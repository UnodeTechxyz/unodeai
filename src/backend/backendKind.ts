import { AgentConfig, AgentBackendKind } from '../types';
import {
  BUILTIN_CONNECTION_REGISTRY,
  ConnectionResolver,
  connectionIdForProviderId,
  connectionProfile,
  defaultBackendForProviderId,
  isSupportedProviderOrConnectionId,
} from '../routes/ConnectionRegistry';

/**
 * Providers that speak the OpenAI-compatible HTTP API run in-process (openai-compat backend);
 * everything else goes through the Claude headless CLI. **Add every new OpenAI-compatible provider
 * here** — otherwise Add Agent silently routes it to the Claude backend and skips the endpoint/model
 * picker (this is exactly how OpenRouter regressed in v0.2.29). The resolver is supplied by the
 * host so a newly added custom connection is visible without an extension reload.
 */
export function isSupportedProviderId(
  providerId: string,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): boolean {
  return isSupportedProviderOrConnectionId(providerId, resolver);
}

/** Returns the API key for an API-key connection; CLI-account connections have none to request. */
export function apiKeySecretNameForProvider(
  providerId: string,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): string | undefined {
  const connectionId = connectionIdForProviderId(providerId, resolver);
  const profile = connectionId ? connectionProfile(connectionId, resolver) : undefined;
  return profile?.authKind === 'api-key' ? profile.apiKeySecretName : undefined;
}

/**
 * Whether this agent's runtime can tell the host how full its context is.
 *
 * Only the in-process OpenAI-compatible backend builds the request the host measures. The CLI runtimes own
 * their own context, so the honest answer for them is "not mine to report", never a zero or a blank.
 */
export function backendReportsContextWindow(
  config: Pick<AgentConfig, 'provider' | 'backend'>,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): boolean {
  const kind = config.backend ?? defaultBackendKind(config, resolver);
  return kind === 'openai-compat';
}

/** Default runtime for an agent when config.backend is unset. */
export function defaultBackendKind(
  config: Pick<AgentConfig, 'provider'>,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): AgentBackendKind {
  return defaultBackendForProviderId(config.provider.providerId, resolver) ?? 'claude';
}
