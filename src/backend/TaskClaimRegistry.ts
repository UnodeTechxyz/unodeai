/*---------------------------------------------------------------------------------------------
 *  UnodeAi - TaskClaimRegistry  (Option B step 2)
 *  Proactive file-conflict prevention for PARALLEL delegation.
 *
 *  When the PM fans tasks out concurrently (assign_task_async), each task can declare the files it
 *  will own. This registry records those claims and rejects a new dispatch whose files OVERLAP an
 *  in-flight claim — so two teammates never edit the same files at once. It complements (does not
 *  replace) the optimistic FileCoordinator (write-time compare-and-swap) and run_checks: claims stop
 *  the collision before it starts; CAS + run_checks catch anything that slips through (e.g. a coarse
 *  claim, or a Claude-backed teammate). Claims are intent ("will touch"), released when the task ends.
 *
 *  Pure (no vscode), shared across all agents in a workspace like FileCoordinator.
 *--------------------------------------------------------------------------------------------*/

export interface ClaimResult {
  ok: boolean;
  /** When ok===false: human/agent-readable overlaps naming the in-flight task and its holder. */
  conflicts?: string[];
}

interface ActiveClaim {
  agentId: string;
  paths: string[];
  instruction?: string;
}

/** Normalize a path/glob for comparison: forward slashes, no ./ prefix, no trailing slash, lowercase. */
function normalize(p: string): string {
  return (p ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** Strip a trailing glob (`/**`, `/*`, `*`) to the base path node the spec covers. */
function baseOf(spec: string): string {
  let s = normalize(spec);
  if (s.endsWith('/**')) { s = s.slice(0, -3); }
  else if (s.endsWith('/*')) { s = s.slice(0, -2); }
  else if (s.endsWith('*')) { s = s.replace(/\*+$/, ''); }
  return s.replace(/\/+$/, '');
}

/**
 * Two specs overlap when their base nodes are equal, one contains the other at a path boundary, or
 * either side is a whole-tree claim (empty base). Distinct files (src/a.ts vs src/b.ts) do NOT overlap.
 */
export function pathsOverlap(a: string, b: string): boolean {
  const na = baseOf(a);
  const nb = baseOf(b);
  if (na === '' || nb === '') { return true; } // a "**" / repo-wide claim conflicts with everything
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

export class TaskClaimRegistry {
  private claims = new Map<string, ActiveClaim>();

  /**
   * Try to claim `paths` for `taskId`. Returns ok when no path overlaps another in-flight task's
   * claim; otherwise returns the conflicting paths (and who holds them) without recording anything.
   * An empty `paths` list always succeeds (the caller opted out of declaring ownership).
   */
  claim(taskId: string, agentId: string, paths: string[], instruction?: string): ClaimResult {
    const wanted = (paths ?? []).map((p) => p.trim()).filter(Boolean);
    const checked = this.check(taskId, wanted);
    if (!checked.ok) return checked;
    if (wanted.length === 0) return { ok: true };
    this.claims.set(taskId, { agentId, paths: wanted, instruction: instruction?.trim().slice(0, 160) || undefined });
    return { ok: true };
  }

  /** Pure inspection used while building a candidate set. It never reserves the paths. */
  check(taskId: string, paths: string[]): ClaimResult {
    const wanted = (paths ?? []).map((p) => p.trim()).filter(Boolean);
    if (wanted.length === 0) return { ok: true };
    const conflicts: string[] = [];
    for (const [otherTask, held] of this.claims) {
      if (otherTask === taskId) continue;
      for (const mine of wanted) {
        for (const theirs of held.paths) {
          if (!pathsOverlap(mine, theirs)) continue;
          const task = held.instruction ? `: ${held.instruction}` : '';
          conflicts.push(`${mine} (overlaps in-flight task ${otherTask} held by ${held.agentId}${task})`);
        }
      }
    }
    return conflicts.length ? { ok: false, conflicts: [...new Set(conflicts)] } : { ok: true };
  }

  /** Release a task's claim (call when the task settles). No-op if it held none. */
  release(taskId: string): void {
    this.claims.delete(taskId);
  }

  /** Snapshot of active claims (for inspection / tests). */
  activeClaims(): ReadonlyArray<{ taskId: string; agentId: string; paths: string[] }> {
    return [...this.claims.entries()].map(([taskId, c]) => ({ taskId, agentId: c.agentId, paths: c.paths }));
  }
}
