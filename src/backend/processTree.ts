/*---------------------------------------------------------------------------------------------
 *  UnodeAi - processTree
 *  Kill a spawned command AND its descendants. A command string runs under a shell, so on Windows the
 *  child is `cmd.exe`; `child.kill()` terminates the shell but leaves the actual runner (npm/node/pytest)
 *  alive — a watch-mode or input-waiting command then orphans on a timeout. `taskkill /T /F` kills the
 *  whole tree. The first two functions are best-effort and never throw (Audit N2/N9); the CLI routes keep
 *  them. v0.9.96 adds the observed termination below, which reports whether the tree was seen to stop.
 *--------------------------------------------------------------------------------------------*/

import { spawn, ChildProcess } from 'child_process';
import { resolveHostExecutable } from '../security/HostExecutableResolver';

const PROCESS_TREE_KILL_TIMEOUT_MS = 5_000;
type HostExecutableResolver = (command: string) => string;

function killPidDirectly(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone / best effort */
  }
}

/**
 * Kill a process tree when the owner only has a PID (VS Code terminals expose no ChildProcess).
 * Unlike Terminal.dispose(), the Windows path deliberately waits for `taskkill /T` to finish before
 * its caller closes the terminal tab, so a nested shell cannot be orphaned when the root shell exits.
 */
export async function killProcessTreeByPid(pid: number, resolveExecutable: HostExecutableResolver = resolveHostExecutable): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) { return; }

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      let settled = false;
      let killer: ChildProcess | undefined;
      const finish = (fallback: boolean) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        if (fallback) { killPidDirectly(pid); }
        resolve();
      };
      const timer = setTimeout(() => {
        try { killer?.kill('SIGKILL'); } catch { /* best effort */ }
        finish(true);
      }, PROCESS_TREE_KILL_TIMEOUT_MS);
      try {
        killer = spawn(resolveExecutable('taskkill'), ['/pid', String(pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.once('error', () => finish(true));
        killer.once('exit', (code) => finish(code !== 0));
      } catch {
        finish(true);
      }
    });
    return;
  }

  // Terminal children may have their own process group, so killing only the shell (or only its group)
  // can leave a foreground nested shell alive. Snapshot the parent graph and kill leaves first.
  const descendants = await new Promise<number[]>((resolve) => {
    let output = '';
    let settled = false;
    let listing: ChildProcess | undefined;
    const finish = (rows: number[]) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      resolve(rows);
    };
    const timer = setTimeout(() => {
      try { listing?.kill('SIGKILL'); } catch { /* best effort */ }
      finish([]);
    }, PROCESS_TREE_KILL_TIMEOUT_MS);
    try {
      listing = spawn(resolveExecutable('ps'), ['-e', '-o', 'pid=', '-o', 'ppid='], { stdio: ['ignore', 'pipe', 'ignore'] });
      listing.stdout?.on('data', (chunk) => { output += String(chunk); });
      listing.once('error', () => finish([]));
      listing.once('close', (code) => {
        if (code !== 0) { finish([]); return; }
        const children = new Map<number, number[]>();
        for (const line of output.split(/\r?\n/)) {
          const match = line.trim().match(/^(\d+)\s+(\d+)$/);
          if (!match) { continue; }
          const child = Number(match[1]);
          const parent = Number(match[2]);
          const siblings = children.get(parent) ?? [];
          siblings.push(child);
          children.set(parent, siblings);
        }
        const rows: number[] = [];
        const visit = (parent: number) => {
          for (const child of children.get(parent) ?? []) {
            visit(child);
            rows.push(child);
          }
        };
        visit(pid);
        finish(rows);
      });
    } catch {
      finish([]);
    }
  });
  for (const childPid of descendants) { killPidDirectly(childPid); }
  killPidDirectly(pid);
}

export function killProcessTree(proc: ChildProcess, resolveExecutable: HostExecutableResolver = resolveHostExecutable): void {
  const pid = proc.pid;
  if (process.platform === 'win32' && pid !== undefined) {
    try {
      // /T = tree (kill children too), /F = force. `spawn` reports a missing taskkill asynchronously,
      // so fall back to the direct child only when taskkill could not run or reports failure. Killing
      // the shell immediately would race taskkill's tree enumeration and could orphan its children.
      const killer = spawn(resolveExecutable('taskkill'), ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
      const killDirectChild = () => {
        try { proc.kill('SIGKILL'); } catch { /* best effort */ }
      };
      killer.once('error', killDirectChild);
      killer.once('exit', (code) => {
        if (code !== 0) {
          killDirectChild();
        }
      });
      return;
    } catch {
      /* fall through to a plain kill */
    }
  }
  try {
    proc.kill('SIGKILL');
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------------------------
// v0.9.96: termination that reports what it observed
// ---------------------------------------------------------------------------------------------

/**
 * What a tree termination observed. Only `confirmed-stopped` and `already-stopped` let a caller treat the
 * process tree as gone; `unknown` means a captured process may still be running. v0.9.97: `already-stopped` says
 * only that the root had ended (or never ran) before the stop. Nothing of what that root started was observed, and a
 * process it started can outlive it; a caller that must know the whole tree is gone uses `treeSeenStopped`.
 */
export type ProcessTerminationOutcome =
  | { status: 'confirmed-stopped' | 'already-stopped' }
  | { status: 'unknown'; detail: string };

export const TERMINATION_CONFIRM_TIMEOUT_MS = 5_000;
const TERMINATION_POLL_MS = 100;
const POSIX_STABILIZE_ROUNDS = 5;
/**
 * How long each host tool of an observed termination (the process list, taskkill) may run. A loaded machine can
 * need several seconds just to start PowerShell. The best-effort paths above keep their own shorter limit.
 */
export const OBSERVED_HOST_TOOL_TIMEOUT_MS = 20_000;

/**
 * The host's shutdown, as a tree stop sees it. The editor ends the extension host a few seconds after it starts to
 * deactivate it, and the host's exit ends each of its direct children at once (Node puts them in a job object on
 * Windows). A descendant then has no root for `taskkill /T` to walk from, so it keeps running. Once the shutdown
 * begins, a stop therefore sends its kill before it lists anything on Windows, the POSIX listings of one stop, which
 * find the descendants to kill, share `SHUTDOWN_LISTING_BUDGET_MS`, and nothing waits to observe the result: the
 * outcome is `unknown`, never confirmed. A stop already waiting on a listing stops waiting when the shutdown begins.
 * No direct command starts once it has begun (`DirectChildRegistry`).
 */
export class HostShutdown {
  private begun = false;
  private readonly listeners = new Set<() => void>();
  get started(): boolean { return this.begun; }
  begin(): void {
    if (this.begun) return;
    this.begun = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) listener();
  }
  /** Call `listener` when the shutdown begins, at once if it has. Returns a function that forgets the listener. */
  onBegin(listener: () => void): () => void {
    if (this.begun) {
      listener();
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** The extension host's own shutdown. `deactivate()` begins it before it stops anything. */
export const hostShutdown = new HostShutdown();

/**
 * How long the POSIX listings of one stop may still take, all rounds together, once the host is shutting down. The
 * time is counted from when the stop first sees the shutdown; a round that starts later gets only what is left.
 */
export const SHUTDOWN_LISTING_BUDGET_MS = 1_000;

const NOT_OBSERVED_AT_SHUTDOWN = 'the host was shutting down, so the stop was sent and not observed';
const SHUTDOWN_CUT_LISTING = Symbol('the host began shutting down before the listing came back');

/**
 * The listing, unless the host begins to shut down first: then it gets only what `timeLeft()` says is left of the
 * stop's listing time, read when the shutdown is seen. The listing itself keeps running; its result is not used.
 */
function listUnlessShuttingDown(
  list: () => Promise<ProcessRow[] | undefined>,
  shutdown: HostShutdown,
  timeLeft: () => number,
): Promise<ProcessRow[] | undefined | typeof SHUTDOWN_CUT_LISTING> {
  // With no time left, nothing is started at all.
  if (shutdown.started && timeLeft() <= 0) return Promise.resolve(SHUTDOWN_CUT_LISTING);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forget: () => void = () => undefined;
    const finish = (value: ProcessRow[] | undefined | typeof SHUTDOWN_CUT_LISTING) => {
      if (settled) return;
      settled = true;
      forget();
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    forget = shutdown.onBegin(() => {
      const left = timeLeft();
      if (left <= 0) finish(SHUTDOWN_CUT_LISTING);
      else timer = setTimeout(() => finish(SHUTDOWN_CUT_LISTING), left);
    });
    list().then(finish, () => finish(undefined));
  });
}

/**
 * One listed process. `created` (Windows only: microseconds since 1970, UTC) tells a child from an older process
 * whose parent ended and whose parent's number now belongs to someone else: Windows keeps a process's parent number
 * after that parent ends, so csrss.exe, whose parent smss.exe always ends at sign-in, can list a just-started shell
 * as its parent.
 */
export interface ProcessRow { pid: number; ppid: number; created?: number }

/** True when `child` was created before the process now listed under its parent number: it is not that one's child. */
function olderThanParent(child: ProcessRow, parentCreated: number | undefined): boolean {
  return parentCreated !== undefined && child.created !== undefined && child.created < parentCreated;
}

/** What one host tool printed and how it exited, or undefined when it could not run or ran out of time. */
export type HostToolRun = (executable: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string } | undefined>;

/** The host facts a termination needs. Production uses the defaults; tests replace each one. */
export interface ProcessTreeTerminationDeps {
  platform?: NodeJS.Platform;
  resolveExecutable?: HostExecutableResolver;
  /** `process.kill`; signal 0 asks whether the process exists. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** One snapshot of every process with its parent, or undefined when the listing failed. */
  listProcesses?: () => Promise<ProcessRow[] | undefined>;
  /** Windows only: run `taskkill /pid <pid> /t /f`; resolve its exit code, or undefined when it could not run. */
  taskkill?: (pid: number) => Promise<number | undefined>;
  /** Runs the default process list and taskkill, each within `OBSERVED_HOST_TOOL_TIMEOUT_MS`. */
  runHostTool?: HostToolRun;
  /** The shutdown that changes the order of a stop; `hostShutdown` by default. */
  shutdown?: HostShutdown;
  /** `SHUTDOWN_LISTING_BUDGET_MS` by default: the listing time of one whole stop, shared by all its rounds. */
  shutdownListingBudgetMs?: number;
  /**
   * True once the root is known to have ended, after which its number may belong to another process. Set for a child
   * this host spawned: from then on the root is not signalled, listed from or passed to taskkill.
   */
  rootEnded?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  confirmTimeoutMs?: number;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}

type Liveness = 'alive' | 'gone' | 'unknown';

function liveness(kill: NonNullable<ProcessTreeTerminationDeps['kill']>, pid: number): Liveness {
  try {
    kill(pid, 0);
    return 'alive';
  } catch (error) {
    // ESRCH: no such process. EPERM means it exists but is not ours to signal: it cannot be confirmed stopped.
    return errorCode(error) === 'ESRCH' ? 'gone' : 'unknown';
  }
}

/**
 * Descendants of `root` in leaf-first order: every process comes before its parent. A process created before the
 * one listed under its parent number is not that one's child. When either time is missing the listed parent counts.
 */
export function descendantsLeafFirst(root: number, rows: readonly ProcessRow[]): number[] {
  const createdOf = new Map(rows.map((row) => [row.pid, row.created] as const));
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const { pid, ppid } = row;
    if (pid === ppid || olderThanParent(row, createdOf.get(ppid))) continue;
    const siblings = children.get(ppid) ?? [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const visit = (parent: number) => {
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      visit(child);
      out.push(child);
    }
  };
  visit(root);
  return out;
}

/** 1970-01-01 as a Windows FILETIME (100 ns steps since 1601). */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;

/** `<pid> <ppid>`, or on Windows `<pid> <ppid> <creation FILETIME | ->`. */
function parseRows(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)(?:\s+(\d+|-))?$/);
    if (!match) continue;
    const created = match[3] && match[3] !== '-' ? Number((BigInt(match[3]) - FILETIME_UNIX_EPOCH) / 10n) : undefined;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), ...(created !== undefined ? { created } : {}) });
  }
  return rows;
}

/** Run one host tool and collect its output; a tool still running after `timeoutMs` is killed and reads as undefined. */
export const runHostTool: HostToolRun = (executable, args, timeoutMs) => {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    let child: ChildProcess | undefined;
    const finish = (value: { code: number | null; stdout: string } | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch { /* best effort */ }
      finish(undefined);
    }, timeoutMs);
    try {
      child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.once('error', () => finish(undefined));
      child.once('close', (code) => finish({ code, stdout }));
    } catch {
      finish(undefined);
    }
  });
};

/**
 * Lists every process with its parent: a CIM query on Windows, with each creation time, and `ps` elsewhere. POSIX
 * gives an orphan a new parent, so its parent number never belongs to an older process.
 */
const WINDOWS_PROCESS_LIST_COMMAND = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { \'-\' })" }';

function defaultListProcesses(platform: NodeJS.Platform, resolveExecutable: HostExecutableResolver, run: HostToolRun): () => Promise<ProcessRow[] | undefined> {
  return async () => {
    let result: { code: number | null; stdout: string } | undefined;
    try {
      result = platform === 'win32'
        ? await run(resolveExecutable('powershell'), ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_LIST_COMMAND], OBSERVED_HOST_TOOL_TIMEOUT_MS)
        : await run(resolveExecutable('ps'), ['-e', '-o', 'pid=', '-o', 'ppid='], OBSERVED_HOST_TOOL_TIMEOUT_MS);
    } catch {
      return undefined;
    }
    return result && result.code === 0 ? parseRows(result.stdout) : undefined;
  };
}

function defaultTaskkill(resolveExecutable: HostExecutableResolver, run: HostToolRun): (pid: number) => Promise<number | undefined> {
  return async (pid) => {
    let executable: string;
    try {
      executable = resolveExecutable('taskkill');
    } catch {
      return undefined;
    }
    const result = await run(executable, ['/pid', String(pid), '/t', '/f'], OBSERVED_HOST_TOOL_TIMEOUT_MS);
    return result ? result.code ?? undefined : undefined;
  };
}

/**
 * Terminate a process tree by its root PID and report what was observed. The tree is captured BEFORE anything is
 * killed, and the result is `confirmed-stopped` only when every captured process is then seen to be gone. A
 * process that detached from the tree before the snapshot is outside what this can observe, on every platform.
 *
 * Windows: snapshot, `taskkill /T /F`, then poll every captured PID. The snapshot follows a parent number only to a
 * process created after that parent, so an older process whose own parent ended is never captured. Exit 0 from
 * taskkill alone is not confirmation. A non-zero exit is not proof that anything still runs either: taskkill reports one when a captured
 * process ended on its own before it got there, as `cmd.exe` does once its only child is stopped. So after every
 * captured PID is seen gone, a second listing decides: the stop is confirmed only when that listing is readable and
 * shows no captured PID and no child of one. The second listing only observes; it stops nothing and clears no
 * other problem. A descendant started after the first snapshot whose own parent has also ended appears in neither
 * listing, so it is outside what this observes.
 *
 * POSIX: stop the root, keep snapshotting and stopping new descendants until the set is stable, kill leaf-first
 * and then the root, then poll every captured PID until each reports ESRCH.
 *
 * Once the host is shutting down (`HostShutdown`), a Windows stop runs taskkill without listing first, the POSIX
 * listings of the stop share one short budget, and the stop returns after the kill as `unknown`, without observing.
 *
 * With `rootEnded`, a root seen to end is never a target again, because its number may already be another process's:
 * one that ended before the stop is `already-stopped`, as a gone root is, and one that ends during the stop is not
 * passed to taskkill, not listed from and not killed.
 */
export async function terminateProcessTreeObserved(pid: number, deps: ProcessTreeTerminationDeps = {}): Promise<ProcessTerminationOutcome> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'unknown', detail: 'the process has no valid id' };
  const platform = deps.platform ?? process.platform;
  const resolveExecutable = deps.resolveExecutable ?? resolveHostExecutable;
  const kill = deps.kill ?? ((target: number, signal: NodeJS.Signals | 0) => { process.kill(target, signal); });
  const run = deps.runHostTool ?? runHostTool;
  const listProcesses = deps.listProcesses ?? defaultListProcesses(platform, resolveExecutable, run);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? TERMINATION_CONFIRM_TIMEOUT_MS;
  const shutdown = deps.shutdown ?? hostShutdown;
  const shutdownListingBudgetMs = deps.shutdownListingBudgetMs ?? SHUTDOWN_LISTING_BUDGET_MS;
  const rootEnded = deps.rootEnded ?? (() => false);
  /** Set when this stop first sees the shutdown; every listing round after that gets only what is left of it. */
  let shutdownListingDeadline: number | undefined;
  const shutdownListingTimeLeft = (): number => {
    if (shutdownListingDeadline === undefined) shutdownListingDeadline = now() + shutdownListingBudgetMs;
    return shutdownListingDeadline - now();
  };

  if (rootEnded()) return { status: 'already-stopped' };
  const rootState = liveness(kill, pid);
  if (rootState === 'gone') return { status: 'already-stopped' };
  if (rootState === 'unknown') return { status: 'unknown', detail: `process ${pid} cannot be signalled` };

  const problems: string[] = [];
  const captured = new Set<number>([pid]);
  let taskkillFailure: string | undefined;
  /** When each captured process was created, as the first Windows listing showed it. */
  const createdOf = new Map<number, number | undefined>();
  if (platform === 'win32') {
    // At shutdown taskkill walks the tree itself, while the root still lives; a listing first could outlast the host.
    const listed = await listUnlessShuttingDown(listProcesses, shutdown, () => 0);
    const rows = listed === SHUTDOWN_CUT_LISTING ? undefined : listed;
    if (listed === undefined) problems.push('the process list could not be read');
    for (const child of rows ? descendantsLeafFirst(pid, rows) : []) captured.add(child);
    for (const row of rows ?? []) if (captured.has(row.pid)) createdOf.set(row.pid, row.created);
    if (rootEnded()) {
      // It ended while it was listed. Whether its tree is gone is left to the poll and the second listing, as after
      // a taskkill that failed.
      taskkillFailure = `process ${pid} ended before taskkill ran, so taskkill was not run`;
    } else {
      const taskkill = deps.taskkill ?? defaultTaskkill(resolveExecutable, run);
      const code = await taskkill(pid);
      if (code === undefined) problems.push('taskkill could not run');
      else if (code !== 0) taskkillFailure = `taskkill exited ${code}`;
    }
  } else {
    const signalOne = (target: number, signal: NodeJS.Signals) => {
      try {
        kill(target, signal);
      } catch (error) {
        if (errorCode(error) !== 'ESRCH') problems.push(`process ${target} could not be signalled`);
      }
    };
    signalOne(pid, 'SIGSTOP');
    let order: number[] = [];
    let stable = false;
    let listed = true;
    for (let round = 0; round < POSIX_STABILIZE_ROUNDS; round += 1) {
      const rows = await listUnlessShuttingDown(listProcesses, shutdown, shutdownListingTimeLeft);
      if (rows === SHUTDOWN_CUT_LISTING) {
        listed = false;
        problems.push('the host began shutting down before the process list came back, so descendants not yet listed were not stopped');
        break;
      }
      if (!rows) {
        listed = false;
        problems.push('the process list could not be read');
        break;
      }
      if (rootEnded()) {
        // The processes listed under its number may be another process's children.
        listed = false;
        problems.push(`process ${pid} ended while it was stopped, so nothing listed under its number was stopped`);
        break;
      }
      order = descendantsLeafFirst(pid, rows);
      const fresh = order.filter((child) => !captured.has(child));
      if (fresh.length === 0) {
        stable = true;
        break;
      }
      for (const child of fresh) {
        captured.add(child);
        signalOne(child, 'SIGSTOP');
      }
    }
    if (listed && !stable) problems.push('the process tree kept changing');
    // Leaf-first from the last snapshot, then anything captured earlier, then the root.
    const leafFirst = [...new Set([...order, ...[...captured].filter((child) => child !== pid)])];
    for (const child of leafFirst) signalOne(child, 'SIGKILL');
    if (!rootEnded()) signalOne(pid, 'SIGKILL');
  }

  const deadline = now() + confirmTimeoutMs;
  let remaining = [...captured];
  for (;;) {
    // The kill is sent. At shutdown nothing waits to watch it, and nothing seen is taken as proof.
    if (shutdown.started) {
      problems.push(NOT_OBSERVED_AT_SHUTDOWN);
      break;
    }
    const states = remaining.map((target) => [target, liveness(kill, target)] as const);
    const unknown = states.find(([, state]) => state === 'unknown');
    if (unknown) {
      problems.push(`process ${unknown[0]} cannot be signalled`);
      break;
    }
    remaining = states.filter(([, state]) => state === 'alive').map(([target]) => target);
    if (remaining.length === 0) break;
    if (now() >= deadline) {
      problems.push(`process ${remaining[0]} was still running`);
      break;
    }
    await sleep(TERMINATION_POLL_MS);
  }
  if (taskkillFailure !== undefined) {
    if (problems.length > 0) {
      problems.push(taskkillFailure);
    } else {
      const after = await listProcesses();
      // A captured number now held by a process of another creation time is someone else's; so is an older process
      // that lists a captured number as its parent.
      const stillCaptured = (row: ProcessRow) => captured.has(row.pid)
        && !(createdOf.get(row.pid) !== undefined && row.created !== undefined && row.created !== createdOf.get(row.pid));
      const childOfCaptured = (row: ProcessRow) => captured.has(row.ppid) && !olderThanParent(row, createdOf.get(row.ppid));
      const left = after?.find((row) => row.pid !== row.ppid && (stillCaptured(row) || childOfCaptured(row)));
      if (!after) problems.push(`${taskkillFailure}, and the process list could not be read again`);
      else if (left && stillCaptured(left)) problems.push(`${taskkillFailure}, and process ${left.pid} is listed again`);
      else if (left) problems.push(`${taskkillFailure}, and process ${left.pid}, a child of process ${left.ppid}, is still running`);
    }
  }
  return problems.length ? { status: 'unknown', detail: problems.join('; ') } : { status: 'confirmed-stopped' };
}

/** True once Node has seen the child end. From then on its number may belong to another process. */
function childEnded(proc: ChildProcess): boolean {
  return typeof proc.exitCode === 'number' || typeof proc.signalCode === 'string';
}

/** Each child's termination while it is under way. */
const childTerminations = new WeakMap<ChildProcess, Promise<ProcessTerminationOutcome>>();

/**
 * The same observed termination for a child this host spawned. A child that never got a PID never ran. The child's
 * number is used only until Node sees the child end (`rootEnded`), so a number already given to another process is
 * never a target. A second stop of the same child while one is under way, its owner's and the host's at shutdown,
 * joins that one and sends nothing of its own.
 */
export function terminateChildProcessTree(proc: ChildProcess, deps: ProcessTreeTerminationDeps = {}): Promise<ProcessTerminationOutcome> {
  if (proc.pid === undefined) return Promise.resolve({ status: 'already-stopped' });
  const underWay = childTerminations.get(proc);
  if (underWay) return underWay;
  const terminating = terminateProcessTreeObserved(proc.pid, { ...deps, rootEnded: () => childEnded(proc) });
  childTerminations.set(proc, terminating);
  const settled = () => { if (childTerminations.get(proc) === terminating) childTerminations.delete(proc); };
  terminating.then(settled, settled);
  return terminating;
}

export function terminationConfirmed(outcome: ProcessTerminationOutcome): boolean {
  return outcome.status === 'confirmed-stopped' || outcome.status === 'already-stopped';
}

/**
 * v0.9.97: true only when the stop found the root still running, captured what it had started and saw all of it end.
 * A root that had already ended is not that: once Node has seen it end, its number may be another process's, so
 * nothing is listed or signalled under it, and what it started is out of reach.
 */
export function treeSeenStopped(outcome: ProcessTerminationOutcome): boolean {
  return outcome.status === 'confirmed-stopped';
}
