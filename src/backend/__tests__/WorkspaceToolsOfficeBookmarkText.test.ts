import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { WorkspaceTools } from '../WorkspaceTools';
import { officeRouteReader, officeRouteEditor, officeRouteDocument } from './officeInventoryRouteFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { validateOfficeEditRequest } from '../../office/OfficeEditContracts';
const owned: Array<Awaited<ReturnType<typeof prepare>>> = [];
afterEach(async () => { for (const p of owned.splice(0)) { p.tools.retire(); await p.reader.dispose(); } await removeTemporaryFolders(); });
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function prepare(mode = 'ordinary') {
  const root = await temporaryFolder('unode-bookmark-text-'); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'agent'); tools.setOfficeReader(reader); tools.setOfficeEditor(editor); tools.setOfficeAuthoring(() => ({ trackChangesDefault: false, authorName: '', memberName: 'agent' })); tools.beginTurn();
  const start = '<w:bookmarkStart w:id="7" w:name="Customer"/>'; const end = '<w:bookmarkEnd w:id="7"/>';
  const runs = '<w:r><w:rPr><w:b/></w:rPr><w:t>Sa</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>me</w:t></w:r>';
  let body = `<w:p><w:r><w:t>Same</w:t></w:r>${start}${runs}${end}<w:r><w:t>Same</w:t></w:r></w:p>`;
  if (mode === 'empty-inline') body = `<w:p><w:r><w:t>Same</w:t></w:r>${start}${end}</w:p>`;
  if (mode === 'empty-body') body = start + end;
  if (mode === 'paragraph') body = `${start}<w:p><w:pPr><w:tabs><w:tab w:pos="4000"/></w:tabs></w:pPr>${runs}</w:p>${end}`;
  if (mode === 'cross-parent') body = `<w:p>${start}${runs}</w:p><w:p>${end}</w:p>`;
  if (mode === 'multi-paragraph') body = `${start}<w:p>${runs}</w:p><w:p>${runs}</w:p>${end}`;
  if (mode === 'unpaired') body = `<w:p>${start}${runs}</w:p>`;
  if (mode === 'column') body = body.replace('w:name="Customer"', 'w:name="Customer" w:colFirst="0" w:colLast="1"');
  if (mode === 'field') body = `<w:p>${start}<w:fldSimple w:instr="DATE">${runs}</w:fldSimple>${end}</w:p>`;
  if (mode === 'bound') body = `<w:sdt><w:sdtPr><w:showingPlcHdr/><w:dataBinding w:storeItemID="{ABC}" w:xpath="/root/value"/></w:sdtPr><w:sdtContent>${body}</w:sdtContent></w:sdt>`;
  let xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${body}<w:p><w:r><w:t>Original after</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`;
  if (mode.startsWith('strict')) xml = xml.replaceAll(W, 'http://purl.oclc.org/ooxml/wordprocessingml/main').replace('encoding="UTF-8"', 'encoding="UTF-16"');
  const encoded = Buffer.from(xml, mode.startsWith('strict') ? 'utf16le' : 'utf8'); const zip = await JSZip.loadAsync(await officeRouteDocument()); zip.file('word/document.xml', mode === 'strict-be' ? Buffer.concat([Buffer.from([254, 255]), encoded.swap16()]) : mode === 'strict-le' ? Buffer.concat([Buffer.from([255, 254]), encoded]) : encoded); zip.file('customXml/item1.xml', '<root><value>Unchanged</value></root>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(join(root, 'source.docx'), bytes);
  const p = { root, reader, editor, tools, bytes, mode }; owned.push(p); return p;
}
async function inspect(p: Awaited<ReturnType<typeof prepare>>, path = 'source.docx') {
  const records: any[] = []; let cursor: string | undefined;
  for (let count = 0; count < 100; count++) { const result = await p.tools.run('inspect_office', { path, ...(cursor ? { cursor } : {}) }); expect(result.status, result.output).toBe('success'); const page = JSON.parse(result.output); records.push(...page.prepared_fragments); if (!page.next_cursor) return { records, snapshot: page.snapshot_ref }; cursor = page.next_cursor; } throw new Error('inventory did not finish');
}
const assign = (text: string) => ({ op: 'set_bookmark_text', target_ref: 'B1', text });
async function save(p: Awaited<ReturnType<typeof prepare>>, text: string, later = true) { const initial = await inspect(p); return p.tools.run('edit_office', { schema_version: 1, snapshot_ref: initial.snapshot, path: 'output.docx', edits: [assign(text), ...(later ? [{ op: 'replace_text', target_ref: initial.records.find(record => record.kind === 'paragraph' && record.record.text === 'Original after').id, find: 'Original after', replace: 'Original after changed' }] : [])] }); }
async function output(p: Awaited<ReturnType<typeof prepare>>) {
  const bytes = await fs.readFile(join(p.root, 'output.docx')); const zip = await JSZip.loadAsync(bytes); const source = await JSZip.loadAsync(p.bytes); expect(Object.keys(zip.files).sort()).toEqual(Object.keys(source.files).sort()); for (const [name, entry] of Object.entries(source.files)) if (!entry.dir && name !== 'word/document.xml') expect((await zip.file(name)!.async('nodebuffer')).equals(await entry.async('nodebuffer')), name).toBe(true);
  expect((await fs.readFile(join(p.root, 'source.docx'))).equals(p.bytes)).toBe(true); const part = await zip.file('word/document.xml')!.async('nodebuffer'); const xml = p.mode === 'strict-be' ? Buffer.from(part.subarray(2)).swap16().toString('utf16le') : p.mode === 'strict-le' ? part.subarray(2).toString('utf16le') : part.toString(); expect(xml).not.toContain('data-unode-private'); expect(xml).not.toContain('unodeBookmark'); return { bytes, xml, part, records: (await inspect(p, 'output.docx')).records };
}
it.each(['ordinary', 'strict-le', 'strict-be', 'empty-inline', 'empty-body', 'paragraph', 'bound'])('registered bookmark whole assignment handles %s and later original D refs', async mode => {
  const p = await prepare(mode); const result = await save(p, 'Filled <&>\r\n中文\tvalue'); expect(result.status, result.output).toBe('success'); expect(result.output).toContain('Assigned stored bookmark text B1'); const out = await output(p); expect(out.records.find(record => record.kind === 'bookmark' && record.id === 'B1').record).toMatchObject({ text: 'Filled <&>\n中文\tvalue', name: 'Customer', paired: true }); expect(out.records.some(record => record.kind === 'paragraph' && record.record.text === 'Original after changed')).toBe(true); expect(out.xml).toContain('w:bookmarkEnd w:id="7"');
  if (['ordinary', 'strict-le', 'strict-be', 'bound'].includes(mode)) { expect(out.xml.match(/<w:t>Same<\/w:t>/g)).toHaveLength(2); expect(out.xml).toContain('<w:b/>'); expect(out.xml).toContain('<w:i/>'); }
  if (mode === 'bound') { expect(out.xml).toContain('<w:showingPlcHdr/>'); expect(out.xml).toContain('w:xpath="/root/value"'); expect(result.output).toContain('binding data and native fields were not refreshed'); }
  if (mode.startsWith('strict')) expect([...out.part.subarray(0, 2)]).toEqual(mode === 'strict-be' ? [254, 255] : [255, 254]);
});
it('clears a bookmark value while preserving its boundaries and outside duplicate text', async () => { const p = await prepare(); const result = await save(p, ''); expect(result.status, result.output).toBe('success'); const out = await output(p); expect(out.records.find(record => record.kind === 'bookmark').record.text).toBe(''); expect(out.xml.match(/<w:t>Same<\/w:t>/g)).toHaveLength(2); });
it('same rich bookmark value preserves exact ZIP bytes', async () => { const p = await prepare(); const result = await save(p, 'Same', false); expect(result.status, result.output).toBe('success'); expect((await fs.readFile(join(p.root, 'output.docx'))).equals(p.bytes)).toBe(true); });
it.each(['cross-parent', 'multi-paragraph', 'unpaired', 'column', 'field', 'bad-fact', 'late-off'])('withholds %s without changing an existing destination', async mode => {
  const p = await prepare(mode); const prior = Buffer.from('Existing destination'); await fs.writeFile(join(p.root, 'output.docx'), prior);
  if (mode === 'bad-fact' || mode === 'late-off') { const real = p.editor.edit.bind(p.editor); vi.spyOn(p.editor, 'edit').mockImplementation(async (...args) => { const result = await real(...args); if (mode === 'bad-fact') result.bookmarkTexts![0].characters++; else (p.tools as any).allowedTools.delete('write'); return result; }); }
  const result = await save(p, 'New value'); expect(result.status).not.toBe('success'); if (['cross-parent', 'multi-paragraph', 'field'].includes(mode)) { expect(result.officeEdit?.code).toBe('unsupported-bookmark-text'); expect(result.output).toContain('paragraph_refs/cell_ref'); } expect((await fs.readFile(join(p.root, 'output.docx'))).equals(prior)).toBe(true);
});
it.each([{ target_ref: 'C1' }, { text: 1 }, { text: '\ud800' }, { text: '\u0001' }, { raw_xml: '<w:t/>' }])('rejects invalid typed whole-bookmark assignment %j', extra => { expect(() => validateOfficeEditRequest({ schema_version: 1, path: 'output.docx', snapshot_ref: 'office-11111111-1111-1111-1111-111111111111', edits: [{ ...assign('Value'), ...extra }] })).toThrow('invalid-office-edits'); });
