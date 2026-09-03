/*---------------------------------------------------------------------------------------------
 *  UnodeAi - SessionManager
 *  Owns the lifecycle of agent sessions and is the bridge between the MessageBus and the
 *  per-agent backend processes.
 *
 *  This is the piece that makes inter-agent communication real:
 *    - Inbound:  a MessageBus message addressed to an agent  -> backend.sendUserTurn()
 *    - Outbound: a backend's turn_complete                   -> MessageBus terminal event
 *  Without both directions wired, "agents talking to each other" is just a log panel.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'events';
import * as path from 'path';
import {
  AgentConfig,
  AgentModelParams,
  ChatMode,
  ContextMeterState,
  ContextWindowUsage,
  DelegationTaskScope,
  Message,
  MessageType,
  ModelTier,
  SessionEvent,
  SessionInfo,
  SessionStatus,
  TaskWorkspaceAccess,
} from '../types';
import { MessageBus } from '../bus/MessageBus';
import { AgentBackend, BackendEvent, BackendFactory, ConversationSnapshot, TurnAttachments } from '../backend/AgentBackend';
import { classifyToolFailure } from '../backend/toolSummary';
import { backendReportsContextWindow } from '../backend/backendKind';
import { CompactOutcome, unavailableReasonForMeter } from './compactOutcome';
import { Summarizer, SummarizerIO } from './Summarizer';
import { TaskTokenTracker } from './TaskTokenTracker';
import { parseTodos } from '../backend/Todos';
import type { TurnContext } from '../backend/AgentBackend';
import { resolveRuntimeSystemPrompt } from '../roles/PromptTemplateState';
import { migrateAgentConfigOrRepair, withRouteModel } from '../routes/RouteMigration';
import { BUILTIN_CONNECTION_REGISTRY, ConnectionResolver } from '../routes/ConnectionRegistry';
import {
  appendContextManifestSource,
  DelegationContentSource,
  TurnContextManifest,
} from './TurnContextManifest';
import { WorkerTaskProgressRecord, WorkerTaskProgressTracker } from './WorkerTaskProgress';
import { TurnTimingTracker } from './TurnTiming';
import {
  compareEffectiveExecutionIdentities,
  type EffectiveExecutionIdentity,
  type EffectiveExecutionIdentityComparison,
} from './EffectiveExecutionIdentity';
import type { TaskAttemptCard } from '../backend/TaskContract';
import type { ReviewPolicyPreflightDecision } from '../policy/ReviewPolicyPreflight';
import { isCoordinator, resolveCoordinatorId } from './CoordinatorIdentity';

/**
 * Typed payloads per event, so listeners get real types instead of `any`.
 * `fire()` always emits a SessionEvent; `data` is narrowed by the event key here.
 */
export interface SessionEventData {
  'session.created': undefined;
  'session.removed': undefined;
  'session.started': { status: SessionStatus };
  'session.stopped': { exitCode: number | null };
  'session.error': { error: string };
  'session.output': { stream: 'stdout' | 'stderr'; content: string };
  'session.stream': { delta: string; epoch: number };
  'session.reasoning': { delta: string; epoch: number };
  'session.tool': {
    phase: 'use' | 'result';
    name: string;
    input?: unknown;
    ok?: boolean;
    summary?: string;
    detail?: string;
    diff?: string;
    failureKind?: 'blocked' | 'not_found' | 'error';
    epoch: number;
    /** The inbound bus thread that caused this tool use, when the host can prove one. */
    correlationId?: string;
  };
  'session.context': TurnContext;
  /** A read-only inventory of what this exact turn received; independent of provider usage reporting. */
  'session.contextManifest': { manifest: TurnContextManifest; epoch: number; correlationId?: string };
  /** A temporary delegation scope survived host intersection and is now active for this task turn. */
  'session.taskScopeApplied': { handle: string; scope: DelegationTaskScope };
  'session.compacted': { dropped: number; model: string };
  /** A provider refused a request for size; the ceiling it proved is now on the agent config. */
  'session.contextWindowObserved': { model: string; tokens: number };
  'session.status': { status: SessionStatus };
  'session.modelSwitched': { from: string; to: string; reason: string };
  /** Start was deferred because the concurrency cap is full; it will auto-start when a slot frees. */
  'session.queued': { reason: string };
  /** A user-initiated task finished; its per-agent token usage was recorded (Dashboard "Latest tasks"). */
  'session.taskTokens': { taskId: string };
  /** Phase A: a completed correlated worker task's host-observed progress record. */
  'session.taskProgress': { correlationId: string; progress: WorkerTaskProgressRecord };
}

/** Re-exported so existing importers (e.g. DashboardProvider) keep their import path. */
export type { TaskTokenRecord } from './TaskTokenTracker';

/** Cap on retained per-task token records. */
const MAX_TASK_TOKEN_RECORDS = 50;

export type SessionManagerEvent = keyof SessionEventData;

/** A SessionEvent whose `data` is narrowed to the payload for event `K`. */
export interface TypedSessionEvent<K extends SessionManagerEvent> extends SessionEvent {
  data: SessionEventData[K];
}

/** A framework-framed async delegation result waiting to wake an idle coordinator. */
export interface AsyncDelegationWakeResult {
  handle: string;
  ref: string;
  text: string;
  /** Host-owned run id. Different runs must never be collapsed into one PM wake turn. */
  runId?: string;
}

interface QueuedAsyncDelegationWake {
  result: AsyncDelegationWakeResult;
  /** Re-check just before injection: cancellation or await_tasks may have won while this was queued. */
  isReady: () => boolean;
  /** Consumes the TeamTools pending entry only after this manager started the PM turn. */
  consume: () => boolean;
}

/** Consecutive turn failures before we switch an agent to its fallback model (P1#6). */
const FALLBACK_AFTER_FAILURES = 2;
/** Cap on retained cost-timeline samples (for the Dashboard trend sparkline). */
const MAX_COST_SAMPLES = 240;
/** Chat Stop must acknowledge immediately; backend cleanup continues out of band. */
const INTERRUPT_FORCE_STOP_MS = 1500;
const USER_CANCELLED_TURN = 'Stopped by user.';
const DEFAULT_DELEGATION_PROGRESS_HEARTBEAT_MS = 300_000;

interface DelegatedProgressHeartbeat {
  activity: string;
  activityIdentity?: string;
  epoch: number;
  observedToolActions: number;
  announcedToolActions: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Visible worker phases are restricted to host-observed lifecycle events. */
type DelegatedWorkerPhase = 'request-open' | 'tool-running' | 'tool-loop-ended' | 'cancellation-requested';

/** Message types that should be delivered to an agent as a new task turn. */
const ACTIONABLE_INBOUND: ReadonlySet<MessageType> = new Set<MessageType>([
  'task.assign',
  'handoff',
  'review.request',
  'review.feedback',
  'ask.question',
  // A DIRECTED inter-agent message (send_message) is delivered as a turn so the recipient actually
  // reads it. Broadcasts (to '*') are filtered out in routeInbound — they stay informational.
  'agent.message',
]);

export interface SessionManagerDeps {
  /** Produces a backend for a config (defaults to ClaudeHeadlessBackend in extension wiring). */
  createBackend: BackendFactory;
  /** Resolves the process env (incl. API keys from SecretStorage) for a given agent. */
  resolveEnv: (config: AgentConfig) => Promise<NodeJS.ProcessEnv>;
  /** Worktree fan-out (v0.6.x): resolve the sandbox root for this agent's run, e.g. a per-agent git
   *  worktree path. Called at start, before the backend is built; the returned path becomes the
   *  agent's workingDirectory (so all its file ops are isolated there). Return undefined to use the
   *  agent's normal working directory. Best-effort — a throw/undefined falls back to the normal root. */
  resolveWorkingDirectory?: (config: AgentConfig) => Promise<string | undefined>;
  /** Worktree fan-out (v0.6.x): notified when an agent finishes a turn, so the host can commit +
   *  merge that agent's worktree into the integration branch. Fire-and-forget (must not block). */
  onTurnComplete?: (agentId: string, isError: boolean) => void;
  /** Load a saved conversation snapshot for an agent (L2 crash recovery). Optional. */
  loadSnapshot?: (agentId: string) => ConversationSnapshot | undefined;
  /** Persist an agent's conversation snapshot after each completed turn. Optional. */
  saveSnapshot?: (agentId: string, snapshot: ConversationSnapshot) => void;
  /** Drop a persisted snapshot (on agent removal). Optional. */
  clearSnapshot?: (agentId: string) => void;
  /** Estimate USD cost from token usage when a backend reports tokens but no cost. Optional. */
  /** `cachedInputTokens` is a SUBSET of `inputTokens` (prefix-cache hits, ~1/10 the price). */
  estimateCost?: (
    model: string, inputTokens: number, outputTokens: number, providerId?: string, cachedInputTokens?: number
  ) => number | undefined;
  /** A top-tier premium model id (e.g. claude-opus-4-8) used as the "all-premium" cost baseline for the
   *  savings comparison. The same tokens are priced against this to show what mixed routing saved. */
  premiumCostModel?: string;
  /** Resolve effective model/sampling params for an agent's turn (F2). Optional. */
  resolveModelParams?: (config: AgentConfig, smartTierParams?: AgentModelParams) => AgentModelParams;
  /** Smart Mode (F3): pick the model this task should run at; applied via setModel before the turn.
   *  Return undefined to leave the agent on its current model. */
  resolveTaskModel?: (config: AgentConfig, msg: Message) => string | undefined;
  /** Smart Mode (F2/F3): optional tier-level params for the selected task tier. */
  resolveTaskModelParams?: (config: AgentConfig, msg: Message) => AgentModelParams | undefined;
  /** Host-selected routing tier for this turn. This is a host fact, never a reported model identity. */
  resolveTaskTier?: (config: AgentConfig, msg: Message) => ModelTier | undefined;
  /** Captures host-private route facts for one selected model; never placed on any public session shape. */
  resolveEffectiveExecutionIdentity?: (config: AgentConfig, reportedModelId: string) => EffectiveExecutionIdentity | undefined;
  /** Final host-policy gate for an exact attempt and its request-scoped execution identity. */
  admitTaskExecution?: (attempt: TaskAttemptCard, identity?: EffectiveExecutionIdentity) => ReviewPolicyPreflightDecision;
  /** Records content-free review observation facts after an admitted attempt reaches a terminal result. */
  onTaskAttemptTerminal?: (attemptId: string) => void;
  /** Resolve a requested delegation scope into the already-intersected roots a backend may use. */
  resolveTaskWorkspaceAccess?: (config: AgentConfig, msg: Message) => { access?: TaskWorkspaceAccess; reason?: string };
  /** Interval for a host-derived delegated-work heartbeat. Tests may shorten it; production defaults to 5 min. */
  delegationProgressHeartbeatMs?: number;
  /** Session Memory (F4): current project/team context attached to each turn. Backends keep volatile
   *  context out of their cached system prefix while preserving its authority. */
  getProjectContext?: () => string;
  /** Build the context disclosure record from host-owned sources without changing prompt assembly. */
  getTurnContextManifest?: (config: AgentConfig, message: Message, projectContext: string) => TurnContextManifest;
  /** Optional host-side workspace context gatherer (opt-in): returns a formatted string to attach to turns.
   *  Provided by the extension wiring when `unode.engine.workspaceContext` is enabled. */
  /** @param root the agent's runtime working directory (worktree/workspace) so an isolated worker is
   *  grounded to its ACTUAL tool root, not the global workspace. */
  getWorkspaceContext?: (root?: string) => Promise<string | undefined> | string | undefined;
  /** v0.2.0 E1: summarizer injected into backends that support history compaction. */
  summarizer?: Summarizer;
  summarizerIO?: (config: AgentConfig) => SummarizerIO;
  summarizerModel?: (config: AgentConfig) => string;
  /** Current host-owned registry snapshot used when persisting/restoring dynamic connection routes. */
  connectionResolver?: () => ConnectionResolver;
}

export class SessionManager {
  private emitter = new EventEmitter();
  private sessions = new Map<string, SessionInfo>();
  /** The one host-selected coordinator, retained by id rather than inferred from capabilities. */
  private coordinatorAgentId: string | undefined;
  private backends = new Map<string, AgentBackend>();
  private backendDisposers = new Map<string, () => void>();
  private busDisposers = new Map<string, () => void>();
  /** The message currently being worked on by a session, so we can reply to its sender. */
  private pendingOrigin = new Map<string, Message>();
  /** Latest unfinished model-reported plan for the active turn. An unfinished plan is progress, not a completion. */
  private incompletePlanActivity = new Map<string, string>();
  /** Turns queued for a session that is not yet ready. */
  private inbox = new Map<string, Message[]>();
  /** Results that landed together; flush as one normal PM turn instead of a notification storm. */
  private asyncDelegationWakes = new Map<string, Map<string, QueuedAsyncDelegationWake>>();
  private asyncDelegationWakeFlushes = new Set<string>();
  /** Sessions whose start was deferred by the concurrency cap; drained FIFO as slots free. */
  private pendingStarts: string[] = [];
  /**
   * A backend can acknowledge an open human-consent surface before its start promise settles.  This
   * lets `start()` return a visible, actionable state instead of awaiting a modal forever, while the
   * same backend start continues in the background until the human answers.
   */
  private consentStartSignals = new Map<string, { backend: AgentBackend; resolve: () => void }>();
  /** Consecutive failed turns per session, for model-fallback (reset on success). */
  private consecutiveErrors = new Map<string, number>();
  /** Model actually used for the turn in flight; Smart Mode can choose it without mutating config. */
  private pendingTurnModel = new Map<string, string>();
  /** Host-selected routing tier for the active turn; used only by host-owned memory stamping. */
  private pendingTurnTier = new Map<string, ModelTier>();
  /** Host-private identity for the turn currently producing output. */
  private pendingTurnExecutionIdentity = new Map<string, EffectiveExecutionIdentity>();
  /** Last completed turn per session; in-process only and intentionally not serialised with snapshots. */
  private completedTurnExecutionIdentity = new Map<string, EffectiveExecutionIdentity>();
  /** Per-session streaming fence. A real new turn/cancel bumps this; steer/interject does not. */
  private turnEpochs = new Map<string, number>();
  private activeTurnEpochs = new Map<string, number>();
  /** Rolling cumulative-cost timeline samples for the Dashboard trend (cost in USD over time). */
  private costTimeline: Array<{ t: number; cost: number }> = [];
  /** Per-task token usage for the Dashboard "Latest tasks" panel. A "task" = one user turn (from:'user')
   *  and all the delegated sub-work it triggered; attribution is by origin so concurrent user tasks on
   *  different agents never double-count. */
  private taskTokens = new TaskTokenTracker(MAX_TASK_TOKEN_RECORDS);
  /** Phase A only: records worker progress without participating in scheduling or enforcement. */
  private workerTaskProgress = new WorkerTaskProgressTracker();
  /** Transcript timing is observational: it neither retries nor changes a completed turn. */
  private turnTiming = new TurnTimingTracker();
  /** message id → the task id it was bound to at dispatch (so a queued delegation inherits the right task
   *  even if its delegator's turn already ended). Cleared when the turn starts or the recipient is removed. */
  private pendingMsgTask = new Map<string, string>();
  /** A heartbeat is permitted only after a host-observed tool action, never from worker prose alone. */
  private delegatedProgressHeartbeats = new Map<string, DelegatedProgressHeartbeat>();
  private readonly delegationProgressHeartbeatMs: number;

  constructor(
    private maxConcurrent: number,
    private bus: MessageBus,
    private deps: SessionManagerDeps
  ) {
    this.delegationProgressHeartbeatMs = Math.max(1_000, deps.delegationProgressHeartbeatMs ?? DEFAULT_DELEGATION_PROGRESS_HEARTBEAT_MS);
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = n;
    // Raising the cap should let queued agents start now; drain respects the new cap so a
    // lowered cap is a no-op here (running agents finish naturally).
    this.drainPendingStarts();
  }

  /** Host-only inspection for a live or just-completed turn. This returns no prompt or ledger shape. */
  effectiveExecutionIdentity(sessionId: string): EffectiveExecutionIdentity | undefined {
    return this.pendingTurnExecutionIdentity.get(sessionId) ?? this.completedTurnExecutionIdentity.get(sessionId);
  }

  /** Host-only routing fact for the active turn; it is never copied into transcript or evidence shapes. */
  currentTurnTier(sessionId: string): ModelTier | undefined {
    return this.pendingTurnTier.get(sessionId);
  }

  /** Compare only the two facts P1 records; callers choose any later policy from them explicitly. */
  compareEffectiveExecutionIdentity(
    leftSessionId: string,
    rightSessionId: string,
  ): EffectiveExecutionIdentityComparison | undefined {
    const left = this.effectiveExecutionIdentity(leftSessionId);
    const right = this.effectiveExecutionIdentity(rightSessionId);
    return left && right ? compareEffectiveExecutionIdentities(left, right) : undefined;
  }

  /**
   * Switch an agent's model at runtime. For the in-process OpenAICompatBackend this takes effect
   * on the very next turn (it reads config.model each request) — no restart, context preserved.
   * Returns false if the agent is unknown or already on that model. (Foundation for tier hot-swap
   * and the fallback path below.)
   */
  setModel(sessionId: string, model: string): boolean {
    const info = this.sessions.get(sessionId);
    if (!info || !model || info.config.model === model) {
      return false;
    }
    info.config = withRouteModel(info.config, model);
    // The running backend holds its own config copy (runtime system-prompt / baseUrl resolution clone it),
    // so push the change there too — otherwise the swap never reaches the in-flight agent.
    this.backends.get(sessionId)?.setModel?.(model);
    return true;
  }

  /**
   * L3 agent-robustness escalation: move an agent onto its configured fallback model so a
   * persistently-refusing/empty worker gets one more attempt on a (typically stronger) model. Returns
   * the outcome so the caller can tell the user precisely what happened. Does not retry the turn itself.
   */
  escalateToFallback(sessionId: string): { switched: boolean; reason: 'switched' | 'no-fallback' | 'already-on-fallback' | 'unknown-agent'; from?: string; to?: string } {
    const info = this.sessions.get(sessionId);
    if (!info) {
      return { switched: false, reason: 'unknown-agent' };
    }
    const fallback = info.config.fallbackModel;
    if (!fallback) {
      return { switched: false, reason: 'no-fallback' };
    }
    if (info.config.model === fallback) {
      return { switched: false, reason: 'already-on-fallback' };
    }
    const from = info.config.model;
    this.setModel(sessionId, fallback);
    this.consecutiveErrors.set(sessionId, 0);
    this.fire('session.modelSwitched', sessionId, 'status_change', {
      from,
      to: fallback,
      reason: 'teammate returned nothing usable; escalated to fallback model',
    });
    return { switched: true, reason: 'switched', from, to: fallback };
  }

  /** Cumulative-cost samples (oldest→newest) for the Dashboard cost trend. */
  getCostTimeline(): ReadonlyArray<{ t: number; cost: number }> {
    return this.costTimeline;
  }

  // ─── Registration ───────────────────────────────────────────────────

  create(config: AgentConfig): SessionInfo {
    const migrated = migrateAgentConfigOrRepair(
      config,
      this.deps.connectionResolver?.() ?? BUILTIN_CONNECTION_REGISTRY,
    ).config;
    const info: SessionInfo = {
      id: migrated.id,
      config: migrated,
      status: migrated.routeRepair ? 'error' : 'stopped',
      ...(migrated.routeRepair ? { errorMessage: migrated.routeRepair } : {}),
      restartCount: 0,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0, premiumCostUsd: 0 },
    };
    this.sessions.set(info.id, info);
    if (!this.coordinatorAgentId && info.config.role === 'pm') {
      this.coordinatorAgentId = info.id;
    }

    // Subscribe this session to messages addressed to it (the bus also delivers '*' broadcasts).
    const dispose = this.bus.subscribe({ to: info.id }, (msg) => this.routeInbound(info.id, msg));
    this.busDisposers.set(info.id, dispose);

    this.fire('session.created', info.id, 'start');
    return info;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  async start(sessionId: string): Promise<SessionInfo> {
    const info = this.sessions.get(sessionId);
    if (!info) {
      throw new Error(`Session '${sessionId}' not found`);
    }
    if (info.config.routeRepair) {
      info.status = 'error';
      info.errorMessage = info.config.routeRepair;
      this.fire('session.error', sessionId, 'status_change', { error: info.config.routeRepair });
      throw new Error(info.config.routeRepair);
    }
    if (info.status === 'running' || info.status === 'starting' || info.status === 'consent_required' || info.status === 'idle') {
      return info;
    }
    if (this.getRunningCount() >= this.maxConcurrent) {
      // B1: don't fail — queue the start and auto-resume when a running session frees a slot.
      if (!this.pendingStarts.includes(sessionId)) {
        this.pendingStarts.push(sessionId);
      }
      info.pendingStart = true;
      const reason = `Max concurrent agents (${this.maxConcurrent}) reached`;
      this.fire('session.queued', sessionId, 'status_change', { reason });
      return info;
    }
    // If we're starting it now, it's no longer waiting on a slot.
    this.pendingStarts = this.pendingStarts.filter((id) => id !== sessionId);
    info.pendingStart = false;

    info.status = 'starting';
    info.errorMessage = undefined;
    info.consentMessage = undefined;
    info.startedAt = new Date().toISOString();
    this.fire('session.status', info.id, 'status_change', { status: info.status });

    // Derive runtime role additions without mutating the stored config. Volatile project/team context is
    // attached to each turn below, rather than interpolated into this cacheable system-prompt prefix.
    const runConfig = this.withRuntimeSystemPrompt(info.config);
    // Worktree fan-out (v0.6.x): isolate this agent in its own git worktree by rooting it there.
    // Best-effort — if assignment fails we fall back to the agent's normal working directory.
    if (this.deps.resolveWorkingDirectory) {
      try {
        const wd = await this.deps.resolveWorkingDirectory(info.config);
        if (wd) { runConfig.workingDirectory = wd; }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('Folder Access cannot be combined with worktree mode')) {
          info.status = 'error';
          info.errorMessage = message;
          this.fire('session.error', info.id, 'error', { error: message });
          this.drainPendingStarts();
          throw err;
        }
        /* fall back to the normal root */
      }
    }
    // Record the ACTUAL root the backend/tools will use (worktree path or current workspace) as the single
    // runtime truth — used for workspace grounding, chat preflight, diagnostics. Not persisted to the roster.
    if (info.status !== 'starting') {
      return info;
    }
    info.runtimeWorkingDirectory = runConfig.workingDirectory;
    // createBackend can throw synchronously (e.g. the route capability guard rejects the agent). It was
    // OUTSIDE the try below, so a throw left the session pinned in 'starting' with the error only in the log —
    // the "stuck STARTING, no error shown" symptom. Surface it as 'error' like every other start failure.
    let backend;
    try {
      backend = this.deps.createBackend(runConfig);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      info.status = 'error';
      info.errorMessage = message;
      this.fire('session.error', info.id, 'error', { error: message });
      this.drainPendingStarts();
      throw err;
    }
    this.backendDisposers.get(sessionId)?.();
    this.backends.set(sessionId, backend);
    this.backendDisposers.set(sessionId, backend.onEvent((evt) => this.onBackendEvent(info, backend, evt)));

    // L2 recovery: seed the backend with its prior conversation (before start) so a restart/crash
    // doesn't wipe the agent's context.
    const snapshot = this.deps.loadSnapshot?.(sessionId);
    if (snapshot && backend.restore) {
      backend.restore(snapshot);
    }

    try {
      const env = await this.deps.resolveEnv(info.config);
      if (this.backends.get(sessionId) !== backend || info.status !== 'starting') {
        return info;
      }

      // P0's approval contract distinguishes quick delivery/liveness acknowledgement from the human
      // decision window.  Apply that here too: if Claude has opened a model-egress consent dialog, return
      // an actionable state immediately while retaining the original start promise for the eventual Allow
      // or Cancel.  There is intentionally no human-response timeout.
      let signalConsentRequired!: () => void;
      const consentRequired = new Promise<'consent_required'>((resolve) => {
        signalConsentRequired = () => resolve('consent_required');
      });
      this.consentStartSignals.set(sessionId, { backend, resolve: signalConsentRequired });
      const startPromise = backend.start(env);
      const outcome = await Promise.race([
        startPromise.then(
          () => ({ kind: 'started' as const }),
          (error) => ({ kind: 'failed' as const, error }),
        ),
        consentRequired.then((kind) => ({ kind })),
      ]);

      if (outcome.kind === 'consent_required') {
        // Keep observing the exact same start.  A later Allow launches normally; a Cancel takes the
        // established start-error route.  This detached observer always consumes rejection so it cannot
        // become an unhandled promise after `start()` has already returned the pending lifecycle state.
        void this.finishConsentGatedStart(info, backend, startPromise);
        return info;
      }

      this.clearConsentStartSignal(sessionId, backend);
      if (outcome.kind === 'failed') {
        throw outcome.error;
      }
      if (this.backends.get(sessionId) !== backend) {
        void backend.stop(INTERRUPT_FORCE_STOP_MS).catch(() => undefined);
        return info;
      }
      info.pid = backend.pid;
      return info;
    } catch (err) {
      this.clearConsentStartSignal(sessionId, backend);
      if (this.backends.get(sessionId) !== backend) {
        return info;
      }
      this.failBackendStart(info, err);
      throw err;
    }
  }

  async stop(sessionId: string, forceTimeoutMs = 10000): Promise<void> {
    this.cancelPendingStart(sessionId);
    const info = this.sessions.get(sessionId);
    if (!info || info.status === 'stopped' || info.status === 'stopping') {
      return;
    }
    info.status = 'stopping';
    this.fire('session.status', info.id, 'status_change', { status: info.status });
    // A stopped worker cannot leave its coordinator's delegation promise (or its task-token slot)
    // hanging until the timeout. Publish the same terminal cancellation shape as Interrupt before the
    // backend begins graceful shutdown, so TeamTools releases its live async-capacity slot immediately.
    this.cancelActiveTurn(sessionId, USER_CANCELLED_TURN);

    const backend = this.backends.get(sessionId);
    if (backend) {
      await backend.stop(forceTimeoutMs);
      // Claude can be awaiting a consent dialog before it has a process to emit `exit`.  Stop still needs
      // to settle the lifecycle now; Claude's cancellation guard prevents a later human click from spawning
      // an orphaned process.
      if (this.backends.get(sessionId) === backend && !backend.isAlive()) {
        this.onBackendEvent(info, backend, { kind: 'exit', code: null });
      }
    }
    // The backend 'exit' event flips status to 'stopped' and cleans up.
  }

  /** Finish a consent-gated start after the human answers without blocking the original caller. */
  private async finishConsentGatedStart(
    info: SessionInfo,
    backend: AgentBackend,
    startPromise: Promise<void>,
  ): Promise<void> {
    try {
      await startPromise;
      if (this.backends.get(info.id) !== backend) {
        void backend.stop(INTERRUPT_FORCE_STOP_MS).catch(() => undefined);
        return;
      }
      info.pid = backend.pid;
    } catch (err) {
      if (this.backends.get(info.id) === backend) {
        this.failBackendStart(info, err);
      }
    } finally {
      this.clearConsentStartSignal(info.id, backend);
    }
  }

  private clearConsentStartSignal(sessionId: string, backend: AgentBackend): void {
    if (this.consentStartSignals.get(sessionId)?.backend === backend) {
      this.consentStartSignals.delete(sessionId);
    }
  }

  /** One shared terminal path for immediate start failures and a declined pending consent. */
  private failBackendStart(info: SessionInfo, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    info.status = 'error';
    info.errorMessage = message;
    info.consentMessage = undefined;
    this.backends.delete(info.id);
    this.backendDisposers.get(info.id)?.();
    this.backendDisposers.delete(info.id);
    this.fire('session.error', info.id, 'error', { error: message });
    this.drainPendingStarts();
  }

  async restart(sessionId: string): Promise<SessionInfo> {
    const info = this.sessions.get(sessionId);
    if (!info) {
      throw new Error(`Session '${sessionId}' not found`);
    }
    await this.stop(sessionId);
    info.restartCount++;
    return this.start(sessionId);
  }

  async remove(sessionId: string): Promise<void> {
    await this.stop(sessionId);
    this.busDisposers.get(sessionId)?.();
    this.busDisposers.delete(sessionId);
    this.backendDisposers.get(sessionId)?.();
    this.backendDisposers.delete(sessionId);
    this.backends.delete(sessionId);
    this.pendingOrigin.delete(sessionId);
    // Cancel still-queued (never-run) turns for this agent and release their reserved task-token slots, so a
    // removed worker can't keep its root task open forever.
    this.cancelQueuedTaskWork(sessionId);
    this.pendingStarts = this.pendingStarts.filter((id) => id !== sessionId);
    this.consecutiveErrors.delete(sessionId);
    this.pendingTurnExecutionIdentity.delete(sessionId);
    this.completedTurnExecutionIdentity.delete(sessionId);
    this.pendingTurnTier.delete(sessionId);
    this.turnEpochs.delete(sessionId);
    this.activeTurnEpochs.delete(sessionId);
    this.asyncDelegationWakes.delete(sessionId);
    this.asyncDelegationWakeFlushes.delete(sessionId);
    this.taskTokens.removeSession(sessionId); // drop any in-flight task tag / rooted task so it can't leak
    this.sessions.delete(sessionId);
    if (this.coordinatorAgentId === sessionId) {
      this.coordinatorAgentId = resolveCoordinatorId(this.getAll().map((session) => session.config));
    }
    this.deps.clearSnapshot?.(sessionId);
    this.fire('session.removed', sessionId, 'stop');
  }

  async startAll(): Promise<SessionInfo[]> {
    const results: SessionInfo[] = [];
    for (const info of this.sessions.values()) {
      if (info.status === 'stopped' || info.status === 'error') {
        try {
          results.push(await this.start(info.id));
        } catch {
          /* respect concurrency cap / surface per-agent errors elsewhere */
        }
      }
    }
    return results;
  }

  async stopAll(): Promise<void> {
    this.pendingStarts = [];
    for (const info of this.sessions.values()) {
      info.pendingStart = false;
    }
    await Promise.allSettled(Array.from(this.sessions.keys()).map((id) => this.stop(id)));
  }

  // ─── Queries ────────────────────────────────────────────────────────

  get(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  getAll(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /** The durable roster's first PM is the single coordinator for this live team. */
  coordinatorId(): string | undefined {
    return this.coordinatorAgentId;
  }

  /** Host-only inspection seam for non-persistent per-session diagnostics such as capability observations. */
  getBackend(sessionId: string): AgentBackend | undefined {
    return this.backends.get(sessionId);
  }

  /** The exact bus thread the session is currently executing, never inferred from the agent identity. */
  currentTurnCorrelationId(sessionId: string): string | undefined {
    const origin = this.pendingOrigin.get(sessionId);
    return origin?.correlationId ?? origin?.id;
  }

  /** The most recent user-initiated tasks (newest first), with per-agent token breakdown. Drives the
   *  Dashboard "Latest tasks" panel. */
  getRecentTaskTokens(limit = 10): ReturnType<TaskTokenTracker['recent']> {
    return this.taskTokens.recent(limit);
  }

  /**
   * Record product-observed human time for the task this session is currently executing. Approval
   * prompts live outside SessionManager, so the extension calls this only after a decision/timeout.
   */
  recordApprovalOutcome(sessionId: string | undefined, waitMs: number, denied: boolean): void {
    if (!sessionId) { return; }
    this.taskTokens.recordApproval(sessionId, waitMs, denied);
    this.turnTiming.recordApproval(sessionId, waitMs);
  }

  /** Resolve a workflow reference that may be either a concrete session id or a role key. */
  resolveByRoleOrId(ref: string): SessionInfo | undefined {
    return this.sessions.get(ref) ?? this.getAll().find((s) => s.config.role === ref);
  }

  getRunningCount(): number {
    let count = 0;
    for (const info of this.sessions.values()) {
      if (info.status === 'running' || info.status === 'starting' || info.status === 'consent_required' || info.status === 'idle') {
        count++;
      }
    }
    return count;
  }

  isRunning(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)?.status;
    return s === 'running' || s === 'starting' || s === 'consent_required' || s === 'idle';
  }

  private currentTurnEpoch(sessionId: string): number {
    return this.turnEpochs.get(sessionId) ?? 0;
  }

  private bumpTurnEpoch(sessionId: string, requested?: unknown): number {
    const current = this.currentTurnEpoch(sessionId);
    const requestedEpoch = normalizeEpoch(requested);
    const next = Math.max(current + 1, requestedEpoch ?? 0);
    this.turnEpochs.set(sessionId, next);
    return next;
  }

  interrupt(sessionId: string, reason = USER_CANCELLED_TURN): void {
    const info = this.sessions.get(sessionId);
    const backend = this.backends.get(sessionId);
    if (!info) {
      return;
    }
    if (info.status !== 'running' && info.status !== 'starting') {
      return;
    }
    this.bumpTurnEpoch(sessionId);
    this.activeTurnEpochs.delete(sessionId);
    // Invariant: backend.abort() must not synchronously emit content deltas. Late async events are
    // dropped by the backend identity guard after deletion below; sync abort deltas would otherwise
    // fall back to the new current epoch and look current.
    backend?.abort?.();
    this.cancelActiveTurn(sessionId, reason);
    this.backendDisposers.get(sessionId)?.();
    this.backendDisposers.delete(sessionId);
    this.backends.delete(sessionId);
    info.status = 'stopped';
    info.pid = undefined;
    info.currentTask = undefined;
    this.fire('session.stopped', sessionId, 'stop', { exitCode: null });
    this.drainPendingStarts();
    if (backend) {
      void backend.stop(INTERRUPT_FORCE_STOP_MS).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.fire('session.output', sessionId, 'message', {
          stream: 'stderr',
          content: `Background cleanup after Stop failed: ${message}`,
        });
      });
    }
  }

  /**
   * Cancel exactly one delegated assignment by its correlation handle. This never chooses work by
   * agent id alone: a reused worker may be running a different delegation when the coordinator stops.
   * It covers both an active turn and an assignment still waiting in that worker's inbox.
   */
  cancelDelegation(sessionId: string, handle: string, reason: string): boolean {
    const origin = this.pendingOrigin.get(sessionId);
    if (origin && (origin.correlationId ?? origin.id) === handle) {
      this.interrupt(sessionId, reason);
      // A lifecycle race can leave the turn origin present while its status is already terminal. The
      // correlation is still exact, so settle it rather than waiting for a backend event that cannot arrive.
      if (this.pendingOrigin.get(sessionId) === origin) {
        this.cancelActiveTurn(sessionId, reason);
      }
      return true;
    }

    const queue = this.inbox.get(sessionId);
    const index = queue?.findIndex((message) => (message.correlationId ?? message.id) === handle) ?? -1;
    if (index < 0 || !queue) {
      return false;
    }
    const [queued] = queue.splice(index, 1);
    if (queue.length === 0) {
      this.inbox.delete(sessionId);
    }
    const taskId = this.pendingMsgTask.get(queued.id);
    if (taskId) {
      this.pendingMsgTask.delete(queued.id);
      const record = this.taskTokens.cancelPending(taskId);
      if (record) { this.fire('session.taskTokens', sessionId, 'message', { taskId: record.id }); }
    }
    this.bus.send(
      sessionId,
      queued.from ?? 'user',
      'system.error',
      { instruction: reason, metadata: { isError: true, cancelled: true } },
      'normal',
      handle,
    );
    return true;
  }

  /**
   * Mid-run steering: a user message sent while an agent is busy.
   *
   * DESIGN: a user message ALWAYS goes on the MessageBus — the bus is the single record of "what was said",
   * so the message is persisted, visible in history, and auditable. Mid-turn steering is only a DELIVERY
   * STRATEGY chosen in routeInbound, never a way to bypass the record.
   *
   * The old code called `this.backends.get(id)?.interject?.(text)` and nothing else. That was broken twice:
   *  - `interject` is OPTIONAL and ClaudeHeadlessBackend does not implement it, so for a Claude agent the
   *    call was a NO-OP — the message was SILENTLY DISCARDED, never queued, never answered.
   *  - Even for OpenAICompat (which does implement it), interject only pushed onto a private in-memory array
   *    inside the backend. It never reached the bus, so the message never appeared in the message history.
   * Both symptoms are the same root cause: the steering path bypassed the bus. It no longer does.
   */
  interjectAgent(sessionId: string, text: string): void {
    const t = (text ?? '').trim();
    if (!t) {
      return;
    }
    // On the bus first. routeInbound decides HOW it is delivered (steer mid-turn / run now / queue).
    this.bus.send('user', sessionId, 'ask.question', { instruction: t, metadata: { steer: true } });
  }

  /**
   * Queue a just-settled delegation result for an idle coordinator. This is intentionally a normal
   * MessageBus turn, not a side channel: the PM can verify, delegate follow-up work, or report to the
   * user exactly as it would for any other input. The second idle check in the microtask closes the
   * gap between a teammate settling and the turn actually starting.
   *
   * Returns false when the coordinator is already busy. In that case the caller must leave the result
   * in TeamTools so the PM's own await_tasks call remains its single delivery path.
   */
  queueAsyncDelegationWake(
    sessionId: string,
    result: AsyncDelegationWakeResult,
    isReady: () => boolean,
    consume: () => boolean
  ): boolean {
    // Accept the entry even when the coordinator is BUSY. It used to be refused here, which made the
    // wake a single instantaneous attempt: a teammate that happened to finish mid-turn had its result
    // dropped on the floor, and nothing re-tried when the coordinator went idle a second later. The
    // documented fallback was that the PM would call `await_tasks` itself — i.e. the framework going
    // quiet unless the MODEL remembered to do something, which is the exact failure v0.9.34 exists to
    // remove. Retained entries are re-attempted at the next idle transition and pruned once
    // `await_tasks` or Stop claims them.
    if (!this.backends.has(sessionId)) {
      return false;
    }
    const queued = this.asyncDelegationWakes.get(sessionId) ?? new Map<string, QueuedAsyncDelegationWake>();
    queued.set(result.handle, { result, isReady, consume });
    this.asyncDelegationWakes.set(sessionId, queued);
    this.scheduleAsyncDelegationWake(sessionId);
    return true;
  }

  /** Results retained until the coordinator reaches an idle transition; presentation may show this count. */
  pendingAsyncDelegationWakeCount(sessionId: string): number {
    return this.asyncDelegationWakes.get(sessionId)?.size ?? 0;
  }

  private scheduleAsyncDelegationWake(sessionId: string): void {
    if (this.asyncDelegationWakeFlushes.has(sessionId)) {
      return;
    }
    this.asyncDelegationWakeFlushes.add(sessionId);
    queueMicrotask(() => this.flushAsyncDelegationWake(sessionId));
  }

  /** Re-attempt any wake retained while this coordinator was busy. Called on the idle transition. */
  private retryAsyncDelegationWake(sessionId: string): void {
    if ((this.asyncDelegationWakes.get(sessionId)?.size ?? 0) > 0) {
      this.scheduleAsyncDelegationWake(sessionId);
    }
  }

  // ─── Events ─────────────────────────────────────────────────────────

  on<K extends SessionManagerEvent>(event: K, listener: (e: TypedSessionEvent<K>) => void): void {
    this.emitter.on(event, listener as (e: SessionEvent) => void);
  }

  off<K extends SessionManagerEvent>(event: K, listener: (e: TypedSessionEvent<K>) => void): void {
    this.emitter.off(event, listener as (e: SessionEvent) => void);
  }

  dispose(): void {
    this.stopAll();
    for (const sessionId of this.delegatedProgressHeartbeats.keys()) {
      this.clearDelegatedProgressHeartbeat(sessionId);
    }
    this.busDisposers.forEach((d) => d());
    this.busDisposers.clear();
    this.backendDisposers.forEach((d) => d());
    this.backendDisposers.clear();
    this.sessions.clear();
    this.backends.clear();
    this.asyncDelegationWakes.clear();
    this.asyncDelegationWakeFlushes.clear();
    this.emitter.removeAllListeners();
  }

  // ─── Inbound: MessageBus -> backend ─────────────────────────────────

  private flushAsyncDelegationWake(sessionId: string): void {
    this.asyncDelegationWakeFlushes.delete(sessionId);
    const queued = this.asyncDelegationWakes.get(sessionId);
    if (!queued || queued.size === 0) {
      this.asyncDelegationWakes.delete(sessionId);
      return;
    }

    // `await_tasks` and Stop can claim/cancel a handle after this was queued but before this microtask
    // runs. Prune those unconditionally — including on the busy path — so a retained entry cannot be
    // delivered twice and the retained set cannot grow without bound.
    for (const [handle, entry] of queued) {
      if (!entry.isReady()) {
        queued.delete(handle);
      }
    }
    if (queued.size === 0) {
      this.asyncDelegationWakes.delete(sessionId);
      return;
    }

    // Busy: RETAIN rather than discard. retryAsyncDelegationWake picks these up when the turn ends.
    if (!this.isIdle(sessionId) || !this.backends.has(sessionId)) {
      return;
    }
    const allResults = [...queued.values()];
    // A PM may have more than one open run. Wake one run at a time and mark the turn with its opaque run id,
    // rather than merging unrelated results into one completion that no evidence ledger can attribute.
    const runId = allResults[0].result.runId;
    const results = runId
      ? allResults.filter((entry) => entry.result.runId === runId)
      : allResults.filter((entry) => !entry.result.runId);
    const sections = results.map(({ result }) => `=== ${result.ref} (${result.handle}) ===\n${result.text}`);
    const noun = results.length === 1 ? 'result' : 'results';
    const instruction = [
      `Async delegation ${noun} arrived. Continue as the PM: assess the framework evidence, do any needed verification or follow-up, then report the outcome to the user.`,
      sections.join('\n\n'),
    ].join('\n\n');

    // MessageBus delivery synchronously changes the session to running when it is still idle. That
    // state transition is our atomic claim; only then remove the TeamTools pending entries.
    this.bus.send('unode', sessionId, 'ask.question', {
      instruction,
      metadata: { autoWake: 'async-delegation-result' },
    }, 'normal', runId);
    if (this.sessions.get(sessionId)?.status === 'running') {
      for (const { result } of results) {
        queued.delete(result.handle);
      }
      if (queued.size === 0) {
        this.asyncDelegationWakes.delete(sessionId);
      }
      for (const { consume } of results) {
        consume();
      }
    }
    // If the send did NOT start a turn, the entries stay retained and are re-attempted on the next idle
    // transition. Deleting them here — which is what the original did unconditionally at the top of this
    // method — is how a result could be consumed by nobody.
  }

  private routeInbound(sessionId: string, msg: Message): void {
    // Never react to our own outgoing messages.
    if (msg.from === sessionId) {
      return;
    }
    if (!ACTIONABLE_INBOUND.has(msg.type)) {
      return;
    }
    // Broadcast messages (to '*') are informational only — never start a turn on every teammate.
    // Only a directed message becomes a turn. (A 'task.assign' is always directed.)
    if (msg.type === 'agent.message' && msg.to === '*') {
      return;
    }

    const backend = this.backends.get(sessionId);
    const info = this.sessions.get(sessionId);
    if (!info) {
      return;
    }

    // Per-task token tracking: bind a delegation to its root task NOW (at dispatch), not when the worker's
    // turn finally starts. The delegator is still in its turn here, so its task id is available; binding
    // later would lose it for an async delegation to a STOPPED/queued worker that the PM out-runs. Reserve
    // an active slot so the root task waits for this worker even if the PM finishes first.
    if (msg.from !== 'user') {
      const taskId = this.taskTokens.taskIdOf(msg.from);
      if (taskId) {
        this.pendingMsgTask.set(msg.id, taskId);
        this.taskTokens.markPending(taskId);
      }
    }

    // Deliver ONLY when the agent is idle — never while a turn is in flight. A single pendingOrigin
    // slot tracks the in-flight task's sender; delivering to a 'running' agent would overwrite it and
    // misroute both completions. Busy/starting/stopped → queue; flushInbox delivers the next on
    // turn_complete (one task at a time).
    const steerable =
      backend?.interject &&
      (msg.payload?.metadata as { steer?: boolean } | undefined)?.steer === true &&
      (info.status === 'running' || info.status === 'starting');

    if (backend && this.isIdle(sessionId)) {
      this.deliverTurn(sessionId, msg);
    } else if (steerable && backend!.interject!(String(msg.payload.instruction ?? ''))) {
      // A user message sent mid-turn, to a backend that CAN take it right now: fold it into the running turn.
      // It is already recorded on the bus (see interjectAgent), so it stays visible in history — we only chose
      // the faster delivery. If the backend REFUSES (returns false — e.g. its turn just ended, so the session
      // status is stale), we fall through to the inbox below and it is delivered as a normal turn. Backends
      // without interject at all (Claude) also fall through. Either way the message is never dropped.
    } else {
      // Queue and lazily start the session so a handoff to a stopped agent still lands.
      const q = this.inbox.get(sessionId) ?? [];
      q.push(msg);
      this.inbox.set(sessionId, q);
      if (info.status === 'stopped' || info.status === 'error') {
        this.start(sessionId).catch((err) => {
          this.fire('session.error', sessionId, 'error', { error: String(err) });
          // The lazy start failed, so these queued turns will never run — cancel them and release their
          // reserved task-token slots, or the root task's active count never reaches zero (it would never
          // appear in "Latest tasks" and the tracker would keep an open task forever).
          this.cancelQueuedTaskWork(sessionId);
        });
      }
    }
  }

  /** Cancel a session's still-queued (never-delivered) turns and release any per-task token slots reserved
   *  for them at dispatch. Use whenever those turns can't run (agent removed, lazy-start failed, queued work
   *  cancelled). Finalizes + notifies the Dashboard if releasing a slot completes a task. */
  private cancelQueuedTaskWork(sessionId: string): void {
    for (const queued of this.inbox.get(sessionId) ?? []) {
      const tid = this.pendingMsgTask.get(queued.id);
      if (!tid) { continue; }
      this.pendingMsgTask.delete(queued.id);
      const record = this.taskTokens.cancelPending(tid);
      if (record) { this.fire('session.taskTokens', sessionId, 'message', { taskId: record.id }); }
    }
    this.inbox.delete(sessionId);
  }

  private cancelActiveTurn(sessionId: string, reason: string): void {
    const origin = this.pendingOrigin.get(sessionId);
    const info = this.sessions.get(sessionId);
    if (origin && info) {
      // This is a phase receipt, not a completion: retain the correlation until the terminal
      // system.error below so a coordinator and the run ledger can account for this stop.
      this.publishDelegatedProgress(info, 'Cancellation requested.', this.currentTurnEpoch(sessionId), false, 'cancellation-requested');
    }
    const progress = this.workerTaskProgress.finish(sessionId, { text: reason, isError: true });
    if (progress) {
      this.fire('session.taskProgress', sessionId, 'message', {
        correlationId: progress.correlationId,
        progress,
      });
    }
    const timing = this.turnTiming.finish(sessionId);
    this.pendingOrigin.delete(sessionId);
    this.incompletePlanActivity.delete(sessionId);
    this.pendingTurnModel.delete(sessionId);
    this.pendingTurnTier.delete(sessionId);
    this.pendingTurnExecutionIdentity.delete(sessionId);
    this.cancelQueuedTaskWork(sessionId);

    const finished = this.taskTokens.endTurn(sessionId);
    if (finished) {
      this.fire('session.taskTokens', sessionId, 'message', { taskId: finished.id });
    }

    if (info) {
      info.currentTask = undefined;
      info.lastActiveAt = new Date().toISOString();
    }

    if (origin) {
      this.bus.send(
        sessionId,
        origin.from ?? 'user',
        'system.error',
        {
          instruction: reason,
          metadata: {
            isError: true,
            cancelled: true,
            turnEpoch: this.currentTurnEpoch(sessionId),
            ...(timing ? { turnTiming: timing } : {}),
          },
        },
        'normal',
        origin.correlationId ?? origin.id
      );
    }
  }

  private deliverTurn(sessionId: string, msg: Message): void {
    const backend = this.backends.get(sessionId);
    const info = this.sessions.get(sessionId);
    if (!backend || !info) {
      return;
    }
    const taskAccess = msg.payload.taskScope
      ? this.deps.resolveTaskWorkspaceAccess?.(info.config, msg)
      : undefined;
    if (msg.payload.taskScope && (!taskAccess?.access || taskAccess.reason)) {
      const taskId = this.pendingMsgTask.get(msg.id);
      if (taskId) {
        this.pendingMsgTask.delete(msg.id);
        const record = this.taskTokens.cancelPending(taskId);
        if (record) { this.fire('session.taskTokens', sessionId, 'message', { taskId: record.id }); }
      }
      this.bus.send(
        sessionId,
        msg.from,
        'system.error',
        {
          instruction: taskAccess?.reason ?? 'Task-scoped folder access is unavailable for this agent. The assignment was not started.',
          metadata: { isError: true, taskScope: true },
        },
        'normal',
        msg.correlationId ?? msg.id,
      );
      return;
    }
    // Smart Mode (F3): choose a model for this task without mutating the agent's configured model.
    // Persistent retunes still go through setModel(); Smart Mode is request-scoped.
    const taskModel = this.deps.resolveTaskModel?.(info.config, msg);
    const taskModelParams = this.deps.resolveTaskModelParams?.(info.config, msg);
    if (taskModel) {
      this.pendingTurnModel.set(sessionId, taskModel);
    } else {
      this.pendingTurnModel.delete(sessionId);
    }
    const effectiveModel = taskModel ?? info.config.model;
    const executionIdentity = this.deps.resolveEffectiveExecutionIdentity?.(info.config, effectiveModel);
    if (executionIdentity) {
      this.pendingTurnExecutionIdentity.set(sessionId, executionIdentity);
    } else {
      this.pendingTurnExecutionIdentity.delete(sessionId);
    }
    const taskAttempt = msg.payload.taskAttempt;
    if (taskAttempt && this.deps.admitTaskExecution) {
      const decision = this.deps.admitTaskExecution(taskAttempt, executionIdentity);
      if (!decision.allowed) {
        this.pendingTurnExecutionIdentity.delete(sessionId);
        this.pendingTurnModel.delete(sessionId);
        const taskId = this.pendingMsgTask.get(msg.id);
        if (taskId) {
          this.pendingMsgTask.delete(msg.id);
          const record = this.taskTokens.cancelPending(taskId);
          if (record) { this.fire('session.taskTokens', sessionId, 'message', { taskId: record.id }); }
        }
        this.bus.send(
          sessionId,
          msg.from,
          'system.error',
          {
            instruction: decision.reason,
            metadata: {
              isError: true,
              policyRefused: true,
              policyId: decision.policyId,
              policyDecision: decision.code,
            },
          },
          'normal',
          msg.correlationId ?? msg.id,
        );
        return;
      }
      this.bus.send(
        sessionId,
        msg.from,
        'task.admitted',
        { metadata: { policyId: decision.policyId, policyDecision: decision.code } },
        'normal',
        msg.correlationId ?? msg.id,
      );
    }
    const taskTier = this.deps.resolveTaskTier?.(info.config, msg);
    if (taskTier) {
      this.pendingTurnTier.set(sessionId, taskTier);
    } else {
      this.pendingTurnTier.delete(sessionId);
    }
    if (msg.payload.taskScope && taskAccess?.access) {
      this.fire('session.taskScopeApplied', sessionId, 'message', {
        handle: msg.correlationId ?? msg.id,
        scope: msg.payload.taskScope,
      });
    }
    this.clearDelegatedProgressHeartbeat(sessionId);
    const turnEpoch = this.bumpTurnEpoch(sessionId, msg.payload.metadata?.turnEpoch);
    this.activeTurnEpochs.set(sessionId, turnEpoch);
    this.incompletePlanActivity.delete(sessionId);
    // The bus timestamp is captured before a busy/stopped session queues this message. Using it here makes
    // queueing part of the human-visible turn duration while keeping approval waits separately accounted.
    this.turnTiming.begin(sessionId, msg.timestamp);
    if (msg.type === 'task.assign' && msg.from !== 'user') {
      this.workerTaskProgress.begin({
        sessionId,
        correlationId: msg.correlationId ?? msg.id,
        agentId: info.id,
        backend: info.config.backend ?? 'claude',
        model: taskModel ?? info.config.model,
      });
    }

    // A directed inter-agent message (send_message) carries its text in payload.message, not
    // payload.instruction; frame it so the recipient knows who it's from. Everything else uses
    // payload.instruction as before.
    const rawTurnText = msg.type === 'agent.message'
      ? `Message from ${msg.from}: ${msg.payload.message ?? msg.payload.instruction ?? ''}`
      : (msg.payload.instruction ?? '');
    const workflowBranchLabels = (msg.payload.workflowBranchLabels ?? [])
      .filter((label): label is string => typeof label === 'string' && label.length > 0);
    const baseTurnText = workflowBranchLabels.length > 0
      ? `${rawTurnText}\n\n[Workflow outcome] Before completing this step, call select_workflow_branch with exactly one of these declared labels if one applies: ${workflowBranchLabels.map((label) => JSON.stringify(label)).join(', ')}. If none applies, do not select a label; the workflow will continue linearly.`
      : rawTurnText;
    // Delegation is intentionally not a history fork. Only the non-rebuildable material the user supplied
    // on this turn gets an opaque content receipt; standing workspace knowledge is built independently for
    // every worker by the normal manifest/project-context path.
    const hasDelegationSourceContract = Object.prototype.hasOwnProperty.call(msg.payload, 'delegationContentSources');
    const turnText = msg.type === 'task.assign' && hasDelegationSourceContract
      ? `${baseTurnText}${delegatedSourceHandoff(msg.payload.delegationContentSources)}`
      : baseTurnText;

    this.pendingOrigin.set(sessionId, msg);
    // Per-task token tracking: a user turn (from:'user') ROOTS a new task; a delegated turn INHERITS the
    // task id of the agent that delegated it (msg.from). Tagging by origin (not a global usage snapshot)
    // means two user tasks running concurrently on different agents never count each other's tokens.
    if (msg.from === 'user') {
      this.taskTokens.startRoot(sessionId, turnText.slice(0, 160));
    } else {
      // Inherit the task id bound at dispatch (markPending already reserved the active slot there).
      const taskId = this.pendingMsgTask.get(msg.id);
      this.pendingMsgTask.delete(msg.id);
      this.taskTokens.startInheritedByTask(sessionId, taskId);
    }
    info.status = 'running';
    info.currentTask = turnText.slice(0, 120);
    info.lastActiveAt = new Date().toISOString();
    this.fire('session.status', sessionId, 'status_change', { status: 'running' });
    const projectContext = this.deps.getProjectContext?.() ?? '';
    let contextManifest = this.deps.getTurnContextManifest?.(info.config, msg, projectContext);
    const attachments: TurnAttachments = {
      mode: normalizeChatMode(msg.payload.mode),
      files: msg.payload.files,
      userAttachments: msg.payload.userAttachments,
      workflowBranchLabels,
      delegationContentSources: msg.payload.delegationContentSources,
      verificationPlan: msg.payload.verificationPlan,
      taskAttempt: msg.payload.taskAttempt,
      taskWorkspaceAccess: taskAccess?.access,
      context: msg.payload.context,
      expectedOutput: msg.payload.expectedOutput,
      model: taskModel,
      modelParams: this.deps.resolveModelParams?.(info.config, taskModelParams),
      projectContext,
      contextManifest,
    };
    const sendTurn = (): void => {
      if (contextManifest) {
        attachments.contextManifest = contextManifest;
        this.fire('session.contextManifest', sessionId, 'message', {
          manifest: contextManifest,
          epoch: turnEpoch,
          correlationId: this.currentTurnCorrelationId(sessionId),
        });
      }
      // This is the host-observed point at which the worker's provider request is open. We cannot
      // observe or label internal model thought.
      this.publishDelegatedProgress(
        info,
        `Provider request open: ${turnText.slice(0, 120) || 'assigned task'}.`,
        turnEpoch,
        false,
        'request-open',
      );
      backend.sendUserTurn(turnText, attachments);
    };

    // Preserve the original synchronous path unless context/summarization work is actually needed.
    if (!this.deps.getWorkspaceContext && !this.canSummarize(backend)) {
      sendTurn();
      return;
    }

    const workspaceContextPromise = this.deps.getWorkspaceContext
      ? Promise.resolve()
          .then(() => this.deps.getWorkspaceContext?.(info.runtimeWorkingDirectory))
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            this.fire('session.output', sessionId, 'message', {
              stream: 'stderr',
              content: `Workspace context gather skipped: ${message}`,
            });
            return undefined;
          })
      : Promise.resolve(undefined);

    void (async () => {
      if (this.canSummarize(backend)) {
        try {
          await this.summarizeIfNeeded(info, backend);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.fire('session.output', sessionId, 'message', {
            stream: 'stderr',
            content: `History summarization skipped: ${message}`,
          });
        }
      }

      const workspaceContext = await workspaceContextPromise;
      if (workspaceContext?.trim()) {
        attachments.workspaceContext = workspaceContext;
        if (contextManifest) {
          contextManifest = appendContextManifestSource(contextManifest, {
            kind: 'workspace-orientation',
            label: 'Workspace orientation',
            location: info.runtimeWorkingDirectory || 'agent runtime workspace',
            text: workspaceContext,
            reason: 'fixed workspace-grounding path',
          });
        }
      }
      sendTurn();
    })();
  }

  /** Context a session is carrying. Undefined when the backend cannot report it. */
  contextUsage(sessionId: string): ContextWindowUsage | undefined {
    return this.backends.get(sessionId)?.contextUsage?.();
  }

  /**
   * The same question, answered so the UI can say WHY there is no number.
   *
   * `contextUsage` returns undefined for two unrelated reasons — the agent has not been started, and the
   * runtime does not report a window — and the composer rendered both as a blank. A blank meter beside a
   * Compact button reads as a broken feature; it was reported as exactly that. The backend, when present,
   * is the authority; before one exists the config's runtime is.
   */
  contextMeter(sessionId: string): ContextMeterState | undefined {
    const info = this.sessions.get(sessionId);
    if (!info) {
      return undefined;
    }
    const backend = this.backends.get(sessionId);
    const usage = backend?.contextUsage?.();
    if (usage) {
      return { kind: 'usage', usage };
    }
    if (backend) {
      return { kind: 'unsupported' };
    }
    return backendReportsContextWindow(info.config) ? { kind: 'not-started' } : { kind: 'unsupported' };
  }

  /**
   * Compact because the user asked, and report what actually happened.
   *
   * Forced: the automatic path is gated on a threshold derived from the assumed context window, so on the
   * one conversation a gateway is already rejecting, the threshold has not tripped and a threshold-gated
   * compaction plans nothing. Reporting matters as much as forcing — a control that says "compacted" while
   * dropping nothing is worse than one that refuses, because the user stops looking for the real problem.
   */
  async compactSession(sessionId: string): Promise<CompactOutcome> {
    const info = this.sessions.get(sessionId);
    // A bare `supported: false` collapsed three conditions into one sentence, and the sentence it produced
    // was the wrong one for an agent that simply had not started yet — the composer said "start the agent"
    // while pressing the same action said "this backend manages its own context".
    if (!info) {
      return { supported: false, compacted: false, dropped: 0, reason: 'unknown-session' };
    }
    const backend = this.backends.get(sessionId);
    if (!backend || !this.canSummarize(backend)) {
      return {
        supported: false,
        compacted: false,
        dropped: 0,
        reason: unavailableReasonForMeter(this.contextMeter(sessionId)) ?? 'unsupported',
      };
    }
    const result = await backend.compactHistory!.call(
      backend,
      this.deps.summarizer!,
      this.deps.summarizerIO!(info.config),
      this.deps.summarizerModel!(info.config),
      { force: true }
    );
    return {
      supported: true,
      compacted: !!result && result.compacted,
      dropped: result && result.compacted ? result.dropped : 0,
    };
  }

  private async summarizeIfNeeded(info: SessionInfo, backend: AgentBackend): Promise<void> {
    if (!this.canSummarize(backend)) {
      return;
    }
    const compactHistory = backend.compactHistory!;
    await compactHistory.call(
      backend,
      this.deps.summarizer!,
      this.deps.summarizerIO!(info.config),
      this.deps.summarizerModel!(info.config)
    );
  }

  private canSummarize(backend: AgentBackend): boolean {
    return !!backend.compactHistory && !!this.deps.summarizer && !!this.deps.summarizerIO && !!this.deps.summarizerModel;
  }

  private flushInbox(sessionId: string): void {
    const q = this.inbox.get(sessionId);
    if (!q || q.length === 0) {
      return;
    }
    // Deliver one turn now; remaining turns are delivered as each completes (one task at a time).
    const next = q.shift()!;
    this.deliverTurn(sessionId, next);
  }

  /** Ready to accept a NEW turn right now: idle (started and not mid-turn). 'running' is NOT idle —
   *  a turn is in flight and its origin must not be overwritten (see routeInbound). */
  private isIdle(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.status === 'idle';
  }

  /**
   * Return a config whose system prompt has the worker-compliance protocol for non-coordinator agents.
   * Project/team context is intentionally excluded: it is volatile, timestamped shared state and belongs
   * on the per-turn attachment rather than inside the provider's cacheable system prefix. Never mutates
   * the stored config.
   */
  private withRuntimeSystemPrompt(config: AgentConfig): AgentConfig {
    const worker = workerComplianceProtocol(config, this.coordinatorId());
    const systemPrompt = resolveRuntimeSystemPrompt(config);
    if (!worker && systemPrompt === config.systemPrompt) {
      return config;
    }
    return { ...config, systemPrompt: systemPrompt + worker };
  }

  /**
   * B1: start any sessions deferred by the concurrency cap, FIFO, while slots remain. `start()` sets
   * status to 'starting' synchronously (before its first await), so getRunningCount() reflects each
   * launch immediately and we never exceed the cap within this loop.
   */
  private drainPendingStarts(): void {
    while (this.pendingStarts.length > 0 && this.getRunningCount() < this.maxConcurrent) {
      const next = this.pendingStarts.shift()!;
      const info = this.sessions.get(next);
      if (!info || info.status !== 'stopped') {
        if (info) {
          info.pendingStart = false;
        }
        continue; // removed, or already started by another path
      }
      this.start(next).catch((err) =>
        this.fire('session.error', next, 'error', { error: String(err) })
      );
    }
  }

  /** Remove a deferred start request when the user stops/removes the agent before it gets a slot. */
  private cancelPendingStart(sessionId: string): void {
    this.pendingStarts = this.pendingStarts.filter((id) => id !== sessionId);
    const info = this.sessions.get(sessionId);
    if (info) {
      info.pendingStart = false;
    }
  }

  // ─── Outbound: backend -> MessageBus + UI ───────────────────────────

  private onBackendEvent(info: SessionInfo, backend: AgentBackend, evt: BackendEvent): void {
    // Stop detaches the backend immediately and lets process cleanup finish in the background. Any
    // late events from that stale backend must not re-open UI state or publish old completions.
    if (this.backends.get(info.id) !== backend) {
      return;
    }
    const epoch = this.activeTurnEpochs.get(info.id) ?? this.currentTurnEpoch(info.id);
    switch (evt.kind) {
      case 'ready':
        info.status = 'idle';
        info.consentMessage = undefined;
        info.backendSessionId = evt.backendSessionId;
        info.pid = this.backends.get(info.id)?.pid;
        info.lastActiveAt = new Date().toISOString();
        this.fire('session.started', info.id, 'status_change', { status: 'idle' });
        this.flushInbox(info.id);
        break;

      case 'consent_required': {
        // The consent modal has been opened.  The backend's start promise is deliberately still
        // pending, but this status is immediately visible/actionable instead of masquerading as an
        // indefinitely-starting process.  A later ready/error completes the normal lifecycle.
        info.status = 'consent_required';
        info.consentMessage = evt.message || 'Consent is required before this agent can contact its model provider.';
        const pendingStart = this.consentStartSignals.get(info.id);
        if (pendingStart?.backend === backend) {
          pendingStart.resolve();
        }
        this.fire('session.status', info.id, 'status_change', { status: info.status });
        break;
      }

      case 'assistant':
        info.lastActiveAt = new Date().toISOString();
        this.fire('session.output', info.id, 'message', { stream: 'stdout', content: evt.text });
        break;

      case 'model_request':
        this.workerTaskProgress.noteModelRequest(info.id);
        break;

      case 'assistant_delta':
        info.lastActiveAt = new Date().toISOString();
        this.fire('session.stream', info.id, 'message', { delta: evt.delta, epoch });
        break;

      case 'reasoning_delta':
        info.lastActiveAt = new Date().toISOString();
        this.fire('session.reasoning', info.id, 'message', { delta: evt.delta, epoch });
        break;

      case 'tool_use':
        this.workerTaskProgress.noteToolUse(info.id, evt.name, evt.input);
        if (/^update_todos$/i.test(evt.name)) {
          const activity = unfinishedPlanActivity(evt.input);
          if (activity) {
            this.incompletePlanActivity.set(info.id, activity);
          } else {
            this.incompletePlanActivity.delete(info.id);
          }
        }
        {
          const activity = progressActivityForTool(
            evt.name,
            evt.input,
            info.runtimeWorkingDirectory ?? info.config.workingDirectory,
          );
          this.publishDelegatedProgress(info, activity.label, epoch, true, 'tool-running', activity.identity);
        }
        this.fire('session.tool', info.id, 'message', {
          phase: 'use',
          name: evt.name,
          input: evt.input,
          epoch,
          correlationId: this.currentTurnCorrelationId(info.id),
        });
        this.fire('session.output', info.id, 'message', {
          stream: 'stdout',
          content: `[tool: ${evt.name}]`,
        });
        break;

      case 'tool_result':
        this.workerTaskProgress.noteToolResult(info.id, evt.name, evt.ok);
        this.fire('session.tool', info.id, 'message', {
          phase: 'result',
          name: evt.name,
          ok: evt.ok,
          summary: evt.summary,
          detail: evt.detail,
          diff: evt.diff,
          failureKind: evt.failureKind ?? (evt.ok === false ? classifyToolFailure(`${evt.summary}\n${evt.detail ?? ''}`) : undefined),
          epoch,
          correlationId: this.currentTurnCorrelationId(info.id),
        });
        break;

      case 'watchdog_idle':
        // Claude's process is still alive here. The host cannot classify quiet thought versus a wedge,
        // so expiry is an explicit operational choice and deliberately reuses the normal interrupt path.
        this.interrupt(
          info.id,
          `Stopped: Claude produced no host-observed output, tool call, or approval request for ${Math.ceil(evt.idleMs / 1000)}s.`,
        );
        break;

      case 'compacted':
        this.fire('session.compacted', info.id, 'message', {
          dropped: evt.dropped,
          model: evt.model,
        });
        break;

      // A rejection for size is the only hard evidence we ever get about a model's real window. The backend
      // has already applied it to its own guard; writing it onto the config is what makes it survive the
      // session, so the next conversation on this agent starts with the truth rather than the assumption.
      case 'context_overflow':
        info.config.observedContextWindow = { model: evt.model, tokens: evt.tokens, observedAt: evt.observedAt };
        this.fire('session.contextWindowObserved', info.id, 'message', {
          model: evt.model,
          tokens: evt.tokens,
        });
        break;

      case 'turn_complete': {
        const progress = this.workerTaskProgress.finish(info.id, evt.result);
        if (progress) {
          this.fire('session.taskProgress', info.id, 'message', {
            correlationId: progress.correlationId,
            progress,
          });
        }
        const timing = this.turnTiming.finish(info.id);
        this.publishDelegatedProgress(info, 'Provider tool loop ended.', epoch, false, 'tool-loop-ended');
        this.clearDelegatedProgressHeartbeat(info.id);
        if (evt.result.usage) {
          const usage = evt.result.usage;
          const u = info.usage!;
          u.inputTokens += usage.inputTokens;
          u.outputTokens += usage.outputTokens;
          // Cached input is a SUBSET of inputTokens, tracked separately so the cost below can price it at the
          // cache rate (~1/10) instead of the full miss rate. Left undefined while no gateway has told us
          // anything: "we don't know" must not be shown as "0% cached".
          if (usage.cachedInputTokens !== undefined) {
            u.cachedInputTokens = (u.cachedInputTokens ?? 0) + usage.cachedInputTokens;
          }
          // Sticky: once ANY turn's numbers were reconstructed rather than reported, this session's running
          // totals are part guess and must not be displayed as if they were a bill.
          if (usage.estimated) {
            u.estimated = true;
          }
          // Prefer the backend's real cost (Claude); otherwise estimate from token usage + price table.
          const modelForCost = this.pendingTurnModel.get(info.id) ?? info.config.model;
          const providerForCost = info.config.provider?.providerId;
          const cost =
            usage.costUsd ??
            this.deps.estimateCost?.(
              modelForCost, usage.inputTokens, usage.outputTokens, providerForCost, usage.cachedInputTokens
            ) ??
            0;
          u.costUsd += cost;
          if (usage.costBasis === 'api-equivalent') {
            u.costBasis = 'api-equivalent';
          } else if (!u.costBasis && (usage.costUsd !== undefined || cost > 0)) {
            u.costBasis = usage.costBasis ?? 'billed';
          }
          // Premium baseline: the TRUE estimate of the same tokens on a top-tier model (always estimated,
          // even when the turn reported a real cost) so "all-premium vs mixed" is apples-to-apples. Store
          // it honestly — NOT max(premium, actual) — so the UI can show a real cost delta if mixed routing
          // ever came out pricier. Falls back to the actual cost only when no premium model/estimator wired.
          const premiumModel = this.deps.premiumCostModel;
          const premiumCost = (premiumModel
            ? this.deps.estimateCost?.(premiumModel, usage.inputTokens, usage.outputTokens, providerForCost)
            : undefined) ?? cost;
          u.premiumCostUsd = (u.premiumCostUsd ?? 0) + premiumCost;
          u.turns += 1;
          // Attribute THIS turn's usage to the task it belongs to (for the Dashboard "Latest tasks" panel).
          this.taskTokens.attribute(info.id, info.config.name, usage.inputTokens, usage.outputTokens, cost);
        }
        // Track per-turn success/failure for model fallback, and sample total cost for the trend.
        const completedIdentity = this.pendingTurnExecutionIdentity.get(info.id);
        if (completedIdentity) {
          this.completedTurnExecutionIdentity.set(info.id, completedIdentity);
        }
        this.pendingTurnExecutionIdentity.delete(info.id);
        this.pendingTurnModel.delete(info.id);
        this.pendingTurnTier.delete(info.id);
        this.activeTurnEpochs.delete(info.id);
        this.recordTurnOutcome(info, evt.result.isError);
        this.sampleCost();
        if (evt.result.context) {
          this.fire('session.context', info.id, 'status_change', evt.result.context);
        }
        // End this turn's task tag. If this session ROOTS the task, the whole orchestration (root turn +
        // everything it delegated) is finished → a record is returned, so notify the Dashboard.
        const finished = this.taskTokens.endTurn(info.id);
        if (finished) {
          this.fire('session.taskTokens', info.id, 'message', { taskId: finished.id });
        }
        info.status = 'idle';
        info.currentTask = undefined;

        // Persist the agent's conversation after each turn so a later restart resumes its context.
        const snap = this.backends.get(info.id)?.snapshot?.();
        if (snap) {
          this.deps.saveSnapshot?.(info.id, snap);
        }

        // Reply to whoever assigned this task, so workflows/askers get a completion.
        const origin = this.pendingOrigin.get(info.id);
        this.pendingOrigin.delete(info.id);
        const unfinishedActivity = this.incompletePlanActivity.get(info.id);
        this.incompletePlanActivity.delete(info.id);
        // Ending an LLM turn is not the same as completing its assigned task. Preserve the full report
        // while publishing the unfinished structured plan as an independent terminal fact.
        const replyType: MessageType = evt.result.isError || evt.result.unresolvedReason
          ? 'system.error'
          : unfinishedActivity && origin && origin.from !== 'user' && origin.to !== '*'
            ? 'task.partial'
          : 'task.complete';
        if (origin?.payload.taskAttempt) {
          this.deps.onTaskAttemptTerminal?.(origin.payload.taskAttempt.attemptId);
        }
        const terminalMetadata = {
          isError: evt.result.isError || !!evt.result.unresolvedReason,
          unresolvedReason: evt.result.unresolvedReason,
          midPlan: replyType === 'task.partial',
          usage: evt.result.usage,
          turnEpoch: epoch,
          delegationEvidence: evt.result.delegationEvidence,
          workflowBranchLabel: evt.result.workflowBranchLabel,
          ...(timing ? { turnTiming: timing } : {}),
        };
        if (replyType === 'task.partial') {
          this.bus.send(
            info.id,
            origin?.from ?? '*',
            'task.partial',
            {
              instruction: evt.result.text,
              metadata: {
                ...terminalMetadata,
                completionState: 'partial',
                unfinishedActivity: unfinishedActivity!,
              },
            },
            'normal',
            origin?.correlationId ?? origin?.id,
          );
        } else {
          this.bus.send(
            info.id,
            origin?.from ?? '*',
            replyType,
            { instruction: evt.result.text, metadata: terminalMetadata },
            'normal',
            origin?.correlationId ?? origin?.id,
          );
        }

        this.fire('session.status', info.id, 'status_change', { status: 'idle' });
        // Worktree fan-out: let the host merge this agent's worktree now that its turn is done.
        this.deps.onTurnComplete?.(info.id, evt.result.isError);
        this.flushInbox(info.id);
        // A teammate result that landed while this coordinator was mid-turn was retained rather than
        // dropped; this is where it gets its second chance. AFTER flushInbox on purpose — a queued user
        // turn outranks an auto-wake, and if one was delivered the session is running again, so the
        // wake correctly defers to the idle transition after THAT turn instead of racing it.
        this.retryAsyncDelegationWake(info.id);
        break;
      }

      case 'log':
        this.fire('session.output', info.id, 'message', { stream: evt.stream, content: evt.line });
        break;

      case 'error':
        info.errorMessage = evt.message;
        this.fire('session.error', info.id, 'error', { error: evt.message });
        // Only a DEAD backend frees a concurrency slot. A turn-level error (backend still alive) is
        // followed by turn_complete, which restores 'idle' — so marking 'error' or draining here would
        // release the slot mid-turn and let a queued agent breach maxConcurrent. Defer to 'exit' for
        // genuine death; only handle the no-following-turn_complete case (backend not alive).
        if (!this.backends.get(info.id)?.isAlive()) {
          info.status = 'error';
          info.consentMessage = undefined;
          this.drainPendingStarts();
        }
        break;

      case 'exit': {
        const progress = this.workerTaskProgress.finish(info.id, { text: '', isError: true });
        if (progress) {
          this.fire('session.taskProgress', info.id, 'message', {
            correlationId: progress.correlationId,
            progress,
          });
        }
        this.clearDelegatedProgressHeartbeat(info.id);
        const wasUnexpected = info.status !== 'stopping';
        info.status = 'stopped';
        info.consentMessage = undefined;
        info.pid = undefined;
        info.currentTask = undefined;
        this.activeTurnEpochs.delete(info.id);
        this.incompletePlanActivity.delete(info.id);
        this.backends.delete(info.id);
        this.clearConsentStartSignal(info.id, backend);
        this.backendDisposers.get(info.id)?.();
        this.backendDisposers.delete(info.id);
        this.fire('session.stopped', info.id, 'stop', { exitCode: evt.code });

        // Basic crash recovery: restart once-per-incident with backoff if configured.
        if (wasUnexpected && info.config.autoRestart && info.restartCount < 5) {
          info.restartCount++;
          setTimeout(() => {
            this.start(info.id).catch(() => undefined);
          }, Math.min(1000 * info.restartCount, 5000));
        }
        // A slot just freed — start anything queued by the concurrency cap (B1).
        this.drainPendingStarts();
        break;
      }
    }
  }

  /** A status update is intentionally a different bus event from a task completion. */
  private publishDelegatedProgress(
    info: SessionInfo,
    activity: string,
    epoch: number,
    observedToolAction = false,
    phase?: DelegatedWorkerPhase,
    activityIdentity?: string,
  ): void {
    const origin = this.pendingOrigin.get(info.id);
    if (!origin || origin.from === 'user' || origin.to === '*') {
      return;
    }
    let effectiveActivityIdentity = activityIdentity;
    if (observedToolAction) {
      const heartbeat = this.delegatedProgressHeartbeats.get(info.id) ?? {
        activity,
        epoch,
        observedToolActions: 0,
        announcedToolActions: 0,
      };
      heartbeat.activity = activity;
      heartbeat.epoch = epoch;
      heartbeat.observedToolActions += 1;
      // A reviewed path/program target has a stable identity and may fold. A target-less or untrusted tool
      // gets a host-local action identity instead: the heartbeat can update it, but two calls are never
      // merged on a fact the host did not observe.
      effectiveActivityIdentity ??= `${activity}\u0000action\u0000${epoch}:${heartbeat.observedToolActions}`;
      heartbeat.activityIdentity = effectiveActivityIdentity;
      this.delegatedProgressHeartbeats.set(info.id, heartbeat);
      this.scheduleDelegatedProgressHeartbeat(info, origin, heartbeat);
    }
    this.bus.send(
      info.id,
      origin.from,
      'task.status',
      {
        instruction: activity,
        metadata: {
          activity,
          ...(effectiveActivityIdentity ? { activityIdentity: effectiveActivityIdentity } : {}),
          turnEpoch: epoch,
          ...(phase ? { phase } : {}),
          ...(observedToolAction ? { progress: { source: 'tool', observed: true } } : {}),
        },
      },
      'low',
      origin.correlationId ?? origin.id,
    );
  }

  /**
   * A heartbeat means "the host saw more tool work since the last heartbeat", not "the worker says
   * it is alive". It deliberately does not carry the observed=true marker, so TeamTools never lets a
   * timer wake-up renew its own deadline.
   */
  private scheduleDelegatedProgressHeartbeat(info: SessionInfo, origin: Message, heartbeat: DelegatedProgressHeartbeat): void {
    if (heartbeat.timer) {
      return;
    }
    heartbeat.timer = setTimeout(() => {
      heartbeat.timer = undefined;
      const current = this.delegatedProgressHeartbeats.get(info.id);
      const activeOrigin = this.pendingOrigin.get(info.id);
      if (!current || current !== heartbeat || info.status !== 'running' || activeOrigin?.id !== origin.id) {
        return;
      }
      if (current.observedToolActions > current.announcedToolActions) {
        current.announcedToolActions = current.observedToolActions;
        this.bus.send(
          info.id,
          origin.from,
          'task.status',
          {
            instruction: `Still working: ${current.activity}`,
            metadata: {
              activity: current.activity,
              ...(current.activityIdentity ? { activityIdentity: current.activityIdentity } : {}),
              turnEpoch: current.epoch,
              progress: { source: 'heartbeat', observed: false, observedToolActions: current.observedToolActions },
            },
          },
          'low',
          origin.correlationId ?? origin.id,
        );
      }
      // Continue watching the running turn. The next interval is silent unless another tool action
      // happened; a timer alone is not evidence and must not masquerade as progress.
      this.scheduleDelegatedProgressHeartbeat(info, origin, current);
    }, this.delegationProgressHeartbeatMs);
  }

  private clearDelegatedProgressHeartbeat(sessionId: string): void {
    const heartbeat = this.delegatedProgressHeartbeats.get(sessionId);
    if (heartbeat?.timer) {
      clearTimeout(heartbeat.timer);
    }
    this.delegatedProgressHeartbeats.delete(sessionId);
  }

  /**
   * Model fallback (P1#6): count consecutive failed turns; once a primary model fails
   * FALLBACK_AFTER_FAILURES times in a row and a `fallbackModel` is configured, switch to it so a
   * persistently-down primary doesn't wedge the agent. A successful turn resets the counter.
   */
  private recordTurnOutcome(info: SessionInfo, isError: boolean): void {
    if (!isError) {
      this.consecutiveErrors.set(info.id, 0);
      return;
    }
    const n = (this.consecutiveErrors.get(info.id) ?? 0) + 1;
    this.consecutiveErrors.set(info.id, n);

    const fallback = info.config.fallbackModel;
    if (n >= FALLBACK_AFTER_FAILURES && fallback && info.config.model !== fallback) {
      const from = info.config.model;
      this.setModel(info.id, fallback);
      this.consecutiveErrors.set(info.id, 0);
      this.fire('session.modelSwitched', info.id, 'status_change', {
        from,
        to: fallback,
        reason: `primary model failed ${n} turns in a row`,
      });
    }
  }

  /** Append a cumulative-cost sample to the trend timeline (bounded). */
  private sampleCost(): void {
    const total = this.getAll().reduce((sum, s) => sum + (s.usage?.costUsd ?? 0), 0);
    this.costTimeline.push({ t: Date.now(), cost: total });
    if (this.costTimeline.length > MAX_COST_SAMPLES) {
      this.costTimeline.splice(0, this.costTimeline.length - MAX_COST_SAMPLES);
    }
  }

  private fire(event: SessionManagerEvent, sessionId: string, type: SessionEvent['type'], data?: unknown): void {
    this.emitter.emit(event, {
      type,
      sessionId,
      timestamp: new Date().toISOString(),
      data,
    } as SessionEvent);
  }
}

/**
 * The only delegation-specific context prompt. It names opaque, expiring source handles without copying
 * user text into the inter-agent message. In particular, a missing receipt is a stop signal: widening to
 * web search would turn an absent user fact into an invented substitute.
 */
export function delegatedSourceHandoff(sources: readonly DelegationContentSource[] | undefined): string {
  const safe = (sources ?? []).filter((source) =>
    /^content-[1-9]\d*$/.test(source.assetId) &&
    (source.kind === 'user-request' || source.kind === 'context-mention' || source.kind === 'user-attachment') &&
    (source.mediaKind === 'text' || source.mediaKind === 'pdf' || source.mediaKind === 'image')
  );
  const lines = [
    '',
    '[delegated user-supplied sources]',
  ];
  if (safe.length === 0) {
    lines.push('No user-supplied source was forwarded with this assignment. If this task depends on a user-provided fact, attachment, @ expansion, or prior conversation material, say that the required user-supplied source is missing and stop. Do not web-search for a user-supplied fact before reporting it missing.');
    return `\n\n${lines.join('\n')}`;
  }
  lines.push('These sources are addressable, not copied into this turn. Read only what the task needs:');
  for (const source of safe) {
    const size = source.textBytes !== undefined
      ? `${source.textBytes} text bytes`
      : source.bytes !== undefined ? `${source.bytes} bytes` : 'size unavailable';
    const access = source.mediaKind === 'image'
      ? 'request image analysis with send_image_asset_to_model only when that tool is available and its separate consent succeeds'
      : 'use read_extracted_content or search_extracted_content';
    lines.push(`- ${source.label || source.kind}: ${source.assetId} (${source.mediaKind}; ${size}; ${access}).`);
  }
  lines.push('If a source this task needs is not listed or cannot be read, report that missing source to the coordinator before widening reach. Do not web-search for a user-supplied fact before noting the missing source.');
  return `\n\n${lines.join('\n')}`;
}

function normalizeChatMode(mode: unknown): ChatMode {
  return mode === 'plan' ? 'plan' : 'act';
}

interface ProgressActivity {
  /** Bounded user-visible text. */
  label: string;
  /** Untruncated, but still export-safe, identity used only by the Activity projection. */
  identity?: string;
}

const PATH_ACTIVITY_TOOLS = new Set([
  'read_file', 'list_dir', 'search_files', 'read_skill_file', 'load_skill',
  'write_file', 'apply_edit', 'edit_file', 'delete_file', 'delete_dir',
]);

const COMMAND_ACTIVITY_TOOLS = new Set([
  'run_command', 'run_checks', 'bash', 'shell', 'sh', 'zsh', 'powershell', 'pwsh',
  'cmd', 'execute', 'exec', 'command', 'terminal',
]);

/**
 * A tool activity is a host-observed identifier plus a closed, non-secret target shape. It deliberately
 * contains no semantic phrase map: an unknown tool renders as its de-plumbed name without guessing intent.
 */
function progressActivityForTool(name: string, input: unknown, workspaceRoot?: string): ProgressActivity {
  const routed = routedToolName(name);
  const toolName = routed.tool || 'tool';
  const args = asUnknownRecord(input);

  if (mayShowPathTarget(routed, toolName)) {
    const target = safeWorkspaceRelativeTarget(args.path, workspaceRoot);
    if (target) {
      return {
        label: `${toolName} · ${truncatePathTarget(target)}`,
        identity: `${toolName}\u0000path\u0000${target}`,
      };
    }
  }

  if (mayShowCommandTarget(routed, toolName)) {
    const program = safeCommandProgram(args.command);
    if (program) {
      return {
        label: `${toolName} · ${program}`,
        identity: `${toolName}\u0000program\u0000${program}`,
      };
    }
  }

  return { label: toolName };
}

interface RoutedToolName {
  server?: string;
  tool: string;
}

function routedToolName(value: string): RoutedToolName {
  const original = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!original.toLowerCase().startsWith('mcp__')) {
    return { tool: original };
  }
  const parts = original.split('__');
  if (parts.length >= 3) {
    return { server: parts[1].toLowerCase(), tool: parts.slice(2).join('__') || 'tool' };
  }
  return { tool: original.slice(5) || 'tool' };
}

function mayShowPathTarget(routed: RoutedToolName, toolName: string): boolean {
  if (!PATH_ACTIVITY_TOOLS.has(toolName.toLowerCase())) {
    return false;
  }
  // Native workspace tools and the host-owned Claude MCP bridge have reviewed path schemas. An external
  // MCP tool with the same bare name is still rendered, but none of its arbitrary arguments are persisted.
  return routed.server === undefined || routed.server === 'unode_files';
}

function mayShowCommandTarget(routed: RoutedToolName, toolName: string): boolean {
  if (!COMMAND_ACTIVITY_TOOLS.has(toolName.toLowerCase())) {
    return false;
  }
  return routed.server === undefined || routed.server === 'unode_files' || routed.server === 'unode_team_bridge';
}

function safeWorkspaceRelativeTarget(value: unknown, workspaceRoot?: string): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const raw = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!raw || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return undefined;
  }

  const rawIsWindowsAbsolute = path.win32.isAbsolute(raw);
  const rawIsPosixAbsolute = path.posix.isAbsolute(raw);
  const windowsStyle = rawIsWindowsAbsolute
    || (!rawIsPosixAbsolute && !!workspaceRoot && path.win32.isAbsolute(workspaceRoot));
  const pathApi = windowsStyle ? path.win32 : path.posix;
  let relative = raw;
  if (pathApi.isAbsolute(raw)) {
    if (workspaceRoot && pathApi.isAbsolute(workspaceRoot)) {
      const candidate = pathApi.relative(pathApi.resolve(workspaceRoot), pathApi.resolve(raw));
      if (!candidate || candidate === '..' || candidate.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(candidate)) {
        return undefined;
      }
      relative = candidate;
    } else {
      return undefined;
    }
  }

  relative = pathApi.normalize(relative).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!relative || relative === '..' || relative.startsWith('../')) {
    return undefined;
  }
  return relative || undefined;
}

function truncatePathTarget(target: string, limit = 120): string {
  if (target.length <= limit) {
    return target;
  }
  const fileName = path.posix.basename(target);
  const suffix = `…/${fileName}`;
  const prefixLength = Math.max(12, limit - suffix.length);
  return `${target.slice(0, prefixLength).replace(/\/+$/, '')}${suffix}`;
}

function safeCommandProgram(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const tokens = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (const rawToken of tokens) {
    const token = rawToken.replace(/^['"]|['"]$/g, '').replace(/[;,]+$/g, '');
    if (!token || /^(?:&&?|\|\|?)$/.test(token)) {
      continue;
    }
    // POSIX and PowerShell leading environment assignments are data, not executable identities.
    if (/^(?:[A-Za-z_][A-Za-z0-9_]*|\$env:[A-Za-z_][A-Za-z0-9_]*)=/.test(token)) {
      continue;
    }
    const baseName = path.posix.basename(path.win32.basename(token));
    return baseName.replace(/[\u0000-\u001f\u007f]+/g, '') || undefined;
  }
  return undefined;
}

function asUnknownRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** A todo snapshot is model-reported, but it is an explicit enough signal to avoid a false completion. */
function unfinishedPlanActivity(input: unknown): string | undefined {
  const todos = parseTodos(input);
  const current = todos.find((todo) => todo.status === 'in_progress')
    ?? todos.find((todo) => todo.status === 'pending');
  return current ? `Still working on ${current.content}.` : undefined;
}

function normalizeEpoch(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/**
 * Agent robustness: a firm protocol injected into every NON-coordinator agent's system prompt, so a
 * delegated worker actually carries out the task it's handed instead of returning empty, replying with
 * only a plan/analysis, or telling the requester to run a script themselves. Coordinators (the PM /
 * any agent with the `delegate` tool) are excluded — they orchestrate, they don't execute. Phrased
 * to fit read-only roles too: a reviewer's "deliverable" is its PASS/FAIL verdict, not an edit.
 * Returns '' for coordinators. Exported for unit testing.
 */
// The coordinator id is required rather than defaulted. A default that resolved it from this one config
// would make every `role: 'pm'` its own coordinator, quietly restoring the behaviour W4 removed.
export function workerComplianceProtocol(
  config: AgentConfig,
  coordinatorId: string | undefined,
): string {
  const coordinator = isCoordinator(config, coordinatorId);
  // Applies to EVERY agent — coordinator, worker, or solo. The single most common dogfood failure is an
  // agent stating a fact (a version, a config value, file contents) it remembers from an earlier turn or
  // session, which has since changed. Force a fresh read before citing.
  const freshRead = `

## Cite from a fresh read, never from memory (required)
Before you state any fact about the project — a version number, a config value, file contents, whether
something exists, or current status — READ it THIS turn with read_file (or search_files). The workspace
and files change between turns and sessions, so your memory of an earlier read may be stale. Never
present a remembered or assumed value as if you verified it ("I read this directly…") unless you
actually read it in this turn. If you haven't checked, say so or go check first.`;
  if (coordinator) {
    return freshRead + coordinatorDelegationProtocol();
  }
  return freshRead + `

## Ground the task in the REAL code before you act (required)
An instruction tells you the INTENT — it is not a literal script to type out blindly. Weak execution
looks like this: read the instruction, immediately start writing code, never look at what's actually
there. Do NOT work that way. Before you change anything:
- READ the actual files the task touches and understand how they work RIGHT NOW — the real structure,
  types, naming, patterns, and where the relevant logic lives. Use read_file / search_files first.
- RECONCILE the instruction with what you found. Adapt it to the real code (its actual APIs, conventions,
  and file layout). Do NOT invent a function, file, import, or pattern the codebase doesn't use, and do
  NOT assume the layout — confirm it.
- If the instruction CONFLICTS with reality (it names something that moved, was renamed, or never
  existed), STOP and say so, quoting the specific lines you just read — don't force a change that doesn't
  fit, and don't paper over the mismatch.
- MATCH the surrounding code: follow the patterns already in the file you're editing, not a generic
  template from memory.
Going straight from instruction → code without first reading the source it touches is the single most
common way a task gets done wrong. Understand the current code first, THEN make the change.

## Carrying out an assigned task (required)
When the PM or a teammate assigns you a task, it is a direct instruction from your coordinator — not a
suggestion. Do it now:
- Actually DO the work with your tools. If the task needs code, read the relevant files and then make
  the change with write_file (and verify with run_command). Produce the concrete deliverable the task
  asks for — do not reply with only a plan, only analysis, or "here's what you should do".
- You are the one assigned. Do NOT tell the requester to run a command or make the change themselves.
  If a script needs running, YOU run it (use the project's own scripts; don't invent commands).
- Stay on the task you were given. If you believe it's the wrong task, say so briefly, then still do
  the closest correct thing you can.
- Check reality before claiming "already done". Before you say a task is already complete or needs no
  changes, READ the relevant file(s) with read_file to confirm their CURRENT contents. Never rely on
  your memory of an earlier change — the files may differ from what you recall.
- Make the checks pass by fixing the CODE, never by weakening the tests. Do NOT edit, delete, or loosen
  a test (e.g. changing an assertion to match buggy output) just to make it go green. If a test is
  genuinely wrong, say so explicitly and explain why — never silently neuter it to pass.
- Work in small, verifiable steps: make the smallest change that satisfies the task, verify it, then
  stop. Don't bundle in unrelated edits.
- Keep your todo list honest. If you're tracking steps with update_todos, before you report the task
  done make sure the list reflects reality — mark the FINAL step completed too. Don't leave a step
  showing "in progress" after you've actually finished it.
- Only report that you cannot proceed if you are genuinely blocked — and then state the exact blocker
  (the specific file, command, or error). Never hand back a vague "the environment is broken" or an
  empty response; that is treated as a failure to do the work.
- ACT, don't just announce. NEVER end your message by saying you are *about to* do something (e.g.
  "let me read the file", "I'll run the tests now") and then stop. If you say you will use a tool,
  issue that tool call in the SAME message. Stopping after an announcement stalls the whole team and
  forces the user to prod you — which is a failure. Do the action, then report the result.`;
}

/**
 * Delegation rules for a coordinator, appended at RUNTIME rather than baked into the role template.
 *
 * WHY THIS EXISTS: an agent's `systemPrompt` is copied out of its role template at creation and then
 * PERSISTED (extension.ts `systemPrompt: template.systemPrompt`; SessionManager runs `config.systemPrompt`).
 * So editing a role template only ever reaches agents created AFTER the edit — every existing user's PM keeps
 * whatever guidance shipped the day they made it, and no reload or upgrade changes that. A field report caught
 * exactly this: the delegation rule was fixed, but a PM created earlier kept blocking on assign_task and the
 * user could not reach it. Any delegation rule we improve must therefore be appended HERE (so it reaches every
 * agent, old and new) and must explicitly SUPERSEDE the frozen copy still sitting in an old prompt.
 */
export function coordinatorDelegationProtocol(): string {
  return [
    '',
    '## How to delegate (required — SUPERSEDES any earlier delegation instruction in this prompt)',
    'These rules OVERRIDE anything stated earlier about which delegation tool to use.',
    '- DEFAULT: call **dispatch_task** with a complete version-1 Task Contract, then **END YOUR TURN**. The contract—not the instruction prose—declares objective, deliverable, read files, write scope, inputs with purpose/provenance/freshness, constraints, artifact dependencies, verification sensors, required capabilities and execution strategy.',
    '- Use execution_strategy delegate-preferred normally, delegate-required when fallback is forbidden, and coordinator-only only when decomposition is not worthwhile. Coordinator fallback is host-filtered; there is no bounce-count permission escape.',
    '- Recover decisions from your own conversation log when needed, then declare only settled decisions in contract constraints. Never forward conversation history or let a worker read yours.',
    '- There is no blocking delegation tool in your model-visible schema. Do not wait in this turn for a dependency. When a result settles, UnodeAi opens the next PM turn automatically.',
    '- **collect_ready_tasks** is an optional inspection tool: it returns only results that already settled and never waits. Use it only when you are already handling related work in this turn.',
    '- When a delegated result is settled, dispose it before ending the turn: record the coordinator decision (accepted, rework, deferred, superseded, or needs-human) and then continue, gate, or report.',
    '- When a delegate reports that a user-supplied source is missing, say that source is missing before widening reach. Do not web-search for a user-supplied fact before noting the missing source.',
    '- Independent tasks use non-overlapping contract write scopes. Read files are context pointers, never write grants. Sequential work passes only explicit artifact-ready dependencies with provenance.',
  ].join('\\n');
  /* Legacy frozen-prompt copy retained only as a migration record; it is not returned to a PM.
  return `

## How to delegate (required — SUPERSEDES any earlier delegation instruction in this prompt)
These rules OVERRIDE anything stated earlier about which delegation tool to use.
- DEFAULT: dispatch with **assign_task_async**, then **END YOUR TURN** with one line — e.g. "dispatched to
  <role>; ask me anything meanwhile, I'll report when it's back". Ending the turn after an async dispatch is
  CORRECT, not stopping early: it keeps you reachable, so the user can talk to you while the teammate works.
- You do NOT need to block to get the result. When it lands and you are idle you are woken automatically with
  the framework's evidence — verify, continue the plan, or report to the user then.
- When a delegated result is settled, dispose it before ending the turn: record the coordinator decision
  (accepted, rework, deferred, superseded, or needs-human) and then continue, gate, or report. A settled
  result with no disposition is unfinished coordination, even when a check has already passed.
- Use the BLOCKING **assign_task** ONLY when you genuinely need the teammate's output to keep working IN THIS
  SAME TURN. It holds your turn open, so the user CANNOT reach you until the teammate finishes. Having only a
  single task is NOT a reason to block.
- Independent tasks on non-overlapping files: assign_task_async once per teammate, then end the turn.`;
}
*/
}
