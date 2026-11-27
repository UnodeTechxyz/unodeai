import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ workspace: { getConfiguration: () => ({ get: () => undefined }) }, env: { shell: '' } }));

import { terminalProfileHint } from './TerminalShellProfile';

describe('terminalProfileHint (v0.9.96)', () => {
  it('reads a grammar hint from the profile source, then its path, then a known name, then the default shell', () => {
    expect(terminalProfileHint({ defaultProfile: 'PowerShell', profile: { source: 'PowerShell' } }).grammar).toBe('powershell');
    expect(terminalProfileHint({ defaultProfile: 'Git Bash', profile: { source: 'Git Bash' } })).toMatchObject({ grammar: 'posix', label: 'Git Bash' });
    expect(terminalProfileHint({ defaultProfile: 'Dev', profile: { path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' } }).grammar).toBe('powershell');
    expect(terminalProfileHint({ defaultProfile: 'Command Prompt', profile: { path: ['C:\\WINDOWS\\System32\\cmd.exe'] } }).grammar).toBe('cmd');
    expect(terminalProfileHint({ defaultProfile: 'zsh' }).grammar).toBe('posix');
    expect(terminalProfileHint({ envShell: '/bin/bash' }).grammar).toBe('posix');
  });

  it('names the shell kind from the profile path, else from VS Code\'s default shell, only when it agrees with the grammar', () => {
    // VS Code reports its resolved default shell, which is what an automatic "PowerShell" profile starts.
    expect(terminalProfileHint({ envShell: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' })).toMatchObject({ grammar: 'powershell', kind: 'windows-powershell' });
    expect(terminalProfileHint({ defaultProfile: 'PowerShell', profile: { source: 'PowerShell' }, envShell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }).kind).toBe('pwsh');
    expect(terminalProfileHint({ defaultProfile: 'Git Bash', profile: { source: 'Git Bash' }, envShell: 'C:\\Program Files\\Git\\bin\\bash.exe' }).kind).toBe('bash');
    expect(terminalProfileHint({ defaultProfile: 'Dev', profile: { path: '/usr/bin/zsh' } }).kind).toBe('zsh');
    expect(terminalProfileHint({ envShell: '/bin/bash' }).kind).toBe('bash');
    expect(terminalProfileHint({ defaultProfile: 'Command Prompt', profile: { path: ['C:\\WINDOWS\\System32\\cmd.exe'] } }).kind).toBe('cmd');
    // A "PowerShell" profile with no executable to say which one names no kind; nor does a default shell of another grammar.
    expect(terminalProfileHint({ defaultProfile: 'PowerShell', profile: { source: 'PowerShell' } }).kind).toBeUndefined();
    expect(terminalProfileHint({ defaultProfile: 'PowerShell', profile: { source: 'PowerShell' }, envShell: '/bin/bash' }).kind).toBeUndefined();
    expect(terminalProfileHint({ defaultProfile: 'My Dev Shell', envShell: '/bin/bash' }).kind).toBeUndefined();
  });

  it('gives no hint for an unknown custom name, and calls an unknown shell executable unsupported', () => {
    expect(terminalProfileHint({ defaultProfile: 'My Dev Shell' }).grammar).toBeUndefined();
    expect(terminalProfileHint({ defaultProfile: 'fish', profile: { path: '/usr/bin/fish' } }).grammar).toBe('unsupported');
    expect(terminalProfileHint({ envShell: '/usr/local/bin/nu' }).grammar).toBe('unsupported');
    expect(terminalProfileHint({}).grammar).toBeUndefined();
  });

  it('recognizes a WSL profile, and keeps paths out of the label and the fingerprint', () => {
    const wsl = terminalProfileHint({ defaultProfile: 'Ubuntu (WSL)', profile: { path: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'] } });
    expect(wsl).toMatchObject({ grammar: 'posix', wsl: true });
    const a = terminalProfileHint({ defaultProfile: 'Dev', profile: { path: 'C:\\Users\\me\\secret\\pwsh.exe' } });
    const b = terminalProfileHint({ defaultProfile: 'Dev', profile: { path: 'D:\\other\\pwsh.exe' } });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.label ?? '').not.toMatch(/[\\/]/);
    expect(terminalProfileHint({ defaultProfile: 'Git Bash' }).fingerprint).not.toBe(terminalProfileHint({ defaultProfile: 'PowerShell' }).fingerprint);
  });
});
