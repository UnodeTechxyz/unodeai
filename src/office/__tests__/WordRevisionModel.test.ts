import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { wordStoryModel, wordStoryModelFromXml } from '../word/WordRevisionModel';
import { wordStoryText, wordParagraphText } from '../word/WordRevisionViews';
import { wordComments } from '../word/WordComments';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const fixture = join(__dirname, 'testdata', 'word-revisions');
async function part(name: string) { const zip = await JSZip.loadAsync(await readFile(join(fixture, 'word-revisions.docx'))); return zip.file(name)!.async('nodebuffer'); }
async function expected() { return JSON.parse(await readFile(join(fixture, 'word-revisions.expected.json'), 'utf8')); }
/** Word's Content.Text: CR ends a paragraph, CR+BEL ends a cell or row. Empty entries are dropped on both sides. */
const wordParagraphs = (text: string) => text.replace(/\r\u0007/g, '\r').split('\r').filter(Boolean);
const body = (xml: string) => Buffer.from(`<w:document xmlns:w="${W}"><w:body>${xml}<w:sectPr/></w:body></w:document>`);

describe('W1 revision views against Word Accept All / Reject All', () => {
  it('current and original views equal the text Word produced for the Word-saved three-author fixture', async () => {
    const word = await expected(); const model = wordStoryModel(await part('word/document.xml'), 'main');
    expect(wordStoryText(model, 'current').filter(Boolean)).toEqual(wordParagraphs(word.accepted.body));
    expect(wordStoryText(model, 'original').filter(Boolean)).toEqual(wordParagraphs(word.rejected.body));
    const header = wordStoryModel(await part('word/header1.xml'), 'header');
    expect(wordStoryText(header, 'current')).toEqual(wordParagraphs(word.accepted.header));
    expect(wordStoryText(header, 'original')).toEqual(wordParagraphs(word.rejected.header));
  });

  it('reports each revision with author, kind, nesting and decidability, grouped the way Word lists them', async () => {
    const model = wordStoryModel(await part('word/document.xml'), 'main');
    const summary = model.groups.map(group => ({ kind: group.kind, author: group.author, text: group.text, nested: group.nestedIn?.ordinal, decidable: group.decidable, structure: group.structure }));
    expect(summary).toEqual([
      { kind: 'delete', author: 'Avery Fixture', text: 'old ', nested: undefined, decidable: true, structure: undefined },
      { kind: 'insert', author: 'Avery Fixture', text: 'new ', nested: undefined, decidable: true, structure: undefined },
      { kind: 'insert', author: 'Avery Fixture', text: 'drop ', nested: undefined, decidable: false, structure: undefined },
      { kind: 'delete', author: 'Blake Fixture', text: 'drop ', nested: 3, decidable: false, structure: undefined },
      { kind: 'move-from', author: 'Casey Fixture', text: 'moved words ', nested: undefined, decidable: false, structure: undefined },
      { kind: 'insert', author: 'Blake Fixture', text: 'Brand new paragraph.\n', nested: undefined, decidable: true, structure: undefined },
      { kind: 'move-to', author: 'Casey Fixture', text: 'moved words ', nested: undefined, decidable: false, structure: undefined },
      { kind: 'delete', author: 'Avery Fixture', text: '\n', nested: undefined, decidable: false, structure: 'paragraph-mark' },
      { kind: 'format-paragraph', author: 'Casey Fixture', text: 'Bold now.', nested: undefined, decidable: false, structure: undefined },
      { kind: 'format-run', author: 'Casey Fixture', text: 'Bold now.', nested: undefined, decidable: false, structure: undefined },
      { kind: 'insert', author: 'Avery Fixture', text: 'Row two\n', nested: undefined, decidable: true, structure: 'table-row' },
    ]);
    // Word's own list for the same file: the same authors and change types, with the format and paragraph-property changes listed separately.
    const word = await expected(); const types: Record<number, string> = { 1: 'insert', 2: 'delete', 3: 'format-run', 10: 'format-paragraph', 14: 'move-from', 15: 'move-to' };
    const fromWord = word.revisions.filter((revision: { story: string }) => revision.story === 'body').map((revision: { type: number; author: string }) => `${types[revision.type]}:${revision.author}`).sort();
    expect(model.groups.map(group => `${group.kind}:${group.author}`).sort()).toEqual(fromWord);
  });

  it('markup marks every revision inline and escapes author delimiters', () => {
    const model = wordStoryModelFromXml(`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>a</w:t></w:r><w:ins w:author="A]b:c"><w:r><w:t>B</w:t></w:r></w:ins><w:del w:author="D"><w:r><w:delText>c</w:delText></w:r></w:del>`
      + `<w:moveFrom w:author="M"><w:r><w:t>x</w:t></w:r></w:moveFrom><w:moveTo w:author="M"><w:r><w:t>y</w:t></w:r></w:moveTo><w:commentRangeStart w:id="5"/><w:r><w:t>z</w:t></w:r><w:commentRangeEnd w:id="5"/></w:p></w:body></w:document>`, 'main');
    expect(wordParagraphText(model.paragraphs[0], 'markup', id => id === '5' ? 'M1' : undefined)).toBe('a[+A\\]b\\:c: B][-D: c][<M: x][>M: y]z[#M1]');
    expect(wordParagraphText(model.paragraphs[0], 'current')).toBe('aByz'); expect(wordParagraphText(model.paragraphs[0], 'original')).toBe('acxz');
  });

  it('keeps paragraph ordinals of the stored inventory, skips compatibility alternatives and joins removed paragraph marks', () => {
    const model = wordStoryModel(body('<w:p><w:r><w:t>one</w:t><w:drawing><w:txbxContent><w:p><w:r><w:t>box</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r></w:p>'
      + '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice><w:p><w:r><w:t>hidden</w:t></w:r></w:p></mc:Choice></mc:AlternateContent>'
      + '<w:p><w:pPr><w:rPr><w:del w:author="A"/></w:rPr></w:pPr><w:r><w:t>two </w:t></w:r></w:p><w:p><w:r><w:t>three</w:t></w:r></w:p>'), 'main');
    expect(model.paragraphs.map(paragraph => paragraph.stored)).toEqual(['one', 'box', 'two ', 'three']);
    expect(wordStoryText(model, 'current')).toEqual(['one', 'box', 'two three']); expect(wordStoryText(model, 'original')).toEqual(['one', 'box', 'two ', 'three']);
  });

  it('decides only whole paragraphs and rows: partial, last-paragraph, bookmarked and section-break cases are not decidable', () => {
    const ins = (text: string) => `<w:ins w:author="A" w:date="d"><w:r><w:t>${text}</w:t></w:r></w:ins>`; const mark = '<w:pPr><w:rPr><w:ins w:author="A" w:date="d"/></w:rPr></w:pPr>';
    const decided = (xml: string) => wordStoryModel(body(xml), 'main').groups.map(group => group.decidable);
    expect(decided(`<w:p>${mark}${ins('whole')}</w:p><w:p/>`)).toEqual([true]);
    expect(decided(`<w:p>${mark}<w:r><w:t>kept </w:t></w:r>${ins('part')}</w:p><w:p/>`)).toEqual([false]);
    expect(decided(`<w:p/><w:p>${mark}${ins('last')}</w:p>`)).toEqual([false]);
    expect(decided(`<w:p>${mark}<w:bookmarkStart w:id="1" w:name="b"/>${ins('marked')}</w:p><w:p><w:bookmarkEnd w:id="1"/></w:p>`)).toEqual([false]);
    expect(decided(`<w:p><w:pPr><w:rPr><w:ins w:author="A" w:date="d"/></w:rPr><w:sectPr/></w:pPr>${ins('section')}</w:p><w:p/>`)).toEqual([false]);
    expect(decided(`<w:p>${ins('inline')}<w:r><w:t> plain</w:t></w:r></w:p>`)).toEqual([true]);
    expect(decided(`<w:p><w:ins w:author="A" w:date="d"><w:bookmarkStart w:id="1" w:name="b"/><w:r><w:t>x</w:t></w:r></w:ins><w:bookmarkEnd w:id="1"/></w:p>`)).toEqual([false]);
    const row = (content: string) => `<w:tr><w:trPr><w:ins w:author="A" w:date="d"/></w:trPr><w:tc><w:p>${content}</w:p></w:tc></w:tr>`;
    expect(decided(`<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr>${row(`${mark.replace('<w:pPr>', '<w:pPr>')}${ins('r')}`)}</w:tbl><w:p/>`)).toEqual([true]);
    expect(decided(`<w:tbl>${row(`${mark}${ins('only row')}`)}</w:tbl><w:p/>`)).toEqual([false]);
  });

  it('reads comment threads, the last-paragraph link and the resolved state from the Word fixture', async () => {
    const set = wordComments({ comments: await part('word/comments.xml'), extended: await part('word/commentsExtended.xml'), ids: await part('word/commentsIds.xml') });
    expect(set.comments.map(comment => ({ id: comment.id, author: comment.author, text: comment.text, parent: set.parent(comment)?.id, resolved: set.resolved(comment) }))).toEqual([
      { id: '13', author: 'Avery Fixture', text: 'First comment line.\nSecond line.', parent: undefined, resolved: true },
      { id: '14', author: 'Blake Fixture', text: 'Reply text.', parent: '13', resolved: true },
      { id: '15', author: 'Casey Fixture', text: 'Point note.', parent: undefined, resolved: false },
    ]);
    const word = await expected();
    expect(word.comments.map((comment: { author: string; done: boolean; ancestor: number }) => [comment.author, comment.done, comment.ancestor])).toEqual([['Avery Fixture', true, 0], ['Blake Fixture', true, 1], ['Casey Fixture', false, 0]]);
    expect(wordComments({ comments: await part('word/comments.xml') }).resolved(set.comments[0])).toBeNull();
  });
});
