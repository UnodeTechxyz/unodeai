import { describe, expect, it } from 'vitest';
import { createUnifiedDiff } from '../diff';

describe('createUnifiedDiff', () => {
  it('shows changed lines with unified diff signs', () => {
    const diff = createUnifiedDiff('one\ntwo\nthree', 'one\nTWO\nthree', 'a.txt');

    expect(diff.truncated).toBe(false);
    expect(diff.text).toContain('--- a.txt');
    expect(diff.text).toContain('+++ a.txt');
    expect(diff.text).toContain('-two');
    expect(diff.text).toContain('+TWO');
  });

  it('handles new files as added lines', () => {
    const diff = createUnifiedDiff(null, 'first\nsecond', 'new.txt');

    expect(diff.text).toContain('+first');
    expect(diff.text).toContain('+second');
  });

  it('caps large diffs', () => {
    const diff = createUnifiedDiff('a'.repeat(100), 'b'.repeat(100), 'big.txt', { maxChars: 40 });

    expect(diff.truncated).toBe(true);
    expect(diff.text.length).toBeLessThanOrEqual(40);
    expect(diff.text).toContain('[diff truncated]');
  });
});
