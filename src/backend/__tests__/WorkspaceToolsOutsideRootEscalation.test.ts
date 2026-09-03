import { describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { CommandApprover, WorkspaceTools } from '../WorkspaceTools';
import { CommandPolicy } from '../CommandPolicy';

/**
 * An out-of-root path in a shell command is a SUSPICION, not a verdict — the same read spelled
 * `..\..\x` walks straight past the detector, so refusing the honest spelling bought no safety while
 * costing real work. The detector now escalates to the human. It must never refuse on its own, and it
 * must never silently allow.
 */
async function toolsWith(
  approver: CommandApprover | undefined,
  mode: 'none' | 'ask' | 'allowlist' | 'all' = 'all', // 'all' → policy alone would allow, without asking
  executor = vi.fn(async () => ({ code: 0, output: 'ran' }))
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-escalate-'));
  const outside = path.join(path.parse(root).root, 'Users', 'me', 'id_rsa');
  const tools = new WorkspaceTools(
    root,
    new Set(['execute']),
    'agent',
    undefined as never,
    new CommandPolicy(mode, []),
    120_000,
    approver,
    undefined,
    undefined,
    executor as never
  );
  return { root, outside, tools, executor };
}

describe('run_command: an out-of-root path escalates to the human, it does not self-refuse', () => {
  it('asks the human — with the reason — even when policy would have allowed it silently', async () => {
    const approve = vi.fn(async () => ({ allow: true }));
    const { root, outside, tools, executor } = await toolsWith(approve);

    const out = await tools.runText('run_command', { command: `type ${outside}` });

    expect(approve).toHaveBeenCalledTimes(1);
    const [command, context] = approve.mock.calls[0] as unknown as [string, { warning?: string; forcePrompt?: boolean }];
    expect(command).toBe(`type ${outside}`);
    expect(context?.forcePrompt).toBe(true);           // a latched template must not skip this prompt
    expect(context?.warning).toContain(outside);       // the human is told what was found
    expect(executor).toHaveBeenCalledTimes(1);         // approved → it actually runs
    expect(out).not.toMatch(/BLOCKED_OUTSIDE_WORKDIR/);

    await fs.rm(root, { recursive: true, force: true });
  });

  it('does not run the command when the human denies, and does not relay their note', async () => {
    const approve = vi.fn(async () => ({ allow: false, note: 'wrong folder' }));
    const { root, outside, tools, executor } = await toolsWith(approve);

    const result = await tools.run('run_command', { command: `type ${outside}` });

    expect(executor).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'refused', reason: 'consent' });
    expect(result.output).not.toContain('wrong folder');
    expect(result.output).not.toContain(outside);

    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses when there is nobody to ask — a heuristic may not allow unattended', async () => {
    const { root, outside, tools, executor } = await toolsWith(undefined);

    const result = await tools.run('run_command', { command: `type ${outside}` });

    expect(result).toMatchObject({ status: 'refused', reason: 'scope' });
    expect(result.output).not.toContain(outside);
    expect(executor).not.toHaveBeenCalled();

    await fs.rm(root, { recursive: true, force: true });
  });

  it('leaves an in-root command alone: no prompt, no warning', async () => {
    const approve = vi.fn(async () => ({ allow: true }));
    const { root, tools, executor } = await toolsWith(approve);

    const out = await tools.runText('run_command', { command: 'git status' });

    expect(approve).not.toHaveBeenCalled(); // policy 'all' allows; nothing to escalate
    expect(executor).toHaveBeenCalledTimes(1);
    expect(out).toContain('ran');

    await fs.rm(root, { recursive: true, force: true });
  });

  it('does not escalate on a URL — the regression that started this', async () => {
    const approve = vi.fn(async () => ({ allow: true }));
    const { root, tools, executor } = await toolsWith(approve);

    const out = await tools.runText('run_command', { command: 'git remote add org https://github.com/SilentDataAI/SilentData.git' });

    expect(approve).not.toHaveBeenCalled();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(out).not.toMatch(/BLOCKED_OUTSIDE_WORKDIR/);

    await fs.rm(root, { recursive: true, force: true });
  });
});

// Escalation adds a PROMPT to a command policy would permit. It must never become a route to a prompt for
// something policy REFUSES -- otherwise appending an out-of-root path to `rm -rf` turns an always-blocked
// catastrophic pattern into one click. (This regressed while the escalation was first written.)
describe('escalation never bypasses a policy denial', () => {
  const alwaysAllow = () => vi.fn(async () => ({ allow: true }));

  it('mode=none: an outside path does not become a runnable prompt', async () => {
    const { root, outside, tools, executor } = await toolsWith(alwaysAllow(), 'none');
    const result = await tools.run('run_command', { command: `type ${outside}` });
    expect(executor).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'refused', reason: 'capability' });
    await fs.rm(root, { recursive: true, force: true });
  });

  it('a catastrophic pattern stays blocked even when the user clicks Allow', async () => {
    const { root, outside, tools, executor } = await toolsWith(alwaysAllow(), 'ask');
    const result = await tools.run('run_command', { command: `rm -rf ${outside}` });
    expect(executor).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'refused', reason: 'capability' });
    await fs.rm(root, { recursive: true, force: true });
  });

  it('mode=allowlist: a non-allowlisted command with an outside path stays blocked', async () => {
    const { root, outside, tools, executor } = await toolsWith(alwaysAllow(), 'allowlist');
    const result = await tools.run('run_command', { command: `type ${outside}` });
    expect(executor).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'refused', reason: 'capability' });
    await fs.rm(root, { recursive: true, force: true });
  });
});
