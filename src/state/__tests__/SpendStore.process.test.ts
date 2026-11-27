import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { buildSync } from 'esbuild';
import { FileSpendLedger } from '../SpendStore';
import { aggregateSpend, counterTotals, latestApplicableReset } from '../../models/spend/SpendAggregate';

/*
 * v0.9.89 design §8: three independent-process tests, plus a fourth for a stalled lock holder (Codex audit,
 * round 2). Each child is a separate Node process running the real SpendStore against one shared directory, like
 * two VS Code windows on one project.
 */

let workDir: string;
let worker: string;

beforeAll(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-spend-process-'));
  worker = path.join(workDir, 'worker.cjs');
  buildSync({
    entryPoints: [path.join(__dirname, 'spendStoreWorker.fixture.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: worker,
    // The same jsonc-parser resolution as esbuild.config.mjs (its UMD `main` cannot be bundled).
    alias: { 'jsonc-parser': path.join(process.cwd(), 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js') },
    logLevel: 'silent',
  });
});

afterAll(async () => {
  await fsp.rm(workDir, { recursive: true, force: true });
});

function run(args: string[]): { child: ChildProcess; done: Promise<{ code: number | null; stdout: string; stderr: string }> } {
  const child = spawn(process.execPath, [worker, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

async function freshRoot(name: string): Promise<string> {
  const root = path.join(workDir, name);
  await fsp.mkdir(root, { recursive: true });
  return root;
}

async function reader(root: string): Promise<FileSpendLedger> {
  const store = new FileSpendLedger({ root, hostEpoch: `reader-${Math.random().toString(36).slice(2)}`, pollMs: 0 });
  await store.open();
  return store;
}

describe('independent processes share one spend ledger', () => {
  it('1. two processes writing receipts at once: both appear exactly once in the merged total', async () => {
    const root = await freshRoot('receipts');
    const barrier = path.join(root, 'go');
    const a = run(['receipts', root, 'win-a', '60', barrier]);
    const b = run(['receipts', root, 'win-b', '60', barrier]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fsp.writeFile(barrier, '');
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect(ra.code, ra.stderr).toBe(0);
    expect(rb.code, rb.stderr).toBe(0);
    const store = await reader(root);
    const aggregate = aggregateSpend(store.snapshot().events);
    expect(aggregate.units.size).toBe(120);
    expect(counterTotals(aggregate, store.snapshot().control, { kind: 'request', requestId: 'shared-request' }).eligibleTokens).toBe(1200);
    await store.dispose();
  }, 60_000);

  it('2. a reset racing progress and receipts: every delta lands before or after its baseline exactly once', async () => {
    const root = await freshRoot('reset-race');
    const barrier = path.join(root, 'go');
    const writer = run(['progress', root, 'win-w', '80', barrier]);
    const resetter = run(['reset', root, 'win-r', '15', barrier]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fsp.writeFile(barrier, '');
    const [rw, rr] = await Promise.all([writer.done, resetter.done]);
    expect(rw.code, rw.stderr).toBe(0);
    expect(rr.code, rr.stderr).toBe(0);
    const store = await reader(root);
    const snapshot = store.snapshot();
    const aggregate = aggregateSpend(snapshot.events);
    const scope = { kind: 'request' as const, requestId: 'shared-request' };
    const total = counterTotals(aggregate, { ...snapshot.control, resets: [] }, scope).eligibleTokens;
    expect(total).toBe(80 * 20);
    expect(snapshot.control.resets.length).toBe(15);
    // Partition the stream by consecutive watermarks: each contribution falls in exactly one interval.
    const resets = snapshot.control.resets;
    let accounted = 0;
    for (let i = 0; i <= resets.length; i++) {
      const upper = resets[i];
      const lower = i === 0 ? undefined : resets[i - 1];
      for (const contribution of aggregate.contributions) {
        const above = (reset: typeof lower) => !reset || contribution.sequence > (reset.watermarks[contribution.segment] ?? -1)
          || reset.watermarks[contribution.segment] === undefined;
        if (above(lower) && (!upper || !above(upper))) accounted += contribution.reminderTokens;
      }
    }
    expect(accounted).toBe(total);
    // The final counter equals the stream after the last baseline, and never goes negative.
    const since = counterTotals(aggregate, snapshot.control, scope).eligibleTokens;
    expect(latestApplicableReset(snapshot.control, scope)?.resetId).toBe(resets.at(-1)!.resetId);
    expect(since).toBeGreaterThanOrEqual(0);
    expect(since).toBeLessThanOrEqual(total);
    await store.dispose();
  }, 60_000);

  it('3. a killed lock owner: the lock recovers after its lease while usage appends never waited', async () => {
    const root = await freshRoot('killed-owner');
    const holder = run(['hold-lock', root, 'win-dead', '0']);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the holder never took the lock')), 15_000);
      holder.child.stdout!.on('data', (chunk) => { if (String(chunk).includes('holding')) { clearTimeout(timer); resolve(); } });
    });
    holder.child.kill('SIGKILL');
    await holder.done;
    // While the dead owner's lock stands, model usage keeps being recorded without waiting.
    const store = new FileSpendLedger({ root, hostEpoch: 'win-live', pollMs: 0, leaseMs: 1_500 });
    await store.open();
    const started = Date.now();
    await store.append({ kind: 'usage-unit-start', usageUnitId: 'during', requestId: 'r', agentId: 'pm', connectionId: 'unode', modelId: 'm', providerAttempts: 1 }, 'start:during:1');
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(store.transact((control) => ({ next: control, result: 'early' }))).rejects.toThrow(/Another UnodeAi window/);
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    await expect(store.transact((control) => ({ next: { ...control, noticeClaims: [{ key: 'recovered', claimedAt: new Date().toISOString() }] }, result: 'recovered' }))).resolves.toBe('recovered');
    expect(store.snapshot().events.map((stored) => stored.event.eventId)).toContain('start:during:1');
    await store.dispose();
  }, 60_000);

  it('4. a stalled holder whose lease was taken over cannot overwrite newer control or release the new lock', async () => {
    const root = await freshRoot('stale-holder');
    const barrier = path.join(root, 'go');
    const holder = run(['stale-holder', root, 'win-stale', '0', barrier]);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the holder never reached its publish')), 15_000);
      holder.child.stdout!.on('data', (chunk) => { if (String(chunk).includes('at-publish')) { clearTimeout(timer); resolve(); } });
    });
    let ids = 0;
    let hook: () => Promise<void> = async () => undefined;
    const store = new FileSpendLedger({
      root, hostEpoch: 'win-new', pollMs: 0, leaseMs: 1_000, renewMs: 60_000, randomId: () => `new-${++ids}`,
      beforeControlPublish: () => hook(),
    });
    await store.open();
    // The stalled holder has passed its ownership check; its lease now runs out and this window takes over.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await expect(store.transact((control) => ({ next: { ...control, noticeClaims: [{ key: 'new', claimedAt: new Date().toISOString() }] }, result: 'new' }))).resolves.toBe('new');
    let ownerWhileHeld: string | undefined;
    let holderResult: { code: number | null; stdout: string; stderr: string } | undefined;
    hook = async () => {
      // While this window holds the lock again, the stalled holder resumes, tries to publish and releases.
      await fsp.writeFile(barrier, '');
      holderResult = await holder.done;
      ownerWhileHeld = JSON.parse(await fsp.readFile(path.join(root, 'maintenance.lock', 'owner.json'), 'utf8')).nonce;
    };
    await expect(store.transact((control) => ({ next: { ...control, noticeClaims: [...control.noticeClaims, { key: 'new-2', claimedAt: new Date().toISOString() }] }, result: 'new-2' }))).resolves.toBe('new-2');
    expect(holderResult?.code, holderResult?.stderr).toBe(0);
    expect(holderResult?.stdout).toContain('rejected');
    expect(ownerWhileHeld).toMatch(/^new-/);
    const check = await reader(root);
    expect(check.snapshot().control.revision).toBe(2);
    expect(check.snapshot().control.noticeClaims.map((claim) => claim.key)).toEqual(['new', 'new-2']);
    await check.dispose();
    await store.dispose();
  }, 60_000);
});
