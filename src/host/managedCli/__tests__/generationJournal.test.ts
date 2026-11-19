import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  generationFileName,
  JOURNAL_KEEP_GENERATIONS,
  nodeJournalFs,
  publishGeneration,
  readJournal,
  trimJournal,
  type JournalFs,
  type JournalSpec,
} from '../generationJournal';
import { canonicalJson, recordDigest } from '../storeLayout';

// The design these tests realise: the managed store's record generations. Publication is a compare-and-swap by
// exclusive link of a flushed temp file, so exactly one writer wins a generation and no reader sees a partial file;
// the current record is the newest valid generation, and any file above it makes the journal unusable (a file
// UnodeAi never writes comes from damage, tampering or a newer schema); every record names its predecessor's digest.

interface TestRecord {
  schema: 'test/1';
  generation: number;
  previousRecordDigest: string | null;
  value: string;
}

const temps: string[] = [];
afterEach(() => {
  for (const folder of temps.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function journal(): JournalSpec<TestRecord> {
  const folder = mkdtempSync(path.join(tmpdir(), 'unode-journal-'));
  temps.push(folder);
  return {
    folder,
    prefix: 'test',
    parse: (value) => {
      const record = value as Omit<Partial<TestRecord>, 'schema'> & { schema?: unknown };
      if (record.schema === 'test/2') return { ok: false, newerSchema: true, detail: 'schema test/2' };
      if (record.schema !== 'test/1' || typeof record.value !== 'string') return { ok: false, detail: 'not a test record' };
      return { ok: true, record: record as TestRecord };
    },
  };
}

function write(spec: JournalSpec<TestRecord>, generation: number, body: unknown): void {
  writeFileSync(path.join(spec.folder, generationFileName(spec.prefix, generation)), typeof body === 'string' ? body : JSON.stringify(body));
}

/** A valid file for `generation`, written by hand (as a damaged or foreign writer would). */
function validRecord(generation: number, previous: string | null, value: string): Record<string, unknown> {
  const record = { schema: 'test/1', generation, previousRecordDigest: previous, value };
  return { ...record, recordDigest: recordDigest(record) };
}

describe('publishGeneration and readJournal', () => {
  it('reads an empty or missing folder as empty', () => {
    const spec = journal();
    expect(readJournal(spec)).toEqual({ kind: 'empty' });
    expect(readJournal({ ...spec, folder: path.join(spec.folder, 'missing') })).toEqual({ kind: 'empty' });
  });

  it('publishes generation 1 and then each next one, chained by digest, and reads the newest', () => {
    const spec = journal();
    const first = publishGeneration(spec, null, { schema: 'test/1', value: 'a' });
    expect(first.outcome).toBe('published');
    if (first.outcome !== 'published') return;
    expect(first.entry.generation).toBe(1);
    expect(first.entry.record.previousRecordDigest).toBeNull();
    const second = publishGeneration(spec, first.entry, { schema: 'test/1', value: 'b' });
    expect(second.outcome).toBe('published');
    if (second.outcome !== 'published') return;
    expect(second.entry.record.previousRecordDigest).toBe(first.entry.digest);
    const read = readJournal(spec);
    expect(read).toMatchObject({ kind: 'ok', generation: 2, digest: second.entry.digest, record: { value: 'b' } });
    // The file holds the canonical record and its digest; no temp file is left behind.
    const names = readdirSync(spec.folder);
    expect(names.sort()).toEqual([generationFileName('test', 1), generationFileName('test', 2)]);
    const stored = JSON.parse(readFileSync(path.join(spec.folder, generationFileName('test', 2)), 'utf8'));
    expect(stored.recordDigest).toBe(recordDigest(stored));
  });

  it('loses, and changes nothing, when the generation already exists', () => {
    const spec = journal();
    const first = publishGeneration(spec, null, { schema: 'test/1', value: 'a' });
    if (first.outcome !== 'published') throw new Error('setup');
    expect(publishGeneration(spec, first.entry, { schema: 'test/1', value: 'b' }).outcome).toBe('published');
    expect(publishGeneration(spec, first.entry, { schema: 'test/1', value: 'c' })).toEqual({ outcome: 'lost' });
    expect(readJournal(spec)).toMatchObject({ kind: 'ok', generation: 2, record: { value: 'b' } });
    expect(readdirSync(spec.folder).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('writes the temp file exclusively and flushed, and links it; the temp file is removed whether it won or lost', () => {
    const spec = journal();
    const calls: string[] = [];
    const fs: JournalFs = {
      ...nodeJournalFs,
      writeExclusive: (file, bytes) => { calls.push(`write ${path.basename(file)}`); nodeJournalFs.writeExclusive(file, bytes); },
      link: (existing, created) => { calls.push(`link ${path.basename(created)}`); nodeJournalFs.link(existing, created); },
      unlink: (file) => { calls.push(`unlink ${path.basename(file)}`); nodeJournalFs.unlink(file); },
    };
    publishGeneration(spec, null, { schema: 'test/1', value: 'a' }, fs, () => 'f'.repeat(32));
    publishGeneration(spec, null, { schema: 'test/1', value: 'b' }, fs, () => 'e'.repeat(32));
    expect(calls).toEqual([
      `write .test.tmp-${'f'.repeat(32)}`, `link ${generationFileName('test', 1)}`, `unlink .test.tmp-${'f'.repeat(32)}`,
      `write .test.tmp-${'e'.repeat(32)}`, `link ${generationFileName('test', 1)}`, `unlink .test.tmp-${'e'.repeat(32)}`,
    ]);
  });

  it('is unusable when a file above the newest valid generation is damaged, and names the newest valid one', () => {
    const spec = journal();
    const first = publishGeneration(spec, null, { schema: 'test/1', value: 'a' });
    if (first.outcome !== 'published') throw new Error('setup');
    write(spec, 2, '{"schema":"test/1","generation":2');
    const read = readJournal(spec);
    expect(read.kind).toBe('corrupt');
    if (read.kind === 'corrupt') expect(read.newestValid?.generation).toBe(1);
  });

  it.each([
    ['not JSON', '{'],
    ['the wrong generation', () => validRecord(3, 'a'.repeat(64), 'x')],
    ['a wrong digest', () => ({ ...validRecord(2, 'a'.repeat(64), 'x'), value: 'changed' })],
    ['no digest', () => { const { recordDigest: _drop, ...rest } = validRecord(2, 'a'.repeat(64), 'x'); return rest; }],
    ['a record of another kind', () => ({ schema: 'other' })],
    ['no predecessor above generation 1', () => validRecord(2, null, 'x')],
    ['an array', '[]'],
  ])('treats a newer file with %s as damage, not as the current record', (_label, body) => {
    const spec = journal();
    const first = publishGeneration(spec, null, { schema: 'test/1', value: 'a' });
    if (first.outcome !== 'published') throw new Error('setup');
    write(spec, 2, typeof body === 'function' ? body() : body);
    expect(readJournal(spec).kind).toBe('corrupt');
  });

  it('reads a newer schema above the newest valid generation as newer-schema', () => {
    const spec = journal();
    publishGeneration(spec, null, { schema: 'test/1', value: 'a' });
    write(spec, 2, { schema: 'test/2', generation: 2 });
    expect(readJournal(spec)).toMatchObject({ kind: 'newer-schema', generation: 2 });
  });

  it('is unusable when the newest record does not name its predecessor\'s digest', () => {
    const spec = journal();
    const first = publishGeneration(spec, null, { schema: 'test/1', value: 'a' });
    if (first.outcome !== 'published') throw new Error('setup');
    write(spec, 2, validRecord(2, 'b'.repeat(64), 'forged'));
    expect(readJournal(spec)).toMatchObject({ kind: 'corrupt', detail: 'generation 2 does not follow generation 1' });
  });

  it('accepts the newest record when its predecessor was trimmed', () => {
    const spec = journal();
    write(spec, 7, validRecord(7, 'c'.repeat(64), 'kept'));
    expect(readJournal(spec)).toMatchObject({ kind: 'ok', generation: 7, record: { value: 'kept' } });
  });

  it('ignores names that are not generation files, temp files included', () => {
    const spec = journal();
    publishGeneration(spec, null, { schema: 'test/1', value: 'a' });
    writeFileSync(path.join(spec.folder, `.test.tmp-${'0'.repeat(32)}`), 'partial');
    writeFileSync(path.join(spec.folder, 'test-2.json'), 'short name');
    writeFileSync(path.join(spec.folder, 'test-0000000000.json'), 'generation zero');
    writeFileSync(path.join(spec.folder, 'other-0000000009.json'), 'other prefix');
    expect(readJournal(spec)).toMatchObject({ kind: 'ok', generation: 1 });
  });

  it('refuses a file larger than a record can be', () => {
    const spec = journal();
    publishGeneration(spec, null, { schema: 'test/1', value: 'a' });
    write(spec, 2, JSON.stringify({ ...validRecord(2, 'a'.repeat(64), 'x'), padding: 'x'.repeat(300 * 1024) }));
    expect(readJournal(spec).kind).toBe('corrupt');
  });

  it('re-lists when a file disappears while it is read, and gives up after three listings', () => {
    const spec = journal();
    const first = publishGeneration(spec, null, { schema: 'test/1', value: 'a' });
    if (first.outcome !== 'published') throw new Error('setup');
    let vanishings = 1;
    const flaky: JournalFs = {
      ...nodeJournalFs,
      readFile: (file, max) => {
        if (vanishings > 0) { vanishings--; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }
        return nodeJournalFs.readFile(file, max);
      },
    };
    expect(readJournal(spec, flaky)).toMatchObject({ kind: 'ok', generation: 1 });
    const gone: JournalFs = { ...nodeJournalFs, readFile: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } };
    expect(readJournal(spec, gone).kind).toBe('corrupt');
  });

  it('trims only generations older than the newest minus the kept number', () => {
    const spec = journal();
    let predecessor: { generation: number; digest: string } | null = null;
    for (let index = 1; index <= 14; index++) {
      const result: ReturnType<typeof publishGeneration<TestRecord>> = publishGeneration(spec, predecessor, { schema: 'test/1', value: String(index) });
      if (result.outcome !== 'published') throw new Error('setup');
      predecessor = result.entry;
    }
    trimJournal(spec as JournalSpec<unknown>, 14);
    const left = readdirSync(spec.folder).sort();
    expect(left[0]).toBe(generationFileName('test', 14 - JOURNAL_KEEP_GENERATIONS));
    expect(left).toHaveLength(JOURNAL_KEEP_GENERATIONS + 1);
    expect(readJournal(spec)).toMatchObject({ kind: 'ok', generation: 14 });
  });

  it('does not count a link under a name a trim freed: a writer delayed past the kept generations loses, and its stale file is removed', () => {
    const spec = journal();
    const first = publishGeneration(spec, null, { schema: 'test/1', value: 'seed' });
    if (first.outcome !== 'published') throw new Error('setup');
    const delayed = first.entry;
    let predecessor: { generation: number; digest: string } = first.entry;
    for (let index = 2; index <= 13; index++) {
      const result = publishGeneration(spec, predecessor, { schema: 'test/1', value: String(index) });
      if (result.outcome !== 'published') throw new Error('setup');
      predecessor = result.entry;
    }
    trimJournal(spec as JournalSpec<unknown>, 13);
    expect(readdirSync(spec.folder)).not.toContain(generationFileName('test', 2));
    expect(readdirSync(spec.folder)).toContain(generationFileName('test', 3));
    // The writer that read generation 1 long ago links generation 2 again: the name is free, the chain is not, since
    // generation 3 names the earlier generation 2.
    expect(publishGeneration(spec, delayed, { schema: 'test/1', value: 'stale' })).toEqual({ outcome: 'lost' });
    expect(readdirSync(spec.folder)).not.toContain(generationFileName('test', 2));
    expect(readJournal(spec)).toMatchObject({ kind: 'ok', generation: 13 });
  });

  it('does not count a link whose next generation cannot be read, and keeps its file, since it may be in the chain', () => {
    const spec = journal();
    const first = publishGeneration(spec, null, { schema: 'test/1', value: 'a' });
    if (first.outcome !== 'published') throw new Error('setup');
    write(spec, 4, validRecord(4, 'c'.repeat(64), 'later'));
    write(spec, 3, '{ torn');
    const result = publishGeneration(spec, first.entry, { schema: 'test/1', value: 'b' });
    expect(result).toEqual({ outcome: 'lost' });
    expect(readdirSync(spec.folder)).toContain(generationFileName('test', 2));
  });

  it('counts a link that a later generation names as its predecessor', () => {
    const spec = journal();
    const first = publishGeneration(spec, null, { schema: 'test/1', value: 'a' });
    if (first.outcome !== 'published') throw new Error('setup');
    // A faster window builds on this writer's generation 2 between its link and its check.
    const linkFs: JournalFs = {
      ...nodeJournalFs,
      link: (existing, created) => {
        nodeJournalFs.link(existing, created);
        const mine = JSON.parse(readFileSync(created, 'utf8'));
        write(spec, 3, validRecord(3, mine.recordDigest, 'built on it'));
      },
    };
    expect(publishGeneration(spec, first.entry, { schema: 'test/1', value: 'b' }, linkFs).outcome).toBe('published');
  });

  it('stores canonical JSON: equal records have equal bytes whatever their key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ f: 1, e: 0 }] } })).toBe('{"a":{"c":[{"e":0,"f":1}],"d":2},"b":1}');
    expect(recordDigest({ a: 1, b: 2 })).toBe(recordDigest({ b: 2, a: 1, recordDigest: 'ignored' }));
  });
});

describe('concurrent writers (real processes)', () => {
  let worker = '';
  beforeAll(() => {
    const folder = mkdtempSync(path.join(tmpdir(), 'unode-journal-worker-'));
    worker = path.join(folder, 'worker.cjs');
    buildSync({
      entryPoints: [path.join(__dirname, 'journalWorker.fixture.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: worker,
      logLevel: 'silent',
    });
  });
  afterAll(() => { rmSync(path.dirname(worker), { recursive: true, force: true }); });

  function run(args: string[]): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [worker, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (chunk) => { out += String(chunk); });
      child.on('close', () => resolve(out));
    });
  }

  it('gives eight processes racing through the real journal eight distinct generations in one chain, and a reader never sees a partial record', async () => {
    for (let round = 0; round < 5; round++) {
      const spec = journal();
      publishGeneration(spec, null, { schema: 'test/1', value: 'seed' });
      const go = path.join(spec.folder, '..', `${path.basename(spec.folder)}.go`);
      temps.push(go);
      const writers = Array.from({ length: 8 }, (_, index) => run(['write', spec.folder, `w${index}`, go]));
      const reader = run(['read', spec.folder, '1500']);
      await new Promise((resolve) => setTimeout(resolve, 300));
      writeFileSync(go, '');
      const results = (await Promise.all(writers)).map((out) => JSON.parse(out) as { generation: number; losses: number });
      expect(results.map((result) => result.generation).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
      // Every loser decided again from a winner, so the chain names each predecessor and keeps every value.
      const chain: TestRecord[] = [];
      for (let generation = 1; generation <= 9; generation++) {
        chain.push(JSON.parse(readFileSync(path.join(spec.folder, generationFileName('test', generation)), 'utf8')));
      }
      for (let generation = 2; generation <= 9; generation++) {
        expect(chain[generation - 1].previousRecordDigest).toBe(recordDigest(chain[generation - 2]));
        expect(chain[generation - 1].value).toMatch(new RegExp(` after ${chain[generation - 2].value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      }
      const read = JSON.parse(await reader) as { reads: number; bad: string[] };
      expect(read.reads).toBeGreaterThan(0);
      expect(read.bad).toEqual([]);
    }
  }, 120_000);

  it('a writer that loses decides again from the winner and publishes after it', () => {
    const spec = journal();
    const first = publishGeneration(spec, null, { schema: 'test/1', value: 'a' });
    if (first.outcome !== 'published') throw new Error('setup');
    const other = publishGeneration(spec, first.entry, { schema: 'test/1', value: 'other window' });
    if (other.outcome !== 'published') throw new Error('setup');
    expect(publishGeneration(spec, first.entry, { schema: 'test/1', value: 'mine' }).outcome).toBe('lost');
    const current = readJournal(spec);
    if (current.kind !== 'ok') throw new Error('setup');
    const again = publishGeneration(spec, current, { schema: 'test/1', value: `mine after ${current.record.value}` });
    expect(again.outcome).toBe('published');
    expect(readJournal(spec)).toMatchObject({ kind: 'ok', generation: 3, record: { value: 'mine after other window', previousRecordDigest: other.entry.digest } });
  });
});

describe('a folder that cannot be listed', () => {
  it('is unusable rather than empty', () => {
    const spec = journal();
    const fs: JournalFs = { ...nodeJournalFs, readdir: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
    expect(readJournal(spec, fs).kind).toBe('corrupt');
    mkdirSync(path.join(spec.folder, 'unused'));
  });
});
