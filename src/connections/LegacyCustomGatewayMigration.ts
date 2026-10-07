/*
 * Pure planning for the retired singleton `custom` connection. This module is the only production
 * location that recognizes that legacy identity. It performs no I/O, SecretStorage read, profile
 * mutation, roster write, or network request; the extension host supplies trusted inputs and asks
 * the user to confirm its returned preview before applying it.
 */

import type { AgentConfig } from '../types';
import { AGENT_ROUTE_VERSION, requireHttpsCustomEndpoint } from '../routes/RouteContracts';
import type { CustomGatewayConnectionId } from './CustomGatewayProfile';
import { customGatewayDisplayNameKey } from './CustomGatewayProfile';

export const LEGACY_CUSTOM_PROVIDER_ID = 'custom';
export const LEGACY_CUSTOM_SECRET_NAME = 'CUSTOM_API_KEY';
/** Persisted team-file marker for a legacy member that has no usable model and cannot receive a route. */
export const LEGACY_CUSTOM_MISSING_MODEL_REPAIR = 'missing-model';

export interface LegacyCustomGatewayMigrationEntry {
  connectionId: CustomGatewayConnectionId;
  secretRef?: string;
  displayName: string;
  endpointBase: string;
  legacySecretName: string;
  agentIds: readonly string[];
}

export interface LegacyCustomGatewayRepair {
  agentId: string;
  /** Trusted migrations persist a closed opaque id; untrusted planning deliberately leaves it absent. */
  connectionId?: CustomGatewayConnectionId;
  reason: string;
}

export interface LegacyCustomGatewayMigrationPlan {
  schemaVersion: 1;
  trusted: boolean;
  entries: readonly LegacyCustomGatewayMigrationEntry[];
  repairs: readonly LegacyCustomGatewayRepair[];
}

export interface LegacyCustomGatewayMigrationInput {
  trusted: boolean;
  agents: readonly AgentConfig[];
  legacyGlobalEndpoint?: string;
  /** Names of legacy SecretStorage entries that were found by the trusted host. Never key values. */
  legacySecretNamesWithValues?: ReadonlySet<string>;
  /** Existing display names ensure preview names are valid before the user confirms. */
  reservedDisplayNames?: readonly string[];
  /** Host-generated 32-character opaque values. It is never derived from endpoint/name/model data. */
  nextOpaqueId: () => string;
}

/** Legacy singleton identity is input-only and must never be returned by a new route/provider. */
export function isLegacySingletonCustomAgent(config: Pick<AgentConfig, 'provider' | 'route'>): boolean {
  // workspaceState is unvalidated: a corrupted non-string providerId must not reach String#trim (`?.` guards
  // null/undefined, not type) or this predicate — called throughout activation before the apiKeySecretName
  // guard — throws and aborts activation. Same C3b class as the secret-name containment.
  const providerId = config.provider?.providerId;
  if (typeof providerId === 'string' && providerId.trim().toLowerCase() === LEGACY_CUSTOM_PROVIDER_ID) {
    return true;
  }
  return (config.route as { connectionId?: unknown } | undefined)?.connectionId === LEGACY_CUSTOM_PROVIDER_ID;
}

/** Runtime guard for workspaceState-sourced legacy data; a non-string must never reach String#trim. */
export function hasMalformedLegacyCustomSecretName(config: Pick<AgentConfig, 'provider'>): boolean {
  const secretName = config.provider?.apiKeySecretName;
  return secretName !== undefined && typeof secretName !== 'string';
}

/** The only legacy secret name the trusted host may look up after validating its runtime type. */
export function legacyCustomSecretName(config: Pick<AgentConfig, 'provider'>): string {
  const secretName = config.provider?.apiKeySecretName;
  return typeof secretName === 'string' && secretName.trim() ? secretName.trim() : LEGACY_CUSTOM_SECRET_NAME;
}

/** A legacy agent without a usable model can only remain a visible repair, never a runnable route. */
export function isModelLessLegacyCustomAgent(config: Pick<AgentConfig, 'provider' | 'route' | 'model'>): boolean {
  return isLegacySingletonCustomAgent(config) && (typeof config.model !== 'string' || !config.model.trim());
}

/** True only when every remaining legacy member is a previously declared terminal model repair. */
export function hasOnlyTerminalLegacyCustomRepairs(
  agents: readonly AgentConfig[],
  repairAgentIds: ReadonlySet<string>,
): boolean {
  const remaining = agents.filter(isLegacySingletonCustomAgent);
  return remaining.length > 0 && remaining.every((agent) =>
    repairAgentIds.has(agent.id) && isModelLessLegacyCustomAgent(agent)
  );
}

/** Leave already-declared model-less repairs visible, but do not reopen their completed migration. */
export function pendingLegacyCustomMigrationAgents(
  agents: readonly AgentConfig[],
  terminalRepairAgentIds: ReadonlySet<string>,
): AgentConfig[] {
  return agents.filter((agent) =>
    !(terminalRepairAgentIds.has(agent.id) && isModelLessLegacyCustomAgent(agent))
  );
}

/**
 * Produce a host-reviewable migration preview. Endpoint equality is used only to group this one
 * preview; it never reuses an existing profile and never becomes an identity after application.
 */
export function planLegacyCustomGatewayMigration(input: LegacyCustomGatewayMigrationInput): LegacyCustomGatewayMigrationPlan {
  const legacyAgents = input.agents.filter(isLegacySingletonCustomAgent);
  if (!input.trusted) {
    return {
      schemaVersion: 1,
      trusted: false,
      entries: [],
      repairs: legacyAgents.map((agent) => ({
        agentId: agent.id,
        reason: 'This workspace is untrusted. Trust it, then review the legacy custom gateway migration before this agent can run.',
      })),
    };
  }

  const secretNamesWithValues = input.legacySecretNamesWithValues ?? new Set<string>();
  const displayNameKeys = new Set((input.reservedDisplayNames ?? []).map(customGatewayDisplayNameKey));
  const groups = new Map<string, {
    endpointBase: string;
    legacySecretName: string;
    agentIds: string[];
  }>();
  const repairs: LegacyCustomGatewayRepair[] = [];

  for (const agent of legacyAgents) {
    if (hasMalformedLegacyCustomSecretName(agent)) {
      repairs.push({
        agentId: agent.id,
        connectionId: nextConnectionId(input),
        reason: 'Legacy custom route has an invalid credential reference. Choose a configured custom gateway while repairing this agent.',
      });
      continue;
    }
    if (isModelLessLegacyCustomAgent(agent)) {
      repairs.push({ agentId: agent.id, connectionId: nextConnectionId(input), reason: 'Legacy custom route has no model id. Choose a model while repairing this agent.' });
      continue;
    }
    const configuredEndpoint = typeof agent.baseUrl === 'string' && agent.baseUrl.trim()
      ? agent.baseUrl
      : input.legacyGlobalEndpoint;
    let endpointBase: string;
    try {
      endpointBase = requireHttpsCustomEndpoint(configuredEndpoint ?? '');
    } catch {
      repairs.push({
        agentId: agent.id,
        connectionId: nextConnectionId(input),
        reason: 'Legacy custom route has no valid HTTPS endpoint. Choose a configured custom gateway while repairing this agent.',
      });
      continue;
    }
    const secretName = legacyCustomSecretName(agent);
    const groupKey = `${endpointBase}\u0000${secretName}`;
    const group = groups.get(groupKey) ?? { endpointBase, legacySecretName: secretName, agentIds: [] };
    group.agentIds.push(agent.id);
    groups.set(groupKey, group);
  }

  const entries: LegacyCustomGatewayMigrationEntry[] = [];
  for (const group of groups.values()) {
    const connectionId = nextConnectionId(input);
    const hasLegacyKey = secretNamesWithValues.has(group.legacySecretName);
    const secretRef = hasLegacyKey ? `custom-gateway:${connectionId.slice('custom:'.length)}:${nextOpaque(input)}` : undefined;
    const displayName = nextDisplayName(displayNameKeys);
    entries.push({
      connectionId,
      ...(secretRef === undefined ? {} : { secretRef }),
      displayName,
      endpointBase: group.endpointBase,
      legacySecretName: group.legacySecretName,
      agentIds: Object.freeze([...group.agentIds]),
    });
  }
  return {
    schemaVersion: 1,
    trusted: true,
    entries: Object.freeze(entries),
    repairs: Object.freeze(repairs),
  };
}

/** Apply a confirmed plan without retaining the legacy endpoint or credential identity in the roster. */
export function applyLegacyCustomGatewayMigration(
  agents: readonly AgentConfig[],
  plan: LegacyCustomGatewayMigrationPlan,
): AgentConfig[] {
  const entriesByAgentId = new Map<string, LegacyCustomGatewayMigrationEntry>();
  for (const entry of plan.entries) {
    for (const agentId of entry.agentIds) {
      entriesByAgentId.set(agentId, entry);
    }
  }
  const repairsByAgentId = new Map(plan.repairs.map((repair) => [repair.agentId, repair]));
  return agents.map((agent) => {
    const entry = entriesByAgentId.get(agent.id);
    if (entry) {
      return {
        ...agent,
        route: {
          routeVersion: AGENT_ROUTE_VERSION,
          kind: 'openai-compatible',
          connectionId: entry.connectionId,
          modelId: agent.model,
        },
        provider: { providerId: entry.connectionId, apiKeySecretName: entry.secretRef ?? '' },
        backend: 'openai-compat',
        baseUrl: undefined,
        routeRepair: entry.secretRef === undefined
          ? `Custom gateway "${entry.connectionId}" was migrated without an API key. Set a key before starting this agent.`
          : undefined,
      };
    }
    const repair = repairsByAgentId.get(agent.id);
    if (repair?.connectionId && typeof agent.model === 'string' && agent.model.trim()) {
      return {
        ...agent,
        route: {
          routeVersion: AGENT_ROUTE_VERSION,
          kind: 'openai-compatible',
          connectionId: repair.connectionId,
          modelId: agent.model,
        },
        provider: { providerId: repair.connectionId, apiKeySecretName: '' },
        backend: 'openai-compat',
        baseUrl: undefined,
        routeRepair: repair.reason,
      };
    }
    return agent;
  });
}

function nextConnectionId(input: LegacyCustomGatewayMigrationInput): CustomGatewayConnectionId {
  return `custom:${nextOpaque(input)}` as CustomGatewayConnectionId;
}

function nextOpaque(input: LegacyCustomGatewayMigrationInput): string {
  const value = input.nextOpaqueId();
  if (!/^[a-f0-9]{32}$/.test(value)) {
    throw new Error('Legacy custom gateway migration id generator returned an invalid opaque id.');
  }
  return value;
}

function nextDisplayName(reserved: Set<string>): string {
  for (let index = 1; index <= 10_000; index += 1) {
    const value = `Migrated gateway ${index}`;
    const key = customGatewayDisplayNameKey(value);
    if (!reserved.has(key)) {
      reserved.add(key);
      return value;
    }
  }
  throw new Error('Unable to allocate a unique legacy custom gateway display name.');
}
