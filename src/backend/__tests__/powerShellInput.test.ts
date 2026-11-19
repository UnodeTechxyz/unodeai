import { describe, expect, it } from 'vitest';
import { powerShellInputIncomplete } from '../powerShellInput';
import { WorkspaceTools } from '../WorkspaceTools';
import { CommandPolicy } from '../CommandPolicy';
import { asProvider, BASH_SHELL, WINDOWS_POWERSHELL_SHELL } from './shellFixtures';
import * as os from 'node:os';

// Each answer below was checked against PowerShell's own parser. A wider comparison of 2,540 generated commands found
// no command this scan calls open that the parser does not.
describe('whether PowerShell would wait for more input', () => {
  it.each([
    // The field command (T3): \\" escapes nothing, so the string runs on past the end.
    [`node -e "const q=JSON.parse('\\"'); console.log(q);"`, true],
    [`echo it's`, true],
    [`echo "a`, true],
    [`echo 'a`, true],
    [`echo \u201ca`, true],
    [`echo "a"b"`, true],
  ])('open: %s', (command, expected) => {
    expect(powerShellInputIncomplete(command)).toBe(expected);
  });

  it.each([
    'npm test', 'git diff --no-pager', 'echo "a"', `echo 'a''b'`, 'echo "a""b"', 'echo `"', 'echo "`""',
    '# only "a comment', 'echo a # it\'s a comment', 'echo "$(echo "x")"', "@'\nabc\n'@", 'echo a(b', `node --% -e "a`,
    // Audit of 35f593f8: each of these is complete to PowerShell's own parser.
    'Write-Output ok <# a " in a block comment #>', `Write-Output ok <# it's a comment #>`, '<# " #> echo a',
    'echo a <# one " #> <# two " #>',
  ])('complete, or left to the shell: %s', (command) => {
    expect(powerShellInputIncomplete(command)).toBe(false);
  });
});

describe('a subexpression', () => {
  it('holds quotes of its own, so it is left to the shell', () => {
    expect(powerShellInputIncomplete('echo "$(echo \'it"s\')"')).toBe(false);
  });
});

describe('run_command with a command PowerShell would wait on', () => {
  const tools = (shell: typeof BASH_SHELL, runs: string[]) => new WorkspaceTools(os.tmpdir(), new Set(['read', 'execute']), 'agent', undefined,
    new CommandPolicy('all'), undefined, undefined, undefined, undefined,
    asProvider(async (command) => { runs.push(command); return { code: 0, output: 'ran' }; }, shell));

  it('does not start it, and says why at once', async () => {
    const runs: string[] = [];
    const result = await tools(WINDOWS_POWERSHELL_SHELL, runs).run('run_command', { command: 'node -e "a\\"b"' });
    expect(result.status).toBe('failed');
    expect(String(result.output)).toContain('PowerShell would wait for more input');
    expect(runs).toEqual([]);
  });

  it('leaves other shells to their own rules', async () => {
    const runs: string[] = [];
    await tools(BASH_SHELL, runs).run('run_command', { command: 'echo "ok' });
    expect(runs).toEqual(['echo "ok']);
  });
});
