import type { SessionStatus } from '../types';

/**
 * A gateway's endpoint/key cannot change while a request may still use its captured connection
 * profile. Idle sessions have no request in flight; their revision guard will require a restart
 * before a later request if the profile changes.
 */
export function isCustomGatewayEditBlockedStatus(status: SessionStatus): boolean {
  return status === 'starting' || status === 'consent_required' || status === 'running' || status === 'stopping';
}
