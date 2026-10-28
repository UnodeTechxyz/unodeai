import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { OpenAICompatBackend, type BackendNetworkOptions, type FetchFn, type StreamFetchFn } from '../OpenAICompatBackend';
import type { BackendEvent } from '../AgentBackend';
import type { AgentConfig } from '../../types';
import { MCPHub } from '../../mcp/MCPHub';
import { REQUEST_LIMIT_STOPPED_REFUSAL, type RequestBoundary, type RequestBoundaryDetail, type RequestBoundaryOutcome } from '../requestBoundary';

/* v0.9.94: the request limit boundary on the OpenAI-compatible route. Asked before every model request and
   before every call that acts; while it is pending nothing leaves and nothing runs. */

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'a1', name: 'Worker', role: 'senior-dev', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-chat', systemPrompt: 'Be terse.', autoApprove: true, allowedTools: ['read', 'write'],
    workingDirectory: process.cwd(),
    ...overrides,
  };
}

interface Asked {
  kind: string;
  detail?: RequestBoundaryDetail;
  answer(outcome: RequestBoundaryOutcome): void;
}

/** A boundary the test answers by hand, and the order in which it and the transport were reached. */
function heldBoundary(log: string[]) {
  const asked: Asked[] = [];
  const boundary: RequestBoundary = (kind, detail) => new Promise((resolve) => {
    log.push(`boundary:${kind}${detail?.tool ? `:${detail.tool}` : ''}`);
    asked.push({ kind, detail, answer: resolve });
  });
  return { boundary, asked };
}

function scriptedFetch(log: string[], responses: Array<{ status?: number; body: unknown }>): FetchFn {
  let index = 0;
  return async () => {
    log.push('fetch');
    const response = responses[Math.min(index++, responses.length - 1)];
    const status = response.status ?? 200;
    return { ok: status === 200, status, text: async () => JSON.stringify(response.body) };
  };
}

const reply = (content: string, usage?: Record<string, unknown>) => ({
  body: { choices: [{ message: { role: 'assistant', content } }], ...(usage ? { usage } : {}) },
});
const toolCalls = (...calls: Array<[string, Record<string, unknown>]>) => ({
  body: {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: calls.map(([name, args], index) => ({
      id: `call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
    })) } }],
    usage: { prompt_tokens: 40, completion_tokens: 4 },
  },
});

function backendWith(fetchFn: FetchFn, net: BackendNetworkOptions, options: { config?: Partial<AgentConfig>; mcp?: any; streamFetchFn?: StreamFetchFn } = {}) {
  return new OpenAICompatBackend(
    config(options.config), fetchFn, undefined, undefined, undefined,
    { retryBaseMs: 0, ...net }, options.mcp, options.streamFetchFn,
  );
}

async function startTurn(backend: OpenAICompatBackend, log: string[]) {
  const events: BackendEvent[] = [];
  const done = new Promise<Extract<BackendEvent, { kind: 'turn_complete' }>>((resolve) => {
    backend.onEvent((event) => {
      events.push(event);
      if (event.kind === 'model_request') log.push('model_request');
      if (event.kind === 'turn_complete') resolve(event);
    });
  });
  await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
  backend.sendUserTurn('go');
  return { events, done };
}

/** Let everything that can run without a further answer run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !condition(); turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(condition()).toBe(true);
}

const dirs: string[] = [];
async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-request-boundary-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const exists = (file: string) => fs.access(file).then(() => true, () => false);

describe('OpenAI-compatible request boundary before a model request', () => {
  it('asks before every model request, and nothing leaves while the answer is pending', async () => {
    const log: string[] = [];
    const { boundary, asked } = heldBoundary(log);
    const backend = backendWith(scriptedFetch(log, [toolCalls(['list_dir', { path: '.' }]), reply('done')]), { onRequestBoundary: boundary });
    const { done } = await startTurn(backend, log);

    await until(() => asked.length === 1);
    await settle();
    // Held: no request was counted and none left.
    expect(log).toEqual(['boundary:provider-request']);
    asked[0].answer('proceed');
    await until(() => asked.length === 2);
    await settle();
    // The listing between the two requests is a read: it never asked.
    expect(log).toEqual(['boundary:provider-request', 'model_request', 'fetch', 'boundary:provider-request']);
    asked[1].answer('proceed');

    const result = (await done).result;
    expect(result.text).toBe('done');
    expect(log).toEqual([
      'boundary:provider-request', 'model_request', 'fetch',
      'boundary:provider-request', 'model_request', 'fetch',
    ]);
    // The turn's own stop signal travels with the question, so the host can end a held wait with the turn.
    expect(asked[0].detail?.signal).toBeInstanceOf(AbortSignal);
  });

  it('asks again before each retry of the same request', async () => {
    const log: string[] = [];
    const { boundary, asked } = heldBoundary(log);
    const backend = backendWith(
      scriptedFetch(log, [{ status: 503, body: { error: 'busy' } }, reply('recovered')]),
      { onRequestBoundary: boundary, maxRetries: 2 },
    );
    const { done } = await startTurn(backend, log);
    await until(() => asked.length === 1);
    asked[0].answer('proceed');
    await until(() => asked.length === 2);
    await settle();
    expect(log).toEqual(['boundary:provider-request', 'model_request', 'fetch', 'boundary:provider-request']);
    asked[1].answer('proceed');
    expect((await done).result.text).toBe('recovered');
    expect(log.filter((entry) => entry === 'fetch')).toHaveLength(2);
  });

  it('ends the turn as a stop, with no request and no provider error, when the person stops the request', async () => {
    const log: string[] = [];
    const backend = backendWith(scriptedFetch(log, [reply('never sent')]), { onRequestBoundary: async () => 'stopped', maxRetries: 3 });
    const { events, done } = await startTurn(backend, log);
    const result = (await done).result;
    expect(result.responseOutcome).toEqual({ kind: 'stopped' });
    expect(result.text).toBe('[Stopped by user]');
    // Nothing left, nothing was counted as an attempt, and no usage was rebuilt for a request that was never sent.
    expect(log).toEqual([]);
    expect(result.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, usageBasis: 'reported', attributedAttempts: 0 });
    expect(events.some((event) => event.kind === 'error')).toBe(false);
    expect(events.some((event) => event.kind === 'log' && /retry/.test(event.line))).toBe(false);
  });

  it('keeps the usage of the responses that completed before the stop', async () => {
    const log: string[] = [];
    let asks = 0;
    const backend = backendWith(
      scriptedFetch(log, [toolCalls(['list_dir', { path: '.' }]), reply('never sent')]),
      { onRequestBoundary: async () => (++asks === 1 ? 'proceed' : 'stopped') },
    );
    const { done } = await startTurn(backend, log);
    const result = (await done).result;
    expect(result.responseOutcome).toEqual({ kind: 'stopped' });
    expect(log).toEqual(['model_request', 'fetch']);
    expect(result.usage).toMatchObject({ inputTokens: 40, outputTokens: 4, attributedAttempts: 1 });
  });

  it('opens no stream and rebuilds no usage when a streaming request is stopped at the boundary', async () => {
    const log: string[] = [];
    const streamFetchFn: StreamFetchFn = async () => {
      log.push('stream');
      throw new Error('the stream must not be opened');
    };
    const backend = backendWith(scriptedFetch(log, [reply('never sent')]), { onRequestBoundary: async () => 'stopped' }, { streamFetchFn });
    const { events, done } = await startTurn(backend, log);
    const result = (await done).result;
    expect(result.responseOutcome).toEqual({ kind: 'stopped' });
    expect(log).toEqual([]);
    expect(result.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, usageBasis: 'reported' });
    // Not a failed stream: no fallback to the non-streaming transport was tried.
    expect(events.some((event) => event.kind === 'log' && /falling back/.test(event.line))).toBe(false);
  });

  it('asks before a streaming request and holds the stream until the answer', async () => {
    const log: string[] = [];
    const { boundary, asked } = heldBoundary(log);
    const encoder = new TextEncoder();
    const streamFetchFn: StreamFetchFn = async () => {
      log.push('stream');
      return {
        ok: true, status: 200,
        body: (async function* () {
          yield encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`);
          yield encoder.encode('data: [DONE]\n\n');
        })(),
      };
    };
    const backend = backendWith(scriptedFetch(log, []), { onRequestBoundary: boundary }, { streamFetchFn });
    const { done } = await startTurn(backend, log);
    await until(() => asked.length === 1);
    await settle();
    expect(log).toEqual(['boundary:provider-request']);
    asked[0].answer('proceed');
    expect((await done).result.text).toBe('hi');
    expect(log).toEqual(['boundary:provider-request', 'model_request', 'stream']);
  });

  it('ends a held turn at once when the person stops the agent, without waiting for the boundary', async () => {
    const log: string[] = [];
    const { boundary, asked } = heldBoundary(log);
    const backend = backendWith(scriptedFetch(log, [reply('never sent')]), { onRequestBoundary: boundary });
    const { done } = await startTurn(backend, log);
    await until(() => asked.length === 1);
    backend.abort();
    const result = (await done).result;
    expect(result.responseOutcome).toEqual({ kind: 'stopped' });
    expect(log).toEqual(['boundary:provider-request']);
    expect(asked[0].detail?.signal?.aborted).toBe(true);
    // The boundary was never answered, and a late answer starts nothing.
    asked[0].answer('proceed');
    await settle();
    expect(log).toEqual(['boundary:provider-request']);
  });

  it('stops rather than sends when the boundary itself fails', async () => {
    const log: string[] = [];
    const backend = backendWith(scriptedFetch(log, [reply('never sent')]), { onRequestBoundary: async () => { throw new Error('host fault'); } });
    const { done } = await startTurn(backend, log);
    expect((await done).result.responseOutcome).toEqual({ kind: 'stopped' });
    expect(log).toEqual([]);
  });
});

describe('OpenAI-compatible request boundary before a call that acts', () => {
  it('holds a write until the answer, runs it after Continue, and never asks for a read', async () => {
    const dir = await workspace();
    await fs.writeFile(path.join(dir, 'notes.txt'), 'existing');
    const log: string[] = [];
    const { boundary, asked } = heldBoundary(log);
    const backend = backendWith(
      scriptedFetch(log, [
        toolCalls(['read_file', { path: 'notes.txt' }], ['write_file', { path: 'out.txt', content: 'written' }]),
        reply('done'),
      ]),
      { onRequestBoundary: boundary },
      { config: { workingDirectory: dir } },
    );
    const { events, done } = await startTurn(backend, log);
    await until(() => asked.length === 1);
    asked[0].answer('proceed');
    await until(() => asked.length === 2);
    await settle();
    // The read ran without asking; the write is held and has not touched the disk.
    expect(log).toEqual(['boundary:provider-request', 'model_request', 'fetch', 'boundary:effect:write_file']);
    expect(events.filter((event) => event.kind === 'tool_result').map((event) => (event as { name: string }).name)).toEqual(['read_file']);
    expect(await exists(path.join(dir, 'out.txt'))).toBe(false);

    asked[1].answer('proceed');
    await until(() => asked.length === 3);
    expect(await fs.readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('written');
    asked[2].answer('proceed');
    await done;
    expect(events.filter((event) => event.kind === 'tool_result').map((event) => (event as { outcome: { status: string } }).outcome.status))
      .toEqual(['success', 'success']);
  });

  it('refuses a held write with the typed safety-limit refusal when the person stops the request', async () => {
    const dir = await workspace();
    const log: string[] = [];
    const answers: RequestBoundaryOutcome[] = ['proceed', 'stopped', 'stopped'];
    const backend = backendWith(
      scriptedFetch(log, [toolCalls(['write_file', { path: 'out.txt', content: 'written' }]), reply('never sent')]),
      { onRequestBoundary: async () => answers.shift() ?? 'stopped' },
      { config: { workingDirectory: dir } },
    );
    const { events, done } = await startTurn(backend, log);
    const result = (await done).result;
    expect(await exists(path.join(dir, 'out.txt'))).toBe(false);
    const refused = events.find((event) => event.kind === 'tool_result') as Extract<BackendEvent, { kind: 'tool_result' }>;
    expect(refused.outcome).toEqual({ status: 'refused', observedBy: 'host', reason: 'safety-limit' });
    expect(refused.detail ?? refused.summary).toContain(REQUEST_LIMIT_STOPPED_REFUSAL);
    // The next model request is stopped at the boundary too, so the turn ends as a stop and sends nothing more.
    expect(result.responseOutcome).toEqual({ kind: 'stopped' });
    expect(log).toEqual(['model_request', 'fetch']);
  });

  it('asks before an integration call and before a Skill action, and runs neither when stopped', async () => {
    const calls: string[] = [];
    const hub = new MCPHub(async () => ({
      async listTools() { return [{ name: 'create_pr', description: 'create a PR' }]; },
      async callTool() { calls.push('mcp'); return 'created'; },
      async close() { /* nothing to release */ },
    }));
    await hub.register({ id: 'github', name: 'GitHub', transport: 'stdio', command: 'npx' });
    const skills = {
      toolSpec: () => ({
        type: 'function', returnsExternalContent: true,
        function: { name: 'run_skill_action', description: 'Approved action.', parameters: { type: 'object', properties: {} } },
      }),
      async run() { calls.push('skill'); return { source: 'host', contentSource: 'host', status: 'success', output: 'ran' }; },
    };
    const script = () => [
      toolCalls(['github__create_pr', { title: 't' }], ['run_skill_action', { name: 'audit', action: 'run', input: {} }]),
      reply('done'),
    ];

    // Held, then continued: each call runs only after its own answer.
    const log: string[] = [];
    const { boundary, asked } = heldBoundary(log);
    const continued = backendWith(scriptedFetch(log, script()), { onRequestBoundary: boundary }, { mcp: { hub, grants: [{ serverId: 'github', toolFilter: 'all' }] } });
    (continued as any).executableSkills = skills;
    const first = await startTurn(continued, log);
    await until(() => asked.length === 1);
    asked[0].answer('proceed');
    await until(() => asked.length === 2);
    await settle();
    expect(log.at(-1)).toBe('boundary:effect:github__create_pr');
    expect(calls).toEqual([]);
    asked[1].answer('proceed');
    await until(() => asked.length === 3);
    await settle();
    expect(log.at(-1)).toBe('boundary:effect:run_skill_action');
    expect(calls).toEqual(['mcp']);
    asked[2].answer('proceed');
    await until(() => asked.length === 4);
    expect(calls).toEqual(['mcp', 'skill']);
    asked[3].answer('proceed');
    await first.done;

    // Stopped: both are refused and neither runs.
    calls.length = 0;
    const answers: RequestBoundaryOutcome[] = ['proceed'];
    const stopped = backendWith(scriptedFetch([], script()), { onRequestBoundary: async () => answers.shift() ?? 'stopped' }, { mcp: { hub, grants: [{ serverId: 'github', toolFilter: 'all' }] } });
    (stopped as any).executableSkills = skills;
    const second = await startTurn(stopped, []);
    await second.done;
    expect(calls).toEqual([]);
    expect(second.events.filter((event) => event.kind === 'tool_result').map((event) => (event as { outcome: unknown }).outcome)).toEqual([
      { status: 'refused', observedBy: 'host', reason: 'safety-limit' },
      { status: 'refused', observedBy: 'host', reason: 'safety-limit' },
    ]);
  });

  it('hands the coordinator tools a boundary that ends with the turn', async () => {
    let received: RequestBoundary | undefined;
    const asked: RequestBoundaryDetail[] = [];
    const team = { setRequestBoundary: (boundary: RequestBoundary) => { received = boundary; } };
    const backend = new OpenAICompatBackend(
      config(), scriptedFetch([], [reply('done')]), team as any, undefined, undefined,
      { retryBaseMs: 0, onRequestBoundary: async (_kind, detail) => { asked.push(detail ?? {}); return 'stopped'; } },
    );
    expect(received).toBeTypeOf('function');
    expect(await received!('effect', { tool: 'dispatch_task' })).toBe('stopped');
    expect(asked).toEqual([{ tool: 'dispatch_task', signal: undefined }]);
    // Without a boundary the coordinator tools are left exactly as the host built them.
    received = undefined;
    void new OpenAICompatBackend(config(), scriptedFetch([], [reply('done')]), team as any);
    expect(received).toBeUndefined();
    void backend;
  });
});
