/*---------------------------------------------------------------------------------------------
 *  UnodeAi - TerminalManager  (#13 Cline-class command execution; v0.9.96 execution boundary)
 *  Owns one VS Code integrated terminal per agent and hands out a prepared execution for each command.
 *  Running through a real terminal (Shell Integration API = a PTY) lets agents run TTY-needing tools
 *  (e.g. vitest) that raw `child_process.spawn` can't, and the user SEES the command run.
 *
 *  v0.9.96: a foreground command is attempted at most once, under the shell identity and the last
 *  host-observed physical working directory it was checked for, and a later foreground command of the same
 *  agent cannot begin until the earlier one has ended or its process tree is confirmed stopped.
 *    - Each agent has a lane (ExecutionLane): ownership is taken before preparation and kept through approval,
 *      execution, timeout grace and cleanup. Different agents run concurrently.
 *    - Each terminal is a replaceable slot with its own integration and capture state; nothing is manager-wide.
 *    - Nothing is started, typed or probed for a command before its gate and approval. The shell named on the card
 *      is the agent terminal's last proved shell, or the one the terminal settings name; the terminal is created
 *      and checked only after the approval, and a command runs only where it proves that same shell kind.
 *    - Before every command the terminal's reported folder is checked physically. A drifted terminal is
 *      replaced once, never repaired with `cd`; if the replacement cannot prove the folder either, the command is
 *      not run, and the agent's next command is checked for the declared direct fallback before its approval.
 *    - A host-generated nonce probe proves the shell's grammar; the proof is reused only while nothing ran since.
 *    - After every timeout the terminal's process tree is terminated, observed and the terminal disposed. An
 *      unconfirmed stop, or a terminal that closed while a command ran, quarantines the lane until the agent is
 *      restarted or removed, or the window reloads.
 *  Authority stays outside: this module never decides whether a command is allowed.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { realpath as fsRealpath } from 'fs/promises';
import { AnsiStripper, BoundedCommandOutput, COMMAND_OUTPUT_MAX_CHARS } from '../backend/BoundedCommandOutput';
import {
  type CommandExecResult,
  type CommandExecutionProvider,
  type CommandPreparationFailure,
  ExecutionLane,
  LANE_DISPOSED_MESSAGE,
  guardDirectCommand,
  HOST_SHUTTING_DOWN_MESSAGE,
  laneStartRefusal,
  type LaneTicket,
  notStartedBy,
  type PrepareDirectCommand,
  type PreparedCommandExecution,
  type PreparedDirectCommand,
  sameExecutionDirectory,
  type StartRefusal,
  TIMEOUT_STOP_UNCONFIRMED_MESSAGE,
} from '../backend/CommandExecution';
import {
  type CommandShellIdentity,
  type CommandShellKind,
  commandShellIdentity,
  declaredDirectShellIdentity,
  directFallbackNotice,
  posixShellKindFromBasename,
} from '../backend/CommandShell';
import { spawnCwd } from '../backend/commandEnv';
import { type HostShutdown, hostShutdown, type ProcessTerminationOutcome, terminationConfirmed } from '../backend/processTree';
import { effectiveTerminalProfileHint, type TerminalProfileHint } from './TerminalShellProfile';

/** How long to wait for a freshly-created terminal's shell integration to activate before falling back. */
export const SHELL_INTEGRATION_TIMEOUT_MS = 5_000;
/** The whole classification probe, all of its stages together. */
export const CAPTURE_PROBE_TIMEOUT_MS = 2_000;
/** How long a timed-out command may clean up after Ctrl-C before its tree is terminated. */
export const TERMINAL_INTERRUPT_GRACE_MS = 2_000;
/** A probe stage's private capture limit. */
const PROBE_CAPTURE_LIMIT = 4_096;
/** How long output may keep arriving after a command's end event before the result is returned. */
const STREAM_DRAIN_MS = 1_000;
/** Durable ownership marker: Terminal.creationOptions survives an extension-host restart. */
export const UNODEAI_TERMINAL_MARKER = 'UNODEAI_MANAGED_TERMINAL';
export const UNODEAI_TERMINAL_MARKER_VALUE = '1';

const CWD_CHANGED_AFTER_APPROVAL = 'Command not run: the prepared terminal changed working directory after approval. '
  + 'Retry to check the command against the current execution environment.';
const TERMINAL_CHANGED_AFTER_APPROVAL = 'Command not run: the prepared terminal changed after approval. Retry to check '
  + 'the command against the current execution environment.';
const TERMINAL_SETTINGS_CHANGED_AFTER_APPROVAL = 'Command not run: the terminal profile settings changed after approval. Retry to '
  + 'check the command against the current execution environment.';
/** How often a preparation reads the terminal settings again when they change while it waits. */
const PREPARE_ATTEMPTS = 3;
const SETTINGS_KEPT_CHANGING_MESSAGE = 'Command not run: the terminal profile settings kept changing while the command was '
  + 'being prepared. Retry once they are settled.';
export const TERMINAL_CLOSED_DURING_COMMAND_MESSAGE = 'The agent terminal closed while this command ran, so UnodeAi could not '
  + 'confirm that the command\'s processes stopped. No later command will start for this agent. Close any remaining '
  + 'process and restart the agent or reload the window.';

function isUnodeAiTerminal(terminal: vscode.Terminal): boolean {
  const options = terminal.creationOptions;
  return 'env' in options && options.env?.[UNODEAI_TERMINAL_MARKER] === UNODEAI_TERMINAL_MARKER_VALUE;
}

function createManagedTerminal(name: string, cwd: string | undefined): vscode.Terminal {
  return vscode.window.createTerminal({
    name,
    // Every agent terminal starts where a command would: an agent's commands run in it, whoever opened it first.
    cwd: cwd === undefined ? undefined : spawnCwd(cwd),
    isTransient: true,
    env: { [UNODEAI_TERMINAL_MARKER]: UNODEAI_TERMINAL_MARKER_VALUE },
  });
}

/** The proved shell is the one a command was checked and approved for: the same kind, hence the same grammar. */
function sameShellKind(proved: CommandShellIdentity, approved: CommandShellIdentity): boolean {
  return proved.kind === approved.kind && proved.grammar === approved.grammar;
}

function notStarted(reason: 'environment-changed' | 'disposed', output: string): CommandExecResult {
  return { status: 'not-started', code: null, reason, output };
}

/** One managed terminal and everything the host knows about it. Replacing a terminal creates a new slot. */
interface TerminalSlot {
  readonly terminal: vscode.Terminal;
  readonly generation: number;
  /** The terminal-profile settings revision it was created under: it proves nothing about later settings. */
  readonly settingsRevision: number;
  shell?: CommandShellIdentity;
  integration: 'waiting' | 'available' | 'unavailable';
  capture: 'unprobed' | 'probing' | 'reliable' | 'unreliable';
  state: 'idle' | 'running' | 'stopping' | 'closed';
  /** The probe or command the manager itself is running in this terminal. */
  activeExecution?: vscode.TerminalShellExecution;
  /** Executions someone else started in this terminal, until their end events. */
  readonly external: Set<vscode.TerminalShellExecution>;
  /** Bumped by every external start and end: anything prepared under an older revision must not run. */
  observedRevision: number;
  /**
   * What the shell proof was made under; reused only while all of it still holds. Cleared when a command starts:
   * whatever it ran may have changed the shell, so the next command proves it again.
   */
  proof?: { revision: number; settingsRevision: number; integration: vscode.TerminalShellIntegration };
  readonly idleWaiters: Set<() => void>;
}

/** One agent: its lane, its current terminal and the profile that failed for it. */
interface AgentLane {
  readonly agentId: string;
  name: string;
  readonly queue: ExecutionLane;
  slot?: TerminalSlot;
  failedProfile?: { hintFingerprint: string; settingsRevision: number; why: string };
}

export interface TerminalManagerDeps {
  /** The declared direct fallback (cmd.exe on Windows, /bin/sh elsewhere), prepared per invocation. */
  prepareDirect: PrepareDirectCommand;
  /** Terminate a terminal's process tree and report what was observed. */
  terminateProcessTree: (pid: number) => Promise<ProcessTerminationOutcome>;
  realpath?: (candidate: string) => Promise<string>;
  profileHint?: () => TerminalProfileHint;
  platform?: NodeJS.Platform;
  nonce?: () => string;
  now?: () => number;
  /** Once it has begun, no command starts in an agent terminal; `hostShutdown` by default. */
  shutdown?: HostShutdown;
}

/** One execution's listeners, stream and wake-ups, disposed exactly once on every exit path. */
class ExecutionWatch {
  ended = false;
  exitCode: number | undefined;
  closed = false;
  streamDone = false;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly waiters = new Set<() => void>();
  private iterator?: AsyncIterator<string>;
  private disposed = false;

  constructor(terminal: vscode.Terminal, private readonly execution: vscode.TerminalShellExecution, private readonly sink: (chunk: string) => void) {
    this.disposables.push(vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.execution !== execution) return;
      this.ended = true;
      this.exitCode = event.exitCode;
      this.notify();
    }));
    this.disposables.push(vscode.window.onDidCloseTerminal((closedTerminal) => {
      if (closedTerminal !== terminal) return;
      this.closed = true;
      this.notify();
    }));
    // Read at once: the stream must be read from the start of the execution not to miss data.
    void this.read();
  }

  private async read(): Promise<void> {
    try {
      this.iterator = this.execution.read()[Symbol.asyncIterator]();
      for (;;) {
        const next = await this.iterator.next();
        if (next.done || this.disposed) break;
        this.sink(next.value);
      }
    } catch {
      /* The stream ended or failed; the end event still reports the exit. */
    } finally {
      this.streamDone = true;
      this.notify();
    }
  }

  /** Resolves true once `ready()` holds, or false when `ms` passes, the signal aborts or the watch ends first. */
  until(ready: () => boolean, ms: number, signal?: AbortSignal): Promise<boolean> {
    if (ready()) return Promise.resolve(true);
    if (this.disposed || signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.delete(check);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const check = () => {
        if (ready()) finish(true);
        else if (this.disposed) finish(false);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(ready()), Math.max(0, ms));
      this.waiters.add(check);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private notify(): void {
    for (const check of [...this.waiters]) check();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables.splice(0)) {
      try { disposable.dispose(); } catch { /* already gone */ }
    }
    try { void this.iterator?.return?.()?.catch?.(() => undefined); } catch { /* the stream is already closed */ }
    this.notify();
  }
}

type ProbeGrammar = 'powershell' | 'posix' | 'cmd';

/** What a terminal lease was checked and approved for, fixed before its gate. */
interface TerminalPlan {
  readonly shell: CommandShellIdentity;
  readonly hint: TerminalProfileHint;
  readonly settingsRevision: number;
  /** The caller's host condition (Workspace Trust), checked at every side-effect boundary. */
  readonly startRefusal?: StartRefusal;
}

/**
 * Whether an approved terminal command may still go on, checked before each thing it would start and after each
 * wait: the agent's lifecycle, the terminal settings it was approved under, and the caller's start condition.
 */
type Halt = () => CommandExecResult | undefined;

export class TerminalManager {
  private readonly lanes = new Map<string, AgentLane>();
  private readonly slotsByTerminal = new Map<vscode.Terminal, TerminalSlot>();
  /** Prevent overlapping activation/invalidation/deactivation sweeps from acting on a stale PID twice. */
  private readonly terminalShutdowns = new WeakMap<vscode.Terminal, Promise<ProcessTerminationOutcome>>();
  private listeners: vscode.Disposable[] | undefined;
  private slotGeneration = 0;
  private settingsRevision = 0;
  private readonly realpath: (candidate: string) => Promise<string>;
  private readonly profileHint: () => TerminalProfileHint;
  private readonly pathFlavor: 'win32' | 'posix';
  private readonly platform: NodeJS.Platform;
  private readonly nonce: () => string;
  private readonly now: () => number;
  private readonly shutdown: HostShutdown;

  constructor(private readonly deps: TerminalManagerDeps) {
    this.realpath = deps.realpath ?? ((candidate) => fsRealpath(candidate));
    const platform = deps.platform ?? process.platform;
    this.profileHint = deps.profileHint ?? (() => effectiveTerminalProfileHint(platform));
    this.pathFlavor = platform === 'win32' ? 'win32' : 'posix';
    this.platform = platform;
    this.nonce = deps.nonce ?? (() => randomBytes(8).toString('hex'));
    this.now = deps.now ?? Date.now;
    this.shutdown = deps.shutdown ?? hostShutdown;
  }

  /** The prepared-execution provider for one agent's foreground commands. */
  executionProviderFor(agentId: string, name: string): CommandExecutionProvider {
    return { acquire: (opts) => this.acquire(agentId, name, opts.cwd, opts.startRefusal), prepareDirect: () => this.prepareDirectFor(agentId, name) };
  }

  /**
   * A background command runs beside the foreground lane, never past its quarantine: an earlier command of this
   * agent may still be running, so no later command of the agent starts until the lane is reset. The lane is
   * checked when the command is prepared and again at the moment it would start, because its gate and approval
   * may have waited in between; a lane quarantined or reset meanwhile refuses the start.
   */
  private prepareDirectFor(agentId: string, name: string): PreparedDirectCommand | CommandPreparationFailure {
    const lane = this.laneFor(agentId, name);
    const refused = laneStartRefusal(lane.queue);
    if (refused) return refused;
    const prepared = this.deps.prepareDirect();
    return prepared.ok ? guardDirectCommand(prepared, () => laneStartRefusal(lane.queue)) : prepared;
  }

  /** The effective terminal-profile settings changed: a cached profile failure no longer applies. */
  profileSettingsChanged(): void {
    this.settingsRevision += 1;
  }

  /**
   * Reveal an agent's terminal. It never executes or probes. With an open, idle lane it may create an unprobed
   * terminal, so every agent has its own visible thread; the next command still proves integration, folder and
   * shell. While a command holds the lane, or the lane is being reset or is quarantined, it only shows what exists.
   */
  reveal(agentId: string, name?: string, cwd?: string): void {
    const lane = this.lanes.get(agentId);
    let slot = lane ? this.liveSlot(lane) : undefined;
    const mayCreate = !lane || (lane.queue.state === 'open' && !lane.queue.busy);
    if (!slot && name && mayCreate) {
      this.ensureListeners();
      slot = this.createSlot(this.laneFor(agentId, name), cwd);
    }
    try { slot?.terminal.show(); } catch { /* the terminal closed meanwhile */ }
  }

  /**
   * The lifecycle reset of one agent (removal or restart). A queued, preparing or approval-waiting command is
   * aborted at once and never starts; one that is already running is stopped through its ordinary stop path.
   * Then the agent's terminal is closed and the lane forgotten, which also clears a quarantine and a cached
   * profile failure.
   */
  async dispose(agentId: string): Promise<void> {
    const lane = this.lanes.get(agentId);
    if (!lane) return;
    await lane.queue.close();
    const slot = lane.slot;
    lane.slot = undefined;
    if (slot) {
      this.slotsByTerminal.delete(slot.terminal);
      await this.stopTerminal(slot.terminal);
    }
    if (this.lanes.get(agentId) === lane) this.lanes.delete(agentId);
  }

  /**
   * Dispose every lane and every managed terminal, including renderer-owned terminals left by an earlier
   * extension host. The durable env marker keeps user-created terminals outside this cleanup boundary. Safe to
   * call again: each terminal is stopped once.
   */
  async disposeAll(): Promise<void> {
    const lanes = [...this.lanes.values()];
    this.lanes.clear();
    const terminals = new Set<vscode.Terminal>();
    for (const lane of lanes) {
      if (lane.slot) terminals.add(lane.slot.terminal);
    }
    for (const terminal of vscode.window.terminals) {
      if (isUnodeAiTerminal(terminal)) terminals.add(terminal);
    }
    await Promise.all([
      ...lanes.map((lane) => lane.queue.close()),
      ...Array.from(terminals, (terminal) => this.stopTerminal(terminal)),
    ]);
    this.slotsByTerminal.clear();
    for (const listener of this.listeners?.splice(0) ?? []) {
      try { listener.dispose(); } catch { /* already disposed */ }
    }
    this.listeners = undefined;
  }

  // ----------------------------------------------------------------------------------------------
  // Preparation
  // ----------------------------------------------------------------------------------------------

  private laneFor(agentId: string, name: string): AgentLane {
    const existing = this.lanes.get(agentId);
    if (existing && existing.queue.state !== 'closed') {
      existing.name = name;
      return existing;
    }
    const lane: AgentLane = { agentId, name, queue: new ExecutionLane() };
    this.lanes.set(agentId, lane);
    return lane;
  }

  private async acquire(
    agentId: string,
    name: string,
    cwd: string,
    startRefusal: StartRefusal | undefined,
  ): Promise<PreparedCommandExecution | CommandPreparationFailure> {
    this.ensureListeners();
    const lane = this.laneFor(agentId, name);
    const ticket = await lane.queue.enter();
    if (!('signal' in ticket)) return ticket;
    try {
      const prepared = await this.prepare(lane, ticket, cwd, startRefusal);
      if (prepared.ok) ticket.setPhase('awaiting-approval');
      else ticket.release();
      return prepared;
    } catch (error) {
      ticket.release();
      return {
        ok: false,
        reason: 'cwd-unverified',
        message: `Command not run: UnodeAi could not prepare the agent terminal (${error instanceof Error ? error.message : String(error)}).`,
      };
    }
  }

  private disposedFailure(): CommandPreparationFailure {
    return { ok: false, reason: 'disposed', message: LANE_DISPOSED_MESSAGE };
  }

  /**
   * Decide, before the gate, what the command will run in, from facts alone: nothing is started, typed or probed.
   * The agent terminal's last proved shell, while that terminal still belongs to these settings, or the shell the
   * terminal settings name. The terminal is created, checked and probed only after the gate and the approval, and
   * must then prove the same shell kind (executeInTerminal).
   */
  private async prepare(
    lane: AgentLane,
    ticket: LaneTicket,
    cwd: string,
    startRefusal: StartRefusal | undefined,
  ): Promise<PreparedCommandExecution | CommandPreparationFailure> {
    const signal = ticket.signal;
    for (let attempt = 1; ; attempt += 1) {
      // Every fact the plan rests on is read under one settings revision, and the plan carries that revision.
      const revision = this.settingsRevision;
      const hint = this.profileHint();
      const failed = lane.failedProfile;
      if (failed && failed.hintFingerprint === hint.fingerprint && failed.settingsRevision === revision) {
        // Known to fail for this agent and these settings: no new terminal, no second five-second wait.
        return this.directLease(lane, ticket, cwd, failed.why, startRefusal);
      }
      lane.failedProfile = undefined;
      const slot = this.liveSlot(lane);
      const current = slot && slot.settingsRevision === revision ? slot : undefined;
      if (current && current.external.size > 0) {
        const idle = await this.waitForExternalIdle(current, signal);
        if (signal.aborted) return this.disposedFailure();
        if (this.settingsRevision !== revision) {
          // The settings changed during the wait: nothing read above holds any more. Read them again.
          if (attempt < PREPARE_ATTEMPTS) continue;
          return { ok: false, reason: 'shell-compatibility', message: SETTINGS_KEPT_CHANGING_MESSAGE };
        }
        // Someone's own command is running there. It is never interrupted, and nothing is cached.
        if (!idle) return this.directLease(lane, ticket, cwd, 'Someone is running a command in the agent terminal.', startRefusal);
      }
      if (signal.aborted) return this.disposedFailure();
      const shell = current?.shell ?? this.profileShell(hint, revision);
      if ('why' in shell) return this.failProfile(lane, ticket, cwd, hint, shell.why, startRefusal, revision);
      return this.terminalLease(lane, ticket, { shell, hint, settingsRevision: revision, startRefusal }, cwd);
    }
  }

  /** The shell the terminal settings name, or why the agent terminal cannot be used with them. */
  private profileShell(hint: TerminalProfileHint, revision: number): CommandShellIdentity | { why: string } {
    if (hint.grammar === 'unsupported') return { why: 'The selected terminal profile is not a shell UnodeAi can check commands for.' };
    if (hint.wsl) return { why: 'The selected terminal profile runs WSL, whose folders UnodeAi does not map to this host.' };
    if (hint.grammar === 'cmd' || hint.kind === 'cmd') return { why: 'The selected terminal profile is Command Prompt, which reports no shell integration.' };
    if (!hint.kind) return { why: 'UnodeAi could not tell from the terminal settings which shell the agent terminal would run.' };
    return commandShellIdentity(hint.kind, 'terminal-profile', {
      label: hint.kind === 'bash' && hint.label ? hint.label : undefined,
      fingerprint: ['profile', hint.fingerprint, revision],
    });
  }

  private failProfile(
    lane: AgentLane,
    ticket: LaneTicket,
    cwd: string,
    hint: TerminalProfileHint,
    why: string,
    startRefusal: StartRefusal | undefined,
    revision: number,
  ): PreparedCommandExecution | CommandPreparationFailure {
    lane.failedProfile = { hintFingerprint: hint.fingerprint, settingsRevision: revision, why };
    return this.directLease(lane, ticket, cwd, why, startRefusal);
  }

  /** The declared direct fallback, chosen before the gate and named in the notice. */
  private directLease(
    lane: AgentLane,
    ticket: LaneTicket,
    cwd: string,
    why: string,
    startRefusal: StartRefusal | undefined,
  ): PreparedCommandExecution | CommandPreparationFailure {
    const prepared = this.deps.prepareDirect();
    if (!prepared.ok) return prepared;
    let used = false;
    return {
      ok: true,
      shell: prepared.shell,
      transport: 'direct',
      notice: directFallbackNotice(prepared.shell, why),
      signal: ticket.signal,
      execute: async (command, timeoutMs) => {
        if (used) return notStarted('disposed', 'Command not run: this prepared command was already used.');
        used = true;
        if (ticket.signal.aborted) return notStarted('disposed', LANE_DISPOSED_MESSAGE);
        ticket.setPhase('running');
        const refused = startRefusal?.();
        if (refused) return notStartedBy(refused);
        const result = await prepared.execute(command, { cwd, timeoutMs, signal: ticket.signal });
        if (result.status === 'outcome-unknown' && result.reason === 'stop-unconfirmed') lane.queue.quarantine();
        if (ticket.signal.aborted) ticket.release();
        return result;
      },
      release: async () => { ticket.release(); },
    };
  }

  private terminalLease(lane: AgentLane, ticket: LaneTicket, plan: TerminalPlan, cwd: string): PreparedCommandExecution {
    let used = false;
    return {
      ok: true,
      shell: plan.shell,
      transport: 'terminal',
      signal: ticket.signal,
      execute: async (command, timeoutMs) => {
        if (used) return notStarted('disposed', 'Command not run: this prepared command was already used.');
        used = true;
        const result = await this.executeInTerminal(lane, ticket, plan, cwd, command, timeoutMs);
        if (ticket.signal.aborted) ticket.release();
        return result;
      },
      release: async () => { ticket.release(); },
    };
  }

  // ----------------------------------------------------------------------------------------------
  // Execution
  // ----------------------------------------------------------------------------------------------

  /**
   * After the gate and the approval: create or reuse the agent terminal, prove its integration, folder and shell,
   * and run the command only when the proved shell is the kind that was checked and approved. Every failure here
   * is "not run": no other shell is chosen after an approval. A terminal that cannot be used is remembered for
   * this agent, so its next command is checked for the declared direct fallback before its own approval.
   */
  private async executeInTerminal(
    lane: AgentLane,
    ticket: LaneTicket,
    plan: TerminalPlan,
    cwd: string,
    command: string,
    timeoutMs: number,
  ): Promise<CommandExecResult> {
    const halt: Halt = () => {
      // Checked before the terminal is created and again right before the command is sent.
      if (this.shutdown.started) return notStarted('disposed', HOST_SHUTTING_DOWN_MESSAGE);
      if (ticket.signal.aborted) return notStarted('disposed', LANE_DISPOSED_MESSAGE);
      if (plan.settingsRevision !== this.settingsRevision) return notStarted('environment-changed', TERMINAL_SETTINGS_CHANGED_AFTER_APPROVAL);
      const refused = plan.startRefusal?.();
      return refused ? notStartedBy(refused) : undefined;
    };
    const stopped = halt();
    if (stopped) return stopped;
    // From here the host acts on the agent's behalf: a lifecycle reset waits for this invocation to settle.
    ticket.setPhase('running');
    const ready = await this.readyTerminal(lane, ticket, plan, cwd, halt);
    if ('status' in ready) return ready;
    if (!sameShellKind(ready.shell, plan.shell)) {
      return notStarted(
        'environment-changed',
        `Command not run: the agent terminal runs ${ready.shell.label}, not ${plan.shell.label} as the command was checked `
          + `and approved for. Retry: the next command is checked for ${ready.shell.label}.`,
      );
    }
    const prepared = { revision: ready.slot.observedRevision, generation: ready.slot.generation, integration: ready.integration };
    return this.executeInSlot(lane, ticket, ready.slot, prepared, ready.shell, cwd, command, timeoutMs, halt, plan.settingsRevision);
  }

  private async readyTerminal(
    lane: AgentLane,
    ticket: LaneTicket,
    plan: TerminalPlan,
    cwd: string,
    halt: Halt,
  ): Promise<{ slot: TerminalSlot; integration: vscode.TerminalShellIntegration; shell: CommandShellIdentity } | CommandExecResult> {
    const signal = ticket.signal;
    // One replacement in all. A terminal that was already in use and no longer proves the approved shell is replaced
    // without blaming the profile: an earlier command may have left a subshell running in it. Only a terminal made
    // for this command that still fails marks the profile as failed for this agent.
    let replaced = false;
    for (;;) {
      let slot = this.liveSlot(lane);
      if (slot && slot.settingsRevision !== plan.settingsRevision) {
        // Created under other terminal settings: it never proves anything about these.
        await this.retireSlot(lane, slot);
        slot = undefined;
      }
      // Before a terminal is created: its profile program would start.
      const beforeCreate = halt();
      if (beforeCreate) return beforeCreate;
      const reused = !!slot;
      slot = slot ?? this.createSlot(lane, cwd, plan.settingsRevision);
      const replaceOnce = async (current: TerminalSlot) => {
        await this.retireSlot(lane, current);
        if (replaced) return false;
        replaced = true;
        return true;
      };
      const integration = await this.waitForIntegration(slot, signal);
      const afterIntegration = halt();
      if (afterIntegration) return afterIntegration;
      if (!integration) {
        slot.integration = 'unavailable';
        if (reused && await replaceOnce(slot)) continue;
        if (!reused) await this.retireSlot(lane, slot);
        return this.notRunInProfile(lane, plan, 'The selected terminal profile could not prove shell integration and cwd.');
      }
      slot.integration = 'available';
      if (slot.external.size > 0 && !(await this.waitForExternalIdle(slot, signal))) {
        return halt() ?? notStarted('environment-changed', 'Command not run: someone is running a command in the agent terminal. Retry when it has finished.');
      }
      const inFolder = await this.cwdMatches(cwd, integration.cwd);
      const afterFolder = halt();
      if (afterFolder) return afterFolder;
      if (!inFolder) {
        if (await replaceOnce(slot)) continue;
        return this.notRunInProfile(lane, plan, 'The agent terminal could not prove that it starts in the authorised folder.');
      }
      const shell = this.reusableProof(slot) ?? await this.probe(slot, integration, plan.hint, signal);
      const afterProbe = halt();
      if (afterProbe) return afterProbe;
      if (!shell) {
        if (reused && await replaceOnce(slot)) continue;
        if (!reused) await this.retireSlot(lane, slot);
        return this.notRunInProfile(lane, plan, 'The selected terminal profile could not prove its shell.');
      }
      if (reused && !sameShellKind(shell, plan.shell) && await replaceOnce(slot)) continue;
      return { slot, integration, shell };
    }
  }

  /** Remember the failure for this agent and these settings, and say that nothing ran and what comes next. */
  private notRunInProfile(lane: AgentLane, plan: TerminalPlan, why: string): CommandExecResult {
    lane.failedProfile = { hintFingerprint: plan.hint.fingerprint, settingsRevision: plan.settingsRevision, why };
    return notStarted(
      'environment-changed',
      `Command not run: ${why} The next command of this agent is checked for the declared direct fallback `
        + `(${declaredDirectShellIdentity(this.platform).label}) before its approval.`,
    );
  }

  private async executeInSlot(
    lane: AgentLane,
    ticket: LaneTicket,
    slot: TerminalSlot,
    prepared: { revision: number; generation: number; integration: vscode.TerminalShellIntegration },
    shell: CommandShellIdentity,
    cwd: string,
    command: string,
    timeoutMs: number,
    halt: Halt,
    settingsRevision: number,
  ): Promise<CommandExecResult> {
    const signal = ticket.signal;
    const stopped = halt();
    if (stopped) return stopped;
    const unchanged = () => lane.slot === slot
      && slot.settingsRevision === settingsRevision
      && slot.state === 'idle'
      && slot.terminal.exitStatus === undefined
      && slot.generation === prepared.generation
      && slot.observedRevision === prepared.revision
      && slot.external.size === 0
      && slot.terminal.shellIntegration === prepared.integration
      && slot.shell === shell;
    // The environment may have changed while the approval was open. Then nothing runs, in no other shell.
    if (!unchanged()) return notStarted('environment-changed', TERMINAL_CHANGED_AFTER_APPROVAL);
    const inFolder = await this.cwdMatches(cwd, prepared.integration.cwd);
    // Immediately before the command starts: nothing awaits between these checks and executeCommand.
    const beforeStart = halt();
    if (beforeStart) return beforeStart;
    if (!inFolder) return notStarted('environment-changed', CWD_CHANGED_AFTER_APPROVAL);
    if (!unchanged()) return notStarted('environment-changed', TERMINAL_CHANGED_AFTER_APPROVAL);

    ticket.setPhase('running');
    slot.state = 'running';
    try { slot.terminal.show(true); } catch { /* showing is cosmetic */ }
    const capture = new BoundedCommandOutput();
    let execution: vscode.TerminalShellExecution;
    try {
      execution = prepared.integration.executeCommand(command);
    } catch (error) {
      // The command text may already have reached the shell. It is never replayed, here or in another shell.
      return this.stopAfterStart(lane, ticket, slot, undefined, capture, 'start-failed', error);
    }
    slot.activeExecution = execution;
    slot.proof = undefined;
    const watch = new ExecutionWatch(slot.terminal, execution, (chunk) => capture.push(chunk));
    try {
      const startedIn = execution.cwd;
      if (startedIn && !(await this.cwdMatches(cwd, startedIn))) {
        return await this.stopAfterStart(lane, ticket, slot, watch, capture, 'cwd-changed-after-start');
      }
      await watch.until(() => (watch.ended && watch.streamDone) || watch.closed, timeoutMs, signal);
      if (watch.ended) {
        if (!watch.streamDone) await watch.until(() => watch.streamDone || watch.closed, STREAM_DRAIN_MS);
        capture.finish();
        const output = capture.renderWithin(COMMAND_OUTPUT_MAX_CHARS);
        return watch.exitCode === undefined
          ? { status: 'outcome-unknown', code: null, reason: 'exit-unreported', output, capture }
          : { status: 'exited', code: watch.exitCode, output, capture };
      }
      if (watch.closed) {
        // The shell is gone, and a child it started may not be: nothing observes it any more, so nothing may
        // start beside it.
        this.forgetSlot(lane, slot);
        lane.queue.quarantine();
        capture.finish();
        const note = TERMINAL_CLOSED_DURING_COMMAND_MESSAGE;
        const output = capture.renderWithin(COMMAND_OUTPUT_MAX_CHARS);
        return { status: 'outcome-unknown', code: null, reason: 'terminal-died', note, output: output ? `${note}\n${output}` : note, capture };
      }
      return await this.stopAfterStart(lane, ticket, slot, watch, capture, signal.aborted ? 'disposed' : 'timeout');
    } finally {
      watch.dispose();
      if (slot.activeExecution === execution) slot.activeExecution = undefined;
      if (slot.state === 'running') slot.state = 'idle';
    }
  }

  /**
   * Interrupt, give a cooperative tool its grace, then ALWAYS terminate and observe the terminal's process tree
   * and dispose the terminal. A returned prompt proves only that the shell job ended, not that a child which
   * ignored Ctrl-C or changed process group has stopped, so no timed-out terminal is ever reused.
   */
  private async stopAfterStart(
    lane: AgentLane,
    ticket: LaneTicket,
    slot: TerminalSlot,
    watch: ExecutionWatch | undefined,
    capture: BoundedCommandOutput,
    why: 'timeout' | 'disposed' | 'cwd-changed-after-start' | 'start-failed',
    error?: unknown,
  ): Promise<CommandExecResult> {
    ticket.setPhase('stopping');
    slot.state = 'stopping';
    if (watch) {
      try { slot.terminal.sendText('\x03', false); } catch { /* the terminal may already be gone */ }
      await watch.until(() => (watch.ended && watch.streamDone) || watch.closed, TERMINAL_INTERRUPT_GRACE_MS);
    }
    const outcome = await this.retireSlot(lane, slot);
    capture.finish();
    const output = capture.renderWithin(COMMAND_OUTPUT_MAX_CHARS);
    if (!terminationConfirmed(outcome)) {
      lane.queue.quarantine();
      const lead = why === 'timeout'
        ? TIMEOUT_STOP_UNCONFIRMED_MESSAGE
        : 'UnodeAi stopped this command but could not confirm that its process tree stopped, so no later command will '
          + 'start for this agent. Close any remaining process and restart the agent or reload the window.';
      return { status: 'outcome-unknown', code: null, reason: 'stop-unconfirmed', note: lead, output: output ? `${lead}\n${output}` : lead, capture };
    }
    switch (why) {
      case 'timeout':
        return { status: 'timed-out', code: null, stopConfirmed: true, output, capture };
      case 'cwd-changed-after-start': {
        const note = 'The terminal reported another working directory once the command had started, so UnodeAi stopped it. It may have had effects.';
        return { status: 'outcome-unknown', code: null, reason: 'cwd-changed-after-start', note, output: output ? `${note}\n${output}` : note, capture };
      }
      case 'start-failed': {
        const note = `The terminal failed while starting the command (${error instanceof Error ? error.message : String(error)}); it may have started, and it was not run again.`;
        return { status: 'outcome-unknown', code: null, reason: 'exit-unreported', note, output: note, capture };
      }
      case 'disposed': {
        const note = 'The agent was stopped, restarted or removed while this command ran, and UnodeAi stopped its process tree. It may have had effects.';
        return { status: 'outcome-unknown', code: null, reason: 'exit-unreported', note, output: output ? `${note}\n${output}` : note, capture };
      }
    }
  }

  // ----------------------------------------------------------------------------------------------
  // The shell proof
  // ----------------------------------------------------------------------------------------------

  private reusableProof(slot: TerminalSlot): CommandShellIdentity | undefined {
    const proof = slot.proof;
    return slot.shell && slot.capture === 'reliable' && proof
      && proof.revision === slot.observedRevision
      && proof.settingsRevision === this.settingsRevision
      && proof.integration === slot.terminal.shellIntegration
      ? slot.shell
      : undefined;
  }

  private probeStages(hint: TerminalProfileHint): ProbeGrammar[] {
    switch (hint.grammar) {
      case 'powershell': return ['powershell'];
      case 'posix': return ['posix'];
      case 'cmd': return ['cmd'];
      default: return ['powershell', 'posix'];
    }
  }

  /**
   * Classify the terminal's shell with host-generated probe text holding only a random nonce. A stage counts only
   * when its end event reports exit 0, its stream settled and exactly one expected nonce record parses. The text
   * goes nowhere: not to the model, the request ledger or the approval surface.
   */
  private async probe(
    slot: TerminalSlot,
    integration: vscode.TerminalShellIntegration,
    hint: TerminalProfileHint,
    signal: AbortSignal,
  ): Promise<CommandShellIdentity | undefined> {
    slot.capture = 'probing';
    const tag = `__UNODE_CAPTURE_${this.nonce()}__`;
    const deadline = this.now() + CAPTURE_PROBE_TIMEOUT_MS;
    const revision = slot.observedRevision;
    for (const grammar of this.probeStages(hint)) {
      if (signal.aborted) break;
      const stage = await this.runProbeStage(slot, integration, PROBE_TEXT[grammar](tag), deadline, signal);
      if (!stage) break;
      if (stage.exitCode !== 0) continue;
      const evidence = parseProbe(grammar, tag, stage.text);
      if (!evidence) continue;
      let kind = evidence.kind;
      if (hint.wsl && grammar === 'posix') kind = 'wsl';
      if (slot.observedRevision !== revision) break;
      const shell = commandShellIdentity(kind, 'terminal-probe', {
        label: kind === 'wsl' ? `WSL (${evidence.inner ?? 'sh'})` : kind === 'bash' && hint.label ? hint.label : undefined,
        fingerprint: ['terminal', slot.generation, hint.fingerprint, kind, evidence.inner ?? ''],
      });
      slot.shell = shell;
      slot.capture = 'reliable';
      slot.proof = { revision: slot.observedRevision, settingsRevision: this.settingsRevision, integration };
      return shell;
    }
    slot.capture = 'unreliable';
    return undefined;
  }

  private async runProbeStage(
    slot: TerminalSlot,
    integration: vscode.TerminalShellIntegration,
    text: string,
    deadline: number,
    signal: AbortSignal,
  ): Promise<{ exitCode: number | undefined; text: string } | undefined> {
    const stripper = new AnsiStripper();
    let captured = '';
    let execution: vscode.TerminalShellExecution;
    try {
      execution = integration.executeCommand(text);
    } catch {
      return undefined;
    }
    slot.activeExecution = execution;
    const watch = new ExecutionWatch(slot.terminal, execution, (chunk) => {
      if (captured.length < PROBE_CAPTURE_LIMIT) captured = (captured + stripper.push(chunk)).slice(0, PROBE_CAPTURE_LIMIT);
    });
    try {
      await watch.until(() => (watch.ended && watch.streamDone) || watch.closed, deadline - this.now(), signal);
      if (!watch.ended || !watch.streamDone || watch.closed) return undefined;
      return { exitCode: watch.exitCode, text: (captured + stripper.flush()).slice(0, PROBE_CAPTURE_LIMIT) };
    } finally {
      watch.dispose();
      if (slot.activeExecution === execution) slot.activeExecution = undefined;
    }
  }

  // ----------------------------------------------------------------------------------------------
  // Slots and terminals
  // ----------------------------------------------------------------------------------------------

  private ensureListeners(): void {
    if (this.listeners) return;
    this.listeners = [
      vscode.window.onDidStartTerminalShellExecution((event) => {
        const slot = this.slotsByTerminal.get(event.terminal);
        if (!slot || event.execution === slot.activeExecution) return;
        // Someone else's execution in a managed terminal: never run over it, and anything prepared before it is stale.
        slot.external.add(event.execution);
        slot.observedRevision += 1;
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        const slot = this.slotsByTerminal.get(event.terminal);
        if (!slot || !slot.external.delete(event.execution)) return;
        slot.observedRevision += 1;
        for (const wake of [...slot.idleWaiters]) wake();
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        const slot = this.slotsByTerminal.get(terminal);
        if (!slot) return;
        this.slotsByTerminal.delete(terminal);
        if (slot.state !== 'stopping') slot.state = 'closed';
        for (const lane of this.lanes.values()) {
          if (lane.slot === slot) lane.slot = undefined;
        }
        for (const wake of [...slot.idleWaiters]) wake();
      }),
    ];
  }

  private liveSlot(lane: AgentLane): TerminalSlot | undefined {
    const slot = lane.slot;
    if (slot && (slot.state === 'closed' || slot.terminal.exitStatus !== undefined)) {
      this.forgetSlot(lane, slot);
      return undefined;
    }
    return slot;
  }

  private createSlot(lane: AgentLane, cwd: string | undefined, settingsRevision = this.settingsRevision): TerminalSlot {
    const terminal = createManagedTerminal(lane.name, cwd);
    this.slotGeneration += 1;
    const slot: TerminalSlot = {
      terminal,
      generation: this.slotGeneration,
      settingsRevision,
      integration: 'waiting',
      capture: 'unprobed',
      state: 'idle',
      external: new Set(),
      observedRevision: 0,
      idleWaiters: new Set(),
    };
    lane.slot = slot;
    this.slotsByTerminal.set(terminal, slot);
    return slot;
  }

  private forgetSlot(lane: AgentLane, slot: TerminalSlot): void {
    if (lane.slot === slot) lane.slot = undefined;
    this.slotsByTerminal.delete(slot.terminal);
    slot.state = 'closed';
  }

  /** Take a slot out of use, terminate its tree and dispose its terminal; report what was observed. */
  private async retireSlot(lane: AgentLane, slot: TerminalSlot): Promise<ProcessTerminationOutcome> {
    slot.state = 'stopping';
    if (lane.slot === slot) lane.slot = undefined;
    this.slotsByTerminal.delete(slot.terminal);
    const outcome = await this.stopTerminal(slot.terminal);
    slot.state = 'closed';
    return outcome;
  }

  /**
   * Wait for shell integration AND its reported folder. A shell reports its folder shortly after integration
   * activates, through another change event, so both are awaited within the one integration bound. On the bound
   * the integration is returned as it is: a folder still missing then fails the folder check, never passes it.
   */
  private waitForIntegration(slot: TerminalSlot, signal: AbortSignal): Promise<vscode.TerminalShellIntegration | undefined> {
    const ready = () => slot.terminal.shellIntegration?.cwd !== undefined;
    if (ready()) return Promise.resolve(slot.terminal.shellIntegration);
    return new Promise((resolve) => {
      let done = false;
      const subscriptions: vscode.Disposable[] = [];
      const finish = (value: vscode.TerminalShellIntegration | undefined) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const subscription of subscriptions) {
          try { subscription.dispose(); } catch { /* already disposed */ }
        }
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      subscriptions.push(vscode.window.onDidChangeTerminalShellIntegration((event) => {
        if (event.terminal === slot.terminal && ready()) finish(event.shellIntegration);
      }));
      subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
        if (terminal === slot.terminal) finish(undefined);
      }));
      const onAbort = () => finish(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => finish(slot.terminal.shellIntegration), SHELL_INTEGRATION_TIMEOUT_MS);
    });
  }

  private waitForExternalIdle(slot: TerminalSlot, signal: AbortSignal): Promise<boolean> {
    if (slot.external.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        slot.idleWaiters.delete(wake);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const wake = () => {
        if (slot.state === 'closed') finish(false);
        else if (slot.external.size === 0) finish(true);
      };
      const onAbort = () => finish(false);
      slot.idleWaiters.add(wake);
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => finish(slot.external.size === 0), SHELL_INTEGRATION_TIMEOUT_MS);
    });
  }

  /** The terminal's reported folder is the authorised one, physically. Only a local `file` URI can be checked. */
  private cwdMatches(expected: string, reported: vscode.Uri | undefined): Promise<boolean> {
    if (!reported || reported.scheme !== 'file') return Promise.resolve(false);
    return sameExecutionDirectory(expected, reported.fsPath, this.pathFlavor, this.realpath);
  }

  private stopTerminal(terminal: vscode.Terminal): Promise<ProcessTerminationOutcome> {
    const existing = this.terminalShutdowns.get(terminal);
    if (existing) { return existing; }
    const shutdown = this.terminateAndDisposeTerminal(terminal);
    this.terminalShutdowns.set(terminal, shutdown);
    return shutdown;
  }

  private async terminateAndDisposeTerminal(terminal: vscode.Terminal): Promise<ProcessTerminationOutcome> {
    let outcome: ProcessTerminationOutcome = terminal.exitStatus !== undefined
      ? { status: 'already-stopped' }
      : { status: 'unknown', detail: 'the terminal reported no process id' };
    try {
      const pid = await terminal.processId;
      if (pid !== undefined) { outcome = await this.deps.terminateProcessTree(pid); }
    } catch (error) {
      outcome = { status: 'unknown', detail: `the terminal process could not be stopped (${error instanceof Error ? error.message : String(error)})` };
    } finally {
      // Closing the terminal is mandatory whatever the tree termination observed.
      try { terminal.dispose(); } catch { /* already closed */ }
    }
    return outcome;
  }
}

const PROBE_TEXT: Readonly<Record<ProbeGrammar, (tag: string) => string>> = {
  powershell: (tag) => `Write-Output ('${tag}:' + $PSHOME + ':' + $PSVersionTable.PSEdition)`,
  posix: (tag) => `printf '%s:%s\\n' '${tag}' "\${0##*/}"`,
  cmd: (tag) => `echo ${tag}:%COMSPEC%`,
};

function parseProbe(grammar: ProbeGrammar, tag: string, text: string): { kind: CommandShellKind; inner?: string } | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith(`${tag}:`));
  if (lines.length !== 1) return undefined;
  const value = lines[0].slice(tag.length + 1);
  switch (grammar) {
    case 'powershell': {
      const match = /^(.+):(Desktop|Core)$/.exec(value);
      if (!match || !match[1].trim()) return undefined;
      return { kind: match[2] === 'Core' ? 'pwsh' : 'windows-powershell' };
    }
    case 'posix': {
      const kind = posixShellKindFromBasename(value);
      return kind ? { kind, inner: kind } : undefined;
    }
    case 'cmd':
      return /cmd\.exe$/i.test(value) && !/%COMSPEC%/i.test(value) ? { kind: 'cmd' } : undefined;
  }
}
