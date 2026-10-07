/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Job outcome projection (v0.9.93)
 *
 *  One pure function from a closed run's stored host facts to what the Job outcome card, its expanded
 *  view and the evidence report say. It reads; it never calls a model, runs a command, touches the network
 *  or writes. Each fact has one authority, and a fact that was not recorded, is only partly recorded or is
 *  in conflict is said to be so: it never becomes zero, a pass or an empty list.
 *
 *  Nothing here reads assistant or agent prose. Lifecycle and completion come from the run's own closeout,
 *  attempts and retries from its delegations and their typed retry links, tool counts from turn outcome
 *  receipts, checks from the declared verification plan and its host result, changes from write-time
 *  digests, usage from the spend units the run's turns name, approvals from permission receipts, and
 *  timing from the run's timestamps and its turn entries.
 *--------------------------------------------------------------------------------------------*/
import type { TurnTimingPhases } from '../session/TurnTiming';
import type { DisplayClass } from '../models/spend/SpendAggregate';
import { formatUsd, nanoToString, parseNanoUsd } from '../models/spend/Money';
import {
  latestRunVerdictResolution,
  type RunCloseoutBasis,
  type RunDelegation,
  type RunPermissionKind,
  type RunRecord,
} from './RunLedger';
import { projectRetryTopology } from './RetryTopology';
import { UTC_TIMESTAMPS_NOTE } from './evidenceTimes';
import { isPortableRelativePath } from './PortableRunEvidence';

export const JOB_OUTCOME_SCHEMA_VERSION = 1 as const;
export type JobOutcomeId = `outcome:${string}`;

/** The stable presentation identity of a run's outcome: a function of the run id and of nothing else. */
export function jobOutcomeId(runId: string): JobOutcomeId {
  return `outcome:${runId}`;
}

export type EvidenceCoverage = 'complete' | 'partial' | 'not-recorded' | 'conflict';

const MAX_LISTED_FILES = 50;
const MAX_PATH_CHARS = 240;
const MAX_REMAINING_ITEMS = 20;
const MAX_LABEL_CHARS = 80;

// ─── Inputs beside the run ──────────────────────────────────────────────────────────────

export interface JobUsageRow {
  displayClass: DisplayClass;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Absent when this basis has no price: tokens only. Never zero in its place. */
  nanoUsd?: string;
}

/** What the spend authority holds for one usage unit, read by exact unit id. */
export interface JobUsageUnitFacts {
  state: 'settled' | 'open' | 'gap';
  /** Copies of the unit's records disagree. */
  quarantined: boolean;
  /** The unit's receipt says one or more provider attempts could not be attributed. */
  unattributed: boolean;
  rows: JobUsageRow[];
}

/** Undefined means the spend authority holds nothing under that id. */
export type JobUsageLookup = (usageUnitId: string) => JobUsageUnitFacts | undefined;

// ─── The projection ─────────────────────────────────────────────────────────────────────

export interface JobWorkV1 {
  /** Attempts grouped through typed retry links only. */
  logicalTasks: number;
  attempts: number;
  retryChains: number;
  /** Logical tasks by the state of their last attempt. */
  settled: number;
  cancelled: number;
  interrupted: number;
  unfinished: number;
  refusedBeforeDispatch: number;
  policyRefused: number;
  retryLinkGaps: number;
  /**
   * Of the retry grouping. `not-recorded` for a run with several attempts written before retry links existed:
   * its attempts are counted singly and nothing is known about retries among them.
   */
  coverage: EvidenceCoverage;
}

export type JobVerificationState = 'verified' | 'failed' | 'not-run' | 'no-applicable-sensor' | 'coverage-incomplete';

export interface JobVerificationV1 {
  state: JobVerificationState;
  /** Host-evaluated sensors of the tasks the checks apply to. */
  checks: { planned: number; passed: number; failed: number; notRun: number };
  /** Tasks whose result is still the job's result, and how many of them carry a host verification result. */
  tasks: number;
  tasksRecorded: number;
  coverage: EvidenceCoverage;
}

export interface JobChangesV1 {
  coverage: EvidenceCoverage;
  fileCount: number;
  /** Workspace-relative, sorted, bounded. No contents. */
  files: string[];
  omittedFiles: number;
  /** Recorded paths that could not be proved workspace-relative; counted, never shown. */
  droppedPaths: number;
  unrecordedWrites: boolean;
  /** Only delegated work is observed at the write boundary; the coordinator's own writes are not in this list. */
  scope: 'delegated-work';
}

export interface JobToolSummaryV1 {
  coverage: EvidenceCoverage;
  /** Turns whose receipt is counted below. */
  turns: number;
  total: number;
  success: number;
  refused: number;
  failed: number;
  failureKinds: Array<{ kind: string; count: number }>;
  refusalReasons: Array<{ reason: string; count: number }>;
}

export type JobCostV1 =
  | { state: 'unavailable' }
  | { state: 'single-basis'; displayClass: DisplayClass; nanoUsd: string }
  | { state: 'mixed-basis' };

export type JobUsageV1 =
  | { state: 'not-recorded' }
  | {
      state: 'recorded';
      coverage: Exclude<EvidenceCoverage, 'not-recorded'>;
      /** Recorded turn entries of the run, and how many of them have a settled spend unit. */
      turns: number;
      unitsSettled: number;
      tokens: { input: number; cachedInput: number; output: number };
      cost: JobCostV1;
      /** One row per cost basis. Bases are never added into one dollar figure. */
      rows: Array<{ displayClass: DisplayClass; tokens: number; nanoUsd?: string }>;
    };

export interface JobApprovalSummaryV1 {
  total: number;
  allowed: number;
  denied: number;
  expired: number;
  byKind: Array<{ kind: RunPermissionKind; allowed: number; denied: number; expired: number }>;
}

export interface JobClockV1 {
  requestAcceptedAt: { state: 'recorded'; at: string } | { state: 'not-recorded' };
  /** The earliest dispatch the host accepted. A job whose every dispatch was refused has none. */
  firstDispatchAt: { state: 'recorded'; at: string } | { state: 'none' };
  /** When the host opened the run's record: at its first accepted dispatch, or at a refusal by team policy. */
  recordOpenedAt: string;
  closedAt: string;
}

export type JobPhaseName = 'queued' | 'host' | 'provider-wait' | 'reasoning' | 'responding' | 'tool';

export type JobPhaseBreakdownV1 =
  | { state: 'not-recorded' }
  | {
      state: 'recorded';
      coverage: Exclude<EvidenceCoverage, 'not-recorded'>;
      /** Turn entries that contributed. Agents overlap, so these totals can exceed the job's elapsed time. */
      turns: number;
      totals: TurnTimingPhases;
      approvalWaitMs: number;
      /** Named only when every expected turn contributed. */
      dominant?: JobPhaseName;
    };

export interface JobTimingV1 {
  clock: JobClockV1;
  /**
   * Wall clock, to the close: from the accepted request when that instant is recorded, else from the first
   * accepted dispatch, else, when nothing was dispatched, from the opening of the run's record.
   */
  elapsedMs: number;
  elapsedBasis: 'since-request' | 'since-first-dispatch' | 'since-record-opened';
  /** Recorded only when both instants are: a job without an accepted dispatch has no such time. */
  timeToFirstDispatchMs: { state: 'recorded'; ms: number } | { state: 'not-recorded' };
  phases: JobPhaseBreakdownV1;
}

export type JobRemainingReason =
  | 'interrupted'
  | 'stopped'
  | 'abandoned'
  | 'still-active'
  | 'timed-out'
  | 'partial-result'
  | 'result-not-observed'
  | 'needs-rework'
  | 'rejected'
  | 'needs-human'
  | 'deferred';

export interface JobRemainingWorkV1 {
  state: 'none' | 'some';
  items: Array<{ handle: string; agentId: string; requested: string; reason: JobRemainingReason }>;
  omittedItems: number;
  /**
   * Dispatches that team policy refused. Nothing was started for them, and they are not tasks. No later dispatch
   * is taken to have replaced one: the host records no link between a refusal and another dispatch.
   */
  blocked: Array<{ requested: string; reason: 'policy-refused'; policyId?: string }>;
  omittedBlocked: number;
  /** The run was closed as partial and nothing listed above accounts for it. */
  closeoutPartial: boolean;
}

export type JobHumanVerdictV1 = 'accepted' | 'accepted-with-exceptions' | 'rejected' | 'unjudged' | 'withheld';

export interface JobOutcomeProjectionV1 {
  schemaVersion: typeof JOB_OUTCOME_SCHEMA_VERSION;
  state: 'available';
  id: JobOutcomeId;
  runId: string;
  coordinatorId: string;
  lifecycle: 'closed';
  completion: 'complete' | 'partial' | 'not-recorded';
  /** Present when the host, not the coordinator's own closeout, closed the run. */
  closeoutBasis?: RunCloseoutBasis;
  work: JobWorkV1;
  verification: JobVerificationV1;
  changes: JobChangesV1;
  tools: JobToolSummaryV1;
  usage: JobUsageV1;
  approvals: JobApprovalSummaryV1;
  timing: JobTimingV1;
  remaining: JobRemainingWorkV1;
  /** A person's judgement, shown apart: it never changes completion or verification. */
  humanVerdict: JobHumanVerdictV1;
}

export type JobOutcomeUnavailableReason = 'run-not-retained' | 'run-not-closed' | 'anchor-conflict';

/** What a surviving anchor shows when its run cannot back it: no derived value at all. */
export interface JobOutcomeUnavailableV1 {
  schemaVersion: typeof JOB_OUTCOME_SCHEMA_VERSION;
  state: 'unavailable';
  id: JobOutcomeId;
  runId: string;
  reason: JobOutcomeUnavailableReason;
}

export type JobOutcomeV1 = JobOutcomeProjectionV1 | JobOutcomeUnavailableV1;

export function unavailableJobOutcome(runId: string, reason: JobOutcomeUnavailableReason): JobOutcomeUnavailableV1 {
  return { schemaVersion: JOB_OUTCOME_SCHEMA_VERSION, state: 'unavailable', id: jobOutcomeId(runId), runId, reason };
}

/**
 * Project one run. A run that is not held any more, or is not closed, has no outcome to show: a card exists only
 * for a closed run, and an anchor that outlived its run says that its evidence is unavailable.
 */
export function projectJobOutcome(runId: string, run: RunRecord | undefined, usage: JobUsageLookup): JobOutcomeV1 {
  if (!run || run.id !== runId) return unavailableJobOutcome(runId, 'run-not-retained');
  if (run.status !== 'closed' || !run.endedAt) return unavailableJobOutcome(runId, 'run-not-closed');
  const expected = expectedTurns(run);
  const verdict = latestRunVerdictResolution(run);
  return {
    schemaVersion: JOB_OUTCOME_SCHEMA_VERSION,
    state: 'available',
    id: jobOutcomeId(run.id),
    runId: run.id,
    coordinatorId: run.coordinatorId,
    lifecycle: 'closed',
    completion: run.closeoutCompletionState ?? 'not-recorded',
    ...(run.closeoutBasis ? { closeoutBasis: run.closeoutBasis } : {}),
    work: projectWork(run),
    verification: projectVerification(run),
    changes: projectChanges(run),
    tools: projectTools(run, expected),
    usage: projectUsage(run, expected, usage),
    approvals: projectApprovals(run),
    timing: projectTiming(run, expected, run.endedAt),
    remaining: projectRemaining(run),
    humanVerdict: verdict.status === 'accepted' ? verdict.verdict.verdict : verdict.status === 'withheld' ? 'withheld' : 'unjudged',
  };
}

// ─── Attempts, tasks and what is left ───────────────────────────────────────────────────

interface LogicalTask {
  /** The last attempt: the one whose result stands for the task. */
  final: RunDelegation;
  attempts: RunDelegation[];
}

function logicalTasks(run: RunRecord): { tasks: LogicalTask[]; retryChains: number; gaps: number; conflict: boolean } {
  const topology = projectRetryTopology(run.delegations);
  const byHandle = new Map(run.delegations.map((delegation) => [delegation.handle, delegation]));
  const tasks = topology.tasks.map((task) => {
    const attempts = task.attempts.map((handle) => byHandle.get(handle)!).filter(Boolean);
    return { final: attempts[attempts.length - 1], attempts };
  }).filter((task) => task.final);
  return {
    tasks,
    retryChains: topology.retryChains,
    gaps: topology.gaps.length,
    conflict: topology.gaps.some((gap) => gap.gap === 'conflict'),
  };
}

type TerminalDisposition = 'superseded' | 'abandoned';

/** The first superseded or abandoned decision: such a decision is final, and a later entry cannot undo it. */
function terminalDisposition(delegation: RunDelegation): TerminalDisposition | undefined {
  const entry = delegation.dispositions.find((candidate) =>
    candidate.disposition === 'superseded' || candidate.disposition === 'abandoned');
  return entry?.disposition as TerminalDisposition | undefined;
}

/** Why a task is not finished, or undefined when its result stands. A superseded task was replaced, not left. */
function remainingReason(delegation: RunDelegation): JobRemainingReason | undefined {
  const terminal = terminalDisposition(delegation);
  if (terminal === 'superseded') return undefined;
  if (terminal === 'abandoned') return 'abandoned';
  switch (delegation.state) {
    case 'active': return 'still-active';
    case 'interrupted': return 'interrupted';
    case 'cancelled': return 'stopped';
    case 'settled': break;
    default: return unreachable(delegation.state);
  }
  const latest = delegation.dispositions[delegation.dispositions.length - 1]?.disposition;
  if (latest === 'needs-rework') return 'needs-rework';
  if (latest === 'rejected') return 'rejected';
  if (latest === 'needs-human') return 'needs-human';
  if (latest === 'deferred') return 'deferred';
  if (delegation.evidence?.outcome === 'timed-out') return 'timed-out';
  if (delegation.evidence?.completionState === 'partial') return 'partial-result';
  if (!delegation.evidence || delegation.evidence.completionState === 'not-observed') return 'result-not-observed';
  return undefined;
}

function projectWork(run: RunRecord): JobWorkV1 {
  const { tasks, retryChains, gaps, conflict } = logicalTasks(run);
  const count = (state: RunDelegation['state']) => tasks.filter((task) => task.final.state === state).length;
  return {
    logicalTasks: tasks.length,
    attempts: run.delegations.length,
    retryChains,
    settled: count('settled'),
    cancelled: count('cancelled'),
    interrupted: count('interrupted'),
    unfinished: tasks.filter((task) => remainingReason(task.final) !== undefined).length,
    refusedBeforeDispatch: run.refusedDispatches.length,
    policyRefused: run.refusedDispatches.filter((refusal) => refusal.taskState === 'policy-refused').length,
    retryLinkGaps: gaps,
    coverage: conflict ? 'conflict'
      : gaps > 0 ? 'partial'
        : run.retryTopology !== 'recorded' && run.delegations.length > 1 ? 'not-recorded'
          : 'complete',
  };
}

function projectRemaining(run: RunRecord): JobRemainingWorkV1 {
  const all: JobRemainingWorkV1['items'] = [];
  for (const task of logicalTasks(run).tasks) {
    const reason = remainingReason(task.final);
    if (!reason) continue;
    all.push({
      handle: task.final.handle,
      agentId: task.final.agentId,
      requested: bounded(task.final.requestedAgent, MAX_LABEL_CHARS),
      reason,
    });
  }
  // A dispatch refused by team policy is terminal: the host started nothing for it and hands the work to no one
  // else. It is work that was asked for and is not done, so it is said here and not only counted under Work.
  const blocked: JobRemainingWorkV1['blocked'] = run.refusedDispatches
    .filter((refusal) => refusal.taskState === 'policy-refused')
    .map((refusal) => ({
      requested: bounded(refusal.requestedAgent, MAX_LABEL_CHARS),
      reason: 'policy-refused' as const,
      ...(refusal.policyId ? { policyId: bounded(refusal.policyId, MAX_LABEL_CHARS) } : {}),
    }));
  const listed = all.length + blocked.length;
  return {
    state: listed > 0 || run.closeoutCompletionState === 'partial' ? 'some' : 'none',
    items: all.slice(0, MAX_REMAINING_ITEMS),
    omittedItems: Math.max(0, all.length - MAX_REMAINING_ITEMS),
    blocked: blocked.slice(0, MAX_REMAINING_ITEMS),
    omittedBlocked: Math.max(0, blocked.length - MAX_REMAINING_ITEMS),
    closeoutPartial: run.closeoutCompletionState === 'partial' && listed === 0,
  };
}

// ─── Verification ───────────────────────────────────────────────────────────────────────

type TaskVerification = 'verified' | 'failed' | 'not-run' | 'no-applicable-sensor' | 'not-recorded';

/** One task's verification, from the host's evaluation of its declared plan. Its reply text is never read. */
function taskVerification(delegation: RunDelegation): {
  state: TaskVerification;
  checks: JobVerificationV1['checks'];
} {
  const checks = { planned: 0, passed: 0, failed: 0, notRun: 0 };
  const evidence = delegation.evidence;
  if (!evidence) return { state: 'not-recorded', checks };
  for (const sensor of evidence.verificationSensors ?? []) {
    checks.planned++;
    if (sensor.status === 'passed') checks.passed++;
    else if (sensor.status === 'failed') checks.failed++;
    else checks.notRun++;
  }
  switch (evidence.verificationPlanStatus) {
    case 'satisfied': return { state: 'verified', checks };
    case 'failed': return { state: 'failed', checks };
    case 'not-run': return { state: 'not-run', checks };
    case 'no-applicable-sensor': return { state: 'no-applicable-sensor', checks };
    case undefined: break;
    default: return unreachable(evidence.verificationPlanStatus);
  }
  // A task dispatched without a declared plan: the workspace's verification gate, as the host observed it.
  if (evidence.verification.ran) {
    checks.planned++;
    if (evidence.verification.passed) checks.passed++;
    else checks.failed++;
    return { state: evidence.verification.passed ? 'verified' : 'failed', checks };
  }
  return { state: evidence.outcome === 'no-applicable-sensor' ? 'no-applicable-sensor' : 'not-run', checks };
}

function projectVerification(run: RunRecord): JobVerificationV1 {
  // The tasks the checks apply to: those whose result is still the job's result. A superseded or abandoned task
  // has no result to verify.
  const applicable = logicalTasks(run).tasks.filter((task) => terminalDisposition(task.final) === undefined);
  const checks = { planned: 0, passed: 0, failed: 0, notRun: 0 };
  const states: TaskVerification[] = [];
  for (const task of applicable) {
    const result = taskVerification(task.final);
    states.push(result.state);
    checks.planned += result.checks.planned;
    checks.passed += result.checks.passed;
    checks.failed += result.checks.failed;
    checks.notRun += result.checks.notRun;
  }
  const recorded = states.filter((state) => state !== 'not-recorded').length;
  const has = (state: TaskVerification) => states.includes(state);
  const withSensor = states.filter((state) => state !== 'no-applicable-sensor');
  const state: JobVerificationState = has('failed') ? 'failed'
    : states.length === 0 ? 'not-run'
      : withSensor.length === 0 ? 'no-applicable-sensor'
        : withSensor.every((entry) => entry === 'verified') ? 'verified'
          : withSensor.every((entry) => entry === 'not-run') ? 'not-run'
            : 'coverage-incomplete';
  return {
    state,
    checks,
    tasks: applicable.length,
    tasksRecorded: recorded,
    coverage: applicable.length === 0 ? 'not-recorded' : recorded === applicable.length ? 'complete' : 'partial',
  };
}

// ─── Changes ────────────────────────────────────────────────────────────────────────────

function projectChanges(run: RunRecord): JobChangesV1 {
  const paths = new Set<string>();
  let dropped = 0;
  let unrecordedWrites = false;
  let whole = 0;
  let anyRecord = false;
  for (const delegation of run.delegations) {
    const recorded = [
      ...(delegation.diffDigest?.files.map((file) => file.path) ?? []),
      ...(delegation.evidence?.changedFiles ?? []),
    ];
    for (const path of recorded) {
      if (isPortableRelativePath(path) && path.length <= MAX_PATH_CHARS) paths.add(path.replace(/\\/g, '/'));
      else dropped++;
    }
    if (delegation.diffDigest || delegation.diffDigestUnavailable || delegation.evidence) anyRecord = true;
    if (delegation.evidence?.unrecordedWrites) unrecordedWrites = true;
    // A complete digest of a settled attempt is the only proof that its list is whole.
    if (delegation.diffDigest && !delegation.diffDigestUnavailable && delegation.state === 'settled') whole++;
  }
  const files = [...paths].sort();
  return {
    coverage: !anyRecord ? 'not-recorded'
      : whole === run.delegations.length && !unrecordedWrites && dropped === 0 ? 'complete'
        : 'partial',
    fileCount: files.length,
    files: files.slice(0, MAX_LISTED_FILES),
    omittedFiles: Math.max(0, files.length - MAX_LISTED_FILES),
    droppedPaths: dropped,
    unrecordedWrites,
    scope: 'delegated-work',
  };
}

// ─── Turns a run proves it had ──────────────────────────────────────────────────────────

/**
 * The turns a run proves existed, from facts that do not depend on the turn entries: the coordinator turn that
 * opened it, the one that closed it, and for each delegation one turn of its agent on its handle. It is a lower
 * bound: a coordinator turn between the first and the last leaves no trace when its entry is missing.
 */
interface ExpectedTurns {
  openingTurnId?: string;
  closingTurnId?: string;
  delegated: Array<{ handle: string; agentId: string }>;
}

function expectedTurns(run: RunRecord): ExpectedTurns {
  return {
    ...(run.openingTurnId ? { openingTurnId: run.openingTurnId } : {}),
    ...(run.closingTurnId ? { closingTurnId: run.closingTurnId } : {}),
    delegated: run.delegations.map((delegation) => ({ handle: delegation.handle, agentId: delegation.agentId })),
  };
}

/** Whether every expected turn is among the given ones. Without both coordinator turn ids nothing can be proved. */
function coversExpected(
  expected: ExpectedTurns,
  turns: ReadonlyArray<{ turnId: string; agentId: string; correlationId?: string }>,
): boolean {
  if (!expected.openingTurnId || !expected.closingTurnId) return false;
  const ids = new Set(turns.map((turn) => turn.turnId));
  if (!ids.has(expected.openingTurnId) || !ids.has(expected.closingTurnId)) return false;
  return expected.delegated.every((delegation) =>
    turns.some((turn) => turn.agentId === delegation.agentId && turn.correlationId === delegation.handle));
}

/** A coordinator closeout with every delegation settled: the only run whose turn set can be called whole. */
function settledByCoordinator(run: RunRecord): boolean {
  return !run.closeoutBasis && run.delegations.every((delegation) => delegation.state === 'settled');
}

// ─── Tools ──────────────────────────────────────────────────────────────────────────────

function projectTools(run: RunRecord, expected: ExpectedTurns): JobToolSummaryV1 {
  const summary: JobToolSummaryV1 = {
    coverage: 'not-recorded', turns: 0, total: 0, success: 0, refused: 0, failed: 0, failureKinds: [], refusalReasons: [],
  };
  if (run.turnOutcomes.length === 0) {
    return { ...summary, coverage: run.droppedTurnOutcomes > 0 ? 'partial' : 'not-recorded' };
  }
  const failureKinds = new Map<string, number>();
  const refusalReasons = new Map<string, number>();
  const counted: Array<{ turnId: string; agentId: string; correlationId?: string }> = [];
  let conflict = false;
  let partial = run.droppedTurnOutcomes > 0;
  for (const entry of run.turnOutcomes) {
    if (entry.state === 'conflict') {
      conflict = true;
      continue;
    }
    const { receipt } = entry;
    counted.push({ turnId: receipt.turnId, agentId: receipt.agentId, ...(receipt.correlationId ? { correlationId: receipt.correlationId } : {}) });
    summary.total += receipt.tools.total;
    summary.success += receipt.tools.success;
    summary.refused += receipt.tools.refused;
    summary.failed += receipt.tools.failed;
    if (receipt.tools.coverage !== 'complete') partial = true;
    for (const [kind, value] of Object.entries(receipt.tools.failureKinds)) failureKinds.set(kind, (failureKinds.get(kind) ?? 0) + (value ?? 0));
    for (const [reason, value] of Object.entries(receipt.tools.refusalReasons)) refusalReasons.set(reason, (refusalReasons.get(reason) ?? 0) + (value ?? 0));
  }
  const sorted = (map: Map<string, number>) => [...map.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    ...summary,
    coverage: conflict ? 'conflict'
      : partial || !settledByCoordinator(run) || !coversExpected(expected, counted) ? 'partial'
        : 'complete',
    turns: counted.length,
    failureKinds: sorted(failureKinds).map(([kind, count]) => ({ kind, count })),
    refusalReasons: sorted(refusalReasons).map(([reason, count]) => ({ reason, count })),
  };
}

// ─── Usage ──────────────────────────────────────────────────────────────────────────────

const DISPLAY_CLASS_ORDER: readonly DisplayClass[] = [
  'billed', 'exact-route', 'selected-reference', 'reference', 'published', 'api-equivalent',
  'reported-partial', 'reconstructed', 'unavailable',
];

/**
 * Usage is joined to the run through its turns, by exact id: each turn entry names the spend unit the host opened
 * for it. Selecting spend by run id would leave out the coordinator's opening turn, whose unit began before the
 * run existed.
 */
function projectUsage(run: RunRecord, expected: ExpectedTurns, lookup: JobUsageLookup): JobUsageV1 {
  if (run.turns.length === 0) return { state: 'not-recorded' };
  let conflict = false;
  let partial = run.droppedTurns > 0 || !settledByCoordinator(run);
  const recorded: Array<{ turnId: string; agentId: string; correlationId: string }> = [];
  const seenUnits = new Set<string>();
  const byClass = new Map<DisplayClass, { tokens: number; nano?: bigint; unpriced: boolean }>();
  const tokens = { input: 0, cachedInput: 0, output: 0 };
  let unitsSettled = 0;
  for (const entry of run.turns) {
    if (entry.state === 'conflict') {
      conflict = true;
      continue;
    }
    recorded.push({ turnId: entry.turnId, agentId: entry.agentId, correlationId: entry.correlationId });
    if (!entry.usageUnitId) {
      partial = true;
      continue;
    }
    if (seenUnits.has(entry.usageUnitId)) {
      // Two turns naming one unit: its usage cannot belong to both.
      conflict = true;
      continue;
    }
    seenUnits.add(entry.usageUnitId);
    const unit = lookup(entry.usageUnitId);
    if (!unit || unit.state !== 'settled') partial = true;
    if (!unit) continue;
    if (unit.quarantined) conflict = true;
    if (unit.unattributed) partial = true;
    if (unit.state === 'settled') unitsSettled++;
    for (const row of unit.rows) {
      tokens.input += row.inputTokens;
      tokens.cachedInput += row.cachedInputTokens;
      tokens.output += row.outputTokens;
      const bucket = byClass.get(row.displayClass) ?? { tokens: 0, unpriced: false };
      bucket.tokens += row.inputTokens + row.outputTokens;
      const nano = parseNanoUsd(row.nanoUsd);
      if (nano === undefined) bucket.unpriced = true;
      else bucket.nano = (bucket.nano ?? 0n) + nano;
      byClass.set(row.displayClass, bucket);
    }
  }
  if (!coversExpected(expected, recorded)) partial = true;
  const rows = DISPLAY_CLASS_ORDER.flatMap((displayClass) => {
    const bucket = byClass.get(displayClass);
    if (!bucket) return [];
    // A basis in which any part had no price has no dollar figure at all: a part-sum would read as the whole.
    const priced = bucket.nano !== undefined && !bucket.unpriced;
    return [{ displayClass, tokens: bucket.tokens, ...(priced ? { nanoUsd: nanoToString(bucket.nano!) } : {}) }];
  });
  const priced = rows.filter((row) => row.nanoUsd !== undefined);
  const cost: JobCostV1 = priced.length === 0 ? { state: 'unavailable' }
    : rows.length === 1 ? { state: 'single-basis', displayClass: rows[0].displayClass, nanoUsd: rows[0].nanoUsd! }
      : { state: 'mixed-basis' };
  return {
    state: 'recorded',
    coverage: conflict ? 'conflict' : partial ? 'partial' : 'complete',
    turns: recorded.length,
    unitsSettled,
    tokens,
    cost,
    rows,
  };
}

// ─── Approvals ──────────────────────────────────────────────────────────────────────────

const PERMISSION_KINDS: readonly RunPermissionKind[] = [
  'command-approval', 'write-approval', 'web-access-approval', 'tool-approval', 'folder-access', 'mcp-grant',
];

function projectApprovals(run: RunRecord): JobApprovalSummaryV1 {
  const byKind = PERMISSION_KINDS.flatMap((kind) => {
    const events = run.permissions.filter((event) => event.kind === kind);
    if (events.length === 0) return [];
    return [{
      kind,
      allowed: events.filter((event) => event.decision === 'allowed').length,
      denied: events.filter((event) => event.decision === 'denied').length,
      expired: events.filter((event) => event.decision === 'expired').length,
    }];
  });
  const sum = (pick: (row: typeof byKind[number]) => number) => byKind.reduce((total, row) => total + pick(row), 0);
  return {
    total: sum((row) => row.allowed + row.denied + row.expired),
    allowed: sum((row) => row.allowed),
    denied: sum((row) => row.denied),
    expired: sum((row) => row.expired),
    byKind,
  };
}

// ─── Timing ─────────────────────────────────────────────────────────────────────────────

const PHASE_BUCKETS: ReadonlyArray<readonly [JobPhaseName, keyof TurnTimingPhases]> = [
  ['queued', 'queuedMs'], ['host', 'hostMs'], ['provider-wait', 'providerWaitMs'],
  ['reasoning', 'reasoningMs'], ['responding', 'respondingMs'], ['tool', 'toolMs'],
];

function projectTiming(run: RunRecord, expected: ExpectedTurns, closedAt: string): JobTimingV1 {
  // The accepted request is the start of the turn that opened the run, found by exact turn id. It is never the
  // earliest message or the earliest entry.
  const opening = expected.openingTurnId
    ? run.turns.find((entry) => entry.state === 'recorded' && entry.turnId === expected.openingTurnId)
    : undefined;
  const requestAcceptedAt = opening?.state === 'recorded' ? opening.timing.startedAt : undefined;
  const closed = Date.parse(closedAt);
  const recordOpened = Date.parse(run.startedAt);
  // The first dispatch is the earliest accepted one, read from the attempts themselves. The run's own start is
  // not it: a refusal by team policy opens a run too, and such a run may hold no accepted dispatch at all.
  let firstDispatchAt: string | undefined;
  let firstDispatch = Number.NaN;
  for (const delegation of run.delegations) {
    const dispatched = Date.parse(delegation.dispatchedAt);
    if (Number.isFinite(dispatched) && (firstDispatchAt === undefined || dispatched < firstDispatch)) {
      firstDispatch = dispatched;
      firstDispatchAt = delegation.dispatchedAt;
    }
  }
  const accepted = requestAcceptedAt === undefined ? Number.NaN : Date.parse(requestAcceptedAt);
  const fromRequest = Number.isFinite(accepted) && accepted <= recordOpened;
  const span = (from: number) => Math.max(0, Math.round(closed - from));
  return {
    clock: {
      requestAcceptedAt: fromRequest ? { state: 'recorded', at: requestAcceptedAt! } : { state: 'not-recorded' },
      firstDispatchAt: firstDispatchAt === undefined ? { state: 'none' } : { state: 'recorded', at: firstDispatchAt },
      recordOpenedAt: run.startedAt,
      closedAt,
    },
    elapsedMs: span(fromRequest ? accepted : firstDispatchAt === undefined ? recordOpened : firstDispatch),
    elapsedBasis: fromRequest ? 'since-request' : firstDispatchAt === undefined ? 'since-record-opened' : 'since-first-dispatch',
    timeToFirstDispatchMs: fromRequest && firstDispatchAt !== undefined
      ? { state: 'recorded', ms: Math.max(0, Math.round(firstDispatch - accepted)) }
      : { state: 'not-recorded' },
    phases: projectPhases(run, expected),
  };
}

function projectPhases(run: RunRecord, expected: ExpectedTurns): JobPhaseBreakdownV1 {
  if (run.turns.length === 0) return { state: 'not-recorded' };
  const totals: TurnTimingPhases = {
    queuedMs: 0, hostMs: 0, providerWaitMs: 0, reasoningMs: 0, respondingMs: 0, toolMs: 0,
    providerWaitCount: 0, longestProviderWaitMs: 0,
  };
  let approvalWaitMs = 0;
  let conflict = false;
  const recorded: Array<{ turnId: string; agentId: string; correlationId: string }> = [];
  for (const entry of run.turns) {
    if (entry.state === 'conflict') {
      conflict = true;
      continue;
    }
    recorded.push({ turnId: entry.turnId, agentId: entry.agentId, correlationId: entry.correlationId });
    const phases = entry.timing.phases;
    for (const [, key] of PHASE_BUCKETS) totals[key] += phases[key];
    totals.providerWaitCount += phases.providerWaitCount;
    totals.longestProviderWaitMs = Math.max(totals.longestProviderWaitMs, phases.longestProviderWaitMs);
    approvalWaitMs += entry.timing.approvalWaitMs;
  }
  const complete = !conflict && run.droppedTurns === 0 && settledByCoordinator(run) && coversExpected(expected, recorded);
  let dominant: JobPhaseName | undefined;
  if (complete) {
    let longest = 0;
    for (const [name, key] of PHASE_BUCKETS) {
      if (totals[key] > longest) {
        longest = totals[key];
        dominant = name;
      }
    }
  }
  return {
    state: 'recorded',
    coverage: conflict ? 'conflict' : complete ? 'complete' : 'partial',
    turns: recorded.length,
    totals,
    approvalWaitMs,
    ...(dominant ? { dominant } : {}),
  };
}

// ─── One view model for the card, its expanded state and the report ─────────────────────

export type JobOutcomeTone = 'positive' | 'caution' | 'negative' | 'neutral';

export interface JobOutcomeSegment {
  text: string;
  tone: JobOutcomeTone;
}

export type JobOutcomeSectionTitle = 'Outcome' | 'Work' | 'Changes' | 'Checks' | 'Remaining' | 'Usage' | 'Approvals' | 'Timing';

export const JOB_OUTCOME_SECTIONS: readonly JobOutcomeSectionTitle[] = [
  'Outcome', 'Work', 'Changes', 'Checks', 'Remaining', 'Usage', 'Approvals', 'Timing',
];

export interface JobOutcomeSection {
  title: JobOutcomeSectionTitle;
  rows: Array<{
    label: string;
    value: string;
    tone?: JobOutcomeTone;
    /**
     * Set when the value is one instant: the same instant in UTC, ISO 8601. `value` is that UTC text. A renderer
     * on the person's machine may show the instant in local time with its zone; one that shows `value` says UTC.
     */
    instant?: string;
  }>;
  /** A bounded list under the rows: file paths, or the work that remains. */
  items?: string[];
  /** What the section cannot show, in words. */
  note?: string;
}

export type JobOutcomeActionId = 'reviewChanges' | 'openEvidence' | 'continueUnfinished' | 'changeTarget' | 'resetCounter';

export interface JobOutcomeAction {
  id: JobOutcomeActionId;
  label: string;
  /** Where the expanded card puts it. */
  section: JobOutcomeSectionTitle;
  title: string;
}

/**
 * Everything a renderer needs, as text and tones. Workbench, sidebar and the Markdown report format this one
 * value; none of them looks at the run, and none decides a state.
 */
export interface JobOutcomeViewV1 {
  schemaVersion: typeof JOB_OUTCOME_SCHEMA_VERSION;
  id: JobOutcomeId;
  runId: string;
  available: boolean;
  /** The collapsed line. */
  headline: JobOutcomeSegment[];
  sections: JobOutcomeSection[];
  actions: JobOutcomeAction[];
}

export interface JobOutcomeLabels {
  /** The roster's current name for an agent, when the host knows one. Presentation only. */
  agentName?: (agentId: string) => string | undefined;
}

const UNAVAILABLE_TEXT: Record<JobOutcomeUnavailableReason, string> = {
  'run-not-retained': 'The run behind this card is no longer retained, so nothing about it is shown.',
  'run-not-closed': 'The run behind this card is not recorded as closed, so no outcome is shown for it.',
  'anchor-conflict': 'Two different records claim this card, so nothing about the run is shown.',
};

export function jobOutcomeView(outcome: JobOutcomeV1, labels: JobOutcomeLabels = {}): JobOutcomeViewV1 {
  if (outcome.state === 'unavailable') {
    return {
      schemaVersion: JOB_OUTCOME_SCHEMA_VERSION,
      id: outcome.id,
      runId: outcome.runId,
      available: false,
      headline: [{ text: 'Outcome evidence unavailable', tone: 'caution' }],
      sections: [{ title: 'Outcome', rows: [], note: UNAVAILABLE_TEXT[outcome.reason] }],
      actions: [],
    };
  }
  return {
    schemaVersion: JOB_OUTCOME_SCHEMA_VERSION,
    id: outcome.id,
    runId: outcome.runId,
    available: true,
    headline: headline(outcome),
    sections: [
      outcomeSection(outcome),
      workSection(outcome),
      changesSection(outcome),
      checksSection(outcome),
      remainingSection(outcome, labels),
      usageSection(outcome),
      approvalsSection(outcome),
      timingSection(outcome),
    ],
    actions: actionsFor(outcome),
  };
}

function actionsFor(outcome: JobOutcomeProjectionV1): JobOutcomeAction[] {
  const actions: JobOutcomeAction[] = [];
  if (outcome.changes.fileCount > 0) {
    actions.push({ id: 'reviewChanges', label: 'Review changes', section: 'Changes', title: 'Open the recorded changes of this job in the change review.' });
  }
  actions.push({ id: 'openEvidence', label: 'Open evidence', section: 'Outcome', title: 'Open this job\'s evidence report. No check is run again.' });
  if (outcome.remaining.state === 'some') {
    actions.push({ id: 'continueUnfinished', label: 'Continue unfinished work', section: 'Remaining', title: 'Start a new request for the work that remains. Nothing is resumed silently, and a refused dispatch is not sent again.' });
  }
  actions.push(
    { id: 'changeTarget', label: 'Change target', section: 'Usage', title: 'Change the spend reminder target. This does not change the job.' },
    { id: 'resetCounter', label: 'Reset counter', section: 'Usage', title: 'Reset a spend counter. This does not change the job.' },
  );
  return actions;
}

const COMPLETION_TEXT: Record<JobOutcomeProjectionV1['completion'], JobOutcomeSegment> = {
  complete: { text: 'Complete', tone: 'positive' },
  partial: { text: 'Partial', tone: 'caution' },
  'not-recorded': { text: 'Completion not recorded', tone: 'caution' },
};

const VERIFICATION_TEXT: Record<JobVerificationState, JobOutcomeSegment> = {
  verified: { text: 'Verified', tone: 'positive' },
  failed: { text: 'Checks failed', tone: 'negative' },
  'not-run': { text: 'Checks not run', tone: 'caution' },
  'no-applicable-sensor': { text: 'No applicable check', tone: 'neutral' },
  'coverage-incomplete': { text: 'Verification coverage incomplete', tone: 'caution' },
};

const COVERAGE_TEXT: Record<EvidenceCoverage, string> = {
  complete: 'complete',
  partial: 'partial',
  'not-recorded': 'not recorded',
  conflict: 'in conflict',
};

/** How a cost basis reads in one word, after its amount. */
const COST_WORD: Record<DisplayClass, string> = {
  billed: 'billed',
  'exact-route': 'estimated',
  'selected-reference': 'estimated',
  reference: 'estimated',
  published: 'estimated',
  'api-equivalent': 'API-equivalent',
  'reported-partial': 'partial',
  reconstructed: 'reconstructed',
  unavailable: 'unpriced',
};

const COST_LABEL: Record<DisplayClass, string> = {
  billed: 'Billed',
  'exact-route': 'Estimate (account or user price)',
  'selected-reference': 'Estimate (selected reference)',
  reference: 'Estimate (reference, display only)',
  published: 'Estimate (gateway published, display only)',
  'api-equivalent': 'API-equivalent (subscription)',
  'reported-partial': 'Partial (stopped before completion)',
  reconstructed: 'Reconstructed (not reported)',
  unavailable: 'Price unavailable (tokens only)',
};

function headline(outcome: JobOutcomeProjectionV1): JobOutcomeSegment[] {
  const segments: JobOutcomeSegment[] = [COMPLETION_TEXT[outcome.completion], VERIFICATION_TEXT[outcome.verification.state]];
  // How the run was closed is the ledger's word and is not changed here. A task that did not finish is said
  // beside it, so that a closed line never hides one.
  const unfinished = outcome.remaining.items.length + outcome.remaining.omittedItems;
  if (unfinished > 0) {
    segments.push({ text: `${count(unfinished)} task${unfinished === 1 ? '' : 's'} unfinished`, tone: 'caution' });
  }
  // A dispatch that team policy refused never became a task, so it is not in the count above. It is still work
  // that was asked for and not started, and the line says so.
  const blocked = outcome.remaining.blocked.length + outcome.remaining.omittedBlocked;
  if (blocked > 0) {
    segments.push({ text: `${count(blocked)} dispatch${blocked === 1 ? '' : 'es'} refused by team policy`, tone: 'caution' });
  }
  segments.push(changesSegment(outcome.changes));
  const { checks } = outcome.verification;
  if (checks.planned > 0) {
    segments.push({
      text: `${count(checks.passed)}/${count(checks.planned)} checks passed`,
      tone: checks.failed > 0 ? 'negative' : checks.passed === checks.planned ? 'positive' : 'caution',
    });
  }
  segments.push(costSegment(outcome.usage));
  segments.push({ text: `${formatDuration(outcome.timing.elapsedMs)}${ELAPSED_SUFFIX[outcome.timing.elapsedBasis]}`, tone: 'neutral' });
  return segments;
}

/** What the elapsed figure is measured from, when that is not the accepted request. */
const ELAPSED_SUFFIX: Record<JobTimingV1['elapsedBasis'], string> = {
  'since-request': '',
  'since-first-dispatch': ' since first dispatch',
  'since-record-opened': ' since the job was recorded',
};

const ELAPSED_LABEL: Record<JobTimingV1['elapsedBasis'], string> = {
  'since-request': 'Elapsed',
  'since-first-dispatch': 'Elapsed since first dispatch',
  'since-record-opened': 'Elapsed since the job was recorded',
};

function changesSegment(changes: JobChangesV1): JobOutcomeSegment {
  const files = `${count(changes.fileCount)} file${changes.fileCount === 1 ? '' : 's'} changed`;
  switch (changes.coverage) {
    case 'complete': return { text: changes.fileCount === 0 ? 'no file changes observed' : files, tone: 'neutral' };
    case 'partial': return { text: changes.fileCount === 0 ? 'change list incomplete' : `${files}, list incomplete`, tone: 'caution' };
    case 'not-recorded': return { text: 'changes not recorded', tone: 'caution' };
    case 'conflict': return { text: 'change evidence in conflict', tone: 'caution' };
    default: return unreachable(changes.coverage);
  }
}

function costSegment(usage: JobUsageV1): JobOutcomeSegment {
  if (usage.state === 'not-recorded') return { text: 'usage not recorded', tone: 'caution' };
  const suffix = usage.coverage === 'complete' ? '' : usage.coverage === 'conflict' ? ', usage in conflict' : ', usage partial';
  const tone: JobOutcomeTone = usage.coverage === 'complete' ? 'neutral' : 'caution';
  switch (usage.cost.state) {
    case 'unavailable': return { text: `cost unavailable${suffix}`, tone: 'caution' };
    case 'mixed-basis': return { text: `cost on mixed basis${suffix}`, tone };
    case 'single-basis': {
      const nano = parseNanoUsd(usage.cost.nanoUsd);
      return nano === undefined
        ? { text: `cost unavailable${suffix}`, tone: 'caution' }
        : { text: `${formatUsd(nano)} ${COST_WORD[usage.cost.displayClass]}${suffix}`, tone };
    }
    default: return unreachable(usage.cost);
  }
}

function outcomeSection(outcome: JobOutcomeProjectionV1): JobOutcomeSection {
  const verdict: Record<JobHumanVerdictV1, string> = {
    accepted: 'Accepted by a person',
    'accepted-with-exceptions': 'Accepted by a person, with exceptions',
    rejected: 'Rejected by a person',
    unjudged: 'Not judged by a person',
    withheld: 'A stored verdict was withheld',
  };
  return {
    title: 'Outcome',
    rows: [
      { label: 'Lifecycle', value: 'Closed' },
      { label: 'Completion', ...asRow(COMPLETION_TEXT[outcome.completion]) },
      { label: 'Verification', ...asRow(VERIFICATION_TEXT[outcome.verification.state]) },
      {
        label: 'Closed by',
        value: outcome.closeoutBasis === 'interrupted-work-resolved' ? 'UnodeAi, after every interrupted task was superseded or abandoned'
          : outcome.closeoutBasis === 'stopped-work-resolved' ? 'UnodeAi, after a task was stopped and no work was left running'
            : 'The coordinator\'s closing reply',
      },
      { label: 'Human acceptance', value: verdict[outcome.humanVerdict] },
    ],
    note: 'Completion is how the run was closed. Verification is what the host observed of the declared checks. Neither is taken from what an agent wrote.',
  };
}

function workSection(outcome: JobOutcomeProjectionV1): JobOutcomeSection {
  const { work } = outcome;
  const rows: JobOutcomeSection['rows'] = [
    { label: 'Tasks', value: count(work.logicalTasks) },
    { label: 'Attempts', value: work.retryChains > 0 ? `${count(work.attempts)} (${count(work.retryChains)} task${work.retryChains === 1 ? '' : 's'} retried by the host)` : count(work.attempts) },
    { label: 'Settled', value: count(work.settled) },
  ];
  if (work.cancelled > 0) rows.push({ label: 'Stopped', value: count(work.cancelled), tone: 'caution' });
  if (work.interrupted > 0) rows.push({ label: 'Interrupted', value: count(work.interrupted), tone: 'caution' });
  rows.push({ label: 'Unfinished', value: count(work.unfinished), ...(work.unfinished > 0 ? { tone: 'caution' as const } : {}) });
  if (work.refusedBeforeDispatch > 0) {
    rows.push({
      label: 'Refused before dispatch',
      value: work.policyRefused > 0 ? `${count(work.refusedBeforeDispatch)} (${count(work.policyRefused)} by team policy)` : count(work.refusedBeforeDispatch),
    });
  }
  const note = work.coverage === 'conflict' ? `${count(work.retryLinkGaps)} retry link(s) were in conflict or invalid and were not used: those attempts are counted as tasks of their own.`
    : work.coverage === 'partial' ? `${count(work.retryLinkGaps)} retry link(s) were invalid and were not used: those attempts are counted as tasks of their own.`
      : work.coverage === 'not-recorded' ? 'Retry relations were not recorded for this run. Each attempt is counted as a task of its own; none is assumed to be a retry.'
        : undefined;
  return { title: 'Work', rows, ...(note ? { note } : {}) };
}

function changesSection(outcome: JobOutcomeProjectionV1): JobOutcomeSection {
  const { changes } = outcome;
  const notes: string[] = [];
  if (changes.coverage === 'partial') notes.push('The change list is incomplete: at least one task has no complete write-time record.');
  if (changes.coverage === 'not-recorded') notes.push('No change evidence was recorded for this job. That is not a claim that nothing changed.');
  if (changes.unrecordedWrites) notes.push('Writes were observed outside the recorded file list.');
  if (changes.droppedPaths > 0) notes.push(`${count(changes.droppedPaths)} recorded path(s) are not shown because they could not be proved workspace-relative.`);
  if (changes.omittedFiles > 0) notes.push(`${count(changes.omittedFiles)} more file(s) are not listed here.`);
  notes.push('Only delegated work is recorded at the write boundary. Files the coordinator changed itself are not in this list.');
  return {
    title: 'Changes',
    rows: [
      { label: 'Files changed', value: changes.coverage === 'not-recorded' ? 'not recorded' : count(changes.fileCount), ...(changes.coverage === 'complete' ? {} : { tone: 'caution' as const }) },
      { label: 'Evidence', value: COVERAGE_TEXT[changes.coverage] },
    ],
    ...(changes.files.length > 0 ? { items: changes.files } : {}),
    note: notes.join(' '),
  };
}

function checksSection(outcome: JobOutcomeProjectionV1): JobOutcomeSection {
  const { verification } = outcome;
  const { checks } = verification;
  const rows: JobOutcomeSection['rows'] = [
    { label: 'Result', ...asRow(VERIFICATION_TEXT[verification.state]) },
    { label: 'Planned', value: count(checks.planned) },
    { label: 'Passed', value: count(checks.passed) },
    { label: 'Failed', value: count(checks.failed), ...(checks.failed > 0 ? { tone: 'negative' as const } : {}) },
    { label: 'Not run', value: count(checks.notRun), ...(checks.notRun > 0 ? { tone: 'caution' as const } : {}) },
  ];
  const note = verification.coverage === 'complete'
    ? 'Checks are the sensors declared for each task before it started, as the host evaluated them. A statement that tests pass is not a check.'
    : verification.coverage === 'not-recorded'
      ? 'No task of this job has a result the checks apply to.'
      : `${count(verification.tasks - verification.tasksRecorded)} of ${count(verification.tasks)} task(s) have no recorded verification result.`;
  return { title: 'Checks', rows, note };
}

const REMAINING_TEXT: Record<JobRemainingReason, string> = {
  interrupted: 'interrupted before a result',
  stopped: 'stopped before a result',
  abandoned: 'abandoned by the coordinator',
  'still-active': 'still recorded as running',
  'timed-out': 'timed out',
  'partial-result': 'returned a partial result',
  'result-not-observed': 'no completed result was observed',
  'needs-rework': 'sent back for rework',
  rejected: 'rejected by the coordinator',
  'needs-human': 'waiting for a person',
  deferred: 'deferred by the coordinator',
};

function remainingSection(outcome: JobOutcomeProjectionV1, labels: JobOutcomeLabels): JobOutcomeSection {
  const { remaining } = outcome;
  if (remaining.state === 'none') {
    return { title: 'Remaining', rows: [{ label: 'Unfinished work', value: 'None recorded' }] };
  }
  const items = remaining.items.map((item) => {
    const name = bounded(labels.agentName?.(item.agentId) ?? item.requested, MAX_LABEL_CHARS);
    return `${name}: ${REMAINING_TEXT[item.reason]}`;
  });
  for (const refusal of remaining.blocked) {
    // The reference the dispatch named. It is an agent's id only when the coordinator wrote one.
    const name = bounded(labels.agentName?.(refusal.requested) ?? refusal.requested, MAX_LABEL_CHARS);
    items.push(`${name}: refused by team policy before it started${refusal.policyId ? ` (policy ${refusal.policyId})` : ''}`);
  }
  const unfinished = remaining.items.length + remaining.omittedItems;
  const blocked = remaining.blocked.length + remaining.omittedBlocked;
  const rows: JobOutcomeSection['rows'] = [
    { label: 'Unfinished work', value: count(unfinished), ...(unfinished > 0 || remaining.closeoutPartial ? { tone: 'caution' as const } : {}) },
  ];
  if (blocked > 0) rows.push({ label: 'Refused by team policy', value: count(blocked), tone: 'caution' });
  const notes: string[] = [];
  if (remaining.closeoutPartial) notes.push('The run was closed as partial, and nothing listed here accounts for it.');
  const omitted = remaining.omittedItems + remaining.omittedBlocked;
  if (omitted > 0) notes.push(`${count(omitted)} more item(s) are not listed here.`);
  if (blocked > 0) {
    notes.push('A dispatch refused by team policy was never started, and the same dispatch would be refused again. UnodeAi records no link from a refusal to a later dispatch, so it cannot say whether that work was done another way.');
  }
  notes.push('Continuing starts a new request. Nothing is resumed or retried by itself.');
  return {
    title: 'Remaining',
    rows,
    ...(items.length > 0 ? { items } : {}),
    note: notes.join(' '),
  };
}

const REMAINING_REQUEST_TEXT: Record<JobRemainingReason, string> = {
  interrupted: 'was interrupted before it returned a result',
  stopped: 'was stopped before it returned a result',
  abandoned: 'was abandoned',
  'still-active': 'is still recorded as running',
  'timed-out': 'timed out',
  'partial-result': 'returned a partial result',
  'result-not-observed': 'returned no completed result that the host observed',
  'needs-rework': 'was sent back for rework',
  rejected: 'was rejected',
  'needs-human': 'is waiting for a person\'s decision',
  deferred: 'was deferred',
};

/**
 * The text of a new request for a job's unfinished work, composed from the run's typed facts. It quotes no agent
 * reply and no earlier instruction: it names who had each task, what the host recorded about it, and its handle.
 * It also says how each kind of task is redone. The host accepts `replaces_handle` for an interrupted task only,
 * so a request that named it for a stopped task sent the coordinator into a refused call.
 */
export function jobContinuationRequest(outcome: JobOutcomeProjectionV1, labels: JobOutcomeLabels = {}): string {
  const { remaining } = outcome;
  const lines = ['Continue the unfinished work of the earlier job. This is a new request.', '', 'What UnodeAi recorded as unfinished:'];
  for (const item of remaining.items) {
    const name = bounded(labels.agentName?.(item.agentId) ?? item.requested, MAX_LABEL_CHARS);
    lines.push(`- ${name}'s task ${REMAINING_REQUEST_TEXT[item.reason]} (task handle ${item.handle}).`);
  }
  if (remaining.omittedItems > 0) lines.push(`- ${count(remaining.omittedItems)} more unfinished task(s) are not listed here.`);
  for (const refusal of remaining.blocked) {
    const name = bounded(labels.agentName?.(refusal.requested) ?? refusal.requested, MAX_LABEL_CHARS);
    lines.push(`- A dispatch to ${name} was refused by team policy before it started${refusal.policyId ? ` (policy ${refusal.policyId})` : ''}. No work was done for it.`);
  }
  if (remaining.omittedBlocked > 0) lines.push(`- ${count(remaining.omittedBlocked)} more refused dispatch(es) are not listed here.`);
  if (remaining.closeoutPartial) lines.push('- The job was closed as partial, and nothing listed here accounts for it.');
  const interrupted = remaining.items.some((item) => item.reason === 'interrupted');
  const otherTasks = remaining.items.some((item) => item.reason !== 'interrupted') || remaining.omittedItems > 0;
  const how = ['Nothing from the earlier attempts is still running and nothing is resumed. Check the current state of the work first, then redo or finish what is needed.'];
  if (interrupted) how.push('To redo an interrupted task, dispatch it again with replaces_handle set to its handle.');
  if (otherTasks) {
    how.push(interrupted
      ? 'Any other task listed here is redone as a new dispatch, without replaces_handle: the host accepts that parameter for an interrupted task only.'
      : 'To redo a task listed here, dispatch it as a new task, without replaces_handle: the host accepts that parameter for an interrupted task only.');
  }
  // The Owner's decision after the field re-check of 2026-10-04: a coordinator told to continue tried to record a
  // disposition for the stopped task first. The host records one for a settled or an interrupted task only.
  if (remaining.items.some((item) => item.reason === 'stopped')) {
    how.push('A stopped task has no result and takes no disposition: do not call record_task_disposition for it.');
  }
  lines.push('', how.join(' '));
  if (remaining.blocked.length + remaining.omittedBlocked > 0) {
    lines.push(
      '',
      'Do not send a refused dispatch again unchanged: team policy would refuse it again. First check whether that work was done another way. If it was not, give it to a teammate the policy allows, or tell me what would have to change, and wait for my answer before changing any policy.',
    );
  }
  return lines.join('\n');
}

function usageSection(outcome: JobOutcomeProjectionV1): JobOutcomeSection {
  const { usage } = outcome;
  if (usage.state === 'not-recorded') {
    return {
      title: 'Usage',
      rows: [{ label: 'Usage', value: 'not recorded', tone: 'caution' }],
      note: 'This run has no turn records, so its usage cannot be joined to it. That is not zero usage.',
    };
  }
  const rows: JobOutcomeSection['rows'] = [
    {
      label: 'Tokens',
      value: `${count(usage.tokens.input)} input${usage.tokens.cachedInput > 0 ? ` (${count(usage.tokens.cachedInput)} from cache)` : ''}, ${count(usage.tokens.output)} output`,
    },
  ];
  for (const row of usage.rows) {
    const nano = parseNanoUsd(row.nanoUsd);
    rows.push({
      label: COST_LABEL[row.displayClass],
      value: nano === undefined ? `${count(row.tokens)} tokens, no price` : `${formatUsd(nano)} for ${count(row.tokens)} tokens`,
    });
  }
  if (usage.rows.length === 0) rows.push({ label: 'Cost', value: 'unavailable', tone: 'caution' });
  rows.push({ label: 'Coverage', value: COVERAGE_TEXT[usage.coverage], ...(usage.coverage === 'complete' ? {} : { tone: 'caution' as const }) });
  const notes: string[] = [];
  if (usage.cost.state === 'mixed-basis') notes.push('The amounts above are on different bases and are not added into one total.');
  if (usage.coverage === 'partial') {
    // Partial has two causes, and the sentence says which: a recorded turn without settled usage, or a set of
    // turns that cannot be shown to be the whole job's.
    notes.push(usage.unitsSettled < usage.turns
      ? `Usage is known for ${count(usage.unitsSettled)} of ${count(usage.turns)} recorded turn(s); the rest is missing, so the figures are a lower bound.`
      : `Usage is known for all ${count(usage.turns)} recorded turn(s), but it cannot be shown to be the whole job's: a turn may be unrecorded, or part of one could not be attributed. The figures are a lower bound.`);
  }
  if (usage.coverage === 'conflict') notes.push('Records of this run\'s usage disagree, so the figures cannot be relied on.');
  notes.push('A spend target or a counter reset never changes this job.');
  return { title: 'Usage', rows, note: notes.join(' ') };
}

const PERMISSION_LABEL: Record<RunPermissionKind, string> = {
  'command-approval': 'Commands',
  'write-approval': 'File writes',
  'web-access-approval': 'Web access',
  'tool-approval': 'Tools',
  'folder-access': 'Folder access',
  'mcp-grant': 'Integration grants used',
};

function approvalsSection(outcome: JobOutcomeProjectionV1): JobOutcomeSection {
  const { approvals } = outcome;
  // The counts are of approval receipts. A consent dialog that is not an approval, such as the one for reading
  // outside the workspace, writes none, yet the turns record the person's wait. The two are said together, so
  // that "none" is never read as "nobody was asked".
  const { phases } = outcome.timing;
  const personWaitMs = phases.state === 'recorded' ? phases.approvalWaitMs : 0;
  const consentNote = 'Consent dialogs that are not approvals, such as the one for reading outside the workspace, are not counted here.';
  if (approvals.total === 0) {
    return personWaitMs > 0
      ? {
          title: 'Approvals',
          rows: [{ label: 'Approvals', value: 'None recorded', tone: 'caution' }],
          note: `A person was asked something during this job: its turns recorded ${formatDuration(personWaitMs)} of waiting for a person. ${consentNote}`,
        }
      : { title: 'Approvals', rows: [{ label: 'Approvals', value: 'None recorded' }] };
  }
  const describe = (row: { allowed: number; denied: number; expired: number }): string => [
    row.allowed > 0 ? `${count(row.allowed)} allowed` : '',
    row.denied > 0 ? `${count(row.denied)} denied` : '',
    row.expired > 0 ? `${count(row.expired)} expired` : '',
  ].filter(Boolean).join(', ');
  return {
    title: 'Approvals',
    rows: [
      { label: 'All', value: describe(approvals), ...(approvals.denied + approvals.expired > 0 ? { tone: 'caution' as const } : {}) },
      ...approvals.byKind.map((row) => ({ label: PERMISSION_LABEL[row.kind], value: describe(row) })),
    ],
    note: `Counts only. What was approved is in the run's internal evidence, not on this card. ${consentNote}`,
  };
}

const PHASE_LABEL: Record<JobPhaseName, string> = {
  queued: 'Queued',
  host: 'Host work',
  'provider-wait': 'Waiting for the provider',
  reasoning: 'Reasoning',
  responding: 'Responding',
  tool: 'Tools',
};

function timingSection(outcome: JobOutcomeProjectionV1): JobOutcomeSection {
  const { timing } = outcome;
  const rows: JobOutcomeSection['rows'] = [
    { label: ELAPSED_LABEL[timing.elapsedBasis], value: formatDuration(timing.elapsedMs) },
  ];
  if (timing.clock.requestAcceptedAt.state === 'recorded') rows.push(instantRow('Request accepted', timing.clock.requestAcceptedAt.at));
  if (timing.clock.firstDispatchAt.state === 'recorded') {
    rows.push(instantRow('First dispatch', timing.clock.firstDispatchAt.at));
  } else {
    rows.push({ label: 'First dispatch', value: 'none accepted', tone: 'caution' }, instantRow('Job recorded', timing.clock.recordOpenedAt));
  }
  rows.push(instantRow('Closed', timing.clock.closedAt));
  if (timing.timeToFirstDispatchMs.state === 'recorded') {
    rows.push({ label: 'Time to first dispatch', value: formatDuration(timing.timeToFirstDispatchMs.ms) });
  }
  const notes: string[] = ['Chat shows these instants in local time, with the time zone. An exported report shows the same instants in UTC.'];
  if (timing.clock.firstDispatchAt.state === 'none') {
    notes.push('No dispatch was accepted in this job, so it has no first dispatch.');
  }
  if (timing.elapsedBasis === 'since-first-dispatch') {
    notes.push('The moment the request was accepted is not recorded, so the time before the first dispatch is not in the elapsed figure.');
  } else if (timing.elapsedBasis === 'since-record-opened') {
    notes.push('The moment the request was accepted is not recorded, so the elapsed figure starts when UnodeAi first recorded the job.');
  }
  const { phases } = timing;
  if (phases.state === 'not-recorded') {
    rows.push({ label: 'Phase breakdown', value: 'not recorded', tone: 'caution' });
  } else {
    for (const [name, key] of PHASE_BUCKETS) {
      if (phases.totals[key] > 0) rows.push({ label: PHASE_LABEL[name], value: formatDuration(phases.totals[key]) });
    }
    if (phases.totals.providerWaitCount > 0) {
      rows.push({ label: 'Longest provider wait', value: formatDuration(phases.totals.longestProviderWaitMs) });
    }
    if (phases.approvalWaitMs > 0) rows.push({ label: 'Waiting for a person', value: formatDuration(phases.approvalWaitMs) });
    if (phases.dominant) rows.push({ label: 'Most time in', value: PHASE_LABEL[phases.dominant] });
    rows.push({ label: 'Phase coverage', value: `${COVERAGE_TEXT[phases.coverage]}, ${count(phases.turns)} turn(s)`, ...(phases.coverage === 'complete' ? {} : { tone: 'caution' as const }) });
    notes.push('Phase times are observed agent-turn time, added over every recorded turn. Agents work at the same time, so they can exceed the elapsed time above.');
    notes.push('Waiting for the provider means the host had not seen the next event; it says nothing about why.');
  }
  return { title: 'Timing', rows, note: notes.join(' ') };
}

// ─── The report ─────────────────────────────────────────────────────────────────────────

/**
 * The evidence report of one run: the same view the card shows, as Markdown. It formats stored observations
 * only. Generating it runs no check and reads no file.
 */
export function renderJobOutcomeMarkdown(view: JobOutcomeViewV1, exportedAt: string): string {
  const lines = [
    '# UnodeAi job outcome',
    '',
    '**Host-observed.** Every figure below is a stored host observation of this run. Nothing was run, checked or measured again to write this report, and nothing is taken from what an agent wrote.',
    '',
    `- Run: \`${markdownCode(view.runId)}\``,
    `- Report written (UTC): ${markdownText(exportedAt)}`,
    `- ${UTC_TIMESTAMPS_NOTE}`,
    '',
    `> ${view.headline.map((segment) => markdownText(segment.text)).join(' · ')}`,
    '',
  ];
  for (const section of view.sections) {
    lines.push(`## ${section.title}`, '');
    for (const row of section.rows) {
      lines.push(`- ${markdownText(row.instant ? `${row.label} (UTC)` : row.label)}: **${markdownText(row.value)}**`);
    }
    if (section.items?.length) {
      if (section.rows.length > 0) lines.push('');
      for (const item of section.items) lines.push(`- \`${markdownCode(item)}\``);
    }
    if (section.note) lines.push('', markdownText(section.note));
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// ─── Small helpers ──────────────────────────────────────────────────────────────────────

/** A row that states one instant. An unreadable stored value is shown as it is, and is not called an instant. */
function instantRow(label: string, at: string): JobOutcomeSection['rows'][number] {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return { label, value: at };
  const utc = new Date(parsed).toISOString();
  return { label, value: utc, instant: utc };
}

function asRow(segment: JobOutcomeSegment): { value: string; tone: JobOutcomeTone } {
  return { value: segment.text, tone: segment.tone };
}

function count(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString('en-US');
}

function bounded(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (ms > 0 && seconds === 0) return 'under 1s';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  return `${rest}s`;
}

function markdownText(value: string): string {
  return value.replace(/[\\`*_{}\[\]<>|]/g, '\\$&').replace(/\r?\n/g, ' ');
}

function markdownCode(value: string): string {
  return value.replace(/`/g, '\'').replace(/\r?\n/g, ' ');
}

function unreachable(value: never): never {
  throw new Error(`Unhandled job outcome state: ${JSON.stringify(value)}`);
}
