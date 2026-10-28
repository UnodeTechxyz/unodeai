/*---------------------------------------------------------------------------------------------
 *  UnodeAi - request closeout accumulator (v0.9.94)
 *
 *  Collects what the host observes during one top-level turn and closes it into that turn's request closeout
 *  record. Every input is a typed host fact: a tool's name and its typed result, a recorded write, an approval
 *  decision, the attached-context inventory, the turn's route. No reply text, tool argument, tool output or
 *  reasoning text is taken, so none of them can become a fact of the record.
 *
 *  v0.9.97: file effects are kept per request, not per turn, in the request's effect ledger (RequestFileEffects),
 *  which every turn of the request and every delegate turn acting for it feed, and which a record takes as it is
 *  when its turn ends. A later effect revises the records of that request already written.
 *--------------------------------------------------------------------------------------------*/
import type { TurnResponseOutcome } from '../backend/AgentBackend';
import type { ToolResultFact } from '../backend/toolSummary';
import { parseDocumentReceipt, type DocumentReceiptV1 } from '../content/document/DocumentWrite';
import {
  MAX_CHANGED_FILES,
  MAX_REQUEST_COUNT,
  MAX_ROUTE_AGENTS,
  MAX_USAGE_UNITS,
  REQUEST_CLOSEOUT_SCHEMA_VERSION,
  boundedObservations,
  changeGradeCount,
  limitedCoverageAreas,
  parseRequestCloseoutRecord,
  requestCloseoutRecordId,
  type FileEffectGrade,
  type FileRestoreOutcome,
  type RequestApprovalKind,
  type RequestChangeGrades,
  type RequestChangeOperation,
  type RequestChangedFile,
  type RequestChangesObservation,
  type RequestCloseoutRecordV1,
  type RequestLimitsObservation,
  type RequestObservationsV1,
  type RequestRunObservation,
  type RequestTerminalFact,
} from '../observability/RequestCloseout';
import { isPortableRelativePath } from '../observability/PortableRunEvidence';
import type { TurnTiming } from './TurnTiming';
import type { TurnOutcomeReceiptV1 } from './turnOutcomeReceipt';
import { parseCompletionCheckObservation, type CompletionCheckObservation } from '../observability/CompletionCheckObservation';
import type { VerificationCheckOutcome } from '../backend/CompletionVerificationCheck';
import type { TurnInterruptionV1 } from '../backend/TurnInterruption';
import { ACTIVITY_DISPOSITIONS, MAX_ACTIVITY_CALLS, MAX_ACTIVITY_NAMES, MAX_ACTIVITY_PATHS,
  activityPath, activityTool, parseTurnActivity, unavailableTurnActivity, type ActivityTool, type ActivityToolCounts, type TurnActivityV1 } from '../observability/TurnActivity';

/** A tool reached through one of the host's local bridges carries the bridge's name in front of its own. */
const BRIDGED_TOOL = /^mcp__unode_[a-z_]+_[a-f0-9]{32}__(.+)$/;

/** The tool's own name, whichever route named it. */
export function hostToolName(name: string): string {
  return BRIDGED_TOOL.exec(name)?.[1] ?? name;
}

/**
 * Tools whose effect on the workspace the host does not observe file by file: a shell command on any route, and
 * a provider-native file change. After one of them succeeds, the list of changed files may be incomplete.
 */
const UNOBSERVED_EFFECT_TOOLS = new Set(['run_command', 'bash', 'powershell', 'command_execution', 'file_change']);

/** v0.9.97: whether a finished tool call may have changed files the host does not observe one by one. */
export function hasUnobservedEffects(name: string, fact: ToolResultFact): boolean {
  return fact.status === 'success' && UNOBSERVED_EFFECT_TOOLS.has(hostToolName(name).toLowerCase());
}

/** v0.9.97: the paths one request's ledger keeps one by one; beyond them, effects are only counted. */
export const MAX_REQUEST_EFFECT_PATHS = 2_000;

/** v0.9.97: one file effect the host observed, as the ledger takes it. */
export interface ObservedFileEffect {
  /** Relative to the acting agent's folder, `/`-separated; absent when the file is not inside it. */
  path?: string;
  /** The host's key of the file, so that one it cannot show is still counted once. */
  key: string;
  operation: RequestChangeOperation;
  grade: FileEffectGrade;
}

/**
 * v0.9.97: the file effects of one request, as the host observed them: its top-level turns and the turns of the
 * agents it delegated to, which act under the same request. Each path is held once, with the last effect seen on it
 * (a file written twice, or written and then deleted, is one entry), so a rewrite or a retry is never counted again.
 * It takes host facts only: a host commit read back, a native change read back, an effect that could not be confirmed,
 * a restore of the person. An approval, an attempt or a model's claim never reaches it.
 */
export class RequestFileEffects {
  private readonly documents = new Map<string, DocumentReceiptV1>();
  private readonly files = new Map<string, RequestChangedFile>();
  /** Effects on files that cannot be shown, by the host's key: counted once each, never listed. */
  private readonly hidden = new Map<string, FileEffectGrade>();
  /** Effects past the path bound, by grade: counted, not held one by one. */
  private readonly beyond: RequestChangeGrades = { hostVerified: 0, nativeObserved: 0, uncertain: 0 };
  private notCovered = false;

  constructor(private readonly onChange: () => void = () => undefined) {}

  /** One effect. Returns whether the ledger changed. */
  effect(effect: ObservedFileEffect): boolean {
    const portable = effect.path?.replace(/\\/g, '/');
    const droppedDocument = portable ? this.documents.delete(portable) : false;
    if (portable === undefined || portable.length > 240 || !isPortableRelativePath(portable)) {
      if (this.hidden.get(effect.key) === effect.grade) return false;
      if (!this.hidden.has(effect.key) && this.hidden.size >= MAX_REQUEST_EFFECT_PATHS) return this.countBeyond(effect.grade);
      this.hidden.set(effect.key, effect.grade);
      return this.changed();
    }
    const held = this.files.get(portable);
    if (held && held.operation === effect.operation && held.evidence === effect.grade && !held.restore) return droppedDocument ? this.changed() : false;
    if (!held && this.files.size >= MAX_REQUEST_EFFECT_PATHS) return this.countBeyond(effect.grade);
    // A later effect on the path replaces what was held: the file is this request's again, as now observed.
    this.files.set(portable, { path: portable, operation: effect.operation, evidence: effect.grade });
    return this.changed();
  }

  /** A restore of the person undid this request's change to the path since. Returns whether the path is held. */
  restored(path: string, outcome: FileRestoreOutcome): boolean {
    this.documents.delete(path.replace(/\\/g, '/'));
    const held = this.files.get(path.replace(/\\/g, '/'));
    if (!held) return false;
    const next = restoredEntry(held, outcome);
    if (next.restore === held.restore && next.evidence === held.evidence) return true;
    this.files.set(held.path, next);
    this.changed();
    return true;
  }

  /** A command, a shell or a provider-native action ran in the request: other effects are not covered. */
  effectsNotCovered(): void {
    if (this.notCovered) return;
    this.notCovered = true;
    this.changed();
  }

  /** Additional metadata about an existing write/read-back; never increments effect counts. */
  documentWritten(raw: DocumentReceiptV1): void {
    const receipt = parseDocumentReceipt(raw);
    if (!receipt || receipt.path.length > 240 || !isPortableRelativePath(receipt.path)) return;
    if (!this.documents.has(receipt.path) && this.documents.size >= MAX_CHANGED_FILES) return;
    this.documents.set(receipt.path, receipt); this.changed();
  }

  /** The request's changes as a record holds them, the list cut to its bound. */
  observation(): RequestChangesObservation {
    const listed = boundedObservations([...this.files.values()].map((file) => ({ ...file })), MAX_CHANGED_FILES);
    const grades: RequestChangeGrades = { ...this.beyond };
    for (const file of this.files.values()) grades[changeGradeCount(file.evidence ?? 'effect-uncertain')] += 1;
    for (const grade of this.hidden.values()) grades[changeGradeCount(grade)] += 1;
    const omitted = listed.omitted + this.beyond.hostVerified + this.beyond.nativeObserved + this.beyond.uncertain;
    const droppedPaths = this.hidden.size;
    return {
      coverage: this.notCovered || omitted > 0 || droppedPaths > 0 ? 'partial' : 'complete',
      files: listed.kept,
      omitted,
      droppedPaths,
      grades,
      ...(this.documents.size ? { documents: [...this.documents.values()].map(receipt => structuredClone(receipt)) } : {}),
      ...(this.notCovered ? { notCovered: true as const } : {}),
    };
  }

  /** An effect past the bounds: counted by grade, up to what a record can hold beside the paths it keeps. */
  private countBeyond(grade: FileEffectGrade): boolean {
    const total = this.beyond.hostVerified + this.beyond.nativeObserved + this.beyond.uncertain;
    if (total >= MAX_REQUEST_COUNT - 2 * MAX_REQUEST_EFFECT_PATHS) return false;
    this.beyond[changeGradeCount(grade)] += 1;
    return this.changed();
  }

  private changed(): true {
    try { this.onChange(); } catch { /* a listener's failure is not the ledger's */ }
    return true;
  }
}

/** The entry after a restore: a confirmed one keeps how the change was known; an unconfirmed one makes it uncertain. */
function restoredEntry(held: RequestChangedFile, outcome: FileRestoreOutcome): RequestChangedFile {
  return { ...held, restore: outcome, ...(outcome === 'uncertain' ? { evidence: 'effect-uncertain' as const } : {}) };
}

const APPROVAL_KIND_ORDER: readonly RequestApprovalKind[] = [
  'command-approval', 'write-approval', 'web-access-approval', 'tool-approval', 'folder-access', 'mcp-grant', 'unclassified',
];

export interface RequestCloseoutIdentity {
  requestId: string;
  rootAgentId: string;
  /** The bus message that began the request. */
  originTurnId: string;
  /** The turn being observed. */
  terminalTurnId: string;
}

export interface RequestCloseoutFinish {
  terminal: RequestTerminalFact;
  interruption?: TurnInterruptionV1;
  recordedAt: string;
  turnOutcome?: TurnOutcomeReceiptV1;
  timing?: TurnTiming;
  /** The host ended the turn or lost its process, so events of it may never have arrived. */
  eventsCut: boolean;
  run?: RequestRunObservation;
  limits?: RequestLimitsObservation;
  /**
   * v0.9.95: whether the host had a verification command for this turn's agent, as it stood when the turn
   * closed. Left out when the host cannot say: the record then keeps no such fact.
   */
  verificationConfigured?: boolean;
}

export class RequestCloseoutAccumulator {
  private changesUnavailable = false;
  private checks = { passed: 0, failed: 0, refused: 0 };
  private lastCompletionCheck?: CompletionCheckObservation;
  private typedCheckToolEvents = 0;
  private readonly approvals = new Map<RequestApprovalKind, { allowed: number; denied: number; expired: number }>();
  private context: { sources: number; estimatedTextTokens: number } | undefined;
  private readonly routes: Array<{ agentId: string; backend?: string; model?: string }> = [];
  private omittedRoutes = 0;
  private delegation: { accepted: number; refused: number; pending: number } | undefined;
  private reasoningItems = 0;
  private inReasoning = false;
  private readonly usageUnitIds: string[] = [];
  private activityEnabled = false;
  private activityLimited = false;
  private readonly activityOpen = new Map<string, ActivityTool>();
  private readonly activityClosed = new Set<string>();
  private readonly activityTools = new Map<ActivityTool, ActivityToolCounts>();
  private readonly activityReads = new Set<string>();
  private readonly activityChanges = new Map<string, TurnActivityV1['changes'][number]>();
  private readonly activityDecisions = new Map<TurnActivityV1['decisions'][number]['disposition'], number>();
  private activityTodoUpdates = 0;
  private readonly activityOmitted = { events: 0, reads: 0, changes: 0 };
  private frozenActivity?: TurnActivityV1;

  /**
   * `effects` is the ledger of the turn's request, shared with every other turn of it and with its delegates' turns
   * (v0.9.97). A record then lists the request's file effects so far, not this turn's alone.
   */
  constructor(readonly identity: RequestCloseoutIdentity, readonly effects: RequestFileEffects = new RequestFileEffects()) {}

  /** Enable only when the owning turn's real event wiring is available. Legacy/missing observations are not zero. */
  beginTurnActivity(): void { if (!this.frozenActivity) this.activityEnabled = true; }
  activityCoverageLimited(): void {
    if (!this.frozenActivity) { this.activityEnabled = true; this.activityLimited = true; }
  }

  activityToolStarted(callId: string, name: string): void {
    if (this.frozenActivity) return;
    this.activityEnabled = true;
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(callId) || this.activityOpen.has(callId) || this.activityClosed.has(callId)
      || this.activityOpen.size + this.activityClosed.size >= MAX_ACTIVITY_CALLS) {
      this.activityOmitted.events = bump(this.activityOmitted.events); this.activityLimited = true; return;
    }
    const tool = activityTool(hostToolName(name));
    if (tool === 'native-tool') this.activityLimited = true;
    if (!this.activityTools.has(tool)) {
      if (this.activityTools.size >= MAX_ACTIVITY_NAMES) {
        this.activityOmitted.events = bump(this.activityOmitted.events); this.activityLimited = true; return;
      }
      this.activityTools.set(tool, { tool, success: 0, refused: 0, failed: 0, unfinished: 0 });
    }
    this.activityOpen.set(callId, tool);
  }

  private activityToolFinished(callId: string, name: string, fact: ToolResultFact): boolean {
    if (this.frozenActivity) return false;
    this.activityEnabled = true;
    const tool = this.activityOpen.get(callId);
    if (!tool || tool !== activityTool(hostToolName(name)) || this.activityClosed.has(callId)
      || !['success', 'refused', 'failed'].includes(fact.status)) {
      this.activityOmitted.events = bump(this.activityOmitted.events); this.activityLimited = true; return false;
    }
    this.activityOpen.delete(callId); this.activityClosed.add(callId);
    const entry = this.activityTools.get(tool)!;
    if (fact.status === 'success') entry.success = bump(entry.success);
    else if (fact.status === 'refused') entry.refused = bump(entry.refused);
    else entry.failed = bump(entry.failed);
    if (fact.observedBy !== 'host') this.activityLimited = true;
    if (tool === 'update_todos' && fact.status === 'success' && fact.observedBy === 'host') this.activityTodoUpdates = bump(this.activityTodoUpdates);
    return true;
  }

  /** Caller supplies a successful typed read fact, not a tool argument or summary. */
  activityFileRead(path: string | undefined, terminalTurnId: string): boolean {
    if (this.frozenActivity || terminalTurnId !== this.identity.terminalTurnId) return false;
    this.activityEnabled = true;
    const relative = activityPath(path);
    if (!relative || !this.activityReads.has(relative) && this.activityReads.size >= MAX_ACTIVITY_PATHS) {
      this.activityOmitted.reads = bump(this.activityOmitted.reads); this.activityLimited = true; return false;
    }
    this.activityReads.add(relative); return true;
  }

  /** Effects without this turn's captured origin remain in the shared request ledger only. */
  activityFileEffect(effect: ObservedFileEffect, terminalTurnId: string): boolean {
    if (this.frozenActivity || terminalTurnId !== this.identity.terminalTurnId) return false;
    this.activityEnabled = true;
    const relative = activityPath(effect.path);
    if (!relative || !this.activityChanges.has(relative) && this.activityChanges.size >= MAX_ACTIVITY_PATHS) {
      this.activityOmitted.changes = bump(this.activityOmitted.changes); this.activityLimited = true; return false;
    }
    this.activityChanges.set(relative, { path: relative, operation: effect.operation, evidence: effect.grade }); return true;
  }

  /** Only an already recorded host disposition; no inference from an accept tool's prose or arguments. */
  activityDisposition(disposition: TurnActivityV1['decisions'][number]['disposition']): void {
    if (this.frozenActivity || !(ACTIVITY_DISPOSITIONS as readonly string[]).includes(disposition)) return;
    this.activityEnabled = true;
    this.activityDecisions.set(disposition, bump(this.activityDecisions.get(disposition) ?? 0));
  }

  /** One immutable projection per turn; later shared-request file updates do not alter these facts. */
  freezeTurnActivity(eventsCut: boolean): TurnActivityV1 | undefined {
    if (!this.frozenActivity) this.frozenActivity = this.snapshotTurnActivity(eventsCut);
    return parseTurnActivity(this.frozenActivity);
  }

  /** A progress report reads a copy; it must not freeze observations while the turn keeps running. */
  snapshotTurnActivity(eventsCut = false): TurnActivityV1 | undefined {
    if (!this.activityEnabled) return undefined;
    if (this.frozenActivity) return parseTurnActivity(this.frozenActivity);
    const tools = [...this.activityTools.values()].map(entry => ({ ...entry }));
    for (const tool of this.activityOpen.values()) {
      const entry = tools.find(entry => entry.tool === tool)!;
      entry.unfinished = bump(entry.unfinished);
    }
    const lastUnfinished = [...this.activityOpen.values()].at(-1);
    return parseTurnActivity({ schemaVersion: 1,
      coverage: eventsCut || this.activityLimited || this.activityOpen.size ? 'partial' : 'complete',
      tools, reads: [...this.activityReads], changes: [...this.activityChanges.values()],
      decisions: [...this.activityDecisions].map(([disposition, count]) => ({ disposition, count })), todoUpdates: this.activityTodoUpdates,
      ...(this.delegation ? { dispatch: this.delegation } : {}), ...(lastUnfinished ? { lastUnfinished } : {}), omitted: this.activityOmitted }) ?? unavailableTurnActivity();
  }

  /**
   * A file effect the host observed for the request, with how it knows it (v0.9.97). A path it cannot show is counted,
   * not kept; the same path again is the same entry.
   */
  fileChanged(path: string, operation: RequestChangeOperation, grade: FileEffectGrade): void {
    this.effects.effect({ path, key: path, operation, grade });
  }

  /** This route records no file changes for the turn at all. */
  changesNotObserved(): void {
    this.changesUnavailable = true;
  }

  /** One finished tool call: its name as the route gave it, and the typed fact of its result. */
  toolResult(name: string, fact: ToolResultFact, callId?: string): boolean {
    const joined = callId !== undefined && this.activityToolFinished(callId, name, fact);
    this.endReasoningItem();
    const tool = hostToolName(name);
    if (tool === 'run_checks') {
      if (this.typedCheckToolEvents > 0) { this.typedCheckToolEvents--; return joined; }
      if (fact.status === 'success') this.checks.passed = bump(this.checks.passed);
      else if (fact.status === 'refused') this.checks.refused = bump(this.checks.refused);
      else this.checks.failed = bump(this.checks.failed);
      return joined;
    }
    if (hasUnobservedEffects(name, fact)) this.effects.effectsNotCovered();
    return joined;
  }

  /** Host path reports the typed result before its tool-result event, so that event must not count it twice. */
  verificationCheck(check: VerificationCheckOutcome, consumer: 'run-checks' | 'completion-gate'): void {
    const observation = parseCompletionCheckObservation(check);
    if (!observation) return;
    this.lastCompletionCheck = observation;
    if (consumer === 'run-checks') this.typedCheckToolEvents++;
    if (check.kind === 'passed') this.checks.passed = bump(this.checks.passed);
    else if (check.kind === 'failed') this.checks.failed = bump(this.checks.failed);
    else if (check.kind === 'not-run' && check.reason !== 'disabled' && check.reason !== 'not-applicable') this.checks.refused = bump(this.checks.refused);
    // Unknown is neither a failed implementation check nor a pass. Its receipt states that explicitly.
  }

  /** Provider-native activity the host only watches. What it changed is not observed. */
  nativeActivity(): void {
    if (!this.frozenActivity) { this.activityEnabled = true; this.activityLimited = true; }
    this.endReasoningItem();
    this.effects.effectsNotCovered();
  }

  approval(kind: RequestApprovalKind, decision: 'allowed' | 'denied' | 'expired'): void {
    const entry = this.approvals.get(kind) ?? { allowed: 0, denied: 0, expired: 0 };
    entry[decision] = bump(entry[decision]);
    this.approvals.set(kind, entry);
  }

  /** The inventory of what the host attached to this turn. */
  contextAttached(sources: number, estimatedTextTokens: number): void {
    this.context = { sources: whole(sources, MAX_REQUEST_COUNT), estimatedTextTokens: whole(estimatedTextTokens, 1_000_000_000) };
  }

  /** An agent that took part, with its configured route. The first one named is the turn's own agent. */
  route(agent: { agentId: string; backend?: string; model?: string }): void {
    if (this.routes.some((known) => known.agentId === agent.agentId)) return;
    if (this.routes.length >= MAX_ROUTE_AGENTS) {
      this.omittedRoutes = bump(this.omittedRoutes);
      return;
    }
    this.routes.push({
      agentId: agent.agentId,
      ...(routeLabel(agent.backend) ? { backend: routeLabel(agent.backend) } : {}),
      ...(routeLabel(agent.model) ? { model: routeLabel(agent.model) } : {}),
    });
  }

  /** The host's count of this turn's dispatches. A later receipt of the same turn replaces the earlier one. */
  delegationReceipt(receipt: { accepted: number; refused: number; pending: number }): void {
    this.delegation = {
      accepted: whole(receipt.accepted, MAX_REQUEST_COUNT),
      refused: whole(receipt.refused, MAX_REQUEST_COUNT),
      pending: whole(receipt.pending, MAX_REQUEST_COUNT),
    };
  }

  /** Reasoning text is being shown. A run of it is one item; its text is never read here. */
  reasoningShown(): void {
    if (this.inReasoning) return;
    this.inReasoning = true;
    this.reasoningItems = bump(this.reasoningItems);
  }

  /** Something other than reasoning was observed, so reasoning shown after it is another item. */
  endReasoningItem(): void {
    this.inReasoning = false;
  }

  usageUnit(usageUnitId: string): void {
    if (this.usageUnitIds.includes(usageUnitId) || this.usageUnitIds.length >= MAX_USAGE_UNITS) return;
    this.usageUnitIds.push(usageUnitId);
  }

  /**
   * Close the turn into its record, at revision 1. The record is passed through its own parser, so a value the
   * parser would refuse from storage is never published either.
   */
  finish(end: RequestCloseoutFinish): RequestCloseoutRecordV1 | undefined {
    const dispatchedWithoutRun = !end.run && !!this.delegation && this.delegation.accepted + this.delegation.pending > 0;
    // An observed typed receipt dominates the retired setting's boolean. Do not claim that a disabled team's
    // check was configured just because a different software team once used the User command.
    const configured = !this.lastCompletionCheck ? end.verificationConfigured
      : this.lastCompletionCheck.kind !== 'not-run' ? true
        : this.lastCompletionCheck.reason === 'disabled' ? false : undefined;
    const observations: RequestObservationsV1 = {
      ...(this.activityEnabled ? { turnActivity: this.freezeTurnActivity(end.eventsCut) } : {}),
      // v0.9.97: the request's file effects as the host has observed them so far.
      changes: this.changesUnavailable
        ? { coverage: 'unavailable', files: [], omitted: 0, droppedPaths: 0 }
        : this.effects.observation(),
      // A check's result arrives as an event of the turn. When the turn was cut short, one may be missing.
      checks: {
        coverage: end.eventsCut ? 'partial' : 'complete',
        ...this.checks,
        ...(this.lastCompletionCheck ? { lastCompletionCheck: this.lastCompletionCheck } : {}),
        ...(configured === undefined ? {} : { verificationConfigured: configured }),
      },
      approvals: {
        coverage: 'complete',
        decisions: APPROVAL_KIND_ORDER.flatMap((kind) => {
          const entry = this.approvals.get(kind);
          return entry ? [{ kind, ...entry }] : [];
        }),
      },
      context: { coverage: 'complete', ...(this.context ?? { sources: 0, estimatedTextTokens: 0 }) },
      // A turn that dispatched while no run was recorded for it yet cannot name the teammates it dispatched to.
      routes: this.routes.length > 0
        ? { coverage: this.omittedRoutes > 0 || dispatchedWithoutRun ? 'partial' : 'complete', agents: this.routes, omitted: this.omittedRoutes }
        : { coverage: 'unavailable', agents: [], omitted: 0 },
      ...(this.delegation ? { delegation: this.delegation } : {}),
      ...(end.run ? { run: end.run } : {}),
      reasoning: { visibleItems: this.reasoningItems },
      ...(end.limits ? { limits: end.limits } : {}),
    };
    const turnOutcome = end.turnOutcome?.turnId === this.identity.terminalTurnId ? end.turnOutcome : undefined;
    return parseRequestCloseoutRecord({
      schemaVersion: REQUEST_CLOSEOUT_SCHEMA_VERSION,
      recordId: requestCloseoutRecordId(this.identity.requestId, this.identity.terminalTurnId),
      requestId: this.identity.requestId,
      rootAgentId: this.identity.rootAgentId,
      originTurnId: this.identity.originTurnId,
      terminalTurnId: this.identity.terminalTurnId,
      recordedAt: end.recordedAt,
      revision: 1,
      terminal: end.terminal,
      ...(end.interruption ? { interruption: end.interruption } : {}),
      ...(turnOutcome ? { turnOutcome } : {}),
      ...(end.timing ? { timing: end.timing } : {}),
      usageUnitIds: this.usageUnitIds,
      observations,
      coverage: {
        events: end.eventsCut ? 'partial' : 'complete',
        limited: limitedCoverageAreas({ turnOutcome, timing: end.timing, observations }),
      },
    });
  }
}

/**
 * The record of a turn whose run has closed since the record was written: the same turn, the run's state as it is
 * now, and the next revision. Nothing else of the record changes: it keeps the time its turn ended, so its place
 * among the agent's records does not move. A record without that run is not revised.
 */
export function reviseForClosedRun(
  record: RequestCloseoutRecordV1,
  run: RequestRunObservation,
): RequestCloseoutRecordV1 | undefined {
  const held = record.observations.run;
  if (!held || held.runId !== run.runId || held.state === 'closed' || run.state !== 'closed') return undefined;
  const observations: RequestObservationsV1 = { ...record.observations, run };
  return parseRequestCloseoutRecord({
    ...record,
    revision: record.revision + 1,
    observations,
    coverage: { events: record.coverage.events, limited: limitedCoverageAreas({ turnOutcome: record.turnOutcome, timing: record.timing, observations }) },
  });
}

/**
 * The record of a turn whose run was recorded only after the record was written. A dispatch is recorded when the
 * teammate takes the task up, and that can be after the dispatching turn has ended. The record gets that run and
 * its next revision; its turn, how the turn ended and the time it ended stay. A run that is still open is marked
 * as recorded after the turn, so the card does not say that it was open when the turn ended. A run that has
 * already closed is taken as it is: the open state need not have been seen. A record that holds a run is not
 * given another.
 */
export function reviseForLateRun(
  record: RequestCloseoutRecordV1,
  run: RequestRunObservation,
): RequestCloseoutRecordV1 | undefined {
  if (record.observations.run) return undefined;
  const held: RequestRunObservation = run.state === 'open' ? { ...run, afterTurn: true } : run;
  const observations: RequestObservationsV1 = { ...record.observations, run: held };
  return parseRequestCloseoutRecord({
    ...record,
    revision: record.revision + 1,
    observations,
    coverage: { events: record.coverage.events, limited: limitedCoverageAreas({ turnOutcome: record.turnOutcome, timing: record.timing, observations }) },
  });
}

/**
 * v0.9.94: bring a record's limit facts up to date after its turn has ended.
 *
 * A record takes the limit facts of its request when its turn ends. The request goes on after that: teammates
 * make model requests, one of them reaches the limit, the person continues or stops it. The record of a turn
 * that dispatched and ended would then say `1 observed` and `continued 1 time` of a request that made twenty
 * and was stopped, and it is that record a Job outcome reads the facts from.
 *
 * A record is revised, with the whole observation of that moment, in three cases:
 *
 *  - The person has answered since: an allowance more, or the request stopped.
 *  - The record's claim of accuracy no longer holds: its coverage was complete and is not any more. A card must
 *    not go on saying that its totals are exact once a turn ran that the host cannot count inside.
 *  - The request is over and the observation says anything else than the record: these are its final facts.
 *    A request is over when its turn's coordinated run has closed, or when its turn opened none.
 *
 * While the run is open, totals alone do not revise: that would be a store write and a redraw at every model
 * request of a running job, for a figure the card gets in full when the job closes.
 *
 * A decision that is still open is not written into a record: it is not a fact of the request yet, and it would
 * turn an ended turn's card into a question. The counts of a request only grow and its coverage only gets worse,
 * so an observation with fewer crossings or allowances, or with a better coverage, is not a later one and is
 * refused. A record of a request that had no limit is never given one. The terminal fact and `recordedAt` stay.
 */
export function reviseForLimits(
  record: RequestCloseoutRecordV1,
  now: RequestLimitsObservation | undefined,
): RequestCloseoutRecordV1 | undefined {
  const held = record.observations.limits;
  if (!held || !now || now.decision === 'awaiting') return undefined;
  if (now.crossings < held.crossings || now.allowances < held.allowances) return undefined;
  if (held.coverage !== 'complete' && now.coverage === 'complete') return undefined;
  const answered = now.crossings !== held.crossings || now.allowances !== held.allowances || now.decision !== held.decision;
  const lessAccurate = held.coverage === 'complete' && now.coverage !== 'complete';
  const over = record.observations.run?.state !== 'open';
  if (!answered && !lessAccurate && !(over && !sameLimitFacts(held, now))) return undefined;
  const observations: RequestObservationsV1 = { ...record.observations, limits: now };
  return parseRequestCloseoutRecord({
    ...record,
    revision: record.revision + 1,
    observations,
    coverage: {
      events: record.coverage.events,
      limited: limitedCoverageAreas({ turnOutcome: record.turnOutcome, timing: record.timing, observations }),
    },
  });
}

/**
 * v0.9.97: the record of a turn of a request whose file effects have changed since the record was written: a delegate
 * wrote for the request after the turn ended, a later turn of it did, or a restore of the person undid a change. The
 * record takes the request's changes as they are now, under its next revision; its turn, how the turn ended and the
 * time it ended stay. A record of another request is never revised, and neither is a record whose route gave no view
 * of changes, nor one written before changes were graded (it lists one turn's writes, not the request's effects).
 */
export function reviseForFileEffects(
  record: RequestCloseoutRecordV1,
  requestId: string,
  changes: RequestChangesObservation,
): RequestCloseoutRecordV1 | undefined {
  const held = record.observations.changes;
  if (record.requestId !== requestId || !held.grades || (held.coverage !== 'complete' && held.coverage !== 'partial')) return undefined;
  if (JSON.stringify(held) === JSON.stringify(changes)) return undefined;
  return reviseChanges(record, changes);
}

/**
 * v0.9.97: the record of a request one of whose changes a restore of the person has undone since, when the request's
 * ledger is no longer held (after a reload). The listed entry of that path takes the restore; an entry that is not
 * listed cannot be found, and the record is left as it is.
 */
export function reviseForRestore(
  record: RequestCloseoutRecordV1,
  requestId: string,
  path: string,
  outcome: FileRestoreOutcome,
): RequestCloseoutRecordV1 | undefined {
  const held = record.observations.changes;
  if (record.requestId !== requestId || !held.grades) return undefined;
  const portable = path.replace(/\\/g, '/');
  const index = held.files.findIndex((file) => file.path === portable);
  if (index < 0) return undefined;
  const before = held.files[index];
  const after = restoredEntry(before, outcome);
  if (after.restore === before.restore && after.evidence === before.evidence) return undefined;
  const grades = { ...held.grades };
  if (before.evidence !== after.evidence) {
    grades[changeGradeCount(before.evidence ?? 'effect-uncertain')] -= 1;
    grades[changeGradeCount(after.evidence ?? 'effect-uncertain')] += 1;
  }
  const files = held.files.map((file, at) => (at === index ? after : file));
  return reviseChanges(record, { ...held, files, grades,
    ...(held.documents ? { documents: held.documents.filter(receipt => receipt.path !== portable) } : {}) });
}

function reviseChanges(record: RequestCloseoutRecordV1, changes: RequestChangesObservation): RequestCloseoutRecordV1 | undefined {
  const observations: RequestObservationsV1 = { ...record.observations, changes };
  return parseRequestCloseoutRecord({
    ...record,
    revision: record.revision + 1,
    observations,
    coverage: { events: record.coverage.events, limited: limitedCoverageAreas({ turnOutcome: record.turnOutcome, timing: record.timing, observations }) },
  });
}

/** Whether two observations of a request's limits say the same, member by member. */
function sameLimitFacts(a: RequestLimitsObservation, b: RequestLimitsObservation): boolean {
  return a.coverage === b.coverage
    && a.providerTurns?.ceiling === b.providerTurns?.ceiling
    && a.providerTurns?.observed === b.providerTurns?.observed
    && (a.providerTurns?.hostCountedTurns ?? 0) === (b.providerTurns?.hostCountedTurns ?? 0)
    && a.tokens?.ceiling === b.tokens?.ceiling
    && a.tokens?.observed === b.tokens?.observed
    && a.crossings === b.crossings
    && a.allowances === b.allowances
    && a.decision === b.decision
    && a.heldBoundary === b.heldBoundary;
}

/** Where the run of a stored record is read from. */
export interface RequestCloseoutRunSource {
  /** The run a record holds, by its exact id, as it is now. */
  byId(agentId: string, runId: string): RequestRunObservation | undefined;
  /** The run that this agent's turn opened, when one has been recorded. */
  openedBy(agentId: string, turnId: string): RequestRunObservation | undefined;
}

/**
 * The next revision of a stored record for what is held of its run now, or undefined when nothing changed. A
 * record without a run takes the run its own turn opened. A record of an open run takes that run's close.
 */
export function reviseForRunNow(
  record: RequestCloseoutRecordV1,
  runs: RequestCloseoutRunSource,
): RequestCloseoutRecordV1 | undefined {
  const held = record.observations.run;
  if (!held) {
    const opened = runs.openedBy(record.rootAgentId, record.terminalTurnId);
    return opened ? reviseForLateRun(record, opened) : undefined;
  }
  if (held.state !== 'open') return undefined;
  const now = runs.byId(record.rootAgentId, held.runId);
  return now ? reviseForClosedRun(record, now) : undefined;
}

/**
 * How a turn ended, from two typed host facts: how the host's turn was ended, and the delivery the backend
 * reported for it. A boundary of the host that stopped or failed the turn comes first: such a turn did not
 * answer, whatever its delivery says. A turn that ended with no typed delivery has no conclusion.
 */
export function requestTerminalOf(
  delivery: TurnResponseOutcome | undefined,
  ended: 'completed' | 'failed' | 'stopped' | 'interrupted',
): RequestTerminalFact {
  if (ended === 'stopped') return { kind: 'stopped' };
  if (ended === 'interrupted') return { kind: 'failed', failure: 'process-lost' };
  if (ended === 'failed') return { kind: 'failed', failure: 'turn-error' };
  if (!delivery) return { kind: 'no-conclusion' };
  switch (delivery.kind) {
    case 'reply': return { kind: 'answered' };
    case 'tool-only': return { kind: 'tool-only' };
    case 'empty-reply': return { kind: 'empty-reply' };
    case 'error': return { kind: 'failed', failure: 'turn-error' };
    case 'stopped': return { kind: 'stopped' };
    case 'host-deadline': return { kind: 'host-deadline' };
    default: return unhandledDelivery(delivery);
  }
}

function unhandledDelivery(value: never): never {
  throw new Error(`Unhandled turn delivery: ${JSON.stringify(value)}`);
}

function routeLabel(value: string | undefined): string | undefined {
  const flat = value?.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
  return flat || undefined;
}

function whole(value: number, limit: number): number {
  return Number.isFinite(value) ? Math.min(limit, Math.max(0, Math.floor(value))) : 0;
}

function bump(value: number): number {
  return Math.min(MAX_REQUEST_COUNT, value + 1);
}
