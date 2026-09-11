import { describe, expect, it } from 'vitest';
import { TurnTimingTracker } from '../TurnTiming';

describe('TurnTimingTracker', () => {
  it('keeps queued and same-turn host time while excluding recorded human approval', () => {
    let now = 15_000;
    const tracker = new TurnTimingTracker(() => now);
    tracker.begin('dev', new Date(1_000).toISOString());
    tracker.recordApproval('dev', 2_500);
    now = 15_000;

    expect(tracker.finish('dev')).toEqual({
      startedAt: new Date(1_000).toISOString(),
      settledAt: new Date(15_000).toISOString(),
      durationMs: 11_500,
      approvalWaitMs: 2_500,
    });
  });

  it('does not invent a duration for an untracked historical turn', () => {
    const tracker = new TurnTimingTracker(() => 1_000);
    expect(tracker.finish('missing')).toBeUndefined();
  });
});
