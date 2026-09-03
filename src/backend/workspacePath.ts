import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Resolve a recorded workspace-relative path against the workspace root, or refuse it.
 *
 * Used at sites that WRITE or OPEN a path which was recorded earlier rather than supplied by the
 * user in the moment — checkpoint restore and checkpoint diff. Those records are re-loaded from a
 * persisted file on the next session, so the fact that the original write was confined does not
 * make the replay safe: the check has to happen again at the site that acts on it.
 *
 * `path.resolve` rather than `path.join`, because `join` treats an absolute second argument as a
 * segment to append on POSIX but `resolve` lets it replace the root — the containment check below
 * is what catches both, and it can only catch what it is given in resolved form.
 *
 * LEXICAL ONLY. This cannot see a symlink or junction, so it is the fast pre-check, never the
 * decision for anything that touches the filesystem. Use `resolveInsideRootPhysical` for that.
 */
export type WorkspacePathResolution =
  | { status: 'resolved'; path: string }
  | { status: 'refused'; reason: 'scope' }
  | { status: 'failed'; reason: 'invalid-target' | 'not-found' | 'unreadable' };

export function resolveInsideRoot(root: string, candidate: string): WorkspacePathResolution {
  if (!candidate) {
    return { status: 'failed', reason: 'invalid-target' };
  }
  const resolvedRoot = path.resolve(root);
  const abs = path.resolve(resolvedRoot, candidate);
  return isStrictlyInside(resolvedRoot, abs)
    ? { status: 'resolved', path: abs }
    : { status: 'refused', reason: 'scope' };
}

/**
 * The same question, asked of the filesystem instead of the string.
 *
 * `linked/target.txt` is lexically inside the workspace even when `linked` is a symlink or a Windows
 * junction pointing anywhere on the machine — and a write follows it. So the target's REAL path (or,
 * when the target does not exist yet, the real path of the nearest existing ancestor) is what has to
 * land inside the workspace's own real path.
 *
 * Returns the resolved physical path, so the caller writes to the location that was validated rather
 * than re-walking the link it was checked through.
 */
export async function resolveInsideRootPhysical(root: string, candidate: string): Promise<WorkspacePathResolution> {
  const lexical = resolveInsideRoot(root, candidate);
  if (lexical.status !== 'resolved') {
    return lexical;
  }
  let realRoot: string;
  try {
    realRoot = await fs.realpath(path.resolve(root));
  } catch {
    return { status: 'failed', reason: 'not-found' }; // no workspace to be inside of
  }

  try {
    const real = await fs.realpath(lexical.path);
    return isStrictlyInside(realRoot, real)
      ? { status: 'resolved', path: real }
      : { status: 'refused', reason: 'scope' };
  } catch (err) {
    if (!isNotFound(err)) {
      return { status: 'failed', reason: 'unreadable' };
    }
  }

  // The target does not exist (restoring a file an agent deleted, for one). Its nearest existing
  // ancestor decides: that is the directory the write would actually land in.
  try {
    const ancestor = await nearestExistingAncestor(path.dirname(lexical.path));
    const realAncestor = await fs.realpath(ancestor);
    if (!isStrictlyInside(realRoot, realAncestor)) {
      return { status: 'refused', reason: 'scope' };
    }
    const resolved = path.resolve(realAncestor, path.relative(ancestor, lexical.path));
    return isStrictlyInside(realRoot, resolved)
      ? { status: 'resolved', path: resolved }
      : { status: 'refused', reason: 'scope' };
  } catch (err) {
    return { status: 'failed', reason: isNotFound(err) ? 'not-found' : 'unreadable' };
  }
}

/** Inside, and not the root itself: the root is a directory, never a file to restore or diff. */
function isStrictlyInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function nearestExistingAncestor(absDir: string): Promise<string> {
  let current = absDir;
  for (;;) {
    try {
      // lstat, not stat: a symlinked directory must be FOUND here so its realpath is what gets
      // checked. stat would follow it silently and hand back the target as if it were the ancestor.
      const stat = await fs.lstat(current);
      if (stat.isDirectory() || stat.isSymbolicLink()) {
        return current;
      }
    } catch (err) {
      if (!isNotFound(err)) {
        throw err;
      }
    }
    const next = path.dirname(current);
    if (next === current) {
      throw new Error(`No existing parent directory for "${absDir}".`);
    }
    current = next;
  }
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}
