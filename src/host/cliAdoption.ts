/*---------------------------------------------------------------------------------------------
 *  UnodeAi - External CLI adoption records (v0.9.97)
 *  A Claude or Codex program that this UnodeAi has not qualified runs only after the user chose it once and its
 *  compatibility check passed. That decision is kept as one record per exact identity: the provider, the physical
 *  program and the digest of its closure, the files bound to its start. Any change to one of those files is another
 *  identity, so it asks again.
 *
 *  Records live in `<cli-store>\adoptions\<provider>\`. Each is written once, flushed, and linked to its final name,
 *  which fails when the name exists: a record is never rewritten and no reader ever sees a partial one. A record that
 *  does not parse, does not match its own digest, or does not describe the current closure is not evidence. Neither
 *  is any record while an agent could write into the store, because it could forge one.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import * as path from 'node:path';
import { closureDigest, closureListing, type CliClosure } from '../backend/cliClosure';
import type { CliClosureKind } from '../backend/cliCompatibilityPolicy';
import type { CliRuntimeProvider } from '../backend/cliRuntime';
import { isPathInsideOrEqual } from '../backend/pathContainment';
import { canonicalJson, cliStoreReachableFrom, cliStoreRoots, newStoreToken, recordDigest } from './managedCli/storeLayout';

/** A record's closure listing has at most this many lines; a larger closure is not recorded. */
export const ADOPTION_LISTING_MAX_LINES = 20_000;
/** A record file larger than this is not read. */
export const ADOPTION_RECORD_MAX_BYTES = 16 * 1024 * 1024;

const PROVIDERS: readonly CliRuntimeProvider[] = ['claude-cli', 'codex-cli'];
/** The closure kinds each provider's programs can have. */
const KINDS: Readonly<Record<CliRuntimeProvider, readonly CliClosureKind[]>> = {
  'codex-cli': ['package', 'unbounded'],
  'claude-cli': ['single-file', 'launcher-pair'],
};
const RECORD_NAME = /^[0-9a-f]{64}\.json$/;
const TEMP_NAME = /^\.adoption\.tmp-[0-9a-f]{32}$/;
const LISTING_LINE = /^[^\t\n]+\t(0|[1-9]\d{0,15})\t[0-9a-f]{64}$/;

/** The compatibility check that passed, as the record keeps it. */
export interface AdoptionProbeEvidence {
  result: 'pass';
  /** What the program printed for `--version`, trimmed. */
  versionOutput: string;
  ranAt: string;
  durationMs: number;
}

export interface AdoptionRecord {
  v: 1;
  provider: CliRuntimeProvider;
  /** The physical program, as it was spawned. */
  executable: string;
  closureKind: CliClosureKind;
  closureDigest: string;
  /** The closure listing, so a later mismatch can name the file that changed. */
  listing: string;
  /** The exact version the check read. */
  version: string;
  probe: AdoptionProbeEvidence;
  decidedAt: string;
  extensionVersion: string;
  /** The SHA-256 of the record's canonical JSON without this field. */
  recordDigest: string;
}

/** Who could write into the store. Both lists are required: an omitted list must not read as "nobody". */
export interface AdoptionReach {
  /** Every folder an agent of this window may write. */
  writeRoots: readonly string[];
  /** Every Folder Access grant of this window. */
  folderAccessGrants: readonly string[];
}

/** What the record functions read and write. Production uses `nodeAdoptionFs`; tests replace parts of it. */
export interface AdoptionFs {
  /** Undefined when the file is larger than `maxBytes`. Throws `ENOENT` when it is missing. */
  readFile(file: string, maxBytes: number): Buffer | undefined;
  /** Creates the file exclusively, writes all bytes, flushes them and closes it. */
  writeExclusive(file: string, bytes: Buffer): void;
  link(existing: string, created: string): void;
  unlink(file: string): void;
  readdir(folder: string): string[];
  /** Creates one folder; its parent must exist. `EEXIST` is not an error. */
  mkdir(folder: string): void;
  /** Undefined when nothing exists there. */
  lstat(file: string): { isSymbolicLink(): boolean; isDirectory(): boolean } | undefined;
  realpath(file: string): string;
}

export const nodeAdoptionFs: AdoptionFs = {
  readFile: (file, maxBytes) => {
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size > maxBytes) return undefined;
      const bytes = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const count = readSync(fd, bytes, read, size - read, read);
        if (count === 0) break;
        read += count;
      }
      return bytes.subarray(0, read);
    } finally {
      closeSync(fd);
    }
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
  readdir: (folder) => readdirSync(folder),
  mkdir: (folder) => {
    try {
      mkdirSync(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  },
  lstat: (file) => {
    try {
      return lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  },
  realpath: (file) => realpathSync.native(file),
};

export interface AdoptionContext {
  /** `%LOCALAPPDATA%\UnodeAi\cli-store`, as `resolveCliStoreLocation` found it. */
  storeRoot: string;
  reach: AdoptionReach;
  platform?: NodeJS.Platform;
  fs?: AdoptionFs;
}

/** The physical program as the identity compares it: without case on Windows. */
export function adoptionExecutableKey(executable: string, platform: NodeJS.Platform = process.platform): string {
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  const resolved = hostPath.resolve(executable);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** `sha256(provider | physical program, case-folded on Windows | closure digest)`, in hex. */
export function adoptionId(provider: CliRuntimeProvider, executable: string, digest: string, platform: NodeJS.Platform = process.platform): string {
  return createHash('sha256').update(`${provider}|${adoptionExecutableKey(executable, platform)}|${digest}`, 'utf8').digest('hex');
}

function providerFolder(storeRoot: string, provider: CliRuntimeProvider): string {
  return path.join(cliStoreRoots(storeRoot).adoptions, provider);
}

/** Where the record of one identity is. */
export function adoptionRecordPath(storeRoot: string, provider: CliRuntimeProvider, id: string): string {
  return path.join(providerFolder(storeRoot, provider), `${id}.json`);
}

function storeReachable(context: AdoptionContext): boolean {
  const fs = context.fs ?? nodeAdoptionFs;
  return cliStoreReachableFrom(context.storeRoot, [...context.reach.writeRoots, ...context.reach.folderAccessGrants], (file) => fs.realpath(file));
}

export type AdoptionLookup =
  | { adopted: true; adoptionId: string; record: AdoptionRecord }
  | {
    adopted: false;
    /**
     * `none`: no record for this identity. `damaged`: a record exists but is not evidence. `store-reachable`: an
     * agent could write into the store. `not-this-closure`: the program or closure given does not match itself.
     */
    reason: 'none' | 'damaged' | 'store-reachable' | 'not-this-closure';
    detail?: string;
  };

/**
 * The adoption of exactly this identity, or why there is none. `executable` is the physical program the start would
 * spawn, which is the closure's own. Only a record whose every field parses, whose digest matches, and whose closure
 * digest and listing equal the current closure's is the adopted identity. Nothing is ever repaired or rewritten.
 */
export function findAdoption(
  provider: CliRuntimeProvider,
  executable: string,
  closure: Pick<CliClosure, 'kind' | 'executable' | 'listing' | 'digest'>,
  context: AdoptionContext,
): AdoptionLookup {
  const platform = context.platform ?? process.platform;
  const fs = context.fs ?? nodeAdoptionFs;
  if (!PROVIDERS.includes(provider)) return { adopted: false, reason: 'not-this-closure', detail: 'unknown provider' };
  if (adoptionExecutableKey(executable, platform) !== adoptionExecutableKey(closure.executable, platform)
    || closureDigest(closure.listing) !== closure.digest) {
    return { adopted: false, reason: 'not-this-closure' };
  }
  if (storeReachable(context)) return { adopted: false, reason: 'store-reachable' };
  const linked = linkedFolder(context, provider, fs);
  if (linked) return { adopted: false, reason: 'damaged', detail: linked };

  const id = adoptionId(provider, closure.executable, closure.digest, platform);
  let bytes: Buffer | undefined;
  try {
    bytes = fs.readFile(adoptionRecordPath(context.storeRoot, provider, id), ADOPTION_RECORD_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { adopted: false, reason: 'none' };
    return { adopted: false, reason: 'damaged', detail: `the record could not be read (${errorCode(error)})` };
  }
  if (!bytes) return { adopted: false, reason: 'damaged', detail: 'the record is larger than a record can be' };
  const parsed = parseAdoptionRecord(bytes, provider, platform);
  if (!parsed.ok) return { adopted: false, reason: 'damaged', detail: parsed.detail };
  const record = parsed.record;
  if (adoptionId(provider, record.executable, record.closureDigest, platform) !== id
    || record.closureKind !== closure.kind || record.closureDigest !== closure.digest || record.listing !== closure.listing) {
    return { adopted: false, reason: 'damaged', detail: 'the record does not describe this program' };
  }
  return { adopted: true, adoptionId: id, record };
}

export interface AdoptionInput {
  provider: CliRuntimeProvider;
  /** The hashed closure the user confirmed and the check ran on. */
  closure: Pick<CliClosure, 'kind' | 'executable' | 'files' | 'listing' | 'digest'>;
  version: string;
  probe: AdoptionProbeEvidence;
  decidedAt: string;
  extensionVersion: string;
}

export type AdoptionWrite =
  | { ok: true; adoptionId: string; file: string }
  | {
    ok: false;
    /** `exists`: this identity already has a record, which is kept as it is. */
    reason: 'exists' | 'store-reachable' | 'too-large' | 'invalid' | 'write-failed';
    detail: string;
  };

/**
 * Writes the record of one adoption, after its check passed. The record is created exclusively: a second write of
 * the same identity is refused and the first record is kept.
 */
export function recordAdoption(input: AdoptionInput, context: AdoptionContext): AdoptionWrite {
  const platform = context.platform ?? process.platform;
  const fs = context.fs ?? nodeAdoptionFs;
  const { provider, closure } = input;
  if (!PROVIDERS.includes(provider) || !KINDS[provider].includes(closure.kind)) {
    return { ok: false, reason: 'invalid', detail: 'the closure is not one of this provider\'s' };
  }
  if (input.probe?.result !== 'pass') return { ok: false, reason: 'invalid', detail: 'only a check that passed is recorded' };
  if (closure.files.length > ADOPTION_LISTING_MAX_LINES) {
    return { ok: false, reason: 'too-large', detail: `the program has more than ${ADOPTION_LISTING_MAX_LINES.toLocaleString('en-US')} files` };
  }
  if (closureListing(closure.files) !== closure.listing || closureDigest(closure.listing) !== closure.digest) {
    return { ok: false, reason: 'invalid', detail: 'the closure listing does not match its files or its digest' };
  }
  if (storeReachable(context)) return { ok: false, reason: 'store-reachable', detail: 'an agent could write into the CLI store' };

  const content: Omit<AdoptionRecord, 'recordDigest'> = {
    v: 1, provider, executable: closure.executable, closureKind: closure.kind, closureDigest: closure.digest,
    listing: closure.listing, version: input.version,
    probe: { result: 'pass', versionOutput: input.probe.versionOutput, ranAt: input.probe.ranAt, durationMs: input.probe.durationMs },
    decidedAt: input.decidedAt, extensionVersion: input.extensionVersion,
  };
  const record: AdoptionRecord = { ...content, recordDigest: recordDigest(content) };
  const bytes = Buffer.from(canonicalJson(record), 'utf8');
  if (bytes.length > ADOPTION_RECORD_MAX_BYTES) return { ok: false, reason: 'too-large', detail: 'the record would be larger than a record can be' };
  const check = parseAdoptionRecord(bytes, provider, platform);
  if (!check.ok) return { ok: false, reason: 'invalid', detail: check.detail };

  const folder = providerFolder(context.storeRoot, provider);
  const id = adoptionId(provider, closure.executable, closure.digest, platform);
  const file = path.join(folder, `${id}.json`);
  try {
    // Each folder is created on its own, so nothing is created below a parent that is missing or a link.
    for (const level of [path.dirname(context.storeRoot), context.storeRoot, cliStoreRoots(context.storeRoot).adoptions, folder]) {
      fs.mkdir(level);
      const stat = fs.lstat(level);
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
        return { ok: false, reason: 'write-failed', detail: `${level} is not a folder of its own` };
      }
    }
    const temp = path.join(folder, `.adoption.tmp-${newStoreToken()}`);
    fs.writeExclusive(temp, bytes);
    try {
      fs.link(temp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ok: false, reason: 'exists', detail: 'this exact program already has an adoption record, which was kept' };
      }
      throw error;
    } finally {
      try { fs.unlink(temp); } catch { /* removed with the folder, or by Forget adoptions */ }
    }
  } catch (error) {
    return { ok: false, reason: 'write-failed', detail: `the record could not be written (${errorCode(error)})` };
  }
  return { ok: true, adoptionId: id, file };
}

/** The listing paths whose line differs between the record and the closure: changed, added or gone, sorted. */
export function changedFiles(record: Pick<AdoptionRecord, 'listing'>, closure: Pick<CliClosure, 'listing'>): string[] {
  const lines = (listing: string) => {
    const byPath = new Map<string, string>();
    for (const line of listing.split('\n')) {
      if (!line) continue;
      byPath.set(line.slice(0, line.indexOf('\t')), line);
    }
    return byPath;
  };
  const before = lines(record.listing);
  const after = lines(closure.listing);
  const changed = new Set<string>();
  for (const [file, line] of before) if (after.get(file) !== line) changed.add(file);
  for (const file of after.keys()) if (!before.has(file)) changed.add(file);
  return [...changed].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
}

/** Deletes the adoption records of one provider, or of both when none is given. Returns how many were deleted. */
export function forgetAdoptions(context: Pick<AdoptionContext, 'storeRoot' | 'fs'>, provider?: CliRuntimeProvider): number {
  const fs = context.fs ?? nodeAdoptionFs;
  let deleted = 0;
  for (const each of provider ? [provider] : PROVIDERS) {
    const folder = providerFolder(context.storeRoot, each);
    const stat = fs.lstat(folder);
    // A link is not followed: what it leads to is not UnodeAi's to delete.
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    let names: string[];
    try {
      names = fs.readdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names) {
      if (!RECORD_NAME.test(name) && !TEMP_NAME.test(name)) continue;
      try {
        fs.unlink(path.join(folder, name));
        if (RECORD_NAME.test(name)) deleted += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return deleted;
}

/**
 * Whether a program's physical path, every ancestor resolved, lies inside the CLI store (the live instance, its work
 * folders, retired instances, anything). Compared by whole segments, without case on Windows. A program in the store
 * runs only through the managed path, after its own consent, never as an External program.
 */
export function externalPathInStore(
  physicalExecutable: string,
  storeRoot: string,
  options: { platform?: NodeJS.Platform; realpath?: (file: string) => string } = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  const realpath = options.realpath ?? ((file: string) => realpathSync.native(file));
  const fold = (value: string) => {
    const resolved = hostPath.resolve(stripDevicePrefix(value, platform));
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  /** The physical path of `file`, or of its nearest ancestor that exists with the rest appended. */
  const physical = (file: string): string => {
    let current = hostPath.resolve(file);
    const rest: string[] = [];
    for (;;) {
      try {
        return hostPath.join(stripDevicePrefix(realpath(current), platform), ...rest);
      } catch {
        const parent = hostPath.dirname(current);
        if (parent === current) return hostPath.resolve(file);
        rest.unshift(hostPath.basename(current));
        current = parent;
      }
    }
  };
  const stores = [fold(storeRoot), fold(physical(storeRoot))];
  const candidates = [fold(physicalExecutable), fold(physical(physicalExecutable))];
  return candidates.some((candidate) => stores.some((store) => isPathInsideOrEqual(store, candidate, hostPath)));
}

type RecordParse = { ok: true; record: AdoptionRecord } | { ok: false; detail: string };

function parseAdoptionRecord(bytes: Buffer, provider: CliRuntimeProvider, platform: NodeJS.Platform): RecordParse {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, detail: 'the record is not JSON' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, detail: 'the record is not an object' };
  const record = value as Partial<Record<keyof AdoptionRecord, unknown>>;
  const expected: Array<keyof AdoptionRecord> = ['v', 'provider', 'executable', 'closureKind', 'closureDigest', 'listing', 'version', 'probe', 'decidedAt', 'extensionVersion', 'recordDigest'];
  if (Object.keys(record).length !== expected.length || !expected.every((key) => Object.hasOwn(record, key))) {
    return { ok: false, detail: 'the record has other fields than an adoption record' };
  }
  if (record.v !== 1) return { ok: false, detail: 'the record is not version 1' };
  if (record.provider !== provider) return { ok: false, detail: 'the record is another provider\'s' };
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  if (typeof record.executable !== 'string' || !hostPath.isAbsolute(record.executable)) return { ok: false, detail: 'the record names no program' };
  if (typeof record.closureKind !== 'string' || !KINDS[provider].includes(record.closureKind as CliClosureKind)) {
    return { ok: false, detail: 'the record names no closure kind of this provider' };
  }
  if (typeof record.closureDigest !== 'string' || !/^[0-9a-f]{64}$/.test(record.closureDigest)) return { ok: false, detail: 'the record has no closure digest' };
  if (typeof record.listing !== 'string' || !record.listing.endsWith('\n')) return { ok: false, detail: 'the record has no closure listing' };
  const lines = record.listing.slice(0, -1).split('\n');
  if (lines.length > ADOPTION_LISTING_MAX_LINES) return { ok: false, detail: 'the record\'s listing is longer than a listing can be' };
  if (!lines.every((line) => LISTING_LINE.test(line))) return { ok: false, detail: 'the record\'s listing has a line that is not a listing line' };
  if (closureDigest(record.listing) !== record.closureDigest) return { ok: false, detail: 'the record\'s listing does not match its closure digest' };
  if (typeof record.version !== 'string' || !record.version || record.version.length > 200) return { ok: false, detail: 'the record has no version' };
  const probe = record.probe as Partial<AdoptionProbeEvidence> | null;
  if (!probe || typeof probe !== 'object' || Array.isArray(probe) || Object.keys(probe).length !== 4
    || probe.result !== 'pass' || typeof probe.versionOutput !== 'string' || probe.versionOutput.length > 4096
    || typeof probe.ranAt !== 'string' || typeof probe.durationMs !== 'number' || !Number.isFinite(probe.durationMs) || probe.durationMs < 0) {
    return { ok: false, detail: 'the record holds no passed check' };
  }
  if (typeof record.decidedAt !== 'string' || typeof record.extensionVersion !== 'string') return { ok: false, detail: 'the record has no decision time' };
  if (typeof record.recordDigest !== 'string' || record.recordDigest !== recordDigest(record)) return { ok: false, detail: 'the record does not match its digest' };
  return { ok: true, record: record as AdoptionRecord };
}

/** Why the provider's record folder, or the folder above it, cannot hold evidence: it is a link or not a folder. */
function linkedFolder(context: AdoptionContext, provider: CliRuntimeProvider, fs: AdoptionFs): string | undefined {
  for (const folder of [cliStoreRoots(context.storeRoot).adoptions, providerFolder(context.storeRoot, provider)]) {
    let stat: ReturnType<AdoptionFs['lstat']>;
    try {
      stat = fs.lstat(folder);
    } catch (error) {
      return `${folder} could not be read (${errorCode(error)})`;
    }
    if (!stat) return undefined;
    if (stat.isSymbolicLink() || !stat.isDirectory()) return `${folder} is not a folder of its own`;
  }
  return undefined;
}

function stripDevicePrefix(value: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return value;
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (value.startsWith('\\\\?\\')) return value.slice(4);
  return value;
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message.slice(0, 120) : 'unknown');
}
