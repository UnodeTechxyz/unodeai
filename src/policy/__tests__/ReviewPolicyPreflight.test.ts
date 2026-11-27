import { describe, expect, it } from 'vitest';
import { createEffectiveExecutionIdentity } from '../../session/EffectiveExecutionIdentity';
import { evaluateReviewPolicy } from '../ReviewPolicyPreflight';

const off = { version: 1 as const, requireDifferentReportedModelForArtifactReview: false };
const on = { version: 1 as const, requireDifferentReportedModelForArtifactReview: true };
const author = createEffectiveExecutionIdentity('reported-a', 'route-a', 1);

describe('artifact review policy preflight', () => {
  it('does nothing for unmarked tasks regardless of review-looking natural language elsewhere', () => {
    expect(evaluateReviewPolicy({ policy: on, authorIdentity: author, reviewerIdentity: author })).toMatchObject({
      allowed: true, applied: false, code: 'not-marked',
    });
  });

  it('keeps marked same-model reviews on the pre-card path while policy is off', () => {
    expect(evaluateReviewPolicy({ review: { inputId: 'artifact' }, policy: off, authorIdentity: author, reviewerIdentity: author })).toMatchObject({
      allowed: true, applied: false, code: 'not-selected',
      comparison: { sameReportedModel: true, sameConfiguredRouteAndModel: true },
    });
  });

  it('refuses the same reported model even when the configured route differs', () => {
    const reviewer = createEffectiveExecutionIdentity('reported-a', 'route-b', 9);
    expect(evaluateReviewPolicy({ review: { inputId: 'artifact' }, policy: on, authorIdentity: author, reviewerIdentity: reviewer })).toMatchObject({
      allowed: false, code: 'refused-same-reported-model',
      comparison: { sameReportedModel: true, sameConfiguredRouteAndModel: false },
    });
  });

  it('allows a different reported id but makes no underlying-model or quality claim', () => {
    const reviewer = createEffectiveExecutionIdentity('reported-b', 'route-a', 1);
    const decision = evaluateReviewPolicy({ review: { inputId: 'artifact' }, policy: on, authorIdentity: author, reviewerIdentity: reviewer });
    expect(decision).toMatchObject({ allowed: true, applied: true, code: 'allowed-different-reported-model' });
    expect(decision.reason).toMatch(/does not prove different underlying models or review quality/i);
  });

  it('fails closed when either exact process-lifetime identity is unavailable', () => {
    expect(evaluateReviewPolicy({ review: { inputId: 'artifact' }, policy: on, reviewerIdentity: author }).code)
      .toBe('refused-identity-unavailable');
    expect(evaluateReviewPolicy({ review: { inputId: 'artifact' }, policy: on, authorIdentity: author }).allowed)
      .toBe(false);
  });

  it('says of the refusal what holds for a workspace file as well: it has no producer to re-run', () => {
    // A review of a workspace file comes with a reviewer and no author. The rule cannot be shown to hold, so the
    // review does not start, and the reason must not send the coordinator to re-run a producer that never was.
    const decision = evaluateReviewPolicy({ review: { inputId: 'the-file' }, policy: on, reviewerIdentity: author });
    expect(decision).toMatchObject({ allowed: false, applied: true, code: 'refused-identity-unavailable' });
    expect(decision.reason).toMatch(/workspace file with no verified current-version author, the selected strict rule cannot be established/);
    expect(decision.reason).toMatch(/For a review of an upstream artifact, re-run the producer/);
    expect(decision.reason).not.toMatch(/^This marked artifact review/);
  });

  it('admits unknown author only in the selected recommended mode without claiming a comparison', () => {
    const policy = { version: 2 as const, reviewMode: 'different-when-author-known' as const, requireDifferentReportedModelForArtifactReview: true };
    const unknown = evaluateReviewPolicy({ review: { inputId: 'target' }, policy, reviewerIdentity: author });
    expect(unknown).toMatchObject({ allowed: true, applied: true, code: 'allowed-author-unknown' });
    expect(unknown.comparison).toBeUndefined(); expect(unknown.reason).toContain('independence not established');
    expect(evaluateReviewPolicy({ review: { inputId: 'target' }, policy: on, reviewerIdentity: author }).allowed).toBe(false);
    expect(evaluateReviewPolicy({ review: { inputId: 'target' }, policy, authorReportedModelId: 'reported-a', reviewerIdentity: author }).allowed).toBe(false);
    expect(evaluateReviewPolicy({ review: { inputId: 'target' }, policy, authorReportedModelId: 'reported-b', reviewerIdentity: author }))
      .toMatchObject({ allowed: true, code: 'allowed-different-reported-model' });
    expect(evaluateReviewPolicy({ review: { inputId: 'target' }, policy, authorReportedModelId: 'reported-b' }).allowed).toBe(false);
  });
});
