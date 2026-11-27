/*
 * v0.9.101 G4 (design §6.4, T101-5): a multi-part document whose save is refused keeps its prepared parts; once the
 * boundary allows the save, the same draft is saved once without the parts being sent again; the save checks the
 * boundary as it is then; and the same save again writes nothing. Field T2: a bilingual Word document saved outside
 * the workspace. Real temp folders, the real access owner and the real isolated render worker. The saved file is
 * opened as a ZIP with yauzl, the archive reader the product's Office reader runs, and its document part is read in
 * order: this file needs no compiled out/ tree, so the mutation sandbox can run it.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionLocalReadScopeConsent } from '../localReadScope';
import { folder, saveHost, sha } from './attachmentSaveFixtures';
import { documentRouteRenderer } from './documentRouteFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';

afterEach(removeTemporaryFolders);
// Each test starts the real isolated render worker; give it room when the machine is busy.
vi.setConfig({ testTimeout: 60_000 });

const yauzl: any = require('yauzl');

/** The text runs of word/document.xml, in document order, from the saved file's own bytes. */
async function docxText(file: string): Promise<string> {
  const bytes = await fs.readFile(file);
  const xml = await new Promise<string>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error: Error | null, zip: any) => {
      if (error) { reject(error); return; }
      zip.on('error', reject);
      zip.on('end', () => reject(new Error('word/document.xml is missing')));
      zip.on('entry', (entry: any) => {
        if (entry.fileName !== 'word/document.xml') { zip.readEntry(); return; }
        zip.openReadStream(entry, (streamError: Error | null, stream: NodeJS.ReadableStream) => {
          if (streamError) { reject(streamError); return; }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks).toString('utf8')); });
        });
      });
      zip.readEntry();
    });
  });
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(match => match[1]).join('');
}
function expectInOrder(text: string, expected: string[]) {
  let at = -1;
  for (const marker of expected) {
    const next = text.indexOf(marker, at + 1);
    expect(next, marker).toBeGreaterThan(at); at = next;
  }
}
async function host() {
  const h = await saveHost();
  const tools = h.tools();
  const real = await documentRouteRenderer();
  const renderer = { render: vi.fn((...args: Parameters<typeof real.render>) => real.render(...args)) };
  tools.setDocumentRenderer(renderer);
  tools.beginTurn();
  return { ...h, tools, renderer };
}
const draftFiles = async (tools: any): Promise<string[]> => {
  const root = await (tools.documentDrafts as any).root;
  return root ? fs.readdir(root).catch(() => []) : [];
};

describe('v0.9.101 G4: a prepared draft waits for its save', () => {
  const part = (target: string, blocks: any[], extra: object = {}) => ({ schema_version: 1, path: target, format: 'docx',
    template: 'report-v1', draft: 'summary', document: { title: 'Lease Summary 租賃摘要', language: 'en', blocks }, ...extra });
  const en = (text: string) => ({ type: 'paragraph', content: [{ text }] });
  const zh = (text: string) => ({ type: 'paragraph', content: [{ text, language: 'zh-Hant' }] });
  const PARTS = [[en('PART-ONE English terms')], [zh('PART-TWO 租賃期限為三十六個月')], [en('PART-THREE fees'), zh('費用 PART-THREE')]];
  async function outsideHost() {
    const h = await host();
    const owner = new SessionLocalReadScopeConsent(async () => false);
    h.tools.setLivePathAccess(() => owner.pathAccessFor('r1'));
    const offered: string[] = [];
    h.tools.setOutsideRootObserver(target => offered.push(target));
    const grant = (where: string) => owner.requestPathAccess(where, { requestId: 'r1', isCurrent: () => true },
      async () => ({ permission: 'readwrite', lifetime: 'session' }));
    return { ...h, owner, offered, grant };
  }

  it('the first part names the missing save condition; after the grant the final saves every part once, and a repeat writes nothing', async () => {
    const h = await outsideHost(); const output = await folder('unode-g4-output-');
    const target = path.join(output, 'Lease_Summary_EN_ZH-TW.docx');
    const first = await h.tools.run('write_document', part(target, PARTS[0]));
    expect(first).toMatchObject({ status: 'success', kind: 'unknown' });
    expect(first.output).toContain('part 1 added');
    expect(first.output).toContain('The destination cannot be saved yet: write_document refused: workspace-escape.');
    expect(first.output).toContain('The draft keeps every part meanwhile; keep preparing it.');
    // Known at the first part, through the same offer a refused save makes; nothing rendered or written.
    expect(h.offered).toEqual([target]);
    const second = await h.tools.run('write_document', part(target, PARTS[1]));
    expect(second.status).toBe('success'); expect(second.output).not.toContain('cannot be saved yet');
    const refused = await h.tools.run('write_document', part(target, PARTS[2], { final: true }));
    expect(refused).toMatchObject({ status: 'refused', reason: 'workspace-escape', documentWrite: { code: 'target-refused', targetEffect: 'none' } });
    expect(refused.output).toContain('The document draft is kept with every part');
    expect(refused.output).toContain('final: true and no new blocks');
    expect(h.renderer.render).not.toHaveBeenCalled(); expect(await fs.readdir(output)).toEqual([]);
    expect(await draftFiles(h.tools)).toHaveLength(1);

    await h.grant(output);
    const saved = await h.tools.run('write_document', part(target, [], { final: true }));
    expect(saved).toMatchObject({ status: 'success', documentWrite: { code: 'written', receipt: { format: 'docx', blocks: 4 } } });
    expect(h.renderer.render).toHaveBeenCalledOnce();
    expectInOrder(await docxText(target), ['PART-ONE English terms', 'PART-TWO 租賃期限為三十六個月', 'PART-THREE fees', '費用 PART-THREE']);
    expect(await draftFiles(h.tools)).toEqual([]);
    const bytes = await fs.readFile(target); const before = await fs.stat(target);

    // The same save again (a repeated call or continuation): the saved fact, no render, no second write.
    const repeat = await h.tools.run('write_document', part(target, [], { final: true }));
    expect(repeat).toMatchObject({ status: 'success', kind: 'unknown' });
    expect(repeat).not.toHaveProperty('documentWrite'); expect(repeat).not.toHaveProperty('path');
    expect(repeat.output).toContain('was already saved; this call wrote nothing again');
    expect(repeat.output).toContain(`Document written: ${target}`);
    expect(h.renderer.render).toHaveBeenCalledOnce();
    expect(sha(await fs.readFile(target))).toBe(sha(bytes));
    expect((await fs.stat(target)).mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readdir(output)).toEqual(['Lease_Summary_EN_ZH-TW.docx']);
    // Not a repeat: new blocks under the saved name find no draft, and are never written as a shorter document.
    expect(await h.tools.run('write_document', part(target, [en('MORE')], { final: true })))
      .toMatchObject({ status: 'failed', documentWrite: { code: 'draft-not-found', targetEffect: 'none' } });
    expect(h.renderer.render).toHaveBeenCalledOnce();
  });

  // Audit R3 (85ebb229): two identical final calls outstanding together each passed the repeat check before either save
  // settled, so the draft was rendered and written twice.
  it('two identical final calls at once save the draft once: one render, one write, and the other gets the saved fact', async () => {
    const h = await outsideHost(); const output = await folder('unode-g4-concurrent-');
    const target = path.join(output, 'Lease_Summary_EN_ZH-TW.docx');
    for (const blocks of PARTS) expect((await h.tools.run('write_document', part(target, blocks))).status).toBe('success');
    // Refused together while the destination is not writable: nothing renders, both are refused, the draft stays.
    const refused = await Promise.all([1, 2].map(() => h.tools.run('write_document', part(target, [], { final: true }))));
    expect(refused.map(outcome => outcome.status)).toEqual(['refused', 'refused']);
    expect(h.renderer.render).not.toHaveBeenCalled(); expect(await draftFiles(h.tools)).toHaveLength(1);

    await h.grant(output);
    const saves = await Promise.all([1, 2].map(() => h.tools.run('write_document', part(target, [], { final: true }))));
    expect(h.renderer.render).toHaveBeenCalledOnce();
    expect(saves.filter(outcome => (outcome as any).documentWrite?.code === 'written')).toHaveLength(1);
    const other = saves.find(outcome => (outcome as any).documentWrite === undefined)!;
    expect(other).toMatchObject({ status: 'success', kind: 'unknown' });
    expect(other.output).toContain('was already saved; this call wrote nothing again');
    expect(await fs.readdir(output)).toEqual(['Lease_Summary_EN_ZH-TW.docx']);
    expectInOrder(await docxText(target), ['PART-ONE English terms', 'PART-TWO 租賃期限為三十六個月', 'PART-THREE fees', '費用 PART-THREE']);
    expect(await draftFiles(h.tools)).toEqual([]);
  });

  it('a draft carries no authority: access revoked before the save refuses it, and refuses again while still revoked, keeping the draft', async () => {
    const h = await outsideHost(); const output = await folder('unode-g4-revoked-');
    const target = path.join(output, 'summary.docx');
    const grant = await h.grant(output);
    const first = await h.tools.run('write_document', part(target, PARTS[0]));
    expect(first.status).toBe('success'); expect(first.output).not.toContain('cannot be saved yet');
    expect((await h.tools.run('write_document', part(target, PARTS[1]))).status).toBe('success');
    h.owner.revokePathAccess(grant!.id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await h.tools.run('write_document', part(target, [], { final: true }));
      expect(refused).toMatchObject({ status: 'refused', reason: 'workspace-escape', documentWrite: { code: 'target-refused' } });
      expect(refused.output).toContain('The document draft is kept with every part');
      expect(await draftFiles(h.tools)).toHaveLength(1);
    }
    expect(h.renderer.render).not.toHaveBeenCalled(); expect(await fs.readdir(output)).toEqual([]);
    await h.grant(output);
    const saved = await h.tools.run('write_document', part(target, PARTS[2], { final: true }));
    expect(saved).toMatchObject({ status: 'success', documentWrite: { code: 'written', receipt: { blocks: 4 } } });
    expectInOrder(await docxText(target), ['PART-ONE', 'PART-TWO', 'PART-THREE fees', '費用 PART-THREE']);
    expect(h.renderer.render).toHaveBeenCalledOnce();
  });

  it('the save checks the destination it is given: a changed target outside the grant is refused, the granted one saves the same parts', async () => {
    const h = await outsideHost(); const granted = await folder('unode-g4-granted-'); const other = await folder('unode-g4-other-');
    await h.grant(granted);
    for (const blocks of PARTS.slice(0, 2)) expect((await h.tools.run('write_document', part(path.join(granted, 'a.docx'), blocks))).status).toBe('success');
    const moved = await h.tools.run('write_document', part(path.join(other, 'a.docx'), [], { final: true }));
    expect(moved).toMatchObject({ status: 'refused', reason: 'workspace-escape', documentWrite: { code: 'target-refused' } });
    expect(h.offered).toEqual([path.join(other, 'a.docx')]);
    expect(await fs.readdir(other)).toEqual([]);
    const saved = await h.tools.run('write_document', part(path.join(granted, 'a.docx'), [], { final: true }));
    expect(saved).toMatchObject({ status: 'success', documentWrite: { code: 'written', receipt: { blocks: 2 } } });
    expectInOrder(await docxText(path.join(granted, 'a.docx')), ['PART-ONE', 'PART-TWO']);
    // A saved draft answers a repeat only for its own destination: another one is not the same save.
    expect(await h.tools.run('write_document', part(path.join(granted, 'b.docx'), [], { final: true })))
      .toMatchObject({ status: 'failed', documentWrite: { code: 'draft-not-found' } });
    expect(await fs.readdir(granted)).toEqual(['a.docx']);
  });

  it('a draft belongs to the task attempt it was started in: another attempt of the same agent neither reads nor saves it', async () => {
    const h = await host();
    const attempt = (attemptId: string) => h.tools.setTaskAttempt({ attemptId, agentId: 'dev' } as any);
    attempt('attempt-1');
    expect((await h.tools.run('write_document', part('out/a.docx', PARTS[0]))).status).toBe('success');
    attempt('attempt-2');
    expect(await h.tools.run('write_document', part('out/a.docx', [], { final: true })))
      .toMatchObject({ status: 'failed', documentWrite: { code: 'draft-not-found', targetEffect: 'none' } });
    expect(await fs.readdir(h.root)).toEqual([]);
    attempt('attempt-1');
    expect(await h.tools.run('write_document', part('out/a.docx', [], { final: true })))
      .toMatchObject({ status: 'success', documentWrite: { code: 'written', receipt: { blocks: 1 } } });
    expect(await docxText(path.join(h.root, 'out/a.docx'))).toContain('PART-ONE');
  });
});
