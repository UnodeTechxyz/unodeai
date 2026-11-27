import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatViewProvider, type ChatViewDeps } from '../../views/ChatViewProvider';
import { HistoryService } from '../HistoryService';
import { HistoryStore } from '../HistoryStore';
import { chatHistoryKey, CHAT_HISTORY_LIMIT, serializeChatHistory, type ChatHistoryMessage } from '../../views/chatHistory';

/**
 * v0.9.110 H0: the real chat view over the real history service and store. What the person sends and reads in the chat
 * reaches the canonical history; the 50-message chat key stays the window 0.9.109 reads, and what 0.9.109 writes into
 * it comes back.
 */
const WORKSPACE = 'd'.repeat(64);
let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-history-chat-'));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

class State {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, structuredClone(value));
  }
}

function window(state: State, options: { open?: () => Promise<HistoryStore | undefined>; notices?: string[] } = {}) {
  const sent: Array<{ text: string; historyId?: string }> = [];
  const history = new HistoryService({
    open: options.open ?? (() => HistoryStore.open({ directory: dir, workspaceId: WORKSPACE, writerId: randomUUID() })),
    state,
    onNotSaved: (agentId, reason) => options.notices?.push(`${agentId}: ${reason}`),
  });
  const deps = {
    listAgents: () => [{ id: 'dev', name: 'Dev', role: 'Developer', status: 'idle', backend: 'openai' }],
    send: (_agentId: string, text: string, _mode: unknown, _attachments: unknown, _epoch: unknown, task?: { historyId: string }) => {
      sent.push({ text, historyId: task?.historyId });
    },
    interject: vi.fn(), interrupt: vi.fn(), onReply: () => () => {},
    state,
    history,
    getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval: vi.fn(),
  } as unknown as ChatViewDeps;
  const provider = new ChatViewProvider({} as never, deps);
  provider.selectAgent('dev');
  const send = (text: string) => (provider as any).onMessage({ command: 'send', agentId: 'dev', requestId: randomUUID(), text, mode: 'act', attachments: [] }, 'sidebar');
  const reply = (text: string) => (provider as any).onReply({ from: 'dev', fromName: 'Dev', text, isError: false, completionState: 'complete' });
  return { provider, history, sent, send, reply };
}

/** What 0.9.109 writes into the key: its parser keeps no history id. */
function as109(messages: readonly ChatHistoryMessage[]): ChatHistoryMessage[] {
  return serializeChatHistory(messages.map(({ messageId: _id, ...rest }) => rest));
}

const at = (minute: number) => new Date(Date.UTC(2026, 10, 24, 9, minute)).toISOString();

describe('task history through the chat view', () => {
  it('keeps every message past the 50-message window, binds each request, survives Clear and reads 0.9.109 writes after a reload', async () => {
    const state = new State();
    await state.update(chatHistoryKey('dev'), [
      { role: 'user', text: 'Written by 0.9.109', ts: at(0), seq: 0 },
      { role: 'agent', text: 'Answered in 0.9.109', ts: at(1), seq: 1, turnFinal: true },
    ]);
    const a = window(state);
    for (let i = 0; i < 30; i++) {
      a.send(`request ${i}`);
      const task = a.sent.at(-1)!;
      expect(task.historyId).toMatch(/^[0-9a-f-]{36}$/);
      // The host admits it under its own request id.
      a.history.requestAdmitted('dev', task.historyId!, `request-id-${i}`);
      a.reply(`answer ${i}`);
    }
    await a.history.flush();
    await a.history.bridge.reconcile('dev');
    const store = (await a.history.store())!;
    await store.refresh();
    expect(store.messagesOf('dev').length).toBe(62);
    expect((state.get<unknown[]>(chatHistoryKey('dev')) ?? []).length).toBe(CHAT_HISTORY_LIMIT);
    const tasks = (await store.query({}, undefined)).tasks;
    expect(tasks).toHaveLength(31);
    expect(tasks[0]).toMatchObject({ goal: 'request 29', rootRequestId: 'request-id-29', legacy: false });
    expect(tasks.at(-1)).toMatchObject({ goal: 'Written by 0.9.109', legacy: true });
    expect(store.historyIdOfRequest('request-id-0')).toBe(a.sent[0].historyId);

    // Clear empties the window and the key; the history keeps the conversation, read-only.
    a.provider.clearSelectedAgent();
    await a.history.flush();
    expect(state.get(chatHistoryKey('dev'))).toBeUndefined();
    await store.refresh();
    expect(store.messagesOf('dev').length).toBe(62);
    a.provider.dispose();

    // A downgrade: 0.9.109, still holding its old view, writes it back with one message of its own.
    const stale = as109([{ role: 'user', text: 'Written by 0.9.109', ts: at(0), seq: 0 },
      { role: 'agent', text: 'Answered in 0.9.109', ts: at(1), seq: 1, turnFinal: true },
      { role: 'user', text: 'Typed in 0.9.109 after the downgrade', ts: at(59), seq: 2 }]);
    await state.update(chatHistoryKey('dev'), stale);

    // The next 0.9.110 start: a new window over the same storage.
    const b = window(state);
    expect(await b.history.bridge.reconcile('dev')).toMatch(/imported|replaced/);
    const reopened = (await b.history.store())!;
    await reopened.refresh();
    const texts = reopened.messagesOf('dev').map((entry) => entry.message.text);
    expect(texts.filter((text) => text === 'Typed in 0.9.109 after the downgrade')).toHaveLength(1);
    // The cleared conversation was not imported a second time.
    expect(texts.filter((text) => text === 'Written by 0.9.109')).toHaveLength(1);
    expect(texts).toHaveLength(63);
    b.provider.dispose();
  });

  it('records an import as a replaced view with new ids, so importing the same file twice keeps both', async () => {
    const state = new State();
    const a = window(state);
    a.send('before import');
    const imported: ChatHistoryMessage[] = [
      { role: 'user', text: 'Imported question', ts: at(2), messageId: 'from-the-file' },
      { role: 'agent', text: 'Imported answer', ts: at(3), turnFinal: true },
    ];
    expect(a.provider.importToSelected(imported)).toBe(true);
    expect(a.provider.importToSelected(imported)).toBe(true);
    await a.history.flush();
    const store = (await a.history.store())!;
    await store.refresh();
    const texts = store.messagesOf('dev').map((entry) => entry.message.text);
    expect(texts).toEqual(['before import', 'Imported question', 'Imported answer', 'Imported question', 'Imported answer']);
    expect(store.messagesOf('dev').some((entry) => entry.messageId === 'from-the-file')).toBe(false);
    a.provider.dispose();
  });

  it('keeps the conversation and tells the person once when the history cannot be saved', async () => {
    const state = new State();
    const notices: string[] = [];
    const a = window(state, { open: () => Promise.reject(new Error('storage is read-only')), notices });
    a.send('first');
    a.send('second');
    await a.history.flush();
    expect(notices).toHaveLength(1);
    expect((state.get<ChatHistoryMessage[]>(chatHistoryKey('dev')) ?? []).map((m) => m.text)).toEqual(['first', 'second']);
    a.provider.dispose();
  });
});
