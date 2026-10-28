import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager, type SessionEventData, type SessionManagerDeps } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler, ConversationSnapshot } from '../../backend/AgentBackend';
import { CODEX_CLI_DEFAULT_MODEL, CodexBackend } from '../../backend/CodexBackend';
import { type FetchFn, OpenAICompatBackend, readStoredChatMessages } from '../../backend/OpenAICompatBackend';
import type { AgentBackendKind, AgentConfig } from '../../types';

/*
 * v0.9.94, field finding of 2026-10-10: the session manager and the real backends together.
 *
 * An agent keeps its id when its backend kind is changed, and its stored snapshot is kept under that id. The
 * session manager handed whatever was stored to whichever backend started. The snapshot of a Codex backend is a
 * reference to its thread; an OpenAI-compatible backend took it for a chat message, sent it, and wrote it into its
 * own next snapshot. The session now offers a snapshot only to the kind that wrote it and discards one that is
 * not taken, before the backend starts.
 */

const ID = 'senior-dev';
type NotRestored = SessionEventData['session.conversationNotRestored'];

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: ID, name: 'Senior Developer', role: 'senior-dev', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-chat', systemPrompt: 'Be terse.', autoApprove: true, allowedTools: [],
    backend: 'openai-compat', workingDirectory: process.cwd(), ...overrides,
  };
}

/** The same agent on a CLI backend kind, with a provider of that kind. */
function cliAgent(kind: 'codex' | 'claude'): AgentConfig {
  return kind === 'codex'
    ? agent({ provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' }, model: CODEX_CLI_DEFAULT_MODEL, backend: 'codex' })
    : agent({ provider: { providerId: 'claude-cli', apiKeySecretName: 'CLAUDE_CLI_AUTH' }, model: 'opus', backend: 'claude' });
}

function agentOfKind(kind: AgentBackendKind): AgentConfig {
  return kind === 'openai-compat' ? agent() : cliAgent(kind);
}

/** The snapshot a Codex backend with a live thread writes, taken from the real backend. */
function codexSnapshot(): ConversationSnapshot {
  const codex = new CodexBackend(cliAgent('codex'), undefined, {});
  // A thread is taken up again only from a record whose last request the host saw end (v0.9.95).
  codex.restore({ version: 3, backend: 'codex', hostTurnState: 'complete', messages: [{
    codexThreadId: 'thread-7f3a',
    codexUsageBaseline: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 40 },
    codexLastRequest: { inputTokens: 1200, outputTokens: 40 },
    codexContextWindow: { model: CODEX_CLI_DEFAULT_MODEL, tokens: 272000 },
  }] });
  return codex.snapshot()!;
}

/** A backend of a kind that keeps its own snapshot; the test sees what it was offered. */
class KindBackend implements AgentBackend {
  readonly agentId: string;
  pid = 4321;
  offered: ConversationSnapshot[] = [];
  /** The turns this backend was sent. */
  turns: string[] = [];
  /** How often the session stopped it. */
  stopped = 0;
  private handler?: BackendEventHandler;
  constructor(config: AgentConfig, readonly snapshotKind: AgentBackendKind, private readonly takes: boolean) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void { this.handler = h; return () => (this.handler = undefined); }
  async start(): Promise<void> { /* ready is sent by the test */ }
  sendUserTurn(instruction: string): void { this.turns.push(instruction); }
  async stop(): Promise<void> { this.stopped++; this.emit({ kind: 'exit', code: 0 }); }
  abort(): void { /* nothing to end */ }
  isAlive(): boolean { return true; }
  snapshot(): ConversationSnapshot { return { version: 1, backend: this.snapshotKind, messages: [`${this.snapshotKind} state`] }; }
  restore(snapshot: ConversationSnapshot): boolean { this.offered.push(snapshot); return this.takes; }
  emit(e: BackendEvent): void { this.handler?.(e); }
}

/** A backend that keeps no conversation across a start, as the Claude CLI backend does. */
class NoSnapshotBackend implements AgentBackend {
  readonly agentId: string;
  pid = 99;
  private handler?: BackendEventHandler;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void { this.handler = h; return () => (this.handler = undefined); }
  async start(): Promise<void> { /* nothing */ }
  sendUserTurn(): void { /* not driven here */ }
  async stop(): Promise<void> { this.handler?.({ kind: 'exit', code: 0 }); }
  abort(): void { /* nothing to end */ }
  isAlive(): boolean { return true; }
}

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function expectWireMessages(messages: unknown[]): void {
  expect(messages.length).toBeGreaterThan(0);
  for (const message of messages) {
    const entry = message as Record<string, unknown>;
    expect(ROLES.has(entry.role as string), JSON.stringify(Object.keys(entry))).toBe(true);
    expect(typeof entry.content === 'string' || entry.content === null || Array.isArray(entry.content),
      JSON.stringify(Object.keys(entry))).toBe(true);
  }
  expect(JSON.stringify(messages)).not.toContain('codexThreadId');
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function harness(make?: (config: AgentConfig) => AgentBackend | undefined, deps: Partial<SessionManagerDeps> = {}) {
  const bus = new MessageBus();
  const store = new Map<string, ConversationSnapshot>();
  const cleared: string[] = [];
  const requests: Array<{ model: string; messages: unknown[] }> = [];
  const notRestored: NotRestored[] = [];
  const created: AgentBackend[] = [];
  const fetchFn: FetchFn = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: `reply ${requests.length}` } }] }) };
  };
  const manager = new SessionManager(5, bus, {
    createBackend: (config) => {
      const backend = make?.(config) ?? new OpenAICompatBackend(config, fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
      created.push(backend);
      return backend;
    },
    resolveEnv: async () => ({ ROAM_API_KEY: 'sk-test', UNODE_API_KEY: 'sk-un-test', OPENROUTER_API_KEY: 'sk-or-test' }),
    loadSnapshot: (id) => store.get(id),
    saveSnapshot: (id, snapshot) => { store.set(id, structuredClone(snapshot)); },
    clearSnapshot: (id) => { cleared.push(id); store.delete(id); },
    ...deps,
  });
  manager.on('session.conversationNotRestored', (event) => { notRestored.push(event.data); });
  const turn = (instruction: string): Promise<void> => new Promise((resolve) => {
    const ended = (): void => { manager.off('session.turnEnded', ended); resolve(); };
    manager.on('session.turnEnded', ended);
    bus.send('user', ID, 'ask.question', { instruction, mode: 'act' });
  });
  return { bus, store, cleared, requests, notRestored, created, manager, turn };
}

describe('a stored conversation and the backend kind of the agent that starts', () => {
  let manager: SessionManager | undefined;
  afterEach(() => { manager?.dispose(); manager = undefined; });

  it('starts a new conversation for an agent changed from Codex CLI to an OpenAI-compatible connection', async () => {
    const env = harness();
    manager = env.manager;
    env.store.set(ID, codexSnapshot());
    expect(env.store.get(ID)).toMatchObject({ backend: 'codex', messages: [{ codexThreadId: 'thread-7f3a' }] });

    // The same agent id, now on an OpenAI-compatible connection.
    env.manager.create(agent({ provider: { providerId: 'openrouter', apiKeySecretName: 'OPENROUTER_API_KEY' }, model: 'deepseek/deepseek-v4.1-flash' }));
    await env.manager.start(ID, { pin: 'take' });

    // Discarded at the start, before any request, and said once.
    expect(env.store.has(ID)).toBe(false);
    expect(env.notRestored).toEqual([{ reason: 'other-backend', writtenBy: 'codex', startedAs: 'openai-compat' }]);
    expect(env.requests).toEqual([]);

    await env.turn('Reply with the single word OK');

    expect(env.requests).toHaveLength(1);
    expectWireMessages(env.requests[0].messages);
    expect(env.requests[0].messages.map((message) => (message as { role: string }).role)).toEqual(['system', 'user']);
    // What is saved after the turn is this backend's own, and holds chat messages only.
    const saved = env.store.get(ID)!;
    expect(saved.backend).toBe('openai-compat');
    expect(readStoredChatMessages(saved.messages)).toBeDefined();
    expect(JSON.stringify(saved)).not.toContain('codexThreadId');

    // And it is taken at the next start, with nothing said.
    await env.manager.restart(ID);
    await env.turn('And again');
    expect(env.notRestored).toHaveLength(1);
    expect(JSON.stringify(env.requests[1].messages)).toContain('Reply with the single word OK');
    expectWireMessages(env.requests[1].messages);
  });

  it.each([1, 2] as const)('discards a version %i snapshot from before the kind was written that holds a Codex record', async (version) => {
    const env = harness();
    manager = env.manager;
    env.store.set(ID, { version, messages: structuredClone(codexSnapshot().messages) });

    env.manager.create(agent());
    await env.manager.start(ID, { pin: 'take' });

    expect(env.store.has(ID)).toBe(false);
    // No kind was written into it, so the backend decided, and no kind is named.
    expect(env.notRestored).toEqual([{ reason: 'not-a-conversation', startedAs: 'openai-compat' }]);
    await env.turn('Reply with the single word OK');
    expectWireMessages(env.requests[0].messages);
  });

  it('cleans the state the field left behind: the snapshot the OpenAI-compatible backend wrote with the Codex record in it', async () => {
    const env = harness();
    manager = env.manager;
    env.store.set(ID, {
      version: 2,
      messages: [
        { role: 'system', content: 'Be terse.' },
        structuredClone(codexSnapshot().messages[0]),
        { role: 'user', content: 'Reply with the single word OK' },
        { role: 'user', content: 'Reply with the single word OK' },
      ],
    });

    env.manager.create(agent());
    await env.manager.start(ID, { pin: 'take' });
    expect(env.store.has(ID)).toBe(false);
    expect(env.notRestored).toEqual([{ reason: 'not-a-conversation', startedAs: 'openai-compat' }]);

    await env.turn('Reply with the single word OK');
    expectWireMessages(env.requests[0].messages);
    expect(env.requests[0].messages.filter((message) => (message as { role: string }).role === 'user')).toHaveLength(1);
    expect(JSON.stringify(env.store.get(ID))).not.toContain('codexThreadId');

    // A reload after that: the clean snapshot is taken and nothing more is said.
    await env.manager.restart(ID);
    await env.turn('And again');
    expect(env.notRestored).toHaveLength(1);
    expectWireMessages(env.requests[1].messages);
  });

  it('keeps the conversation when only the model changes', async () => {
    const env = harness();
    manager = env.manager;
    env.manager.create(agent({ model: 'deepseek-chat' }));
    await env.manager.start(ID, { pin: 'take' });
    await env.turn('The codeword is heron.');

    // As Agent Builder does: the same config object, edited in place, and the session manager told of the edit.
    env.manager.get(ID)!.config.model = 'kimi-k2.7-code';
    await env.manager.configEdited(ID, { backendKindChanged: false });
    expect(env.created).toHaveLength(2);
    await env.turn('What is the codeword?');

    expect(env.requests[1].model).toBe('kimi-k2.7-code');
    expect(JSON.stringify(env.requests[1].messages)).toContain('The codeword is heron.');
    expect(env.notRestored).toEqual([]);
    expect(env.cleared).toEqual([]);
  });

  it('keeps the conversation when the agent moves to another OpenAI-compatible connection', async () => {
    const env = harness();
    manager = env.manager;
    env.manager.create(agent({ provider: { providerId: 'unode', apiKeySecretName: 'ROAM_API_KEY' }, model: 'deepseek-v4.1-flash' }));
    await env.manager.start(ID, { pin: 'take' });
    await env.turn('The codeword is heron.');

    const config = env.manager.get(ID)!.config;
    config.provider = { providerId: 'openrouter', apiKeySecretName: 'OPENROUTER_API_KEY' };
    config.model = 'deepseek/deepseek-v4.1-flash';
    config.baseUrl = 'https://openrouter.ai/api/v1';
    await env.manager.restart(ID);
    await env.turn('What is the codeword?');

    expect(env.requests[1].model).toBe('deepseek/deepseek-v4.1-flash');
    expect(JSON.stringify(env.requests[1].messages)).toContain('The codeword is heron.');
    expectWireMessages(env.requests[1].messages);
    expect(env.notRestored).toEqual([]);
    expect(env.cleared).toEqual([]);
  });

  it('never shows a backend a snapshot that another kind signed', async () => {
    for (const [stored, startedAs] of [
      [{ version: 2, backend: 'openai-compat', messages: [{ role: 'user', content: 'hello' }] }, 'codex'],
      [codexSnapshot(), 'openai-compat'],
    ] as Array<[ConversationSnapshot, AgentBackendKind]>) {
      let backend!: KindBackend;
      const env = harness((config) => (backend = new KindBackend(config, startedAs, true)));
      env.store.set(ID, stored);
      env.manager.create(agentOfKind(startedAs));
      await env.manager.start(ID, { pin: 'take' });

      expect(backend.offered).toEqual([]);
      expect(env.store.has(ID)).toBe(false);
      expect(env.notRestored).toEqual([{ reason: 'other-backend', writtenBy: stored.backend, startedAs }]);
      env.manager.dispose();
    }
  });

  it('offers a backend the snapshot its own kind signed, and one from before the kind was written', async () => {
    for (const stored of [
      { version: 1, backend: 'codex', messages: [{ codexThreadId: 'thread-7f3a' }] },
      { version: 1, messages: [{ codexThreadId: 'thread-7f3a' }] },
    ] as ConversationSnapshot[]) {
      let backend!: KindBackend;
      const env = harness((config) => (backend = new KindBackend(config, 'codex', true)));
      env.store.set(ID, stored);
      env.manager.create(cliAgent('codex'));
      await env.manager.start(ID, { pin: 'take' });

      expect(backend.offered).toEqual([stored]);
      expect(env.store.get(ID)).toEqual(stored);
      expect(env.notRestored).toEqual([]);
      expect(env.cleared).toEqual([]);
      env.manager.dispose();
    }
  });

  it('discards a snapshot the backend refuses, and one stored for an agent whose backend keeps none', async () => {
    let refusing!: KindBackend;
    const first = harness((config) => (refusing = new KindBackend(config, 'codex', false)));
    first.store.set(ID, { version: 2, messages: [{ role: 'user', content: 'hello' }] });
    first.manager.create(cliAgent('codex'));
    await first.manager.start(ID, { pin: 'take' });
    expect(refusing.offered).toHaveLength(1);
    expect(first.store.has(ID)).toBe(false);
    expect(first.notRestored).toEqual([{ reason: 'not-a-conversation', startedAs: 'codex' }]);
    first.manager.dispose();

    // Changed to Claude CLI, whose backend keeps no snapshot: what is stored is another kind's, and is not kept
    // to come back when the agent is changed again.
    const second = harness((config) => new NoSnapshotBackend(config));
    second.store.set(ID, { version: 2, backend: 'openai-compat', messages: [{ role: 'user', content: 'hello' }] });
    second.manager.create(cliAgent('claude'));
    await second.manager.start(ID, { pin: 'take' });
    expect(second.store.has(ID)).toBe(false);
    expect(second.notRestored).toEqual([{ reason: 'other-backend', writtenBy: 'openai-compat' }]);
    second.manager.dispose();
  });

  it('does not give a stopped Codex agent its thread back after it was changed to another kind and back before any start', async () => {
    // Codex's audit of 2026-10-10. The start of an agent sees the stored snapshot and the kind the agent has by
    // then. After this round trip both say Codex, and Agent Builder has said twice that the model starts a new
    // conversation. So the save that changes the kind discards what is stored.
    let started: KindBackend | undefined;
    const env = harness((config) => (started = new KindBackend(config, 'codex', true)));
    manager = env.manager;
    env.store.set(ID, codexSnapshot());
    env.manager.create(cliAgent('codex'));
    expect(env.manager.get(ID)!.status).toBe('stopped');

    // To an OpenAI-compatible connection, saved. A stopped agent is not restarted.
    env.manager.get(ID)!.config.backend = 'openai-compat';
    await env.manager.configEdited(ID, { backendKindChanged: true });
    expect(env.store.has(ID)).toBe(false);
    expect(env.created).toEqual([]);

    // And back to Codex CLI, saved, still before any start.
    env.manager.get(ID)!.config.backend = 'codex';
    await env.manager.configEdited(ID, { backendKindChanged: true });
    expect(env.created).toEqual([]);

    await env.manager.start(ID, { pin: 'take' });
    expect(started!.offered).toEqual([]);
    // Nothing was stored by then, so the start has nothing to say; the two saves said it.
    expect(env.notRestored).toEqual([]);
  });

  it('does not give a stopped OpenAI-compatible agent its conversation back after the same round trip', async () => {
    const env = harness();
    manager = env.manager;
    env.manager.create(agent());
    await env.manager.start(ID, { pin: 'take' });
    await env.turn('The codeword is heron.');
    await env.manager.stop(ID);
    expect(env.manager.get(ID)!.status).toBe('stopped');
    expect(JSON.stringify(env.store.get(ID))).toContain('heron');

    env.manager.get(ID)!.config.backend = 'codex';
    await env.manager.configEdited(ID, { backendKindChanged: true });
    expect(env.store.has(ID)).toBe(false);
    env.manager.get(ID)!.config.backend = 'openai-compat';
    await env.manager.configEdited(ID, { backendKindChanged: true });
    expect(env.created).toHaveLength(1);

    await env.manager.start(ID, { pin: 'take' });
    await env.turn('What is the codeword?');
    expect(JSON.stringify(env.requests[1].messages)).not.toContain('heron');
    expect(env.requests[1].messages.map((message) => (message as { role: string }).role)).toEqual(['system', 'user']);
    expect(env.notRestored).toEqual([]);
  });

  it('restarts a live agent on its new kind with nothing stored, in that order', async () => {
    let onCodex: KindBackend | undefined;
    const env = harness((config) => (config.backend === 'codex' ? (onCodex = new KindBackend(config, 'codex', true)) : undefined));
    manager = env.manager;
    env.manager.create(agent());
    await env.manager.start(ID, { pin: 'take' });
    await env.turn('The codeword is heron.');
    expect(env.manager.get(ID)!.status).toBe('idle');
    expect(env.store.has(ID)).toBe(true);

    // What the store holds at the moment the new backend is made: the earlier one is detached and the stored
    // conversation discarded before that.
    let storedAtCreation: boolean | undefined;
    const create = env.created.push.bind(env.created);
    env.created.push = (...backends) => { storedAtCreation = env.store.has(ID); return create(...backends); };

    Object.assign(env.manager.get(ID)!.config, cliAgent('codex'), { route: undefined, baseUrl: undefined });
    await env.manager.configEdited(ID, { backendKindChanged: true });

    expect(env.created).toHaveLength(2);
    expect(storedAtCreation).toBe(false);
    expect(onCodex!.offered).toEqual([]);
    expect(env.store.has(ID)).toBe(false);
    expect(env.notRestored).toEqual([]);
    expect(env.manager.get(ID)!.restartCount).toBe(1);
  });

  it('stops a backend whose start was under way when the kind was changed, and starts the agent on the new kind', async () => {
    // The backend had been made and was still starting. An edit does not restart a starting agent, except when
    // it changes the backend kind: that backend is of the kind the agent was changed away from.
    const releases: Array<() => void> = [];
    class SlowStart extends KindBackend {
      start(): Promise<void> { return new Promise((resolve) => { releases.push(resolve); }); }
    }
    const made: KindBackend[] = [];
    const env = harness((config) => {
      const backend = config.backend === 'codex' ? new SlowStart(config, 'codex', true) : new KindBackend(config, 'openai-compat', true);
      made.push(backend);
      return backend;
    });
    manager = env.manager;
    env.manager.create(cliAgent('codex'));
    const first = env.manager.start(ID, { pin: 'take' });
    await tick();
    expect(env.manager.get(ID)!.status).toBe('starting');
    expect(made).toHaveLength(1);

    Object.assign(env.manager.get(ID)!.config, agent(), { route: undefined });
    await env.manager.configEdited(ID, { backendKindChanged: true });
    expect(made).toHaveLength(2);
    expect(made[0].stopped).toBe(1);
    expect(made[1].snapshotKind).toBe('openai-compat');

    // The earlier backend finishes starting and reports a turn. It is no longer the agent's: nothing is saved.
    releases.shift()!();
    await first;
    made[0].emit({ kind: 'ready' });
    made[0].emit({ kind: 'turn_complete', result: { text: 'late', isError: false } });
    expect(env.store.has(ID)).toBe(false);

    // Work goes to the backend of the new kind, and its turns are saved as its own.
    made[1].emit({ kind: 'ready' });
    env.bus.send('user', ID, 'ask.question', { instruction: 'go', mode: 'act' });
    expect(made[1].turns).toHaveLength(1);
    expect(made[0].turns).toEqual([]);
    made[1].emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
    expect(env.store.get(ID)).toEqual({ version: 1, backend: 'openai-compat', messages: ['openai-compat state'], hostTurnState: 'complete' });
  });

  it('makes no backend of the earlier kind when the kind is changed while a start waits, and starts the agent on the new kind', async () => {
    // Codex's audits of 2026-10-10. A start can wait a long time before it makes its backend: for a worktree,
    // or for a managed integration that waits for a person. It took its configuration before the wait. When the
    // kind is changed meanwhile, what it would make is a backend of the kind the agent was changed away from,
    // and the agent would go on answering on that provider.
    const holds: Array<() => void> = [];
    let prepared = 0;
    const made: KindBackend[] = [];
    const env = harness((config) => {
      const backend = new KindBackend(config, config.backend === 'codex' ? 'codex' : 'openai-compat', true);
      made.push(backend);
      return backend;
    }, {
      // The first start waits here; the start that follows the edit goes through.
      prepareBackendStart: () => (prepared++ === 0 ? new Promise<void>((resolve) => { holds.push(resolve); }) : Promise.resolve()),
    });
    manager = env.manager;
    env.store.set(ID, codexSnapshot());
    env.manager.create(cliAgent('codex'));
    const first = env.manager.start(ID, { pin: 'take' });
    await tick();
    expect(env.manager.get(ID)!.status).toBe('starting');
    expect(made).toEqual([]);

    // Changed to an OpenAI-compatible connection while that start waits.
    Object.assign(env.manager.get(ID)!.config, agent(), { route: undefined });
    await env.manager.configEdited(ID, { backendKindChanged: true });
    // The agent was started again on the new kind, with nothing stored and nothing offered.
    expect(made).toHaveLength(1);
    expect(made[0].snapshotKind).toBe('openai-compat');
    expect(made[0].offered).toEqual([]);
    expect(env.store.has(ID)).toBe(false);
    expect(env.notRestored).toEqual([]);

    // The first start comes back from its wait. It makes nothing and changes nothing.
    holds.shift()!();
    await first;
    expect(made).toHaveLength(1);
    expect(env.manager.get(ID)!.status).not.toBe('error');

    // Work goes to the backend of the new kind.
    made[0].emit({ kind: 'ready' });
    env.bus.send('user', ID, 'ask.question', { instruction: 'go', mode: 'act' });
    expect(made[0].turns).toHaveLength(1);
    made[0].emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
    expect(env.store.get(ID)).toEqual({ version: 1, backend: 'openai-compat', messages: ['openai-compat state'], hostTurnState: 'complete' });
  });

  it('makes one backend when an agent is stopped and started again while its first start waits', async () => {
    // The same rule without an edit: a start that a Stop ended does not come back to life because a later start
    // has made the agent `starting` again.
    const holds: Array<() => void> = [];
    const made: KindBackend[] = [];
    const env = harness((config) => {
      const backend = new KindBackend(config, 'codex', true);
      made.push(backend);
      return backend;
    }, {
      prepareBackendStart: () => new Promise<void>((resolve) => { holds.push(resolve); }),
    });
    manager = env.manager;
    env.manager.create(cliAgent('codex'));
    const first = env.manager.start(ID, { pin: 'take' });
    await tick();
    await env.manager.stop(ID);
    const second = env.manager.start(ID, { pin: 'take' });
    await tick();
    expect(holds).toHaveLength(2);

    // The first start comes back first, while the second is still waiting.
    holds[0]();
    await first;
    expect(made).toEqual([]);
    holds[1]();
    await second;
    expect(made).toHaveLength(1);
  });

  it('leaves the agent as its later start left it when an overtaken start fails afterwards', async () => {
    const holds: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
    const made: KindBackend[] = [];
    const errors: string[] = [];
    const env = harness((config) => {
      const backend = new KindBackend(config, 'codex', true);
      made.push(backend);
      return backend;
    }, {
      prepareBackendStart: () => new Promise<void>((resolve, reject) => { holds.push({ resolve, reject }); }),
    });
    manager = env.manager;
    env.manager.on('session.error', (event) => { errors.push(String(event.data?.error)); });
    env.manager.create(cliAgent('codex'));
    const first = env.manager.start(ID, { pin: 'take' });
    await tick();
    await env.manager.stop(ID);
    const second = env.manager.start(ID, { pin: 'take' });
    await tick();
    holds[1].resolve();
    await second;
    expect(made).toHaveLength(1);

    // The integration the first start waited for fails now. That start is no longer the agent's.
    holds[0].reject(new Error('integration not ready'));
    await first;
    expect(errors).toEqual([]);
    expect(env.manager.get(ID)!.status).not.toBe('error');
    expect(made).toHaveLength(1);
  });

  it('does not return from the edit, and does not read for a start, while the clear of the store is still under way', async () => {
    // A store's clear returns before it is done. Until it is done the old snapshot can still be read.
    const clears: Array<() => void> = [];
    let started: KindBackend | undefined;
    const env = harness((config) => (started = new KindBackend(config, 'codex', true)), {
      clearSnapshot: (id) => new Promise<void>((resolve) => { clears.push(() => { env.store.delete(id); resolve(); }); }),
    });
    manager = env.manager;
    env.store.set(ID, codexSnapshot());
    env.manager.create(cliAgent('codex'));

    let edited = false;
    const edit = env.manager.configEdited(ID, { backendKindChanged: true }).then(() => { edited = true; });
    await tick();
    expect(clears).toHaveLength(1);
    expect(edited).toBe(false);
    expect(env.store.has(ID)).toBe(true);

    // A start in this moment waits for the clear, and makes no backend before it.
    const starting = env.manager.start(ID, { pin: 'take' });
    await tick();
    expect(env.created).toEqual([]);

    clears.shift()!();
    await edit;
    await starting;
    expect(env.store.has(ID)).toBe(false);
    expect(started!.offered).toEqual([]);
    expect(env.notRestored).toEqual([]);
  });

  it('writes the clear after a save that was in flight when the kind changed, and waits for both', async () => {
    const saves: Array<() => void> = [];
    const written: string[] = [];
    let onCodex: KindBackend | undefined;
    let first: KindBackend | undefined;
    const env = harness((config) => (config.backend === 'codex'
      ? (onCodex = new KindBackend(config, 'codex', true))
      : (first = new KindBackend(config, 'openai-compat', true))), {
      saveSnapshot: (id, snapshot) => new Promise<void>((resolve) => {
        saves.push(() => { written.push('save'); env.store.set(id, snapshot); resolve(); });
      }),
      clearSnapshot: (id) => { written.push('clear'); env.store.delete(id); },
    });
    manager = env.manager;
    env.manager.create(agent());
    await env.manager.start(ID, { pin: 'take' });
    first!.emit({ kind: 'ready' });
    env.bus.send('user', ID, 'ask.question', { instruction: 'go', mode: 'act' });
    first!.emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
    // The record written when the request was handed over has been issued and has not landed. The save of the
    // finished turn waits behind it (v0.9.95: a turn is stored when it is handed over and again when it ends).
    expect(saves).toHaveLength(1);
    expect(env.store.has(ID)).toBe(false);

    Object.assign(env.manager.get(ID)!.config, cliAgent('codex'), { route: undefined, baseUrl: undefined });
    let edited = false;
    const edit = env.manager.configEdited(ID, { backendKindChanged: true }).then(() => { edited = true; });
    await tick();
    // The clear waits behind the save; nothing is started on the new kind meanwhile.
    expect(written).toEqual([]);
    expect(edited).toBe(false);
    expect(env.created).toHaveLength(1);

    saves.shift()!();
    await tick();
    // The turn's own save goes out only now, and the clear still waits behind it.
    expect(written).toEqual(['save']);
    expect(edited).toBe(false);
    saves.shift()!();
    await edit;
    expect(written).toEqual(['save', 'save', 'clear']);
    expect(env.store.has(ID)).toBe(false);
    expect(env.created).toHaveLength(2);
    expect(onCodex!.offered).toEqual([]);
  });

  it('starts nothing when the store cannot be cleared, and reads nothing for that agent until it is', async () => {
    let failing = true;
    let started: KindBackend | undefined;
    const env = harness((config) => (started = new KindBackend(config, 'codex', true)), {
      clearSnapshot: (id) => (failing ? Promise.reject(new Error('disk full')) : void env.store.delete(id)),
    });
    manager = env.manager;
    env.store.set(ID, codexSnapshot());
    env.manager.create(cliAgent('codex'));

    await expect(env.manager.configEdited(ID, { backendKindChanged: true })).rejects.toThrow(
      'The saved model conversation of Senior Developer could not be discarded (disk full). The agent was not started; start it to try again.',
    );
    expect(env.created).toEqual([]);
    // The old snapshot is still in the store, and it is of the kind the agent has. It must not come back.
    expect(env.store.has(ID)).toBe(true);

    // Started while the store still cannot be cleared: the clear is tried again and fails again, the snapshot is
    // still there, and the backend is offered nothing all the same.
    await env.manager.start(ID, { pin: 'take' });
    expect(env.created).toHaveLength(1);
    expect(started!.offered).toEqual([]);
    await tick();
    expect(env.store.has(ID)).toBe(true);

    // Started when the store can be cleared: it is, before anything is read.
    failing = false;
    await env.manager.restart(ID);
    expect(started!.offered).toEqual([]);
    await tick();
    expect(env.store.has(ID)).toBe(false);

    // Once the store is clear the agent keeps a conversation again, and gets it back at its next start.
    started!.emit({ kind: 'ready' });
    env.bus.send('user', ID, 'ask.question', { instruction: 'go', mode: 'act' });
    started!.emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
    const saved = env.store.get(ID);
    expect(saved).toEqual({ version: 1, backend: 'codex', messages: ['codex state'], hostTurnState: 'complete' });
    await env.manager.restart(ID);
    expect(started!.offered).toEqual([saved]);
  });

  it('says nothing when no snapshot is stored', async () => {
    const env = harness();
    manager = env.manager;
    env.manager.create(agent());
    await env.manager.start(ID, { pin: 'take' });
    expect(env.notRestored).toEqual([]);
    expect(env.cleared).toEqual([]);
  });

  it('is told to the person in the agent\'s chat, and in the log without any content', () => {
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    expect(source).toContain("sessionManager.on('session.conversationNotRestored', (e) => {");
    expect(source).toContain('const notice = conversationNotRestoredNotice(e.data);');
    expect(source).toContain('if (notice) chatViewProvider?.postRuntimeNotice(e.sessionId, notice);');
    expect(source).toContain('outputChannel.info(`Stored conversation of ${e.sessionId} not restored (${conversationNotRestoredLogLine(e.data)}).`);');
  });
});
