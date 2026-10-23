/*---------------------------------------------------------------------------------------------
 * The strict reader of one pinned `.tar.gz` CLI package: `node:zlib` and a bounded USTAR reader, no dependency.
 *
 * The gzip file must be exactly one member: its header is read here, the deflate data must end exactly where the
 * eight-byte trailer begins, and the trailer's CRC-32 and length must match. Inside, only three header kinds are
 * read: a regular file (`0` or NUL), a directory (`5`) and a per-file pax header (`x`) whose only key is `mtime`,
 * which is ignored. Every header has the `ustar\0` magic, version `00`, a valid checksum, an octal size and an empty
 * prefix. Every other kind (links, devices, FIFOs, GNU long names, global pax headers) is refused, and so is any byte
 * that is not zero after the end-of-archive blocks.
 *
 * The package layout is the allowlist. Every regular entry is a listed file with its exact size, every directory is
 * listed, ignored entries are skipped and never written, and at the end no listed file or directory may be missing.
 * Names are compared case-insensitively, and two names equal that way are refused. Each name also passes the path
 * rule on its own (no `.`/`..`, no absolute or drive path, no reserved device name), so a wrong layout cannot widen
 * it. Directories are created one level at a time, so a parent must already exist; files are created with `wx`, and
 * their SHA-256 is computed while they are written. Decompressed bytes are bounded by the layout and by 1 GiB, and
 * entries by 20,000, so a gzip bomb ends on the byte count. On a failure the result names the entry and the reason,
 * and lists what was written: the payload folder is the caller's to remove. vscode-free.
 *--------------------------------------------------------------------------------------------*/

import { createHash, type Hash } from 'crypto';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import * as zlib from 'zlib';

export const TAR_LIMITS = {
  maxDecompressedBytes: 1024 * 1024 * 1024,
  maxEntries: 20_000,
  /** One pax header's data. The observed ones hold one `mtime` record of under 30 bytes. */
  maxPaxBytes: 1024,
  /** The two end-of-archive blocks, plus the zero padding that fills the last 20-block record. */
  maxEndBlocks: 21,
  /** The gzip header with its optional name, comment and extra field. */
  maxGzipHeaderBytes: 4096,
} as const;

const BLOCK = 512;

/** The policy entry's package layout: the shape of `managed.layout`. Other fields of a file row are not read here. */
export interface TarLayout {
  entrypoint: string;
  unpackedBytes: number;
  dirs: readonly string[];
  ignoredEntries: readonly string[];
  files: ReadonlyArray<{ path: string; size: number; sha256: string }>;
}

export interface TarExtractRequest {
  /** An absolute path to the downloaded `.tar.gz`. */
  archivePath: string;
  /** An absolute path to an existing, empty folder. Its cleanup belongs to the caller. */
  payloadDir: string;
  layout: TarLayout;
  /** Cancels the extraction; it stops at once. */
  signal: AbortSignal;
}

/** The file-system calls the reader makes. `mkdir` is never recursive. */
export interface TarReaderFs {
  open(file: string, flags: 'r' | 'wx'): Promise<fsp.FileHandle>;
  mkdir(dir: string): Promise<unknown>;
  readdir(dir: string): Promise<string[]>;
  lstat(file: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
}

/**
 * Why an extraction failed.
 * - `layout`: the layout itself is not usable (an unsafe or duplicate path, a missing parent, bad sizes or digests).
 * - `payload`: the payload folder is missing, not a plain folder, or not empty.
 * - `gzip`: not one valid gzip member (header, data, CRC-32 or length); `trailing-data`: bytes after that member.
 * - `header`: a tar header with another magic or version, a bad checksum, a base-256 or malformed size, a prefix,
 *   or a lone zero block; `type`: a refused entry type; `pax`: a pax key other than `mtime`, or a malformed pax header.
 * - `name`: a name that fails the path rule; `unlisted`: a name the layout does not list as that kind;
 *   `duplicate`: a name seen before, compared case-insensitively.
 * - `size`, `digest`: a listed file with another size or SHA-256 (a directory with data is `size`).
 * - `parent-missing`: an entry before its folder; `exists`: something is already at that path; `file`: another
 *   file-system error.
 * - `missing`: a listed file or folder that the archive does not hold; `after-end`: non-zero bytes after the
 *   end-of-archive blocks; `truncated`: the archive ends inside an entry or before its end blocks.
 * - `bounds`: more decompressed bytes or more entries than allowed.
 */
export type TarFailureReason =
  | 'layout' | 'payload' | 'gzip' | 'trailing-data' | 'header' | 'type' | 'pax' | 'name' | 'unlisted' | 'duplicate'
  | 'size' | 'digest' | 'parent-missing' | 'exists' | 'file' | 'missing' | 'after-end' | 'truncated' | 'bounds'
  | 'cancelled';

/** The scheduler's view: `integrity` (the archive is not the package) is never retried. */
export type TarFailureClass = 'integrity' | 'file' | 'cancelled';

export type TarExtractResult =
  | { ok: true; files: number; dirs: number; ignored: number; entries: number; decompressedBytes: number; written: string[] }
  | {
      ok: false;
      failure: TarFailureClass;
      reason: TarFailureReason;
      /** The entry that failed, as the archive or the layout names it (printable ASCII only). */
      entry?: string;
      detail: string;
      decompressedBytes: number;
      /** The layout paths created under the payload folder, in order; a file is listed once it was created. */
      written: string[];
    };

export function tarFailureClass(reason: TarFailureReason): TarFailureClass {
  if (reason === 'cancelled') return 'cancelled';
  if (reason === 'payload' || reason === 'exists' || reason === 'file') return 'file';
  return 'integrity';
}

class TarFailure extends Error {
  constructor(readonly reason: TarFailureReason, readonly detail: string, readonly entry?: string) {
    super(detail);
  }
}

const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Why a relative package path is unsafe to create on any platform, or undefined when it is safe. */
export function unsafePackagePath(rel: string): string | undefined {
  for (const segment of rel.split('/')) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) return 'has an empty segment or a character outside [A-Za-z0-9._-]';
    if (segment === '.' || segment === '..') return 'has a . or .. segment';
    if (segment.endsWith('.')) return 'has a segment that ends in a dot';
    if (RESERVED_DEVICE.test(segment.split('.')[0])) return 'names a reserved device';
  }
  return undefined;
}

/** Bytes a valid archive of this layout can decompress to: its data, and per entry a header, a pax header and padding. */
export function tarDecompressedLimit(layout: TarLayout): number {
  const entries = layout.files.length + layout.dirs.length + layout.ignoredEntries.length;
  const perEntry = BLOCK + BLOCK + TAR_LIMITS.maxPaxBytes + (BLOCK - 1);
  return Math.min(TAR_LIMITS.maxDecompressedBytes, layout.unpackedBytes + entries * perEntry + TAR_LIMITS.maxEndBlocks * BLOCK);
}

function layoutProblem(layout: TarLayout): string | undefined {
  if (!layout || !Array.isArray(layout.files) || !Array.isArray(layout.dirs) || !Array.isArray(layout.ignoredEntries)) {
    return 'is malformed';
  }
  if (layout.files.some((file) => !file || typeof file !== 'object')) return 'is malformed';
  const all =[...layout.files.map((file) => file.path), ...layout.dirs, ...layout.ignoredEntries];
  if (all.length > TAR_LIMITS.maxEntries) return `lists more than ${TAR_LIMITS.maxEntries} entries`;
  const seen = new Set<string>();
  for (const rel of all) {
    if (typeof rel !== 'string') return 'lists a path that is not a string';
    const problem = unsafePackagePath(rel);
    if (problem) return `lists ${printable(rel)}, which ${problem}`;
    if (seen.has(rel.toLowerCase())) return `lists ${printable(rel)} twice`;
    seen.add(rel.toLowerCase());
  }
  const dirs = new Set(layout.dirs.map((dir) => dir.toLowerCase()));
  let total = 0;
  for (const file of layout.files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0) return `gives ${printable(file.path)} no valid size`;
    if (!/^[0-9a-fA-F]{64}$/.test(file.sha256)) return `gives ${printable(file.path)} no valid SHA-256`;
    total += file.size;
  }
  for (const rel of [...layout.files.map((file) => file.path), ...layout.dirs]) {
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')).toLowerCase() : '';
    if (parent !== '' && !dirs.has(parent)) return `lists ${printable(rel)} without its folder`;
  }
  if (!layout.files.some((file) => file.path.toLowerCase() === String(layout.entrypoint).toLowerCase())) {
    return 'has an entrypoint that is not a listed file';
  }
  if (!Number.isSafeInteger(layout.unpackedBytes) || layout.unpackedBytes < total || layout.unpackedBytes > TAR_LIMITS.maxDecompressedBytes) {
    return 'has an unpacked size below its files or above the bound';
  }
  return undefined;
}

/** Printable ASCII only, so a hostile name cannot reach a log as control or bidi characters. */
function printable(text: string): string {
  const shown = text.length > 160 ? `${text.slice(0, 160)}...` : text;
  return shown.replace(/[^\x20-\x7e]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function fsCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

let crcTable: Uint32Array | undefined;
/** CRC-32 as zlib computes it, continuing from `value`. Used where `zlib.crc32` is missing (older Node). */
export function crc32Fallback(data: Uint8Array, value = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = (value ^ 0xffffffff) >>> 0;
  for (let index = 0; index < data.length; index++) crc = crcTable[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const crc32: (data: Uint8Array, value?: number) => number =
  (zlib as { crc32?: (data: Uint8Array, value?: number) => number }).crc32 ?? crc32Fallback;

/** The length of the gzip header (RFC 1952), with its optional fields; refuses anything else. */
function gzipHeaderLength(head: Buffer, fileSize: number): number {
  if (fileSize < 10 + 1 + 8 || head[0] !== 0x1f || head[1] !== 0x8b || head[2] !== 8) {
    throw new TarFailure('gzip', 'the archive is not a gzip file');
  }
  const flags = head[3];
  if (flags & 0xe0) throw new TarFailure('gzip', 'the gzip header sets reserved flags');
  let at = 10;
  const need = (bytes: number): void => {
    if (at + bytes > head.length) throw new TarFailure('gzip', 'the gzip header is longer than UnodeAi reads');
  };
  if (flags & 0x04) {
    need(2);
    const extra = head.readUInt16LE(at);
    need(2 + extra);
    at += 2 + extra;
  }
  for (const flag of [0x08, 0x10]) {
    if (!(flags & flag)) continue;
    const end = head.indexOf(0, at);
    if (end < 0) throw new TarFailure('gzip', 'the gzip header is longer than UnodeAi reads');
    at = end + 1;
  }
  if (flags & 0x02) {
    need(2);
    if (head.readUInt16LE(at) !== (crc32(head.subarray(0, at)) & 0xffff)) throw new TarFailure('gzip', 'the gzip header checksum does not match');
    at += 2;
  }
  if (at + 1 + 8 > fileSize) throw new TarFailure('gzip', 'the gzip file has no data');
  return at;
}

function octal(field: Buffer, digits: number): number | undefined {
  const match = new RegExp(`^ *([0-7]{1,${digits}})[ \\0]*$`).exec(field.toString('latin1'));
  return match ? parseInt(match[1], 8) : undefined;
}

const REFUSED_TYPES: Record<string, string> = {
  '1': 'a hard link', '2': 'a symbolic link', '3': 'a character device', '4': 'a block device', '6': 'a FIFO',
  '7': 'a contiguous file', 'g': 'a global pax header', 'L': 'a GNU long name', 'K': 'a GNU long link name',
};

type EntryKind = 'file' | 'dir' | 'pax';

/** The kind of entry a type flag names; undefined for every type that is refused. */
function entryKind(type: number): EntryKind | undefined {
  switch (type) {
    case 0x30: // '0'
    case 0x00:
      return 'file';
    case 0x35: // '5'
      return 'dir';
    case 0x78: // 'x'
      return 'pax';
    default:
      return undefined;
  }
}

interface Header { name: string; kind: EntryKind; size: number }

function readHeader(block: Buffer): Header {
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 0x20 : block[index];
  if (octal(block.subarray(148, 156), 8) !== sum) throw new TarFailure('header', 'a tar header checksum does not match');
  if (block.toString('latin1', 257, 263) !== 'ustar\0' || block.toString('latin1', 263, 265) !== '00') {
    throw new TarFailure('header', 'a tar header is not ustar version 00');
  }
  const nameEnd = block.indexOf(0, 0);
  const name = block.toString('latin1', 0, nameEnd < 0 || nameEnd > 100 ? 100 : nameEnd);
  const kind = entryKind(block[156]);
  if (!kind) {
    const type = String.fromCharCode(block[156]);
    throw new TarFailure('type', `the archive holds ${REFUSED_TYPES[type] ?? `an entry of type 0x${block[156].toString(16).padStart(2, '0')}`}`, printable(name));
  }
  if (block[124] & 0x80) throw new TarFailure('header', 'a tar header has a base-256 size', printable(name));
  const size = octal(block.subarray(124, 136), 12);
  if (size === undefined) throw new TarFailure('header', 'a tar header has a malformed size', printable(name));
  if (!block.subarray(345, 500).every((byte) => byte === 0)) throw new TarFailure('header', 'a tar header uses the prefix field', printable(name));
  return { name, kind, size };
}

/** Pax records (`<length> <key>=<value>\n`); only `mtime` is accepted, and its value is not used. */
function checkPax(data: Buffer, entry: string): void {
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const lengthText = space < 0 ? '' : data.toString('latin1', at, space);
    if (!/^[1-9]\d{0,4}$/.test(lengthText)) throw new TarFailure('pax', 'a pax record is malformed', entry);
    const end = at + Number(lengthText);
    if (end > data.length || end <= space + 1 || data[end - 1] !== 0x0a) throw new TarFailure('pax', 'a pax record is malformed', entry);
    const record = data.toString('latin1', space + 1, end - 1);
    const equals = record.indexOf('=');
    if (equals <= 0) throw new TarFailure('pax', 'a pax record is malformed', entry);
    const key = record.slice(0, equals);
    if (key !== 'mtime') throw new TarFailure('pax', `the archive sets the pax key ${printable(key)}`, entry);
    at = end;
  }
}

type State =
  | { kind: 'header' }
  | { kind: 'file'; rel: string; entry: string; left: number; at: number; handle: fsp.FileHandle; hash: Hash; sha256: string }
  | { kind: 'pax'; left: number; data: Buffer; filled: number; entry: string }
  | { kind: 'skip'; left: number }
  | { kind: 'end' };

/** The USTAR state machine over the decompressed bytes. */
class TarExtraction {
  readonly written: string[] = [];
  entries = 0;
  dirs = 0;
  files = 0;
  ignored = 0;
  private state: State = { kind: 'header' };
  /** Bytes of padding still to skip after the current entry's data. */
  private pad = 0;
  private readonly block = Buffer.alloc(BLOCK);
  private filled = 0;
  private zeroBlocks = 0;
  private paxPending: string | undefined;
  private readonly seen = new Set<string>();
  private readonly fileRows = new Map<string, { path: string; size: number; sha256: string }>();
  private readonly dirRows = new Map<string, string>();
  private readonly ignoredRows = new Set<string>();

  constructor(
    private readonly payloadDir: string,
    private readonly layout: TarLayout,
    private readonly fs: TarReaderFs,
    private readonly signal: AbortSignal,
  ) {
    for (const file of layout.files) this.fileRows.set(file.path.toLowerCase(), file);
    for (const dir of layout.dirs) this.dirRows.set(dir.toLowerCase(), dir);
    for (const ignored of layout.ignoredEntries) this.ignoredRows.add(ignored.toLowerCase());
  }

  async write(chunk: Buffer): Promise<void> {
    let at = 0;
    while (at < chunk.length) {
      const state = this.state;
      if (state.kind === 'end') {
        for (let index = at; index < chunk.length; index++) {
          if (chunk[index] !== 0) throw new TarFailure('after-end', 'the archive has data after its end blocks');
        }
        return;
      }
      if (state.kind === 'header') {
        // The padding after an entry's data comes before the next header.
        if (this.pad > 0) {
          const skip = Math.min(this.pad, chunk.length - at);
          this.pad -= skip;
          at += skip;
          continue;
        }
        const take = Math.min(BLOCK - this.filled, chunk.length - at);
        chunk.copy(this.block, this.filled, at, at + take);
        this.filled += take;
        at += take;
        if (this.filled === BLOCK) {
          this.filled = 0;
          await this.onBlock();
        }
        continue;
      }
      const take = Math.min(state.left, chunk.length - at);
      const piece = chunk.subarray(at, at + take);
      at += take;
      state.left -= take;
      if (state.kind === 'file') await this.writeFile(state, piece);
      else if (state.kind === 'pax') {
        piece.copy(state.data, state.filled);
        state.filled += piece.length;
      }
      if (state.left === 0) await this.endEntry(state);
    }
  }

  /** The stream ended: the archive must have reached its end blocks, and every listed path must have been seen. */
  finish(): void {
    if (this.state.kind !== 'end') throw new TarFailure('truncated', 'the archive ends before its end blocks');
    for (const file of this.layout.files) {
      if (!this.seen.has(file.path.toLowerCase())) throw new TarFailure('missing', 'a listed file is not in the archive', printable(file.path));
    }
    for (const dir of this.layout.dirs) {
      if (!this.seen.has(dir.toLowerCase())) throw new TarFailure('missing', 'a listed folder is not in the archive', printable(dir));
    }
  }

  async close(): Promise<void> {
    if (this.state.kind === 'file') await this.state.handle.close().catch(() => undefined);
  }

  private async onBlock(): Promise<void> {
    if (this.block.every((byte) => byte === 0)) {
      if (this.paxPending !== undefined) throw new TarFailure('pax', 'a pax header has no entry after it', this.paxPending);
      this.zeroBlocks++;
      if (this.zeroBlocks === 2) this.state = { kind: 'end' };
      return;
    }
    if (this.zeroBlocks > 0) throw new TarFailure('header', 'the archive has a lone zero block');
    if (this.signal.aborted) throw new TarFailure('cancelled', 'the extraction was cancelled');
    const header = readHeader(this.block);
    const entry = printable(header.name);
    this.pad = (BLOCK - (header.size % BLOCK)) % BLOCK;
    if (header.kind === 'pax') {
      if (this.paxPending !== undefined) throw new TarFailure('pax', 'two pax headers follow each other', entry);
      if (header.size === 0 || header.size > TAR_LIMITS.maxPaxBytes) throw new TarFailure('pax', 'a pax header is empty or larger than UnodeAi reads', entry);
      this.paxPending = entry;
      this.state = { kind: 'pax', left: header.size, data: Buffer.alloc(header.size), filled: 0, entry };
      return;
    }
    this.paxPending = undefined;
    this.entries++;
    if (this.entries > TAR_LIMITS.maxEntries) throw new TarFailure('bounds', `the archive has more than ${TAR_LIMITS.maxEntries} entries`, entry);
    const rel = header.kind === 'dir' && header.name.endsWith('/') ? header.name.slice(0, -1) : header.name;
    const problem = unsafePackagePath(rel);
    if (problem) throw new TarFailure('name', `an entry name ${problem}`, entry);
    const key = rel.toLowerCase();
    if (this.seen.has(key)) throw new TarFailure('duplicate', 'two entries have the same name, compared case-insensitively', entry);
    this.seen.add(key);
    if (this.ignoredRows.has(key)) {
      this.ignored++;
      this.state = header.size > 0 ? { kind: 'skip', left: header.size } : { kind: 'header' };
      return;
    }
    if (header.kind === 'dir') {
      const dir = this.dirRows.get(key);
      if (dir === undefined) throw new TarFailure('unlisted', 'the layout does not list this folder', entry);
      if (header.size !== 0) throw new TarFailure('size', 'a folder entry carries data', entry);
      await this.create(entry, dir, () => this.fs.mkdir(this.target(dir)));
      this.dirs++;
      this.state = { kind: 'header' };
      return;
    }
    const row = this.fileRows.get(key);
    if (row === undefined) throw new TarFailure('unlisted', 'the layout does not list this file', entry);
    if (header.size !== row.size) throw new TarFailure('size', 'a file has another size than the layout lists', entry);
    const handle = await this.create(entry, row.path, () => this.fs.open(this.target(row.path), 'wx'));
    const state: State = { kind: 'file', rel: row.path, entry, left: header.size, at: 0, handle, hash: createHash('sha256'), sha256: row.sha256.toLowerCase() };
    this.state = state;
    if (header.size === 0) await this.endEntry(state);
  }

  private target(rel: string): string {
    return path.join(this.payloadDir, ...rel.split('/'));
  }

  private async create<T>(entry: string, rel: string, make: () => Promise<T>): Promise<T> {
    try {
      const made = await make();
      this.written.push(rel);
      return made;
    } catch (error) {
      const code = fsCode(error);
      if (code === 'ENOENT') throw new TarFailure('parent-missing', 'an entry comes before its folder', entry);
      if (code === 'EEXIST') throw new TarFailure('exists', 'something already exists at an entry path', entry);
      throw new TarFailure('file', `an entry could not be created${code ? ` (${code})` : ''}`, entry);
    }
  }

  private async writeFile(state: Extract<State, { kind: 'file' }>, piece: Buffer): Promise<void> {
    state.hash.update(piece);
    try {
      let done = 0;
      while (done < piece.length) {
        const { bytesWritten } = await state.handle.write(piece, done, piece.length - done, state.at + done);
        if (bytesWritten <= 0) throw new Error('nothing written');
        done += bytesWritten;
      }
      state.at += piece.length;
    } catch (error) {
      const code = fsCode(error);
      throw new TarFailure('file', `a file could not be written${code ? ` (${code})` : ''}`, state.entry);
    }
  }

  private async endEntry(state: Exclude<State, { kind: 'header' } | { kind: 'end' }>): Promise<void> {
    if (state.kind === 'file') {
      this.state = { kind: 'header' };
      try {
        await state.handle.close();
      } catch (error) {
        const code = fsCode(error);
        throw new TarFailure('file', `a file could not be closed${code ? ` (${code})` : ''}`, state.entry);
      }
      if (state.hash.digest('hex') !== state.sha256) throw new TarFailure('digest', 'a file has another SHA-256 than the layout lists', state.entry);
      this.files++;
      return;
    }
    if (state.kind === 'pax') checkPax(state.data, state.entry);
    this.state = { kind: 'header' };
  }
}

const defaultFs: TarReaderFs = {
  open: (file, flags) => fsp.open(file, flags),
  mkdir: (dir) => fsp.mkdir(dir),
  readdir: (dir) => fsp.readdir(dir),
  lstat: (file) => fsp.lstat(file),
};

/** Extract the archive into the empty payload folder, exactly as the layout lists it. Never throws for a bad archive. */
export async function extractTarGz(request: TarExtractRequest, deps: { fs?: TarReaderFs } = {}): Promise<TarExtractResult> {
  if (!path.isAbsolute(request.archivePath) || !path.isAbsolute(request.payloadDir)) {
    throw new TypeError('An extraction needs absolute archive and payload paths.');
  }
  const fs = deps.fs ?? defaultFs;
  const extraction = new TarExtraction(request.payloadDir, request.layout, fs, request.signal);
  let decompressed = 0;
  let archive: fsp.FileHandle | undefined;
  try {
    if (request.signal.aborted) throw new TarFailure('cancelled', 'the extraction was cancelled');
    const problem = layoutProblem(request.layout);
    if (problem) throw new TarFailure('layout', `the layout ${problem}`);
    await checkPayloadFolder(fs, request.payloadDir);
    try {
      archive = await fs.open(request.archivePath, 'r');
    } catch (error) {
      throw new TarFailure('file', `the archive could not be opened${fsCode(error) ? ` (${fsCode(error)})` : ''}`);
    }
    const fileSize = (await archive.stat()).size;
    const head = Buffer.alloc(Math.min(fileSize, TAR_LIMITS.maxGzipHeaderBytes));
    await archive.read(head, 0, head.length, 0);
    const headerBytes = gzipHeaderLength(head, fileSize);
    const bodyBytes = fileSize - 8 - headerBytes;
    const trailer = Buffer.alloc(8);
    await archive.read(trailer, 0, 8, fileSize - 8);

    const limit = tarDecompressedLimit(request.layout);
    const inflater = zlib.createInflateRaw({ chunkSize: 64 * 1024 });
    let crc = 0;
    // What the extraction stage itself refused. Node 22's pipeline rejects with an AbortError in its place (Node 25
    // passes it through), so it is kept here and reported, not read back from the pipeline's error.
    let refused: TarFailure | undefined;
    try {
      await pipeline(
        archive.createReadStream({ start: headerBytes, end: headerBytes + bodyBytes - 1, autoClose: false, highWaterMark: 256 * 1024 }),
        inflater,
        async (source: AsyncIterable<Buffer>) => {
          try {
            for await (const chunk of source) {
              decompressed += chunk.length;
              if (decompressed > limit) throw new TarFailure('bounds', `the archive decompresses to more than ${limit} bytes`);
              crc = crc32(chunk, crc);
              await extraction.write(chunk);
            }
          } catch (error) {
            if (error instanceof TarFailure) refused = error;
            throw error;
          }
        },
        { signal: request.signal },
      );
    } catch (error) {
      if (refused) throw refused;
      if (error instanceof TarFailure) throw error;
      if (request.signal.aborted) throw new TarFailure('cancelled', 'the extraction was cancelled');
      // When the deflate data ends before the input does, Node ends the inflater's output early, and input that
      // arrives after that end fails the pipeline as a premature close. Input in the same chunk is caught below.
      if (fsCode(error) === 'ERR_STREAM_PREMATURE_CLOSE') throw new TarFailure('trailing-data', 'the archive has data after its gzip member');
      throw new TarFailure('gzip', `the archive is not valid gzip data${fsCode(error) ? ` (${fsCode(error)})` : ''}`);
    }
    if (inflater.bytesWritten !== bodyBytes) throw new TarFailure('trailing-data', 'the archive has data after its gzip member');
    if (trailer.readUInt32LE(0) !== crc || trailer.readUInt32LE(4) !== decompressed % 0x1_0000_0000) {
      throw new TarFailure('gzip', 'the gzip trailer does not match the data');
    }
    extraction.finish();
    return {
      ok: true,
      files: extraction.files,
      dirs: extraction.dirs,
      ignored: extraction.ignored,
      entries: extraction.entries,
      decompressedBytes: decompressed,
      written: extraction.written,
    };
  } catch (error) {
    const failure = error instanceof TarFailure ? error : new TarFailure('file', `the extraction failed${fsCode(error) ? ` (${fsCode(error)})` : ''}`);
    return {
      ok: false,
      failure: tarFailureClass(failure.reason),
      reason: failure.reason,
      ...(failure.entry !== undefined ? { entry: failure.entry } : {}),
      detail: failure.detail,
      decompressedBytes: decompressed,
      written: extraction.written,
    };
  } finally {
    await extraction.close();
    await archive?.close().catch(() => undefined);
  }
}

async function checkPayloadFolder(fs: TarReaderFs, dir: string): Promise<void> {
  let stat: { isDirectory(): boolean; isSymbolicLink(): boolean };
  try {
    stat = await fs.lstat(dir);
  } catch {
    throw new TarFailure('payload', 'the payload folder does not exist');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TarFailure('payload', 'the payload folder is not a plain folder');
  if ((await fs.readdir(dir)).length > 0) throw new TarFailure('payload', 'the payload folder is not empty');
}
