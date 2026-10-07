/*---------------------------------------------------------------------------------------------
 *  UnodeAi - spend aggregation (v0.9.89, design §8, §9, §13.3, §13.4)
 *
 *  Pure: durable events and the control file in, totals and threshold facts out. Events are ordered against a
 *  reset by shard sequence watermarks, never by timestamps. OpenAI-compatible progress counts at its own
 *  sequence; the final receipt adds only its non-negative residual, so a reset in the middle of a long tool
 *  loop divides it exactly once. Nothing reconstructed, partial or API-equivalent carries reminder authority.
 *--------------------------------------------------------------------------------------------*/

import { parseNanoUsd } from './Money';
import {
  CostBasis,
  CounterResetV1,
  eventIdentityPayload,
  ReminderValue,
  SpendControlV1,
  SpendTotalsSnapshot,
  StoredSpendEvent,
  TokenBasis,
  UsageReceipt,
  UsageTokens,
} from './SpendTypes';
import { periodIdFor } from './SpendTargets';

/** Separate provenance rows; they are never collapsed into one unlabelled dollar figure (design §7). */
export type DisplayClass =
  | 'billed'
  | 'exact-route'
  | 'selected-reference'
  | 'reference'
  | 'published'
  | 'api-equivalent'
  | 'reported-partial'
  | 'reconstructed'
  | 'unavailable';

export const DISPLAY_CLASSES: readonly DisplayClass[] = [
  'billed', 'exact-route', 'selected-reference', 'reference', 'published', 'api-equivalent',
  'reported-partial', 'reconstructed', 'unavailable',
];

export interface Contribution {
  segment: string;
  sequence: number;
  recordedAt: string;
  requestId: string;
  agentId: string;
  usageUnitId: string;
  displayClass: DisplayClass;
  displayTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  displayNano?: bigint;
  reminderTokens: number;
  reminderNano: bigint;
  /** The unit's providers attempts could not all be attributed to its final total. */
  unattributed?: boolean;
}

export interface UnitSummary {
  usageUnitId: string;
  requestId: string;
  agentId: string;
  connectionId: string;
  modelId: string;
  providerAttempts: number;
  state: 'open' | 'settled' | 'gap';
  firstRecordedAt: string;
}

export interface AggregateResult {
  contributions: Contribution[];
  units: Map<string, UnitSummary>;
  /** Ids whose duplicate copies disagree; excluded from reminder totals. */
  quarantined: Set<string>;
  diagnostics: string[];
  /** segment -> highest complete sequence observed (what a reset records). */
  watermarks: Record<string, number>;
  /** When the first durable event was recorded ("Tracked since"). */
  firstRecordedAt?: string;
}

function classOf(tokens: TokenBasis, displayBasis: CostBasis, reminder: ReminderValue): DisplayClass {
  if (tokens === 'reported-partial') return 'reported-partial';
  if (tokens === 'reconstructed' || tokens === 'unavailable') return 'reconstructed';
  switch (displayBasis) {
    case 'billed': return 'billed';
    case 'user-model-override':
    case 'account-coefficient':
    case 'account-group':
    case 'authenticated-account':
      return 'exact-route';
    case 'unode-reference':
    case 'roam-reference':
      return reminder.basis === 'selected-reference' ? 'selected-reference' : 'reference';
    case 'gateway-published': return 'published';
    case 'api-equivalent': return 'api-equivalent';
    default: return 'unavailable';
  }
}

function displayNanoOf(cost: UsageReceipt['displayCost']): bigint | undefined {
  return cost.basis === 'unavailable' ? undefined : parseNanoUsd(cost.nanoUsd);
}

function orderKey(a: StoredSpendEvent, b: StoredSpendEvent): number {
  const time = Date.parse(a.event.recordedAt) - Date.parse(b.event.recordedAt);
  if (time !== 0) return time;
  if (a.segment !== b.segment) return a.segment < b.segment ? -1 : 1;
  return a.event.sequence - b.event.sequence;
}

interface UnitBuild {
  start?: StoredSpendEvent & { event: Extract<StoredSpendEvent['event'], { kind: 'usage-unit-start' }> };
  progress: Array<StoredSpendEvent & { event: Extract<StoredSpendEvent['event'], { kind: 'usage-progress' }> }>;
  receipt?: StoredSpendEvent & { event: Extract<StoredSpendEvent['event'], { kind: 'usage-receipt' }> };
  gap?: StoredSpendEvent;
  /** When the unit's first attempt was recorded. */
  firstAt?: string;
}

/** Aggregate every valid event. The input may contain duplicates from several windows. */
export function aggregateSpend(events: readonly StoredSpendEvent[]): AggregateResult {
  const diagnostics: string[] = [];
  const quarantined = new Set<string>();
  const byId = new Map<string, { stored: StoredSpendEvent; identity: string }>();
  const watermarks: Record<string, number> = {};
  let firstRecordedAt: string | undefined;
  for (const stored of events) {
    watermarks[stored.segment] = Math.max(watermarks[stored.segment] ?? 0, stored.event.sequence);
    if (!firstRecordedAt || stored.event.recordedAt < firstRecordedAt) firstRecordedAt = stored.event.recordedAt;
    const identity = eventIdentityPayload(stored.event);
    const prior = byId.get(stored.event.eventId);
    if (!prior) {
      byId.set(stored.event.eventId, { stored, identity });
    } else if (prior.identity !== identity) {
      if (!quarantined.has(stored.event.eventId)) diagnostics.push(`Conflicting copies of ${stored.event.eventId}; excluded from reminder totals.`);
      quarantined.add(stored.event.eventId);
    }
  }

  const units = new Map<string, UnitBuild>();
  const unit = (id: string): UnitBuild => {
    let entry = units.get(id);
    if (!entry) { entry = { progress: [] }; units.set(id, entry); }
    return entry;
  };
  const adjustments: StoredSpendEvent[] = [];
  const unique = [...byId.values()].map((entry) => entry.stored);
  // Attempt-count updates are replacement starts with a higher count: keep the highest valid one.
  for (const stored of unique) {
    const event = stored.event;
    switch (event.kind) {
      case 'usage-unit-start': {
        const entry = unit(event.usageUnitId);
        if (!entry.start || entry.start.event.providerAttempts < event.providerAttempts) {
          if (entry.start && (entry.start.event.requestId !== event.requestId || entry.start.event.agentId !== event.agentId)) {
            diagnostics.push(`Usage unit ${event.usageUnitId} changed identity between attempts; excluded from reminder totals.`);
            quarantined.add(event.usageUnitId);
          }
          entry.start = stored as NonNullable<UnitBuild['start']>;
        }
        if (!entry.firstAt || event.recordedAt < entry.firstAt) entry.firstAt = event.recordedAt;
        break;
      }
      case 'usage-progress':
        unit(event.usageUnitId).progress.push(stored as UnitBuild['progress'][number]);
        break;
      case 'usage-receipt':
        unit(event.receipt.usageUnitId).receipt = stored as NonNullable<UnitBuild['receipt']>;
        break;
      case 'coverage-gap':
        unit(event.usageUnitId).gap = stored;
        break;
      case 'cost-adjustment':
        adjustments.push(stored);
        break;
    }
  }

  // Apply adjustments in order; each is a compare-and-set on the receipt's current basis.
  const adjusted = new Map<string, { displayCost: UsageReceipt['displayCost']; reminderValue: ReminderValue }>();
  const receiptsById = new Map<string, UsageReceipt>();
  for (const entry of units.values()) if (entry.receipt) receiptsById.set(entry.receipt.event.receipt.receiptId, entry.receipt.event.receipt);
  for (const stored of adjustments.sort(orderKey)) {
    const event = stored.event;
    if (event.kind !== 'cost-adjustment') continue;
    const receipt = receiptsById.get(event.receiptId);
    if (!receipt) { diagnostics.push(`Cost adjustment ${event.adjustmentId} names an unknown receipt; ignored.`); continue; }
    const current = adjusted.get(event.receiptId) ?? { displayCost: receipt.displayCost, reminderValue: receipt.reminderValue };
    if (current.displayCost.basis !== event.expectedCostBasis) {
      diagnostics.push(`Cost adjustment ${event.adjustmentId} is stale (receipt basis ${current.displayCost.basis}); ignored.`);
      continue;
    }
    // A reconstructed or partial receipt never gains reminder authority through an adjustment.
    const reminderValue = receipt.tokens.basis === 'reported' ? event.reminderValue : { basis: 'not-eligible' as const };
    adjusted.set(event.receiptId, { displayCost: event.displayCost, reminderValue });
  }

  const contributions: Contribution[] = [];
  const summaries = new Map<string, UnitSummary>();
  for (const [usageUnitId, entry] of units) {
    const start = entry.start?.event;
    if (!start) {
      if (entry.progress.length > 0 || entry.receipt || entry.gap) {
        diagnostics.push(`Usage unit ${usageUnitId} has no start record; excluded.`);
      }
      continue;
    }
    const unitQuarantined = quarantined.has(usageUnitId);
    const state: UnitSummary['state'] = entry.receipt ? 'settled' : entry.gap ? 'gap' : 'open';
    summaries.set(usageUnitId, {
      usageUnitId,
      requestId: start.requestId,
      agentId: start.agentId,
      connectionId: start.connectionId,
      modelId: start.modelId,
      providerAttempts: start.providerAttempts,
      state,
      firstRecordedAt: entry.firstAt ?? start.recordedAt,
    });
    let progressTokens = { input: 0, cached: 0, output: 0, reminder: 0 };
    let progressDisplayNano = 0n;
    const firstProgress = contributions.length;
    let progressReminderNano = 0n;
    const seenAttempts = new Set<number>();
    for (const progress of entry.progress.sort((a, b) => a.event.providerAttempt - b.event.providerAttempt)) {
      const event = progress.event;
      if (event.requestId !== start.requestId || event.providerAttempt > start.providerAttempts || seenAttempts.has(event.providerAttempt)) {
        diagnostics.push(`Progress ${event.progressId} does not match its unit; excluded.`);
        continue;
      }
      seenAttempts.add(event.providerAttempt);
      const excluded = unitQuarantined || quarantined.has(event.eventId);
      const reminderNano = excluded ? 0n : parseNanoUsd(event.reminderValue.nanoUsd) ?? 0n;
      const reminderTokens = excluded ? 0 : event.reminderValue.tokens ?? 0;
      const displayNano = displayNanoOf(event.displayCost);
      progressTokens = {
        input: progressTokens.input + event.tokens.input,
        cached: progressTokens.cached + (event.tokens.cachedInput ?? 0),
        output: progressTokens.output + event.tokens.output,
        reminder: progressTokens.reminder + (event.reminderValue.tokens ?? 0),
      };
      progressDisplayNano += displayNano ?? 0n;
      progressReminderNano += parseNanoUsd(event.reminderValue.nanoUsd) ?? 0n;
      contributions.push({
        segment: progress.segment,
        sequence: event.sequence,
        recordedAt: event.recordedAt,
        requestId: start.requestId,
        agentId: start.agentId,
        usageUnitId,
        displayClass: classOf('reported', event.displayCost.basis, event.reminderValue),
        displayTokens: event.tokens.input + event.tokens.output,
        inputTokens: event.tokens.input,
        cachedInputTokens: event.tokens.cachedInput ?? 0,
        outputTokens: event.tokens.output,
        ...(displayNano !== undefined ? { displayNano } : {}),
        reminderTokens,
        reminderNano,
      });
    }
    if (!entry.receipt) continue;
    const receiptEvent = entry.receipt.event;
    const receipt = receiptEvent.receipt;
    const cost = adjusted.get(receipt.receiptId) ?? { displayCost: receipt.displayCost, reminderValue: receipt.reminderValue };
    if (receipt.requestId !== start.requestId || receipt.agentId !== start.agentId) {
      diagnostics.push(`Receipt ${receipt.receiptId} does not match its unit; excluded.`);
      continue;
    }
    const covered = new Set(receipt.coveredProgressIds ?? []);
    const uncovered = entry.progress.filter((progress) => !covered.has(progress.event.progressId));
    if (uncovered.length > 0) {
      diagnostics.push(`Receipt ${receipt.receiptId} does not list ${uncovered.length} progress record(s); they are treated as covered.`);
    }
    const residual = (total: number, part: number) => Math.max(0, total - part);
    const tokens: UsageTokens = receipt.tokens;
    const input = residual(tokens.input, progressTokens.input);
    const cached = residual(tokens.cachedInput ?? 0, progressTokens.cached);
    const output = residual(tokens.output, progressTokens.output);
    const receiptDisplayNano = displayNanoOf(cost.displayCost);
    const displayClass = classOf(tokens.basis, cost.displayCost.basis, cost.reminderValue);
    let displayNano = receiptDisplayNano === undefined ? undefined
      : receiptDisplayNano > progressDisplayNano ? receiptDisplayNano - progressDisplayNano : 0n;
    if (tokens.basis === 'reported') {
      // A complete receipt is the unit's final word on its price (billed, or re-priced by an adjustment). Its progress
      // is shown under the receipt's label, and the receipt's total is spread over progress and residual by tokens,
      // so the rows and each period add up to exactly that total. Reminder amounts are untouched: they stay at each
      // record's own sequence. A partial or reconstructed receipt keeps completed progress under its own label.
      const progress = contributions.slice(firstProgress);
      const weight = progress.reduce((sum, contribution) => sum + BigInt(contribution.displayTokens), BigInt(input + output));
      let allocated = 0n;
      for (const contribution of progress) {
        contribution.displayClass = displayClass;
        if (receiptDisplayNano === undefined) {
          delete contribution.displayNano;
          continue;
        }
        const share = weight > 0n ? (receiptDisplayNano * BigInt(contribution.displayTokens)) / weight : 0n;
        contribution.displayNano = share;
        allocated += share;
      }
      if (receiptDisplayNano !== undefined) displayNano = receiptDisplayNano - allocated;
    }
    const excluded = unitQuarantined || quarantined.has(receiptEvent.eventId);
    let reminderTokens = 0;
    let reminderNano = 0n;
    if (!excluded && cost.reminderValue.basis !== 'not-eligible') {
      const totalTokens = cost.reminderValue.tokens ?? 0;
      if (cost.reminderValue.tokens !== undefined) {
        if (totalTokens < progressTokens.reminder) {
          diagnostics.push(`Receipt ${receipt.receiptId} reports fewer tokens than its progress; the difference is display-only.`);
        } else {
          reminderTokens = totalTokens - progressTokens.reminder;
        }
      }
      const totalNano = parseNanoUsd(cost.reminderValue.nanoUsd);
      if (totalNano !== undefined) {
        if (totalNano < progressReminderNano) {
          diagnostics.push(`Receipt ${receipt.receiptId} prices below its progress; the difference is display-only.`);
        } else {
          reminderNano = totalNano - progressReminderNano;
        }
      }
    }
    contributions.push({
      segment: entry.receipt.segment,
      sequence: receiptEvent.sequence,
      recordedAt: receiptEvent.recordedAt,
      requestId: start.requestId,
      agentId: start.agentId,
      usageUnitId,
      displayClass,
      displayTokens: input + output,
      inputTokens: input,
      cachedInputTokens: cached,
      outputTokens: output,
      ...(displayNano !== undefined ? { displayNano } : {}),
      reminderTokens,
      reminderNano,
      ...(receipt.coverageGap ? { unattributed: true } : {}),
    });
  }
  return { contributions, units: summaries, quarantined, diagnostics, watermarks, ...(firstRecordedAt ? { firstRecordedAt } : {}) };
}

// ─── Counters, resets and the alert ladder ──────────────────────────────────────────

export type CounterScope =
  | { kind: 'request'; requestId: string }
  | { kind: 'project-period'; periodId: string; period: 'day' | 'month'; timeZone: string }
  | { kind: 'agent-period'; agentId: string; periodId: string; period: 'day' | 'month'; timeZone: string };

/** The latest reset (in control order) that applies to a counter, or undefined for the initial epoch. */
export function latestApplicableReset(control: SpendControlV1, scope: CounterScope): CounterResetV1 | undefined {
  for (let i = control.resets.length - 1; i >= 0; i--) {
    const reset = control.resets[i];
    if (reset.scope === 'project-all') return reset;
    switch (scope.kind) {
      case 'request':
        if (reset.scope === 'request' && reset.requestId === scope.requestId) return reset;
        break;
      case 'project-period':
        if (reset.scope === 'project-period' && reset.periodId === scope.periodId) return reset;
        break;
      case 'agent-period':
        if ((reset.scope === 'agent-period' && reset.agentId === scope.agentId && reset.periodId === scope.periodId)
          || (reset.scope === 'project-period' && reset.periodId === scope.periodId)) return reset;
        break;
    }
  }
  return undefined;
}

/** Derived, never stored separately: `initial` until a matching reset exists. */
export function counterEpochOf(control: SpendControlV1, scope: CounterScope): string {
  return latestApplicableReset(control, scope)?.resetId ?? 'initial';
}

/** A racing event lands at or below the captured watermark (before the reset) or above it (after). */
export function afterReset(contribution: Pick<Contribution, 'segment' | 'sequence'>, reset: CounterResetV1 | undefined): boolean {
  if (!reset) return true;
  const mark = reset.watermarks[contribution.segment];
  return mark === undefined || contribution.sequence > mark;
}

export interface CounterTotals {
  eligibleTokens: number;
  eligibleNanoUsd: bigint;
  displayTokens: number;
  byClass: Record<DisplayClass, { tokens: number; nanoUsd: bigint; hasCost: boolean; count: number }>;
  unattributedUnits: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export function emptyTotals(): CounterTotals {
  return {
    eligibleTokens: 0,
    eligibleNanoUsd: 0n,
    displayTokens: 0,
    byClass: Object.fromEntries(DISPLAY_CLASSES.map((c) => [c, { tokens: 0, nanoUsd: 0n, hasCost: false, count: 0 }])) as CounterTotals['byClass'],
    unattributedUnits: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
}

export function addContribution(totals: CounterTotals, contribution: Contribution): void {
  totals.eligibleTokens += contribution.reminderTokens;
  totals.eligibleNanoUsd += contribution.reminderNano;
  totals.displayTokens += contribution.displayTokens;
  totals.inputTokens += contribution.inputTokens;
  totals.cachedInputTokens += contribution.cachedInputTokens;
  totals.outputTokens += contribution.outputTokens;
  const row = totals.byClass[contribution.displayClass];
  row.tokens += contribution.displayTokens;
  row.count += 1;
  if (contribution.displayNano !== undefined) {
    row.nanoUsd += contribution.displayNano;
    row.hasCost = true;
  }
  if (contribution.unattributed) totals.unattributedUnits += 1;
}

function inScope(contribution: Contribution, scope: CounterScope): boolean {
  switch (scope.kind) {
    case 'request':
      return contribution.requestId === scope.requestId;
    case 'project-period':
      return periodIdFor(Date.parse(contribution.recordedAt), scope.period, scope.timeZone) === scope.periodId;
    case 'agent-period':
      return contribution.agentId === scope.agentId
        && periodIdFor(Date.parse(contribution.recordedAt), scope.period, scope.timeZone) === scope.periodId;
  }
}

/** Totals of one counter since its latest applicable reset. */
export function counterTotals(aggregate: AggregateResult, control: SpendControlV1, scope: CounterScope): CounterTotals {
  const reset = latestApplicableReset(control, scope);
  const totals = emptyTotals();
  for (const contribution of aggregate.contributions) {
    if (inScope(contribution, scope) && afterReset(contribution, reset)) addContribution(totals, contribution);
  }
  return totals;
}

export function totalsSnapshot(totals: CounterTotals): SpendTotalsSnapshot {
  return {
    eligibleTokens: totals.eligibleTokens,
    eligibleNanoUsd: totals.eligibleNanoUsd.toString(),
    displayTokens: totals.displayTokens,
  };
}

/**
 * The ladder: 80, 100, 150, 200, then every further whole multiple (300, 400, …), as percentages of the target.
 * Returns the fixed rungs reached plus the highest whole multiple reached: a jump from 50% to 450% returns
 * 80, 100, 150, 200 and 400. Only the highest reached rung is claimed and presented, and a counter never claims a
 * rung at or below one it already claimed, so the multiples in between are never needed and the ladder has no
 * upper bound. Integer arithmetic; a multiple beyond 2^53 / 100 becomes the nearest representable number, so an
 * alert that far out can skip a multiple but never repeats one.
 */
export function reachedThresholds(value: bigint, target: bigint): number[] {
  if (target <= 0n || value <= 0n) return [];
  const reached: number[] = [];
  for (const pct of [80, 100, 150, 200]) {
    if (value * 100n >= target * BigInt(pct)) reached.push(pct);
  }
  const multiple = value / target;
  if (multiple >= 3n) reached.push(Number(multiple * 100n));
  return reached;
}

export function thresholdLoudness(threshold: number): 'quiet' | 'over-target' {
  return threshold < 100 ? 'quiet' : 'over-target';
}

export interface NoticeKeyParts {
  scopeKey: string;
  dimension: 'tokens' | 'usd';
  targetRevision: string;
  counterEpoch: string;
  periodId?: string;
  threshold: number;
}

/** One counter's part of its notice keys: everything but the threshold. */
export function noticeCounterKey(parts: Omit<NoticeKeyParts, 'threshold'>): string {
  return [parts.scopeKey, parts.dimension, parts.targetRevision, parts.counterEpoch, parts.periodId ?? '-'].join('|');
}

/**
 * The durable claim key for one threshold appearance (design §13.4): scope, target revision, counter epoch,
 * period and threshold. A new target revision or counter epoch deliberately starts the ladder again.
 */
export function noticeKey(parts: NoticeKeyParts): string {
  return `${noticeCounterKey(parts)}|${String(parts.threshold)}`;
}

/** A stored claim key split into its counter, scope, period and threshold; undefined if it is not one of ours. */
export function parseNoticeKey(key: string): { counter: string; scopeKey: string; periodId: string; threshold: number } | undefined {
  const cut = key.lastIndexOf('|');
  if (cut <= 0) return undefined;
  const threshold = Number(key.slice(cut + 1));
  const counter = key.slice(0, cut);
  const parts = counter.split('|');
  if (!Number.isFinite(threshold) || parts.length !== 5) return undefined;
  return { counter, scopeKey: parts[0], periodId: parts[4], threshold };
}
