import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { isPathInsideOrEqual } from '../backend/pathContainment';

/** At most this many paths of one message are offered: a pasted log is not a list of requests. */
export const MAX_NAMED_OUTSIDE_PATHS = 8;
/** An unquoted path is read across at most this many spaces: a name rarely holds more. */
const MAX_WORDS = 12;

const QUOTED = /["'`<]((?:[A-Za-z]:[\\/]|\\\\|\/)[^"'`<>\r\n]*)["'`>]/g;
const WINDOWS_START = /(?<![\w\\/])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])/g;
/**
 * A path whose first use reaches a computer the words choose. On Windows, a share or device (`\\server\share`,
 * `\\?\UNC\...`, `\\.\pipe\...`): checking one opens SMB to that server, with the person's credentials, and blocks the
 * extension host until it gives up (21 s for an address that does not answer). On macOS, `/net/<host>/...`, which the
 * automounter mounts from that host on first use (any case: the volume usually ignores it). A message can be pasted from
 * anywhere, so such a path is never checked and never offered from the words; a refused file tool still offers it. It
 * is tested once resolved, as it would be used, so `/tmp/../net/host` and `//server/share` are caught (audit of
 * 362e990b). Mapped drive letters were set up by the person and are read.
 */
const NETWORK_SPELLING = /^(?:[\\/]{2}|\/net(?:\/|$))/i;

/**
 * v0.9.101 (A1): the same rule for a path a task contract names. `resolved` is the path as the host resolved it. Such a
 * path gets no metadata or other disk check until a grant or Full access already covers it by its spelling.
 */
export function reachesAnotherComputer(resolved: string): boolean {
  return NETWORK_SPELLING.test(resolved);
}

/** `\\?\C:\...` (or `\\.\C:\...`) names a drive of this computer in Windows' extended spelling: no share, no device. */
const LOCAL_DRIVE = /^[\\/]{2}[?.][\\/][A-Za-z]:(?:[\\/]|$)/;

/**
 * v0.9.101 (E2): `reachesAnotherComputer` for a path a file tool acts on. Node and VS Code spell a local drive in the
 * extended form (`path.toNamespacedPath`), and a tool given one reads that drive as before.
 */
export function fileToolReachesAnotherComputer(resolved: string): boolean {
  return reachesAnotherComputer(resolved) && !LOCAL_DRIVE.test(resolved);
}

/** `\\?\UNC\server\share\x` and `\\.\UNC\server\share\x` name the share `\\server\share\x` does. */
const shareForm = (target: string): string => target.replace(/^[\\/]{2}[?.][\\/]UNC[\\/]/i, '\\\\');

/**
 * v0.9.101 (E2, named by the Owner 2026-11-03): whether authority already held names `target`, a path
 * `reachesAnotherComputer` judges, by its spelling alone: one of `folders` holds it, or one of `files` is it. Nothing is
 * resolved or checked on disk, so a share nothing names is refused before anything opens SMB to that server, and one a
 * root, Folder Access entry or grant names keeps its real resolution. Paths are read by `host`'s rules.
 */
export function heldBySpelling(
  target: string, folders: readonly string[], files: readonly string[], host: path.PlatformPath = path,
): boolean {
  const named = shareForm(host.resolve(target));
  return folders.some((folder) => isPathInsideOrEqual(shareForm(host.resolve(folder)), named, host))
    || files.some((file) => host.relative(shareForm(host.resolve(file)), named) === '');
}
const POSIX_START = /(?<![\w\\/:.])\/[^\s"'`<>|*?(){}[\]/]+\//g;
const STOP = /["'`<>|*?(){}[\]]/;

/**
 * v0.9.100 (field, 4523a765): the absolute paths a person's own message names, outside every one of `roots`: quoted
 * ones first (they may hold spaces), then the others, each once. A request to read an outside contract and save a
 * summary beside the workspace got its Grant access notice only when a file tool was refused: never when the teammate
 * gave up without trying, and only after minutes of work when the coordinator's save was the first call. A path the
 * person typed is what they asked for, so it is offered when the request starts. Paths are read by the host's own
 * rules: a Windows spelling on another host names nothing.
 *
 * An unquoted path ends at no fixed character: `C:\Users\Jane Doe\out\report.docx and the rest` (audit of aaf794a2).
 * It is read across spaces, and the longest reading that exists, or whose folder exists and whose last name is a file
 * name with an extension (a file still to be made), is the one named, unless the words could name another path too
 * (see below). Then nothing is offered: a wrong folder offered as the one the person named is worse than none, and a
 * refused file tool still offers the real one.
 */
export function namedOutsidePaths(
  text: string,
  roots: readonly string[],
  host: path.PlatformPath = path,
  exists: (target: string) => boolean = existsSync,
): string[] {
  const windows = host.sep === '\\';
  const same = (left: string, right: string) => (windows ? left.toLowerCase() === right.toLowerCase() : left === right);
  const found: string[] = [];
  const accept = (raw: string): string | undefined => {
    const trimmed = raw.trim().replace(/[.,;:!?)\]}>'"`]+$/, '');
    if (!trimmed || !host.isAbsolute(trimmed) || (windows && !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(trimmed))) return undefined;
    const resolved = host.resolve(trimmed);
    return host.parse(resolved).root === resolved || NETWORK_SPELLING.test(resolved) ? undefined : resolved;
  };
  const add = (resolved: string | undefined) => {
    if (!resolved || roots.some((root) => isPathInsideOrEqual(root, resolved, host))) return;
    if (!found.some((other) => same(other, resolved))) found.push(resolved);
  };
  const quoted: string[] = [];
  for (const match of text.matchAll(QUOTED)) { add(accept(match[1])); quoted.push(match[1]); }
  const unquoted = quoted.reduce((rest, inner) => rest.split(inner).join(' '), text);
  for (const match of unquoted.matchAll(windows ? WINDOWS_START : POSIX_START)) {
    const line = unquoted.slice(match.index).split(/\r?\n/, 1)[0];
    const stop = line.search(STOP);
    const words = (stop < 0 ? line : line.slice(0, stop)).split(/(?<=\S)(?=\s)/).slice(0, MAX_WORDS);
    const readings: string[] = [];
    for (let count = 1; count <= words.length; count++) {
      const reading = accept(words.slice(0, count).join(''));
      if (reading && !readings.some((other) => same(other, reading))) readings.push(reading);
    }
    // A file still to be made is a name with an extension in a folder that exists; its name may hold spaces.
    const valid = readings.filter((reading) => exists(reading)
      || (/^\S(?:.*\S)?\.[^\s.]+$/.test(host.basename(reading)) && exists(host.dirname(reading))));
    const chosen = valid.at(-1);
    // Nothing is offered when the words could name two paths (audit of 5b4180ec):
    // - a longer reading lies in another folder that exists, so the path goes on past the space the choice stopped
    //   at: `C:\Users\Jane` beside `C:\Users\Jane Doe\new folder`;
    // - a shorter valid reading lies in the deepest folder the choice is known to have, so nothing on disk tells them
    //   apart: `C:\Out\Lease`, a folder, beside `C:\Out\Lease Agreement.docx`, a file still to be made.
    const continues = chosen !== undefined && readings.slice(readings.indexOf(chosen) + 1).some((longer) => {
      const folder = host.dirname(longer);
      return exists(folder) && !isPathInsideOrEqual(folder, chosen, host);
    });
    const known = chosen !== undefined && (exists(chosen) ? chosen : host.dirname(chosen));
    const rivalled = chosen !== undefined && valid.slice(0, -1).some((shorter) =>
      !isPathInsideOrEqual(shorter, chosen, host) && isPathInsideOrEqual(known as string, shorter, host));
    if (!continues && !rivalled) add(chosen);
  }
  return found.slice(0, MAX_NAMED_OUTSIDE_PATHS);
}
