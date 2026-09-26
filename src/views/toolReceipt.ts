import * as path from 'path';

export interface RecordedFileResolution {
  ok: boolean;
  path?: string;
  reason?: 'missing' | 'outside-read-roots';
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
): RecordedFileResolution {
  const candidate = path.isAbsolute(recordedPath)
    ? path.resolve(recordedPath)
    : path.resolve(primaryRoot, recordedPath);
  let physicalPath: string;
  try {
    physicalPath = realpath(candidate);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  const allowed = readRoots.some((root) => {
    let physicalRoot: string;
    try {
      physicalRoot = realpath(root);
    } catch {
      physicalRoot = path.resolve(root);
    }
    const relative = path.relative(physicalRoot, physicalPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  return allowed
    ? { ok: true, path: physicalPath }
    : { ok: false, reason: 'outside-read-roots' };
}
