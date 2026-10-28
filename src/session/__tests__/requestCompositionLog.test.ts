import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler } from '../../backend/AgentBackend';
import { OpenAICompatBackend } from '../../backend/OpenAICompatBackend';
import { projectHostSubmitComposition, projectProviderComposition } from '../../backend/RequestComposition';
import type { AgentConfig } from '../../types';

const privateId = 'PRIVATE_ID/https://private.invalid';
function config(backend: AgentConfig['backend']): AgentConfig {
  return { id: privateId, name: 'PRIVATE_NAME', role: 'senior-dev', skill: '', backend,
    provider: { providerId: backend === 'codex' ? 'codex' : backend === 'claude' ? 'anthropic' : 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-chat', systemPrompt: 'PRIVATE_SYSTEM', autoApprove: true, allowedTools: [], workingDirectory: process.cwd() };
}
class FakeBackend implements AgentBackend {
  readonly agentId = privateId;
  private handler?: BackendEventHandler;
  private alive = false;
  onEvent(handler: BackendEventHandler) { this.handler = handler; return () => { this.handler = undefined; }; }
  async start() { this.alive = true; this.emit({ kind: 'ready', backendSessionId: 'PRIVATE_PROVIDER_SESSION' }); }
  sendUserTurn() {}
  async stop() { this.alive = false; this.emit({ kind: 'exit', code: 0 }); }
  isAlive() { return this.alive; }
  emit(event: BackendEvent) { this.handler?.(event); }
}
const managers: SessionManager[] = [];
afterEach(() => { managers.splice(0).forEach(manager => manager.dispose()); vi.restoreAllMocks(); });
function setup(kind: AgentConfig['backend'] = 'openai-compat', logger = vi.fn<(line: string) => void>()) {
  const bus = new MessageBus();
  const backends: FakeBackend[] = [];
  const launches: string[] = [];
  const manager = new SessionManager(5, bus, { resolveEnv: async () => ({}), logRequestComposition: logger,
    createBackend: (_config, launch) => { const backend = new FakeBackend(); backends.push(backend); launches.push(launch); return backend; } });
  managers.push(manager);
  manager.create(config(kind));
  return { bus, manager, backends, launches, logger,
    send: () => bus.send('user', privateId, 'ask.question', { instruction: 'PRIVATE_INSTRUCTION', mode: 'act' }) };
}
const measurement = projectProviderComposition({ messages: [{ role: 'system', content: 'PRIVATE_SYSTEM' }] }, 123)!;
const submit = projectHostSubmitComposition({ wirePacket: 'PRIVATE_PACKET', texts: [{ text: 'PRIVATE_INPUT' }], imageCount: 0 })!;
const parse = (line: string) => JSON.parse(line.slice(line.indexOf('{')));

describe('private local request diagnostics through the real session fence', () => {
  it('uses the launch UUID/turn/attempt, rejects duplicates and stale launches, and never emits transcript records', async () => {
    const { manager, logger, backends, launches, send, bus } = setup();
    const output: unknown[] = [];
    manager.on('session.output', event => output.push(event));
    await manager.start(privateId, { pin: 'take' });
    // A setup event is not an active user turn.
    backends[0].emit({ kind: 'request_composition', attempt: 1, measurement });
    expect(logger).not.toHaveBeenCalled();
    send();
    backends[0].emit({ kind: 'request_composition', attempt: 1, measurement });
    const first = parse(logger.mock.calls[0][0]);
    expect(first).toMatchObject({ session: launches[0], turn: expect.any(Number), attempt: 1, route: 'openai-compatible' });
    expect(first.turn).toBeGreaterThan(0);
    backends[0].emit({ kind: 'request_composition', attempt: 1, measurement });
    backends[0].emit({ kind: 'request_composition', attempt: 0, measurement });
    expect(logger).toHaveBeenCalledTimes(1);
    backends[0].emit({ kind: 'usage_progress', attempt: 1, inputTokens: 900, outputTokens: 3, cachedInputTokens: 100 });
    expect(parse(logger.mock.calls[1][0])).toEqual({ session: first.session, turn: first.turn, attempt: 1,
      route: 'openai-compatible', usage_scope: 'request', reported_input_tokens: 900, output_tokens: 3, cached_input_tokens: 100 });
    backends[0].emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
    send();
    backends[0].emit({ kind: 'request_composition', attempt: 1, measurement });
    const second = parse(logger.mock.calls[2][0]);
    expect(second.turn).toBeGreaterThan(first.turn);
    await manager.stop(privateId);
    const count = logger.mock.calls.length;
    backends[0].emit({ kind: 'request_composition', attempt: 2, measurement });
    expect(logger).toHaveBeenCalledTimes(count);
    await manager.start(privateId, { pin: 'take' });
    send();
    backends[1].emit({ kind: 'request_composition', attempt: 1, measurement });
    expect(parse(logger.mock.calls.at(-1)![0]).session).toBe(launches[1]);
    expect(launches[1]).not.toBe(launches[0]);
    expect(JSON.stringify(logger.mock.calls)).not.toContain('PRIVATE_');
    expect(JSON.stringify(output)).not.toContain('request-composition');
    expect(JSON.stringify(manager.getAll())).not.toContain('request-composition');
    expect(JSON.stringify(bus.query({}))).not.toContain('request-composition');
  });

  it.each(['claude', 'codex'] as const)('%s keeps turn totals separate, and does not invent usage for a host submit', async kind => {
    const { manager, logger, backends, send } = setup(kind);
    await manager.start(privateId, { pin: 'take' }); send();
    backends[0].emit({ kind: 'request_composition', attempt: 1, measurement: submit });
    expect(parse(logger.mock.calls[0][0])).toMatchObject({ boundary: 'host-turn-submit', internal_requests: 'not-observable', reported_input_tokens: 'not-observable' });
    backends[0].emit({ kind: 'usage_progress', attempt: 1, inputTokens: 999, outputTokens: 1 });
    expect(logger).toHaveBeenCalledTimes(1);
    backends[0].emit({ kind: 'turn_complete', result: { text: 'done', isError: false, usage: { inputTokens: 42, outputTokens: 3, usageBasis: 'reported' } } });
    expect(parse(logger.mock.calls[1][0])).toMatchObject({ turn: parse(logger.mock.calls[0][0]).turn,
      usage_scope: 'turn', attempt: 'not-observable', reported_input_tokens: 42 });
  });

  it('a throwing logger does not prevent a real request, reply, or ordinary usage settlement', async () => {
    const bus = new MessageBus();
    const logger = vi.fn(() => { throw new Error('PRIVATE_LOGGER_ERROR'); });
    const sent: string[] = [];
    const manager = new SessionManager(5, bus, {
      resolveEnv: async () => ({ ROAM_API_KEY: 'PRIVATE_KEY' }), logRequestComposition: logger,
      createBackend: agent => new OpenAICompatBackend(agent, async (_url, init) => {
        sent.push(init.body);
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'safe reply' } }],
          usage: { prompt_tokens: 100, completion_tokens: 5 } }) };
      }),
    });
    managers.push(manager); manager.create(config('openai-compat'));
    await manager.start(privateId, { pin: 'take' });
    const ended = new Promise<void>(resolve => manager.on('session.turnEnded', () => resolve()));
    bus.send('user', privateId, 'ask.question', { instruction: 'hello', mode: 'act' });
    await ended;
    expect(sent).toHaveLength(1);
    expect(logger).toHaveBeenCalledTimes(2);
    expect(manager.get(privateId)).toMatchObject({ status: 'idle', usage: { inputTokens: 100, outputTokens: 5, turns: 1 } });
    expect(bus.query({ type: 'system.error' })).toEqual([]);
  });

  it('does not log reconstructed or partial CLI usage as reported request input', async () => {
    const { manager, logger, backends, send } = setup('claude');
    await manager.start(privateId, { pin: 'take' });
    for (const usageBasis of ['reconstructed', 'reported-partial'] as const) {
      send(); backends[0].emit({ kind: 'request_composition', attempt: 1, measurement: submit });
      backends[0].emit({ kind: 'turn_complete', result: { text: 'done', isError: false, usage: { inputTokens: 42, outputTokens: 3, usageBasis } } });
    }
    expect(logger).toHaveBeenCalledTimes(2);
    expect(logger.mock.calls.every(([line]) => line.startsWith('[request-composition]'))).toBe(true);
  });
});
