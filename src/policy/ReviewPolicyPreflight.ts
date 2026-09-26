import {
  compareEffectiveExecutionIdentities,
  type EffectiveExecutionIdentity,
  type EffectiveExecutionIdentityComparison,
} from '../session/EffectiveExecutionIdentity';
import { ARTIFACT_REVIEW_POLICY_ID, type TeamPolicyV1 } from './TeamPolicy';

export type ReviewPolicyDecisionCode =
  | 'not-marked'
  | 'not-selected'
  | 'allowed-different-reported-model'
  | 'refused-same-reported-model'
  | 'refused-identity-unavailable';

export interface ReviewPolicyPreflightDecision {
  allowed: boolean;
  applied: boolean;
  policyId: typeof ARTIFACT_REVIEW_POLICY_ID;
  code: ReviewPolicyDecisionCode;
  reason: string;
  comparison?: EffectiveExecutionIdentityComparison;
}

/** Pure final admission: structured review relation + selected policy + exact turn identities only. */
export function evaluateReviewPolicy(input: {
  review?: { inputId: string };
  policy: TeamPolicyV1;
  authorIdentity?: EffectiveExecutionIdentity;
  reviewerIdentity?: EffectiveExecutionIdentity;
}): ReviewPolicyPreflightDecision {
  if (!input.review) {
    return {
      allowed: true,
      applied: false,
      policyId: ARTIFACT_REVIEW_POLICY_ID,
      code: 'not-marked',
      reason: 'No artifact review relation was declared.',
    };
  }
  const comparison = input.authorIdentity && input.reviewerIdentity
    ? compareEffectiveExecutionIdentities(input.authorIdentity, input.reviewerIdentity)
    : undefined;
  if (!input.policy.requireDifferentReportedModelForArtifactReview) {
    return {
      allowed: true,
      applied: false,
      policyId: ARTIFACT_REVIEW_POLICY_ID,
      code: 'not-selected',
      reason: 'The human-selected reported-model review policy is off.',
      ...(comparison ? { comparison } : {}),
    };
  }
  if (!comparison) {
    return {
      allowed: false,
      applied: true,
      policyId: ARTIFACT_REVIEW_POLICY_ID,
      code: 'refused-identity-unavailable',
      reason: 'This marked artifact review was not started because an exact process-lifetime author or reviewer execution identity is unavailable. Re-run the producer, then dispatch the marked review.',
    };
  }
  if (comparison.sameReportedModel) {
    return {
      allowed: false,
      applied: true,
      policyId: ARTIFACT_REVIEW_POLICY_ID,
      code: 'refused-same-reported-model',
      reason: 'This marked artifact review was not started because its author and candidate reviewer have the same reported model identity. Choose a reviewer turn with a different reported model id.',
      comparison,
    };
  }
  return {
    allowed: true,
    applied: true,
    policyId: ARTIFACT_REVIEW_POLICY_ID,
    code: 'allowed-different-reported-model',
    reason: 'The author and candidate reviewer have different reported model identities. This does not prove different underlying models or review quality.',
    comparison,
  };
}
