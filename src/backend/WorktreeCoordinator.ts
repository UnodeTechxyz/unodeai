/*---------------------------------------------------------------------------------------------
 *  UnodeAi - WorktreeCoordinator (v0.6.x worktree fan-out, Slice B+C integration layer)
 *  Ties the primitives together for the live session: gives eligible agents their own git worktree
 *  (isolation), and on each turn completion commits + merges that worktree into the shared
 *  `unode/integration` branch (coordination), conflict-aware, with an opt-in auto-finalize to base.
 *
 *  Pure orchestration over injected WorktreeManager + MergeOrchestrator (+ config/log/notify thunks),
 *  so it's unit-testable with fakes — no vscode coupling. The extension wires it to SessionManager's
 *  resolveWorkingDirectory + onTurnComplete hooks.
 *--------------------------------------------------------------------------------------------*/

import { AgentConfig } from '../types';
import { WorktreeManager, Worktree } from './WorktreeManager';
import { MergeOrchestrator, MergeResult } from './MergeOrchestrator';
import { VerifyResult } from './Verifier';

export interface WorktreeCoordinatorDeps {
  manager: WorktreeManager;
  orchestrator: MergeOrchestrator;
  /** unode.concurrencyStrategy === 'worktree'. */
  isEnabled: () => boolean;
  /** unode.worktree.autoMerge — finalize integration → base automatically after a clean merge. */
  autoMerge: () => boolean;
  /** unode.worktree.maxParallel — cap on simultaneous per-agent worktrees. */
  maxParallel: () => number;
  /** Eligible for isolation? Extension passes `!canDelegate(c) && role !== 'solo'` — the delegating
   *  PM and solo agents stay on the live shared tree. */
  isEligible: (config: AgentConfig) => boolean;
  /** Human-readable status line (output channel). */
  log: (message: string) => void;
  /** Called ONCE when worktree mode is on but the workspace isn't a git repo, so the host can warn the
   *  user (it silently falls back to the shared workspace otherwise). Optional. */
  onNonGitRepo?: () => void;
  /** Send feedback to an agent (e.g. a conflict-resolution ask) via the message bus. Optional. */
  notifyAgent?: (agentId: string, message: string) => void;
  /** v0.7.0 verifier-as-gate: run the project's verify command in the agent's worktree BEFORE merging.
   *  Returns passed/failed/skipped. Absent = no gate (pre-0.7.0 behavior). The extension's impl honors
   *  unode.worktree.verifyBeforeMerge + unode.verifyCommand and returns 'skipped' when gating is off, so
   *  the coordinator stays policy-free. On 'failed' the work is held on its own branch (not merged) and
   *  the failure is handed back to the agent; 'skipped'/'passed' fall through to the merge. */
  verify?: (cwd: string) => Promise<VerifyResult>;
  /** v0.7.0 anti-cheat: list the files this lane changed (vs base), so a PASSING lane that also edited
   *  the tests can be flagged for review (a weak agent can make the gate green by weakening the tests
   *  instead of fixing the code). Absent = no flagging. Best-effort; failures degrade to "no flag". */
  changedFiles?: (worktree: Worktree) => Promise<string[]>;
}

/** A lane's verification result, plus (v0.7.0 anti-cheat) any test files the passing change also
 *  modified — surfaced in the review board so "tests pass" can't silently mean "tests were weakened". */
export type LaneVerifyState = VerifyResult & { touchedTests?: string[] };

export class WorktreeCoordinator {
  private readonly worktrees = new Map<string, Worktree>();
  /** Guard so the "not a git repo" warning fires at most once per session, not per agent. */
  private warnedNonGit = false;
  // v0.7.0: last verification result per agent, for the review board (✓ verified / ✗ failing / ⚠ unverified),
  // plus any test files a passing change also touched (anti-cheat flag).
  private readonly verifyStatus = new Map<string, LaneVerifyState>();
  // Serializes commit/merge/finalize so concurrent turn-completions can't race the single
  // integration worktree.
  private mergeChain: Promise<unknown> = Promise.resolve();

  /** Callback fired after verify state changes (mergeAgent, reverify). Extension subscribes to
   *  refresh the worktree review panel. Never throws — errors are silently caught. */
  onChange?: () => void;

  constructor(private readonly deps: WorktreeCoordinatorDeps) {}

  private emit(): void {
    try { this.onChange?.(); } catch { /* never let a subscriber crash the coordinator */ }
  }

  /**
   * `SessionManager.resolveWorkingDirectory` impl. Returns the agent's worktree path, or undefined to
   * fall back to the shared workspace root. Best-effort — any failure falls back (logged), never throws.
   */
  async assignWorkingDirectory(config: AgentConfig): Promise<string | undefined> {
    if (!this.deps.isEnabled() || !this.deps.isEligible(config)) {
      return undefined;
    }
    // Reuse within the session (e.g. on restart).
    const known = this.worktrees.get(config.id);
    if (known) {
      return known.path;
    }
    try {
      if (!(await this.deps.manager.isGitRepo())) {
        this.deps.log('Worktree mode: not a git repository — using the shared workspace.');
        if (!this.warnedNonGit) {
          this.warnedNonGit = true;
          this.deps.onNonGitRepo?.(); // one-time, user-facing warning (not just the Output channel)
        }
        return undefined;
      }
      const branch = `unode/${worktreeName(config)}`;
      // Adopt an existing worktree on this branch (survives an extension reload mid-run).
      const existing = (await this.deps.manager.list()).find((w) => w.branch === branch);
      if (existing) {
        this.worktrees.set(config.id, { ...existing, agentId: config.id });
        return existing.path;
      }
      if (this.worktrees.size >= Math.max(1, this.deps.maxParallel())) {
        this.deps.log(`Worktree cap (${this.deps.maxParallel()}) reached — "${config.name}" uses the shared workspace.`);
        return undefined;
      }
      if (!(await this.deps.manager.isClean())) {
        this.deps.log('Worktree mode: uncommitted or untracked files in the workspace — using the shared workspace so agents can see them (commit them to enable per-agent worktree isolation).');
        return undefined;
      }
      const wt = await this.deps.manager.create({ name: worktreeName(config), branch, agentId: config.id });
      this.worktrees.set(config.id, wt);
      this.deps.log(`Isolated "${config.name}" in ${wt.path} (branch ${wt.branch}).`);
      return wt.path;
    } catch (err) {
      this.deps.log(`Worktree assignment failed for "${config.name}": ${String(err)} — using the shared workspace.`);
      return undefined;
    }
  }

  /**
   * `SessionManager.onTurnComplete` impl. Commits + merges the agent's worktree into integration.
   * Fire-and-forget for the caller; returns a promise so tests can await. Serialized.
   */
  onTurnComplete(agentId: string, isError: boolean): Promise<void> {
    const wt = this.worktrees.get(agentId);
    if (!wt || isError) {
      return Promise.resolve();
    }
    return this.serialize(() => this.mergeAgent(wt));
  }

  private async mergeAgent(wt: Worktree): Promise<void> {
    try {
      const committed = await this.deps.orchestrator.commitWorktree(wt, `UnodeAi: ${wt.branch}`);

      // v0.7.0 verifier-as-gate: only NEWLY committed work needs (re-)verifying. If it fails the
      // project's checks, hold it on the agent's own branch — never merge unverified work into
      // integration — and hand the failure back so the agent fixes it and finishes again.
      if (committed && this.deps.verify && wt.agentId) {
        const verification = await this.deps.verify(wt.path);
        // A CONFIGURED verify command that policy blocked is NOT a pass — never merge it as if verified.
        // (A plain `skipped` with no command at all still merges: there's genuinely nothing to gate on.)
        if (verification.blocked) {
          this.verifyStatus.set(wt.agentId, verification);
          this.emit();
          this.deps.log(`Verification could not run for ${wt.branch} (\`${verification.command}\` not approved) — not merged.`);
          this.deps.notifyAgent?.(
            wt.agentId,
            `Your work can't merge yet: the verification command \`${verification.command}\` isn't approved ` +
            `to run, so the gate can't confirm it. Ask the user to add it to unode.allowedCommands (or adjust ` +
            `unode.commandApproval). Your work is safe on your own branch until verification can run.`
          );
          return; // held out of integration until verification can actually run
        }
        if (verification.status === 'failed') {
          this.verifyStatus.set(wt.agentId, verification);
          this.emit();
          this.deps.log(`Verification failed for ${wt.branch} (\`${verification.command}\`) — not merged.`);
          this.deps.notifyAgent?.(
            wt.agentId,
            `Your changes don't pass the project's checks yet (\`${verification.command}\`):\n\n${verification.output}\n\n` +
            `Fix the CODE and finish again — do NOT edit or weaken the tests to make them pass. ` +
            `Your work is safe on your own branch and will merge once it genuinely passes.`
          );
          return; // blocked from integration until it verifies
        }
        // Passed (or skipped). Anti-cheat: a weak agent can make the gate green by editing the tests
        // instead of the code (observed in dogfood: it changed the assertion to match the broken code).
        // We don't BLOCK (legit changes touch tests too — TDD/new features), but we FLAG a passing lane
        // that also modified test files so the human reviewer sees it before finalizing.
        let touchedTests: string[] | undefined;
        if (verification.status === 'passed' && this.deps.changedFiles) {
          try {
            const changed = await this.deps.changedFiles(wt);
            const tests = changed.filter(isVerificationTargetFile);
            if (tests.length > 0) {
              touchedTests = tests;
              this.deps.log(`Verification passed for ${wt.branch} BUT it modified test file(s): ${tests.join(', ')} — flagged for review.`);
            }
          } catch { /* best-effort: no flag on failure to diff */ }
        }
        this.verifyStatus.set(wt.agentId, { ...verification, touchedTests });
        this.emit();
        if (!touchedTests) {
          this.deps.log(`Verification ${verification.status} for ${wt.branch}${verification.command ? ` (\`${verification.command}\`)` : ''}.`);
        }
      }

      const result = await this.deps.orchestrator.mergeToIntegration(wt);
      if (result.status === 'conflict') {
        const files = result.conflictedFiles?.join(', ') || 'some files';
        this.deps.log(`Conflict merging ${wt.branch}: ${files}.`);
        if (wt.agentId) {
          this.deps.notifyAgent?.(
            wt.agentId,
            `Your changes conflict with a teammate's on: ${files}. Re-read those files, reconcile your edits, ` +
            `and finish again — your work is safe on your own branch.`
          );
        }
        return;
      }
      if (result.status === 'error') {
        this.deps.log(`Merge error for ${wt.branch}: ${result.message}`);
        return;
      }
      this.deps.log(`${wt.branch} → ${result.integrationBranch}: ${result.status}.`);
      if (result.status === 'merged' && this.deps.autoMerge()) {
        await this.runFinalize();
      }
    } catch (err) {
      this.deps.log(`Worktree merge failed for ${wt.branch}: ${String(err)}`);
    }
  }

  /** The "approve" action: finalize integration → base and refresh the user's checkout. Serialized. */
  finalize(baseRef?: string): Promise<MergeResult> {
    return this.serialize(() => this.runFinalize(baseRef));
  }

  private async runFinalize(baseRef?: string): Promise<MergeResult> {
    // finalizeToBase fast-forwards the live checkout itself (materializing files), so no separate
    // working-tree refresh is needed here.
    const result = await this.deps.orchestrator.finalizeToBase(baseRef);
    this.deps.log(`Finalize → ${result.branch}: ${result.status} — ${result.message}`);
    return result;
  }

  /** Remove an agent's worktree (on agent removal). Best-effort. Serialized with the merge chain so an
   *  in-flight commit/merge for this agent FINISHES before we delete its worktree — otherwise the merge
   *  would run against a removed path and the agent's work would be lost silently. (Audit #2.) */
  release(agentId: string): Promise<void> {
    return this.serialize(() => this.doRelease(agentId));
  }

  private async doRelease(agentId: string): Promise<void> {
    const wt = this.worktrees.get(agentId);
    if (!wt) {
      return;
    }
    this.worktrees.delete(agentId);
    this.verifyStatus.delete(agentId);
    try {
      // pruneBranch: also delete the agent's unode/<name> branch. Its work is already on integration by
      // now (we awaited the merge above), so removing the branch is safe and stops a later same-id
      // agent from failing on `git worktree add -b` ("branch already exists"). (Audit #1.)
      await this.deps.manager.remove(wt, { force: true, pruneBranch: true });
    } catch (err) {
      this.deps.log(`Worktree remove failed for ${wt.branch}: ${String(err)}`);
    }
  }

  /** Agents currently isolated in worktrees (for status / the review surface). */
  active(): Worktree[] {
    return [...this.worktrees.values()];
  }

  /** v0.7.0: the latest verify result for an agent's worktree (for the review board), incl. any test
   *  files a passing change touched (anti-cheat flag), or undefined if not verified this session. */
  verification(agentId: string): LaneVerifyState | undefined {
    return this.verifyStatus.get(agentId);
  }

  /** Re-run verification for an agent's worktree (triggered from the review board). Idempotent —
   *  replaces the previous status in verifyStatus; fires onChange when done. Respects deps.verify
   *  being absent. Returns the raw result (for logging), or undefined when no verify dep exists. */
  async reverify(agentId: string): Promise<VerifyResult | undefined> {
    const wt = this.worktrees.get(agentId);
    if (!wt || !this.deps.verify) return undefined;
    const result = await this.deps.verify(wt.path);
    let touchedTests: string[] | undefined;
    if (result.status === 'passed' && this.deps.changedFiles) {
      try {
        const changed = await this.deps.changedFiles(wt);
        const tests = changed.filter(isVerificationTargetFile);
        if (tests.length > 0) touchedTests = tests;
      } catch { /* best-effort: no flag on failure to diff */ }
    }
    this.verifyStatus.set(agentId, { ...result, touchedTests });
    this.emit();
    return result;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mergeChain.then(fn, fn);
    this.mergeChain = run.then(() => undefined, () => undefined);
    return run;
  }
}

/** Heuristic: is this path a test / spec file (the gate's verification target)? Used to flag a
 *  passing lane that also edited the tests — so "tests pass" can't silently mean "tests weakened".
 *  Deliberately broad across ecosystems (jest/vitest/mocha, pytest, go, rust, etc.). */
export function isVerificationTargetFile(p: string): boolean {
  const f = p.replace(/\\/g, '/').toLowerCase();
  return (
    /(^|\/)(tests?|__tests__|spec|specs)\//.test(f) ||      // a test/ or spec/ directory
    /\.(test|spec)\.[a-z0-9]+$/.test(f) ||                  // foo.test.ts / foo.spec.js
    /(^|\/)test_[^/]*\.py$/.test(f) || /_test\.[a-z0-9]+$/.test(f) // python test_*.py / go *_test.go
  );
}

/** Stable, readable, per-agent worktree name, e.g. "developer-a1b2c3". */
export function worktreeName(config: AgentConfig): string {
  const role = (config.role || 'agent').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const short = config.id.replace(/[^a-z0-9]+/gi, '').slice(0, 8) || Math.random().toString(36).slice(2, 10);
  return `${role}-${short}`;
}
