/*---------------------------------------------------------------------------------------------
 *  UnodeAi - CheckpointRestore
 *  Putting a file back from a restore point is a new write, and it is judged as one when it happens:
 *
 *  - Workspace Trust, and the folders the host may write in now. A restore point is not a standing permission.
 *  - The file it names is the one the change was recorded for (its absolute target), never the recorded display
 *    path read against whichever folder happens to be first.
 *  - Unsaved editor changes are never overwritten.
 *  - The file must hold what UnodeAi last recorded for it. Anything else is newer work UnodeAi has no record of, and a
 *    restore never rolls that back.
 *
 *  The write goes to an owned temporary file beside the target, which replaces the target by rename after a last
 *  check; the result is read back and hashed. A read-back that does not match is `effect-uncertain`, never "nothing
 *  happened", and nothing is written again to hide it. A refusal leaves the target as it was.
 *
 *  Residual: the checks and the rename are separate filesystem calls, so another program can still change the file
 *  between the last check and the rename. On Windows a directory cannot be flushed, so the rename's durability across
 *  a power loss rests on the filesystem's own journal.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'crypto';
import { constants } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { CheckpointExpectedState } from './Checkpoints';
import { isPathInsideOrEqual } from './pathContainment';
import { resolveInsideRootPhysical } from './workspacePath';

/** What the host knows of its current authority. Every function is asked again at each check. */
export interface CheckpointRestoreAuthority {
  isTrusted(): boolean;
  /** The folders the host may write in now. */
  writeRoots(): readonly string[];
  /** Whether an editor holds unsaved changes for this file. */
  hasUnsavedChanges(absolutePath: string): boolean;
}

/** What a restore puts back: no file (it did not exist before the change), or these exact bytes. */
export type CheckpointRestoreContent = { kind: 'absent' } | { kind: 'bytes'; bytes: Buffer };

export interface CheckpointRestoreRequest {
  /** Absolute path of the file, as the tool that changed it resolved it. */
  target: string;
  /** Where that path led when the change was recorded, when known. */
  physicalTarget?: string;
  content: CheckpointRestoreContent;
  expected: CheckpointExpectedState;
}

type TargetState =
  | { kind: 'absent' }
  | { kind: 'file'; sha256: string; size: number; dev: bigint; ino: bigint; nlink: bigint; mode: number };

/** A restore that passed every check once. It carries the state it found, which the commit requires again. */
export interface PreparedCheckpointRestore {
  readonly request: CheckpointRestoreRequest;
  /** Where the restore acts: the target's real path. */
  readonly physical: string;
  readonly observed: TargetState;
}

export type CheckpointRestorePreparation =
  | { status: 'ready'; prepared: PreparedCheckpointRestore }
  | { status: 'refused'; reason: string };

export type CheckpointRestoreOutcome =
  /** The read-back holds the restored bytes (or the file is gone, for a delete). `sha256` is null for a delete. */
  | { status: 'restored'; physical: string; sha256: string | null }
  /** Nothing was changed: the target is as it was found. */
  | { status: 'refused'; reason: string }
  /** The target may have been changed, and does not hold what the restore meant to leave. */
  | { status: 'effect-uncertain'; physical: string; reason: string };

/** Seams a test uses to fail a step or change the filesystem between two of them. The host passes none. */
export interface CheckpointRestoreHooks {
  /** After the temporary file is ready, before the last check of the target. */
  beforeCommit?: () => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  unlink?: (file: string) => Promise<void>;
  /** Between the rename (or delete) and the read-back. */
  afterCommit?: () => Promise<void>;
}

/** The largest file a restore reads to verify. A legacy text record holds far less; a raw-byte one, at most this. */
export const MAX_RESTORE_VERIFY_BYTES = 32 * 1024 * 1024;

const NOT_TRUSTED = 'this workspace is not trusted, and UnodeAi writes no files in an untrusted workspace.';
const UNSAVED = 'it has unsaved changes in an editor. Save or revert them first; UnodeAi does not overwrite them.';
const NEWER_WORK = 'it changed after UnodeAi last recorded it, so a restore would discard work UnodeAi has no record of. Open the edit to compare.';

/** Every check a restore must pass before it is offered, without changing anything. */
export async function prepareCheckpointRestore(
  request: CheckpointRestoreRequest,
  authority: CheckpointRestoreAuthority,
): Promise<CheckpointRestorePreparation> {
  const located = await locate(request, authority);
  if ('reason' in located) {
    return { status: 'refused', reason: located.reason };
  }
  const observed = await readTargetState(located.physical);
  if ('reason' in observed) {
    return { status: 'refused', reason: observed.reason };
  }
  const mismatch = expectationProblem(request, observed);
  if (mismatch) {
    return { status: 'refused', reason: mismatch };
  }
  return { status: 'ready', prepared: { request, physical: located.physical, observed } };
}

/**
 * The restore itself. Every check runs again first, and the target must still be what preparation found, since the
 * user decided on that. The last check runs after the temporary file is written, immediately before the rename.
 */
export async function commitCheckpointRestore(
  prepared: PreparedCheckpointRestore,
  authority: CheckpointRestoreAuthority,
  hooks: CheckpointRestoreHooks = {},
): Promise<CheckpointRestoreOutcome> {
  const unchanged = await stillAsPrepared(prepared, authority);
  if (unchanged !== true) {
    return { status: 'refused', reason: unchanged };
  }
  return prepared.request.content.kind === 'absent'
    ? deleteTarget(prepared, authority, hooks)
    : replaceTarget(prepared, prepared.request.content.bytes, authority, hooks);
}

async function deleteTarget(
  prepared: PreparedCheckpointRestore,
  authority: CheckpointRestoreAuthority,
  hooks: CheckpointRestoreHooks,
): Promise<CheckpointRestoreOutcome> {
  const { physical } = prepared;
  await hooks.beforeCommit?.();
  const unchanged = await stillAsPrepared(prepared, authority);
  if (unchanged !== true) {
    return { status: 'refused', reason: unchanged };
  }
  try {
    await (hooks.unlink ?? fs.unlink)(physical);
  } catch (err) {
    return await failedEffect(prepared, `the file could not be deleted (${errorCode(err)}).`);
  }
  await hooks.afterCommit?.();
  const after = await readTargetState(physical);
  return 'kind' in after && after.kind === 'absent'
    ? { status: 'restored', physical, sha256: null }
    : { status: 'effect-uncertain', physical, reason: 'after the delete, the file is still there.' };
}

async function replaceTarget(
  prepared: PreparedCheckpointRestore,
  bytes: Buffer,
  authority: CheckpointRestoreAuthority,
  hooks: CheckpointRestoreHooks,
): Promise<CheckpointRestoreOutcome> {
  const { physical, observed } = prepared;
  const directory = path.dirname(physical);
  const wanted = sha256(bytes);
  // A restored file whose folder is gone gets the folder back. mkdir reports the first folder it created, so a
  // refusal removes exactly those folders again, and only while they are empty.
  let createdDirectory: string | undefined;
  let temporary: string | undefined;
  const attempt = async (): Promise<CheckpointRestoreOutcome> => {
    try {
      createdDirectory = await fs.mkdir(directory, { recursive: true });
      temporary = path.join(directory, `.${path.basename(physical)}.${randomBytes(8).toString('hex')}.unode-restore`);
      const handle = await fs.open(temporary, 'wx');
      try {
        await handle.writeFile(bytes);
        if (observed.kind === 'file' && process.platform !== 'win32') {
          // The replaced file's permission bits carry over, as an in-place write would have kept them. Windows keeps
          // only a read-only flag in them, and a read-only target refuses the rename anyway.
          await handle.chmod(observed.mode & 0o777);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (err) {
      return { status: 'refused', reason: `the restored copy could not be written next to it (${errorCode(err)}).` };
    }
    await hooks.beforeCommit?.();
    const unchanged = await stillAsPrepared(prepared, authority);
    if (unchanged !== true) {
      return { status: 'refused', reason: unchanged };
    }
    try {
      await (hooks.rename ?? fs.rename)(temporary, physical);
      temporary = undefined;
    } catch (err) {
      return await failedEffect(prepared, `the file could not be replaced (${errorCode(err)}).`);
    }
    await hooks.afterCommit?.();
    const after = await readTargetState(physical);
    return 'kind' in after && after.kind === 'file' && after.sha256 === wanted
      ? { status: 'restored', physical, sha256: wanted }
      : { status: 'effect-uncertain', physical, reason: 'after the restore, the file does not hold the restored content.' };
  };
  const outcome = await attempt();
  const residue: string[] = [];
  if (temporary) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    if (await exists(temporary)) {
      residue.push(`the temporary file ${temporary} could not be removed`);
    }
  }
  if (createdDirectory && outcome.status === 'refused') {
    const left = await removeEmptyCreatedDirectories(createdDirectory, directory);
    if (left) {
      residue.push(`the folder ${left} it created could not be removed`);
    }
  }
  if (residue.length === 0) {
    return outcome;
  }
  const note = ` Left behind: ${residue.join('; ')}.`;
  return outcome.status === 'restored' ? outcome : { ...outcome, reason: `${outcome.reason}${note}` };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}

/** A failed delete or rename changed nothing only when the target is provably what it was; otherwise say so. */
async function failedEffect(prepared: PreparedCheckpointRestore, reason: string): Promise<CheckpointRestoreOutcome> {
  const now = await readTargetState(prepared.physical);
  return 'kind' in now && sameState(now, prepared.observed)
    ? { status: 'refused', reason: `${reason} The file is unchanged.` }
    : { status: 'effect-uncertain', physical: prepared.physical, reason: `${reason} UnodeAi cannot confirm what the file holds now.` };
}

/** Trust, authority, the target's identity, unsaved changes and its content, against what preparation found. */
async function stillAsPrepared(
  prepared: PreparedCheckpointRestore,
  authority: CheckpointRestoreAuthority,
): Promise<true | string> {
  const located = await locate(prepared.request, authority);
  if ('reason' in located) {
    return located.reason;
  }
  if (!samePhysical(located.physical, prepared.physical)) {
    return 'the path now leads to a different place than when the restore was prepared.';
  }
  const now = await readTargetState(prepared.physical);
  if ('reason' in now) {
    return now.reason;
  }
  return sameState(now, prepared.observed) ? true : 'it changed while the restore was waiting.';
}

/** Where the restore would act, if it may act there at all. Nothing is created and nothing is opened for writing. */
async function locate(
  request: CheckpointRestoreRequest,
  authority: CheckpointRestoreAuthority,
): Promise<{ physical: string } | { reason: string }> {
  if (!authority.isTrusted()) {
    return { reason: NOT_TRUSTED };
  }
  if (request.expected.kind === 'unknown') {
    return { reason: request.expected.reason };
  }
  if (!path.isAbsolute(request.target)) {
    return { reason: 'the restore point does not record which file it belongs to.' };
  }
  let physical: string | undefined;
  for (const root of authority.writeRoots()) {
    const resolution = await resolveInsideRootPhysical(root, request.target);
    if (resolution.status === 'resolved') {
      physical = resolution.path;
      break;
    }
  }
  if (physical === undefined) {
    return { reason: 'it is outside the folders UnodeAi may write in now.' };
  }
  if (request.physicalTarget !== undefined && !samePhysical(physical, request.physicalTarget)) {
    return { reason: 'its path now leads to a different place than when the change was recorded.' };
  }
  if (authority.hasUnsavedChanges(request.target) || authority.hasUnsavedChanges(physical)) {
    return { reason: UNSAVED };
  }
  return { physical };
}

function expectationProblem(request: CheckpointRestoreRequest, observed: TargetState): string | undefined {
  const expected = request.expected;
  if (expected.kind === 'unknown') {
    return expected.reason;
  }
  const matches = expected.kind === 'absent'
    ? observed.kind === 'absent'
    : observed.kind === 'file' && observed.sha256 === expected.sha256;
  if (!matches) {
    return NEWER_WORK;
  }
  if (request.content.kind === 'absent' && observed.kind === 'absent') {
    return 'it is already gone.';
  }
  // A second name of the same file (a hard link) is invisible to a path check. Replacing it would leave the other
  // names holding the old content, and an in-place write would change them all; neither is the restore asked for.
  if (request.content.kind === 'bytes' && observed.kind === 'file' && observed.nlink > 1n) {
    return 'the file has more than one name on disk (a hard link), so a restore cannot change only this one.';
  }
  return undefined;
}

/** The target as it is now: gone, or a regular file read through one handle, with its identity and SHA-256. */
async function readTargetState(physical: string): Promise<TargetState | { reason: string }> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(physical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    if (errorCode(err) === 'ENOENT') {
      try {
        await fs.lstat(physical);
      } catch (lstatErr) {
        if (errorCode(lstatErr) === 'ENOENT') {
          return { kind: 'absent' };
        }
      }
    }
    return { reason: `the file could not be read (${errorCode(err)}).` };
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) {
      return { reason: 'it is not a regular file.' };
    }
    if (stat.size > BigInt(MAX_RESTORE_VERIFY_BYTES)) {
      return { reason: 'it is too large for UnodeAi to verify before replacing it.' };
    }
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_RESTORE_VERIFY_BYTES) {
        return { reason: 'it is too large for UnodeAi to verify before replacing it.' };
      }
      hash.update(chunk.subarray(0, bytesRead));
    }
    return {
      kind: 'file',
      sha256: hash.digest('hex'),
      size: total,
      dev: stat.dev,
      ino: stat.ino,
      nlink: stat.nlink,
      mode: Number(stat.mode),
    };
  } catch (err) {
    return { reason: `the file could not be read (${errorCode(err)}).` };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function sameState(left: TargetState, right: TargetState): boolean {
  if (left.kind === 'absent' || right.kind === 'absent') {
    return left.kind === right.kind;
  }
  return left.sha256 === right.sha256 && left.dev === right.dev && left.ino === right.ino;
}

/**
 * Remove the folders this restore created, deepest first, while they are empty. Anything else stays. Returns the
 * deepest created folder still there, or undefined when all are gone.
 */
async function removeEmptyCreatedDirectories(first: string, deepest: string): Promise<string | undefined> {
  // On Windows, mkdir reports the folder in its `\\?\` long-path form.
  const top = path.resolve(first.startsWith('\\\\?\\') ? first.slice(4) : first);
  let current = path.resolve(deepest);
  // The walk ends where it leaves the first created folder: nothing above it was created by this restore.
  while (isPathInsideOrEqual(top, current)) {
    try {
      await fs.rmdir(current);
    } catch {
      return current;
    }
    current = path.dirname(current);
  }
  return undefined;
}

function samePhysical(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? (err instanceof Error ? err.message : String(err));
}
