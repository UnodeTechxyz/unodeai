import { MarkdownBlock } from './markdown';

export const PACED_STREAM_MAX_LAG_MS = 250;
export const PACED_STREAM_MIN_DURATION_MS = 48;
export const PACED_STREAM_BASE_CHARS_PER_SECOND = 900;

/**
 * Source injected into the chat webview for the stateful pacing/reconstruction layer. Keeping this
 * here (instead of hand-copying it inside ChatViewProvider.getHtml) lets unit tests exercise the
 * exact code that production runs.
 */
export const WEBVIEW_STREAM_PACING_SOURCE = String.raw`
    const SMOOTH_STREAM_MAX_LAG_MS = ${PACED_STREAM_MAX_LAG_MS};
    const SMOOTH_STREAM_MIN_DURATION_MS = ${PACED_STREAM_MIN_DURATION_MS};
    const SMOOTH_STREAM_BASE_CHARS_PER_SECOND = ${PACED_STREAM_BASE_CHARS_PER_SECOND};
    const livePacing = new Map();

    function pacingKey(kind) {
      return kind === 'reasoning' ? 'reasoning' : 'message';
    }

    function flushAllPacing() {
      for (const [key, pace] of Array.from(livePacing.entries())) {
        if (pace.raf) cancelAnimationFrame(pace.raf);
        if (pace.root && pace.root.isConnected) {
          // Paint the full arrived content, but KEEP the entry with its complete targetBlocks. The host
          // keeps streaming replaceFrom>0 tail frames (it doesn't know the webview flushed); if we dropped
          // the entry, the next frame would rebuild targetBlocks from [] and collapse the message to its
          // tail for the rest of the turn. Marking it fully-caught-up lets pacing resume cleanly.
          replacePacedLiveBlocks(pace.root, pace, pace.targetBlocks || []);
          pace.visibleCount = pace.targetVisible;
          pace.raf = undefined;
        } else {
          livePacing.delete(key); // detached node — safe to drop
        }
      }
    }

    function applyPacedLiveBlocks(root, msg) {
      const key = pacingKey(msg.kind);
      const previous = livePacing.get(key);
      const replaceFrom = Math.max(0, Number(msg.replaceFrom) || 0);
      const previousTarget = previous ? (previous.targetBlocks || []) : [];
      const targetBlocks = previousTarget.slice(0, replaceFrom).concat(msg.blocks || []);
      const targetText = flattenBlocksText(targetBlocks);
      const stablePrefixText = flattenBlocksText(targetBlocks.slice(0, replaceFrom));
      const targetVisible = targetText.length;
      // Resume from what is already on screen, rewinding only to where the shown text stops being a prefix
      // of the new target. The previous rule clamped to the settled-block boundary instead, so every host
      // frame (16 ms apart) restarted the reveal from the START of the open paragraph: while a paragraph
      // streamed, the screen showed its first few words over and over, and the whole paragraph appeared at
      // once when the stream paused or the block settled. Blocks before replaceFrom are the same objects
      // as last frame, so the comparison can begin at the settled boundary.
      const previousText = previous ? (previous.targetText || '') : '';
      const divergence = commonPrefixLength(previousText, targetText, stablePrefixText.length);
      const startVisible = Math.min(previous ? (previous.visibleCount || 0) : 0, divergence);

      if (previous && previous.raf) {
        cancelAnimationFrame(previous.raf);
      }
      if (msg.flush || !smoothStreamingOn() || targetVisible <= startVisible) {
        const pace = {
          root, targetBlocks, targetText, targetVisible, visibleCount: targetVisible, raf: undefined,
          renderedBlocks: previous && previous.root === root ? (previous.renderedBlocks || []) : [],
        };
        replacePacedLiveBlocks(root, pace, targetBlocks);
        livePacing.set(key, pace);
        return;
      }

      const startedAt = nowMs();
      const durationMs = pacedDurationMs(targetVisible - startVisible);
      const pace = {
        root,
        targetBlocks,
        targetText,
        startVisible,
        targetVisible,
        visibleCount: startVisible,
        startedAt,
        durationMs,
        raf: undefined,
        renderedBlocks: previous && previous.root === root ? (previous.renderedBlocks || []) : [],
      };
      livePacing.set(key, pace);
      paintPacedLiveBlocks(key);
    }

    function pacedDurationMs(chars) {
      if (chars <= 0) return 0;
      const baseCharsPerMs = SMOOTH_STREAM_BASE_CHARS_PER_SECOND / 1000;
      const natural = chars / Math.max(0.001, baseCharsPerMs);
      return Math.min(SMOOTH_STREAM_MAX_LAG_MS, Math.max(SMOOTH_STREAM_MIN_DURATION_MS, natural));
    }

    function paintPacedLiveBlocks(key) {
      const pace = livePacing.get(key);
      if (!pace || !pace.root || !pace.root.isConnected) {
        livePacing.delete(key);
        return;
      }
      if (!smoothStreamingOn()) {
        replacePacedLiveBlocks(pace.root, pace, pace.targetBlocks || []);
        pace.visibleCount = pace.targetVisible;
        pace.raf = undefined;
        return;
      }
      const visible = pacedVisibleCount(pace, nowMs());
      pace.visibleCount = visible;
      const blocks = visible >= pace.targetVisible
        ? pace.targetBlocks
        : truncateBlocks(pace.targetBlocks || [], visible);
      replacePacedLiveBlocks(pace.root, pace, blocks);
      // The host only pins the transcript on its own frames; paced paints keep growing the tail for up to
      // the lag budget after the last one. Let the page follow each paint, or the reveal runs below the
      // fold and snaps up when a settle timer fires.
      if (typeof onPacedPaint === 'function') onPacedPaint(pace.root);
      if (visible < pace.targetVisible) {
        pace.raf = requestAnimationFrame(() => paintPacedLiveBlocks(key));
      } else {
        pace.raf = undefined;
      }
    }

    // A host frame names its mutable tail with replaceFrom, but smooth pacing can paint several
    // intermediate frames before the next host frame arrives. Preserve the exact block objects that
    // are already on screen in those frames; otherwise every animation frame removes and re-adds the
    // whole message, which is visible as flicker on a long streamed reply.
    function replacePacedLiveBlocks(root, pace, blocks) {
      const previous = pace.renderedBlocks || [];
      let keep = 0;
      const limit = Math.min(previous.length, (blocks || []).length);
      while (keep < limit && previous[keep] === blocks[keep]) keep++;
      replaceLiveBlocks(root, keep, (blocks || []).slice(keep));
      pace.renderedBlocks = blocks || [];
    }

    function pacedVisibleCount(pace, now) {
      const elapsed = Math.max(0, now - pace.startedAt);
      if (elapsed >= pace.durationMs) return pace.targetVisible;
      const raw = pace.startVisible + Math.ceil((pace.targetVisible - pace.startVisible) * (elapsed / Math.max(1, pace.durationMs)));
      return nextWordBoundary(pace.targetText || '', raw, pace.targetVisible);
    }

    function commonPrefixLength(a, b, from) {
      const limit = Math.min(a.length, b.length);
      let i = Math.max(0, Math.min(limit, Math.floor(from) || 0));
      while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
      return i;
    }

    function nextWordBoundary(text, requested, target) {
      const min = Math.max(0, Math.min(text.length, Math.floor(requested) || 0));
      const max = Math.max(0, Math.min(text.length, Math.floor(target) || 0));
      if (min >= max) return max;
      for (let i = min; i < max; i++) {
        if (/\s/.test(text[i])) return i + 1;
      }
      return max;
    }

    function flattenBlocksText(blocks) {
      const parts = [];
      for (const block of blocks || []) {
        if (block.type === 'heading' || block.type === 'paragraph') {
          parts.push(flattenSpansText(block.spans));
        } else if (block.type === 'list') {
          for (const item of block.items || []) parts.push(flattenSpansText(item));
        } else if (block.type === 'code') {
          parts.push(block.code || '');
        } else if (block.type === 'table') {
          for (const cell of block.header || []) parts.push(flattenSpansText(cell));
          for (const row of block.rows || []) {
            for (const cell of row || []) parts.push(flattenSpansText(cell));
          }
        }
      }
      return parts.join('\n');
    }

    function flattenSpansText(spans) {
      return (spans || []).map((span) => span.text || '').join('');
    }

    function truncateBlocks(blocks, visibleChars) {
      const budget = { left: Math.max(0, Math.floor(visibleChars) || 0) };
      const out = [];
      for (const block of blocks || []) {
        if (budget.left <= 0) break;
        const next = truncateBlock(block, budget);
        if (next) out.push(next);
      }
      return out;
    }

    function truncateBlock(block, budget) {
      // Stable fully-visible blocks retain identity. That identity lets replacePacedLiveBlocks leave
      // their DOM nodes alone while only the live markdown tail changes.
      const whole = blockTextLength(block);
      if (budget.left >= whole) {
        budget.left -= whole;
        return block;
      }
      if (block.type === 'heading' || block.type === 'paragraph') {
        const spans = truncateSpans(block.spans || [], budget);
        return spans.length ? Object.assign({}, block, { spans }) : undefined;
      }
      if (block.type === 'list') {
        const items = [];
        for (const item of block.items || []) {
          if (budget.left <= 0) break;
          const spans = truncateSpans(item, budget);
          if (spans.length) items.push(spans);
        }
        return items.length ? Object.assign({}, block, { items }) : undefined;
      }
      if (block.type === 'code') {
        const code = takeText(block.code || '', budget);
        return code ? Object.assign({}, block, { code }) : undefined;
      }
      if (block.type === 'table') {
        const header = truncateSpanRows(block.header || [], budget);
        const rows = [];
        for (const row of block.rows || []) {
          if (budget.left <= 0) break;
          const cells = truncateSpanRows(row || [], budget);
          if (cells.length) rows.push(cells);
        }
        return header.length || rows.length ? Object.assign({}, block, { header, rows }) : undefined;
      }
      return undefined;
    }

    function blockTextLength(block) {
      if (block.type === 'heading' || block.type === 'paragraph') return flattenSpansText(block.spans).length;
      if (block.type === 'list') return (block.items || []).reduce((n, item) => n + flattenSpansText(item).length, 0);
      if (block.type === 'code') return (block.code || '').length;
      if (block.type === 'table') {
        let total = 0;
        for (const cell of block.header || []) total += flattenSpansText(cell).length;
        for (const row of block.rows || []) for (const cell of row || []) total += flattenSpansText(cell).length;
        return total;
      }
      return 0;
    }

    function truncateSpanRows(rows, budget) {
      const out = [];
      for (const row of rows || []) {
        if (budget.left <= 0) break;
        const spans = truncateSpans(row || [], budget);
        if (spans.length) out.push(spans);
      }
      return out;
    }

    function truncateSpans(spans, budget) {
      const out = [];
      for (const span of spans || []) {
        if (budget.left <= 0) break;
        const text = takeText(span.text || '', budget);
        if (text) out.push(Object.assign({}, span, { text }));
      }
      return out;
    }

    function takeText(text, budget) {
      if (budget.left <= 0 || !text) return '';
      const taken = String(text).slice(0, budget.left);
      budget.left -= taken.length;
      return taken;
    }
`;

export interface PacingPlanInput {
  text: string;
  startVisible: number;
  targetVisible: number;
  startedAtMs: number;
  nowMs: number;
  maxLagMs?: number;
  minDurationMs?: number;
  baseCharsPerSecond?: number;
}

export function pacedDurationMs(
  chars: number,
  opts: {
    maxLagMs?: number;
    minDurationMs?: number;
    baseCharsPerSecond?: number;
  } = {}
): number {
  if (chars <= 0) {
    return 0;
  }
  const maxLag = opts.maxLagMs ?? PACED_STREAM_MAX_LAG_MS;
  const minDuration = opts.minDurationMs ?? PACED_STREAM_MIN_DURATION_MS;
  const baseCharsPerMs = (opts.baseCharsPerSecond ?? PACED_STREAM_BASE_CHARS_PER_SECOND) / 1000;
  const natural = chars / Math.max(0.001, baseCharsPerMs);
  return Math.min(maxLag, Math.max(minDuration, natural));
}

export function computePacedVisibleCount(input: PacingPlanInput): number {
  const start = clampCount(input.startVisible, input.text.length);
  const target = clampCount(input.targetVisible, input.text.length);
  if (target <= start) {
    return target;
  }
  const elapsed = Math.max(0, input.nowMs - input.startedAtMs);
  const duration = pacedDurationMs(target - start, input);
  if (duration <= 0 || elapsed >= duration) {
    return target;
  }
  const raw = start + Math.ceil((target - start) * (elapsed / duration));
  return nextWordBoundary(input.text, raw, target);
}

export function flattenMarkdownText(blocks: MarkdownBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
      case 'paragraph':
        parts.push(flattenSpans(block.spans));
        break;
      case 'list':
        parts.push(...block.items.map(flattenSpans));
        break;
      case 'code':
        parts.push(block.code);
        break;
      case 'table':
        parts.push(...block.header.map(flattenSpans));
        for (const row of block.rows) {
          parts.push(...row.map(flattenSpans));
        }
        break;
    }
  }
  return parts.join('\n');
}

export function truncateMarkdownBlocks(blocks: MarkdownBlock[], visibleChars: number): MarkdownBlock[] {
  const budget = { left: Math.max(0, Math.floor(visibleChars)) };
  const out: MarkdownBlock[] = [];
  for (const block of blocks) {
    if (budget.left <= 0) {
      break;
    }
    const next = truncateBlock(block, budget);
    if (next) {
      out.push(next);
    }
  }
  return out;
}

function truncateBlock(block: MarkdownBlock, budget: { left: number }): MarkdownBlock | undefined {
  const whole = markdownBlockTextLength(block);
  if (budget.left >= whole) {
    budget.left -= whole;
    return block;
  }
  switch (block.type) {
    case 'heading': {
      const spans = truncateSpans(block.spans, budget);
      return spans.length ? { ...block, spans } : undefined;
    }
    case 'paragraph': {
      const spans = truncateSpans(block.spans, budget);
      return spans.length ? { ...block, spans } : undefined;
    }
    case 'list': {
      const items: typeof block.items = [];
      for (const item of block.items) {
        if (budget.left <= 0) {
          break;
        }
        const spans = truncateSpans(item, budget);
        if (spans.length) {
          items.push(spans);
        }
      }
      return items.length ? { ...block, items } : undefined;
    }
    case 'code': {
      const code = takeText(block.code, budget);
      return code ? { ...block, code } : undefined;
    }
    case 'table': {
      const header = truncateSpanRows(block.header, budget);
      const rows: typeof block.rows = [];
      for (const row of block.rows) {
        if (budget.left <= 0) {
          break;
        }
        const cells = truncateSpanRows(row, budget);
        if (cells.length) {
          rows.push(cells);
        }
      }
      return header.length || rows.length ? { ...block, header, rows } : undefined;
    }
  }
}

function markdownBlockTextLength(block: MarkdownBlock): number {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
      return flattenSpans(block.spans).length;
    case 'list':
      return block.items.reduce((total, item) => total + flattenSpans(item).length, 0);
    case 'code':
      return block.code.length;
    case 'table':
      return block.header.reduce((total, cell) => total + flattenSpans(cell).length, 0)
        + block.rows.reduce((total, row) => total + row.reduce((rowTotal, cell) => rowTotal + flattenSpans(cell).length, 0), 0);
  }
}

function truncateSpanRows(rows: Array<Array<{ type: string; text?: string; href?: string }>>, budget: { left: number }): any[] {
  const out: any[] = [];
  for (const row of rows) {
    if (budget.left <= 0) {
      break;
    }
    const spans = truncateSpans(row as any, budget);
    if (spans.length) {
      out.push(spans);
    }
  }
  return out;
}

function truncateSpans<T extends { type: string; text?: string; href?: string }>(spans: T[], budget: { left: number }): T[] {
  const out: T[] = [];
  for (const span of spans) {
    if (budget.left <= 0) {
      break;
    }
    const text = takeText(span.text ?? '', budget);
    if (text) {
      out.push({ ...span, text });
    }
  }
  return out;
}

function flattenSpans(spans: Array<{ text?: string }>): string {
  return spans.map((span) => span.text ?? '').join('');
}

function takeText(text: string, budget: { left: number }): string {
  if (budget.left <= 0 || !text) {
    return '';
  }
  const taken = text.slice(0, budget.left);
  budget.left -= taken.length;
  return taken;
}

function nextWordBoundary(text: string, requested: number, target: number): number {
  const min = clampCount(requested, text.length);
  const max = clampCount(target, text.length);
  if (min >= max) {
    return max;
  }
  for (let i = min; i < max; i++) {
    if (/\s/.test(text[i])) {
      return i + 1;
    }
  }
  return max;
}

function clampCount(value: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(max, Math.floor(value)));
}
