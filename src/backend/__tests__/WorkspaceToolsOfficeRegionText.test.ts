import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { WorkspaceTools } from '../WorkspaceTools';
import { officeRouteReader, officeRouteEditor, officeRouteDocument } from './officeInventoryRouteFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
const owned: Array<Awaited<ReturnType<typeof host>>> = [];
afterEach(async () => { for (const h of owned.splice(0)) { h.tools.retire(); await h.reader.dispose(); } await removeTemporaryFolders(); });
async function host() {
  const root = await temporaryFolder('unode-region-text-'); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'agent'); tools.setOfficeReader(reader); tools.setOfficeEditor(editor); tools.setOfficeAuthoring(() => ({ trackChangesDefault: false, authorName: '', memberName: 'agent' })); tools.beginTurn(); const h = { root, reader, editor, tools }; owned.push(h); return h;
}
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function fixture(mode = 'normal') {
  const zip = await JSZip.loadAsync(await officeRouteDocument()); let xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>
<mc:AlternateContent><mc:Choice Requires="w"><w:p><w:bookmarkStart w:id="99" w:name="Skipped"/><w:sdt><w:sdtPr/><w:sdtContent><w:r><w:t>Skipped</w:t></w:r></w:sdtContent></w:sdt><w:bookmarkEnd w:id="99"/></w:p></mc:Choice><mc:Fallback/></mc:AlternateContent>
<w:p><w:r><w:t>Same</w:t></w:r><w:bookmarkStart w:id="7" w:name="Exact"/><w:r><w:rPr><w:b/></w:rPr><w:t>Sa</w:t></w:r><w:r><w:t>me</w:t></w:r><w:bookmarkEnd w:id="7"/><w:r><w:t>Same</w:t></w:r></w:p>
<w:sdt><w:sdtPr><w:id w:val="3"/><w:alias w:val="Outer"/><w:dataBinding w:storeItemID="{ABC}" w:xpath="/root/value"/><w:showingPlcHdr/><w:lock w:val="sdtLocked"/></w:sdtPr><w:sdtContent><w:p><w:pPr><w:tabs><w:tab w:pos="4000"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">Outer </w:t></w:r><w:sdt><w:sdtPr><w:id w:val="4"/><w:alias w:val="Inner"/></w:sdtPr><w:sdtContent><w:r><w:t>Nested</w:t></w:r></w:sdtContent></w:sdt></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:sdtContent></w:sdt><w:p><w:r><w:t>Same</w:t></w:r></w:p></w:body></w:document>`;
  if (mode === 'unpaired') xml = xml.replace('<w:bookmarkEnd w:id="7"/>', '');
  if (mode === 'column') xml = xml.replace('w:name="Exact"', 'w:name="Exact" w:colFirst="0" w:colLast="1"');
  if (mode === 'strict') xml = xml.replaceAll(W, 'http://purl.oclc.org/ooxml/wordprocessingml/main').replace('encoding="UTF-8"', 'encoding="UTF-16"');
  zip.file('word/document.xml', mode === 'strict' ? Buffer.concat([Buffer.from([255, 254]), Buffer.from(xml, 'utf16le')]) : xml); zip.file('customXml/item1.xml', '<root><value>Unchanged bound value</value></root>'); return zip.generateAsync({ type: 'nodebuffer' });
}
async function inventory(h: Awaited<ReturnType<typeof host>>, path = 'source.docx') {
  const records: any[] = []; let cursor: string | undefined;
  for (let count = 0; count < 100; count++) { const result = await h.tools.run('inspect_office', { path, ...(cursor ? { cursor } : {}) }); expect(result.status, result.output).toBe('success'); const page = JSON.parse(result.output); records.push(...page.prepared_fragments); if (!page.next_cursor) return { records, snapshot: page.snapshot_ref }; cursor = page.next_cursor; } throw new Error('inventory did not finish');
}
async function prepare(mode = 'normal') { const h = await host(); const bytes = await fixture(mode); await fs.writeFile(join(h.root, 'source.docx'), bytes); return { h, bytes, initial: await inventory(h) }; }
const replace = (target_ref: string, find: string, replacement: string) => ({ op: 'replace_text', target_ref, find, replace: replacement });
const save = (p: Awaited<ReturnType<typeof prepare>>, edits: unknown[]) => p.h.tools.run('edit_office', { schema_version: 1, snapshot_ref: p.initial.snapshot, path: 'output.docx', edits });
async function output(p: Awaited<ReturnType<typeof prepare>>) {
  const bytes = await fs.readFile(join(p.h.root, 'output.docx')); const zip = await JSZip.loadAsync(bytes); const source = await JSZip.loadAsync(p.bytes); expect(Object.keys(zip.files).sort()).toEqual(Object.keys(source.files).sort()); for (const [name, entry] of Object.entries(source.files)) if (!entry.dir && name !== 'word/document.xml') expect((await zip.file(name)!.async('nodebuffer')).equals(await entry.async('nodebuffer')), name).toBe(true);
  expect((await fs.readFile(join(p.h.root, 'source.docx'))).equals(p.bytes)).toBe(true); return { bytes, zip, inventory: await inventory(p.h, 'output.docx') };
}
it.each(['normal', 'strict'])('registered %s bookmark text edit is confined to the exact stored range and preserves outside duplicates/style/markers', async mode => {
  const p = await prepare(mode); const result = await save(p, [replace('B1', 'Same', 'Exact <&>\r\n中文\tvalue')]); expect(result.status, result.output).toBe('success'); const out = await output(p); expect(out.inventory.records.find(record => record.id === 'B1').record).toMatchObject({ text: 'Exact <&>\n中文\tvalue', paired: true, name: 'Exact' });
  const bytes = await out.zip.file('word/document.xml')!.async('nodebuffer'); const xml = mode === 'strict' ? bytes.subarray(2).toString('utf16le') : bytes.toString(); expect(xml.match(/<w:t>Same<\/w:t>/g)).toHaveLength(3); expect(xml).toContain('<w:b/>'); expect(xml).toContain('w:bookmarkStart w:id="7"'); expect(xml).toContain('w:bookmarkEnd w:id="7"'); if (mode === 'strict') expect([...bytes.subarray(0, 2)]).toEqual([255, 254]);
});
it('nested and outer control replacements retain binding/placeholder/lock metadata and report stored-text-only semantics', async () => {
  const p = await prepare(); const result = await save(p, [replace('C2', 'Nested', 'Only inner'), replace('C1', 'Second', 'Outer end')]); expect(result.status, result.output).toBe('success'); expect(result.output).toContain('Stored Word region text targets: C2, C1'); expect(result.output).toContain('not a completed binding or form-fill operation'); const out = await output(p);
  expect(out.inventory.records.find(record => record.id === 'C1').record).toMatchObject({ text: 'Outer Only inner\nOuter end', data_binding: { xpath: '/root/value', storeItemID: '{ABC}' }, showing_placeholder: true, lock: 'sdtLocked' }); expect(out.inventory.records.find(record => record.id === 'C2').record.text).toBe('Only inner');
  const source = await JSZip.loadAsync(p.bytes); const before = await source.file('word/document.xml')!.async('string'); const after = await out.zip.file('word/document.xml')!.async('string'); expect(after.match(/<w:sdtPr>[\s\S]*?<\/w:sdtPr>/g)).toEqual(before.match(/<w:sdtPr>[\s\S]*?<\/w:sdtPr>/g));
});
it('keeps original region refs after paragraph/table inserts and recomputes spans after earlier region edits', async () => {
  const p = await prepare(); const result = await save(p, [{ op: 'insert_paragraphs', target_ref: 'D1', position: 'before', paragraphs: ['Before original'] }, { op: 'insert_table', target_ref: 'D4', position: 'before', rows: [['New cell']] }, replace('B1', 'Same', 'Changed after inserts'), replace('C2', 'Nested', 'Changed inner'), replace('C1', 'Second', 'Changed outer')]);
  expect(result.status, result.output).toBe('success'); const out = await output(p); expect(out.inventory.records.find(record => record.id === 'B1').record.text).toBe('Changed after inserts'); expect(out.inventory.records.find(record => record.id === 'C2').record.text).toBe('Changed inner'); expect(out.inventory.records.find(record => record.id === 'C1').record.text).toBe('Outer Changed inner\nChanged outer');
});
it('keeps the whole ZIP byte-identical for an exact region no-op', async () => {
  const p = await prepare(); const result = await save(p, [replace('B1', 'Same', 'Same')]); expect(result.status, result.output).toBe('success'); expect((await fs.readFile(join(p.h.root, 'output.docx'))).equals(p.bytes)).toBe(true);
});
it.each(['paragraph-boundary', 'nested-control-boundary', 'unpaired', 'column', 'bad-fact', 'late-off', 'missing-target'])('withholds region %s without changing an existing destination', async mode => {
  const p = await prepare(mode); const prior = Buffer.from('Existing destination'); await fs.writeFile(join(p.h.root, 'output.docx'), prior);
  if (mode === 'bad-fact' || mode === 'late-off') { const real = p.h.editor.edit.bind(p.h.editor); vi.spyOn(p.h.editor, 'edit').mockImplementation(async (...args) => { const result = await real(...args); if (mode === 'bad-fact') result.regionTextEdits = []; else (p.h.tools as any).allowedTools.delete('read'); return result; }); }
  const edits = mode === 'paragraph-boundary' ? [replace('C1', 'Nested\nSecond', 'Crossing')] : mode === 'nested-control-boundary' ? [replace('C1', 'Outer Nested', 'Crossing')] : [replace(mode === 'missing-target' ? 'C99' : 'B1', 'Same', 'Changed')];
  const result = await save(p, edits); expect(result.status).not.toBe('success'); if (mode.endsWith('boundary')) expect(result.officeEdit?.code).toBe('text-match-crosses-structural-control'); if (mode === 'column' || mode === 'unpaired') { expect(result.officeEdit?.code).toBe('unsupported-word-region'); expect(result.output).toContain('paragraph_refs or cell_ref'); } expect((await fs.readFile(join(p.h.root, 'output.docx'))).equals(prior)).toBe(true);
});
