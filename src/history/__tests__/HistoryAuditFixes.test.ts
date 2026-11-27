import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatViewProvider, type ChatViewDeps } from '../../views/ChatViewProvider';
import { HistoryService } from '../HistoryService';
import { HistoryStore } from '../HistoryStore';
import { historyWorkspace } from '../HistoryWorkspaceIdentity';
import { bridgeStateKey } from '../LegacyChatProjectionBridge';
import { chatHistoryKey, serializeChatHistory, type ChatHistoryMessage } from '../../views/chatHistory';
import type { HistoryEventBody } from '../HistoryRecords';
import type { RequestCloseoutRecordV1 } from '../../observability/RequestCloseout';

/**
 * v0.9.110 H0, Codex's audit of fa0de878 (F1–F5): each finding's trigger, through the production entries.
 */
const WORKSPACE = 'f'.repeat(64);
let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-history-fix-'));
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

function openStore(options: { hardLinks?: boolean; compactAfter?: number } = {}): Promise<HistoryStore> {
  return HistoryStore.open({ directory: dir, workspaceId: WORKSPACE, writerId: randomUUID(), ...options });
}

function chatWindow(state: State, open: () => Promise<HistoryStore | undefined> = () => openStore()) {
  const history = new HistoryService({ open, state });
  const deps = {
    listAgents: () => [{ id: 'dev', name: 'Dev', role: 'Developer', status: 'idle', backend: 'openai' }],
    send: vi.fn(), interject: vi.fn(), interrupt: vi.fn(), onReply: () => () => {},
    state, history,
    getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval: vi.fn(),
  } as unknown as ChatViewDeps;
  const provider = new ChatViewProvider({} as never, deps);
  provider.selectAgent('dev');
  const send = (text: string) => (provider as any).onMessage({ command: 'send', agentId: 'dev', requestId: randomUUID(), text, mode: 'act', attachments: [] }, 'sidebar');
  return { provider, history, send, deps };
}

const at = (minute: number) => new Date(Date.UTC(2026, 10, 25, 11, minute)).toISOString();

/** What 0.9.109 writes: its parser keeps no history id. */
function as109(messages: readonly ChatHistoryMessage[]): ChatHistoryMessage[] {
  return serializeChatHistory(messages.map(({ messageId: _id, ...rest }) => rest));
}

async function canonicalTexts(window: ReturnType<typeof chatWindow>): Promise<string[]> {
  await window.history.flush();
  const store = (await window.history.store())!;
  await store.refresh();
  return store.messagesOf('dev').map((entry) => entry.message.text);
}

function transcriptMessage(text: string): HistoryEventBody {
  const messageId = randomUUID();
  return { kind: 'transcript-append', agentId: 'dev', viewGeneration: 'g', messageId,
    message: { role: 'user', text, ts: at(0), messageId }, startsTask: { historyId: `t-${messageId}` } };
}

describe('F1: another writer\'s event still being written', () => {
  it('waits for it instead of setting it aside, whatever this reader\'s own publishing, and keeps it through compaction', async () => {
    const writer = await openStore({ hardLinks: false });
    expect((await writer.append(transcriptMessage('first'))).status).toBe('durable');
    const file = path.join(dir, 'events', '000000000001.json');
    const whole = fs.readFileSync(file, 'utf8');
    // The writer has created the file and written half of it.
    fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));
    const reader = await openStore({ compactAfter: 1 });
    expect(reader.gaps).toEqual([]);
    expect(reader.messagesOf('dev')).toEqual([]);
    // The write completes; the reader sees the event in its place, and its own appends come after it.
    fs.writeFileSync(file, whole);
    await reader.refresh();
    expect(reader.messagesOf('dev').map((entry) => entry.message.text)).toEqual(['first']);
    expect((await reader.append(transcriptMessage('second'))).revision).toBe(2);
    await reader.append(transcriptMessage('third'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fresh = await openStore();
    expect(fresh.messagesOf('dev').map((entry) => entry.message.text)).toEqual(['first', 'second', 'third']);
    expect(fresh.gaps).toEqual([]);
  });

  it('heals a gap whose writer stalled past the grace, in revision order, and no snapshot removes it meanwhile', async () => {
    const writer = await openStore();
    await writer.append(transcriptMessage('stalled'));
    const file = path.join(dir, 'events', '000000000001.json');
    const whole = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, whole.slice(0, 20));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    const reader = await openStore({ compactAfter: 1 });
    expect(reader.gaps).toEqual([1]);
    await reader.append(transcriptMessage('after'));
    await reader.append(transcriptMessage('after 2'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The snapshot did not pass the gap that may still heal; its file is still there.
    expect(fs.existsSync(file)).toBe(true);
    fs.writeFileSync(file, whole);
    await reader.refresh();
    expect(reader.gaps).toEqual([]);
    expect(reader.messagesOf('dev').map((entry) => entry.message.text)).toEqual(['stalled', 'after', 'after 2']);
    const fresh = await openStore();
    expect(fresh.messagesOf('dev').map((entry) => entry.message.text)).toEqual(['stalled', 'after', 'after 2']);
  });
});

describe('F2: what another version added just before a write', () => {
  async function migratedWithLegacyAddition(state: State) {
    await state.update(chatHistoryKey('dev'), as109([{ role: 'user', text: 'own-first', ts: at(1) }]));
    const window = chatWindow(state);
    await window.history.flush();
    await window.history.bridge.reconcile('dev');
    // 0.9.109 appends to the key while this window is open, before any focus reconciliation.
    const current = state.get<ChatHistoryMessage[]>(chatHistoryKey('dev'))!;
    await state.update(chatHistoryKey('dev'), as109([...current, { role: 'user', text: 'legacy-observed', ts: at(2) }]));
    return window;
  }

  it('keeps it through a Send and through trimming the window', async () => {
    const state = new State();
    const window = await migratedWithLegacyAddition(state);
    window.send('own-second');
    for (let i = 0; i < 55; i++) window.send(`filler ${i}`);
    const canonical = await canonicalTexts(window);
    expect(canonical).toContain('legacy-observed');
    expect(canonical.filter((text) => text === 'legacy-observed')).toHaveLength(1);
    expect((state.get<ChatHistoryMessage[]>(chatHistoryKey('dev')) ?? []).some((m) => m.text === 'legacy-observed')).toBe(false);
    window.provider.dispose();
  });

  it('keeps it through a Clear, recorded before the clear', async () => {
    const state = new State();
    const window = await migratedWithLegacyAddition(state);
    window.provider.clearSelectedAgent();
    expect(await canonicalTexts(window)).toEqual(['own-first', 'legacy-observed']);
    expect(state.get(chatHistoryKey('dev'))).toBeUndefined();
    window.provider.dispose();
  });

  it('keeps the observation when its import fails, and imports it on the next reconciliation', async () => {
    const state = new State();
    let failImports = 0;
    const open = async () => {
      const store = await openStore();
      const append = store.append.bind(store);
      (store as any).append = (body: HistoryEventBody, options?: { eventId?: string }) => {
        if (body.kind === 'legacy-import' && body.reason === 'divergence' && failImports > 0) {
          failImports--;
          return Promise.resolve({ status: 'failed', reason: 'disk full' });
        }
        return append(body, options);
      };
      return store;
    };
    await state.update(chatHistoryKey('dev'), as109([{ role: 'user', text: 'own-first', ts: at(1) }]));
    const window = chatWindow(state, open);
    await window.history.flush();
    await window.history.bridge.reconcile('dev');
    const current = state.get<ChatHistoryMessage[]>(chatHistoryKey('dev'))!;
    await state.update(chatHistoryKey('dev'), as109([...current, { role: 'user', text: 'legacy-observed', ts: at(2) }]));
    failImports = 1;
    window.provider.clearSelectedAgent();
    await window.history.flush();
    expect(await canonicalTexts(window)).toEqual(['own-first']);
    expect(JSON.stringify(state.get(bridgeStateKey('dev')))).toContain('legacy-observed');
    expect(await window.history.bridge.reconcile('dev')).toBe('imported');
    expect(await canonicalTexts(window)).toEqual(['own-first', 'legacy-observed']);
    expect(JSON.stringify(state.get(bridgeStateKey('dev')))).not.toContain('legacy-observed');
    window.provider.dispose();
  });
});

describe('F3: a stale copy written back after Clear', () => {
  it('does not show the cleared conversation again; a really new message is shown and kept', async () => {
    const state = new State();
    const first = chatWindow(state);
    first.send('cleared-message');
    await first.history.flush();
    await first.history.bridge.reconcile('dev');
    const beforeClear = state.get<ChatHistoryMessage[]>(chatHistoryKey('dev'))!;
    first.provider.clearSelectedAgent();
    await first.history.flush();
    first.provider.dispose();
    // A 0.9.109 window still holding the old view writes it back, with one message of its own.
    await state.update(chatHistoryKey('dev'), as109([...beforeClear, { role: 'user', text: 'new-in-109', ts: at(30) }]));
    const reopened = chatWindow(state);
    expect(reopened.provider.exportSelected()!.messages.map((m) => m.text)).toEqual(['new-in-109']);
    reopened.send('after-clear');
    expect((state.get<ChatHistoryMessage[]>(chatHistoryKey('dev')) ?? []).map((m) => m.text)).toEqual(['new-in-109', 'after-clear']);
    const canonical = await canonicalTexts(reopened);
    expect(canonical.filter((text) => text === 'cleared-message')).toHaveLength(1);
    expect(canonical).toContain('new-in-109');
    reopened.provider.dispose();
  });
});

describe('re-audit of b63bce39', () => {
  it('F1: keeps a gap\'s file through compaction at any age, so an event completed a day later survives a fresh open', async () => {
    const writer = await openStore({ hardLinks: false });
    await writer.append(transcriptMessage('acknowledged'));
    const file = path.join(dir, 'events', '000000000001.json');
    const whole = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, whole.slice(0, 10));
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(file, longAgo, longAgo);
    const reader = await openStore({ compactAfter: 1 });
    expect(reader.gaps).toEqual([1]);
    for (let i = 0; i < 4; i++) await reader.append(transcriptMessage(`later ${i}`));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.readdirSync(path.join(dir, 'snapshots')).length).toBeGreaterThan(0);
    expect(fs.existsSync(file)).toBe(true);
    // The stalled writer completes its event after the snapshot passed its revision.
    fs.writeFileSync(file, whole);
    const fresh = await openStore();
    expect(fresh.messagesOf('dev').map((entry) => entry.message.text)).toEqual(['acknowledged', 'later 0', 'later 1', 'later 2', 'later 3']);
    expect(fresh.gaps).toEqual([]);
  });

  it('F2: keeps every observed message while imports fail, past any count, and imports the oldest once storage recovers', async () => {
    const state = new State();
    let failing = true;
    const open = async () => {
      const store = await openStore();
      const append = store.append.bind(store);
      (store as any).append = (body: HistoryEventBody, options?: { eventId?: string }) =>
        (failing && body.kind === 'legacy-import' && body.reason === 'divergence'
          ? Promise.resolve({ status: 'failed', reason: 'disk full' }) : append(body, options));
      return store;
    };
    await state.update(chatHistoryKey('dev'), as109([{ role: 'user', text: 'own-first', ts: at(0) }]));
    const window = chatWindow(state, open);
    await window.history.flush();
    await window.history.bridge.reconcile('dev');
    // Eleven 50-message snapshots from 0.9.109, each observed and then cleared away while imports fail.
    for (let round = 0; round < 11; round++) {
      const batch = Array.from({ length: 50 }, (_, i) => ({ role: 'user' as const, text: `legacy-${round}-${i}`, ts: at(1), seq: i }));
      await state.update(chatHistoryKey('dev'), as109(batch));
      window.provider.clearSelectedAgent();
      await window.history.flush();
    }
    failing = false;
    expect(await window.history.bridge.reconcile('dev')).toBe('imported');
    const fresh = await openStore();
    const texts = fresh.messagesOf('dev').map((entry) => entry.message.text);
    expect(texts).toContain('legacy-0-0');
    expect(texts).toContain('legacy-10-49');
    expect(texts.filter((text) => text.startsWith('legacy-'))).toHaveLength(550);
    window.provider.dispose();
  });

  it('F3: a read-only reopen does not adopt the stale copy; the second reopen and the next Send still leave it out', async () => {
    const state = new State();
    const first = chatWindow(state);
    first.send('cleared-message');
    await first.history.flush();
    await first.history.bridge.reconcile('dev');
    const beforeClear = state.get<ChatHistoryMessage[]>(chatHistoryKey('dev'))!;
    expect(typeof beforeClear[0].seq).toBe('number');
    first.provider.clearSelectedAgent();
    await first.history.flush();
    first.provider.dispose();
    // 0.9.109 writes its stale view back with one sequenced message of its own.
    await state.update(chatHistoryKey('dev'), as109([...beforeClear, { role: 'user', text: 'really-new-in-109', ts: at(40), seq: 7 }]));
    const second = chatWindow(state);
    expect(second.provider.exportSelected()!.messages.map((m) => m.text)).toEqual(['really-new-in-109']);
    await second.history.flush();
    await second.history.bridge.reconcile('dev');
    second.provider.dispose();
    const third = chatWindow(state);
    expect(third.provider.exportSelected()!.messages.map((m) => m.text)).toEqual(['really-new-in-109']);
    third.send('after-second-reopen');
    expect((state.get<ChatHistoryMessage[]>(chatHistoryKey('dev')) ?? []).map((m) => m.text)).toEqual(['really-new-in-109', 'after-second-reopen']);
    const canonical = await canonicalTexts(third);
    expect(canonical.filter((text) => text === 'cleared-message')).toHaveLength(1);
    third.provider.dispose();
  });
});

describe('second re-audit (754eb183)', () => {
  it('F1: a window that loses the snapshot publication removes only what the winning snapshot holds as events', async () => {
    const seed = await openStore();
    await seed.append(transcriptMessage('first'));
    await seed.append(transcriptMessage('second'));
    const events = path.join(dir, 'events');
    const second = JSON.parse(fs.readFileSync(path.join(events, '000000000002.json'), 'utf8'));
    // Another window, which had event 1 as a gap, won the publication of the snapshot through revision 2.
    const winner = JSON.stringify({ schemaVersion: 1, workspaceId: WORKSPACE, through: 2, events: [{ revision: 2, envelope: second }], gaps: [1] });
    const loser = await HistoryStore.open({ directory: dir, workspaceId: WORKSPACE, writerId: randomUUID(), compactAfter: 2,
      beforeSnapshotPublish: async (file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${winner}\n`); } });
    expect(loser.messagesOf('dev').map((entry) => entry.message.text)).toEqual(['first', 'second']);
    // It compacts through revision 2; the other window published that snapshot name first.
    await (loser as any).compactIfDue.call(Object.assign(loser, { loadedThrough: 2 }));
    expect(fs.existsSync(path.join(events, '000000000001.json'))).toBe(true);
    expect(fs.existsSync(path.join(events, '000000000002.json'))).toBe(false);
    const fresh = await openStore();
    expect(fresh.messagesOf('dev').map((entry) => entry.message.text)).toEqual(['first', 'second']);
    expect(fresh.gaps).toEqual([]);
  });
});

describe('F4: a closeout that arrives while its admission is still being written', () => {
  it('links the outcome to the task in the history\'s order', async () => {
    const state = new State();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const window = chatWindow(state, async () => { await gate; return openStore(); });
    window.send('fast request');
    const historyId = (window.deps.send as ReturnType<typeof vi.fn>).mock.calls[0][5].historyId as string;
    window.history.requestAdmitted('dev', historyId, 'fast-request');
    const record = {
      recordId: 'request-closeout:fast-request:turn-1', requestId: 'fast-request', rootAgentId: 'dev', revision: 1,
      recordedAt: at(5), terminal: { kind: 'answered' },
      observations: { checks: { coverage: 'complete', passed: 1, failed: 0, refused: 0 } },
    } as unknown as RequestCloseoutRecordV1;
    window.history.outcomeRecorded(record);
    release();
    await window.history.flush();
    const store = (await window.history.store())!;
    const task = (await store.task(historyId))!;
    expect(task).toMatchObject({ rootRequestId: 'fast-request', terminal: 'completed', verification: 'verified',
      outcomeRefs: ['request-closeout:fast-request:turn-1'] });
    const reopened = await openStore();
    expect((await reopened.task(historyId))!.outcomeRefs).toEqual(['request-closeout:fast-request:turn-1']);
    window.provider.dispose();
  });
});

describe('F5: workspace identity and case', () => {
  const same = (root: string) => root;
  it('keeps case-distinct roots apart on POSIX, folds case on Windows, and ignores root order', () => {
    const upper = historyWorkspace(['/projects/App'], undefined, { platform: 'linux', path: path.posix, realpath: same });
    const lower = historyWorkspace(['/projects/app'], undefined, { platform: 'linux', path: path.posix, realpath: same });
    expect(upper.workspaceId).not.toBe(lower.workspaceId);
    const w1 = historyWorkspace(['C:\\Work\\App', 'D:\\b'], undefined, { platform: 'win32', path: path.win32, realpath: same });
    const w2 = historyWorkspace(['d:\\B', 'c:\\work\\app\\'], undefined, { platform: 'win32', path: path.win32, realpath: same });
    expect(w1.workspaceId).toBe(w2.workspaceId);
    const alias = historyWorkspace(['/link/to/app'], undefined, { platform: 'linux', path: path.posix, realpath: () => '/projects/app' });
    expect(alias.workspaceId).toBe(lower.workspaceId);
    const p1 = historyWorkspace(['/a', '/b'], 'SSH-Remote+Box', { platform: 'linux', path: path.posix, realpath: same });
    const p2 = historyWorkspace(['/b', '/a'], 'ssh-remote+box', { platform: 'linux', path: path.posix, realpath: same });
    expect(p1.workspaceId).toBe(p2.workspaceId);
    expect(p1.workspaceId).not.toBe(historyWorkspace(['/a', '/b'], undefined, { platform: 'linux', path: path.posix, realpath: same }).workspaceId);
  });
});
