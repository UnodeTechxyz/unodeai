/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the Continue offer for a turn an agent's CLI began on its own (v0.9.103, F2; the Owner's option A)
 *
 *  A Claude CLI agent can start something in the background. When that finishes after the person's request ended, the
 *  CLI begins a turn of its own, in which a command is refused (the request has ended). The person is offered one
 *  non-modal Continue: it sends that agent an ordinary message through the same entry as chat Send, so the next request
 *  carries the usual grants, limits and approvals. Nothing about authority carries over. Dismissing does nothing.
 *--------------------------------------------------------------------------------------------*/

/** One unrequested turn of one launch of one agent, as SessionManager reported it. */
export interface UnrequestedTurnStarted {
  sessionId: string;
  launchId: string;
  taskId?: string;
  summary?: string;
}

export interface UnrequestedTurnOfferDeps {
  /** A non-modal notification with one action; resolves to the action's label, or undefined when dismissed. */
  show(text: string, action: string): PromiseLike<string | undefined>;
  /** A non-modal information line, without actions. */
  inform(text: string): void;
  /** The agent's display name, or undefined when there is no such agent. */
  agentName(sessionId: string): string | undefined;
  /** Whether `launchId` is the backend this session runs now. Must be synchronous. */
  isCurrentLaunch(sessionId: string, launchId: string): boolean;
  /** The entry chat Send uses, for an ordinary message of the person to this agent. */
  sendPersonMessage(sessionId: string, text: string): void | Promise<void>;
}

export const CONTINUE_ACTION = 'Continue';
export const OFFER_ENDED_NOTICE = 'That agent session has ended; nothing was sent.';

/** The text of the offer. `summary` is the CLI's own words, shown as data. */
export function unrequestedTurnOfferText(name: string, summary: string | undefined): string {
  const what = summary ? ` (${summary})` : '';
  return `${name}: something it started in the background finished after your request ended${what}. It can read files in `
    + 'that turn but cannot run commands or change files. To let it act on the result, press Continue.';
}

/** The ordinary message Continue sends. */
export function continueMessageText(summary: string | undefined): string {
  const what = summary ? ` (${summary})` : '';
  return `Continue: something you started in the background finished after my last request ended${what}. Check its `
    + 'result and finish what that request needs.';
}

export class UnrequestedTurnOffers {
  /** At most one outstanding offer per agent. */
  private readonly outstanding = new Set<string>();

  constructor(private readonly deps: UnrequestedTurnOfferDeps) {}

  /** Offer Continue for one unrequested turn. A second wake while this agent's offer is open adds no second offer. */
  offer(event: UnrequestedTurnStarted): void {
    if (this.outstanding.has(event.sessionId)) return;
    const name = this.deps.agentName(event.sessionId);
    if (!name || !this.deps.isCurrentLaunch(event.sessionId, event.launchId)) return;
    this.outstanding.add(event.sessionId);
    let shown: PromiseLike<string | undefined>;
    try {
      shown = this.deps.show(unrequestedTurnOfferText(name, event.summary), CONTINUE_ACTION);
    } catch {
      this.outstanding.delete(event.sessionId);
      return;
    }
    Promise.resolve(shown).then((choice) => {
      this.outstanding.delete(event.sessionId);
      if (choice !== CONTINUE_ACTION) return;
      // Checked here, synchronously, immediately before delivery: a restarted, removed or stopped agent gets nothing.
      if (!this.deps.isCurrentLaunch(event.sessionId, event.launchId)) {
        this.deps.inform(OFFER_ENDED_NOTICE);
        return;
      }
      void Promise.resolve(this.deps.sendPersonMessage(event.sessionId, continueMessageText(event.summary))).catch(() => undefined);
    }, () => { this.outstanding.delete(event.sessionId); });
  }
}
