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
