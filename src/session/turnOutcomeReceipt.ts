/*---------------------------------------------------------------------------------------------
 *  UnodeAi - turn outcome receipt (v0.9.91)
 *
 *  One immutable, content-free aggregate per terminal host turn: what the turn delivered and how its tool calls
 *  ended. Session builds it once from the live backend events; the final transcript message and the run ledger keep
 *  that same value. No tool name, call id, argument, output, diff, path or model prose enters it, and nothing reads
 *  it back as control state.
 *--------------------------------------------------------------------------------------------*/

import type { RestoredTurnDelivery, TurnResponseOutcome } from '../backend/AgentBackend';
import { parseResponseOutcome } from '../backend/emptyReplyOutcome';
import {
  CANONICAL_TOOL_FAILURE_KINDS,
  HOST_TOOL_REFUSAL_REASONS,
  type CanonicalToolFailureKind,
  type HostToolRefusalReason,
  type ToolResultFact,
} from '../backend/toolSummary';

export interface TurnOutcomeToolCounts {
  /** `complete` only when every observed use had exactly one result and nothing was excluded or lost. */
  coverage: 'complete' | 'partial';
  /** Results counted below: success + refused + failed. */
  total: number;
  success: number;
  refused: number;
  failed: number;
  failureKinds: Partial<Record<CanonicalToolFailureKind, number>>;
  refusalReasons: Partial<Record<HostToolRefusalReason, number>>;
  /** Uses that never received a result, or reused or invalid use ids. */
  unmatchedUses: number;
  /** Results with no use, duplicates (not counted again) or invalid ids. */
  unmatchedResults: number;
  /** Provider-native activity the host does not mediate, such as Codex's own MCP calls. */
  excludedNativeActivities: number;
  /** Host decisions that could not be joined to their call; the result kept the provider's own fact. */
  unjoinedHostDecisions: number;
  /** Points where the host knows events may be missing, such as a process that died mid-turn. */
  observationGaps: number;
}

export interface TurnOutcomeReceiptV1 {
  schemaVersion: 1;
  /** `turn-outcome:<turnId>`; distinct from the run outcome card ids v0.9.92 introduces. */
  receiptId: string;
  /** The origin bus message id that admitted the turn. */
  turnId: string;
  agentId: string;
  /** The turn's message correlation: a thread key, not an identity. */
  correlationId?: string;
  /** Present only when the host resolved the turn to a coordinated run. */
  runId?: string;
  recordedAt: string;
  delivery: TurnResponseOutcome;
  tools: TurnOutcomeToolCounts;
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const RECEIPT_ID_PREFIX = 'turn-outcome:';
/** Far above any real turn; a stored counter beyond it is not a count this host wrote. */
export const MAX_TURN_OUTCOME_COUNT = 100_000;

/** The receipt id for a turn. */
export function turnOutcomeReceiptId(turnId: string): string {
  return `${RECEIPT_ID_PREFIX}${turnId}`;
}

/**
 * Counts one turn's tool observations by host call id. It takes only the id and the typed fact, so a summary, detail
 * or diff can never become an input.
 */
export class TurnOutcomeAccumulator {
  private readonly open = new Set<string>();
  private readonly closed = new Set<string>();
  private success = 0;
  private refused = 0;
  private failed = 0;
  private readonly failureKinds: Partial<Record<CanonicalToolFailureKind, number>> = {};
  private readonly refusalReasons: Partial<Record<HostToolRefusalReason, number>> = {};
  private unmatchedUses = 0;
  private unmatchedResults = 0;
  private nativeStarts = 0;
  private nativeEnds = 0;
  private unjoinedHostDecisions = 0;
  private observationGaps = 0;

  use(callId: string): void {
    if (!ID_PATTERN.test(callId) || this.open.has(callId) || this.closed.has(callId)) {
      this.unmatchedUses = bump(this.unmatchedUses);
      return;
    }
    this.open.add(callId);
  }

  result(callId: string, fact: ToolResultFact): void {
    const valid = ID_PATTERN.test(callId);
    if (valid && this.closed.has(callId)) {
      // A second result for one call is a duplicated event: it is named, never counted twice.
      this.unmatchedResults = bump(this.unmatchedResults);
      return;
    }
    if (valid && this.open.delete(callId)) {
      this.closed.add(callId);
    } else {
      this.unmatchedResults = bump(this.unmatchedResults);
    }
    switch (fact.status) {
      case 'success':
        this.success = bump(this.success);
        break;
      case 'refused':
        this.refused = bump(this.refused);
        this.refusalReasons[fact.reason] = bump(this.refusalReasons[fact.reason] ?? 0);
        break;
      case 'failed':
        this.failed = bump(this.failed);
        this.failureKinds[fact.failureKind] = bump(this.failureKinds[fact.failureKind] ?? 0);
        break;
      default:
        return unhandled(fact);
    }
  }

  /** A host decision the backend could not join to its call. */
  unjoinedHostDecision(): void {
    this.unjoinedHostDecisions = bump(this.unjoinedHostDecisions);
  }

  /** The turn's event stream may be incomplete from here on, for example because its process died. */
  observationGap(): void {
    this.observationGaps = bump(this.observationGaps);
  }

  /** Provider-native activity the host only observes. A start and its end are one activity. */
  nativeActivity(status: 'inProgress' | 'completed' | 'failed'): void {
    if (status === 'inProgress') this.nativeStarts = bump(this.nativeStarts);
    else this.nativeEnds = bump(this.nativeEnds);
  }

  finish(turn: {
    turnId: string;
    agentId: string;
    correlationId?: string;
    runId?: string;
    recordedAt: string;
    delivery: TurnResponseOutcome;
  }): TurnOutcomeReceiptV1 | undefined {
    const unmatchedUses = Math.min(MAX_TURN_OUTCOME_COUNT, this.unmatchedUses + this.open.size);
    const excludedNativeActivities = Math.max(this.nativeStarts, this.nativeEnds);
    const complete = unmatchedUses === 0 && this.unmatchedResults === 0 && excludedNativeActivities === 0
      && this.unjoinedHostDecisions === 0 && this.observationGaps === 0;
    return parseTurnOutcomeReceipt({
      schemaVersion: 1,
      receiptId: turnOutcomeReceiptId(turn.turnId),
      turnId: turn.turnId,
      agentId: turn.agentId,
      ...(turn.correlationId ? { correlationId: turn.correlationId } : {}),
      ...(turn.runId ? { runId: turn.runId } : {}),
      recordedAt: turn.recordedAt,
      delivery: turn.delivery,
      tools: {
        coverage: complete ? 'complete' : 'partial',
        total: this.success + this.refused + this.failed,
        success: this.success,
        refused: this.refused,
        failed: this.failed,
        failureKinds: { ...this.failureKinds },
        refusalReasons: { ...this.refusalReasons },
        unmatchedUses,
        unmatchedResults: this.unmatchedResults,
        excludedNativeActivities,
        unjoinedHostDecisions: this.unjoinedHostDecisions,
        observationGaps: this.observationGaps,
      },
    });
  }
}

/**
 * A receipt from metadata or storage, rebuilt field by field: every id, enum, counter and empty-reply attempt is
 * bounded, unknown fields are dropped, and a receipt whose counts contradict each other is rejected whole rather than
 * repaired. Undefined means no receipt; it never means a turn without tools.
 */
export function parseTurnOutcomeReceipt(raw: unknown): TurnOutcomeReceiptV1 | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1) return undefined;
  const turnId = id(value.turnId);
  const agentId = id(value.agentId);
  if (!turnId || !agentId || value.receiptId !== turnOutcomeReceiptId(turnId)) return undefined;
  const correlationId = value.correlationId === undefined ? undefined : id(value.correlationId);
  const runId = value.runId === undefined ? undefined : id(value.runId);
  if ((value.correlationId !== undefined && !correlationId) || (value.runId !== undefined && !runId)) return undefined;
  if (typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt)) || value.recordedAt.length > 40) {
    return undefined;
  }
  const delivery = parseResponseOutcome(value.delivery);
  const tools = parseToolCounts(value.tools);
  if (!delivery || !tools) return undefined;
  return {
    schemaVersion: 1,
    receiptId: turnOutcomeReceiptId(turnId),
    turnId,
    agentId,
    ...(correlationId ? { correlationId } : {}),
    ...(runId ? { runId } : {}),
    recordedAt: value.recordedAt,
    delivery,
    tools,
  };
}

/** Whether two receipts hold the same facts. Both are parsed, so their fields are in one canonical order. */
export function sameTurnOutcomeReceipt(left: TurnOutcomeReceiptV1, right: TurnOutcomeReceiptV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * A restored turn's delivery: typed from its receipt, or `legacy-unclassified` for a turn recorded without one.
 * Reply text and `isError` are never used to reconstruct a kind.
 */
export function restoredTurnDelivery(receipt: TurnOutcomeReceiptV1 | undefined): RestoredTurnDelivery {
  return receipt ? { classification: 'typed', outcome: receipt.delivery } : { classification: 'legacy-unclassified' };
}

function parseToolCounts(raw: unknown): TurnOutcomeToolCounts | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const counts = {
    total: count(value.total),
    success: count(value.success),
    refused: count(value.refused),
    failed: count(value.failed),
    unmatchedUses: count(value.unmatchedUses),
    unmatchedResults: count(value.unmatchedResults),
    excludedNativeActivities: count(value.excludedNativeActivities),
    unjoinedHostDecisions: count(value.unjoinedHostDecisions),
    observationGaps: count(value.observationGaps),
  };
  if (Object.values(counts).some((entry) => entry === undefined)) return undefined;
  const failureKinds = countsByKey(value.failureKinds, CANONICAL_TOOL_FAILURE_KINDS);
  const refusalReasons = countsByKey(value.refusalReasons, HOST_TOOL_REFUSAL_REASONS);
  if (!failureKinds || !refusalReasons) return undefined;
  const sum = (record: Partial<Record<string, number>>) => Object.values(record).reduce((total, entry) => total! + entry!, 0);
  const complete = counts.unmatchedUses === 0 && counts.unmatchedResults === 0 && counts.excludedNativeActivities === 0
    && counts.unjoinedHostDecisions === 0 && counts.observationGaps === 0;
  if (
    counts.total !== counts.success! + counts.refused! + counts.failed!
    || sum(failureKinds) !== counts.failed
    || sum(refusalReasons) !== counts.refused
    || (value.coverage !== 'complete' && value.coverage !== 'partial')
    || (value.coverage === 'complete') !== complete
  ) {
    return undefined;
  }
  return {
    coverage: value.coverage,
    total: counts.total!,
    success: counts.success!,
    refused: counts.refused!,
    failed: counts.failed!,
    failureKinds,
    refusalReasons,
    unmatchedUses: counts.unmatchedUses!,
    unmatchedResults: counts.unmatchedResults!,
    excludedNativeActivities: counts.excludedNativeActivities!,
    unjoinedHostDecisions: counts.unjoinedHostDecisions!,
    observationGaps: counts.observationGaps!,
  };
}

/** Counts keyed by a known enum, in the enum's order; zero entries are left out. Any unknown key rejects the map. */
function countsByKey<Key extends string>(raw: unknown, keys: readonly Key[]): Partial<Record<Key, number>> | undefined {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !(keys as readonly string[]).includes(key))) return undefined;
  const out: Partial<Record<Key, number>> = {};
  for (const key of keys) {
    if (value[key] === undefined) continue;
    const parsed = count(value[key]);
    if (parsed === undefined) return undefined;
    if (parsed > 0) out[key] = parsed;
  }
  return out;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TURN_OUTCOME_COUNT
    ? value
    : undefined;
}

function id(value: unknown): string | undefined {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : undefined;
}

function bump(value: number): number {
  return Math.min(MAX_TURN_OUTCOME_COUNT, value + 1);
}

function unhandled(value: never): never {
  throw new Error(`Unhandled tool result status: ${JSON.stringify(value)}`);
}
