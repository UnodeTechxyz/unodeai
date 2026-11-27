import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { WorkspaceTools } from '../WorkspaceTools';
import { officeRouteReader, officeRouteEditor } from './officeInventoryRouteFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { wordStoryModelFromXml } from '../../office/word/WordRevisionModel';
import { wordStoryText } from '../../office/word/WordRevisionViews';
import { projectedText } from '../../office/word/WordEditSession';
import type { OfficeAuthoring } from '../../office/word/WordAuthor';

// Counts every process start the host could make while editing; the author lookup must start none (design 4.5).
const launched = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const counted = <T,>(work: T) => ((...args: unknown[]) => { launched.count++; return (work as (...values: unknown[]) => unknown)(...args); }) as unknown as T;
  return { ...actual, spawn: counted(actual.spawn), execFile: counted(actual.execFile), exec: counted(actual.exec), fork: counted(actual.fork) };
});
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const fixture = join(__dirname, '../../office/__tests__/testdata/word-revisions');
const owned: Array<Awaited<ReturnType<typeof host>>> = [];
afterEach(async () => { for (const h of owned.splice(0)) { h.tools.retire(); await h.reader.dispose(); } await removeTemporaryFolders(); vi.restoreAllMocks(); });
async function host(authoring?: OfficeAuthoring) {
  const root = await temporaryFolder('unode-word-tracked-'); const reader = await officeRouteReader(); const editor = await officeRouteEditor();
  const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'agent'); tools.setOfficeReader(reader); tools.setOfficeEditor(editor);
  if (authoring) tools.setOfficeAuthoring(() => authoring); tools.beginTurn(); const h = { root, reader, editor, tools }; owned.push(h); return h;
}
function docx(body: string, extra: Record<string, string> = {}) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>');
  zip.file('word/settings.xml', `<w:settings xmlns:w="${W}"><w:zoom w:percent="100"/></w:settings>`);
  zip.file('word/document.xml', `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`);
  for (const [name, value] of Object.entries(extra)) zip.file(name, value);
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function inspect(h: Awaited<ReturnType<typeof host>>, path: string, view?: string) {
  const records: Array<{ kind: string; id: string; record: Record<string, any> }> = []; let cursor: string | undefined; let snapshot = '';
  for (let count = 0; count < 100; count++) {
    const result = await h.tools.run('inspect_office', { path, ...(cursor ? { cursor } : view ? { view } : {}) }); expect(result.status, result.output).toBe('success');
    const page = JSON.parse(result.output); snapshot = page.snapshot_ref; records.push(...page.prepared_fragments); if (!page.next_cursor) return { records, snapshot }; cursor = page.next_cursor;
  }
  throw new Error('inventory did not finish');
}
const p = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
async function prepare(bytes: Buffer, authoring?: OfficeAuthoring) { const h = await host(authoring); await fs.writeFile(join(h.root, 'source.docx'), bytes); return { h, bytes, initial: await inspect(h, 'source.docx') }; }
const save = (s: Awaited<ReturnType<typeof prepare>>, edits: unknown[], extra: Record<string, unknown> = {}) => s.h.tools.run('edit_office', { schema_version: 1, snapshot_ref: s.initial.snapshot, path: 'output.docx', edits, ...extra });
const outputXml = async (s: Awaited<ReturnType<typeof prepare>>, name = 'word/document.xml') => (await JSZip.loadAsync(await fs.readFile(join(s.h.root, 'output.docx')))).file(name)!.async('string');
const ref = (s: Awaited<ReturnType<typeof prepare>>, text: string) => s.initial.records.find(item => item.kind === 'paragraph' && item.record.text === text)!.id;

it('W2 default edit_office on Word records a tracked replacement with author and date; views and receipt say so; the document switch is unchanged', async () => {
  const s = await prepare(await docx(p('Alpha beta gamma') + p('Untouched')), { trackChangesDefault: true, authorName: 'Dana Reviewer', memberName: 'Writer' });
  launched.count = 0; const result = await save(s, [{ op: 'replace_text', target_ref: ref(s, 'Alpha beta gamma'), find: 'beta', replace: 'BETA\tnew' }]);
  expect(result.status, result.output).toBe('success'); expect(launched.count).toBe(0);
  expect(result.output).toContain('recorded as Word revisions by "Dana Reviewer (via Writer)" (author from the Unode › Office: Author Name setting)');
  expect(result.output).toContain("The document's own Track Changes switch is unchanged."); expect(result.output).toMatch(/New revisions in the saved file: R1 delete, R2 insert/);
  const xml = await outputXml(s); expect(xml).toMatch(/<w:del w:id="\d+" w:author="Dana Reviewer \(via Writer\)" w:date="\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"><w:r><w:delText xml:space="preserve">beta<\/w:delText><\/w:r><\/w:del><w:ins w:id="\d+"/);
  expect(await outputXml(s, 'word/settings.xml')).toBe(`<w:settings xmlns:w="${W}"><w:zoom w:percent="100"/></w:settings>`);
  const current = await inspect(s.h, 'output.docx'); const original = await inspect(s.h, 'output.docx', 'original');
  expect(current.records.find(item => item.id === 'D1')!.record.text).toBe('Alpha BETA\tnew gamma'); expect(original.records.find(item => item.id === 'D1')!.record.text).toBe('Alpha beta gamma');
  expect(current.records.filter(item => item.kind === 'revision').map(item => [item.record.kind, item.record.author, item.record.decidable])).toEqual([['delete', 'Dana Reviewer (via Writer)', true], ['insert', 'Dana Reviewer (via Writer)', true]]);
});

it('W2 closure: other author inserted 甲 in one paragraph, 乙 becomes 丙 in another; rejecting only this request gives 甲 and 乙 and 甲 stays the other author\'s insertion', async () => {
  const s = await prepare(await docx(`<w:p><w:ins w:id="5" w:author="Other" w:date="2026-11-01T00:00:00Z"><w:r><w:t>甲</w:t></w:r></w:ins></w:p>${p('乙')}`));
  const result = await save(s, [{ op: 'replace_text', target_ref: 'D2', find: '乙', replace: '丙' }]); expect(result.status, result.output).toBe('success');
  const model = wordStoryModelFromXml(await outputXml(s), 'main', () => {}, true, true);
  const own = new Set(model.items.filter(item => item.author === 'agent (UnodeAi)').map(item => item.wordId!));
  expect(own.size).toBe(2); expect(projectedText(model, 'current', own, 'reject')).toEqual(['甲', '乙']); expect(projectedText(model, 'original', own, 'reject')).toEqual(['', '乙']);
  expect(projectedText(model, 'current', own, 'accept')).toEqual(['甲', '丙']); expect(wordStoryText(model, 'current')).toEqual(['甲', '丙']);
  expect(model.items.find(item => item.wordId === '5')).toMatchObject({ kind: 'insert', author: 'Other' }); expect(result.output).toContain('author from the team member name');
});

it('W2 refuses an overlap with another person\'s or an earlier request\'s revision, and edits text this request inserted in place', async () => {
  const body = `<w:p><w:r><w:t xml:space="preserve">Keep </w:t></w:r><w:ins w:id="9" w:author="agent (UnodeAi)" w:date="2026-11-01T00:00:00Z"><w:r><w:t>earlier</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> end</w:t></w:r></w:p>`
    + `<w:p><w:r><w:t xml:space="preserve">a</w:t></w:r><w:del w:id="10" w:author="Other"><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:t>b</w:t></w:r></w:p>${p('Fresh text')}`;
  const s = await prepare(await docx(body));
  for (const [target, find] of [['D1', 'earlier'], ['D1', 'Keep earlier'], ['D2', 'ab']]) {
    const refused = await save(s, [{ op: 'replace_text', target_ref: target, find, replace: 'X' }]); expect(refused.status).toBe('failed');
    expect(refused.output).toContain('lies inside or across a tracked change this request did not make'); expect(refused.output).toContain('Review tab → Accept / Reject');
  }
  const result = await save(s, [{ op: 'replace_text', target_ref: 'D3', find: 'Fresh', replace: 'New words' }, { op: 'replace_text', target_ref: 'D3', find: 'New', replace: 'Better' }]);
  expect(result.status, result.output).toBe('success'); const xml = await outputXml(s);
  expect(xml.match(/<w:ins /g)).toHaveLength(2); expect(xml).toContain('>Better</w:t>'); expect(xml).not.toContain('>New');
  const out = await inspect(s.h, 'output.docx'); expect(out.records.find(item => item.id === 'D3')!.record.text).toBe('Better words text');
});

it('W2 splits runs at text offsets keeping run properties byte-identical; a copied property history gets a new ID; tab and break inside the match are deleted', async () => {
  const run = '<w:r><w:rPr><w:b/><w:rPrChange w:id="3" w:author="Old" w:date="2026-01-01T00:00:00Z"><w:rPr/></w:rPrChange></w:rPr><w:t xml:space="preserve">one two three</w:t></w:r>';
  const s = await prepare(await docx(`<w:p>${run}</w:p><w:p><w:r><w:t>left</w:t><w:tab/><w:t>right</w:t><w:br/><w:t>down</w:t></w:r></w:p>`));
  const result = await save(s, [{ op: 'replace_text', target_ref: 'D1', find: 'two', replace: '2' }, { op: 'replace_text', target_ref: 'D2', find: 't\tright\nd', replace: '-' }]);
  expect(result.status, result.output).toBe('success'); const xml = await outputXml(s);
  const properties = [...xml.matchAll(/<w:rPr><w:b\/><w:rPrChange w:id="(\d+)" w:author="Old" w:date="2026-01-01T00:00:00Z"><w:rPr\/><\/w:rPrChange><\/w:rPr>/g)].map(match => match[1]);
  expect(properties).toHaveLength(3); expect(properties[0]).toBe('3'); expect(new Set(properties).size).toBe(3);
  expect(xml).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">2</w:t>');
  expect(xml).toMatch(/<w:del [^>]*><w:r><w:delText xml:space="preserve">t<\/w:delText><w:tab\/><w:delText xml:space="preserve">right<\/w:delText><w:br\/><w:delText xml:space="preserve">d<\/w:delText><\/w:r><\/w:del>/);
  const out = await inspect(s.h, 'output.docx'); const original = await inspect(s.h, 'output.docx', 'original');
  expect(out.records.filter(item => item.kind === 'paragraph').map(item => item.record.text)).toEqual(['one 2 three', 'lef-own']);
  expect(original.records.filter(item => item.kind === 'paragraph').map(item => item.record.text)).toEqual(['one two three', 'left\tright\ndown']);
});

it('W2 tracked paragraph and table inserts are revisions whose rejection restores the input text; a match across paragraphs or an untrackable op is refused', async () => {
  const s = await prepare(await docx(p('First') + p('Last')));
  const result = await save(s, [{ op: 'insert_paragraphs', target_ref: 'D1', paragraphs: ['Added one', 'Added two'] }, { op: 'insert_table', target_ref: 'D2', rows: [['a', 'b']] }]);
  expect(result.status, result.output).toBe('success'); const xml = await outputXml(s);
  const model = wordStoryModelFromXml(xml, 'main', () => {}, true, true); const own = new Set(model.items.map(item => item.wordId!));
  expect(projectedText(model, 'current', own, 'reject')).toEqual(['First', 'Last']); expect(wordStoryText(model, 'original')).toEqual(['First', 'Last']);
  expect(wordStoryText(model, 'current')).toEqual(['First', 'Added one', 'Added two', 'Last', 'a', 'b']);
  expect(xml.match(/<\w+:trPr><\w+:ins /g)).toHaveLength(1);
  const tail = await prepare(await docx(p('Only')));
  const appended = await save(tail, [{ op: 'insert_paragraphs', target_ref: 'D1', paragraphs: ['After the last'] }]); expect(appended.status, appended.output).toBe('success');
  const appendedModel = wordStoryModelFromXml(await outputXml(tail), 'main', () => {}, true, true);
  expect(wordStoryText(appendedModel, 'original')).toEqual(['Only']); expect(appendedModel.paragraphs[0].mark?.kind).toBe('insert');
  const two = await prepare(await docx(`<w:p><w:bookmarkStart w:id="1" w:name="b"/><w:r><w:t>one</w:t></w:r></w:p><w:p><w:r><w:t>two</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>`));
  const crossing = await save(two, [{ op: 'replace_text', target_ref: 'B1', find: 'one\ntwo', replace: 'x' }]); expect(crossing.status).toBe('failed'); expect(crossing.output).toContain('resend with track_changes:false');
  const theme = await save(two, [{ op: 'replace_text', target_ref: 'D1', find: 'one', replace: 'uno' }, { op: 'replace_image', target_ref: 'I1', asset_ref: 'x' }]);
  expect(theme.status).toBe('failed');
});

it('W2 track_changes:false gives the 0.9.107 direct edit byte for byte; PPT refuses track_changes:true', async () => {
  const bytes = await docx(p('Alpha beta'));
  const tracked = await prepare(bytes); const direct = await prepare(bytes, { trackChangesDefault: false, authorName: '', memberName: 'agent' });
  const edit = [{ op: 'replace_text', target_ref: 'D1', find: 'beta', replace: 'gamma' }];
  expect((await save(tracked, edit, { track_changes: false })).status).toBe('success'); const viaRequest = await outputXml(tracked);
  const viaSetting = await save(direct, edit); expect(viaSetting.status).toBe('success'); expect(viaSetting.output).toContain('Direct edit without tracked changes.');
  expect(viaRequest).toBe(await outputXml(direct)); expect(viaRequest).toContain('<w:t xml:space="preserve">Alpha gamma</w:t>');
  const forced = await save(direct, edit, { track_changes: true }); expect(forced.status).toBe('success'); expect(await outputXml(direct)).toContain('<w:del ');
  const invalid = await save(direct, edit, { track_changes: 'yes' }); expect(invalid.status).toBe('failed'); expect(invalid.output).toContain('track_changes');
});

it('W2 accept and reject inspected revisions of the Word-saved fixture in one request; non-decidable and reused targets are refused', async () => {
  const s = await prepare(await fs.readFile(join(fixture, 'word-revisions.docx')));
  const revision = (index: number) => s.initial.records.filter(item => item.kind === 'revision')[index].id;
  const result = await save(s, [{ op: 'accept_revision', target_ref: revision(0) }, { op: 'reject_revision', target_ref: revision(1) }, { op: 'reject_revision', target_ref: revision(5) },
    { op: 'accept_revision', target_ref: revision(10) }, { op: 'replace_text', target_ref: 'D5', find: 'Target', replace: 'Goal' }]);
  expect(result.status, result.output).toBe('success'); expect(result.output).toContain('Accepted revision R1.'); expect(result.output).toContain('Rejected revision R6. Removed paragraphs (their selectors are no longer available): D4.');
  const out = await inspect(s.h, 'output.docx'); const texts = out.records.filter(item => item.kind === 'paragraph' && !item.record.story).map(item => item.record.text);
  expect(texts.slice(0, 4)).toEqual(['Alpha text.', 'Keep this.', 'Before after.', 'Goal: moved words here.']);
  expect(out.records.filter(item => item.kind === 'revision').some(item => item.record.structure === 'table-row')).toBe(false);
  const nested = await save(s, [{ op: 'accept_revision', target_ref: revision(3) }]); expect(nested.status).toBe('failed'); expect(nested.output).toContain('Review tab → Accept or Reject');
  const removedTarget = await save(s, [{ op: 'reject_revision', target_ref: revision(5) }, { op: 'replace_text', target_ref: 'D4', find: 'Brand', replace: 'x' }]); expect(removedTarget.status).toBe('failed');
  const twice = await save(s, [{ op: 'accept_revision', target_ref: revision(0) }, { op: 'reject_revision', target_ref: revision(0) }]); expect(twice.status).toBe('failed');});

it('W2 F1 default tracking assigns an ordinary single-paragraph inline text control as a tracked change and keeps its properties', async () => {
  const properties = '<w:sdtPr><w:id w:val="10"/><w:tag w:val="inline"/><w:text/></w:sdtPr>';
  const s = await prepare(await docx(`<w:p><w:r><w:t>Before</w:t></w:r><w:sdt>${properties}<w:sdtContent><w:r><w:t>Old inline</w:t></w:r></w:sdtContent></w:sdt></w:p>`
    + `<w:p><w:sdt><w:sdtPr><w:id w:val="11"/></w:sdtPr><w:sdtContent><w:r><w:t>Outer </w:t></w:r><w:sdt><w:sdtPr><w:id w:val="12"/></w:sdtPr><w:sdtContent><w:r><w:t>Inner</w:t></w:r></w:sdtContent></w:sdt></w:sdtContent></w:sdt></w:p>`));
  const control = s.initial.records.find(item => item.kind === 'content-control' && item.record.text === 'Old inline')!.id;
  const result = await save(s, [{ op: 'set_control_text', target_ref: control, text: 'New inline' }]); expect(result.status, result.output).toBe('success');
  const xml = await outputXml(s); expect(xml).toContain(properties); expect(xml).toMatch(/<w:sdtContent><w:del [^>]*><w:r><w:delText xml:space="preserve">Old inline<\/w:delText><\/w:r><\/w:del><w:ins [^>]*><w:r><w:t xml:space="preserve">New inline<\/w:t><\/w:r><\/w:ins><\/w:sdtContent>/);
  const current = await inspect(s.h, 'output.docx'); const original = await inspect(s.h, 'output.docx', 'original');
  expect(current.records.find(item => item.id === 'D1')!.record.text).toBe('BeforeNew inline'); expect(original.records.find(item => item.id === 'D1')!.record.text).toBe('BeforeOld inline');
  const outer = s.initial.records.find(item => item.kind === 'content-control' && String(item.record.text).startsWith('Outer'))!.id;
  const nested = await save(s, [{ op: 'replace_text', target_ref: outer, find: 'Outer Inner', replace: 'x' }]); expect(nested.status).toBe('failed');
});

it('W2 F2 accepting a revision and a direct edit in one untracked request saves both; decisions with tracked edits still roll back to the decided input', async () => {
  const body = `<w:p><w:ins w:id="1" w:author="Other" w:date="2026-11-01T00:00:00Z"><w:r><w:t>Inserted</w:t></w:r></w:ins></w:p>${p('Old')}`;
  const direct = await prepare(await docx(body));
  const result = await save(direct, [{ op: 'accept_revision', target_ref: 'R1' }, { op: 'replace_text', target_ref: 'D2', find: 'Old', replace: 'New' }], { track_changes: false });
  expect(result.status, result.output).toBe('success'); expect(result.output).toContain('Accepted revision R1.'); expect(result.output).toContain('Direct edit without tracked changes.');
  const xml = await outputXml(direct); expect(xml).not.toContain('<w:ins '); expect(xml).toContain('>Inserted<'); expect(xml).toContain('>New<');
  const tracked = await prepare(await docx(body));
  const both = await save(tracked, [{ op: 'reject_revision', target_ref: 'R1' }, { op: 'replace_text', target_ref: 'D2', find: 'Old', replace: 'New' }]); expect(both.status, both.output).toBe('success');
  const out = await inspect(tracked.h, 'output.docx', 'original'); expect(out.records.filter(item => item.kind === 'paragraph').map(item => item.record.text)).toEqual(['', 'Old']);
});
