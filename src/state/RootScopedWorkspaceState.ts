import type { WorkspaceMemento } from '../settings/ProjectCommandApprovals';
import { workspaceRootIdentity } from './WorkspaceRootIdentity';

export const ROOT_STATE_PREFIX = 'unode.workspaceRoot.v1.';
export const GLOBAL_WORKSPACE_STATE_KEYS = new Set(['unode.workbenchInspectorOpen']);

export interface KeyedWorkspaceMemento extends WorkspaceMemento {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  keys(): readonly string[];
}

export type LegacyWorkspaceStateHost = 'vscode' | 'cursor' | 'other';

/**
 * VS Code and Cursor already give each opened workspace its own extension-state bucket, so their
 * v0.9.81 unscoped values can be attributed to the currently open root. Devin may reuse one bucket
 * across roots; its old values are deliberately not imported.
 */
export function classifyLegacyWorkspaceStateHost(appName: string): LegacyWorkspaceStateHost {
  const normalized = appName.trim().toLowerCase();
  if (normalized === 'visual studio code' || normalized === 'visual studio code - insiders') return 'vscode';
  if (normalized === 'cursor') return 'cursor';
  return 'other';
}

/**
 * A physical namespace over VS Code's workspaceState. All project state is scoped by the same root
 * digest, including dynamic key families and keys introduced later. The small global-key allowlist
 * is intentionally not exposed through this wrapper.
 */
export class RootScopedWorkspaceState implements KeyedWorkspaceMemento {
  private readonly prefix: string | undefined;

  constructor(
    private readonly backing: KeyedWorkspaceMemento,
    root: string | undefined,
    private readonly isAvailable: () => boolean = () => true,
  ) {
    this.prefix = root ? `${ROOT_STATE_PREFIX}${workspaceRootIdentity(root)}.` : undefined;
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (!this.prefix || !this.isAvailable()) return defaultValue;
    return defaultValue === undefined
      ? this.backing.get<T>(this.scopedKey(key))
      : this.backing.get<T>(this.scopedKey(key), defaultValue);
  }

  update(key: string, value: unknown): PromiseLike<void> {
    if (!this.prefix || !this.isAvailable()) {
      return Promise.reject(new Error(
        'Open a workspace folder and reload the window before changing project state; no project state was written.',
      ));
    }
    return this.backing.update(this.scopedKey(key), value);
  }

  keys(): readonly string[] {
    if (!this.prefix || !this.isAvailable()) return [];
    return this.backing.keys()
      .filter((key) => key.startsWith(this.prefix!))
      .map((key) => key.slice(this.prefix!.length));
  }

  /**
   * One-time compatibility import for hosts whose old bucket was already workspace-local. Values
   * are moved, not read through: a reused bucket can never fall back to another root's raw state.
   */
  async importLegacyWorkspaceLocalState(host: LegacyWorkspaceStateHost): Promise<readonly string[]> {
    if (!this.prefix || !this.isAvailable() || host === 'other') return [];
    const imported: string[] = [];
    for (const key of this.backing.keys()) {
      if (key.startsWith(ROOT_STATE_PREFIX) || GLOBAL_WORKSPACE_STATE_KEYS.has(key)) continue;
      const value = this.backing.get<unknown>(key);
      if (value !== undefined && this.backing.get<unknown>(this.scopedKey(key)) === undefined) {
        await this.backing.update(this.scopedKey(key), value);
        imported.push(key);
      }
      await this.backing.update(key, undefined);
    }
    return imported;
  }

  private scopedKey(key: string): string {
    return `${this.prefix}${key}`;
  }
}
