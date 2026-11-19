import { describe, expect, it } from 'vitest';
import { RunLedger } from '../../observability/RunLedger';
import {
  boundSet, parseFindingDispositions, parseFindingRefText, parseStoredReviewSet, renderReviewFindingsBlock,
  REVIEW_SET_MAX_BYTES, REVIEW_SET_TEXT_RETAINED_PER_RUN, type ReviewReportCapture, type ReviewSetV1,
} from '../ReviewFindings';

/**
 * v0.9.106 R1: a review's numbered findings. The ledger records them for the standing result they belong to only when
 * the host identities join (the TaskContract attempt that closed the review is the attempt that revision settled),
 * keeps them through store, reload and merge, bounds their text, and reads each stored set on its own.
 */

const ATTEMPT = 'attempt-0a1b2c3d-review';
const DIGEST = 'a'.repeat(64);

function capture(overrides: Partial<ReviewReportCapture> = {}, statement = 'total() ignores its second argument.'): ReviewReportCapture {
  return {
    reviewSetId: 'review-set-11111111-aaaa',
    review: {
      attemptId: ATTEMPT, reviewerAgentId: 'reviewer', admission: { policyId: 'artifact-review', code: 'not-selected' },
      target: { inputId: 'target', lexicalPath: '/ws/a.ts', contentDigest: DIGEST, capturedAt: '2026-11-17T10:00:00.000Z', key: '/ws/a.ts' },
      dispatchedAt: '2026-11-17T10:00:00.000Z', closedAt: '2026-11-17T10:01:00.000Z',
    },
    coverage: 'partial',
    findings: [
      { findingId: 'F1', classification: 'observed', statement, citations: [{ path: 'a.ts', startLine: 1, endLine: 1 }] },
      { findingId: 'F2', classification: 'inferred', statement: 'The name is unclear.', citations: [] },
    ],
    ...overrides,
  };
}

/** A ledger with one settled review delegation of revision 1, its completion identity the review's attempt. */
function settledReview(handle = 'review-1', attemptId = ATTEMPT) {
  const ledger = new RunLedger();
  ledger.recordDelegationDispatched({
    coordinatorId: 'pm', handle, requestedAgent: 'reviewer', agentId: 'reviewer', instruction: 'Review a.ts.',
    originCorrelationId: 'root', resultCompletion: { attemptId, settledEventId: `settled-${handle}` },
  } as never);
  const identity = ledger.resultIdentity('pm', handle)!;
  ledger.recordResultSettlement(identity, 'ready');
  return { ledger, identity };
}

const stored = (ledger: RunLedger) => JSON.parse(JSON.stringify(ledger.snapshot())) as Array<{ delegations: Array<Record<string, any>> }>;
const setsOf = (ledger: RunLedger, index = 0) => ledger.snapshot()[0].delegations[index].reviewSets ?? [];

describe('review findings: references, records and the coordinator text', () => {
  it('reads a reference only in the form "<handle>#F<n>"', () => {
    expect(parseFindingRefText('task-3#F2')).toEqual({ handle: 'task-3', findingId: 'F2' });
    expect(parseFindingRefText('a#b#F50')).toEqual({ handle: 'a#b', findingId: 'F50' });
    for (const bad of ['task-3#F0', 'task-3#F51', 'task-3#f2', '#F1', 'task-3', 'F2', 3]) expect(parseFindingRefText(bad)).toBeUndefined();
  });

  it('numbers the findings for the coordinator and says the statements are the reviewer\'s', () => {
    const block = renderReviewFindingsBlock('review-1', capture());
    expect(block).toContain("the statements are the reviewer's, not host facts");
    expect(block).toContain('review-1#F1 [observed] total() ignores its second argument. — a.ts:1-1');
    expect(block).toContain('review-1#F2 [inferred] The name is unclear.');
    expect(renderReviewFindingsBlock('review-1', capture({ findings: [] }))).toBe('');
  });

  it('a stored v1 set is read strictly; a newer one is kept unread; a broken one is invalid', () => {
    const set: ReviewSetV1 = { schemaVersion: 1, ...capture(), result: { handle: 'review-1', revision: 1, completionAttemptId: ATTEMPT, settledEventId: 's' }, text: 'retained' };
    expect(parseStoredReviewSet(JSON.parse(JSON.stringify(set)), 'review-1')).toEqual({ kind: 'set', set });
    expect(parseStoredReviewSet(set, 'another-handle').kind).toBe('invalid');
    expect(parseStoredReviewSet({ ...set, findings: [{ ...set.findings[1], findingId: 'F2' }] }, 'review-1').kind).toBe('invalid');
    expect(parseStoredReviewSet({ ...set, schemaVersion: 2, novel: true }, 'review-1').kind).toBe('newer');
    expect(parseStoredReviewSet({ ...set, schemaVersion: 2, novel: 'x'.repeat(REVIEW_SET_MAX_BYTES) }, 'review-1').kind).toBe('invalid');
    expect(parseStoredReviewSet({ ...set, text: 'complete' }, 'review-1').kind).toBe('invalid');
  });

  it('bounds a set to its stored size by dropping statements from the last finding back, and says so', () => {
    const findings = Array.from({ length: 50 }, (_, index) => ({ findingId: `F${index + 1}` as const, classification: 'inferred' as const,
      statement: 'x'.repeat(240), citations: [{ path: 'p'.repeat(60), startLine: 1, endLine: 2 }] }));
    const bounded = boundSet({ schemaVersion: 1, ...capture({ findings: findings as never }),
      result: { handle: 'h', revision: 1, completionAttemptId: ATTEMPT, settledEventId: 's' }, text: 'retained' });
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(REVIEW_SET_MAX_BYTES);
    expect(bounded.text).toBe('truncated');
    expect(bounded.findings[0].statement).toBe('x'.repeat(240));
    expect(bounded.findings[49].statement).toBeUndefined();
    expect(bounded.findings.map((finding) => finding.findingId)).toEqual(findings.map((finding) => finding.findingId));
    // At the bound with no statement left, the cited lines go too; numbers and classes stay.
    const paths = Array.from({ length: 50 }, (_, index) => ({ findingId: `F${index + 1}` as const, classification: 'inferred' as const,
      statement: 'x', citations: Array.from({ length: 8 }, () => ({ path: 'p'.repeat(240), startLine: 1, endLine: 2 })) }));
    const smallest = boundSet({ schemaVersion: 1, ...capture({ findings: paths as never }),
      result: { handle: 'h', revision: 1, completionAttemptId: ATTEMPT, settledEventId: 's' }, text: 'retained' });
    expect(Buffer.byteLength(JSON.stringify(smallest))).toBeLessThanOrEqual(REVIEW_SET_MAX_BYTES);
    expect(smallest.text).toBe('not-retained');
    expect(smallest.findings).toHaveLength(50);
  });

  it('a finding decision needs a reason when it is not a fix, and an invalid one is not read', () => {
    const ref = { reviewSetId: 'review-set-11111111-aaaa', findingId: 'F1' };
    expect(parseFindingDispositions({ schemaVersion: 1, entries: [{ ref, action: 'fix-requested' }] })?.entries).toHaveLength(1);
    expect(parseFindingDispositions({ schemaVersion: 1, entries: [{ ref, action: 'not-adopted' }] })).toBeUndefined();
    expect(parseFindingDispositions({ schemaVersion: 1, entries: [{ ref, action: 'accepted' }] })).toBeUndefined();
    expect(parseFindingDispositions({ schemaVersion: 1, entries: [{ ref, action: 'not-adopted', reason: 'token=abc123 is fine' }] })!.entries[0].reason)
      .toBe('token=[redacted] is fine');
  });
});

describe('review sets in the run ledger', () => {
  it('records a set when the review attempt is the attempt this revision settled, once, and keeps it through store, reload and merge', () => {
    const { ledger, identity } = settledReview();
    expect(ledger.recordReviewSet(identity, capture())).toBe(true);
    // A duplicate retain records nothing.
    expect(ledger.recordReviewSet(identity, capture())).toBe(false);
    const sets = setsOf(ledger);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ reviewSetId: 'review-set-11111111-aaaa', text: 'retained',
      result: { handle: 'review-1', revision: 1, completionAttemptId: ATTEMPT, settledEventId: 'settled-review-1' } });
    const reloaded = new RunLedger(stored(ledger));
    expect(setsOf(reloaded)).toEqual(sets);
    expect(new RunLedger().snapshotForPersistence(stored(ledger))[0].delegations[0].reviewSets).toEqual(sets);
    expect(reloaded.snapshotForPersistence(stored(ledger))[0].delegations[0].reviewSets).toEqual(sets);
  });

  it('never joins by name or timing: another attempt, a rework revision or an unsettled result records nothing', () => {
    const { ledger, identity } = settledReview();
    expect(ledger.recordReviewSet(identity, capture({ review: { ...capture().review, attemptId: 'attempt-someone-else' } }))).toBe(false);
    expect(ledger.recordReviewSet({ ...identity, settledEventId: 'another-settlement' }, capture())).toBe(false);
    // A rework revision has a fresh completion id, never the review attempt's.
    ledger.beginResultRework('pm', 'review-1');
    const rework = ledger.resultIdentity('pm', 'review-1')!;
    ledger.recordResultSettlement(rework, 'ready');
    expect(rework.ref.revision).toBe(2);
    expect(ledger.recordReviewSet(rework, capture())).toBe(false);
    expect(setsOf(ledger)).toEqual([]);
  });

  it('a stored set that does not hold is dropped alone and marked; a newer one is kept unread; the result is untouched', () => {
    const { ledger, identity } = settledReview();
    ledger.recordReviewSet(identity, capture());
    const records = stored(ledger);
    const delegation = records[0].delegations[0];
    delegation.reviewSets = [{ ...delegation.reviewSets[0], coverage: 'everything' },
      { ...delegation.reviewSets[0], reviewSetId: 'review-set-newer', schemaVersion: 2 }];
    const reloaded = new RunLedger(records).snapshot()[0].delegations[0];
    expect(reloaded.reviewSetsRecovery).toBe('partial');
    expect(reloaded.reviewSets).toEqual([expect.objectContaining({ reviewSetId: 'review-set-newer', schemaVersion: 2 })]);
    expect(reloaded.resultHistory).toEqual(ledger.snapshot()[0].delegations[0].resultHistory);
  });

  it('two copies of one set with different content are a conflict, not a choice', () => {
    const { ledger, identity } = settledReview();
    ledger.recordReviewSet(identity, capture());
    const other = stored(ledger);
    other[0].delegations[0].reviewSets[0].findings[0].citations[0].endLine = 9;
    const merged = ledger.snapshotForPersistence(other)[0].delegations[0].reviewSets!;
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ conflict: true });
  });

  it('keeps statements for the latest few sets of a run only', () => {
    const ledger = new RunLedger();
    const count = REVIEW_SET_TEXT_RETAINED_PER_RUN + 2;
    for (let index = 0; index < count; index++) {
      const handle = `review-${index}`;
      const attemptId = `attempt-review-${index}`;
      ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle, requestedAgent: 'reviewer', agentId: 'reviewer',
        instruction: 'Review.', originCorrelationId: 'root', resultCompletion: { attemptId, settledEventId: `s-${index}` } } as never);
      const identity = ledger.resultIdentity('pm', handle)!;
      ledger.recordResultSettlement(identity, 'ready');
      const base = capture();
      ledger.recordReviewSet(identity, { ...base, reviewSetId: `review-set-${index}`,
        review: { ...base.review, attemptId, closedAt: `2026-11-17T10:${String(10 + index).padStart(2, '0')}:00.000Z` } });
    }
    const texts = ledger.snapshot()[0].delegations.map((delegation) => (delegation.reviewSets![0] as ReviewSetV1).text);
    expect(texts.slice(0, 2)).toEqual(['not-retained', 'not-retained']);
    expect(texts.slice(2).every((text) => text === 'retained')).toBe(true);
    expect((ledger.snapshot()[0].delegations[0].reviewSets![0] as ReviewSetV1).findings[0].statement).toBeUndefined();
  });

  it('resolves a finding reference within the request only, to its latest set, and says what exists otherwise', () => {
    const { ledger, identity } = settledReview();
    ledger.recordReviewSet(identity, capture());
    expect(ledger.resolveFindingRefs('review-1', ['review-1#F2'])).toEqual({ ok: true, refs: [
      { ref: { reviewSetId: 'review-set-11111111-aaaa', findingId: 'F2' }, reviewHandle: 'review-1', hasTarget: true }] });
    expect(ledger.resolveFindingRefs('review-1', ['review-1#F3'])).toEqual({ ok: false, reason: 'review-1 has no F3; its findings are F1, F2.' });
    expect(ledger.resolveFindingRefs('review-1', ['task-elsewhere#F1'])).toMatchObject({ ok: false });
    expect(ledger.resolveFindingRefs('review-1', ['review-1 F1'])).toMatchObject({ ok: false });
  });

  it('names a review closed without evidence and says how to get its findings tracked (field smoke of a86b8516)', () => {
    const { ledger } = settledReview();
    const refused = ledger.resolveFindingRefs('review-1', ['review-1#F1']);
    expect(refused).toMatchObject({ ok: false });
    const reason = (refused as { reason: string }).reason;
    expect(reason).toContain('review-1 has no recorded review findings');
    expect(reason).toContain('dispatch a new review of the same input');
    expect(reason).toContain('close_assignment and review_evidence');
  });

  it('names the findings of a review\'s latest set that no decision names, as its Review section shows them (field retest, 2026-11-18)', () => {
    const { ledger, identity } = settledReview();
    expect(ledger.undecidedReviewFindings('review-1', 'pm')).toEqual([]);
    ledger.recordReviewSet(identity, capture());
    const ref = (findingId: 'F1' | 'F2') => ({ reviewSetId: 'review-set-11111111-aaaa', findingId });
    expect(ledger.undecidedReviewFindings('review-1', 'pm')).toEqual([
      { ref: ref('F1'), reviewHandle: 'review-1', statement: 'total() ignores its second argument.' },
      { ref: ref('F2'), reviewHandle: 'review-1', statement: 'The name is unclear.' },
    ]);
    // Another coordinator's question names nothing.
    expect(ledger.undecidedReviewFindings('review-1', 'another-pm')).toEqual([]);
    ledger.recordDisposition({ eventId: 'disposition-1', handle: 'review-1', agentId: 'reviewer', disposition: 'deferred', reason: 'Later.',
      recordedAt: '2026-11-17T10:02:00.000Z', outcome: 'replied-not-verified',
      findings: { schemaVersion: 1, entries: [{ ref: ref('F2'), action: 'not-adopted', reason: 'The name is the domain term.' }] } });
    expect(ledger.undecidedReviewFindings('review-1', 'pm').map((entry) => entry.ref.findingId)).toEqual(['F1']);
    // A set whose stored copies conflict cannot be named, so nothing is asked of it.
    const other = stored(ledger);
    other[0].delegations[0].reviewSets[0].findings[0].citations[0].endLine = 9;
    const merged = new RunLedger(ledger.snapshotForPersistence(other));
    expect(merged.snapshot()[0].delegations[0].reviewSets![0]).toMatchObject({ conflict: true });
    expect(merged.undecidedReviewFindings('review-1', 'pm')).toEqual([]);
  });

  it('a decision keeps the revision it was about and its checked finding decisions; a broken one loses only them', () => {
    const { ledger, identity } = settledReview();
    ledger.recordReviewSet(identity, capture());
    const ref = { reviewSetId: 'review-set-11111111-aaaa', findingId: 'F2' as const };
    ledger.recordDisposition({ eventId: 'disposition-1', handle: 'review-1', agentId: 'reviewer', disposition: 'accepted',
      recordedAt: '2026-11-17T10:02:00.000Z', outcome: 'replied-not-verified',
      findings: { schemaVersion: 1, entries: [{ ref, action: 'not-adopted', reason: 'The name is the domain term.' }] } });
    const event = ledger.snapshot()[0].delegations[0].dispositions[0];
    expect(event).toMatchObject({ eventId: 'disposition-1', resultRevision: 1,
      findings: { schemaVersion: 1, entries: [{ ref, action: 'not-adopted', reason: 'The name is the domain term.' }] } });
    const records = stored(ledger);
    records[0].delegations[0].dispositions[0].findings.entries[0].action = 'ignored';
    const restored = new RunLedger(records).snapshot()[0].delegations[0].dispositions[0];
    expect(restored.findings).toBeUndefined();
    expect(restored).toMatchObject({ eventId: 'disposition-1', disposition: 'accepted' });
  });
});

describe('v0.9.106 R2: target effects, the order and version facts of a reviewed file', () => {
  const KEY = '/ws/a.ts';
  const B = 'b'.repeat(64);

  function fixingMyself() {
    const { ledger, identity } = settledReview();
    ledger.recordReviewSet(identity, capture());
    ledger.recordDisposition({ eventId: 'disposition-fix', handle: 'review-1', agentId: 'reviewer', disposition: 'accepted',
      recordedAt: '2026-11-17T10:02:00.000Z', outcome: 'replied-not-verified',
      findings: { schemaVersion: 1, entries: [{ ref: { reviewSetId: 'review-set-11111111-aaaa', findingId: 'F1' }, action: 'fixing-myself' }] } });
    return ledger;
  }
  const effectsOf = (ledger: RunLedger) => ledger.snapshot()[0].delegations[0].targetEffects ?? [];

  it('records each change by the coordinator to the reviewed file, in order, with its version and the fix it serves', () => {
    const ledger = fixingMyself();
    ledger.noteReviewTargetEffect({ agentId: 'pm', key: KEY, operation: 'write', grade: 'host-verified', sha256: B, at: '2026-11-17T10:03:00.000Z' });
    ledger.noteReviewTargetEffect({ agentId: 'pm', key: KEY, operation: 'write', grade: 'host-verified', sha256: B, at: '2026-11-17T10:04:00.000Z' });
    ledger.noteReviewTargetEffect({ agentId: 'pm', key: KEY, operation: 'write', grade: 'effect-uncertain', sha256: B, at: '2026-11-17T10:05:00.000Z' });
    // Another file, or someone with no task of the request, records nothing.
    ledger.noteReviewTargetEffect({ agentId: 'pm', key: '/ws/other.ts', operation: 'write', grade: 'host-verified', sha256: B });
    ledger.noteReviewTargetEffect({ agentId: 'stranger', key: KEY, operation: 'write', grade: 'host-verified', sha256: B });
    const effects = effectsOf(ledger);
    expect(effects.map((effect) => [effect.seq, effect.sha256, effect.byCoordinator, effect.fixes])).toEqual([
      [1, B, true, ['disposition-fix']], [2, B, true, ['disposition-fix']], [3, undefined, true, ['disposition-fix']]]);
    // Kept through store and reload, and through the merge of two copies.
    expect(effectsOf(new RunLedger(stored(ledger)))).toEqual(effects);
    expect(ledger.snapshotForPersistence(stored(ledger))[0].delegations[0].targetEffects).toEqual(effects);
  });

  it('a stored effect that does not hold is dropped alone and marked; the rest and the result stay', () => {
    const ledger = fixingMyself();
    ledger.noteReviewTargetEffect({ agentId: 'pm', key: KEY, operation: 'write', grade: 'host-verified', sha256: B });
    ledger.noteReviewTargetEffect({ agentId: 'pm', key: KEY, operation: 'write', grade: 'host-verified', sha256: B });
    const records = stored(ledger);
    records[0].delegations[0].targetEffects[0].sha256 = 'not-a-digest';
    const reloaded = new RunLedger(records).snapshot()[0].delegations[0];
    expect(reloaded.targetEffects?.map((effect) => effect.seq)).toEqual([2]);
    expect(reloaded.targetEffectsRecovery).toBe('partial');
    expect(reloaded.reviewSets).toHaveLength(1);
  });
});

describe('v0.9.106 R2: what a fix or recheck dispatch keeps through a reload', () => {
  it('the contract keeps its recheck and fixes names; the task keeps the findings it was dispatched to fix', async () => {
    const { compileTaskContract } = await import('../TaskContract');
    const compiled = compileTaskContract({
      version: 1, objective: 'Fix a.ts.', expected_deliverable: 'a.ts', effects: { read_files: [], expected_file_effect: 'none' },
      inputs: [], constraints: [], dependencies: [], required_capabilities: { version: 1, capabilities: [] },
      execution_strategy: 'delegate-required', fixes: ['review-1#F1'],
    }, 'pm').contract!;
    const fixesOf = [{ reviewSetId: 'review-set-11111111-aaaa', findingId: 'F1' as const }];
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'fix-1', requestedAgent: 'dev', agentId: 'dev', instruction: 'Fix it.',
      originCorrelationId: 'root', contract: { ...compiled, fixesOf } } as never);
    const reloaded = new RunLedger(stored(ledger)).snapshot()[0].delegations[0];
    expect(reloaded.contract?.fixes).toEqual(['review-1#F1']);
    expect(reloaded.fixesFindings).toEqual(fixesOf);
  });
});
