import { describe, expect, it } from 'vitest';
import { contextLabel } from '../contextLabel';

describe('contextLabel', () => {
  it('formats measured openai-compatible context usage', () => {
    expect(contextLabel({ tokens: 32000, window: 128000, ratio: 0.25 }, 'openai-compat')).toEqual({
      text: '25% of 128k tokens',
      percent: 25,
      level: 'low',
    });
  });

  it('does not fake Claude context usage', () => {
    expect(contextLabel(undefined, 'claude')).toEqual({
      text: 'Context managed by Claude',
      percent: 0,
      level: 'none',
    });
  });

  it('labels high usage', () => {
    expect(contextLabel({ tokens: 90, window: 100, ratio: 0.9 }, 'openai-compat').level).toBe('high');
  });
});
