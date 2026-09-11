/*
 * Capability compatibility is intentionally a pure, registry-backed boundary.  Webviews use the
 * same result to explain a limitation, but the host calls the assertion before it constructs a
 * backend so a forged message or hand-edited roster cannot enable a feature by bypassing the UI.
 */

import type { AgentConfig, AgentModelParams } from '../types';
import {
  BUILTIN_CONNECTION_REGISTRY,
  ConnectionResolver,
  connectionIdForProviderId,
  connectionProfile,
} from './ConnectionRegistry';
import type { ConnectionProfile, RuntimeCapabilities } from './RouteContracts';

export type CapabilityViolation = {
  capability: string;
  message: string;
};

const TOOL_CAPABILITIES: Readonly<Record<string, keyof RuntimeCapabilities>> = Object.freeze({
  read: 'read',
  search: 'read',
  write: 'write',
  execute: 'command',
  delegate: 'delegation',
});
const SAFE_TOOL_TOKENS = new Set(['message']);

export function supportedAllowedTools(
  capabilities: RuntimeCapabilities,
  tools: readonly string[],
): string[] {
  return tools.filter((tool) => {
    const capability = TOOL_CAPABILITIES[tool];
    return SAFE_TOOL_TOKENS.has(tool) || (capability !== undefined && capabilities[capability] === true);
  });
}

export function supportedModelParams(
  capabilities: Pick<RuntimeCapabilities, 'modelParams'>,
  params: AgentModelParams | undefined,
): AgentModelParams | undefined {
  const filtered = Object.fromEntries(
    Object.entries(params ?? {}).filter(([key]) => capabilities.modelParams.has(key))
  ) as AgentModelParams;
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

/** Resolve the one registry row that is authoritative for a persisted agent configuration. */
export function connectionProfileForAgent(
  config: Pick<AgentConfig, 'provider' | 'route'>,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): ConnectionProfile | undefined {
  const connectionId = config.route?.connectionId ?? connectionIdForProviderId(config.provider.providerId, resolver);
  return connectionId ? connectionProfile(connectionId, resolver) : undefined;
}

export function unsupportedModelParamKeys(
  capabilities: Pick<RuntimeCapabilities, 'modelParams'>,
  params: AgentModelParams | undefined,
): string[] {
  return Object.keys(params ?? {}).filter((key) => !capabilities.modelParams.has(key));
}

/**
 * Return every requested runtime effect the route cannot perform.  This does not mutate the config:
 * persistence callers can reject it visibly, and request callers can omit unsupported model fields.
 */
export function capabilityViolations(
  config: AgentConfig,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): CapabilityViolation[] {
  const profile = connectionProfileForAgent(config, resolver);
  if (!profile) {
    return [{ capability: 'connection', message: `Unknown connection "${config.provider.providerId}".` }];
  }
  const availabilityViolation = profile.availability !== 'available'
    ? [{ capability: 'availability', message: profile.availabilityMessage ?? `${profile.presentation.displayName} is not available in this release.` }]
    : [];
  const capabilities = profile.capabilities;
  const backend = config.backend ?? profile.backendKind;
  const toolViolations = (config.allowedTools ?? [])
    .flatMap((tool): CapabilityViolation[] => {
      const capability = TOOL_CAPABILITIES[tool];
      if (SAFE_TOOL_TOKENS.has(tool)) {
        return [];
      }
      if (!capability) {
        return [{ capability: 'tool', message: `Unknown requested tool "${tool}" was rejected.` }];
      }
      return capabilities[capability]
        ? []
        : [{ capability: String(capability), message: `${profile.presentation.displayName} does not support the requested ${tool} tool.` }];
    });
  const coordinatorViolation = config.role === 'pm' && !capabilities.coordinator
    ? [{ capability: 'coordinator', message: `${profile.presentation.displayName} cannot coordinate a team on this route.` }]
    : [];
  const mcpViolation = (config.mcpServers?.length ?? 0) > 0 && !capabilities.mcp
    ? [{ capability: 'mcp', message: `${profile.presentation.displayName} does not support MCP grants on this route.` }]
    : [];
  const skillViolation = ((config.skills?.length ?? 0) > 0 || (config.playbooks?.length ?? 0) > 0) && !capabilities.skills
    ? [{ capability: 'skills', message: `${profile.presentation.displayName} does not support UnodeAi skill or playbook grants on this route.` }]
    : [];
  const folderAccessViolation = (config.folderAccess?.length ?? 0) > 0 && !capabilities.folderAccess
    ? [{ capability: 'folderAccess', message: `${profile.presentation.displayName} does not support Folder Access confinement on this route.` }]
    : [];
  // `tier` (Smart Mode) and `toolProtocol` are INAPPLICABLE PREFERENCES on a route that doesn't use them,
  // not unsafe capabilities. A Claude Headless agent picks its own model via the CLI and uses Claude-native
  // tool calling, so a persisted Smart Mode tier or tool-protocol setting is simply IGNORED at runtime — it
  // must never hard-block start. (Blocking here left a legitimate Claude Headless PM stuck in STARTING when a
  // team/Smart-Mode config carried a tier.) The genuinely unsafe/broken-if-unsupported items below still
  // block: availability, backend, tools, coordinator, MCP/skill/folder-access grants.
  const backendViolation = backend !== profile.backendKind
    ? [{ capability: 'backend', message: `${profile.presentation.displayName} must use its registered ${profile.backendKind} backend.` }]
    : [];
  return [
    ...availabilityViolation,
    ...backendViolation,
    ...toolViolations,
    ...coordinatorViolation,
    ...mcpViolation,
    ...skillViolation,
    ...folderAccessViolation,
  ];
}

export function assertAgentCapabilityCompatibility(
  config: AgentConfig,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): void {
  const violations = capabilityViolations(config, resolver);
  if (violations.length > 0) {
    throw new Error(`Route capability rejected this agent: ${violations.map((v) => v.message).join(' ')}`);
  }
}

/** Team presets require a connection that can host the PM/coordinator role; no provider-name fallback. */
export function canCoordinateTeam(
  providerId: string,
  resolver: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY,
): boolean {
  const profile = connectionProfileForAgent(
    { provider: { providerId } } as Pick<AgentConfig, 'provider' | 'route'>,
    resolver,
  );
  return profile?.availability === 'available' && profile.capabilities.coordinator === true;
}
