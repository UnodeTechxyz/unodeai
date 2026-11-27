import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join, posix } from 'node:path';
import JSZip from 'jszip';
import { admitUserTurn, attachment, attachmentIds, saveHost } from './attachmentSaveFixtures';
import { officeRouteReader, officeRouteEditor } from './officeInventoryRouteFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { PRESENTATION_PNG } from './presentationImageFixtures';
import { wordPictureDocument, wordPictureDrawing } from './officeWordPictureFixtures';
import { wordPictureElements, WORD_DRAWING_NS, WORD_PICTURE_NS } from '../../office/OfficeWordPicture';
import { OFFICE_NS, OFFICE_REL } from '../../office/OfficePackage';
import { officeXmlElements } from '../../office/OfficeXmlElements';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); await removeTemporaryFolders(); });
async function prepare(mode = 'ordinary') {
  const h = await saveHost(); const sources = await admitUserTurn(h.assets, [attachment('new.png', 'image/png', 'image', PRESENTATION_PNG)]); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const tools = h.tools('dev', sources); tools.setOfficeReader(reader); tools.setOfficeEditor(editor); tools.setOfficeAuthoring(() => ({ trackChangesDefault: false, authorName: '', memberName: 'agent' })); tools.beginTurn(); cleanup.push(async () => { tools.retire(); await reader.dispose(); await h.assets.dispose(); });
  const bytes = await wordPictureDocument(mode); await fs.writeFile(join(h.root, 'source.docx'), bytes); const p = { ...h, reader, editor, tools, bytes, id: attachmentIds(sources)[0] }; return { ...p, page: await inspect(p) };
}
async function inspect(p: { tools: ReturnType<Awaited<ReturnType<typeof saveHost>>['tools']> }, path = 'source.docx') {
  const records: any[] = []; let cursor: string | undefined;
  for (let count = 0; count < 100; count++) { const result = await p.tools.run('inspect_office', { path, ...(cursor ? { cursor } : {}) }); expect(result.status, result.output).toBe('success'); const page = JSON.parse(result.output); records.push(...page.prepared_fragments); if (!page.next_cursor) return { records, snapshot: page.snapshot_ref, summary: page.summary }; cursor = page.next_cursor; } throw new Error('inventory did not finish');
}
const imageEdit = (asset: string, extra = {}) => ({ op: 'replace_image', target_ref: 'I1', asset_ref: asset, ...extra });
const save = (p: Awaited<ReturnType<typeof prepare>>, edits: unknown[]) => p.tools.run('edit_office', { schema_version: 1, snapshot_ref: p.page.snapshot, path: 'output.docx', edits });
async function output(p: Awaited<ReturnType<typeof prepare>>) {
  const zip = await JSZip.loadAsync(await fs.readFile(join(p.root, 'output.docx'))); const before = await JSZip.loadAsync(p.bytes);
  for (const [name, entry] of Object.entries(before.files)) if (!entry.dir && !['word/document.xml', 'word/_rels/document.xml.rels', '[Content_Types].xml'].includes(name)) expect((await zip.file(name)!.async('nodebuffer')).equals(await entry.async('nodebuffer')), name).toBe(true);
  expect((await fs.readFile(join(p.root, 'source.docx'))).equals(p.bytes)).toBe(true); return { zip, before, parsed: wordPictureElements(await zip.file('word/document.xml')!.async('nodebuffer'), () => {}), page: await inspect(p, 'output.docx') };
}
async function pictureMedia(zip: JSZip, index = 0) {
  const parsed = wordPictureElements(await zip.file('word/document.xml')!.async('nodebuffer'), () => {}); const picture = parsed.pictures[index]; const fill = picture.children.find(child => WORD_PICTURE_NS.includes(child.tag.uri) && child.tag.local === 'blipFill')!; const blip = fill.children.find(child => OFFICE_NS.a.includes(child.tag.uri) && child.tag.local === 'blip')!; const embed = Object.values(blip.tag.attributes).find(attribute => attribute.local === 'embed' && OFFICE_REL.includes(attribute.uri))!.value;
  const rels = officeXmlElements(await zip.file('word/_rels/document.xml.rels')!.async('nodebuffer'), () => {}); const relation = rels.elements.find(element => element.tag.local === 'Relationship' && element.tag.attributes.Id?.value === embed)!; const name = posix.normalize(posix.join('word', relation.tag.attributes.Target.value)); return { embed, name, bytes: await zip.file(name)!.async('nodebuffer') };
}
it.each(['ordinary', 'strict-le', 'strict-be', 'anchor', 'svg', 'alternate', 'missing-rels', 'missing-transform', 'missing-offset', 'missing-extent', 'empty-properties'])('registered Word image replacement handles %s and preserves unselected shared media', async mode => {
  const p = await prepare(mode); const pictures = p.page.records.filter(record => record.kind === 'object'); expect(pictures.map(record => record.id)).toEqual(['I1', 'I2']); expect(p.page.summary.objects).toBe(2); expect(JSON.stringify(p.page)).not.toContain('credential=hidden');
  const result = await save(p, [imageEdit(p.id, { alt_text: 'New <&> 中文' })]); expect(result.status, result.output).toBe('success'); const out = await output(p); const media = await pictureMedia(out.zip); expect(media.bytes).toEqual(PRESENTATION_PNG); expect(media.name).not.toBe('word/media/original.png');
  const before = wordPictureElements(await out.before.file('word/document.xml')!.async('nodebuffer'), () => {}); const originalSecond = before.pictures[1]; const second = out.parsed.pictures[1]; expect(out.parsed.decoded.xml.slice(second.start, second.end)).toBe(before.decoded.xml.slice(originalSecond.start, originalSecond.end));
  expect(out.page.records.find(record => record.id === 'I1').record).toMatchObject({ alt_text: 'New <&> 中文', geometry_emu: { off_x: '0', off_y: '250000', ext_cx: '1000000', ext_cy: '500000' }, layout_extent_emu: { cx: '1000000', cy: '1000000' } });
  if (!['missing-transform', 'empty-properties'].includes(mode)) expect(out.parsed.decoded.xml).toContain('rot="30000" flipH="1"'); if (mode === 'anchor') { expect(out.parsed.decoded.xml).toContain('<wp:posOffset>180000</wp:posOffset>'); expect(out.parsed.decoded.xml).toContain('<wp:wrapNone/>'); }
  if (mode === 'svg') { expect(out.parsed.decoded.xml).not.toContain('asvg:svgBlip'); expect(out.parsed.decoded.xml).toContain('uri="vendor"'); }
  if (mode === 'alternate') expect(out.parsed.decoded.xml).toContain(wordPictureDrawing(9));
  if (mode.startsWith('strict')) expect([...(await out.zip.file('word/document.xml')!.async('nodebuffer')).subarray(0, 2)]).toEqual(mode === 'strict-be' ? [254, 255] : [255, 254]);
});
it('deduplicates repeated replacement media but keeps independent selected-picture relationships', async () => {
  const p = await prepare(); const result = await save(p, [imageEdit(p.id), imageEdit(p.id, { target_ref: 'I2', fit: 'cover' })]); expect(result.status, result.output).toBe('success'); const out = await output(p); const first = await pictureMedia(out.zip); const second = await pictureMedia(out.zip, 1); expect(first.name).toBe(second.name); expect(first.embed).not.toBe(second.embed); expect(Object.keys(out.zip.files).filter(name => /word\/unode-.*\.png$/.test(name))).toHaveLength(1); expect(out.parsed.decoded.xml).toContain('l="25000"'); expect(out.parsed.decoded.xml).toContain('r="25000"');
});
it('keeps original I refs after paragraph insertion and honors source crop and focal rectangle', async () => {
  const p = await prepare(); const result = await save(p, [{ op: 'insert_paragraphs', target_ref: 'D1', paragraphs: ['Added'], position: 'before' }, imageEdit(p.id, { target_ref: 'I2', fit: 'cover', crop: { x: 0.1, y: 0, w: 0.8, h: 1 }, focal_rect: { x: 0.1, y: 0, w: 0.2, h: 1 } })]); expect(result.status, result.output).toBe('success'); const out = await output(p); const first = await pictureMedia(out.zip); const second = await pictureMedia(out.zip, 1); expect(first.name).toBe('word/media/original.png'); expect(second.name).not.toBe(first.name); expect(out.page.records.find(record => record.id === 'D1').record.text).toBe('Added'); const pic = out.parsed.pictures[1]; const selected = out.parsed.decoded.xml.slice(pic.start, pic.end); expect(selected).toContain('l="10000"'); expect(selected).toContain('r="40000"');
});
it.each(['linked', 'grouped', 'unheld', 'late-off', 'bad-image-fact'])('withholds %s without overwriting an existing destination', async mode => {
  const p = await prepare(mode); const prior = Buffer.from('Existing destination'); await fs.writeFile(join(p.root, 'output.docx'), prior);
  if (mode === 'late-off' || mode === 'bad-image-fact') { const real = p.editor.edit.bind(p.editor); vi.spyOn(p.editor, 'edit').mockImplementation(async (...args) => { const result = await real(...args); if (mode === 'late-off') (p.tools as any).allowedTools.delete('write'); else result.images![0].placements++; return result; }); }
  const result = await save(p, [imageEdit(mode === 'unheld' ? 'unheld-asset' : p.id)]); expect(result.status).not.toBe('success'); if (['linked', 'grouped'].includes(mode)) { expect(result.officeEdit?.code).toBe('unsupported-word-picture'); expect(result.output).toContain('I# or header/footer P#-I#'); } expect((await fs.readFile(join(p.root, 'output.docx'))).equals(prior)).toBe(true);
});
it('retains drawing-local geometry namespaces and reports body-only picture coverage', async () => { const p = await prepare(); const picture = p.page.records.find(record => record.id === 'I1'); expect(picture.record).toMatchObject({ placement: 'inline', coordinate_space: 'word-drawing-local', images: [{ linked: false, relationship_id: 'sharedImage' }] }); expect(p.tools.specs().find(spec => spec.function.name === 'inspect_office')!.function.description).toContain('header/footer P#-I#'); const result = await save(p, [imageEdit(p.id)]); expect(result.status, result.output).toBe('success'); const out = await output(p); expect(out.parsed.elements.filter(element => WORD_DRAWING_NS.includes(element.tag.uri) && element.tag.local === 'extent')).toHaveLength(2); });
