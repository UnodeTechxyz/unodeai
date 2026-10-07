/*---------------------------------------------------------------------------------------------
 *  UnodeAi - context compaction coordinator (v0.9.90 Smart compaction design, §4.2, §5.1, §5.2)
 *
 *  Owns the pre-dispatch gate for one agent: resolve its policy for the model that will serve the turn, project
 *  the next request, and — at or over the trigger — run exactly one bounded compaction before the task is sent.
 *  Every branch ends with the task sent; the trigger never refuses work. There is one compaction per agent at a
 *  time, a 180-second budget, and a ten-minute suppression of an identical automatic failure.
 *--------------------------------------------------------------------------------------------*/

import type { AgentConfig } from '../types';
import type { TurnAttachments } from '../backend/AgentBackend';
import type {
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
  cooldownMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_COOLDOWN_MS = 600_000;
const BUCKET_TOKENS = 10_000;

interface FailureTuple {
  route: string;
  revision: string;
  reason: string;
  bucket: number;
  until: number;
}

export class ContextCompactionCoordinator {
  private readonly inFlight = new Map<string, Promise<CompactionGateOutcome>>();
  private readonly lastFailure = new Map<string, FailureTuple>();

  constructor(private readonly deps: CompactionCoordinatorDeps) {}

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
      const bucket = Math.floor(before.tokens / BUCKET_TOKENS);
      if (failure && failure.until > this.now() && failure.route === routeKey && failure.revision === policy.revision
        && failure.bucket === bucket) {
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
          reason: result.reason,
          bucket: Math.floor(before.tokens / BUCKET_TOKENS),
          until: this.now() + (this.deps.cooldownMs ?? DEFAULT_COOLDOWN_MS),
        });
      }
      return { kind: 'failed', reason: result.reason, detail: result.detail };
    }
    this.lastFailure.delete(input.agentId);
    return {
      kind: 'compacted',
      receipt: {
        version: 1,
        id: operationId,
        agentId: input.agentId,
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
        trigger: input.cause === 'manual' || !policy.winningTerm ? 'manual' : policy.winningTerm,
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
      },
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
        : `UnodeAi: Automatic compaction failed. ${outcome.detail} The task was sent unchanged.`;
    case 'suppressed':
      return 'UnodeAi: Automatic compaction was recently unsuccessful; task sent unchanged.';
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
