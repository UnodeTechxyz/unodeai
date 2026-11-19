/*---------------------------------------------------------------------------------------------
 *  UnodeAi - spend event, receipt and control types (v0.9.89, design §3, §13.4)
 *
 *  Closed, versioned shapes plus their validators. A value that does not validate is quarantined by the
 *  caller; it never becomes zero, a default or a permissive fallback.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { parseNanoUsd } from './Money';

export const SPEND_SCHEMA_VERSION = 1 as const;

export type CostBasis =
  | 'billed'
  | 'user-model-override'
  | 'account-coefficient'
  | 'account-group'
  | 'authenticated-account'
  | 'gateway-published'
  | 'unode-reference'
  | 'roam-reference'
  | 'api-equivalent'
  | 'unavailable';

export const COST_BASES: readonly CostBasis[] = [
  'billed', 'user-model-override', 'account-coefficient', 'account-group', 'authenticated-account',
  'gateway-published', 'unode-reference', 'roam-reference', 'api-equivalent', 'unavailable',
];

export type TokenBasis = 'reported' | 'reported-partial' | 'reconstructed' | 'unavailable';
export type ReminderBasis = 'reported-tokens' | 'billed' | 'exact-route' | 'selected-reference' | 'not-eligible';

export interface UsageTokens {
  input: number;
  cachedInput?: number;
  output: number;
  reasoningOutput?: number;
  basis: TokenBasis;
}

export type DisplayCost =
  | { nanoUsd: string; basis: Exclude<CostBasis, 'unavailable'>; sourceId: string; sourceDate?: string; stale?: true }
  | { basis: 'unavailable' };

export interface ReminderValue {
  tokens?: number;
  nanoUsd?: string;
  basis: ReminderBasis;
}

export interface UsageReceipt {
  schemaVersion: 1;
  receiptId: string;
  requestId: string;
  runId?: string;
  usageUnitId: string;
  providerAttempts: number;
  coveredProgressIds?: string[];
  agentId: string;
  connectionId: string;
  modelId: string;
  observedAt: string;
  tokens: UsageTokens;
  displayCost: DisplayCost;
  reminderValue: ReminderValue;
  coverageGap?: 'one-or-more-attempts-unattributed';
}

export type SpendEventPayload =
  | { kind: 'usage-unit-start'; usageUnitId: string; requestId: string; agentId: string;
      connectionId: string; modelId: string; providerAttempts: number }
  | { kind: 'usage-progress'; progressId: string; usageUnitId: string; requestId: string;
      providerAttempt: number; tokens: UsageTokens & { basis: 'reported' };
      displayCost: DisplayCost; reminderValue: ReminderValue }
  | { kind: 'usage-receipt'; receipt: UsageReceipt }
  | { kind: 'cost-adjustment'; adjustmentId: string; receiptId: string; expectedCostBasis: CostBasis;
      displayCost: DisplayCost; reminderValue: ReminderValue }
  | { kind: 'coverage-gap'; usageUnitId: string; requestId: string; reason: 'no-terminal-usage' };

export interface SpendEventEnvelope {
  schemaVersion: 1;
  eventId: string;
  hostEpoch: string;
  sequence: number;
  recordedAt: string;
}

export type SpendEventV1 = SpendEventEnvelope & SpendEventPayload;

/** A validated event plus where it was read from; the segment and sequence order it against reset watermarks. */
export interface StoredSpendEvent {
  segment: string;
  event: SpendEventV1;
}

/** Totals a reset retires, so the user can still see what the counter held. */
export interface SpendTotalsSnapshot {
  eligibleTokens: number;
  eligibleNanoUsd: string;
  displayTokens: number;
}

export type ResetScope = 'request' | 'project-period' | 'agent-period' | 'project-all';

export interface CounterResetV1 {
  resetId: string;
  scope: ResetScope;
  requestId?: string;
  agentId?: string;
  periodId?: string;
  resetAt: string;
  actor: 'user';
  /** shard segment -> highest complete sequence observed when the reset committed. */
  watermarks: Record<string, number>;
  previousTotals: SpendTotalsSnapshot;
}

export type RepositoryTargetDecision =
  | { mode: 'accepted-digest'; contentDigest: string; decidedAt: string }
  | { mode: 'ignore-project'; decidedAt: string };

export interface SpendControlV1 {
  schemaVersion: 1;
  revision: number;
  resets: CounterResetV1[];
  noticeClaims: Array<{ key: string; claimedAt: string }>;
  repositoryTargetDecision?: RepositoryTargetDecision;
  repairs: Array<{ repairId: string; repairedAt: string; reason: string }>;
}

export function emptySpendControl(): SpendControlV1 {
  return { schemaVersion: 1, revision: 0, resets: [], noticeClaims: [], repairs: [] };
}

// ─── Validation ────────────────────────────────────────────────────────────────

const ID = /^[A-Za-z0-9._:@-]{1,200}$/;
const SHORT_ID = /^[A-Za-z0-9._:@/+-]{1,300}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_TOKENS = 1_000_000_000_000_000;

/**
 * An id as it may be stored in a spend event. A value outside the closed character set (a model name with a space,
 * a hand-written agent id) becomes a stable hashed token rather than an event the validator would refuse, so usage
 * is never lost because of a name.
 */
export function spendEventId(value: string, kind: 'id' | 'route'): string {
  const pattern = kind === 'id' ? ID : SHORT_ID;
  return pattern.test(value) ? value : `h-${createHash('sha256').update(value).digest('hex').slice(0, 40)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function isRouteId(value: unknown): value is string {
  return typeof value === 'string' && SHORT_ID.test(value);
}

function isCount(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= MAX_TOKENS;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function isCostBasis(value: unknown): value is CostBasis {
  return typeof value === 'string' && (COST_BASES as readonly string[]).includes(value);
}

export function validUsageTokens(value: unknown): value is UsageTokens {
  if (!isObject(value) || !onlyKeys(value, ['input', 'cachedInput', 'output', 'reasoningOutput', 'basis'])) return false;
  if (!isCount(value.input) || !isCount(value.output)) return false;
  if (value.cachedInput !== undefined && (!isCount(value.cachedInput) || value.cachedInput > value.input)) return false;
  if (value.reasoningOutput !== undefined && !isCount(value.reasoningOutput)) return false;
  return value.basis === 'reported' || value.basis === 'reported-partial'
    || value.basis === 'reconstructed' || value.basis === 'unavailable';
}

export function validDisplayCost(value: unknown): value is DisplayCost {
  if (!isObject(value)) return false;
  if (value.basis === 'unavailable') return onlyKeys(value, ['basis']);
  if (!onlyKeys(value, ['nanoUsd', 'basis', 'sourceId', 'sourceDate', 'stale'])) return false;
  // A priced cost never names the unavailable basis, whatever order the checks above run in.
  return isCostBasis(value.basis) && value.basis !== 'unavailable'
    && parseNanoUsd(value.nanoUsd) !== undefined
    && isRouteId(value.sourceId)
    && (value.sourceDate === undefined || isTimestamp(value.sourceDate))
    && (value.stale === undefined || value.stale === true);
}

export function validReminderValue(value: unknown): value is ReminderValue {
  if (!isObject(value) || !onlyKeys(value, ['tokens', 'nanoUsd', 'basis'])) return false;
  if (value.tokens !== undefined && !isCount(value.tokens)) return false;
  if (value.nanoUsd !== undefined && parseNanoUsd(value.nanoUsd) === undefined) return false;
  switch (value.basis) {
    case 'not-eligible':
      return value.tokens === undefined && value.nanoUsd === undefined;
    case 'reported-tokens':
      return value.tokens !== undefined && value.nanoUsd === undefined;
    case 'billed':
    case 'exact-route':
    case 'selected-reference':
      return value.nanoUsd !== undefined;
    default:
      return false;
  }
}

export function validUsageReceipt(value: unknown): value is UsageReceipt {
  if (!isObject(value) || !onlyKeys(value, [
    'schemaVersion', 'receiptId', 'requestId', 'runId', 'usageUnitId', 'providerAttempts', 'coveredProgressIds',
    'agentId', 'connectionId', 'modelId', 'observedAt', 'tokens', 'displayCost', 'reminderValue', 'coverageGap',
  ])) return false;
  if (value.schemaVersion !== 1 || !isId(value.receiptId) || !isId(value.requestId) || !isId(value.usageUnitId)) return false;
  if (value.receiptId !== `usage:${value.usageUnitId}`) return false;
  if (value.runId !== undefined && !isId(value.runId)) return false;
  if (!isCount(value.providerAttempts)) return false;
  if (value.coveredProgressIds !== undefined) {
    if (!Array.isArray(value.coveredProgressIds) || value.coveredProgressIds.length > (value.providerAttempts as number)) return false;
    const seen = new Set<string>();
    for (const id of value.coveredProgressIds) {
      if (!isId(id) || seen.has(id) || !id.startsWith(`progress:${value.usageUnitId}:`)) return false;
      seen.add(id);
    }
  }
  return isId(value.agentId) && isRouteId(value.connectionId) && isRouteId(value.modelId)
    && isTimestamp(value.observedAt)
    && validUsageTokens(value.tokens)
    && validDisplayCost(value.displayCost)
    && validReminderValue(value.reminderValue)
    && (value.coverageGap === undefined || value.coverageGap === 'one-or-more-attempts-unattributed');
}

const ENVELOPE_KEYS = ['schemaVersion', 'eventId', 'hostEpoch', 'sequence', 'recordedAt', 'kind'] as const;

/** Validate one parsed NDJSON line. Unknown schema versions and unknown keys fail closed. */
export function validateSpendEvent(value: unknown): SpendEventV1 | undefined {
  if (!isObject(value)) return undefined;
  if (value.schemaVersion !== 1 || !isId(value.eventId) || !isId(value.hostEpoch)
    || !isCount(value.sequence, 1) || !isTimestamp(value.recordedAt)) {
    return undefined;
  }
  const keys = (extra: readonly string[]) => onlyKeys(value, [...ENVELOPE_KEYS, ...extra]);
  switch (value.kind) {
    case 'usage-unit-start':
      return keys(['usageUnitId', 'requestId', 'agentId', 'connectionId', 'modelId', 'providerAttempts'])
        && isId(value.usageUnitId) && isId(value.requestId) && isId(value.agentId)
        && isRouteId(value.connectionId) && isRouteId(value.modelId) && isCount(value.providerAttempts, 1)
        && value.eventId === `start:${value.usageUnitId}:${value.providerAttempts}`
        ? value as unknown as SpendEventV1 : undefined;
    case 'usage-progress':
      return keys(['progressId', 'usageUnitId', 'requestId', 'providerAttempt', 'tokens', 'displayCost', 'reminderValue'])
        && isId(value.usageUnitId) && isId(value.requestId) && isCount(value.providerAttempt, 1)
        && value.progressId === `progress:${value.usageUnitId}:${value.providerAttempt}`
        && value.eventId === value.progressId
        && validUsageTokens(value.tokens) && (value.tokens as UsageTokens).basis === 'reported'
        && validDisplayCost(value.displayCost) && validReminderValue(value.reminderValue)
        ? value as unknown as SpendEventV1 : undefined;
    case 'usage-receipt':
      return keys(['receipt']) && validUsageReceipt(value.receipt)
        && value.eventId === (value.receipt as UsageReceipt).receiptId
        ? value as unknown as SpendEventV1 : undefined;
    case 'cost-adjustment':
      return keys(['adjustmentId', 'receiptId', 'expectedCostBasis', 'displayCost', 'reminderValue'])
        && isId(value.adjustmentId) && value.eventId === value.adjustmentId && isId(value.receiptId)
        && isCostBasis(value.expectedCostBasis)
        && validDisplayCost(value.displayCost) && validReminderValue(value.reminderValue)
        ? value as unknown as SpendEventV1 : undefined;
    case 'coverage-gap':
      return keys(['usageUnitId', 'requestId', 'reason'])
        && isId(value.usageUnitId) && isId(value.requestId)
        && value.reason === 'no-terminal-usage' && value.eventId === `gap:${value.usageUnitId}`
        ? value as unknown as SpendEventV1 : undefined;
    default:
      return undefined;
  }
}

function validTotalsSnapshot(value: unknown): value is SpendTotalsSnapshot {
  return isObject(value) && onlyKeys(value, ['eligibleTokens', 'eligibleNanoUsd', 'displayTokens'])
    && isCount(value.eligibleTokens) && parseNanoUsd(value.eligibleNanoUsd) !== undefined && isCount(value.displayTokens);
}

function validReset(value: unknown): value is CounterResetV1 {
  if (!isObject(value) || !onlyKeys(value, [
    'resetId', 'scope', 'requestId', 'agentId', 'periodId', 'resetAt', 'actor', 'watermarks', 'previousTotals',
  ])) return false;
  if (!isId(value.resetId) || value.actor !== 'user' || !isTimestamp(value.resetAt)) return false;
  if (!isObject(value.watermarks) || !Object.entries(value.watermarks).every(([segment, sequence]) =>
    SHORT_ID.test(segment) && isCount(sequence))) return false;
  if (!validTotalsSnapshot(value.previousTotals)) return false;
  const periodOk = (v: unknown) => typeof v === 'string' && v.length <= 80 && /^\d{4}-\d{2}(?:-\d{2})?@[A-Za-z0-9_+\-/]{1,64}$/.test(v);
  switch (value.scope) {
    case 'request': return isId(value.requestId) && value.agentId === undefined && value.periodId === undefined;
    case 'project-period': return periodOk(value.periodId) && value.requestId === undefined && value.agentId === undefined;
    case 'agent-period': return periodOk(value.periodId) && isId(value.agentId) && value.requestId === undefined;
    case 'project-all': return value.requestId === undefined && value.agentId === undefined && value.periodId === undefined;
    default: return false;
  }
}

/** Validate a control file. An unknown schema version is `undefined`: fail closed, never overwrite. */
export function validateSpendControl(value: unknown): SpendControlV1 | undefined {
  if (!isObject(value) || !onlyKeys(value, [
    'schemaVersion', 'revision', 'resets', 'noticeClaims', 'repositoryTargetDecision', 'repairs',
  ])) return undefined;
  if (value.schemaVersion !== 1 || !isCount(value.revision)) return undefined;
  if (!Array.isArray(value.resets) || !value.resets.every(validReset)) return undefined;
  if (!Array.isArray(value.noticeClaims) || !value.noticeClaims.every((claim) =>
    isObject(claim) && onlyKeys(claim, ['key', 'claimedAt'])
    && typeof claim.key === 'string' && claim.key.length > 0 && claim.key.length <= 600 && isTimestamp(claim.claimedAt))) {
    return undefined;
  }
  if (!Array.isArray(value.repairs) || !value.repairs.every((repair) =>
    isObject(repair) && onlyKeys(repair, ['repairId', 'repairedAt', 'reason'])
    && isId(repair.repairId) && isTimestamp(repair.repairedAt)
    && typeof repair.reason === 'string' && repair.reason.length <= 300)) {
    return undefined;
  }
  const decision = value.repositoryTargetDecision;
  if (decision !== undefined) {
    if (!isObject(decision)) return undefined;
    if (decision.mode === 'accepted-digest') {
      if (!onlyKeys(decision, ['mode', 'contentDigest', 'decidedAt'])
        || typeof decision.contentDigest !== 'string' || !DIGEST.test(decision.contentDigest)
        || !isTimestamp(decision.decidedAt)) return undefined;
    } else if (decision.mode === 'ignore-project') {
      if (!onlyKeys(decision, ['mode', 'decidedAt']) || !isTimestamp(decision.decidedAt)) return undefined;
    } else {
      return undefined;
    }
  }
  return value as unknown as SpendControlV1;
}

/**
 * Canonical JSON: object keys sorted, no whitespace, `undefined` members dropped. Used for digests and for
 * deciding whether two copies of one event id are the same event.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

/** The part of an event that must match for a duplicate id to be the same event (the envelope may differ). */
export function eventIdentityPayload(event: SpendEventV1): string {
  const { schemaVersion: _v, eventId: _e, hostEpoch: _h, sequence: _s, recordedAt: _r, ...payload } = event;
  if (payload.kind === 'usage-receipt') {
    // A receipt's observedAt is when its host settled it; the same receipt settled twice is still one receipt.
    const { observedAt: _o, ...receipt } = payload.receipt;
    return canonicalJson({ ...payload, receipt });
  }
  return canonicalJson(payload);
}
