import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeHeadlessBackend, CLAUDE_SEND_MESSAGE_NOTE, type ClaudeHeadlessBackendDeps } from '../ClaudeHeadlessBackend';
import type { AgentConfig, Message } from '../../types';
import { MessageBus } from '../../bus/MessageBus';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { compileTaskContract, TaskInputResolver } from '../TaskContract';
import { sendMessageToolSpec } from '../WorkspaceTools';
import type { RequestBoundary, RequestBoundaryOutcome } from '../requestBoundary';

/*
 * v0.9.103 (DESIGN_v09103_cli_teammate_messages §3, tests 1-4): a Claude CLI teammate is offered UnodeAi's
 * send_message on its files bridge, bound to the live task, and a held call whose turn ended or was cancelled sends
 * nothing. The production ClaudeHeadlessBackend with a fake process and its real files bridge server over HTTP.
 */

const AGENT = 'claude-dev-m1';

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: AGENT, name: 'Claude Dev', role: 'developer', skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-haiku-4-5', systemPrompt: 'Follow the role.', autoApprove: true,
    allowedTools: ['read', 'write', 'execute', 'message'], backend: 'claude', workingDirectory: process.cwd(),
    ...overrides,
  };
}

function fakeSpawn() {
  const calls: Array<{ args: string[] }> = [];
  const procs: any[] = [];
  const fn = (_command: string, args: string[]) => {
    calls.push({ args });
    const proc = new EventEmitter() as any;
    proc.pid = 4321;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = { write: () => true, end: () => undefined };
    proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
    procs.push(proc);
    setTimeout(() => proc.emit('spawn'), 0);
    return proc;
  };
  return { fn, calls, procs };
}

function heldBoundary() {
  const asked: Array<{ answer(outcome: RequestBoundaryOutcome): void }> = [];
  const boundary: RequestBoundary = () => new Promise((resolve) => { asked.push({ answer: resolve }); });
  return { boundary, asked };
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check(), label).toBe(true);
}

function mcpJsonPath(dir: string): string {
  const root = path.join(dir, '.unode', 'claude');
  const files = existsSync(root) ? readdirSync(root).map((id) => path.join(root, id, 'mcp.json')).filter((file) => existsSync(file)) : [];
  expect(files).toHaveLength(1);
  return files[0];
}

async function bridgeEndpoint(dir: string): Promise<{ port: number; token?: string }> {
  const written = JSON.parse(await fs.readFile(mcpJsonPath(dir), 'utf8'));
  const serverId = Object.keys(written.mcpServers).find((id) => /^unode_files_[a-f0-9]{32}$/.test(id));
  expect(serverId).toBeTruthy();
  const spec = written.mcpServers[serverId!];
  const auth = String(spec.headers?.Authorization ?? '');
  return { port: Number(new URL(spec.url).port), token: auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined };
}

/** One JSON-RPC POST; `request` is exposed so a test can drop the connection (the client's cancellation). */
function rpc(endpoint: { port: number; token?: string }, body: unknown): { result: Promise<any>; request: http.ClientRequest } {
  const text = JSON.stringify(body);
  let request!: http.ClientRequest;
  const result = new Promise<any>((resolve, reject) => {
    request = http.request({
      host: '127.0.0.1', port: endpoint.port, path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text),
        ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}) },
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (out += chunk));
      res.on('end', () => resolve(out ? JSON.parse(out).result : undefined));
    });
    request.on('error', reject);
    request.end(text);
  });
  return { result, request };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function team(options: { config?: Partial<AgentConfig>; deps?: Partial<ClaudeHeadlessBackendDeps>; bus?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-claude-msg-'));
  const store = new ContentAssetStore();
  const resolver = new TaskInputResolver(store, dir);
  const bus = new MessageBus();
  const sent: Message[] = [];
  bus.onType('agent.message', (message) => { sent.push(message); });
  for (const member of ['pm', AGENT]) bus.onAddressed(member, () => undefined);
  const spawn = fakeSpawn();
  const backend = new ClaudeHeadlessBackend(config({ workingDirectory: dir, ...options.config }), undefined, undefined, {
    spawn: spawn.fn as any,
    taskInputResolver: resolver,
    ...(options.bus === false ? {} : { messageBus: bus }),
    ...options.deps,
  });
  cleanups.push(async () => {
    await backend.stop(50);
    await store.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await backend.start({} as NodeJS.ProcessEnv, { pin: 'take' });
  const liveCard = async (handle: string) => {
    const contract = compileTaskContract({
      version: 1, objective: 'Write the summary.', effects: { read_files: [], expected_file_effect: 'none' }, inputs: [],
      required_capabilities: { version: 1, capabilities: ['read'] }, execution_strategy: 'delegate-required',
    }, 'pm').contract!;
    const card = (await resolver.beginAttempt(contract, {
      agentId: AGENT, capabilities: { read: true, write: false, shell: false }, taskScope: 'per-turn',
      verificationSensors: [], authorizedContentAssetIds: [], liveContentAssetIds: [], readyArtifacts: [],
    }, 'pm')).card!;
    resolver.bindAttemptHandle(card.attemptId, handle);
    return card;
  };
  const endTurn = async () => (backend as any).handleEvent({ type: 'result', subtype: 'success', result: 'done' });
  return { dir, backend, spawn, bus, sent, resolver, liveCard, endTurn };
}

const callArgs = (id: number, args: Record<string, unknown>) =>
  ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'send_message', arguments: args } });

describe('Claude CLI teammate: send_message on the files bridge (v0.9.103, CLI teammate messages)', () => {
  // Design test 1 (offered).
  it('lists send_message, with the shared spec plus the Claude note, when the role has message and the host a bus', async () => {
    const { dir, spawn } = await team();
    expect(spawn.calls[0].args).toContainEqual(expect.stringMatching(/^mcp__unode_files_[a-f0-9]{32}__send_message$/));
    const endpoint = await bridgeEndpoint(dir);
    const list = await rpc(endpoint, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).result;
    const tool = list.tools.find((entry: any) => entry.name === 'send_message');
    const shared = sendMessageToolSpec().function;
    expect(tool.description).toBe(`${shared.description} ${CLAUDE_SEND_MESSAGE_NOTE}`);
    expect(tool.inputSchema).toEqual(shared.parameters);
  });

  // Design test 1, preserved halves: no message tool on the role, or no bus.
  it('does not list send_message without the role\'s message tool, nor without a bus', async () => {
    const withoutRole = await team({ config: { allowedTools: ['read', 'write', 'execute'] } });
    expect(withoutRole.spawn.calls[0].args.some((arg) => arg.endsWith('__send_message'))).toBe(false);
    const withoutBus = await team({ bus: false });
    expect(withoutBus.spawn.calls[0].args.some((arg) => arg.endsWith('__send_message'))).toBe(false);
  });

  // Design test 2 (bound).
  it('binds a question to the coordinator to the live attempt the host holds and puts exactly one message on the bus', async () => {
    const { dir, backend, sent, liveCard } = await team();
    const card = await liveCard('handle-claude-q1');
    backend.sendUserTurn('Write the summary.', { taskAttempt: card });
    const result = await rpc(await bridgeEndpoint(dir), callArgs(2, { target: 'coordinator', message: 'Who reads it, claude-q1?', kind: 'question' })).result;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/^Sent to your coordinator as a question on this task\. Its answer comes back into this task\./);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: AGENT, to: 'pm', correlationId: 'handle-claude-q1', payload: { message: 'Who reads it, claude-q1?' } });
    expect(sent[0].payload.metadata).toEqual({ taskMessage: {
      attemptId: card.attemptId, handle: 'handle-claude-q1', kind: 'question', eventId: expect.stringMatching(/^task-message-/) } });
  });

  // Design test 3 (hold and cancel): the client drops the call while the request limit holds it.
  it('sends nothing for a held call the client cancelled, and exactly once for a held call released normally', async () => {
    const { boundary, asked } = heldBoundary();
    const { dir, backend, sent, liveCard } = await team({ deps: { requestBoundary: boundary } });
    const card = await liveCard('handle-claude-h1');
    backend.sendUserTurn('Write the summary.', { taskAttempt: card });
    const endpoint = await bridgeEndpoint(dir);

    const dropped = rpc(endpoint, callArgs(3, { target: 'coordinator', message: 'Dropped claude-h1?', kind: 'question' }));
    dropped.result.catch(() => undefined);
    await until(() => asked.length === 1, 'the first call is held');
    dropped.request.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    asked[0].answer('proceed');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent).toHaveLength(0);

    const released = rpc(endpoint, callArgs(4, { target: 'coordinator', message: 'Released claude-h1?', kind: 'question' }));
    await until(() => asked.length === 2, 'the second call is held');
    asked[1].answer('proceed');
    expect((await released.result).isError).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.message).toBe('Released claude-h1?');
  });

  // Design test 4 (stale turn): the turn ends while the call is held; releasing it afterwards sends nothing.
  it('sends nothing, and says so, for a held call whose turn ended before it was released', async () => {
    const { boundary, asked } = heldBoundary();
    const { dir, backend, sent, liveCard, endTurn } = await team({ deps: { requestBoundary: boundary } });
    const card = await liveCard('handle-claude-s1');
    backend.sendUserTurn('Write the summary.', { taskAttempt: card });
    const held = rpc(await bridgeEndpoint(dir), callArgs(5, { target: 'coordinator', message: 'Stale claude-s1?', kind: 'question' }));
    await until(() => asked.length === 1, 'the call is held');
    await endTurn();
    asked[0].answer('proceed');
    const result = await held.result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error: nothing was sent: the turn this message belonged to has ended.');
    expect(sent).toHaveLength(0);
  });

  // Design test 4, outside any turn: a call between turns has no origin and sends nothing.
  it('sends nothing for a call that arrives when no turn is open', async () => {
    const { dir, sent } = await team();
    const result = await rpc(await bridgeEndpoint(dir), callArgs(6, { target: 'pm', message: 'Between turns claude-b1.' })).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error: nothing was sent: the turn this message belonged to has ended.');
    expect(sent).toHaveLength(0);
  });
});
