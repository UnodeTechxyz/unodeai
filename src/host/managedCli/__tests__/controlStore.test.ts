import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cliStoreVersionKey } from '../../../backend/cliCompatibilityPolicy';
import type { AdmissionGateState, ControlChange, ControlRecord, ControlView } from '../contracts';
import {
  createFloor,
  FLOOR_REGION_A,
  FLOOR_REGION_B,
  FLOOR_SEAL,
  floorRecord,
  nextReductionEpoch,
  nodeFloorFs,
  readFloor,
} from '../controlFloor';
import {
  checkControlRecord,
  CONTROL_PUBLISH_ROUNDS,
  createControlStore,
  nodeControlFs,
  SUSPENSION_MAX_BYTES,
  type ControlFs,
} from '../controlStore';
import { generationFileName, nodeJournalFs, type JournalFs } from '../generationJournal';
import { cliStoreRoots } from '../storeLayout';
import {
  A, activate, B, change, consent, D1, D2, disable, enrol, fillFloorTo, generationFiles, K1, K2, key, publishAtEpoch,
  selectExternal, selectManaged, T, touch, tree, undisable,
} from './controlTestKit';

// The design these tests realise: the managed store's control journal and its states (merged store design §3, §4;
// Codex's rulings Q1-Q4; Revision 5 §6.4 and §6.5 for the floor and the blocked states). `read()` evaluates, in this
// order: an empty journal is `fresh` only with no floor reduction and no instance (else `control-missing`, or
// `floor-unavailable` for an invalid floor); a corrupt journal is `control-unreadable`, a newer one
// `control-newer-schema`; a floor of another journal is `control-unreadable`, an unknown floor `floor-unavailable`, the
// seal `sealed`; a record below the floor `behind-floor`; else `ok`. `publish` is the one place control changes: a
// reduction takes E = min(max(P, F) + 1, 4095) and writes both floor regions before it is reported; an increase takes
// no epoch; every round decides again on a fresh predecessor. The shared suspension only removes authority: present
// in any form means blocked, and it is reported only after its bytes were flushed.

const OTHER = '0d'.repeat(16);
const temps: string[] = [];
afterEach(() => {
  for (const folder of temps.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function newRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'unode-control-'));
  temps.push(root);
  return root;
}

function kit(options: { root?: string; fs?: ControlFs; journalFs?: JournalFs; newId?: () => string } = {}) {
  const root = options.root ?? newRoot();
  const gates = new Map<string, AdmissionGateState>();
  const epochCalls: Array<[number, number]> = [];
  const store = createControlStore({
    root,
    admissionState: (storeId) => gates.get(storeId) ?? 'open',
    fs: options.fs,
    journalFs: options.journalFs,
    now: () => new Date(T),
    newId: options.newId,
    nextEpoch: (predecessor, floor) => { epochCalls.push([predecessor, floor]); return nextReductionEpoch(predecessor, floor); },
  });
  return { root, roots: cliStoreRoots(root), gates, store, epochCalls };
}
type Kit = ReturnType<typeof kit>;

async function ready(options: Parameters<typeof kit>[0] = {}): Promise<Kit> {
  const k = kit(options);
  expect((await k.store.initialize()).outcome).toBe('published');
  return k;
}

async function published(k: Kit, item: ControlChange) {
  const result = await k.store.publish(item);
  if (result.outcome !== 'published') throw new Error(`setup: ${item.label} gave ${JSON.stringify(result)}`);
  return result.snapshot;
}

function readable(k: Kit): Extract<ControlView, { kind: 'readable' }> {
  const view = k.store.read();
  if (view.kind !== 'readable') throw new Error(`expected readable, got ${JSON.stringify(view)}`);
  return view;
}

function deleteNewestGeneration(k: Kit): void {
  const files = generationFiles(k.root);
  unlinkSync(path.join(k.roots.controlManifests, files[files.length - 1]));
}

function controlId(k: Kit): string {
  return readable(k).snapshot.record.controlId;
}

const region = (position: number) => position >= FLOOR_REGION_B ? `B@${(position - FLOOR_REGION_B) / 64}` : `A@${position / 64}`;

describe('read(): the control view, in its evaluation order', () => {
  it('is fresh with nothing recorded: no journal, no floor reduction, no instance', async () => {
    expect(kit().store.read()).toEqual({ kind: 'fresh' });
    const k = kit();
    mkdirSync(k.roots.instances);
    expect(k.store.read()).toEqual({ kind: 'fresh' });
  });

  it('is fresh with a floor that holds only its header (an initialisation that stopped before its first generation)', () => {
    const k = kit();
    mkdirSync(k.roots.controlAuthority, { recursive: true });
    createFloor(k.roots.floor, OTHER);
    expect(k.store.read()).toEqual({ kind: 'fresh' });
  });

  it('is control-missing, not fresh, when an instance exists but no generation can be read', () => {
    const k = kit();
    mkdirSync(path.join(k.roots.instances, A), { recursive: true });
    expect(k.store.read()).toMatchObject({ kind: 'unusable', reason: 'control-missing' });
  });

  it('is control-missing, not fresh, when instances\\ cannot be listed', () => {
    const root = newRoot();
    const roots = cliStoreRoots(root);
    const fs: ControlFs = { ...nodeControlFs, readdir: (folder) => { if (folder === roots.instances) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return nodeControlFs.readdir(folder); } };
    expect(kit({ root, fs }).store.read()).toMatchObject({ kind: 'unusable', reason: 'control-missing' });
    writeFileSync(roots.instances, 'not a folder');
    expect(kit({ root }).store.read()).toMatchObject({ kind: 'unusable', reason: 'control-missing' });
  });

  it('reads the floor again when it was missing a moment before the first generation appeared (another window initialising)', async () => {
    const k = await ready();
    let hide = true;
    const fs: ControlFs = {
      ...nodeControlFs,
      open: (file, flags) => {
        if (hide && file === k.roots.floor && flags === 'r') { hide = false; throw Object.assign(new Error('not yet'), { code: 'ENOENT' }); }
        return nodeControlFs.open(file, flags);
      },
    };
    expect(kit({ root: k.root, fs }).store.read()).toMatchObject({ kind: 'readable', authority: 'ok', floor: 0 });
  });

  it('is control-missing, not fresh, when the floor records a reduction (or a torn one) but no generation can be read', async () => {
    const k = await ready();
    await published(k, touch());
    for (const name of generationFiles(k.root)) unlinkSync(path.join(k.roots.controlManifests, name));
    expect(k.store.read()).toMatchObject({ kind: 'unusable', reason: 'control-missing' });

    const torn = kit();
    mkdirSync(torn.roots.controlAuthority, { recursive: true });
    createFloor(torn.roots.floor, OTHER);
    writeFileSync(torn.roots.floor, Buffer.concat([readFileSync(torn.roots.floor).subarray(0, 64 * 3), Buffer.alloc(64, 7), readFileSync(torn.roots.floor).subarray(64 * 4)]));
    expect(readFloor(torn.roots.floor)).toMatchObject({ known: true, floor: 0, torn: [3] });
    expect(torn.store.read()).toMatchObject({ kind: 'unusable', reason: 'control-missing' });
  });

  it('is floor-unavailable when a floor is present but invalid and no generation exists', () => {
    const k = kit();
    mkdirSync(k.roots.controlAuthority, { recursive: true });
    writeFileSync(k.roots.floor, Buffer.alloc(100));
    expect(k.store.read()).toMatchObject({ kind: 'unusable', reason: 'floor-unavailable' });
  });

  it('is readable and ok after initialisation: generation 1, (null, external), epoch 0, floor 0', async () => {
    const k = await ready();
    const view = readable(k);
    expect(view).toMatchObject({ authority: 'ok', floor: 0, snapshot: { generation: 1 } });
    expect(view.snapshot.record).toMatchObject({ enrolledStoreId: null, selection: 'external', enrollment: null, reductionEpoch: 0 });
  });

  it('is control-unreadable when a damaged generation lies above the newest valid one; that one is shown for Details only', async () => {
    const k = await ready();
    await published(k, enrol());
    writeFileSync(path.join(k.roots.controlManifests, generationFileName('control', 3)), '{"schema":"unodeai.cli-control/1"');
    const view = k.store.read();
    expect(view).toMatchObject({ kind: 'unusable', reason: 'control-unreadable', snapshot: { generation: 2 } });
  });

  it('is control-newer-schema when a newer UnodeAi wrote a generation', async () => {
    const k = await ready();
    writeFileSync(path.join(k.roots.controlManifests, generationFileName('control', 2)), JSON.stringify({ schema: 'unodeai.cli-control/2', generation: 2 }));
    expect(k.store.read()).toMatchObject({ kind: 'unusable', reason: 'control-newer-schema' });
  });

  it('is control-unreadable when the floor belongs to another journal', async () => {
    const k = await ready();
    unlinkSync(k.roots.floor);
    createFloor(k.roots.floor, OTHER);
    expect(k.store.read()).toMatchObject({ kind: 'unusable', reason: 'control-unreadable', detail: 'the floor belongs to another control journal' });
  });

  it('is floor-unavailable when the floor is missing, of the wrong size or has both headers damaged while a generation exists', async () => {
    const missing = await ready();
    unlinkSync(missing.roots.floor);
    expect(missing.store.read()).toMatchObject({ kind: 'unusable', reason: 'floor-unavailable', snapshot: { generation: 1 } });

    const short = await ready();
    truncateSync(short.roots.floor, 1000);
    expect(short.store.read()).toMatchObject({ kind: 'unusable', reason: 'floor-unavailable' });

    const headers = await ready();
    const bytes = readFileSync(headers.roots.floor);
    bytes.fill(0, FLOOR_REGION_A, 64);
    bytes.fill(1, FLOOR_REGION_B + 8, FLOOR_REGION_B + 16);
    writeFileSync(headers.roots.floor, bytes);
    expect(headers.store.read()).toMatchObject({ kind: 'unusable', reason: 'floor-unavailable' });
  });

  it('is sealed when the floor holds the seal, whatever the record says, and when the record is sealed', async () => {
    const k = await ready();
    fillFloorTo(k.root, controlId(k), FLOOR_SEAL);
    expect(k.store.read()).toMatchObject({ kind: 'unusable', reason: 'sealed' });

    const record = await ready();
    publishAtEpoch(record.root, FLOOR_SEAL, true);
    expect(record.store.read()).toMatchObject({ kind: 'unusable', reason: 'sealed' });
  });

  it('is behind-floor when a reported reduction\'s generation is lost, and ok otherwise', async () => {
    const k = await ready();
    await published(k, enrol());
    await published(k, selectExternal());
    expect(readable(k)).toMatchObject({ authority: 'ok', floor: 1 });
    deleteNewestGeneration(k);
    expect(readable(k)).toMatchObject({ authority: 'behind-floor', floor: 1, snapshot: { record: { reductionEpoch: 0, selection: 'managed' } } });
  });
});

describe('the control record validator', () => {
  function valid(): Record<string, unknown> {
    return {
      schema: 'unodeai.cli-control/1', controlId: OTHER, generation: 3, previousRecordDigest: 'e'.repeat(64), reductionEpoch: 2,
      enrolledStoreId: A, selection: 'managed', enrollment: { epoch: 1, consentedHosts: ['releases.openai.com', 'github.com'], decidedAt: T },
      scheduler: { epoch: 0, autoMode: true },
      activationConsents: [{ storeId: A, key: K1, closureDigest: D1, decidedAt: T }],
      active: { storeId: A, key: K1 }, lastKnownGood: null,
      disabled: [{ storeId: B, key: K2, reason: 'probe-stop-unconfirmed', at: T, detail: 'stop not confirmed' }],
      retiredInstances: [{ storeId: B, retiredAt: T }], decidedAt: T,
    };
  }

  it('accepts a complete record, and the version key exactly as cliStoreVersionKey names a policy entry\'s folder', () => {
    expect(checkControlRecord(valid())).toMatchObject({ ok: true });
    const policyKey = cliStoreVersionKey({ version: '0.163.0-alpha.2', os: 'win32', arch: 'x64', managed: { artifact: { sha256: 'f'.repeat(64) } } });
    expect(checkControlRecord({ ...valid(), active: { storeId: A, key: policyKey } })).toMatchObject({ ok: true });
  });

  it.each<[string, (record: Record<string, unknown>) => void]>([
    ['selection managed without an enrolled instance', (r) => { r.enrolledStoreId = null; r.enrollment = null; r.active = null; }],
    ['an enrolment without an enrolled instance', (r) => { r.enrolledStoreId = null; r.selection = 'external'; r.active = null; }],
    ['an enrolled instance without its enrolment', (r) => { r.enrollment = null; }],
    ['active naming another instance', (r) => { r.active = { storeId: B, key: K1 }; }],
    ['lastKnownGood naming another instance', (r) => { r.lastKnownGood = { storeId: B, key: K1 }; }],
    ['a malformed store id', (r) => { r.enrolledStoreId = 'A1'.repeat(16); }],
    ['a malformed control id', (r) => { r.controlId = 'abc'; }],
    ['a key that is not a policy folder name', (r) => { r.active = { storeId: A, key: '0.163.0' }; }],
    ['a key of another platform', (r) => { r.active = { storeId: A, key: '0.163.0-linux-x64-0123456789abcdef' }; }],
    ['a key with a path in it', (r) => { r.activationConsents = [{ storeId: A, key: `..\\${K1}`, closureDigest: D1, decidedAt: T }]; }],
    ['an epoch above the seal', (r) => { r.reductionEpoch = FLOOR_SEAL + 1; }],
    ['a negative or fractional epoch', (r) => { r.reductionEpoch = 1.5; }],
    ['sealed below the seal', (r) => { r.sealed = true; }],
    ['the seal without sealed', (r) => { r.reductionEpoch = FLOOR_SEAL; }],
    ['sealed: false', (r) => { r.sealed = false; }],
    ['an upper-case host', (r) => { r.enrollment = { epoch: 1, consentedHosts: ['Releases.openai.com'], decidedAt: T }; }],
    ['a host with a port or path', (r) => { r.enrollment = { epoch: 1, consentedHosts: ['releases.openai.com/x'], decidedAt: T }; }],
    ['more than 16 hosts', (r) => { r.enrollment = { epoch: 1, consentedHosts: Array.from({ length: 17 }, (_, i) => `h${i}.example.com`), decidedAt: T }; }],
    ['a host named twice', (r) => { r.enrollment = { epoch: 1, consentedHosts: ['github.com', 'github.com'], decidedAt: T }; }],
    ['more than 1,000 disabled entries', (r) => { r.disabled = Array.from({ length: 1001 }, () => ({ storeId: A, key: K1, reason: 'local-bad', at: T })); }],
    ['more than 1,000 consents', (r) => { r.activationConsents = Array.from({ length: 1001 }, () => ({ storeId: A, key: K1, closureDigest: D1, decidedAt: T })); }],
    ['more than 1,000 retired instances', (r) => { r.retiredInstances = Array.from({ length: 1001 }, () => ({ storeId: B, retiredAt: T })); }],
    ['a time that is not an ISO string', (r) => { r.decidedAt = 'yesterday'; }],
    ['a disabled entry without an ISO time', (r) => { r.disabled = [{ storeId: A, key: K1, reason: 'local-bad', at: '2026-10-21' }]; }],
    ['an unknown disable reason', (r) => { r.disabled = [{ storeId: A, key: K1, reason: 'fine', at: T }]; }],
    ['an unknown field', (r) => { r.extra = 1; }],
    ['an unknown field in an entry', (r) => { r.active = { storeId: A, key: K1, root: 'C:\\x' }; }],
    ['a missing list', (r) => { delete r.disabled; }],
    ['a consent without a closure digest', (r) => { r.activationConsents = [{ storeId: A, key: K1, closureDigest: 'x', decidedAt: T }]; }],
    ['a scheduler without a switch', (r) => { r.scheduler = { epoch: 0, autoMode: 'yes' }; }],
    ['another schema', (r) => { r.schema = 'unodeai.cli-instance/1'; }],
  ])('refuses %s', (_label, edit) => {
    const record = valid();
    edit(record);
    const checked = checkControlRecord(record);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.newerSchema).toBeUndefined();
  });

  it('names a record of a later control schema as newer, and nothing else', () => {
    expect(checkControlRecord({ ...valid(), schema: 'unodeai.cli-control/2' })).toMatchObject({ ok: false, newerSchema: true });
    expect(checkControlRecord({ ...valid(), schema: 'unodeai.cli-control/0' })).not.toHaveProperty('newerSchema');
    expect(checkControlRecord({ ...valid(), schema: 'unodeai.cli-control/2x' })).not.toHaveProperty('newerSchema');
  });
});

describe('publish(): increases, reductions and the floor', () => {
  it('refuses before initialisation, and passes an unusable view through', async () => {
    expect(await kit().store.publish(touch())).toMatchObject({ outcome: 'refused' });
    const k = kit();
    mkdirSync(path.join(k.roots.instances, A), { recursive: true });
    expect(await k.store.publish(touch())).toMatchObject({ outcome: 'unusable', view: { reason: 'control-missing' } });
  });

  it('gives an increase no epoch and writes no floor record', async () => {
    const writes: string[] = [];
    const fs: ControlFs = { ...nodeControlFs, write: (fd, b, o, l, p) => { writes.push(region(p)); return nodeControlFs.write(fd, b, o, l, p); } };
    const k = await ready({ fs });
    writes.length = 0;
    const snapshot = await published(k, enrol());
    expect(snapshot.record.reductionEpoch).toBe(0);
    expect(writes).toEqual([]);
    expect(k.epochCalls).toEqual([]);
  });

  it('writes a reduction\'s floor record in region A, flushed, then region B, flushed, after its generation and before it reports', async () => {
    const calls: string[] = [];
    const fs: ControlFs = {
      ...nodeControlFs,
      write: (fd, b, o, l, p) => { calls.push(`write ${region(p)}`); return nodeControlFs.write(fd, b, o, l, p); },
      fsync: (fd) => { calls.push('fsync'); nodeControlFs.fsync(fd); },
    };
    const journalFs: JournalFs = { ...nodeJournalFs, link: (existing, created) => { calls.push(`link ${path.basename(created)}`); nodeJournalFs.link(existing, created); } };
    const k = await ready({ fs, journalFs });
    await published(k, enrol());
    calls.length = 0;
    const result = await k.store.publish(selectExternal());
    calls.push(`returned ${result.outcome}`);
    expect(calls).toEqual([`link ${generationFileName('control', 3)}`, 'write A@1', 'fsync', 'write B@1', 'fsync', 'returned published']);
    const floor = readFileSync(k.roots.floor);
    const record = floorRecord(controlId(k), 1);
    expect(floor.subarray(FLOOR_REGION_A + 64, FLOOR_REGION_A + 128).equals(record)).toBe(true);
    expect(floor.subarray(FLOOR_REGION_B + 64, FLOOR_REGION_B + 128).equals(record)).toBe(true);
  });

  it('takes max(P, F) + 1 for each reduction, with F read in the same round', async () => {
    const k = await ready();
    await published(k, enrol());
    expect((await published(k, disable(K1, 'probe-failed'))).record.reductionEpoch).toBe(1);
    expect((await published(k, consent(K2))).record.reductionEpoch).toBe(1);
    expect((await published(k, selectExternal())).record.reductionEpoch).toBe(2);
    expect(k.epochCalls).toEqual([[0, 0], [1, 1]]);
  });

  it('does not report a reduction whose floor record could not be written; the generation stands, unprotected, and the next reduction goes above it', async () => {
    let failRegionA = false;
    const fs: ControlFs = {
      ...nodeControlFs,
      write: (fd, b, o, l, p) => {
        if (failRegionA && p > 0 && p < FLOOR_REGION_B) throw Object.assign(new Error('disk'), { code: 'EIO' });
        return nodeControlFs.write(fd, b, o, l, p);
      },
    };
    const k = await ready({ fs });
    await published(k, enrol());
    failRegionA = true;
    const result = await k.store.publish(selectExternal());
    expect(result).toMatchObject({ outcome: 'failed', step: 'floor', snapshot: { generation: 3, record: { reductionEpoch: 1, selection: 'external' } } });
    failRegionA = false;
    // The reduction is in force in the journal, but the floor did not record it: the next read is ok at epoch 1, floor 0.
    expect(readable(k)).toMatchObject({ authority: 'ok', floor: 0, snapshot: { generation: 3, record: { selection: 'external' } } });
    // Here P (1) is above F (0): the next reduction takes max(P, F) + 1 = 2.
    expect((await published(k, disable(K1, 'local-bad'))).record.reductionEpoch).toBe(2);
    expect(readFloor(k.roots.floor)).toMatchObject({ known: true, floor: 2 });
  });

  it('reads an unreported reduction whose generation is then lost as the earlier state, ok (it was never reported)', async () => {
    let fail = false;
    const fs: ControlFs = { ...nodeControlFs, write: (fd, b, o, l, p) => { if (fail && p > 0) throw Object.assign(new Error('disk'), { code: 'EIO' }); return nodeControlFs.write(fd, b, o, l, p); } };
    const k = await ready({ fs });
    await published(k, enrol());
    fail = true;
    expect((await k.store.publish(selectExternal())).outcome).toBe('failed');
    deleteNewestGeneration(k);
    expect(readable(k)).toMatchObject({ authority: 'ok', snapshot: { generation: 2, record: { selection: 'managed' } } });
  });

  it('keeps a reduction whose region B write failed protected by region A, and still does not report it', async () => {
    let fail = false;
    const fs: ControlFs = { ...nodeControlFs, write: (fd, b, o, l, p) => { if (fail && p > FLOOR_REGION_B) throw Object.assign(new Error('disk'), { code: 'EIO' }); return nodeControlFs.write(fd, b, o, l, p); } };
    const k = await ready({ fs });
    await published(k, enrol());
    fail = true;
    expect(await k.store.publish(selectExternal())).toMatchObject({ outcome: 'failed', step: 'floor' });
    expect(readFloor(k.roots.floor)).toMatchObject({ known: true, floor: 1 });
    deleteNewestGeneration(k);
    expect(readable(k).authority).toBe('behind-floor');
  });

  it('decides again on the winner after a lost race, and never publishes what it decided on the old predecessor', async () => {
    let raced = false;
    const other = kit();
    let calls = 0;
    const journalFs: JournalFs = {
      ...nodeJournalFs,
      link: (existing, created) => {
        if (!raced && path.basename(created) === generationFileName('control', 3)) {
          raced = true;
          // Another window disables K1 and wins generation 3 first.
          void other.store.publish(disable(K1, 'local-bad'));
        }
        nodeJournalFs.link(existing, created);
      },
    };
    const k = await ready({ root: other.root, journalFs });
    await published(k, enrol());
    const counted = activate(K1);
    const apply = counted.apply;
    counted.apply = (current) => { calls++; return apply(current); };
    const result = await k.store.publish(counted);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'disabled', snapshot: { generation: 3 } });
    expect(calls).toBe(2);
    expect(generationFiles(k.root)).toHaveLength(3);
    expect(readable(k).snapshot.record).toMatchObject({ active: null, disabled: [{ key: K1, reason: 'local-bad' }] });
  });

  it('is moot when the winner of a lost race already made the change', async () => {
    let raced = false;
    const other = kit();
    const journalFs: JournalFs = {
      ...nodeJournalFs,
      link: (existing, created) => {
        if (!raced && path.basename(created) === generationFileName('control', 3)) { raced = true; void other.store.publish(selectExternal()); }
        nodeJournalFs.link(existing, created);
      },
    };
    const k = await ready({ root: other.root, journalFs });
    await published(k, enrol());
    expect(await k.store.publish(selectExternal())).toMatchObject({ outcome: 'moot', snapshot: { generation: 3 } });
    expect(readFloor(k.roots.floor)).toMatchObject({ floor: 1 });
  });

  it('does not count a link that re-created a trimmed name: it is removed, and the change is decided again on the current chain', async () => {
    async function race(expectedFromStart: boolean) {
      let delayed = false;
      const other = kit();
      const journalFs: JournalFs = {
        ...nodeJournalFs,
        link: (existing, created) => {
          if (!delayed && path.basename(created) === generationFileName('control', 3)) {
            delayed = true;
            // While this writer is paused before its link, another window publishes twelve generations (3 to 14) and
            // trims 3 away, so this writer's target name is free again.
            for (let index = 0; index < 12; index++) void other.store.publish(touch(`other ${index}`));
            expect(generationFiles(other.root)[0]).toBe(generationFileName('control', 4));
          }
          nodeJournalFs.link(existing, created);
        },
      };
      const k = await ready({ root: other.root, journalFs });
      const decidedOn = await published(k, enrol());
      let calls = 0;
      const counted = selectExternal(expectedFromStart ? { expected: { generation: decidedOn.generation, digest: decidedOn.digest } } : {});
      const apply = counted.apply;
      counted.apply = (current) => { calls++; return apply(current); };
      return { k, calls: () => calls, result: await k.store.publish(counted) };
    }
    const again = await race(false);
    expect(again.calls()).toBe(2);
    // Published after the newest of the other window's generations, with the epoch above all of them.
    expect(again.result).toMatchObject({ outcome: 'published', snapshot: { generation: 15, record: { reductionEpoch: 13, selection: 'external' } } });
    expect(readable(again.k)).toMatchObject({ authority: 'ok', floor: 13, snapshot: { generation: 15, record: { selection: 'external' } } });
    // The stale file is removed at once (here no later trim of this writer could have removed it).
    const exact = await race(true);
    expect(exact.result).toMatchObject({ outcome: 'stale', snapshot: { generation: 14 } });
    expect(generationFiles(exact.k.root)).not.toContain(generationFileName('control', 3));
  });

  it('does not report a link it cannot confirm as current (a later generation exists, the next one is gone): it keeps the file, writes no floor record for it, and decides again', async () => {
    async function race(expectedFromStart: boolean) {
      let delayed = false;
      const other = kit();
      const journalFs: JournalFs = {
        ...nodeJournalFs,
        link: (existing, created) => {
          if (!delayed && path.basename(created) === generationFileName('control', 3)) {
            delayed = true;
            for (let index = 0; index < 12; index++) void other.store.publish(touch(`other ${index}`));
            unlinkSync(path.join(other.roots.controlManifests, generationFileName('control', 4)));
          }
          nodeJournalFs.link(existing, created);
        },
      };
      const writes: string[] = [];
      const fs: ControlFs = { ...nodeControlFs, write: (fd, b, o, l, p) => { writes.push(region(p)); return nodeControlFs.write(fd, b, o, l, p); } };
      const k = await ready({ root: other.root, journalFs, fs });
      const decidedOn = await published(k, enrol());
      writes.length = 0;
      const result = await k.store.publish(selectExternal(expectedFromStart ? { expected: { generation: decidedOn.generation, digest: decidedOn.digest } } : {}));
      return { k, writes, result };
    }
    const again = await race(false);
    expect(again.result).toMatchObject({ outcome: 'published', snapshot: { generation: 15, record: { reductionEpoch: 13, selection: 'external' } } });
    // Only the reported reduction's epoch is written: an unconfirmed link is not reported, so it needs no record.
    expect(again.writes).toEqual(['A@13', 'B@13']);
    // A decision the user made on one exact generation is not carried to another: it is stale. The unconfirmed file
    // is left where it is (only a later trim removes it).
    const exact = await race(true);
    expect(exact.result).toMatchObject({ outcome: 'stale', snapshot: { generation: 14 } });
    expect(exact.writes).toEqual([]);
    expect(generationFiles(exact.k.root)).toContain(generationFileName('control', 3));
  });

  it('is stale, and publishes nothing, when the user decided on another generation than the current one', async () => {
    const k = await ready();
    const first = readable(k).snapshot;
    await published(k, enrol());
    const decidedOn = { generation: first.generation, digest: first.digest };
    expect(await k.store.publish(selectExternal({ expected: decidedOn }))).toMatchObject({ outcome: 'stale', snapshot: { generation: 2 } });
    const current = readable(k).snapshot;
    expect(await k.store.publish(selectExternal({ expected: { generation: current.generation, digest: first.digest } }))).toMatchObject({ outcome: 'stale' });
    expect(generationFiles(k.root)).toHaveLength(2);
    expect(await k.store.publish(selectExternal({ expected: { generation: current.generation, digest: current.digest } }))).toMatchObject({ outcome: 'published' });
  });

  it('is busy after five lost rounds, each decided again, with nothing published', async () => {
    let lose = false;
    const journalFs: JournalFs = {
      ...nodeJournalFs,
      link: (existing, created) => { if (lose) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); nodeJournalFs.link(existing, created); },
    };
    const k = await ready({ journalFs });
    lose = true;
    let calls = 0;
    const counted = touch();
    const apply = counted.apply;
    counted.apply = (current) => { calls++; return apply(current); };
    expect(await k.store.publish(counted)).toEqual({ outcome: 'busy' });
    expect(calls).toBe(CONTROL_PUBLISH_ROUNDS);
    expect(generationFiles(k.root)).toHaveLength(1);
    expect(readFloor(k.roots.floor)).toMatchObject({ floor: 0 });
  });

  it('refuses a result that is not a valid record, and one that names no kind, and publishes nothing', async () => {
    const k = await ready();
    expect(await k.store.publish(change('increase', 'managed without enrolment', (c) => ({ ...c, selection: 'managed' })))).toMatchObject({ outcome: 'refused' });
    expect(await k.store.publish(change('increase', 'bad host', (c) => ({ ...c, enrolledStoreId: A, selection: 'managed', enrollment: { epoch: 0, consentedHosts: ['UPPER.example'], decidedAt: T } })))).toMatchObject({ outcome: 'refused' });
    expect(await k.store.publish({ ...touch(), kind: 'both' as never })).toMatchObject({ outcome: 'refused' });
    expect(await k.store.publish(change('reduction', 'throws', () => { throw new Error('bug'); }))).toMatchObject({ outcome: 'refused' });
    expect(generationFiles(k.root)).toHaveLength(1);
  });

  it('trims old generations after publishing, keeping the newest eleven', async () => {
    const k = await ready();
    for (let index = 0; index < 13; index++) await published(k, touch());
    expect(generationFiles(k.root)).toEqual(Array.from({ length: 11 }, (_, i) => generationFileName('control', 4 + i)));
    expect(readable(k)).toMatchObject({ authority: 'ok', floor: 13, snapshot: { generation: 14 } });
  });
});

describe('publish(): selection is separate from enrolment (merged §3.2, Codex Q1)', () => {
  it('keeps the instance, its consents and its versions when External is selected, and selecting managed again changes only the selection', async () => {
    const k = await ready();
    await published(k, enrol());
    await published(k, consent(K1));
    await published(k, activate(K1));
    const managed = readable(k).snapshot.record;
    const external = await published(k, selectExternal());
    expect(external.record).toMatchObject({ enrolledStoreId: A, selection: 'external', reductionEpoch: 1 });
    expect(external.record.activationConsents).toEqual(managed.activationConsents);
    expect(external.record.active).toEqual(managed.active);
    expect(external.record.retiredInstances).toEqual([]);
    const back = await published(k, selectManaged());
    // An increase: no epoch, and nothing else changes.
    const { selection: _s1, generation: _g1, previousRecordDigest: _p1, reductionEpoch: _e1, decidedAt: _d1, ...before } = managed;
    const { selection: _s2, generation: _g2, previousRecordDigest: _p2, reductionEpoch: _e2, decidedAt: _d2, ...after } = back.record;
    expect(back.record).toMatchObject({ selection: 'managed', reductionEpoch: 1 });
    expect(after).toEqual(before);
  });
});

describe('publish(): the kind of a change is checked against what it changes', () => {
  async function full(): Promise<Kit> {
    const k = await ready();
    await published(k, change('increase', 'setup', (c) => ({
      ...c, enrolledStoreId: A, selection: 'managed',
      enrollment: { epoch: 0, consentedHosts: ['releases.openai.com', 'github.com'], decidedAt: T },
      scheduler: { epoch: 0, autoMode: true },
      activationConsents: [{ storeId: A, key: K1, closureDigest: D1, decidedAt: T }, { storeId: A, key: K2, closureDigest: D2, decidedAt: T }],
      active: { storeId: A, key: K2 }, lastKnownGood: { storeId: A, key: K1 }, decidedAt: T,
    })));
    await published(k, disable(key('0.150.0'), 'local-bad'));
    return k;
  }

  it.each<[string, (c: ControlRecord) => Partial<ControlRecord>]>([
    ['selecting External', () => ({ selection: 'external' })],
    ['removing a consented host', (c) => ({ enrollment: { ...c.enrollment!, consentedHosts: ['github.com'] } })],
    ['raising the enrolment epoch', (c) => ({ enrollment: { ...c.enrollment!, epoch: 1 } })],
    ['turning automatic mode off', () => ({ scheduler: { epoch: 0, autoMode: false } })],
    ['raising the scheduler epoch', () => ({ scheduler: { epoch: 1, autoMode: true } })],
    ['withdrawing an activation consent', (c) => ({ activationConsents: c.activationConsents.slice(1) })],
    ['rolling active back to an older version', () => ({ active: { storeId: A, key: K1 } })],
    ['clearing active', () => ({ active: null })],
    ['clearing the last known good version', () => ({ lastKnownGood: null })],
    ['adding a disabled entry', (c) => ({ disabled: [...c.disabled, { storeId: A, key: K2, reason: 'probe-failed', at: T }] })],
    ['removing a disabled entry', () => ({ disabled: [] })],
    ['replacing a disabled entry', (c) => ({ disabled: [{ ...c.disabled[0], reason: 'policy-bad' }] })],
    ['retiring the instance', () => ({ enrolledStoreId: null, selection: 'external', enrollment: null, active: null, lastKnownGood: null })],
  ])('refuses %s published as an increase, and records it as a reduction', async (_label, edit) => {
    const k = await full();
    const before = generationFiles(k.root);
    const result = await k.store.publish(change('increase', 'edit', (c) => ({ ...c, ...edit(c) })));
    expect(result).toMatchObject({ outcome: 'refused' });
    expect(generationFiles(k.root)).toEqual(before);
    const reduced = await k.store.publish(change('reduction', 'edit', (c) => ({ ...c, ...edit(c) })));
    expect(reduced).toMatchObject({ outcome: 'published', snapshot: { record: { reductionEpoch: 2 } } });
  });

  it('accepts as increases: a newer active version with the previous one as last known good, a new consent, a new host, automatic mode on', async () => {
    const k = await full();
    const K3 = key('0.165.0');
    const result = await k.store.publish(change('increase', 'activate newer', (c) => ({
      ...c, active: { storeId: A, key: K3 }, lastKnownGood: { storeId: A, key: K2 },
      activationConsents: [...c.activationConsents, { storeId: A, key: K3, closureDigest: D1, decidedAt: T }],
      enrollment: { ...c.enrollment!, consentedHosts: [...c.enrollment!.consentedHosts, 'release-assets.githubusercontent.com'] },
    })));
    expect(result).toMatchObject({ outcome: 'published', snapshot: { record: { reductionEpoch: 1 } } });
  });

  it('refuses any change that lowers an epoch', async () => {
    const k = await full();
    await published(k, change('reduction', 'auto off', (c) => ({ ...c, scheduler: { epoch: 1, autoMode: false } })));
    expect(await k.store.publish(change('reduction', 'lower', (c) => ({ ...c, scheduler: { epoch: 0, autoMode: false } })))).toMatchObject({ outcome: 'refused' });
    await published(k, change('reduction', 'host epoch', (c) => ({ ...c, enrollment: { ...c.enrollment!, epoch: 2 } })));
    expect(await k.store.publish(change('reduction', 'lower', (c) => ({ ...c, enrollment: { ...c.enrollment!, epoch: 1 } })))).toMatchObject({ outcome: 'refused' });
  });
});

describe('publish(): behind-floor, floor-unavailable, sealed', () => {
  /** Record at epoch 1, floor at 2: P = 1, F = 2. */
  async function behind(): Promise<Kit> {
    const k = await ready();
    await published(k, enrol());
    await published(k, disable(K2, 'probe-failed'));
    await published(k, selectExternal());
    deleteNewestGeneration(k);
    expect(readable(k)).toMatchObject({ authority: 'behind-floor', floor: 2, snapshot: { record: { reductionEpoch: 1 } } });
    return k;
  }

  it('refuses an increase, a reduction that is not a re-decision, and a re-decision published as an increase', async () => {
    const k = await behind();
    const before = generationFiles(k.root);
    expect(await k.store.publish(consent(K1))).toMatchObject({ outcome: 'refused' });
    expect(await k.store.publish(disable(K1, 'local-bad'))).toMatchObject({ outcome: 'refused' });
    expect(await k.store.publish({ ...consent(K1), redecision: true })).toMatchObject({ outcome: 'refused' });
    expect(generationFiles(k.root)).toEqual(before);
    expect(k.epochCalls.slice(-1)).toEqual([[1, 1]]);
  });

  it('records the user\'s one re-decision as a reduction at max(P, F) + 1, after which control is ok', async () => {
    const k = await behind();
    const result = await k.store.publish(selectExternal({ redecision: true }));
    expect(result).toMatchObject({ outcome: 'published', snapshot: { record: { reductionEpoch: 3, selection: 'external' } } });
    expect(readable(k)).toMatchObject({ authority: 'ok', floor: 3 });
    const floor = readFileSync(k.roots.floor);
    const record = floorRecord(controlId(k), 3);
    expect(floor.subarray(FLOOR_REGION_A + 192, FLOOR_REGION_A + 256).equals(record)).toBe(true);
    expect(floor.subarray(FLOOR_REGION_B + 192, FLOOR_REGION_B + 256).equals(record)).toBe(true);
  });

  it('publishes nothing in floor-unavailable and never computes an epoch, a re-decision included', async () => {
    const k = await ready();
    await published(k, enrol());
    truncateSync(k.roots.floor, 4096);
    const before = tree(k.root);
    k.epochCalls.length = 0;
    for (const item of [selectExternal({ redecision: true }), selectExternal(), consent(K1)]) {
      expect(await k.store.publish(item)).toMatchObject({ outcome: 'unusable', view: { reason: 'floor-unavailable' } });
    }
    expect(k.epochCalls).toEqual([]);
    expect(tree(k.root)).toEqual(before);
  });

  it('publishes nothing once sealed and never computes an epoch; the seal stays when the newest generation is lost', async () => {
    const k = await ready();
    await published(k, enrol());
    fillFloorTo(k.root, controlId(k), FLOOR_SEAL - 1);
    publishAtEpoch(k.root, FLOOR_SEAL - 1);
    expect(readable(k)).toMatchObject({ authority: 'ok', floor: FLOOR_SEAL - 1 });
    k.epochCalls.length = 0;
    expect(await published(k, selectExternal())).toMatchObject({ record: { reductionEpoch: FLOOR_SEAL, sealed: true } });
    expect(k.epochCalls).toEqual([[FLOOR_SEAL - 1, FLOOR_SEAL - 1]]);
    expect(k.store.read()).toMatchObject({ kind: 'unusable', reason: 'sealed' });
    const before = tree(k.root);
    k.epochCalls.length = 0;
    for (const item of [touch(), selectExternal({ redecision: true }), consent(K1)]) {
      expect(await k.store.publish(item)).toMatchObject({ outcome: 'unusable', view: { reason: 'sealed' } });
    }
    expect(await k.store.initialize()).toMatchObject({ outcome: 'unusable' });
    expect(k.epochCalls).toEqual([]);
    expect(tree(k.root)).toEqual(before);
    deleteNewestGeneration(k);
    expect(k.store.read()).toMatchObject({ kind: 'unusable', reason: 'sealed' });
  });
});

describe('publish(): a pending Reset (the enrolled instance\'s admission gate is seen closed)', () => {
  const completeReset = (extra: Partial<ControlChange> = {}) => change('reduction', 'complete Reset', (c) => c.enrolledStoreId === null ? { moot: true } : ({
    ...c, enrolledStoreId: null, selection: 'external', enrollment: null, active: null, lastKnownGood: null,
    retiredInstances: [...c.retiredInstances, { storeId: c.enrolledStoreId, retiredAt: T }], decidedAt: T,
  }), { completesReset: 'gate-closed', ...extra });

  it('allows only completing the Reset while the gate is closed', async () => {
    const evidence = 'gate-closed' as const;
    const k = await ready();
    await published(k, enrol());
    k.gates.set(A, 'closed');
    const before = generationFiles(k.root);
    for (const item of [consent(K1), selectExternal(), disable(K1, 'local-bad'), selectManaged()]) {
      expect(await k.store.publish(item)).toMatchObject({ outcome: 'refused' });
    }
    expect(generationFiles(k.root)).toEqual(before);
    expect(await k.store.publish(change('reduction', 'keeps A', (c) => ({ ...c, selection: 'external' }), { completesReset: evidence }))).toMatchObject({ outcome: 'refused' });
    expect(await k.store.publish(change('increase', 'as increase', (c) => ({ ...c }), { completesReset: evidence }))).toMatchObject({ outcome: 'refused' });
    const done = await k.store.publish(completeReset({ completesReset: evidence }));
    expect(done).toMatchObject({ outcome: 'published', snapshot: { record: { enrolledStoreId: null, selection: 'external', reductionEpoch: 1, retiredInstances: [{ storeId: A }] } } });
  });

  it('reads a missing gate as a store to repair, not a pending Reset: reductions go through, no increase, and no Reset completes', async () => {
    const k = await ready();
    await published(k, enrol());
    await published(k, consent(K1));
    k.gates.set(A, 'missing');
    for (const item of [consent(K2), selectManaged()]) {
      expect(await k.store.publish(item)).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('cannot be opened') });
    }
    // A completion names a closed gate nobody saw: one window's failed open is no barrier against another window.
    expect(await k.store.publish(completeReset())).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('not seen closed') });
    expect(readable(k).snapshot.record.enrolledStoreId).toBe(A);
    expect(await k.store.publish(selectExternal())).toMatchObject({ outcome: 'published', snapshot: { record: { enrolledStoreId: A, selection: 'external' } } });
    expect(await k.store.publish(completeReset())).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('not seen closed') });
    expect(readable(k).snapshot.record).toMatchObject({ enrolledStoreId: A, retiredInstances: [] });
  });

  it('treats a gate that cannot be read as missing: no increase, and no Reset', async () => {
    const root = newRoot();
    const store = createControlStore({ root, admissionState: () => { throw new Error('gate unreadable'); }, now: () => new Date(T) });
    expect((await store.initialize()).outcome).toBe('published');
    expect((await store.publish(enrol())).outcome).toBe('published');
    expect(await store.publish(consent(K1))).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('cannot be opened') });
    expect(await store.publish(completeReset())).toMatchObject({ outcome: 'refused' });
  });

  it('refuses to record a Reset whose gate is still open', async () => {
    const k = await ready();
    await published(k, enrol());
    expect(await k.store.publish(completeReset())).toMatchObject({ outcome: 'refused' });
    expect(readable(k).snapshot.record.enrolledStoreId).toBe(A);
  });

  it('in behind-floor, records the Reset only as the user\'s re-decision', async () => {
    const k = await ready();
    await published(k, enrol());
    await published(k, consent(K1));
    await published(k, selectExternal());
    deleteNewestGeneration(k);
    k.gates.set(A, 'closed');
    expect(await k.store.publish(completeReset())).toMatchObject({ outcome: 'refused' });
    expect(await k.store.publish(completeReset({ redecision: true }))).toMatchObject({ outcome: 'published', snapshot: { record: { reductionEpoch: 2 } } });
    expect(readable(k).authority).toBe('ok');
  });
});

describe('publish(): the shared suspension refuses increases', () => {
  it('refuses every increase while the file is present, readable or not, and still records reductions', async () => {
    const k = await ready();
    await published(k, enrol());
    expect((await k.store.suspend('control-unreadable', 'test')).ok).toBe(true);
    const before = generationFiles(k.root);
    expect(await k.store.publish(consent(K1))).toMatchObject({ outcome: 'refused' });
    expect(generationFiles(k.root)).toEqual(before);
    expect(await k.store.publish(selectExternal())).toMatchObject({ outcome: 'published', snapshot: { record: { selection: 'external' } } });
    unlinkSync(k.roots.suspension);
    mkdirSync(k.roots.suspension);
    expect(await k.store.publish(selectManaged())).toMatchObject({ outcome: 'refused' });
  });

  it('refuses enrolling or selecting managed while suspended, even when published as a reduction', async () => {
    const k = await ready();
    writeFileSync(k.roots.suspension, '');
    expect(await k.store.publish({ ...enrol(), kind: 'reduction' })).toMatchObject({ outcome: 'refused' });
    rmSync(k.roots.suspension);
    await published(k, enrol());
    await published(k, selectExternal());
    writeFileSync(k.roots.suspension, '{');
    expect(await k.store.publish({ ...selectManaged(), kind: 'reduction' })).toMatchObject({ outcome: 'refused' });
    expect(readable(k).snapshot.record.selection).toBe('external');
  });
});

describe('initialize()', () => {
  it('creates control\\, authority\\ and manifests\\ one at a time, a floor with a new journal id, and generation 1 (null, external)', async () => {
    const made: string[] = [];
    const fs: ControlFs = { ...nodeControlFs, mkdir: (folder) => { made.push(path.relative(root, folder)); nodeControlFs.mkdir(folder); } };
    const root = newRoot();
    const k = kit({ root, fs, newId: () => 'cc'.repeat(16) });
    const result = await k.store.initialize();
    expect(made).toEqual(['control', path.join('control', 'authority'), path.join('control', 'manifests')]);
    expect(result).toMatchObject({ outcome: 'published', snapshot: { generation: 1 } });
    if (result.outcome !== 'published') return;
    expect(result.snapshot.record).toEqual({
      schema: 'unodeai.cli-control/1', controlId: 'cc'.repeat(16), generation: 1, previousRecordDigest: null, reductionEpoch: 0,
      enrolledStoreId: null, selection: 'external', enrollment: null, scheduler: { epoch: 0, autoMode: false },
      activationConsents: [], active: null, lastKnownGood: null, disabled: [], retiredInstances: [], decidedAt: T,
    });
    expect(readFloor(k.roots.floor)).toEqual({ known: true, controlId: 'cc'.repeat(16), floor: 0, torn: [] });
    expect(readable(k).snapshot.digest).toBe(result.snapshot.digest);
  });

  it('never creates the store root itself', async () => {
    const k = kit({ root: path.join(newRoot(), 'not-there') });
    expect(await k.store.initialize()).toMatchObject({ outcome: 'failed', step: 'folders' });
    expect(k.store.read()).toEqual({ kind: 'fresh' });
  });

  it('reuses the journal id of a header-only floor', async () => {
    const k = kit();
    mkdirSync(k.roots.controlAuthority, { recursive: true });
    createFloor(k.roots.floor, OTHER);
    expect(await k.store.initialize()).toMatchObject({ outcome: 'published', snapshot: { record: { controlId: OTHER } } });
  });

  it('is moot once initialised, and when another window won generation 1 first', async () => {
    const k = await ready();
    expect(await k.store.initialize()).toMatchObject({ outcome: 'moot', snapshot: { generation: 1 } });

    let raced = false;
    const other = kit();
    const journalFs: JournalFs = {
      ...nodeJournalFs,
      link: (existing, created) => {
        if (!raced) { raced = true; void other.store.initialize(); }
        nodeJournalFs.link(existing, created);
      },
    };
    const mine = kit({ root: other.root, journalFs });
    expect(await mine.store.initialize()).toMatchObject({ outcome: 'moot', snapshot: { generation: 1 } });
    expect(generationFiles(mine.root)).toHaveLength(1);
  });

  it('reads again when another window creates the floor first (wx gives EEXIST), and uses that window\'s journal id', async () => {
    const root = newRoot();
    const roots = cliStoreRoots(root);
    let first = true;
    const fs: ControlFs = {
      ...nodeControlFs,
      open: (file, flags) => {
        if (first && flags === 'wx' && file === roots.floor) { first = false; createFloor(file, OTHER, nodeFloorFs); }
        return nodeControlFs.open(file, flags);
      },
    };
    const k = kit({ root, fs });
    expect(await k.store.initialize()).toMatchObject({ outcome: 'published', snapshot: { record: { controlId: OTHER } } });
  });

  it('waits while another window is still writing the floor, then uses it', async () => {
    const root = newRoot();
    const roots = cliStoreRoots(root);
    let first = true;
    const fs: ControlFs = {
      ...nodeControlFs,
      open: (file, flags) => {
        if (first && flags === 'wx' && file === roots.floor) {
          first = false;
          writeFileSync(file, Buffer.alloc(4096));
          setTimeout(() => { unlinkSync(file); createFloor(file, OTHER, nodeFloorFs); }, 60);
        }
        return nodeControlFs.open(file, flags);
      },
    };
    const k = kit({ root, fs });
    expect(await k.store.initialize()).toMatchObject({ outcome: 'published', snapshot: { record: { controlId: OTHER } } });
  });

  it('creates nothing when control is unusable', async () => {
    const k = kit();
    mkdirSync(path.join(k.roots.instances, A), { recursive: true });
    const before = tree(k.root);
    expect(await k.store.initialize()).toMatchObject({ outcome: 'unusable', view: { reason: 'control-missing' } });
    expect(tree(k.root)).toEqual(before);
  });
});

describe('the shared suspension (merged §4, Codex Q4)', () => {
  it('is created wx, written, flushed and closed, and reported only after the flush', async () => {
    const calls: string[] = [];
    const fs: ControlFs = {
      ...nodeControlFs,
      open: (file, flags) => { calls.push(`open ${flags}`); return nodeControlFs.open(file, flags); },
      write: (fd, b, o, l, p) => { calls.push('write'); return nodeControlFs.write(fd, b, o, l, p); },
      fsync: (fd) => { calls.push('fsync'); nodeControlFs.fsync(fd); },
      close: (fd) => { calls.push('close'); nodeControlFs.close(fd); },
    };
    const k = kit({ fs });
    const result = await k.store.suspend('control-unreadable', 'generation 7 is damaged');
    calls.push(`returned ${result.ok}`);
    expect(calls).toEqual(['open wx', 'write', 'fsync', 'close', 'returned true']);
    expect(JSON.parse(readFileSync(k.roots.suspension, 'utf8'))).toEqual({ v: 1, reason: 'control-unreadable', controlState: 'generation 7 is damaged', decidedAt: T });
    expect(k.store.readSuspension()).toEqual({ present: true, readable: true, reason: 'control-unreadable', controlState: 'generation 7 is damaged', decidedAt: T });
  });

  it('reports failure when the flush fails, and the partial file left behind still counts as present', async () => {
    const fs: ControlFs = { ...nodeControlFs, fsync: () => { throw Object.assign(new Error('flush'), { code: 'EIO' }); } };
    const k = kit({ fs });
    expect(await k.store.suspend('sealed', 'x')).toMatchObject({ ok: false });
    expect(k.store.readSuspension()).toMatchObject({ present: true });
    expect(kit({ root: k.root }).store.readSuspension()).toMatchObject({ present: true });
  });

  it('reports failure when the write fails; the empty file left behind counts as present', async () => {
    const fs: ControlFs = { ...nodeControlFs, write: () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); } };
    const k = kit({ fs });
    expect(await k.store.suspend('sealed', 'x')).toMatchObject({ ok: false });
    expect(k.store.readSuspension()).toEqual({ present: true, readable: false });
  });

  it('is ok when another window suspended first (EEXIST), after flushing that window\'s file; any other failure is not ok', async () => {
    const calls: string[] = [];
    const fs: ControlFs = { ...nodeControlFs, open: (file, flags) => { calls.push(`open ${flags}`); return nodeControlFs.open(file, flags); }, fsync: (fd) => { calls.push('fsync'); nodeControlFs.fsync(fd); } };
    const k = kit({ fs });
    writeFileSync(k.roots.suspension, '{"v":1');
    expect(await k.store.suspend('control-missing', 'x')).toEqual({ ok: true });
    expect(calls).toEqual(['open wx', 'open r+', 'fsync']);
    expect(readFileSync(k.roots.suspension, 'utf8')).toBe('{"v":1');

    const folder = kit();
    mkdirSync(folder.roots.suspension);
    expect(await folder.store.suspend('control-missing', 'x')).toMatchObject({ ok: false });
    expect(folder.store.readSuspension()).toMatchObject({ present: true, readable: false });

    const noRoot = kit({ root: path.join(newRoot(), 'missing') });
    expect(await noRoot.store.suspend('control-missing', 'x')).toMatchObject({ ok: false });
  });

  it('writes nothing under control\\ or instances\\', async () => {
    const k = await ready();
    mkdirSync(path.join(k.roots.instances, A), { recursive: true });
    const control = tree(k.roots.control);
    const instances = tree(k.roots.instances);
    expect((await k.store.suspend('control-missing', 'x')).ok).toBe(true);
    expect(tree(k.roots.control)).toEqual(control);
    expect(tree(k.roots.instances)).toEqual(instances);
  });

  it.each<[string, (file: string) => void]>([
    ['empty', (file) => writeFileSync(file, '')],
    ['partial', (file) => writeFileSync(file, '{"v":1,"reason":"sea')],
    ['unparsable', (file) => writeFileSync(file, 'not json')],
    ['of another version', (file) => writeFileSync(file, JSON.stringify({ v: 2, reason: 'r', controlState: 's', decidedAt: T }))],
    ['missing a field', (file) => writeFileSync(file, JSON.stringify({ v: 1, reason: 'r', decidedAt: T }))],
    ['carrying an unknown field', (file) => writeFileSync(file, JSON.stringify({ v: 1, reason: 'r', controlState: 's', decidedAt: T, grant: true }))],
    ['oversized', (file) => writeFileSync(file, JSON.stringify({ v: 1, reason: 'x'.repeat(SUSPENSION_MAX_BYTES), controlState: 's', decidedAt: T }))],
    ['a folder', (file) => mkdirSync(file)],
  ])('reads a suspension file that is %s as present (unreadable)', (_label, make) => {
    const k = kit();
    make(k.roots.suspension);
    expect(k.store.readSuspension()).toEqual({ present: true, readable: false });
  });

  it('reads an lstat or read failure as present, and only a missing file as absent', () => {
    const k = kit();
    expect(k.store.readSuspension()).toEqual({ present: false });
    writeFileSync(k.roots.suspension, JSON.stringify({ v: 1, reason: 'r', controlState: 's', decidedAt: T }));
    const lstatFails: ControlFs = { ...nodeControlFs, lstat: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
    expect(kit({ root: k.root, fs: lstatFails }).store.readSuspension()).toEqual({ present: true, readable: false });
    const openFails: ControlFs = { ...nodeControlFs, open: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } };
    expect(kit({ root: k.root, fs: openFails }).store.readSuspension()).toEqual({ present: true, readable: false });
    const readFails: ControlFs = { ...nodeControlFs, read: () => { throw Object.assign(new Error('io'), { code: 'EIO' }); } };
    expect(kit({ root: k.root, fs: readFails }).store.readSuspension()).toEqual({ present: true, readable: false });
    const goneBeforeOpen: ControlFs = { ...nodeControlFs, open: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } };
    expect(kit({ root: k.root, fs: goneBeforeOpen }).store.readSuspension()).toEqual({ present: false });
  });

  it('can be published from every unusable control state', async () => {
    const states: Array<[string, () => Promise<Kit>]> = [
      ['control-missing (an instance)', async () => { const k = kit(); mkdirSync(path.join(k.roots.instances, A), { recursive: true }); return k; }],
      ['control-missing (a floor reduction)', async () => { const k = await ready(); await published(k, touch()); for (const n of generationFiles(k.root)) unlinkSync(path.join(k.roots.controlManifests, n)); return k; }],
      ['control-unreadable (damage above)', async () => { const k = await ready(); writeFileSync(path.join(k.roots.controlManifests, generationFileName('control', 2)), '{'); return k; }],
      ['control-unreadable (another journal\'s floor)', async () => { const k = await ready(); unlinkSync(k.roots.floor); createFloor(k.roots.floor, OTHER); return k; }],
      ['control-newer-schema', async () => { const k = await ready(); writeFileSync(path.join(k.roots.controlManifests, generationFileName('control', 2)), JSON.stringify({ schema: 'unodeai.cli-control/3' })); return k; }],
      ['floor-unavailable (generation, no floor)', async () => { const k = await ready(); unlinkSync(k.roots.floor); return k; }],
      ['floor-unavailable (invalid floor, no generation)', async () => { const k = kit(); mkdirSync(k.roots.controlAuthority, { recursive: true }); writeFileSync(k.roots.floor, 'x'); return k; }],
      ['sealed', async () => { const k = await ready(); fillFloorTo(k.root, controlId(k), FLOOR_SEAL); return k; }],
    ];
    const reasons = new Set<string>();
    for (const [label, make] of states) {
      const k = await make();
      const view = k.store.read();
      expect(view.kind, label).toBe('unusable');
      if (view.kind === 'unusable') reasons.add(view.reason);
      const control = tree(k.roots.control);
      expect(await k.store.suspend(view.kind === 'unusable' ? view.reason : 'none', label), label).toEqual({ ok: true });
      expect(k.store.readSuspension(), label).toMatchObject({ present: true, readable: true });
      expect(tree(k.roots.control), label).toEqual(control);
    }
    expect([...reasons].sort()).toEqual(['control-missing', 'control-newer-schema', 'control-unreadable', 'floor-unavailable', 'sealed']);
  });

  it('stays in force while control reads ok, until the user clears it', async () => {
    const k = await ready();
    await published(k, enrol());
    await published(k, selectExternal());
    writeFileSync(k.roots.suspension, '');
    expect(readable(k).authority).toBe('ok');
    expect(k.store.readSuspension().present).toBe(true);
    expect(await k.store.publish(selectManaged())).toMatchObject({ outcome: 'refused' });
    expect(await k.store.clearSuspension()).toEqual({ ok: true });
    expect(k.store.readSuspension()).toEqual({ present: false });
    expect(await k.store.publish(selectManaged())).toMatchObject({ outcome: 'published' });
  });

  it('is cleared only while control is readable and ok, and clearing publishes nothing', async () => {
    const fresh = kit();
    writeFileSync(fresh.roots.suspension, '');
    expect(await fresh.store.clearSuspension()).toMatchObject({ ok: false });
    expect(fresh.store.readSuspension().present).toBe(true);

    const behind = await ready();
    await published(behind, enrol());
    await published(behind, selectExternal());
    deleteNewestGeneration(behind);
    writeFileSync(behind.roots.suspension, '');
    expect(readable(behind).authority).toBe('behind-floor');
    expect(await behind.store.clearSuspension()).toMatchObject({ ok: false });
    expect(behind.store.readSuspension().present).toBe(true);

    const unusable = await ready();
    unlinkSync(unusable.roots.floor);
    writeFileSync(unusable.roots.suspension, '');
    expect(await unusable.store.clearSuspension()).toMatchObject({ ok: false });
    expect(unusable.store.readSuspension().present).toBe(true);

    const ok = await ready();
    writeFileSync(ok.roots.suspension, 'garbage');
    const control = tree(ok.roots.control);
    expect(await ok.store.clearSuspension()).toEqual({ ok: true });
    expect(ok.store.readSuspension()).toEqual({ present: false });
    expect(tree(ok.roots.control)).toEqual(control);
    expect(await ok.store.clearSuspension()).toEqual({ ok: true });
  });
});

describe('every prohibition lives in control (merged §9, Codex Q2 and Q3)', () => {
  it('keeps local-bad, probe-failed and probe-stop-unconfirmed entries when the instance\'s newest manifests are lost', async () => {
    const k = await ready();
    await published(k, enrol());
    await published(k, disable(K1, 'local-bad'));
    await published(k, disable(K2, 'probe-failed'));
    await published(k, disable(key('0.165.0'), 'probe-stop-unconfirmed'));
    const manifests = path.join(k.roots.instances, A, 'manifests');
    mkdirSync(manifests, { recursive: true });
    for (let generation = 1; generation <= 3; generation++) writeFileSync(path.join(manifests, `instance-${String(generation).padStart(10, '0')}.json`), '{}');
    rmSync(manifests, { recursive: true, force: true });
    expect(readable(k).snapshot.record.disabled.map((entry) => entry.reason)).toEqual(['local-bad', 'probe-failed', 'probe-stop-unconfirmed']);
  });

  it('reads behind-floor when the newest control generation is lost after a reported disabled entry, and only a re-decision is accepted', async () => {
    const k = await ready();
    await published(k, enrol());
    await published(k, consent(K1));
    await published(k, activate(K1));
    await published(k, disable(K1, 'probe-stop-unconfirmed'));
    deleteNewestGeneration(k);
    const view = readable(k);
    expect(view).toMatchObject({ authority: 'behind-floor', snapshot: { record: { disabled: [] } } });
    expect(await k.store.publish(activate(K2))).toMatchObject({ outcome: 'refused' });
    expect(await k.store.publish({ ...disable(K1, 'probe-stop-unconfirmed'), redecision: true })).toMatchObject({ outcome: 'published', snapshot: { record: { reductionEpoch: 2 } } });
  });

  it('records Check again\'s removal of only the matching probe-stop-unconfirmed entry as a reduction, with its floor record', async () => {
    const k = await ready();
    await published(k, enrol());
    await published(k, disable(K1, 'probe-stop-unconfirmed'));
    await published(k, disable(K1, 'policy-bad'));
    await published(k, disable(K2, 'probe-stop-unconfirmed'));
    expect(await k.store.publish(undisable(K1, 'probe-stop-unconfirmed', 'increase'))).toMatchObject({ outcome: 'refused' });
    const snapshot = await published(k, undisable(K1, 'probe-stop-unconfirmed'));
    expect(snapshot.record.reductionEpoch).toBe(4);
    expect(snapshot.record.disabled.map((entry) => `${entry.key === K1 ? 'K1' : 'K2'} ${entry.reason}`)).toEqual(['K1 policy-bad', 'K2 probe-stop-unconfirmed']);
    expect(readFloor(k.roots.floor)).toMatchObject({ known: true, floor: 4 });
  });

  it('records Try again\'s removal of a local-bad entry only as a reduction', async () => {
    const k = await ready();
    await published(k, enrol());
    await published(k, disable(K1, 'local-bad'));
    expect(await k.store.publish(undisable(K1, 'local-bad', 'increase'))).toMatchObject({ outcome: 'refused' });
    expect(await published(k, undisable(K1, 'local-bad'))).toMatchObject({ record: { reductionEpoch: 2, disabled: [] } });
  });
});
