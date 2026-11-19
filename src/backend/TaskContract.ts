/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Task Contract and Input Resolver
 *
 *  A coordinator proposes structure; the host compiles an immutable contract and grants only the
 *  declared inputs to one concrete execution attempt.  This module is deliberately vscode-free so
 *  routing, dispatch, and security can share one decision instead of re-reading task prose.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { readFileSync, realpathSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { attemptHolder, extractWorkspaceDocument, hostReadMemoryBudget, userRequestHolder, type ContentAssetStore } from '../content/ContentAssetStore';
import { sniffContent } from '../contentSniff';
import type { DelegationTaskScope } from '../types';
import type { EffectiveExecutionIdentity } from '../session/EffectiveExecutionIdentity';
import type { ReviewPolicyPreflightDecision, ReviewPolicyDecisionCode } from '../policy/ReviewPolicyPreflight';
import {
  parseVerificationPlan,
  type VerificationPlan,
  type VerificationSensorKind,
} from './VerificationPlan';
import {
  closeReviewEvidence,
  contentDigestOf,
  parseReviewEvidenceSubmission,
  validateReviewEvidence,
  REVIEW_EVIDENCE_NOT_SUBMITTED,
  ReviewReceiptRegistry,
  reviewCloseRefusal,
  reviewTargetChangedFinding,
  type CheckedReviewSubmission,
  type ReviewEvidenceState,
  type ReviewReadReceipt,
} from './ReviewEvidence';
import {
  findingIdAt, MAX_FINDING_DISPOSITIONS, parseFindingRefText, storedCitationPath, storedStatement, type ReviewFindingRefV1,
  type ReviewRecheckV1, type ReviewReportCapture,
} from './ReviewFindings';
import { targetKey } from './fileWritePolicy';
import { readRegularFileInsideRoot, type RegularFileRead } from './workspacePath';
import type { DocumentDraftCustodian, SourceDigest } from './DocumentDraftCustody';
import { isPathInsideOrEqual } from './pathContainment';
import { reachesAnotherComputer } from '../host/namedOutsidePaths';
import {
  CHECKPOINT_ATTEMPT_ENDED,
  describeFinalCheck,
  formatDeliveryPlan,
  formatSavedBatches,
  parseCheckpointRequest,
  parseDeliveryPlan,
  type CheckpointAttemptSummary,
  type CheckpointRefusalReason,
  type IncrementalDeliveryPlan,
  type TaskCheckpointReceipt,
  type TaskCheckpointRecord,
  type TaskCheckpointStore,
} from './TaskCheckpoints';

export const TASK_CONTRACT_VERSION = 1 as const;
/** v0.9.101 (G1): version 2 adds only `outputs`; every other field keeps its version 1 meaning. */
export const TASK_CONTRACT_OUTPUTS_VERSION = 2 as const;
export const TASK_CAPABILITY_SCHEMA_VERSION = 1 as const;
export const TASK_CAPABILITIES = ['read', 'write', 'shell'] as const;
export type TaskCapability = typeof TASK_CAPABILITIES[number];
export type TaskExecutionStrategy = 'delegate-preferred' | 'delegate-required' | 'coordinator-only';
export type ExpectedFileEffect = 'none' | 'create' | 'modify' | 'delete' | 'mixed';
export type ContextGapReason = 'missing' | 'expired' | 'outside-task-scope' | 'unreadable';

/** Why the host dispatched a task again: once more on the same model, or on the agent's fallback model. */
export const RETRY_STAGES = ['firm-retry', 'fallback-model'] as const;
export type RetryStage = typeof RETRY_STAGES[number];

/**
 * The typed relation between a retry attempt and the attempt it retries. It is the only thing that makes two
 * dispatches one logical task: time, wording, model and agent identity never do.
 */
export interface RetryLink {
  retryOfHandle: string;
  retryStage: RetryStage;
}

/**
 * Why a stored or supplied link was not kept. The attempt then stands alone, and the reason stays visible as a
 * coverage gap; a rejected link is never repaired from anything else.
 */
export const RETRY_LINK_GAPS = [
  'half-pair', 'invalid-shape', 'self-link', 'missing-parent', 'cross-run', 'not-earlier', 'cycle', 'conflict',
] as const;
export type RetryLinkGap = typeof RETRY_LINK_GAPS[number];

export type RetryLinkParse =
  | { state: 'absent' }
  | { state: 'valid'; link: RetryLink }
  | { state: 'rejected'; gap: Extract<RetryLinkGap, 'half-pair' | 'invalid-shape'> };

const RETRY_HANDLE = /^[A-Za-z0-9._:-]{1,128}$/;
const RETRY_STAGE_SET = new Set<string>(RETRY_STAGES);

/** The pair as it was supplied: both fields or neither. One field alone is a half-pair and names no retry. */
export function parseRetryLink(raw: { retryOfHandle?: unknown; retryStage?: unknown } | undefined): RetryLinkParse {
  const handle = raw?.retryOfHandle;
  const stage = raw?.retryStage;
  if (handle === undefined && stage === undefined) return { state: 'absent' };
  if (handle === undefined || stage === undefined) return { state: 'rejected', gap: 'half-pair' };
  if (typeof handle !== 'string' || !RETRY_HANDLE.test(handle) || typeof stage !== 'string' || !RETRY_STAGE_SET.has(stage)) {
    return { state: 'rejected', gap: 'invalid-shape' };
  }
  return { state: 'valid', link: { retryOfHandle: handle, retryStage: stage as RetryStage } };
}

export function isRetryLinkGap(value: unknown): value is RetryLinkGap {
  return typeof value === 'string' && (RETRY_LINK_GAPS as readonly string[]).includes(value);
}

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

/**
 * v0.9.101 (G1): a result the task is to leave at `path`. A requirement, never a grant: it gives no write, widens no
 * scope and narrows no authority. Who may write it is decided by the host's existing authority and task scope.
 * `path` is workspace-relative, or absolute for a target outside the workspace, as a read file is.
 */
export interface PlannedOutput {
  outputId: string;
  path: string;
  kind: 'file' | 'directory';
  required: boolean;
}

/**
 * v0.9.101 (G1): why a parsable contract is not ready to dispatch. `requirementRef` names the requirement
 * (`output:<output_id>`); `reason` says what is wrong and who fixes it.
 */
export interface TaskReadinessIssue {
  requirementRef: string;
  code: 'invalid-task-scope';
  reason: string;
}

/** v0.9.101 (G1): what is at an absolute host path now, by metadata only. Nothing known: undefined. */
export type OutputTargetProbe = (absolute: string) => 'file' | 'directory' | undefined;

export interface EffectiveTaskContract {
  contractId: string;
  version: typeof TASK_CONTRACT_VERSION | typeof TASK_CONTRACT_OUTPUTS_VERSION;
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
  /** v0.9.101 (G1): present exactly on a version 2 contract, empty when it names none. */
  outputs?: PlannedOutput[];
  constraints: Array<{ text: string; basisRefs: string[] }>;
  /** Coordinator-authored orientation for a delegate. It is a claim, never host evidence. */
  coordinatorBrief?: { text: string; basisRefs: string[] };
  dependencies: string[];
  /**
   * Explicit relation only; the host never infers review intent from prose, roles or filenames. v0.9.106: `recheck`
   * names findings of earlier reviews ("<reviewHandle>#F<n>") this review checks again; `recheckOf` is the host's
   * resolution of them at dispatch, never written by a model.
   */
  review?: { inputId: string; recheck?: string[]; recheckOf?: ReviewFindingRefV1[] };
  /**
   * v0.9.106: findings of earlier reviews ("<reviewHandle>#F<n>") this task is dispatched to fix; `fixesOf` is the
   * host's resolution of them at dispatch, never written by a model.
   */
  fixes?: string[];
  fixesOf?: ReviewFindingRefV1[];
  verificationPlan?: VerificationPlan;
  requiredCapabilities: {
    version: typeof TASK_CAPABILITY_SCHEMA_VERSION;
    capabilities: TaskCapability[];
  };
  executionStrategy: TaskExecutionStrategy;
  /**
   * v0.9.97: present when the dispatcher chose delivery in batches. It is part of the claim like the rest of the
   * contract: it adds no capability, grant, budget or time, and it asks for no extra model call.
   */
  delivery?: IncrementalDeliveryPlan;
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
  /**
   * v0.9.97: an artifact a coordinator made from saved batches. `incomplete` stays on it, and on every task card
   * that is granted it, until a later task replaces it: partial work never reads as a finished deliverable.
   */
  partialWork?: { completeness: 'complete' | 'incomplete'; finalCheck: string };
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
  /**
   * v0.9.101 (A1): for each workspacePath input outside the workspace, by input id, whether this candidate can read it,
   * as the host projected it from the candidate's live authority just before this call. Absent: nobody could judge it.
   */
  outsideInputs?: Readonly<Record<string, OutsideInputAccess>>;
}

/**
 * v0.9.101 (A1): the host's answer for one outside input of one candidate. Having a read tool is not readability.
 * - `readable`: its authority reaches the file, which exists as a regular file; `physical` is where it is.
 * - `grant-needed`: nothing it may use reaches the file yet; a deliberate grant can. Never reported as a missing file.
 * - `explicit-limit`: the agent's own Folder Access is a ceiling no grant widens, and the file is outside it.
 * - `missing-input`: its authority reaches the path, and no regular file is there.
 * - `unavailable`: the host could not judge it, for `detail`.
 * `unprobed`: decided by the spelling alone. A share, device or `/net` path is not touched before a grant covers it.
 * `currentRead` (v0.9.101, T101-8): the UnodeAi file tool this candidate itself reads the file with during its task,
 * and which checks, at that read, the access the host counted here. Host readability is a host fact: it lets the host
 * take a dispatch snapshot, and is no proof that the teammate's own tools reach the file. Absent: no such tool, so a
 * `current` input cannot be read under this access, and only a snapshot delivers it.
 */
export type OutsideInputAccess =
  | { status: 'readable'; physical: string; currentRead?: OutsideCurrentRead }
  | { status: 'grant-needed' | 'explicit-limit' | 'missing-input' | 'unavailable'; detail?: string; unprobed?: true };

/**
 * v0.9.101 (T101-8): the teammate's own file tool for an outside `current` input. `host-file-tools`: an
 * OpenAI-compatible agent's file tools are the host's. `files-bridge`: a Claude agent's UnodeAi files bridge, whose
 * read_file the host serves; Claude's native Read is not checked against a host grant.
 */
export type OutsideCurrentRead = 'host-file-tools' | 'files-bridge';

/**
 * v0.9.101 (G1): the host's answer for one outside output of one agent, as for an input but for write. A read grant,
 * or Full access the agent does not have, never makes it `writable`. An output need not exist yet, so nothing is
 * reported missing. `unprobed`: decided by the spelling alone, as for an input.
 */
export type OutsideOutputAccess =
  | { status: 'writable' }
  | { status: 'grant-needed' | 'explicit-limit' | 'unavailable'; detail?: string; unprobed?: true };

export interface PreflightInputDecision {
  inputId: string;
  kind: ContractInput['kind'];
  sourceRef: string;
  resolvedContentAssetId?: string;
  partialWork?: ReadyTaskArtifact['partialWork'];
}

export interface PreflightFailure {
  filter: 'permissions' | 'task-scope' | 'input-grant' | 'dependency' | 'verification-sensor'
    | 'grant-needed' | 'explicit-limit' | 'missing-input' | 'read-route';
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
  /** v0.9.97: the granted artifact is partial work made from saved batches; its final check is shown with it. */
  partialWork?: ReadyTaskArtifact['partialWork'];
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
  /** Optional snapshot inputs not passed on because their text cannot be read (Codex audit of ff2dcae4). */
  unreadableOptionalInputs?: string[];
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

/** v0.9.97: the host's answer to one save_task_checkpoint call. */
export type CheckpointToolResult =
  | { status: 'saved'; receipt: TaskCheckpointReceipt }
  | { status: 'refused'; reason: CheckpointRefusalReason | 'no-attempt' | 'not-incremental'; message: string };

/** Who hears about saved batches: the live progress of the attempt, and the reminder that one is due. */
export interface CheckpointObservers {
  saved?(attemptId: string, receipt: TaskCheckpointReceipt): void;
  due?(attemptId: string): string | undefined;
}

interface LiveTaskAttempt {
  card: TaskAttemptCard;
  coordinatorId: string;
  state: 'live' | 'cancelled' | 'settled' | 'interrupted';
  startedAt: string;
  /** v0.9.97: the delegation handle that carries this attempt, once the dispatch has one. */
  handle?: string;
  gapRecords: Array<{ gap: TaskContextGap; observationRevision: number }>;
  inputObservations: Map<string, InputAccessObservation>;
  nextObservationRevision: number;
  /** Host-private physical identities for workspace inputs. Never copy these into TaskAttemptCard. */
  workspacePathBase: string;
  workspacePathIdentities: Map<string, string>;
  workspaceLexicalPaths: Map<string, string>;
  /** v0.9.94: the receipts of the tools serving this attempt's reads and searches, while it is live. */
  reviewReceipts?: ReviewReceiptRegistry;
  /** v0.9.94: what closing this review recorded. Kept after settlement, like the grants. */
  reviewEvidence?: ReviewEvidenceState;
  /** v0.9.95: present exactly when the marked review is of a workspace file. Never copy it into TaskAttemptCard. */
  reviewTarget?: WorkspaceReviewTargetBinding;
  /**
   * v0.9.106: the numbered findings of the last successful close with evidence, while the attempt is live. A refused
   * close or a close without evidence leaves it; the attempt's end clears it. Host-private, in memory only.
   */
  reviewReport?: ReviewReportCapture;
  /**
   * v0.9.101 (H2b): per required file input, the SHA-256 of the exact bytes the host first read of it in this attempt,
   * with the physical file it read. Host-private; kept after the attempt ends.
   */
  sourceDigests: Map<string, SourceDigest>;
  /** v0.9.101 (H2b): the file tools that hold this attempt's document drafts. Host-private. */
  draftCustodian?: DocumentDraftCustodian;
}

/**
 * v0.9.95, host-private: the workspace file a marked review is a review of, as it was when the review was
 * dispatched. `contentDigest` is over the exact bytes the file had then. Closing the review compares the file with
 * this, so a change made after dispatch is seen whoever made it. No task card, grant or evidence record is built
 * from it.
 */
interface WorkspaceReviewTargetBinding {
  inputId: string;
  lexicalPath: string;
  physicalPath: string;
  contentDigest: string;
  capturedAt: string;
}

interface ReviewAdmissionReceipt {
  decision: ReviewPolicyPreflightDecision;
}

/**
 * v0.9.102 (R4): the file a review of a workspace file was dispatched for no longer has that content when the review
 * settles. `detail` is the host's sentence for what changed; it names the review input, never a path or a digest.
 */
export interface ReviewTargetChangeAtSettlement {
  inputId: string;
  detail: string;
  /** One of the file changes the host recorded for the reviewing attempt is the file under review. */
  changedByTeammate: boolean;
}

/**
 * v0.9.94: the answer to closing a review with or without evidence. `no-admitted-review` means the attempt is not
 * a live, admitted review held by that agent, so there is nothing review evidence could belong to. `refused`
 * recorded nothing: `reason` is the text of the failed call and `finding` the same without its failure mark, for
 * a caller that goes on and reports it. `unchanged` marks a close without evidence that left earlier checked
 * evidence in place.
 */
export type ReviewAssignmentClose =
  | { status: 'no-admitted-review' }
  | { status: 'refused'; reason: string; finding: string }
  | { status: 'closed'; evidence: ReviewEvidenceState; unchanged?: true };

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
  /**
   * v0.9.101 (G1): how an output's existing target is observed, only when `workspaceRoot` is given. Replaced by tests.
   */
  probeOutputTarget: OutputTargetProbe = observeOutputTarget,
): TaskContractParseResult {
  return compileContract(rawValue, proposedBy, workspaceRoot, probeOutputTarget, 'name');
}

/**
 * v0.9.101 (audit R1): re-parse a contract the host compiled and stored, by the same strict rules, with no workspace and
 * no disk. A stored path is either workspace-relative or, for a file outside the workspace, the absolute spelling the
 * compiler resolved; such an absolute path is accepted only in exactly that canonical spelling. Until now a stored outside
 * input or output made the whole contract fail to parse, and a reload dropped it. Nothing is read, probed or granted.
 */
export function restoreStoredTaskContract(rawValue: unknown, proposedBy: string): TaskContractParseResult {
  return compileContract(rawValue, proposedBy, undefined, () => undefined, 'stored');
}

/** How a contract path outside the workspace is taken: named (needs the host root), refused, or a stored canonical one. */
type OutsideContractPath = 'name' | 'refuse' | 'stored';

function compileContract(
  rawValue: unknown,
  proposedBy: string,
  workspaceRoot: string | undefined,
  probeOutputTarget: OutputTargetProbe,
  outside: Exclude<OutsideContractPath, 'refuse'>,
): TaskContractParseResult {
  if (!isRecord(rawValue)) {
    return { error: 'contract is required and must be an object.' };
  }
  const raw = rawValue;
  const withOutputs = raw.version === TASK_CONTRACT_OUTPUTS_VERSION;
  const allowed = new Set([
    'version', 'objective', 'expected_deliverable', 'effects', 'inputs', 'constraints',
    'coordinator_brief', 'dependencies', 'review', 'verification_plan', 'required_capabilities', 'execution_strategy',
    'delivery', 'fixes', ...(withOutputs ? ['outputs'] : []),
  ]);
  const extra = Object.keys(raw).find((key) => !allowed.has(key));
  if (extra) {
    return { error: `contract contains unsupported field "${extra}".${extra === 'outputs' ? ' contract.outputs needs contract.version 2.' : ''}` };
  }
  if (raw.version !== TASK_CONTRACT_VERSION && !withOutputs) {
    return { error: `contract.version must be ${TASK_CONTRACT_VERSION} or ${TASK_CONTRACT_OUTPUTS_VERSION}.` };
  }
  const objective = boundedText(raw.objective, 'contract.objective', 1, 4_000);
  if (objective.error) return { error: objective.error };
  const deliverable = raw.expected_deliverable === undefined
    ? { value: '' }
    : boundedText(raw.expected_deliverable, 'contract.expected_deliverable', 1, 4_000);
  if (deliverable.error) return { error: deliverable.error };

  const declaredEffects = parseEffects(raw.effects, workspaceRoot, outside);
  if (declaredEffects.error) return { error: declaredEffects.error };
  const inputs = parseInputs(raw.inputs, workspaceRoot, outside);
  if (inputs.error) return { error: inputs.error };
  const effects = withOutsideInputReads(declaredEffects.effects!, inputs.inputs!, workspaceRoot);
  if (effects.error) return { error: effects.error };
  const outputs = withOutputs ? parseOutputs(raw.outputs === undefined ? [] : raw.outputs, workspaceRoot, probeOutputTarget, outside) : {};
  if (outputs.error) return { error: outputs.error };
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
  const fixes = parseFindingRefList(raw.fixes, 'contract.fixes');
  if (fixes.error) return { error: fixes.error };

  const requiredCapabilities = parseRequiredCapabilities(raw.required_capabilities);
  if (requiredCapabilities.error) return { error: requiredCapabilities.error };
  const declaredCapabilities = new Set(requiredCapabilities.value!.capabilities);
  const needsRead = effects.effects!.readFiles.length > 0
    || inputs.inputs!.length > 0
    || effects.effects!.writeScope?.folderAccess.some((entry) => entry.permission === 'read') === true;
  const needsWrite = effects.effects!.expectedFileEffect !== 'none'
    || effects.effects!.writeScope?.folderAccess.some((entry) => entry.permission === 'readwrite') === true
    || (outputs.outputs?.length ?? 0) > 0;
  if (needsRead && !declaredCapabilities.has('read')) {
    return { error: 'contract.required_capabilities.capabilities must explicitly declare "read" for the declared inputs or read effects.' };
  }
  if (needsWrite && !declaredCapabilities.has('write')) {
    return { error: `contract.required_capabilities.capabilities must explicitly declare "write" for the declared file effects${outputs.outputs?.length ? ' and outputs' : ''}; the host will not infer or add it.` };
  }
  const verification = parseVerificationPlan(raw.verification_plan);
  if (verification.error) return { error: `invalid contract verification plan. ${verification.error}` };
  const strategy = raw.execution_strategy === undefined ? 'delegate-preferred' : raw.execution_strategy;
  if (strategy !== 'delegate-preferred' && strategy !== 'delegate-required' && strategy !== 'coordinator-only') {
    return { error: 'contract.execution_strategy must be delegate-preferred, delegate-required, or coordinator-only.' };
  }
  const delivery = parseDeliveryPlan(raw.delivery);
  if (delivery.error) return { error: delivery.error };

  const contract: EffectiveTaskContract = {
    contractId: `contract-${uuidv4()}`,
    version: withOutputs ? TASK_CONTRACT_OUTPUTS_VERSION : TASK_CONTRACT_VERSION,
    proposedBy,
    compiledAt: new Date().toISOString(),
    objective: objective.value!,
    expectedDeliverable: deliverable.value!,
    effects: effects.effects!,
    inputs: inputs.inputs!,
    ...(outputs.outputs ? { outputs: outputs.outputs } : {}),
    constraints: constraints.constraints!,
    ...(coordinatorBrief.brief ? { coordinatorBrief: coordinatorBrief.brief } : {}),
    dependencies: dependencies.values!,
    ...(review.value ? { review: review.value } : {}),
    ...(fixes.values?.length ? { fixes: fixes.values } : {}),
    ...(verification.plan ? { verificationPlan: verification.plan } : {}),
    requiredCapabilities: requiredCapabilities.value!,
    executionStrategy: strategy,
    ...(delivery.plan ? { delivery: delivery.plan } : {}),
  };
  return { contract: deepFreeze(contract) };
}

/**
 * v0.9.101 (G1): what keeps a parsable contract from being dispatched, before any teammate is judged. When the
 * contract carries a task scope, every required output must lie inside a readwrite entry of it, as that entry is
 * resolved: a scope is the teammate's whole file reach, so an output outside its write part could never be written.
 * The output is not intersected away and the scope is not widened: the coordinator fixes its scope. Without a scope
 * the teammate's own authority applies, and outputs narrow nothing. Optional outputs are never an issue.
 */
export function taskReadinessIssues(contract: EffectiveTaskContract, workspaceRoot?: string): TaskReadinessIssue[] {
  const scope = contract.effects.writeScope;
  if (!scope) return [];
  const writable = scope.folderAccess.filter((entry) => entry.permission === 'readwrite');
  return (contract.outputs ?? []).flatMap((output) => {
    if (!output.required) return [];
    const target = contractPathApi(output.path, workspaceRoot).resolve(workspaceRoot ?? '', output.path);
    if (scopeEntryCovers(writable, target, workspaceRoot)) return [];
    return [{
      requirementRef: `output:${output.outputId}`,
      code: 'invalid-task-scope' as const,
      reason: `required output "${output.outputId}" (${output.path}) is not inside a readwrite entry of `
        + 'contract.effects.write_scope, so the teammate could not write it. Add a readwrite entry that holds it, or leave '
        + 'write_scope out so the teammate\'s own access applies. The host neither widens the scope nor drops the output',
    }];
  });
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
      // v0.9.101 (A1): a read tool is not readability. An outside file is judged by the host's projection of this
      // candidate's live authority; a task scope already holds it as read (see withOutsideInputReads).
      if (isOutsideContractPath(input.path)) {
        const access = candidateAgent.outsideInputs?.[input.inputId];
        if (access?.status !== 'readable') {
          if (input.required) failures.push(outsideInputFailure(input, access));
          continue;
        }
        // v0.9.101 (T101-8): a current input is read by the teammate itself, during its task. The host reading it is
        // not enough: the teammate needs a tool of its own that reads it under this access.
        if (input.freshness === 'current' && !access.currentRead) {
          if (input.required) failures.push(currentReadRouteFailure(input));
          continue;
        }
        decisions.push({ inputId: input.inputId, kind: input.kind, sourceRef: input.path });
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
      ...(artifact.partialWork ? { partialWork: { ...artifact.partialWork } } : {}),
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
  /** v0.9.97: where saved batches are kept. Without it a task that delivers in batches is told it cannot save. */
  private checkpoints?: TaskCheckpointStore;
  private checkpointObservers: CheckpointObservers = {};

  constructor(
    private readonly contentAssets: ContentAssetStore,
    private readonly workspaceRoot: string | (() => string | undefined),
    /** How a dispatch snapshot is read. Replaced only by tests that change the filesystem mid-read. */
    private readonly readSnapshot: (root: string, candidate: string, maxBytes: number) => Promise<RegularFileRead>
      = readRegularFileInsideRoot,
  ) {}

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
    // Snapshots this attempt stored. An attempt that is not started keeps none of them: a later input's refusal
    // must not leave an earlier input's snapshot behind. Assets the contract only names are never touched.
    const createdSnapshots: string[] = [];
    let started = false;
    try {
      const outcome = await this.materialiseAttempt(contract, candidate, coordinatorId, preflight, attemptId, createdSnapshots);
      started = outcome.card !== undefined;
      return outcome;
    } finally {
      if (!started) {
        if (this.liveAttemptByContract.get(contract.contractId) === attemptId) {
          this.liveAttemptByContract.delete(contract.contractId);
        }
        this.contentAssets.release(attemptHolder(attemptId));
        for (const assetId of createdSnapshots) {
          this.contractManagedContentAssets.delete(assetId);
          await this.contentAssets.discard(assetId);
        }
      }
    }
  }

  private async materialiseAttempt(
    contract: EffectiveTaskContract,
    candidate: CandidateContractAgent,
    coordinatorId: string,
    preflight: TaskPreflightResult,
    attemptId: string,
    createdSnapshots: string[],
  ): Promise<{ card?: TaskAttemptCard; error?: string }> {
    const abort = (error: string): { error: string } => ({ error });
    const now = new Date().toISOString();
    const grants: InputGrant[] = [];
    const configuredRoot = (() => {
      try {
        return typeof this.workspaceRoot === 'function' ? this.workspaceRoot() : this.workspaceRoot;
      } catch {
        return undefined;
      }
    })();
    const selectedRoot = candidate.workspaceRoot ?? configuredRoot;
    if (!selectedRoot?.trim()) {
      return abort('task-scope: no workspace folder is bound; the assignment was not started');
    }
    const workspacePathBase = path.resolve(selectedRoot);
    // v0.9.101 (A1): an outside input reaches here only when preflight found this candidate able to read it; where.
    const outsideReadable = new Map<string, string>();
    for (const decision of preflight.decisions) {
      const access = candidate.outsideInputs?.[decision.inputId];
      if (decision.kind === 'workspacePath' && isOutsideContractPath(decision.sourceRef) && access?.status === 'readable') {
        outsideReadable.set(decision.inputId, access.physical);
      }
    }
    const reviewTarget = bindWorkspaceReviewTarget(contract, workspacePathBase, now, outsideReadable);
    if (reviewTarget.error) return abort(reviewTarget.error);
    const workspacePathIdentities = new Map<string, string>();
    const workspaceLexicalPaths = new Map<string, string>();
    const sourceDigests = new Map<string, SourceDigest>();
    const unreadableOptionalInputs: string[] = [];
    for (const decision of preflight.decisions) {
      const input = contract.inputs.find((candidateInput) => candidateInput.inputId === decision.inputId)!;
      let resolvedContentAssetId = decision.resolvedContentAssetId;
      const outsidePhysical = outsideReadable.get(input.inputId);
      if (input.kind === 'workspacePath') {
        workspaceLexicalPaths.set(input.inputId, path.resolve(workspacePathBase, input.path));
        const identity = outsidePhysical ?? resolveWorkspacePathIdentity(workspacePathBase, input.path);
        if (identity) workspacePathIdentities.set(input.inputId, identity);
      }
      if (input.kind === 'workspacePath' && input.freshness === 'dispatch-snapshot') {
        // The attempt's workspace is the authority: the snapshot reads only a regular file physically inside it,
        // which the delegate could read itself. A write scope covering the path grants no read.
        // v0.9.99: no store or preview limit decides whether a required snapshot is taken. The copy is the file as it
        // is at dispatch, kept on disk and immutable, and read in pages; only a file this window cannot hold in memory
        // at once is refused, as a real resource error.
        // v0.9.101 (A1): an outside file is read through the same reader, below the folder that holds it where the host
        // found this teammate's live authority reaching it, and only when it is still that very file: the old
        // inside-root read would refuse a source admission had just found readable.
        const read = outsidePhysical
          ? await this.readSnapshot(path.dirname(outsidePhysical), outsidePhysical, hostReadMemoryBudget())
          : await this.readSnapshot(workspacePathBase, input.path, hostReadMemoryBudget());
        if (read.status !== 'read') {
          return abort(snapshotRefusal(input.inputId, read.reason, !!outsidePhysical));
        }
        if (outsidePhysical && !samePhysicalPath(read.physicalPath, outsidePhysical)) {
          return abort(snapshotRefusal(input.inputId, 'scope', true));
        }
        // v0.9.101 (H2b): the dispatch snapshot is the host's first read of this source in the attempt: its exact bytes.
        if (input.required) sourceDigests.set(input.inputId, { inputId: input.inputId, physical: read.physicalPath, sha256: sha256Of(read.bytes) });
        // Smoke of 81f50826: the snapshot carries the text read_file would show, never a binary file's bytes decoded.
        const text = await snapshotText(read.bytes);
        // Codex audit of ff2dcae4: an optional input whose text cannot be read is left out, and the card says so; the
        // rest of the task goes ahead. Only a required one stops the dispatch.
        if (text === undefined && !input.required) {
          unreadableOptionalInputs.push(input.inputId);
          continue;
        }
        if (text === undefined) return abort(snapshotNotText(input.inputId));
        const stored = await this.contentAssets.storeText(text, 'turn-supplied');
        createdSnapshots.push(stored.assetId);
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
        ...(decision.partialWork ? { partialWork: { ...decision.partialWork } } : {}),
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
    // v0.9.99: the attempt holds every source it was granted while it runs, however long that is.
    this.contentAssets.retain(
      grants.flatMap((grant) => grant.resolvedContentAssetId ? [grant.resolvedContentAssetId] : []),
      attemptHolder(attemptId),
    );
    const card: TaskAttemptCard = deepFreeze({
      attemptId,
      contractId: contract.contractId,
      agentId: candidate.agentId,
      contract,
      grants,
      baselineWorkspaceAuthority: contract.effects.writeScope
        ? 'narrowed-by-contract-scope'
        : 'independent-agent-authority',
      ...(unreadableOptionalInputs.length ? { unreadableOptionalInputs } : {}),
    });
    this.attempts.set(attemptId, {
      card,
      coordinatorId,
      state: 'live',
      startedAt: now,
      gapRecords: [],
      inputObservations: new Map(),
      nextObservationRevision: 1,
      workspacePathBase,
      workspacePathIdentities,
      workspaceLexicalPaths,
      ...(reviewTarget.binding ? { reviewTarget: reviewTarget.binding } : {}),
      sourceDigests,
    });
    return { card };
  }

  /**
   * `cause` says why a cancellation happened when it was not a stop: the attempt's result windows closed. Saved
   * batches record that apart from a stop, because only a stopped task's draft is the person's alone to recover.
   */
  endAttempt(attemptId: string, state: 'cancelled' | 'settled' | 'interrupted', cause?: 'late-window-closed'): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state !== 'live') return;
    attempt.state = state;
    if (attempt.card.contract.delivery && this.checkpoints) {
      const summary = this.requiredInputReadSummary(attemptId);
      void this.checkpoints.attemptEnded(
        attemptId,
        state === 'cancelled' && cause === 'late-window-closed' ? 'window-closed' : state,
        summary?.requiredInputReadNotObservedCount,
      ).catch(() => undefined);
    }
    attempt.workspacePathIdentities.clear();
    attempt.workspaceLexicalPaths.clear();
    // v0.9.94: an attempt that is over can no longer be closed, so it lets go of its tools' receipts. What closing
    // it recorded stays readable.
    attempt.reviewReceipts = undefined;
    // The file a review was bound to is only ever compared when that review is closed.
    attempt.reviewTarget = undefined;
    // v0.9.106: its numbered findings were read at settlement, while it was live; a later reader gets none.
    attempt.reviewReport = undefined;
    this.liveAttemptByContract.delete(attempt.card.contractId);
    this.attemptExecutionIdentities.delete(attemptId);
    // v0.9.99: an attempt that is over lets go of its sources; each stays while anything else still holds it.
    this.contentAssets.release(attemptHolder(attemptId));
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

  /**
   * v0.9.94: the review relation of an attempt the host admitted, for the agent that holds it. A marked review
   * counts only while its attempt is live and the review policy's decision for it was recorded as allowed; the
   * host never infers a review from a role, a file name or prose.
   */
  admittedReview(attemptId: string, agentId: string): { inputId: string } | undefined {
    const attempt = this.attempts.get(attemptId);
    const review = attempt?.card.contract.review;
    if (!attempt || attempt.state !== 'live' || attempt.card.agentId !== agentId || !review) return undefined;
    return this.reviewAdmissions.get(attemptId)?.decision.allowed === true ? { ...review } : undefined;
  }

  /**
   * v0.9.94: name the receipts that belong to this attempt: those of the tool surface that serves its reads and
   * searches. That surface empties them when another attempt or turn begins, so a view shown earlier can never
   * be cited here. A stale or foreign attempt binds nothing.
   */
  /**
   * v0.9.106: the receipts bound to a live attempt for the agent that holds it, so a later turn's tool surface continues
   * them by reference. Nothing for an attempt that has ended or belongs to another agent.
   */
  liveReviewReceipts(attemptId: string, agentId: string): ReviewReceiptRegistry | undefined {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state !== 'live' || attempt.card.agentId !== agentId) return undefined;
    return attempt.reviewReceipts;
  }

  bindReviewReceipts(attemptId: string, agentId: string, receipts: ReviewReceiptRegistry): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state !== 'live' || attempt.card.agentId !== agentId) return;
    attempt.reviewReceipts = receipts;
  }

  /**
   * v0.9.94: close an admitted review, with evidence or without. Evidence is checked against the receipts bound to
   * this attempt and to no other. This reads and records only; it grants no read, write, command, network or
   * approval authority, and it is the single place both callers of `close_assignment` reach.
   *
   * v0.9.95: a review of a workspace file is closed only while that file is still what the review was dispatched
   * for. The host reads the file again here instead of trusting that every change went through its own tools, so
   * an edit made in an editor or by another process refuses the close as well. Nothing yields between that read
   * and the record, and a refusal leaves whatever an earlier close recorded as it is.
   */
  closeReviewAssignment(attemptId: string, agentId: string, rawEvidence: unknown): ReviewAssignmentClose {
    if (!this.admittedReview(attemptId, agentId)) return { status: 'no-admitted-review' };
    const attempt = this.attempts.get(attemptId)!;
    const target = attempt.reviewTarget;
    const changed = target && reviewTargetChange(target);
    if (changed) return { status: 'refused', ...reviewCloseRefusal(reviewTargetChangedFinding(changed)) };
    const closed = closeReviewEvidence(rawEvidence, attempt.reviewReceipts ?? new ReviewReceiptRegistry(), target && {
      contentDigest: target.contentDigest,
      isViewOfTarget: (receipt) => isViewOfReviewTarget(target, receipt),
    });
    if (!closed.ok) return { status: 'refused', reason: closed.reason, finding: closed.finding };
    // v0.9.106: the rechecks this review was dispatched for, checked like findings. A refusal records nothing.
    const rechecks = closed.checked ? this.checkedRechecks(attempt, closed.checked.rechecks) : { rechecks: undefined };
    if ('error' in rechecks) return { status: 'refused', ...reviewCloseRefusal(rechecks.error) };
    // Closing again without evidence does not withdraw evidence whose citations the host already checked for this attempt.
    if (closed.state.state === 'not-submitted' && attempt.reviewEvidence?.state === 'citations-checked') {
      return { status: 'closed', evidence: attempt.reviewEvidence, unchanged: true };
    }
    attempt.reviewEvidence = closed.state;
    // v0.9.106: the findings this close used, numbered by the host. A close without evidence keeps the earlier ones.
    if (closed.state.state === 'citations-checked' && closed.checked) {
      attempt.reviewReport = this.reviewCapture(attempt, closed.checked, rechecks.rechecks);
    }
    return { status: 'closed', evidence: closed.state };
  }

  /** v0.9.106: the capture of one successful close: host numbers, redacted text, the host's identities. */
  /**
   * v0.9.106: `review_evidence.rechecks`, against the findings this review was dispatched to recheck. Each names one of
   * them once, says resolved or unresolved, and cites lines like a finding does: receipts of this attempt, the file
   * as it was dispatched. Resolved needs a citation. Nothing outside the dispatched list, and nothing unchecked.
   */
  private checkedRechecks(attempt: LiveTaskAttempt, raw: unknown): { rechecks: ReviewRecheckV1[] | undefined } | { error: string } {
    if (raw === undefined) return { rechecks: undefined };
    const review = attempt.card.contract.review;
    const declared = review?.recheck ?? [];
    const resolvedRefs = review?.recheckOf ?? [];
    if (!Array.isArray(raw) || raw.length > declared.length) {
      return { error: `review_evidence.rechecks must list the findings this review was dispatched to recheck${declared.length ? ` (${declared.join(', ')})` : ' (none)'}, each once.` };
    }
    const rechecks: ReviewRecheckV1[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of raw.entries()) {
      const at = `recheck ${index + 1}`;
      const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined;
      const finding = typeof record?.finding === 'string' ? record.finding.trim() : '';
      const position = declared.indexOf(finding);
      if (!record || position < 0 || seen.has(finding) || !resolvedRefs[position]) {
        return { error: `${at}: finding must be one of ${declared.join(', ') || 'none'}, each once.` };
      }
      seen.add(finding);
      if (record.status !== 'resolved' && record.status !== 'unresolved') return { error: `${at}: status must be "resolved" or "unresolved".` };
      const citations = Array.isArray(record.citations) ? record.citations : record.citations === undefined ? [] : undefined;
      if (!citations) return { error: `${at}: citations must be an array.` };
      if (record.status === 'resolved' && citations.length === 0) {
        return { error: `${at}: a resolved recheck needs at least one citation to lines you read with line_numbers: true.` };
      }
      const target = attempt.reviewTarget;
      const parsed = parseReviewEvidenceSubmission({ schemaVersion: 1, coverage: 'partial', searches: [],
        findings: [{ classification: citations.length ? 'observed' : 'inferred', statement: finding, citations }] });
      const validated = parsed.ok ? validateReviewEvidence(parsed.submission, attempt.reviewReceipts ?? new ReviewReceiptRegistry(),
        target && { contentDigest: target.contentDigest, isViewOfTarget: (receipt) => isViewOfReviewTarget(target, receipt) }) : parsed;
      if (!validated.ok) return { error: `${at}: ${validated.reason.replace(/^finding 1, /, '')}` };
      // A resolved recheck rests on the file it was bound to: at least one citation must be of a view, in this attempt,
      // of that file with the bytes it was dispatched for. Other files may be cited beside it, never instead of it.
      if (record.status === 'resolved' && parsed.ok && !parsed.submission.findings[0].citations.some((citation) => {
        const receipt = attempt.reviewReceipts?.read(citation.readReceiptId);
        return !!target && !!receipt && isViewOfReviewTarget(target, receipt) && receipt.contentDigest === target.contentDigest;
      })) {
        return { error: `${at}: a resolved recheck must cite lines of the file under review (input "${review?.inputId ?? 'none'}"), `
          + 'read with read_file and line_numbers: true in this task. Citations of other files may go beside it, not instead of it. '
          + 'Read that file and cite it, or report this finding as unresolved.' };
      }
      rechecks.push({ of: resolvedRefs[position], status: record.status, citations: parsed.ok
        ? parsed.submission.findings[0].citations.map((citation) => ({
          path: storedCitationPath(attempt.reviewReceipts?.read(citation.readReceiptId)?.path ?? citation.path),
          startLine: citation.startLine, endLine: citation.endLine })) : [] });
    }
    return { rechecks };
  }

  private reviewCapture(attempt: LiveTaskAttempt, checked: CheckedReviewSubmission, rechecks?: ReviewRecheckV1[]): ReviewReportCapture {
    const admission = this.reviewAdmissions.get(attempt.card.attemptId)!.decision;
    const target = attempt.reviewTarget;
    return {
      reviewSetId: `review-set-${uuidv4()}`,
      review: {
        attemptId: attempt.card.attemptId,
        reviewerAgentId: attempt.card.agentId,
        admission: { policyId: admission.policyId, code: admission.code },
        ...(target ? { target: { inputId: target.inputId, lexicalPath: target.lexicalPath, contentDigest: target.contentDigest,
          capturedAt: target.capturedAt, key: targetKey(target.physicalPath) } } : {}),
        dispatchedAt: attempt.startedAt,
        closedAt: new Date().toISOString(),
        ...(attempt.card.contract.review?.recheckOf?.length ? { recheckOf: structuredClone(attempt.card.contract.review.recheckOf) } : {}),
      },
      coverage: checked.coverage,
      findings: checked.findings.map((finding, index) => ({
        findingId: findingIdAt(index),
        classification: finding.classification,
        statement: storedStatement(finding.statement),
        citations: finding.citations.map((citation) => ({ ...citation, path: storedCitationPath(citation.path) })),
      })),
      ...(rechecks?.length ? { rechecks } : {}),
    };
  }

  /**
   * v0.9.106: the numbered findings of an admitted review, only while its attempt is live. A rework reply reads the
   * attempt after it settled and so never gets them: a reply to a rework request is never a new review.
   */
  reviewReportForAttempt(attemptId: string): ReviewReportCapture | undefined {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state !== 'live' || this.reviewAdmissions.get(attemptId)?.decision.allowed !== true) return undefined;
    return attempt.reviewReport ? structuredClone(attempt.reviewReport) : undefined;
  }

  /**
   * v0.9.94: the review-evidence fact of an admitted review attempt, live or settled. A review that was never
   * closed, or was closed without evidence, is `not-submitted`. An attempt that is not an admitted review has no
   * such fact at all.
   */
  reviewEvidenceForAttempt(attemptId: string): ReviewEvidenceState | undefined {
    const attempt = this.attempts.get(attemptId);
    if (!attempt?.card.contract.review || this.reviewAdmissions.get(attemptId)?.decision.allowed !== true) return undefined;
    return attempt.reviewEvidence ?? REVIEW_EVIDENCE_NOT_SUBMITTED;
  }

  /**
   * v0.9.102 (R4; design 6, 6.1): read when a live admitted review of a workspace file settles. Whatever its close
   * recorded covers the file as it was dispatched; when the file is not that any more, this says so, read again here
   * like a close is, so an editor, a command or another teammate is seen too. `changedFiles` are the file changes the
   * host recorded for this attempt; `changedByTeammate` says whether one of them is the file under review. Nothing
   * is stored: the binding goes when the attempt ends, as before.
   */
  reviewTargetChangeAtSettlement(attemptId: string, changedFiles: readonly string[]): ReviewTargetChangeAtSettlement | undefined {
    const attempt = this.attempts.get(attemptId);
    const target = attempt?.state === 'live' ? attempt.reviewTarget : undefined;
    if (!attempt || !target || this.reviewAdmissions.get(attemptId)?.decision.allowed !== true) return undefined;
    const detail = reviewTargetChange(target);
    if (!detail) return undefined;
    const changedByTeammate = changedFiles.some((file) => {
      const changed = path.resolve(attempt.workspacePathBase, file);
      return samePhysicalPath(changed, target.lexicalPath) || samePhysicalPath(changed, target.physicalPath);
    });
    return { inputId: target.inputId, detail, changedByTeammate };
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
  noteWorkspaceRead(attemptId: string, agentId: string, observedPath: string, bytes?: Buffer): void {
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
    // v0.9.101 (H2b): the first read of a required source in this attempt: the digest of the exact bytes the read used.
    const required = attempt.card.contract.inputs.some((input) => input.inputId === matched.inputId && input.required);
    if (bytes && required && !attempt.sourceDigests.has(matched.inputId)) {
      attempt.sourceDigests.set(matched.inputId, { inputId: matched.inputId, physical: observedIdentity, sha256: sha256Of(bytes) });
    }
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

  /**
   * v0.9.101 (H2b): the source digests an attempt recorded, and the required file inputs it recorded none for: those a
   * draft prepared in it cannot be confirmed against. Content assets and upstream artifacts are host-held bytes that do
   * not change, so they need none.
   */
  sourceDigestsOf(attemptId: string): { digests: SourceDigest[]; undigested: string[] } {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return { digests: [], undigested: [] };
    const digests = [...attempt.sourceDigests.values()].map((digest) => ({ ...digest }));
    const undigested = attempt.card.contract.inputs
      .filter((input) => input.required && input.kind === 'workspacePath' && !attempt.sourceDigests.has(input.inputId))
      .map((input) => input.inputId);
    return { digests, undigested };
  }

  /** v0.9.101 (H2b): the file tools of this attempt's own agent hold a draft of it. A foreign one is not recorded. */
  noteDraftCustodian(attemptId: string, custodian: DocumentDraftCustodian): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state !== 'live' || attempt.card.agentId !== custodian.agentId) return;
    attempt.draftCustodian = custodian;
  }

  /**
   * v0.9.101 (H2b): the attempt that took over an earlier attempt's draft of the same agent carries that attempt's reads
   * of its inputs: the draft it saves is the work those reads made, and its save compares each digested source with the
   * bytes first read before it writes. Only reads the earlier attempt recorded are carried; nothing is read here.
   */
  carryInputReads(fromAttemptId: string, toAttemptId: string): void {
    const from = this.attempts.get(fromAttemptId);
    const to = this.attempts.get(toAttemptId);
    if (!from || !to || to.state !== 'live' || from.card.agentId !== to.card.agentId || from.card.contractId === to.card.contractId) return;
    const now = new Date().toISOString();
    for (const read of from.card.grants) {
      if (!read.readAt || !to.card.grants.some((grant) => grant.inputId === read.inputId)) continue;
      this.updateGrant(toAttemptId, to.card.agentId, (grant) => grant.inputId === read.inputId,
        (grant) => ({ ...grant, reachableAt: grant.reachableAt ?? now, readAt: grant.readAt ?? now }));
      this.setInputObservation(to, read.inputId, { outcome: 'read', observedAt: now });
    }
  }

  /** v0.9.101 (H2b): who holds this attempt's drafts, live or ended. */
  draftCustodianOf(attemptId: string): DocumentDraftCustodian | undefined {
    return this.attempts.get(attemptId)?.draftCustodian;
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
    // v0.9.99: an artifact of any length is kept on disk and read in pages; no store limit refuses it. The attempt
    // that made it and its coordinator's request hold it.
    const stored = await this.contentAssets.storeText(value, 'turn-supplied', agentId);
    this.contentAssets.retain([stored.assetId], attemptHolder(attemptId));
    this.contentAssets.retain([stored.assetId], userRequestHolder(attempt.coordinatorId));
    this.contractManagedContentAssets.add(stored.assetId);
    const provenance = this.attemptProvenance(attempt);
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

  /** Host-only wiring of the saved-batch store and of who hears about a save. */
  setCheckpointStore(store: TaskCheckpointStore | undefined, observers: CheckpointObservers = {}): void {
    this.checkpoints = store;
    this.checkpointObservers = observers;
  }

  /** The dispatch's handle, recorded with the attempt's first saved batch so a coordinator and a view can find it. */
  bindAttemptHandle(attemptId: string, handle: string): void {
    const attempt = this.attempts.get(attemptId);
    if (attempt && !attempt.handle) attempt.handle = handle;
  }

  /**
   * v0.9.103 (G1): the coordinator a live attempt reports to and the handle that carries it, for the agent executing
   * it only. Undefined when the attempt is not live, is another agent's, has no handle yet, or is the coordinator's own.
   */
  messageBinding(attemptId: string, agentId: string): { coordinatorId: string; handle: string } | undefined {
    const attempt = this.attempts.get(attemptId);
    if (!attempt?.handle || !this.isAttemptLive(attemptId, agentId) || attempt.coordinatorId === agentId) return undefined;
    return { coordinatorId: attempt.coordinatorId, handle: attempt.handle };
  }

  private turnThreadSource?: (agentId: string) => { coordinatorId: string; handle: string } | undefined;

  /** v0.9.103 (audit I1): host-only wiring of where an agent's running turn says which delegation thread it is on. */
  setTurnThreadSource(source: ((agentId: string) => { coordinatorId: string; handle: string } | undefined) | undefined): void {
    this.turnThreadSource = source;
  }

  /**
   * v0.9.103 (audit I1): the coordinator and handle of the delegation an agent's running turn is on, when that turn
   * carries no attempt card (a rework of the handle). It grants nothing: it only says where the agent's messages go.
   */
  turnThread(agentId: string): { coordinatorId: string; handle: string } | undefined {
    let thread: { coordinatorId: string; handle: string } | undefined;
    try { thread = this.turnThreadSource?.(agentId); } catch { thread = undefined; }
    return thread && thread.coordinatorId !== agentId ? thread : undefined;
  }

  /** The delivery plan of a live attempt that delivers in batches, for the agent executing it. */
  liveDeliveryPlan(attemptId: string, agentId: string): IncrementalDeliveryPlan | undefined {
    return this.isAttemptLive(attemptId, agentId) ? this.attempts.get(attemptId)!.card.contract.delivery : undefined;
  }

  /**
   * v0.9.97: save one batch of a live attempt's work product. The authority is the attempt's, exactly as for a
   * published artifact: live, and executed by this agent. It is asked again by the store after the batch is flushed
   * and once more after the store answers, so an attempt that a stop or a closed result window ended meanwhile
   * keeps nothing of this batch. The model supplies only the text and its section metadata.
   */
  async saveCheckpoint(attemptId: string, agentId: string, args: Record<string, unknown>): Promise<CheckpointToolResult> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.card.agentId !== agentId) {
      return { status: 'refused', reason: 'no-attempt', message: 'no live task attempt of this agent can save a batch.' };
    }
    if (attempt.state !== 'live') return { status: 'refused', reason: 'attempt-ended', message: CHECKPOINT_ATTEMPT_ENDED };
    const plan = attempt.card.contract.delivery;
    if (!plan) {
      return { status: 'refused', reason: 'not-incremental', message: 'this task was not dispatched for delivery in batches; return the work as the task card says.' };
    }
    if (!this.checkpoints?.available) {
      return { status: 'refused', reason: 'unavailable', message: 'batches cannot be saved in this window: it has no workspace storage. Nothing was saved; deliver the work in your reply.' };
    }
    const parsed = parseCheckpointRequest(args);
    if (!parsed.request) return { status: 'refused', reason: 'invalid', message: `${parsed.error} Nothing was saved.` };
    const live = () => this.isAttemptLive(attemptId, agentId);
    const result = await this.checkpoints.save({
      attemptId,
      agentId,
      coordinatorId: attempt.coordinatorId,
      contractId: attempt.card.contractId,
      ...(attempt.handle ? { handle: attempt.handle } : {}),
      objective: attempt.card.contract.objective,
      plan,
      requiredInputCount: attempt.card.contract.inputs.filter((input) => input.required).length,
      startedAt: attempt.startedAt,
      requiredInputsNotRead: this.requiredInputReadSummary(attemptId)?.requiredInputReadNotObservedCount ?? 0,
    }, parsed.request, live);
    if (result.status !== 'saved') return result;
    // A batch confirmed on disk after the attempt ended is taken back: the end came first.
    if (!result.receipt.replay && !live()) {
      await this.checkpoints.withdraw(attemptId, result.receipt.checkpointId);
      return { status: 'refused', reason: 'attempt-ended', message: CHECKPOINT_ATTEMPT_ENDED };
    }
    if (!result.receipt.replay) this.checkpointObservers.saved?.(attemptId, result.receipt);
    return result;
  }

  /** The saved batches of an attempt. For an attempt this window holds, the final check uses its live input reads. */
  checkpointSummary(attemptId: string): CheckpointAttemptSummary | undefined {
    return this.checkpoints?.summary(attemptId, this.requiredInputReadSummary(attemptId)?.requiredInputReadNotObservedCount);
  }

  checkpointSummaryForHandle(handle: string): CheckpointAttemptSummary | undefined {
    return this.checkpoints?.summaryForHandle(handle, (attemptId) => this.requiredInputReadSummary(attemptId)?.requiredInputReadNotObservedCount);
  }

  /** The delivery plan of an attempt this window holds, live or ended. */
  deliveryPlanOf(attemptId: string): IncrementalDeliveryPlan | undefined {
    return this.attempts.get(attemptId)?.card.contract.delivery;
  }

  /**
   * The host's reminder that a batch is due, for the next result of a tool the host serves to this attempt. Only a
   * live attempt that delivers in batches gets one; the source decides when, and says so once per due period.
   */
  takeCheckpointDueNotice(attemptId: string, agentId: string): string | undefined {
    if (!this.liveDeliveryPlan(attemptId, agentId)) return undefined;
    return this.checkpointObservers.due?.(attemptId);
  }

  /**
   * v0.9.97: the saved batches of one of this coordinator's own handles, as the final check selects them. A stopped
   * task's batches are a draft only the person may recover, so a coordinator is not given them.
   */
  savedBatchesForCoordinator(
    handle: string,
    coordinatorId: string,
    sections?: readonly string[],
  ): { summary: CheckpointAttemptSummary; batches: TaskCheckpointRecord[] } | { error: string } {
    const summary = this.checkpointSummaryForHandle(handle);
    if (!summary || summary.coordinatorId !== coordinatorId) {
      return { error: `no saved batches are known for handle ${handle}` };
    }
    if (summary.removed) return { error: `the saved batches of handle ${handle} were ${summary.removed.reason} on ${summary.removed.at}; they are unavailable` };
    if (summary.state === 'cancelled') {
      return { error: `handle ${handle} was stopped. Its ${summary.batches} saved batch(es) are a stopped task's draft: only the person can open or recover them (UnodeAi: Saved Task Batches). Nothing was read` };
    }
    const unknown = (sections ?? []).filter((key) => !summary.plan.sections.some((section) => section.key === key));
    if (unknown.length) return { error: `not expected sections of handle ${handle}: ${unknown.join(', ')}` };
    return { summary, batches: this.checkpoints!.selectedBatches(summary.attemptId, sections) };
  }

  /**
   * v0.9.97: the coordinator's explicit choice to make one handle's saved batches a task input. The artifact holds
   * the final check's selection, keeps the producing attempt's whole input provenance, is delegable by this
   * coordinator alone, and is marked incomplete whenever the final check is. A stopped task's draft is refused.
   */
  async publishSavedBatchesArtifact(handle: string, coordinatorId: string): Promise<{ artifact?: ReadyTaskArtifact; error?: string }> {
    const found = this.savedBatchesForCoordinator(handle, coordinatorId);
    if ('error' in found) return { error: found.error };
    const attempt = this.attempts.get(found.summary.attemptId);
    if (!attempt || attempt.coordinatorId !== coordinatorId) {
      return { error: `the inputs of handle ${handle} are not known in this window, so its saved batches cannot carry their provenance into a task input` };
    }
    if (found.batches.length === 0) return { error: `handle ${handle} has no saved batch to publish` };
    const finalCheck = describeFinalCheck(found.summary.finalCheck);
    const stored = await this.contentAssets.storeText(
      formatSavedBatches(handle, found.summary, found.batches),
      'turn-supplied',
      attempt.card.agentId,
    );
    // v0.9.99: saved batches of any length become one input; the coordinator's request holds it.
    this.contentAssets.retain([stored.assetId], userRequestHolder(coordinatorId));
    this.contractManagedContentAssets.add(stored.assetId);
    const artifact: ReadyTaskArtifact = {
      artifactId: `artifact-${this.nextArtifact++}-${uuidv4()}`,
      contentAssetId: stored.assetId,
      producerAttemptId: attempt.card.attemptId,
      producerAgentId: attempt.card.agentId,
      delegableByAgentIds: [coordinatorId],
      provenance: this.attemptProvenance(attempt),
      state: 'artifact-ready',
      partialWork: { completeness: found.summary.finalCheck.status, finalCheck },
    };
    this.artifacts.set(artifact.artifactId, artifact);
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

  /**
   * Conservative taint: every granted input and every inherited upstream entry is retained. A worker cannot launder
   * a source by omitting it or by publishing it through several artifact hops.
   */
  private attemptProvenance(attempt: LiveTaskAttempt): ReadyTaskArtifact['provenance'] {
    const attemptId = attempt.card.attemptId;
    return attempt.card.grants.flatMap((grant) => {
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
      : card.unreadableOptionalInputs?.includes(input.inputId)
        ? 'not passed (optional): it is a binary file whose text UnodeAi cannot read'
      : input.kind === 'workspacePath' && (grant || !isOutsideContractPath(input.path))
        ? `read ${isOutsideContractPath(input.path) ? 'the file outside the workspace' : 'workspace path'} ${input.path}`
          + (input.freshness === 'dispatch-snapshot' ? ' (snapshot)' : ' (current content)')
        : 'not granted (optional)';
    // v0.9.97: partial work made from saved batches says so wherever it is granted.
    const partial = grant?.partialWork
      ? ` — partial work from saved batches, final check ${grant.partialWork.finalCheck}`
      : '';
    return `- ${input.inputId} [${input.kind}; ${input.required ? 'required' : 'optional'}]: ${input.purpose} — ${access}${partial}`;
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
    `Marked ${reviewedInput(contract)?.kind === 'workspacePath' ? 'workspace file' : 'artifact'} review input: ${contract.review?.inputId ?? 'none'}`,
    `Baseline workspace authority: ${card.baselineWorkspaceAuthority === 'independent-agent-authority'
      ? 'still exists independently; contract inputs do not widen it'
      : 'narrowed to the host-enforced per-turn scope'}`,
    'Inputs:',
    inputs.join('\n') || '- none',
    // v0.9.101 (G1): a version 2 contract's outputs, as requirements. Saving one uses the teammate's own write access.
    ...(contract.outputs ? [
      'Outputs (requirements, not grants: saving one uses your own write access, and a refused save is reported, not worked around):',
      contract.outputs.map((output) => `- ${output.outputId} [${output.kind}; ${output.required ? 'required' : 'optional'}]: ${output.path}`)
        .join('\n') || '- none',
    ] : []),
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
    ...(contract.review ? [REVIEW_EVIDENCE_GUIDANCE] : []),
    // v0.9.106: the findings this review checks again, and how to report each.
    ...(contract.review?.recheck?.length ? [`Recheck these findings of earlier reviews: ${contract.review.recheck.join(', ')}. `
      + 'In close_assignment, add review_evidence.rechecks with one entry per finding: {"finding": "<reviewHandle>#F<n>", '
      + '"status": "resolved" or "unresolved", "citations": [...]}. "resolved" needs at least one citation to lines you read with '
      + 'read_file and line_numbers: true in this task.'] : []),
    ...(contract.fixes?.length ? [`This task fixes these findings of earlier reviews: ${contract.fixes.join(', ')}.`] : []),
    ...(contract.delivery ? [formatDeliveryPlan(contract.delivery)] : []),
    '[/host task card]',
  ].join('\n');
}

/**
 * v0.9.94: what the holder of a marked review is told about backing findings with host receipts. It names the two
 * tools that issue them, because a read made with a connection's own file tool looks the same to the model and
 * leaves nothing the host could check a citation against. It also says which findings need a citation and what a
 * checked citation shows, so a reviewer does not take the check for a judgement of its findings or its coverage.
 */
const REVIEW_EVIDENCE_GUIDANCE = 'Close this review with close_assignment and review_evidence: that is what numbers your '
  + 'findings, so the coordinator can decide each one and have it rechecked; your reply still reaches the coordinator. '
  + 'Do this even if the task asks you to put your conclusion in your reply. A finding is a defect or risk for the coordinator '
  + 'to decide. If you found none, close with findings: [] and your coverage: a pass or "no defect found" is not a finding, '
  + 'and say in your reply what you read. To back findings, read with read_file and '
  + 'line_numbers: true, search with search_files, and cite the short receipt ids those results carry (R1, S1). '
  + 'Only those two UnodeAi tools issue receipts: a read or search made with any other tool cannot be cited. '
  + 'An observed or source-traced finding needs at least one citation; a finding you cannot cite is inferred. '
  + 'The host checks that each cited receipt belongs to this attempt and that the cited lines were displayed to you. '
  + 'It does not confirm a finding, and it records your overall coverage as your own statement. '
  + 'A review closed without review_evidence, or on a connection that offers no close_assignment, is recorded as evidence '
  + 'not submitted, and its findings cannot be numbered or tracked.';

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

function parseEffects(value: unknown, workspaceRoot: string | undefined, outside: OutsideContractPath): { effects?: EffectiveTaskContract['effects']; error?: string } {
  if (!isRecord(value)) return { error: 'contract.effects must be an object.' };
  const extra = Object.keys(value).find((key) => !['read_files', 'write_scope', 'expected_file_effect'].includes(key));
  if (extra) return { error: `contract.effects contains unsupported field "${extra}".` };
  const readFiles = parsePathArray(value.read_files, 'contract.effects.read_files', 500, workspaceRoot, outside);
  if (readFiles.error) return { error: readFiles.error };
  const fileEffect = value.expected_file_effect;
  if (fileEffect !== 'none' && fileEffect !== 'create' && fileEffect !== 'modify' && fileEffect !== 'delete' && fileEffect !== 'mixed') {
    return { error: 'contract.effects.expected_file_effect is required and must be none, create, modify, delete, or mixed.' };
  }
  const scope = parseTaskScope(value.write_scope, workspaceRoot, outside);
  if (scope.error) return { error: scope.error };
  // v0.9.100 (field, 7fc21c4b T2): a task scope is the teammate's whole file reach, so a file outside the workspace
  // named only in read_files was out of reach as soon as the contract had a write_scope: "read the agreement, write the
  // summary there" admitted the folder and silently left the agreement out. Such a file joins the scope as read, so
  // admission judges it, the person is told of it or offered Grant access for it, and the teammate can open it.
  // Covered means inside an entry as that entry is resolved: `.` is the workspace, not every path (audit of 15a4fa53, F1).
  // `pathCoveredByScope` answers `.` with yes for any target, which is right only for a path inside the workspace.
  const coveredByEntry = (file: string) => scopeEntryCovers(scope.scope!.folderAccess, file, workspaceRoot);
  const outsideReads = scope.scope
    ? readFiles.values!.filter((file) => contractPathApi(file, workspaceRoot).isAbsolute(file) && !coveredByEntry(file))
    : [];
  if (scope.scope && scope.scope.folderAccess.length + outsideReads.length > 100) {
    return { error: 'contract.effects.write_scope.folder_access and the outside read_files it must add may contain at most 100 entries.' };
  }
  const writeScope = scope.scope && outsideReads.length
    ? { folderAccess: [...scope.scope.folderAccess, ...outsideReads.map((file) => ({ path: file, permission: 'read' as const }))] }
    : scope.scope;
  return { effects: { readFiles: readFiles.values!, ...(writeScope ? { writeScope } : {}), expectedFileEffect: fileEffect } };
}

/** Whether an entry of a scope, as that entry is resolved, holds `file`. `.` is the workspace, not every path. */
function scopeEntryCovers(entries: DelegationTaskScope['folderAccess'], file: string, workspaceRoot?: string): boolean {
  return entries.some((entry) => {
    const api = contractPathApi(file, workspaceRoot);
    const relative = api.relative(api.resolve(workspaceRoot ?? '', entry.path), file);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative));
  });
}

/**
 * v0.9.101 (A1, field aebbd520 T2): a workspacePath input may name a file outside the workspace, by its absolute path.
 * It stays an input (its id, required, freshness, provenance and receipt keep their meaning) and is a read the task
 * needs, nothing more. With a task scope, which is the teammate's whole file reach, it joins the scope as read, once and
 * only where no entry already holds it (a read_files entry for the same file holds it). Never write, never its folder:
 * admission still intersects the scope with what the teammate may reach, so this widens no ceiling.
 */
function withOutsideInputReads(
  effects: EffectiveTaskContract['effects'],
  inputs: readonly ContractInput[],
  workspaceRoot?: string,
): { effects?: EffectiveTaskContract['effects']; error?: string } {
  const scope = effects.writeScope;
  if (!scope) return { effects };
  const folderAccess = [...scope.folderAccess];
  for (const input of inputs) {
    if (input.kind !== 'workspacePath' || !isOutsideContractPath(input.path)) continue;
    if (!scopeEntryCovers(folderAccess, input.path, workspaceRoot)) folderAccess.push({ path: input.path, permission: 'read' });
  }
  if (folderAccess.length === scope.folderAccess.length) return { effects };
  if (folderAccess.length > 100) {
    return { error: 'contract.effects.write_scope.folder_access and the outside read_files and inputs it must add may contain at most 100 entries.' };
  }
  return { effects: { ...effects, writeScope: { folderAccess } } };
}

/**
 * A compiled contract path names a file outside the workspace exactly when it is absolute: a path inside the workspace
 * is always kept relative. Decided by the spelling alone; nothing is resolved or read.
 */
export function isOutsideContractPath(value: string): boolean {
  return contractPathApi(value, undefined).isAbsolute(value);
}

function parseInputs(value: unknown, workspaceRoot: string | undefined, outside: OutsideContractPath): { inputs?: ContractInput[]; error?: string } {
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
      // v0.9.101 (A1): by the rules of read_files. A path outside the workspace is named by its absolute spelling; a
      // relative path that climbs out, or any other malformed path, is still refused. Nothing is read or resolved.
      const parsedPath = parseContractPath(raw.path, `contract.inputs[${index}].path`, workspaceRoot, outside);
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

/**
 * v0.9.101 (G1): a version 2 contract's outputs. Each entry is exactly `output_id`, `path`, `kind` and `required`; ids
 * follow the input id rules and are unique; at most 100, the same bound as a task scope's entries. A path is parsed as a
 * read file is: relative to the host workspace, or an absolute path that only names a target outside it. A kind that
 * contradicts what is already at the target is an input error: the host never takes a folder's parent, or a file's
 * folder, instead. That is observed by metadata only, never for a share, device or `/net` path, and never without a
 * host workspace (a stored contract is re-parsed without one).
 */
function parseOutputs(
  value: unknown,
  workspaceRoot: string | undefined,
  probe: OutputTargetProbe,
  outside: OutsideContractPath,
): { outputs?: PlannedOutput[]; error?: string } {
  if (!Array.isArray(value)) return { error: 'contract.outputs must be an array.' };
  if (value.length > 100) return { error: 'contract.outputs may contain at most 100 entries.' };
  const outputs: PlannedOutput[] = [];
  for (let index = 0; index < value.length; index++) {
    const label = `contract.outputs[${index}]`;
    if (!isRecord(value[index])) return { error: `${label} must be an object.` };
    const raw = value[index] as Record<string, unknown>;
    const extra = Object.keys(raw).find((key) => !['output_id', 'path', 'kind', 'required'].includes(key));
    if (extra) return { error: `${label} contains unsupported field "${extra}".` };
    const outputId = typeof raw.output_id === 'string' ? raw.output_id.trim() : '';
    if (!INPUT_ID.test(outputId)) return { error: `${label}.output_id is invalid.` };
    if (outputs.some((output) => output.outputId === outputId)) return { error: `contract.outputs repeats output_id "${outputId}".` };
    const parsedPath = parseContractPath(raw.path, `${label}.path`, workspaceRoot, outside);
    if (parsedPath.error) return { error: parsedPath.error };
    if (raw.kind !== 'file' && raw.kind !== 'directory') return { error: `${label}.kind must be file or directory.` };
    if (typeof raw.required !== 'boolean') return { error: `${label}.required must be boolean.` };
    const api = contractPathApi(parsedPath.value!, workspaceRoot);
    const target = api.resolve(workspaceRoot ?? '', parsedPath.value!);
    const repeated = outputs.find((output) => api.relative(api.resolve(workspaceRoot ?? '', output.path), target) === '');
    if (repeated) return { error: `${label}.path names the same target as output "${repeated.outputId}".` };
    // Only a path this host can resolve is observed: a Windows spelling names nothing on another host. And only inside
    // the workspace (security re-audit, F4): before any authority is judged, an outside path's answer told the model
    // whether a file or folder exists there, outside every grant. An outside output's kind is met when it is written.
    const fromRoot = workspaceRoot ? api.relative(api.resolve(workspaceRoot), target) : '..';
    const insideWorkspace = fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${api.sep}`) && !api.isAbsolute(fromRoot));
    const observed = workspaceRoot && insideWorkspace && path.isAbsolute(target) && !reachesAnotherComputer(path.resolve(target))
      ? probe(path.resolve(target)) : undefined;
    if (observed && observed !== raw.kind) {
      return { error: `${label}.kind is ${raw.kind}, but ${parsedPath.value} is an existing ${observed === 'directory' ? 'folder' : 'file'}. `
        + 'Correct the kind or name the intended target; an output never stands for its folder or for a file in it.' };
    }
    outputs.push({ outputId, path: parsedPath.value!, kind: raw.kind, required: raw.required });
  }
  return { outputs };
}

/** v0.9.101 (G1): a file or folder already at `absolute`, following links; anything else, or nothing, is undefined. */
function observeOutputTarget(absolute: string): 'file' | 'directory' | undefined {
  try {
    const stats = statSync(absolute);
    return stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : undefined;
  } catch {
    return undefined;
  }
}

function parseReview(
  value: unknown,
  inputs: readonly ContractInput[],
): { value?: { inputId: string; recheck?: string[] }; error?: string } {
  if (value === undefined) return {};
  if (!isRecord(value) || typeof value.input_id !== 'string'
    || Object.keys(value).some((key) => key !== 'input_id' && key !== 'recheck')) {
    return { error: 'contract.review must contain input_id, and optionally recheck.' };
  }
  const inputId = value.input_id.trim();
  const input = inputs.find((candidate) => candidate.inputId === inputId);
  if (!INPUT_ID.test(inputId) || !input || !input.required || !isReviewableInput(input)) {
    return { error: 'contract.review.input_id must name one required upstreamArtifact or current workspacePath input in this contract.' };
  }
  const recheck = parseFindingRefList(value.recheck, 'contract.review.recheck');
  if (recheck.error) return { error: recheck.error };
  return { value: { inputId, ...(recheck.values?.length ? { recheck: recheck.values } : {}) } };
}

/** v0.9.106: at most 50 distinct finding references, each written "<reviewHandle>#F<n>". The host resolves them. */
function parseFindingRefList(value: unknown, field: string): { values?: string[]; error?: string } {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length > MAX_FINDING_DISPOSITIONS
    || value.some((entry) => typeof entry !== 'string' || !parseFindingRefText(entry))) {
    return { error: `${field} must be a list of at most ${MAX_FINDING_DISPOSITIONS} findings, each written "<reviewHandle>#F<n>".` };
  }
  const values = value.map((entry) => (entry as string).trim());
  if (new Set(values).size !== values.length) return { error: `${field} names a finding twice.` };
  return { values };
}

/**
 * What a marked review may be a review of: an upstream artifact, or a workspace file read where it stands. A
 * dispatch snapshot and a content asset reach the reviewer through the extracted-content tools, which issue no read
 * receipt, so a review of one could never back a finding with a citation.
 */
function isReviewableInput(input: ContractInput): boolean {
  return input.kind === 'upstreamArtifact' || (input.kind === 'workspacePath' && input.freshness === 'current');
}

/** The declared input a marked review is a review of. */
function reviewedInput(contract: EffectiveTaskContract): ContractInput | undefined {
  const review = contract.review;
  return review && contract.inputs.find((input) => input.inputId === review.inputId);
}

/**
 * Bind the workspace file a marked review is a review of, as that file is at dispatch. A review of an upstream
 * artifact has no such file and binds nothing. A target the host cannot bind stops the dispatch: closing the
 * review would have nothing to compare the file with.
 */
function bindWorkspaceReviewTarget(
  contract: EffectiveTaskContract,
  workspacePathBase: string,
  capturedAt: string,
  /** v0.9.101 (A1): outside inputs this attempt's teammate was found able to read. Only these may lie outside. */
  outsideReadable: ReadonlyMap<string, string> = new Map(),
): { binding?: WorkspaceReviewTargetBinding; error?: string } {
  const input = reviewedInput(contract);
  if (input?.kind !== 'workspacePath') return {};
  const lexicalPath = path.resolve(workspacePathBase, input.path);
  if (!outsideReadable.has(input.inputId) && !isPathInsideOrEqual(workspacePathBase, lexicalPath)) {
    return { error: `task-scope: workspace review target "${input.inputId}" escapes the workspace root` };
  }
  const observed = observeReviewTarget(lexicalPath);
  if (!observed) {
    return {
      error: `input-grant: workspace review target "${input.inputId}" is missing, is not a file, or is larger than the `
        + `${hostReadMemoryBudget()} bytes this window can hold in memory at once; a review of a workspace file needs that file at dispatch`,
    };
  }
  return { binding: { inputId: input.inputId, lexicalPath, ...observed, capturedAt } };
}

/**
 * What a review target's path leads to right now: the physical file and the digest of its bytes. The binding at
 * dispatch and the check before a close both read through here, so the two digests are taken the same way. A path
 * that leads to no file, or to one above the size a read displays, has no answer.
 */
function observeReviewTarget(lexicalPath: string): { physicalPath: string; contentDigest: string } | undefined {
  try {
    const physicalPath = realpathSync.native(lexicalPath);
    const stat = statSync(physicalPath);
    if (!stat.isFile() || stat.size > hostReadMemoryBudget()) return undefined;
    return { physicalPath, contentDigest: contentDigestOf(readFileSync(physicalPath)) };
  } catch {
    return undefined;
  }
}

/** What changed about a bound review target since dispatch, in words for the refusal; nothing when it still holds. */
function reviewTargetChange(target: WorkspaceReviewTargetBinding): string | undefined {
  const current = observeReviewTarget(target.lexicalPath);
  if (!current) {
    return `The file under review (input "${target.inputId}") is no longer a file the host can read at its path.`;
  }
  // The same bytes in another file are another file: the review was dispatched for this one.
  if (!samePhysicalPath(current.physicalPath, target.physicalPath)) {
    return `The path of the file under review (input "${target.inputId}") now leads to another file than the one this review was dispatched for.`;
  }
  if (current.contentDigest !== target.contentDigest) {
    return `The file under review (input "${target.inputId}") no longer has the content it had when this review was dispatched.`;
  }
  return undefined;
}

/**
 * Whether a displayed view is a view of the bound review target. A receipt keeps the absolute path its read
 * resolved and the physical file it reached. A match on either counts: the path may have led to another file while
 * the view was displayed, and the file may have been read under another name.
 */
function isViewOfReviewTarget(target: WorkspaceReviewTargetBinding, receipt: ReviewReadReceipt): boolean {
  return [receipt.path, ...receipt.pathAliases].some((spelling) => path.isAbsolute(spelling)
    && (samePhysicalPath(spelling, target.lexicalPath) || samePhysicalPath(spelling, target.physicalPath)));
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

function parseTaskScope(value: unknown, workspaceRoot: string | undefined, outside: OutsideContractPath): { scope?: DelegationTaskScope; error?: string } {
  if (value === undefined || value === null) return {};
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'folder_access')) return { error: 'contract.effects.write_scope may contain only folder_access.' };
  if (!Array.isArray(value.folder_access) || value.folder_access.length === 0 || value.folder_access.length > 100) return { error: 'contract.effects.write_scope.folder_access must contain 1-100 entries.' };
  const folderAccess: DelegationTaskScope['folderAccess'] = [];
  for (let index = 0; index < value.folder_access.length; index++) {
    const entry = value.folder_access[index];
    if (!isRecord(entry) || Object.keys(entry).some((key) => key !== 'path' && key !== 'permission')) return { error: `contract.effects.write_scope.folder_access[${index}] is invalid.` };
    const parsedPath = parseContractPath(entry.path, `contract.effects.write_scope.folder_access[${index}].path`, workspaceRoot, outside);
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

function parsePathArray(value: unknown, label: string, max: number, workspaceRoot: string | undefined, outside: OutsideContractPath): { values?: string[]; error?: string } {
  if (!Array.isArray(value)) return { error: `${label} must be an array.` };
  if (value.length > max) return { error: `${label} may contain at most ${max} entries.` };
  const values: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const parsed = parseContractPath(value[index], `${label}[${index}]`, workspaceRoot, outside);
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

/**
 * The path rules for a contract path: Windows rules for a Windows spelling (a drive, or a `\\server` share) of the path or
 * its root, so a contract fixture with Windows paths reads the same on any host; the host's own rules otherwise. A POSIX
 * `/tmp/x` is absolute by Windows rules too, so `path.win32.isAbsolute` cannot choose: until v0.9.100 it sent such a path
 * through `path.win32` on Linux and macOS, which spelled an outside folder `\tmp\x`, a name inside the workspace.
 */
export function contractPathApi(raw: string, workspaceRoot: string | undefined, host: typeof path = path): typeof path {
  const windowsSpelling = (value: string) => /^[A-Za-z]:([\\/]|$)/.test(value) || value.startsWith('\\\\');
  return windowsSpelling(raw) || windowsSpelling(workspaceRoot ?? '') ? path.win32 : host;
}

function parseContractPath(value: unknown, label: string, workspaceRoot?: string, outside: OutsideContractPath = 'refuse'): { value?: string; error?: string } {
  if (typeof value !== 'string') return { error: `${label} must be a workspace-relative path.` };
  const normalized = normalizeWorkspacePath(value, workspaceRoot);
  if (normalized && normalized.length <= 1_000) return { value: normalized };
  // v0.9.100 (the Owner): a scope may name an outside path by its absolute spelling. Naming grants nothing: task
  // admission intersects it with what the teammate may already reach, and the person is told when one is admitted.
  const raw = value.trim();
  const api = contractPathApi(raw, workspaceRoot);
  if (outside === 'name' && workspaceRoot && api.isAbsolute(raw) && raw.length <= 1_000) return { value: api.resolve(raw) };
  // A stored record has no root: its absolute path is taken only as the compiler wrote it, already resolved.
  if (outside === 'stored' && api.isAbsolute(raw) && raw.length <= 1_000 && api.resolve(raw) === raw) return { value: raw };
  return { error: outside !== 'refuse'
    ? `${label} must be relative and inside the workspace, or an absolute path.`
    : `${label} must stay inside the workspace and be relative. Name a path outside the workspace in contract.effects.read_files or contract.effects.write_scope instead, by its absolute path.` };
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
  const api = contractPathApi(raw, workspaceRoot);
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
    return isPathInsideOrEqual(root, value);
  });
}

/**
 * One filesystem-aware identity primitive for contract admission and read receipts. `realpath` preserves
 * the filesystem's own case semantics and collapses symlinks; missing paths deliberately have no physical
 * identity and callers may fall back to lexical containment where existence is not yet required. It is the
 * native realpath, the one `fs.promises.realpath` uses and the file tools observe with: the JavaScript
 * `realpathSync` keeps an 8.3 short name or a lowercase drive letter, so the same file had two identities.
 */
export function resolveWorkspacePathIdentity(pathBase: string, value: string): string | undefined {
  const candidate = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(pathBase, normalizeContractPath(value));
  try {
    return realpathSync.native(candidate);
  } catch {
    return undefined;
  }
}

/**
 * v0.9.101 (A1): why a required outside input keeps a candidate from starting, by the host's access fact. A permission
 * gap is never called a missing file, and the way forward keeps the contract as it is: the same dispatch is admitted
 * once the access exists.
 */
function outsideInputFailure(input: WorkspacePathContractInput, access: OutsideInputAccess | undefined): PreflightFailure {
  const named = `required input "${input.inputId}" (${input.path})`;
  const detail = access && access.status !== 'readable' && access.detail ? ` (${access.detail})` : '';
  switch (access?.status) {
    case 'grant-needed':
      return { filter: 'grant-needed', inputId: input.inputId, reason: `${named} is outside the workspace, and this teammate `
        + 'may not read it yet. A UnodeAi notice offers Grant access for it; after the user grants Read, dispatch the same '
        + 'contract again, keeping this input and the task scope' };
    case 'explicit-limit':
      return { filter: 'explicit-limit', inputId: input.inputId, reason: `${named} is outside this teammate's own Folder `
        + 'Access, a limit a grant does not widen. Choose a teammate that can read it, or the user can change that Folder Access' };
    case 'missing-input':
      return { filter: 'missing-input', inputId: input.inputId, reason: `${named} is within this teammate's access, but no `
        + `regular file is there${detail}` };
    default:
      return { filter: 'input-grant', inputId: input.inputId, reason: `${named} is outside the workspace, and the host could `
        + `not check that this teammate can read it${detail}` };
  }
}

/**
 * v0.9.101 (T101-8): why a required outside `current` input keeps a candidate from starting although the host can read
 * the file: the teammate has no UnodeAi file tool of its own that reads it under that access during its task. A grant
 * does not change that, so none is offered. A snapshot the host takes now does deliver it, and another teammate may.
 */
function currentReadRouteFailure(input: WorkspacePathContractInput): PreflightFailure {
  return { filter: 'read-route', inputId: input.inputId, reason: `required input "${input.inputId}" (${input.path}) is `
    + 'readable by UnodeAi, but this teammate has no UnodeAi file tool that reads it during its task under that access '
    + '(its own native reads are not checked against it). Dispatch the same input with freshness "dispatch-snapshot", so '
    + 'UnodeAi reads it now and hands the teammate that copy, or choose a teammate whose UnodeAi file tools read it' };
}

/** Why a dispatch snapshot was not taken, named by input. The assignment is not started. */
function snapshotRefusal(inputId: string, reason: Exclude<RegularFileRead, { status: 'read' }>['reason'], outside = false): string {
  switch (reason) {
    case 'scope':
      return outside
        ? `task-scope: snapshot input "${inputId}" no longer leads to the file this teammate may read; nothing was snapshotted`
        : `task-scope: workspace snapshot input "${inputId}" is outside the workspace this assignment may read`;
    case 'changed':
      return `input-grant: workspace snapshot input "${inputId}" changed while it was being read; nothing was snapshotted`;
    case 'missing':
      return `input-grant: workspace snapshot input "${inputId}" does not exist`;
    case 'not-regular':
      return `input-grant: workspace snapshot input "${inputId}" is not a regular file`;
    case 'too-large':
      return `input-grant: workspace snapshot input "${inputId}" is larger than this VS Code window can hold in memory at once, so it could not be snapshotted`;
    case 'unreadable':
      return `input-grant: workspace snapshot input "${inputId}" is unreadable`;
  }
}

/**
 * The text a dispatch snapshot carries, as read_file reads the same file: a Word, PowerPoint or PDF file's extracted
 * text, and text as it is. Undefined for a binary file that is not a readable document. Before (since v0.9.97) the
 * bytes were decoded as UTF-8 whatever they were, so a Word input reached the teammate as its ZIP bytes and it could
 * not read the contract (smoke of 81f50826).
 */
async function snapshotText(bytes: Buffer): Promise<string | undefined> {
  if (!sniffContent(bytes).binary) return bytes.toString('utf8');
  const extracted = await extractWorkspaceDocument(bytes);
  return extracted.text;
}

function snapshotNotText(inputId: string): string {
  return `input-grant: snapshot input "${inputId}" is a binary file whose text UnodeAi cannot read (it reads Word, `
    + 'PowerPoint, PDF and text files); nothing was snapshotted';
}

function samePhysicalPath(left: string, right: string): boolean {
  return path.relative(left, right) === '';
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

/** v0.9.101 (H2b): the SHA-256 of exact source bytes, hex. */
function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
