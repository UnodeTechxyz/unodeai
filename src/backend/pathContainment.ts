/*---------------------------------------------------------------------------------------------
 * v0.9.96: whether a path is inside a folder, by whole path segments.
 *
 * `path.relative(root, candidate)` starts with `..` both for a parent (`..\storage`) and for an ordinary child whose
 * name starts with two dots (`..storage`). Only a whole `..` segment leaves the root. On Windows, path.win32
 * compares without case, as Windows does.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

function escapesRoot(relative: string, pathApi: path.PlatformPath): boolean {
  return relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative);
}

/** `candidate` is `root` itself or inside it. */
export function isPathInsideOrEqual(root: string, candidate: string, pathApi: path.PlatformPath = path): boolean {
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  return relative === '' || !escapesRoot(relative, pathApi);
}

/** `candidate` is inside `root`, and is not `root` itself. */
export function isPathStrictlyInside(root: string, candidate: string, pathApi: path.PlatformPath = path): boolean {
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  return relative !== '' && !escapesRoot(relative, pathApi);
}
