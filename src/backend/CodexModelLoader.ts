/*---------------------------------------------------------------------------------------------
 *  Explicit, model-list-only Codex App Server session.
 *  This path is used only after the user clicks "Load models from Codex". It never starts a thread or
 *  turn and its cwd is extension-global storage, so repository configuration is not discovered.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isPathInsideOrEqual } from './pathContainment';
import { killProcessTreeByPid, terminateChildProcessTree, type ProcessTerminationOutcome } from './processTree';
import { buildCodexAppServerArgs } from './CodexSpawnArgs';
import { StreamJsonParser } from './StreamJsonParser';

type JsonObject = Record<string, unknown>;
const MAX_MODEL_DISCOVERY_STDOUT_BYTES = 4 * 1024 * 1024;

export interface CodexAccountModel {
  id: string;
  name: string;
  vision: boolean;
  isDefault: boolean;
}

export interface CodexModelLoaderDeps {
  binaryPath: string;
  neutralWorkingDirectory: string;
  workspaceRoots?: readonly string[];
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
  spawn?: typeof nodeSpawn;
  killProcessTree?: (pid: number) => Promise<void>;
  /**
   * v0.9.97: told how the stop of App Server's tree ended, once a process was started. Given, the stop is observed
   * (`terminateProcessTree`, by default the observed tree stop), so a managed start's lease is given up only after a
   * confirmed one; without it the stop stays the best-effort kill by process number.
   */
  onStopped?: (outcome: ProcessTerminationOutcome) => void;
  terminateProcessTree?: (proc: ChildProcess) => Promise<ProcessTerminationOutcome>;
  timeoutMs?: number;
  /**
   * The host's check that this operation is still current: the selected program, the window not closing, the
   * workspace unchanged. Called synchronously right before App Server is spawned, after every await of the
   * preparation, with nothing awaited in between. It throws to start nothing.
   */
  assertCurrent: () => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Parse the bounded, account-visible portion of App Server's model/list response. */
export function parseCodexAccountModels(value: unknown): CodexAccountModel[] {
  const response = asObject(value);
  const seen = new Set<string>();
  return (Array.isArray(response.data) ? response.data : []).flatMap((raw): CodexAccountModel[] => {
    const item = asObject(raw);
    const id = stringValue(item.id) || stringValue(item.model);
    if (!id || item.hidden === true || seen.has(id)) return [];
    seen.add(id);
    const modalities = stringArray(item.inputModalities);
    return [{
      id,
      name: stringValue(item.displayName) || id,
      vision: modalities.includes('image'),
      isDefault: item.isDefault === true,
    }];
  }).slice(0, 200);
}

/**
 * v0.9.97: the model names App Server's model/list says take image input, by `id` and by `model`, hidden ones too:
 * a thread may run a model the picker does not show. Only an explicit `image` in `inputModalities` counts.
 */
export function parseCodexImageInputModels(value: unknown): Set<string> {
  const response = asObject(value);
  const names = new Set<string>();
  for (const raw of (Array.isArray(response.data) ? response.data : []).slice(0, 200)) {
    const item = asObject(raw);
    if (!stringArray(item.inputModalities).includes('image')) continue;
    for (const name of [stringValue(item.id), stringValue(item.model)]) if (name) names.add(name);
  }
  return names;
}

/**
 * Start a short-lived App Server solely to request the model list, then stop its whole process tree.
 * The only client requests are `initialize` and `model/list`; no repository config, thread, or turn call
 * exists on this code path.
 */
export async function loadCodexAccountModels(deps: CodexModelLoaderDeps): Promise<CodexAccountModel[]> {
  const requestedCwd = requireNeutralWorkingDirectory(deps.neutralWorkingDirectory, deps.workspaceRoots ?? []);
  await fs.mkdir(requestedCwd, { recursive: true });
  // Check physical paths too: an extension-storage symlink must not redirect discovery into a repository.
  const cwd = await fs.realpath(requestedCwd);
  const physicalWorkspaceRoots = await Promise.all((deps.workspaceRoots ?? []).map(async (root) => {
    try { return await fs.realpath(root); } catch { return path.resolve(root); }
  }));
  requireNeutralWorkingDirectory(cwd, physicalWorkspaceRoots);
  const client = new CodexModelListClient(deps, cwd);
  try {
    await client.start();
    await client.request('initialize', {
      clientInfo: { name: 'unodeai', title: 'UnodeAi', version: deps.clientVersion || 'dev' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        extensions: {},
      },
    });
    return parseCodexAccountModels(await client.request('model/list', { limit: 100, includeHidden: false }));
  } finally {
    await client.stop();
  }
}

/** The observed stop of a process this host started; any other is killed, and its stop is not confirmed. */
async function terminateModelListTree(proc: ChildProcess): Promise<ProcessTerminationOutcome> {
  if (startedByNode(proc)) return terminateChildProcessTree(proc);
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  return { status: 'unknown', detail: 'its process was not started by this host, so its tree was not observed' };
}

function startedByNode(proc: ChildProcess): boolean {
  return proc instanceof ChildProcess;
}

function requireNeutralWorkingDirectory(candidate: string, workspaceRoots: readonly string[]): string {
  if (!candidate || !path.isAbsolute(candidate)) {
    throw new Error('Codex model discovery requires an absolute extension-storage directory.');
  }
  const resolved = path.resolve(candidate);
  if (workspaceRoots.some((root) => isInside(path.resolve(root), resolved))) {
    throw new Error('Codex model discovery refused to start inside a workspace.');
  }
  return resolved;
}

class CodexModelListClient {
  private readonly parser = new StreamJsonParser();
  private readonly pending = new Map<number, PendingRequest>();
  private proc: ChildProcess | undefined;
  private requestSequence = 0;
  private stderr = '';
  private stdoutBytes = 0;
  private terminalError: Error | undefined;
  private stopped = false;

  constructor(private readonly deps: CodexModelLoaderDeps, private readonly cwd: string) {}

  async start(): Promise<void> {
    const spawn = this.deps.spawn ?? nodeSpawn;
    // The last word before a process exists: a stale operation throws here and nothing is started or sent.
    this.deps.assertCurrent();
    const proc = spawn(this.deps.binaryPath, buildCodexAppServerArgs(undefined, 'read-only'), {
      cwd: this.cwd,
      env: sanitizedCodexEnv(this.deps.env ?? process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    this.proc = proc;
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => this.consume(chunk));
    proc.stderr?.on('data', (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-4_000); });
    proc.once('error', (error: Error) => this.fail(error));
    proc.once('exit', (code: number | null) => {
      if (!this.stopped) {
        const detail = this.stderr.trim();
        this.fail(new Error(`Codex model discovery exited with code ${code ?? 'unknown'}${detail ? `: ${detail}` : '.'}`));
      }
    });
  }

  request(method: 'initialize' | 'model/list', params: unknown): Promise<unknown> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const id = ++this.requestSequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.deps.timeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.fail(new Error('Codex model discovery stopped.'));
    const proc = this.proc;
    this.proc = undefined;
    if (!proc) return;
    if (proc.pid === undefined) {
      proc.kill();
      // No process was created, so nothing of it can still run.
      this.deps.onStopped?.({ status: 'confirmed-stopped' });
      return;
    }
    if (!this.deps.onStopped) {
      await (this.deps.killProcessTree ?? killProcessTreeByPid)(proc.pid).catch(() => undefined);
      return;
    }
    let outcome: ProcessTerminationOutcome;
    try {
      outcome = await (this.deps.terminateProcessTree ?? terminateModelListTree)(proc);
    } catch (error) {
      outcome = { status: 'unknown', detail: error instanceof Error ? error.message : String(error) };
    }
    this.deps.onStopped(outcome);
  }

  private consume(chunk: string): void {
    if (this.terminalError) return;
    this.stdoutBytes += Buffer.byteLength(chunk, 'utf8');
    if (this.stdoutBytes > MAX_MODEL_DISCOVERY_STDOUT_BYTES) {
      this.fail(new Error('Codex model discovery exceeded its stdout safety limit.'));
      return;
    }
    const parsed = this.parser.push(chunk);
    for (const raw of parsed.objects) {
      const message = asObject(raw);
      if (typeof message.id === 'number' && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error !== undefined) {
          pending.reject(new Error(String(asObject(message.error).message ?? 'Codex App Server request failed.')));
        } else {
          pending.resolve(message.result);
        }
      } else if (message.id !== undefined && typeof message.method === 'string') {
        // A model-list-only client grants no effects. Fail closed if a future App Server asks for one.
        this.write({
          jsonrpc: '2.0', id: message.id,
          error: { code: -32601, message: `UnodeAi model discovery declined App Server request: ${message.method}` },
        });
      }
    }
  }

  private write(message: JsonObject): void {
    if (!this.proc?.stdin?.writable) throw new Error('Codex App Server stdin is unavailable.');
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error): void {
    this.terminalError ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function sanitizedCodexEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe = { ...env };
  for (const key of Object.keys(safe)) {
    if (key.toUpperCase() === 'OPENAI_API_KEY' || key.toUpperCase() === 'CODEX_API_KEY') delete safe[key];
  }
  return safe;
}

function isInside(root: string, candidate: string): boolean {
  return isPathInsideOrEqual(root, candidate, path);
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
function stringValue(value: unknown): string { return typeof value === 'string' ? value : ''; }
function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}
