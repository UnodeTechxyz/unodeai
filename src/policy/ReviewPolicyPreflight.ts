import {
  compareEffectiveExecutionIdentities,
  type EffectiveExecutionIdentity,
  type EffectiveExecutionIdentityComparison,
} from '../session/EffectiveExecutionIdentity';
import { ARTIFACT_REVIEW_POLICY_ID, reviewPolicyMode, type TeamPolicy } from './TeamPolicy';

export type ReviewPolicyDecisionCode =
  | 'not-marked'
  | 'not-selected'
  | 'allowed-different-reported-model'
  | 'allowed-author-unknown'
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

/** Pure final admission: structured relation + selected policy + host current-version/turn evidence only. */
export function evaluateReviewPolicy(input: {
  review?: { inputId: string };
  policy: TeamPolicy;
  authorIdentity?: EffectiveExecutionIdentity;
  /** Host's last committed current-byte writer. This is historical evidence, never process/route authority. */
  authorReportedModelId?: string;
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
  const authorModel = input.authorReportedModelId ?? input.authorIdentity?.reportedModelId;
  const comparison = !input.authorReportedModelId && input.authorIdentity && input.reviewerIdentity
    ? compareEffectiveExecutionIdentities(input.authorIdentity, input.reviewerIdentity)
    : undefined;
  const mode = reviewPolicyMode(input.policy);
  if (mode === 'off') {
    return {
      allowed: true,
      applied: false,
      policyId: ARTIFACT_REVIEW_POLICY_ID,
      code: 'not-selected',
      reason: 'The human-selected reported-model review policy is off.',
      ...(comparison ? { comparison } : {}),
    };
  }
  if (mode === 'different-when-author-known' && !authorModel) return {
    allowed: true, applied: true, policyId: ARTIFACT_REVIEW_POLICY_ID, code: 'allowed-author-unknown',
    reason: 'Author unknown — independence not established. Review may continue under the selected Team Rules policy; do not claim different reported models.',
  };
  if (!authorModel || !input.reviewerIdentity) {
    return {
      allowed: false,
      applied: true,
      policyId: ARTIFACT_REVIEW_POLICY_ID,
      code: 'refused-identity-unavailable',
      reason: authorModel ? 'This marked review was not started because the reviewer has not reported a model identity. The selected rule must be checked after normal reviewer start; no different model or timeout was invented.'
        : 'This marked review was not started because a verified current-version author reported model identity is unavailable. '
        + 'For a review of an upstream artifact, re-run the producer, then dispatch the marked review. '
        + 'For a workspace file with no verified current-version author, the selected strict rule cannot be established. Open Team Rules and choose “Different when author known (recommended)” if that is your intended policy; no setting was changed.',
    };
  }
  if (authorModel === input.reviewerIdentity.reportedModelId) {
    return {
      allowed: false,
      applied: true,
      policyId: ARTIFACT_REVIEW_POLICY_ID,
      code: 'refused-same-reported-model',
      reason: 'This marked artifact review was not started because its author and candidate reviewer have the same reported model identity. '
        + '\n1. Open the reviewer’s Agent Builder and choose a connection/model with a different reported model id.'
        + '\n2. Dispatch the marked review again.',
      ...(comparison ? { comparison } : {}),
    };
  }
  return {
    allowed: true,
    applied: true,
    policyId: ARTIFACT_REVIEW_POLICY_ID,
    code: 'allowed-different-reported-model',
    reason: 'The author and candidate reviewer have different reported model identities. This does not prove different underlying models or review quality.',
    ...(comparison ? { comparison } : {}),
  };
}
