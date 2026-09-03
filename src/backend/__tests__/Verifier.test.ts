import { beforeEach, describe, it, expect } from 'vitest';
import { Verifier } from '../Verifier';
import { CommandPolicy } from '../CommandPolicy';
import { resetShellCommandGateWarningsForTest } from '../ShellCommandGate';

describe('Verifier (v0.7.0 verifier-as-gate)', () => {
  beforeEach(() => {
    resetShellCommandGateWarningsForTest();
  });

  it('passes on exit 0', async () => {
    const v = new Verifier({ command: () => 'npm test', run: async () => ({ code: 0, output: 'all green' }) });
    expect(await v.verify('/x')).toMatchObject({ status: 'passed', command: 'npm test' });
  });

  it('fails on a non-zero exit and keeps the output for feedback', async () => {
    const v = new Verifier({ command: () => 'npm test', run: async () => ({ code: 1, output: '2 tests failing: boom' }) });
    const r = await v.verify('/x');
    expect(r.status).toBe('failed');
    expect(r.output).toContain('boom');
  });

  it('skips (and never runs) when no command is configured — NOT flagged blocked (nothing to gate on)', async () => {
    let ran = false;
    const v = new Verifier({ command: () => '   ', run: async () => { ran = true; return { code: 0, output: '' }; } });
    const r = await v.verify('/x');
    expect(r.status).toBe('skipped');
    expect(r.blocked).toBeFalsy(); // no command ⇒ legit skip; merges proceed
    expect(ran).toBe(false);
  });

  it('marks a policy-BLOCKED command as blocked (a configured command that cannot run must not merge as passed)', async () => {
    let ran = false;
    const v = new Verifier({
      command: () => 'npm test',
      run: async () => { ran = true; return { code: 0, output: '' }; },
      commandPolicy: new CommandPolicy('none', []), // execution disabled → hard block
    });
    const r = await v.verify('/x');
    expect(r.status).toBe('skipped');
    expect(r.blocked).toBe(true); // distinct from no-command skip → WorktreeCoordinator holds the merge
    expect(ran).toBe(false);
  });

  it('skips (does NOT auto-run) a command awaiting approval in "ask" mode — respects unode.commandApproval', async () => {
    let ran = false;
    const v = new Verifier({
      command: () => 'make check',
      run: async () => { ran = true; return { code: 0, output: '' }; },
      commandPolicy: new CommandPolicy('ask', []), // 'make check' not allowlisted → { allowed:false, ask:true }
    });
    const r = await v.verify('/x');
    expect(r.status).toBe('skipped');
    expect(r.output).toMatch(/approv/i);
    expect(ran).toBe(false); // the bug: it used to run on ask:true
  });

  it('still runs an allowlisted command in "ask" mode (the common npm test case keeps gating)', async () => {
    const v = new Verifier({
      command: () => 'npm test',
      run: async () => ({ code: 0, output: 'ok' }),
      commandPolicy: new CommandPolicy('ask', ['npm test']),
    });
    expect((await v.verify('/x')).status).toBe('passed');
  });

  it('runs a config verify command with an outside path but warns once', async () => {
    const root = process.platform === 'win32' ? 'C:\\repo' : '/repo';
    const outside = process.platform === 'win32' ? 'C:\\outside\\tool.cmd' : '/outside/tool';
    const command = `type ${outside}`;
    const runs: string[] = [];
    const warnings: string[] = [];
    const v = new Verifier({
      command: () => command,
      commandPolicy: new CommandPolicy('all', []),
      onConfigOutsideRoot: (message) => warnings.push(message),
      run: async (cmd) => { runs.push(cmd); return { code: 0, output: 'ok' }; },
    });

    expect((await v.verify(root)).status).toBe('passed');
    expect((await v.verify(root)).status).toBe('passed');

    expect(runs).toEqual([command, command]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(outside);
  });

  it('treats a timed-out run (code: null) as failed, not passed', async () => {
    const v = new Verifier({ command: () => 'npm test', run: async () => ({ code: null, output: '[verify timed out]' }) });
    const r = await v.verify('/x');
    expect(r.status).toBe('failed');
    expect(r.output).toContain('timed out');
  });

  it('runs the command in the given working directory', async () => {
    let seenCwd = '';
    const v = new Verifier({ command: () => 'npm test', run: async (_cmd, cwd) => { seenCwd = cwd; return { code: 0, output: '' }; } });
    await v.verify('/work/tree-a');
    expect(seenCwd).toBe('/work/tree-a');
  });
});
