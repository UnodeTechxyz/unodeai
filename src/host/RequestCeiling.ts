/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Request ceiling (v0.9.94)
 *
 *  A request limit is optional. When the person configured one, this gate owns what happens at it: each
 *  request moves `open -> awaiting-decision -> open | stopped`. A limit is checked at a boundary the host
 *  controls (a model request about to leave, a tool call about to act, a turn about to start) and never by
 *  waiting for a reminder or by reading an error string. Reaching a limit finishes nothing early: the
 *  response already under way completes, and the next boundary is held until the person decides.
 *
 *  A boundary that will be followed by a counted request reserves that request as it crosses, in the same
 *  step that lets it cross. So two callers that ask at the same count cannot both pass the last allowance.
 *
 *  Exactly one decision is open per request. Continue adds one tranche of each configured limit; the observed
 *  totals are never reset, so a later crossing asks again. Stop refuses what was held and asks the host to end
 *  the request's live turns through its ordinary stop path.
 *
 *  A request with no limit configured is never tracked: every boundary of it proceeds at once. A tracked
 *  request, its totals and its stop are kept until the host shows that nothing can continue the request.
 *
 *  VS Code-free: settings, the prompt, the stop path and the clock arrive as dependencies.
 *--------------------------------------------------------------------------------------------*/

import type { TokenCounts } from '../models/spend/Money';
import { MAX_REQUEST_COUNT, type RequestLimitsObservation } from '../observability/RequestCloseout';

export type {
  RequestBoundary,
  RequestBoundaryDetail,
  RequestBoundaryKind,
  RequestBoundaryOutcome,
} from '../backend/requestBoundary';

/** The limits of one request. A missing member is no limit of that kind. */
export interface RequestLimits {
  /** Provider requests the host counted for the request, root and delegated turns together. */
  providerTurns?: number;
  /** Raw tokens: input plus output, cached input counted once. Not a cost. */
  tokens?: number;
}

export type RequestLimitKind = 'providerTurns' | 'tokens';

/** Where a request can be held. `turn-start` is the host's own boundary before it starts a turn. */
export type RequestCeilingBoundaryKind = 'provider-request' | 'effect' | 'turn-start';
export type RequestCeilingBoundaryOutcome = 'proceed' | 'stopped';
export type RequestCeilingDecision = 'continue' | 'stop';

/**
 * How one counted provider request was counted. `request`: the host saw that one request leave. `turn`: the
 * host started a turn on a route where a CLI makes the requests inside it, and counts the turn as one.
 */
export type RequestCountKind = 'request' | 'turn';

/**
 * Why the gate stopped waiting for an answer, given as the reason of the aborted prompt signal.
 * `expired`: nobody answered inside the window, and the request was stopped. `withdrawn`: the last held step
 * ended by itself; nothing was decided and the request was not stopped. `failed`: the prompt itself failed,
 * and the request was stopped. `disposed`: the host is shutting down.
 */
export type RequestDecisionEnd = 'expired' | 'withdrawn' | 'failed' | 'disposed';

/** What the person is shown when a limit is reached. Totals and classes only: no prompt, path or tool input. */
export interface RequestCeilingDecisionFacts {
  requestId: string;
  /** The limits that are reached, provider turns first. `allowance` is the configured limit plus every tranche added. */
  reached: Array<{ limit: RequestLimitKind; configured: number; allowance: number; observed: number }>;
  /** What the request's closeout would record at this moment: totals, the held boundary and coverage. */
  limits: RequestLimitsObservation;
}

export interface RequestCeilingTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface RequestCeilingDeps {
  /** The limits configured now. Read once per request, when it begins. */
  readLimits(): RequestLimits;
  /**
   * Ask the person. The signal aborts when the gate no longer waits for the answer, with a `RequestDecisionEnd`
   * as its reason, so the prompt can show how the wait ended. A rejection is taken as Stop: a prompt that failed
   * must not let the request run on.
   */
  decide(facts: RequestCeilingDecisionFacts, signal: AbortSignal): Promise<RequestCeilingDecision>;
  /** End every live turn of the request through the ordinary stop path. Called once, when the request is stopped. */
  stopRequest(requestId: string): void;
  /**
   * The requests something in the host can still continue: a turn that is running, a message that is queued, a
   * result that is on its way. A tracked request is forgotten only when it is not among them.
   */
  reachableRequests(): ReadonlySet<string>;
  /** How long an unanswered decision stays open before it resolves as Stop. */
  decisionTimeoutMs?: number;
  timers?: RequestCeilingTimers;
}

/** A held tool call on a CLI route cannot wait for ever: an unanswered decision becomes Stop after this long. */
export const DEFAULT_REQUEST_DECISION_TIMEOUT_MS = 15 * 60_000;
/** Tracked requests above which the gate asks the host which of them can still continue, and forgets the rest. */
export const MAX_TRACKED_REQUESTS = 2_000;

const DEFAULT_TIMERS: RequestCeilingTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * The limits a settings value states. Only a positive whole number is a limit; anything else (absent, null,
 * zero, a fraction, text) is no limit of that kind. The value is never rounded into a limit nobody wrote.
 */
export function normalizeRequestLimits(raw: unknown): RequestLimits {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const providerTurns = positiveInteger(value.providerTurns);
  const tokens = positiveInteger(value.tokens);
  return {
    ...(providerTurns !== undefined ? { providerTurns } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
  };
}

function wholeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

/**
 * The raw tokens of one usage figure: input plus output. Cached input is a part of the input figure, so it is
 * already in the sum and is not added again.
 */
export function rawTokenTotal(counts: TokenCounts): number {
  return Math.min(wholeCount(counts.input) + wholeCount(counts.output), Number.MAX_SAFE_INTEGER);
}

function bounded(total: number): number {
  return Math.min(total, Number.MAX_SAFE_INTEGER);
}

interface HeldBoundary {
  kind: RequestCeilingBoundaryKind;
  /** The agent whose counted request follows this boundary, when one does. */
  reserveFor?: string;
  settle(outcome: RequestCeilingBoundaryOutcome): void;
}

interface OpenDecision {
  held: Set<HeldBoundary>;
  /** Aborted, with the reason, when the gate stops waiting for the person's answer. */
  prompt: AbortController;
  timer?: unknown;
}

interface TrackedRequest {
  /** The limits as configured when the request began. At least one is set. */
  configured: RequestLimits;
  state: 'open' | 'awaiting-decision' | 'stopped';
  /** Provider requests the host saw leave, one by one. */
  providerRequests: number;
  /** Turns the host started where a CLI makes the requests inside them. Each counts as one. */
  hostCountedTurns: number;
  /** Requests that were let across a boundary and are not counted yet, by the agent that will make them. */
  reserved: Map<string, number>;
  /** The raw tokens of every usage unit that is over. */
  settledTokens: number;
  /** The latest raw-token figure of each usage unit that is still open. */
  tokensByUnit: Map<string, number>;
  usageIncomplete: boolean;
  observedOnly: boolean;
  crossings: number;
  /** Tranches added so far. Only ever grows. */
  allowances: number;
  /** `allowances` when the last crossing was counted: asking again at the same allowance is the same crossing. */
  crossedAtAllowances?: number;
  heldBoundary?: RequestCeilingBoundaryKind;
  decision?: OpenDecision;
}

export class RequestCeilingGate {
  private readonly requests = new Map<string, TrackedRequest>();
  private readonly timers: RequestCeilingTimers;
  private readonly decisionTimeoutMs: number;
  private disposed = false;

  constructor(private readonly deps: RequestCeilingDeps) {
    this.timers = deps.timers ?? DEFAULT_TIMERS;
    const configured = deps.decisionTimeoutMs;
    this.decisionTimeoutMs = typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_REQUEST_DECISION_TIMEOUT_MS;
  }

  /**
   * Pin the limits configured at this moment for a new request. A later change of the setting applies to the
   * next request, never to one that is running. Calling it again for a request already begun changes nothing:
   * its limits stay pinned and its totals stay as they are.
   */
  begin(requestId: string): void {
    if (this.requests.has(requestId)) return;
    const configured = normalizeRequestLimits(this.deps.readLimits());
    if (configured.providerTurns === undefined && configured.tokens === undefined) return;
    this.forgetUnreachable();
    this.requests.set(requestId, {
      configured,
      // Once the host is shutting down nothing can ask the person, so a limited request does not run unlimited.
      state: this.disposed ? 'stopped' : 'open',
      providerRequests: 0,
      hostCountedTurns: 0,
      reserved: new Map(),
      settledTokens: 0,
      tokensByUnit: new Map(),
      usageIncomplete: false,
      observedOnly: false,
      crossings: 0,
      allowances: 0,
    });
  }

  /** Whether the request has a limit. A request stopped at its limit still has one. Everything else never waits here. */
  governs(requestId: string): boolean {
    return this.requests.has(requestId);
  }

  /**
   * Whether a boundary of the request asked now would wait for the person: a decision is open, or a limit is
   * reached. A caller reads it to tell a wait for the person from its own time; it holds nothing by itself.
   */
  wouldHold(requestId: string): boolean {
    const tracked = this.requests.get(requestId);
    if (!tracked || tracked.state === 'stopped') return false;
    return tracked.state === 'awaiting-decision' || this.reached(tracked).length > 0;
  }

  /**
   * One provider request of the request was counted, made by this agent. When that agent crossed a boundary for
   * it, this is the request it reserved there, and the total does not move a second time.
   */
  noteProviderRequest(requestId: string, agentId: string, counted: RequestCountKind): void {
    const tracked = this.requests.get(requestId);
    if (!tracked) return;
    const reserved = tracked.reserved.get(agentId) ?? 0;
    if (reserved > 1) tracked.reserved.set(agentId, reserved - 1);
    else tracked.reserved.delete(agentId);
    if (counted === 'turn') tracked.hostCountedTurns = bounded(tracked.hostCountedTurns + 1);
    else tracked.providerRequests = bounded(tracked.providerRequests + 1);
  }

  /**
   * The agent will make none of the requests it reserved: its turn ended, or was never sent. What it reserved is
   * given back. Without this a request that never left would be counted for good.
   */
  release(requestId: string, agentId: string): void {
    this.requests.get(requestId)?.reserved.delete(agentId);
  }

  /**
   * The latest token counts observed for one usage unit that is still open. A later report for the same unit
   * replaces the earlier one, so a running total reported twice is not counted twice; different units add up.
   */
  noteUsage(requestId: string, usageUnitId: string, counts: TokenCounts): void {
    this.requests.get(requestId)?.tokensByUnit.set(usageUnitId, rawTokenTotal(counts));
  }

  /**
   * A usage unit is over. With its terminal counts, they replace whatever was reported while it was open; without
   * them, the last figure it reported stays in the total. Either way the unit is no longer kept by itself.
   */
  settleUsage(requestId: string, usageUnitId: string, counts?: TokenCounts): void {
    const tracked = this.requests.get(requestId);
    if (!tracked) return;
    const last = tracked.tokensByUnit.get(usageUnitId) ?? 0;
    tracked.tokensByUnit.delete(usageUnitId);
    tracked.settledTokens = bounded(tracked.settledTokens + (counts ? rawTokenTotal(counts) : last));
  }

  /**
   * Some usage of the request is unknown. It is not counted as zero: the token total is a lower bound from now on
   * and the limits coverage says so. A provider-turn limit is counted by the host and stays exact.
   */
  markUsageIncomplete(requestId: string): void {
    const tracked = this.requests.get(requestId);
    if (tracked) tracked.usageIncomplete = true;
  }

  /**
   * The request ran on a route where a CLI makes the provider requests inside a turn the host starts. The host
   * counts that turn as one request, learns its tokens when it ends, and can hold neither. A limit then acts at
   * the next boundary the host does control.
   */
  markObservedOnly(requestId: string): void {
    const tracked = this.requests.get(requestId);
    if (tracked) tracked.observedOnly = true;
  }

  /**
   * May the request cross this boundary? Inside its limits: yes, at once. At a reached limit the call is held
   * until the person decides, together with every other boundary of the same request, behind one prompt.
   * A caller whose signal aborts is released as `stopped`; when it was the last one held, the prompt is closed
   * and the next boundary asks again.
   *
   * `reserveFor` names the agent that makes one counted request right after this boundary. That request is
   * reserved here, as the boundary is crossed, and `noteProviderRequest` for the same agent turns the
   * reservation into the count.
   */
  boundary(
    requestId: string,
    kind: RequestCeilingBoundaryKind,
    signal?: AbortSignal,
    reserveFor?: string,
  ): Promise<RequestCeilingBoundaryOutcome> {
    const tracked = this.requests.get(requestId);
    if (!tracked) return Promise.resolve('proceed');
    if (tracked.state === 'stopped') return Promise.resolve('stopped');
    if (tracked.state === 'open' && this.reached(tracked).length === 0) {
      this.reserve(tracked, reserveFor);
      return Promise.resolve('proceed');
    }
    // A caller that is already stopped is not held and opens no prompt.
    if (signal?.aborted) return Promise.resolve('stopped');

    return new Promise<RequestCeilingBoundaryOutcome>((resolve) => {
      const onAbort = (): void => {
        const decision = tracked.decision;
        if (!decision || !decision.held.delete(held)) return;
        resolve('stopped');
        if (decision.held.size === 0) this.withdraw(tracked, decision);
      };
      const held: HeldBoundary = {
        kind,
        ...(reserveFor !== undefined ? { reserveFor } : {}),
        settle: (outcome) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(outcome);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.hold(requestId, tracked, [held]);
    });
  }

  /**
   * The limits observation of the request for its closeout record: totals against the configured limits, how
   * often a limit was reached and continued, the decision and the held boundary. Undefined when the request has
   * no limit.
   */
  facts(requestId: string): RequestLimitsObservation | undefined {
    const tracked = this.requests.get(requestId);
    return tracked ? this.observation(tracked) : undefined;
  }

  /**
   * The host is shutting down. Every tracked request is stopped, every held boundary is refused, every prompt is
   * closed and no timer is left. The requests stay known, so a call that arrives late is still refused.
   */
  dispose(): void {
    this.disposed = true;
    for (const tracked of this.requests.values()) {
      tracked.state = 'stopped';
      const decision = tracked.decision;
      if (!decision) continue;
      const waiting = [...decision.held];
      decision.held.clear();
      this.close(tracked, decision, 'disposed');
      for (const boundary of waiting) boundary.settle('stopped');
    }
  }

  /**
   * Keep the tracked requests bounded without ever dropping a limit that could still apply. Above the bound the
   * host is asked which requests something can still continue; only the others are forgotten. A request whose
   * decision is open is kept, and when the host cannot say, everything is kept.
   */
  private forgetUnreachable(): void {
    if (this.requests.size < MAX_TRACKED_REQUESTS) return;
    let reachable: ReadonlySet<string>;
    try {
      reachable = this.deps.reachableRequests();
    } catch {
      return;
    }
    for (const [requestId, tracked] of this.requests) {
      if (tracked.decision) continue;
      if (!reachable.has(requestId)) this.requests.delete(requestId);
    }
  }

  private reserve(tracked: TrackedRequest, agentId: string | undefined): void {
    if (agentId !== undefined) tracked.reserved.set(agentId, (tracked.reserved.get(agentId) ?? 0) + 1);
  }

  private allowance(tracked: TrackedRequest, limit: RequestLimitKind): number | undefined {
    const configured = tracked.configured[limit];
    return configured === undefined ? undefined : Math.min(configured * (tracked.allowances + 1), Number.MAX_SAFE_INTEGER);
  }

  private observed(tracked: TrackedRequest, limit: RequestLimitKind): number {
    let total = 0;
    if (limit === 'providerTurns') {
      // A reserved request counts from the moment its boundary was crossed.
      for (const reserved of tracked.reserved.values()) total += reserved;
      return bounded(total + tracked.providerRequests + tracked.hostCountedTurns);
    }
    for (const tokens of tracked.tokensByUnit.values()) total += tokens;
    return bounded(total + tracked.settledTokens);
  }

  /** The limits whose observed total has reached the allowance. Reaching it exactly is reaching it. */
  private reached(tracked: TrackedRequest): RequestCeilingDecisionFacts['reached'] {
    const reached: RequestCeilingDecisionFacts['reached'] = [];
    for (const limit of ['providerTurns', 'tokens'] as const) {
      const configured = tracked.configured[limit];
      const allowance = this.allowance(tracked, limit);
      if (configured === undefined || allowance === undefined) continue;
      const observed = this.observed(tracked, limit);
      if (observed >= allowance) reached.push({ limit, configured, allowance, observed });
    }
    return reached;
  }

  private observation(tracked: TrackedRequest): RequestLimitsObservation {
    const { configured } = tracked;
    // A token limit over a total with unknown parts is checked against a lower bound, and says so.
    const partial = tracked.observedOnly || (configured.tokens !== undefined && tracked.usageIncomplete);
    return {
      coverage: partial ? 'partial' : 'complete',
      ...(configured.providerTurns !== undefined
        ? {
            providerTurns: {
              ceiling: configured.providerTurns,
              observed: this.observed(tracked, 'providerTurns'),
              // How many of them are turns counted as one each, so a reader can tell a count of requests from it.
              ...(tracked.hostCountedTurns > 0 ? { hostCountedTurns: tracked.hostCountedTurns } : {}),
            },
          }
        : {}),
      ...(configured.tokens !== undefined
        ? { tokens: { ceiling: configured.tokens, observed: this.observed(tracked, 'tokens') } }
        : {}),
      crossings: Math.min(tracked.crossings, MAX_REQUEST_COUNT),
      allowances: Math.min(tracked.allowances, MAX_REQUEST_COUNT),
      // A request the shutting-down host stopped before any limit was reached records no decision at a limit.
      decision: tracked.state === 'awaiting-decision'
        ? 'awaiting'
        : tracked.state === 'stopped' && tracked.crossings > 0
          ? 'stopped'
          : tracked.allowances > 0 ? 'continued' : 'none',
      ...(tracked.heldBoundary ? { heldBoundary: tracked.heldBoundary } : {}),
    };
  }

  /** Put boundaries behind the request's one open decision, opening it and asking the person when there is none. */
  private hold(requestId: string, tracked: TrackedRequest, boundaries: HeldBoundary[]): void {
    const joined = tracked.decision;
    const decision = joined ?? this.openDecision(tracked, boundaries[0].kind);
    for (const boundary of boundaries) decision.held.add(boundary);
    // Asked only after a boundary is held, so an answer can never arrive before there is one to release.
    if (!joined) this.ask(requestId, tracked, decision);
  }

  private openDecision(tracked: TrackedRequest, kind: RequestCeilingBoundaryKind): OpenDecision {
    tracked.state = 'awaiting-decision';
    tracked.heldBoundary = kind;
    if (tracked.crossedAtAllowances !== tracked.allowances) {
      tracked.crossings += 1;
      tracked.crossedAtAllowances = tracked.allowances;
    }
    const decision: OpenDecision = { held: new Set(), prompt: new AbortController() };
    tracked.decision = decision;
    return decision;
  }

  private ask(requestId: string, tracked: TrackedRequest, decision: OpenDecision): void {
    decision.timer = this.timers.set(() => this.settle(requestId, tracked, decision, 'stop', 'expired'), this.decisionTimeoutMs);
    const facts: RequestCeilingDecisionFacts = {
      requestId,
      reached: this.reached(tracked),
      limits: this.observation(tracked),
    };
    let answer: Promise<RequestCeilingDecision>;
    try {
      answer = Promise.resolve(this.deps.decide(facts, decision.prompt.signal));
    } catch (error) {
      answer = Promise.reject(error);
    }
    answer.then(
      // Only the exact word continues the request. Any other answer, and a prompt that failed, stops it.
      (answered) => this.settle(requestId, tracked, decision, answered === 'continue' ? 'continue' : 'stop'),
      () => this.settle(requestId, tracked, decision, 'stop', 'failed'),
    );
  }

  /**
   * Apply the one decision of an open prompt. An answer that arrives after the prompt was resolved is ignored.
   * `ended` says why the gate stopped waiting when it was not the person's answer that resolved it.
   */
  private settle(
    requestId: string,
    tracked: TrackedRequest,
    decision: OpenDecision,
    answered: RequestCeilingDecision,
    ended?: RequestDecisionEnd,
  ): void {
    if (tracked.decision !== decision) return;
    const waiting = [...decision.held];
    decision.held.clear();
    this.close(tracked, decision, ended);
    if (answered === 'continue') {
      tracked.state = 'open';
      // One tranche of every configured limit. The observed totals stay as they are.
      tracked.allowances += 1;
      tracked.heldBoundary = undefined;
      this.admit(requestId, tracked, waiting);
      return;
    }
    tracked.state = 'stopped';
    for (const boundary of waiting) boundary.settle('stopped');
    try {
      this.deps.stopRequest(requestId);
    } catch {
      /* the request is stopped here whatever the host's stop path does */
    }
  }

  /**
   * Let the held boundaries cross after Continue. The first one crosses: the person continued the step that was
   * held. One that is followed by a counted request reserves it as it crosses, so the boundaries behind it see
   * the total it made. Those the new allowance no longer covers are held again, behind a new decision.
   */
  private admit(requestId: string, tracked: TrackedRequest, waiting: HeldBoundary[]): void {
    const heldAgain: HeldBoundary[] = [];
    for (const [index, boundary] of waiting.entries()) {
      if (index > 0 && this.reached(tracked).length > 0) {
        heldAgain.push(boundary);
        continue;
      }
      this.reserve(tracked, boundary.reserveFor);
      boundary.settle('proceed');
    }
    if (heldAgain.length > 0) this.hold(requestId, tracked, heldAgain);
  }

  /** The last held boundary was stopped by its own caller: nobody waits for the answer, so the prompt closes. */
  private withdraw(tracked: TrackedRequest, decision: OpenDecision): void {
    this.close(tracked, decision, 'withdrawn');
    tracked.state = 'open';
    tracked.heldBoundary = undefined;
  }

  /** End a decision. With `ended`, the prompt is told that the gate no longer waits for it, and why. */
  private close(tracked: TrackedRequest, decision: OpenDecision, ended?: RequestDecisionEnd): void {
    tracked.decision = undefined;
    if (decision.timer !== undefined) this.timers.clear(decision.timer);
    decision.timer = undefined;
    if (ended) decision.prompt.abort(ended);
  }
}
