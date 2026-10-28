import * as fs from 'fs/promises';
import { constants, realpathSync, type BigIntStats } from 'fs';
import * as path from 'path';
import { isPathInsideOrEqual, isPathStrictlyInside } from './pathContainment';

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
  // Strictly inside, by whole segments: the root is a directory, never a file to restore or diff, and a child named
  // `..cache` is inside it while a real `..` parent and a sibling `repo-cache` are not.
  return isPathStrictlyInside(resolvedRoot, abs)
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
    return isPathStrictlyInside(realRoot, real)
      ? { status: 'resolved', path: real }
      : { status: 'refused', reason: 'scope' };
  } catch (err) {
    if (!isNotFound(err)) {
      return { status: 'failed', reason: 'unreadable' };
    }
  }

  // Nothing resolves at the target, yet a link whose target is gone still holds the name. A write would go
  // through it and create that target wherever the link points, so the ancestor below would not be where the
  // write lands.
  if (await nameIsTaken(lexical.path)) {
    return { status: 'refused', reason: 'scope' };
  }

  // The target does not exist (restoring a file an agent deleted, for one). Its nearest existing
  // ancestor decides: that is the directory the write would actually land in.
  try {
    const ancestor = await nearestExistingAncestor(path.dirname(lexical.path));
    const realAncestor = await fs.realpath(ancestor);
    // The nearest existing ancestor may legitimately be the workspace root when the target's
    // parent directories have not been created yet. The final file must still be strictly inside.
    if (!isPathInsideOrEqual(realRoot, realAncestor)) {
      return { status: 'refused', reason: 'scope' };
    }
    const resolved = path.resolve(realAncestor, path.relative(ancestor, lexical.path));
    return isPathStrictlyInside(realRoot, resolved)
      ? { status: 'resolved', path: resolved }
      : { status: 'refused', reason: 'scope' };
  } catch (err) {
    return { status: 'failed', reason: isNotFound(err) ? 'not-found' : 'unreadable' };
  }
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

/**
 * Whether something holds this name. Asked of a path at which nothing resolves, yes means a link whose target is
 * gone: the name exists and leads nowhere yet. `lstat` reads the name itself and follows nothing. A name that
 * cannot be read counts as taken.
 */
export async function nameIsTaken(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs);
    return true;
  } catch (err) {
    return !isNotFound(err);
  }
}

/**
 * One identity for the file a path leads to, however a call spells it: `./a.txt`, `a.txt` and the absolute path
 * are one file, and so are another case on Windows and a way in through a junction or a short name. It is for
 * telling inside one turn whether two calls addressed the same file; it grants nothing and is never shown.
 *
 * Inside one of `roots` the identity is physical, the path the file tools key their own bookkeeping by: the
 * file's real path, or, for a file that is not there, the real path of what holds it plus the rest. Outside every
 * root it is the lexical path, and the filesystem is not asked: a path the agent may not write is not looked up
 * because an agent named it.
 */
export function fileIdentity(abs: string, roots: readonly string[]): string {
  const lexical = path.resolve(abs);
  const located = roots.some((root) => isPathInsideOrEqual(path.resolve(root), lexical)) ? physicalPath(lexical) : lexical;
  return process.platform === 'win32' ? located.toLowerCase() : located;
}

/**
 * Why a write or delete target names something other than an ordinary file on a Windows host, or undefined. VS Code's
 * runtime opens paths through `\\?\`, which skips Windows' own name rules, so each of these is acted on literally:
 *
 * - a `:` in a segment opens an alternate data stream (`a.txt:hidden`, `README.md::$DATA` is README.md itself,
 *   `.git::$INDEX_ALLOCATION` is the .git folder);
 * - a reserved device name, alone or with an extension (`NUL`, `con.md`, `COM1.log`);
 * - a trailing dot or space, which cmd, PowerShell, Explorer and Git all read as the name without it.
 *
 * The drive or share at the start belongs to the root and is not judged. Every segment is judged as written,
 * before anything trims or normalises it. Other hosts have none of these rules.
 */
export function windowsNameProblem(target: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') {
    return undefined;
  }
  const { root } = path.win32.parse(target);
  for (const segment of target.slice(root.length).split(/[\\/]+/)) {
    if (!segment || segment === '.' || segment === '..') {
      continue;
    }
    if (segment.includes(':')) {
      return `"${segment}" contains ":", which on Windows names an alternate data stream of a file or folder, not a file`;
    }
    if (/[. ]$/.test(segment)) {
      return `"${segment}" ends in a dot or a space, which Windows tools read as a different name`;
    }
    if (WINDOWS_DEVICE_NAME.test(segment.split('.')[0].replace(/ +$/, ''))) {
      return `"${segment}" is a reserved Windows device name`;
    }
  }
  return undefined;
}

// Microsoft's list, superscript digits included, plus the console's own CONIN$ and CONOUT$.
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

export type RegularFileRead =
  | { status: 'read'; bytes: Buffer; physicalPath: string }
  | { status: 'refused'; reason: 'scope' | 'changed' }
  | { status: 'failed'; reason: 'missing' | 'not-regular' | 'unreadable' | 'too-large' };

/** Seams a test uses to change the filesystem between the steps a swap could race. The host passes none. */
export interface RegularFileReadHooks {
  afterResolve?: () => Promise<void>;
  afterRead?: () => Promise<void>;
}

/**
 * Read a regular file below `root` where the filesystem places it, through one handle, at most `maxBytes`.
 *
 * - The target and the root are both resolved to real paths, and the target must lie below the real root by whole
 *   segments (`..cache/x` is below it). A link that leads out is refused as out of scope.
 * - Only a regular file is read; a folder, device or pipe is refused before it is opened.
 * - The resolved path is opened, never the link it was reached through (POSIX also refuses a final link at open),
 *   and the open handle must be the file that was resolved. The size bound holds while reading, so a file that grows
 *   is refused rather than read whole.
 * - After the read, the root and the target are resolved again. The root must be the same folder (real path and
 *   identity) it was at the start, the target the same file (real path and identity), and the target still below
 *   the root as it is now. Re-reaching the same file is not enough: a root re-bound to another folder that links
 *   back to the old file has moved the file out of the root. Any change refuses the read.
 *
 * Residual: without a directory handle to walk from, a folder on the way swapped and swapped back between two of
 * these checks is not seen. No snapshot is taken from what this refuses.
 */
export async function readRegularFileInsideRoot(
  root: string,
  candidate: string,
  maxBytes: number,
  hooks: RegularFileReadHooks = {},
): Promise<RegularFileRead> {
  const lexicalRoot = path.resolve(root);
  const lexical = path.resolve(lexicalRoot, candidate);
  if (!isBelowRoot(lexicalRoot, lexical)) {
    return { status: 'refused', reason: 'scope' };
  }
  let realRoot: string;
  let rootIdentity: BigIntStats;
  let real: string;
  let resolved: BigIntStats;
  try {
    realRoot = await fs.realpath(lexicalRoot);
    rootIdentity = await fs.stat(realRoot, { bigint: true });
  } catch {
    return { status: 'failed', reason: 'unreadable' };
  }
  try {
    real = await fs.realpath(lexical);
  } catch (err) {
    return { status: 'failed', reason: isNotFound(err) ? 'missing' : 'unreadable' };
  }
  if (!isBelowRoot(realRoot, real)) {
    return { status: 'refused', reason: 'scope' };
  }
  try {
    resolved = await fs.stat(real, { bigint: true });
  } catch (err) {
    return { status: 'failed', reason: isNotFound(err) ? 'missing' : 'unreadable' };
  }
  if (!resolved.isFile()) {
    return { status: 'failed', reason: 'not-regular' };
  }
  if (resolved.size > BigInt(maxBytes)) {
    return { status: 'failed', reason: 'too-large' };
  }
  await hooks.afterResolve?.();
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return { status: 'refused', reason: 'changed' }; // it was a file a moment ago
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(opened, resolved)) {
      return { status: 'refused', reason: 'changed' };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) {
        return { status: 'failed', reason: 'too-large' };
      }
    }
    await hooks.afterRead?.();
    try {
      const rootAfter = await fs.realpath(lexicalRoot);
      const rootAfterIdentity = await fs.stat(rootAfter, { bigint: true });
      const realAfter = await fs.realpath(lexical);
      const after = await fs.stat(realAfter, { bigint: true });
      // With both real paths unchanged, the target is still below the root: that was checked before the open.
      if (rootAfter !== realRoot || !sameFile(rootAfterIdentity, rootIdentity) || realAfter !== real || !sameFile(after, opened)) {
        return { status: 'refused', reason: 'changed' };
      }
    } catch {
      return { status: 'refused', reason: 'changed' };
    }
    return { status: 'read', bytes: Buffer.concat(chunks, total), physicalPath: real };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Below `root` by whole segments, and not `root` itself: `..cache` is below it, `..` and `../x` are not. */
function isBelowRoot(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** The real path of `abs`, or of the nearest thing on the way to it that resolves, plus the rest of the way. */
export function physicalPath(abs: string): string {
  let current = abs;
  for (;;) {
    try {
      return path.join(realpathSync.native(current), path.relative(current, abs));
    } catch {
      // Not there, or not readable: what holds it decides.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return abs;
    }
    current = parent;
  }
}
