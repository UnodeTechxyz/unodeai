/*---------------------------------------------------------------------------------------------
 *  UnodeAi - spend price sources (v0.9.89, design §5.2, §5.6, §13.5)
 *
 *  Account snapshots: in-memory, per connection and credential generation. Replacing, clearing or rerouting a
 *  key bumps the generation, drops the snapshot and makes any in-flight result from the old key unusable.
 *  Snapshots hold public price rows and an opaque source id; never a key, login or reversible fingerprint.
 *
 *  Reference catalogs: the two bundled dated captures, or a newer validated capture the user refreshed. A
 *  refresh contacts only that provider's pinned HTTPS pricing endpoint, sends no credential, refuses
 *  redirects, bounds the payload and never borrows a row from the other provider.
 *--------------------------------------------------------------------------------------------*/

import * as fsp from 'fs/promises';
import * as path from 'path';
import { bundledReferenceCatalog } from '../models/spend/BundledCatalogs';
import {
  catalogFromNewApiPricing,
  validatePriceCatalog,
  type PriceCatalogV1,
  type ReferenceProvider,
} from '../models/spend/PriceCatalog';
import {
  gatewayCandidates,
  userOverrideCandidate,
  type GatewayPriceSnapshot,
  type PriceCandidate,
  type ReferenceCatalogs,
} from '../models/spend/PriceResolver';
import type { PriceFetch } from '../models/LivePriceService';

export class AccountPriceSnapshots {
  private readonly generations = new Map<string, number>();
  private readonly snapshots = new Map<string, { generation: number; snapshot: GatewayPriceSnapshot }>();

  generation(connectionId: string): number {
    return this.generations.get(connectionId) ?? 0;
  }

  /** A key replaced, cleared or rerouted for this connection (in this or another window). */
  invalidate(connectionId: string): void {
    this.generations.set(connectionId, this.generation(connectionId) + 1);
    this.snapshots.delete(connectionId);
  }

  invalidateAll(): void {
    for (const connectionId of new Set([...this.generations.keys(), ...this.snapshots.keys()])) this.invalidate(connectionId);
  }

  /** Record a snapshot fetched under `generationAtStart`; a result from an older credential is dropped. */
  record(connectionId: string, generationAtStart: number, snapshot: GatewayPriceSnapshot): boolean {
    if (this.generation(connectionId) !== generationAtStart) return false;
    this.snapshots.set(connectionId, { generation: generationAtStart, snapshot: { ...snapshot, connectionId } });
    return true;
  }

  snapshot(connectionId: string): GatewayPriceSnapshot | undefined {
    const entry = this.snapshots.get(connectionId);
    return entry && entry.generation === this.generation(connectionId) ? entry.snapshot : undefined;
  }
}

/**
 * Items 2–6 of design §5.1 for one exact connection and model: the user's exact-model override, then whatever
 * the connection's current snapshot supports with the user's single stated coefficient or group.
 */
export function routeCandidatesFor(input: {
  connectionId: string;
  modelId: string;
  userModelPrices: unknown;
  snapshot?: GatewayPriceSnapshot;
  coefficient?: number;
  group?: string;
  /** A coefficient or group is dormant while the connection has no key (design §5.2). */
  hasKey: boolean;
}): PriceCandidate[] {
  const out: PriceCandidate[] = [];
  const override = userOverrideCandidate(input.userModelPrices, input.modelId);
  if (override) out.push(override);
  if (input.snapshot && input.snapshot.connectionId === input.connectionId) {
    out.push(...gatewayCandidates(input.snapshot, input.modelId, input.hasKey
      ? { coefficient: input.coefficient, group: input.group }
      : {}));
  }
  return out;
}

const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;

export class ReferenceCatalogStore {
  private readonly refreshed: Partial<Record<ReferenceProvider, PriceCatalogV1>> = {};

  constructor(private readonly root: string | undefined) {}

  /** `<globalStorage>/pricing/v1` */
  private dir(provider: ReferenceProvider): string | undefined {
    return this.root ? path.join(this.root, 'pricing', 'v1', provider) : undefined;
  }

  /** Load the user's refreshed captures, if any. A capture that fails validation is ignored, not deleted. */
  async load(): Promise<void> {
    for (const provider of ['unode', 'roam'] as const) {
      const dir = this.dir(provider);
      if (!dir) continue;
      let pointer: string | undefined;
      try {
        pointer = (JSON.parse(await fsp.readFile(path.join(dir, 'current.json'), 'utf8')) as { catalogId?: unknown }).catalogId as string;
      } catch { pointer = undefined; }
      if (typeof pointer !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(pointer)) continue;
      try {
        const result = validatePriceCatalog(JSON.parse(await fsp.readFile(path.join(dir, `${pointer}.json`), 'utf8')));
        if (result.ok && result.catalog.provider === provider) this.refreshed[provider] = result.catalog;
      } catch { /* the bundled capture stays in use */ }
    }
  }

  /** The newest valid catalog per provider: a refreshed capture only when newer than the bundled one. */
  catalogs(): ReferenceCatalogs {
    const pick = (provider: ReferenceProvider): PriceCatalogV1 | undefined => {
      const bundled = bundledReferenceCatalog(provider);
      const refreshed = this.refreshed[provider];
      if (!refreshed) return bundled;
      if (!bundled) return refreshed;
      return Date.parse(refreshed.capturedAt) > Date.parse(bundled.capturedAt) ? refreshed : bundled;
    };
    return { unode: pick('unode'), roam: pick('roam') };
  }

  /**
   * Refresh one provider's reference capture from its pinned HTTPS pricing endpoint: no credential, no
   * redirects, bounded payload, full validation, then an atomic write. Failure keeps the previous catalog.
   */
  async refresh(provider: ReferenceProvider, pricingUrl: string, fetchFn: PriceFetch, now: () => number = Date.now): Promise<PriceCatalogV1> {
    const url = new URL(pricingUrl);
    if (url.protocol !== 'https:') throw new Error(`${provider} reference prices must come from an HTTPS endpoint.`);
    const response = await fetchFn(url.href, { headers: { Accept: 'application/json' }, redirect: 'error' });
    if (!response.ok) {
      throw new Error(response.status === 401 || response.status === 403
        ? `${provider === 'unode' ? 'Unode' : 'Roam'} now requires sign-in for its price list, so its anonymous reference cannot be refreshed. The previous capture stays in use.`
        : `HTTP ${response.status} from ${url.host}.`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_REFERENCE_BYTES) throw new Error(`The ${url.host} price list is larger than expected; it was not used.`);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new Error(`The ${url.host} price list is not JSON; it was not used.`); }
    const catalog = catalogFromNewApiPricing(body, { provider, capturedAt: new Date(now()).toISOString(), sourceUrl: url.href });
    if (catalog.models.length === 0) throw new Error(`The ${url.host} price list contained no token-priced models; it was not used.`);
    const check = validatePriceCatalog(catalog);
    if (!check.ok) throw new Error(`The ${url.host} price list did not validate (${check.reason}); it was not used.`);
    const dir = this.dir(provider);
    if (dir) {
      await fsp.mkdir(dir, { recursive: true });
      await writeAtomic(path.join(dir, `${catalog.catalogId}.json`), `${JSON.stringify(catalog, null, 2)}\n`);
      await writeAtomic(path.join(dir, 'current.json'), `${JSON.stringify({ catalogId: catalog.catalogId })}\n`);
    }
    this.refreshed[provider] = catalog;
    return catalog;
  }
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
}
