/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Local Read Scope
 *
 *  A host-owned, read-only expansion for local project discovery.  It never contributes a write
 *  root or a shell cwd.  Workspace Trust remains the outer permission boundary.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';

export type LocalReadScope = 'workspace' | 'parent' | 'volume';

/**
 * Host-owned, session-only confirmation for a local-scope root. The backend deliberately knows
 * neither VS Code nor persistence: the extension supplies the modal and this class owns the
 * in-memory decision lifecycle.
 */
export type LocalReadScopeConsentRequester = (absoluteRoot: string) => Promise<boolean>;

export type LocalReadScopeConsentStatus = 'granted' | 'declined';

export interface LocalReadScopeConsentDecision {
  absoluteRoot: string;
  status: LocalReadScopeConsentStatus;
}

/** The callback receives a grant action already bound to the exact refused root. */
export type LocalReadScopeConsentDeclinedHandler = (
  absoluteRoot: string,
  grant: () => Promise<boolean>,
) => void;

export const LOCAL_READ_SCOPE_GRANT_ACTION = 'Grant folder access' as const;

export type LocalReadScopeRecoveryPresenter = (
  message: string,
  action: typeof LOCAL_READ_SCOPE_GRANT_ACTION,
) => PromiseLike<string | undefined>;

/** Present the recoverable refusal without making the original tool call wait for a second decision. */
export async function offerLocalReadScopeRecovery(
  absoluteRoot: string,
  grant: () => Promise<boolean>,
  present: LocalReadScopeRecoveryPresenter,
): Promise<boolean> {
  const choice = await present(
    `Folder access was declined for:\n${absoluteRoot}\n\nThe current request will continue without it.`,
    LOCAL_READ_SCOPE_GRANT_ACTION,
  );
  return choice === LOCAL_READ_SCOPE_GRANT_ACTION ? grant() : false;
}

export interface LocalReadScopeConsentGate {
  ensure(absoluteRoot: string): Promise<boolean>;
}

export class SessionLocalReadScopeConsent implements LocalReadScopeConsentGate {
  private readonly decisions = new Map<string, LocalReadScopeConsentStatus>();
  private readonly pending = new Map<string, Promise<'granted' | 'declined' | 'failed'>>();
  /** One epoch is shared by the coordinator and every delegate spawned for that user request. */
  private userRequestEpoch = 0;
  /** A decline or unavailable dialog blocks retries only in the epoch that observed it. */
  private readonly blockedAtEpoch = new Map<string, number>();
  /** Defensive dedupe: one declined root can raise at most one recovery notice in an epoch. */
  private readonly recoveryNotifiedAtEpoch = new Map<string, number>();

  constructor(
    private readonly request: LocalReadScopeConsentRequester,
    private readonly onDeclined?: LocalReadScopeConsentDeclinedHandler,
  ) {}

  /**
   * A direct user request is the only event that makes a previous decline askable again. Automated
   * continuations, tool retries, delegate wakes and backend restarts do not call this method, so they
   * retain the fail-closed latch and cannot create a prompt loop.
   */
  beginUserRequest(): void {
    this.userRequestEpoch++;
  }

  async ensure(absoluteRoot: string): Promise<boolean> {
    const root = path.resolve(absoluteRoot);
    if (this.decisions.get(root) === 'granted') {
      return true;
    }
    const epoch = this.userRequestEpoch;
    if (this.blockedAtEpoch.get(root) === epoch) {
      return false;
    }
    const outcome = await this.ask(root, epoch, true);
    if (outcome !== 'granted') {
      this.blockedAtEpoch.set(root, epoch);
    }
    return outcome === 'granted';
  }

  /** Open the same confirmation from a recovery notice or the Security panel. */
  async requestGrant(absoluteRoot: string): Promise<boolean> {
    const root = path.resolve(absoluteRoot);
    if (this.decisions.get(root) === 'granted') {
      return true;
    }
    const epoch = this.userRequestEpoch;
    const outcome = await this.ask(root, epoch, false);
    if (outcome !== 'granted') {
      this.blockedAtEpoch.set(root, epoch);
    }
    return outcome === 'granted';
  }

  /** A revoke affects every currently active request before its next tool call. */
  revoke(absoluteRoot: string): boolean {
    const root = path.resolve(absoluteRoot);
    if (this.decisions.get(root) !== 'granted') {
      return false;
    }
    this.decisions.set(root, 'declined');
    this.blockedAtEpoch.set(root, this.userRequestEpoch);
    return true;
  }

  list(): LocalReadScopeConsentDecision[] {
    return [...this.decisions.entries()]
      .map(([absoluteRoot, status]) => ({ absoluteRoot, status }))
      .sort((left, right) => left.absoluteRoot.localeCompare(right.absoluteRoot));
  }

  private ask(root: string, epoch: number, notifyDecline: boolean): Promise<'granted' | 'declined' | 'failed'> {
    const inFlight = this.pending.get(root);
    if (inFlight) {
      return inFlight;
    }
    // Store the pending promise before awaiting it so simultaneous agents coalesce to the same modal.
    // A thrown/unavailable UI fails this attempt closed but records no user decision.
    const decision = Promise.resolve()
      .then(() => this.request(root))
      .then((approved): 'granted' | 'declined' => approved === true ? 'granted' : 'declined')
      .then((outcome) => {
        this.decisions.set(root, outcome);
        if (outcome === 'granted') {
          this.blockedAtEpoch.delete(root);
          this.recoveryNotifiedAtEpoch.delete(root);
        } else if (notifyDecline && this.recoveryNotifiedAtEpoch.get(root) !== epoch) {
          this.recoveryNotifiedAtEpoch.set(root, epoch);
          this.onDeclined?.(root, () => this.requestGrant(root));
        }
        return outcome;
      }, () => 'failed' as const)
      .finally(() => {
        this.pending.delete(root);
      });
    this.pending.set(root, decision);
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
