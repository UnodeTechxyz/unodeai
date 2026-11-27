/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Marketplace role-template projection
 *  ROLE_TEMPLATES is the single source used by both Create a team and Marketplace.
 *--------------------------------------------------------------------------------------------*/

import { ROLE_TEMPLATES } from '../roles/RoleConfig';
import { AgentCatalogEntry } from './catalog';

/** Frozen reconciliation for the retired 13-entry marketplace/agents.json catalog. */
export const LEGACY_AGENT_CATALOG_TEMPLATE_MAP: Readonly<Record<string, string>> = {
  'security-auditor': 'security',
  'api-designer': 'backend-api-engineer',
  'test-engineer': 'tester',
  'performance-optimizer': 'performance-engineer',
  'devops-engineer': 'devops',
  'technical-writer': 'tech-writer',
  'hermes-operator': 'workflow-automation-specialist',
  'data-engineer': 'data-engineer',
  debugger: 'senior-dev',
  'code-reviewer': 'reviewer',
  'frontend-developer': 'frontend-engineer',
  'backend-developer': 'backend-api-engineer',
  'qa-analyst': 'tester',
};

/** Project the live shipped templates into Marketplace cards without creating a second catalog. */
export function roleTemplateCatalogEntries(): AgentCatalogEntry[] {
  return Object.entries(ROLE_TEMPLATES).map(([key, template]) => ({
    id: key,
    roleTemplateKey: key,
    name: template.name,
    role: template.role,
    summary: template.description ?? `Create an agent from the ${template.name} role template.`,
    icon: template.icon,
    color: template.color,
    skills: template.skills.map((skill) => skill.id),
    model: template.model,
    tier: template.tier,
    systemPrompt: template.systemPrompt,
    modelParams: template.modelParams ? { ...template.modelParams } : undefined,
  }));
}

/** The equality gate is intentionally exposed so tests compare the two product surfaces by key. */
export function roleTemplateCatalogKeys(): string[] {
  return roleTemplateCatalogEntries().map((entry) => entry.id).sort();
}
