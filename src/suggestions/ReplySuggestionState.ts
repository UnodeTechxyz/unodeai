/*---------------------------------------------------------------------------------------------
 *  UnodeAi - The one reply suggestion a chat may offer (v0.9.110)
 *
 *  A suggestion belongs to one answer in one conversation, to the composer that asked for it and to the composer
 *  text it was made for. Its identity is (workspace, conversation, branch, agent, turn, composer revision, settings
 *  revision). The host offers it only after the composer said it is empty; the result is delivered only when every
 *  part of the identity still holds, and only to the view that asked. Anything that changes one of them ends it.
 *
 *  At most one operation is live. Ending it aborts its request. Nothing here sends a message: an accepted
 *  suggestion is an ordinary draft the person may edit and send, or not.
 *
 *  VS Code-free.
 *--------------------------------------------------------------------------------------------*/

export type SuggestionView = 'sidebar' | 'workbench';

export interface SuggestionIdentity {
  workspaceId: string;
  conversationId: string;
  branchId: string;
  agentId: string;
  turnId: string;
  composerRevision: number;
  settingsRevision: number;
}

/** Why a suggestion ended. Content-free. */
export type SuggestionDismissReason =
  | 'typing' | 'paste' | 'composition' | 'escape' | 'attachment' | 'send' | 'stop' | 'clear'
  | 'switch' | 'settings' | 'disposed' | 'new-turn' | 'accepted' | 'superseded' | 'stale';

interface Offer {
  offerId: string;
  view: SuggestionView;
  /** The identity without the composer revision, which only the composer can tell. */
  identity: Omit<SuggestionIdentity, 'composerRevision'>;
}

interface Operation {
  opId: string;
  view: SuggestionView;
  identity: SuggestionIdentity;
  controller: AbortController;
  delivered: boolean;
}

let counter = 0;
function defaultId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

export class ReplySuggestionState {
  private offer?: Offer;
  private operation?: Operation;
  private readonly ended: Array<{ opId?: string; offerId?: string; reason: SuggestionDismissReason }> = [];

  constructor(private readonly newId: () => string = defaultId) {}

  /**
   * A new answer may be offered to the composer of `view`. Any earlier offer or operation ends: only the latest
   * answer of the visible conversation can have a suggestion.
   */
  offerFor(view: SuggestionView, identity: Omit<SuggestionIdentity, 'composerRevision'>): string {
    this.dismiss('superseded');
    const offerId = `offer-${this.newId()}`;
    this.offer = { offerId, view, identity: { ...identity } };
    return offerId;
  }

  /**
   * The composer of `view` answered the offer: it is empty, with no files, at `composerRevision`. Returns the operation
   * to run, or undefined when the offer is not current, came from another view, or the identity moved on.
   */
  start(offerId: string, view: SuggestionView, composerRevision: number, now: Omit<SuggestionIdentity, 'composerRevision'>):
    { opId: string; identity: SuggestionIdentity; signal: AbortSignal } | undefined {
    const offer = this.offer;
    if (!offer || offer.offerId !== offerId || offer.view !== view) return undefined;
    if (!Number.isSafeInteger(composerRevision) || composerRevision < 0) return undefined;
    this.offer = undefined;
    if (!sameIdentity(offer.identity, now)) return undefined;
    const opId = `op-${this.newId()}`;
    const identity: SuggestionIdentity = { ...offer.identity, composerRevision };
    const controller = new AbortController();
    this.operation = { opId, view, identity, controller, delivered: false };
    return { opId, identity, signal: controller.signal };
  }

  /**
   * The suggestion arrived. It may be shown only when this operation is still the live one and every part of its
   * identity, apart from the composer revision the composer checks itself, is still the same. Returns the view to
   * show it in.
   */
  deliverable(opId: string, now: Omit<SuggestionIdentity, 'composerRevision'>): SuggestionView | undefined {
    const operation = this.operation;
    if (!operation || operation.opId !== opId || operation.delivered) return undefined;
    if (!sameIdentity(operation.identity, now)) {
      this.dismiss('stale');
      return undefined;
    }
    operation.delivered = true;
    return operation.view;
  }

  /** The composer filled the suggestion in at the revision it was made for. The operation is over. */
  accepted(opId: string, view: SuggestionView, composerRevision: number): boolean {
    const operation = this.operation;
    if (!operation || operation.opId !== opId || operation.view !== view || !operation.delivered
      || operation.identity.composerRevision !== composerRevision) return false;
    this.operation = undefined;
    this.ended.push({ opId, reason: 'accepted' });
    return true;
  }

  /** The operation `opId` is over without a suggestion to show (none, failed, stale). Another operation is untouched. */
  end(opId: string, reason: SuggestionDismissReason): void {
    const operation = this.operation;
    if (!operation || operation.opId !== opId) return;
    operation.controller.abort();
    this.operation = undefined;
    this.ended.push({ opId, reason });
  }

  /**
   * End the offer and the operation: the request is aborted and a late answer is not shown. `filter` ends only one
   * agent's or one view's suggestion; without it, every one.
   */
  dismiss(reason: SuggestionDismissReason, filter: { agentId?: string; view?: SuggestionView } = {}): boolean {
    const matches = (view: SuggestionView, agentId: string) =>
      (filter.view === undefined || filter.view === view) && (filter.agentId === undefined || filter.agentId === agentId);
    let ended = false;
    if (this.offer && matches(this.offer.view, this.offer.identity.agentId)) {
      this.ended.push({ offerId: this.offer.offerId, reason });
      this.offer = undefined;
      ended = true;
    }
    const operation = this.operation;
    if (operation && matches(operation.view, operation.identity.agentId)) {
      operation.controller.abort();
      this.ended.push({ opId: operation.opId, reason });
      this.operation = undefined;
      ended = true;
    }
    if (this.ended.length > 50) this.ended.splice(0, this.ended.length - 50);
    return ended;
  }

  /** What is live now, for tests and diagnostics. Never a suggestion's text. */
  snapshot(): { offerId?: string; opId?: string; view?: SuggestionView; agentId?: string; ended: ReadonlyArray<{ opId?: string; offerId?: string; reason: SuggestionDismissReason }> } {
    return {
      ...(this.offer ? { offerId: this.offer.offerId, view: this.offer.view, agentId: this.offer.identity.agentId } : {}),
      ...(this.operation ? { opId: this.operation.opId, view: this.operation.view, agentId: this.operation.identity.agentId } : {}),
      ended: [...this.ended],
    };
  }
}

function sameIdentity(a: Omit<SuggestionIdentity, 'composerRevision'>, b: Omit<SuggestionIdentity, 'composerRevision'>): boolean {
  return a.workspaceId === b.workspaceId && a.conversationId === b.conversationId && a.branchId === b.branchId
    && a.agentId === b.agentId && a.turnId === b.turnId && a.settingsRevision === b.settingsRevision;
}
