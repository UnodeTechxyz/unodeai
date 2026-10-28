/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Gated workflow types + decision logic (P2 / Team Workflow design §3, §8)
 *  A "gate" sits after a step: an OBJECTIVE machine check (run_checks: build/type-check/test) and,
 *  on pass/fail, a deterministic tier switch (cheaper model when things go well, stronger model on
 *  the retry). This is the "machine vs judgment" split from the design: the runtime owns the gate
 *  (reliable), the PM owns subjective quality (probabilistic, separate).
 *
 *  The decision logic here is pure so it's unit-testable; WorkflowEngine wires the async run_checks
 *  + TierController + step re-issue around it.
 *--------------------------------------------------------------------------------------------*/

import { ModelTier } from '../roles/RoleConfig';

/** A gate evaluated after `after` (a step id). */
export interface WorkflowGate {
  after: string;
  /** Run the objective check (run_checks) at this gate. */
  objective?: boolean;
  /** Tier changes to apply when the gate PASSES (e.g. drop back to economy to save cost). */
  onPass?: Record<string, ModelTier>;
  onFail?: {
    /** Tier changes on failure (e.g. escalate the implementer to premium for the retry). */
    setTier?: Record<string, ModelTier>;
    /** Max retries of the failed step before escalating out. Default 1. */
    maxRetries?: number;
    /** Reassign the retry to a different role instead of the original step's target. */
    route?: string;
    /** What to do once retries are exhausted. Default 'human' (pause for a person). */
    onExhaust?: 'human' | 'fail';
  };
}

export interface GateDecision {
  /** Gate passed → proceed to the next step. */
  proceed: boolean;
  /** Tier directive to apply now (onPass on success, setTier on a retry). */
  applyTiers?: Record<string, ModelTier>;
  /** Re-run the failed step (gate failed but retries remain). */
  retry: boolean;
  /** If retrying, optionally reassign to this role. */
  route?: string;
  /** Terminal outcome when retries are exhausted. */
  escalate: 'none' | 'human' | 'fail';
}

/** Reserved label for a migrated pre-0.9.70 unconditional branch. Never offered to the agent, so it
 *  cannot be selected; it exists only so the old "always matches" branch keeps a stable identity. */
export const LEGACY_FALLBACK_BRANCH_LABEL = '__unode_legacy_fallback';

/**
 * One migration, shared by the team-file schema and the engine so the two cannot disagree about what an
 * old branch means. A branch with no `label` and no usable `whenResultContains` is the pre-0.9.70
 * unconditional branch: it always matched, so it becomes a fallback rather than a label nobody selects.
 */
export function migrateWorkflowBranchLabel(
  raw: { label?: unknown; whenResultContains?: unknown; fallback?: unknown },
): { label: string; fallback?: true } {
  if (typeof raw.label === 'string' && raw.label.length > 0) {
    return raw.fallback === true ? { label: raw.label, fallback: true } : { label: raw.label };
  }
  // An empty legacy substring matched every result, so it was unconditional too.
  if (typeof raw.whenResultContains === 'string' && raw.whenResultContains.length > 0) {
    return { label: raw.whenResultContains };
  }
  return { label: LEGACY_FALLBACK_BRANCH_LABEL, fallback: true };
}

/**
 * P2 conditional routing: compare one agent-selected structured label against the step's declared
 * vocabulary. Model-authored prose is never inspected here. An exact selection always wins; a migrated
 * unconditional branch is the fallback when nothing matched, and no label at all means linear fallthrough
 * unless such a fallback exists.
 */
export function resolveBranch(
  branches: import('../types').WorkflowBranch[] | undefined,
  selectedLabel: string | undefined
): string | undefined {
  if (!branches || branches.length === 0) {
    return undefined;
  }
  if (selectedLabel !== undefined) {
    for (const b of branches) {
      if (!b.fallback && b.label === selectedLabel) {
        return b.goto;
      }
    }
  }
  for (const b of branches) {
    if (b.fallback) {
      return b.goto;
    }
  }
  return undefined;
}

/**
 * Decide what to do at a gate given whether the objective check passed and how many attempts of the
 * gated step have already been made (1 = first run just completed).
 */
export function decideGate(gate: WorkflowGate, passed: boolean, attempt: number): GateDecision {
  if (passed) {
    return { proceed: true, applyTiers: gate.onPass, retry: false, escalate: 'none' };
  }
  const f = gate.onFail ?? {};
  const maxRetries = f.maxRetries ?? 1;
  if (attempt <= maxRetries) {
    return { proceed: false, applyTiers: f.setTier, retry: true, route: f.route, escalate: 'none' };
  }
  return { proceed: false, retry: false, escalate: f.onExhaust ?? 'human' };
}
