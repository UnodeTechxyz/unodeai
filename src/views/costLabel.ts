/*---------------------------------------------------------------------------------------------
 *  UnodeAi - one wording for a session's spend (v0.9.108 S2)
 *
 *  A stopped turn says it was partial, a subscription says it is one, and usage that was never observed is
 *  named as unknown: no surface shows $0 or leaves the cost blank for it.
 *--------------------------------------------------------------------------------------------*/

export interface SessionCostFacts {
  costUsd: number;
  turns: number;
  costBasis?: 'billed' | 'api-equivalent' | 'estimated' | 'mixed';
  /** A stopped turn contributed only the usage seen before it stopped. */
  partial?: boolean;
  /** Turns that made a provider request but whose usage was never reported. */
  unknownTurns?: number;
  /** The agent runs on a subscription CLI (Codex), which reports no per-turn amount of its own. */
  subscription?: boolean;
}

export const API_EQUIVALENT_COST_TITLE =
  'API-equivalent cost. This is a pricing estimate for subscription-authenticated CLI usage, not a billed per-token invoice.';
export const SUBSCRIPTION_NO_AMOUNT_TITLE =
  'Usage runs on a subscription. No per-turn amount was reported and no API-equivalent price is known for this model.';
export const UNKNOWN_COST_TITLE =
  'Cost basis has not been observed for a completed turn, so UnodeAi does not display $0 as if it were a bill.';
export const ESTIMATED_COST_TITLE =
  'Estimated cost from a labelled price source (an account, user-configured or reference price), not a provider bill. See Dashboard → Spend for the source and date.';
export const MIXED_COST_TITLE =
  'This agent has turns with different cost bases (or an unpriced turn); the total is approximate. See Dashboard → Spend for separate rows.';
export const PARTIAL_COST_TITLE =
  'A stopped turn is included with only the usage reported before it stopped. The amount is an estimate, not a bill. See Dashboard → Spend.';
export const PARTIAL_UNKNOWN_COST_TITLE =
  'A stopped turn reported usage before it stopped, but no price is known for it, so no amount is shown. See Dashboard → Spend for its tokens.';
export const UNREPORTED_USAGE_TITLE =
  'At least one turn made a provider request whose usage was never reported. It is not counted as $0. See Dashboard → Spend for coverage gaps.';

/**
 * The label and tooltip for a session's cost. `digits` is the number of decimals of an amount; `plainSuffix` follows
 * a plain billed or estimated amount only.
 */
export function sessionCostLabel(facts: SessionCostFacts, digits = 4, plainSuffix = ''): { label: string; title?: string } {
  const amount = (prefix: string) => `${prefix}$${facts.costUsd.toFixed(digits)}`;
  const unknown = facts.unknownTurns ?? 0;
  const known = facts.turns > 0;
  const withUnknown = (result: { label: string; title?: string }) => !unknown ? result
    : { label: `${result.label} + ${unknown} ${unknown === 1 ? 'turn' : 'turns'} usage unknown`, title: [result.title, UNREPORTED_USAGE_TITLE].filter(Boolean).join(' ') };
  if (!known) return unknown ? { label: 'Usage not reported, cost unknown', title: UNREPORTED_USAGE_TITLE } : { label: 'cost unknown', title: UNKNOWN_COST_TITLE };
  if (facts.costBasis === 'api-equivalent' || (facts.subscription && !facts.costBasis)) {
    // A stopped subscription turn says both: it was partial, and it is a subscription.
    const priced = facts.costBasis === 'api-equivalent';
    const subscription = priced ? `subscription (API-equivalent ${amount('~')})` : 'subscription, no per-turn amount';
    const title = priced ? API_EQUIVALENT_COST_TITLE : SUBSCRIPTION_NO_AMOUNT_TITLE;
    return withUnknown(facts.partial ? { label: `Partial usage, ${subscription}`, title: `${PARTIAL_COST_TITLE} ${title}` }
      : { label: subscription[0].toUpperCase() + subscription.slice(1), title });
  }
  if (facts.partial) return withUnknown(facts.costBasis
    ? { label: `Partial usage ${amount('~')}`, title: PARTIAL_COST_TITLE }
    : { label: 'Usage recorded, cost unknown', title: PARTIAL_UNKNOWN_COST_TITLE });
  if (!facts.costBasis) return withUnknown({ label: 'cost unknown', title: UNKNOWN_COST_TITLE });
  if (facts.costBasis === 'billed') return withUnknown({ label: amount('') + plainSuffix });
  return withUnknown({ label: amount('~') + plainSuffix, title: facts.costBasis === 'mixed' ? MIXED_COST_TITLE : ESTIMATED_COST_TITLE });
}
