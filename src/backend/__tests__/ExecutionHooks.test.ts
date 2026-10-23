import { describe, expect, it } from 'vitest';
import {
  constructApprovedExecutionHooks,
  HostExecutionHooks,
  normalizeExecutionHookCandidate,
  type ExecutionHookAction,
} from '../ExecutionHooks';

const declaration = (id: string, point: 'PreTool' | 'PostWrite' | 'EndTurn' | 'on-failure', extra: Record<string, unknown> = {}) => ({
  id,
  point,
  appliedBy: 'human',
  timeoutMs: 50,
  maxOutputBytes: 64,
  onFailure: 'block',
  ...extra,
});

describe('host execution hooks', () => {
  it('fires each declared point once and nowhere outside its declaration', async () => {
    const fired: string[] = [];
    const actions = new Map<string, ExecutionHookAction>([
      ['pre', (ctx) => { fired.push(ctx.point); return { output: 'ok' }; }],
      ['post', (ctx) => { fired.push(ctx.point); return { output: 'ok' }; }],
      ['end', (ctx) => { fired.push(ctx.point); return { output: 'ok' }; }],
      ['failure', (ctx) => { fired.push(ctx.point); return { output: 'ok' }; }],
    ]);
    const hooks = new HostExecutionHooks([
      declaration('pre', 'PreTool'), declaration('post', 'PostWrite'),
      declaration('end', 'EndTurn'), declaration('failure', 'on-failure'),
    ], actions);

    await hooks.run('PreTool', { toolName: 'read_file' });
    await hooks.run('PostWrite', { writtenPath: 'src/a.ts' });
    await hooks.run('EndTurn');
    await hooks.run('on-failure', { failure: 'blocked' });
    await hooks.run('PreTool', { toolName: 'read_file' });

    expect(fired).toEqual(['PreTool', 'PostWrite', 'EndTurn', 'on-failure', 'PreTool']);
  });

  it('fails closed on a time ceiling, output ceiling, unreadable action, or explicit restriction', async () => {
    const slow = new HostExecutionHooks([declaration('slow', 'PreTool', { timeoutMs: 5 })], new Map([
      ['slow', async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { output: 'late' }; }],
    ]));
    await expect(slow.run('PreTool')).resolves.toMatchObject({ allow: false });

    const large = new HostExecutionHooks([declaration('large', 'EndTurn', { maxOutputBytes: 1 })], new Map([
      ['large', () => ({ output: 'too large' })],
    ]));
    await expect(large.run('EndTurn')).resolves.toMatchObject({ allow: false });

    const unreadable = new HostExecutionHooks([declaration('missing', 'PostWrite')]);
    await expect(unreadable.run('PostWrite')).resolves.toMatchObject({ allow: false });
  });

  it('refuses authority grants and agent-authored guardrails by name', () => {
    for (const authority of ['command', 'writeScope', 'networkDestination', 'mcpServer']) {
      expect(() => new HostExecutionHooks([declaration('bad', 'PreTool', { [authority]: 'allow' })]))
        .toThrow(/authority/i);
    }
    expect(() => new HostExecutionHooks([declaration('agent-edit', 'EndTurn', { appliedBy: 'agent' })]))
      .toThrow(/human application/i);
  });

  it('requires every decorative-looking ceiling instead of silently defaulting it', () => {
    const noTime = declaration('no-time', 'PreTool');
    delete noTime.timeoutMs;
    expect(() => new HostExecutionHooks([noTime])).toThrow(/time ceiling/i);
    const noOutput = declaration('no-output', 'PreTool');
    delete noOutput.maxOutputBytes;
    expect(() => new HostExecutionHooks([noOutput])).toThrow(/output ceiling/i);
  });

  it('keeps a workspace setting inert until the exact normalized declaration and origin are explicitly approved', async () => {
    // This is the production construction path used by extension.ts. Treating `workspace` as a candidate
    // here models a repository .vscode/settings.json: it receives no authority merely by being present.
    const suppliedByWorkspace = normalizeExecutionHookCandidate([declaration('repository-candidate', 'PreTool')]);
    expect(constructApprovedExecutionHooks(suppliedByWorkspace, undefined, 'workspace')).toBeUndefined();

    const approved = constructApprovedExecutionHooks(
      suppliedByWorkspace,
      { version: 1, digest: suppliedByWorkspace.digest, origin: 'workspace' },
      'workspace',
    );
    expect(approved).toBeInstanceOf(HostExecutionHooks);
    // No declaration can grant an action: an unknown host action is a restrictive, fail-closed block.
    await expect(approved!.run('PreTool', { toolName: 'run_command' })).resolves.toMatchObject({ allow: false });

    const editedAfterApproval = normalizeExecutionHookCandidate([
      declaration('repository-candidate', 'PreTool', { timeoutMs: 499 }),
    ]);
    expect(constructApprovedExecutionHooks(
      editedAfterApproval,
      { version: 1, digest: suppliedByWorkspace.digest, origin: 'workspace' },
      'workspace',
    )).toBeUndefined();
    expect(constructApprovedExecutionHooks(
      suppliedByWorkspace,
      { version: 1, digest: suppliedByWorkspace.digest, origin: 'workspace' },
      'global',
    )).toBeUndefined();
  });

  it('refuses an invalid candidate rather than silently dropping a protection the user may expect', () => {
    expect(() => normalizeExecutionHookCandidate([
      declaration('attempted-grant', 'PreTool', { command: 'npm test' }),
    ])).toThrow(/authority/i);
  });
});
