import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

export interface CodexCliProbeResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

export interface CliProbeOptions {
  /** The program's name in messages. */
  label: string;
  /** Environment keys never passed to the program, compared without case. */
  credentialKeys: readonly string[];
  /** A host-owned folder to start the program in, never a repository with its own configuration. Required. */
  cwd: string;
  /**
   * Only for npm's Windows `.cmd` launcher, which Node cannot start without `cmd.exe`. The arguments are fixed by
   * the caller and the path is quoted as one token; the caller has refused a path with a quote, `%` or line break.
   */
  shell?: boolean;
}

/** Local CLI probes only. Never enable a shell or forward ambient API credentials. */
export function runCodexCliProbe(
  binaryPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stop: (proc: ChildProcess) => void,
  cwd: string,
): Promise<CodexCliProbeResult> {
  return runCliProbe(binaryPath, args, env, stop, {
    label: 'Codex CLI', credentialKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'], cwd,
  });
}

/** A bounded local run of a CLI program: 15 seconds, 64 KiB of output, settled when its output has closed. */
export function runCliProbe(
  binaryPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stop: (proc: ChildProcess) => void,
  options: CliProbeOptions,
): Promise<CodexCliProbeResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = 15_000;
    const outputLimit = 64 * 1024;
    const cliEnv = { ...env };
    const credentialKeys = options.credentialKeys.map((key) => key.toUpperCase());
    for (const key of Object.keys(cliEnv)) {
      if (credentialKeys.includes(key.toUpperCase())) delete cliEnv[key];
    }
    if (options.shell && /["\r\n%]/.test(binaryPath)) {
      reject(new Error(`${options.label} refused an unsafe executable path.`));
      return;
    }
    // Never the inherited current directory: without a host-owned folder, nothing starts.
    if (typeof options.cwd !== 'string' || !path.isAbsolute(options.cwd)) {
      reject(new Error(`${options.label} was not started: it has no host-owned folder to start in.`));
      return;
    }
    let proc: ChildProcess;
    try {
      proc = spawn(options.shell ? `"${binaryPath}"` : binaryPath, args, {
        shell: options.shell === true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: cliEnv, cwd: options.cwd,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let output = '';
    let settled = false;
    let exited = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // A process can exit before its output pipes close. Never signal its potentially reused PID.
      if (!exited) stop(proc);
      reject(new Error(`${options.label} did not finish within ${timeoutMs / 1000} seconds.`));
    }, timeoutMs);
    const appendOutput = (chunk: string): void => {
      if (output.length < outputLimit) output += chunk.slice(0, outputLimit - output.length);
    };
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', appendOutput);
    proc.stderr?.on('data', appendOutput);
    proc.once('exit', () => { exited = true; });
    proc.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    // 'exit' does not guarantee stdout/stderr have drained; 'close' does.
    proc.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, output: output.trim() });
    });
  });
}
