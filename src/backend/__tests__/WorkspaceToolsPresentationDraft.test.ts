import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveHost } from './attachmentSaveFixtures';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import { presentationInput, presentationRouteRenderer } from './presentationRouteFixtures';
import { isGovernedWorkspaceTool } from '../requestBoundary';
import { SessionLocalReadScopeConsent } from '../localReadScope';
import { FileWritePolicy } from '../fileWritePolicy';

afterEach(removeTemporaryFolders);
function part(text: string, final = false) {
  return { ...presentationInput(), draft: 'report', final, deck: { title: 'Report', slides: text ? [{ objects: [
    { type: 'text', text, x: 0.5, y: 0.5, w: 10, h: 1 },
  ] }] : [] } };
}
async function host(options: Parameters<typeof saveHost>[0] = {}) {
  const h = await saveHost(options); const tools = h.tools(); const real = await presentationRouteRenderer();
  const renderer = { render: vi.fn((...args: Parameters<typeof real.render>) => real.render(...args)) };
  tools.setPresentationRenderer(renderer); tools.beginTurn(); return { ...h, tools, renderer };
}
async function slides(file: string) {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const names = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  return Promise.all(names.sort((a, b) => Number(a.match(/slide(\d+)\.xml/)![1]) - Number(b.match(/slide(\d+)\.xml/)![1]))
    .map(name => zip.file(name)!.async('string')));
}

describe('O3 disk-backed presentation draft production flows', () => {
  it('keeps ordinary replacement available without adding a decision-surface requirement', async () => {
    const h = await host(); const target = path.join(h.root, 'out/result.pptx');
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'USER EXISTING FILE');
    const writes = new FileWritePolicy({ workspaceId: () => h.root, isRequestRunning: () => true })
      .forAgent({ agentId: 'dev', base: h.root, requestId: () => 'r1' });
    h.tools.setFileWrites(writes); h.tools.beginTurn();
    await h.tools.run('write_presentation', part('FIRST'));
    const result = await h.tools.run('write_presentation', part('LAST', true));
    expect(result.status, result.output).toBe('success');
    expect(await slides(target)).toHaveLength(2); expect(h.state.approvals).toEqual([]);
  });
  it('a draft final refused at its destination preserves Read + Write detail and saves kept slides once after the real grant', async () => {
    const h = await host(); const owner = new SessionLocalReadScopeConsent(async () => false);
    const target = path.join(await temporaryFolder('unode-ppt-grant-'), 'outside.pptx');
    await owner.requestPathAccess(path.dirname(target), { requestId: 'r1', isCurrent: () => true },
      async () => ({ permission: 'read', lifetime: 'session' }));
    h.tools.setLivePathAccess(() => owner.pathAccessFor('r1'));
    const single = await h.tools.run('write_presentation', { ...presentationInput(), path: target });
    expect(single).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    await h.tools.run('write_presentation', { ...part('FIRST'), path: target });
    const refused = await h.tools.run('write_presentation', { ...part('LAST', true), path: target });
    expect(refused).toMatchObject({ status: 'refused', reason: single.status === 'refused' ? single.reason : 'workspace-escape',
      presentationWrite: { code: 'target-refused', targetEffect: 'none' } });
    expect(refused.output).toContain('Read + Write');
    expect(refused.output).toContain('whole presentation draft is kept');
    expect(refused.output).toContain('final: true and no new slides');
    expect(h.renderer.render).not.toHaveBeenCalled();
    await owner.requestPathAccess(target, { requestId: 'r1', isCurrent: () => true },
      async () => ({ permission: 'readwrite', lifetime: 'request' }));
    h.tools.beginTurn();
    const saved = await h.tools.run('write_presentation', { ...part('', true), path: target });
    expect(saved.status, saved.output).toBe('success');
    const xml = await slides(target); expect(xml).toHaveLength(2); expect(xml[0]).toContain('FIRST'); expect(xml[1]).toContain('LAST');
    expect(h.renderer.render).toHaveBeenCalledTimes(1);
  });
  it('keeps large parts off the workspace, holds only the final save, writes one ordered deck and coalesces duplicate final saves', async () => {
    const h = await host(); const boundary = vi.fn(async () => 'proceed' as const); h.tools.setRequestBoundary(boundary);
    const first = part('A'.repeat(75000) + ' FIRST');
    expect(isGovernedWorkspaceTool('write_presentation', first)).toBe(false);
    expect((await h.tools.run('write_presentation', first)).status).toBe('success');
    expect(await fs.readdir(h.root)).toEqual([]); expect(boundary).not.toHaveBeenCalled(); expect(h.renderer.render).not.toHaveBeenCalled();
    expect((await h.tools.run('write_presentation', part('SECOND'))).status).toBe('success');
    const final = { ...part('THIRD', true), path: 'out/final.pptx', deck: { ...part('THIRD').deck, title: 'Final title', layout: 'standard' } };
    const [saved, repeated] = await Promise.all([h.tools.run('write_presentation', final),
      h.tools.run('write_presentation', { ...final, deck: { ...final.deck, slides: [] } })]);
    expect(saved.status, saved.output).toBe('success'); expect(repeated.output).toContain('already saved'); expect(h.renderer.render).toHaveBeenCalledTimes(1);
    const alternate = await h.tools.run('write_presentation', { ...final, path: path.resolve(h.root, final.path), deck: { ...final.deck, slides: [] } });
    expect(alternate.output).toContain('already saved'); expect(h.renderer.render).toHaveBeenCalledTimes(1);
    const xml = await slides(path.join(h.root, 'out/final.pptx'));
    expect(xml).toHaveLength(3); expect(xml[0]).toContain('FIRST'); expect(xml[1]).toContain('SECOND'); expect(xml[2]).toContain('THIRD');
    const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'out/final.pptx')));
    expect(await zip.file('docProps/core.xml')!.async('string')).toContain('Final title');
    expect(await zip.file('ppt/presentation.xml')!.async('string')).toContain('cx="9144000" cy="6858000"');
  });

  it('retains the final part after an Ask denial and retries it with no new slides', async () => {
    let allow = false; const h = await host({ ask: true, approve: async () => allow ? 'once' : 'deny' });
    await h.tools.run('write_presentation', part('FIRST'));
    const denied = await h.tools.run('write_presentation', part('LAST', true));
    expect(denied.status).toBe('refused'); expect(denied.output).toContain('whole presentation draft is kept');
    await expect(fs.stat(path.join(h.root, 'out/result.pptx'))).rejects.toMatchObject({ code: 'ENOENT' });
    allow = true; const saved = await h.tools.run('write_presentation', part('', true)); expect(saved.status).toBe('success');
    const xml = await slides(path.join(h.root, 'out/result.pptx')); expect(xml).toHaveLength(2); expect(xml[1]).toContain('LAST');
  });

  it('Stop discards every part and another task attempt never gets a prior attempt’s deck by name', async () => {
    const h = await host(); const signal = new AbortController();
    await h.tools.run('write_presentation', part('FIRST'), { signal: signal.signal }); signal.abort();
    expect((await h.tools.run('write_presentation', part('', true))).presentationWrite?.code).toBe('draft-not-found');
    await h.tools.run('write_presentation', part('PRIVATE'));
    h.tools.setTaskAttempt({ attemptId: 'another', agentId: 'dev' } as any);
    expect((await h.tools.run('write_presentation', part('', true))).presentationWrite?.code).toBe('draft-not-found');
    h.tools.retire(); await expect(fs.stat(path.join(h.root, 'out/result.pptx'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
