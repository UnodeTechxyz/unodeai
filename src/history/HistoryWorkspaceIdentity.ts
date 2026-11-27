/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the history's workspace identity (v0.9.110 §3.1)
 *  The whole set of physical roots and the remote authority, never the first root alone: the order of the roots
 *  does not change it, and a different set is another workspace. Each root is read through its real path, so a
 *  symlinked alias of a folder is the same workspace.
 *
 *  Case: compared as the platform compares paths, the rule `samePath` (backend/folderAccess.ts) uses through
 *  `node:path`. Windows folds case; POSIX keeps it, so `/projects/App` and `/projects/app` on Linux are two
 *  workspaces. macOS keeps case here too, so one folder on a case-insensitive volume opened under two spellings may
 *  get two identities (two separate histories, nothing mixed). Not verified on macOS.
 *
 *  A window with no folder has no physical identity: its history can be read, but nothing in it can be restored.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import * as nodePath from 'node:path';

export type HistoryWorkspace =
  | { kind: 'physical'; workspaceId: string; roots: string[]; remoteAuthority?: string }
  | { kind: 'no-folder'; workspaceId: string };

export const NO_FOLDER_WORKSPACE_ID = 'no-folder';

export interface HistoryWorkspaceDeps {
  realpath?: (root: string) => string;
  platform?: NodeJS.Platform;
  /** The path module of the platform the roots belong to; `node:path` by default. */
  path?: typeof nodePath.posix;
}

function comparable(root: string, deps: Required<HistoryWorkspaceDeps>): string {
  let real: string;
  try {
    real = deps.realpath(root);
  } catch {
    real = deps.path.resolve(root);
  }
  const resolved = deps.path.resolve(real);
  if (deps.platform === 'win32') return resolved.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  return resolved.length > 1 ? resolved.replace(/\/$/, '') : resolved;
}

export function historyWorkspace(roots: readonly string[], remoteAuthority: string | undefined, deps: HistoryWorkspaceDeps = {}): HistoryWorkspace {
  if (roots.length === 0) return { kind: 'no-folder', workspaceId: NO_FOLDER_WORKSPACE_ID };
  const resolved: Required<HistoryWorkspaceDeps> = {
    realpath: deps.realpath ?? ((root: string) => realpathSync.native(root)),
    platform: deps.platform ?? process.platform,
    path: deps.path ?? nodePath,
  };
  const set = [...new Set(roots.map((root) => comparable(root, resolved)))].sort();
  // A remote authority names a host (such as `wsl+Ubuntu` or `ssh-remote+box`); host names are case-insensitive.
  const authority = remoteAuthority ? remoteAuthority.toLowerCase() : '';
  const workspaceId = createHash('sha256').update(JSON.stringify({ v: 1, authority, roots: set })).digest('hex');
  return { kind: 'physical', workspaceId, roots: set, ...(authority ? { remoteAuthority: authority } : {}) };
}
