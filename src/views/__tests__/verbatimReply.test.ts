import { describe, expect, it } from 'vitest';
import { deserializeChatHistory, MAX_AGENT_MESSAGE_CHARS, parseChatVerbatim, serializeChatHistory } from '../chatHistory';
import { verbatimReplyBlocks } from '../verbatimReply';
import { TeamTools, type TeamView } from '../../backend/TeamTools';
import { MessageBus } from '../../bus/MessageBus';
import { turnVerbatimOf } from '../../backend/TurnContentDelivery';

/** v0.9.88 §5.5: host-published exact content renders verbatim; everything around it stays Markdown. */
describe('verbatim reply blocks', () => {
  const file = '# not a heading\n* not a bullet\n1. not a list\n  indented `code`';

  it('renders the span as one exact block and the framing as Markdown', () => {
    const framing = 'Here is **the file**:';
    const text = `${framing}\n\n${file}`;
    const blocks = verbatimReplyBlocks(text, { start: framing.length + 2, length: file.length });
    expect(blocks[0]).toMatchObject({ type: 'paragraph' });
    expect(JSON.stringify(blocks[0])).toContain('"type":"strong"');
    expect(blocks[1]).toEqual({ type: 'verbatim', text: file, caption: 'Exact content' });
    expect(blocks).toHaveLength(2);
  });

  it('keeps text the host appended after the span as Markdown', () => {
    const text = `${file}\n\nHost execution hook blocked turn completion: **denied**`;
    const blocks = verbatimReplyBlocks(text, { start: 0, length: file.length });
    expect(blocks[0]).toMatchObject({ type: 'verbatim', text: file });
    expect(blocks.at(-1)).toMatchObject({ type: 'paragraph' });
  });

  it('captions a prefix and a transcript-clipped span with their character counts', () => {
    expect(verbatimReplyBlocks('A😀B', { start: 0, length: 4, partial: true })[0])
      .toEqual({ type: 'verbatim', text: 'A😀B', caption: 'Exact content (first 3 characters)' });
    expect(verbatimReplyBlocks('x'.repeat(1_500), { start: 0, length: 1_500, clipped: true })[0])
      .toMatchObject({ caption: 'Exact content (first 1,500 characters kept in the transcript)' });
  });

  it('lands a published A😀BC prefix on exact UTF-16 offsets end to end, with and without framing', async () => {
    const view: TeamView = { list: () => [{ id: 'pm', role: 'pm', name: 'PM', status: 'running' }], resolve: () => undefined };
    for (const framing of ['', 'Prefix:']) {
      for (const state of ['shown', 'partial'] as const) {
        const team = new TeamTools('pm', view, new MessageBus());
        team.beginTurnContentReceipts();
        const receipt = team.registerTurnContentReceipt('A😀BC');
        await team.run('publish_content_receipt', {
          receipt_id: receipt!.id, state, ...(framing ? { framing } : {}), ...(state === 'partial' ? { visible_characters: 2 } : {}),
        });
        const delivery = team.takePublishedTurnDelivery()!;
        const [stored] = deserializeChatHistory(serializeChatHistory([
          { role: 'agent', text: delivery.text, ts: '2026-09-26T00:00:00.000Z', verbatim: turnVerbatimOf(delivery) },
        ]));
        const exact = verbatimReplyBlocks(stored.text, stored.verbatim!).find((block) => block.type === 'verbatim');
        expect(exact).toMatchObject({ text: state === 'shown' ? 'A😀BC' : 'A😀' });
      }
    }
  });
});

describe('stored verbatim spans', () => {
  it('round-trips a span and drops malformed or out-of-range ones', () => {
    const row = (verbatim: unknown) => deserializeChatHistory(([
      { role: 'agent', text: 'hello world', ts: '2026-09-26T00:00:00.000Z', verbatim },
    ]))[0];
    expect(row({ start: 6, length: 5, partial: true }).verbatim).toEqual({ start: 6, length: 5, partial: true });
    for (const bad of [{ start: -1, length: 2 }, { start: 0, length: 0 }, { start: 1.5, length: 2 }, { start: '0', length: 2 }, { start: 11, length: 1 }, 'x']) {
      expect(row(bad).verbatim).toBeUndefined();
    }
    expect(parseChatVerbatim({ start: 0, length: 3, clipped: 'yes' })).toEqual({ start: 0, length: 3 });
  });

  it('keeps no span on a user message', () => {
    const [user] = deserializeChatHistory(([{ role: 'user', text: 'hello', ts: '2026-09-26T00:00:00.000Z', verbatim: { start: 0, length: 5 } }]));
    expect(user.verbatim).toBeUndefined();
  });

  it('clips a span at the transcript limit, keeps the kept part exact and leaves the notice outside it', () => {
    const framing = 'Here:';
    const content = 'y'.repeat(MAX_AGENT_MESSAGE_CHARS + 5_000);
    const text = `${framing}\n\n${content}`;
    const [stored] = deserializeChatHistory(serializeChatHistory([
      { role: 'agent', text, ts: '2026-09-26T00:00:00.000Z', verbatim: { start: framing.length + 2, length: content.length } },
    ]));
    expect(stored.text.length).toBeLessThanOrEqual(MAX_AGENT_MESSAGE_CHARS);
    expect(stored.verbatim?.clipped).toBe(true);
    const blocks = verbatimReplyBlocks(stored.text, stored.verbatim!);
    const exact = blocks.find((block) => block.type === 'verbatim') as { text: string; caption: string };
    expect(/^y+$/.test(exact.text)).toBe(true);
    expect(exact.caption).toMatch(/kept in the transcript/);
    expect(JSON.stringify(blocks.at(-1))).toContain('not kept in the transcript');
    // Re-serializing never shrinks the span again.
    const [again] = deserializeChatHistory(serializeChatHistory([stored]));
    expect(again.verbatim).toEqual(stored.verbatim);
  });

  it('drops a span that starts beyond the kept text', () => {
    const text = 'z'.repeat(MAX_AGENT_MESSAGE_CHARS + 100);
    const [stored] = deserializeChatHistory(serializeChatHistory([
      { role: 'agent', text, ts: '2026-09-26T00:00:00.000Z', verbatim: { start: MAX_AGENT_MESSAGE_CHARS + 10, length: 20 } },
    ]));
    expect(stored.verbatim).toBeUndefined();
  });
});
