/*---------------------------------------------------------------------------------------------
 *  UnodeAi - required outputs a command wrote (v0.9.103, field smoke of d71485c5; the Owner: fix)
 *
 *  A task's required output is "written" when a file tool the host records wrote it. A file a command made (a script,
 *  a build, a conversion) was never recorded, so the result said the output was not written while it was there. At
 *  dispatch the host notes each required output's place on disk; at settlement an output no file tool wrote, but that
 *  was created or changed there since, as the kind the contract names, is observed on disk. That is all it says: who
 *  wrote it is not recorded.
 *
 *  Codex's audit of 04be3005: a place is looked at only where the teammate may write it now, by the host's own judgement
 *  of its authority (`writable`), at dispatch and again at settlement. Naming an output grants nothing, so an output
 *  outside that authority is never looked at or reported. A place that reaches another computer (a share, a device,
 *  /net) is never looked at either. A folder never stands for a required file, nor a file for a required folder.
 *  Codex's audit of 2b57dbe4: a place the teammate may write only later (a grant during the task) is kept unlooked;
 *  at settlement it counts when it is now the right kind and was modified at or after dispatch.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { reachesAnotherComputer } from '../host/namedOutsidePaths';

export type OutputKind = 'file' | 'directory';

/**
 * A file's modified time comes from a coarser clock than `Date.now()` (Windows file times step about every 16 ms; FAT
 * keeps 2 s), so a file written just after dispatch can carry a time a little before it. A file modified more than this
 * before dispatch is not counted as made during the task.
 */
export const MTIME_TOLERANCE_MS = 2_000;

/** What one place held when the task was dispatched. */
export interface OutputDiskMark {
  exists: boolean;
  kind?: OutputKind | 'other';
  mtimeMs?: number;
  size?: number;
}

/** One required output's kind, its places (the contract's folder, and the teammate's own when it differs) and marks. */
export interface RequiredOutputMarks {
  outputId: string;
  kind: OutputKind;
  /** When the task was dispatched (epoch ms): the time a place first looked at only at settlement is judged by. */
  since: number;
  /** `before` is absent for a place the teammate could not write at dispatch: it was not looked at then. */
  places: Array<{ path: string; before?: OutputDiskMark }>;
}

export type StatPlace = (place: string) => OutputDiskMark;
/** Whether the teammate may write `place` now, by the host's own authority judgement. Nothing is looked at otherwise. */
export type MayLookAt = (place: string) => boolean;

/** The host's own look at a local place: whether it exists, what it is, and its modified time and size. */
export const statPlace: StatPlace = (place) => {
  const stat = fs.statSync(place, { throwIfNoEntry: false });
  if (!stat) return { exists: false };
  return { exists: true, kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other', mtimeMs: stat.mtimeMs, size: stat.size };
};

/**
 * The absolute places a required output names: resolved under the contract's folder, and under the teammate's own
 * when that differs, as `requiredOutputsNotWritten` reads the output. Places on another computer are left out.
 */
export function requiredOutputPlaces(outputPath: string, bases: { contract?: string; changes?: string } | undefined): string[] {
  const api = /^[a-z]:[\\/]|^[\\/]{2}/i.test(outputPath) ? path.win32 : path;
  const places = api.isAbsolute(outputPath)
    ? [api.resolve(outputPath)]
    : [bases?.contract, bases?.changes].filter((base): base is string => !!base).map((base) => api.resolve(base, outputPath));
  return [...new Set(places)].filter((place) => !reachesAnotherComputer(place));
}

/**
 * At dispatch: each required output's places, and what those the teammate may write held. A place outside that
 * authority is kept without being looked at; one whose look fails is left out.
 */
export function markRequiredOutputs(
  outputs: ReadonlyArray<{ outputId: string; path: string; kind: OutputKind; required: boolean }> | undefined,
  bases: { contract?: string; changes?: string } | undefined,
  mayLookAt: MayLookAt,
  stat: StatPlace = statPlace,
  since: number = Date.now(),
): RequiredOutputMarks[] {
  const marks: RequiredOutputMarks[] = [];
  for (const output of outputs ?? []) {
    if (!output.required) continue;
    const places: RequiredOutputMarks['places'] = [];
    for (const place of requiredOutputPlaces(output.path, bases)) {
      if (!safely(() => mayLookAt(place), false)) { places.push({ path: place }); continue; }
      try { places.push({ path: place, before: stat(place) }); } catch { /* not looked at, never judged */ }
    }
    if (places.length > 0) marks.push({ outputId: output.outputId, kind: output.kind, since, places });
  }
  return marks;
}

/**
 * At settlement: of `outputIds` (required outputs no file tool wrote), those that exist now at one of their places as
 * the kind the contract names, and were created or changed there since dispatch, with that place. A place the teammate
 * may no longer write is not looked at again.
 */
export function outputsObservedOnDisk(
  marks: readonly RequiredOutputMarks[] | undefined,
  outputIds: readonly string[],
  mayLookAt: MayLookAt,
  stat: StatPlace = statPlace,
): Array<{ outputId: string; path: string }> {
  const observed: Array<{ outputId: string; path: string }> = [];
  for (const mark of marks ?? []) {
    if (!outputIds.includes(mark.outputId)) continue;
    for (const place of mark.places) {
      if (!safely(() => mayLookAt(place.path), false)) continue;
      let now: OutputDiskMark;
      try { now = stat(place.path); } catch { continue; }
      const before = place.before;
      const changed = before
        ? !before.exists || now.mtimeMs !== before.mtimeMs || now.size !== before.size || now.kind !== before.kind
        : typeof now.mtimeMs === 'number' && now.mtimeMs >= mark.since - MTIME_TOLERANCE_MS;
      if (now.exists && now.kind === mark.kind && changed) {
        observed.push({ outputId: mark.outputId, path: place.path });
        break;
      }
    }
  }
  return observed;
}

function safely<T>(run: () => T, fallback: T): T {
  try { return run(); } catch { return fallback; }
}
