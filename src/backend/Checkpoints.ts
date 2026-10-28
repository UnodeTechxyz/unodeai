/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Checkpoints  (V1: per-write snapshot + restore — the v0.4 "trust" core)
 *  Every file-mutating tool use already produces before/after content (WorkspaceTools sets
 *  oldContent/newContent on its run result, used today to render the chat diff). We tap that here:
 *  each successful write records a Checkpoint holding the file's content BEFORE the edit, so the user
 *  can one-click restore a file to any earlier point — no shadow-git needed.
 *
 *  The store is pure/dependency-free (in-memory + a serialize/restore round-trip for persistence) so
 *  it's unit-testable without vscode. The extension injects the recorder into WorkspaceTools, persists
 *  the serialized state, and applies a restore through CheckpointRestore, which judges it as a new write.
 *
 *  A record's `before` and `after` are decoded text, not the file's bytes. When the host kept the file's exact bytes
 *  before a change, as a raw-byte restore point of RawCheckpointStore, the record names it (`raw`): a restore then
 *  puts those bytes back, and the text is only what the diff shows. A record without `raw` is a text restore point
 *  and is labelled so. The two kinds share one limit of 200 entries per workspace (see CheckpointIndexPeer), and a
 *  change with a raw-byte restore point counts once, as its raw entry; neither kind is ever relabelled as the other.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import * as path from 'path';

export interface Checkpoint {
  /** Monotonic id, unique within a store instance. */
  id: number;
  agentId: string;
  agentName: string;
  /** The path as reported by the tool, for display. Usually relative to the agent's own folder. */
  path: string;
  /**
   * The absolute path of the file the change was made to, as the tool that made it resolved it. This, never the
   * display path read against the first workspace folder, names the file a restore acts on. Records written before
   * v0.9.97 have none: their path was relative to a folder they did not record, so they cannot be restored.
   */
  target?: string;
  /** Where `target` led on disk when the change was recorded. A restore refuses a path that now leads elsewhere. */
  physicalTarget?: string;
  /** What the change did. Absent on records written before v0.9.97, which are not restorable. */
  operation?: CheckpointOperation;
  /** File content BEFORE this edit (null = file did not exist → restore deletes it). */
  before: string | null;
  /** File content AFTER this edit. A restore requires the file to still hold it (or what a later edit left). */
  after: string;
  /** ms epoch when recorded. */
  ts: number;
  /** True when before/after were too large to retain — listed but not restorable. */
  truncated?: boolean;
  /** The before-state was not provable. Listed and diffable, but restore is deliberately disabled. */
  restoreDisabledReason?: CheckpointRestoreDisabledReason;
  /** Set when a restore undid this change: when, and the SHA-256 of what it left (null: it deleted the file). */
  restored?: { at: number; sha256: string | null };
  /**
   * The raw-byte restore point the host kept before this change (v0.9.97). A restore puts back its bytes, never the
   * text above; when its bytes are no longer kept, the record goes too.
   */
  raw?: CheckpointRawRef;
  /**
   * v0.9.97: SHA-256 of what the change left, as the host read it back, for a change whose `after` text is not its
   * bytes (a saved attachment: an image, a PDF, a text file with a byte-order mark). A restore then requires exactly
   * these bytes; `after` is only what the diff shows.
   */
  afterSha256?: string;
  /**
   * v0.9.97: the request the change was made for, and where that request's closeout lists the file, so that a restore
   * of this change shows on it. Absent for a change made outside a request, and on records written before v0.9.97.
   */
  request?: CheckpointRequestRef;
}

/** v0.9.97: the request a recorded change was made for, by its id, and the path its closeout lists, when it lists one. */
export interface CheckpointRequestRef {
  id: string;
  path?: string;
}

/** A change's raw-byte restore point: the exact bytes the file held before it, kept out of line under this id. */
export interface CheckpointRawRef {
  id: string;
  /**
   * SHA-256 of what the change left, as the host read it back; null when it removed the file. Absent when the host
   * could not confirm what the change left.
   */
  afterSha256?: string | null;
}

/** What a recorded change did to its target. */
export type CheckpointOperation = 'write' | 'delete-file' | 'delete-directory';

/** Why a checkpoint is visible without offering a restore that could overwrite user work incorrectly. */
export type CheckpointRestoreDisabledReason =
  | 'empty-new-string'
  | 'ambiguous-occurrence'
  | 'not-found'
  | 'replace-all-ambiguous'
  | 'roundtrip-mismatch'
  | 'overwrote-existing'
  | 'deleted-directory'
  | 'not-utf8-text';

/** What the caller passes when a write succeeds (ids/timestamps are assigned by the store). */
export interface CheckpointInput {
  agentId: string;
  agentName: string;
  path: string;
  /** Absolute path of the file the tool changed. Without it the record is listed but never restorable. */
  target?: string;
  physicalTarget?: string;
  operation?: CheckpointOperation;
  before: string | null;
  after: string;
  /** Preserve the observed change without pretending its prior contents are known. */
  restoreDisabledReason?: CheckpointRestoreDisabledReason;
  /** The raw-byte restore point kept before the change, when the host kept one. */
  raw?: CheckpointRawRef;
  /** What the change left, by SHA-256 as read back, when `after` is not those bytes. */
  afterSha256?: string;
  /** v0.9.97: the request the change was made for. */
  request?: CheckpointRequestRef;
}

export interface SerializedCheckpoints {
  version: 1;
  nextId: number;
  items: Checkpoint[];
}

/**
 * One side of the unified restore-point index. Text records and raw-byte records together keep at most 200 entries
 * per workspace; whichever side needs room drops the oldest entry that may be dropped, from either side. An entry in
 * use (pinned) is never dropped, so `oldestEvictable` skips it.
 */
export interface CheckpointIndexPeer {
  count(): number;
  /** When each entry that may be dropped now was recorded, oldest first. */
  evictableTimes(): number[];
  /** Drop the oldest entry that may be dropped. */
  evictOldest(): void;
}

/** Don't retain huge blobs: a file larger than this (either side) is logged but marked non-restorable. */
const MAX_CONTENT_BYTES = 200_000;
/**
 * v0.9.99: whether a change's text record keeps the file's earlier text, so the undo button can put it back without a
 * raw-byte restore point. The same size rule `record` applies.
 */
export function checkpointKeepsText(before: string | null, after: string): boolean {
  return before !== null && before.length <= MAX_CONTENT_BYTES && after.length <= MAX_CONTENT_BYTES;
}

/** Keep memory/persistence bounded — oldest checkpoints fall off. Shared with the raw-byte store. */
export const MAX_CHECKPOINT_ENTRIES = 200;

export class CheckpointStore implements CheckpointIndexPeer {
  private items: Checkpoint[] = [];
  private nextId = 1;
  private peer?: CheckpointIndexPeer;

  constructor(private readonly maxEntries: number = MAX_CHECKPOINT_ENTRIES) {}

  /** Share the entry limit with the raw-byte store of the same workspace. */
  attachPeer(peer: CheckpointIndexPeer | undefined): void {
    this.peer = peer;
  }

  /**
   * Record a write. Returns the stored Checkpoint. A no-op edit (before === after) is skipped, unless the host kept a
   * raw-byte restore point for it: equal text can stand for different bytes, and that restore point needs its record.
   */
  record(input: CheckpointInput): Checkpoint | undefined {
    if (input.before === input.after && !input.raw) {
      return undefined; // nothing changed — not worth a restore point
    }
    const tooBig =
      (input.before != null && input.before.length > MAX_CONTENT_BYTES) ||
      input.after.length > MAX_CONTENT_BYTES;
    // A deleted folder is recorded with a listing of what it held as its "before". That listing is for review: written
    // back, it would become a file at the folder's path.
    const restoreDisabledReason = input.restoreDisabledReason
      ?? (input.operation === 'delete-directory' ? 'deleted-directory' : undefined);
    const cp: Checkpoint = {
      id: this.nextId++,
      agentId: input.agentId,
      agentName: input.agentName,
      path: input.path,
      ...(input.target ? { target: input.target } : {}),
      ...(input.physicalTarget ? { physicalTarget: input.physicalTarget } : {}),
      ...(input.operation ? { operation: input.operation } : {}),
      before: tooBig || restoreDisabledReason ? null : input.before,
      after: tooBig ? '' : input.after,
      ts: Date.now(),
      ...(tooBig ? { truncated: true } : {}),
      ...(restoreDisabledReason ? { restoreDisabledReason } : {}),
      ...(input.raw ? { raw: { ...input.raw } } : {}),
      ...(input.afterSha256 !== undefined ? { afterSha256: input.afterSha256 } : {}),
      ...(input.request ? { request: { id: input.request.id, ...(input.request.path ? { path: input.request.path } : {}) } } : {}),
    };
    this.items.push(cp);
    this.trim(cp);
    return cp;
  }

  /**
   * Drop the oldest entries of either kind until both kinds fit the shared limit. The new record itself stays. A record
   * with a raw-byte restore point is counted, and dropped, as its raw entry, by the raw store.
   */
  private trim(kept: Checkpoint): void {
    while (this.count() + (this.peer?.count() ?? 0) > this.maxEntries) {
      const own = this.items.find((item) => !item.raw);
      const peerOldest = this.peer?.evictableTimes()[0];
      if (peerOldest !== undefined && (!own || own === kept || peerOldest < own.ts)) {
        const before = this.peer!.count();
        this.peer!.evictOldest();
        if (this.peer!.count() < before) {
          continue;
        }
      }
      if (!own || own === kept) {
        return;
      }
      this.items = this.items.filter((item) => item !== own);
    }
  }

  /** The text restore points. A record with a raw-byte restore point is counted by the raw store, once. */
  count(): number {
    return this.items.filter((item) => !item.raw).length;
  }

  /** A text record is never in use by a pending write: it is recorded after the write. */
  evictableTimes(): number[] {
    return this.items.filter((item) => !item.raw).map((item) => item.ts);
  }

  evictOldest(): void {
    const oldest = this.items.findIndex((item) => !item.raw);
    if (oldest >= 0) {
      this.items.splice(oldest, 1);
    }
  }

  /** The raw-byte restore points the records refer to. */
  rawIds(): string[] {
    return this.items.flatMap((item) => (item.raw ? [item.raw.id] : []));
  }

  /** Drop the records whose raw-byte restore point is gone. True when one was dropped. */
  dropRaw(ids: readonly string[]): boolean {
    const gone = new Set(ids);
    const kept = this.items.filter((item) => !item.raw || !gone.has(item.raw.id));
    const dropped = kept.length !== this.items.length;
    this.items = kept;
    return dropped;
  }

  /** All checkpoints, newest first. */
  list(): Checkpoint[] {
    return [...this.items].reverse();
  }

  get(id: number): Checkpoint | undefined {
    return this.items.find((c) => c.id === id);
  }

  /** Restorable checkpoints only, newest first. */
  restorable(): Checkpoint[] {
    return this.list().filter((c) => checkpointRestoreDisabledMessage(c) === undefined);
  }

  /** Note that a restore undid these changes, so none of them is offered again and the next restore knows the state. */
  markRestored(ids: readonly number[], sha256: string | null, at = Date.now()): void {
    for (const item of this.items) {
      if (ids.includes(item.id)) {
        item.restored = { at, sha256 };
      }
    }
  }

  clear(): void {
    this.items = [];
  }

  serialize(): SerializedCheckpoints {
    return { version: 1, nextId: this.nextId, items: [...this.items] };
  }

  /** Replace state from a persisted blob. Tolerant of missing/garbage input (keeps current state). */
  restoreFrom(data: SerializedCheckpoints | undefined): void {
    if (!data || data.version !== 1 || !Array.isArray(data.items)) {
      return;
    }
    this.items = data.items.slice(-this.maxEntries);
    this.nextId = Math.max(data.nextId ?? 1, ...this.items.map((c) => c.id + 1), 1);
  }
}

/** User-facing reason shared by the rail and command path. Never turn an uncertainty into a guess. */
export function checkpointRestoreDisabledMessage(checkpoint: Checkpoint): string | undefined {
  // A raw-byte restore point keeps the bytes whatever the size of the text kept for the diff.
  if (checkpoint.truncated && !checkpoint.raw) {
    return 'The file content was too large to retain.';
  }
  switch (checkpoint.restoreDisabledReason) {
    case 'empty-new-string':
      return 'The edit deleted text, so its original location cannot be proved.';
    case 'ambiguous-occurrence':
      return 'The new text occurs more than once, so the original location is ambiguous.';
    case 'not-found':
      return 'The completed file does not contain the edit result described by the tool.';
    case 'replace-all-ambiguous':
      return 'Replace-all edits do not preserve a unique original version.';
    case 'roundtrip-mismatch':
      return 'The original version could not be reconstructed and verified.';
    case 'overwrote-existing':
      return 'The write replaced an existing file, whose prior contents were not available.';
    case 'deleted-directory':
      return 'A deleted folder is listed with the files it held, not their contents, so it cannot be put back.';
    case 'not-utf8-text':
      return 'The file was not UTF-8 text, so the text UnodeAi kept of it is not its original content.';
    default:
      break;
  }
  if (checkpoint.restored) {
    return 'This change was already restored.';
  }
  if (!checkpoint.target || !checkpoint.operation) {
    return 'An earlier UnodeAi version recorded this change without the folder its path belongs to, so the file it names cannot be proved.';
  }
  return undefined;
}

/** What a record's restore puts back: the exact bytes the host kept, or the text UnodeAi kept of the file. */
export type CheckpointEvidence = 'raw-bytes' | 'text';

export function checkpointEvidence(checkpoint: Checkpoint): CheckpointEvidence {
  return checkpoint.raw ? 'raw-bytes' : 'text';
}

/** How the restore point is labelled where a restore is offered or confirmed. */
export function checkpointEvidenceLabel(checkpoint: Checkpoint): string {
  return checkpoint.raw ? 'exact bytes kept before the edit' : 'text copy kept by UnodeAi';
}

/**
 * One identity for the file a record names, or undefined for a record that names none provably. Windows paths
 * compare without case, as Windows does.
 */
export function checkpointTargetKey(checkpoint: Checkpoint, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!checkpoint.target) {
    return undefined;
  }
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const resolved = pathApi.resolve(checkpoint.target);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** What a restore must find in the file before it acts: the state UnodeAi last recorded for it. */
export type CheckpointExpectedState =
  | { kind: 'absent' }
  | { kind: 'bytes'; sha256: string }
  | { kind: 'unknown'; reason: string };

export interface CheckpointRestorePlan {
  /** The record whose before-state is put back. */
  checkpoint: Checkpoint;
  target: string;
  physicalTarget?: string;
  /** Every recorded change the restore undoes, oldest first, the chosen one included. */
  undoes: Checkpoint[];
  /** What the file must hold now: the after-state of the newest recorded change, or what the last restore left. */
  expected: CheckpointExpectedState;
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/**
 * The restore of `chosen`, judged against every record of the same file, or why there is none.
 *
 * A restore puts back the content before `chosen` and so undoes every later recorded change of that file too, by any
 * agent; they are listed so the confirmation can name them. It may act only on the state the newest record left: a
 * file that holds anything else was changed by something UnodeAi did not record, and restoring would discard it.
 */
export function checkpointRestorePlan(
  all: readonly Checkpoint[],
  chosen: Checkpoint,
): { ok: true; plan: CheckpointRestorePlan } | { ok: false; reason: string } {
  const disabled = checkpointRestoreDisabledMessage(chosen);
  if (disabled) {
    return { ok: false, reason: disabled };
  }
  const key = checkpointTargetKey(chosen)!;
  const sameFile = all
    .filter((c) => checkpointTargetKey(c) === key)
    .sort((a, b) => a.id - b.id);
  const newest = sameFile[sameFile.length - 1] ?? chosen;
  const undoes = sameFile.filter((c) => c.id >= chosen.id && !c.restored);
  return {
    ok: true,
    plan: {
      checkpoint: chosen,
      target: chosen.target!,
      ...(chosen.physicalTarget ? { physicalTarget: chosen.physicalTarget } : {}),
      undoes,
      expected: expectedStateAfter(newest),
    },
  };
}

function expectedStateAfter(newest: Checkpoint): CheckpointExpectedState {
  if (newest.restored) {
    return newest.restored.sha256 === null ? { kind: 'absent' } : { kind: 'bytes', sha256: newest.restored.sha256 };
  }
  // What the host read back after a change it kept the raw bytes before: exact, whatever the text kept of it.
  const confirmed = newest.raw?.afterSha256;
  if (confirmed !== undefined && newest.operation && newest.operation !== 'delete-directory') {
    return confirmed === null ? { kind: 'absent' } : { kind: 'bytes', sha256: confirmed };
  }
  // What the host read back after a change whose kept text is not its bytes: exact as well.
  if (newest.afterSha256 !== undefined && newest.operation === 'write') {
    return { kind: 'bytes', sha256: newest.afterSha256 };
  }
  if (newest.truncated) {
    return { kind: 'unknown', reason: 'its latest recorded change was too large to retain, so UnodeAi cannot tell whether it changed since.' };
  }
  if (!newest.operation) {
    return { kind: 'unknown', reason: 'its latest change was recorded by an earlier UnodeAi version, which did not record what the change did.' };
  }
  if (newest.operation === 'delete-directory') {
    return { kind: 'unknown', reason: 'its latest recorded change deleted a folder at this path.' };
  }
  return newest.operation === 'delete-file' ? { kind: 'absent' } : { kind: 'bytes', sha256: sha256Text(newest.after) };
}
