import { describe, expect, it } from 'vitest';
import {
  createChatExportPayload,
  createMessagesExportPayload,
  parseChatImportPayload,
  parseMessagesImportPayload,
} from '../transcriptPort';

describe('transcript import/export payloads', () => {
  it('creates the chat export payload shape', () => {
    const payload = createChatExportPayload(
      { id: 'dev-1', name: 'Dev', role: 'senior-dev' },
      [{ role: 'user', text: 'hello', ts: '2026-06-09T00:00:00.000Z' }],
      '2026-06-09T01:00:00.000Z'
    );

    expect(payload).toEqual({
      version: 1,
      kind: 'chat',
      agent: { id: 'dev-1', name: 'Dev', role: 'senior-dev' },
      exportedAt: '2026-06-09T01:00:00.000Z',
      messages: [{ role: 'user', text: 'hello', ts: '2026-06-09T00:00:00.000Z', fromName: undefined, isError: undefined }],
    });
  });

  it('creates the messages export payload shape', () => {
    const payload = createMessagesExportPayload([
      { time: '10:00', from: 'PM', to: 'Dev', type: 'task.assign', priority: 'high', content: 'Build it' },
    ], '2026-06-09T01:00:00.000Z');

    expect(payload).toMatchObject({
      version: 1,
      kind: 'messages',
      exportedAt: '2026-06-09T01:00:00.000Z',
      messages: [{ time: '10:00', from: 'PM', to: 'Dev', type: 'task.assign', priority: 'high', content: 'Build it' }],
    });
  });

  it('records message-log truncation rather than making an omitted prefix look like a fresh run (T11)', () => {
    const payload = createMessagesExportPayload([
      { time: '10:00', from: 'PM', to: 'Dev', type: 'task.assign', priority: 'high', content: 'Build it' },
    ], '2026-06-09T01:00:00.000Z', { occurred: true, droppedItems: 417, retainedItems: 1, limit: 300 });

    expect(payload.truncation).toEqual({ occurred: true, droppedItems: 417, retainedItems: 1, limit: 300 });
    const parsed = parseMessagesImportPayload(payload);
    expect(parsed.ok && parsed.truncation).toEqual({ occurred: true, droppedItems: 417, retainedItems: 1, limit: 300 });
  });

  it('safely rejects bad import JSON without throwing', () => {
    expect(parseChatImportPayload('{nope').ok).toBe(false);
  });

  // v0.9.103: a chat keeps its newest 50 messages; the import says whether it left older ones out.
  it('a chat import keeps the newest messages and says whether older ones were left out', () => {
    const chat = (count: number, truncation?: unknown) => ({ kind: 'chat', messages: [...Array(count).keys()]
      .map((index) => ({ role: 'agent', text: `Message ${index}`, ts: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString() })),
    ...(truncation ? { truncation } : {}) });
    const long = parseChatImportPayload(chat(70));
    expect(long.ok && long.messages.map((message) => message.text)).toEqual([...Array(50).keys()].map((index) => `Message ${index + 20}`));
    expect(long.ok && long.dropped).toBe(true);
    const full = parseChatImportPayload(chat(50));
    expect(full.ok && [full.messages.length, full.dropped]).toEqual([50, false]);
    // A file its export already cut says so, whatever its length now.
    const cut = parseChatImportPayload(chat(3, { occurred: true, droppedItems: 9, retainedItems: 3, limit: 50 }));
    expect(cut.ok && [cut.messages.length, cut.dropped]).toEqual([3, true]);
  });

  it('rejects the wrong import kind', () => {
    expect(parseChatImportPayload({ kind: 'messages', messages: [] })).toEqual({
      ok: false,
      error: 'Import file must have kind "chat".',
    });
  });

  it('rejects imports without a messages array', () => {
    expect(parseMessagesImportPayload({ kind: 'messages', messages: {} })).toEqual({
      ok: false,
      error: 'Import file must contain a messages array.',
    });
  });
});
