import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { CommandPolicy } from '../CommandPolicy';
import { AgentCommandPolicy } from '../AgentCommandPolicy';
import { commandShellIdentity } from '../CommandShell';
import { type CommandApprovalContext, detectOutsideRootPath, gateShellCommand, msysDrivePath } from '../ShellCommandGate';
import { BASH_SHELL, CMD_SHELL, PWSH_SHELL, WINDOWS_POWERSHELL_SHELL } from './shellFixtures';

const ROOT = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';

describe('gateShellCommand under the prepared shell (v0.9.96)', () => {
  it.each(['allowlist', 'ask', 'all'] as const)('dangerous deletes need a fresh exact confirmation in %s', async (mode) => {
    const policy = new CommandPolicy(mode);
    const opts = { command: 'rm -rf output', roots: ROOT, cwd: ROOT, source: 'model' as const, shell: BASH_SHELL, commandPolicy: policy };
    const approve = vi.fn(async () => ({ allow: true }));
    await expect(gateShellCommand({ ...opts, requestApproval: approve })).resolves.toEqual({ ok: true });
    await expect(gateShellCommand({ ...opts, source: 'config', requestApproval: approve })).resolves.toEqual({ ok: true });
    expect(approve).toHaveBeenCalledTimes(2);
    expect(approve).toHaveBeenLastCalledWith(opts.command, expect.objectContaining({ cwd: ROOT, dangerous: true, singleUse: true, forcePrompt: true }));
    await expect(gateShellCommand(opts)).resolves.toMatchObject({ ok: false, message: 'The user did not confirm this delete.' });
    await expect(gateShellCommand({ ...opts, requestApproval: async () => ({ allow: false }) })).resolves.toMatchObject({ ok: false });
  });
  it.each(['rm -rf .', 'echo hello'])('Disabled refuses %s without asking and emits exactly one visible line', async command => {
    const requestApproval = vi.fn(async () => ({ allow: true })); const onCommandDisabled = vi.fn();
    const result = await gateShellCommand({ command, roots: ROOT, cwd: ROOT, source: 'model', shell: BASH_SHELL,
      commandPolicy: new CommandPolicy('none'), requestApproval, onCommandDisabled });
    expect(result).toMatchObject({ ok: false, kind: 'policy' });
    expect(requestApproval).not.toHaveBeenCalled(); expect(onCommandDisabled).toHaveBeenCalledTimes(1);
    expect(onCommandDisabled.mock.calls[0][0]).toContain(command);
    expect(onCommandDisabled.mock.calls[0][0]).toContain('Automatic or Ask each at the bottom');
    expect(onCommandDisabled.mock.calls[0][0]).toContain(JSON.stringify(ROOT));
  });
  it('keeps the dangerous flag through agent narrowing and refuses Stop after confirmation', async () => {
    const commandPolicy = new AgentCommandPolicy(new CommandPolicy('all'), { approvalMode: 'ask', allowedCommands: [] }, 'Ada');
    const command = 'rm -rf .';
    expect(commandPolicy.check(command, { shell: BASH_SHELL })).toMatchObject({ dangerous: true });
    const abort = new AbortController(); const requestApproval = vi.fn(async () => { abort.abort(); return { allow: true }; });
    expect(await gateShellCommand({ command, roots: ROOT, cwd: ROOT, source: 'model', shell: BASH_SHELL,
      commandPolicy, requestApproval, signal: abort.signal })).toMatchObject({ ok: false, kind: 'approval' });
    expect(requestApproval).toHaveBeenCalledWith(command, expect.objectContaining({ dangerous: true, singleUse: true, forcePrompt: true }));
  });
  it('refuses a cmdlet before any approval opens when cmd.exe runs it, and asks when PowerShell does', async () => {
    const requestApproval = vi.fn(async () => ({ allow: true }));
    const policy = new CommandPolicy('ask', []);
    const underCmd = await gateShellCommand({ command: 'Copy-Item a b', roots: ROOT, cwd: ROOT, source: 'model', shell: CMD_SHELL, commandPolicy: policy, requestApproval });
    expect(underCmd).toMatchObject({ ok: false, kind: 'shell-compatibility' });
    expect(underCmd.ok ? '' : underCmd.message).toMatch(/runs in cmd\.exe \(cmd grammar\).*copy or xcopy/);
    expect(requestApproval).not.toHaveBeenCalled();

    const underPowerShell = await gateShellCommand({ command: 'Copy-Item a b', roots: ROOT, cwd: ROOT, source: 'model', shell: WINDOWS_POWERSHELL_SHELL, commandPolicy: policy, requestApproval });
    expect(underPowerShell).toEqual({ ok: true });
    expect(requestApproval).toHaveBeenCalledWith('Copy-Item a b', { shell: WINDOWS_POWERSHELL_SHELL });
  });

  it('refuses && in Windows PowerShell before approval, and lets pwsh ask for it', async () => {
    const requestApproval = vi.fn(async () => ({ allow: true }));
    const policy = new CommandPolicy('ask', []);
    const legacy = await gateShellCommand({ command: 'npm test && npm run lint', roots: ROOT, cwd: ROOT, source: 'model', shell: WINDOWS_POWERSHELL_SHELL, commandPolicy: policy, requestApproval });
    expect(legacy).toMatchObject({ ok: false, kind: 'shell-compatibility' });
    expect(legacy.ok ? '' : legacy.message).toMatch(/Use ";" to run the commands one after another, or make two calls/);
    expect(requestApproval).not.toHaveBeenCalled();
    await expect(gateShellCommand({ command: 'npm test && npm run lint', roots: ROOT, cwd: ROOT, source: 'model', shell: PWSH_SHELL, commandPolicy: policy, requestApproval }))
      .resolves.toEqual({ ok: true });
  });

  it('keeps a catastrophic denial dominant over compatibility guidance', async () => {
    const result = await gateShellCommand({
      command: 'Remove-Item -Recurse .git', roots: ROOT, cwd: ROOT, source: 'model', shell: CMD_SHELL,
      commandPolicy: new CommandPolicy('all', []), requestApproval: vi.fn(),
    });
    expect(result).toMatchObject({ ok: false, kind: 'approval', message: 'The user did not confirm this delete.' });
  });

  it('hands the approval its shell, the preparation notice and the lifecycle signal', async () => {
    const seen: CommandApprovalContext[] = [];
    const signal = new AbortController().signal;
    await gateShellCommand({
      command: 'npm run deploy', roots: ROOT, cwd: ROOT, source: 'model', shell: CMD_SHELL,
      notice: 'The selected terminal profile could not prove shell integration and cwd. This invocation will use the declared direct fallback: cmd.exe.',
      signal,
      commandPolicy: new CommandPolicy('ask', []),
      requestApproval: async (_command, context) => { seen.push(context); return { allow: true }; },
    });
    expect(seen).toEqual([{
      shell: CMD_SHELL,
      warning: 'The selected terminal profile could not prove shell integration and cwd. This invocation will use the declared direct fallback: cmd.exe.',
      signal,
    }]);
  });

  it('reports a prompt the host withdrew as not run, never as a refusal by the user', async () => {
    for (const source of ['model', 'config'] as const) {
      const result = await gateShellCommand({
        command: 'npm run deploy', roots: ROOT, cwd: ROOT, source, shell: BASH_SHELL,
        commandPolicy: new CommandPolicy('ask', []),
        requestApproval: async () => ({ allow: false, withdrawn: true }),
      });
      expect(result).toMatchObject({ ok: false, kind: 'approval' });
      expect(result.ok ? '' : result.message, source).toBe('Command not run: its approval was withdrawn because the agent was stopped, restarted or removed.');
      expect(result.ok ? '' : result.message).not.toMatch(/user/);
    }
  });
});

describe('detectOutsideRootPath with a shell identity (v0.9.96)', () => {
  const gitBash = commandShellIdentity('bash', 'terminal-probe', { label: 'Git Bash' });
  const windows = { platform: 'win32' as const, pathApi: path.win32 };

  it('maps only the MSYS drive form /c/... for an identified bash on a Windows host', () => {
    expect(msysDrivePath('/c/Users/me/secret.txt')).toBe('C:\\Users\\me\\secret.txt');
    expect(msysDrivePath('/d')).toBe('D:\\');
    expect(msysDrivePath('/mnt/c/Users')).toBeUndefined();
    expect(msysDrivePath('/dev/null')).toBeUndefined();

    expect(detectOutsideRootPath('cat /c/Users/me/secret.txt', 'C:\\work\\project', { shell: gitBash, ...windows }))
      .toBe('C:\\Users\\me\\secret.txt');
    expect(detectOutsideRootPath('cat /c/work/project/src/a.ts', 'C:\\work\\project', { shell: gitBash, ...windows }))
      .toBeUndefined();
  });

  it('does not guess WSL paths, shell expansions, or a drive form under another shell', () => {
    // Without the mapping, /c/work/project/... is not the project folder; it stays an outside path. (The drive a
    // rooted path resolves to depends on the host's current directory, so only the path part is pinned.)
    expect(detectOutsideRootPath('cat /c/work/project/a.ts', 'C:\\work\\project', { shell: CMD_SHELL, ...windows }))
      .toMatch(/\\c\\work\\project\\a\.ts$/);
    const wsl = commandShellIdentity('wsl', 'terminal-probe');
    expect(detectOutsideRootPath('cat /mnt/c/work/project/a.ts', 'C:\\work\\project', { shell: wsl, ...windows }))
      .toMatch(/\\mnt\\c\\work\\project\\a\.ts$/);
    // On a non-Windows host the identified bash keeps the plain POSIX reading.
    expect(detectOutsideRootPath('cat /c/x/y', '/work/project', { shell: gitBash, platform: 'linux', pathApi: path.posix }))
      .toBe('/c/x/y');
    // Expansions are not paths the detector can read; it never invents one.
    for (const command of ['cat ~/secret', 'cat $HOME/secret', 'type %USERPROFILE%\\secret', 'Get-Content $env:USERPROFILE\\secret']) {
      expect(detectOutsideRootPath(command, 'C:\\work\\project', { shell: gitBash, ...windows }), command).toBeUndefined();
    }
  });
});
