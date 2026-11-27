import type { SessionStatus } from '../types';

/**
 * A gateway's endpoint/key cannot change while a request may still use its captured connection
 * profile. Idle sessions have no request in flight; their revision guard will require a restart
 * before a later request if the profile changes.
 */
export function isCustomGatewayEditBlockedStatus(status: SessionStatus): boolean {
  return status === 'starting' || status === 'consent_required' || status === 'running' || status === 'stopping';
}

export interface CustomGatewayTurnsPort {
  /** Agents on this gateway whose status is one of the statuses above. */
  busyAgentNames(): string[];
  /** Called on every agent status change; returns the unsubscribe. */
  onStatusChange(listener: () => void): () => void;
}

/**
 * v0.9.99: an endpoint or key edit made while an agent on this gateway is mid-turn is applied after that turn
 * instead of being refused ("Stop X, then edit this gateway"). Resolves at once when no agent is busy; otherwise
 * tells the person once and resolves at the first status change that leaves no agent busy (a Stop counts).
 */
export function whenCustomGatewayTurnsEnd(port: CustomGatewayTurnsPort, onWaiting: (agentNames: string[]) => void): Promise<void> {
  const busy = port.busyAgentNames();
  if (busy.length === 0) return Promise.resolve();
  try { onWaiting(busy); } catch { /* the notice is informational */ }
  return new Promise((resolve) => {
    let settled = false;
    const unsubscribe = port.onStatusChange(() => {
      if (settled || port.busyAgentNames().length > 0) return;
      settled = true;
      unsubscribe();
      resolve();
    });
  });
}
