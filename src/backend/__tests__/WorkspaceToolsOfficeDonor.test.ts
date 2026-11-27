import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { WorkspaceTools } from '../WorkspaceTools';
import { officeRouteReader, officeRouteEditor, officeRouteDocument } from './officeInventoryRouteFixtures';
import { workbookRouteReader } from './workbookRouteFixtures';
import { COMPUTE_CSV, workbookSumPlan } from './workbookComputeFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { OfficePackage } from '../../office/OfficePackage';
import { officeXmlElements } from '../../office/OfficeXmlElements';
import { validateOfficeEditRequest } from '../../office/OfficeEditContracts';
const owned: Array<Awaited<ReturnType<typeof host>>> = [];
afterEach(async () => { for (const h of owned.splice(0)) { h.tools.retire(); await h.reader.dispose(); } await removeTemporaryFolders(); });
async function host() {
  const root = await temporaryFolder('unode-donor-'); const reader = await officeRouteReader(); const editor = await officeRouteEditor();
  const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'agent'); tools.setOfficeReader(reader); tools.setOfficeEditor(editor); tools.beginTurn();
  const h = { root, reader, editor, tools }; owned.push(h); return h;
}
async function inventory(h: Awaited<ReturnType<typeof host>>, path: string) {
  const records: any[] = []; let cursor: string | undefined;
  for (let count = 0; count < 100; count++) {
    const result = await h.tools.run('inspect_office', { path, ...(cursor ? { cursor } : {}) }); expect(result.status, result.output).toBe('success');
    const page = JSON.parse(result.output); records.push(...page.prepared_fragments); if (!page.next_cursor) return { snapshot: page.snapshot_ref, records, summary: page.summary }; cursor = page.next_cursor;
  }
  throw new Error('inventory did not finish');
}
async function fixture(donor = false) {
  const deck = new PptxGenJS(); const slide = deck.addSlide(); slide.addText(donor ? 'Donor title' : 'Original title', { x: 1, y: 1, w: 5, h: 1 }); slide.addNotes(donor ? 'Donor notes' : 'Destination notes');
  if (donor) {
    slide.addChart(deck.ChartType.bar, [{ name: 'Donor series', labels: ['Q1'], values: [42] }], { x: 1, y: 2, w: 5, h: 3 });
    slide.addText('External link', { x: 1, y: 6, w: 2, h: 1, hyperlink: { url: 'https://example.invalid/retained' } });
  }
  deck.addSlide().addText(donor ? 'Unrequested donor page' : 'Original second page', { x: 1, y: 1, w: 4, h: 1 });
  const zip = await JSZip.loadAsync(await deck.write({ outputType: 'nodebuffer' }) as Buffer);
  if (donor) zip.file('ppt/theme/theme1.xml', (await zip.file('ppt/theme/theme1.xml')!.async('string')).replace(/(<a:accent1>)[\s\S]*?(<\/a:accent1>)/, '$1<a:srgbClr val="ABC123"/>$2'));
  zip.file('custom/keep.bin', Buffer.from(donor ? 'donor unknown part' : 'original unknown part')); return zip;
}
async function prepare(options: { source?: JSZip; donor?: JSZip } = {}) {
  const h = await host(); const source = await (options.source ?? await fixture()).generateAsync({ type: 'nodebuffer' }); const donor = await (options.donor ?? await fixture(true)).generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(join(h.root, 'source.pptx'), source); await fs.writeFile(join(h.root, 'donor.pptx'), donor);
  return { h, source, donor, base: await inventory(h, 'source.pptx'), from: await inventory(h, 'donor.pptx') };
}
const insertion = (p: Awaited<ReturnType<typeof prepare>>, extra: Record<string, unknown> = {}) => ({ op: 'insert_generated_slide', target_ref: 'S1', donor_snapshot_ref: p.from.snapshot, donor_slide_ref: 'S1', ...extra });
const save = (p: Awaited<ReturnType<typeof prepare>>, edits: unknown[]) => p.h.tools.run('edit_office', { schema_version: 1, path: 'output.pptx', snapshot_ref: p.base.snapshot, edits });
async function preserved(source: Buffer, output: JSZip, changed = ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'docProps/app.xml']) {
  const before = await JSZip.loadAsync(source);
  for (const [name, entry] of Object.entries(before.files)) if (!entry.dir && !changed.includes(name)) expect((await output.file(name)!.async('nodebuffer')).equals(await entry.async('nodebuffer')), name).toBe(true);
}
it('registered donor insertion saves a complete dependency graph and master registration while preserving destination/source parts', async () => {
  const p = await prepare(); const result = await save(p, [insertion(p)]); expect(result.status, result.output).toBe('success'); expect(result.output).toContain('slide count 2 to 3'); expect(result.output).toContain('Matched text spans: 0');
  const readback = await inventory(p.h, 'output.pptx'); expect(readback.records.filter(record => record.kind === 'object' && record.record.object_kind === 'sp').map(record => record.record.text)).toContain('Donor title');
  expect(readback.records.filter(record => record.kind === 'slide')).toHaveLength(3); expect(readback.records.some(record => record.record.text === 'Unrequested donor page')).toBe(false);
  const output = await JSZip.loadAsync(await fs.readFile(join(p.h.root, 'output.pptx'))); await preserved(p.source, output);
  const added = Object.keys(output.files).filter(name => !name.endsWith('/') && name.includes('/unode-import-')); expect(added.length).toBeGreaterThan(5);
  const pkg = await OfficePackage.open(join(p.h.root, 'output.pptx'), 1000, 64 * 1024 * 1024, () => {});
  try {
    for (const name of pkg.zip.names().filter(name => name.includes('/UNODE-IMPORT-') && !name.includes('/_RELS/'))) for (const relation of await pkg.relations(name)) if (!relation.external) expect(pkg.zip.has(relation.target!), name + ':' + relation.id).toBe(true);
    const main = officeXmlElements(await output.file('ppt/presentation.xml')!.async('nodebuffer'), () => {}); const masters = main.elements.filter(element => element.tag.local === 'sldMasterId'); expect(masters).toHaveLength(2);
    const numeric: string[] = masters.map(master => master.tag.attributes.id.value);
    for (const part of pkg.parts.filter(part => part.contentType?.endsWith('presentationml.slideMaster+xml'))) {
      const member = await output.file(pkg.zip.memberName(part.name))!.async('nodebuffer'); numeric.push(...officeXmlElements(member, () => {}).elements.filter(element => element.tag.local === 'sldLayoutId').map(element => element.tag.attributes.id.value));
    }
    expect(new Set(numeric).size).toBe(numeric.length);
    const imported = readback.records.find(record => record.kind === 'slide' && record.id === 'S2');
    const notes = readback.records.find(record => record.kind === 'relationship' && record.record.part_ref === imported.record.part_ref && record.record.relationship_kind === 'notesSlide');
    expect(readback.records.find(record => record.kind === 'relationship' && record.record.part_ref === notes.record.target_part && record.record.relationship_kind === 'slide').record.target_part).toBe(imported.record.part_ref);
    expect(await Promise.all(added.filter(name => /\.xml$/.test(name)).map(name => output.file(name)!.async('string')))).toEqual(expect.arrayContaining([expect.stringContaining('ABC123'), expect.stringContaining('Donor series')]));
  } finally { pkg.close(); }
  expect((await fs.readFile(join(p.h.root, 'source.pptx'))).equals(p.source)).toBe(true); expect((await fs.readFile(join(p.h.root, 'donor.pptx'))).equals(p.donor)).toBe(true);
});
it.each(['first', 'main-append', 'empty'])('inserts at %s with correct original logical selector meaning', async mode => {
  const source = await fixture(); if (mode === 'empty') source.file('ppt/presentation.xml', (await source.file('ppt/presentation.xml')!.async('string')).replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, '<p:sldIdLst/>'));
  const p = await prepare({ source }); const main = p.base.records.find(record => record.kind === 'part' && record.record.main).id;
  const result = await save(p, [insertion(p, mode === 'first' ? { after_ref: null } : { target_ref: main })]); expect(result.status, result.output).toBe('success');
  const out = await inventory(p.h, 'output.pptx'); const text = out.records.filter(record => record.kind === 'object' && record.record.object_kind === 'sp').map(record => record.record.text);
  expect(text.indexOf('Donor title')).toBe(mode === 'main-append' ? 2 : 0); expect(out.records.filter(record => record.kind === 'slide')).toHaveLength(mode === 'empty' ? 1 : 3);
});
it('mixes insert, duplicate, original text edit and remove without retargeting original selectors', async () => {
  const p = await prepare(); const result = await save(p, [insertion(p, { after_ref: null }), { op: 'duplicate_slide', target_ref: 'S2' }, { op: 'set_shape_text', target_ref: 'S2-O1', text: 'Edited original second' }, { op: 'remove_slide', target_ref: 'S1' }]);
  expect(result.status, result.output).toBe('success'); const out = await inventory(p.h, 'output.pptx'); expect(out.records.filter(record => record.kind === 'slide')).toHaveLength(3);
  const text = out.records.filter(record => record.kind === 'object' && record.record.object_kind === 'sp').map(record => record.record.text);
  expect(text).toEqual(expect.arrayContaining(['Donor title', 'Edited original second', 'Original second page'])); expect(text).not.toContain('Original title');
});
it('repeated donor imports have independent part graphs and unique slide/master/layout identifiers', async () => {
  const p = await prepare(); const result = await save(p, [insertion(p), insertion(p)]); expect(result.status, result.output).toBe('success');
  const out = await inventory(p.h, 'output.pptx'); expect(out.records.filter(record => record.kind === 'slide')).toHaveLength(4);
  const donorSlides = out.records.filter(record => record.kind === 'object' && record.record.text === 'Donor title'); expect(donorSlides).toHaveLength(2); expect(new Set(donorSlides.map(record => record.record.part_ref)).size).toBe(2);
  const pkg = await OfficePackage.open(join(p.h.root, 'output.pptx'), 1000, 64 * 1024 * 1024, () => {}); const zip = await JSZip.loadAsync(await fs.readFile(join(p.h.root, 'output.pptx')));
  try {
    const ids: string[] = [];
    for (const part of pkg.parts.filter(part => part.name === pkg.main.name || part.contentType?.endsWith('presentationml.slideMaster+xml'))) ids.push(...officeXmlElements(await zip.file(pkg.zip.memberName(part.name))!.async('nodebuffer'), () => {}).elements.filter(element => ['sldId', 'sldMasterId', 'sldLayoutId'].includes(element.tag.local)).map(element => element.tag.attributes.id.value));
    expect(new Set(ids).size).toBe(ids.length);
  } finally { pkg.close(); }
});
it.each(['hlinkClick', 'hlinkMouseOver', 'hlinkHover'])('omits linked donor pages and neutralizes %s while preserving ordinary dependencies', async hyperlink => {
  const donor = await fixture(true); const name = 'ppt/slides/_rels/slide1.xml.rels';
  donor.file('custom/dependency.bin', Buffer.from([0, 255, 33]));
  const sourceSlide = await donor.file('ppt/slides/slide1.xml')!.async('string');
  const link = `<a:${hyperlink} r:id="auxiliary" action="ppaction://hlinksldjump"/>`;
  const linkedSlide = hyperlink === 'hlinkHover' ? sourceSlide.replace(/<p:cNvPr\b([^>]*?)\/>/, `<p:cNvPr$1>${link}</p:cNvPr>`)
    : sourceSlide.replace('</a:rPr>', link + '</a:rPr>');
  expect(linkedSlide).toContain('r:id="auxiliary"'); donor.file('ppt/slides/slide1.xml', linkedSlide);
  donor.file(name, (await donor.file(name)!.async('string')).replace('</Relationships>', '<Relationship Id="auxiliary" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slide2.xml#detail"/><Relationship Id="opaque" Type="urn:custom" Target="../../custom/dependency.bin"/><Relationship Id="missing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/missing.png"/></Relationships>'));
  const p = await prepare({ donor }); const result = await save(p, [insertion(p)]); expect(result.status, result.output).toBe('success'); expect(result.output).toContain('auxiliary linked slide parts 0'); expect(result.output).toContain('unavailable dependencies 1');
  const out = await inventory(p.h, 'output.pptx'); expect(out.records.filter(record => record.kind === 'slide')).toHaveLength(3); expect(out.records.some(record => record.record.text === 'Unrequested donor page')).toBe(false);
  const zip = await JSZip.loadAsync(await fs.readFile(join(p.h.root, 'output.pptx'))); const pkg = await OfficePackage.open(join(p.h.root, 'output.pptx'), 1000, 64 * 1024 * 1024, () => {});
  try {
    const part = out.records.find(record => record.kind === 'slide' && record.id === 'S2').record.part_ref; const relations = await pkg.relations(pkg.partByRef(part)!.name);
    expect((await zip.file(pkg.zip.memberName(relations.find(relation => relation.id === 'opaque')!.target!))!.async('nodebuffer')).equals(Buffer.from([0, 255, 33]))).toBe(true);
    expect(relations.find(relation => relation.id === 'auxiliary')).toBeUndefined(); expect(pkg.zip.has(relations.find(relation => relation.id === 'missing')!.target!)).toBe(false);
    const imported = await zip.file(pkg.zip.memberName(pkg.partByRef(part)!.name))!.async('string'); expect(imported).not.toContain('r:id="auxiliary"');
    const xml = await zip.file(pkg.zip.memberName(pkg.partByRef(part)!.name).replace(/([^/]+)$/, '_rels/$1.rels'))!.async('string'); expect(xml).not.toContain('#detail'); expect(xml).toContain('https://example.invalid/retained');
    const all = await Promise.all(Object.values(zip.files).filter(entry => !entry.dir && /\.xml$/.test(entry.name)).map(entry => entry.async('string')));
    expect(all.join('\n')).not.toContain('Unrequested donor page');
  } finally { pkg.close(); }
});
it('inserts into a strict UTF16 destination while retaining its BOM and untouched original slide bytes', async () => {
  const source = await fixture();
  for (const [name, entry] of Object.entries(source.files)) if (!entry.dir && /\.(xml|rels)$/.test(name)) {
    const xml = (await entry.async('string')).replaceAll('http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main').replaceAll('http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main').replaceAll('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships').replace(/encoding="UTF-8"/i, 'encoding="UTF-16"');
    source.file(name, Buffer.concat([Buffer.from([255, 254]), Buffer.from(xml, 'utf16le')]));
  }
  const p = await prepare({ source }); const result = await save(p, [insertion(p)]); expect(result.status, result.output).toBe('success'); const zip = await JSZip.loadAsync(await fs.readFile(join(p.h.root, 'output.pptx'))); await preserved(p.source, zip);
  expect([...(await zip.file('ppt/presentation.xml')!.async('nodebuffer')).subarray(0, 2)]).toEqual([255, 254]); expect((await inventory(p.h, 'output.pptx')).records.filter(record => record.kind === 'slide')).toHaveLength(3);
});
it('rechecks donor bytes after worker completion and before saving', async () => {
  const p = await prepare(); const real = p.h.editor.edit.bind(p.h.editor); vi.spyOn(p.h.editor, 'edit').mockImplementation(async (...args) => { const result = await real(...args); await fs.appendFile(join(p.h.root, 'donor.pptx'), 'changed after render'); return result; });
  const result = await save(p, [insertion(p)]); expect(result.status).not.toBe('success'); await expect(fs.stat(join(p.h.root, 'output.pptx'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('F1 reports an unheld donor snapshot accurately when a chart transformation shares the request', async () => {
  const p = await prepare({ source: await fixture(true) }); const workbook = await workbookRouteReader(); p.h.tools.setWorkbookReader(workbook);
  try {
    await fs.writeFile(join(p.h.root, 'data.csv'), COMPUTE_CSV); const read = await p.h.tools.run('read_workbook', { path: 'data.csv' }); expect(read.status, read.output).toBe('success');
    const computed = await p.h.tools.run('transform_workbook', workbookSumPlan(JSON.parse(read.output).snapshot_ref)); expect(computed.status, computed.output).toBe('success');
    const prior = Buffer.from('Existing destination'); await fs.writeFile(join(p.h.root, 'output.pptx'), prior);
    const result = await save(p, [{ op: 'update_chart_data', target_ref: 'S1-O2', data_from: { transformation_ref: JSON.parse(computed.output).transformation_ref, label_field: 'team', value_fields: ['total'] } }, insertion(p, { donor_snapshot_ref: 'office-11111111-1111-1111-1111-111111111111' })]);
    expect(result.officeEdit?.code).toBe('snapshot-unavailable'); expect(result.output).toContain('Call inspect_office'); expect(result.output).not.toContain('transform_workbook again'); expect((await fs.readFile(join(p.h.root, 'output.pptx'))).equals(prior)).toBe(true);
  } finally { await workbook.dispose(); }
});
it('F2 names the required PPTX donor when an unchanged DOCX snapshot is supplied', async () => {
  const p = await prepare(); const word = await officeRouteDocument(); await fs.writeFile(join(p.h.root, 'donor.docx'), word); const from = await inventory(p.h, 'donor.docx');
  const prior = Buffer.from('Existing destination'); await fs.writeFile(join(p.h.root, 'output.pptx'), prior);
  const result = await save(p, [insertion(p, { donor_snapshot_ref: from.snapshot })]); expect(result.officeEdit?.code).toBe('donor-presentation-required'); expect(result.output).toContain('Use inspect_office on a PPTX donor'); expect(result.output).not.toContain('Source bytes changed');
  expect((await fs.readFile(join(p.h.root, 'output.pptx'))).equals(prior)).toBe(true); expect((await fs.readFile(join(p.h.root, 'donor.docx'))).equals(word)).toBe(true);
});
it.each(['donor-stale', 'worker-fact', 'late-off', 'unheld-snapshot', 'wrong-donor-slide', 'macro-donor'])('withholds %s and preserves an existing destination', async mode => {
  const donor = await fixture(true); if (mode === 'macro-donor') donor.file('[Content_Types].xml', (await donor.file('[Content_Types].xml')!.async('string')).replace('application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml', 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml'));
  const p = await prepare({ donor }); const prior = Buffer.from('User destination'); await fs.writeFile(join(p.h.root, 'output.pptx'), prior);
  if (mode === 'donor-stale') await fs.appendFile(join(p.h.root, 'donor.pptx'), 'changed');
  if (mode === 'worker-fact' || mode === 'late-off') { const real = p.h.editor.edit.bind(p.h.editor); vi.spyOn(p.h.editor, 'edit').mockImplementation(async (...args) => { const result = await real(...args); if (mode === 'worker-fact') result.insertedSlides![0].donor_sha256 = '0'.repeat(64); else (p.h.tools as any).allowedTools.delete('read'); return result; }); }
  const result = await save(p, [insertion(p, mode === 'unheld-snapshot' ? { donor_snapshot_ref: 'office-11111111-1111-1111-1111-111111111111' } : mode === 'wrong-donor-slide' ? { donor_slide_ref: 'S99' } : {})]);
  expect(result.status).not.toBe('success'); expect((await fs.readFile(join(p.h.root, 'output.pptx'))).equals(prior)).toBe(true);
});
it.each([{ donor_slide_ref: 'bad' }, { donor_snapshot_ref: 'bad' }, { target_ref: 'D1' }, { raw_xml: '<p:sld/>' }, { after_ref: 'P1' }])('rejects invalid typed donor fields %j', extra => {
  expect(() => validateOfficeEditRequest({ schema_version: 1, path: 'output.pptx', snapshot_ref: 'office-11111111-1111-1111-1111-111111111111', edits: [{ op: 'insert_generated_slide', target_ref: 'S1', donor_snapshot_ref: 'office-11111111-1111-1111-1111-111111111111', donor_slide_ref: 'S1', ...extra }] })).toThrow('invalid-office-edits');
});
