/*---------------------------------------------------------------------------------------------
 *  Explicit, model-list-only Codex App Server session.
 *  This path is used only after the user clicks "Load models from Codex". It never starts a thread or
 *  turn and its cwd is extension-global storage, so repository configuration is not discovered.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { killProcessTreeByPid } from './processTree';
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
  timeoutMs?: number;
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
    if (proc.pid !== undefined) {
      await (this.deps.killProcessTree ?? killProcessTreeByPid)(proc.pid).catch(() => undefined);
    } else {
      proc.kill();
    }
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
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
function stringValue(value: unknown): string { return typeof value === 'string' ? value : ''; }
function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}
