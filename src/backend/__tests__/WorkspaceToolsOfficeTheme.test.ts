import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { WorkspaceTools } from '../WorkspaceTools';
import { officeRouteReader, officeRouteEditor, officeRouteDocument } from './officeInventoryRouteFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { officeXmlElements } from '../../office/OfficeXmlElements';
import { validateOfficeEditRequest } from '../../office/OfficeEditContracts';

const owned: Array<Awaited<ReturnType<typeof host>>> = [];
afterEach(async () => { for (const h of owned.splice(0)) { h.tools.retire(); await h.reader.dispose(); } await removeTemporaryFolders(); });
async function host() {
  const root = await temporaryFolder('unode-theme-'); const reader = await officeRouteReader(); const editor = await officeRouteEditor();
  const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'agent'); tools.setOfficeReader(reader); tools.setOfficeEditor(editor); tools.setOfficeAuthoring(() => ({ trackChangesDefault: false, authorName: '', memberName: 'agent' })); tools.beginTurn();
  const h = { root, reader, editor, tools }; owned.push(h); return h;
}
async function inventory(h: Awaited<ReturnType<typeof host>>, path = 'source.pptx') {
  const records: any[] = []; let cursor: string | undefined;
  for (let count = 0; count < 100; count++) {
    const result = await h.tools.run('inspect_office', { path, ...(cursor ? { cursor } : {}) }); expect(result.status, result.output).toBe('success');
    const page = JSON.parse(result.output); records.push(...page.prepared_fragments); if (!page.next_cursor) return { snapshot: page.snapshot_ref, records }; cursor = page.next_cursor;
  }
  throw new Error('inventory did not finish');
}
async function fixture() {
  const deck = new PptxGenJS(); deck.addSlide().addText('Hardcoded title', { x: 1, y: 1, w: 5, h: 1, color: 'FF0000', fontFace: 'Arial' });
  deck.addSlide().addText('Other slide', { x: 1, y: 1, w: 4, h: 1 });
  const zip = await JSZip.loadAsync(await deck.write({ outputType: 'nodebuffer' }) as Buffer); zip.file('custom/keep.bin', Buffer.from([0, 255, 3]));
  zip.file('ppt/theme/theme2.xml', await zip.file('ppt/theme/theme1.xml')!.async('nodebuffer'));
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('</Types>', '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>'));
  return zip;
}
async function prepare(supplied?: JSZip, path = 'source.pptx') {
  const zip = supplied ?? await fixture();
  const h = await host(); const bytes = await zip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(join(h.root, path), bytes);
  const inspected = await inventory(h, path); const themes = inspected.records.filter(record => record.kind === 'part' && record.record.content_type === 'application/vnd.openxmlformats-officedocument.theme+xml');
  return { h, bytes, inspected, themes };
}
const edit = (target_ref: string, extra: Record<string, unknown>) => ({ op: 'set_theme_tokens', target_ref, ...extra });
async function save(p: Awaited<ReturnType<typeof prepare>>, edits: unknown[], path = 'output.pptx') {
  return p.h.tools.run('edit_office', { schema_version: 1, snapshot_ref: p.inspected.snapshot, path, edits });
}
async function preserved(before: Buffer, after: Buffer, changed: string[]) {
  const source = await JSZip.loadAsync(before); const output = await JSZip.loadAsync(after);
  expect(Object.keys(output.files).sort()).toEqual(Object.keys(source.files).sort());
  for (const [name, entry] of Object.entries(source.files)) if (!entry.dir && !changed.includes(name)) expect((await output.file(name)!.async('nodebuffer')).equals(await entry.async('nodebuffer')), name).toBe(true);
  return output;
}
it('registered edit_office changes selected tokens through the actual worker and save, preserving other themes and direct formatting', async () => {
  const p = await prepare(); expect(p.themes.length).toBeGreaterThan(1);
  const spec: any = p.h.tools.specs().find(tool => tool.function.name === 'edit_office'); expect(spec.function.parameters.properties.edits.items.properties.op.enum).toContain('set_theme_tokens');
  const fonts = { major: { latin: 'A&B "<字体>\t', ea: '' }, minor: { cs: 'Example CS' } };
  const result = await save(p, [edit(p.themes[0].id, { colors: { accent1: 'a1b2c3', dk1: '102030' }, fonts })]);
  expect(result.status, result.output).toBe('success'); expect(result.output).toContain('Matched text spans: 0'); expect(result.output).toContain('Set theme tokens ' + p.themes[0].id);
  expect(result.output).toContain('direct formatting may override'); expect(result.output).toContain('Font availability not checked');
  const output = await preserved(p.bytes, await fs.readFile(join(p.h.root, 'output.pptx')), ['ppt/theme/theme1.xml']);
  const xml = await output.file('ppt/theme/theme1.xml')!.async('nodebuffer'); const parsed = officeXmlElements(xml, () => {});
  expect(parsed.elements.find(element => element.tag.local === 'accent1')!.children[0].tag.attributes.val.value).toBe('A1B2C3');
  const major = parsed.elements.find(element => element.tag.local === 'majorFont')!; expect(major.children.find(element => element.tag.local === 'latin')!.tag.attributes.typeface.value).toBe(fonts.major.latin);
  expect(major.children.find(element => element.tag.local === 'ea')!.tag.attributes.typeface.value).toBe('');
  expect((await fs.readFile(join(p.h.root, 'source.pptx'))).equals(p.bytes)).toBe(true);
});
it('a matching literal theme edit keeps the entire ZIP byte-identical', async () => {
  const p = await prepare(); const zip = await JSZip.loadAsync(p.bytes); const parsed = officeXmlElements(await zip.file('ppt/theme/theme1.xml')!.async('nodebuffer'), () => {});
  const accent = parsed.elements.find(element => element.tag.local === 'accent1')!.children[0].tag.attributes.val.value;
  const latin = parsed.elements.find(element => element.tag.local === 'majorFont')!.children.find(element => element.tag.local === 'latin')!.tag.attributes.typeface.value;
  const result = await save(p, [edit(p.themes[0].id, { colors: { accent1: accent }, fonts: { major: { latin } } })]);
  expect(result.status, result.output).toBe('success'); expect((await fs.readFile(join(p.h.root, 'output.pptx'))).equals(p.bytes)).toBe(true);
});
it.each(['system', 'transforms', 'strict-utf16'])('sets literal RGB for %s theme content and keeps unrelated scheme XML', async mode => {
  const zip = await fixture(); let xml = await zip.file('ppt/theme/theme1.xml')!.async('string');
  if (mode === 'system') xml = xml.replace(/(<a:accent1>)[\s\S]*?(<\/a:accent1>)/, '$1<a:sysClr val="windowText" lastClr="A1B2C3"/>$2');
  if (mode === 'transforms') xml = xml.replace(/(<a:accent1>)[\s\S]*?(<\/a:accent1>)/, '$1<a:srgbClr val="A1B2C3"><a:alpha val="50000"/></a:srgbClr>$2');
  if (mode === 'strict-utf16') xml = xml.replaceAll('http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main').replace(/encoding="UTF-8"/i, 'encoding="UTF-16"');
  zip.file('ppt/theme/theme1.xml', mode === 'strict-utf16' ? Buffer.concat([Buffer.from([255, 254]), Buffer.from(xml, 'utf16le')]) : xml);
  const p = await prepare(zip); const result = await save(p, [edit(p.themes[0].id, { colors: { accent1: 'A1B2C3' } })]); expect(result.status, result.output).toBe('success');
  const output = await preserved(p.bytes, await fs.readFile(join(p.h.root, 'output.pptx')), ['ppt/theme/theme1.xml']); const bytes = await output.file('ppt/theme/theme1.xml')!.async('nodebuffer');
  const actual = mode === 'strict-utf16' ? bytes.subarray(2).toString('utf16le') : bytes.toString();
  expect(actual).toContain('val="A1B2C3"'); expect(actual).not.toContain('lastClr="A1B2C3"'); expect(actual).not.toContain('val="50000"');
  expect(/<a:accent2>[\s\S]*?<\/a:accent2>/.exec(actual)?.[0]).toBe(/<a:accent2>[\s\S]*?<\/a:accent2>/.exec(xml)?.[0]);
  if (mode === 'strict-utf16') expect([...bytes.subarray(0, 2)]).toEqual([255, 254]);
});
it('sequential edits read the current theme and can be combined with logical slide edits', async () => {
  const p = await prepare(); const ref = p.themes[0].id;
  const result = await save(p, [edit(ref, { colors: { accent1: 'A1B2C3' } }), { op: 'set_shape_text', target_ref: 'S1-O1', text: 'Changed title' }, edit(ref, { colors: { accent2: 'D4E5F6' }, fonts: { minor: { latin: 'Example' } } })]);
  expect(result.status, result.output).toBe('success'); const output = await preserved(p.bytes, await fs.readFile(join(p.h.root, 'output.pptx')), ['ppt/theme/theme1.xml', 'ppt/slides/slide1.xml']);
  const xml = await output.file('ppt/theme/theme1.xml')!.async('string'); expect(xml).toContain('A1B2C3'); expect(xml).toContain('D4E5F6'); expect(xml).toContain('Example'); expect(await output.file('ppt/slides/slide1.xml')!.async('string')).toContain('Changed title');
});
it('uses an inspected Word theme without changing document text or theme relationships', async () => {
  const ppt = await fixture(); const zip = await JSZip.loadAsync(await officeRouteDocument()); zip.file('word/theme/theme1.xml', await ppt.file('ppt/theme/theme1.xml')!.async('nodebuffer'));
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('</Types>', '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>'));
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="theme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>');
  const p = await prepare(zip, 'source.docx'); const result = await save(p, [edit(p.themes[0].id, { fonts: { major: { ea: '等线' } } })], 'output.docx');
  expect(result.status, result.output).toBe('success'); const output = await preserved(p.bytes, await fs.readFile(join(p.h.root, 'output.docx')), ['word/theme/theme1.xml']); expect(await output.file('word/theme/theme1.xml')!.async('string')).toContain('等线');
});
it('edits existing tokens in themeOverride and retains supplemental fonts, metadata and unselected slot XML', async () => {
  const zip = await fixture(); const theme = '<a:themeOverride xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:q="urn:keep"><a:clrScheme name="Partial"><a:accent1 q:keep="literal &gt; $&amp;"><a:srgbClr val="112233"/></a:accent1></a:clrScheme><a:fontScheme name="Keep"><a:majorFont><a:latin q:keep="x &gt; y" pitchFamily="34" typeface=\'Before\'/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="Supplemental"/></a:majorFont></a:fontScheme></a:themeOverride>';
  zip.file('ppt/theme/override.xml', theme);
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('</Types>', '<Override PartName="/ppt/theme/override.xml" ContentType="application/vnd.openxmlformats-officedocument.themeOverride+xml"/></Types>'));
  const p = await prepare(zip); const ref = p.inspected.records.find(record => record.kind === 'part' && record.record.content_type?.endsWith('themeOverride+xml')).id;
  const result = await save(p, [edit(ref, { colors: { accent1: '445566' }, fonts: { major: { latin: 'After' } } })]); expect(result.status, result.output).toBe('success');
  const output = await preserved(p.bytes, await fs.readFile(join(p.h.root, 'output.pptx')), ['ppt/theme/override.xml']); const actual = await output.file('ppt/theme/override.xml')!.async('string');
  expect(actual).toContain('q:keep="literal &gt; $&amp;"'); expect(actual).toContain('q:keep="x &gt; y" pitchFamily="34" typeface="After"'); expect(actual).toContain('<a:font script="Hans" typeface="Supplemental"/>');
});
it.each(['bad-fact', 'wrong-part', 'wrong-operation', 'late-off', 'missing-slot'])('withholds %s without changing an existing destination', async mode => {
  const zip = await fixture(); if (mode === 'missing-slot') zip.file('ppt/theme/theme1.xml', (await zip.file('ppt/theme/theme1.xml')!.async('string')).replace(/<a:accent1>[\s\S]*?<\/a:accent1>/, ''));
  const p = await prepare(zip); const before = Buffer.from('Existing user destination'); await fs.writeFile(join(p.h.root, 'output.pptx'), before);
  if (mode === 'bad-fact' || mode === 'late-off') {
    const real = p.h.editor.edit.bind(p.h.editor); vi.spyOn(p.h.editor, 'edit').mockImplementation(async (...args) => { const result = await real(...args); if (mode === 'late-off') (p.h.tools as any).allowedTools.delete('write'); else result.themes![0].colors = { accent1: '000000' }; return result; });
  }
  const edits = mode === 'wrong-operation' ? [{ op: 'replace_text', target_ref: p.themes[0].id, find: 'A', replace: 'B' }]
    : [edit(mode === 'wrong-part' ? p.inspected.records.find(record => record.kind === 'part' && record.record.main).id : p.themes[0].id, { colors: { accent1: 'A1B2C3' } })];
  const result = await save(p, edits); expect(result.status).not.toBe('success'); expect((await fs.readFile(join(p.h.root, 'output.pptx'))).equals(before)).toBe(true);
});
it.each([{ colors: {} }, { fonts: {} }, { colors: { bogus: 'AABBCC' } }, { colors: { accent1: '#AABBCC' } }, { fonts: { major: { bogus: 'Arial' } } }, { fonts: { major: {} } }, { fonts: { major: { latin: '\ud800' } } }, { colors: { accent1: 'AABBCC' }, script: 'raw' }])('rejects invalid typed theme input %j', extra => {
  expect(() => validateOfficeEditRequest({ schema_version: 1, path: 'x.pptx', snapshot_ref: 'office-11111111-1111-1111-1111-111111111111', edits: [edit('P1', extra)] })).toThrow('invalid-office-edits');
});
