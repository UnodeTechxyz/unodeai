/*---------------------------------------------------------------------------------------------
 *  UnodeAi - The review loop of one request, derived (v0.9.106)
 *
 *  For each finding a review of the request numbered: pending, sent for a fix, fixed and awaiting a
 *  recheck, closed by an independent recheck (for the version it covered), self-checked, not adopted
 *  with a reason, or still unresolved. Everything is derived from what the run ledger holds: the review
 *  sets, the finding decisions, the fix dispatches, the result revisions and the target effects. There
 *  is no state of its own, and reading it starts nothing. A fact that is missing gives a gap, never a
 *  guess from a path, a name or prose.
 *--------------------------------------------------------------------------------------------*/

import { isReviewSetV1, reviewCitationLabels, type FindingAction, type FindingId, type ReviewCitationV1, type ReviewSetV1,
  type ReviewTargetEffectV1 } from '../backend/ReviewFindings';
import type { RunDelegation, RunRecord } from './RunLedger';
import type { OfficeReviewCitation } from '../backend/OfficeReviewCitations';

export type ReviewFindingState =
  | 'pending' | 'fix-requested' | 'fixed-awaiting-recheck' | 'closed-by-recheck' | 'self-checked'
  | 'not-adopted' | 'unresolved';

export interface ReviewFindingView {
  reviewHandle: string;
  reviewSetId: string;
  findingId: FindingId;
  classification: string;
  statement?: string;
  citations: ReviewCitationV1[];
  officeCitations?: OfficeReviewCitation[];
  state: ReviewFindingState;
  /** The latest decision on it, when it is not a fix: its action and the coordinator's reason. */
  decision?: { action: FindingAction; reason?: string };
  /** The recheck that closed it, or the self-check: its handle and the version it covered. */
  recheck?: { handle: string; reviewerAgentId: string; versionAt?: string; status: 'resolved' | 'unresolved' };
  /** A later change to the reviewed file after the version the closing recheck covered. */
  changedLaterBy?: string;
  /** Why a stronger state could not be established. */
  gap?: 'fix-version-not-confirmed' | 'recheck-of-another-version' | 'fix-time-not-recorded' | 'fix-not-linked'
    | 'target-effects-incomplete' | 'target-changed-during-recheck';
}

export interface ReviewLoopView {
  findings: ReviewFindingView[];
  /** Reviews whose findings could not be linked one by one: checked evidence with no set, a conflict, a newer format. */
  notLinked: Array<{ handle: string; reason: 'no-set' | 'conflict' | 'newer-format' | 'dropped' }>;
  unverifiedIndependence?: string[];
}

interface Decision {
  eventId?: string;
  action: FindingAction;
  reason?: string;
  /** The task the decision was recorded on, and its teammate. */
  handle: string;
  agentId: string;
  /** The standing revision that decision was about. */
  resultRevision?: number;
  at: string;
  /** A dispatch made to fix it (contract.fixes): the fix is that task's first revision. */
  dispatch?: true;
}

const FIX_ACTIONS: ReadonlySet<FindingAction> = new Set(['fix-requested', 'fixing-myself']);

/** The review loop of the runs of one request. Pure. */
export function projectReviewLoop(chain: readonly RunRecord[]): ReviewLoopView {
  const delegations = chain.flatMap((run) => run.delegations);
  const coordinatorId = chain[0]?.coordinatorId;
  const byHandle = new Map(delegations.map((delegation) => [delegation.handle, delegation]));
  const notLinked: ReviewLoopView['notLinked'] = [];
  const sets: Array<{ delegation: RunDelegation; set: ReviewSetV1 }> = [];
  for (const delegation of delegations) {
    const stored = delegation.reviewSets ?? [];
    for (const entry of stored) {
      if (!isReviewSetV1(entry)) notLinked.push({ handle: delegation.handle, reason: 'newer-format' });
      else if (entry.conflict) notLinked.push({ handle: delegation.handle, reason: 'conflict' });
      else sets.push({ delegation, set: entry });
    }
    if (delegation.reviewSetsRecovery === 'partial') notLinked.push({ handle: delegation.handle, reason: 'dropped' });
    if (!stored.length && delegation.evidence?.reviewEvidence?.state === 'citations-checked') {
      notLinked.push({ handle: delegation.handle, reason: 'no-set' });
    }
  }
  const decisions = new Map<string, Decision[]>();
  const add = (key: string, decision: Decision) => decisions.set(key, [...(decisions.get(key) ?? []), decision]);
  for (const delegation of delegations) {
    for (const event of delegation.dispositions) {
      for (const entry of event.findings?.entries ?? []) {
        add(`${entry.ref.reviewSetId}#${entry.ref.findingId}`, { eventId: event.eventId, action: entry.action, reason: entry.reason,
          handle: event.handle, agentId: delegation.agentId, resultRevision: event.resultRevision, at: event.recordedAt });
      }
    }
    for (const ref of delegation.fixesFindings ?? []) {
      add(`${ref.reviewSetId}#${ref.findingId}`, { eventId: `dispatch:${delegation.handle}`, action: 'fix-requested',
        handle: delegation.handle, agentId: delegation.agentId, at: delegation.dispatchedAt, dispatch: true });
    }
  }

  const findings: ReviewFindingView[] = [];
  for (const { delegation, set } of sets) {
    for (const finding of set.findings) {
      const key = `${set.reviewSetId}#${finding.findingId}`;
      const base = { reviewHandle: delegation.handle, reviewSetId: set.reviewSetId, findingId: finding.findingId,
        classification: finding.classification, ...(finding.statement ? { statement: finding.statement } : {}), citations: finding.citations,
        ...(finding.officeCitations?.length ? { officeCitations: finding.officeCitations } : {}) };
      const latest = (decisions.get(key) ?? []).sort((left, right) => left.at.localeCompare(right.at)).at(-1);
      if (!latest) { findings.push({ ...base, state: 'pending' }); continue; }
      if (!FIX_ACTIONS.has(latest.action)) {
        findings.push({ ...base, state: latest.action === 'not-adopted' ? 'not-adopted' : 'unresolved',
          decision: { action: latest.action, ...(latest.reason ? { reason: latest.reason } : {}) } });
        continue;
      }
      findings.push({ ...base, ...fixState(set, delegation, latest, sets, byHandle, coordinatorId, finding.findingId) });
    }
  }
  const unverifiedIndependence = [...new Set(sets.filter(entry => entry.set.review.admission.code === 'allowed-author-unknown').map(entry => entry.delegation.handle))];
  return { findings, notLinked, ...(unverifiedIndependence.length ? { unverifiedIndependence } : {}) };
}

/** The state of a finding whose latest decision is a fix: the fix, then the recheck that covers it. */
function fixState(origin: ReviewSetV1, originDelegation: RunDelegation, decision: Decision,
  sets: ReadonlyArray<{ delegation: RunDelegation; set: ReviewSetV1 }>, byHandle: ReadonlyMap<string, RunDelegation>,
  coordinatorId: string | undefined, findingId: FindingId): Omit<ReviewFindingView, 'reviewHandle' | 'reviewSetId' | 'findingId' | 'classification' | 'statement' | 'citations'> {
  const effects = (originDelegation.targetEffects ?? []).filter((effect) => effect.reviewSetId === origin.reviewSetId)
    .sort((left, right) => left.seq - right.seq);
  const linked = decision.eventId ? effects.filter((effect) => effect.fixes.includes(decision.eventId!)) : [];
  const ownFix = decision.action === 'fixing-myself';
  const author = ownFix ? coordinatorId : decision.agentId;
  // The recheck sets of this finding, latest first.
  const rechecks = sets.filter(({ set }) => set.review.recheckOf?.some((ref) => ref.reviewSetId === origin.reviewSetId && ref.findingId === findingId))
    .map(({ delegation, set }) => ({ delegation, set, entry: set.rechecks?.find((entry) => entry.of.reviewSetId === origin.reviewSetId
      && entry.of.findingId === findingId) }))
    .filter((candidate) => !!candidate.entry)
    .sort((left, right) => right.set.review.closedAt.localeCompare(left.set.review.closedAt));

  // When the fix was made: by its confirmed versions (target effects), or, for a teammate's fix with none, by when
  // its result revision settled.
  const confirmed = linked.filter((effect) => effect.sha256);
  const latestLinked = linked.at(-1);
  let fixed: { versions?: ReviewTargetEffectV1[]; settledAt?: string } | undefined;
  let gap: ReviewFindingView['gap'];
  if (latestLinked && !latestLinked.sha256) gap = 'fix-version-not-confirmed';
  if (confirmed.length && latestLinked?.sha256) fixed = { versions: confirmed };
  else if (!ownFix && !linked.length) {
    const fixTask = byHandle.get(decision.handle);
    const revision = decision.dispatch ? 1 : (decision.resultRevision ?? 0) + 1;
    const settled = fixTask?.resultHistory?.some((row) => row.ref.revision >= revision);
    if (settled) {
      const settledAt = fixTask?.resultSettledAt?.[String(Math.max(...fixTask.resultHistory!.map((row) => row.ref.revision)))];
      if (settledAt) fixed = { settledAt }; else gap = 'fix-time-not-recorded';
    }
  } else if (ownFix && !linked.length && !decision.eventId) gap = 'fix-not-linked';
  if (!fixed) {
    return { state: latestLinked || gap === 'fix-time-not-recorded' ? 'fixed-awaiting-recheck' : 'fix-requested', ...(gap ? { gap } : {}) };
  }
  if (originDelegation.targetEffectsTruncated || originDelegation.targetEffectsRecovery === 'partial') gap = 'target-effects-incomplete';

  for (const { delegation, set, entry } of rechecks) {
    // The recheck must be bound to the same file as the review it rechecks, whichever way the fix's version is known.
    const sameFile = !!set.review.target?.key && set.review.target.key === origin.review.target?.key;
    const covers = !sameFile ? undefined : fixed.versions
      ? fixed.versions.find((effect) => effect.sha256 === set.review.target?.contentDigest)
      : set.review.dispatchedAt >= fixed.settledAt! ? { seq: Number.MAX_SAFE_INTEGER, at: set.review.dispatchedAt } as ReviewTargetEffectV1 : undefined;
    if (!covers) continue;
    // The file changed while the recheck was settling: by the reviewer it is a self-check; by anyone else, the version
    // it covered is not known, and nothing is closed.
    const changedDuring = set.review.targetChangedAtSettlement;
    if (changedDuring && !changedDuring.changedByTeammate) {
      return { state: 'fixed-awaiting-recheck', gap: 'target-changed-during-recheck' };
    }
    const independent = set.review.reviewerAgentId !== author && !changedDuring
      && (!ownFix || set.review.reviewerAgentId !== coordinatorId);
    const later = fixed.versions && covers.seq !== Number.MAX_SAFE_INTEGER
      ? effects.filter((effect) => effect.seq > covers.seq).at(-1)
      : effects.filter((effect) => effect.at > set.review.dispatchedAt).at(-1);
    const recheck = { handle: delegation.handle, reviewerAgentId: set.review.reviewerAgentId,
      versionAt: set.review.target?.capturedAt, status: entry!.status };
    const state: ReviewFindingState = entry!.status === 'unresolved' ? 'unresolved' : independent ? 'closed-by-recheck' : 'self-checked';
    return { state, recheck, ...(later ? { changedLaterBy: later.agentId } : {}), ...(gap ? { gap } : {}) };
  }
  return { state: 'fixed-awaiting-recheck', ...(rechecks.length ? { gap: 'recheck-of-another-version' as const } : gap ? { gap } : {}) };
}

// ─── The Review section of a Job outcome card (v0.9.106 R3) ─────────────────

const STATE_WORD: Record<ReviewFindingState, string> = {
  'pending': 'not decided yet',
  'fix-requested': 'fix requested',
  'fixed-awaiting-recheck': 'fixed, awaiting a recheck',
  'closed-by-recheck': 'closed by an independent recheck',
  'self-checked': 'fixed, not independently rechecked',
  'not-adopted': 'not adopted',
  'unresolved': 'still unresolved',
};

const GAP_WORD: Record<NonNullable<ReviewFindingView['gap']>, string> = {
  'fix-version-not-confirmed': 'the fixed version could not be confirmed',
  'recheck-of-another-version': 'a recheck reviewed another version',
  'fix-time-not-recorded': 'when the fix settled was not recorded',
  'fix-not-linked': 'the fix is not linked to this finding',
  'target-effects-incomplete': 'some changes to the file were not kept',
  'target-changed-during-recheck': 'the file changed while it was rechecked',
};

const NOT_LINKED_WORD: Record<ReviewLoopView['notLinked'][number]['reason'], string> = {
  'no-set': 'its findings were not linked one by one',
  'conflict': 'its stored findings conflict',
  'newer-format': 'its findings were recorded by a newer UnodeAi',
  'dropped': 'some of its stored findings could not be read',
};

/**
 * The section, or nothing when the request had no review and no file of its own agent's. Every line is derived from
 * the view; the statements are the reviewer's words, shown as text and never as an action.
 */
export function reviewLoopSection(view: ReviewLoopView, options: {
  agentName?: (agentId: string) => string | undefined;
  /** The request's own agent's changed files that no review of the request was bound to. */
  unreviewedOwnFiles?: readonly string[];
  /** The reviewer of each review handle, for naming. */
  reviewerOf?: (handle: string) => string | undefined;
} = {}): { title: 'Review'; rows: Array<{ label: string; value: string; tone?: 'neutral' | 'caution' }>; items?: string[]; note: string } | undefined {
  const own = options.unreviewedOwnFiles ?? [];
  if (!view.findings.length && !view.notLinked.length && !own.length && !view.unverifiedIndependence?.length) return undefined;
  const name = (agentId: string | undefined) => (agentId && options.agentName?.(agentId)) || agentId || 'a reviewer';
  const counts = new Map<ReviewFindingState, number>();
  for (const finding of view.findings) counts.set(finding.state, (counts.get(finding.state) ?? 0) + 1);
  const open = view.findings.filter((finding) => finding.state !== 'closed-by-recheck' && finding.state !== 'not-adopted').length;
  const rows: Array<{ label: string; value: string; tone?: 'neutral' | 'caution' }> = [];
  if (view.unverifiedIndependence?.length) rows.push({ label: 'Reported-model independence', value: 'Author unknown — independence not established', tone: 'caution' });
  if (view.findings.length) {
    rows.push({ label: 'Findings', value: `${view.findings.length}: ${[...counts].map(([state, count]) => `${count} ${STATE_WORD[state]}`).join(', ')}`,
      ...(open > 0 ? { tone: 'caution' as const } : {}) });
  }
  for (const entry of view.notLinked) rows.push({ label: 'Review not linked', value: `${name(options.reviewerOf?.(entry.handle))}'s review: ${NOT_LINKED_WORD[entry.reason]}`, tone: 'caution' });
  if (own.length) rows.push({ label: 'Not independently reviewed', value: `${own.length} file${own.length === 1 ? '' : 's'} changed in this chat`, tone: 'caution' });
  const items = view.findings.map((finding) => {
    const cited = reviewCitationLabels(finding).join(', ');
    const parts = [`${name(options.reviewerOf?.(finding.reviewHandle))}'s review ${finding.findingId} [${finding.classification}] ${finding.statement ?? '(text no longer kept)'}${cited ? ` — ${cited}` : ''}`,
      STATE_WORD[finding.state]];
    if (finding.decision?.reason) parts.push(`reason: ${finding.decision.reason}`);
    if (finding.recheck) parts.push(`recheck by ${name(finding.recheck.reviewerAgentId)}${finding.recheck.versionAt ? ` of the version at ${finding.recheck.versionAt}` : ''}`);
    if (finding.changedLaterBy) parts.push(`changed later by ${name(finding.changedLaterBy)}`);
    if (finding.gap) parts.push(GAP_WORD[finding.gap]);
    return parts.join(' · ');
  });
  for (const file of own) items.push(`${file} · not independently reviewed`);
  return {
    title: 'Review',
    rows,
    ...(items.length ? { items } : {}),
    note: 'Statements are the reviewer\'s words, not UnodeAi\'s. A finding is closed only by a new review of the fixed version '
      + 'by someone other than whoever fixed it; UnodeAi checks that relation, not whether the finding is right.',
  };
}
