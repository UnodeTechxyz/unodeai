/**
 * F1: Unit tests for read_file pagination in WorkspaceTools.
 * Pagination is LINE-based (offset = 0-indexed start line, limit = max lines) — the convention
 * models expect; byte offsets used to confuse agents into reading tiny fragments.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContentAssetStore } from '../content/ContentAssetStore';
import { compileTaskContract, TaskInputResolver } from './TaskContract';
import {
  LINE_NUMBERS_PARAMETER_DESCRIPTION,
  LINE_NUMBERS_REVIEW_CITATION_SUFFIX,
  WorkspaceTools,
  formatNumberedPaginationFooter,
  formatPaginationFooter,
  lineNumbersParameterDescription,
  receiptTextSize,
} from './WorkspaceTools';

function storedZip(entries: Array<{ name: string; text: string }>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.text, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const record = Buffer.concat([local, name, data]);
    locals.push(record);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, name]));
    offset += record.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

// ─── formatPaginationFooter pure function ──────────────────────────────

describe('formatPaginationFooter', () => {
  it('formats correctly when reading from the start', () => {
    expect(formatPaginationFooter(0, 50, 818)).toBe(
      '…[showing lines 0–50 of 818 total. Use offset=50 to continue.]'
    );
  });

  it('formats correctly for a middle slice', () => {
    expect(formatPaginationFooter(50, 90, 818)).toBe(
      '…[showing lines 50–90 of 818 total. Use offset=90 to continue.]'
    );
  });

  it('points offset at the next line to continue', () => {
    expect(formatPaginationFooter(0, 100, 500)).toContain('Use offset=100 to continue.');
  });

  it('reports the total line count so the agent knows the full extent', () => {
    expect(formatPaginationFooter(0, 10, 818)).toContain('of 818 total');
  });
});

// ─── Real read_file behaviour against the filesystem ───────────────────

describe('read_file line pagination', () => {
  // 200 lines: "line0".."line199"
  const content = Array.from({ length: 200 }, (_, i) => `line${i}`).join('\n');

  async function withTools(run: (tools: WorkspaceTools) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-readfile-'));
    await fs.writeFile(path.join(root, 'big.txt'), content, 'utf8');
    const tools = new WorkspaceTools(root, new Set(['read']));
    try {
      await run(tools);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it('reads a line window via offset + limit (not a byte fragment)', async () => {
    await withTools(async (tools) => {
      const out = await tools.runText('read_file', { path: 'big.txt', offset: 10, limit: 3 });
      // Three whole lines, in order — the bug was returning a 3-BYTE fragment here.
      expect(out).toContain('line10\nline11\nline12');
      expect(out).not.toContain('line13');
      expect(out).toContain('…[showing lines 10–13 of 200 total. Use offset=13 to continue.]');
    });
  });

  it('returns the whole file with no footer when it fits', async () => {
    await withTools(async (tools) => {
      const out = await tools.runText('read_file', { path: 'big.txt' });
      expect(out).toContain('line0\n');
      expect(out).toContain('line199');
      expect(out).not.toContain('showing lines');
    });
  });

  it('errors when offset is past the end (by line count, not byte count)', async () => {
    await withTools(async (tools) => {
      const out = await tools.runText('read_file', { path: 'big.txt', offset: 5000 });
      expect(out).toMatch(/offset 5000 is beyond the end of the file \(200 lines\)/);
    });
  });

  it('reads to the end from an offset', async () => {
    await withTools(async (tools) => {
      const out = await tools.runText('read_file', { path: 'big.txt', offset: 198 });
      expect(out).toContain('line198\nline199');
    });
  });

  it('gives an actionable hint (not a raw ENOENT) for a missing in-workspace path', async () => {
    await withTools(async (tools) => {
      const out = await tools.runText('read_file', { path: 'src/marketplace/agents.json' });
      expect(out).toMatch(/not found/i);
      expect(out).toContain('list_dir');
      expect(out).not.toMatch(/ENOENT|realpath/); // the confusing raw error that caused flailing
    });
  });
});

describe('read_file local document extraction', () => {
  async function withDocument(name: string, bytes: Buffer, run: (tools: WorkspaceTools) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-read-document-'));
    await fs.writeFile(path.join(root, name), bytes);
    try {
      await run(new WorkspaceTools(root, new Set(['read'])));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it('returns DOCX and PPTX text directly from read_file, without a content receipt', async () => {
    await withDocument('brief.docx', storedZip([{ name: 'word/document.xml', text: '<w:document><w:p><w:r><w:t>DOCX direct text</w:t></w:r></w:p></w:document>' }]), async (tools) => {
      const output = await tools.runText('read_file', { path: 'brief.docx' });
      expect(output).toContain('DOCX direct text');
      expect(output).not.toContain('Asset content-');
    });
    await withDocument('slides.pptx', storedZip([{ name: 'ppt/slides/slide2.xml', text: '<p:sld><a:t>Second slide</a:t></p:sld>' }, { name: 'ppt/slides/slide1.xml', text: '<p:sld><a:t>First slide</a:t></p:sld>' }]), async (tools) => {
      const output = await tools.runText('read_file', { path: 'slides.pptx' });
      expect(output).toContain('Slide 1: First slide');
      expect(output).toContain('Slide 2: Second slide');
    });
  });

  it('continues to refuse a plain ZIP as binary', async () => {
    await withDocument('archive.zip', storedZip([{ name: 'notes.txt', text: 'not an Office document' }]), async (tools) => {
      await expect(tools.runText('read_file', { path: 'archive.zip' })).resolves.toMatch(/binary|not read as text/i);
    });
  });
});

// ─── v0.9.94: line-numbered reads and their receipts ───────────────────

describe('formatNumberedPaginationFooter', () => {
  it('speaks in the numbers the page displays and gives the 0-indexed offset of the next line', () => {
    expect(formatNumberedPaginationFooter(11, 13, 200)).toBe(
      '…[showing numbered lines 11–13 of 200. Use offset=13 to continue.]'
    );
  });

  it('says the file ended instead of offering an offset past it', () => {
    expect(formatNumberedPaginationFooter(198, 200, 200)).toBe(
      '…[showing numbered lines 198–200 of 200, the end of the file.]'
    );
  });
});

describe('read_file line numbers', () => {
  async function withFiles(
    files: Record<string, string | Buffer>,
    run: (tools: WorkspaceTools, root: string) => Promise<void>,
  ): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-numbered-read-'));
    for (const [name, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), content);
    }
    try {
      await run(new WorkspaceTools(root, new Set(['read'])), root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  /** The numbered lines of a result: everything between the receipt line and any host footer or note. */
  function numberedLines(output: string): string[] {
    return output.split('\n').slice(1).filter((line) => /^\d+\t/.test(line));
  }

  it('numbers an LF file from 1, issues receipt R1 for the whole view and leaves readContent as the file text', async () => {
    await withFiles({ 'src/a.ts': 'alpha\nbeta\ngamma\n' }, async (tools) => {
      const plain = await tools.run('read_file', { path: 'src/a.ts' });
      const numbered = await tools.run('read_file', { path: 'src/a.ts', line_numbers: true });

      expect(numbered.output).toBe(
        '[read receipt R1: src/a.ts lines 1-3 of 3, the whole file. To cite these lines, use readReceiptId "R1" '
        + 'with this path and line numbers inside this range.]\n1\talpha\n2\tbeta\n3\tgamma'
      );
      // The bytes the read stands for are the same with and without numbers.
      expect(numbered.readContent).toBe('alpha\nbeta\ngamma\n');
      expect(numbered.readContent).toBe(plain.readContent);
      expect(plain.output).toBe('alpha\nbeta\ngamma\n');
      expect(plain.readReceipt).toBeUndefined();
      expect(numbered.readReceipt).toMatchObject({ id: 'R1', path: 'src/a.ts', startLine: 1, endLine: 3, coverage: 'complete' });
    });
  });

  it('counts a file without a final newline the same way and never numbers the empty piece after one', async () => {
    await withFiles({ 'with.txt': 'one\ntwo\n', 'without.txt': 'one\ntwo', 'blank-last.txt': 'one\n\n' }, async (tools) => {
      const withNewline = await tools.run('read_file', { path: 'with.txt', line_numbers: true });
      const without = await tools.run('read_file', { path: 'without.txt', line_numbers: true });
      const blankLast = await tools.run('read_file', { path: 'blank-last.txt', line_numbers: true });

      expect(numberedLines(withNewline.output)).toEqual(['1\tone', '2\ttwo']);
      expect(numberedLines(without.output)).toEqual(['1\tone', '2\ttwo']);
      expect(withNewline.readReceipt).toMatchObject({ startLine: 1, endLine: 2, coverage: 'complete' });
      expect(without.readReceipt).toMatchObject({ startLine: 1, endLine: 2, coverage: 'complete' });
      // A real empty line is a line and gets its number; only the piece after the last newline is not one.
      expect(numberedLines(blankLast.output)).toEqual(['1\tone', '2\t']);
      expect(blankLast.readReceipt).toMatchObject({ endLine: 2 });
    });
  });

  it('numbers a CRLF file by its lines and keeps every carriage return where it was', async () => {
    const crlf = 'first\r\nsecond\r\n\r\nfourth\r\n';
    await withFiles({ 'win.txt': crlf }, async (tools) => {
      const plain = await tools.run('read_file', { path: 'win.txt' });
      const numbered = await tools.run('read_file', { path: 'win.txt', line_numbers: true });

      expect(numberedLines(numbered.output)).toEqual(['1\tfirst\r', '2\tsecond\r', '3\t\r', '4\tfourth\r']);
      expect(numbered.readContent).toBe(crlf);
      expect(numbered.readContent).toBe(plain.readContent);
      expect(numbered.readReceipt).toMatchObject({ startLine: 1, endLine: 4, coverage: 'complete' });
    });
  });

  it('does not treat a lone carriage return or a Unicode line separator as a line break', async () => {
    const tricky = [
      `old mac${'\r'}still line one`,
      `separator${String.fromCharCode(0x2028)}still line two${String.fromCharCode(0x2029)}and still`,
      `next line${String.fromCharCode(0x85)}still line three`,
    ].join('\n');
    await withFiles({ 'tricky.txt': tricky }, async (tools) => {
      const numbered = await tools.run('read_file', { path: 'tricky.txt', line_numbers: true });
      const lines = numbered.output.split('\n').slice(1);

      expect(lines).toHaveLength(3);
      expect(lines.map((line) => line.split('\t')[0])).toEqual(['1', '2', '3']);
      expect(numbered.readReceipt).toMatchObject({ startLine: 1, endLine: 3 });
      expect(numbered.readContent).toBe(tricky);
    });
  });

  it('numbers lines of wide, astral and combining characters by line, not by width or code unit', async () => {
    const unicode = [
      '研发团队 notes',
      `${String.fromCodePoint(0x1F50D)}${String.fromCodePoint(0x1F50D)} astral`,
      `e${String.fromCharCode(0x301)} combining`,
      'العربية',
    ];
    await withFiles({ 'unicode.txt': `${unicode.join('\n')}\n` }, async (tools) => {
      const numbered = await tools.run('read_file', { path: 'unicode.txt', line_numbers: true });

      expect(numberedLines(numbered.output)).toEqual(unicode.map((line, index) => `${index + 1}\t${line}`));
      expect(numbered.readContent).toBe(`${unicode.join('\n')}\n`);
      expect(numbered.readReceipt).toMatchObject({ startLine: 1, endLine: 4, coverage: 'complete' });
    });
  });

  it('gives every line the same number on every page, so a cited range means the same lines', async () => {
    const content = Array.from({ length: 200 }, (_unused, index) => `line${index + 1}`).join('\n');
    await withFiles({ 'big.txt': content }, async (tools) => {
      const page = await tools.run('read_file', { path: 'big.txt', offset: 10, limit: 3, line_numbers: true });
      const overlapping = await tools.run('read_file', { path: 'big.txt', offset: 11, limit: 5, line_numbers: true });
      const whole = await tools.run('read_file', { path: 'big.txt', line_numbers: true });

      expect(numberedLines(page.output)).toEqual(['11\tline11', '12\tline12', '13\tline13']);
      expect(page.output).toContain('…[showing numbered lines 11–13 of 200. Use offset=13 to continue.]');
      expect(page.output).not.toContain('showing lines 10');
      expect(page.readReceipt).toMatchObject({ id: 'R1', startLine: 11, endLine: 13, coverage: 'partial' });
      // Line 12 is "12<TAB>line12" on every page it appears on.
      for (const result of [page, overlapping, whole]) {
        expect(numberedLines(result.output)).toContain('12\tline12');
      }
      expect(overlapping.readReceipt).toMatchObject({ id: 'R2', startLine: 12, endLine: 16, coverage: 'partial' });
      expect(whole.readReceipt).toMatchObject({ id: 'R3', startLine: 1, endLine: 200, coverage: 'complete' });
      expect(whole.output).not.toContain('showing numbered lines');
    });
  });

  it('continues from the offset its footer names and says where the file ends', async () => {
    const content = Array.from({ length: 20 }, (_unused, index) => `line${index + 1}`).join('\n') + '\n';
    await withFiles({ 'paged.txt': content }, async (tools) => {
      const first = await tools.run('read_file', { path: 'paged.txt', limit: 13, line_numbers: true });
      expect(first.output).toContain('Use offset=13 to continue.');

      const second = await tools.run('read_file', { path: 'paged.txt', offset: 13, line_numbers: true });
      expect(numberedLines(second.output)[0]).toBe('14\tline14');
      expect(numberedLines(second.output).at(-1)).toBe('20\tline20');
      expect(second.output).toContain('…[showing numbered lines 14–20 of 20, the end of the file.]');
      expect(second.readReceipt).toMatchObject({ startLine: 14, endLine: 20, coverage: 'partial' });
      // The same paging without numbers returns the same bytes for the same request.
      const plain = await tools.run('read_file', { path: 'paged.txt', offset: 13 });
      expect(second.readContent).toBe(plain.readContent);
    });
  });

  it('issues no receipt when no line is in the requested range', async () => {
    await withFiles({ 'empty.txt': '', 'two.txt': 'one\ntwo\n' }, async (tools) => {
      const empty = await tools.run('read_file', { path: 'empty.txt', line_numbers: true });
      // Offset 2 is the empty piece after the final newline: there is no third line to number.
      const pastLastLine = await tools.run('read_file', { path: 'two.txt', offset: 2, line_numbers: true });

      for (const result of [empty, pastLastLine]) {
        expect(result.status).toBe('success');
        expect(result.output).toContain('[no read receipt: no line of the file is in this range.]');
        expect(result.readReceipt).toBeUndefined();
        expect(numberedLines(result.output)).toEqual([]);
      }
    });
  });

  it('gives a very long line one number and continues the count after it', async () => {
    const long = 'x'.repeat(150_000);
    await withFiles({ 'long.txt': `short\n${long}\nafter\n` }, async (tools) => {
      const fromLong = await tools.run('read_file', { path: 'long.txt', offset: 1, line_numbers: true });
      // The line is longer than a whole page, so it is a page of its own: one number, however long it is.
      expect(numberedLines(fromLong.output)).toEqual([`2\t${long}`]);
      expect(fromLong.readReceipt).toMatchObject({ startLine: 2, endLine: 2, coverage: 'partial' });
      expect(fromLong.output).toContain('…[showing numbered lines 2–2 of 3. Use offset=2 to continue.]');

      const after = await tools.run('read_file', { path: 'long.txt', offset: 2, line_numbers: true });
      expect(numberedLines(after.output)).toEqual(['3\tafter']);
    });
  });

  it('keeps a numbered page inside a transport budget and gives a cut line a number but no receipt', async () => {
    // One-character lines: the number and its tab are most of every displayed line, so a page sized by the
    // file's own lines would be several times over the bound.
    const lines = Array.from({ length: 3_000 }, () => 'y');
    await withFiles({ 'budget.txt': lines.join('\n'), 'cut.txt': `${'z'.repeat(5_000)}\nnext\n` }, async (tools) => {
      const budget = { unit: 'bytes' as const, limit: 2_000, reserved: 200 };
      const page = await tools.run('read_file', { path: 'budget.txt', line_numbers: true }, { receiptBudget: budget });

      // The number prefix and the receipt line are part of what is sized: the whole result fits.
      expect(receiptTextSize(page.output, 'bytes')).toBeLessThanOrEqual(budget.limit - budget.reserved);
      expect(page.readReceipt?.startLine).toBe(1);
      expect(page.readReceipt!.endLine).toBeGreaterThan(100);
      expect(numberedLines(page.output)).toHaveLength(page.readReceipt!.endLine);
      expect(page.output).toContain(`Use offset=${page.readReceipt!.endLine} to continue.`);

      const cut = await tools.run('read_file', { path: 'cut.txt', line_numbers: true }, { receiptBudget: budget });
      expect(cut.output.startsWith('1\tzzz')).toBe(true);
      expect(cut.output).toContain('[no read receipt: numbered line 1 is shown only in part and cannot be cited.]');
      expect(cut.readReceipt).toBeUndefined();
      expect(receiptTextSize(cut.output, 'bytes')).toBeLessThanOrEqual(budget.limit - budget.reserved);
    });
  });

  it('records in the receipt which file and lines were shown and a digest of the bytes, never the text', async () => {
    const secret = 'const TOKEN = "SENTINEL-FILE-CONTENT";\nexport {};\n';
    await withFiles({ 'src/secret.ts': secret }, async (tools, root) => {
      const read = await tools.run('read_file', { path: './src/secret.ts', line_numbers: true });
      const receipt = read.readReceipt!;

      expect(Object.keys(receipt).sort()).toEqual(['contentDigest', 'coverage', 'endLine', 'id', 'path', 'pathAliases', 'startLine']);
      expect(receipt.contentDigest).toBe(createHash('sha256').update(secret).digest('hex'));
      expect(JSON.stringify(receipt)).not.toContain('SENTINEL-FILE-CONTENT');
      // One name for the file, relative to the working folder with forward slashes; the absolute spelling is an alias.
      expect(receipt.path).toBe('src/secret.ts');
      expect(receipt.pathAliases).toContain(path.join(root, 'src', 'secret.ts').replace(/\\/g, '/'));
    });
  });

  it('digests the bytes on disk and not the text it decoded from them', async () => {
    // A byte-order mark is dropped when the text is decoded, and a DOCX is shown as text its bytes do not spell.
    const marked = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('alpha\r\nbeta\r\n', 'utf8')]);
    const docx = storedZip([{ name: 'word/document.xml', text: '<w:document><w:p><w:r><w:t>DOCX review target</w:t></w:r></w:p></w:document>' }]);
    // The archive holds bytes that are no UTF-8, so a digest of them decoded and encoded again is another digest.
    expect(Buffer.from(docx.toString('utf8'), 'utf8').equals(docx)).toBe(false);
    await withFiles({ 'marked.txt': marked, 'brief.docx': docx }, async (tools) => {
      const text = await tools.run('read_file', { path: 'marked.txt', line_numbers: true });
      expect(numberedLines(text.output)).toEqual(['1\talpha\r', '2\tbeta\r']);
      expect(text.readReceipt!.contentDigest).toBe(createHash('sha256').update(marked).digest('hex'));
      expect(text.readReceipt!.contentDigest).not.toBe(createHash('sha256').update('alpha\r\nbeta\r\n', 'utf8').digest('hex'));

      const document = await tools.run('read_file', { path: 'brief.docx', line_numbers: true });
      expect(document.output).toContain('DOCX review target');
      expect(document.readReceipt!.contentDigest).toBe(createHash('sha256').update(docx).digest('hex'));
    });
  });

  it('reads the flag strictly and refuses it together with publish_to_user', async () => {
    await withFiles({ 'a.txt': 'one\ntwo\n' }, async (tools) => {
      const quoted = await tools.run('read_file', { path: 'a.txt', line_numbers: 'true' });
      expect(quoted.status).toBe('failed');
      expect(quoted.output).toBe('Error: line_numbers must be true or false. Nothing was read.');

      const both = await tools.run('read_file', { path: 'a.txt', line_numbers: true, publish_to_user: true });
      expect(both.status).toBe('failed');
      expect(both.output).toMatch(/line_numbers and publish_to_user cannot be used together/);
      expect(both.readReceipt).toBeUndefined();

      const off = await tools.run('read_file', { path: 'a.txt', line_numbers: false });
      expect(off.output).toBe('one\ntwo\n');
      expect(off.readReceipt).toBeUndefined();
    });
  });

  it('starts receipt numbering again when a new turn begins', async () => {
    await withFiles({ 'a.txt': 'one\n', 'b.txt': 'two\n' }, async (tools) => {
      expect((await tools.run('read_file', { path: 'a.txt', line_numbers: true })).readReceipt?.id).toBe('R1');
      expect((await tools.run('read_file', { path: 'b.txt', line_numbers: true })).readReceipt?.id).toBe('R2');

      tools.beginTurn();

      const next = await tools.run('read_file', { path: 'b.txt', line_numbers: true });
      expect(next.readReceipt).toMatchObject({ id: 'R1', path: 'b.txt' });
    });
  });
});

// ─── Schema contract test ──────────────────────────────────────────────

describe('read_file tool spec', () => {
  it('declares offset and limit as optional LINE parameters', () => {
    const tools = new WorkspaceTools('/tmp/nonexistent', new Set(['read']));
    const spec = tools.specs().find((s) => s.function.name === 'read_file');
    expect(spec).toBeTruthy();
    const params = spec!.function.parameters as {
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
    expect(params.properties.offset.type).toBe('integer');
    expect(params.properties.limit.type).toBe('integer');
    expect(params.properties.offset.description.toLowerCase()).toContain('line');
    expect(params.properties.limit.description.toLowerCase()).toContain('line');
    expect(params.required).not.toContain('offset');
    expect(params.required).toContain('path');
  });

  it('declares line_numbers as an optional flag and promises an ordinary reader no tool it is not offered', () => {
    const tools = new WorkspaceTools('/tmp/nonexistent', new Set(['read']));
    const params = tools.specs().find((s) => s.function.name === 'read_file')!.function.parameters as {
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };

    expect(params.properties.line_numbers.type).toBe('boolean');
    expect(params.required).not.toContain('line_numbers');
    // An ordinary reader is told what the flag does for it: numbered lines and a receipt that lasts for the attempt.
    expect(params.properties.line_numbers.description).toBe(`${LINE_NUMBERS_PARAMETER_DESCRIPTION} Do not combine it with publish_to_user.`);
    expect(params.properties.line_numbers.description).toMatch(/1-based line number/);
    expect(params.properties.line_numbers.description).toMatch(/read receipt \(R1, R2, \.\.\.\)/);
    expect(params.properties.line_numbers.description).toMatch(/A receipt is local to the current attempt/);
    // It is offered no close_assignment, so nothing here tells it to cite a receipt in one.
    expect(tools.specs().map((s) => s.function.name)).not.toContain('close_assignment');
    expect(params.properties.line_numbers.description).not.toMatch(/close_assignment|review_evidence|cite/);
    expect(lineNumbersParameterDescription(false)).toBe(LINE_NUMBERS_PARAMETER_DESCRIPTION);
  });

  it('tells the holder of a delegated, admitted review how receipts are cited, in the list that offers close_assignment', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-line-numbers-review-'));
    const store = new ContentAssetStore();
    try {
      await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n', 'utf8');
      const resolver = new TaskInputResolver(store, root);
      const contract = compileTaskContract({
        version: 1, objective: 'Review a.ts.', effects: { read_files: [], expected_file_effect: 'none' },
        inputs: [{
          input_id: 'target', kind: 'workspacePath', path: 'a.ts', purpose: 'Review target',
          required: true, freshness: 'current', provenance: { kind: 'workspace', source_refs: [] },
        }],
        review: { input_id: 'target' },
        required_capabilities: { version: 1, capabilities: ['read'] }, execution_strategy: 'delegate-required',
      }, 'pm').contract!;
      const card = (await resolver.beginAttempt(contract, {
        agentId: 'reviewer', capabilities: { read: true, write: false, shell: false }, taskScope: 'per-turn',
        verificationSensors: [], authorizedContentAssetIds: [], liveContentAssetIds: [], readyArtifacts: [],
      }, 'pm')).card!;
      const tools = new WorkspaceTools(root, new Set(['read']), 'reviewer');
      tools.setTaskInputResolver(resolver);
      tools.beginTurn();
      tools.setTaskAttempt(card);
      const lineNumbers = () => (tools.specs().find((s) => s.function.name === 'read_file')!.function.parameters as {
        properties: Record<string, { description: string }>;
      }).properties.line_numbers.description;
      const names = () => tools.specs().map((s) => s.function.name);

      // Marked as a review but not admitted by the host: still an ordinary reader.
      expect(names()).not.toContain('close_assignment');
      expect(lineNumbers()).toBe(`${LINE_NUMBERS_PARAMETER_DESCRIPTION} Do not combine it with publish_to_user.`);

      resolver.recordReviewAdmission(card.attemptId, {
        allowed: true, applied: false, policyId: 'artifact-review-different-reported-model-v1', code: 'not-selected', reason: 'off',
      });

      expect(names()).toContain('close_assignment');
      expect(lineNumbers()).toBe(
        `${LINE_NUMBERS_PARAMETER_DESCRIPTION} ${LINE_NUMBERS_REVIEW_CITATION_SUFFIX} Do not combine it with publish_to_user.`,
      );
      // The rule a reviewer needs: where a receipt is cited, and that a read made with another tool leaves nothing to cite.
      expect(lineNumbers()).toMatch(/A reviewer cites these receipts in close_assignment review_evidence\./);
      expect(lineNumbers()).toMatch(/Only this tool and search_files issue receipts; a read or search made with any other tool cannot be cited\./);
      expect(lineNumbersParameterDescription(true)).toBe(`${LINE_NUMBERS_PARAMETER_DESCRIPTION} ${LINE_NUMBERS_REVIEW_CITATION_SUFFIX}`);
    } finally {
      await store.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
