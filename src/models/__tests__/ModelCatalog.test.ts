import { describe, it, expect, vi } from 'vitest';
import { ModelCatalog, CatalogFetch, ModelInfo } from '../ModelCatalog';

const staticFor = (models: Record<string, ModelInfo[]>) => (pk: string) => models[pk] ?? [];

/** A fetch that maps url substrings to scripted JSON bodies; records calls. */
function routeFetch(routes: Array<{ match: string; status?: number; body: unknown }>): { fetchFn: CatalogFetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: CatalogFetch = async (url) => {
    calls.push(url);
    const r = routes.find((x) => url.includes(x.match));
    if (!r) {
      return { ok: false, status: 404, text: async () => 'not found' };
    }
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => JSON.stringify(r.body) };
  };
  return { fetchFn, calls };
}

/**
 * A gateway answers /v1/models for the key that asked, and two keys on one account can differ.
 *
 * The cache was keyed by provider and base URL alone, so a replaced credential was handed the previous
 * credential's answer until a five-minute TTL happened to lapse. Field report, 2026-08-21: a user swapped
 * their Unode key for one in another price group and saw no change in either the price or the model range —
 * which reads exactly like the swap not working.
 *
 * The same reasoning was already written into this codebase for a much smaller input change: dropping the
 * cache when `unode.extraModels` is edited, because otherwise "the edit would appear whenever the TTL
 * happened to lapse, which reads as the setting not working." A credential is a bigger input than a
 * hand-typed model id.
 */
describe('the cache belongs to one credential', () => {
  const bodyFor = (ids: string[]) => ({ data: ids.map((id) => ({ id })) });

  function keyAwareFetch(byKey: Record<string, string[]>): CatalogFetch {
    return async (url, init) => {
      const auth = init?.headers?.Authorization ?? '';
      const key = auth.replace(/^Bearer /, '') || 'anon';
      return { ok: true, status: 200, text: async () => JSON.stringify(bodyFor(byKey[key] ?? [])) };
    };
  }

  it('does not hand a new key the previous key\'s models', async () => {
    const cat = new ModelCatalog(staticFor({}), keyAwareFetch({
      'key-basic': ['cheap-model'],
      'key-vip': ['cheap-model', 'premium-model'],
    }));

    expect((await cat.list('unode', 'https://gw.example/v1', 'key-basic')).map((m) => m.id))
      .toEqual(['cheap-model']);
    // Same provider, same base URL, different credential — and the answer must change immediately rather
    // than in five minutes.
    expect((await cat.list('unode', 'https://gw.example/v1', 'key-vip')).map((m) => m.id))
      .toEqual(['cheap-model', 'premium-model']);
  });

  it('still caches within one credential, so the TTL keeps doing its job', async () => {
    let calls = 0;
    const fetchFn: CatalogFetch = async () => {
      calls++;
      return { ok: true, status: 200, text: async () => JSON.stringify(bodyFor(['m'])) };
    };
    const cat = new ModelCatalog(staticFor({}), fetchFn);

    await cat.list('unode', 'https://gw.example/v1', 'key-basic');
    await cat.list('unode', 'https://gw.example/v1', 'key-basic');
    expect(calls).toBe(1);
  });

  // The cache key is the sort of string that ends up in a log, so it carries a digest and never the key.
  it('never puts the credential itself in the cache key', async () => {
    const cat = new ModelCatalog(staticFor({}), keyAwareFetch({ 'sk-secret-value': ['m'] }));
    await cat.list('unode', 'https://gw.example/v1', 'sk-secret-value');

    const keys = [...(cat as unknown as { cache: Map<string, unknown> }).cache.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain('sk-secret-value');
    // A 32-bit hash, not a cryptographic control: it separates two credentials, it does not protect one.
    expect(keys[0]).toMatch(/\|[0-9a-z]{1,7}$/);
    expect(keys[0]).toContain('unode|https://gw.example/v1|');
  });
});

describe('ModelCatalog', () => {
  it('parses the gateway /v1/models endpoint (OpenAI shape)', async () => {
    const { fetchFn } = routeFetch([{ match: '/models', body: { data: [{ id: 'deepseek-v4-flash' }, { id: 'qwen-max' }] } }]);
    const cat = new ModelCatalog(staticFor({}), fetchFn);
    const models = await cat.list('roam', 'https://gw.example/v1');
    expect(models.map((m) => m.id)).toEqual(['deepseek-v4-flash', 'qwen-max']);
    expect(models[0].source).toBe('endpoint');
  });

  it('keeps an advertised context window on the matching endpoint model', async () => {
    const { fetchFn } = routeFetch([{
      match: '/models',
      body: { data: [
        { id: 'small', context_length: 16_000 },
        { id: 'large', capabilities: { max_context_length: '128000' } },
        { id: 'unreported' },
      ] },
    }]);
    const cat = new ModelCatalog(staticFor({}), fetchFn);
    const models = await cat.list('gateway', 'https://gw.example/v1');
    expect(models.find((model) => model.id === 'small')?.measuredContextWindow).toEqual({
      model: 'small', tokens: 16_000, field: 'context_length',
    });
    expect(models.find((model) => model.id === 'large')?.measuredContextWindow).toEqual({
      model: 'large', tokens: 128_000, field: 'max_context_length',
    });
    expect(models.find((model) => model.id === 'unreported')?.measuredContextWindow).toBeUndefined();
  });

  it('merges curated catalog (rich names win) with the live endpoint and back-fills names', async () => {
    const { fetchFn } = routeFetch([
      { match: 'catalog.json', body: { providers: { roam: { models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', recommendedFor: ['senior-dev'] }] } } } },
      { match: '/v1/models', body: { data: [{ id: 'deepseek-v4-flash' }, { id: 'new-model-x' }] } },
    ]);
    const cat = new ModelCatalog(staticFor({}), fetchFn, { catalogUrl: 'https://roam.example/catalog.json' });
    const models = await cat.list('roam', 'https://gw.example/v1');
    const flash = models.find((m) => m.id === 'deepseek-v4-flash')!;
    expect(flash.name).toBe('DeepSeek V4 Flash');
    expect(flash.source).toBe('catalog');
    expect(flash.recommendedFor).toEqual(['senior-dev']);
    // The endpoint contributed a model the catalog didn't list.
    expect(models.map((m) => m.id)).toContain('new-model-x');
  });

  it('falls back to static models when the endpoint and catalog fail', async () => {
    const { fetchFn } = routeFetch([]); // every fetch 404s
    const cat = new ModelCatalog(
      staticFor({ roam: [{ id: 'deepseek-v4-flash', name: 'Flash', source: 'static' }] }),
      fetchFn,
      { catalogUrl: 'https://roam.example/catalog.json' }
    );
    const models = await cat.list('roam', 'https://gw.example/v1');
    expect(models).toEqual([{ id: 'deepseek-v4-flash', name: 'Flash', source: 'static' }]);
  });

  it('surfaces an actionable configuration error for a 200 HTML model-list response', async () => {
    const fetchFn: CatalogFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => '<!doctype html><title>gateway login</title>',
    });
    const cat = new ModelCatalog(staticFor({}), fetchFn);

    await expect(cat.list('custom:gateway', 'https://gateway.example/v1')).rejects.toThrow(
      'The gateway at https://gateway.example/v1 returned HTML, not JSON',
    );
  });

  it('backfills a static name onto an endpoint-discovered id', async () => {
    const { fetchFn } = routeFetch([{ match: '/v1/models', body: { data: [{ id: 'gpt-4o' }] } }]);
    const cat = new ModelCatalog(staticFor({ openai: [{ id: 'gpt-4o', name: 'GPT-4o', vision: true, source: 'static' }] }), fetchFn);
    const models = await cat.list('openai', 'https://api.openai.com/v1');
    expect(models[0]).toMatchObject({ id: 'gpt-4o', name: 'GPT-4o', vision: true, source: 'endpoint' });
  });

  it('works with no baseUrl (static only)', async () => {
    const { fetchFn, calls } = routeFetch([]);
    const cat = new ModelCatalog(staticFor({ anthropic: [{ id: 'claude-sonnet-4', source: 'static' }] }), fetchFn);
    const models = await cat.list('anthropic');
    expect(models.map((m) => m.id)).toEqual(['claude-sonnet-4']);
    expect(calls).toEqual([]); // no catalog url, no baseUrl -> no network
  });

  // unode.extraModels: the only source that works for a connection with nothing to query — Claude
// Headless runs a CLI with no model-list command — so it must not need a release or a reachable host.
  it('offers user-configured models for a connection with no endpoint, ahead of the static list', async () => {
    const { fetchFn, calls } = routeFetch([]);
    const cat = new ModelCatalog(staticFor({ 'claude-cli': [{ id: 'opus', source: 'static' }] }), fetchFn, {
      userModels: (pk) => (pk === 'claude-cli' ? ([{ id: 'claude-opus-5', name: 'Opus 5' }] as ModelInfo[]) : []),
    });
    const models = await cat.list('claude-cli');
    expect(models.map((m) => m.id)).toEqual(['claude-opus-5', 'opus']);
    expect(models[0].source).toBe('user');
    expect(calls).toEqual([]); // naming a new model must not require reaching anything
  });

  it('accepts a bare id string and keeps the user name over a later source that renames the same id', async () => {
    const { fetchFn } = routeFetch([{ match: '/models', body: { data: [{ id: 'gpt-4o' }] } }]);
    const cat = new ModelCatalog(staticFor({ openai: [{ id: 'gpt-4o', name: 'Static name', source: 'static' }] }), fetchFn, {
      userModels: () => (['gpt-4o', { id: 'o3-pro', name: 'o3 pro' }] as unknown) as ModelInfo[],
    });
    const models = await cat.list('openai', 'https://api.openai.com/v1');
    expect(models.map((m) => m.id)).toEqual(['gpt-4o', 'o3-pro']);
    // A bare string carries no name, so a later source may still back-fill one...
    expect(models[0].name).toBe('Static name');
    // ...but the id and its user origin are the user's.
    expect(models[0].source).toBe('user');
  });

  it('drops malformed user entries and survives a throwing reader rather than emptying the picker', async () => {
    const { fetchFn } = routeFetch([]);
    const cat = new ModelCatalog(staticFor({ 'claude-cli': [{ id: 'opus', source: 'static' }] }), fetchFn, {
      userModels: () => ([{ id: 42 }, null, '', '  ', { name: 'no id' }, 'claude-opus-5', 'claude-opus-5'] as unknown) as ModelInfo[],
    });
    const models = await cat.list('claude-cli');
    expect(models.map((m) => m.id)).toEqual(['claude-opus-5', 'opus']); // junk dropped, duplicate collapsed

    const thrower = new ModelCatalog(staticFor({ 'claude-cli': [{ id: 'opus', source: 'static' }] }), fetchFn, {
      userModels: () => { throw new Error('settings.json is mid-edit'); },
    });
    expect((await thrower.list('claude-cli')).map((m) => m.id)).toEqual(['opus']);
  });

  it('caches results per (provider, baseUrl) within the TTL', async () => {
    const fetchSpy = vi.fn<Parameters<CatalogFetch>, ReturnType<CatalogFetch>>(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'm1' }] }),
    }));
    const cat = new ModelCatalog(staticFor({}), fetchSpy, { ttlMs: 10_000 });
    await cat.list('roam', 'https://gw.example/v1');
    await cat.list('roam', 'https://gw.example/v1');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('does not let a cache hit stand in for current metadata permission', async () => {
    let allowed = true;
    const fetchSpy = vi.fn<Parameters<CatalogFetch>, ReturnType<CatalogFetch>>(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'remote-only' }] }),
    }));
    const cat = new ModelCatalog(
      staticFor({ unode: [{ id: 'built-in', source: 'static' }] }),
      fetchSpy,
      { canReadMetadata: () => allowed },
    );

    expect((await cat.list('unode', 'https://gw.example/v1', 'key')).map((model) => model.id))
      .toEqual(['remote-only', 'built-in']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    allowed = false;
    // The remote result is still in memory, but no current grant means it cannot be reused.
    expect((await cat.list('unode', 'https://gw.example/v1', 'key')).map((model) => model.id))
      .toEqual(['built-in']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight lookup for one connection and never one for another connection', async () => {
    let resolve!: (value: { ok: boolean; status: number; text(): Promise<string> }) => void;
    const delayed = new Promise<{ ok: boolean; status: number; text(): Promise<string> }>((done) => { resolve = done; });
    const fetchSpy = vi.fn<Parameters<CatalogFetch>, ReturnType<CatalogFetch>>(async () => delayed);
    const cat = new ModelCatalog(staticFor({}), fetchSpy);

    const one = cat.list('connection-a', 'https://gw.example/v1', 'key-a');
    const same = cat.list('connection-a', 'https://gw.example/v1', 'key-a');
    const other = cat.list('connection-b', 'https://gw.example/v1', 'key-b');
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    resolve({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'm' }] }) });
    await expect(one).resolves.toHaveLength(1);
    await expect(same).resolves.toHaveLength(1);
    await expect(other).resolves.toHaveLength(1);
  });

  it('does not let an invalidated lookup delete or repopulate the replacement lookup', async () => {
    type Response = { ok: boolean; status: number; text(): Promise<string> };
    let resolveFirst!: (value: Response) => void;
    let resolveSecond!: (value: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const secondResponse = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    const fetchSpy = vi.fn<Parameters<CatalogFetch>, ReturnType<CatalogFetch>>()
      .mockImplementationOnce(async () => firstResponse)
      .mockImplementationOnce(async () => secondResponse);
    let configuredId = 'old-local';
    const cat = new ModelCatalog(staticFor({}), fetchSpy, {
      userModels: () => [{ id: configuredId, source: 'user' }],
    });

    const oldLookup = cat.list('unode', 'https://gw.example/v1', 'key');
    await Promise.resolve();
    configuredId = 'new-local';
    cat.clearCache();
    const replacement = cat.list('unode', 'https://gw.example/v1', 'key');
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    resolveFirst({ ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) });
    await expect(oldLookup).resolves.toEqual([{ id: 'old-local', source: 'user' }]);
    resolveSecond({ ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) });
    await expect(replacement).resolves.toEqual([{ id: 'new-local', source: 'user' }]);

    await expect(cat.list('unode', 'https://gw.example/v1', 'key'))
      .resolves.toEqual([{ id: 'new-local', source: 'user' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
