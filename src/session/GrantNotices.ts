/**
 * v0.9.100: what became of telling an agent about a file-access grant.
 *
 * A notice is not a user message: it opens no request, resumes nothing and never shows as the person's words. Each
 * grant is its own item with its own steer attempt, so a receipt settles that item only. An item settles once, and a
 * receipt that arrives afterwards changes nothing. The access itself does not depend on any of this: file tools check
 * the grants on every call.
 */

export type GrantNoticeNotTold =
  /** A delegated worker's turn: its result has already gone back when the turn ends, so nobody would read another. */
  | 'worker'
  /** The agent is running, or owes a turn to, another request. */
  | 'other-request'
  /** The turn ended in an error. */
  | 'turn-failed'
  /** The person's next message was already waiting. */
  | 'queued-message'
  /** The coordinator is on hold after Stop. */
  | 'held'
  /** No turn of this request is left to tell. */
  | 'no-turn'
  /** The person stopped it or cleared the chat, or the agent is gone. They know; no line is written for this one. */
  | 'stopped';

export type GrantNoticeReport =
  /** The current state, written at once where the turn cannot be told: no promise of how it ends. */
  | { kind: 'waiting' }
  /** The turn accepted the notice. */
  | { kind: 'told' }
  /** A turn of the same request will carry it. */
  | { kind: 'continues' }
  | { kind: 'not-told'; reason: GrantNoticeNotTold };

export interface GrantNoticeItem {
  readonly requestId: string;
  readonly text: string;
  /** The turn was the person's or the host's own, so one more turn has someone to answer to. */
  readonly topLevel: boolean;
  readonly report: (report: GrantNoticeReport) => void;
}

interface OpenItem extends GrantNoticeItem {
  settled: boolean;
}

/** The turn owed once a turn has ended: it carries every item of its request that was not told. */
export interface GrantContinuation {
  readonly requestId: string;
  readonly correlationId: string;
  readonly texts: string[];
  /** Slot reserved in the request's task, so the turn's own end does not finalize it. */
  readonly taskId: string;
}

const say = (item: GrantNoticeItem, report: GrantNoticeReport): void => {
  try { item.report(report); } catch { /* A notice never decides what runs next. */ }
};

export class GrantNotices {
  /** Items of a running turn that have no result yet. They cannot outlive it: its end settles all of them. */
  private readonly open = new Map<string, OpenItem[]>();
  private readonly continuations = new Map<string, GrantContinuation>();

  /** Settle an item before it was ever open. */
  static settleAtOnce(item: GrantNoticeItem, report: GrantNoticeReport): void {
    say(item, report);
  }

  add(sessionId: string, item: GrantNoticeItem): OpenItem {
    const entry: OpenItem = { ...item, settled: false };
    this.open.set(sessionId, [...(this.open.get(sessionId) ?? []), entry]);
    return entry;
  }

  /**
   * The answer of this item's own steer attempt, or that there is none to wait for. Accepted settles it. Otherwise a
   * delegated turn's item is not told, and a top-level turn's waits for the turn's end. No effect on a settled item.
   */
  answered(sessionId: string, item: OpenItem, accepted: boolean): void {
    if (item.settled) return;
    if (accepted) { this.settle(sessionId, item, { kind: 'told' }); return; }
    if (!item.topLevel) { this.settle(sessionId, item, { kind: 'not-told', reason: 'worker' }); return; }
    say(item, { kind: 'waiting' });
  }

  private settle(sessionId: string, item: OpenItem, report: GrantNoticeReport): void {
    item.settled = true;
    const left = (this.open.get(sessionId) ?? []).filter((row) => row !== item);
    if (left.length) this.open.set(sessionId, left); else this.open.delete(sessionId);
    say(item, report);
  }

  /**
   * The turn has ended. Every item without a result gets its one result now, and a later receipt finds it settled.
   * Delegated items are not told. The caller decides for the top-level items, all alike.
   */
  endTurn(sessionId: string, decide: (items: readonly GrantNoticeItem[]) => GrantNoticeReport): void {
    const items = this.open.get(sessionId) ?? [];
    this.open.delete(sessionId);
    const topLevel = items.filter((item) => item.topLevel);
    for (const item of items) item.settled = true;
    for (const item of items) if (!item.topLevel) say(item, { kind: 'not-told', reason: 'worker' });
    if (!topLevel.length) return;
    const report = decide(topLevel);
    for (const item of topLevel) say(item, report);
  }

  /** Stop or the agent's end: nothing is told and no turn follows. Returns the continuation that will now not run. */
  drop(sessionId: string, reason: GrantNoticeNotTold): GrantContinuation | undefined {
    const items = this.open.get(sessionId) ?? [];
    this.open.delete(sessionId);
    for (const item of items) { item.settled = true; say(item, { kind: 'not-told', reason }); }
    const continuation = this.continuations.get(sessionId);
    this.continuations.delete(sessionId);
    return continuation;
  }

  continuationOf(sessionId: string): GrantContinuation | undefined {
    return this.continuations.get(sessionId);
  }

  /**
   * A session owes one turn at a time, and nothing replaces it: the turn owed has a task slot and a mark of its own, and
   * only that turn or its withdrawal settles them. Returns false, changing nothing, when one is already owed.
   */
  setContinuation(sessionId: string, continuation: GrantContinuation): boolean {
    if (this.continuations.has(sessionId)) return false;
    this.continuations.set(sessionId, continuation);
    return true;
  }

  takeContinuation(sessionId: string): void {
    this.continuations.delete(sessionId);
  }

  /** The session whose owed turn belongs to this request. An open item needs no answer here: its turn is live. */
  sessionsOwingTurnOf(requestId: string): string[] {
    return [...this.continuations].filter(([, continuation]) => continuation.requestId === requestId).map(([sessionId]) => sessionId);
  }
}
