export type MarkdownInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string };

export type TableAlign = 'left' | 'center' | 'right' | null;

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3; spans: MarkdownInline[] }
  | { type: 'paragraph'; spans: MarkdownInline[] }
  | { type: 'list'; items: MarkdownInline[][] }
  | { type: 'code'; language: string; code: string }
  | { type: 'table'; align: TableAlign[]; header: MarkdownInline[][]; rows: MarkdownInline[][][] };

const FENCE_RE = /^```([A-Za-z0-9_-]*)\s*$/;
/**
 * ONE regex for "this line is a heading" — used both to build the heading block and to tell the paragraph
 * fallback to keep its hands off. They used to be two different regexes, and the gap between them was fatal:
 * the heading branch required text after the hashes (`(.+)`), the paragraph guard did not. So `# ` — the
 * state EVERY streamed heading passes through, for one frame, before its title arrives — was claimed by
 * neither. The paragraph loop consumed nothing, `i` never advanced, and the outer loop pushed empty
 * paragraphs until V8 died with "Ineffective mark-compacts near heap limit" and took the extension host with
 * it. If you change this, change it once.
 */
const HEADING_RE = /^(#{1,3})\s+(.+)$/;
const LIST_ITEM_RE = /^\s*[-*]\s+/;

let renderHookForTest: ((source: string) => void) | undefined;

export function setMarkdownRenderHookForTest(hook: ((source: string) => void) | undefined): void {
  renderHookForTest = hook;
}

export function renderMarkdown(source: string): MarkdownBlock[] {
  renderHookForTest?.(String(source));
  const lines = String(source).replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence) {
      const language = fence[1] ?? '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        i++;
      }
      blocks.push({ type: 'code', language, code: codeLines.join('\n') });
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        spans: parseInline(heading[2].trim()),
      });
      i++;
      continue;
    }

    if (LIST_ITEM_RE.test(line)) {
      const items: MarkdownInline[][] = [];
      while (i < lines.length && LIST_ITEM_RE.test(lines[i])) {
        items.push(parseInline(lines[i].replace(LIST_ITEM_RE, '').trim()));
        i++;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    // GFM table: a header row (contains a pipe) immediately followed by a separator row (| --- | :--: |).
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = parseTableRow(line);
      const cols = header.length;
      const align = fitColumns(parseTableAlign(lines[i + 1]), cols, () => null as TableAlign);
      i += 2;
      const rows: MarkdownInline[][][] = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|') && !isTableSeparator(lines[i])) {
        rows.push(fitColumns(parseTableRow(lines[i]), cols, () => [{ type: 'text', text: '' }]));
        i++;
      }
      blocks.push({ type: 'table', align, header, rows });
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !FENCE_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !LIST_ITEM_RE.test(lines[i])
    ) {
      paragraph.push(lines[i].trim());
      i++;
    }
    if (paragraph.length === 0) {
      // Paragraph is the FALLBACK: every other branch is entered by a positive match and consumes its line,
      // so if we reach here and take nothing, no branch owns this line and `i` never moves — an infinite
      // loop that fills the heap. This parser runs on PARTIAL text, 60 times a second, so a line no rule
      // claims is not a hypothetical. Consume it as literal text and move on. Belt and braces: the regex gap
      // that caused this is closed above, and this makes a future one impossible rather than fatal.
      paragraph.push(line.trim());
      i++;
    }
    blocks.push({ type: 'paragraph', spans: parseInline(paragraph.join(' ')) });
  }

  return blocks;
}

export interface LiveMarkdownFrame {
  replaceFrom: number;
  blocks: MarkdownBlock[];
  allBlocks: MarkdownBlock[];
}

/**
 * A streaming markdown buffer that re-renders only what can still change.
 *
 * The first version re-parsed the ENTIRE accumulated text on every frame, and `firstChangedBlockIndex`
 * JSON.stringify'd every block twice to diff it — all at 60 fps (LIVE_MARKDOWN_FRAME_MS = 16). That is O(n)
 * work per frame over a buffer that only grows, i.e. O(n²) per turn, and it killed the extension host: a
 * long streamed reply drove the allocation rate past what GC could reclaim and V8 died with
 * "Ineffective mark-compacts near heap limit" at a 4 GB heap. The CPU profile was unambiguous — 83.9% of
 * samples in snapshot(), 16% in GC, nothing else running.
 *
 * The fix rests on a property of the parser: `renderMarkdown` is line-local. Its only cross-line state is
 * the code fence, so once a blank line closes a block OUTSIDE a fence, nothing before it can ever change
 * again. Everything up to that boundary is parsed exactly once into `stableBlocks` and never touched again,
 * and those blocks are kept as the SAME objects — so the diff can compare them by reference instead of
 * stringifying them. Each frame then costs O(unstable tail), not O(everything).
 */
export class LiveMarkdown {
  private text = '';
  private sentBlocks: MarkdownBlock[] = [];
  private dirty = false;
  /** Blocks before `stableChars`: parsed once, reused by identity forever. */
  private stableBlocks: MarkdownBlock[] = [];
  private stableChars = 0;
  /** Incremental scan for the stable boundary — advanced only over the bytes that just arrived, so finding
   *  it never costs O(text) either. */
  private boundary = 0;
  private scanPos = 0;
  private scanLineStart = 0;
  private scanFenceOpen = false;

  constructor(private readonly parse: (source: string) => MarkdownBlock[] = renderMarkdown) {}

  push(delta: string): void {
    if (delta) {
      this.text += String(delta).replace(/\r\n/g, '\n');
      this.dirty = true;
      this.advanceBoundary();
    }
  }

  getText(): string {
    return this.text;
  }

  /**
   * How much text EVERY future frame must re-parse — the region past the last settled boundary.
   *
   * Deliberately measured from `boundary`, not `stableChars`: text between them is settled and will be
   * parsed exactly once, on the next frame, and then never again. Only the region beyond the boundary is
   * re-parsed frame after frame. Getting this wrong makes a perfectly ordinary 17k-character prose reply
   * look "expensive" the instant it arrives, when in truth it settles on its first frame and every frame
   * after that is trivial.
   *
   * The caller backs off the frame rate when this is large — which happens only when a single enormous
   * block (a long code fence, a wide table) leaves the boundary unable to advance, so the live tail really
   * IS the whole document.
   */
  liveTailLength(): number {
    return this.text.length - this.boundary;
  }

  snapshot(): LiveMarkdownFrame | undefined {
    if (!this.dirty) {
      return undefined;
    }
    const next = this.renderIncrementally();
    const replaceFrom = firstChangedBlockIndex(this.sentBlocks, next);
    this.dirty = false;
    if (replaceFrom === this.sentBlocks.length && replaceFrom === next.length) {
      this.sentBlocks = next;
      return undefined;
    }
    const frame = {
      replaceFrom,
      blocks: next.slice(replaceFrom),
      allBlocks: next,
    };
    this.sentBlocks = next;
    return frame;
  }

  finish(): MarkdownBlock[] {
    if (!this.dirty) {
      return this.sentBlocks;
    }
    const next = this.renderIncrementally();
    this.sentBlocks = next;
    this.dirty = false;
    return next;
  }

  /** Settle everything the boundary has passed, then parse ONLY the live tail. Splitting at a blank line
   *  outside a fence is safe precisely because every block type here is a run of adjacent lines terminated
   *  by one: parsing the halves and concatenating gives the same blocks as parsing the whole. */
  private renderIncrementally(): MarkdownBlock[] {
    if (this.boundary > this.stableChars) {
      const settled = this.parse(this.text.slice(this.stableChars, this.boundary));
      if (settled.length > 0) {
        this.stableBlocks = this.stableBlocks.concat(settled);
      }
      this.stableChars = this.boundary;
    }
    const tail = this.parse(this.text.slice(this.stableChars));
    return tail.length > 0 ? this.stableBlocks.concat(tail) : this.stableBlocks;
  }

  /** Scan only the newly-arrived bytes for the last blank line that is not inside a code fence. Uses the
   *  raw (untrimmed) line for the fence test, exactly as renderMarkdown does, so the two agree on what is
   *  fenced — disagreeing would settle a boundary INSIDE a code block and corrupt it. */
  private advanceBoundary(): void {
    for (let i = this.scanPos; i < this.text.length; i++) {
      if (this.text[i] !== '\n') {
        continue;
      }
      const line = this.text.slice(this.scanLineStart, i);
      if (FENCE_RE.test(line)) {
        this.scanFenceOpen = !this.scanFenceOpen;
      } else if (!this.scanFenceOpen && line.trim() === '') {
        this.boundary = i + 1;
      }
      this.scanLineStart = i + 1;
    }
    this.scanPos = this.text.length;
  }
}

function firstChangedBlockIndex(previous: MarkdownBlock[], next: MarkdownBlock[]): number {
  const limit = Math.min(previous.length, next.length);
  for (let i = 0; i < limit; i++) {
    // LiveMarkdown reuses a settled block's exact object across frames, so identity settles the whole stable
    // prefix for free. Without this, the diff JSON.stringify'd every block of the document twice per frame,
    // 60 times a second — half of the O(n²) that OOM'd the extension host.
    if (previous[i] === next[i]) {
      continue;
    }
    if (blockSignature(previous[i]) !== blockSignature(next[i])) {
      return i;
    }
  }
  return limit;
}

function blockSignature(block: MarkdownBlock): string {
  return JSON.stringify(block);
}

export function renderMarkdownToSafeHtml(source: string): string {
  return renderMarkdown(source).map(blockToHtml).join('');
}

export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseInline(source: string): MarkdownInline[] {
  const tokens: MarkdownInline[] = [];
  let rest = source;

  while (rest.length > 0) {
    const match = nextInline(rest);
    if (!match) {
      tokens.push({ type: 'text', text: rest });
      break;
    }
    if (match.index > 0) {
      tokens.push({ type: 'text', text: rest.slice(0, match.index) });
    }
    tokens.push(match.token);
    rest = rest.slice(match.index + match.length);
  }

  return tokens;
}

function nextInline(source: string): { index: number; length: number; token: MarkdownInline } | undefined {
  const patterns: Array<{ re: RegExp; toToken: (m: RegExpMatchArray) => MarkdownInline | undefined }> = [
    {
      re: /`([^`]+)`/,
      toToken: (m) => ({ type: 'code', text: m[1] }),
    },
    {
      re: /\[([^\]]+)\]\(([^)\s]+)\)/,
      toToken: (m) => ({ type: 'link', text: m[1], href: sanitizeHref(m[2]) }),
    },
    {
      re: /\*\*([^*]+)\*\*/,
      toToken: (m) => ({ type: 'strong', text: m[1] }),
    },
    {
      re: /\*([^*]+)\*/,
      toToken: (m) => ({ type: 'em', text: m[1] }),
    },
  ];

  let best: { index: number; length: number; token: MarkdownInline } | undefined;
  for (const pattern of patterns) {
    const match = source.match(pattern.re);
    if (!match || match.index === undefined) {
      continue;
    }
    const token = pattern.toToken(match);
    if (!token) {
      continue;
    }
    if (!best || match.index < best.index) {
      best = { index: match.index, length: match[0].length, token };
    }
  }
  return best;
}

/** Split a table row into trimmed cells. Drops the optional leading/trailing border pipe, and — unlike a
 *  raw split('|') — does NOT split on an escaped pipe (\|) or a pipe inside an inline-code span (`a|b`). */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) { s = s.slice(1); }
  if (s.endsWith('|') && !/\\\|$/.test(s)) { s = s.slice(0, -1); } // trailing border pipe (not an escaped \|)
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; } // escaped pipe → literal in the cell
    if (ch === '`') { inCode = !inCode; cur += ch; continue; }            // toggle inline-code span
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Pad/truncate a row's cells to the table's column count so a short/long body row still aligns. */
function fitColumns<T>(cells: T[], cols: number, fill: () => T): T[] {
  const out = cells.slice(0, cols);
  while (out.length < cols) { out.push(fill()); }
  return out;
}

/** A GFM table separator row: contains a pipe, and every cell is dashes with optional colons (:--, :-:, --:). */
function isTableSeparator(line: string): boolean {
  if (!line.includes('|') || !line.includes('-')) {
    return false;
  }
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function parseTableRow(line: string): MarkdownInline[][] {
  return splitTableRow(line).map((cell) => parseInline(cell));
}

function parseTableAlign(separator: string): TableAlign[] {
  return splitTableRow(separator).map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) { return 'center'; }
    if (right) { return 'right'; }
    if (left) { return 'left'; }
    return null;
  });
}

function sanitizeHref(href: string): string {
  if (/^https?:\/\//i.test(href)) {
    return href;
  }
  return '#';
}

function blockToHtml(block: MarkdownBlock): string {
  switch (block.type) {
    case 'heading':
      return `<h${block.level}>${inlineToHtml(block.spans)}</h${block.level}>`;
    case 'paragraph':
      return `<p>${inlineToHtml(block.spans)}</p>`;
    case 'list':
      return `<ul>${block.items.map((item) => `<li>${inlineToHtml(item)}</li>`).join('')}</ul>`;
    case 'code':
      return `<pre><code data-language="${escapeHtml(block.language)}">${escapeHtml(block.code)}</code></pre>`;
    case 'table': {
      const alignAttr = (i: number) => (block.align[i] ? ` style="text-align:${block.align[i]}"` : '');
      const head = `<thead><tr>${block.header.map((c, i) => `<th${alignAttr(i)}>${inlineToHtml(c)}</th>`).join('')}</tr></thead>`;
      const body = `<tbody>${block.rows.map((r) => `<tr>${r.map((c, i) => `<td${alignAttr(i)}>${inlineToHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
      return `<table>${head}${body}</table>`;
    }
  }
}

function inlineToHtml(spans: MarkdownInline[]): string {
  return spans.map((span) => {
    switch (span.type) {
      case 'text':
        return escapeHtml(span.text);
      case 'strong':
        return `<strong>${escapeHtml(span.text)}</strong>`;
      case 'em':
        return `<em>${escapeHtml(span.text)}</em>`;
      case 'code':
        return `<code>${escapeHtml(span.text)}</code>`;
      case 'link':
        return `<a href="${escapeHtml(span.href)}">${escapeHtml(span.text)}</a>`;
    }
  }).join('');
}
