import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { REQUEST_NOT_RECORDED_STOP, SessionManager, type SessionEventData, type SessionManagerDeps } from '../SessionManager';
import { conversationNotRestoredLogLine, conversationNotRestoredNotice } from '../ConversationNotRestored';
import { MessageBus } from '../../bus/MessageBus';
import type {
  AgentBackend, BackendEvent, BackendEventHandler, ConversationRestoreReport, ConversationSnapshot,
} from '../../backend/AgentBackend';
import { CODEX_CLI_DEFAULT_MODEL, CodexBackend } from '../../backend/CodexBackend';
import { type FetchFn, OpenAICompatBackend } from '../../backend/OpenAICompatBackend';
import { bundledSmartCompactionPolicy } from '../../compaction/BundledSmartCompactionPolicy';
import { resolveSmartCompactionPolicy } from '../../compaction/SmartCompactionPolicy';
import { RunLedger } from '../../observability/RunLedger';
import type { AgentBackendKind, AgentConfig, Message } from '../../types';

/*
 * v0.9.95, field finding of 2026-10-10: the session manager and the real backends together.
 *
 * A Reviewer was given a review and carried out an older task beside it. Its request held that older task, then
 * the note `[Session restored from a previous session.]`, then the review. The older task had never been
 * answered. Its turn had ended in a failure, the snapshot of that turn was the stored record, and a restore put
 * the whole record back as the conversation.
 *
 * The session now stores, with every record, whether it saw the agent's last request end, and a backend
 * continues only what was answered. These tests run one window after another over the same store, as a reload
 * does.
 */

const ID = 'reviewer';
const OLD_TASK = 'Task card t-7 for Reviewer. Read notes/codeword.txt and report the code word it holds.';
const NEW_TASK = 'Review src/app.ts for an off-by-one error.';
const NOTE_MARK = '[Session restored from a previous session.]';
const INTERRUPTED = 'Your earlier request was interrupted and was not resumed. Send it again if you still want it.';
// A request that ended without an answer while its host lived, or in a record from before the marker.
const UNANSWERED = 'Your earlier request ended without an answer and was not resumed. Send it again if you still want it.';
const LEGACY = 'This conversation was saved by an earlier version of UnodeAi, which did not record whether its last request '
  + 'had finished. The agent starts a new conversation; the messages above stay as history.';

type Notice = SessionEventData['session.conversationNotRestored'];
type Wire = { role: string; content: unknown };
type Reply = { status: number; body: unknown } | 'hang';

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: ID, name: 'Reviewer', role: 'reviewer', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-chat', systemPrompt: 'Be terse.', autoApprove: true, allowedTools: [],
    backend: 'openai-compat', workingDirectory: process.cwd(), ...overrides,
  };
}

function codexAgent(): AgentConfig {
  return agent({ provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' }, model: CODEX_CLI_DEFAULT_MODEL, backend: 'codex' });
}

const answered = (text: string): Reply => ({ status: 200, body: { choices: [{ message: { role: 'assistant', content: text } }] } });
const unavailable: Reply = { status: 503, body: { error: { message: 'model_not_found' } } };
const userTexts = (messages: Wire[]): unknown[] => messages.filter((message) => message.role === 'user').map((message) => message.content);
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
async function until(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !done(); turn++) await tick();
  expect(done()).toBe(true);
}

/** One window: a session manager over a store that outlives it, as the workspace state outlives a reload. */
function openWindow(
  store: Map<string, ConversationSnapshot>,
  options: {
    respond?: (index: number) => Reply;
    make?: (config: AgentConfig) => AgentBackend | undefined;
    deps?: Partial<SessionManagerDeps>;
  } = {},
) {
  const bus = new MessageBus();
  const requests: Array<{ messages: Wire[] }> = [];
  const notices: Notice[] = [];
  const sent: Message[] = [];
  const saved: ConversationSnapshot[] = [];
  const fetchFn: FetchFn = (_url, init) => {
    const index = requests.length;
    requests.push(JSON.parse(init.body));
    const reply = options.respond?.(index) ?? answered(`reply ${index + 1}`);
    if (reply === 'hang') {
      // The provider never answers. Only the turn being ended ends the request.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('request aborted')));
      });
    }
    return Promise.resolve({ ok: reply.status === 200, status: reply.status, text: async () => JSON.stringify(reply.body) });
  };
  const manager = new SessionManager(5, bus, {
    createBackend: (config) => options.make?.(config)
      ?? new OpenAICompatBackend(config, fetchFn, undefined, undefined, undefined, { retryBaseMs: 0, maxRetries: 0 }),
    resolveEnv: async () => ({ ROAM_API_KEY: 'sk-test' }),
    loadSnapshot: (id) => store.get(id),
    saveSnapshot: (id, snapshot) => { saved.push(structuredClone(snapshot)); store.set(id, structuredClone(snapshot)); },
    clearSnapshot: (id) => { store.delete(id); },
    ...options.deps,
  });
  manager.on('session.conversationNotRestored', (event) => { notices.push(event.data); });
  bus.subscribe({}, (message) => { sent.push(message); });
  const turn = (instruction: string): Promise<void> => new Promise((resolve) => {
    const ended = (): void => { manager.off('session.turnEnded', ended); resolve(); };
    manager.on('session.turnEnded', ended);
    bus.send('user', ID, 'ask.question', { instruction, mode: 'act' });
  });
  /** The window reloads: the extension is told to deactivate, as VS Code does. */
  const reload = async (): Promise<void> => {
    manager.hostExiting();
    await manager.stopAll();
    manager.dispose();
  };
  return { bus, manager, requests, notices, sent, saved, turn, reload };
}

/** A backend of a kind that keeps a conversation; the test sees the store as it stands when a request arrives. */
class ProbeBackend implements AgentBackend {
  readonly agentId: string;
  pid = 4321;
  kept: ConversationSnapshot | undefined;
  offered: ConversationSnapshot[] = [];
  turns: Array<{ instruction: string; storedMarker: unknown }> = [];
  /** Whether it takes a snapshot it is offered, and what it then says it left out. */
  takes = true;
  leftOut: ConversationRestoreReport | undefined;
  alive = true;
  private handler?: BackendEventHandler;
  constructor(config: AgentConfig, readonly snapshotKind: AgentBackendKind, private readonly stored: () => ConversationSnapshot | undefined) {
    this.agentId = config.id;
  }
  onEvent(handler: BackendEventHandler): () => void { this.handler = handler; return () => (this.handler = undefined); }
  async start(): Promise<void> { /* ready is sent by the test */ }
  sendUserTurn(instruction: string): void { this.turns.push({ instruction, storedMarker: this.stored()?.hostTurnState }); }
  async stop(): Promise<void> { /* nothing to end */ }
  abort(): void { /* nothing to end */ }
  isAlive(): boolean { return this.alive; }
  snapshot(): ConversationSnapshot | undefined { return this.kept; }
  restore(snapshot: ConversationSnapshot): boolean { this.offered.push(snapshot); return this.takes; }
  takeRestoreReport(): ConversationRestoreReport | undefined { const report = this.leftOut; this.leftOut = undefined; return report; }
  emit(event: BackendEvent): void { this.handler?.(event); }
}

/** The real Codex backend without its App Server: what it does with a stored record is all these tests need. */
class CodexWithoutProcess extends CodexBackend {
  override async start(): Promise<void> { /* no process */ }
}

describe('a restored conversation and the request that follows it', () => {
  let manager: SessionManager | undefined;
  afterEach(() => { manager?.dispose(); manager = undefined; });

  it('does not send an earlier unanswered task with the first request after a reload', async () => {
    const store = new Map<string, ConversationSnapshot>();
    // The first window: the Reviewer is given a task and the provider answers nothing but a failure.
    const first = openWindow(store, { respond: () => unavailable });
    manager = first.manager;
    first.manager.create(agent());
    await first.manager.start(ID, { pin: 'take' });
    await first.turn(OLD_TASK);
    await first.reload();

    // The stored record holds the task, behind the boundary: the turn ended, and nothing answered it.
    const stored = store.get(ID)!;
    expect(stored).toMatchObject({ version: 3, backend: 'openai-compat', hostTurnState: 'complete', completedMessageCount: 1 });
    expect(stored.messages.map((message) => (message as Wire).role)).toEqual(['system', 'user']);
    expect((stored.messages[1] as Wire).content).toBe(OLD_TASK);

    // The window is reloaded, and the Reviewer is given another task.
    const second = openWindow(store, { respond: () => answered('No off-by-one error found.') });
    manager = second.manager;
    second.manager.create(agent());
    await second.manager.start(ID, { pin: 'take' });
    expect(second.notices).toEqual([{
      reason: 'request-unanswered', startedAs: 'openai-compat',
      restoredMessages: 1, quarantinedMessages: 1, reasonCodes: ['unfinished-tail'],
    }]);
    await second.turn(NEW_TASK);

    // One request, and the new task is the only instruction in it: the request the field report describes held
    // the older task and the staleness note before it.
    expect(second.requests).toHaveLength(1);
    expect(userTexts(second.requests[0].messages)).toEqual([NEW_TASK]);
    expect(JSON.stringify(second.requests)).not.toContain('codeword');
    expect(second.requests[0].messages.filter((message) => message.role === 'user' && String(message.content).includes(NOTE_MARK))).toEqual([]);
    // It was carried out once: one terminal reply to the person, and it is the new task's.
    const replies = second.sent.filter((message) => message.from === ID && message.to === 'user' && message.type === 'task.complete');
    expect(replies.map((message) => message.payload.instruction)).toEqual(['No off-by-one error found.']);

    // What is stored now: the new exchange as the conversation, and the older task beside it as evidence.
    const after = store.get(ID)!;
    expect(after).toMatchObject({ version: 3, hostTurnState: 'complete', completedMessageCount: 3 });
    expect(userTexts(after.messages as Wire[])).toEqual([NEW_TASK]);
    expect(after.quarantined).toMatchObject({ reasons: ['unfinished-tail'], messageCount: 1, messages: [{ role: 'user', content: OLD_TASK }] });
  });

  it('migrates the record v0.9.94 left in the field, and keeps the answered exchanges before the task as context', async () => {
    // As v0.9.94 stored it: version 2, no marker, no boundary, the unanswered task at its end.
    const store = new Map<string, ConversationSnapshot>([[ID, {
      version: 2, backend: 'openai-compat',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'The code word is heron.' },
        { role: 'assistant', content: 'Noted: heron.' },
        { role: 'user', content: OLD_TASK },
      ],
      usageBaseline: { routes: [] },
    }]]);
    const window = openWindow(store, { respond: () => answered('No off-by-one error found.') });
    manager = window.manager;
    window.manager.create(agent());
    await window.manager.start(ID, { pin: 'take' });

    expect(window.notices).toEqual([{
      reason: 'request-unanswered', startedAs: 'openai-compat',
      restoredMessages: 3, quarantinedMessages: 1, reasonCodes: ['legacy-unfinished-tail'],
    }]);
    // The record is rewritten at the start, before any request: version 3, and nothing left to say about it.
    expect(store.get(ID)).toMatchObject({ version: 3, hostTurnState: 'complete', completedMessageCount: 3 });
    expect(JSON.stringify(store.get(ID)!.messages)).not.toContain('codeword.txt');
    expect(window.requests).toEqual([]);

    await window.turn(NEW_TASK);
    expect(window.requests).toHaveLength(1);
    expect(userTexts(window.requests[0].messages)).toEqual(['The code word is heron.', NEW_TASK]);
    expect(JSON.stringify(window.requests[0].messages)).toContain('Noted: heron.');
    expect(JSON.stringify(window.requests)).not.toContain('codeword.txt');
    // The staleness note goes with that request as host context, after the new task.
    expect(window.requests[0].messages.at(-1)).toMatchObject({ role: 'system' });
    expect(String(window.requests[0].messages.at(-1)!.content).startsWith(NOTE_MARK)).toBe(true);
    expect(JSON.stringify(store.get(ID))).not.toContain(NOTE_MARK);
  });

  it('says once that a request was left out, however often the agent is started after that', async () => {
    const store = new Map<string, ConversationSnapshot>();
    const first = openWindow(store, { respond: () => unavailable });
    manager = first.manager;
    first.manager.create(agent());
    await first.manager.start(ID, { pin: 'take' });
    await first.turn(OLD_TASK);
    await first.reload();

    const seen: Notice[] = [];
    // Three starts with nothing sent between them, in three windows; then a turn, and two more starts.
    for (let start = 0; start < 3; start++) {
      const window = openWindow(store);
      manager = window.manager;
      window.manager.create(agent());
      await window.manager.start(ID, { pin: 'take' });
      seen.push(...window.notices);
      await window.reload();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].reason).toBe('request-unanswered');

    const last = openWindow(store, { respond: () => answered('No off-by-one error found.') });
    manager = last.manager;
    last.manager.create(agent());
    await last.manager.start(ID, { pin: 'take' });
    await last.turn(NEW_TASK);
    await last.manager.restart(ID);
    await last.manager.restart(ID);
    expect(last.notices).toEqual([]);
    expect(userTexts(last.requests[0].messages)).toEqual([NEW_TASK]);
  });

  it('tells the person in the words of the notice, and the log in counts and reason codes only', async () => {
    const store = new Map<string, ConversationSnapshot>([[ID, {
      version: 2, messages: [{ role: 'system', content: 'Be terse.' }, { role: 'user', content: OLD_TASK }],
    }]]);
    const window = openWindow(store);
    manager = window.manager;
    window.manager.create(agent());
    await window.manager.start(ID, { pin: 'take' });

    expect(window.notices).toHaveLength(1);
    expect(conversationNotRestoredNotice(window.notices[0])).toBe(UNANSWERED);
    const line = conversationNotRestoredLogLine(window.notices[0]);
    expect(line).toBe('reason=request-unanswered startedAs=openai-compat restoredMessages=1 quarantinedMessages=1 codes=legacy-unfinished-tail');
    expect(JSON.stringify(window.notices)).not.toContain('codeword');
  });
});

describe('the record of a request that is with a backend', () => {
  let manager: SessionManager | undefined;
  afterEach(() => { manager?.dispose(); manager = undefined; });

  it('is stored as unfinished before the backend is handed the request, and as finished once the turn has ended', async () => {
    const store = new Map<string, ConversationSnapshot>();
    let backend!: ProbeBackend;
    const window = openWindow(store, { make: (config) => (backend = new ProbeBackend(config, 'openai-compat', () => store.get(ID))) });
    manager = window.manager;
    window.manager.create(agent());
    await window.manager.start(ID, { pin: 'take' });
    backend.kept = { version: 3, backend: 'openai-compat', messages: ['before the turn'], completedMessageCount: 1 };
    backend.emit({ kind: 'ready' });
    expect(store.has(ID)).toBe(false);

    window.bus.send('user', ID, 'ask.question', { instruction: NEW_TASK, mode: 'act' });
    // When the request reached the backend the store already said that one was with it.
    expect(backend.turns).toEqual([{ instruction: NEW_TASK, storedMarker: 'incomplete' }]);
    expect(store.get(ID)).toEqual({ version: 3, backend: 'openai-compat', messages: ['before the turn'], completedMessageCount: 1, hostTurnState: 'incomplete' });

    backend.kept = { version: 3, backend: 'openai-compat', messages: ['after the turn'], completedMessageCount: 1 };
    backend.emit({ kind: 'turn_complete', result: { text: 'done', isError: false, responseOutcome: { kind: 'reply' } } });
    expect(store.get(ID)).toEqual({ version: 3, backend: 'openai-compat', messages: ['after the turn'], completedMessageCount: 1, hostTurnState: 'complete' });
    expect(window.saved.map((snapshot) => snapshot.hostTurnState)).toEqual(['incomplete', 'complete']);
  });

  it('does not hand the request over while the store is still writing that record', async () => {
    const store = new Map<string, ConversationSnapshot>();
    const writes: Array<() => void> = [];
    let backend!: ProbeBackend;
    const window = openWindow(store, {
      make: (config) => (backend = new ProbeBackend(config, 'openai-compat', () => store.get(ID))),
      deps: {
        saveSnapshot: (id, snapshot) => new Promise<void>((resolve) => {
          writes.push(() => { store.set(id, structuredClone(snapshot)); resolve(); });
        }),
      },
    });
    manager = window.manager;
    window.manager.create(agent());
    await window.manager.start(ID, { pin: 'take' });
    backend.emit({ kind: 'ready' });

    window.bus.send('user', ID, 'ask.question', { instruction: NEW_TASK, mode: 'act' });
    await tick();
    // The write has been issued and has not landed: the backend has nothing yet.
    expect(writes).toHaveLength(1);
    expect(backend.turns).toEqual([]);
    expect(window.manager.get(ID)!.status).toBe('running');

    writes.shift()!();
    await tick();
    expect(backend.turns).toEqual([{ instruction: NEW_TASK, storedMarker: 'incomplete' }]);
  });

  it('hands nothing over when a Stop arrives while that record is being written', async () => {
    const store = new Map<string, ConversationSnapshot>();
    const writes: Array<() => void> = [];
    let backend!: ProbeBackend;
    const window = openWindow(store, {
      make: (config) => (backend = new ProbeBackend(config, 'openai-compat', () => store.get(ID))),
      deps: {
        saveSnapshot: (id, snapshot) => new Promise<void>((resolve) => {
          writes.push(() => { store.set(id, structuredClone(snapshot)); resolve(); });
        }),
      },
    });
    manager = window.manager;
    window.manager.create(agent());
    await window.manager.start(ID, { pin: 'take' });
    backend.emit({ kind: 'ready' });
    window.bus.send('user', ID, 'ask.question', { instruction: NEW_TASK, mode: 'act' });
    await tick();

    window.manager.interrupt(ID);
    while (writes.length > 0) { writes.shift()!(); await tick(); }
    expect(backend.turns).toEqual([]);
    // The Stop is the turn's terminal outcome: the last record written says that no request is with the backend.
    expect(store.get(ID)).toMatchObject({ hostTurnState: 'complete' });
  });

  it.each([
    ['refuses the record at once', (): void => { throw new Error('disk full'); }],
    ['fails to write the record', (): Promise<void> => Promise.reject(new Error('disk full'))],
  ] as Array<[string, () => void | Promise<void>]>)('does not hand the request over when the store %s, and says so', async (_what, saveSnapshot) => {
    const store = new Map<string, ConversationSnapshot>();
    let backend!: ProbeBackend;
    const window = openWindow(store, {
      make: (config) => (backend = new ProbeBackend(config, 'openai-compat', () => store.get(ID))),
      deps: { saveSnapshot },
    });
    manager = window.manager;
    window.manager.create(agent());
    await window.manager.start(ID, { pin: 'take' });
    backend.emit({ kind: 'ready' });

    window.bus.send('user', ID, 'ask.question', { instruction: NEW_TASK, mode: 'act' });
    await tick(); await tick();

    expect(backend.turns).toEqual([]);
    const terminal = window.sent.filter((message) => message.from === ID && message.to === 'user' && message.type === 'system.error');
    expect(terminal.map((message) => message.payload.instruction)).toEqual([REQUEST_NOT_RECORDED_STOP]);
    expect(REQUEST_NOT_RECORDED_STOP).toBe(
      'UnodeAi did not send this request: it could not save the record that the request was starting. Send it again.',
    );
    expect(window.manager.get(ID)!.status).toBe('stopped');
  });

  it('is written for a backend that has nothing to keep yet: the marker alone says a request was handed over', async () => {
    const store = new Map<string, ConversationSnapshot>();
    let backend!: ProbeBackend;
    const window = openWindow(store, { make: (config) => (backend = new ProbeBackend(config, 'codex', () => store.get(ID))) });
    manager = window.manager;
    window.manager.create(codexAgent());
    await window.manager.start(ID, { pin: 'take' });
    backend.emit({ kind: 'ready' });
    expect(backend.snapshot()).toBeUndefined();

    window.bus.send('user', ID, 'ask.question', { instruction: NEW_TASK, mode: 'act' });
    expect(backend.turns).toEqual([{ instruction: NEW_TASK, storedMarker: 'incomplete' }]);
    expect(store.get(ID)).toEqual({ version: 3, backend: 'codex', messages: [], hostTurnState: 'incomplete' });

    // The host goes away with the request still out. What the next start reads says so.
    await window.reload();
    expect(store.get(ID)).toEqual({ version: 3, backend: 'codex', messages: [], hostTurnState: 'incomplete' });
  });

  it('does not ask a backend that refused a snapshot what it left out of it', async () => {
    const stored: ConversationSnapshot = { version: 2, messages: [{ role: 'user', content: OLD_TASK }] };
    const store = new Map<string, ConversationSnapshot>([[ID, stored]]);
    let backend!: ProbeBackend;
    const window = openWindow(store, {
      make: (config) => {
        backend = new ProbeBackend(config, 'codex', () => store.get(ID));
        backend.takes = false;
        backend.leftOut = { notice: 'interrupted', reasons: ['host-turn-incomplete'], quarantinedMessages: 0, restoredMessages: 0 };
        return backend;
      },
    });
    manager = window.manager;
    window.manager.create(codexAgent());
    await window.manager.start(ID, { pin: 'take' });
    await tick();

    // The refusal is the one thing said, and the snapshot is discarded: nothing is stored in its place.
    expect(backend.offered).toEqual([stored]);
    expect(window.notices).toEqual([{ reason: 'not-a-conversation', startedAs: 'codex' }]);
    expect(store.has(ID)).toBe(false);
    expect(window.saved).toEqual([]);
  });

  it('writes nothing back for a turn whose stored conversation was discarded before its process was gone', async () => {
    const store = new Map<string, ConversationSnapshot>();
    let backend!: ProbeBackend;
    const window = openWindow(store, { make: (config) => (backend = new ProbeBackend(config, 'codex', () => store.get(ID))) });
    manager = window.manager;
    window.manager.create(codexAgent());
    await window.manager.start(ID, { pin: 'take' });
    backend.kept = { version: 3, backend: 'codex', messages: [{ codexThreadId: 'thread-7f3a' }] };
    backend.emit({ kind: 'ready' });
    window.bus.send('user', ID, 'ask.question', { instruction: OLD_TASK, mode: 'act' });
    expect(store.get(ID)).toMatchObject({ hostTurnState: 'incomplete' });

    // The process fails in the middle of the turn. Before it is gone the agent is moved to another backend kind,
    // which discards what is stored of its conversation.
    backend.alive = false;
    backend.emit({ kind: 'error', message: 'App Server stopped answering.' });
    expect(window.manager.get(ID)!.status).toBe('error');
    await window.manager.configEdited(ID, { backendKindChanged: true });
    expect(store.has(ID)).toBe(false);

    // The process ends. The record of that turn belonged to the discarded conversation and is not written back.
    backend.emit({ kind: 'exit', code: 1 });
    await tick();
    expect(store.has(ID)).toBe(false);
  });

  it('records no request for a backend that was started before the stored conversation was discarded', async () => {
    const store = new Map<string, ConversationSnapshot>();
    let backend!: ProbeBackend;
    const window = openWindow(store, { make: (config) => (backend = new ProbeBackend(config, 'codex', () => store.get(ID))) });
    manager = window.manager;
    window.manager.create(codexAgent());
    await window.manager.start(ID, { pin: 'take' });
    backend.kept = { version: 3, backend: 'codex', messages: [{ codexThreadId: 'thread-7f3a' }] };
    // The backend reports a failure before it is ready, and the agent is moved to another kind meanwhile.
    backend.alive = false;
    backend.emit({ kind: 'error', message: 'App Server is not answering.' });
    await window.manager.configEdited(ID, { backendKindChanged: true });
    // It comes up after all, and is given a request.
    backend.alive = true;
    backend.emit({ kind: 'ready' });
    window.bus.send('user', ID, 'ask.question', { instruction: NEW_TASK, mode: 'act' });
    expect(backend.turns.map((turn) => turn.instruction)).toEqual([NEW_TASK]);
    backend.emit({ kind: 'turn_complete', result: { text: 'done', isError: false, responseOutcome: { kind: 'reply' } } });
    await tick();

    // A backend saves only into the conversation it was started in: nothing of this one reaches the store, not
    // when its request is handed over and not when its turn ends.
    expect(window.saved).toEqual([]);
    expect(store.has(ID)).toBe(false);
  });

  it('keeps saying that a request is with the backend when a compaction is saved in the middle of its turn', async () => {
    const resolved = resolveSmartCompactionPolicy({
      policy: bundledSmartCompactionPolicy(), agent: { roleTemplateKey: 'pm' }, contextWindow: { tokens: 1_048_576, source: 'assumed' },
    });
    if (resolved.status !== 'resolved') throw new Error('bundled policy did not resolve');
    const store = new Map<string, ConversationSnapshot>();
    let backend!: ProbeBackend;
    const window = openWindow(store, { make: (config) => (backend = new ProbeBackend(config, 'openai-compat', () => store.get(ID))) });
    manager = window.manager;
    window.manager.create(agent());
    await window.manager.start(ID, { pin: 'take' });
    backend.kept = { version: 3, backend: 'openai-compat', messages: ['before the turn'], completedMessageCount: 1 };
    backend.emit({ kind: 'ready' });
    window.bus.send('user', ID, 'ask.question', { instruction: NEW_TASK, mode: 'act' });
    expect(store.get(ID)).toMatchObject({ messages: ['before the turn'], hostTurnState: 'incomplete' });

    // The runtime compacts inside the turn, and what the backend keeps now is saved at once.
    backend.kept = { version: 3, backend: 'openai-compat', messages: ['compacted in the turn'], completedMessageCount: 1 };
    backend.emit({
      kind: 'native_compaction', operationId: 'in-turn-1', trigger: 'auto',
      before: { tokens: 82_939, basis: 'reported-plus-delta' }, after: { basis: 'unavailable' }, policy: resolved.policy,
    });
    await tick();
    expect(store.get(ID)).toEqual({
      version: 3, backend: 'openai-compat', messages: ['compacted in the turn'], completedMessageCount: 1, hostTurnState: 'incomplete',
    });

    // A Stop ends the turn. The record keeps the compacted conversation and stops saying that a request is out.
    backend.kept = { version: 3, backend: 'openai-compat', messages: ['in the middle of the turn'], completedMessageCount: 1 };
    window.manager.interrupt(ID);
    await tick();
    expect(store.get(ID)).toEqual({
      version: 3, backend: 'openai-compat', messages: ['compacted in the turn'], completedMessageCount: 1, hostTurnState: 'complete',
    });
  });

  it('keeps saying that a request is with the backend when the window closes, and stops saying it when the person stops the turn', async () => {
    for (const ending of ['reload', 'dispose', 'stop', 'process-lost'] as const) {
      const store = new Map<string, ConversationSnapshot>();
      let backend!: ProbeBackend;
      const window = openWindow(store, { make: (config) => (backend = new ProbeBackend(config, 'codex', () => store.get(ID))) });
      window.manager.create(codexAgent());
      await window.manager.start(ID, { pin: 'take' });
      backend.kept = { version: 3, backend: 'codex', messages: [{ codexThreadId: 'thread-7f3a' }] };
      backend.emit({ kind: 'ready' });
      window.bus.send('user', ID, 'ask.question', { instruction: OLD_TASK, mode: 'act' });
      // The backend is in the middle of the turn; what it would save now is not what was stored at the handover.
      backend.kept = { version: 3, backend: 'codex', messages: [{ codexThreadId: 'thread-in-the-middle' }] };

      if (ending === 'reload') await window.reload();
      else if (ending === 'dispose') window.manager.dispose();
      else if (ending === 'stop') window.manager.interrupt(ID);
      else backend.emit({ kind: 'exit', code: 1 });
      await tick();

      // A Stop and a lost process are terminal outcomes the host saw and said. A closing window is not one.
      const expected = ending === 'reload' || ending === 'dispose' ? 'incomplete' : 'complete';
      expect(store.get(ID), ending).toEqual({ version: 3, backend: 'codex', messages: [{ codexThreadId: 'thread-7f3a' }], hostTurnState: expected });
      window.manager.dispose();
    }
  });
});

describe('a request the window closed on', () => {
  let manager: SessionManager | undefined;
  afterEach(() => { manager?.dispose(); manager = undefined; });

  it('is not resumed and not sent again: the person is told once, and the next request stands alone', async () => {
    const store = new Map<string, ConversationSnapshot>();
    // One answered exchange, then a request the provider never answers.
    const first = openWindow(store, { respond: (index) => (index === 0 ? answered('Noted: heron.') : 'hang') });
    manager = first.manager;
    first.manager.create(agent());
    await first.manager.start(ID, { pin: 'take' });
    await first.turn('The code word is heron.');
    first.bus.send('user', ID, 'ask.question', { instruction: OLD_TASK, mode: 'act' });
    await until(() => first.requests.length === 2);
    // The window reloads with that request out.
    await first.reload();

    // The record written at the handover is what stayed: the conversation before that request, marked unfinished.
    const stored = store.get(ID)!;
    expect(stored).toMatchObject({ version: 3, hostTurnState: 'incomplete', completedMessageCount: 3 });
    expect(userTexts(stored.messages as Wire[])).toEqual(['The code word is heron.']);

    const second = openWindow(store, { respond: () => answered('No off-by-one error found.') });
    manager = second.manager;
    second.manager.create(agent());
    await second.manager.start(ID, { pin: 'take' });
    expect(second.notices).toEqual([{
      reason: 'request-interrupted', startedAs: 'openai-compat',
      restoredMessages: 3, quarantinedMessages: 0, reasonCodes: ['host-turn-incomplete'],
    }]);
    expect(conversationNotRestoredNotice(second.notices[0])).toBe(INTERRUPTED);
    // Nothing runs because of the restart: the old request is not sent on its own.
    await tick(); await tick();
    expect(second.requests).toEqual([]);
    expect(store.get(ID)).toMatchObject({ hostTurnState: 'complete' });

    await second.turn(NEW_TASK);
    expect(second.requests).toHaveLength(1);
    expect(userTexts(second.requests[0].messages)).toEqual(['The code word is heron.', NEW_TASK]);
    expect(JSON.stringify(second.requests)).not.toContain('codeword.txt');

    // And a restart after that says nothing more.
    await second.manager.restart(ID);
    expect(second.notices).toHaveLength(1);
  });

  it('says nothing after a turn the person stopped, and keeps the conversation from before it', async () => {
    const store = new Map<string, ConversationSnapshot>();
    const first = openWindow(store, { respond: (index) => (index === 0 ? answered('Noted: heron.') : 'hang') });
    manager = first.manager;
    first.manager.create(agent());
    await first.manager.start(ID, { pin: 'take' });
    await first.turn('The code word is heron.');
    first.bus.send('user', ID, 'ask.question', { instruction: OLD_TASK, mode: 'act' });
    await until(() => first.requests.length === 2);
    first.manager.interrupt(ID);
    await first.reload();
    expect(store.get(ID)).toMatchObject({ hostTurnState: 'complete', completedMessageCount: 3 });

    const second = openWindow(store, { respond: () => answered('No off-by-one error found.') });
    manager = second.manager;
    second.manager.create(agent());
    await second.manager.start(ID, { pin: 'take' });
    await second.turn(NEW_TASK);
    expect(second.notices).toEqual([]);
    expect(userTexts(second.requests[0].messages)).toEqual(['The code word is heron.', NEW_TASK]);
  });

  it('leaves the delegated attempt it cut off interrupted in the run ledger, and gives the worker nothing to do for it', async () => {
    const store = new Map<string, ConversationSnapshot>();
    const first = openWindow(store, { respond: (index) => (index === 0 ? answered('Noted: heron.') : 'hang') });
    manager = first.manager;
    first.manager.create(agent());
    await first.manager.start(ID, { pin: 'take' });
    await first.turn('The code word is heron.');
    // The coordinator delegates a task to this worker. The run ledger has it as live work.
    const ledger = new RunLedger();
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'handle-7', requestedAgent: 'Reviewer', agentId: ID,
      instruction: OLD_TASK, attemptId: 'attempt-7', originCorrelationId: 'root-7', dispatchedAt: '2026-10-10T10:00:00.000Z',
    });
    first.bus.send('pm', ID, 'task.assign', { instruction: OLD_TASK }, 'normal', 'handle-7');
    await until(() => first.requests.length === 2);
    const persisted = ledger.snapshot();
    await first.reload();

    // The new host cannot resume the attempt. It is interrupted, for good: `host-restarted`.
    const restoredLedger = new RunLedger(persisted);
    expect(restoredLedger.reconcileRestoredActiveDelegations('2026-10-10T10:05:00.000Z')).toEqual([
      expect.objectContaining({ handle: 'handle-7', agentId: ID, attemptId: 'attempt-7', reason: 'host-restarted' }),
    ]);
    expect(restoredLedger.inspectTaskStatus('pm', ['handle-7'])[0]).toMatchObject({
      lifecycle: 'interrupted', interruption: { reason: 'host-restarted' },
    });
    expect(restoredLedger.get(runId)?.delegations[0]).toMatchObject({ state: 'interrupted' });
    // It is no live work any more: a later reconciliation finds nothing to interrupt, and it waits for the coordinator.
    expect(restoredLedger.reconcileRestoredActiveDelegations('2026-10-10T10:06:00.000Z')).toEqual([]);
    expect(restoredLedger.unresolvedInterruptions().map((interruption) => interruption.handle)).toEqual(['handle-7']);

    // The worker starts with its earlier conversation and no task. Nothing wakes it for the attempt.
    const second = openWindow(store, { respond: () => answered('No off-by-one error found.') });
    manager = second.manager;
    second.manager.create(agent());
    await second.manager.start(ID, { pin: 'take' });
    await tick(); await tick();
    expect(second.requests).toEqual([]);
    expect(second.manager.get(ID)!.status).toBe('idle');
    expect(second.manager.get(ID)!.currentTask).toBeUndefined();
    expect(second.sent.filter((message) => message.to === ID)).toEqual([]);
    expect(second.notices.map((notice) => notice.reason)).toEqual(['request-interrupted']);
    expect(JSON.stringify(store.get(ID))).not.toContain('codeword.txt');

    // The replacement the coordinator sends is the only task the worker runs.
    second.bus.send('pm', ID, 'task.assign', { instruction: NEW_TASK }, 'normal', 'handle-8');
    await until(() => second.requests.length === 1);
    expect(userTexts(second.requests[0].messages)).toEqual(['The code word is heron.', NEW_TASK]);
  });

  // The extension says the host is exiting before it stops the agents, and disposes them after every cleanup: its
  // deactivate() runs in src/__tests__/deactivate.test.ts.

  it('reports an unconfirmed background stop at shutdown to the output channel only, not as a warning', () => {
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    // A stop sent at shutdown is never observed, so its report goes to the output channel only, not to a warning.
    const reporterStart = source.indexOf('function reportUnconfirmedBackgroundStops(');
    const reporter = source.slice(reporterStart, source.indexOf('\n}\n', reporterStart));
    const quiet = reporter.indexOf('if (hostShutdown.started) return;');
    expect(quiet).toBeGreaterThan(reporter.indexOf('outputChannel.warn('));
    expect(reporter.indexOf('showWarningMessage(')).toBeGreaterThan(quiet);
  });
});

describe('a stored Codex thread at the start of its agent', () => {
  let manager: SessionManager | undefined;
  afterEach(() => { manager?.dispose(); manager = undefined; });

  const thread = { codexThreadId: 'thread-7f3a', codexDynamicTools: '{"team":false,"mcpTools":[],"executableSkills":false}' };
  const startWith = async (stored: ConversationSnapshot) => {
    const store = new Map<string, ConversationSnapshot>([[ID, structuredClone(stored)]]);
    const backends: CodexWithoutProcess[] = [];
    const window = openWindow(store, {
      make: (config) => { const backend = new CodexWithoutProcess(config, undefined, {}); backends.push(backend); return backend; },
    });
    manager = window.manager;
    window.manager.create(codexAgent());
    await window.manager.start(ID, { pin: 'take' });
    await tick();
    return { store, window, backends };
  };

  it.each([1, 2] as const)('starts a version %i thread fresh once, keeps nothing of its reference, and says why in its own words', async (version) => {
    const { store, window, backends } = await startWith({ version, backend: 'codex', messages: [thread] });

    expect(window.notices).toEqual([{
      reason: 'legacy-completion-unknown', startedAs: 'codex', restoredMessages: 0, quarantinedMessages: 0, reasonCodes: ['legacy-thread'],
    }]);
    expect(conversationNotRestoredNotice(window.notices[0])).toBe(LEGACY);
    // The request is not called interrupted: nothing says that it was.
    expect(conversationNotRestoredNotice(window.notices[0])).not.toContain('interrupted');
    // The backend holds no thread, and the stored record no longer names one.
    expect(backends[0].snapshot()).toBeUndefined();
    expect(store.get(ID)).toEqual({ version: 3, backend: 'codex', messages: [], hostTurnState: 'complete' });

    // Started again, in this window and in the next: nothing more is said.
    await window.manager.restart(ID);
    await tick();
    expect(window.notices).toHaveLength(1);
    await window.reload();
    const next = await startWith(store.get(ID)!);
    expect(next.window.notices).toEqual([]);
  });

  it('starts a thread fresh when its record says a request was with it, and says that the request was interrupted', async () => {
    const { store, window, backends } = await startWith({ version: 3, backend: 'codex', hostTurnState: 'incomplete', messages: [thread] });

    expect(window.notices).toEqual([{
      reason: 'request-interrupted', startedAs: 'codex', restoredMessages: 0, quarantinedMessages: 0, reasonCodes: ['host-turn-incomplete'],
    }]);
    expect(conversationNotRestoredNotice(window.notices[0])).toBe(INTERRUPTED);
    expect(backends[0].snapshot()).toBeUndefined();
    expect(store.get(ID)).toEqual({ version: 3, backend: 'codex', messages: [], hostTurnState: 'complete' });
    await window.manager.restart(ID);
    await tick();
    expect(window.notices).toHaveLength(1);
  });

  it('keeps a thread whose record says the host saw its last request end, and says nothing', async () => {
    const stored: ConversationSnapshot = { version: 3, backend: 'codex', hostTurnState: 'complete', messages: [thread] };
    const { store, window, backends } = await startWith(stored);

    expect(window.notices).toEqual([]);
    expect(backends[0].snapshot()).toMatchObject({ messages: [{ codexThreadId: 'thread-7f3a' }] });
    expect(store.get(ID)).toEqual(stored);
    expect(window.saved).toEqual([]);
  });
});

describe('an agent on the Claude CLI', () => {
  /** A backend that keeps no conversation across a start, as the Claude CLI backend does. */
  class NoConversationBackend implements AgentBackend {
    readonly agentId: string;
    pid = 99;
    turns: string[] = [];
    private handler?: BackendEventHandler;
    constructor(config: AgentConfig) { this.agentId = config.id; }
    onEvent(handler: BackendEventHandler): () => void { this.handler = handler; return () => (this.handler = undefined); }
    async start(): Promise<void> { /* nothing */ }
    sendUserTurn(instruction: string): void { this.turns.push(instruction); }
    async stop(): Promise<void> { /* nothing */ }
    abort(): void { /* nothing to end */ }
    isAlive(): boolean { return true; }
    emit(event: BackendEvent): void { this.handler?.(event); }
  }

  it('has no stored record at any point of a turn, and takes none that an earlier kind left', async () => {
    const leftover: ConversationSnapshot = {
      version: 3, backend: 'openai-compat', hostTurnState: 'incomplete', completedMessageCount: 1,
      messages: [{ role: 'system', content: 'Be terse.' }, { role: 'user', content: OLD_TASK }],
    };
    const store = new Map<string, ConversationSnapshot>([[ID, leftover]]);
    let backend!: NoConversationBackend;
    const window = openWindow(store, { make: (config) => (backend = new NoConversationBackend(config)) });
    window.manager.create(agent({ provider: { providerId: 'claude-cli', apiKeySecretName: 'CLAUDE_CLI_AUTH' }, model: 'opus', backend: 'claude' }));
    await window.manager.start(ID, { pin: 'take' });

    // The leftover is discarded, and the chat is told nothing: this model starts new at every start.
    expect(store.has(ID)).toBe(false);
    expect(window.notices).toEqual([{ reason: 'other-backend', writtenBy: 'openai-compat' }]);
    expect(conversationNotRestoredNotice(window.notices[0])).toBeUndefined();

    backend.emit({ kind: 'ready' });
    window.bus.send('user', ID, 'ask.question', { instruction: NEW_TASK, mode: 'act' });
    expect(backend.turns).toEqual([NEW_TASK]);
    expect(store.has(ID)).toBe(false);
    backend.emit({ kind: 'turn_complete', result: { text: 'done', isError: false, responseOutcome: { kind: 'reply' } } });
    await window.reload();
    expect(store.has(ID)).toBe(false);
    expect(window.saved).toEqual([]);
  });
});
