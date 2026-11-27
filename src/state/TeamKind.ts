/** Shared classification used by Team Rules and completion verification. Not a role/authority inference. */
export type TeamRulesKind = 'software' | 'knowledge';

/** Keep in sync with the knowledge/business specialist presets in roles/RoleConfig. Their role is often custom,
 * so primary skill, not role/name, is the existing signal. It also controls the missing verification default. */
export const KNOWLEDGE_TEAM_SKILLS = [
  'business-analysis', 'market-research', 'financial-modeling', 'strategy',
  'content-marketing', 'growth-marketing', 'seo-analytics',
  'sales-development', 'sales-execution', 'sales-engineering', 'customer-success',
];

export function teamKindFromSkills(agentSkills: readonly string[]): TeamRulesKind {
  const known = new Set(KNOWLEDGE_TEAM_SKILLS);
  return agentSkills.some((skill) => known.has(skill)) ? 'knowledge' : 'software';
}
