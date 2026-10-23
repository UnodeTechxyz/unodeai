import { describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { CommandPolicy, inspectCommand, noPolicyVerdict } from '../CommandPolicy';
import { commandShellIdentity } from '../CommandShell';
import { gateShellCommand, PhysicalQueryLimit } from '../ShellCommandGate';
import { decideCommandPermission, claudeToolShell } from '../commandPermission';
import { BASH_SHELL, CMD_SHELL, ON_CMD, ON_POSIX, ON_WINDOWS_POWERSHELL, WINDOWS_POWERSHELL_SHELL } from './shellFixtures';
import { protectedFixture, removeTemporaryFolders } from './pathSafetyFixtures';

/*
 * v0.9.97 S0 bounded command guard. The scanner reports blocked / supported / opaque; the mode authorises. This
 * file pins the three-state contract, the mode matrix, the single-use handling of opaque, the physical budget that
 * turns an unprovable delete target opaque, and the fail-closed behaviour when no policy is injected.
 */

const CLAUDE_BASH = claudeToolShell('Bash')!;

describe('inspectCommand: the literal envelope', () => {
  it('reads a simple literal command and an admitted chain as supported', () => {
    for (const command of ['git status', 'npm run lint', 'npm test && npm run build', 'git commit -m "fix: a && b"']) {
      expect(inspectCommand(command, ON_POSIX.shell).kind, command).toBe('supported');
    }
    expect(inspectCommand('Remove-Item -Recurse "build"', ON_WINDOWS_POWERSHELL.shell).kind).toBe('supported');
  });

  it('blocks a literal recursive delete of a protected or parent target', () => {
    for (const [command, shell] of [['rm -r .git', ON_POSIX], ['rmdir /s /q ..', ON_CMD], ['Remove-Item -Recurse ..', ON_WINDOWS_POWERSHELL]] as const) {
      expect(inspectCommand(command, shell.shell).kind, command).toBe('blocked');
    }
  });

  it('turns an expansion, escape, pipe, wrapper, newline or unidentified shell opaque', () => {
    const opaque: Array<[string, { shell: typeof ON_POSIX.shell }]> = [
      ['rm -r $HOME/x', ON_POSIX],
      ['rm -r *', ON_POSIX],
      ['grep x foo | sh', ON_POSIX],
      ['cat a > b', ON_POSIX],
      [String.raw`rm -r a\" b`, ON_POSIX],
      ['cmd /c "rmdir /s /q x"', ON_POSIX],
      ['node -e "require(\'fs\')"', ON_POSIX],
      ['./build.sh', ON_POSIX],
      ['rm -r a\nrm -r b', ON_POSIX],
    ];
    for (const [command, shell] of opaque) {
      expect(inspectCommand(command, shell.shell).kind, command).toBe('opaque');
    }
    expect(inspectCommand('git status', undefined).kind).toBe('opaque'); // no shell = unidentified
  });

  it('keeps a plain interpreter invocation without an eval flag supported', () => {
    expect(inspectCommand('node server.js', ON_POSIX.shell).kind).toBe('supported');
    expect(inspectCommand('python app.py', ON_POSIX.shell).kind).toBe('supported');
  });
});

// A recursive/forced delete target that may still be expanded names files the guard cannot list. PowerShell's -Path
// and cmd's erase/del match wildcards themselves, inside quotes too, so `Remove-Item -Recurse -Force "*"` is every item
// in the folder, `.git` included; a leading `~` is the home folder. Such a command is opaque on every route.
describe('a delete target that may still be expanded is opaque (wildcards, a leading ~)', () => {
  const expandable: Array<[string, { shell: typeof ON_POSIX.shell }]> = [
    ['Remove-Item -Recurse -Force "*"', ON_WINDOWS_POWERSHELL],
    ['Remove-Item -Recurse "src?"', ON_WINDOWS_POWERSHELL],
    ['erase /s /q "*"', ON_CMD],
    ['rd /s /q "build*"', ON_CMD],
    ['rm -r ~/proj', ON_POSIX],
    ['rm -r "x[1]"', ON_POSIX],
  ];

  it('classifies each as opaque and maps it through the mode matrix, no policy included', () => {
    for (const [command, shell] of expandable) {
      expect(inspectCommand(command, shell.shell).kind, command).toBe('opaque');
      expect(new CommandPolicy('allowlist', ['Remove-Item', 'erase', 'rd', 'rm']).check(command, shell), command)
        .toMatchObject({ allowed: false, opaque: true });
      expect(new CommandPolicy('ask', []).check(command, shell), command).toMatchObject({ allowed: false, ask: true, opaque: true });
      expect(new CommandPolicy('all', []).check(command, shell), command).toMatchObject({ allowed: true, opaque: true });
      expect(noPolicyVerdict(command, shell.shell), command).toMatchObject({ allowed: false, opaque: true });
    }
  });

  it('still blocks a recognised dangerous target in the same command, and keeps a literal target supported', () => {
    expect(inspectCommand('rm -r .git "*"', ON_POSIX.shell).kind).toBe('blocked');
    expect(inspectCommand('rm -r ~', ON_POSIX.shell).kind).toBe('blocked');
    expect(inspectCommand('Remove-Item -Recurse -Force build', ON_WINDOWS_POWERSHELL.shell).kind).toBe('supported');
  });

  it('is refused on the host gate and on the Claude native route with no policy injected', async () => {
    const command = 'Remove-Item -Recurse -Force "*"';
    const gate = (policy?: CommandPolicy) => gateShellCommand({
      command, roots: ['/ws'], cwd: '/ws', source: 'model', shell: WINDOWS_POWERSHELL_SHELL,
      ...(policy ? { commandPolicy: policy } : {}),
    });
    expect(await gate(new CommandPolicy('allowlist', ['Remove-Item']))).toMatchObject({ ok: false, kind: 'policy' });
    expect(await gate()).toMatchObject({ ok: false });
    expect((await decideCommandPermission('PowerShell', { command }, { isTrusted: true })).behavior).toBe('deny');
  });
});

describe('CommandPolicy: the mode x state matrix', () => {
  const opaque = 'cmd /c "echo hi"'; // a wrapper, opaque under POSIX
  const supported = 'git status';

  it('none refuses every state', () => {
    const none = new CommandPolicy('none', ['git status']);
    expect(none.check(supported, ON_POSIX).allowed).toBe(false);
    expect(none.check(opaque, ON_POSIX).allowed).toBe(false);
    expect(none.check('rm -r .git', ON_POSIX).reason).toMatch(/destructive/);
  });

  it('allowlist runs a supported allowlisted command and refuses opaque as uncheckable', () => {
    const list = new CommandPolicy('allowlist', ['git status']);
    expect(list.check(supported, ON_POSIX).allowed).toBe(true);
    expect(list.check(opaque, ON_POSIX)).toMatchObject({ allowed: false, opaque: true });
    expect(list.check(opaque, ON_POSIX).reason).toMatch(/cannot be checked silently/);
  });

  it('ask prompts a non-allowlisted supported command normally and an opaque command single-use', () => {
    const ask = new CommandPolicy('ask', ['git status']);
    expect(ask.check(supported, ON_POSIX).allowed).toBe(true); // allowlisted supported: silent
    expect(ask.check('git diff', ON_POSIX)).toMatchObject({ allowed: false, ask: true });
    expect(ask.check('git diff', ON_POSIX).opaque).toBeUndefined(); // supported: a normal, persistable prompt
    expect(ask.check(opaque, ON_POSIX)).toMatchObject({ allowed: false, ask: true, opaque: true }); // single-use
  });

  it('all runs supported and opaque, marking opaque not analysed', () => {
    const all = new CommandPolicy('all', []);
    expect(all.check(supported, ON_POSIX)).toEqual({ allowed: true });
    expect(all.check(opaque, ON_POSIX)).toEqual({ allowed: true, opaque: true });
  });
});

describe('the gate authorises opaque per mode and makes its approval single-use', () => {
  const run = (command: string, policy?: CommandPolicy, approve?: () => Promise<{ allow: boolean }>) =>
    gateShellCommand({ command, roots: ['/ws'], cwd: '/ws', source: 'model', shell: BASH_SHELL,
      ...(policy ? { commandPolicy: policy } : {}), ...(approve ? { requestApproval: approve } : {}) });
  const opaque = 'cmd /c "echo hi"';

  it('refuses opaque in none and allowlist, runs it in all', async () => {
    expect(await run(opaque, new CommandPolicy('none'))).toMatchObject({ ok: false });
    expect(await run(opaque, new CommandPolicy('allowlist', ['cmd']))).toMatchObject({ ok: false, kind: 'policy' });
    expect(await run(opaque, new CommandPolicy('all'))).toEqual({ ok: true, outsidePath: undefined });
  });

  it('prompts opaque single-use in ask, with forcePrompt so no latch applies', async () => {
    const approve = vi.fn(async () => ({ allow: true }));
    const outcome = await run(opaque, new CommandPolicy('ask'), approve);
    expect(outcome).toEqual({ ok: true, outsidePath: undefined });
    expect(approve).toHaveBeenCalledWith(opaque, expect.objectContaining({ singleUse: true, forcePrompt: true }));
  });

  it('with no policy injected, refuses opaque and blocked, runs supported (a missing mode is not all)', async () => {
    expect(await run(opaque)).toMatchObject({ ok: false }); // opaque, fail-closed
    expect(await run('rm -r .git')).toMatchObject({ ok: false, kind: 'policy', reason: expect.stringMatching(/destructive/) });
    expect(await run('git status')).toEqual({ ok: true, outsidePath: undefined });
  });
});

describe('the physical delete guard turns an unprovable target opaque, not allowed', () => {
  it('a delete with more literal targets than the budget is opaque, not silently allowed', async () => {
    const many = `rm -r ${Array.from({ length: 33 }, (_, i) => `d${i}`).join(' ')}`;
    // In all mode the command runs but is marked opaque (not analysed); in allowlist it is refused.
    const all = await gateShellCommand({ command: many, roots: ['/ws'], cwd: '/ws', source: 'model', shell: BASH_SHELL, commandPolicy: new CommandPolicy('all') });
    expect(all).toEqual({ ok: true });
    const list = await gateShellCommand({ command: many, roots: ['/ws'], cwd: '/ws', source: 'model', shell: BASH_SHELL, commandPolicy: new CommandPolicy('allowlist', ['rm']) });
    expect(list).toMatchObject({ ok: false, kind: 'policy' });
  });

  it('a real-fixture link and short name to a protected folder is still blocked (supported + physical)', async () => {
    const root = await protectedFixture();
    const shell = process.platform === 'win32' ? CMD_SHELL : BASH_SHELL;
    const del = (t: string) => process.platform === 'win32' ? `rmdir /s /q "${t}"` : `rm -r "${t}"`;
    await fs.symlink(path.join(root, '.git'), path.join(root, 'innocent'), process.platform === 'win32' ? 'junction' : 'dir');
    const outcome = await gateShellCommand({ command: del('innocent'), roots: [root], cwd: root, source: 'model', shell, commandPolicy: new CommandPolicy('all') });
    expect(outcome).toMatchObject({ ok: false, kind: 'policy', reason: expect.stringMatching(/destructive/) });
    await removeTemporaryFolders();
  });

  // S0-N5: the 1-second budget must bound the filesystem queries themselves, not only the gap between them. A
  // resolver that never settles (a stuck network/volume lookup) is injected through the production gate seam; the
  // guard must report `uncertain` at the deadline — opaque, refused in allowlist — instead of holding the gate.
  it('bounds a stalled filesystem query by the remaining budget and does not hang (uncertain -> opaque)', async () => {
    const neverSettles = () => new Promise<string>(() => {}); // a query that never resolves
    // Its own query limit, so the queries this test leaves pending never fill the process-wide one.
    const queries = new PhysicalQueryLimit(8);
    const started = Date.now();
    const list = await gateShellCommand({
      command: 'rm -r something', roots: ['/ws'], cwd: '/ws', source: 'model', shell: BASH_SHELL,
      commandPolicy: new CommandPolicy('allowlist', ['rm']),
      physicalDeleteGuardForTest: { realpath: neverSettles, budgetMs: 40, queries },
    });
    expect(Date.now() - started, 'the deadline bounds the stalled query; the gate does not hang').toBeLessThan(2000);
    expect(list).toMatchObject({ ok: false, kind: 'policy', reason: expect.stringMatching(/cannot be checked silently/) });
    // The same stalled query in `all` runs but is marked opaque (uncertain, not analysed), never silently cleared.
    const all = await gateShellCommand({
      command: 'rm -r something', roots: ['/ws'], cwd: '/ws', source: 'model', shell: BASH_SHELL,
      commandPolicy: new CommandPolicy('all'),
      physicalDeleteGuardForTest: { realpath: neverSettles, budgetMs: 40, queries },
    });
    expect(all).toEqual({ ok: true });
  });

  // S0-N6: one call's deadline does not bound queries ACROSS calls, because an abandoned realpath keeps running.
  // A shared cap does: with a resolver that never settles, repeated and concurrent gate calls all return, and the
  // resolver is started no more than the cap allows in total.
  it('caps never-settling queries across repeated and concurrent gate calls; every call still returns', async () => {
    let starts = 0;
    const neverSettles = () => { starts += 1; return new Promise<string>(() => {}); };
    const queries = new PhysicalQueryLimit(2);
    const gate = () => gateShellCommand({
      command: 'rm -r something', roots: ['/ws'], cwd: '/ws', source: 'model', shell: BASH_SHELL,
      commandPolicy: new CommandPolicy('allowlist', ['rm']),
      physicalDeleteGuardForTest: { realpath: neverSettles, budgetMs: 40, queries },
    });
    const refused = { ok: false, kind: 'policy', reason: expect.stringMatching(/cannot be checked silently/) };
    const started = Date.now();
    for (let i = 0; i < 6; i++) {
      expect(await gate(), `sequential call ${i + 1}`).toMatchObject(refused);
    }
    const concurrent = await Promise.all(Array.from({ length: 6 }, gate));
    expect(Date.now() - started, 'every call returns; none waits on a stalled query').toBeLessThan(2000);
    for (const outcome of concurrent) {
      expect(outcome).toMatchObject(refused);
    }
    expect(starts, 'the resolver is never started beyond the shared cap').toBe(2);
    expect(queries.inFlight).toBe(2);
  });

  it('releases a slot when its query finally settles, so a later call can query again', async () => {
    const pending: Array<(value: string) => void> = [];
    const controlled = (p: string) => new Promise<string>((resolve) => { pending.push(() => resolve(p)); });
    const queries = new PhysicalQueryLimit(1);
    const gate = () => gateShellCommand({
      command: 'rm -r something', roots: ['/ws'], cwd: '/ws', source: 'model', shell: BASH_SHELL,
      commandPolicy: new CommandPolicy('allowlist', ['rm']),
      physicalDeleteGuardForTest: { realpath: controlled, budgetMs: 40, queries },
    });
    await gate(); // starts one query, abandons it at the deadline
    await gate(); // the only slot is held: no query is started
    expect(pending).toHaveLength(1);
    pending[0]('/ws'); // the stalled system call finally returns
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queries.inFlight).toBe(0);
    await gate(); // the slot is free again: a new query starts
    expect(pending).toHaveLength(2);
  });

  // S0-N7: a protected root whose query fails has no proven physical identity. Its written spelling must not stand in
  // for it: here the root lookup is denied (EACCES) while the delete target resolves to the root's real location, so
  // comparing against the spelling would miss that the target IS the workspace. The result must be uncertain.
  it('treats a failed protected-root query as uncertain, never as the root\'s written spelling', async () => {
    const root = path.resolve('/audit-ws-link'); // the root as the gate is given it (a link, say)
    const physicalRoot = path.resolve('/audit-ws-physical'); // where that root really is
    const onWindows = process.platform === 'win32';
    // A relative cmd target on Windows (resolved from the root without querying it); an absolute one on POSIX,
    // whose walk starts at `/` rather than at the root.
    const shell = onWindows ? CMD_SHELL : BASH_SHELL;
    const command = onWindows ? 'rmdir /s /q alias' : 'rm -r /audit-alias';
    const resolver = async (p: string): Promise<string> => {
      if (path.resolve(p) === root) {
        throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      }
      return physicalRoot; // the delete target is the root itself, by another name
    };
    const gate = (policy?: CommandPolicy) => gateShellCommand({
      command, roots: [root], cwd: root, source: 'model', shell,
      ...(policy ? { commandPolicy: policy } : {}),
      physicalDeleteGuardForTest: { realpath: resolver, queries: new PhysicalQueryLimit(8) },
    });
    const refused = { ok: false, kind: 'policy', reason: expect.stringMatching(/cannot be checked silently|could not be confirmed/) };
    expect(await gate(new CommandPolicy('allowlist', ['rmdir', 'rm']))).toMatchObject(refused);
    expect(await gate(new CommandPolicy('none'))).toMatchObject({ ok: false });
    expect(await gate()).toMatchObject(refused); // no policy injected: opaque is refused, not run
    // Unsafe `all` keeps the documented mapping: it runs, as opaque (not analysed), never as a checked "clear".
    expect(await gate(new CommandPolicy('all'))).toMatchObject({ ok: true });
  });

  // A character its grammar may expand reaches the physical check only inside quotes (the scanner refuses it outside).
  // Single-quoted in a POSIX shell it is literal, so `'$alias'` may be a real link to a protected folder; whether
  // literal or expanded, its real path is not proven, so it is uncertain, not skipped as clear.
  it('treats a quoted target holding an expansion character as uncertain, never as clear', async () => {
    const queried: string[] = [];
    const resolver = async (p: string): Promise<string> => { queried.push(p); return p; };
    const outcome = await gateShellCommand({
      command: "rm -r '$alias'", roots: ['/ws'], cwd: '/ws', source: 'model', shell: BASH_SHELL,
      commandPolicy: new CommandPolicy('allowlist', ['rm']),
      physicalDeleteGuardForTest: { realpath: resolver, queries: new PhysicalQueryLimit(8) },
    });
    expect(inspectCommand("rm -r '$alias'", BASH_SHELL).kind).toBe('supported');
    expect(outcome).toMatchObject({ ok: false, kind: 'policy', reason: expect.stringMatching(/cannot be checked silently/) });
    expect(queried.some((p) => p.includes('$alias')), 'the target is not resolved as if it were literal').toBe(false);
  });

  // S0-N8, the invariant: `skip` counts as clear, so it means only "proven to name nothing" — a proven argument, or a
  // proven host path the system reports absent. A target whose host path is not proven is uncertain, whatever spelling
  // made it unproven. These are representative unproven forms across the grammars, not a list the guard keeps.
  it('makes a target with no proven host path uncertain, never clear, in every grammar', async () => {
    const root = path.resolve('/audit-n8-ws');
    const wsl = commandShellIdentity('wsl', 'terminal-probe', { fingerprint: ['test'] });
    const cases: Array<{ command: string; shell: typeof BASH_SHELL }> = [
      { command: 'rm -r child', shell: wsl }, // this host cannot map a WSL path
      { command: "rm -r 'alias\\name'", shell: BASH_SHELL }, // a POSIX backslash
      { command: 'rmdir /s /q D:.', shell: CMD_SHELL }, // drive-relative: the drive's own current folder
      { command: 'Remove-Item -Recurse ws:\\data', shell: WINDOWS_POWERSHELL_SHELL }, // a PowerShell drive
      // Git Bash on Windows maps only /c/... to a drive; /home/... has no host path here. Elsewhere it is a real path.
      ...(process.platform === 'win32' ? [{ command: 'rm -r /home/alias', shell: BASH_SHELL }] : []),
    ];
    for (const { command, shell } of cases) {
      expect(inspectCommand(command, shell).kind, command).toBe('supported');
      const gate = (policy?: CommandPolicy) => gateShellCommand({
        command, roots: [root], cwd: root, source: 'model', shell,
        ...(policy ? { commandPolicy: policy } : {}),
        // Answers the separate outside-the-workspace prompt an absolute path raises, so `all` shows only this check.
        requestApproval: async () => ({ allow: true }),
        physicalDeleteGuardForTest: { realpath: async (p) => p, queries: new PhysicalQueryLimit(8) },
      });
      expect(await gate(new CommandPolicy('allowlist', ['rm', 'rmdir', 'Remove-Item'])), command)
        .toMatchObject({ ok: false, kind: 'policy', reason: expect.stringMatching(/cannot be checked silently/) });
      expect(await gate(new CommandPolicy('none')), command).toMatchObject({ ok: false });
      expect(await gate(), command).toMatchObject({ ok: false, reason: expect.stringMatching(/could not be confirmed/) });
      expect(await gate(new CommandPolicy('all')), command).toMatchObject({ ok: true });
    }
  });

  // S0-N8: in Windows PowerShell `/alias` is a path at the drive root, not a cmd switch, so it is resolved: a link
  // there that leads to the workspace is the workspace.
  it('resolves a PowerShell slash-rooted target instead of skipping it as a cmd switch', async () => {
    const root = path.resolve('/audit-ps-ws');
    const queried: string[] = [];
    const resolver = async (p: string): Promise<string> => {
      queried.push(p);
      return path.basename(p) === 'alias' ? root : p; // `/alias` is a link to the workspace root
    };
    for (const mode of ['allowlist', 'all'] as const) {
      const outcome = await gateShellCommand({
        command: 'Remove-Item -Recurse /alias', roots: [root], cwd: root, source: 'model', shell: WINDOWS_POWERSHELL_SHELL,
        commandPolicy: new CommandPolicy(mode, ['Remove-Item']),
        physicalDeleteGuardForTest: { realpath: resolver, queries: new PhysicalQueryLimit(8) },
      });
      expect(outcome, mode).toMatchObject({ ok: false, kind: 'policy', reason: expect.stringMatching(/destructive/) });
    }
    expect(queried.some((p) => path.basename(p) === 'alias'), 'the target is resolved, not skipped').toBe(true);
    // A cmd switch is still not a target in cmd.
    expect(inspectCommand('rmdir /s /q build', CMD_SHELL).kind).toBe('supported');
  });

  // A POSIX `-x` token is not proven to be an option: after `--` it is a file name. So it is resolved like any target,
  // and an operand `-alias` that is a link to the workspace is blocked.
  it('resolves a POSIX dash token instead of assuming it is an option', async () => {
    const root = path.resolve('/audit-dash-ws');
    const resolver = async (p: string): Promise<string> => (path.basename(p) === '-alias' ? root : p);
    for (const mode of ['allowlist', 'all'] as const) {
      const outcome = await gateShellCommand({
        command: 'rm -r -- -alias', roots: [root], cwd: root, source: 'model', shell: BASH_SHELL,
        commandPolicy: new CommandPolicy(mode, ['rm']),
        physicalDeleteGuardForTest: { realpath: resolver, queries: new PhysicalQueryLimit(8) },
      });
      expect(outcome, mode).toMatchObject({ ok: false, kind: 'policy', reason: expect.stringMatching(/destructive/) });
    }
  });

  // S0-N9: the program, not the shell, decides what a token means, so cmd does not prove a `/x` is a switch. Here it is
  // a path handed to an external `rm.exe`, a link to the workspace root, and it is blocked. An ordinary cmd switch that
  // names no file is simply absent, so an ordinary delete stays clear.
  it('resolves a cmd /x token instead of assuming it is a switch', async () => {
    const root = path.resolve('/audit-cmd-ws');
    const resolver = async (p: string): Promise<string> => {
      if (path.resolve(p) === root) return root;
      if (path.basename(p) === 'alias') return root; // `/alias` is a link to the workspace root
      throw Object.assign(new Error('not found'), { code: 'ENOENT' }); // `/s`, `/q` and `build` name nothing
    };
    const gate = (command: string, mode: 'allowlist' | 'all') => gateShellCommand({
      command, roots: [root], cwd: root, source: 'model', shell: CMD_SHELL,
      commandPolicy: new CommandPolicy(mode, ['rm.exe', 'rmdir']),
      physicalDeleteGuardForTest: { realpath: resolver, queries: new PhysicalQueryLimit(8) },
    });
    for (const mode of ['allowlist', 'all'] as const) {
      expect(await gate('rm.exe -r /alias', mode), mode).toMatchObject({ ok: false, kind: 'policy', reason: expect.stringMatching(/destructive/) });
    }
    expect(await gate('rmdir /s /q build', 'allowlist')).toMatchObject({ ok: true });
  });

  // The other half of the invariant: a proven host path the system reports absent is still clear, so an ordinary
  // delete of something that does not exist is not turned into a prompt.
  it('keeps a proven path that does not exist clear', async () => {
    const root = path.resolve('/audit-absent-ws');
    const resolver = async (p: string): Promise<string> => {
      if (path.resolve(p) === root) return root;
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    };
    const outcome = await gateShellCommand({
      command: 'rm -r build', roots: [root], cwd: root, source: 'model', shell: BASH_SHELL,
      commandPolicy: new CommandPolicy('allowlist', ['rm']),
      physicalDeleteGuardForTest: { realpath: resolver, queries: new PhysicalQueryLimit(8) },
    });
    expect(outcome).toMatchObject({ ok: true });
  });
});

describe('the Claude bridge is fail-closed and single-use for opaque', () => {
  const base = { policy: new CommandPolicy('ask', ['git status']), isTrusted: true } as const;

  it('allows a supported allowlisted command and prompts a supported non-allowlisted one', async () => {
    expect((await decideCommandPermission('Bash', { command: 'git status' }, base)).behavior).toBe('allow');
    const approve = vi.fn(async () => ({ allow: true }));
    const d = await decideCommandPermission('Bash', { command: 'git diff' }, { ...base, requestApproval: approve });
    expect(d.behavior).toBe('allow');
    expect(approve).toHaveBeenCalledWith('git diff', expect.not.objectContaining({ singleUse: true }));
  });

  it('prompts an opaque command single-use, and denies it when no approver', async () => {
    const approve = vi.fn(async () => ({ allow: true }));
    const prompted = await decideCommandPermission('Bash', { command: 'cmd /c "echo hi"' }, { ...base, requestApproval: approve });
    expect(prompted.behavior).toBe('allow');
    expect(approve).toHaveBeenCalledWith('cmd /c "echo hi"', expect.objectContaining({ singleUse: true, forcePrompt: true }));
    expect((await decideCommandPermission('Bash', { command: 'cmd /c "echo hi"' }, base)).behavior).toBe('deny');
  });

  it('with no policy, refuses opaque and blocked but allows supported (closes the old !verdict allow)', async () => {
    expect((await decideCommandPermission('Bash', { command: 'git status' }, { isTrusted: true })).behavior).toBe('allow');
    expect((await decideCommandPermission('Bash', { command: 'cmd /c "echo hi"' }, { isTrusted: true })).behavior).toBe('deny');
    expect((await decideCommandPermission('Bash', { command: 'rm -r .git' }, { isTrusted: true })).behavior).toBe('deny');
  });

  it('names the Claude Bash tool shell (Windows PowerShell has no && separator)', () => {
    expect(CLAUDE_BASH.grammar).toBe('posix');
    expect(claudeToolShell('PowerShell')!.grammar).toBe('powershell');
  });
});
