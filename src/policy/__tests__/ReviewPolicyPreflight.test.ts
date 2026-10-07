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
});
