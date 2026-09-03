/*---------------------------------------------------------------------------------------------
 *  UnodeAi - FileCoordinator
 *  Prevents agents from silently clobbering each other's edits to shared workspace files.
 *
 *  Strategy abstraction so the team can pick how concurrency is handled:
 *    - 'optimistic' (default, this file): no locks. Each agent's read of a file is remembered;
 *      a write is allowed only if the file on disk still matches what that agent last read
 *      (compare-and-swap). Disjoint work runs fully parallel; a real conflict is rejected with a
 *      "re-read and retry" message instead of a lost update. No locks, no deadlocks, no
 *      task-duration blocking.
 *    - 'worktree' (planned, for large projects): give each agent its own git worktree and merge
 *      results — the Conductor / Claude Squad model. Scaffolded here as an extension point; not
 *      yet implemented (see makeFileCoordinator in extension.ts).
 *
 *  The coordinator is shared across all agents in a workspace, so one agent's write is visible
 *  to every other agent's next write-check.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';

export type ConcurrencyStrategy = 'optimistic' | 'worktree';

export interface WriteDecision {
  ok: boolean;
  /** Human/agent-readable reason when ok === false (surfaced to the model so it can re-read). */
  reason?: string;
}

export interface FileCoordinator {
  /** Remember the content hash an agent saw when it read a file. */
  recordRead(agentId: string, absPath: string, content: string): void;
  /**
   * Decide whether `agentId` may overwrite `absPath`. `diskContent` is the file's current
   * on-disk content, or null if it does not exist.
   */
  checkWrite(agentId: string, absPath: string, diskContent: string | null): WriteDecision;
  /** Record a successful write so the writer can write again and others detect the change. */
  recordWrite(agentId: string, absPath: string, content: string): void;
  /**
   * Layer 1 — read-set invalidation. Returns (and clears) the files this agent had read which a
   * teammate has since changed. Surfaced to the agent so it re-reads a dependency before relying
   * on it, catching cross-file breakage (X depends on Y; a teammate edited Y).
   */
  takeStaleNotices(agentId: string): string[];
}

function hash(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

/**
 * Optimistic (compare-and-swap) concurrency. Uses on-disk content as the source of truth, so it
 * also catches edits made outside the tool surface (e.g. a Claude-backed agent or the human).
 */
export class OptimisticFileCoordinator implements FileCoordinator {
  // agentId -> (absPath -> hash the agent last observed)
  private reads = new Map<string, Map<string, string>>();
  // agentId -> set of files it read that a teammate has since changed (pending notices)
  private stale = new Map<string, Set<string>>();

  recordRead(agentId: string, absPath: string, content: string): void {
    this.forAgent(agentId).set(absPath, hash(content));
    // Re-reading clears any pending staleness for this file — the agent now has the fresh version.
    this.stale.get(agentId)?.delete(absPath);
  }

  checkWrite(agentId: string, absPath: string, diskContent: string | null): WriteDecision {
    // Creating a brand-new file (nothing on disk) is always safe.
    if (diskContent === null) {
      return { ok: true };
    }

    const lastRead = this.forAgent(agentId).get(absPath);
    const diskHash = hash(diskContent);

    if (lastRead === undefined) {
      return {
        ok: false,
        reason: `You have not read "${rel(absPath)}" yet. Read it first so you don't overwrite a teammate's work, then write.`,
      };
    }
    if (lastRead !== diskHash) {
      return {
        ok: false,
        reason: `"${rel(absPath)}" changed since you last read it (a teammate edited it). Re-read it, reconcile your changes, then write again.`,
      };
    }
    return { ok: true };
  }

  recordWrite(agentId: string, absPath: string, content: string): void {
    // The writer now "owns" the latest version; others still hold their stale read hashes and
    // will be rejected (by disk comparison) until they re-read.
    this.forAgent(agentId).set(absPath, hash(content));

    // Read-set invalidation: flag every OTHER agent that had read this file as stale on it.
    for (const [otherId, readMap] of this.reads) {
      if (otherId !== agentId && readMap.has(absPath)) {
        this.staleFor(otherId).add(absPath);
      }
    }
  }

  takeStaleNotices(agentId: string): string[] {
    const set = this.stale.get(agentId);
    if (!set || set.size === 0) {
      return [];
    }
    const notices = [...set];
    set.clear();
    return notices;
  }

  private forAgent(agentId: string): Map<string, string> {
    let m = this.reads.get(agentId);
    if (!m) {
      m = new Map();
      this.reads.set(agentId, m);
    }
    return m;
  }

  private staleFor(agentId: string): Set<string> {
    let s = this.stale.get(agentId);
    if (!s) {
      s = new Set();
      this.stale.set(agentId, s);
    }
    return s;
  }
}

/**
 * No-op coordinator: every write is allowed. Used for single-agent contexts and tests where
 * cross-agent conflict can't happen.
 */
export class NoopFileCoordinator implements FileCoordinator {
  recordRead(): void {
    /* nothing */
  }
  checkWrite(): WriteDecision {
    return { ok: true };
  }
  recordWrite(): void {
    /* nothing */
  }
  takeStaleNotices(): string[] {
    return [];
  }
}

function rel(absPath: string): string {
  // Show just the basename-ish tail to keep messages readable without leaking full paths.
  const parts = absPath.split(/[\\/]/);
  return parts.slice(-2).join('/');
}
