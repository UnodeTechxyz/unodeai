import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLI_CLOSURE_LIMITS,
  ClosureHasher,
  closureDigest,
  closureListing,
  computeCliClosure,
  resolveCliClosure,
  startClosureWorker,
  verifyManagedVersionFolder,
  type CliClosure,
  type CliClosureFs,
  type CliClosureStat,
} from '../cliClosure';
import { CLI_COMPATIBILITY_POLICY, CLI_REQUIRED_CANARIES, loadCliCompatibilityPolicy, qualifyCliClosure, type CliCompatibilityPolicy, type PolicyEntry, type PolicyLayout } from '../cliCompatibilityPolicy';

// The design these tests realise: the P6 effective specification, §3.1 (closure by route and the package-root rules:
// an `unbounded` closure is the executable alone), §3.2 (canonical listing and digest), §5.1-§5.3 (hash at every
// start with no cache; the managed folder check; the worker, request-fresh single-flight, the 60 s bound, no
// fallback) and §11 items 2 and 5.

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const temps: string[] = [];
const links: string[] = [];

afterEach(() => {
  // Links first, so that removing a tree never walks into what a link points at.
  for (const link of links.splice(0)) {
    try { unlinkSync(link); } catch { /* already gone */ }
  }
  for (const folder of temps.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function tempFolder(): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'unode-closure-'));
  temps.push(folder);
  return folder;
}

function writeTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

const PACKAGE_FILES = (entrypoint = 'bin/codex.exe'): Record<string, string> => ({
  'codex-package.json': JSON.stringify({ layoutVersion: 1, version: '0.163.0', entrypoint, resourcesDir: 'codex-resources', pathDir: 'codex-path' }),
  'bin/codex.exe': 'MZ codex main program',
  'bin/codex-code-mode-host.exe': 'MZ code mode host',
  'codex-path/rg.exe': 'MZ ripgrep',
  'codex-resources/voice/bin/vcruntime140.dll': 'MZ crt',
  'codex-resources/voice/manifest.json': '{"files":[]}',
});

/** A Codex package on disk, in the host's own file system. */
function packageOnDisk(files = PACKAGE_FILES()): { root: string; exe: string } {
  const root = path.join(tempFolder(), 'package');
  writeTree(root, files);
  return { root, exe: path.join(root, 'bin', 'codex.exe') };
}

/** The listing of a folder computed here, without the module under test. */
function independentListing(root: string): string {
  const lines: Array<{ key: string; line: string }> = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else {
        const bytes = readFileSync(path.join(root, child));
        lines.push({ key: child.toLowerCase(), line: `${child}\t${bytes.length}\t${sha(bytes)}\n` });
      }
    }
  };
  walk('');
  return lines.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((entry) => entry.line).join('');
}

function layoutOf(closure: CliClosure): PolicyLayout {
  const dirs = new Set<string>();
  for (const file of closure.files) {
    const segments = file.path.split('/');
    for (let depth = 1; depth < segments.length; depth++) dirs.add(segments.slice(0, depth).join('/'));
  }
  return {
    entrypoint: closure.executablePath,
    unpackedBytes: closure.files.reduce((total, file) => total + file.size, 0),
    dirs: [...dirs],
    ignoredEntries: [],
    files: closure.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256, pe: file.path.endsWith('.exe') || file.path.endsWith('.dll'), signer: file.path.endsWith('rg.exe') ? 'unsigned' as const : file.path.endsWith('.exe') || file.path.endsWith('.dll') ? 'openai' as const : 'none' as const })),
  };
}

function policyQualifying(layout: PolicyLayout) {
  const entry: PolicyEntry = {
    id: 'codex-cli/0.163.0/win32-x64/codex-package', provider: 'codex-cli', version: '0.163.0', versionOutput: 'codex-cli 0.163.0',
    os: 'win32', arch: 'x64', status: 'qualified',
    managed: {
      artifact: { kind: 'tar.gz', name: 'codex-package.tar.gz', size: 1000, sha256: sha('artifact'), urls: ['https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-package.tar.gz'], redirectHosts: ['release-assets.githubusercontent.com'] },
      layout,
    },
    gates: {}, canaries: CLI_REQUIRED_CANARIES['codex-cli'].map((id) => ({ id, result: 'pass' as const, evidenceRef: 'r', ranAt: 't', model: 'm' })),
    selfUpdateReview: { sourceRef: 'tag', finding: 'none' }, qualifiedAt: 'today', qualificationRecord: 'record', leafThumbprints: [],
  };
  const policy = { ...structuredClone(CLI_COMPATIBILITY_POLICY) as CliCompatibilityPolicy, entries: [entry] };
  const result = loadCliCompatibilityPolicy(policy);
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result.policy;
}

const WINDOWS_X64 = { os: 'win32', arch: 'x64' };

async function closureOf(exe: string, hasher = new ClosureHasher()): Promise<CliClosure> {
  const outcome = await computeCliClosure({ provider: 'codex-cli', executable: exe }, hasher);
  if (!outcome.ok) throw new Error(`refused: ${outcome.reason} ${outcome.message}`);
  return outcome.closure;
}

type FakeNode = { type: 'file'; content: Buffer } | { type: 'dir' } | { type: 'link' } | { type: 'other' };

/** A file system of exactly these entries, by exact path; every parent folder exists. */
function fakeFs(entries: Record<string, string | Buffer | 'dir' | 'link' | 'other' | { size: number; content?: string }>, platform: 'win32' | 'linux' = 'win32', order: 'listed' | 'reversed' = 'listed'): CliClosureFs {
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  const nodes = new Map<string, FakeNode & { size?: number }>();
  const children = new Map<string, string[]>();
  const add = (target: string, node: FakeNode & { size?: number }) => {
    if (nodes.has(target)) return;
    nodes.set(target, node);
    const parent = hostPath.dirname(target);
    if (parent !== target) {
      add(parent, { type: 'dir' });
      const siblings = children.get(parent) ?? [];
      siblings.push(hostPath.basename(target));
      children.set(parent, siblings);
    }
  };
  for (const [target, value] of Object.entries(entries)) {
    if (value === 'dir' || value === 'link' || value === 'other') add(target, { type: value });
    else if (typeof value === 'object' && !Buffer.isBuffer(value)) add(target, { type: 'file', content: Buffer.from(value.content ?? ''), size: value.size });
    else add(target, { type: 'file', content: Buffer.from(value) });
  }
  const missing = (target: string) => Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
  const stat = (node: FakeNode & { size?: number }): CliClosureStat => ({
    isFile: () => node.type === 'file',
    isDirectory: () => node.type === 'dir',
    isSymbolicLink: () => node.type === 'link',
    size: node.type === 'file' ? node.size ?? node.content.length : 0,
  });
  return {
    realpath: async (target) => { if (!nodes.has(target)) throw missing(target); return target; },
    lstat: async (target) => { const node = nodes.get(target); if (!node) throw missing(target); return stat(node); },
    readdir: async (folder) => {
      const names = [...(children.get(folder) ?? [])];
      return order === 'reversed' ? names.reverse() : names;
    },
    readFile: async (target, maxBytes) => { const node = nodes.get(target); if (!node || node.type !== 'file') throw missing(target); return node.content.subarray(0, maxBytes); },
  };
}

const WIN_ROOT = 'C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc';
const winPackage = (extra: Record<string, string | Buffer | 'dir' | 'link' | 'other' | { size: number; content?: string }> = {}, metadata?: string) => ({
  [`${WIN_ROOT}\\codex-package.json`]: metadata ?? JSON.stringify({ layoutVersion: 1, entrypoint: 'bin/codex.exe' }),
  [`${WIN_ROOT}\\bin\\codex.exe`]: 'MZ codex',
  [`${WIN_ROOT}\\codex-path\\rg.exe`]: 'MZ rg',
  ...extra,
});
const WIN_EXE = `${WIN_ROOT}\\bin\\codex.exe`;

async function planOf(entries: Parameters<typeof fakeFs>[0], executable = WIN_EXE, platform: 'win32' | 'linux' = 'win32', provider: 'codex-cli' | 'claude-cli' = 'codex-cli') {
  const resolution = await resolveCliClosure({ provider, executable }, { fs: fakeFs(entries, platform), platform });
  if (!resolution.ok) throw new Error(`no closure: ${resolution.reason}`);
  return resolution.plan;
}

/** An unbounded plan lists the program alone, by its file name. */
function expectProgramOnly(plan: Awaited<ReturnType<typeof planOf>>, reason: RegExp): void {
  expect(plan.kind).toBe('unbounded');
  expect(plan.files).toEqual([{ path: 'codex.exe', absolutePath: WIN_EXE, size: 8 }]);
  expect(plan.executablePath).toBe('codex.exe');
  expect(plan.unboundedReason).toMatch(reason);
}

describe('closure listing and digest (P6 §3.2)', () => {
  it('writes one path, size and SHA-256 line per file, sorted by the lower-case path in code-unit order', () => {
    const files = [
      { path: 'Zeta', size: 1, sha256: 'a'.repeat(64) },
      { path: 'Beta/x', size: 22, sha256: 'b'.repeat(64) },
      { path: 'alpha', size: 0, sha256: 'c'.repeat(64) },
      { path: 'beta.txt', size: 333, sha256: 'd'.repeat(64) },
    ];
    expect(closureListing(files)).toBe(
      `alpha\t0\t${'c'.repeat(64)}\nbeta.txt\t333\t${'d'.repeat(64)}\nBeta/x\t22\t${'b'.repeat(64)}\nZeta\t1\t${'a'.repeat(64)}\n`,
    );
  });

  it('digests the listing\'s UTF-8 bytes', () => {
    const listing = closureListing([{ path: 'voice/\u00fcber.txt', size: 5, sha256: 'e'.repeat(64) }]);
    expect(closureDigest(listing)).toBe(createHash('sha256').update(Buffer.from(listing, 'utf8')).digest('hex'));
    expect(closureDigest(listing)).not.toBe(createHash('sha256').update(Buffer.from(listing, 'latin1')).digest('hex'));
  });

  it('does not depend on the order the folders are listed in', async () => {
    const entries = winPackage({ [`${WIN_ROOT}\\codex-resources\\voice\\bin\\a.dll`]: 'MZ a', [`${WIN_ROOT}\\codex-resources\\b.json`]: '{}' });
    const fakeHash = (files: Array<{ path: string; size: number }>) => files.map((file) => ({ path: file.path, size: file.size, sha256: sha(file.path) }));
    const listed = await resolveCliClosure({ provider: 'codex-cli', executable: WIN_EXE }, { fs: fakeFs(entries, 'win32', 'listed'), platform: 'win32' });
    const reversed = await resolveCliClosure({ provider: 'codex-cli', executable: WIN_EXE }, { fs: fakeFs(entries, 'win32', 'reversed'), platform: 'win32' });
    if (!listed.ok || !reversed.ok) throw new Error('no closure');
    expect(listed.plan.files.map((file) => file.path)).not.toEqual(reversed.plan.files.map((file) => file.path));
    expect(closureListing(fakeHash(reversed.plan.files))).toBe(closureListing(fakeHash(listed.plan.files)));
  });
});

describe('closure resolution by route (P6 §3.1)', () => {
  it('lists every file of a Codex package layout, and of a root layout', async () => {
    const packaged = await planOf(winPackage({ [`${WIN_ROOT}\\codex-resources\\voice\\bin\\vcruntime140.dll`]: 'MZ crt' }));
    expect(packaged.kind).toBe('package');
    expect(packaged.root).toBe(WIN_ROOT);
    expect(packaged.executablePath).toBe('bin/codex.exe');
    expect(packaged.files.map((file) => file.path).sort()).toEqual(['bin/codex.exe', 'codex-package.json', 'codex-path/rg.exe', 'codex-resources/voice/bin/vcruntime140.dll']);

    const rootLayout = await planOf({
      'C:\\WinGet\\Codex\\codex-package.json': JSON.stringify({ layoutVersion: 1, entrypoint: 'codex.exe' }),
      'C:\\WinGet\\Codex\\codex.exe': 'MZ codex',
      'C:\\WinGet\\Codex\\codex-path\\rg.exe': 'MZ rg',
    }, 'C:\\WinGet\\Codex\\codex.exe');
    expect(rootLayout).toMatchObject({ kind: 'package', root: 'C:\\WinGet\\Codex', executablePath: 'codex.exe' });
    expect(rootLayout.files).toHaveLength(3);
  });

  it('compares the entrypoint without case on Windows only', async () => {
    const metadata = JSON.stringify({ layoutVersion: 1, entrypoint: 'BIN/Codex.EXE' });
    expect((await planOf(winPackage({}, metadata))).kind).toBe('package');
    const posixRoot = '/opt/codex';
    const posix = await planOf({
      [`${posixRoot}/codex-package.json`]: metadata,
      [`${posixRoot}/bin/codex.exe`]: 'MZ codex',
    }, `${posixRoot}/bin/codex.exe`, 'linux');
    expect(posix.kind).toBe('unbounded');
    expect(posix.files).toEqual([{ path: 'codex.exe', absolutePath: `${posixRoot}/bin/codex.exe`, size: 8 }]);
  });

  it('is unbounded, the program alone, for a bare program', async () => {
    expectProgramOnly(await planOf({ [WIN_EXE]: 'MZ codex', [`${WIN_ROOT}\\codex-path\\rg.exe`]: 'MZ rg' }), /no codex-package\.json/);
  });

  it('is unbounded, the program alone, for a link anywhere under the root', async () => {
    expectProgramOnly(await planOf(winPackage({ [`${WIN_ROOT}\\codex-resources\\voice\\linked`]: 'link' })), /link or junction/);
  });

  it('is unbounded, the program alone, for an entry that is neither a file nor a folder', async () => {
    expectProgramOnly(await planOf(winPackage({ [`${WIN_ROOT}\\codex-path\\pipe`]: 'other' })), /neither a file nor a folder/);
  });

  it('is unbounded, the program alone, for two paths equal without case on Windows, and a package elsewhere', async () => {
    const collision = { [`${WIN_ROOT}\\codex-path\\RG.exe`]: 'MZ other rg' };
    expectProgramOnly(await planOf(winPackage(collision)), /equals another path without case/);
    const posixRoot = '/opt/codex';
    const posix = await planOf({
      [`${posixRoot}/codex-package.json`]: JSON.stringify({ layoutVersion: 1, entrypoint: 'bin/codex.exe' }),
      [`${posixRoot}/bin/codex.exe`]: 'MZ codex',
      [`${posixRoot}/codex-path/rg.exe`]: 'MZ rg',
      [`${posixRoot}/codex-path/RG.exe`]: 'MZ other rg',
    }, `${posixRoot}/bin/codex.exe`, 'linux');
    expect(posix.kind).toBe('package');
    expect(posix.files).toHaveLength(4);
  });

  it('allows exactly 20,000 entries and is unbounded, the program alone, at 20,001', async () => {
    const withFiles = (count: number) => {
      const extra: Record<string, string> = {};
      for (let index = 0; index < count; index++) extra[`${WIN_ROOT}\\many\\f${index}`] = '';
      return extra;
    };
    // codex-package.json, bin, bin/codex.exe, codex-path, codex-path/rg.exe and many: six entries before the files.
    expect((await planOf(winPackage(withFiles(19_994)))).kind).toBe('package');
    expectProgramOnly(await planOf(winPackage(withFiles(19_995))), /more than 20,000 entries/);
    expect(CLI_CLOSURE_LIMITS.maxEntries).toBe(20_000);
  });

  it('allows exactly 1 GiB and is unbounded, the program alone, above it', async () => {
    const metadata = JSON.stringify({ layoutVersion: 1, entrypoint: 'bin/codex.exe' });
    const fill = (bytes: number) => winPackage({ [`${WIN_ROOT}\\codex-resources\\big.bin`]: { size: bytes } }, metadata);
    const used = Buffer.byteLength(metadata) + 'MZ codex'.length + 'MZ rg'.length;
    expect((await planOf(fill(1024 ** 3 - used))).kind).toBe('package');
    expectProgramOnly(await planOf(fill(1024 ** 3 - used + 1)), /more than 1 GiB/);
    expect(CLI_CLOSURE_LIMITS.maxBytes).toBe(1024 ** 3);
  });

  it('is unbounded, the program alone, for a missing, oversized, unparsable or inconsistent codex-package.json', async () => {
    const withoutMetadata: Parameters<typeof fakeFs>[0] = winPackage();
    delete withoutMetadata[`${WIN_ROOT}\\codex-package.json`];
    expectProgramOnly(await planOf(withoutMetadata), /no codex-package\.json/);
    const padded = (length: number) => {
      const base = JSON.stringify({ layoutVersion: 1, entrypoint: 'bin/codex.exe' });
      return base.slice(0, -1) + ' '.repeat(length - base.length) + '}';
    };
    expect(padded(4096)).toHaveLength(4096);
    expect((await planOf(winPackage({}, padded(4096)))).kind).toBe('package');
    expectProgramOnly(await planOf(winPackage({}, padded(4097))), /larger than 4 KiB/);
    expectProgramOnly(await planOf(winPackage({}, '{"layoutVersion": 1, "entrypoint": ')), /does not parse/);
    expectProgramOnly(await planOf(winPackage({}, `\ufeff${JSON.stringify({ layoutVersion: 1, entrypoint: 'bin/codex.exe' })}`)), /does not parse/);
    for (const inconsistent of [
      { layoutVersion: 2, entrypoint: 'bin/codex.exe' },
      { layoutVersion: '1', entrypoint: 'bin/codex.exe' },
      { entrypoint: 'bin/codex.exe' },
      { layoutVersion: 1, entrypoint: 'bin/codex-code-mode-host.exe' },
      { layoutVersion: 1, entrypoint: 'bin\\codex.exe' },
      { layoutVersion: 1 },
      [1],
    ]) {
      expectProgramOnly(await planOf(winPackage({}, JSON.stringify(inconsistent))), /does not describe this program/);
    }
    expectProgramOnly(await planOf(winPackage({ [`${WIN_ROOT}\\codex-package.json`]: 'link' })), /is a link/);
  });

  it('does not read a codex-package.json the file system reports as larger than 4 KiB', async () => {
    const metadata = `${WIN_ROOT}\\codex-package.json`;
    const valid = JSON.stringify({ layoutVersion: 1, entrypoint: 'bin/codex.exe' });
    const fs = fakeFs(winPackage({ [metadata]: { size: 10 * 1024 ** 3, content: valid } }));
    const reads: string[] = [];
    const watched: CliClosureFs = { ...fs, readFile: (file, maxBytes) => { reads.push(file); return fs.readFile(file, maxBytes); } };
    const resolution = await resolveCliClosure({ provider: 'codex-cli', executable: WIN_EXE }, { fs: watched, platform: 'win32' });
    if (!resolution.ok) throw new Error('no closure');
    expectProgramOnly(resolution.plan, /larger than 4 KiB/);
    expect(reads).toEqual([]);
  });

  it('reads at most one byte past 4 KiB of a codex-package.json that grew after its size was read', async () => {
    const metadata = `${WIN_ROOT}\\codex-package.json`;
    const grown = JSON.stringify({ layoutVersion: 1, entrypoint: 'bin/codex.exe', notes: 'x'.repeat(8000) });
    const fs = fakeFs(winPackage({ [metadata]: { size: 64, content: grown } }));
    const asked: number[] = [];
    const watched: CliClosureFs = { ...fs, readFile: (file, maxBytes) => { asked.push(maxBytes); return fs.readFile(file, maxBytes); } };
    const resolution = await resolveCliClosure({ provider: 'codex-cli', executable: WIN_EXE }, { fs: watched, platform: 'win32' });
    if (!resolution.ok) throw new Error('no closure');
    expectProgramOnly(resolution.plan, /larger than 4 KiB/);
    expect(asked).toEqual([4097]);
  });

  it('the bounded read stops at its limit on a real file', async () => {
    const folder = tempFolder();
    const root = path.join(folder, 'package');
    writeTree(root, {
      'codex-package.json': JSON.stringify({ layoutVersion: 1, entrypoint: 'bin/codex.exe', notes: 'x'.repeat(5000) }),
      'bin/codex.exe': 'MZ codex',
    });
    const plan = await resolveCliClosure({ provider: 'codex-cli', executable: path.join(root, 'bin', 'codex.exe') });
    expect(plan).toMatchObject({ ok: true, plan: { kind: 'unbounded', unboundedReason: 'codex-package.json is larger than 4 KiB' } });
  });

  it('is unbounded for a Codex program that is not a .exe on Windows', async () => {
    const cmd = `${WIN_ROOT}\\bin\\codex.cmd`;
    const plan = await planOf(winPackage({ [cmd]: '@echo off' }), cmd);
    expect(plan).toMatchObject({ kind: 'unbounded', files: [{ path: 'codex.cmd', absolutePath: cmd, size: 9 }] });
  });

  it('binds the physical program: a launch through a link is resolved first', async () => {
    const fs = fakeFs(winPackage());
    const resolution = await resolveCliClosure({ provider: 'codex-cli', executable: 'C:\\Links\\codex.exe' }, {
      fs: { ...fs, realpath: async (target) => (target === 'C:\\Links\\codex.exe' ? WIN_EXE : fs.realpath(target)) },
      platform: 'win32',
    });
    expect(resolution).toMatchObject({ ok: true, plan: { kind: 'package', executable: WIN_EXE, root: WIN_ROOT } });
  });

  it('refuses a relative or unreadable program path', async () => {
    expect(await resolveCliClosure({ provider: 'codex-cli', executable: 'codex.exe' }, { fs: fakeFs({}), platform: 'win32' })).toMatchObject({ ok: false, reason: 'not-absolute' });
    expect(await resolveCliClosure({ provider: 'codex-cli', executable: 'C:\\missing\\codex.exe' }, { fs: fakeFs({}), platform: 'win32' })).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it('lists a Claude program as a single file', async () => {
    const native = 'C:\\Users\\Ada\\.local\\bin\\claude.exe';
    const plan = await planOf({ [native]: 'MZ claude' }, native, 'win32', 'claude-cli');
    expect(plan).toEqual({ provider: 'claude-cli', kind: 'single-file', executable: native, files: [{ path: 'claude.exe', absolutePath: native, size: 9 }], executablePath: 'claude.exe' });
    const posix = await planOf({ '/home/ada/.local/bin/claude': 'ELF claude' }, '/home/ada/.local/bin/claude', 'linux', 'claude-cli');
    expect(posix).toMatchObject({ kind: 'single-file', files: [{ path: 'claude', size: 10 }] });
  });

  it('lists npm\'s Claude launcher with the program it starts, and refuses a launcher without it', async () => {
    const npm = 'C:\\Users\\Ada\\AppData\\Roaming\\npm';
    const launcher = `${npm}\\claude.cmd`;
    const program = `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
    const plan = await planOf({ [launcher]: '@echo off', [program]: 'MZ claude' }, launcher, 'win32', 'claude-cli');
    expect(plan).toMatchObject({ kind: 'launcher-pair', executable: launcher, executablePath: 'claude.cmd' });
    const listing = closureListing(plan.files.map((file) => ({ path: file.path, size: file.size, sha256: sha(file.path) })));
    expect(listing).toBe(`claude.cmd\t9\t${sha('claude.cmd')}\nnode_modules/@anthropic-ai/claude-code/bin/claude.exe\t9\t${sha('node_modules/@anthropic-ai/claude-code/bin/claude.exe')}\n`);

    const alone = await resolveCliClosure({ provider: 'claude-cli', executable: launcher }, { fs: fakeFs({ [launcher]: '@echo off' }), platform: 'win32' });
    expect(alone).toMatchObject({ ok: false, reason: 'launcher-program-missing' });
    const folderInstead = await resolveCliClosure({ provider: 'claude-cli', executable: launcher }, { fs: fakeFs({ [launcher]: '@echo off', [program]: 'dir' }), platform: 'win32' });
    expect(folderInstead).toMatchObject({ ok: false, reason: 'launcher-program-missing' });
    const other = await resolveCliClosure({ provider: 'claude-cli', executable: `${npm}\\claude.ps1` }, { fs: fakeFs({ [`${npm}\\claude.ps1`]: 'x' }), platform: 'win32' });
    expect(other).toMatchObject({ ok: false, reason: 'unsupported-program' });
  });
});

describe('closures on disk, hashed by the real worker (P6 §3.1, §3.2, §5.1, §5.3)', () => {
  it('has the worker compiled beside the module, as the content workers are', () => {
    expect(() => startClosureWorker().terminate()).not.toThrow();
  });

  it('is built as its own esbuild entry point, like the PDF worker', () => {
    const config = readFileSync(path.join(__dirname, '..', '..', '..', 'esbuild.config.mjs'), 'utf8');
    expect(config).toContain("'backend/cliClosureWorker': 'src/backend/cliClosureWorker.ts',");
  });

  it('hashes a package layout to the digest of its independently computed listing', async () => {
    const { root, exe } = packageOnDisk();
    // The physical folder: on macOS the temp folder lies under /var, a link to /private/var.
    const closure = await closureOf(exe);
    expect(closure).toMatchObject({ kind: 'package', root: realpathSync.native(root), executablePath: 'bin/codex.exe' });
    expect(closure.files).toHaveLength(6);
    expect(closure.listing).toBe(independentListing(root));
    expect(closure.digest).toBe(sha(Buffer.from(independentListing(root), 'utf8')));
  });

  it('hashes a root layout', async () => {
    const root = path.join(tempFolder(), 'winget');
    writeTree(root, { 'codex-package.json': JSON.stringify({ layoutVersion: 1, entrypoint: 'codex.exe' }), 'codex.exe': 'MZ codex', 'codex-path/rg.exe': 'MZ rg' });
    const closure = await closureOf(path.join(root, 'codex.exe'));
    expect(closure).toMatchObject({ kind: 'package', executablePath: 'codex.exe' });
    expect(closure.listing).toBe(independentListing(root));
  });

  it('lists the program alone, hashed, when a folder link sits under the root (a junction on Windows)', async () => {
    const { root, exe } = packageOnDisk();
    const outside = path.join(tempFolder(), 'outside');
    writeTree(outside, { 'planted.dll': 'MZ planted' });
    const link = path.join(root, 'codex-resources', 'linked');
    symlinkSync(outside, link, 'junction');
    links.push(link);
    const closure = await closureOf(exe);
    expect(closure.kind).toBe('unbounded');
    expect(closure.listing).toBe(`codex.exe\t${'MZ codex main program'.length}\t${sha('MZ codex main program')}\n`);
    expect(closure.files).toEqual([{ path: 'codex.exe', size: 21, sha256: sha('MZ codex main program') }]);
  });

  it('qualifies the npm vendor folder and the standalone package against one table, and nothing changed', async () => {
    const npmVendor = path.join(tempFolder(), 'node_modules', '@openai', 'codex', 'vendor', 'x86_64-pc-windows-msvc');
    const standalone = path.join(tempFolder(), '.codex', 'packages', 'standalone', 'releases', '0.163.0');
    writeTree(npmVendor, PACKAGE_FILES());
    writeTree(standalone, PACKAGE_FILES());
    const first = await closureOf(path.join(npmVendor, 'bin', 'codex.exe'));
    const second = await closureOf(path.join(standalone, 'bin', 'codex.exe'));
    expect(second.digest).toBe(first.digest);
    const policy = policyQualifying(layoutOf(first));
    expect(qualifyCliClosure(policy, first, WINDOWS_X64).verdict).toBe('qualified');
    expect(qualifyCliClosure(policy, second, WINDOWS_X64).verdict).toBe('qualified');

    writeTree(standalone, { 'bin/version.dll': 'MZ planted beside codex.exe' });
    expect(qualifyCliClosure(policy, await closureOf(path.join(standalone, 'bin', 'codex.exe')), WINDOWS_X64).verdict).toBe('needs-adoption');
    rmSync(path.join(standalone, 'bin', 'version.dll'));
    rmSync(path.join(standalone, 'codex-path', 'rg.exe'));
    expect(qualifyCliClosure(policy, await closureOf(path.join(standalone, 'bin', 'codex.exe')), WINDOWS_X64).verdict).toBe('needs-adoption');
    writeTree(standalone, { 'codex-path/rg.exe': 'MZ ripgrep plus' });
    expect(qualifyCliClosure(policy, await closureOf(path.join(standalone, 'bin', 'codex.exe')), WINDOWS_X64).verdict).toBe('needs-adoption');
  });

  it('catches a one-byte change with the size and modification time restored, at the next start', async () => {
    const { root, exe } = packageOnDisk();
    const helper = path.join(root, 'codex-path', 'rg.exe');
    // A whole-second time, so that restoring it is exact on every file system.
    utimesSync(helper, 1_700_000_000, 1_700_000_000);
    const stamp = statSync(helper);
    const hasher = new ClosureHasher();
    const before = await closureOf(exe, hasher);
    const policy = policyQualifying(layoutOf(before));
    expect(qualifyCliClosure(policy, before, WINDOWS_X64).verdict).toBe('qualified');

    const bytes = readFileSync(helper);
    bytes[bytes.length - 1] ^= 0x01;
    writeFileSync(helper, bytes);
    utimesSync(helper, 1_700_000_000, 1_700_000_000);
    const restamped = statSync(helper);
    expect([restamped.size, restamped.mtimeMs]).toEqual([stamp.size, stamp.mtimeMs]);

    const after = await closureOf(exe, hasher);
    expect(after.digest).not.toBe(before.digest);
    expect(qualifyCliClosure(policy, after, WINDOWS_X64)).toEqual({ verdict: 'needs-adoption', hostHasEntries: true });
  });
});

/** A worker that hashes the files when asked, then waits for `{ go: true }` from the test before it answers. */
const HELD_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
let answer;
parentPort.on('message', (message) => {
  if (message && message.go) { parentPort.postMessage(answer); return; }
  answer = { ok: true, files: message.files.map((file) => {
    const bytes = readFileSync(file);
    return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }) };
  Atomics.store(workerData.hashed, 0, 1);
});`;

/** Held workers, each with a flag it sets once it has read every file of its run. */
function heldWorkers() {
  const started: Array<{ worker: Worker; hashed: () => boolean }> = [];
  const startWorker = () => {
    const hashed = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(HELD_WORKER, { eval: true, workerData: { hashed } });
    started.push({ worker, hashed: () => Atomics.load(hashed, 0) === 1 });
    return worker;
  };
  return { started, startWorker };
}

/** A worker that reports a failure while carrying correct hashes of every file. */
const FAILURE_WITH_HASHES_WORKER = `
const { parentPort } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
parentPort.once('message', (message) => {
  const files = message.files.map((file) => {
    const bytes = readFileSync(file);
    return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  parentPort.postMessage({ ok: false, error: 'EBUSY: resource busy or locked', files });
});`;

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('the hash runs (P6 §5.1, §5.3)', () => {
  it('starts one hash run per start: no answer is kept between starts', async () => {
    const { exe } = packageOnDisk();
    let runs = 0;
    const hasher = new ClosureHasher({ startWorker: () => { runs += 1; return startClosureWorker(); } });
    const digests: string[] = [];
    for (let start = 0; start < 5; start++) digests.push((await closureOf(exe, hasher)).digest);
    expect(runs).toBe(5);
    expect(new Set(digests).size).toBe(1);
  });

  it('never lets a request share a run that began before it; requests made before a run begins share it', async () => {
    const { root, exe } = packageOnDisk();
    const { started, startWorker } = heldWorkers();
    const hasher = new ClosureHasher({ startWorker });
    const request = () => computeCliClosure({ provider: 'codex-cli', executable: exe }, hasher);

    const first = request();
    await until(() => started.length === 1 && started[0].hashed(), 'the first run to read the files');
    // Change a file, then ask twice: neither request may get the first run's answer.
    const helper = path.join(root, 'codex-path', 'rg.exe');
    writeFileSync(helper, 'MZ ripgrep, replaced');
    const second = request();
    const third = request();
    started[0].worker.postMessage({ go: true });
    const firstOutcome = await first;
    await until(() => started.length === 2 && started[1].hashed(), 'the second run to read the files');
    started[1].worker.postMessage({ go: true });
    const [secondOutcome, thirdOutcome] = await Promise.all([second, third]);

    if (!firstOutcome.ok || !secondOutcome.ok || !thirdOutcome.ok) throw new Error('a run was refused');
    expect(started).toHaveLength(2);
    // The requests that shared a run share its answer, which none of them can change.
    expect(thirdOutcome.closure).toBe(secondOutcome.closure);
    expect(Object.isFrozen(secondOutcome.closure) && Object.isFrozen(secondOutcome.closure.files) && Object.isFrozen(secondOutcome.closure.files[0])).toBe(true);
    expect(secondOutcome.closure.digest).not.toBe(firstOutcome.closure.digest);
    expect(secondOutcome.closure.digest).toBe(thirdOutcome.closure.digest);
    expect(secondOutcome.closure.listing).toBe(independentListing(root));
  });

  it('runs one hash at a time per provider, and providers independently', async () => {
    const codex = packageOnDisk();
    const claudeFolder = tempFolder();
    writeTree(claudeFolder, { 'claude.exe': 'MZ claude' });
    const done: string[] = [];
    const { started, startWorker } = heldWorkers();
    const hasher = new ClosureHasher({ startWorker });
    const firstCodex = computeCliClosure({ provider: 'codex-cli', executable: codex.exe }, hasher).then((outcome) => { done.push('codex 1'); return outcome; });
    await until(() => started.length === 1 && started[0].hashed(), 'the first Codex run');
    const secondCodex = computeCliClosure({ provider: 'codex-cli', executable: path.join(codex.root, 'bin', 'codex-code-mode-host.exe') }, hasher)
      .then((outcome) => { done.push('codex 2'); return outcome; });
    const claude = computeCliClosure({ provider: 'claude-cli', executable: path.join(claudeFolder, 'claude.exe') }, hasher);
    await until(() => started.length === 2 && started[1].hashed(), 'the Claude run, beside the running Codex run');
    // The Claude run has begun and finished reading while the first Codex run is still held: the second Codex run
    // has not begun, because a provider's runs never overlap.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started, 'the second Codex run waits for the first').toHaveLength(2);
    started[1].worker.postMessage({ go: true });
    expect((await claude).ok).toBe(true);
    expect(started).toHaveLength(2);
    started[0].worker.postMessage({ go: true });
    await firstCodex;
    await until(() => started.length === 3 && started[2].hashed(), 'the second Codex run');
    started[2].worker.postMessage({ go: true });
    expect((await secondCodex).ok).toBe(true);
    expect(done).toEqual(['codex 1', 'codex 2']);
  });

  it('refuses when the worker fails, with no fallback and no answer kept', async () => {
    const { exe } = packageOnDisk();
    let starts = 0;
    const hasher = new ClosureHasher({
      startWorker: () => { starts += 1; return starts === 1 ? new Worker('throw new Error("hashing worker crashed")', { eval: true }) : startClosureWorker(); },
    });
    const refused = await computeCliClosure({ provider: 'codex-cli', executable: exe }, hasher);
    expect(refused).toMatchObject({ ok: false, reason: 'hash-failed', message: expect.stringMatching(/hashing worker crashed/) });
    const next = await computeCliClosure({ provider: 'codex-cli', executable: exe }, hasher);
    expect(next.ok).toBe(true);
    expect(starts).toBe(2);
  });

  it('refuses when the worker exits without answering', async () => {
    const { exe } = packageOnDisk();
    const hasher = new ClosureHasher({ timeoutMs: 4_000, startWorker: () => new Worker('process.exit(3)', { eval: true }) });
    expect(await computeCliClosure({ provider: 'codex-cli', executable: exe }, hasher))
      .toMatchObject({ ok: false, reason: 'hash-failed', message: expect.stringMatching(/exited before answering \(code 3\)/) });
  });

  it('refuses a worker that reports a failure, even with every hash in its answer', async () => {
    const { exe } = packageOnDisk();
    const hasher = new ClosureHasher({ startWorker: () => new Worker(FAILURE_WITH_HASHES_WORKER, { eval: true }) });
    expect(await computeCliClosure({ provider: 'codex-cli', executable: exe }, hasher))
      .toMatchObject({ ok: false, reason: 'hash-failed', message: expect.stringMatching(/EBUSY/) });
  });

  it('refuses an answer that does not hash every file', async () => {
    const { exe } = packageOnDisk();
    const short = `require('node:worker_threads').parentPort.once('message', () => require('node:worker_threads').parentPort.postMessage({ ok: true, files: [] }));`;
    const hasher = new ClosureHasher({ startWorker: () => new Worker(short, { eval: true }) });
    expect(await computeCliClosure({ provider: 'codex-cli', executable: exe }, hasher))
      .toEqual({ ok: false, reason: 'hash-failed', message: 'The CLI hashing worker returned an unreadable answer.' });
  });

  it('refuses a run past the time limit and stops its worker', async () => {
    const { exe } = packageOnDisk();
    let worker: Worker | undefined;
    let exited = false;
    const hasher = new ClosureHasher({
      timeoutMs: 300,
      startWorker: () => {
        worker = new Worker('setInterval(() => undefined, 1000)', { eval: true });
        worker.once('exit', () => { exited = true; });
        return worker;
      },
    });
    const started = Date.now();
    expect(await computeCliClosure({ provider: 'codex-cli', executable: exe }, hasher))
      .toMatchObject({ ok: false, reason: 'hash-timeout' });
    expect(Date.now() - started).toBeLessThan(3_000);
    await until(() => exited, 'the timed-out worker to stop');
    expect(CLI_CLOSURE_LIMITS.hashTimeoutMs).toBe(60_000);
  });

  it('refuses a run that hangs while it lists the files, at the time limit', async () => {
    const fs = fakeFs(winPackage());
    const stuck: CliClosureFs = { ...fs, readdir: () => new Promise<string[]>(() => undefined) };
    let workers = 0;
    const hasher = new ClosureHasher({ timeoutMs: 200, startWorker: () => { workers += 1; return startClosureWorker(); } });
    expect(await computeCliClosure({ provider: 'codex-cli', executable: WIN_EXE }, hasher, { fs: stuck, platform: 'win32' }))
      .toMatchObject({ ok: false, reason: 'hash-timeout' });
    expect(workers).toBe(0);
  });

  it('refuses a file that changed between listing and hashing', async () => {
    const { root, exe } = packageOnDisk();
    const hasher = new ClosureHasher();
    // The real worker reads when the run asks it to; grow a file after the listing and before that read.
    const growing = {
      run: (provider, key, job) => hasher.run(provider, key, (hashFiles, signal) => job((files) => {
        writeFileSync(path.join(root, 'codex-path', 'rg.exe'), 'MZ ripgrep, now longer');
        return hashFiles(files);
      }, signal)),
    } as Pick<ClosureHasher, 'run'> as ClosureHasher;
    expect(await computeCliClosure({ provider: 'codex-cli', executable: exe }, growing))
      .toMatchObject({ ok: false, reason: 'changed-during-check', message: expect.stringMatching(/codex-path\/rg\.exe changed/) });
  });

  it('the real worker refuses a path that is not a regular file', async () => {
    const folder = tempFolder();
    const worker = startClosureWorker();
    const reply = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      worker.once('message', resolve);
      worker.postMessage({ files: [folder], maxBytes: 1024 });
    });
    await worker.terminate();
    expect(reply).toMatchObject({ ok: false, error: expect.stringMatching(/not a regular file/) });
  });

  it('the real worker stops at its byte limit', async () => {
    const folder = tempFolder();
    writeTree(folder, { 'a.bin': Buffer.alloc(600), 'b.bin': Buffer.alloc(600) });
    const worker = startClosureWorker();
    const reply = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      worker.once('message', resolve);
      worker.postMessage({ files: [path.join(folder, 'a.bin'), path.join(folder, 'b.bin')], maxBytes: 1000 });
    });
    await worker.terminate();
    expect(reply).toMatchObject({ ok: false, error: expect.stringMatching(/larger than UnodeAi checks/) });
  });
});

describe('the managed version folder check (P6 §5.2)', () => {
  async function checkedFolder() {
    const { root, exe } = packageOnDisk();
    const layout = layoutOf(await closureOf(exe));
    return { root, layout };
  }

  it('accepts a folder that holds exactly the layout, hashing it at every check', async () => {
    const { root, layout } = await checkedFolder();
    let runs = 0;
    const hasher = new ClosureHasher({ startWorker: () => { runs += 1; return startClosureWorker(); } });
    for (let check = 0; check < 3; check++) {
      const result = await verifyManagedVersionFolder(root, layout, hasher);
      expect(result).toMatchObject({ ok: true, closure: { kind: 'package', executablePath: 'bin/codex.exe' } });
    }
    expect(runs).toBe(3);
  });

  it('refuses an extra DLL beside the program, naming it', async () => {
    const { root, layout } = await checkedFolder();
    writeTree(root, { 'bin/version.dll': 'MZ planted' });
    expect(await verifyManagedVersionFolder(root, layout, new ClosureHasher())).toMatchObject({ ok: false, reason: 'extra-file', file: 'bin/version.dll' });
  });

  it('refuses a missing file, naming it', async () => {
    const { root, layout } = await checkedFolder();
    rmSync(path.join(root, 'codex-path', 'rg.exe'));
    expect(await verifyManagedVersionFolder(root, layout, new ClosureHasher())).toMatchObject({ ok: false, reason: 'missing-file', file: 'codex-path/rg.exe' });
  });

  it('refuses a changed or resized file, naming it', async () => {
    const { root, layout } = await checkedFolder();
    const helper = path.join(root, 'codex-path', 'rg.exe');
    const bytes = readFileSync(helper);
    bytes[0] ^= 0x01;
    writeFileSync(helper, bytes);
    expect(await verifyManagedVersionFolder(root, layout, new ClosureHasher())).toMatchObject({ ok: false, reason: 'changed-file', file: 'codex-path/rg.exe' });
    writeFileSync(helper, Buffer.concat([bytes, Buffer.from('x')]));
    expect(await verifyManagedVersionFolder(root, layout, new ClosureHasher())).toMatchObject({ ok: false, reason: 'changed-file', file: 'codex-path/rg.exe' });
  });

  it('refuses a link under the folder (a junction on Windows), naming it, and a folder that is itself a link', async () => {
    const { root, layout } = await checkedFolder();
    const outside = path.join(tempFolder(), 'outside');
    writeTree(outside, { 'x.dll': 'MZ x' });
    const link = path.join(root, 'codex-resources', 'linked');
    symlinkSync(outside, link, 'junction');
    links.push(link);
    expect(await verifyManagedVersionFolder(root, layout, new ClosureHasher())).toMatchObject({ ok: false, reason: 'reparse-point', file: 'codex-resources/linked' });
    unlinkSync(link);

    const alias = path.join(tempFolder(), 'alias');
    symlinkSync(root, alias, 'junction');
    links.push(alias);
    expect(await verifyManagedVersionFolder(alias, layout, new ClosureHasher())).toMatchObject({ ok: false, reason: 'reparse-point', file: '.' });
  });

  it('compares the file set without case on Windows only', async () => {
    const layout: Pick<PolicyLayout, 'entrypoint' | 'files'> = {
      entrypoint: 'bin/codex.exe',
      files: [{ path: 'bin/codex.exe', size: 8, sha256: sha('MZ codex'), pe: true, signer: 'openai' }],
    };
    const fs = fakeFs({ 'C:\\store\\v\\BIN\\Codex.exe': 'MZ codex' });
    const hasher = { run: (_provider: string, _key: string, job: (hash: (files: readonly string[]) => Promise<Array<{ size: number; sha256: string }>>, signal: AbortSignal) => Promise<unknown>) => job(async () => [{ size: 8, sha256: sha('MZ codex') }], new AbortController().signal) } as unknown as ClosureHasher;
    expect(await verifyManagedVersionFolder('C:\\store\\v', layout, hasher, { fs, platform: 'win32' })).toMatchObject({ ok: true, closure: { executablePath: 'BIN/Codex.exe' } });
    const posix = fakeFs({ '/store/v/BIN/Codex.exe': 'MZ codex' }, 'linux');
    expect(await verifyManagedVersionFolder('/store/v', layout, hasher, { fs: posix, platform: 'linux' })).toMatchObject({ ok: false, reason: 'extra-file', file: 'BIN/Codex.exe' });
  });

  it('refuses when the hash run fails', async () => {
    const { root, layout } = await checkedFolder();
    const hasher = new ClosureHasher({ startWorker: () => new Worker('process.exit(1)', { eval: true }) });
    expect(await verifyManagedVersionFolder(root, layout, hasher)).toMatchObject({ ok: false, reason: 'hash-failed' });
  });
});
