/*---------------------------------------------------------------------------------------------
 *  UnodeAi - virtual document identities for the native diff editor
 *
 *  A recorded checkpoint's "before" content, and a worktree lane's base revision, do not exist as
 *  files on disk. The native diff editor takes two URIs, so each side that has no file gets a URI
 *  on its own scheme and is materialised on demand by a TextDocumentContentProvider.
 *
 *  This module is deliberately free of the `vscode` module so the encoding is unit-testable. A
 *  malformed, truncated, or hand-edited URI must fail closed (undefined) rather than resolve to
 *  some other file's content - these URIs address recorded file contents, so a parser that guesses
 *  is a disclosure bug.
 *--------------------------------------------------------------------------------------------*/

/** Left-hand side of a checkpoint diff: the content recorded before an agent's edit. */
export const CHECKPOINT_SCHEME = 'unode-checkpoint';

/** Left-hand side of a worktree lane diff: the file as it stands on the base branch. */
export const LANE_BASE_SCHEME = 'unode-lane-base';

/** The parts of a virtual URI. The path segment is display only - it gives the diff tab its label
 *  and lets VS Code pick a language for syntax highlighting. Identity lives entirely in the query. */
export interface VirtualDocRef {
  path: string;
  query: string;
}

export type CheckpointSide = 'before' | 'after';

export interface CheckpointRef {
  id: number;
  side: CheckpointSide;
}

export function checkpointRef(checkpoint: { id: number; path: string }, side: CheckpointSide): VirtualDocRef {
  return { path: checkpoint.path, query: `${checkpoint.id}:${side}` };
}

export function parseCheckpointRef(query: string): CheckpointRef | undefined {
  const match = /^(\d{1,15}):(before|after)$/.exec(query);
  if (!match) {
    return undefined;
  }
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? { id, side: match[2] as CheckpointSide } : undefined;
}

export interface LaneBaseRef {
  /** The FULL commit SHA of the base, captured when the diff was opened. */
  baseSha: string;
  file: string;
}

/**
 * The base side is identified by commit, not by branch name.
 *
 * A branch name is a moving target: resolving it at read time means an open tab silently re-points
 * when the base advances, and because VS Code caches virtual documents per URI, reopening the same
 * file could serve the old content under a new base or vice versa — with no honest way to tell.
 * Pinning the SHA makes every tab an immutable snapshot, which is what a diff tab claims to be, and
 * removes the need for a change event on a document that can no longer change.
 */
export function laneBaseRef(ref: LaneBaseRef): VirtualDocRef {
  return { path: ref.file, query: ref.baseSha };
}

export function parseLaneBaseRef(query: string, path: string): LaneBaseRef | undefined {
  // A commit SHA and nothing else. This value is interpolated into `git show <sha>:<file>`, so a
  // permissive parser here would be an argument-injection seam, not merely a lookup miss.
  if (!/^[0-9a-f]{40}$/.test(query) || !path) {
    return undefined;
  }
  const file = path.replace(/^\/+/, '');
  return file ? { baseSha: query, file } : undefined;
}

/** Short form for display only — never for lookup. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Diff tab label. The editor shows `<left> ↔ <right>`; this is the whole title, so it names the
 *  file once and then says which two versions are being compared. */
export function checkpointDiffTitle(filePath: string, agentName: string, rightIsLiveFile: boolean): string {
  const name = filePath.split('/').pop() || filePath;
  return rightIsLiveFile
    ? `${name} — before ${agentName}'s edit ↔ current file`
    : `${name} — before ${agentName}'s edit ↔ after`;
}

export function laneDiffTitle(filePath: string, agentName: string, baseSha: string): string {
  const name = filePath.split('/').pop() || filePath;
  // The base commit is named in the title because the tab outlives the branch position it was
  // opened against: "base" alone would become a claim the tab cannot keep.
  return `${name} — base ${shortSha(baseSha)} ↔ ${agentName}'s lane`;
}
