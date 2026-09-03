/*
 * v0.9.30 route migration.
 *
 * Persisted AgentRoute is the authority; legacy fields stay for one compatibility window because
 * older code and exports still read provider/baseUrl.  The conversion below never examines a
 * model id.  It either derives the one registered connection from legacy provider/backend fields
 * or refuses the record so the host can ask the user instead of silently changing a route.
 */

import type { AgentConfig } from '../types';
import {
  isLegacySingletonCustomAgent,
  isModelLessLegacyCustomAgent,
  LEGACY_CUSTOM_MISSING_MODEL_REPAIR,
} from '../connections/LegacyCustomGatewayMigration';
import {
  BUILTIN_CONNECTION_REGISTRY,
  ConnectionResolver,
  agentRouteFromLegacyConfig,
  connectionProfile,
  providerRefForConnectionId,
} from './ConnectionRegistry';
import { assertAgentRoute, type AgentRoute } from './RouteContracts';

export type MigratedAgentConfig = {
  config: AgentConfig;
  changed: boolean;
};

export class RouteMigrationError extends Error {
  constructor(public readonly agentId: string, message: string) {
    super(`Agent "${agentId || '(unnamed)'}" needs route repair: ${message}`);
  }
}

/**
 * The on-disk team-file format writes its route as the single connection/model authority. Older
 * in-memory call sites still need these compatibility fields, so reconstruct them only after the
 * registered route has been validated. This never reconstructs a credential value: API-key
 * connection rows contain only a SecretStorage key name and CLI rows contain a placeholder.
 */
export function legacyFieldsForRoute(
  route: AgentRoute,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): Pick<AgentConfig, 'provider' | 'model' | 'backend'> {
  const profile = connectionProfile(route.connectionId, resolver);
  const provider = providerRefForConnectionId(route.connectionId, resolver);
  if (!profile || !provider) {
    throw new Error(`route connection "${route.connectionId}" is not registered.`);
  }
  return {
    // An active API-key profile may intentionally have no key after Clear key/recovery. Hydrate an
    // empty compatibility value so the agent is visible and non-runnable, rather than inventing a
    // different secret identity or discarding it during import.
    provider,
    model: route.modelId,
    backend: profile.backendKind,
  };
}

/**
 * The one-way export form for versionable team files. `provider`, `model`, and `backend` were
 * legacy parallel authorities; retaining them in a new export invites a hand edit to make the
 * fields disagree. They are hydrated from `route` only when the file is read.
 */
export type VersionedAgentConfig =
  | (Omit<AgentConfig, 'provider' | 'model' | 'backend' | 'baseUrl' | 'routeRepair'> & { route: AgentRoute })
  | (Omit<AgentConfig, 'provider' | 'model' | 'backend' | 'baseUrl' | 'routeRepair'> & { legacyCustomRepair: typeof LEGACY_CUSTOM_MISSING_MODEL_REPAIR });

export function exportVersionedAgentConfig(
  config: AgentConfig,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): VersionedAgentConfig {
  if (config.routeRepair && !config.route && isModelLessLegacyCustomAgent(config)) {
    const { provider: _provider, model: _model, backend: _backend, baseUrl: _baseUrl, routeRepair: _routeRepair, ...versioned } = config;
    return { ...versioned, legacyCustomRepair: LEGACY_CUSTOM_MISSING_MODEL_REPAIR } as VersionedAgentConfig;
  }
  if (config.routeRepair && config.route) {
    assertRepairableCustomRoute(config.route);
    const { provider: _provider, model: _model, backend: _backend, baseUrl: _baseUrl, routeRepair: _routeRepair, ...versioned } = config;
    return versioned as VersionedAgentConfig;
  }
  const normalized = migrateAgentConfig(config, resolver).config;
  if (!normalized.route) {
    throw new RouteMigrationError(normalized.id, 'versioned route was not produced.');
  }
  const { provider: _provider, model: _model, backend: _backend, baseUrl: _baseUrl, routeRepair: _routeRepair, ...versioned } = normalized;
  return versioned as VersionedAgentConfig;
}

/**
 * A repair record is never an alternate route authority. It can retain either an opaque custom id
 * or the exact retired singleton id needed to preserve a pre-migration v0.9.30 roster. Both forms
 * remain closed route objects and are rejected by normal registered-route resolution.
 */
export function assertRepairableCustomRoute(route: AgentRoute): void {
  const isRetiredSingleton = isLegacySingletonCustomAgent(
    { route } as Pick<AgentConfig, 'provider' | 'route'>,
  );
  if (
    route.kind !== 'openai-compatible' ||
    (!/^custom:[a-f0-9]{32}$/.test(route.connectionId) && !isRetiredSingleton)
  ) {
    throw new Error('Only a closed-shape opaque or retired singleton custom gateway route may be retained for repair.');
  }
}

/** Produce the canonical versioned route for a legacy or already-versioned config. */
export function migrateAgentConfig(
  config: AgentConfig,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): MigratedAgentConfig {
  let route: AgentRoute;
  try {
    route = agentRouteFromLegacyConfig(config, resolver);
  } catch (error) {
    throw new RouteMigrationError(config.id, error instanceof Error ? error.message : String(error));
  }
  let legacyFields: Pick<AgentConfig, 'provider' | 'model' | 'backend'>;
  try {
    legacyFields = legacyFieldsForRoute(route, resolver);
  } catch (error) {
    throw new RouteMigrationError(config.id, error instanceof Error ? error.message : String(error));
  }
  const normalized: AgentConfig = {
    ...config,
    route,
    ...legacyFields,
  };
  return { config: normalized, changed: !samePersistedRouteConfig(config, normalized) };
}

/**
 * Keep a closed opaque custom route visible when this machine does not have its local profile.
 * It is explicitly non-runnable and recomputed on every load, so a restored profile clears repair
 * state without trusting a persisted endpoint or secret reference.
 */
export function migrateAgentConfigOrRepair(
  config: AgentConfig,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): MigratedAgentConfig {
  const { routeRepair: _previousRepair, ...withoutPriorRepair } = config;
  // `custom` is intentionally not a registered connection. Keep it visible only as an in-memory
  // repair item until the trusted host migration creates an opaque custom:<id> profile; never
  // persist this repair, create a profile, or read a legacy key from this generic route boundary.
  if (isLegacySingletonCustomAgent(config)) {
    const repair = 'Legacy Custom gateway migration is required. Trust this workspace and review the host migration preview before starting this agent.';
    return {
      config: { ...withoutPriorRepair, routeRepair: repair } as AgentConfig,
      changed: false,
    };
  }
  try {
    const migrated = migrateAgentConfig(withoutPriorRepair as AgentConfig, resolver);
    const profile = migrated.config.route ? connectionProfile(migrated.config.route.connectionId, resolver) : undefined;
    // A custom profile without a generated secret ref is a valid durable state after Clear key or
    // a keyless legacy import, but it is never runnable and must not fall back to another key.
    if (profile?.id.startsWith('custom:') && profile.authKind === 'api-key' && !profile.apiKeySecretName) {
      const repair = `Custom gateway "${profile.id}" has no API key configured. Set a key before starting this agent.`;
      return { config: { ...migrated.config, routeRepair: repair }, changed: migrated.changed };
    }
    return migrated;
  } catch (error) {
    const route = config.route;
    try {
      assertAgentRoute(route);
      assertRepairableCustomRoute(route);
    } catch {
      throw error;
    }
    if (connectionProfile(route.connectionId, resolver)) {
      throw error;
    }
    const repair = `Custom gateway "${route.connectionId}" is unavailable on this machine. Repair or rebind this agent before starting it.`;
    const repairedConfig = {
      ...withoutPriorRepair,
      route,
      provider: { providerId: route.connectionId, apiKeySecretName: '' },
      model: route.modelId,
      backend: 'openai-compat',
      routeRepair: repair,
    } as AgentConfig;
    return {
      config: repairedConfig,
      // routeRepair is intentionally derived rather than persisted. Compare only the durable
      // route fields so a restored repair record does not rewrite the roster on every activation.
      changed: !samePersistedRouteConfig(config, repairedConfig),
    };
  }
}

/** Apply a user-initiated provider/model change: legacy fields become an explicit fresh route. */
export function migrateUpdatedLegacyFields(
  config: AgentConfig,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): MigratedAgentConfig {
  const withoutPriorRoute: AgentConfig = { ...config, route: undefined };
  return migrateAgentConfig(withoutPriorRoute, resolver);
}

/** Keep a persisted route authoritative when a user chooses a different model on the same connection. */
export function withRouteModel(config: AgentConfig, model: string): AgentConfig {
  if (!config.route || !model || config.route.modelId === model) {
    return config;
  }
  return { ...config, model, route: { ...config.route, modelId: model } } as AgentConfig;
}

function samePersistedRouteConfig(before: AgentConfig, after: AgentConfig): boolean {
  return JSON.stringify(before.route) === JSON.stringify(after.route)
    && before.provider?.providerId === after.provider.providerId
    && before.provider?.apiKeySecretName === after.provider.apiKeySecretName
    && before.model === after.model
    && before.backend === after.backend;
}
