import type { CoordinatorTaskStatus } from '../backend/TeamTools';

/**
 * v0.9.99: how a PM's task records are read for what its team is doing. v0.9.102 (the Owner's decision): replies carry
 * no PM status any more; the PM live strip (PmLiveStrip.ts) reads the same classification, live. Nothing here is read
 * from model prose.
 */
export interface PmStatusRef { handle: string; revision: number; agent?: string }

/** The task records still running, uncertain, or owing a decision. */
export function pmStatusRelevant(task: CoordinatorTaskStatus): boolean {
  if (task.result) return !['decided', 'historical', 'cancelled', 'stopped'].includes(task.result.state);
  if (task.disposition) return false;
  return task.lifecycle === 'active' || task.lifecycle === 'timed-out' || task.lifecycle === 'unknown' || task.lifecycle === 'settled';
}

/**
 * What one task record says about its work: running, of unknown state, owing the person's decision, owing rework that is
 * not running, finished without a decision, finished and decided, or a result Stop suspended (it is offered again when
 * the person resumes the PM). Undefined: nothing to say (cancelled, historical, or a result settled before results had
 * revisions and decided).
 */
export type PmTaskKind = 'running' | 'uncertain' | 'human' | 'rework' | 'undisposed' | 'decided' | 'suspended';

export function pmTaskKind(task: CoordinatorTaskStatus): PmTaskKind | undefined {
  const result = task.result;
  if (!result) {
    // No standing result yet: the attempt is running, ended without one, or its state is not known.
    if (task.lifecycle === 'active' || task.lifecycle === 'timed-out' && task.recordedState === 'active') {
      return task.execution?.state === 'unknown' || task.execution?.state === 'stop-unconfirmed' ? 'uncertain' : 'running';
    }
    if (task.lifecycle === 'unknown') return 'uncertain';
    // A result settled before results had revisions, with no decision recorded: owed, never continued.
    return task.lifecycle === 'settled' && !task.disposition ? 'undisposed' : undefined;
  }
  // A result whose recovery is not settled is not known to be what the projection says.
  if (result.recovery) return 'uncertain';
  // v0.9.102: Stop suspended it in the result mailbox; the person's next message offers it to the PM again. Its run may
  // have closed with the stopped turn, which projects it as historical: the suspension is what still holds.
  if (result.scope?.state === 'suspended') return 'suspended';
  switch (result.state) {
    case 'running': return 'running';
    case 'stop-unconfirmed':
    case 'unknown': return 'uncertain';
    case 'awaiting-human': return 'human';
    case 'awaiting-rework': return 'rework';
    case 'ready':
    case 'awaiting-decision':
    case 'failed': return 'undisposed';
    case 'decided': return 'decided';
    default: return undefined;
  }
}

interface Classified {
  running: PmStatusRef[];
  uncertain: PmStatusRef[];
  human: Array<PmStatusRef & { reason?: string }>;
  undisposed: Array<PmStatusRef & { continuation?: 'scheduled' | 'consumed' }>;
  awaitingRework: PmStatusRef[];
}

/** Sorts each task record into exactly one of the typed facts, or none (decided, cancelled, historical). */
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
    switch (pmTaskKind(task)) {
      case 'running': out.running.push(ref); break;
      case 'uncertain': out.uncertain.push(ref); break;
      case 'human': out.human.push({ ...ref, ...(result?.decision?.reason ? { reason: result.decision.reason } : {}) }); break;
      case 'rework': out.awaitingRework.push(ref); break;
      case 'undisposed':
        out.undisposed.push({ ...ref, ...(result?.reviewContinuation ? { continuation: result.reviewContinuation } : {}) });
        break;
      default: break;
    }
  }
  return out;
}

const shortHandle = (handle: string): string => handle.slice(0, 8);
export const formatPmRef = (ref: PmStatusRef): string =>
  `${ref.agent ? `${ref.agent} ` : ''}(${shortHandle(ref.handle)})${ref.revision > 0 ? ` rev ${ref.revision}` : ''}`;
