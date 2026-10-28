/**
 * v0.9.99: a message the person sent is prepared before it reaches the agent (an @url mention is read, attachments
 * are admitted). Each preparation has its own cancellation. Stop, removing the agent, or clearing its conversation
 * cancels the preparations under way for that agent, and a cancelled preparation is never submitted, however late
 * its reads finish.
 */
export interface UserRequestPreparation {
  readonly signal: AbortSignal;
  /** True once Stop, removal or a clear cancelled it: the message must not be submitted. */
  cancelled(): boolean;
  /** The preparation finished (submitted, cancelled or failed); it is no longer tracked. */
  end(): void;
}

export class UserRequestPreparations {
  private readonly byAgent = new Map<string, Set<AbortController>>();

  begin(agentId: string): UserRequestPreparation {
    const controller = new AbortController();
    const set = this.byAgent.get(agentId) ?? new Set<AbortController>();
    set.add(controller);
    this.byAgent.set(agentId, set);
    return {
      signal: controller.signal,
      cancelled: () => controller.signal.aborted,
      end: () => {
        const current = this.byAgent.get(agentId);
        if (!current) return;
        current.delete(controller);
        if (current.size === 0) this.byAgent.delete(agentId);
      },
    };
  }

  /** Cancel every preparation under way for `agentId`; returns how many there were. */
  cancel(agentId: string): number {
    const set = this.byAgent.get(agentId);
    if (!set) return 0;
    this.byAgent.delete(agentId);
    for (const controller of set) controller.abort();
    return set.size;
  }

  pending(agentId: string): number {
    return this.byAgent.get(agentId)?.size ?? 0;
  }

  /** The agents with a preparation under way, whether or not their session is running. */
  agents(): string[] {
    return [...this.byAgent.keys()];
  }
}

/** The chat line when Stop ends a message that was still being prepared. */
export const STOPPED_BEFORE_SENDING =
  'You stopped this message before it was sent. The agent did not receive it; send it again when you want it.';

/**
 * v0.9.99: what every Stop of the person does first, from any surface (the chat, the agent's row, Stop all): each
 * named agent's messages still being prepared are cancelled, and its chat says so. The session is stopped after.
 */
export function stopPreparing(
  preparations: UserRequestPreparations,
  agentIds: Iterable<string>,
  tell: (agentId: string, text: string) => void,
): void {
  for (const agentId of [...agentIds]) {
    if (preparations.cancel(agentId) > 0) tell(agentId, STOPPED_BEFORE_SENDING);
  }
}

/**
 * v0.9.99: prepare a sent message and submit it, unless its preparation was cancelled meanwhile. Each await is followed
 * by that check, so a read that finishes after Stop submits nothing.
 */
export async function prepareAndSubmit<Prepared>(
  preparations: UserRequestPreparations,
  agentId: string,
  steps: {
    prepare(signal: AbortSignal): Promise<Prepared>;
    submit(prepared: Prepared): void;
  },
): Promise<'submitted' | 'cancelled'> {
  const preparation = preparations.begin(agentId);
  try {
    const prepared = await steps.prepare(preparation.signal);
    if (preparation.cancelled()) return 'cancelled';
    steps.submit(prepared);
    return 'submitted';
  } finally {
    preparation.end();
  }
}
