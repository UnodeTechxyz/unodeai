import type { CoordinatorTaskStatus } from '../backend/TeamTools';
import type { RequestTerminalKind } from '../observability/RequestCloseout';

/**
 * v0.9.99: the PM status shown under every coordinator reply. One closed, first-match table maps typed host state,
 * read when the turn closes, to what the person sees: the state, what is going on now, why the turn ended, and the
 * next expected event. Nothing here is read from model prose, and only rows backed by a registered result wake or a
 * persisted review continuation promise anything automatic.
 */
export type PmStatusState =
  | 'Stopped'
  | 'Awaiting your decision'
  | 'Timed out'
  | 'Turn failed'
  | 'Running in background'
  | 'Awaiting PM review'
  | 'No task dispatched'
  | 'Complete'
  | 'Idle'
  | 'Status unavailable';

export interface PmTurnStatus {
  /** The table row that matched, 1–12; 8.5 is the rework-requested row beside row 8. */
  row: number;
  state: PmStatusState;
  now: string;
  why: string;
  next?: string;
}

export interface PmStatusRef { handle: string; revision: number; agent?: string }

export interface PmStatusFacts {
  turnEnd: RequestTerminalKind;
  /** Stop has stopped or suspended this coordinator. */
  held: boolean;
  /** The coordinator's task records that still need attention or are running. */
  tasks: readonly CoordinatorTaskStatus[];
  refused: ReadonlyArray<{ requestedAgent: string; reason: string }>;
  accepted: number;
  /** `close_assignment` with outcome `complete` was accepted in this turn. */
  closed: boolean;
}

interface Classified {
  running: PmStatusRef[];
  uncertain: PmStatusRef[];
  human: Array<PmStatusRef & { reason?: string }>;
  undisposed: Array<PmStatusRef & { continuation?: 'scheduled' | 'consumed' }>;
  awaitingRework: PmStatusRef[];
}

/** The task records the status reads: anything still running, uncertain, or owing a decision. */
export function pmStatusRelevant(task: CoordinatorTaskStatus): boolean {
  if (task.result) return !['decided', 'historical', 'cancelled', 'stopped'].includes(task.result.state);
  if (task.disposition) return false;
  return task.lifecycle === 'active' || task.lifecycle === 'timed-out' || task.lifecycle === 'unknown' || task.lifecycle === 'settled';
}

/** Sorts each task record into exactly one of the table's typed facts, or none (decided, cancelled, historical). */
export function classifyPmTasks(tasks: readonly CoordinatorTaskStatus[]): Classified {
  const out: Classified = { running: [], uncertain: [], human: [], undisposed: [], awaitingRework: [] };
  for (const task of tasks) {
    const result = task.result;
    const ref: PmStatusRef = {
      handle: task.handle,
      // 0: no standing result yet, so there is no revision to name.
      revision: result?.ref?.revision ?? 0,
      ...(task.requestedAgent ? { agent: task.requestedAgent } : {}),
    };
    if (!result) {
      // No standing result yet: the attempt is running, ended without one, or its state is not known.
      if (task.lifecycle === 'active' || task.lifecycle === 'timed-out' && task.recordedState === 'active') {
        if (task.execution?.state === 'unknown' || task.execution?.state === 'stop-unconfirmed') out.uncertain.push(ref);
        else out.running.push(ref);
      } else if (task.lifecycle === 'unknown') out.uncertain.push(ref);
      // A result settled before results had revisions, with no decision recorded: owed, never continued.
      else if (task.lifecycle === 'settled' && !task.disposition) out.undisposed.push(ref);
      continue;
    }
    // A result whose recovery is not settled is not known to be what the projection says.
    if (result.recovery) { out.uncertain.push(ref); continue; }
    switch (result.state) {
      case 'running': out.running.push(ref); break;
      case 'stop-unconfirmed':
      case 'unknown': out.uncertain.push(ref); break;
      case 'awaiting-human': out.human.push({ ...ref, ...(result.decision?.reason ? { reason: result.decision.reason } : {}) }); break;
      case 'awaiting-rework': out.awaitingRework.push(ref); break;
      case 'ready':
      case 'awaiting-decision':
      case 'failed':
        out.undisposed.push({ ...ref, ...(result.reviewContinuation ? { continuation: result.reviewContinuation } : {}) });
        break;
      default: break;
    }
  }
  return out;
}

const shortHandle = (handle: string): string => handle.slice(0, 8);
export const formatPmRef = (ref: PmStatusRef): string =>
  `${ref.agent ? `${ref.agent} ` : ''}(${shortHandle(ref.handle)})${ref.revision > 0 ? ` rev ${ref.revision}` : ''}`;
const list = (refs: readonly PmStatusRef[]): string => refs.map(formatPmRef).join(', ');
const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

const ANSWERED_ENDS: ReadonlySet<RequestTerminalKind> = new Set(['answered', 'tool-only', 'empty-reply', 'no-conclusion']);
const WAKE_PROMISE = 'When a result returns, the PM resumes automatically and reviews it.';
const NOTHING_SCHEDULED = 'Nothing is scheduled. The team continues when you send a message.';

export function pmTurnStatus(facts: PmStatusFacts): PmTurnStatus {
  const c = classifyPmTasks(facts.tasks);
  const scheduled = c.undisposed.filter((ref) => ref.continuation === 'scheduled');
  // Every row that reports known work while something is uncertain names the uncertain handles, and scopes any
  // automatic promise to what is actually registered.
  const uncertainNote = c.uncertain.length
    ? ` UnodeAi cannot confirm the state of ${list(c.uncertain)}.`
    : '';
  const failedEnd = facts.turnEnd === 'host-deadline' || facts.turnEnd === 'failed';
  const failedState: PmStatusState = facts.turnEnd === 'host-deadline' ? 'Timed out' : 'Turn failed';
  const failedWhy = facts.turnEnd === 'host-deadline' ? 'the turn timed out' : 'the turn failed';

  // 1. Stop.
  if (facts.held || facts.turnEnd === 'stopped') {
    const parts: string[] = [];
    if (c.running.length) parts.push(`${count(c.running.length, 'task')} still running`);
    if (c.undisposed.length) parts.push(`${count(c.undisposed.length, 'result')} not yet reviewed`);
    return {
      row: 1, state: 'Stopped',
      now: (parts.length ? `${parts.join(' · ')}.` : 'No delegated work is known to be running.') + uncertainNote,
      why: 'you pressed Stop',
      next: 'No automatic PM turn is scheduled. Your next message resumes the team.',
    };
  }
  // 2. A person must decide.
  if (c.human.length) {
    const first = c.human[0];
    return {
      row: 2, state: 'Awaiting your decision',
      now: `${formatPmRef(first)} needs your decision${first.reason ? `: "${first.reason}"` : ''}.`
        + (c.human.length > 1 ? ` ${c.human.length - 1} more also need one.` : '') + uncertainNote,
      why: 'a result needs a person',
      next: 'Answer it in Review Delivered Work: open the Command Palette and run "UnodeAi: Review Delivered Work".',
    };
  }
  // 3–5. The turn timed out or failed.
  if (failedEnd && c.running.length) {
    return {
      row: 3, state: failedState, now: `Still running: ${list(c.running)}.${uncertainNote}`, why: failedWhy,
      next: 'Their results will wake the PM automatically. No action is needed now.',
    };
  }
  if (failedEnd && scheduled.length) {
    return {
      row: 4, state: failedState, now: `Not yet reviewed: ${list(c.undisposed)}.${uncertainNote}`, why: failedWhy,
      next: `The PM gets one automatic turn to review ${list(scheduled)}.`,
    };
  }
  if (failedEnd && !c.uncertain.length) {
    return {
      row: 5, state: failedState,
      now: c.undisposed.length ? `Not yet reviewed: ${list(c.undisposed)}.` : 'Nothing is running.',
      why: failedWhy, next: NOTHING_SCHEDULED,
    };
  }
  // 6. Background work.
  if (c.running.length) {
    return {
      row: 6, state: 'Running in background', now: `Running: ${list(c.running)}.${uncertainNote}`,
      why: 'waiting for background results', next: WAKE_PROMISE,
    };
  }
  // 7–8. Results the PM still owes a decision.
  if (scheduled.length) {
    return {
      row: 7, state: 'Awaiting PM review', now: `Not yet reviewed: ${list(c.undisposed)}.${uncertainNote}`,
      why: 'the PM ended without recording a decision',
      next: `The PM gets one automatic turn to review ${list(scheduled)}.`,
    };
  }
  if (c.undisposed.length) {
    const allConsumed = c.undisposed.every((ref) => ref.continuation === 'consumed');
    return {
      row: 8, state: 'Awaiting PM review', now: `Not yet reviewed: ${list(c.undisposed)}.${uncertainNote}`,
      why: allConsumed ? 'no decision after the automatic review turn' : 'the PM has not recorded a decision',
      next: allConsumed
        ? 'No further automatic turn. The team continues when you send a message.'
        : 'No automatic turn is scheduled. The team continues when you send a message.',
    };
  }
  // Rework was requested (a recorded decision), but no rework is running: never a review continuation.
  if (c.awaitingRework.length) {
    return {
      row: 8.5, state: 'Awaiting PM review', now: `Rework requested, not running: ${list(c.awaitingRework)}.${uncertainNote}`,
      why: 'rework was requested but no rework is running',
      next: 'No automatic turn is scheduled. The team continues when you send a message.',
    };
  }
  // 9. Nothing was dispatched.
  if (facts.refused.length && facts.accepted === 0 && !c.uncertain.length) {
    const shown = facts.refused.slice(0, 3).map((row) => `${row.requestedAgent}: ${row.reason}`).join('; ');
    return {
      row: 9, state: 'No task dispatched',
      now: `Refused: ${shown}${facts.refused.length > 3 ? `; ${facts.refused.length - 3} more` : ''}.`,
      why: 'no dispatch was accepted',
      next: 'Nothing is running and nothing is scheduled. The team continues when you send a message.',
    };
  }
  // 10. Closed.
  if (facts.closed && !c.uncertain.length) {
    return { row: 10, state: 'Complete', now: 'Nothing is running.', why: 'the PM closed the assignment' };
  }
  // 11. Idle needs positive proof.
  if (!c.uncertain.length && ANSWERED_ENDS.has(facts.turnEnd)) {
    return { row: 11, state: 'Idle', now: 'Nothing is running.', why: 'the PM finished its reply', next: NOTHING_SCHEDULED };
  }
  // 12. Anything the table does not prove.
  return {
    row: 12, state: 'Status unavailable',
    now: c.uncertain.length ? `UnodeAi cannot confirm the state of ${list(c.uncertain)}.` : 'The turn ended in a state UnodeAi does not classify.',
    why: facts.turnEnd === 'host-deadline' ? 'the turn timed out' : facts.turnEnd === 'failed' ? 'the turn failed' : 'the turn ended',
    next: 'UnodeAi cannot confirm whether work is still running.',
  };
}

/** v0.9.99: row 12 when the task records themselves could not be read; nothing is invented about the tasks. */
export function pmStatusUnavailable(turnEnd: PmStatusFacts['turnEnd']): PmTurnStatus {
  return {
    row: 12, state: 'Status unavailable',
    now: 'UnodeAi could not read its task records for this turn.',
    why: turnEnd === 'host-deadline' ? 'the turn timed out' : turnEnd === 'failed' ? 'the turn failed' : 'the turn ended',
    next: 'UnodeAi cannot confirm whether work is still running.',
  };
}

/** One line per field, as the reply footer shows it. */
export function formatPmTurnStatus(status: PmTurnStatus): string {
  return [`PM status — ${status.state}`, status.now, `Why: ${status.why}.`, ...(status.next ? [`Next: ${status.next}`] : [])].join('\n');
}

/** Parses a status carried in message metadata; anything malformed is dropped rather than shown. */
export function parsePmTurnStatus(value: unknown): PmTurnStatus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (typeof raw.row !== 'number' || !text(raw.state, 40) || !text(raw.now, 2_000) || !text(raw.why, 200)
    || (raw.next !== undefined && !text(raw.next, 600))) return undefined;
  return { row: raw.row, state: raw.state as PmStatusState, now: raw.now as string, why: raw.why as string,
    ...(raw.next !== undefined ? { next: raw.next as string } : {}) };
}
