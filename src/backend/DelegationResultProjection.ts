import type { CoordinatorDisposition, DelegationExecutionState } from './TeamTools';

export interface ResultRef { handle: string; revision: number }
export interface ResultScopeEvent {
  state: 'suspended' | 'closed' | 'reopened';
  cause: 'assignment-cancelled' | 'assignment-abandoned' | 'handle-superseded' | 'handle-abandoned'
    | 'coordinator-removed' | 'team-switched' | 'coordinator-stopped' | 'explicit-resume';
  recordedAt: string;
  by: 'user-action' | 'host-lifecycle';
  bodyRef?: { conversationId: string; messageId: string };
}
export interface StandingResult {
  ref: ResultRef;
  attemptId: string;
  settledEventId: string;
  state: 'ready' | 'failed';
  delivery: 'pending' | 'delivered';
  deliveredVia?: 'auto-wake' | 'collect-ready' | 'blocking-tool';
  decision?: { value: CoordinatorDisposition; reason?: string; recordedAt: string };
  decisionScopes?: ResultScopeEvent[];
  /** Sticky: contradictory copies never become an authoritative result by timestamp ordering. */
  conflict?: true;
  legacy?: true;
  /**
   * v0.9.99: this revision's one automatic PM review turn. `scheduled` once the host has registered it,
   * `consumed` once that turn was admitted. Content-free; a consumed revision never gets another.
   */
  reviewContinuation?: 'scheduled' | 'consumed';
}
export type ResultRecovery = 'decision-scope-unknown' | 'body-unavailable' | 'delivery-unknown' | 'recovery-data-not-saved';
export interface DelegationProjectionInput {
  handle: string;
  lifecycle: 'active' | 'settled' | 'cancelled' | 'interrupted';
  execution: DelegationExecutionState | 'ended' | 'unknown';
  wait: 'waiting' | 'elapsed' | 'not-waiting';
  standing?: StandingResult;
  reworkRunning?: { revision: number; attemptId: string };
  historical: boolean;
  recovery?: ResultRecovery;
  bodyAvailable?: boolean;
}
export interface DelegationResultProjection {
  handle: string;
  ref?: ResultRef;
  state: 'running' | 'ready' | 'awaiting-decision' | 'decided' | 'failed' | 'stopped'
    | 'stop-unconfirmed' | 'cancelled' | 'historical' | 'unknown' | 'awaiting-rework' | 'awaiting-human';
  execution: DelegationProjectionInput['execution'];
  wait: DelegationProjectionInput['wait'];
  delivery?: StandingResult['delivery'];
  decision?: StandingResult['decision'];
  nextAction: 'wait' | 'collect' | 'decide' | 'inspect' | 'resume' | 'rework' | 'ask-human' | 'none';
  blocksComplete: boolean;
  recovery?: ResultRecovery;
  scope?: ResultScopeEvent;
  reviewContinuation?: StandingResult['reviewContinuation'];
}

export const sameResultRef = (a: ResultRef, b: ResultRef): boolean => a.handle === b.handle && a.revision === b.revision;
/** A recorded disposition may still leave work or a human decision owed. One exhaustive table owns both. */
const dispositionProjection = {
  accepted: { state: 'decided', nextAction: 'none', blocksComplete: false },
  rejected: { state: 'decided', nextAction: 'none', blocksComplete: false },
  'needs-human': { state: 'awaiting-human', nextAction: 'ask-human', blocksComplete: true },
  'needs-rework': { state: 'awaiting-rework', nextAction: 'rework', blocksComplete: true },
  deferred: { state: 'decided', nextAction: 'none', blocksComplete: false },
  'accepted-with-caveat': { state: 'decided', nextAction: 'none', blocksComplete: false },
  'accepted-after-rework': { state: 'decided', nextAction: 'none', blocksComplete: false },
  'accepted-despite-framework-no-evidence': { state: 'decided', nextAction: 'none', blocksComplete: false },
  superseded: { state: 'decided', nextAction: 'none', blocksComplete: false },
  abandoned: { state: 'decided', nextAction: 'none', blocksComplete: false },
} as const satisfies Record<CoordinatorDisposition, Pick<DelegationResultProjection, 'state' | 'nextAction' | 'blocksComplete'>>;
const dispositions = new Set(Object.keys(dispositionProjection));
const scopeCauses = new Set<ResultScopeEvent['cause']>(['assignment-cancelled', 'assignment-abandoned', 'handle-superseded',
  'handle-abandoned', 'coordinator-removed', 'team-switched', 'coordinator-stopped', 'explicit-resume']);
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500;
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));

export function parseResultRef(value: unknown): ResultRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as ResultRef;
  return identity(raw.handle) && Number.isSafeInteger(raw.revision) && raw.revision >= 1
    ? { handle: raw.handle, revision: raw.revision } : undefined;
}

function parseScope(value: unknown): ResultScopeEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as ResultScopeEvent;
  if (!['suspended', 'closed', 'reopened'].includes(raw.state) || !scopeCauses.has(raw.cause)
    || !['user-action', 'host-lifecycle'].includes(raw.by) || !timestamp(raw.recordedAt)) return undefined;
  if ((raw.state === 'reopened') !== (raw.cause === 'explicit-resume')) return undefined;
  const bodyRef = raw.bodyRef && identity(raw.bodyRef.conversationId) && identity(raw.bodyRef.messageId)
    ? { conversationId: raw.bodyRef.conversationId, messageId: raw.bodyRef.messageId } : undefined;
  return { state: raw.state, cause: raw.cause, recordedAt: raw.recordedAt, by: raw.by, ...(bodyRef ? { bodyRef } : {}) };
}

export function parseStandingResult(value: unknown): StandingResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as StandingResult;
  const ref = parseResultRef(raw.ref);
  if (!ref || !identity(raw.attemptId) || !identity(raw.settledEventId) || !['ready', 'failed'].includes(raw.state)
    || !['pending', 'delivered'].includes(raw.delivery)) return undefined;
  if (raw.decision && (!dispositions.has(raw.decision.value) || !timestamp(raw.decision.recordedAt)
    || (raw.decision.reason !== undefined && (typeof raw.decision.reason !== 'string' || raw.decision.reason.length > 2000)))) return undefined;
  if (raw.decisionScopes !== undefined && (!Array.isArray(raw.decisionScopes) || raw.decisionScopes.length > 256
    || raw.decisionScopes.some(scope => !parseScope(scope)))) return undefined;
  return { ref, attemptId: raw.attemptId, settledEventId: raw.settledEventId, state: raw.state, delivery: raw.delivery,
    ...(raw.delivery === 'delivered' && ['auto-wake', 'collect-ready', 'blocking-tool'].includes(raw.deliveredVia ?? '') ? { deliveredVia: raw.deliveredVia } : {}),
    ...(raw.decision ? { decision: { value: raw.decision.value, recordedAt: raw.decision.recordedAt,
      ...(raw.decision.reason !== undefined ? { reason: raw.decision.reason } : {}) } } : {}),
    ...(raw.decisionScopes ? { decisionScopes: raw.decisionScopes.map(scope => parseScope(scope)!) } : {}),
    ...(raw.conflict ? { conflict: true } : {}), ...(raw.legacy ? { legacy: true } : {}),
    ...(raw.reviewContinuation === 'scheduled' || raw.reviewContinuation === 'consumed' ? { reviewContinuation: raw.reviewContinuation } : {}) };
}

/** No last-writer-wins for conflicting same-revision completion identities or decisions. */
export function mergeStandingResults(left: readonly StandingResult[], right: readonly StandingResult[]): StandingResult[] {
  const results = new Map<string, StandingResult>();
  for (const candidate of [...left, ...right]) {
    const parsed = parseStandingResult(candidate);
    if (!parsed) continue;
    const key = JSON.stringify(parsed.ref);
    const existing = results.get(key);
    if (!existing) { results.set(key, parsed); continue; }
    const conflict = existing.conflict || parsed.conflict || existing.attemptId !== parsed.attemptId
      || existing.settledEventId !== parsed.settledEventId || existing.state !== parsed.state
      || (!!existing.decision && !!parsed.decision && JSON.stringify(existing.decision) !== JSON.stringify(parsed.decision));
    const scopes = [...new Map([...(existing.decisionScopes ?? []), ...(parsed.decisionScopes ?? [])]
      .map(scope => [JSON.stringify(scope), scope])).values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    // A conflicting identity stays visibly unusable. Pick a deterministic representation, never an authority.
    const base = JSON.stringify(existing).localeCompare(JSON.stringify(parsed)) <= 0 ? existing : parsed;
    results.set(key, { ...base,
      delivery: existing.delivery === 'delivered' || parsed.delivery === 'delivered' ? 'delivered' : 'pending',
      ...((existing.deliveredVia ?? parsed.deliveredVia) ? { deliveredVia: [existing.deliveredVia, parsed.deliveredVia].filter(Boolean).sort()[0] as StandingResult['deliveredVia'] } : {}),
      ...((existing.decision ?? parsed.decision) ? { decision: [existing.decision, parsed.decision].filter(Boolean)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))[0] } : {}),
      ...(scopes.length ? { decisionScopes: scopes.slice(0, 256) } : {}),
      // A consumed continuation stays consumed whichever copy carries it.
      ...((existing.reviewContinuation ?? parsed.reviewContinuation) ? { reviewContinuation:
        existing.reviewContinuation === 'consumed' || parsed.reviewContinuation === 'consumed' ? 'consumed' as const : 'scheduled' as const } : {}),
      ...(conflict || scopes.length > 256 ? { conflict: true } : {}) });
  }
  return [...results.values()].sort((a, b) => a.ref.handle.localeCompare(b.ref.handle) || a.ref.revision - b.ref.revision);
}

/** One result, not one agent. Consumers keep all rows: a different handle/rework can still be running. */
export function projectDelegationResult(input: DelegationProjectionInput): DelegationResultProjection {
  const standing = input.reworkRunning ? undefined : input.standing;
  const scope = standing?.decisionScopes?.at(-1);
  const base = { handle: input.handle, execution: input.execution, wait: input.wait,
    ...(input.reworkRunning ? { ref: { handle: input.handle, revision: input.reworkRunning.revision } } : {}),
    ...(standing ? { ref: { ...standing.ref }, delivery: standing.delivery, ...(standing.decision ? { decision: { ...standing.decision } } : {}) } : {}),
    ...(scope ? { scope: structuredClone(scope) } : {}), ...(input.recovery ? { recovery: input.recovery } : {}),
    ...(standing?.reviewContinuation ? { reviewContinuation: standing.reviewContinuation } : {}) };
  const row = (state: DelegationResultProjection['state'], nextAction: DelegationResultProjection['nextAction'], blocksComplete: boolean): DelegationResultProjection => ({ ...base, state, nextAction, blocksComplete });
  if (input.historical || scope?.state === 'closed') return row('historical', 'none', false);
  if (scope?.state === 'suspended') return row('stopped', 'resume', false);
  if (input.execution === 'stop-unconfirmed') return row('stop-unconfirmed', 'inspect', true);
  if (input.reworkRunning || ['running', 'queued', 'stopping'].includes(input.execution)) return row('running', 'wait', true);
  if (standing?.conflict || (standing && standing.ref.handle !== input.handle) || input.recovery === 'decision-scope-unknown') return row('unknown', 'inspect', true);
  if (standing) {
    if (standing.decision) {
      const projected = Object.hasOwn(dispositionProjection, standing.decision.value) ? dispositionProjection[standing.decision.value] : undefined;
      return projected ? row(projected.state, projected.nextAction, projected.blocksComplete) : row('unknown', 'inspect', true);
    }
    if (input.bodyAvailable === false || input.recovery === 'body-unavailable') return row('unknown', 'inspect', true);
    if (input.recovery === 'delivery-unknown') return row('unknown', 'inspect', true);
    if (standing.state === 'failed') return row('failed', standing.delivery === 'pending' ? 'collect' : 'decide', true);
    return standing.delivery === 'pending' ? row('ready', 'collect', true) : row('awaiting-decision', 'decide', true);
  }
  if (input.lifecycle === 'cancelled') return row('cancelled', 'none', false);
  if (input.lifecycle === 'interrupted' || input.execution === 'stopped') return row('stopped', 'inspect', true);
  return row('unknown', input.lifecycle === 'active' ? 'wait' : 'inspect', true);
}

/** Main closeout blockers are current running work and owed result decisions, never historical rejection prose. */
export function projectDelegationCloseout(inputs: readonly DelegationProjectionInput[]) {
  const rows = inputs.map(projectDelegationResult);
  return { rows, blockers: rows.filter(row => row.blocksComplete).sort((a, b) =>
    Number(b.state === 'running') - Number(a.state === 'running') || a.handle.localeCompare(b.handle)) };
}
