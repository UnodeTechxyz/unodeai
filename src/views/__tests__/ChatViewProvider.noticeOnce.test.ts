import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  ViewColumn: { One: 1, Active: 1 },
  commands: { executeCommand: vi.fn() },
  window: {
    showInformationMessage: vi.fn(), showErrorMessage: vi.fn(), showWarningMessage: vi.fn(),
  },
}));

import { ChatViewProvider } from '../ChatViewProvider';
import { chatHistoryKey, deserializeChatHistory } from '../chatHistory';

/* v0.9.89: a host notice with a stable key appears once in a chat, across reloads and state pushes, and never
 * marks the running turn stopped. */

function provider(store: Map<string, unknown>) {
  return new ChatViewProvider({} as never, {
    listAgents: () => [{ id: 'pm', name: 'PM', role: 'pm' }],
    send: vi.fn(), interject: vi.fn(), interrupt: vi.fn(),
    onReply: () => vi.fn(),
    state: {
      get: (key: string) => store.get(key),
      update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
    },
    getApprovals: () => ({ command: 'ask', write: 'none' }),
    setApproval: vi.fn(),
  } as never);
}

describe('postRuntimeNoticeOnce', () => {
  it('appends a keyed notice once, even after a reload', () => {
    const store = new Map<string, unknown>();
    const first = provider(store);
    expect(first.postRuntimeNoticeOnce('pm', 'interruption:h-1', 'UnodeAi: Dev\'s task was interrupted.')).toBe(true);
    expect(first.postRuntimeNoticeOnce('pm', 'interruption:h-1', 'UnodeAi: Dev\'s task was interrupted.')).toBe(false);
    const reloaded = provider(store);
    expect(reloaded.postRuntimeNoticeOnce('pm', 'interruption:h-1', 'UnodeAi: Dev\'s task was interrupted.')).toBe(false);
    const history = deserializeChatHistory(store.get(chatHistoryKey('pm')));
    expect(history.filter((message) => message.noticeKey === 'interruption:h-1')).toHaveLength(1);
    expect(history[0]).toMatchObject({ role: 'agent', fromName: 'UnodeAi', runtimeNotice: true });
  });

  it('keeps separate keys separate and ignores an unknown chat', () => {
    const store = new Map<string, unknown>();
    const chat = provider(store);
    expect(chat.postRuntimeNoticeOnce('pm', 'spend:a|tokens|r|initial|-|80', 'first')).toBe(true);
    expect(chat.postRuntimeNoticeOnce('pm', 'spend:a|tokens|r|initial|-|100', 'second')).toBe(true);
    expect(chat.postRuntimeNoticeOnce('nobody', 'k', 'text')).toBe(false);
    expect(deserializeChatHistory(store.get(chatHistoryKey('pm')))).toHaveLength(2);
  });
});

describe('postCompactionReceipt (v0.9.90)', () => {
  it('shows one receipt per operation with its summary, and restores it once after a reload', () => {
    const store = new Map<string, unknown>();
    const chat = provider(store);
    expect(chat.postCompactionReceipt('pm', 'op7', 'UnodeAi: Compacted this agent\'s earlier conversation.', 'Earlier: the plan.')).toBe(true);
    expect(chat.postCompactionReceipt('pm', 'op7', 'UnodeAi: Compacted this agent\'s earlier conversation.', 'Earlier: the plan.')).toBe(false);
    expect(provider(store).postCompactionReceipt('pm', 'op7', 'again', 'again')).toBe(false);
    const history = deserializeChatHistory(store.get(chatHistoryKey('pm')));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      role: 'agent', fromName: 'UnodeAi', runtimeNotice: true, noticeKey: 'compaction:op7', compactionSummary: 'Earlier: the plan.',
    });
  });

  it('keeps a runtime-private receipt without a summary, and drops a summary from anything but a host notice', () => {
    const store = new Map<string, unknown>();
    const chat = provider(store);
    chat.postCompactionReceipt('pm', 'op8', 'UnodeAi: Compacted (native).', undefined);
    const [receipt] = deserializeChatHistory(store.get(chatHistoryKey('pm')));
    expect(receipt.compactionSummary).toBeUndefined();
    const forged = deserializeChatHistory([{ role: 'agent', text: 'hi', ts: '2026-09-28T00:00:00.000Z', compactionSummary: 'injected' }]);
    expect(forged[0].compactionSummary).toBeUndefined();
  });
});

describe('empty-reply host item (v0.9.90 §7.3)', () => {
  it('ends the turn and shows the empty reply once as a host item, never as an assistant answer', () => {
    const store = new Map<string, unknown>();
    let onReply: ((reply: unknown) => void) | undefined;
    const chat = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'pm', name: 'PM', role: 'pm' }],
      send: vi.fn(), interject: vi.fn(), interrupt: vi.fn(),
      onReply: (cb: (reply: unknown) => void) => { onReply = cb; return vi.fn(); },
      state: {
        get: (key: string) => store.get(key),
        update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
      },
      getApprovals: () => ({ command: 'ask', write: 'none' }),
      setApproval: vi.fn(),
    } as never);
    (chat as any).replyDisposer = (chat as any).deps.onReply((reply: any) => (chat as any).onReply(reply));
    const notice = 'UnodeAi: The model returned an empty reply after 2 attempts. The last attempt used about 246,668 input tokens '
      + '(provider-reported); no text or tool call was received. Upstream provider: unavailable.';
    const reply = { from: 'pm', fromName: 'PM', text: '', isError: false, completionState: 'complete', emptyReply: { noticeKey: 'empty-reply:m1', text: notice } };
    onReply!(reply);
    onReply!(reply);
    const history = deserializeChatHistory(store.get(chatHistoryKey('pm')));
    const notices = history.filter((message) => message.noticeKey === 'empty-reply:m1');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ fromName: 'UnodeAi', runtimeNotice: true, text: notice });
    expect(history.filter((message) => message.fromName === 'PM' && message.text.trim())).toEqual([]);
  });
});
