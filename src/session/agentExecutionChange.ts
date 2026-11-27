/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Whether an agent edit replaced what the agent runs on (v0.9.101, H2a audit H2a-1)
 *
 *  An edit that changes the agent's model or the connection it runs on (backend kind, route, endpoint, provider)
 *  replaces the coordinator a waiting request was waiting with: that work ends as "coordinator gone". A name, prompt,
 *  tool or folder edit is not such a change and leaves the waits alone.
 *--------------------------------------------------------------------------------------------*/
import type { AgentConfig } from '../types';

type ExecutionFields = Pick<AgentConfig, 'model' | 'backend' | 'route' | 'baseUrl' | 'provider'>;

export function agentExecutionChanged(prior: ExecutionFields, next: ExecutionFields, priorBackendKind: AgentConfig['backend']): boolean {
  return prior.model !== next.model
    || (prior.backend ?? priorBackendKind) !== next.backend
    || JSON.stringify(prior.route ?? null) !== JSON.stringify(next.route ?? null)
    || (prior.baseUrl ?? null) !== (next.baseUrl ?? null)
    || JSON.stringify(prior.provider ?? null) !== JSON.stringify(next.provider ?? null);
}
