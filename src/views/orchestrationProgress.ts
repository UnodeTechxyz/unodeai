import { DelegationCompletionState, DelegationTaskScope, Message, type RunCloseoutCompletionState } from '../types';
import { runPresentationKey, type RunCardCloseout, type RunRecord } from '../observability/RunLedger';
import type { DelegationInterruptionEvent } from '../backend/TeamTools';
import type { RetryLinkGap, RetryStage } from '../backend/TaskContract';
import {
  projectStandingWork,
  type HistoricalReason,
  type StandingWorkAttempt,
  type StandingWorkLifecycle,
} from '../observability/StandingWork';
import { describeEmptyReply, emptyReplyReason, parseResponseOutcome } from '../backend/emptyReplyOutcome';

/**
 * Activity keeps the newest FINISHED summaries; Chat's disappearance sensor shares this exact window. v0.9.104 (ROADMAP
 * item 3, the Owner, 2026-11-15): a summary with a task still running is always kept, however many runs are newer.
 */
export const DELEGATION_PROGRESS_SUMMARY_LIMIT = 12;
/** How many summaries are kept in memory beyond the shown window; never one that is still running. */
const DELEGATION_PROGRESS_RETAINED = 16;
/** v0.9.104 (item 3): a run with a task still working. */
export const delegationRunning = (summary: Pick<DelegationProgressSummary, 'items'>): boolean =>
  summary.items.some((item) => item.status === 'working');
/** After this quiet period the UI labels a live task stalled; it never cancels or retries it. */
export const DELEGATION_STALLED_AFTER_MS = 2 * 60_000;

/** Raw completion is not a quality verdict: framework evidence replaces the transient `done` state. */
export type DelegationStatus = 'working' | 'delegating' | 'done' | 'blocked' | 'cancelled' | 'interrupted' | 'policy-refused' | 'not-started' | 'verified' | 'verification-failed' | 'no-applicable-sensor' | 'tool-activity-recorded' | 'replied-not-verified' | 'no-evidence' | 'required-input-read-not-observed' | 'timed-out' | 'coordinator-accepted' | 'coordinator-rejected' | 'human-intervention-required';
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

/** v0.9.90 §7.3: a rejected empty reply names the observed cause, never "returned nothing" or a diagnosis. */
export function emptyReplyRejectionTask(emptyReply: string, coordinatorReason: string | undefined): string {
  return `Rejected — ${emptyReply}.${coordinatorReason ? ` Coordinator: ${coordinatorReason}` : ''}`;
}

export function coordinatorDispositionTask(item: Pick<DelegationProgressItem, 'agentName' | 'coordinatorDisposition' | 'dispositionReason' | 'amendedFrom' | 'replacementHandle' | 'reworkReplyAt' | 'emptyReply'>): string | undefined {
  if (item.coordinatorDisposition === 'needs-rework' && item.reworkReplyAt) {
    return lateReworkReplyNotice(item.agentName);
  }
  const disposition = item.coordinatorDisposition;
  if (!disposition) { return undefined; }
  const label = coordinatorDispositionLabel(disposition);
  const reason = item.dispositionReason;
  if (disposition === 'rejected' && item.emptyReply) {
    return emptyReplyRejectionTask(item.emptyReply, reason);
  }
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
  /** v0.9.90 §7: the worker's turn ended with an empty reply; this is the observed cause, never a diagnosis. */
  emptyReply?: string;
  /** The typed retry link the host wrote at dispatch, when this attempt retries an earlier one. */
  retryOfHandle?: string;
  retryStage?: RetryStage;
  retryLinkGap?: RetryLinkGap;
  /** File changes the host refused for this attempt and that it never made, and whether it made any. */
  effects?: { refusedOutstanding: number; succeeded: boolean };
  /** Set when the attempt is history: superseded by the coordinator, or retried by the host. It is not counted. */
  historical?: HistoricalReason;
}

export interface DelegationProgressSummary {
  id: string;
  /** Rebuilt from the run ledger after a reload; the chat places it by its start time among persisted items. */
  restored?: true;
  coordinatorId: string;
  coordinatorName: string;
  startedAt: string;
  completedAt?: string;
  /** Run ownership closeout, independent from each delegation's terminal and evidence state. */
  closeoutCompletionState?: RunCloseoutCompletionState;
  /** Standing attempts. A superseded or retried attempt stays in `items` and is counted in `historical` only. */
  total: number;
  historical?: number;
  done: number;
  partial: number;
  blocked: number;
  cancelled?: number;
  /**
   * v0.9.106 (retest 3, T4): dispatches whose teammate's start was refused, so it never took the task. They are not
   * tasks and are in none of the counts above; the agent's own row shows its state.
   */
  notStarted?: number;
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
/**
 * The run a coordinator's assignment belongs to, as a stable key (F7-20). Undefined when the host cannot tell
 * (for example a workflow dispatch with no coordinator turn): such cards keep per-coordinator grouping.
 */
export type DelegationRunKeyResolver = (message: Message) => string | undefined;

export class OrchestrationProgressTracker {
  private readonly summaries: DelegationProgressSummary[] = [];
  private readonly itemToSummary = new Map<string, DelegationProgressSummary>();
  private readonly currentByCoordinator = new Map<string, DelegationProgressSummary>();
  /** One card per run: live assignments and restored runs share this key, so a reload keeps the same cards. */
  private readonly summaryByRunKey = new Map<string, DelegationProgressSummary>();
  private sequence = 0;
  /** TeamTools can finish before the MessageBus listener receives task.complete; retain the verdict. */
  private readonly pendingEvidence = new Map<string, EvidenceDelegationStatus>();
  /** A disposition can race the bus completion in the same way evidence can; retain it until the item settles. */
  private readonly pendingDispositions = new Map<string, { disposition: CoordinatorDisposition; reason?: string; recordedAt: string; replacementHandle?: string }>();
  private readonly pendingTaskStates = new Map<string, ContextGapTaskState>();
  /** Session start can race task.assign's synchronous UI receipt. */
  private readonly pendingScopeApplications = new Set<string>();
  /** The admission receipt can come before the task.assign that opens the card's row. */
  private readonly pendingAdmittedScopes = new Map<string, string>();

  constructor(
    private readonly resolveName: DelegationNameResolver,
    private readonly runKeyFor?: DelegationRunKeyResolver,
  ) {}

  /**
   * A run the ledger closes while its card is on screen, by its coordinator's closeout or by the host (F7-23),
   * shows that closeout at once instead of only after a reload (field test, 2026-09-26). Returns true when a card
   * changed.
   */
  applyRunCloseouts(closeouts: readonly RunCardCloseout[]): boolean {
    let changed = false;
    for (const closeout of closeouts) {
      const summary = this.summaryByRunKey.get(closeout.key);
      if (!summary || summary.closeoutCompletionState === closeout.closeoutCompletionState) continue;
      summary.closeoutCompletionState = closeout.closeoutCompletionState;
      if (closeout.endedAt) summary.completedAt = closeout.endedAt;
      changed = true;
    }
    return changed;
  }

  /**
   * Re-resolve every coordinator and agent name. Restored cards are built before the roster loads (F7-20), and a
   * roster change can rename an agent; this is called after both. Returns true when anything changed.
   */
  refreshNames(): boolean {
    let changed = false;
    for (const summary of this.summaries) {
      const coordinatorName = this.resolveName(summary.coordinatorId);
      if (coordinatorName !== summary.coordinatorName) {
        summary.coordinatorName = coordinatorName;
        changed = true;
      }
      for (const item of summary.items) {
        const agentName = this.resolveName(item.agentId);
        if (agentName !== item.agentName || coordinatorName !== item.coordinatorName) {
          item.agentName = agentName;
          item.coordinatorName = coordinatorName;
          changed = true;
        }
      }
    }
    return changed;
  }

  /** Rebuild the bounded Activity projection from durable lifecycle facts after a host reload. */
  hydrate(records: readonly RunRecord[]): void {
    this.summaries.splice(0);
    this.itemToSummary.clear();
    this.currentByCoordinator.clear();
    this.summaryByRunKey.clear();
    this.pendingEvidence.clear();
    this.pendingDispositions.clear();
    this.pendingTaskStates.clear();
    this.pendingScopeApplications.clear();
    this.pendingAdmittedScopes.clear();
    this.sequence = 0;

    // v0.9.104 (item 3): every run with a task still active, and the newest others up to the retained count.
    const active = (run: RunRecord) => run.delegations.some((delegation) => delegation.state === 'active');
    const restoredOthers = new Set(records.filter((run) => !active(run)).slice(-DELEGATION_PROGRESS_RETAINED));
    for (const run of records.filter((record) => active(record) || restoredOthers.has(record))) {
      // v0.9.106 (retest 3): a dispatch whose teammate never started is restored as one, as a policy refusal is.
      const policyRefusals = run.refusedDispatches.filter((refusal) =>
        (refusal.taskState === 'policy-refused' || refusal.taskState === 'not-started') && typeof refusal.handle === 'string');
      if (run.delegations.length === 0 && policyRefusals.length === 0) continue;
      const runKey = runPresentationKey(run);
      const summary: DelegationProgressSummary = {
        id: `delegation-run-${runKey}`,
        restored: true,
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
      this.summaryByRunKey.set(runKey, summary);
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
          ...(delegation.retryOfHandle !== undefined ? { retryOfHandle: delegation.retryOfHandle } : {}),
          ...(delegation.retryStage !== undefined ? { retryStage: delegation.retryStage } : {}),
          ...(delegation.retryLinkGap !== undefined ? { retryLinkGap: delegation.retryLinkGap } : {}),
          ...(delegation.state === 'settled' && delegation.evidence ? effectsOf(delegation.evidence) : {}),
        };
        summary.items.push(item);
        this.itemToSummary.set(item.id, summary);

        if (delegation.state === 'settled' && delegation.evidence?.outcome) {
          this.applyEvidence(summary, item, delegation.evidence.outcome);
        }
        if (delegation.evidence?.responseOutcome?.kind === 'empty-reply') {
          item.emptyReply = emptyReplyReason(delegation.evidence.responseOutcome.attempts);
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
        // A superseded or abandoned decision is final: the first one stands, whatever a legacy ledger appended.
        const disposition = delegation.dispositions.find((entry) =>
          entry.disposition === 'superseded' || entry.disposition === 'abandoned')
          ?? delegation.dispositions[delegation.dispositions.length - 1];
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
          status: refusal.taskState === 'not-started' ? 'not-started' : 'policy-refused',
          startedAt: refusal.recordedAt,
          stepCount: 0,
          completedAt: refusal.recordedAt,
          result: compactInstruction(refusal.reason),
        };
        summary.items.push(item);
        this.itemToSummary.set(item.id, summary);
      }
      this.recount(summary);
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
    // Every running summary, and the newest finished ones up to the limit, in their order.
    const shownFinished = new Set(this.summaries.filter((summary) => !delegationRunning(summary)).slice(-DELEGATION_PROGRESS_SUMMARY_LIMIT));
    return this.summaries
      .filter((summary) => delegationRunning(summary) || shownFinished.has(summary))
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
        // A replaced attempt and an abandoned one are kept in the card. Neither is what the agent is doing now,
        // and an interruption the coordinator has closed must not hold the row for good.
        if (item.historical || item.coordinatorDisposition === 'abandoned') {
          continue;
        }
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

  /**
   * Keep the typed retry link of a dispatch. The earlier attempt of the pair becomes history once the link holds:
   * its parent is in the same card and was dispatched before it.
   */
  recordRetryLink(id: string, retryOfHandle: string, retryStage: RetryStage): boolean {
    const summary = this.itemToSummary.get(id);
    const item = summary?.items.find((candidate) => candidate.id === id);
    if (!summary || !item) return false;
    item.retryOfHandle = retryOfHandle;
    item.retryStage = retryStage;
    this.recount(summary);
    return true;
  }

  /** Keep what the host recorded of the file changes an attempt asked for; the counts follow from it. */
  recordEffects(id: string, effects: { refusedOutstanding: number; succeeded: boolean }): boolean {
    const summary = this.itemToSummary.get(id);
    const item = summary?.items.find((candidate) => candidate.id === id);
    if (!summary || !item) return false;
    item.effects = { ...effects };
    this.recount(summary);
    return true;
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
    this.recount(summary);
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
    this.recount(summary);
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

  /** What the host admitted replaces what the coordinator asked for, as soon as both are known. Returns true when a card changed. */
  recordAdmittedScope(id: string, scope: string): boolean {
    const item = this.itemToSummary.get(id)?.items.find((candidate) => candidate.id === id);
    if (!item) {
      this.pendingAdmittedScopes.set(id, scope);
      return false;
    }
    item.scope = scope;
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

    // One card per run (F7-20): an assignment joins its run's card; the same key identifies the run after a
    // reload, so the live and restored card sets match. Without a run key, the per-coordinator grouping stays.
    const runKey = this.runKeyFor?.(message);
    let summary = runKey ? this.summaryByRunKey.get(runKey) : this.currentByCoordinator.get(message.from);
    if (!summary || (!runKey && summary.working === 0)) {
      summary = {
        id: runKey ? `delegation-run-${runKey}` : `delegation-${++this.sequence}`,
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
      if (runKey) this.summaryByRunKey.set(runKey, summary);
      this.summaries.push(summary);
      this.trimSummaries(summary);
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
    const admitted = this.pendingAdmittedScopes.get(id);
    if (admitted !== undefined) {
      this.pendingAdmittedScopes.delete(id);
      item.scope = admitted;
    }
    summary.items.push(item);
    this.recount(summary);
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
      startRefused?: unknown;
      lastObservedAt?: unknown;
      detectedAt?: unknown;
      stopped?: unknown;
      stopReason?: unknown;
      responseOutcome?: unknown;
    } | undefined;
    if (metadata?.interrupted === true) {
      return this.recordInterruption(id, {
        coordinatorId: item.coordinatorId,
        handle: id,
        agentId: item.agentId,
        // v0.9.103 (F1): a stop the host made is `host-stopped`, never a lost worker.
        reason: metadata.interruptionReason === 'host-restarted' || metadata.interruptionReason === 'host-stopped'
          ? metadata.interruptionReason : 'worker-lost',
        lastObservedAt: typeof metadata.lastObservedAt === 'string' ? metadata.lastObservedAt : item.updatedAt ?? item.startedAt,
        detectedAt: typeof metadata.detectedAt === 'string' ? metadata.detectedAt : message.timestamp,
      });
    }
    const cancelled = metadata?.cancelled === true;
    item.completionState = message.type === 'task.partial'
      ? 'partial'
      : message.type === 'system.error' ? 'not-observed' : 'complete';
    // v0.9.106 (retest 3, T4): a refused start is not a blocked task. The teammate never took it (no CLI program was
    // chosen, say), and a later dispatch starts it again, so the card and the agent's row must not say Blocked.
    item.status = metadata?.policyRefused === true
      ? 'policy-refused'
      : cancelled ? 'cancelled'
        : message.type === 'system.error' && metadata?.startRefused === true ? 'not-started'
          : message.type === 'system.error' ? 'blocked' : 'done';
    item.completedAt = message.timestamp;
    item.stopped = metadata?.stopped === true || undefined;
    item.stopReason = typeof metadata?.stopReason === 'string' ? compactInstruction(metadata.stopReason) : undefined;
    item.result = compactInstruction(message.payload?.instruction ?? message.payload?.message ?? '');
    const responseOutcome = parseResponseOutcome(metadata?.responseOutcome);
    if (responseOutcome?.kind === 'empty-reply') {
      item.emptyReply = emptyReplyReason(responseOutcome.attempts);
      item.result = compactInstruction(describeEmptyReply(responseOutcome.attempts));
    }
    this.recount(summary);
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
    if (item.status === 'blocked' || item.status === 'cancelled' || item.status === 'interrupted' || item.status === 'not-started') {
      return; // an actual task error remains blocked, and a refused start stays one; a stale verdict changes neither.
    }
    item.status = status;
    item.evidenceOutcome = status;
    this.recount(summary);
  }

  /**
   * Every count of a card, from its items. Nothing is kept beside them, so a decision that arrives later, a
   * superseded attempt for one, changes the counts by changing its item and by nothing else.
   */
  private recount(summary: DelegationProgressSummary): void {
    // A dispatch whose start was refused never became a task, so it is in no task count.
    const tasks = summary.items.filter((item) => item.status !== 'not-started');
    const projection = projectStandingWork(tasks.map(standingAttemptOf));
    for (const item of tasks) {
      const historical = projection.byHandle.get(item.id)?.historical;
      if (historical) item.historical = historical; else delete item.historical;
    }
    const standing = tasks.filter((item) => !item.historical);
    summary.total = standing.length + (summary.items.length - tasks.length);
    summary.done = projection.counts.complete;
    summary.partial = projection.counts.partial;
    summary.blocked = projection.counts.blocked;
    summary.working = projection.counts.working;
    setCount(summary, 'cancelled', projection.counts.cancelled, summary.cancelled !== undefined);
    setCount(summary, 'historical', projection.historical.length);
    setCount(summary, 'notStarted', summary.items.length - tasks.length);
    const evidence = (status: EvidenceDelegationStatus) => standing.filter((item) => item.evidenceOutcome === status).length;
    setCount(summary, 'verified', evidence('verified'));
    setCount(summary, 'toolActivityRecorded', evidence('tool-activity-recorded'));
    setCount(summary, 'repliedNotVerified', evidence('replied-not-verified'));
    setCount(summary, 'verificationFailed', evidence('verification-failed'));
    setCount(summary, 'noApplicableSensor', evidence('no-applicable-sensor'));
    setCount(summary, 'requiredInputReadReceiptsNotObserved', evidence('required-input-read-not-observed'));
    setCount(summary, 'noEvidence', standing.filter((item) => item.evidenceOutcome !== undefined
      && !COUNTED_EVIDENCE.has(item.evidenceOutcome)).length);
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
    if (item.status !== 'interrupted') {
      if (disposition === 'accepted' || disposition === 'accepted-with-caveat' ||
        disposition === 'accepted-after-rework' || disposition === 'accepted-despite-framework-no-evidence') {
        item.status = 'coordinator-accepted';
      } else if (disposition === 'needs-human') {
        item.status = 'human-intervention-required';
      } else {
        // Keep the observed verdict as an immutable fact and show that the later rejection amended it.
        item.amendedFrom = item.evidenceOutcome ?? previous;
        item.status = 'coordinator-rejected';
      }
    }
    const summary = this.itemToSummary.get(item.id);
    if (summary) this.recount(summary);
  }

  /**
   * v0.9.104 (item 3; Codex's audit of 5c296230, F4): the retained count is of FINISHED summaries; running ones are kept
   * on top of it. `admitted` is a summary just created for an assignment, whose task is added after this call: it is
   * never a candidate, even while it has no item yet.
   */
  private trimSummaries(admitted?: DelegationProgressSummary): void {
    const candidate = (summary: DelegationProgressSummary) => summary !== admitted && !delegationRunning(summary);
    while (this.summaries.filter(candidate).length > DELEGATION_PROGRESS_RETAINED) {
      // The oldest finished summary goes; a running one is never trimmed.
      const index = this.summaries.findIndex(candidate);
      if (index < 0) {
        break;
      }
      const [removed] = this.summaries.splice(index, 1);
      if (this.currentByCoordinator.get(removed.coordinatorId)?.id === removed.id) {
        this.currentByCoordinator.delete(removed.coordinatorId);
      }
      for (const [runKey, summary] of this.summaryByRunKey) {
        if (summary.id === removed.id) this.summaryByRunKey.delete(runKey);
      }
      for (const item of removed.items) {
        this.itemToSummary.delete(item.id);
        this.pendingDispositions.delete(item.id);
        this.pendingTaskStates.delete(item.id);
      }
    }
  }
}

/** The evidence verdicts that have a counter of their own; every other verdict is counted as no evidence. */
const COUNTED_EVIDENCE = new Set<EvidenceDelegationStatus>([
  'verified', 'tool-activity-recorded', 'replied-not-verified', 'verification-failed', 'no-applicable-sensor',
  'required-input-read-not-observed',
]);

type OptionalCount = 'cancelled' | 'historical' | 'notStarted' | 'verified' | 'toolActivityRecorded' | 'repliedNotVerified'
  | 'verificationFailed' | 'noApplicableSensor' | 'noEvidence' | 'requiredInputReadReceiptsNotObserved';

/** An optional counter is absent while it is zero, as it was when counters were bumped one event at a time. */
function setCount(summary: DelegationProgressSummary, key: OptionalCount, value: number, keepZero = false): void {
  if (value > 0 || keepZero) summary[key] = value; else delete summary[key];
}

/** A card item as the standing-work projection reads it. The item's own fields are the only source. */
function standingAttemptOf(item: DelegationProgressItem): StandingWorkAttempt {
  const lifecycle: StandingWorkLifecycle = item.status === 'working' ? 'working'
    : item.status === 'cancelled' ? 'cancelled'
      : item.status === 'interrupted' ? 'interrupted'
        : item.status === 'policy-refused' ? 'policy-refused'
          : item.status === 'blocked' ? 'failed'
            : 'settled';
  return {
    handle: item.id,
    dispatchedAt: item.startedAt,
    ...(item.retryOfHandle !== undefined ? { retryOfHandle: item.retryOfHandle } : {}),
    ...(item.retryStage !== undefined ? { retryStage: item.retryStage } : {}),
    ...(item.retryLinkGap !== undefined ? { retryLinkGap: item.retryLinkGap } : {}),
    lifecycle,
    ...(item.completionState ? { completionState: item.completionState } : {}),
    dispositions: item.coordinatorDisposition ? [{ disposition: item.coordinatorDisposition }] : [],
    ...(item.effects ? { effects: item.effects } : {}),
  };
}

/** The file-change facts of a stored evidence record, when the host kept any. */
function effectsOf(evidence: { changedFiles: readonly string[]; unrecordedWrites?: boolean; refusedEffects?: number }):
  Pick<DelegationProgressItem, 'effects'> {
  if (evidence.refusedEffects === undefined) return {};
  return {
    effects: {
      refusedOutstanding: evidence.refusedEffects,
      succeeded: evidence.changedFiles.length > 0 || evidence.unrecordedWrites === true,
    },
  };
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
