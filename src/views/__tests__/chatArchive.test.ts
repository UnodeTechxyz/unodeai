import { describe, it, expect } from 'vitest';
import {
  ArchivedChat,
  CHAT_ARCHIVE_LIMIT,
  deserializeArchives,
  makeArchiveId,
  serializeArchives,
  summarizeArchive,
} from '../chatArchive';

const entry = (over: Partial<ArchivedChat> = {}): ArchivedChat => ({
  id: 'arch-1',
  agentId: 'a1',
  agentName: 'Dev',
  archivedAt: '2026-06-15T00:00:00.000Z',
  messages: [{ role: 'user', text: 'hi', ts: '2026-06-15T00:00:00.000Z' }],
  ...over,
});

describe('chatArchive', () => {
  it('normalizes a valid historic list with an explicit not-recorded timing state', () => {
    const list = [entry()];
    expect(deserializeArchives(serializeArchives(list))).toEqual([{
      ...entry(),
      role: undefined,
      messages: [{
        role: 'user',
        text: 'hi',
        ts: '2026-06-15T00:00:00.000Z',
        seq: undefined,
        turnEpoch: undefined,
        fromName: undefined,
        isError: undefined,
        attachments: undefined,
        turnTiming: null,
      }],
    }]);
  });

  it('drops malformed entries and non-arrays', () => {
    expect(deserializeArchives(null)).toEqual([]);
    expect(deserializeArchives('nope')).toEqual([]);
    expect(deserializeArchives([{ id: 'x' }, { agentId: 'y' }, 42])).toEqual([]); // missing id/agentId
    const ok = deserializeArchives([{ id: 'i', agentId: 'a', messages: 'bad' }]);
    expect(ok).toHaveLength(1);
    expect(ok[0].messages).toEqual([]); // bad messages coerced to empty, entry kept
    expect(ok[0].agentName).toBe('a'); // falls back to agentId
  });

  it('caps the list at CHAT_ARCHIVE_LIMIT (oldest dropped — newest is first)', () => {
    const many = Array.from({ length: CHAT_ARCHIVE_LIMIT + 10 }, (_, i) => entry({ id: `arch-${i}` }));
    const out = serializeArchives(many);
    expect(out).toHaveLength(CHAT_ARCHIVE_LIMIT);
    expect(out[0].id).toBe('arch-0');
  });

  it('makeArchiveId is unique-ish and prefixed', () => {
    const a = makeArchiveId(1000, () => 0.1234);
    const b = makeArchiveId(1001, () => 0.9876);
    expect(a).toMatch(/^arch-/);
    expect(a).not.toBe(b);
  });

  it('summarizeArchive previews the first non-empty message with a count', () => {
    expect(summarizeArchive(entry())).toBe('1 message · hi');
    const long = 'x'.repeat(200);
    expect(summarizeArchive(entry({ messages: [{ role: 'user', text: long, ts: '' }] }))).toContain('…');
    expect(summarizeArchive(entry({ messages: [] }))).toBe('0 messages');
  });
});
