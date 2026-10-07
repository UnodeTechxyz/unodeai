import { describe, expect, it } from 'vitest';
import {
  appendChatMessage,
  chatHistoryKey,
  deserializeChatHistory,
  MAX_AGENT_MESSAGE_CHARS,
  serializeChatHistory,
  ChatHistoryMessage,
} from '../chatHistory';
import { restoredTurnDelivery, TurnOutcomeAccumulator } from '../../session/turnOutcomeReceipt';

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
      { role: 'user', text: 'safe', ts: '2026-06-05T00:00:00.000Z', fromName: undefined, isError: undefined },
    ]);
  });

  it('preserves recorded timing and leaves an unrecorded one absent instead of manufacturing null', () => {
    const startedAt = '2026-08-28T12:00:00.000Z';
    const settledAt = '2026-08-28T12:03:10.000Z';
    const [recorded] = deserializeChatHistory([{
      role: 'agent', text: 'done', ts: settledAt,
      turnTiming: { startedAt, settledAt, durationMs: 170_000, approvalWaitMs: 20_000 },
    }]);
    const [historic] = deserializeChatHistory([{ role: 'agent', text: 'old', ts: startedAt }]);

    const [explicitNull] = deserializeChatHistory([{ role: 'agent', text: 'older build', ts: startedAt, turnTiming: null }]);

    expect(recorded.turnTiming).toEqual({ startedAt, settledAt, durationMs: 170_000, approvalWaitMs: 20_000 });
    expect(historic.turnTiming).toBeUndefined();
    // Older builds wrote null for "not recorded"; it is kept, and renders nothing, exactly like absent.
    expect(explicitNull.turnTiming).toBeNull();
  });

  it('keeps a phase breakdown across a reload only when it adds up to the turn it belongs to', () => {
    const startedAt = '2026-10-02T12:00:00.000Z';
    const settledAt = '2026-10-02T12:00:30.000Z';
    const phases = {
      queuedMs: 2_000, hostMs: 1_000, providerWaitMs: 15_000, reasoningMs: 4_000, respondingMs: 3_000, toolMs: 5_000,
      providerWaitCount: 2, longestProviderWaitMs: 12_000,
    };
    const timing = { startedAt, settledAt, durationMs: 30_000, approvalWaitMs: 0 };
    const reload = (stored: Record<string, unknown>) => deserializeChatHistory(
      serializeChatHistory(deserializeChatHistory([{ role: 'agent', text: 'done', ts: settledAt, turnTiming: stored }])),
    )[0].turnTiming;

    expect(reload({ ...timing, phases, smuggled: 'prose' })).toEqual({ ...timing, phases });
    // A turn recorded before phases existed keeps its total. Its breakdown is absent, not six zeroes.
    expect(reload(timing)).toEqual(timing);
    expect(reload(timing)).not.toHaveProperty('phases');
    // A breakdown the host could not have recorded for this duration is dropped; the total stays.
    expect(reload({ ...timing, phases: { ...phases, toolMs: 6_000 } })).toEqual(timing);
    expect(reload({ ...timing, phases: { ...phases, longestProviderWaitMs: 16_000 } })).toEqual(timing);
    expect(reload({ ...timing, phases: { ...phases, hostMs: -1_000, queuedMs: 4_000 } })).toEqual(timing);
    const { queuedMs: _queuedMs, ...withoutQueue } = phases;
    expect(reload({ ...timing, phases: withoutQueue })).toEqual(timing);
  });

  it('round-trips the terminal-turn fields and drops malformed ones', () => {
    const [kept] = deserializeChatHistory(serializeChatHistory([{
      role: 'agent', text: 'done', ts: '2026-09-26T00:00:00.000Z',
      turnFinal: true, turnId: '5b1c2f0e-4c2a-4d7e-9a61-2f3c0d9b7e11',
      delegationReceipt: { accepted: 1, refused: 2, pending: 0 },
    }]));
    expect(kept).toMatchObject({
      turnFinal: true,
      turnId: '5b1c2f0e-4c2a-4d7e-9a61-2f3c0d9b7e11',
      delegationReceipt: { accepted: 1, refused: 2, pending: 0 },
    });

    const malformed = deserializeChatHistory([
      { role: 'agent', text: 'a', ts: 't', turnFinal: 'yes', turnId: 'has spaces', delegationReceipt: { accepted: 1, refused: 2 } },
      { role: 'agent', text: 'b', ts: 't', turnId: 'x'.repeat(129), delegationReceipt: { accepted: -1, refused: 0, pending: 0 } },
      { role: 'agent', text: 'c', ts: 't', delegationReceipt: { accepted: 1.5, refused: 0, pending: 0 } },
      { role: 'agent', text: 'd', ts: 't', delegationReceipt: { accepted: 10_001, refused: 0, pending: 0 } },
    ]);
    for (const message of malformed) {
      expect(message.turnFinal).toBeUndefined();
      expect(message.turnId).toBeUndefined();
      expect(message.delegationReceipt).toBeUndefined();
    }
  });

  it('keeps a well-formed trigger whole and drops any malformed one', () => {
    const trigger = {
      sources: [
        { agentId: 'fe-1', agentName: 'Frontend Engineer', reason: 'rework-reply' },
        { agentId: 'rv-2', agentName: 'Reviewer', reason: 'delegation-result' },
      ],
      more: 3,
    };
    const [kept] = deserializeChatHistory(serializeChatHistory([{ role: 'agent', text: 'x', ts: 't', turnTrigger: trigger as never }]));
    expect(kept.turnTrigger).toEqual(trigger);

    const bad = [
      { sources: [], more: 0 },
      { sources: [{ agentId: 'a', agentName: 'A', reason: 'guess' }], more: 0 },
      { sources: [{ agentId: 'has spaces', agentName: 'A', reason: 'rework-reply' }], more: 0 },
      { sources: [{ agentId: 'a', agentName: '  ', reason: 'rework-reply' }], more: 0 },
      { sources: [{ agentId: 'a', agentName: 'A', reason: 'rework-reply' }], more: -1 },
      { sources: Array.from({ length: 5 }, (_, index) => ({ agentId: `a${index}`, agentName: 'A', reason: 'rework-reply' })), more: 0 },
    ];
    for (const turnTrigger of bad) {
      const [message] = deserializeChatHistory([{ role: 'agent', text: 'x', ts: 't', turnTrigger }]);
      expect(message.turnTrigger).toBeUndefined();
    }
  });

  it('never gives a user message turn-ending fields', () => {
    const [user] = deserializeChatHistory([{
      role: 'user', text: 'hi', ts: 't', turnFinal: true, turnId: 'abc', delegationReceipt: { accepted: 0, refused: 0, pending: 0 },
    }]);
    expect(user.turnFinal).toBeUndefined();
    expect(user.turnId).toBeUndefined();
    expect(user.delegationReceipt).toBeUndefined();
  });

  it('preserves runtime notices as non-turn records across persistence', () => {
    const [notice] = deserializeChatHistory(serializeChatHistory([{
      role: 'agent', text: 'Codex auto-review approved.', ts: '2026-09-23T00:00:00.000Z',
      fromName: 'UnodeAi', runtimeNotice: true,
    }]));
    expect(notice.runtimeNotice).toBe(true);
    expect(notice.turnTiming).toBeUndefined();
    expect(notice.turnFinal).toBeUndefined();
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

describe('v0.9.91 turn outcome receipt in the transcript', () => {
  const receipt = () => {
    const turn = new TurnOutcomeAccumulator();
    turn.use('call-1');
    turn.result('call-1', { status: 'failed', observedBy: 'provider-protocol', failureKind: 'error' });
    return turn.finish({ turnId: 'turn-1', agentId: 'dev', recordedAt: '2026-09-30T10:00:00.000Z', delivery: { kind: 'reply' } })!;
  };

  it('keeps the receipt only on the reply that ends a turn, rebuilt from its bounded fields', () => {
    const stored = JSON.parse(JSON.stringify([
      { role: 'agent', text: 'Done.', ts: 't', turnFinal: true, turnOutcome: { ...receipt(), toolNames: ['Bash'] } },
      { role: 'agent', text: 'Working.', ts: 't', turnOutcome: receipt() },
      { role: 'user', text: 'Go.', ts: 't', turnFinal: true, turnOutcome: receipt() },
      { role: 'agent', text: 'Forged.', ts: 't', turnFinal: true, turnOutcome: { ...receipt(), tools: { ...receipt().tools, total: 9 } } },
    ]));
    const restored = deserializeChatHistory(stored);
    expect(restored.map((message) => message.turnOutcome)).toEqual([receipt(), undefined, undefined, undefined]);
    expect(serializeChatHistory(restored)[0].turnOutcome).toEqual(receipt());
  });

  it('restores a row written before v0.9.91 as legacy-unclassified, whatever its text or error flag says', () => {
    const [legacy] = deserializeChatHistory([{ role: 'agent', text: '', ts: 't', turnFinal: true, isError: true }]);
    expect(legacy.turnOutcome).toBeUndefined();
    expect(restoredTurnDelivery(legacy.turnOutcome)).toEqual({ classification: 'legacy-unclassified' });
    const [typed] = deserializeChatHistory([{ role: 'agent', text: 'Done.', ts: 't', turnFinal: true, turnOutcome: receipt() }]);
    expect(restoredTurnDelivery(typed.turnOutcome)).toEqual({ classification: 'typed', outcome: { kind: 'reply' } });
  });
});
