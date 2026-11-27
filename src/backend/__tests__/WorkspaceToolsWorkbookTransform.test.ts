import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceTools } from '../WorkspaceTools';
import { OptimisticFileCoordinator } from '../FileCoordinator';
import { SessionLocalReadScopeConsent } from '../localReadScope';
import { workbookRouteReader } from './workbookRouteFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { workbookOutputSize, type PageBudget } from '../../content/WorkbookPage';
import type { WorkbookReader } from '../../content/WorkbookReader';
import { COMPUTE_CSV, workbookSumPlan, WorkbookRecordCollector } from './workbookComputeFixtures';
import { typedXlsxFixture } from '../../content/__tests__/xlsxFixtures';
import JSZip from 'jszip';
import { columnName } from '../../content/WorkbookPage';
const hosts: Array<{ tools: WorkspaceTools; reader: WorkbookReader }> = [];
afterEach(async () => { for (const h of hosts.splice(0)) { h.tools.retire(); await h.reader.dispose(); } await removeTemporaryFolders(); });
const budget: PageBudget = { unit: 'bytes', carrier: 'mcp', limit: 1800, reserved: 70 };
it('explains malformed grouping and header selectors, then computes the corrected plan without changing sources', async () => {
  const h = await host(); const csv = 'Region,Sales\nNorth,10\nNorth,5\nSouth,20';
  const file = join(h.root, 'sales.csv'); await fs.writeFile(file, csv);
  const read = await h.tools.run('read_workbook', { path: 'sales.csv' }); const snapshot_ref = JSON.parse(read.output).snapshot_ref;
  const sources = [{ name: 'sales', snapshot_ref, sheet_id: 'csv:1', range: 'A2:B4' }];
  const badGroup = await h.tools.run('transform_workbook', { sources, steps: [
    { id: 'regions', input: 'sales', operation: 'group', by: ['Region'], fields: [{ field: 'Sales', operation: 'sum', as: 'TotalSales' }] },
  ], output: 'regions' });
  expect(badGroup.status).toBe('failed'); expect(badGroup.output).toContain('steps[0]');
  expect(badGroup.output).toContain('group accepts only by'); expect(badGroup.output).toContain('remove fields');
  expect(badGroup.output).toContain('following aggregate step');
  const badColumn = await h.tools.run('transform_workbook', { sources, steps: [
    { id: 'regions', input: 'sales', operation: 'group', by: ['Region'] },
  ] });
  expect(badColumn.status).toBe('failed'); expect(badColumn.output).toContain('steps[0].by[0]="Region"');
  expect(badColumn.output).toContain('not header text'); expect(badColumn.output).toContain('as_number: true');
  const spec = h.tools.specs().find(spec => spec.function.name === 'transform_workbook')!.function.description;
  const example = JSON.parse(spec.slice(spec.indexOf('{"sources"'), spec.indexOf('}. ', spec.indexOf('{"sources"')) + 1));
  example.sources[0].snapshot_ref = snapshot_ref;
  const grouped = await collect(h, example);
  const rows = grouped.records.filter(item => item.kind === 'row').map(item => item.record.cells);
  expect(rows.map(row => [row.Region.text, row.TotalSales.exact.numerator])).toEqual([['North', '15'], ['South', '20']]);
  const total = await collect(h, { sources, steps: [
    { id: 'parsed', input: 'sales', operation: 'select', columns: [{ column: 'B', as: 'Sales', as_number: true }] },
    { id: 'total', input: 'parsed', operation: 'aggregate', fields: [{ field: 'Sales', operation: 'sum', as: 'TotalSales' }] },
  ] });
  expect(total.records.find(item => item.kind === 'row').record.cells.TotalSales.exact.numerator).toBe('35');
  expect(await fs.readFile(file, 'utf8')).toBe(csv); expect(await fs.readdir(h.root)).toEqual(['sales.csv']);
});
async function host(allowed = new Set(['read'])) {
  const root = await temporaryFolder('unode-transform-tool-'); const reader = await workbookRouteReader(); const coordinator = new OptimisticFileCoordinator();
  const tools = new WorkspaceTools(root, allowed, 'agent', coordinator); tools.setWorkbookReader(reader); tools.beginTurn(); hosts.push({ tools, reader }); return { root, tools, reader, coordinator };
}
async function collect(h: Awaited<ReturnType<typeof host>>, initial: Record<string, unknown>, bound = budget) {
  const records = new WorkbookRecordCollector(); let args = initial; let dataRef = ''; let first = true;
  for (let count = 0; ; count++) {
    expect(count).toBeLessThan(100); const result = await h.tools.run('transform_workbook', args, { workbookBudget: bound });
    expect(result.status, result.output).toBe('success'); expect(workbookOutputSize(result.output, bound) + bound.reserved).toBeLessThanOrEqual(bound.limit);
    const page = JSON.parse(result.output); expect(page.delivery).toBe('prepared'); if (first) { dataRef = page.data_ref; first = false; } else expect(page.data_ref).toBe(dataRef);
    records.add(page); if (!page.next_cursor) return { records: records.records(), dataRef };
    args = { operation: 'read', data_ref: dataRef, cursor: page.next_cursor };
  }
}
it('directs an expired snapshot to transform sources rather than read_workbook arguments', async () => {
  const h = await host();
  const result = await h.tools.run('transform_workbook', workbookSumPlan('missing-snapshot'));
  expect(result.status).toBe('failed');
  expect(result.output).toContain('transform_workbook sources[].snapshot_ref');
  expect(result.output).toContain('Do not pass snapshot_ref to read_workbook');
});
it.each(['eq', 'ne'])('reports cross-type %s as unknown instead of silently excluding text years', async operator => {
  const h = await host(); await fs.writeFile(join(h.root, 'years.csv'), '2026\n2025');
  const read = await h.tools.run('read_workbook', { path: 'years.csv' }); const ref = JSON.parse(read.output).snapshot_ref;
  const result = await collect(h, { sources: [{ name: 'input', snapshot_ref: ref }], steps: [
    { id: 'filter', input: 'input', operation: 'filter', predicate: { column: 'A', operator, value: { kind: 'number', value: '2026' } } },
  ] });
  const manifest = result.records.find(item => item.kind === 'transformation').record;
  expect(manifest.operations.find((operation: any) => operation.id === 'filter').counts).toEqual({ accepted: 0, excluded: 0, unknown: 2 });
  expect(result.records.filter(item => item.kind === 'row')).toHaveLength(2);
});
it('rejects exponent-sized arithmetic before allocating it through CSV, XLSX, filter and unit paths', async () => {
  const h = await host(); const huge = '1e10000000';
  await fs.writeFile(join(h.root, 'huge.csv'), huge);
  const zip = await JSZip.loadAsync(await typedXlsxFixture());
  zip.file('data/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>${huge}</v></c></row></sheetData></worksheet>`);
  const xlsx = await zip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(join(h.root, 'huge.xlsx'), xlsx);
  for (const path of ['huge.csv', 'huge.xlsx']) {
    const read = await h.tools.run('read_workbook', { path }); const snapshot_ref = JSON.parse(read.output).snapshot_ref;
    for (const step of [
      { operation: 'select', columns: [{ column: 'A', as: 'amount', as_number: true }] },
      { operation: 'filter', predicate: { column: 'A', operator: 'eq', value: { kind: 'number', value: huge } } },
      { operation: 'unit-convert', column: 'A', as: 'amount', factor: huge, from_unit: 'a', to_unit: 'b' },
    ]) {
      const result = await h.tools.run('transform_workbook', { sources: [{ name: 'input', snapshot_ref, range: 'A1' }], steps: [{ id: 'bounded', input: 'input', ...step }] });
      expect(result.status).toBe('failed'); expect(result.output).toContain('arithmetic memory budget');
    }
  }
  expect(await fs.readFile(join(h.root, 'huge.csv'), 'utf8')).toBe(huge);
  expect(await fs.readFile(join(h.root, 'huge.xlsx'))).toEqual(xlsx);
});
it('computes exact source groups through the registered tool and real worker, pages records and retains the old version across requests', async () => {
  const h = await host(); const file = join(h.root, 'table.csv'); await fs.writeFile(file, COMPUTE_CSV);
  const inspected = await h.tools.run('read_workbook', { path: 'table.csv' }); const ref = JSON.parse(inspected.output).snapshot_ref;
  expect(h.tools.specs().some(spec => spec.function.name === 'transform_workbook' && spec.returnsExternalContent)).toBe(true);
  const result = await collect(h, workbookSumPlan(ref)); const rows = result.records.filter(item => item.kind === 'row').map(item => item.record.cells);
  expect(rows).toHaveLength(2); const a = rows.find(row => row.team.text === 'A'); const b = rows.find(row => row.team.text === 'B');
  expect(a.total).toEqual({ kind: 'number', exact: { numerator: '3', denominator: '10' } }); expect(a.average.exact).toEqual({ numerator: '3', denominator: '20' });
  expect(a.minimum.exact).toEqual({ numerator: '1', denominator: '10' }); expect(a.maximum.exact).toEqual({ numerator: '1', denominator: '5' });
  expect(b.total.exact).toEqual({ numerator: '9007199254740994', denominator: '1' });
  expect(result.records.find(item => item.kind === 'transformation').record.source_reads[0]).toMatchObject({ snapshot_ref: ref, columns: ['A', 'B'], range: { firstRow: 2, lastRow: 5 } });
  expect(JSON.stringify(result.records)).not.toContain('directory'); expect(await fs.readFile(file, 'utf8')).toBe(COMPUTE_CSV); expect(await fs.readdir(h.root)).toEqual(['table.csv']);
  await fs.writeFile(file, 'changed,9'); h.tools.beginTurn();
  const repeated = await collect(h, { operation: 'read', data_ref: result.dataRef }); expect(repeated.records.filter(item => item.kind === 'row')).toEqual(result.records.filter(item => item.kind === 'row'));
  expect((await h.tools.run('transform_workbook', { ...workbookSumPlan(ref), values: { total: '999' } })).status).toBe('failed');
  const another = await host(); expect((await another.tools.run('transform_workbook', { operation: 'read', data_ref: result.dataRef })).status).toBe('failed');
});
it('keeps read Off and actual source-grant revocation effective for prepared and retained computations', async () => {
  const disabled = await host(new Set()); expect((await disabled.tools.run('transform_workbook', {})).status).toBe('refused');
  const h = await host(); const outside = await temporaryFolder('unode-transform-grant-'); const file = join(outside, 'source.csv'); await fs.writeFile(file, COMPUTE_CSV);
  const owner = new SessionLocalReadScopeConsent(async () => false); const grant = await owner.requestPathAccess(file, { requestId: 'request', isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'request' }));
  h.tools.setLivePathAccess(() => owner.pathAccessFor('request'));
  const read = await h.tools.run('read_workbook', { path: file }); expect(read.status, read.output).toBe('success'); const ref = JSON.parse(read.output).snapshot_ref;
  let rejectedRef = ''; let rejectedDirectory = '';
  const original = h.reader.transform.bind(h.reader); vi.spyOn(h.reader, 'transform').mockImplementation(async (...args) => {
    const result = await original(...args); rejectedRef = result.data_ref;
    // Locate only this host-created root to verify actual disk reclamation before Stop.
    rejectedDirectory = (h.reader as unknown as { transformations: Map<string, { directory: string }> }).transformations.get(rejectedRef)!.directory;
    owner.revokePathAccess(grant!.id); return result;
  });
  const revoked = await h.tools.run('transform_workbook', workbookSumPlan(ref)); expect(revoked.status).toBe('failed'); expect(revoked.output).not.toContain('9007199254740994');
  expect(rejectedDirectory).not.toBe(''); await expect(fs.stat(rejectedDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(h.reader.readTransformation({ data_ref: rejectedRef }, async () => () => true, budget)).rejects.toThrow('invalid-cursor');
  const again = await h.tools.run('transform_workbook', workbookSumPlan(ref)); expect(again.status).not.toBe('success'); expect(again.output).not.toContain('9007199254740994');
});
it('gives usable source-selection guidance for invalid XLSX ranges and unavailable sheets', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'source.xlsx'), await typedXlsxFixture());
  const captured = await h.tools.run('read_workbook', { path: 'source.xlsx' }); const ref = JSON.parse(captured.output).snapshot_ref;
  for (const selection of [{ range: 'Sheet1!A1:B9' }, { sheet_id: 'not-a-readable-sheet' }]) {
    const result = await h.tools.run('transform_workbook', { sources: [{ name: 'input', snapshot_ref: ref, ...selection }],
      steps: [{ id: 'values', input: 'input', operation: 'select', columns: [{ column: 'A' }] }] });
    expect(result.status).toBe('failed'); expect(result.output).not.toContain('could not finish');
    expect(result.output).toContain('range' in selection ? 'ordered A1' : 'read_workbook with operation inspect');
  }
});
it('computes XLSX merge anchors and keeps date epoch, percentage raw value and missing formula caches distinct', async () => {
  const h = await host(); const bytes = await typedXlsxFixture(); const file = join(h.root, 'source.xlsx'); await fs.writeFile(file, bytes);
  const captured = await h.tools.run('read_workbook', { path: 'source.xlsx' }); const ref = JSON.parse(captured.output).snapshot_ref;
  for (const visibility of ['all', 'visible-only']) {
    const result = await collect(h, { sources: [{ name: 'input', snapshot_ref: ref, sheet_id: 'sheet-1', range: 'N1:N2', visibility }], steps: [
      { id: 'values', input: 'input', operation: 'select', columns: [{ column: 'N', as: 'amount' }] },
      { id: 'total', input: 'values', operation: 'aggregate', fields: [{ operation: 'sum', field: 'amount', as: 'total' }] },
    ] });
    expect(result.records.find(item => item.kind === 'row').record.cells.total).toEqual({ kind: 'number', exact: { numerator: '12', denominator: '1' } });
    expect(result.records.find(item => item.kind === 'aggregate-fact').record.fact.fields[0].merged).toBe(visibility === 'all' ? 1 : 0);
    expect(result.records.find(item => item.kind === 'transformation').record.source_reads[0].counts).toMatchObject({ hiddenRows: 1, excludedRows: visibility === 'all' ? 0 : 1 });
  }
  const result = await collect(h, { sources: [{ name: 'input', snapshot_ref: ref, range: 'H1:K1' }], steps: [
    { id: 'values', input: 'input', operation: 'select', columns: [{ column: 'H', as: 'date' }, { column: 'I', as: 'ratio' }, { column: 'J', as: 'cache' }, { column: 'K', as: 'missing' }] },
  ] });
  const cells = result.records.find(item => item.kind === 'row').record.cells;
  expect(cells.date).toEqual({ kind: 'date-serial', raw: '60', epoch: '1900', excelLeapDay: true,
    display: { text: '2/29/00', status: 'formatted', format_code: 'm/d/yy' } });
  expect(cells.ratio.exact).toEqual({ numerator: '3', denominator: '20' }); expect(cells.cache.exact).toEqual({ numerator: '5', denominator: '1' });
  expect(cells.missing).toEqual({ kind: 'missing', reason: 'formula-cache-missing' }); expect(await fs.readFile(file)).toEqual(bytes);
});
it('re-pages one computed result for real stale notices instead of running its computation again', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'source.csv'), COMPUTE_CSV);
  const source = await h.tools.run('read_workbook', { path: 'source.csv' }); const ref = JSON.parse(source.output).snapshot_ref;
  const compute = vi.spyOn(h.reader, 'transform'); const dependency = join(h.root, 'dependency.txt');
  await fs.writeFile(dependency, 'old'); h.coordinator.recordRead('agent', dependency, 'old'); await fs.writeFile(dependency, 'new'); h.coordinator.recordWrite('other', dependency, 'new');
  const result = await h.tools.run('transform_workbook', workbookSumPlan(ref), { workbookBudget: budget });
  expect(result.status, result.output).toBe('success'); expect(result.output).toContain('Dependency changed');
  expect(workbookOutputSize(result.output, budget) + budget.reserved).toBeLessThanOrEqual(budget.limit); expect(compute).toHaveBeenCalledTimes(1);
  const page = JSON.parse(result.output.slice(result.output.indexOf('{"schema_version":1'))); expect(page.data_ref).toMatch(/^data-/);
});
it('propagates unknown filter membership and excludes it only with explicit counted policy', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'filter.csv'), 'team,amount,keep\nA,1,yes\nA,2\nA,3,no');
  const captured = await h.tools.run('read_workbook', { path: 'filter.csv' }); const ref = JSON.parse(captured.output).snapshot_ref;
  for (const missing of ['propagate', 'exclude-with-counts']) {
    const result = await collect(h, { sources: [{ name: 'input', snapshot_ref: ref, range: 'A2:C4' }], steps: [
      { id: 'values', input: 'input', operation: 'select', columns: [{ column: 'A', as: 'team' }, { column: 'B', as: 'amount', as_number: true }, { column: 'C', as: 'keep' }] },
      { id: 'kept', input: 'values', operation: 'filter', predicate: { column: 'keep', operator: 'eq', value: { kind: 'string', value: 'yes' } }, missing },
      { id: 'sum', input: 'kept', operation: 'aggregate', fields: [{ operation: 'sum', field: 'amount', as: 'total' }] },
    ] });
    const meta = result.records.find(item => item.kind === 'transformation').record; expect(meta.table.partial).toBe(true);
    expect(meta.operations.find((operation: any) => operation.id === 'kept').counts).toEqual({ accepted: 1, excluded: missing === 'propagate' ? 1 : 2, unknown: 1 });
    const value = result.records.find(item => item.kind === 'row').record.cells.total;
    expect(value).toEqual(missing === 'propagate' ? { kind: 'missing', reason: 'filter-inclusion-unresolved' } : { kind: 'number', exact: { numerator: '1', denominator: '1' } });
  }
});
it('propagates invalid grouping keys or excludes their rows with explicit group counts', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'groups.csv'), 'team,amount\nA,1\n,2\nB,3');
  const captured = await h.tools.run('read_workbook', { path: 'groups.csv' }); const ref = JSON.parse(captured.output).snapshot_ref;
  for (const missing of ['propagate', 'exclude-with-counts']) {
    const result = await collect(h, { sources: [{ name: 'input', snapshot_ref: ref, range: 'A2:B4' }], steps: [
      { id: 'values', input: 'input', operation: 'select', columns: [{ column: 'A', as: 'team', as_number: true }, { column: 'B', as: 'amount', as_number: true }] },
      { id: 'groups', input: 'values', operation: 'group', by: ['team'] },
      { id: 'sum', input: 'groups', operation: 'aggregate', fields: [{ operation: 'sum', field: 'amount', as: 'total' }], missing },
    ] });
    const meta = result.records.find(item => item.kind === 'transformation').record;
    expect(meta.operations.find((operation: any) => operation.id === 'sum').group_counts).toMatchObject({ inputRows: 3, errorGroupKeys: 3, excludedGroupRows: missing === 'propagate' ? 0 : 3 });
    const rows = result.records.filter(item => item.kind === 'row');
    if (missing === 'propagate') { expect(rows).toHaveLength(1); expect(rows[0].record.cells.total).toEqual({ kind: 'missing', reason: 'group-key-unresolved' }); }
    else { expect(rows).toHaveLength(0); expect(meta.table.partial).toBe(true); }
  }
});
it('prepares a full-width native XLSX row by cells without expanding its repeated strings into a giant JSON row', async () => {
  const h = await host(); const zip = await JSZip.loadAsync(await typedXlsxFixture()); const values = Array.from({ length: 50 }, (_, index) => `value-${index}-` + '界'.repeat(32000));
  zip.file('custom/strings.xml', `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="16384" uniqueCount="50">${values.map(value => `<si><t>${value}</t></si>`).join('')}</sst>`);
  zip.file('data/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${Array.from({ length: 16384 }, (_, index) => `<c r="${columnName(index + 1)}1" t="s"><v>${index % 50}</v></c>`).join('')}</row></sheetData></worksheet>`);
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }); const file = join(h.root, 'wide.xlsx'); await fs.writeFile(file, bytes);
  const captured = await h.tools.run('read_workbook', { path: 'wide.xlsx' }); expect(captured.status, captured.output).toBe('success'); const ref = JSON.parse(captured.output).snapshot_ref;
  const bound: PageBudget = { unit: 'bytes', carrier: 'codex', limit: 64000, reserved: 100 }; let args: Record<string, unknown> = {
    sources: [{ name: 'input', snapshot_ref: ref, range: 'A1:XFD1' }], steps: [{ id: 'unused', input: 'input', operation: 'select', columns: [] }], output: 'input',
  };
  const records = new WorkbookRecordCollector();
  for (let pageIndex = 0; ; pageIndex++) {
    expect(pageIndex).toBeLessThan(50); const result = await h.tools.run('transform_workbook', args, { workbookBudget: bound });
    expect(result.status, result.output).toBe('success'); expect(workbookOutputSize(result.output, bound) + bound.reserved).toBeLessThanOrEqual(bound.limit);
    const page = JSON.parse(result.output); records.add(page);
    const firstCell = page.prepared_fragments.find((item: any) => item.kind === 'table-cell' || (item.kind === 'table-cell-fragment' && item.end_byte === item.total_bytes));
    if (firstCell) break; expect(page.next_cursor).toBeTruthy(); args = { operation: 'read', data_ref: page.data_ref, cursor: page.next_cursor };
  }
  const first = records.records(true).find(item => item.kind === 'table-cell'); expect(first.record).toMatchObject({ firstRow: 1, field: 'A', repeat: 1, value: { kind: 'string', text: values[0] } });
  expect(await fs.readFile(file)).toEqual(bytes);
}, 30000);
it('uses merged anchor labels for grouping while preserving explicit hidden-state restrictions', async () => {
  const h = await host(); const zip = await JSZip.loadAsync(await typedXlsxFixture());
  zip.file('data/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="str"><v>Team</v></c><c r="B1"><v>1</v></c></row><row r="2"><c r="B2"><v>2</v></c></row></sheetData><mergeCells><mergeCell ref="A1:A2"/></mergeCells></worksheet>');
  await fs.writeFile(join(h.root, 'merged.xlsx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const captured = await h.tools.run('read_workbook', { path: 'merged.xlsx' }); const ref = JSON.parse(captured.output).snapshot_ref;
  const plan = workbookSumPlan(ref); plan.sources[0].range = 'A1:B2';
  const result = await collect(h, plan); const rows = result.records.filter(item => item.kind === 'row'); expect(rows).toHaveLength(1);
  expect(rows[0].record.cells.team.text).toBe('Team'); expect(rows[0].record.cells.total.exact).toEqual({ numerator: '3', denominator: '1' });
  zip.file('data/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" hidden="1"/></cols><sheetData><row r="1"><c r="A1" t="str"><v>PRIVATE HIDDEN LABEL</v></c><c r="C1"><v>7</v></c></row></sheetData><mergeCells><mergeCell ref="A1:B1"/></mergeCells></worksheet>');
  await fs.writeFile(join(h.root, 'hidden.xlsx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const hidden = await h.tools.run('read_workbook', { path: 'hidden.xlsx' }); const hiddenRef = JSON.parse(hidden.output).snapshot_ref;
  const kept = await collect(h, { sources: [{ name: 'input', snapshot_ref: hiddenRef, range: 'B1:C1', visibility: 'visible-only' }], steps: [
    { id: 'values', input: 'input', operation: 'select', columns: [{ column: 'B', as: 'team' }, { column: 'C', as: 'amount' }] },
    { id: 'groups', input: 'values', operation: 'group', by: ['team'] },
    { id: 'sum', input: 'groups', operation: 'aggregate', fields: [{ operation: 'sum', field: 'amount', as: 'total' }] },
  ] });
  expect(kept.records.filter(item => item.kind === 'row')).toHaveLength(0); expect(JSON.stringify(kept.records)).not.toContain('PRIVATE HIDDEN LABEL');
  expect(kept.records.find(item => item.kind === 'transformation').record.operations.find((operation: any) => operation.id === 'sum').group_counts.visibilityExcludedGroupRows).toBe(1);
});
