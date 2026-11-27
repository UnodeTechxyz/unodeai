import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { saveHost, sha } from './attachmentSaveFixtures';
import { workbookRouteReader } from './workbookRouteFixtures';
import { presentationRouteRenderer } from './presentationRouteFixtures';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import { COMPUTE_CSV, workbookSumPlan } from './workbookComputeFixtures';
import { presentationTableTexts } from '../../office/PresentationDataCheck';
import { checkPresentationData } from '../../office/PresentationDataCheck';
import type { WorkbookReader } from '../../content/WorkbookReader';
import type { WorkspaceTools } from '../WorkspaceTools';
import { SessionLocalReadScopeConsent } from '../localReadScope';
import { WorkspaceTools as Tools } from '../WorkspaceTools';
import { checkPresentationCharts } from '../../office/PresentationChartCheck';
const owners: Array<{ tools: WorkspaceTools; reader: WorkbookReader }> = [];
afterEach(async () => { for (const owner of owners.splice(0)) { owner.tools.retire(); await owner.reader.dispose(); } await removeTemporaryFolders(); });
async function host(options: Parameters<typeof saveHost>[0] = {}) {
  const h = await saveHost(options); const tools = h.tools(); const reader = await workbookRouteReader(); const renderer = await presentationRouteRenderer();
  tools.setWorkbookReader(reader); tools.setPresentationRenderer(renderer); tools.beginTurn(); owners.push({ tools, reader }); return { ...h, tools, reader, renderer };
}
async function compute(h: Awaited<ReturnType<typeof host>>, source = join(h.root, 'source.csv')) {
  await fs.writeFile(source, COMPUTE_CSV); const read = await h.tools.run('read_workbook', { path: source }); expect(read.status, read.output).toBe('success');
  const result = await h.tools.run('transform_workbook', workbookSumPlan(JSON.parse(read.output).snapshot_ref)); expect(result.status, result.output).toBe('success');
  return JSON.parse(result.output).transformation_ref as string;
}
function request(ref: string, rows?: (string | number)[][]) {
  return { schema_version: 1, path: 'out/bound.pptx', deck: { title: 'Host values', slides: [{ objects: [
    { type: 'table', x: 0.5, y: 0.5, w: 10, h: 4, data_from: { transformation_ref: ref, fields: ['team', 'total', 'average'] }, ...(rows ? { rows } : {}) },
  ] }] } };
}
function chartRequest(ref: string, fields = ['total', 'average']) {
  return { schema_version: 1, path: 'out/chart.pptx', deck: { slides: [{ notes: 'Owner notes stay here', objects: [
    { type: 'chart', chartType: 'line', x: 1, y: 1, w: 8, h: 4,
      data_from: { transformation_ref: ref, label_field: 'team', value_fields: fields } },
  ] }] } };
}
it('fills real native charts from exact host data and keeps binary precision partial with exact notes', async () => {
  const h = await host(); const ref = await compute(h); const input = chartRequest(ref);
  const supplied = { ...input.deck.slides[0].objects[0], series: [
    { name: 'total', labels: ['A', 'B'], values: [999, 9007199254740994] },
    { name: 'average', labels: ['A', 'B'], values: [0.15, 4503599627370497] },
  ] };
  const result = await h.tools.run('write_presentation', { ...input, deck: { slides: [{ ...input.deck.slides[0], objects: [supplied] }] } });
  expect(result.status, result.output).toBe('success'); const bytes = await fs.readFile(join(h.root, 'out/chart.pptx'));
  const zip = await JSZip.loadAsync(bytes); const chart = await zip.file('ppt/charts/chart1.xml')!.async('string');
  expect(chart).toContain('<c:v>0.3</c:v>'); expect(chart).not.toContain('<c:v>999</c:v>');
  const notes = await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string');
  expect(notes).toContain('Owner notes stay here'); expect(notes).toContain('exact\\u005ftext'); expect(notes).toContain('0.15');
  expect(result.presentationWrite?.receipt?.chartBindings).toMatchObject([{ transformation_ref: ref, points: 4, precision_loss: 2, blank_points: 0,
    supplied: { present: true, differences: 1 }, sources: [{ sha256: sha(COMPUTE_CSV) }], output: { status: 'partial', differences: 0, package_sha256: sha(bytes) } }]);
  expect(result.output).toContain('data checks: partial'); expect(h.state.approvals).toEqual([]);
});
it('binds charts and table cells together and reports exact integer chart checks passed', async () => {
  const h = await host(); const ref = await compute(h); const input = chartRequest(ref, ['count']);
  const result = await h.tools.run('write_presentation', { ...input, deck: { slides: [{ objects: [
    ...input.deck.slides[0].objects, request(ref).deck.slides[0].objects[0],
  ] }] } }); expect(result.status, result.output).toBe('success');
  expect(result.presentationWrite?.receipt?.chartBindings).toMatchObject([{ points: 2, precision_loss: 0, output: { status: 'passed', differences: 0 } }]);
  expect(result.presentationWrite?.receipt?.dataBindings).toMatchObject([{ output: { status: 'passed' } }]);
});
it('keeps missing numeric chart points blank, preserves zero and exact repeating rational notes', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'source.csv'), 'label,amount\nA,1\nA,0\nA,0\nB,0\nmissing');
  const read = await h.tools.run('read_workbook', { path: 'source.csv' }); const plan = workbookSumPlan(JSON.parse(read.output).snapshot_ref);
  plan.sources[0].range = 'A2:B6'; const transformed = await h.tools.run('transform_workbook', plan); expect(transformed.status, transformed.output).toBe('success');
  const ref = JSON.parse(transformed.output).transformation_ref; const result = await h.tools.run('write_presentation', chartRequest(ref, ['average']));
  expect(result.status, result.output).toBe('success'); const bytes = await fs.readFile(join(h.root, 'out/chart.pptx')); const zip = await JSZip.loadAsync(bytes);
  expect(await zip.file('ppt/charts/chart1.xml')!.async('string')).toContain('<c:pt idx="1"><c:v>0</c:v>');
  expect(await zip.file('ppt/charts/chart1.xml')!.async('string')).toContain('<c:pt idx="2"><c:v></c:v>');
  const notes = await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string'); expect(notes).toContain('1/3'); expect(notes).toContain('[Missing:');
  expect(result.presentationWrite?.receipt?.chartBindings).toMatchObject([{ points: 3, precision_loss: 1, blank_points: 1, output: { status: 'partial', differences: 0 } }]);
  // Real package mutation cannot keep a passing data check just because the source ref is unchanged.
  const expected = { labels: ['A', 'B', 'missing'], series: [{ name: 'average', labels: ['A', 'B', 'missing'], values: [1 / 3, 0, null] }], points: [], unknownLabels: 0, partial: false, exactNote: '' };
  zip.file('ppt/charts/chart1.xml', (await zip.file('ppt/charts/chart1.xml')!.async('string')).replace('<c:v>0.3333333333333333</c:v>', '<c:v>999</c:v>'));
  const changed = await zip.generateAsync({ type: 'nodebuffer' }); const checked = await checkPresentationCharts(changed, [{ values: expected, fact: result.presentationWrite!.receipt!.chartBindings![0] }]);
  expect(checked[0].output).toMatchObject({ status: 'failed', differences: 1, package_sha256: sha(changed) });
  const original = await JSZip.loadAsync(bytes); const workbookName = Object.keys(original.files).find(name => name.startsWith('ppt/embeddings/') && name.endsWith('.xlsx'))!;
  const workbook = await JSZip.loadAsync(await original.file(workbookName)!.async('nodebuffer'));
  const sheet = await workbook.file('xl/worksheets/sheet1.xml')!.async('string');
  workbook.file('xl/worksheets/sheet1.xml', sheet.replace('<v>0.3333333333333333</v>', '<v>999</v>'));
  original.file(workbookName, await workbook.generateAsync({ type: 'nodebuffer' }));
  expect((await checkPresentationCharts(await original.generateAsync({ type: 'nodebuffer' }), [{ values: expected, fact: result.presentationWrite!.receipt!.chartBindings![0] }]))[0].output).toMatchObject({ status: 'failed', differences: 1 });
  const noteExpected = { ...expected, exactNote: 'Retained text that is missing from these real notes' };
  expect((await checkPresentationCharts(bytes, [{ values: noteExpected, fact: result.presentationWrite!.receipt!.chartBindings![0] }]))[0].output).toMatchObject({ status: 'failed', differences: 1 });
});
it('uses actual chart relationships and selected coordinates beside unbound charts on multiple slides', async () => {
  const h = await host(); const ref = await compute(h); const bound = chartRequest(ref, ['total']).deck.slides[0].objects[0];
  const selection = { ...bound.data_from, rows: { first: 2, last: 2 } };
  const unbound = { type: 'chart', chartType: 'bar', x: 0, y: 0, w: 2, h: 2, series: [{ name: 'model', labels: ['other'], values: [7] }] };
  const result = await h.tools.run('write_presentation', { schema_version: 1, path: 'out/chart.pptx', deck: { slides: [
    { objects: [unbound, { ...bound, data_from: selection }] },
    { objects: [{ ...bound, chartType: 'pie', data_from: selection }] },
  ] } }); expect(result.status, result.output).toBe('success');
  expect(result.presentationWrite?.receipt?.chartBindings).toMatchObject([
    { slide: 1, object: 2, chart: 2, points: 1, precision_loss: 0, output: { status: 'passed', differences: 0 } },
    { slide: 2, object: 1, chart: 1, points: 1, precision_loss: 0, output: { status: 'passed', differences: 0 } },
  ]);
});
it('preserves empty chart labels and X-Axis names and accepts ordinary CR/CRLF text normalization', async () => {
  const h = await host(); const field = 'X-Axis\r\nRevenue';
  await fs.writeFile(join(h.root, 'source.csv'), 'label,amount\n,0\nafter,2\n"line1\r\nline2",3\n"single\rreturn",4');
  const read = await h.tools.run('read_workbook', { path: 'source.csv' });
  const transformed = await h.tools.run('transform_workbook', { operation: 'compute', sources: [{ name: 'input', snapshot_ref: JSON.parse(read.output).snapshot_ref, range: 'A2:B5' }],
    steps: [{ id: 'values', input: 'input', operation: 'select', columns: [{ column: 'A', as: 'team' }, { column: 'B', as: field, as_number: true }] }],
  }); expect(transformed.status, transformed.output).toBe('success');
  const result = await h.tools.run('write_presentation', chartRequest(JSON.parse(transformed.output).transformation_ref, [field])); expect(result.status, result.output).toBe('success');
  expect(result.presentationWrite?.receipt?.chartBindings).toMatchObject([{ points: 4, output: { status: 'passed', differences: 0, text_comparison: 'powerpoint-line-breaks' } }]);
  const bytes = await fs.readFile(join(h.root, 'out/chart.pptx')); const zip = await JSZip.loadAsync(bytes);
  const name = Object.keys(zip.files).find(name => name.startsWith('ppt/embeddings/') && name.endsWith('.xlsx'))!;
  const workbook = await JSZip.loadAsync(await zip.file(name)!.async('nodebuffer')); const sst = await workbook.file('xl/sharedStrings.xml')!.async('string');
  expect(sst).toContain('<t xml:space="preserve"></t>'); expect(sst).toContain('X-Axis&#13;\nRevenue'); expect(sst).toContain('>after<');
  expect(await workbook.file('xl/worksheets/sheet1.xml')!.async('string')).toContain('<c r="B2"><v>0</v></c>');
});
it('retains source-bound charts in drafts, refuses Read Off and gives field recovery', async () => {
  const h = await host(); const ref = await compute(h); const input = chartRequest(ref);
  expect((await h.tools.run('write_presentation', { ...input, draft: 'chart' })).status).toBe('success'); h.tools.beginTurn();
  const saved = await h.tools.run('write_presentation', { ...input, draft: 'chart', final: true, deck: { slides: [] } }); expect(saved.status, saved.output).toBe('success');
  expect(saved.presentationWrite?.receipt?.chartBindings?.[0].output?.status).toBe('partial');
  const off = new Tools(h.root, new Set(['write'])); off.shareWorkbookDataWith(h.tools); off.setPresentationRenderer(h.renderer); off.beginTurn();
  try { const refused = await off.run('write_presentation', input); expect(refused.status).toBe('refused'); expect(refused.output).toContain('Read'); } finally { off.retire(); }
  const bad = await h.tools.run('write_presentation', chartRequest(ref, ['unknown-field'])); expect(bad.status).toBe('failed'); expect(bad.output).toContain('Select fields');
});
it('retains overflow and underflow exact values and does not certify an empty chart as checked', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'source.csv'), 'label,amount\nbig,1e400\nsmall,1e-400\nzero,0');
  const read = await h.tools.run('read_workbook', { path: 'source.csv' });
  const steps = [{ id: 'values', input: 'input', operation: 'select', columns: [{ column: 'A', as: 'team' }, { column: 'B', as: 'amount', as_number: true }] }];
  const plan = { operation: 'compute', sources: [{ name: 'input', snapshot_ref: JSON.parse(read.output).snapshot_ref, range: 'A2:B4' }], steps };
  const result = await h.tools.run('transform_workbook', plan); expect(result.status, result.output).toBe('success');
  const saved = await h.tools.run('write_presentation', chartRequest(JSON.parse(result.output).transformation_ref, ['amount'])); expect(saved.status, saved.output).toBe('success');
  expect(saved.presentationWrite?.receipt?.chartBindings).toMatchObject([{ points: 3, precision_loss: 2, blank_points: 1, output: { status: 'partial', differences: 0 } }]);
  const empty = await h.tools.run('transform_workbook', { ...plan, steps: [...steps,
    { id: 'none', input: 'values', operation: 'filter', predicate: { column: 'team', operator: 'eq', value: { kind: 'string', value: 'none' } } },
  ] }); expect(empty.status, empty.output).toBe('success');
  const emptySaved = await h.tools.run('write_presentation', chartRequest(JSON.parse(empty.output).transformation_ref, ['amount'])); expect(emptySaved.status, emptySaved.output).toBe('success');
  expect(emptySaved.presentationWrite?.receipt?.chartBindings).toMatchObject([{ points: 0, output: { status: 'not-performed', differences: 0 } }]);
});
async function tables(bytes: Buffer) { const zip = await JSZip.loadAsync(bytes); return presentationTableTexts(await zip.file('ppt/slides/slide1.xml')!.async('string')); }

it('writes exact retained host values to real editable PPTX and corrects/report supplied model discrepancies', async () => {
  const h = await host(); const ref = await compute(h); await fs.writeFile(join(h.root, 'source.csv'), 'changed,999'); h.tools.beginTurn();
  const result = await h.tools.run('write_presentation', request(ref, [['team', 'total', 'average'], ['A', '999', 'bad'], ['B', '9007199254740994', '4503599627370497']]));
  expect(result.status, result.output).toBe('success'); const bytes = await fs.readFile(join(h.root, 'out/bound.pptx'));
  const expected = [['team', 'total', 'average'], ['A', '0.3', '0.15'], ['B', '9007199254740994', '4503599627370497']];
  expect(await tables(bytes)).toEqual([expected]);
  const receipt = result.presentationWrite!.receipt!; expect(receipt.sha256).toBe(sha(bytes));
  expect(receipt.dataBindings).toMatchObject([{ transformation_ref: ref, sources: [{ sha256: sha(COMPUTE_CSV) }], rows: 2, cells: 9, unresolved_cells: 0, partial: false,
    supplied: { present: true, differences: 2 }, output: { status: 'passed', compared_cells: 9, differences: 0, package_sha256: sha(bytes) } }]);
  expect(result.output).toContain('differences corrected: 2'); expect(h.state.approvals).toEqual([]);
  // Readback detects a real package mutation, even when a claimed source ref stays unchanged.
  const zip = await JSZip.loadAsync(bytes); const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  zip.file('ppt/slides/slide1.xml', xml.replace('>0.3<', '>900<')); const changed = await zip.generateAsync({ type: 'nodebuffer' });
  const checked = await checkPresentationData(changed, [{ rows: expected, fact: receipt.dataBindings![0] }]);
  expect(checked[0].output).toMatchObject({ status: 'failed', differences: 1, package_sha256: sha(changed) });
});
it('keeps source authorization live through real rendering and changes no target after revocation', async () => {
  const h = await host(); const outside = await temporaryFolder('unode-binding-source-'); const source = join(outside, 'source.csv');
  const scope = new SessionLocalReadScopeConsent(async () => false);
  const grant = await scope.requestPathAccess(source, { requestId: 'r1', isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'request' }));
  h.tools.setLivePathAccess(() => scope.pathAccessFor('r1')); const ref = await compute(h, source);
  const target = join(h.root, 'out/bound.pptx'); await fs.mkdir(join(h.root, 'out')); await fs.writeFile(target, 'USER FILE');
  const render = h.renderer.render.bind(h.renderer);
  vi.spyOn(h.renderer, 'render').mockImplementation(async (...args) => { const value = await render(...args); scope.revokePathAccess(grant!.id); return value; });
  const result = await h.tools.run('write_presentation', request(ref)); expect(result.status).not.toBe('success');
  expect(result.presentationWrite?.code).toBe('cancelled'); expect(await fs.readFile(target, 'utf8')).toBe('USER FILE'); expect(h.state.approvals).toEqual([]);
});
it('binds selected output coordinates to the correct table beside an unbound table', async () => {
  const h = await host(); const ref = await compute(h); const base = request(ref);
  const selected = { ...base.deck.slides[0].objects[0], data_from: { transformation_ref: ref, fields: ['total', 'team'], rows: { first: 2, last: 2 } } };
  const input = { ...base, deck: { slides: [{ objects: [{ type: 'table', x: 0, y: 0, w: 3, h: 1, rows: [['Unbound']] }, selected] }] } };
  const result = await h.tools.run('write_presentation', input); expect(result.status, result.output).toBe('success');
  expect(await tables(await fs.readFile(join(h.root, 'out/bound.pptx')))).toEqual([[['Unbound']], [['total', 'team'], ['9007199254740994', 'B']]]);
  expect(result.presentationWrite?.receipt?.dataBindings).toMatchObject([{ object: 2, table: 2, rows: 1, cells: 4, output: { status: 'passed' } }]);
});
it('retains source refs in disk drafts across requests and rejects forged refs/selectors without writing', async () => {
  const h = await host(); const ref = await compute(h); const first = await h.tools.run('write_presentation', { ...request(ref), draft: 'bound' }); expect(first.status, first.output).toBe('success');
  await expect(fs.stat(join(h.root, 'out/bound.pptx'))).rejects.toMatchObject({ code: 'ENOENT' }); h.tools.beginTurn();
  const final = await h.tools.run('write_presentation', { ...request(ref), draft: 'bound', final: true, deck: { title: 'Final', slides: [] } });
  expect(final.status, final.output).toBe('success'); expect((await tables(await fs.readFile(join(h.root, 'out/bound.pptx'))))[0][1]).toEqual(['A', '0.3', '0.15']);
  for (const invalid of [request('transformation-forged'), { ...request(ref), deck: { slides: [{ objects: [{ ...request(ref).deck.slides[0].objects[0], data_from: { transformation_ref: ref, fields: ['not-a-field'] } }] }] } }]) {
    const before = await fs.readFile(join(h.root, 'out/bound.pptx')); const result = await h.tools.run('write_presentation', invalid);
    expect(result.status).toBe('failed'); expect(await fs.readFile(join(h.root, 'out/bound.pptx'))).toEqual(before);
  }
  const other = new Tools(h.root, new Set(['read', 'write'])); other.setPresentationRenderer(h.renderer); other.beginTurn();
  try { const result = await other.run('write_presentation', request(ref)); expect(result.status).toBe('failed'); expect(result.output).toContain('transform_workbook'); }
  finally { other.retire(); }
});
it('keeps exact rational text, multilingual line breaks and unresolved source values in the actual package', async () => {
  const h = await host(); const source = 'label,amount\n"带 & 表\nemoji😀",1\n"带 & 表\nemoji😀",0\n"带 & 表\nemoji😀",0\nmissing';
  await fs.writeFile(join(h.root, 'source.csv'), source);
  const captured = await h.tools.run('read_workbook', { path: 'source.csv' }); const plan = workbookSumPlan(JSON.parse(captured.output).snapshot_ref);
  plan.sources[0].range = 'A2:B5'; const computed = await h.tools.run('transform_workbook', plan); expect(computed.status).toBe('success');
  const ref = JSON.parse(computed.output).transformation_ref; const saved = await h.tools.run('write_presentation', request(ref));
  expect(saved.status, saved.output).toBe('success'); const bytes = await fs.readFile(join(h.root, 'out/bound.pptx')); const actual = (await tables(bytes))[0];
  expect(actual[1]).toEqual(['带 & 表\nemoji😀', '1', '0.333333333333']); expect(actual[2][0]).toBe('missing'); expect(actual[2][1]).toContain('[Missing:');
  expect(saved.presentationWrite?.receipt?.dataBindings?.[0]).toMatchObject({ partial: false, unresolved_cells: 2, output: { status: 'passed' } });
  expect(saved.output).toContain('unresolved/structural cells: 2'); expect(saved.output).toContain('Visual review not performed.');
});
it('honors Read Off on a shared host data store and source revocation during the existing write approval', async () => {
  const h = await host(); const ref = await compute(h); const off = new Tools(h.root, new Set(['write']), 'dev');
  off.shareWorkbookDataWith(h.tools); off.setPresentationRenderer(h.renderer); off.beginTurn();
  try { expect((await off.run('write_presentation', request(ref))).status).toBe('refused'); }
  finally { off.retire(); }
  await expect(fs.stat(join(h.root, 'out/bound.pptx'))).rejects.toMatchObject({ code: 'ENOENT' });
  const scope = new SessionLocalReadScopeConsent(async () => false); let grantId = '';
  const late = await host({ ask: true, approve: async () => { scope.revokePathAccess(grantId); return 'once'; } });
  const outside = await temporaryFolder('unode-boundary-binding-'); const source = join(outside, 'source.csv');
  const grant = await scope.requestPathAccess(source, { requestId: 'r1', isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'request' })); grantId = grant!.id;
  late.tools.setLivePathAccess(() => scope.pathAccessFor('r1')); const lateRef = await compute(late, source);
  const result = await late.tools.run('write_presentation', request(lateRef)); expect(result.status).not.toBe('success'); expect(late.state.approvals).toHaveLength(1);
  await expect(fs.stat(join(late.root, 'out/bound.pptx'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('gives a usable recovery for immutable drafts containing a stale ref or invalid source field', async () => {
  const h = await host(); const ref = await compute(h);
  for (const label of ['reference', 'field']) {
    const input = request(label === 'reference' ? 'transformation-unavailable' : ref);
    if (label === 'field') input.deck.slides[0].objects[0].data_from.fields = ['missing-field'];
    const draft = `bad-${label}`; const part = await h.tools.run('write_presentation', { ...input, draft }); expect(part.status, part.output).toBe('success');
    const final = await h.tools.run('write_presentation', { ...input, draft, final: true, deck: { slides: [] } });
    expect(final.status).toBe('failed'); expect(final.output).toContain('new draft name'); expect(final.output).toContain('cannot be edited in place');
    await expect(fs.stat(join(h.root, 'out/bound.pptx'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect((await h.tools.run('write_presentation', { ...request(ref), draft: 'corrected' })).status).toBe('success');
  const corrected = await h.tools.run('write_presentation', { ...request(ref), draft: 'corrected', final: true, deck: { slides: [] } });
  expect(corrected.status, corrected.output).toBe('success'); expect((await tables(await fs.readFile(join(h.root, 'out/bound.pptx'))))[0][1]).toEqual(['A', '0.3', '0.15']);
});
it('explains actual source text that Office XML cannot represent without exposing the text or changing the target', async () => {
  const h = await host(); const source = 'label,amount\r\n"private\u0001source",1'; const file = join(h.root, 'unsafe.csv'); await fs.writeFile(file, source);
  const read = await h.tools.run('read_workbook', { path: file }); expect(read.status, read.output).toBe('success');
  const plan = workbookSumPlan(JSON.parse(read.output).snapshot_ref); plan.sources[0].range = 'A2:B2';
  const computed = await h.tools.run('transform_workbook', plan); expect(computed.status, computed.output).toBe('success');
  const target = join(h.root, 'out/bound.pptx'); await fs.mkdir(join(h.root, 'out')); await fs.writeFile(target, 'USER FILE');
  const result = await h.tools.run('write_presentation', request(JSON.parse(computed.output).transformation_ref));
  expect(result.status).toBe('failed'); expect(result.output).toContain('at data_from'); expect(result.output).toContain('Office XML cannot represent');
  expect(result.output).toContain('transform_workbook'); expect(result.output).not.toContain('private');
  expect(await fs.readFile(file, 'utf8')).toBe(source); expect(await fs.readFile(target, 'utf8')).toBe('USER FILE');
});
it.each(['\r\n', '\r'])('compares actual editable cell text with declared PowerPoint line-break normalization for %j', async newline => {
  const h = await host(); await fs.writeFile(join(h.root, 'lines.csv'), `label,amount\r\n"A${newline}B",0.3`);
  const captured = await h.tools.run('read_workbook', { path: 'lines.csv' }); expect(captured.status, captured.output).toBe('success');
  const plan = workbookSumPlan(JSON.parse(captured.output).snapshot_ref); plan.sources[0].range = 'A2:B2';
  const computed = await h.tools.run('transform_workbook', plan); expect(computed.status, computed.output).toBe('success');
  const saved = await h.tools.run('write_presentation', request(JSON.parse(computed.output).transformation_ref)); expect(saved.status, saved.output).toBe('success');
  expect((await tables(await fs.readFile(join(h.root, 'out/bound.pptx'))))[0][1]).toEqual(['A\nB', '0.3', '0.3']);
  expect(saved.presentationWrite?.receipt?.dataBindings?.[0].output).toMatchObject({ status: 'passed', differences: 0, text_comparison: 'powerpoint-line-breaks' });
  expect(saved.output).toContain('failed: 0'); expect(saved.output).toContain('line-break normalization');
});
