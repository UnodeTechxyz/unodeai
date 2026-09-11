/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Local Read Scope
 *
 *  A host-owned, read-only expansion for local project discovery.  It never contributes a write
 *  root or a shell cwd.  Workspace Trust remains the outer permission boundary.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';

export type LocalReadScope = 'workspace' | 'parent' | 'volume';

/**
 * Host-owned, session-only confirmation for a local-scope root.  The backend deliberately knows
 * neither VS Code nor persistence: the extension supplies the modal and this class makes a single
 * approval/decline decision stable for the lifetime of the extension process.
 */
export type LocalReadScopeConsentRequester = (absoluteRoot: string) => Promise<boolean>;

export interface LocalReadScopeConsentGate {
  ensure(absoluteRoot: string): Promise<boolean>;
}

export class SessionLocalReadScopeConsent implements LocalReadScopeConsentGate {
  private readonly decisions = new Map<string, Promise<boolean>>();

  constructor(private readonly request: LocalReadScopeConsentRequester) {}

  ensure(absoluteRoot: string): Promise<boolean> {
    const root = path.resolve(absoluteRoot);
    const existing = this.decisions.get(root);
    if (existing) {
      return existing;
    }
    // A missing/failed UI must never become an implicit approval. Store the pending promise before
    // awaiting it so simultaneous agents coalesce to the same modal and the same final decision.
    const decision = Promise.resolve()
      .then(() => this.request(root))
      .then((approved) => approved === true, () => false);
    this.decisions.set(root, decision);
    return decision;
  }
}

/**
 * Return the one optional host-owned root implied by the user's local-read choice.
 *
 * - workspace: preserve the long-standing workspace-only sandbox.
 * - parent: let an agent inspect sibling projects without asking the user to pre-register each one.
 * - volume: mirror Codex's broad local read reach on the workspace's current filesystem volume.
 *
 * This intentionally returns lexical paths. `normalizeAgentReadRoots` is still responsible for
 * existence, realpath canonicalisation, de-duplication, and nested-root collapse.
 */
export function localReadRootsForScope(
  scope: LocalReadScope | string | undefined,
  workspaceRoot: string,
  isTrusted: boolean,
): string[] {
  if (!isTrusted) {
    return [];
  }
  const root = path.resolve(workspaceRoot);
  switch (scope) {
    case 'parent': {
      const parent = path.dirname(root);
      return parent === root ? [] : [parent];
    }
    case 'volume':
      return [path.parse(root).root];
    default:
      return [];
  }
}
