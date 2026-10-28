/*---------------------------------------------------------------------------------------------
 *  UnodeAi - price source resolution and reminder eligibility (v0.9.89, design §3, §5)
 *
 *  Display cost takes the first available source in the design's order. Reminder dollars take the first
 *  ELIGIBLE source: billed, a user exact-model override, an exact account-route estimate, or a Unode/Roam
 *  reference the user explicitly selected. A published gateway list price, an API-equivalent subscription
 *  figure, a stale account estimate and anything reconstructed stay display-only.
 *--------------------------------------------------------------------------------------------*/

import { billedUsdToNano, costNano, NanoRates, nanoToString, scaleNano, TokenCounts } from './Money';
import {
  catalogIsStale,
  credentialBoundGroupFromPricing,
  groupRatiosFromNewApiPricing,
  lookupCatalogModel,
  PriceCatalogV1,
  ratesFromNewApiPricing,
  ReferenceProvider,
} from './PriceCatalog';
import type { CostBasis, DisplayCost, ReminderValue, TokenBasis } from './SpendTypes';

export type StoredReferencePriceMode = 'unselected' | 'unode' | 'roam' | 'token-only';

export function isStoredReferencePriceMode(value: unknown): value is StoredReferencePriceMode {
  return value === 'unselected' || value === 'unode' || value === 'roam' || value === 'token-only';
}

/** The dated catalog a mode displays: Unode until the user explicitly picks Roam. */
export function displayReferenceProvider(mode: StoredReferencePriceMode): ReferenceProvider {
  return mode === 'roam' ? 'roam' : 'unode';
}

/** Only an explicit Unode or Roam choice lets a reference figure drive a dollar reminder. */
export function reminderReferenceProvider(mode: StoredReferencePriceMode): ReferenceProvider | undefined {
  return mode === 'unode' || mode === 'roam' ? mode : undefined;
}

type RouteBasis = Exclude<CostBasis, 'billed' | 'api-equivalent' | 'unavailable'>;

/** One candidate price for an exact route/model, already computed by the host. */
export interface PriceCandidate {
  basis: RouteBasis;
  sourceId: string;
  sourceDate?: string;
  rates: NanoRates;
  /** A candidate that must stay display-only whatever its basis (a stale account estimate, a legacy fuzzy match). */
  displayOnly?: boolean;
  stale?: boolean;
}

/** The price pinned for one usage unit when it starts. Billed cost from the provider may replace it at the end. */
export interface PinnedPrice {
  route: 'gateway' | 'subscription';
  display?: PriceCandidate;
  reminder?: PriceCandidate;
  /** Subscription routes: the reference used for an API-equivalent figure. */
  apiEquivalent?: PriceCandidate;
}

const ACCOUNT_BASES: ReadonlySet<CostBasis> = new Set(['account-coefficient', 'account-group', 'authenticated-account']);
const EXACT_ROUTE_BASES: ReadonlySet<CostBasis> = new Set(['user-model-override', ...ACCOUNT_BASES]);

export function isAccountBasis(basis: CostBasis): boolean {
  return ACCOUNT_BASES.has(basis);
}

export function isExactRouteBasis(basis: CostBasis): boolean {
  return EXACT_ROUTE_BASES.has(basis);
}

export interface ReferenceCatalogs {
  unode?: PriceCatalogV1;
  roam?: PriceCatalogV1;
}

export function referenceCandidate(
  catalogs: ReferenceCatalogs,
  provider: ReferenceProvider,
  modelId: string,
  now: number,
): PriceCandidate | undefined {
  const catalog = catalogs[provider];
  if (!catalog) return undefined;
  const row = lookupCatalogModel(catalog, modelId);
  if (!row) return undefined;
  const stale = catalogIsStale(catalog, now);
  return {
    basis: provider === 'unode' ? 'unode-reference' : 'roam-reference',
    sourceId: catalog.catalogId,
    sourceDate: catalog.capturedAt,
    rates: row.rates,
    ...(stale ? { stale: true } : {}),
  };
}

export interface PinInputs {
  route: 'gateway' | 'subscription';
  modelId: string;
  /** Items 2–6, best first, as the host found them for this exact connection and credential generation. */
  routeCandidates: PriceCandidate[];
  referenceMode: StoredReferencePriceMode;
  catalogs: ReferenceCatalogs;
  now: number;
}

/**
 * Choose the display source and the reminder source for one usage unit (design §5.1 order). Subscription
 * routes display an API-equivalent reference figure and never get a dollar reminder source.
 */
export function pinPrice(input: PinInputs): PinnedPrice {
  if (input.route === 'subscription') {
    const apiEquivalent = referenceCandidate(input.catalogs, displayReferenceProvider(input.referenceMode), input.modelId, input.now);
    return { route: 'subscription', ...(apiEquivalent ? { apiEquivalent } : {}) };
  }
  const ordered = [...input.routeCandidates].sort((a, b) => ROUTE_ORDER[a.basis] - ROUTE_ORDER[b.basis]);
  const displayReference = referenceCandidate(input.catalogs, displayReferenceProvider(input.referenceMode), input.modelId, input.now);
  const selectedProvider = reminderReferenceProvider(input.referenceMode);
  const selectedReference = selectedProvider
    ? referenceCandidate(input.catalogs, selectedProvider, input.modelId, input.now)
    : undefined;
  const display = ordered[0] ?? displayReference;
  const reminder = ordered.find((candidate) => !candidate.displayOnly && isExactRouteBasis(candidate.basis))
    ?? selectedReference;
  return { route: 'gateway', ...(display ? { display } : {}), ...(reminder ? { reminder } : {}) };
}

const ROUTE_ORDER: Record<RouteBasis, number> = {
  'user-model-override': 2,
  'account-coefficient': 3,
  'account-group': 4,
  'authenticated-account': 5,
  'gateway-published': 6,
  'unode-reference': 7,
  'roam-reference': 7,
};

/** Whether the pinned price gives a dollar reminder source (billed cost may still supply one at the end). */
export function pinHasReminderDollars(pin: PinnedPrice): boolean {
  return !!pin.reminder;
}

export interface PricedUsage {
  displayCost: DisplayCost;
  reminderValue: ReminderValue;
}

function displayFrom(candidate: PriceCandidate, nano: bigint, basisOverride?: Exclude<CostBasis, 'unavailable'>): DisplayCost {
  return {
    nanoUsd: nanoToString(nano),
    basis: basisOverride ?? candidate.basis,
    sourceId: candidate.sourceId,
    ...(candidate.sourceDate ? { sourceDate: candidate.sourceDate } : {}),
    ...(candidate.stale ? { stale: true as const } : {}),
  };
}

/**
 * Price one usage figure against a pin. Only `reported` tokens carry reminder authority; billed cost counts only
 * when it is `billed` (not an API-equivalent figure) and valid. Every amount rounds down.
 */
export function priceUsage(
  pin: PinnedPrice,
  tokens: TokenCounts & { basis: TokenBasis },
  reported?: { costUsd?: number; costBasis?: 'billed' | 'api-equivalent' },
): PricedUsage {
  const eligibleTokens = tokens.basis === 'reported';
  const tokenTotal = Math.max(0, Math.floor(tokens.input)) + Math.max(0, Math.floor(tokens.output));
  const billedNano = reported?.costBasis !== 'api-equivalent' && reported?.costUsd !== undefined
    ? billedUsdToNano(reported.costUsd)
    : undefined;
  const apiEquivalentNano = reported?.costBasis === 'api-equivalent' && reported.costUsd !== undefined
    ? billedUsdToNano(reported.costUsd)
    : undefined;

  if (billedNano !== undefined) {
    return {
      displayCost: { nanoUsd: nanoToString(billedNano), basis: 'billed', sourceId: 'provider-billed' },
      reminderValue: eligibleTokens
        ? { tokens: tokenTotal, nanoUsd: nanoToString(billedNano), basis: 'billed' }
        : { basis: 'not-eligible' },
    };
  }

  if (pin.route === 'subscription') {
    const displayCost: DisplayCost = apiEquivalentNano !== undefined
      ? { nanoUsd: nanoToString(apiEquivalentNano), basis: 'api-equivalent', sourceId: 'provider-reported' }
      : pin.apiEquivalent
        ? displayFrom(pin.apiEquivalent, costNano(tokens, pin.apiEquivalent.rates), 'api-equivalent')
        : { basis: 'unavailable' };
    return {
      displayCost,
      reminderValue: eligibleTokens ? { tokens: tokenTotal, basis: 'reported-tokens' } : { basis: 'not-eligible' },
    };
  }

  const displayCost: DisplayCost = pin.display
    ? displayFrom(pin.display, costNano(tokens, pin.display.rates))
    : { basis: 'unavailable' };
  if (!eligibleTokens) {
    return { displayCost, reminderValue: { basis: 'not-eligible' } };
  }
  if (pin.reminder) {
    return {
      displayCost,
      reminderValue: {
        tokens: tokenTotal,
        nanoUsd: nanoToString(costNano(tokens, pin.reminder.rates)),
        basis: isExactRouteBasis(pin.reminder.basis) ? 'exact-route' : 'selected-reference',
      },
    };
  }
  return { displayCost, reminderValue: { tokens: tokenTotal, basis: 'reported-tokens' } };
}

/** The user-facing label for a cost basis (design §5.1). */
export function costBasisLabel(basis: CostBasis, connectionName?: string): string {
  switch (basis) {
    case 'billed': return 'billed by the provider';
    case 'user-model-override': return 'user-configured model price';
    case 'account-coefficient':
    case 'account-group':
    case 'authenticated-account':
      return connectionName ? `${connectionName} account estimate` : 'account estimate';
    case 'gateway-published': return 'gateway published estimate';
    case 'unode-reference': return 'Unode reference estimate';
    case 'roam-reference': return 'Roam reference estimate';
    case 'api-equivalent': return 'API-equivalent (subscription)';
    case 'unavailable': return 'price unavailable';
  }
}

// ─── Candidate builders (pure; the host supplies settings and snapshots) ──────────

function usdPerMillionToNano(value: unknown): bigint | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? billedUsdToNano(value) : undefined;
}

/**
 * `unode.modelPrices`: a user-owned model price. An exact id (case-insensitive) is a user assertion and is
 * reminder-eligible; a legacy substring match is shown for compatibility but stays display-only (design §5.2).
 */
export function userOverrideCandidate(raw: unknown, modelId: string): PriceCandidate | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const table = raw as Record<string, unknown>;
  const wanted = modelId.trim().toLowerCase();
  if (!wanted) return undefined;
  const rates = (entry: unknown): NanoRates | undefined => {
    if (!entry || typeof entry !== 'object') return undefined;
    const price = entry as { input?: unknown; output?: unknown; cachedInput?: unknown };
    const input = usdPerMillionToNano(price.input);
    const output = usdPerMillionToNano(price.output);
    if (input === undefined || output === undefined) return undefined;
    const cachedInput = price.cachedInput === undefined ? undefined : usdPerMillionToNano(price.cachedInput);
    return { input, output, ...(cachedInput !== undefined ? { cachedInput } : {}) };
  };
  const exactKey = Object.keys(table).find((key) => key.trim().toLowerCase() === wanted);
  if (exactKey) {
    const exact = rates(table[exactKey]);
    return exact ? { basis: 'user-model-override', sourceId: 'user-model-prices', rates: exact } : undefined;
  }
  // The pre-v0.9.89 table matched the longest key contained in the id, stopping at a version boundary.
  const fuzzyKey = Object.keys(table)
    .filter((key) => {
      const k = key.trim().toLowerCase();
      const at = k ? wanted.indexOf(k) : -1;
      if (at < 0) return false;
      const after = wanted[at + k.length];
      return !(after === '.' || (after !== undefined && after >= '0' && after <= '9'));
    })
    .sort((a, b) => b.length - a.length)[0];
  const fuzzy = fuzzyKey ? rates(table[fuzzyKey]) : undefined;
  return fuzzy ? { basis: 'user-model-override', sourceId: 'user-model-prices-approximate', rates: fuzzy, displayOnly: true } : undefined;
}

/** One gateway's anonymous-or-keyed price snapshot, normalized. Rates are before any group ratio. */
export interface GatewayPriceSnapshot {
  sourceId: string;
  connectionId: string;
  capturedAt: string;
  /** Rows with no group ratio applied (the publisher's own vendor/row discount included). */
  baseRows: Array<{ modelId: string; rates: NanoRates }>;
  /** group -> ratio, exactly as published (decimal strings). */
  groupRatios: Record<string, string>;
  /** A group the gateway's response explicitly bound to the presented credential (design §5.1 item 5). */
  credentialBoundGroup?: string;
  /** False once the metadata TTL has passed and a refresh failed. */
  fresh: boolean;
  /** The request carried this connection's key. Without one, a stated coefficient or group is dormant. */
  authenticated: boolean;
}

function scaleRates(rates: NanoRates, ratio: unknown): NanoRates | undefined {
  const scale = (value: bigint) => scaleNano(value, ratio);
  const input = scale(rates.input);
  const output = scale(rates.output);
  if (input === undefined || output === undefined) return undefined;
  const cachedInput = rates.cachedInput === undefined ? undefined : scale(rates.cachedInput);
  return { input, output, ...(cachedInput !== undefined ? { cachedInput } : {}) };
}

function validRatio(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
}

/**
 * Route candidates from one gateway snapshot (design §5.2). Exactly one discount basis applies: an explicit
 * coefficient replaces any group ratio; otherwise an explicit group must exist in this snapshot; otherwise only a
 * group the response bound to the credential. The published figure is the default group's list price.
 */
export function gatewayCandidates(
  snapshot: GatewayPriceSnapshot,
  modelId: string,
  stated: { coefficient?: number; group?: string },
): PriceCandidate[] {
  const wanted = modelId.trim().toLowerCase();
  const row = snapshot.baseRows.find((candidate) => candidate.modelId === modelId.trim())
    ?? snapshot.baseRows.find((candidate) => candidate.modelId.toLowerCase() === wanted);
  if (!row) return [];
  const defaultRatio = validRatio(snapshot.groupRatios.default) ? snapshot.groupRatios.default : '1';
  const published = scaleRates(row.rates, defaultRatio);
  const common = {
    sourceDate: snapshot.capturedAt,
    ...(snapshot.fresh ? {} : { displayOnly: true, stale: true }),
  };
  const out: PriceCandidate[] = [];
  if (published) {
    out.push({ basis: 'gateway-published', sourceId: `${snapshot.sourceId}:published`, rates: published, ...common });
  }
  const coefficient = stated.coefficient;
  if (typeof coefficient === 'number' && Number.isFinite(coefficient) && coefficient >= 0 && published) {
    const rates = scaleRates(published, coefficient);
    if (rates) out.push({ basis: 'account-coefficient', sourceId: `${snapshot.sourceId}:coefficient`, rates, ...common });
    return out;
  }
  const group = stated.group?.trim();
  if (group) {
    const ratio = Object.prototype.hasOwnProperty.call(snapshot.groupRatios, group) ? snapshot.groupRatios[group] : undefined;
    const rates = validRatio(ratio) ? scaleRates(row.rates, ratio) : undefined;
    if (rates) out.push({ basis: 'account-group', sourceId: `${snapshot.sourceId}:group`, rates, ...common });
    return out;
  }
  const bound = snapshot.credentialBoundGroup;
  if (bound && Object.prototype.hasOwnProperty.call(snapshot.groupRatios, bound)) {
    const rates = validRatio(snapshot.groupRatios[bound]) ? scaleRates(row.rates, snapshot.groupRatios[bound]) : undefined;
    if (rates) out.push({ basis: 'authenticated-account', sourceId: `${snapshot.sourceId}:bound`, rates, ...common });
  }
  return out;
}

/** Normalize a gateway `/api/pricing` body into a snapshot. The credential-bound group counts only when a key was sent. */
export function gatewaySnapshotFromPricing(
  body: unknown,
  meta: { sourceId: string; connectionId: string; capturedAt: string; authenticated: boolean; fresh?: boolean },
): GatewayPriceSnapshot {
  const bound = meta.authenticated ? credentialBoundGroupFromPricing(body) : undefined;
  return {
    sourceId: meta.sourceId,
    connectionId: meta.connectionId,
    capturedAt: meta.capturedAt,
    baseRows: ratesFromNewApiPricing(body, { applyDefaultGroup: false }).map((row) => ({
      modelId: row.modelId,
      rates: {
        input: BigInt(row.inputNanoUsdPerMillion),
        output: BigInt(row.outputNanoUsdPerMillion),
        ...(row.cachedInputNanoUsdPerMillion !== undefined ? { cachedInput: BigInt(row.cachedInputNanoUsdPerMillion) } : {}),
      },
    })),
    groupRatios: groupRatiosFromNewApiPricing(body),
    ...(bound ? { credentialBoundGroup: bound } : {}),
    fresh: meta.fresh !== false,
    authenticated: meta.authenticated,
  };
}
