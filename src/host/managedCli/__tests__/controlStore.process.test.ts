import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ControlView } from '../contracts';
import { FLOOR_REGION_A, FLOOR_REGION_B, FLOOR_SEAL, floorRecord, readFloor } from '../controlFloor';
import { createControlStore } from '../controlStore';
import { cliStoreRoots } from '../storeLayout';
import { fillFloorTo, generationFiles, publishAtEpoch, touch } from './controlTestKit';

// The design these tests realise: the authority floor holds under real, concurrent and crashing processes, through
// the product's publish (Revision 5 §6.4 and §11.13, the product versions of the p6-floor experiments X1, X2, X3 and
// X5). Once epoch E has been reported, no delayed or concurrent writer with a lower epoch can make the floor less than
// E: Codex's schedule (R1 at E11 delayed before region A, or between the regions; R2 at E12 reports) ends at 12 or
// more. Concurrent reducers get distinct, contiguous epochs; the floor equals the highest reported; every reported
// epoch is valid in both regions; a reader never sees the floor fall. A reducer killed before its generation, after
// it, between the regions or after the floor leaves the states of X3, all ok; a reported reduction whose generation
// is lost reads behind-floor. The seal: the reduction after 4094 seals; a reported seal survives the loss of its
// generation; a sealing generation lost before either seal region was written reads ok (it was never reported).

const temps: string[] = [];
afterEach(() => {
  for (const folder of temps.splice(0)) rmSync(folder, { recursive: true, force: true });
});

let worker = '';
beforeAll(() => {
  const folder = mkdtempSync(path.join(tmpdir(), 'unode-control-worker-'));
  worker = path.join(folder, 'worker.cjs');
  buildSync({
    entryPoints: [path.join(__dirname, 'controlWorker.fixture.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: worker,
    logLevel: 'silent',
  });
});
afterAll(() => { rmSync(path.dirname(worker), { recursive: true, force: true }); });

function folder(prefix: string): string {
  const created = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(created);
  return created;
}

function run(args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [worker, ...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.on('close', (code, signal) => resolve({ code, signal, out }));
  });
}

async function waitForFile(file: string, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (!existsSync(file)) {
    if (Date.now() > until) throw new Error(`${file} did not appear`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function control(root: string) {
  return createControlStore({ root, admissionState: () => 'open' });
}

/** An initialised store with `upTo` reductions published through the product: record epoch and floor = upTo. */
async function seeded(upTo: number) {
  const root = folder('unode-control-proc-');
  const store = control(root);
  expect((await store.initialize()).outcome).toBe('published');
  for (let index = 0; index < upTo; index++) expect((await store.publish(touch())).outcome).toBe('published');
  return { root, roots: cliStoreRoots(root), store };
}

function view(root: string): ControlView {
  return control(root).read();
}

function controlIdOf(root: string): string {
  const current = view(root);
  if (current.kind !== 'readable' && !(current.kind === 'unusable' && current.snapshot)) throw new Error('setup');
  return (current as { snapshot: { record: { controlId: string } } }).snapshot.record.controlId;
}

function deleteNewestGeneration(root: string): void {
  const files = generationFiles(root);
  unlinkSync(path.join(cliStoreRoots(root).controlManifests, files[files.length - 1]));
}

describe('Codex\'s delayed older writer (real processes, the product publish)', () => {
  it.each(['beforeA', 'betweenRegions'])('ends at a floor of at least 12 in each of 20 rounds when R1 (E11) is delayed %s and R2 (E12) reports', async (point) => {
    const finals: number[] = [];
    for (let round = 0; round < 20; round++) {
      const s = await seeded(10);
      const signals = folder('unode-control-signals-');
      const r1 = run(['pause', s.root, point, signals]);
      await waitForFile(path.join(signals, 'paused'));
      const go = path.join(signals, 'go-r2');
      writeFileSync(go, '');
      const r2 = JSON.parse((await run(['reduce', s.root, '1', go])).out) as { reported: number[] };
      expect(r2.reported).toEqual([12]);
      expect(readFloor(s.roots.floor)).toMatchObject({ known: true, floor: 12 });
      writeFileSync(path.join(signals, 'go'), '');
      const r1Out = JSON.parse((await r1).out) as { reported: number[] };
      expect(r1Out.reported).toEqual([11]);
      const final = readFloor(s.roots.floor);
      if (!final.known) throw new Error('floor unknown');
      finals.push(final.floor);
      expect(final.torn).toEqual([]);
      expect(view(s.root)).toMatchObject({ kind: 'readable', authority: 'ok', floor: 12, snapshot: { record: { reductionEpoch: 12 } } });
    }
    expect(finals.filter((floor) => floor < 12)).toEqual([]);
    expect(finals).toHaveLength(20);
  }, 300_000);
});

describe('concurrent reducers and a reader (real processes, the product publish)', () => {
  it('gives six processes making fifteen reductions each distinct contiguous epochs, every one valid in both regions, and a reader never sees the floor fall or a view that is not ok', async () => {
    for (let round = 0; round < 2; round++) {
      const s = await seeded(0);
      const signals = folder('unode-control-signals-');
      const go = path.join(signals, 'go');
      const stop = path.join(signals, 'stop');
      const reader = run(['read', s.root, stop]);
      const reducers = Array.from({ length: 6 }, () => run(['reduce', s.root, '15', go]));
      await new Promise((resolve) => setTimeout(resolve, 400));
      writeFileSync(go, '');
      const outs = (await Promise.all(reducers)).map((result) => JSON.parse(result.out) as { reported: number[]; busy: number; error?: unknown });
      writeFileSync(stop, '');
      const read = JSON.parse((await reader).out) as { reads: number; decreases: number; notOkCount: number; notOk: string[]; last: number };

      expect(outs.filter((out) => out.error !== undefined).map((out) => out.error)).toEqual([]);
      const all = outs.flatMap((out) => out.reported);
      expect(all).toHaveLength(90);
      expect([...all].sort((a, b) => a - b)).toEqual(Array.from({ length: 90 }, (_, index) => index + 1));
      const floor = readFloor(s.roots.floor);
      expect(floor).toMatchObject({ known: true, floor: 90, torn: [] });
      const bytes = readFileSync(s.roots.floor);
      const id = controlIdOf(s.root);
      for (const epoch of all) {
        const record = floorRecord(id, epoch);
        expect(bytes.subarray(FLOOR_REGION_A + epoch * 64, FLOOR_REGION_A + epoch * 64 + 64).equals(record)).toBe(true);
        expect(bytes.subarray(FLOOR_REGION_B + epoch * 64, FLOOR_REGION_B + epoch * 64 + 64).equals(record)).toBe(true);
      }
      expect(view(s.root)).toMatchObject({ kind: 'readable', authority: 'ok', floor: 90, snapshot: { record: { reductionEpoch: 90 } } });
      expect(read.reads).toBeGreaterThan(0);
      expect(read.decreases).toBe(0);
      expect(read.notOk).toEqual([]);
      expect(read.last).toBe(90);
    }
  }, 300_000);
});

describe('a reducer killed at each point of the write order (real processes, the product publish)', () => {
  it.each<[string, number, number]>([
    ['beforeGeneration', 10, 10],
    ['afterGeneration', 10, 11],
    ['betweenRegions', 11, 11],
    ['afterFloor', 11, 11],
  ])('killed %s: floor %d, record epoch %d, ok', async (point, floor, epoch) => {
    const s = await seeded(10);
    const result = await run(['die', s.root, point]);
    expect(result.out).toBe('');
    expect(readFloor(s.roots.floor)).toMatchObject({ known: true, floor, torn: [] });
    expect(view(s.root)).toMatchObject({ kind: 'readable', authority: 'ok', floor, snapshot: { record: { reductionEpoch: epoch } } });
  }, 60_000);

  it('after a reducer died with its generation won but no floor record, the next reduction takes the epoch above it', async () => {
    const s = await seeded(10);
    await run(['die', s.root, 'afterGeneration']);
    expect((await s.store.publish(touch())).outcome).toBe('published');
    expect(readFloor(s.roots.floor)).toEqual(expect.objectContaining({ known: true, floor: 12, torn: [] }));
    expect(view(s.root)).toMatchObject({ kind: 'readable', authority: 'ok', snapshot: { record: { reductionEpoch: 12 } } });
  }, 60_000);

  it('reads an unreported reduction whose generation is lost as ok, and a reported one as behind-floor', async () => {
    const unreported = await seeded(10);
    await run(['die', unreported.root, 'afterGeneration']);
    deleteNewestGeneration(unreported.root);
    expect(view(unreported.root)).toMatchObject({ kind: 'readable', authority: 'ok', floor: 10, snapshot: { record: { reductionEpoch: 10 } } });

    const reported = await seeded(10);
    expect((await run(['die', reported.root, 'afterFloor'])).out).toBe('');
    deleteNewestGeneration(reported.root);
    expect(view(reported.root)).toMatchObject({ kind: 'readable', authority: 'behind-floor', floor: 11, snapshot: { record: { reductionEpoch: 10 } } });

    const between = await seeded(10);
    await run(['die', between.root, 'betweenRegions']);
    deleteNewestGeneration(between.root);
    expect(view(between.root)).toMatchObject({ kind: 'readable', authority: 'behind-floor', floor: 11 });
  }, 60_000);
});

describe('the seal (real processes, the product publish)', () => {
  /** Record and floor at 4094 (the fill is written directly). */
  async function at4094() {
    const s = await seeded(0);
    fillFloorTo(s.root, controlIdOf(s.root), FLOOR_SEAL - 1);
    publishAtEpoch(s.root, FLOOR_SEAL - 1);
    expect(view(s.root)).toMatchObject({ kind: 'readable', authority: 'ok', floor: FLOOR_SEAL - 1 });
    return s;
  }

  it('seals with the reduction after 4094, and stays sealed when that reported generation is lost', async () => {
    const s = await at4094();
    const result = await s.store.publish(touch());
    expect(result).toMatchObject({ outcome: 'published', snapshot: { record: { reductionEpoch: FLOOR_SEAL, sealed: true } } });
    expect(readFloor(s.roots.floor)).toMatchObject({ known: true, floor: FLOOR_SEAL });
    expect(view(s.root)).toMatchObject({ kind: 'unusable', reason: 'sealed' });
    deleteNewestGeneration(s.root);
    expect(view(s.root)).toMatchObject({ kind: 'unusable', reason: 'sealed' });
  }, 60_000);

  it.each<[string, string, string]>([
    ['afterGeneration', 'sealed', 'ok'],
    ['betweenRegions', 'sealed', 'sealed'],
    ['afterFloor', 'sealed', 'sealed'],
  ])('a sealing reducer killed %s reads %s; with its generation lost, %s', async (point, before, after) => {
    const s = await at4094();
    expect((await run(['die', s.root, point])).out).toBe('');
    const reasonOf = (current: ControlView) => current.kind === 'unusable' ? current.reason : current.kind === 'readable' ? current.authority : current.kind;
    expect(reasonOf(view(s.root))).toBe(before);
    deleteNewestGeneration(s.root);
    expect(reasonOf(view(s.root))).toBe(after);
    if (after === 'ok') expect(view(s.root)).toMatchObject({ floor: FLOOR_SEAL - 1, snapshot: { record: { reductionEpoch: FLOOR_SEAL - 1 } } });
  }, 60_000);
});
