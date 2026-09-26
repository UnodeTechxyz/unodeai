/*---------------------------------------------------------------------------------------------
 *  UnodeAi - ModelPricing
 *  Estimates USD cost from token usage for backends that report tokens but not cost.
 *
 *  The Claude headless backend reports real `total_cost_usd`; OpenAI-compatible gateways (Roam /
 *  算力仓 / OpenAI …) report only token counts. Since the whole product narrative is cost
 *  arbitrage, the Dashboard needs a dollar figure — so we estimate it from a per-model price table.
 *
 *  Prices are USD per 1M tokens and are APPROXIMATE; users/Roam can override or extend the table
 *  via the `unode.modelPrices` setting. Matching is exact-id first, then the longest table key that
 *  the model id contains (so `claude-opus-4-5` and `anthropic/claude-opus…` both map to opus).
 *--------------------------------------------------------------------------------------------*/

export interface ModelPrice {
  /** USD per 1,000,000 input tokens (a cache MISS — the full rate). */
  input: number;
  /** USD per 1,000,000 output tokens. */
  output: number;
  /**
   * USD per 1,000,000 input tokens served from the prefix cache. **Absent = no discount** — cached tokens
   * are priced at the full `input` rate.
   *
   * That default looks pessimistic and is deliberate. The rate that decides the user's bill is the
   * GATEWAY's, not the upstream model's. A stock new-api gateway (`setting/ratio_setting/cache_ratio.go`)
   * returns a cache ratio of **1.0 — full price — for any model not in a small hardcoded table**, and that
   * table contains none of the models we actually ship on (`deepseek-v4-*`, `glm-*`, `kimi-*`, `qwen-*`,
   * `grok-*`). So the gateway happily *reports* a 90% hit rate while *charging* full price for every one of
   * those tokens. Assuming a discount we cannot prove would UNDER-report what the user really pays, and
   * under-reporting a bill is worse than over-reporting it.
   *
   * Only fill this in for a (model, gateway) pair whose real billing we have measured — the hit-rate display
   * is honest regardless, because it reports what the gateway told us rather than what we hope it charged.
   */
  cachedInput?: number;
}

export type ModelPriceSource = 'live' | 'list';
export interface ResolvedModelPrice { price: ModelPrice; source: ModelPriceSource; }

/**
 * These OpenAI tier defaults resolve on the selected gateway, but no rate for them has been verified
 * in the published price snapshot or a provider-scoped live response. Do not inherit `gpt-5`'s price:
 * a version boundary is an unknown bill, not a license to display an older model's number. A live
 * provider price still wins normally when it becomes available.
 */
const INTENTIONALLY_UNPRICED_LIST_MODEL_IDS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
]);

/** A visible picker/agent-builder label for selected defaults whose rate has not been verified. */
export function intentionallyUnknownPriceLabel(modelId: string): string | undefined {
  return INTENTIONALLY_UNPRICED_LIST_MODEL_IDS.has(modelId.trim().toLowerCase())
    ? 'price unavailable (no verified rate)'
    : undefined;
}

/**
 * Prices in USD / 1M tokens, derived from the Roam ComputeVault gateway's published ratios
 * (https://www.unodetech.xyz/pricing, GET /api/pricing — snapshot 2026-06-02). These are what a
 * Roam user actually pays, so estimates match their bill. Conversion (new-api convention,
 * verified against gpt-4o = OpenAI list): input = model_ratio × 2, output = model_ratio ×
 * completion_ratio × 2, then apply live gateway discounts when available. Override/extend via the
 * `unode.modelPrices` setting.
 *
 * Keys match by substring (longest-first), so `claude-opus` covers claude-opus-4-5/4-6/4-7/4-8.
 */
export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
  // DeepSeek (cheap "muscle" models — the demo team's default)
  'deepseek-v4-flash': { input: 0.14, output: 0.28 },
  'deepseek-v4-pro': { input: 0.435, output: 0.87 },
  // Qwen
  'qwen-max': { input: 1.6, output: 6.4 },
  'qwen-plus': { input: 0.4, output: 1.2 },
  // OpenAI
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5': { input: 1.25, output: 10 },
  // Anthropic (gateway BASE ratios — do NOT bake the vendor discount in here; it varies (and VIP group
  // ratios are coming). LivePriceService applies group_ratio × vendor_discount on top from live data.
  // This static table is only the offline fallback, so it stays at base; live values override it.)
  'claude-haiku': { input: 1, output: 5 },
  'claude-sonnet': { input: 3, output: 15 },
  'claude-opus': { input: 5, output: 25 },
  'claude-fable': { input: 10, output: 50 },
  // Bare family aliases, as accepted by `claude --model` (opus/sonnet/haiku/fable → newest in family).
  // Without these an aliased agent estimates at zero, which reads as free rather than as unknown. Keys
  // match longest-first, so a full id still resolves to its own row above, not to these.
  fable: { input: 10, output: 50 },
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
  // Google
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-3-flash-preview': { input: 0.5, output: 3 },
  'gemini-3-pro-preview': { input: 2, output: 12 },
  // Others on the gateway
  'glm-5.1': { input: 1.4, output: 4.4 },
  'glm-5': { input: 1, output: 3.2 },
  'kimi-k2.6': { input: 0.95, output: 4 },
  'grok-4': { input: 1.25, output: 2.5 },
  // No global grok-4.5 default on purpose: it is priced differently per gateway (Roam 3.4 vs Unode 5.1
  // output), so any single global number is wrong for one of them. A per-provider price comes from the live
  // /api/pricing refresh; before that lands (or if it fails) the picker shows blank, never a wrong gateway's.
};

export class ModelPricing {
  private prices: Record<string, ModelPrice>;
  /** Table keys sorted longest-first so a more specific id wins (claude-opus before claude). */
  private keys: string[];
  private providerPrices = new Map<string, Record<string, ModelPrice>>();
  private providerKeys = new Map<string, string[]>();

  constructor(prices: Record<string, ModelPrice> = DEFAULT_MODEL_PRICES) {
    // Clone so live refreshes (merge) never mutate the shared DEFAULT_MODEL_PRICES constant.
    this.prices = { ...prices };
    this.keys = this.sortedKeys(this.prices);
  }

  /**
   * Merge live prices (e.g. fetched from a gateway's /api/pricing). When `providerId` is supplied,
   * prices stay scoped to that provider so two gateways with the same model id never overwrite each
   * other. Without `providerId`, this preserves the legacy/global override path.
   */
  merge(prices: Record<string, ModelPrice>, providerId?: string): void {
    const scopedProvider = normalizeProvider(providerId);
    if (scopedProvider) {
      const current = this.providerPrices.get(scopedProvider) ?? {};
      const next = { ...current, ...prices };
      this.providerPrices.set(scopedProvider, next);
      this.providerKeys.set(scopedProvider, this.sortedKeys(next));
      return;
    }
    Object.assign(this.prices, prices);
    this.keys = this.sortedKeys(this.prices);
  }

  private sortedKeys(prices: Record<string, ModelPrice>): string[] {
    return Object.keys(prices).sort((a, b) => b.length - a.length);
  }

  /** The price entry for a model id, or undefined if unknown. */
  priceFor(model: string, providerId?: string): ModelPrice | undefined {
    return this.priceInfoFor(model, providerId)?.price;
  }

  /** Price plus provenance: provider-scoped gateway entries are live; the static table is list fallback. */
  priceInfoFor(model: string, providerId?: string): ResolvedModelPrice | undefined {
    const scopedProvider = normalizeProvider(providerId);
    if (scopedProvider) {
      const scoped = this.providerPrices.get(scopedProvider);
      if (scoped) {
        const scopedPrice = lookupPrice(scoped, this.providerKeys.get(scopedProvider) ?? this.sortedKeys(scoped), model);
        if (scopedPrice) {
          return { price: scopedPrice, source: 'live' };
        }
      }
      // A custom connection has no trusted global price authority. It must publish a price for this
      // exact immutable connection id or remain unknown; borrowing another gateway's list price lies.
      if (scopedProvider.startsWith('custom:')) {
        return undefined;
      }
    }
    const price = lookupPrice(this.prices, this.keys, model);
    return price ? { price, source: 'list' } : undefined;
  }

  /** Estimated USD cost for a turn, or undefined when the model isn't in the table. */
  /**
   * @param cachedInputTokens the part of `inputTokens` the provider served from its prefix cache — a SUBSET,
   *   not an addition. Undefined = the gateway reported nothing, so we price the old way (everything a miss)
   *   rather than inventing a discount we cannot prove.
   *
   * Pricing every input token as a cache miss overstated the bill by up to ~10x. Inside an agentic loop the
   * prefix is stable and append-only, so most of iterations 2..N are cache hits: a Kilo session on the same
   * gateway reported 235.7K fresh input against 3.1M cached (~93% hit rate). Cost is our headline pitch — we
   * were making our own product look an order of magnitude more expensive than it is.
   */
  estimate(
    model: string,
    inputTokens: number,
    outputTokens: number,
    providerId?: string,
    cachedInputTokens?: number
  ): number | undefined {
    const p = this.priceFor(model, providerId);
    if (!p) {
      return undefined;
    }
    const cached = Math.min(Math.max(cachedInputTokens ?? 0, 0), inputTokens);
    const fresh = inputTokens - cached;
    // NO DISCOUNT UNLESS THE PRICE TABLE STATES ONE. See the note on `cachedInput` — the rate that governs
    // the user's bill is the GATEWAY's, not the upstream model's, and a stock new-api bills cache hits at
    // full price for every model missing from its table (which includes every model we ship on).
    const cachedRate = p.cachedInput ?? p.input;
    return (fresh / 1_000_000) * p.input
      + (cached / 1_000_000) * cachedRate
      + (outputTokens / 1_000_000) * p.output;
  }
}

function normalizeProvider(providerId: string | undefined): string | undefined {
  const value = providerId?.trim().toLowerCase();
  return value || undefined;
}

function lookupPrice(prices: Record<string, ModelPrice>, keys: string[], model: string): ModelPrice | undefined {
  if (prices[model]) {
    return prices[model];
  }
  // Substring match handles variants (`grok-4-fast`, dated suffixes), but must NOT cross a version number:
  // `grok-4` is a substring of `grok-4.5`, yet they are different models with different prices. Reject a
  // match whose key is immediately followed by a version continuation (`.` or a digit), so grok-4.5 (and
  // gpt-5.6 vs gpt-5, etc.) falls through to an explicitly labelled unknown rather than borrowing the older
  // version's price.
  const key = keys.find((k) => {
    const idx = model.indexOf(k);
    if (idx < 0) {
      return false;
    }
    const after = model[idx + k.length];
    return !(after === '.' || (after >= '0' && after <= '9'));
  });
  return key ? prices[key] : undefined;
}
