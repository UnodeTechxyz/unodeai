import type { AgentConfig, AgentSkill } from '../types';

export type ResolveSkillMcpRefs = (skills: AgentSkill[]) => readonly { serverId: string }[];

/** Remove every persisted route by which an agent could regain this integration. */
export function withoutIntegrationGrant(
  config: AgentConfig,
  serverId: string,
  resolveSkillMcpRefs: ResolveSkillMcpRefs,
): AgentConfig {
  return {
    ...config,
    mcpServers: (config.mcpServers ?? []).filter((id) => id !== serverId),
    skills: (config.skills ?? []).filter((skill) =>
      !resolveSkillMcpRefs([skill]).some((grant) => grant.serverId === serverId)),
  };
}
