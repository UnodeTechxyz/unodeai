/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Standing work of a coordinator (v0.9.95)
 *  Which delegated attempts are the work as it now stands, and which are history. Every surface that counts
 *  delegations or says how they ended reads this one projection: the coordinator's closeout state, the host's
 *  closing notice, the delegation card before and after a reload, the Team row and the assignment close.
 *
 *  An attempt is history when the coordinator recorded it as superseded, or when a typed retry link the host
 *  wrote at dispatch shows a later attempt of the same task. History is kept and shown; it is never counted as
 *  current work. An abandoned attempt has no replacement, so it stands, as blocked.
 *
 *  Nothing here reads a reply. The inputs are lifecycle, typed completion state, recorded dispositions, typed
 *  retry links and the host's own results for file changes it was asked to make.
 *--------------------------------------------------------------------------------------------*/
import type { RetryLinkGap, RetryStage } from '../backend/TaskContract';
import { projectRetryTopology } from './RetryTopology';

export type StandingWorkLifecycle = 'working' | 'settled' | 'failed' | 'cancelled' | 'interrupted' | 'policy-refused';
export type StandingWorkState = 'working' | 'complete' | 'partial' | 'blocked' | 'cancelled';
export type DeclaredCheckState = 'passed' | 'failed' | 'not-run' | 'not-applicable';
export type HistoricalReason = 'superseded' | 'retried';
export type TerminalDisposition = 'superseded' | 'abandoned';

/** What the projection reads of one attempt. Each consumer maps its own record to this and adds nothing. */
export interface StandingWorkAttempt {
  handle: string;
  /** Needed only to order the attempts of a retry chain; an attempt without a link may leave it empty. */
  dispatchedAt?: string;
  retryOfHandle?: string;
  retryStage?: RetryStage;
  retryLinkGap?: RetryLinkGap;
  lifecycle: StandingWorkLifecycle;
  /** The typed terminal shape of a settled attempt. Absent on a record written before it was kept. */
  completionState?: 'complete' | 'partial' | 'not-observed';
  /** Coordinator decisions in the order they were recorded. */
  dispositions: ReadonlyArray<{ disposition: string }>;
  /**
   * File changes the host refused for this attempt and that no later call of the attempt carried out, with
   * whether any file change of the attempt did succeed. Absent when the host recorded neither.
   */
  effects?: { refusedOutstanding: number; succeeded: boolean };
  /** The host's evaluation of the checks the task declared. Absent when it declared none. */
  declaredCheck?: DeclaredCheckState;
}

export interface ProjectedAttempt {
  handle: string;
  state: StandingWorkState;
  /** Why the attempt is history. Absent for an attempt that stands. */
  historical?: HistoricalReason;
  /** The first superseded or abandoned decision. It is final: a later entry does not undo it. */
  terminalDisposition?: TerminalDisposition;
  /** The decision in force for a standing attempt; absent when none was recorded. */
  latestDisposition?: string;
}

export interface StandingWorkProjection {
  /** Every attempt once, in the order given. */
  attempts: ProjectedAttempt[];
  byHandle: ReadonlyMap<string, ProjectedAttempt>;
  standing: ProjectedAttempt[];
  historical: ProjectedAttempt[];
  /** Standing attempts only. */
  counts: Record<StandingWorkState, number>;
  /** Declared task checks of standing attempts only. */
  declaredChecks: Record<DeclaredCheckState, number>;
}

/** The first superseded or abandoned decision of an attempt. */
export function terminalDispositionOf(dispositions: ReadonlyArray<{ disposition: string }>): TerminalDisposition | undefined {
  const entry = dispositions.find((candidate) => candidate.disposition === 'superseded' || candidate.disposition === 'abandoned');
  return entry?.disposition as TerminalDisposition | undefined;
}

/**
 * How one attempt ended, from typed facts alone. A transport-complete attempt stays complete unless the host
 * refused a file change it asked for and that change was never made: with no file change made at all the attempt
 * is blocked, with some made it is partial. Write authority that was never used proves nothing either way.
 */
export function standingStateOf(attempt: StandingWorkAttempt): StandingWorkState {
  switch (attempt.lifecycle) {
    case 'working': return 'working';
    case 'cancelled': return 'cancelled';
    case 'interrupted':
    case 'failed':
    case 'policy-refused':
      return 'blocked';
    case 'settled':
      break;
    default:
      return unreachable(attempt.lifecycle);
  }
  if (attempt.completionState === 'partial') return 'partial';
  if (attempt.completionState === 'not-observed') return 'blocked';
  const refused = attempt.effects?.refusedOutstanding ?? 0;
  if (refused > 0) return attempt.effects!.succeeded ? 'partial' : 'blocked';
  return 'complete';
}

export function projectStandingWork(attempts: readonly StandingWorkAttempt[]): StandingWorkProjection {
  const unique: StandingWorkAttempt[] = [];
  const seen = new Set<string>();
  for (const attempt of attempts) {
    if (seen.has(attempt.handle)) continue;
    seen.add(attempt.handle);
    unique.push(attempt);
  }
  // Only a link the retry topology accepts makes an earlier attempt history. A rejected link leaves both
  // attempts standing as tasks of their own, which is what the Job outcome counts as well.
  const retried = new Set<string>();
  const topology = projectRetryTopology(unique.map((attempt) => ({
    handle: attempt.handle,
    dispatchedAt: attempt.dispatchedAt ?? '',
    ...(attempt.retryOfHandle !== undefined ? { retryOfHandle: attempt.retryOfHandle } : {}),
    ...(attempt.retryStage !== undefined ? { retryStage: attempt.retryStage } : {}),
    ...(attempt.retryLinkGap !== undefined ? { retryLinkGap: attempt.retryLinkGap } : {}),
  })));
  for (const task of topology.tasks) {
    for (const handle of task.attempts.slice(0, -1)) retried.add(handle);
  }

  const projected: ProjectedAttempt[] = [];
  const byHandle = new Map<string, ProjectedAttempt>();
  const counts: Record<StandingWorkState, number> = { working: 0, complete: 0, partial: 0, blocked: 0, cancelled: 0 };
  const declaredChecks: Record<DeclaredCheckState, number> = { passed: 0, failed: 0, 'not-run': 0, 'not-applicable': 0 };
  for (const attempt of unique) {
    const terminal = terminalDispositionOf(attempt.dispositions);
    const historical: HistoricalReason | undefined = terminal === 'superseded' ? 'superseded'
      : retried.has(attempt.handle) ? 'retried'
        : undefined;
    const latest = attempt.dispositions[attempt.dispositions.length - 1]?.disposition;
    const entry: ProjectedAttempt = {
      handle: attempt.handle,
      state: standingStateOf(attempt),
      ...(historical ? { historical } : {}),
      ...(terminal ? { terminalDisposition: terminal } : {}),
      ...(!historical && (terminal ?? latest) ? { latestDisposition: terminal ?? latest } : {}),
    };
    projected.push(entry);
    byHandle.set(entry.handle, entry);
    if (historical) continue;
    counts[entry.state] += 1;
    if (attempt.declaredCheck) declaredChecks[attempt.declaredCheck] += 1;
  }
  return {
    attempts: projected,
    byHandle,
    standing: projected.filter((entry) => !entry.historical),
    historical: projected.filter((entry) => !!entry.historical),
    counts,
    declaredChecks,
  };
}

function unreachable(value: never): never {
  throw new Error(`unknown attempt lifecycle: ${String(value)}`);
}
