import { describe, expect, it } from 'vitest';
import { compactOutcomeMessage, unavailableReasonForMeter } from '../compactOutcome';

// Codex audit, 2026-08-11: the composer meter said "start the agent" for an OpenAI-compatible agent that had
// not been started, while pressing the same action answered "this backend manages its own context". Two host
// surfaces contradicting each other about one agent, because `supported: false` collapsed three unrelated
// conditions into one and every caller rendered the first.
describe('what a user is told after asking to compact', () => {
  it('does not tell the owner of an unstarted agent that its runtime owns the context', () => {
    const notStarted = compactOutcomeMessage({ supported: false, compacted: false, dropped: 0, reason: 'not-started' }, 'Dev');
    expect(notStarted).toMatch(/not running/);
    expect(notStarted).not.toMatch(/manages its own context/);
    expect(notStarted).toContain('Dev');
  });

  it('still says so when the runtime genuinely owns the context', () => {
    expect(compactOutcomeMessage({ supported: false, compacted: false, dropped: 0, reason: 'unsupported' }))
      .toMatch(/manages its own context/);
  });

  it('reports what was dropped, and refuses rather than claiming success when nothing was', () => {
    expect(compactOutcomeMessage({ supported: true, compacted: true, dropped: 1 })).toMatch(/Compacted 1 older message /);
    expect(compactOutcomeMessage({ supported: true, compacted: true, dropped: 4 })).toMatch(/Compacted 4 older messages /);
    const nothing = compactOutcomeMessage({ supported: true, compacted: false, dropped: 0 });
    expect(nothing).toMatch(/Nothing could be compacted/);
    // The likeliest real cause, because this is the answer a user gets while a gateway is still rejecting.
    expect(nothing).toMatch(/context window set for this agent is larger/);
  });

  it('derives the reason from the same runtime fact the meter shows', () => {
    expect(unavailableReasonForMeter({ kind: 'not-started' })).toBe('not-started');
    expect(unavailableReasonForMeter({ kind: 'unsupported' })).toBe('unsupported');
    expect(unavailableReasonForMeter(undefined)).toBe('unknown-session');
    expect(unavailableReasonForMeter({
      kind: 'usage',
      usage: { tokens: 1, window: 2, ratio: 0.5, source: 'assumed' },
    })).toBeUndefined();
  });
});
