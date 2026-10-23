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

/** Activation-time first-folder binding. Once its identity changes, old project services stay unusable. */
export class FirstWorkspaceBinding {
  private invalidated = false;

  constructor(private readonly initialRoot: string | undefined) {}

  root(): string | undefined {
    return this.invalidated ? undefined : this.initialRoot;
  }

  isStale(): boolean {
    return this.invalidated;
  }

  /** Returns true exactly once when a different first folder invalidates the captured project services. */
  observe(nextRoot: string | undefined): boolean {
    if (this.invalidated || sameRoot(this.initialRoot, nextRoot)) return false;
    this.invalidated = true;
    return true;
  }
}

function sameRoot(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return left === right;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
