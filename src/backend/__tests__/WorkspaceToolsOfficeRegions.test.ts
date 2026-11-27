import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { WorkspaceTools } from '../WorkspaceTools';
import { officeRouteReader, officeRouteDocument } from './officeInventoryRouteFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { WorkbookRecordCollector } from './workbookComputeFixtures';
const owned: Array<Awaited<ReturnType<typeof host>>> = [];
afterEach(async () => { for (const h of owned.splice(0)) { h.tools.retire(); await h.reader.dispose(); } await removeTemporaryFolders(); });
async function host() {
  const root = await temporaryFolder('unode-word-regions-'); const reader = await officeRouteReader(); const tools = new WorkspaceTools(root, new Set(['read']), 'agent'); tools.setOfficeReader(reader); tools.beginTurn(); const h = { root, reader, tools }; owned.push(h); return h;
}
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function fixture(strict = false, longText?: string) {
  const zip = await JSZip.loadAsync(await officeRouteDocument());
  let xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>
<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="5000"/></w:tabs></w:pPr><w:bookmarkStart w:id="7" w:name="Customer"/><w:r><w:t>A&amp;</w:t></w:r><w:sdt><w:sdtPr><w:id w:val="11"/><w:alias w:val="Customer name"/><w:tag w:val="customer"/><w:showingPlcHdr/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Candidate</w:t></w:r></w:sdtContent></w:sdt><w:r><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r><w:bookmarkEnd w:id="7"/></w:p>
<w:sdt><w:sdtPr><w:id w:val="22"/><w:alias w:val="Bound outer"/><w:lock w:val="sdtContentLocked"/><w:dataBinding w:storeItemID="{ABC}" w:xpath="/root/field" w:prefixMappings="xmlns:x='urn:sample'"/></w:sdtPr><w:sdtContent><w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="2000"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">Outer first </w:t></w:r><w:sdt><w:sdtPr><w:id w:val="33"/><w:alias w:val="Nested"/><w:showingPlcHdr w:val="0"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Nested</w:t></w:r></w:sdtContent></w:sdt></w:p><w:p><w:bookmarkStart w:id="8" w:name="Cross" w:colFirst="0" w:colLast="1"/><w:r><w:t>Second</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell bound</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>Third</w:t></w:r><w:bookmarkEnd w:id="8"/></w:p></w:sdtContent></w:sdt>
<w:p><w:bookmarkStart w:id="9" w:name="Missing end"/><w:r><w:t>Tail</w:t></w:r></w:p><mc:AlternateContent><mc:Choice Requires="w"><w:sdt><w:sdtPr><w:alias w:val="Skipped"/></w:sdtPr><w:sdtContent><w:p><w:bookmarkStart w:id="99" w:name="Skipped"/><w:r><w:t>Skipped</w:t></w:r><w:bookmarkEnd w:id="99"/></w:p></w:sdtContent></w:sdt></mc:Choice><mc:Fallback/></mc:AlternateContent></w:body></w:document>`;
  if (longText !== undefined) xml = xml.replace('Candidate', longText);
  if (strict) xml = xml.replaceAll(W, 'http://purl.oclc.org/ooxml/wordprocessingml/main').replace('encoding="UTF-8"', 'encoding="UTF-16"');
  zip.file('word/document.xml', strict ? Buffer.concat([Buffer.from([255, 254]), Buffer.from(xml, 'utf16le')]) : xml); zip.file('customXml/item1.xml', '<root><field>Actual custom XML value</field></root>'); return zip.generateAsync({ type: 'nodebuffer' });
}
async function inspect(h: Awaited<ReturnType<typeof host>>) {
  const collector = new WorkbookRecordCollector(); let cursor: string | undefined; let first: any; let pages = 0;
  do { const result = await h.tools.run('inspect_office', { path: 'source.docx', ...(cursor ? { cursor } : {}) }); expect(result.status, result.output).toBe('success'); const page = JSON.parse(result.output); first ??= page; collector.add(page); cursor = page.next_cursor; expect(++pages).toBeLessThan(100); } while (cursor);
  return { first, records: collector.records(), pages };
}
it.each([false, true])('registered inspection inventories bookmark/control text and metadata in strict=%s without evaluating bindings or changing bytes', async strict => {
  const h = await host(); const bytes = await fixture(strict); await fs.writeFile(join(h.root, 'source.docx'), bytes); const out = await inspect(h); expect(out.first.summary).toMatchObject({ bookmarks: 3, controls: 3, paragraphs: 6, tables: 1, gaps: 1 });
  const controls = out.records.filter(record => record.kind === 'content-control'); const find = (id: string) => controls.find(record => record.id === id).record;
  expect(find('C1')).toMatchObject({ text: 'Candidate', control_id: '11', alias: 'Customer name', tag: 'customer', control_type: 'text', showing_placeholder: true, paragraph_refs: ['D1'] });
  expect(find('C2')).toMatchObject({ text: 'Outer first Nested\nSecond\nCell bound\nThird', control_id: '22', alias: 'Bound outer', lock: 'sdtContentLocked', data_binding: { storeItemID: '{ABC}', xpath: '/root/field', prefixMappings: "xmlns:x='urn:sample'" }, data_binding_resolution: 'not-performed', paragraph_refs: ['D2', 'D3', 'D4', 'D5'] });
  expect(find('C3')).toMatchObject({ text: 'Nested', control_id: '33', showing_placeholder: false, paragraph_refs: ['D2'] });
  const bookmarks = out.records.filter(record => record.kind === 'bookmark'); expect(bookmarks.find(record => record.id === 'B1').record).toMatchObject({ name: 'Customer', bookmark_id: '7', text: 'A&Candidate\tB\nC', paired: true, paragraph_refs: ['D1'] });
  expect(bookmarks.find(record => record.id === 'B2').record).toMatchObject({ text: 'Second\nCell bound\nThird', paired: true, table_columns: { colFirst: '0', colLast: '1' }, table_column_resolution: 'not-performed', paragraph_refs: ['D3', 'D4', 'D5'] });
  expect(bookmarks.find(record => record.id === 'B3').record).toMatchObject({ paired: false, text: 'Tail', paragraph_refs: ['D6'] }); expect(controls.some(record => record.record.alias === 'Skipped')).toBe(false);
  for (const region of [...controls, ...bookmarks]) { expect(region.record.selector.snapshot_ref).toBe(out.first.snapshot_ref); for (const ref of region.record.paragraph_refs) expect(out.records.some(record => record.kind === 'paragraph' && record.id === ref)).toBe(true); }
  expect((await fs.readFile(join(h.root, 'source.docx'))).equals(bytes)).toBe(true); expect(out.first.coverage.content_controls).toContain('bindings-not-resolved');
});
it('paginates long region records and reconstructs their exact Unicode text through the actual tool cursor', async () => {
  const h = await host(); const text = '中文'.repeat(16000); const bytes = await fixture(false, text); await fs.writeFile(join(h.root, 'source.docx'), bytes); const out = await inspect(h); expect(out.pages).toBeGreaterThan(2); expect(out.records.find(record => record.id === 'C1' && record.kind === 'content-control').record.text).toBe(text); expect(out.records.find(record => record.id === 'B1' && record.kind === 'bookmark').record.text).toBe('A&' + text + '\tB\nC'); expect((await fs.readFile(join(h.root, 'source.docx'))).equals(bytes)).toBe(true);
});
