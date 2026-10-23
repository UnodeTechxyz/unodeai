/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Request closeout (v0.9.94)
 *
 *  What the host can state about one top-level turn when it returns control to the person: how the turn ended,
 *  what the host saw it do, and where the host's view is incomplete. The record is built once from typed host
 *  observations and holds ids, counts, paths and enums only: no prompt, no reply text, no file content, no
 *  command output and no reasoning text. Nothing here reads assistant prose, so prose can never become a
 *  change, a check, an approval, a cost or a completion.
 *
 *  One record belongs to one terminal top-level turn. A request whose coordinator is woken again by a
 *  teammate's result has one record per such turn, so a record never moves to a later reply. A record is
 *  revised, never appended to: a later fact replaces it under a larger revision.
 *
 *  The projection is a pure function of the record and of the spend units it names. A coordinated job that has
 *  closed is shown by its Job outcome; this module never stands in for it.
 *--------------------------------------------------------------------------------------------*/
import type { TurnTiming } from '../session/TurnTiming';
import { parseTurnTimingPhases } from '../session/TurnTiming';
import { parseTurnOutcomeReceipt, type TurnOutcomeReceiptV1 } from '../session/turnOutcomeReceipt';
import { formatUsd, parseNanoUsd } from '../models/spend/Money';
import {
  APPROVAL_KIND_LABEL,
  USAGE_BASIS_LABEL,
  formatDuration,
  type JobOutcomeSegment,
  type JobOutcomeTone,
  type JobOutcomeViewV1,
  type JobUsageLookup,
} from './JobOutcome';
import { isPortableRelativePath } from './PortableRunEvidence';
import type { RunPermissionKind } from './RunLedger';
import { MAX_CHANGED_FILES, MAX_REQUEST_COUNT, MAX_ROUTE_AGENTS, MAX_RUN_HANDLES, MAX_USAGE_UNITS } from './RequestCloseoutBounds';

export { MAX_CHANGED_FILES, MAX_REQUEST_COUNT, MAX_ROUTE_AGENTS, MAX_RUN_HANDLES, MAX_USAGE_UNITS, boundedObservations } from './RequestCloseoutBounds';

export const REQUEST_CLOSEOUT_SCHEMA_VERSION = 1 as const;
export type RequestCloseoutRecordId = `request-closeout:${string}`;

const RECORD_ID_PREFIX = 'request-closeout:';
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const AGENT_ID = /^[^\u0000-\u001f]{1,200}$/;
const LABEL = /^[^\u0000-\u001f]{1,120}$/;

const MAX_PATH_CHARS = 240;

/**
 * The record id of one terminal top-level turn. It is a function of the request and of that turn: a request
 * whose coordinator ends several turns has one record under each, and none of them can take another's place.
 */
export function requestCloseoutRecordId(requestId: string, terminalTurnId: string): RequestCloseoutRecordId {
  return `${RECORD_ID_PREFIX}${requestId}:${terminalTurnId}`;
}

// ─── The record ─────────────────────────────────────────────────────────────────────────

export const REQUEST_TERMINAL_KINDS = [
  'answered', 'tool-only', 'empty-reply', 'stopped', 'host-deadline', 'failed', 'no-conclusion',
] as const;
/**
 * How the turn ended, as the host typed it. `answered` says that visible reply text was delivered and nothing
 * about whether it is right. `no-conclusion` is a turn that ended with no typed delivery at all.
 */
export type RequestTerminalKind = typeof REQUEST_TERMINAL_KINDS[number];

export interface RequestTerminalFact {
  kind: RequestTerminalKind;
  /** Only with `failed`: the turn reported an error, or its process was lost before a result. */
  failure?: 'turn-error' | 'process-lost';
}

export const OBSERVATION_COVERAGES = ['complete', 'partial', 'unavailable', 'excluded'] as const;
/**
 * What the host can say about one kind of fact. `partial`: what is listed was observed and more is possible.
 * `unavailable`: this route gives the host no view of it. `excluded`: the host does not collect it for this turn.
 */
export type ObservationCoverage = typeof OBSERVATION_COVERAGES[number];

export type RequestChangeOperation = 'write' | 'delete-file' | 'delete-directory';
export type RequestApprovalKind = RunPermissionKind | 'unclassified';

const CHANGE_OPERATIONS: readonly RequestChangeOperation[] = ['write', 'delete-file', 'delete-directory'];
const APPROVAL_KINDS: readonly RequestApprovalKind[] = [
  'command-approval', 'write-approval', 'web-access-approval', 'tool-approval', 'folder-access', 'mcp-grant', 'unclassified',
];

export const FILE_EFFECT_GRADES = ['host-verified', 'native-observed', 'effect-uncertain'] as const;
/**
 * v0.9.97: how the host knows a file effect. `host-verified`: the host wrote or removed the file and read the result
 * back. `native-observed`: a CLI's own file tool did, and the host read back what it was to leave; that does not
 * prove who wrote it. `effect-uncertain`: the change may or may not have happened, or its author cannot be told.
 */
export type FileEffectGrade = typeof FILE_EFFECT_GRADES[number];

export const FILE_RESTORE_OUTCOMES = ['restored', 'removed', 'uncertain'] as const;
/**
 * v0.9.97: what a restore of the person did to a change since: put the earlier bytes back, removed a file the change
 * created, or could not be confirmed (the file's state is then uncertain, and so is the change's grade).
 */
export type FileRestoreOutcome = typeof FILE_RESTORE_OUTCOMES[number];

export interface RequestChangedFile {
  path: string;
  /** The last change the host observed to the path. */
  operation: RequestChangeOperation;
  /** v0.9.97: how that change is known. Absent on a record written before v0.9.97, which did not grade it. */
  evidence?: FileEffectGrade;
  /** v0.9.97: a restore of the person undid the change since. Only on a graded entry. */
  restore?: FileRestoreOutcome;
}

/** v0.9.97: the request's changed paths by the grade of the last effect observed on each, listed or not. */
export interface RequestChangeGrades {
  hostVerified: number;
  nativeObserved: number;
  uncertain: number;
}

export interface RequestChangesObservation {
  coverage: ObservationCoverage;
  /** Workspace-relative paths the host recorded a write or a delete for, in the order first seen. No contents. */
  files: RequestChangedFile[];
  /** Recorded changes beyond the bound: counted, not listed. */
  omitted: number;
  /** Recorded paths that could not be shown as workspace-relative: counted, never shown. */
  droppedPaths: number;
  /**
   * v0.9.97: present when the list is the request's host-observed file effects (its own turns and the work its
   * delegates did for it, each path once with its last effect), rather than one turn's recorded writes. Every path
   * of `files`, `omitted` and `droppedPaths` is counted here once. Absent on a record written before v0.9.97.
   */
  grades?: RequestChangeGrades;
  /**
   * v0.9.97, only with `grades`: a command, a shell or a provider-native action ran in this request, so file effects
   * beyond the ones listed are possible and the list is `partial`.
   */
  notCovered?: true;
}

/** Runs of the configured verification command that the host itself started in this turn. */
export interface RequestChecksObservation {
  coverage: ObservationCoverage;
  passed: number;
  failed: number;
  /** A run the host refused or the person declined: nothing was executed. */
  refused: number;
  /**
   * v0.9.95: whether the host had a verification command for the turn's agent when the turn closed. Absent on a
   * record written before this was kept, and when the host could not say. Absent is never read as false.
   */
  verificationConfigured?: boolean;
}

export interface RequestApprovalsObservation {
  coverage: ObservationCoverage;
  /** One entry per kind that had a decision, in the fixed kind order. */
  decisions: Array<{ kind: RequestApprovalKind; allowed: number; denied: number; expired: number }>;
}

/** The sources the host attached to this turn. The conversation, system prompt and tool definitions are not in it. */
export interface RequestContextObservation {
  coverage: ObservationCoverage;
  sources: number;
  estimatedTextTokens: number;
}

export interface RequestRoutesObservation {
  coverage: ObservationCoverage;
  /** The turn's own agent first. A route label is the configured backend and model: no key, endpoint or secret. */
  agents: Array<{ agentId: string; backend?: string; model?: string }>;
  omitted: number;
}

/** The coordinated run this turn belongs to, as the host held it when the record was written. */
export interface RequestRunObservation {
  runId: string;
  state: 'open' | 'closed';
  /**
   * The run was recorded after this turn had ended: the task the turn dispatched was taken up later. Absent when
   * the run was read as the turn ended. It decides only how an open run is worded.
   */
  afterTurn?: true;
  tasks: { active: number; settled: number; cancelled: number; interrupted: number };
  refusedDispatches: number;
  policyRefused: number;
  /** Handles of the tasks still running, bounded. */
  handles: string[];
  omittedHandles: number;
}

/** A request ceiling the person configured, and what the host did at it. */
export interface RequestLimitsObservation {
  /** `partial`: a turn ran where the host cannot count or hold the requests made inside it, or token usage was not reported. */
  coverage: ObservationCoverage;
  /**
   * `observed` counts model requests the host saw leave and turns it started where a CLI makes the requests
   * inside. `hostCountedTurns` is how many of `observed` are such turns, each counted as one; absent means none.
   */
  providerTurns?: { ceiling: number; observed: number; hostCountedTurns?: number };
  tokens?: { ceiling: number; observed: number };
  /** How many times a ceiling was reached. */
  crossings: number;
  /** How many times the person chose to continue: each added one tranche. Observed totals are never reset. */
  allowances: number;
  decision: 'none' | 'awaiting' | 'continued' | 'stopped';
  heldBoundary?: 'provider-request' | 'effect' | 'turn-start';
}

export interface RequestObservationsV1 {
  changes: RequestChangesObservation;
  checks: RequestChecksObservation;
  approvals: RequestApprovalsObservation;
  context: RequestContextObservation;
  routes: RequestRoutesObservation;
  /** The dispatch receipt of this turn, when the turn dispatched. */
  delegation?: { accepted: number; refused: number; pending: number };
  run?: RequestRunObservation;
  /** How many reasoning items were shown during the turn. Their text is never kept here. */
  reasoning: { visibleItems: number };
  limits?: RequestLimitsObservation;
}

export const REQUEST_COVERAGE_AREAS = ['tools', 'changes', 'checks', 'approvals', 'context', 'routes', 'timing', 'limits'] as const;
export type RequestCoverageArea = typeof REQUEST_COVERAGE_AREAS[number];

export interface RequestCoverageV1 {
  /** `partial` when the host's view of the turn's events may have been cut short: a stop, a deadline, a lost process. */
  events: 'complete' | 'partial';
  /** The areas whose facts are missing or bounded, in the fixed area order. A function of the record's other fields. */
  limited: RequestCoverageArea[];
}

export interface RequestCloseoutRecordV1 {
  schemaVersion: typeof REQUEST_CLOSEOUT_SCHEMA_VERSION;
  recordId: RequestCloseoutRecordId;
  /** The host's id of the top-level request: never an id the webview chose. */
  requestId: string;
  /** The agent the person addressed. */
  rootAgentId: string;
  /** The bus message that began the request. */
  originTurnId: string;
  /** The turn this record closes: the id its terminal message carries. */
  terminalTurnId: string;
  recordedAt: string;
  /** Starts at 1. A later fact replaces the record only under a larger revision. */
  revision: number;
  terminal: RequestTerminalFact;
  turnOutcome?: TurnOutcomeReceiptV1;
  timing?: TurnTiming;
  /** Spend units the host opened for this turn, by exact id. */
  usageUnitIds: string[];
  observations: RequestObservationsV1;
  coverage: RequestCoverageV1;
}

/** The areas a record's own fields show as limited. The stored list must equal this. */
export function limitedCoverageAreas(record: Pick<RequestCloseoutRecordV1, 'turnOutcome' | 'timing' | 'observations'>): RequestCoverageArea[] {
  const { observations } = record;
  const limited = new Set<RequestCoverageArea>();
  if (!record.turnOutcome || record.turnOutcome.tools.coverage !== 'complete') limited.add('tools');
  if (observations.changes.coverage !== 'complete') limited.add('changes');
  if (observations.checks.coverage !== 'complete') limited.add('checks');
  if (observations.approvals.coverage !== 'complete') limited.add('approvals');
  if (observations.context.coverage !== 'complete') limited.add('context');
  if (observations.routes.coverage !== 'complete') limited.add('routes');
  if (!record.timing) limited.add('timing');
  if (observations.limits && observations.limits.coverage !== 'complete') limited.add('limits');
  return REQUEST_COVERAGE_AREAS.filter((area) => limited.has(area));
}

// ─── Parsing ────────────────────────────────────────────────────────────────────────────

const count = (value: unknown): number | undefined =>
  (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_REQUEST_COUNT ? value : undefined);
const id = (value: unknown): string | undefined => (typeof value === 'string' && ID.test(value) ? value : undefined);
const instant = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const record = (value: unknown): Record<string, unknown> | undefined =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
const coverage = (value: unknown): ObservationCoverage | undefined =>
  (OBSERVATION_COVERAGES as readonly unknown[]).includes(value) ? value as ObservationCoverage : undefined;

/**
 * A record from a host event or from storage, rebuilt field by field. Unknown fields are dropped; a field outside
 * its bound, an id that is not the id of its own request and turn, or a coverage list that contradicts the
 * record's other fields rejects the record whole. Undefined means no record: it never means an empty turn.
 */
export function parseRequestCloseoutRecord(raw: unknown): RequestCloseoutRecordV1 | undefined {
  const value = record(raw);
  if (!value || value.schemaVersion !== REQUEST_CLOSEOUT_SCHEMA_VERSION) return undefined;
  const requestId = id(value.requestId);
  const originTurnId = id(value.originTurnId);
  const terminalTurnId = id(value.terminalTurnId);
  if (!requestId || !originTurnId || !terminalTurnId) return undefined;
  if (value.recordId !== requestCloseoutRecordId(requestId, terminalTurnId)) return undefined;
  if (typeof value.rootAgentId !== 'string' || !AGENT_ID.test(value.rootAgentId)) return undefined;
  if (!instant(value.recordedAt)) return undefined;
  const revision = count(value.revision);
  if (!revision) return undefined;
  const terminal = parseTerminal(value.terminal);
  if (!terminal) return undefined;
  const turnOutcome = value.turnOutcome === undefined ? undefined : parseTurnOutcomeReceipt(value.turnOutcome);
  if (value.turnOutcome !== undefined && (!turnOutcome || turnOutcome.turnId !== terminalTurnId)) return undefined;
  const timing = value.timing === undefined ? undefined : parseTiming(value.timing);
  if (value.timing !== undefined && !timing) return undefined;
  if (!Array.isArray(value.usageUnitIds) || value.usageUnitIds.length > MAX_USAGE_UNITS) return undefined;
  const usageUnitIds: string[] = [];
  for (const entry of value.usageUnitIds) {
    const unit = id(entry);
    if (!unit || usageUnitIds.includes(unit)) return undefined;
    usageUnitIds.push(unit);
  }
  const observations = parseObservations(value.observations);
  if (!observations) return undefined;
  const stored = record(value.coverage);
  if (!stored || (stored.events !== 'complete' && stored.events !== 'partial') || !Array.isArray(stored.limited)) return undefined;
  const limited = limitedCoverageAreas({ turnOutcome, timing, observations });
  if (stored.limited.length !== limited.length || stored.limited.some((area, index) => area !== limited[index])) return undefined;
  return {
    schemaVersion: REQUEST_CLOSEOUT_SCHEMA_VERSION,
    recordId: requestCloseoutRecordId(requestId, terminalTurnId),
    requestId,
    rootAgentId: value.rootAgentId,
    originTurnId,
    terminalTurnId,
    recordedAt: value.recordedAt,
    revision,
    terminal,
    ...(turnOutcome ? { turnOutcome } : {}),
    ...(timing ? { timing } : {}),
    usageUnitIds,
    observations,
    coverage: { events: stored.events, limited },
  };
}

function parseTerminal(raw: unknown): RequestTerminalFact | undefined {
  const value = record(raw);
  if (!value || !(REQUEST_TERMINAL_KINDS as readonly unknown[]).includes(value.kind)) return undefined;
  const kind = value.kind as RequestTerminalKind;
  if (kind !== 'failed') return value.failure === undefined ? { kind } : undefined;
  if (value.failure !== 'turn-error' && value.failure !== 'process-lost') return undefined;
  return { kind, failure: value.failure };
}

/** A timing fact as the tracker builds it. Phases are kept only when they add up to the duration. */
function parseTiming(raw: unknown): TurnTiming | undefined {
  const value = record(raw);
  if (!value || !instant(value.startedAt) || !instant(value.settledAt)) return undefined;
  const durationMs = count(value.durationMs);
  const approvalWaitMs = count(value.approvalWaitMs);
  if (durationMs === undefined || approvalWaitMs === undefined) return undefined;
  const phases = value.phases === undefined ? undefined : parseTurnTimingPhases(value.phases, durationMs);
  if (value.phases !== undefined && !phases) return undefined;
  return {
    startedAt: value.startedAt,
    settledAt: value.settledAt,
    durationMs,
    approvalWaitMs,
    ...(phases ? { phases } : {}),
  };
}

function parseObservations(raw: unknown): RequestObservationsV1 | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const changes = parseChanges(value.changes);
  const checks = parseChecks(value.checks);
  const approvals = parseApprovals(value.approvals);
  const context = parseContext(value.context);
  const routes = parseRoutes(value.routes);
  const reasoning = record(value.reasoning);
  const visibleItems = count(reasoning?.visibleItems);
  if (!changes || !checks || !approvals || !context || !routes || visibleItems === undefined) return undefined;
  const delegation = value.delegation === undefined ? undefined : parseDelegation(value.delegation);
  const run = value.run === undefined ? undefined : parseRun(value.run);
  const limits = value.limits === undefined ? undefined : parseLimits(value.limits);
  if ((value.delegation !== undefined && !delegation) || (value.run !== undefined && !run) || (value.limits !== undefined && !limits)) {
    return undefined;
  }
  return {
    changes,
    checks,
    approvals,
    context,
    routes,
    ...(delegation ? { delegation } : {}),
    ...(run ? { run } : {}),
    reasoning: { visibleItems },
    ...(limits ? { limits } : {}),
  };
}

function parseChanges(raw: unknown): RequestChangesObservation | undefined {
  const value = record(raw);
  const stated = coverage(value?.coverage);
  const omitted = count(value?.omitted);
  const droppedPaths = count(value?.droppedPaths);
  if (!value || !stated || omitted === undefined || droppedPaths === undefined) return undefined;
  if (!Array.isArray(value.files) || value.files.length > MAX_CHANGED_FILES) return undefined;
  const grades = value.grades === undefined ? undefined : parseGrades(value.grades);
  if (value.grades !== undefined && !grades) return undefined;
  const files: RequestChangesObservation['files'] = [];
  const listed: RequestChangeGrades = { hostVerified: 0, nativeObserved: 0, uncertain: 0 };
  for (const entry of value.files) {
    const file = record(entry);
    if (!file || typeof file.path !== 'string' || file.path.length > MAX_PATH_CHARS || !isPortableRelativePath(file.path)) return undefined;
    if (!(CHANGE_OPERATIONS as readonly unknown[]).includes(file.operation)) return undefined;
    // A graded list holds every path once, each with its grade; a list of one turn's writes holds no grade at all.
    const { evidence, restore } = file;
    if (grades) {
      if (!(FILE_EFFECT_GRADES as readonly unknown[]).includes(evidence)) return undefined;
      if (restore !== undefined && !(FILE_RESTORE_OUTCOMES as readonly unknown[]).includes(restore)) return undefined;
      if (restore === 'uncertain' && evidence !== 'effect-uncertain') return undefined;
      if (files.some((known) => known.path === file.path)) return undefined;
      listed[GRADE_COUNT[evidence as FileEffectGrade]] += 1;
    } else if (evidence !== undefined || restore !== undefined) {
      return undefined;
    }
    files.push({
      path: file.path,
      operation: file.operation as RequestChangeOperation,
      ...(grades ? { evidence: evidence as FileEffectGrade } : {}),
      ...(grades && restore !== undefined ? { restore: restore as FileRestoreOutcome } : {}),
    });
  }
  // A list that left something out, or that shows paths the host could not observe, is not complete.
  if (stated === 'complete' && (omitted > 0 || droppedPaths > 0)) return undefined;
  const graded = grades ? gradeTotal(grades) : 0;
  if ((stated === 'unavailable' || stated === 'excluded') && (files.length > 0 || omitted > 0 || droppedPaths > 0 || graded > 0)) return undefined;
  if (grades) {
    // Each path of the request is counted once: what is listed, what was left out and what cannot be shown.
    if (graded !== files.length + omitted + droppedPaths) return undefined;
    if (listed.hostVerified > grades.hostVerified || listed.nativeObserved > grades.nativeObserved || listed.uncertain > grades.uncertain) return undefined;
  }
  // Effects that are not covered make the list partial, and only a graded list says so. A graded list is partial
  // exactly when something is not covered, left out or not shown.
  if (value.notCovered !== undefined && (value.notCovered !== true || !grades || stated !== 'partial')) return undefined;
  if (grades && (stated === 'complete' || stated === 'partial')
    && (stated === 'partial') !== (value.notCovered === true || omitted > 0 || droppedPaths > 0)) return undefined;
  return {
    coverage: stated,
    files,
    omitted,
    droppedPaths,
    ...(grades ? { grades } : {}),
    ...(value.notCovered === true ? { notCovered: true as const } : {}),
  };
}

const GRADE_COUNT: Record<FileEffectGrade, keyof RequestChangeGrades> = {
  'host-verified': 'hostVerified',
  'native-observed': 'nativeObserved',
  'effect-uncertain': 'uncertain',
};

function parseGrades(raw: unknown): RequestChangeGrades | undefined {
  const value = record(raw);
  const hostVerified = count(value?.hostVerified);
  const nativeObserved = count(value?.nativeObserved);
  const uncertain = count(value?.uncertain);
  if (hostVerified === undefined || nativeObserved === undefined || uncertain === undefined) return undefined;
  return { hostVerified, nativeObserved, uncertain };
}

function gradeTotal(grades: RequestChangeGrades): number {
  return grades.hostVerified + grades.nativeObserved + grades.uncertain;
}

/** v0.9.97: the record field that counts a path of this grade. */
export function changeGradeCount(grade: FileEffectGrade): keyof RequestChangeGrades {
  return GRADE_COUNT[grade];
}

function parseChecks(raw: unknown): RequestChecksObservation | undefined {
  const value = record(raw);
  const stated = coverage(value?.coverage);
  const passed = count(value?.passed);
  const failed = count(value?.failed);
  const refused = count(value?.refused);
  if (!stated || passed === undefined || failed === undefined || refused === undefined) return undefined;
  if ((stated === 'unavailable' || stated === 'excluded') && passed + failed + refused > 0) return undefined;
  const configured = value?.verificationConfigured;
  if (configured !== undefined && typeof configured !== 'boolean') return undefined;
  return { coverage: stated, passed, failed, refused, ...(configured === undefined ? {} : { verificationConfigured: configured }) };
}

function parseApprovals(raw: unknown): RequestApprovalsObservation | undefined {
  const value = record(raw);
  const stated = coverage(value?.coverage);
  if (!value || !stated || !Array.isArray(value.decisions) || value.decisions.length > APPROVAL_KINDS.length) return undefined;
  const byKind = new Map<RequestApprovalKind, { allowed: number; denied: number; expired: number }>();
  for (const entry of value.decisions) {
    const decision = record(entry);
    if (!decision || !(APPROVAL_KINDS as readonly unknown[]).includes(decision.kind)) return undefined;
    const kind = decision.kind as RequestApprovalKind;
    const allowed = count(decision.allowed);
    const denied = count(decision.denied);
    const expired = count(decision.expired);
    if (allowed === undefined || denied === undefined || expired === undefined || byKind.has(kind)) return undefined;
    if (allowed + denied + expired === 0) return undefined;
    byKind.set(kind, { allowed, denied, expired });
  }
  if ((stated === 'unavailable' || stated === 'excluded') && byKind.size > 0) return undefined;
  return {
    coverage: stated,
    decisions: APPROVAL_KINDS.flatMap((kind) => {
      const entry = byKind.get(kind);
      return entry ? [{ kind, ...entry }] : [];
    }),
  };
}

function parseContext(raw: unknown): RequestContextObservation | undefined {
  const value = record(raw);
  const stated = coverage(value?.coverage);
  const sources = count(value?.sources);
  if (!value || !stated || sources === undefined) return undefined;
  // A token estimate is a size, not a tally: it has its own, larger bound.
  const tokens = value.estimatedTextTokens;
  if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0 || tokens > 1_000_000_000) return undefined;
  if ((stated === 'unavailable' || stated === 'excluded') && (sources > 0 || tokens > 0)) return undefined;
  return { coverage: stated, sources, estimatedTextTokens: tokens };
}

function parseRoutes(raw: unknown): RequestRoutesObservation | undefined {
  const value = record(raw);
  const stated = coverage(value?.coverage);
  const omitted = count(value?.omitted);
  if (!value || !stated || omitted === undefined || !Array.isArray(value.agents) || value.agents.length > MAX_ROUTE_AGENTS) return undefined;
  const agents: RequestRoutesObservation['agents'] = [];
  for (const entry of value.agents) {
    const agent = record(entry);
    if (!agent || typeof agent.agentId !== 'string' || !AGENT_ID.test(agent.agentId)) return undefined;
    if (agents.some((known) => known.agentId === agent.agentId)) return undefined;
    const backend = agent.backend === undefined ? undefined : label(agent.backend);
    const model = agent.model === undefined ? undefined : label(agent.model);
    if ((agent.backend !== undefined && !backend) || (agent.model !== undefined && !model)) return undefined;
    agents.push({ agentId: agent.agentId, ...(backend ? { backend } : {}), ...(model ? { model } : {}) });
  }
  if (stated === 'complete' && omitted > 0) return undefined;
  return { coverage: stated, agents, omitted };
}

function label(value: unknown): string | undefined {
  return typeof value === 'string' && LABEL.test(value) ? value : undefined;
}

function parseDelegation(raw: unknown): RequestObservationsV1['delegation'] | undefined {
  const value = record(raw);
  const accepted = count(value?.accepted);
  const refused = count(value?.refused);
  const pending = count(value?.pending);
  if (accepted === undefined || refused === undefined || pending === undefined) return undefined;
  return { accepted, refused, pending };
}

function parseRun(raw: unknown): RequestRunObservation | undefined {
  const value = record(raw);
  const runId = id(value?.runId);
  const tasks = record(value?.tasks);
  if (!value || !runId || !tasks || (value.state !== 'open' && value.state !== 'closed')) return undefined;
  if (value.afterTurn !== undefined && value.afterTurn !== true) return undefined;
  const active = count(tasks.active);
  const settled = count(tasks.settled);
  const cancelled = count(tasks.cancelled);
  const interrupted = count(tasks.interrupted);
  const refusedDispatches = count(value.refusedDispatches);
  const policyRefused = count(value.policyRefused);
  const omittedHandles = count(value.omittedHandles);
  if (active === undefined || settled === undefined || cancelled === undefined || interrupted === undefined
    || refusedDispatches === undefined || policyRefused === undefined || omittedHandles === undefined) {
    return undefined;
  }
  if (!Array.isArray(value.handles) || value.handles.length > MAX_RUN_HANDLES) return undefined;
  const handles: string[] = [];
  for (const entry of value.handles) {
    const handle = id(entry);
    if (!handle || handles.includes(handle)) return undefined;
    handles.push(handle);
  }
  // The handles are the running tasks: there cannot be more of them than tasks that run.
  if (handles.length + omittedHandles !== active) return undefined;
  return {
    runId,
    state: value.state,
    ...(value.afterTurn === true ? { afterTurn: true as const } : {}),
    tasks: { active, settled, cancelled, interrupted },
    refusedDispatches,
    policyRefused,
    handles,
    omittedHandles,
  };
}

function parseLimits(raw: unknown): RequestLimitsObservation | undefined {
  const value = record(raw);
  const stated = coverage(value?.coverage);
  const crossings = count(value?.crossings);
  const allowances = count(value?.allowances);
  if (!value || !stated || crossings === undefined || allowances === undefined) return undefined;
  if (value.decision !== 'none' && value.decision !== 'awaiting' && value.decision !== 'continued' && value.decision !== 'stopped') return undefined;
  const providerTurns = value.providerTurns === undefined ? undefined : parseProviderTurns(value.providerTurns);
  const tokens = value.tokens === undefined ? undefined : parseCeiling(value.tokens);
  if ((value.providerTurns !== undefined && !providerTurns) || (value.tokens !== undefined && !tokens)) return undefined;
  if (!providerTurns && !tokens) return undefined;
  const heldBoundary = value.heldBoundary;
  if (heldBoundary !== undefined && heldBoundary !== 'provider-request' && heldBoundary !== 'effect' && heldBoundary !== 'turn-start') return undefined;
  // A decision exists only where a ceiling was reached, and a continued request was allowed at least once.
  if (value.decision !== 'none' && crossings === 0) return undefined;
  if (value.decision === 'continued' && allowances === 0) return undefined;
  if (allowances > crossings) return undefined;
  return {
    coverage: stated,
    ...(providerTurns ? { providerTurns } : {}),
    ...(tokens ? { tokens } : {}),
    crossings,
    allowances,
    decision: value.decision,
    ...(heldBoundary ? { heldBoundary } : {}),
  };
}

/** A provider-turn ceiling. The turns counted as one each are a part of what was observed, never more than it. */
function parseProviderTurns(raw: unknown): NonNullable<RequestLimitsObservation['providerTurns']> | undefined {
  const parsed = parseCeiling(raw);
  const turns = record(raw)?.hostCountedTurns;
  if (!parsed || turns === undefined) return parsed;
  if (typeof turns !== 'number' || !Number.isSafeInteger(turns) || turns < 1 || turns > parsed.observed) return undefined;
  return { ...parsed, hostCountedTurns: turns };
}

function parseCeiling(raw: unknown): { ceiling: number; observed: number } | undefined {
  const value = record(raw);
  const ceiling = value?.ceiling;
  const observed = value?.observed;
  const whole = (entry: unknown): entry is number => typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0;
  if (!whole(ceiling) || ceiling === 0 || !whole(observed)) return undefined;
  return { ceiling, observed };
}

/** Whether two records hold the same facts. Both are parsed, so their fields are in one canonical order. */
export function sameRequestCloseoutRecord(left: RequestCloseoutRecordV1, right: RequestCloseoutRecordV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// ─── The projection ─────────────────────────────────────────────────────────────────────

export const REQUEST_SUMMARY_STATES = [
  'answered', 'completed', 'in-progress', 'needs-you', 'blocked', 'stopped', 'failed', 'no-conclusion', 'job-closed',
] as const;
/**
 * What the card leads with. `job-closed` is a turn that ended while its coordinated run was open, once that run
 * has closed: the run's Job outcome carries the result, and this card only points at it.
 */
export type RequestSummaryState = typeof REQUEST_SUMMARY_STATES[number];

export type RequestVerification = 'verified' | 'checks-failed' | 'not-verified' | 'not-applicable';

/** Whether the host itself ran the verification command in this turn, and how that ended. Never read from prose. */
export function requestVerification(observed: RequestCloseoutRecordV1): RequestVerification {
  const { checks, changes } = observed.observations;
  if (checks.failed > 0) return 'checks-failed';
  if (checks.passed > 0) return 'verified';
  return changes.files.length + changes.omitted + changes.droppedPaths > 0 ? 'not-verified' : 'not-applicable';
}

/**
 * The state of one closed turn. Every terminal kind is handled by name: a new kind does not fall into another's
 * state. An answer is `answered` or `completed` by what the host observed, never by what the reply says.
 */
export function requestSummaryState(observed: RequestCloseoutRecordV1): RequestSummaryState {
  const { observations, terminal } = observed;
  const run = observations.run;
  if (run?.state === 'closed') return 'job-closed';
  // A request limit that waits for the person is the next step whatever else the turn did.
  if (observations.limits?.decision === 'awaiting') return 'needs-you';
  switch (terminal.kind) {
    case 'stopped':
      return 'stopped';
    case 'failed':
      return 'failed';
    case 'host-deadline':
      return 'needs-you';
    case 'tool-only':
    case 'empty-reply':
    case 'no-conclusion':
      return 'no-conclusion';
    case 'answered': {
      if (run) {
        if (run.tasks.active > 0) return 'in-progress';
        if (run.policyRefused > 0) return 'blocked';
        // An open run with nothing running and no typed next step: the turn did not conclude the job.
        return 'no-conclusion';
      }
      if (observations.approvals.decisions.some((decision) => decision.denied + decision.expired > 0)) return 'needs-you';
      const changed = observations.changes.files.length + observations.changes.omitted + observations.changes.droppedPaths;
      const checked = observations.checks.passed + observations.checks.failed;
      return changed > 0 || checked > 0 ? 'completed' : 'answered';
    }
    default:
      return unhandled(terminal.kind);
  }
}

export type RequestSummarySectionTitle =
  | 'Result' | 'Work' | 'Changes' | 'Checks' | 'Access & approvals' | 'Context' | 'Team & routes' | 'Usage & timing' | 'Remaining';

export const REQUEST_SUMMARY_SECTIONS: readonly RequestSummarySectionTitle[] = [
  'Result', 'Work', 'Changes', 'Checks', 'Access & approvals', 'Context', 'Team & routes', 'Usage & timing', 'Remaining',
];

export interface RequestSummarySection {
  title: RequestSummarySectionTitle;
  rows: Array<{ label: string; value: string; tone?: JobOutcomeTone; instant?: string }>;
  items?: string[];
  note?: string;
}

/**
 * Everything a renderer needs, as text and tones. It has the shape of the Job outcome view, so one card
 * renderer shows both, and neither decides a state.
 */
export interface RequestSummaryViewV1 {
  schemaVersion: typeof REQUEST_CLOSEOUT_SCHEMA_VERSION;
  kind: 'request-summary';
  id: RequestCloseoutRecordId;
  requestId: string;
  terminalTurnId: string;
  available: true;
  state: RequestSummaryState;
  /** The collapsed line. */
  headline: JobOutcomeSegment[];
  sections: RequestSummarySection[];
  actions: [];
}

export interface RequestSummaryInputs {
  /** The spend authority, read by exact unit id. */
  usage: JobUsageLookup;
  /** The roster's current name for an agent. Presentation only. */
  agentName?: (agentId: string) => string | undefined;
}

const STATE_SEGMENT: Record<Exclude<RequestSummaryState, 'completed'>, JobOutcomeSegment> = {
  answered: { text: 'Answered', tone: 'neutral' },
  'in-progress': { text: 'In progress', tone: 'neutral' },
  'needs-you': { text: 'Needs you', tone: 'caution' },
  blocked: { text: 'Blocked', tone: 'caution' },
  stopped: { text: 'Stopped', tone: 'caution' },
  failed: { text: 'Failed', tone: 'negative' },
  'no-conclusion': { text: 'No conclusion recorded', tone: 'caution' },
  'job-closed': { text: 'Job closed', tone: 'neutral' },
};

// The state stays `completed`. The card says Finished: the turn ended with a change or a check run, and the word
// is not UnodeAi's own verdict that the work is done.
const COMPLETED_SEGMENT: Record<RequestVerification, JobOutcomeSegment> = {
  verified: { text: 'Verified', tone: 'positive' },
  'checks-failed': { text: 'Finished — checks failed', tone: 'negative' },
  'not-verified': { text: 'Finished — not verified', tone: 'caution' },
  'not-applicable': { text: 'Finished — not verified', tone: 'caution' },
};

// The three rows that say how much of something the host holds. Each row is named for its subject, and
// `complete` says what is complete, so that it is not read as test coverage or as a claim about the work.
const TOOL_RECORD_WORD: Record<TurnOutcomeReceiptV1['tools']['coverage'], string> = {
  complete: 'complete: every observed tool call has one result',
  partial: 'partial',
};

const CHANGE_VISIBILITY_WORD: Record<ObservationCoverage, string> = {
  complete: 'complete: every recorded write and delete is listed',
  partial: 'partial',
  unavailable: 'not available on this route',
  excluded: 'not collected for this turn',
};

const USAGE_ATTRIBUTION_WORD: Record<ProjectedUsage['coverage'], string> = {
  complete: 'complete: the usage recorded for this turn is settled and attributed',
  partial: 'partial',
  conflict: 'in conflict',
};

const TERMINAL_WORD: Record<RequestTerminalKind, string> = {
  answered: 'A reply was delivered',
  'tool-only': 'The turn ended after tool calls, with no final reply',
  'empty-reply': 'The model returned an empty reply',
  stopped: 'The turn was stopped',
  'host-deadline': 'UnodeAi ended the attempt: the model was silent past the first-action deadline',
  failed: 'The turn failed',
  'no-conclusion': 'The turn ended with no recorded delivery',
};

const OPERATION_WORD: Record<RequestChangeOperation, string> = {
  write: 'written',
  'delete-file': 'deleted',
  'delete-directory': 'folder deleted',
};

// v0.9.97: the words of a graded list, the request's file effects.
const GRADED_VISIBILITY_WORD: Record<ObservationCoverage, string> = {
  ...CHANGE_VISIBILITY_WORD,
  complete: 'complete: every file change UnodeAi observed in this request is listed',
};

const GRADE_WORD: Record<FileEffectGrade, string> = {
  'host-verified': 'host-verified',
  'native-observed': 'CLI native observed',
  'effect-uncertain': 'effect uncertain',
};

const RESTORE_WORD: Record<FileRestoreOutcome, string> = {
  restored: 'restored by you since',
  removed: 'removed by your restore since',
  uncertain: 'your restore of it was not confirmed',
};

/** The card of one closed turn. Reads the record and the spend units it names; changes neither. */
export function projectRequestSummary(observed: RequestCloseoutRecordV1, inputs: RequestSummaryInputs): RequestSummaryViewV1 {
  const state = requestSummaryState(observed);
  const verification = requestVerification(observed);
  const usage = projectUsage(observed, inputs.usage);
  return {
    schemaVersion: REQUEST_CLOSEOUT_SCHEMA_VERSION,
    kind: 'request-summary',
    id: observed.recordId,
    requestId: observed.requestId,
    terminalTurnId: observed.terminalTurnId,
    available: true,
    state,
    headline: headline(observed, state, verification, usage),
    sections: [
      resultSection(observed, state),
      workSection(observed),
      changesSection(observed),
      checksSection(observed, verification),
      approvalsSection(observed),
      contextSection(observed),
      routesSection(observed, inputs),
      usageSection(observed, usage),
      remainingSection(observed, state),
    ],
    actions: [],
  };
}

function headline(
  observed: RequestCloseoutRecordV1,
  state: RequestSummaryState,
  verification: RequestVerification,
  usage: ProjectedUsage,
): JobOutcomeSegment[] {
  const { observations } = observed;
  const segments: JobOutcomeSegment[] = [state === 'completed' ? COMPLETED_SEGMENT[verification] : STATE_SEGMENT[state]];
  if (state === 'job-closed') {
    segments.push({ text: 'its Job outcome follows the closing reply', tone: 'neutral' });
    return segments;
  }
  if (observations.limits?.decision === 'awaiting') segments.push({ text: 'request limit reached', tone: 'caution' });
  const denied = observations.approvals.decisions.reduce((total, decision) => total + decision.denied + decision.expired, 0);
  if (denied > 0) segments.push({ text: `${plural(denied, 'approval')} not granted`, tone: 'caution' });
  const run = observations.run;
  if (run) {
    segments.push(run.tasks.active > 0
      ? { text: `${plural(run.tasks.active, 'delegated task')} running ${run.afterTurn ? 'after' : 'when'} this turn ended`, tone: 'neutral' }
      : { text: 'no live work or next action recorded', tone: 'caution' });
  }
  segments.push(changesSegment(observations.changes));
  if (state === 'completed' || observations.checks.passed + observations.checks.failed + observations.checks.refused > 0) {
    segments.push(checksSegment(observations.checks));
  }
  if (usage.single) segments.push({ text: usage.single, tone: 'neutral' });
  if (observed.timing) segments.push({ text: formatDuration(observed.timing.durationMs), tone: 'neutral' });
  if (observed.coverage.events === 'partial' || observed.coverage.limited.length > 0) {
    segments.push({ text: 'coverage limited', tone: 'caution' });
  }
  return segments;
}

function changesSegment(changes: RequestChangesObservation): JobOutcomeSegment {
  const listed = changes.files.length + changes.omitted + changes.droppedPaths;
  if (changes.grades && (changes.coverage === 'complete' || changes.coverage === 'partial')) {
    // v0.9.97: the request's effects. Every changed path is counted, listed or not; only effects nothing covers can
    // add to them. "None" is said of verified changes, never of the workspace.
    const uncertain = changes.grades.uncertain;
    const parts = [
      listed > 0 ? `${plural(listed, 'file')} changed` : 'no verified file change observed',
      ...(uncertain > 0 ? [`${whole(uncertain)} uncertain`] : []),
      ...(changes.notCovered ? ['other effects not covered'] : []),
    ];
    return { text: parts.join(', '), tone: uncertain > 0 || changes.notCovered ? 'caution' : 'neutral' };
  }
  switch (changes.coverage) {
    case 'complete':
      return listed > 0
        ? { text: `${plural(listed, 'file')} changed`, tone: 'neutral' }
        : { text: 'no workspace changes observed', tone: 'neutral' };
    case 'partial':
      return listed > 0
        ? { text: `${plural(listed, 'file')} changed, more possible`, tone: 'caution' }
        : { text: 'no workspace changes observed, more possible', tone: 'caution' };
    case 'unavailable':
      return { text: 'changes not observed on this route', tone: 'caution' };
    case 'excluded':
      return { text: 'changes not recorded', tone: 'caution' };
    default:
      return unhandled(changes.coverage);
  }
}

function checksSegment(checks: RequestChecksObservation): JobOutcomeSegment {
  if (checks.failed > 0) return { text: `${plural(checks.failed, 'check run')} failed`, tone: 'negative' };
  if (checks.passed > 0) return { text: `${plural(checks.passed, 'check run')} passed`, tone: 'positive' };
  if (checks.refused > 0) return { text: 'checks not run: the run was refused', tone: 'caution' };
  return { text: 'checks not run', tone: 'caution' };
}

function resultSection(observed: RequestCloseoutRecordV1, state: RequestSummaryState): RequestSummarySection {
  const { terminal } = observed;
  const ending = terminal.kind === 'failed' && terminal.failure === 'process-lost'
    ? 'The agent\'s process ended before the turn reported a result'
    : TERMINAL_WORD[terminal.kind];
  const rows: RequestSummarySection['rows'] = [
    { label: 'How the turn ended', value: ending, ...(terminal.kind === 'answered' ? {} : { tone: 'caution' as const }) },
    { label: 'Recorded', value: observed.recordedAt, instant: observed.recordedAt },
  ];
  const notes: string[] = [];
  if (terminal.kind === 'answered') {
    // Said of the delivery, not of a state word: an answered turn can lead its card with another heading.
    notes.push('A reply was delivered. UnodeAi does not judge whether it is correct.');
  }
  if (state === 'job-closed') {
    notes.push('The coordinated job this turn belonged to has closed since. Its Job outcome is the record of that job.');
  }
  if (observed.coverage.events === 'partial') {
    notes.push('The turn was cut short, so events of it may be missing from what is shown here.');
  }
  if (observed.coverage.limited.length > 0) {
    notes.push(`Incomplete or bounded: ${observed.coverage.limited.join(', ')}.`);
  }
  return { title: 'Result', rows, ...(notes.length > 0 ? { note: notes.join(' ') } : {}) };
}

function workSection(observed: RequestCloseoutRecordV1): RequestSummarySection {
  const rows: RequestSummarySection['rows'] = [];
  const tools = observed.turnOutcome?.tools;
  if (tools) {
    rows.push({ label: 'Tool calls', value: `${whole(tools.total)}: ${whole(tools.success)} succeeded, ${whole(tools.refused)} refused, ${whole(tools.failed)} failed` });
    rows.push({ label: 'Tool event record', value: TOOL_RECORD_WORD[tools.coverage], ...(tools.coverage === 'complete' ? {} : { tone: 'caution' as const }) });
    if (tools.excludedNativeActivities > 0) {
      rows.push({ label: 'Provider-native activity', value: `${whole(tools.excludedNativeActivities)}, observed and not mediated by UnodeAi`, tone: 'caution' });
    }
  } else {
    rows.push({ label: 'Tool calls', value: 'not recorded', tone: 'caution' });
  }
  const { delegation, reasoning } = observed.observations;
  if (delegation) {
    rows.push({ label: 'Dispatches in this turn', value: `${whole(delegation.accepted)} accepted, ${whole(delegation.refused)} refused, ${whole(delegation.pending)} pending` });
  }
  if (reasoning.visibleItems > 0) {
    rows.push({ label: 'Reasoning shown', value: `${plural(reasoning.visibleItems, 'item')}; work shown, not a conclusion` });
  }
  return {
    title: 'Work',
    rows,
    ...(tools ? {} : { note: 'This turn has no tool receipt. That is not the same as a turn without tool calls.' }),
  };
}

function changesSection(observed: RequestCloseoutRecordV1): RequestSummarySection {
  const { changes } = observed.observations;
  if (changes.grades && (changes.coverage === 'complete' || changes.coverage === 'partial')) return gradedChangesSection(changes, changes.grades);
  const listed = changes.files.length + changes.omitted + changes.droppedPaths;
  const rows: RequestSummarySection['rows'] = [
    changes.coverage === 'unavailable' || changes.coverage === 'excluded'
      ? { label: 'Files changed', value: 'not observed', tone: 'caution' }
      : { label: 'Files changed', value: listed > 0 ? whole(listed) : 'none observed' },
    { label: 'Change visibility', value: CHANGE_VISIBILITY_WORD[changes.coverage], ...(changes.coverage === 'complete' ? {} : { tone: 'caution' as const }) },
  ];
  const notes: string[] = [];
  if (changes.coverage === 'partial') {
    notes.push('A command or a provider-native action ran in this turn. Files it changed are not in this list.');
  }
  if (changes.omitted > 0) notes.push(`${plural(changes.omitted, 'more change')} recorded and not listed.`);
  if (changes.droppedPaths > 0) notes.push(`${plural(changes.droppedPaths, 'recorded path')} could not be shown as workspace-relative.`);
  return {
    title: 'Changes',
    rows,
    ...(changes.files.length > 0 ? { items: changes.files.map((file) => `${file.path} (${OPERATION_WORD[file.operation]})`) } : {}),
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}

/**
 * v0.9.97: the file effects of the whole request, by how the host knows each: its own turns and the work its
 * delegates did for it, every path once, as it was last observed. Nothing a reply, an approval or an attempt says is
 * in it. A native change is never shown as "none": its count stands beside the verified one.
 */
function gradedChangesSection(changes: RequestChangesObservation, grades: RequestChangeGrades): RequestSummarySection {
  const rows: RequestSummarySection['rows'] = [
    { label: 'Host-verified files', value: grades.hostVerified > 0 ? whole(grades.hostVerified) : 'none' },
    { label: 'CLI native observed', value: grades.nativeObserved > 0 ? whole(grades.nativeObserved) : 'none' },
    ...(grades.uncertain > 0 ? [{ label: 'Effect uncertain', value: whole(grades.uncertain), tone: 'caution' as const }] : []),
    { label: 'Change visibility', value: GRADED_VISIBILITY_WORD[changes.coverage], ...(changes.coverage === 'complete' ? {} : { tone: 'caution' as const }) },
  ];
  const notes = [
    'File changes UnodeAi observed in this request: its own turns and the work its teammates did for it. An approval, an '
      + 'attempt, or a reply that says a file was saved is not counted. "None" means only that no such change was observed.',
  ];
  if (grades.nativeObserved > 0) {
    notes.push('CLI native observed: the CLI\'s own tool made the change and UnodeAi read back the bytes it was to leave. That does not prove who wrote them.');
  }
  if (grades.uncertain > 0) notes.push('Effect uncertain: the change may or may not have happened. Check the file before relying on it.');
  if (changes.notCovered) {
    notes.push('Other file effects are not fully covered: a command or a provider-native action ran in this request, and files it changed are not in this list.');
  }
  if (changes.omitted > 0) notes.push(`${plural(changes.omitted, 'more changed file')} counted and not listed.`);
  if (changes.droppedPaths > 0) notes.push(`${plural(changes.droppedPaths, 'changed path')} could not be shown as relative to the agent's folder.`);
  return {
    title: 'Changes',
    rows,
    ...(changes.files.length > 0 ? { items: changes.files.map(gradedChangeItem) } : {}),
    note: notes.join(' '),
  };
}

function gradedChangeItem(file: RequestChangedFile): string {
  const grade = file.evidence ? GRADE_WORD[file.evidence] : 'not graded';
  return `${file.path} (${OPERATION_WORD[file.operation]}, ${grade}${file.restore ? `; ${RESTORE_WORD[file.restore]}` : ''})`;
}

function checksSection(observed: RequestCloseoutRecordV1, verification: RequestVerification): RequestSummarySection {
  const { checks } = observed.observations;
  const ran = checks.passed + checks.failed;
  const rows: RequestSummarySection['rows'] = [];
  if (checks.coverage === 'unavailable' || checks.coverage === 'excluded') {
    rows.push({ label: 'Verification runs', value: 'not observed', tone: 'caution' });
  } else {
    rows.push({ label: 'Verification runs', value: ran > 0 ? `${whole(checks.passed)} passed, ${whole(checks.failed)} failed` : verificationNotRunWord(checks.verificationConfigured), ...(checks.failed > 0 ? { tone: 'negative' as const } : ran === 0 ? { tone: 'caution' as const } : {}) });
    if (checks.refused > 0) rows.push({ label: 'Refused or declined', value: whole(checks.refused), tone: 'caution' });
  }
  const note = verification === 'verified'
    ? 'Verified means that UnodeAi ran the configured verification command in this turn and it exited 0.'
    : 'Only a run of the configured verification command that UnodeAi itself started counts here. A command the agent ran, or a result it reported in its reply, does not.';
  return { title: 'Checks', rows, note };
}

/**
 * What the row says when UnodeAi ran no verification: whether there was a command it could have run. A record
 * written before that was kept says neither, and is not read as a turn with no command configured.
 */
function verificationNotRunWord(configured: boolean | undefined): string {
  if (configured === undefined) return 'configuration not recorded';
  return configured ? 'configured, not run' : 'not configured';
}

function approvalsSection(observed: RequestCloseoutRecordV1): RequestSummarySection {
  const { approvals } = observed.observations;
  if (approvals.coverage === 'unavailable' || approvals.coverage === 'excluded') {
    return { title: 'Access & approvals', rows: [{ label: 'Approval decisions', value: 'not observed', tone: 'caution' }] };
  }
  if (approvals.decisions.length === 0) {
    const waited = observed.timing?.approvalWaitMs ?? 0;
    return {
      title: 'Access & approvals',
      // No decision was recorded. That does not say that none was needed.
      rows: [{ label: 'Approval decisions', value: 'none recorded', ...(waited > 0 ? { tone: 'caution' as const } : {}) }],
      ...(waited > 0
        ? { note: `The turn recorded ${formatDuration(waited)} of waiting for a person. A consent dialog, such as a folder-read disclosure, is not recorded as an approval.` }
        : {}),
    };
  }
  return {
    title: 'Access & approvals',
    rows: approvals.decisions.map((decision) => ({
      label: decision.kind === 'unclassified' ? 'Approvals' : APPROVAL_KIND_LABEL[decision.kind],
      value: `${whole(decision.allowed)} allowed, ${whole(decision.denied)} denied, ${whole(decision.expired)} expired`,
      ...(decision.denied + decision.expired > 0 ? { tone: 'caution' as const } : {}),
    })),
  };
}

function contextSection(observed: RequestCloseoutRecordV1): RequestSummarySection {
  const { context } = observed.observations;
  if (context.coverage === 'unavailable' || context.coverage === 'excluded') {
    return { title: 'Context', rows: [{ label: 'Attached sources', value: 'not recorded', tone: 'caution' }] };
  }
  return {
    title: 'Context',
    rows: [
      { label: 'Attached sources', value: whole(context.sources) },
      { label: 'Estimated text tokens', value: `about ${whole(context.estimatedTextTokens)}` },
    ],
    note: 'Attached sources only. The conversation, the system prompt and the tool definitions are not counted here.',
  };
}

function routesSection(observed: RequestCloseoutRecordV1, inputs: RequestSummaryInputs): RequestSummarySection {
  const { routes, run } = observed.observations;
  const rows: RequestSummarySection['rows'] = routes.agents.map((agent) => {
    let name: string | undefined;
    try { name = inputs.agentName?.(agent.agentId); } catch { name = undefined; }
    const shown = name && LABEL.test(name) ? name : agent.agentId;
    const route = [agent.backend, agent.model].filter((part): part is string => !!part).join(' · ');
    return { label: shown, value: route || 'route not recorded', ...(route ? {} : { tone: 'caution' as const }) };
  });
  if (rows.length === 0) rows.push({ label: 'Route', value: 'not recorded', tone: 'caution' });
  if (run) rows.push({ label: 'Coordinated run', value: run.state !== 'open' ? 'closed' : run.afterTurn ? 'opened after this turn ended' : 'open when this turn ended' });
  return {
    title: 'Team & routes',
    rows,
    ...(routes.omitted > 0
      ? { note: `${plural(routes.omitted, 'more agent')} took part and is not listed.` }
      : routes.coverage === 'partial' ? { note: 'This turn dispatched work, and no run was recorded for it when the turn ended. The teammates it dispatched to are not listed.' } : {}),
  };
}

interface ProjectedUsage {
  state: 'not-recorded' | 'recorded';
  coverage: 'complete' | 'partial' | 'conflict';
  tokens: { input: number; cachedInput: number; output: number };
  rows: Array<{ label: string; tokens: number; amount?: string }>;
  /** One short phrase for the collapsed line, only when the whole turn is on one priced basis. */
  single?: string;
}

function projectUsage(observed: RequestCloseoutRecordV1, lookup: JobUsageLookup): ProjectedUsage {
  const empty: ProjectedUsage = { state: 'not-recorded', coverage: 'partial', tokens: { input: 0, cachedInput: 0, output: 0 }, rows: [] };
  if (observed.usageUnitIds.length === 0) return empty;
  const tokens = { input: 0, cachedInput: 0, output: 0 };
  const byBasis = new Map<string, { tokens: number; nano?: bigint; unpriced: boolean }>();
  let settled = 0;
  let conflict = false;
  let unattributed = false;
  for (const usageUnitId of observed.usageUnitIds) {
    let facts: ReturnType<JobUsageLookup>;
    try { facts = lookup(usageUnitId); } catch { facts = undefined; }
    if (!facts) continue;
    if (facts.quarantined) conflict = true;
    if (facts.unattributed) unattributed = true;
    if (facts.state === 'settled') settled += 1;
    for (const row of facts.rows) {
      tokens.input += row.inputTokens;
      tokens.cachedInput += row.cachedInputTokens;
      tokens.output += row.outputTokens;
      const basis = byBasis.get(row.displayClass) ?? { tokens: 0, unpriced: false };
      // Cached input is part of the input figure: it is counted once.
      basis.tokens += row.inputTokens + row.outputTokens;
      const nano = parseNanoUsd(row.nanoUsd);
      if (nano === undefined) basis.unpriced = true;
      else basis.nano = (basis.nano ?? 0n) + nano;
      byBasis.set(row.displayClass, basis);
    }
  }
  if (byBasis.size === 0 && settled === 0) return empty;
  const rows = [...byBasis.entries()].map(([displayClass, basis]) => ({
    label: USAGE_BASIS_LABEL[displayClass as keyof typeof USAGE_BASIS_LABEL] ?? displayClass,
    tokens: basis.tokens,
    // A basis with an unpriced part has no amount: part of a sum would read as the whole.
    ...(basis.nano !== undefined && !basis.unpriced ? { amount: formatUsd(basis.nano) } : {}),
  }));
  const complete = !conflict && !unattributed && settled === observed.usageUnitIds.length;
  return {
    state: 'recorded',
    coverage: conflict ? 'conflict' : complete ? 'complete' : 'partial',
    tokens,
    rows,
    ...(complete && rows.length === 1 && rows[0].amount ? { single: rows[0].amount } : {}),
  };
}

function usageSection(observed: RequestCloseoutRecordV1, usage: ProjectedUsage): RequestSummarySection {
  const rows: RequestSummarySection['rows'] = [];
  const notes: string[] = [];
  if (usage.state === 'not-recorded') {
    rows.push({ label: 'Usage', value: 'not recorded', tone: 'caution' });
    notes.push('No usage is recorded for this turn. That is not zero usage.');
  } else {
    rows.push({
      label: 'Tokens',
      value: `${whole(usage.tokens.input)} input${usage.tokens.cachedInput > 0 ? ` (${whole(usage.tokens.cachedInput)} from cache)` : ''}, ${whole(usage.tokens.output)} output`,
    });
    for (const row of usage.rows) {
      rows.push({ label: row.label, value: row.amount ? `${row.amount} for ${whole(row.tokens)} tokens` : `${whole(row.tokens)} tokens, no price` });
    }
    if (usage.rows.length === 0) rows.push({ label: 'Cost', value: 'unavailable', tone: 'caution' });
    rows.push({ label: 'Usage attribution', value: USAGE_ATTRIBUTION_WORD[usage.coverage], ...(usage.coverage === 'complete' ? {} : { tone: 'caution' as const }) });
    if (usage.rows.length > 1) notes.push('The amounts above are on different bases and are not added into one total.');
    if (usage.coverage === 'partial') notes.push('Usage of this turn is not fully settled or attributed, so the figures are a lower bound.');
    if (usage.coverage === 'conflict') notes.push('Records of this turn\'s usage disagree, so the figures cannot be relied on.');
  }
  const { timing } = observed;
  if (timing) {
    rows.push({ label: 'Started', value: timing.startedAt, instant: timing.startedAt });
    rows.push({ label: 'Turn time', value: formatDuration(timing.durationMs) });
    if (timing.approvalWaitMs > 0) rows.push({ label: 'Waiting for a person', value: formatDuration(timing.approvalWaitMs) });
  } else {
    rows.push({ label: 'Turn time', value: 'not recorded', tone: 'caution' });
  }
  const limits = observed.observations.limits;
  if (limits) {
    const facts = requestLimitFacts(limits);
    rows.push(...facts.rows);
    notes.push(...facts.notes);
  }
  return { title: 'Usage & timing', rows, ...(notes.length > 0 ? { note: notes.join(' ') } : {}) };
}

/**
 * What a request's limits did, as rows and notes: the totals against each limit, how often a limit was reached
 * and continued, and whether the request was stopped there. One wording for the Request summary and for a Job
 * outcome that stands in its place.
 */
function requestLimitFacts(limits: RequestLimitsObservation): { rows: RequestSummarySection['rows']; notes: string[] } {
  const rows: RequestSummarySection['rows'] = [];
  const notes: string[] = [];
  if (limits.providerTurns) {
    // A turn counted as one is not a model request, so the row never calls a count of turns model requests.
    const { observed: counted, ceiling, hostCountedTurns = 0 } = limits.providerTurns;
    const label = hostCountedTurns === 0
      ? 'Model requests against the limit'
      : hostCountedTurns === counted ? 'Host-counted turns against the limit' : 'Model requests and host-counted turns against the limit';
    const turns = hostCountedTurns > 0 && hostCountedTurns < counted ? ` (${plural(hostCountedTurns, 'host-counted turn')})` : '';
    rows.push({ label, value: `${whole(counted)} observed${turns}, limit ${whole(ceiling)}` });
  }
  if (limits.tokens) rows.push({ label: 'Tokens against the limit', value: `${whole(limits.tokens.observed)} observed, limit ${whole(limits.tokens.ceiling)}` });
  if (limits.crossings > 0) {
    const ending = limits.decision === 'stopped' ? '; then stopped' : '';
    rows.push({ label: 'Limit reached', value: `${plural(limits.crossings, 'time')}; continued ${plural(limits.allowances, 'time')}${ending}`, tone: 'caution' });
  }
  if (limits.coverage !== 'complete') {
    // Partial has two causes and the record does not say which: a CLI route, or usage that was not reported.
    notes.push('These totals may be a lower bound. On the Claude CLI and Codex routes UnodeAi counts each turn it starts as one (a host-counted turn), learns the tokens of a turn when it ends, and can neither count nor hold the model requests the CLI makes inside a turn. Usage a route did not report is never counted as zero. A limit acts at the next point UnodeAi controls.');
  }
  // Said of a token limit only. A request limited by model requests alone has no token limit to explain.
  if (limits.tokens) notes.push('The token limit counts raw tokens, cached input once. It is not a cost-weighted threshold.');
  return { rows, notes };
}

/** Said with the limit facts wherever they stand beside a run's own facts: they are the request's, not the run's. */
export const REQUEST_LIMIT_SOURCE_NOTE = 'These are facts of the request this job belongs to, read from that request\'s own record. They are not facts of the run.';

/**
 * v0.9.94: what the limits of a record's request did, as one section: the Request summary's own rows and notes,
 * and whose facts they are. Undefined for no record and for a request that had no limit.
 */
export function requestLimitSection(
  record: RequestCloseoutRecordV1 | undefined,
): { title: 'Request limit'; rows: RequestSummarySection['rows']; note: string } | undefined {
  const limits = record?.observations.limits;
  if (!limits) return undefined;
  const facts = requestLimitFacts(limits);
  if (facts.rows.length === 0) return undefined;
  return { title: 'Request limit', rows: facts.rows, note: [REQUEST_LIMIT_SOURCE_NOTE, ...facts.notes].join(' ') };
}

/**
 * v0.9.94: the closeout record of the turn that closed a run: the coordinator's own record of that exact turn.
 * A run that has no closing turn has none, and neither has a turn whose record is not kept. No other turn of
 * the conversation, however near, and no other agent's record stands in for it: what `recordOfTurn` hands back
 * is taken only when it is that agent's record of that turn.
 */
export function closingTurnCloseout(
  run: { coordinatorId: string; closingTurnId?: string } | undefined,
  recordOfTurn: RequestCloseoutOfTurn,
): RequestCloseoutRecordV1 | undefined {
  if (!run?.closingTurnId) return undefined;
  const record = recordOfTurn(run.coordinatorId, run.closingTurnId);
  return record && record.terminalTurnId === run.closingTurnId && record.rootAgentId === run.coordinatorId ? record : undefined;
}

/** The record kept for one agent's turn, by the exact turn. */
export type RequestCloseoutOfTurn = (agentId: string, terminalTurnId: string) => RequestCloseoutRecordV1 | undefined;

/**
 * v0.9.94: the Job outcome of a turn, with the limit facts of that turn's request.
 *
 * A turn shows one card. Where it closed a coordinated run, that card is the Job outcome and the turn's Request
 * summary is not shown, so what the request's limits did would be on no card. The facts stay where they are
 * recorded, on the request closeout record of the same turn; nothing is copied into the run. This adds them to
 * the view as one more section, in the Request summary's own words.
 *
 * `record` is the closeout record of the turn the card stands at, found by that exact turn. With no record, with
 * a record of a request that had no limit, or with a card that shows no outcome, the view is returned as it is.
 */
export function jobOutcomeWithRequestLimits(view: JobOutcomeViewV1, record: RequestCloseoutRecordV1 | undefined): JobOutcomeViewV1 {
  if (!view.available) return view;
  const section = requestLimitSection(record);
  return section ? { ...view, sections: [...view.sections, section] } : view;
}

/**
 * v0.9.94: the Job outcome of a run as a person is shown it, on every surface: the card in Chat, its expanded
 * state and the evidence report. It is the run's own view with the limit facts of the request, read from the
 * record of the run's closing turn. Every surface asks here, so the card and its report cannot say different
 * things. A failure to read the records leaves the run's own view.
 */
export function displayedJobOutcomeView(
  view: JobOutcomeViewV1,
  run: { coordinatorId: string; closingTurnId?: string } | undefined,
  recordOfTurn: RequestCloseoutOfTurn,
): JobOutcomeViewV1 {
  try {
    return jobOutcomeWithRequestLimits(view, closingTurnCloseout(run, recordOfTurn));
  } catch {
    return view;
  }
}

function remainingSection(observed: RequestCloseoutRecordV1, state: RequestSummaryState): RequestSummarySection {
  const { observations } = observed;
  const rows: RequestSummarySection['rows'] = [];
  const items: string[] = [];
  const run = observations.run;
  if (state === 'job-closed') {
    return {
      title: 'Remaining',
      rows: [{ label: 'Job', value: 'closed; see its Job outcome' }],
    };
  }
  if (observations.limits?.decision === 'awaiting') {
    rows.push({ label: 'Request limit', value: 'waiting for your decision: stop or continue', tone: 'caution' });
  }
  if (run) {
    if (run.tasks.active > 0) {
      rows.push({ label: 'Delegated work', value: `${plural(run.tasks.active, 'task')} running ${run.afterTurn ? 'after' : 'when'} this turn ended` });
      for (const handle of run.handles) items.push(`task ${handle}`);
      if (run.omittedHandles > 0) items.push(`${plural(run.omittedHandles, 'more task')} not listed`);
    } else {
      rows.push({ label: 'Delegated work', value: 'no live work or next action recorded', tone: 'caution' });
    }
    if (run.tasks.cancelled + run.tasks.interrupted > 0) {
      rows.push({ label: 'Stopped or interrupted tasks', value: whole(run.tasks.cancelled + run.tasks.interrupted), tone: 'caution' });
    }
    if (run.policyRefused > 0) rows.push({ label: 'Dispatches refused by team policy', value: whole(run.policyRefused), tone: 'caution' });
  }
  switch (state) {
    case 'stopped':
      rows.push({ label: 'This turn', value: 'stopped before it finished', tone: 'caution' });
      break;
    case 'failed':
      rows.push({ label: 'This turn', value: 'did not finish', tone: 'negative' });
      break;
    case 'no-conclusion':
      rows.push({ label: 'This turn', value: 'ended without a conclusion', tone: 'caution' });
      break;
    case 'needs-you':
      if (observed.terminal.kind === 'host-deadline') rows.push({ label: 'This turn', value: 'ended by UnodeAi; retry, change the route, or stop', tone: 'caution' });
      break;
    case 'answered':
    case 'completed':
    case 'in-progress':
    case 'blocked':
      break;
    default:
      return unhandled(state);
  }
  if (rows.length === 0) rows.push({ label: 'Remaining work', value: 'none recorded' });
  return {
    title: 'Remaining',
    rows,
    ...(items.length > 0 ? { items } : {}),
    note: 'This lists what UnodeAi recorded as unfinished. "None recorded" does not say that nothing remains.',
  };
}

function whole(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString('en-US');
}

function plural(value: number, noun: string): string {
  return `${whole(value)} ${noun}${value === 1 ? '' : 's'}`;
}

function unhandled(value: never): never {
  throw new Error(`Unhandled request closeout value: ${JSON.stringify(value)}`);
}
