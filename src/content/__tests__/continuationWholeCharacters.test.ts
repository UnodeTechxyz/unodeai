import { describe, expect, it } from 'vitest';
import { boundToolResultForModel, MODEL_TOOL_RESULT_MAX_CHARS } from '../../backend/boundToolResultForModel';
import { boundDynamicToolResult } from '../../backend/CodexBackend';
import { composeUserTextAttachments, storedTextAttachmentSource } from '../../attachments';
import type { UserAttachment } from '../../types';
import { boundToolResultWithContinuation } from '../../backend/boundToolResultForModel';
import { formatSavedBatches, type CheckpointAttemptSummary, type TaskCheckpointRecord } from '../../backend/TaskCheckpoints';
import { CONTENT_ASSET_MAX_PAGE_TEXT, ContentAssetStore, textContinuationAt, type ContentContinuation } from '../ContentAssetStore';

// v0.9.99: every part a continuation delivers holds whole characters. A character outside the Basic Multilingual Plane
// (an emoji, a supplementary CJK character) is two UTF-16 code units; no page, part or continuation offset falls
// between them, so the parts, each encoded as UTF-8 on its own, rebuild the original bytes. All text is synthetic.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SMILE = '\u{1F600}';
const CJK = '\u{20BB7}';

function expectWholeParts(parts: readonly string[], original: string): void {
  for (const part of parts) expect(part).not.toMatch(LONE_SURROGATE);
  expect(Buffer.concat(parts.map((part) => Buffer.from(part, 'utf8'))).equals(Buffer.from(original, 'utf8'))).toBe(true);
}

/** Every part of a stored text, read by following each continuation the store names from `first`. */
async function readOn(store: ContentAssetStore, assetId: string, first: ContentContinuation, maxChars?: number): Promise<string[]> {
  const parts: string[] = [];
  let next: ContentContinuation | undefined = first;
  for (let reads = 0; next && reads < 10_000; reads++) {
    const read = await store.readExtractedContent(assetId, { start: next.page }, {
      ...(next.offset > 0 ? { offset: next.offset } : {}),
      ...(maxChars ? { maxChars } : {}),
    });
    if ('error' in read) throw new Error(read.error);
    for (const item of read.items) if (item.text) parts.push(item.text);
    next = read.continuation;
  }
  return parts;
}

describe('v0.9.99 continuations never split a character', () => {
  it('two text pages read on their own keep a character that straddles the page boundary whole', async () => {
    const store = new ContentAssetStore();
    try {
      const original = 'x'.repeat(19_999) + SMILE + 'TAIL';
      const asset = await store.storeText(original, 'tool-result', 'agent-a');
      const one = await store.readExtractedContent(asset.assetId, { start: 1, end: 1 });
      const two = await store.readExtractedContent(asset.assetId, { start: 2, end: 2 });
      if ('error' in one || 'error' in two) throw new Error('unexpected read failure');
      const a = one.items[0].text!;
      const b = two.items[0].text!;
      expect(a).toBe('x'.repeat(19_999));
      expect(b).toBe(`${SMILE}TAIL`);
      expect(one.pages.total).toBe(2);
      expectWholeParts([a, b], original);
      // A read of the whole range has one character of room left at the pair: it stops there and names page 2.
      const all = await store.readExtractedContent(asset.assetId);
      if ('error' in all) throw new Error(all.error);
      expect(all.items.map((item) => item.text)).toEqual(['x'.repeat(19_999)]);
      expect(all.continuation).toEqual({ page: 2, offset: 0 });
    } finally {
      await store.dispose();
    }
  });

  it('a read part-way through a page, and the offset it names, end and start at whole characters', async () => {
    const store = new ContentAssetStore();
    try {
      // A pair at 9,998-9,999 meets the 9,999-character read; another straddles the page boundary at 20,000; a CJK
      // character straddles the next page boundary.
      const original = 'a'.repeat(9_998) + SMILE + 'b'.repeat(9_999) + SMILE + 'c'.repeat(19_998) + CJK + 'd'.repeat(500) + 'TAIL';
      const asset = await store.storeText(original, 'tool-result', 'agent-a');
      const first = await store.readExtractedContent(asset.assetId, { start: 1 }, { maxChars: 9_999 });
      if ('error' in first) throw new Error(first.error);
      expect(first.items[0].text).toBe('a'.repeat(9_998));
      expect(first.continuation).toEqual({ page: 1, offset: 9_998 });
      for (const maxChars of [undefined, 9_999, 3_333, 7_001]) {
        const parts = await readOn(store, asset.assetId, { page: 1, offset: 0 }, maxChars);
        expectWholeParts(parts, original);
      }
    } finally {
      await store.dispose();
    }
  });

  it('a read of one character shows a whole pair, and every read moves forward', async () => {
    const store = new ContentAssetStore();
    try {
      const original = `a${SMILE}${CJK}b`;
      const asset = await store.storeText(original, 'tool-result', 'agent-a');
      const parts = await readOn(store, asset.assetId, { page: 1, offset: 0 }, 1);
      expect(parts).toEqual(['a', SMILE, CJK, 'b']);
    } finally {
      await store.dispose();
    }
  });

  it('a search excerpt holds whole characters at both ends', async () => {
    const store = new ContentAssetStore();
    try {
      // The excerpt's 120 characters before the match start inside the first pair; its 240 after end inside the last.
      const original = `${SMILE}${'a'.repeat(119)}NEEDLE${'b'.repeat(239)}${SMILE}TAIL`;
      const asset = await store.storeText(original, 'tool-result', 'agent-a');
      const found = await store.searchExtractedContent(asset.assetId, 'needle');
      if ('error' in found) throw new Error(found.error);
      expect(found.matches[0].excerpt).toBe(`${SMILE}${'a'.repeat(119)}NEEDLE${'b'.repeat(239)}`);
    } finally {
      await store.dispose();
    }
  });

  it('an offset that names the second half of a pair starts at the pair', async () => {
    const store = new ContentAssetStore();
    try {
      const original = 'a'.repeat(100) + SMILE + 'TAIL';
      const asset = await store.storeText(original, 'tool-result', 'agent-a');
      const read = await store.readExtractedContent(asset.assetId, { start: 1 }, { offset: 101 });
      if ('error' in read) throw new Error(read.error);
      expect(read.items[0].offset).toBe(100);
      expect(read.items[0].text).toBe(`${SMILE}TAIL`);
    } finally {
      await store.dispose();
    }
  });

  it('textContinuationAt names exactly where the next read starts when a page boundary moved to keep a pair whole', async () => {
    const store = new ContentAssetStore();
    try {
      // Pairs straddle the page boundaries at 20,000 and 60,000.
      const original = 'x'.repeat(CONTENT_ASSET_MAX_PAGE_TEXT - 1) + SMILE + 'y'.repeat(39_998) + CJK + 'z'.repeat(5_000) + 'TAIL';
      expect(original.codePointAt(59_999)).toBe(0x20bb7);
      const asset = await store.storeText(original, 'tool-result', 'agent-a');
      for (const at of [0, 19_998, 19_999, 20_001, 25_000, 39_999, 40_000, 59_998, 59_999, 60_001, original.length - 1]) {
        const next = textContinuationAt(original, at);
        const read = await store.readExtractedContent(asset.assetId, { start: next.page }, next.offset > 0 ? { offset: next.offset } : {});
        if ('error' in read) throw new Error(read.error);
        const text = read.items.map((item) => item.text ?? '').join('');
        expect(text.slice(0, 4)).toBe(original.slice(at, at + 4));
      }
      expect(textContinuationAt(original, 19_999)).toEqual({ page: 2, offset: 0 });
      expect(textContinuationAt(original, 20_001)).toEqual({ page: 2, offset: 2 });
      // A position inside a pair continues at the pair.
      expect(textContinuationAt(original, 20_000)).toEqual({ page: 2, offset: 0 });
      expect(textContinuationAt(original, 60_000)).toEqual({ page: 4, offset: 0 });
    } finally {
      await store.dispose();
    }
  });

  it('a long tool result: the preview and every read after it rebuild the result, past a moved page boundary', async () => {
    const store = new ContentAssetStore();
    try {
      const original = 'x'.repeat(19_999) + SMILE + 'y'.repeat(10_000) + CJK + 'TAIL';
      const bounded = await boundToolResultWithContinuation('mcp__example__report', original, async (text) => (await store.storeText(text, 'tool-result', 'agent-a')).assetId);
      const preview = bounded.slice(bounded.indexOf(']\n') + 2, bounded.lastIndexOf('\n\n['));
      const call = /read_extracted_content\(\{ assetId: "([^"]+)", pages: \{ start: (\d+) \}(?:, offset: (\d+))? \}\)/.exec(bounded)!;
      const parts = await readOn(store, call[1], { page: Number(call[2]), offset: Number(call[3] ?? 0) });
      expectWholeParts([preview, ...parts], original);
    } finally {
      await store.dispose();
    }
  });

  it('a long text attachment: its inlined part ends at a whole character and the read it names goes on from there', async () => {
    const store = new ContentAssetStore();
    try {
      // The stored copy starts with the block's heading and head, so pairs are placed to straddle the stored copy's
      // page boundaries at 20,000 and 120,000 (where the read the block names starts), and another the inlined part's
      // end.
      const name = 'notes.md';
      const probe: UserAttachment = { name, mime: 'text/markdown', kind: 'file', dataBase64: Buffer.from('x').toString('base64'), size: 1 };
      const head = storedTextAttachmentSource(probe)!.length - 'x\n```'.length;
      const decoded = 'a'.repeat(CONTENT_ASSET_MAX_PAGE_TEXT - head - 1) + SMILE + 'b'.repeat(99_998) + CJK + 'c'.repeat(head - 2) + SMILE + 'd'.repeat(3_000) + 'TAIL';
      expect(decoded.codePointAt(CONTENT_ASSET_MAX_PAGE_TEXT - head - 1)).toBe(0x1f600);
      expect(decoded.codePointAt(6 * CONTENT_ASSET_MAX_PAGE_TEXT - head - 1)).toBe(0x20bb7);
      expect(decoded.codePointAt(119_999)).toBe(0x1f600);
      const bytes = Buffer.from(decoded, 'utf8');
      const file: UserAttachment = { name, mime: 'text/markdown', kind: 'file', dataBase64: bytes.toString('base64'), size: bytes.length };
      const stored = storedTextAttachmentSource(file)!;
      const kept = await store.storeTextAttachment(bytes, stored);
      if ('error' in kept) throw new Error('not stored');
      file.contentAssetId = kept.assetId;
      const block = composeUserTextAttachments([file]).text;
      const inlined = block.slice(block.indexOf('```markdown\n') + '```markdown\n'.length, block.indexOf('\n```\n[Attachment'));
      const call = /pages: \{ start: (\d+) \}(?:, offset: (\d+))? \}\)/.exec(block)!;
      const parts = await readOn(store, kept.assetId, { page: Number(call[1]), offset: Number(call[2] ?? 0) });
      expectWholeParts([inlined, ...parts], `${decoded}\n\`\`\``);
      expect(block).toContain(`the first ${inlined.length.toLocaleString('en-US')} of ${decoded.length.toLocaleString('en-US')} characters are above`);
    } finally {
      await store.dispose();
    }
  });

  it('a saved section read in parts rebuilds the section, and an offset inside a pair starts at the pair', () => {
    const summary = { state: 'running', batches: 1, finalCheck: { status: 'incomplete', missingSections: [], conflicts: [], requiredInputsNotRead: 0 } } as unknown as CheckpointAttemptSummary;
    const text = 'a'.repeat(1_234) + SMILE + 'b'.repeat(2_000) + CJK + 'c'.repeat(700) + SMILE + 'TAIL';
    const batch = { sectionKey: 's1', revision: 1, checkpointId: 'cp-1', contentSha256: 'f'.repeat(64), text } as unknown as TaskCheckpointRecord;
    // How many characters a first read of 1,000 shows, so a read can be sized to end inside the first pair.
    const room = Number(/characters 0-(\d+) of/.exec(formatSavedBatches('h-1', summary, [batch], 1_000))![1]);
    const splitting = 1_000 + 1_235 - room;
    expect(formatSavedBatches('h-1', summary, [batch], splitting)).toContain('characters 0-1234 of');
    for (const maxChars of [1_000, splitting, splitting + 1, splitting + 2_001]) {
      const parts: string[] = [];
      let offset: number | undefined;
      for (let reads = 0; reads < 1_000; reads++) {
        const output = formatSavedBatches('h-1', summary, [batch], maxChars, offset === undefined ? undefined : { offset, revision: 1 });
        const span = /characters (\d+)-(\d+) of \d+\]\n/.exec(output)!;
        const shown = output.slice(span.index + span[0].length, span.index + span[0].length + Number(span[2]) - Number(span[1]));
        parts.push(shown);
        const next = /offset: (\d+) \}\)\.\]/.exec(output);
        if (!next) break;
        offset = Number(next[1]);
      }
      expectWholeParts(parts, text);
    }
    const inside = formatSavedBatches('h-1', summary, [batch], 1_000, { offset: 1_235, revision: 1 });
    expect(inside).toContain('characters 1234-');
  });
});

// v0.9.99 (audit of 036061e6, M2): the two last one-shot bounds, used when a longer result is not kept, also end at a
// whole character. What they omit is still declared.
describe('the last one-shot bounds of a tool result keep whole characters', () => {
  it.each([
    ['the model bound', (text: string) => boundToolResultForModel('mcp__example__report', text), MODEL_TOOL_RESULT_MAX_CHARS, '[Tool result truncated.'],
    ['the Codex dynamic tool bound', boundDynamicToolResult, 64 * 1024, '[UnodeAi truncated this tool result at 64 KiB.]'],
  ] as const)('%s ends before a pair the limit falls inside', (_label, bound, limit, notice) => {
    for (const character of [SMILE, CJK]) {
      const text = 'x'.repeat(limit - 1) + character + 'TAIL';
      const result = bound(text);
      expect(result).not.toMatch(LONE_SURROGATE);
      expect(Buffer.from(result, 'utf8').toString('utf8')).not.toContain('\ufffd');
      expect(result).toContain('x'.repeat(limit - 1) + '\n');
      expect(result).not.toContain(character);
      expect(result).toContain(notice);
    }
  });

  it.each([
    ['the model bound', (text: string) => boundToolResultForModel('mcp__example__report', text), MODEL_TOOL_RESULT_MAX_CHARS],
    ['the Codex dynamic tool bound', boundDynamicToolResult, 64 * 1024],
  ] as const)('%s keeps a pair that ends at the limit', (_label, bound, limit) => {
    const result = bound('x'.repeat(limit - 2) + SMILE + 'TAIL');
    expect(result).toContain('x'.repeat(limit - 2) + SMILE + '\n');
  });
});
