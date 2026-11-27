import { describe, expect, it } from 'vitest';
import {
  autoAllowSegments,
  boundedShellLabel,
  commandShellIdentity,
  declaredDirectShellIdentity,
  describeShell,
  posixShellKindFromBasename,
  reviewedSafeApprovalKeys,
  sameShellIdentity,
  SessionCommandApprovals,
  shellCompatibilityProblem,
  shellHintGrammar,
  templateRunsUnder,
} from '../CommandShell';
import { SAFE_COMMAND_TEMPLATES } from '../CommandPolicy';
import { BASH_SHELL, CMD_SHELL, NEUTRAL_SHELL, PWSH_SHELL, SH_SHELL, WINDOWS_POWERSHELL_SHELL } from './shellFixtures';

describe('CommandShell identity (v0.9.96)', () => {
  it('maps every admitted kind to its grammar, and an unproved provider shell to the neutral grammar', () => {
    const grammars = Object.fromEntries(([
      'cmd', 'windows-powershell', 'pwsh', 'bash', 'zsh', 'sh', 'dash', 'ksh', 'wsl', 'provider-unknown',
    ] as const).map((kind) => [kind, commandShellIdentity(kind, 'terminal-probe').grammar]));
    expect(grammars).toEqual({
      cmd: 'cmd',
      'windows-powershell': 'powershell',
      pwsh: 'powershell',
      bash: 'posix',
      zsh: 'posix',
      sh: 'posix',
      dash: 'posix',
      ksh: 'posix',
      wsl: 'posix',
      'provider-unknown': 'neutral',
    });
  });

  it('reads a profile name or executable only as a grammar hint, and never calls fish or a wrapper POSIX', () => {
    expect(shellHintGrammar('Command Prompt')).toBe('cmd');
    expect(shellHintGrammar('C:\\Windows\\System32\\cmd.exe')).toBe('cmd');
    expect(shellHintGrammar('PowerShell')).toBe('powershell');
    expect(shellHintGrammar('Windows PowerShell')).toBe('powershell');
    expect(shellHintGrammar('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell');
    expect(shellHintGrammar('Git Bash')).toBe('posix');
    expect(shellHintGrammar('/bin/zsh')).toBe('posix');
    expect(shellHintGrammar('Ubuntu (WSL)')).toBe('posix');
    expect(shellHintGrammar('C:\\Windows\\System32\\wsl.exe')).toBe('posix');
    for (const unsupported of ['fish', '/usr/bin/fish', 'nu', 'xonsh', 'tmux', 'JavaScript Debug Terminal']) {
      expect(shellHintGrammar(unsupported), unsupported).toBe('unsupported');
    }
    expect(shellHintGrammar(undefined)).toBeUndefined();
    expect(shellHintGrammar('   ')).toBeUndefined();
  });

  it('admits a probed POSIX basename, also a login shell, and nothing else', () => {
    expect(posixShellKindFromBasename('bash')).toBe('bash');
    expect(posixShellKindFromBasename('-bash')).toBe('bash');
    expect(posixShellKindFromBasename('/usr/bin/zsh')).toBe('zsh');
    expect(posixShellKindFromBasename('-zsh')).toBe('zsh');
    expect(posixShellKindFromBasename('dash')).toBe('dash');
    expect(posixShellKindFromBasename('ksh')).toBe('ksh');
    expect(posixShellKindFromBasename('sh')).toBe('sh');
    expect(posixShellKindFromBasename('bash.exe')).toBe('bash');
    for (const other of ['fish', '--bash', 'nu', 'python', '', undefined]) {
      expect(posixShellKindFromBasename(other), String(other)).toBeUndefined();
    }
  });

  it('keeps labels short and printable, and never lets a path or arguments into one', () => {
    expect(boundedShellLabel('Git Bash', 'bash')).toBe('Git Bash');
    expect(boundedShellLabel('C:\\Program Files\\Git\\bin\\bash.exe', 'bash')).toBe('bash');
    expect(boundedShellLabel('/usr/bin/zsh', 'zsh')).toBe('zsh');
    expect(boundedShellLabel('pwsh -NoLogo', 'PowerShell')).toBe('PowerShell');
    expect(boundedShellLabel('x'.repeat(200), 'sh')).toHaveLength(40);
    expect(boundedShellLabel(undefined, 'cmd.exe')).toBe('cmd.exe');
  });

  it('tells two identities apart by kind and fingerprint, never by label', () => {
    const a = commandShellIdentity('pwsh', 'terminal-probe', { fingerprint: ['generation', 1] });
    const sameShell = commandShellIdentity('pwsh', 'terminal-probe', { label: 'other label', fingerprint: ['generation', 1] });
    const nextTerminal = commandShellIdentity('pwsh', 'terminal-probe', { fingerprint: ['generation', 2] });
    expect(sameShellIdentity(a, sameShell)).toBe(true);
    expect(sameShellIdentity(a, nextTerminal)).toBe(false);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(describeShell(CMD_SHELL)).toBe('cmd.exe (cmd grammar)');
  });

  it('declares cmd.exe as the direct fallback on Windows and sh elsewhere', () => {
    expect(declaredDirectShellIdentity('win32')).toMatchObject({ kind: 'cmd', grammar: 'cmd', source: 'direct-fallback', label: 'cmd.exe' });
    for (const platform of ['linux', 'darwin'] as const) {
      expect(declaredDirectShellIdentity(platform)).toMatchObject({ kind: 'sh', grammar: 'posix', source: 'direct-fallback', label: 'sh' });
    }
  });
});

describe('CommandShell dialect adapters (v0.9.96)', () => {
  it('splits a chain only at the separators its own grammar admits', () => {
    expect(autoAllowSegments('npm test && npm run lint', CMD_SHELL)).toEqual(['npm test', 'npm run lint']);
    expect(autoAllowSegments('npm test; npm run lint', CMD_SHELL)).toBeUndefined();
    expect(autoAllowSegments('npm test; npm run lint', WINDOWS_POWERSHELL_SHELL)).toEqual(['npm test', 'npm run lint']);
    expect(autoAllowSegments('npm test && npm run lint', WINDOWS_POWERSHELL_SHELL)).toBeUndefined();
    expect(autoAllowSegments('npm test && npm run lint', PWSH_SHELL)).toEqual(['npm test', 'npm run lint']);
    expect(autoAllowSegments('npm test; npm run lint', PWSH_SHELL)).toEqual(['npm test', 'npm run lint']);
    expect(autoAllowSegments('npm test && npm run lint; git status', BASH_SHELL)).toEqual(['npm test', 'npm run lint', 'git status']);
    // An unverified shell admits one simple command and no chain at all.
    expect(autoAllowSegments('npm test', NEUTRAL_SHELL)).toEqual(['npm test']);
    expect(autoAllowSegments('npm test && npm run lint', NEUTRAL_SHELL)).toBeUndefined();
    expect(autoAllowSegments('npm test; npm run lint', NEUTRAL_SHELL)).toBeUndefined();
  });

  it('never auto-allows expansion, substitution, redirection, pipes, newlines or an open quote, in any grammar', () => {
    const cases: Array<[string, typeof CMD_SHELL]> = [
      ['npm test %EVIL%', CMD_SHELL],
      ['npm test ^& del x', CMD_SHELL],
      ['npm test > out.txt', CMD_SHELL],
      ['npm test | more', CMD_SHELL],
      ['npm test (x)', CMD_SHELL],
      ['npm test $env:EVIL', WINDOWS_POWERSHELL_SHELL],
      ['npm test $(Remove-Item x)', WINDOWS_POWERSHELL_SHELL],
      ['npm test (Remove-Item x)', WINDOWS_POWERSHELL_SHELL],
      ['npm test @args', WINDOWS_POWERSHELL_SHELL],
      ['npm test `n', WINDOWS_POWERSHELL_SHELL],
      ['npm test { x }', PWSH_SHELL],
      ['npm test $(npm publish)', BASH_SHELL],
      ['npm test `npm publish`', BASH_SHELL],
      ['npm test ${HOME}', BASH_SHELL],
      ['npm test !!', BASH_SHELL],
      ['npm test & npm publish', BASH_SHELL],
      ['(npm publish)', BASH_SHELL],
      ['npm test\nnpm publish', BASH_SHELL],
      ['npm test "unterminated', BASH_SHELL],
      ["npm test 'unterminated", WINDOWS_POWERSHELL_SHELL],
      ['npm test "unterminated', CMD_SHELL],
      ['npm test &&', BASH_SHELL],
      ['npm test $HOME', NEUTRAL_SHELL],
      ['npm test *', NEUTRAL_SHELL],
      ['npm test ~', NEUTRAL_SHELL],
      ['npm test %X%', NEUTRAL_SHELL],
    ];
    for (const [command, shell] of cases) {
      expect(autoAllowSegments(command, shell), `${command} in ${shell.kind}`).toBeUndefined();
    }
  });

  it('refuses a PowerShell cmdlet outside PowerShell and names the shell, its grammar and an equivalent', () => {
    expect(shellCompatibilityProblem('Copy-Item a b', WINDOWS_POWERSHELL_SHELL)).toBeUndefined();
    expect(shellCompatibilityProblem('Copy-Item a b', PWSH_SHELL)).toBeUndefined();
    expect(shellCompatibilityProblem('Copy-Item a b', CMD_SHELL)).toEqual({
      construct: 'copy-item',
      message: '"copy-item" is a PowerShell cmdlet, but this command runs in cmd.exe (cmd grammar), so it would never '
        + 'succeed. Use the cmd.exe equivalent (copy or xcopy).',
    });
    expect(shellCompatibilityProblem('Get-ChildItem', BASH_SHELL)?.message).toBe(
      '"get-childitem" is a PowerShell cmdlet, but this command runs in bash (posix grammar), so it would never '
      + 'succeed. Use the POSIX shell equivalent (ls).',
    );
    expect(shellCompatibilityProblem('Start-Sleep -Seconds 3', SH_SHELL)?.message).toContain('(sleep 3)');
    expect(shellCompatibilityProblem('git-lfs pull', CMD_SHELL)).toBeUndefined();
    // An unverified shell has no executor facts to refuse with.
    expect(shellCompatibilityProblem('Copy-Item a b', NEUTRAL_SHELL)).toBeUndefined();
  });

  it('refuses && and || in Windows PowerShell, outside quotes only, and offers ; or two calls', () => {
    const problem = shellCompatibilityProblem('npm test && npm run lint', WINDOWS_POWERSHELL_SHELL);
    expect(problem).toEqual({
      construct: '&&',
      message: '"&&" is not a command separator in Windows PowerShell (powershell grammar), so this command would not '
        + 'parse. Use ";" to run the commands one after another, or make two calls when the second must run only if '
        + 'the first succeeds.',
    });
    expect(shellCompatibilityProblem('npm test || exit 1', WINDOWS_POWERSHELL_SHELL)?.construct).toBe('||');
    expect(shellCompatibilityProblem('git commit -m "a && b"', WINDOWS_POWERSHELL_SHELL)).toBeUndefined();
    expect(shellCompatibilityProblem("git commit -m 'it''s a && b'", WINDOWS_POWERSHELL_SHELL)).toBeUndefined();
    expect(shellCompatibilityProblem('npm test && npm run lint', PWSH_SHELL)).toBeUndefined();
    expect(shellCompatibilityProblem('npm test && npm run lint', CMD_SHELL)).toBeUndefined();
  });

  it('lets a stored template run only under a grammar that can run it', () => {
    expect(templateRunsUnder('copy-item', 'powershell')).toBe(true);
    expect(templateRunsUnder('copy-item', 'cmd')).toBe(false);
    expect(templateRunsUnder('copy-item', 'posix')).toBe(false);
    expect(templateRunsUnder('copy-item', 'neutral')).toBe(false);
    expect(templateRunsUnder('npm test', 'cmd')).toBe(true);
    expect(templateRunsUnder('npm test', 'neutral')).toBe(true);
  });

  it('turns the reviewed safe list into keys for all three persisted grammars, each holding what it can run', () => {
    const keys = reviewedSafeApprovalKeys([...SAFE_COMMAND_TEMPLATES, 'Copy-Item']);
    const byGrammar = (grammar: string) => keys.filter((key) => key.grammar === grammar).map((key) => key.template);
    expect(byGrammar('cmd')).toEqual([...SAFE_COMMAND_TEMPLATES]);
    expect(byGrammar('posix')).toEqual([...SAFE_COMMAND_TEMPLATES]);
    expect(byGrammar('powershell')).toEqual([...SAFE_COMMAND_TEMPLATES, 'copy-item']);
    expect(keys.some((key) => (key.grammar as string) === 'neutral' || (key.grammar as string) === 'any')).toBe(false);
  });

  it('remembers a session approval for its grammar only, and never for an unverified shell', () => {
    const session = new SessionCommandApprovals();
    expect(session.add('powershell', 'Copy-Item')).toBe(true);
    expect(session.has('powershell', 'copy-item')).toBe(true);
    expect(session.has('cmd', 'copy-item')).toBe(false);
    expect(session.has('posix', 'copy-item')).toBe(false);
    expect(session.add('neutral', 'npm test')).toBe(false);
    expect(session.has('neutral', 'npm test')).toBe(false);
  });
});
