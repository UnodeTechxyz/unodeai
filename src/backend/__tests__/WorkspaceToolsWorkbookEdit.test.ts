import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { saveHost, sha } from './attachmentSaveFixtures';
import { workbookRouteReader, workbookRouteEditor } from './workbookRouteFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { COMPUTE_CSV, workbookSumPlan } from './workbookComputeFixtures';
import { workbookFixture, tableXml, MAIN, REL } from '../../office/__tests__/workbookEditFixtures';
import { parseXlsxSnapshot } from '../../content/XlsxWorkbook';
import { XlsxPointReader } from '../../content/XlsxPointReader';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); await removeTemporaryFolders(); });
async function host(options: Parameters<typeof saveHost>[0] = {}) {
  const h = await saveHost(options); const workbook = await workbookRouteReader(); const editor = await workbookRouteEditor(); const tools = h.tools('dev');
  tools.setWorkbookReader(workbook); tools.setWorkbookEditor(editor); tools.beginTurn();
  cleanup.push(async () => { tools.retire(); await workbook.dispose(); await h.assets.dispose(); }); return { ...h, workbook, editor, tools };
}
async function inspect(h: Awaited<ReturnType<typeof host>>, path: string) {
  const result = await h.tools.run('read_workbook', { path }); expect(result.status, result.output).toBe('success'); return JSON.parse(result.output).snapshot_ref as string;
}
async function readCell(file: string, sheet: string, row: number, column: number) {
  const directory = await fs.mkdtemp(join(file, '..', 'readback-')); const manifest = await parseXlsxSnapshot(file, directory, () => {});
  const info = manifest.sheets.find(item => item.sheetId === sheet)!; const reader = new XlsxPointReader(directory, join(directory, info.directory!), info.metadata!, manifest.date1904);
  try { return reader.cell(row, column); } finally { reader.close(); await fs.rm(directory, { recursive: true, force: true }); }
}

it('registered edit_workbook writes formulas and values to a copy, then in place, through the actual worker, approval and read-back', async () => {
  const h = await host(); const source = await workbookFixture(); await fs.writeFile(join(h.root, 'book.xlsx'), source);
  expect(h.tools.specs().map(spec => spec.function.name)).toEqual(expect.arrayContaining(['edit_workbook', 'write_workbook']));
  const snapshot = await inspect(h, 'book.xlsx');
  const result = await h.tools.run('edit_workbook', { schema_version: 1, path: 'out/total.xlsx', snapshot_ref: snapshot, edits: [
    { op: 'set_cells', sheet_id: 'sheet-1', range: 'B1', values: [[10]] }, { op: 'set_formulas', sheet_id: 'sheet-1', cells: { E1: 'A1+B1' } }] });
  expect(result.status, result.output).toBe('success');
  expect(result.output).toContain('Formula cells written (1): sheet-1!E1 = A1+B1'); expect(result.output).toContain('Recalculated: no.');
  expect(result).toMatchObject({ workbookWrite: { code: 'written', targetEffect: 'written', receipt: { kind: 'workbook-edited', sourceSha256: sha(source),
    formulas_written: ['sheet-1!E1'], recalculated: false, full_calc_on_load: true, calc_chain_removed: true, effect: 'created' } } });
  const output = await fs.readFile(join(h.root, 'out', 'total.xlsx')); expect(result.workbookWrite!.receipt!.sha256).toBe(sha(output));
  expect((await readCell(join(h.root, 'out', 'total.xlsx'), 'sheet-1', 1, 5))!.formula).toMatchObject({ storedText: 'A1+B1', cachePresent: false });
  expect(await fs.readFile(join(h.root, 'book.xlsx'))).toEqual(source);
  const inPlace = await h.tools.run('edit_workbook', { schema_version: 1, path: 'book.xlsx', snapshot_ref: snapshot, edits: [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'B1', values: [['text']] }] });
  expect(inPlace.status, inPlace.output).toBe('success'); expect(inPlace.workbookWrite!.receipt).toMatchObject({ effect: 'replaced' });
  const stale = await h.tools.run('edit_workbook', { schema_version: 1, path: 'again.xlsx', snapshot_ref: snapshot, edits: [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'B1', values: [[1]] }] });
  expect(stale.status).toBe('failed'); expect(stale.output).toMatch(/changed since inspect|not held/); await expect(fs.stat(join(h.root, 'again.xlsx'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('registered edit_workbook refuses a protected sheet with its next step and writes nothing; a denied approval saves nothing', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'book.xlsx'), await workbookFixture()); const snapshot = await inspect(h, 'book.xlsx');
  const locked = await h.tools.run('edit_workbook', { schema_version: 1, path: 'out.xlsx', snapshot_ref: snapshot, edits: [{ op: 'set_cells', sheet_id: 'sheet-2', range: 'B1', values: [[1]] }] });
  expect(locked.status).toBe('failed'); expect(locked.output).toContain('Unprotect Sheet'); expect(locked).toMatchObject({ workbookWrite: { code: 'sheet-protected', targetEffect: 'none' } });
  await expect(fs.stat(join(h.root, 'out.xlsx'))).rejects.toMatchObject({ code: 'ENOENT' });
  const denied = await host({ ask: true, approve: async () => 'deny' as never }); await fs.writeFile(join(denied.root, 'book.xlsx'), await workbookFixture());
  const fresh = await inspect(denied, 'book.xlsx');
  const result = await denied.tools.run('edit_workbook', { schema_version: 1, path: 'out.xlsx', snapshot_ref: fresh, edits: [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'J1', values: [[1]] }] });
  expect(result.status).not.toBe('success'); await expect(fs.stat(join(denied.root, 'out.xlsx'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('registered write_workbook creates a workbook with host data from transform_workbook and per-row formulas', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'sales.csv'), COMPUTE_CSV);
  const read = await h.tools.run('read_workbook', { path: 'sales.csv' }); expect(read.status, read.output).toBe('success');
  const computed = await h.tools.run('transform_workbook', workbookSumPlan(JSON.parse(read.output).snapshot_ref)); expect(computed.status, computed.output).toBe('success');
  const page = JSON.parse(computed.output); const field = 'total';
  const result = await h.tools.run('write_workbook', { schema_version: 1, path: 'report.xlsx', sheets: [{ name: 'Report', header: ['Total', 'Double'],
    rows: [[{ from: { transformation_ref: page.transformation_ref, field, row: 1 } }, null]], formulas: { B: 'A{row}*2' } }] });
  expect(result.status, result.output).toBe('success'); expect(result.output).toContain(`from ${page.transformation_ref}`);
  expect(result).toMatchObject({ workbookWrite: { receipt: { kind: 'workbook-created', formulas_written: ['sheet-1!B2'], recalculated: false } } });
  const file = join(h.root, 'report.xlsx'); expect((await readCell(file, 'sheet-1', 2, 2))!.formula!.storedText).toBe('A2*2');
  expect((await readCell(file, 'sheet-1', 2, 1))!.value).toMatchObject({ kind: 'number', raw: '0.3' });
  const zip = await JSZip.loadAsync(await fs.readFile(file)); expect(await zip.file('xl/workbook.xml')!.async('string')).toContain('fullCalcOnLoad="1"');
});

it('keeps both writers unavailable without Write and edit_workbook unavailable without Read', async () => {
  const noWrite = await host({ capabilities: ['read'] });
  expect(noWrite.tools.specs().some(spec => ['edit_workbook', 'write_workbook'].includes(spec.function.name))).toBe(false);
  expect(await noWrite.tools.run('write_workbook', { schema_version: 1, path: 'x.xlsx', sheets: [{ name: 'A', rows: [[1]] }] })).toMatchObject({ status: 'refused', reason: 'capability' });
  const noRead = await host({ capabilities: ['write'] });
  expect(noRead.tools.specs().some(spec => spec.function.name === 'edit_workbook')).toBe(false); expect(noRead.tools.specs().some(spec => spec.function.name === 'write_workbook')).toBe(true);
  expect(await noRead.tools.run('edit_workbook', { schema_version: 1, path: 'x.xlsx', snapshot_ref: 'workbook-1', edits: [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'A1', values: [[1]] }] }))
    .toMatchObject({ status: 'refused', reason: 'capability' });
});

const FORMULA = 'Sales[[#This Row],[Qty]]*Sales[[#This Row],[Price]]';
async function tableBook() {
  const rows = '<row r="1"><c r="A1" t="inlineStr"><is><t>Qty</t></is></c><c r="B1" t="inlineStr"><is><t>Price</t></is></c><c r="C1" t="inlineStr"><is><t>Total</t></is></c></row>'
    + `<row r="2"><c r="A2"><v>2</v></c><c r="B2"><v>3</v></c><c r="C2"><f>${FORMULA}</f><v>6</v></c></row>`
    + `<row r="3"><c r="A3"><v>4</v></c><c r="B3"><v>5</v></c><c r="C3"><f>${FORMULA}</f><v>20</v></c></row>`;
  return workbookFixture({ sheet1: `<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><dimension ref="A1:C3"/><sheetData>${rows}</sheetData><tableParts count="1"><tablePart r:id="t1"/></tableParts></worksheet>`,
    tables: { table1: tableXml('A1:C3', { formula: FORMULA }) } });
}
async function savedPart(h: Awaited<ReturnType<typeof host>>, name: string) { return (await JSZip.loadAsync(await fs.readFile(join(h.root, 'out.xlsx')))).file(name)!.async('string'); }

it('audit F1: a second append in one request extends the table again and fills its calculated column', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'book.xlsx'), await tableBook()); const snapshot = await inspect(h, 'book.xlsx');
  const result = await h.tools.run('edit_workbook', { schema_version: 1, path: 'out.xlsx', snapshot_ref: snapshot, edits: [
    { op: 'append_rows', sheet_id: 'sheet-1', rows: [[7, 8, null]] }, { op: 'append_rows', sheet_id: 'sheet-1', rows: [[9, 10, null]] }] });
  expect(result.status, result.output).toBe('success');
  const table = await savedPart(h, 'xl/tables/table1.xml'); expect(table).toContain('ref="A1:C5"'); expect(table).toContain('<autoFilter ref="A1:C5"/>');
  const sheet = await savedPart(h, 'xl/worksheets/sheet1.xml');
  expect(sheet).toContain(`<c r="C4"><f>${FORMULA}</f></c>`); expect(sheet).toContain(`<c r="C5"><f>${FORMULA}</f></c>`);
  expect(result.workbookWrite!.receipt!.formulas_written).toEqual(['sheet-1!C4', 'sheet-1!C5']);
});

it('audit F2: an append after other content edits starts below the last row with content at that point', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'book.xlsx'), await tableBook()); const snapshot = await inspect(h, 'book.xlsx');
  const result = await h.tools.run('edit_workbook', { schema_version: 1, path: 'out.xlsx', snapshot_ref: snapshot, edits: [
    { op: 'append_rows', sheet_id: 'sheet-1', rows: [[7, 8, null]] }, { op: 'set_cells', sheet_id: 'sheet-1', range: 'A10:B10', values: [[11, 12]] },
    { op: 'append_rows', sheet_id: 'sheet-1', rows: [[9, 10]] }] });
  expect(result.status, result.output).toBe('success');
  const sheet = await savedPart(h, 'xl/worksheets/sheet1.xml');
  expect(sheet).toContain('<row r="10"><c r="A10"><v>11</v></c><c r="B10"><v>12</v></c></row><row r="11"><c r="A11"><v>9</v></c><c r="B11"><v>10</v></c></row>');
  expect(sheet).not.toContain('<row r="5">');
  // A cleared cell is not content, and consecutive appends still follow each other.
  const plain = await h.tools.run('edit_workbook', { schema_version: 1, path: 'plain.xlsx', snapshot_ref: snapshot, edits: [
    { op: 'set_cells', sheet_id: 'sheet-1', range: 'E20', values: [[null]] }, { op: 'append_rows', sheet_id: 'sheet-1', rows: [[7]] }, { op: 'append_rows', sheet_id: 'sheet-1', rows: [[9]] }] });
  expect(plain.status, plain.output).toBe('success');
  const plainSheet = await (await JSZip.loadAsync(await fs.readFile(join(h.root, 'plain.xlsx')))).file('xl/worksheets/sheet1.xml')!.async('string');
  expect(plainSheet).toContain('<c r="A4"><v>7</v></c>'); expect(plainSheet).toContain('<c r="A5"><v>9</v></c>');
});
