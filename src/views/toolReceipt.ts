import * as path from 'path';
import { isPathInsideOrEqual } from '../backend/pathContainment';

export type FileOpenRefusal = 'missing' | 'outside-read-roots' | 'directory' | 'not-regular' | 'unreadable';

export interface RecordedFileResolution {
  ok: boolean;
  path?: string;
  reason?: FileOpenRefusal;
}

/** The filesystem questions the open check asks. Synchronous on purpose: see `resolveFileForOpen`. */
export interface FileOpenFilesystem {
  realpath(candidate: string): string;
  stat?(physicalPath: string): { isFile(): boolean; isDirectory(): boolean };
}

/**
 * Resolve a host-recorded read_file path for a user-initiated editor open. Physical resolution happens
 * before the root comparison, so a symlink cannot turn a receipt into a path outside Folder Access.
 */
export function resolveRecordedFileForOpen(
  recordedPath: string,
  primaryRoot: string,
  readRoots: readonly string[],
  realpath: (candidate: string) => string,
  stat?: FileOpenFilesystem['stat'],
): RecordedFileResolution {
  const candidate = path.isAbsolute(recordedPath)
    ? path.resolve(recordedPath)
    : path.resolve(primaryRoot, recordedPath);
  return resolveFileForOpen(candidate, readRoots, { realpath, stat });
}

/**
 * v0.9.97: the one physical check before a chat surface opens a file in the editor, for a tool receipt and a file
 * link in a reply alike.
 *
 * - The candidate's real path, symlinks and junctions followed, must lie inside a read root's real path by whole
 *   segments: a prefix sibling (`workspace-old`) is outside, and a child named `..name` is inside. A root whose real
 *   path cannot be read is no root.
 * - With `stat`, it must be a regular file; a directory is reported as one.
 *
 * Synchronous, so the caller opens the path it checked with no wait in between. The editor still opens it by name
 * afterwards; a swap on disk in that instant is a residual race this does not claim to close.
 */
export function resolveFileForOpen(
  candidate: string,
  readRoots: readonly string[],
  fs: FileOpenFilesystem,
  pathApi: path.PlatformPath = path,
): RecordedFileResolution {
  const realpath = (target: string) => fs.realpath(target);
  let physicalPath: string;
  try {
    physicalPath = realpath(candidate);
  } catch (error) {
    return { ok: false, reason: deniedError(error) ? 'unreadable' : 'missing' };
  }
  // Authority is a physical identity: a read root whose real path cannot be read now grants nothing.
  const allowed = readRoots.some((root) => {
    let physicalRoot: string;
    try {
      physicalRoot = realpath(root);
    } catch {
      return false;
    }
    return isPathInsideOrEqual(physicalRoot, physicalPath, pathApi);
  });
  if (!allowed) {
    return { ok: false, reason: 'outside-read-roots' };
  }
  if (fs.stat) {
    let stats: { isFile(): boolean; isDirectory(): boolean };
    try {
      stats = fs.stat(physicalPath);
    } catch (error) {
      return { ok: false, reason: deniedError(error) ? 'unreadable' : 'missing' };
    }
    if (stats.isDirectory()) {
      return { ok: false, reason: 'directory' };
    }
    if (!stats.isFile()) {
      return { ok: false, reason: 'not-regular' };
    }
  }
  return { ok: true, path: physicalPath };
}

function deniedError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM';
}
