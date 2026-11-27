import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { parseXlsxSnapshot } from '../../content/XlsxWorkbook';
import { XlsxPointReader } from '../../content/XlsxPointReader';
import { xlsxAddress } from '../../content/XlsxSheet';
import { CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES } from '../../content/ContentAssetStore';
import { editWorkbookPackage, workbookNumberText } from '../WorkbookEdits';
import { createWorkbookPackage } from '../WorkbookCreate';
import { validateWorkbookEditRequest, validateWorkbookCreateRequest, workbookDateSerial, WorkbookEditFailure, type WorkbookEdit } from '../WorkbookEditContracts';
import { xlsxFormulaEffects, xlsxFormulaIssue, xlsxFormulaNetworkHosts } from '../XlsxFormulaEffects';
import { workbookFixture, tableXml, MAIN, REL } from './workbookEditFixtures';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function folder() { const value = await mkdtemp(join(tmpdir(), 'unode-workbook-edit-test-')); folders.push(value); return value; }
async function edit(bytes: Buffer, edits: unknown[]) {
  const root = await folder(); const source = join(root, 'source.xlsx'); await writeFile(source, bytes);
  const parsed = join(root, 'parsed'); await mkdir(parsed); const manifest = await parseXlsxSnapshot(source, parsed, () => {});
  const request = validateWorkbookEditRequest({ schema_version: 1, path: 'out.xlsx', snapshot_ref: 'workbook-x', edits });
  return editWorkbookPackage({ source, sourceSha256: sha(bytes), directory: parsed, manifest, edits: request.edits as WorkbookEdit[] },
    CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES, () => {});
}
async function refused(bytes: Buffer, edits: unknown[]) {
  try { await edit(bytes, edits); } catch (error) { if (error instanceof WorkbookEditFailure) return { code: error.message, issue: error.inputIssue }; throw error; }
  throw new Error('expected a refusal');
}
async function cells(bytes: Uint8Array, sheet = 'sheet-1') {
  const root = await folder(); const file = join(root, 'out.xlsx'); await writeFile(file, bytes);
  const parsed = join(root, 'parsed'); await mkdir(parsed); const manifest = await parseXlsxSnapshot(file, parsed, () => {});
  const info = manifest.sheets.find(item => item.sheetId === sheet)!;
  const reader = new XlsxPointReader(parsed, join(parsed, info.directory!), info.metadata!, manifest.date1904);
  return { manifest, get: (ref: string) => { const at = xlsxAddress(ref); return reader.cell(at.row, at.column); }, close: () => reader.close() };
}
const part = async (bytes: Uint8Array, name: string) => (await JSZip.loadAsync(bytes)).file(name)?.async('string');

describe('edit_workbook writer', () => {
  it('writes values and formulas, keeps untouched parts and cells, removes the calculation chain and asks for calculation on open', async () => {
    const source = await workbookFixture({ calcMode: 'manual' });
    const result = await edit(source, [
      { op: 'set_cells', sheet_id: 'sheet-1', range: 'B1:C1', values: [[10, 'new _x000D_ text\r\n']] },
      { op: 'set_formulas', sheet_id: 'sheet-1', cells: { E1: '=B1+C1+A1', E2: 'WEBSERVICE("https://example.invalid/x")' }, number_format: '0.00' },
      { op: 'set_cells', sheet_id: 'sheet-1', range: 'E4', values: [[{ date: '2026-11-22' }]] },
    ]);
    expect(result).toMatchObject({ kind: 'workbook-edited', calc_chain_removed: true, full_calc_on_load: true, calc_mode_manual: true, number_formats_added: 1 });
    expect(result.formulas_written).toEqual([{ sheet_id: 'sheet-1', cell: 'E1', formula: 'B1+C1+A1' }, { sheet_id: 'sheet-1', cell: 'E2', formula: 'WEBSERVICE("https://example.invalid/x")' }]);
    expect(result.formula_effects).toEqual([{ sheet_id: 'sheet-1', cell: 'E2', effects: ['network'] }]);
    const before = await JSZip.loadAsync(source); const after = await JSZip.loadAsync(result.bytes);
    expect(after.file('xl/calc/chain.xml')).toBeNull();
    expect(await part(result.bytes, '[Content_Types].xml')).not.toContain('calcChain');
    expect(await part(result.bytes, 'xl/_rels/workbook.xml.rels')).not.toContain('calcChain');
    for (const name of ['xl/sharedStrings.xml', 'xl/worksheets/sheet2.xml', '_rels/.rels']) expect(await after.file(name)!.async('string'), name).toBe(await before.file(name)!.async('string'));
    const workbook = await part(result.bytes, 'xl/workbook.xml');
    expect(workbook).toContain('calcMode="manual"'); expect(workbook).toContain('fullCalcOnLoad="1"'); expect(workbook).toContain('<extLst><ext uri="{x}"/></extLst>');
    const sheet = (await part(result.bytes, 'xl/worksheets/sheet1.xml'))!;
    // B1=1, A1=B1+1 with cache 2: the untouched A1 keeps its formula and stored cache; fullCalcOnLoad makes Excel recompute it as 11.
    expect(sheet).toContain('<c r="A1"><f>B1+1</f><v>2</v></c>'); expect(sheet).toContain('<c r="A4" t="inlineStr"><is><t>keep</t></is></c>');
    expect(sheet).toContain('<dimension ref="A1:E4"/>');
    const read = await cells(result.bytes);
    try {
      expect(read.get('B1')!.value).toMatchObject({ kind: 'number', raw: '10' });
      expect(read.get('C1')!.value).toMatchObject({ kind: 'string', text: 'new _x000D_ text\r\n' });
      expect(read.get('E1')!.formula).toMatchObject({ storedText: 'B1+C1+A1', cachePresent: false }); expect(read.get('E1')!.numberFormat).toMatchObject({ id: 2 });
      expect(read.get('E4')!.value).toMatchObject({ kind: 'date-serial', raw: '46348' }); expect(read.get('E4')!.numberFormat!.code).toBe('yyyy-mm-dd');
    } finally { read.close(); }
  });

  it('format-only writes keep formula, value and inline text; base cell format is copied with only the number format changed', async () => {
    const result = await edit(await workbookFixture(), [{ op: 'set_number_format', sheet_id: 'sheet-1', range: 'A1:A4', number_format: '#,##0.00' }]);
    expect(result).toMatchObject({ full_calc_on_load: false, calc_chain_removed: false, cells_written: 0, formats_written: 4 });
    const sheet = (await part(result.bytes, 'xl/worksheets/sheet1.xml'))!;
    expect(sheet).toMatch(/<c r="A1" s="\d+"><f>B1\+1<\/f><v>2<\/v><\/c>/); expect(sheet).toMatch(/<c r="A4" t="inlineStr" s="\d+"><is><t>keep<\/t><\/is><\/c>/);
    const styles = (await part(result.bytes, 'xl/styles.xml'))!;
    expect(styles).toContain('<cellXfs count="4">'); expect(styles).toContain('<xf numFmtId="4" fontId="0" applyNumberFormat="1"><alignment horizontal="center"/></xf>');
    expect(await part(result.bytes, 'xl/workbook.xml')).not.toContain('fullCalcOnLoad');
    expect((await JSZip.loadAsync(result.bytes)).file('xl/calc/chain.xml')).not.toBeNull();
  });

  it('judges shared formula groups on the whole request', async () => {
    expect(await refused(await workbookFixture(), [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'B2', values: [[1]] }])).toMatchObject({ code: 'formula-range-partial' });
    const result = await edit(await workbookFixture(), [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'B2', values: [[1]] }, { op: 'set_formulas', sheet_id: 'sheet-1', cells: { B3: 'A3*4' } }]);
    const sheet = (await part(result.bytes, 'xl/worksheets/sheet1.xml'))!;
    expect(sheet).not.toContain('t="shared"'); expect(sheet).toContain('<c r="B3"><f>A3*4</f></c>');
    expect((await edit(await workbookFixture(), [{ op: 'set_number_format', sheet_id: 'sheet-1', range: 'B2', number_format: '0%' }])).cells_written).toBe(0);
  });

  it('treats an array formula range as one block through its first cell', async () => {
    expect(await refused(await workbookFixture(), [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'D3', values: [[1]] }])).toMatchObject({ code: 'formula-range-partial' });
    const result = await edit(await workbookFixture(), [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'D2', values: [[7]] }]);
    expect(result.array_cells_cleared).toEqual(['sheet-1!D3']);
    const sheet = (await part(result.bytes, 'xl/worksheets/sheet1.xml'))!;
    expect(sheet).toContain('<c r="D2"><v>7</v></c>'); expect(sheet).toContain('<c r="D3"/>');
  });

  it('refuses protected, merged-covered, pivot, macro and signed targets with their codes; other sheets stay writable', async () => {
    expect(await refused(await workbookFixture(), [{ op: 'set_cells', sheet_id: 'sheet-2', range: 'B1', values: [[1]] }])).toMatchObject({ code: 'sheet-protected' });
    expect(await refused(await workbookFixture(), [{ op: 'set_number_format', sheet_id: 'sheet-2', range: 'A1', number_format: '0' }])).toMatchObject({ code: 'sheet-protected' });
    expect((await edit(await workbookFixture({ sheet2: `<worksheet xmlns="${MAIN}"><sheetData/><sheetProtection sheet="0"/></worksheet>` }), [{ op: 'set_cells', sheet_id: 'sheet-2', range: 'A1', values: [[1]] }])).cells_written).toBe(1);
    expect(await refused(await workbookFixture(), [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'G2', values: [[1]] }])).toMatchObject({ code: 'merged-cell-covered' });
    expect((await edit(await workbookFixture(), [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'F1', values: [['top-left']] }])).cells_written).toBe(1);
    const pivot = `<pivotTableDefinition xmlns="${MAIN}" name="P"><location ref="H1:I5" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/></pivotTableDefinition>`;
    expect(await refused(await workbookFixture({ pivot }), [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'H2', values: [[1]] }])).toMatchObject({ code: 'workbook-structure-unsupported' });
    expect((await edit(await workbookFixture({ pivot }), [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'J2', values: [[1]] }])).cells_written).toBe(1);
    expect(await refused(await workbookFixture({ macro: true }), [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'J2', values: [[1]] }])).toMatchObject({ code: 'workbook-macros-unsupported' });
    expect(await refused(await workbookFixture({ signed: true }), [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'J2', values: [[1]] }])).toMatchObject({ code: 'workbook-signed' });
  });

  it('protects table headers and totals, writes table data, and extends a table without totals on append', async () => {
    const sheet1 = (rows: string) => `<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><dimension ref="A1:C3"/><sheetData>${rows}</sheetData><tableParts count="1"><tablePart r:id="t1"/></tableParts></worksheet>`;
    const rows = '<row r="1"><c r="A1" t="inlineStr"><is><t>Qty</t></is></c><c r="B1" t="inlineStr"><is><t>Price</t></is></c><c r="C1" t="inlineStr"><is><t>Total</t></is></c></row>'
      + '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><v>3</v></c><c r="C2"><f>Sales[[#This Row],[Qty]]*Sales[[#This Row],[Price]]</f><v>6</v></c></row>'
      + '<row r="3"><c r="A3"><v>4</v></c><c r="B3"><v>5</v></c><c r="C3"><f>Sales[[#This Row],[Qty]]*Sales[[#This Row],[Price]]</f><v>20</v></c></row>';
    const formula = 'Sales[[#This Row],[Qty]]*Sales[[#This Row],[Price]]';
    const plain = await workbookFixture({ sheet1: sheet1(rows), tables: { table1: tableXml('A1:C3', { formula }) } });
    expect(await refused(plain, [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'A1', values: [['Count']] }])).toMatchObject({ code: 'table-structure-unsupported' });
    const data = await edit(plain, [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'C2', values: [[99]] }]);
    expect(data.calculated_column_notes).toEqual(['sheet-1!C2']);
    const appended = await edit(plain, [{ op: 'append_rows', sheet_id: 'sheet-1', rows: [[7, 8, null]] }]);
    expect(appended.tables_extended).toEqual(['Sales']);
    const table = (await part(appended.bytes, 'xl/tables/table1.xml'))!;
    expect(table).toContain('ref="A1:C4"'); expect(table).toContain('<autoFilter ref="A1:C4"/>');
    expect(await part(appended.bytes, 'xl/worksheets/sheet1.xml')).toContain(`<row r="4"><c r="A4"><v>7</v></c><c r="B4"><v>8</v></c><c r="C4"><f>${formula}</f></c></row>`);
    const totals = await workbookFixture({ sheet1: sheet1(rows), tables: { table1: tableXml('A1:C3', { totals: 1 }) } });
    expect(await refused(totals, [{ op: 'append_rows', sheet_id: 'sheet-1', rows: [[7]] }])).toMatchObject({ code: 'table-structure-unsupported' });
    expect(await refused(totals, [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'A3', values: [[1]] }])).toMatchObject({ code: 'table-structure-unsupported' });
    const headless = await workbookFixture({ sheet1: sheet1('<row r="1"><c r="A1"><v>1</v></c></row>'), tables: { table1: tableXml('A1:C2', { header: 0 }) } });
    expect((await edit(headless, [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'A1:C1', values: [[1, 2, 3]] }])).cells_written).toBe(3);
  });

  it('keeps cells without r attributes, refuses an insertion that would shift them, and bases new cells on row then column styles', async () => {
    const sheet1 = `<worksheet xmlns="${MAIN}"><cols><col min="3" max="3" style="1"/></cols><sheetData><row><c><v>1</v></c><c><v>2</v></c></row><row r="3" s="1" customFormat="1"><c r="B3"><v>3</v></c></row></sheetData></worksheet>`;
    const result = await edit(await workbookFixture({ sheet1 }), [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'D1', values: [[4]] },
      { op: 'set_cells', sheet_id: 'sheet-1', range: 'C2', values: [[5]] }, { op: 'set_cells', sheet_id: 'sheet-1', range: 'A3', values: [[6]] }]);
    expect(result.untouched_cells_checked).toBe(3);
    const sheet = (await part(result.bytes, 'xl/worksheets/sheet1.xml'))!;
    expect(sheet).toContain('<row><c><v>1</v></c><c><v>2</v></c><c r="D1"><v>4</v></c></row>');
    expect(sheet).toContain('<row r="2"><c r="C2" s="1"><v>5</v></c></row>'); expect(sheet).toContain('<c r="A3" s="1"><v>6</v></c><c r="B3"><v>3</v></c>');
    expect((await edit(await workbookFixture({ sheet1 }), [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'A1', values: [[0]] }])).cells_written).toBe(1);
    const shifted = `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="B1"><v>1</v></c><c><v>2</v></c></row></sheetData></worksheet>`;
    expect(await refused(await workbookFixture({ sheet1: shifted }), [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'A1', values: [[0]] }])).toMatchObject({ code: 'workbook-structure-unsupported' });
  });

  it('creates styles for a workbook without them and stores 1904-system dates', async () => {
    const result = await edit(await workbookFixture({ styles: null, date1904: true }), [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'J1', values: [[{ date: '1904-01-02' }]] }]);
    const zip = await JSZip.loadAsync(result.bytes);
    expect(zip.file('xl/styles.xml')).not.toBeNull(); expect(await part(result.bytes, '[Content_Types].xml')).toContain('/xl/styles.xml');
    expect(await part(result.bytes, 'xl/_rels/workbook.xml.rels')).toContain('Target="styles.xml"');
    const read = await cells(result.bytes); try { expect(read.get('J1')!.value).toMatchObject({ kind: 'date-serial', raw: '1', epoch: '1904' }); } finally { read.close(); }
  });

  it('validates formula text, references and number text', () => {
    expect(xlsxFormulaIssue('SUM(A1:A2')).toMatch(/parentheses/); expect(xlsxFormulaIssue('"("&A1')).toBeUndefined(); expect(xlsxFormulaIssue('A1\u0001')).toMatch(/control/);
    expect(() => validateWorkbookEditRequest({ schema_version: 1, path: 'x.xlsx', snapshot_ref: 'w', edits: [{ op: 'set_formulas', sheet_id: 'sheet-1', cells: { A1: 'SUM(' } }] })).toThrow('invalid-formula');
    expect(() => validateWorkbookEditRequest({ schema_version: 1, path: 'x.xlsx', snapshot_ref: 'w', edits: [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'XFE1', values: [[1]] }] })).toThrow('invalid-cell-ref');
    expect(() => validateWorkbookEditRequest({ schema_version: 1, path: 'x.xlsx', snapshot_ref: 'w', edits: [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'A1:B1', values: [[1]] }] })).toThrow('invalid-workbook-edits');
    expect(workbookNumberText(1e21)).toBe('1E+21'); expect(workbookNumberText(-0)).toBe('0'); expect(workbookNumberText(0.1)).toBe('0.1');
    expect(workbookDateSerial('1900-02-28', false)).toBe('59'); expect(workbookDateSerial('1900-03-01', false)).toBe('61'); expect(workbookDateSerial('2023-11-01', false)).toBe('45231');
    expect(workbookDateSerial('2026-11-22T12:00:00', false)).toBe('46348.5');
    expect(xlsxFormulaEffects('CALL("user32","MessageBoxA","JJCCJ",0,"x","y",0)')).toEqual(['native-code']);
    expect(xlsxFormulaEffects("cmd|'/c calc'!A0")).toEqual(['native-code']);
    expect(xlsxFormulaEffects("'[1]Other sheet'!A1+[2]Data!B2")).toEqual(['external-workbook']);
    expect(xlsxFormulaEffects('Sales[[#This Row],[Qty]]*2')).toEqual([]); expect(xlsxFormulaEffects('"WEBSERVICE(" & A1')).toEqual([]);
    expect(xlsxFormulaNetworkHosts('WEBSERVICE("https://Example.com/a")+WEBSERVICE(A1)')).toEqual({ hosts: ['example.com'], dynamic: true });
  });
});

describe('write_workbook generator', () => {
  it('creates a workbook with header, values, per-row formulas and formats, and reads every cell back', async () => {
    const root = await folder();
    const request = validateWorkbookCreateRequest({ schema_version: 1, path: 'new.xlsx', sheets: [
      { name: 'Budget & Plan', header: ['A', 'B', 'C', 'D'], rows: [[1, 2, 3, null], [4, 5, 6, null]], formulas: { D: 'A{row}+B{row}+C{row}', F1: 'SUM(D2:D3)' },
        columns: [{ width: 12 }, {}, { number_format: '0.00' }], freeze_header: true },
      { name: 'Dates', rows: [[{ date: '2026-01-31' }, true, 'text']] }] });
    const result = await createWorkbookPackage({ directory: root, sheets: request.sheets }, CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES, () => {});
    expect(result).toMatchObject({ kind: 'workbook-created', full_calc_on_load: true });
    expect(result.formulas_written.map(item => item.cell)).toEqual(['F1', 'D2', 'D3']);
    const read = await cells(result.bytes);
    try {
      expect(read.manifest.calculation.fullCalcOnLoad).toBe('1'); expect(read.manifest.sheets.map(sheet => sheet.name)).toEqual(['Budget & Plan', 'Dates']);
      expect(read.get('D3')!.formula).toMatchObject({ storedText: 'A3+B3+C3', cachePresent: false });
      expect(read.get('C2')!.numberFormat!.id).toBe(2); expect(read.get('A1')!.value).toMatchObject({ kind: 'string', text: 'A' });
    } finally { read.close(); }
    expect(await part(result.bytes, 'xl/worksheets/sheet1.xml')).toContain('state="frozen"');
    expect(() => validateWorkbookCreateRequest({ schema_version: 1, path: 'x.xlsx', sheets: [{ name: 'a/b', rows: [] }] })).toThrow('invalid-workbook-edits');
  });
});
