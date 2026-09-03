import { describe, expect, it } from 'vitest';
import { discoverContextWindow } from '../ContextWindowDiscovery';

describe('discoverContextWindow', () => {
  it.each([
    ['context_length', { context_length: 128_000 }, 128_000],
    ['max_context_length', { max_context_length: '65536' }, 65_536],
    ['context_window', { context_window: 32_768 }, 32_768],
  ] as const)('reads %s without inventing a different spelling', (field, record, tokens) => {
    expect(discoverContextWindow('gateway-model', record)).toEqual({ model: 'gateway-model', field, tokens });
  });

  it('reads a nested value from the selected model record', () => {
    expect(discoverContextWindow('nested-model', {
      id: 'nested-model',
      capabilities: { limits: { max_context_length: '200000' } },
    })).toEqual({ model: 'nested-model', field: 'max_context_length', tokens: 200_000 });
  });

  it('treats omitted, zero, fractional, and malformed values as absent', () => {
    expect(discoverContextWindow('m', { id: 'm' })).toBeUndefined();
    expect(discoverContextWindow('m', { context_window: 0 })).toBeUndefined();
    expect(discoverContextWindow('m', { context_length: 1.5 })).toBeUndefined();
    expect(discoverContextWindow('m', { max_context_length: '128k' })).toBeUndefined();
  });

  it('does not borrow a window from a separate model record', () => {
    const first = { id: 'small', context_length: 16_000 };
    const second = { id: 'large' };
    expect(discoverContextWindow(second.id, second)).toBeUndefined();
    expect(discoverContextWindow(first.id, first)).toMatchObject({ tokens: 16_000 });
  });
});
