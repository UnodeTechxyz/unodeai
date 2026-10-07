import { describe, expect, it } from 'vitest';
import { TurnTimingTracker, type TurnTiming } from '../TurnTiming';

function clock(start = 10_000) {
  const state = { now: start };
  return { state, tracker: new TurnTimingTracker(() => state.now) };
}

/** The two identities every recorded turn satisfies. */
function expectPartition(timing: TurnTiming): void {
  const phases = timing.phases!;
  expect(phases.queuedMs + phases.hostMs + phases.providerWaitMs + phases.reasoningMs + phases.respondingMs + phases.toolMs)
    .toBe(timing.durationMs);
  expect(Date.parse(timing.settledAt) - Date.parse(timing.startedAt)).toBe(timing.durationMs + timing.approvalWaitMs);
}

describe('TurnTimingTracker', () => {
  it('partitions a turn into queue, host, provider wait, reasoning, response and tool time', () => {
    const { state, tracker } = clock(10_000);
    tracker.begin('dev', new Date(4_000).toISOString());   // queued 6 s in the inbox
    state.now = 11_000; tracker.modelRequest('dev');        // 1 s of host work
    state.now = 14_000; tracker.reasoning('dev');           // 3 s waiting for the provider
    state.now = 16_000; tracker.responding('dev');          // 2 s of reasoning
    state.now = 16_500; tracker.toolStarted('dev', 'a');    // 0.5 s of response
    state.now = 20_500; tracker.toolFinished('dev', 'a');   // 4 s of tool
    state.now = 21_500; tracker.responding('dev');          // 1 s waiting again
    state.now = 22_000;                                     // 0.5 s of response
    const timing = tracker.finish('dev')!;

    expect(timing).toEqual({
      startedAt: new Date(4_000).toISOString(),
      settledAt: new Date(22_000).toISOString(),
      durationMs: 18_000,
      approvalWaitMs: 0,
      phases: {
        queuedMs: 6_000, hostMs: 1_000, providerWaitMs: 4_000, reasoningMs: 2_000, respondingMs: 1_000, toolMs: 4_000,
        providerWaitCount: 2, longestProviderWaitMs: 3_000,
      },
    });
    expectPartition(timing);
  });

  it('keeps the turn in the tool phase until every parallel call has a result', () => {
    const { state, tracker } = clock();
    tracker.begin('dev', undefined);
    tracker.modelRequest('dev');
    state.now += 1_000; tracker.toolStarted('dev', 'a');
    state.now += 1_000; tracker.toolStarted('dev', 'b');
    // Reasoning and content that arrive while a call is still open do not end the tool time.
    state.now += 1_000; expect(tracker.reasoning('dev')).toBe(false);
    state.now += 1_000; expect(tracker.responding('dev')).toBe(false);
    state.now += 1_000; tracker.toolFinished('dev', 'a');
    expect(tracker.snapshot('dev')).toMatchObject({ phase: 'tool', openTools: 1 });
    state.now += 1_000; tracker.toolFinished('dev', 'b');
    expect(tracker.snapshot('dev')).toMatchObject({ phase: 'provider-wait', openTools: 0 });
    state.now += 2_000;
    const timing = tracker.finish('dev')!;

    expect(timing.phases).toMatchObject({ toolMs: 5_000, reasoningMs: 0, respondingMs: 0, providerWaitMs: 3_000 });
    expectPartition(timing);
  });

  it('ignores a result for a call the turn never opened', () => {
    const { state, tracker } = clock();
    tracker.begin('dev', undefined);
    tracker.modelRequest('dev');
    state.now += 1_000; tracker.toolStarted('dev', 'a');
    state.now += 1_000; expect(tracker.toolFinished('dev', 'never-opened')).toBe(false);
    expect(tracker.snapshot('dev')).toMatchObject({ phase: 'tool', openTools: 1 });
  });

  it('continues one provider wait when the host sends its request after a tool result', () => {
    const { state, tracker } = clock();
    tracker.begin('dev', undefined);
    tracker.modelRequest('dev');
    state.now += 1_000; tracker.toolStarted('dev', 'a');
    state.now += 1_000; tracker.toolFinished('dev', 'a');
    state.now += 200; expect(tracker.modelRequest('dev')).toBe(false);
    state.now += 4_800; tracker.responding('dev');
    const timing = tracker.finish('dev')!;

    expect(timing.phases).toMatchObject({ providerWaitCount: 2, longestProviderWaitMs: 5_000, providerWaitMs: 6_000 });
  });

  it('removes a human approval from whichever phase surrounds it, and counts overlapping approvals once', () => {
    const { state, tracker } = clock();
    tracker.begin('dev', undefined);
    tracker.modelRequest('dev');
    state.now += 1_000; tracker.toolStarted('dev', 'a');
    tracker.toolStarted('dev', 'b');
    state.now += 500; expect(tracker.approvalStarted('dev', 'approve-a')).toBe(true);
    state.now += 2_000; expect(tracker.approvalStarted('dev', 'approve-b')).toBe(false);
    state.now += 3_000; expect(tracker.approvalFinished('dev', 'approve-a')).toBe(false);
    state.now += 4_000; expect(tracker.approvalFinished('dev', 'approve-b')).toBe(true);
    state.now += 500; tracker.toolFinished('dev', 'a');
    tracker.toolFinished('dev', 'b');
    const timing = tracker.finish('dev')!;

    // The two waits overlap for 3 s; the person kept the turn waiting for 9 s, not 12 s.
    expect(timing.approvalWaitMs).toBe(9_000);
    expect(timing.phases).toMatchObject({ toolMs: 1_000, providerWaitMs: 1_000 });
    expectPartition(timing);
  });

  it('charges nothing to a phase that begins while an approval is open', () => {
    const { state, tracker } = clock();
    tracker.begin('dev', undefined);
    tracker.modelRequest('dev');
    state.now += 1_000; tracker.toolStarted('dev', 'a');
    state.now += 1_000; tracker.approvalStarted('dev', 'approve');
    // The call settles while the person is still deciding: a phase boundary inside the wait.
    state.now += 5_000; tracker.toolFinished('dev', 'a');
    state.now += 5_000; tracker.approvalFinished('dev', 'approve');
    state.now += 2_000; tracker.responding('dev');
    const timing = tracker.finish('dev')!;

    expect(timing.approvalWaitMs).toBe(10_000);
    expect(timing.phases).toMatchObject({ toolMs: 1_000, providerWaitMs: 3_000, longestProviderWaitMs: 2_000 });
    expectPartition(timing);
  });

  it('treats a provider wait interrupted by an approval as one wait', () => {
    const { state, tracker } = clock();
    tracker.begin('dev', undefined);
    tracker.modelRequest('dev');
    state.now += 4_000; tracker.approvalStarted('dev', 'approve');
    state.now += 60_000; tracker.approvalFinished('dev', 'approve');
    state.now += 3_000; tracker.responding('dev');
    const timing = tracker.finish('dev')!;

    expect(timing.phases).toMatchObject({ providerWaitMs: 7_000, providerWaitCount: 1, longestProviderWaitMs: 7_000 });
    expect(timing.approvalWaitMs).toBe(60_000);
  });

  it('reports the live phase from the host, with the approval ahead of the tool behind it', () => {
    const { state, tracker } = clock(50_000);
    expect(tracker.snapshot('dev')).toBeUndefined();
    tracker.begin('dev', new Date(48_000).toISOString());
    expect(tracker.snapshot('dev')).toEqual({
      phase: 'host', phaseStartedAt: new Date(50_000).toISOString(), turnStartedAt: new Date(48_000).toISOString(),
      openTools: 0, activeMs: 2_000, phaseActiveMs: 0, phaseToolCalls: 0, observedAt: new Date(50_000).toISOString(),
      approvalPending: false,
    });
    state.now = 51_000; expect(tracker.modelRequest('dev')).toBe(true);
    expect(tracker.snapshot('dev')).toMatchObject({ phase: 'provider-wait', phaseStartedAt: new Date(51_000).toISOString() });
    // The same phase again is not a change, so the host has nothing new to publish.
    state.now = 52_000; expect(tracker.reasoning('dev')).toBe(true);
    state.now = 53_000; expect(tracker.reasoning('dev')).toBe(false);
    state.now = 54_000; expect(tracker.toolStarted('dev', 'a')).toBe(true);
    state.now = 55_000; tracker.approvalStarted('dev', 'approve');
    expect(tracker.snapshot('dev')).toMatchObject({
      phase: 'tool', openTools: 1, approvalPending: true, approvalStartedAt: new Date(55_000).toISOString(),
    });
    tracker.finish('dev');
    expect(tracker.snapshot('dev')).toBeUndefined();
  });

  it('reports the turn time so far without the human waits in it, and holds it while a decision is open', () => {
    const { state, tracker } = clock(50_000);
    tracker.begin('dev', new Date(48_000).toISOString());
    state.now = 51_000; tracker.modelRequest('dev');
    state.now = 54_000; tracker.toolStarted('dev', 'a');
    expect(tracker.snapshot('dev')).toMatchObject({ activeMs: 6_000, observedAt: new Date(54_000).toISOString() });

    state.now = 55_000; tracker.approvalStarted('dev', 'first');
    state.now = 57_000; tracker.approvalStarted('dev', 'second');
    state.now = 60_000; tracker.approvalFinished('dev', 'first');
    // The pause began with the first decision and is still open: the turn time stands where it stopped.
    expect(tracker.snapshot('dev')).toMatchObject({
      activeMs: 7_000, approvalPending: true, approvalStartedAt: new Date(55_000).toISOString(),
    });
    // A call that settles inside the pause changes the phase, not the turn time.
    state.now = 70_000; tracker.toolFinished('dev', 'a');
    expect(tracker.snapshot('dev')).toMatchObject({ phase: 'provider-wait', activeMs: 7_000, approvalPending: true });

    state.now = 95_000; tracker.approvalFinished('dev', 'second');
    expect(tracker.snapshot('dev')).toMatchObject({
      activeMs: 7_000, observedAt: new Date(95_000).toISOString(), approvalPending: false,
    });
    expect(tracker.snapshot('dev')).not.toHaveProperty('approvalStartedAt');
    state.now = 98_000;
    const timing = tracker.finish('dev')!;
    expect(timing).toMatchObject({ durationMs: 10_000, approvalWaitMs: 40_000 });
    expectPartition(timing);
  });

  it('keeps a decision inside a phase out of the phase time, and resumes the phase where it stopped', () => {
    const { state, tracker } = clock(0);
    tracker.begin('dev', undefined);
    tracker.modelRequest('dev');
    state.now = 1_000; tracker.toolStarted('dev', 'a');
    state.now = 2_000; tracker.approvalStarted('dev', 'approve');
    state.now = 32_000; tracker.approvalFinished('dev', 'approve');
    // The call has run for 1 s. The 30 s the person took are not its time, and it did not start again.
    expect(tracker.snapshot('dev')).toMatchObject({
      phase: 'tool', phaseStartedAt: new Date(1_000).toISOString(), phaseActiveMs: 1_000,
      activeMs: 2_000, observedAt: new Date(32_000).toISOString(),
    });
    state.now = 35_000; tracker.toolFinished('dev', 'a');
    // A new phase starts from nothing.
    expect(tracker.snapshot('dev')).toMatchObject({ phase: 'provider-wait', phaseActiveMs: 0, activeMs: 5_000 });
    state.now = 36_000; tracker.modelRequest('dev');
    expect(tracker.snapshot('dev')).toMatchObject({ phase: 'provider-wait', phaseActiveMs: 1_000 });
    expect(tracker.finish('dev')!.phases).toMatchObject({ toolMs: 4_000, providerWaitMs: 2_000 });
  });

  it('says how many calls have shared the tool phase, so its time is one call\'s only when there was one', () => {
    const { state, tracker } = clock(0);
    tracker.begin('dev', undefined);
    tracker.modelRequest('dev');
    expect(tracker.snapshot('dev')).toMatchObject({ phase: 'provider-wait', phaseToolCalls: 0 });
    state.now = 1_000; tracker.toolStarted('dev', 'a');
    state.now = 2_000; tracker.toolStarted('dev', 'a');
    // One call, reported twice: the 1 s of this phase are its own.
    expect(tracker.snapshot('dev')).toMatchObject({ phase: 'tool', openTools: 1, phaseToolCalls: 1, phaseActiveMs: 1_000 });
    state.now = 26_000; tracker.toolStarted('dev', 'b');
    state.now = 27_000; tracker.toolFinished('dev', 'a');
    // `b` has run for 1 s. The 26 s of the phase are not its time, although it is the only call still open.
    expect(tracker.snapshot('dev')).toMatchObject({ phase: 'tool', openTools: 1, phaseToolCalls: 2, phaseActiveMs: 26_000 });
    state.now = 30_000; tracker.toolFinished('dev', 'b');
    expect(tracker.snapshot('dev')).toMatchObject({ phase: 'provider-wait', phaseToolCalls: 0 });
    // The next tool phase counts from one again.
    state.now = 31_000; tracker.toolStarted('dev', 'c');
    expect(tracker.snapshot('dev')).toMatchObject({ phase: 'tool', phaseToolCalls: 1, phaseActiveMs: 0 });
  });

  // Field run, 2026-10-02: a list_dir card read "Done · 40.2s" under a footer that took the same 40 s out as the
  // person's decision. Each call is told how much of its span was a decision.
  it('says how much of each open call\'s span people spent deciding', () => {
    const { state, tracker } = clock(10_000);
    tracker.begin('dev', undefined);
    state.now = 11_000; tracker.toolStarted('dev', 'asked');
    state.now = 12_000; tracker.approvalStarted('dev', 'p1');
    state.now = 52_000; tracker.approvalFinished('dev', 'p1');
    state.now = 52_500; tracker.toolStarted('dev', 'later');
    expect(tracker.callHumanWaitMs('dev', 'asked')).toBe(40_000);
    tracker.toolFinished('dev', 'asked');
    // A call that opened after the decision was not waiting on it.
    state.now = 53_000; tracker.approvalStarted('dev', 'p2');
    state.now = 55_000; tracker.approvalFinished('dev', 'p2');
    expect(tracker.callHumanWaitMs('dev', 'later')).toBe(2_000);
    tracker.toolFinished('dev', 'later');
    // A call that is not open, and a session with no turn, have no wait to report.
    expect(tracker.callHumanWaitMs('dev', 'asked')).toBeUndefined();
    expect(tracker.callHumanWaitMs('nobody', 'asked')).toBeUndefined();
    expectPartition(tracker.finish('dev')!);
  });

  it('takes every human wait out of the queue, however many a request waited through', () => {
    const { state, tracker } = clock(0);
    // A request waits behind 200 decisions of 1 s each, 1 s apart.
    for (let index = 0; index < 200; index++) {
      state.now += 1_000; tracker.approvalStarted('dev', `decision-${index}`);
      state.now += 1_000; tracker.approvalFinished('dev', `decision-${index}`);
    }
    state.now += 1_000;
    tracker.begin('dev', new Date(0).toISOString());
    const timing = tracker.finish('dev')!;
    expect(timing).toMatchObject({ durationMs: 201_000, approvalWaitMs: 200_000 });
    expect(timing.phases).toMatchObject({ queuedMs: 201_000 });
    expectPartition(timing);
    // The first of them is still known to a request that was sent before it.
    tracker.begin('dev', new Date(500).toISOString());
    expect(tracker.finish('dev')).toMatchObject({ durationMs: 200_500, approvalWaitMs: 200_000 });
  });

  it('takes a human wait out of the queue time of the request that waited through it', () => {
    const { state, tracker } = clock(10_000);
    // The request is sent to a stopped agent. Starting it raises a consent prompt before any turn runs.
    const sentAt = new Date(10_000).toISOString();
    state.now = 12_000; expect(tracker.approvalStarted('dev', 'consent')).toBe(false);
    state.now = 42_000; expect(tracker.approvalFinished('dev', 'consent')).toBe(false);
    state.now = 45_000; tracker.begin('dev', sentAt);
    expect(tracker.snapshot('dev')).toMatchObject({ activeMs: 5_000, approvalPending: false });
    state.now = 46_000;
    const first = tracker.finish('dev')!;
    expect(first).toMatchObject({ durationMs: 6_000, approvalWaitMs: 30_000 });
    expect(first.phases).toMatchObject({ queuedMs: 5_000, hostMs: 1_000 });
    expectPartition(first);

    // A wait that ended before the request was sent is no part of it.
    state.now = 50_000; tracker.begin('dev', new Date(47_000).toISOString());
    const second = tracker.finish('dev')!;
    expect(second).toMatchObject({ durationMs: 3_000, approvalWaitMs: 0 });
    expectPartition(second);
  });

  it('keeps a decision that is open when the turn begins, and one an earlier turn waited on, out of the turn time', () => {
    const { state, tracker } = clock(10_000);
    state.now = 12_000; tracker.approvalStarted('dev', 'consent');
    state.now = 20_000; tracker.begin('dev', new Date(10_000).toISOString());
    // The turn begins paused: the label is the approval and its clock runs from when the prompt opened.
    expect(tracker.snapshot('dev')).toMatchObject({
      phase: 'host', activeMs: 2_000, approvalPending: true, approvalStartedAt: new Date(12_000).toISOString(),
    });
    state.now = 50_000; expect(tracker.approvalFinished('dev', 'consent')).toBe(true);
    state.now = 51_000; tracker.modelRequest('dev');
    state.now = 60_000;
    const first = tracker.finish('dev')!;
    expect(first).toMatchObject({ durationMs: 12_000, approvalWaitMs: 38_000 });
    expect(first.phases).toMatchObject({ queuedMs: 2_000, hostMs: 1_000, providerWaitMs: 9_000 });
    expectPartition(first);

    // A second request was sent at 30 s, while the first turn was waiting for that decision.
    tracker.begin('dev', new Date(30_000).toISOString());
    const second = tracker.finish('dev')!;
    expect(second).toMatchObject({ durationMs: 10_000, approvalWaitMs: 20_000 });
    expect(second.phases).toMatchObject({ queuedMs: 10_000 });
    expectPartition(second);
  });

  it('measures consecutive provider silence apart from the sticky phase', () => {
    const { state, tracker } = clock();
    tracker.begin('dev', undefined);
    // Before the first request nothing has been asked of the provider.
    state.now += 5_000; expect(tracker.providerSilenceMs('dev')).toBeUndefined();
    tracker.modelRequest('dev');
    state.now += 30_000; expect(tracker.providerSilenceMs('dev')).toBe(30_000);
    // One reasoning event restarts the silence. The phase then stays `reasoning` however long nothing follows.
    tracker.reasoning('dev');
    state.now += 90_000;
    expect(tracker.snapshot('dev')).toMatchObject({ phase: 'reasoning' });
    expect(tracker.providerSilenceMs('dev')).toBe(90_000);
    // A running tool and an open approval pause it; the result starts it again from zero.
    tracker.toolStarted('dev', 'a');
    state.now += 40_000; expect(tracker.providerSilenceMs('dev')).toBe(0);
    tracker.toolFinished('dev', 'a');
    state.now += 10_000; tracker.approvalStarted('dev', 'approve');
    state.now += 50_000; tracker.approvalFinished('dev', 'approve');
    state.now += 5_000; expect(tracker.providerSilenceMs('dev')).toBe(15_000);
    tracker.responding('dev');
    expect(tracker.providerSilenceMs('dev')).toBe(0);
  });

  it('resumes the silence a refused first-action call found, and restarts it for any other provider event', () => {
    const { state, tracker } = clock();
    tracker.begin('pm', undefined);
    tracker.modelRequest('pm');
    state.now += 40_000;
    // The call arrives after 40 s of silence. While the host decides, nothing counts.
    tracker.toolStarted('pm', 'dispatch-1', true);
    state.now += 25_000; expect(tracker.providerSilenceMs('pm')).toBe(0);
    // Refused: the provider has still not acted, and the refusal buys no fresh budget.
    tracker.toolFinished('pm', 'dispatch-1', true);
    expect(tracker.providerSilenceMs('pm')).toBe(40_000);
    state.now += 15_000; expect(tracker.providerSilenceMs('pm')).toBe(55_000);

    // An accepted call, or one the caller does not mark as refused, restarts it as any result does.
    tracker.toolStarted('pm', 'dispatch-2', true);
    tracker.toolFinished('pm', 'dispatch-2');
    expect(tracker.providerSilenceMs('pm')).toBe(0);

    // Something else the provider did while a held call was open restarts the silence for good.
    state.now += 30_000;
    tracker.toolStarted('pm', 'dispatch-3', true);
    tracker.toolStarted('pm', 'read-1');
    tracker.toolFinished('pm', 'read-1');
    tracker.toolFinished('pm', 'dispatch-3', true);
    expect(tracker.providerSilenceMs('pm')).toBe(0);
    state.now += 30_000;
    tracker.toolStarted('pm', 'dispatch-4', true);
    tracker.reasoning('pm');
    tracker.toolFinished('pm', 'dispatch-4', true);
    expect(tracker.providerSilenceMs('pm')).toBe(0);

    // Two refused calls open together resume from the longer silence either of them found.
    state.now += 20_000;
    tracker.toolStarted('pm', 'dispatch-5', true);
    tracker.toolStarted('pm', 'close-1', true);
    tracker.toolFinished('pm', 'dispatch-5', true);
    expect(tracker.providerSilenceMs('pm')).toBe(0);
    tracker.toolFinished('pm', 'close-1', true);
    expect(tracker.providerSilenceMs('pm')).toBe(20_000);
    expectPartition(tracker.finish('pm')!);
  });

  it('starts the turn now when the bus timestamp is missing, unreadable or ahead of the clock', () => {
    for (const startedAt of [undefined, 'not a time', new Date(99_000).toISOString()]) {
      const { state, tracker } = clock(20_000);
      tracker.begin('dev', startedAt);
      state.now = 21_000;
      const timing = tracker.finish('dev')!;
      expect(timing).toMatchObject({ startedAt: new Date(20_000).toISOString(), durationMs: 1_000 });
      expect(timing.phases!.queuedMs).toBe(0);
    }
  });

  it('charges nothing when the clock steps backwards', () => {
    const { state, tracker } = clock(20_000);
    tracker.begin('dev', undefined);
    tracker.modelRequest('dev');
    state.now = 25_000; tracker.responding('dev');
    state.now = 22_000; tracker.toolStarted('dev', 'a');
    state.now = 26_000; tracker.toolFinished('dev', 'a');
    const timing = tracker.finish('dev')!;

    expect(timing.phases).toMatchObject({ providerWaitMs: 5_000, respondingMs: 0, toolMs: 1_000 });
    expectPartition(timing);
  });

  it('does not invent a duration for an untracked historical turn', () => {
    const tracker = new TurnTimingTracker(() => 1_000);
    expect(tracker.finish('missing')).toBeUndefined();
    expect(tracker.modelRequest('missing')).toBe(false);
  });

  it('keeps both identities over arbitrary event orders', () => {
    // A fixed seed: the sequences are arbitrary, not different between runs.
    let seed = 0x9e3779b9;
    const next = (bound: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) % bound;
    };
    for (let sequence = 0; sequence < 400; sequence++) {
      const { state, tracker } = clock(1_000_000);
      const sentAt = next(3) === 0 ? undefined : new Date(1_000_000 - next(9_000)).toISOString();
      // Decisions that open and end before the turn begins, some of them still open when it does.
      for (let step = next(6); step > 0; step--) {
        state.now += next(10) === 0 ? -next(500) : next(3_000);
        if (next(2) === 0) tracker.approvalStarted('dev', String(next(3)));
        else tracker.approvalFinished('dev', String(next(3)));
      }
      tracker.begin('dev', sentAt);
      for (let step = 0; step < 60; step++) {
        // Mostly forwards, sometimes not at all, now and then backwards.
        state.now += next(10) === 0 ? -next(500) : next(4_000);
        const id = String(next(3));
        switch (next(8)) {
          case 0: tracker.modelRequest('dev'); break;
          case 1: tracker.reasoning('dev'); break;
          case 2: tracker.responding('dev'); break;
          case 3: tracker.toolStarted('dev', id); break;
          case 4: tracker.toolFinished('dev', id); break;
          case 5: tracker.approvalStarted('dev', id); break;
          case 6: tracker.approvalFinished('dev', id); break;
          default: tracker.providerSilenceMs('dev');
        }
      }
      const timing = tracker.finish('dev')!;
      expectPartition(timing);
      const phases = timing.phases!;
      for (const value of [...Object.values(phases), timing.durationMs, timing.approvalWaitMs]) {
        expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
      }
      expect(phases.longestProviderWaitMs).toBeLessThanOrEqual(phases.providerWaitMs);
      if (phases.providerWaitMs > 0) expect(phases.providerWaitCount).toBeGreaterThan(0);
    }
  });
});
