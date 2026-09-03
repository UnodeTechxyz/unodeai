import { existsSync, realpathSync } from 'node:fs';
import * as path from 'path';
import { FolderGrant, FolderPermission, TaskWorkspaceAccess } from '../types';

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
  writeRoots: string[];
  readRoots: string[];
  primaryRoot: string;
  restricted: boolean;
  issues: FolderAccessIssue[];
}

/** Workspace Trust is a hard ceiling: an untrusted workspace never receives writable roots. */
export function writeRootsForTrust(writeRoots: readonly string[], isTrusted: boolean): string[] {
  return isTrusted ? [...writeRoots] : [];
}

/**
 * The one-way task-scope ratchet: retain only roots both the permanent agent configuration and
 * this assignment allow. Keeping the more-specific overlap makes a task scope a ceiling, never a
 * replacement grant. `undefined` means the requested scope has no readable intersection at all.
 */
export function intersectTaskWorkspaceAccess(
  configured: Pick<EffectiveRoots, 'readRoots' | 'writeRoots'>,
  requested: Pick<EffectiveRoots, 'readRoots' | 'writeRoots'>,
  isTrusted: boolean,
  pathBase: string,
): TaskWorkspaceAccess | undefined {
  const readRoots = intersectFolderRoots(configured.readRoots, requested.readRoots);
  const writeRoots = writeRootsForTrust(
    intersectFolderRoots(configured.writeRoots, requested.writeRoots),
    isTrusted,
  );
  if (readRoots.length === 0) {
    return undefined;
  }
  const resolvedPathBase = path.resolve(pathBase);
  return {
    pathBase: resolvedPathBase,
    commandCwd: writeRoots[0] ?? resolvedPathBase,
    readRoots,
    writeRoots,
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
      primaryRoot: fallbackPrimaryRoot,
      restricted: false,
      issues: [],
    };
  }

  const issues: FolderAccessIssue[] = [];
  const byReal = new Map<string, { permission: FolderPermission; paths: string[] }>();
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
    if (!existsSync(abs)) {
      issues.push({ kind: 'missing', path: raw, message: `Folder does not exist: ${raw}` });
      continue;
    }
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      issues.push({ kind: 'missing', path: raw, message: `Folder is not accessible: ${raw}` });
      continue;
    }
    if (!opts.isTrusted && !workspaceRoots.some((root) => isInside(root, real))) {
      issues.push({
        kind: 'untrusted-outside-workspace',
        path: raw,
        message: `Ignored outside-workspace folder in an untrusted workspace: ${raw}`,
      });
      continue;
    }
    const existing = byReal.get(real);
    if (!existing) {
      byReal.set(real, { permission, paths: [raw] });
      continue;
    }
    existing.paths.push(raw);
    if (existing.permission !== permission) {
      existing.permission = 'read';
      issues.push({
        kind: 'duplicate-conflict',
        path: raw,
        message: `Duplicate folder has conflicting permissions; using read-only: ${raw}`,
      });
    }
  }

  const grants = [...byReal.entries()].map(([root, value]) => ({ root, permission: value.permission }));
  const readwriteRoots = grants.filter((grant) => grant.permission === 'readwrite').map((grant) => grant.root);
  for (const grant of grants) {
    if (grant.permission !== 'read') {
      continue;
    }
    const parent = readwriteRoots.find((root) => root !== grant.root && isInside(root, grant.root));
    if (parent) {
      issues.push({
        kind: 'read-inside-readwrite',
        path: grant.root,
        message: `Read-only folder is inside writable folder ${parent}; it is writable in practice: ${grant.root}`,
      });
    }
  }

  const writeRoots = collapseRoots(readwriteRoots);
  const readRoots = collapseRoots([...grants.map((grant) => grant.root), ...writeRoots]);
  return {
    writeRoots,
    readRoots,
    primaryRoot: writeRoots[0] ?? readRoots[0] ?? fallbackPrimaryRoot,
    restricted: true,
    issues,
  };
}

function collapseRoots(roots: string[]): string[] {
  const resolved = [...new Set(roots.map((root) => path.resolve(root)))].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const root of resolved) {
    if (!kept.some((parent) => isInside(parent, root))) {
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
      if (isInside(leftRoot, rightRoot)) {
        roots.add(rightRoot);
      } else if (isInside(rightRoot, leftRoot)) {
        roots.add(leftRoot);
      }
    }
  }
  return [...roots].sort((a, b) => a.length - b.length);
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
