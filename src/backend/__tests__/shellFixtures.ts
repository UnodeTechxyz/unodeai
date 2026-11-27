/* Shell identities for tests. Every command check names the shell that would run it (v0.9.96). */
import type { CommandExecResult, CommandExecutionProvider, PrepareDirectCommand, PreparedCommandExecution, PreparedDirectCommand } from '../CommandExecution';
import { type CommandShellIdentity, commandShellIdentity } from '../CommandShell';

export const CMD_SHELL = commandShellIdentity('cmd', 'direct-fallback', { fingerprint: ['test'] });
export const WINDOWS_POWERSHELL_SHELL = commandShellIdentity('windows-powershell', 'terminal-probe', { fingerprint: ['test'] });
export const PWSH_SHELL = commandShellIdentity('pwsh', 'terminal-probe', { fingerprint: ['test'] });
export const BASH_SHELL = commandShellIdentity('bash', 'terminal-probe', { fingerprint: ['test'] });
export const SH_SHELL = commandShellIdentity('sh', 'direct-fallback', { fingerprint: ['test'] });
export const NEUTRAL_SHELL = commandShellIdentity('provider-unknown', 'native-provider-command', { fingerprint: ['test'] });

/** Check options for a POSIX shell, the grammar whose chain rules match the pre-v0.9.96 policy. */
export const ON_POSIX = { shell: BASH_SHELL } as const;
export const ON_CMD = { shell: CMD_SHELL } as const;
export const ON_WINDOWS_POWERSHELL = { shell: WINDOWS_POWERSHELL_SHELL } as const;
export const ON_PWSH = { shell: PWSH_SHELL } as const;
export const ON_NEUTRAL = { shell: NEUTRAL_SHELL } as const;

/** The shape of a pre-v0.9.96 test runner: what it returns becomes a typed result. */
export type LegacyRun = (command: string, opts: { cwd: string; timeoutMs: number }) =>
  Promise<{ code: number | null; output: string; timedOut?: boolean; error?: string } | CommandExecResult>;

function typed(result: Awaited<ReturnType<LegacyRun>>): CommandExecResult {
  if ('status' in result) return result;
  if (result.error !== undefined) return { status: 'not-started', code: null, reason: 'spawn-failed', output: `Failed to start the command: ${result.error}` };
  if (result.timedOut) return { status: 'timed-out', code: null, stopConfirmed: true, output: result.output };
  return { status: 'exited', code: result.code, output: result.output };
}

/**
 * A provider whose prepared execution calls `run` once. It records what was acquired and released, so a test
 * can pin that every preparation is released and nothing runs twice.
 */
export function asProvider(run: LegacyRun, shell: CommandShellIdentity = BASH_SHELL):
  CommandExecutionProvider & { acquired: Array<{ cwd: string }>; released: number } {
  const provider = {
    acquired: [] as Array<{ cwd: string }>,
    released: 0,
    async acquire(opts: { cwd: string }): Promise<PreparedCommandExecution> {
      provider.acquired.push(opts);
      let used = false;
      return {
        ok: true,
        shell,
        transport: 'direct',
        signal: new AbortController().signal,
        async execute(command: string, timeoutMs: number) {
          if (used) throw new Error('a prepared execution ran twice');
          used = true;
          return typed(await run(command, { cwd: opts.cwd, timeoutMs }));
        },
        async release() { provider.released += 1; },
      };
    },
  };
  return provider;
}

/**
 * A direct-shell preparer whose one prepared command calls `run`. It records each preparation, so a test can pin
 * that the gate and the execution used ONE preparation and its identity.
 */
export function directPreparer(run: LegacyRun, shell: CommandShellIdentity = CMD_SHELL):
  PrepareDirectCommand & { prepared: number; runs: Array<{ command: string; cwd: string; timeoutMs?: number; maxOutputChars?: number }> } {
  const runs: Array<{ command: string; cwd: string; timeoutMs?: number; maxOutputChars?: number }> = [];
  const prepare = (() => {
    prepare.prepared += 1;
    let used = false;
    const prepared: PreparedDirectCommand = {
      ok: true,
      shell,
      async execute(command, opts) {
        if (used) throw new Error('a prepared command ran twice');
        used = true;
        runs.push({ command, cwd: opts.cwd, timeoutMs: opts.timeoutMs, maxOutputChars: opts.maxOutputChars });
        return typed(await run(command, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 0 }));
      },
      startBackground() { return { ok: false, error: 'not in this test' }; },
    };
    return prepared;
  }) as PrepareDirectCommand & { prepared: number; runs: typeof runs };
  prepare.prepared = 0;
  prepare.runs = runs;
  return prepare;
}
