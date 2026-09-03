import { describe, it, expect, vi } from 'vitest';
import { LivePriceService, EgressNotConsentedError, consentGatedFetch, consentedSources, scopedSources, convertRows, resolveGroupRatio, resolveVendorDiscounts, PriceFetch } from '../LivePriceService';
import { ModelCatalog } from '../ModelCatalog';
import { ModelPricing } from '../ModelPricing';

// The gate lives on the FETCH, not on the callers. The first version of this fix guarded the price call
// site, and review immediately found ModelCatalog fetching {base}/models and a configurable catalog URL
// straight past it — the same bug, one service over. "Every caller remembers to check" is not a property you
// can hold, so no caller is asked to. (Codex, v0.9.29 review.)
describe('consentGatedFetch — no metadata service can reach an unapproved host', () => {
  const approved = (...hosts: string[]) => (h: string): boolean => hosts.includes(h);
  const okJson = (body: unknown) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

  it('refuses before a packet moves — the inner fetch is never called', async () => {
    const inner = vi.fn(okJson({}));
    const gated = consentGatedFetch(inner as any, approved()); // nothing approved
    await expect(gated('https://api.openai.com/v1/models')).rejects.toBeInstanceOf(EgressNotConsentedError);
    expect(inner).not.toHaveBeenCalled();
  });

  it('lets an approved host through, unchanged', async () => {
    const inner = vi.fn(okJson({ data: [{ id: 'gpt-4o' }] }));
    const gated = consentGatedFetch(inner as any, approved('api.openai.com'));
    await expect(gated('https://api.openai.com/v1/models')).resolves.toMatchObject({ ok: true });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('fails CLOSED on an unparseable URL, even when consent says yes to everything', async () => {
    const inner = vi.fn(okJson({}));
    const gated = consentGatedFetch(inner as any, () => true);
    await expect(gated('not a url')).rejects.toBeInstanceOf(EgressNotConsentedError);
    expect(inner).not.toHaveBeenCalled();
  });

  // THE regression Codex asked for: a user who declines gets ZERO requests — not "one that fails", zero.
  // ModelCatalog is the service that slipped past the first fix, so it is the one driven here, end to end.
  it('a DECLINED model picker makes zero network calls and still shows the static model list', async () => {
    const inner = vi.fn(okJson({ data: [{ id: 'leaked-from-the-network' }] }));
    const catalog = new ModelCatalog(
      () => [{ id: 'built-in-model', name: 'Built-in', source: 'static' as const }],
      consentGatedFetch(inner as any, approved()),         // the user declined: nothing is approved
      { catalogUrl: 'https://catalog.example/models.json' } // ...and a catalog URL is configured
    );

    const models = await catalog.list('openai', 'https://api.openai.com/v1', 'sk-a-real-key');

    expect(inner).toHaveBeenCalledTimes(0);                 // not the endpoint, not the catalog. ZERO.
    expect(models.map((m) => m.id)).toEqual(['built-in-model']); // and the picker still works
  });

  it('an APPROVED model picker fetches both sources and merges them', async () => {
    const inner = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(
        url.includes('catalog.example')
          ? { providers: { openai: { models: [{ id: 'curated-model' }] } } }
          : { data: [{ id: 'live-model' }] }
      ),
    }));
    const catalog = new ModelCatalog(
      () => [{ id: 'built-in-model', source: 'static' as const }],
      consentGatedFetch(inner as any, approved('api.openai.com', 'catalog.example')),
      { catalogUrl: 'https://catalog.example/models.json' }
    );

    const ids = (await catalog.list('openai', 'https://api.openai.com/v1', 'sk-key')).map((m) => m.id);

    expect(inner).toHaveBeenCalledTimes(2);
    expect(ids).toEqual(expect.arrayContaining(['curated-model', 'live-model', 'built-in-model']));
  });
});

// Consent limits which hosts may EVER be contacted; scope limits which of those THIS ACTION contacts. Both
// axes are needed: after the prompt was correctly narrowed to the selected provider, the fetch still walked
// every configured gateway — so a user who had approved Roam and Unode LAST WEEK opened the OpenAI picker
// and, with no modal at all (everything was already consented), still sent both gateways a price request.
// No consent was violated, which is exactly the point: "this action touches only its planned hosts" is an
// invariant about the ACTION, not about the grant. (Codex, v0.9.29 review.)
describe('scopedSources — the action reaches only its own provider, however much standing consent exists', () => {
  const CONFIGURED = [
    { providerId: 'roam', url: 'https://api.weroam.xyz/v1' },
    { providerId: 'unode', url: 'https://api.unodetech.xyz/v1' },
    { url: 'https://my-gateway.example/api/pricing' }, // user-added pricingSources entry: no providerId
  ];

  // THE regression Codex asked for, driven through the same pipeline refreshPrices uses:
  // scope → consent → gated fetch. Roam and Unode are PRE-APPROVED, and still receive zero requests.
  it('an OpenAI picker with Roam+Unode pre-approved fetches NOTHING from them — zero, not "allowed but skipped"', async () => {
    const inner = vi.fn(async () => ({ ok: true, status: 200, text: async () => '[]' }));
    const approvedEverything = (h: string) => ['api.weroam.xyz', 'api.unodetech.xyz'].includes(h);
    const service = new LivePriceService(consentGatedFetch(inner as any, approvedEverything));

    const scoped = scopedSources(CONFIGURED, 'openai');           // the OpenAI picker's actual reach
    const { allowed } = consentedSources(scoped, approvedEverything);
    for (const s of allowed) { await service.fetchGatewayPrices(s.url); }

    expect(scoped).toEqual([]);            // OpenAI has no price source of ours...
    expect(inner).toHaveBeenCalledTimes(0); // ...so the approved gateways are not contacted by THIS action
  });

  it('a Roam picker fetches Roam and only Roam', async () => {
    const calls: string[] = [];
    const inner = vi.fn(async (url: string) => { calls.push(url); return { ok: true, status: 200, text: async () => '[]' }; });
    const service = new LivePriceService(consentGatedFetch(inner as any, () => true));

    const { allowed } = consentedSources(scopedSources(CONFIGURED, 'roam'), () => true);
    for (const s of allowed) { await service.fetchGatewayPrices(s.url); }

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('api.weroam.xyz');
    expect(calls.some((u) => u.includes('unodetech'))).toBe(false);
  });

  it('an UNSCOPED refresh (activation, timer, the explicit command) keeps every source, including user-added ones', () => {
    expect(scopedSources(CONFIGURED, undefined)).toHaveLength(3);
  });

  it('user-added pricingSources entries are reachable ONLY by an unscoped refresh', () => {
    // They carry no providerId, so no provider-scoped action can ever pull them in.
    for (const scope of ['roam', 'unode', 'openai', 'anthropic']) {
      expect(scopedSources(CONFIGURED, scope).some((s) => !s.providerId)).toBe(false);
    }
  });

  it('scope composes with consent — a scoped source still needs its host approved', async () => {
    const inner = vi.fn(async () => ({ ok: true, status: 200, text: async () => '[]' }));
    const nothingApproved = () => false;
    const service = new LivePriceService(consentGatedFetch(inner as any, nothingApproved));

    const { allowed, skipped } = consentedSources(scopedSources(CONFIGURED, 'roam'), nothingApproved);
    for (const s of allowed) { await service.fetchGatewayPrices(s.url); }

    expect(allowed).toEqual([]);
    expect(skipped).toHaveLength(1); // in scope, but not consented — still not fetched
    expect(inner).toHaveBeenCalledTimes(0);
  });
});

// The rule that turns an install into a phone-home if it is missing. v0.9.29 called refreshPrices()
// unconditionally from activate(): a fresh install with no key, no provider and no approved host still
// beaconed two vendor gateways at startup — contradicting the extension's own published promise, and
// matching what registries classify as unwanted software. (Codex, v0.9.29 Marketplace review.)
describe('consentedSources — a convenience fetch rides on an approved host, it never opens one', () => {
  const approved = (...hosts: string[]) => (h: string): boolean => hosts.includes(h);

  // THE case. This is the one that got a previous release delisted; it is named so it can never be
  // quietly deleted as "redundant".
  it('a FRESH INSTALL (nothing approved) fetches NOTHING — zero network on activation', () => {
    const configured = [
      { providerId: 'roam', url: 'https://api.weroam.xyz/v1' },
      { providerId: 'unode', url: 'https://api.unodetech.xyz/v1' },
      { url: 'https://some-gateway.example/api/pricing' },
    ];
    const { allowed, skipped } = consentedSources(configured, approved()); // consented set is EMPTY
    expect(allowed).toEqual([]);
    expect(skipped).toHaveLength(3);
  });

  it('fetches only from hosts the user already approved, and leaves the rest alone', () => {
    const configured = [
      { providerId: 'roam', url: 'https://api.weroam.xyz/v1' },
      { providerId: 'unode', url: 'https://api.unodetech.xyz/v1' },
    ];
    const { allowed, skipped } = consentedSources(configured, approved('api.unodetech.xyz'));
    expect(allowed.map((s) => s.providerId)).toEqual(['unode']);
    expect(skipped.map((s) => s.providerId)).toEqual(['roam']);
  });

  it('consent is per HOST, not per URL — a path or port change does not re-open the question', () => {
    const { allowed } = consentedSources(
      [{ url: 'https://api.unodetech.xyz/v1/some/other/path' }],
      approved('api.unodetech.xyz')
    );
    expect(allowed).toHaveLength(1);
    // ...but a DIFFERENT host is a different question, even on the same registrable domain.
    expect(consentedSources([{ url: 'https://evil.unodetech.xyz/v1' }], approved('api.unodetech.xyz')).allowed).toEqual([]);
  });

  it('fails CLOSED on a URL it cannot parse (no host → never consented → never fetched)', () => {
    const { allowed, skipped } = consentedSources(
      [{ url: 'not a url' }, { url: '' }],
      () => true // even with a hasConsent that says yes to everything
    );
    expect(allowed).toEqual([]);
    expect(skipped).toHaveLength(2);
  });
});

describe('convertRows (new-api ratios -> USD/1M)', () => {
  it('applies the verified formula (gpt-4o = OpenAI list price)', () => {
    const out = convertRows([{ model_name: 'gpt-4o', model_ratio: 1.25, completion_ratio: 4, quota_type: 0 }]);
    expect(out['gpt-4o']).toEqual({ input: 2.5, output: 10 });
  });

  it('converts deepseek and claude-opus to the gateway price', () => {
    const out = convertRows([
      { model_name: 'deepseek-v4-flash', model_ratio: 0.07, completion_ratio: 2, quota_type: 0 },
      { model_name: 'claude-opus-4-8', model_ratio: 2.5, completion_ratio: 5, quota_type: 0 },
    ]);
    expect(out['deepseek-v4-flash']).toEqual({ input: 0.14, output: 0.28 });
    expect(out['claude-opus-4-8']).toEqual({ input: 5, output: 25 });
  });

  it('skips per-call media pricing (quota_type 1) and zero-ratio rows', () => {
    const out = convertRows([
      { model_name: 'veo-3.0', model_ratio: 0, completion_ratio: 0, quota_type: 1 },
      { model_name: 'embed', model_ratio: 0, completion_ratio: 1, quota_type: 0 },
      { model_name: 'good', model_ratio: 0.5, completion_ratio: 2, quota_type: 0 },
    ]);
    expect(Object.keys(out)).toEqual(['good']);
  });

  it('applies a group discount ratio to both input and output', () => {
    const out = convertRows([{ model_name: 'gpt-4o', model_ratio: 1.25, completion_ratio: 4, quota_type: 0 }], 0.5);
    expect(out['gpt-4o']).toEqual({ input: 1.25, output: 5 }); // half of list (2.5 / 10)
  });

  it('applies vendor discounts from the pricing endpoint', () => {
    const out = convertRows(
      [{ model_name: 'claude-opus-4-8', vendor_id: 3, model_ratio: 2.5, completion_ratio: 5, quota_type: 0 }],
      1,
      { 3: 0.6 }
    );
    expect(out['claude-opus-4-8']).toEqual({ input: 3, output: 15 });
  });

  it('treats a MISSING quota_type as token-priced (gateways that omit the field)', () => {
    // Regression: the old `quota_type !== 0` guard dropped every row without the field, blanking the table.
    const out = convertRows([{ model_name: 'qwen-max', model_ratio: 0.8, completion_ratio: 4 }]);
    expect(out['qwen-max']).toEqual({ input: 1.6, output: 6.4 });
  });

  it('coerces string-encoded ratios', () => {
    const out = convertRows([{ model_name: 'gpt-4o', model_ratio: '1.25', completion_ratio: '4', quota_type: 0 }]);
    expect(out['gpt-4o']).toEqual({ input: 2.5, output: 10 });
  });

  it('accepts `model` as a fallback name key', () => {
    const out = convertRows([{ model: 'glm-5', model_ratio: 0.5, completion_ratio: 2, quota_type: 0 }]);
    expect(out['glm-5']).toEqual({ input: 1, output: 2 });
  });
});

/**
 * A stated coefficient and a gateway group ratio are two answers to the same question.
 *
 * Codex review, 2026-08-21: both were applied. The prompt asks what fraction of the PUBLISHED price a key
 * pays, and a group ratio has already turned published into charged — so 0.33 stated against a gateway
 * reporting 0.33 displayed 0.1089 of list, under-reporting cost by nine times. The tests covered each
 * separately and neither in combination, which is where the defect lived.
 */
describe('exactly one discount is applied', () => {
  const body = {
    data: [{ model_name: 'grok-4.5', model_ratio: 1, completion_ratio: 1, quota_type: 0 }],
    group_ratio: { default: 1, vip: 0.33 },
    usable_group: { vip: 'VIP' },
  };
  const fetchOnce: PriceFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  const service = () => new LivePriceService(fetchOnce);

  // model_ratio 1 x completion_ratio 1 x USD_PER_RATIO_UNIT 2 = $2 list.
  it('uses the gateway ratio when the user has stated nothing', async () => {
    const { prices, resolution } = await service().fetchGatewayPricesDetailed('https://gw.example/v1', 'k');
    expect(resolution.basis).toBe('only-usable-group');
    expect(prices['grok-4.5'].output).toBeCloseTo(2 * 0.33);
  });

  it('uses the stated coefficient INSTEAD of the gateway ratio, never on top of it', async () => {
    const { prices, resolution } = await service().fetchGatewayPricesDetailed('https://gw.example/v1', 'k', undefined, 0.33);
    expect(resolution.basis).toBe('user-coefficient');
    // 2 x 0.33 = 0.66. Multiplying both would give 0.2178 — nine times cheaper than the truth.
    expect(prices['grok-4.5'].output).toBeCloseTo(2 * 0.33);
    expect(prices['grok-4.5'].output).not.toBeCloseTo(2 * 0.33 * 0.33);
  });

  // A stated 1 means "this key pays list price" and must suppress a discount the gateway would apply.
  it('lets a stated 1 override a gateway that would have discounted', async () => {
    const { prices, resolution } = await service().fetchGatewayPricesDetailed('https://gw.example/v1', 'k', undefined, 1);
    expect(resolution.basis).toBe('user-coefficient');
    expect(prices['grok-4.5'].output).toBeCloseTo(2);
  });

  it('lets a stated 0 report a free key as free', async () => {
    const { prices } = await service().fetchGatewayPricesDetailed('https://gw.example/v1', 'k', undefined, 0);
    expect(prices['grok-4.5'].output).toBe(0);
  });
});

describe('resolveGroupRatio (new-api discount selection)', () => {
  it('returns 1 when only the default group exists (list price)', () => {
    expect(resolveGroupRatio({ group_ratio: { default: 1 }, usable_group: { default: 'x' } })).toBe(1);
  });
  it('auto-applies the single usable group when it differs from default', () => {
    expect(resolveGroupRatio({ group_ratio: { default: 1, vip: 0.7 }, usable_group: { vip: 'VIP' } })).toBe(0.7);
  });
  it('honors an explicit preferredGroup over auto-detection', () => {
    const body = { group_ratio: { default: 1, vip: 0.7, svip: 0.5 }, usable_group: { vip: 'a', svip: 'b' } };
    expect(resolveGroupRatio(body, 'svip')).toBe(0.5);
  });
  /**
   * When several groups are usable, this function is guessing — new-api does not say which one bills, and
   * the endpoint that would (`/api/user/self`) needs a login session rather than an API key.
   *
   * It used to guess the cheapest. Field report, 2026-08-21: a model listed at $5.10/1M displayed as
   * $1.6983 and the user was billed $5.10. Guessing downward is not optimism; it is a cost display wrong in
   * the one direction that costs money without warning. So the guess now takes the ratio it cannot be
   * under, and a real discount stays invisible until the user pins their group.
   */
  it('with several usable groups, takes the price it cannot be under rather than the cheapest', () => {
    // `default` among the usable groups is evidence the account may sit there.
    expect(resolveGroupRatio({ group_ratio: { default: 1, vip: 0.8 }, usable_group: { default: '', vip: '' } })).toBe(1);
    // No `default` offered: the least discounted of what is on the table.
    expect(resolveGroupRatio({ group_ratio: { default: 1, a: 0.8, b: 0.9 }, usable_group: { a: '', b: '' } })).toBe(0.9);
  });

  // One usable group is not a guess: there is nothing to choose between.
  it('still applies a single usable group outright', () => {
    expect(resolveGroupRatio({ group_ratio: { default: 1, vip: 0.7 }, usable_group: { vip: 'VIP' } })).toBe(0.7);
  });

  // A stated fact beats any inference, including this one.
  it('lets an explicit group pin reach a discount the guess refuses to assume', () => {
    const body = { group_ratio: { default: 1, vip: 0.8, svip: 0.5 }, usable_group: { default: '', vip: '', svip: '' } };
    expect(resolveGroupRatio(body)).toBe(1);
    expect(resolveGroupRatio(body, 'svip')).toBe(0.5);
  });

  it('falls back to default (or 1) when no usable group is given', () => {
    expect(resolveGroupRatio({ group_ratio: { default: 0.9 } })).toBe(0.9);
    expect(resolveGroupRatio({})).toBe(1);
  });
});

describe('resolveVendorDiscounts (new-api vendor discount selection)', () => {
  it('turns percentage discounts into price multipliers', () => {
    expect(resolveVendorDiscounts({ vendors: [{ id: 3, discount: 40 }, { id: 1, discount: 10 }] })).toEqual({
      3: 0.6,
      1: 0.9,
    });
  });
});

describe('LivePriceService.fetchGatewayPrices', () => {
  function fakeFetch(body: unknown, ok = true): { fetchFn: PriceFetch; urls: string[] } {
    const urls: string[] = [];
    const fetchFn: PriceFetch = async (url) => {
      urls.push(url);
      return { ok, status: ok ? 200 : 500, text: async () => JSON.stringify(body) };
    };
    return { fetchFn, urls };
  }

  it('derives /api/pricing from a gateway base URL and parses an array body', async () => {
    const { fetchFn, urls } = fakeFetch([{ model_name: 'qwen-max', model_ratio: 0.8, completion_ratio: 4, quota_type: 0 }]);
    const svc = new LivePriceService(fetchFn);
    const prices = await svc.fetchGatewayPrices('https://computevault.unodetech.xyz/v1');
    expect(urls[0]).toBe('https://computevault.unodetech.xyz/api/pricing');
    expect(prices['qwen-max']).toEqual({ input: 1.6, output: 6.4 });
  });

  it('also accepts a {data:[…]} envelope and a full /api/pricing url', async () => {
    const { fetchFn, urls } = fakeFetch({ data: [{ model_name: 'gpt-5', model_ratio: 0.625, completion_ratio: 8, quota_type: 0 }] });
    const svc = new LivePriceService(fetchFn);
    const prices = await svc.fetchGatewayPrices('https://gw.example/api/pricing');
    expect(urls[0]).toBe('https://gw.example/api/pricing');
    expect(prices['gpt-5']).toEqual({ input: 1.25, output: 10 });
  });

  it('accepts an alternative envelope key (e.g. {models:[…]})', async () => {
    const { fetchFn } = fakeFetch({ models: [{ model_name: 'kimi-k2', model_ratio: 0.25, completion_ratio: 4, quota_type: 0 }] });
    const svc = new LivePriceService(fetchFn);
    const prices = await svc.fetchGatewayPrices('https://gw.example/api/pricing');
    expect(prices['kimi-k2']).toEqual({ input: 0.5, output: 2 }); // 0.25*2 ; 0.25*4*2
  });

  it('combines group ratio and vendor discount from the envelope', async () => {
    const { fetchFn } = fakeFetch({
      data: [{ model_name: 'claude-opus-4-8', vendor_id: 3, model_ratio: 2.5, completion_ratio: 5, quota_type: 0 }],
      group_ratio: { default: 1 },
      usable_group: { default: 'default' },
      vendors: [{ id: 3, discount: 40 }],
    });
    const svc = new LivePriceService(fetchFn);
    const prices = await svc.fetchGatewayPrices('https://gw.example/api/pricing');
    expect(prices['claude-opus-4-8']).toEqual({ input: 3, output: 15 });
  });

  it('throws on HTTP failure so the caller can fall back to the static table', async () => {
    const { fetchFn } = fakeFetch([], false);
    const svc = new LivePriceService(fetchFn);
    await expect(svc.fetchGatewayPrices('https://gw.example/v1')).rejects.toThrow(/HTTP 500/);
  });

  it('does not treat a completed cache entry as current egress permission', async () => {
    let allowed = true;
    const { fetchFn, urls } = fakeFetch([{ model_name: 'm', model_ratio: 1, quota_type: 0 }]);
    const svc = new LivePriceService(fetchFn, { canReadMetadata: () => allowed });

    await svc.fetchGatewayPricesDetailed('https://gw.example/v1', 'key', undefined, undefined, { scope: 'connection-a' });
    expect(urls).toHaveLength(1);
    allowed = false;
    await expect(
      svc.fetchGatewayPricesDetailed('https://gw.example/v1', 'key', undefined, undefined, { scope: 'connection-a' }),
    ).rejects.toBeInstanceOf(EgressNotConsentedError);
    expect(urls).toHaveLength(1);
  });

  it('deduplicates one connection while concurrent connections get separate reads', async () => {
    let resolve!: (value: { ok: boolean; status: number; text(): Promise<string> }) => void;
    const delayed = new Promise<{ ok: boolean; status: number; text(): Promise<string> }>((done) => { resolve = done; });
    const fetchSpy = vi.fn<Parameters<PriceFetch>, ReturnType<PriceFetch>>(async () => delayed);
    const svc = new LivePriceService(fetchSpy);

    const a1 = svc.fetchGatewayPricesDetailed('https://gw.example/v1', 'key-a', undefined, undefined, { scope: 'connection-a' });
    const a2 = svc.fetchGatewayPricesDetailed('https://gw.example/v1', 'key-a', undefined, undefined, { scope: 'connection-a' });
    const b = svc.fetchGatewayPricesDetailed('https://gw.example/v1', 'key-b', undefined, undefined, { scope: 'connection-b' });
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    resolve({ ok: true, status: 200, text: async () => JSON.stringify([{ model_name: 'm', model_ratio: 1, quota_type: 0 }]) });
    await expect(a1).resolves.toMatchObject({ prices: { m: { input: 2, output: 2 } } });
    await expect(a2).resolves.toMatchObject({ prices: { m: { input: 2, output: 2 } } });
    await expect(b).resolves.toMatchObject({ prices: { m: { input: 2, output: 2 } } });
  });
});

describe('ModelPricing.merge', () => {
  it('overlays live prices over the defaults without mutating the shared constant', () => {
    const pricing = new ModelPricing({ 'deepseek-v4-flash': { input: 0.14, output: 0.28 } });
    pricing.merge({ 'deepseek-v4-flash': { input: 0.2, output: 0.4 }, 'new-model': { input: 1, output: 2 } });
    expect(pricing.priceFor('deepseek-v4-flash')).toEqual({ input: 0.2, output: 0.4 });
    expect(pricing.priceFor('new-model')).toEqual({ input: 1, output: 2 });
  });

  it('scopes live gateway prices by provider id', () => {
    const pricing = new ModelPricing({ 'grok-4.5': { input: 1, output: 3.4 } });
    pricing.merge({ 'grok-4.5': { input: 1, output: 3.4 } }, 'roam');
    pricing.merge({ 'grok-4.5': { input: 1.5, output: 5.1 } }, 'unode');
    expect(pricing.priceFor('grok-4.5', 'roam')).toEqual({ input: 1, output: 3.4 });
    expect(pricing.priceFor('grok-4.5', 'unode')).toEqual({ input: 1.5, output: 5.1 });
  });
});
