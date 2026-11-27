/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Codex and the live file access grants (v0.9.102, R4a)
 *
 *  The person's Read + Write grant of a folder reaches a Codex agent's native sandbox at its next turn: the folder is
 *  added to the same runtime access the backend reads for every turn, and the backend restarts App Server when that
 *  changes the sandbox. An exact-file grant never becomes a writable root: a sandbox root cannot name one file, so the
 *  host `write_file`/`write_document` write that file, checked against the live grant at each call. A turn already
 *  started keeps the sandbox it started with (the Owner's plan A, 2026-11-09); when a grant it started with is taken
 *  away, the person is told so once, beside the existing Stop.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import type { CodexRuntimeAccess, CodexTurnWriteScope } from '../backend/CodexBackend';
import type { SessionPathAccessGrant } from '../backend/localReadScope';
import { isPathInsideOrEqual } from '../backend/pathContainment';

/** The folders of current Read + Write grants. A read grant and a file grant are not folders Codex may write. */
function writableGrantFolders(grants: readonly SessionPathAccessGrant[]): string[] {
  return grants.filter((grant) => grant.permission === 'readwrite' && grant.target.kind === 'directory' && grant.current())
    .map((grant) => grant.target.realPath);
}

/**
 * The runtime access of a Codex agent with its live folder grants: each Read + Write folder grant is a read and a write
 * root. `grants` is what the agent may use now: none when it may not write, when the workspace is not trusted or when
 * its own Folder Access caps it (the caller's live grant source already says so for the last two).
 */
export function codexAccessWithGrants(base: CodexRuntimeAccess, grants: readonly SessionPathAccessGrant[]): CodexRuntimeAccess {
  if (!base.trusted) return base;
  const folders = writableGrantFolders(grants);
  if (folders.length === 0) return base;
  return { ...base, readRoots: [...base.readRoots, ...folders], writeRoots: [...base.writeRoots, ...folders] };
}

/** The exact files of current Read + Write grants: written only by the host tools. */
export function codexExactFileWrites(grants: readonly SessionPathAccessGrant[]): string[] {
  return grants.filter((grant) => grant.permission === 'readwrite' && grant.target.kind === 'file' && grant.current())
    .map((grant) => grant.target.realPath);
}

/** What the person is told when a running Codex turn started with write access to a folder that is now gone. */
export function codexGrantBoundaryNotice(agentName: string, folders: readonly string[]): string {
  const named = folders.length === 1 ? folders[0] : folders.join(', ');
  return `${agentName}: write access to ${named} was removed. The Codex turn running now started with it and may still `
    + 'write there until that turn ends; the next turn starts without it. To end the running turn now, press Stop. '
    + 'Stop does not undo changes already made.';
}

/**
 * The folders a running Codex turn started with write access to and the next turn no longer gets, not yet told. Each is
 * told once per turn: `told` keeps them.
 */
export function revokedDuringTurn(scope: CodexTurnWriteScope, told: Set<string>): string[] {
  let current: readonly string[];
  try { current = scope.current(); } catch { return []; }
  const key = (root: string) => (process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root));
  const gone = scope.started.filter((root) => !current.some((kept) => isPathInsideOrEqual(kept, root)))
    .filter((root) => !told.has(key(root)));
  for (const root of gone) told.add(key(root));
  return gone;
}
