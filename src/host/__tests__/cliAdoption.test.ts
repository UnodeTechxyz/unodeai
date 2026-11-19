import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closureDigest, closureListing } from '../../backend/cliClosure';
import type { CliClosureFile, CliClosureKind } from '../../backend/cliCompatibilityPolicy';
import {
  ADOPTION_LISTING_MAX_LINES,
  adoptionId,
  adoptionRecordPath,
  changedFiles,
  externalPathInStore,
  findAdoption,
  forgetAdoptions,
  recordAdoption,
  type AdoptionContext,
  type AdoptionInput,
} from '../cliAdoption';
import { canonicalJson, recordDigest } from '../managedCli/storeLayout';

// The design these tests realise: External adoption records. One record per exact identity, keyed by
// sha256(provider | physical program, case-folded on Windows | closure digest), created exclusively and never
// rewritten; it holds the closure listing, so a later mismatch names the changed file. A damaged or mismatched record
// is not evidence; neither is any record while the store is reachable from a write root or Folder Access grant.
// "Forget adoptions" deletes them. An External program inside cli-store\ is refused (external-path-in-store).

const temps: string[] = [];
afterEach(() => {
  for (const folder of temps.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'unode-adoption-'));
  temps.push(dir);
  return dir;
}

const hex = (seed: string) => seed.repeat(64).slice(0, 64);

function closure(executable: string, files: CliClosureFile[], kind: CliClosureKind = 'package') {
  const listing = closureListing(files);
  return { kind, executable, files, listing, digest: closureDigest(listing), executablePath: 'bin/codex.exe' };
}

const PACKAGE: CliClosureFile[] = [
  { path: 'bin/codex.exe', size: 341_270_320, sha256: hex('a') },
  { path: 'codex-package.json', size: 120, sha256: hex('b') },
  { path: 'codex-path/rg.exe', size: 5_000_000, sha256: hex('c') },
];

function context(storeRoot: string, reach: Partial<AdoptionContext['reach']> = {}): AdoptionContext {
  return { storeRoot, reach: { writeRoots: reach.writeRoots ?? [], folderAccessGrants: reach.folderAccessGrants ?? [] } };
}

function input(c: ReturnType<typeof closure>, version = '0.163.0'): AdoptionInput {
  return {
    provider: 'codex-cli', closure: c, version,
    probe: { result: 'pass', versionOutput: `codex-cli ${version}`, ranAt: '2026-10-21T10:00:00.000Z', durationMs: 412 },
    decidedAt: '2026-10-21T10:00:01.000Z', extensionVersion: '0.9.96',
  };
}

function setup() {
  const dir = temp();
  const storeRoot = path.join(dir, 'Local', 'UnodeAi', 'cli-store');
  mkdirSync(path.join(dir, 'Local'));
  const exe = path.join(dir, 'npm', 'codex', 'bin', 'codex.exe');
  return { dir, storeRoot, exe, ctx: context(storeRoot) };
}

describe('the identity key', () => {
  it('is the provider, the physical program without case on Windows, and the closure digest', () => {
    const id = adoptionId('codex-cli', 'C:\\Tools\\Codex\\bin\\codex.exe', hex('d'), 'win32');
    expect(adoptionId('codex-cli', 'c:\\tools\\codex\\BIN\\CODEX.EXE', hex('d'), 'win32')).toBe(id);
    expect(adoptionId('codex-cli', 'C:\\Tools\\Codex\\bin\\codex.exe', hex('e'), 'win32')).not.toBe(id);
    expect(adoptionId('claude-cli', 'C:\\Tools\\Codex\\bin\\codex.exe', hex('d'), 'win32')).not.toBe(id);
    expect(adoptionId('codex-cli', 'C:\\Tools\\Other\\bin\\codex.exe', hex('d'), 'win32')).not.toBe(id);
    expect(adoptionId('codex-cli', '/tools/Codex', hex('d'), 'linux')).not.toBe(adoptionId('codex-cli', '/tools/codex', hex('d'), 'linux'));
  });

  it('names the record file in the provider\'s folder under adoptions', () => {
    const { storeRoot, exe, ctx } = setup();
    const c = closure(exe, PACKAGE);
    const written = recordAdoption(input(c), ctx);
    expect(written).toMatchObject({ ok: true });
    const id = adoptionId('codex-cli', exe, c.digest);
    expect(written.ok && written.file).toBe(path.join(storeRoot, 'adoptions', 'codex-cli', `${id}.json`));
    expect(adoptionRecordPath(storeRoot, 'codex-cli', id)).toBe(path.join(storeRoot, 'adoptions', 'codex-cli', `${id}.json`));
    expect(readdirSync(path.join(storeRoot, 'adoptions', 'codex-cli'))).toEqual([`${id}.json`]);
  });
});

describe('recording and finding an adoption', () => {
  it('finds exactly the recorded identity, with its listing, version and passed check', () => {
    const { exe, ctx } = setup();
    const c = closure(exe, PACKAGE);
    expect(findAdoption('codex-cli', exe, c, ctx)).toEqual({ adopted: false, reason: 'none' });
    recordAdoption(input(c), ctx);
    const found = findAdoption('codex-cli', exe, c, ctx);
    expect(found).toMatchObject({
      adopted: true,
      adoptionId: adoptionId('codex-cli', exe, c.digest),
      record: { v: 1, provider: 'codex-cli', executable: exe, closureKind: 'package', closureDigest: c.digest, listing: c.listing, version: '0.163.0', probe: { result: 'pass', versionOutput: 'codex-cli 0.163.0' } },
    });
    expect(findAdoption('claude-cli', exe, c, ctx).adopted).toBe(false);
  });

  it('creates a record once: a second write of the same identity is refused and the first is kept', () => {
    const { exe, ctx, storeRoot } = setup();
    const c = closure(exe, PACKAGE);
    expect(recordAdoption(input(c, '0.163.0'), ctx)).toMatchObject({ ok: true });
    const file = adoptionRecordPath(storeRoot, 'codex-cli', adoptionId('codex-cli', exe, c.digest));
    const first = readFileSync(file, 'utf8');
    expect(recordAdoption(input(c, '9.9.9'), ctx)).toMatchObject({ ok: false, reason: 'exists' });
    expect(readFileSync(file, 'utf8')).toBe(first);
    expect(findAdoption('codex-cli', exe, c, ctx)).toMatchObject({ adopted: true, record: { version: '0.163.0' } });
    // No temp file is left behind either way.
    expect(readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  });

  it('gives no adoption for a changed helper beside an unchanged codex.exe, which is adopted on its own record', () => {
    const { exe, ctx } = setup();
    const a = closure(exe, PACKAGE);
    const b = closure(exe, PACKAGE.map((file) => (file.path === 'codex-path/rg.exe' ? { ...file, sha256: hex('f') } : file)));
    recordAdoption(input(a), ctx);
    expect(findAdoption('codex-cli', exe, b, ctx)).toEqual({ adopted: false, reason: 'none' });
    const foundA = findAdoption('codex-cli', exe, a, ctx);
    expect(foundA.adopted).toBe(true);
    // "Any change to one of its files asks again", naming the file.
    if (foundA.adopted) expect(changedFiles(foundA.record, b)).toEqual(['codex-path/rg.exe']);
    expect(recordAdoption(input(b), ctx)).toMatchObject({ ok: true });
    expect(findAdoption('codex-cli', exe, a, ctx).adopted).toBe(true);
    expect(findAdoption('codex-cli', exe, b, ctx).adopted).toBe(true);
  });

  it('refuses a closure whose listing or digest is not its own, and a check that did not pass', () => {
    const { exe, ctx } = setup();
    const c = closure(exe, PACKAGE);
    expect(recordAdoption(input({ ...c, digest: hex('9') }), ctx)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(recordAdoption({ ...input(c), probe: { ...input(c).probe, result: 'fail' as never } }, ctx)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(recordAdoption(input({ ...c, kind: 'single-file' }), ctx)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(findAdoption('codex-cli', exe, { ...c, digest: hex('9') }, ctx)).toMatchObject({ adopted: false, reason: 'not-this-closure' });
    expect(findAdoption('codex-cli', path.join(path.dirname(exe), 'other.exe'), c, ctx)).toMatchObject({ adopted: false, reason: 'not-this-closure' });
  });

  it('refuses a closure whose listing cannot be read back line by line (a tab or a line break in a file name)', () => {
    const { exe, ctx, storeRoot } = setup();
    for (const name of ['bin/a\tb.dll', 'bin/a\nb.dll']) {
      const c = closure(exe, [...PACKAGE, { path: name, size: 1, sha256: hex('5') }]);
      expect(recordAdoption(input(c), ctx)).toMatchObject({ ok: false, reason: 'invalid' });
      expect(existsSync(adoptionRecordPath(storeRoot, 'codex-cli', adoptionId('codex-cli', exe, c.digest)))).toBe(false);
    }
  });

  it('refuses a listing of more than 20,000 files', () => {
    const { exe, ctx } = setup();
    const many = Array.from({ length: ADOPTION_LISTING_MAX_LINES + 1 }, (_, index) => ({ path: `f/${index}.dat`, size: 1, sha256: hex('1') }));
    expect(recordAdoption(input(closure(exe, many)), ctx)).toMatchObject({ ok: false, reason: 'too-large' });
    const exact = many.slice(0, ADOPTION_LISTING_MAX_LINES);
    expect(recordAdoption(input(closure(exe, exact)), ctx)).toMatchObject({ ok: true });
    expect(findAdoption('codex-cli', exe, closure(exe, exact), ctx).adopted).toBe(true);
  });
});

describe('a damaged record is never evidence', () => {
  function recorded() {
    const s = setup();
    const c = closure(s.exe, PACKAGE);
    recordAdoption(input(c), s.ctx);
    const file = adoptionRecordPath(s.storeRoot, 'codex-cli', adoptionId('codex-cli', s.exe, c.digest));
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return { ...s, c, file, record };
  }
  const rewrite = (file: string, value: unknown) => {
    rmSync(file);
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  /** A record edited and then given a matching digest, as a forger with a copy of the code would. */
  const resealed = (record: Record<string, unknown>) => {
    const { recordDigest: _old, ...rest } = record;
    return { ...rest, recordDigest: recordDigest(rest) };
  };

  it.each([
    ['cut short', (record: any) => canonicalJson(record).slice(0, 40)],
    ['empty', () => ''],
    ['not an object', () => '[1]'],
    ['an edited version', (record: any) => ({ ...record, version: '0.170.0' })],
    ['an edited listing', (record: any) => ({ ...record, listing: record.listing.replace(hex('c'), hex('0')) })],
    ['an extra field', (record: any) => resealed({ ...record, trusted: true })],
    ['a check that did not pass', (record: any) => resealed({ ...record, probe: { ...record.probe, result: 'fail' } })],
    ['another schema version', (record: any) => resealed({ ...record, v: 2 })],
    ['another closure kind', (record: any) => resealed({ ...record, closureKind: 'single-file' })],
    ['a listing line that is not one', (record: any) => {
      const listing = `${record.listing}not a listing line\n`;
      return resealed({ ...record, listing, closureDigest: closureDigest(listing) });
    }],
  ])('%s', (_name, damage) => {
    const { exe, ctx, c, file, record } = recorded();
    rewrite(file, damage(record));
    expect(findAdoption('codex-cli', exe, c, ctx)).toMatchObject({ adopted: false, reason: 'damaged' });
  });

  it('is not accepted for a closure it does not describe, even when it is internally consistent', () => {
    const { exe, ctx, c, file, record } = recorded();
    // A consistent record of another closure, placed under this identity's name.
    const other = closure(exe, PACKAGE.map((entry) => (entry.path === 'codex-package.json' ? { ...entry, size: 121 } : entry)));
    rewrite(file, resealed({ ...record, listing: other.listing, closureDigest: other.digest }));
    expect(findAdoption('codex-cli', exe, c, ctx)).toMatchObject({ adopted: false, reason: 'damaged', detail: 'the record does not describe this program' });
  });
});

describe('a store an agent could write holds no evidence', () => {
  it.each([
    ['a write root above the store', (dir: string) => ({ writeRoots: [path.join(dir, 'Local')] })],
    ['a Folder Access grant above the store', (dir: string) => ({ folderAccessGrants: [dir] })],
    ['a write root inside the store', (dir: string) => ({ writeRoots: [path.join(dir, 'Local', 'UnodeAi', 'cli-store', 'adoptions')] })],
  ])('%s: nothing is found and nothing is recorded', (_name, reach) => {
    const { dir, exe, storeRoot, ctx } = setup();
    const c = closure(exe, PACKAGE);
    recordAdoption(input(c), ctx);
    const reachable = context(storeRoot, reach(dir));
    expect(findAdoption('codex-cli', exe, c, reachable)).toEqual({ adopted: false, reason: 'store-reachable' });
    const other = closure(exe, PACKAGE.slice(0, 2));
    expect(recordAdoption(input(other), reachable)).toMatchObject({ ok: false, reason: 'store-reachable' });
    expect(existsSync(adoptionRecordPath(storeRoot, 'codex-cli', adoptionId('codex-cli', exe, other.digest)))).toBe(false);
    // Unreachable again, the record is evidence again: nothing was changed.
    expect(findAdoption('codex-cli', exe, c, ctx).adopted).toBe(true);
  });

  it('a record folder that is a link holds no evidence and receives no record', () => {
    const { dir, exe, storeRoot, ctx } = setup();
    const elsewhere = path.join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(path.join(storeRoot, 'adoptions'), { recursive: true });
    symlinkSync(elsewhere, path.join(storeRoot, 'adoptions', 'codex-cli'), 'junction');
    const c = closure(exe, PACKAGE);
    expect(recordAdoption(input(c), ctx)).toMatchObject({ ok: false, reason: 'write-failed' });
    expect(readdirSync(elsewhere)).toEqual([]);
    // Even a valid record placed behind the link is not evidence.
    const valid = setup();
    recordAdoption(input(closure(exe, PACKAGE)), valid.ctx);
    const source = adoptionRecordPath(valid.storeRoot, 'codex-cli', adoptionId('codex-cli', exe, c.digest));
    writeFileSync(path.join(elsewhere, path.basename(source)), readFileSync(source));
    expect(findAdoption('codex-cli', exe, c, ctx)).toMatchObject({ adopted: false, reason: 'damaged' });
  });
});

describe('changed files and Forget adoptions', () => {
  it('names every file whose line differs: changed, added and gone', () => {
    const before = closure('/x/bin/codex.exe', PACKAGE);
    const after = closure('/x/bin/codex.exe', [
      { ...PACKAGE[0], sha256: hex('9') },
      PACKAGE[1],
      { path: 'bin/extra.dll', size: 5, sha256: hex('7') },
    ]);
    expect(changedFiles(before, after)).toEqual(['bin/codex.exe', 'bin/extra.dll', 'codex-path/rg.exe']);
    expect(changedFiles(before, before)).toEqual([]);
  });

  it('deletes one provider\'s records or both, and treats a missing folder as nothing to delete', () => {
    const { exe, storeRoot, ctx } = setup();
    expect(forgetAdoptions(ctx)).toBe(0);
    const codex = closure(exe, PACKAGE);
    recordAdoption(input(codex), ctx);
    const claudeExe = path.join(path.dirname(exe), 'claude.exe');
    const claude = { ...closure(claudeExe, [{ path: 'claude.exe', size: 10, sha256: hex('2') }], 'single-file'), executablePath: 'claude.exe' };
    recordAdoption({ ...input(claude), provider: 'claude-cli' }, ctx);
    writeFileSync(path.join(storeRoot, 'adoptions', 'codex-cli', 'notes.txt'), 'kept');
    expect(forgetAdoptions(ctx, 'codex-cli')).toBe(1);
    expect(findAdoption('codex-cli', exe, codex, ctx).adopted).toBe(false);
    expect(findAdoption('claude-cli', claudeExe, claude, ctx).adopted).toBe(true);
    expect(readdirSync(path.join(storeRoot, 'adoptions', 'codex-cli'))).toEqual(['notes.txt']);
    recordAdoption(input(codex), ctx);
    expect(forgetAdoptions(ctx)).toBe(2);
    expect(findAdoption('claude-cli', claudeExe, claude, ctx).adopted).toBe(false);
  });
});

describe('an External program inside the CLI store', () => {
  function store() {
    const dir = temp();
    const storeRoot = path.join(dir, 'Local', 'UnodeAi', 'cli-store');
    const id = 'a'.repeat(32);
    const place = (...segments: string[]) => {
      const file = path.join(storeRoot, ...segments);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'MZ');
      return file;
    };
    return { dir, storeRoot, id, place };
  }

  it('is refused wherever in the store it lies: an instance\'s versions, a verified key, work, instance trash', () => {
    const { storeRoot, id, place } = store();
    for (const file of [
      place('instances', id, 'versions', '0.164.0-win32-x64-0123456789abcdef', 'bin', 'codex.exe'),
      place('instances', id, 'versions', '0.165.0-win32-x64-fedcba9876543210', 'bin', 'codex.exe'),
      place('instances', id, 'staging', 'b'.repeat(32), 'payload', 'bin', 'codex.exe'),
      place('work', id, 'c'.repeat(32), 'cwd', 'codex.exe'),
      place('instance-trash', `${id}.${'d'.repeat(32)}`, 'versions', 'k', 'bin', 'codex.exe'),
      place('adoptions', 'codex.exe'),
    ]) {
      expect(externalPathInStore(file, storeRoot)).toBe(true);
    }
  });

  it('is refused when a link elsewhere leads into the store, and for a file not yet there below that link', () => {
    const { dir, storeRoot, id, place } = store();
    const inside = place('instances', id, 'versions', 'k', 'bin', 'codex.exe');
    const link = path.join(dir, 'tools');
    symlinkSync(path.join(storeRoot, 'instances', id, 'versions'), link, 'junction');
    expect(externalPathInStore(path.join(link, 'k', 'bin', 'codex.exe'), storeRoot)).toBe(true);
    expect(externalPathInStore(path.join(link, 'not-yet', 'bin', 'codex.exe'), storeRoot)).toBe(true);
    expect(existsSync(inside)).toBe(true);
  });

  it('compares without case on Windows, by whole segments, and admits a sibling folder', () => {
    const identity = (file: string) => file;
    const root = 'C:\\Users\\u\\AppData\\Local\\UnodeAi\\cli-store';
    expect(externalPathInStore('C:\\USERS\\U\\APPDATA\\LOCAL\\UNODEAI\\CLI-STORE\\work\\x\\codex.exe', root, { platform: 'win32', realpath: identity })).toBe(true);
    expect(externalPathInStore('c:\\users\\u\\appdata\\local\\unodeai\\cli-store-old\\codex.exe', root, { platform: 'win32', realpath: identity })).toBe(false);
    expect(externalPathInStore('C:\\Users\\u\\AppData\\Local\\UnodeAi\\cli-store', root, { platform: 'win32', realpath: identity })).toBe(true);
    expect(externalPathInStore('C:\\Program Files\\codex\\codex.exe', root, { platform: 'win32', realpath: identity })).toBe(false);
    // A physical path the file system reports with the device prefix is still the same place.
    expect(externalPathInStore('D:\\short\\codex.exe', root, { platform: 'win32', realpath: () => '\\\\?\\C:\\Users\\u\\AppData\\Local\\UnodeAi\\cli-store\\work\\codex.exe' })).toBe(true);
  });

  it('admits a program outside the store and in a sibling folder on this file system', () => {
    const { dir, storeRoot } = store();
    mkdirSync(storeRoot, { recursive: true });
    const sibling = path.join(dir, 'Local', 'UnodeAi', 'cli-store-old', 'codex.exe');
    mkdirSync(path.dirname(sibling), { recursive: true });
    writeFileSync(sibling, 'MZ');
    expect(externalPathInStore(sibling, storeRoot)).toBe(false);
    expect(externalPathInStore(path.join(dir, 'npm', 'codex.exe'), storeRoot)).toBe(false);
  });
});
