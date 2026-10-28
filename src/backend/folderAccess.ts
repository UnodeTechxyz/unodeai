import { existsSync, lstatSync, realpathSync } from 'node:fs';
import * as path from 'path';
import { FolderGrant, FolderPermission, ResolvedFileGrant, ResolvedPathGrant, TaskWorkspaceAccess } from '../types';
import { isPathInsideOrEqual } from './pathContainment';

export type FolderAccessIssueKind =
  | 'missing'
  | 'untrusted-outside-workspace'
  | 'duplicate-conflict'
  | 'read-inside-readwrite';

export interface FolderAccessIssue {
  kind: FolderAccessIssueKind;
  path: string;
  message: string;
}

export interface EffectiveRoots {
  /** Directories only. A grant that names a file is never a root: it is listed in `readFiles`. */
  writeRoots: string[];
  readRoots: string[];
  /**
   * Exact-file grants beside those directories. `readFiles` lists every one of them, `writeFiles` the writable
   * ones. A file inside a directory that already gives it the same authority is not listed: the directory holds it.
   */
  writeFiles: ResolvedFileGrant[];
  readFiles: ResolvedFileGrant[];
  /** The agent's working directory. Never a file. */
  primaryRoot: string;
  restricted: boolean;
  issues: FolderAccessIssue[];
}

/** Resolved Folder Access as authority alone: the form in which a task scope and the ceiling it narrows are intersected. */
export type ResolvedWorkspaceScope = Pick<EffectiveRoots, 'readRoots' | 'writeRoots' | 'readFiles' | 'writeFiles'>;

/** Workspace Trust is a hard ceiling: an untrusted workspace never receives writable roots or writable files. */
export function writeRootsForTrust<T>(writeRoots: readonly T[], isTrusted: boolean): T[] {
  return isTrusted ? [...writeRoots] : [];
}

/**
 * The one-way task-scope ratchet: retain only what both the permanent agent configuration and this assignment
 * allow. Keeping the more-specific overlap makes a task scope a ceiling, never a replacement grant. A file one
 * side names stays that exact file, whatever directory of the other side holds it. `undefined` means the
 * requested scope has no readable intersection at all.
 */
export function intersectTaskWorkspaceAccess(
  configured: ResolvedWorkspaceScope,
  requested: ResolvedWorkspaceScope,
  isTrusted: boolean,
  pathBase: string,
): TaskWorkspaceAccess | undefined {
  const readRoots = intersectFolderRoots(configured.readRoots, requested.readRoots);
  const writeRoots = writeRootsForTrust(
    intersectFolderRoots(configured.writeRoots, requested.writeRoots),
    isTrusted,
  );
  const { readFiles, writeFiles } = exactFileGrants(
    readRoots,
    writeRoots,
    intersectFileGrants(configured.readRoots, configured.readFiles, requested.readRoots, requested.readFiles),
    writeRootsForTrust(
      intersectFileGrants(configured.writeRoots, configured.writeFiles, requested.writeRoots, requested.writeFiles),
      isTrusted,
    ),
  );
  if (readRoots.length === 0 && readFiles.length === 0) {
    return undefined;
  }
  return {
    pathBase: path.resolve(pathBase),
    // A command runs in a writable directory of the scope. Without one there is no working directory at all:
    // a file cannot be one, and the path base is not an authority root.
    ...(writeRoots.length > 0 ? { commandCwd: writeRoots[0] } : {}),
    readRoots,
    writeRoots,
    readFiles,
    writeFiles,
  };
}

export function resolveEffectiveRoots(opts: {
  grants: readonly FolderGrant[] | undefined;
  fallbackPrimaryRoot: string;
  fallbackReadRoots: readonly string[];
  workspaceRoots: readonly string[];
  isTrusted: boolean;
}): EffectiveRoots {
  const fallbackPrimaryRoot = path.resolve(opts.fallbackPrimaryRoot);
  const fallbackReadRoots = opts.fallbackReadRoots.map((root) => path.resolve(root));
  if (!opts.grants || opts.grants.length === 0) {
    return {
      writeRoots: [fallbackPrimaryRoot],
      readRoots: collapseRoots([fallbackPrimaryRoot, ...fallbackReadRoots]),
      writeFiles: [],
      readFiles: [],
      primaryRoot: fallbackPrimaryRoot,
      restricted: false,
      issues: [],
    };
  }

  const issues: FolderAccessIssue[] = [];
  const byReal = new Map<string, ResolvedPathGrant>();
  const workspaceRoots = opts.workspaceRoots.map((root) => {
    const resolved = path.resolve(root);
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  });

  for (const grant of opts.grants) {
    const raw = String(grant.path ?? '').trim();
    const permission = grant.permission;
    if (!raw || (permission !== 'read' && permission !== 'readwrite')) {
      continue;
    }
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(fallbackPrimaryRoot, raw);
    // Whether the path names a folder or a file is not known until it resolves, so a missing one is called neither.
    if (!existsSync(abs)) {
      issues.push({ kind: 'missing', path: raw, message: `Path does not exist: ${raw}` });
      continue;
    }
    let resolved: ResolvedPathGrant;
    try {
      resolved = resolvePathGrant(abs, permission);
    } catch {
      issues.push({ kind: 'missing', path: raw, message: `Path is not accessible: ${raw}` });
      continue;
    }
    if (!opts.isTrusted && !workspaceRoots.some((root) => isPathInsideOrEqual(root, resolved.realPath))) {
      issues.push({
        kind: 'untrusted-outside-workspace',
        path: raw,
        message: `Ignored outside-workspace ${nounOf(resolved)} in an untrusted workspace: ${raw}`,
      });
      continue;
    }
    const existing = byReal.get(resolved.realPath);
    if (!existing) {
      byReal.set(resolved.realPath, resolved);
      continue;
    }
    if (existing.permission !== permission) {
      existing.permission = 'read';
      issues.push({
        kind: 'duplicate-conflict',
        path: raw,
        message: `Duplicate ${nounOf(resolved)} has conflicting permissions; using read-only: ${raw}`,
      });
    }
  }

  const grants = [...byReal.values()];
  const directories = grants.filter((grant) => grant.kind === 'directory');
  const readwriteRoots = directories.filter((grant) => grant.permission === 'readwrite').map((grant) => grant.realPath);
  for (const grant of grants) {
    if (grant.permission !== 'read') {
      continue;
    }
    // Whole path segments, as the grants themselves are decided: a read-only `..name` folder inside a writable one is
    // reported, and a sibling whose name only starts like the writable folder is not.
    const parent = readwriteRoots.find((root) => root !== grant.realPath && isPathInsideOrEqual(root, grant.realPath));
    if (parent) {
      issues.push({
        kind: 'read-inside-readwrite',
        path: grant.realPath,
        message: `Read-only ${nounOf(grant)} is inside writable folder ${parent}; it is writable in practice: ${grant.realPath}`,
      });
    }
  }

  // Collapsing is for directories alone: a file is never a root, so it neither absorbs a path nor becomes one.
  const writeRoots = collapseRoots(readwriteRoots);
  const readRoots = collapseRoots([...directories.map((grant) => grant.realPath), ...writeRoots]);
  const files = grants.filter(isFileGrant);
  return {
    writeRoots,
    readRoots,
    ...exactFileGrants(readRoots, writeRoots, files, files.filter((grant) => grant.permission === 'readwrite')),
    primaryRoot: writeRoots[0] ?? readRoots[0] ?? fallbackPrimaryRoot,
    restricted: true,
    issues,
  };
}

/**
 * Where an exact-file grant stands now, measured the way it was admitted.
 * `present`: its path still leads to the admitted file.
 * `absent`: nothing is at its path and the directory that held it is the admitted one, so it can be written again there.
 * `changed`: a link on the way leads elsewhere now, or something else took the place of the file.
 */
export function exactFileGrantState(grant: ResolvedFileGrant): 'present' | 'absent' | 'changed' {
  let real: string | undefined;
  try {
    real = realpathSync(grant.lexicalPath);
  } catch {
    real = undefined;
  }
  if (real !== undefined) {
    return samePath(real, grant.realPath) ? 'present' : 'changed';
  }
  // A link whose target is gone still holds the name, and a write through it would create that target.
  if (nameIsTaken(grant.lexicalPath)) {
    return 'changed';
  }
  try {
    return samePath(realpathSync(path.dirname(grant.lexicalPath)), grant.realParent) ? 'absent' : 'changed';
  } catch {
    return 'changed';
  }
}

/** One location, spelled as the platform compares paths. Never containment: a path beside, above or below is another path. */
export function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === '';
}

/** Every path the roots make readable, for a check that asks only whether one known physical file is covered. */
export function readablePathCeilings(roots: Pick<EffectiveRoots, 'readRoots' | 'readFiles'>): string[] {
  return [...roots.readRoots, ...roots.readFiles.map((file) => file.realPath)];
}

/**
 * What exact-file grants come to for an agent that is confined by folders alone. Its own tools reach everything
 * in its working directory, so a file can be neither that directory nor one of its roots: the grants are not
 * given to it. With no folder granted at all there is nowhere for it to run, and it must not start in a folder
 * its Folder Access never named.
 */
export function exactFileGrantsOnFolderRoute(
  roots: Pick<EffectiveRoots, 'readRoots' | 'readFiles'>,
): { ignored: string[]; refused: boolean } {
  const ignored = roots.readFiles.map((file) => file.lexicalPath);
  return { ignored, refused: ignored.length > 0 && roots.readRoots.length === 0 };
}

/** Resolved once, when the grant is admitted: the physical target, and what kind of thing it is. */
function resolvePathGrant(lexicalPath: string, permission: FolderPermission): ResolvedPathGrant {
  const realPath = realpathSync(lexicalPath);
  return {
    kind: lstatSync(realPath).isDirectory() ? 'directory' : 'file',
    permission,
    lexicalPath,
    realPath,
    realParent: realpathSync(path.dirname(lexicalPath)),
  };
}

function isFileGrant(grant: ResolvedPathGrant): grant is ResolvedFileGrant {
  return grant.kind === 'file';
}

function nounOf(grant: ResolvedPathGrant): 'file' | 'folder' {
  return grant.kind === 'file' ? 'file' : 'folder';
}

function nameIsTaken(lexicalPath: string): boolean {
  try {
    lstatSync(lexicalPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * The exact-file grants a scope keeps beside its directory roots, each physical file once. A file inside a root
 * that already gives it the same authority adds nothing and is left to that root, as a nested directory is. A
 * writable file inside a root that is only readable stays: the directory does not make it writable. The permission
 * each grant carries is the one this scope gives it.
 */
function exactFileGrants(
  readRoots: readonly string[],
  writeRoots: readonly string[],
  readable: readonly ResolvedFileGrant[],
  writable: readonly ResolvedFileGrant[],
): Pick<EffectiveRoots, 'readFiles' | 'writeFiles'> {
  const writeFiles = uniqueFiles(writable)
    .filter((file) => !writeRoots.some((root) => isPathInsideOrEqual(root, file.realPath)))
    .map((file): ResolvedFileGrant => ({ ...file, permission: 'readwrite' }));
  const readOnlyFiles = uniqueFiles(readable)
    .filter((file) => !writeFiles.some((other) => samePath(other.realPath, file.realPath)))
    .filter((file) => !readRoots.some((root) => isPathInsideOrEqual(root, file.realPath)))
    .map((file): ResolvedFileGrant => ({ ...file, permission: 'read' }));
  return { readFiles: [...writeFiles, ...readOnlyFiles], writeFiles };
}

function uniqueFiles(files: readonly ResolvedFileGrant[]): ResolvedFileGrant[] {
  const kept: ResolvedFileGrant[] = [];
  for (const file of files) {
    if (!kept.some((other) => samePath(other.realPath, file.realPath))) {
      kept.push(file);
    }
  }
  return kept;
}

/**
 * The exact files both sides allow. A file the request names inside a configured directory stays that file, and so
 * does a configured file inside a requested directory: a file never widens to the directory around it. A file both
 * name is that file. Any other pairing shares nothing. The request's own spelling comes first, because it is the
 * path the task was given.
 */
function intersectFileGrants(
  configuredRoots: readonly string[],
  configuredFiles: readonly ResolvedFileGrant[],
  requestedRoots: readonly string[],
  requestedFiles: readonly ResolvedFileGrant[],
): ResolvedFileGrant[] {
  return [
    ...requestedFiles.filter((file) =>
      configuredRoots.some((root) => isPathInsideOrEqual(path.resolve(root), file.realPath))
      || configuredFiles.some((other) => samePath(other.realPath, file.realPath))),
    ...configuredFiles.filter((file) => requestedRoots.some((root) => isPathInsideOrEqual(path.resolve(root), file.realPath))),
  ];
}

function collapseRoots(roots: string[]): string[] {
  const resolved = [...new Set(roots.map((root) => path.resolve(root)))].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const root of resolved) {
    if (!kept.some((parent) => isPathInsideOrEqual(parent, root))) {
      kept.push(root);
    }
  }
  return kept;
}

function intersectFolderRoots(left: readonly string[], right: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const leftRaw of left) {
    for (const rightRaw of right) {
      const leftRoot = path.resolve(leftRaw);
      const rightRoot = path.resolve(rightRaw);
      if (isPathInsideOrEqual(leftRoot, rightRoot)) {
        roots.add(rightRoot);
      } else if (isPathInsideOrEqual(rightRoot, leftRoot)) {
        roots.add(leftRoot);
      }
    }
  }
  return [...roots].sort((a, b) => a.length - b.length);
}
