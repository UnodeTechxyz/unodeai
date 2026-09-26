import { DelegationCompletionState, DelegationTaskScope, Message, type RunCloseoutCompletionState } from '../types';
import type { RunRecord } from '../observability/RunLedger';
import type { DelegationInterruptionEvent } from '../backend/TeamTools';

/** Activity keeps the newest summaries; Chat's disappearance sensor shares this exact window. */
export const DELEGATION_PROGRESS_SUMMARY_LIMIT = 12;
/** After this quiet period the UI labels a live task stalled; it never cancels or retries it. */
export const DELEGATION_STALLED_AFTER_MS = 2 * 60_000;

/** Raw completion is not a quality verdict: framework evidence replaces the transient `done` state. */
export type DelegationStatus = 'working' | 'delegating' | 'done' | 'blocked' | 'cancelled' | 'interrupted' | 'policy-refused' | 'verified' | 'verification-failed' | 'no-applicable-sensor' | 'tool-activity-recorded' | 'replied-not-verified' | 'no-evidence' | 'required-input-read-not-observed' | 'timed-out' | 'coordinator-accepted' | 'coordinator-rejected' | 'human-intervention-required';
export type EvidenceDelegationStatus = Extract<DelegationStatus, 'verified' | 'verification-failed' | 'no-applicable-sensor' | 'tool-activity-recorded' | 'replied-not-verified' | 'no-evidence' | 'required-input-read-not-observed' | 'timed-out'>;
export type DelegationProgressPhase = 'request-open' | 'tool-running' | 'tool-result-observed' | 'tool-loop-ended' | 'cancellation-requested' | 'host-wait' | 'host-wait-ended';
export type DelegationLiveState = 'assigned' | 'working' | 'waiting';
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
  | 'superseded'
  | 'abandoned';

export function coordinatorDispositionLabel(disposition: CoordinatorDisposition): string {
  return disposition === 'accepted' ? 'Coordinator accepted'
    : disposition === 'rejected' ? 'Coordinator rejected — amended'
    : disposition === 'needs-human' ? 'Human intervention required'
    : disposition === 'needs-rework' ? 'Coordinator requested rework'
    : disposition === 'deferred' ? 'Coordinator deferred'
    : disposition === 'accepted-with-caveat' ? 'Coordinator accepted with caveat'
    : disposition === 'accepted-after-rework' ? 'Coordinator accepted after rework'
    : disposition === 'accepted-despite-framework-no-evidence' ? 'Coordinator accepted despite framework no-evidence'
    : disposition === 'superseded' ? 'Coordinator superseded task'
    : 'Coordinator abandoned task';
}

export function lateReworkReplyNotice(agentName: string): string {
  return `UnodeAi: ${agentName} replied to the PM's rework request. Ask the PM to review it.`;
}

export function coordinatorDispositionTask(item: Pick<DelegationProgressItem, 'agentName' | 'coordinatorDisposition' | 'dispositionReason' | 'amendedFrom' | 'replacementHandle' | 'reworkReplyAt'>): string | undefined {
  if (item.coordinatorDisposition === 'needs-rework' && item.reworkReplyAt) {
    return lateReworkReplyNotice(item.agentName);
  }
  const disposition = item.coordinatorDisposition;
  if (!disposition) { return undefined; }
  const label = coordinatorDispositionLabel(disposition);
  const reason = item.dispositionReason;
  if (disposition === 'rejected') {
    return `Amended from ${item.amendedFrom ?? 'earlier verdict'}: ${reason ?? 'coordinator rejected the result'}`;
  }
  const replacement = item.replacementHandle ? ` Replacement: ${item.replacementHandle}.` : '';
  return `${reason ? `${label}: ${reason}` : label}${replacement}`;
}

/** User-visible interruption facts. Keep transport loss separate from the later coordinator decision. */
export function interruptionTask(
  item: Pick<DelegationProgressItem, 'agentName' | 'status' | 'interruption' | 'coordinatorDisposition' | 'dispositionReason' | 'amendedFrom' | 'replacementHandle' | 'reworkReplyAt'>,
): string | undefined {
  if (item.status !== 'interrupted' || !item.interruption) return undefined;
  const facts = `Reason: ${item.interruption.reason}. Last observed: ${item.interruption.lastObservedAt}. Detected: ${item.interruption.detectedAt}.`;
  const disposition = coordinatorDispositionTask(item);
  return disposition ? `${facts} ${disposition}` : facts;
}

export function interruptionStatusLabel(
  item: Pick<DelegationProgressItem, 'status' | 'coordinatorDisposition'>,
): string | undefined {
  if (item.status !== 'interrupted') return undefined;
  return [
    'Interrupted — no active worker',
    item.coordinatorDisposition ? coordinatorDispositionLabel(item.coordinatorDisposition) : undefined,
  ].filter((value): value is string => !!value).join(' · ');
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
  /** Count of host-observed provider request boundaries for this task. */
  stepCount: number;
  /** Host-known dependency currently holding the task; never inferred from model narration. */
  waitingOn?: string;
  /** A host safety boundary ended the turn with a partial result. */
  stopped?: boolean;
  stopReason?: string;
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
  replacementHandle?: string;
  /** A completed rework arrived after the coordinator's turn had already ended. */
  reworkReplyAt?: string;
  interruption?: Pick<DelegationInterruptionEvent, 'reason' | 'lastObservedAt' | 'detectedAt'>;
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
  startedAt: string;
  stepCount: number;
  waitingOn?: string;
  liveState?: DelegationLiveState;
  stopped?: boolean;
  stopReason?: string;
  busyCount?: number;
}

export function delegationLiveState(
  item: Pick<DelegationProgressItem, 'updatedAt' | 'stepCount' | 'waitingOn'>,
): DelegationLiveState {
  if (!item.updatedAt && item.stepCount === 0) return 'assigned';
  return item.waitingOn ? 'waiting' : 'working';
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
  private readonly pendingDispositions = new Map<string, { disposition: CoordinatorDisposition; reason?: string; recordedAt: string; replacementHandle?: string }>();
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
          status: delegation.state === 'active' ? 'working'
            : delegation.state === 'cancelled' ? 'cancelled'
            : delegation.state === 'interrupted' ? 'interrupted'
            : 'done',
          ...(delegation.evidence?.completionState ? { completionState: delegation.evidence.completionState } : {}),
          startedAt: delegation.dispatchedAt,
          stepCount: delegation.progress?.modelRequests ?? 0,
          ...(delegation.progress?.terminalState === 'stopped' ? { stopped: true } : {}),
          ...(delegation.state === 'settled' ? { completedAt: delegation.settledAt ?? delegation.progress?.settledAt } : {}),
          ...(delegation.state === 'cancelled' ? { completedAt: delegation.cancelledAt } : {}),
          ...(delegation.interruption ? {
            completedAt: delegation.interruption.detectedAt,
            updatedAt: delegation.interruption.lastObservedAt,
            activity: 'Interrupted — no active worker',
            result: `Interrupted — no active worker (${delegation.interruption.reason}).`,
            interruption: { ...delegation.interruption },
          } : {}),
          ...(!delegation.interruption && delegation.progress ? {
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
        else if (item.status === 'interrupted') summary.blocked++;
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
        if (disposition) this.applyDisposition(
          item,
          disposition.disposition,
          disposition.reason,
          disposition.recordedAt,
          disposition.replacementHandle,
        );
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
          stepCount: 0,
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
      .slice(-DELEGATION_PROGRESS_SUMMARY_LIMIT)
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
            : interruptionTask(item) ?? coordinatorDispositionTask(item) ?? (item.activity || item.instruction),
          coordinatorName: item.coordinatorName,
          updatedAt,
          startedAt: item.startedAt,
          stepCount: item.stepCount,
          ...(item.waitingOn ? { waitingOn: item.waitingOn } : {}),
          ...(item.status === 'working' ? { liveState: delegationLiveState(item) } : {}),
          ...(item.stopped ? { stopped: true, ...(item.stopReason ? { stopReason: item.stopReason } : {}) } : {}),
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
        startedAt: summary.startedAt,
        stepCount: summary.items.reduce((count, item) => count + item.stepCount, 0),
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
  recordDisposition(
    id: string,
    disposition: CoordinatorDisposition,
    reason: string | undefined,
    recordedAt: string,
    replacementHandle?: string,
  ): boolean {
    const summary = this.itemToSummary.get(id);
    const item = summary?.items.find((candidate) => candidate.id === id);
    if (!summary || !item || item.status === 'working') {
      this.pendingDispositions.set(id, { disposition, reason, recordedAt, replacementHandle });
      return false;
    }
    this.applyDisposition(item, disposition, reason, recordedAt, replacementHandle);
    return true;
  }

  /** Record a late reply without fabricating a new coordinator turn or outcome. */
  recordLateReworkReply(id: string, repliedAt: string): string | undefined {
    const summary = this.itemToSummary.get(id);
    const item = summary?.items.find((candidate) => candidate.id === id);
    if (!summary || !item || item.coordinatorDisposition !== 'needs-rework') return undefined;
    item.reworkReplyAt = repliedAt;
    item.updatedAt = repliedAt;
    return lateReworkReplyNotice(item.agentName);
  }

  /** Settle a lost live assignment without presenting it as a worker reply or resuming it later. */
  recordInterruption(id: string, event: DelegationInterruptionEvent): boolean {
    const summary = this.itemToSummary.get(id);
    const item = summary?.items.find((candidate) => candidate.id === id);
    if (!summary || !item || item.status !== 'working') return false;
    item.status = 'interrupted';
    item.completionState = 'not-observed';
    item.interruption = {
      reason: event.reason,
      lastObservedAt: event.lastObservedAt,
      detectedAt: event.detectedAt,
    };
    item.activity = 'Interrupted — no active worker';
    item.result = `Interrupted — no active worker (${event.reason}).`;
    item.updatedAt = event.lastObservedAt;
    item.completedAt = event.detectedAt;
    summary.working = Math.max(0, summary.working - 1);
    summary.blocked += 1;
    this.pendingEvidence.delete(id);
    if (summary.working === 0) summary.completedAt = event.detectedAt;
    const disposition = this.pendingDispositions.get(id);
    if (disposition) {
      this.pendingDispositions.delete(id);
      this.applyDisposition(
        item,
        disposition.disposition,
        disposition.reason,
        disposition.recordedAt,
        disposition.replacementHandle,
      );
    }
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
      stepCount: 0,
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

    const metadata = message.payload.metadata as {
      cancelled?: unknown;
      policyRefused?: unknown;
      interrupted?: unknown;
      interruptionReason?: unknown;
      lastObservedAt?: unknown;
      detectedAt?: unknown;
      stopped?: unknown;
      stopReason?: unknown;
    } | undefined;
    if (metadata?.interrupted === true) {
      return this.recordInterruption(id, {
        coordinatorId: item.coordinatorId,
        handle: id,
        agentId: item.agentId,
        reason: metadata.interruptionReason === 'host-restarted' ? 'host-restarted' : 'worker-lost',
        lastObservedAt: typeof metadata.lastObservedAt === 'string' ? metadata.lastObservedAt : item.updatedAt ?? item.startedAt,
        detectedAt: typeof metadata.detectedAt === 'string' ? metadata.detectedAt : message.timestamp,
      });
    }
    const cancelled = metadata?.cancelled === true;
    item.completionState = message.type === 'task.partial'
      ? 'partial'
      : message.type === 'system.error' ? 'not-observed' : 'complete';
    item.status = metadata?.policyRefused === true
      ? 'policy-refused'
      : cancelled ? 'cancelled' : message.type === 'system.error' ? 'blocked' : 'done';
    item.completedAt = message.timestamp;
    item.stopped = metadata?.stopped === true || undefined;
    item.stopReason = typeof metadata?.stopReason === 'string' ? compactInstruction(metadata.stopReason) : undefined;
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
      this.applyDisposition(item, disposition.disposition, disposition.reason, disposition.recordedAt, disposition.replacementHandle);
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
      if (phase === 'request-open') {
        item.stepCount += 1;
        item.waitingOn = 'model provider';
      } else if (phase === 'host-wait') {
        item.waitingOn = 'your approval';
      } else {
        item.waitingOn = undefined;
      }
    } else if (/^Streaming response\./i.test(activity)) {
      item.waitingOn = undefined;
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
    if (item.status === 'blocked' || item.status === 'cancelled' || item.status === 'interrupted') {
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
    replacementHandle?: string,
  ): void {
    if (item.status === 'cancelled') {
      return;
    }
    const previous = item.status;
    item.coordinatorDisposition = disposition;
    item.dispositionReason = reason;
    item.dispositionAt = recordedAt;
    item.replacementHandle = replacementHandle;
    delete item.reworkReplyAt;
    item.updatedAt = recordedAt;
    if (item.status === 'interrupted') {
      return;
    }
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
    value === 'tool-loop-ended' || value === 'cancellation-requested' || value === 'host-wait' ||
    value === 'host-wait-ended';
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
