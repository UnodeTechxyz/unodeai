/**
 * Host-observed timing for one delivered turn. The start comes from the MessageBus timestamp, so time
 * spent waiting in a session inbox remains visible. Human approval is reported independently and is not
 * charged to the agent turn.
 */
export interface TurnTiming {
  startedAt: string;
  settledAt: string;
  /** Queueing, model time, tools, and host-authored continuations; excludes human approval waits. */
  durationMs: number;
  /** Human approval time removed from durationMs. */
  approvalWaitMs: number;
}

interface ActiveTurnTiming {
  startedAtMs: number;
  approvalWaitMs: number;
}

/** One session can execute only one turn at a time, so session id is the safe correlation key. */
export class TurnTimingTracker {
  private active = new Map<string, ActiveTurnTiming>();

  constructor(private readonly now: () => number = Date.now) {}

  begin(sessionId: string, startedAt: string | undefined): void {
    const parsed = startedAt ? Date.parse(startedAt) : Number.NaN;
    this.active.set(sessionId, {
      startedAtMs: Number.isFinite(parsed) ? parsed : this.now(),
      approvalWaitMs: 0,
    });
  }

  recordApproval(sessionId: string, waitMs: number): void {
    const active = this.active.get(sessionId);
    if (!active) { return; }
    active.approvalWaitMs += Math.max(0, Math.round(Number.isFinite(waitMs) ? waitMs : 0));
  }

  finish(sessionId: string): TurnTiming | undefined {
    const active = this.active.get(sessionId);
    if (!active) { return undefined; }
    this.active.delete(sessionId);
    const settledAtMs = this.now();
    const totalMs = Math.max(0, settledAtMs - active.startedAtMs);
    const approvalWaitMs = Math.min(totalMs, active.approvalWaitMs);
    return {
      startedAt: new Date(active.startedAtMs).toISOString(),
      settledAt: new Date(settledAtMs).toISOString(),
      durationMs: totalMs - approvalWaitMs,
      approvalWaitMs,
    };
  }
}
