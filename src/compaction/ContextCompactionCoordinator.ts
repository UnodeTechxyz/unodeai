/*---------------------------------------------------------------------------------------------
 *  UnodeAi - context compaction coordinator (v0.9.90 Smart compaction design, §4.2, §5.1, §5.2)
 *
 *  Owns the pre-dispatch gate for one agent: resolve its policy for the model that will serve the turn, project
 *  the next request, and — at or over the trigger — run exactly one bounded compaction before the task is sent.
 *  Every branch ends with the task sent; the trigger never refuses work. There is one compaction per agent at a
 *  time, a 180-second budget, and session-long failure suppression while the request fits the model window.
 *--------------------------------------------------------------------------------------------*/

import type { AgentConfig, ContextMeterCompaction } from '../types';
import type { TurnAttachments } from '../backend/AgentBackend';
import type {
  BackgroundCompaction,
  ContextCompactionRequest,
  ContextCompactionResult,
  ContextControl,
  ContextProjection,
} from '../backend/ContextControl';
import {
  compactionSizing,
  formatTokens,
  type ResolvedSmartCompactionPolicy,
  type SmartCompactionResolution,
  type TriggerTerm,
} from './SmartCompactionPolicy';
import { compactionUsageSink, type CompactionSpendPort, type CompactionUsageCoverage } from './CompactionUsage';

/** One host-owned record of a successful compaction (design §5.1). */
export interface CompactionReceipt {
  version: 1;
  id: string;
  agentId: string;
  policy: {
    mode: ResolvedSmartCompactionPolicy['mode'];
    profile?: ResolvedSmartCompactionPolicy['profile'];
    policyRevision: string;
    resolutionSource?: ResolvedSmartCompactionPolicy['resolutionSource'];
    windowPercent: number;
    ceilingTokens: number;
    recentTailTokens: number;
    postCompactTargetTokens: number;
    routeEvidenceCapTokens?: number;
    activeTriggerTokens?: number;
    winningTerm?: TriggerTerm;
  };
  trigger: TriggerTerm | 'manual';
  mechanism: 'host-history' | 'native-runtime';
  before: ContextProjection;
  after: ContextProjection;
  replacedMessages?: number;
  carriedForward?: Array<{ kind: string; count: number }>;
  /** Host-history only: the tokens kept word for word (instructions, tools, carried records, newest turns). */
  keptTokens?: number;
  summaryVisibility: 'included' | 'runtime-private';
  summary?: string;
  usage: {
    usageUnitIds: string[];
    coverage: CompactionUsageCoverage | 'parent-turn';
    parentUsageUnitId?: string;
  };
  createdAt: string;
}

export interface CompactionGateInput {
  agentId: string;
  config: AgentConfig;
  control: ContextControl;
  /** The request the compaction's cost belongs to: the pending task's, or a manual Compact's own. */
  requestId: string;
  /** The model that will serve the turn (a Smart Mode or fallback model, not the roster default). */
  modelId: string;
  pendingTurn?: { instruction: string; attachments?: TurnAttachments };
  cause: 'automatic' | 'manual';
  /** Aborts the operation when the user stops the turn it is gating. */
  signal?: AbortSignal;
}

export type CompactionGateOutcome =
  | { kind: 'not-needed'; reason: 'off' | 'below-trigger' | 'projection-unavailable' | 'route-not-admitted' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'suppressed' }
  | { kind: 'skipped'; reason: 'below-trigger' | 'nothing-droppable' | 'runtime-managed' | 'too-little-to-gain' }
  | { kind: 'failed'; reason: Extract<ContextCompactionResult, { kind: 'failed' }>['reason'] | 'stopped'; detail: string }
  | { kind: 'compacted'; receipt: CompactionReceipt };

/**
 * v0.9.99: what the gate decided for one turn. `outcomes` are reported in order (an applied background compaction,
 * then the gate's own). `startBackground` starts a captured background summary; the caller calls it once the turn's
 * first provider request has begun, so the summary never goes out ahead of it.
 */
export interface CompactionGateDecision {
  outcomes: CompactionGateOutcome[];
  startBackground?: () => void;
}

/** v0.9.99: a content-free record of one background compaction's progress, for the host's own log and notices. */
export interface BackgroundCompactionEvent {
  agentId: string;
  operationId: string;
  state: 'prepared' | 'applied' | 'stale' | 'not-applied' | 'cancelled' | 'failed';
  /** Milliseconds since its summary requests started; 0 when they never did. */
  elapsedMs: number;
  /** The host's estimate of the summary requests' input, in tokens. */
  estimatedInputTokens: number;
  /** Summary requests started so far: the summarizer's chunks, one usage unit each. */
  summaryRequests: number;
  /** Provider-reported tokens of those requests, or unavailable when none reported valid usage. */
  reportedInputTokens: number | 'unavailable';
  reportedOutputTokens: number | 'unavailable';
  usageCoverage: CompactionUsageCoverage | 'none';
  /** The summary requests are not streamed, so the host never sees a first token. */
  firstTokenMs: 'unavailable';
  /** For `failed`, `stale` and `not-applied`: the reason, from the host's closed vocabulary. */
  failureReason?: string;
  /** For `failed`: the outcome to report, as a foreground failure would be. */
  outcome?: CompactionGateOutcome;
}

export interface CompactionCoordinatorDeps {
  /** The agent's policy for this window and serving route, from the bundled data and its team's table. */
  resolvePolicy(
    config: AgentConfig,
    contextWindow: { tokens: number; source: NonNullable<ContextProjection['windowSource']> } | undefined,
    route: { connectionId: string; modelId: string } | undefined,
  ): SmartCompactionResolution;
  /** Whether host-triggered compaction is admitted on this agent's route in this build. */
  admitted(config: AgentConfig): boolean;
  hostSummarizer(config: AgentConfig): ContextCompactionRequest['hostSummarizer'];
  spend?: CompactionSpendPort;
  newOperationId(): string;
  now?(): number;
  timeoutMs?: number;
  /** v0.9.99: background progress; a failure carries the outcome to report. */
  onBackgroundEvent?(event: BackgroundCompactionEvent): void;
}

/** v0.9.99: one agent's background compaction, in memory only. */
interface BackgroundJob {
  agentId: string;
  operationId: string;
  control: ContextControl;
  routeKey: string;
  policy: ResolvedSmartCompactionPolicy;
  handle: BackgroundCompaction;
  controller: AbortController;
  usage: ReturnType<typeof compactionUsageSink>;
  state: 'captured' | 'preparing' | 'ready' | 'failed' | 'cancelled';
  startedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  timedOut?: boolean;
  settled?: Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/** Resolves when `signal` aborts; never, without one. */
function aborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) { resolve(); return; }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

interface FailureTuple {
  route: string;
  revision: string;
}

export class ContextCompactionCoordinator {
  private readonly inFlight = new Map<string, Promise<CompactionGateOutcome>>();
  private readonly lastFailure = new Map<string, FailureTuple>();
  private readonly background = new Map<string, BackgroundJob>();

  constructor(private readonly deps: CompactionCoordinatorDeps) {}

  /**
   * v0.9.99: the pre-dispatch gate. A route that can prepare a compaction in the background does so whenever the
   * request still fits its admissible budget: the turn is sent at once and the summary is applied at a later idle
   * boundary. Only a request that does not fit waits, for a summary already being prepared (within its own 180-second
   * budget) or, without one, for the foreground compaction as before. Any other route keeps the foreground gate.
   */
  gate(input: CompactionGateInput): Promise<CompactionGateDecision> {
    if (input.cause !== 'automatic' || !input.control.captureCompaction) {
      return this.run(input).then((outcome) => ({ outcomes: [outcome] }));
    }
    const previous = this.inFlight.get(input.agentId);
    const decision = (previous ? previous.then(() => undefined, () => undefined) : Promise.resolve()).then(() => this.gateOnce(input));
    const marker: Promise<CompactionGateOutcome> = decision
      .then((value): CompactionGateOutcome => value.outcomes.at(-1) ?? { kind: 'not-needed', reason: 'below-trigger' })
      .finally(() => { if (this.inFlight.get(input.agentId) === marker) this.inFlight.delete(input.agentId); });
    this.inFlight.set(input.agentId, marker);
    return decision;
  }

  /**
   * v0.9.99: cancel an agent's background compaction so it can never apply, and settle it. Stop, removal, a replaced
   * backend, a discarded conversation and a manual Compact call this.
   */
  cancelBackground(agentId: string): Promise<void> {
    const job = this.background.get(agentId);
    if (!job) return Promise.resolve();
    this.background.delete(agentId);
    job.state = 'cancelled';
    if (job.timer) clearTimeout(job.timer);
    job.controller.abort();
    this.emitBackground(job, 'cancelled');
    return job.settled?.then(() => undefined, () => undefined) ?? Promise.resolve();
  }

  /**
   * v0.9.99: what the composer's ring fills toward for this agent and window: the resolved automatic trigger, off, or
   * unavailable when the policy cannot be resolved or host compaction is not admitted on this route. It reads the
   * same policy the gate uses, for the agent's configured model.
   */
  meterPolicy(
    config: AgentConfig,
    contextWindow: { tokens: number; source: NonNullable<ContextProjection['windowSource']> } | undefined,
    servedModel?: string,
  ): ContextMeterCompaction {
    if (!this.deps.admitted(config)) return { mode: 'unavailable' };
    // The model that served the last turn, as the gate resolves it with the turn's own model; the configured one
    // before any turn.
    const route = config.route ? { connectionId: config.route.connectionId, modelId: servedModel ?? config.model } : undefined;
    const resolution = this.deps.resolvePolicy(config, contextWindow, route);
    if (resolution.status === 'unavailable') return { mode: 'unavailable' };
    if (resolution.policy.mode === 'off') return { mode: 'off' };
    const trigger = resolution.policy.activeTriggerTokens;
    return trigger !== undefined && trigger > 0
      ? { mode: 'automatic', triggerTokens: trigger, basis: servedModel ? 'served-model' : 'configured-model' }
      : { mode: 'unavailable' };
  }

  /** v0.9.99: this agent's background summary while it exists: being prepared, or ready to apply. */
  backgroundState(agentId: string): 'preparing' | 'ready' | undefined {
    const state = this.background.get(agentId)?.state;
    return state === 'captured' || state === 'preparing' ? 'preparing' : state === 'ready' ? 'ready' : undefined;
  }

  /** v0.9.99: cancel every background compaction. */
  dispose(): void {
    for (const agentId of [...this.background.keys()]) void this.cancelBackground(agentId);
  }

  private async gateOnce(input: CompactionGateInput): Promise<CompactionGateDecision> {
    if (!this.deps.admitted(input.config)) return { outcomes: [{ kind: 'not-needed', reason: 'route-not-admitted' }] };
    const pending = input.pendingTurn;
    let before = input.control.projectNextTurn(pending?.instruction ?? '', pending?.attachments);
    const window = before.window !== undefined
      ? { tokens: before.window, source: before.windowSource ?? 'assumed' as const }
      : undefined;
    const route = input.config.route ? { connectionId: input.config.route.connectionId, modelId: input.modelId } : undefined;
    const resolution = this.deps.resolvePolicy(input.config, window, route);
    if (resolution.status === 'unavailable') return { outcomes: [{ kind: 'unavailable', reason: resolution.reason }] };
    const policy = resolution.policy;
    const routeKey = route ? `${route.connectionId}\u0000${route.modelId.trim().toLowerCase()}` : '';
    const outcomes: CompactionGateOutcome[] = [];

    // A job prepared for another backend, route or policy can never apply here.
    let job = this.background.get(input.agentId);
    // A ready summary that turned out stale or no longer shrinking is not replaced at the same boundary.
    let discarded = false;
    if (job && (job.control !== input.control || job.routeKey !== routeKey || job.policy.revision !== policy.revision)) {
      void this.cancelBackground(input.agentId);
      job = undefined;
    }
    const trigger = policy.mode === 'off' ? undefined : policy.activeTriggerTokens;
    const due = (projection: ContextProjection): boolean =>
      trigger !== undefined && projection.basis !== 'unavailable' && projection.tokens >= trigger;
    // 1. A ready summary is applied when compaction is due again, or when the read cutoff moves this turn and the
    //    history prefix changes anyway. It is never held back for a cutoff move.
    if (job?.state === 'ready' && (due(before) || (before.basis !== 'unavailable' && before.readProjectionMoves === true))) {
      const applied = this.commitJob(input, job, before);
      job = undefined;
      if (applied) {
        outcomes.push(applied);
        before = input.control.projectNextTurn(pending?.instruction ?? '', pending?.attachments);
      } else {
        discarded = true;
      }
    }
    if (trigger === undefined) return { outcomes: [...outcomes, { kind: 'not-needed', reason: 'off' }] };
    if (before.basis === 'unavailable') return { outcomes: [...outcomes, { kind: 'not-needed', reason: 'projection-unavailable' }] };
    if (before.tokens < trigger) return { outcomes: [...outcomes, { kind: 'not-needed', reason: 'below-trigger' }] };
    const failure = this.lastFailure.get(input.agentId);
    const exceedsWindow = before.window !== undefined && before.tokens > before.window;
    if (failure && failure.route === routeKey && failure.revision === policy.revision && !exceedsWindow) {
      return { outcomes: [...outcomes, { kind: 'suppressed' }] };
    }

    // 2. Due and fits: send now; prepare beside it.
    const fits = before.admissibleTokens !== undefined && before.tokens <= before.admissibleTokens;
    if (fits) {
      if (job || discarded) return { outcomes };
      const captured = this.captureJob(input, policy, routeKey, before);
      return 'start' in captured
        ? { outcomes, startBackground: captured.start }
        : { outcomes: [...outcomes, captured] };
    }

    // 3. Due and does not fit: a summary being prepared is joined within its own budget, never restarted.
    if (job) {
      if (job.state === 'captured') this.startJob(job);
      await Promise.race([job.settled, aborted(input.signal)]);
      if (input.signal?.aborted) {
        return { outcomes: [...outcomes, { kind: 'failed', reason: 'stopped', detail: 'The turn was stopped before compaction finished.' }] };
      }
      if (job.state === 'ready') {
        const applied = this.commitJob(input, job, before);
        if (applied) return { outcomes: [...outcomes, applied] };
        // Stale or no longer shrinking: one fresh foreground attempt, as before.
      } else {
        // Its failure is already recorded and reported; the task goes out unchanged.
        return { outcomes };
      }
    }
    return { outcomes: [...outcomes, await this.runOnce(input)] };
  }

  /** Captures a background compaction at this idle boundary; its summary requests wait for `start`. */
  private captureJob(
    input: CompactionGateInput,
    policy: ResolvedSmartCompactionPolicy,
    routeKey: string,
    before: ContextProjection,
  ): { start: () => void } | CompactionGateOutcome {
    const operationId = this.deps.newOperationId();
    const usage = compactionUsageSink(this.deps.spend, { operationId, requestId: input.requestId, agentId: input.agentId });
    const controller = new AbortController();
    let captured: ReturnType<NonNullable<ContextControl['captureCompaction']>>;
    try {
      captured = input.control.captureCompaction!({
        operationId,
        requestId: input.requestId,
        agentId: input.agentId,
        cause: 'automatic',
        policy,
        before,
        ...(input.pendingTurn ? { pendingTurn: input.pendingTurn } : {}),
        usage,
        hostSummarizer: this.deps.hostSummarizer(input.config),
        signal: controller.signal,
      });
    } catch (error) {
      captured = { kind: 'failed', reason: 'summarizer-failed', detail: error instanceof Error ? error.message : String(error) };
    }
    if (!('prepare' in captured)) {
      if (captured.kind === 'skipped') return { kind: 'skipped', reason: captured.reason };
      this.lastFailure.set(input.agentId, { route: routeKey, revision: policy.revision });
      return { kind: 'failed', reason: captured.reason, detail: captured.detail };
    }
    const job: BackgroundJob = {
      agentId: input.agentId, operationId, control: input.control, routeKey, policy, handle: captured, controller, usage, state: 'captured',
    };
    this.background.set(input.agentId, job);
    return { start: () => this.startJob(job) };
  }

  /** Starts a captured job's summary requests, once, under its own 180-second budget. */
  private startJob(job: BackgroundJob): void {
    if (job.state !== 'captured' || this.background.get(job.agentId) !== job) return;
    job.state = 'preparing';
    job.startedAt = this.now();
    job.timer = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const settle = (result: { kind: 'prepared' } | Extract<ContextCompactionResult, { kind: 'failed' }>) => {
      if (job.timer) clearTimeout(job.timer);
      // Cancelled meanwhile: a late result changes nothing and reports nothing.
      if (job.state === 'cancelled' || this.background.get(job.agentId) !== job) return;
      if (result.kind === 'prepared' && !job.controller.signal.aborted) {
        job.state = 'ready';
        this.emitBackground(job, 'prepared');
        return;
      }
      job.state = 'failed';
      this.background.delete(job.agentId);
      this.lastFailure.set(job.agentId, { route: job.routeKey, revision: job.policy.revision });
      const outcome: CompactionGateOutcome = job.timedOut || result.kind === 'prepared'
        ? { kind: 'failed', reason: 'timeout', detail: 'It did not finish within 180 seconds.' }
        : { kind: 'failed', reason: result.reason, detail: result.detail };
      this.emitBackground(job, 'failed', outcome);
    };
    job.settled = job.handle.prepare().then(settle, (error: unknown) => settle({
      kind: 'failed', reason: 'summarizer-failed', detail: error instanceof Error ? error.message : String(error),
    }));
  }

  /** Applies a ready job at this idle boundary; the receipt's `before` is the request it shrank. */
  private commitJob(input: CompactionGateInput, job: BackgroundJob, before: ContextProjection): CompactionGateOutcome | undefined {
    this.background.delete(job.agentId);
    let result: ContextCompactionResult;
    try {
      result = job.handle.commit(input.pendingTurn);
    } catch (error) {
      result = { kind: 'failed', reason: 'stale', detail: error instanceof Error ? error.message : String(error) };
    }
    if (result.kind !== 'compacted') {
      const reason = result.kind === 'failed' ? result.reason : result.kind === 'skipped' ? result.reason : undefined;
      this.emitBackground(job, reason === 'stale' ? 'stale' : 'not-applied', undefined, reason);
      return undefined;
    }
    this.lastFailure.delete(job.agentId);
    this.emitBackground(job, 'applied');
    return { kind: 'compacted', receipt: this.receiptFor(job.operationId, job.agentId, job.policy, 'automatic', before, result, job.usage) };
  }

  private emitBackground(job: BackgroundJob, state: BackgroundCompactionEvent['state'], outcome?: CompactionGateOutcome, reason?: string): void {
    try {
      const reported = job.usage.reported();
      const failureReason = reason ?? (outcome?.kind === 'failed' ? outcome.reason : undefined);
      this.deps.onBackgroundEvent?.({
        agentId: job.agentId,
        operationId: job.operationId,
        state,
        elapsedMs: job.startedAt === undefined ? 0 : Math.max(0, this.now() - job.startedAt),
        estimatedInputTokens: job.handle.estimatedInputTokens,
        summaryRequests: job.usage.unitIds().length,
        reportedInputTokens: reported?.inputTokens ?? 'unavailable',
        reportedOutputTokens: reported?.outputTokens ?? 'unavailable',
        usageCoverage: job.usage.coverage() ?? 'none',
        firstTokenMs: 'unavailable',
        ...(failureReason ? { failureReason } : {}),
        ...(outcome ? { outcome } : {}),
      });
    } catch { /* A report sink cannot change the compaction. */ }
  }

  /**
   * One compaction per agent at a time. A caller that arrives while one runs waits for it, then projects its own
   * request afresh: it never inherits another request's outcome, receipt or cost.
   */
  run(input: CompactionGateInput): Promise<CompactionGateOutcome> {
    const previous = this.inFlight.get(input.agentId);
    const outcome: Promise<CompactionGateOutcome> = (previous ? previous.then(() => undefined, () => undefined) : Promise.resolve())
      .then(() => this.runOnce(input))
      .finally(() => { if (this.inFlight.get(input.agentId) === outcome) this.inFlight.delete(input.agentId); });
    this.inFlight.set(input.agentId, outcome);
    return outcome;
  }

  private async runOnce(input: CompactionGateInput): Promise<CompactionGateOutcome> {
    if (!this.deps.admitted(input.config)) return { kind: 'not-needed', reason: 'route-not-admitted' };
    const pending = input.pendingTurn;
    const before = input.control.projectNextTurn(pending?.instruction ?? '', pending?.attachments);
    const window = before.window !== undefined
      ? { tokens: before.window, source: before.windowSource ?? 'assumed' as const }
      : undefined;
    const route = input.config.route ? { connectionId: input.config.route.connectionId, modelId: input.modelId } : undefined;
    const resolution = this.deps.resolvePolicy(input.config, window, route);
    if (resolution.status === 'unavailable') return { kind: 'unavailable', reason: resolution.reason };
    const policy = resolution.policy;
    const routeKey = route ? `${route.connectionId}\u0000${route.modelId.trim().toLowerCase()}` : '';

    if (input.cause === 'automatic') {
      if (policy.mode === 'off' || policy.activeTriggerTokens === undefined) return { kind: 'not-needed', reason: 'off' };
      if (before.basis === 'unavailable') return { kind: 'not-needed', reason: 'projection-unavailable' };
      if (before.tokens < policy.activeTriggerTokens) return { kind: 'not-needed', reason: 'below-trigger' };
      const failure = this.lastFailure.get(input.agentId);
      const exceedsWindow = before.window !== undefined && before.tokens > before.window;
      if (failure && failure.route === routeKey && failure.revision === policy.revision && !exceedsWindow) {
        return { kind: 'suppressed' };
      }
    }

    const operationId = this.deps.newOperationId();
    const usage = compactionUsageSink(this.deps.spend, { operationId, requestId: input.requestId, agentId: input.agentId });
    const controller = new AbortController();
    const stop = () => controller.abort();
    input.signal?.addEventListener('abort', stop, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ContextCompactionResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: 'failed', reason: 'timeout', detail: 'It did not finish within 180 seconds.' });
      }, this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    });
    let result: ContextCompactionResult;
    try {
      result = await Promise.race([
        input.control.compact({
          operationId,
          requestId: input.requestId,
          agentId: input.agentId,
          cause: input.cause,
          policy,
          before,
          ...(pending ? { pendingTurn: pending } : {}),
          usage,
          hostSummarizer: this.deps.hostSummarizer(input.config),
          signal: controller.signal,
        }),
        timeout,
      ]);
    } catch (error) {
      result = { kind: 'failed', reason: 'summarizer-failed', detail: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener('abort', stop);
    }

    // A compaction the backend already applied stays a fact: Stop only prevents the task that follows, so the receipt,
    // the saved context and the spend it caused are never hidden behind "stopped".
    if (input.signal?.aborted && result.kind !== 'compacted') {
      return { kind: 'failed', reason: 'stopped', detail: 'The turn was stopped before compaction finished.' };
    }
    if (result.kind === 'skipped') return { kind: 'skipped', reason: result.reason };
    if (result.kind === 'failed') {
      if (input.cause === 'automatic' && before.basis !== 'unavailable') {
        this.lastFailure.set(input.agentId, {
          route: routeKey,
          revision: policy.revision,
        });
      }
      return { kind: 'failed', reason: result.reason, detail: result.detail };
    }
    this.lastFailure.delete(input.agentId);
    return { kind: 'compacted', receipt: this.receiptFor(operationId, input.agentId, policy, input.cause, before, result, usage) };
  }

  private receiptFor(
    operationId: string,
    agentId: string,
    policy: ResolvedSmartCompactionPolicy,
    cause: 'automatic' | 'manual',
    before: ContextProjection,
    result: Extract<ContextCompactionResult, { kind: 'compacted' }>,
    usage: ReturnType<typeof compactionUsageSink>,
  ): CompactionReceipt {
    return {
        version: 1,
        id: operationId,
        agentId,
        policy: {
          mode: policy.mode,
          ...(policy.profile ? { profile: policy.profile } : {}),
          policyRevision: policy.revision,
          ...(policy.resolutionSource ? { resolutionSource: policy.resolutionSource } : {}),
          windowPercent: policy.windowPercent,
          ceilingTokens: policy.ceilingTokens,
          recentTailTokens: policy.recentTailTokens,
          postCompactTargetTokens: policy.postCompactTargetTokens,
          ...(policy.routeEvidenceCapTokens !== undefined ? { routeEvidenceCapTokens: policy.routeEvidenceCapTokens } : {}),
          ...(policy.activeTriggerTokens !== undefined ? { activeTriggerTokens: policy.activeTriggerTokens } : {}),
          ...(policy.winningTerm ? { winningTerm: policy.winningTerm } : {}),
        },
        trigger: cause === 'manual' || !policy.winningTerm ? 'manual' : policy.winningTerm,
        mechanism: result.mechanism,
        before,
        after: result.after,
        ...(result.droppedMessages !== undefined ? { replacedMessages: result.droppedMessages } : {}),
        ...(result.carriedForward ? { carriedForward: result.carriedForward } : {}),
        ...(result.keptTokens !== undefined ? { keptTokens: result.keptTokens } : {}),
        summaryVisibility: result.summary !== undefined ? 'included' : 'runtime-private',
        ...(result.summary !== undefined ? { summary: result.summary } : {}),
        usage: { usageUnitIds: usage.unitIds(), coverage: usage.coverage() ?? 'reported' },
        createdAt: new Date(this.now()).toISOString(),
    };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

/**
 * A receipt for a compaction the runtime ran on its own inside a turn (Claude's in-turn threshold). Its cost is part
 * of the parent turn's reported cost, so it references that unit and opens none of its own.
 */
export function nativeCompactionReceipt(
  agentId: string,
  event: { operationId: string; before: ContextProjection; after: ContextProjection; summary?: string; policy?: ResolvedSmartCompactionPolicy },
  parentUsageUnitId: string | undefined,
  now: number,
): CompactionReceipt | undefined {
  const policy = event.policy;
  if (!policy) return undefined;
  return {
    version: 1,
    id: event.operationId,
    agentId,
    policy: {
      mode: policy.mode,
      ...(policy.profile ? { profile: policy.profile } : {}),
      policyRevision: policy.revision,
      ...(policy.resolutionSource ? { resolutionSource: policy.resolutionSource } : {}),
      windowPercent: policy.windowPercent,
      ceilingTokens: policy.ceilingTokens,
      recentTailTokens: policy.recentTailTokens,
      postCompactTargetTokens: policy.postCompactTargetTokens,
      ...(policy.routeEvidenceCapTokens !== undefined ? { routeEvidenceCapTokens: policy.routeEvidenceCapTokens } : {}),
      ...(policy.activeTriggerTokens !== undefined ? { activeTriggerTokens: policy.activeTriggerTokens } : {}),
      ...(policy.winningTerm ? { winningTerm: policy.winningTerm } : {}),
    },
    trigger: policy.winningTerm ?? 'practical-ceiling',
    mechanism: 'native-runtime',
    before: event.before,
    after: event.after,
    summaryVisibility: event.summary !== undefined ? 'included' : 'runtime-private',
    ...(event.summary !== undefined ? { summary: event.summary } : {}),
    usage: { usageUnitIds: [], coverage: 'parent-turn', ...(parentUsageUnitId ? { parentUsageUnitId } : {}) },
    createdAt: new Date(now).toISOString(),
  };
}

/** What the agent's chat says about one gate outcome; undefined when there is nothing worth saying. */
export function compactionNotice(outcome: CompactionGateOutcome): string | undefined {
  switch (outcome.kind) {
    case 'failed':
      return outcome.reason === 'stopped'
        ? undefined
        : `UnodeAi: Automatic compaction failed. ${outcome.detail} The task was sent unchanged. `
          + 'UnodeAi will not retry it automatically in this session while the request fits the model window. '
          + 'To try again, click the ring below the message box (Compact this conversation now), '
          + 'or press Ctrl+Shift+P and run "UnodeAi: Compact Context".';
    case 'suppressed':
      return undefined;
    default:
      return undefined;
  }
}

/** The chat line for a receipt: sizes, why it fired, and what was kept. The summary itself renders separately. */
export function compactionReceiptText(receipt: CompactionReceipt): string {
  const size = (projection: ContextProjection) => projection.basis === 'unavailable'
    ? 'unavailable'
    : `about ${formatTokens(projection.tokens)} tokens`;
  const sizes = receipt.after.basis === 'unavailable' && receipt.mechanism === 'native-runtime'
    ? `${size(receipt.before)} before; the runtime does not report the size after`
    : `${size(receipt.before)} → ${size(receipt.after)}`;
  const why = receipt.usage.coverage === 'parent-turn'
    ? 'it reached its own compaction threshold inside a turn'
    : receipt.trigger === 'manual'
    ? 'you asked for it'
    : `the next request reached the ${receipt.trigger === 'window-share'
      ? `${receipt.policy.windowPercent}% window share`
      : receipt.trigger === 'route-evidence-cap' ? 'route evidence cap' : 'practical ceiling'} of `
      + `${formatTokens(receipt.policy.activeTriggerTokens ?? 0)} tokens`;
  const carried = (receipt.carriedForward ?? []).reduce((sum, entry) => sum + entry.count, 0);
  // Only the host-history route keeps turns word for word; a runtime replaces the conversation with its own summary.
  const kept = receipt.mechanism === 'native-runtime'
    ? receipt.summaryVisibility === 'included'
      ? ' The runtime replaced the conversation with its own summary.'
      : ' The runtime replaced the conversation with its own summary, which it does not show.'
    : carried > 0
    ? ` Kept word for word: ${carried} carried-forward record${carried === 1 ? '' : 's'} and the newest turns.`
    : ' The newest turns were kept word for word.';
  const still = receipt.policy.activeTriggerTokens !== undefined && receipt.after.basis !== 'unavailable'
    && receipt.after.tokens >= receipt.policy.activeTriggerTokens
    ? ' It is still above the trigger.'
    : '';
  // When what must stay word for word crowds the ceiling, say so and what helps: otherwise the next compaction, a turn
  // or two later, looks like a fault.
  const workingTarget = receipt.mechanism === 'host-history' ? compactionSizing(receipt.policy)?.postCompactTargetTokens : undefined;
  const crowded = receipt.keptTokens !== undefined && workingTarget !== undefined && receipt.after.basis !== 'unavailable'
    && receipt.after.tokens > workingTarget
    ? ` The instructions, tools, kept records and newest turns alone take about ${formatTokens(receipt.keptTokens)} tokens, `
      + `so it stays above its ${formatTokens(workingTarget)}-token working target and may compact again soon; a higher `
      + 'ceiling means fewer compactions.'
    : '';
  const cost = receipt.usage.coverage === 'parent-turn'
    ? ' Its cost is part of that turn.'
    : receipt.usage.usageUnitIds.length === 0
      ? ''
      : ` Cost: ${receipt.usage.usageUnitIds.length} summary request${receipt.usage.usageUnitIds.length === 1 ? '' : 's'}`
        + ` (${receipt.usage.coverage === 'gap' ? 'usage not fully reported' : `usage ${receipt.usage.coverage}`}).`;
  return `UnodeAi: Compacted this agent's earlier conversation (${sizes}) because ${why}.${still}${kept}${crowded}${cost}`;
}
