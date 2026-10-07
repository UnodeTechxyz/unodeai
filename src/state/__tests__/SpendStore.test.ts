import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { FileSpendLedger, MemorySpendLedger, SpendEventRejectedError, SpendLockBusyError } from '../SpendStore';
import { emptySpendControl, SpendEventPayload } from '../../models/spend/SpendTypes';

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-spend-store-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});

function start(unit: string, attempts = 1): [SpendEventPayload, string] {
  return [{ kind: 'usage-unit-start', usageUnitId: unit, requestId: 'req', agentId: 'pm', connectionId: 'unode', modelId: 'm', providerAttempts: attempts }, `start:${unit}:${attempts}`];
}

function ledger(root: string, extra: Partial<ConstructorParameters<typeof FileSpendLedger>[0]> = {}) {
  return new FileSpendLedger({ root, pollMs: 0, ...extra });
}

describe('SpendStore shards', () => {
  it('appends durably, reads its own and another window\'s lines once', async () => {
    const root = await tempRoot();
    const a = ledger(root, { hostEpoch: 'host-a' });
    const b = ledger(root, { hostEpoch: 'host-b' });
    await a.open();
    await b.open();
    await a.append(...start('u1'));
    await b.append(...start('u2'));
    await a.refresh();
    await a.refresh();
    const ids = a.snapshot().events.map((stored) => stored.event.eventId).sort();
    expect(ids).toEqual(['start:u1:1', 'start:u2:1']);
    await a.dispose();
    await b.dispose();
  });

  it('waits for an incomplete final line and sets aside a corrupt interior line', async () => {
    const root = await tempRoot();
    const store = ledger(root, { hostEpoch: 'reader' });
    await store.open();
    const shard = path.join(root, 'shards', 'other-0.ndjson');
    const good = (unit: string, sequence: number) => JSON.stringify({
      schemaVersion: 1, eventId: `start:${unit}:1`, hostEpoch: 'other', sequence, recordedAt: '2026-09-27T00:00:00.000Z',
      kind: 'usage-unit-start', usageUnitId: unit, requestId: 'req', agentId: 'pm', connectionId: 'unode', modelId: 'm', providerAttempts: 1,
    });
    await fsp.writeFile(shard, `${good('u1', 1)}\n{not json}\n${good('u2', 3)}\n${good('u3', 4).slice(0, 30)}`);
    await store.refresh();
    expect(store.snapshot().events.map((stored) => stored.event.eventId)).toEqual(['start:u1:1', 'start:u2:1']);
    expect(store.snapshot().quarantinedLines).toBe(1);
    // The rest of the partial line arrives later and is then read once.
    await fsp.appendFile(shard, `${good('u3', 4).slice(30)}\n`);
    await store.refresh();
    expect(store.snapshot().events.map((stored) => stored.event.eventId)).toEqual(['start:u1:1', 'start:u2:1', 'start:u3:1']);
    await store.dispose();
  });

  it('rotates segments without losing or reordering a line', async () => {
    const root = await tempRoot();
    const store = ledger(root, { hostEpoch: 'rot', segmentMaxBytes: 400 });
    await store.open();
    for (let i = 1; i <= 6; i++) await store.append(...start(`u${i}`));
    const names = (await fsp.readdir(path.join(root, 'shards'))).sort();
    expect(names.length).toBeGreaterThan(1);
    const reader = ledger(root, { hostEpoch: 'reader' });
    await reader.open();
    const events = reader.snapshot().events.map((stored) => stored.event);
    expect(events.map((event) => event.sequence).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6]);
    await store.dispose();
    await reader.dispose();
  });

  it('refuses to write an invalid event', async () => {
    const root = await tempRoot();
    const store = ledger(root);
    await store.open();
    await expect(store.append(...start('bad id with spaces'))).rejects.toThrow(SpendEventRejectedError);
    await store.dispose();
  });

  it('after a failed write, later lines go to a fresh segment and are never glued to the fragment', async () => {
    const root = await tempRoot();
    const store = ledger(root, { hostEpoch: 'w' });
    await store.open();
    const probe = await fsp.open(path.join(root, 'probe'), 'w');
    const fileHandle = Object.getPrototypeOf(probe) as { writeFile: (data: string) => Promise<void>; write: (data: string) => Promise<unknown> };
    await probe.close();
    // The disk fills part-way through the first line.
    const spy = vi.spyOn(fileHandle, 'writeFile').mockImplementationOnce(async function (this: typeof fileHandle, data: string) {
      await this.write(String(data).slice(0, 25));
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    });
    try {
      await expect(store.append(...start('u1'))).rejects.toThrow(/no space/);
    } finally {
      spy.mockRestore();
    }
    // The caller retries the same event, then writes the next one.
    await store.append(...start('u1'));
    await store.append(...start('u2'));
    const reader = ledger(root, { hostEpoch: 'reader' });
    await reader.open();
    expect(reader.snapshot().events.map((stored) => stored.event.eventId).sort()).toEqual(['start:u1:1', 'start:u2:1']);
    expect(reader.snapshot().quarantinedLines).toBe(0);
    const sequences = reader.snapshot().events.map((stored) => stored.event.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect((await fsp.readdir(path.join(root, 'shards'))).sort()).toEqual(['w-0.ndjson', 'w-1.ndjson']);
    await store.dispose();
    await reader.dispose();
  });
});

const claim = (key: string) => ({ key, claimedAt: '2026-09-27T00:00:00.000Z' });
const revisionFile = (root: string, revision: number) => path.join(root, 'control', `${String(revision).padStart(12, '0')}.json`);
async function age(file: string, ms = 60_000): Promise<void> {
  const past = new Date(Date.now() - ms);
  await fsp.utimes(file, past, past);
}

describe('SpendStore control and lock', () => {
  it('commits each transaction as a new revision and falls back to the newest readable one', async () => {
    const root = await tempRoot();
    const store = ledger(root);
    await store.open();
    await store.transact((control) => ({ next: { ...control, noticeClaims: [claim('k1')] }, result: undefined }));
    await store.transact((control) => ({ next: { ...control, noticeClaims: [...control.noticeClaims, claim('k2')] }, result: undefined }));
    expect(store.snapshot().control.revision).toBe(2);
    expect(fs.existsSync(revisionFile(root, 1)) && fs.existsSync(revisionFile(root, 2))).toBe(true);
    await fsp.writeFile(revisionFile(root, 2), '{broken');
    await age(revisionFile(root, 2));
    await store.refresh();
    expect(store.snapshot().controlState).toBe('backup');
    expect(store.snapshot().control.noticeClaims.map((entry) => entry.key)).toEqual(['k1']);
    // The next commit builds on the readable revision and supersedes the broken one.
    await store.transact((control) => ({ next: { ...control, noticeClaims: [...control.noticeClaims, claim('k3')] }, result: undefined }));
    expect(store.snapshot().controlState).toBe('ok');
    expect(store.snapshot().control.revision).toBe(3);
    expect(store.snapshot().control.noticeClaims.map((entry) => entry.key)).toEqual(['k1', 'k3']);
    await store.dispose();
  });

  it('treats a young unreadable newest revision as still being written and retries instead of building on the older one', async () => {
    const root = await tempRoot();
    const store = ledger(root);
    await store.open();
    await store.transact((control) => ({ next: { ...control, noticeClaims: [claim('k1')] }, result: undefined }));
    await fsp.writeFile(revisionFile(root, 2), '');
    await expect(store.transact((control) => ({ next: { ...control, noticeClaims: [] }, result: undefined }))).rejects.toBeInstanceOf(SpendLockBusyError);
    expect(fs.existsSync(revisionFile(root, 3))).toBe(false);
    await store.dispose();
  });

  it('never overwrites control written by a newer schema, even when it appears after this window last read', async () => {
    const root = await tempRoot();
    const store = ledger(root, { hostEpoch: 'claims' });
    const repairer = ledger(root, { hostEpoch: 'repairs' });
    await store.open();
    await store.transact((control) => ({ next: { ...control, noticeClaims: [claim('k1')] }, result: undefined }));
    await repairer.open();
    expect(store.snapshot().controlState).toBe('ok');
    expect(repairer.snapshot().controlState).toBe('ok');
    // A newer UnodeAi in a third window publishes revision 2; neither window has refreshed since.
    const newer = `${JSON.stringify({ ...emptySpendControl(), schemaVersion: 2, revision: 2 })}\n`;
    await fsp.writeFile(revisionFile(root, 2), newer);
    await expect(store.transact((control) => ({ next: { ...control, noticeClaims: [] }, result: undefined }))).rejects.toThrow(/newer UnodeAi/);
    await expect(repairer.repair('test')).rejects.toThrow(/newer UnodeAi/);
    expect(await fsp.readFile(revisionFile(root, 2), 'utf8')).toBe(newer);
    expect(fs.existsSync(revisionFile(root, 3))).toBe(false);
    expect(store.snapshot().controlState).toBe('unsupported');
    await store.dispose();
    await repairer.dispose();
  });

  it('refuses control transactions while the shards hold events from a newer schema', async () => {
    const root = await tempRoot();
    const store = ledger(root);
    await store.open();
    await fsp.writeFile(path.join(root, 'shards', 'future-0.ndjson'), `${JSON.stringify({ schemaVersion: 2, eventId: 'x', kind: 'future' })}\n`);
    await expect(store.transact((control) => ({ next: control, result: undefined }))).rejects.toThrow(/newer UnodeAi/);
    expect(fs.existsSync(revisionFile(root, 1))).toBe(false);
    await store.dispose();
  });

  it('Repair also refuses, and changes nothing, when only a shard comes from a newer schema', async () => {
    const root = await tempRoot();
    const store = ledger(root);
    await store.open();
    await store.transact((control) => ({ next: { ...control, noticeClaims: [claim('k1')] }, result: undefined }));
    await fsp.writeFile(path.join(root, 'shards', 'future-0.ndjson'), `${JSON.stringify({ schemaVersion: 2, eventId: 'x', kind: 'future' })}\n`);
    await store.refresh();
    expect(store.snapshot().controlState).toBe('ok');
    expect(store.snapshot().unsupportedLines).toBe(1);
    const snapshotFiles = async () => {
      const out: Record<string, string> = {};
      for (const dir of ['control', 'shards']) {
        for (const name of (await fsp.readdir(path.join(root, dir))).sort()) out[`${dir}/${name}`] = await fsp.readFile(path.join(root, dir, name), 'utf8');
      }
      return out;
    };
    const before = await snapshotFiles();
    await expect(store.repair('test')).rejects.toThrow(/newer UnodeAi/);
    expect(await snapshotFiles()).toEqual(before);
    expect(store.snapshot().control.repairs).toEqual([]);
    await store.dispose();
  });

  it('refuses a live lock, and recovers an expired or released one', async () => {
    const root = await tempRoot();
    let now = Date.parse('2026-09-27T00:00:00.000Z');
    const clock = () => now;
    const second = ledger(root, { hostEpoch: 'second', now: clock, leaseMs: 1_000 });
    await second.open();
    const lock = path.join(root, 'maintenance.lock');
    await fsp.mkdir(lock);
    await fsp.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ nonce: 'dead', hostEpoch: 'gone', acquiredAt: new Date(now).toISOString() }));
    await expect(second.transact((control) => ({ next: control, result: 1 }))).rejects.toBeInstanceOf(SpendLockBusyError);
    // The owner's own heartbeat file extends its lease.
    now += 800;
    await fsp.writeFile(path.join(lock, 'beat-dead'), '');
    await fsp.utimes(path.join(lock, 'beat-dead'), new Date(now), new Date(now));
    now += 800;
    await expect(second.transact((control) => ({ next: control, result: 1 }))).rejects.toBeInstanceOf(SpendLockBusyError);
    // After the lease it is moved aside, whatever process it named, and work proceeds.
    now += 2_000;
    await expect(second.transact((control) => ({ next: { ...control, noticeClaims: [claim('after')] }, result: 2 }))).resolves.toBe(2);
    expect(fs.readdirSync(root).filter((name) => name.startsWith('maintenance.lock.'))).toEqual([]);
    // A released lock is free at once, with no lease wait.
    const third = ledger(root, { hostEpoch: 'third', now: clock, leaseMs: 1_000 });
    await third.open();
    await expect(third.transact((control) => ({ next: { ...control, noticeClaims: [...control.noticeClaims, claim('third')] }, result: 3 }))).resolves.toBe(3);
    expect(third.snapshot().control.noticeClaims.map((entry) => entry.key)).toEqual(['after', 'third']);
    await second.dispose();
    await third.dispose();
  });

  it('a holder whose lease was taken over cannot publish over newer control, and its release leaves the new lock alone', async () => {
    const root = await tempRoot();
    let now = Date.parse('2026-09-27T00:00:00.000Z');
    const clock = () => now;
    let reachedPublish!: () => void;
    const staleAtPublish = new Promise<void>((resolve) => { reachedPublish = resolve; });
    let letStaleGo!: () => void;
    const staleMayGo = new Promise<void>((resolve) => { letStaleGo = resolve; });
    let freshHook: () => Promise<void> = async () => undefined;
    let ids = 0;
    const stale = ledger(root, {
      hostEpoch: 'stale', now: clock, leaseMs: 1_000, renewMs: 60_000,
      beforeControlPublish: async () => { reachedPublish(); await staleMayGo; },
    });
    const fresh = ledger(root, {
      hostEpoch: 'fresh', now: clock, leaseMs: 1_000, renewMs: 60_000, randomId: () => `fresh-${++ids}`,
      beforeControlPublish: () => freshHook(),
    });
    await stale.open();
    await fresh.open();
    const staleCommit = stale.transact((control) => ({ next: { ...control, noticeClaims: [claim('stale')] }, result: 'stale' }));
    staleCommit.catch(() => undefined);
    await staleAtPublish; // the stale holder has passed its ownership check
    now += 2_000; // ...and its lease runs out while it is stalled
    await expect(fresh.transact((control) => ({ next: { ...control, noticeClaims: [claim('fresh')] }, result: 'fresh' }))).resolves.toBe('fresh');
    let ownerDuringHold: string | undefined;
    let releasedMarkers: string[] = [];
    freshHook = async () => {
      // While the new owner holds the lock, the stale holder resumes, fails to publish and releases.
      letStaleGo();
      await expect(staleCommit).rejects.toBeInstanceOf(SpendLockBusyError);
      ownerDuringHold = JSON.parse(await fsp.readFile(path.join(root, 'maintenance.lock', 'owner.json'), 'utf8')).nonce;
      releasedMarkers = (await fsp.readdir(path.join(root, 'maintenance.lock'))).filter((name) => name.startsWith('released-'));
    };
    await expect(fresh.transact((control) => ({ next: { ...control, noticeClaims: [...control.noticeClaims, claim('fresh-2')] }, result: 'fresh-2' }))).resolves.toBe('fresh-2');
    expect(ownerDuringHold).toMatch(/^fresh-/);
    expect(releasedMarkers.every((name) => !name.includes(ownerDuringHold!))).toBe(true);
    const reader = ledger(root, { hostEpoch: 'reader' });
    await reader.open();
    expect(reader.snapshot().control.revision).toBe(2);
    expect(reader.snapshot().control.noticeClaims.map((entry) => entry.key)).toEqual(['fresh', 'fresh-2']);
    await stale.dispose();
    await fresh.dispose();
    await reader.dispose();
  });

  it('publishes by exclusive create where hard links are unavailable, and the first publisher still wins', async () => {
    const root = await tempRoot();
    let reachedPublish!: () => void;
    const aAtPublish = new Promise<void>((resolve) => { reachedPublish = resolve; });
    let letAGo!: () => void;
    const aMayGo = new Promise<void>((resolve) => { letAGo = resolve; });
    let now = Date.parse('2026-09-27T00:00:00.000Z');
    const a = ledger(root, { hostEpoch: 'a', hardLinks: false, now: () => now, leaseMs: 1_000, beforeControlPublish: async () => { reachedPublish(); await aMayGo; } });
    const b = ledger(root, { hostEpoch: 'b', hardLinks: false, now: () => now, leaseMs: 1_000 });
    await a.open();
    await b.open();
    const aCommit = a.transact((control) => ({ next: { ...control, noticeClaims: [claim('a')] }, result: 'a' }));
    aCommit.catch(() => undefined);
    await aAtPublish;
    now += 2_000;
    await expect(b.transact((control) => ({ next: { ...control, noticeClaims: [claim('b')] }, result: 'b' }))).resolves.toBe('b');
    letAGo();
    await expect(aCommit).rejects.toBeInstanceOf(SpendLockBusyError);
    await a.refresh();
    expect(a.snapshot().control.noticeClaims.map((entry) => entry.key)).toEqual(['b']);
    await a.dispose();
    await b.dispose();
  });

  it('keeps the newest ten revisions as backups', async () => {
    const root = await tempRoot();
    const store = ledger(root);
    await store.open();
    for (let i = 1; i <= 12; i++) {
      await store.transact((control) => ({ next: { ...control, noticeClaims: [claim(`k${i}`)] }, result: undefined }));
    }
    const files = (await fsp.readdir(path.join(root, 'control'))).sort();
    expect(files).toEqual(Array.from({ length: 10 }, (_, i) => path.basename(revisionFile(root, i + 3))));
    expect(store.snapshot().control.revision).toBe(12);
    await store.dispose();
  });

  it('repairs unreadable control without touching shard events; a transaction refuses to replace it silently', async () => {
    const root = await tempRoot();
    const store = ledger(root);
    await store.open();
    await store.append(...start('u1'));
    await store.transact((control) => ({ next: { ...control, noticeClaims: [claim('k1')] }, result: undefined }));
    await fsp.writeFile(revisionFile(root, 1), '{broken');
    await age(revisionFile(root, 1));
    await store.refresh();
    expect(store.snapshot().controlState).toBe('corrupt');
    await expect(store.transact((control) => ({ next: control, result: undefined }))).rejects.toThrow(/Repair spend tracking/);
    const shardBefore = await fsp.readdir(path.join(root, 'shards'));
    await store.repair('test');
    expect(store.snapshot().controlState).toBe('ok');
    expect(store.snapshot().control.revision).toBe(2);
    expect(store.snapshot().control.repairs).toHaveLength(1);
    expect(await fsp.readdir(path.join(root, 'shards'))).toEqual(shardBefore);
    expect(store.snapshot().events).toHaveLength(1);
    await store.dispose();
  });
});

describe('heartbeats', () => {
  it('reports a window whose heartbeat is gone or stale as not live', async () => {
    const root = await tempRoot();
    let now = Date.now();
    const a = ledger(root, { hostEpoch: 'a', now: () => now, heartbeatLeaseMs: 60_000 });
    const b = ledger(root, { hostEpoch: 'b', now: () => now, heartbeatLeaseMs: 60_000 });
    await a.open();
    await b.open();
    await a.refresh();
    expect([...a.snapshot().liveHosts].sort()).toEqual(['a', 'b']);
    await b.dispose();
    await a.refresh();
    expect([...a.snapshot().liveHosts]).toEqual(['a']);
    now += 120_000;
    await a.dispose();
  });
});

describe('MemorySpendLedger', () => {
  it('keeps a folderless window in memory and writes nothing', async () => {
    const memory = new MemorySpendLedger();
    await memory.append(...start('u1'));
    expect(memory.projectBacked).toBe(false);
    expect(memory.snapshot().events).toHaveLength(1);
  });
});
