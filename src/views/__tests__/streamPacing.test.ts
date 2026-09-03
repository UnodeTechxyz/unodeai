import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../markdown';
import {
  computePacedVisibleCount,
  flattenMarkdownText,
  PACED_STREAM_MAX_LAG_MS,
  truncateMarkdownBlocks,
  WEBVIEW_STREAM_PACING_SOURCE,
} from '../streamPacing';

function paragraph(text: string) {
  return { type: 'paragraph', spans: [{ type: 'text', text }] };
}

function webviewPacingHarness() {
  const painted: unknown[][] = [];
  const replaceFroms: number[] = [];
  const replaceLiveBlocks = (root: { blocks?: unknown[] }, replaceFrom: number, blocks: unknown[]) => {
    root.blocks = (root.blocks || []).slice(0, replaceFrom).concat(blocks);
    painted.push(blocks);
    replaceFroms.push(replaceFrom);
  };
  const smoothStreamingOn = () => false;
  const nowMs = () => 0;
  const requestAnimationFrame = () => 0;
  const cancelAnimationFrame = () => undefined;
  const fn = new Function(
    'replaceLiveBlocks',
    'smoothStreamingOn',
    'nowMs',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    `${WEBVIEW_STREAM_PACING_SOURCE}
return { applyPacedLiveBlocks, flushAllPacing, livePacing };`
  );
  return {
    ...(fn(replaceLiveBlocks, smoothStreamingOn, nowMs, requestAnimationFrame, cancelAnimationFrame) as {
      applyPacedLiveBlocks: (root: { blocks?: unknown[]; isConnected: boolean }, msg: Record<string, unknown>) => void;
      flushAllPacing: () => void;
      livePacing: Map<string, unknown>;
    }),
    painted,
    replaceFroms,
  };
}

describe('stream pacing', () => {
  it('reveals a large arrived burst over no more than the lag budget, not in one frame', () => {
    const text = Array.from({ length: 400 }, (_, i) => `token${i}`).join(' ');
    const start = 1000;
    const firstFrame = computePacedVisibleCount({
      text,
      startVisible: 0,
      targetVisible: text.length,
      startedAtMs: start,
      nowMs: start + 16,
    });
    const deadline = computePacedVisibleCount({
      text,
      startVisible: 0,
      targetVisible: text.length,
      startedAtMs: start,
      nowMs: start + PACED_STREAM_MAX_LAG_MS,
    });

    expect(firstFrame).toBeGreaterThan(0);
    expect(firstFrame).toBeLessThan(text.length);
    expect(deadline).toBe(text.length);
  });

  it('advances to word or whitespace boundaries instead of chopping every character', () => {
    const text = 'alpha beta gamma';
    const visible = computePacedVisibleCount({
      text,
      startVisible: 0,
      targetVisible: text.length,
      startedAtMs: 0,
      nowMs: 20,
      maxLagMs: 200,
      minDurationMs: 200,
      baseCharsPerSecond: 10,
    });

    expect(text.slice(0, visible)).toMatch(/\s$/);
    expect(text.slice(0, visible)).toBe('alpha ');
  });

  it('truncates markdown blocks without revealing text that has not arrived', () => {
    const blocks = renderMarkdown([
      '## Update',
      '',
      '- alpha beta',
      '- gamma delta',
      '',
      '```ts',
      'const hidden = true;',
      '```',
    ].join('\n'));
    const visible = truncateMarkdownBlocks(blocks, 'Update\nalpha beta\n'.length);
    const flat = flattenMarkdownText(visible);

    expect(flat).toContain('Update');
    expect(flat).toContain('alpha beta');
    expect(flat).not.toContain('gamma');
    expect(flat).not.toContain('hidden');
  });

  it('keeps the stable prefix after a mid-stream flush followed by a tail frame', () => {
    const { applyPacedLiveBlocks, flushAllPacing } = webviewPacingHarness();
    const root: { blocks?: unknown[]; isConnected: boolean } = { isConnected: true };
    const a = paragraph('Alpha');
    const b = paragraph('Bravo');
    const b2 = paragraph('Bravo updated');

    applyPacedLiveBlocks(root, { kind: 'message', replaceFrom: 0, blocks: [a] });
    applyPacedLiveBlocks(root, { kind: 'message', replaceFrom: 1, blocks: [b] });
    flushAllPacing();
    applyPacedLiveBlocks(root, { kind: 'message', replaceFrom: 1, blocks: [b2] });

    expect(root.blocks).toEqual([a, b2]);
  });

  it('does not rebuild already-rendered stable blocks when only the live tail changes', () => {
    const { applyPacedLiveBlocks, replaceFroms } = webviewPacingHarness();
    const root: { blocks?: unknown[]; isConnected: boolean } = { isConnected: true };
    const settled = paragraph('Already settled');

    applyPacedLiveBlocks(root, { kind: 'message', replaceFrom: 0, blocks: [settled, paragraph('first tail')] });
    applyPacedLiveBlocks(root, { kind: 'message', replaceFrom: 1, blocks: [paragraph('second tail')] });

    expect(replaceFroms).toEqual([0, 1]);
  });

  it('never rewinds the reveal below what is already on screen when a mid-paragraph host frame arrives', () => {
    // A controllable clock and animation-frame queue, so the paint schedule is driven by the test.
    let now = 0;
    const rafQueue: Array<() => void> = [];
    const painted: unknown[][] = [];
    const replaceLiveBlocks = (root: { blocks?: unknown[] }, replaceFrom: number, blocks: unknown[]) => {
      root.blocks = (root.blocks || []).slice(0, replaceFrom).concat(blocks);
      painted.push(blocks);
    };
    const fn = new Function(
      'replaceLiveBlocks', 'smoothStreamingOn', 'nowMs', 'requestAnimationFrame', 'cancelAnimationFrame',
      `${WEBVIEW_STREAM_PACING_SOURCE}
return { applyPacedLiveBlocks, livePacing };`
    );
    const { applyPacedLiveBlocks, livePacing } = fn(
      replaceLiveBlocks,
      () => true,
      () => now,
      (cb: () => void) => { rafQueue.push(cb); return rafQueue.length; },
      () => undefined,
    ) as {
      applyPacedLiveBlocks: (root: { blocks?: unknown[]; isConnected: boolean }, msg: Record<string, unknown>) => void;
      livePacing: Map<string, { visibleCount: number; targetVisible: number }>;
    };
    const root: { blocks?: unknown[]; isConnected: boolean } = { isConnected: true };
    const settled = paragraph('Settled block.');
    const open = 'The quick brown fox jumps over the lazy dog and keeps going';

    // Host frame 1: one settled block plus an open paragraph. Let the reveal run to roughly mid-paragraph.
    applyPacedLiveBlocks(root, { kind: 'message', replaceFrom: 0, blocks: [settled, paragraph(open)] });
    now = 30;
    rafQueue.splice(0).forEach((cb) => cb());
    const midParagraph = livePacing.get('message')!.visibleCount;
    expect(midParagraph).toBeGreaterThan('Settled block.'.length + 1);
    expect(midParagraph).toBeLessThan(livePacing.get('message')!.targetVisible);

    // Host frame 2, 16 ms later: the same open paragraph grew by a few words. replaceFrom: 1 names it as the
    // only changed block. What is already on screen is a prefix of the new target, so nothing may rewind.
    now = 46;
    applyPacedLiveBlocks(root, { kind: 'message', replaceFrom: 1, blocks: [paragraph(open + ' and going')] });
    const afterFrame2 = livePacing.get('message')!.visibleCount;

    expect(afterFrame2).toBeGreaterThanOrEqual(midParagraph);
  });

  it('reports every paced paint through onPacedPaint so the transcript can follow between host frames', () => {
    let now = 0;
    const rafQueue: Array<() => void> = [];
    let paints = 0;
    let reported = 0;
    const replaceLiveBlocks = (root: { blocks?: unknown[] }, replaceFrom: number, blocks: unknown[]) => {
      root.blocks = (root.blocks || []).slice(0, replaceFrom).concat(blocks);
      paints++;
    };
    const fn = new Function(
      'replaceLiveBlocks', 'smoothStreamingOn', 'nowMs', 'requestAnimationFrame', 'cancelAnimationFrame', 'onPacedPaint',
      `${WEBVIEW_STREAM_PACING_SOURCE}
return { applyPacedLiveBlocks, livePacing };`
    );
    const { applyPacedLiveBlocks, livePacing } = fn(
      replaceLiveBlocks,
      () => true,
      () => now,
      (cb: () => void) => { rafQueue.push(cb); return rafQueue.length; },
      () => undefined,
      () => { reported++; },
    ) as {
      applyPacedLiveBlocks: (root: { blocks?: unknown[]; isConnected: boolean }, msg: Record<string, unknown>) => void;
      livePacing: Map<string, { visibleCount: number; targetVisible: number }>;
    };
    const root: { blocks?: unknown[]; isConnected: boolean } = { isConnected: true };

    applyPacedLiveBlocks(root, { kind: 'message', replaceFrom: 0, blocks: [paragraph('one two three four five six seven')] });
    // Drive the animation to completion: each queued frame is one paced paint.
    while (rafQueue.length) {
      now += 16;
      rafQueue.splice(0).forEach((cb) => cb());
    }

    expect(livePacing.get('message')!.visibleCount).toBe(livePacing.get('message')!.targetVisible);
    expect(paints).toBeGreaterThan(1);
    expect(reported).toBe(paints);
  });
});
