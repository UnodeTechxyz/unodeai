/*---------------------------------------------------------------------------------------------
 *  UnodeAi - coordinator brief consent decision
 *  Pure: decides whether a cross-destination coordinator brief needs a visible per-dispatch approval.
 *--------------------------------------------------------------------------------------------*/

export type CoordinatorBriefConsentDecision =
  | { kind: 'allow'; basis: 'same-destination' | 'user-setting' }
  | { kind: 'ask' }
  | { kind: 'refuse'; reason: string };

/** The user-level setting. Application-scoped, so a repository's own settings file cannot flip it. */
export const ALLOW_CROSS_PROVIDER_DISPATCH_SETTING = 'allowCrossProviderDispatchWithoutApproval';
export const ALLOW_CROSS_PROVIDER_DISPATCH_DEFAULT = true;

export const UNRESOLVED_BRIEF_DESTINATION_REASON =
  'The host could not resolve the coordinator and worker destinations for brief consent; no attempt was created.';

/**
 * The setting skips the dialog; it never skips resolution. An unresolvable destination still refuses, because
 * "send to another provider without asking" is a decision about a known destination, and an unknown one is not
 * a destination anyone agreed to in advance.
 *
 * `basis` separates the two silent allows so the host can record the one that happened only because of the
 * setting — a send nobody clicked should still leave a trace of why it went.
 */
export function decideCoordinatorBriefConsent(input: {
  sourceKey: string | undefined;
  destinationKey: string | undefined;
  allowCrossProviderWithoutApproval: boolean;
}): CoordinatorBriefConsentDecision {
  if (!input.sourceKey || !input.destinationKey) {
    return { kind: 'refuse', reason: UNRESOLVED_BRIEF_DESTINATION_REASON };
  }
  if (input.sourceKey === input.destinationKey) return { kind: 'allow', basis: 'same-destination' };
  return input.allowCrossProviderWithoutApproval ? { kind: 'allow', basis: 'user-setting' } : { kind: 'ask' };
}
