import { describe, expect, it, vi } from 'vitest';
import { ScopedMetadataCache } from '../ScopedMetadataCache';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('ScopedMetadataCache', () => {
  it('deduplicates only an identical scoped key; concurrent connections never share a value', async () => {
    const cache = new ScopedMetadataCache<string>();
    const first = deferred<string>();
    const second = deferred<string>();
    const load = vi.fn((key: string) => key === 'connection-a' ? first.promise : second.promise);
    const loadA = () => load('connection-a');
    const loadB = () => load('connection-b');

    const a1 = cache.get('connection-a|route|credential-a', loadA);
    const a2 = cache.get('connection-a|route|credential-a', loadA);
    const b = cache.get('connection-b|route|credential-b', loadB);
    await Promise.resolve();

    expect(load).toHaveBeenCalledTimes(2);
    first.resolve('only-a');
    second.resolve('only-b');
    await expect(a1).resolves.toMatchObject({ value: 'only-a' });
    await expect(a2).resolves.toMatchObject({ value: 'only-a' });
    await expect(b).resolves.toMatchObject({ value: 'only-b' });
  });

  it('cancels one caller without cancelling another caller sharing the same in-flight request', async () => {
    const cache = new ScopedMetadataCache<string>();
    const loading = deferred<string>();
    const load = vi.fn(async () => loading.promise);
    const controller = new AbortController();

    const cancelled = cache.get('one', load, controller.signal);
    const retained = cache.get('one', load);
    await Promise.resolve();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    loading.resolve('still-valid');
    await expect(retained).resolves.toMatchObject({ value: 'still-valid', state: 'fresh' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not disguise a cancelled stale refresh as a completed stale cache hit', async () => {
    let now = 0;
    const cache = new ScopedMetadataCache<string>(1_000, () => now);
    await cache.get('one', async () => 'old');
    now = 1_001;
    const loading = deferred<string>();
    const controller = new AbortController();
    const cancelled = cache.get('one', async () => loading.promise, controller.signal);
    await Promise.resolve();
    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    loading.resolve('unused');
  });
});
