/*
 * v0.9.97: the host's restore point before a change replaces or removes an existing file (handoff §4.3: pin while
 * the write runs and the request's first restore point until the request ends; storage failure refuses the change;
 * one directory per workspace). The tool-level behaviour is in WorkspaceToolsRawCheckpoints.test.ts.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { PreChangeCheckpoints, rawCheckpointLocation } from '../PreChangeCheckpoints';
import { RawCheckpointStore } from '../RawCheckpointStore';

const temps: string[] = [];
async function folder(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-prechange-')));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const target = path.resolve('/ws/a.txt');
const request = (bytes: Buffer | undefined, requestId: string | null = 'r1') => ({
  agentId: 'dev', ...(requestId ? { requestId } : {}), path: 'a.txt', target, physical: target, bytes,
});

async function checkpoints(isRequestRunning: (id: string) => boolean = () => true) {
  const dir = await folder();
  let store: RawCheckpointStore | undefined;
  const pre = new PreChangeCheckpoints({
    open: async () => { store = (await RawCheckpointStore.open({ directory: dir, workspaceId: 'ws' })).store; return store; },
    isRequestRunning,
  });
  return { pre, store: async () => { await pre.store(); return store!; } };
}

describe('PreChangeCheckpoints', () => {
  it('refuses every capture when the store cannot be opened', async () => {
    const pre = new PreChangeCheckpoints({ open: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, isRequestRunning: () => true });
    expect(await pre.capture(request(Buffer.from('x')))).toEqual({
      status: 'refused', code: 'unavailable', reason: 'the restore-point store could not be opened (EACCES).',
    });
  });

  it('refuses a file it was not given whole, as too large to keep', async () => {
    const { pre } = await checkpoints();
    expect(await pre.capture(request(undefined))).toMatchObject({ status: 'refused', code: 'too-large' });
  });

  it('settles once: a later settlement neither removes nor changes the restore point', async () => {
    const { pre, store } = await checkpoints();
    const kept = await pre.capture(request(Buffer.from('before'), null));
    if (kept.status !== 'kept') throw new Error(kept.reason);
    const after = { exists: true as const, size: 5, sha256: 'a'.repeat(64) };
    expect(await kept.checkpoint.settle({ kind: 'committed', after })).toEqual({ id: kept.checkpoint.id, afterSha256: 'a'.repeat(64) });
    expect(await kept.checkpoint.settle({ kind: 'not-committed' })).toBeUndefined();
    expect((await store()).get(kept.checkpoint.id)).toMatchObject({ after });
    // Outside a request nothing holds it once its change has settled.
    expect((await store()).isPinned(kept.checkpoint.id)).toBe(false);
  });

  it('keeps a request\'s pins while it cannot tell whether the request still runs', async () => {
    const { pre, store } = await checkpoints(() => { throw new Error('session manager gone'); });
    const kept = await pre.capture(request(Buffer.from('before')));
    if (kept.status !== 'kept') throw new Error(kept.reason);
    await kept.checkpoint.settle({ kind: 'committed', after: { exists: false } });
    pre.releaseEndedRequests();
    expect((await store()).isPinned(kept.checkpoint.id)).toBe(true);
  });

  it('gives each workspace its own directory under the extension storage', () => {
    const storage = path.resolve('/storage');
    const one = rawCheckpointLocation(storage, path.resolve('/projects/one'));
    const two = rawCheckpointLocation(storage, path.resolve('/projects/two'));
    expect(one.directory).not.toBe(two.directory);
    expect(path.dirname(one.directory)).toBe(path.dirname(two.directory));
    expect(path.basename(one.directory)).toBe(one.workspaceId);
    expect(one.directory.startsWith(storage)).toBe(true);
  });
});
