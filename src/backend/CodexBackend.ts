/*---------------------------------------------------------------------------------------------
 *  UnodeAi - CodexBackend
 *  Track A: one read-only `codex exec --json` process per turn.
 *
 *  Codex's shell is part of the agent; it is intentionally not wired to UnodeAi CommandPolicy.
 *  The only supported sandbox for this backend is Codex CLI's own `-s read-only` sandbox.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn as nodeSpawn } from 'child_process';
import { AgentConfig, AgentModelParams } from '../types';
import { AgentBackend, BackendEvent, BackendEventHandler, ConversationSnapshot, TurnAttachments, TurnUsage } from './AgentBackend';
import { StreamJsonParser } from './StreamJsonParser';
import { estimateTokensUpper } from './TokenCounter';

const SAFE_CLI_ARGUMENT = /^[A-Za-z0-9._:/-]+$/;
/** Let the authenticated Codex CLI choose the account-supported default instead of forcing an API model id. */
export const CODEX_CLI_DEFAULT_MODEL = 'codex-cli-default';
export const CODEX_BANNED_FLAGS = [
  'danger-full-access',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
] as const;

/** The final argv boundary: no caller may launch Codex with its only sandbox bypassed. */
export function assertSafeCodexSpawnArgs(args: readonly string[]): void {
  const banned = args.find((arg) => CODEX_BANNED_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
  if (banned) {
    throw new Error(`Codex refused unsafe spawn argument: ${banned}`);
  }
}

export interface CodexBackendDeps {
  /** An explicit, version-checked CLI executable. Never resolve an arbitrary `codex` from PATH here. */
  binaryPath: string;
  /** Resolve binary version and CLI login before the session becomes available. */
  preflight?: () => Promise<void>;
  /** Called immediately before each model process is spawned. Rejection means no process and no egress. */
  onBeforeEgress?: () => Promise<void>;
  /** Load-bearing route assertion, invoked before every model process spawn. */
  assertResolvedRoute?: () => void;
  spawn?: typeof nodeSpawn;
}

/** Track A supports the stable JSONL protocol verified with the 0.137 line, not an alpha binary. */
export function isSupportedCodexCliVersion(version: string): boolean {
  const match = /^codex-cli\s+(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) { return false; }
  const [, major, minor] = match;
  return Number(major) === 0 && Number(minor) >= 137 && Number(minor) <= 144;
}

export class CodexBackend implements AgentBackend {
  public readonly agentId: string;
  private readonly handlers = new Set<BackendEventHandler>();
  private proc: ChildProcess | undefined;
  private started = false;
  private stopped = false;
  private threadId: string | undefined;
  private turnText = '';
  private parser = new StreamJsonParser();

  constructor(private config: AgentConfig, private resolvedParams?: AgentModelParams, private deps?: CodexBackendDeps) {
    this.agentId = config.id;
  }

  get pid(): number | undefined { return this.proc?.pid; }

  onEvent(handler: BackendEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async start(_env: NodeJS.ProcessEnv): Promise<void> {
    if (this.started) { return; }
    if (!this.deps?.binaryPath) { throw new Error('Codex CLI path is not configured. Set unode.codexCliPath to a supported Codex CLI executable.'); }
    this.assertSafeArguments();
    await this.deps.preflight?.();
    this.started = true;
    this.stopped = false;
    // SessionManager must be able to flush its first user turn before Codex creates a thread.
    this.emit({ kind: 'ready', model: this.config.model });
  }

  sendUserTurn(instruction: string, attachments?: TurnAttachments): void {
    if (!this.started || this.stopped) {
      this.emit({ kind: 'error', message: 'Codex backend is not running; cannot send turn.' });
      return;
    }
    if (this.proc) {
      this.emit({ kind: 'error', message: 'Codex is already running a turn.' });
      return;
    }
    if (attachments?.userAttachments?.some((attachment) => attachment.kind === 'pdf')) {
      this.failTurn('Local PDF attachments require an OpenAI-compatible agent in this release; the Codex CLI backend did not receive PDF bytes.');
      return;
    }
    void this.runTurn(this.composeTurnText(instruction, attachments));
  }

  async stop(forceTimeoutMs = 10000): Promise<void> {
    this.stopped = true;
    this.started = false;
    const proc = this.proc;
    if (proc?.pid !== undefined) {
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => proc.kill('SIGKILL'), forceTimeoutMs);
        proc.once('exit', () => { clearTimeout(force); resolve(); });
        try { proc.stdin?.end(); } catch { /* already closed */ }
        proc.kill('SIGTERM');
      });
    }
    this.proc = undefined;
    this.emit({ kind: 'exit', code: 0 });
  }

  abort(): void {
    if (this.proc) { this.proc.kill('SIGTERM'); }
  }

  setModel(model: string): void {
    if (model) { this.config.model = model; }
  }

  isAlive(): boolean { return this.started && !this.stopped; }

  snapshot(): ConversationSnapshot | undefined {
    return this.threadId ? { version: 1, messages: [{ codexThreadId: this.threadId }] } : undefined;
  }

  restore(snapshot: ConversationSnapshot): void {
    const item = snapshot.messages[0];
    if (item && typeof item === 'object' && typeof (item as { codexThreadId?: unknown }).codexThreadId === 'string') {
      this.threadId = (item as { codexThreadId: string }).codexThreadId;
    }
  }

  buildArgs(): string[] {
    this.assertSafeArguments();
    const args = this.threadId ? ['exec', 'resume', this.threadId] : ['exec'];
    args.push('--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '-s', 'read-only');
    args.push('-C', this.config.workingDirectory || process.cwd());
    if (this.config.model && this.config.model !== CODEX_CLI_DEFAULT_MODEL) { args.push('-m', this.config.model); }
    const effort = this.resolvedParams?.reasoning_effort ?? this.config.modelParams?.reasoning_effort;
    if (effort) { args.push('-c', `model_reasoning_effort=${effort}`); }
    return args;
  }

  private async runTurn(prompt: string): Promise<void> {
    try {
      // Starting the CLI can reach OpenAI; do not spawn until the host consent gate has completed.
      this.deps?.assertResolvedRoute?.();
      await this.deps?.onBeforeEgress?.();
      if (this.stopped) { return; }
      const spawn = this.deps?.spawn ?? nodeSpawn;
      const args = this.buildArgs();
      assertSafeCodexSpawnArgs(args);
      // Phase A observation: a Codex CLI process is one model request for this worker turn.
      this.emit({ kind: 'model_request' });
      const proc = spawn(this.deps!.binaryPath, args, {
        cwd: this.config.workingDirectory || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
      this.proc = proc;
      this.turnText = '';
      this.parser.reset();
      proc.stdout?.setEncoding('utf8');
      proc.stderr?.setEncoding('utf8');
      proc.stdout?.on('data', (chunk: string) => this.consume(chunk));
      proc.stderr?.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) { if (line.trim()) { this.emit({ kind: 'log', stream: 'stderr', line: line.trim() }); } }
      });
      proc.on('error', (error: Error) => this.failTurn(error.message));
      proc.on('exit', (code: number | null) => {
        const tail = this.parser.flush();
        tail.objects.forEach((event) => this.handleEvent(event));
        tail.garbage.forEach((line) => this.emit({ kind: 'log', stream: 'stdout', line }));
        if (!this.stopped && code !== 0) { this.failTurn(`Codex CLI exited with code ${code ?? 'unknown'}.`); }
        this.proc = undefined;
      });
      proc.stdin?.end(prompt);
    } catch (error) {
      this.failTurn(error instanceof Error ? error.message : String(error));
    }
  }

  private consume(chunk: string): void {
    const parsed = this.parser.push(chunk);
    parsed.objects.forEach((event) => this.handleEvent(event));
    parsed.garbage.forEach((line) => this.emit({ kind: 'log', stream: 'stdout', line }));
  }

  private handleEvent(raw: unknown): void {
    if (!raw || typeof raw !== 'object') { return; }
    const event = raw as Record<string, any>;
    const item = event.item as Record<string, any> | undefined;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      this.threadId = event.thread_id;
      this.emit({ kind: 'ready', model: this.config.model, backendSessionId: this.threadId });
      return;
    }
    if ((event.type === 'item.started' || event.type === 'item.completed') && item?.type === 'command_execution') {
      const command = String(item.command ?? item.cmd ?? 'command');
      if (event.type === 'item.started') {
        this.emit({ kind: 'tool_use', name: 'command_execution (Codex read-only sandbox; not UnodeAi-approved)', input: { command } });
      } else {
        const exitCode = Number(item.exit_code ?? item.exitCode ?? 1);
        const detail = String(item.aggregated_output ?? item.output ?? '');
        this.emit({ kind: 'tool_result', name: 'command_execution', ok: exitCode === 0, summary: detail.slice(0, 500) || `exit ${exitCode}`, detail });
      }
      return;
    }
    if (event.type === 'item.completed' && item?.type === 'agent_message') {
      const text = String(item.text ?? item.content ?? '');
      if (text) { this.turnText += text; this.emit({ kind: 'assistant', text }); }
      return;
    }
    if (event.type === 'turn.completed') {
      const usage = codexUsage(event.usage ?? event.turn?.usage);
      this.emit({ kind: 'turn_complete', result: { text: this.turnText, isError: false, usage: usage ?? estimatedUsage(this.turnText) } });
      return;
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      this.failTurn(String(event.error?.message ?? event.message ?? 'Codex turn failed.'));
    }
  }

  private failTurn(message: string): void {
    if (this.stopped) { return; }
    this.emit({ kind: 'error', message });
    this.emit({ kind: 'turn_complete', result: { text: this.turnText || message, isError: true, usage: estimatedUsage(this.turnText || message) } });
  }

  private composeTurnText(instruction: string, attachments?: TurnAttachments): string {
    const parts = [this.config.systemPrompt, instruction];
    if (attachments?.projectContext) { parts.push(`<project_context>\n${attachments.projectContext}\n</project_context>`); }
    if (attachments?.workspaceContext) { parts.push(attachments.workspaceContext); }
    if (attachments?.mode === 'plan') { parts.push('[PLAN MODE] Analyze and plan only. Do not propose mutations.'); }
    return parts.filter(Boolean).join('\n\n');
  }

  private assertSafeArguments(): void {
    const effort = this.resolvedParams?.reasoning_effort ?? this.config.modelParams?.reasoning_effort;
    for (const [label, value] of [['model', this.config.model], ['reasoning effort', effort]] as const) {
      if (value && !SAFE_CLI_ARGUMENT.test(value)) { throw new Error(`Codex refused unsafe ${label} argument.`); }
    }
  }

  private emit(event: BackendEvent): void { this.handlers.forEach((handler) => handler(event)); }
}

function codexUsage(raw: unknown): TurnUsage | undefined {
  if (!raw || typeof raw !== 'object') { return undefined; }
  const usage = raw as Record<string, unknown>;
  const input = asNumber(usage.input_tokens);
  const output = asNumber(usage.output_tokens);
  if (input === undefined || output === undefined) { return undefined; }
  const cached = asNumber(usage.cached_input_tokens);
  const reasoning = asNumber(usage.reasoning_output_tokens) ?? 0;
  return { inputTokens: input, cachedInputTokens: cached, outputTokens: output + reasoning, costBasis: 'api-equivalent' };
}

function estimatedUsage(text: string): TurnUsage {
  return { inputTokens: estimateTokensUpper(text), outputTokens: estimateTokensUpper(text), estimated: true, costBasis: 'api-equivalent' };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
