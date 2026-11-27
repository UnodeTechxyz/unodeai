import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { indexOfficePackage } from '../OfficeInventory';
import { editOfficePackage } from '../OfficeEdits';
import type { OfficeEdit } from '../OfficeEditContracts';
import { wordStoryModelFromXml } from '../word/WordRevisionModel';
import { wordStoryText } from '../word/WordRevisionViews';

// Real Microsoft Word check of tracked output (design 4.3 / R4 condition 6). Windows with Word only, and only when
// UNODE_REAL_WORD=1: the helper starts its own hidden Word instance, uses it only when identified as newly created by
// it, quits only that instance and never ends any other Word process.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const helper = join(__dirname, 'testdata', 'word-revisions', 'word-check.ps1');
const wordText = (text: string) => text.replace(/\r\u0007/g, '\r').split('\r').filter(Boolean);
async function edit(bytes: Buffer, edits: OfficeEdit[], root: string) {
  const source = join(root, 'source.docx'); await writeFile(source, bytes); const directory = join(root, 'parsed'); await mkdir(directory);
  const manifest = await indexOfficePackage(source, directory, 'office-native', 100, 1 << 26, () => {});
  const result = await editOfficePackage({ source, directory, manifest, snapshotRef: 'office-native', edits, tracking: { author: 'Native Check (via Writer)', initials: 'NC', authorSource: 'setting', date: '2026-11-22T08:00:00Z' },
    commentAuthor: { author: 'Native Check (via Writer)', initials: 'NC', authorSource: 'setting', date: '2026-11-22T08:00:00Z' } }, 100, 1 << 26, () => {});
  const output = join(root, 'output.docx'); await writeFile(output, result.bytes); return output;
}
function word(source: string, root: string) {
  const job = join(root, 'job.json'); const result = join(root, 'result.json'); require('node:fs').writeFileSync(job, JSON.stringify({ source, saveAs: null, result }));
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-JobFile', job], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
  const report = JSON.parse(require('node:fs').readFileSync(result, 'utf8').replace(/^\uFEFF/, ''));
  const detail = JSON.stringify({ ...report, accepted: undefined, rejected: undefined }); expect(run.status, run.stderr).toBe(0); expect(report.owned, detail).toBe(true); expect(report.quit, detail).toBe(true); expect(report.error, 'Word opened the file without repair').toBeNull();
  return report as { revisions: Array<{ type: number; author: string }>; accepted: { body: string }; rejected: { body: string }; comments: Array<{ author: string; initial: string; text: string; scope: string; done: boolean | null; ancestor: number }> };
}
async function plain(body: string) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
const p = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const realWord = () => process.env.UNODE_REAL_WORD === '1';
// The platform is decided at collection; the opt-in when each case runs, so Windows discovery lists every case.
describe.runIf(process.platform === 'win32')('real Word round trip of tracked edits', () => {
  it('Word opens tracked replace, paragraph and table inserts without repair; Accept All and Reject All equal the current and original views', async ctx => {
    if (!realWord()) { ctx.skip(); return; }
    const root = await mkdtemp(join(tmpdir(), 'unode-word-native-'));
    try {
      const source = await plain(p('Alpha beta gamma') + p('Middle') + `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t><w:tab/><w:t>tail</w:t></w:r></w:p>` + p('Last'));
      const output = await edit(source, [{ op: 'replace_text', target_ref: 'D1', find: 'beta', replace: 'BETA', all: true }, { op: 'insert_paragraphs', target_ref: 'D2', paragraphs: ['Inserted mid'], position: 'after' },
        { op: 'replace_text', target_ref: 'D3', find: 'd\tt', replace: '-', all: true }, { op: 'insert_table', target_ref: 'D2', rows: [['c1', 'c2'], ['c3', 'c4']], position: 'after', header_row: false },
        { op: 'insert_paragraphs', target_ref: 'D4', paragraphs: ['After the last'], position: 'after' }], root);
      const model = wordStoryModelFromXml((await (await JSZip.loadAsync(await readFile(output))).file('word/document.xml')!.async('string')), 'main');
      const report = word(output, root);
      expect(report.revisions.length).toBeGreaterThan(0); expect(new Set(report.revisions.map(revision => revision.author))).toEqual(new Set(['Native Check (via Writer)']));
      expect(new Set(report.revisions.map(revision => revision.type))).toEqual(new Set([1, 2]));
      expect(wordText(report.accepted.body)).toEqual(wordStoryText(model, 'current').filter(Boolean));
      expect(wordText(report.rejected.body)).toEqual(['Alpha beta gamma', 'Middle', 'Bold\ttail', 'Last']);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 600000);

  it('Word agrees with accept and reject decisions applied to the Word-saved fixture', async ctx => {
    if (!realWord()) { ctx.skip(); return; }
    const root = await mkdtemp(join(tmpdir(), 'unode-word-native-'));
    try {
      const fixture = await readFile(join(__dirname, 'testdata', 'word-revisions', 'word-revisions.docx'));
      const output = await edit(fixture, [{ op: 'accept_revision', target_ref: 'R1' }, { op: 'reject_revision', target_ref: 'R2' }, { op: 'reject_revision', target_ref: 'R6' }, { op: 'reject_revision', target_ref: 'R11' }], root);
      const model = wordStoryModelFromXml((await (await JSZip.loadAsync(await readFile(output))).file('word/document.xml')!.async('string')), 'main');
      const report = word(output, root);
      expect(wordText(report.accepted.body)).toEqual(wordStoryText(model, 'current').filter(Boolean)); expect(wordText(report.rejected.body)).toEqual(wordStoryText(model, 'original').filter(Boolean));
      expect(wordText(report.accepted.body)).toContain('Alpha text.'); expect(wordText(report.accepted.body)).not.toContain('Brand new paragraph.'); expect(wordText(report.accepted.body)).not.toContain('Row two');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 600000);

  it('Word reads added comments, a reply in an existing thread and a resolved thread as written', async ctx => {
    if (!realWord()) { ctx.skip(); return; }
    const root = await mkdtemp(join(tmpdir(), 'unode-word-native-'));
    try {
      const fixture = await readFile(join(__dirname, 'testdata', 'word-revisions', 'word-revisions.docx'));
      const output = await edit(fixture, [{ op: 'reply_comment', target_ref: 'M1', text: 'Native reply.' }, { op: 'add_comment', target_ref: 'D7', find: 'second half', text: 'New native comment.\nSecond line.' },
        { op: 'reply_comment', target_ref: 'M3', text: 'Point reply.' }, { op: 'resolve_comment', target_ref: 'M3' }], root);
      const report = word(output, root);
      // Word lists comments in document order; Ancestor is the parent's position in that list.
      const texts = report.comments.map(comment => comment.text.replace(/\r/g, '\n'));
      const summary = report.comments.map((comment, index) => [comment.author, texts[index], comment.done, comment.ancestor > 0 ? texts[comment.ancestor - 1] : null]);
      expect(summary, JSON.stringify(summary)).toEqual(expect.arrayContaining([['Native Check (via Writer)', 'Native reply.', true, 'First comment line.\nSecond line.'],
        ['Native Check (via Writer)', 'New native comment.\nSecond line.', false, null], ['Native Check (via Writer)', 'Point reply.', true, 'Point note.']]));
      expect(report.comments).toHaveLength(6); expect(report.comments.find(comment => comment.text === 'Point note.')!.done, JSON.stringify(report.comments)).toBe(true);
      expect(report.comments.find(comment => comment.text.startsWith('New native'))!.scope).toBe('second half');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 600000);
});
