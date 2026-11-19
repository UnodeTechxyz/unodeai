/*---------------------------------------------------------------------------------------------
 *  UnodeAi - where the managed CLI store lives, and the names inside it (v0.9.97)
 *  The store is `%LOCALAPPDATA%\UnodeAi\cli-store\`, on a local drive, reached without any link or junction, and never
 *  inside a folder an agent may write. Managed mode exists on Windows x64 only.
 *
 *  `instances\<storeId>\` is named here but derived only by the instance store; every other module holds an
 *  `InstanceRef`.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { isPathInsideOrEqual } from '../../backend/pathContainment';
import type { StoreId } from './contracts';

/** Below `%LOCALAPPDATA%`. */
export const CLI_STORE_SEGMENTS = Object.freeze(['UnodeAi', 'cli-store']);

export interface CliStoreRoots {
  readonly root: string;
  readonly control: string;
  readonly controlAuthority: string;
  readonly floor: string;
  readonly controlManifests: string;
  /** Present means no managed authority in any window. */
  readonly suspension: string;
  /** External adoption records, `<provider>\<id>.json`; never inside an instance. */
  readonly adoptions: string;
  readonly instances: string;
  readonly instanceTrash: string;
  /** `work\<storeId>\<token>\`: probe folders, outside every instance. */
  readonly work: string;
}

export function cliStoreRoots(root: string): CliStoreRoots {
  const join = path.join;
  const control = join(root, 'control');
  const controlAuthority = join(control, 'authority');
  return Object.freeze({
    root,
    control,
    controlAuthority,
    floor: join(controlAuthority, 'floor.bin'),
    controlManifests: join(control, 'manifests'),
    suspension: join(root, 'managed-suspended.json'),
    adoptions: join(root, 'adoptions'),
    instances: join(root, 'instances'),
    instanceTrash: join(root, 'instance-trash'),
    work: join(root, 'work'),
  });
}

const STORE_ID = /^[0-9a-f]{32}$/;

/** A store id, a task token or a lease token: 32 lowercase hex digits. */
export function isStoreToken(value: unknown): value is StoreId {
  return typeof value === 'string' && STORE_ID.test(value);
}

/** 128 random bits as 32 lowercase hex digits. */
export function newStoreToken(random: (bytes: number) => Buffer = randomBytes): string {
  const value = random(16).toString('hex');
  if (!isStoreToken(value)) throw new Error('UnodeAi could not make a random store name.');
  return value;
}

/** JSON with every object's keys sorted, so equal records have equal bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) sorted[key] = sortKeys(item);
    }
    return sorted;
  }
  return value;
}

/** The SHA-256 of a record's canonical JSON, without its own `recordDigest` field. */
export function recordDigest(record: object): string {
  const { recordDigest: _ignored, ...rest } = record as Record<string, unknown>;
  return createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex');
}

export type CliStoreLocation =
  | { ok: true; root: string }
  | { ok: false; reason: 'unsupported-platform' | 'no-local-app-data' | 'not-a-local-drive' | 'link-in-path' | 'unreadable'; detail: string };

export interface CliStoreLocationFs {
  /** Undefined when nothing exists there. */
  lstat(file: string): { isSymbolicLink(): boolean; isDirectory(): boolean } | undefined;
  realpath(file: string): string;
}

const nodeLocationFs: CliStoreLocationFs = {
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

/**
 * The store folder, or why there is none. `%LOCALAPPDATA%` must be an absolute path on a drive letter (no UNC, no
 * device path), and every part of the path that exists must be a real folder: no symbolic link or junction
 * anywhere, and the physical path equal to the written one. Folders that do not exist yet are created later, one at
 * a time, by their owners.
 */
export function resolveCliStoreLocation(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  fs: CliStoreLocationFs = nodeLocationFs,
): CliStoreLocation {
  if (platform !== 'win32' || arch !== 'x64') {
    return { ok: false, reason: 'unsupported-platform', detail: 'Managed Codex is available on Windows x64 only.' };
  }
  const base = env.LOCALAPPDATA;
  if (!base) return { ok: false, reason: 'no-local-app-data', detail: 'LOCALAPPDATA is not set.' };
  if (!/^[A-Za-z]:\\/.test(base) || /[\\/]{2}/.test(base)) {
    return { ok: false, reason: 'not-a-local-drive', detail: 'LOCALAPPDATA is not a folder on a local drive letter.' };
  }
  const root = path.win32.join(path.win32.resolve(base), ...CLI_STORE_SEGMENTS);
  const parts = root.split('\\');
  for (let length = 2; length <= parts.length; length++) {
    const ancestor = parts.slice(0, length).join('\\');
    let stat: ReturnType<CliStoreLocationFs['lstat']>;
    try {
      stat = fs.lstat(ancestor);
    } catch (error) {
      return { ok: false, reason: 'unreadable', detail: `${ancestor} could not be read (${errorCode(error)}).` };
    }
    if (!stat) break;
    if (stat.isSymbolicLink()) return { ok: false, reason: 'link-in-path', detail: `${ancestor} is a link or junction.` };
    if (!stat.isDirectory()) return { ok: false, reason: 'unreadable', detail: `${ancestor} is not a folder.` };
    let physical: string;
    try {
      physical = fs.realpath(ancestor);
    } catch (error) {
      return { ok: false, reason: 'unreadable', detail: `${ancestor} could not be resolved (${errorCode(error)}).` };
    }
    if (physical.toLowerCase() !== ancestor.toLowerCase()) {
      return { ok: false, reason: 'link-in-path', detail: `${ancestor} leads to ${physical}.` };
    }
  }
  return { ok: true, root };
}

/**
 * Whether an agent that may write `writeRoots` could write into the store, or the store into one of them: either
 * contains the other, as written or physically. A store an agent can write could carry forged records.
 */
export function cliStoreReachableFrom(
  storeRoot: string,
  writeRoots: readonly string[],
  realpath: (file: string) => string = (file) => realpathSync.native(file),
): boolean {
  const physical = (file: string) => {
    try { return realpath(file); } catch { return file; }
  };
  const stores = [storeRoot, physical(storeRoot)];
  for (const root of writeRoots) {
    for (const candidate of [root, physical(root)]) {
      if (stores.some((store) => isPathInsideOrEqual(candidate, store, path.win32) || isPathInsideOrEqual(store, candidate, path.win32))) return true;
    }
  }
  return false;
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message.slice(0, 120) : 'unknown');
}
