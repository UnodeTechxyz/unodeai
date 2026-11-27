import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { saveHost, sha } from './attachmentSaveFixtures';
import { workbookRouteReader } from './workbookRouteFixtures';
import { documentRouteRenderer } from './documentRouteFixtures';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import { COMPUTE_CSV, workbookSumPlan } from './workbookComputeFixtures';
import { documentTableTexts, checkDocumentData } from '../../content/document/DocumentDataCheck';
import { parseDocumentReceipt } from '../../content/document/DocumentWrite';
import type { WorkspaceTools } from '../WorkspaceTools';
import type { WorkbookReader } from '../../content/WorkbookReader';
import { resolveEffectiveRoots } from '../folderAccess';
import { SessionLocalReadScopeConsent } from '../localReadScope';
import { presentationRouteRenderer, boundPresentationInput } from './presentationRouteFixtures';
import { OfficeArtifactHistory, type OfficeArtifactRecord } from '../../office/OfficeArtifactHistory';
import { displayXlsxFixture } from '../../content/__tests__/xlsxFixtures';
import { officeXmlElements } from '../../office/OfficeXmlElements';
const owners: Array<{ tools: WorkspaceTools; reader: WorkbookReader }> = [];
afterEach(async () => { for (const owner of owners.splice(0)) { owner.tools.retire(); await owner.reader.dispose(); } await removeTemporaryFolders(); });
async function host(options: Parameters<typeof saveHost>[0] = {}) {
  const h = await saveHost(options); const tools = h.tools(); const reader = await workbookRouteReader(); const renderer = await documentRouteRenderer();
  tools.setWorkbookReader(reader); tools.setDocumentRenderer(renderer); tools.beginTurn(); owners.push({ tools, reader }); return { ...h, tools, reader, renderer };
}
async function compute(h: Awaited<ReturnType<typeof host>>, source = join(h.root, 'source.csv'), bytes = COMPUTE_CSV, range = 'A2:B5') {
  await fs.writeFile(source, bytes); const read = await h.tools.run('read_workbook', { path: source }); expect(read.status, read.output).toBe('success');
  const plan = workbookSumPlan(JSON.parse(read.output).snapshot_ref); plan.sources[0].range = range;
  const result = await h.tools.run('transform_workbook', plan); expect(result.status, result.output).toBe('success'); return JSON.parse(result.output).transformation_ref as string;
}
function request(ref: string, format: 'docx' | 'pdf' = 'docx') {
  return { schema_version: 1, path: `out/bound.${format}`, format, template: 'report-v1', document: { title: 'Source totals', language: 'en', blocks: [
    { type: 'signature', parties: [{ label: 'ONE' }, { label: 'TWO' }, { label: 'THREE' }] },
    { type: 'table', headers: ['Note', 'Team', 'Total', 'Average'], rows: [['unbound', [{ text: 'wrong', bold: true }], '999', '999']] },
  ] }, source_bindings: [{ block_index: 1, target: { row: 1, column: 2 }, data_from: { transformation_ref: ref, fields: ['team', 'total', 'average'] } }] };
}
async function table(bytes: Buffer) { const zip = await JSZip.loadAsync(bytes); return documentTableTexts(await zip.file('word/document.xml')!.async('string'))[2]; }
it('binds source date, percent, currency, blanks and padded text into real Word and native chart packages', async () => {
  const h = await host(); const input = await displayXlsxFixture(); await fs.writeFile(join(h.root, 'display.xlsx'), input);
  const read = await h.tools.run('read_workbook', { path: 'display.xlsx' }); const snapshot_ref = JSON.parse(read.output).snapshot_ref;
  const transformed = await h.tools.run('transform_workbook', { sources: [{ name: 'input', snapshot_ref, range: 'A1:G3' }], steps: [
    { id: 'values', input: 'input', operation: 'select', columns: ['date', 'percent', 'money', 'blank', 'amount', 'large', 'cjkDate'].map((as, index) => ({ column: String.fromCharCode(65 + index), as })) },
  ] });
  expect(transformed.status, transformed.output).toBe('success'); const ref = JSON.parse(transformed.output).transformation_ref;
  expect(transformed.output).toContain('9007199254740993'); expect(transformed.output).toContain('"numerator":"3","denominator":"20"');
  const average = await h.tools.run('transform_workbook', { sources: [{ name: 'input', snapshot_ref, range: 'E1:E3' }], steps: [
    { id: 'mean', input: 'input', operation: 'aggregate', fields: [{ operation: 'average', field: 'E', as: 'average' }] },
  ] });
  expect(average.status, average.output).toBe('success'); expect(average.output).toContain('"numerator":"5","denominator":"3"');
  const averageRef = JSON.parse(average.output).transformation_ref;
  const currency = await h.tools.run('transform_workbook', { sources: [{ name: 'input', snapshot_ref, range: 'C1:C3' }], steps: [
    { id: 'sum', input: 'input', operation: 'aggregate', fields: [{ operation: 'sum', field: 'C', as: 'total' }] },
  ] });
  expect(currency.status, currency.output).toBe('success'); expect(currency.output).toContain('$234.30');
  const fields = ['date', 'percent', 'money', 'blank', 'amount', 'large', 'cjkDate'];
  const word = await h.tools.run('write_document', { schema_version: 1, path: 'display.docx', format: 'docx', template: 'report-v1',
    document: { title: 'Display', language: 'en', blocks: [{ type: 'table', headers: fields, rows: [fields.map(() => '')] }, { type: 'table', headers: ['Average'], rows: [['']] }] },
    source_bindings: [{ block_index: 0, target: { row: 1, column: 1 }, data_from: { transformation_ref: ref, fields } },
      { block_index: 1, target: { row: 1, column: 1 }, data_from: { transformation_ref: averageRef, fields: ['average'] } }] });
  expect(word.status, word.output).toBe('success'); const doc = await JSZip.loadAsync(await fs.readFile(join(h.root, 'display.docx')));
  const rows = documentTableTexts(await doc.file('word/document.xml')!.async('string'))[0];
  expect(rows[1]).toEqual(['2023-11-01', '15%', '$1,234.50', '', '1', '$9,007,199,254,740,993.00', '2023-11-01']);
  expect(rows[2][3]).toBe('  padded  ');
  expect(documentTableTexts(await doc.file('word/document.xml')!.async('string'))[1][1]).toEqual(['1.666666666667']);
  h.tools.setPresentationRenderer(await presentationRouteRenderer());
  const saved = await h.tools.run('write_presentation', { schema_version: 1, path: 'display.pptx', deck: { slides: [{ objects: [
    { type: 'chart', chartType: 'bar', x: 1, y: 1, w: 8, h: 4, data_from: { transformation_ref: ref, label_field: 'cjkDate', value_fields: ['percent', 'money', 'percent'] } },
  ] }] } });
  expect(saved.status, saved.output).toBe('success'); const ppt = await JSZip.loadAsync(await fs.readFile(join(h.root, 'display.pptx')));
  const chart = await ppt.file('ppt/charts/chart1.xml')!.async('string'); expect(chart).toContain('2023-11-01');
  const labelFormats = officeXmlElements(Buffer.from(chart), () => {}).elements.filter(element => element.tag.local === 'numFmt' && element.parent?.tag.local === 'dLbl').map(element => element.tag.attributes.formatCode.value);
  expect(labelFormats).toEqual(['0%', '0%', '0%', '"$"#,##0.00', '"$"#,##0.00', '"$"#,##0.00', '0%', '0%', '0%']);
  const embedded = Object.values(ppt.files).find(file => /\.xlsx$/.test(file.name))!;
  const workbook = await JSZip.loadAsync(await embedded.async('nodebuffer')); const styles = await workbook.file('xl/styles.xml')!.async('string');
  expect(styles).toContain('formatCode="0%"'); expect(styles).toContain('formatCode="&quot;$&quot;#,##0.00"');
  const sheet = await workbook.file('xl/worksheets/sheet1.xml')!.async('string'); expect(sheet).toContain('<v>0.15</v>'); expect(sheet).toContain('<v>1234.5</v>');
  expect(sheet).toMatch(/<c r="B2"[^>]* s="\d+"/); expect(sheet).toMatch(/<c r="C2"[^>]* s="\d+"/);
  const styleNodes = officeXmlElements(Buffer.from(styles), () => {}).elements;
  const formats = new Map(styleNodes.filter(node => node.tag.local === 'numFmt').map(node => [node.tag.attributes.numFmtId.value, node.tag.attributes.formatCode.value]));
  const cellStyles = styleNodes.filter(node => node.tag.local === 'xf' && node.parent?.tag.local === 'cellXfs');
  const sheetNodes = officeXmlElements(Buffer.from(sheet), () => {}).elements;
  const cellFormat = (ref: string) => { const cell = sheetNodes.find(node => node.tag.local === 'c' && node.tag.attributes.r?.value === ref)!;
    return formats.get(cellStyles[Number(cell.tag.attributes.s.value)].tag.attributes.numFmtId.value); };
  expect(cellFormat('B2')).toBe('0%'); expect(cellFormat('C2')).toBe('"$"#,##0.00');
  expect(saved.presentationWrite?.receipt?.chartBindings?.[0].output).toMatchObject({ differences: 0 });
  expect(await fs.readFile(join(h.root, 'display.xlsx'))).toEqual(input);
});
it('retains actual written versions and source-computation links for Word and PowerPoint tables/charts', async () => {
  const records: OfficeArtifactRecord[] = [];
  const history = new OfficeArtifactHistory({ failed: vi.fn(), write: async (_key, record) => { records.push(record); } });
  const h = await host({ officeHistory: history }); const ref = await compute(h);
  await fs.mkdir(join(h.root, 'out')); const prior = Buffer.from('Previous owned document bytes');
  await fs.writeFile(join(h.root, 'out/bound.docx'), prior);
  const saved = await h.tools.run('write_document', request(ref)); expect(saved.status, saved.output).toBe('success');
  const doc = await fs.readFile(join(h.root, 'out/bound.docx'));
  h.tools.setPresentationRenderer(await presentationRouteRenderer());
  const pptResult = await h.tools.run('write_presentation', boundPresentationInput(ref)); expect(pptResult.status, pptResult.output).toBe('success');
  const ppt = await fs.readFile(join(h.root, 'out/bound.pptx'));
  await history.flush();
  const files = records.filter(record => record.kind === 'file'); expect(files).toHaveLength(2);
  const word = files.find(record => record.format === 'docx')!; const slides = files.find(record => record.format === 'pptx')!;
  expect(word).toBeDefined(); expect(slides).toBeDefined();
  expect(word).toMatchObject({ effect: 'replaced', requestId: 'r1', versions: expect.arrayContaining([{ sha256: sha(doc), bytes: doc.length, kind: 'office-output' }]) });
  expect(word.derivations).toContainEqual({ fromSha256: sha(prior), toSha256: sha(doc), kind: 'previous-version' });
  for (const [record, bytes] of [[word, doc], [slides, ppt]] as const) {
    expect(record.derivations).toContainEqual({ fromSha256: sha(COMPUTE_CSV), toSha256: sha(bytes), kind: 'source-data', transformationRef: ref });
    expect(record.data.every(binding => binding.transformationRef === ref && binding.sources[0].sha256 === sha(COMPUTE_CSV))).toBe(true);
    expect(record.data.every(binding => binding.output?.packageSha256 === sha(bytes))).toBe(true);
    expect(record.artifactId).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(word.data).toHaveLength(1);
  expect(word.data[0].selection).toMatchObject({ fields: ['team', 'total', 'average'] });
  expect(word.data[0].output).toMatchObject({ status: 'passed', differences: 0 });
  expect(slides.data).toHaveLength(2); // Table and chart keep their separate checked selections.
  expect(slides.data[1].selection).toMatchObject({ label_field: 'team', value_fields: ['total'] });
  expect(slides.data[1].output?.status).toBe('partial');
  const rejected = await h.tools.run('write_document', request('not-a-transformation')); expect(rejected.status).toBe('failed');
  await history.flush(); expect(records).toHaveLength(2);
  expect(JSON.stringify(records)).not.toContain(h.root); expect(JSON.stringify(records)).not.toContain('unbound');
});
it('fills only selected editable DOCX cells from exact retained data and reloads closed hash-bound check facts', async () => {
  const h = await host(); const ref = await compute(h); await fs.writeFile(join(h.root, 'source.csv'), 'changed,7'); h.tools.beginTurn();
  const saved = await h.tools.run('write_document', request(ref)); expect(saved.status, saved.output).toBe('success');
  const bytes = await fs.readFile(join(h.root, 'out/bound.docx')); const actual = await table(bytes);
  expect(actual).toEqual([['Note', 'Team', 'Total', 'Average'], ['unbound', 'A', '0.3', '0.15'], ['', 'B', '9007199254740994', '4503599627370497']]);
  if (saved.documentWrite?.code !== 'written') throw new Error(saved.output); const receipt = saved.documentWrite.receipt;
  expect(receipt.sha256).toBe(sha(bytes)); expect(receipt.dataBindings).toMatchObject([{ block_index: 1, table: 3, cells: 6, rows: 2,
    sources: [{ sha256: sha(COMPUTE_CSV) }], supplied: { cells: 3, differences: 3 }, output: { status: 'passed', compared_cells: 6, differences: 0, package_sha256: sha(bytes) } }]);
  expect(parseDocumentReceipt(JSON.parse(JSON.stringify(receipt)))?.dataBindings).toEqual(receipt.dataBindings);
  const forged = structuredClone(receipt); forged.dataBindings![0].output!.package_sha256 = 'f'.repeat(64); expect(parseDocumentReceipt(forged)).toBeUndefined();
  const zip = await JSZip.loadAsync(bytes); const xml = await zip.file('word/document.xml')!.async('string');
  zip.file('word/document.xml', xml.replace('>0.3<', '>777<')); const changed = await zip.generateAsync({ type: 'nodebuffer' });
  const checked = await checkDocumentData(changed, [{ fact: receipt.dataBindings![0], rows: actual.slice(1).map(row => row.slice(1)) }], 'docx');
  expect(checked[0].output).toMatchObject({ status: 'failed', differences: 1, package_sha256: sha(changed) });
  expect(saved.output).toContain('headers and other text remain model-authored'); expect(h.state.approvals).toEqual([]);
});
it('retains part-local binding coordinates on disk across requests and shifts final-part bindings correctly', async () => {
  const h = await host(); const ref = await compute(h); const base = request(ref);
  const prefix = { ...base, draft: 'report', source_bindings: [], document: { ...base.document, blocks: [{ type: 'paragraph', content: [{ text: 'Prefix' }] }] } };
  expect((await h.tools.run('write_document', prefix)).status).toBe('success');
  expect((await h.tools.run('write_document', { ...base, draft: 'report' })).status).toBe('success'); h.tools.beginTurn();
  const final = await h.tools.run('write_document', { ...base, draft: 'report', final: true }); expect(final.status, final.output).toBe('success');
  if (final.documentWrite?.code !== 'written') throw new Error(final.output);
  expect(final.documentWrite.receipt.dataBindings?.map(fact => [fact.block_index, fact.table, fact.output?.status])).toEqual([[2, 3, 'passed'], [4, 6, 'passed']]);
  const repeat = await h.tools.run('write_document', { ...base, draft: 'report', final: true, source_bindings: [], document: { ...base.document, blocks: [] } });
  expect(repeat.status, repeat.output).toBe('success');
});
it('writes actual source values to PDF while explicitly leaving PDF output-cell checks not performed', async () => {
  const h = await host(); const ref = await compute(h); const saved = await h.tools.run('write_document', request(ref, 'pdf')); expect(saved.status, saved.output).toBe('success');
  if (saved.documentWrite?.code !== 'written') throw new Error(saved.output);
  expect(saved.documentWrite.receipt.dataBindings?.[0].output).toMatchObject({ status: 'not-performed', compared_cells: 0, differences: 0 });
  const forged = structuredClone(saved.documentWrite.receipt); const output = forged.dataBindings![0].output!;
  output.status = 'passed'; output.compared_cells = forged.dataBindings![0].cells; expect(parseDocumentReceipt(forged)).toBeUndefined();
  const bytes = await fs.readFile(join(h.root, 'out/bound.pdf')); const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const reader = await getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false }).promise;
  try { const text: string[] = []; for (let page = 1; page <= reader.numPages; page++) { const content = await (await reader.getPage(page)).getTextContent(); text.push(...content.items.flatMap(item => 'str' in item ? [item.str] : [])); }
    expect(text.join(' ')).toContain('0.3'); expect(text.join(' ')).toContain('0.15'); expect(text.join(' ')).not.toContain('999'); }
  finally { await reader.destroy(); }
  expect(saved.output).toContain('not performed: 1');
});
it('preserves source line breaks and counts canonical normalization without upgrading unbound content', async () => {
  const h = await host(); const ref = await compute(h, join(h.root, 'lines.csv'), 'label,amount\r\n"가\r\nB",1', 'A2:B2');
  const saved = await h.tools.run('write_document', request(ref)); expect(saved.status, saved.output).toBe('success');
  expect((await table(await fs.readFile(join(h.root, 'out/bound.docx'))))[1]).toEqual(['unbound', '가\nB', '1', '1']);
  if (saved.documentWrite?.code !== 'written') throw new Error(saved.output);
  expect(saved.documentWrite.receipt.dataBindings?.[0]).toMatchObject({ normalized_cells: 1, output: { status: 'passed', text_comparison: 'document-canonical-text' } });
});
it('keeps an existing target unchanged after a real source grant is revoked during rendering', async () => {
  const h = await host(); const outside = await temporaryFolder('unode-word-binding-source-'); const source = join(outside, 'source.csv');
  const scope = new SessionLocalReadScopeConsent(async () => false); const grant = await scope.requestPathAccess(source, { requestId: 'r1', isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'request' }));
  h.tools.setLivePathAccess(() => scope.pathAccessFor('r1')); const ref = await compute(h, source);
  const target = join(h.root, 'out/bound.docx'); await fs.mkdir(join(h.root, 'out')); await fs.writeFile(target, 'USER FILE');
  const render = h.renderer.render.bind(h.renderer); vi.spyOn(h.renderer, 'render').mockImplementation(async (...args) => { const value = await render(...args); scope.revokePathAccess(grant!.id); return value; });
  const saved = await h.tools.run('write_document', request(ref)); expect(saved.status).not.toBe('success'); expect(saved.documentWrite?.code).toBe('cancelled');
  expect(await fs.readFile(target, 'utf8')).toBe('USER FILE');
});
it.each([false, true])('keeps source-grant draft retries Read-only for document/presentation bindings with pending task scope %s', async pending => {
  const h = await host(); h.tools.setPresentationRenderer(await presentationRouteRenderer()); h.tools.beginTurn();
  const namedOutside = await temporaryFolder('unode-binding-once-source-');
  // Production delegation resolves existing roots before passing TaskWorkspaceAccess to the tool host.
  const resolved = resolveEffectiveRoots({ grants: [{ path: namedOutside, permission: 'read' }],
    fallbackPrimaryRoot: h.root, fallbackReadRoots: [h.root], workspaceRoots: [h.root], isTrusted: true });
  expect(resolved.issues).toEqual([]); expect(resolved.readRoots).toEqual([await fs.realpath(namedOutside)]);
  const outside = resolved.readRoots[0]; const source = join(namedOutside, 'source.csv'); let activeRequest = 'r1';
  const requested: string[] = []; h.tools.setOutsideRootObserver((_path, permission) => { requested.push(permission ?? ''); });
  const scope = new SessionLocalReadScopeConsent(async () => false);
  if (pending) h.tools.setTurnWorkspaceAccess({ pathBase: h.root, readRoots: [h.root], writeRoots: [h.root], pending: {
    readRoots: [outside], writeRoots: [], readFiles: [], writeFiles: [],
  } });
  await scope.requestPathAccess(source, { requestId: activeRequest, isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'request' }));
  h.tools.setLivePathAccess(() => scope.pathAccessFor(activeRequest)); const ref = await compute(h, source);
  const doc = request(ref); const ppt = boundPresentationInput(ref);
  const variants = [{ tool: 'write_document', initial: { ...doc, draft: 'source-word' }, empty: { source_bindings: [], document: { ...doc.document, blocks: [] } }, file: 'out/bound.docx' },
    { tool: 'write_presentation', initial: { ...ppt, draft: 'source-ppt' }, empty: { deck: { slides: [] } }, file: 'out/bound.pptx' }];
  for (const item of variants) {
    expect((await h.tools.run(item.tool, item.initial)).status).toBe('success');
    activeRequest = `${item.tool}-next`; h.state.request = activeRequest; h.state.running.add(activeRequest); h.tools.beginTurn();
    const args = { ...item.initial, ...item.empty, final: true }; const refused = await h.tools.run(item.tool, args);
    expect(refused.status, refused.output).toBe('refused'); expect(refused.detail).toContain('Read access to the selected source');
    expect(refused.detail).toContain('whole draft is kept'); expect(refused.detail).not.toContain('Read + Write');
    await expect(fs.stat(join(h.root, item.file))).rejects.toMatchObject({ code: 'ENOENT' });
    await scope.requestPathAccess(source, { requestId: activeRequest, isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'request' }));
    const saved = await h.tools.run(item.tool, args); expect(saved.status, saved.output).toBe('success'); expect((await fs.stat(join(h.root, item.file))).size).toBeGreaterThan(0);
  }
  expect(requested).toEqual(['read', 'read']);
});
it('warns from actual bound Unicode and rejects invalid binding drafts with usable correction guidance', async () => {
  const h = await host(); const ref = await compute(h, join(h.root, 'arabic.csv'), 'label,amount\nمرحبا,1', 'A2:B2');
  const saved = await h.tools.run('write_document', request(ref)); expect(saved.status, saved.output).toBe('success');
  if (saved.documentWrite?.code !== 'written') throw new Error(saved.output);
  expect(saved.documentWrite.receipt.layoutWarnings).toMatchObject([{ code: 'reader-layout-unverified', scripts: ['Arab'] }]);
  expect(saved.output).toContain('reader layout'); expect((await table(await fs.readFile(join(h.root, 'out/bound.docx'))))[1][1]).toBe('مرحبا');
  const pdf = await h.tools.run('write_document', request(ref, 'pdf')); expect(pdf.status).toBe('failed'); expect(pdf.documentWrite?.code).toBe('unsupported-text-layout');
  expect(pdf.output).toContain('format docx');
  const invalid = request(ref); invalid.path = 'out/invalid.docx'; invalid.source_bindings[0].data_from.fields = ['not-a-field'];
  expect((await h.tools.run('write_document', { ...invalid, draft: 'bad-fields' })).status).toBe('success');
  const final = await h.tools.run('write_document', { ...invalid, draft: 'bad-fields', final: true, source_bindings: [], document: { ...invalid.document, blocks: [] } });
  expect(final.status).toBe('failed'); expect(final.output).toContain('new draft name'); await expect(fs.stat(join(h.root, invalid.path))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('applies explicit source and target row/column selectors while leaving other numeric cells model-authored', async () => {
  const h = await host(); const ref = await compute(h); const selected = request(ref);
  selected.source_bindings[0] = { block_index: 1, target: { row: 3, column: 3 }, data_from: { transformation_ref: ref, fields: ['total', 'average'], rows: { first: 2, last: 2 } } } as typeof selected.source_bindings[number];
  const saved = await h.tools.run('write_document', selected); expect(saved.status, saved.output).toBe('success');
  const actual = await table(await fs.readFile(join(h.root, 'out/bound.docx'))); expect(actual[1].slice(2)).toEqual(['999', '999']);
  expect(actual[3]).toEqual(['', '', '9007199254740994', '4503599627370497']);
  if (saved.documentWrite?.code !== 'written') throw new Error(saved.output); expect(saved.documentWrite.receipt.dataBindings?.[0]).toMatchObject({ cells: 2, rows: 1, target: { row: 3, column: 3 }, output: { status: 'passed', compared_cells: 2 } });
  const overlapping = { ...request(ref), source_bindings: [...request(ref).source_bindings, ...request(ref).source_bindings] };
  const before = await fs.readFile(join(h.root, 'out/bound.docx')); const refused = await h.tools.run('write_document', overlapping);
  expect(refused.status).toBe('failed'); expect(refused.output).toContain('non-overlapping'); expect(await fs.readFile(join(h.root, 'out/bound.docx'))).toEqual(before);
});
it('reports unrepresentable actual source text with a finite error and preserves the source and target', async () => {
  const h = await host(); const source = 'label,amount\n"private\u0001source",1'; const ref = await compute(h, join(h.root, 'unsafe.csv'), source, 'A2:B2');
  const target = join(h.root, 'out/bound.docx'); await fs.mkdir(join(h.root, 'out')); await fs.writeFile(target, 'USER FILE');
  const saved = await h.tools.run('write_document', request(ref)); expect(saved.status).toBe('failed'); expect(saved.output).toContain('at source_bindings');
  expect(saved.output).toContain('document text format'); expect(saved.output).not.toContain('private');
  expect(await fs.readFile(target, 'utf8')).toBe('USER FILE'); expect(await fs.readFile(join(h.root, 'unsafe.csv'), 'utf8')).toBe(source);
});
