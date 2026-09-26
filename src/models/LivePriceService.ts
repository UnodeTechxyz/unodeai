/*---------------------------------------------------------------------------------------------
 *  UnodeAi - LivePriceService
 *  Fetches live model prices from a new-api gateway's /api/pricing and converts them to USD,
 *  so the cost table stays current without an extension release.
 *
 *  Conversion (new-api / one-api convention, verified against gpt-4o = OpenAI list price):
 *    input  USD / 1M tokens = model_ratio × 2
 *    output USD / 1M tokens = model_ratio × completion_ratio × 2
 *  (The ×2 is the standard "$1 = 500,000 quota" base. Per-call media pricing — quota_type 1 with a
 *   flat model_price — is skipped here since we only estimate token cost.)
 *
 *  Roam/new-api discounts are applied after conversion: account group_ratio and vendor discount.
 *
 *  Same logic for ANY new-api gateway: ComputeVault/Roam automatically, and "platforms we don't
 *  control" by giving their base/pricing URL via unode.pricingSources. A site that does NOT expose
 *  a new-api-style /api/pricing (e.g. a hand-written HTML pricing page) can't be parsed reliably —
 *  use the unode.modelPrices manual override for those.
 *--------------------------------------------------------------------------------------------*/

import { ModelPrice } from './ModelPricing';
import {
  boundedMetadataTtl,
  credentialFingerprint,
  ScopedMetadataCache,
  type MetadataCacheState,
} from './ScopedMetadataCache';

/** Injectable fetch (real one is global fetch) — keeps parsing/conversion unit-testable. */
export type PriceFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * THE RULE: a convenience fetch may RIDE ON a host the user already approved for network egress — it may
 * never INITIATE a network relationship with one.
 *
 * "Convenience" means the extension's *metadata* traffic: the gateway price list, the account balance, the
 * model catalog, the live `/models` endpoint. It is, by construction, the only traffic that no user action
 * asks for, which makes it the only traffic that can turn an install into a phone-home. v0.9.29 shipped
 * `void refreshPrices()` straight out of `activate()`, so a fresh install with no key, no configured provider
 * and no approved host beaconed two vendor gateways the moment VS Code finished starting — contradicting this
 * extension's own published promise, and matching the behavioural signature registries classify as unwanted
 * software.
 *
 * THE GATE IS ON THE FETCH, NOT ON THE CALLER. The first fix put the check at the price call site, and a
 * review immediately found `ModelCatalog` fetching `{base}/models` and a configurable catalog URL straight
 * past it. That is the same bug a second time, and the lesson is that "every caller remembers to check" is
 * not a property you can hold — so no caller is asked to. Every metadata service is constructed with a fetch
 * that has already been wrapped in this gate; there is no ungated path to forget, and adding a fourth service
 * inherits the rule for free.
 *
 * Fails CLOSED: a URL with no parseable host is never consented, so it is never fetched.
 */
export class EgressNotConsentedError extends Error {
  constructor(public readonly host: string) {
    super(
      `UnodeAi has not been approved to contact ${host || 'this host'}, so no request was made. `
      + 'Approve the gateway (or run "UnodeAi: Refresh Model Prices") to fetch live prices and models.'
    );
    this.name = 'EgressNotConsentedError';
  }
}

/**
 * Wrap a fetch so it refuses any host the user has not approved for metadata.
 *
 * Every metadata service (prices, balance, model catalog) is built on the wrapped fetch. They all already
 * degrade gracefully on a failed request — to the built-in price table, to no balance card, to the static
 * model list — so a refusal costs the user a live figure, never a broken UI.
 */
export function consentGatedFetch<F extends (url: string, init?: any) => Promise<any>>(
  inner: F,
  hasConsent: (host: string) => boolean
): F {
  return (async (url: string, init?: any) => {
    let host = '';
    try { host = new URL(url).host; } catch { host = ''; }
    if (!host || !hasConsent(host)) {
      throw new EgressNotConsentedError(host);
    }
    return inner(url, init);
  }) as F;
}

/**
 * Narrow a source list to ONE provider's own sources — the "actual reach" half of action-scoped metadata.
 *
 * Consent limits which hosts may EVER be contacted; scope limits which of those THIS ACTION contacts. They
 * are different axes and both are needed: after the prompt was correctly narrowed to the selected provider,
 * the fetch still walked every configured gateway — so a user who had approved Roam and Unode last week
 * opened the OpenAI picker and silently sent both gateways a price request. No consent was violated, and
 * that is exactly why consent alone was not enough: "this action touches only its planned hosts" is an
 * invariant about the ACTION, not about the grant. (Codex, v0.9.29 review.)
 *
 *  - `scope` = a providerId: only that provider's own source survives. For a direct provider (OpenAI,
 *    Anthropic…) no source carries its id, so the list is empty and the action fetches nothing — its prices
 *    come from the built-in table. User-added `pricingSources` entries carry no providerId and are therefore
 *    ONLY reachable by an unscoped refresh.
 *  - `scope` undefined = deliberately unscoped: activation, the daily timer, and the explicit
 *    "Refresh Model Prices" command, where every configured gateway is legitimately in play.
 */
export function scopedSources<T extends { providerId?: string }>(
  sources: readonly T[],
  scope: string | undefined
): T[] {
  if (scope === undefined) {
    return [...sources];
  }
  return sources.filter((s) => s.providerId === scope);
}

/**
 * The same rule applied to a LIST of sources, so a batch caller can skip-and-log rather than throw per item.
 * Enforcement still lives in `consentGatedFetch`; this is for reporting which sources were left alone.
 */
export function consentedSources<T extends { url: string }>(
  sources: readonly T[],
  hasConsent: (host: string) => boolean
): { allowed: T[]; skipped: T[] } {
  const allowed: T[] = [];
  const skipped: T[] = [];
  for (const s of sources) {
    let host = '';
    try { host = new URL(s.url).host; } catch { host = ''; }
    (host && hasConsent(host) ? allowed : skipped).push(s);
  }
  return { allowed, skipped };
}

/** new-api default: a model_ratio of 1 == $2 per 1M input tokens. */
const USD_PER_RATIO_UNIT = 2;

interface NewApiRow {
  model_name?: string;
  /** Some gateways key the model name as `model` instead of `model_name` — accepted as a fallback. */
  model?: string;
  vendor_id?: number;
  // Ratios may arrive as numbers or numeric strings depending on the gateway — coerced via toNum().
  model_ratio?: number | string;
  completion_ratio?: number | string;
  quota_type?: number;
}

/** Coerce a number-or-numeric-string to a number; undefined/NaN/non-finite → undefined. */
function toNum(v: unknown): number | undefined {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : undefined;
  }
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Extract the array of price rows from a new-api body. The rows may be the top-level value or nested
 * under one of several common envelope keys (gateways differ slightly) — the first array found wins.
 */
function extractRows(body: unknown): NewApiRow[] {
  if (Array.isArray(body)) {
    return body as NewApiRow[];
  }
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    for (const key of ['data', 'rows', 'list', 'models', 'prices']) {
      if (Array.isArray(b[key])) {
        return b[key] as NewApiRow[];
      }
    }
  }
  return [];
}

interface NewApiVendor {
  id?: number;
  discount?: number;
}

export class LivePriceService {
  private readonly cache: ScopedMetadataCache<{ prices: Record<string, ModelPrice>; resolution: GroupRatioResolution }>;

  constructor(
    private fetchFn: PriceFetch,
    private opts: {
      ttlMs?: number;
      now?: () => number;
      /** Re-checked before every lookup, including cache hits. */
      canReadMetadata?: (url: string) => boolean;
    } = {},
  ) {
    this.cache = new ScopedMetadataCache(
      boundedMetadataTtl(opts.ttlMs),
      opts.now,
    );
  }

  /**
   * Fetch a new-api gateway's pricing and convert to a USD/1M price table. Accepts either the
   * gateway base URL (…/v1) or a full …/api/pricing URL. Throws on network/HTTP failure so the
   * caller can log-and-fallback to the static table.
   *
   * `preferredGroup` lets the user pin their billing group (unode.priceGroup) when the gateway
   * exposes several; otherwise we auto-pick the single usable group, else "default".
   */
  /**
   * Fetch and convert, reporting the basis alongside the table.
   *
   * `fetchGatewayPrices` keeps returning the table alone for existing callers; this is the one that can say
   * where the number came from. A price a user cannot trace is a price they cannot check, and the field
   * report behind this was exactly that: a third of the real rate, with nowhere to look.
   */
  /**
   * @param userCoefficient What the user says this key pays as a fraction of the published price. When
   * given it is the **only** discount applied — the gateway's own `group_ratio` is not multiplied on top.
   *
   * Both are answers to the same question, so applying both answers it twice. The prompt asks for a
   * fraction "of the published price", and a group ratio has already turned published into charged, so
   * 0.33 stated against a gateway reporting 0.33 displayed 0.1089 of list. Codex review, 2026-08-21.
   *
   * The user's number wins because it is a stated fact about their account and the ratio is an inference
   * from a document that, in the field, usually does not carry the number at all.
   */
  async fetchGatewayPricesDetailed(
    baseOrPricingUrl: string,
    apiKey?: string,
    preferredGroup?: string,
    userCoefficient?: number,
    request: { scope?: string; signal?: AbortSignal } = {},
  ): Promise<{ prices: Record<string, ModelPrice>; resolution: GroupRatioResolution; cacheState: Exclude<MetadataCacheState, 'unknown'> }> {
    const url = this.pricingUrl(baseOrPricingUrl);
    this.assertCurrentPermission(url);
    const result = await this.cache.get(
      this.cacheKey(url, apiKey, preferredGroup, userCoefficient, request.scope),
      (signal) => this.loadDetailed(url, apiKey, preferredGroup, userCoefficient, signal),
      request.signal,
    );
    return { ...result.value, cacheState: result.state };
  }

  /** State for presentation code that chooses to keep an expired, failed-refresh value visible. */
  cacheState(
    baseOrPricingUrl: string,
    apiKey?: string,
    preferredGroup?: string,
    userCoefficient?: number,
    scope?: string,
  ): MetadataCacheState {
    const url = this.pricingUrl(baseOrPricingUrl);
    return this.cache.state(this.cacheKey(url, apiKey, preferredGroup, userCoefficient, scope));
  }

  private async loadDetailed(
    url: string,
    apiKey: string | undefined,
    preferredGroup: string | undefined,
    userCoefficient: number | undefined,
    signal: AbortSignal,
  ): Promise<{ prices: Record<string, ModelPrice>; resolution: GroupRatioResolution }> {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const res = await this.fetchFn(url, { headers, signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    const body = JSON.parse(await res.text());
    const resolution: GroupRatioResolution =
      typeof userCoefficient === 'number' && Number.isFinite(userCoefficient) && userCoefficient >= 0
        ? { ratio: userCoefficient, basis: 'user-coefficient' }
        : resolveGroupRatioDetailed(body, preferredGroup);
    return {
      prices: convertRows(extractRows(body), resolution.ratio, resolveVendorDiscounts(body)),
      resolution,
    };
  }

  async fetchGatewayPrices(
    baseOrPricingUrl: string,
    apiKey?: string,
    preferredGroup?: string,
    request: { scope?: string; signal?: AbortSignal } = {},
  ): Promise<Record<string, ModelPrice>> {
    return (await this.fetchGatewayPricesDetailed(baseOrPricingUrl, apiKey, preferredGroup, undefined, request)).prices;
  }

  private cacheKey(
    url: string,
    apiKey: string | undefined,
    preferredGroup: string | undefined,
    userCoefficient: number | undefined,
    scope: string | undefined,
  ): string {
    const route = new URL(url);
    // Do not preserve a user-supplied query in a cache key; pricing endpoints do not need it and cache keys
    // are a poor place for a token-like query parameter. Scope names the connection before a route is shared.
    const normalizedRoute = `${route.origin}${route.pathname}`;
    return [scope ?? normalizedRoute, normalizedRoute, credentialFingerprint(apiKey), preferredGroup ?? '', userCoefficient ?? 'unstated'].join('|');
  }

  private assertCurrentPermission(url: string): void {
    if (this.opts.canReadMetadata && !this.opts.canReadMetadata(url)) {
      let host = '';
      try { host = new URL(url).host; } catch { /* pricingUrl already validates normal inputs */ }
      throw new EgressNotConsentedError(host);
    }
  }

  /** Resolve a base URL (…/v1) or a full pricing URL to the /api/pricing endpoint. */
  private pricingUrl(input: string): string {
    if (/\/api\/pricing\/?$/.test(input)) {
      return input;
    }
    return new URL('/api/pricing', input).href; // absolute path -> origin + /api/pricing
  }
}

/**
 * Read `unode.priceMultiplier`: the coefficient a gateway settles at for one key.
 *
 * `unode.priceGroup` only helps when the pricing endpoint reports a ratio for the named group. Field
 * report, 2026-08-21: it often reports none — the coefficient is an internal settlement number and the
 * endpoint publishes list prices only. Naming a group cannot recover a number nobody sent, so this setting
 * carries the number itself.
 *
 * Like the group, it belongs to the key: a plain number applies everywhere, a map names one per connection.
 *
 * **Zero is allowed and negative is not.** A free or internally-settled key genuinely costs nothing, and
 * refusing to express that would force the user to state a price they do not pay. A negative price is not a
 * fact about anything, and neither is NaN — those read as unstated, so the gateway's own answer applies
 * rather than a number nobody meant.
 *
 * **`undefined` means unstated, and that is not the same as 1.** A stated 1 says "this key pays list price"
 * and suppresses the gateway's group ratio; an absent value says nothing and lets the ratio through. The
 * two were the same value in the first version of this, which made every connection override a gateway that
 * did know the answer.
 */
export function readPriceMultiplierSetting(raw: unknown): (connectionId: string) => number | undefined {
  const valid = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const single = valid(raw);
  if (single !== undefined) {
    return () => single;
  }
  if (raw && typeof raw === 'object') {
    const map = raw as Record<string, unknown>;
    return (connectionId) => valid(map[connectionId]);
  }
  return () => undefined;
}

/**
 * Which connections still have no stated coefficient.
 *
 * Pure so it can be tested: the caller supplies the connections that have a stored key, and this decides
 * what to write. Codex review, 2026-08-21 — the first version could never fire, because the setting's
 * default was the number 1 and the function returned early on a number. A backfill that cannot run is
 * indistinguishable from one that ran and found nothing.
 *
 * A bare number is left alone: that is a deliberate "same everywhere" statement, and rewriting it into a
 * map behind the user would change what they said.
 */
export function priceMultiplierBackfill(
  current: unknown,
  connectionsWithKeys: readonly string[],
): { next: Record<string, number>; added: string[] } | undefined {
  if (typeof current === 'number') {
    return undefined;
  }
  const next: Record<string, number> = current && typeof current === 'object'
    ? { ...(current as Record<string, number>) }
    : {};
  const added = connectionsWithKeys.filter((id) => typeof next[id] !== 'number');
  if (added.length === 0) {
    return undefined;
  }
  for (const id of added) {
    // 1 and nothing else. Inferring a discount unattended is the guess this whole area exists to refuse.
    next[id] = 1;
  }
  return { next, added };
}

/**
 * Read `unode.priceGroup`, which names the billing group per connection.
 *
 * Accepts a plain string (one group everywhere — correct only when every key is in the same group) or a map
 * keyed by connection id. The map exists because the group is a property of the key: the same account can
 * hold a `roam` key in one group and a `unode` key in another, and one global value cannot be right for
 * both. Exported for test.
 */
export function readPriceGroupSetting(raw: unknown): (connectionId: string) => string | undefined {
  if (typeof raw === 'string') {
    const single = raw.trim();
    return () => single || undefined;
  }
  if (raw && typeof raw === 'object') {
    const map = raw as Record<string, unknown>;
    return (connectionId) => {
      const value = map[connectionId];
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    };
  }
  return () => undefined;
}

/**
 * Pick the discount multiplier to apply from a new-api /api/pricing body.
 *
 * new-api returns `group_ratio` (group → multiplier) and `usable_group` (the groups this account/key MAY
 * use). It does not return the group the account is actually billed at: that lives behind
 * `/api/user/self`, which needs a login session rather than an API key and is deliberately not used (see
 * `BalanceService`). **So when several groups are usable, this function is guessing.**
 *
 * It used to guess the cheapest usable group. Field report, 2026-08-21: a model listed at $5.10/1M showed
 * as $1.6983 in the extension — a third of the real price — and the user was billed the $5.10. Guessing
 * downward does not produce an optimistic estimate; it produces a cost display that is wrong in the one
 * direction that costs the user money without warning them. **An estimate you cannot verify should err
 * where being wrong is survivable.**
 *
 * Selection now:
 *   1. explicit `preferredGroup` (`unode.priceGroup`), when valid — a stated fact beats any inference;
 *   2. exactly one usable group → use it. There is nothing to guess between;
 *   3. several usable groups → **the one we cannot be under**: `default` if it is among them, otherwise
 *      the highest (least discounted) ratio. `default` being usable is itself evidence the account may sit
 *      there, which is precisely when picking the cheapest is unjustified;
 *   4. no usable list → `default`, else 1.
 *
 * A user on a real discount sees list price until they pin their group. That is the correct trade: an
 * over-estimate is visible and correctable, and an under-estimate is neither.
 */
/**
 * What the displayed price was computed against.
 *
 * A cost figure with no provenance is a number a user cannot check. The field report that produced this
 * type went the other way — the extension showed a third of the real price and there was nowhere to look to
 * find out why — so the resolution now reports itself rather than only its answer.
 */
export interface GroupRatioResolution {
  ratio: number;
  /** Which group's multiplier was used, when one was identifiable. */
  group?: string;
  /** How the group was arrived at: a pin and a single usable group are facts; the rest are not. */
  basis: 'user-coefficient' | 'pinned' | 'only-usable-group' | 'assumed-undiscounted' | 'default-group' | 'no-discount';
  /** Groups the account may use, when more than one made the choice ambiguous. */
  ambiguousGroups?: string[];
}

/** A one-line, user-facing account of where a price came from. */
export function describeGroupRatio(resolution: GroupRatioResolution): string {
  if (resolution.basis === 'user-coefficient') {
    return resolution.ratio === 1
      ? 'list price — your stated coefficient for this key is 1'
      : `your stated ${resolution.ratio}x coefficient for this key`;
  }
  if (resolution.basis === 'pinned') {
    return `your pinned price group "${resolution.group}"`;
  }
  if (resolution.basis === 'only-usable-group') {
    return `your account's price group "${resolution.group}"`;
  }
  if (resolution.basis === 'assumed-undiscounted') {
    return 'list price — this key may use '
      + `${(resolution.ambiguousGroups ?? []).length} price groups and the gateway does not say which one bills, `
      + 'so the highest is shown. Set unode.priceGroup to see your real rate';
  }
  return 'list price';
}

export function resolveGroupRatioDetailed(body: unknown, preferredGroup?: string): GroupRatioResolution {
  const b = (body && typeof body === 'object' ? body : {}) as {
    group_ratio?: Record<string, unknown>;
    usable_group?: Record<string, unknown>;
  };
  const groupRatio = b.group_ratio && typeof b.group_ratio === 'object' ? b.group_ratio : {};
  const usable = b.usable_group && typeof b.usable_group === 'object' ? Object.keys(b.usable_group) : [];
  const ratioOf = (g: string): number | undefined => {
    const r = groupRatio[g];
    return typeof r === 'number' && r > 0 ? r : undefined;
  };

  // 1. Explicit pin.
  const pref = preferredGroup?.trim();
  if (pref) {
    const r = ratioOf(pref);
    if (r !== undefined) {
      return { ratio: r, group: pref, basis: 'pinned' };
    }
  }

  // 2. Exactly one usable group: no ambiguity, so applying it is a fact rather than a guess.
  const usableRatios = usable
    .map((group) => ({ group, ratio: ratioOf(group) }))
    .filter((entry): entry is { group: string; ratio: number } => entry.ratio !== undefined);
  if (usableRatios.length === 1) {
    return { ratio: usableRatios[0].ratio, group: usableRatios[0].group, basis: 'only-usable-group' };
  }

  // 3. Several usable groups and no way to tell which one bills. Take the one we cannot be under.
  if (usableRatios.length > 1) {
    const asDefault = usableRatios.find((entry) => entry.group === 'default');
    const chosen = asDefault
      ?? usableRatios.reduce((a, b) => (b.ratio > a.ratio ? b : a));
    return {
      ratio: chosen.ratio,
      group: chosen.group,
      basis: 'assumed-undiscounted',
      ambiguousGroups: usableRatios.map((entry) => entry.group),
    };
  }

  // 4. Fall back to the default group's ratio, else no discount.
  const fallback = ratioOf('default');
  return fallback !== undefined
    ? { ratio: fallback, group: 'default', basis: 'default-group' }
    : { ratio: 1, basis: 'no-discount' };
}

/** The multiplier alone, for callers that do not report provenance. */
export function resolveGroupRatio(body: unknown, preferredGroup?: string): number {
  return resolveGroupRatioDetailed(body, preferredGroup).ratio;
}

/**
 * Build per-vendor price multipliers from new-api's `vendors[].discount` field. The public Roam
 * pricing endpoint currently reports account group ratios separately from vendor discounts; both
 * affect the displayed/user-facing price. `discount: 40` means the user pays 60% of the base ratio.
 */
export function resolveVendorDiscounts(body: unknown): Record<number, number> {
  const b = (body && typeof body === 'object' ? body : {}) as { vendors?: unknown };
  const vendors = Array.isArray(b.vendors) ? (b.vendors as NewApiVendor[]) : [];
  const out: Record<number, number> = {};
  for (const vendor of vendors) {
    if (!vendor || typeof vendor.id !== 'number' || typeof vendor.discount !== 'number') {
      continue;
    }
    if (vendor.discount <= 0 || vendor.discount >= 100) {
      continue;
    }
    out[vendor.id] = (100 - vendor.discount) / 100;
  }
  return out;
}

/** Exposed for testing: convert new-api rows to a USD/1M price table (token models only). */
export function convertRows(
  rows: NewApiRow[],
  groupRatio = 1,
  vendorDiscounts: Record<number, number> = {}
): Record<string, ModelPrice> {
  // `>= 0`, not `> 0`: zero is a stated coefficient meaning a key costs nothing, and the old guard read it
  // as "unset" and charged list price for a free key. The same off-by-one-concept the multiplier had.
  const discount = typeof groupRatio === 'number' && Number.isFinite(groupRatio) && groupRatio >= 0
    ? groupRatio
    : 1;
  const out: Record<string, ModelPrice> = {};
  for (const r of rows) {
    if (!r) {
      continue;
    }
    const name = typeof r.model_name === 'string' ? r.model_name : typeof r.model === 'string' ? r.model : undefined;
    if (!name) {
      continue;
    }
    // quota_type 1 = flat per-call (image/video/audio) — not token-priced; skip. A MISSING quota_type is
    // treated as token-priced (0): some gateways omit the field, and dropping those rows blanked the table.
    if (typeof r.quota_type === 'number' && r.quota_type !== 0) {
      continue;
    }
    const ratio = toNum(r.model_ratio) ?? 0;
    if (!(ratio > 0)) {
      continue;
    }
    const completionRatio = toNum(r.completion_ratio);
    const completion = completionRatio && completionRatio > 0 ? completionRatio : 1;
    const vendorMultiplier = typeof r.vendor_id === 'number' ? vendorDiscounts[r.vendor_id] ?? 1 : 1;
    const effectiveMultiplier = discount * vendorMultiplier;
    out[name] = {
      input: ratio * USD_PER_RATIO_UNIT * effectiveMultiplier,
      output: ratio * completion * USD_PER_RATIO_UNIT * effectiveMultiplier,
    };
  }
  return out;
}
