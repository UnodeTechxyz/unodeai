import { describe, expect, it } from 'vitest';
import type { ReviewSetV1, ReviewTargetEffectV1 } from '../../backend/ReviewFindings';
import { projectReviewLoop, type ReviewFindingView } from '../ReviewLoopProjection';
import type { RunRecord } from '../RunLedger';

/**
 * v0.9.106 R2 (design R0 §3.7, §7): each finding's state is derived from ledger facts only. A recheck closes a fix only
 * when it is a new admitted review of the same file that covers the fixed version and was made by someone other than
 * the fixer, with nothing changing the file under it. Otherwise the finding stays open, with the gap named.
 */

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const at = (minute: number) => `2026-11-17T10:${String(minute).padStart(2, '0')}:00.000Z`;

function set(id: string, handle: string, reviewer: string, options: { key?: string; digest?: string; dispatched?: number; closed?: number;
  recheckOf?: Array<{ reviewSetId: string; findingId: 'F1' | 'F2' }>; rechecks?: Array<{ findingId: 'F1' | 'F2'; of: string; status: 'resolved' | 'unresolved' }>;
  changed?: { changedByTeammate: boolean }; findings?: number } = {}): ReviewSetV1 {
  return {
    schemaVersion: 1, reviewSetId: id, text: 'retained',
    review: { attemptId: `attempt-${id}`, reviewerAgentId: reviewer, admission: { policyId: 'p', code: 'not-selected' },
      target: { inputId: 'target', lexicalPath: '/ws/a.ts', contentDigest: options.digest ?? A, capturedAt: at(options.dispatched ?? 0),
        key: options.key ?? '/ws/a.ts' },
      ...(options.changed ? { targetChangedAtSettlement: options.changed } : {}),
      dispatchedAt: at(options.dispatched ?? 0), closedAt: at(options.closed ?? (options.dispatched ?? 0) + 1),
      ...(options.recheckOf ? { recheckOf: options.recheckOf as never } : {}) },
    result: { handle, revision: 1, completionAttemptId: `attempt-${id}`, settledEventId: 's' },
    coverage: 'partial',
    findings: Array.from({ length: options.findings ?? 2 }, (_, index) => ({ findingId: `F${index + 1}` as const, classification: 'observed' as const,
      statement: `Finding ${index + 1}.`, citations: [] })),
    ...(options.rechecks ? { rechecks: options.rechecks.map((entry) => ({ of: { reviewSetId: entry.of, findingId: entry.findingId }, status: entry.status, citations: [] })) } : {}),
  };
}

function delegation(handle: string, agentId: string, extra: Record<string, unknown> = {}) {
  return { handle, agentId, requestedAgent: agentId, instruction: '', dispatchedAt: at(0), state: 'settled', dispositions: [], ...extra };
}

const decision = (handle: string, findings: Array<{ findingId: 'F1' | 'F2'; action: string; reason?: string }>, minute: number,
  extra: Record<string, unknown> = {}) => ({
  eventId: `disposition-${handle}-${minute}`, handle, agentId: 'x', disposition: 'accepted', recordedAt: at(minute), outcome: 'no-evidence',
  findings: { schemaVersion: 1, entries: findings.map((entry) => ({ ref: { reviewSetId: 'review-set-1', findingId: entry.findingId },
    action: entry.action, ...(entry.reason ? { reason: entry.reason } : {}) })) }, ...extra });

const run = (delegations: unknown[]): RunRecord[] => [{ id: 'run-1', coordinatorId: 'pm', delegations } as unknown as RunRecord];
const f1 = (view: ReturnType<typeof projectReviewLoop>): ReviewFindingView => view.findings.find((entry) => entry.findingId === 'F1')!;

/** The review of Dev's a.ts (by Writer), Dev's task, and decisions about the review's findings. */
function delegatedFix(options: { recheck?: Parameters<typeof set>[3]; reviewer2?: string; fixSettledAt?: number } = {}) {
  const review = delegation('review', 'writer', { reviewSets: [set('review-set-1', 'review', 'writer')],
    dispositions: [decision('review', [{ findingId: 'F2', action: 'not-adopted', reason: 'Domain term.' }], 2)] });
  const dev = delegation('dev', 'dev', {
    dispositions: [decision('dev', [{ findingId: 'F1', action: 'fix-requested' }], 3, { disposition: 'needs-rework', resultRevision: 1 })],
    resultHistory: [{ ref: { handle: 'dev', revision: 1 } }, { ref: { handle: 'dev', revision: 2 } }],
    resultSettledAt: { 1: at(1), 2: at(options.fixSettledAt ?? 5) },
  });
  const recheck = options.recheck ? [delegation('recheck', options.reviewer2 ?? 'writer', { reviewSets: [set('review-set-2', 'recheck', options.reviewer2 ?? 'writer', {
    dispatched: 6, recheckOf: [{ reviewSetId: 'review-set-1', findingId: 'F1' }],
    rechecks: [{ findingId: 'F1', of: 'review-set-1', status: 'resolved' }], ...options.recheck })] })] : [];
  return run([review, dev, ...recheck]);
}

describe('the review loop of a request, derived', () => {
  it('pending, not adopted with its reason, deferred as unresolved; nothing closes in bulk', () => {
    const review = delegation('review', 'writer', { reviewSets: [set('review-set-1', 'review', 'writer')],
      dispositions: [decision('review', [{ findingId: 'F2', action: 'deferred', reason: 'Next release.' }], 2)] });
    const view = projectReviewLoop(run([review]));
    expect(view.findings.map((entry) => [entry.findingId, entry.state])).toEqual([['F1', 'pending'], ['F2', 'unresolved']]);
    expect(view.findings[1].decision).toEqual({ action: 'deferred', reason: 'Next release.' });
  });

  it('a teammate\'s fix: requested, fixed, then closed by an independent recheck of the same file made after the fix', () => {
    const before = projectReviewLoop(delegatedFix());
    expect(f1(before).state).toBe('fixed-awaiting-recheck');
    expect(before.findings.find((entry) => entry.findingId === 'F2')).toMatchObject({ state: 'not-adopted', decision: { reason: 'Domain term.' } });
    expect(f1(projectReviewLoop(delegatedFix({ recheck: {} }))))
      .toMatchObject({ state: 'closed-by-recheck', recheck: { handle: 'recheck', reviewerAgentId: 'writer', status: 'resolved' } });
  });

  it('never closes it with a recheck of another file, one made before the fix settled, or one the fixer made', () => {
    expect(f1(projectReviewLoop(delegatedFix({ recheck: { key: '/ws/other.ts' } }))).state).toBe('fixed-awaiting-recheck');
    expect(f1(projectReviewLoop(delegatedFix({ recheck: { dispatched: 4 } }))).state).toBe('fixed-awaiting-recheck');
    expect(f1(projectReviewLoop(delegatedFix({ recheck: {}, reviewer2: 'dev' }))).state).toBe('self-checked');
  });

  it('a fix dispatched as a new task (contract.fixes): requested until it settles, then closed by an independent recheck', () => {
    const review = delegation('review', 'writer', { reviewSets: [set('review-set-1', 'review', 'writer')] });
    const fixRef = [{ reviewSetId: 'review-set-1', findingId: 'F1' }];
    const pending = delegation('fix', 'dev2', { state: 'active', dispatchedAt: at(3), fixesFindings: fixRef });
    expect(f1(projectReviewLoop(run([review, pending]))).state).toBe('fix-requested');
    const settled = delegation('fix', 'dev2', { dispatchedAt: at(3), fixesFindings: fixRef,
      resultHistory: [{ ref: { handle: 'fix', revision: 1 } }], resultSettledAt: { 1: at(5) } });
    expect(f1(projectReviewLoop(run([review, settled]))).state).toBe('fixed-awaiting-recheck');
    const recheck = delegation('recheck', 'writer', { reviewSets: [set('review-set-2', 'recheck', 'writer', { dispatched: 6,
      recheckOf: [{ reviewSetId: 'review-set-1', findingId: 'F1' }], rechecks: [{ findingId: 'F1', of: 'review-set-1', status: 'resolved' }] })] });
    expect(f1(projectReviewLoop(run([review, settled, recheck])))).toMatchObject({ state: 'closed-by-recheck' });
    // A5: the fixer rechecking its own fix is a self-check, never an independent closure.
    const selfCheck = delegation('recheck', 'dev2', { reviewSets: [set('review-set-2', 'recheck', 'dev2', { dispatched: 6,
      recheckOf: [{ reviewSetId: 'review-set-1', findingId: 'F1' }], rechecks: [{ findingId: 'F1', of: 'review-set-1', status: 'resolved' }] })] });
    expect(f1(projectReviewLoop(run([review, settled, selfCheck]))).state).toBe('self-checked');
  });

  it('a recheck under which someone else changed the file closes nothing; one the reviewer changed is a self-check', () => {
    expect(f1(projectReviewLoop(delegatedFix({ recheck: { changed: { changedByTeammate: false } } }))))
      .toMatchObject({ state: 'fixed-awaiting-recheck', gap: 'target-changed-during-recheck' });
    expect(f1(projectReviewLoop(delegatedFix({ recheck: { changed: { changedByTeammate: true } } }))).state).toBe('self-checked');
  });

  /** The PM's own fix: its writes to the reviewed file after it recorded fixing-myself, with their versions. */
  function ownFix(effects: Array<Partial<ReviewTargetEffectV1>>, recheck?: Parameters<typeof set>[3]) {
    const fixing = decision('review', [{ findingId: 'F1', action: 'fixing-myself' }], 2);
    const targetEffects = effects.map((effect, index) => ({ schemaVersion: 1, effectId: `target-effect-${index}`, seq: index + 1,
      reviewSetId: 'review-set-1', agentId: 'pm', byCoordinator: true, operation: 'write', grade: 'host-verified', at: at(3 + index),
      fixes: [fixing.eventId], ...effect }));
    const review = delegation('review', 'writer', { reviewSets: [set('review-set-1', 'review', 'writer')], dispositions: [fixing], targetEffects });
    const checks = recheck ? [delegation('recheck', 'writer', { reviewSets: [set('review-set-2', 'recheck', 'writer', {
      dispatched: 8, recheckOf: [{ reviewSetId: 'review-set-1', findingId: 'F1' }],
      rechecks: [{ findingId: 'F1', of: 'review-set-1', status: 'resolved' }], ...recheck })] })] : [];
    return f1(projectReviewLoop(run([review, ...checks])));
  }

  it('the PM\'s own fix closes only for the version the recheck was bound to; a stale recheck of the pre-fix file does not', () => {
    expect(ownFix([]).state).toBe('fix-requested');
    expect(ownFix([{ sha256: B }]).state).toBe('fixed-awaiting-recheck');
    // The recheck was bound to the bytes before the fix (A): not this fix.
    expect(ownFix([{ sha256: B }], { digest: A })).toMatchObject({ state: 'fixed-awaiting-recheck', gap: 'recheck-of-another-version' });
    expect(ownFix([{ sha256: B }], { digest: B })).toMatchObject({ state: 'closed-by-recheck' });
    // Two writes: a recheck of the first version is closed for it, and the later write is named.
    expect(ownFix([{ sha256: B }, { sha256: C }], { digest: B })).toMatchObject({ state: 'closed-by-recheck', changedLaterBy: 'pm' });
    expect(ownFix([{ sha256: B }, { sha256: C }], { digest: C }).changedLaterBy).toBeUndefined();
    // The latest write could not be confirmed: no version, no closure.
    expect(ownFix([{ sha256: B }, { grade: 'effect-uncertain' }], { digest: B })).toMatchObject({ state: 'fixed-awaiting-recheck', gap: 'fix-version-not-confirmed' });
  });

  it('a review with checked evidence but no linked findings, a conflict or a newer record is listed as not linked', () => {
    const view = projectReviewLoop(run([
      delegation('old', 'writer', { evidence: { reviewEvidence: { schemaVersion: 1, state: 'citations-checked' } } }),
      delegation('conflict', 'writer', { reviewSets: [{ ...set('review-set-9', 'conflict', 'writer'), conflict: true }] }),
      delegation('newer', 'writer', { reviewSets: [{ schemaVersion: 2, reviewSetId: 'review-set-8' }] }),
    ]));
    expect(view.findings).toEqual([]);
    expect(view.notLinked).toEqual([{ handle: 'old', reason: 'no-set' }, { handle: 'conflict', reason: 'conflict' },
      { handle: 'newer', reason: 'newer-format' }]);
  });
});

describe('the Review section of a result', () => {
  it('counts the states, lists each finding with its state and reason, and the files nobody reviewed', async () => {
    const { reviewLoopSection } = await import('../ReviewLoopProjection');
    const review = delegation('review', 'writer', { reviewSets: [set('review-set-1', 'review', 'writer')],
      dispositions: [decision('review', [{ findingId: 'F2', action: 'not-adopted', reason: 'Domain term.' }], 2)] });
    const section = reviewLoopSection(projectReviewLoop(run([review])), { agentName: (id) => (id === 'writer' ? 'Writer' : undefined),
      reviewerOf: () => 'writer', unreviewedOwnFiles: ['other.md'] })!;
    expect(section.title).toBe('Review');
    expect(section.rows).toEqual([
      { label: 'Findings', value: '2: 1 not decided yet, 1 not adopted', tone: 'caution' },
      { label: 'Not independently reviewed', value: '1 file changed in this chat', tone: 'caution' },
    ]);
    expect(section.items).toEqual([
      "Writer's review F1 [observed] Finding 1. · not decided yet",
      "Writer's review F2 [observed] Finding 2. · not adopted · reason: Domain term.",
      'other.md · not independently reviewed',
    ]);
    expect(reviewLoopSection(projectReviewLoop(run([])))).toBeUndefined();
  });
});
