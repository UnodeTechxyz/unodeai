import { resolveOpenAICompatBaseUrl } from '../backend/openAICompatBaseUrl';
import {
  BUILTIN_CONNECTION_REGISTRY,
  ConnectionResolver,
  connectionIdForProviderId,
  connectionProfile,
} from '../routes/ConnectionRegistry';

/**
 * The live /models request uses the same endpoint authority as a model turn. In particular, an
 * untrusted picker message or persisted agent baseUrl cannot make a registered provider send its
 * stored API key to another host. Dynamic custom connections are resolved by their immutable
 * connection id, not a caller-provided endpoint.
 */
export function resolveModelCatalogBaseUrl(
  providerKey: string,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): string | undefined {
  const connectionId = connectionIdForProviderId(providerKey, resolver);
  const profile = connectionId ? connectionProfile(connectionId, resolver) : undefined;
  if (!profile || profile.kind !== 'openai-compatible') {
    return undefined;
  }
  return resolveOpenAICompatBaseUrl(
    { routeVersion: 1, kind: 'openai-compatible', connectionId: profile.id, modelId: 'catalog' },
    resolver,
  );
}
