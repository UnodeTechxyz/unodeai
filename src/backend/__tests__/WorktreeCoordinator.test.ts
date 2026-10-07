import { describe, it, expect, vi } from 'vitest';
import { AgentConfig } from '../../types';
import { WorktreeCoordinator, WorktreeCoordinatorDeps, isVerificationTargetFile } from '../WorktreeCoordinator';
import { WorktreeManager, Worktree } from '../WorktreeManager';
import { MergeOrchestrator, MergeResult } from '../MergeOrchestrator';

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
