import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { build } from 'esbuild';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { WorkspaceTools } from '../WorkspaceTools';
import { OfficeReader } from '../../office/OfficeReader';
import { workbookOutputSize, type PageBudget } from '../../content/WorkbookPage';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { SessionLocalReadScopeConsent } from '../localReadScope';
import { assertOfficeInventoryWorkerBundleGraph } from '../../../scripts/office-inventory-worker-bundle.mjs';

const owned: Array<{ tools: WorkspaceTools; reader: OfficeReader }> = [];
const budget: PageBudget = { unit: 'bytes', limit: 2500, reserved: 80, carrier: 'mcp' };
let worker: string;
beforeAll(async () => {
  // This is an affected worker-only test bundle, not a product/candidate build.
  const root = await temporaryFolder('unode-office-test-worker-'); worker = join(root, 'OfficeInventoryWorker.cjs');
  const result = await build({ entryPoints: ['src/office/OfficeInventoryWorker.ts'], outfile: worker, bundle: true,
    platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent', metafile: true });
  assertOfficeInventoryWorkerBundleGraph(result.metafile);
});
afterEach(async () => { for (const h of owned.splice(0)) { h.tools.retire(); await h.reader.dispose(); } });
// The bundle must remain available for all tests. Fixture cleanup owns only its mkdtemp paths.
afterAll(removeTemporaryFolders);

async function host(allowed = new Set(['read'])) {
  const root = await temporaryFolder('unode-office-tool-'); const reader = new OfficeReader(worker);
  const tools = new WorkspaceTools(root, allowed, 'agent'); tools.setOfficeReader(reader); tools.beginTurn(); owned.push({ tools, reader });
  return { root, tools, reader };
}
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function xmlZip(kind: 'docx' | 'pptx', body: string) {
  const zip = new JSZip(); const main = 'custom/main.xml';
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${kind === 'pptx' ? 'presentationml.presentation' : 'wordprocessingml.document'}.main+xml"/></Types>`);
  zip.file('_rels/.rels', `<Relationships xmlns="${PKG}"><Relationship Id="main" Type="${REL}/officeDocument" Target="${main}"/></Relationships>`);
  zip.file(main, body); return zip;
}
async function collect(h: Awaited<ReturnType<typeof host>>, path: string, bound = budget) {
  const records: Array<{ kind: string; id: string; record: any }> = []; const split = new Map<string, { kind: string; text: string }>();
  let cursor: string | undefined; let first: any; let count = 0;
  do {
    const result = await h.tools.run('inspect_office', { path, ...(cursor ? { cursor } : {}) }, { workbookBudget: bound });
    expect(result.status, result.output).toBe('success'); expect(workbookOutputSize(result.output, bound) + bound.reserved).toBeLessThanOrEqual(bound.limit);
    const page = JSON.parse(result.output); first ??= page;
    for (const item of page.prepared_fragments) {
      if (item.kind.endsWith('-fragment')) {
        const prior = split.get(item.id) ?? { kind: item.kind.slice(0, -9), text: '' };
        expect(Buffer.byteLength(prior.text)).toBe(item.start_byte); prior.text += item.text;
        expect(prior.text).not.toContain('\ufffd'); split.set(item.id, prior);
        if (item.end_byte === item.total_bytes) { records.push({ kind: prior.kind, id: item.id, record: JSON.parse(prior.text) }); split.delete(item.id); }
      } else records.push(item);
    }
    cursor = page.next_cursor ?? undefined; expect(++count).toBeLessThan(150);
  } while (cursor);
  expect(split.size).toBe(0); return { first, records, pages: count };
}

it('registered tool inventories real SDK editable shapes, charts and package links without changing the source', async () => {
  const h = await host(); const deck = new PptxGenJS(); const slide = deck.addSlide();
  slide.addText('Quarterly 名称', { x: 1, y: 1, w: 4, h: 1 });
  slide.addTable([['Quarter', 'Revenue'], ['Q1', '12']], { x: 1, y: 2, w: 4, h: 1 });
  slide.addChart(deck.ChartType.bar, [{ name: 'Revenue', labels: ['Q1'], values: [12] }], { x: 5, y: 1, w: 4, h: 3 });
  const bytes = await deck.write({ outputType: 'nodebuffer', compression: true }) as Buffer;
  const file = join(h.root, 'deck.pptx'); await fs.writeFile(file, bytes);
  const result = await collect(h, 'deck.pptx'); expect(result.first.source_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(result.first.summary).toMatchObject({ slides: 1, tables: 1, gaps: 0 });
  const objects = result.records.filter(item => item.kind === 'object').map(item => item.record);
  expect(objects.some(object => object.text === 'Quarterly 名称')).toBe(true);
  expect(objects.some(object => object.chart_relationships.length === 1)).toBe(true);
  expect(result.records.some(item => item.kind === 'relationship' && item.record.relationship_kind === 'slideMaster')).toBe(true);
  expect(result.records.some(item => item.kind === 'relationship' && item.record.relationship_kind === 'package')).toBe(true);
  const cells = result.records.filter(item => item.kind === 'table-cell').map(item => item.record);
  expect(cells.map(cell => cell.text)).toEqual(['Quarter', 'Revenue', 'Q1', '12']);
  expect(cells[3]).toMatchObject({ row_index: 2, cell_index: 2, coordinate_system: 'stored-row-cell-ordinals', selector: { snapshot_ref: result.first.snapshot_ref } });
  expect(result.first.coverage).toMatchObject({ chart_data: 'not-inspected', native_visual_check: 'not-performed' });
  expect(await fs.readFile(file)).toEqual(bytes);
});

it('follows actual slide order and namespace relationships at nonstandard paths, preserving run breaks and placeholder selectors', async () => {
  const h = await host(); const zip = xmlZip('pptx', `<p:presentation xmlns:p="${P}" xmlns:r="${REL}"><p:sldIdLst><p:sldId id="300" r:id="second"/><p:sldId id="256" r:id="first"/></p:sldIdLst><p:extLst><p:ext uri="unknown"><p:sldId id="999" r:id="first"/></p:ext></p:extLst></p:presentation>`);
  zip.file('custom/_rels/main.xml.rels', `<Relationships xmlns="${PKG}"><Relationship Id="first" Type="${REL}/slide" Target="../slides/a.xml"/><Relationship Id="second" Type="${REL}/slide" Target="../slides/b.xml"/><Relationship Id="external" Type="${REL}/hyperlink" Target="https://user:SECRET@invalid.example/private" TargetMode="External"/></Relationships>`);
  const slide = (text: string) => `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="9" name="Title"/><p:nvPr><p:ph type="title" idx="0"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr b="1"/><a:t>${text}</a:t></a:r><a:br/><a:r><a:t>tail</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  zip.file('slides/a.xml', slide('first')); zip.file('slides/b.xml', slide('second'));
  await fs.writeFile(join(h.root, 'ordered.pptx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await collect(h, 'ordered.pptx'); expect(result.first.summary.slides).toBe(2);
  const objects = result.records.filter(item => item.kind === 'object').map(item => item.record);
  expect(objects.map(object => object.text)).toEqual(['second\ntail', 'first\ntail']);
  expect(objects[0]).toMatchObject({ selector: { snapshot_ref: result.first.snapshot_ref, object_ref: 'S1-O1', slide_id: '300' }, shape_id: '9', placeholder: { type: 'title', idx: '0' } });
  expect(JSON.stringify(result)).not.toContain('SECRET'); expect(JSON.stringify(result)).not.toContain('invalid.example');
  expect(result.records.find(item => item.id.endsWith(':external'))?.record).toMatchObject({ external: true, relationship_kind: 'hyperlink' });
});

it('reconstructs long DOCX Unicode runs in exact text order including in-run tabs and breaks', async () => {
  const h = await host(); const text = '名😀&quot;'.repeat(1200); const decoded = '名😀"'.repeat(1200);
  const zip = xmlZip('docx', `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:rPr><w:b/><w:lang w:val="zh-CN"/></w:rPr><w:t>before</w:t><w:tab/><w:t>${text}</w:t><w:br/><w:t>after</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`);
  await fs.writeFile(join(h.root, 'long.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await collect(h, 'long.docx', { ...budget, carrier: 'codex', limit: 1900 });
  expect(result.pages).toBeGreaterThan(2); expect(result.first.summary).toMatchObject({ paragraphs: 2, tables: 1 });
  const paragraph = result.records.find(item => item.id === 'D1')!.record;
  expect(paragraph.text).toBe('before\t' + decoded + '\nafter'); expect(paragraph.runs[0].style).toEqual({ b: 'true', lang: 'zh-CN' });
  expect(result.records.find(item => item.id === 'T1')!.record.cell_mapping).toBe('stored-rows-and-cells');
  expect(result.records.find(item => item.id === 'D2')!.record.cell_ref).toBe('T1-R1-C1');
});

it('indexes Word stored cells, omitted grid positions, merge continuations and nested tables without flattening them', async () => {
  const h = await host(); const p = (value: string) => `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`;
  const zip = xmlZip('docx', `<w:document xmlns:w="${W}"><w:body><w:tbl><w:tblGrid><w:gridCol w:w="1000"/><w:gridCol w:w="2000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:trPr><w:gridBefore w:val="1"/><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/></w:tcPr>${p('outer before')}<w:tbl><w:tr><w:tc>${p('nested')}</w:tc></w:tr></w:tbl>${p('outer after')}</w:tc></w:tr><w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr>${p('continuation')}</w:tc><w:tc><w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>last</w:t><w:tab/><w:t>tail</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:del><w:r><w:delText>deleted</w:delText></w:r></w:del><w:ins><w:r><w:t>inserted</w:t></w:r></w:ins></w:p></w:body></w:document>`);
  await fs.writeFile(join(h.root, 'cells.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await collect(h, 'cells.docx'); expect(result.first.summary.tables).toBe(2);
  const lookup = (id: string) => { const item = result.records.find(item => item.id === id); expect(item, id).toBeDefined(); return item!.record; };
  expect(lookup('T1')).toMatchObject({ rows: 2, stored_cells: 3, grid_columns: 3, native_grid_layout: 'not-resolved' });
  expect(lookup('T1-R1')).toMatchObject({ stored_cells: 1, saved_properties: { gridBefore: '1', tblHeader: 'true' } });
  expect(lookup('T1-R1-C1')).toMatchObject({ text: 'outer before\nouter after', saved_merge_properties: { gridSpan: '2', vMerge: 'restart' },
    nested_table_refs: ['T2'], paragraph_refs: ['D1', 'D3'], selector: { snapshot_ref: result.first.snapshot_ref, cell_ref: 'T1-R1-C1' } });
  expect(lookup('T2')).toMatchObject({ parent_cell: 'T1-R1-C1', stored_cells: 1 }); expect(lookup('T2-R1-C1').text).toBe('nested');
  expect(lookup('T1-R2-C1').saved_merge_properties).toEqual({ vMerge: 'continue' }); expect(lookup('T1-R2-C2').text).toBe('last\ttail');
  expect(lookup('D6').text).toBe('inserted'); expect(result.first.coverage.tracked_changes).toBe('revisions-read');
});

it('keeps PPT merge metadata and group coordinate transforms separate from table cell ordinals', async () => {
  const h = await host(); const zip = xmlZip('pptx', `<p:presentation xmlns:p="${P}" xmlns:r="${REL}"><p:sldIdLst><p:sldId id="256" r:id="slide"/></p:sldIdLst></p:presentation>`);
  zip.file('custom/_rels/main.xml.rels', `<Relationships xmlns="${PKG}"><Relationship Id="slide" Type="${REL}/slide" Target="slide.xml"/></Relationships>`);
  zip.file('custom/slide.xml', `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:grpSp><p:grpSpPr><a:xfrm><a:off x="10" y="20"/><a:ext cx="30" cy="40"/><a:chOff x="1" y="2"/><a:chExt cx="3" cy="4"/></a:xfrm><a:extLst><a:ext uri="not-an-EMU"/></a:extLst></p:grpSpPr><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tblGrid><a:gridCol w="300"/><a:gridCol w="400"/></a:tblGrid><a:tr h="200"><a:tc gridSpan="2" rowSpan="2"><a:txBody><a:p><a:r><a:t>first</a:t></a:r><a:br/><a:r><a:t>tail</a:t></a:r></a:p></a:txBody></a:tc><a:tc hMerge="1"><a:txBody><a:p/></a:txBody></a:tc></a:tr><a:tr h="250"><a:tc vMerge="1"><a:txBody><a:p/></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:grpSp></p:spTree></p:cSld></p:sld>`);
  await fs.writeFile(join(h.root, 'table.pptx'), await zip.generateAsync({ type: 'nodebuffer' })); const result = await collect(h, 'table.pptx');
  const lookup = (id: string) => { const item = result.records.find(item => item.id === id); expect(item, id).toBeDefined(); return item!.record; };
  expect(lookup('S1-O1').geometry_emu).toEqual({ off_x: '10', off_y: '20', ext_cx: '30', ext_cy: '40', chOff_x: '1', chOff_y: '2', chExt_cx: '3', chExt_cy: '4' });
  expect(lookup('S1-O2-T1')).toMatchObject({ object_ref: 'S1-O2', rows: 2, stored_cells: 3 });
  expect(lookup('S1-O2-T1-R1-C1')).toMatchObject({ text: 'first\ntail', saved_merge_properties: { gridSpan: '2', rowSpan: '2' }, row_index: 1, cell_index: 1 });
  expect(lookup('S1-O2-T1-R1-C2').saved_merge_properties).toEqual({ hMerge: '1' }); expect(lookup('S1-O2-T1-R2-C1').saved_merge_properties).toEqual({ vMerge: '1' });
});

it('indexes Word wrapped rows and cells in repeating-section content controls using the actual stored ordinals', async () => {
  const h = await host(); const cell = (value: string) => `<w:tc><w:p><w:r><w:t>${value}</w:t></w:r></w:p></w:tc>`;
  const control = (content: string) => `<w:sdt><w:sdtPr><w:alias w:val="Form field"/></w:sdtPr><w:sdtContent>${content}</w:sdtContent></w:sdt>`;
  const row2 = control(`<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr>${cell('first')}${control(cell('controlled cell'))}</w:tr>`);
  const row3 = control(`<w:customXml w:element="row"><w:tr><w:customXml w:element="cell">${cell('custom cell')}</w:customXml>${cell('last')}</w:tr></w:customXml>`);
  const zip = xmlZip('docx', `<w:document xmlns:w="${W}"><w:body><w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr>${cell('Header A')}${cell('Header B')}</w:tr>${control(row2 + row3)}</w:tbl></w:body></w:document>`);
  await fs.writeFile(join(h.root, 'form.docx'), await zip.generateAsync({ type: 'nodebuffer' })); const result = await collect(h, 'form.docx');
  const rows = result.records.filter(item => item.kind === 'table-row');
  expect(rows.map(item => item.id)).toEqual(['T1-R1', 'T1-R2', 'T1-R3']); expect(rows.map(item => item.record.stored_cells)).toEqual([2, 2, 2]);
  expect(rows[0].record.saved_properties).toEqual({ tblHeader: 'true' }); expect(rows[1].record.saved_properties).toEqual({ gridBefore: '1' }); expect(rows[2].record.saved_properties).toEqual({});
  const cells = result.records.filter(item => item.kind === 'table-cell');
  expect(cells.map(item => item.id)).toEqual(['T1-R1-C1', 'T1-R1-C2', 'T1-R2-C1', 'T1-R2-C2', 'T1-R3-C1', 'T1-R3-C2']);
  expect(cells.map(item => item.record.text)).toEqual(['Header A', 'Header B', 'first', 'controlled cell', 'custom cell', 'last']);
  expect(result.records.find(item => item.id === 'D4')?.record.cell_ref).toBe('T1-R2-C2');
  expect(result.records.find(item => item.id === 'D5')?.record.cell_ref).toBe('T1-R3-C1');
  expect(result.records.find(item => item.id === 'T1')?.record).toMatchObject({ rows: 3, stored_cells: 6 }); expect(result.first.summary.gaps).toBe(0);
});

it('keeps alternate branches out of asserted text and reports the specific inventory gap', async () => {
  const h = await host(); const zip = xmlZip('docx', `<w:document xmlns:w="${W}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body><w:p><w:r><w:t>before</w:t></w:r><mc:AlternateContent><mc:Choice Requires="w"><w:r><w:t>choice</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>fallback</w:t></w:r></mc:Fallback></mc:AlternateContent><w:r><w:t>after</w:t></w:r></w:p></w:body></w:document>`);
  await fs.writeFile(join(h.root, 'alternate.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await collect(h, 'alternate.docx'); expect(result.first.summary.gaps).toBe(1);
  expect(result.records.find(item => item.id === 'D1')!.record.text).toBe('beforeafter');
  expect(result.records.find(item => item.kind === 'gap')!.record.code).toBe('alternate-content-not-selected');
});

it('rejects continuation against changed source bytes, another request or another reader', async () => {
  const h = await host(); const zip = xmlZip('docx', `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>${'a'.repeat(9000)}</w:t></w:r></w:p></w:body></w:document>`);
  const bytes = await zip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(join(h.root, 'source.docx'), bytes);
  const first = await h.tools.run('inspect_office', { path: 'source.docx' }, { workbookBudget: budget }); expect(first.status).toBe('success');
  const cursor = JSON.parse(first.output).next_cursor; expect(cursor).toMatch(/^office-cursor-/);
  await fs.writeFile(join(h.root, 'source.docx'), Buffer.from('changed'));
  expect((await h.tools.run('inspect_office', { path: 'source.docx', cursor }, { workbookBudget: budget })).output).toContain('Source bytes changed');
  await fs.writeFile(join(h.root, 'source.docx'), bytes); h.tools.beginTurn();
  expect((await h.tools.run('inspect_office', { path: 'source.docx', cursor }, { workbookBudget: budget })).output).toContain('does not belong');
  const other = await host(); await fs.writeFile(join(other.root, 'source.docx'), bytes);
  expect((await other.tools.run('inspect_office', { path: 'source.docx', cursor }, { workbookBudget: budget })).status).toBe('failed');
});

it('preserves explicit Read Off and outside-folder restrictions while allowing a granted read', async () => {
  const off = await host(new Set()); expect(off.tools.specs().some(spec => spec.function.name === 'inspect_office')).toBe(false);
  expect(await off.tools.run('inspect_office', { path: 'source.docx' })).toMatchObject({ status: 'refused', reason: 'capability' });
  const h = await host(); const outside = await temporaryFolder('unode-office-outside-'); const file = join(outside, 'outside.docx');
  const zip = xmlZip('docx', `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>granted</w:t></w:r></w:p></w:body></w:document>`);
  await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  expect((await h.tools.run('inspect_office', { path: file })).status).toBe('refused');
  const access = new SessionLocalReadScopeConsent(async () => false);
  const grant = await access.requestPathAccess(file, { requestId: 'office-request', isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'request' }));
  h.tools.setLivePathAccess(() => access.pathAccessFor('office-request'));
  expect((await h.tools.run('inspect_office', { path: file }, { workbookBudget: budget })).status).toBe('success');
  const read = h.reader.read.bind(h.reader); vi.spyOn(h.reader, 'read').mockImplementation(async (...args) => { const value = await read(...args); access.revokePathAccess(grant!.id); return value; });
  const revoked = await h.tools.run('inspect_office', { path: file }); expect(revoked.status).not.toBe('success'); expect(revoked.output).not.toContain('granted');
});

it('reports a missing slide part and refuses XML entity expansion without executing or changing source bytes', async () => {
  const h = await host(); const zip = xmlZip('pptx', `<p:presentation xmlns:p="${P}" xmlns:r="${REL}"><p:sldIdLst><p:sldId id="256" r:id="absent"/></p:sldIdLst></p:presentation>`);
  await fs.writeFile(join(h.root, 'missing.pptx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await collect(h, 'missing.pptx'); expect(result.first.summary).toMatchObject({ slides: 1, objects: 0, gaps: 1 });
  expect(result.records.find(item => item.kind === 'gap')?.record.code).toBe('slide-part-unavailable');
  const bad = xmlZip('docx', `<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///DO-NOT-READ">]><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>&secret;</w:t></w:r></w:p></w:body></w:document>`);
  const bytes = await bad.generateAsync({ type: 'nodebuffer' }); const target = join(h.root, 'dtd.docx'); await fs.writeFile(target, bytes);
  expect((await h.tools.run('inspect_office', { path: 'dtd.docx' })).status).toBe('failed'); expect(await fs.readFile(target)).toEqual(bytes);
});

it('withholds a prepared inventory after its actual host request changes and removes owned snapshots on Stop', async () => {
  const h = await host(); const zip = xmlZip('docx', `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>PRIVATE CANARY</w:t></w:r></w:p></w:body></w:document>`);
  await fs.writeFile(join(h.root, 'source.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const read = h.reader.read.bind(h.reader); vi.spyOn(h.reader, 'read').mockImplementation(async (...args) => { const value = await read(...args); h.tools.beginTurn(); return value; });
  const result = await h.tools.run('inspect_office', { path: 'source.docx' }); expect(result.status).toBe('failed'); expect(result.output).not.toContain('PRIVATE CANARY');
  const roots = [...(h.reader as any).roots] as string[]; expect(roots.length).toBeGreaterThan(0); h.tools.retire();
  const disposal = h.reader.dispose(); expect(h.reader.dispose()).toBe(disposal); await disposal;
  for (const root of roots) await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
});
