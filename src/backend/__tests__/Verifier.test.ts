import { beforeEach, describe, it, expect } from 'vitest';
import { Verifier } from '../Verifier';
import { CommandPolicy } from '../CommandPolicy';
import { resetShellCommandGateWarningsForTest } from '../ShellCommandGate';
import { CMD_SHELL, directPreparer } from './shellFixtures';

describe('Verifier (v0.7.0 verifier-as-gate)', () => {
  beforeEach(() => {
    resetShellCommandGateWarningsForTest();
  });

  it('passes on exit 0', async () => {
    const v = new Verifier({ command: () => 'npm test', prepare: directPreparer(async () => ({ code: 0, output: 'all green' })) });
    expect(await v.verify('/x')).toMatchObject({ status: 'passed', command: 'npm test' });
  });

  it('fails on a non-zero exit and keeps the output for feedback', async () => {
    const v = new Verifier({ command: () => 'npm test', prepare: directPreparer(async () => ({ code: 1, output: '2 tests failing: boom' })) });
    const r = await v.verify('/x');
    expect(r.status).toBe('failed');
    expect(r.output).toContain('boom');
  });

  it('skips (and never runs) when no command is configured — NOT flagged blocked (nothing to gate on)', async () => {
    let ran = false;
    const v = new Verifier({ command: () => '   ', prepare: directPreparer(async () => { ran = true; return { code: 0, output: '' }; }) });
    const r = await v.verify('/x');
    expect(r.status).toBe('skipped');
    expect(r.blocked).toBeFalsy(); // no command ⇒ legit skip; merges proceed
    expect(ran).toBe(false);
  });

  it('marks a policy-BLOCKED command as blocked (a configured command that cannot run must not merge as passed)', async () => {
    let ran = false;
    const v = new Verifier({
      command: () => 'npm test',
      prepare: directPreparer(async () => { ran = true; return { code: 0, output: '' }; }),
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
      prepare: directPreparer(async () => { ran = true; return { code: 0, output: '' }; }),
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
      prepare: directPreparer(async () => ({ code: 0, output: 'ok' })),
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
      prepare: directPreparer(async (cmd) => { runs.push(cmd); return { code: 0, output: 'ok' }; }),
    });

    expect((await v.verify(root)).status).toBe('passed');
    expect((await v.verify(root)).status).toBe('passed');

    expect(runs).toEqual([command, command]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(outside);
  });

  it('treats a timed-out run as failed, not passed, and says its process tree was stopped', async () => {
    const v = new Verifier({ command: () => 'npm test', timeoutMs: () => 30_000, prepare: directPreparer(async () => ({ code: null, output: 'partial', timedOut: true })) });
    const r = await v.verify('/x');
    expect(r.status).toBe('failed');
    expect(r.output).toBe('partial\n[verify timed out after 30s and its process tree was stopped — ensure unode.verifyCommand exits (e.g. not a watch mode) and doesn\'t wait for input]');
  });

  it('a run with no exit observed is never a pass: it fails and holds the merge (v0.9.96)', async () => {
    const v = new Verifier({
      command: () => 'npm test',
      prepare: directPreparer(async () => ({ status: 'outcome-unknown', code: null, reason: 'stop-unconfirmed', output: 'may still run' })),
    });
    expect(await v.verify('/x')).toEqual({ status: 'failed', command: 'npm test', output: 'may still run', blocked: true });
  });

  it('gates and runs ONE preparation of the declared direct shell, and names its grammar in the remedy (v0.9.96)', async () => {
    const policy = new CommandPolicy('ask', []);
    const checked: string[] = [];
    const original = policy.check.bind(policy);
    policy.check = (command, options) => { checked.push(options.shell.fingerprint); return original(command, options); };
    const prepare = directPreparer(async () => ({ code: 0, output: '' }), CMD_SHELL);
    const blocked = await new Verifier({ command: () => 'make check', prepare, commandPolicy: policy }).verify('/x');
    expect(blocked.output).toBe('Verify command "make check" needs approval and the gate can\'t prompt during a merge. It runs in cmd.exe (cmd grammar). Approve the same command once through coordinator run_checks, which runs in that shell, or add it to "unode.allowedCommands", before relying on this gate.');
    expect(prepare.prepared).toBe(1);
    expect(checked).toEqual([CMD_SHELL.fingerprint]);

    const allowed = new CommandPolicy('ask', { configured: [], project: [{ grammar: 'cmd', template: 'npm test' }] });
    const ran = directPreparer(async () => ({ code: 0, output: '' }), CMD_SHELL);
    expect((await new Verifier({ command: () => 'npm test', prepare: ran, commandPolicy: allowed, maxOutputChars: 4000 }).verify('/x')).status).toBe('passed');
    expect(ran.prepared).toBe(1);
    expect(ran.runs).toEqual([{ command: 'npm test', cwd: '/x', timeoutMs: 300_000, maxOutputChars: 4000 }]);
  });

  it('fails and holds the merge when the direct shell cannot be prepared, and runs nothing (v0.9.96)', async () => {
    const v = new Verifier({
      command: () => 'npm test',
      prepare: () => ({ ok: false, reason: 'shell-compatibility', message: 'Verification skipped: this workspace is not trusted.' }),
    });
    expect(await v.verify('/x')).toEqual({ status: 'failed', command: 'npm test', output: 'Verification skipped: this workspace is not trusted.', blocked: true });
  });

  it('runs the command in the given working directory', async () => {
    let seenCwd = '';
    const v = new Verifier({ command: () => 'npm test', prepare: directPreparer(async (_cmd, opts) => { seenCwd = opts.cwd; return { code: 0, output: '' }; }) });
    await v.verify('/work/tree-a');
    expect(seenCwd).toBe('/work/tree-a');
  });
});
