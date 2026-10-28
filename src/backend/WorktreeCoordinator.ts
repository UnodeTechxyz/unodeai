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
import { MergeOrchestrator, MergeResult, type MergeAdmission } from './MergeOrchestrator';
import { VerifyResult } from './Verifier';
import { policyVerifyResult, type PolicyVerifyResult } from './CompletionPolicyVerifier';
import { verificationUnrunOrUnknown } from './CompletionVerificationPolicy';
import type { WorktreeVerificationOwner } from './WorktreeVerificationOwner';
import type { VerificationCheckOutcome } from './CompletionVerificationCheck';

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
  /** Standalone legacy compatibility only: run a verify command in the worktree before merging.
   *  Returns passed/failed/skipped. Absent = no gate for old standalone hosts. On 'failed' the work is
   *  held on its own branch (not merged) and
   *  the failure is handed back to the agent; 'skipped'/'passed' fall through to the merge. */
  verify?: (cwd: string) => Promise<VerifyResult>;
  /** Product path: an observed typed pass and current completed-task ownership are mandatory for merging. */
  verifyTyped?: (worktree: Worktree, owner: WorktreeVerificationOwner) => Promise<PolicyVerifyResult & { mergeAdmission?: MergeAdmission }>;
  revision?: (worktree: Worktree) => Promise<string | undefined>;
  laneIsClean?: (worktree: Worktree) => Promise<boolean>;
  /** User-action hold, independent of any completed task or command authorization. */
  withManualMergeAdmission?: <T>(worktree: Worktree, operation: (isCurrent: () => boolean) => Promise<T>) => Promise<T | undefined>;
  /** v0.7.0 anti-cheat: list the files this lane changed (vs base), so a PASSING lane that also edited
   *  the tests can be flagged for review (a weak agent can make the gate green by weakening the tests
   *  instead of fixing the code). Absent = no flagging. Best-effort; failures degrade to "no flag". */
  changedFiles?: (worktree: Worktree) => Promise<string[]>;
  /**
   * v0.9.99: the admission for merging a lane into integration marked unverified, when its check could not run or its
   * outcome is unknown. Undefined when the current policy explicitly requires the check (a command the user set, or a
   * configuration the host cannot read): the lane then stays held as before. A failed check never reaches this.
   */
  unverifiedMergeAdmission?: (worktree: Worktree, owner: WorktreeVerificationOwner) => Promise<MergeAdmission | undefined>;
  /** v0.9.99: one non-modal line for the user, e.g. that a lane was merged unverified. Optional. */
  notifyUser?: (message: string) => void;
}

/** A lane's verification result, plus (v0.7.0 anti-cheat) any test files the passing change also
 *  modified — surfaced in the review board so "tests pass" can't silently mean "tests were weakened". */
export type LaneVerifyState = VerifyResult & { touchedTests?: string[]; check?: VerificationCheckOutcome };

export interface ManualLaneMergeReview { agentId: string; agentName: string; branch: string; head: string; reason: string }
export type ManualLaneMergeResult = { kind: 'cancelled' | 'refused' } | { kind: 'result'; result: MergeResult };

export class WorktreeCoordinator {
  private readonly worktrees = new Map<string, Worktree & { agentName: string }>();
  /** Guard so the "not a git repo" warning fires at most once per session, not per agent. */
  private warnedNonGit = false;
  // v0.7.0: last verification result per agent, for the review board (✓ verified / ✗ failing / ⚠ unverified),
  // plus any test files a passing change also touched (anti-cheat flag).
  private readonly verifyStatus = new Map<string, LaneVerifyState>();
  // Serializes commit/merge/finalize so concurrent turn-completions can't race the single
  // integration worktree.
  private mergeChain: Promise<unknown> = Promise.resolve();
  private mergedHeads = new Map<string, string>();
  private manualLandings = new Map<string, string>();

  /** Callback fired after verify state changes (mergeAgent, reverify). Extension subscribes to
   *  refresh the worktree review panel. Never throws — errors are silently caught. */
  onChange?: () => void;

  constructor(private readonly deps: WorktreeCoordinatorDeps) {}

  private emit(): void {
    try { this.onChange?.(); } catch { /* never let a subscriber crash the coordinator */ }
  }

  private markVerificationStale(wt: Worktree): void {
    if (!wt.agentId) return;
    const previous = this.verifyStatus.get(wt.agentId);
    const detail = 'Verification ownership, policy, permissions or lane revision changed; not merged.';
    this.verifyStatus.set(wt.agentId, { status: 'skipped', command: '', output: detail, blocked: true,
      check: { kind: 'not-run', source: previous?.check?.source ?? 'team-document', reason: 'policy-stale', detail } });
    this.emit();
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
      known.agentName = config.name;
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
        this.worktrees.set(config.id, { ...existing, agentId: config.id, agentName: config.name });
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
      this.worktrees.set(config.id, { ...wt, agentName: config.name });
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
  onTurnComplete(agentId: string, isError: boolean, owner?: WorktreeVerificationOwner): Promise<void> {
    const wt = this.worktrees.get(agentId);
    if (!wt || isError) {
      return Promise.resolve();
    }
    return this.serialize(() => this.mergeAgent(wt, owner));
  }

  private async mergeAgent(wt: Worktree, owner?: WorktreeVerificationOwner): Promise<void> {
    try {
      const prior = wt.agentId && this.deps.verifyTyped ? this.verifyStatus.get(wt.agentId) : undefined;
      // v0.9.99: an earlier check whose outcome is unknown is never started again (its command may still be running).
      // Under a policy that does not require the check, the lane still merges, marked unverified, without a new check.
      let priorUnknownAdmission: MergeAdmission | undefined;
      if (prior?.check?.kind === 'outcome-unknown') {
        priorUnknownAdmission = owner?.isCurrent() && owner.request.sessionId === wt.agentId
          ? await this.deps.unverifiedMergeAdmission?.(wt, owner) : undefined;
        if (!priorUnknownAdmission) {
          this.deps.log(`Verification outcome for ${wt.branch} is still unknown; no automatic check or merge was started.`);
          return;
        }
      }
      if (this.deps.verifyTyped && (!owner?.isCurrent() || owner.request.sessionId !== wt.agentId)) return;
      if (wt.agentId) { this.mergedHeads.delete(wt.agentId); this.manualLandings.delete(wt.agentId); }
      const committed = await this.deps.orchestrator.commitWorktree(wt, `UnodeAi: ${wt.branch}`);
      let admission: MergeAdmission | undefined;
      let verifiedHead: string | undefined;
      /** v0.9.99: set when this lane merges into integration marked unverified (its check could not run or is unknown). */
      let unverifiedReason: string | undefined;

      // The product always verifies, even without a new commit: a prior unrun/failed check cannot be bypassed
      // by completing a clean turn. Standalone legacy hosts retain their newly-committed-only behavior.
      // If verification fails the
      // project's checks, hold it on the agent's own branch — never merge unverified work into
      // integration — and hand the failure back so the agent fixes it and finishes again.
      if ((this.deps.verifyTyped || (committed && this.deps.verify)) && wt.agentId) {
        if (this.deps.verifyTyped && !owner?.isCurrent()) return;
        verifiedHead = this.deps.verifyTyped ? await this.deps.revision?.(wt) : undefined;
        if (this.deps.verifyTyped && (!verifiedHead || !/^[0-9a-f]{40}$/i.test(verifiedHead) || !owner?.isCurrent())) return;
        const typed = this.deps.verifyTyped && !priorUnknownAdmission ? await this.deps.verifyTyped(wt, owner!) : undefined;
        const verification = priorUnknownAdmission ? { ...prior!, blocked: true }
          : this.deps.verifyTyped ? typed && policyVerifyResult(typed.check) : await this.deps.verify!(wt.path);
        if (!verification) return;
        if (typed) {
          admission = typed.mergeAdmission && { ...typed.mergeAdmission, expectedHead: verifiedHead };
          if (typed.check.kind === 'not-run' || typed.check.kind === 'outcome-unknown'
            || (typed.check.kind === 'passed' && !admission) || !owner?.isCurrent()) verification.blocked = true;
        }
        // v0.9.99: a check that could not run, or whose outcome is unknown, no longer holds the lane unless the policy
        // explicitly requires it (the admission is then undefined). A failed check never comes here.
        const unverified = !verification.blocked || !owner?.isCurrent() ? undefined
          : priorUnknownAdmission ?? (typed && verificationUnrunOrUnknown(typed.check)
            ? await this.deps.unverifiedMergeAdmission?.(wt, owner) : undefined);
        if (unverified && owner?.isCurrent()) {
          admission = { ...unverified, expectedHead: verifiedHead };
          const check = typed?.check ?? prior?.check;
          unverifiedReason = check?.kind === 'not-run' ? check.detail : 'the outcome of its check is unknown';
          this.verifyStatus.set(wt.agentId, typed ? { ...verification, check: typed.check } : verification);
          this.emit();
          this.deps.log(`Verification could not run to a known result for ${wt.branch}; merging into integration marked unverified.`);
        } else if (verification.blocked) {
          // A CONFIGURED verify command that policy blocked is NOT a pass — never merge it as if verified.
          // (A plain `skipped` with no command at all still merges: there's genuinely nothing to gate on.)
          const commandLabel = verification.command ? `the verification command \`${verification.command}\`` : 'verification';
          this.verifyStatus.set(wt.agentId, verification);
          this.emit();
          this.deps.log(`Verification could not run to a known result for ${wt.branch}${verification.command ? ` (\`${verification.command}\`)` : ''} — not merged.`);
          // v0.9.96: the verifier says why (not approved, no direct shell, or an outcome it could not observe) and,
          // for an approval, which shell grammar the gate needs and how to grant it there.
          if (!typed) this.deps.notifyAgent?.(
            wt.agentId,
            `Your work can't merge yet: ${commandLabel} could not run to a known ` +
            `result, so the gate can't confirm it. ${verification.output} Your work is safe on your own branch until verification can run.`
          );
          return; // held out of integration until verification can actually run
        } else if (verification.status === 'failed') {
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
        } else {
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
      }

      if (this.deps.verifyTyped) {
        if (!owner?.isCurrent() || !admission) { this.markVerificationStale(wt); return; }
        await admission.refresh();
        if (!admission.isCurrent()) { this.markVerificationStale(wt); return; }
      }
      const result = admission ? await this.deps.orchestrator.mergeToIntegration(wt, admission)
        : await this.deps.orchestrator.mergeToIntegration(wt);
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
        if (result.admissionRefused) this.markVerificationStale(wt);
        this.deps.log(`Merge error for ${wt.branch}: ${result.message}`);
        return;
      }
      this.deps.log(`${wt.branch} → ${result.integrationBranch}: ${result.status}.`);
      if (wt.agentId && verifiedHead) this.mergedHeads.set(wt.agentId, verifiedHead);
      if (unverifiedReason !== undefined && wt.agentId && verifiedHead) {
        // v0.9.99: recorded as an unverified landing (never as check evidence), shown so on the review board. It is
        // not finalized to the base branch automatically: approving unverified work stays the user's step.
        this.manualLandings.set(wt.agentId, verifiedHead);
        this.emit();
        this.deps.notifyUser?.(`${(wt as Worktree & { agentName?: string }).agentName ?? wt.agentId}'s work was merged into the `
          + `integration branch unverified: ${unverifiedReason.replace(/\.$/, '')}. Review it in Crew Worktrees before you approve it.`);
        return;
      }
      if (result.status === 'merged' && this.deps.autoMerge()) {
        await this.runFinalize(undefined, admission);
      }
    } catch (err) {
      this.deps.log(`Worktree merge failed for ${wt.branch}: ${String(err)}`);
    }
  }

  /** The "approve" action: finalize integration → base and refresh the user's checkout. Serialized. */
  finalize(baseRef?: string): Promise<MergeResult> {
    return this.serialize(() => this.runFinalize(baseRef));
  }

  /** Explicit user landing into integration only. It never runs a check or automatically finalizes to base. */
  mergeWithoutVerification(agentId: string, confirm: (review: ManualLaneMergeReview) => Promise<boolean>): Promise<ManualLaneMergeResult> {
    return this.serialize(async () => {
      const wt = this.worktrees.get(agentId);
      if (!wt || !this.deps.withManualMergeAdmission) return { kind: 'refused' };
      const result = await this.deps.withManualMergeAdmission(wt, async isOwnerCurrent => {
        let clean = false;
        const current = () => isOwnerCurrent() && this.worktrees.get(agentId) === wt && clean;
        const refresh = async () => { clean = await this.deps.laneIsClean?.(wt) === true; };
        await refresh();
        const head = await this.deps.revision?.(wt);
        if (!current() || !head || !/^[0-9a-f]{40}$/i.test(head) || this.mergedHeads.get(agentId) === head) return { kind: 'refused' } as const;
        const v = this.verifyStatus.get(agentId);
        if (v?.status === 'passed' && !v.blocked) return { kind: 'refused' } as const;
        const reason = v?.check?.kind === 'not-run' ? `Check not run (${v.check.reason}).`
          : v?.check?.kind === 'outcome-unknown' ? 'The check outcome is unknown.'
            : v?.status === 'failed' ? 'The check failed.'
              : 'No current passing verification authorizes this merge.';
        if (await confirm({ agentId, agentName: wt.agentName, branch: wt.branch, head, reason }) !== true) return { kind: 'cancelled' } as const;
        await refresh();
        if (!current() || await this.deps.revision?.(wt) !== head) return { kind: 'refused' } as const;
        const merged = await this.deps.orchestrator.mergeToIntegration(wt, { expectedHead: head, refresh, isCurrent: current });
        if (merged.status === 'merged' || merged.status === 'nothing') {
          this.mergedHeads.set(agentId, head);
          this.manualLandings.set(agentId, head);
          this.deps.log(`Manually merged ${wt.branch} at ${head} into ${merged.integrationBranch}: unverified (not check evidence).`);
          this.emit();
        }
        return { kind: 'result', result: merged } as const;
      });
      return result ?? { kind: 'refused' };
    });
  }

  manualLanding(agentId: string): string | undefined { return this.manualLandings.get(agentId); }
  agentName(agentId: string): string | undefined { return this.worktrees.get(agentId)?.agentName; }

  private async runFinalize(baseRef?: string, admission?: MergeAdmission): Promise<MergeResult> {
    // finalizeToBase fast-forwards the live checkout itself (materializing files), so no separate
    // working-tree refresh is needed here.
    const result = admission ? await this.deps.orchestrator.finalizeToBase(baseRef, admission)
      : await this.deps.orchestrator.finalizeToBase(baseRef);
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
    if (this.deps.verifyTyped) {
      const head = await this.deps.revision?.(wt);
      if (!head || (this.verifyStatus.get(agentId)?.check?.kind === 'outcome-unknown' && this.manualLandings.get(agentId) !== head) || this.mergedHeads.get(agentId) !== head) {
        this.deps.log(`Retained ${wt.branch}: its current work has not been verified and merged.`);
        return;
      }
    }
    try {
      // pruneBranch: also delete the agent's unode/<name> branch. Its work is already on integration by
      // now (we awaited the merge above), so removing the branch is safe and stops a later same-id
      // agent from failing on `git worktree add -b` ("branch already exists"). (Audit #1.)
      await this.deps.manager.remove(wt, { force: !this.deps.verifyTyped, pruneBranch: true });
      this.worktrees.delete(agentId);
      this.verifyStatus.delete(agentId);
      this.mergedHeads.delete(agentId);
      this.manualLandings.delete(agentId);
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
  async reverify(agentId: string, owner?: WorktreeVerificationOwner): Promise<LaneVerifyState | undefined> {
    return this.serialize(() => this.doReverify(agentId, owner));
  }

  private async doReverify(agentId: string, owner?: WorktreeVerificationOwner): Promise<LaneVerifyState | undefined> {
    const wt = this.worktrees.get(agentId);
    if (!wt || (!this.deps.verify && !this.deps.verifyTyped)) return undefined;
    if (this.deps.verifyTyped && this.verifyStatus.get(agentId)?.check?.kind === 'outcome-unknown') return this.verifyStatus.get(agentId);
    if (this.deps.verifyTyped && (!owner?.isCurrent() || owner.request.sessionId !== agentId)) return undefined;
    const typed = this.deps.verifyTyped ? await this.deps.verifyTyped(wt, owner!) : undefined;
    const result = this.deps.verifyTyped ? typed && policyVerifyResult(typed.check) : await this.deps.verify!(wt.path);
    if (!result) return undefined;
    if (this.deps.verifyTyped && !owner?.isCurrent()) return undefined;
    let touchedTests: string[] | undefined;
    if (result.status === 'passed' && this.deps.changedFiles) {
      try {
        const changed = await this.deps.changedFiles(wt);
        const tests = changed.filter(isVerificationTargetFile);
        if (tests.length > 0) touchedTests = tests;
      } catch { /* best-effort: no flag on failure to diff */ }
    }
    if (this.deps.verifyTyped && !owner?.isCurrent()) return undefined;
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
