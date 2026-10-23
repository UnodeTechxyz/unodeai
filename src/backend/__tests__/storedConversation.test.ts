import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../../types';
import type { BackendEvent, ConversationSnapshot } from '../AgentBackend';
import { CODEX_CLI_DEFAULT_MODEL, CodexBackend } from '../CodexBackend';
import {
  type ChatMessage, type FetchFn, MAX_QUARANTINED_BYTES, MAX_QUARANTINED_MESSAGES, OpenAICompatBackend,
  completedExchangeCount, readStoredChatMessages,
} from '../OpenAICompatBackend';
import { renderRollingSummary } from '../../compaction/HistoryCompactionPlanner';

/*
 * v0.9.94, field finding of 2026-10-10. An agent was changed from Codex CLI to an OpenAI-compatible connection.
 * Its stored snapshot was the Codex backend's own continuation record, an object with neither `role` nor
 * `content`. The OpenAI-compatible backend took it as a chat message and sent it: the provider answered HTTP 400,
 * and the next save made it part of that backend's own snapshot. A snapshot belongs to the backend kind that wrote
 * it, and nothing that is not a chat message is taken from one.
 */

function openAiConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'senior-dev', name: 'Senior Developer', role: 'senior-dev', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-chat', systemPrompt: 'Be terse.', autoApprove: true, allowedTools: [],
    workingDirectory: process.cwd(), ...overrides,
  };
}

function scriptedFetch(bodies: unknown[]): { fetchFn: FetchFn; requests: Array<{ messages: unknown[] }> } {
  const requests: Array<{ messages: unknown[] }> = [];
  let i = 0;
  const fetchFn: FetchFn = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetchFn, requests };
}

const REPLY = { choices: [{ message: { role: 'assistant', content: 'OK' } }] };

async function runOneTurn(backend: OpenAICompatBackend, instruction: string): Promise<BackendEvent[]> {
  const events: BackendEvent[] = [];
  const done = new Promise<void>((resolve) => {
    backend.onEvent((event) => {
      events.push(event);
      if (event.kind === 'turn_complete') resolve();
    });
  });
  await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
  backend.sendUserTurn(instruction);
  await done;
  return events;
}

/** The snapshot a Codex backend with a live thread writes, taken from the real backend. */
function codexSnapshot(): ConversationSnapshot {
  const codex = new CodexBackend({
    id: 'senior-dev', name: 'Senior Developer', role: 'senior-dev', skill: '',
    provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' }, model: CODEX_CLI_DEFAULT_MODEL,
    systemPrompt: '', autoApprove: true, allowedTools: [], backend: 'codex', workingDirectory: process.cwd(),
  }, undefined, {});
  // A thread is taken up again only from a record whose last request the host saw end (v0.9.95).
  expect(codex.restore({ version: 3, backend: 'codex', hostTurnState: 'complete', messages: [{
    codexThreadId: 'thread-7f3a',
    codexUsageBaseline: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 40 },
    codexLastRequest: { inputTokens: 1200, outputTokens: 40 },
    codexContextWindow: { model: CODEX_CLI_DEFAULT_MODEL, tokens: 272000 },
  }] })).toBe(true);
  const snapshot = codex.snapshot();
  expect(snapshot).toBeDefined();
  return snapshot!;
}

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/** Every message of a request is a chat message a provider can read. */
function expectWireMessages(messages: unknown[]): void {
  expect(messages.length).toBeGreaterThan(0);
  for (const message of messages) {
    const entry = message as Record<string, unknown>;
    expect(ROLES.has(entry.role as string), JSON.stringify(Object.keys(entry))).toBe(true);
    const content = entry.content;
    const readable = typeof content === 'string' || content === null
      || (Array.isArray(content) && content.every((part) => part && typeof part === 'object'
        && ((part as { type?: unknown }).type !== 'text' || typeof (part as { text?: unknown }).text === 'string')));
    expect(readable, JSON.stringify(Object.keys(entry))).toBe(true);
  }
  expect(JSON.stringify(messages)).not.toContain('codexThreadId');
}

describe('a stored conversation belongs to the backend kind that wrote it', () => {
  it('names its kind in the snapshot each backend writes', () => {
    expect(codexSnapshot().backend).toBe('codex');
    expect(codexSnapshot().messages[0]).toMatchObject({ codexThreadId: 'thread-7f3a' });
    const backend = new OpenAICompatBackend(openAiConfig(), scriptedFetch([REPLY]).fetchFn);
    expect(backend.snapshot().backend).toBe('openai-compat');
    expect(backend.snapshotKind).toBe('openai-compat');
    expect(new CodexBackend({ ...openAiConfig(), backend: 'codex' }, undefined, {}).snapshotKind).toBe('codex');
  });

  it('refuses a Codex snapshot on an OpenAI-compatible backend, and nothing of it reaches the first request', async () => {
    const { fetchFn, requests } = scriptedFetch([REPLY]);
    const backend = new OpenAICompatBackend(openAiConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });

    expect(backend.restore(codexSnapshot())).toBe(false);
    await runOneTurn(backend, 'Reply with the single word OK');

    expect(requests).toHaveLength(1);
    expectWireMessages(requests[0].messages);
    // A refused snapshot is not a restored session: the model is told nothing about one.
    expect(JSON.stringify(requests[0].messages)).not.toContain('Session restored from a previous session');
    // The first request is the system prompt and the request the person sent, and nothing else.
    expect(requests[0].messages.map((message) => (message as { role: string }).role)).toEqual(['system', 'user']);
  });

  it.each([1, 2] as const)('refuses a version %i snapshot from before the kind was written that holds a Codex record', async (version) => {
    const { fetchFn, requests } = scriptedFetch([REPLY]);
    const backend = new OpenAICompatBackend(openAiConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const legacy = { version, messages: structuredClone(codexSnapshot().messages) } as ConversationSnapshot;
    expect(legacy.backend).toBeUndefined();

    expect(backend.restore(legacy)).toBe(false);
    await runOneTurn(backend, 'Reply with the single word OK');

    expectWireMessages(requests[0].messages);
  });

  it('refuses the snapshot the field left behind, and does not write it again', async () => {
    // What the OpenAI-compatible backend saved after its failed turn: its system message, the Codex record it had
    // taken for a message, and the two requests the person sent.
    const poisoned: ConversationSnapshot = {
      version: 2,
      messages: [
        { role: 'system', content: 'Be terse.' },
        structuredClone(codexSnapshot().messages[0]),
        { role: 'user', content: 'Reply with the single word OK' },
        { role: 'user', content: 'Reply with the single word OK' },
      ],
    };
    const { fetchFn, requests } = scriptedFetch([REPLY]);
    const backend = new OpenAICompatBackend(openAiConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });

    expect(backend.restore(poisoned)).toBe(false);
    await runOneTurn(backend, 'Reply with the single word OK');

    expectWireMessages(requests[0].messages);
    const saved = backend.snapshot();
    expect(saved.backend).toBe('openai-compat');
    expect(readStoredChatMessages(saved.messages)).toBeDefined();
    expect(JSON.stringify(saved)).not.toContain('codexThreadId');
    expect(saved.messages.map((message) => (message as { role: string }).role)).toEqual(['system', 'user', 'assistant']);
  });

  it('refuses a snapshot another kind signed, whatever its messages look like', () => {
    const backend = new OpenAICompatBackend(openAiConfig(), scriptedFetch([REPLY]).fetchFn);
    expect(backend.restore({ version: 2, backend: 'codex', messages: [{ role: 'user', content: 'hello' }] })).toBe(false);
    expect(backend.snapshot().messages).toEqual([]);
  });

  it('takes its own snapshot, with the kind or from before the kind was written', async () => {
    const history = [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'what is the codeword?' },
      { role: 'assistant', content: 'The codeword is heron.' },
    ];
    for (const snapshot of [
      { version: 2, backend: 'openai-compat', messages: history },
      { version: 2, messages: history },
      { version: 1, messages: history },
    ] as ConversationSnapshot[]) {
      const { fetchFn, requests } = scriptedFetch([REPLY]);
      const backend = new OpenAICompatBackend(openAiConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
      expect(backend.restore(structuredClone(snapshot))).toBe(true);
      await runOneTurn(backend, 'say it again');
      expect(JSON.stringify(requests[0].messages)).toContain('The codeword is heron.');
      expectWireMessages(requests[0].messages);
    }
  });

  it('leaves the backend as it was when it refuses: no accounting fact is taken from a refused snapshot', () => {
    const backend = new OpenAICompatBackend(openAiConfig(), scriptedFetch([REPLY]).fetchFn);
    expect(backend.restore({
      version: 2,
      messages: [{ codexThreadId: 'thread-7f3a' }],
      usageBaseline: { routes: [{ route: 'https://gateway.example/v1|deepseek-chat', semantics: 'exclusive' }] },
    })).toBe(false);
    expect(backend.snapshot().usageBaseline).toEqual({ routes: [] });
  });

  it('refuses a snapshot whose compacted provider history holds an entry that is not a message', () => {
    const backend = new OpenAICompatBackend(openAiConfig(), scriptedFetch([REPLY]).fetchFn);
    expect(backend.restore({
      version: 2,
      messages: [{ role: 'system', content: 'Be terse.' }, { role: 'user', content: 'hello' }],
      providerHistory: [{ role: 'system', content: 'Be terse.' }, { codexThreadId: 'thread-7f3a' }],
    })).toBe(false);
    expect(backend.snapshot().messages).toEqual([]);
  });
});

describe('what the OpenAI-compatible backend takes for a stored chat message', () => {
  const call = { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } };

  it('takes every shape this backend writes', () => {
    const stored = [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'read a.txt' },
      { role: 'user', content: [{ type: 'text', text: 'what is in this picture?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: '', tool_calls: [call], reasoning_content: 'I should read it.' },
      { role: 'assistant', content: null, tool_calls: [{ ...call, function: { name: 'read_file', arguments: { path: 'a.txt' } } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'alpha', hostOutcome: { status: 'ok' } },
      { role: 'assistant', content: 'It says alpha.' },
    ];
    const read = readStoredChatMessages(stored);
    expect(read).toEqual(stored);
    // A copy: the stored value is never the live history.
    expect(read).not.toBe(stored);
    expect(read![0]).not.toBe(stored[0]);
  });

  it.each([
    ['is not a list', { role: 'user', content: 'hi' }],
    ['holds an entry that is not an object', ['hi']],
    ['holds a list where a message should be', [[{ role: 'user', content: 'hi' }]]],
    ['holds an entry with no role', [{ content: 'hi' }]],
    ['holds an entry with a role no provider knows', [{ role: 'developer-note', content: 'hi' }]],
    ['holds an entry with no content', [{ role: 'user' }]],
    ['holds a user message with null content', [{ role: 'user', content: null }]],
    ['holds a tool result with null content', [{ role: 'tool', tool_call_id: 'call-1', content: null }]],
    ['holds content that is a number', [{ role: 'user', content: 7 }]],
    ['holds content that is an object', [{ role: 'user', content: { text: 'hi' } }]],
    ['holds an empty list of parts', [{ role: 'user', content: [] }]],
    ['holds a text part with no text', [{ role: 'user', content: [{ type: 'text' }] }]],
    ['holds a text part whose text is not a string', [{ role: 'user', content: [{ type: 'text', text: 7 }] }]],
    ['holds an image part with no address', [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }]],
    ['holds an image part with no image', [{ role: 'user', content: [{ type: 'image_url' }] }]],
    ['holds a part of a kind it does not write', [{ role: 'user', content: [{ type: 'input_audio', data: 'AAAA' }] }]],
    ['holds tool calls that are not a list', [{ role: 'assistant', content: '', tool_calls: call }]],
    ['holds a tool call with no id', [{ role: 'assistant', content: '', tool_calls: [{ type: 'function', function: call.function }] }]],
    ['holds a tool call with no function', [{ role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function' }] }]],
    ['holds a tool call whose function has no name', [{ role: 'assistant', content: '', tool_calls: [{ id: 'call-1', function: { arguments: '{}' } }] }]],
    ['holds a tool result whose call id is not a string', [{ role: 'tool', tool_call_id: 7, content: 'alpha' }]],
    // Each field only on the role that carries it (Codex's audit of 2026-10-10).
    ['holds an assistant turn with null content and no tool call', [{ role: 'assistant', content: null }]],
    ['holds an assistant turn with null content and an empty list of tool calls', [{ role: 'assistant', content: null, tool_calls: [] }]],
    ['holds an assistant turn with an empty list of tool calls', [{ role: 'assistant', content: 'done', tool_calls: [] }]],
    ['holds tool calls on a user message', [{ role: 'user', content: 'hi', tool_calls: [call] }]],
    ['holds tool calls on a system message', [{ role: 'system', content: 'Be terse.', tool_calls: [call] }]],
    ['holds tool calls on a tool result', [{ role: 'tool', tool_call_id: 'call-1', content: 'alpha', tool_calls: [call] }]],
    ['holds a tool call with an empty id', [{ role: 'assistant', content: '', tool_calls: [{ id: '', function: call.function }] }]],
    ['holds a tool result with no call id', [{ role: 'tool', content: 'alpha' }]],
    ['holds a tool result with an empty call id', [{ role: 'tool', tool_call_id: '', content: 'alpha' }]],
    ['holds a call id on an assistant turn', [{ role: 'assistant', content: 'done', tool_call_id: 'call-1' }]],
    ['holds a call id on a user message', [{ role: 'user', content: 'hi', tool_call_id: 'call-1' }]],
    ['holds reasoning that is not text', [{ role: 'assistant', content: 'done', reasoning_content: { text: 'thinking' } }]],
    ['holds reasoning on a user message', [{ role: 'user', content: 'hi', reasoning_content: 'thinking' }]],
    ['holds reasoning on a tool result', [{ role: 'tool', tool_call_id: 'call-1', content: 'alpha', reasoning_content: 'thinking' }]],
  ])('refuses a record that %s', (_what, stored) => {
    expect(readStoredChatMessages(stored)).toBeUndefined();
  });

  it('reads null in an optional field as the field being absent, and does not carry it into the copy', () => {
    // A provider that leaves a field out may write null for it. That is no reason to discard a conversation,
    // and no reason to send the null on to another provider.
    const stored = [
      { role: 'system', content: 'Be terse.', tool_calls: null },
      { role: 'user', content: 'hi', tool_call_id: null, reasoning_content: null },
      { role: 'assistant', content: 'hello', tool_calls: null, tool_call_id: null, reasoning_content: null, refusal: null },
    ];
    expect(readStoredChatMessages(stored)).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'hi' },
      // A field this backend does not read is left as the provider wrote it.
      { role: 'assistant', content: 'hello', refusal: null },
    ]);
    // The stored value itself is not changed.
    expect(stored[2]).toHaveProperty('tool_calls', null);
  });

  it('does not let null stand in for what a role requires', () => {
    expect(readStoredChatMessages([{ role: 'assistant', content: null, tool_calls: null }])).toBeUndefined();
    expect(readStoredChatMessages([{ role: 'tool', tool_call_id: null, content: 'alpha' }])).toBeUndefined();
  });

  it('sends nothing role-invalid from a record it takes', async () => {
    // What is taken goes out as it is; this is the whole of what a restored assistant turn may carry.
    const stored = [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'read a.txt' },
      { role: 'assistant', content: null, tool_calls: [call], reasoning_content: 'I should read it.', tool_call_id: null },
      { role: 'tool', tool_call_id: 'call-1', content: 'alpha', tool_calls: null },
      { role: 'assistant', content: 'It says alpha.', tool_calls: null },
    ];
    const { fetchFn, requests } = scriptedFetch([REPLY]);
    const backend = new OpenAICompatBackend(openAiConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    expect(backend.restore({ version: 2, backend: 'openai-compat', messages: stored })).toBe(true);
    await runOneTurn(backend, 'and again?');

    for (const message of requests[0].messages as Array<Record<string, unknown>>) {
      if (message.role !== 'assistant') expect('tool_calls' in message, JSON.stringify(Object.keys(message))).toBe(false);
      if (message.role !== 'tool') expect('tool_call_id' in message, JSON.stringify(Object.keys(message))).toBe(false);
      if ('tool_calls' in message) expect((message.tool_calls as unknown[]).length).toBeGreaterThan(0);
      if (message.role === 'tool') expect(typeof message.tool_call_id).toBe('string');
    }
  });

  it('refuses the whole record for one bad entry, so no tool result is left without its call', async () => {
    const stored = [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'read a.txt' },
      { role: 'assistant', content: '', tool_calls: [call] },
      { codexThreadId: 'thread-7f3a' },
      { role: 'tool', tool_call_id: 'call-1', content: 'alpha' },
      { role: 'assistant', content: 'It says alpha.' },
    ];
    expect(readStoredChatMessages(stored)).toBeUndefined();

    const { fetchFn, requests } = scriptedFetch([REPLY]);
    const backend = new OpenAICompatBackend(openAiConfig(), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    expect(backend.restore({ version: 2, messages: stored })).toBe(false);
    await runOneTurn(backend, 'Reply with the single word OK');
    expectWireMessages(requests[0].messages);
    expect(requests[0].messages.some((message) => (message as { role: string }).role === 'tool')).toBe(false);
    expect(requests[0].messages.some((message) => 'tool_calls' in (message as object))).toBe(false);
  });

  it('keeps a valid tool-call history whole through a restore', async () => {
    const stored = [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'read a.txt' },
      { role: 'assistant', content: '', tool_calls: [call] },
      { role: 'tool', tool_call_id: 'call-1', content: 'alpha' },
      { role: 'assistant', content: 'It says alpha.' },
    ];
    const { fetchFn, requests } = scriptedFetch([REPLY]);
    const backend = new OpenAICompatBackend(openAiConfig({ allowedTools: ['read'] }), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    expect(backend.restore({ version: 2, backend: 'openai-compat', messages: stored })).toBe(true);
    await runOneTurn(backend, 'and again?');

    const sent = requests[0].messages as Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>;
    const callAt = sent.findIndex((message) => message.tool_calls?.[0]?.id === 'call-1');
    expect(callAt).toBeGreaterThan(0);
    expect(sent[callAt + 1]).toMatchObject({ role: 'tool', tool_call_id: 'call-1', content: 'alpha' });
  });
});

describe('the Codex backend and a snapshot that is not its own', () => {
  const codex = () => new CodexBackend({ ...openAiConfig(), backend: 'codex' }, undefined, {});

  it('takes its own snapshot, with the kind or from before the kind was written', () => {
    expect(codex().restore(codexSnapshot())).toBe(true);
    expect(codex().restore({ version: 1, messages: [{ codexThreadId: 'thread-7f3a' }] })).toBe(true);
  });

  it('refuses a conversation of the OpenAI-compatible kind, and keeps no thread from it', () => {
    const backend = codex();
    expect(backend.restore({ version: 2, backend: 'openai-compat', messages: [{ role: 'user', content: 'hi' }] })).toBe(false);
    expect(backend.restore({ version: 2, messages: [{ role: 'system', content: 'Be terse.' }, { role: 'user', content: 'hi' }] })).toBe(false);
    expect(backend.restore({ version: 2, backend: 'openai-compat', messages: [{ codexThreadId: 'thread-7f3a' }] })).toBe(false);
    expect(backend.snapshot()).toBeUndefined();
  });
});

/*
 * v0.9.95, field finding of 2026-10-10. A Reviewer was given a review and carried out an older task beside it. Its
 * request held that older task, then the note `[Session restored from a previous session.]`, then the review. The
 * older task had never been answered: its turn had ended in a provider failure, and the snapshot of that turn was
 * the stored record. A restore put the whole record back and appended the note as one more user message, so the
 * model read the older task as open work.
 *
 * A restore now continues only the part of a record that was answered. What follows it is kept apart as evidence
 * and reaches no provider. The note travels with the request and is no message of the conversation.
 */

const SYSTEM: ChatMessage = { role: 'system', content: 'Be terse.' };
const OLD_TASK = 'Task card t-7 for Reviewer. Read notes/codeword.txt and report the code word it holds.';
const NEW_TASK = 'Review src/app.ts for an off-by-one error.';
const NOTE_MARK = '[Session restored from a previous session.]';
const ask = (content: string): ChatMessage => ({ role: 'user', content });
const answer = (content: string): ChatMessage => ({ role: 'assistant', content });
const readCall = (id: string) => ({ id, type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"notes/codeword.txt"}' } });
const callsFor = (...ids: string[]): ChatMessage => ({ role: 'assistant', content: null, tool_calls: ids.map(readCall) });
const resultOf = (id: string, content = 'heron'): ChatMessage => ({ role: 'tool', tool_call_id: id, content });
/** A step of a tool loop as the XML protocol stores it: the call in the turn's text, the result in a user message. */
const XML_CALL = 'I will read it.\n<read_file>\n<path>notes/codeword.txt</path>\n</read_file>';
const XML_RESULT = '[Tool result: read_file]\nheron';

type Sent = Array<{ role: string; content: unknown; tool_calls?: unknown; tool_call_id?: unknown }>;
type Step = Partial<ChatMessage> | 'fail';

/** A provider that answers each request with the next step. `fail` is an HTTP 503. */
function provider(steps: Step[] | ((index: number) => Step)): { fetchFn: FetchFn; requests: Array<{ messages: Sent }> } {
  const requests: Array<{ messages: Sent }> = [];
  const fetchFn: FetchFn = async (_url, init) => {
    const index = requests.length;
    requests.push(JSON.parse(init.body));
    const step = typeof steps === 'function' ? steps(index) : steps[Math.min(index, steps.length - 1)];
    if (step === 'fail') {
      return { ok: false, status: 503, text: async () => '{"error":{"message":"model_not_found"}}' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', ...step } }] }) };
  };
  return { fetchFn, requests };
}

function backendOn(fetchFn: FetchFn = provider([{ content: 'OK' }]).fetchFn, config: Partial<AgentConfig> = {}): OpenAICompatBackend {
  return new OpenAICompatBackend(openAiConfig(config), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0, maxRetries: 0 });
}

const rolesOf = (messages: unknown[]): string[] => messages.map((message) => (message as { role: string }).role);
const userTexts = (messages: unknown[]): unknown[] => messages
  .filter((message) => (message as { role: string }).role === 'user')
  .map((message) => (message as { content: unknown }).content);
/** A snapshot as the session stores it: the backend's own state under the host's turn marker. */
const storedAs = (snapshot: ConversationSnapshot, hostTurnState: 'complete' | 'incomplete'): ConversationSnapshot =>
  ({ ...structuredClone(snapshot), hostTurnState });
const historyOf = (backend: OpenAICompatBackend): ChatMessage[] => (backend as unknown as { history: ChatMessage[] }).history;

describe('a restored conversation gives the model no request that was never answered', () => {
  it('keeps the unanswered task of the field record out of the first request, and sends the new task alone', async () => {
    // What v0.9.94 stored after the Reviewer's turn failed: its system message and the task, with no answer.
    const fieldRecord: ConversationSnapshot = {
      version: 2, backend: 'openai-compat', messages: [SYSTEM, ask(OLD_TASK)], usageBaseline: { routes: [] },
    };
    const { fetchFn, requests } = provider([{ content: 'No off-by-one error found.' }]);
    const backend = backendOn(fetchFn);

    expect(backend.restore(structuredClone(fieldRecord))).toBe(true);
    expect(backend.takeRestoreReport()).toEqual({
      notice: 'unanswered', reasons: ['legacy-unfinished-tail'], quarantinedMessages: 1, restoredMessages: 1,
    });
    // Said once.
    expect(backend.takeRestoreReport()).toBeUndefined();

    await runOneTurn(backend, NEW_TASK);

    // One request, and the new task is the only instruction in it.
    expect(requests).toHaveLength(1);
    expect(requests[0].messages).toEqual([SYSTEM, ask(NEW_TASK)]);
    expect(JSON.stringify(requests)).not.toContain('codeword');
    // Nothing but the system prompt was restored, so there is no earlier content to warn about.
    expect(JSON.stringify(requests)).not.toContain(NOTE_MARK);
  });

  it('keeps answered exchanges as context, and what it left out as evidence that no request and no record carries', async () => {
    const stored: ConversationSnapshot = {
      version: 2, backend: 'openai-compat',
      messages: [SYSTEM, ask('The code word is heron.'), answer('Noted: heron.'), ask(OLD_TASK)],
    };
    const { fetchFn, requests } = provider([{ content: 'No off-by-one error found.' }, { content: 'It is heron.' }]);
    const backend = backendOn(fetchFn);
    expect(backend.restore(structuredClone(stored))).toBe(true);
    expect(backend.takeRestoreReport()).toMatchObject({ quarantinedMessages: 1, restoredMessages: 3 });

    await runOneTurn(backend, NEW_TASK);

    expect(userTexts(requests[0].messages)).toEqual(['The code word is heron.', NEW_TASK]);
    expect(requests[0].messages.slice(0, 4)).toEqual([SYSTEM, ask('The code word is heron.'), answer('Noted: heron.'), ask(NEW_TASK)]);
    expect(JSON.stringify(requests)).not.toContain('codeword.txt');

    const saved = backend.snapshot();
    expect(saved.version).toBe(3);
    // The active record: the answered exchange, the new request and its answer. All of it is complete.
    expect(saved.messages).toEqual([
      SYSTEM, ask('The code word is heron.'), answer('Noted: heron.'), ask(NEW_TASK), answer('No off-by-one error found.'),
    ]);
    expect(saved.completedMessageCount).toBe(5);
    // The task that was left out is held beside the record, with its reason, and nowhere in it.
    expect(saved.quarantined).toEqual({ reasons: ['legacy-unfinished-tail'], messageCount: 1, messages: [ask(OLD_TASK)] });
    expect(JSON.stringify(saved.messages)).not.toContain('codeword.txt');

    // The request after that carries nothing of it either.
    await runOneTurn(backend, 'What is the code word?');
    expect(userTexts(requests[1].messages)).toEqual(['The code word is heron.', NEW_TASK, 'What is the code word?']);
    expect(JSON.stringify(requests[1])).not.toContain('codeword.txt');
  });

  it('sends the staleness note with the request and never as a message of the conversation', async () => {
    const { fetchFn, requests } = provider(['fail', { content: 'It is heron.' }, { content: 'Still heron.' }]);
    const backend = backendOn(fetchFn);
    backend.restore({ version: 3, backend: 'openai-compat', hostTurnState: 'complete', completedMessageCount: 3,
      messages: [SYSTEM, ask('The code word is heron.'), answer('Noted: heron.')] });
    expect(backend.takeRestoreReport()).toBeUndefined();

    // The first request after the restore fails at the provider.
    await runOneTurn(backend, 'What is the code word?');
    const first = requests[0].messages;
    // The note is the request's last message, as host context: not one of the person's messages.
    expect(first.at(-1)).toMatchObject({ role: 'system' });
    expect(String(first.at(-1)!.content).startsWith(NOTE_MARK)).toBe(true);
    expect(String(first.at(-1)!.content)).toMatch(/re-read the file/);
    expect(first.filter((message) => message.role === 'user' && String(message.content).includes(NOTE_MARK))).toEqual([]);
    expect(userTexts(first)).toEqual(['The code word is heron.', 'What is the code word?']);
    expect(JSON.stringify(backend.snapshot())).not.toContain(NOTE_MARK);

    // The model has not answered with the note before it yet, so the next request carries it again.
    await runOneTurn(backend, 'What is the code word?');
    expect(String(requests[1].messages.at(-1)!.content).startsWith(NOTE_MARK)).toBe(true);
    expect(JSON.stringify(backend.snapshot())).not.toContain(NOTE_MARK);

    // Once it has, the note is not repeated.
    await runOneTurn(backend, 'And once more?');
    expect(JSON.stringify(requests[2])).not.toContain(NOTE_MARK);
    expect(JSON.stringify(backend.snapshot())).not.toContain(NOTE_MARK);
  });

  it('leaves out only the turn that a snapshot taken during its tool loop had not seen answered', async () => {
    const running: { backend?: OpenAICompatBackend } = {};
    let duringToolLoop: ConversationSnapshot | undefined;
    // The first turn is answered. The second asks for a tool; the provider fails once it has the tool's result.
    const before = provider((index) => {
      if (index === 0) return { content: 'Noted: heron.' };
      if (index === 1) return { content: null, tool_calls: [readCall('call-1')] };
      duringToolLoop = running.backend!.snapshot();
      return 'fail';
    });
    const backend = running.backend = backendOn(before.fetchFn, { allowedTools: ['read'] });
    await runOneTurn(backend, 'The code word is heron.');
    await runOneTurn(backend, OLD_TASK);

    // The record holds the turn in flight, and the boundary stands where it stood before that turn began.
    expect(rolesOf(duringToolLoop!.messages)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'tool']);
    expect(duringToolLoop!.completedMessageCount).toBe(3);
    // The turn ended in the provider's failure: it has its terminal outcome and still no answer.
    expect(backend.snapshot().completedMessageCount).toBe(3);
    expect(backend.snapshot().messages).toHaveLength(6);

    // The host was gone in the middle of that loop: the stored record says a request was with the backend.
    const after = provider([{ content: 'No off-by-one error found.' }]);
    const restored = backendOn(after.fetchFn, { allowedTools: ['read'] });
    expect(restored.restore(storedAs(duringToolLoop!, 'incomplete'))).toBe(true);
    expect(restored.takeRestoreReport()).toEqual({
      notice: 'interrupted', reasons: ['host-turn-incomplete', 'unfinished-tail'], quarantinedMessages: 3, restoredMessages: 3,
    });
    await runOneTurn(restored, NEW_TASK);

    const sent = after.requests[0].messages;
    expect(userTexts(sent)).toEqual(['The code word is heron.', NEW_TASK]);
    // Nothing of the unfinished loop: no call, no result, and no result made up for a call that was cut off.
    expect(sent.some((message) => message.role === 'tool' || message.tool_calls !== undefined)).toBe(false);
    expect(JSON.stringify(sent)).not.toContain('tool call interrupted');
    expect(JSON.stringify(sent)).not.toContain('codeword.txt');
    expect(rolesOf(restored.snapshot().quarantined!.messages)).toEqual(['user', 'assistant', 'tool']);
  });

  it('leaves out a turn the XML protocol had not seen answered, as the backend itself stores it', async () => {
    const before = provider((index) => {
      if (index === 0) return { content: 'Noted: heron.' };
      if (index === 1) return { content: XML_CALL };
      return 'fail';
    });
    const backend = backendOn(before.fetchFn, { allowedTools: ['read'], toolProtocol: 'xml' });
    await runOneTurn(backend, 'The code word is heron.');
    await runOneTurn(backend, OLD_TASK);

    // The call is text of an assistant turn and its result a user message: no field says that either is a tool's.
    const saved = backend.snapshot();
    expect(rolesOf(saved.messages)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(String((saved.messages[5] as ChatMessage).content).startsWith('[Tool result: read_file]')).toBe(true);
    expect(saved.completedMessageCount).toBe(3);

    // With its boundary, and as a record from before the boundary existed: the same three messages are continued.
    for (const stored of [storedAs(saved, 'complete'), { version: 2, backend: 'openai-compat', messages: structuredClone(saved.messages) }] as ConversationSnapshot[]) {
      const after = provider([{ content: 'No off-by-one error found.' }]);
      const restored = backendOn(after.fetchFn, { allowedTools: ['read'], toolProtocol: 'xml' });
      expect(restored.restore(stored)).toBe(true);
      expect(restored.takeRestoreReport()).toMatchObject({ quarantinedMessages: 3, restoredMessages: 3 });
      await runOneTurn(restored, NEW_TASK);
      expect(userTexts(after.requests[0].messages)).toEqual(['The code word is heron.', NEW_TASK]);
      expect(JSON.stringify(after.requests[0].messages)).not.toContain('codeword.txt');
      expect(JSON.stringify(after.requests[0].messages)).not.toContain('[Tool result:');
    }
  });

  it.each([
    ['a task alone', [ask(OLD_TASK)]],
    ['a task and a call that was never run', [ask(OLD_TASK), callsFor('c9')]],
    ['a task, its call and the result', [ask(OLD_TASK), callsFor('c9'), resultOf('c9')]],
    ['a task and an empty reply', [ask(OLD_TASK), answer('')]],
    ['a task, a result and a further call', [ask(OLD_TASK), callsFor('c8'), resultOf('c8'), callsFor('c9')]],
    ['two tasks, neither answered', [ask('Count the lines of README.md.'), ask(OLD_TASK)]],
    // Under the XML protocol a call is text of the assistant turn, and its result a user message the host frames.
    ['a task, an XML call and its result', [ask(OLD_TASK), answer(XML_CALL), ask(XML_RESULT)]],
    ['a task and two steps of an XML tool loop', [ask(OLD_TASK), answer(XML_CALL), ask(XML_RESULT), answer(XML_CALL), ask(XML_RESULT)]],
  ] as Array<[string, ChatMessage[]]>)('leaves out a record\'s end that is %s, in a version 1 and a version 2 record', async (_what, tail) => {
    for (const version of [1, 2] as const) {
      const { fetchFn, requests } = provider([{ content: 'No off-by-one error found.' }]);
      const backend = backendOn(fetchFn, { allowedTools: ['read'] });
      expect(backend.restore({ version, messages: [SYSTEM, ask('The code word is heron.'), answer('Noted: heron.'), ...structuredClone(tail)] })).toBe(true);
      expect(backend.takeRestoreReport()).toEqual({
        notice: 'unanswered', reasons: ['legacy-unfinished-tail'], quarantinedMessages: tail.length, restoredMessages: 3,
      });
      await runOneTurn(backend, NEW_TASK);
      expect(userTexts(requests[0].messages)).toEqual(['The code word is heron.', NEW_TASK]);
      expect(requests[0].messages.some((message) => message.role === 'tool' || message.tool_calls !== undefined)).toBe(false);
      expect(backend.snapshot().quarantined?.messageCount).toBe(tail.length);
    }
  });

  it('repairs a call left without a result in an answered exchange, and brings nothing back from the end it left out', async () => {
    const { fetchFn, requests } = provider([{ content: 'No off-by-one error found.' }]);
    const backend = backendOn(fetchFn, { allowedTools: ['read'] });
    backend.restore({ version: 2, messages: [
      // An answered exchange in which one call never got its result.
      SYSTEM, ask('Read the code word.'), callsFor('c1'), answer('I could not read it.'),
      // And the end of the record: a request whose call was never answered.
      ask(OLD_TASK), callsFor('c2'),
    ] });
    await runOneTurn(backend, NEW_TASK);

    const sent = requests[0].messages;
    // The repair gave the call in the answered exchange a result, as it always did.
    const repaired = sent.filter((message) => message.role === 'tool');
    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toMatchObject({ tool_call_id: 'c1' });
    // It made no result for the call that was left out, and that request is not in the history.
    expect(JSON.stringify(sent)).not.toContain('c2');
    expect(userTexts(sent)).toEqual(['Read the code word.', NEW_TASK]);
  });
});

describe('where a stored conversation stops being complete', () => {
  it('counts the messages up to the last answer, and none of what follows it', () => {
    expect(completedExchangeCount([])).toBe(0);
    expect(completedExchangeCount([SYSTEM])).toBe(1);
    expect(completedExchangeCount([SYSTEM, ask('a')])).toBe(1);
    expect(completedExchangeCount([SYSTEM, ask('a'), answer('b')])).toBe(3);
    expect(completedExchangeCount([SYSTEM, ask('a'), answer('b'), ask('c')])).toBe(3);
    expect(completedExchangeCount([SYSTEM, ask('a'), callsFor('c1'), resultOf('c1')])).toBe(1);
    expect(completedExchangeCount([SYSTEM, ask('a'), callsFor('c1'), resultOf('c1'), answer('b')])).toBe(5);
    // An earlier request without an answer of its own was followed by one that got an answer.
    expect(completedExchangeCount([SYSTEM, ask('a'), ask('b'), answer('c')])).toBe(4);
    // An empty reply, a reply of blanks and a turn that only calls a tool answer nothing.
    expect(completedExchangeCount([ask('a'), answer('')])).toBe(0);
    expect(completedExchangeCount([ask('a'), answer('  \n')])).toBe(0);
    expect(completedExchangeCount([ask('a'), { role: 'assistant', content: 'Let me read it.', tool_calls: [readCall('c1')] }])).toBe(0);
    expect(completedExchangeCount([ask('a'), { role: 'assistant', content: [{ type: 'text', text: 'b' }] }])).toBe(2);
    // A system message is no part of an exchange: it stays on the answered side.
    expect(completedExchangeCount([SYSTEM, ask('a'), answer('b'), SYSTEM, ask('c')])).toBe(4);
    expect(completedExchangeCount([SYSTEM, SYSTEM, ask('c')])).toBe(2);
    // A tool result with no request before it is no answer either.
    expect(completedExchangeCount([SYSTEM, resultOf('c1')])).toBe(1);
    // An assistant turn that a tool result follows asked for that tool: it is a step of a loop, not an answer.
    const framed = ask(XML_RESULT);
    expect(completedExchangeCount([SYSTEM, ask('a'), answer('<read_file><path>a</path></read_file>'), framed])).toBe(1);
    expect(completedExchangeCount([SYSTEM, ask('a'), answer('b'), resultOf('c1')])).toBe(1);
    expect(completedExchangeCount([SYSTEM, ask('a'), answer('<read_file><path>a</path></read_file>'), framed, answer('It says heron.')])).toBe(5);
    // A system message between the turn and its result changes nothing about that.
    expect(completedExchangeCount([SYSTEM, ask('a'), answer('<read_file><path>a</path></read_file>'), SYSTEM, framed])).toBe(1);
    // An assistant turn without text ends a tool loop: the model did the work and said nothing more. After the
    // request itself the same empty turn is a response that never came.
    expect(completedExchangeCount([SYSTEM, ask('a'), callsFor('c1'), resultOf('c1'), answer('')])).toBe(5);
    expect(completedExchangeCount([SYSTEM, ask('a'), answer(XML_CALL), framed, answer('')])).toBe(5);
    expect(completedExchangeCount([SYSTEM, ask('a'), callsFor('c1'), resultOf('c1'), SYSTEM, answer('')])).toBe(6);
    expect(completedExchangeCount([SYSTEM, ask('a'), answer('')])).toBe(1);
    expect(completedExchangeCount([SYSTEM, answer('')])).toBe(1);
    expect(completedExchangeCount([SYSTEM, ask('a'), callsFor('c1'), resultOf('c1'), answer(''), ask('b'), answer('')])).toBe(5);
    // A request the person wrote after an answer is a request, and the answer before it stands.
    expect(completedExchangeCount([SYSTEM, ask('a'), answer('b'), ask('Tool result: none yet?')])).toBe(3);
  });

  const record = [SYSTEM, ask('The code word is heron.'), answer('Noted: heron.'), ask(OLD_TASK), answer('It is heron.')];
  const restoredWith = (completedMessageCount: unknown, messages: ChatMessage[] = record) => {
    const backend = backendOn();
    expect(backend.restore({
      version: 3, backend: 'openai-compat', hostTurnState: 'complete', messages: structuredClone(messages), completedMessageCount,
    } as ConversationSnapshot)).toBe(true);
    return { messages: backend.snapshot().messages, report: backend.takeRestoreReport() };
  };

  it('follows the stored boundary exactly: one message more or less changes what is restored', () => {
    // The whole record is complete.
    expect(restoredWith(5)).toEqual({ messages: record, report: undefined });
    // The host never saw the second turn end. That its messages read like an answered exchange changes nothing.
    expect(restoredWith(3)).toEqual({
      messages: record.slice(0, 3),
      report: { notice: 'unanswered', reasons: ['unfinished-tail'], quarantinedMessages: 2, restoredMessages: 3 },
    });
    expect(restoredWith(1)).toEqual({
      messages: record.slice(0, 1),
      report: { notice: 'unanswered', reasons: ['unfinished-tail'], quarantinedMessages: 4, restoredMessages: 1 },
    });
    expect(restoredWith(0).messages).toEqual([]);
  });

  it('does not follow a boundary that is not at the end of an answered request, and never moves one forward', () => {
    // After the second request and before its answer: the request is not complete.
    expect(restoredWith(4)).toEqual({
      messages: record.slice(0, 3),
      report: { notice: 'unanswered', reasons: ['unfinished-tail', 'boundary-invalid'], quarantinedMessages: 2, restoredMessages: 3 },
    });
    expect(restoredWith(2)).toEqual({
      messages: record.slice(0, 1),
      report: { notice: 'unanswered', reasons: ['unfinished-tail', 'boundary-invalid'], quarantinedMessages: 4, restoredMessages: 1 },
    });
  });

  it.each([-1, 2.5, 5, '3', null, undefined, Number.NaN])('reads a record whose boundary is %s by its structure', (bad) => {
    // Four messages, so 5 is past the end. The answered exchange is kept and the request after it is not.
    const unanswered = record.slice(0, 4);
    expect(restoredWith(bad, unanswered)).toEqual({
      messages: record.slice(0, 3),
      report: { notice: 'unanswered', reasons: ['unfinished-tail', 'boundary-invalid'], quarantinedMessages: 1, restoredMessages: 3 },
    });
  });

  it('takes a message of a version 3 record that begins like the staleness note for what it is: a message', () => {
    // Only a record from before version 3 holds notes as messages. In a version 3 record such a message is the
    // person's own, and the boundary counts it like any other.
    const quoted = ask(`${NOTE_MARK} is what the agent said after the reload. Why?`);
    const messages = [SYSTEM, quoted, answer('It warns that files may have changed.'), ask(OLD_TASK)];
    const backend = backendOn();
    backend.restore({ version: 3, backend: 'openai-compat', hostTurnState: 'complete', messages: structuredClone(messages), completedMessageCount: 3 });
    expect(backend.snapshot().messages).toEqual(messages.slice(0, 3));
    expect(backend.takeRestoreReport()).toEqual({
      notice: 'unanswered', reasons: ['unfinished-tail'], quarantinedMessages: 1, restoredMessages: 3,
    });
    // In a record from before version 3 the same message is a stored note, and is left out as one.
    const legacy = backendOn();
    legacy.restore({ version: 2, messages: structuredClone(messages) });
    expect(legacy.snapshot().messages).not.toContainEqual(quoted);
  });

  it('changes nothing when it refuses a record, and replaces an earlier report when it takes one', () => {
    const backend = backendOn();
    backend.restore({ version: 2, messages: record.slice(0, 4) });
    // A refused record changes nothing in the backend: what the earlier restore left out is still to be said.
    expect(backend.restore({ version: 3, backend: 'codex', hostTurnState: 'complete', messages: [] })).toBe(false);
    expect(backend.restore({ version: 3, backend: 'openai-compat', hostTurnState: 'complete', messages: [{ codexThreadId: 'thread-7f3a' }] })).toBe(false);
    expect(backend.snapshot().messages).toEqual(record.slice(0, 3));
    expect(backend.snapshot().quarantined).toEqual({ reasons: ['legacy-unfinished-tail'], messageCount: 1, messages: [ask(OLD_TASK)] });
    expect(backend.takeRestoreReport()).toMatchObject({ reasons: ['legacy-unfinished-tail'], quarantinedMessages: 1 });

    backend.restore({ version: 2, messages: record.slice(0, 4) });
    expect(backend.restore({ version: 3, backend: 'openai-compat', hostTurnState: 'complete', messages: record, completedMessageCount: 5 })).toBe(true);
    expect(backend.takeRestoreReport()).toBeUndefined();
    expect(backend.snapshot()).not.toHaveProperty('quarantined');
  });

  it('reads the host marker: only `complete` says the last request was seen to its end', () => {
    const marked = (hostTurnState: unknown) => {
      const backend = backendOn();
      expect(backend.restore({
        version: 3, backend: 'openai-compat', messages: structuredClone(record), completedMessageCount: 5,
        ...(hostTurnState === undefined ? {} : { hostTurnState }),
      } as ConversationSnapshot)).toBe(true);
      return { messages: backend.snapshot().messages, report: backend.takeRestoreReport() };
    };
    expect(marked('complete')).toEqual({ messages: record, report: undefined });
    // The record itself is complete: the request that was cut off had not reached it. The person is still told.
    for (const state of ['incomplete', undefined, 'done', true]) {
      expect(marked(state)).toEqual({
        messages: record,
        report: { notice: 'interrupted', reasons: ['host-turn-incomplete'], quarantinedMessages: 0, restoredMessages: 5 },
      });
    }
  });
});

describe('the boundary an OpenAI-compatible backend writes', () => {
  it('moves it when a turn ends with an answer, and not when a turn starts, fails or ends on an empty reply', async () => {
    const running: { backend?: OpenAICompatBackend } = {};
    const atRequest: Array<number | undefined> = [];
    const { fetchFn, requests } = provider((index) => {
      atRequest.push(running.backend!.snapshot().completedMessageCount);
      return ([{ content: 'Noted: heron.' }, 'fail', { content: '' }, { content: '' }, { content: 'It is heron.' }] as Step[])[index];
    });
    const backend = running.backend = backendOn(fetchFn);
    expect(backend.snapshot()).toMatchObject({ version: 3, completedMessageCount: 0, messages: [] });
    // The backend writes no marker: the session does.
    expect(backend.snapshot()).not.toHaveProperty('hostTurnState');

    await runOneTurn(backend, 'The code word is heron.');
    // While the request was out the boundary stood before it: the system message only.
    expect(atRequest[0]).toBe(1);
    expect(backend.snapshot()).toMatchObject({ completedMessageCount: 3 });
    expect(backend.snapshot().messages).toHaveLength(3);

    // A turn the provider fails has its terminal outcome and no answer.
    const failed = await runOneTurn(backend, OLD_TASK);
    expect(failed.at(-1)).toMatchObject({ kind: 'turn_complete', result: { isError: true } });
    expect(atRequest[1]).toBe(3);
    expect(backend.snapshot()).toMatchObject({ completedMessageCount: 3 });
    expect(backend.snapshot().messages).toHaveLength(4);

    // A turn that ends on an empty reply has no answer either. The empty response is asked for once more.
    const empty = await runOneTurn(backend, 'Count the lines of README.md.');
    expect(empty.at(-1)).toMatchObject({ kind: 'turn_complete', result: { responseOutcome: { kind: 'empty-reply' } } });
    expect(backend.snapshot()).toMatchObject({ completedMessageCount: 3 });

    // The next request gets an answer, so the record is complete to its end: the requests before it that got
    // none are no longer its end.
    await runOneTurn(backend, 'What is the code word?');
    expect(requests).toHaveLength(5);
    const saved = backend.snapshot();
    expect(saved.completedMessageCount).toBe(saved.messages.length);
    expect(saved.messages.at(-1)).toEqual(answer('It is heron.'));
  });

  it('counts a turn that ran its tools and ended without a word as answered, and keeps it through a restore', async () => {
    // The model calls a tool, gets the result, and returns nothing more. The empty response is asked for once more.
    const before = provider([{ content: null, tool_calls: [readCall('call-1')] }, { content: '' }, { content: '' }]);
    const backend = backendOn(before.fetchFn, { allowedTools: ['read'] });
    const events = await runOneTurn(backend, OLD_TASK);
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', result: { isError: false, responseOutcome: { kind: 'tool-only' } } });

    const saved = backend.snapshot();
    expect(rolesOf(saved.messages)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    expect(saved.completedMessageCount).toBe(5);

    // The work was done, so nothing of it is left out, and nobody is told that a request was interrupted.
    const after = provider([{ content: 'No off-by-one error found.' }]);
    const restored = backendOn(after.fetchFn, { allowedTools: ['read'] });
    expect(restored.restore(storedAs(saved, 'complete'))).toBe(true);
    expect(restored.takeRestoreReport()).toBeUndefined();
    expect(restored.snapshot().messages).toEqual(saved.messages);
    expect(restored.snapshot()).not.toHaveProperty('quarantined');
    // A record from before the boundary that ends the same way is read the same way.
    const legacy = backendOn();
    expect(legacy.restore({ version: 2, backend: 'openai-compat', messages: structuredClone(saved.messages) })).toBe(true);
    expect(legacy.takeRestoreReport()).toBeUndefined();
    expect(legacy.snapshot().messages).toEqual(saved.messages);
  });

  it('keeps the boundary with the answered part when the record gives up its oldest turns', async () => {
    // Two system messages and 999 answered exchanges: the record is at its limit of 2,000 messages.
    const full: ChatMessage[] = [SYSTEM, { role: 'system', content: 'Second.' }];
    for (let turn = 0; turn < 999; turn++) full.push(ask(`task ${turn}`), answer(`done ${turn}`));
    const backend = backendOn(provider(['fail']).fetchFn);
    backend.restore({ version: 3, backend: 'openai-compat', hostTurnState: 'complete', messages: full, completedMessageCount: full.length });

    await runOneTurn(backend, OLD_TASK);

    // The failed request pushed the record over its limit, and the oldest exchange went. The boundary went with
    // the answered part: it still stands right before the request without an answer.
    const saved = backend.snapshot();
    expect(saved.messages).toHaveLength(1999);
    expect(saved.messages[2]).toEqual(ask('task 1'));
    expect(saved.completedMessageCount).toBe(1998);
    expect(saved.messages[1998]).toEqual(ask(OLD_TASK));

    const restored = backendOn();
    restored.restore(storedAs(saved, 'complete'));
    expect(restored.takeRestoreReport()).toMatchObject({ reasons: ['unfinished-tail'], quarantinedMessages: 1, restoredMessages: 1998 });
  });

  it('counts down the unanswered requests the record itself gives up', async () => {
    // Three requests of three mebibytes each, none answered: together they pass the record's 8 MiB bound.
    const backend = backendOn(provider(['fail']).fetchFn);
    backend.restore({ version: 3, backend: 'openai-compat', hostTurnState: 'complete', messages: [SYSTEM], completedMessageCount: 1 });
    const big = (name: string) => `${name} ${'x'.repeat(3 * 1024 * 1024)}`;
    for (const name of ['first', 'second', 'third']) await runOneTurn(backend, big(name));

    const saved = backend.snapshot();
    expect(saved.messages.map((message) => String((message as ChatMessage).content).slice(0, 6))).toEqual(['Be ter', 'second', 'third ']);
    expect(saved.completedMessageCount).toBe(1);
  });
});

describe('a record from before the boundary is migrated the same way every time', () => {
  const summary: ChatMessage = { role: 'system', content: renderRollingSummary('Earlier: the code word was agreed.') };
  const note = ask(`${NOTE_MARK} The conversation above is from an earlier session.`);
  const answered = [SYSTEM, ask('The code word is heron.'), answer('Noted: heron.')];

  it.each([
    ['a version 1 record that ends on an answer', { version: 1, messages: answered }],
    ['a version 2 record that ends on a request', { version: 2, backend: 'openai-compat', messages: [...answered, ask(OLD_TASK)] }],
    ['a record that holds staleness notes as messages', { version: 2, messages: [SYSTEM, ask('The code word is heron.'), note, answer('Noted: heron.'), note] }],
    ['a record whose end is a staleness note after a request', { version: 2, messages: [...answered, ask(OLD_TASK), note] }],
    ['a record cut off in a tool loop', { version: 2, messages: [...answered, ask(OLD_TASK), callsFor('c1'), resultOf('c1')] }],
    ['a compacted record', {
      version: 2, backend: 'openai-compat', messages: [...answered, ask(OLD_TASK)],
      providerHistory: [SYSTEM, summary, ask('The code word is heron.'), answer('Noted: heron.'), ask(OLD_TASK)],
      usageBaseline: { routes: [{ route: 'https://gateway.example/v1|deepseek-chat', semantics: 'exclusive' }] },
    }],
    ['a record with no message but the system prompt', { version: 2, messages: [SYSTEM] }],
    ['an empty record', { version: 1, messages: [] }],
  ] as Array<[string, ConversationSnapshot]>)('migrates %s to the same version 3 record each time, and leaves that record as it is', (_what, legacy) => {
    const migrate = (snapshot: ConversationSnapshot) => {
      const backend = backendOn();
      expect(backend.restore(snapshot)).toBe(true);
      return { saved: backend.snapshot(), report: backend.takeRestoreReport() };
    };
    const original = structuredClone(legacy);
    const once = migrate(legacy);
    // The stored value itself is not changed by reading it.
    expect(legacy).toEqual(original);
    // Deterministic: the same record gives the same result.
    expect(migrate(structuredClone(original))).toEqual(once);

    expect(once.saved.version).toBe(3);
    expect(once.saved.backend).toBe('openai-compat');
    expect(once.saved.completedMessageCount).toBe(once.saved.messages.length);
    expect(JSON.stringify(once.saved.messages)).not.toContain(NOTE_MARK);
    expect(JSON.stringify(once.saved.messages)).not.toContain('codeword.txt');

    // Idempotent: the migrated record, stored and read again, is the same record, with nothing left to say.
    const twice = migrate(storedAs(once.saved, 'complete'));
    expect(twice.saved).toEqual(once.saved);
    expect(twice.report).toBeUndefined();
    expect(migrate(storedAs(twice.saved, 'complete')).saved).toEqual(once.saved);
  });

  it('says once what a migration left out, and keeps it as evidence through the next restore', () => {
    const backend = backendOn();
    backend.restore({ version: 2, messages: [...answered, ask(OLD_TASK), note] });
    expect(backend.takeRestoreReport()).toEqual({
      notice: 'unanswered', reasons: ['legacy-unfinished-tail'], quarantinedMessages: 1, restoredMessages: 3,
    });
    const migrated = backend.snapshot();
    expect(migrated.messages).toEqual(answered);
    expect(migrated.quarantined).toEqual({ reasons: ['legacy-unfinished-tail'], messageCount: 1, messages: [ask(OLD_TASK)] });

    const again = backendOn();
    again.restore(storedAs(migrated, 'complete'));
    expect(again.takeRestoreReport()).toBeUndefined();
    expect(again.snapshot().quarantined).toEqual(migrated.quarantined);
  });
});

describe('a compacted provider history ends where its own answered requests end', () => {
  const summary: ChatMessage = { role: 'system', content: renderRollingSummary('Earlier: the code word was agreed to be heron.') };
  const kept = [ask('Is it still heron?'), answer('Yes, heron.')];
  const record = [SYSTEM, ask('The code word is heron.'), answer('Noted: heron.'), ...kept];
  const compacted = [SYSTEM, summary, ...kept];

  it('cuts the compacted history of a record from before the boundary at its last answer', async () => {
    const { fetchFn, requests } = provider([{ content: 'No off-by-one error found.' }]);
    const backend = backendOn(fetchFn);
    backend.restore({ version: 2, backend: 'openai-compat', messages: [...record, ask(OLD_TASK)], providerHistory: [...compacted, ask(OLD_TASK)] });

    // The next request continues from the compacted history, without the request that was never answered.
    expect(historyOf(backend)).toEqual(compacted);
    await runOneTurn(backend, NEW_TASK);
    expect(requests[0].messages.slice(0, 5)).toEqual([...compacted, ask(NEW_TASK)]);
    expect(JSON.stringify(requests)).not.toContain('codeword.txt');

    const saved = backend.snapshot();
    expect(JSON.stringify(saved.providerHistory)).not.toContain('codeword.txt');
    expect(saved.providerCompletedMessageCount).toBe(saved.providerHistory!.length);
    expect(saved.providerHistory![1]).toEqual(summary);
  });

  it('follows the boundary a version 3 record names for its compacted history', () => {
    const unseen = [ask(OLD_TASK), answer('It is heron.')];
    const restoredWith = (providerCompletedMessageCount: unknown) => {
      const backend = backendOn();
      expect(backend.restore({
        version: 3, backend: 'openai-compat', hostTurnState: 'complete',
        messages: [...record, ...unseen], completedMessageCount: record.length,
        providerHistory: [...compacted, ...unseen], providerCompletedMessageCount,
      } as ConversationSnapshot)).toBe(true);
      return historyOf(backend);
    };
    expect(restoredWith(4)).toEqual(compacted);
    // One message further is inside an exchange, and is not followed.
    expect(restoredWith(5)).toEqual(compacted);
    // With none of it complete the request history is built from the record's answered part instead.
    expect(restoredWith(0)).toEqual(record);
    // A boundary that is missing leaves the history to be read by its structure.
    expect(restoredWith(undefined)).toEqual([...compacted, ...unseen]);
    expect(restoredWith(99)).toEqual([...compacted, ...unseen]);
  });

  it('writes the boundary of a compacted history, so a failed request does not come back through it', async () => {
    const before = provider(['fail']);
    const backend = backendOn(before.fetchFn);
    backend.restore({
      version: 3, backend: 'openai-compat', hostTurnState: 'complete', messages: record, completedMessageCount: record.length,
      providerHistory: compacted, providerCompletedMessageCount: compacted.length,
    });
    await runOneTurn(backend, OLD_TASK);

    const saved = backend.snapshot();
    // Both lists hold the failed request, each behind its own boundary.
    expect(saved.messages.at(-1)).toEqual(ask(OLD_TASK));
    expect(saved.completedMessageCount).toBe(record.length);
    expect(saved.providerHistory!.at(-1)).toEqual(ask(OLD_TASK));
    expect(saved.providerCompletedMessageCount).toBe(compacted.length);

    const after = provider([{ content: 'No off-by-one error found.' }]);
    const restored = backendOn(after.fetchFn);
    restored.restore(storedAs(saved, 'complete'));
    expect(historyOf(restored)).toEqual(compacted);
    await runOneTurn(restored, NEW_TASK);
    expect(userTexts(after.requests[0].messages)).toEqual(['Is it still heron?', NEW_TASK]);
    expect(JSON.stringify(after.requests)).not.toContain('codeword.txt');
  });

  it('counts none of a compacted history as complete once a repair has rebuilt the request that is open in it', async () => {
    const backend = backendOn(provider(['fail']).fetchFn);
    backend.restore({
      version: 3, backend: 'openai-compat', hostTurnState: 'complete', messages: record, completedMessageCount: record.length,
      providerHistory: compacted, providerCompletedMessageCount: compacted.length,
    });
    await runOneTurn(backend, OLD_TASK);
    // A repair that rebuilds the history replaces every message by a copy; the open request can no longer be found.
    (backend as unknown as { history: ChatMessage[] }).history = historyOf(backend).map((message) => ({ ...message }));

    const saved = backend.snapshot();
    expect(saved.providerCompletedMessageCount).toBe(0);
    const restored = backendOn();
    restored.restore(storedAs(saved, 'complete'));
    // Built from the record's answered part: the uncompacted conversation, and not the failed request.
    expect(historyOf(restored)).toEqual(record);
  });
});

describe('what a restore keeps as evidence is bounded', () => {
  const answered = [SYSTEM, ask('The code word is heron.'), answer('Noted: heron.')];

  it('keeps the first messages of a long tail and says how many there were', () => {
    const tail: ChatMessage[] = [ask(OLD_TASK)];
    for (let step = 0; step < 40; step++) tail.push(callsFor(`c${step}`), resultOf(`c${step}`));
    const backend = backendOn();
    backend.restore({ version: 2, messages: [...answered, ...tail] });

    const evidence = backend.snapshot().quarantined!;
    expect(tail).toHaveLength(81);
    expect(evidence.messageCount).toBe(81);
    expect(evidence.messages).toHaveLength(MAX_QUARANTINED_MESSAGES);
    expect(evidence.messages).toEqual(tail.slice(0, MAX_QUARANTINED_MESSAGES));
    expect(backend.takeRestoreReport()).toMatchObject({ quarantinedMessages: 81 });
  });

  it('keeps no more bytes than its bound, and no image', () => {
    const large = 'x'.repeat(100 * 1024);
    const withImage: ChatMessage = { role: 'user', content: [
      { type: 'text', text: OLD_TASK }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ] };
    const backend = backendOn();
    backend.restore({ version: 2, messages: [...answered, withImage, ask(large), ask(large), ask(large)] });

    const evidence = backend.snapshot().quarantined!;
    expect(evidence.messageCount).toBe(4);
    // The request and two of the three large messages fit; the third would pass the bound.
    expect(evidence.messages).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(evidence.messages), 'utf8')).toBeLessThanOrEqual(MAX_QUARANTINED_BYTES);
    expect(JSON.stringify(evidence)).not.toContain('image_url');
    expect(evidence.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: OLD_TASK }, { type: 'text', text: '[1 image(s) not kept]' }] });
  });

  it.each([
    ['is not an object', 'tail'],
    ['holds an entry that is not a message', { reasons: ['unfinished-tail'], messageCount: 1, messages: [{ codexThreadId: 'thread-7f3a' }] }],
    ['names a reason that is none', { reasons: ['because'], messageCount: 1, messages: [ask(OLD_TASK)] }],
    ['counts fewer messages than it holds', { reasons: ['unfinished-tail'], messageCount: 0, messages: [ask(OLD_TASK)] }],
    ['holds more messages than the bound', { reasons: ['unfinished-tail'], messageCount: 60, messages: Array.from({ length: 51 }, () => ask('a')) }],
    ['holds more bytes than the bound', { reasons: ['unfinished-tail'], messageCount: 1, messages: [ask('x'.repeat(MAX_QUARANTINED_BYTES))] }],
  ] as Array<[string, unknown]>)('drops stored evidence that %s, and restores the conversation all the same', (_what, quarantined) => {
    const backend = backendOn();
    expect(backend.restore({
      version: 3, backend: 'openai-compat', hostTurnState: 'complete', messages: answered, completedMessageCount: 3, quarantined,
    } as ConversationSnapshot)).toBe(true);
    expect(backend.snapshot().messages).toEqual(answered);
    expect(backend.snapshot()).not.toHaveProperty('quarantined');
  });
});
