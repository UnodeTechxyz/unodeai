import { type ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  descendantsLeafFirst,
  HostShutdown,
  OBSERVED_HOST_TOOL_TIMEOUT_MS,
  type ProcessRow,
  type ProcessTreeTerminationDeps,
  runHostTool,
  terminateChildProcessTree,
  terminateProcessTreeObserved,
} from '../processTree';

/** A fake process table: which PIDs exist, who their parent is, and every signal sent. */
function fakeHost(rows: ProcessRow[], options: { permission?: number[] } = {}) {
  const alive = new Set<number>([...rows.map((row) => row.pid), ...rows.map((row) => row.ppid)]);
  const signals: Array<[number, NodeJS.Signals | 0]> = [];
  const kill = (pid: number, signal: NodeJS.Signals | 0) => {
    signals.push([pid, signal]);
    if (options.permission?.includes(pid)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    if (!alive.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    if (signal === 'SIGKILL') alive.delete(pid);
  };
  return { alive, signals, kill, rows };
}

const instant: Pick<ProcessTreeTerminationDeps, 'sleep' | 'now'> = (() => {
  let clock = 0;
  return { sleep: async (ms: number) => { clock += ms; }, now: () => clock };
})();

describe('terminateProcessTreeObserved (v0.9.96)', () => {
  it('orders descendants leaf-first, and ignores loops and self-parents', () => {
    expect(descendantsLeafFirst(1, [
      { pid: 2, ppid: 1 }, { pid: 3, ppid: 2 }, { pid: 4, ppid: 1 }, { pid: 5, ppid: 5 }, { pid: 1, ppid: 3 },
    ])).toEqual([3, 2, 4]);
  });

  it('does not take an older process for the child of a newer one that holds its ended parent\'s number', () => {
    expect(descendantsLeafFirst(100, [
      { pid: 100, ppid: 4, created: 5_000 },
      { pid: 101, ppid: 100, created: 5_001 },
      // csrss.exe: its smss.exe parent ended at sign-in, and 100 is that parent's number again.
      { pid: 300, ppid: 100, created: 10 },
      { pid: 301, ppid: 300, created: 20 },
      // No creation time: the listed parent counts.
      { pid: 102, ppid: 101 },
    ])).toEqual([102, 101]);
  });

  describe('Windows', () => {
    it('confirms the stop only after every captured process is seen gone after taskkill', async () => {
      const host = fakeHost([{ pid: 100, ppid: 4 }, { pid: 101, ppid: 100 }, { pid: 102, ppid: 101 }]);
      const killed: number[] = [];
      const outcome = await terminateProcessTreeObserved(100, {
        platform: 'win32',
        kill: host.kill,
        listProcesses: async () => host.rows,
        taskkill: async (pid) => { killed.push(pid); for (const p of [100, 101, 102]) host.alive.delete(p); return 0; },
        ...instant,
      });
      expect(killed).toEqual([100]);
      expect(outcome).toEqual({ status: 'confirmed-stopped' });
    });

    it('does not take exit 0 from taskkill as proof while a captured child is still running', async () => {
      const host = fakeHost([{ pid: 100, ppid: 4 }, { pid: 101, ppid: 100 }]);
      const outcome = await terminateProcessTreeObserved(100, {
        platform: 'win32',
        kill: host.kill,
        listProcesses: async () => host.rows,
        taskkill: async () => { host.alive.delete(100); return 0; },
        confirmTimeoutMs: 300,
        ...instant,
      });
      expect(outcome).toEqual({ status: 'unknown', detail: 'process 101 was still running' });
    });

    it('reports unknown for an unreadable process list or a taskkill that could not run, even when the tree is gone', async () => {
      const noList = fakeHost([{ pid: 100, ppid: 4 }]);
      expect(await terminateProcessTreeObserved(100, {
        platform: 'win32', kill: noList.kill, listProcesses: async () => undefined,
        taskkill: async () => { noList.alive.delete(100); return 0; }, ...instant,
      })).toEqual({ status: 'unknown', detail: 'the process list could not be read' });

      const noTaskkill = fakeHost([{ pid: 100, ppid: 4 }]);
      expect(await terminateProcessTreeObserved(100, {
        platform: 'win32', kill: noTaskkill.kill, listProcesses: async () => noTaskkill.rows,
        taskkill: async () => undefined, confirmTimeoutMs: 100, ...instant,
      })).toMatchObject({ status: 'unknown', detail: expect.stringContaining('taskkill could not run') });
    });

    describe('a taskkill that exits non-zero', () => {
      /**
       * cmd.exe (100) runs node (101) beside its conhost (102). taskkill stops 101 and 102, and cmd.exe ends on its own
       * before taskkill reaches it, so taskkill exits 255 although the tree is gone. A listing shows what is alive,
       * plus `addedLater` from the second listing on.
       */
      function racedTree(options: { afterKill?: (host: ReturnType<typeof fakeHost>) => void; addedLater?: ProcessRow[]; unreadable?: number[] } = {}) {
        const host = fakeHost([
          { pid: 100, ppid: 4, created: 5_000 }, { pid: 101, ppid: 100, created: 5_001 }, { pid: 102, ppid: 100, created: 5_002 },
          { pid: 200, ppid: 4, created: 1 },
        ]);
        let listings = 0;
        let taskkills = 0;
        const deps: ProcessTreeTerminationDeps = {
          platform: 'win32',
          kill: host.kill,
          listProcesses: async () => {
            listings += 1;
            if (options.unreadable?.includes(listings)) return undefined;
            const alive = host.rows.filter((row) => host.alive.has(row.pid));
            return listings > 1 ? [...alive, ...(options.addedLater ?? [])] : alive;
          },
          taskkill: async () => {
            taskkills += 1;
            for (const pid of [101, 102, 100]) host.alive.delete(pid);
            options.afterKill?.(host);
            return 255;
          },
          confirmTimeoutMs: 300,
          ...instant,
        };
        return { host, deps, listings: () => listings, taskkills: () => taskkills };
      }

      it('confirms the stop when a second listing shows no captured process and no child of one, and stops nothing more', async () => {
        const tree = racedTree();
        expect(await terminateProcessTreeObserved(100, tree.deps)).toEqual({ status: 'confirmed-stopped' });
        expect(tree.listings()).toBe(2);
        expect(tree.taskkills()).toBe(1);
        expect(tree.host.signals.every(([, signal]) => signal === 0)).toBe(true);
      });

      it('reports unknown when the second listing shows a child of a captured process still running, and does not stop it', async () => {
        // node (101) started 103 after the first listing, and taskkill could not stop it.
        const tree = racedTree({ afterKill: (host) => { host.rows.push({ pid: 103, ppid: 101 }); host.alive.add(103); } });
        expect(await terminateProcessTreeObserved(100, tree.deps)).toEqual({
          status: 'unknown',
          detail: 'taskkill exited 255, and process 103, a child of process 101, is still running',
        });
        expect(tree.taskkills()).toBe(1);
        expect(tree.host.signals.filter(([pid]) => pid === 103)).toEqual([]);
        expect(tree.host.alive.has(103)).toBe(true);
      });

      it('reports unknown when a captured PID is listed again, whoever its parent is', async () => {
        // The poll saw 101 gone; by the second listing that number belongs to a process again.
        const tree = racedTree({ addedLater: [{ pid: 101, ppid: 4 }] });
        expect(await terminateProcessTreeObserved(100, tree.deps)).toEqual({
          status: 'unknown',
          detail: 'taskkill exited 255, and process 101 is listed again',
        });
      });

      it('tells a reused number from a captured process in the second listing by its creation time', async () => {
        // 101's number now belongs to a younger process, and an older process lists 100 as its parent.
        const reused = racedTree({ addedLater: [{ pid: 101, ppid: 4, created: 9_000 }, { pid: 300, ppid: 100, created: 10 }] });
        expect(await terminateProcessTreeObserved(100, reused.deps)).toEqual({ status: 'confirmed-stopped' });

        const same = racedTree({ addedLater: [{ pid: 101, ppid: 100, created: 5_001 }] });
        expect(await terminateProcessTreeObserved(100, same.deps)).toEqual({
          status: 'unknown',
          detail: 'taskkill exited 255, and process 101 is listed again',
        });
      });

      it('reports unknown when the second listing cannot be read', async () => {
        const tree = racedTree({ unreadable: [2] });
        expect(await terminateProcessTreeObserved(100, tree.deps)).toEqual({
          status: 'unknown',
          detail: 'taskkill exited 255, and the process list could not be read again',
        });
      });

      it('never lets the second listing clear another problem', async () => {
        const stillRunning = racedTree({ afterKill: (host) => { host.alive.add(101); } });
        expect(await terminateProcessTreeObserved(100, stillRunning.deps)).toEqual({
          status: 'unknown',
          detail: 'process 101 was still running; taskkill exited 255',
        });

        const unlisted = racedTree({ unreadable: [1] });
        expect(await terminateProcessTreeObserved(100, unlisted.deps)).toEqual({
          status: 'unknown',
          detail: 'the process list could not be read; taskkill exited 255',
        });
      });
    });

    it('runs the default process list and taskkill within the observed tool limit of 20 s', async () => {
      const host = fakeHost([{ pid: 100, ppid: 4 }, { pid: 101, ppid: 100 }]);
      const calls: Array<[string, string[], number]> = [];
      const outcome = await terminateProcessTreeObserved(100, {
        platform: 'win32',
        kill: host.kill,
        resolveExecutable: (name) => `C:\\host\\${name}.exe`,
        runHostTool: async (executable, args, timeoutMs) => {
          calls.push([executable, args, timeoutMs]);
          if (executable.endsWith('taskkill.exe')) { host.alive.delete(100); host.alive.delete(101); return { code: 0, stdout: '' }; }
          return { code: 0, stdout: '100 4\r\n101 100\r\n' };
        },
        ...instant,
      });
      expect(outcome).toEqual({ status: 'confirmed-stopped' });
      expect(OBSERVED_HOST_TOOL_TIMEOUT_MS).toBe(20_000);
      expect(calls).toEqual([
        ['C:\\host\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', expect.stringMatching(/Win32_Process.*CreationDate\.ToFileTimeUtc\(\)/)], 20_000],
        ['C:\\host\\taskkill.exe', ['/pid', '100', '/t', '/f'], 20_000],
      ]);
    });

    it('reads each creation time from the Windows listing and leaves an older process that lists the shell as parent alone', async () => {
      // 300 is csrss.exe, which Windows does not let this host signal.
      const host = fakeHost([{ pid: 100, ppid: 4 }, { pid: 101, ppid: 100 }, { pid: 300, ppid: 100 }], { permission: [300] });
      const outcome = await terminateProcessTreeObserved(100, {
        platform: 'win32',
        kill: host.kill,
        resolveExecutable: (name) => name,
        runHostTool: async (executable) => {
          if (executable === 'taskkill') { host.alive.delete(100); host.alive.delete(101); return { code: 0, stdout: '' }; }
          return { code: 0, stdout: '100 4 134000000000000000\r\n101 100 134000000000010000\r\n300 100 133000000000000000\r\n7 0 -\r\n' };
        },
        ...instant,
      });
      expect(outcome).toEqual({ status: 'confirmed-stopped' });
      expect(host.signals.filter(([pid]) => pid === 300)).toEqual([]);
    });

    it('reads a host tool that ran out of time as an unreadable list and a taskkill that could not run', async () => {
      const host = fakeHost([{ pid: 100, ppid: 4 }]);
      expect(await terminateProcessTreeObserved(100, {
        platform: 'win32', kill: host.kill, resolveExecutable: (name) => name, runHostTool: async () => undefined,
        confirmTimeoutMs: 300, ...instant,
      })).toEqual({
        status: 'unknown',
        detail: 'the process list could not be read; taskkill could not run; process 100 was still running',
      });
    });

    it('reports a root that is already gone as already stopped, without running taskkill', async () => {
      const host = fakeHost([]);
      let ran = false;
      expect(await terminateProcessTreeObserved(100, {
        platform: 'win32', kill: host.kill, listProcesses: async () => [], taskkill: async () => { ran = true; return 0; }, ...instant,
      })).toEqual({ status: 'already-stopped' });
      expect(ran).toBe(false);
    });
  });

  describe('POSIX', () => {
    it('stops the root, collects new descendants until stable, kills leaf-first and confirms by ESRCH', async () => {
      const host = fakeHost([{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }]);
      let snapshots = 0;
      const outcome = await terminateProcessTreeObserved(10, {
        platform: 'linux',
        kill: host.kill,
        // A grandchild appears while the tree is being frozen; the next snapshot is stable.
        listProcesses: async () => {
          snapshots += 1;
          if (snapshots === 2) { host.rows.push({ pid: 12, ppid: 11 }); host.alive.add(12); }
          return [...host.rows];
        },
        ...instant,
      });
      expect(outcome).toEqual({ status: 'confirmed-stopped' });
      const stops = host.signals.filter(([, signal]) => signal === 'SIGSTOP').map(([pid]) => pid);
      const kills = host.signals.filter(([, signal]) => signal === 'SIGKILL').map(([pid]) => pid);
      expect(stops).toEqual([10, 11, 12]);
      expect(kills).toEqual([12, 11, 10]);
    });

    it('reports unknown for a process it may not signal, and for a tree that never stops changing', async () => {
      const denied = fakeHost([{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }], { permission: [11] });
      expect(await terminateProcessTreeObserved(10, {
        platform: 'linux', kill: denied.kill, listProcesses: async () => [...denied.rows], ...instant,
      })).toMatchObject({ status: 'unknown', detail: expect.stringContaining('process 11 cannot be signalled') });

      let next = 20;
      const churning = fakeHost([{ pid: 10, ppid: 1 }]);
      expect(await terminateProcessTreeObserved(10, {
        platform: 'linux',
        kill: churning.kill,
        listProcesses: async () => {
          churning.rows.push({ pid: next, ppid: 10 });
          churning.alive.add(next);
          next += 1;
          return [...churning.rows];
        },
        ...instant,
      })).toMatchObject({ status: 'unknown', detail: expect.stringContaining('the process tree kept changing') });
    });
  });

  describe('when the host shuts down', () => {
    const NOT_OBSERVED = 'the host was shutting down, so the stop was sent and not observed';
    /** The signals sent after the first liveness check of the root. */
    const after = (host: ReturnType<typeof fakeHost>) => host.signals.slice(1);

    it('runs taskkill on Windows without listing first, and claims nothing it did not see', async () => {
      const shutdown = new HostShutdown();
      shutdown.begin();
      const host = fakeHost([{ pid: 100, ppid: 4 }, { pid: 101, ppid: 100 }]);
      let listings = 0;
      const killed: number[] = [];
      expect(await terminateProcessTreeObserved(100, {
        platform: 'win32', kill: host.kill, shutdown,
        listProcesses: async () => { listings += 1; return host.rows; },
        taskkill: async (pid) => { killed.push(pid); host.alive.delete(100); host.alive.delete(101); return 0; },
        ...instant,
      })).toEqual({ status: 'unknown', detail: NOT_OBSERVED });
      expect(listings).toBe(0);
      expect(killed).toEqual([100]);
      // Not even a liveness poll: a gone root is no proof.
      expect(after(host)).toEqual([]);
    });

    it('sends taskkill as soon as the shutdown begins when a Windows stop is waiting on a slow listing, and the late list changes nothing', async () => {
      const shutdown = new HostShutdown();
      const host = fakeHost([{ pid: 100, ppid: 4 }, { pid: 101, ppid: 100 }]);
      let answer: (rows: ProcessRow[]) => void = () => undefined;
      const killed: number[] = [];
      const stopping = terminateProcessTreeObserved(100, {
        platform: 'win32', kill: host.kill, shutdown,
        // A listing that would take up to 20 s on a loaded machine.
        listProcesses: () => new Promise<ProcessRow[]>((resolve) => { answer = resolve; }),
        taskkill: async (pid) => { killed.push(pid); host.alive.delete(100); return 255; },
        ...instant,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(killed).toEqual([]);

      shutdown.begin();
      expect(await stopping).toEqual({ status: 'unknown', detail: `${NOT_OBSERVED}; taskkill exited 255` });
      expect(killed).toEqual([100]);
      answer(host.rows);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(killed).toEqual([100]);
      expect(after(host)).toEqual([]);
    });

    it('gives a POSIX listing the shutdown budget, and still kills the root when the list does not come back', async () => {
      const shutdown = new HostShutdown();
      shutdown.begin();
      const host = fakeHost([{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }]);
      const began = Date.now();
      const outcome = await terminateProcessTreeObserved(10, {
        platform: 'linux', kill: host.kill, shutdown, shutdownListingBudgetMs: 50,
        listProcesses: () => new Promise<ProcessRow[]>(() => undefined),
        ...instant,
      });
      expect(Date.now() - began).toBeLessThan(5_000);
      expect(outcome).toEqual({
        status: 'unknown',
        detail: `the host began shutting down before the process list came back, so descendants not yet listed were not stopped; ${NOT_OBSERVED}`,
      });
      expect(after(host)).toEqual([[10, 'SIGSTOP'], [10, 'SIGKILL']]);
    });

    it('kills every descendant a POSIX listing finds within the budget, leaf-first, and observes nothing', async () => {
      const shutdown = new HostShutdown();
      shutdown.begin();
      const host = fakeHost([{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }]);
      expect(await terminateProcessTreeObserved(10, {
        platform: 'linux', kill: host.kill, shutdown, shutdownListingBudgetMs: 5_000,
        listProcesses: async () => [...host.rows],
        ...instant,
      })).toEqual({ status: 'unknown', detail: NOT_OBSERVED });
      expect(after(host).filter(([, signal]) => signal === 'SIGKILL').map(([pid]) => pid)).toEqual([12, 11, 10]);
      expect(after(host).some(([, signal]) => signal === 0)).toBe(false);
    });

    it('stops watching a stop it is polling once the shutdown begins, without calling it confirmed or still running', async () => {
      const shutdown = new HostShutdown();
      const host = fakeHost([{ pid: 100, ppid: 4 }]);
      let polls = 0;
      expect(await terminateProcessTreeObserved(100, {
        platform: 'win32', kill: host.kill, shutdown,
        listProcesses: async () => host.rows,
        // taskkill reports success, and the root is still there when the window starts to close.
        taskkill: async () => 0,
        sleep: async () => { polls += 1; shutdown.begin(); },
        now: () => 0,
      })).toEqual({ status: 'unknown', detail: NOT_OBSERVED });
      expect(polls).toBe(1);
    });

    it('calls each listener once when the shutdown begins, and forgets one whose listing settled', () => {
      const shutdown = new HostShutdown();
      const heard: string[] = [];
      shutdown.onBegin(() => heard.push('a'));
      const forget = shutdown.onBegin(() => heard.push('b'));
      forget();
      shutdown.begin();
      shutdown.begin();
      shutdown.onBegin(() => heard.push('late'));
      expect(heard).toEqual(['a', 'late']);
      expect(shutdown.started).toBe(true);
    });

    describe('the listing time of one POSIX stop', () => {
      const CUT = 'the host began shutting down before the process list came back';
      /** A tree that gains a child at every listing, so it never looks stable, each listing taking `ms`. */
      const growing = (host: ReturnType<typeof fakeHost>, ms: number, count: { listings: number }) => () => {
        count.listings += 1;
        const child = 10 + count.listings;
        host.rows.push({ pid: child, ppid: 10 });
        host.alive.add(child);
        const rows = [...host.rows];
        return new Promise<ProcessRow[]>((resolve) => setTimeout(() => resolve(rows), ms));
      };
      /** When each SIGKILL was sent, in ms since `began`. */
      const timedKills = (host: ReturnType<typeof fakeHost>, began: number, kills: number[]) => (pid: number, signal: NodeJS.Signals | 0) => {
        if (signal === 'SIGKILL') kills.push(Date.now() - began);
        host.kill(pid, signal);
      };

      it('is shared by every round, so a later round gets only what is left of it', async () => {
        vi.useFakeTimers();
        try {
          const shutdown = new HostShutdown();
          shutdown.begin();
          const host = fakeHost([{ pid: 10, ppid: 1 }]);
          const count = { listings: 0 };
          const kills: number[] = [];
          const stopping = terminateProcessTreeObserved(10, {
            platform: 'linux', shutdown, shutdownListingBudgetMs: 100,
            kill: timedKills(host, Date.now(), kills), listProcesses: growing(host, 40, count),
          });
          await vi.advanceTimersByTimeAsync(1_000);
          // Two listings of 40 ms, and the third has 20 ms left: the kill goes out at 100 ms, not after five rounds.
          expect(await stopping).toMatchObject({ status: 'unknown', detail: expect.stringContaining(CUT) });
          expect(count.listings).toBe(3);
          expect(kills[0]).toBe(100);
          expect(kills).toHaveLength(3);
        } finally {
          vi.useRealTimers();
        }
      });

      it('is counted from when the shutdown begins for a listing already under way', async () => {
        vi.useFakeTimers();
        try {
          const shutdown = new HostShutdown();
          const host = fakeHost([{ pid: 10, ppid: 1 }]);
          const count = { listings: 0 };
          const kills: number[] = [];
          const stopping = terminateProcessTreeObserved(10, {
            platform: 'linux', shutdown, shutdownListingBudgetMs: 100,
            kill: timedKills(host, Date.now(), kills), listProcesses: growing(host, 60, count),
          });
          await vi.advanceTimersByTimeAsync(30);
          shutdown.begin();
          await vi.advanceTimersByTimeAsync(1_000);
          // The time runs out at 130 ms: the listings end at 60 and 120 ms, and the third is cut at 130 ms.
          expect(await stopping).toMatchObject({ status: 'unknown', detail: expect.stringContaining(CUT) });
          expect(count.listings).toBe(3);
          expect(kills[0]).toBe(130);
        } finally {
          vi.useRealTimers();
        }
      });

      it('starts no listing once it has run out, and still kills what was found', async () => {
        const shutdown = new HostShutdown();
        shutdown.begin();
        const host = fakeHost([{ pid: 10, ppid: 1 }]);
        let clock = 0;
        let listings = 0;
        const outcome = await terminateProcessTreeObserved(10, {
          platform: 'linux', shutdown, shutdownListingBudgetMs: 100, kill: host.kill, now: () => clock,
          // The one listing comes back as the time runs out, with a new child, so another round would follow.
          listProcesses: async () => {
            listings += 1;
            clock += 100;
            host.rows.push({ pid: 11, ppid: 10 });
            host.alive.add(11);
            return [...host.rows];
          },
        });
        expect(outcome).toMatchObject({ status: 'unknown', detail: expect.stringContaining(CUT) });
        expect(listings).toBe(1);
        expect(after(host).filter(([, signal]) => signal === 'SIGKILL').map(([pid]) => pid)).toEqual([11, 10]);
      });
    });
  });

  describe('a child whose end Node has seen', () => {
    /** A child Node started, with the state Node keeps of its end. */
    const nodeChild = (pid: number) => Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null }) as unknown as ChildProcess
      & { exitCode: number | null; signalCode: NodeJS.Signals | null };
    const ESRCH = () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); };

    it('sends nothing to the number of a child that has ended but not closed, although that number is in use again', async () => {
      const signals: Array<[number, NodeJS.Signals | 0]> = [];
      const taskkills: number[] = [];
      let listings = 0;
      // Every number is alive: the ended child's number now belongs to an unrelated process.
      const deps = (platform: NodeJS.Platform): ProcessTreeTerminationDeps => ({
        platform, shutdown: new HostShutdown(), kill: (pid, signal) => { signals.push([pid, signal]); },
        listProcesses: async () => { listings += 1; return [{ pid: 41001, ppid: 4 }, { pid: 41010, ppid: 41001 }]; },
        taskkill: async (pid) => { taskkills.push(pid); return 0; },
        ...instant,
      });
      const exited = nodeChild(41001);
      exited.exitCode = 0;
      exited.emit('exit', 0, null);
      expect(await terminateChildProcessTree(exited, deps('win32'))).toEqual({ status: 'already-stopped' });
      const signalled = nodeChild(41001);
      signalled.signalCode = 'SIGTERM';
      expect(await terminateChildProcessTree(signalled, deps('linux'))).toEqual({ status: 'already-stopped' });
      expect(signals).toEqual([]);
      expect(taskkills).toEqual([]);
      expect(listings).toBe(0);
    });

    it('does not run taskkill for a child that ends while its tree is listed, and leaves the verdict to what it then sees', async () => {
      const child = nodeChild(41001);
      const taskkills: number[] = [];
      let answer: (rows: ProcessRow[]) => void = () => undefined;
      const stopping = terminateChildProcessTree(child, {
        platform: 'win32', shutdown: new HostShutdown(),
        // Alive throughout: by the time the listing comes back the number is someone else's.
        kill: () => undefined,
        listProcesses: () => new Promise<ProcessRow[]>((resolve) => { answer = resolve; }),
        taskkill: async (pid) => { taskkills.push(pid); return 0; },
        confirmTimeoutMs: 300,
        ...instant,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      child.exitCode = 1;
      child.emit('exit', 1, null);
      answer([{ pid: 41001, ppid: 4, created: 1 }, { pid: 41010, ppid: 41001, created: 2 }]);
      expect(await stopping).toMatchObject({
        status: 'unknown',
        detail: expect.stringContaining('process 41001 ended before taskkill ran, so taskkill was not run'),
      });
      expect(taskkills).toEqual([]);
    });

    it('stops nothing listed under the number of a POSIX child that ended while it was listed, nor that number', async () => {
      const child = nodeChild(500);
      const host = fakeHost([{ pid: 500, ppid: 1 }, { pid: 501, ppid: 500 }]);
      const outcome = await terminateChildProcessTree(child, {
        platform: 'linux', shutdown: new HostShutdown(), kill: host.kill, confirmTimeoutMs: 300,
        listProcesses: async () => { child.signalCode = 'SIGKILL'; return [...host.rows]; },
        ...instant,
      });
      expect(outcome).toMatchObject({
        status: 'unknown',
        detail: expect.stringContaining('process 500 ended while it was stopped, so nothing listed under its number was stopped'),
      });
      expect(host.signals.filter(([, signal]) => signal !== 0)).toEqual([[500, 'SIGSTOP']]);
    });

    it('joins a stop of the same child that is under way, and a stop after it has settled is a new one', async () => {
      const child = nodeChild(41001);
      const taskkills: number[] = [];
      const releases: Array<(code: number | undefined) => void> = [];
      let alive = true;
      const deps: ProcessTreeTerminationDeps = {
        platform: 'win32', shutdown: new HostShutdown(),
        kill: () => { if (!alive) ESRCH(); },
        listProcesses: async () => [{ pid: 41001, ppid: 4 }],
        taskkill: (pid) => { taskkills.push(pid); return new Promise((resolve) => { releases.push(resolve); }); },
        ...instant,
      };
      const owner = terminateChildProcessTree(child, deps);
      const backstop = terminateChildProcessTree(child, deps);
      expect(backstop).toBe(owner);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(taskkills).toEqual([41001]);
      // taskkill could not run: the stop is unknown, and the child still runs.
      releases[0](undefined);
      expect(await owner).toMatchObject({ status: 'unknown', detail: expect.stringContaining('taskkill could not run') });

      const again = terminateChildProcessTree(child, deps);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(taskkills).toEqual([41001, 41001]);
      alive = false;
      releases[1](0);
      expect(await again).toEqual({ status: 'confirmed-stopped' });
    });
  });

  it('confirms that a real child and its nested child are gone on this platform', async () => {
    const nested = 'const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1000)';
    const child = spawn(process.execPath, ['-e', nested], { stdio: ['ignore', 'pipe', 'ignore'] });
    let confirmed = false;
    let nestedPid: number | undefined;
    try {
      nestedPid = await new Promise<number>((resolve, reject) => {
        let text = '';
        child.stdout!.on('data', (chunk) => {
          text += String(chunk);
          const line = text.match(/^(\d+)\r?\n/);
          if (line) resolve(Number(line[1]));
        });
        child.once('exit', () => reject(new Error('the child ended before it started its own child')));
      });
      const outcome = await terminateChildProcessTree(child);
      expect(outcome.status).toBe('confirmed-stopped');
      expect(() => process.kill(nestedPid!, 0)).toThrow();
      confirmed = true;
    } finally {
      // A failed stop must not leave the test's processes running. The root goes through its own handle, which
      // knows whether it ended; the nested child only when it still answers.
      if (!confirmed) {
        if (nestedPid) try { process.kill(nestedPid, 0); process.kill(nestedPid, 'SIGKILL'); } catch { /* gone */ }
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  }, 30_000);

  it('kills a host tool that runs past its limit and reads it as no result', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-host-tool-'));
    const pidFile = path.join(dir, 'pid');
    let pid: number | undefined;
    let gone = false;
    try {
      const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
      expect(await runHostTool(process.execPath, ['-e', script], 5_000)).toBeUndefined();
      pid = Number(await fs.readFile(pidFile, 'utf8'));
      for (let i = 0; i < 50 && !gone; i += 1) {
        try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 100)); } catch { gone = true; }
      }
      expect(gone).toBe(true);
      expect(await runHostTool(process.execPath, ['-e', 'console.log("12 3")'], OBSERVED_HOST_TOOL_TIMEOUT_MS))
        .toEqual({ code: 0, stdout: expect.stringMatching(/^12 3\r?\n$/) });
    } finally {
      if (pid && !gone) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
