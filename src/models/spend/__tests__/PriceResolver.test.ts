import { describe, expect, it } from 'vitest';
import { catalogFromNewApiPricing } from '../PriceCatalog';
import {
  gatewayCandidates,
  gatewaySnapshotFromPricing,
  pinPrice,
  priceUsage,
  PriceCandidate,
  userOverrideCandidate,
} from '../PriceResolver';

const pricing = {
  group_ratio: { default: 1, eco: 0.5, vip: 1.5 },
  usable_group: { default: 'Default', eco: 'ECO' },
  data: [{ model_name: 'm1', quota_type: 0, model_ratio: 1, completion_ratio: 2 }],
};
const now = Date.parse('2026-09-28T00:00:00.000Z');
const unode = catalogFromNewApiPricing(pricing, { provider: 'unode', capturedAt: '2026-09-27T00:00:00.000Z', sourceUrl: 'https://u.example/api/pricing' });
const roam = catalogFromNewApiPricing({ data: [{ model_name: 'm1', quota_type: 0, model_ratio: 3, completion_ratio: 1 }] },
  { provider: 'roam', capturedAt: '2026-09-27T00:00:00.000Z', sourceUrl: 'https://r.example/api/pricing' });
const catalogs = { unode, roam };
const tokens = { input: 1_000_000, output: 1_000_000, basis: 'reported' as const };

function snapshot(extra: Partial<Parameters<typeof gatewaySnapshotFromPricing>[1]> = {}, body: unknown = pricing) {
  return gatewaySnapshotFromPricing(body, { sourceId: 'snap-1', connectionId: 'unode', capturedAt: '2026-09-28T00:00:00.000Z', authenticated: true, ...extra });
}

describe('source order and reminder eligibility', () => {
  it('uses a user exact-model override before any account or reference price', () => {
    const override = userOverrideCandidate({ M1: { input: 0.5, output: 1 } }, 'm1')!;
    const pin = pinPrice({ route: 'gateway', modelId: 'm1', routeCandidates: [...gatewayCandidates(snapshot(), 'm1', { coefficient: 0.3 }), override], referenceMode: 'unselected', catalogs, now });
    expect(pin.display?.basis).toBe('user-model-override');
    expect(priceUsage(pin, tokens).reminderValue).toEqual({ tokens: 2_000_000, nanoUsd: '1500000000', basis: 'exact-route' });
  });

  it('keeps a legacy substring override display-only', () => {
    const fuzzy = userOverrideCandidate({ m: { input: 9, output: 9 } }, 'm1');
    expect(fuzzy).toBeUndefined(); // "m" is followed by a digit: a version boundary, never matched.
    const approx = userOverrideCandidate({ 'model-x': { input: 9, output: 9 } }, 'vendor/model-x-fast')!;
    expect(approx.displayOnly).toBe(true);
    const pin = pinPrice({ route: 'gateway', modelId: 'vendor/model-x-fast', routeCandidates: [approx], referenceMode: 'unselected', catalogs, now });
    expect(pin.display?.sourceId).toBe('user-model-prices-approximate');
    expect(priceUsage(pin, tokens).reminderValue.basis).toBe('reported-tokens');
  });

  it('applies exactly one discount: an explicit coefficient replaces the group ratio', () => {
    const candidates = gatewayCandidates(snapshot(), 'm1', { coefficient: 0.5, group: 'vip' });
    expect(candidates.map((c) => c.basis)).toEqual(['gateway-published', 'account-coefficient']);
    const coefficient = candidates.find((c) => c.basis === 'account-coefficient')!;
    expect(coefficient.rates.input).toBe(1_000_000_000n); // $2/M list x 0.5; never x 1.5 as well
  });

  it('uses an explicit group only when it exists in this snapshot', () => {
    expect(gatewayCandidates(snapshot(), 'm1', { group: 'eco' }).map((c) => c.basis)).toEqual(['gateway-published', 'account-group']);
    expect(gatewayCandidates(snapshot(), 'm1', { group: 'gold' }).map((c) => c.basis)).toEqual(['gateway-published']);
  });

  it('never turns a public usable_group list, or an Authorization header, into an account price', () => {
    const candidates = gatewayCandidates(snapshot(), 'm1', {});
    expect(candidates.map((c) => c.basis)).toEqual(['gateway-published']);
    const pin = pinPrice({ route: 'gateway', modelId: 'm1', routeCandidates: candidates, referenceMode: 'unselected', catalogs, now });
    expect(pin.display?.basis).toBe('gateway-published');
    expect(pin.reminder).toBeUndefined();
    expect(priceUsage(pin, tokens).reminderValue).toEqual({ tokens: 2_000_000, basis: 'reported-tokens' });
  });

  it('accepts only a response that binds a group to the presented credential', () => {
    const bound = { ...pricing, applied_group: 'eco', applied_group_scope: 'credential' };
    expect(gatewayCandidates(snapshot({}, bound), 'm1', {}).map((c) => c.basis)).toEqual(['gateway-published', 'authenticated-account']);
    expect(gatewayCandidates(snapshot({ authenticated: false }, bound), 'm1', {}).map((c) => c.basis)).toEqual(['gateway-published']);
  });

  it('keeps a stale account snapshot display-only', () => {
    const candidates = gatewayCandidates(snapshot({ fresh: false }), 'm1', { coefficient: 0.5 });
    const pin = pinPrice({ route: 'gateway', modelId: 'm1', routeCandidates: candidates, referenceMode: 'unselected', catalogs, now });
    expect(pin.display?.stale).toBe(true);
    expect(pin.reminder).toBeUndefined();
  });

  it('distinguishes unselected, token-only and an explicit reference choice', () => {
    const base = { route: 'gateway' as const, modelId: 'm1', routeCandidates: [] as PriceCandidate[], catalogs, now };
    const unselected = pinPrice({ ...base, referenceMode: 'unselected' });
    expect(unselected.display?.basis).toBe('unode-reference');
    expect(unselected.reminder).toBeUndefined();
    const tokenOnly = pinPrice({ ...base, referenceMode: 'token-only' });
    expect(tokenOnly.display?.basis).toBe('unode-reference');
    expect(tokenOnly.reminder).toBeUndefined();
    const chosenUnode = pinPrice({ ...base, referenceMode: 'unode' });
    expect(priceUsage(chosenUnode, tokens).reminderValue.basis).toBe('selected-reference');
    const chosenRoam = pinPrice({ ...base, referenceMode: 'roam' });
    expect(chosenRoam.display?.basis).toBe('roam-reference');
    expect(priceUsage(chosenRoam, tokens).reminderValue.nanoUsd).toBe('12000000000');
  });

  it('lets an account price win over a selected reference automatically', () => {
    const pin = pinPrice({ route: 'gateway', modelId: 'm1', routeCandidates: gatewayCandidates(snapshot(), 'm1', { coefficient: 1 }), referenceMode: 'roam', catalogs, now });
    expect(pin.display?.basis).toBe('account-coefficient');
    expect(pin.reminder?.basis).toBe('account-coefficient');
  });

  it('shows tokens and an unavailable price for an unknown model', () => {
    const pin = pinPrice({ route: 'gateway', modelId: 'nope', routeCandidates: [], referenceMode: 'unode', catalogs, now });
    expect(priceUsage(pin, tokens)).toEqual({ displayCost: { basis: 'unavailable' }, reminderValue: { tokens: 2_000_000, basis: 'reported-tokens' } });
  });
});

describe('billed, subscription and non-reported usage', () => {
  const pin = pinPrice({ route: 'gateway', modelId: 'm1', routeCandidates: [], referenceMode: 'unode', catalogs, now });

  it('prefers a billed amount and rounds it down', () => {
    expect(priceUsage(pin, tokens, { costUsd: 0.0123456789, costBasis: 'billed' })).toEqual({
      displayCost: { nanoUsd: '12345678', basis: 'billed', sourceId: 'provider-billed' },
      reminderValue: { tokens: 2_000_000, nanoUsd: '12345678', basis: 'billed' },
    });
  });

  it('never gives partial or reconstructed usage reminder authority', () => {
    expect(priceUsage(pin, { ...tokens, basis: 'reported-partial' }).reminderValue).toEqual({ basis: 'not-eligible' });
    expect(priceUsage(pin, { ...tokens, basis: 'reconstructed' }, { costUsd: 5, costBasis: 'billed' }).reminderValue).toEqual({ basis: 'not-eligible' });
  });

  it('shows subscription dollars as API-equivalent only', () => {
    const subscription = pinPrice({ route: 'subscription', modelId: 'm1', routeCandidates: [], referenceMode: 'roam', catalogs, now });
    const priced = priceUsage(subscription, tokens);
    expect(priced.displayCost).toMatchObject({ basis: 'api-equivalent', sourceId: roam.catalogId });
    expect(priced.reminderValue).toEqual({ tokens: 2_000_000, basis: 'reported-tokens' });
    const reported = priceUsage(subscription, tokens, { costUsd: 1, costBasis: 'api-equivalent' });
    expect(reported.displayCost).toMatchObject({ basis: 'api-equivalent', nanoUsd: '1000000000' });
    expect(reported.reminderValue.nanoUsd).toBeUndefined();
  });

  it('shows tokens only for a subscription model missing from the reference', () => {
    const subscription = pinPrice({ route: 'subscription', modelId: 'gpt-x', routeCandidates: [], referenceMode: 'unode', catalogs, now });
    expect(priceUsage(subscription, tokens).displayCost).toEqual({ basis: 'unavailable' });
  });
});
