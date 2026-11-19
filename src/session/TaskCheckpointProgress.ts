/*---------------------------------------------------------------------------------------------
 *  v0.9.97: how far a task that delivers in batches is from its last saved batch, as the host observes it.
 *
 *  Observational only. It counts the generated tokens the provider reported while the turn runs and the turn's
 *  active time, and says when a batch is due. It never stops, interrupts, resends, extends or starts anything, and
 *  it never reads reasoning text: only the counts a provider reports.
 *--------------------------------------------------------------------------------------------*/

import type { GenerationUsageSource } from '../backend/AgentBackend';
import { SAVE_TASK_CHECKPOINT_TOOL } from '../backend/TaskCheckpoints';

/** Provider-reported generated tokens since the last saved batch at which a batch is due. */
export const CHECKPOINT_DUE_GENERATED_TOKENS = 8_000;
/** Active time without a saved batch at which a batch is due. Approval waits are not active time. */
export const CHECKPOINT_DUE_AFTER_MS = 2 * 60_000;
/** Active time with no saved batch at all after which the task is shown as having no recoverable work product yet. */
export const NO_RECOVERABLE_PRODUCT_AFTER_MS = 4 * 60_000;

export type CheckpointProgressState = 'on-track' | 'checkpoint-due' | 'no-recoverable-product';
export type CheckpointDueReason = 'generated-tokens' | 'elapsed';

/** Where a route's count comes from and when it arrives, worded for the coordinator and the person. */
export const GENERATION_USAGE_SOURCE_LABELS: Record<GenerationUsageSource, string> = {
  'openai-compatible-response': 'provider-reported output tokens, at the end of each response',
  'claude-stream-message': 'Claude CLI message usage, as each streamed message reports it',
  'codex-thread-usage': 'Codex App Server thread usage, when App Server reports it',
};

/** The turn's active time so far (approval waits excluded) and the human wait beside it. */
export interface ActiveTime {
  activeMs: number;
  approvalWaitMs: number;
}

export interface CheckpointProgressSnapshot {
  attemptId: string;
  handle?: string;
  state: CheckpointProgressState;
  dueReasons: CheckpointDueReason[];
  batchesSaved: number;
  lastSavedAt?: string;
  /** Active time since the attempt began, or since its last saved batch. */
  activeMsSinceProduct: number;
  approvalWaitMs: number;
  /**
   * `unavailable` until the provider reported a count in this attempt: no count is inferred from elapsed time or
   * from a turn's final total. Output is the provider's own output count; reasoning is shown only when reported.
   */
  generated:
    | {
      status: 'reported';
      sources: GenerationUsageSource[];
      outputTokens: number;
      reasoningTokens?: number;
      sinceLastBatch: { outputTokens: number; reasoningTokens?: number };
      lastReportedAt: string;
    }
    | { status: 'unavailable' };
}

interface TrackedAttempt {
  attemptId: string;
  handle?: string;
  /** The latest count of each reported unit. A repeat replaces it; a lower late report changes nothing. */
  units: Map<string, { output: number; reasoning?: number }>;
  sources: Set<GenerationUsageSource>;
  lastReportedAtMs?: number;
  batches: number;
  lastSavedAtMs?: number;
  atLastBatch: { output: number; reasoning: number; activeMs: number };
  /** The reminder was given for the current due period; the next saved batch starts a new one. */
  dueNoticeGiven: boolean;
}

/** One session runs one turn at a time, and a tracked attempt is the turn's. */
export class TaskCheckpointProgressTracker {
  private readonly bySession = new Map<string, TrackedAttempt>();

  constructor(private readonly now: () => number = Date.now) {}

  begin(sessionId: string, attemptId: string, handle?: string): void {
    this.bySession.set(sessionId, {
      attemptId,
      ...(handle ? { handle } : {}),
      units: new Map(),
      sources: new Set(),
      batches: 0,
      atLastBatch: { output: 0, reasoning: 0, activeMs: 0 },
      dueNoticeGiven: false,
    });
  }

  end(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  isTracking(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }

  sessionFor(attemptId: string): string | undefined {
    for (const [sessionId, tracked] of this.bySession) if (tracked.attemptId === attemptId) return sessionId;
    return undefined;
  }

  /** One report from the provider. Counts that are not whole non-negative numbers are not counts. */
  noteUsage(sessionId: string, sample: { source: GenerationUsageSource; unit: string; outputTokens: number; reasoningTokens?: number }): void {
    const tracked = this.bySession.get(sessionId);
    if (!tracked || !wholeCount(sample.outputTokens) || !sample.unit) return;
    const reasoning = wholeCount(sample.reasoningTokens) ? sample.reasoningTokens : undefined;
    const prior = tracked.units.get(sample.unit);
    tracked.units.set(sample.unit, {
      output: Math.max(prior?.output ?? 0, sample.outputTokens),
      ...(reasoning !== undefined || prior?.reasoning !== undefined
        ? { reasoning: Math.max(prior?.reasoning ?? 0, reasoning ?? 0) }
        : {}),
    });
    tracked.sources.add(sample.source);
    tracked.lastReportedAtMs = this.now();
  }

  /** A batch was confirmed. What was generated and how long it took start again from here. */
  noteBatchSaved(attemptId: string, time: ActiveTime | undefined): boolean {
    const sessionId = this.sessionFor(attemptId);
    const tracked = sessionId ? this.bySession.get(sessionId) : undefined;
    if (!tracked) return false;
    const totals = totalsOf(tracked);
    tracked.batches += 1;
    tracked.lastSavedAtMs = this.now();
    tracked.atLastBatch = { output: totals.output, reasoning: totals.reasoning ?? 0, activeMs: time?.activeMs ?? tracked.atLastBatch.activeMs };
    tracked.dueNoticeGiven = false;
    return true;
  }

  snapshot(sessionId: string, time: ActiveTime | undefined): CheckpointProgressSnapshot | undefined {
    const tracked = this.bySession.get(sessionId);
    if (!tracked) return undefined;
    const activeMs = time?.activeMs ?? tracked.atLastBatch.activeMs;
    const activeMsSinceProduct = Math.max(0, activeMs - tracked.atLastBatch.activeMs);
    const totals = totalsOf(tracked);
    const sinceOutput = Math.max(0, totals.output - tracked.atLastBatch.output);
    const sinceReasoning = totals.reasoning === undefined ? undefined : Math.max(0, totals.reasoning - tracked.atLastBatch.reasoning);
    const reported = tracked.units.size > 0;
    const dueReasons: CheckpointDueReason[] = [];
    if (reported && sinceOutput >= CHECKPOINT_DUE_GENERATED_TOKENS) dueReasons.push('generated-tokens');
    if (activeMsSinceProduct >= CHECKPOINT_DUE_AFTER_MS) dueReasons.push('elapsed');
    const state: CheckpointProgressState = tracked.batches === 0 && activeMsSinceProduct >= NO_RECOVERABLE_PRODUCT_AFTER_MS
      ? 'no-recoverable-product'
      : dueReasons.length > 0 ? 'checkpoint-due' : 'on-track';
    return {
      attemptId: tracked.attemptId,
      ...(tracked.handle ? { handle: tracked.handle } : {}),
      state,
      dueReasons,
      batchesSaved: tracked.batches,
      ...(tracked.lastSavedAtMs !== undefined ? { lastSavedAt: new Date(tracked.lastSavedAtMs).toISOString() } : {}),
      activeMsSinceProduct,
      approvalWaitMs: time?.approvalWaitMs ?? 0,
      generated: reported
        ? {
          status: 'reported',
          sources: [...tracked.sources].sort(),
          outputTokens: totals.output,
          ...(totals.reasoning !== undefined ? { reasoningTokens: totals.reasoning } : {}),
          sinceLastBatch: { outputTokens: sinceOutput, ...(sinceReasoning !== undefined ? { reasoningTokens: sinceReasoning } : {}) },
          lastReportedAt: new Date(tracked.lastReportedAtMs!).toISOString(),
        }
        : { status: 'unavailable' },
    };
  }

  /** The reminder for the next result of a host-served tool, once per due period. */
  takeDueNotice(attemptId: string, time: ActiveTime | undefined): string | undefined {
    const sessionId = this.sessionFor(attemptId);
    const tracked = sessionId ? this.bySession.get(sessionId) : undefined;
    const snapshot = sessionId ? this.snapshot(sessionId, time) : undefined;
    if (!tracked || !snapshot || snapshot.state === 'on-track' || tracked.dueNoticeGiven) return undefined;
    tracked.dueNoticeGiven = true;
    return describeDueNotice(snapshot);
  }

  /**
   * Active time until the state can next change by time alone, so a view can be redrawn then. Approval time does
   * not count, so the moment can come later than this; the caller asks again when it does.
   */
  nextTimedChangeMs(sessionId: string, time: ActiveTime | undefined): number | undefined {
    const snapshot = this.snapshot(sessionId, time);
    if (!snapshot) return undefined;
    if (snapshot.activeMsSinceProduct < CHECKPOINT_DUE_AFTER_MS) return CHECKPOINT_DUE_AFTER_MS - snapshot.activeMsSinceProduct;
    if (snapshot.batchesSaved === 0 && snapshot.activeMsSinceProduct < NO_RECOVERABLE_PRODUCT_AFTER_MS) {
      return NO_RECOVERABLE_PRODUCT_AFTER_MS - snapshot.activeMsSinceProduct;
    }
    return undefined;
  }
}

/** The model-facing reminder. It asks for what exists; it neither stops the task nor promises more time. */
export function describeDueNotice(snapshot: CheckpointProgressSnapshot): string {
  const reasons: string[] = [];
  if (snapshot.dueReasons.includes('generated-tokens') && snapshot.generated.status === 'reported') {
    reasons.push(`${snapshot.generated.sinceLastBatch.outputTokens} provider-reported output tokens`);
  }
  if (snapshot.dueReasons.includes('elapsed')) reasons.push(`${Math.round(snapshot.activeMsSinceProduct / 60_000)} min of active time`);
  const since = snapshot.batchesSaved === 0 ? 'since this task began, and no batch is saved yet' : 'since the last saved batch';
  return `[host] A batch is due: ${reasons.join(' and ')} ${since}. If a section is complete, save it now with `
    + `${SAVE_TASK_CHECKPOINT_TOOL}. Saving extends no wait, budget or deadline.`;
}

/** One line for the coordinator and the person: where the attempt stands, and where each number comes from. */
export function describeCheckpointProgress(snapshot: CheckpointProgressSnapshot): string {
  const minutes = (ms: number) => `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  const state = snapshot.state === 'no-recoverable-product'
    ? `no recoverable work product yet after ${minutes(snapshot.activeMsSinceProduct)} of active time`
    : snapshot.state === 'checkpoint-due'
      ? `a batch is due (${snapshot.dueReasons.join(' and ')})`
      : 'on track';
  const generated = snapshot.generated.status === 'reported'
    ? `${snapshot.generated.sinceLastBatch.outputTokens} output tokens since the last saved batch`
      + `${snapshot.generated.sinceLastBatch.reasoningTokens !== undefined ? ` (reasoning reported separately: ${snapshot.generated.sinceLastBatch.reasoningTokens})` : ''}`
      + ` · source: ${snapshot.generated.sources.map((source) => GENERATION_USAGE_SOURCE_LABELS[source]).join('; ')}`
      + ` · last report ${snapshot.generated.lastReportedAt}`
    : 'generated tokens: unavailable (no live count reported on this route yet)';
  return `${state} · ${minutes(snapshot.activeMsSinceProduct)} active since ${snapshot.batchesSaved === 0 ? 'the task began' : 'the last saved batch'}`
    + ` · approval wait ${minutes(snapshot.approvalWaitMs)} (not counted) · ${generated}`;
}

function totalsOf(tracked: TrackedAttempt): { output: number; reasoning?: number } {
  let output = 0;
  let reasoning: number | undefined;
  for (const unit of tracked.units.values()) {
    output += unit.output;
    if (unit.reasoning !== undefined) reasoning = (reasoning ?? 0) + unit.reasoning;
  }
  return { output, ...(reasoning !== undefined ? { reasoning } : {}) };
}

function wholeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
