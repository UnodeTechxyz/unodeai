/*---------------------------------------------------------------------------------------------
 *  UnodeAi - DirectCommandExecution (v0.9.96)
 *  The host's declared direct shell, for every command string that does not run in a visible terminal:
 *  the foreground fallback, background commands, coordinator run_checks, the worktree verifier and the
 *  completion gate. The shell is resolved ONCE per preparation, as an absolute host executable, and the same
 *  preparation is gated and executed: Node receives it as its `shell` option and never `shell: true`.
 *
 *  Windows: cmd.exe admitted by the host executable resolver (ComSpec is only a candidate).
 *  macOS/Linux: /bin/sh. vscode-free.
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process';
import * as path from 'path';
import { BoundedCommandOutput, COMMAND_OUTPUT_MAX_CHARS } from './BoundedCommandOutput';
import type {
  CommandExecResult,
  CommandExecutionProvider,
  CommandPreparationFailure,
  PrepareDirectCommand,
  PreparedCommandExecution,
  PreparedDirectCommand,
} from './CommandExecution';
import {
  ExecutionLane,
  guardDirectCommand,
  HOST_SHUTTING_DOWN_MESSAGE,
  laneStartRefusal,
  notStartedBy,
  STOP_UNCONFIRMED_MESSAGE,
  TIMEOUT_STOP_UNCONFIRMED_MESSAGE,
} from './CommandExecution';
import { type DirectCommandShell, declaredDirectShellIdentity } from './CommandShell';
import { sanitizedCommandEnv, spawnCwd } from './commandEnv';
import {
  type HostShutdown,
  hostShutdown,
  type ProcessTerminationOutcome,
  TERMINATION_CONFIRM_TIMEOUT_MS,
  terminateChildProcessTree,
  terminationConfirmed,
} from './processTree';
import { resolveHostExecutable } from '../security/HostExecutableResolver';

/** The default wall clock of a direct foreground command when the caller gives none. */
export const DIRECT_COMMAND_DEFAULT_TIMEOUT_MS = 120_000;

const HOST_SHUTTING_DOWN: CommandPreparationFailure = { ok: false, reason: 'disposed', message: HOST_SHUTTING_DOWN_MESSAGE };

/**
 * Every direct child of this host that has not closed: foreground and background commands, checks and the verifier,
 * whoever started them. When the host shuts down it stops them all here and waits for each stop, because a stop
 * that one of their owners started may have nobody waiting for it. Every direct child starts here, and none starts
 * once the shutdown has begun, so the stop at shutdown sees them all.
 */
export class DirectChildRegistry {
  private readonly live = new Set<ChildProcess>();
  constructor(private readonly shutdown: HostShutdown = hostShutdown) {}
  get size(): number { return this.live.size; }
  /** Start one child and keep it until it closes; once the host has begun to shut down, start nothing (undefined). */
  start(startChild: () => ChildProcess): ChildProcess | undefined {
    if (this.shutdown.started) return undefined;
    const proc = startChild();
    this.live.add(proc);
    const forget = () => { this.live.delete(proc); };
    proc.once('close', forget);
    // A child that failed to start never closes.
    proc.once('error', () => { if (proc.pid === undefined) forget(); });
    return proc;
  }
  /**
   * Stop every live child at once and wait until each stop has settled. A child that is kept after this began, which
   * the closed start should rule out, is stopped too before this returns.
   */
  async stopAll(terminate: (proc: ChildProcess) => Promise<unknown> = (proc) => terminateChildProcessTree(proc)): Promise<void> {
    const sent = new Set<ChildProcess>();
    for (;;) {
      const fresh = [...this.live].filter((proc) => !sent.has(proc));
      if (fresh.length === 0) return;
      for (const proc of fresh) sent.add(proc);
      await Promise.allSettled(fresh.map(async (proc) => terminate(proc)));
    }
  }
}

/** This host's direct children. */
export const directChildren = new DirectChildRegistry();

export interface DirectShellResolutionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Resolve a host executable, refusing one inside a workspace or worktree. */
  resolveExecutable?: (program: string) => string;
}

/**
 * Resolve the declared direct shell as an absolute host executable. A ComSpec value is only a candidate: it must
 * name cmd.exe and still pass the resolver. When nothing resolves, the command is refused; no other interpreter
 * is borrowed and `shell: true` is never used.
 */
export function resolveDeclaredDirectShell(options: DirectShellResolutionOptions = {}): DirectCommandShell | CommandPreparationFailure {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const resolve = options.resolveExecutable ?? ((program: string) => resolveHostExecutable(program, { env, platform }));
  const identity = declaredDirectShellIdentity(platform);
  const refusal: CommandPreparationFailure = {
    ok: false,
    reason: 'shell-compatibility',
    message: `Command not run: UnodeAi could not find its declared direct shell (${identity.label}) as a host executable.`,
  };
  if (platform === 'win32') {
    const comspec = env.ComSpec ?? env.COMSPEC;
    const candidates = [
      ...(comspec && path.win32.isAbsolute(comspec) && path.win32.basename(comspec).toLowerCase() === 'cmd.exe' ? [comspec] : []),
      'cmd.exe',
    ];
    for (const candidate of candidates) {
      try {
        const executable = resolve(candidate);
        if (path.win32.basename(executable).toLowerCase() === 'cmd.exe') return { identity, executable };
      } catch {
        /* the next candidate */
      }
    }
    return refusal;
  }
  try {
    return { identity, executable: resolve('/bin/sh') };
  } catch {
    return refusal;
  }
}

export interface DirectCommandExecutionDeps {
  /** Resolve the direct shell; called once per preparation. */
  shell?: () => DirectCommandShell | CommandPreparationFailure;
  spawn?: (command: string, options: SpawnOptions) => ChildProcess;
  env?: () => NodeJS.ProcessEnv;
  terminateTree?: (proc: ChildProcess) => Promise<ProcessTerminationOutcome>;
  /** How long to wait for the child to close after its tree was terminated. */
  confirmTimeoutMs?: number;
  platform?: NodeJS.Platform;
  /** Where every started child is kept until it closes; `directChildren` by default. */
  children?: DirectChildRegistry;
}

function notStarted(reason: 'spawn-failed' | 'disposed', output: string): CommandExecResult {
  return { status: 'not-started', code: null, reason, output };
}

/**
 * Prepare one command for the declared direct shell. The returned object is one-shot across `execute` and
 * `startBackground`: a second call is refused and never re-runs anything, and the shell is not resolved again
 * after approval.
 */
export function createDirectCommandPreparer(deps: DirectCommandExecutionDeps = {}): PrepareDirectCommand {
  const resolveShell = deps.shell ?? (() => resolveDeclaredDirectShell({ platform: deps.platform }));
  const children = deps.children ?? directChildren;
  const startChild = deps.spawn ?? ((command: string, options: SpawnOptions) => nodeSpawn(command, options));
  // The one place a direct child starts: undefined once the host has begun to shut down.
  const spawn = (command: string, options: SpawnOptions) => children.start(() => startChild(command, options));
  const env = deps.env ?? (() => sanitizedCommandEnv());
  const terminateTree = deps.terminateTree ?? ((proc: ChildProcess) => terminateChildProcessTree(proc));
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? TERMINATION_CONFIRM_TIMEOUT_MS;
  const platform = deps.platform ?? process.platform;

  return () => {
    const shell = resolveShell();
    if (!('identity' in shell)) return shell;
    let used = false;
    const spawnOptions = (cwd: string): SpawnOptions => ({
      cwd: spawnCwd(cwd, platform),
      // The resolved absolute interpreter, never `true`: Node keeps its quoting, the host keeps the identity.
      shell: shell.executable,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env(),
      windowsHide: true,
    });
    const prepared: PreparedDirectCommand = {
      ok: true,
      shell: shell.identity,
      execute: (command, opts) => {
        if (used) return Promise.resolve(notStarted('disposed', 'Command not run: this prepared command was already used.'));
        used = true;
        if (opts.signal?.aborted) return Promise.resolve(notStarted('disposed', 'Command not run: the agent was stopped before it started.'));
        return runDirect(command, opts);
      },
      startBackground: (command, opts) => {
        if (used) return { ok: false, error: 'this prepared command was already used' };
        used = true;
        try {
          const proc = spawn(command, spawnOptions(opts.cwd));
          return proc ? { ok: true, process: proc } : { ok: false, error: HOST_SHUTTING_DOWN.message, notStarted: HOST_SHUTTING_DOWN };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    };

    function runDirect(command: string, opts: { cwd: string; timeoutMs?: number; maxOutputChars?: number; signal?: AbortSignal; continueOnTimeout?: boolean }): Promise<CommandExecResult> {
      const timeoutMs = opts.timeoutMs ?? DIRECT_COMMAND_DEFAULT_TIMEOUT_MS;
      const maxOutputChars = opts.maxOutputChars ?? COMMAND_OUTPUT_MAX_CHARS;
      const capture = new BoundedCommandOutput();
      let complete!: (result: CommandExecResult) => void;
      const completion = new Promise<CommandExecResult>(resolve => { complete = resolve; });
      return new Promise((resolve) => {
        let started: ChildProcess | undefined;
        try {
          started = spawn(command, spawnOptions(opts.cwd));
        } catch (error) {
          resolve(notStarted('spawn-failed', `Failed to start the command: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }
        if (!started) {
          resolve(notStartedBy(HOST_SHUTTING_DOWN));
          return;
        }
        const proc = started;
        let settled = false;
        let spawned = false;
        let closed = false;
        let stopping = false;
        let commandStop = false;
        let onClosed: (() => void) | undefined;
        const finish = (result: CommandExecResult) => {
          if (settled) return;
          settled = true;
          capture.finish();
          if (result.capture === capture) {
            const output = rendered();
            const note = 'note' in result ? result.note : undefined;
            result.output = note ? (output ? `${note}\n${output}` : note) : output;
          }
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
          complete(result);
          resolve(result);
        };
        const rendered = () => capture.snapshotWithin(maxOutputChars);
        proc.once('spawn', () => { spawned = true; });
        proc.stdout?.on('data', (chunk) => capture.push(chunk.toString()));
        proc.stderr?.on('data', (chunk) => capture.push(chunk.toString()));
        proc.once('error', (error) => {
          // An error before the process existed means nothing ran. After that, `close` reports the outcome.
          if (!spawned && !stopping) finish(notStarted('spawn-failed', `Failed to start the command: ${error.message}`));
        });
        proc.once('close', (code) => {
          closed = true;
          onClosed?.();
          if (!stopping) finish({ status: 'exited', code, output: rendered(), capture });
        });
        let lastStop: ProcessTerminationOutcome | undefined;
        const stop = async (why: 'timeout' | 'abort') => {
          if (stopping || settled) return;
          stopping = true;
          const outcome = await terminateTree(proc);
          lastStop = outcome;
          if (!closed) {
            await new Promise<void>((resume) => {
              const wait = setTimeout(resume, confirmTimeoutMs);
              onClosed = () => { clearTimeout(wait); resume(); };
            });
          }
          if (!terminationConfirmed(outcome) || !closed) {
            const note = why === 'timeout' ? TIMEOUT_STOP_UNCONFIRMED_MESSAGE : STOP_UNCONFIRMED_MESSAGE;
            finish({ status: 'outcome-unknown', code: null, reason: 'stop-unconfirmed', note, output: `${note}\n${rendered()}`, capture });
            return;
          }
          if (why === 'timeout') {
            finish({ status: 'timed-out', code: null, stopConfirmed: true, output: rendered(), capture });
            return;
          }
          const note = commandStop
            ? 'This background command was stopped. It may have already changed files or other state.'
            : 'The agent was stopped, restarted or removed while this command ran, and UnodeAi stopped its process tree. It may have had effects.';
          finish({ status: 'outcome-unknown', code: null, reason: 'exit-unreported', note, output: `${note}\n${rendered()}`, capture });
        };
        const onAbort = () => { void stop('abort'); };
        let requestedStop: Promise<ProcessTerminationOutcome> | undefined;
        const timer = setTimeout(() => {
          if (!opts.continueOnTimeout) { void stop('timeout'); return; }
          resolve({ status: 'running', code: null, output: rendered(), capture, continuation: {
            completion, output: rendered,
            stop: () => requestedStop ??= (async () => {
              if (closed && !stopping) return { status: 'already-stopped' };
              commandStop = true;
              await stop('abort');
              const result = await completion;
              return result.status === 'outcome-unknown' && result.reason === 'stop-unconfirmed'
                ? { status: 'unknown', detail: 'The command process stop was not confirmed.' }
                : lastStop ?? { status: 'unknown', detail: 'No process stop was observed.' };
            })(),
          } });
        }, timeoutMs);
        opts.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }

    return prepared;
  };
}

/**
 * A foreground execution provider with no visible terminal, for consumers outside VS Code (and the default of
 * WorkspaceTools). It keeps the same lane rule: one command at a time. v0.9.99: a stop that could not be confirmed
 * is reported in that command's result and no longer refuses the agent's later commands; each runs in its own
 * process.
 */
export function createDirectExecutionProvider(prepare: PrepareDirectCommand = createDirectCommandPreparer()): CommandExecutionProvider {
  const lane = new ExecutionLane();
  return {
    // A background command runs beside the lane, never past its reset: checked when it is prepared, and again when it
    // would start, because an approval may have waited in between.
    prepareDirect: () => {
      const refused = laneStartRefusal(lane);
      if (refused) return refused;
      const prepared = prepare();
      return prepared.ok ? guardDirectCommand(prepared, () => laneStartRefusal(lane)) : prepared;
    },
    async acquire(opts) {
      const ticket = await lane.enter();
      if (!('signal' in ticket)) return ticket;
      const prepared = prepare();
      if (!prepared.ok) {
        ticket.release();
        return prepared;
      }
      ticket.setPhase('awaiting-approval');
      let executed = false;
      const lease: PreparedCommandExecution = {
        ok: true,
        shell: prepared.shell,
        transport: 'direct',
        signal: ticket.signal,
        async execute(command, timeoutMs, continueOnTimeout) {
          if (executed) return notStarted('disposed', 'Command not run: this prepared command was already used.');
          executed = true;
          ticket.setPhase('running');
          const refused = opts.startRefusal?.();
          if (refused) return notStartedBy(refused);
          return prepared.execute(command, { cwd: opts.cwd, timeoutMs, signal: ticket.signal, continueOnTimeout });
        },
        async release() {
          ticket.release();
        },
      };
      return lease;
    },
  };
}
