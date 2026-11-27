import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HistoryStore } from '../HistoryStore';
import { LegacyChatProjectionBridge, bridgeStateKey } from '../LegacyChatProjectionBridge';
import type { HistoryEventBody } from '../HistoryRecords';
import { chatHistoryKey, serializeChatHistory, type ChatHistoryMessage } from '../../views/chatHistory';

const WORKSPACE = 'c'.repeat(64);
let dir: string;

class FakeState {
  readonly values = new Map<string, unknown>();
  get(key: string): unknown {
    const value = this.values.get(key);
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, JSON.parse(JSON.stringify(value)));
  }
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-bridge-'));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

let clock = 0;
function msg(role: 'user' | 'agent', text: string): ChatHistoryMessage {
  clock += 1;
  return { role, text, ts: new Date(Date.UTC(2026, 10, 25, 9, 0, clock)).toISOString(), seq: clock };
}

/** What 0.9.109 writes: its parser keeps no history id. */
function as109(messages: ChatHistoryMessage[]): ChatHistoryMessage[] {
  return serializeChatHistory(messages.map(({ messageId: _id, ...rest }) => rest));
}

function setup(state = new FakeState(), failAppends = { count: 0 }) {
  let store: HistoryStore | undefined;
  const opened = HistoryStore.open({ directory: dir, workspaceId: WORKSPACE, writerId: randomUUID() }).then((s) => { store = s; return s; });
  const bridge = new LegacyChatProjectionBridge({
    state,
    store: async () => {
      const s = await opened;
      if (failAppends.count <= 0) return s;
      // Only the import fails: a marker written after it would succeed, so a bridge that ignored the failure would mark.
      const bound = bindStore(s);
      return { ...bound, append: async (body: HistoryEventBody, options?: { eventId?: string }) => {
        if (body.kind !== 'legacy-import') return bound.append(body, options);
        failAppends.count--;
        return { status: 'failed' as const, reason: 'disk full' };
      } };
    },
    newGeneration: () => randomUUID(),
  });
  return { state, bridge, store: () => opened, peek: () => store };
}

function bindStore(s: HistoryStore) {
  return {
    refresh: () => s.refresh(),
    append: s.append.bind(s),
    hasMessage: (id: string) => s.hasMessage(id),
    migrationMarker: (agentId: string, key: string) => s.migrationMarker(agentId, key),
    currentGeneration: (agentId: string) => s.currentGeneration(agentId),
  };
}

describe('LegacyChatProjectionBridge', () => {
  it('copies the chat key into the history, marks it migrated, and finds nothing new the second time', async () => {
    const { state, bridge, store } = setup();
    const legacy = [msg('user', 'old goal'), msg('agent', 'old answer')];
    await state.update(chatHistoryKey('dev'), as109(legacy));
    expect(await bridge.reconcile('dev')).toBe('migrated');
    const s = await store();
    expect(s.migrationMarker('dev', chatHistoryKey('dev'))).toMatch(/^[a-f0-9]{64}$/);
    expect(s.messagesOf('dev').map((entry) => entry.message.text)).toEqual(['old goal', 'old answer']);
    expect(await bridge.reconcile('dev')).toBe('unchanged');
    expect(s.messagesOf('dev')).toHaveLength(2);
    const [task] = (await s.query()).tasks;
    expect(task).toMatchObject({ legacy: true, goal: 'old goal' });
    expect(task.conclusion).toBeUndefined();
  });

  it('imports what 0.9.109 added after the marker, once, and keeps the earlier history', async () => {
    const { state, bridge, store } = setup();
    const first = [msg('user', 'a'), msg('agent', 'b')];
    await state.update(chatHistoryKey('dev'), as109(first));
    await bridge.reconcile('dev');
    // A downgrade: 0.9.109 appends two messages and writes the key without history ids.
    await state.update(chatHistoryKey('dev'), as109([...first, msg('user', 'c from 109'), msg('agent', 'd from 109')]));
    expect(await bridge.reconcile('dev')).toBe('imported');
    expect(await bridge.reconcile('dev')).toBe('unchanged');
    // A second 0.9.110 window starting on the same state imports nothing again.
    const again = setup(state);
    expect(await again.bridge.reconcile('dev')).toBe('unchanged');
    const s = await store();
    await s.refresh();
    expect(s.messagesOf('dev').map((entry) => entry.message.text)).toEqual(['a', 'b', 'c from 109', 'd from 109']);
  });

  it('records a key that 0.9.109 cleared as a replaced view, and a stale copy does not bring the conversation back', async () => {
    const { state, bridge, store } = setup();
    const before = [msg('user', 'keep me'), msg('agent', 'answer')];
    await state.update(chatHistoryKey('dev'), as109(before));
    await bridge.reconcile('dev');
    await state.update(chatHistoryKey('dev'), undefined);
    expect(await bridge.reconcile('dev')).toBe('replaced');
    const s = await store();
    // The cleared conversation is still in the history, read-only.
    expect(s.messagesOf('dev').map((entry) => entry.message.text)).toEqual(['keep me', 'answer']);
    // A 0.9.109 window that still held the old view writes it back, with one message really new.
    await state.update(chatHistoryKey('dev'), as109([...before, msg('user', 'new after clear')]));
    expect(await bridge.reconcile('dev')).toBe('imported');
    expect(s.messagesOf('dev').map((entry) => entry.message.text)).toEqual(['keep me', 'answer', 'new after clear']);
  });

  it('does not overwrite or forget the key when the history cannot record it, and migrates on the next try', async () => {
    const fail = { count: 1 };
    const { state, bridge, store } = setup(new FakeState(), fail);
    await state.update(chatHistoryKey('dev'), as109([msg('user', 'precious')]));
    expect(await bridge.reconcile('dev')).toBe('failed');
    const s = await store();
    expect(s.migrationMarker('dev', chatHistoryKey('dev'))).toBeUndefined();
    expect(state.get(bridgeStateKey('dev'))).toBeUndefined();
    expect((state.get(chatHistoryKey('dev')) as unknown[]).length).toBe(1);
    expect(await bridge.reconcile('dev')).toBe('migrated');
    expect(s.messagesOf('dev').map((entry) => entry.message.text)).toEqual(['precious']);
  });

  it('imports what was in the key at the first look even when this window cleared it before the migration ran', async () => {
    const { state, bridge, store } = setup();
    await state.update(chatHistoryKey('dev'), as109([msg('user', 'before clear')]));
    bridge.observe('dev');
    // The person clears at once; the window writes the empty key.
    await state.update(chatHistoryKey('dev'), undefined);
    bridge.written('dev', undefined);
    expect(await bridge.reconcile('dev')).toBe('unchanged');
    const s = await store();
    expect(s.messagesOf('dev').map((entry) => entry.message.text)).toEqual(['before clear']);
  });

  it('hands the view what another version added before this window writes, and nothing when the key is as written', async () => {
    const { state, bridge } = setup();
    const own = [msg('user', 'mine')];
    await state.update(chatHistoryKey('dev'), as109(own));
    await bridge.reconcile('dev');
    expect(bridge.beforeWrite('dev')).toEqual([]);
    await state.update(chatHistoryKey('dev'), as109([...own, msg('agent', 'theirs')]));
    expect(bridge.beforeWrite('dev').map((m) => m.text)).toEqual(['theirs']);
    // beforeWrite schedules the durable import of the addition; it finishes before the history folder is removed.
    await bridge.reconcile('dev');
  });

  it('remembers messages this window wrote and then trimmed, so a stale copy without their ids cannot re-add them', async () => {
    const { state, bridge, store } = setup();
    expect(await bridge.reconcile('dev')).toBe('migrated');
    const s = await store();
    // This window wrote three messages of its own: each is in the history under its own id, and in the key.
    const own = Array.from({ length: 3 }, (_, i) => ({ ...msg('user', `m${i}`), messageId: `own-${i}` }));
    for (const m of own) {
      await s.append({ kind: 'transcript-append', agentId: 'dev', viewGeneration: 'g', messageId: m.messageId, message: m, startsTask: { historyId: `t-${m.messageId}` } });
    }
    const written = serializeChatHistory(own);
    await state.update(chatHistoryKey('dev'), written);
    bridge.written('dev', written);
    // Its window drops m0 and writes again.
    const trimmed = serializeChatHistory(own.slice(1));
    await state.update(chatHistoryKey('dev'), trimmed);
    bridge.written('dev', trimmed);
    // A 0.9.109 window that still held all three writes them back, without history ids.
    await state.update(chatHistoryKey('dev'), as109(own));
    expect(await bridge.reconcile('dev')).toBe('unchanged');
    expect(s.messagesOf('dev').map((entry) => entry.messageId)).toEqual(['own-0', 'own-1', 'own-2']);
  });
});
