import {
  BUILTIN_CONNECTION_REGISTRY,
  ConnectionResolver,
  connectionProfile,
} from '../routes/ConnectionRegistry';
import { canonicalEndpointBase, requireHttpsCustomEndpoint } from '../routes/RouteContracts';
import type { AgentRoute } from '../routes/RouteContracts';

export const OPENAI_COMPAT_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** Roam's own gateway (the default provider) is the weroam endpoint. */
export const ROAM_DEFAULT_BASE_URL = 'https://ai.weroam.xyz/v1';
/** Unode is a separate gateway provider (the previous Roam endpoint), kept for existing users. */
export const UNODE_DEFAULT_BASE_URL = 'https://www.unodetech.xyz/v1';

/**
 * Resolve the endpoint for a model-content request from the registered route, never from a
 * workspace agent record. This is a security boundary: every OpenAI-compatible connection,
 * including a dynamic custom:<opaque-id> profile, is pinned to its host-owned registry row before
 * an API key or prompt can reach the backend.
 */
export function resolveOpenAICompatBaseUrl(
  route: AgentRoute,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): string {
  if (route.kind !== 'openai-compatible') {
    throw new Error(`Route ${route.connectionId} is not an OpenAI-compatible connection.`);
  }
  const profile = connectionProfile(route.connectionId, resolver);
  if (!profile || profile.kind !== 'openai-compatible' || profile.backendKind !== 'openai-compat') {
    throw new Error(`OpenAI-compatible route names an unknown connection "${route.connectionId}".`);
  }
  const endpoint = profile.presentation.endpointDefault;
  if (!endpoint) {
    throw new Error(`Connection "${profile.id}" has no registered OpenAI-compatible endpoint.`);
  }
  return canonicalEndpointBase(endpoint);
}

export { requireHttpsCustomEndpoint };
