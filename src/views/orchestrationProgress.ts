import { DelegationCompletionState, DelegationTaskScope, Message, type RunCloseoutCompletionState } from '../types';
import type { RunRecord } from '../observability/RunLedger';

/** Raw completion is not a quality verdict: framework evidence replaces the transient `done` state. */
export type DelegationStatus = 'working' | 'delegating' | 'done' | 'blocked' | 'cancelled' | 'policy-refused' | 'verified' | 'verification-failed' | 'no-applicable-sensor' | 'tool-activity-recorded' | 'replied-not-verified' | 'no-evidence' | 'required-input-read-not-observed' | 'timed-out' | 'coordinator-accepted' | 'coordinator-rejected' | 'human-intervention-required';
export type EvidenceDelegationStatus = Extract<DelegationStatus, 'verified' | 'verification-failed' | 'no-applicable-sensor' | 'tool-activity-recorded' | 'replied-not-verified' | 'no-evidence' | 'required-input-read-not-observed' | 'timed-out'>;
export type DelegationProgressPhase = 'request-open' | 'tool-running' | 'tool-result-observed' | 'tool-loop-ended' | 'cancellation-requested';
export interface ContextGapTaskState {
  kind: 'context-gap';
  inputId: string;
  reason: 'missing' | 'expired' | 'outside-task-scope' | 'unreadable';
  purpose: string;
  reportedAt: string;
}
export type CoordinatorDisposition =
  | 'accepted'
  | 'rejected'
  | 'needs-human'
  | 'needs-rework'
  | 'deferred'
  | 'accepted-with-caveat'
  | 'accepted-after-rework'
  | 'accepted-despite-framework-no-evidence'
  | 'superseded';

export function coordinatorDispositionLabel(disposition: CoordinatorDisposition): string {
  return disposition === 'accepted' ? 'Coordinator accepted'
    : disposition === 'rejected' ? 'Coordinator rejected — amended'
    : disposition === 'needs-human' ? 'Human intervention required'
    : disposition === 'needs-rework' ? 'Coordinator requested rework'
    : disposition === 'deferred' ? 'Coordinator deferred'
    : disposition === 'accepted-with-caveat' ? 'Coordinator accepted with caveat'
    : disposition === 'accepted-after-rework' ? 'Coordinator accepted after rework'
    : disposition === 'accepted-despite-framework-no-evidence' ? 'Coordinator accepted despite framework no-evidence'
    : 'Coordinator superseded result';
}

export function coordinatorDispositionTask(item: Pick<DelegationProgressItem, 'coordinatorDisposition' | 'dispositionReason' | 'amendedFrom'>): string | undefined {
  const disposition = item.coordinatorDisposition;
  if (!disposition) { return undefined; }
  const label = coordinatorDispositionLabel(disposition);
  const reason = item.dispositionReason;
  if (disposition === 'rejected') {
    return `Amended from ${item.amendedFrom ?? 'earlier verdict'}: ${reason ?? 'coordinator rejected the result'}`;
  }
  return reason ? `${label}: ${reason}` : label;
}

export interface DelegationProgressItem {
  id: string;
  coordinatorId: string;
  coordinatorName: string;
  agentId: string;
  agentName: string;
  instruction: string;
  /** Explicit temporary scope requested for this task; it expires when the task settles. */
  scope?: string;
  /** A missing task scope means fixed session permissions, never task-level isolation. */
  scopeMode: 'per-turn-requested' | 'per-turn-enforced' | 'fixed-session-permissions';
  /** Last framework-observed activity. A status is deliberately not a completion. */
  activity?: string;
  /** Lifecycle phase declared from a host event, never from the model's prose. */
  phase?: DelegationProgressPhase;
  status: DelegationStatus;
  /** Terminal transport shape, independent from evidence status and coordinator disposition. */
  completionState?: DelegationCompletionState;
  startedAt: string;
  updatedAt?: string;
  completedAt?: string;
  result?: string;
  /** The original host-observed evidence verdict, retained when a coordinator later amends the display. */
  evidenceOutcome?: EvidenceDelegationStatus;
  coordinatorDisposition?: CoordinatorDisposition;
  dispositionReason?: string;
  dispositionAt?: string;
  /** A rejection never silently rewrites an earlier framework verdict. */
  amendedFrom?: EvidenceDelegationStatus | DelegationStatus;
  /** Independent from the framework outcome and any coordinator disposition. */
  taskState?: ContextGapTaskState;
}

export interface DelegationProgressSummary {
  id: string;
  coordinatorId: string;
  coordinatorName: string;
  startedAt: string;
  completedAt?: string;
  /** Run ownership closeout, independent from each delegation's terminal and evidence state. */
  closeoutCompletionState?: RunCloseoutCompletionState;
  total: number;
  done: number;
  partial: number;
  blocked: number;
  cancelled?: number;
  working: number;
  verified?: number;
  toolActivityRecorded?: number;
  repliedNotVerified?: number;
  verificationFailed?: number;
  noApplicableSensor?: number;
  noEvidence?: number;
  requiredInputReadReceiptsNotObserved?: number;
  items: DelegationProgressItem[];
}

export interface DelegationAgentState {
  agentId: string;
  status: DelegationStatus;
  completionState?: DelegationCompletionState;
  task: string;
  coordinatorName: string;
  updatedAt: string;
  busyCount?: number;
}

export type DelegationNameResolver = (id: string) => string;

export class OrchestrationProgressTracker {
  private readonly summaries: DelegationProgressSummary[] = [];
  private readonly itemToSummary = new Map<string, DelegationProgressSummary>();
  private readonly currentByCoordinator = new Map<string, DelegationProgressSummary>();
  private sequence = 0;
  /** TeamTools can finish before the MessageBus listener receives task.complete; retain the verdict. */
  private readonly pendingEvidence = new Map<string, EvidenceDelegationStatus>();
  /** A disposition can race the bus completion in the same way evidence can; retain it until the item settles. */
  private readonly pendingDispositions = new Map<string, { disposition: CoordinatorDisposition; reason?: string; recordedAt: string }>();
  private readonly pendingTaskStates = new Map<string, ContextGapTaskState>();
  /** Session start can race task.assign's synchronous UI receipt. */
  private readonly pendingScopeApplications = new Set<string>();

  constructor(private readonly resolveName: DelegationNameResolver) {}

  /** Rebuild the bounded Activity projection from durable lifecycle facts after a host reload. */
  hydrate(records: readonly RunRecord[]): void {
    this.summaries.splice(0);
    this.itemToSummary.clear();
    this.currentByCoordinator.clear();
    this.pendingEvidence.clear();
    this.pendingDispositions.clear();
    this.pendingTaskStates.clear();
    this.pendingScopeApplications.clear();
    this.sequence = 0;

    for (const run of records.slice(-16)) {
      const policyRefusals = run.refusedDispatches.filter((refusal) =>
        refusal.taskState === 'policy-refused' && typeof refusal.handle === 'string');
      if (run.delegations.length === 0 && policyRefusals.length === 0) continue;
      const summary: DelegationProgressSummary = {
        id: `delegation-restored-${++this.sequence}`,
        coordinatorId: run.coordinatorId,
        coordinatorName: this.resolveName(run.coordinatorId),
        startedAt: run.startedAt,
        ...(run.endedAt ? { completedAt: run.endedAt } : {}),
        ...(run.closeoutCompletionState ? { closeoutCompletionState: run.closeoutCompletionState } : {}),
        total: 0,
        done: 0,
        partial: 0,
        blocked: 0,
        cancelled: 0,
        working: 0,
        items: [],
      };
      this.summaries.push(summary);
      for (const delegation of run.delegations) {
        const item: DelegationProgressItem = {
          id: delegation.handle,
          coordinatorId: run.coordinatorId,
          coordinatorName: summary.coordinatorName,
          agentId: delegation.agentId,
          agentName: this.resolveName(delegation.agentId),
          instruction: compactInstruction(delegation.instruction),
          scopeMode: delegation.scopeMode ?? 'fixed-session-permissions',
          status: delegation.state === 'active' ? 'working' : delegation.state === 'cancelled' ? 'cancelled' : 'done',
          ...(delegation.evidence?.completionState ? { completionState: delegation.evidence.completionState } : {}),
          startedAt: delegation.dispatchedAt,
          ...(delegation.state === 'settled' ? { completedAt: delegation.settledAt ?? delegation.progress?.settledAt } : {}),
          ...(delegation.state === 'cancelled' ? { completedAt: delegation.cancelledAt } : {}),
          ...(delegation.progress ? {
            activity: delegation.progress.toolCalls > 0
              ? `${delegation.progress.toolCalls} tool call${delegation.progress.toolCalls === 1 ? '' : 's'} observed`
              : `${delegation.progress.modelRequests} model request${delegation.progress.modelRequests === 1 ? '' : 's'} observed`,
            updatedAt: delegation.progress.lastMaterialProgressAt,
          } : {}),
        };
        summary.items.push(item);
        summary.total++;
        this.itemToSummary.set(item.id, summary);
        if (item.status === 'working') summary.working++;
        else if (item.status === 'cancelled') summary.cancelled = (summary.cancelled ?? 0) + 1;
        else if (item.completionState === 'partial') summary.partial++;
        else if (item.completionState === 'not-observed') summary.blocked++;
        else summary.done++;

        if (delegation.state === 'settled' && delegation.evidence?.outcome) {
          this.applyEvidence(summary, item, delegation.evidence.outcome);
        }
        const gap = delegation.evidence?.contextGaps?.[0];
        if (gap) {
          item.taskState = {
            kind: 'context-gap',
            inputId: compactInstruction(gap.inputId),
            reason: gap.reason,
            purpose: compactInstruction(gap.purpose),
            reportedAt: gap.reportedAt,
          };
        }
        const disposition = delegation.dispositions[delegation.dispositions.length - 1];
        if (disposition) this.applyDisposition(item, disposition.disposition, disposition.reason, disposition.recordedAt);
      }
      for (const refusal of policyRefusals) {
        const target = refusal.requestedAgent;
        const item: DelegationProgressItem = {
          id: refusal.handle!,
          coordinatorId: run.coordinatorId,
          coordinatorName: summary.coordinatorName,
          agentId: target,
          agentName: this.resolveName(target),
          instruction: compactInstruction(refusal.reason),
          scopeMode: 'fixed-session-permissions',
          status: 'policy-refused',
          startedAt: refusal.recordedAt,
          completedAt: refusal.recordedAt,
          result: compactInstruction(refusal.reason),
        };
        summary.items.push(item);
        summary.total++;
        summary.blocked++;
        this.itemToSummary.set(item.id, summary);
      }
      if (summary.working > 0) this.currentByCoordinator.set(run.coordinatorId, summary);
      if (!summary.completedAt && summary.working === 0) {
        summary.completedAt = summary.items.reduce((latest, item) => {
          const candidate = item.completedAt ?? item.updatedAt ?? item.startedAt;
          return candidate > latest ? candidate : latest;
        }, summary.startedAt);
      }
    }
  }

  recordMessage(message: Message): boolean {
    if (message.type === 'task.assign') {
      return this.recordAssign(message);
    }
    if (message.type === 'task.status') {
      return this.recordStatus(message);
    }
    if (message.type === 'task.complete' || message.type === 'task.partial' || message.type === 'system.error') {
      return this.recordCompletion(message);
    }
    return false;
  }

  snapshot(): DelegationProgressSummary[] {
    return this.summaries
      .slice(-12)
      .map((summary) => ({
        ...summary,
        items: summary.items.map((item) => ({ ...item })),
      }));
  }

  agentStates(): DelegationAgentState[] {
    const latest = new Map<string, DelegationAgentState>();
    const busyCounts = new Map<string, number>();
    for (const summary of this.summaries) {
      for (const item of summary.items) {
        if (item.status === 'working') {
          busyCounts.set(item.agentId, (busyCounts.get(item.agentId) ?? 0) + 1);
        }
      }
    }
    for (const summary of this.summaries) {
      for (const item of summary.items) {
        const updatedAt = item.updatedAt ?? item.completedAt ?? item.startedAt;
        const previous = latest.get(item.agentId);
        if (previous && previous.updatedAt >= updatedAt) {
          continue;
        }
        latest.set(item.agentId, {
          agentId: item.agentId,
          status: item.status,
          ...(item.completionState ? { completionState: item.completionState } : {}),
          task: item.taskState?.kind === 'context-gap'
            ? `Context gap ${item.taskState.reason}: ${item.taskState.inputId} — ${item.taskState.purpose}`
            : coordinatorDispositionTask(item) ?? (item.activity || item.instruction),
          coordinatorName: item.coordinatorName,
          updatedAt,
          busyCount: busyCounts.get(item.agentId),
        });
      }
    }
    for (const summary of this.summaries) {
      if (summary.working <= 0) { continue; }
      latest.set(summary.coordinatorId, {
        agentId: summary.coordinatorId,
        status: 'delegating',
        task: `${summary.working} task${summary.working === 1 ? '' : 's'} out`,
        coordinatorName: summary.coordinatorName,
        updatedAt: summary.startedAt,
        busyCount: summary.working,
      });
    }
    return Array.from(latest.values());
  }

  /** Apply the TeamTools framework verdict to a delegation, even if task.complete has not arrived yet. */
  recordEvidence(id: string, status: EvidenceDelegationStatus): boolean {
    const summary = this.itemToSummary.get(id);
    const item = summary?.items.find((candidate) => candidate.id === id);
    // Defer when the item doesn't exist yet OR is still 'working': recordCompletion must decrement the
    // working count first, then drain pendingEvidence. Otherwise evidence-before-completion would move the
    // status off 'working', recordCompletion would bail at its guard, and `working` (the "delegating — N out"
    // card and busyCount) would stick forever.
    if (!summary || !item || item.status === 'working') {
      this.pendingEvidence.set(id, status);
      return false;
    }
    this.applyEvidence(summary, item, status);
    return true;
  }

  recordTaskState(id: string, state: ContextGapTaskState): boolean {
    const summary = this.itemToSummary.get(id);
    const item = summary?.items.find((candidate) => candidate.id === id);
    const safe = {
      ...state,
      inputId: compactInstruction(state.inputId),
      purpose: compactInstruction(state.purpose),
    };
    if (!item) {
      this.pendingTaskStates.set(id, safe);
      return false;
    }
    item.taskState = safe;
    item.updatedAt = safe.reportedAt;
    return true;
  }

  recordCancellation(id: string, cancelledAt: string): boolean {
    const summary = this.itemToSummary.get(id);
    const item = summary?.items.find((candidate) => candidate.id === id);
    if (!summary || !item || item.status !== 'working') return false;
    item.status = 'cancelled';
    item.completedAt = cancelledAt;
    item.updatedAt = cancelledAt;
    summary.working = Math.max(0, summary.working - 1);
    summary.cancelled = (summary.cancelled ?? 0) + 1;
    if (summary.working === 0) summary.completedAt = cancelledAt;
    return true;
  }

  /** Apply the coordinator's explicit decision. It is a captured decision, never a new quality verdict. */
  recordDisposition(id: string, disposition: CoordinatorDisposition, reason: string | undefined, recordedAt: string): boolean {
    const summary = this.itemToSummary.get(id);
    const item = summary?.items.find((candidate) => candidate.id === id);
    if (!summary || !item || item.status === 'working') {
      this.pendingDispositions.set(id, { disposition, reason, recordedAt });
      return false;
    }
    this.applyDisposition(item, disposition, reason, recordedAt);
    return true;
  }

  /** Upgrade only a requested scope when the extension host actually applied it for this turn. */
  recordTaskScopeApplied(id: string): boolean {
    const summary = this.itemToSummary.get(id);
    const item = summary?.items.find((candidate) => candidate.id === id);
    if (!item) {
      this.pendingScopeApplications.add(id);
      return false;
    }
    if (item.scope) {
      item.scopeMode = 'per-turn-enforced';
      return true;
    }
    return false;
  }

  private recordAssign(message: Message): boolean {
    if (message.from === 'user' || message.to === '*' || message.from === message.to) {
      return false;
    }
    const id = message.correlationId ?? message.id;
    if (this.itemToSummary.has(id)) {
      return false;
    }

    let summary = this.currentByCoordinator.get(message.from);
    if (!summary || summary.working === 0) {
      summary = {
        id: `delegation-${++this.sequence}`,
        coordinatorId: message.from,
        coordinatorName: this.resolveName(message.from),
        startedAt: message.timestamp,
        total: 0,
        done: 0,
        partial: 0,
        blocked: 0,
        working: 0,
        items: [],
      };
      this.currentByCoordinator.set(message.from, summary);
      this.summaries.push(summary);
      this.trimSummaries();
    }

    const item: DelegationProgressItem = {
      id,
      coordinatorId: message.from,
      coordinatorName: summary.coordinatorName,
      agentId: message.to,
      agentName: this.resolveName(message.to),
      instruction: compactInstruction(message.payload?.instruction ?? message.payload?.message ?? ''),
      scope: compactTaskScope(message.payload.taskScope),
      scopeMode: message.payload.taskScope ? 'per-turn-requested' : 'fixed-session-permissions',
      status: 'working',
      startedAt: message.timestamp,
    };
    if (this.pendingScopeApplications.delete(id) && item.scope) {
      item.scopeMode = 'per-turn-enforced';
    }
    summary.items.push(item);
    summary.total += 1;
    summary.working += 1;
    delete summary.completedAt;
    this.itemToSummary.set(id, summary);
    return true;
  }

  private recordCompletion(message: Message): boolean {
    const id = message.correlationId;
    if (!id) {
      return false;
    }
    const summary = this.itemToSummary.get(id);
    if (!summary) {
      return false;
    }
    const item = summary.items.find((candidate) => candidate.id === id);
    if (!item || item.status !== 'working') {
      return false;
    }

    const metadata = message.payload.metadata as { cancelled?: unknown; policyRefused?: unknown } | undefined;
    const cancelled = metadata?.cancelled === true;
    item.completionState = message.type === 'task.partial'
      ? 'partial'
      : message.type === 'system.error' ? 'not-observed' : 'complete';
    item.status = metadata?.policyRefused === true
      ? 'policy-refused'
      : cancelled ? 'cancelled' : message.type === 'system.error' ? 'blocked' : 'done';
    item.completedAt = message.timestamp;
    item.result = compactInstruction(message.payload?.instruction ?? message.payload?.message ?? '');
    summary.working = Math.max(0, summary.working - 1);
    if (item.status === 'cancelled') {
      summary.cancelled = (summary.cancelled ?? 0) + 1;
    } else if (item.status === 'blocked' || item.status === 'policy-refused') {
      summary.blocked += 1;
    } else if (item.completionState === 'partial') {
      summary.partial += 1;
    } else {
      summary.done += 1;
    }
    const evidence = this.pendingEvidence.get(id);
    if (evidence) {
      this.pendingEvidence.delete(id);
      this.applyEvidence(summary, item, evidence);
    }
    const disposition = this.pendingDispositions.get(id);
    if (disposition) {
      this.pendingDispositions.delete(id);
      this.applyDisposition(item, disposition.disposition, disposition.reason, disposition.recordedAt);
    }
    const taskState = this.pendingTaskStates.get(id);
    if (taskState) {
      this.pendingTaskStates.delete(id);
      item.taskState = taskState;
      item.updatedAt = taskState.reportedAt;
    }
    if (summary.working === 0) {
      summary.completedAt = message.timestamp;
    }
    return true;
  }

  /** Update a working delegation without changing its completion counters or event kind. */
  private recordStatus(message: Message): boolean {
    const id = message.correlationId;
    if (!id) {
      return false;
    }
    const summary = this.itemToSummary.get(id);
    const item = summary?.items.find((candidate) => candidate.id === id);
    if (!summary || !item || item.status !== 'working') {
      return false;
    }
    const activity = compactInstruction(message.payload?.instruction ?? message.payload?.message ?? '');
    if (!activity) {
      return false;
    }
    item.activity = activity;
    const phase = (message.payload.metadata as { phase?: unknown } | undefined)?.phase;
    if (isDelegationProgressPhase(phase)) {
      item.phase = phase;
    }
    item.updatedAt = message.timestamp;
    return true;
  }

  private applyEvidence(
    summary: DelegationProgressSummary,
    item: DelegationProgressItem,
    status: EvidenceDelegationStatus
  ): void {
    if (item.status === status) { return; }
    if (item.status === 'blocked' || item.status === 'cancelled') {
      return; // an actual task error remains blocked; it cannot be upgraded by a stale verdict.
    }
    item.status = status;
    item.evidenceOutcome = status;
    if (status === 'verified') {
      summary.verified = (summary.verified ?? 0) + 1;
    } else if (status === 'tool-activity-recorded') {
      summary.toolActivityRecorded = (summary.toolActivityRecorded ?? 0) + 1;
    } else if (status === 'replied-not-verified') {
      summary.repliedNotVerified = (summary.repliedNotVerified ?? 0) + 1;
    } else if (status === 'verification-failed') {
      summary.verificationFailed = (summary.verificationFailed ?? 0) + 1;
    } else if (status === 'no-applicable-sensor') {
      summary.noApplicableSensor = (summary.noApplicableSensor ?? 0) + 1;
    } else if (status === 'required-input-read-not-observed') {
      summary.requiredInputReadReceiptsNotObserved = (summary.requiredInputReadReceiptsNotObserved ?? 0) + 1;
    } else {
      summary.noEvidence = (summary.noEvidence ?? 0) + 1;
    }
  }

  private applyDisposition(
    item: DelegationProgressItem,
    disposition: CoordinatorDisposition,
    reason: string | undefined,
    recordedAt: string,
  ): void {
    if (item.status === 'cancelled') {
      return;
    }
    const previous = item.status;
    item.coordinatorDisposition = disposition;
    item.dispositionReason = reason;
    item.dispositionAt = recordedAt;
    item.updatedAt = recordedAt;
    if (disposition === 'accepted' || disposition === 'accepted-with-caveat' ||
      disposition === 'accepted-after-rework' || disposition === 'accepted-despite-framework-no-evidence') {
      item.status = 'coordinator-accepted';
      return;
    }
    if (disposition === 'needs-human') {
      item.status = 'human-intervention-required';
      return;
    }
    // Keep the observed verdict as an immutable fact and show that the later rejection amended it.
    item.amendedFrom = item.evidenceOutcome ?? previous;
    item.status = 'coordinator-rejected';
  }

  private trimSummaries(): void {
    while (this.summaries.length > 16) {
      const removed = this.summaries.shift();
      if (!removed) {
        break;
      }
      if (this.currentByCoordinator.get(removed.coordinatorId)?.id === removed.id) {
        this.currentByCoordinator.delete(removed.coordinatorId);
      }
      for (const item of removed.items) {
        this.itemToSummary.delete(item.id);
        this.pendingDispositions.delete(item.id);
        this.pendingTaskStates.delete(item.id);
      }
    }
  }
}

function compactInstruction(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function isDelegationProgressPhase(value: unknown): value is DelegationProgressPhase {
  return value === 'request-open' || value === 'tool-running' || value === 'tool-result-observed' ||
    value === 'tool-loop-ended' || value === 'cancellation-requested';
}

function compactTaskScope(scope: DelegationTaskScope | undefined): string | undefined {
  if (!scope?.folderAccess?.length) {
    return undefined;
  }
  const entries = scope.folderAccess
    .filter((grant) => typeof grant.path === 'string' && (grant.permission === 'read' || grant.permission === 'readwrite'))
    .map((grant) => `${grant.permission === 'read' ? 'read-only' : 'read/write'} ${grant.path.trim()}`)
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries.join(', ').slice(0, 160) : undefined;
}
