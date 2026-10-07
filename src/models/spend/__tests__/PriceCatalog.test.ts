import { describe, expect, it } from 'vitest';
import {
  catalogDigest,
  catalogFromNewApiPricing,
  catalogIsStale,
  credentialBoundGroupFromPricing,
  groupRatiosFromNewApiPricing,
  lookupCatalogModel,
  PriceCatalogV1,
  ratesFromNewApiPricing,
  REFERENCE_STALE_AFTER_MS,
  validatePriceCatalog,
} from '../PriceCatalog';

const body = {
  success: true,
  group_ratio: { default: 1, eco: 0.333, vip: 1.5 },
  usable_group: { default: 'Default', eco: 'ECO', vip: 'VIP' },
  vendors: [{ id: 3, name: 'Anthropic', discount: 40 }, { id: 6, name: 'DeepSeek', discount: 50 }],
  data: [
    { model_name: 'claude-opus-5', vendor_id: 3, quota_type: 0, model_ratio: 2.5, completion_ratio: 5, cache_ratio: 0.1 },
    { model_name: 'deepseek-v4-pro', vendor_id: 6, quota_type: 0, model_ratio: 0.6617, completion_ratio: 3, cache_ratio: 0.0333, effective_discount: 50 },
    { model_name: 'image-model', vendor_id: 3, quota_type: 1, model_ratio: 0, model_price: 0.03 },
    { model_name: 'zero', vendor_id: 3, quota_type: 0, model_ratio: 0 },
  ],
};

function catalog(): PriceCatalogV1 {
  return catalogFromNewApiPricing(body, {
    provider: 'unode',
    capturedAt: '2026-09-27T00:00:00.000Z',
    sourceUrl: 'https://www.unodetech.xyz/api/pricing',
    aliases: { 'opus-latest-dated': 'claude-opus-5', 'missing-alias': 'nope' },
  });
}

describe('new-api conversion', () => {
  it('uses exact decimal arithmetic for ratio x 2 x published discount', () => {
    const rows = ratesFromNewApiPricing(body);
    const opus = rows.find((row) => row.modelId === 'claude-opus-5')!;
    // 2.5 x 2 x 0.6 = $3/M input; output x5 = $15/M; cached x0.1 = $0.30/M.
    expect(opus.inputNanoUsdPerMillion).toBe('3000000000');
    expect(opus.outputNanoUsdPerMillion).toBe('15000000000');
    expect(opus.cachedInputNanoUsdPerMillion).toBe('300000000');
    const deepseek = rows.find((row) => row.modelId === 'deepseek-v4-pro')!;
    expect(deepseek.inputNanoUsdPerMillion).toBe('661700000');
  });

  it('skips per-call and zero-ratio rows', () => {
    const ids = ratesFromNewApiPricing(body).map((row) => row.modelId);
    expect(ids).not.toContain('image-model');
    expect(ids).not.toContain('zero');
  });

  it('never applies a non-default group to the anonymous list price', () => {
    const cheaper = ratesFromNewApiPricing({ ...body, group_ratio: { default: 1, eco: 0.333 } });
    expect(cheaper.find((row) => row.modelId === 'claude-opus-5')!.inputNanoUsdPerMillion).toBe('3000000000');
    const base = ratesFromNewApiPricing({ ...body, group_ratio: { default: 2 } }, { applyDefaultGroup: false });
    expect(base.find((row) => row.modelId === 'claude-opus-5')!.inputNanoUsdPerMillion).toBe('3000000000');
  });

  it('keeps group ratios exact and recognizes only an explicit credential-scoped binding', () => {
    expect(groupRatiosFromNewApiPricing(body)).toEqual({ default: '1', eco: '0.333', vip: '1.5' });
    expect(credentialBoundGroupFromPricing(body)).toBeUndefined();
    expect(credentialBoundGroupFromPricing({ ...body, applied_group: 'eco' })).toBeUndefined();
    expect(credentialBoundGroupFromPricing({ ...body, applied_group: 'eco', applied_group_scope: 'credential' })).toBe('eco');
  });
});

describe('catalog validation and lookup', () => {
  it('builds a digested catalog that validates, dropping aliases to missing rows', () => {
    const built = catalog();
    expect(built.aliases).toEqual({ 'opus-latest-dated': 'claude-opus-5' });
    expect(validatePriceCatalog(built)).toEqual({ ok: true, catalog: built });
  });

  it('refuses a tampered, unknown-version or duplicated catalog', () => {
    const built = catalog();
    const tampered = { ...built, models: built.models.map((row) => ({ ...row, inputNanoUsdPerMillion: '1' })) };
    expect(validatePriceCatalog(tampered)).toMatchObject({ ok: false, reason: 'digest mismatch' });
    expect(validatePriceCatalog({ ...built, schemaVersion: 2 })).toMatchObject({ ok: false });
    const duplicate = { ...built, models: [...built.models, built.models[0]] };
    expect(validatePriceCatalog({ ...duplicate, contentDigest: catalogDigest(duplicate) })).toMatchObject({ ok: false, reason: 'model id' });
    const cyclic = { ...built, aliases: { 'claude-opus-5': 'deepseek-v4-pro' } };
    expect(validatePriceCatalog({ ...cyclic, contentDigest: catalogDigest(cyclic) })).toMatchObject({ ok: false });
    const insecure = { ...built, sourceUrl: 'http://example.com' };
    expect(validatePriceCatalog({ ...insecure, contentDigest: catalogDigest(insecure) })).toMatchObject({ ok: false, reason: 'source url' });
  });

  it('looks up an exact id, then the same id case-insensitively, then an explicit alias; never a substring', () => {
    const built = catalog();
    expect(lookupCatalogModel(built, 'claude-opus-5')?.modelId).toBe('claude-opus-5');
    expect(lookupCatalogModel(built, 'CLAUDE-OPUS-5')?.modelId).toBe('claude-opus-5');
    expect(lookupCatalogModel(built, 'opus-latest-dated')?.modelId).toBe('claude-opus-5');
    expect(lookupCatalogModel(built, 'claude-opus-5-5')).toBeUndefined();
    expect(lookupCatalogModel(built, 'claude-opus')).toBeUndefined();
    expect(lookupCatalogModel(built, 'latest')).toBeUndefined();
  });

  it('turns stale 30 days after capture', () => {
    const captured = Date.parse('2026-09-27T00:00:00.000Z');
    expect(catalogIsStale(catalog(), captured + REFERENCE_STALE_AFTER_MS - 1)).toBe(false);
    expect(catalogIsStale(catalog(), captured + REFERENCE_STALE_AFTER_MS)).toBe(true);
  });
});
