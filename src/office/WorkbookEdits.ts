// Fixed worker workbook writer: formulas are stored as text, nothing is evaluated, fetched or run.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { ReadOnlyOpc, opcPartName, opcRelationshipsPart } from '../content/OpcReadPackage';
import { inspectXlsxInventory } from '../content/XlsxInventory';
import { parseXlsxSnapshot, type XlsxManifest } from '../content/XlsxWorkbook';
import { XlsxPointReader } from '../content/XlsxPointReader';
import { xlsxAddress, xlsxRange } from '../content/XlsxSheet';
import { columnName, type WorkbookRange } from '../content/WorkbookPage';
import { WorkbookExactNumber } from '../content/WorkbookExactNumber';
import { readWorkbookBinding, workbookExactText, type WorkbookBindingInput } from '../content/WorkbookBinding';
import type { XlsxCellRecord } from '../content/XlsxCell';
import { WorkbookEditFailure, workbookDateSerial, type WorkbookCellValue, type WorkbookEditCode, type WorkbookEditInput, type WorkbookWriteResult,
  type WorkbookFormulaFact, type WorkbookFormulaEffectFact, type WorkbookDataSourceFact } from './WorkbookEditContracts';
import { xlsxFormulaEffects } from './XlsxFormulaEffects';
import { readXlsxSheetLayout, patchXlsxSheet, xlsxUntouchedCells, xlsxNewCellStyle, xlsxCellKey, type XlsxSheetLayout, type XlsxCellContent, type XlsxCellWrite } from './XlsxSheetPatch';
import { XlsxStylesWriter, XLSX_BUILTIN_NUMBER_FORMATS } from './XlsxStylesWriter';
import { readXlsxContentTypes, readXlsxRelationships, editXlsxRelationships, editXlsxContentTypes, setXlsxFullCalcOnLoad, readXlsxWorkbookCalc, type XlsxRelationships } from './XlsxPackageParts';
import { readXlsxTable, extendXlsxTable, readXlsxPivotLocation, xlsxRangeText, type XlsxTableInfo } from './XlsxStructure';

const fail = (code: WorkbookEditCode, issue?: { location: string; issue: string }): never => { throw new WorkbookEditFailure(code, issue); };
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const inRange = (range: WorkbookRange, row: number, column: number) => row >= range.firstRow && row <= range.lastRow && column >= range.firstColumn && column <= range.lastColumn;
const STYLES_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml';
const SHEET_MAIN = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const TEMPLATE_MAIN = 'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml';
const DATE_FORMAT = 'yyyy-mm-dd'; const DATE_TIME_FORMAT = 'yyyy-mm-dd hh:mm:ss';

/** Canonical decimal text of a finite JSON number; -0 is 0 and exponents use the stored-number E form. */
export function workbookNumberText(value: number): string {
  if (!Number.isFinite(value)) return fail('invalid-workbook-edits', { location: 'value', issue: 'numbers must be finite' });
  const text = Object.is(value, -0) ? '0' : String(value).replace('e+', 'E+').replace('e-', 'E-');
  WorkbookExactNumber.parse(text.replace('E', 'e'), 4096); return text;
}

interface Pending { row: number; column: number; content?: XlsxCellContent; format?: string; formulaWritten?: boolean }
interface Converted { content: XlsxCellContent; defaultFormat?: string; source?: Omit<WorkbookDataSourceFact, 'sheet_id' | 'cell'> }
/** Model values become stored cell content; host data references are filled from the actual host table. */
export function workbookCellContent(value: WorkbookCellValue, date1904: boolean, location: string, bindings: readonly WorkbookBindingInput[], progress: () => void): Converted {
  if (value === null) return { content: { kind: 'clear' } };
  if (typeof value === 'string') return { content: { kind: 'string', text: value } };
  if (typeof value === 'boolean') return { content: { kind: 'boolean', value } };
  if (typeof value === 'number') return { content: { kind: 'number', raw: workbookNumberText(value) } };
  if ('date' in value) {
    const raw = workbookDateSerial(value.date, date1904);
    if (raw === undefined) return fail('invalid-workbook-edits', { location, issue: `date is before this workbook's ${date1904 ? '1904' : '1900'} date system begins` });
    return { content: { kind: 'number', raw }, defaultFormat: value.date.includes('T') ? DATE_TIME_FORMAT : DATE_FORMAT };
  }
  const from = value.from; const input = bindings.find(binding => binding.transformationRef === from.transformation_ref);
  const unavailable = (issue: string): never => fail('workbook-data-unavailable', { location, issue });
  if (!input) return unavailable('this transformation_ref is not a current transform_workbook result of this agent');
  if (!input.manifest.table.columns.includes(from.field)) return unavailable(`field ${from.field} is not in that result; use one of ${input.manifest.table.columns.slice(0, 20).join(', ')}`);
  if (from.row > input.manifest.table.rows) return unavailable(`row ${from.row} is beyond the ${input.manifest.table.rows} result rows`);
  let datum: ReturnType<typeof readWorkbookBinding> extends Generator<infer R> ? R : never;
  try { datum = readWorkbookBinding(input, { transformation_ref: from.transformation_ref, fields: [from.field], rows: { first: from.row, last: from.row } }, progress).next().value as typeof datum; }
  catch { return unavailable('the host data could not be read'); }
  if (!datum || datum.uncertain) return unavailable('this value is not a certain result');
  const cell = datum.cells[0].value; const sources = (input.manifest.source_reads as Array<{ source_sha256?: string }>).flatMap(read => typeof read?.source_sha256 === 'string' ? [read.source_sha256] : []);
  const source = { transformation_ref: from.transformation_ref, field: from.field, row: from.row, source_sha256: [...new Set(sources)] };
  if (cell.kind === 'string') return cell.escapedCodeUnitsUnresolved ? unavailable('the text has unresolved escaped characters') : { content: { kind: 'string', text: cell.text }, source };
  if (cell.kind === 'boolean') return { content: { kind: 'boolean', value: cell.value }, source };
  if (cell.kind === 'number') {
    const text = workbookExactText(new WorkbookExactNumber(BigInt(cell.exact.numerator), BigInt(cell.exact.denominator)));
    return text.includes('/') ? unavailable(`the exact value ${text} has no finite decimal form; write a formula that computes it instead`) : { content: { kind: 'number', raw: text }, source };
  }
  if (cell.kind === 'date-serial') {
    let serial = WorkbookExactNumber.parse(cell.raw.trim(), 4096); const shift = new WorkbookExactNumber(1462n);
    if (cell.epoch === '1900' && date1904) serial = serial.add(new WorkbookExactNumber(-1462n));
    if (cell.epoch === '1904' && !date1904) serial = serial.add(shift);
    const text = workbookExactText(serial); if (serial.compare(new WorkbookExactNumber(0n)) < 0 || text.includes('/')) return unavailable('this date cannot be stored in the destination date system');
    return { content: { kind: 'number', raw: text }, defaultFormat: DATE_FORMAT, source };
  }
  return unavailable(`the value is ${cell.kind}${'reason' in cell ? ` (${cell.reason})` : ''}, not a value that can be written`);
}

interface SheetState { sheetId: string; name: string; part: string; layout: XlsxSheetLayout; rels?: XlsxRelationships; relsPart: string; tables: XlsxTableInfo[]; pivots: WorkbookRange[];
  writes: Map<number, Pending>; extended: Map<string, number> }

/** Read the selected record of a written cell back through the ordinary reader and compare it with the request. */
function matches(record: XlsxCellRecord | undefined, write: XlsxCellWrite, format: string | undefined): boolean {
  if (!record) return false;
  if (format !== undefined) {
    const builtin = XLSX_BUILTIN_NUMBER_FORMATS.get(format);
    if (builtin !== undefined ? record.numberFormat?.id !== builtin : record.numberFormat?.code !== format) return false;
  }
  const content = write.content; if (!content) return true; const value = record.value;
  switch (content.kind) {
    case 'string': return !record.formula && (value.kind === 'string' || value.kind === 'rich-string') && value.text === content.text;
    case 'number': return !record.formula && (value.kind === 'number' || value.kind === 'date-serial') && value.raw === content.raw;
    case 'boolean': return !record.formula && value.kind === 'boolean' && value.value === content.value;
    case 'clear': return !record.formula && value.kind === 'blank';
    case 'formula': return record.formula?.storedText === content.text && record.formula.mode === 'normal' && !record.formula.cachePresent;
    case 'cached': {
      const cache = record.formula?.cachePresent ? record.formula.cachedResult : undefined; if (!cache) return false;
      return content.type === 'n' ? (cache.kind === 'number' || cache.kind === 'date-serial') && cache.raw === content.text
        : content.type === 'str' ? cache.kind === 'string' && cache.text === content.text
          : content.type === 'b' ? cache.kind === 'boolean' && cache.value === (content.text === '1')
            : cache.kind === 'error' && cache.code === content.text;
    }
  }
}

/** Preserving edit of an existing workbook: only the written cells, their formats and the named calculation metadata change. */
export async function editWorkbookPackage(input: WorkbookEditInput, ratio: number, floor: number, progress: () => void): Promise<WorkbookWriteResult> {
  const source = await readFile(input.source);
  if (sha(source) !== input.sourceSha256 || input.manifest.sha256 !== input.sourceSha256) return fail('source-changed');
  const pkg = await ReadOnlyOpc.open(input.source, ratio, floor, progress);
  const scratch = join(input.directory, `workbook-edit-${randomUUID()}`); await mkdir(scratch);
  try {
    let inventory: Awaited<ReturnType<typeof inspectXlsxInventory>>;
    try { inventory = await inspectXlsxInventory(pkg); } catch { return fail('unsupported-workbook-package'); }
    const before = new Map<string, { member: string; hash: string }>(); const cache = new Map<string, Buffer>();
    for (const name of pkg.names().sort()) {
      const hash = createHash('sha256'); for await (const chunk of pkg.bytes(name)) hash.update(chunk);
      before.set(name, { member: pkg.memberName(name), hash: hash.digest('hex') }); progress();
    }
    const read = async (part: string) => {
      const name = opcPartName(part); const known = cache.get(name); if (known) return known;
      const chunks: Buffer[] = []; for await (const chunk of pkg.bytes(name)) { chunks.push(Buffer.from(chunk)); progress(); }
      const bytes = Buffer.concat(chunks); cache.set(name, bytes); return bytes;
    };
    const types = readXlsxContentTypes(await read('/[Content_Types].xml'), progress);
    const rootRels = readXlsxRelationships(await read('/_rels/.rels'), '/', progress);
    // Package signatures and macro projects are identified by relationship and content type, never by member name.
    if (rootRels.items.some(rel => /\/digital-signature\/origin$/.test(rel.type)) || [...types.overrides.map(item => item.type), ...types.defaults.values()].some(type => type.includes('digital-signature'))) return fail('workbook-signed');
    const mainType = types.typeOf(inventory.workbookPart);
    if (inventory.macroContentPresent || mainType?.includes('macroenabled') || [...types.overrides.map(item => item.type), ...types.defaults.values()].some(type => type.includes('vbaproject') || type.includes('macroenabled'))) return fail('workbook-macros-unsupported');
    const template = mainType === TEMPLATE_MAIN;
    const workbookRelsPart = opcRelationshipsPart(inventory.workbookPart);
    const workbookRels = readXlsxRelationships(await read(workbookRelsPart), inventory.workbookPart, progress);
    const date1904 = inventory.date1904; const bindings = input.bindings ?? [];
    const sheets = new Map<string, SheetState>();
    const sheetState = async (sheetId: string, location: string): Promise<SheetState> => {
      const known = sheets.get(sheetId); if (known) return known;
      const listed = input.manifest.sheets.find(sheet => sheet.sheetId === sheetId); const actual = inventory.sheets.find(sheet => sheet.sheetId === sheetId);
      if (!listed || !actual || actual.gap || listed.gap || actual.kind !== 'worksheet' || !actual.part || actual.part !== listed.part) return fail('unavailable-worksheet', { location, issue: `${sheetId} is not a readable worksheet in this snapshot` });
      const layout = readXlsxSheetLayout(await read(actual.part), progress); const relsPart = opcRelationshipsPart(actual.part);
      const rels = pkg.has(relsPart) ? readXlsxRelationships(await read(relsPart), actual.part, progress) : undefined;
      const tables: XlsxTableInfo[] = []; const pivots: WorkbookRange[] = [];
      for (const rel of rels?.items ?? []) {
        if (rel.external || !rel.part || !pkg.has(rel.part)) { if (rel.kind === 'table' || rel.kind === 'pivotTable') return fail('workbook-structure-unsupported', { location, issue: `${listed.name} has a table or pivot table that is not in the package` }); continue; }
        if (rel.kind === 'table') tables.push(readXlsxTable(await read(rel.part), rel.part, progress));
        if (rel.kind === 'pivotTable') pivots.push(readXlsxPivotLocation(await read(rel.part), progress));
      }
      const state: SheetState = { sheetId, name: listed.name, part: actual.part, layout, rels, relsPart, tables, pivots, writes: new Map(), extended: new Map() };
      sheets.set(sheetId, state); return state;
    };
    const values: string[] = []; const sourcesUsed: WorkbookDataSourceFact[] = [];
    const put = (state: SheetState, row: number, column: number, change: Partial<Pending>) => {
      const key = xlsxCellKey(row, column); const prior = state.writes.get(key) ?? { row, column };
      state.writes.set(key, { ...prior, ...change });
    };
    const setValue = (state: SheetState, row: number, column: number, value: WorkbookCellValue, format: string | undefined, location: string) => {
      const converted = workbookCellContent(value, date1904, location, bindings, progress);
      put(state, row, column, { content: converted.content, formulaWritten: false, ...(format ?? converted.defaultFormat ? { format: format ?? converted.defaultFormat } : {}) });
      if (converted.source) sourcesUsed.push({ sheet_id: state.sheetId, cell: `${columnName(column)}${row}`, ...converted.source });
    };
    // The next append row follows the last row with content as the earlier edits of this request left it (audit F2):
    // a pending write decides its own cell, and every other stored cell keeps its saved content.
    const contentRow = (state: SheetState) => {
      let last = 0;
      for (const row of state.layout.rows) if (row.cells.some(cell => {
        const pending = state.writes.get(xlsxCellKey(cell.row, cell.column))?.content;
        return pending ? pending.kind !== 'clear' : cell.children.some(child => ['f', 'v', 'is'].includes(child.local));
      })) last = Math.max(last, row.row);
      for (const write of state.writes.values()) if (write.content && write.content.kind !== 'clear') last = Math.max(last, write.row);
      return last + 1;
    };
    for (const [index, edit] of input.edits.entries()) {
      const at = `edits[${index}]`; const state = await sheetState(edit.sheet_id, `${at}.sheet_id`);
      if (edit.op === 'set_cells') {
        const range = xlsxRange(edit.range);
        edit.values.forEach((row, rowOffset) => row.forEach((value, columnOffset) => setValue(state, range.firstRow + rowOffset, range.firstColumn + columnOffset, value, edit.number_format, `${at}.values[${rowOffset}][${columnOffset}]`)));
      } else if (edit.op === 'set_formulas') {
        for (const [ref, text] of Object.entries(edit.cells)) { const address = xlsxAddress(ref); put(state, address.row, address.column, { content: { kind: 'formula', text }, formulaWritten: true, ...(edit.number_format ? { format: edit.number_format } : {}) }); }
      } else if (edit.op === 'set_number_format') {
        const range = xlsxRange(edit.range);
        for (let row = range.firstRow; row <= range.lastRow; row++) for (let column = range.firstColumn; column <= range.lastColumn; column++) put(state, row, column, { format: edit.number_format });
      } else {
        const first = contentRow(state); const last = first + edit.rows.length - 1;
        if (last > 1048576) return fail('invalid-cell-ref', { location: `${at}.rows`, issue: `appending ${edit.rows.length} rows after row ${first - 1} goes beyond row 1048576` });
        const formulas = Object.entries(edit.formulas ?? {}).map(([column, text]) => ({ column: xlsxAddress(`${column}1`).column, text }));
        const width = Math.max(...edit.rows.map(row => row.length), ...formulas.map(item => item.column));
        for (const [offset, row] of edit.rows.entries()) {
          const number = first + offset;
          row.forEach((value, column) => {
            if (formulas.some(item => item.column === column + 1) && value !== null) fail('invalid-workbook-edits', { location: `${at}.rows[${offset}][${column}]`, issue: `column ${columnName(column + 1)} also has a formula; use null in rows for formula columns` });
            const format = edit.number_formats?.[columnName(column + 1)];
            setValue(state, number, column + 1, value, format, `${at}.rows[${offset}][${column}]`);
          });
          for (const formula of formulas) put(state, number, formula.column, { content: { kind: 'formula', text: formula.text.replaceAll('{row}', String(number)) }, formulaWritten: true,
            ...(edit.number_formats?.[columnName(formula.column)] ? { format: edit.number_formats[columnName(formula.column)] } : {}) });
        }
        // A block directly under a table without a totals row becomes part of it; calculated columns are filled from their stored text.
        for (const table of state.tables) {
          const overlaps = table.range.firstColumn <= width && first <= table.range.lastRow + 1 && last > table.range.lastRow;
          if (!overlaps) continue;
          if (table.totalsRows > 0) return fail('table-structure-unsupported', { location: `${at}.rows`, issue: `table ${table.name ?? table.part} has a totals row or would be split; write inside its data rows with set_cells, or remove the totals row in Excel first` });
          state.extended.set(table.part, Math.max(state.extended.get(table.part) ?? table.range.lastRow, last));
          table.columns.forEach((column, offset) => {
            if (column.formula === undefined) return; const target = table.range.firstColumn + offset;
            for (let number = Math.max(first, table.range.lastRow + 1); number <= last; number++) {
              const existing = state.writes.get(xlsxCellKey(number, target));
              if (!existing?.content || existing.content.kind === 'clear') put(state, number, target, { content: { kind: 'formula', text: column.formula }, formulaWritten: true });
            }
          });
          // Later edits of this request see the table as it now is (audit F1): a following append extends it again.
          table.range = { ...table.range, lastRow: last };
        }
      }
    }
    // Final write set per sheet: structural boundaries are judged on the whole request, never one operation at a time.
    const arrayCleared: string[] = []; const calculatedNotes: string[] = []; let formulaRemoved = false;
    for (const state of sheets.values()) {
      const { layout } = state; const location = state.name;
      if (state.writes.size && layout.protected) return fail('sheet-protected', { location, issue: `${state.name} is protected; unprotect it in Excel, or write to another sheet` });
      const groups = new Map<string, string[]>(); const arrays: Array<{ master: string; range: WorkbookRange }> = []; const dataTables: WorkbookRange[] = [];
      for (const row of layout.rows) for (const cell of row.cells) {
        const formula = cell.formula; if (!formula) continue;
        if (formula.mode === 'shared' && formula.si !== undefined) groups.set(formula.si, [...(groups.get(formula.si) ?? []), cell.ref]);
        if (formula.mode === 'array' && formula.ref) { try { arrays.push({ master: cell.ref, range: xlsxRange(formula.ref) }); } catch { return fail('workbook-structure-unsupported', { location, issue: `array formula at ${cell.ref} has an unreadable range` }); } }
        if (formula.mode === 'dataTable') { try { dataTables.push(xlsxRange(formula.ref ?? cell.ref)); } catch { return fail('workbook-structure-unsupported', { location, issue: `data table at ${cell.ref} has an unreadable range` }); } }
      }
      const contentAt = (ref: string) => { const address = xlsxAddress(ref); return !!state.writes.get(xlsxCellKey(address.row, address.column))?.content; };
      for (const [si, members] of groups) {
        const covered = members.filter(contentAt).length;
        if (covered && covered < members.length) return fail('formula-range-partial', { location, issue: `shared formula group ${si} spans ${members.join(', ')}; write every member in one request, or only change number formats there` });
      }
      for (const array of arrays) {
        const inside = [...state.writes.values()].filter(write => write.content && inRange(array.range, write.row, write.column));
        if (!inside.length) continue;
        if (!contentAt(array.master)) return fail('formula-range-partial', { location, issue: `cells inside the array formula ${xlsxRangeText(array.range)} need its first cell ${array.master} written in the same request` });
        for (const row of layout.rows) for (const cell of row.cells) if (inRange(array.range, cell.row, cell.column) && !contentAt(cell.ref)) {
          put(state, cell.row, cell.column, { content: { kind: 'clear' } }); arrayCleared.push(`${state.sheetId}!${cell.ref}`);
        }
      }
      for (const write of state.writes.values()) {
        const ref = `${columnName(write.column)}${write.row}`; const node = layout.byRef.get(ref);
        if (state.pivots.some(pivot => inRange(pivot, write.row, write.column))) return fail('workbook-structure-unsupported', { location, issue: `${ref} is inside a pivot table; change the pivot table in Excel, or write outside it` });
        if (!write.content) continue;
        const merge = layout.merges.find(range => inRange(range, write.row, write.column));
        if (merge && (merge.firstRow !== write.row || merge.firstColumn !== write.column)) return fail('merged-cell-covered', { location, issue: `${ref} is covered by the merged range ${xlsxRangeText(merge)}; write its first cell ${columnName(merge.firstColumn)}${merge.firstRow}` });
        if (dataTables.some(range => inRange(range, write.row, write.column))) return fail('workbook-structure-unsupported', { location, issue: `${ref} is inside a what-if data table; change it in Excel` });
        if (node?.formula && xlsxFormulaEffects(node.formula.text).includes('external-workbook')) return fail('workbook-structure-unsupported', { location, issue: `${ref} holds a link to another workbook; change it in Excel` });
        for (const table of state.tables) {
          if (!inRange(table.range, write.row, write.column)) continue;
          if (table.headerRows > 0 && write.row < table.range.firstRow + table.headerRows) return fail('table-structure-unsupported', { location, issue: `${ref} is a header cell of table ${table.name ?? ''}; header changes rename columns, so rename them in Excel` });
          if (table.totalsRows > 0 && write.row > table.range.lastRow - table.totalsRows) return fail('table-structure-unsupported', { location, issue: `${ref} is in the totals row of table ${table.name ?? ''}; change totals in Excel` });
          const column = table.columns[write.column - table.range.firstColumn];
          if (column?.formula !== undefined && !(write.content.kind === 'formula' && write.content.text === column.formula)) calculatedNotes.push(`${state.sheetId}!${ref}`);
        }
        if (node?.formula) formulaRemoved = true;
      }
    }
    // Styles, sheets and calculation metadata.
    const formats = [...sheets.values()].some(state => [...state.writes.values()].some(write => write.format));
    let styles: XlsxStylesWriter | undefined; let stylesPart = inventory.stylesPart;
    if (formats) styles = new XlsxStylesWriter(stylesPart ? await read(stylesPart) : undefined, progress);
    const changed = new Map<string, Buffer>(); const added = new Map<string, { member: string; bytes: Buffer }>(); const removed = new Set<string>();
    const formulas: WorkbookFormulaFact[] = []; const effects: WorkbookFormulaEffectFact[] = []; const untouched = new Map<string, string[]>();
    const written = new Map<string, Map<string, { write: XlsxCellWrite; format?: string }>>(); let cells = 0; let formatsWritten = 0; let content = false;
    for (const state of sheets.values()) {
      const final: XlsxCellWrite[] = []; const record = new Map<string, { write: XlsxCellWrite; format?: string }>();
      for (const write of [...state.writes.values()].sort((left, right) => left.row - right.row || left.column - right.column)) {
        const ref = `${columnName(write.column)}${write.row}`; const node = state.layout.byRef.get(ref);
        if (!node && write.content?.kind === 'clear' && !write.format) continue;
        const base = node ? node.style ?? 0 : xlsxNewCellStyle(state.layout, write.row, write.column);
        const style = write.format ? styles!.styleFor(base, write.format) : node ? undefined : base || undefined;
        const cell: XlsxCellWrite = { row: write.row, column: write.column, ...(write.content ? { content: write.content } : {}), ...(style !== undefined ? { style } : {}) };
        final.push(cell); record.set(ref, { write: cell, ...(write.format ? { format: write.format } : {}) });
        if (write.format) formatsWritten++;
        if (write.content) {
          cells++; content = true;
          if (write.content.kind === 'formula') {
            formulas.push({ sheet_id: state.sheetId, cell: ref, formula: write.content.text });
            const found = xlsxFormulaEffects(write.content.text); if (found.length) effects.push({ sheet_id: state.sheetId, cell: ref, effects: found });
          } else if (write.content.kind !== 'clear') values.push(`${state.sheetId}!${ref}`);
        }
      }
      if (!final.length) continue;
      untouched.set(state.part, xlsxUntouchedCells(state.layout, new Set(record.keys())));
      changed.set(state.part, patchXlsxSheet(state.layout, final).bytes); written.set(state.sheetId, record);
      for (const [part, lastRow] of state.extended) {
        const table = state.tables.find(item => item.part === part)!; changed.set(part, extendXlsxTable(await read(part), table, lastRow, progress));
      }
    }
    const tablesExtended = [...sheets.values()].flatMap(state => [...state.extended.keys()].map(part => state.tables.find(table => table.part === part)?.name ?? part));
    let workbookRelsChanged = false; const relRemovals: string[] = []; const relAdditions: Array<{ id: string; type: string; target: string }> = [];
    const typeRemovals: string[] = []; const typeAdditions: Array<{ part: string; type: string }> = []; const retype: Array<{ part: string; type: string }> = [];
    if (styles) {
      const bytes = styles.finish();
      if (styles.created) {
        const directory = posix.dirname(before.get(inventory.workbookPart)!.member); let name = 'styles.xml'; let index = 1;
        while (before.has(opcPartName('/' + posix.join(directory, name)))) name = `styles${index++}.xml`;
        const member = posix.join(directory, name); stylesPart = opcPartName('/' + member); added.set(stylesPart, { member, bytes: bytes! });
        let id = 'rIdUnodeStyles'; let suffix = 1; while (workbookRels.items.some(rel => rel.id === id)) id = `rIdUnodeStyles${suffix++}`;
        relAdditions.push({ id, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles', target: name });
        typeAdditions.push({ part: '/' + member, type: STYLES_TYPE }); workbookRelsChanged = true;
      } else if (bytes) changed.set(stylesPart!, bytes);
    }
    let calcMode: string | undefined; let calcChainRemoved = false;
    if (content) { const result = setXlsxFullCalcOnLoad(await read(inventory.workbookPart), progress); changed.set(inventory.workbookPart, result.bytes); calcMode = result.calcMode; }
    if (formulas.length || formulaRemoved) {
      for (const rel of workbookRels.items.filter(item => item.kind === 'calcChain')) {
        relRemovals.push(rel.id); workbookRelsChanged = true;
        if (rel.part && before.has(rel.part)) { removed.add(rel.part); calcChainRemoved = true; if (types.overrides.some(item => item.part === rel.part)) typeRemovals.push(rel.part!); }
      }
    }
    if (template) retype.push({ part: inventory.workbookPart, type: SHEET_MAIN });
    if (workbookRelsChanged) changed.set(workbookRelsPart, editXlsxRelationships(workbookRels, relRemovals, relAdditions));
    if (typeRemovals.length || typeAdditions.length || retype.length) changed.set('/[CONTENT_TYPES].XML', editXlsxContentTypes(types, typeRemovals, typeAdditions, retype));
    for (const [name, bytes] of [...changed]) if (before.get(name)?.hash === sha(bytes)) changed.delete(name);
    // Package output: only changed members are replaced; every other member keeps its stored bytes and name.
    const zip = await JSZip.loadAsync(source, { createFolders: false });
    for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir) {
      let canonical: string; try { canonical = opcPartName('/' + name); } catch { return fail('workbook-output-check-failed'); }
      const original = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? name;
      if (original !== name || before.get(canonical)?.member !== name) return fail('workbook-output-check-failed');
    }
    for (const [name, bytes] of changed) zip.file(before.get(name)!.member, bytes);
    for (const name of removed) zip.remove(before.get(name)!.member);
    for (const item of added.values()) zip.file(item.member, item.bytes);
    const output = changed.size || removed.size || added.size ? await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }, () => progress()) : source;
    const file = join(scratch, 'output.xlsx'); await writeFile(file, output, { flag: 'wx' });
    const preserved = await verifyWorkbookOutput(file, { before, changed, added, removed, ratio, floor, progress, written, untouched, content, scratch, manifestSheets: input.manifest.sheets.map(sheet => ({ id: sheet.sheetId, part: sheet.part })) });
    return { kind: 'workbook-edited', bytes: output, sha256: sha(output), sourceSha256: input.sourceSha256, sheets: [...sheets.values()].map(state => ({ sheet_id: state.sheetId, name: state.name })),
      cells_written: cells, values_written: values, formulas_written: formulas, formats_written: formatsWritten, number_formats_added: styles?.numberFormatsAdded ?? 0,
      calc_chain_removed: calcChainRemoved, full_calc_on_load: content, calc_mode_manual: calcMode === 'manual', array_cells_cleared: arrayCleared,
      calculated_column_notes: calculatedNotes, formula_effects: effects, tables_extended: tablesExtended, data_sources: sourcesUsed, template_converted: template,
      preserved_parts: preserved.preserved, changed_parts: changed.size, added_parts: added.size, removed_parts: removed.size, untouched_cells_checked: preserved.cells, preservation_digest: preserved.digest };
  } finally { pkg.close(); await rm(scratch, { recursive: true, force: true }); }
}

/** Read the actual output again: untouched members, untouched cells, every written cell and the calculation flag. */
export async function verifyWorkbookOutput(file: string, expected: { before: Map<string, { member: string; hash: string }>; changed: Map<string, Buffer>; added: Map<string, { member: string; bytes: Buffer }>;
  removed: Set<string>; ratio: number; floor: number; progress: () => void; written: Map<string, Map<string, { write: XlsxCellWrite; format?: string }>>;
  untouched: Map<string, string[]>; content: boolean; scratch: string; manifestSheets: Array<{ id: string; part?: string }> }): Promise<{ preserved: number; cells: number; digest: string }> {
  const { before, changed, added, removed, progress } = expected; const check = (ok: boolean) => { if (!ok) fail('workbook-output-check-failed'); };
  const pkg = await ReadOnlyOpc.open(file, expected.ratio, expected.floor, progress); let preserved = 0; let cells = 0; const digest = createHash('sha256');
  try {
    check(pkg.names().length === before.size - removed.size + added.size);
    const bytesOf = async (name: string) => { const chunks: Buffer[] = []; for await (const chunk of pkg.bytes(name)) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); };
    for (const [name, original] of before) {
      if (removed.has(name)) { check(!pkg.has(name)); continue; }
      check(pkg.has(name) && pkg.memberName(name) === original.member);
      const actual = sha(await bytesOf(name)); check(actual === (changed.has(name) ? sha(changed.get(name)!) : original.hash));
      if (!changed.has(name)) { preserved++; digest.update(JSON.stringify([name, actual])); } progress();
    }
    for (const [name, item] of added) check(pkg.has(name) && pkg.memberName(name) === item.member && sha(await bytesOf(name)) === sha(item.bytes));
    for (const [part, list] of expected.untouched) {
      const sheet = expected.manifestSheets.find(item => item.part === part); const record = sheet ? expected.written.get(sheet.id) : undefined;
      const layout = readXlsxSheetLayout(await bytesOf(part), progress); const after = xlsxUntouchedCells(layout, new Set(record?.keys() ?? []));
      check(after.length === list.length && after.every((item, index) => item === list[index])); cells += list.length;
    }
  } finally { pkg.close(); }
  const directory = join(expected.scratch, 'readback'); await mkdir(directory);
  let manifest: XlsxManifest;
  try { manifest = await parseXlsxSnapshot(file, directory, progress); } catch { return fail('workbook-output-check-failed'); }
  if (expected.content) check(manifest.calculation.fullCalcOnLoad === '1' || manifest.calculation.fullCalcOnLoad === 'true');
  for (const [sheetId, record] of expected.written) {
    const sheet = manifest.sheets.find(item => item.sheetId === sheetId); check(!!sheet?.metadata && !!sheet.directory && !sheet.gap);
    const reader = new XlsxPointReader(directory, join(directory, sheet!.directory!), sheet!.metadata!, manifest.date1904);
    try { for (const [ref, item] of record) { const address = xlsxAddress(ref); check(matches(reader.cell(address.row, address.column), item.write, item.format)); progress(); } }
    finally { reader.close(); }
  }
  return { preserved, cells, digest: digest.digest('hex') };
}

export { readXlsxWorkbookCalc };
