import type { AgentBackendKind } from '../types';

/** No CLI or model backend starts merely because an agent is selected, restored, or activated. */
export function shouldPrewarmBackend(_backend: AgentBackendKind): boolean {
  return false;
}
