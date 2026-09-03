import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import {
  CoordinatorTaskStatus,
  DelegationEvidenceRecord,
  DelegationOutcome,
  DelegationDispositionEvent,
  DelegationCancellationEvent,
  DelegationRoutingReceipt,
} from '../backend/TeamTools';
import { sanitizeVerificationPlan, type VerificationPlan } from '../backend/VerificationPlan';
import {
  DelegationTaskScope,
  Message,
  type DelegationCompletionState,
  type RunCloseoutCompletionState,
} from '../types';
import { SECRET_PATTERNS } from '../security/secretPatterns';
import { TurnContextManifest, TurnContextManifestEntry } from '../session/TurnContextManifest';
import { WorkerTaskProgressRecord } from '../session/WorkerTaskProgress';
import type { ConnectionKind, PrivacyDomain } from '../routes/RouteContracts';
import { sanitizeContentReceipt, type ContentReceiptObservation } from '../content/ContentReceipt';
import {
  compileTaskContract,
  type EffectiveTaskContract,
  type ArtifactReviewObservation,
  type InputGrant,
  type ReadyTaskArtifact,
  type TaskContextGap,
} from '../backend/TaskContract';

export const RUN_ACTIVITY_RETAINED_LIMIT = 300;
const RUN_HISTORY_LIMIT = 100;

export type RunStatus = 'open' | 'closed';
/** The one declared source for persisted run versions. Adding a version changes this union too. */
export const RUN_SCHEMA_VERSIONS = [1, 2, 3, 4, 5, 6, 7] as const;
export type RunSchemaVersion = typeof RUN_SCHEMA_VERSIONS[number];
export type RunPermissionKind = 'command-approval' | 'write-approval' | 'web-access-approval' | 'tool-approval' | 'folder-access' | 'mcp-grant';
/** `expired` is a fail-closed host outcome, never a late human denial. */
export type RunPermissionDecision = 'allowed' | 'denied' | 'expired';
export type RunOutcomeRepairCategory = 'consent-timeout' | 'delegate-empty';
export type RunOutcomeRepairState = 'offered' | 'invoked' | 'unavailable';
export type RunVerdict = 'accepted' | 'accepted-with-exceptions' | 'rejected';
const RUN_VERDICTS = new Set<RunVerdict>(['accepted', 'accepted-with-exceptions', 'rejected']);

/** A human judgement. It is deliberately not a coordinator disposition or a framework outcome. */
export interface RunVerdictEvent {
  verdict: RunVerdict;
  /** A real actor recorded at the time the person gave the verdict. */
  approverId: string;
  recordedAt: string;
  /** The surface showed the host-observed evidence before accepting the verdict. */
  evidenceReviewedAt: string;
  /** Bounded internal audit text; portable evidence exports only this array's length. */
  unresolvedItems: string[];
}

export type RunVerdictWithholdingReason = 'non-human-approver' | 'invalid-shape' | 'invalid-exceptions';

/** Content-free record that a persisted verdict was deliberately not restored as human judgement. */
export interface RunVerdictWithholding {
  reason: RunVerdictWithholdingReason;
  /** Number of accepted verdicts that preceded this rejected persisted value. */
  acceptedVerdictCount: number;
}

export type RunVerdictResolution =
  | { status: 'accepted'; verdict: RunVerdictEvent }
  | { status: 'absent' }
  | { status: 'withheld'; reason: RunVerdictWithholdingReason };

export interface RunActivityItem {
  timestamp: string;
  from: string;
  to: string;
  type: string;
  content: string;
}

export interface RunDelegation {
  handle: string;
  requestedAgent: string;
  agentId: string;
  instruction: string;
  /** Full internal contract. Portable evidence has a separate no-prose allowlist. */
  contract?: EffectiveTaskContract;
  /** Concrete execution identity; grants are bound here rather than to the agent or a TTL. */
  attemptId?: string;
  /** Content-free verification contract chosen before this task started. */
  verificationPlan?: VerificationPlan;
  dispatchedAt: string;
  temporaryScope?: { readGrants: number; readwriteGrants: number; appliedAt?: string };
  /** Distinguishes host-enforced temporary scope from an ordinary fixed-session dispatch. */
  scopeMode?: 'per-turn-requested' | 'per-turn-enforced' | 'fixed-session-permissions';
  state: 'active' | 'settled' | 'cancelled';
  settledAt?: string;
  cancelledAt?: string;
  cancellationReason?: string;
  /** Result delivery is independent from worker settlement and from mailbox cleanup. */
  delivery?: {
    state: 'pending' | 'delivered';
    observedAt: string;
    via?: 'auto-wake' | 'collect-ready' | 'blocking-tool';
  };
  /** Exact host-resolved destination. The internal pack keeps it; the portable builder classifies it. */
  route?: RunRouteReceipt;
  /** Host routing facts retained for internal audit; portable evidence owns its own allowlist. */
  routing?: DelegationRoutingReceipt;
  /** Content-free digest captured while before/after bytes still existed at the successful write boundary. */
  diffDigest?: RunDiffDigest;
  /** A bounded reason why a complete digest cannot truthfully be claimed for this delegation. */
  diffDigestUnavailable?: RunDiffDigestUnavailableReason;
  evidence?: DelegationEvidenceRecord;
  /** Phase A host-observed progress facts for this one dispatched worker task. */
  progress?: WorkerTaskProgressRecord;
  dispositions: DelegationDispositionEvent[];
}

export interface RunRefusedDispatch {
  handle?: string;
  requestedAgent: string;
  reason: string;
  recordedAt: string;
  taskState?: 'no-executor' | 'policy-refused';
  policyId?: string;
}

export interface RunPermissionEvent {
  kind: RunPermissionKind;
  agentId: string;
  decision: RunPermissionDecision;
  recordedAt: string;
  label?: string;
  /** Present only when this receipt records a contemporaneous human decision. */
  approverId?: string;
}

/**
 * A host-observed repair lifecycle entry. The internal record keeps the opaque outcome id so state is
 * correlated to the thing that actually got stuck; portable evidence deliberately omits that identity.
 */
export interface RunOutcomeRepairEvent {
  outcomeId: string;
  category: RunOutcomeRepairCategory;
  state: RunOutcomeRepairState;
  recordedAt: string;
}

export interface RunRouteReceipt {
  /** Registered connection id. May be a machine-local custom-gateway id. */
  routeId: string;
  connectionKind: ConnectionKind;
  /** Exact canonical endpoint. May contain a private gateway hostname. */
  executionDomain: string;
  /** Exact internal privacy-domain identity plus its bounded resolution state. */
  privacyDomain: Pick<PrivacyDomain, 'id' | 'status'>;
}

export interface RunDiffFileHash {
  path: string;
  /** null means the path did not exist at that side of the observed change. */
  beforeContentHash: string | null;
  /** null means the observed operation deleted the file. */
  afterContentHash: string | null;
}

export interface RunDiffDigest {
  algorithm: 'sha256';
  value: string;
  files: RunDiffFileHash[];
}

export type RunDiffDigestUnavailableReason =
  | 'directory-tree-content-not-observed'
  | 'file-content-not-observed'
  | 'unrecorded-write';

export interface RunContextReceipt {
  agentId: string;
  recordedAt: string;
  entries: TurnContextManifestEntry[];
}

/**
 * Durable, content-free record of a bounded consultation. Asset ids (when the class uses one) are host-
 * generated and remapped to document-local ordinals; URL, query, bytes, temp path, transcript text and
 * extracted text are deliberately absent from this type.
 */
export type RunContentReceipt = ContentReceiptObservation & {
  agentId: string;
  recordedAt: string;
};

/**
 * Shape read from workspace storage. It deliberately retains the historical optional fields: this value
 * has not passed the ledger's normalizer and must never be handed to a consumer as a RunRecord.
 */
export interface StoredRunRecord {
  /** v2 correlation; v3 route/diff; v4 verdicts; v5 delivery; v6 reviews; v7 completion/read receipts. */
  schemaVersion: RunSchemaVersion;
  id: string;
  coordinatorId: string;
  /** Host-observed thread keys that identify this run. Never infer membership from an agent id. */
  correlationIds: string[];
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  /** How a closed coordinator turn ended. Ownership closeout is independent from human acceptance. */
  closeoutCompletionState?: RunCloseoutCompletionState;
  objective?: string;
  delegations: RunDelegation[];
  refusedDispatches: RunRefusedDispatch[];
  permissions: RunPermissionEvent[];
  /** Outcome-repair facts are append-only, like permissions and verdicts. */
  outcomeRepairs?: RunOutcomeRepairEvent[];
  /** Append-only human acceptance history. A missing field on an older row means unjudged. */
  verdicts?: RunVerdictEvent[];
  /** Invalid/non-human persisted verdicts are withheld, but the drop itself is never silent. */
  verdictWithholdings?: RunVerdictWithholding[];
  contextReceipts: RunContextReceipt[];
  /** Optional only for pre-v0.9.57 persisted rows; new runs always initialise this empty. */
  contentReceipts?: RunContentReceipt[];
  /** Content-free exact-attempt observations; absent on older records means not recorded. */
  reviewObservations?: ArtifactReviewObservation[];
  activity: RunActivityItem[];
  droppedActivityItems: number;
}

/** The normalized in-memory record. These four arrays always exist after normalizeRun returns. */
export interface RunRecord extends StoredRunRecord {
  outcomeRepairs: RunOutcomeRepairEvent[];
  verdicts: RunVerdictEvent[];
  contentReceipts: RunContentReceipt[];
  reviewObservations: ArtifactReviewObservation[];
}

type FieldPolicy = {
  /** Fields copied into RunSummary; derived summary fields live in RUN_SUMMARY_DERIVED. */
  summary?: true;
} & (
  | { portable: false; reason: string }
  | { portable: true | string; portableOrder: number }
);

type RunRecordField = keyof Required<RunRecord>;

/**
 * The policy is exhaustive, so a RunRecord field cannot be introduced without an explicit portability
 * and summary decision. This is a policy manifest, not a generated parser or exporter.
 */
export const RUN_RECORD_FIELDS = {
  id: { portable: 'runId', portableOrder: 1, summary: true },
  coordinatorId: { portable: 'coordinator', portableOrder: 2, summary: true },
  status: { portable: true, portableOrder: 3, summary: true },
  startedAt: { portable: true, portableOrder: 4, summary: true },
  endedAt: { portable: true, portableOrder: 5 },
  closeoutCompletionState: { portable: true, portableOrder: 6, summary: true },
  refusedDispatches: { portable: 'accounting', portableOrder: 8 },
  permissions: { portable: true, portableOrder: 9 },
  outcomeRepairs: { portable: true, portableOrder: 10 },
  verdicts: { portable: 'verdict', portableOrder: 11 },
  verdictWithholdings: { portable: 'verdict', portableOrder: 11 },
  delegations: { portable: true, portableOrder: 12 },
  contentReceipts: { portable: 'content', portableOrder: 13 },
  schemaVersion: { portable: false, reason: 'The portable document carries its own schema version.' },
  correlationIds: { portable: false, reason: 'Internal correlation keys identify host threads and are not portable evidence.' },
  objective: { portable: false, reason: 'The user request is free text; portable evidence carries no prose.', summary: true },
  contextReceipts: { portable: false, reason: 'Context receipts may identify internal source and conversation structure.' },
  reviewObservations: { portable: false, reason: 'Review observations remain internal evidence until their own portable policy is defined.' },
  activity: { portable: false, reason: 'Activity contains message content and is retained only in the internal evidence pack.' },
  droppedActivityItems: { portable: false, reason: 'Internal evidence, not a portable run-evidence field.' },
} satisfies Record<RunRecordField, FieldPolicy>;

type SummaryDirectField = {
  [Field in keyof typeof RUN_RECORD_FIELDS]: typeof RUN_RECORD_FIELDS[Field] extends { summary: true } ? Field : never;
}[keyof typeof RUN_RECORD_FIELDS];

export const RUN_SUMMARY_DIRECT_FIELDS = (Object.keys(RUN_RECORD_FIELDS) as RunRecordField[])
  .filter((field): field is SummaryDirectField =>
    'summary' in RUN_RECORD_FIELDS[field] && RUN_RECORD_FIELDS[field].summary === true);

function pickRunRecordFields<const Fields extends readonly RunRecordField[]>(
  run: RunRecord,
  fields: Fields,
): Pick<RunRecord, Fields[number]> {
  const picked: Partial<Pick<RunRecord, Fields[number]>> = {};
  for (const field of fields) {
    const value = run[field];
    if (value !== undefined) Object.assign(picked, { [field]: value });
  }
  return picked as Pick<RunRecord, Fields[number]>;
}

function defineRunSummaryDerived<const Fields extends readonly RunRecordField[], Value>(
  from: Fields,
  compute: (run: Pick<RunRecord, Fields[number]>) => Value,
) {
  return {
    from,
    compute,
    project: (run: RunRecord): Value => compute(pickRunRecordFields(run, from)),
  };
}

/** Computed summary fields must declare the RunRecord fields their computation reads. */
export const RUN_SUMMARY_DERIVED = {
  verdict: defineRunSummaryDerived(
    ['verdicts', 'verdictWithholdings'] as const,
    (run) => latestRunVerdict(run)?.verdict,
  ),
} as const;

type RunSummaryDerivedFields = {
  [Field in keyof typeof RUN_SUMMARY_DERIVED]: ReturnType<typeof RUN_SUMMARY_DERIVED[Field]['project']>;
};

export type RunSummary = Pick<RunRecord, SummaryDirectField> & Partial<RunSummaryDerivedFields>;

function projectRunSummary(run: RunRecord): RunSummary {
  const direct = pickRunRecordFields(run, RUN_SUMMARY_DIRECT_FIELDS);
  const derived: Record<string, unknown> = {};
  for (const field of Object.keys(RUN_SUMMARY_DERIVED) as Array<keyof typeof RUN_SUMMARY_DERIVED>) {
    const value = RUN_SUMMARY_DERIVED[field].project(run);
    if (value !== undefined) derived[field] = value;
  }
  return { ...direct, ...derived } as RunSummary;
}

interface PendingCoordinatorEvidence {
  objective?: string;
  refusedDispatches: RunRefusedDispatch[];
}

/**
 * Durable, host-observed run accounting. A run begins after a coordinator actually dispatches work, or
 * when the final admission gate refuses that exact proposed dispatch and records a policy-refused run.
 * Every subsequent fact must carry one of that run's correlation keys; agent identity is deliberately not
 * a fallback. That loses unthreaded narration, but prevents a reused PM or worker from producing evidence
 * that looks attributable when it is not.
 */
export class RunLedger {
  private records: RunRecord[];
  /** User objectives and pre-dispatch refusals waiting for their exact originating turn to dispatch work. */
  private pending = new Map<string, PendingCoordinatorEvidence>();
  /** Legacy/in-process callers without a turn correlation cannot be joined to an existing open run. */
  private pendingWithoutCorrelation = new Map<string, PendingCoordinatorEvidence>();
  // MessageBus sends the assignment synchronously. A task-start receipt can arrive before TeamTools has
  // returned from that send and recorded its matching delegation.
  private pendingScopeApplications = new Map<string, { readGrants: number; readwriteGrants: number; appliedAt: string }>();
  /** A worker can finish before TeamTools returns from the synchronous MessageBus dispatch. */
  private pendingProgressByHandle = new Map<string, { agentId: string; progress: WorkerTaskProgressRecord }>();
  /** A manifest can precede the TeamTools dispatch callback, but it still has the delegation's handle. */
  private latestManifests = new Map<string, RunContextReceipt>();
  private listeners = new Set<() => void>();

  constructor(records: readonly unknown[] = []) {
    this.records = records.map(normalizeRun).filter((record): record is RunRecord => !!record).slice(-RUN_HISTORY_LIMIT);
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): RunRecord[] {
    return structuredClone(this.records);
  }

  list(): RunSummary[] {
    return this.records.slice().reverse().map(projectRunSummary);
  }

  get(id: string): RunRecord | undefined {
    const record = this.records.find((candidate) => candidate.id === id);
    return record ? structuredClone(record) : undefined;
  }

  observeMessage(message: Message): void {
    if (message.from === 'user' && message.type === 'ask.question' && message.to !== '*') {
      const pending = this.pendingFor(message.correlationId ?? message.id);
      pending.objective = redactEvidenceText(String(message.payload.instruction ?? ''));
      this.emit();
      return;
    }

    // A message without a verified thread key is intentionally omitted. Including it just because the PM
    // or a worker once belonged to the run is the cross-run contamination this ledger exists to prevent.
    if (!message.correlationId) {
      return;
    }

    const affected = this.records.filter((run) => run.status === 'open' && this.messageBelongsToRun(run, message));
    for (const run of affected) {
      this.appendActivity(run, message);
    }

    // A coordinator closeout is trustworthy only when it is in that run's thread. `unode` is the internal
    // async-result bridge; its completion is rendered in the same chat transcript as a user-facing reply.
    if ((message.to === 'user' || message.to === 'unode')
      && (message.type === 'task.complete' || message.type === 'task.partial')) {
      for (const run of affected.filter((candidate) => candidate.coordinatorId === message.from)) {
        if (run.delegations.every((delegation) => delegation.state !== 'active')) {
          run.status = 'closed';
          run.endedAt = message.timestamp;
          run.closeoutCompletionState = message.type === 'task.partial' ? 'partial' : 'complete';
        }
      }
    }
    if (affected.length > 0) {
      this.emit();
    }
  }

  recordDelegationDispatched(event: {
    coordinatorId: string;
    handle: string;
    requestedAgent: string;
    agentId: string;
    instruction: string;
    contract?: EffectiveTaskContract;
    attemptId?: string;
    verificationPlan?: VerificationPlan;
    scope?: DelegationTaskScope;
    scopeMode?: 'per-turn-requested' | 'fixed-session-permissions';
    routing?: DelegationRoutingReceipt;
    route?: RunRouteReceipt;
    dispatchedAt?: string;
    /** Canonical key for the coordinator turn that emitted this dispatch. */
    originCorrelationId?: string;
  }): string {
    const run = this.openRunFor(event.coordinatorId, event.originCorrelationId, event.dispatchedAt);
    const requestedScope = scopeSummary(event.scope);
    const route = event.route ? sanitizeRouteReceipt(event.route) : undefined;
    const routing = event.routing ? sanitizeRoutingReceipt(event.routing) : undefined;
    let delegation = run.delegations.find((candidate) => candidate.handle === event.handle);
    if (!delegation) {
      delegation = {
        handle: event.handle,
        requestedAgent: redactEvidenceText(event.requestedAgent),
        agentId: event.agentId,
        instruction: redactEvidenceText(event.instruction),
        ...(event.contract ? { contract: structuredClone(event.contract) } : {}),
        ...(event.attemptId ? { attemptId: event.attemptId } : {}),
        ...(event.verificationPlan ? { verificationPlan: sanitizeVerificationPlan(event.verificationPlan) } : {}),
        dispatchedAt: event.dispatchedAt ?? new Date().toISOString(),
        ...(requestedScope ? { temporaryScope: requestedScope } : {}),
        ...(event.scopeMode ? { scopeMode: event.scopeMode } : {}),
        ...(route ? { route } : {}),
        ...(routing ? { routing } : {}),
        state: 'active',
        dispositions: [],
      };
      run.delegations.push(delegation);
    }
    const pendingScopeApplication = this.pendingScopeApplications.get(delegation.handle);
    if (pendingScopeApplication) {
      delegation.temporaryScope = pendingScopeApplication;
      delegation.scopeMode = 'per-turn-enforced';
      this.pendingScopeApplications.delete(delegation.handle);
    }
    const pendingProgress = this.pendingProgressByHandle.get(delegation.handle);
    if (pendingProgress && pendingProgress.agentId === delegation.agentId) {
      delegation.progress = sanitizeProgress(pendingProgress.progress);
      this.pendingProgressByHandle.delete(delegation.handle);
    }
    // MessageBus delivers the assignment synchronously. A fast worker can publish its context manifest
    // before TeamTools returns from send() and invokes this receipt callback, so attach that exact
    // post-dispatch manifest rather than losing the first worker turn from the run account.
    const workerManifest = this.latestManifests.get(event.handle);
    if (workerManifest && Date.parse(workerManifest.recordedAt) >= Date.parse(delegation.dispatchedAt)) {
      this.appendContextReceipt(run, workerManifest);
    }
    // TeamTools records the receipt after MessageBus delivers task.assign. The handle is not owned until
    // this point, so the bus observer correctly omitted that message. Add this host-observed receipt once.
    this.appendActivity(run, {
      id: event.handle,
      correlationId: event.handle,
      from: event.coordinatorId,
      to: event.agentId,
      type: 'task.assign',
      priority: 'high',
      payload: { instruction: event.instruction },
      timestamp: event.dispatchedAt ?? new Date().toISOString(),
    });
    this.emit();
    return run.id;
  }

  recordRefusedDispatch(event: {
    coordinatorId: string;
    handle?: string;
    requestedAgent: string;
    reason: string;
    recordedAt?: string;
    originCorrelationId?: string;
    taskState?: 'no-executor' | 'policy-refused';
    policyId?: string;
  }): void {
    const receipt: RunRefusedDispatch = {
      ...(event.handle ? { handle: event.handle } : {}),
      requestedAgent: redactEvidenceText(event.requestedAgent),
      reason: redactEvidenceText(event.reason),
      recordedAt: event.recordedAt ?? new Date().toISOString(),
      ...(event.taskState === 'no-executor' || event.taskState === 'policy-refused' ? { taskState: event.taskState } : {}),
      ...(event.policyId ? { policyId: redactEvidenceText(event.policyId) } : {}),
    };
    const run = event.originCorrelationId ? this.openRunForCorrelation(event.coordinatorId, event.originCorrelationId) : undefined;
    if (run) {
      run.refusedDispatches.push(receipt);
    } else if (event.taskState === 'policy-refused') {
      this.openRunFor(event.coordinatorId, event.originCorrelationId, receipt.recordedAt).refusedDispatches.push(receipt);
    } else {
      this.pendingFor(event.originCorrelationId, event.coordinatorId).refusedDispatches.push(receipt);
    }
    this.emit();
  }

  recordReviewObservation(observation: ArtifactReviewObservation): void {
    const sanitized = normalizeReviewObservation(observation);
    if (!sanitized) return;
    const run = this.records.find((candidate) => candidate.delegations.some(
      (delegation) => delegation.attemptId === sanitized.reviewerAttemptId,
    ));
    if (!run) return;
    if (run.reviewObservations.some((entry) => entry.reviewerAttemptId === sanitized.reviewerAttemptId)) return;
    run.reviewObservations.push(sanitized);
    this.emit();
  }

  recordDelegationEvidence(event: {
    handle: string;
    agentId: string;
    outcome: DelegationOutcome;
    evidence: DelegationEvidenceRecord;
  }): void {
    const located = this.findDelegation(event.handle);
    if (!located) {
      return;
    }
    if (located.delegation.state === 'cancelled') {
      return;
    }
    located.delegation.state = 'settled';
    located.delegation.settledAt ??= located.delegation.progress?.settledAt ?? new Date().toISOString();
    const evidence = sanitizeEvidence(event.evidence);
    const observedPaths = located.delegation.diffDigest?.files.map((file) => file.path) ?? [];
    evidence.changedFiles = [...new Set([...evidence.changedFiles, ...observedPaths])];
    located.delegation.evidence = evidence;
    if (evidence.unrecordedWrites) {
      located.delegation.diffDigest = undefined;
      located.delegation.diffDigestUnavailable = 'unrecorded-write';
    } else if (!located.delegation.diffDigestUnavailable) {
      if (evidence.changedFiles.length === 0) {
        located.delegation.diffDigest = makeRunDiffDigest([]);
      } else if (!located.delegation.diffDigest || evidence.changedFiles.some((path) => !observedPaths.includes(path))) {
        located.delegation.diffDigest = undefined;
        located.delegation.diffDigestUnavailable = 'file-content-not-observed';
      }
    }
    this.emit();
  }

  /** Mark a settled async result as still owned by the delivery mailbox. */
  recordDeliveryPending(handle: string, observedAt = new Date().toISOString()): void {
    const located = this.findDelegation(handle);
    if (!located || located.delegation.state !== 'settled' || located.delegation.delivery?.state === 'delivered') {
      return;
    }
    located.delegation.delivery = { state: 'pending', observedAt };
    this.emit();
  }

  /** Record the exact host path that placed a result into a coordinator turn or tool result. */
  recordDeliveryDelivered(
    handle: string,
    via: 'auto-wake' | 'collect-ready' | 'blocking-tool',
    observedAt = new Date().toISOString(),
  ): void {
    const located = this.findDelegation(handle);
    if (!located || located.delegation.state !== 'settled') {
      return;
    }
    if (located.delegation.delivery?.state === 'delivered') {
      return;
    }
    located.delegation.delivery = { state: 'delivered', observedAt, via };
    this.emit();
  }

  /**
   * Record one successful filesystem effect while its bytes still exist. Source bytes are accepted only at
   * this method boundary, hashed immediately, and never attached to the durable run object.
   */
  recordFileChange(event: {
    agentId?: string;
    correlationId?: string;
    path: string;
    before: string | null;
    after: string;
    operation?: 'write' | 'delete-file' | 'delete-directory';
    /** False when a backend observed the write but could not reconstruct one side's source bytes. */
    contentObserved?: boolean;
  }): void {
    if (!event.agentId || !event.correlationId || !event.path ||
        (event.operation !== 'delete-file' && event.operation !== 'delete-directory' && event.before === event.after)) {
      return;
    }
    const located = this.findDelegation(event.correlationId);
    if (!located || located.delegation.agentId !== event.agentId || located.delegation.state !== 'active') {
      return;
    }
    if (event.contentObserved === false) {
      located.delegation.diffDigest = undefined;
      located.delegation.diffDigestUnavailable = 'file-content-not-observed';
      this.emit();
      return;
    }
    if (event.operation === 'delete-directory') {
      located.delegation.diffDigest = undefined;
      located.delegation.diffDigestUnavailable = 'directory-tree-content-not-observed';
      this.emit();
      return;
    }
    if (located.delegation.diffDigestUnavailable) {
      return;
    }
    const files = located.delegation.diffDigest?.files.map((file) => ({ ...file })) ?? [];
    const existing = files.find((file) => file.path === event.path);
    const beforeContentHash = event.before === null ? null : sha256(event.before);
    const afterContentHash = event.operation === 'delete-file' ? null : sha256(event.after);
    if (existing) {
      existing.afterContentHash = afterContentHash;
    } else {
      files.push({ path: event.path, beforeContentHash, afterContentHash });
    }
    located.delegation.diffDigest = makeRunDiffDigest(files);
    this.emit();
  }

  /**
   * Phase A receipt. This is intentionally orthogonal to the existing evidence verdict: it measures
   * progress timing without asking a model (or a human) to grade the worker's prose.
   */
  recordDelegationProgress(event: { handle: string; agentId: string; progress: WorkerTaskProgressRecord }): void {
    const located = this.findDelegation(event.handle);
    if (!located) {
      this.pendingProgressByHandle.set(event.handle, { agentId: event.agentId, progress: sanitizeProgress(event.progress) });
      return;
    }
    if (located.delegation.agentId !== event.agentId) {
      return;
    }
    located.delegation.progress = sanitizeProgress(event.progress);
    this.emit();
  }

  /** Cancellation is a host receipt, not an evidence result or coordinator disposition. */
  recordDelegationCancelled(event: DelegationCancellationEvent): void {
    const located = this.findDelegation(event.handle);
    if (!located || located.delegation.state === 'settled') {
      return;
    }
    located.delegation.state = 'cancelled';
    located.delegation.cancelledAt = event.cancelledAt;
    located.delegation.cancellationReason = redactEvidenceText(event.reason);
    this.emit();
  }

  recordTaskScopeApplied(handle: string, scope: DelegationTaskScope, appliedAt = new Date().toISOString()): void {
    const summary = scopeSummary(scope);
    if (!summary) {
      return;
    }
    const located = this.findDelegation(handle);
    if (!located) {
      this.pendingScopeApplications.set(handle, { ...summary, appliedAt });
      return;
    }
    located.delegation.temporaryScope = { ...summary, appliedAt };
    located.delegation.scopeMode = 'per-turn-enforced';
    this.emit();
  }

  recordDisposition(event: DelegationDispositionEvent): void {
    const located = this.findDelegation(event.handle);
    if (!located || located.delegation.state !== 'settled') {
      return;
    }
    located.delegation.dispositions.push({
      ...event,
      ...(event.reason ? { reason: redactEvidenceText(event.reason) } : {}),
    });
    this.emit();
  }

  recordContextManifest(
    agentId: string,
    manifest: TurnContextManifest,
    correlationId: string | undefined,
    recordedAt = new Date().toISOString()
  ): void {
    if (!correlationId) {
      return;
    }
    const receipt: RunContextReceipt = {
      agentId,
      recordedAt,
      entries: structuredClone(manifest.entries),
    };
    this.latestManifests.set(correlationId, receipt);
    const runs = this.records.filter((run) => run.status === 'open' && this.ownsCorrelation(run, correlationId));
    if (runs.length > 0) {
      for (const run of runs) {
        this.appendContextReceipt(run, receipt);
      }
    }
    this.emit();
  }

  /**
   * One bounded observation from the rich-content port. Correlation remains mandatory: attaching a
   * receipt merely because an agent once belonged to a run would recreate the cross-run attribution bug
   * this ledger exists to avoid.
   */
  recordContentReceipt(event: ContentReceiptObservation & {
    agentId?: string;
    correlationId?: string;
    recordedAt?: string;
  }): void {
    if (!event.agentId || !event.correlationId) {
      return;
    }
    const content = sanitizeContentReceipt(event);
    if (!content) {
      return;
    }
    const receipt: RunContentReceipt = {
      agentId: event.agentId,
      recordedAt: event.recordedAt ?? new Date().toISOString(),
      ...content,
    };
    let changed = false;
    for (const run of this.records) {
      if (run.status !== 'open' || !this.ownsCorrelation(run, event.correlationId)) {
        continue;
      }
      run.contentReceipts.push(receipt);
      changed = true;
    }
    if (changed) {
      this.emit();
    }
  }

  recordPermission(event: {
    agentId?: string;
    kind: RunPermissionKind;
    decision: RunPermissionDecision;
    label?: string;
    approverId?: string;
    recordedAt?: string;
    correlationId?: string;
  }): void {
    if (!event.agentId || !event.correlationId) {
      return;
    }
    const receipt: RunPermissionEvent = {
      kind: event.kind,
      agentId: event.agentId,
      decision: event.decision,
      recordedAt: event.recordedAt ?? new Date().toISOString(),
      ...(event.label ? { label: redactEvidenceText(event.label) } : {}),
      ...(isContemporaneousApprover(event.kind, event.approverId)
        ? { approverId: event.approverId }
        : {}),
    };
    let changed = false;
    for (const run of this.records) {
      if (run.status === 'open' && this.ownsCorrelation(run, event.correlationId)) {
        run.permissions.push(receipt);
        changed = true;
      }
    }
    if (changed) {
      this.emit();
    }
  }

  /** Record a bounded, host-derived repair fact against the run that owns this correlation. */
  recordOutcomeRepair(event: {
    outcomeId: string;
    category: RunOutcomeRepairCategory;
    state: RunOutcomeRepairState;
    correlationId?: string;
    recordedAt?: string;
  }): void {
    if (!event.correlationId || !event.outcomeId || event.outcomeId.length > 240) {
      return;
    }
    const receipt: RunOutcomeRepairEvent = {
      outcomeId: event.outcomeId,
      category: event.category,
      state: event.state,
      recordedAt: event.recordedAt ?? new Date().toISOString(),
    };
    let changed = false;
    for (const run of this.records) {
      if (run.status === 'open' && this.ownsCorrelation(run, event.correlationId)) {
        run.outcomeRepairs.push(receipt);
        changed = true;
      }
    }
    if (changed) {
      this.emit();
    }
  }

  /**
   * Append a human verdict after the evidence was shown. A rejected verdict is a valid outcome; an absent
   * verdict remains unjudged. This never reads coordinator dispositions or framework outcomes.
   */
  recordVerdict(event: {
    runId: string;
    verdict: RunVerdict;
    approverId?: string;
    evidenceReviewedAt: string;
    unresolvedItems?: readonly string[];
    recordedAt?: string;
  }): boolean {
    const run = this.records.find((candidate) => candidate.id === event.runId);
    if (!run || run.delegations.some((delegation) => delegation.state === 'active') || !RUN_VERDICTS.has(event.verdict) ||
        !isContemporaneousHumanApprover(event.approverId) || typeof event.evidenceReviewedAt !== 'string') {
      return false;
    }
    const unresolvedItems = sanitizeUnresolvedItems(event.unresolvedItems);
    if (event.verdict === 'accepted-with-exceptions' && unresolvedItems.length === 0) {
      return false;
    }
    run.verdicts.push({
      verdict: event.verdict,
      approverId: event.approverId,
      recordedAt: event.recordedAt ?? new Date().toISOString(),
      evidenceReviewedAt: event.evidenceReviewedAt,
      unresolvedItems,
    });
    this.emit();
    return true;
  }

  runIdForDelegation(handle: string): string | undefined {
    return this.findDelegation(handle)?.run.id;
  }

  /**
   * Read-only, coordinator-scoped projection over durable facts. The projection intentionally excludes
   * instructions, output, paths, commands, route internals and every other unbounded source value.
   */
  inspectTaskStatus(
    coordinatorId: string,
    handles?: readonly string[],
    limit = 50,
  ): CoordinatorTaskStatus[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit) || 50));
    if (handles && handles.length > 0) {
      return handles.slice(0, boundedLimit).map((handle) => {
        const located = this.findCoordinatorDelegation(coordinatorId, handle);
        if (located) return projectCoordinatorTaskStatus(located.run, located.delegation);
        for (const run of this.records) {
          if (run.coordinatorId !== coordinatorId) continue;
          const refusal = run.refusedDispatches.find((entry) => entry.handle === handle && entry.taskState === 'policy-refused');
          if (refusal) return projectPolicyRefusalStatus(run, refusal);
        }
        return { handle, lifecycle: 'unknown' };
      });
    }
    const rows: CoordinatorTaskStatus[] = [];
    for (const run of this.records.slice().reverse()) {
      if (run.coordinatorId !== coordinatorId) continue;
      for (const refusal of run.refusedDispatches.slice().reverse()) {
        if (refusal.taskState !== 'policy-refused' || !refusal.handle) continue;
        rows.push(projectPolicyRefusalStatus(run, refusal));
        if (rows.length >= boundedLimit) return rows;
      }
      for (const delegation of run.delegations.slice().reverse()) {
        rows.push(projectCoordinatorTaskStatus(run, delegation));
        if (rows.length >= boundedLimit) return rows;
      }
    }
    return rows;
  }

  private openRunFor(coordinatorId: string, originCorrelationId?: string, startedAt?: string): RunRecord {
    const existing = originCorrelationId ? this.openRunForCorrelation(coordinatorId, originCorrelationId) : undefined;
    if (existing) {
      return existing;
    }
    const pending = originCorrelationId
      ? this.pending.get(originCorrelationId)
      : this.pendingWithoutCorrelation.get(coordinatorId);
    const id = uuidv4();
    const run: RunRecord = {
      schemaVersion: 7,
      id,
      coordinatorId,
      correlationIds: [id, ...(originCorrelationId ? [originCorrelationId] : [])],
      status: 'open',
      startedAt: startedAt ?? new Date().toISOString(),
      ...(pending?.objective ? { objective: pending.objective } : {}),
      delegations: [],
      refusedDispatches: pending?.refusedDispatches ?? [],
      permissions: [],
      outcomeRepairs: [],
      verdicts: [],
      contextReceipts: originCorrelationId && this.latestManifests.get(originCorrelationId)
        ? [structuredClone(this.latestManifests.get(originCorrelationId)!)]
        : [],
      contentReceipts: [],
      reviewObservations: [],
      activity: [],
      droppedActivityItems: 0,
    };
    if (originCorrelationId) {
      this.pending.delete(originCorrelationId);
    } else {
      this.pendingWithoutCorrelation.delete(coordinatorId);
    }
    this.records.push(run);
    if (this.records.length > RUN_HISTORY_LIMIT) {
      this.records.splice(0, this.records.length - RUN_HISTORY_LIMIT);
    }
    return run;
  }

  private openRunForCorrelation(coordinatorId: string, correlationId: string): RunRecord | undefined {
    return this.records.find((run) =>
      run.coordinatorId === coordinatorId && run.status === 'open' && this.ownsCorrelation(run, correlationId)
    );
  }

  private pendingFor(correlationId: string | undefined, coordinatorId?: string): PendingCoordinatorEvidence {
    const store = correlationId ? this.pending : this.pendingWithoutCorrelation;
    const key = correlationId ?? coordinatorId;
    if (!key) {
      throw new Error('A pending run record needs either a coordinator id or a turn correlation.');
    }
    let pending = store.get(key);
    if (!pending) {
      pending = { refusedDispatches: [] };
      store.set(key, pending);
    }
    return pending;
  }

  private findDelegation(handle: string): { run: RunRecord; delegation: RunDelegation } | undefined {
    for (const run of this.records) {
      const delegation = run.delegations.find((candidate) => candidate.handle === handle);
      if (delegation) {
        return { run, delegation };
      }
    }
    return undefined;
  }

  private findCoordinatorDelegation(
    coordinatorId: string,
    handle: string,
  ): { run: RunRecord; delegation: RunDelegation } | undefined {
    for (const run of this.records) {
      if (run.coordinatorId !== coordinatorId) continue;
      const delegation = run.delegations.find((candidate) => candidate.handle === handle);
      if (delegation) return { run, delegation };
    }
    return undefined;
  }

  private messageBelongsToRun(run: RunRecord, message: Message): boolean {
    return !!message.correlationId && this.ownsCorrelation(run, message.correlationId);
  }

  private ownsCorrelation(run: RunRecord, correlationId: string): boolean {
    return run.correlationIds.includes(correlationId) || run.delegations.some((delegation) => delegation.handle === correlationId);
  }

  private appendContextReceipt(run: RunRecord, receipt: RunContextReceipt): void {
    if (!run.contextReceipts.some((item) => item.agentId === receipt.agentId && item.recordedAt === receipt.recordedAt)) {
      run.contextReceipts.push(structuredClone(receipt));
    }
  }

  private appendActivity(run: RunRecord, message: Message): void {
    const item: RunActivityItem = {
      timestamp: message.timestamp,
      from: message.from,
      to: message.to,
      type: message.type,
      content: redactEvidenceText(String(message.payload.instruction ?? message.payload.message ?? '')),
    };
    run.activity.push(item);
    if (run.activity.length > RUN_ACTIVITY_RETAINED_LIMIT) {
      run.activity.splice(0, run.activity.length - RUN_ACTIVITY_RETAINED_LIMIT);
      run.droppedActivityItems++;
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function scopeSummary(scope: DelegationTaskScope | undefined): { readGrants: number; readwriteGrants: number } | undefined {
  if (!scope?.folderAccess.length) {
    return undefined;
  }
  return {
    readGrants: scope.folderAccess.filter((grant) => grant.permission === 'read').length,
    readwriteGrants: scope.folderAccess.filter((grant) => grant.permission === 'readwrite').length,
  };
}

export function redactEvidenceText(value: string): string {
  let redacted = value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b(api[_-]?key|access[_-]?token|token|password|secret|authorization)\b\s*([:=])\s*[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/(--(?:token|password|secret|api[_-]?key)=(?:[^\s]+))/gi, (match) => `${match.slice(0, match.indexOf('='))}=[redacted]`);
  for (const { expression } of SECRET_PATTERNS) {
    redacted = redacted.replace(new RegExp(expression.source, 'g'), '[redacted secret]');
  }
  return redacted.trim().slice(0, 4000);
}

function normalizeRun(input: unknown): RunRecord | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  // This is the only assertion about persisted data, immediately followed by the field-by-field
  // validation below. Partial avoids claiming that storage supplied every required field.
  const value = input as Partial<StoredRunRecord>;
  if (!value || !isRunSchemaVersion(value.schemaVersion) || typeof value.id !== 'string' || typeof value.coordinatorId !== 'string' ||
    (value.status !== 'open' && value.status !== 'closed') || !Array.isArray(value.delegations)) {
    return undefined;
  }
  const verdicts: RunVerdictEvent[] = [];
  const derivedVerdictWithholdings: RunVerdictWithholding[] = [];
  for (const storedVerdict of Array.isArray(value.verdicts) ? value.verdicts : []) {
    const resolution = normalizeRunVerdictResolution(storedVerdict);
    if (resolution.status === 'accepted') {
      verdicts.push(resolution.verdict);
    } else if (resolution.status === 'withheld') {
      derivedVerdictWithholdings.push({
        reason: resolution.reason,
        acceptedVerdictCount: verdicts.length,
      });
    }
  }
  const restoredVerdictWithholdings = Array.isArray(value.verdictWithholdings)
    ? value.verdictWithholdings
      .filter((entry): entry is RunVerdictWithholding =>
        !!entry && ['non-human-approver', 'invalid-shape', 'invalid-exceptions'].includes(entry.reason))
      .map((entry) => ({
        reason: entry.reason,
        // Old records did not retain order. Conservatively keep judgement withheld until a new valid verdict is appended.
        acceptedVerdictCount: Number.isInteger(entry.acceptedVerdictCount) && entry.acceptedVerdictCount >= 0
          ? Math.min(entry.acceptedVerdictCount, verdicts.length)
          : verdicts.length,
      }))
    : [];
  const verdictWithholdings = [...restoredVerdictWithholdings, ...derivedVerdictWithholdings];
  return {
    schemaVersion: 7,
    id: value.id,
    coordinatorId: value.coordinatorId,
    correlationIds: value.schemaVersion >= 2 && Array.isArray(value.correlationIds)
      ? [...new Set(value.correlationIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
      : [],
    status: value.status,
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : new Date(0).toISOString(),
    ...(typeof value.endedAt === 'string' ? { endedAt: value.endedAt } : {}),
    ...(value.status === 'closed'
      ? value.schemaVersion <= 6
        ? { closeoutCompletionState: 'complete' as const }
        : isRunCloseoutCompletionState(value.closeoutCompletionState)
          ? { closeoutCompletionState: value.closeoutCompletionState }
          : {}
      : {}),
    ...(typeof value.objective === 'string' ? { objective: redactEvidenceText(value.objective) } : {}),
    delegations: value.delegations.map(normalizeDelegation).filter((entry): entry is RunDelegation => !!entry),
    refusedDispatches: Array.isArray(value.refusedDispatches) ? value.refusedDispatches.map(normalizeRefusal).filter((entry): entry is RunRefusedDispatch => !!entry) : [],
    permissions: Array.isArray(value.permissions)
      ? value.permissions.filter(isPermission).map((entry) => ({
        kind: entry.kind,
        agentId: entry.agentId,
        decision: entry.decision,
        recordedAt: entry.recordedAt,
        ...(entry.label ? { label: redactEvidenceText(entry.label) } : {}),
        ...(isContemporaneousApprover(entry.kind, entry.approverId)
          ? { approverId: entry.approverId }
          : {}),
      }))
      : [],
    outcomeRepairs: Array.isArray(value.outcomeRepairs)
      ? value.outcomeRepairs.map(normalizeOutcomeRepair).filter((entry): entry is RunOutcomeRepairEvent => !!entry)
      : [],
    verdicts,
    ...(verdictWithholdings.length > 0 ? { verdictWithholdings } : {}),
    contextReceipts: Array.isArray(value.contextReceipts) ? value.contextReceipts.filter(isContextReceipt).map((entry) => structuredClone(entry)) : [],
    contentReceipts: Array.isArray(value.contentReceipts)
      ? value.contentReceipts.map(sanitizeRunContentReceipt).filter((entry): entry is RunContentReceipt => !!entry)
      : [],
    reviewObservations: Array.isArray(value.reviewObservations)
      ? value.reviewObservations.map(normalizeReviewObservation).filter((entry): entry is ArtifactReviewObservation => !!entry)
      : [],
    activity: Array.isArray(value.activity) ? value.activity.filter(isActivity).map((entry) => ({ ...entry, content: redactEvidenceText(entry.content) })).slice(-RUN_ACTIVITY_RETAINED_LIMIT) : [],
    droppedActivityItems: Math.max(0, Math.floor(Number(value.droppedActivityItems) || 0)),
  };
}

function isRunSchemaVersion(value: unknown): value is RunSchemaVersion {
  return typeof value === 'number' && (RUN_SCHEMA_VERSIONS as readonly number[]).includes(value);
}

function normalizeDelegation(value: RunDelegation): RunDelegation | undefined {
  if (!value || typeof value.handle !== 'string' || typeof value.agentId !== 'string' || value.state !== 'active' && value.state !== 'settled' && value.state !== 'cancelled') {
    return undefined;
  }
  const {
    route: untrustedRoute,
    routing: untrustedRouting,
    diffDigest: untrustedDiffDigest,
    diffDigestUnavailable: untrustedDiffDigestUnavailable,
    verificationPlan: untrustedVerificationPlan,
    contract: untrustedContract,
    attemptId: untrustedAttemptId,
    delivery: untrustedDelivery,
    ...rest
  } = value;
  const route = sanitizeRouteReceipt(untrustedRoute);
  const routing = sanitizeRoutingReceipt(untrustedRouting);
  const diffDigest = sanitizeRunDiffDigest(untrustedDiffDigest);
  const verificationPlan = sanitizeVerificationPlan(untrustedVerificationPlan);
  const contract = sanitizeStoredTaskContract(untrustedContract);
  return {
    ...rest,
    requestedAgent: redactEvidenceText(String(value.requestedAgent ?? '')),
    instruction: redactEvidenceText(String(value.instruction ?? '')),
    dispatchedAt: typeof value.dispatchedAt === 'string' ? value.dispatchedAt : new Date(0).toISOString(),
    ...(route ? { route } : {}),
    ...(routing ? { routing } : {}),
    ...(verificationPlan ? { verificationPlan } : {}),
    ...(contract ? { contract } : {}),
    ...(typeof untrustedAttemptId === 'string' && /^attempt-[a-z0-9-]{1,100}$/i.test(untrustedAttemptId)
      ? { attemptId: untrustedAttemptId }
      : {}),
    ...(value.scopeMode === 'per-turn-requested' || value.scopeMode === 'per-turn-enforced' || value.scopeMode === 'fixed-session-permissions'
      ? { scopeMode: value.scopeMode }
      : {}),
    ...(diffDigest ? { diffDigest } : {}),
    ...(isRunDiffDigestUnavailableReason(untrustedDiffDigestUnavailable)
      ? { diffDigestUnavailable: untrustedDiffDigestUnavailable }
      : {}),
    ...(typeof value.cancelledAt === 'string' ? { cancelledAt: value.cancelledAt } : {}),
    ...(typeof value.settledAt === 'string' ? { settledAt: value.settledAt } : {}),
    ...(typeof value.cancellationReason === 'string' ? { cancellationReason: redactEvidenceText(value.cancellationReason) } : {}),
    ...(sanitizeDelivery(untrustedDelivery) ? { delivery: sanitizeDelivery(untrustedDelivery) } : {}),
    ...(value.evidence ? { evidence: sanitizeEvidence(value.evidence, value.settledAt) } : {}),
    ...(value.progress ? { progress: sanitizeProgress(value.progress) } : {}),
    dispositions: Array.isArray(value.dispositions) ? value.dispositions.map((event) => ({ ...event, ...(event.reason ? { reason: redactEvidenceText(event.reason) } : {}) })) : [],
  };
}

function sanitizeDelivery(value: RunDelegation['delivery'] | unknown): RunDelegation['delivery'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if ((candidate.state !== 'pending' && candidate.state !== 'delivered') || typeof candidate.observedAt !== 'string') {
    return undefined;
  }
  if (candidate.state === 'pending') {
    return { state: 'pending', observedAt: candidate.observedAt };
  }
  const via = candidate.via;
  return via === 'auto-wake' || via === 'collect-ready' || via === 'blocking-tool'
    ? { state: 'delivered', observedAt: candidate.observedAt, via }
    : undefined;
}

function projectCoordinatorTaskStatus(run: RunRecord, delegation: RunDelegation): CoordinatorTaskStatus {
  const evidenceOutcome = delegation.evidence?.outcome;
  const timedOut = evidenceOutcome === 'timed-out';
  const latestDisposition = delegation.dispositions[delegation.dispositions.length - 1];
  const progress = delegation.progress;
  const activity = progress
    ? progress.toolCalls > 0
      ? `${progress.toolCalls} tool call${progress.toolCalls === 1 ? '' : 's'} observed`
      : `${progress.modelRequests} model request${progress.modelRequests === 1 ? '' : 's'} observed`
    : undefined;
  return {
    handle: delegation.handle,
    runId: run.id,
    agentId: delegation.agentId,
    requestedAgent: delegation.requestedAgent,
    lifecycle: timedOut ? 'timed-out' : delegation.state,
    dispatchedAt: delegation.dispatchedAt,
    ...(delegation.state === 'settled'
      ? { terminalAt: delegation.settledAt ?? progress?.settledAt }
      : delegation.state === 'cancelled' ? { terminalAt: delegation.cancelledAt } : {}),
    ...(delegation.state === 'settled'
      ? { delivery: delegation.delivery ? { ...delegation.delivery } : { state: 'not-observed' as const } }
      : {}),
    ...(progress && activity ? { progress: { observedAt: progress.lastMaterialProgressAt, activity } } : {}),
    ...(evidenceOutcome ? { evidenceOutcome } : {}),
    ...(delegation.evidence ? { completionState: delegation.evidence.completionState } : {}),
    ...(typeof delegation.evidence?.requiredInputCount === 'number'
      && typeof delegation.evidence?.requiredInputReadNotObservedCount === 'number'
      ? {
          requiredInputCount: delegation.evidence.requiredInputCount,
          requiredInputReadNotObservedCount: delegation.evidence.requiredInputReadNotObservedCount,
        }
      : {}),
    ...(delegation.evidence?.contextGaps?.length
      ? { contextGaps: delegation.evidence.contextGaps.map(({ inputId, reason }) => ({ inputId, reason })) }
      : {}),
    ...(delegation.evidence?.inputGrants?.length
      ? { inputReceipts: delegation.evidence.inputGrants.map((grant) => ({
        inputId: grant.inputId,
        supplied: true,
        reachable: typeof grant.reachableAt === 'string',
        readReceipt: typeof grant.readAt === 'string' ? 'observed' as const : 'not-observed' as const,
      })) }
      : {}),
    ...(latestDisposition ? { disposition: {
      value: latestDisposition.disposition,
      ...(latestDisposition.replacementHandle ? { replacementHandle: latestDisposition.replacementHandle } : {}),
    } } : {}),
  };
}

function projectPolicyRefusalStatus(run: RunRecord, refusal: RunRefusedDispatch): CoordinatorTaskStatus {
  return {
    handle: refusal.handle!,
    runId: run.id,
    requestedAgent: refusal.requestedAgent,
    lifecycle: 'policy-refused',
    terminalAt: refusal.recordedAt,
    ...(refusal.policyId ? { policyId: refusal.policyId } : {}),
    policyReason: refusal.reason,
  };
}

function sanitizeProgress(value: WorkerTaskProgressRecord): WorkerTaskProgressRecord {
  const safeInteger = (input: unknown): number => Math.max(0, Math.floor(Number(input) || 0));
  const outcome = value?.outcome === 'framework-evidenced-output' ? 'framework-evidenced-output' : 'no-framework-evidence';
  const backend = value?.backend === 'codex' || value?.backend === 'openai-compat' ? value.backend : 'claude';
  return {
    schemaVersion: 1,
    correlationId: typeof value?.correlationId === 'string' ? value.correlationId : '',
    agentId: typeof value?.agentId === 'string' ? value.agentId : '',
    backend,
    model: redactEvidenceText(String(value?.model ?? '')),
    startedAt: typeof value?.startedAt === 'string' ? value.startedAt : new Date(0).toISOString(),
    settledAt: typeof value?.settledAt === 'string' ? value.settledAt : new Date(0).toISOString(),
    durationMs: safeInteger(value?.durationMs),
    modelRequests: safeInteger(value?.modelRequests),
    toolCalls: safeInteger(value?.toolCalls),
    ...(typeof value?.inputTokens === 'number' && Number.isFinite(value.inputTokens) && value.inputTokens >= 0
      ? { inputTokens: Math.floor(value.inputTokens) }
      : {}),
    ...(value?.inputTokensEstimated === true ? { inputTokensEstimated: true } : {}),
    fingerprintSequence: Array.isArray(value?.fingerprintSequence)
      ? value.fingerprintSequence.filter((entry): entry is string => typeof entry === 'string' && /^[A-Za-z0-9_.-]+:[a-f0-9]{16}$/.test(entry)).slice(-1_000)
      : [],
    droppedFingerprintCount: safeInteger(value?.droppedFingerprintCount),
    materialProgressCount: safeInteger(value?.materialProgressCount),
    lastMaterialProgressAt: typeof value?.lastMaterialProgressAt === 'string' ? value.lastMaterialProgressAt : new Date(0).toISOString(),
    longestNoMaterialProgressMs: safeInteger(value?.longestNoMaterialProgressMs),
    outcome,
    hasFinalReply: value?.hasFinalReply === true,
    terminalState: value?.terminalState === 'completed' ? 'completed' : 'error-or-unresolved',
  };
}

function sanitizeEvidence(evidence: DelegationEvidenceRecord, historicalObservedAt?: string): DelegationEvidenceRecord {
  const contextGaps = Array.isArray(evidence.contextGaps)
    ? evidence.contextGaps.map(sanitizeContextGap).filter((gap): gap is TaskContextGap => !!gap)
    : [];
  const taskArtifacts = Array.isArray(evidence.taskArtifacts)
    ? evidence.taskArtifacts.map(sanitizeReadyArtifact).filter((artifact): artifact is ReadyTaskArtifact => !!artifact)
    : [];
  const inputGrants = Array.isArray(evidence.inputGrants)
    ? evidence.inputGrants.map(sanitizeInputGrant).filter((grant): grant is InputGrant => !!grant)
    : [];
  const legacy = evidence as unknown as {
    unreadRequiredInputCount?: unknown;
    outcome: DelegationOutcome | 'required-inputs-unread';
  };
  const rawRequiredInputCount = evidence.requiredInputCount;
  const rawReadNotObservedCount = evidence.requiredInputReadNotObservedCount ?? legacy.unreadRequiredInputCount;
  const requiredInputCount = typeof rawRequiredInputCount === 'number'
    && Number.isSafeInteger(rawRequiredInputCount) && rawRequiredInputCount >= 0
    ? rawRequiredInputCount
    : undefined;
  const requiredInputReadNotObservedCount = typeof rawReadNotObservedCount === 'number'
    && Number.isSafeInteger(rawReadNotObservedCount) && rawReadNotObservedCount >= 0
    && (requiredInputCount === undefined || rawReadNotObservedCount <= requiredInputCount)
    ? rawReadNotObservedCount
    : undefined;
  const receiptSnapshots = sanitizeReceiptSnapshots(evidence.receiptSnapshots);
  if (!receiptSnapshots.terminal && requiredInputCount !== undefined
      && requiredInputReadNotObservedCount !== undefined && historicalObservedAt) {
    receiptSnapshots.terminal = {
      requiredInputCount,
      requiredInputReadNotObservedCount,
      observedAt: historicalObservedAt,
    };
  }
  return {
    outcome: legacy.outcome === 'required-inputs-unread' ? 'required-input-read-not-observed' : legacy.outcome,
    completionState: normalizeDelegationCompletionState(evidence.completionState),
    changedFiles: Array.isArray(evidence.changedFiles) ? evidence.changedFiles.map((file) => redactEvidenceText(String(file))) : [],
    hadToolActions: evidence.hadToolActions === true,
    verification: {
      ran: evidence.verification?.ran === true,
      passed: evidence.verification?.passed === true,
    },
    unrecordedWrites: evidence.unrecordedWrites === true,
    ...(sanitizeVerificationPlan(evidence.verificationPlan) ? { verificationPlan: sanitizeVerificationPlan(evidence.verificationPlan)! } : {}),
    ...(evidence.verificationPlanStatus === 'no-applicable-sensor' || evidence.verificationPlanStatus === 'satisfied' || evidence.verificationPlanStatus === 'not-run' || evidence.verificationPlanStatus === 'failed'
      ? { verificationPlanStatus: evidence.verificationPlanStatus }
      : {}),
    ...(Array.isArray(evidence.verificationSensors)
      ? { verificationSensors: evidence.verificationSensors.filter((sensor) =>
        sensor && typeof sensor === 'object' &&
        ['command-exit-zero', 'editor-diagnostics-clean', 'recorded-file-effect', 'run-checks'].includes(String(sensor.kind)) &&
        ['passed', 'not-run', 'failed'].includes(String(sensor.status))
      ).map((sensor) => ({
        kind: sensor.kind,
        status: sensor.status,
      })) }
      : {}),
    ...(contextGaps.length ? { contextGaps } : {}),
    ...(taskArtifacts.length ? { taskArtifacts } : {}),
    ...(inputGrants.length ? { inputGrants } : {}),
    ...(requiredInputCount === undefined || requiredInputReadNotObservedCount === undefined
      ? {}
      : { requiredInputCount, requiredInputReadNotObservedCount }),
    ...(receiptSnapshots.timeout || receiptSnapshots.terminal ? { receiptSnapshots } : {}),
  };
}

function sanitizeReceiptSnapshots(value: DelegationEvidenceRecord['receiptSnapshots'] | unknown): NonNullable<DelegationEvidenceRecord['receiptSnapshots']> {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const normalize = (entry: unknown) => {
    if (!entry || typeof entry !== 'object') return undefined;
    const snapshot = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(snapshot.requiredInputCount) || Number(snapshot.requiredInputCount) < 0
      || !Number.isSafeInteger(snapshot.requiredInputReadNotObservedCount)
      || Number(snapshot.requiredInputReadNotObservedCount) < 0
      || Number(snapshot.requiredInputReadNotObservedCount) > Number(snapshot.requiredInputCount)
      || typeof snapshot.observedAt !== 'string') return undefined;
    return {
      requiredInputCount: Number(snapshot.requiredInputCount),
      requiredInputReadNotObservedCount: Number(snapshot.requiredInputReadNotObservedCount),
      observedAt: snapshot.observedAt,
    };
  };
  const timeout = normalize(candidate.timeout);
  const terminal = normalize(candidate.terminal);
  return { ...(timeout ? { timeout } : {}), ...(terminal ? { terminal } : {}) };
}

function normalizeDelegationCompletionState(value: unknown): DelegationCompletionState {
  return value === 'complete' || value === 'partial' || value === 'not-observed' ? value : 'not-observed';
}

function isRunCloseoutCompletionState(value: unknown): value is RunCloseoutCompletionState {
  return value === 'complete' || value === 'partial';
}

/** Re-compile persisted contract data through the same strict parser instead of trusting disk rows. */
function sanitizeStoredTaskContract(value: unknown): EffectiveTaskContract | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, any>;
  const effects = raw.effects;
  if (!effects || typeof effects !== 'object') return undefined;
  const inputs = Array.isArray(raw.inputs) ? raw.inputs : undefined;
  const constraints = Array.isArray(raw.constraints) ? raw.constraints : undefined;
  if (!inputs || !constraints) return undefined;
  const proposal = {
    version: raw.version,
    objective: raw.objective,
    expected_deliverable: raw.expectedDeliverable,
    effects: {
      read_files: effects.readFiles,
      ...(effects.writeScope ? {
        write_scope: {
          folder_access: Array.isArray(effects.writeScope.folderAccess)
            ? effects.writeScope.folderAccess.map((entry: any) => ({ path: entry?.path, permission: entry?.permission }))
            : effects.writeScope.folderAccess,
        },
      } : {}),
      expected_file_effect: effects.expectedFileEffect,
    },
    inputs: inputs.map((input: any) => ({
      input_id: input?.inputId,
      kind: input?.kind,
      purpose: input?.purpose,
      required: input?.required,
      provenance: { kind: input?.provenance?.kind, source_refs: input?.provenance?.sourceRefs },
      freshness: input?.freshness,
      ...(input?.kind === 'contentAsset' ? { asset_id: input.assetId } : {}),
      ...(input?.kind === 'workspacePath' ? { path: input.path } : {}),
      ...(input?.kind === 'upstreamArtifact' ? { artifact_id: input.artifactId } : {}),
    })),
    constraints: constraints.map((entry: any) => ({ text: entry?.text, basis_refs: entry?.basisRefs })),
    ...(raw.coordinatorBrief ? {
      coordinator_brief: {
        text: raw.coordinatorBrief.text,
        basis_refs: raw.coordinatorBrief.basisRefs,
      },
    } : {}),
    dependencies: raw.dependencies,
    ...(raw.review ? { review: { input_id: raw.review.inputId } } : {}),
    ...(raw.verificationPlan ? { verification_plan: raw.verificationPlan } : {}),
    required_capabilities: raw.requiredCapabilities,
    execution_strategy: raw.executionStrategy,
  };
  const proposedBy = typeof raw.proposedBy === 'string' && raw.proposedBy.length <= 500 ? raw.proposedBy : '';
  const parsed = compileTaskContract(proposal, proposedBy);
  if (!parsed.contract || typeof raw.contractId !== 'string' || !/^contract-[a-z0-9-]{1,100}$/i.test(raw.contractId)) return undefined;
  if (typeof raw.compiledAt !== 'string' || !Number.isFinite(Date.parse(raw.compiledAt))) return undefined;
  return structuredClone({ ...parsed.contract, contractId: raw.contractId, compiledAt: raw.compiledAt });
}

function sanitizeContextGap(value: unknown): TaskContextGap | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.attemptId !== 'string' || typeof raw.contractId !== 'string' || typeof raw.inputId !== 'string'
    || typeof raw.purpose !== 'string' || typeof raw.reportedAt !== 'string'
    || !['missing', 'expired', 'outside-task-scope', 'unreadable'].includes(String(raw.reason))) return undefined;
  return {
    attemptId: raw.attemptId.slice(0, 150),
    contractId: raw.contractId.slice(0, 150),
    inputId: raw.inputId.slice(0, 80),
    reason: raw.reason as TaskContextGap['reason'],
    purpose: redactEvidenceText(raw.purpose).slice(0, 1_000),
    reportedAt: raw.reportedAt,
  };
}

function sanitizeReadyArtifact(value: unknown): ReadyTaskArtifact | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, any>;
  if (raw.state !== 'artifact-ready' || typeof raw.artifactId !== 'string' || typeof raw.contentAssetId !== 'string'
    || typeof raw.producerAttemptId !== 'string' || typeof raw.producerAgentId !== 'string') return undefined;
  const kinds = new Set(['contentAsset', 'workspacePath', 'upstreamArtifact']);
  return {
    artifactId: raw.artifactId.slice(0, 150),
    contentAssetId: raw.contentAssetId.slice(0, 150),
    producerAttemptId: raw.producerAttemptId.slice(0, 150),
    producerAgentId: raw.producerAgentId.slice(0, 500),
    delegableByAgentIds: Array.isArray(raw.delegableByAgentIds)
      ? raw.delegableByAgentIds.filter((id: unknown): id is string => typeof id === 'string').slice(0, 100)
      : [],
    provenance: Array.isArray(raw.provenance)
      ? raw.provenance.flatMap((entry: any) => typeof entry?.producerAttemptId === 'string'
        && typeof entry?.inputId === 'string' && kinds.has(entry?.kind)
        ? [{ producerAttemptId: entry.producerAttemptId.slice(0, 150), inputId: entry.inputId.slice(0, 80), kind: entry.kind }]
        : []).slice(0, 100)
      : [],
    state: 'artifact-ready',
  };
}

function sanitizeInputGrant(value: unknown): InputGrant | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.attemptId !== 'string' || typeof raw.agentId !== 'string' || typeof raw.inputId !== 'string'
    || typeof raw.sourceRef !== 'string' || typeof raw.suppliedAt !== 'string'
    || (raw.kind !== 'contentAsset' && raw.kind !== 'workspacePath' && raw.kind !== 'upstreamArtifact')) return undefined;
  return {
    attemptId: raw.attemptId.slice(0, 150),
    agentId: raw.agentId.slice(0, 500),
    inputId: raw.inputId.slice(0, 80),
    kind: raw.kind,
    sourceRef: redactEvidenceText(raw.sourceRef).slice(0, 1_000),
    ...(typeof raw.resolvedContentAssetId === 'string' ? { resolvedContentAssetId: raw.resolvedContentAssetId.slice(0, 150) } : {}),
    suppliedAt: raw.suppliedAt,
    ...(typeof raw.reachableAt === 'string' ? { reachableAt: raw.reachableAt } : {}),
    ...(typeof raw.readAt === 'string' ? { readAt: raw.readAt } : {}),
  };
}

function normalizeRefusal(value: RunRefusedDispatch): RunRefusedDispatch | undefined {
  if (!value || typeof value.requestedAgent !== 'string' || typeof value.reason !== 'string' || typeof value.recordedAt !== 'string') {
    return undefined;
  }
  const { taskState, handle, policyId, ...rest } = value;
  return {
    ...rest,
    requestedAgent: redactEvidenceText(value.requestedAgent),
    reason: redactEvidenceText(value.reason),
    ...(typeof handle === 'string' ? { handle: handle.slice(0, 240) } : {}),
    ...(taskState === 'no-executor' || taskState === 'policy-refused' ? { taskState } : {}),
    ...(typeof policyId === 'string' ? { policyId: redactEvidenceText(policyId) } : {}),
  };
}

function normalizeReviewObservation(value: unknown): ArtifactReviewObservation | undefined {
  const item = value as Partial<ArtifactReviewObservation>;
  if (!item || item.schemaVersion !== 1
      || typeof item.artifactId !== 'string' || typeof item.reviewInputId !== 'string'
      || typeof item.producerAttemptId !== 'string' || typeof item.reviewerAttemptId !== 'string'
      || typeof item.artifactReadAt !== 'string' || typeof item.observedAt !== 'string'
      || typeof item.sameReportedModel !== 'boolean' || typeof item.sameConfiguredRouteAndModel !== 'boolean'
      || (item.policyDecision !== 'not-selected' && item.policyDecision !== 'allowed-different-reported-model')) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    artifactId: item.artifactId.slice(0, 180),
    reviewInputId: item.reviewInputId.slice(0, 80),
    producerAttemptId: item.producerAttemptId.slice(0, 150),
    reviewerAttemptId: item.reviewerAttemptId.slice(0, 150),
    artifactReadAt: item.artifactReadAt,
    sameReportedModel: item.sameReportedModel,
    sameConfiguredRouteAndModel: item.sameConfiguredRouteAndModel,
    policyDecision: item.policyDecision,
    observedAt: item.observedAt,
  };
}

function isPermission(value: unknown): value is RunPermissionEvent {
  const item = value as RunPermissionEvent;
  return !!item && typeof item.agentId === 'string' && typeof item.recordedAt === 'string' &&
    ['command-approval', 'write-approval', 'web-access-approval', 'tool-approval', 'folder-access', 'mcp-grant'].includes(item.kind) &&
    (item.decision === 'allowed' || item.decision === 'denied' || item.decision === 'expired');
}

function normalizeOutcomeRepair(value: unknown): RunOutcomeRepairEvent | undefined {
  const item = value as Partial<RunOutcomeRepairEvent>;
  if (!item || typeof item.outcomeId !== 'string' || item.outcomeId.length === 0 || item.outcomeId.length > 240 ||
      typeof item.recordedAt !== 'string' ||
      (item.category !== 'consent-timeout' && item.category !== 'delegate-empty') ||
      (item.state !== 'offered' && item.state !== 'invoked' && item.state !== 'unavailable')) {
    return undefined;
  }
  return {
    outcomeId: item.outcomeId,
    category: item.category,
    state: item.state,
    recordedAt: item.recordedAt,
  };
}

/** A grant exercise and a system fail-closed outcome are not contemporaneous human decisions. */
export function isContemporaneousApprover(
  kind: RunPermissionKind,
  approverId: unknown,
): approverId is string {
  return kind !== 'mcp-grant' && isContemporaneousHumanApprover(approverId);
}

/** A human decision names a real actor now; blank and host/system actors are never converted into one. */
export function isContemporaneousHumanApprover(approverId: unknown): approverId is string {
  return typeof approverId === 'string' && approverId.trim().length > 0 && !approverId.startsWith('system:');
}

/** Latest verdict decision, including an explicit content-free reason when a stored value is withheld. */
export function latestRunVerdictResolution(
  run: Pick<RunRecord, 'verdicts' | 'verdictWithholdings'>,
): RunVerdictResolution {
  const acceptedVerdictCount = run.verdicts.reduce(
    (count, verdict) => count + (normalizeRunVerdictResolution(verdict).status === 'accepted' ? 1 : 0),
    0,
  );
  let withholding: RunVerdictWithholding | undefined;
  for (let index = (run.verdictWithholdings?.length ?? 0) - 1; index >= 0; index -= 1) {
    const candidate = run.verdictWithholdings?.[index];
    if (candidate && candidate.acceptedVerdictCount >= acceptedVerdictCount) {
      withholding = candidate;
      break;
    }
  }
  if (withholding) {
    return { status: 'withheld', reason: withholding.reason };
  }
  const latest = run.verdicts.at(-1);
  if (latest !== undefined) {
    return normalizeRunVerdictResolution(latest);
  }
  return { status: 'absent' };
}

/** Latest append-only human verdict, or undefined for the intentionally visible unjudged/withheld state. */
export function latestRunVerdict(run: Pick<RunRecord, 'verdicts' | 'verdictWithholdings'>): RunVerdictEvent | undefined {
  const resolution = latestRunVerdictResolution(run);
  return resolution.status === 'accepted' ? resolution.verdict : undefined;
}

/** Per-run north-star input: only a human acceptance counts, never a coordinator label or evidence outcome. */
export function acceptedWorkCountForRun(run: Pick<RunRecord, 'verdicts' | 'verdictWithholdings'>): number {
  const verdict = latestRunVerdict(run)?.verdict;
  return verdict === 'accepted' || verdict === 'accepted-with-exceptions' ? 1 : 0;
}

/** Period derivation is intentionally data-only; a later slice may choose how (or whether) to display it. */
export function acceptedWorkCountForPeriod(
  runs: readonly Pick<RunRecord, 'verdicts' | 'verdictWithholdings'>[],
  period: { startsAt: string; endsAt: string },
): number {
  const start = Date.parse(period.startsAt);
  const end = Date.parse(period.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return 0;
  }
  return runs.reduce((count, run) => {
    const verdict = latestRunVerdict(run);
    const recordedAt = verdict ? Date.parse(verdict.recordedAt) : Number.NaN;
    return count + (Number.isFinite(recordedAt) && recordedAt >= start && recordedAt <= end
      ? acceptedWorkCountForRun(run)
      : 0);
  }, 0);
}

export function normalizeRunVerdictResolution(value: unknown): RunVerdictResolution {
  const item = value as Partial<RunVerdictEvent>;
  if (value === undefined) {
    return { status: 'absent' };
  }
  if (!item || !RUN_VERDICTS.has(item.verdict as RunVerdict) ||
      typeof item.recordedAt !== 'string' || typeof item.evidenceReviewedAt !== 'string') {
    return { status: 'withheld', reason: 'invalid-shape' };
  }
  if (!isContemporaneousHumanApprover(item.approverId)) {
    return { status: 'withheld', reason: 'non-human-approver' };
  }
  const unresolvedItems = sanitizeUnresolvedItems(item.unresolvedItems);
  if (item.verdict === 'accepted-with-exceptions' && unresolvedItems.length === 0) {
    return { status: 'withheld', reason: 'invalid-exceptions' };
  }
  return {
    status: 'accepted',
    verdict: { verdict: item.verdict as RunVerdict, approverId: item.approverId, recordedAt: item.recordedAt, evidenceReviewedAt: item.evidenceReviewedAt, unresolvedItems },
  };
}

export function normalizeRunVerdict(value: unknown): RunVerdictEvent | undefined {
  const resolution = normalizeRunVerdictResolution(value);
  return resolution.status === 'accepted' ? resolution.verdict : undefined;
}

export function describeRunVerdictWithholding(reason: RunVerdictWithholdingReason): string {
  switch (reason) {
    case 'non-human-approver':
      return 'A stored verdict was withheld because no contemporaneous human approver was recorded.';
    case 'invalid-exceptions':
      return 'A stored exception verdict was withheld because it contained no valid unresolved items.';
    case 'invalid-shape':
      return 'A stored verdict was withheld because it did not satisfy the durable verdict schema.';
  }
}

function sanitizeUnresolvedItems(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') { continue; }
    const item = redactEvidenceText(raw).slice(0, 400);
    if (item && !items.includes(item)) {
      items.push(item);
      if (items.length === 20) { break; }
    }
  }
  return items;
}

function sanitizeRouteReceipt(value: RunRouteReceipt | undefined): RunRouteReceipt | undefined {
  if (!value || typeof value.routeId !== 'string' || !value.routeId ||
      !['openai-compatible', 'claude-headless', 'codex-headless'].includes(value.connectionKind) ||
      typeof value.executionDomain !== 'string' || !value.executionDomain ||
      !value.privacyDomain || typeof value.privacyDomain.id !== 'string' || !value.privacyDomain.id ||
      !['known', 'unknown', 'unresolved-user-selected'].includes(value.privacyDomain.status)) {
    return undefined;
  }
  return {
    routeId: value.routeId,
    connectionKind: value.connectionKind,
    executionDomain: value.executionDomain,
    privacyDomain: { id: value.privacyDomain.id, status: value.privacyDomain.status },
  };
}

function sanitizeRoutingReceipt(value: DelegationRoutingReceipt | undefined): DelegationRoutingReceipt | undefined {
  if (!value || !['implementation', 'research-or-review', 'general'].includes(value.taskClassification)) {
    return undefined;
  }
  const requiredCapabilities = Array.isArray(value.requiredCapabilities)
    ? value.requiredCapabilities.filter((entry): entry is 'read' | 'write' | 'shell' => entry === 'read' || entry === 'write' || entry === 'shell')
    : [];
  const compatibilityFilters = Array.isArray(value.compatibilityFilters)
    ? value.compatibilityFilters.filter((entry): entry is string => typeof entry === 'string').map(redactEvidenceText).slice(0, 12)
    : [];
  return {
    taskClassification: value.taskClassification,
    requiredCapabilities: [...new Set(requiredCapabilities)],
    compatibilityFilters,
    selectionReason: redactEvidenceText(String(value.selectionReason ?? '')),
  };
}

function sanitizeRunDiffDigest(value: RunDiffDigest | undefined): RunDiffDigest | undefined {
  if (!value || value.algorithm !== 'sha256' || !isSha256(value.value) || !Array.isArray(value.files)) {
    return undefined;
  }
  const files: RunDiffFileHash[] = [];
  for (const file of value.files) {
    if (!file || typeof file.path !== 'string' || !file.path ||
        (file.beforeContentHash !== null && !isSha256(file.beforeContentHash)) ||
        (file.afterContentHash !== null && !isSha256(file.afterContentHash))) {
      return undefined;
    }
    files.push({
      path: file.path,
      beforeContentHash: file.beforeContentHash,
      afterContentHash: file.afterContentHash,
    });
  }
  const rebuilt = makeRunDiffDigest(files);
  return rebuilt.value === value.value ? rebuilt : undefined;
}

function isRunDiffDigestUnavailableReason(value: unknown): value is RunDiffDigestUnavailableReason {
  return value === 'directory-tree-content-not-observed' || value === 'file-content-not-observed' || value === 'unrecorded-write';
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function makeRunDiffDigest(files: readonly RunDiffFileHash[]): RunDiffDigest {
  const sorted = [...files]
    .map((file) => ({ ...file }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const canonical = sorted.map((file) => JSON.stringify([
    file.path,
    file.beforeContentHash,
    file.afterContentHash,
  ])).join('\n');
  return { algorithm: 'sha256', value: sha256(canonical), files: sorted };
}

function isContextReceipt(value: unknown): value is RunContextReceipt {
  const item = value as RunContextReceipt;
  return !!item && typeof item.agentId === 'string' && typeof item.recordedAt === 'string' && Array.isArray(item.entries);
}

function sanitizeRunContentReceipt(value: unknown): RunContentReceipt | undefined {
  const candidate = value as Partial<RunContentReceipt>;
  if (!candidate || typeof candidate.agentId !== 'string' || !candidate.agentId || typeof candidate.recordedAt !== 'string') {
    return undefined;
  }
  const content = sanitizeContentReceipt(candidate as ContentReceiptObservation);
  return content ? { agentId: candidate.agentId, recordedAt: candidate.recordedAt, ...content } : undefined;
}

function isActivity(value: unknown): value is RunActivityItem {
  const item = value as RunActivityItem;
  return !!item && typeof item.timestamp === 'string' && typeof item.from === 'string' && typeof item.to === 'string' &&
    typeof item.type === 'string' && typeof item.content === 'string';
}
