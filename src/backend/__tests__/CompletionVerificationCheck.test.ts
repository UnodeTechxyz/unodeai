import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { CommandPolicy, type CommandApprovalMode } from '../CommandPolicy';
import { AgentCommandPolicy } from '../AgentCommandPolicy';
import type { CommandExecResult, PreparedDirectCommand } from '../CommandExecution';
import type { CommandApprovalDecision } from '../ShellCommandGate';
import { resolveCompletionVerificationPolicy, type VerificationPolicyResolution } from '../CompletionVerificationPolicy';
import { prepareCompletionVerificationCheck, verificationUsesRepairBudget, type CompletionVerificationCheckOptions } from '../CompletionVerificationCheck';
import type { VerificationAdmissionReaders } from '../CompletionVerificationAdmission';

function resolution(policy: unknown = { mode: 'command', command: 'npm test' }, source: 'team' | 'global' | 'auto' = 'team'): VerificationPolicyResolution {
  return resolveCompletionVerificationPolicy({ workspaceId: 'workspace-A', agentSkills: [],
    completionVerification: source === 'team' ? policy : undefined,
    readLegacyGlobalCommand: () => source === 'global' ? 'npm test' : undefined });
}

function harness(mode: CommandApprovalMode = 'ask') {
  const abort = new AbortController();
  const cwd = path.join(tmpdir(), 'unode-check-kernel');
  let current = resolution();
  let trusted = true;
  let allowed = true;
  let active = true;
  let policy: CommandPolicy | undefined = new CommandPolicy(mode);
  let result: CommandExecResult = { status: 'exited', code: 0, output: 'checked' };
  const execute = vi.fn(async () => result);
  const shell = { kind: 'cmd' as const, grammar: 'cmd' as const, label: 'cmd.exe', source: 'direct-fallback' as const, fingerprint: 'test-shell-A' };
  const prepared: PreparedDirectCommand = { ok: true, shell, execute, startBackground: () => { throw new Error('not used'); } };
  const approval = vi.fn(async (): Promise<CommandApprovalDecision> => ({ allow: true }));
  const readers = { manifest: vi.fn<VerificationAdmissionReaders['manifest']>(async () => ({ kind: 'read', scripts: { test: 'test' } })), packageManager: async () => 'npm' };
  const options: CompletionVerificationCheckOptions = {
    resolution: current, cwd, roots: [cwd], signal: abort.signal,
    request: { kind: 'session', sessionId: 'session-A', requestId: 'request-A', attemptId: 'attempt-A' },
    currentResolution: () => current, isCurrentRequest: () => active,
    isTrusted: () => trusted, directoryAllowed: () => allowed, commandPolicy: () => policy,
    prepare: vi.fn(() => prepared), requestApproval: approval, readers,
  };
  return {
    options, abort, execute, approval, readers, shell,
    create: () => prepareCompletionVerificationCheck(options),
    policy: (value: CommandPolicy | undefined) => { policy = value; },
    current: (value: VerificationPolicyResolution) => { current = value; },
    active: (value: boolean) => { active = value; },
    trusted: (value: boolean) => { trusted = value; },
    allowed: (value: boolean) => { allowed = value; },
    result: (value: CommandExecResult) => { result = value; },
  };
}

describe('typed completion check and private one-shot approval', () => {
  it('asks once for the exact prepared shell/command/cwd/source, rechecks and runs once', async () => {
    const h = harness(); const check = h.create();
    expect(await check.run()).toMatchObject({ kind: 'passed', exitCode: 0, command: 'npm test', source: 'team-document' });
    expect(h.approval).toHaveBeenCalledTimes(1);
    expect(h.approval).toHaveBeenCalledWith('npm test', expect.objectContaining({
      shell: h.shell, warning: expect.stringContaining(h.options.cwd), signal: h.abort.signal,
    }));
    expect(h.execute).toHaveBeenCalledWith('npm test', expect.objectContaining({ cwd: h.options.cwd, signal: h.abort.signal }));
    expect(await check.run()).toMatchObject({ kind: 'not-run', reason: 'policy-stale' });
    expect(h.execute).toHaveBeenCalledTimes(1);
    // A new run cannot reuse the consumed receipt. With no human channel, it refuses under ask.
    h.options.requestApproval = undefined;
    expect(await h.create().run()).toMatchObject({ kind: 'not-run', reason: 'approval-required' });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('consumes synchronously under concurrent reuse', async () => {
    const h = harness(); const check = h.create();
    const results = await Promise.all([check.run(), check.run()]);
    expect(results.map(r => r.kind).sort()).toEqual(['not-run', 'passed']);
    expect(h.approval).toHaveBeenCalledTimes(1); expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it.each(['team', 'global', 'auto'] as const)('no policy / none / unattended ask blocks source %s', async source => {
    for (const mode of ['none', 'ask', 'missing'] as const) {
      const h = harness(mode === 'missing' ? 'all' : mode);
      const state = resolution(undefined, source);
      h.options.resolution = state; h.current(state);
      if (mode === 'missing') h.policy(undefined);
      h.options.requestApproval = undefined;
      expect((await h.create().run()).kind).toBe('not-run');
      expect(h.execute).not.toHaveBeenCalled();
    }
  });

  it.each(['all', 'allowlist', 'ask'] as const)('existing current permission can allow %s without prompting', async mode => {
    const h = harness(); h.policy(new CommandPolicy(mode, ['npm test']));
    expect((await h.create().run()).kind).toBe('passed');
    expect(h.approval).not.toHaveBeenCalled();
  });

  it('applies the supplied live agent narrowing, never widens a global hard denial', async () => {
    const h = harness(); const global = new CommandPolicy('all');
    h.policy(new AgentCommandPolicy(global, { approvalMode: 'none', allowedCommands: [] }, 'delegate'));
    expect(await h.create().run()).toMatchObject({ kind: 'not-run', reason: 'policy-blocked' });
    expect(h.execute).not.toHaveBeenCalled(); expect(h.approval).not.toHaveBeenCalled();
  });

  it.each(['trust', 'scope', 'request', 'signal', 'policy'] as const)('refuses %s revoked while approval is waiting', async what => {
    const h = harness();
    h.approval.mockImplementation(async () => {
      if (what === 'trust') h.trusted(false);
      if (what === 'scope') h.allowed(false);
      if (what === 'request') h.active(false);
      if (what === 'signal') h.abort.abort();
      if (what === 'policy') h.policy(new CommandPolicy('none'));
      return { allow: true };
    });
    expect((await h.create().run()).kind).toBe('not-run'); expect(h.execute).not.toHaveBeenCalled();
  });

  it('refuses a hard denial first observed after the second gate, immediately before execution', async () => {
    const h = harness();
    const policy = new CommandPolicy('none');
    // Both real gates see ask and consume this invocation's single human approval.
    // Only the final synchronous check sees Commands=none; an earlier refusal cannot satisfy this test.
    const check = vi.spyOn(policy, 'check')
      .mockReturnValueOnce({ allowed: false, ask: true, reason: 'awaiting user approval' })
      .mockReturnValueOnce({ allowed: false, ask: true, reason: 'awaiting user approval' });
    h.policy(policy);

    expect(await h.create().run()).toMatchObject({
      kind: 'not-run', reason: 'policy-blocked',
      detail: 'Current command permission does not authorize this check.',
    });
    expect(check).toHaveBeenCalledTimes(3);
    for (const call of check.mock.calls) expect(call).toEqual(['npm test', { shell: h.shell }]);
    expect(h.approval).toHaveBeenCalledTimes(1);
    expect(h.readers.manifest).toHaveBeenCalledTimes(2);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('requires approval first requested after the second gate, with no consumed receipt', async () => {
    const h = harness();
    const policy = new CommandPolicy('ask');
    const check = vi.spyOn(policy, 'check')
      .mockReturnValueOnce({ allowed: true })
      .mockReturnValueOnce({ allowed: true });
    h.policy(policy);

    expect(await h.create().run()).toMatchObject({
      kind: 'not-run', reason: 'approval-required',
      detail: 'Current command permission does not authorize this check.',
    });
    expect(check).toHaveBeenCalledTimes(3);
    expect(h.readers.manifest).toHaveBeenCalledTimes(2);
    expect(h.approval).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each(['command', 'source', 'teamKind', 'workspace'] as const)('rejects a changed %s after preparation', async field => {
    const h = harness(); const next = structuredClone(h.options.resolution);
    if (next.kind !== 'resolved') throw new Error('fixture');
    if (field === 'command') { next.effective.binding.policyDigest = 'changed'; next.effective.policy = { mode: 'command', command: 'npm run lint' }; }
    if (field === 'source') { next.effective.binding.source = 'legacy-global'; next.effective.source = 'legacy-global'; }
    if (field === 'teamKind') { next.effective.binding.teamKind = 'knowledge'; next.effective.teamKind = 'knowledge'; }
    if (field === 'workspace') next.effective.binding.workspaceId = 'workspace-B';
    h.approval.mockImplementation(async () => { h.current(next); return { allow: true }; });
    expect((await h.create().run()).kind).toBe('not-run'); expect(h.execute).not.toHaveBeenCalled();
  });

  it('A→B→A cannot revive an abandoned request even with identical policy bytes', async () => {
    const h = harness();
    h.approval.mockImplementation(async () => { h.current(resolution({ mode: 'disabled' })); h.active(false); h.current(resolution()); return { allow: true }; });
    expect((await h.create().run()).kind).toBe('not-run'); expect(h.execute).not.toHaveBeenCalled();
  });

  it('unrelated roster/MCP changes with the same binding do not invalidate a live request', async () => {
    const h = harness();
    h.approval.mockImplementation(async () => { h.current(structuredClone(h.options.resolution)); return { allow: true }; });
    expect((await h.create().run()).kind).toBe('passed');
  });

  it('does not bind to caller mutation of a captured request or policy snapshot', async () => {
    const h = harness(); const check = h.create();
    h.options.request = { kind: 'session', sessionId: 'new', requestId: 'new' };
    if (h.options.resolution.kind !== 'resolved') throw new Error('fixture');
    h.options.resolution.effective.binding.policyDigest = 'mutated';
    expect((await check.run()).kind).toBe('not-run'); expect(h.execute).not.toHaveBeenCalled();
  });

  it('refuses changed applicability after an approval wait', async () => {
    const h = harness(); h.readers.manifest.mockResolvedValueOnce({ kind: 'read', scripts: { test: 'test' } })
      .mockResolvedValueOnce({ kind: 'read', scripts: {} });
    expect(await h.create().run()).toMatchObject({ kind: 'not-run', reason: 'not-applicable' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('the receipt does not transfer to another command, cwd or shell', async () => {
    const h = harness(); await h.create().run();
    h.options.requestApproval = undefined;
    h.options.cwd = path.join(h.options.cwd, 'other');
    h.shell.fingerprint = 'shell-B';
    const next = resolution({ mode: 'command', command: 'npm run lint' }); h.options.resolution = next; h.current(next);
    h.readers.manifest.mockResolvedValue({ kind: 'read', scripts: { lint: 'lint' } });
    expect((await h.create().run()).kind).toBe('not-run'); expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it.each([{ allow: false }, { allow: false, withdrawn: true }])('does not execute after refusal %j', async decision => {
    const h = harness(); h.approval.mockResolvedValue(decision);
    expect((await h.create().run()).kind).toBe('not-run'); expect(h.execute).not.toHaveBeenCalled();
  });

  it('disabled and invalid never prepare a command or ask for approval', async () => {
    for (const policy of [{ mode: 'disabled' }, { mode: 'Auto' }]) {
      const h = harness(); const state = resolution(policy); h.options.resolution = state; h.current(state);
      expect((await h.create().run()).kind).toBe('not-run');
      expect(h.options.prepare).not.toHaveBeenCalled(); expect(h.approval).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['NUL', 'private-token\0', 'NUL'],
    ['newline only', '\n', 'CR or LF'],
    ['too many bytes', 'private-token' + 'é'.repeat(1025), '2,048 UTF-8 bytes'],
    ['wrong type', { token: 'private-token' }, 'must be a string'],
  ] as const)('explains legacy %s without revealing its contents, running or consuming repair budget', async (_name, raw, explanation) => {
    const h = harness('all');
    const state = resolveCompletionVerificationPolicy({
      workspaceId: 'workspace-A', agentSkills: [], readLegacyGlobalCommand: () => raw,
    });
    h.options.resolution = state; h.current(state);
    const outcome = await h.create().run();
    expect(outcome).toMatchObject({ kind: 'not-run', reason: 'configuration-invalid', source: 'legacy-global' });
    if (outcome.kind !== 'not-run') throw new Error('fixture');
    expect(outcome.detail).toContain(explanation);
    expect(outcome.detail).toContain('User Settings');
    expect(outcome.detail).toContain('unode.verifyCommand');
    expect(JSON.stringify(outcome)).not.toContain('private-token');
    expect(verificationUsesRepairBudget(outcome)).toBe(false);
    expect(h.execute).not.toHaveBeenCalled(); expect(h.approval).not.toHaveBeenCalled();
    expect(h.options.prepare).not.toHaveBeenCalled(); expect(h.readers.manifest).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'exited', code: 0, output: '' }, 'passed', false],
    [{ status: 'exited', code: 1, output: '' }, 'failed', true],
    [{ status: 'exited', code: null, output: '' }, 'outcome-unknown', false],
    [{ status: 'timed-out', code: null, stopConfirmed: true, output: '' }, 'failed', true],
    [{ status: 'not-started', code: null, reason: 'spawn-failed', output: '' }, 'not-run', false],
    [{ status: 'outcome-unknown', code: null, reason: 'stop-unconfirmed', output: '' }, 'outcome-unknown', false],
  ] as const)('maps real executor status %j without inventing a successful sensor', async (result, kind, budget) => {
    const h = harness('all'); h.result(result);
    const outcome = await h.create().run();
    expect(outcome.kind).toBe(kind); expect(verificationUsesRepairBudget(outcome)).toBe(budget);
  });

  it('binds host workflow checks to the existing workflow run, never a fabricated agent session', async () => {
    const h = harness();
    h.options.request = { kind: 'workflow', runId: 'existing-workflow-A' };
    const current = vi.fn(() => true); h.options.isCurrentRequest = current;
    expect((await h.create().run()).kind).toBe('passed');
    expect(current).toHaveBeenCalledWith({ kind: 'workflow', runId: 'existing-workflow-A' });
    h.approval.mockImplementation(async () => { current.mockReturnValue(false); return { allow: true }; });
    expect((await h.create().run()).kind).toBe('not-run'); expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('unexpected executor rejection is unknown, never proof of zero effects or implementation failure', async () => {
    const h = harness('all'); h.execute.mockRejectedValue(new Error('unknown'));
    expect(await h.create().run()).toMatchObject({ kind: 'outcome-unknown' });
  });
});
