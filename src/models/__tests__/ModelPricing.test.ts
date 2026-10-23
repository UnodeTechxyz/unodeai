import { describe, it, expect } from 'vitest';
import { intentionallyUnknownPriceLabel, ModelPricing } from '../ModelPricing';

describe('ModelPricing', () => {
  const pricing = new ModelPricing({ 'deepseek-v4-flash': { input: 0.14, output: 0.28 } });

  it('estimates cost from input/output tokens at the table rate', () => {
    const cost = pricing.estimate('deepseek-v4-flash', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.42, 6);
  });

  // v0.9.89: no undated built-in table. A price with no live or user source comes from the dated reference,
  // by exact id only, labelled with its catalog and date.
  it('has no silent built-in price and shows a dated reference only for an exact id', () => {
    const empty = new ModelPricing();
    expect(empty.priceFor('claude-opus-5')).toBeUndefined();
    empty.setReference({ 'claude-opus-5': { input: 3, output: 15 } }, 'Unode reference 2026-09-27');
    expect(empty.priceInfoFor('claude-opus-5')).toEqual({ price: { input: 3, output: 15 }, source: 'reference', sourceLabel: 'Unode reference 2026-09-27' });
    expect(empty.priceInfoFor('CLAUDE-OPUS-5')?.source).toBe('reference');
    expect(empty.priceFor('claude-opus-5-5')).toBeUndefined();
    expect(empty.priceFor('opus')).toBeUndefined();
  });

  it('returns undefined for an unknown model (caller treats cost as 0)', () => {
    expect(pricing.estimate('some-unlisted-model', 1000, 1000)).toBeUndefined();
    expect(pricing.priceFor('some-unlisted-model')).toBeUndefined();
  });

  it('honors a custom/override price table', () => {
    const custom = new ModelPricing({ 'my-model': { input: 1, output: 2 } });
    expect(custom.estimate('my-model', 2_000_000, 1_000_000)).toBeCloseTo(2 * 1 + 1 * 2, 6);
  });

  // The substring fallback must not cross a version number: grok-4.5 is gateway-divergent and has no global
  // default, so it must return blank — NOT grok-4's price (grok-4 is a substring of grok-4.5).
  it('does not borrow an older version\'s price across a version boundary', () => {
    const p = new ModelPricing({ 'grok-4': { input: 1.25, output: 2.5 } });
    expect(p.priceFor('grok-4')).toEqual({ input: 1.25, output: 2.5 });   // exact
    expect(p.priceFor('grok-4.5')).toBeUndefined();                        // version bump → blank, not 2.5
    expect(p.priceFor('grok-4-fast')).toEqual({ input: 1.25, output: 2.5 }); // real variant (- boundary)
  });

  it('labels the selected OpenAI 5.6 tier defaults as unknown instead of borrowing gpt-5 pricing', () => {
    for (const modelId of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(pricing.priceFor(modelId)).toBeUndefined();
      expect(pricing.estimate(modelId, 1_000_000, 1_000_000)).toBeUndefined();
      expect(intentionallyUnknownPriceLabel(modelId)).toBe('price unavailable (no verified rate)');
    }
    expect(intentionallyUnknownPriceLabel('gpt-5')).toBeUndefined();
  });

  it('keeps live prices scoped to the provider that published them', () => {
    const scoped = new ModelPricing({ 'grok-4.5': { input: 1, output: 3.4 } });
    scoped.merge({ 'grok-4.5': { input: 1, output: 3.4 }, 'roam-only-model': { input: 2, output: 4 } }, 'roam');
    scoped.merge({ 'grok-4.5': { input: 1.5, output: 5.1 } }, 'unode');

    expect(scoped.priceFor('grok-4.5', 'roam')).toEqual({ input: 1, output: 3.4 });
    expect(scoped.priceFor('grok-4.5', 'unode')).toEqual({ input: 1.5, output: 5.1 });
    expect(scoped.priceFor('roam-only-model', 'unode')).toBeUndefined();
    expect(scoped.estimate('grok-4.5', 1_000_000, 1_000_000, 'roam')).toBeCloseTo(4.4, 6);
    expect(scoped.estimate('grok-4.5', 1_000_000, 1_000_000, 'unode')).toBeCloseTo(6.6, 6);
  });

  it("reports whether a displayed price is live or the user's own table", () => {
    const p = new ModelPricing({ 'gpt-4o': { input: 2.5, output: 10 } });
    expect(p.priceInfoFor('gpt-4o', 'roam')).toMatchObject({ source: 'list', sourceLabel: 'your price', price: { input: 2.5, output: 10 } });
    p.merge({ 'gpt-4o': { input: 1.7, output: 5.1 } }, 'roam');
    expect(p.priceInfoFor('gpt-4o', 'roam')).toMatchObject({ source: 'live', price: { input: 1.7, output: 5.1 } });
  });

  it('never borrows global list prices for a custom connection', () => {
    const p = new ModelPricing({ 'shared-model': { input: 1, output: 2 } });
    expect(p.priceFor('shared-model', 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeUndefined();
    p.merge({ 'shared-model': { input: 3, output: 4 } }, 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(p.priceFor('shared-model', 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toEqual({ input: 3, output: 4 });
  });
});


describe('cached input is never discounted on a promise we cannot keep', () => {
  // The temptation: a Kilo session on our gateway showed 235.7K fresh input against 3.1M cached (~93% hit
  // rate), and cached tokens are ~10x-100x cheaper UPSTREAM. So discount the bill, right?
  //
  // No. The rate that decides what the user PAYS is the GATEWAY's, not the upstream model's. A stock new-api
  // returns a cache ratio of 1.0 -- FULL PRICE -- for any model absent from a small hardcoded table, and that
  // table contains none of the models we ship on (deepseek-v4-*, glm-*, kimi-*, qwen-*, grok-*). The gateway
  // reports the hit and charges full price for it. Assuming the discount would UNDER-report a real bill, and
  // under-reporting money is worse than over-reporting it.
  const pricing = new ModelPricing();
  pricing.merge({ 'test-model': { input: 10, output: 20 } }, 'roam');

  it('charges cached tokens at FULL price when no cachedInput rate is known', () => {
    const cached = pricing.estimate('test-model', 1_000_000, 0, 'roam', 900_000);
    const allMiss = pricing.estimate('test-model', 1_000_000, 0, 'roam');
    expect(cached).toBeCloseTo(allMiss!, 6);   // the hit rate is reported; the discount is NOT assumed
    expect(cached).toBeCloseTo(10, 6);
  });

  it('applies a discount only where the price table states a measured rate', () => {
    const p = new ModelPricing();
    p.merge({ 'measured': { input: 10, output: 20, cachedInput: 1 } }, 'roam');
    // 1M input, 900K cached: 100K @ $10/M + 900K @ $1/M = $1.00 + $0.90
    expect(p.estimate('measured', 1_000_000, 0, 'roam', 900_000)).toBeCloseTo(0.1 * 10 + 0.9 * 1, 6);
  });

  it('treats cached as a SUBSET of inputTokens, never an addition', () => {
    const p = new ModelPricing();
    p.merge({ 'measured': { input: 10, output: 20, cachedInput: 1 } }, 'roam');
    const all = p.estimate('measured', 1_000_000, 0, 'roam', 1_000_000)!;
    expect(all).toBeCloseTo(1, 6);
    // A gateway over-reporting cached tokens must not yield a negative fresh count / a cheaper-than-cache bill.
    expect(p.estimate('measured', 1_000_000, 0, 'roam', 5_000_000)).toBeCloseTo(all, 6);
  });

  it('undefined means "the gateway told us nothing" — never a free ride', () => {
    expect(pricing.estimate('test-model', 1_000_000, 0, 'roam')).toBeCloseTo(10, 6);
    expect(pricing.estimate('test-model', 1_000_000, 0, 'roam', 0)).toBeCloseTo(10, 6);
  });
});
