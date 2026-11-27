// Fixed worker workbook generator: a new package from typed values and formula text; nothing is evaluated.
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { opcPartName } from '../content/OpcReadPackage';
import { xlsxAddress } from '../content/XlsxSheet';
import { columnName } from '../content/WorkbookPage';
import { WorkbookEditFailure, type WorkbookCreateInput, type WorkbookWriteResult, type WorkbookFormulaFact, type WorkbookFormulaEffectFact, type WorkbookDataSourceFact } from './WorkbookEditContracts';
import { xlsxFormulaEffects } from './XlsxFormulaEffects';
import { xlsxNewCellXml, type XlsxCellWrite } from './XlsxSheetPatch';
import { XlsxStylesWriter } from './XlsxStylesWriter';
import { xlsxXmlAttributeValue } from './XlsxXmlScan';
import { workbookCellContent, verifyWorkbookOutput } from './WorkbookEdits';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const BASE_STYLES = `${DECLARATION}<styleSheet xmlns="${MAIN}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>`
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A new workbook asks the application to calculate every formula when it is opened; no cached result is invented. */
export async function createWorkbookPackage(input: WorkbookCreateInput, ratio: number, floor: number, progress: () => void): Promise<WorkbookWriteResult> {
  const scratch = join(input.directory, `workbook-create-${randomUUID()}`); await mkdir(scratch);
  try {
    const styles = new XlsxStylesWriter(Buffer.from(BASE_STYLES), progress); const bindings = input.bindings ?? [];
    const files = new Map<string, string | Buffer>(); const written = new Map<string, Map<string, { write: XlsxCellWrite; format?: string }>>();
    const formulas: WorkbookFormulaFact[] = []; const effects: WorkbookFormulaEffectFact[] = []; const values: string[] = []; const sources: WorkbookDataSourceFact[] = [];
    let cells = 0; let formatted = 0;
    for (const [index, sheet] of input.sheets.entries()) {
      const sheetId = `sheet-${index + 1}`; const at = `sheets[${index}]`; const first = sheet.header ? 2 : 1;
      const cellMap = new Map<string, { write: XlsxCellWrite; format?: string }>();
      const columnFormat = (column: number) => sheet.columns?.[column - 1]?.number_format;
      const place = (row: number, column: number, write: Omit<XlsxCellWrite, 'row' | 'column'>, format?: string) => {
        const ref = `${columnName(column)}${row}`;
        cellMap.set(ref, { write: { row, column, ...write }, ...(format ? { format } : {}) });
      };
      sheet.header?.forEach((text, column) => place(1, column + 1, { content: { kind: 'string', text }, style: 1 }));
      const templates = Object.entries(sheet.formulas ?? {}).filter(([key]) => /^[A-Z]+$/.test(key)).map(([key, text]) => ({ column: xlsxAddress(`${key}1`).column, text }));
      for (const [offset, row] of sheet.rows.entries()) {
        const number = first + offset;
        row.forEach((value, column) => {
          if (value === null) return;
          if (templates.some(item => item.column === column + 1)) throw new WorkbookEditFailure('invalid-workbook-edits', { location: `${at}.rows[${offset}][${column}]`, issue: `column ${columnName(column + 1)} has a formula; use null there` });
          const converted = workbookCellContent(value, false, `${at}.rows[${offset}][${column}]`, bindings, progress);
          const format = columnFormat(column + 1) ?? converted.defaultFormat;
          place(number, column + 1, { content: converted.content, ...(format ? { style: styles.styleFor(0, format) } : {}) }, format);
          if (converted.source) sources.push({ sheet_id: sheetId, cell: `${columnName(column + 1)}${number}`, ...converted.source });
        });
        for (const template of templates) {
          const format = columnFormat(template.column);
          place(number, template.column, { content: { kind: 'formula', text: template.text.replaceAll('{row}', String(number)) }, ...(format ? { style: styles.styleFor(0, format) } : {}) }, format);
        }
      }
      for (const [key, text] of Object.entries(sheet.formulas ?? {})) {
        if (/^[A-Z]+$/.test(key)) continue; const address = xlsxAddress(key);
        if (cellMap.has(address.cell)) throw new WorkbookEditFailure('invalid-workbook-edits', { location: `${at}.formulas.${key}`, issue: `${address.cell} already has a header or row value` });
        const format = address.row >= first ? columnFormat(address.column) : undefined;
        place(address.row, address.column, { content: { kind: 'formula', text }, ...(format ? { style: styles.styleFor(0, format) } : {}) }, format);
      }
      const sorted = [...cellMap.values()].sort((left, right) => left.write.row - right.write.row || left.write.column - right.write.column);
      const rows: string[] = []; let rowNumber = 0; let rowCells: string[] = [];
      const flush = () => { if (rowNumber) rows.push(`<row r="${rowNumber}">${rowCells.join('')}</row>`); rowCells = []; };
      for (const item of sorted) {
        if (item.write.row !== rowNumber) { flush(); rowNumber = item.write.row; }
        rowCells.push(xlsxNewCellXml('', item.write)); cells++; if (item.format) formatted++;
        const ref = `${columnName(item.write.column)}${item.write.row}`; const content = item.write.content!;
        if (content.kind === 'formula') { formulas.push({ sheet_id: sheetId, cell: ref, formula: content.text }); const found = xlsxFormulaEffects(content.text); if (found.length) effects.push({ sheet_id: sheetId, cell: ref, effects: found }); }
        else values.push(`${sheetId}!${ref}`);
        progress();
      }
      flush();
      const last = sorted.at(-1); const maxColumn = sorted.reduce((max, item) => Math.max(max, item.write.column), 0);
      const dimension = last ? `<dimension ref="A1${last.write.row > 1 || maxColumn > 1 ? `:${columnName(Math.max(1, maxColumn))}${last.write.row}` : ''}"/>` : '<dimension ref="A1"/>';
      const pane = sheet.freeze_header && sheet.header ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : '';
      const columns = (sheet.columns ?? []).map((column, position) => column.width === undefined && column.number_format === undefined ? ''
        : `<col min="${position + 1}" max="${position + 1}"${column.width !== undefined ? ` width="${column.width}" customWidth="1"` : ' width="9.140625"'}${column.number_format ? ` style="${styles.styleFor(0, column.number_format)}"` : ''}/>`).join('');
      files.set(`xl/worksheets/sheet${index + 1}.xml`, `${DECLARATION}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">${dimension}<sheetViews><sheetView${index === 0 ? ' tabSelected="1"' : ''} workbookViewId="0">${pane}</sheetView></sheetViews>`
        + `<sheetFormatPr defaultRowHeight="15"/>${columns ? `<cols>${columns}</cols>` : ''}<sheetData>${rows.join('')}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`);
      written.set(sheetId, cellMap);
    }
    const sheetCount = input.sheets.length;
    files.set('[Content_Types].xml', `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + Array.from({ length: sheetCount }, (_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>');
    files.set('_rels/.rels', `${DECLARATION}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>`
      + `<Relationship Id="rId2" Type="${PKG}/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`);
    files.set('docProps/app.xml', `${DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>UnodeAi</Application></Properties>`);
    files.set('docProps/core.xml', `${DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
      + `<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</dcterms:created></cp:coreProperties>`);
    files.set('xl/workbook.xml', `${DECLARATION}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><bookViews><workbookView/></bookViews><sheets>`
      + input.sheets.map((sheet, index) => `<sheet name="${xlsxXmlAttributeValue(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')
      + '</sheets><calcPr fullCalcOnLoad="1"/></workbook>');
    files.set('xl/_rels/workbook.xml.rels', `${DECLARATION}<Relationships xmlns="${PKG}">`
      + Array.from({ length: sheetCount }, (_, index) => `<Relationship Id="rId${index + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheetCount + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`);
    files.set('xl/styles.xml', styles.finish() ?? Buffer.from(BASE_STYLES));
    const zip = new JSZip(); const added = new Map<string, { member: string; bytes: Buffer }>();
    for (const [member, content] of files) { const bytes = typeof content === 'string' ? Buffer.from(content) : content; zip.file(member, bytes, { createFolders: false }); added.set(opcPartName('/' + member), { member, bytes }); }
    const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }, () => progress());
    const file = join(scratch, 'created.xlsx'); await writeFile(file, output, { flag: 'wx' });
    const checked = await verifyWorkbookOutput(file, { before: new Map(), changed: new Map(), added, removed: new Set(), ratio, floor, progress, written, untouched: new Map(), content: true, scratch, manifestSheets: [] });
    return { kind: 'workbook-created', bytes: output, sha256: sha(output), sheets: input.sheets.map((sheet, index) => ({ sheet_id: `sheet-${index + 1}`, name: sheet.name })),
      cells_written: cells, values_written: values, formulas_written: formulas, formats_written: formatted, number_formats_added: styles.numberFormatsAdded,
      calc_chain_removed: false, full_calc_on_load: true, calc_mode_manual: false, array_cells_cleared: [], calculated_column_notes: [], formula_effects: effects,
      tables_extended: [], data_sources: sources, template_converted: false, preserved_parts: 0, changed_parts: 0, added_parts: added.size, removed_parts: 0,
      untouched_cells_checked: checked.cells, preservation_digest: checked.digest };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
