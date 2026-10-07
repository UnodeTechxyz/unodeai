import { describe, it, expect } from 'vitest';
import {
  buildMetadataPlan, describePurposes, planModelPicker, planPriceRefresh, unapprovedHosts,
} from '../metadataPlan';

const ROAM = 'https://api.weroam.xyz/v1';
const UNODE = 'https://api.unodetech.xyz/v1';
const OPENAI = 'https://api.openai.com/v1';
const CATALOG = 'https://catalog.unodetech.xyz/models.json';

// The plan is what makes the consent gate ASKABLE without being rude. The first version asked about
// pricingSources() — which always holds both default gateways — so opening the OpenAI model picker prompted
// for weroam, then unodetech, then openai: three modals, two about hosts the action would never contact.
// A prompt that asks for more than the action needs teaches the user to click through it, and a consent the
// user clicks through protects nobody. (Codex, v0.9.29 metadata-consent UX review.)
describe('planModelPicker — ask about this provider, and nothing else', () => {
  it('an OpenAI picker never mentions the Roam or Unode gateways', () => {
    const plan = planModelPicker({ endpointUrl: OPENAI, hasKey: true }); // OpenAI has no price endpoint of ours
    expect(plan.map((p) => p.host)).toEqual(['api.openai.com']);
    expect(plan[0].purposes).toEqual(['models', 'context-window']);
    expect(plan[0].authenticated).toBe(true); // the /models call carries the stored key
  });

  it('includes a configured catalog host exactly once, as a CATALOG — never as a price list', () => {
    const plan = planModelPicker({ endpointUrl: OPENAI, catalogUrl: CATALOG });
    const catalog = plan.find((p) => p.host === 'catalog.unodetech.xyz')!;
    expect(catalog.purposes).toEqual(['catalog']);
    expect(catalog.purposes).not.toContain('prices');
    expect(catalog.authenticated).toBe(false); // a curated catalog is public; no key is sent
    expect(plan.filter((p) => p.host === 'catalog.unodetech.xyz')).toHaveLength(1);
  });

  it('DEDUPLICATES a gateway that serves models, prices and balance from one host — one question, all purposes', () => {
    const plan = planModelPicker({ endpointUrl: UNODE, priceUrl: UNODE, hasKey: true });
    expect(plan).toHaveLength(1);
    expect(plan[0].host).toBe('api.unodetech.xyz');
    expect(plan[0].purposes).toEqual(['models', 'context-window', 'prices', 'balance']); // asked once, told everything
    expect(describePurposes(plan[0]))
      .toBe('the list of models it can serve, the context-window limit it advertises for those models, its price list and your account\'s discount tier and balance');
  });

  it('omits BALANCE when no key is stored — we would not be able to ask for it, so we do not claim we might', () => {
    const plan = planModelPicker({ endpointUrl: UNODE, priceUrl: UNODE, hasKey: false });
    expect(plan[0].purposes).toEqual(['models', 'context-window', 'prices']);
    expect(plan[0].authenticated).toBe(false);
  });

  it('a picker with nothing configured asks nothing', () => {
    expect(planModelPicker({})).toEqual([]);
  });
});

describe('planPriceRefresh — the one action where every gateway is in scope', () => {
  it('covers every configured price source, in one reviewable plan', () => {
    const plan = planPriceRefresh([{ url: ROAM, apiKey: 'k' }, { url: UNODE }]);
    expect(plan.map((p) => p.host)).toEqual(['api.weroam.xyz', 'api.unodetech.xyz']);
    expect(plan[0].purposes).toEqual(['prices', 'balance']); // keyed ⇒ balance is in scope
    expect(plan[1].purposes).toEqual(['prices']);            // unkeyed ⇒ it is not
  });
});

describe('buildMetadataPlan', () => {
  it('drops a source whose URL has no host — there is nothing to ask about, and the fetch gate refuses it anyway', () => {
    expect(buildMetadataPlan([{ url: 'not a url', purpose: 'models' }, { url: '', purpose: 'prices' }])).toEqual([]);
  });

  it('one authenticated purpose makes the host authenticated — the prompt must not under-state the key', () => {
    const plan = buildMetadataPlan([
      { url: UNODE, purpose: 'catalog' },                       // no key
      { url: UNODE, purpose: 'prices', authenticated: true },   // key
    ]);
    expect(plan[0].authenticated).toBe(true);
  });
});

describe('unapprovedHosts — only interrupt for what has not been answered', () => {
  it('asks only about hosts with no existing grant', () => {
    const plan = planPriceRefresh([{ url: ROAM }, { url: UNODE }]);
    const pending = unapprovedHosts(plan, (h) => h === 'api.weroam.xyz');
    expect(pending.map((p) => p.host)).toEqual(['api.unodetech.xyz']);
  });

  it('a fully-approved plan interrupts nobody', () => {
    const plan = planPriceRefresh([{ url: ROAM }, { url: UNODE }]);
    expect(unapprovedHosts(plan, () => true)).toEqual([]);
  });
});
