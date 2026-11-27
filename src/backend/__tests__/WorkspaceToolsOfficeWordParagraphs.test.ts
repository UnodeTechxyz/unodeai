import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { WorkspaceTools } from '../WorkspaceTools';
import { officeRouteReader, officeRouteEditor } from './officeInventoryRouteFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { validateDocumentRequest } from '../../content/document/DocumentValidation';
import { docxPackageMembers } from '../../content/document/DocxRenderer';
import { officeXmlElements } from '../../office/OfficeXmlElements';
import { validateOfficeEditRequest } from '../../office/OfficeEditContracts';
const owned: Array<Awaited<ReturnType<typeof host>>> = [];
afterEach(async () => { for (const h of owned.splice(0)) { h.tools.retire(); await h.reader.dispose(); } await removeTemporaryFolders(); });
async function host() {
  const root = await temporaryFolder('unode-word-paragraph-'); const reader = await officeRouteReader(); const editor = await officeRouteEditor();
  const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'agent'); tools.setOfficeReader(reader); tools.setOfficeEditor(editor); tools.setOfficeAuthoring(() => ({ trackChangesDefault: false, authorName: '', memberName: 'agent' })); tools.beginTurn(); const h = { root, reader, editor, tools }; owned.push(h); return h;
}
async function fixture() {
  const canonical = validateDocumentRequest({ schema_version: 1, path: 'source.docx', format: 'docx', template: 'report-v1', document: { title: 'Original title', language: 'en', blocks: [
    { type: 'heading', level: 1, content: [{ text: 'Anchor heading' }] }, { type: 'paragraph', content: [{ text: 'Original last' }] }, { type: 'table', headers: ['Header'], rows: [['Cell']] },
  ] } });
  const zip = new JSZip(); for (const [name, xml] of docxPackageMembers(canonical)) zip.file(name, xml); zip.file('custom/keep.bin', Buffer.from([0, 255, 3])); return zip;
}
async function inventory(h: Awaited<ReturnType<typeof host>>, path = 'source.docx') {
  const records: any[] = []; let cursor: string | undefined;
  for (let count = 0; count < 100; count++) { const result = await h.tools.run('inspect_office', { path, ...(cursor ? { cursor } : {}) }); expect(result.status, result.output).toBe('success'); const page = JSON.parse(result.output); records.push(...page.prepared_fragments); if (!page.next_cursor) return { records, snapshot: page.snapshot_ref }; cursor = page.next_cursor; }
  throw new Error('inventory did not finish');
}
async function prepare(supplied?: JSZip) {
  const h = await host(); const zip = supplied ?? await fixture(); const bytes = await zip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(join(h.root, 'source.docx'), bytes); return { h, bytes, initial: await inventory(h) };
}
const insert = (target_ref: string, paragraphs: string[], position?: string) => ({ op: 'insert_paragraphs', target_ref, paragraphs, ...(position ? { position } : {}) });
const save = (p: Awaited<ReturnType<typeof prepare>>, edits: unknown[]) => p.h.tools.run('edit_office', { schema_version: 1, snapshot_ref: p.initial.snapshot, path: 'output.docx', edits });
const ref = (p: Awaited<ReturnType<typeof prepare>>, text: string) => p.initial.records.find(record => record.kind === 'paragraph' && record.record.text === text).id;
async function output(p: Awaited<ReturnType<typeof prepare>>) {
  const bytes = await fs.readFile(join(p.h.root, 'output.docx')); const zip = await JSZip.loadAsync(bytes); const original = await JSZip.loadAsync(p.bytes);
  expect(Object.keys(zip.files).sort()).toEqual(Object.keys(original.files).sort()); for (const [name, entry] of Object.entries(original.files)) if (!entry.dir && name !== 'word/document.xml') expect((await zip.file(name)!.async('nodebuffer')).equals(await entry.async('nodebuffer')), name).toBe(true);
  expect((await fs.readFile(join(p.h.root, 'source.docx'))).equals(p.bytes)).toBe(true); return { zip, bytes, inventory: await inventory(p.h, 'output.docx') };
}
it('registered Word insertion saves literal paragraphs with native breaks/tabs and inherited heading formatting', async () => {
  const p = await prepare(); const result = await save(p, [insert(ref(p, 'Anchor heading'), ['New <&>\r\n中文\tvalue', ''])]); expect(result.status, result.output).toBe('success'); expect(result.output).toContain('Inserted 2 Word paragraphs after'); expect(result.output).toContain('Matched text spans: 0');
  const out = await output(p); const paragraphs = out.inventory.records.filter(record => record.kind === 'paragraph' && !record.record.story); expect(paragraphs.map(record => record.record.text)).toEqual(['Original title', 'Anchor heading', 'New <&>\n中文\tvalue', '', 'Original last', 'Header', 'Cell']);
  const xml = await out.zip.file('word/document.xml')!.async('nodebuffer'); const elements = officeXmlElements(xml, () => {}).elements.filter(element => element.tag.local === 'p');
  for (const index of [2, 3]) { expect(elements[index].children.find(element => element.tag.local === 'pPr')!.children[0].tag.attributes['w:val'].value).toBe('Heading1'); expect(elements[index].children.find(element => element.tag.local === 'r')!.children.find(element => element.tag.local === 'rPr')!.children.some(element => element.tag.local === 'b')).toBe(true); }
});
it('repeated before/after inserts keep original paragraph and cell selectors through subsequent text edits', async () => {
  const p = await prepare(); const heading = ref(p, 'Anchor heading'); const cell = ref(p, 'Cell'); const last = ref(p, 'Original last'); const cellRef = p.initial.records.find(record => record.kind === 'paragraph' && record.id === cell).record.cell_ref;
  const result = await save(p, [insert(heading, ['Before heading'], 'before'), insert(cell, ['Before cell'], 'before'), { op: 'replace_text', target_ref: heading, find: 'Anchor heading', replace: 'Original heading changed' }, insert(heading, ['After heading']), { op: 'replace_text', target_ref: last, find: 'Original last', replace: 'Original last changed' }, { op: 'replace_text', target_ref: cellRef, find: 'Cell', replace: 'Cell changed' }]);
  expect(result.status, result.output).toBe('success'); const out = await output(p); expect(out.inventory.records.filter(record => record.kind === 'paragraph' && !record.record.story).map(record => record.record.text)).toEqual(['Original title', 'Before heading', 'Original heading changed', 'After heading', 'Original last changed', 'Header', 'Before cell', 'Cell changed']);
});
it('inserts beside an empty self-closing paragraph without requiring text or a preexisting run', async () => {
  const zip = await fixture(); zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr/></w:body></w:document>');
  const p = await prepare(zip); const result = await save(p, [insert('D1', ['First usable text'])]); expect(result.status, result.output).toBe('success'); const out = await output(p); expect(out.inventory.records.filter(record => record.kind === 'paragraph' && !record.record.story).map(record => record.record.text)).toEqual(['', 'First usable text']);
});
it('F1 keeps paragraph tab-stop formatting separate from inserted literal Tab text', async () => {
  const zip = await fixture(); zip.file('word/document.xml', (await zip.file('word/document.xml')!.async('string')).replace('<w:pStyle w:val="Heading1"/>', '<w:pStyle w:val="Heading1"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="5000"/></w:tabs>'));
  const p = await prepare(zip); const result = await save(p, [insert(ref(p, 'Anchor heading'), ['Actual\ttext'])]); expect(result.status, result.output).toBe('success'); const out = await output(p);
  expect(out.inventory.records.filter(record => record.kind === 'paragraph' && !record.record.story).map(record => record.record.text)).toContain('Actual\ttext');
  expect((await out.zip.file('word/document.xml')!.async('string')).match(/w:leader="dot"/g)).toHaveLength(2);
});
it('F2 leaves paragraph-mark revision history only on the original paragraph', async () => {
  const zip = await fixture(); zip.file('word/document.xml', (await zip.file('word/document.xml')!.async('string')).replace('<w:pStyle w:val="Heading1"/>', '<w:pStyle w:val="Heading1"/><w:rPr><w:b/><w:ins w:id="9" w:author="Original author" w:date="2026-11-19T00:00:00Z"/><w:rPrChange w:id="10" w:author="Old author"><w:rPr><w:i/></w:rPr></w:rPrChange></w:rPr>'));
  const p = await prepare(zip); const result = await save(p, [insert(ref(p, 'Anchor heading'), ['New paragraph', 'Second new'])]); expect(result.status, result.output).toBe('success'); const out = await output(p); const bytes = await out.zip.file('word/document.xml')!.async('nodebuffer'); const xml = bytes.toString();
  expect(xml.match(/w:id="9"/g)).toHaveLength(1); expect(xml.match(/w:id="10"/g)).toHaveLength(1);
  const paragraphs = officeXmlElements(bytes, () => {}).elements.filter(element => element.tag.local === 'p');
  for (const index of [2, 3]) {
    const mark = paragraphs[index].children.find(element => element.tag.local === 'pPr')!.children.find(element => element.tag.local === 'rPr')!;
    expect(mark.children.map(element => element.tag.local)).toEqual(['b']);
  }
});
it.each(['identity', 'strict-utf16', 'nested'])('preserves original %s content while inserting new paragraphs', async mode => {
  const zip = await fixture(); let xml = await zip.file('word/document.xml')!.async('string');
  if (mode === 'identity') xml = xml.replace('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>', '<w:p xmlns:w14="urn:identity" w14:paraId="12345678"><w:pPr><w:pStyle w:val="Heading1"/><w:sectPr><w:pgSz w:w="10000"/></w:sectPr></w:pPr><w:bookmarkStart w:id="7" w:name="Original bookmark"/><w:bookmarkEnd w:id="7"/>');
  if (mode === 'nested') xml = xml.replace('Anchor heading</w:t>', 'Anchor heading</w:t><w:drawing><w:txbxContent><w:p><w:r><w:t>Nested text</w:t></w:r></w:p></w:txbxContent></w:drawing>');
  if (mode === 'strict-utf16') xml = xml.replaceAll('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main').replace(/encoding="UTF-8"/i, 'encoding="UTF-16"');
  zip.file('word/document.xml', mode === 'strict-utf16' ? Buffer.concat([Buffer.from([255, 254]), Buffer.from(xml, 'utf16le')]) : xml);
  const p = await prepare(zip); const result = await save(p, [insert(ref(p, 'Anchor heading'), ['Inserted text']), { op: 'replace_text', target_ref: ref(p, 'Original last'), find: 'Original last', replace: 'Last changed' }]); expect(result.status, result.output).toBe('success'); const out = await output(p); const bytes = await out.zip.file('word/document.xml')!.async('nodebuffer'); const actual = mode === 'strict-utf16' ? bytes.subarray(2).toString('utf16le') : bytes.toString();
  expect(out.inventory.records.filter(record => record.kind === 'paragraph' && !record.record.story).map(record => record.record.text)).toContain('Last changed');
  if (mode === 'identity') { expect(actual.match(/paraId=/g)).toHaveLength(1); expect(actual.match(/bookmarkStart/g)).toHaveLength(1); expect(actual.match(/<w:sectPr/g)).toHaveLength(2); }
  if (mode === 'strict-utf16') expect([...bytes.subarray(0, 2)]).toEqual([255, 254]);
  if (mode === 'nested') expect(out.inventory.records.filter(record => record.kind === 'paragraph' && !record.record.story).map(record => record.record.text).slice(1, 4)).toEqual(['Nested text', 'Anchor heading', 'Inserted text']);
});
it.each(['bad-fact', 'late-off', 'wrong-target', 'stale-source'])('withholds %s without changing an existing destination', async mode => {
  const p = await prepare(); const prior = Buffer.from('Existing destination'); await fs.writeFile(join(p.h.root, 'output.docx'), prior);
  if (mode === 'bad-fact' || mode === 'late-off') { const real = p.h.editor.edit.bind(p.h.editor); vi.spyOn(p.h.editor, 'edit').mockImplementation(async (...args) => { const result = await real(...args); if (mode === 'bad-fact') result.insertedParagraphs![0].paragraphs++; else (p.h.tools as any).allowedTools.delete('write'); return result; }); }
  if (mode === 'stale-source') await fs.appendFile(join(p.h.root, 'source.docx'), 'changed');
  const result = await save(p, [insert(mode === 'wrong-target' ? 'D99' : ref(p, 'Anchor heading'), ['Insert'])]); expect(result.status).not.toBe('success'); expect((await fs.readFile(join(p.h.root, 'output.docx'))).equals(prior)).toBe(true);
});
it.each([{ paragraphs: [] }, { paragraphs: [1] }, { paragraphs: ['\ud800'] }, { paragraphs: ['\u0001'] }, { target_ref: 'S1' }, { position: 'inside' }, { raw_xml: '<w:p/>' }])('rejects invalid typed paragraph input %j', extra => {
  expect(() => validateOfficeEditRequest({ schema_version: 1, path: 'output.docx', snapshot_ref: 'office-11111111-1111-1111-1111-111111111111', edits: [{ op: 'insert_paragraphs', target_ref: 'D1', paragraphs: ['Text'], ...extra }] })).toThrow('invalid-office-edits');
});
