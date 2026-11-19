/*---------------------------------------------------------------------------------------------
 * v0.9.97: one bounded run of Windows PowerShell with a fixed script.
 *
 * The host asks Windows itself for facts it cannot read from Node (publisher signatures, the process list). The
 * program is the system's own `powershell.exe`, found from `SystemRoot`, never from PATH or the current folder, and
 * refused when it lies inside a workspace or a worktree. The script is a source constant passed with
 * `-EncodedCommand`, so no script file exists on disk and no execution policy applies. Input travels only through one
 * environment variable, as base64, so paths never appear on the command line and no code page can change them. The
 * environment is exactly the allowlist below: a user or project `PSModulePath` could otherwise shadow the modules the
 * script calls. Every failure is an answer of its own, `unavailable` with a reason; nothing here is ever a pass.
 *--------------------------------------------------------------------------------------------*/

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as path from 'node:path';
import { killProcessTree } from '../backend/processTree';
import {
  resolveHostExecutable,
  type HostExecutableResolutionOptions,
} from '../security/HostExecutableResolver';

/** The arguments before the encoded script, in this order and no others. */
export const WINDOWS_POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-EncodedCommand'] as const;

/** A drive-letter Windows folder directly below the drive root, as `SystemRoot` always is (`C:\Windows`). */
export const SYSTEM_ROOT_PATTERN = /^[A-Za-z]:\\[^\\/:*?"<>|]+$/;

/** How much of stderr is kept. It is a diagnostic only and never decides anything. */
export const WINDOWS_POWERSHELL_STDERR_LIMIT = 2 * 1024;

/** The environment names the runner sets itself; an input variable may not take one of them. */
const FIXED_ENVIRONMENT_NAMES = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PSModulePath'] as const;

/** The form `-EncodedCommand` takes: base64 of the script's UTF-16LE bytes. */
export function encodePowerShellScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`. */
export function windowsPowerShellPath(systemRoot: string): string {
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** The system modules folder, the only `PSModulePath` the script sees. */
export function windowsPowerShellModulePath(systemRoot: string): string {
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
}

/** The complete environment of a run: these six names and nothing else. */
export function windowsPowerShellEnvironment(
  systemRoot: string,
  tmp: string,
  inputVariable: string,
  input: string,
): Record<string, string> {
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    TEMP: tmp,
    TMP: tmp,
    PSModulePath: windowsPowerShellModulePath(systemRoot),
    [inputVariable]: input,
  };
}

export interface WindowsPowerShellRequest {
  /** The fixed script, already in the form of `encodePowerShellScript`. */
  encodedCommand: string;
  /** The one variable that carries the input, for example `UNODE_AC_INPUT`. */
  inputVariable: string;
  /** The input, base64. */
  input: string;
  /** The longest input this caller allows, in characters; a longer one is not run. */
  maxInputChars: number;
  /** A folder the caller owns: the run's working folder. */
  cwd: string;
  /** A folder the caller owns: TEMP and TMP. */
  tmp: string;
  /** The run is stopped, with its process tree, after this long. */
  timeoutMs: number;
  /** More stdout than this stops the run. */
  maxStdoutBytes: number;
  /** PowerShell inside one of these is refused. */
  workspaceRoots?: readonly string[];
  worktreeRoots?: readonly string[];
}

/**
 * Why a run gave no answer. `not-found`: not Windows, no valid `SystemRoot`, or no usable `powershell.exe` there.
 * `spawn-failed`: Windows did not start it. `timeout` and `output-limit`: it was stopped, with its process tree.
 */
export type WindowsPowerShellUnavailableReason = 'not-found' | 'spawn-failed' | 'timeout' | 'output-limit';

export type WindowsPowerShellRunResult =
  | {
    status: 'exited';
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    /** At most `WINDOWS_POWERSHELL_STDERR_LIMIT` bytes of stderr, as a diagnostic. */
    stderr: string;
  }
  | { status: 'unavailable'; reason: WindowsPowerShellUnavailableReason; detail: string; stderr: string };

type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** The host facts a run needs. Production uses the defaults; tests replace each one. */
export interface WindowsPowerShellDeps {
  platform?: NodeJS.Platform;
  /** Where `SystemRoot` is read from. */
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFunction;
  resolveExecutable?: (command: string, options: HostExecutableResolutionOptions) => string;
  /** Stops the run's process tree; `killProcessTree` by default. */
  killTree?: (proc: ChildProcess) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const INPUT_VARIABLE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * `SystemRoot` from the environment. On Windows the name is matched without case, as Windows does; two spellings
 * with different values are refused rather than guessed between.
 */
function systemRootOf(env: NodeJS.ProcessEnv): string | undefined {
  const values = new Set(Object.keys(env)
    .filter((name) => name.toLowerCase() === 'systemroot')
    .map((name) => env[name])
    .filter((value): value is string => typeof value === 'string'));
  return values.size === 1 ? [...values][0] : undefined;
}

/** A request the caller built wrongly is refused before anything runs. */
function requestProblem(request: WindowsPowerShellRequest): string | undefined {
  if (!request.encodedCommand || !BASE64.test(request.encodedCommand) || request.encodedCommand.length % 4 !== 0) {
    return 'the script is not in encoded form';
  }
  if (!INPUT_VARIABLE.test(request.inputVariable)
    || FIXED_ENVIRONMENT_NAMES.some((name) => name.toLowerCase() === request.inputVariable.toLowerCase())) {
    return `the input variable name "${request.inputVariable}" is not allowed`;
  }
  if (!BASE64.test(request.input)) return 'the input is not base64';
  for (const [name, folder] of [['working folder', request.cwd], ['temporary folder', request.tmp]] as const) {
    if (typeof folder !== 'string' || !path.win32.isAbsolute(folder) || /[\0\r\n]/.test(folder)) {
      return `the ${name} is not an absolute Windows path`;
    }
  }
  if (!(request.timeoutMs > 0) || !(request.maxStdoutBytes > 0) || !(request.maxInputChars > 0)) {
    return 'the run has no bounds';
  }
  return undefined;
}

/**
 * Run the fixed script once. Resolves with what PowerShell printed and how it exited, or with `unavailable`; it never
 * rejects. A request built wrongly (no bounds, an input over the caller's limit, a relative folder) throws a
 * `TypeError` before anything starts, because it is a defect of the caller rather than a fact about this computer.
 */
export function runWindowsPowerShell(
  request: WindowsPowerShellRequest,
  deps: WindowsPowerShellDeps = {},
): Promise<WindowsPowerShellRunResult> {
  const problem = requestProblem(request);
  if (problem) throw new TypeError(`Windows PowerShell was not started: ${problem}.`);
  if (request.input.length > request.maxInputChars) {
    throw new TypeError(`Windows PowerShell was not started: the input is ${request.input.length} characters, over the limit of ${request.maxInputChars}.`);
  }
  const platform = deps.platform ?? process.platform;
  const unavailable = (reason: WindowsPowerShellUnavailableReason, detail: string, stderr = ''): WindowsPowerShellRunResult =>
    ({ status: 'unavailable', reason, detail, stderr });
  if (platform !== 'win32') return Promise.resolve(unavailable('not-found', 'Windows PowerShell exists only on Windows'));
  const systemRoot = systemRootOf(deps.env ?? process.env);
  if (systemRoot === undefined || !SYSTEM_ROOT_PATTERN.test(systemRoot)) {
    return Promise.resolve(unavailable('not-found', 'SystemRoot is missing or is not a folder directly below a drive root'));
  }
  const resolveExecutable = deps.resolveExecutable ?? resolveHostExecutable;
  let executable: string;
  try {
    executable = resolveExecutable(windowsPowerShellPath(systemRoot), {
      platform: 'win32',
      env: {},
      workspaceRoots: request.workspaceRoots ?? [],
      worktreeRoots: request.worktreeRoots ?? [],
    });
  } catch (error) {
    return Promise.resolve(unavailable('not-found', error instanceof Error ? error.message : String(error)));
  }

  const spawn = deps.spawn ?? (nodeSpawn as SpawnFunction);
  const killTree = deps.killTree ?? ((proc: ChildProcess) => killProcessTree(proc));
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const env = windowsPowerShellEnvironment(systemRoot, request.tmp, request.inputVariable, request.input);

  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let settled = false;
    let exited = false;
    let proc: ChildProcess;
    try {
      proc = spawn(executable, [...WINDOWS_POWERSHELL_ARGS, request.encodedCommand], {
        cwd: request.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      resolve(unavailable('spawn-failed', error instanceof Error ? error.message : String(error)));
      return;
    }
    const stderrText = () => Buffer.concat(stderr).toString('utf8');
    // A process can exit before its pipes close; its number may then be another process's, so it is not signalled.
    const stop = () => { if (!exited) killTree(proc); };
    const timer = setTimer(() => {
      if (settled) return;
      stop();
      finish(unavailable('timeout', `Windows PowerShell did not finish within ${Math.round(request.timeoutMs / 1000)} seconds`, stderrText()));
    }, request.timeoutMs);
    function finish(result: WindowsPowerShellRunResult): void {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      resolve(result);
    }
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > request.maxStdoutBytes) {
        stop();
        finish(unavailable('output-limit', `Windows PowerShell wrote more than ${request.maxStdoutBytes} bytes`, stderrText()));
        return;
      }
      stdout.push(chunk);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= WINDOWS_POWERSHELL_STDERR_LIMIT) return;
      const kept = chunk.subarray(0, WINDOWS_POWERSHELL_STDERR_LIMIT - stderrBytes);
      stderr.push(kept);
      stderrBytes += kept.length;
    });
    proc.once('exit', () => { exited = true; });
    proc.once('error', (error: NodeJS.ErrnoException) => {
      finish(unavailable(error.code === 'ENOENT' ? 'not-found' : 'spawn-failed', error.message, stderrText()));
    });
    // 'exit' does not guarantee that the pipes have drained; 'close' does.
    proc.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish({ status: 'exited', code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: stderrText() });
    });
  });
}
