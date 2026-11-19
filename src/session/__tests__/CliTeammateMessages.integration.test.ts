/*
 * v0.9.103 (DESIGN_v09103_cli_teammate_messages §3, tests 10-13): the lifecycle of a CLI teammate's question to its
 * coordinator, end to end through the modules that own it.
 *
 * MODULE INTEGRATION, NOT ACTIVATION EVIDENCE. Nothing here runs activate(); the wiring between the modules is the
 * few lines activation has (the resolver's turn-thread source, the coordinator's reply_to_task and async-result wake).
 *
 * Real: SessionManager, MessageBus, TaskInputResolver, the PM's TeamTools handlers (dispatch_task, reply_to_task,
 * record_task_disposition), the production ClaudeHeadlessBackend for the teammate with a fake process (deps.spawn) and
 * its real files bridge over HTTP, and the production CodexBackend with a fake App Server transport.
 * The teammate's question enters only through the bridge's tools/call (Claude) or an App Server item/tool/call (Codex)
 * of send_message. The message claim, the attempt card, the waiting checkpoint and the results are produced by the
 * production modules; the test only plays the CLI's stream (its turn end) and the PM model's tool calls.
 * The PM is a scripted backend: its tool calls are the test's calls of its real TeamTools.
 */
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import { existsSync, readdirSync, readFileSync } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentBackend, BackendEvent, BackendEventHandler, TurnAttachments } from '../../backend/AgentBackend';
import { ClaudeHeadlessBackend } from '../../backend/ClaudeHeadlessBackend';
import { CODEX_CLI_DEFAULT_MODEL, CodexBackend } from '../../backend/CodexBackend';
import { TaskInputResolver, type TaskAttemptCard } from '../../backend/TaskContract';
import { TeamTools, type TeamView } from '../../backend/TeamTools';
import { MessageBus } from '../../bus/MessageBus';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import type { AgentConfig, Message } from '../../types';
import { SessionManager } from '../SessionManager';
import { fixedCodexProgram } from '../../backend/__tests__/codexProgramFixture';

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0)); };

/** The PM: a scripted model. Its turns are recorded; its tool calls are the test's calls of its real TeamTools. */
class ScriptedPm implements AgentBackend {
  readonly agentId: string;
  pid = 11;
  turns: string[] = [];
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void { this.handler = h; return () => { this.handler = undefined; }; }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(instruction: string): void { this.turns.push(instruction); }
  async stop(): Promise<void> { this.alive = false; }
  abort(): void {}
  setModel(): void {}
  isAlive(): boolean { return this.alive; }
  emit(event: BackendEvent): void { this.handler?.(event); }
}

// ─── The Claude CLI process: a fake child the production backend spawns ───────────────────────────────

interface FakeCli { proc: any; packets: string[] }

function fakeClaudeSpawn() {
  const clis: FakeCli[] = [];
  const fn = () => {
    const proc = new EventEmitter() as any;
    const cli: FakeCli = { proc, packets: [] };
    proc.pid = 5150;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = {
      write: (text: string) => {
        for (const line of String(text).split('\n')) if (line.trim()) cli.packets.push(line);
        return true;
      },
      end: () => undefined,
    };
    proc.kill = () => { if (proc.exitCode === null) { proc.exitCode = 0; proc.emit('exit', 0); } return true; };
    clis.push(cli);
    setTimeout(() => proc.emit('spawn'), 0);
    return proc;
  };
  return { fn, clis };
}

/** The text of a user packet the backend wrote to the CLI's stdin. */
function packetText(line: string): string {
  const content = (JSON.parse(line) as { message: { content: unknown } }).message.content;
  return typeof content === 'string' ? content
    : (content as Array<{ type: string; text?: string }>).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

/** The CLI's own end of its turn, as `claude -p --output-format stream-json` writes it. */
function cliTurnEnds(cli: FakeCli, text: string): void {
  cli.proc.stdout.emit('data', `${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: text,
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
  })}\n`);
}

function filesBridgeEndpoint(dir: string): { port: number; token?: string } {
  const root = path.join(dir, '.unode', 'claude');
  const files = existsSync(root) ? readdirSync(root).map((id) => path.join(root, id, 'mcp.json')).filter((file) => existsSync(file)) : [];
  expect(files).toHaveLength(1);
  const written = JSON.parse(readFileSync(files[0], 'utf8'));
  const serverId = Object.keys(written.mcpServers).find((id) => /^unode_files_[a-f0-9]{32}$/.test(id));
  expect(serverId).toBeTruthy();
  const spec = written.mcpServers[serverId!];
  const auth = String(spec.headers?.Authorization ?? '');
  return { port: Number(new URL(spec.url).port), token: auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined };
}

let rpcId = 100;
/** The Claude CLI calling the files bridge's send_message, over the bridge's own HTTP JSON-RPC. */
function bridgeSendMessage(dir: string, args: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ text: string }> }> {
  const endpoint = filesBridgeEndpoint(dir);
  const text = JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: 'send_message', arguments: args } });
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: endpoint.port, path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text),
        ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) },
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (out += chunk));
      res.on('end', () => resolve(JSON.parse(out).result));
    });
    request.on('error', reject);
    request.end(text);
  });
}

// ─── The Codex App Server: a fake transport the production backend spawns ───────────────────────────────

function fakeAppServer() {
  const setting = (args: readonly string[], key: string): unknown => {
    const raw = args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1);
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw); } catch { return raw; }
  };
  const state = { steer: 'accept' as 'accept' | 'refuse', turns: 0, currentTurn: '' };
  const clientMessages: any[] = [];
  const responses: any[] = [];
  let proc: any;
  const emit = (message: unknown) => queueMicrotask(() => proc.stdout.emit('data', `${JSON.stringify(message)}\n`));
  const spawn = (_command: string, args: string[]) => {
    proc = new EventEmitter();
    proc.pid = 4321;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = {
      writable: true,
      write(text: string) {
        for (const line of text.trim().split(/\r?\n/)) {
          if (!line) continue;
          const message = JSON.parse(line);
          clientMessages.push(message);
          const reply = (result: unknown) => emit({ jsonrpc: '2.0', id: message.id, result });
          if (message.method === 'initialize') reply({ userAgent: 'fake' });
          else if (message.method === 'config/read') reply({
            config: {
              model_provider: 'openai', analytics: { enabled: false }, otel: { exporter: 'none' },
              approval_policy: setting(args, 'approval_policy'), approvals_reviewer: setting(args, 'approvals_reviewer'),
              sandbox_mode: setting(args, 'sandbox_mode'),
              sandbox_workspace_write: { network_access: setting(args, 'sandbox_workspace_write.network_access') === true },
              apps: { _default: {
                default_tools_approval_mode: setting(args, 'apps._default.default_tools_approval_mode'),
                approvals_reviewer: setting(args, 'apps._default.approvals_reviewer'),
              } },
            },
            origins: {}, layers: [],
          });
          else if (message.method === 'model/list') reply({ data: [] });
          else if (message.method === 'skills/extraRoots/set' || message.method === 'turn/interrupt') reply({});
          else if (message.method === 'skills/list') reply({ data: [] });
          else if (message.method === 'thread/start' || message.method === 'thread/resume') reply({
            thread: { id: 'thread-1' }, cwd: message.params.cwd, approvalPolicy: message.params.approvalPolicy,
            approvalsReviewer: message.params.approvalsReviewer, modelProvider: message.params.modelProvider,
            runtimeWorkspaceRoots: message.params.runtimeWorkspaceRoots,
            sandbox: message.params.sandbox === 'read-only'
              ? { type: 'readOnly', networkAccess: false }
              : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
          });
          else if (message.method === 'turn/start') {
            state.currentTurn = `turn-${++state.turns}`;
            reply({ turn: { id: state.currentTurn, status: 'inProgress' } });
          } else if (message.method === 'turn/steer') {
            // App Server's answer to a steer of this exact turn: accepted, or refused (the turn cannot take input).
            if (state.steer === 'accept' && message.params.expectedTurnId === state.currentTurn) reply({ turnId: state.currentTurn });
            else emit({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'no active turn to steer' } });
          } else if (message.id !== undefined && !message.method) responses.push(message);
        }
        return true;
      },
      end() { proc.stdin.writable = false; },
    };
    proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
    return proc;
  };
  return {
    spawn: spawn as any,
    state,
    clientMessages,
    responses,
    /** Codex calling a dynamic tool in its current turn. */
    toolCall(tool: string, args: Record<string, unknown>, id: string) {
      emit({ jsonrpc: '2.0', id, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: state.currentTurn, callId: id, namespace: null, tool, arguments: args } });
    },
    /** Codex ending its current turn with a final agent message. */
    turnEnds(text: string) {
      const turnId = state.currentTurn;
      emit({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-1', turnId, item: { type: 'agentMessage', id: `${turnId}-msg`, text } } });
      emit({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } } });
    },
    /**
     * v0.9.104 D1.1: Codex's own question tool in its current turn, as measured on 0.165.0 and 0.167.0-alpha.4.1: Codex
     * answers request_user_input_async itself, and the question arrives only as an async agentMessage item, with no deltas.
     */
    nativeQuestion(title: string, options: string[], id = `call_native_${state.currentTurn}`) {
      const item = { type: 'agentMessage', id, text: `${title}\n${options.map((option) => `- ${option}`).join('\n')}`, delivery: 'async',
        questions: [{ title, options }] };
      emit({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'thread-1', turnId: state.currentTurn, item } });
      emit({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-1', turnId: state.currentTurn, item } });
    },
    turnStarts(): any[] { return clientMessages.filter((message) => message.method === 'turn/start'); },
    steers(): any[] { return clientMessages.filter((message) => message.method === 'turn/steer'); },
  };
}

function turnStartText(message: any): string {
  return (message.params.input as Array<{ type: string; text?: string }>).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

// ─── The team: a PM with its real TeamTools, and one CLI teammate, under a real SessionManager ─────────────

const CONTRACT = (objective: string) => ({
  version: 1, objective, expected_deliverable: 'Return the summary.',
  effects: { read_files: [], expected_file_effect: 'none' }, inputs: [], constraints: [], dependencies: [],
  required_capabilities: { version: 1, capabilities: ['read'] }, execution_strategy: 'delegate-required',
});

function pmConfig(): AgentConfig {
  return {
    id: 'pm', name: 'PM', role: 'pm', skill: '', provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-sonnet-4-5', systemPrompt: '', autoApprove: true, allowedTools: [],
  };
}

function devConfig(kind: 'claude' | 'codex', dir: string): AgentConfig {
  return kind === 'claude'
    ? {
      id: 'dev', name: 'Dev', role: 'developer', skill: '', provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
      model: 'claude-haiku-4-5', systemPrompt: 'Follow the role.', autoApprove: true, allowedTools: ['read', 'message'],
      backend: 'claude', workingDirectory: dir,
    }
    : {
      id: 'dev', name: 'Dev', role: 'developer', skill: '', provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' },
      model: CODEX_CLI_DEFAULT_MODEL, systemPrompt: 'Work.', autoApprove: true, allowedTools: ['read', 'message'],
      backend: 'codex', workingDirectory: dir,
    };
}

interface Team {
  kind: 'claude' | 'codex';
  dir: string;
  assets: ContentAssetStore;
  resolver: TaskInputResolver;
  bus: MessageBus;
  mgr: SessionManager;
  tools: TeamTools;
  claude: ReturnType<typeof fakeClaudeSpawn>;
  codex: ReturnType<typeof fakeAppServer>;
  terminal: string[];
  ended: string[];
  pm: () => ScriptedPm;
}
const teams: Team[] = [];

afterEach(async () => {
  for (const t of teams.splice(0)) {
    await t.mgr.stopAll().catch(() => undefined);
    t.bus.dispose();
    await t.assets.dispose();
    await fs.rm(t.dir, { recursive: true, force: true });
  }
});

async function team(kind: 'claude' | 'codex'): Promise<Team> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `unode-cli-msg-${kind}-`)));
  const assets = new ContentAssetStore();
  const resolver = new TaskInputResolver(assets, dir);
  const bus = new MessageBus();
  const claude = fakeClaudeSpawn();
  const codex = fakeAppServer();
  const terminal: string[] = [];
  const ended: string[] = [];
  let pm!: ScriptedPm;
  const mgr = new SessionManager(5, bus, {
    createBackend: (agent) => {
      if (agent.id === 'pm') return (pm = new ScriptedPm(agent));
      return kind === 'claude'
        ? new ClaudeHeadlessBackend(agent, undefined, undefined, { spawn: claude.fn as any, taskInputResolver: resolver, messageBus: bus })
        : new CodexBackend(agent, undefined, {
          launchProgram: fixedCodexProgram('C:/tools/codex.exe'),
          spawn: codex.spawn,
          access: () => ({ trusted: true, restricted: false, readRoots: [dir], writeRoots: [dir] }),
          requestApproval: async () => ({ allow: false }),
          killProcessTree: async () => undefined,
          taskInputResolver: resolver,
          messageBus: bus,
        });
    },
    resolveEnv: async () => ({ PATH: 'safe' }),
    // As activation wires them: a stop ends the stopped turn's attempt; a terminal attempt is reported.
    endTaskAttempt: (attemptId) => { ended.push(attemptId); resolver.endAttempt(attemptId, 'cancelled'); },
    onTaskAttemptTerminal: (attemptId) => { terminal.push(attemptId); },
  });
  // As activation wires it: a turn with no attempt card (a rework) is on the thread the session manager says it is on.
  resolver.setTurnThreadSource((agentId) => mgr.taskThreadOf(agentId));
  const view: TeamView = {
    list: () => [
      { id: 'pm', role: 'pm', name: 'PM', status: mgr.get('pm')?.status ?? 'stopped' },
      {
        id: 'dev', role: 'developer', name: 'Dev', status: mgr.get('dev')?.status ?? 'stopped', workspaceRoot: dir,
        capabilities: { read: true, write: false, shell: false, verificationSensors: [], toolFamilies: ['read'], backend: kind, taskScope: 'per-turn' as const },
      },
    ],
    resolve: (ref) => (ref === 'dev' || ref === 'Dev' ? { id: 'dev' } : undefined),
    execution: (agentId, handle) => mgr.delegationExecution(agentId, handle),
  };
  // The PM's team tools as the orchestration host builds them, for the parts these flows use.
  let tools!: TeamTools;
  tools = new TeamTools('pm', view, bus, {
    cwd: dir,
    taskInputResolver: resolver,
    replyToTask: (handle, exchangeId, text) => mgr.replyToTask('pm', handle, exchangeId, text),
    cancelDelegatedWorker: (event) => mgr.cancelDelegation(event.agentId, event.handle, event.reason ?? 'cancelled'),
    onAsyncResultReady: (result) => mgr.queueAsyncDelegationWake('pm', result,
      () => tools.isAsyncResultReady(result.handle), () => tools.consumeAsyncResult(result.handle)),
  });
  mgr.create(pmConfig());
  await mgr.start('pm', { pin: 'take' });
  pm.emit({ kind: 'ready' });
  mgr.create(devConfig(kind, dir));
  await mgr.start('dev', { pin: 'take' });
  await vi.waitFor(() => expect(mgr.get('dev')?.status).toBe('idle'));
  const t: Team = { kind, dir, assets, resolver, bus, mgr, tools, claude, codex, terminal, ended, pm: () => pm };
  teams.push(t);
  return t;
}

/** The PM model ends its current turn with this reply. */
function pmEnds(t: Team, text: string): void {
  t.pm().emit({ kind: 'turn_complete', result: { text, isError: false, responseOutcome: { kind: 'reply' } } });
}

/** What the teammate's CLI has been sent as turns: Claude's stdin packets, or Codex's turn/start inputs. */
function teammateTurns(t: Team): string[] {
  return t.kind === 'claude' ? (t.claude.clis[0]?.packets ?? []).map(packetText) : t.codex.turnStarts().map(turnStartText);
}

/** The teammate's CLI ends its turn with this final text. */
function teammateTurnEnds(t: Team, text: string): void {
  if (t.kind === 'claude') cliTurnEnds(t.claude.clis[0], text);
  else t.codex.turnEnds(text);
}

let codexCallId = 0;
/** The teammate's CLI calls send_message through its production route: the files bridge, or an App Server dynamic tool. */
async function teammateSends(t: Team, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  if (t.kind === 'claude') {
    const result = await bridgeSendMessage(t.dir, args);
    return { isError: result.isError === true, text: result.content[0].text };
  }
  const id = `codex-call-${++codexCallId}`;
  t.codex.toolCall('send_message', args, id);
  const response = await vi.waitFor(() => {
    const found = t.codex.responses.find((entry) => entry.id === id);
    expect(found).toBeDefined();
    return found;
  });
  return { isError: response.result.success !== true, text: response.result.contentItems[0].text };
}

/** The person asks the PM; the PM's model calls dispatch_task; the PM ends its turn. Returns the handle and the card. */
async function delegated(t: Team, tag: string): Promise<{ handle: string; card: TaskAttemptCard; requestId: string }> {
  t.bus.send('user', 'pm', 'ask.question', { instruction: `Please summarise the notes, ${tag}.` });
  const requestId = t.mgr.currentRequestId('pm')!;
  const out = await t.tools.run('dispatch_task', { agent: 'dev', instruction: `Write the summary, ${tag}.`, contract: CONTRACT(`Write the summary, ${tag}.`) });
  const handle = /Handle: ([0-9a-f-]+)/i.exec(out)?.[1];
  expect(handle, out).toBeDefined();
  pmEnds(t, `Dev is on it, ${tag}.`);
  await vi.waitFor(() => expect(teammateTurns(t)).toHaveLength(1));
  const assignment = t.bus.query({ type: 'task.assign' }).find((message) => message.correlationId === handle)!;
  return { handle: handle!, card: assignment.payload.taskAttempt as TaskAttemptCard, requestId };
}

/** The PM's wake that carries the teammate's question; its exchange id, when one was opened. */
async function questionWake(t: Team, question: string): Promise<{ wake: string; exchangeId?: string }> {
  const wake = await vi.waitFor(() => {
    const found = t.pm().turns.find((turn) => turn.includes(question));
    expect(found).toBeDefined();
    return found!;
  });
  return { wake, exchangeId: /exchange (exchange-[0-9a-f]{8})/.exec(wake)?.[1] };
}

const results = (t: Team, handle: string): Message[] => t.bus.query().filter((message) => message.from === 'dev' && message.correlationId === handle
  && (message.type === 'task.complete' || message.type === 'task.partial' || message.type === 'system.error'));
const exchangeRecords = (t: Team, fact: string): Message[] => t.bus.query({ type: 'ask.answer' })
  .filter((message) => (message.payload.metadata as { taskExchange?: { fact?: string } } | undefined)?.taskExchange?.fact === fact);
const waitingNotes = (t: Team, handle: string): Message[] => t.bus.query({ type: 'task.status' })
  .filter((message) => message.correlationId === handle && (message.payload.metadata as { taskWaiting?: unknown } | undefined)?.taskWaiting);
const questionClaims = (t: Team, text: string): Message[] => t.bus.query({ type: 'agent.message' })
  .filter((message) => message.from === 'dev' && message.payload.message === text);

const ATTEMPT_BOUND_RECEIPT = 'Sent to your coordinator as a question on this task. Its answer comes back into this task. Meanwhile do what does '
  + 'not depend on it; if you cannot go on without it, end your turn saying what you wait for: the task stays open and continues with the answer.';
const REWORK_RECEIPT = 'Sent to your coordinator as a question on this task; the PM is told. In a rework turn the answer does not come back '
  + 'into this turn: finish what you can, and if you need the answer, end your turn saying exactly what you need; the PM can send the task '
  + 'back to you with it.';

// ─── Design test 10: the question, its waiting checkpoint, the answer and the continuation (Claude CLI) ─────────

describe('module integration, not activation evidence: a Claude CLI teammate\'s question reaches its PM and the answer continues the same attempt (v0.9.103 design test 10)', () => {
  it('10: asked through the files bridge, the turn end is a waiting checkpoint; reply_to_task continues the same attempt and handle in a new CLI turn; exactly one result uses the answer', async () => {
    const t = await team('claude');
    const { handle, card, requestId } = await delegated(t, 'q10');
    expect(teammateTurns(t)[0]).toContain(card.attemptId);

    // 2. In its turn, the CLI calls the bridge's send_message; the host binds it to the live attempt.
    const sent = await teammateSends(t, { target: 'coordinator', message: 'Which format do you want, q10?', kind: 'question' });
    expect(sent).toEqual({ isError: false, text: ATTEMPT_BOUND_RECEIPT });
    const claims = questionClaims(t, 'Which format do you want, q10?');
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ to: 'pm', correlationId: handle });
    expect(claims[0].payload.metadata).toEqual({ taskMessage: { attemptId: card.attemptId, handle, kind: 'question', eventId: expect.stringMatching(/^task-message-/) } });
    const { wake, exchangeId } = await questionWake(t, 'Which format do you want, q10?');
    expect(exchangeId, wake).toBeDefined();
    expect(wake).toContain(`Answer it with reply_to_task: handle "${handle}", exchange_id "${exchangeId}".`);

    // The CLI ends its turn while the PM is still on the wake.
    teammateTurnEnds(t, 'Waiting for the format, q10.');
    await vi.waitFor(() => expect(waitingNotes(t, handle)).toHaveLength(1));

    // 3. The waiting checkpoint: no result, no terminal callback, no attempt cleanup.
    await tick();
    expect(results(t, handle)).toEqual([]);
    expect(t.terminal).toEqual([]);
    expect(t.ended).toEqual([]);
    expect(t.resolver.isAttemptLive(card.attemptId, 'dev')).toBe(true);
    expect(waitingNotes(t, handle)[0]).toMatchObject({ from: 'dev', to: 'pm', payload: { instruction: 'Waiting for the format, q10.' } });
    expect(t.mgr.taskExchangeFacts(handle)).toEqual({ attemptId: card.attemptId, owed: [{ exchangeId, kind: 'question', state: 'question-open' }],
      waiting: true, exchangeCount: 1 });
    expect(t.mgr.delegationExecution('dev', handle)).toEqual({ state: 'waiting-for-answer', exchangeIds: [exchangeId] });
    expect(teammateTurns(t)).toHaveLength(1);

    // 4. The PM's model answers with reply_to_task, through its real TeamTools.
    const reply = await t.tools.run('reply_to_task', { handle, exchange_id: exchangeId, text: 'Use Markdown, q10.' });
    expect(reply).toContain('continues the same task');
    pmEnds(t, 'Answered Dev, q10.');

    // 5. The continuation: a new CLI turn on the same attempt and handle; nothing dispatched again.
    await vi.waitFor(() => expect(teammateTurns(t)).toHaveLength(2));
    const continuation = teammateTurns(t)[1];
    expect(continuation).toContain(`Your question (${exchangeId}): Which format do you want, q10?\n  Answer: Use Markdown, q10.`);
    expect(continuation).toContain(card.attemptId);
    expect(t.bus.query({ type: 'task.assign' }).filter((message) => message.to === 'dev')).toHaveLength(1);
    expect(t.mgr.delegationExecution('dev', handle)).toEqual({ state: 'running' });
    expect(t.mgr.currentRequestId('dev')).toBe(requestId);
    expect(exchangeRecords(t, 'answer-delivered')).toHaveLength(1);
    expect(t.mgr.taskExchangeFacts(handle)).toMatchObject({ attemptId: card.attemptId, owed: [], waiting: false, exchangeCount: 1 });
    // The continuation turn's bridge binds to the same attempt and handle the host holds.
    const note = await teammateSends(t, { target: 'coordinator', message: 'Writing it in Markdown now, q10.', kind: 'note' });
    expect(note.isError).toBe(false);
    expect(questionClaims(t, 'Writing it in Markdown now, q10.')[0].payload.metadata)
      .toMatchObject({ taskMessage: { attemptId: card.attemptId, handle, kind: 'note' } });

    // 6. The teammate replies using the answer: exactly one result, under the original handle.
    teammateTurnEnds(t, 'Summary in Markdown, q10.');
    await vi.waitFor(() => expect(results(t, handle)).toHaveLength(1));
    await tick();
    expect(results(t, handle)).toHaveLength(1);
    expect(results(t, handle)[0]).toMatchObject({ type: 'task.complete', to: 'pm', payload: { instruction: 'Summary in Markdown, q10.' } });
    expect(t.terminal).toEqual([card.attemptId]);
    expect(waitingNotes(t, handle)).toHaveLength(1);
    expect(teammateTurns(t)).toHaveLength(2);
  });
});

// ─── Design test 11: a question in a rework turn (Claude CLI) ─────────────────────────────────────────

describe('module integration, not activation evidence: a Claude CLI teammate\'s question in a rework turn opens no exchange (v0.9.103 design test 11)', () => {
  it('11: after needs-rework the bridge question gets the rework receipt and opens no exchange; the next rework carrying the answer finishes', async () => {
    const t = await team('claude');
    const { handle, card } = await delegated(t, 'r11');
    teammateTurnEnds(t, 'Summary without the totals, r11.');
    await vi.waitFor(() => expect(results(t, handle)).toHaveLength(1));
    // The PM is woken with the result and its model records needs-rework through its real TeamTools.
    await vi.waitFor(() => expect(t.pm().turns.some((turn) => turn.includes('Summary without the totals, r11.'))).toBe(true));
    expect(await t.tools.run('record_task_disposition', { handle, disposition: 'needs-rework', reason: 'Add the totals, r11.' }))
      .toBe(`Recorded needs-rework for ${handle}; the actionable reason was sent to dev.`);
    pmEnds(t, 'Sent it back for the totals, r11.');

    // The rework turn: no attempt card, the reason, on the same CLI process.
    await vi.waitFor(() => expect(teammateTurns(t)).toHaveLength(2));
    expect(teammateTurns(t)[1]).toContain('Add the totals, r11.');
    expect(teammateTurns(t)[1]).not.toContain(card.attemptId);

    // The CLI asks through the bridge: the rework receipt, a claim with no attempt, and no exchange.
    const sent = await teammateSends(t, { target: 'coordinator', message: 'Should the totals include tax, r11?', kind: 'question' });
    expect(sent).toEqual({ isError: false, text: REWORK_RECEIPT });
    const claim = questionClaims(t, 'Should the totals include tax, r11?');
    expect(claim).toHaveLength(1);
    expect(claim[0]).toMatchObject({ to: 'pm', correlationId: handle });
    expect(claim[0].payload.metadata).toEqual({ taskMessage: { handle, kind: 'question', eventId: expect.stringMatching(/^task-message-/) } });
    const { wake, exchangeId } = await questionWake(t, 'Should the totals include tax, r11?');
    expect(exchangeId, wake).toBeUndefined();
    expect(wake).toContain(`Asked in a rework turn: no answer can go into it. When Dev's result says what it needs, send the task back with the answer: record_task_disposition needs-rework on handle "${handle}".`);
    expect(t.mgr.awaitsExchange(handle)).toBe(false);
    expect(t.mgr.taskExchangeFacts(handle)?.exchangeCount ?? 0).toBe(0);
    expect(exchangeRecords(t, 'answer-queued')).toEqual([]);
    pmEnds(t, 'Dev asked about tax, r11.');

    // The CLI ends the rework turn saying what it needs: a result, not a waiting checkpoint.
    teammateTurnEnds(t, 'I need to know whether the totals include tax, r11.');
    await vi.waitFor(() => expect(results(t, handle)).toHaveLength(2));
    expect(waitingNotes(t, handle)).toEqual([]);
    expect(results(t, handle)[1]).toMatchObject({ type: 'task.complete', to: 'pm', payload: { instruction: 'I need to know whether the totals include tax, r11.' } });

    // The PM sends the task back with the answer; the next rework finishes.
    await vi.waitFor(() => expect(t.pm().turns.some((turn) => turn.includes('I need to know whether the totals include tax, r11.'))).toBe(true));
    expect(await t.tools.run('record_task_disposition', { handle, disposition: 'needs-rework', reason: 'Answer: include tax in the totals, r11.' }))
      .toBe(`Recorded needs-rework for ${handle}; the actionable reason was sent to dev.`);
    pmEnds(t, 'Sent the tax answer back, r11.');
    await vi.waitFor(() => expect(teammateTurns(t)).toHaveLength(3));
    expect(teammateTurns(t)[2]).toContain('Answer: include tax in the totals, r11.');
    teammateTurnEnds(t, 'Totals include tax, r11.');
    await vi.waitFor(() => expect(results(t, handle)).toHaveLength(3));
    await tick();
    expect(results(t, handle)).toHaveLength(3);
    expect(results(t, handle)[2]).toMatchObject({ type: 'task.complete', to: 'pm', payload: { instruction: 'Totals include tax, r11.' } });
    expect(exchangeRecords(t, 'answer-queued')).toEqual([]);
    expect(teammateTurns(t)).toHaveLength(3);
  });
});

// ─── Design test 12: Stop while an exchange is open (Claude CLI) ───────────────────────────────────────

describe('module integration, not activation evidence: Stop of a Claude CLI teammate while its exchange is open (v0.9.103 design test 12)', () => {
  it('12: Stop during the asking turn closes the exchange undelivered and keeps its fact; a late reply_to_task is refused and no continuation starts', async () => {
    const t = await team('claude');
    const { handle, card } = await delegated(t, 's12');
    await teammateSends(t, { target: 'coordinator', message: 'Which audience, s12?', kind: 'question' });
    const { exchangeId } = await questionWake(t, 'Which audience, s12?');
    expect(exchangeId).toBeDefined();

    // The person stops Dev while its asking turn runs and the exchange is open.
    t.mgr.interrupt('dev');
    const closed = exchangeRecords(t, 'closed');
    expect(closed).toHaveLength(1);
    expect(closed[0].payload.metadata).toMatchObject({ taskExchange: { exchangeId, handle, attemptId: card.attemptId, delivered: false } });
    expect(t.ended).toEqual([card.attemptId]);
    expect(t.resolver.isAttemptLive(card.attemptId, 'dev')).toBe(false);
    // Its fact is kept: the question's claim on the bus, the exchange counted on the attempt, nothing owed.
    expect(questionClaims(t, 'Which audience, s12?')).toHaveLength(1);
    expect(t.mgr.taskExchangeFacts(handle)).toEqual({ attemptId: card.attemptId, owed: [], waiting: false, exchangeCount: 1 });
    expect(t.mgr.awaitsExchange(handle)).toBe(false);

    // The PM's model answers late: refused with the reason, nothing queued, nothing started.
    const late = await t.tools.runOutcome('reply_to_task', { handle, exchange_id: exchangeId, text: 'General readers, s12.' });
    expect(late.status).toBe('failed');
    expect(late.output).toMatch(new RegExp(`^Error: exchange ${exchangeId} is closed: the teammate was stopped`));
    expect(late.output).toContain('Nothing was sent.');
    pmEnds(t, 'Dev was stopped, s12.');
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(exchangeRecords(t, 'answer-queued')).toEqual([]);
    expect(exchangeRecords(t, 'answer-delivered')).toEqual([]);
    expect(teammateTurns(t)).toHaveLength(1);
    expect(t.claude.clis).toHaveLength(1);
  });

  it('12: Stop at the waiting checkpoint cancels the task, closes the exchange undelivered and keeps its fact; a late reply_to_task is refused and no continuation starts', async () => {
    const t = await team('claude');
    const { handle, card } = await delegated(t, 'w12');
    await teammateSends(t, { target: 'coordinator', message: 'Which audience, w12?', kind: 'question' });
    const { exchangeId } = await questionWake(t, 'Which audience, w12?');
    pmEnds(t, 'I will ask the person, w12.');
    teammateTurnEnds(t, 'Waiting for the audience, w12.');
    await vi.waitFor(() => expect(waitingNotes(t, handle)).toHaveLength(1));
    expect(t.mgr.delegationExecution('dev', handle)).toEqual({ state: 'waiting-for-answer', exchangeIds: [exchangeId] });

    t.mgr.interrupt('dev');
    expect(results(t, handle)).toHaveLength(1);
    expect(results(t, handle)[0]).toMatchObject({ type: 'system.error', to: 'pm',
      payload: { metadata: { cancelled: true, taskExchanges: { undelivered: [{ exchangeId }] } } } });
    expect(exchangeRecords(t, 'closed')[0].payload.metadata).toMatchObject({ taskExchange: { exchangeId, delivered: false } });
    expect(t.ended).toEqual([card.attemptId]);
    expect(t.mgr.taskExchangeFacts(handle)).toEqual({ attemptId: card.attemptId, owed: [], waiting: false, exchangeCount: 1 });
    expect(waitingNotes(t, handle)).toHaveLength(1);
    expect(waitingNotes(t, handle)[0].payload.instruction).toBe('Waiting for the audience, w12.');

    const late = await t.tools.runOutcome('reply_to_task', { handle, exchange_id: exchangeId, text: 'General readers, w12.' });
    expect(late.status).toBe('failed');
    expect(late.output).toMatch(new RegExp(`^Error: exchange ${exchangeId} is closed: `));
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(exchangeRecords(t, 'answer-queued')).toEqual([]);
    expect(teammateTurns(t)).toHaveLength(1);
    expect(results(t, handle)).toHaveLength(1);
  });
});

// ─── Design test 13: test 10 on a Codex CLI teammate ───────────────────────────────────────────────────

describe('module integration, not activation evidence: a Codex CLI teammate\'s question, answered in its turn or by a continuation (v0.9.103 design test 13)', () => {
  it('13: the answer goes into the running Codex turn through steerNotice (turn/steer accepted); one result, no checkpoint, no second turn', async () => {
    const t = await team('codex');
    const { handle, card } = await delegated(t, 'c13');
    expect(t.codex.clientMessages.find((message) => message.method === 'thread/start').params.dynamicTools
      .some((tool: { name: string }) => tool.name === 'send_message')).toBe(true);

    const sent = await teammateSends(t, { target: 'coordinator', message: 'Which format do you want, c13?', kind: 'question' });
    expect(sent).toEqual({ isError: false, text: ATTEMPT_BOUND_RECEIPT });
    expect(questionClaims(t, 'Which format do you want, c13?')[0].payload.metadata)
      .toEqual({ taskMessage: { attemptId: card.attemptId, handle, kind: 'question', eventId: expect.stringMatching(/^task-message-/) } });
    const { exchangeId } = await questionWake(t, 'Which format do you want, c13?');
    expect(exchangeId).toBeDefined();

    // The PM answers while Codex's turn runs: App Server takes the steer of this exact turn.
    const reply = await t.tools.run('reply_to_task', { handle, exchange_id: exchangeId, text: 'Use Markdown, c13.' });
    expect(reply).toContain('goes into Dev\'s running turn');
    await vi.waitFor(() => expect(exchangeRecords(t, 'answer-delivered')).toHaveLength(1));
    const steers = t.codex.steers();
    expect(steers).toHaveLength(1);
    expect(steers[0].params.expectedTurnId).toBe('turn-1');
    expect(JSON.stringify(steers[0].params.input)).toContain(`(${exchangeId}): Use Markdown, c13.`);
    expect(t.mgr.taskExchangeFacts(handle)).toMatchObject({ owed: [], waiting: false, exchangeCount: 1 });
    pmEnds(t, 'Answered Dev, c13.');

    t.codex.turnEnds('Summary in Markdown, c13.');
    await vi.waitFor(() => expect(results(t, handle)).toHaveLength(1));
    await tick();
    expect(results(t, handle)[0]).toMatchObject({ type: 'task.complete', to: 'pm', payload: { instruction: 'Summary in Markdown, c13.' } });
    expect(results(t, handle)).toHaveLength(1);
    expect(waitingNotes(t, handle)).toEqual([]);
    expect(t.terminal).toEqual([card.attemptId]);
    expect(teammateTurns(t)).toHaveLength(1);
  });

  it('13: when App Server refuses the steer, the turn end is a waiting checkpoint and the answer continues the same attempt in a new Codex turn; exactly one result', async () => {
    const t = await team('codex');
    t.codex.state.steer = 'refuse';
    const { handle, card, requestId } = await delegated(t, 'f13');
    await teammateSends(t, { target: 'coordinator', message: 'Which format do you want, f13?', kind: 'question' });
    const { exchangeId } = await questionWake(t, 'Which format do you want, f13?');
    expect(exchangeId).toBeDefined();

    // Answered while the turn runs; App Server refuses the steer, so the answer stays queued for the continuation.
    expect(await t.tools.run('reply_to_task', { handle, exchange_id: exchangeId, text: 'Use Markdown, f13.' })).toContain('Answer accepted');
    await vi.waitFor(() => expect(t.codex.steers()).toHaveLength(1));
    await tick();
    expect(exchangeRecords(t, 'answer-delivered')).toEqual([]);
    expect(t.mgr.taskExchangeFacts(handle)!.owed).toEqual([{ exchangeId, kind: 'question', state: 'answer-queued' }]);
    pmEnds(t, 'Answered Dev, f13.');

    // The Codex turn ends: a waiting checkpoint, no result, and then the continuation of the same attempt.
    t.codex.turnEnds('Waiting for the format, f13.');
    await vi.waitFor(() => expect(waitingNotes(t, handle)).toHaveLength(1));
    expect(results(t, handle)).toEqual([]);
    expect(t.ended).toEqual([]);
    await vi.waitFor(() => expect(teammateTurns(t)).toHaveLength(2));
    expect(t.terminal).toEqual([]);
    expect(t.resolver.isAttemptLive(card.attemptId, 'dev')).toBe(true);
    expect(teammateTurns(t)[1]).toContain(`Your question (${exchangeId}): Which format do you want, f13?\n  Answer: Use Markdown, f13.`);
    expect(t.bus.query({ type: 'task.assign' }).filter((message) => message.to === 'dev')).toHaveLength(1);
    expect(t.mgr.delegationExecution('dev', handle)).toEqual({ state: 'running' });
    expect(t.mgr.currentRequestId('dev')).toBe(requestId);
    expect(exchangeRecords(t, 'answer-delivered')).toHaveLength(1);
    // The continuation turn's dynamic tool binds to the same attempt and handle.
    await teammateSends(t, { target: 'coordinator', message: 'Writing it in Markdown now, f13.', kind: 'note' });
    expect(questionClaims(t, 'Writing it in Markdown now, f13.')[0].payload.metadata)
      .toMatchObject({ taskMessage: { attemptId: card.attemptId, handle, kind: 'note' } });

    t.codex.turnEnds('Summary in Markdown, f13.');
    await vi.waitFor(() => expect(results(t, handle)).toHaveLength(1));
    await tick();
    expect(results(t, handle)).toHaveLength(1);
    expect(results(t, handle)[0]).toMatchObject({ type: 'task.complete', to: 'pm', payload: { instruction: 'Summary in Markdown, f13.' } });
    expect(t.terminal).toEqual([card.attemptId]);
    expect(teammateTurns(t)).toHaveLength(2);
  });
});

// ─── v0.9.104 D1.1 (ROADMAP item 5): the same exchange, asked with Codex's own question tool ─────────

describe('module integration, not activation evidence: a Codex teammate asks with its own question tool, and the answer continues the same task (v0.9.104 D1.1)', () => {
  const NATIVE = (tag: string) => `Which format do you want, ${tag}?\nOptions: Markdown, Plain text`;

  it('native, answered in its turn: one question claim bound to the attempt, reply_to_task steers it into the running turn, one result', async () => {
    const t = await team('codex');
    const { handle, card } = await delegated(t, 'n13');
    t.codex.nativeQuestion('Which format do you want, n13?', ['Markdown', 'Plain text']);
    await vi.waitFor(() => expect(questionClaims(t, NATIVE('n13'))).toHaveLength(1));
    expect(questionClaims(t, NATIVE('n13'))[0].payload.metadata)
      .toEqual({ taskMessage: { attemptId: card.attemptId, handle, kind: 'question', eventId: expect.stringMatching(/^task-message-/) } });
    const { exchangeId } = await questionWake(t, NATIVE('n13'));
    expect(exchangeId).toBeDefined();

    const reply = await t.tools.run('reply_to_task', { handle, exchange_id: exchangeId, text: 'Use Markdown, n13.' });
    expect(reply).toContain('goes into Dev\'s running turn');
    await vi.waitFor(() => expect(exchangeRecords(t, 'answer-delivered')).toHaveLength(1));
    expect(t.codex.steers()).toHaveLength(1);
    expect(JSON.stringify(t.codex.steers()[0].params.input)).toContain(`(${exchangeId}): Use Markdown, n13.`);
    pmEnds(t, 'Answered Dev, n13.');

    t.codex.turnEnds('Summary in Markdown, n13.');
    await vi.waitFor(() => expect(results(t, handle)).toHaveLength(1));
    await tick();
    expect(results(t, handle)[0]).toMatchObject({ type: 'task.complete', to: 'pm', payload: { instruction: 'Summary in Markdown, n13.' } });
    expect(results(t, handle)).toHaveLength(1);
    expect(waitingNotes(t, handle)).toEqual([]);
    expect(questionClaims(t, NATIVE('n13'))).toHaveLength(1);
    expect(teammateTurns(t)).toHaveLength(1);
  });

  it('native, the turn ends while waiting: a waiting checkpoint, not a result; the answer continues the same attempt and handle', async () => {
    const t = await team('codex');
    t.codex.state.steer = 'refuse';
    const { handle, card } = await delegated(t, 'w13');
    t.codex.nativeQuestion('Which format do you want, w13?', ['Markdown', 'Plain text']);
    const { exchangeId } = await questionWake(t, NATIVE('w13'));
    expect(exchangeId).toBeDefined();
    pmEnds(t, 'Thinking about it, w13.');

    // The model slept and ended its turn saying it waits: the attempt waits too, with nothing published.
    t.codex.turnEnds('I am waiting for the format, w13.');
    await vi.waitFor(() => expect(waitingNotes(t, handle)).toHaveLength(1));
    expect(results(t, handle)).toEqual([]);
    expect(t.resolver.isAttemptLive(card.attemptId, 'dev')).toBe(true);

    expect(await t.tools.run('reply_to_task', { handle, exchange_id: exchangeId, text: 'Use Markdown, w13.' })).toContain('turn had ended waiting');
    await vi.waitFor(() => expect(teammateTurns(t)).toHaveLength(2));
    expect(teammateTurns(t)[1]).toContain(`Your question (${exchangeId}): ${NATIVE('w13')}\n  Answer: Use Markdown, w13.`);
    expect(t.bus.query({ type: 'task.assign' }).filter((message) => message.to === 'dev')).toHaveLength(1);
    pmEnds(t, 'Answered Dev, w13.');

    t.codex.turnEnds('Summary in Markdown, w13.');
    await vi.waitFor(() => expect(results(t, handle)).toHaveLength(1));
    await tick();
    expect(results(t, handle)).toHaveLength(1);
    expect(t.terminal).toEqual([card.attemptId]);
  });

  it('native, Stop while waiting for the answer: the exchange closes undelivered, a late answer is refused and nothing continues', async () => {
    const t = await team('codex');
    const { handle, card } = await delegated(t, 's13');
    t.codex.nativeQuestion('Which format do you want, s13?', ['Markdown', 'Plain text']);
    const { exchangeId } = await questionWake(t, NATIVE('s13'));
    expect(exchangeId).toBeDefined();

    t.mgr.interrupt('dev');
    const closed = exchangeRecords(t, 'closed');
    expect(closed).toHaveLength(1);
    expect(closed[0].payload.metadata).toMatchObject({ taskExchange: { exchangeId, handle, attemptId: card.attemptId, delivered: false } });
    expect(t.resolver.isAttemptLive(card.attemptId, 'dev')).toBe(false);

    const late = await t.tools.runOutcome('reply_to_task', { handle, exchange_id: exchangeId, text: 'Use Markdown, s13.' });
    expect(late.status).toBe('failed');
    expect(late.output).toContain('Nothing was sent.');
    pmEnds(t, 'Dev was stopped, s13.');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(exchangeRecords(t, 'answer-delivered')).toEqual([]);
    expect(t.codex.steers()).toEqual([]);
    expect(teammateTurns(t)).toHaveLength(1);
  });
});
