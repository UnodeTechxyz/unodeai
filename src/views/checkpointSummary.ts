import { Checkpoint, checkpointRestoreDisabledMessage } from '../backend/Checkpoints';

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
    if (seenPaths.has(checkpoint.path)) {
      continue;
    }

    seenPaths.add(checkpoint.path);
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
 * Returns the target plus how many of that agent's edits it rolls back, so the confirmation can say so
 * rather than claiming to undo "the edit" when it is undoing four.
 */
export function restoreTargetForRow(
  checkpoints: readonly Checkpoint[],
  row: Checkpoint,
): { target: Checkpoint; edits: number } {
  const sameFile = checkpoints
    .filter((c) => c.agentId === row.agentId && c.path === row.path && !c.truncated && !c.restoreDisabledReason)
    .sort((a, b) => (a.ts - b.ts) || (a.id - b.id));
  return { target: sameFile[0] ?? row, edits: Math.max(sameFile.length, 1) };
}
