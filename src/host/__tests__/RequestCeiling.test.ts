import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REQUEST_DECISION_TIMEOUT_MS,
  MAX_TRACKED_REQUESTS,
  normalizeRequestLimits,
  rawTokenTotal,
  RequestCeilingGate,
  type RequestCeilingDecision,
  type RequestCeilingDecisionFacts,
  type RequestLimits,
} from '../RequestCeiling';
import {
  limitedCoverageAreas,
  parseRequestCloseoutRecord,
  requestCloseoutRecordId,
  type RequestLimitsObservation,
  type RequestObservationsV1,
} from '../../observability/RequestCloseout';

/* v0.9.94: the request limit gate. Every wait here is driven by the test; nothing reads the clock. */

interface OpenPrompt {
  facts: RequestCeilingDecisionFacts;
  signal: AbortSignal;
  answer(decision: RequestCeilingDecision): void;
  fail(error: Error): void;
}

function manualTimers() {
  let next = 1;
  const active = new Map<number, { callback: () => void; ms: number }>();
  return {
    active,
    set(callback: () => void, ms: number): unknown {
      const id = next++;
      active.set(id, { callback, ms });
      return id;
    },
    clear(handle: unknown): void {
      active.delete(handle as number);
    },
    /** Let every armed window pass. */
    fire(): void {
      for (const [id, timer] of [...active]) {
        active.delete(id);
        timer.callback();
      }
    },
  };
}

function harness(limits: RequestLimits, options: { stopRequest?: (requestId: string) => void; decisionTimeoutMs?: number } = {}) {
  let configured: unknown = limits;
  const prompts: OpenPrompt[] = [];
  const stops: string[] = [];
  const timers = manualTimers();
  /** What the host says can still continue. A test that reaches the bound says which requests those are. */
  const reachability: { ids: Set<string>; fails: boolean; asked: number } = { ids: new Set(), fails: false, asked: 0 };
  const gate = new RequestCeilingGate({
    reachableRequests: () => {
      reachability.asked += 1;
      if (reachability.fails) throw new Error('the host cannot say');
      return reachability.ids;
    },
    readLimits: () => configured as RequestLimits,
    decide: (facts, signal) => new Promise<RequestCeilingDecision>((resolve, reject) => {
      prompts.push({ facts, signal, answer: resolve, fail: reject });
    }),
    stopRequest: (requestId) => {
      stops.push(requestId);
      options.stopRequest?.(requestId);
    },
    timers,
    ...(options.decisionTimeoutMs !== undefined ? { decisionTimeoutMs: options.decisionTimeoutMs } : {}),
  });
  return { gate, prompts, stops, timers, reachability, configure: (next: unknown) => { configured = next; } };
}

/** What a boundary has resolved to by now, or `held` while it is still waiting. */
async function seen<T>(promise: Promise<T>): Promise<T | 'held'> {
  return Promise.race([promise, new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), 0))]);
}

function requests(gate: RequestCeilingGate, requestId: string, count: number): void {
  for (let index = 0; index < count; index++) gate.noteProviderRequest(requestId, 'agent', 'request');
}

/** A closeout record that is valid apart from what the test puts under `observations.limits`. */
function recordWith(limits: RequestLimitsObservation): Record<string, unknown> {
  const observations: RequestObservationsV1 = {
    changes: { coverage: 'complete', files: [], omitted: 0, droppedPaths: 0 },
    checks: { coverage: 'complete', passed: 0, failed: 0, refused: 0 },
    approvals: { coverage: 'complete', decisions: [] },
    context: { coverage: 'complete', sources: 0, estimatedTextTokens: 0 },
    routes: { coverage: 'complete', agents: [], omitted: 0 },
    reasoning: { visibleItems: 0 },
    limits,
  };
  return {
    schemaVersion: 1,
    recordId: requestCloseoutRecordId('request-1', 'turn-1'),
    requestId: 'request-1',
    rootAgentId: 'pm',
    originTurnId: 'origin-1',
    terminalTurnId: 'turn-1',
    recordedAt: '2026-10-08T00:00:00.000Z',
    revision: 1,
    terminal: { kind: 'stopped' },
    usageUnitIds: [],
    observations,
    coverage: { events: 'complete', limited: limitedCoverageAreas({ observations }) },
  };
}

function expectAcceptedByCloseout(limits: RequestLimitsObservation | undefined): void {
  expect(limits).toBeDefined();
  expect(parseRequestCloseoutRecord(recordWith(limits!))?.observations.limits).toEqual(limits);
}

describe('RequestCeilingGate without a limit', () => {
  it('never tracks a request with no limit configured: every boundary proceeds at once and nobody is asked', async () => {
    const { gate, prompts, timers } = harness({});
    gate.begin('request-1');
    requests(gate, 'request-1', 500);
    gate.noteUsage('request-1', 'unit-1', { input: 9_000_000, output: 9_000_000 });
    for (const kind of ['provider-request', 'effect', 'turn-start'] as const) {
      expect(await gate.boundary('request-1', kind)).toBe('proceed');
    }
    expect(gate.facts('request-1')).toBeUndefined();
    expect(prompts).toHaveLength(0);
    expect(timers.active.size).toBe(0);
  });

  it('proceeds for a request that was never begun', async () => {
    const { gate } = harness({ providerTurns: 1 });
    gate.noteProviderRequest('unknown', 'agent', 'request');
    expect(await gate.boundary('unknown', 'provider-request')).toBe('proceed');
    expect(gate.facts('unknown')).toBeUndefined();
  });

  it('reads only a positive whole number as a limit', () => {
    expect(normalizeRequestLimits({ providerTurns: 3, tokens: 1000 })).toEqual({ providerTurns: 3, tokens: 1000 });
    for (const value of [0, -1, 2.5, '3', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, true, []]) {
      expect(normalizeRequestLimits({ providerTurns: value, tokens: value })).toEqual({});
    }
    for (const value of [undefined, null, 5, 'x', [1]]) expect(normalizeRequestLimits(value)).toEqual({});
    // A value that is not a limit is no limit: it is never rounded into one.
    const { gate } = harness({});
    const malformed = harness({ providerTurns: 2.5 } as RequestLimits);
    malformed.gate.begin('request-1');
    expect(malformed.gate.facts('request-1')).toBeUndefined();
    expect(gate.facts('request-1')).toBeUndefined();
  });
});

describe('RequestCeilingGate totals', () => {
  it('adds the provider requests and the latest usage of every unit of one request', () => {
    const { gate } = harness({ providerTurns: 100, tokens: 1_000_000 });
    gate.begin('request-1');
    requests(gate, 'request-1', 3);
    gate.noteUsage('request-1', 'root-turn', { input: 100, output: 10 });
    gate.noteUsage('request-1', 'worker-turn', { input: 400, output: 40 });
    gate.noteUsage('request-1', 'reviewer-turn', { input: 50, output: 5 });
    expect(gate.facts('request-1')).toEqual({
      coverage: 'complete',
      providerTurns: { ceiling: 100, observed: 3 },
      tokens: { ceiling: 1_000_000, observed: 605 },
      crossings: 0,
      allowances: 0,
      decision: 'none',
    });
    // A unit reports its running total again: the later report replaces the earlier one.
    gate.noteUsage('request-1', 'root-turn', { input: 300, output: 30 });
    expect(gate.facts('request-1')?.tokens).toEqual({ ceiling: 1_000_000, observed: 825 });
  });

  it('counts cached input once: it is part of the input figure, not an addition to it', () => {
    expect(rawTokenTotal({ input: 100, cachedInput: 40, output: 10 })).toBe(110);
    expect(rawTokenTotal({ input: 100, output: 10 })).toBe(110);
    expect(rawTokenTotal({ input: -5, cachedInput: 99, output: Number.NaN })).toBe(0);
    const { gate } = harness({ tokens: 1000 });
    gate.begin('request-1');
    gate.noteUsage('request-1', 'unit-1', { input: 100, cachedInput: 100, output: 10 });
    expect(gate.facts('request-1')?.tokens?.observed).toBe(110);
  });

  it('pins the limits a request began with and keeps its totals when it is begun again', async () => {
    const { gate, prompts, configure } = harness({ providerTurns: 2 });
    gate.begin('request-1');
    requests(gate, 'request-1', 1);
    configure({ providerTurns: 500, tokens: 10 });
    gate.begin('request-1');
    expect(gate.facts('request-1')).toMatchObject({ providerTurns: { ceiling: 2, observed: 1 } });
    expect(gate.facts('request-1')?.tokens).toBeUndefined();
    requests(gate, 'request-1', 1);
    expect(await seen(gate.boundary('request-1', 'provider-request'))).toBe('held');
    expect(prompts).toHaveLength(1);
    // The next request reads the setting as it is now.
    gate.begin('request-2');
    expect(gate.facts('request-2')).toMatchObject({ providerTurns: { ceiling: 500, observed: 0 }, tokens: { ceiling: 10, observed: 0 } });
  });
});

describe('RequestCeilingGate at a limit', () => {
  it('reaches a provider-turn limit at the limit itself, not one past it', async () => {
    const { gate, prompts } = harness({ providerTurns: 2 });
    gate.begin('request-1');
    expect(await gate.boundary('request-1', 'provider-request')).toBe('proceed');
    gate.noteProviderRequest('request-1', 'agent', 'request');
    expect(await gate.boundary('request-1', 'provider-request')).toBe('proceed');
    gate.noteProviderRequest('request-1', 'agent', 'request');
    // Two requests left and the limit is two: the third is held.
    const third = gate.boundary('request-1', 'provider-request');
    expect(await seen(third)).toBe('held');
    expect(prompts).toHaveLength(1);
    expect(prompts[0].facts).toEqual({
      requestId: 'request-1',
      reached: [{ limit: 'providerTurns', configured: 2, allowance: 2, observed: 2 }],
      limits: {
        coverage: 'complete',
        providerTurns: { ceiling: 2, observed: 2 },
        crossings: 1,
        allowances: 0,
        decision: 'awaiting',
        heldBoundary: 'provider-request',
      },
    });
    expect(gate.facts('request-1')).toEqual(prompts[0].facts.limits);
  });

  it('reaches a token limit when the observed total equals it', async () => {
    const { gate, prompts } = harness({ tokens: 100 });
    gate.begin('request-1');
    gate.noteUsage('request-1', 'unit-1', { input: 90, output: 9 });
    expect(await gate.boundary('request-1', 'effect')).toBe('proceed');
    gate.noteUsage('request-1', 'unit-1', { input: 90, output: 10 });
    expect(await seen(gate.boundary('request-1', 'effect'))).toBe('held');
    expect(prompts[0].facts.reached).toEqual([{ limit: 'tokens', configured: 100, allowance: 100, observed: 100 }]);
    expect(prompts[0].facts.limits.heldBoundary).toBe('effect');
  });

  it('holds concurrent boundaries behind one prompt and releases them all on Continue', async () => {
    const { gate, prompts, stops, timers } = harness({ providerTurns: 1 });
    gate.begin('request-1');
    gate.noteProviderRequest('request-1', 'agent', 'request');
    const held = [
      gate.boundary('request-1', 'effect'),
      gate.boundary('request-1', 'provider-request'),
      gate.boundary('request-1', 'turn-start'),
    ];
    for (const boundary of held) expect(await seen(boundary)).toBe('held');
    expect(prompts).toHaveLength(1);
    expect(timers.active.size).toBe(1);
    // The boundary that opened the prompt is the one recorded as held.
    expect(gate.facts('request-1')).toMatchObject({ decision: 'awaiting', heldBoundary: 'effect', crossings: 1 });

    prompts[0].answer('continue');
    expect(await Promise.all(held)).toEqual(['proceed', 'proceed', 'proceed']);
    expect(prompts).toHaveLength(1);
    expect(stops).toEqual([]);
    expect(timers.active.size).toBe(0);
    expect(prompts[0].signal.aborted).toBe(false);
    expect(gate.facts('request-1')).toEqual({
      coverage: 'complete',
      providerTurns: { ceiling: 1, observed: 1 },
      crossings: 1,
      allowances: 1,
      decision: 'continued',
    });
  });

  it('adds exactly one tranche per Continue, keeps the totals, and asks again at the next crossing', async () => {
    const { gate, prompts } = harness({ providerTurns: 2 });
    gate.begin('request-1');
    requests(gate, 'request-1', 2);
    const first = gate.boundary('request-1', 'provider-request');
    expect(await seen(first)).toBe('held');
    prompts[0].answer('continue');
    expect(await first).toBe('proceed');

    // One tranche of two: the third and the fourth request leave, the fifth does not.
    gate.noteProviderRequest('request-1', 'agent', 'request');
    expect(await gate.boundary('request-1', 'provider-request')).toBe('proceed');
    gate.noteProviderRequest('request-1', 'agent', 'request');
    expect(gate.facts('request-1')).toMatchObject({ providerTurns: { ceiling: 2, observed: 4 }, crossings: 1, allowances: 1 });
    const fifth = gate.boundary('request-1', 'provider-request');
    expect(await seen(fifth)).toBe('held');
    expect(prompts).toHaveLength(2);
    expect(prompts[1].facts.reached).toEqual([{ limit: 'providerTurns', configured: 2, allowance: 4, observed: 4 }]);
    expect(prompts[1].facts.limits).toMatchObject({ crossings: 2, allowances: 1, decision: 'awaiting' });

    prompts[1].answer('continue');
    expect(await fifth).toBe('proceed');
    expect(gate.facts('request-1')).toMatchObject({ providerTurns: { ceiling: 2, observed: 4 }, crossings: 2, allowances: 2, decision: 'continued' });
    requests(gate, 'request-1', 1);
    expect(await gate.boundary('request-1', 'provider-request')).toBe('proceed');
    requests(gate, 'request-1', 1);
    expect(await seen(gate.boundary('request-1', 'provider-request'))).toBe('held');
    expect(prompts).toHaveLength(3);
  });

  it('adds the tranche to every configured limit, and one Continue never covers a total two tranches past', async () => {
    const { gate, prompts } = harness({ providerTurns: 2, tokens: 100 });
    gate.begin('request-1');
    requests(gate, 'request-1', 2);
    const held = gate.boundary('request-1', 'provider-request');
    expect(await seen(held)).toBe('held');
    expect(prompts[0].facts.reached.map((entry) => entry.limit)).toEqual(['providerTurns']);
    prompts[0].answer('continue');
    expect(await held).toBe('proceed');
    // The token limit received its tranche too: 150 is inside 200.
    gate.noteUsage('request-1', 'unit-1', { input: 140, output: 10 });
    expect(await gate.boundary('request-1', 'effect')).toBe('proceed');

    // One response takes the total past two further tranches: each of them needs its own decision.
    gate.noteUsage('request-1', 'unit-1', { input: 400, output: 50 });
    const second = gate.boundary('request-1', 'effect');
    expect(await seen(second)).toBe('held');
    expect(prompts[1].facts.reached).toEqual([{ limit: 'tokens', configured: 100, allowance: 200, observed: 450 }]);
    prompts[1].answer('continue');
    expect(await second).toBe('proceed');
    const third = gate.boundary('request-1', 'effect');
    expect(await seen(third)).toBe('held');
    expect(prompts[2].facts.reached).toEqual([{ limit: 'tokens', configured: 100, allowance: 300, observed: 450 }]);
    expect(gate.facts('request-1')).toMatchObject({ tokens: { ceiling: 100, observed: 450 }, crossings: 3, allowances: 2 });
  });

  it('names both limits when both are reached, provider turns first', async () => {
    const { gate, prompts } = harness({ providerTurns: 1, tokens: 10 });
    gate.begin('request-1');
    gate.noteProviderRequest('request-1', 'agent', 'request');
    gate.noteUsage('request-1', 'unit-1', { input: 8, output: 4 });
    expect(await seen(gate.boundary('request-1', 'turn-start'))).toBe('held');
    expect(prompts[0].facts.reached).toEqual([
      { limit: 'providerTurns', configured: 1, allowance: 1, observed: 1 },
      { limit: 'tokens', configured: 10, allowance: 10, observed: 12 },
    ]);
  });

  it('on Stop refuses every held and every later boundary and asks the host to stop the request once', async () => {
    const { gate, prompts, stops, timers } = harness({ providerTurns: 1 });
    gate.begin('request-1');
    gate.noteProviderRequest('request-1', 'agent', 'request');
    const held = [gate.boundary('request-1', 'provider-request'), gate.boundary('request-1', 'effect')];
    expect(await seen(held[0])).toBe('held');
    prompts[0].answer('stop');
    expect(await Promise.all(held)).toEqual(['stopped', 'stopped']);
    expect(stops).toEqual(['request-1']);
    expect(timers.active.size).toBe(0);
    expect(gate.facts('request-1')).toEqual({
      coverage: 'complete',
      providerTurns: { ceiling: 1, observed: 1 },
      crossings: 1,
      allowances: 0,
      decision: 'stopped',
      heldBoundary: 'provider-request',
    });

    for (const kind of ['provider-request', 'effect', 'turn-start'] as const) {
      expect(await gate.boundary('request-1', kind)).toBe('stopped');
    }
    expect(prompts).toHaveLength(1);
    expect(stops).toEqual(['request-1']);
    // A stopped request stays stopped when it is begun again, and its record stays readable.
    gate.begin('request-1');
    expect(await gate.boundary('request-1', 'effect')).toBe('stopped');
    expect(gate.facts('request-1')?.decision).toBe('stopped');
    expect(stops).toEqual(['request-1']);
  });

  it('stops the request whatever the host stop path throws', async () => {
    const { gate, prompts, stops } = harness({ providerTurns: 1 }, { stopRequest: () => { throw new Error('stop path failed'); } });
    gate.begin('request-1');
    gate.noteProviderRequest('request-1', 'agent', 'request');
    const held = gate.boundary('request-1', 'effect');
    prompts[0].answer('stop');
    expect(await held).toBe('stopped');
    expect(stops).toEqual(['request-1']);
    expect(await gate.boundary('request-1', 'effect')).toBe('stopped');
  });

  it('takes any answer but the exact word, and a prompt that failed, as Stop', async () => {
    for (const settle of [
      (prompt: OpenPrompt) => prompt.answer('yes' as RequestCeilingDecision),
      (prompt: OpenPrompt) => prompt.answer(undefined as unknown as RequestCeilingDecision),
      (prompt: OpenPrompt) => prompt.fail(new Error('the prompt could not be shown')),
    ]) {
      const { gate, prompts, stops } = harness({ providerTurns: 1 });
      gate.begin('request-1');
      gate.noteProviderRequest('request-1', 'agent', 'request');
      const held = gate.boundary('request-1', 'provider-request');
      settle(prompts[0]);
      expect(await held).toBe('stopped');
      expect(stops).toEqual(['request-1']);
      expect(gate.facts('request-1')).toMatchObject({ decision: 'stopped', allowances: 0 });
    }
  });

  it('stops a request whose prompt throws before it can be shown', async () => {
    const stops: string[] = [];
    const gate = new RequestCeilingGate({
      readLimits: () => ({ providerTurns: 1 }),
      decide: () => { throw new Error('no prompt surface'); },
      stopRequest: (requestId) => { stops.push(requestId); },
      timers: manualTimers(),
    });
    gate.begin('request-1');
    gate.noteProviderRequest('request-1', 'agent', 'request');
    expect(await gate.boundary('request-1', 'effect')).toBe('stopped');
    expect(stops).toEqual(['request-1']);
  });

  it('resolves an unanswered decision as Stop when its window passes, and ignores an answer that comes later', async () => {
    const { gate, prompts, stops, timers } = harness({ providerTurns: 1 }, { decisionTimeoutMs: 1234 });
    gate.begin('request-1');
    gate.noteProviderRequest('request-1', 'agent', 'request');
    const held = [gate.boundary('request-1', 'effect'), gate.boundary('request-1', 'provider-request')];
    expect(await seen(held[0])).toBe('held');
    expect([...timers.active.values()].map((timer) => timer.ms)).toEqual([1234]);

    timers.fire();
    expect(await Promise.all(held)).toEqual(['stopped', 'stopped']);
    expect(stops).toEqual(['request-1']);
    // The prompt is told that nobody waits for it any more.
    expect(prompts[0].signal.aborted).toBe(true);

    prompts[0].answer('continue');
    await seen(Promise.resolve());
    expect(gate.facts('request-1')).toMatchObject({ decision: 'stopped', allowances: 0, crossings: 1 });
    expect(await gate.boundary('request-1', 'effect')).toBe('stopped');
    expect(stops).toEqual(['request-1']);
  });

  it('waits fifteen minutes for a decision unless told otherwise', async () => {
    expect(DEFAULT_REQUEST_DECISION_TIMEOUT_MS).toBe(15 * 60_000);
    // A window that is not a positive duration is not a window: the default applies.
    for (const decisionTimeoutMs of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { gate, timers } = harness({ providerTurns: 1 }, { decisionTimeoutMs });
      gate.begin('request-1');
      gate.noteProviderRequest('request-1', 'agent', 'request');
      void gate.boundary('request-1', 'effect');
      expect([...timers.active.values()].map((timer) => timer.ms)).toEqual([DEFAULT_REQUEST_DECISION_TIMEOUT_MS]);
      gate.dispose();
      expect(timers.active.size).toBe(0);
    }
  });

  it('keeps time on the host clock when no timer is injected, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    try {
      const stops: string[] = [];
      const gate = new RequestCeilingGate({
        readLimits: () => ({ providerTurns: 1 }),
        decide: () => new Promise<RequestCeilingDecision>(() => undefined),
        stopRequest: (requestId) => { stops.push(requestId); },
        reachableRequests: () => new Set<string>(),
      });
      const outcomes: Record<string, string> = {};
      const hold = (requestId: string, signal?: AbortSignal): void => {
        gate.begin(requestId);
        gate.noteProviderRequest(requestId, 'agent', 'request');
        void gate.boundary(requestId, 'effect', signal).then((outcome) => { outcomes[requestId] = outcome; });
      };

      hold('request-1');
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_DECISION_TIMEOUT_MS - 1);
      expect(outcomes).toEqual({});
      await vi.advanceTimersByTimeAsync(1);
      expect(outcomes).toEqual({ 'request-1': 'stopped' });
      expect(stops).toEqual(['request-1']);
      expect(vi.getTimerCount()).toBe(0);

      const caller = new AbortController();
      hold('request-2', caller.signal);
      expect(vi.getTimerCount()).toBe(1);
      caller.abort();
      expect(vi.getTimerCount()).toBe(0);

      hold('request-3');
      expect(vi.getTimerCount()).toBe(1);
      gate.dispose();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_DECISION_TIMEOUT_MS * 2);
      expect(outcomes).toEqual({ 'request-1': 'stopped', 'request-2': 'stopped', 'request-3': 'stopped' });
      // Only the decision that timed out asked the host to stop a request.
      expect(stops).toEqual(['request-1']);
    } finally {
      vi.useRealTimers();
    }
  });

});

describe('RequestCeilingGate when a held boundary ends without a decision', () => {
  it('releases a boundary whose caller was stopped, and keeps the prompt for the others', async () => {
    const { gate, prompts, stops } = harness({ providerTurns: 1 });
    gate.begin('request-1');
    gate.noteProviderRequest('request-1', 'agent', 'request');
    const stoppedTurn = new AbortController();
    const first = gate.boundary('request-1', 'effect', stoppedTurn.signal);
    const second = gate.boundary('request-1', 'provider-request');
    expect(await seen(first)).toBe('held');
    stoppedTurn.abort();
    expect(await first).toBe('stopped');
    expect(await seen(second)).toBe('held');
    expect(prompts).toHaveLength(1);
    expect(prompts[0].signal.aborted).toBe(false);
    expect(stops).toEqual([]);
    prompts[0].answer('continue');
    expect(await second).toBe('proceed');
  });

  it('closes the prompt when the last held boundary was stopped, and asks again without a new crossing', async () => {
    const { gate, prompts, stops, timers } = harness({ providerTurns: 1 });
    gate.begin('request-1');
    gate.noteProviderRequest('request-1', 'agent', 'request');
    const stoppedTurn = new AbortController();
    const held = gate.boundary('request-1', 'effect', stoppedTurn.signal);
    expect(await seen(held)).toBe('held');
    stoppedTurn.abort();
    expect(await held).toBe('stopped');
    expect(prompts[0].signal.aborted).toBe(true);
    expect(timers.active.size).toBe(0);
    // Nobody decided: the host is not asked to stop anything, and the request is not marked stopped.
    expect(stops).toEqual([]);
    expect(gate.facts('request-1')).toEqual({
      coverage: 'complete',
      providerTurns: { ceiling: 1, observed: 1 },
      crossings: 1,
      allowances: 0,
      decision: 'none',
    });
    // An answer to the closed prompt changes nothing.
    prompts[0].answer('continue');
    await seen(Promise.resolve());
    expect(gate.facts('request-1')?.allowances).toBe(0);

    // The limit is still reached, so the next boundary asks again. It is the same crossing.
    const next = gate.boundary('request-1', 'turn-start');
    expect(await seen(next)).toBe('held');
    expect(prompts).toHaveLength(2);
    expect(gate.facts('request-1')).toMatchObject({ crossings: 1, decision: 'awaiting', heldBoundary: 'turn-start' });
    prompts[1].answer('continue');
    expect(await next).toBe('proceed');
    expect(gate.facts('request-1')).toMatchObject({ crossings: 1, allowances: 1, decision: 'continued' });
  });

  it('does not hold a caller that is already stopped, and opens no prompt for it', async () => {
    const { gate, prompts } = harness({ providerTurns: 1 });
    gate.begin('request-1');
    const stoppedTurn = new AbortController();
    stoppedTurn.abort();
    // Inside the limits a stopped caller is none of the gate's business.
    expect(await gate.boundary('request-1', 'effect', stoppedTurn.signal)).toBe('proceed');
    gate.noteProviderRequest('request-1', 'agent', 'request');
    expect(await gate.boundary('request-1', 'effect', stoppedTurn.signal)).toBe('stopped');
    expect(prompts).toHaveLength(0);
    expect(gate.facts('request-1')).toMatchObject({ crossings: 0, decision: 'none' });
  });

  it('refuses everything held, closes every prompt and leaves no timer when the host shuts down', async () => {
    const { gate, prompts, stops, timers } = harness({ providerTurns: 1 });
    for (const requestId of ['request-1', 'request-2', 'request-3']) gate.begin(requestId);
    gate.noteProviderRequest('request-1', 'agent', 'request');
    gate.noteProviderRequest('request-2', 'agent', 'request');
    const held = [gate.boundary('request-1', 'effect'), gate.boundary('request-2', 'provider-request')];
    expect(await seen(held[0])).toBe('held');
    expect(prompts).toHaveLength(2);
    expect(timers.active.size).toBe(2);

    gate.dispose();
    expect(await Promise.all(held)).toEqual(['stopped', 'stopped']);
    expect(prompts.map((prompt) => prompt.signal.aborted)).toEqual([true, true]);
    expect(timers.active.size).toBe(0);
    expect(stops).toEqual([]);
    expect(prompts.map((prompt) => prompt.signal.reason)).toEqual(['disposed', 'disposed']);
    // Nothing with a limit runs on after shutdown: not a request that was open, not one begun afterwards.
    expect(await gate.boundary('request-3', 'effect')).toBe('stopped');
    gate.begin('request-4');
    expect(await gate.boundary('request-4', 'effect')).toBe('stopped');
    expect(prompts).toHaveLength(2);
    expect(timers.active.size).toBe(0);
    // The requests stay known, and one the shutdown stopped before any limit records no decision at a limit.
    expect(gate.governs('request-3')).toBe(true);
    expect(gate.facts('request-3')).toMatchObject({ crossings: 0, decision: 'none' });
    expect(gate.facts('request-1')).toMatchObject({ crossings: 1, decision: 'stopped' });
    expectAcceptedByCloseout(gate.facts('request-3'));
    expectAcceptedByCloseout(gate.facts('request-1'));
  });
});

describe('RequestCeilingGate coverage', () => {
  it('says the token total is a lower bound when usage is unknown, and never counts the unknown part as zero', async () => {
    const { gate, prompts } = harness({ providerTurns: 2, tokens: 100 });
    gate.begin('request-1');
    gate.noteUsage('request-1', 'unit-1', { input: 50, output: 10 });
    expect(gate.facts('request-1')?.coverage).toBe('complete');
    gate.markUsageIncomplete('request-1');
    expect(gate.facts('request-1')).toMatchObject({ coverage: 'partial', tokens: { ceiling: 100, observed: 60 } });
    expectAcceptedByCloseout(gate.facts('request-1'));

    // The provider-turn limit is counted by the host and stays enforceable.
    requests(gate, 'request-1', 2);
    expect(await seen(gate.boundary('request-1', 'provider-request'))).toBe('held');
    expect(prompts[0].facts.reached).toEqual([{ limit: 'providerTurns', configured: 2, allowance: 2, observed: 2 }]);
    expect(prompts[0].facts.limits.coverage).toBe('partial');
  });

  it('still acts on the tokens it did observe when part of the usage is unknown', async () => {
    const { gate, prompts } = harness({ tokens: 100 });
    gate.begin('request-1');
    gate.markUsageIncomplete('request-1');
    gate.noteUsage('request-1', 'unit-1', { input: 100, output: 20 });
    expect(await seen(gate.boundary('request-1', 'effect'))).toBe('held');
    expect(prompts[0].facts.limits).toMatchObject({ coverage: 'partial', tokens: { ceiling: 100, observed: 120 } });
  });

  it('leaves a provider-turn limit complete when only token usage is unknown', () => {
    const { gate } = harness({ providerTurns: 2 });
    gate.begin('request-1');
    gate.markUsageIncomplete('request-1');
    expect(gate.facts('request-1')?.coverage).toBe('complete');
  });

  it('is partial on a route where the host only observes the provider requests', () => {
    const { gate } = harness({ providerTurns: 2 });
    gate.begin('request-1');
    gate.markObservedOnly('request-1');
    expect(gate.facts('request-1')).toEqual({
      coverage: 'partial',
      providerTurns: { ceiling: 2, observed: 0 },
      crossings: 0,
      allowances: 0,
      decision: 'none',
    });
    expectAcceptedByCloseout(gate.facts('request-1'));
  });
});

describe('RequestCeilingGate facts in a request closeout record', () => {
  it('are accepted by the closeout parser in every state of the request', async () => {
    const { gate, prompts } = harness({ providerTurns: 1, tokens: 1000 });
    gate.begin('request-1');
    gate.noteUsage('request-1', 'unit-1', { input: 10, cachedInput: 4, output: 2 });
    expectAcceptedByCloseout(gate.facts('request-1'));

    gate.noteProviderRequest('request-1', 'agent', 'request');
    const first = gate.boundary('request-1', 'provider-request');
    expect(await seen(first)).toBe('held');
    expect(gate.facts('request-1')?.decision).toBe('awaiting');
    expectAcceptedByCloseout(gate.facts('request-1'));

    prompts[0].answer('continue');
    await first;
    expect(gate.facts('request-1')?.decision).toBe('continued');
    expectAcceptedByCloseout(gate.facts('request-1'));

    gate.noteProviderRequest('request-1', 'agent', 'request');
    const second = gate.boundary('request-1', 'effect');
    expect(await seen(second)).toBe('held');
    prompts[1].answer('stop');
    await second;
    expect(gate.facts('request-1')).toEqual({
      coverage: 'complete',
      providerTurns: { ceiling: 1, observed: 2 },
      tokens: { ceiling: 1000, observed: 12 },
      crossings: 2,
      allowances: 1,
      decision: 'stopped',
      heldBoundary: 'effect',
    });
    expectAcceptedByCloseout(gate.facts('request-1'));
  });

  it('is rejected by the same parser when a fact is taken out of it, so the check above is not vacuous', () => {
    const { gate } = harness({ providerTurns: 1 });
    gate.begin('request-1');
    const limits = gate.facts('request-1')!;
    expect(parseRequestCloseoutRecord(recordWith(limits))).toBeDefined();
    expect(parseRequestCloseoutRecord(recordWith({ ...limits, decision: 'continued' }))).toBeUndefined();
    expect(parseRequestCloseoutRecord(recordWith({ ...limits, providerTurns: undefined }))).toBeUndefined();
  });
});

describe('RequestCeilingGate, what a host asks before it waits', () => {
  it('governs a request with a limit for as long as it is known, stopped or not, and nothing else', async () => {
    const { gate, prompts, configure } = harness({ providerTurns: 1 });
    expect(gate.governs('request-1')).toBe(false);
    gate.begin('request-1');
    expect(gate.governs('request-1')).toBe(true);

    gate.noteProviderRequest('request-1', 'agent', 'request');
    const held = gate.boundary('request-1', 'effect');
    prompts[0].answer('stop');
    expect(await held).toBe('stopped');
    // Stopped, and still governed: the host still asks before it starts a turn of it.
    expect(gate.governs('request-1')).toBe(true);
    expect(gate.facts('request-1')?.decision).toBe('stopped');

    configure({});
    gate.begin('request-2');
    expect(gate.governs('request-2')).toBe(false);
  });

  it('says a boundary would wait exactly while a limit is reached or a decision is open', async () => {
    const { gate, prompts } = harness({ providerTurns: 2 });
    expect(gate.wouldHold('request-1')).toBe(false);
    gate.begin('request-1');
    gate.noteProviderRequest('request-1', 'agent', 'request');
    expect(gate.wouldHold('request-1')).toBe(false);
    gate.noteProviderRequest('request-1', 'agent', 'request');
    // Reached, and nobody has been asked yet: asking the question opens no prompt.
    expect(gate.wouldHold('request-1')).toBe(true);
    expect(prompts).toHaveLength(0);

    const held = gate.boundary('request-1', 'provider-request');
    expect(gate.wouldHold('request-1')).toBe(true);
    prompts[0].answer('continue');
    expect(await held).toBe('proceed');
    expect(gate.wouldHold('request-1')).toBe(false);

    gate.noteProviderRequest('request-1', 'agent', 'request');
    gate.noteProviderRequest('request-1', 'agent', 'request');
    const again = gate.boundary('request-1', 'provider-request');
    prompts[1].answer('stop');
    expect(await again).toBe('stopped');
    // A stopped request is refused at once: there is nothing to wait for.
    expect(gate.wouldHold('request-1')).toBe(false);
  });
});

describe('RequestCeilingGate reserves a request as its boundary is crossed', () => {
  it('lets one of two callers that ask at the same count cross the last allowance, and holds the other', async () => {
    const { gate, prompts } = harness({ providerTurns: 1 });
    gate.begin('request-1');
    // Two teammates ask before either request has been counted.
    const first = gate.boundary('request-1', 'provider-request', undefined, 'dev');
    const second = gate.boundary('request-1', 'provider-request', undefined, 'reviewer');

    expect(await seen(first)).toBe('proceed');
    expect(await seen(second)).toBe('held');
    expect(prompts).toHaveLength(1);
    expect(prompts[0].facts.reached).toEqual([{ limit: 'providerTurns', configured: 1, allowance: 1, observed: 1 }]);
    // The request that crossed is counted once, not once at the boundary and again when it leaves.
    gate.noteProviderRequest('request-1', 'dev', 'request');
    expect(gate.facts('request-1')?.providerTurns).toEqual({ ceiling: 1, observed: 1 });
  });

  it('counts a reserved request from the moment its boundary is crossed, before it is seen to leave', () => {
    const { gate } = harness({ providerTurns: 5 });
    gate.begin('request-1');
    void gate.boundary('request-1', 'provider-request', undefined, 'dev');
    void gate.boundary('request-1', 'provider-request', undefined, 'dev');
    expect(gate.facts('request-1')?.providerTurns?.observed).toBe(2);

    gate.noteProviderRequest('request-1', 'dev', 'request');
    gate.noteProviderRequest('request-1', 'dev', 'request');
    expect(gate.facts('request-1')?.providerTurns?.observed).toBe(2);
    // A third request of that agent was not reserved: it is counted when it is seen.
    gate.noteProviderRequest('request-1', 'dev', 'request');
    expect(gate.facts('request-1')?.providerTurns?.observed).toBe(3);
  });

  it('keeps one agent\'s reservation for that agent: a request another agent makes is counted beside it', () => {
    const { gate } = harness({ providerTurns: 5 });
    gate.begin('request-1');
    void gate.boundary('request-1', 'provider-request', undefined, 'dev');
    // A teammate's request that crossed no boundary of its own, such as a turn a CLI route counts as one.
    gate.noteProviderRequest('request-1', 'pm', 'turn');
    expect(gate.facts('request-1')?.providerTurns).toEqual({ ceiling: 5, observed: 2, hostCountedTurns: 1 });

    gate.noteProviderRequest('request-1', 'dev', 'request');
    expect(gate.facts('request-1')?.providerTurns).toEqual({ ceiling: 5, observed: 2, hostCountedTurns: 1 });
  });

  it('reserves nothing for a boundary that is followed by no counted request', async () => {
    const { gate } = harness({ providerTurns: 1 });
    gate.begin('request-1');
    expect(await gate.boundary('request-1', 'effect')).toBe('proceed');
    expect(await gate.boundary('request-1', 'turn-start')).toBe('proceed');
    expect(gate.facts('request-1')?.providerTurns?.observed).toBe(0);
  });

  it('gives back what an agent reserved when its turn ends without the request', async () => {
    const { gate, prompts } = harness({ providerTurns: 1 });
    gate.begin('request-1');
    expect(await gate.boundary('request-1', 'turn-start', undefined, 'cli')).toBe('proceed');
    expect(gate.wouldHold('request-1')).toBe(true);

    gate.release('request-1', 'cli');
    expect(gate.facts('request-1')?.providerTurns?.observed).toBe(0);
    expect(await gate.boundary('request-1', 'effect')).toBe('proceed');
    // Releasing an agent that reserved nothing, or a request the gate does not know, changes nothing.
    gate.release('request-1', 'cli');
    gate.release('unknown', 'cli');
    expect(prompts).toHaveLength(0);
  });

  it('after Continue lets the held requests cross only while the new allowance lasts, and asks again for the rest', async () => {
    const { gate, prompts } = harness({ providerTurns: 1 });
    gate.begin('request-1');
    gate.noteProviderRequest('request-1', 'pm', 'request');
    const held = ['dev', 'reviewer', 'tester'].map((agent) => gate.boundary('request-1', 'provider-request', undefined, agent));
    expect(await seen(held[0])).toBe('held');
    expect(prompts).toHaveLength(1);

    prompts[0].answer('continue');
    // One tranche of one request: the first held request takes it, the two behind it are held again.
    expect(await seen(held[0])).toBe('proceed');
    expect(await seen(held[1])).toBe('held');
    expect(await seen(held[2])).toBe('held');
    expect(prompts).toHaveLength(2);
    expect(prompts[1].facts.reached).toEqual([{ limit: 'providerTurns', configured: 1, allowance: 2, observed: 2 }]);
    expect(prompts[1].facts.limits).toMatchObject({ crossings: 2, allowances: 1, decision: 'awaiting' });

    prompts[1].answer('stop');
    expect(await Promise.all(held)).toEqual(['proceed', 'stopped', 'stopped']);
  });

  it('after Continue releases every held call that is followed by no counted request', async () => {
    const { gate, prompts } = harness({ providerTurns: 1 });
    gate.begin('request-1');
    gate.noteProviderRequest('request-1', 'pm', 'request');
    const held = [gate.boundary('request-1', 'effect'), gate.boundary('request-1', 'effect'), gate.boundary('request-1', 'effect')];
    expect(await seen(held[0])).toBe('held');
    prompts[0].answer('continue');

    expect(await Promise.all(held)).toEqual(['proceed', 'proceed', 'proceed']);
    expect(prompts).toHaveLength(1);
  });

  it('releases a boundary that was held again when its caller is stopped, and withdraws the second prompt', async () => {
    const { gate, prompts } = harness({ providerTurns: 1 });
    gate.begin('request-1');
    gate.noteProviderRequest('request-1', 'pm', 'request');
    const caller = new AbortController();
    const first = gate.boundary('request-1', 'provider-request', undefined, 'dev');
    const second = gate.boundary('request-1', 'provider-request', caller.signal, 'reviewer');
    expect(await seen(second)).toBe('held');
    prompts[0].answer('continue');
    expect(await seen(first)).toBe('proceed');
    expect(prompts).toHaveLength(2);

    caller.abort();
    expect(await second).toBe('stopped');
    expect(prompts[1].signal.aborted).toBe(true);
    expect(prompts[1].signal.reason).toBe('withdrawn');
  });
});

describe('RequestCeilingGate tells the prompt why it stopped waiting', () => {
  async function heldAtLimit() {
    const made = harness({ providerTurns: 1 });
    made.gate.begin('request-1');
    made.gate.noteProviderRequest('request-1', 'agent', 'request');
    const caller = new AbortController();
    const held = made.gate.boundary('request-1', 'effect', caller.signal);
    expect(await seen(held)).toBe('held');
    return { ...made, caller, held };
  }

  it('says expired when the window passed, and the request is stopped', async () => {
    const { prompts, timers, held, stops } = await heldAtLimit();
    timers.fire();
    expect(await held).toBe('stopped');
    expect(prompts[0].signal.reason).toBe('expired');
    expect(stops).toEqual(['request-1']);
  });

  it('says withdrawn when the last held step ended by itself, and the request is not stopped', async () => {
    const { gate, prompts, caller, held, stops } = await heldAtLimit();
    caller.abort();
    expect(await held).toBe('stopped');
    expect(prompts[0].signal.reason).toBe('withdrawn');
    expect(stops).toEqual([]);
    expect(gate.facts('request-1')?.decision).toBe('none');
  });

  it('says failed when the prompt itself failed, and the request is stopped', async () => {
    const { prompts, held, stops } = await heldAtLimit();
    prompts[0].fail(new Error('the card could not be shown'));
    expect(await held).toBe('stopped');
    expect(prompts[0].signal.reason).toBe('failed');
    expect(stops).toEqual(['request-1']);
  });

  it('aborts nothing when the person answered', async () => {
    const { prompts, held } = await heldAtLimit();
    prompts[0].answer('continue');
    expect(await held).toBe('proceed');
    expect(prompts[0].signal.aborted).toBe(false);
  });
});

describe('RequestCeilingGate counts model requests and host-counted turns apart', () => {
  it('says how many of the counted requests are turns counted as one each', () => {
    const { gate } = harness({ providerTurns: 10 });
    gate.begin('request-1');
    gate.noteProviderRequest('request-1', 'dev', 'request');
    expect(gate.facts('request-1')?.providerTurns).toEqual({ ceiling: 10, observed: 1 });

    gate.noteProviderRequest('request-1', 'pm', 'turn');
    gate.noteProviderRequest('request-1', 'pm', 'turn');
    expect(gate.facts('request-1')?.providerTurns).toEqual({ ceiling: 10, observed: 3, hostCountedTurns: 2 });
    expectAcceptedByCloseout(gate.facts('request-1'));
  });

  it('reaches the limit on turns and requests together', async () => {
    const { gate, prompts } = harness({ providerTurns: 2 });
    gate.begin('request-1');
    gate.noteProviderRequest('request-1', 'pm', 'turn');
    gate.noteProviderRequest('request-1', 'dev', 'request');
    expect(await seen(gate.boundary('request-1', 'effect'))).toBe('held');
    expect(prompts[0].facts.limits.providerTurns).toEqual({ ceiling: 2, observed: 2, hostCountedTurns: 1 });
  });

  it('is refused by the closeout parser when the turns are more than what was observed, or not a count', () => {
    const limits = (hostCountedTurns: unknown): RequestLimitsObservation => ({
      coverage: 'partial', providerTurns: { ceiling: 5, observed: 2, hostCountedTurns: hostCountedTurns as number },
      crossings: 0, allowances: 0, decision: 'none',
    });
    expect(parseRequestCloseoutRecord(recordWith(limits(2)))?.observations.limits?.providerTurns?.hostCountedTurns).toBe(2);
    for (const hostile of [3, 0, -1, 1.5, '1']) {
      expect(parseRequestCloseoutRecord(recordWith(limits(hostile)))).toBeUndefined();
    }
  });
});

describe('RequestCeilingGate token totals of units that are over', () => {
  it('replaces what a unit reported with its terminal counts, and keeps the total when the unit is no longer kept', async () => {
    const { gate } = harness({ tokens: 1_000 });
    gate.begin('request-1');
    gate.noteUsage('request-1', 'unit-1', { input: 100, output: 10 });
    gate.settleUsage('request-1', 'unit-1', { input: 300, output: 30 });
    expect(gate.facts('request-1')?.tokens?.observed).toBe(330);

    // A unit that ends without terminal counts keeps the last figure it reported, and one that reported nothing adds nothing.
    gate.noteUsage('request-1', 'unit-2', { input: 50, output: 5 });
    gate.settleUsage('request-1', 'unit-2');
    expect(gate.facts('request-1')?.tokens?.observed).toBe(385);
    gate.settleUsage('request-1', 'unit-3');
    expect(gate.facts('request-1')?.tokens?.observed).toBe(385);
  });

  it('reaches a token limit on settled and open units together', async () => {
    const { gate, prompts } = harness({ tokens: 100 });
    gate.begin('request-1');
    gate.settleUsage('request-1', 'unit-1', { input: 60, output: 0 });
    gate.noteUsage('request-1', 'unit-2', { input: 40, output: 0 });
    expect(await seen(gate.boundary('request-1', 'effect'))).toBe('held');
    expect(prompts[0].facts.reached).toEqual([{ limit: 'tokens', configured: 100, allowance: 100, observed: 100 }]);
  });
});

describe('RequestCeilingGate never forgets a request something can still continue', () => {
  function filled(limits: RequestLimits = { providerTurns: 2 }) {
    const made = harness(limits);
    made.gate.begin('stopped');
    made.gate.begin('at-limit');
    made.gate.begin('inside');
    for (let index = 0; index < MAX_TRACKED_REQUESTS - 3; index++) made.gate.begin(`filler-${index}`);
    return made;
  }

  it('asks the host nothing below the bound', () => {
    const { gate, reachability } = harness({ providerTurns: 2 });
    for (let index = 0; index < MAX_TRACKED_REQUESTS - 1; index++) gate.begin(`request-${index}`);
    expect(reachability.asked).toBe(0);
    gate.begin('at-the-bound');
    expect(reachability.asked).toBe(0);
  });

  it('at the bound keeps every request the host says can continue, with its totals and its stop', async () => {
    const { gate, prompts, reachability } = filled();
    gate.noteProviderRequest('at-limit', 'agent', 'request');
    gate.noteProviderRequest('at-limit', 'agent', 'request');
    gate.noteProviderRequest('stopped', 'agent', 'request');
    gate.noteProviderRequest('stopped', 'agent', 'request');
    const held = gate.boundary('stopped', 'effect');
    prompts[0].answer('stop');
    expect(await held).toBe('stopped');
    gate.noteProviderRequest('inside', 'agent', 'request');

    reachability.ids = new Set(['stopped', 'at-limit', 'inside']);
    gate.begin('one-more');
    expect(reachability.asked).toBe(1);
    // What can continue is exactly as it was: stopped stays stopped, the limit still holds, the count stands.
    expect(await gate.boundary('stopped', 'effect')).toBe('stopped');
    expect(gate.wouldHold('at-limit')).toBe(true);
    expect(gate.facts('inside')?.providerTurns?.observed).toBe(1);
    // What nothing can continue is gone, and the new request is tracked.
    expect(gate.governs('filler-0')).toBe(false);
    expect(gate.governs('one-more')).toBe(true);
  });

  it('keeps everything when the host cannot say what can continue', () => {
    const { gate, reachability } = filled();
    reachability.fails = true;
    gate.begin('one-more');
    expect(reachability.asked).toBe(1);
    for (const requestId of ['stopped', 'at-limit', 'inside', 'filler-0', 'one-more']) {
      expect(gate.governs(requestId)).toBe(true);
    }
  });

  it('keeps a request the person is being asked about even when the host no longer lists it', async () => {
    const { gate, prompts, reachability } = filled({ providerTurns: 1 });
    gate.noteProviderRequest('at-limit', 'agent', 'request');
    const held = gate.boundary('at-limit', 'effect');
    expect(await seen(held)).toBe('held');

    reachability.ids = new Set();
    gate.begin('one-more');
    expect(gate.facts('at-limit')?.decision).toBe('awaiting');
    expect(prompts[0].signal.aborted).toBe(false);
    prompts[0].answer('continue');
    expect(await held).toBe('proceed');
  });
});
