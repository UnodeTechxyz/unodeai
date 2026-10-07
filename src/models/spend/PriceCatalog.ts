/*---------------------------------------------------------------------------------------------
 *  UnodeAi - dated reference price catalogs (v0.9.89, design §5.1, §13.5)
 *
 *  A reference catalog is an anonymous, dated capture of one provider's public price list. It is looked up by
 *  exact model id or an explicit alias only: a prior model version is never borrowed by substring, and a
 *  catalog never borrows a row from the other provider.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { canonicalJson } from './SpendTypes';
import { exactDecimal, NanoRates, parseNanoUsd } from './Money';

export type ReferenceProvider = 'unode' | 'roam';

export interface PriceCatalogModelV1 {
  modelId: string;
  inputNanoUsdPerMillion: string;
  outputNanoUsdPerMillion: string;
  cachedInputNanoUsdPerMillion?: string;
}

export interface PriceCatalogV1 {
  schemaVersion: 1;
  catalogId: string;
  provider: ReferenceProvider;
  capturedAt: string;
  publisherEffectiveAt?: string;
  sourceUrl: string;
  contentDigest: string;
  /** explicit alias -> exact model id */
  aliases: Record<string, string>;
  models: PriceCatalogModelV1[];
}

/** A reference figure turns stale 30 days after capture. */
export const REFERENCE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MODELS = 2_000;
const MODEL_ID = /^[A-Za-z0-9._:@/+-]{1,200}$/;
const CATALOG_ID = /^[A-Za-z0-9._-]{1,120}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function catalogDigest(catalog: Omit<PriceCatalogV1, 'contentDigest'> | PriceCatalogV1): string {
  const { contentDigest: _ignored, ...payload } = catalog as PriceCatalogV1;
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * Validate a catalog completely: closed keys, unique ids, canonical non-negative integers, acyclic aliases that
 * resolve once, an HTTPS source, and a digest over the canonical payload. Anything else is refused whole.
 */
export function validatePriceCatalog(value: unknown): { ok: true; catalog: PriceCatalogV1 } | { ok: false; reason: string } {
  if (!isObject(value)) return { ok: false, reason: 'not an object' };
  const allowed = ['schemaVersion', 'catalogId', 'provider', 'capturedAt', 'publisherEffectiveAt', 'sourceUrl', 'contentDigest', 'aliases', 'models'];
  if (!Object.keys(value).every((key) => allowed.includes(key))) return { ok: false, reason: 'unknown key' };
  if (value.schemaVersion !== 1) return { ok: false, reason: 'unsupported schema version' };
  if (typeof value.catalogId !== 'string' || !CATALOG_ID.test(value.catalogId)) return { ok: false, reason: 'catalog id' };
  if (value.provider !== 'unode' && value.provider !== 'roam') return { ok: false, reason: 'provider' };
  if (typeof value.capturedAt !== 'string' || Number.isNaN(Date.parse(value.capturedAt))) return { ok: false, reason: 'capture date' };
  if (value.publisherEffectiveAt !== undefined
    && (typeof value.publisherEffectiveAt !== 'string' || Number.isNaN(Date.parse(value.publisherEffectiveAt)))) {
    return { ok: false, reason: 'publisher date' };
  }
  if (typeof value.sourceUrl !== 'string' || !/^https:\/\/[^\s]+$/.test(value.sourceUrl)) return { ok: false, reason: 'source url' };
  if (typeof value.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentDigest)) return { ok: false, reason: 'digest' };
  if (!Array.isArray(value.models) || value.models.length > MAX_MODELS) return { ok: false, reason: 'models' };
  const ids = new Set<string>();
  for (const row of value.models) {
    if (!isObject(row)) return { ok: false, reason: 'model row' };
    if (!Object.keys(row).every((key) => ['modelId', 'inputNanoUsdPerMillion', 'outputNanoUsdPerMillion', 'cachedInputNanoUsdPerMillion'].includes(key))) {
      return { ok: false, reason: 'model row key' };
    }
    if (typeof row.modelId !== 'string' || !MODEL_ID.test(row.modelId) || ids.has(row.modelId)) return { ok: false, reason: 'model id' };
    ids.add(row.modelId);
    if (parseNanoUsd(row.inputNanoUsdPerMillion) === undefined || parseNanoUsd(row.outputNanoUsdPerMillion) === undefined) {
      return { ok: false, reason: `rate for ${row.modelId}` };
    }
    if (row.cachedInputNanoUsdPerMillion !== undefined && parseNanoUsd(row.cachedInputNanoUsdPerMillion) === undefined) {
      return { ok: false, reason: `cached rate for ${row.modelId}` };
    }
  }
  if (!isObject(value.aliases)) return { ok: false, reason: 'aliases' };
  for (const [alias, target] of Object.entries(value.aliases)) {
    // An alias resolves once, to a real row, and is not itself a model id or another alias's source.
    if (!MODEL_ID.test(alias) || typeof target !== 'string' || !ids.has(target) || ids.has(alias)) {
      return { ok: false, reason: `alias ${alias}` };
    }
  }
  const catalog = value as unknown as PriceCatalogV1;
  if (catalogDigest(catalog) !== catalog.contentDigest) return { ok: false, reason: 'digest mismatch' };
  return { ok: true, catalog };
}

export interface CatalogRates {
  modelId: string;
  rates: NanoRates;
}

/** Exact id (then the same id case-insensitively), then an explicit alias. Never a substring. */
export function lookupCatalogModel(catalog: PriceCatalogV1, modelId: string): CatalogRates | undefined {
  const wanted = modelId.trim();
  if (!wanted) return undefined;
  const lower = wanted.toLowerCase();
  const direct = catalog.models.find((row) => row.modelId === wanted)
    ?? catalog.models.find((row) => row.modelId.toLowerCase() === lower);
  const aliasTarget = direct ? undefined : (catalog.aliases[wanted] ?? Object.entries(catalog.aliases)
    .find(([alias]) => alias.toLowerCase() === lower)?.[1]);
  const row = direct ?? (aliasTarget ? catalog.models.find((candidate) => candidate.modelId === aliasTarget) : undefined);
  if (!row) return undefined;
  return {
    modelId: row.modelId,
    rates: {
      input: BigInt(row.inputNanoUsdPerMillion),
      output: BigInt(row.outputNanoUsdPerMillion),
      ...(row.cachedInputNanoUsdPerMillion !== undefined ? { cachedInput: BigInt(row.cachedInputNanoUsdPerMillion) } : {}),
    },
  };
}

export function catalogIsStale(catalog: Pick<PriceCatalogV1, 'capturedAt'>, now: number): boolean {
  return now - Date.parse(catalog.capturedAt) >= REFERENCE_STALE_AFTER_MS;
}

// ─── new-api conversion ────────────────────────────────────────────────────────

/** Exact rational arithmetic for the new-api price convention: USD per 1M = ratio × 2 (× factors). */
class Rational {
  constructor(readonly num: bigint, readonly den: bigint) {}
  static of(value: unknown): Rational | undefined {
    const decimal = exactDecimal(value);
    return decimal ? new Rational(decimal.digits, 10n ** BigInt(decimal.scale)) : undefined;
  }
  times(other: Rational): Rational { return new Rational(this.num * other.num, this.den * other.den); }
  /** nano-USD, rounded down. */
  floorNano(): bigint { return (this.num * 1_000_000_000n) / this.den; }
}

const TWO = new Rational(2n, 1n);

interface NewApiBodyRow {
  model_name?: unknown;
  model?: unknown;
  vendor_id?: unknown;
  quota_type?: unknown;
  model_ratio?: unknown;
  completion_ratio?: unknown;
  cache_ratio?: unknown;
  effective_discount?: unknown;
}

function newApiRows(body: unknown): NewApiBodyRow[] {
  if (Array.isArray(body)) return body as NewApiBodyRow[];
  if (isObject(body)) {
    for (const key of ['data', 'rows', 'list', 'models', 'prices']) {
      if (Array.isArray(body[key])) return body[key] as NewApiBodyRow[];
    }
  }
  return [];
}

/** A published discount percentage (0 < d < 100) as the fraction the buyer pays. */
function discountFactor(percent: unknown): Rational | undefined {
  const value = Rational.of(percent);
  if (!value || value.num === 0n) return undefined;
  if (value.num * 100n >= value.den * 10_000n) return undefined;
  // (100 - d) / 100
  return new Rational(100n * value.den - value.num, 100n * value.den);
}

/**
 * Convert a new-api `/api/pricing` body to anonymous list rates: the default group's published price including
 * the publisher's own per-row or vendor discount. Per-call (media) rows and rows without a positive ratio are
 * skipped. A group other than `default` is never applied: which group bills a key is not public information.
 */
export function ratesFromNewApiPricing(body: unknown, options: { applyDefaultGroup?: boolean } = {}): PriceCatalogModelV1[] {
  const vendors = new Map<number, Rational>();
  const vendorList = isObject(body) && Array.isArray(body.vendors) ? body.vendors : [];
  for (const vendor of vendorList) {
    if (isObject(vendor) && typeof vendor.id === 'number') {
      const factor = discountFactor(vendor.discount);
      if (factor) vendors.set(vendor.id, factor);
    }
  }
  const groupRatios = isObject(body) && isObject(body.group_ratio) ? body.group_ratio : {};
  const defaultGroup = Rational.of(groupRatios.default);
  const groupFactor = options.applyDefaultGroup !== false && defaultGroup && defaultGroup.num > 0n
    ? defaultGroup
    : new Rational(1n, 1n);
  const out = new Map<string, PriceCatalogModelV1>();
  for (const row of newApiRows(body)) {
    if (!isObject(row)) continue;
    const name = typeof row.model_name === 'string' ? row.model_name : typeof row.model === 'string' ? row.model : undefined;
    if (!name || !MODEL_ID.test(name) || out.has(name)) continue;
    if (typeof row.quota_type === 'number' && row.quota_type !== 0) continue;
    const ratio = Rational.of(row.model_ratio);
    if (!ratio || ratio.num <= 0n) continue;
    const completion = Rational.of(row.completion_ratio);
    const completionFactor = completion && completion.num > 0n ? completion : new Rational(1n, 1n);
    const discount = discountFactor(row.effective_discount)
      ?? (typeof row.vendor_id === 'number' ? vendors.get(row.vendor_id) : undefined)
      ?? new Rational(1n, 1n);
    const input = ratio.times(TWO).times(discount).times(groupFactor);
    const cache = Rational.of(row.cache_ratio);
    out.set(name, {
      modelId: name,
      inputNanoUsdPerMillion: input.floorNano().toString(),
      outputNanoUsdPerMillion: input.times(completionFactor).floorNano().toString(),
      ...(cache ? { cachedInputNanoUsdPerMillion: input.times(cache).floorNano().toString() } : {}),
    });
  }
  return [...out.values()].sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0));
}

/** Build a validated, digested reference catalog from a public new-api body. */
export function catalogFromNewApiPricing(
  body: unknown,
  meta: { provider: ReferenceProvider; capturedAt: string; sourceUrl: string; aliases?: Record<string, string> },
): PriceCatalogV1 {
  const models = ratesFromNewApiPricing(body);
  const ids = new Set(models.map((row) => row.modelId));
  const aliases = Object.fromEntries(Object.entries(meta.aliases ?? {}).filter(([alias, target]) => ids.has(target) && !ids.has(alias)));
  const payload: Omit<PriceCatalogV1, 'contentDigest'> = {
    schemaVersion: 1,
    catalogId: `${meta.provider}-${meta.capturedAt.slice(0, 10)}-${createHash('sha256').update(canonicalJson(models)).digest('hex').slice(0, 12)}`,
    provider: meta.provider,
    capturedAt: meta.capturedAt,
    sourceUrl: meta.sourceUrl,
    aliases,
    models,
  };
  return { ...payload, contentDigest: catalogDigest(payload) };
}

/** Published group ratios as exact decimal strings; invalid or negative entries are dropped. */
export function groupRatiosFromNewApiPricing(body: unknown): Record<string, string> {
  const raw = isObject(body) && isObject(body.group_ratio) ? body.group_ratio : {};
  const out: Record<string, string> = {};
  for (const [group, value] of Object.entries(raw)) {
    const decimal = exactDecimal(value);
    if (!decimal || group.length > 80) continue;
    const digits = decimal.digits.toString().padStart(decimal.scale + 1, '0');
    out[group] = decimal.scale > 0 ? `${digits.slice(0, -decimal.scale)}.${digits.slice(-decimal.scale)}` : digits;
  }
  return out;
}

/**
 * A billing group the response explicitly binds to the presented credential. Public `usable_group` and
 * `group_ratio` lists are the same for every key and never count; only an explicit credential-scoped field does.
 */
export function credentialBoundGroupFromPricing(body: unknown): string | undefined {
  if (!isObject(body)) return undefined;
  const group = body.applied_group;
  return body.applied_group_scope === 'credential' && typeof group === 'string' && group.trim() && group.length <= 80
    ? group.trim()
    : undefined;
}
