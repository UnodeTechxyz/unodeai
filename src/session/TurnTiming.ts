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
  /**
   * Human approval time removed from durationMs. Overlapping approvals count once. It includes a wait that fell
   * inside the turn's queue time: one the agent's start raised, or one an earlier turn was still waiting on.
   */
  approvalWaitMs: number;
  /**
   * Where `durationMs` went, as the host observed it. Absent on a record written before v0.9.92: the breakdown was
   * not recorded, which is never the same as zero.
   */
  phases?: TurnTimingPhases;
}

/**
 * What the host last observed. A phase lasts until the next observed event, so `provider-wait` says only that no
 * later event had arrived; it does not claim the provider was queued, reading or reasoning.
 */
export type TurnTimingPhase = 'host' | 'provider-wait' | 'reasoning' | 'responding' | 'tool';

/** The six time buckets partition `durationMs` exactly. */
export interface TurnTimingPhases {
  /** In the session inbox, before the turn began to execute. */
  queuedMs: number;
  hostMs: number;
  providerWaitMs: number;
  reasoningMs: number;
  respondingMs: number;
  toolMs: number;
  providerWaitCount: number;
  /** The longest single provider wait. An approval inside a wait pauses it; it does not split it. */
  longestProviderWaitMs: number;
}

/** The live phase of a running turn. The host is its only source; a view never derives one. */
export interface TurnPhaseSnapshot {
  phase: TurnTimingPhase;
  phaseStartedAt: string;
  turnStartedAt: string;
  openTools: number;
  /**
   * The turn time so far by the measure the finished turn reports: no human wait is in it. It was true at
   * `observedAt` and grows from there while no approval is pending.
   */
  activeMs: number;
  /** The same measure for the current phase alone: a decision inside a phase pauses it and does not restart it. */
  phaseActiveMs: number;
  /**
   * How many tool calls have been open in the current tool phase; 0 in any other phase. With exactly one, the
   * phase time is that call's own time. With more, calls overlapped and the phase time belongs to none of them.
   */
  phaseToolCalls: number;
  observedAt: string;
  /** A human decision is open. The turn clock is paused and the label is the approval, not the tool behind it. */
  approvalPending: boolean;
  /** When the open pause began, however many decisions it holds. */
  approvalStartedAt?: string;
}

/**
 * The human waits of one session. They belong to the session, not to a turn: a decision can open while the agent
 * starts or while a request is still queued, and it can still be open when the next turn begins.
 */
interface SessionPauses {
  /** Open human decisions. However many are open, the clock is paused once. */
  open: Set<string>;
  /** When the current pause began; undefined while no decision is open. */
  startedAtMs?: number;
  /**
   * Ended pauses, oldest first and never overlapping. A later turn takes the part inside its queue out of it.
   * None is ever dropped: a request can wait in the queue through any number of them, and a dropped one would
   * come back as queue time with both identities still holding. The cost is two numbers per decision.
   */
  ended: Array<{ startMs: number; endMs: number }>;
}

interface ActiveTurnTiming {
  startedAtMs: number;
  /** The one clock. Every handler advances it before applying its event. */
  lastAtMs: number;
  phase: TurnTimingPhase;
  phaseStartedAtMs: number;
  /** Time in the current phase with no human wait in it. */
  phaseActiveMs: number;
  phaseToolCalls: number;
  phases: TurnTimingPhases;
  approvalWaitMs: number;
  /** Each open call, with the approval wait the turn had reached when it opened. */
  openTools: Map<string, number>;
  pauses: SessionPauses;
  currentWaitMs: number;
  /** Unbroken time with nothing from the provider, while no tool and no approval is open. */
  silence: { active: boolean; ms: number };
  /** The silence each open first-action call found when it arrived, kept until the host has answered it. */
  heldSilence: Map<string, number>;
  /** What the silence resumes from when the last open call closes: the longest silence a refused call had found. */
  resumeSilenceMs: number;
}

/** One session can execute only one turn at a time, so session id is the safe correlation key. */
export class TurnTimingTracker {
  private active = new Map<string, ActiveTurnTiming>();
  private pauses = new Map<string, SessionPauses>();

  constructor(private readonly now: () => number = Date.now) {}

  begin(sessionId: string, startedAt: string | undefined): void {
    const nowMs = this.now();
    const parsed = startedAt ? Date.parse(startedAt) : Number.NaN;
    // A bus timestamp ahead of this clock would make the queue negative; the turn then starts now.
    const startedAtMs = Number.isFinite(parsed) && parsed <= nowMs ? parsed : nowMs;
    const pauses = this.pausesOf(sessionId);
    // The part of the queue during which a person was deciding is that person's time, as it is inside the turn.
    let waitedMs = 0;
    for (const pause of pauses.ended) waitedMs += overlapMs(pause.startMs, pause.endMs, startedAtMs, nowMs);
    if (pauses.startedAtMs !== undefined) waitedMs += overlapMs(pauses.startedAtMs, nowMs, startedAtMs, nowMs);
    waitedMs = Math.min(waitedMs, nowMs - startedAtMs);
    this.active.set(sessionId, {
      startedAtMs,
      lastAtMs: nowMs,
      phase: 'host',
      phaseStartedAtMs: nowMs,
      phaseActiveMs: 0,
      phaseToolCalls: 0,
      phases: { ...EMPTY_PHASES, queuedMs: nowMs - startedAtMs - waitedMs },
      approvalWaitMs: waitedMs,
      openTools: new Map(),
      pauses,
      currentWaitMs: 0,
      silence: { active: false, ms: 0 },
      heldSilence: new Map(),
      resumeSilenceMs: 0,
    });
  }

  /**
   * The host sent a request to the provider. It opens a provider wait unless one is already open: a request that
   * follows a tool result continues the wait that result began.
   */
  modelRequest(sessionId: string): boolean {
    return this.apply(sessionId, (turn) => {
      turn.silence = { active: true, ms: 0 };
      if (turn.openTools.size > 0 || turn.phase === 'provider-wait') return false;
      this.enterProviderWait(turn);
      return true;
    });
  }

  reasoning(sessionId: string): boolean {
    return this.providerSpoke(sessionId, 'reasoning');
  }

  responding(sessionId: string): boolean {
    return this.providerSpoke(sessionId, 'responding');
  }

  /**
   * `holdsSilence` marks a call that may be the turn's first action. Any other call is something the provider
   * did, and restarts the silence for good. A first-action call restarts it only if the host accepts it: the
   * silence it found is kept, and `toolFinished` resumes from there when the host refused the call.
   */
  toolStarted(sessionId: string, callId: string, holdsSilence = false): boolean {
    return this.apply(sessionId, (turn) => {
      const opened = !turn.openTools.has(callId);
      if (holdsSilence) {
        if (opened) turn.heldSilence.set(callId, turn.silence.ms);
      } else {
        dropHeldSilence(turn);
      }
      turn.silence.ms = 0;
      if (opened) turn.openTools.set(callId, turn.approvalWaitMs);
      const entered = turn.phase !== 'tool';
      if (entered) this.setPhase(turn, 'tool');
      if (opened) turn.phaseToolCalls += 1;
      return opened || entered;
    });
  }

  /**
   * The time people took to decide while this call was open. It is inside the call's span and in no clock, so a
   * card that shows the span can leave it out and say so. Undefined for a call this turn has not opened.
   */
  callHumanWaitMs(sessionId: string, callId: string): number | undefined {
    const turn = this.active.get(sessionId);
    const atOpen = turn?.openTools.get(callId);
    if (!turn || atOpen === undefined) return undefined;
    this.advance(turn);
    return turn.approvalWaitMs - atOpen;
  }

  /**
   * A result for a call this turn never opened changes nothing. `refusedFirstAction` is for a call opened with
   * `holdsSilence` that the host refused: the provider has not acted yet, so its silence goes on from where the
   * call found it instead of starting again.
   */
  toolFinished(sessionId: string, callId: string, refusedFirstAction = false): boolean {
    return this.apply(sessionId, (turn) => {
      if (!turn.openTools.delete(callId)) return false;
      const held = turn.heldSilence.get(callId);
      turn.heldSilence.delete(callId);
      if (refusedFirstAction && held !== undefined) turn.resumeSilenceMs = Math.max(turn.resumeSilenceMs, held);
      if (turn.openTools.size === 0) {
        // The result is on its way back to the provider: its silence starts here.
        turn.silence = { active: true, ms: turn.resumeSilenceMs };
        turn.resumeSilenceMs = 0;
        this.enterProviderWait(turn);
      }
      return true;
    });
  }

  /**
   * A human decision opened for this session, with or without a running turn. Returns whether a running turn's
   * snapshot changed: only the first open decision pauses the clock.
   */
  approvalStarted(sessionId: string, approvalId: string): boolean {
    const turn = this.active.get(sessionId);
    if (turn) this.advance(turn);
    const pauses = this.pausesOf(sessionId);
    if (pauses.open.has(approvalId)) return false;
    pauses.open.add(approvalId);
    if (pauses.open.size > 1) return false;
    pauses.startedAtMs = this.pauseInstant(turn, pauses);
    return turn !== undefined;
  }

  /** The decision ended. The clock runs again only when no other decision is open. */
  approvalFinished(sessionId: string, approvalId: string): boolean {
    const turn = this.active.get(sessionId);
    if (turn) this.advance(turn);
    const pauses = this.pauses.get(sessionId);
    if (!pauses || !pauses.open.delete(approvalId) || pauses.open.size > 0) return false;
    const endMs = this.pauseInstant(turn, pauses);
    const startMs = pauses.startedAtMs ?? endMs;
    pauses.startedAtMs = undefined;
    if (endMs > startMs) pauses.ended.push({ startMs, endMs });
    return turn !== undefined;
  }

  snapshot(sessionId: string): TurnPhaseSnapshot | undefined {
    const turn = this.active.get(sessionId);
    if (!turn) return undefined;
    const approvalStartedAtMs = turn.pauses.open.size > 0 ? turn.pauses.startedAtMs : undefined;
    return {
      phase: turn.phase,
      phaseStartedAt: new Date(turn.phaseStartedAtMs).toISOString(),
      turnStartedAt: new Date(turn.startedAtMs).toISOString(),
      openTools: turn.openTools.size,
      activeMs: activeMs(turn.phases),
      phaseActiveMs: turn.phaseActiveMs,
      phaseToolCalls: turn.phaseToolCalls,
      observedAt: new Date(turn.lastAtMs).toISOString(),
      approvalPending: turn.pauses.open.size > 0,
      ...(approvalStartedAtMs !== undefined ? { approvalStartedAt: new Date(approvalStartedAtMs).toISOString() } : {}),
    };
  }

  /**
   * How long the provider has been silent without a break, or undefined before the first request of the turn. A
   * running tool and an open approval pause it; any provider event restarts it at zero.
   */
  providerSilenceMs(sessionId: string): number | undefined {
    const turn = this.active.get(sessionId);
    if (!turn) return undefined;
    this.advance(turn);
    return turn.silence.active ? turn.silence.ms : undefined;
  }

  /**
   * The running turn's time so far by the measure a finished turn reports, with the human wait beside it and the
   * phases that time went to. Undefined when no turn is running.
   */
  elapsed(sessionId: string): { activeMs: number; approvalWaitMs: number; phases: TurnTimingPhases } | undefined {
    const turn = this.active.get(sessionId);
    if (!turn) return undefined;
    this.advance(turn);
    return { activeMs: activeMs(turn.phases), approvalWaitMs: turn.approvalWaitMs, phases: { ...turn.phases } };
  }

  finish(sessionId: string): TurnTiming | undefined {
    const turn = this.active.get(sessionId);
    if (!turn) { return undefined; }
    this.active.delete(sessionId);
    this.advance(turn);
    const phases = turn.phases;
    // The duration is the sum of its parts by construction, and the turn's span is that plus the approval wait.
    const durationMs = activeMs(phases);
    return {
      startedAt: new Date(turn.startedAtMs).toISOString(),
      settledAt: new Date(turn.startedAtMs + durationMs + turn.approvalWaitMs).toISOString(),
      durationMs,
      approvalWaitMs: turn.approvalWaitMs,
      phases,
    };
  }

  private apply(sessionId: string, event: (turn: ActiveTurnTiming) => boolean): boolean {
    const turn = this.active.get(sessionId);
    if (!turn) return false;
    this.advance(turn);
    return event(turn);
  }

  /** Charge the time since the last event to the approval wait when one is open, else to the current phase. */
  private advance(turn: ActiveTurnTiming): void {
    // A clock that steps backwards charges nothing and does not move the turn back.
    const elapsed = Math.max(0, this.now() - turn.lastAtMs);
    if (elapsed === 0) return;
    turn.lastAtMs += elapsed;
    if (turn.pauses.open.size > 0) {
      turn.approvalWaitMs += elapsed;
      return;
    }
    turn.phaseActiveMs += elapsed;
    if (turn.phase === 'host') turn.phases.hostMs += elapsed;
    else if (turn.phase === 'provider-wait') {
      turn.phases.providerWaitMs += elapsed;
      turn.currentWaitMs += elapsed;
      turn.phases.longestProviderWaitMs = Math.max(turn.phases.longestProviderWaitMs, turn.currentWaitMs);
    } else if (turn.phase === 'reasoning') turn.phases.reasoningMs += elapsed;
    else if (turn.phase === 'responding') turn.phases.respondingMs += elapsed;
    else turn.phases.toolMs += elapsed;
    if (turn.silence.active && turn.openTools.size === 0) turn.silence.ms += elapsed;
  }

  /** Reasoning or assistant content arrived. While a tool is open the turn stays in the tool phase. */
  private providerSpoke(sessionId: string, phase: 'reasoning' | 'responding'): boolean {
    return this.apply(sessionId, (turn) => {
      dropHeldSilence(turn);
      turn.silence.ms = 0;
      if (turn.openTools.size > 0 || turn.phase === phase) return false;
      this.setPhase(turn, phase);
      return true;
    });
  }

  private enterProviderWait(turn: ActiveTurnTiming): void {
    this.setPhase(turn, 'provider-wait');
    turn.phases.providerWaitCount += 1;
    turn.currentWaitMs = 0;
  }

  private setPhase(turn: ActiveTurnTiming, phase: TurnTimingPhase): void {
    turn.phase = phase;
    turn.phaseStartedAtMs = turn.lastAtMs;
    turn.phaseActiveMs = 0;
    turn.phaseToolCalls = 0;
  }

  private pausesOf(sessionId: string): SessionPauses {
    let pauses = this.pauses.get(sessionId);
    if (!pauses) {
      pauses = { open: new Set(), ended: [] };
      this.pauses.set(sessionId, pauses);
    }
    return pauses;
  }

  /**
   * The instant a pause begins or ends: the running turn's clock, else the wall clock. Never before the end of the
   * last pause, so a clock that steps backwards cannot make two pauses overlap and one wait count twice.
   */
  private pauseInstant(turn: ActiveTurnTiming | undefined, pauses: SessionPauses): number {
    const at = turn ? turn.lastAtMs : this.now();
    const last = pauses.ended[pauses.ended.length - 1];
    return last ? Math.max(at, last.endMs) : at;
  }
}

/** The provider produced something else, so the silence has restarted and no held value outlives that. */
function dropHeldSilence(turn: ActiveTurnTiming): void {
  turn.heldSilence.clear();
  turn.resumeSilenceMs = 0;
}

function activeMs(phases: TurnTimingPhases): number {
  return phases.queuedMs + phases.hostMs + phases.providerWaitMs + phases.reasoningMs + phases.respondingMs
    + phases.toolMs;
}

/** How much of [start, end) lies inside [from, to). */
function overlapMs(start: number, end: number, from: number, to: number): number {
  return Math.max(0, Math.min(end, to) - Math.max(start, from));
}

const EMPTY_PHASES: TurnTimingPhases = {
  queuedMs: 0,
  hostMs: 0,
  providerWaitMs: 0,
  reasoningMs: 0,
  respondingMs: 0,
  toolMs: 0,
  providerWaitCount: 0,
  longestProviderWaitMs: 0,
};

const PHASE_FIELDS = [
  'queuedMs', 'hostMs', 'providerWaitMs', 'reasoningMs', 'respondingMs', 'toolMs', 'providerWaitCount',
  'longestProviderWaitMs',
] as const satisfies ReadonlyArray<keyof TurnTimingPhases>;

/**
 * A stored phase breakdown, rebuilt field by field, or nothing. It is kept only when it is one the tracker could
 * have built for a turn of `durationMs`: every value a non-negative whole number, the six buckets adding up to the
 * duration, and the longest wait no longer than all waits together. Anything else is "not recorded".
 */
export function parseTurnTimingPhases(raw: unknown, durationMs: number): TurnTimingPhases | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const phases = {} as TurnTimingPhases;
  for (const field of PHASE_FIELDS) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
    phases[field] = value;
  }
  const parts = phases.queuedMs + phases.hostMs + phases.providerWaitMs + phases.reasoningMs + phases.respondingMs
    + phases.toolMs;
  if (parts !== durationMs || phases.longestProviderWaitMs > phases.providerWaitMs) return undefined;
  return phases;
}
