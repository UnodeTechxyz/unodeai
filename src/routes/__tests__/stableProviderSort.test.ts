import { describe, expect, it } from 'vitest';
import { BUILTIN_CONNECTION_REGISTRY } from '../ConnectionRegistry';
import { stableProviderSort } from '../stableProviderSort';

describe('stableProviderSort', () => {
  it('puts Unode first and Roam second while preserving unranked registry order', () => {
    const ids = [
      'roam',
      'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'unode',
      'openrouter',
      'custom:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ];

    expect(stableProviderSort(ids, (id) => id)).toEqual([
      'unode',
      'roam',
      'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'openrouter',
      'custom:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
  });

  it('does not mutate its input or affect default-provider resolution', () => {
    const ids = ['roam', 'unode', 'openai'];
    const defaultConnection = BUILTIN_CONNECTION_REGISTRY.connectionIdForProviderId('unode');

    stableProviderSort(ids, (id) => id);

    expect(ids).toEqual(['roam', 'unode', 'openai']);
    expect(BUILTIN_CONNECTION_REGISTRY.connectionIdForProviderId('unode')).toBe(defaultConnection);
  });
});

describe('registry declaration order', () => {
  it('declares unode before roam, because an unsorted consumer takes the first one', () => {
    // stableProviderSort fixes the four DISPLAY pickers, but AgentBuilderPanel's `firstProvider`
    // fallback reads the unsorted list and takes the first non-coming-soon profile. While roam was
    // declared first, an agent whose default provider failed to resolve silently fell back to Roam.
    // The registry order is therefore load-bearing, not cosmetic.
    const ids = BUILTIN_CONNECTION_REGISTRY.profiles.map((profile) => profile.id);
    expect(ids.indexOf('unode')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('unode')).toBeLessThan(ids.indexOf('roam'));

    const firstRunnable = BUILTIN_CONNECTION_REGISTRY.profiles
      .find((profile) => profile.availability !== 'coming-soon');
    expect(firstRunnable?.id).toBe('unode');
  });
});
