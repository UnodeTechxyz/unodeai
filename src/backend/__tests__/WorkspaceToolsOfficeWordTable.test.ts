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
  const root = await temporaryFolder('unode-word-table-'); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'agent'); tools.setOfficeReader(reader); tools.setOfficeEditor(editor); tools.beginTurn(); const h = { root, reader, editor, tools }; owned.push(h); return h;
}
async function fixture() {
  const request = validateDocumentRequest({ schema_version: 1, path: 'source.docx', format: 'docx', template: 'report-v1', document: { title: 'Title', language: 'en', blocks: [
    { type: 'paragraph', content: [{ text: 'Anchor' }] }, { type: 'paragraph', content: [{ text: 'Last' }] }, { type: 'table', headers: ['H1', 'H2'], rows: [['A2', 'B2']] },
  ] } }); const zip = new JSZip(); for (const [name, xml] of docxPackageMembers(request)) zip.file(name, xml);
  zip.file('word/styles.xml', (await zip.file('word/styles.xml')!.async('string')).replace('</w:styles>', '<w:style w:type="table" w:styleId="TableCustom"><w:name w:val="Custom table"/></w:style></w:styles>')); zip.file('custom/keep.bin', Buffer.from([0, 255, 3])); return zip;
}
async function inventory(h: Awaited<ReturnType<typeof host>>, path = 'source.docx') {
  const records: any[] = []; let cursor: string | undefined;
  for (let count = 0; count < 100; count++) { const result = await h.tools.run('inspect_office', { path, ...(cursor ? { cursor } : {}) }); expect(result.status, result.output).toBe('success'); const page = JSON.parse(result.output); records.push(...page.prepared_fragments); if (!page.next_cursor) return { records, snapshot: page.snapshot_ref }; cursor = page.next_cursor; } throw new Error('inventory did not finish');
}
async function prepare(supplied?: JSZip) { const h = await host(); const bytes = await (supplied ?? await fixture()).generateAsync({ type: 'nodebuffer' }); await fs.writeFile(join(h.root, 'source.docx'), bytes); return { h, bytes, initial: await inventory(h) }; }
const insert = (target_ref: string, rows: string[][], extra: Record<string, unknown> = {}) => ({ op: 'insert_table', target_ref, rows, ...extra });
const ref = (p: Awaited<ReturnType<typeof prepare>>, text: string) => p.initial.records.find(record => record.kind === 'paragraph' && record.record.text === text).id;
const save = (p: Awaited<ReturnType<typeof prepare>>, edits: unknown[]) => p.h.tools.run('edit_office', { schema_version: 1, snapshot_ref: p.initial.snapshot, path: 'output.docx', edits });
async function output(p: Awaited<ReturnType<typeof prepare>>) {
  const zip = await JSZip.loadAsync(await fs.readFile(join(p.h.root, 'output.docx'))); const source = await JSZip.loadAsync(p.bytes); expect(Object.keys(zip.files).sort()).toEqual(Object.keys(source.files).sort());
  for (const [name, entry] of Object.entries(source.files)) if (!entry.dir && name !== 'word/document.xml') expect((await zip.file(name)!.async('nodebuffer')).equals(await entry.async('nodebuffer')), name).toBe(true);
  expect((await fs.readFile(join(p.h.root, 'source.docx'))).equals(p.bytes)).toBe(true); return { zip, inventory: await inventory(p.h, 'output.docx') };
}
it('registered table insertion saves literal cells, AutoFit, header and existing table style while preserving other parts', async () => {
  const p = await prepare(); const result = await save(p, [insert(ref(p, 'Anchor'), [['B2', 'Literal <&>\r\n中文\tvalue'], ['', 'Second']], { position: 'before', header_row: true, style_id: 'TableCustom' })]); expect(result.status, result.output).toBe('success'); expect(result.output).toContain('Inserted Word table 2×2 before'); expect(result.output).toContain('Matched text spans: 0'); expect(result.output).toContain('no source computation attested');
  const out = await output(p); const cells = out.inventory.records.filter(record => record.kind === 'table-cell' && record.record.table_ref === 'T1'); expect(cells.map(record => record.record.text)).toEqual(['B2', 'Literal <&>\n中文\tvalue', '', 'Second']);
  expect(out.inventory.records.find(record => record.id === 'T1-R1').record.saved_properties.tblHeader).toBe('true');
  const parsed = officeXmlElements(await out.zip.file('word/document.xml')!.async('nodebuffer'), () => {}); const table = parsed.elements.find(element => element.tag.local === 'tbl')!; const properties = table.children.find(element => element.tag.local === 'tblPr')!;
  expect(properties.children.find(element => element.tag.local === 'tblStyle')!.tag.attributes['ut:val'].value).toBe('TableCustom'); expect(properties.children.find(element => element.tag.local === 'tblLayout')!.tag.attributes['ut:type'].value).toBe('autofit');
  const spec: any = p.h.tools.specs().find(tool => tool.function.name === 'edit_office'); expect(spec.function.parameters.properties.edits.items.properties.op.enum).toContain('insert_table');
});
it('mixed repeated table/paragraph inserts preserve original paragraph and cell selectors through subsequent text edits', async () => {
  const p = await prepare(); const anchor = ref(p, 'Anchor'); const last = ref(p, 'Last'); const cell = p.initial.records.find(record => record.kind === 'table-cell' && record.record.text === 'B2').id;
  const result = await save(p, [insert(anchor, [['B2', 'New literal']], { position: 'before' }), { op: 'insert_paragraphs', target_ref: last, paragraphs: ['Before original last'], position: 'before' }, insert(last, [['Second table']]), { op: 'replace_text', target_ref: anchor, find: 'Anchor', replace: 'Original anchor changed' }, { op: 'replace_text', target_ref: cell, find: 'B2', replace: 'Original cell changed' }]);
  expect(result.status, result.output).toBe('success'); const out = await output(p); expect(out.inventory.records.find(record => record.id === 'T1-R1-C1').record.text).toBe('B2'); expect(out.inventory.records.find(record => record.id === 'T3-R2-C2').record.text).toBe('Original cell changed'); expect(out.inventory.records.some(record => record.kind === 'paragraph' && record.record.text === 'Original anchor changed')).toBe(true);
});
it('nested insertion ends its original table cell with a paragraph and retains the original paragraph selector', async () => {
  const p = await prepare(); const original = ref(p, 'B2'); const result = await save(p, [insert(original, [['Nested']]), { op: 'replace_text', target_ref: original, find: 'B2', replace: 'Original B2 changed' }]); expect(result.status, result.output).toBe('success'); expect(result.output).toContain('trailing cell paragraph true'); const out = await output(p);
  const parsed = officeXmlElements(await out.zip.file('word/document.xml')!.async('nodebuffer'), () => {}); const nested = parsed.elements.filter(element => element.tag.local === 'tbl').at(-1)!; expect(nested.parent!.children.at(-1)!.tag.local).toBe('p'); expect(out.inventory.records.find(record => record.id === 'T2-R1-C1').record.text).toBe('Nested'); expect(out.inventory.records.some(record => record.kind === 'paragraph' && record.record.text === 'Original B2 changed')).toBe(true);
});
it('keeps strict UTF16/BOM and original paragraphs while adding empty table cells', async () => {
  const zip = await fixture(); const xml = (await zip.file('word/document.xml')!.async('string')).replaceAll('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main').replace(/encoding="UTF-8"/i, 'encoding="UTF-16"'); zip.file('word/document.xml', Buffer.concat([Buffer.from([255, 254]), Buffer.from(xml, 'utf16le')])); const p = await prepare(zip);
  const result = await save(p, [insert(ref(p, 'Anchor'), [['', '第二列']])]); expect(result.status, result.output).toBe('success'); const out = await output(p); expect([...(await out.zip.file('word/document.xml')!.async('nodebuffer')).subarray(0, 2)]).toEqual([255, 254]); expect(out.inventory.records.find(record => record.id === 'T1-R1-C1').record.text).toBe('');
});
it('adds a table beside an empty paragraph in a document with no original tables', async () => {
  const zip = await fixture(); zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr/></w:body></w:document>'); const p = await prepare(zip); const result = await save(p, [insert('D1', [['First table']])]); expect(result.status, result.output).toBe('success'); const out = await output(p); expect(out.inventory.records.find(record => record.id === 'T1-R1-C1').record.text).toBe('First table');
});
it.each(['bad-fact', 'late-off', 'wrong-target', 'stale-source'])('withholds table %s without changing an existing destination', async mode => {
  const p = await prepare(); const prior = Buffer.from('Existing destination'); await fs.writeFile(join(p.h.root, 'output.docx'), prior);
  if (mode === 'bad-fact' || mode === 'late-off') { const real = p.h.editor.edit.bind(p.h.editor); vi.spyOn(p.h.editor, 'edit').mockImplementation(async (...args) => { const result = await real(...args); if (mode === 'bad-fact') result.insertedTables![0].columns++; else (p.h.tools as any).allowedTools.delete('write'); return result; }); }
  if (mode === 'stale-source') await fs.appendFile(join(p.h.root, 'source.docx'), 'changed'); const result = await save(p, [insert(mode === 'wrong-target' ? 'D99' : ref(p, 'Anchor'), [['New table']])]); expect(result.status).not.toBe('success'); expect((await fs.readFile(join(p.h.root, 'output.docx'))).equals(prior)).toBe(true);
});
it.each([{ rows: [] }, { rows: [[]] }, { rows: [['A'], ['B', 'C']] }, { rows: [[1]] }, { rows: [['\ud800']] }, { style_id: '' }, { header_row: 'yes' }, { position: 'inside' }, { raw_xml: '<w:tbl/>' }])('rejects invalid typed table fields %j', extra => {
  expect(() => validateOfficeEditRequest({ schema_version: 1, path: 'output.docx', snapshot_ref: 'office-11111111-1111-1111-1111-111111111111', edits: [{ op: 'insert_table', target_ref: 'D1', rows: [['Text']], ...extra }] })).toThrow('invalid-office-edits');
});
