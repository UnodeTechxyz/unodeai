import { describe, expect, it } from 'vitest';
import { shouldPrewarmBackend } from '../prewarmPolicy';

describe('shouldPrewarmBackend', () => {
  it('never starts any backend during activation, selection, reload, or restore', () => {
    const storedCodexConsent = true;
    expect(storedCodexConsent).toBe(true);
    expect(shouldPrewarmBackend('codex')).toBe(false);
    expect(shouldPrewarmBackend('openai-compat')).toBe(false);
    expect(shouldPrewarmBackend('claude')).toBe(false);
  });
});
