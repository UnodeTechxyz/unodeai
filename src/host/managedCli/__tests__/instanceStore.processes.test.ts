import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceRef } from '../contracts';
import { ADMISSION_CLOSE_ATTEMPTS, INSTANCE_LIMITS } from '../instanceStore';
import { cleanTemps, created, kit, recordingFs, temps } from './instanceTestKit';

// The design these tests realise, with real processes (the immutable-instance design §8, §13, §14.5, §14.6):
// - while any process holds the admission gate, Windows refuses the rename that closes it: every attempt of a close
//   fails with nothing changed, another admission succeeds meanwhile, and after the holder releases it, or is killed
//   with taskkill /f, the close succeeds at the first attempt (Windows only);
// - an instance whose creation was killed after its folder, after identity.bin, after its first manifest or before
//   guard.bin is never opened as complete, has no open gate, and is collected as an orphan after 10 minutes;
// - several processes promoting the same key: one folder, one fact, the others report already promoted.

let worker = '';
beforeAll(() => {
  const folder = mkdtempSync(path.join(tmpdir(), 'unode-instance-worker-'));
  worker = path.join(folder, 'worker.cjs');
  buildSync({
    entryPoints: [path.join(__dirname, 'instanceWorker.fixture.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: worker,
    logLevel: 'silent',
  });
});
afterAll(() => { rmSync(path.dirname(worker), { recursive: true, force: true }); });
afterEach(cleanTemps);

function start(args: string[]): ChildProcess {
  return spawn(process.execPath, [worker, ...args], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
}

function untilLine(child: ChildProcess, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += String(chunk);
      if (buffer.includes(text)) { child.stdout?.off('data', onData); resolve(); }
      if (buffer.includes('refused')) reject(new Error(buffer));
    };
    child.stdout?.on('data', onData);
  });
}

function output(child: ChildProcess): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    let out = '';
    child.stdout?.on('data', (chunk) => { out += String(chunk); });
    child.on('close', (code) => resolve({ out, code }));
  });
}

function realSleepKit() {
  return kit({ sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10))) });
}

describe.runIf(process.platform === 'win32')('the admission gate across processes', () => {
  it('cannot be closed while another process holds it; another admission succeeds meanwhile; after release the close wins at once', async () => {
    for (let round = 0; round < 3; round++) {
      let renames = 0;
      const { fs } = recordingFs((call) => { if (call.op === 'rename') renames++; });
      const { store, roots } = kit({ fs, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10))) });
      const ref = await created(store);
      const holder = start(['hold', roots.root, ref.storeId]);
      await untilLine(holder, 'held');
      const refused = await store.closeAdmission(ref);
      expect(refused).toMatchObject({ ok: false, attempts: ADMISSION_CLOSE_ATTEMPTS });
      expect(renames).toBe(ADMISSION_CLOSE_ATTEMPTS);
      expect(store.admissionState(ref)).toBe('open');
      expect(readdirSync(path.join(ref.root, 'admission'))).toEqual(['open']);
      const meanwhile = store.acquireAdmission(ref);
      expect(meanwhile.ok).toBe(true);
      if (meanwhile.ok) meanwhile.handle.release();
      const released = untilLine(holder, 'released');
      holder.stdin?.write('release\n');
      await released;
      renames = 0;
      expect(await store.closeAdmission(ref)).toEqual({ ok: true, alreadyClosed: false });
      expect(renames).toBe(1);
      expect(store.acquireAdmission(ref)).toMatchObject({ ok: false, reason: 'closed' });
      await new Promise((resolve) => holder.once('close', resolve));
    }
  }, 60_000);

  it('is released by a holder that is killed with taskkill /f', async () => {
    for (let round = 0; round < 3; round++) {
      const { store, roots } = realSleepKit();
      const ref = await created(store);
      const holder = start(['hold', roots.root, ref.storeId]);
      await untilLine(holder, 'held');
      expect(await store.closeAdmission(ref)).toMatchObject({ ok: false });
      const closed = new Promise((resolve) => holder.once('close', resolve));
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
      spawnSync(path.win32.join(systemRoot, 'System32', 'taskkill.exe'), ['/pid', String(holder.pid), '/f'], { windowsHide: true });
      await closed;
      expect(await store.closeAdmission(ref)).toEqual({ ok: true, alreadyClosed: false });
    }
  }, 60_000);
});

describe('creation killed part way', () => {
  it.each(['after-folder', 'after-identity', 'after-manifest', 'before-guard'])('killed %s: never opened as complete, no open gate, collected after 10 minutes', async (step) => {
    const { store, roots, clock } = kit();
    const { code } = await output(start(['crash', roots.root, step]));
    expect(code).not.toBe(0);
    const ids = readdirSync(roots.instances);
    expect(ids).toHaveLength(1);
    const storeId = ids[0];
    const opened = store.open(storeId);
    expect(opened).toMatchObject({ ok: false, reason: 'missing' });
    const ref: InstanceRef = { storeId, root: path.join(roots.instances, storeId) };
    expect(store.admissionState(ref)).toBe('missing');
    expect(store.acquireAdmission(ref).ok).toBe(false);
    expect(await store.collectInstances(null, [])).toEqual([]);
    clock.offsetMs = INSTANCE_LIMITS.unpublishedInstanceAgeMs + 60_000;
    expect(await store.collectInstances(null, [])).toEqual([storeId]);
    expect(readdirSync(roots.instances)).toEqual([]);
  }, 30_000);
});

describe('concurrent promotion of one key (real processes)', () => {
  it('leaves one folder and one fact; every other process reports already promoted', async () => {
    for (let round = 0; round < 3; round++) {
      const { store, roots } = kit();
      const ref = await created(store);
      const goFile = path.join(roots.root, `go-${round}`);
      temps.push(goFile);
      const workers = Array.from({ length: 6 }, (_, index) => output(start(['promote', roots.root, ref.storeId, String(index), goFile])));
      await new Promise((resolve) => setTimeout(resolve, 400));
      writeFileSync(goFile, '');
      const results = (await Promise.all(workers)).map(({ out }) => JSON.parse(out) as { ok: boolean; alreadyPromoted?: boolean; taskToken?: string });
      expect(results.every((result) => result.ok)).toBe(true);
      const winners = results.filter((result) => result.alreadyPromoted === false);
      expect(winners).toHaveLength(1);
      expect(results.filter((result) => result.alreadyPromoted === true)).toHaveLength(5);
      const keys = store.listVersionFolders(ref);
      expect(keys).toHaveLength(1);
      const view = store.read(ref);
      if (view.kind !== 'readable') throw new Error('unreadable');
      expect(Object.keys(view.snapshot.record.versions)).toEqual(keys);
      expect(view.snapshot.record.versions[keys[0]].taskToken).toBe(winners[0].taskToken);
      expect(readdirSync(path.join(ref.root, 'staging'))).toEqual([]);
    }
  }, 120_000);
});
