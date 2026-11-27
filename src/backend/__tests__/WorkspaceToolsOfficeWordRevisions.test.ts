import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { WorkspaceTools } from '../WorkspaceTools';
import { officeRouteReader } from './officeInventoryRouteFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';

const fixture = join(__dirname, '../../office/__tests__/testdata/word-revisions');
const owned: Array<Awaited<ReturnType<typeof host>>> = [];
afterEach(async () => { for (const h of owned.splice(0)) { h.tools.retire(); await h.reader.dispose(); } await removeTemporaryFolders(); });
async function host() {
  const root = await temporaryFolder('unode-word-revisions-'); const reader = await officeRouteReader();
  const tools = new WorkspaceTools(root, new Set(['read']), 'agent'); tools.setOfficeReader(reader); tools.beginTurn(); const h = { root, reader, tools }; owned.push(h); return h;
}
async function inspect(h: Awaited<ReturnType<typeof host>>, path: string, view?: string) {
  const records: Array<{ kind: string; id: string; record: Record<string, any> }> = []; let cursor: string | undefined; let first: Record<string, any> | undefined;
  for (let count = 0; count < 200; count++) {
    const result = await h.tools.run('inspect_office', { path, ...(cursor ? { cursor } : view ? { view } : {}) }); expect(result.status, result.output).toBe('success');
    const page = JSON.parse(result.output); first ??= page; records.push(...page.prepared_fragments); if (!page.next_cursor) return { records, first: first! }; cursor = page.next_cursor;
  }
  throw new Error('inventory did not finish');
}
const wordParagraphs = (text: string) => text.replace(/\r\u0007/g, '\r').split('\r').filter(Boolean);
/** Whole-body text of one view from paragraph records, applying the view's joins and omissions. */
function viewText(records: Array<{ kind: string; record: Record<string, any> }>) {
  const output: string[] = []; let carry: string | undefined;
  for (const item of records.filter(item => item.kind === 'paragraph' && !item.record.story)) {
    if (item.record.omitted_in_view) continue; const text = (carry ?? '') + item.record.text;
    if (item.record.joins_next_in_view) { carry = text; continue; } carry = undefined; output.push(text);
  }
  return output.filter(Boolean);
}

it('W1 inspect_office reads the Word-saved fixture: views equal Word Accept All / Reject All, revision and comment records', async () => {
  const h = await host(); await fs.copyFile(join(fixture, 'word-revisions.docx'), join(h.root, 'contract.docx'));
  const word = JSON.parse(await fs.readFile(join(fixture, 'word-revisions.expected.json'), 'utf8'));
  const current = await inspect(h, 'contract.docx'); const original = await inspect(h, 'contract.docx', 'original'); const markup = await inspect(h, 'contract.docx', 'markup');
  expect(current.first.view).toBe('current'); expect(original.first.view).toBe('original');
  expect(current.first.summary).toMatchObject({ revisions: 12, comments: 3, revision_authors: 3 }); expect(current.first.coverage.tracked_changes).toBe('revisions-read');
  expect(viewText(current.records)).toEqual(wordParagraphs(word.accepted.body)); expect(viewText(original.records)).toEqual(wordParagraphs(word.rejected.body));
  const header = (records: typeof current.records) => records.filter(item => item.kind === 'paragraph' && item.record.story === 'header').map(item => item.record.text);
  expect(header(current.records)).toEqual(wordParagraphs(word.accepted.header)); expect(header(original.records)).toEqual(wordParagraphs(word.rejected.header));
  const paragraph = (records: typeof current.records, text: string) => records.find(item => item.kind === 'paragraph' && String(item.record.text).startsWith(text))!.record;
  expect(paragraph(markup.records, 'Keep').text).toBe('Keep [+Avery Fixture: [-Blake Fixture: drop ]]this.');
  expect(paragraph(markup.records, 'See').text).toBe('See commented words[#M1][#M2] and a point[#M3].');
  const revisions = current.records.filter(item => item.kind === 'revision');
  expect(revisions.map(item => item.id)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', expect.stringMatching(/^P\d+-R1$/)]);
  expect(revisions[3].record).toMatchObject({ revision_ref: 'R4', kind: 'delete', author: 'Blake Fixture', date: '2026-11-02T09:00:00Z', word_id: '3', paragraph_refs: ['D2'], text: 'drop ', nested_in: 'R3', decidable: false });
  expect(revisions[5].record).toMatchObject({ kind: 'insert', author: 'Blake Fixture', paragraph_refs: ['D4'], text: 'Brand new paragraph.\n', decidable: true, word_ids: ['7', '6'] });
  expect(revisions[10].record).toMatchObject({ kind: 'insert', structure: 'table-row', decidable: true });
  expect(revisions[11].record).toMatchObject({ kind: 'insert', author: 'Blake Fixture', text: 'draft ', story: 'header', paragraph_refs: [expect.stringMatching(/^P\d+-D1$/)] });
  const comments = current.records.filter(item => item.kind === 'comment').map(item => item.record);
  expect(comments).toMatchObject([
    { comment_ref: 'M1', word_id: '13', author: 'Avery Fixture', initials: 'AF', text: 'First comment line.\nSecond line.', resolved: true, anchor: { start_paragraph_ref: 'D9', end_paragraph_ref: 'D9', text: 'commented words' } },
    { comment_ref: 'M2', author: 'Blake Fixture', parent_ref: 'M1', resolved: true, anchor: { text: 'commented words' } },
    { comment_ref: 'M3', author: 'Casey Fixture', resolved: false, anchor: { start_paragraph_ref: 'D9', text: '' } },
  ]);
  expect(comments[0].parent_ref).toBeUndefined();
  const relationships = current.records.filter(item => item.kind === 'relationship').map(item => item.record.relationship_kind);
  expect(relationships).toEqual(expect.arrayContaining(['comments', 'commentsExtended', 'commentsIds']));
});

it('W1 a continuation keeps its first view and an unsupported view is refused before reading', async () => {
  const h = await host(); await fs.copyFile(join(fixture, 'word-revisions.docx'), join(h.root, 'contract.docx'));
  const first = JSON.parse((await h.tools.run('inspect_office', { path: 'contract.docx', view: 'original' }, { workbookBudget: { unit: 'chars', limit: 4000, reserved: 0, carrier: 'text' } })).output);
  expect(first.next_cursor).toBeTruthy();
  const changed = await h.tools.run('inspect_office', { path: 'contract.docx', cursor: first.next_cursor, view: 'markup' });
  expect(changed.status).toBe('failed'); expect(changed.output).toContain('keeps the view it started with');
  const kept = JSON.parse((await h.tools.run('inspect_office', { path: 'contract.docx', cursor: first.next_cursor })).output); expect(kept.view).toBe('original');
  const invalid = await h.tools.run('inspect_office', { path: 'contract.docx', view: 'accepted' }); expect(invalid.status).toBe('failed'); expect(invalid.output).toContain('current, original or markup');
});

it('W1 a document without revisions or comments keeps its stored paragraph records unchanged', async () => {
  const h = await host(); const zip = new JSZip(); const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Plain</w:t><w:tab/><w:t>text</w:t></w:r></w:p><w:p/></w:body></w:document>`);
  await fs.writeFile(join(h.root, 'plain.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  for (const view of [undefined, 'original', 'markup']) {
    const { records, first } = await inspect(h, 'plain.docx', view);
    expect(records.filter(item => item.kind === 'paragraph').map(item => item.record)).toEqual([
      { paragraph_ref: 'D1', part_ref: 'P1', selector: { snapshot_ref: first.snapshot_ref, paragraph_ref: 'D1' }, text: 'Plain\ttext', runs: [{ text: 'Plain\ttext', style: { b: 'true' } }], style_resolution: 'explicit-run-properties-only', field_refresh: 'not-performed' },
      { paragraph_ref: 'D2', part_ref: 'P1', selector: { snapshot_ref: first.snapshot_ref, paragraph_ref: 'D2' }, text: '', runs: [], style_resolution: 'explicit-run-properties-only', field_refresh: 'not-performed' },
    ]);
    expect(records.some(item => item.kind === 'revision' || item.kind === 'comment')).toBe(false); expect(first.summary).toMatchObject({ revisions: 0, comments: 0, revision_authors: 0 });
  }
});

it('W1 a damaged optional comments part and a broken comment range never fail the body inventory', async () => {
  const h = await host(); const zip = await JSZip.loadAsync(await fs.readFile(join(fixture, 'word-revisions.docx')));
  zip.file('word/commentsExtended.xml', '<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx');
  await fs.writeFile(join(h.root, 'damaged.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const damaged = await inspect(h, 'damaged.docx');
  expect(damaged.records.filter(item => item.kind === 'gap').map(item => item.record.code)).toContain('word-comments-unavailable');
  expect(damaged.records.filter(item => item.kind === 'revision')).toHaveLength(12); expect(damaged.records.some(item => item.kind === 'comment')).toBe(false);
  const broken = await JSZip.loadAsync(await fs.readFile(join(fixture, 'word-revisions.docx')));
  broken.file('word/document.xml', (await broken.file('word/document.xml')!.async('string')).replace('<w:commentRangeEnd w:id="13"/>', '').replace('<w:commentReference w:id="15"/>', '<w:commentReference w:id="99"/>'));
  await fs.writeFile(join(h.root, 'broken.docx'), await broken.generateAsync({ type: 'nodebuffer' }));
  const read = await inspect(h, 'broken.docx'); const gaps = read.records.filter(item => item.kind === 'gap').map(item => item.id);
  expect(gaps).toEqual(expect.arrayContaining(['comment-id-99', 'M1-anchor', 'M3-anchor']));
  expect(read.records.find(item => item.id === 'M1')!.record.anchor).toBeNull(); expect(read.records.find(item => item.id === 'M2')!.record.anchor).toMatchObject({ text: 'commented words' });
});

it.each([['del', 'current', 'original'], ['ins', 'original', 'current']] as const)('W1 F1 a row-only %s revision with plain cell paragraphs is omitted in the %s view and kept in %s and markup', async (marker, hidden, shown) => {
  const h = await host(); const zip = new JSZip(); const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const cell = (text: string) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  zip.file('word/document.xml', `<w:document xmlns:w="${W}"><w:body><w:tbl><w:tr>${cell('Keep')}</w:tr><w:tr><w:trPr><w:${marker} w:id="1" w:author="A" w:date="2026-11-01T00:00:00Z"/></w:trPr>${cell('Row under revision')}</w:tr></w:tbl><w:p><w:r><w:t>End</w:t></w:r></w:p></w:body></w:document>`);
  await fs.writeFile(join(h.root, 'rows.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const row = async (view: string) => (await inspect(h, 'rows.docx', view)).records.find(item => item.id === 'D2')!.record;
  expect(await row(hidden)).toMatchObject({ text: 'Row under revision', view: hidden, omitted_in_view: true });
  for (const view of [shown, 'markup']) { const record = await row(view); expect(record.text).toBe('Row under revision'); expect(record.omitted_in_view).toBeUndefined(); }
  expect(viewText((await inspect(h, 'rows.docx', hidden)).records)).toEqual(['Keep', 'End']);
  expect(viewText((await inspect(h, 'rows.docx', shown)).records)).toEqual(['Keep', 'Row under revision', 'End']);
});
