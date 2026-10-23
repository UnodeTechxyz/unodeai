import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runWindowsPowerShell, type WindowsPowerShellRequest, type WindowsPowerShellRunResult } from '../../windowsPowerShell';
import { judgeProcessIdentity, PROCESS_CREATION_PATTERN, queryProcessCreations, type ProcessCreations } from '../processIdentity';

// The design these tests realise: the process-creation query runs the system's Windows PowerShell with the fixed
// script and reads `Win32_Process.CreationDate` with 100 ns precision, identical on every query of the same process;
// a process that ended is absent from the answer and so is dead. Windows only.
//
// It checks the answer's form and meaning, not how fast a host answers. On GitHub's Windows runner, running the whole
// suite, a query with a 30 s bound answered and the next one, with the product's 5 s bound, timed out; a desktop
// answers in half a second even with every core busy. The bound and the `unavailable` answer it gives (counted as
// alive) are processIdentity.test.ts's; every query here runs the product's request with a 30 s bound instead.

const temps: string[] = [];
// A process stopped a moment ago can still hold its folder on a slow Windows host (GitHub's runner: EPERM).
// Node retries EPERM/EBUSY with a growing wait (100 ms more each time, about 21 s in all); a folder still held after
// that fails the test, since a process that did not stop is what these tests are about.
afterEach(() => {
  for (const folder of temps.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}, 30_000);

/**
 * A run that does not finish within its bound says nothing about the answer, so a timed-out query is asked again,
 * up to three times; any other `unavailable` fails at once. Three queries of up to three 30 s runs fit the budget,
 * and the child outlives all of them. (GitHub's Windows runner once let a run pass 30 s after two answered.)
 */
const QUERY_BOUND_MS = 30_000;
const QUERY_ATTEMPTS = 3;
const TEST_BUDGET_MS = 3 * QUERY_ATTEMPTS * QUERY_BOUND_MS + 30_000;
const CHILD_LIFETIME_MS = 2 * TEST_BUDGET_MS;

/** Asks again only when the last run timed out; an answer, or any other `unavailable`, is final. */
async function askUntilAnswered(ask: () => Promise<ProcessCreations>, lastRun: () => WindowsPowerShellRunResult | undefined): Promise<ProcessCreations> {
  let answer: ProcessCreations = 'unavailable';
  for (let attempt = 1; attempt <= QUERY_ATTEMPTS; attempt += 1) {
    answer = await ask();
    const last = lastRun();
    if (answer !== 'unavailable' || !(last && last.status === 'unavailable' && last.reason === 'timeout')) break;
  }
  return answer;
}

/**
 * The host answered none of a query's attempts in time: every run of it timed out. GitHub's Windows runner, running
 * the whole suite, has done so for more than 90 s; that is a fact about the machine, so the test skips (it is an
 * environment-dependent skip in the release baseline). An answer, or `unavailable` for any other reason, is judged.
 */
function hostDidNotAnswer(answer: ProcessCreations, attemptRuns: readonly WindowsPowerShellRunResult[]): boolean {
  return answer === 'unavailable' && attemptRuns.length === QUERY_ATTEMPTS
    && attemptRuns.every((run) => run.status === 'unavailable' && run.reason === 'timeout');
}

interface ObservedChild {
  readonly pid?: number;
  kill(): boolean;
  once(event: 'exit', listener: () => void): unknown;
}

/**
 * Alive twice with one creation time, then dead once stopped. The child's exit is observed from the start, so an exit
 * that happens while a query runs, or before its answer is read, is not missed.
 */
async function observeLifeAndDeath(child: ObservedChild, query: (pids: number[]) => Promise<ProcessCreations>, runs: () => string): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once('exit', resolve));
  const pid = child.pid as number;
  const first = await query([process.pid, pid]);
  expect(first, runs()).not.toBe('unavailable');
  if (first === 'unavailable') return;
  expect(first.get(process.pid)).toMatch(PROCESS_CREATION_PATTERN);
  expect(first.get(pid)).toMatch(PROCESS_CREATION_PATTERN);
  const second = await query([pid]);
  expect(second).toEqual(new Map([[pid, first.get(pid)]]));
  const identity = { pid, creation: first.get(pid) as string };
  expect(judgeProcessIdentity(identity, second)).toBe('alive');
  child.kill();
  await exited;
  const after = await query([pid]);
  expect(after, runs()).not.toBe('unavailable');
  expect(judgeProcessIdentity(identity, after)).toBe('dead');
}

describe.runIf(process.platform === 'win32')('process creation times on a real Windows host', () => {
  it('reads this process and a child with 100 ns creation times, the same on a second query, and a stopped child as dead', async (context) => {
    const folder = mkdtempSync(path.join(tmpdir(), 'unode-pc-'));
    temps.push(folder);
    const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${CHILD_LIFETIME_MS})`], { stdio: 'ignore', windowsHide: true });
    // Every run is kept, so that an `unavailable` answer says why (a timeout, an exit code, the output).
    const runs: WindowsPowerShellRunResult[] = [];
    const recorded = { runPowerShell: async (request: WindowsPowerShellRequest) => {
      const result = await runWindowsPowerShell({ ...request, timeoutMs: QUERY_BOUND_MS });
      runs.push(result);
      return result;
    } };
    try {
      const query = async (pids: number[]): Promise<ProcessCreations> => {
        const first = runs.length;
        const answer = await askUntilAnswered(
          () => queryProcessCreations(pids, { ownedFolder: folder, ownedTmp: folder }, recorded),
          () => runs[runs.length - 1],
        );
        if (hostDidNotAnswer(answer, runs.slice(first))) {
          context.skip(`this host answered none of ${QUERY_ATTEMPTS} runs within ${QUERY_BOUND_MS / 1000} s: ${JSON.stringify(runs)}`);
        }
        return answer;
      };
      await observeLifeAndDeath(child, query, () => JSON.stringify(runs));
    } finally {
      child.kill();
    }
  }, TEST_BUDGET_MS);
});

describe('observing a child that ends while a query answers', () => {
  it('reaches the dead check when the child exits after the second answer is taken and before it is read', async () => {
    const created = '2026-10-23T00:00:00.1234567Z';
    let ended = false;
    let queries = 0;
    const child = Object.assign(new EventEmitter(), {
      pid: 424242,
      end() { if (!ended) { ended = true; child.emit('exit', 0, null); } },
      kill() { child.end(); return true; },
    });
    const query = async (pids: number[]): Promise<ProcessCreations> => {
      queries += 1;
      const answer = new Map<number, string>();
      for (const pid of pids) {
        if (pid === process.pid) answer.set(pid, created);
        else if (queries < 3) answer.set(pid, created);
      }
      // The second answer saw the child alive; the child ends before the caller reads it.
      if (queries === 2) child.end();
      return answer;
    };
    await expect(observeLifeAndDeath(child, query, () => '')).resolves.toBeUndefined();
    expect(queries).toBe(3);
  });
});

describe('asking again after a run that timed out', () => {
  const timedOut: WindowsPowerShellRunResult = { status: 'unavailable', reason: 'timeout', detail: 'did not finish', stderr: '' };
  const exitedBadly: WindowsPowerShellRunResult = { status: 'exited', code: 4, signal: null, stdout: 'UNODE-PC1:ERR', stderr: '' };
  const answered: ProcessCreations = new Map([[process.pid, '2026-10-23T00:00:00.1234567Z']]);
  function asker(runs: WindowsPowerShellRunResult[], answers: ProcessCreations[]) {
    const seen: WindowsPowerShellRunResult[] = [];
    let asked = 0;
    const ask = async () => { seen.push(runs[asked]); return answers[asked++]; };
    return { ask, last: () => seen[seen.length - 1], asked: () => asked };
  }

  it('asks again after a timeout and returns the answer that comes', async () => {
    const a = asker([timedOut, timedOut, exitedBadly], ['unavailable', 'unavailable', answered]);
    await expect(askUntilAnswered(a.ask, a.last)).resolves.toBe(answered);
    expect(a.asked()).toBe(3);
  });

  it('does not ask again when the run was unavailable for another reason', async () => {
    const a = asker([exitedBadly, timedOut], ['unavailable', answered]);
    await expect(askUntilAnswered(a.ask, a.last)).resolves.toBe('unavailable');
    expect(a.asked()).toBe(1);
  });

  it('skips only when every attempt of a query timed out', () => {
    expect(hostDidNotAnswer('unavailable', [timedOut, timedOut, timedOut])).toBe(true);
    expect(hostDidNotAnswer('unavailable', [timedOut, timedOut, exitedBadly])).toBe(false);
    expect(hostDidNotAnswer('unavailable', [exitedBadly])).toBe(false);
    expect(hostDidNotAnswer('unavailable', [timedOut])).toBe(false);
    expect(hostDidNotAnswer(answered, [timedOut, timedOut, timedOut])).toBe(false);
  });

  it('gives up after three timeouts', async () => {
    const a = asker([timedOut, timedOut, timedOut, timedOut], ['unavailable', 'unavailable', 'unavailable', answered]);
    await expect(askUntilAnswered(a.ask, a.last)).resolves.toBe('unavailable');
    expect(a.asked()).toBe(3);
  });
});
