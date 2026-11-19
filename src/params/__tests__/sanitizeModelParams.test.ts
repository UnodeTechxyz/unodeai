import { describe, it, expect } from 'vitest';
import { sanitizeParams, sanitizeContextWindow } from '../sanitizeModelParams';

describe('sanitizeParams (F1, untrusted webview input)', () => {
  it('keeps valid numeric fields and rounds max_tokens', () => {
    const out = sanitizeParams({ temperature: 0.3, top_p: 0.9, max_tokens: 8000.7, presence_penalty: 0.5, frequency_penalty: -0.5 });
    expect(out).toEqual({ temperature: 0.3, top_p: 0.9, max_tokens: 8001, presence_penalty: 0.5, frequency_penalty: -0.5 });
  });

  it('clamps out-of-range values into bounds', () => {
    const out = sanitizeParams({ temperature: 9, top_p: 5, presence_penalty: -10, frequency_penalty: 10 });
    expect(out.temperature).toBe(2);
    expect(out.top_p).toBe(1);
    expect(out.presence_penalty).toBe(-2);
    expect(out.frequency_penalty).toBe(2);
  });

  it('drops non-numeric and unknown fields', () => {
    const out = sanitizeParams({ temperature: 'hot', bogus: 1, __proto__: { polluted: true } });
    expect('temperature' in out).toBe(false);
    expect('bogus' in (out as Record<string, unknown>)).toBe(false);
  });

  it('accepts valid enums and rejects invalid ones', () => {
    expect(sanitizeParams({ reasoning_effort: 'xhigh' }).reasoning_effort).toBe('xhigh');
    expect(sanitizeParams({ reasoning_effort: 'turbo' }).reasoning_effort).toBeUndefined();
    expect(sanitizeParams({ response_format: 'json_object' }).response_format).toEqual({ type: 'json_object' });
    expect(sanitizeParams({ response_format: 'yaml' }).response_format).toBeUndefined();
  });

  it('accepts stream, tool_choice, stop, and thinking controls', () => {
    const out = sanitizeParams({
      stream: false,
      tool_choice: 'auto',
      stop: ['END', 'STOP', '', 'DONE', 'EXTRA'],
      thinking: { type: 'enabled', budget_tokens: 1234.6 },
    });
    expect(out.stream).toBe(false);
    expect(out.tool_choice).toBe('auto');
    expect(out.stop).toEqual(['END', 'STOP', 'DONE', 'EXTRA']);
    expect(out.thinking).toEqual({ type: 'enabled', budget_tokens: 1235 });
  });

  it('drops malformed nested advanced params', () => {
    const out = sanitizeParams({
      stream: 'false',
      tool_choice: '   ',
      stop: [1, 2, ''],
      thinking: { type: 'turbo', budget_tokens: 100 },
    });
    expect(out.stream).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
    expect(out.stop).toBeUndefined();
    expect(out.thinking).toBeUndefined();
  });

  it('returns an empty object for junk input', () => {
    expect(sanitizeParams(undefined)).toEqual({});
    expect(sanitizeParams('nope')).toEqual({});
    expect(sanitizeParams(42)).toEqual({});
  });
});

describe('sanitizeContextWindow (F1b)', () => {
  it('accepts a positive integer (rounded)', () => {
    expect(sanitizeContextWindow(32000)).toBe(32000);
    expect(sanitizeContextWindow('200000')).toBe(200000);
    expect(sanitizeContextWindow(64000.9)).toBe(64001);
  });

  it('returns undefined for non-numeric or non-positive input (falls back to default)', () => {
    expect(sanitizeContextWindow('')).toBeUndefined();
    expect(sanitizeContextWindow(undefined)).toBeUndefined();
    expect(sanitizeContextWindow('abc')).toBeUndefined();
    expect(sanitizeContextWindow(0)).toBe(1); // clamped to min 1
  });
});
