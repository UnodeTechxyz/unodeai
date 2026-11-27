import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  crc32Fallback,
  extractTarGz,
  tarDecompressedLimit,
  TAR_LIMITS,
  unsafePackagePath,
  type TarLayout,
  type TarReaderFs,
} from '../tarReader';

// ADAPTER §5.4 (only `tar.gz`, Revision 5 §1) and Revision 5 §11 item 8. Every archive is built byte by byte here.

interface HeaderOptions { magic?: string; version?: string; prefix?: string; linkname?: string; checksumDelta?: number; sizeField?: Buffer }

function header(name: string, type: string, size: number, options: HeaderOptions = {}): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'latin1');
  block.write('0000644\0', 100, 'latin1');
  block.write('0000000\0', 108, 'latin1');
  block.write('0000000\0', 116, 'latin1');
  if (options.sizeField) options.sizeField.copy(block, 124);
  else block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  block.write('15264123577\0', 136, 'latin1');
  block[156] = type.charCodeAt(0);
  if (options.linkname) block.write(options.linkname, 157, 'latin1');
  block.write(options.magic ?? 'ustar\0', 257, 'latin1');
  block.write(options.version ?? '00', 263, 'latin1');
  if (options.prefix) block.write(options.prefix, 345, 'latin1');
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${(sum + (options.checksumDelta ?? 0)).toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}

function padded(data: Buffer): Buffer {
  const rest = data.length % 512;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rest)]);
}

function paxRecord(key: string, value: string): Buffer {
  const text = ` ${key}=${value}\n`;
  let length = text.length + 1;
  while (String(length).length + text.length !== length) length = String(length).length + text.length;
  return Buffer.from(`${length}${text}`, 'latin1');
}

function paxData(data: Buffer): Buffer {
  return Buffer.concat([header('././@PaxHeader', 'x', data.length), padded(data)]);
}

function pax(...records: Array<[string, string]>): Buffer {
  return paxData(Buffer.concat(records.map(([key, value]) => paxRecord(key, value))));
}

const mtime = (): Buffer => pax(['mtime', '1792095599.8596323']);
const file = (name: string, data: Buffer, options?: HeaderOptions): Buffer => Buffer.concat([header(name, '0', data.length, options), padded(data)]);
const dir = (name: string, options?: HeaderOptions): Buffer => header(name.endsWith('/') ? name : `${name}/`, '5', 0, options);
const tar = (...parts: Buffer[]): Buffer => Buffer.concat([...parts, Buffer.alloc(1024)]);
const gz = (data: Buffer): Buffer => zlib.gzipSync(data);
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

const CODEX = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(3000, 0x41)]);
const PACKAGE_JSON = Buffer.from('{"layoutVersion":1,"entrypoint":"bin/codex.exe"}\n');
const NOTICE = Buffer.alloc(700, 0x6e);
const EMPTY = Buffer.alloc(0);
const FILES: Array<[string, Buffer]> = [
  ['bin/codex.exe', CODEX],
  ['bin/empty.txt', EMPTY],
  ['codex-package.json', PACKAGE_JSON],
  ['codex-resources/voice/NOTICE.md', NOTICE],
];
const DIRS = ['bin', 'codex-resources', 'codex-resources/voice'];

function layout(overrides: Partial<TarLayout> = {}): TarLayout {
  return {
    entrypoint: 'bin/codex.exe',
    unpackedBytes: FILES.reduce((sum, [, data]) => sum + data.length, 0),
    dirs: DIRS,
    ignoredEntries: [],
    files: FILES.map(([rel, data]) => ({ path: rel, size: data.length, sha256: sha256(data) })),
    ...overrides,
  };
}

/** The package as the real archive orders it: a pax `mtime` header before each entry, every folder before its contents. */
function entries(): Buffer[] {
  return [
    mtime(), dir('bin'), // 0, 1
    mtime(), file('bin/codex.exe', CODEX), // 2, 3
    mtime(), file('bin/empty.txt', EMPTY), // 4, 5
    mtime(), file('codex-package.json', PACKAGE_JSON), // 6, 7
    mtime(), dir('codex-resources'), // 8, 9
    mtime(), dir('codex-resources/voice'), // 10, 11
    mtime(), file('codex-resources/voice/NOTICE.md', NOTICE), // 12, 13
  ];
}

function replaced(index: number, ...parts: Buffer[]): Buffer[] {
  const list = entries();
  list.splice(index, 1, ...parts);
  return list;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface ExtractOptions { layout?: TarLayout; fs?: TarReaderFs; signal?: AbortSignal; prepare?: (payloadDir: string) => void }

async function extract(archive: Buffer, options: ExtractOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unode-tar-'));
  roots.push(root);
  const archivePath = path.join(root, 'pkg.tar.gz');
  fs.writeFileSync(archivePath, archive);
  const payloadDir = path.join(root, 'payload');
  fs.mkdirSync(payloadDir);
  options.prepare?.(payloadDir);
  const result = await extractTarGz(
    { archivePath, payloadDir, layout: options.layout ?? layout(), signal: options.signal ?? new AbortController().signal },
    { fs: options.fs },
  );
  return { result, payloadDir };
}

function tree(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(`${child}/`, ...tree(root, child));
    else out.push(child);
  }
  return out.sort();
}

function realFs(overrides: Partial<TarReaderFs> = {}): TarReaderFs {
  return {
    open: (target, flags) => fsp.open(target, flags),
    mkdir: (target) => fsp.mkdir(target),
    readdir: (target) => fsp.readdir(target),
    lstat: (target) => fsp.lstat(target),
    ...overrides,
  };
}

/** A gzip member written by hand, with optional header fields and a trailer that can be made wrong. */
function gzipWith(data: Buffer, options: { flags: number; extra?: Buffer; name?: string; comment?: string; badHeaderCrc?: boolean; crcDelta?: number; sizeDelta?: number }): Buffer {
  const parts: Buffer[] = [Buffer.from([0x1f, 0x8b, 8, options.flags, 0x70, 0x35, 0xd1, 0x6a, 0, 0xff])];
  if (options.extra) {
    const length = Buffer.alloc(2);
    length.writeUInt16LE(options.extra.length);
    parts.push(length, options.extra);
  }
  if (options.name !== undefined) parts.push(Buffer.from(`${options.name}\0`, 'latin1'));
  if (options.comment !== undefined) parts.push(Buffer.from(`${options.comment}\0`, 'latin1'));
  let head = Buffer.concat(parts);
  if (options.flags & 0x02) {
    const check = Buffer.alloc(2);
    check.writeUInt16LE((crc32Fallback(head) & 0xffff) ^ (options.badHeaderCrc ? 1 : 0));
    head = Buffer.concat([head, check]);
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE((crc32Fallback(data) + (options.crcDelta ?? 0)) >>> 0, 0);
  trailer.writeUInt32LE((data.length + (options.sizeDelta ?? 0)) >>> 0, 4);
  return Buffer.concat([head, zlib.deflateRawSync(data), trailer]);
}

describe('extractTarGz', () => {
  it('extracts the package exactly as the layout lists it, accepting pax mtime headers', async () => {
    const { result, payloadDir } = await extract(gz(tar(...entries())));
    expect(result).toMatchObject({ ok: true, files: 4, dirs: 3, ignored: 0, entries: 7 });
    expect(result.written).toEqual(['bin', 'bin/codex.exe', 'bin/empty.txt', 'codex-package.json', 'codex-resources', 'codex-resources/voice', 'codex-resources/voice/NOTICE.md']);
    expect(tree(payloadDir)).toEqual(['bin/', 'bin/codex.exe', 'bin/empty.txt', 'codex-package.json', 'codex-resources/', 'codex-resources/voice/', 'codex-resources/voice/NOTICE.md']);
    for (const [rel, data] of FILES) expect(fs.readFileSync(path.join(payloadDir, ...rel.split('/'))).equals(data)).toBe(true);
  });

  it('skips the ignored entries and never writes them', async () => {
    const archive = gz(tar(...entries(), mtime(), file('LICENSE', Buffer.from('license text')), dir('docs')));
    const { result, payloadDir } = await extract(archive, { layout: layout({ ignoredEntries: ['LICENSE', 'docs'] }) });
    expect(result).toMatchObject({ ok: true, ignored: 2 });
    expect(fs.existsSync(path.join(payloadDir, 'LICENSE'))).toBe(false);
    expect(fs.existsSync(path.join(payloadDir, 'docs'))).toBe(false);
  });

  // ADAPTER §5.4.2: `x` whose keys ⊆ {mtime}; any other pax key is refused.
  it.each([
    ['path', 'bin/codex.exe'],
    ['linkpath', 'bin/codex.exe'],
    ['size', String(CODEX.length)],
    ['uid', '0'],
    ['MTIME', '1792095599'],
    ['atime', '1792095599'],
  ])('refuses the pax key %s', async (key, value) => {
    const { result, payloadDir } = await extract(gz(tar(...replaced(2, pax(['mtime', '1'], [key, value])))));
    expect(result).toMatchObject({ ok: false, failure: 'integrity', reason: 'pax', detail: expect.stringContaining(key) });
    expect(fs.existsSync(path.join(payloadDir, 'bin', 'codex.exe'))).toBe(false);
  });

  it.each([
    ['a wrong record length', paxData(Buffer.from('99 mtime=1\n'))],
    ['a record without a newline', paxData(Buffer.from('11 mtime=12x'))],
    ['a record without a key', paxData(Buffer.from('6 =12\n'))],
    ['two pax headers in a row', Buffer.concat([mtime(), mtime()])],
    ['a pax header larger than the reader reads', pax(['mtime', '1'.repeat(TAR_LIMITS.maxPaxBytes)])],
  ])('refuses %s', async (_label, replacement) => {
    const { result } = await extract(gz(tar(...replaced(2, replacement))));
    expect(result).toMatchObject({ ok: false, reason: 'pax' });
  });

  it('refuses a pax header with no entry after it', async () => {
    const { result } = await extract(gz(tar(...entries(), mtime())));
    expect(result).toMatchObject({ ok: false, reason: 'pax', detail: 'a pax header has no entry after it' });
  });

  // ADAPTER §5.4.2: refused g, L, K, 1, 2, 3, 4, 6, 7 and any other type. The entry carries a listed name and size,
  // so only its type refuses it.
  it.each(['1', '2', '3', '4', '6', '7', 'L', 'K', 'g', 'S', 'V', 'D', 'M', 'N', 'A'])('refuses an entry of type %s', async (type) => {
    const { result, payloadDir } = await extract(gz(tar(...replaced(5, header('bin/empty.txt', type, 0, { linkname: 'codex.exe' })))));
    expect(result).toMatchObject({ ok: false, failure: 'integrity', reason: 'type', entry: 'bin/empty.txt' });
    expect(fs.existsSync(path.join(payloadDir, 'bin', 'empty.txt'))).toBe(false);
  });

  it('refuses a symbolic link even when its name and size are a listed file', async () => {
    const link = header('bin/empty.txt', '2', 0, { linkname: '../../../Windows/System32/cmd.exe' });
    const { result } = await extract(gz(tar(...replaced(5, link))));
    expect(result).toMatchObject({ ok: false, reason: 'type', detail: 'the archive holds a symbolic link' });
  });

  // Revision 5 §11 item 8: `..`, absolute paths, `C:`, reserved names. Refused by the path rule before the allowlist.
  it.each([
    '../codex.exe', 'bin/../../codex.exe', '/bin/codex.exe', 'C:/bin/codex.exe', 'C:codex.exe', 'bin\\codex.exe',
    './bin/codex.exe', 'bin/./codex.exe', 'bin//codex.exe', 'bin/codex.exe.', 'bin/codex .exe', 'bin/CON', 'bin/nul.txt',
    'bin/COM1.dll', 'LPT9', 'aux.json', 'bin/codex\u00e9.exe', 'bin/codex.exe:stream',
  ])('refuses the entry name %j', async (name) => {
    const { result } = await extract(gz(tar(...replaced(3, file(name, CODEX)))));
    expect(result).toMatchObject({ ok: false, failure: 'integrity', reason: 'name' });
  });

  it('refuses a folder entry name that fails the path rule', async () => {
    const { result } = await extract(gz(tar(...replaced(1, dir('../bin')))));
    expect(result).toMatchObject({ ok: false, reason: 'name' });
  });

  it.each([
    ['a .. segment', (files: TarLayout['files']) => [{ ...files[0], path: '../codex.exe' }, ...files.slice(1)]],
    ['a reserved device name', (files: TarLayout['files']) => [...files.slice(0, 1), { ...files[1], path: 'bin/nul.txt' }, ...files.slice(2)]],
    ['a drive path', (files: TarLayout['files']) => [{ ...files[0], path: 'C:/codex.exe' }, ...files.slice(1)]],
    ['a trailing dot', (files: TarLayout['files']) => [...files, { path: 'bin/extra.', size: 0, sha256: sha256(EMPTY) }]],
    ['a case-insensitive duplicate', (files: TarLayout['files']) => [...files, { path: 'BIN/CODEX.EXE', size: CODEX.length, sha256: sha256(CODEX) }]],
    ['a file whose folder is not listed', (files: TarLayout['files']) => [...files, { path: 'lib/x.dll', size: 0, sha256: sha256(EMPTY) }]],
    ['a bad SHA-256', (files: TarLayout['files']) => [{ ...files[0], sha256: 'abc' }, ...files.slice(1)]],
  ])('refuses a layout with %s before reading the archive', async (_label, edit) => {
    const bad = layout();
    const files = edit(bad.files);
    const archive = gz(tar(...replaced(5, file(files[1].path, EMPTY))));
    const { result, payloadDir } = await extract(archive, { layout: { ...bad, files } });
    expect(result).toMatchObject({ ok: false, reason: 'layout', written: [] });
    expect(tree(payloadDir)).toEqual([]);
  });

  it('refuses a layout whose entrypoint is not listed, whose unpacked size is below its files, or with more than 20,000 entries', async () => {
    for (const bad of [
      layout({ entrypoint: 'bin/missing.exe' }),
      layout({ unpackedBytes: CODEX.length }),
      layout({ ignoredEntries: Array.from({ length: TAR_LIMITS.maxEntries - 7 + 1 }, (_, index) => `i${index}`) }),
    ]) {
      const { result } = await extract(gz(tar(...entries())), { layout: bad });
      expect(result).toMatchObject({ ok: false, reason: 'layout' });
    }
  });

  // ADAPTER §5.4.3: names are compared case-insensitively; two names equal that way are refused.
  it.each([
    ['the same file twice', [mtime(), file('bin/codex.exe', CODEX)]],
    ['a file in another letter case', [file('BIN/CODEX.EXE', CODEX)]],
    ['a folder in another letter case', [dir('Bin')]],
    ['a file named like a folder', [file('BIN', EMPTY)]],
  ])('refuses %s', async (_label, extra) => {
    const { result } = await extract(gz(tar(...entries(), ...extra)));
    expect(result).toMatchObject({ ok: false, failure: 'integrity', reason: 'duplicate' });
  });

  // ADAPTER §5.4.3: the exact file list is the allowlist.
  it('refuses an unlisted file and never writes it', async () => {
    const { result, payloadDir } = await extract(gz(tar(...entries(), mtime(), file('bin/extra.dll', Buffer.from('MZ planted')))));
    expect(result).toMatchObject({ ok: false, reason: 'unlisted', entry: 'bin/extra.dll' });
    expect(fs.existsSync(path.join(payloadDir, 'bin', 'extra.dll'))).toBe(false);
  });

  it.each([
    ['an unlisted folder', dir('extra')],
    ['a file named as a listed folder', file('codex-path', EMPTY)],
    ['a folder named as a listed file', dir('codex-package.json')],
  ])('refuses %s', async (_label, entry) => {
    const list = entries();
    list.splice(6, 2, entry);
    const archive = gz(tar(...list));
    const { result } = await extract(archive, { layout: layout({ dirs: [...DIRS, 'codex-path'] }) });
    expect(result).toMatchObject({ ok: false, reason: 'unlisted' });
  });

  it('refuses an archive without a listed file, and without a listed folder', async () => {
    const withoutNotice = entries().slice(0, 12);
    const first = await extract(gz(tar(...withoutNotice)));
    expect(first.result).toMatchObject({ ok: false, reason: 'missing', entry: 'codex-resources/voice/NOTICE.md' });
    const second = await extract(gz(tar(...entries())), { layout: layout({ dirs: [...DIRS, 'codex-path'] }) });
    expect(second.result).toMatchObject({ ok: false, reason: 'missing', entry: 'codex-path' });
  });

  // ADAPTER §5.4.4: the SHA-256 is computed while writing; a mismatch aborts.
  it('refuses a file with another size, before creating it', async () => {
    const { result, payloadDir } = await extract(gz(tar(...replaced(3, file('bin/codex.exe', Buffer.concat([CODEX, Buffer.from('!')]))))));
    expect(result).toMatchObject({ ok: false, reason: 'size', entry: 'bin/codex.exe', written: ['bin'] });
    expect(fs.existsSync(path.join(payloadDir, 'bin', 'codex.exe'))).toBe(false);
  });

  it('refuses a file with another SHA-256 and says the file was left for the caller', async () => {
    const changed = Buffer.from(CODEX);
    changed[1500] ^= 0x01;
    const { result, payloadDir } = await extract(gz(tar(...replaced(3, file('bin/codex.exe', changed)))));
    expect(result).toMatchObject({ ok: false, failure: 'integrity', reason: 'digest', entry: 'bin/codex.exe', written: ['bin', 'bin/codex.exe'] });
    expect(fs.existsSync(path.join(payloadDir, 'bin', 'codex.exe'))).toBe(true);
  });

  it('refuses a folder entry that carries data', async () => {
    const { result } = await extract(gz(tar(...replaced(1, Buffer.concat([header('bin/', '5', 10), padded(Buffer.alloc(10, 1))])))));
    expect(result).toMatchObject({ ok: false, reason: 'size', entry: 'bin/' });
  });

  // ADAPTER §5.4.5: a gzip bomb aborts on the byte count.
  it('ends a gzip bomb on the decompressed byte count', async () => {
    const bomb = gz(Buffer.concat([tar(...entries()), Buffer.alloc(32 * 1024 * 1024)]));
    expect(bomb.length).toBeLessThan(64 * 1024);
    const { result } = await extract(bomb);
    expect(result).toMatchObject({ ok: false, reason: 'bounds' });
    expect(result.decompressedBytes).toBeLessThanOrEqual(tarDecompressedLimit(layout()) + 64 * 1024);
  });

  it('ends an ignored entry larger than the bound on the byte count', async () => {
    const big = Buffer.concat([header('big.bin', '0', 64 * 1024 * 1024), Buffer.alloc(64 * 1024 * 1024)]);
    const { result } = await extract(gz(tar(...entries(), big)), { layout: layout({ ignoredEntries: ['big.bin'] }) });
    expect(result).toMatchObject({ ok: false, reason: 'bounds' });
    expect(result.decompressedBytes).toBeLessThan(1024 * 1024);
  });

  it('bounds the decompressed bytes by the layout and by 1 GiB', () => {
    const small = layout();
    expect(tarDecompressedLimit(small)).toBe(small.unpackedBytes + 7 * (512 + 512 + 1024 + 511) + 21 * 512);
    expect(tarDecompressedLimit(layout({ unpackedBytes: 1024 * 1024 * 1024 }))).toBe(1024 * 1024 * 1024);
  });

  // ADAPTER §5.4.2 (amended in the slice brief): trailing data after the gzip member.
  it.each([
    ['garbage', Buffer.from('trailing garbage')],
    ['a second gzip member', gz(Buffer.alloc(512))],
    ['zero bytes', Buffer.alloc(16)],
  ])('refuses %s after the gzip member', async (_label, extra) => {
    const { result } = await extract(Buffer.concat([gz(tar(...entries())), extra]));
    expect(result).toMatchObject({ ok: false, failure: 'integrity', reason: 'trailing-data' });
  });

  it('refuses a non-zero block after the end-of-archive blocks', async () => {
    const { result } = await extract(gz(Buffer.concat([tar(...entries()), Buffer.alloc(512, 0x41)])));
    expect(result).toMatchObject({ ok: false, reason: 'after-end' });
  });

  it('accepts the zero padding of the last record after the end blocks', async () => {
    const { result } = await extract(gz(Buffer.concat([tar(...entries()), Buffer.alloc(19 * 512)])));
    expect(result).toMatchObject({ ok: true });
  });

  // ADAPTER §5.4.5: at most 20,000 entries. The layout lists 20,000; the archive has one more.
  it('refuses more than 20,000 entries on the count, before the unlisted name', async () => {
    const ignored = Array.from({ length: TAR_LIMITS.maxEntries - 7 }, (_, index) => `i${index}`);
    const archive = gz(tar(...entries(), ...ignored.map((name) => header(name, '0', 0)), header('one-more', '0', 0)));
    const { result } = await extract(archive, { layout: layout({ ignoredEntries: ignored }) });
    expect(result).toMatchObject({ ok: false, reason: 'bounds', entry: 'one-more' });
  });

  // ADAPTER §5.4.4: files are created with open('wx').
  it('refuses to overwrite a file that appears at an entry path while it extracts (EEXIST on wx)', async () => {
    let planted = false;
    const fsWithPlant = realFs({
      open: async (target, flags) => {
        if (!planted && target.endsWith(`${path.sep}codex.exe`)) {
          planted = true;
          await fsp.writeFile(target, 'planted');
        }
        return fsp.open(target, flags);
      },
    });
    const { result, payloadDir } = await extract(gz(tar(...entries())), { fs: fsWithPlant });
    expect(planted).toBe(true);
    expect(result).toMatchObject({ ok: false, failure: 'file', reason: 'exists', entry: 'bin/codex.exe' });
    expect(fs.readFileSync(path.join(payloadDir, 'bin', 'codex.exe'), 'utf8')).toBe('planted');
  });

  // ADAPTER §5.4.2: the header checksum, the magic and version, the prefix and base-256 sizes.
  it('refuses a header whose checksum does not match', async () => {
    const { result, payloadDir } = await extract(gz(tar(...replaced(3, file('bin/codex.exe', CODEX, { checksumDelta: 1 })))));
    expect(result).toMatchObject({ ok: false, reason: 'header', detail: 'a tar header checksum does not match' });
    expect(fs.existsSync(path.join(payloadDir, 'bin', 'codex.exe'))).toBe(false);
  });

  it.each([
    ['the GNU magic', { magic: 'ustar ', version: ' \0' }],
    ['version 01', { version: '01' }],
    ['no magic', { magic: '\0\0\0\0\0\0', version: '\0\0' }],
  ])('refuses a header with %s', async (_label, options) => {
    const { result } = await extract(gz(tar(...replaced(3, file('bin/codex.exe', CODEX, options)))));
    expect(result).toMatchObject({ ok: false, reason: 'header', detail: 'a tar header is not ustar version 00' });
  });

  it('refuses a header that uses the prefix field', async () => {
    const { result } = await extract(gz(tar(...replaced(3, file('codex.exe', CODEX, { prefix: 'bin' })))));
    expect(result).toMatchObject({ ok: false, reason: 'header', detail: 'a tar header uses the prefix field' });
  });

  it('refuses a base-256 size', async () => {
    const sizeField = Buffer.alloc(12);
    sizeField[0] = 0x80;
    sizeField.writeUInt16BE(CODEX.length, 10);
    const { result } = await extract(gz(tar(...replaced(3, file('bin/codex.exe', CODEX, { sizeField })))));
    expect(result).toMatchObject({ ok: false, reason: 'header', detail: 'a tar header has a base-256 size' });
  });

  // ADAPTER §5.4 as briefed: folders are created without `recursive`, so each parent must already exist.
  it('refuses a folder that comes before its parent folder', async () => {
    const list = entries();
    const [voicePax, voice] = list.splice(10, 2);
    list.splice(8, 0, voicePax, voice);
    const { result, payloadDir } = await extract(gz(tar(...list)));
    expect(result).toMatchObject({ ok: false, reason: 'parent-missing', entry: 'codex-resources/voice/' });
    expect(tree(payloadDir)).toEqual(['bin/', 'bin/codex.exe', 'bin/empty.txt', 'codex-package.json']);
  });

  it('refuses a file that comes before its folder', async () => {
    const list = entries();
    const [binPax, bin] = list.splice(0, 2);
    list.splice(2, 0, binPax, bin);
    const { result } = await extract(gz(tar(...list)));
    expect(result).toMatchObject({ ok: false, reason: 'parent-missing', entry: 'bin/codex.exe', written: [] });
  });

  it('refuses a payload folder that is not empty, is missing, or is not a folder', async () => {
    const notEmpty = await extract(gz(tar(...entries())), { prepare: (payload) => fs.writeFileSync(path.join(payload, 'old.txt'), 'x') });
    expect(notEmpty.result).toMatchObject({ ok: false, failure: 'file', reason: 'payload', detail: 'the payload folder is not empty' });
    const missing = await extract(gz(tar(...entries())), { prepare: (payload) => fs.rmdirSync(payload) });
    expect(missing.result).toMatchObject({ ok: false, reason: 'payload', detail: 'the payload folder does not exist' });
    const aFile = await extract(gz(tar(...entries())), { prepare: (payload) => { fs.rmdirSync(payload); fs.writeFileSync(payload, 'x'); } });
    expect(aFile.result).toMatchObject({ ok: false, reason: 'payload', detail: 'the payload folder is not a plain folder' });
  });

  // ADAPTER §5.12.1: cancelling stops the extraction.
  it('stops on the abort signal, before it starts and while it runs', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const before = await extract(gz(tar(...entries())), { signal: aborted.signal });
    expect(before.result).toMatchObject({ ok: false, failure: 'cancelled', reason: 'cancelled', written: [] });
    expect(tree(before.payloadDir)).toEqual([]);

    const controller = new AbortController();
    const abortOnPackageJson = realFs({
      open: async (target, flags) => {
        if (target.endsWith('codex-package.json')) controller.abort();
        return fsp.open(target, flags);
      },
    });
    const during = await extract(gz(tar(...entries())), { fs: abortOnPackageJson, signal: controller.signal });
    expect(during.result).toMatchObject({ ok: false, failure: 'cancelled', reason: 'cancelled' });
    expect(during.result.ok === false && during.result.written).not.toContain('codex-resources');
  });

  it('refuses an archive that ends inside an entry or before its end blocks, and a lone zero block', async () => {
    const body = Buffer.concat(entries());
    for (const archive of [gz(body), gz(Buffer.concat([body, Buffer.alloc(512)])), gz(body.subarray(0, 3 * 512 + 1000))]) {
      const { result } = await extract(archive);
      expect(result).toMatchObject({ ok: false, reason: 'truncated' });
    }
    const lone = entries();
    lone.splice(4, 0, Buffer.alloc(512));
    const { result } = await extract(gz(tar(...lone)));
    expect(result).toMatchObject({ ok: false, reason: 'header', detail: 'the archive has a lone zero block' });
  });

  it('accepts a gzip header with a name, a comment, an extra field and a header checksum', async () => {
    const archive = gzipWith(tar(...entries()), { flags: 0x02 | 0x04 | 0x08 | 0x10, extra: Buffer.from('AB\x02\x00xy', 'latin1'), name: 'codex-package.tar', comment: 'built' });
    const { result } = await extract(archive);
    expect(result).toMatchObject({ ok: true, files: 4 });
  });

  it.each([
    ['not gzip at all', () => tar(...entries())],
    ['reserved flags', () => gzipWith(tar(...entries()), { flags: 0x20 })],
    ['a wrong header checksum', () => gzipWith(tar(...entries()), { flags: 0x02 | 0x08, name: 'x', badHeaderCrc: true })],
    ['a wrong CRC-32', () => gzipWith(tar(...entries()), { flags: 0, crcDelta: 1 })],
    ['a wrong length', () => gzipWith(tar(...entries()), { flags: 0, sizeDelta: 1 })],
    ['cut deflate data', () => { const whole = gz(tar(...entries())); return Buffer.concat([whole.subarray(0, whole.length - 40), whole.subarray(whole.length - 8)]); }],
  ])('refuses gzip with %s', async (_label, build) => {
    const { result } = await extract(build());
    expect(result).toMatchObject({ ok: false, failure: 'integrity', reason: 'gzip' });
  });
});

describe('tar reader helpers', () => {
  it('computes CRC-32 as zlib does when zlib.crc32 is missing', () => {
    expect(crc32Fallback(Buffer.from('123456789'))).toBe(0xcbf43926);
    const data = createHash('sha512').update('fixture').digest();
    expect(crc32Fallback(data.subarray(20), crc32Fallback(data.subarray(0, 20)))).toBe(crc32Fallback(data));
    const native = (zlib as { crc32?: (data: Uint8Array, value?: number) => number }).crc32;
    if (native) expect(crc32Fallback(data)).toBe(native(data));
  });

  it('accepts the package paths and refuses unsafe ones', () => {
    for (const safe of ['bin/codex.exe', 'codex-resources/voice/LGPL-2.1.txt', 'codex-resources/voice/bin/gstapp-1.0-0.dll', '.hidden']) {
      expect(unsafePackagePath(safe), safe).toBeUndefined();
    }
    for (const unsafe of ['', 'a//b', '/a', 'a/', '..', 'a/./b', 'C:', 'a\\b', 'CON', 'con.txt', 'Com9.dll', 'lpt1', 'a.', 'a b', 'a/\u00e9']) {
      expect(unsafePackagePath(unsafe), unsafe).toBeDefined();
    }
  });
});
