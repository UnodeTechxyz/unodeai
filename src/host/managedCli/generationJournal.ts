/*---------------------------------------------------------------------------------------------
 *  UnodeAi - immutable, numbered record generations published by exclusive link (v0.9.97)
 *  A generation is written to a private temp file, flushed, and then linked to its final name. The link fails when
 *  the name exists, so exactly one writer wins each generation and no reader ever sees a partial file. A writer that
 *  loses re-reads and decides again from the winner; it never reapplies an old decision.
 *
 *  The current record is the newest generation whose file parses, passes its schema, carries its own number and
 *  digest, and names its predecessor's digest when that predecessor is still there. Any file above it means the
 *  journal is not used: UnodeAi never writes such a file, so it comes from damage, tampering or a newer UnodeAi.
 *--------------------------------------------------------------------------------------------*/

import { closeSync, fsyncSync, linkSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import * as path from 'node:path';
import { canonicalJson, newStoreToken, recordDigest } from './storeLayout';

/** A generation file is at most this large; a larger one is not read. */
export const JOURNAL_MAX_RECORD_BYTES = 256 * 1024;
/** Generations older than the newest minus this many may be removed by the writer that published the newest. */
export const JOURNAL_KEEP_GENERATIONS = 10;
/** A listing that loses a file to a concurrent trim is read again this many times. */
const LISTING_ATTEMPTS = 3;

export interface JournalFs {
  readdir(folder: string): string[];
  /** Undefined when the file is larger than `maxBytes`. */
  readFile(file: string, maxBytes: number): Buffer | undefined;
  /** Creates the file exclusively, writes all bytes, flushes them and closes it. */
  writeExclusive(file: string, bytes: Buffer): void;
  link(existing: string, created: string): void;
  unlink(file: string): void;
}

export const nodeJournalFs: JournalFs = {
  readdir: (folder) => readdirSync(folder),
  readFile: (file, maxBytes) => {
    if (statSync(file).size > maxBytes) return undefined;
    const bytes = readFileSync(file);
    return bytes.length > maxBytes ? undefined : bytes;
  },
  writeExclusive: (file, bytes) => {
    const fd = openSync(file, 'wx');
    try {
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  link: (existing, created) => linkSync(existing, created),
  unlink: (file) => unlinkSync(file),
};

export type JournalParse<T> =
  | { ok: true; record: T }
  /** `newerSchema`: the file is a record of a schema this UnodeAi does not know but a newer one may. */
  | { ok: false; newerSchema?: boolean; detail: string };

export interface JournalSpec<T> {
  folder: string;
  /** File names are `<prefix>-<10-digit generation>.json`. */
  prefix: string;
  /**
   * Checks one record's own content (schema, fields, and anything it refers to). The journal itself checks the
   * generation number, the digest and the chain.
   */
  parse(value: unknown, generation: number): JournalParse<T>;
}

export interface JournalEntry<T> {
  generation: number;
  record: T;
  digest: string;
}

export type JournalRead<T> =
  | { kind: 'empty' }
  | ({ kind: 'ok' } & JournalEntry<T>)
  | { kind: 'corrupt'; detail: string; newestValid?: JournalEntry<T> }
  | { kind: 'newer-schema'; generation: number; detail: string };

export function generationFileName(prefix: string, generation: number): string {
  return `${prefix}-${String(generation).padStart(10, '0')}.json`;
}

function generationOf(prefix: string, name: string): number | undefined {
  const match = new RegExp(`^${prefix}-(\\d{10})\\.json$`).exec(name);
  if (!match) return undefined;
  const generation = Number(match[1]);
  return generation >= 1 && generationFileName(prefix, generation) === name ? generation : undefined;
}

type FileRead<T> =
  | { kind: 'valid'; entry: JournalEntry<T>; previousRecordDigest: string | null }
  | { kind: 'invalid'; newerSchema: boolean; detail: string }
  | { kind: 'gone' };

function readGeneration<T>(spec: JournalSpec<T>, generation: number, fs: JournalFs): FileRead<T> {
  const file = path.join(spec.folder, generationFileName(spec.prefix, generation));
  let bytes: Buffer | undefined;
  try {
    bytes = fs.readFile(file, JOURNAL_MAX_RECORD_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'gone' };
    return { kind: 'invalid', newerSchema: false, detail: `generation ${generation} could not be read (${errorCode(error)})` };
  }
  if (!bytes) return { kind: 'invalid', newerSchema: false, detail: `generation ${generation} is larger than a record can be` };
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { kind: 'invalid', newerSchema: false, detail: `generation ${generation} is not JSON` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'invalid', newerSchema: false, detail: `generation ${generation} is not a record` };
  }
  const fields = value as { generation?: unknown; recordDigest?: unknown; previousRecordDigest?: unknown };
  const parsed = spec.parse(value, generation);
  if (!parsed.ok) return { kind: 'invalid', newerSchema: parsed.newerSchema === true, detail: `generation ${generation}: ${parsed.detail}` };
  if (fields.generation !== generation) {
    return { kind: 'invalid', newerSchema: false, detail: `generation ${generation} names generation ${String(fields.generation)}` };
  }
  if (typeof fields.recordDigest !== 'string' || fields.recordDigest !== recordDigest(value)) {
    return { kind: 'invalid', newerSchema: false, detail: `generation ${generation} does not match its digest` };
  }
  const previous = fields.previousRecordDigest;
  if (previous !== null && (typeof previous !== 'string' || !/^[0-9a-f]{64}$/.test(previous))) {
    return { kind: 'invalid', newerSchema: false, detail: `generation ${generation} names no valid predecessor` };
  }
  if (generation === 1 && previous !== null) {
    return { kind: 'invalid', newerSchema: false, detail: 'generation 1 names a predecessor' };
  }
  if (generation > 1 && previous === null) {
    return { kind: 'invalid', newerSchema: false, detail: `generation ${generation} names no predecessor` };
  }
  return { kind: 'valid', entry: { generation, record: parsed.record, digest: fields.recordDigest }, previousRecordDigest: previous };
}

/** The current record of a journal, or why there is none. */
export function readJournal<T>(spec: JournalSpec<T>, fs: JournalFs = nodeJournalFs): JournalRead<T> {
  for (let attempt = 1; ; attempt++) {
    let names: string[];
    try {
      names = fs.readdir(spec.folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'empty' };
      return { kind: 'corrupt', detail: `the record folder could not be listed (${errorCode(error)})` };
    }
    const generations = names.map((name) => generationOf(spec.prefix, name))
      .filter((generation): generation is number => generation !== undefined)
      .sort((a, b) => b - a);
    if (generations.length === 0) return { kind: 'empty' };

    let vanished = false;
    const above: Array<{ generation: number; newerSchema: boolean; detail: string }> = [];
    let newest: { entry: JournalEntry<T>; previousRecordDigest: string | null } | undefined;
    for (const generation of generations) {
      const read = readGeneration(spec, generation, fs);
      if (read.kind === 'gone') { vanished = true; break; }
      if (read.kind === 'invalid') { above.push({ generation, newerSchema: read.newerSchema, detail: read.detail }); continue; }
      newest = read;
      break;
    }
    if (vanished) {
      if (attempt < LISTING_ATTEMPTS) continue;
      return { kind: 'corrupt', detail: 'record files kept disappearing while they were read' };
    }
    if (above.length > 0) {
      const newer = above.find((file) => file.newerSchema);
      if (newer) return { kind: 'newer-schema', generation: newer.generation, detail: newer.detail };
      return { kind: 'corrupt', detail: above[0].detail, ...(newest ? { newestValid: newest.entry } : {}) };
    }
    if (!newest) return { kind: 'corrupt', detail: 'no generation is valid' };

    const predecessor = newest.entry.generation - 1;
    if (predecessor >= 1 && generations.includes(predecessor)) {
      const read = readGeneration(spec, predecessor, fs);
      if (read.kind === 'gone') {
        if (attempt < LISTING_ATTEMPTS) continue;
        return { kind: 'corrupt', detail: 'record files kept disappearing while they were read' };
      }
      if (read.kind === 'valid' && read.entry.digest !== newest.previousRecordDigest) {
        return { kind: 'corrupt', detail: `generation ${newest.entry.generation} does not follow generation ${predecessor}`, newestValid: newest.entry };
      }
    }
    return { kind: 'ok', ...newest.entry };
  }
}

export type JournalPublish<T> =
  | { outcome: 'published'; entry: JournalEntry<T> }
  /**
   * Another writer published this generation first, or the link is not in the chain readers follow (see
   * `publishGeneration`). The caller reads again and decides again on what is current.
   */
  | { outcome: 'lost' };

/**
 * Publishes `content` as the generation after `predecessor` (none: generation 1). The record gets `generation`,
 * `previousRecordDigest` and `recordDigest`; the caller's fields must not set them.
 *
 * A trim frees the names of old generations, so a writer whose predecessor is more generations old than are kept can
 * link such a name again: it wins the name, not the chain. A link counts as published only when no later generation
 * exists, or the next one names this record's digest. A later generation that names another digest makes the link
 * stale: its file is removed, below the current record where no reader looks. When the next generation cannot be
 * read, the link is not counted either, and its file stays, since it may be in the chain.
 */
export function publishGeneration<T extends object>(
  spec: JournalSpec<T>,
  predecessor: { generation: number; digest: string } | null,
  content: Omit<T, 'generation' | 'previousRecordDigest' | 'recordDigest'>,
  fs: JournalFs = nodeJournalFs,
  token: () => string = newStoreToken,
): JournalPublish<T> {
  const generation = predecessor ? predecessor.generation + 1 : 1;
  const record = { ...content, generation, previousRecordDigest: predecessor ? predecessor.digest : null } as Record<string, unknown>;
  const digest = recordDigest(record);
  const bytes = Buffer.from(canonicalJson({ ...record, recordDigest: digest }), 'utf8');
  if (bytes.length > JOURNAL_MAX_RECORD_BYTES) throw new Error('The record is larger than a record can be.');
  const temp = path.join(spec.folder, `.${spec.prefix}.tmp-${token()}`);
  fs.writeExclusive(temp, bytes);
  try {
    fs.link(temp, path.join(spec.folder, generationFileName(spec.prefix, generation)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { outcome: 'lost' };
    throw error;
  } finally {
    try { fs.unlink(temp); } catch { /* removed with the folder, or retried by a later writer's trim */ }
  }
  const chain = linkInChain(spec, generation, digest, fs);
  if (chain === 'stale') {
    try { fs.unlink(path.join(spec.folder, generationFileName(spec.prefix, generation))); } catch { /* no reader looks below the current record */ }
  }
  if (chain !== 'in-chain') return { outcome: 'lost' };
  return { outcome: 'published', entry: { generation, record: record as T, digest } };
}

function linkInChain(spec: JournalSpec<unknown>, generation: number, digest: string, fs: JournalFs): 'in-chain' | 'stale' | 'unknown' {
  let names: string[];
  try {
    names = fs.readdir(spec.folder);
  } catch {
    return 'unknown';
  }
  if (!names.some((name) => (generationOf(spec.prefix, name) ?? 0) > generation)) return 'in-chain';
  let next: unknown;
  try {
    const bytes = fs.readFile(path.join(spec.folder, generationFileName(spec.prefix, generation + 1)), JOURNAL_MAX_RECORD_BYTES);
    if (!bytes) return 'unknown';
    next = JSON.parse(bytes.toString('utf8'));
  } catch {
    return 'unknown';
  }
  const fields = (next && typeof next === 'object' ? next : {}) as { recordDigest?: unknown; previousRecordDigest?: unknown };
  if (typeof fields.recordDigest !== 'string' || fields.recordDigest !== recordDigest(next as object) || typeof fields.previousRecordDigest !== 'string') {
    return 'unknown';
  }
  return fields.previousRecordDigest === digest ? 'in-chain' : 'stale';
}

/** Removes generations older than the newest minus `JOURNAL_KEEP_GENERATIONS`. Best effort. */
export function trimJournal(spec: JournalSpec<unknown>, newest: number, fs: JournalFs = nodeJournalFs): void {
  let names: string[];
  try {
    names = fs.readdir(spec.folder);
  } catch {
    return;
  }
  for (const name of names) {
    const generation = generationOf(spec.prefix, name);
    if (generation === undefined || generation >= newest - JOURNAL_KEEP_GENERATIONS) continue;
    try { fs.unlink(path.join(spec.folder, name)); } catch { /* another window trimmed it, or it is open */ }
  }
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message.slice(0, 120) : 'unknown');
}
