import { describe, expect, it } from 'vitest';
import { awaitMediaCapability, MediaCapabilityCache, mediaCapabilityKey } from '../MediaCapability';

const route = { connectionId: 'Gateway-A', modelId: 'vision-1', endpointBase: 'https://gateway.example.test/v1' };

describe('MediaCapabilityCache', () => {
  it('uses declared support but treats a missing declaration as unknown', () => {
    const cache = new MediaCapabilityCache();
    expect(cache.resolve(route, 'image', true)).toMatchObject({ state: 'supported', source: 'declared' });
    expect(cache.resolve(route, 'image', false)).toMatchObject({ state: 'unsupported', source: 'declared' });
    expect(cache.resolve(route, 'image', undefined)).toMatchObject({ state: 'unknown', source: 'declared' });
  });

  it('lets a scoped observed rejection override the declaration without poisoning another route or class', () => {
    const cache = new MediaCapabilityCache();
    cache.record(route, 'image', { state: 'unsupported', detail: 'Gateway rejected image_url.' });
    expect(cache.resolve(route, 'image', true)).toMatchObject({ state: 'unsupported', source: 'observed' });
    expect(cache.resolve({ ...route, modelId: 'vision-2' }, 'image', true)).toMatchObject({ state: 'supported', source: 'declared' });
    expect(cache.resolve(route, 'audio', true)).toMatchObject({ state: 'supported', source: 'declared' });
    expect(mediaCapabilityKey(route, 'image')).not.toBe(mediaCapabilityKey({ ...route, endpointBase: 'https://other.example.test/v1' }, 'image'));
  });

  it('shares a discovery while one cancelled waiter leaves the observation running for another', async () => {
    const cache = new MediaCapabilityCache();
    let resolveDiscovery!: (value: { state: 'supported'; detail: string }) => void;
    let calls = 0;
    const discover = () => {
      calls++;
      return new Promise<{ state: 'supported'; detail: string }>((resolve) => { resolveDiscovery = resolve; });
    };
    const controller = new AbortController();
    const shared = cache.observe(route, 'image', discover);
    const cancelled = awaitMediaCapability(shared, controller.signal);
    const survivor = cache.observe(route, 'image', discover);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    resolveDiscovery({ state: 'supported', detail: 'Probe accepted an image.' });
    await expect(survivor).resolves.toMatchObject({ state: 'supported', source: 'observed' });
    expect(calls).toBe(1);
    expect(cache.resolve(route, 'image', undefined)).toMatchObject({ state: 'supported', source: 'observed' });
  });
});
