import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { visit } from 'jsonc-parser';
import { bundledReferenceCatalog } from '../BundledCatalogs';
import {
  catalogDigest,
  catalogFromNewApiPricing,
  catalogIsStale,
  catalogWithAliases,
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

// v0.9.94: a gateway may name a model with a prefix the reference does not use. Such a name is priced only when
// the catalog declares it as an alias; nothing is derived from the spelling of the name.
describe('gateway-prefixed model identity', () => {
  const GATEWAY_ID = 'deepseek/deepseek-v4.1-flash';
  const ROW_ID = 'deepseek-v4.1-flash';
  const providers = ['unode', 'roam'] as const;

  it('prices an exact model id from its own row', () => {
    for (const provider of providers) {
      const bundled = bundledReferenceCatalog(provider)!;
      const row = bundled.models.find((candidate) => candidate.modelId === ROW_ID)!;
      expect(lookupCatalogModel(bundled, ROW_ID), provider).toEqual({
        modelId: ROW_ID,
        rates: {
          input: BigInt(row.inputNanoUsdPerMillion),
          output: BigInt(row.outputNanoUsdPerMillion),
          ...(row.cachedInputNanoUsdPerMillion !== undefined ? { cachedInput: BigInt(row.cachedInputNanoUsdPerMillion) } : {}),
        },
      });
    }
  });

  it('resolves the declared gateway alias to its row in each bundled reference', () => {
    for (const provider of providers) {
      const bundled = bundledReferenceCatalog(provider)!;
      expect(bundled.aliases, provider).toEqual({ [GATEWAY_ID]: ROW_ID });
      expect(lookupCatalogModel(bundled, GATEWAY_ID), provider).toEqual(lookupCatalogModel(bundled, ROW_ID));
      expect(lookupCatalogModel(bundled, GATEWAY_ID)?.modelId, provider).toBe(ROW_ID);
    }
  });

  it('leaves a prefixed id without a declared alias unpriced: no prefix is stripped and nothing is matched loosely', () => {
    const unmatched = [
      'deepseek/deepseek-v4-pro', // its row exists, but no alias was declared for this name
      'deepseek/deepseek-v4-flash',
      'anthropic/claude-opus-5',
      `openrouter/${ROW_ID}`, // another prefix on the aliased row
      `x/${GATEWAY_ID}`, // a prefix on the alias itself
      `${GATEWAY_ID}:free`, // a suffix on the alias
      `${GATEWAY_ID}-0813`,
      'deepseek/deepseek-v4.1', // a shorter spelling of the alias
      'deepseek/',
      `/${ROW_ID}`,
    ];
    for (const provider of providers) {
      const bundled = bundledReferenceCatalog(provider)!;
      for (const id of unmatched) expect(lookupCatalogModel(bundled, id), `${provider} ${id}`).toBeUndefined();
    }
  });

  it('refuses a catalog whose alias reads the same as a row id or as another alias', () => {
    const built = catalog();
    // Each catalog carries the digest of its own content, so a refusal below is the alias rule and not the digest.
    const withAliases = (aliases: Record<string, string>) => {
      const edited = { ...built, aliases };
      return validatePriceCatalog({ ...edited, contentDigest: catalogDigest(edited) });
    };
    // Control: two different names for one row are fine, and each resolves to it.
    const valid = withAliases({ 'gw/opus': 'claude-opus-5', 'other/opus': 'claude-opus-5' });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(lookupCatalogModel(valid.catalog, 'gw/opus')?.modelId).toBe('claude-opus-5');
      expect(lookupCatalogModel(valid.catalog, 'other/opus')?.modelId).toBe('claude-opus-5');
    }
    // The alias is another row's id, exactly or in another case: the lookup would answer with that row instead.
    expect(withAliases({ 'claude-opus-5': 'deepseek-v4-pro' })).toEqual({ ok: false, reason: 'alias claude-opus-5' });
    expect(withAliases({ 'Claude-Opus-5': 'deepseek-v4-pro' })).toEqual({ ok: false, reason: 'alias Claude-Opus-5' });
    // Two aliases that differ only by case, whichever rows they name: the lookup would answer with the first.
    expect(withAliases({ 'gw/model': 'claude-opus-5', 'GW/Model': 'deepseek-v4-pro' })).toEqual({ ok: false, reason: 'alias gw/model' });
    expect(withAliases({ 'gw/model': 'claude-opus-5', 'GW/Model': 'claude-opus-5' })).toEqual({ ok: false, reason: 'alias gw/model' });
    // An alias names a row, never another alias and never a row the catalog does not have.
    expect(withAliases({ 'gw/opus': 'claude-opus-5', 'gw/again': 'gw/opus' })).toEqual({ ok: false, reason: 'alias gw/again' });
    expect(withAliases({ [GATEWAY_ID]: ROW_ID })).toEqual({ ok: false, reason: `alias ${GATEWAY_ID}` });
    // A refused catalog gives the caller no catalog at all, so neither reading can be looked up.
    expect(withAliases({ 'gw/model': 'claude-opus-5', 'GW/Model': 'deepseek-v4-pro' })).not.toHaveProperty('catalog');
  });

  it('builds a capture without the declared aliases it cannot honour, so an exact id is never shadowed', () => {
    const built = catalogFromNewApiPricing(body, {
      provider: 'unode',
      capturedAt: '2026-09-27T00:00:00.000Z',
      sourceUrl: 'https://www.unodetech.xyz/api/pricing',
      aliases: {
        'gw/opus': 'claude-opus-5',
        'CLAUDE-OPUS-5': 'deepseek-v4-pro', // reads the same as a row id
        'gw/model': 'claude-opus-5', 'GW/Model': 'deepseek-v4-pro', // read the same as each other
        [GATEWAY_ID]: ROW_ID, // its row is not in this capture
      },
    });
    expect(built.aliases).toEqual({ 'gw/opus': 'claude-opus-5' });
    expect(validatePriceCatalog(built)).toEqual({ ok: true, catalog: built });
    expect(lookupCatalogModel(built, 'CLAUDE-OPUS-5')?.modelId).toBe('claude-opus-5');
    expect(lookupCatalogModel(built, 'gw/model')).toBeUndefined();
    expect(lookupCatalogModel(built, 'GW/Model')).toBeUndefined();
  });

  it('sets a capture under the aliases a release declares, keeping its rows, id and dates', () => {
    const capture = catalogFromNewApiPricing(body, {
      provider: 'unode', capturedAt: '2026-09-27T00:00:00.000Z', sourceUrl: 'https://www.unodetech.xyz/api/pricing',
    });
    expect(capture.aliases).toEqual({});
    const named = catalogWithAliases(capture, {
      'gw/opus': 'claude-opus-5',
      'CLAUDE-OPUS-5': 'deepseek-v4-pro', // reads the same as a row id of this capture
      [GATEWAY_ID]: ROW_ID, // its row is not in this capture
    });
    const expected = { ...capture, aliases: { 'gw/opus': 'claude-opus-5' } };
    expect(named).toEqual({ ...expected, contentDigest: catalogDigest(expected) });
    expect(validatePriceCatalog(named)).toEqual({ ok: true, catalog: named });
    expect(lookupCatalogModel(named, 'gw/opus')?.modelId).toBe('claude-opus-5');
    // The capture it was made from is not changed, and a name the release stops declaring is gone again.
    expect(capture.aliases).toEqual({});
    expect(catalogWithAliases(named, {})).toEqual(capture);
  });

  it('gives a stale catalog without the row no price for the id or for its alias', () => {
    // An older capture, taken before the model was listed. The alias another catalog declares does not reach it.
    const older = catalogFromNewApiPricing(body, {
      provider: 'roam',
      capturedAt: '2026-06-01T00:00:00.000Z',
      sourceUrl: 'https://ai.weroam.xyz/api/pricing',
      aliases: bundledReferenceCatalog('roam')!.aliases,
    });
    expect(catalogIsStale(older, Date.parse(bundledReferenceCatalog('roam')!.capturedAt))).toBe(true);
    expect(older.aliases).toEqual({});
    expect(lookupCatalogModel(older, ROW_ID)).toBeUndefined();
    expect(lookupCatalogModel(older, GATEWAY_ID)).toBeUndefined();
    // Being stale does not remove a row the capture does have.
    expect(lookupCatalogModel(older, 'deepseek-v4-pro')?.modelId).toBe('deepseek-v4-pro');
  });

  it('ships catalogs that match their recorded digest and state every key once', () => {
    for (const provider of providers) {
      const text = fs.readFileSync(path.join(__dirname, '..', '..', 'pricingCatalogs', `${provider}.json`), 'utf8');
      const raw = JSON.parse(text) as PriceCatalogV1;
      // After editing a bundled catalog, this is the digest to record in it.
      expect(raw.contentDigest, `${provider}.json contentDigest`).toBe(catalogDigest(raw));
      expect(validatePriceCatalog(raw), provider).toEqual({ ok: true, catalog: raw });
      expect(bundledReferenceCatalog(provider), provider).toEqual(raw);
      // A repeated key is dropped by the JSON parser before any check can see it, so the text itself is read.
      const repeated: string[] = [];
      const stack: Array<Set<string>> = [];
      visit(text, {
        onObjectBegin: () => { stack.push(new Set()); },
        onObjectEnd: () => { stack.pop(); },
        onObjectProperty: (property) => {
          const keys = stack[stack.length - 1];
          if (keys.has(property)) repeated.push(property);
          keys.add(property);
        },
      });
      expect(repeated, `${provider}.json repeated keys`).toEqual([]);
    }
  });
});
