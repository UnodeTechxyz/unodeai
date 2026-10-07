import { describe, expect, it } from 'vitest';
import { LiveMarkdown, renderMarkdown, renderMarkdownToSafeHtml } from '../markdown';

describe('markdown renderer', () => {
  it('renders headings, emphasis, lists, links, inline code, and fenced code', () => {
    const blocks = renderMarkdown([
      '## Update',
      'This is **bold**, *kind*, `code`, and [Roam](https://example.com).',
      '',
      '- first',
      '- second',
      '',
      '```ts',
      'const value: string = "ok";',
      '```',
    ].join('\n'));

    expect(blocks[0]).toMatchObject({ type: 'heading', level: 2 });
    expect(blocks[1]).toMatchObject({ type: 'paragraph' });
    expect(blocks[2]).toMatchObject({ type: 'list' });
    expect(blocks[3]).toEqual({ type: 'code', language: 'ts', code: 'const value: string = "ok";' });
  });

  it('escapes XSS payloads in the safe HTML output', () => {
    const html = renderMarkdownToSafeHtml('Hello <img src=x onerror=alert(1)> and [bad](javascript:alert(1))');

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('href="#"');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:alert');
  });

  it('escapes fenced code instead of treating it as markup', () => {
    const html = renderMarkdownToSafeHtml(['```html', '<script>alert(1)</script>', '```'].join('\n'));

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('parses a GFM table (header, alignment, rows, inline spans in cells)', () => {
    const blocks = renderMarkdown([
      '| Feature | Cursor | UnodeAi |',
      '|---|:---:|---:|',
      '| Single agent | ✅ | ✅ |',
      '| **PM → delegate** | ❌ | ✅ |',
    ].join('\n'));
    expect(blocks).toHaveLength(1);
    const t = blocks[0] as Extract<ReturnType<typeof renderMarkdown>[number], { type: 'table' }>;
    expect(t.type).toBe('table');
    expect(t.header.map((c) => c.map((s) => (s as any).text).join(''))).toEqual(['Feature', 'Cursor', 'UnodeAi']);
    expect(t.align).toEqual([null, 'center', 'right']);
    expect(t.rows).toHaveLength(2);
    expect((t.rows[1][0][0] as any).type).toBe('strong'); // **PM → delegate** stays bold in the cell
  });

  it('renders a table to safe HTML (thead/tbody, alignment)', () => {
    const html = renderMarkdownToSafeHtml(['| A | B |', '|:--|--:|', '| 1 | 2 |'].join('\n'));
    expect(html).toContain('<table>');
    expect(html).toContain('<th style="text-align:left">A</th>');
    expect(html).toContain('<th style="text-align:right">B</th>');
    expect(html).toContain('<td style="text-align:left">1</td>');
  });

  it('does NOT treat a stray pipe in prose as a table', () => {
    const blocks = renderMarkdown('Use the a | b operator for bitwise or.');
    expect(blocks[0].type).toBe('paragraph');
  });

  it('does not split on an escaped pipe or a pipe inside inline code (Codex review)', () => {
    const blocks = renderMarkdown([
      '| Expr | Meaning |',
      '|---|---|',
      '| a \\| b | escaped pipe |',
      '| `x|y` | code pipe |',
    ].join('\n'));
    const t = blocks[0] as Extract<ReturnType<typeof renderMarkdown>[number], { type: 'table' }>;
    expect(t.header).toHaveLength(2);
    // Each body row must still have exactly 2 cells — the pipe in the first cell is NOT a delimiter.
    expect(t.rows[0]).toHaveLength(2);
    expect(t.rows[1]).toHaveLength(2);
    expect((t.rows[0][0][0] as any).text).toBe('a | b');         // \| became a literal pipe
    expect((t.rows[1][0][0] as any)).toMatchObject({ type: 'code', text: 'x|y' }); // code span kept its pipe
  });

  it('normalizes short/long body rows to the header column count', () => {
    const blocks = renderMarkdown(['| A | B | C |', '|---|---|---|', '| 1 |', '| 1 | 2 | 3 | 4 |'].join('\n'));
    const t = blocks[0] as Extract<ReturnType<typeof renderMarkdown>[number], { type: 'table' }>;
    expect(t.rows[0]).toHaveLength(3); // padded
    expect(t.rows[1]).toHaveLength(3); // truncated
  });

  it('renders an unclosed fenced block while markdown is still streaming', () => {
    const blocks = renderMarkdown(['```ts', 'const value = 1;'].join('\n'));

    expect(blocks).toEqual([{ type: 'code', language: 'ts', code: 'const value = 1;' }]);
  });

  it('streams markdown as replace-from block tails and finalizes to the same blocks', () => {
    const live = new LiveMarkdown();
    live.push(['Intro', '', '- one'].join('\n'));
    const first = live.snapshot();
    expect(first?.replaceFrom).toBe(0);
    expect(first?.allBlocks).toEqual(renderMarkdown(['Intro', '', '- one'].join('\n')));

    live.push('\n- two');
    const second = live.snapshot();
    expect(second?.replaceFrom).toBe(1);
    expect(second?.blocks).toEqual(renderMarkdown(['- one', '- two'].join('\n')));

    const finalText = ['Intro', '', '- one', '- two'].join('\n');
    expect(live.finish()).toEqual(renderMarkdown(finalText));
  });

  // ─── The one that actually killed the extension host ─────────────────────────────────────────────────
  //
  // "# " — a heading that has been streamed as far as its space, and not yet its title. Every heading any
  // model ever writes passes through this state for one frame.
  //
  // The heading branch required text after the hashes; the paragraph fallback's "not mine, that's a
  // heading" guard did not. So NO branch claimed the line: the paragraph loop consumed nothing, `i` never
  // advanced, and the outer while pushed empty paragraphs forever. V8 died with "Ineffective mark-compacts
  // near heap limit" at a 4 GB heap and took the whole extension host with it.
  //
  // If this test ever hangs or OOMs instead of failing, that IS the bug.
  it('terminates on a heading that has streamed only as far as its space', () => {
    expect(renderMarkdown('# ')).toEqual([{ type: 'paragraph', spans: [{ type: 'text', text: '#' }] }]);
    expect(renderMarkdown('## ')).toHaveLength(1);
    expect(renderMarkdown('### ')).toHaveLength(1);
    // ...and the very next character makes it a real heading, as it should.
    expect(renderMarkdown('# T')).toEqual([{ type: 'heading', level: 1, spans: [{ type: 'text', text: 'T' }] }]);
  });

  it('always consumes a line, whatever it is — a parser on partial input may never spin', () => {
    // Every prefix of a document with headings, lists, tables and fences. Any prefix that no rule claims
    // would hang here rather than fail, which is precisely why this is a loop over every prefix.
    const doc = ['# H', '', '- a', '', '| x |', '|---|', '| y |', '', '```js', 'z();', '```', '', '#', '## ', 'p'].join('\n');
    for (let n = 0; n <= doc.length; n++) {
      expect(() => renderMarkdown(doc.slice(0, n))).not.toThrow();
    }
  });

  // The extension host died with "JavaScript heap out of memory" at a 4 GB heap while streaming a reply.
  // The CPU profile: 83.9% of samples in LiveMarkdown.snapshot(), 16% in GC. It re-parsed the ENTIRE
  // accumulated text on every frame, at 60 fps — O(n) work over a buffer that only grows.
  //
  // So this asserts the WORK, not the output. Every other test here passes just as happily on the quadratic
  // version; only a test that counts what gets parsed can tell the two apart.
  it('re-parses only the live tail — a settled prefix is never parsed twice', () => {
    const parsedChars: number[] = [];
    const live = new LiveMarkdown((source) => {
      parsedChars.push(source.length);
      return renderMarkdown(source);
    });

    live.push('A settled paragraph.\n\n'.repeat(400)); // ~8.8k chars, all of it closed by blank lines
    live.snapshot();
    parsedChars.length = 0;

    for (let i = 0; i < 30; i++) {
      live.push('x');
      live.snapshot();
    }

    // Each frame parses the ~30-char live tail. The quadratic version parsed all 8,800 every single time.
    expect(Math.max(...parsedChars)).toBeLessThan(100);
  });

  it('keeps a settled block as the same object, so the frame diff never has to stringify it', () => {
    const live = new LiveMarkdown();
    live.push('Settled.\n\nlive');
    const first = live.snapshot();
    live.push(' text');
    const second = live.snapshot();

    // Identity, not equality: this is what lets firstChangedBlockIndex skip the whole stable prefix for free.
    expect(second!.allBlocks[0]).toBe(first!.allBlocks[0]);
    expect(second!.replaceFrom).toBe(1); // ...and the settled block is correctly reported as unchanged
  });

  // The boundary is a blank line — but a blank line INSIDE a code fence is content, not a block end.
  // Settling there would cut a code block in half. Fed one character at a time, the worst case for the
  // incremental scan.
  it('never settles a boundary inside a code fence', () => {
    const text = ['Intro.', '', '```js', 'a();', '', 'b();', '```', '', 'After.'].join('\n');
    const live = new LiveMarkdown();
    for (const ch of text) {
      live.push(ch);
    }
    expect(live.finish()).toEqual(renderMarkdown(text));
  });

  it('streams to exactly the same blocks as a single parse, character by character', () => {
    const text = [
      '# Title', '', 'A paragraph with **bold**.', '', '- one', '- two', '',
      '| A | B |', '|---|---|', '| 1 | 2 |', '', '```ts', 'const x = 1;', '', 'const y = 2;', '```', '', 'Done.',
    ].join('\n');
    const live = new LiveMarkdown();
    for (const ch of text) {
      live.push(ch);
      live.snapshot();
    }
    expect(live.finish()).toEqual(renderMarkdown(text));
  });

  it('replaces from an earlier block when a streamed table becomes structurally valid', () => {
    const live = new LiveMarkdown();
    live.push('| Area | Status |');
    const first = live.snapshot();
    expect(first?.allBlocks).toEqual(renderMarkdown('| Area | Status |'));

    live.push(['', '|---|---|', '| Streaming | fixed |', '', 'Final paragraph.'].join('\n'));
    const second = live.snapshot();
    const finalText = [
      '| Area | Status |',
      '|---|---|',
      '| Streaming | fixed |',
      '',
      'Final paragraph.',
    ].join('\n');

    expect(second?.replaceFrom).toBe(0);
    expect(second?.blocks).toEqual(renderMarkdown(finalText));
    expect(live.finish()).toEqual(renderMarkdown(finalText));
  });
});
