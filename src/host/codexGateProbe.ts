/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the Codex CLI compatibility check (v0.9.97)
 *  Runs only after the user's OK for this exact program, and sends no model request. It reads the version, then starts
 *  the App Server with the production arguments and asks only `initialize`, `initialized` and `config/read`, and
 *  requires every host-owned setting in effect, exactly as an agent start does. No thread, turn, model list or skill
 *  request is sent. Then the App Server's tree is stopped while it still runs.
 *
 *  External (adoption): the existing preflight (version floor, login status) first, with the user's own CODEX_HOME.
 *  Managed (after the click for one version): `--version` must equal the policy's text; no login status; only the
 *  allowlisted environment, with an empty CODEX_HOME and folders of the check's own.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { verifyCodexCliPreflight } from '../backend/CodexCliPreflight';
import { assertCodexEffectiveProcessConfig, codexInitializeParams } from '../backend/codexEffectiveConfig';
import { assertManagedCodexArgs, buildCodexAppServerArgs, finalCodexSpawnEnv } from '../backend/CodexSpawnArgs';
import { prepareNeutralFolder } from '../backend/cliRuntime';
import { StreamJsonParser } from '../backend/StreamJsonParser';
import type { WorkFolder } from './managedCli/contracts';
import { bounded, GateProbeRun, GateProbeStop, runToExit, type GateProbeDeps, type GateProbeResult } from './cliGateProbeRun';

export { GATE_PROBE_LIMITS, type GateProbeResult, type GateProbeStep } from './cliGateProbeRun';

/** The only requests a check sends, in this order. */
export const CODEX_GATE_PROBE_METHODS = Object.freeze(['initialize', 'initialized', 'config/read'] as const);

export interface CodexGateProbeDeps extends GateProbeDeps {
  /** UnodeAi's version, for `initialize`. */
  clientVersion?: string;
  /** Whether a program file exists; the preflight's own check. */
  exists?: (file: string) => boolean;
  /** The entries of a folder; throws when it is missing. Used to require an empty CODEX_HOME. */
  folderEntries?: (folder: string) => string[];
}

export interface ExternalCodexGateProbeRequest {
  /** The physical program the user confirmed. */
  executable: string;
  /** UnodeAi's own folder for checks, outside every workspace; prepared again here. */
  probeCwd: string;
  workspaceRoots: readonly string[];
  /** The environment an agent of this program starts with, every layer merged. */
  agentEnv: NodeJS.ProcessEnv;
}

/**
 * The check of an External program, after the user chose **Check and use this program**. A pass carries the exact
 * version the preflight read; the caller then writes the adoption record.
 */
export async function runExternalCodexGateProbe(
  request: ExternalCodexGateProbeRequest,
  deps: CodexGateProbeDeps = {},
): Promise<GateProbeResult & { version?: string }> {
  const run = new GateProbeRun(deps);
  let cwd: string;
  try {
    cwd = prepareNeutralFolder(request.probeCwd, request.workspaceRoots);
  } catch (error) {
    return run.failed(error, undefined);
  }
  // The user's CODEX_HOME stays as it is: that is what the program runs with.
  const env = finalCodexSpawnEnv(request.agentEnv);
  let versionOutput: string | undefined;
  let version: string;
  try {
    version = await verifyCodexCliPreflight(request.executable, env, async (binary, args, runEnv) => {
      const step = args[0] === '--version' ? 'version' : 'login-status';
      const result = await runToExit(run, step, binary, args, { env: runEnv, cwd });
      if (step === 'version') versionOutput = result.output;
      return { code: result.code, signal: result.signal, output: result.output };
    }, deps.exists ?? existsSync);
  } catch (error) {
    return run.failed(error, versionOutput);
  }
  const args = buildCodexAppServerArgs({ projectRoot: cwd, mode: 'user-only' }, 'ask-for-approval');
  const outcome = await appServerCheck(run, request.executable, args, env, cwd, deps.clientVersion, versionOutput);
  return outcome.result === 'pass' ? { ...outcome, version } : outcome;
}

export interface ManagedCodexGateProbeRequest {
  /** `versions\<key>\bin\codex.exe` of the instance, as the instance store names it. */
  executable: string;
  /** The check's own folders, outside the instance. */
  workFolder: WorkFolder;
  /** The policy entry's exact `--version` text. */
  expectedVersionOutput: string;
  /** The environment of the extension host, from which only the allowlisted variables are read. */
  hostEnv: NodeJS.ProcessEnv;
}

/** The environment of a managed check: these variables and nothing else. */
export function managedCodexProbeEnv(hostEnv: NodeJS.ProcessEnv, work: Pick<WorkFolder, 'tmp' | 'home'>): NodeJS.ProcessEnv {
  const read = (name: string): string | undefined => {
    const key = Object.keys(hostEnv).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
    const value = key === undefined ? undefined : hostEnv[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const systemRoot = read('SystemRoot');
  if (!systemRoot) throw new GateProbeStop('fail', 'SystemRoot is not set, so the check has no Windows folder to run with');
  const env: NodeJS.ProcessEnv = { SystemRoot: systemRoot };
  for (const name of ['WINDIR', 'ComSpec', 'PATHEXT']) {
    const value = read(name);
    if (value !== undefined) env[name] = value;
  }
  env.PATH = `${systemRoot}\\System32;${systemRoot}`;
  env.TEMP = work.tmp;
  env.TMP = work.tmp;
  for (const name of ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']) {
    const value = read(name);
    if (value !== undefined) env[name] = value;
  }
  env[OWNED_CODEX_HOME_VARIABLE] = work.home;
  return env;
}

/**
 * The check's own empty home, set for the check's process only. UnodeAi never reads the user's Codex home: the
 * variable is written here, never read, and no path is built from it.
 */
const OWNED_CODEX_HOME_VARIABLE = 'CODEX_HOME';

/**
 * The post-click check of one managed version. The caller holds the instance's admission and a probe lease; it may
 * release the admission once `onSpawned` reports the `app-server` step, the last spawn.
 */
export async function runManagedCodexGateProbe(
  request: ManagedCodexGateProbeRequest,
  deps: CodexGateProbeDeps = {},
): Promise<GateProbeResult> {
  const run = new GateProbeRun(deps);
  const work = request.workFolder;
  const entries = deps.folderEntries ?? ((folder: string) => {
    if (!statSync(folder).isDirectory()) throw new Error(`${folder} is not a folder`);
    return readdirSync(folder);
  });
  let home: string[];
  try {
    if (![work.cwd, work.tmp, work.home].every((folder) => path.isAbsolute(folder))) throw new Error('they are not absolute paths');
    entries(work.cwd);
    entries(work.tmp);
    home = entries(work.home);
  } catch (error) {
    return run.result(`the check's folders are not ready (${bounded(error instanceof Error ? error.message : String(error), 300)})`, undefined, undefined);
  }
  if (home.length !== 0) return run.result('the check\'s own Codex home is not empty', undefined, undefined);
  let env: NodeJS.ProcessEnv;
  let args: string[];
  try {
    env = managedCodexProbeEnv(request.hostEnv, work);
    args = buildCodexAppServerArgs({ projectRoot: work.cwd, mode: 'user-only' }, 'ask-for-approval');
    assertManagedCodexArgs(args);
  } catch (error) {
    return run.failed(error, undefined);
  }
  let versionOutput: string | undefined;
  try {
    const version = await runToExit(run, 'version', request.executable, ['--version'], { env, cwd: work.cwd });
    versionOutput = version.stdout.trim();
    if (version.code !== 0 || versionOutput !== request.expectedVersionOutput) {
      throw new GateProbeStop('fail', `the program printed "${bounded(versionOutput, 120)}" for --version (exit ${version.code ?? 'none'}), not "${request.expectedVersionOutput}"`);
    }
  } catch (error) {
    return run.failed(error, versionOutput);
  }
  return appServerCheck(run, request.executable, args, env, work.cwd, deps.clientVersion, versionOutput);
}

/**
 * The App Server part of both checks: the three messages and the production assertions, then the stop of its tree
 * while it still runs. Its input is ended only after that stop.
 */
async function appServerCheck(
  run: GateProbeRun,
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  clientVersion: string | undefined,
  versionOutput: string | undefined,
): Promise<GateProbeResult> {
  if (run.remainingMs() <= 0) return run.result(run.timeoutText(), undefined, versionOutput);
  let proc: ChildProcess;
  try {
    proc = run.spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  } catch (error) {
    return run.result(`the App Server could not be started (${bounded(String(error), 300)})`, undefined, versionOutput);
  }
  run.spawned(proc, 'app-server');
  const failure = await handshake(run, proc, cwd, clientVersion);
  // The stop is sent while the root runs, before its input ends (see the module comment).
  const unconfirmed = await run.stop(proc);
  return run.result(failure, unconfirmed, versionOutput);
}

/** Undefined when the handshake and every assertion passed; otherwise why not. Never stops the process. */
function handshake(run: GateProbeRun, proc: ChildProcess, cwd: string, clientVersion: string | undefined): Promise<string | undefined> {
  return new Promise((resolve) => {
    const parser = new StreamJsonParser();
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let settled = false;
    let nextId = 0;
    const finish = (failure: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const request of pending.values()) request.reject(new Error(failure ?? 'the check ended'));
      pending.clear();
      resolve(failure);
    };
    const timer = setTimeout(() => finish(run.timeoutText()), run.remainingMs());
    const write = (message: Record<string, unknown>) => {
      if (!proc.stdin?.writable) throw new Error('the App Server\'s input is closed');
      proc.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (method: string, params: unknown) => new Promise<unknown>((resolveRequest, rejectRequest) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      try {
        write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        pending.delete(id);
        rejectRequest(error instanceof Error ? error : new Error(String(error)));
      }
    });
    const handle = (raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const message = raw as Record<string, unknown>;
      if (message.id !== undefined && typeof message.method === 'string') {
        // A request of the server: declined, as an agent start declines a request it does not know.
        try {
          write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `UnodeAi's compatibility check declines ${message.method}` } });
        } catch { /* the exit handler reports it */ }
        return;
      }
      if (typeof message.id !== 'number' || message.method !== undefined) return;
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error !== undefined) {
        const error = message.error as { message?: unknown };
        waiting.reject(new Error(typeof error?.message === 'string' ? error.message : 'the App Server returned an error'));
      } else {
        waiting.resolve(message.result);
      }
    };
    const take = (chunk: Buffer, isStdout: boolean) => {
      if (settled) return;
      if (!run.takeOutput(chunk.length)) { finish(run.outputText()); return; }
      if (isStdout) parser.push(chunk.toString('utf8')).objects.forEach(handle);
    };
    proc.stdout?.on('data', (chunk: Buffer) => take(chunk, true));
    proc.stderr?.on('data', (chunk: Buffer) => take(chunk, false));
    proc.stdin?.on('error', () => { /* the exit handler reports it */ });
    proc.once('error', (error) => finish(`the App Server could not be started (${bounded(error.message, 300)})`));
    proc.once('exit', (code) => finish(`the App Server exited with code ${code ?? 'unknown'} before the check finished`));

    void (async () => {
      try {
        await request('initialize', codexInitializeParams(clientVersion));
        write({ jsonrpc: '2.0', method: 'initialized' });
        const response = await request('config/read', { cwd, includeLayers: true });
        if (settled) return;
        assertCodexEffectiveProcessConfig(response, { profile: 'ask-for-approval', repositoryMode: 'user-only' });
        finish(undefined);
      } catch (error) {
        finish(error instanceof Error ? error.message : String(error));
      }
    })();
  });
}
