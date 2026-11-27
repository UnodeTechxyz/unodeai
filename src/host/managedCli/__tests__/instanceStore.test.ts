import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstanceRecord, InstanceRef } from '../contracts';
import { generationFileName, publishGeneration, readJournal, type JournalSpec } from '../generationJournal';
import {
  ADMISSION_CLOSE_ATTEMPTS,
  ADMISSION_CLOSE_INTERVAL_MS,
  identityFileBytes,
  identityOfCopy,
  identityRecord,
  IDENTITY_SECOND_COPY,
  INSTANCE_PUBLISH_ROUNDS,
  INSTANCE_SCHEMA,
  nodeInstanceFs,
} from '../instanceStore';
import { recordDigest } from '../storeLayout';
import { cleanTemps, created, factsFor, fsError, kit, recordingFs, tempRoots } from './instanceTestKit';

// The design these tests realise (the store design for immutable instances, with Codex's binding rulings):
// - an instance has a random store id that is never reused, an `identity.bin` with two checksummed copies read through
//   the handle that opened it, and is complete only once `admission\open\guard.bin` exists; a mismatch always refuses,
//   and there is no adoption of an identity found at a path;
// - the admission gate: a launch opens `guard.bin` and reads the identity through that handle; a Reset renames
//   `admission\open` to `admission\closed` with 30 attempts 100 ms apart, and reports that nothing changed when the
//   rename cannot win; a closed gate refuses every launch;
// - the instance manifest holds positive facts only, published by exact-predecessor CAS; a fact needs no folder; a
//   repair moves only damaged generations above the newest valid one, and never for a newer schema.

afterEach(cleanTemps);

const ID_A = 'a1'.repeat(16);
const ID_B = 'b2'.repeat(16);

function readIdentityCopies(file: string): Array<string | undefined> {
  const bytes = readFileSync(file);
  return [identityOfCopy(bytes.subarray(0, 64)), identityOfCopy(bytes.subarray(IDENTITY_SECOND_COPY, IDENTITY_SECOND_COPY + 64))];
}

function instanceSpec(ref: InstanceRef): JournalSpec<InstanceRecord> {
  return { folder: path.join(ref.root, 'manifests'), prefix: 'instance', parse: (value) => ({ ok: true, record: value as InstanceRecord }) };
}

// =============================================================================================
// Identity and creation
// =============================================================================================

describe('the identity record', () => {
  it('is magic UNID, format 1, the 16 bytes of the store id, u32 zero, 4 zero bytes and the SHA-256 of bytes 0-31', () => {
    const record = identityRecord(ID_A);
    expect(record.length).toBe(64);
    expect(record.subarray(0, 4).toString('ascii')).toBe('UNID');
    expect(record.readUInt32LE(4)).toBe(1);
    expect(record.subarray(8, 24).toString('hex')).toBe(ID_A);
    expect(record.subarray(24, 32)).toEqual(Buffer.alloc(8));
    expect(identityOfCopy(record)).toBe(ID_A);
    const file = identityFileBytes(ID_A);
    expect(file.length).toBe(IDENTITY_SECOND_COPY + 64);
    expect(file.subarray(IDENTITY_SECOND_COPY)).toEqual(record);
    expect(file.subarray(64, IDENTITY_SECOND_COPY)).toEqual(Buffer.alloc(IDENTITY_SECOND_COPY - 64));
  });

  it.each([
    ['the magic', 0],
    ['the format', 4],
    ['the store id', 12],
    ['the u32 zero', 25],
    ['the four zero bytes', 30],
    ['the checksum', 40],
  ])('is not valid with %s changed', (_label, offset) => {
    const record = identityRecord(ID_A);
    record[offset] ^= 0x01;
    expect(identityOfCopy(record)).toBeUndefined();
  });
});

describe('create()', () => {
  it('builds the identity, the layout, the first manifest and, last, the open gate; the ref comes only then', async () => {
    const { fs, calls } = recordingFs();
    const { store, roots } = kit({ fs });
    const result = await store.create();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { ref } = result;
    expect(ref.root).toBe(path.join(roots.instances, ref.storeId));
    expect(readIdentityCopies(path.join(ref.root, 'identity.bin'))).toEqual([ref.storeId, ref.storeId]);
    expect(readIdentityCopies(path.join(ref.root, 'admission', 'open', 'guard.bin'))).toEqual([ref.storeId, ref.storeId]);
    expect(readdirSync(ref.root).sort()).toEqual(['admission', 'identity.bin', 'leases', 'manifests', 'staging', 'trash', 'versions']);
    const journal = readJournal(instanceSpec(ref));
    expect(journal).toMatchObject({ kind: 'ok', generation: 1, record: { schema: INSTANCE_SCHEMA, storeId: ref.storeId, versions: {}, probes: {}, stagingIntents: {}, schedule: {} } });

    // Every folder is made one level at a time; identity first, the guard last, after the first generation's link.
    const writes = calls.filter((call) => ['mkdir', 'writeExclusive', 'link'].includes(call.op))
      .map((call) => `${call.op} ${path.relative(roots.root, call.paths[call.paths.length - 1])}`.replace(/\\/g, '/').replace(ref.storeId, 'ID').replace(/tmp-[0-9a-f]{32}/, 'tmp'));
    expect(writes).toEqual([
      'mkdir instances',
      'mkdir instances/ID',
      'writeExclusive instances/ID/identity.bin',
      'mkdir instances/ID/manifests',
      'mkdir instances/ID/versions',
      'mkdir instances/ID/staging',
      'mkdir instances/ID/leases',
      'mkdir instances/ID/trash',
      'mkdir instances/ID/admission',
      'mkdir instances/ID/admission/open',
      'writeExclusive instances/ID/manifests/.instance.tmp',
      `link instances/ID/manifests/${generationFileName('instance', 1)}`,
      'writeExclusive instances/ID/admission/open/guard.bin',
    ]);
  });

  it('chooses a new id when the folder exists, at most three times', async () => {
    const roots = tempRoots();
    mkdirSync(roots.instances);
    mkdirSync(path.join(roots.instances, ID_A));
    const ids = [ID_A, ID_A, ID_B];
    const { store } = kit({ random: () => Buffer.from(ids.shift() ?? ID_B, 'hex') }, roots);
    const result = await store.create();
    expect(result).toMatchObject({ ok: true, ref: { storeId: ID_B } });
    // The existing folder was not written into.
    expect(readdirSync(path.join(roots.instances, ID_A))).toEqual([]);

    const always = kit({ random: () => Buffer.from(ID_A, 'hex') }, roots);
    expect(await always.store.create()).toMatchObject({ ok: false });
  });

  it('creates nothing when the store folder itself is missing (no recursive creation)', async () => {
    const roots = tempRoots();
    rmSync(roots.root, { recursive: true });
    const { store } = kit({}, roots);
    expect(await store.create()).toMatchObject({ ok: false });
    expect(existsSync(roots.root)).toBe(false);
  });

  it('gives every instance its own id', async () => {
    const { store } = kit();
    const ids = new Set<string>();
    for (let index = 0; index < 5; index++) ids.add((await created(store)).storeId);
    expect(ids.size).toBe(5);
  });
});

// =============================================================================================
// open(): no fallback, no adoption (Codex §14.9)
// =============================================================================================

describe('open()', () => {
  it('opens a complete instance, and a closed one', async () => {
    const { store } = kit();
    const ref = await created(store);
    expect(store.open(ref.storeId)).toEqual({ ok: true, ref: { storeId: ref.storeId, root: ref.root } });
    expect((await store.closeAdmission(ref)).ok).toBe(true);
    expect(store.open(ref.storeId)).toMatchObject({ ok: true });
  });

  it('refuses a name that is not a store id before touching the disk', () => {
    const { fs, calls } = recordingFs();
    const { store } = kit({ fs });
    for (const name of ['..', '../x', 'A1'.repeat(16), 'a1'.repeat(15), `${'a1'.repeat(15)}/x`, 'C:\\x', '', null]) {
      expect(store.open(name as string)).toMatchObject({ ok: false, reason: 'missing' });
    }
    expect(calls).toEqual([]);
  });

  it('refuses a missing instance', () => {
    const { store } = kit();
    expect(store.open(ID_A)).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('refuses another instance\'s identity, and never adopts it (copied identity.bin)', async () => {
    const { store, roots } = kit();
    const a = await created(store);
    const b = await created(store);
    copyFileSync(path.join(b.root, 'identity.bin'), path.join(a.root, 'identity.bin'));
    expect(store.open(a.storeId)).toMatchObject({ ok: false, reason: 'identity-mismatch' });
    // B itself is unaffected, and A's name never yields B's root.
    expect(store.open(b.storeId)).toMatchObject({ ok: true, ref: { root: b.root } });
    expect(path.join(roots.instances, a.storeId)).not.toBe(b.root);
  });

  it('refuses an identity with both copies damaged, and accepts one damaged copy (the other carries it)', async () => {
    const { store } = kit();
    const ref = await created(store);
    const file = path.join(ref.root, 'identity.bin');
    const bytes = readFileSync(file);
    bytes[40] ^= 1;
    writeFileSync(file, bytes);
    expect(store.open(ref.storeId)).toMatchObject({ ok: true });
    bytes[IDENTITY_SECOND_COPY + 40] ^= 1;
    writeFileSync(file, bytes);
    expect(store.open(ref.storeId)).toMatchObject({ ok: false, reason: 'identity-unreadable' });
    writeFileSync(file, '');
    expect(store.open(ref.storeId)).toMatchObject({ ok: false, reason: 'identity-unreadable' });
  });

  it('refuses copies that name different stores', async () => {
    const { store } = kit();
    const ref = await created(store);
    const bytes = identityFileBytes(ref.storeId);
    identityRecord(ID_B).copy(bytes, IDENTITY_SECOND_COPY);
    writeFileSync(path.join(ref.root, 'identity.bin'), bytes);
    expect(store.open(ref.storeId)).toMatchObject({ ok: false, reason: 'identity-mismatch' });
  });

  it('refuses an instance whose gate was never written as incomplete, and a damaged or foreign gate', async () => {
    const { store } = kit();
    const ref = await created(store);
    const guard = path.join(ref.root, 'admission', 'open', 'guard.bin');
    writeFileSync(guard, Buffer.alloc(10));
    expect(store.open(ref.storeId)).toMatchObject({ ok: false, reason: 'identity-unreadable' });
    writeFileSync(guard, identityFileBytes(ID_B));
    expect(store.open(ref.storeId)).toMatchObject({ ok: false, reason: 'identity-mismatch' });
    rmSync(guard);
    expect(store.open(ref.storeId)).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('refuses a ref whose root is not the one its store id derives', async () => {
    const { store } = kit();
    const a = await created(store);
    const b = await created(store);
    expect(() => store.read({ storeId: a.storeId, root: b.root })).toThrow(TypeError);
    expect(() => store.acquireAdmission({ storeId: a.storeId, root: b.root })).toThrow(TypeError);
    expect(() => store.versionFolder({ storeId: a.storeId, root: `${a.root}\\..\\${b.storeId}` }, factsFor('0.163.0').key)).toThrow(TypeError);
  });
});

// =============================================================================================
// The admission gate (Codex §8; Q1/Q4 linearization)
// =============================================================================================

describe('the admission gate', () => {
  it('is open after create(), closed after closeAdmission(), missing when neither exists', async () => {
    const { store } = kit();
    const ref = await created(store);
    expect(store.admissionState(ref)).toBe('open');
    expect(await store.closeAdmission(ref)).toEqual({ ok: true, alreadyClosed: false });
    expect(store.admissionState(ref)).toBe('closed');
    expect(readdirSync(path.join(ref.root, 'admission'))).toEqual(['closed']);
    rmSync(path.join(ref.root, 'admission', 'closed'), { recursive: true });
    expect(store.admissionState(ref)).toBe('missing');
  });

  it('admits with a handle whose release() closes the one handle once; the identity is read through it, guard.bin opened once', async () => {
    const { fs, calls } = recordingFs();
    const { store } = kit({ fs });
    const ref = await created(store);
    calls.length = 0;
    const first = store.acquireAdmission(ref);
    expect(first).toMatchObject({ ok: true, handle: { storeId: ref.storeId } });
    if (!first.ok) return;
    expect(calls.filter((call) => call.op === 'openRead').map((call) => call.paths[0])).toEqual([path.join(ref.root, 'admission', 'open', 'guard.bin')]);
    expect(calls.filter((call) => call.op === 'readFile' || call.op === 'lstat')).toEqual([]);
    expect(calls.filter((call) => call.op === 'read').length).toBeGreaterThanOrEqual(2);
    expect(calls.filter((call) => call.op === 'close')).toEqual([]);
    first.handle.release();
    first.handle.release();
    expect(calls.filter((call) => call.op === 'close')).toHaveLength(1);
  });

  it('reads the identity that was at the path when it opened, even if the file is replaced afterwards', async () => {
    let swap: (() => void) | undefined;
    const { fs } = recordingFs((call) => { if (call.op === 'read' && swap) { const run = swap; swap = undefined; run(); } });
    const { store } = kit({ fs });
    const ref = await created(store);
    const guard = path.join(ref.root, 'admission', 'open', 'guard.bin');
    // A path re-open after the replacement would read B's identity and refuse; the handle reads A's.
    swap = () => { renameSync(guard, `${guard}.old`); writeFileSync(guard, identityFileBytes(ID_B)); };
    const acquired = store.acquireAdmission(ref);
    expect(acquired.ok).toBe(true);
    if (acquired.ok) acquired.handle.release();
    expect(store.acquireAdmission(ref)).toMatchObject({ ok: false, reason: 'identity-mismatch' });
  });

  it('refuses a closed gate, a missing gate, a damaged gate and a foreign gate, closing every handle it opened', async () => {
    const { fs: recording, calls } = recordingFs();
    let opened = 0;
    const fs = { ...recording, openRead: (file: string) => { const fd = recording.openRead(file); opened++; return fd; } };
    const { store } = kit({ fs });
    const ref = await created(store);
    const guard = path.join(ref.root, 'admission', 'open', 'guard.bin');
    opened = 0;
    calls.length = 0;
    const opens = () => opened;
    const closes = () => calls.filter((call) => call.op === 'close').length;

    writeFileSync(guard, Buffer.alloc(64));
    expect(store.acquireAdmission(ref)).toMatchObject({ ok: false, reason: 'unreadable' });
    writeFileSync(guard, identityFileBytes(ID_B));
    expect(store.acquireAdmission(ref)).toMatchObject({ ok: false, reason: 'identity-mismatch' });
    expect(opens()).toBe(closes());

    rmSync(guard);
    expect(store.acquireAdmission(ref)).toMatchObject({ ok: false, reason: 'unreadable' });
    writeFileSync(guard, identityFileBytes(ref.storeId));
    expect((await store.closeAdmission(ref)).ok).toBe(true);
    expect(store.acquireAdmission(ref)).toMatchObject({ ok: false, reason: 'closed' });
    expect(opens()).toBe(closes());
  });

  it('closes with up to 30 attempts 100 ms apart while the rename is refused, then reports that nothing changed', async () => {
    let refuse = Number.POSITIVE_INFINITY;
    const { fs, calls } = recordingFs((call) => {
      if (call.op === 'rename' && refuse-- > 0) throw fsError('EPERM');
    });
    const { store, sleeps } = kit({ fs });
    const ref = await created(store);
    const result = await store.closeAdmission(ref);
    expect(result).toEqual({ ok: false, code: 'EPERM', attempts: ADMISSION_CLOSE_ATTEMPTS });
    expect(ADMISSION_CLOSE_ATTEMPTS).toBe(30);
    expect(sleeps).toEqual(Array(29).fill(ADMISSION_CLOSE_INTERVAL_MS));
    expect(ADMISSION_CLOSE_INTERVAL_MS).toBe(100);
    expect(calls.filter((call) => call.op === 'rename')).toHaveLength(30);
    expect(store.admissionState(ref)).toBe('open');
    const admitted = store.acquireAdmission(ref);
    expect(admitted.ok).toBe(true);
    if (admitted.ok) admitted.handle.release();

    refuse = 2;
    sleeps.length = 0;
    expect(await store.closeAdmission(ref)).toEqual({ ok: true, alreadyClosed: false });
    expect(sleeps).toHaveLength(2);
    expect(store.admissionState(ref)).toBe('closed');
  });

  it.each(['EBUSY', 'EACCES'])('retries %s as it retries EPERM', async (code) => {
    let refuse = 1;
    const { fs } = recordingFs((call) => { if (call.op === 'rename' && refuse-- > 0) throw fsError(code); });
    const { store } = kit({ fs });
    const ref = await created(store);
    expect(await store.closeAdmission(ref)).toEqual({ ok: true, alreadyClosed: false });
  });

  it('fails at once on another error, and reports an already closed gate', async () => {
    let fail = true;
    const { fs } = recordingFs((call) => { if (call.op === 'rename' && fail) throw fsError('EIO'); });
    const { store } = kit({ fs });
    const ref = await created(store);
    expect(await store.closeAdmission(ref)).toEqual({ ok: false, code: 'EIO', attempts: 1 });
    expect(store.admissionState(ref)).toBe('open');
    fail = false;
    expect(await store.closeAdmission(ref)).toEqual({ ok: true, alreadyClosed: false });
    expect(await store.closeAdmission(ref)).toEqual({ ok: true, alreadyClosed: true });
  });

  it('counts a close that another window won between the check and the rename as already closed', async () => {
    let race = true;
    const { fs } = recordingFs((call) => {
      if (call.op === 'rename' && race) {
        race = false;
        renameSync(call.paths[0], call.paths[1]);
      }
    });
    const { store } = kit({ fs });
    const ref = await created(store);
    expect(await store.closeAdmission(ref)).toEqual({ ok: true, alreadyClosed: true });
  });

  it('changes nothing when both open and closed exist (damage)', async () => {
    const { store } = kit();
    const ref = await created(store);
    mkdirSync(path.join(ref.root, 'admission', 'closed'));
    expect(await store.closeAdmission(ref)).toEqual({ ok: false, code: 'EEXIST', attempts: 0 });
    expect(existsSync(path.join(ref.root, 'admission', 'open', 'guard.bin'))).toBe(true);
  });

  it.runIf(process.platform === 'win32')('cannot be closed while this process holds it; a second admission succeeds meanwhile; after release the close wins at the first attempt', async () => {
    let renames = 0;
    const { fs } = recordingFs((call) => { if (call.op === 'rename') renames++; });
    const { store } = kit({ fs });
    const ref = await created(store);
    const held = store.acquireAdmission(ref);
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    const refused = await store.closeAdmission(ref);
    expect(refused).toMatchObject({ ok: false, attempts: ADMISSION_CLOSE_ATTEMPTS });
    expect(store.admissionState(ref)).toBe('open');
    const second = store.acquireAdmission(ref);
    expect(second.ok).toBe(true);
    if (second.ok) second.handle.release();
    held.handle.release();
    renames = 0;
    expect(await store.closeAdmission(ref)).toEqual({ ok: true, alreadyClosed: false });
    expect(renames).toBe(1);
    expect(store.acquireAdmission(ref)).toMatchObject({ ok: false, reason: 'closed' });
  });
});

// =============================================================================================
// The instance manifest (merged design §5: positive facts only)
// =============================================================================================

describe('reading the instance manifest', () => {
  it('reads a new instance, a missing one, and one without any generation', async () => {
    const { store } = kit();
    const ref = await created(store);
    expect(store.read(ref)).toMatchObject({ kind: 'readable', snapshot: { generation: 1, record: { storeId: ref.storeId } } });
    const missing = { storeId: ID_A, root: path.join(path.dirname(ref.root), ID_A) };
    expect(store.read(missing)).toMatchObject({ kind: 'unusable', reason: 'missing' });
    for (const name of readdirSync(path.join(ref.root, 'manifests'))) rmSync(path.join(ref.root, 'manifests', name));
    expect(store.read(ref)).toMatchObject({ kind: 'unusable', reason: 'store-corrupt' });
  });

  function writeGeneration(ref: InstanceRef, generation: number, previous: string | null, fields: Record<string, unknown>): void {
    const record = { schema: INSTANCE_SCHEMA, storeId: ref.storeId, versions: {}, probes: {}, stagingIntents: {}, schedule: {}, generation, previousRecordDigest: previous, ...fields };
    writeFileSync(path.join(ref.root, 'manifests', generationFileName('instance', generation)), JSON.stringify({ ...record, recordDigest: recordDigest(record) }));
  }

  it('reads a newer schema above the newest valid generation as store-newer-schema', async () => {
    const { store } = kit();
    const ref = await created(store);
    const current = store.read(ref);
    if (current.kind !== 'readable') throw new Error('setup');
    writeGeneration(ref, 2, current.snapshot.digest, { schema: 'unodeai.cli-instance/2' });
    expect(store.read(ref)).toMatchObject({ kind: 'unusable', reason: 'store-newer-schema' });
  });

  const facts = factsFor('0.163.0');
  const probe = { key: facts.key, closureDigest: 'c'.repeat(64), versionOutput: 'codex-cli 0.163.0', startedAt: '2026-10-20T08:01:00.000Z', durationMs: 900 };

  it.each([
    ['another store id', { storeId: ID_B }],
    ['an unknown field', { extra: 1 }],
    ['a probe of a version that is not listed', { probes: { [facts.key]: probe } }],
    ['a probe filed under another key', { versions: { [facts.key]: facts }, probes: { [facts.key]: { ...probe, key: factsFor('0.162.0').key } } }],
    ['facts filed under another key', { versions: { [factsFor('0.162.0').key]: facts } }],
    ['facts whose key is not their artifact\'s', { versions: { [facts.key]: { ...facts, artifactSha256: 'd'.repeat(64) } } }],
    ['facts with an unbounded string', { versions: { [facts.key]: { ...facts, policyEntryId: 'x'.repeat(201) } } }],
    ['facts with a field out of bounds', { versions: { [facts.key]: { ...facts, verification: { ...facts.verification, files: -1 } } } }],
    ['a staging intent with a bad owner', { stagingIntents: { ['e'.repeat(32)]: { key: facts.key, owner: { pid: 0, creation: 'pending' }, startedAt: '2026-10-20T08:00:00.000Z' } } }],
    ['too many versions', { versions: Object.fromEntries(Array.from({ length: 65 }, (_, index) => { const each = factsFor(`0.${200 + index}.0`); return [each.key, each]; })) }],
    ['a probe with a multi-line output', { versions: { [facts.key]: facts }, probes: { [facts.key]: { ...probe, versionOutput: 'a\nb' } } }],
    ['a schedule failure of an unknown class', { schedule: { failure: { class: 'other', entryId: 'x', at: '2026-10-20T08:00:00.000Z', attempts: 1, detail: 'x' } } }],
  ])('treats a record with %s as damage', async (_label, fields) => {
    const { store } = kit();
    const ref = await created(store);
    const current = store.read(ref);
    if (current.kind !== 'readable') throw new Error('setup');
    writeGeneration(ref, 2, current.snapshot.digest, fields);
    expect(store.read(ref)).toMatchObject({ kind: 'unusable', reason: 'store-corrupt' });
  });

  it('reads facts and probes whose folders do not exist: the manifest never requires a folder', async () => {
    const { store } = kit();
    const ref = await created(store);
    const current = store.read(ref);
    if (current.kind !== 'readable') throw new Error('setup');
    writeGeneration(ref, 2, current.snapshot.digest, { versions: { [facts.key]: facts }, probes: { [facts.key]: probe } });
    expect(store.read(ref)).toMatchObject({ kind: 'readable', snapshot: { generation: 2, record: { versions: { [facts.key]: facts }, probes: { [facts.key]: probe } } } });
    expect(existsSync(store.versionFolder(ref, facts.key))).toBe(false);
  });
});

describe('publishing the instance manifest', () => {
  const facts = factsFor('0.163.0');
  const addFacts = (version = facts) => ({
    label: 'add',
    apply: (current: InstanceRecord) => ({ versions: { ...current.versions, [version.key]: version }, probes: current.probes, stagingIntents: current.stagingIntents, schedule: current.schedule }),
  });

  it('publishes the next generation, chained by digest, with the store id and schema set by the store', async () => {
    const { store } = kit();
    const ref = await created(store);
    const result = await store.publish(ref, addFacts());
    expect(result).toMatchObject({ outcome: 'published', snapshot: { generation: 2, record: { storeId: ref.storeId, schema: INSTANCE_SCHEMA, versions: { [facts.key]: facts } } } });
    expect(store.read(ref)).toMatchObject({ kind: 'readable', snapshot: { generation: 2 } });
  });

  it('decides again from the winner when another window publishes first, never applying the old decision', async () => {
    let competitor: (() => void) | undefined;
    const { fs } = recordingFs((call) => {
      if (call.op === 'link' && competitor) { const run = competitor; competitor = undefined; run(); }
    });
    const { store } = kit({ fs });
    const ref = await created(store);
    const other = factsFor('0.162.0');
    competitor = () => {
      const current = readJournal({ folder: path.join(ref.root, 'manifests'), prefix: 'instance', parse: (value) => ({ ok: true, record: value as InstanceRecord }) });
      if (current.kind !== 'ok') throw new Error('setup');
      const { generation: _g, previousRecordDigest: _p, recordDigest: _d, ...content } = current.record as InstanceRecord & { recordDigest?: string };
      publishGeneration(instanceSpec(ref), current, { ...content, versions: { [other.key]: other } }, nodeInstanceFs);
    };
    const seen: string[][] = [];
    const result = await store.publish(ref, {
      label: 'add',
      apply: (current) => {
        seen.push(Object.keys(current.versions));
        return { ...current, versions: { ...current.versions, [facts.key]: facts } };
      },
    });
    expect(result).toMatchObject({ outcome: 'published', snapshot: { generation: 3 } });
    expect(seen).toEqual([[], [other.key]]);
    const view = store.read(ref);
    expect(view.kind === 'readable' && Object.keys(view.snapshot.record.versions).sort()).toEqual([other.key, facts.key].sort());
  });

  it('reports busy after five lost rounds, publishing nothing of its own', async () => {
    let lose = false;
    const { fs } = recordingFs((call) => { if (call.op === 'link' && lose) throw fsError('EEXIST'); });
    const { store } = kit({ fs });
    const ref = await created(store);
    lose = true;
    let rounds = 0;
    const result = await store.publish(ref, { label: 'add', apply: (current) => { rounds++; return { ...current, versions: { [facts.key]: facts } }; } });
    expect(result).toEqual({ outcome: 'busy' });
    expect(rounds).toBe(INSTANCE_PUBLISH_ROUNDS);
    expect(INSTANCE_PUBLISH_ROUNDS).toBe(5);
    expect(store.read(ref)).toMatchObject({ kind: 'readable', snapshot: { generation: 1 } });
  });

  it('passes moot and refused through, and refuses a change that would make an invalid record', async () => {
    const { store } = kit();
    const ref = await created(store);
    expect(await store.publish(ref, { label: 'x', apply: () => ({ moot: true }) })).toMatchObject({ outcome: 'moot', snapshot: { generation: 1 } });
    expect(await store.publish(ref, { label: 'x', apply: () => ({ refused: 'no' }) })).toEqual({ outcome: 'refused', reason: 'no' });
    const invalid = await store.publish(ref, { label: 'x', apply: (current) => ({ ...current, versions: { [facts.key]: { ...facts, os: 'linux' as 'win32' } } }) });
    expect(invalid.outcome).toBe('refused');
    expect(store.read(ref)).toMatchObject({ kind: 'readable', snapshot: { generation: 1 } });
  });

  it('refuses to publish while the manifest is unusable', async () => {
    const { store } = kit();
    const ref = await created(store);
    writeFileSync(path.join(ref.root, 'manifests', generationFileName('instance', 2)), '{');
    let applied = false;
    const result = await store.publish(ref, { label: 'x', apply: (current) => { applied = true; return current; } });
    expect(result).toMatchObject({ outcome: 'unusable', view: { reason: 'store-corrupt' } });
    expect(applied).toBe(false);
  });

  it('trims old generations after publishing', async () => {
    const { store } = kit();
    const ref = await created(store);
    for (let index = 0; index < 14; index++) {
      await store.publish(ref, { label: 'x', apply: (current) => ({ ...current, schedule: { lastAttemptAt: new Date(Date.UTC(2026, 9, 20, 0, index)).toISOString() } }) });
    }
    const files = readdirSync(path.join(ref.root, 'manifests')).filter((name) => name.startsWith('instance-'));
    expect(files).toHaveLength(11);
    expect(store.read(ref)).toMatchObject({ kind: 'readable', snapshot: { generation: 15 } });
  });
});

describe('repairManifest()', () => {
  it('moves only the damaged generations above the newest valid one to trash\\manifests, and the record reads again', async () => {
    const { store } = kit();
    const ref = await created(store);
    await store.publish(ref, { label: 'x', apply: (current) => ({ ...current, schedule: { lastAttemptAt: '2026-10-20T08:00:00.000Z' } }) });
    writeFileSync(path.join(ref.root, 'manifests', generationFileName('instance', 3)), '{"partial"');
    writeFileSync(path.join(ref.root, 'manifests', generationFileName('instance', 5)), 'garbage');
    expect(store.read(ref)).toMatchObject({ kind: 'unusable', reason: 'store-corrupt' });
    const result = store.repairManifest(ref);
    expect(result).toMatchObject({ ok: true, moved: [generationFileName('instance', 3), generationFileName('instance', 5)], view: { kind: 'readable', snapshot: { generation: 2 } } });
    expect(readdirSync(path.join(ref.root, 'manifests')).filter((name) => name.startsWith('instance-')).sort())
      .toEqual([generationFileName('instance', 1), generationFileName('instance', 2)]);
    const trashed = readdirSync(path.join(ref.root, 'trash', 'manifests'));
    expect(trashed.map((name) => name.replace(/\.[0-9a-f]{32}$/, '')).sort()).toEqual([generationFileName('instance', 3), generationFileName('instance', 5)]);
  });

  it('is refused while a file above the newest valid generation is a newer schema, and moves nothing', async () => {
    const { store } = kit();
    const ref = await created(store);
    writeFileSync(path.join(ref.root, 'manifests', generationFileName('instance', 2)), 'garbage');
    const record = { schema: 'unodeai.cli-instance/2', generation: 3 };
    writeFileSync(path.join(ref.root, 'manifests', generationFileName('instance', 3)), JSON.stringify(record));
    expect(store.repairManifest(ref)).toMatchObject({ ok: false, reason: 'newer-schema' });
    expect(readdirSync(path.join(ref.root, 'manifests')).filter((name) => name.startsWith('instance-'))).toHaveLength(3);
  });

  it('has nothing to do for a readable record, and nothing to keep without a valid one', async () => {
    const { store } = kit();
    const ref = await created(store);
    expect(store.repairManifest(ref)).toMatchObject({ ok: true, moved: [] });
    writeFileSync(path.join(ref.root, 'manifests', generationFileName('instance', 1)), 'garbage');
    expect(store.repairManifest(ref)).toMatchObject({ ok: false, reason: 'nothing-valid' });
  });

  it('cannot repair generations that do not form one chain', async () => {
    const { store } = kit();
    const ref = await created(store);
    const record = { schema: INSTANCE_SCHEMA, storeId: ref.storeId, versions: {}, probes: {}, stagingIntents: {}, schedule: {}, generation: 2, previousRecordDigest: 'f'.repeat(64) };
    writeFileSync(path.join(ref.root, 'manifests', generationFileName('instance', 2)), JSON.stringify({ ...record, recordDigest: recordDigest(record) }));
    expect(store.repairManifest(ref)).toMatchObject({ ok: false, reason: 'not-repairable' });
  });

  it('ignores a file another window moved first', async () => {
    let race = true;
    const { fs } = recordingFs((call) => {
      if (call.op === 'rename' && race && call.paths[0].includes('manifests')) { race = false; rmSync(call.paths[0]); }
    });
    const { store } = kit({ fs });
    const ref = await created(store);
    writeFileSync(path.join(ref.root, 'manifests', generationFileName('instance', 2)), 'garbage');
    expect(store.repairManifest(ref)).toMatchObject({ ok: true, moved: [], view: { kind: 'readable' } });
  });

  it('never makes anything launchable: it only moves files, and writes no record', async () => {
    const { fs, calls } = recordingFs();
    const { store } = kit({ fs });
    const ref = await created(store);
    writeFileSync(path.join(ref.root, 'manifests', generationFileName('instance', 2)), 'garbage');
    calls.length = 0;
    store.repairManifest(ref);
    expect(calls.filter((call) => call.op === 'writeExclusive' || call.op === 'link')).toEqual([]);
  });
});
