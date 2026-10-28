/*---------------------------------------------------------------------------------------------
 *  UnodeAi - CommandExecution (v0.9.96)
 *  The typed contract between a command's host gates and whatever executes it. A command is prepared first
 *  (shell identity, working directory, per-agent ownership), gated under that identity, and then executed
 *  at most once through the same preparation. vscode-free.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcess } from 'child_process';
import * as path from 'path';
import type { CommandOutputCapture } from './BoundedCommandOutput';
import type { CommandShellIdentity } from './CommandShell';
import type { ProcessTerminationOutcome } from './processTree';

/** The same execution, not a replay in another shell. Ownership passes to the existing background registry. */
export interface ContinuingCommand {
  readonly completion: Promise<CommandExecResult>;
  output(): string;
  stop(): Promise<ProcessTerminationOutcome>;
}

/** Why a prepared command did not start. None of these is evidence about the command itself. */
export type CommandNotStartedReason = 'environment-changed' | 'spawn-failed' | 'disposed';

/** Why the host cannot say what a started command did. Effects may have occurred. */
export type CommandOutcomeUnknownReason = 'terminal-died' | 'exit-unreported' | 'cwd-changed-after-start' | 'stop-unconfirmed';

interface CommandOutputFields {
  /** The host's note, if any, then the command's output within the model ceiling. */
  output: string;
  /** The bounded head and tail of the command's own output, when the transport kept one. */
  capture?: CommandOutputCapture;
  /** A host-written explanation that is not command output, e.g. why the outcome is unknown. */
  note?: string;
}

export type CommandExecResult =
  | ({ status: 'running'; code: null; continuation: ContinuingCommand } & CommandOutputFields)
  | ({ status: 'exited'; code: number | null } & CommandOutputFields)
  | ({ status: 'timed-out'; code: null; stopConfirmed: true } & CommandOutputFields)
  | ({ status: 'not-started'; code: null; reason: CommandNotStartedReason } & CommandOutputFields)
  | ({ status: 'outcome-unknown'; code: null; reason: CommandOutcomeUnknownReason } & CommandOutputFields);

export interface CommandPreparationFailure {
  readonly ok: false;
  readonly reason: 'shell-compatibility' | 'cwd-unverified' | 'disposed';
  readonly message: string;
}

export interface PreparedCommandExecution {
  readonly ok: true;
  readonly shell: CommandShellIdentity;
  readonly transport: 'terminal' | 'direct';
  /** A truthful notice for the approval card and the result, e.g. why the direct fallback is used. */
  readonly notice?: string;
  /** Aborted by agent removal, restart or host disposal before or during the one-shot execution. */
  readonly signal: AbortSignal;
  /** One shot. A second call returns `not-started/disposed`; it never replays the command. */
  execute(command: string, timeoutMs: number, continueOnTimeout?: boolean): Promise<CommandExecResult>;
  /** Idempotent. Releases the per-agent lane after any cleanup the execution still owes. */
  release(): Promise<void>;
}

/** A background stop that could not be confirmed, for the owner of the agent to report. */
export interface UnconfirmedBackgroundStop {
  readonly id: string;
  readonly command: string;
  readonly detail: string;
}

/**
 * A host condition checked at every point where preparing or running a command would start something: before a
 * terminal is created, before each probe, after every wait, and immediately before the command itself. A refusal
 * means not run.
 */
export type StartRefusal = () => CommandPreparationFailure | undefined;

export const ALREADY_USED_MESSAGE = 'Command not run: this prepared command was already used.';

/** The not-started result of a refusal: a lifecycle reset is `disposed`, anything else an environment change. */
export function notStartedBy(refused: CommandPreparationFailure): CommandExecResult {
  return { status: 'not-started', code: null, reason: refused.reason === 'disposed' ? 'disposed' : 'environment-changed', output: refused.message };
}

export interface CommandExecutionProvider {
  /**
   * `startRefusal`: checked by the provider at every side-effect boundary of the prepared execution, after its
   * approval as well as before it.
   */
  acquire(opts: { cwd: string; startRefusal?: StartRefusal }): Promise<PreparedCommandExecution | CommandPreparationFailure>;
  /** The declared direct shell of this provider, for a background command that runs outside any lane. */
  prepareDirect?: PrepareDirectCommand;
  /** Told about every background command whose stop could not be confirmed when its session was torn down. */
  reportUnconfirmedStops?(stops: readonly UnconfirmedBackgroundStop[]): void;
}

export type BackgroundStart =
  | { ok: true; process: ChildProcess }
  /** `notStarted`: a host condition refused the start before any process existed. */
  | { ok: false; error: string; notStarted?: CommandPreparationFailure };

/** A command prepared for the host's explicit direct shell, used where no visible terminal is involved. */
export interface PreparedDirectCommand {
  readonly ok: true;
  readonly shell: CommandShellIdentity;
  execute(command: string, opts: { cwd: string; timeoutMs?: number; maxOutputChars?: number; signal?: AbortSignal; continueOnTimeout?: boolean }): Promise<CommandExecResult>;
  startBackground(command: string, opts: { cwd: string }): BackgroundStart;
}

export type PrepareDirectCommand = () => PreparedDirectCommand | CommandPreparationFailure;

/**
 * A direct command whose host conditions are checked again at the moment it would start: after its preparation,
 * the gate and an approval may have waited, and a lane may meanwhile have been reset, or the workspace distrusted.
 * A refused start creates no process. The wrapper is one-shot across `execute` and `startBackground` on its own: its
 * first call consumes it, whether it starts or is refused, so a refused command can only run again through a new
 * preparation, gate and approval.
 */
export function guardDirectCommand(prepared: PreparedDirectCommand, refusal: StartRefusal): PreparedDirectCommand {
  let used = false;
  const consume = (): CommandPreparationFailure | undefined => {
    if (used) return { ok: false, reason: 'disposed', message: ALREADY_USED_MESSAGE };
    used = true;
    return refusal();
  };
  return {
    ok: true,
    shell: prepared.shell,
    execute: async (command, opts) => {
      const refused = consume();
      return refused ? notStartedBy(refused) : prepared.execute(command, opts);
    },
    startBackground: (command, opts) => {
      const refused = consume();
      return refused ? { ok: false, error: refused.message, notStarted: refused } : prepared.startBackground(command, opts);
    },
  };
}

/** The refusal of an agent's lane state, for a command that runs beside the lane but never past its reset. */
export function laneStartRefusal(lane: ExecutionLane): CommandPreparationFailure | undefined {
  return lane.state === 'open' ? undefined : { ok: false, reason: 'disposed', message: LANE_DISPOSED_MESSAGE };
}

/** One terminal or direct lane: whether a started command may be counted as run. */
export function commandWasAttempted(result: CommandExecResult): boolean {
  return result.status !== 'not-started';
}

/** A result that carries a concrete exit code the process reported. */
export function exitedWithCode(result: CommandExecResult): result is Extract<CommandExecResult, { status: 'exited' }> & { code: number } {
  return result.status === 'exited' && typeof result.code === 'number';
}

// ---------------------------------------------------------------------------------------------
// The per-agent foreground lane
// ---------------------------------------------------------------------------------------------

/**
 * v0.9.99: a stop that could not be confirmed no longer refuses this agent's later commands. UnodeAi has already
 * requested the process-tree stop and closed the terminal; the next command runs in a fresh terminal or process. The
 * command itself is never run again, and the result says that it may still be running and may have had effects.
 */
export const TIMEOUT_STOP_UNCONFIRMED_MESSAGE = 'Command timed out. UnodeAi requested a stop of its process tree but '
  + 'could not confirm that it stopped, so it may still be running and may have had effects. It was not run again. '
  + "This agent's next command still runs, in a new terminal or process. If an old process is still running, end it "
  + 'before you run something that depends on it.';

export const STOP_UNCONFIRMED_MESSAGE = 'UnodeAi stopped this command but could not confirm that its process tree '
  + "stopped, so it may still be running and may have had effects. It was not run again. This agent's next command "
  + 'still runs, in a new terminal or process. If an old process is still running, end it before you run something '
  + 'that depends on it.';

export const LANE_DISPOSED_MESSAGE = 'Command not run: the agent was stopped, restarted or removed before the command started.';

/** No command starts once the host has begun to shut down, however long ago it was prepared or approved. */
export const HOST_SHUTTING_DOWN_MESSAGE = 'Command not run: the window is closing or reloading.';

export type LanePhase = 'queued' | 'preparing' | 'awaiting-approval' | 'running' | 'stopping';

/** One invocation's ownership of its agent's lane. */
export interface LaneTicket {
  /** Aborted by the lane's lifecycle reset. A ticket that has not started running must not start. */
  readonly signal: AbortSignal;
  setPhase(phase: Exclude<LanePhase, 'queued'>): void;
  /** Idempotent. The next queued invocation may start only after this. */
  release(): void;
}

interface LaneEntry {
  readonly abort: AbortController;
  phase: LanePhase;
  readonly done: Promise<void>;
  release(): void;
}

function untilSettledOrAborted(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    previous.catch(() => undefined).then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

/**
 * One agent's foreground commands, strictly one after another. An invocation takes the lane before its shell and
 * folder are prepared and keeps it through approval, execution, timeout grace and cleanup, so a later command of
 * the same agent cannot begin while an earlier one may still run. Other agents have lanes of their own.
 *
 * Each ticket chains behind the previous one with `previous.catch(() => undefined)`, so a thrown or rejected
 * earlier preparation cannot poison later work, and a ticket rechecks the generation after its wait, so nothing
 * queued before a lifecycle reset can start after it.
 */
export class ExecutionLane {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;
  private stateValue: 'open' | 'disposing' | 'closed' = 'open';
  private readonly entries = new Set<LaneEntry>();

  get state(): 'open' | 'disposing' | 'closed' {
    return this.stateValue;
  }

  /** True while any invocation holds or waits for the lane. */
  get busy(): boolean {
    return this.entries.size > 0;
  }

  async enter(): Promise<LaneTicket | CommandPreparationFailure> {
    const refusal = this.refusal();
    if (refusal) return refusal;
    const generation = this.generation;
    const abort = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    let released = false;
    const entry: LaneEntry = {
      abort,
      phase: 'queued',
      done,
      release: () => {
        if (released) return;
        released = true;
        this.entries.delete(entry);
        resolveDone();
      },
    };
    this.entries.add(entry);
    const previous = this.tail;
    this.tail = previous.catch(() => undefined).then(() => done);
    await untilSettledOrAborted(previous, abort.signal);
    if (abort.signal.aborted || this.generation !== generation || this.stateValue !== 'open') {
      const failure = this.generation === generation ? this.refusal() : undefined;
      entry.release();
      return failure ?? { ok: false, reason: 'disposed', message: LANE_DISPOSED_MESSAGE };
    }
    entry.phase = 'preparing';
    return {
      signal: abort.signal,
      setPhase: (phase) => { if (!released) entry.phase = phase; },
      release: entry.release,
    };
  }

  /**
   * The explicit lifecycle reset: agent removal, restart or host disposal. Queued, preparing and approval-waiting
   * invocations are aborted and released at once; the reset waits only for one that already crossed into
   * execution, whose own stop path is bounded. The lane is closed afterwards: its owner starts a new lane.
   */
  async close(): Promise<void> {
    if (this.stateValue === 'closed') return;
    this.stateValue = 'disposing';
    this.generation += 1;
    const running: Promise<void>[] = [];
    for (const entry of [...this.entries]) {
      entry.abort.abort();
      if (entry.phase === 'running' || entry.phase === 'stopping') running.push(entry.done);
      else entry.release();
    }
    await Promise.all(running);
    this.stateValue = 'closed';
  }

  private refusal(): CommandPreparationFailure | undefined {
    if (this.stateValue !== 'open') return { ok: false, reason: 'disposed', message: LANE_DISPOSED_MESSAGE };
    return undefined;
  }
}

/**
 * Whether a shell reports the same physical directory the host authorised. Both paths are resolved through
 * `realpath`, so a Windows drive-letter spelling or a symlink/junction spelling of the same folder matches, and a
 * missing, unreadable or relative path never does. `pathFlavor` selects the path semantics.
 */
export async function sameExecutionDirectory(
  expected: string,
  reported: string | undefined,
  pathFlavor: 'win32' | 'posix',
  realpath: (candidate: string) => Promise<string>,
): Promise<boolean> {
  if (!expected || !reported) return false;
  const api = pathFlavor === 'win32' ? path.win32 : path.posix;
  if (!api.isAbsolute(expected) || !api.isAbsolute(reported)) return false;
  let physicalExpected: string;
  let physicalReported: string;
  try {
    [physicalExpected, physicalReported] = await Promise.all([realpath(expected), realpath(reported)]);
  } catch {
    return false;
  }
  const normalize = (candidate: string) => {
    const resolved = api.resolve(candidate).replace(/[\\/]+$/, '');
    return pathFlavor === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(physicalExpected) === normalize(physicalReported);
}
