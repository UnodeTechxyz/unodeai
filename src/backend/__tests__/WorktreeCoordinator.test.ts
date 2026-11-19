import { describe, it, expect, vi } from 'vitest';
import { AgentConfig } from '../../types';
import { WorktreeCoordinator, WorktreeCoordinatorDeps, isVerificationTargetFile } from '../WorktreeCoordinator';
import { WorktreeManager, Worktree } from '../WorktreeManager';
import { MergeOrchestrator, MergeResult } from '../MergeOrchestrator';
import { policyVerifyResult } from '../CompletionPolicyVerifier';
import type { VerificationCheckOutcome } from '../CompletionVerificationCheck';
import type { WorktreeVerificationOwner } from '../WorktreeVerificationOwner';

function cfg(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'a1', name: 'Dev', role: 'developer', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'K' },
    model: 'm', systemPrompt: '', autoApprove: false, allowedTools: [],
    ...over,
  };
}

function fakeManager(over: Partial<Record<keyof WorktreeManager, unknown>> = {}): WorktreeManager {
  return {
    isGitRepo: vi.fn(async () => true),
    isClean: vi.fn(async () => true),
    list: vi.fn(async () => [] as Worktree[]),
    create: vi.fn(async (opts: { name?: string; branch?: string; agentId?: string } = {}) => ({
      path: `/wt/${opts.name}`, branch: opts.branch ?? `unode/${opts.name}`, agentId: opts.agentId,
    })),
    remove: vi.fn(async () => undefined),
    ...over,
  } as unknown as WorktreeManager;
}

const ok = (status: MergeResult['status'], extra: Partial<MergeResult> = {}): MergeResult => ({
  status, branch: 'unode/developer-a1', integrationBranch: 'unode/integration', message: status, ...extra,
});

function fakeOrchestrator(over: Partial<MergeOrchestrator> = {}): MergeOrchestrator {
  return {
    ensureIntegration: vi.fn(async () => undefined),
    commitWorktree: vi.fn(async () => true),
    mergeToIntegration: vi.fn(async () => ok('merged')),
    finalizeToBase: vi.fn(async () => ok('merged', { branch: 'main' })),
    ...over,
  };
}

function make(over: Partial<WorktreeCoordinatorDeps> = {}) {
  const deps: WorktreeCoordinatorDeps = {
    manager: fakeManager(),
    orchestrator: fakeOrchestrator(),
    isEnabled: () => true,
    autoMerge: () => false,
    maxParallel: () => 4,
    isEligible: () => true,
    log: vi.fn(),
    notifyAgent: vi.fn(),
    ...over,
  };
  return { deps, coord: new WorktreeCoordinator(deps) };
}

describe('explicit manual landing, never verification', () => {
  it.each(['cancel', 'merge', 'changed-head', 'busy', 'revoked', 'dirty', 'conflict'] as const)('requires fresh consent and an idle unchanged lane (%s)', async mode => {
    let head = 'a'.repeat(40); let current = true;
    const orchestrator = fakeOrchestrator({ mergeToIntegration: vi.fn(async (_wt, admission) => {
      await admission!.refresh(); expect(admission!.isCurrent()).toBe(true);
      expect(admission!.expectedHead).toBe('a'.repeat(40));
      return ok(mode === 'conflict' ? 'conflict' : 'merged');
    }) });
    const { coord, deps } = make({ orchestrator, autoMerge: () => true,
      revision: async () => head, laneIsClean: async () => mode !== 'dirty',
      withManualMergeAdmission: async (_wt, operation) => mode === 'busy' ? undefined : operation(() => current),
      verifyTyped: vi.fn(),
    });
    await coord.assignWorkingDirectory(cfg());
    const confirm = vi.fn(async review => {
      expect(review).toMatchObject({ agentId: 'a1', agentName: 'Dev', branch: 'unode/developer-a1', head: 'a'.repeat(40) });
      if (mode === 'changed-head') head = 'b'.repeat(40);
      if (mode === 'revoked') current = false;
      return mode !== 'cancel';
    });
    const result = await coord.mergeWithoutVerification('a1', confirm);
    const merges = mode === 'merge' || mode === 'conflict';
    expect(orchestrator.mergeToIntegration).toHaveBeenCalledTimes(merges ? 1 : 0);
    expect(confirm).toHaveBeenCalledTimes(mode === 'busy' || mode === 'dirty' ? 0 : 1);
    expect(result.kind).toBe(mode === 'cancel' ? 'cancelled' : merges ? 'result' : 'refused');
    expect(coord.manualLanding('a1')).toBe(mode === 'merge' ? 'a'.repeat(40) : undefined);
    expect(coord.verification('a1')).toBeUndefined();
    expect(deps.verifyTyped).not.toHaveBeenCalled(); expect(orchestrator.commitWorktree).not.toHaveBeenCalled();
    expect(orchestrator.finalizeToBase).not.toHaveBeenCalled();
  });

  it('preserves an unknown check as unknown, while allowing cleanup only of the manually landed head', async () => {
    const check: VerificationCheckOutcome = { kind: 'outcome-unknown', source: 'team-document', command: 'private-command', output: 'secret output',
      binding: { source: 'team-document', workspaceId: 'workspace', teamKind: 'software', policyDigest: 'digest' } };
    const { coord, deps } = make({ verifyTyped: async () => policyVerifyResult(check), revision: async () => 'a'.repeat(40),
      laneIsClean: async () => true, withManualMergeAdmission: async (_wt, operation) => operation(() => true) });
    await coord.assignWorkingDirectory(cfg());
    const lease = { request: { kind: 'session' as const, sessionId: 'a1', requestId: 'request', attemptId: 'turn' },
      launchId: 'launch', signal: new AbortController().signal, hasTaskScope: false, isCurrent: () => true };
    await coord.onTurnComplete('a1', false, lease);
    expect(coord.verification('a1')?.check).toEqual(check);
    const confirm = vi.fn(async review => { expect(JSON.stringify(review)).not.toMatch(/private-command|secret output/); return true; });
    await coord.mergeWithoutVerification('a1', confirm);
    expect(coord.verification('a1')?.check).toEqual(check);
    expect(coord.verification('a1')?.status).not.toBe('passed');
    await coord.release('a1');
    expect(deps.manager.remove).toHaveBeenCalledWith(expect.anything(), { force: false, pruneBranch: true });
  });
});

describe('WorktreeCoordinator.assignWorkingDirectory', () => {
  it('returns undefined (shared root) when disabled', async () => {
    const { deps, coord } = make({ isEnabled: () => false });
    expect(await coord.assignWorkingDirectory(cfg())).toBeUndefined();
    expect(deps.manager.create).not.toHaveBeenCalled();
  });

  it('returns undefined for ineligible agents (PM/solo)', async () => {
    const { deps, coord } = make({ isEligible: () => false });
    expect(await coord.assignWorkingDirectory(cfg({ role: 'pm' }))).toBeUndefined();
    expect(deps.manager.create).not.toHaveBeenCalled();
  });

  it('falls back to shared root when not a git repo', async () => {
    const { deps, coord } = make({ manager: fakeManager({ isGitRepo: vi.fn(async () => false) }) });
    expect(await coord.assignWorkingDirectory(cfg())).toBeUndefined();
    expect(deps.manager.create).not.toHaveBeenCalled();
  });

  it('warns ONCE (onNonGitRepo) when worktree mode runs on a non-git workspace', async () => {
    const onNonGitRepo = vi.fn();
    const { coord } = make({ manager: fakeManager({ isGitRepo: vi.fn(async () => false) }), onNonGitRepo });
    await coord.assignWorkingDirectory(cfg({ id: 'a1' }));
    await coord.assignWorkingDirectory(cfg({ id: 'a2' })); // a 2nd agent must NOT re-warn
    expect(onNonGitRepo).toHaveBeenCalledTimes(1);
  });

  it('falls back when the tree is dirty', async () => {
    const { deps, coord } = make({ manager: fakeManager({ isClean: vi.fn(async () => false) }) });
    expect(await coord.assignWorkingDirectory(cfg())).toBeUndefined();
    expect(deps.manager.create).not.toHaveBeenCalled();
  });

  it('creates a worktree for an eligible agent and tracks it', async () => {
    const { deps, coord } = make();
    const p = await coord.assignWorkingDirectory(cfg());
    expect(p).toBe('/wt/developer-a1');
    expect(deps.manager.create).toHaveBeenCalledTimes(1);
    expect(coord.active()).toHaveLength(1);
  });

  it('reuses the same worktree across restarts (no second create)', async () => {
    const { deps, coord } = make();
    const p1 = await coord.assignWorkingDirectory(cfg());
    const p2 = await coord.assignWorkingDirectory(cfg());
    expect(p2).toBe(p1);
    expect(deps.manager.create).toHaveBeenCalledTimes(1);
    await coord.assignWorkingDirectory(cfg({ name: 'Renamed developer' }));
    expect(coord.agentName('a1')).toBe('Renamed developer');
  });

  it('adopts an existing worktree on the agent branch (survives reload)', async () => {
    const existing: Worktree = { path: '/wt/developer-a1', branch: 'unode/developer-a1' };
    const { deps, coord } = make({ manager: fakeManager({ list: vi.fn(async () => [existing]) }) });
    const p = await coord.assignWorkingDirectory(cfg());
    expect(p).toBe('/wt/developer-a1');
    expect(deps.manager.create).not.toHaveBeenCalled();
  });

  it('respects the maxParallel cap', async () => {
    const { deps, coord } = make({ maxParallel: () => 1 });
    await coord.assignWorkingDirectory(cfg({ id: 'a1' }));
    const second = await coord.assignWorkingDirectory(cfg({ id: 'a2', name: 'Dev2' }));
    expect(second).toBeUndefined();
    expect(deps.manager.create).toHaveBeenCalledTimes(1);
  });
});

describe('WorktreeCoordinator.onTurnComplete', () => {
  it('does nothing for an agent without a worktree, or on error', async () => {
    const { deps, coord } = make();
    await coord.onTurnComplete('unknown', false);
    expect(deps.orchestrator.commitWorktree).not.toHaveBeenCalled();

    await coord.assignWorkingDirectory(cfg());
    await coord.onTurnComplete('a1', true); // turn errored
    expect(deps.orchestrator.commitWorktree).not.toHaveBeenCalled();
  });

  it('commits + merges to integration on success, no finalize when autoMerge is off', async () => {
    const { deps, coord } = make({ autoMerge: () => false });
    await coord.assignWorkingDirectory(cfg());
    await coord.onTurnComplete('a1', false);
    expect(deps.orchestrator.commitWorktree).toHaveBeenCalledTimes(1);
    expect(deps.orchestrator.mergeToIntegration).toHaveBeenCalledTimes(1);
    expect(deps.orchestrator.finalizeToBase).not.toHaveBeenCalled();
  });

  it('auto-finalizes when autoMerge is on', async () => {
    const { deps, coord } = make({ autoMerge: () => true });
    await coord.assignWorkingDirectory(cfg());
    await coord.onTurnComplete('a1', false);
    expect(deps.orchestrator.finalizeToBase).toHaveBeenCalledTimes(1);
  });

  it('on conflict, notifies the agent with the conflicted files and does not finalize', async () => {
    const orchestrator = fakeOrchestrator({
      mergeToIntegration: vi.fn(async () => ok('conflict', { conflictedFiles: ['src/auth.ts'] })),
    });
    const { deps, coord } = make({ orchestrator, autoMerge: () => true });
    await coord.assignWorkingDirectory(cfg());
    await coord.onTurnComplete('a1', false);
    expect(deps.notifyAgent).toHaveBeenCalledWith('a1', expect.stringContaining('src/auth.ts'));
    expect(orchestrator.finalizeToBase).not.toHaveBeenCalled();
  });
});

describe('WorktreeCoordinator verifier-as-gate (0.7.0)', () => {
  const verifyResult = (status: 'passed' | 'failed' | 'skipped', output = '') =>
    ({ status, command: 'npm test', output });

  it.each(['', 'npm test'])('describes blocked verification without an empty command span (%s)', async command => {
    const { deps, coord } = make({ verify: async () => ({ status: 'skipped', command, output: 'Not authorized.', blocked: true }) });
    await coord.assignWorkingDirectory(cfg());
    await coord.onTurnComplete('a1', false);
    expect(deps.orchestrator.mergeToIntegration).not.toHaveBeenCalled();
    const message = vi.mocked(deps.notifyAgent!).mock.calls[0][1];
    const logs = vi.mocked(deps.log).mock.calls.map(([line]) => line).join('\n');
    expect(message).not.toContain('``');
    expect(logs).not.toContain('``');
    expect(message).toContain('Not authorized.');
    expect(message).toContain(command ? 'the verification command `npm test`' : 'verification could not run');
  });

  it('merges when verification passes and records the status', async () => {
    const verify = vi.fn(async () => verifyResult('passed', 'all green'));
    const { deps, coord } = make({ verify });
    await coord.assignWorkingDirectory(cfg());
    await coord.onTurnComplete('a1', false);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(deps.orchestrator.mergeToIntegration).toHaveBeenCalledTimes(1);
    expect(coord.verification('a1')?.status).toBe('passed');
  });

  it('does NOT merge when verification fails, and hands the failure back to the agent', async () => {
    const verify = vi.fn(async () => verifyResult('failed', '2 tests failing'));
    const { deps, coord } = make({ verify });
    await coord.assignWorkingDirectory(cfg());
    await coord.onTurnComplete('a1', false);
    expect(deps.orchestrator.mergeToIntegration).not.toHaveBeenCalled();
    expect(deps.notifyAgent).toHaveBeenCalledWith('a1', expect.stringContaining('2 tests failing'));
    expect(coord.verification('a1')?.status).toBe('failed');
  });

  it('a failed verification blocks auto-finalize too', async () => {
    const verify = vi.fn(async () => verifyResult('failed', 'x'));
    const { deps, coord } = make({ verify, autoMerge: () => true });
    await coord.assignWorkingDirectory(cfg());
    await coord.onTurnComplete('a1', false);
    expect(deps.orchestrator.finalizeToBase).not.toHaveBeenCalled();
  });

  it('merges when verification is skipped (no command / gate off — nothing to gate on)', async () => {
    const verify = vi.fn(async () => verifyResult('skipped'));
    const { deps, coord } = make({ verify });
    await coord.assignWorkingDirectory(cfg());
    await coord.onTurnComplete('a1', false);
    expect(deps.orchestrator.mergeToIntegration).toHaveBeenCalledTimes(1);
  });

  it('does not verify when the turn committed nothing new', async () => {
    const verify = vi.fn(async () => verifyResult('passed'));
    const orchestrator = fakeOrchestrator({ commitWorktree: vi.fn(async () => false) });
    const { coord } = make({ verify, orchestrator });
    await coord.assignWorkingDirectory(cfg());
    await coord.onTurnComplete('a1', false);
    expect(verify).not.toHaveBeenCalled();
  });

  it('with no verify dep, merges as before (pre-0.7.0 behavior unchanged)', async () => {
    const { deps, coord } = make(); // no verify
    await coord.assignWorkingDirectory(cfg());
    await coord.onTurnComplete('a1', false);
    expect(deps.orchestrator.mergeToIntegration).toHaveBeenCalledTimes(1);
  });

  it('anti-cheat: flags (but still merges) a passing lane that also edited test files', async () => {
    const verify = vi.fn(async () => verifyResult('passed'));
    const changedFiles = vi.fn(async () => ['src/math.js', 'test/math.test.js']);
    const { deps, coord } = make({ verify, changedFiles });
    await coord.assignWorkingDirectory(cfg());
    await coord.onTurnComplete('a1', false);
    expect(deps.orchestrator.mergeToIntegration).toHaveBeenCalledTimes(1); // not blocked — flagged
    expect(coord.verification('a1')?.touchedTests).toEqual(['test/math.test.js']);
  });

  it('anti-cheat: does NOT flag a passing lane that only changed source', async () => {
    const verify = vi.fn(async () => verifyResult('passed'));
    const changedFiles = vi.fn(async () => ['src/math.js']);
    const { coord } = make({ verify, changedFiles });
    await coord.assignWorkingDirectory(cfg());
    await coord.onTurnComplete('a1', false);
    expect(coord.verification('a1')?.touchedTests).toBeUndefined();
  });
});

describe('typed product worktree verification', () => {
  function owner(): WorktreeVerificationOwner {
    return { request: { kind: 'session', sessionId: 'a1', requestId: 'request-A', attemptId: 'turn-A' },
      launchId: 'launch-A', hasTaskScope: false, signal: new AbortController().signal, isCurrent: () => true };
  }
  function observation(kind: 'passed' | 'failed' | 'disabled' | 'not-applicable' | 'outcome-unknown'): VerificationCheckOutcome {
    const context = { source: 'team-document' as const, binding: {
      source: 'team-document' as const, workspaceId: 'workspace-A', policyDigest: 'digest', teamKind: 'software' as const,
    } };
    return kind === 'passed' ? { ...context, kind, command: 'npm test', exitCode: 0, output: 'PASS' }
      : kind === 'failed' ? { ...context, kind, command: 'npm test', reason: 'exit-nonzero', output: 'FAIL' }
        : kind === 'outcome-unknown' ? { ...context, kind, command: 'npm test', output: 'unknown' }
          : { ...context, kind: 'not-run', reason: kind, detail: 'No check ran.' };
  }

  it.each(['passed', 'failed', 'disabled', 'not-applicable', 'outcome-unknown'] as const)(
    'only an observed pass merges (%s), and unrun/unknown starts no agent repair turn', async kind => {
      const lease = owner(); const mergeAdmission = { refresh: vi.fn(async () => {}), isCurrent: () => lease.isCurrent() };
      const verifyTyped = vi.fn(async () => ({ ...policyVerifyResult(observation(kind)), mergeAdmission }));
      const legacy = vi.fn(async () => ({ status: 'passed' as const, command: 'unsafe-fallback', output: '' }));
      const { coord, deps } = make({ verifyTyped, verify: legacy, revision: async () => 'a'.repeat(40), autoMerge: () => true });
      await coord.assignWorkingDirectory(cfg()); await coord.onTurnComplete('a1', false, lease);
      expect(legacy).not.toHaveBeenCalled(); expect(verifyTyped).toHaveBeenCalledTimes(1);
      expect(deps.orchestrator.mergeToIntegration).toHaveBeenCalledTimes(kind === 'passed' ? 1 : 0);
      expect(deps.orchestrator.finalizeToBase).toHaveBeenCalledTimes(kind === 'passed' ? 1 : 0);
      expect(deps.notifyAgent).toHaveBeenCalledTimes(kind === 'failed' ? 1 : 0);
      if (kind === 'passed') {
        expect(deps.orchestrator.mergeToIntegration).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ expectedHead: 'a'.repeat(40) }));
        await coord.release('a1');
        expect(deps.manager.remove).toHaveBeenCalledWith(expect.any(Object), { force: false, pruneBranch: true });
      }
      else {
        await coord.release('a1');
        expect(deps.manager.remove).not.toHaveBeenCalled();
        expect(coord.active()).toHaveLength(1);
      }
      if (kind === 'outcome-unknown') {
        await coord.onTurnComplete('a1', false, lease); await coord.reverify('a1', lease);
        expect(verifyTyped).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('cannot bypass a failed/unrun gate by finishing again without new changes', async () => {
    const verifyTyped = vi.fn(async () => policyVerifyResult(observation('disabled')));
    const { coord, deps } = make({ verifyTyped, revision: async () => 'a'.repeat(40),
      orchestrator: fakeOrchestrator({ commitWorktree: vi.fn(async () => false) }) });
    await coord.assignWorkingDirectory(cfg()); await coord.onTurnComplete('a1', false, owner());
    expect(verifyTyped).toHaveBeenCalledTimes(1); expect(deps.orchestrator.mergeToIntegration).not.toHaveBeenCalled();
  });

  it('a contradictory legacy passed status cannot turn a typed failed check into a merge', async () => {
    const { coord, deps } = make({ revision: async () => 'a'.repeat(40),
      verifyTyped: async () => ({ ...policyVerifyResult(observation('failed')), status: 'passed',
        mergeAdmission: { refresh: async () => {}, isCurrent: () => true } }) });
    await coord.assignWorkingDirectory(cfg()); await coord.onTurnComplete('a1', false, owner());
    expect(deps.orchestrator.mergeToIntegration).not.toHaveBeenCalled();
    expect(coord.verification('a1')?.status).toBe('failed');
  });

  it('refuses missing ownership, and an expired queued owner before committing', async () => {
    const verifyTyped = vi.fn(async () => policyVerifyResult(observation('passed')));
    const { coord, deps } = make({ verifyTyped, revision: async () => 'a'.repeat(40) });
    await coord.assignWorkingDirectory(cfg()); await coord.onTurnComplete('a1', false);
    await coord.onTurnComplete('a1', false, { ...owner(), isCurrent: () => false });
    expect(deps.orchestrator.commitWorktree).not.toHaveBeenCalled(); expect(verifyTyped).not.toHaveBeenCalled();
  });

  it('rechecks after an asynchronous test-file diff and holds work when ownership expires', async () => {
    let current = true; const lease = { ...owner(), isCurrent: () => current };
    const { coord, deps } = make({ revision: async () => 'a'.repeat(40),
      verifyTyped: async () => ({ ...policyVerifyResult(observation('passed')), mergeAdmission: {
        refresh: async () => {}, isCurrent: () => current,
      } }), changedFiles: async () => { current = false; return []; } });
    await coord.assignWorkingDirectory(cfg()); await coord.onTurnComplete('a1', false, lease);
    expect(deps.orchestrator.mergeToIntegration).not.toHaveBeenCalled();
  });
});

// v0.9.99 (B10): a check that could not run, or whose outcome is unknown, no longer holds the lane until "Merge
// without verification" unless the policy explicitly requires it. The lane merges into integration marked unverified
// (never as check evidence), is not finalized automatically, and the user is told. A failed check still holds.
describe('unrun or unknown verification continues unverified (v0.9.99)', () => {
  function owner(): WorktreeVerificationOwner {
    return { request: { kind: 'session', sessionId: 'a1', requestId: 'request-A', attemptId: 'turn-A' },
      launchId: 'launch-A', hasTaskScope: false, signal: new AbortController().signal, isCurrent: () => true };
  }
  type Kind = 'passed' | 'failed' | 'disabled' | 'not-applicable' | 'spawn-failed' | 'policy-stale' | 'configuration-invalid' | 'outcome-unknown';
  function observation(kind: Kind): VerificationCheckOutcome {
    const context = { source: 'team-document' as const, binding: {
      source: 'team-document' as const, workspaceId: 'workspace-A', policyDigest: 'digest', teamKind: 'software' as const,
    } };
    return kind === 'passed' ? { ...context, kind, command: 'npm test', exitCode: 0, output: 'PASS' }
      : kind === 'failed' ? { ...context, kind, command: 'npm test', reason: 'exit-nonzero', output: 'FAIL' }
        : kind === 'outcome-unknown' ? { ...context, kind, command: 'npm test', output: 'unknown' }
          : { ...context, kind: 'not-run', reason: kind, detail: `The check did not run (${kind}).` };
  }
  function setup(kind: Kind, required = false) {
    const admissionRefresh = vi.fn(async () => {});
    const unverifiedMergeAdmission = vi.fn(async () => required ? undefined : { refresh: admissionRefresh, isCurrent: () => true });
    const verifyTyped = vi.fn(async () => policyVerifyResult(observation(kind)));
    const notifyUser = vi.fn();
    const made = make({ verifyTyped, unverifiedMergeAdmission, notifyUser, revision: async () => 'a'.repeat(40), autoMerge: () => true });
    return { ...made, verifyTyped, unverifiedMergeAdmission, notifyUser, admissionRefresh };
  }

  it.each(['disabled', 'not-applicable', 'spawn-failed', 'outcome-unknown'] as const)(
    'merges a lane whose check is %s into integration, marked unverified, and tells the user', async kind => {
      const { coord, deps, notifyUser, admissionRefresh } = setup(kind);
      await coord.assignWorkingDirectory(cfg()); await coord.onTurnComplete('a1', false, owner());
      expect(deps.orchestrator.mergeToIntegration).toHaveBeenCalledTimes(1);
      expect(deps.orchestrator.mergeToIntegration).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ expectedHead: 'a'.repeat(40) }));
      expect(admissionRefresh).toHaveBeenCalled();
      // Truthful status: never a pass, recorded as an unverified landing at that head.
      expect(coord.verification('a1')?.status).not.toBe('passed');
      expect(coord.verification('a1')?.blocked).toBe(true);
      expect(coord.manualLanding('a1')).toBe('a'.repeat(40));
      // Not finalized to base automatically, even with auto-merge on, and no repair turn for the agent.
      expect(deps.orchestrator.finalizeToBase).not.toHaveBeenCalled();
      expect(deps.notifyAgent).not.toHaveBeenCalled();
      expect(notifyUser).toHaveBeenCalledTimes(1);
      expect(notifyUser.mock.calls[0][0]).toMatch(/^Dev's work was merged into the integration branch unverified: .*Review it in Crew Worktrees before you approve it\.$/);
      // The landed lane can be released like any merged one.
      await coord.release('a1');
      expect(deps.manager.remove).toHaveBeenCalled();
    });

  it('an unknown outcome is never checked again; the next completion merges unverified without a new check', async () => {
    const { coord, deps, verifyTyped, unverifiedMergeAdmission } = setup('outcome-unknown');
    await coord.assignWorkingDirectory(cfg()); await coord.onTurnComplete('a1', false, owner());
    await coord.onTurnComplete('a1', false, owner());
    expect(verifyTyped).toHaveBeenCalledTimes(1);
    expect(unverifiedMergeAdmission).toHaveBeenCalledTimes(2);
    expect(deps.orchestrator.mergeToIntegration).toHaveBeenCalledTimes(2);
    expect(coord.verification('a1')?.check?.kind).toBe('outcome-unknown');
  });

  it.each(['disabled', 'outcome-unknown'] as const)('an explicitly required check (%s) still holds the lane', async kind => {
    const { coord, deps, notifyUser } = setup(kind, true);
    await coord.assignWorkingDirectory(cfg()); await coord.onTurnComplete('a1', false, owner());
    expect(deps.orchestrator.mergeToIntegration).not.toHaveBeenCalled();
    expect(coord.manualLanding('a1')).toBeUndefined();
    expect(notifyUser).not.toHaveBeenCalled();
    await coord.release('a1');
    expect(deps.manager.remove).not.toHaveBeenCalled();
  });

  it.each(['failed', 'policy-stale', 'configuration-invalid'] as const)('a %s check is not "could not run": the lane is held', async kind => {
    const { coord, deps, unverifiedMergeAdmission } = setup(kind);
    await coord.assignWorkingDirectory(cfg()); await coord.onTurnComplete('a1', false, owner());
    expect(deps.orchestrator.mergeToIntegration).not.toHaveBeenCalled();
    expect(unverifiedMergeAdmission).not.toHaveBeenCalled();
    expect(deps.notifyAgent).toHaveBeenCalledTimes(kind === 'failed' ? 1 : 0);
  });

  it('a stale admission at merge time holds the lane instead of merging', async () => {
    const verifyTyped = vi.fn(async () => policyVerifyResult(observation('spawn-failed')));
    const { coord, deps } = make({ verifyTyped, revision: async () => 'a'.repeat(40),
      unverifiedMergeAdmission: async () => ({ refresh: async () => {}, isCurrent: () => false }) });
    await coord.assignWorkingDirectory(cfg()); await coord.onTurnComplete('a1', false, owner());
    expect(deps.orchestrator.mergeToIntegration).not.toHaveBeenCalled();
    expect(coord.manualLanding('a1')).toBeUndefined();
  });

  it('a passed check still merges as verified and finalizes with auto-merge', async () => {
    const lease = owner();
    const verifyTyped = vi.fn(async () => ({ ...policyVerifyResult(observation('passed')), mergeAdmission: { refresh: async () => {}, isCurrent: () => true } }));
    const unverifiedMergeAdmission = vi.fn();
    const { coord, deps } = make({ verifyTyped, unverifiedMergeAdmission, revision: async () => 'a'.repeat(40), autoMerge: () => true });
    await coord.assignWorkingDirectory(cfg()); await coord.onTurnComplete('a1', false, lease);
    expect(deps.orchestrator.finalizeToBase).toHaveBeenCalledTimes(1);
    expect(coord.manualLanding('a1')).toBeUndefined();
    expect(unverifiedMergeAdmission).not.toHaveBeenCalled();
  });
});

describe('isVerificationTargetFile', () => {
  it.each([
    'test/math.test.js', 'src/__tests__/foo.ts', 'spec/bar.rb', 'foo.spec.ts',
    'tests/thing.py', 'pkg/thing_test.go', 'test_utils.py',
  ])('treats %s as a test/verification target', (p) => {
    expect(isVerificationTargetFile(p)).toBe(true);
  });
  it.each(['src/math.js', 'src/contestant.ts', 'README.md', 'lib/latest.js'])(
    'does not flag ordinary source %s', (p) => {
    expect(isVerificationTargetFile(p)).toBe(false);
  });
});

describe('WorktreeCoordinator.finalize / release', () => {
  it('finalize() runs finalizeToBase', async () => {
    const { deps, coord } = make();
    const r = await coord.finalize();
    expect(r.status).toBe('merged');
    expect(deps.orchestrator.finalizeToBase).toHaveBeenCalledTimes(1);
  });

  it('passes an explicit base branch through to finalizeToBase', async () => {
    const { deps, coord } = make();
    await coord.finalize('release');
    expect(deps.orchestrator.finalizeToBase).toHaveBeenCalledWith('release');
  });

  it('release() removes the worktree and forgets the agent', async () => {
    const { deps, coord } = make();
    await coord.assignWorkingDirectory(cfg());
    await coord.release('a1');
    expect(deps.manager.remove).toHaveBeenCalledTimes(1);
    expect(coord.active()).toHaveLength(0);
  });

  it('release waits for an in-flight merge before removing the worktree (audit #2)', async () => {
    const order: string[] = [];
    let resolveMerge!: () => void;
    const mergePending = new Promise<void>((r) => { resolveMerge = r; });
    const orchestrator = fakeOrchestrator({
      mergeToIntegration: vi.fn(async () => { await mergePending; order.push('merge'); return ok('merged'); }),
    });
    const manager = fakeManager({ remove: vi.fn(async () => { order.push('remove'); }) });
    const { coord } = make({ orchestrator, manager });
    await coord.assignWorkingDirectory(cfg());

    const merging = coord.onTurnComplete('a1', false); // enters the merge chain, blocks mid-merge
    const releasing = coord.release('a1');             // must queue AFTER the merge, not race it
    resolveMerge();
    await Promise.all([merging, releasing]);

    expect(order).toEqual(['merge', 'remove']); // merge finished before the worktree was removed
  });

  it('release prunes the agent branch (audit #1)', async () => {
    const { deps, coord } = make();
    await coord.assignWorkingDirectory(cfg());
    await coord.release('a1');
    expect(deps.manager.remove).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pruneBranch: true }));
  });
});

describe('WorktreeCoordinator.reverify + onChange (A2 review board)', () => {
  const passing = () => vi.fn(async () => ({ status: 'passed' as const, command: 'npm test', output: 'ok' }));

  it('re-runs verify, stores the status, and fires onChange', async () => {
    const { coord } = make({ verify: passing() });
    await coord.assignWorkingDirectory(cfg()); // creates lane for a1
    let fired = 0;
    coord.onChange = () => { fired++; };

    const r = await coord.reverify('a1');
    expect(r?.status).toBe('passed');
    expect(coord.verification('a1')?.status).toBe('passed');
    expect(fired).toBe(1);
  });

  it('flags a passing re-verify that also edited test files (anti-cheat)', async () => {
    const changedFiles = vi.fn(async () => ['src/foo.ts', 'src/__tests__/foo.test.ts']);
    const { coord } = make({ verify: passing(), changedFiles });
    await coord.assignWorkingDirectory(cfg());
    await coord.reverify('a1');
    expect(coord.verification('a1')?.touchedTests).toEqual(['src/__tests__/foo.test.ts']);
  });

  it('reverify is a no-op when verify is not configured', async () => {
    const { coord } = make({}); // no verify dep
    await coord.assignWorkingDirectory(cfg());
    expect(await coord.reverify('a1')).toBeUndefined();
  });
});
