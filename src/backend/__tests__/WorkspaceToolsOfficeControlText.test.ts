import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { WorkspaceTools } from '../WorkspaceTools';
import { officeRouteReader, officeRouteEditor, officeRouteDocument } from './officeInventoryRouteFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { validateOfficeEditRequest } from '../../office/OfficeEditContracts';
const owned: Array<Awaited<ReturnType<typeof host>>> = [];
afterEach(async () => { for (const h of owned.splice(0)) { h.tools.retire(); await h.reader.dispose(); } await removeTemporaryFolders(); });
async function host() { const root = await temporaryFolder('unode-control-text-'); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'agent'); tools.setOfficeReader(reader); tools.setOfficeEditor(editor); tools.setOfficeAuthoring(() => ({ trackChangesDefault: false, authorName: '', memberName: 'agent' })); tools.beginTurn(); const h = { root, reader, editor, tools }; owned.push(h); return h; }
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function fixture(mode = 'ordinary') {
  const zip = await JSZip.loadAsync(await officeRouteDocument()); const props = '<w:sdtPr><w:id w:val="23"/><w:alias w:val="Customer"/><w:lock w:val="sdtLocked"/><w:showingPlcHdr/><w:text/></w:sdtPr>';
  const value = '<w:p w:rsidR="ABCD"><w:pPr><w:pStyle w:val="Normal"/><w:tabs><w:tab w:pos="4000"/></w:tabs></w:pPr><w:bookmarkStart w:id="7" w:name="Keep"/><w:r><w:rPr><w:b/></w:rPr><w:t>Old</w:t><w:tab/><w:t>value</w:t><w:br/><w:t>tail</w:t></w:r><w:bookmarkEnd w:id="7"/></w:p>';
  let control = `<w:sdt>${props}<w:sdtContent>${value}</w:sdtContent></w:sdt>`;
  if (mode === 'empty-content') control = `<w:sdt>${props}<w:sdtContent/></w:sdt>`;
  if (mode === 'missing-content') control = `<w:sdt>${props}</w:sdt>`;
  if (mode === 'empty-control') control = '<w:sdt/>';
  if (mode === 'empty-paragraph') control = `<w:sdt>${props}<w:sdtContent><w:p/></w:sdtContent></w:sdt>`;
  if (mode === 'inline') control = `<w:p><w:r><w:t>Outside</w:t></w:r><w:sdt>${props}<w:sdtContent><w:r/></w:sdtContent></w:sdt></w:p>`;
  if (mode === 'bound') control = control.replace('</w:sdtPr>', '<w:dataBinding w:storeItemID="{ABC}" w:xpath="/root/value"/></w:sdtPr>');
  if (mode === 'matching' || mode === 'noop') control = `<w:sdt>${mode === 'noop' ? props.replace('<w:showingPlcHdr/>', '') : props}<w:sdtContent><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>A</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>B</w:t></w:r></w:p></w:sdtContent></w:sdt>`;
  if (mode === 'complex') control = `<w:sdt>${props}<w:sdtContent><w:p><w:r><w:t>First</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:sdtContent></w:sdt>`;
  if (mode === 'date') control = control.replace('<w:text/>', '<w:date w:fullDate="2026-11-19T00:00:00Z"/>');
  if (mode === 'checkbox') control = control.replace('<w:text/>', '<w14:checkbox xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w14:checked w14:val="0"/></w14:checkbox>');
  if (mode === 'repeating') control = control.replace('<w:text/>', '<w15:repeatingSection xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"/>');
  if (mode === 'vendor') control = control.replace('<w:sdtPr>', '<w:sdtPr xmlns:v="urn:vendor" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="v"><v:date/>');
  if (mode === 'default-style') control = `<w:sdt><w:sdtPr xmlns:q="${W}"><w:rPr><q:b/><w:rPrChange w:id="9" w:author="Old"><w:rPr/></w:rPrChange></w:rPr><w:showingPlcHdr/></w:sdtPr><w:sdtContent/></w:sdt>`;
  let xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${control}<w:p><w:r><w:t>Original after</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`;
  if (mode === 'strict') xml = xml.replaceAll(W, 'http://purl.oclc.org/ooxml/wordprocessingml/main').replace('encoding="UTF-8"', 'encoding="UTF-16"');
  zip.file('word/document.xml', mode === 'strict' ? Buffer.concat([Buffer.from([255, 254]), Buffer.from(xml, 'utf16le')]) : xml); zip.file('customXml/item1.xml', '<root><value>Unchanged binding data</value></root>'); return zip.generateAsync({ type: 'nodebuffer' });
}
async function inventory(h: Awaited<ReturnType<typeof host>>, path = 'source.docx') {
  const records: any[] = []; let cursor: string | undefined;
  for (let count = 0; count < 100; count++) { const result = await h.tools.run('inspect_office', { path, ...(cursor ? { cursor } : {}) }); expect(result.status, result.output).toBe('success'); const page = JSON.parse(result.output); records.push(...page.prepared_fragments); if (!page.next_cursor) return { records, snapshot: page.snapshot_ref }; cursor = page.next_cursor; } throw new Error('inventory did not finish');
}
async function prepare(mode = 'ordinary') { const h = await host(); const bytes = await fixture(mode); await fs.writeFile(join(h.root, 'source.docx'), bytes); return { h, bytes, initial: await inventory(h) }; }
const assign = (text: string) => ({ op: 'set_control_text', target_ref: 'C1', text });
const save = (p: Awaited<ReturnType<typeof prepare>>, edits: unknown[]) => p.h.tools.run('edit_office', { schema_version: 1, snapshot_ref: p.initial.snapshot, path: 'output.docx', edits });
async function output(p: Awaited<ReturnType<typeof prepare>>) {
  const bytes = await fs.readFile(join(p.h.root, 'output.docx')); const zip = await JSZip.loadAsync(bytes); const source = await JSZip.loadAsync(p.bytes); expect(Object.keys(zip.files).sort()).toEqual(Object.keys(source.files).sort()); for (const [name, entry] of Object.entries(source.files)) if (!entry.dir && name !== 'word/document.xml') expect((await zip.file(name)!.async('nodebuffer')).equals(await entry.async('nodebuffer')), name).toBe(true);
  expect((await fs.readFile(join(p.h.root, 'source.docx'))).equals(p.bytes)).toBe(true); return { bytes, zip, inventory: await inventory(p.h, 'output.docx') };
}
it.each(['ordinary', 'strict', 'empty-content', 'missing-content', 'empty-control', 'empty-paragraph', 'inline'])('registered whole assignment handles %s, native controls, placeholder flag and later original paragraph edits', async mode => {
  const p = await prepare(mode); const later = p.initial.records.find(record => record.kind === 'paragraph' && record.record.text === 'Original after').id;
  const result = await save(p, [assign('Filled <&>\r\n中文\tvalue'), { op: 'replace_text', target_ref: later, find: 'Original after', replace: 'Original after changed' }]); expect(result.status, result.output).toBe('success'); expect(result.output).toContain('Assigned stored control text C1'); const out = await output(p);
  expect(out.inventory.records.find(record => record.id === 'C1' && record.kind === 'content-control').record.text).toBe('Filled <&>\n中文\tvalue'); expect(out.inventory.records.some(record => record.kind === 'paragraph' && record.record.text === 'Original after changed')).toBe(true);
  const bytes = await out.zip.file('word/document.xml')!.async('nodebuffer'); const xml = mode === 'strict' ? bytes.subarray(2).toString('utf16le') : bytes.toString(); expect(xml).not.toContain('showingPlcHdr'); if (mode === 'ordinary' || mode === 'strict') { expect(xml).toContain('w:name="Keep"'); expect(xml).toContain('<w:b/>'); expect(xml).toContain('w:lock w:val="sdtLocked"'); }
  if (mode === 'strict') expect([...bytes.subarray(0, 2)]).toEqual([255, 254]);
});
it('clears a control value without old Tab or line-break text and retains markers', async () => {
  const p = await prepare(); const result = await save(p, [assign('')]); expect(result.status, result.output).toBe('success'); const out = await output(p); expect(out.inventory.records.find(record => record.id === 'C1').record.text).toBe(''); expect(out.inventory.records.find(record => record.id === 'B1').record.paired).toBe(true);
});
it('same visible placeholder text clears its flag without flattening rich runs', async () => {
  const p = await prepare('matching'); const result = await save(p, [assign('AB')]); expect(result.status, result.output).toBe('success'); const out = await output(p); const xml = await out.zip.file('word/document.xml')!.async('string'); expect(xml).toContain('<w:b/>'); expect(xml).toContain('<w:i/>'); expect(xml).toContain('<w:t>A</w:t>'); expect(xml).toContain('<w:t>B</w:t>'); expect(xml).not.toContain('showingPlcHdr');
});
it('exact rich-text assignment without a placeholder flag preserves the whole ZIP bytes', async () => {
  const p = await prepare('noop'); const result = await save(p, [assign('AB')]); expect(result.status, result.output).toBe('success'); expect((await fs.readFile(join(p.h.root, 'output.docx'))).equals(p.bytes)).toBe(true);
});
it('inherits empty-control formatting with local namespaces but does not copy revision identities into the new run', async () => {
  const p = await prepare('default-style'); const result = await save(p, [assign('Styled value')]); expect(result.status, result.output).toBe('success'); const out = await output(p); const xml = await out.zip.file('word/document.xml')!.async('string'); expect(xml.match(/w:id="9"/g)).toHaveLength(1); expect(xml.match(/<q:b\//g)).toHaveLength(2); expect(out.inventory.records.find(record => record.kind === 'content-control').record.text).toBe('Styled value');
});
it('qualifies stored assignment to an XML-bound control and leaves its binding dataset untouched', async () => {
  const p = await prepare('bound'); const result = await save(p, [assign('Stored display value')]); expect(result.status, result.output).toBe('success'); expect(result.output).toContain('not a completed binding operation'); const out = await output(p); expect(out.inventory.records.find(record => record.kind === 'content-control').record).toMatchObject({ text: 'Stored display value', data_binding: { xpath: '/root/value' }, lock: 'sdtLocked' });
});
it('retains an unrelated vendor property with a native-type local name without refusing an ordinary text control', async () => {
  const p = await prepare('vendor'); const result = await save(p, [assign('Filled ordinary text')]); expect(result.status, result.output).toBe('success'); const out = await output(p); expect(await out.zip.file('word/document.xml')!.async('string')).toContain('<v:date/>'); expect(out.inventory.records.find(record => record.kind === 'content-control').record.text).toBe('Filled ordinary text');
});
it.each(['complex', 'date', 'checkbox', 'repeating', 'bad-fact', 'late-off'])('withholds %s whole assignment without changing an existing destination', async mode => {
  const p = await prepare(mode); const prior = Buffer.from('Existing destination'); await fs.writeFile(join(p.h.root, 'output.docx'), prior);
  if (mode === 'bad-fact' || mode === 'late-off') { const real = p.h.editor.edit.bind(p.h.editor); vi.spyOn(p.h.editor, 'edit').mockImplementation(async (...args) => { const result = await real(...args); if (mode === 'bad-fact') result.controlTexts![0].characters++; else (p.h.tools as any).allowedTools.delete('write'); return result; }); }
  const result = await save(p, [assign('New value')]); expect(result.status).not.toBe('success'); if (['complex', 'date', 'checkbox', 'repeating'].includes(mode)) { expect(result.officeEdit?.code).toBe('unsupported-control-text'); expect(result.output).toContain('paragraph_refs or cell_ref'); } expect((await fs.readFile(join(p.h.root, 'output.docx'))).equals(prior)).toBe(true);
});
it.each([{ target_ref: 'B1' }, { text: 1 }, { text: '\ud800' }, { text: '\u0001' }, { raw_xml: '<w:t/>' }])('rejects invalid typed whole-control assignment %j', extra => {
  expect(() => validateOfficeEditRequest({ schema_version: 1, path: 'output.docx', snapshot_ref: 'office-11111111-1111-1111-1111-111111111111', edits: [{ ...assign('Value'), ...extra }] })).toThrow('invalid-office-edits');
});
