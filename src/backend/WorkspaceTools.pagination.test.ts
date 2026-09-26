/**
 * F1: Unit tests for read_file pagination in WorkspaceTools.
 * Pagination is LINE-based (offset = 0-indexed start line, limit = max lines) — the convention
 * models expect; byte offsets used to confuse agents into reading tiny fragments.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceTools, formatPaginationFooter } from './WorkspaceTools';

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
});
