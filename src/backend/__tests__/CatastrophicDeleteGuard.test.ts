import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { MessageBus } from '../../bus/MessageBus';
import type { CommandExecutionProvider } from '../CommandExecution';
import { CommandPolicy, inspectCommand } from '../CommandPolicy';
import { gateShellCommand } from '../ShellCommandGate';
import { TeamTools } from '../TeamTools';
import { Verifier } from '../Verifier';
import { WorkspaceTools } from '../WorkspaceTools';
import { BASH_SHELL, CMD_SHELL, directPreparer, ON_CMD, ON_POSIX, ON_WINDOWS_POWERSHELL, WINDOWS_POWERSHELL_SHELL } from './shellFixtures';
import { protectedFixture, protectedFoldersIntact, removeTemporaryFolders, shortNameOf } from './pathSafetyFixtures';

/*
 * v0.9.97 S0, defects S1 and A2 in released v0.9.96: the catastrophic-delete guard, which every mode applies,
 * read `.git::$INDEX_ALLOCATION`, an 8.3 short name, `./..` and `sub/../..` as ordinary folders, so `all` mode
 * ran them. Each list below is checked as a whole, so a failure names every spelling the guard missed.
 */

afterEach(removeTemporaryFolders);

type Shell = typeof CMD_SHELL;
type CheckOptions = typeof ON_CMD;

const all = new CommandPolicy('all', []);

function missedBy(policy: CommandPolicy, commands: Array<[string, CheckOptions]>): string[] {
  return commands
    .filter(([command, shell]) => !/destructive pattern/.test(policy.check(command, shell).reason ?? ''))
    .map(([command]) => command);
}

/** Commands outside the literal envelope (a wrapper, an escape, an interpolation): opaque, not blocked. */
function notOpaque(commands: Array<[string, CheckOptions]>): string[] {
  return commands.filter(([command, shell]) => inspectCommand(command, shell.shell).kind !== 'opaque').map(([command]) => command);
}

/**
 * The gate's authorisation of an opaque command: refused in none and allowlist and with no policy, a single-use
 * prompt in ask (the approver is asked, for this one command only), and run in all. An approval cannot persist.
 */
async function expectOpaqueModeMatrix(command: string, cwd: string, root: string, shell: Shell): Promise<void> {
  for (const mode of ['none', 'allowlist'] as const) {
    const approve = vi.fn(async () => ({ allow: true }));
    const outcome = await gate(command, cwd, root, shell, new CommandPolicy(mode, ['rmdir', 'rd', 'rm', 'Remove-Item']), approve);
    if (mode === 'none') {
      expect(outcome).toMatchObject({ ok: false, kind: 'policy' });
      expect(approve).not.toHaveBeenCalled();
      continue;
    }
    expect(outcome, `${mode}: ${command}`).toMatchObject({ ok: false });
    expect(approve, `${mode}: ${command}`).not.toHaveBeenCalled();
  }
  await expect(gate(command, cwd, root, shell), `no policy: ${command}`).resolves.toMatchObject({ ok: false });
  const askApprove = vi.fn(async () => ({ allow: true }));
  const asked = await gate(command, cwd, root, shell, new CommandPolicy('ask', ['rmdir', 'rd', 'rm', 'Remove-Item']), askApprove);
  expect(asked, `ask: ${command}`).toEqual({ ok: true, outsidePath: undefined });
  expect(askApprove, `ask: ${command}`).toHaveBeenCalledWith(command, expect.objectContaining({ singleUse: true, forcePrompt: true }));
  const ran = await gate(command, cwd, root, shell, new CommandPolicy('all'));
  expect(ran, `all: ${command}`).toEqual({ ok: true });
}

describe('S1: the guard reads stream and trailing-dot spellings of .git and .unode', () => {
  it('blocks the cmd stream and trailing-dot spellings in "all" mode (cmd keeps `$` and `:` literal)', () => {
    expect(missedBy(all, [
      ['rmdir /s /q .git::$INDEX_ALLOCATION', ON_CMD],
      ['rd /s /q .unode::$INDEX_ALLOCATION', ON_CMD],
      ['rmdir /s /q .GIT::$INDEX_ALLOCATION', ON_CMD],
      ['rmdir /s /q .git::$DATA', ON_CMD],
      ['rmdir /s /q .git.', ON_CMD],
      ['rmdir /s /q ".git "', ON_CMD],
      ['rmdir /s /q sub\\..\\.git.', ON_CMD],
    ])).toEqual([]);
  });

  // A `$` makes a PowerShell argument need interpolation, so the stream spelling is opaque there, not decoded. The
  // physical delete guard catches a short name or link alias of .git on the host route; a `$`-stream alias on the
  // PowerShell command route in `all` (unsafe) mode is a recorded residual. The cmd spelling above stays blocked.
  it('treats the PowerShell `$`-stream spelling as opaque, not a decoded .git target', () => {
    expect(inspectCommand('Remove-Item -Recurse -Force .git::$INDEX_ALLOCATION', ON_WINDOWS_POWERSHELL.shell).kind).toBe('opaque');
  });
});

// Every `rm` with both -r and -f is blocked whatever its target, so these spellings use `rm -r`.
describe('A2: the guard reads every spelling of the parent folder and the working folder', () => {
  it('blocks ./.. and sub/../.. forms in "all" mode', () => {
    expect(missedBy(all, [
      ['rm -r ./..', ON_POSIX],
      ['rm -r sub/../..', ON_POSIX],
      ['rm -r ./../', ON_POSIX],
      ['rm -r "./.."', ON_POSIX],
      ['rmdir /s /q .\\..', ON_CMD],
      ['rd /s /q sub\\..\\..', ON_CMD],
      ['Remove-Item -Recurse .\\..', ON_WINDOWS_POWERSHELL],
    ])).toEqual([]);
  });

  it('blocks a recursive delete of the working folder itself', () => {
    expect(missedBy(all, [
      ['rm -r .', ON_POSIX],
      ['rm -r ./', ON_POSIX],
      ['rm -r sub/..', ON_POSIX],
      ['rmdir /s /q .', ON_CMD],
      ['rd /s /q sub\\..', ON_CMD],
      ['Remove-Item -Recurse .', ON_WINDOWS_POWERSHELL],
    ])).toEqual([]);
  });

  it('reads PowerShell spellings: aliases with -Recurse, a colon-bound path, a comma list, a verb by its path', () => {
    expect(missedBy(all, [
      'rmdir .. -Recurse',
      'rd -r ..',
      'del -Recurse ..',
      'Remove-Item -Path:.. -Recurse',
      'Remove-Item -LiteralPath:.git -Recurse',
      'Remove-Item -Recurse build,..',
      '/bin/rm -r ./..',
      'rm.exe -r ./..',
    ].map((command): [string, CheckOptions] => [command, ON_WINDOWS_POWERSHELL]))).toEqual([]);
  });

  it('still allows folders whose names only start with two dots, and ordinary build folders', () => {
    expect(all.check('rm -r ..cache', ON_POSIX).allowed).toBe(true);
    expect(all.check('rm -r ./..cache', ON_POSIX).allowed).toBe(true);
    expect(all.check('rmdir /s /q sub\\..cache', ON_CMD).allowed).toBe(true);
    expect(all.check('rm -r ./build', ON_POSIX).allowed).toBe(true);
    expect(all.check('rm -r build/.', ON_POSIX).allowed).toBe(true);
    expect(all.check('Remove-Item -Recurse -Path:dist', ON_WINDOWS_POWERSHELL).allowed).toBe(true);
  });

  it('reads a delete\'s targets only up to the end of its own command segment', () => {
    expect(all.check('rm -r dist && tsc -p .', ON_POSIX).allowed).toBe(true);
    expect(all.check('rmdir /s /q build & cd ..', ON_CMD).allowed).toBe(true);
    expect(all.check('Remove-Item -Recurse dist; Set-Location ..', ON_WINDOWS_POWERSHELL).allowed).toBe(true);
    // A later segment's own delete is still read, written apart or glued to the separator.
    expect(all.check('echo hi && rm -r ..', ON_POSIX).reason).toMatch(/destructive pattern/);
    expect(all.check('rm -r build;rm -r ..', ON_POSIX).reason).toMatch(/destructive pattern/);
  });
});

const MODES = ['none', 'allowlist', 'ask', 'all'] as const;

function gate(command: string, cwd: string, root: string, shell: Shell, commandPolicy?: CommandPolicy, requestApproval?: () => Promise<{ allow: boolean }>) {
  return gateShellCommand({
    command, roots: [root], cwd, source: 'model', shell,
    ...(commandPolicy ? { commandPolicy } : {}),
    ...(requestApproval ? { requestApproval } : {}),
  });
}

/**
 * Recognised destructive commands require exact single-use confirmation in every mode. No answer means not run.
 */
async function expectConfirmedInEveryMode(command: string, cwd: string, root: string, shell: Shell): Promise<void> {
  for (const mode of MODES) {
    const approve = vi.fn(async () => ({ allow: true }));
    const outcome = await gate(command, cwd, root, shell, new CommandPolicy(mode, ['rmdir', 'rd', 'rm', 'Remove-Item']), approve);
    if (mode === 'none') {
      expect(outcome).toMatchObject({ ok: false, kind: 'policy' });
      expect(approve).not.toHaveBeenCalled();
      continue;
    }
    expect(outcome, `${mode}: ${command}`).toEqual({ ok: true });
    expect(approve, `${mode}: ${command}`).toHaveBeenCalledWith(command, expect.objectContaining({ dangerous: true, singleUse: true, cwd }));
    await expect(gate(command, cwd, root, shell, new CommandPolicy(mode))).resolves.toMatchObject({ ok: false, kind: 'approval' });
  }
  await expect(gate(command, cwd, root, shell), `no policy: ${command}`)
    .resolves.toMatchObject({ ok: false, kind: 'approval', message: 'The user did not confirm this delete.' });
}

describe('the gate applies the lexical floor in every mode, and without a configured policy', () => {
  it('refuses the written spellings under every mode and with no policy', async () => {
    const root = await protectedFixture();
    for (const [command, shell] of [['rm -r ./..', BASH_SHELL], ['rmdir /s /q .git::$INDEX_ALLOCATION', CMD_SHELL], ['rm -rf build', BASH_SHELL]] as const) {
      await expectConfirmedInEveryMode(command, root, root, shell);
    }
  });
});

describe('S1/A2: the gate judges a delete by where its target physically leads', () => {
  const shell = process.platform === 'win32' ? CMD_SHELL : BASH_SHELL;
  const recursiveDelete = (target: string) => process.platform === 'win32' ? `rmdir /s /q "${target}"` : `rm -r "${target}"`;

  it('refuses the workspace root, a folder above it, the working folder and .git, spelled as absolute paths', async () => {
    const root = await protectedFixture();
    const sub = path.join(root, 'sub');
    await fs.mkdir(sub);
    for (const target of [root, path.dirname(root), path.join(root, '.git')]) {
      await expectConfirmedInEveryMode(recursiveDelete(target), root, root, shell);
    }
    // The working folder is a subfolder of the root: itself and the root above it are both refused.
    await expectConfirmedInEveryMode(recursiveDelete(sub), sub, root, shell);
    await expectConfirmedInEveryMode(recursiveDelete(root), sub, root, shell);
    expect(await protectedFoldersIntact(root)).toBe(true);
  });

  it('refuses "." in a working folder below the root', async () => {
    const root = await protectedFixture();
    const sub = path.join(root, 'sub');
    await fs.mkdir(sub);
    await expectConfirmedInEveryMode(process.platform === 'win32' ? 'rmdir /s /q .' : 'rm -r .', sub, root, shell);
  });

  it('refuses a link whose target is a protected folder', async () => {
    const root = await protectedFixture();
    await fs.symlink(path.join(root, '.git'), path.join(root, 'innocent'), process.platform === 'win32' ? 'junction' : 'dir');
    await expectConfirmedInEveryMode(recursiveDelete('innocent'), root, root, shell);
  });

  it('allows an ordinary folder inside the workspace, spelled relative or absolute', async () => {
    const root = await protectedFixture();
    await fs.mkdir(path.join(root, 'build'));
    await fs.mkdir(path.join(root, '..cache'));
    for (const target of ['build', path.join(root, 'build'), '..cache']) {
      await expect(gate(recursiveDelete(target), root, root, shell, all), target).resolves.toEqual({ ok: true });
    }
  });

  // Codex's audit of 8c552a5, R2: containment by whole segments, so a "..name" working folder is inside its parent.
  it('refuses the parent of a "..name" working folder that is the only root, even with an approver', async () => {
    const repo = await protectedFixture();
    const dotted = path.join(repo, '..cache');
    const other = path.join(repo, 'other-root');
    await fs.mkdir(path.join(dotted, 'build'), { recursive: true });
    await fs.mkdir(other);
    await expectConfirmedInEveryMode(recursiveDelete(repo), dotted, dotted, shell);
    await expectConfirmedInEveryMode(process.platform === 'win32' ? 'rmdir /s /q ..' : 'rm -r ..', dotted, dotted, shell);
    // With a second root, the parent of either is refused.
    for (const cwd of [dotted, other]) {
      const outcome = await gateShellCommand({
        command: recursiveDelete(repo), roots: [dotted, other], cwd, source: 'model', shell,
        commandPolicy: all, requestApproval: async () => ({ allow: true }),
      });
      expect(outcome, cwd).toEqual({ ok: true });
    }
    // A folder inside the "..name" root is ordinary, and a sibling whose name only starts the same is no parent.
    await expect(gate(recursiveDelete(path.join(dotted, 'build')), dotted, dotted, shell, all)).resolves.toEqual({ ok: true });
    await fs.mkdir(path.join(repo, '..cache-other'));
    const sibling = await gateShellCommand({
      command: recursiveDelete(path.join(repo, '..cache-other')), roots: [dotted], cwd: dotted, source: 'model', shell,
      commandPolicy: all, requestApproval: async () => ({ allow: true }),
    });
    expect(sibling).not.toMatchObject({ reason: expect.stringMatching(/destructive pattern/) });
  });

  // Codex's audit of 8c552a5, R3: a narrower working folder must not hide a .git that a wider root sees.
  it('refuses a link into .git when the working folder is inside .git, whatever the order of roots', async () => {
    const repo = await protectedFixture();
    await fs.mkdir(path.join(repo, '.git', 'inner'));
    await fs.mkdir(path.join(repo, 'build'));
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(path.join(repo, '.git', 'inner'), path.join(repo, 'alias'), linkType);
    await fs.symlink(path.join(repo, 'build'), path.join(repo, 'plain-alias'), linkType);
    await expectConfirmedInEveryMode(recursiveDelete(path.join(repo, 'alias')), path.join(repo, '.git'), repo, shell);
    for (const roots of [[path.join(repo, '.git'), repo], [repo, path.join(repo, '.git')]]) {
      const outcome = await gateShellCommand({
        command: recursiveDelete(path.join(repo, 'alias')), roots, cwd: repo, source: 'model', shell, commandPolicy: all,
      });
      expect(outcome, roots.join(' | ')).toMatchObject({ ok: false, kind: 'approval' });
    }
    await expect(gate(recursiveDelete(path.join(repo, 'plain-alias')), repo, repo, shell, all)).resolves.toEqual({ ok: true });
  });
});

// R1 (from Codex's audit of 8c552a5). A WHOLE-word quote is read (its content is the target); a quote spliced
// inside a word, a colon-bound quoted value or a comma list of quotes is outside the literal envelope, so it is
// opaque (a single-use prompt or refused), never decoded into a target.
describe('R1: a whole-word quote is read; a spliced or colon-bound quote is opaque', () => {
  it('blocks a protected target given as a whole-word quote, in "all" mode', () => {
    expect(missedBy(all, [
      ['rmdir /s /q "my dir\\.git"', ON_CMD],
      ['rmdir /s /q "sub dir\\..\\.."', ON_CMD],
      ['rm -r "my dir/../.."', ON_POSIX],
      ['echo "a;b" && rm -r ./..', ON_POSIX],
      ['echo "x";rm -r ./..', ON_POSIX],
      ['rm -r ".git"', ON_POSIX],
      ['Remove-Item -Recurse ".unode"', ON_WINDOWS_POWERSHELL],
    ])).toEqual([]);
  });

  it('treats a colon-bound or spliced quote as opaque, not a decoded target', () => {
    expect(notOpaque([
      'Remove-Item -Recurse -LiteralPath:".git"',
      'Remove-Item -Recurse -Path:".git"',
      "Remove-Item -Recurse -LiteralPath:'.git'",
      'Remove-Item -Recurse -Path:"build",".git"',
      'Remove-Item -Recurse -Path:".g"it',
      'rd -Recurse -Path:".git"',
    ].map((command): [string, CheckOptions] => [command, ON_WINDOWS_POWERSHELL]))).toEqual([]);
  });

  it('still allows whole-word quoted ordinary folders, and reads a separator inside quotes as text', () => {
    expect(all.check('Remove-Item -Recurse "build"', ON_WINDOWS_POWERSHELL).allowed).toBe(true);
    expect(all.check('Remove-Item -Recurse "my build"', ON_WINDOWS_POWERSHELL).allowed).toBe(true);
    expect(all.check('rm -r "a;b"', ON_POSIX).allowed).toBe(true);
    expect(all.check('rm -r "..cache"', ON_POSIX).allowed).toBe(true);
  });

  it('the gate blocks a whole-word quoted protected target in every mode, an approval included', async () => {
    const root = await protectedFixture();
    for (const command of ['Remove-Item -Recurse ".git"', 'Remove-Item -Recurse ".unode"']) {
      await expectConfirmedInEveryMode(command, root, root, WINDOWS_POWERSHELL_SHELL);
    }
    expect(await protectedFoldersIntact(root)).toBe(true);
  });

  it('the gate makes a colon-bound quoted delete a single-use prompt, not a silent run', async () => {
    const root = await protectedFixture();
    await expectOpaqueModeMatrix('Remove-Item -Recurse -LiteralPath:".git"', root, root, WINDOWS_POWERSHELL_SHELL);
  });

  it.runIf(process.platform === 'win32')('the gate reads a whole-word quoted short name and a path with spaces on disk', async (context) => {
    const root = await protectedFixture();
    await fs.mkdir(path.join(root, 'my dir', '.git'), { recursive: true });
    const gitShort = shortNameOf(root, '.git');
    if (!gitShort) {
      context.skip('this volume does not generate 8.3 short names');
    }
    await fs.symlink(path.join(root, '.git'), path.join(root, 'quoted alias'), 'junction');
    for (const command of [`Remove-Item -Recurse "${gitShort}"`, 'Remove-Item -Recurse "quoted alias"', `rmdir /s /q "${gitShort}"`]) {
      await expectConfirmedInEveryMode(command, root, root, command.startsWith('rmdir') ? CMD_SHELL : WINDOWS_POWERSHELL_SHELL);
    }
    expect(await protectedFoldersIntact(root)).toBe(true);
  });
});

// N1 (from the 7b62402 re-audit), under the bounded envelope. A POSIX backslash is an escape the scanner does not
// decode, so an escaped-quote command is opaque (a single-use prompt or refused), never run silently while hiding a
// target. A cmd single quote is an ordinary character, so cmd reads `a'` and the following `.git` as separate words
// and the `.git` target is still blocked. A cmd caret is an escape, so a caret form is opaque.
describe('N1: an escape is opaque; a cmd single quote is an ordinary character', () => {
  it('a POSIX backslash escape makes the command opaque, not a decoded target', () => {
    expect(notOpaque([
      [String.raw`rm -r a\" .git`, ON_POSIX],
      [String.raw`rm -r a\' .git`, ON_POSIX],
      [String.raw`rm -r x\"y\" .git`, ON_POSIX],
      [String.raw`rm -r "a b"\" .git`, ON_POSIX],
    ])).toEqual([]);
  });

  it('a cmd single quote is ordinary, so a following protected target is still blocked', () => {
    expect(missedBy(all, [
      [String.raw`rmdir /s /q a' .git`, ON_CMD],
      [String.raw`rd /s /q x' .unode`, ON_CMD],
    ])).toEqual([]);
  });

  it('a cmd caret escape makes the command opaque, not a decoded target', () => {
    expect(inspectCommand(String.raw`rmdir /s /q a^" .git`, ON_CMD.shell).kind).toBe('opaque');
  });

  it('the gate makes the POSIX escaped-quote form a single-use prompt, not a silent run', async () => {
    const root = await protectedFixture();
    await expectOpaqueModeMatrix(String.raw`rm -r a\" .git`, root, root, BASH_SHELL);
    expect(await protectedFoldersIntact(root)).toBe(true);
  });

  it('still allows an ordinary cmd delete that carries a literal single quote', () => {
    expect(all.check(String.raw`rmdir /s /q o'brien`, ON_CMD).allowed).toBe(true);
  });
});

// N2 (from the 0942ebd re-audit), under the bounded envelope. A wrapper (`powershell -Command`, `cmd /c`, `bash -c`,
// `pwsh -c`) runs a second command the scanner does not read, so it is opaque — never decoded, never run silently in
// a controlled mode. A raw `rm -rf /` text still matches the catastrophic pattern first, so it stays blocked.
describe('N2: a wrapper is opaque, not decoded; a raw rm -rf is still blocked', () => {
  it('a wrapper around a protected delete is opaque under its outer grammar', () => {
    expect(notOpaque([
      [String.raw`powershell -Command 'Remove-Item .\.git -Recurse'`, ON_POSIX],
      [String.raw`powershell -Command 'Remove-Item C:\ -Recurse'`, ON_POSIX],
      [String.raw`pwsh -c "Remove-Item .\.unode -Recurse"`, ON_POSIX],
      [String.raw`cmd /c 'rmdir /s /q .\.unode'`, ON_POSIX],
      [String.raw`cmd /c "rd /s /q .\.git"`, ON_POSIX],
      [String.raw`bash -c "rm -r .git"`, ON_WINDOWS_POWERSHELL],
    ])).toEqual([]);
  });

  it('a raw rm -rf inside a wrapper still matches the catastrophic text pattern', () => {
    expect(all.check(String.raw`sh -c 'rm -rf /'`, ON_CMD).reason).toMatch(/destructive pattern/);
  });

  it('the gate makes a POSIX-wrapped delete a single-use prompt, not a silent run', async () => {
    const root = await protectedFixture();
    await expectOpaqueModeMatrix(String.raw`powershell -Command 'Remove-Item .\.git -Recurse'`, root, root, BASH_SHELL);
    expect(await protectedFoldersIntact(root)).toBe(true);
  });

  it('a wrapper around an ordinary build delete is opaque (a prompt in ask), not silently allowed in allowlist', () => {
    expect(inspectCommand(String.raw`cmd /c 'rmdir /s /q build'`, ON_POSIX.shell).kind).toBe('opaque');
    expect(all.check(String.raw`bash -c "rm -r node_modules"`, ON_WINDOWS_POWERSHELL).allowed).toBe(true);
  });
});

describe('each production caller gives the gate the directory the command runs in', () => {
  const shell = process.platform === 'win32' ? CMD_SHELL : BASH_SHELL;
  const recursiveDelete = (target: string) => process.platform === 'win32' ? `rmdir /s /q "${target}"` : `rm -r "${target}"`;

  it('WorkspaceTools: an agent working in a subfolder cannot delete that folder by its absolute path', async () => {
    const root = await protectedFixture();
    const sub = path.join(root, 'sub');
    await fs.mkdir(sub);
    const executed: string[] = [];
    const provider: CommandExecutionProvider = {
      async acquire() {
        return {
          ok: true, shell, transport: 'terminal', signal: new AbortController().signal,
          async execute(command) { executed.push(command); return { status: 'exited', code: 0, output: 'ok' }; },
          async release() { /* nothing held */ },
        };
      },
    };
    const tools = new WorkspaceTools(root, new Set(['execute']), 'agent', undefined, new CommandPolicy('all'), 120_000,
      undefined, undefined, undefined, provider);
    tools.setTurnWorkspaceAccess({ pathBase: root, commandCwd: sub, readRoots: [root], writeRoots: [root] });
    expect(await tools.run('run_command', { command: recursiveDelete(sub) })).toMatchObject({ status: 'refused', reason: 'consent' });
    expect(executed).toEqual([]);
    // The same agent runs an ordinary delete in its folder, so the refusal above is the guard's.
    await fs.mkdir(path.join(sub, 'build'));
    expect(await tools.run('run_command', { command: recursiveDelete(path.join(sub, 'build')) })).toMatchObject({ status: 'success' });
    expect(executed).toEqual([recursiveDelete(path.join(sub, 'build'))]);
  });

  it('Verifier: a verify command that deletes a protected folder is not run, with or without a policy', async () => {
    const root = await protectedFixture();
    for (const commandPolicy of [new CommandPolicy('all'), undefined]) {
      const prepare = directPreparer(async () => ({ code: 0, output: 'ran' }), shell);
      const verifier = new Verifier({ command: () => recursiveDelete(path.join(root, '.git')), prepare, ...(commandPolicy ? { commandPolicy } : {}) });
      expect(await verifier.verify(root)).toMatchObject({ status: 'skipped', blocked: true });
      expect(prepare.runs).toEqual([]);
    }
  });

  it('run_checks: a verification command that deletes the workspace is not run', async () => {
    const root = await protectedFixture();
    const prepare = directPreparer(async () => ({ code: 0, output: 'ran' }), shell);
    const team = new TeamTools('pm', { list: () => [], resolve: () => undefined }, new MessageBus(), {
      verifyCommand: recursiveDelete(root), cwd: root, commandPolicy: new CommandPolicy('all'), prepareCommand: prepare,
    });
    const outcome = await team.runOutcome('run_checks', {});
    expect(outcome.output).toMatch(/did not confirm this delete/);
    expect(prepare.runs).toEqual([]);
  });
});

describe.runIf(process.platform === 'win32')('S1: the gate reads an 8.3 short name as the folder it names', () => {
  it('refuses a recursive delete of a protected folder by its short name in every mode', async (context) => {
    const root = await protectedFixture();
    const gitShort = shortNameOf(root, '.git');
    const unodeShort = shortNameOf(root, '.unode');
    if (!gitShort || !unodeShort) {
      context.skip('this volume does not generate 8.3 short names');
    }
    for (const command of [`rmdir /s /q ${gitShort}`, `rd /s /q ${unodeShort}`, `Remove-Item -Recurse -Force ${gitShort}`]) {
      await expectConfirmedInEveryMode(command, root, root, CMD_SHELL);
    }
    expect(await protectedFoldersIntact(root)).toBe(true);
  });

  it('still allows an ordinary folder by its short name', async (context) => {
    const root = await protectedFixture();
    await fs.mkdir(path.join(root, 'build-output-folder'));
    const short = shortNameOf(root, 'build-output-folder');
    if (!short) {
      context.skip('this volume does not generate 8.3 short names');
    }
    await expect(gate(`rmdir /s /q ${short}`, root, root, CMD_SHELL, all)).resolves.toEqual({ ok: true });
  });
});
