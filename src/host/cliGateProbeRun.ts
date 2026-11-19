/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the bounded runs of a CLI compatibility check (v0.9.97)
 *  A check starts the chosen program a few times with no model request: 20 s and 64 KiB of output for all of its runs
 *  together. A program that is still running at the end of its check is stopped as a whole tree while it still runs,
 *  and its input is not ended first: a program that exits when its input ends would take the processes it started
 *  out of reach. The check reports its stop as confirmed only when the stop found the program running and saw every
 *  process of its tree end. A program that had already ended is no proof about what it started.
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { terminateChildProcessTree, treeSeenStopped, type ProcessTerminationOutcome } from '../backend/processTree';

export const GATE_PROBE_LIMITS = Object.freeze({
  /** All runs of one check together. */
  timeoutMs: 20_000,
  /** Standard output and error of all runs of one check together. */
  outputBytes: 64 * 1024,
});

/** The outcome of one compatibility check. `stop-unconfirmed`: a process of the check may still be running. */
export type GateProbeResult =
  | { result: 'pass'; versionOutput: string; startedAt: string; durationMs: number }
  | { result: 'fail' | 'stop-unconfirmed'; detail: string; versionOutput?: string; startedAt: string; durationMs: number };

export type GateProbeStep = 'version' | 'login-status' | 'app-server' | 'session';

export type GateProbeSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface GateProbeDeps {
  spawn?: GateProbeSpawn;
  /** `terminateChildProcessTree` by default. */
  terminateTree?: (proc: ChildProcess) => Promise<ProcessTerminationOutcome>;
  /** Monotonic milliseconds for the bounds. */
  now?: () => number;
  /** The wall clock for `startedAt`. */
  clock?: () => Date;
  timeoutMs?: number;
  outputLimitBytes?: number;
  /** Called right after each process of the check is spawned, with its number. A check's last spawn is its final step. */
  onSpawned?: (pid: number, step: GateProbeStep) => void;
}

/** A check's end before its last step: a failure, or a stop that was not confirmed. */
export class GateProbeStop extends Error {
  constructor(readonly outcome: 'fail' | 'stop-unconfirmed', detail: string) {
    super(detail);
  }
}

const ENDED_BEFORE_STOP = 'the program had already ended before the stop, so the processes it started could not be observed';

/** One check's shared bounds and spawner. */
export class GateProbeRun {
  readonly now: () => number;
  readonly startedAt: string;
  private readonly started: number;
  private readonly deadline: number;
  private outputLeft: number;
  readonly spawn: GateProbeSpawn;
  readonly terminateTree: (proc: ChildProcess) => Promise<ProcessTerminationOutcome>;
  readonly limits: { timeoutMs: number; outputBytes: number };

  constructor(private readonly deps: GateProbeDeps) {
    this.now = deps.now ?? (() => performance.now());
    this.started = this.now();
    this.startedAt = (deps.clock?.() ?? new Date()).toISOString();
    this.limits = { timeoutMs: deps.timeoutMs ?? GATE_PROBE_LIMITS.timeoutMs, outputBytes: deps.outputLimitBytes ?? GATE_PROBE_LIMITS.outputBytes };
    this.deadline = this.started + this.limits.timeoutMs;
    this.outputLeft = this.limits.outputBytes;
    this.spawn = deps.spawn ?? ((command, args, options) => nodeSpawn(command, [...args], options));
    this.terminateTree = deps.terminateTree ?? terminateChildProcessTree;
  }

  elapsedMs(): number { return Math.max(0, Math.round(this.now() - this.started)); }
  remainingMs(): number { return Math.max(0, this.deadline - this.now()); }

  /** Counts output against the check's budget; false once the budget is spent. */
  takeOutput(bytes: number): boolean {
    this.outputLeft -= bytes;
    return this.outputLeft >= 0;
  }

  spawned(proc: ChildProcess, step: GateProbeStep): void {
    if (proc.pid !== undefined) this.deps.onSpawned?.(proc.pid, step);
  }

  timeoutText(): string { return `the check did not finish within ${Math.round(this.limits.timeoutMs / 1000)} seconds`; }
  outputText(): string { return `the program printed more than ${Math.round(this.limits.outputBytes / 1024)} KiB`; }

  /**
   * Stops `proc`'s tree while it still runs, then ends its input. Undefined when the stop was confirmed; otherwise
   * what was not seen. A process that never got a number never ran.
   */
  async stop(proc: ChildProcess): Promise<string | undefined> {
    if (proc.pid === undefined) return undefined;
    let outcome: ProcessTerminationOutcome;
    try {
      outcome = await this.terminateTree(proc);
    } catch (error) {
      outcome = { status: 'unknown', detail: bounded(error instanceof Error ? error.message : String(error)) };
    }
    try { proc.stdin?.end(); } catch { /* already closed */ }
    if (treeSeenStopped(outcome)) return undefined;
    return outcome.status === 'unknown' ? outcome.detail : ENDED_BEFORE_STOP;
  }

  result(failure: string | undefined, unconfirmed: string | undefined, versionOutput: string | undefined): GateProbeResult {
    const base = { startedAt: this.startedAt, durationMs: this.elapsedMs(), ...(versionOutput !== undefined ? { versionOutput } : {}) };
    if (unconfirmed !== undefined) {
      const detail = `UnodeAi could not confirm that the check's process stopped (${unconfirmed})${failure ? `; ${failure}` : ''}`;
      return { result: 'stop-unconfirmed', detail: bounded(detail), ...base };
    }
    if (failure !== undefined) return { result: 'fail', detail: bounded(failure), ...base };
    return { result: 'pass', ...base, versionOutput: versionOutput ?? '' };
  }

  failed(error: unknown, versionOutput: string | undefined): GateProbeResult {
    if (error instanceof GateProbeStop) {
      return error.outcome === 'stop-unconfirmed'
        ? { result: 'stop-unconfirmed', detail: bounded(error.message), startedAt: this.startedAt, durationMs: this.elapsedMs(), ...(versionOutput !== undefined ? { versionOutput } : {}) }
        : this.result(error.message, undefined, versionOutput);
    }
    return this.result(error instanceof Error ? error.message : String(error), undefined, versionOutput);
  }
}

export interface RunToExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  /** Standard output and error, trimmed, as the existing preflight reads them. */
  output: string;
}

/**
 * One run of the program that ends by itself (`--version`, `login status`), within what is left of the check. A run
 * that outlasts the check or prints past its budget is stopped as a tree; the check then ends with `GateProbeStop`.
 */
export function runToExit(
  run: GateProbeRun,
  step: GateProbeStep,
  executable: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; shell?: boolean },
): Promise<RunToExitResult> {
  return new Promise((resolve, reject) => {
    if (options.shell && /["\r\n%]/.test(executable)) {
      reject(new GateProbeStop('fail', 'the program path is not safe to start through cmd.exe'));
      return;
    }
    let proc: ChildProcess;
    try {
      proc = run.spawn(options.shell ? `"${executable}"` : executable, args, {
        cwd: options.cwd, env: options.env, shell: options.shell === true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new GateProbeStop('fail', `the program could not be started (${bounded(String(error))})`));
      return;
    }
    run.spawned(proc, step);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      complete();
    };
    const stopWith = (reason: string) => finish(() => {
      void run.stop(proc).then((unconfirmed) => reject(unconfirmed === undefined
        ? new GateProbeStop('fail', reason)
        : new GateProbeStop('stop-unconfirmed', `UnodeAi could not confirm that the check's process stopped (${unconfirmed}); ${reason}`)));
    });
    const timer = setTimeout(() => stopWith(run.timeoutText()), run.remainingMs());
    const take = (chunk: Buffer, into: 'stdout' | 'stderr') => {
      if (settled) return;
      if (!run.takeOutput(chunk.length)) { stopWith(run.outputText()); return; }
      if (into === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    proc.stdout?.on('data', (chunk: Buffer) => take(chunk, 'stdout'));
    proc.stderr?.on('data', (chunk: Buffer) => take(chunk, 'stderr'));
    proc.once('error', (error) => finish(() => reject(new GateProbeStop('fail', `the program could not be started (${bounded(error.message)})`))));
    // 'exit' does not guarantee the pipes have drained; 'close' does.
    proc.once('close', (code, signal) => finish(() => resolve({ code, signal, stdout, output: `${stdout}${stderr}`.trim() })));
  });
}

export function bounded(text: string, limit = 600): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
