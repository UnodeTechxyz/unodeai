import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { WorkspaceTools } from '../WorkspaceTools';
import { officeRouteReader, officeRouteEditor } from './officeInventoryRouteFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const fixture = join(__dirname, '../../office/__tests__/testdata/word-revisions');
const owned: Array<Awaited<ReturnType<typeof host>>> = [];
afterEach(async () => { for (const h of owned.splice(0)) { h.tools.retire(); await h.reader.dispose(); } await removeTemporaryFolders(); });
async function host() {
  const root = await temporaryFolder('unode-word-comments-'); const reader = await officeRouteReader(); const editor = await officeRouteEditor();
  const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'agent'); tools.setOfficeReader(reader); tools.setOfficeEditor(editor);
  tools.setOfficeAuthoring(() => ({ trackChangesDefault: true, authorName: 'Dana Reviewer', memberName: 'Writer' })); tools.beginTurn(); const h = { root, reader, editor, tools }; owned.push(h); return h;
}
function plain(body: string, extra: (zip: JSZip) => void = () => {}) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`); extra(zip);
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function inspect(h: Awaited<ReturnType<typeof host>>, path: string) {
  const records: Array<{ kind: string; id: string; record: Record<string, any> }> = []; let cursor: string | undefined; let snapshot = '';
  for (let count = 0; count < 100; count++) {
    const result = await h.tools.run('inspect_office', { path, ...(cursor ? { cursor } : {}) }); expect(result.status, result.output).toBe('success');
    const page = JSON.parse(result.output); snapshot = page.snapshot_ref; records.push(...page.prepared_fragments); if (!page.next_cursor) return { records, snapshot }; cursor = page.next_cursor;
  }
  throw new Error('inventory did not finish');
}
async function prepare(bytes: Buffer) { const h = await host(); await fs.writeFile(join(h.root, 'source.docx'), bytes); return { h, bytes, initial: await inspect(h, 'source.docx') }; }
const save = (s: Awaited<ReturnType<typeof prepare>>, edits: unknown[]) => s.h.tools.run('edit_office', { schema_version: 1, snapshot_ref: s.initial.snapshot, path: 'output.docx', edits });
const output = async (s: Awaited<ReturnType<typeof prepare>>) => JSZip.loadAsync(await fs.readFile(join(s.h.root, 'output.docx')));

it('W3 add_comment creates the comment parts Word uses, anchors the one literal match and is not a tracked change', async () => {
  const s = await prepare(await plain('<w:p><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">Pay within thirty days of receipt.</w:t></w:r></w:p>'));
  const result = await save(s, [{ op: 'add_comment', target_ref: 'D1', find: 'thirty days', text: 'Why not sixty?\nPlease check.' }]);
  expect(result.status, result.output).toBe('success'); expect(result.output).toContain('Commented on D1: new comment M1 by "Dana Reviewer (via Writer)".');
  const zip = await output(s); const document = await zip.file('word/document.xml')!.async('string');
  expect(document).not.toMatch(/<w:(?:ins|del) /); expect(document).toMatch(/<w:t xml:space="preserve">Pay within <\/w:t><\/w:r><w:commentRangeStart w:id="(\d+)"\/><w:r><w:rPr><w:i\/><\/w:rPr><w:t xml:space="preserve">thirty days<\/w:t><\/w:r><w:commentRangeEnd w:id="\1"\/><w:r><w:rPr><w:rStyle w:val="CommentReference"\/><\/w:rPr><w:commentReference w:id="\1"\/><\/w:r>/);
  const types = await zip.file('[Content_Types].xml')!.async('string'); const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
  for (const [part, type, relationship] of [['comments', 'comments', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'], ['commentsExtended', 'commentsExtended', 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended'],
    ['commentsIds', 'commentsIds', 'http://schemas.microsoft.com/office/2016/09/relationships/commentsIds'], ['people', 'people', 'http://schemas.microsoft.com/office/2011/relationships/people']]) {
    expect(types).toContain(`PartName="/word/${part}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml"`); expect(rels).toContain(`Type="${relationship}" Target="${part}.xml"`);
  }
  expect(zip.file('word/commentsExtensible.xml')).toBeNull();
  const comments = await zip.file('word/comments.xml')!.async('string'); const last = [...comments.matchAll(/w14:paraId="([0-9A-F]{8})"/g)].map(match => match[1]).at(-1)!;
  expect(await zip.file('word/commentsExtended.xml')!.async('string')).toContain(`<w15:commentEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" w15:paraId="${last}" w15:done="0"/>`);
  expect(await zip.file('word/people.xml')!.async('string')).toContain('w15:author="Dana Reviewer (via Writer)"/>'); expect(await zip.file('word/people.xml')!.async('string')).not.toContain('presenceInfo');
  const out = await inspect(s.h, 'output.docx');
  expect(out.records.find(item => item.kind === 'comment')!.record).toMatchObject({ comment_ref: 'M1', author: 'Dana Reviewer (via Writer)', initials: 'DR', text: 'Why not sixty?\nPlease check.', resolved: false, anchor: { start_paragraph_ref: 'D1', text: 'thirty days' } });
  expect(out.records.find(item => item.id === 'D1')!.record.text).toBe('Pay within thirty days of receipt.');
  const ambiguous = await save(s, [{ op: 'add_comment', target_ref: 'D1', find: 'i', text: 'x' }]); expect(ambiguous.status).toBe('failed'); expect(ambiguous.output).toContain('occurs exactly once');
});

it('W3 reply and resolve on the Word-saved fixture link the reply to the parent\'s last paragraph and mark the whole thread done', async () => {
  const s = await prepare(await fs.readFile(join(fixture, 'word-revisions.docx')));
  const result = await save(s, [{ op: 'reply_comment', target_ref: 'M1', text: 'Second reply.' }, { op: 'reply_comment', target_ref: 'M3', text: 'On the point.' }, { op: 'resolve_comment', target_ref: 'M3' }]);
  expect(result.status, result.output).toBe('success'); expect(result.output).toContain('Replied to M1: new comment M4'); expect(result.output).toContain('Marked the comment thread of M3 (thread root M3) as resolved.');
  const zip = await output(s); const document = await zip.file('word/document.xml')!.async('string'); const extended = await zip.file('word/commentsExtended.xml')!.async('string');
  expect(extended).toMatch(/w15:paraIdParent="1A000002" w15:done="0"\/>/); expect(extended).toContain('<w15:commentEx w15:paraId="1A000002" w15:done="1"/>');
  expect(extended).toMatch(/<w15:commentEx w15:paraId="1C000001" w15:done="1"\/>.*w15:paraIdParent="1C000001" w15:done="1"\/>/s);
  expect(document).toMatch(/<w:commentRangeStart w:id="13"\/><w:commentRangeStart w:id="(\d+)"\/><w:commentRangeStart w:id="14"\/>/);
  const out = await inspect(s.h, 'output.docx'); const comments = out.records.filter(item => item.kind === 'comment').map(item => item.record);
  expect(comments.map(comment => [comment.comment_ref, comment.parent_ref ?? null, comment.resolved, comment.anchor?.text ?? null])).toEqual([
    ['M1', null, true, 'commented words'], ['M2', 'M1', true, 'commented words'], ['M3', null, true, ''], ['M4', 'M1', true, 'commented words'], ['M5', 'M3', true, '']]);
  for (const name of Object.keys((await JSZip.loadAsync(s.bytes)).files)) if (!['word/document.xml', 'word/comments.xml', 'word/commentsExtended.xml', 'word/commentsIds.xml', '[Content_Types].xml', 'word/_rels/document.xml.rels'].includes(name) && !name.endsWith('/'))
    expect((await zip.file(name)!.async('nodebuffer')).equals(await (await JSZip.loadAsync(s.bytes)).file(name)!.async('nodebuffer')), name).toBe(true);
});

it('W3 a reply to a legacy comment without thread metadata gives its last paragraph an identity and records only the parent and the reply', async () => {
  const bytes = await plain('<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Old</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p><w:p><w:r><w:commentReference w:id="1"/></w:r></w:p>', zip => {
    zip.file('word/comments.xml', `<w:comments xmlns:w="${W}"><w:comment w:id="0" w:author="Old"><w:p><w:r><w:t>Legacy</w:t></w:r></w:p></w:comment><w:comment w:id="1" w:author="Old"><w:p><w:r><w:t>Other</w:t></w:r></w:p></w:comment></w:comments>`);
    zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="c" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>');
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>');
  });
  const s = await prepare(bytes); expect(s.initial.records.find(item => item.id === 'M1')!.record.resolved).toBeNull();
  const result = await save(s, [{ op: 'reply_comment', target_ref: 'M1', text: 'Answer.' }]); expect(result.status, result.output).toBe('success');
  const zip = await output(s); const comments = await zip.file('word/comments.xml')!.async('string'); const extended = await zip.file('word/commentsExtended.xml')!.async('string');
  const parent = /<w:comment w:id="0" w:author="Old"><w:p w14:paraId="([0-9A-F]{8})">/.exec(comments)![1]; expect(comments).toMatch(/^<w:comments [^>]*xmlns:w14="http:\/\/schemas.microsoft.com\/office\/word\/2010\/wordml"[^>]*mc:Ignorable="w14"/);
  expect(extended.match(/<w15:commentEx /g)).toHaveLength(2); expect(extended).toContain(`w15:paraId="${parent}" w15:done="0"`); expect(extended).toContain(`w15:paraIdParent="${parent}"`);
  expect(comments).toContain('<w:comment w:id="1" w:author="Old"><w:p><w:r><w:t>Other</w:t></w:r></w:p></w:comment>');
  const out = await inspect(s.h, 'output.docx'); expect(out.records.filter(item => item.kind === 'comment').map(item => [item.id, item.record.parent_ref ?? null, item.record.resolved])).toEqual([['M1', null, false], ['M2', null, null], ['M3', 'M1', false]]);
});

it('W3 F1 a comment and a direct text edit compose in one track_changes:false request', async () => {
  const s = await prepare(await plain('<w:p><w:r><w:t xml:space="preserve">Alpha beta</w:t></w:r></w:p>'));
  const result = await s.h.tools.run('edit_office', { schema_version: 1, snapshot_ref: s.initial.snapshot, path: 'output.docx', track_changes: false,
    edits: [{ op: 'add_comment', target_ref: 'D1', find: 'Alpha', text: 'note' }, { op: 'replace_text', target_ref: 'D1', find: 'beta', replace: 'BETA', all: false }] });
  expect(result.status, result.output).toBe('success'); expect(result.output).toContain('Direct edit without tracked changes.');
  const document = await (await output(s)).file('word/document.xml')!.async('string'); expect(document).not.toMatch(/<w:(?:ins|del) /);
  const out = await inspect(s.h, 'output.docx'); expect(out.records.find(item => item.id === 'D1')!.record.text).toBe('Alpha BETA');
  expect(out.records.find(item => item.kind === 'comment')!.record).toMatchObject({ text: 'note', anchor: { text: 'Alpha' } });
});

it('W3 F2 a comment in a header can be replied to and the reply is saved beside it', async () => {
  const bytes = await plain('<w:p><w:r><w:t>Alpha beta</w:t></w:r></w:p>', zip => {
    zip.file('word/header1.xml', `<w:hdr xmlns:w="${W}"><w:p><w:r><w:t xml:space="preserve">Header text</w:t></w:r></w:p></w:hdr>`);
    zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="h" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>');
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>');
    zip.file('word/document.xml', `<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Alpha beta</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="h"/></w:sectPr></w:body></w:document>`);
  });
  const s = await prepare(bytes); const header = s.initial.records.find(item => item.kind === 'paragraph' && item.record.story === 'header')!.id;
  const added = await save(s, [{ op: 'add_comment', target_ref: header, find: 'Header', text: 'header note' }]); expect(added.status, added.output).toBe('success');
  await fs.copyFile(join(s.h.root, 'output.docx'), join(s.h.root, 'commented.docx')); const commented = await inspect(s.h, 'commented.docx');
  const reply = await s.h.tools.run('edit_office', { schema_version: 1, snapshot_ref: commented.snapshot, path: 'replied.docx', edits: [{ op: 'reply_comment', target_ref: 'M1', text: 'reply' }] });
  expect(reply.status, reply.output).toBe('success'); expect(reply.output).toContain('Replied to M1: new comment M2');
  const zip = await JSZip.loadAsync(await fs.readFile(join(s.h.root, 'replied.docx'))); const headerXml = await zip.file('word/header1.xml')!.async('string');
  expect(headerXml.match(/commentRangeStart/g)).toHaveLength(2); expect(headerXml.match(/commentReference/g)).toHaveLength(2);
  const out = await inspect(s.h, 'replied.docx');
  expect(out.records.filter(item => item.kind === 'comment').map(item => [item.record.text, item.record.parent_ref ?? null, item.record.anchor?.text ?? null])).toEqual([['header note', null, 'Header'], ['reply', 'M1', 'Header']]);
});
