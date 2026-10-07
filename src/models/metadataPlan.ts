/*---------------------------------------------------------------------------------------------
 *  UnodeAi — Metadata access plan
 *
 *  ONE pure calculation of "which hosts is this user action about to contact, and for what?", shared by the
 *  consent prompt, the fetch enforcement, and the tests. It is not the security boundary — `consentGatedFetch`
 *  is, and it stays the final word. This is what makes the boundary ASKABLE without being rude.
 *
 *  It exists because the first version of the consent flow asked about `pricingSources()` — which always
 *  contains both default gateways — so opening the OpenAI model picker prompted for weroam, then unodetech,
 *  then openai. Three modals, two of them about hosts the action was never going to touch. A consent prompt
 *  that asks for more than the action needs trains the user to click through it, which is how you end up with
 *  consent that protects nobody.
 *
 *  The rule: ask about exactly the hosts this action will contact, once, with each host's real purposes.
 *--------------------------------------------------------------------------------------------*/

/** What a metadata request to a host is actually for. Each is disclosed to the user, verbatim. */
export type MetadataPurpose = 'models' | 'context-window' | 'catalog' | 'prices' | 'balance';

export interface MetadataHostPlan {
  host: string;
  /** Purposes this action will use this host for, deduplicated and ordered as listed above. */
  purposes: MetadataPurpose[];
  /** True when a stored API key will be attached to at least one of these requests. */
  authenticated: boolean;
}

const PURPOSE_ORDER: MetadataPurpose[] = ['models', 'context-window', 'catalog', 'prices', 'balance'];

/** One human sentence per purpose, for the consent prompt. Kept next to the type so they cannot drift. */
export const PURPOSE_LABEL: Record<MetadataPurpose, string> = {
  models: 'the list of models it can serve',
  'context-window': 'the context-window limit it advertises for those models',
  catalog: 'a curated model catalog',
  prices: 'its price list',
  balance: 'your account\'s discount tier and balance',
};

interface PlanInput {
  /** A URL this action will contact, or undefined/'' to skip it. */
  url?: string;
  purpose: MetadataPurpose;
  /** Whether a stored key is attached to THIS request. */
  authenticated?: boolean;
}

const hostOf = (url: string): string => {
  try { return new URL(url).host; } catch { return ''; }
};

/**
 * Collapse a list of intended requests into one entry per HOST, merging purposes.
 *
 * Deduplication by host is the point: on a gateway that serves models, prices and balance from the same
 * origin, the user must be asked ONCE, and told all three things — not asked three times, and not asked once
 * while being told only one of them.
 */
export function buildMetadataPlan(requests: PlanInput[]): MetadataHostPlan[] {
  const byHost = new Map<string, MetadataHostPlan>();
  for (const r of requests) {
    const host = hostOf(r.url ?? '');
    if (!host) { continue; } // no host ⇒ nothing to ask about, and consentGatedFetch will refuse it anyway
    const existing = byHost.get(host);
    if (existing) {
      if (!existing.purposes.includes(r.purpose)) { existing.purposes.push(r.purpose); }
      existing.authenticated ||= !!r.authenticated;
    } else {
      byHost.set(host, { host, purposes: [r.purpose], authenticated: !!r.authenticated });
    }
  }
  for (const p of byHost.values()) {
    p.purposes.sort((a, b) => PURPOSE_ORDER.indexOf(a) - PURPOSE_ORDER.indexOf(b));
  }
  return [...byHost.values()];
}

/**
 * The plan for opening ONE provider's model picker.
 *
 * `priceUrl` is the SELECTED provider's own price endpoint, or undefined when that provider has none (most
 * direct providers don't — their prices come from the built-in table). It is emphatically NOT
 * `pricingSources()`: another gateway's price list is not something this action needs, so it is not something
 * this action may ask for. Showing provider A's picker must never prompt for gateway B.
 */
export function planModelPicker(input: {
  endpointUrl?: string;
  catalogUrl?: string;
  priceUrl?: string;
  /** A key is stored for the selected provider (so the /models and price calls will carry it). */
  hasKey?: boolean;
}): MetadataHostPlan[] {
  return buildMetadataPlan([
    { url: input.endpointUrl, purpose: 'models', authenticated: input.hasKey },
    // The same user-initiated `/models` response may include the selected model's context window. This
    // is disclosed separately so consent never says "model list" while silently using more metadata from it.
    { url: input.endpointUrl, purpose: 'context-window', authenticated: input.hasKey },
    { url: input.catalogUrl, purpose: 'catalog' },             // a curated catalog is public; no key is sent
    { url: input.priceUrl, purpose: 'prices', authenticated: input.hasKey },
    ...(input.hasKey && input.priceUrl ? [{ url: input.priceUrl, purpose: 'balance' as const, authenticated: true }] : []),
  ]);
}

/** The plan for an explicit, all-gateway price refresh — the ONE action for which every price source is in scope. */
export function planPriceRefresh(
  sources: Array<{ url: string; apiKey?: string }>
): MetadataHostPlan[] {
  return buildMetadataPlan(sources.flatMap((s) => [
    { url: s.url, purpose: 'prices' as const, authenticated: !!s.apiKey },
    ...(s.apiKey ? [{ url: s.url, purpose: 'balance' as const, authenticated: true }] : []),
  ]));
}

/** The part of a plan the user has not already answered — the only part worth interrupting them for. */
export function unapprovedHosts(
  plan: MetadataHostPlan[],
  hasConsent: (host: string) => boolean
): MetadataHostPlan[] {
  return plan.filter((p) => !hasConsent(p.host));
}

/** "its price list, the list of models it can serve, and your account's discount tier and balance" */
export function describePurposes(p: MetadataHostPlan): string {
  const parts = p.purposes.map((x) => PURPOSE_LABEL[x]);
  if (parts.length === 1) { return parts[0]; }
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
