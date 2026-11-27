import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join, posix } from 'node:path';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { SaxesParser } from 'saxes';
import { admitUserTurn, attachment, attachmentIds, saveHost, sha } from './attachmentSaveFixtures';
import { officeRouteReader, officeRouteEditor } from './officeInventoryRouteFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { PRESENTATION_PNG, solidScreenshotPng } from './presentationImageFixtures';
import { withExifOrientation } from './jpegImageFixtures';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); await removeTemporaryFolders(); });
async function host(image = PRESENTATION_PNG, jpeg = false) {
  const h = await saveHost(); const sources = await admitUserTurn(h.assets, [attachment(jpeg ? 'new.jpg' : 'new.png', jpeg ? 'image/jpeg' : 'image/png', 'image', image)]);
  const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const tools = h.tools('dev', sources);
  tools.setOfficeReader(reader); tools.setOfficeEditor(editor); tools.beginTurn();
  cleanup.push(async () => { tools.retire(); await reader.dispose(); await h.assets.dispose(); });
  return { ...h, reader, editor, tools, id: attachmentIds(sources)[0] };
}
async function source(shared = false, svg = false) {
  const deck = new PptxGenJS(); const slide = deck.addSlide();
  for (const x of [1, 6]) slide.addImage({ data: `image/png;base64,${PRESENTATION_PNG.toString('base64')}`, x, y: 1, w: 4, h: 4, altText: 'Original' });
  slide.addText('Preserved text', { x: 1, y: 6, w: 4, h: 1 }); slide.addNotes('Keep notes');
  const zip = await JSZip.loadAsync(await deck.write({ outputType: 'nodebuffer' }) as Buffer);
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  const embeds = [...xml.matchAll(/r:embed="([^"]+)"/g)].map(match => match[1]);
  let slideXml = xml.replace(`r:embed="${embeds[1]}"`, `r:embed="${embeds[0]}"`).replace(/(<p:pic\b[\s\S]*?<a:xfrm)\b[^>]*>/, (_match, prefix: string) => prefix + ' rot="5400000" flipH="1">');
  if (svg) {
    slideXml = slideXml.replace(/<a:blip\b[^>]*\/>|<a:blip\b[^>]*>[\s\S]*?<\/a:blip>/, blip => {
      const extension = '<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId_svg"/></a:ext></a:extLst>';
      return blip.endsWith('/>') ? blip.slice(0, -2) + '>' + extension + '</a:blip>' : blip.slice(0, -9) + extension + '</a:blip>';
    });
    expect(slideXml).toContain('asvg:svgBlip');
    const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string');
    zip.file('ppt/slides/_rels/slide1.xml.rels', rels.replace('</Relationships>', '<Relationship Id="rId_svg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/original.svg"/></Relationships>'));
    zip.file('ppt/media/original.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="red"/></svg>');
    const ct = await zip.file('[Content_Types].xml')!.async('string'); zip.file('[Content_Types].xml', ct.replace('</Types>', '<Override PartName="/ppt/media/original.svg" ContentType="image/svg+xml"/></Types>'));
  }
  zip.file('ppt/slides/slide1.xml', slideXml);
  if (shared) {
    const main = await zip.file('ppt/presentation.xml')!.async('string'); const entry = /<p:sldId\b[^>]*\/>/.exec(main)![0];
    zip.file('ppt/presentation.xml', main.replace('</p:sldIdLst>', entry.replace(/ id="[^"]+"/, ' id="257"') + '</p:sldIdLst>'));
  }
  zip.file('custom/untouched.bin', Buffer.from([255, 0, 3, 11])); return zip.generateAsync({ type: 'nodebuffer' });
}
async function inspect(h: Awaited<ReturnType<typeof host>>, path: string) {
  let cursor: string | undefined; const records: any[] = []; let snapshot = '';
  do {
    const result = await h.tools.run('inspect_office', { path, ...(cursor ? { cursor } : {}) }); expect(result.status, result.output).toBe('success');
    const page = JSON.parse(result.output); records.push(...page.prepared_fragments); snapshot = page.snapshot_ref; cursor = page.next_cursor;
  } while (cursor);
  return { records, snapshot };
}
function xmlElements(xml: string) {
  const result: Array<{ name: string; attrs: Record<string, string> }> = []; const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', tag => result.push({ name: tag.local, attrs: Object.fromEntries(Object.values(tag.attributes).filter(attr => attr.uri !== 'http://www.w3.org/2000/xmlns/').map(attr => [attr.local, attr.value])) }));
  parser.write(xml).close(); return result;
}
const imageEdit = (asset: string, extra = {}) => ({ op: 'replace_image', target_ref: 'S1-O1', asset_ref: asset, ...extra });
async function edited(h: Awaited<ReturnType<typeof host>>, edits: any[], shared = false, svg = false, prepared?: Buffer) {
  const bytes = prepared ?? await source(shared, svg); await fs.writeFile(join(h.root, 'source.pptx'), bytes); const page = await inspect(h, 'source.pptx');
  const result = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: page.snapshot, path: 'out.pptx', edits });
  expect(result.status, result.output).toBe('success'); const output = await fs.readFile(join(h.root, 'out.pptx'));
  expect((await fs.readFile(join(h.root, 'source.pptx'))).equals(bytes)).toBe(true);
  return { result, before: await JSZip.loadAsync(bytes), zip: await JSZip.loadAsync(output), page: await inspect(h, 'out.pptx') };
}
it('duplicates a current replacement picture into independent media and preserves its original source', async () => {
  const h = await host(); const out = await edited(h, [imageEdit(h.id, { alt_text: 'Current replacement' }), { op: 'duplicate_slide', target_ref: 'S1' }]);
  const pictures = out.page.records.filter(record => record.kind === 'object' && record.record.object_kind === 'pic');
  expect(pictures).toHaveLength(4);
  const target = (id: string) => {
    const picture = pictures.find(picture => picture.id === id)!; const image = picture.record.images[0];
    return out.page.records.find(record => record.kind === 'relationship' && record.record.part_ref === picture.record.part_ref && record.record.relationship_id === image.relationship_id)?.record.target_part;
  };
  const first = target('S1-O1'); const second = target('S2-O1'); expect(first).toBeTruthy(); expect(second).toBeTruthy(); expect(first).not.toBe(second);
  const newSlides = Object.keys(out.zip.files).filter(name => /^ppt\/slides\/unode-.*\.xml$/.test(name)); expect(newSlides).toHaveLength(1);
  expect(await out.zip.file(newSlides[0])!.async('string')).toContain('Current replacement');
  expect((await picture(out.zip, newSlides[0])).media).toEqual(PRESENTATION_PNG);
});
async function picture(zip: JSZip, name = 'ppt/slides/slide1.xml', index = 0) {
  const xml = await zip.file(name)!.async('string'); const pics = [...xml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/g)];
  const selected = pics[index][0]; const embed = /r:embed="([^"]+)"/.exec(selected)![1];
  const rels = xmlElements(await zip.file(posix.join(posix.dirname(name), '_rels', posix.basename(name) + '.rels'))!.async('string'));
  const target = rels.find(item => item.name === 'Relationship' && item.attrs.Id === embed)!.attrs.Target;
  return { xml: selected, elements: xmlElements(xml.replace(/<p:spTree[\s\S]*<\/p:spTree>/, () => '<p:spTree>' + selected + '</p:spTree>')),
    media: await zip.file(posix.normalize(posix.join(posix.dirname(name), target)))!.async('nodebuffer') };
}

it('replaces just one shared-image picture with contain geometry, exact original PNG and literal alt text', async () => {
  const h = await host(); const out = await edited(h, [imageEdit(h.id, { alt_text: 'New $& <image>\n第二行' })]);
  const first = await picture(out.zip); const second = await picture(out.zip, undefined, 1); const oldSecond = await picture(out.before, undefined, 1);
  expect(first.media.equals(PRESENTATION_PNG)).toBe(true); expect(second.xml).toBe(oldSecond.xml); expect(second.media.equals(oldSecond.media)).toBe(true);
  expect(first.elements.find(item => item.name === 'off')!.attrs).toEqual({ x: '914400', y: '1828800' });
  expect(first.elements.find(item => item.name === 'ext')!.attrs).toEqual({ cx: '3657600', cy: '1828800' });
  expect(first.elements.find(item => item.name === 'cNvPr')!.attrs.descr).toBe('New $& <image>\n第二行');
  expect(first.elements.find(item => item.name === 'xfrm')!.attrs).toEqual({ rot: '5400000', flipH: '1' });
  for (const [name, entry] of Object.entries(out.before.files)) if (!entry.dir && !['ppt/slides/slide1.xml', 'ppt/slides/_rels/slide1.xml.rels', '[Content_Types].xml'].includes(name))
    expect(sha(await out.zip.file(name)!.async('nodebuffer')), name).toBe(sha(await entry.async('nodebuffer')));
  expect(out.result.output).toContain(sha(PRESENTATION_PNG)); expect(h.state.approvals).toEqual([]);
});
it('removes the selected picture’s overriding SVG preview while preserving the original SVG bytes', async () => {
  const h = await host(); const out = await edited(h, [imageEdit(h.id)], false, true); const actual = await picture(out.zip);
  expect((await picture(out.before)).xml).toContain('svgBlip');
  expect(actual.xml).not.toContain('svgBlip'); expect(actual.media.equals(PRESENTATION_PNG)).toBe(true);
  expect((await out.zip.file('ppt/media/original.svg')!.async('nodebuffer')).equals(await out.before.file('ppt/media/original.svg')!.async('nodebuffer'))).toBe(true);
});
it.each(['layout', 'master', 'partial', 'utf16-layout'])('replaces a template picture inheriting %s geometry without changing the layout/master', async mode => {
  const h = await host(); const zip = await JSZip.loadAsync(await source());
  let xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  xml = xml.replace(/<p:pic\b[\s\S]*?<\/p:pic>/, pic => pic.replace(/<p:nvPr\b[^>]*\/>|<p:nvPr\b[^>]*>[\s\S]*?<\/p:nvPr>/,
    '<p:nvPr><p:ph type="pic" idx="11"/></p:nvPr>').replace(/<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>/,
    mode === 'partial' ? '<p:spPr><a:xfrm><a:off x="1828800" y="914400"/></a:xfrm></p:spPr>' : '<p:spPr/>'));
  expect(xml).toContain('<p:ph type="pic" idx="11"/>');
  zip.file('ppt/slides/slide1.xml', mode === 'utf16-layout' ? Buffer.concat([Buffer.from([255, 254]), Buffer.from(xml.replace('encoding="UTF-8"', 'encoding="UTF-16"'), 'utf16le')]) : xml);
  const geometry = '<a:xfrm rot="2700000" flipV="1"><a:off x="914400" y="914400"/><a:ext cx="3657600" cy="3657600"/></a:xfrm>';
  const shape = (idx: number, type: string, transform: string) => `<p:sp><p:nvSpPr><p:cNvPr id="77" name="Template picture"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}" idx="${idx}"/></p:nvPr></p:nvSpPr><p:spPr>${transform}</p:spPr></p:sp>`;
  const master = mode === 'master' || mode === 'partial';
  const layoutName = 'ppt/slideLayouts/slideLayout1.xml'; const masterName = 'ppt/slideMasters/slideMaster1.xml';
  const decoy = '<a:xfrm><a:off x="123" y="456"/><a:ext cx="789" cy="987"/></a:xfrm>';
  zip.file(layoutName, (await zip.file(layoutName)!.async('string')).replace('</p:spTree>', () => shape(99, 'pic', decoy) + shape(11, 'pic', master ? '' : geometry) + '</p:spTree>'));
  if (master) zip.file(masterName, (await zip.file(masterName)!.async('string')).replace('</p:spTree>', () => shape(11, 'pic', decoy) + shape(91, 'body', geometry) + '</p:spTree>'));
  const out = await edited(h, [imageEdit(h.id)], false, false, await zip.generateAsync({ type: 'nodebuffer' }));
  for (const name of [layoutName, masterName]) expect((await out.zip.file(name)!.async('nodebuffer')).equals(await out.before.file(name)!.async('nodebuffer'))).toBe(true);
  const bytes = await out.zip.file('ppt/slides/slide1.xml')!.async('nodebuffer');
  const output = mode === 'utf16-layout' ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8'); const pictureXml = /<p:pic\b[\s\S]*?<\/p:pic>/.exec(output)![0];
  expect(pictureXml).toContain('cx="3657600" cy="1828800"'); expect(pictureXml).toContain(`x="${mode === 'partial' ? '1828800' : '914400'}" y="1828800"`);
  if (mode !== 'partial') { expect(pictureXml).toContain('rot="2700000"'); expect(pictureXml).toContain('flipV="1"'); }
  if (mode === 'utf16-layout') expect([...bytes.subarray(0, 2)]).toEqual([255, 254]);
  expect(out.result.output).toContain('Matched text spans: 0;');
});
it.each(['<a:stretch/>', '<a:stretch></a:stretch>'])('supports the valid missing-fillRect form %s', async stretch => {
  const h = await host(); const zip = await JSZip.loadAsync(await source()); const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  zip.file('ppt/slides/slide1.xml', xml.replace(/<a:stretch\b[^>]*>[\s\S]*?<\/a:stretch>/, stretch));
  const out = await edited(h, [imageEdit(h.id)], false, false, await zip.generateAsync({ type: 'nodebuffer' }));
  expect((await picture(out.zip)).elements.some(item => item.name === 'fillRect')).toBe(true);
});
it('reports the specific unavailable frame when neither the picture nor a matching placeholder supplies geometry', async () => {
  const h = await host(); const zip = await JSZip.loadAsync(await source()); const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  zip.file('ppt/slides/slide1.xml', xml.replace(/<p:pic\b[\s\S]*?<\/p:pic>/, pic => pic.replace(/<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>/, '<p:spPr/>')));
  await fs.writeFile(join(h.root, 'source.pptx'), await zip.generateAsync({ type: 'nodebuffer' })); const page = await inspect(h, 'source.pptx');
  const result = await h.tools.run('edit_office', { schema_version: 1, path: 'out.pptx', snapshot_ref: page.snapshot, edits: [imageEdit(h.id)] });
  expect(result.status).not.toBe('success'); expect(result.officeEdit?.code).toBe('picture-geometry-unavailable'); expect(result.output).toContain('matching layout/master placeholder');
  await expect(fs.stat(join(h.root, 'out.pptx'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects fault-injected malformed picture XML before creating or replacing the destination', async () => {
  const h = await host(); h.tools.setOfficeEditor(await officeRouteEditor({ corruptPictureXml: true }));
  await fs.writeFile(join(h.root, 'source.pptx'), await source()); await fs.writeFile(join(h.root, 'existing.pptx'), 'USER FILE'); const page = await inspect(h, 'source.pptx');
  const result = await h.tools.run('edit_office', { schema_version: 1, path: 'existing.pptx', snapshot_ref: page.snapshot, edits: [imageEdit(h.id)] });
  expect(result.officeEdit?.code).toBe('office-output-check-failed'); expect(await fs.readFile(join(h.root, 'existing.pptx'), 'utf8')).toBe('USER FILE'); expect(h.text.list()).toEqual([]);
});
it('uses cover and a right-hand focal rectangle without stretching or changing the frame', async () => {
  const h = await host(); const out = await edited(h, [imageEdit(h.id, { fit: 'cover', focal_rect: { x: .8, y: .2, w: .2, h: .6 } })]);
  const actual = await picture(out.zip);
  expect(actual.elements.find(item => item.name === 'srcRect')!.attrs).toEqual({ l: '50000', t: '0', r: '0', b: '0' });
  expect(actual.elements.find(item => item.name === 'ext')!.attrs).toEqual({ cx: '3657600', cy: '3657600' });
});
it('isolates a shared primary slide before image replacement and preserves the original logical slide', async () => {
  const h = await host(); const out = await edited(h, [imageEdit(h.id, { target_ref: 'S2-O1', crop: { x: .5, y: 0, w: .5, h: 1 }, alt_text: 'Second only' })], true);
  expect((await out.zip.file('ppt/slides/slide1.xml')!.async('nodebuffer')).equals(await out.before.file('ppt/slides/slide1.xml')!.async('nodebuffer'))).toBe(true);
  const logical = out.page.records.filter(item => item.kind === 'object' && item.record.object_kind === 'pic');
  expect(logical.filter(item => item.id.startsWith('S1')).map(item => item.record.part_ref)).not.toContain(logical.find(item => item.id === 'S2-O1').record.part_ref);
  const newSlide = Object.keys(out.zip.files).find(name => name.startsWith('ppt/slides/unode-') && name.endsWith('.xml'))!;
  const actual = await picture(out.zip, newSlide); expect(actual.elements.find(item => item.name === 'srcRect')!.attrs).toEqual({ l: '50000', t: '0', r: '0', b: '0' });
  expect(actual.elements.find(item => item.name === 'cNvPr')!.attrs.descr).toBe('Second only');
});
it('decodes an orientation-correct full JPEG rendition and identifies both source and embedded hashes', async () => {
  const bytes = withExifOrientation(6); const h = await host(bytes, true); const out = await edited(h, [imageEdit(h.id)]); const actual = await picture(out.zip);
  expect(actual.media.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(out.result.output).toContain(sha(bytes)); expect(out.result.output).toContain(sha(actual.media)); expect(out.result.output).toContain('orientation 6');
});
it('uses decoded dimensions to budget a highly compressed 5K image replacement', async () => {
  const png = solidScreenshotPng(5120, 2880); const h = await host(png); const out = await edited(h, [imageEdit(h.id)]);
  expect((await picture(out.zip)).media.equals(png)).toBe(true); expect(out.result.output).toContain('5120×2880');
});
it('applies image and text edits sequentially on the isolated current slide', async () => {
  const h = await host(); const out = await edited(h, [imageEdit(h.id, { target_ref: 'S2-O1', fit: 'cover' }),
    { op: 'replace_text', target_ref: 'S2-O3', find: 'Preserved text', replace: 'Changed after picture' },
    imageEdit(h.id, { target_ref: 'S2-O2', alt_text: 'Other replacement' })], true);
  expect(out.page.records.find(item => item.id === 'S1-O3').record.text).toBe('Preserved text');
  expect(out.page.records.find(item => item.id === 'S2-O3').record.text).toBe('Changed after picture');
  expect(out.result.output).toContain('placements 2');
});
it.each(['damaged', 'ungranted', 'revoked', 'bad-receipt', 'bad-crop'])('preserves an existing destination for %s image input', async issue => {
  const bytes = Buffer.from(PRESENTATION_PNG); if (issue === 'damaged') bytes[bytes.length - 1] ^= 1;
  const h = await host(bytes); await fs.writeFile(join(h.root, 'source.pptx'), await source()); const page = await inspect(h, 'source.pptx');
  await fs.writeFile(join(h.root, 'existing.pptx'), 'USER FILE');
  if (issue === 'revoked' || issue === 'bad-receipt') {
    const real = h.editor.edit.bind(h.editor); vi.spyOn(h.editor, 'edit').mockImplementation(async (...args) => {
      const result = await real(...args); if (issue === 'revoked') h.tools.setDelegationContentSources([]);
      else result.images![0].sha256 = '0'.repeat(64); return result;
    });
  }
  const result = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: page.snapshot, path: 'existing.pptx',
    edits: [imageEdit(issue === 'ungranted' ? 'guessed-image-ref' : h.id, issue === 'bad-crop' ? { crop: { x: .9, y: 0, w: .5, h: 1 } } : {})] });
  expect(result.status, result.output).not.toBe('success'); expect(await fs.readFile(join(h.root, 'existing.pptx'), 'utf8')).toBe('USER FILE'); expect(h.text.list()).toEqual([]);
});
