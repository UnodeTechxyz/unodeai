import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MIN_OBSERVED_CONTEXT_BOUND_TOKENS,
  decideContextWindowBound,
  decideContextWindowMeasurement,
  resolveContextWindow,
} from '../contextWindowDefaults';

const measured = { model: 'gateway-model', tokens: 128_000, field: 'context_length' as const };

describe('context-window precedence', () => {
  it('uses a provider measurement only for the exact model it described', () => {
    expect(resolveContextWindow({ model: 'gateway-model', measuredContextWindow: measured })).toMatchObject({
      tokens: 128_000,
      source: 'measured',
    });
    expect(resolveContextWindow({ model: 'other-model', measuredContextWindow: measured })).toEqual({
      tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      source: 'assumed',
    });
  });

  it('makes an explicit user value win even when the gateway disagrees', () => {
    expect(resolveContextWindow({
      model: 'gateway-model',
      contextWindowTokens: 64_000,
      measuredContextWindow: measured,
    })).toEqual({ tokens: 64_000, source: 'configured' });
    expect(decideContextWindowMeasurement({
      model: 'gateway-model',
      explicitTokens: 64_000,
      prior: measured,
      discovered: { model: 'gateway-model', tokens: 128_000, field: 'context_length' },
    })).toEqual({ measurement: measured, applied: false });
  });

  it('does not alter the stored state when a gateway omits or fails to provide a window', () => {
    expect(decideContextWindowMeasurement({ model: 'gateway-model', prior: measured })).toEqual({
      measurement: measured,
      applied: false,
    });
  });

  it('replaces only the inherited default with a fresh exact-model measurement', () => {
    const detected = { model: 'gateway-model', tokens: 256_000, field: 'context_window' as const };
    expect(decideContextWindowMeasurement({ model: 'gateway-model', prior: measured, discovered: detected })).toEqual({
      measurement: detected,
      applied: true,
    });
  });
});

// A gateway that refuses a request for size has told us something no advertisement can contradict. Left
// unrecorded, the guard recomputes its threshold from the disproved number every turn, automatic compaction
// never fires, and the user presses Compact by hand for the rest of the conversation — the field transcript
// of 2026-08-10, where the same 502 arrived over and over.
describe('a refusal for size is evidence', () => {
  const bound = { model: 'gateway-model', tokens: 96_000, observedAt: '2026-08-10T00:00:00.000Z' };

  it('lets a refusal tighten the window a measurement or the default claimed', () => {
    expect(resolveContextWindow({ model: 'gateway-model', observedContextWindow: bound })).toMatchObject({
      tokens: 96_000,
      source: 'observed',
    });
    expect(resolveContextWindow({
      model: 'gateway-model',
      measuredContextWindow: measured,
      observedContextWindow: bound,
    })).toMatchObject({ tokens: 96_000, source: 'observed', measurement: measured });
  });

  it('never lets a refusal argue for MORE room than is already believed', () => {
    const loose = { ...bound, tokens: 512_000 };
    expect(resolveContextWindow({
      model: 'gateway-model',
      measuredContextWindow: measured,
      observedContextWindow: loose,
    })).toMatchObject({ tokens: 128_000, source: 'measured' });
  });

  it('applies a refusal only to the model that produced it, and never over an explicit setting', () => {
    expect(resolveContextWindow({ model: 'other-model', observedContextWindow: bound })).toEqual({
      tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      source: 'assumed',
    });
    expect(resolveContextWindow({
      model: 'gateway-model',
      contextWindowTokens: 200_000,
      observedContextWindow: bound,
    })).toEqual({ tokens: 200_000, source: 'configured' });
  });

  it('records the rejected size as the new ceiling', () => {
    expect(decideContextWindowBound({
      model: 'gateway-model',
      rejectedEstimate: 96_000,
      observedAt: '2026-08-10T00:00:00.000Z',
    })).toEqual({ bound, applied: true });
  });

  it('keeps the tighter of two refusals rather than relaxing to the newer one', () => {
    expect(decideContextWindowBound({
      model: 'gateway-model',
      prior: bound,
      rejectedEstimate: 120_000,
      observedAt: '2026-08-11T00:00:00.000Z',
    })).toEqual({ bound, applied: false, reason: 'not-tighter' });
    expect(decideContextWindowBound({
      model: 'gateway-model',
      prior: bound,
      rejectedEstimate: 40_000,
      observedAt: '2026-08-11T00:00:00.000Z',
    })).toEqual({
      bound: { model: 'gateway-model', tokens: 40_000, observedAt: '2026-08-11T00:00:00.000Z' },
      applied: true,
    });
  });

  // A request carries far more than the conversation. When the history is this small the overflow came from
  // the system prompt, tool schemas, or attached knowledge — none of which compaction can shrink. Recording
  // it as the window would summarise on every turn, cost money, and still not make the request fit.
  it('refuses to learn a ceiling the conversation cannot explain', () => {
    expect(decideContextWindowBound({
      model: 'gateway-model',
      rejectedEstimate: MIN_OBSERVED_CONTEXT_BOUND_TOKENS - 1,
      observedAt: '2026-08-10T00:00:00.000Z',
    })).toEqual({ bound: undefined, applied: false, reason: 'below-floor' });
  });

  it('records nothing under a user who stated the window themselves', () => {
    expect(decideContextWindowBound({
      model: 'gateway-model',
      explicitTokens: 200_000,
      rejectedEstimate: 96_000,
      observedAt: '2026-08-10T00:00:00.000Z',
    })).toEqual({ bound: undefined, applied: false, reason: 'explicit-window' });
  });
});
