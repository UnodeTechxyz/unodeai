import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { OptimisticFileCoordinator } from '../FileCoordinator';
import { WorkspaceTools, type WorkspaceToolRunResult } from '../WorkspaceTools';
import { isHistoricalReadFact, sha256Utf8 } from '../../compaction/ReadReferenceProjection';

let dir: string;
let coordinator: OptimisticFileCoordinator;
let tools: WorkspaceTools;

beforeEach(async () => {
  // A real path: a runner's TEMP can be an 8.3 short name.
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-history-read-')));
  coordinator = new OptimisticFileCoordinator();
  tools = new WorkspaceTools(dir, new Set(['read', 'write']), 'A', coordinator);
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

/** The span must hold exactly the text the fact digests, inside the output the model receives. */
function payloadOf(result: WorkspaceToolRunResult): string {
  const fact = result.historicalRead!;
  expect(fact).toBeDefined();
  // Every fact the host makes passes the shape check that guards the projection.
  expect(isHistoricalReadFact(fact)).toBe(true);
  const payload = result.output.slice(fact.span.start, fact.span.end);
  expect(sha256Utf8(payload)).toBe(fact.resultTextSha256);
  expect([...payload]).toHaveLength(fact.resultCharacters);
  return payload;
}

describe('read_file provenance', () => {
  it('spans exactly the file text of a whole read and names the call that ran', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    const result = await tools.run('read_file', { path: 'a.txt' });
    expect(payloadOf(result)).toBe('one\ntwo\nthree\n');
    expect(result.historicalRead).toMatchObject({
      source: { kind: 'file', path: 'a.txt', representation: 'text', lines: { first: 1, last: 3, total: 3 } },
      rerun: { tool: 'read_file', args: { path: 'a.txt' } },
      truncated: false,
    });
  });

  it('leaves the pagination footer outside the span of a partial read and records the numbers used', async () => {
    await fs.writeFile(path.join(dir, 'b.txt'), 'l1\nl2\nl3\nl4\n');
    const result = await tools.run('read_file', { path: 'b.txt', offset: 1, limit: 2 });
    expect(payloadOf(result)).toBe('l2\nl3');
    expect(result.output.length).toBeGreaterThan(result.historicalRead!.span.end);
    expect(result.historicalRead).toMatchObject({
      source: { lines: { first: 2, last: 3, total: 4 } },
      rerun: { args: { path: 'b.txt', offset: 1, limit: 2 } },
      truncated: true,
    });
  });

  it('spans the numbered lines of a line-numbered read, not its receipt line', async () => {
    await fs.writeFile(path.join(dir, 'c.txt'), 'alpha\nbeta\n');
    const result = await tools.run('read_file', { path: 'c.txt', line_numbers: true });
    const payload = payloadOf(result);
    expect(payload).toContain('alpha');
    expect(payload).toContain('beta');
    expect(result.output.startsWith(payload)).toBe(false);
    expect(result.historicalRead!.rerun.args).toEqual({ path: 'c.txt', line_numbers: true });
  });

  it('gives no provenance to a failed or refused read', async () => {
    expect((await tools.run('read_file', { path: 'missing.txt' })).historicalRead).toBeUndefined();
    const writer = new WorkspaceTools(dir, new Set(['write']), 'W', coordinator);
    await fs.writeFile(path.join(dir, 'd.txt'), 'x');
    expect((await writer.run('read_file', { path: 'd.txt' })).historicalRead).toBeUndefined();
  });

  it('gives no provenance to an empty file', async () => {
    await fs.writeFile(path.join(dir, 'empty.txt'), '');
    expect((await tools.run('read_file', { path: 'empty.txt' })).historicalRead).toBeUndefined();
  });

  it('shifts the span past a dependency notice the host puts in front of the output', async () => {
    const other = new WorkspaceTools(dir, new Set(['read', 'write']), 'B', coordinator);
    await fs.writeFile(path.join(dir, 'shared.txt'), 'v1\n');
    await fs.writeFile(path.join(dir, 'next.txt'), 'next file\n');
    await tools.run('read_file', { path: 'shared.txt' });
    // A writer must read an existing file before it may replace it.
    await other.run('read_file', { path: 'shared.txt' });
    expect((await other.run('write_file', { path: 'shared.txt', content: 'v2\n' })).output).toMatch(/Wrote/);
    const result = await tools.run('read_file', { path: 'next.txt' });
    expect(result.output.startsWith('⚠️ Dependency changed')).toBe(true);
    expect(payloadOf(result)).toBe('next file\n');
  });
});

/** A stored (uncompressed) ZIP, as in WorkspaceTools.pagination.test.ts. */
function storedZip(entries: Array<{ name: string; text: string }>): Buffer {
  const crc32 = (bytes: Buffer): number => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.text, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const record = Buffer.concat([local, name, data]);
    locals.push(record);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
    header.writeUInt32LE(checksum, 16); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, name]));
    offset += record.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe('read_file provenance of an extracted document', () => {
  it('marks a document read as extracted text and digests the extracted text, not the file bytes', async () => {
    const docx = storedZip([{ name: 'word/document.xml', text: '<w:document><w:p><w:r><w:t>Extracted words</w:t></w:r></w:p></w:document>' }]);
    await fs.writeFile(path.join(dir, 'brief.docx'), docx);
    const result = await tools.run('read_file', { path: 'brief.docx' });
    expect(payloadOf(result)).toContain('Extracted words');
    expect(result.historicalRead!.source).toMatchObject({ kind: 'file', path: 'brief.docx', representation: 'extracted-text' });
    expect(result.historicalRead!.resultTextSha256).not.toBe(sha256Utf8(docx.toString('latin1')));
  });
});

describe('list_dir provenance', () => {
  it('spans the listing and names its directory', async () => {
    await fs.writeFile(path.join(dir, 'f1.txt'), '1');
    await fs.mkdir(path.join(dir, 'sub'));
    const result = await tools.run('list_dir', { path: '.' });
    expect(payloadOf(result).split('\n').sort()).toEqual(['f1.txt', 'sub/']);
    expect(result.historicalRead).toMatchObject({
      source: { kind: 'list', directory: '.', recursive: false },
      rerun: { tool: 'list_dir', args: { path: '.' } },
      truncated: false,
    });
    expect(result).toMatchObject({ name: 'list_dir', kind: 'list', path: '.' });
  });

  it('gives no provenance to an empty folder', async () => {
    await fs.mkdir(path.join(dir, 'none'));
    const result = await tools.run('list_dir', { path: 'none' });
    expect(result.output).toBe('(empty)');
    expect(result.historicalRead).toBeUndefined();
  });
});

describe('search_files provenance', () => {
  it('spans only the match lines, with the call as it ran', async () => {
    await fs.writeFile(path.join(dir, 's1.txt'), 'needle here\nnothing\n');
    await fs.writeFile(path.join(dir, 's2.txt'), 'another needle\n');
    const result = await tools.run('search_files', { query: 'needle', max_results: 10 });
    const payload = payloadOf(result);
    expect(payload.split('\n')).toHaveLength(2);
    expect(payload.split('\n').every((line) => line.includes('needle'))).toBe(true);
    expect(result.output.indexOf(payload)).toBeGreaterThan(0);
    expect(result.historicalRead).toMatchObject({
      source: { kind: 'search', scope: '.', query: 'needle', maxResults: 10 },
      rerun: { tool: 'search_files', args: { query: 'needle', max_results: 10 } },
      truncated: false,
    });
  });

  it('marks a capped search as truncated', async () => {
    await fs.writeFile(path.join(dir, 'many.txt'), 'hit\nhit\nhit\n');
    const result = await tools.run('search_files', { query: 'hit', max_results: 2 });
    expect(payloadOf(result).split('\n')).toHaveLength(2);
    expect(result.historicalRead!.truncated).toBe(true);
  });

  it('keeps the span on an exact repeat served from the completed-search cache', async () => {
    await fs.writeFile(path.join(dir, 'r.txt'), 'repeat me\n');
    const first = await tools.run('search_files', { query: 'repeat' });
    const second = await tools.run('search_files', { query: 'repeat' });
    expect(second.output).not.toBe(first.output);
    expect(payloadOf(second)).toBe(payloadOf(first));
  });

  it('gives no provenance to a search without matches', async () => {
    await fs.writeFile(path.join(dir, 'n.txt'), 'nothing\n');
    expect((await tools.run('search_files', { query: 'absent' })).historicalRead).toBeUndefined();
  });
});
