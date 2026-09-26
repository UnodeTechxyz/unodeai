/*---------------------------------------------------------------------------------------------
 *  UnodeAi - SkillResolver
 *  Turns a set of skills into the concrete capability tokens an agent is allowed to use.
 *
 *  This is what makes a Skill a *capability declaration* instead of a label: a role lists its
 *  skills, and `allowedTools` is derived from them rather than hand-maintained. The output
 *  vocabulary is the high-level capability tokens consumed elsewhere:
 *    'read' | 'write' | 'execute' | 'search' | 'delegate' | 'message'
 *  (WorkspaceTools maps these to read_file/list_dir/write_file/run_command; 'delegate' gates
 *  TeamTools/PM delegation.) — NOT low-level function names.
 *--------------------------------------------------------------------------------------------*/

import { AgentConfig, AgentSkill } from '../types';
import { McpServerGrant } from '../mcp/MCPHub';

export class SkillResolver {
  constructor(private library: Record<string, AgentSkill>) {}

  /**
   * Capability tokens granted by these skills, de-duplicated. `builtin` skills contribute their
   * tokens directly; `composite` skills expand recursively (cycle-safe). `mcp-server` skills
   * contribute MCP tools (段2), not capability tokens, so they add nothing here. Skills with no
   * `implementation` are legacy labels and contribute nothing.
   */
  resolveAllowedTools(skills: AgentSkill[]): string[] {
    const acc = new Set<string>();
    const seen = new Set<string>();

    const visit = (skill: AgentSkill | undefined): void => {
      if (!skill || seen.has(skill.id)) {
        return; // unknown skill or already visited (cycle / diamond) — stop.
      }
      seen.add(skill.id);

      const impl = skill.implementation;
      if (!impl) {
        return; // legacy label
      }
      if (impl.type === 'builtin') {
        for (const token of impl.tools) {
          acc.add(token);
        }
      } else if (impl.type === 'composite') {
        for (const id of impl.skillIds) {
          visit(this.library[id]);
        }
      }
      // 'mcp-server' intentionally contributes nothing to allowedTools.
    };

    for (const skill of skills) {
      visit(skill);
    }
    return [...acc];
  }

  /**
   * 段2: MCP server grants declared by these skills (recursively through composites). Each
   * `mcp-server` skill yields one grant carrying its tool filter. Capability-token skills yield
   * nothing here.
   */
  resolveMcpServerRefs(skills: AgentSkill[]): McpServerGrant[] {
    const grants: McpServerGrant[] = [];
    const seen = new Set<string>();
    const visit = (skill: AgentSkill | undefined): void => {
      if (!skill || seen.has(skill.id)) {
        return;
      }
      seen.add(skill.id);
      const impl = skill.implementation;
      if (!impl) {
        return;
      }
      if (impl.type === 'mcp-server') {
        grants.push({ serverId: impl.serverId, toolFilter: impl.toolFilter, toolList: impl.toolList });
      } else if (impl.type === 'composite') {
        impl.skillIds.forEach((id) => visit(this.library[id]));
      }
    };
    skills.forEach(visit);
    return grants;
  }

  /** Resolve a list of skill ids against the library, dropping unknown ids. */
  resolveByIds(ids: string[]): AgentSkill[] {
    return ids.map((id) => this.library[id]).filter((s): s is AgentSkill => Boolean(s));
  }

  /** Convenience: derive capability tokens straight from skill ids. */
  allowedToolsForIds(ids: string[]): string[] {
    return this.resolveAllowedTools(this.resolveByIds(ids));
  }
}

/**
 * 段2: the full set of MCP server grants an agent is authorized for — its `mcp-server` skills
 * plus its explicit `mcpServers` (as full-access grants). Default-deny: an agent with neither gets
 * an empty list. A skill-declared grant wins over an explicit one for the same server (the skill
 * may restrict the tool subset).
 */
export function agentMcpGrants(config: AgentConfig, resolver: SkillResolver): McpServerGrant[] {
  const fromSkills = resolver.resolveMcpServerRefs(config.skills ?? []);
  const explicit: McpServerGrant[] = (config.mcpServers ?? []).map((serverId) => ({
    serverId,
    toolFilter: 'all',
  }));
  const byId = new Map<string, McpServerGrant>();
  for (const grant of [...fromSkills, ...explicit]) {
    if (!byId.has(grant.serverId)) {
      byId.set(grant.serverId, grant);
    }
  }
  return [...byId.values()];
}
