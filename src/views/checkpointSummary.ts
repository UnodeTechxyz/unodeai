import { Checkpoint, checkpointRestoreDisabledMessage, checkpointTargetKey } from '../backend/Checkpoints';

export interface ChangedFileSummary {
  path: string;
  checkpointId: number;
  ts: number;
  /** Undefined only when the checkpoint has a safe, retained before-state. */
  restoreDisabledReason?: string;
}

const MAX_FILES_PER_AGENT = 8;

export function groupChangedFilesByAgent(checkpoints: Checkpoint[]): Map<string, ChangedFileSummary[]> {
  const grouped = new Map<string, ChangedFileSummary[]>();
  const seenPathsByAgent = new Map<string, Set<string>>();

  const newestFirst = [...checkpoints].sort((a, b) => (b.ts - a.ts) || (b.id - a.id));

  for (const checkpoint of newestFirst) {
    const existing = grouped.get(checkpoint.agentId) ?? [];
    if (existing.length >= MAX_FILES_PER_AGENT) {
      continue;
    }

    let seenPaths = seenPathsByAgent.get(checkpoint.agentId);
    if (!seenPaths) {
      seenPaths = new Set<string>();
      seenPathsByAgent.set(checkpoint.agentId, seenPaths);
    }
    // One row per file. Two folders can hold the same relative path, so a row is keyed by the file the change was
    // recorded for; only a record that names none (written before v0.9.97) falls back to its display path.
    const key = checkpointTargetKey(checkpoint) ?? `path:${checkpoint.path}`;
    if (seenPaths.has(key)) {
      continue;
    }

    seenPaths.add(key);
    const restoreDisabledReason = checkpointRestoreDisabledMessage(checkpoint);
    existing.push({
      path: checkpoint.path,
      checkpointId: checkpoint.id,
      ts: checkpoint.ts,
      ...(restoreDisabledReason ? { restoreDisabledReason } : {}),
    });
    grouped.set(checkpoint.agentId, existing);
  }

  return grouped;
}

/**
 * The checkpoint to restore when the user clicks ⟲ on a changed-files row.
 *
 * The rail shows ONE row per file — its newest checkpoint — so the row means "this file", not "this
 * keystroke". Restoring the newest checkpoint undoes only the agent's last edit and leaves every earlier
 * one in place, which reads to the user as the restore having done nothing at all. The row's promise is
 * "put this file back", so the target is the agent's EARLIEST retained edit of it.
 *
 * Returns the target plus how many of that agent's edits it rolls back. The confirmation itself names every
 * recorded edit the restore undoes, other agents' included (checkpointRestorePlan).
 *
 * "That file" is the file the change was recorded for, not its relative path, which another folder can share. A
 * change already restored, or one whose original contents were not kept, is never a target.
 */
export function restoreTargetForRow(
  checkpoints: readonly Checkpoint[],
  row: Checkpoint,
): { target: Checkpoint; edits: number } {
  const key = checkpointTargetKey(row);
  const sameFile = checkpoints
    .filter((c) => c.agentId === row.agentId && key !== undefined && checkpointTargetKey(c) === key
      && checkpointRestoreDisabledMessage(c) === undefined)
    .sort((a, b) => (a.ts - b.ts) || (a.id - b.id));
  return { target: sameFile[0] ?? row, edits: Math.max(sameFile.length, 1) };
}
