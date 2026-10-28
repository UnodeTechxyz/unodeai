import { readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstanceRef, InstanceStoreApi, Lease, StagingFolder, WorkFolder } from '../contracts';
import { isPathInsideOrEqual } from '../../../backend/pathContainment';
import { CREATED, cleanTemps, created, factsFor, kit, promoteVersion, recordingFs, type FsCall } from './instanceTestKit';

// The design these tests realise (the immutable-instance design §3, §14.1, §14.2): a path derived from store id A
// always denotes A, and no path derived from A can ever denote B. Two instances holding the same version with
// byte-identical files have different version-folder paths and different files. Every operation that takes an
// `InstanceRef` touches only that instance's root or its own work folder, and a key, token or reference that could
// name anything else (`..`, separators, drive letters, upper case, a wrong length, a root that is not the derived one)
// is refused before any file-system call.

afterEach(cleanTemps);

describe('path uniqueness of instances', () => {
  it('gives two instances holding the same key with byte-identical files different folders and different files', async () => {
    const { store } = kit();
    const a = await created(store);
    const b = await created(store);
    const facts = factsFor('0.163.0');
    const files = { 'codex.exe': 'identical program', 'codex-path/rg.exe': 'identical helper' };
    expect((await promoteVersion(store, a, facts, files)).ok).toBe(true);
    expect((await promoteVersion(store, b, facts, files)).ok).toBe(true);
    const folderA = store.versionFolder(a, facts.key);
    const folderB = store.versionFolder(b, facts.key);
    expect(folderA).not.toBe(folderB);
    expect(isPathInsideOrEqual(a.root, folderA)).toBe(true);
    expect(isPathInsideOrEqual(b.root, folderB)).toBe(true);
    for (const file of ['codex.exe', path.join('codex-path', 'rg.exe')]) {
      expect(readFileSync(path.join(folderA, file))).toEqual(readFileSync(path.join(folderB, file)));
      const statA = statSync(path.join(folderA, file), { bigint: true });
      const statB = statSync(path.join(folderB, file), { bigint: true });
      expect(statA.ino === statB.ino && statA.dev === statB.dev).toBe(false);
    }
  });
});

/** A seeded generator, so a failure names the sequence that produced it. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('root confinement of instances', () => {
  it('keeps every path that any operation on an instance opens, creates, renames or deletes below that instance or its own work folder', async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const calls: FsCall[] = [];
      let recording = false;
      const { fs } = recordingFs((call) => { if (recording) calls.push(call); });
      const k = kit({ fs });
      const { store, roots, processes, clock } = k;
      const a = await created(store);
      const b = await created(store);
      // B holds the same version: an operation on A that reached B's files would show here.
      await promoteVersion(store, b, factsFor('0.160.0'));
      recording = true;

      const random = prng(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
      const versions = ['0.160.0', '0.161.0', '0.162.0', '0.163.0', '0.164.0'];
      const leases: Lease[] = [];
      const stagings: StagingFolder[] = [];
      const works: WorkFolder[] = [];
      let tokens = 0;
      const nextToken = () => (++tokens + seed * 1000).toString(16).padStart(32, '0');
      const steps: Array<[string, () => Promise<unknown> | unknown]> = [
        ['promote', () => promoteVersion(store, a, factsFor(pick(versions)))],
        ['staging', () => { stagings.push(store.createStaging(a, nextToken())); }],
        ['discard', () => (stagings.length ? store.discardStaging(stagings.pop() as StagingFolder) : undefined)],
        ['lease', () => { leases.push(store.createLease(a, factsFor(pick(versions)).key, pick(['session', 'probe', 'download', 'maintenance'] as const), processes.start(100, CREATED.host))); }],
        ['child', () => (leases.length ? store.recordLeaseChild(leases[leases.length - 1], { pid: 101, creation: CREATED.child }) : undefined)],
        ['release', () => (leases.length ? store.releaseLease(leases.pop() as Lease) : undefined)],
        ['liveness', () => store.leaseLiveness(a, factsFor(pick(versions)).key)],
        ['dead', () => { processes.stop(100); processes.stop(101); }],
        ['admission', () => { const gate = store.acquireAdmission(a); if (gate.ok) gate.handle.release(); return store.admissionState(a); }],
        ['read', () => store.read(a)],
        ['publish', () => store.publish(a, { label: 'x', apply: (current) => ({ ...current, schedule: { lastAttemptAt: new Date(Date.UTC(2026, 9, 20)).toISOString() } }) })],
        ['repair', () => store.repairManifest(a)],
        ['folders', () => [store.listVersionFolders(a), store.versionFolder(a, factsFor(pick(versions)).key)]],
        ['usage', () => store.usageBytes(a)],
        ['collect', () => store.collectVersions(a, { protectedKeys: new Set([factsFor(pick(versions)).key]), keep: 3 })],
        ['orphans', () => { clock.offsetMs = 11 * 60 * 1000; return store.retireOrphans(a); }],
        ['retire', () => store.retireVersion(a, factsFor(pick(versions)).key)],
        ['work', () => { works.push(store.createWorkFolder(a, nextToken())); }],
        ['unwork', () => (works.length ? store.removeWorkFolder(works.pop() as WorkFolder) : undefined)],
      ];
      // Every kind of step at least once, then a random program.
      const program = [...steps, ...Array.from({ length: 30 }, () => pick(steps))];
      for (const [name, step] of program) {
        try {
          await step();
        } catch (error) {
          throw new Error(`seed ${seed}, step ${name}: ${(error as Error).message}`);
        }
      }
      const ownWork = path.join(roots.work, a.storeId);
      const outside = calls.flatMap((call) => call.paths.map((file) => ({ op: call.op, file })))
        .filter(({ op, file }) => !isPathInsideOrEqual(a.root, file) && !isPathInsideOrEqual(ownWork, file)
          // The shared parent of every work folder is only ever created, one level, when it is missing.
          && !(op === 'mkdir' && file === roots.work));
      expect(outside, `seed ${seed}`).toEqual([]);
      expect(calls.some((call) => call.paths.some((file) => isPathInsideOrEqual(b.root, file)))).toBe(false);
      cleanTemps();
    }
  }, 60_000);

  const BAD_KEYS: unknown[] = [
    '..', '.', '', ' ', null, 7, {},
    '../0.163.0-win32-x64-0123456789abcdef',
    '0.163.0-win32-x64-0123456789abcdef/..',
    '0.163.0-win32-x64-0123456789abcdef\\..',
    '..\\0.163.0-win32-x64-0123456789abcdef',
    'C:\\0.163.0-win32-x64-0123456789abcdef',
    'C:0.163.0-win32-x64-0123456789abcdef',
    '0.163.0-win32-x64-0123456789ABCDEF',
    '0.163.0-WIN32-x64-0123456789abcdef',
    '0.163.0-win32-x64-0123456789abcde',
    '0.163.0-win32-x64-0123456789abcdef0',
    '0.163.0-beta.1-win32-x64-0123456789abcdef',
    '0.163.0-linux-x64-0123456789abcdef',
    '0.163.0-win32-x64-0123456789abcdef ',
  ];
  const BAD_TOKENS: unknown[] = [
    '..', '', null, 7, 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), `${'a'.repeat(30)}/x`, `${'a'.repeat(30)}\\x`,
    `C:${'a'.repeat(30)}`, `../${'a'.repeat(29)}`, `${'g'.repeat(32)}`,
  ];

  async function refusedBeforeAnyCall(label: string, store: InstanceStoreApi, calls: FsCall[], run: () => unknown): Promise<void> {
    calls.length = 0;
    let threw = false;
    try {
      await run();
    } catch (error) {
      threw = error instanceof TypeError;
    }
    expect(threw, label).toBe(true);
    expect(calls, label).toEqual([]);
  }

  it('refuses malformed keys, tokens and references before any file-system call, in every operation', async () => {
    const calls: FsCall[] = [];
    let recording = false;
    const { fs } = recordingFs((call) => { if (recording) calls.push(call); });
    const { store, processes } = kit({ fs });
    const ref = await created(store);
    const good = factsFor('0.163.0').key;
    const lease = store.createLease(ref, good, 'session', processes.start(100, CREATED.host));
    const staging = store.createStaging(ref, 'c'.repeat(32));
    const work = store.createWorkFolder(ref, 'd'.repeat(32));
    recording = true;
    const holder = { pid: 100, creation: CREATED.host };

    for (const key of BAD_KEYS) {
      const k = key as string;
      await refusedBeforeAnyCall(`versionFolder ${String(key)}`, store, calls, () => store.versionFolder(ref, k));
      await refusedBeforeAnyCall(`createLease ${String(key)}`, store, calls, () => store.createLease(ref, k, 'session', holder));
      await refusedBeforeAnyCall(`leaseLiveness ${String(key)}`, store, calls, () => store.leaseLiveness(ref, k));
      await refusedBeforeAnyCall(`retireVersion ${String(key)}`, store, calls, () => store.retireVersion(ref, k));
      await refusedBeforeAnyCall(`recordLeaseChild ${String(key)}`, store, calls, () => store.recordLeaseChild({ ...lease, key: k }, holder));
      await refusedBeforeAnyCall(`releaseLease ${String(key)}`, store, calls, () => store.releaseLease({ ...lease, key: k }));
      await refusedBeforeAnyCall(`promote ${String(key)}`, store, calls, () => store.promote(ref, staging, { ...factsFor('0.163.0'), key: k }));
    }
    for (const token of BAD_TOKENS) {
      const t = token as string;
      await refusedBeforeAnyCall(`createStaging ${String(token)}`, store, calls, () => store.createStaging(ref, t));
      await refusedBeforeAnyCall(`createWorkFolder ${String(token)}`, store, calls, () => store.createWorkFolder(ref, t));
      await refusedBeforeAnyCall(`discardStaging ${String(token)}`, store, calls, () => store.discardStaging({ ...staging, taskToken: t }));
      await refusedBeforeAnyCall(`removeWorkFolder ${String(token)}`, store, calls, () => store.removeWorkFolder({ ...work, token: t }));
      await refusedBeforeAnyCall(`releaseLease token ${String(token)}`, store, calls, () => store.releaseLease({ ...lease, token: t }));
      await refusedBeforeAnyCall(`recordLeaseChild token ${String(token)}`, store, calls, () => store.recordLeaseChild({ ...lease, token: t }, holder));
      await refusedBeforeAnyCall(`discardStaging storeId ${String(token)}`, store, calls, () => store.discardStaging({ ...staging, storeId: t }));
      await refusedBeforeAnyCall(`removeWorkFolder storeId ${String(token)}`, store, calls, () => store.removeWorkFolder({ ...work, storeId: t }));
    }
    // Objects that carry a path of their own are refused when it is not the one their names derive.
    await refusedBeforeAnyCall('discardStaging root', store, calls, () => store.discardStaging({ ...staging, root: ref.root }));
    await refusedBeforeAnyCall('promote payload', store, calls, () => store.promote(ref, { ...staging, payload: path.join(ref.root, 'versions') }, factsFor('0.163.0')));
    await refusedBeforeAnyCall('removeWorkFolder root', store, calls, () => store.removeWorkFolder({ ...work, root: ref.root }));

    const badRefs: InstanceRef[] = [
      ...BAD_TOKENS.map((storeId) => ({ storeId: storeId as string, root: ref.root })),
      { storeId: ref.storeId, root: path.dirname(ref.root) },
      { storeId: ref.storeId, root: `${ref.root}${path.sep}` },
      { storeId: ref.storeId, root: ref.root.toUpperCase() === ref.root ? `${ref.root}x` : ref.root.toUpperCase() },
      null as unknown as InstanceRef,
    ];
    const everyRefOperation: Array<[string, (bad: InstanceRef) => unknown]> = [
      ['admissionState', (bad) => store.admissionState(bad)],
      ['acquireAdmission', (bad) => store.acquireAdmission(bad)],
      ['closeAdmission', (bad) => store.closeAdmission(bad)],
      ['read', (bad) => store.read(bad)],
      ['publish', (bad) => store.publish(bad, { label: 'x', apply: (current) => current })],
      ['repairManifest', (bad) => store.repairManifest(bad)],
      ['versionFolder', (bad) => store.versionFolder(bad, good)],
      ['listVersionFolders', (bad) => store.listVersionFolders(bad)],
      ['createStaging', (bad) => store.createStaging(bad, 'e'.repeat(32))],
      ['promote', (bad) => store.promote(bad, staging, factsFor('0.163.0'))],
      ['createLease', (bad) => store.createLease(bad, good, 'session', holder)],
      ['recordLeaseChild', (bad) => store.recordLeaseChild({ ...lease, ref: bad }, holder)],
      ['releaseLease', (bad) => store.releaseLease({ ...lease, ref: bad })],
      ['leaseLiveness', (bad) => store.leaseLiveness(bad, good)],
      ['createWorkFolder', (bad) => store.createWorkFolder(bad, 'e'.repeat(32))],
      ['usageBytes', (bad) => store.usageBytes(bad)],
      ['collectVersions', (bad) => store.collectVersions(bad, { protectedKeys: new Set(), keep: 3 })],
      ['retireOrphans', (bad) => store.retireOrphans(bad)],
      ['retireVersion', (bad) => store.retireVersion(bad, good)],
    ];
    for (const bad of badRefs) {
      for (const [name, run] of everyRefOperation) {
        await refusedBeforeAnyCall(`${name} ${JSON.stringify(bad)}`, store, calls, () => run(bad));
      }
    }
    // A staging folder of another instance is refused before anything moves.
    writeFileSync(path.join(staging.payload, 'codex.exe'), 'x');
    const other = await created(store);
    calls.length = 0;
    await expect(store.promote(other, staging, factsFor('0.163.0'))).rejects.toThrow(TypeError);
    expect(calls.filter((call) => call.op === 'rename')).toEqual([]);
  });
});
