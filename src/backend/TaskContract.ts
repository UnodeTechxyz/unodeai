/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Task Contract and Input Resolver
 *
 *  A coordinator proposes structure; the host compiles an immutable contract and grants only the
 *  declared inputs to one concrete execution attempt.  This module is deliberately vscode-free so
 *  routing, dispatch, and security can share one decision instead of re-reading task prose.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs/promises';
import { realpathSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { ContentAssetStore } from '../content/ContentAssetStore';
import type { DelegationTaskScope } from '../types';
import type { EffectiveExecutionIdentity } from '../session/EffectiveExecutionIdentity';
import type { ReviewPolicyPreflightDecision, ReviewPolicyDecisionCode } from '../policy/ReviewPolicyPreflight';
import {
  parseVerificationPlan,
  type VerificationPlan,
  type VerificationSensorKind,
} from './VerificationPlan';

export const TASK_CONTRACT_VERSION = 1 as const;
export const TASK_CAPABILITY_SCHEMA_VERSION = 1 as const;
export const TASK_CAPABILITIES = ['read', 'write', 'shell'] as const;
export type TaskCapability = typeof TASK_CAPABILITIES[number];
export type TaskExecutionStrategy = 'delegate-preferred' | 'delegate-required' | 'coordinator-only';
export type ExpectedFileEffect = 'none' | 'create' | 'modify' | 'delete' | 'mixed';
export type ContextGapReason = 'missing' | 'expired' | 'outside-task-scope' | 'unreadable';

export interface TaskInputProvenance {
  kind: 'user-turn' | 'workspace' | 'upstream-artifact' | 'coordinator-declared';
  sourceRefs: string[];
}

interface ContractInputBase {
  inputId: string;
  purpose: string;
  required: boolean;
  provenance: TaskInputProvenance;
}

export interface ContentAssetContractInput extends ContractInputBase {
  kind: 'contentAsset';
  assetId: string;
  freshness: 'attempt-start';
}

export interface WorkspacePathContractInput extends ContractInputBase {
  kind: 'workspacePath';
  path: string;
  freshness: 'current' | 'dispatch-snapshot';
}

export interface UpstreamArtifactContractInput extends ContractInputBase {
  kind: 'upstreamArtifact';
  artifactId: string;
  freshness: 'artifact-ready';
}

export type ContractInput = ContentAssetContractInput | WorkspacePathContractInput | UpstreamArtifactContractInput;

export interface EffectiveTaskContract {
  contractId: string;
  version: typeof TASK_CONTRACT_VERSION;
  proposedBy: string;
  compiledAt: string;
  objective: string;
  expectedDeliverable: string;
  effects: {
    readFiles: string[];
    writeScope?: DelegationTaskScope;
    expectedFileEffect: ExpectedFileEffect;
  };
  inputs: ContractInput[];
  constraints: Array<{ text: string; basisRefs: string[] }>;
  /** Coordinator-authored orientation for a delegate. It is a claim, never host evidence. */
  coordinatorBrief?: { text: string; basisRefs: string[] };
  dependencies: string[];
  /** Explicit relation only; the host never infers review intent from prose, roles or filenames. */
  review?: { inputId: string };
  verificationPlan?: VerificationPlan;
  requiredCapabilities: {
    version: typeof TASK_CAPABILITY_SCHEMA_VERSION;
    capabilities: TaskCapability[];
  };
  executionStrategy: TaskExecutionStrategy;
}

export interface TaskContractParseResult {
  contract?: EffectiveTaskContract;
  error?: string;
}

export interface ReadyTaskArtifact {
  artifactId: string;
  contentAssetId: string;
  producerAttemptId: string;
  producerAgentId: string;
  delegableByAgentIds: string[];
  provenance: Array<{ producerAttemptId: string; inputId: string; kind: ContractInput['kind'] }>;
  state: 'artifact-ready';
}

export interface CandidateContractAgent {
  agentId: string;
  /** Host-derived target root used only to resolve dispatch snapshots; never shown as task context. */
  workspaceRoot?: string;
  capabilities?: { read: boolean; write: boolean; shell: boolean };
  taskScope?: 'per-turn' | 'fixed-session-only' | 'unavailable';
  verificationSensors?: readonly VerificationSensorKind[];
  /** The coordinator may delegate only assets it received for this turn (or artifacts it owns). */
  authorizedContentAssetIds: readonly string[];
  liveContentAssetIds: readonly string[];
  readyArtifacts: readonly ReadyTaskArtifact[];
}

export interface PreflightInputDecision {
  inputId: string;
  kind: ContractInput['kind'];
  sourceRef: string;
  resolvedContentAssetId?: string;
}

export interface PreflightFailure {
  filter: 'permissions' | 'task-scope' | 'input-grant' | 'dependency' | 'verification-sensor';
  inputId?: string;
  reason: string;
}

export interface TaskPreflightResult {
  ok: boolean;
  decisions: PreflightInputDecision[];
  failures: PreflightFailure[];
}

export interface InputGrant {
  attemptId: string;
  agentId: string;
  inputId: string;
  kind: ContractInput['kind'];
  sourceRef: string;
  resolvedContentAssetId?: string;
  suppliedAt: string;
  reachableAt?: string;
  readAt?: string;
}

/** Settlement-only host fact. It compares a contract's required inputs with the resolver's own receipts. */
export interface RequiredInputReadSummary {
  requiredInputCount: number;
  requiredInputReadNotObservedCount: number;
}

export interface TaskAttemptCard {
  attemptId: string;
  contractId: string;
  agentId: string;
  contract: EffectiveTaskContract;
  grants: InputGrant[];
  /** A contract narrows workspace authority only when it carries an enforceable per-turn scope. */
  baselineWorkspaceAuthority: 'independent-agent-authority' | 'narrowed-by-contract-scope';
}

export interface TaskContextGap {
  attemptId: string;
  contractId: string;
  inputId: string;
  reason: ContextGapReason;
  /** Coordinator-only. Portable evidence must omit this prose. */
  purpose: string;
  reportedAt: string;
}

export interface ArtifactReviewObservation {
  schemaVersion: 1;
  artifactId: string;
  reviewInputId: string;
  producerAttemptId: string;
  reviewerAttemptId: string;
  artifactReadAt: string;
  sameReportedModel: boolean;
  sameConfiguredRouteAndModel: boolean;
  policyDecision: ReviewPolicyDecisionCode;
  observedAt: string;
}

/** Host-private access fact for one declared input in one live attempt. */
export type InputAccessObservation =
  | { outcome: 'read'; observedAt: string; revision: number }
  | { outcome: 'failure'; reason: ContextGapReason; observedAt: string; revision: number };
type NewInputAccessObservation =
  | { outcome: 'read'; observedAt: string }
  | { outcome: 'failure'; reason: ContextGapReason; observedAt: string };

export type ContextGapReportResult =
  | { status: 'recorded'; gap: TaskContextGap }
  | { status: 'unknown-or-unavailable' }
  | { status: 'no-current-failure'; latestOutcome?: 'read' };

interface LiveTaskAttempt {
  card: TaskAttemptCard;
  coordinatorId: string;
  state: 'live' | 'cancelled' | 'settled';
  gapRecords: Array<{ gap: TaskContextGap; observationRevision: number }>;
  inputObservations: Map<string, InputAccessObservation>;
  nextObservationRevision: number;
  /** Host-private physical identities for workspace inputs. Never copy these into TaskAttemptCard. */
  workspacePathBase: string;
  workspacePathIdentities: Map<string, string>;
  workspaceLexicalPaths: Map<string, string>;
}

interface ReviewAdmissionReceipt {
  decision: ReviewPolicyPreflightDecision;
}

const CAPABILITY_SET = new Set<string>(TASK_CAPABILITIES);
const INPUT_ID = /^[a-z][a-z0-9._-]{0,79}$/;
const CONTENT_ASSET_ID = /^content-[1-9]\d*$/;
const ARTIFACT_ID = /^artifact-[a-z0-9-]+$/;

/** Parse the model's untrusted proposal and return a deeply frozen, host-stamped contract. */
export function compileTaskContract(
  rawValue: unknown,
  proposedBy: string,
  /** The host root makes absolute workspace paths unambiguous without accepting outside paths. */
  workspaceRoot?: string,
): TaskContractParseResult {
  if (!isRecord(rawValue)) {
    return { error: 'contract is required and must be an object.' };
  }
  const raw = rawValue;
  const allowed = new Set([
    'version', 'objective', 'expected_deliverable', 'effects', 'inputs', 'constraints',
    'coordinator_brief', 'dependencies', 'review', 'verification_plan', 'required_capabilities', 'execution_strategy',
  ]);
  const extra = Object.keys(raw).find((key) => !allowed.has(key));
  if (extra) return { error: `contract contains unsupported field "${extra}".` };
  if (raw.version !== TASK_CONTRACT_VERSION) {
    return { error: `contract.version must be ${TASK_CONTRACT_VERSION}.` };
  }
  const objective = boundedText(raw.objective, 'contract.objective', 1, 4_000);
  if (objective.error) return { error: objective.error };
  const deliverable = raw.expected_deliverable === undefined
    ? { value: '' }
    : boundedText(raw.expected_deliverable, 'contract.expected_deliverable', 1, 4_000);
  if (deliverable.error) return { error: deliverable.error };

  const effects = parseEffects(raw.effects, workspaceRoot);
  if (effects.error) return { error: effects.error };
  const inputs = parseInputs(raw.inputs, workspaceRoot);
  if (inputs.error) return { error: inputs.error };
  const constraints = parseConstraints(raw.constraints ?? [], new Set(inputs.inputs!.map((input) => input.inputId)));
  if (constraints.error) return { error: constraints.error };
  const coordinatorBrief = parseCoordinatorBrief(raw.coordinator_brief, new Set(inputs.inputs!.map((input) => input.inputId)));
  if (coordinatorBrief.error) return { error: coordinatorBrief.error };
  const dependencies = parseStringArray(raw.dependencies ?? [], 'contract.dependencies', 100, ARTIFACT_ID);
  if (dependencies.error) return { error: dependencies.error };
  const upstreamIds = new Set(inputs.inputs!.filter((input): input is UpstreamArtifactContractInput => input.kind === 'upstreamArtifact').map((input) => input.artifactId));
  const dependencySet = new Set(dependencies.values!);
  for (const artifactId of dependencySet) {
    if (!upstreamIds.has(artifactId)) {
      return { error: `contract dependency "${artifactId}" has no matching upstreamArtifact input.` };
    }
  }
  for (const artifactId of upstreamIds) {
    if (!dependencySet.has(artifactId)) {
      return { error: `upstreamArtifact input "${artifactId}" must also appear in contract.dependencies.` };
    }
  }
  const review = parseReview(raw.review, inputs.inputs!);
  if (review.error) return { error: review.error };

  const requiredCapabilities = parseRequiredCapabilities(raw.required_capabilities);
  if (requiredCapabilities.error) return { error: requiredCapabilities.error };
  const declaredCapabilities = new Set(requiredCapabilities.value!.capabilities);
  const needsRead = effects.effects!.readFiles.length > 0
    || inputs.inputs!.length > 0
    || effects.effects!.writeScope?.folderAccess.some((entry) => entry.permission === 'read') === true;
  const needsWrite = effects.effects!.expectedFileEffect !== 'none'
    || effects.effects!.writeScope?.folderAccess.some((entry) => entry.permission === 'readwrite') === true;
  if (needsRead && !declaredCapabilities.has('read')) {
    return { error: 'contract.required_capabilities.capabilities must explicitly declare "read" for the declared inputs or read effects.' };
  }
  if (needsWrite && !declaredCapabilities.has('write')) {
    return { error: 'contract.required_capabilities.capabilities must explicitly declare "write" for the declared file effects; the host will not infer or add it.' };
  }
  const verification = parseVerificationPlan(raw.verification_plan);
  if (verification.error) return { error: `invalid contract verification plan. ${verification.error}` };
  const strategy = raw.execution_strategy === undefined ? 'delegate-preferred' : raw.execution_strategy;
  if (strategy !== 'delegate-preferred' && strategy !== 'delegate-required' && strategy !== 'coordinator-only') {
    return { error: 'contract.execution_strategy must be delegate-preferred, delegate-required, or coordinator-only.' };
  }

  const contract: EffectiveTaskContract = {
    contractId: `contract-${uuidv4()}`,
    version: TASK_CONTRACT_VERSION,
    proposedBy,
    compiledAt: new Date().toISOString(),
    objective: objective.value!,
    expectedDeliverable: deliverable.value!,
    effects: effects.effects!,
    inputs: inputs.inputs!,
    constraints: constraints.constraints!,
    ...(coordinatorBrief.brief ? { coordinatorBrief: coordinatorBrief.brief } : {}),
    dependencies: dependencies.values!,
    ...(review.value ? { review: review.value } : {}),
    ...(verification.plan ? { verificationPlan: verification.plan } : {}),
    requiredCapabilities: requiredCapabilities.value!,
    executionStrategy: strategy,
  };
  return { contract: deepFreeze(contract) };
}

/**
 * The one grantability decision. Candidate filtering and actual grant issue both call this exact function.
 * It is pure: all mutable host facts are projected into CandidateContractAgent before the call.
 */
export function preflightInputGrants(
  contract: EffectiveTaskContract,
  candidateAgent: CandidateContractAgent,
): TaskPreflightResult {
  const failures: PreflightFailure[] = [];
  const decisions: PreflightInputDecision[] = [];
  const capabilities = candidateAgent.capabilities;
  for (const capability of contract.requiredCapabilities.capabilities) {
    if (!capabilities?.[capability]) {
      failures.push({ filter: 'permissions', reason: `missing required capability "${capability}"` });
    }
  }
  if (contract.effects.writeScope && candidateAgent.taskScope !== 'per-turn') {
    failures.push({
      filter: 'task-scope',
      reason: `contract scope requires per-turn enforcement; candidate has taskScope=${candidateAgent.taskScope ?? 'unavailable'}`,
    });
  }
  const reachableSensors = new Set(candidateAgent.verificationSensors ?? []);
  for (const sensor of contract.verificationPlan?.sensors ?? []) {
    if (!reachableSensors.has(sensor)) {
      failures.push({ filter: 'verification-sensor', reason: `verification sensor "${sensor}" is not reachable by this candidate` });
    }
  }

  const authorizedAssets = new Set(candidateAgent.authorizedContentAssetIds);
  const liveAssets = new Set(candidateAgent.liveContentAssetIds);
  const artifacts = new Map(candidateAgent.readyArtifacts.map((artifact) => [artifact.artifactId, artifact]));
  for (const input of contract.inputs) {
    if (input.kind === 'contentAsset') {
      if (!authorizedAssets.has(input.assetId)) {
        if (input.required) failures.push({ filter: 'input-grant', inputId: input.inputId, reason: `required input "${input.inputId}" is not authorised for delegation` });
        continue;
      }
      if (!liveAssets.has(input.assetId)) {
        if (input.required) failures.push({ filter: 'input-grant', inputId: input.inputId, reason: `required input "${input.inputId}" is expired or unavailable` });
        continue;
      }
      decisions.push({ inputId: input.inputId, kind: input.kind, sourceRef: input.assetId, resolvedContentAssetId: input.assetId });
      continue;
    }
    if (input.kind === 'workspacePath') {
      if (!capabilities?.read) {
        if (input.required) failures.push({ filter: 'permissions', inputId: input.inputId, reason: `required workspace input "${input.inputId}" needs read capability` });
        continue;
      }
      if (contract.effects.writeScope && !pathCoveredByScope(input.path, contract.effects.writeScope, candidateAgent.workspaceRoot)) {
        if (input.required) failures.push({ filter: 'task-scope', inputId: input.inputId, reason: `workspace input "${input.inputId}" is outside the contract task scope` });
        continue;
      }
      decisions.push({ inputId: input.inputId, kind: input.kind, sourceRef: input.path });
      continue;
    }
    const artifact = artifacts.get(input.artifactId);
    if (!artifact || artifact.state !== 'artifact-ready') {
      if (input.required) failures.push({ filter: 'dependency', inputId: input.inputId, reason: `upstream artifact "${input.artifactId}" is not artifact-ready` });
      continue;
    }
    if (!artifact.delegableByAgentIds.includes(contract.proposedBy)) {
      if (input.required) failures.push({ filter: 'input-grant', inputId: input.inputId, reason: `upstream artifact "${input.artifactId}" is not delegable by this coordinator` });
      continue;
    }
    decisions.push({
      inputId: input.inputId,
      kind: input.kind,
      sourceRef: input.artifactId,
      resolvedContentAssetId: artifact.contentAssetId,
    });
  }
  return { ok: failures.length === 0, decisions, failures };
}

/** Live, host-owned grant registry. TTL is storage cleanup, never authorisation. */
export class TaskInputResolver {
  private readonly attempts = new Map<string, LiveTaskAttempt>();
  private readonly liveAttemptByContract = new Map<string, string>();
  private readonly artifacts = new Map<string, ReadyTaskArtifact>();
  /** P1 identities remain process-private: no public task/artifact/evidence shape references these maps. */
  private readonly attemptExecutionIdentities = new Map<string, EffectiveExecutionIdentity>();
  private readonly artifactAuthorIdentities = new Map<string, EffectiveExecutionIdentity>();
  private readonly reviewAdmissions = new Map<string, ReviewAdmissionReceipt>();
  private readonly reviewObservations = new Map<string, ArtifactReviewObservation>();
  /** Snapshot/artifact transport ids whose creator ownership must never bypass attempt grants. */
  private readonly contractManagedContentAssets = new Set<string>();
  private nextArtifact = 1;

  constructor(private readonly contentAssets: ContentAssetStore, private readonly workspaceRoot: string) {}

  readyArtifacts(): ReadyTaskArtifact[] {
    this.pruneExpiredArtifacts();
    return [...this.artifacts.values()].map(cloneArtifact);
  }

  artifactsForAttempt(attemptId: string): ReadyTaskArtifact[] {
    this.pruneExpiredArtifacts();
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.producerAttemptId === attemptId)
      .map(cloneArtifact);
  }

  liveContentAssetIds(assetIds: readonly string[]): string[] {
    return assetIds.filter((assetId) => this.contentAssets.getReceipt(assetId) !== undefined);
  }

  async beginAttempt(
    contract: EffectiveTaskContract,
    candidate: CandidateContractAgent,
    coordinatorId: string,
  ): Promise<{ card?: TaskAttemptCard; error?: string }> {
    if (this.liveAttemptByContract.has(contract.contractId)) {
      return { error: `contract ${contract.contractId} already has a live attempt` };
    }
    // The real dispatch calls the same pure function used during routing; there is no second grant rule.
    const preflight = preflightInputGrants(contract, candidate);
    if (!preflight.ok) {
      return { error: preflight.failures.map((failure) => `${failure.filter}: ${failure.reason}`).join('; ') };
    }
    const attemptId = `attempt-${uuidv4()}`;
    // Reserve before the first await. Snapshot reads can yield, and a second caller must not create a
    // concurrent attempt for the same immutable contract while the first one is still materialising.
    this.liveAttemptByContract.set(contract.contractId, attemptId);
    const abort = (error: string): { error: string } => {
      if (this.liveAttemptByContract.get(contract.contractId) === attemptId) {
        this.liveAttemptByContract.delete(contract.contractId);
      }
      return { error };
    };
    const now = new Date().toISOString();
    const grants: InputGrant[] = [];
    const workspacePathBase = path.resolve(candidate.workspaceRoot ?? this.workspaceRoot);
    const workspacePathIdentities = new Map<string, string>();
    const workspaceLexicalPaths = new Map<string, string>();
    for (const decision of preflight.decisions) {
      const input = contract.inputs.find((candidateInput) => candidateInput.inputId === decision.inputId)!;
      let resolvedContentAssetId = decision.resolvedContentAssetId;
      if (input.kind === 'workspacePath') {
        workspaceLexicalPaths.set(input.inputId, path.resolve(workspacePathBase, input.path));
        const identity = resolveWorkspacePathIdentity(workspacePathBase, input.path);
        if (identity) workspacePathIdentities.set(input.inputId, identity);
      }
      if (input.kind === 'workspacePath' && input.freshness === 'dispatch-snapshot') {
        const attemptRoot = workspacePathBase;
        const absolute = path.resolve(attemptRoot, input.path);
        if (!isInside(attemptRoot, absolute)) {
          return abort(`task-scope: workspace snapshot input "${input.inputId}" escapes the workspace root`);
        }
        let text: string;
        try {
          text = await fs.readFile(absolute, 'utf8');
        } catch {
          return abort(`input-grant: workspace snapshot input "${input.inputId}" is unreadable`);
        }
        const stored = await this.contentAssets.storeText(text, 'turn-supplied');
        if ('error' in stored) {
          return abort(`input-grant: workspace snapshot input "${input.inputId}" is too large to snapshot`);
        }
        resolvedContentAssetId = stored.assetId;
        this.contractManagedContentAssets.add(stored.assetId);
      }
      grants.push({
        attemptId,
        agentId: candidate.agentId,
        inputId: input.inputId,
        kind: input.kind,
        sourceRef: decision.sourceRef,
        ...(resolvedContentAssetId ? { resolvedContentAssetId } : {}),
        suppliedAt: now,
      });
    }
    const missingBriefGrant = contract.coordinatorBrief?.basisRefs.find((inputId) =>
      !grants.some((grant) => grant.inputId === inputId),
    );
    if (missingBriefGrant) {
      return abort(
        `input-grant: coordinator brief cites input "${missingBriefGrant}", which was not granted; grant it or remove the reference`,
      );
    }
    const card: TaskAttemptCard = deepFreeze({
      attemptId,
      contractId: contract.contractId,
      agentId: candidate.agentId,
      contract,
      grants,
      baselineWorkspaceAuthority: contract.effects.writeScope
        ? 'narrowed-by-contract-scope'
        : 'independent-agent-authority',
    });
    this.attempts.set(attemptId, {
      card,
      coordinatorId,
      state: 'live',
      gapRecords: [],
      inputObservations: new Map(),
      nextObservationRevision: 1,
      workspacePathBase,
      workspacePathIdentities,
      workspaceLexicalPaths,
    });
    return { card };
  }

  endAttempt(attemptId: string, state: 'cancelled' | 'settled'): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state !== 'live') return;
    attempt.state = state;
    attempt.workspacePathIdentities.clear();
    attempt.workspaceLexicalPaths.clear();
    this.liveAttemptByContract.delete(attempt.card.contractId);
    this.attemptExecutionIdentities.delete(attemptId);
    // Grants remain in the historical card as receipts, but every authority check below requires state=live.
  }

  /** Bind only the exact identity selected for this attempt's forthcoming turn. */
  bindAttemptExecutionIdentity(attemptId: string, identity: EffectiveExecutionIdentity | undefined): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state !== 'live' || !identity) return;
    this.attemptExecutionIdentities.set(attemptId, identity);
  }

  reviewPolicyFacts(attemptId: string): {
    review?: { inputId: string };
    authorIdentity?: EffectiveExecutionIdentity;
  } {
    this.pruneExpiredArtifacts();
    const attempt = this.attempts.get(attemptId);
    const review = attempt?.card.contract.review;
    if (!attempt || !review) return {};
    const input = attempt.card.contract.inputs.find((candidate): candidate is UpstreamArtifactContractInput =>
      candidate.inputId === review.inputId && candidate.kind === 'upstreamArtifact');
    if (!input) return { review: { ...review } };
    return {
      review: { ...review },
      ...(this.artifactAuthorIdentities.get(input.artifactId)
        ? { authorIdentity: this.artifactAuthorIdentities.get(input.artifactId)! }
        : {}),
    };
  }

  recordReviewAdmission(attemptId: string, decision: ReviewPolicyPreflightDecision): void {
    if (!this.attempts.has(attemptId) || !decision.allowed) return;
    this.reviewAdmissions.set(attemptId, { decision });
  }

  reviewObservationForAttempt(attemptId: string): ArtifactReviewObservation | undefined {
    const existing = this.reviewObservations.get(attemptId);
    if (existing) return { ...existing };
    const attempt = this.attempts.get(attemptId);
    const review = attempt?.card.contract.review;
    const admission = this.reviewAdmissions.get(attemptId)?.decision;
    if (!attempt || !review || !admission?.allowed || !admission.comparison) return undefined;
    const input = attempt.card.contract.inputs.find((candidate): candidate is UpstreamArtifactContractInput =>
      candidate.inputId === review.inputId && candidate.kind === 'upstreamArtifact');
    const grant = attempt.card.grants.find((candidate) => candidate.inputId === review.inputId);
    if (!input || !grant?.readAt) return undefined;
    const artifact = this.artifacts.get(input.artifactId);
    if (!artifact) return undefined;
    const observation: ArtifactReviewObservation = {
      schemaVersion: 1,
      artifactId: artifact.artifactId,
      reviewInputId: review.inputId,
      producerAttemptId: artifact.producerAttemptId,
      reviewerAttemptId: attemptId,
      artifactReadAt: grant.readAt,
      sameReportedModel: admission.comparison.sameReportedModel,
      sameConfiguredRouteAndModel: admission.comparison.sameConfiguredRouteAndModel,
      policyDecision: admission.code,
      observedAt: new Date().toISOString(),
    };
    this.reviewObservations.set(attemptId, observation);
    return { ...observation };
  }

  isAttemptLive(attemptId: string, agentId?: string): boolean {
    const attempt = this.attempts.get(attemptId);
    return !!attempt && attempt.state === 'live' && (!agentId || attempt.card.agentId === agentId);
  }

  canReadContentAsset(attemptId: string, agentId: string, assetId: string): boolean {
    const attempt = this.attempts.get(attemptId);
    return this.isAttemptLive(attemptId, agentId)
      && !!attempt
      && attempt.card.grants.some((grant) => grant.resolvedContentAssetId === assetId);
  }

  isContractManagedContentAsset(assetId: string): boolean {
    return this.contractManagedContentAssets.has(assetId);
  }

  /** A coordinator may explicitly delegate a live asset it created, except contract-managed transport
   *  objects, which must continue through their declared artifact/input identity and provenance chain. */
  canDelegateOwnedContentAsset(assetId: string, coordinatorId: string): boolean {
    return !this.contractManagedContentAssets.has(assetId) && this.contentAssets.isOwnedBy(assetId, coordinatorId);
  }

  noteReachable(attemptId: string, agentId: string, assetId: string): void {
    this.updateGrant(attemptId, agentId, (candidate) => candidate.resolvedContentAssetId === assetId, (grant) => ({
      ...grant,
      reachableAt: grant.reachableAt ?? new Date().toISOString(),
    }));
  }

  noteRead(attemptId: string, agentId: string, ref: string): void {
    const now = new Date().toISOString();
    this.updateGrant(attemptId, agentId, (candidate) =>
      candidate.resolvedContentAssetId === ref,
      (grant) => ({ ...grant, reachableAt: grant.reachableAt ?? now, readAt: now }),
    );
    this.observeInputByAsset(attemptId, agentId, ref, { outcome: 'read', observedAt: now });
  }

  /**
   * Record a successful workspace read by the physical file the host observed, never by the model's
   * argument spelling. The declared-input identities stay in LiveTaskAttempt and cannot reach the model,
   * the run ledger, or portable evidence through TaskAttemptCard.
   */
  noteWorkspaceRead(attemptId: string, agentId: string, observedPath: string): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state !== 'live' || attempt.card.agentId !== agentId) return;
    const observedIdentity = resolveWorkspacePathIdentity(attempt.workspacePathBase, observedPath);
    if (!observedIdentity) return;
    const matched = attempt.card.grants.find((grant) => {
      if (grant.kind !== 'workspacePath') return false;
      let identity = attempt.workspacePathIdentities.get(grant.inputId);
      if (!identity) {
        identity = resolveWorkspacePathIdentity(attempt.workspacePathBase, grant.sourceRef);
        if (identity) attempt.workspacePathIdentities.set(grant.inputId, identity);
      }
      return !!identity && samePhysicalPath(identity, observedIdentity);
    });
    if (!matched) return;
    const now = new Date().toISOString();
    this.updateGrant(attemptId, agentId, (grant) => grant.inputId === matched.inputId, (grant) => ({
      ...grant,
      reachableAt: grant.reachableAt ?? now,
      readAt: now,
    }));
    this.setInputObservation(attempt, matched.inputId, { outcome: 'read', observedAt: now });
  }

  noteContentAccessFailure(attemptId: string, agentId: string, assetId: string, reason: ContextGapReason): void {
    this.observeInputByAsset(attemptId, agentId, assetId, { outcome: 'failure', reason, observedAt: new Date().toISOString() });
  }

  noteWorkspaceAccessFailure(attemptId: string, agentId: string, observedPath: string, reason: ContextGapReason): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state !== 'live' || attempt.card.agentId !== agentId) return;
    const lexical = path.isAbsolute(observedPath)
      ? path.resolve(observedPath)
      : path.resolve(attempt.workspacePathBase, observedPath);
    const matched = attempt.card.grants.find((grant) => grant.kind === 'workspacePath'
      && samePhysicalPath(attempt.workspaceLexicalPaths.get(grant.inputId) ?? '', lexical));
    if (!matched) return;
    this.setInputObservation(attempt, matched.inputId, { outcome: 'failure', reason, observedAt: new Date().toISOString() });
  }

  reportContextGap(attemptId: string, agentId: string, inputId: string): ContextGapReportResult {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state !== 'live' || attempt.card.agentId !== agentId) return { status: 'unknown-or-unavailable' };
    const input = attempt.card.contract.inputs.find((candidate) => candidate.inputId === inputId && candidate.required);
    if (!input) return { status: 'unknown-or-unavailable' };
    const observation = attempt.inputObservations.get(inputId);
    if (!observation || observation.outcome !== 'failure') {
      return { status: 'no-current-failure', ...(observation?.outcome === 'read' ? { latestOutcome: 'read' as const } : {}) };
    }
    const prior = attempt.gapRecords.find((record) => record.gap.inputId === inputId
      && record.observationRevision === observation.revision);
    if (prior) return { status: 'recorded', gap: { ...prior.gap } };
    const gap: TaskContextGap = {
      attemptId,
      contractId: attempt.card.contractId,
      inputId,
      reason: observation.reason,
      purpose: input.purpose,
      reportedAt: new Date().toISOString(),
    };
    attempt.gapRecords.push({ gap, observationRevision: observation.revision });
    return { status: 'recorded', gap: { ...gap } };
  }

  gapsForAttempt(attemptId: string): TaskContextGap[] {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return [];
    return attempt.gapRecords.flatMap((record) => {
      const current = attempt.inputObservations.get(record.gap.inputId);
      return current?.outcome === 'failure' && current.revision === record.observationRevision
        ? [{ ...record.gap }]
        : [];
    });
  }

  /** Content-free proof vocabulary for evidence: supplied, reachable and read; never "understood". */
  grantsForAttempt(attemptId: string): InputGrant[] {
    return (this.attempts.get(attemptId)?.card.grants ?? []).map((grant) => ({ ...grant }));
  }

  /**
   * Derive required-input receipt counts from the host's live attempt, never from a worker message.
   * Historical attempts remain queryable after settlement, so the final receipt is stable for ledger export.
   */
  requiredInputReadSummary(attemptId: string): RequiredInputReadSummary | undefined {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return undefined;
    const requiredIds = new Set(attempt.card.contract.inputs
      .filter((input) => input.required)
      .map((input) => input.inputId));
    let requiredInputReadNotObservedCount = 0;
    for (const inputId of requiredIds) {
      const grant = attempt.card.grants.find((candidate) => candidate.inputId === inputId);
      if (!grant?.readAt) requiredInputReadNotObservedCount++;
    }
    return { requiredInputCount: requiredIds.size, requiredInputReadNotObservedCount };
  }

  async publishArtifact(attemptId: string, agentId: string, text: string): Promise<{ artifact?: ReadyTaskArtifact; error?: string }> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state !== 'live' || attempt.card.agentId !== agentId) {
      return { error: 'no live task attempt can publish this artifact' };
    }
    const value = String(text ?? '');
    if (!value.trim()) return { error: 'artifact content is required' };
    const stored = await this.contentAssets.storeText(value, 'turn-supplied', agentId);
    if ('error' in stored) return { error: 'artifact exceeds the bounded content store limit' };
    this.contractManagedContentAssets.add(stored.assetId);
    const provenance = attempt.card.grants.flatMap((grant) => {
      const inherited = grant.kind === 'upstreamArtifact'
        ? this.artifacts.get(grant.sourceRef)?.provenance ?? []
        : [];
      return [
        ...inherited.map((entry) => ({ ...entry })),
        { producerAttemptId: attemptId, inputId: grant.inputId, kind: grant.kind },
      ];
    }).filter((entry, index, all) => all.findIndex((candidate) =>
      candidate.producerAttemptId === entry.producerAttemptId
      && candidate.inputId === entry.inputId
      && candidate.kind === entry.kind
    ) === index);
    const artifact: ReadyTaskArtifact = {
      artifactId: `artifact-${this.nextArtifact++}-${uuidv4()}`,
      contentAssetId: stored.assetId,
      producerAttemptId: attemptId,
      producerAgentId: agentId,
      // The proposing coordinator is the only actor allowed to explicitly declare a downstream use.
      delegableByAgentIds: [attempt.coordinatorId],
      // Conservative taint: every granted input and every inherited upstream entry is retained. A worker
      // cannot launder a source by omitting it or by publishing it through several artifact hops.
      provenance,
      state: 'artifact-ready',
    };
    this.artifacts.set(artifact.artifactId, artifact);
    const authorIdentity = this.attemptExecutionIdentities.get(attemptId);
    if (authorIdentity) this.artifactAuthorIdentities.set(artifact.artifactId, authorIdentity);
    return { artifact: cloneArtifact(artifact) };
  }

  private pruneExpiredArtifacts(): void {
    for (const [artifactId, artifact] of this.artifacts) {
      if (this.contentAssets.getReceipt(artifact.contentAssetId)) continue;
      this.artifacts.delete(artifactId);
      this.artifactAuthorIdentities.delete(artifactId);
      this.contractManagedContentAssets.delete(artifact.contentAssetId);
    }
  }

  private updateGrant(
    attemptId: string,
    agentId: string,
    predicate: (grant: InputGrant) => boolean,
    update: (grant: InputGrant) => InputGrant,
  ): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state !== 'live' || attempt.card.agentId !== agentId) return;
    // The externally exposed card is frozen. Replace it with a new frozen receipt when observations change.
    const index = attempt.card.grants.findIndex(predicate);
    if (index < 0) return;
    const grant = update({ ...attempt.card.grants[index] });
    const grants = attempt.card.grants.map((item, itemIndex) => itemIndex === index ? grant : item);
    attempt.card = deepFreeze({ ...attempt.card, grants });
  }

  private observeInputByAsset(
    attemptId: string,
    agentId: string,
    assetId: string,
    observation: NewInputAccessObservation,
  ): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state !== 'live' || attempt.card.agentId !== agentId) return;
    const grant = attempt.card.grants.find((candidate) => candidate.resolvedContentAssetId === assetId);
    if (!grant) return;
    this.setInputObservation(attempt, grant.inputId, observation);
  }

  private setInputObservation(
    attempt: LiveTaskAttempt,
    inputId: string,
    observation: NewInputAccessObservation,
  ): void {
    attempt.inputObservations.set(inputId, {
      ...observation,
      revision: attempt.nextObservationRevision++,
    } as InputAccessObservation);
  }
}

export function formatTaskAttemptCard(card: TaskAttemptCard): string {
  const { contract } = card;
  const inputs = contract.inputs.map((input) => {
    const grant = card.grants.find((candidate) => candidate.inputId === input.inputId);
    const access = grant?.resolvedContentAssetId
      ? `read with extracted-content tools as ${grant.resolvedContentAssetId}`
      : input.kind === 'workspacePath'
        ? `read workspace path ${input.path}${input.freshness === 'dispatch-snapshot' ? ' (snapshot)' : ' (current content)'}`
        : 'not granted (optional)';
    return `- ${input.inputId} [${input.kind}; ${input.required ? 'required' : 'optional'}]: ${input.purpose} — ${access}`;
  });
  const constraints = contract.constraints.length
    ? contract.constraints.map((constraint) => `- ${constraint.text}`).join('\n')
    : '- none declared';
  const writeScope = contract.effects.writeScope
    ? contract.effects.writeScope.folderAccess.map((grant) => `${grant.permission}:${grant.path}`).join(', ')
    : 'agent baseline (not widened by this contract)';
  return [
    '[host task card]',
    `Attempt: ${card.attemptId}`,
    `Objective: ${contract.objective}`,
    `Deliverable: ${contract.expectedDeliverable || 'not declared'}`,
    `Read files: ${contract.effects.readFiles.join(', ') || 'none declared'}`,
    `Write scope: ${writeScope}`,
    `Expected file effect: ${contract.effects.expectedFileEffect}`,
    `Marked artifact review input: ${contract.review?.inputId ?? 'none'}`,
    `Baseline workspace authority: ${card.baselineWorkspaceAuthority === 'independent-agent-authority'
      ? 'still exists independently; contract inputs do not widen it'
      : 'narrowed to the host-enforced per-turn scope'}`,
    'Inputs:',
    inputs.join('\n') || '- none',
    'Settled coordinator constraints (claims, not host facts):',
    constraints,
    ...(contract.coordinatorBrief ? [
      `Coordinator brief — claims and hypotheses, not host facts. Verify against the granted inputs before relying on it. Basis: ${contract.coordinatorBrief.basisRefs.length ? contract.coordinatorBrief.basisRefs.join(', ') : 'none stated'}`,
      contract.coordinatorBrief.text,
    ] : []),
    `Verification sensors: ${contract.verificationPlan?.sensors.join(', ') || 'none applicable / not declared'}`,
    ...(contract.inputs.some((input) => input.required)
      ? ['If a granted read returns a host-observed access failure for a required input, call report_context_gap with only its inputId. '
        + 'The host derives the failure reason; semantic insufficiency belongs in your task result. Do not substitute web content for a declared input the host could not supply; that input stays reported as a gap.']
      : ['This task declares no required inputs, so no input-substitution rule applies to it.']),
    '[/host task card]',
  ].join('\n');
}

/** Explicit legacy compilation: the compatibility path states an empty capability set. */
export function legacyTaskContract(
  instruction: string,
  proposedBy: string,
  options: { readFiles?: string[]; writeScope?: DelegationTaskScope; verificationPlan?: VerificationPlan } = {},
): EffectiveTaskContract {
  return deepFreeze({
    contractId: `contract-legacy-${uuidv4()}`,
    version: TASK_CONTRACT_VERSION,
    proposedBy,
    compiledAt: new Date().toISOString(),
    objective: instruction.trim() || 'Legacy delegated task',
    expectedDeliverable: 'Return the concrete task result.',
    effects: {
      readFiles: [...new Set((options.readFiles ?? []).map(normalizeContractPath).filter(Boolean))],
      ...(options.writeScope ? { writeScope: options.writeScope } : {}),
      expectedFileEffect: options.writeScope ? 'mixed' : 'none',
    },
    inputs: [],
    constraints: [],
    dependencies: [],
    ...(options.verificationPlan ? { verificationPlan: options.verificationPlan } : {}),
    requiredCapabilities: { version: TASK_CAPABILITY_SCHEMA_VERSION, capabilities: [] },
    executionStrategy: 'delegate-required',
  });
}

function parseEffects(value: unknown, workspaceRoot?: string): { effects?: EffectiveTaskContract['effects']; error?: string } {
  if (!isRecord(value)) return { error: 'contract.effects must be an object.' };
  const extra = Object.keys(value).find((key) => !['read_files', 'write_scope', 'expected_file_effect'].includes(key));
  if (extra) return { error: `contract.effects contains unsupported field "${extra}".` };
  const readFiles = parsePathArray(value.read_files, 'contract.effects.read_files', 500, workspaceRoot);
  if (readFiles.error) return { error: readFiles.error };
  const fileEffect = value.expected_file_effect;
  if (fileEffect !== 'none' && fileEffect !== 'create' && fileEffect !== 'modify' && fileEffect !== 'delete' && fileEffect !== 'mixed') {
    return { error: 'contract.effects.expected_file_effect is required and must be none, create, modify, delete, or mixed.' };
  }
  const scope = parseTaskScope(value.write_scope, workspaceRoot);
  if (scope.error) return { error: scope.error };
  return { effects: { readFiles: readFiles.values!, ...(scope.scope ? { writeScope: scope.scope } : {}), expectedFileEffect: fileEffect } };
}

function parseInputs(value: unknown, workspaceRoot?: string): { inputs?: ContractInput[]; error?: string } {
  if (!Array.isArray(value)) return { error: 'contract.inputs must be an array.' };
  if (value.length > 100) return { error: 'contract.inputs may contain at most 100 entries.' };
  const inputs: ContractInput[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    if (!isRecord(value[index])) return { error: `contract.inputs[${index}] must be an object.` };
    const raw = value[index] as Record<string, unknown>;
    const rawKind = raw.kind;
    const common = ['input_id', 'kind', 'purpose', 'required', 'provenance', 'freshness'];
    const kindField = rawKind === 'contentAsset' ? 'asset_id' : rawKind === 'workspacePath' ? 'path' : rawKind === 'upstreamArtifact' ? 'artifact_id' : undefined;
    if (!kindField) return { error: `contract.inputs[${index}].kind is unsupported.` };
    const kind = rawKind as ContractInput['kind'];
    const extra = Object.keys(raw).find((key) => !common.includes(key) && key !== kindField);
    if (extra) return { error: `contract.inputs[${index}] contains unsupported field "${extra}".` };
    const inputId = typeof raw.input_id === 'string' ? raw.input_id.trim() : '';
    if (!INPUT_ID.test(inputId)) return { error: `contract.inputs[${index}].input_id is invalid.` };
    if (ids.has(inputId)) return { error: `contract.inputs repeats input_id "${inputId}".` };
    ids.add(inputId);
    const purpose = boundedText(raw.purpose, `contract.inputs[${index}].purpose`, 1, 1_000);
    if (purpose.error) return { error: purpose.error };
    if (typeof raw.required !== 'boolean') return { error: `contract.inputs[${index}].required must be boolean.` };
    const provenance = parseProvenance(raw.provenance, index);
    if (provenance.error) return { error: provenance.error };
    const base = { inputId, purpose: purpose.value!, required: raw.required, provenance: provenance.value! };
    if (kind === 'contentAsset') {
      if (typeof raw.asset_id !== 'string' || !CONTENT_ASSET_ID.test(raw.asset_id)) return { error: `contract.inputs[${index}].asset_id is invalid.` };
      if (raw.freshness !== 'attempt-start') return { error: `contentAsset input "${inputId}" freshness must be attempt-start.` };
      inputs.push({ ...base, kind, assetId: raw.asset_id, freshness: 'attempt-start' });
    } else if (kind === 'workspacePath') {
      const parsedPath = parseContractPath(raw.path, `contract.inputs[${index}].path`, workspaceRoot);
      if (parsedPath.error) return { error: parsedPath.error };
      if (raw.freshness !== 'current' && raw.freshness !== 'dispatch-snapshot') return { error: `workspacePath input "${inputId}" freshness must be current or dispatch-snapshot.` };
      inputs.push({ ...base, kind, path: parsedPath.value!, freshness: raw.freshness });
    } else {
      if (typeof raw.artifact_id !== 'string' || !ARTIFACT_ID.test(raw.artifact_id)) return { error: `contract.inputs[${index}].artifact_id is invalid.` };
      if (raw.freshness !== 'artifact-ready') return { error: `upstreamArtifact input "${inputId}" freshness must be artifact-ready.` };
      inputs.push({ ...base, kind, artifactId: raw.artifact_id, freshness: 'artifact-ready' });
    }
  }
  return { inputs };
}

function parseReview(
  value: unknown,
  inputs: readonly ContractInput[],
): { value?: { inputId: string }; error?: string } {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.input_id !== 'string') {
    return { error: 'contract.review must contain only input_id.' };
  }
  const inputId = value.input_id.trim();
  const input = inputs.find((candidate) => candidate.inputId === inputId);
  if (!INPUT_ID.test(inputId) || !input || !input.required || input.kind !== 'upstreamArtifact') {
    return { error: 'contract.review.input_id must name one required upstreamArtifact input in this contract.' };
  }
  return { value: { inputId } };
}

function parseConstraints(value: unknown, inputIds: Set<string>): { constraints?: EffectiveTaskContract['constraints']; error?: string } {
  if (!Array.isArray(value)) return { error: 'contract.constraints must be an array.' };
  if (value.length > 100) return { error: 'contract.constraints may contain at most 100 entries.' };
  const constraints: EffectiveTaskContract['constraints'] = [];
  for (let index = 0; index < value.length; index++) {
    if (!isRecord(value[index])) return { error: `contract.constraints[${index}] must be an object.` };
    const raw = value[index] as Record<string, unknown>;
    const extra = Object.keys(raw).find((key) => key !== 'text' && key !== 'basis_refs');
    if (extra) return { error: `contract.constraints[${index}] contains unsupported field "${extra}".` };
    const text = boundedText(raw.text, `contract.constraints[${index}].text`, 1, 2_000);
    if (text.error) return { error: text.error };
    const basis = raw.basis_refs === undefined ? { values: [] as string[] } : parseStringArray(raw.basis_refs, `contract.constraints[${index}].basis_refs`, 50, INPUT_ID);
    if (basis.error) return { error: basis.error };
    const unknown = basis.values!.find((ref) => !inputIds.has(ref));
    if (unknown) return { error: `contract constraint basis_ref "${unknown}" is not a declared input.` };
    constraints.push({ text: text.value!, basisRefs: basis.values! });
  }
  return { constraints };
}

function parseCoordinatorBrief(
  value: unknown,
  inputIds: Set<string>,
): { brief?: NonNullable<EffectiveTaskContract['coordinatorBrief']>; error?: string } {
  if (value === undefined) return {};
  if (!isRecord(value)) return { error: 'contract.coordinator_brief must be an object.' };
  const extra = Object.keys(value).find((key) => key !== 'text' && key !== 'basis_refs');
  if (extra) return { error: `contract.coordinator_brief contains unsupported field "${extra}".` };
  const text = boundedText(value.text, 'contract.coordinator_brief.text', 1, 4_000);
  if (text.error) return { error: text.error };
  const basis = value.basis_refs === undefined
    ? { values: [] as string[] }
    : parseStringArray(value.basis_refs, 'contract.coordinator_brief.basis_refs', 50, INPUT_ID);
  if (basis.error) return { error: basis.error };
  const unknown = basis.values!.find((ref) => !inputIds.has(ref));
  if (unknown) return { error: `contract coordinator_brief basis_ref "${unknown}" is not a declared input.` };
  return { brief: { text: text.value!, basisRefs: basis.values! } };
}

function parseRequiredCapabilities(value: unknown): { value?: EffectiveTaskContract['requiredCapabilities']; error?: string } {
  if (!isRecord(value)) return { error: 'contract.required_capabilities is mandatory and must be an object; no capability is inferred from prose.' };
  const extra = Object.keys(value).find((key) => key !== 'version' && key !== 'capabilities');
  if (extra) return { error: `contract.required_capabilities contains unsupported field "${extra}".` };
  if (value.version !== TASK_CAPABILITY_SCHEMA_VERSION) return { error: `contract.required_capabilities.version must be ${TASK_CAPABILITY_SCHEMA_VERSION}.` };
  if (!Array.isArray(value.capabilities)) return { error: 'contract.required_capabilities.capabilities must be an ordered array.' };
  const capabilities: TaskCapability[] = [];
  for (const capability of value.capabilities) {
    if (typeof capability !== 'string' || !CAPABILITY_SET.has(capability)) return { error: `unsupported required capability "${String(capability)}".` };
    if (capabilities.includes(capability as TaskCapability)) return { error: `required capability "${capability}" is repeated.` };
    capabilities.push(capability as TaskCapability);
  }
  return { value: { version: TASK_CAPABILITY_SCHEMA_VERSION, capabilities } };
}

function parseTaskScope(value: unknown, workspaceRoot?: string): { scope?: DelegationTaskScope; error?: string } {
  if (value === undefined || value === null) return {};
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'folder_access')) return { error: 'contract.effects.write_scope may contain only folder_access.' };
  if (!Array.isArray(value.folder_access) || value.folder_access.length === 0 || value.folder_access.length > 100) return { error: 'contract.effects.write_scope.folder_access must contain 1-100 entries.' };
  const folderAccess: DelegationTaskScope['folderAccess'] = [];
  for (let index = 0; index < value.folder_access.length; index++) {
    const entry = value.folder_access[index];
    if (!isRecord(entry) || Object.keys(entry).some((key) => key !== 'path' && key !== 'permission')) return { error: `contract.effects.write_scope.folder_access[${index}] is invalid.` };
    const parsedPath = parseContractPath(entry.path, `contract.effects.write_scope.folder_access[${index}].path`, workspaceRoot);
    if (parsedPath.error) return { error: parsedPath.error };
    if (entry.permission !== 'read' && entry.permission !== 'readwrite') return { error: `contract.effects.write_scope.folder_access[${index}].permission must be read or readwrite.` };
    folderAccess.push({ path: parsedPath.value!, permission: entry.permission });
  }
  return { scope: { folderAccess } };
}

function parseProvenance(value: unknown, index: number): { value?: TaskInputProvenance; error?: string } {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'kind' && key !== 'source_refs')) return { error: `contract.inputs[${index}].provenance must contain only kind and source_refs.` };
  if (value.kind !== 'user-turn' && value.kind !== 'workspace' && value.kind !== 'upstream-artifact' && value.kind !== 'coordinator-declared') return { error: `contract.inputs[${index}].provenance.kind is unsupported.` };
  const refs = value.source_refs === undefined ? { values: [] as string[] } : parseStringArray(value.source_refs, `contract.inputs[${index}].provenance.source_refs`, 50);
  if (refs.error) return { error: refs.error };
  return { value: { kind: value.kind, sourceRefs: refs.values! } };
}

function parsePathArray(value: unknown, label: string, max: number, workspaceRoot?: string): { values?: string[]; error?: string } {
  if (!Array.isArray(value)) return { error: `${label} must be an array.` };
  if (value.length > max) return { error: `${label} may contain at most ${max} entries.` };
  const values: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const parsed = parseContractPath(value[index], `${label}[${index}]`, workspaceRoot);
    if (parsed.error) return { error: parsed.error };
    if (!values.includes(parsed.value!)) values.push(parsed.value!);
  }
  return { values };
}

function parseStringArray(value: unknown, label: string, max: number, pattern?: RegExp): { values?: string[]; error?: string } {
  if (!Array.isArray(value)) return { error: `${label} must be an array.` };
  if (value.length > max) return { error: `${label} may contain at most ${max} entries.` };
  const values: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = typeof value[index] === 'string' ? value[index].trim() : '';
    if (!item || item.length > 500 || (pattern && !pattern.test(item))) return { error: `${label}[${index}] is invalid.` };
    if (values.includes(item)) return { error: `${label} repeats "${item}".` };
    values.push(item);
  }
  return { values };
}

function boundedText(value: unknown, label: string, min: number, max: number): { value?: string; error?: string } {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length < min || text.length > max ? { error: `${label} must contain ${min}-${max} characters.` } : { value: text };
}

function parseContractPath(value: unknown, label: string, workspaceRoot?: string): { value?: string; error?: string } {
  if (typeof value !== 'string') return { error: `${label} must be a workspace-relative path.` };
  const normalized = normalizeWorkspacePath(value, workspaceRoot);
  if (!normalized || normalized.length > 1_000) return { error: `${label} must stay inside the workspace and be relative.` };
  return { value: normalized };
}

/**
 * The single root-aware path normaliser for task contracts and delegated instruction text.  It accepts an
 * absolute spelling only when the host supplied a root and the resolved target stays below that root; all
 * emitted paths are workspace-relative and slash-normalised for portable contracts.
 */
export function normalizeWorkspacePath(value: string, workspaceRoot?: string): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  // `path` follows the current host, while contract fixtures may use Windows paths on a POSIX test host.
  const api = path.win32.isAbsolute(raw) || path.win32.isAbsolute(workspaceRoot ?? '') ? path.win32 : path;
  const root = workspaceRoot ? api.resolve(workspaceRoot) : undefined;
  const absolute = api.isAbsolute(raw);
  if (absolute && !root) return undefined;
  const candidate = root ? api.resolve(root, raw) : undefined;
  if (root && candidate) {
    const relative = api.relative(root, candidate);
    if (relative === '..' || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) return undefined;
    return normalizeContractPath(relative || '.');
  }
  const normalized = normalizeContractPath(raw);
  if (normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized || undefined;
}

/**
 * Rewrite only absolute path tokens rooted at this workspace.  Unlike the former textual prefix removal,
 * every replacement first passes through `normalizeWorkspacePath`, so a `..` escape or a prefix collision
 * remains untouched rather than being made to look like a permitted relative path.
 */
export function normalizeWorkspacePathsInInstruction(instruction: string, workspaceRoot?: string): string {
  const root = String(workspaceRoot ?? '').trim();
  if (!root) return instruction;
  const escapedRoot = [...root].map((character) => {
    if (character === '/' || character === '\\') return '[\\\\/]';
    return character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  const token = new RegExp(`${escapedRoot}(?:[\\\\/][^\\s"'<>\\[\\](){}]*)?`, 'g');
  return instruction.replace(token, (matched) => {
    const trailing = matched.match(/[.,;:]+$/)?.[0] ?? '';
    const candidate = trailing ? matched.slice(0, -trailing.length) : matched;
    const normalized = normalizeWorkspacePath(candidate, root);
    if (normalized === undefined) return matched;
    // Keep the spelling used in prose; contracts themselves remain slash-normalised above.
    const display = matched.includes('\\') ? normalized.replace(/\//g, '\\') : normalized;
    return `${display === '.' ? '' : display}${trailing}`;
  });
}

function normalizeContractPath(value: string): string {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

function pathCoveredByScope(target: string, scope: DelegationTaskScope, workspaceRoot?: string): boolean {
  const identityBase = path.resolve(workspaceRoot ?? path.parse(path.resolve('.')).root);
  const value = resolveWorkspacePathIdentity(identityBase, target) ?? path.resolve(identityBase, normalizeContractPath(target));
  return scope.folderAccess.some((grant) => {
    const normalizedRoot = normalizeContractPath(grant.path);
    if (normalizedRoot === '.') return true;
    const root = resolveWorkspacePathIdentity(identityBase, normalizedRoot) ?? path.resolve(identityBase, normalizedRoot);
    return isInside(root, value);
  });
}

/**
 * One filesystem-aware identity primitive for contract admission and read receipts. `realpath` preserves
 * the filesystem's own case semantics and collapses symlinks; missing paths deliberately have no physical
 * identity and callers may fall back to lexical containment where existence is not yet required.
 */
export function resolveWorkspacePathIdentity(pathBase: string, value: string): string | undefined {
  const candidate = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(pathBase, normalizeContractPath(value));
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

function samePhysicalPath(left: string, right: string): boolean {
  return path.relative(left, right) === '';
}

function isInside(root: string, absolute: string): boolean {
  const relative = path.relative(root, absolute);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function cloneArtifact(artifact: ReadyTaskArtifact): ReadyTaskArtifact {
  return {
    ...artifact,
    delegableByAgentIds: [...artifact.delegableByAgentIds],
    provenance: artifact.provenance.map((entry) => ({ ...entry })),
  };
}
