/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Marketplace install converters
 *--------------------------------------------------------------------------------------------*/

import { AgentConfig, MCPServerConfig, ProviderRef } from '../types';
import { AgentCatalogEntry, McpCatalogEntry, SkillCatalogEntry } from './catalog';
import { AgentConfigBuilder, ROLE_TEMPLATES } from '../roles/RoleConfig';

/**
 * Pre-B0 builds once appended playbook bodies below a markdown heading. We no longer infer that
 * a literal heading belongs to us: it is valid user-authored instruction text, and saving must
 * never truncate it. Playbook ids are independently persisted on AgentConfig.
 */
export function stripPlaybooks(systemPrompt: string): string {
  return systemPrompt;
}

/**
 * Compatibility shim for Agent Builder saves. Playbook ids are stored on AgentConfig and loaded
 * progressively from extension-owned SKILL.md files, never copied into an agent prompt.
 */
export function applyPlaybooks(systemPrompt: string, _playbookIds: string[] | undefined, _catalog: SkillCatalogEntry[]): string {
  return stripPlaybooks(systemPrompt);
}

/**
 * Compatibility shim for marketplace installation and persisted pre-B0 prompts. The runtime skill
 * registry consumes AgentConfig.playbooks; this function only removes obsolete inline bodies.
 */
export function mountSkillPlaybooks(
  systemPrompt: string,
  _skillIds: string[] | undefined,
  _catalog: SkillCatalogEntry[]
): string {
  return stripPlaybooks(systemPrompt);
}

/**
 * Convert a marketplace agent preset into a runnable AgentConfig.
 *
 * v0.9.105 (S3): on the connection and model the host resolved for a new agent, as Add Agent and Create a team resolve
 * them: the default connection (`unode.defaultProvider`) and that connection's model for the role, with the template's
 * per-provider override. Until 0.9.105 every install went to Roam and dropped the override. The converter reads no
 * setting.
 */
export function toAgentConfig(entry: AgentCatalogEntry, opts: { name: string; provider: ProviderRef; model: string }): AgentConfig {
  const shippedTemplate = entry.roleTemplateKey ? ROLE_TEMPLATES[entry.roleTemplateKey] : undefined;
  const builder = new AgentConfigBuilder(entry.role);
  if (shippedTemplate) {
    builder.fromTemplate(entry.roleTemplateKey as keyof typeof ROLE_TEMPLATES);
  }
  builder
    .setName(opts.name)
    .setProviderRef(opts.provider)
    .setModel(opts.model)
    .setSystemPrompt(entry.systemPrompt)
    .setSkills(entry.skills)
    .setAutoApprove(false);
  const config = builder.build();
  const template = shippedTemplate ?? Object.values(ROLE_TEMPLATES).find((candidate) => candidate.role === entry.role);
  if (template?.playbooks) {
    config.playbooks = [...template.playbooks];
  }
  if (entry.icon) {
    config.icon = entry.icon;
  }
  if (entry.color) {
    config.color = entry.color;
  }
  if (entry.modelParams) {
    config.modelParams = { ...entry.modelParams };
  }
  // suggestedMcpServers is display-only. Adding a role cannot grant an integration.
  return config;
}

/** Convert a marketplace MCP entry into the MCPServerConfig the team registry consumes. */
export function toMcpServerConfig(entry: McpCatalogEntry): MCPServerConfig {
  const cfg: MCPServerConfig = {
    id: entry.id,
    name: entry.name,
    transport: entry.transport,
  };
  if (entry.command !== undefined) {
    cfg.command = entry.command;
  }
  if (entry.args !== undefined) {
    cfg.args = entry.args;
  }
  if (entry.url !== undefined) {
    cfg.url = entry.url;
  }
  if (entry.env !== undefined) {
    cfg.env = entry.env;
  }
  return cfg;
}
