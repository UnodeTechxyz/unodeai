import { describe, expect, it } from 'vitest';
import {
  appendChatMessage,
  chatHistoryKey,
  deserializeChatHistory,
  MAX_AGENT_MESSAGE_CHARS,
  serializeChatHistory,
  ChatHistoryMessage,
} from '../chatHistory';

describe('chatHistory', () => {
  it('keeps the newest messages within the cap', () => {
    let history: ChatHistoryMessage[] = [];
    for (let i = 0; i < 55; i++) {
      history = appendChatMessage(history, {
        role: i % 2 === 0 ? 'user' : 'agent',
        text: `message ${i}`,
        ts: new Date(i).toISOString(),
      });
    }

    expect(history).toHaveLength(50);
    expect(history[0].text).toBe('message 5');
    expect(history[49].text).toBe('message 54');
  });

  it('serializes only valid bounded chat records', () => {
    const serialized = serializeChatHistory([
      { role: 'user', text: 'hello', ts: '2026-06-05T00:00:00.000Z' },
      { role: 'agent', text: 'hi', ts: '2026-06-05T00:00:01.000Z', fromName: 'Dev', isError: false },
    ]);

    expect(serialized).toEqual([
      { role: 'user', text: 'hello', ts: '2026-06-05T00:00:00.000Z', fromName: undefined, isError: undefined },
      { role: 'agent', text: 'hi', ts: '2026-06-05T00:00:01.000Z', fromName: 'Dev', isError: undefined },
    ]);
  });

  it('deserializes workspaceState data defensively', () => {
    const restored = deserializeChatHistory([
      { role: 'user', text: 'safe', ts: '2026-06-05T00:00:00.000Z' },
      { role: 'agent', text: 123, ts: 'bad' },
      { role: 'system', text: 'skip', ts: 'bad' },
    ]);

    expect(restored).toEqual([
      { role: 'user', text: 'safe', ts: '2026-06-05T00:00:00.000Z', fromName: undefined, isError: undefined, turnTiming: null },
    ]);
  });

  it('preserves recorded timing and marks older transcript records as not recorded', () => {
    const startedAt = '2026-08-28T12:00:00.000Z';
    const settledAt = '2026-08-28T12:03:10.000Z';
    const [recorded] = deserializeChatHistory([{
      role: 'agent', text: 'done', ts: settledAt,
      turnTiming: { startedAt, settledAt, durationMs: 170_000, approvalWaitMs: 20_000 },
    }]);
    const [historic] = deserializeChatHistory([{ role: 'agent', text: 'old', ts: startedAt }]);

    expect(recorded.turnTiming).toEqual({ startedAt, settledAt, durationMs: 170_000, approvalWaitMs: 20_000 });
    expect(historic.turnTiming).toBeNull();
  });

  it('uses the required workspaceState key prefix', () => {
    expect(chatHistoryKey('dev')).toBe('roam.chat.dev');
  });

  it('bounds an agent reply at the transcript source and discloses the omitted characters', () => {
    const text = 'x'.repeat(MAX_AGENT_MESSAGE_CHARS + 37);
    const [message] = appendChatMessage([], { role: 'agent', text, ts: '2026-08-10T00:00:00.000Z' });

    // The kept body is shorter than the limit by the room reserved for the notice, so the WHOLE clamped
    // message fits inside the limit and a later re-normalization is a no-op. Asserting the body is exactly
    // MAX would pin the non-idempotent shape this was changed away from.
    expect(message.text.length).toBeLessThanOrEqual(MAX_AGENT_MESSAGE_CHARS);
    expect(message.text.startsWith('x'.repeat(1000))).toBe(true);
    expect(message.text).toContain('agent message truncated');
    // The count is what was actually dropped from the original — body length, not the limit.
    const body = message.text.slice(0, message.text.indexOf('\n\n'));
    expect(message.text).toContain(`${(text.length - body.length).toLocaleString()} more characters not kept in the transcript`);
    // The cap applies again when an old workspaceState record is restored, not only to new messages.
    expect(deserializeChatHistory([{ role: 'agent', text, ts: message.ts }])[0].text).toBe(message.text);
    expect(serializeChatHistory([{ role: 'user', text, ts: message.ts }])[0].text).toBe(text);
  });

  // Audit of v0.9.50, 2026-08-10. normalizeMessage runs on every append, serialize and parse, so a clamped
  // message is re-normalized many times. The first clamp returned `limit + notice` characters — over its own
  // limit — so the next pass cut it again and re-derived the count from already-truncated text. Measured: a
  // message that correctly said "8,000 more characters not kept" said "77" after five re-serializations.
  // A disclosure converging on a number two orders of magnitude too small is worse than silence.
  it('clamps once: repeated normalization changes neither the text nor the count it reports', () => {
    const long = 'x'.repeat(MAX_AGENT_MESSAGE_CHARS + 8000);
    let history = appendChatMessage([], { role: 'agent', text: long, ts: new Date().toISOString() });
    const first = history[0].text;

    for (let i = 0; i < 5; i++) {
      history = serializeChatHistory(history);
    }

    expect(history[0].text).toBe(first);
    expect(first.length).toBeLessThanOrEqual(MAX_AGENT_MESSAGE_CHARS);

    // The count must describe what was actually dropped from the original, not what one pass shaved.
    const marker = '\n\n' + String.fromCharCode(8230) + ' [';
    const body = first.slice(0, first.indexOf(marker));
    const said = /truncated ./.test(first) ? /truncated . ([\d,]+) more/.exec(first)?.[1] : undefined;
    expect(Number(String(said).replace(/,/g, ''))).toBe(long.length - body.length);
  });
});
