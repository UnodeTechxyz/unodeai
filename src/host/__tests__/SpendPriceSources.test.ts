import { afterEach, describe, expect, it } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AccountPriceSnapshots, ReferenceCatalogStore, routeCandidatesFor } from '../SpendPriceSources';
import { gatewaySnapshotFromPricing } from '../../models/spend/PriceResolver';
import { bundledReferenceCatalog } from '../../models/spend/BundledCatalogs';
import type { PriceFetch } from '../../models/LivePriceService';

const pricing = { group_ratio: { default: 1 }, data: [{ model_name: 'm1', quota_type: 0, model_ratio: 1, completion_ratio: 1 }] };
const snapshot = (authenticated = true) => gatewaySnapshotFromPricing(pricing, { sourceId: 'price-1', connectionId: 'unode', capturedAt: '2026-09-28T00:00:00.000Z', authenticated });

describe('account price snapshots', () => {
  it('drops a result fetched under an older credential generation', () => {
    const store = new AccountPriceSnapshots();
    const before = store.generation('unode');
    store.invalidate('unode'); // the key was replaced while the refresh was in flight
    expect(store.record('unode', before, snapshot())).toBe(false);
    expect(store.snapshot('unode')).toBeUndefined();
    expect(store.record('unode', store.generation('unode'), snapshot())).toBe(true);
    expect(store.snapshot('unode')).toBeDefined();
  });

  it('invalidates an existing snapshot when the key changes, without touching other connections', () => {
    const store = new AccountPriceSnapshots();
    store.record('unode', 0, snapshot());
    store.record('roam', 0, { ...snapshot(), connectionId: 'roam' });
    store.invalidate('unode');
    expect(store.snapshot('unode')).toBeUndefined();
    expect(store.snapshot('roam')).toBeDefined();
  });

  it('keeps a stated coefficient dormant without a key', () => {
    const withKey = routeCandidatesFor({ connectionId: 'unode', modelId: 'm1', userModelPrices: {}, snapshot: snapshot(true), coefficient: 0.5, hasKey: true });
    expect(withKey.map((candidate) => candidate.basis)).toEqual(['gateway-published', 'account-coefficient']);
    const withoutKey = routeCandidatesFor({ connectionId: 'unode', modelId: 'm1', userModelPrices: {}, snapshot: snapshot(false), coefficient: 0.5, hasKey: false });
    expect(withoutKey.map((candidate) => candidate.basis)).toEqual(['gateway-published']);
  });

  it('never uses another connection\'s snapshot', () => {
    expect(routeCandidatesFor({ connectionId: 'roam', modelId: 'm1', userModelPrices: {}, snapshot: snapshot(), coefficient: 1, hasKey: true })).toEqual([]);
  });
});

describe('reference catalogs', () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const dir of dirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true }); });

  it('ships two separate, valid, dated captures', () => {
    const unode = bundledReferenceCatalog('unode');
    const roam = bundledReferenceCatalog('roam');
    expect(unode?.provider).toBe('unode');
    expect(roam?.provider).toBe('roam');
    expect(unode?.capturedAt.startsWith('2026-09-27')).toBe(true);
    expect(roam?.capturedAt.startsWith('2026-09-27')).toBe(true);
    for (const id of ['claude-opus-5', 'deepseek-v4-pro', 'deepseek-v4-flash', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(unode?.models.some((row) => row.modelId === id), `unode ${id}`).toBe(true);
      expect(roam?.models.some((row) => row.modelId === id), `roam ${id}`).toBe(true);
    }
  });

  it('refreshes one provider without a key or redirect, and keeps the old capture on failure', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-refs-'));
    dirs.push(root);
    const store = new ReferenceCatalogStore(root);
    const seen: Array<{ url: string; headers?: Record<string, string>; redirect?: string }> = [];
    const ok: PriceFetch = async (url, init) => {
      seen.push({ url, headers: init?.headers, redirect: init?.redirect });
      return { ok: true, status: 200, text: async () => JSON.stringify(pricing) };
    };
    const later = Date.parse('2026-10-30T00:00:00.000Z');
    const catalog = await store.refresh('roam', 'https://ai.weroam.xyz/api/pricing', ok, () => later);
    expect(seen).toEqual([{ url: 'https://ai.weroam.xyz/api/pricing', headers: { Accept: 'application/json' }, redirect: 'error' }]);
    expect(store.catalogs().roam?.catalogId).toBe(catalog.catalogId);
    // A new store instance finds the refreshed capture on disk.
    const reloaded = new ReferenceCatalogStore(root);
    await reloaded.load();
    expect(reloaded.catalogs().roam?.catalogId).toBe(catalog.catalogId);
    const failing: PriceFetch = async () => ({ ok: false, status: 401, text: async () => '' });
    await expect(reloaded.refresh('roam', 'https://ai.weroam.xyz/api/pricing', failing)).rejects.toThrow(/requires sign-in/);
    expect(reloaded.catalogs().roam?.catalogId).toBe(catalog.catalogId);
    await expect(store.refresh('unode', 'http://www.unodetech.xyz/api/pricing', ok)).rejects.toThrow(/HTTPS/);
  });
});
