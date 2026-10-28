import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { CompletionPolicyVerifier } from '../CompletionPolicyVerifier';
import { CommandPolicy } from '../CommandPolicy';
import { resolveCompletionVerificationPolicy } from '../CompletionVerificationPolicy';
import type { CompletionVerificationCheckOptions } from '../CompletionVerificationCheck';
import type { CommandExecResult } from '../CommandExecution';
import { CMD_SHELL } from './shellFixtures';
import { WorktreeCoordinator } from '../WorktreeCoordinator';
import type { WorktreeManager } from '../WorktreeManager';
import type { MergeOrchestrator } from '../MergeOrchestrator';
import type { AgentConfig } from '../../types';

function fixture() {
  const cwd = path.join(tmpdir(), 'unode-policy-worktree');
  const resolution = resolveCompletionVerificationPolicy({ workspaceId: 'workspace-A', agentSkills: [],
    completionVerification: { mode: 'command', command: 'npm test' }, readLegacyGlobalCommand: () => undefined });
  const execute = vi.fn(async (): Promise<CommandExecResult> => ({ status: 'exited', code: 0, output: 'observed' }));
  const options: Omit<CompletionVerificationCheckOptions, 'cwd' | 'requestApproval'> = {
    resolution, roots: [cwd], request: { kind: 'workflow', runId: 'run-A' }, signal: new AbortController().signal,
    currentResolution: () => resolution, isCurrentRequest: () => true, isTrusted: () => true,
    directoryAllowed: candidate => candidate === cwd, commandPolicy: () => new CommandPolicy('all'),
    prepare: () => ({ ok: true, shell: CMD_SHELL, execute, startBackground: () => { throw new Error('unused'); } }),
    readers: { manifest: async () => ({ kind: 'read', scripts: { test: 'tests' } }), packageManager: async () => 'npm' },
  };
  const optionsFor = vi.fn(() => options);
  return { cwd, execute, options, optionsFor, verifier: new CompletionPolicyVerifier(optionsFor) };
}

describe('policy-aware unattended verifier adapter', () => {
  it('executes at the actual worktree cwd and retains the typed observed pass', async () => {
    const h = fixture();
    expect(await h.verifier.verify(h.cwd)).toMatchObject({ status: 'passed', check: { kind: 'passed', exitCode: 0 } });
    expect(h.optionsFor).toHaveBeenCalledWith(h.cwd);
    expect(h.execute).toHaveBeenCalledWith('npm test', expect.objectContaining({ cwd: h.cwd }));
  });

  it.each(['ask', 'none', 'missing', 'untrusted', 'stale', 'missing-manifest', 'disabled'] as const)(
    '%s never executes and cannot become merge evidence', async mode => {
      const h = fixture();
      if (mode === 'ask' || mode === 'none') h.options.commandPolicy = () => new CommandPolicy(mode);
      if (mode === 'missing') h.options.commandPolicy = () => undefined;
      if (mode === 'untrusted') h.options.isTrusted = () => false;
      if (mode === 'stale') h.options.isCurrentRequest = () => false;
      if (mode === 'missing-manifest') h.options.readers!.manifest = async () => ({ kind: 'manifest-missing' });
      if (mode === 'disabled') h.options.resolution = resolveCompletionVerificationPolicy({ workspaceId: 'workspace-A',
        agentSkills: [], completionVerification: { mode: 'disabled' }, readLegacyGlobalCommand: () => undefined });
      expect(await h.verifier.verify(h.cwd)).toMatchObject({ status: 'skipped', blocked: true, check: { kind: 'not-run' } });
      expect(h.execute).not.toHaveBeenCalled();
    },
  );

  it('retains real failure separately from unconfirmed termination', async () => {
    const h = fixture();
    h.execute.mockResolvedValueOnce({ status: 'exited', code: 1, output: 'real test failure' });
    expect(await h.verifier.verify(h.cwd)).toMatchObject({ status: 'failed', check: { kind: 'failed', reason: 'exit-nonzero' } });
    h.execute.mockResolvedValueOnce({ status: 'outcome-unknown', code: null, reason: 'stop-unconfirmed', output: 'still running' });
    expect(await h.verifier.verify(h.cwd)).toMatchObject({ status: 'failed', blocked: true, check: { kind: 'outcome-unknown' } });
  });

  it('cannot take a caller-supplied alternate cwd through the option object', async () => {
    const h = fixture();
    Object.assign(h.options, { cwd: path.join(tmpdir(), 'wrong-cwd') });
    await h.verifier.verify(h.cwd);
    expect(h.execute).toHaveBeenCalledWith('npm test', expect.objectContaining({ cwd: h.cwd }));
  });

  it('strips an approval callback carried by the runtime options object', async () => {
    const h = fixture();
    h.options.commandPolicy = () => new CommandPolicy('ask');
    const requestApproval = vi.fn(async () => ({ allow: true }));
    Object.assign(h.options, { requestApproval });
    expect(await h.verifier.verify(h.cwd)).toMatchObject({
      status: 'skipped', blocked: true, check: { kind: 'not-run', reason: 'approval-required' },
    });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'unknown', 'passed'] as const)('the existing merge consumer holds %s to its observed result', async mode => {
    const h = fixture();
    if (mode === 'blocked') h.options.commandPolicy = () => new CommandPolicy('ask');
    if (mode === 'unknown') h.execute.mockResolvedValue({ status: 'outcome-unknown', code: null,
      reason: 'stop-unconfirmed', output: 'unconfirmed' });
    const merge = vi.fn(async () => ({ status: 'merged' as const, branch: 'worker', integrationBranch: 'integration', message: 'merged' }));
    const notifyAgent = vi.fn();
    const coordinator = new WorktreeCoordinator({
      manager: {
        isGitRepo: async () => true, isClean: async () => true, list: async () => [],
        create: async () => ({ path: h.cwd, branch: 'worker', agentId: 'dev' }),
      } as unknown as WorktreeManager,
      orchestrator: { commitWorktree: async () => true, mergeToIntegration: merge } as unknown as MergeOrchestrator,
      isEnabled: () => true, autoMerge: () => false, maxParallel: () => 1, isEligible: () => true,
      log: () => undefined, notifyAgent, verify: cwd => h.verifier.verify(cwd),
    });
    await coordinator.assignWorkingDirectory({ id: 'dev', name: 'Dev', role: 'developer' } as AgentConfig);
    await coordinator.onTurnComplete('dev', false);
    expect(merge).toHaveBeenCalledTimes(mode === 'passed' ? 1 : 0);
    expect(coordinator.verification('dev')?.status).toBe(mode === 'passed' ? 'passed' : mode === 'blocked' ? 'skipped' : 'failed');
    if (mode !== 'passed') {
      expect(notifyAgent).toHaveBeenCalledWith('dev', expect.stringContaining('work is safe'));
      expect(notifyAgent.mock.calls[0][1]).not.toContain('Fix the CODE');
      expect(notifyAgent.mock.calls[0][1]).not.toContain('``');
    }
  });
});
