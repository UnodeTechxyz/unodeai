import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GenerationLease, cachedSelfIdentity, type HeldLease } from '../GenerationLease';
import { processIdentityHost, type ProcessIdentityAdapter, type ProcessIdentityRecord, type ProcessLiveness } from '../../host/processIdentity/ProcessIdentityHost';
import { runWindowsPowerShell, type WindowsPowerShellRequest, type WindowsPowerShellRunResult } from '../../host/windowsPowerShell';

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-lease-'));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

/** A fake identity service: each pid answers what the test says. */
function identities(answers: Map<number, ProcessLiveness>): ProcessIdentityAdapter {
  return {
    platform: 'linux',
    self: async () => 'unknown',
    identityOf: async () => 'unknown',
    liveness: async (records) => records.map((record) => answers.get(record.pid) ?? 'unknown'),
  };
}

function record(pid: number): ProcessIdentityRecord {
  return { pid, startToken: String(pid), bootToken: 'boot', platform: 'linux' };
}

function lease(host: string, pid: number | undefined, answers: Map<number, ProcessLiveness>, clock?: { t: number }): GenerationLease {
  return new GenerationLease(path.join(dir, 'lease'), {
    hostInstanceId: host,
    selfIdentity: async () => (pid === undefined ? undefined : record(pid)),
    identity: identities(answers),
    ...(clock ? { now: () => clock.t, sleep: async (ms: number) => { clock.t += ms; } } : {}),
  });
}

async function held(attempt: Awaited<ReturnType<GenerationLease['tryAcquire']>>): Promise<HeldLease> {
  expect(attempt.status).toBe('held');
  return (attempt as { lease: HeldLease }).lease;
}

describe('GenerationLease', () => {
  it('lets one holder at a time, and the next takes the following generation after a release', async () => {
    const answers = new Map<number, ProcessLiveness>([[1, 'alive'], [2, 'alive']]);
    const a = lease('host-a', 1, answers);
    const b = lease('host-b', 2, answers);
    const first = await held(await a.tryAcquire('test'));
    expect(first.generation).toBe(1);
    expect(await b.tryAcquire('test')).toEqual({ status: 'busy', holder: 'alive' });
    await first.release();
    const second = await held(await b.tryAcquire('test'));
    expect(second.generation).toBe(2);
    expect(await a.readOwner(2)).toMatchObject({ hostInstanceId: 'host-b', identity: record(2), purpose: 'test' });
  });

  it('takes over a holder proven gone, and never one that is alive or cannot be proven', async () => {
    const answers = new Map<number, ProcessLiveness>([[1, 'alive'], [3, 'unknown']]);
    const crashed = lease('crashed', 1, answers);
    await held(await crashed.tryAcquire('test'));
    const other = lease('other', 2, answers);
    expect(await other.tryAcquire('test')).toEqual({ status: 'busy', holder: 'alive' });
    answers.set(1, 'gone');
    const taken = await held(await other.tryAcquire('test'));
    expect(taken.generation).toBe(2);
    // The gone holder's record was not removed or rewritten; it is only an older generation.
    expect((await other.readOwner(1))?.hostInstanceId).toBe('crashed');

    await fsp.rm(path.join(dir, 'lease'), { recursive: true });
    const unknown = lease('unknown-holder', 3, answers);
    await held(await unknown.tryAcquire('test'));
    expect(await lease('x', 4, answers).tryAcquire('test')).toEqual({ status: 'busy', holder: 'unknown' });

    await fsp.rm(path.join(dir, 'lease'), { recursive: true });
    const anonymous = lease('no-identity', undefined, answers);
    await held(await anonymous.tryAcquire('test'));
    expect(await lease('x', 4, answers).tryAcquire('test')).toEqual({ status: 'busy', holder: 'unknown' });
  });

  it('waits at most the given time: taken when the holder lets go, busy when it does not', async () => {
    const answers = new Map<number, ProcessLiveness>([[1, 'alive']]);
    const holder = lease('holder', 1, answers);
    const first = await held(await holder.tryAcquire('test'));
    const clock = { t: 0 };
    const waiter = lease('waiter', 2, answers, clock);
    const busy = await waiter.acquire('test', { waitMs: 5_000 });
    expect(busy).toEqual({ status: 'busy', holder: 'alive' });
    expect(clock.t).toBeGreaterThanOrEqual(5_000);
    expect(clock.t).toBeLessThan(5_200);

    let polls = 0;
    const clock2 = { t: 0 };
    const waiter2 = new GenerationLease(path.join(dir, 'lease'), {
      hostInstanceId: 'waiter2', selfIdentity: async () => record(2), identity: identities(answers),
      now: () => clock2.t,
      sleep: async (ms) => { clock2.t += ms; if (++polls === 3) await first.release(); },
    });
    const got = await waiter2.acquire('test', { waitMs: 5_000 });
    expect(got.status).toBe('held');
    expect(clock2.t).toBeLessThan(1_000);
  });

  it('gives exactly one of two writers racing for the same generation', async () => {
    const answers = new Map<number, ProcessLiveness>();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => lease(`racer-${i}`, 10 + i, answers).tryAcquire('race')));
    expect(results.filter((result) => result.status === 'held')).toHaveLength(1);
  });

  it('lets this host continue after its own release failed, without proving anything about itself', async () => {
    const answers = new Map<number, ProcessLiveness>([[1, 'alive']]);
    const a = lease('host-a', 1, answers);
    await held(await a.tryAcquire('test'));
    // The release marker never reached the disk; this host knows it does not hold generation 1 any more.
    const fresh = new GenerationLease(path.join(dir, 'lease'), { hostInstanceId: 'host-a', selfIdentity: async () => record(1), identity: identities(answers) });
    expect((await held(await fresh.tryAcquire('test'))).generation).toBe(2);
    // Another host still sees a live holder.
    expect(await lease('host-b', 2, answers).tryAcquire('test')).toEqual({ status: 'busy', holder: 'alive' });
  });

  it('keeps only the two newest generations', async () => {
    const answers = new Map<number, ProcessLiveness>();
    const a = lease('a', 1, answers);
    for (let i = 0; i < 5; i++) await (await held(await a.tryAcquire('test'))).release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const names = fs.readdirSync(path.join(dir, 'lease')).filter((name) => !name.startsWith('.')).sort();
    expect(names).toEqual(['gen.000000000004.json', 'gen.000000000005.json', 'released.000000000004', 'released.000000000005']);
  });
});

// On Windows the identity comes from a Windows PowerShell query. This test checks what the lease does with real
// identities, not how fast a host answers: GitHub's Windows runner, running the whole suite, has let the product's 5 s
// bound pass (the nightly of 2026-11-26 failed here at 5,051 ms). As in processIdentity.realHost.test.ts, each run here
// has a 30 s bound and a timed-out run is asked again, up to three times; a host that answered none of them in time
// skips the test (an environment-dependent skip in the release baseline). Any other answer is judged.
const QUERY_BOUND_MS = 30_000;
const QUERY_ATTEMPTS = 3;
const LEASE_QUERIES = 4; // the child's identity, this host's own, the child alive, the child gone

describe('GenerationLease with real processes', () => {
  it('takes over only after the real holder process is proven gone by the operating system', async (context) => {
    const queryFolder = await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-lease-query-'));
    const runs: WindowsPowerShellRunResult[] = [];
    let unanswered = false;
    const runPowerShell = async (request: WindowsPowerShellRequest): Promise<WindowsPowerShellRunResult> => {
      let result: WindowsPowerShellRunResult | undefined;
      for (let attempt = 1; attempt <= QUERY_ATTEMPTS; attempt += 1) {
        result = await runWindowsPowerShell({ ...request, timeoutMs: QUERY_BOUND_MS });
        runs.push(result);
        if (!(result.status === 'unavailable' && result.reason === 'timeout')) return result;
      }
      unanswered = true;
      return result!;
    };
    const skipIfUnanswered = () => {
      if (unanswered) context.skip(`this host answered none of ${QUERY_ATTEMPTS} runs within ${QUERY_BOUND_MS / 1000} s: ${JSON.stringify(runs)}`);
    };
    const identity = processIdentityHost({ windows: { request: { ownedFolder: queryFolder, ownedTmp: queryFolder }, deps: { runPowerShell } } });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    try {
      const childIdentity = await identity.identityOf(child.pid!);
      skipIfUnanswered();
      expect(childIdentity, `the child process identity can be read on this platform: ${JSON.stringify(runs)}`).not.toBe('unknown');
      // The child holds the lease, published with its own identity.
      const holder = new GenerationLease(path.join(dir, 'lease'), {
        hostInstanceId: 'child-host', selfIdentity: async () => childIdentity as ProcessIdentityRecord, identity,
      });
      await held(await holder.tryAcquire('real'));
      const me = new GenerationLease(path.join(dir, 'lease'), { hostInstanceId: 'parent-host', selfIdentity: cachedSelfIdentity(identity), identity });
      const whileAlive = await me.tryAcquire('real');
      skipIfUnanswered();
      expect(whileAlive).toEqual({ status: 'busy', holder: 'alive' });
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
      const taken = await me.tryAcquire('real');
      skipIfUnanswered();
      expect(taken.status, JSON.stringify(runs)).toBe('held');
      expect((await me.readOwner(2))?.identity?.pid).toBe(process.pid);
    } finally {
      if (child.exitCode === null) child.kill();
      await fsp.rm(queryFolder, { recursive: true, force: true }).catch(() => undefined);
    }
  }, LEASE_QUERIES * QUERY_ATTEMPTS * QUERY_BOUND_MS + 30_000);
});
