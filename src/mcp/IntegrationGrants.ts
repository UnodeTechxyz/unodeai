import type { AgentConfig } from '../types';
import type { McpServerGrant } from './MCPHub';

export interface IntegrationGrantChange {
  agentId: string;
  granted: boolean;
}

export interface IntegrationGrantRepair {
  serverId: string;
  agentIds: string[];
}

/** Host-authored messages safe to show in the Marketplace. Storage errors may contain private data. */
export class IntegrationGrantError extends Error {}

export function withDirectIntegrationGrant<T extends { mcpServers?: string[] }>(
  member: T, serverId: string, granted: boolean,
): T {
  const current = member.mcpServers ?? [];
  if (current.includes(serverId) === granted) return member;
  const mcpServers = granted ? [...current, serverId] : current.filter(id => id !== serverId);
  return { ...member, mcpServers };
}

/** A failed direct edit narrows only the changed direct references. Independent skill grants still apply. */
export function restrictUnconfirmedIntegrationGrants(
  agent: AgentConfig, repairs: readonly IntegrationGrantRepair[],
): AgentConfig {
  return repairs.reduce((config, repair) => repair.agentIds.includes(config.id)
    ? withDirectIntegrationGrant(config, repair.serverId, false)
    : config, agent);
}

export function describeIntegrationSkillGrant(grant: McpServerGrant): string {
  const names = grant.toolList?.join(', ');
  const tools = grant.toolFilter === 'all' ? 'all tools'
    : grant.toolFilter === 'allowlist' ? names || 'no tools'
      : names ? `all tools except ${names}` : 'all tools';
  return `Skill grant (${tools}) · manage in Agent Builder`;
}

export function integrationGrantTiming(apiWithMcp: boolean, mounted: boolean): string {
  return apiWithMcp && mounted ? 'Available on the next request' : 'Available after the next start';
}
