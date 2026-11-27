/*
 * v0.9.110 R1a, Codex's audit of 25ef2cf3 (F1–F6): each finding's trigger through the production APIs.
 */
import { createHash, randomUUID } from 'crypto';
import { realpathSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileWritePolicy } from '../fileWritePolicy';
import { PreChangeCheckpoints } from '../PreChangeCheckpoints';
import { RawCheckpointStore } from '../RawCheckpointStore';
import { WorkspaceTools } from '../WorkspaceTools';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import { GenerationLease, type HeldLease } from '../../history/GenerationLease';
import { FileWriterLeases } from '../../history/FileWriterLeases';
import { HistoryService } from '../../history/HistoryService';
import { HistoryStore } from '../../history/HistoryStore';
import type { ProcessIdentityAdapter, ProcessLiveness, ProcessIdentityRecord } from '../../host/processIdentity/ProcessIdentityHost';

const pendingIdle: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const idle of pendingIdle.splice(0)) await idle();
  await removeTemporaryFolders();
});

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const liveness = new Map<number, ProcessLiveness>();
const identity: ProcessIdentityAdapter = {
  platform: 'linux', self: async () => 'unknown', identityOf: async () => 'unknown',
  liveness: async (records) => records.map((record) => liveness.get(record.pid) ?? 'unknown'),
};
const rec = (pid: number): ProcessIdentityRecord => ({ pid, startToken: String(pid), bootToken: 'boot', platform: 'linux' });

async function folder(prefix: string): Promise<string> {
  return realpathSync.native(await temporaryFolder(prefix));
}

class State {
  readonly values = new Map<string, unknown>();
  get(key: string): unknown { return this.values.get(key); }
  async update(key: string, value: unknown): Promise<void> { if (value === undefined) this.values.delete(key); else this.values.set(key, value); }
}

function coordinated(directory: string, host: string, pid: number, extra: { limits?: { maxEntries?: number; maxTotalBytes?: number } } = {}) {
  return RawCheckpointStore.open({
    directory, workspaceId: 'w',
    coordination: {
      lease: new GenerationLease(path.join(directory, 'lock'), { hostInstanceId: host, selfIdentity: async () => rec(pid), identity }),
      hostInstanceId: host, hostsGone: async () => new Set(),
    },
    ...(extra.limits ? { limits: extra.limits } : {}),
  });
}

describe('F1: a contender paused across pruning never holds alongside a newer holder', () => {
  it('detects that its generation is stale and stays busy', async () => {
    const dir = path.join(await folder('unode-r1a-f1-'), 'lease');
    liveness.set(1, 'alive');
    liveness.set(2, 'alive');
    const seed = new GenerationLease(dir, { hostInstanceId: 'seed', selfIdentity: async () => rec(3), identity });
    const first = await seed.tryAcquire('test');
    if (first.status !== 'held') throw new Error('seed not held');
    await first.lease.release();
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    let scanned!: () => void;
    const reachedPause = new Promise<void>((resolve) => { scanned = resolve; });
    const slow = new GenerationLease(dir, { hostInstanceId: 'slow', identity,
      selfIdentity: async () => { scanned(); await paused; return rec(1); } });
    const fast = new GenerationLease(dir, { hostInstanceId: 'fast', selfIdentity: async () => rec(2), identity });
    const slowAttempt = slow.tryAcquire('test');
    await reachedPause;
    let held: HeldLease | undefined;
    for (let i = 0; i < 3; i++) {
      const attempt = await fast.tryAcquire('test');
      if (attempt.status !== 'held') throw new Error('fast not held');
      if (i < 2) await attempt.lease.release(); else held = attempt.lease;
    }
    expect(held!.generation).toBe(4);
    resume();
    const result = await slowAttempt;
    expect(result.status).toBe('busy');
    expect((await fast.scan()).latest).toBe(4);
    await held!.release();
  });
});

describe('F2: pins another window already wrote are honoured by eviction', () => {
  it('keeps an entry another window pinned, whatever this window cached', async () => {
    liveness.set(1, 'alive');
    liveness.set(2, 'alive');
    const directory = path.join(await folder('unode-r1a-f2-'), 'raw-v2');
    const { store: a } = await coordinated(directory, 'host-a', 1);
    const captured = await a.capture({ agentId: 'dev', path: 'x', target: path.join(directory, '..', 'x.txt'), bytes: Buffer.from('payload') });
    if (captured.status !== 'captured') throw new Error(captured.reason);
    captured.pin.release();
    await a.idle();
    const { store: b } = await coordinated(directory, 'host-b', 2);
    const pin = await b.pinDurable(captured.entry.id);
    expect(pin).toBeDefined();
    a.evictOldest();
    await a.idle();
    expect(await b.readBefore(captured.entry.id)).toEqual({ status: 'read', bytes: Buffer.from('payload') });
    expect(a.get(captured.entry.id)).toBeDefined();
    pin!.release();
    await b.idle();
    // The pin is gone from the shared index once released.
    const index = JSON.parse(await fs.readFile(path.join(directory, 'index.json'), 'utf8')) as { entries: Array<{ id: string; pins?: string[] }> };
    expect(index.entries.find((entry) => entry.id === captured.entry.id)?.pins ?? []).toEqual([]);
  });

  it('gives no durable pin for an entry that is gone', async () => {
    const directory = path.join(await folder('unode-r1a-f2b-'), 'raw-v2');
    const { store } = await coordinated(directory, 'host-a', 1);
    expect(await store.pinDurable('0'.repeat(32))).toBeUndefined();
  });
});

async function writer(options: { openFails?: boolean } = {}) {
  liveness.set(1, 'alive');
  const root = await folder('unode-r1a-ws-');
  const storage = await folder('unode-r1a-storage-');
  const history = new HistoryService({
    open: () => HistoryStore.open({ directory: path.join(storage, 'history'), workspaceId: 'w'.repeat(8), writerId: randomUUID() }),
    state: new State(),
  });
  let raw: RawCheckpointStore | undefined;
  const checkpoints = new PreChangeCheckpoints({
    open: async () => {
      if (options.openFails) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      raw = (await coordinated(path.join(storage, 'raw-v2'), 'host-me', 1)).store;
      return raw;
    },
    isRequestRunning: () => true,
    recovery: { captured: (capture) => history.recoveryCaptured(capture), settled: (settle) => history.recoverySettled(settle) },
  });
  const policy = new FileWritePolicy({ workspaceId: () => 'workspace', isRequestRunning: () => true, checkpoints });
  const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'dev', undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, () => {}, () => false, undefined, undefined, undefined, undefined, [], () => true, [root]);
  tools.setFileWrites(policy.forAgent({ agentId: 'dev', requestId: () => 'r1', decide: async () => 'once', notice: () => {} }));
  pendingIdle.push(async () => { await raw?.idle(); await history.flush(); });
  const manifest = async () => {
    await history.flush();
    const store = (await history.store())!;
    await store.refresh();
    return store.recoveryManifest('r1');
  };
  return { root, tools, checkpoints, manifest, raw: () => raw };
}

describe('F3: an attempt proven not made never supplies the before state', () => {
  it('takes the before and its restore point from the first change that was made', async () => {
    const w = await writer();
    const file = path.join(w.root, 'f.txt');
    await fs.writeFile(file, 'original\n');
    const first = await w.checkpoints.capture({ agentId: 'dev', requestId: 'r1', path: 'f.txt', target: file, physical: file, bytes: Buffer.from('original\n') });
    if (first.status !== 'kept') throw new Error('first not kept');
    await first.checkpoint.settle({ kind: 'not-committed' });
    const second = await w.checkpoints.capture({ agentId: 'dev', requestId: 'r1', path: 'f.txt', target: file, physical: file, bytes: Buffer.from('original\n') });
    if (second.status !== 'kept') throw new Error('second not kept');
    await fs.writeFile(file, 'changed\n');
    await second.checkpoint.settle({ kind: 'committed', after: { exists: true, size: 8, sha256: sha('changed\n') } });
    const manifest = (await w.manifest())!;
    expect(manifest.files).toHaveLength(1);
    const ref = (manifest.files[0].before as { payloadRef: string }).payloadRef;
    expect(ref).toBe(second.checkpoint.id);
    expect(await w.raw()!.readBefore(ref)).toEqual({ status: 'read', bytes: Buffer.from('original\n') });
    expect(manifest.label).toBe('Revertible');
  });
});

describe('F4: a write made while the restore-point store cannot open is still in the manifest', () => {
  it('records the file as changed without a restore point, with what the write left', async () => {
    const w = await writer({ openFails: true });
    await fs.writeFile(path.join(w.root, 'g.txt'), 'original\n');
    await w.tools.run('read_file', { path: 'g.txt' });
    expect((await w.tools.run('write_file', { path: 'g.txt', content: 'changed\n' })).status).toBe('success');
    const manifest = (await w.manifest())!;
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]).toMatchObject({ coverage: 'unknown', before: { kind: 'file', sha256: sha('original\n') },
      after: { kind: 'file', sha256: sha('changed\n') } });
    expect(manifest.files[0].reason).toMatch(/no restore point was kept/);
    expect(manifest.label).toBe('Not revertible');
  });
});

describe('F5: the five-second wait covers queries, and Stop ends it', () => {
  it('returns busy within the wait even when each liveness query is slow', async () => {
    const dir = path.join(await folder('unode-r1a-f5-'), 'lease');
    const holder = new GenerationLease(dir, { hostInstanceId: 'holder', selfIdentity: async () => rec(9), identity });
    expect((await holder.tryAcquire('test')).status).toBe('held');
    const clock = { t: 0 };
    const slowIdentity: ProcessIdentityAdapter = { ...identity, liveness: () => new Promise(() => {}) };
    const waiter = new GenerationLease(dir, { hostInstanceId: 'waiter', selfIdentity: async () => rec(8), identity: slowIdentity,
      now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, timeout: async (ms) => { clock.t += ms; } });
    const result = await waiter.acquire('test', { waitMs: 5_000 });
    expect(result).toEqual({ status: 'busy', holder: 'unknown' });
    expect(clock.t).toBeLessThanOrEqual(5_100);
  });

  it('bounds a query that never answers by the real time left in the wait', async () => {
    const dir = path.join(await folder('unode-r1a-f5r-'), 'lease');
    const holder = new GenerationLease(dir, { hostInstanceId: 'holder', selfIdentity: async () => rec(9), identity });
    expect((await holder.tryAcquire('test')).status).toBe('held');
    const silent: ProcessIdentityAdapter = { ...identity, liveness: () => new Promise(() => {}) };
    const waiter = new GenerationLease(dir, { hostInstanceId: 'waiter', selfIdentity: async () => rec(8), identity: silent });
    const started = Date.now();
    const result = await waiter.acquire('test', { waitMs: 300 });
    expect(result).toEqual({ status: 'busy', holder: 'unknown' });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('a stopped write does not wait and writes nothing', async () => {
    liveness.set(5, 'alive');
    const root = await folder('unode-r1a-f5b-');
    const storage = await folder('unode-r1a-f5b-storage-');
    const clock = { t: 0 };
    const leases = new FileWriterLeases(path.join(storage, 'leases'), { hostInstanceId: 'me', selfIdentity: async () => rec(1), identity,
      now: () => clock.t, sleep: async (ms) => { clock.t += ms; } });
    const other = new FileWriterLeases(path.join(storage, 'leases'), { hostInstanceId: 'other', selfIdentity: async () => rec(5), identity });
    expect((await other.acquire(path.join(root, 'h.txt'), { waitMs: 0 })).status).toBe('held');
    const policy = new FileWritePolicy({ workspaceId: () => 'workspace', fileLeases: leases });
    const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'dev', undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, () => {}, () => false, undefined, undefined, undefined, undefined, [], () => true, [root]);
    tools.setFileWrites(policy.forAgent({ agentId: 'dev', requestId: () => 'r1', decide: async () => 'once', notice: () => {} }));
    const stop = new AbortController();
    stop.abort();
    const result = await tools.run('write_file', { path: 'h.txt', content: 'x\n' }, { signal: stop.signal } as never);
    expect(result.status).not.toBe('success');
    expect(clock.t).toBe(0);
    expect(await fs.access(path.join(root, 'h.txt')).then(() => true, () => false)).toBe(false);
  });
});

describe('re-audit of 80ca14a6', () => {
  it('F5: a hold a retry gets after the wait has ended is not used: no write, and no hold kept', async () => {
    liveness.set(5, 'alive');
    const root = await folder('unode-r1a-late-');
    const storage = await folder('unode-r1a-late-storage-');
    const clock = { t: 0 };
    const other = new FileWriterLeases(path.join(storage, 'leases'), { hostInstanceId: 'other', selfIdentity: async () => rec(5), identity });
    const held = await other.acquire(path.join(root, 'late.txt'), { waitMs: 0 });
    if (held.status !== 'held') throw new Error('other not held');
    let released = false;
    const leases = new FileWriterLeases(path.join(storage, 'leases'), {
      hostInstanceId: 'me', identity,
      // The other writer finishes just before the end of the wait; this window's publication then lands after it.
      selfIdentity: async () => { clock.t += 250; return rec(1); },
      now: () => clock.t,
      sleep: async (ms) => { clock.t += ms; if (!released && clock.t >= 4_850) { released = true; await held.release(); } },
    });
    const policy = new FileWritePolicy({ workspaceId: () => 'workspace', fileLeases: leases });
    const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'dev', undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, () => {}, () => false, undefined, undefined, undefined, undefined, [], () => true, [root]);
    tools.setFileWrites(policy.forAgent({ agentId: 'dev', requestId: () => 'r1', decide: async () => 'once', notice: () => {} }));
    const result = await tools.run('write_file', { path: 'late.txt', content: 'late write\n' });
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/^Write blocked:/);
    expect(await fs.access(path.join(root, 'late.txt')).then(() => true, () => false)).toBe(false);
    // Nothing was kept: another window takes the file at once.
    const after = await other.acquire(path.join(root, 'late.txt'), { waitMs: 0 });
    expect(after.status).toBe('held');
  });

  it('F5: a first attempt that spends the wait proving the previous holder gone does not write after the wait', async () => {
    const root = await folder('unode-r1a-first-');
    const storage = await folder('unode-r1a-first-storage-');
    const clock = { t: 0 };
    // A holder that exited without releasing; proving it gone takes most of the wait.
    const crashed = new FileWriterLeases(path.join(storage, 'leases'), { hostInstanceId: 'crashed', selfIdentity: async () => rec(6), identity });
    expect((await crashed.acquire(path.join(root, 'first.txt'), { waitMs: 0 })).status).toBe('held');
    const slowProof: ProcessIdentityAdapter = { ...identity, liveness: async (records) => { clock.t += 4_900; return records.map(() => 'gone' as const); } };
    const leases = new FileWriterLeases(path.join(storage, 'leases'), {
      hostInstanceId: 'me', identity: slowProof, now: () => clock.t, sleep: async (ms) => { clock.t += ms; },
      timeout: () => new Promise(() => {}),
      // Publishing the successor then takes another 250 ms.
      selfIdentity: async () => { clock.t += 250; return rec(1); },
    });
    const policy = new FileWritePolicy({ workspaceId: () => 'workspace', fileLeases: leases });
    const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'dev', undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, () => {}, () => false, undefined, undefined, undefined, undefined, [], () => true, [root]);
    tools.setFileWrites(policy.forAgent({ agentId: 'dev', requestId: () => 'r1', decide: async () => 'once', notice: () => {} }));
    const result = await tools.run('write_file', { path: 'first.txt', content: 'late first-attempt write\n' });
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/^Write blocked:/);
    expect(await fs.access(path.join(root, 'first.txt')).then(() => true, () => false)).toBe(false);
    // Nothing was kept: a peer takes the file at once.
    const peer = new FileWriterLeases(path.join(storage, 'leases'), { hostInstanceId: 'peer', selfIdentity: async () => rec(7), identity });
    expect((await peer.acquire(path.join(root, 'first.txt'), { waitMs: 0 })).status).toBe('held');
  });

  it('F5: no retry starts once the wait has ended', async () => {
    const dir = path.join(await folder('unode-r1a-noretry-'), 'lease');
    const holder = new GenerationLease(dir, { hostInstanceId: 'holder', selfIdentity: async () => rec(9), identity });
    const first = await holder.tryAcquire('test');
    if (first.status !== 'held') throw new Error('not held');
    liveness.set(9, 'alive');
    const clock = { t: 0 };
    let attemptsAfterDeadline = 0;
    const counting: ProcessIdentityAdapter = { ...identity, liveness: async (records) => {
      if (clock.t >= 5_000) attemptsAfterDeadline++;
      return identity.liveness(records);
    } };
    const waiter = new GenerationLease(dir, { hostInstanceId: 'waiter', selfIdentity: async () => rec(8), identity: counting,
      now: () => clock.t, sleep: async (ms) => { clock.t += ms; if (clock.t >= 5_000) await first.lease.release(); } });
    const result = await waiter.acquire('test', { waitMs: 5_000 });
    expect(result.status).toBe('busy');
    expect(attemptsAfterDeadline).toBe(0);
  });

  it('F7: a failed acquisition of a later target gives back the earlier ones', async () => {
    const releases: string[] = [];
    const leases = {
      acquire: async (physical: string) => {
        if (physical.endsWith('z.pptx')) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        return { status: 'held' as const, release: async () => { releases.push(physical); } };
      },
    } as unknown as FileWriterLeases;
    const policy = new FileWritePolicy({ workspaceId: () => 'workspace', fileLeases: leases });
    const root = await folder('unode-r1a-holdall-');
    await expect(policy.holdAll([path.join(root, 'a.docx'), path.join(root, 'z.pptx')])).rejects.toThrow('EEXIST');
    expect(releases).toEqual([path.join(root, 'a.docx')]);
  });
});

describe('F6: a legacy import fits the batch, not each entry, into the room', () => {
  it('admits only what the limits leave room for, together', async () => {
    const base = await folder('unode-r1a-f6-');
    const v1Dir = path.join(base, 'raw-v1');
    const { store: v1 } = await RawCheckpointStore.open({ directory: v1Dir, workspaceId: 'v1' });
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      const captured = await v1.capture({ agentId: 'dev', path: name, target: path.join(base, name), bytes: Buffer.from('four') });
      if (captured.status !== 'captured') throw new Error(captured.reason);
      ids.push(captured.entry.id);
    }
    const { store: v2 } = await coordinated(path.join(base, 'raw-v2'), 'host-me', 1, { limits: { maxEntries: 2, maxTotalBytes: 8 } });
    const imported = await v2.importLegacyEntries({ directory: v1Dir, workspaceId: 'v1' }, ids);
    expect(imported).toHaveLength(2);
    const kept = v2.list();
    expect(kept).toHaveLength(2);
    expect(kept.reduce((total, entry) => total + (entry.before.exists ? entry.before.size : 0), 0)).toBeLessThanOrEqual(8);
  });
});
