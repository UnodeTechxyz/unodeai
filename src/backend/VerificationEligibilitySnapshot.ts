import type { VerificationBinding, VerificationPolicySource } from './CompletionVerificationPolicy';

/** Ephemeral host-owned configuration observation, never approval or a result that a check passed. */
export type VerificationEligibilitySnapshot =
  | { kind: 'ready'; source: VerificationPolicySource; binding: VerificationBinding; command: string }
  | { kind: 'disabled' | 'not-applicable'; source: VerificationPolicySource; binding: VerificationBinding }
  | { kind: 'configuration-invalid'; source: VerificationPolicySource }
  | { kind: 'restricted' | 'unavailable' };

export function verificationConfiguredFromSnapshot(snapshot: VerificationEligibilitySnapshot): boolean | undefined {
  if (snapshot.kind === 'ready') return true;
  if (snapshot.kind === 'disabled' || snapshot.kind === 'not-applicable') return false;
  return undefined;
}
