import { SessionStatus } from '../types';

/** True when an Agent Builder edit must rebuild the live backend to pick up config changes. */
export function shouldRestartAfterAgentConfigEdit(status: SessionStatus): boolean {
  return status === 'idle' || status === 'running';
}
