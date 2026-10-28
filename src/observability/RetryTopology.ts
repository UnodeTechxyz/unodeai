/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Retry topology of one run (v0.9.93)
 *  Which dispatches of a run are attempts of one logical task. The only evidence is the typed retry link
 *  the host wrote at dispatch. A link that breaks a rule is rejected and its attempt stands alone, with the
 *  reason kept as a coverage gap; nothing is grouped by time, wording, model or agent.
 *--------------------------------------------------------------------------------------------*/
import type { RetryLinkGap, RetryStage } from '../backend/TaskContract';

/** What the topology reads of a delegation. A run's stored delegations satisfy it as they are. */
export interface RetryTopologyAttempt {
  handle: string;
  dispatchedAt: string;
  retryOfHandle?: string;
  retryStage?: RetryStage;
  /** A link the host already rejected, at dispatch or on an earlier restore. It stays rejected. */
  retryLinkGap?: RetryLinkGap;
}

/**
 * The run-level rules, for links whose pair is already well formed: the parent is another attempt of this run,
 * following parents never comes back to the start, and the parent was dispatched strictly earlier. Returns the
 * handles whose link fails, with the first rule it fails. A cycle rejects every link on it.
 *
 * Two attempts with one dispatch time have no order the host recorded. A link between them is rejected, so the
 * links that stand always put a parent before its retry and the last attempt of a task is never chosen by a
 * handle's spelling.
 */
export function rejectedRetryLinks(attempts: readonly RetryTopologyAttempt[]): Map<string, RetryLinkGap> {
  const byHandle = new Map<string, RetryTopologyAttempt>();
  for (const attempt of attempts) if (!byHandle.has(attempt.handle)) byHandle.set(attempt.handle, attempt);
  const rejected = new Map<string, RetryLinkGap>();
  for (const attempt of byHandle.values()) {
    if (attempt.retryOfHandle === undefined || attempt.retryStage === undefined) continue;
    if (attempt.retryOfHandle === attempt.handle) rejected.set(attempt.handle, 'self-link');
    else if (!byHandle.has(attempt.retryOfHandle)) rejected.set(attempt.handle, 'missing-parent');
  }
  // Cycles, before dispatch times are looked at: the time rule alone would reject one link of a cycle and let
  // the others stand as a chain. The walk follows links that are still standing and is bounded by their number.
  for (const attempt of byHandle.values()) {
    const path: string[] = [];
    let cursor: RetryTopologyAttempt | undefined = attempt;
    while (cursor && cursor.retryOfHandle !== undefined && cursor.retryStage !== undefined && !rejected.has(cursor.handle)) {
      const loopStart = path.indexOf(cursor.handle);
      if (loopStart >= 0) {
        for (const handle of path.slice(loopStart)) rejected.set(handle, 'cycle');
        break;
      }
      path.push(cursor.handle);
      cursor = byHandle.get(cursor.retryOfHandle);
    }
  }
  for (const attempt of byHandle.values()) {
    if (attempt.retryOfHandle === undefined || attempt.retryStage === undefined || rejected.has(attempt.handle)) continue;
    const parentAt = Date.parse(byHandle.get(attempt.retryOfHandle)!.dispatchedAt);
    const ownAt = Date.parse(attempt.dispatchedAt);
    if (!Number.isFinite(parentAt) || !Number.isFinite(ownAt) || parentAt >= ownAt) {
      rejected.set(attempt.handle, 'not-earlier');
    }
  }
  return rejected;
}

export interface RetryTask {
  /** The first attempt: the one that retries nothing. */
  rootHandle: string;
  /** Every attempt of the task in dispatch order, the root first. */
  attempts: string[];
  /** The stage of each retry, in the same order as `attempts` without the root. */
  stages: RetryStage[];
}

export interface RetryTopology {
  /** One entry per logical task, in the order their roots were dispatched. */
  tasks: RetryTask[];
  attempts: number;
  /** Tasks that have at least one retry. */
  retryChains: number;
  /** Attempts whose link was rejected. Each is a task of its own above. */
  gaps: Array<{ handle: string; gap: RetryLinkGap }>;
}

/**
 * Group a run's attempts into logical tasks through their valid links. An attempt without a link, or whose link
 * was rejected, is the root of its own task: a legacy run therefore has one task per attempt and no chain.
 */
export function projectRetryTopology(attempts: readonly RetryTopologyAttempt[]): RetryTopology {
  const rejected = rejectedRetryLinks(attempts);
  const gaps: RetryTopology['gaps'] = [];
  const parentOf = new Map<string, { parent: string; stage: RetryStage }>();
  const unique: RetryTopologyAttempt[] = [];
  const seen = new Set<string>();
  for (const attempt of attempts) {
    if (seen.has(attempt.handle)) continue;
    seen.add(attempt.handle);
    unique.push(attempt);
    const gap = attempt.retryLinkGap ?? rejected.get(attempt.handle);
    if (gap) {
      gaps.push({ handle: attempt.handle, gap });
      continue;
    }
    if (attempt.retryOfHandle !== undefined && attempt.retryStage !== undefined) {
      parentOf.set(attempt.handle, { parent: attempt.retryOfHandle, stage: attempt.retryStage });
    }
  }
  const rootOf = (handle: string): string => {
    let cursor = handle;
    // Valid links are acyclic, so this ends; the bound guards a caller that passed unvalidated input.
    for (let steps = 0; steps <= unique.length; steps++) {
      const link = parentOf.get(cursor);
      if (!link) return cursor;
      cursor = link.parent;
    }
    return handle;
  };
  const ordered = unique.slice().sort((left, right) => {
    const difference = Date.parse(left.dispatchedAt) - Date.parse(right.dispatchedAt);
    if (Number.isFinite(difference) && difference !== 0) return difference;
    return left.handle < right.handle ? -1 : left.handle > right.handle ? 1 : 0;
  });
  const tasks = new Map<string, RetryTask>();
  for (const attempt of ordered) {
    const root = rootOf(attempt.handle);
    let task = tasks.get(root);
    if (!task) {
      task = { rootHandle: root, attempts: [], stages: [] };
      tasks.set(root, task);
    }
    if (attempt.handle === root) {
      task.attempts.unshift(attempt.handle);
    } else {
      task.attempts.push(attempt.handle);
      task.stages.push(parentOf.get(attempt.handle)!.stage);
    }
  }
  const list = [...tasks.values()];
  return {
    tasks: list,
    attempts: unique.length,
    retryChains: list.filter((task) => task.attempts.length > 1).length,
    gaps,
  };
}
