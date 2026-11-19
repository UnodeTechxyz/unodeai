/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Request limit binding (v0.9.94)
 *
 *  The request boundary of one agent. A backend and a tool surface ask it without knowing a request id: it asks
 *  about the request that agent's running turn belongs to, read at the moment of the call, so one backend serves
 *  every request its agent ever works on. While a boundary is held for the person's decision, the wait is
 *  theirs, and the host is told so for exactly as long as the boundary is held.
 *
 *  VS Code-free: the gate, the turn's request and the wait accounting arrive as dependencies.
 *--------------------------------------------------------------------------------------------*/

import type { RequestBoundary, RequestBoundaryKind, RequestBoundaryOutcome } from '../backend/requestBoundary';

/** The part of the request ceiling a boundary asks. */
export interface RequestBoundaryGate {
  governs(requestId: string): boolean;
  wouldHold(requestId: string): boolean;
  /** `reserveFor` names the agent that makes one counted request right after this boundary. */
  boundary(requestId: string, kind: RequestBoundaryKind, signal?: AbortSignal, reserveFor?: string): Promise<RequestBoundaryOutcome>;
}

export interface RequestBoundaryBinding {
  /** The gate, or undefined when the host has none (it is shutting down): every boundary then proceeds. */
  gate(): RequestBoundaryGate | undefined;
  /** The request of the agent's running turn. Undefined when it runs none. */
  currentRequestId(agentId: string): string | undefined;
  /** Run a wait that is the person's: the agent's turn clock stands still for it. */
  personWait<T>(agentId: string, wait: () => Promise<T>): Promise<T>;
}

export function agentRequestBoundary(agentId: string, binding: RequestBoundaryBinding): RequestBoundary {
  return (kind, detail) => {
    const gate = binding.gate();
    const requestId = gate ? binding.currentRequestId(agentId) : undefined;
    // No limit on this request: the caller proceeds as if no boundary had been injected.
    if (!gate || !requestId || !gate.governs(requestId)) return Promise.resolve('proceed');
    // A model request that crosses is counted as it crosses, so a teammate asking at the same moment sees it.
    const reserveFor = kind === 'provider-request' ? agentId : undefined;
    const ask = (): Promise<RequestBoundaryOutcome> => gate.boundary(requestId, kind, detail?.signal, reserveFor);
    return gate.wouldHold(requestId) ? binding.personWait(agentId, ask) : ask();
  };
}
