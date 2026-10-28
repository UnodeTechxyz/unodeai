import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstanceRef, InstanceStoreApi, PromotedVersion } from '../contracts';
import { INSTANCE_LIMITS } from '../instanceStore';
import { CREATED, cleanTemps, created, factsFor, fsError, kit, promoteVersion, recordingFs, type FsCall, type Kit } from './instanceTestKit';

// The design these tests realise (the merged store design §6, the Owner's C1 ruling and Codex's accepted retention;
// Codex's Q3 Try again; whole-instance collection of the immutable-instance design §12):
// - newest 3: while more than three version folders exist, the oldest unprotected one, by policy version, is
//   collected; `active`, `lastKnownGood` and every key with a lease that is alive or unknown are never deleted, even
//   when that makes more than three; a folder kept by a lease is collected once the lease is dead and it is still
//   beyond the newest three; a retired instance is never version-collected;
// - the steps, each decided afresh: publish the record without the key's facts, then rename the folder to trash,
//   look at the leases again, rename back when one appeared, else delete file by file and stop at EPERM/EBUSY;
// - Try again retires one key only while no lease on it is alive or unknown;
// - orphans: unlisted folders older than 10 minutes, named by no live or unknown staging intent, with dead leases;
// - whole instances: never the current one, never one with a live or unknown lease; a retired one after 7 days, one
//   never named by control after 10 minutes; renamed to instance-trash, deleted file by file, its work folder too.

afterEach(cleanTemps);

const NONE: ReadonlySet<string> = new Set();

async function withVersions(versions: string[], overrides: Parameters<typeof kit>[0] = {}): Promise<Kit & { ref: InstanceRef; facts: Record<string, PromotedVersion> }> {
  const k = kit(overrides);
  const ref = await created(k.store);
  const facts: Record<string, PromotedVersion> = {};
  for (const version of versions) {
    facts[version] = factsFor(version);
    const result = await promoteVersion(k.store, ref, facts[version]);
    if (!result.ok) throw new Error(`setup: ${result.reason}`);
  }
  return { ...k, ref, facts };
}

async function addProbe(store: InstanceStoreApi, ref: InstanceRef, facts: PromotedVersion): Promise<void> {
  const result = await store.publish(ref, {
    label: 'probe',
    apply: (current) => ({ ...current, probes: { ...current.probes, [facts.key]: { key: facts.key, closureDigest: 'c'.repeat(64), versionOutput: `codex-cli ${facts.version}`, startedAt: '2026-10-20T08:01:00.000Z', durationMs: 900 } } }),
  });
  if (result.outcome !== 'published') throw new Error('setup');
}

function listed(store: InstanceStoreApi, ref: InstanceRef): string[] {
  const view = store.read(ref);
  if (view.kind !== 'readable') throw new Error('unreadable');
  return Object.keys(view.snapshot.record.versions).sort();
}

const keep3 = (protectedKeys: ReadonlySet<string> = NONE) => ({ protectedKeys, keep: 3 });

// =============================================================================================
// Newest 3 (Codex's required evidence item 5)
// =============================================================================================

describe('collectVersions(): the newest three', () => {
  it('collects the fourth ordinary unprotected version, the oldest by policy version, facts and folder', async () => {
    // Promoted out of order; 0.99.0 is older than 0.100.0 by number, not by text.
    const { store, ref, facts } = await withVersions(['0.101.0', '0.99.0', '0.102.0', '0.100.0']);
    await addProbe(store, ref, facts['0.99.0']);
    const report = await store.collectVersions(ref, keep3());
    expect(report.collected).toEqual([facts['0.99.0'].key]);
    expect(report.kept.map((kept) => [kept.key, kept.why])).toEqual([
      [facts['0.100.0'].key, 'newest'], [facts['0.101.0'].key, 'newest'], [facts['0.102.0'].key, 'newest'],
    ]);
    expect(store.listVersionFolders(ref)).toEqual([facts['0.100.0'].key, facts['0.101.0'].key, facts['0.102.0'].key].sort());
    expect(listed(store, ref)).toEqual([facts['0.100.0'].key, facts['0.101.0'].key, facts['0.102.0'].key].sort());
    const view = store.read(ref);
    expect(view.kind === 'readable' && view.snapshot.record.probes).toEqual({});
    expect(readdirSync(path.join(ref.root, 'trash'))).toEqual([]);
    // Three left: nothing more to do.
    expect((await store.collectVersions(ref, keep3())).collected).toEqual([]);
  });

  it('never deletes active or LKG, even when that makes more than three; a newer download displaces an older unclicked one', async () => {
    const { store, ref, facts } = await withVersions(['0.160.0', '0.161.0', '0.162.0', '0.163.0', '0.164.0']);
    const protectedKeys = new Set([facts['0.160.0'].key, facts['0.161.0'].key]);
    const report = await store.collectVersions(ref, keep3(protectedKeys));
    expect(report.collected).toEqual([facts['0.162.0'].key, facts['0.163.0'].key]);
    expect(report.kept).toEqual([
      { key: facts['0.160.0'].key, why: 'active-or-lkg' }, { key: facts['0.161.0'].key, why: 'active-or-lkg' }, { key: facts['0.164.0'].key, why: 'newest' },
    ]);

    const all = await withVersions(['0.160.0', '0.161.0', '0.162.0', '0.163.0']);
    const allProtected = new Set(Object.values(all.facts).map((each) => each.key));
    const none = await all.store.collectVersions(all.ref, keep3(allProtected));
    expect(none.collected).toEqual([]);
    expect(all.store.listVersionFolders(all.ref)).toHaveLength(4);
  });

  it('keeps a version with an alive lease beside the newest three, and collects it once the lease is dead', async () => {
    const { store, ref, facts, processes } = await withVersions(['0.160.0', '0.161.0', '0.162.0', '0.163.0']);
    const host = processes.start(100, CREATED.host);
    store.createLease(ref, facts['0.160.0'].key, 'download', host);
    const leased = await store.collectVersions(ref, keep3());
    expect(leased.collected).toEqual([]);
    expect(leased.kept).toContainEqual({ key: facts['0.160.0'].key, why: 'lease-alive' });
    expect(store.listVersionFolders(ref)).toHaveLength(4);
    expect(listed(store, ref)).toHaveLength(4);

    processes.stop(100);
    const after = await store.collectVersions(ref, keep3());
    expect(after.collected).toEqual([facts['0.160.0'].key]);
    // The dead lease file was removed by the collector.
    expect(readdirSync(path.join(ref.root, 'leases', facts['0.160.0'].key))).toEqual([]);
  });

  it('keeps a version with an unknown lease: a pending child, or a creation query that failed', async () => {
    const { store, ref, facts, processes } = await withVersions(['0.160.0', '0.161.0', '0.162.0', '0.163.0']);
    store.createLease(ref, facts['0.160.0'].key, 'session', { pid: 100, creation: CREATED.host });
    const pending = await store.collectVersions(ref, keep3());
    expect(pending.collected).toEqual([]);
    expect(pending.kept).toContainEqual({ key: facts['0.160.0'].key, why: 'lease-unknown' });

    const other = await withVersions(['0.160.0', '0.161.0', '0.162.0', '0.163.0']);
    other.store.createLease(other.ref, other.facts['0.160.0'].key, 'download', other.processes.start(100, CREATED.host));
    other.processes.unavailable = 'answer';
    const failed = await other.store.collectVersions(other.ref, keep3());
    expect(failed.collected).toEqual([]);
    expect(failed.kept).toContainEqual({ key: other.facts['0.160.0'].key, why: 'lease-unknown' });
    expect(processes.calls.length + other.processes.calls.length).toBeGreaterThan(0);
  });

  it('publishes the record without the key before it moves the folder to trash, and deletes only inside trash', async () => {
    const calls: FsCall[] = [];
    const { fs } = recordingFs((call) => { calls.push(call); });
    const { store, ref, facts } = await withVersions(['0.160.0', '0.161.0', '0.162.0', '0.163.0'], { fs });
    await addProbe(store, ref, facts['0.160.0']);
    calls.length = 0;
    await store.collectVersions(ref, keep3());
    const folder = store.versionFolder(ref, facts['0.160.0'].key);
    const link = calls.findIndex((call) => call.op === 'link');
    const move = calls.findIndex((call) => call.op === 'rename' && call.paths[0] === folder);
    expect(link).toBeGreaterThanOrEqual(0);
    expect(move).toBeGreaterThan(link);
    expect(path.dirname(calls[move].paths[1])).toBe(path.join(ref.root, 'trash'));
    // Nothing is deleted below versions\: every unlink and rmdir is inside trash\ (or the dead leases).
    for (const call of calls.filter((each) => each.op === 'unlink' || each.op === 'rmdir')) {
      expect(call.paths[0].startsWith(path.join(ref.root, 'trash')) || call.paths[0].includes(`${path.sep}manifests${path.sep}.instance.tmp-`)).toBe(true);
    }
  });

  it('moves a folder back when a lease appears after its rename to trash, and deletes nothing', async () => {
    let plant: ((call: FsCall) => void) | undefined;
    const { fs } = recordingFs((call) => plant?.(call));
    const { store, ref, facts, processes } = await withVersions(['0.160.0', '0.161.0', '0.162.0', '0.163.0'], { fs });
    const folder = store.versionFolder(ref, facts['0.160.0'].key);
    plant = (call) => {
      if (call.op === 'rename' && call.paths[0] === folder) {
        plant = undefined;
        renameSync(call.paths[0], call.paths[1]);
        store.createLease(ref, facts['0.160.0'].key, 'session', processes.start(100, CREATED.host));
        renameSync(call.paths[1], call.paths[0]);
      }
    };
    const report = await store.collectVersions(ref, keep3());
    expect(report.restored).toEqual([facts['0.160.0'].key]);
    expect(report.collected).toEqual([]);
    expect(existsSync(path.join(folder, 'codex.exe'))).toBe(true);
    expect(readdirSync(path.join(ref.root, 'trash'))).toEqual([]);
  });

  it('keeps facts and folder when a lease appears after the leases were judged, before the facts are removed', async () => {
    let plant: (() => void) | undefined;
    const k = kit();
    const store = k.store;
    const wrapped = kit({ processCreations: async (pids) => { const run = plant; plant = undefined; run?.(); return k.processes.query(pids); } }, k.roots);
    const ref = await created(store);
    const facts = ['0.160.0', '0.161.0', '0.162.0', '0.163.0'].map((version) => factsFor(version));
    for (const each of facts) await promoteVersion(store, ref, each);
    // Another lease (judged dead) makes the cycle ask about processes; the new one appears during that question.
    store.createLease(ref, facts[0].key, 'download', { pid: 7, creation: CREATED.other });
    plant = () => { store.createLease(ref, facts[0].key, 'session', k.processes.start(100, CREATED.host)); };
    const report = await wrapped.store.collectVersions(ref, keep3());
    expect(report.collected).toEqual([]);
    expect(report.deferred).toEqual([{ key: facts[0].key, code: 'lease-present' }]);
    expect(listed(store, ref)).toHaveLength(4);
    expect(store.listVersionFolders(ref)).toHaveLength(4);
  });

  it('stops deleting at EPERM inside trash; a later cycle finishes', async () => {
    let refuse = false;
    const { fs } = recordingFs((call) => {
      if (refuse && call.op === 'unlink' && call.paths[0].endsWith('codex.exe') && call.paths[0].includes(`${path.sep}trash${path.sep}`)) {
        refuse = false;
        throw fsError('EPERM');
      }
    });
    const { store, ref, facts } = await withVersions(['0.160.0', '0.161.0', '0.162.0', '0.163.0'], { fs });
    refuse = true;
    const first = await store.collectVersions(ref, keep3());
    expect(first.collected).toEqual([facts['0.160.0'].key]);
    const left = readdirSync(path.join(ref.root, 'trash'));
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(existsSync(path.join(ref.root, 'trash', left[0], 'codex.exe'))).toBe(true);
    await store.collectVersions(ref, keep3());
    expect(readdirSync(path.join(ref.root, 'trash'))).toEqual([]);
  });

  it('never version-collects a retired instance (its gate is closed)', async () => {
    const { store, ref, facts } = await withVersions(['0.160.0', '0.161.0', '0.162.0', '0.163.0']);
    expect((await store.closeAdmission(ref)).ok).toBe(true);
    const report = await store.collectVersions(ref, keep3());
    expect(report.collected).toEqual([]);
    expect(report.deferred).toEqual([{ key: facts['0.160.0'].key, code: 'admission-closed' }]);
    expect(store.listVersionFolders(ref)).toHaveLength(4);
    expect(listed(store, ref)).toHaveLength(4);
  });

  it('finishes what an interrupted cycle left in trash: decides undecided entries from fresh leases', async () => {
    const logged: string[] = [];
    const { store, ref, facts, processes } = await withVersions(['0.160.0', '0.161.0'], { log: (line) => logged.push(line) });
    const trash = path.join(ref.root, 'trash');
    // Undecided, no lease: deleted.
    mkdirSync(path.join(trash, `${factsFor('0.150.0').key}.${'1'.repeat(32)}`));
    writeFileSync(path.join(trash, `${factsFor('0.150.0').key}.${'1'.repeat(32)}`, 'codex.exe'), 'x');
    // Undecided, an alive lease, its name free: moved back.
    const leasedKey = factsFor('0.151.0').key;
    mkdirSync(path.join(trash, `${leasedKey}.${'2'.repeat(32)}`));
    store.createLease(ref, leasedKey, 'download', processes.start(100, CREATED.host));
    // Decided: deleted. Unknown: left alone.
    mkdirSync(path.join(trash, '3'.repeat(32)));
    mkdirSync(path.join(trash, 'unknown-name'));
    await store.collectVersions(ref, keep3());
    expect(readdirSync(trash).sort()).toEqual(['unknown-name']);
    expect(store.listVersionFolders(ref)).toContain(leasedKey);
    expect(logged.some((line) => line.includes('unknown-name'))).toBe(true);
    expect(facts['0.160.0']).toBeDefined();
  });
});

// =============================================================================================
// Try again (Codex's required evidence item 3, the store's part)
// =============================================================================================

describe('retireVersion()', () => {
  it('refuses while a lease is alive, changing nothing', async () => {
    const { store, ref, facts, processes } = await withVersions(['0.163.0']);
    store.createLease(ref, facts['0.163.0'].key, 'session', processes.start(100, CREATED.host));
    expect(await store.retireVersion(ref, facts['0.163.0'].key)).toMatchObject({ ok: false, reason: 'in-use' });
    expect(store.listVersionFolders(ref)).toEqual([facts['0.163.0'].key]);
    expect(listed(store, ref)).toEqual([facts['0.163.0'].key]);
  });

  it('refuses while a lease is unknown: a pending child, or a failed query; nothing is changed, a dead lease included', async () => {
    const { store, ref, facts, processes } = await withVersions(['0.163.0']);
    const leases = path.join(ref.root, 'leases', facts['0.163.0'].key);
    const dead = store.createLease(ref, facts['0.163.0'].key, 'download', { pid: 7, creation: CREATED.other });
    const lease = store.createLease(ref, facts['0.163.0'].key, 'session', { pid: 100, creation: CREATED.host });
    expect(await store.retireVersion(ref, facts['0.163.0'].key)).toMatchObject({ ok: false, reason: 'in-use' });
    expect(readdirSync(leases).sort()).toEqual([`${dead.token}.json`, `${lease.token}.json`].sort());
    store.releaseLease(lease);
    store.createLease(ref, facts['0.163.0'].key, 'download', processes.start(100, CREATED.host));
    processes.unavailable = 'throws';
    expect(await store.retireVersion(ref, facts['0.163.0'].key)).toMatchObject({ ok: false, reason: 'in-use' });
    expect(store.listVersionFolders(ref)).toEqual([facts['0.163.0'].key]);
    expect(listed(store, ref)).toEqual([facts['0.163.0'].key]);
  });

  it('retires the key when its leases are dead: facts and probe unpublished first, then the folder through trash', async () => {
    const calls: FsCall[] = [];
    const { fs } = recordingFs((call) => { calls.push(call); });
    const { store, ref, facts } = await withVersions(['0.163.0'], { fs });
    await addProbe(store, ref, facts['0.163.0']);
    store.createLease(ref, facts['0.163.0'].key, 'download', { pid: 100, creation: CREATED.host });
    calls.length = 0;
    expect(await store.retireVersion(ref, facts['0.163.0'].key)).toEqual({ ok: true, key: facts['0.163.0'].key });
    const folder = store.versionFolder(ref, facts['0.163.0'].key);
    const link = calls.findIndex((call) => call.op === 'link');
    const move = calls.findIndex((call) => call.op === 'rename' && call.paths[0] === folder);
    expect(link).toBeGreaterThanOrEqual(0);
    expect(move).toBeGreaterThan(link);
    expect(existsSync(folder)).toBe(false);
    const view = store.read(ref);
    expect(view.kind === 'readable' && [view.snapshot.record.versions, view.snapshot.record.probes]).toEqual([{}, {}]);
    expect(readdirSync(path.join(ref.root, 'trash'))).toEqual([]);
  });

  it('retires facts whose folder is already gone', async () => {
    const { store, ref, facts } = await withVersions(['0.163.0']);
    renameSync(store.versionFolder(ref, facts['0.163.0'].key), path.join(ref.root, 'elsewhere'));
    expect(await store.retireVersion(ref, facts['0.163.0'].key)).toEqual({ ok: true, key: facts['0.163.0'].key });
    expect(listed(store, ref)).toEqual([]);
  });

  it('refuses while the gate is closed', async () => {
    const { store, ref, facts } = await withVersions(['0.163.0']);
    await store.closeAdmission(ref);
    expect(await store.retireVersion(ref, facts['0.163.0'].key)).toMatchObject({ ok: false, reason: 'admission-closed' });
    expect(listed(store, ref)).toEqual([facts['0.163.0'].key]);
  });

  it('reports in use, retiring nothing, when a lease appears after the leases were judged', async () => {
    let plant: (() => void) | undefined;
    const k = kit();
    const wrapped = kit({ processCreations: async (pids) => { const run = plant; plant = undefined; run?.(); return k.processes.query(pids); } }, k.roots);
    const ref = await created(k.store);
    const facts = factsFor('0.163.0');
    await promoteVersion(k.store, ref, facts);
    k.store.createLease(ref, facts.key, 'download', { pid: 7, creation: CREATED.other });
    plant = () => { k.store.createLease(ref, facts.key, 'session', k.processes.start(100, CREATED.host)); };
    expect(await wrapped.store.retireVersion(ref, facts.key)).toMatchObject({ ok: false, reason: 'in-use' });
    expect(listed(k.store, ref)).toEqual([facts.key]);
    expect(k.store.listVersionFolders(ref)).toEqual([facts.key]);
  });

  it('reports in use when a lease appears while it moves the folder, and moves it back', async () => {
    let plant: ((call: FsCall) => void) | undefined;
    const { fs } = recordingFs((call) => plant?.(call));
    const { store, ref, facts, processes } = await withVersions(['0.163.0'], { fs });
    const folder = store.versionFolder(ref, facts['0.163.0'].key);
    plant = (call) => {
      if (call.op === 'rename' && call.paths[0] === folder) {
        plant = undefined;
        store.createLease(ref, facts['0.163.0'].key, 'session', processes.start(100, CREATED.host));
      }
    };
    expect(await store.retireVersion(ref, facts['0.163.0'].key)).toMatchObject({ ok: false, reason: 'in-use' });
    expect(existsSync(path.join(folder, 'codex.exe'))).toBe(true);
  });
});

// =============================================================================================
// Orphans
// =============================================================================================

describe('retireOrphans()', () => {
  async function withOrphan(): Promise<Kit & { ref: InstanceRef; key: string }> {
    const k = kit();
    const ref = await created(k.store);
    const key = factsFor('0.163.0').key;
    mkdirSync(path.join(ref.root, 'versions', key));
    writeFileSync(path.join(ref.root, 'versions', key, 'codex.exe'), 'x');
    return { ...k, ref, key };
  }

  it('retires an unlisted folder older than 10 minutes with dead leases', async () => {
    const { store, ref, key, clock } = await withOrphan();
    expect(await store.retireOrphans(ref)).toEqual([]);
    clock.offsetMs = INSTANCE_LIMITS.orphanAgeMs + 60_000;
    expect(await store.retireOrphans(ref)).toEqual([key]);
    expect(store.listVersionFolders(ref)).toEqual([]);
    expect(readdirSync(path.join(ref.root, 'trash'))).toEqual([]);
  });

  it('keeps an orphan named by a live or unknown staging intent, and retires it when the owner is dead', async () => {
    const { store, ref, key, clock, processes } = await withOrphan();
    clock.offsetMs = INSTANCE_LIMITS.orphanAgeMs + 60_000;
    const owner = processes.start(100, CREATED.host);
    const intent = (pid: number, creation: string) => store.publish(ref, {
      label: 'intent',
      apply: (current) => ({ ...current, stagingIntents: { ['e'.repeat(32)]: { key, owner: { pid, creation }, startedAt: '2026-10-20T08:00:00.000Z' } } }),
    });
    await intent(owner.pid, owner.creation);
    expect(await store.retireOrphans(ref)).toEqual([]);
    await intent(100, 'pending');
    expect(await store.retireOrphans(ref)).toEqual([]);
    processes.stop(100);
    await intent(100, CREATED.host);
    expect(await store.retireOrphans(ref)).toEqual([key]);
  });

  it('keeps an orphan with an alive or unknown lease', async () => {
    const { store, ref, key, clock, processes } = await withOrphan();
    clock.offsetMs = INSTANCE_LIMITS.orphanAgeMs + 60_000;
    const lease = store.createLease(ref, key, 'download', processes.start(100, CREATED.host));
    expect(await store.retireOrphans(ref)).toEqual([]);
    store.releaseLease(lease);
    store.createLease(ref, key, 'session', { pid: 100, creation: CREATED.host });
    expect(await store.retireOrphans(ref)).toEqual([]);
    expect(store.listVersionFolders(ref)).toEqual([key]);
  });

  it('does not retire an orphan whose facts a promotion published while it was being decided', async () => {
    const k = kit();
    let plant: (() => Promise<unknown>) | undefined;
    const { fs } = recordingFs((call) => {
      if (call.op === 'openRead' && call.paths[0].endsWith('guard.bin') && plant) { const run = plant; plant = undefined; void run(); }
    });
    const watched = kit({ fs }, k.roots);
    const ref = await created(k.store);
    const facts = factsFor('0.163.0');
    mkdirSync(path.join(ref.root, 'versions', facts.key));
    writeFileSync(path.join(ref.root, 'versions', facts.key, 'codex.exe'), 'x');
    watched.clock.offsetMs = INSTANCE_LIMITS.orphanAgeMs + 60_000;
    plant = () => k.store.publish(ref, { label: 'promote', apply: (current) => ({ ...current, versions: { [facts.key]: facts } }) });
    expect(await watched.store.retireOrphans(ref)).toEqual([]);
    expect(watched.store.listVersionFolders(ref)).toEqual([facts.key]);
    expect(listed(k.store, ref)).toEqual([facts.key]);
  });

  it('never retires a listed version', async () => {
    const { store, ref, facts, clock } = await withVersions(['0.163.0']);
    clock.offsetMs = INSTANCE_LIMITS.orphanAgeMs + 60_000;
    expect(await store.retireOrphans(ref)).toEqual([]);
    expect(store.listVersionFolders(ref)).toEqual([facts['0.163.0'].key]);
  });
});

// =============================================================================================
// Whole instances (Codex §12, §14.7)
// =============================================================================================

describe('collectInstances()', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it('never collects the current instance, whatever its age', async () => {
    const { store, clock } = kit();
    const current = await created(store);
    clock.offsetMs = 30 * DAY;
    expect(await store.collectInstances(current.storeId, [{ storeId: current.storeId, retiredAt: ago(30 * DAY) }])).toEqual([]);
    expect(existsSync(current.root)).toBe(true);
  });

  it('collects a retired instance only 7 days after its Reset, with its work folder', async () => {
    const { store, roots } = kit();
    const current = await created(store);
    const retired = await created(store);
    store.createWorkFolder(retired, 'c'.repeat(32));
    expect(await store.collectInstances(current.storeId, [{ storeId: retired.storeId, retiredAt: ago(6 * DAY) }])).toEqual([]);
    expect(await store.collectInstances(current.storeId, [{ storeId: retired.storeId, retiredAt: 'not a time' }])).toEqual([]);
    expect(existsSync(retired.root)).toBe(true);
    expect(await store.collectInstances(current.storeId, [{ storeId: retired.storeId, retiredAt: ago(7 * DAY + 1000) }])).toEqual([retired.storeId]);
    expect(existsSync(retired.root)).toBe(false);
    expect(existsSync(path.join(roots.work, retired.storeId))).toBe(false);
    expect(readdirSync(roots.instanceTrash)).toEqual([]);
    expect(existsSync(current.root)).toBe(true);
  });

  it('collects an instance control never named only 10 minutes after it was made', async () => {
    const { store, clock } = kit();
    const orphan = await created(store);
    expect(await store.collectInstances(null, [])).toEqual([]);
    clock.offsetMs = INSTANCE_LIMITS.unpublishedInstanceAgeMs + 60_000;
    expect(await store.collectInstances(null, [])).toEqual([orphan.storeId]);
  });

  it('retains an instance with a live or an unknown lease, never moving it, and lets it go once holder and child are proven dead', async () => {
    const moves: FsCall[] = [];
    const { fs } = recordingFs((call) => { if (call.op === 'rename') moves.push(call); });
    const { store, processes } = kit({ fs });
    const current = await created(store);
    const retired = await created(store);
    const entry = [{ storeId: retired.storeId, retiredAt: ago(8 * DAY) }];
    const key = factsFor('0.163.0').key;
    const lease = store.createLease(retired, key, 'session', processes.start(100, CREATED.host));
    store.recordLeaseChild(lease, processes.start(101, CREATED.child));
    expect(await store.collectInstances(current.storeId, entry)).toEqual([]);

    processes.stop(100);
    expect(await store.collectInstances(current.storeId, entry)).toEqual([]); // the child still runs

    processes.stop(101);
    processes.unavailable = 'answer';
    expect(await store.collectInstances(current.storeId, entry)).toEqual([]); // unknown
    processes.unavailable = 'no';
    const pending = store.createLease(retired, key, 'probe', { pid: 102, creation: CREATED.other });
    expect(await store.collectInstances(current.storeId, entry)).toEqual([]); // pending child
    store.releaseLease(pending);
    expect(existsSync(retired.root)).toBe(true);
    // A live or unknown lease keeps the instance where it is: moving it would take its helpers from a running process.
    expect(moves.filter((call) => call.paths[0] === retired.root)).toEqual([]);

    expect(await store.collectInstances(current.storeId, entry)).toEqual([retired.storeId]);
    expect(existsSync(retired.root)).toBe(false);
  });

  it('retains an instance with an entry in leases\\ that is not a lease folder', async () => {
    const { store } = kit();
    const current = await created(store);
    const retired = await created(store);
    writeFileSync(path.join(retired.root, 'leases', 'stray'), 'x');
    expect(await store.collectInstances(current.storeId, [{ storeId: retired.storeId, retiredAt: ago(8 * DAY) }])).toEqual([]);
  });

  it('leaves an instance whose rename is refused for a later cycle', async () => {
    let refuse = true;
    const { fs } = recordingFs((call) => { if (call.op === 'rename' && refuse && call.paths[1].includes('instance-trash')) { refuse = false; throw fsError('EPERM'); } });
    const { store } = kit({ fs });
    const current = await created(store);
    const retired = await created(store);
    const entry = [{ storeId: retired.storeId, retiredAt: ago(8 * DAY) }];
    expect(await store.collectInstances(current.storeId, entry)).toEqual([]);
    expect(existsSync(path.join(retired.root, 'identity.bin'))).toBe(true);
    expect(await store.collectInstances(current.storeId, entry)).toEqual([retired.storeId]);
  });

  it('moves an instance back when a lease appears after its rename to instance-trash', async () => {
    let plant: ((call: FsCall) => void) | undefined;
    const { fs } = recordingFs((call) => plant?.(call));
    const { store } = kit({ fs });
    const current = await created(store);
    const retired = await created(store);
    plant = (call) => {
      if (call.op === 'rename' && call.paths[0] === retired.root) {
        plant = undefined;
        renameSync(call.paths[0], call.paths[1]);
        mkdirSync(path.join(call.paths[1], 'leases', factsFor('0.163.0').key));
        writeFileSync(path.join(call.paths[1], 'leases', factsFor('0.163.0').key, `${'d'.repeat(32)}.json`), '{}');
        renameSync(call.paths[1], call.paths[0]);
      }
    };
    expect(await store.collectInstances(current.storeId, [{ storeId: retired.storeId, retiredAt: ago(8 * DAY) }])).toEqual([]);
    expect(existsSync(path.join(retired.root, 'identity.bin'))).toBe(true);
  });

  it('finishes what an interrupted collection left, and removes work folders of instances that are gone', async () => {
    const { store, roots } = kit();
    const current = await created(store);
    mkdirSync(roots.instanceTrash);
    mkdirSync(path.join(roots.instanceTrash, '4'.repeat(32)));
    writeFileSync(path.join(roots.instanceTrash, '4'.repeat(32), 'x'), 'x');
    mkdirSync(path.join(roots.instanceTrash, `${'5'.repeat(32)}.${'6'.repeat(32)}`));
    mkdirSync(path.join(roots.work, '7'.repeat(32), 'c'.repeat(32)), { recursive: true });
    store.createWorkFolder(current, 'c'.repeat(32));
    await store.collectInstances(current.storeId, []);
    expect(readdirSync(roots.instanceTrash)).toEqual([]);
    expect(readdirSync(roots.work)).toEqual([current.storeId]);
  });
});
