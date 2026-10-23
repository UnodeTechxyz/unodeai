import { describe, expect, it } from 'vitest';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { compileTaskContract, TaskInputResolver, type CandidateContractAgent, type EffectiveTaskContract } from '../../backend/TaskContract';
import { createEffectiveExecutionIdentity } from '../../session/EffectiveExecutionIdentity';
import { RunLedger } from '../../observability/RunLedger';
import { TeamPolicyStore } from '../TeamPolicy';
import { evaluateReviewPolicy } from '../ReviewPolicyPreflight';

class MemoryState {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  update(key: string, value: unknown): void { this.values.set(key, value); }
}

function compile(overrides: Record<string, unknown> = {}): EffectiveTaskContract {
  const result = compileTaskContract({
    version: 1,
    objective: 'Process the declared artifact.',
    expected_deliverable: 'A bounded result.',
    effects: { read_files: [], expected_file_effect: 'none' },
    inputs: [], constraints: [], dependencies: [],
    required_capabilities: { version: 1, capabilities: ['read'] },
    execution_strategy: 'delegate-required',
    ...overrides,
  }, 'pm');
  if (!result.contract) throw new Error(result.error);
  return result.contract;
}

function candidate(agentId: string, readyArtifacts: CandidateContractAgent['readyArtifacts'] = []): CandidateContractAgent {
  return {
    agentId,
    capabilities: { read: true, write: false, shell: false },
    taskScope: 'per-turn',
    verificationSensors: [],
    authorizedContentAssetIds: [], liveContentAssetIds: [], readyArtifacts,
  };
}

describe('chosen artifact-review policy integration', () => {
  it('refuses A through another route, admits Smart-selected B, records only the read receipt, and restores A when off', async () => {
    const assets = new ContentAssetStore();
    const resolver = new TaskInputResolver(assets, process.cwd());
    const state = new MemoryState();
    const policies = new TeamPolicyStore(state, () => new Date('2026-08-29T12:00:00.000Z'));
    const ledger = new RunLedger();
    const authorA = createEffectiveExecutionIdentity('reported-a', 'producer-route', 1);

    const producer = await resolver.beginAttempt(compile(), candidate('producer'), 'pm');
    resolver.bindAttemptExecutionIdentity(producer.card!.attemptId, authorA);
    const published = await resolver.publishArtifact(producer.card!.attemptId, 'producer', 'ARTIFACT X');
    resolver.endAttempt(producer.card!.attemptId, 'settled');
    await policies.setFromHumanPanel(true);
    expect(policies.changes()).toHaveLength(1);

    const reviewContract = compile({
      inputs: [{
        input_id: 'artifact', kind: 'upstreamArtifact', artifact_id: published.artifact!.artifactId,
        purpose: 'Exact review target', required: true, freshness: 'artifact-ready',
        provenance: { kind: 'upstream-artifact', source_refs: [] },
      }],
      dependencies: [published.artifact!.artifactId],
      review: { input_id: 'artifact' },
    });
    const refusedAttempt = await resolver.beginAttempt(reviewContract, candidate('reviewer-a', resolver.readyArtifacts()), 'pm');
    const refusedFacts = resolver.reviewPolicyFacts(refusedAttempt.card!.attemptId);
    const sameAOtherRoute = createEffectiveExecutionIdentity('reported-a', 'other-route', 9);
    const refusal = evaluateReviewPolicy({
      review: refusedFacts.review, policy: policies.current(),
      authorIdentity: refusedFacts.authorIdentity, reviewerIdentity: sameAOtherRoute,
    });
    expect(refusal).toMatchObject({ allowed: false, code: 'refused-same-reported-model', comparison: { sameConfiguredRouteAndModel: false } });
    resolver.endAttempt(refusedAttempt.card!.attemptId, 'cancelled');
    ledger.recordRefusedDispatch({
      coordinatorId: 'pm', handle: 'refused-a', requestedAgent: 'reviewer-a', reason: refusal.reason,
      taskState: 'policy-refused', policyId: refusal.policyId, originCorrelationId: 'root-review',
    });

    const admittedAttempt = await resolver.beginAttempt(reviewContract, candidate('reviewer-b', resolver.readyArtifacts()), 'pm');
    const reviewerB = createEffectiveExecutionIdentity('reported-b', 'smart-route', 2);
    resolver.bindAttemptExecutionIdentity(admittedAttempt.card!.attemptId, reviewerB);
    const admittedFacts = resolver.reviewPolicyFacts(admittedAttempt.card!.attemptId);
    const admission = evaluateReviewPolicy({
      review: admittedFacts.review, policy: policies.current(),
      authorIdentity: admittedFacts.authorIdentity, reviewerIdentity: reviewerB,
    });
    expect(admission.code).toBe('allowed-different-reported-model');
    resolver.recordReviewAdmission(admittedAttempt.card!.attemptId, admission);
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'admitted-b', requestedAgent: 'reviewer-b', agentId: 'reviewer-b',
      instruction: 'Review X.', contract: reviewContract, attemptId: admittedAttempt.card!.attemptId,
      originCorrelationId: 'root-review',
    });
    expect(resolver.reviewObservationForAttempt(admittedAttempt.card!.attemptId)).toBeUndefined();
    resolver.noteRead(admittedAttempt.card!.attemptId, 'reviewer-b', published.artifact!.contentAssetId);
    const observation = resolver.reviewObservationForAttempt(admittedAttempt.card!.attemptId)!;
    ledger.recordReviewObservation(observation);
    expect(ledger.get(runId)?.reviewObservations).toEqual([expect.objectContaining({
      artifactId: published.artifact!.artifactId, sameReportedModel: false,
    })]);
    expect(JSON.stringify(ledger.get(runId)?.reviewObservations)).not.toMatch(/reported-a|reported-b|producer-route|smart-route|ARTIFACT X|Review X/);

    await policies.setFromHumanPanel(false);
    const offDecision = evaluateReviewPolicy({
      review: admittedFacts.review, policy: policies.current(),
      authorIdentity: authorA, reviewerIdentity: sameAOtherRoute,
    });
    expect(offDecision).toMatchObject({ allowed: true, applied: false, code: 'not-selected' });
    await assets.dispose();
  });
});
