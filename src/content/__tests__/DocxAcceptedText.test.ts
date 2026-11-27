import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { docxAcceptedText, docxContainsComments } from '../DocxAcceptedText';
import { extractWorkspaceDocument, workerHeapMb } from '../ContentAssetStore';
import { saveHost } from '../../backend/__tests__/attachmentSaveFixtures';
import { removeTemporaryFolders } from '../../backend/__tests__/pathSafetyFixtures';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
afterEach(removeTemporaryFolders);
it('reads a real Word-saved revision fixture like Word Accept All and reports its comments through read_file', async () => {
  const bytes = await readFile(join(__dirname, 'fixtures/a7/word-revisions.docx'));
  const accepted = await readFile(join(__dirname, 'fixtures/a7/word-accepted.docx'));
  const expected = 'Start NEW CLAUSE end.\n\nMoved clause.\n\nField result stays.\n\nFormatting stays.\n\nCommented clause.';
  const result = await extractWorkspaceDocument(bytes); expect(result.error).toBeUndefined();
  expect(result.text!.split('\n\n').filter(block => !block.startsWith('[DOCX notice]')).join('\n\n')).toBe(expected);
  expect(result.text).toContain('contains tracked changes'); expect(result.text).toContain('contains comments'); expect(result.text).toContain('inspect_office');
  const nativeAccepted = await extractWorkspaceDocument(accepted); expect(nativeAccepted.text!.split('\n\n').filter(block => !block.startsWith('[DOCX notice]')).join('\n\n')).toBe(expected);
  expect(nativeAccepted.text).not.toContain('contains tracked changes');
  const h = await saveHost(); const tools = h.tools();
  try {
    await writeFile(join(h.root, 'contract.docx'), bytes);
    const read = await tools.run('read_file', { path: 'contract.docx', line_numbers: false }); expect(read.status, read.output).toBe('success');
    expect(read.output).toContain(expected); expect(read.output).not.toMatch(/OLD CLAUSE|DELETED_FIELD|DELETED_FIELD_RESULT/);
    expect(read.output.match(/Moved clause\./g)).toHaveLength(1); expect(read.output).toContain('contains tracked changes');
    expect(await readFile(join(h.root, 'contract.docx'))).toEqual(bytes);
  } finally { tools.retire(); await tools.disposeBackground(); await h.assets.dispose(); }
});
it.each(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'])('drops deleted fields and moved-from text by namespace (%s), including nested deletion', uri => {
  const xml = `<q:document xmlns:q="${uri}"><q:p><q:del><q:ins><q:t>WRONG</q:t></q:ins></q:del><q:delText>WRONG</q:delText><q:delInstrText>DELETED_FIELD</q:delInstrText><q:moveFrom><q:t>OLD PLACE</q:t></q:moveFrom><q:moveTo><q:t>RIGHT</q:t></q:moveTo></q:p></q:document>`;
  const result = docxAcceptedText(xml); expect(result.revisions).toBe(true); expect(result.xml).not.toMatch(/WRONG|DELETED_FIELD|OLD PLACE/); expect(result.xml).toContain('RIGHT');
});
it('keeps legacy plain extraction identical, including empty comments parts and literal revision-looking text', async () => {
  const xml = `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>A &lt; B &amp; C</w:t><w:tab/><w:t>word</w:t><w:br/><w:t>next</w:t></w:r></w:p><w:p><w:r><w:t>End</w:t></w:r></w:p></w:body></w:document>`;
  expect(docxAcceptedText(xml)).toEqual({ xml, revisions: false, comments: false });
  const zip = new JSZip(); zip.file('word/document.xml', xml); zip.file('word/comments.xml', `<w:comments xmlns:w="${W}"/>`);
  expect(await extractWorkspaceDocument(await zip.generateAsync({ type: 'nodebuffer' }))).toEqual({ text: 'A < B & C word\nnext\n\nEnd' });
  expect(docxContainsComments(`<w:comments xmlns:w="${W}"><w:comment w:id="0"/></w:comments>`)).toBe(true);
  expect(docxAcceptedText('<x:document xmlns:x="urn:other"><x:del>keep</x:del></x:document>').revisions).toBe(false);
});
it('reads a ten-megabyte tracked body within the same real-worker heap as the unchanged plain path', async () => {
  const paragraphs = Array.from({ length: 100000 }, (_, index) => `<w:p><w:r><w:t>ROW${index} ${createHash('sha256').update(String(index)).digest('hex')}</w:t></w:r></w:p>`).join('');
  const xml = `<w:document xmlns:w="${W}"><w:body>${paragraphs}</w:body></w:document>`;
  const plainZip = new JSZip(); plainZip.file('word/document.xml', xml);
  const trackedZip = new JSZip(); trackedZip.file('word/document.xml', xml.replace('<w:r>', '<w:ins w:id="1"><w:r>').replace('</w:r>', '</w:r></w:ins>'));
  const plain = await plainZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }); const tracked = await trackedZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  expect(Buffer.byteLength(xml)).toBeGreaterThan(10 * 1024 * 1024); expect(workerHeapMb(plain.length)).toBe(workerHeapMb(tracked.length));
  const before = await extractWorkspaceDocument(plain); expect(before.error).toBeUndefined();
  const after = await extractWorkspaceDocument(tracked); expect(after.error).toBeUndefined();
  expect(after.text!.split('\n\n').filter(block => !block.startsWith('[DOCX notice]')).join('\n\n')).toBe(before.text);
  expect(after.text).toContain('contains tracked changes');
  console.info(JSON.stringify({ xmlBytes: Buffer.byteLength(xml), plainBytes: plain.length, trackedBytes: tracked.length, workerHeapMb: workerHeapMb(tracked.length) }));
}, 30000);
it.each(['malformed', 'unsupported', 'oversized'] as const)('keeps body reads available when optional comments are %s', async issue => {
  const zip = new JSZip(); zip.file('word/document.xml', `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Body survives.</w:t></w:r></w:p></w:body></w:document>`);
  zip.file('word/comments.xml', issue === 'malformed' ? `<w:comments xmlns:w="${W}"><w:comment` : 'optional comments metadata');
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  if (issue !== 'malformed') {
    // Unsupported method or excessive declared expansion only on the optional comments entry.
    for (let at = 0; at < bytes.length - 46; at++) if (bytes.readUInt32LE(at) === 0x02014b50) {
      const length = bytes.readUInt16LE(at + 28); if (bytes.toString('utf8', at + 46, at + 46 + length) === 'word/comments.xml') {
        if (issue === 'unsupported') bytes.writeUInt16LE(99, at + 10); else bytes.writeUInt32LE(100 * 1024 * 1024, at + 24);
      }
    }
  }
  const result = await extractWorkspaceDocument(bytes); expect(result.error).toBeUndefined(); expect(result.text).toContain('Body survives.');
  expect(result.text).toContain('comments part that could not be inspected');
});
it('W1: read_file shows the W1 current view of the Word-saved three-author fixture and ends with the revision and comment summary', async () => {
  const { wordStoryModel } = await import('../../office/word/WordRevisionModel'); const { wordStoryText } = await import('../../office/word/WordRevisionViews');
  const bytes = await readFile(join(__dirname, '../../office/__tests__/testdata/word-revisions/word-revisions.docx'));
  const model = wordStoryModel(await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('nodebuffer'), 'main');
  const normalized = wordStoryText(model, 'current').map(text => text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim()).filter(Boolean);
  const result = await extractWorkspaceDocument(bytes); expect(result.error).toBeUndefined();
  const blocks = result.text!.split('\n\n'); expect(blocks.filter(block => !block.startsWith('[DOCX notice]'))).toEqual(normalized);
  expect(normalized).toContain('First half second half.'); expect(normalized).not.toContain('Before moved words after.');
  expect(blocks.at(-1)).toBe('[DOCX notice] Revisions: 11 by 3 authors; comments: 3 (1 unresolved). Use inspect_office for details.');
});
it('W1: a removed paragraph mark joins the next paragraph, also an empty one, and a deleted row is omitted; no join across a table', () => {
  const del = '<w:pPr><w:rPr><w:del w:id="1" w:author="A"/></w:rPr></w:pPr>';
  const run = (text: string) => `<w:r><w:t>${text}</w:t></w:r>`;
  const xml = `<w:document xmlns:w="${W}"><w:body><w:p>${del}${run('one ')}</w:p><w:bookmarkStart w:id="2" w:name="b"/><w:p>${run('two')}</w:p>`
    + `<w:p>${del}${run('three')}</w:p><w:p/><w:p>${run('four')}</w:p><w:p>${del}${run('five')}</w:p><w:tbl><w:tr><w:trPr><w:del w:id="3" w:author="A"/></w:trPr><w:tc><w:p>${run('gone row')}</w:p></w:tc></w:tr>`
    + `<w:tr><w:tc><w:p>${run('kept row')}</w:p></w:tc></w:tr></w:tbl><w:p>${run('six')}</w:p></w:body></w:document>`;
  const blocks = [...docxAcceptedText(xml).xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map(match => match[1].replace(/<[^>]+>/g, ''));
  expect(blocks).toEqual(['one two', 'three', 'four', 'five', 'kept row', 'six']);
});
