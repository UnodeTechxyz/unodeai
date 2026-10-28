import * as path from 'node:path';

/**
 * Agent backends can create files or child processes. They therefore require a host-selected,
 * absolute workspace root and must never inherit the extension host's current directory.
 */
export function requireAbsoluteWorkingDirectory(value: string | undefined): string {
  const root = value?.trim();
  if (!root || !path.isAbsolute(root)) {
    throw new Error('Open a workspace folder before starting an agent; no project files or processes were touched.');
  }
  return root;
}

/**
 * Activation-time first-folder binding. Project services and project state are bound to this root for the life of
 * the window, so a change of the first folder can never redirect their writes into a different repository.
 *
 * v0.9.99: a change of the first folder no longer invalidates the binding. Before, it stopped every agent,
 * integration and terminal and refused all later work until a reload. Now the window keeps working in the root it
 * started with (each session keeps that root identity) and the host offers a reload to switch; the new folder is
 * used only after the window reloads, which hands project state over to it.
 */
export class FirstWorkspaceBinding {
  /** The different first folder last observed, or null while the editor's first folder is the bound one. */
  private pendingRoot: string | undefined | null = null;

  constructor(private readonly initialRoot: string | undefined) {}

  root(): string | undefined {
    return this.initialRoot;
  }

  /**
   * v0.9.99: never true; a first-folder change no longer makes the bound root unusable. Kept for the callers that
   * still guard on it, so that every one of them keeps working in the bound root.
   */
  isStale(): boolean {
    return false;
  }

  /** v0.9.99: whether the editor's first folder now differs from the bound root, so a reload would switch it. */
  switchPending(): boolean {
    return this.pendingRoot !== null;
  }

  /**
   * Returns true once for each different first folder the editor reports (the host then offers a reload), and
   * false when the first folder is unchanged or back to the bound root. The bound root itself never changes.
   */
  observe(nextRoot: string | undefined): boolean {
    if (sameRoot(this.initialRoot, nextRoot)) {
      this.pendingRoot = null;
      return false;
    }
    if (this.pendingRoot !== null && sameRoot(this.pendingRoot, nextRoot)) return false;
    this.pendingRoot = nextRoot;
    return true;
  }
}

function sameRoot(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return left === right;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
