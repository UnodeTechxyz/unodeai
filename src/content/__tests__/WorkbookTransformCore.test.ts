import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, expect, it } from 'vitest';
import { temporaryFolder, removeTemporaryFolders } from '../../backend/__tests__/pathSafetyFixtures';
import { parseCsvSnapshot } from '../CsvWorkbook';
import { WorkbookExactNumber } from '../WorkbookExactNumber';
import { csvWorkbookRows } from '../WorkbookCsvRows';
import { aggregateWorkbookRows, type WorkbookGroupCounts, type WorkbookRowBlock } from '../WorkbookAggregate';
import { WorkbookTableReader, WorkbookTableWriter } from '../WorkbookTable';
import { typedXlsxFixture } from './xlsxFixtures';
import { parseXlsxSnapshot } from '../XlsxWorkbook';
import { XlsxPointReader } from '../XlsxPointReader';
import { xlsxWorkbookRows, type WorkbookSourceCounts } from '../WorkbookXlsxRows';
import { validateWorkbookTransformPlan } from '../WorkbookTransformPlan';
import { executeWorkbookTransform } from '../WorkbookTransform';
afterEach(removeTemporaryFolders);
it('does not split equal group keys by display style or change their exact arithmetic', async () => {
  async function* rows(): AsyncGenerator<WorkbookRowBlock> {
    for (const format_code of ['0%', '"$"0.00']) yield { repeat: 1, cells: {
      key: { kind: 'number', exact: { numerator: '1', denominator: '1' }, display: { text: format_code, status: 'formatted', format_code } },
      amount: { kind: 'number', exact: { numerator: '1', denominator: '1' } },
    } };
  }
  const result = []; for await (const item of aggregateWorkbookRows(rows(), { group_by: ['key'], missing: 'propagate', fields: [{ operation: 'sum', field: 'amount', as: 'total' }] }, () => {})) result.push(item);
  expect(result).toHaveLength(1); expect(result[0].row.total).toEqual({ kind: 'number', exact: { numerator: '2', denominator: '1' } });
});
it('keeps exact decimal/rational results and labels actual IEEE754 conversion loss', () => {
  const parse = (raw: string) => WorkbookExactNumber.parse(raw);
  expect(parse('0.1').add(parse('0.2')).json()).toEqual({ numerator: '3', denominator: '10' });
  expect(parse('1').divide(parse('3')).json()).toEqual({ numerator: '1', denominator: '3' });
  expect(parse('9007199254740993').add(parse('1')).json()).toEqual({ numerator: '9007199254740994', denominator: '1' });
  expect(parse('0.1').chartNumber()).toEqual({ value: 0.1, exact: false }); expect(parse('0.5').chartNumber()).toEqual({ value: 0.5, exact: true });
  expect(parse('1e400').add(parse('1')).divide(parse('1e400')).chartNumber()).toEqual({ value: 1, exact: false });
  for (const raw of ['5e-324', '2.2250738585072014e-308', '1.7976931348623157e308', '-0.1']) expect(parse(raw).chartNumber().value).toBe(Number(raw));
  for (const raw of ['1,000', '1,5', ' 1', '=1+1', '']) expect(() => parse(raw)).toThrow('ambiguous-or-nonnumeric-literal');
});
it('computes groups from actual CSV indices while counting missing vs empty and a sparse absent tail', async () => {
  const root = await temporaryFolder('unode-transform-csv-'); const source = join(root, 'source'); const directory = join(root, 'parsed'); await fs.mkdir(directory);
  const input = 'category,amount\r\nA,0.1\r\nA,0.2\r\nA,\r\nA\r\nB,9007199254740993\r\nB,1'; await fs.writeFile(source, input);
  const manifest = await parseCsvSnapshot(source, directory, {}, () => {}); let visits = 0;
  const rows = () => csvWorkbookRows(directory, manifest, 2, 1048576, [{ column: 1, as: 'category', as_number: false }, { column: 2, as: 'amount', as_number: true }], undefined, () => { visits++; });
  const fields = [{ operation: 'sum' as const, field: 'amount', as: 'total' }, { operation: 'average' as const, field: 'amount', as: 'average' }, { operation: 'count' as const, as: 'rows' }];
  const groups: WorkbookGroupCounts = { inputRows: 0, excludedGroupRows: 0, visibilityExcludedGroupRows: 0, missingGroupKeys: 0, errorGroupKeys: 0, unresolvedGroupKeys: 0 };
  const output = []; for await (const result of aggregateWorkbookRows(rows(), { group_by: ['category'], fields, missing: 'exclude-with-counts' }, () => {}, groups)) output.push(result);
  expect(visits).toBe(7);
  expect(output[0].row.total).toEqual({ kind: 'number', exact: { numerator: '3', denominator: '10' } });
  expect(output[0].row.average).toEqual({ kind: 'number', exact: { numerator: '3', denominator: '20' } });
  expect(output[0].facts[0]).toMatchObject({ accepted: 2, missing: 1, errors: 1, partial: true });
  expect(output[1].row.total).toEqual({ kind: 'number', exact: { numerator: '9007199254740994', denominator: '1' } });
  expect(output).toHaveLength(2); expect(groups.excludedGroupRows).toBe(1048569); expect(groups.missingGroupKeys).toBe(1048569);
  const strict = []; for await (const result of aggregateWorkbookRows(rows(), { group_by: ['category'], fields, missing: 'propagate' }, () => {})) strict.push(result);
  expect(strict[0].row.total.kind).toBe('missing'); expect(await fs.readFile(source, 'utf8')).toBe(input);
});
it('stores one long shared XLSX value once across thousands of intermediate rows', async () => {
  const root = await temporaryFolder('unode-transform-sst-'); const source = join(root, 'source'); const directory = join(root, 'parsed'); const output = join(root, 'result');
  await fs.mkdir(directory); await fs.mkdir(output); const text = 'Shared 😀'.repeat(4000); const zip = await JSZip.loadAsync(await typedXlsxFixture());
  zip.file('custom/strings.xml', `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2000" uniqueCount="1"><si><t>${text}</t></si></sst>`);
  zip.file('data/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${Array.from({ length: 2000 }, (_, index) => `<row r="${index + 1}"><c r="A${index + 1}" t="s"><v>0</v></c></row>`).join('')}</sheetData></worksheet>`);
  const input = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }); await fs.writeFile(source, input);
  const manifest = await parseXlsxSnapshot(source, directory, () => {}); const sheet = manifest.sheets[0];
  const points = new XlsxPointReader(directory, join(directory, sheet.directory!), sheet.metadata!, false); const writer = new WorkbookTableWriter(output, ['value']);
  try {
    for (let row = 1; row <= 2000; row++) { const value = points.cell(row, 1)!.value; if (value.kind !== 'string') throw new Error('fixture cell not string');
      writer.append({ cells: { value }, repeat: 1 }); }
    expect(writer.info('result')).toMatchObject({ rows: 2000, blocks: 2000 });
  } finally { writer.close(); points.close(); }
  expect((await fs.stat(join(output, 'values.json-data'))).size).toBeLessThan(Buffer.byteLength(text) + 1000);
  const reader = new WorkbookTableReader(output, ['value']);
  try { expect(reader.block(0)?.cells.value).toEqual({ kind: 'string', text }); expect(reader.block(1999)?.cells.value).toEqual({ kind: 'string', text }); }
  finally { reader.close(); }
  expect(await fs.readFile(source)).toEqual(input);
});
it('computes actual XLSX saved values without double-counting merged cells and records saved hidden scope', async () => {
  const root = await temporaryFolder('unode-transform-xlsx-'); const source = join(root, 'source'); const directory = join(root, 'parsed'); await fs.mkdir(directory);
  const bytes = await typedXlsxFixture(); await fs.writeFile(source, bytes); const manifest = await parseXlsxSnapshot(source, directory, () => {});
  for (const visibility of ['all', 'visible-only'] as const) {
    const counts: WorkbookSourceCounts = { includedRows: 0, excludedRows: 0, hiddenRows: 0, hiddenColumns: 0, excludedColumns: 0 };
    const rows = xlsxWorkbookRows(directory, manifest, manifest.sheets[0], 1, 2, [{ column: 14, as: 'amount', as_number: false }], visibility, counts, () => {});
    const output = []; for await (const item of aggregateWorkbookRows(rows, { group_by: [], missing: 'propagate', fields: [{ operation: 'sum', field: 'amount', as: 'total' }] }, () => {})) output.push(item);
    expect(output[0].row.total).toEqual({ kind: 'number', exact: { numerator: '12', denominator: '1' } });
    expect(output[0].facts[0].merged).toBe(visibility === 'all' ? 1 : 0);
    expect(counts).toMatchObject({ includedRows: visibility === 'all' ? 2 : 1, excludedRows: visibility === 'all' ? 0 : 1, hiddenRows: 1 });
  }
  const counts: WorkbookSourceCounts = { includedRows: 0, excludedRows: 0, hiddenRows: 0, hiddenColumns: 0, excludedColumns: 0 };
  const missing = []; for await (const row of xlsxWorkbookRows(directory, manifest, manifest.sheets[0], 1, 1, [{ column: 11, as: 'cache', as_number: false }], 'all', counts, () => {})) missing.push(row);
  expect(missing[0].cells.cache).toEqual({ kind: 'missing', reason: 'formula-cache-missing' }); expect(await fs.readFile(source)).toEqual(bytes);
});
it('executes named selection/filter/group/aggregate/unit steps against real CSV indices', async () => {
  const root = await temporaryFolder('unode-transform-plan-'); const source = join(root, 'source'); const parsed = join(root, 'parsed'); const output = join(root, 'result');
  await fs.mkdir(parsed); await fs.mkdir(output); const input = 'team,amount,keep\nA,0.1,yes\nA,0.2,yes\nA,10,no\nB,9007199254740993,yes\nB,1,yes'; await fs.writeFile(source, input);
  const manifest = await parseCsvSnapshot(source, parsed, {}, () => {});
  const plan = validateWorkbookTransformPlan({ sources: [{ name: 'source', snapshot_ref: 'snapshot', range: 'A2:C6' }], steps: [
    { id: 'select', input: 'source', operation: 'select', columns: [{ column: 'A', as: 'team' }, { column: 'B', as: 'amount', as_number: true }, { column: 'C', as: 'keep' }] },
    { id: 'filter', input: 'select', operation: 'filter', predicate: { column: 'keep', operator: 'eq', value: { kind: 'string', value: 'yes' } } },
    { id: 'group', input: 'filter', operation: 'group', by: ['team'] },
    { id: 'sum', input: 'group', operation: 'aggregate', fields: [{ operation: 'sum', field: 'amount', as: 'total' }, { operation: 'average', field: 'amount', as: 'average' }, { operation: 'count', as: 'count' }] },
    { id: 'units', input: 'sum', operation: 'unit-convert', column: 'total', as: 'percent', factor: '100', from_unit: 'ratio', to_unit: 'percent' },
  ] });
  const result = await executeWorkbookTransform(output, [{ name: 'source', snapshot: { snapshotRef: 'snapshot', sourceSha256: manifest.sha256, bytes: Buffer.byteLength(input), directory: parsed, source: manifest } }], plan, () => {});
  expect(result.executed_steps).toEqual(['select', 'filter', 'group', 'sum', 'units']); expect(result.table.rows).toBe(2);
  expect(result.operations).toContainEqual({ id: 'filter', operation: 'filter', missing: 'propagate', counts: { accepted: 4, excluded: 1, unknown: 0 } });
  const reader = new WorkbookTableReader(join(output, result.table.directory), result.table.columns);
  try {
    const a = reader.block(0)!.cells; const b = reader.block(1)!.cells;
    expect(a.total).toEqual({ kind: 'number', exact: { numerator: '3', denominator: '10' } });
    expect(a.average).toEqual({ kind: 'number', exact: { numerator: '3', denominator: '20' } });
    expect(a.percent).toEqual({ kind: 'number', exact: { numerator: '30', denominator: '1' } });
    expect(b.total).toEqual({ kind: 'number', exact: { numerator: '9007199254740994', denominator: '1' } });
    expect(reader.logicalRow(2)?.cells).toEqual(b); expect(reader.logicalRow(3)).toBeUndefined();
  } finally { reader.close(); }
  expect(result.source_reads).toMatchObject([{ snapshot_ref: 'snapshot', source_sha256: manifest.sha256, range: { firstRow: 2, lastRow: 6 } }]);
  expect(await fs.readFile(source, 'utf8')).toBe(input);
  expect(() => validateWorkbookTransformPlan({ ...plan, result: { total: '999' } })).toThrow('invalid-transform-plan');
});
