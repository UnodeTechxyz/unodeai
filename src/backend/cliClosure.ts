/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the runtime closure of a CLI launch (v0.9.97)
 *  The set of files whose bytes UnodeAi binds to one start of Claude or Codex CLI, and the digest of their listing.
 *  Resolving a closure reads the file system only: it never starts the program. The files are hashed again at every
 *  start, in a worker thread, and nothing is kept between starts: there is no answer cached by path, stamp or
 *  modification time, and no fallback when the hash cannot be taken.
 *
 *  A Codex package is every regular file under the folder its `codex-package.json` describes. When that folder
 *  breaks a rule (a link anywhere below it, too many files or bytes, two names equal without case on Windows, or a
 *  missing, oversized, unreadable or inconsistent `codex-package.json`), the closure is `unbounded`: the program file
 *  alone, never a part of the folder.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { CliClosureFile, CliClosureKind, PolicyLayout, QualifiableCliClosure } from './cliCompatibilityPolicy';
import type { CliRuntimeProvider } from './cliRuntime';

export const CLI_CLOSURE_LIMITS = Object.freeze({
  /** Files and folders under a package root; one more makes the closure `unbounded`. */
  maxEntries: 20_000,
  /** Bytes of all files under a package root; one more makes the closure `unbounded`. */
  maxBytes: 1024 * 1024 * 1024,
  /** `codex-package.json` is read only up to this size; a larger one makes the closure `unbounded`. */
  maxPackageMetadataBytes: 4 * 1024,
  /** A hash run that takes longer refuses the start. */
  hashTimeoutMs: 60_000,
});

/** The file that describes a Codex package, beside `bin/` or beside the program. */
export const CODEX_PACKAGE_METADATA = 'codex-package.json';

/** Where npm's `claude.cmd` launcher finds the program it starts, relative to the launcher's own folder. */
export const CLAUDE_NPM_LAUNCHER_PROGRAM = ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'] as const;

export interface CliClosureRequest {
  provider: CliRuntimeProvider;
  /** The absolute path of the program the launch would start. */
  executable: string;
}

/** One file of a closure before it is hashed. */
export interface CliClosurePlanFile {
  /** The listing path: relative, with `/` separators. */
  path: string;
  /** The physical path that is read. */
  absolutePath: string;
  /** The size the file system reported when the closure was resolved. */
  size: number;
}

/** A resolved closure: which files, before any byte is read. */
export interface CliClosurePlan {
  provider: CliRuntimeProvider;
  kind: CliClosureKind;
  /** The physical path of the program. */
  executable: string;
  /** The physical package folder; `package` only. */
  root?: string;
  files: CliClosurePlanFile[];
  /** The listing path of the program. */
  executablePath: string;
  /** Why a Codex program's package could not be bounded; `unbounded` only. */
  unboundedReason?: string;
}

/** A hashed closure: its sorted listing and the digest the identity of a launch is keyed by. */
export interface CliClosure extends QualifiableCliClosure {
  provider: CliRuntimeProvider;
  kind: CliClosureKind;
  executable: string;
  root?: string;
  /** Sorted as the listing is. */
  files: CliClosureFile[];
  executablePath: string;
  listing: string;
  digest: string;
  unboundedReason?: string;
}

export type CliClosureResolution =
  | { ok: true; plan: CliClosurePlan }
  | { ok: false; reason: 'not-absolute' | 'unreadable' | 'not-a-file' | 'unsupported-program' | 'launcher-program-missing'; message: string };

export type CliClosureOutcome =
  | { ok: true; closure: CliClosure }
  | Extract<CliClosureResolution, { ok: false }>
  | { ok: false; reason: ClosureCheckFailure; message: string };

/** Why a hash run gave no answer. */
export type ClosureCheckFailure = 'hash-failed' | 'hash-timeout' | 'changed-during-check';

/** What a closure is resolved with. Only metadata and `codex-package.json` are read. */
export interface CliClosureFs {
  realpath(file: string): Promise<string>;
  lstat(file: string): Promise<CliClosureStat>;
  readdir(folder: string): Promise<string[]>;
  /** At most `maxBytes` bytes from the start of the file. */
  readFile(file: string, maxBytes: number): Promise<Buffer>;
}

export interface CliClosureStat {
  isFile(): boolean;
  isDirectory(): boolean;
  /** Node reports Windows symbolic links and junctions this way. */
  isSymbolicLink(): boolean;
  size: number;
}

export interface CliClosureOptions {
  fs?: CliClosureFs;
  platform?: NodeJS.Platform;
}

const nodeClosureFs: CliClosureFs = {
  realpath: (file) => fsp.realpath(file),
  lstat: (file) => fsp.lstat(file),
  readdir: (folder) => fsp.readdir(folder),
  readFile: async (file, maxBytes) => {
    const handle = await fsp.open(file, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      let length = 0;
      while (length < maxBytes) {
        const { bytesRead } = await handle.read(buffer, length, maxBytes - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      return buffer.subarray(0, length);
    } finally {
      await handle.close();
    }
  },
};

/** A hash run's failure, with the reason a start is refused for. */
export class ClosureCheckError extends Error {
  constructor(readonly reason: ClosureCheckFailure, message: string) {
    super(message);
  }
}

/**
 * The closure a launch of `request.executable` binds, from the file system alone:
 * - Codex, package layout: the program is `<root>/bin/<name>.exe` and `<root>/codex-package.json` names
 *   `bin/<name>.exe`; root layout: the program is `<root>/<name>.exe` and the file names `<name>.exe`. Every regular
 *   file under `<root>` is listed. Anything else, or a root that breaks a rule, is `unbounded`.
 * - Claude: a `.exe` (or any program outside Windows) is `single-file`; npm's `.cmd` launcher is `launcher-pair`
 *   with the program it starts from beside it. A launcher without that program has no closure, so nothing starts.
 */
export async function resolveCliClosure(
  request: CliClosureRequest,
  options: CliClosureOptions & { signal?: AbortSignal } = {},
): Promise<CliClosureResolution> {
  const fs = options.fs ?? nodeClosureFs;
  const platform = options.platform ?? process.platform;
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  if (!hostPath.isAbsolute(request.executable)) {
    return { ok: false, reason: 'not-absolute', message: 'The CLI program path is not absolute.' };
  }
  let physical: string;
  let stat: CliClosureStat;
  try {
    physical = await fs.realpath(request.executable);
    stat = await fs.lstat(physical);
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: `UnodeAi could not read the CLI program (${errorText(error)}).` };
  }
  if (!stat.isFile()) return { ok: false, reason: 'not-a-file', message: 'The CLI program is not a regular file.' };
  const name = hostPath.basename(physical);
  const program: CliClosurePlanFile = { path: name, absolutePath: physical, size: stat.size };

  if (request.provider === 'claude-cli') {
    const extension = hostPath.extname(name).toLowerCase();
    if (platform !== 'win32' || extension === '.exe') {
      return { ok: true, plan: { provider: request.provider, kind: 'single-file', executable: physical, files: [program], executablePath: name } };
    }
    if (extension !== '.cmd' && extension !== '.bat') {
      return { ok: false, reason: 'unsupported-program', message: 'UnodeAi starts only a .exe program or npm\'s .cmd launcher for Claude CLI.' };
    }
    const besideLauncher = hostPath.join(hostPath.dirname(physical), ...CLAUDE_NPM_LAUNCHER_PROGRAM);
    let started: string;
    let startedStat: CliClosureStat;
    try {
      started = await fs.realpath(besideLauncher);
      startedStat = await fs.lstat(started);
    } catch {
      return launcherProgramMissing();
    }
    if (!startedStat.isFile()) return launcherProgramMissing();
    return {
      ok: true,
      plan: {
        provider: request.provider,
        kind: 'launcher-pair',
        executable: physical,
        files: [program, { path: CLAUDE_NPM_LAUNCHER_PROGRAM.join('/'), absolutePath: started, size: startedStat.size }],
        executablePath: name,
      },
    };
  }

  const unbounded = (reason: string): CliClosureResolution => ({
    ok: true,
    plan: { provider: request.provider, kind: 'unbounded', executable: physical, files: [program], executablePath: name, unboundedReason: reason },
  });
  if (platform === 'win32' && hostPath.extname(name).toLowerCase() !== '.exe') return unbounded('the program is not a .exe file');
  const folder = hostPath.dirname(physical);
  const layouts: Array<{ root: string; entrypoint: string }> = [];
  if (samePathText(hostPath.basename(folder), 'bin', platform)) layouts.push({ root: hostPath.dirname(folder), entrypoint: `bin/${name}` });
  layouts.push({ root: folder, entrypoint: name });
  for (const layout of layouts) {
    const metadataPath = hostPath.join(layout.root, CODEX_PACKAGE_METADATA);
    let metadata: CliClosureStat;
    try {
      metadata = await fs.lstat(metadataPath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') continue;
      return unbounded(`${CODEX_PACKAGE_METADATA} could not be read`);
    }
    if (metadata.isSymbolicLink()) return unbounded(`${CODEX_PACKAGE_METADATA} is a link`);
    if (!metadata.isFile()) return unbounded(`${CODEX_PACKAGE_METADATA} is not a file`);
    if (metadata.size > CLI_CLOSURE_LIMITS.maxPackageMetadataBytes) return unbounded(`${CODEX_PACKAGE_METADATA} is larger than 4 KiB`);
    let text: Buffer;
    try {
      // One byte more than allowed, so that a file that grew after its size was read is still caught.
      text = await fs.readFile(metadataPath, CLI_CLOSURE_LIMITS.maxPackageMetadataBytes + 1);
    } catch {
      return unbounded(`${CODEX_PACKAGE_METADATA} could not be read`);
    }
    if (text.length > CLI_CLOSURE_LIMITS.maxPackageMetadataBytes) return unbounded(`${CODEX_PACKAGE_METADATA} is larger than 4 KiB`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.toString('utf8'));
    } catch {
      return unbounded(`${CODEX_PACKAGE_METADATA} does not parse`);
    }
    const described = parsed as { layoutVersion?: unknown; entrypoint?: unknown } | null;
    if (!described || typeof described !== 'object' || Array.isArray(described) || described.layoutVersion !== 1
      || typeof described.entrypoint !== 'string' || !samePathText(described.entrypoint, layout.entrypoint, platform)) {
      return unbounded(`${CODEX_PACKAGE_METADATA} does not describe this program`);
    }
    const tree = await enumerateTree(layout.root, { fs, platform, signal: options.signal });
    if (!tree.ok) return unbounded(tree.message);
    const listed = tree.files.find((file) => samePathText(file.path, layout.entrypoint, platform));
    if (!listed) return unbounded('the program is not inside its package folder');
    return {
      ok: true,
      plan: { provider: request.provider, kind: 'package', executable: physical, root: layout.root, files: tree.files, executablePath: listed.path },
    };
  }
  return unbounded(`no ${CODEX_PACKAGE_METADATA} describes this program`);
}

function launcherProgramMissing(): CliClosureResolution {
  return {
    ok: false,
    reason: 'launcher-program-missing',
    message: 'npm\'s claude.cmd launcher has no claude.exe beside it in node_modules, so UnodeAi cannot tell which program it would start. Nothing was started.',
  };
}

/** The canonical listing: one `<path>\t<size>\t<sha256>\n` line per file, sorted by the lower-case path. */
export function closureListing(files: readonly CliClosureFile[]): string {
  return sortClosureFiles(files).map((file) => `${file.path}\t${file.size}\t${file.sha256}\n`).join('');
}

/** The SHA-256 of the listing's UTF-8 bytes, in lower-case hex. */
export function closureDigest(listing: string): string {
  return createHash('sha256').update(Buffer.from(listing, 'utf8')).digest('hex');
}

/** Sorted by the lower-case path in code-unit order, then by the path itself, so the order never depends on a locale. */
function sortClosureFiles<T extends { path: string }>(files: readonly T[]): T[] {
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...files].sort((a, b) => order(a.path.toLowerCase(), b.path.toLowerCase()) || order(a.path, b.path));
}

/** One hash run's work: the files' hashes, from the worker of that run. */
export type ClosureFileHasher = (files: readonly string[]) => Promise<Array<{ size: number; sha256: string }>>;

export interface ClosureHasherOptions {
  /** A run that takes longer refuses every request that waits for it. */
  timeoutMs?: number;
  /** Starts the worker of one run. */
  startWorker?: () => Worker;
}

/**
 * Hash runs for CLI starts. Runs of one provider never overlap. A request shares a run only while that run has not
 * begun, so every answer comes from files read after the request was made; otherwise it waits and gets its own run.
 * A worker error, a worker that exits without answering, or a run past the timeout refuses every request of that
 * run. Nothing is kept after a run: the next request reads the files again.
 */
export class ClosureHasher {
  private readonly timeoutMs: number;
  private readonly startWorker: () => Worker;
  private readonly tails = new Map<CliRuntimeProvider, Promise<void>>();
  private readonly notBegun = new Map<string, Promise<unknown>>();

  constructor(options: ClosureHasherOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? CLI_CLOSURE_LIMITS.hashTimeoutMs;
    this.startWorker = options.startWorker ?? startClosureWorker;
  }

  run<T>(provider: CliRuntimeProvider, key: string, job: (hashFiles: ClosureFileHasher, signal: AbortSignal) => Promise<T>): Promise<T> {
    const runKey = `${provider}\0${key}`;
    const waiting = this.notBegun.get(runKey);
    if (waiting) return waiting as Promise<T>;
    const previous = this.tails.get(provider) ?? Promise.resolve();
    const run: Promise<T> = previous.then(() => {
      // The run begins now; a request made from here on waits for a run of its own.
      if (this.notBegun.get(runKey) === run) this.notBegun.delete(runKey);
      return this.execute(job);
    });
    this.notBegun.set(runKey, run);
    this.tails.set(provider, run.then(() => undefined, () => undefined));
    return run;
  }

  private async execute<T>(job: (hashFiles: ClosureFileHasher, signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new ClosureCheckError('hash-timeout', `Checking the CLI program's files took longer than ${Math.round(this.timeoutMs / 1000)} s.`);
        controller.abort(error);
        reject(error);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([job((files) => this.hashFiles(files, controller.signal), controller.signal), timedOut]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private hashFiles(files: readonly string[], signal: AbortSignal): Promise<Array<{ size: number; sha256: string }>> {
    if (signal.aborted) return Promise.reject(signal.reason);
    let worker: Worker;
    try {
      worker = this.startWorker();
    } catch (error) {
      return Promise.reject(new ClosureCheckError('hash-failed', `The CLI hashing worker could not start (${errorText(error)}).`));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (complete: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        void worker.terminate().catch(() => undefined);
        complete();
      };
      const onAbort = () => settle(() => reject(signal.reason));
      signal.addEventListener('abort', onAbort, { once: true });
      worker.once('message', (reply: { ok?: unknown; files?: unknown; error?: unknown }) => {
        settle(() => {
          const hashed = reply?.ok === true ? validHashes(reply.files, files.length) : undefined;
          if (hashed) resolve(hashed);
          else reject(new ClosureCheckError('hash-failed', reply?.ok === false && typeof reply.error === 'string'
            ? `The CLI program's files could not be read (${reply.error.slice(0, 300)}).`
            : 'The CLI hashing worker returned an unreadable answer.'));
        });
      });
      worker.once('error', (error) => settle(() => reject(new ClosureCheckError('hash-failed', `The CLI hashing worker failed (${errorText(error)}).`))));
      worker.once('exit', (code) => settle(() => reject(new ClosureCheckError('hash-failed', `The CLI hashing worker exited before answering (code ${code}).`))));
      worker.postMessage({ files: [...files], maxBytes: CLI_CLOSURE_LIMITS.maxBytes });
    });
  }
}

function validHashes(value: unknown, count: number): Array<{ size: number; sha256: string }> | undefined {
  if (!Array.isArray(value) || value.length !== count) return undefined;
  const valid = value.every((item) => item && typeof item === 'object'
    && Number.isSafeInteger(item.size) && item.size >= 0
    && typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/.test(item.sha256));
  return valid ? value.map((item) => ({ size: item.size as number, sha256: item.sha256 as string })) : undefined;
}

/** The hashing worker, found the way the content workers are: beside this module, or beside the bundle. */
export function startClosureWorker(): Worker {
  // tsc keeps this module under out/backend; esbuild inlines it into out/extension.js and emits the worker
  // separately under out/backend. Supporting both paths keeps the hasher testable before packaging.
  const sibling = path.join(__dirname, 'cliClosureWorker.js');
  const bundled = path.join(__dirname, 'backend', 'cliClosureWorker.js');
  const workerPath = [sibling, bundled, path.join(path.resolve(__dirname, '..', '..'), 'out', 'backend', 'cliClosureWorker.js')].find(existsSync);
  if (!workerPath) throw new Error('the CLI hashing worker is unavailable');
  return new Worker(workerPath);
}

/**
 * The hashed closure a start of `request.executable` binds, computed afresh in one hash run of `hasher`. A
 * resolution failure or a failed, timed-out or contradictory run is a refusal; there is no fallback answer.
 */
export function computeCliClosure(
  request: CliClosureRequest,
  hasher: ClosureHasher,
  options: CliClosureOptions = {},
): Promise<CliClosureOutcome> {
  const platform = options.platform ?? process.platform;
  const key = `closure\0${pathKey(request.executable, platform)}`;
  return hasher.run(request.provider, key, async (hashFiles, signal): Promise<CliClosureOutcome> => {
    const resolution = await resolveCliClosure(request, { ...options, signal });
    if (!resolution.ok) return resolution;
    return { ok: true, closure: await hashPlan(resolution.plan, hashFiles) };
  }).catch(refusal);
}

export type ManagedFolderProblem =
  | 'unreadable' | 'reparse-point' | 'not-a-file' | 'case-duplicate' | 'too-many-entries' | 'too-large'
  | 'extra-file' | 'missing-file' | 'changed-file' | ClosureCheckFailure;

export type ManagedFolderCheck =
  | { ok: true; closure: CliClosure }
  /** `file` is the listing path the check stopped at, when one file is to blame. */
  | { ok: false; reason: ManagedFolderProblem; file?: string; message: string };

/**
 * Whether a managed version folder holds exactly the layout's files: the same set (without case on Windows), the
 * same sizes and the same SHA-256 for each, no link anywhere, nothing else. A failure names the file. The check
 * knows nothing of the store around the folder.
 */
export function verifyManagedVersionFolder(
  folder: string,
  layout: Pick<PolicyLayout, 'entrypoint' | 'files'>,
  hasher: ClosureHasher,
  options: CliClosureOptions = {},
): Promise<ManagedFolderCheck> {
  const fs = options.fs ?? nodeClosureFs;
  const platform = options.platform ?? process.platform;
  const fileKey = (value: string) => (platform === 'win32' ? value.toLowerCase() : value);
  const layoutDigest = createHash('sha256').update(JSON.stringify([layout.entrypoint, layout.files])).digest('hex');
  const key = `managed\0${pathKey(folder, platform)}\0${layoutDigest}`;
  return hasher.run('codex-cli', key, async (hashFiles, signal): Promise<ManagedFolderCheck> => {
    let top: CliClosureStat;
    try {
      top = await fs.lstat(folder);
    } catch (error) {
      return { ok: false, reason: 'unreadable', message: `The version folder could not be read (${errorText(error)}).` };
    }
    if (top.isSymbolicLink()) return { ok: false, reason: 'reparse-point', file: '.', message: 'The version folder is a link.' };
    if (!top.isDirectory()) return { ok: false, reason: 'not-a-file', file: '.', message: 'The version folder is not a folder.' };
    const tree = await enumerateTree(folder, { fs, platform, signal });
    if (!tree.ok) return { ok: false, reason: tree.reason, file: tree.file, message: tree.message };

    const expected = new Map(layout.files.map((file) => [fileKey(file.path), file]));
    const found = new Map<string, CliClosurePlanFile>();
    for (const file of tree.files) {
      const listed = expected.get(fileKey(file.path));
      if (!listed) return { ok: false, reason: 'extra-file', file: file.path, message: `${file.path} is not one of the checked files.` };
      if (file.size !== listed.size) return { ok: false, reason: 'changed-file', file: file.path, message: `${file.path} changed size after it was checked.` };
      found.set(fileKey(file.path), file);
    }
    for (const listed of layout.files) {
      if (!found.has(fileKey(listed.path))) return { ok: false, reason: 'missing-file', file: listed.path, message: `${listed.path} is missing.` };
    }
    const entrypoint = found.get(fileKey(layout.entrypoint));
    if (!entrypoint) return { ok: false, reason: 'missing-file', file: layout.entrypoint, message: `${layout.entrypoint} is missing.` };
    const closure = await hashPlan({
      provider: 'codex-cli',
      kind: 'package',
      executable: entrypoint.absolutePath,
      root: folder,
      files: tree.files,
      executablePath: entrypoint.path,
    }, hashFiles);
    for (const file of closure.files) {
      if (file.sha256 !== expected.get(fileKey(file.path))?.sha256) {
        return { ok: false, reason: 'changed-file', file: file.path, message: `${file.path} changed after it was checked.` };
      }
    }
    return { ok: true, closure };
  }).catch(refusal);
}

async function hashPlan(plan: CliClosurePlan, hashFiles: ClosureFileHasher): Promise<CliClosure> {
  const hashed = await hashFiles(plan.files.map((file) => file.absolutePath));
  const files = plan.files.map((file, index) => {
    if (hashed[index].size !== file.size) {
      throw new ClosureCheckError('changed-during-check', `${file.path} changed while the CLI program was checked.`);
    }
    return { path: file.path, size: hashed[index].size, sha256: hashed[index].sha256 };
  });
  const listing = closureListing(files);
  // Every request that shared the run gets this one object, so none of them can change another's answer.
  return Object.freeze({
    provider: plan.provider,
    kind: plan.kind,
    executable: plan.executable,
    ...(plan.root !== undefined ? { root: plan.root } : {}),
    files: Object.freeze(sortClosureFiles(files).map((file) => Object.freeze(file))) as CliClosureFile[],
    executablePath: plan.executablePath,
    listing,
    digest: closureDigest(listing),
    ...(plan.unboundedReason !== undefined ? { unboundedReason: plan.unboundedReason } : {}),
  });
}

type TreeProblem = 'unreadable' | 'reparse-point' | 'not-a-file' | 'case-duplicate' | 'too-many-entries' | 'too-large';

/**
 * Every regular file under `root`, or the first rule the tree breaks: a link (a Windows junction or symbolic link
 * included), an entry that is neither a file nor a folder, two paths equal without case on Windows, more than 20,000
 * entries or more than 1 GiB. Folders are read one at a time; nothing is opened.
 */
async function enumerateTree(
  root: string,
  options: { fs: CliClosureFs; platform: NodeJS.Platform; signal?: AbortSignal },
): Promise<{ ok: true; files: CliClosurePlanFile[] } | { ok: false; reason: TreeProblem; file?: string; message: string }> {
  const { fs, platform, signal } = options;
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  const files: CliClosurePlanFile[] = [];
  const seen = new Set<string>();
  let entries = 0;
  let bytes = 0;
  const pending: string[] = [''];
  while (pending.length > 0) {
    if (signal?.aborted) throw signal.reason;
    const relativeFolder = pending.pop() as string;
    const folder = relativeFolder ? hostPath.join(root, ...relativeFolder.split('/')) : root;
    let names: string[];
    try {
      names = await fs.readdir(folder);
    } catch (error) {
      return { ok: false, reason: 'unreadable', file: relativeFolder || '.', message: `${relativeFolder || 'the package folder'} could not be listed (${errorText(error)})` };
    }
    for (const name of names) {
      if (signal?.aborted) throw signal.reason;
      const relative = relativeFolder ? `${relativeFolder}/${name}` : name;
      entries += 1;
      if (entries > CLI_CLOSURE_LIMITS.maxEntries) return { ok: false, reason: 'too-many-entries', message: 'the package folder holds more than 20,000 entries' };
      if (platform === 'win32') {
        const folded = relative.toLowerCase();
        if (seen.has(folded)) return { ok: false, reason: 'case-duplicate', file: relative, message: `${relative} equals another path without case` };
        seen.add(folded);
      }
      const absolute = hostPath.join(folder, name);
      let stat: CliClosureStat;
      try {
        stat = await fs.lstat(absolute);
      } catch (error) {
        return { ok: false, reason: 'unreadable', file: relative, message: `${relative} could not be read (${errorText(error)})` };
      }
      if (stat.isSymbolicLink()) return { ok: false, reason: 'reparse-point', file: relative, message: `${relative} is a link or junction` };
      if (stat.isDirectory()) {
        pending.push(relative);
        continue;
      }
      if (!stat.isFile()) return { ok: false, reason: 'not-a-file', file: relative, message: `${relative} is neither a file nor a folder` };
      bytes += stat.size;
      if (bytes > CLI_CLOSURE_LIMITS.maxBytes) return { ok: false, reason: 'too-large', message: 'the package folder holds more than 1 GiB' };
      files.push({ path: relative, absolutePath: absolute, size: stat.size });
    }
  }
  return { ok: true, files };
}

function refusal(error: unknown): { ok: false; reason: ClosureCheckFailure; message: string } {
  if (error instanceof ClosureCheckError) return { ok: false, reason: error.reason, message: error.message };
  return { ok: false, reason: 'hash-failed', message: `The CLI program could not be checked (${errorText(error)}).` };
}

function pathKey(value: string, platform: NodeJS.Platform): string {
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  const resolved = hostPath.resolve(value);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePathText(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
