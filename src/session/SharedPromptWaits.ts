/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Shared prompt waits (v0.9.92)
 *  One prompt can have several sessions waiting on its answer: the approval to mount an MCP server
 *  that more than one starting agent is granted. The decision is shared. The time each session
 *  spends waiting for it is that session's own, so each has its own turn clock paused: from when
 *  it starts waiting, or from when the prompt opens if that is later, until the prompt ends or the
 *  session stops waiting.
 *
 *  More than one prompt can be open for a key. A start that gives up at its deadline leaves its
 *  dialog on screen, and a retry opens a second one behind it. The rule that keeps every clock
 *  right through that: a session that is waiting on a key is paused for every prompt open for the
 *  key, and a session that is not waiting on it is paused for none.
 *--------------------------------------------------------------------------------------------*/
import { randomUUID } from 'crypto';

/** What pauses and releases one session's turn clock for a human decision. */
export interface HumanWaitClock {
  approvalStarted(sessionId: string, approvalId: string): void;
  approvalFinished(sessionId: string, approvalId: string): void;
}

export class SharedPromptWaits {
  /** key → the sessions waiting on it, each with how many of its waits are open. */
  private readonly waiters = new Map<string, Map<string, number>>();
  /** key → the ids of the prompts that are open for it. */
  private readonly open = new Map<string, Set<string>>();

  constructor(private readonly clock: HumanWaitClock, private readonly newId: () => string = randomUUID) {}

  /**
   * `sessionId` starts waiting on whatever `key` is waiting for. Its clock is paused from now for every prompt that
   * is open for the key. The returned function ends this wait; calling it again does nothing.
   */
  join(key: string, sessionId: string): () => void {
    let sessions = this.waiters.get(key);
    if (!sessions) {
      sessions = new Map();
      this.waiters.set(key, sessions);
    }
    const waits = sessions.get(sessionId) ?? 0;
    sessions.set(sessionId, waits + 1);
    if (waits === 0) {
      for (const promptId of this.promptsOf(key)) this.clock.approvalStarted(sessionId, promptId);
    }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const current = this.waiters.get(key);
      const remaining = (current?.get(sessionId) ?? 1) - 1;
      if (remaining > 0) {
        current?.set(sessionId, remaining);
        return;
      }
      current?.delete(sessionId);
      if (current?.size === 0) this.waiters.delete(key);
      // It no longer waits for the person, whichever prompts are still on screen: every one of them is released,
      // not only the newest, or an older dialog that is answered later would leave this session paused for good.
      for (const promptId of this.promptsOf(key)) this.clock.approvalFinished(sessionId, promptId);
    };
  }

  /** The wait of one prompt for `key`: while it is open, every session waiting on the key has its clock paused. */
  prompt(key: string): <T>(wait: () => PromiseLike<T>) => PromiseLike<T> {
    return async (wait) => {
      const promptId = this.newId();
      let prompts = this.open.get(key);
      if (!prompts) {
        prompts = new Set();
        this.open.set(key, prompts);
      }
      prompts.add(promptId);
      for (const sessionId of this.sessionsOf(key)) this.clock.approvalStarted(sessionId, promptId);
      try {
        return await wait();
      } finally {
        prompts.delete(promptId);
        if (prompts.size === 0 && this.open.get(key) === prompts) this.open.delete(key);
        for (const sessionId of this.sessionsOf(key)) this.clock.approvalFinished(sessionId, promptId);
      }
    };
  }

  /**
   * Wait for `pending` for at most `timeoutMs`, counted among the waiters of `key` for exactly as long as this
   * wait lasts. A wait that runs out stops being a wait for the person, even though the prompt stays open.
   */
  async waitAs<T>(
    key: string,
    sessionId: string,
    pending: Promise<T>,
    timeoutMs: number,
  ): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
    const end = this.join(key, sessionId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending.then((value) => ({ timedOut: false as const, value })),
        new Promise<{ timedOut: true }>((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, timeoutMs));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      end();
    }
  }

  private sessionsOf(key: string): string[] {
    return [...(this.waiters.get(key)?.keys() ?? [])];
  }

  private promptsOf(key: string): string[] {
    return [...(this.open.get(key) ?? [])];
  }
}
