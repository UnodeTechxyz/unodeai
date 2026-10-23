/**
 * v0.9.91: the host's identity for one tool call within one host turn. Every backend allocates it when it emits
 * `tool_use` and reuses it for that call's `tool_result`, so same-name and interleaved calls pair exactly and a
 * turn can prove which uses received a result.
 *
 * Provider ids (OpenAI `tool_call.id`, Claude `tool_use_id`, Codex item ids) stay private to the backend: they
 * only find the host id again. They are never the host id, because compatible providers may omit or reuse them
 * and the stream parser's `tool_<index>` fallback restarts on every model round.
 */
export class TurnToolCallIds {
  private sequence = 0;
  private readonly openByProviderId = new Map<string, string>();
  /** Provider ids opened again while still open: no result for them can say which call it belongs to. */
  private readonly ambiguousProviderIds = new Set<string>();

  /** A new host turn: ids restart and no provider id carries over. */
  reset(): void {
    this.sequence = 0;
    this.openByProviderId.clear();
    this.ambiguousProviderIds.clear();
  }

  /**
   * The id for a new tool use. A provider id, when given, is remembered so the result can find this id. A provider
   * id reused while its earlier call is still open becomes ambiguous for the rest of the turn: neither call can be
   * found from it any more, so both stay unmatched instead of one result updating the wrong call.
   */
  open(providerId?: string): string {
    const callId = `call-${++this.sequence}`;
    if (providerId) {
      if (this.openByProviderId.has(providerId) || this.ambiguousProviderIds.has(providerId)) {
        this.openByProviderId.delete(providerId);
        this.ambiguousProviderIds.add(providerId);
      } else {
        this.openByProviderId.set(providerId, callId);
      }
    }
    return callId;
  }

  /** Whether this provider id was reused while open this turn, so nothing keyed by it names one call. */
  isAmbiguous(providerId: string): boolean {
    return this.ambiguousProviderIds.has(providerId);
  }

  /**
   * The id opened for this provider id, released so it cannot pair twice. A result the host never saw begin, or one
   * whose provider id is ambiguous, receives a fresh id: it stays an unmatched result rather than borrowing another
   * call's identity.
   */
  close(providerId: string): string {
    const callId = this.ambiguousProviderIds.has(providerId) ? undefined : this.openByProviderId.get(providerId);
    if (callId === undefined) return this.open();
    this.openByProviderId.delete(providerId);
    return callId;
  }
}

/**
 * Host facts about one provider call that arrive apart from its result: a gate's refusal, a bridge tool's typed
 * outcome. A fact joins the result by the backend-private provider id, and only while that id names exactly one
 * call. A fact for an id the call ids marked ambiguous, or a second fact noted for an id before a result took the
 * first, joins nothing for the rest of the turn: the result keeps the provider's own fact and the backend reports
 * the lost decision as a coverage gap.
 */
export class TurnProviderFacts<F> {
  private readonly pending = new Map<string, F>();
  private readonly conflicted = new Set<string>();

  constructor(private readonly callIds: TurnToolCallIds) {}

  /** A new host turn: no fact carries over. */
  reset(): void {
    this.pending.clear();
    this.conflicted.clear();
  }

  note(providerId: string, fact: F): void {
    if (this.conflicted.has(providerId)) return;
    if (this.pending.has(providerId)) {
      this.pending.delete(providerId);
      this.conflicted.add(providerId);
      return;
    }
    this.pending.set(providerId, fact);
  }

  /**
   * The fact noted for this result's provider id, released so it joins one result. `unjoined` is true when a fact
   * was noted for the id but cannot be attached to this result.
   */
  take(providerId: string): { fact?: F; unjoined: boolean } {
    const fact = this.pending.get(providerId);
    this.pending.delete(providerId);
    if (this.conflicted.has(providerId) || this.callIds.isAmbiguous(providerId)) {
      return { unjoined: fact !== undefined || this.conflicted.has(providerId) };
    }
    return fact === undefined ? { unjoined: false } : { fact, unjoined: false };
  }
}
