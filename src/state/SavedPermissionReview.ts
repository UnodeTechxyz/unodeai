import type { AgentConfig } from '../types';
import type { TeamLibraryScope } from './TeamLibrary';
import { ROLE_TEMPLATES, SKILL_LIBRARY } from '../roles/RoleConfig';
import { SkillResolver } from '../roles/SkillResolver';

/**
 * Capability ids an unrecognised project save may offer for an explicit, unticked review.
 *
 * Pre-0.9.87 team files did not persist `skills`, but they did retain the primary `skill` id and usually
 * the role-template key. Recover that declaration without granting it: the caller still has to show an
 * unticked choice, and the final tools are capped to the file's saved `allowedTools`.
 */
export function savedPermissionSkillIds(member: AgentConfig): string[] {
  const declared = (member.skills ?? []).map((skill) => skill.id).filter((id) => !!SKILL_LIBRARY[id]);
  if (declared.length > 0) return [...new Set(declared)];

  const template = member.roleTemplateKey ? ROLE_TEMPLATES[member.roleTemplateKey] : undefined;
  // Old saves predate `skills`. Keep their surviving primary declaration, but also offer the role's
  // remaining capabilities for an explicit unticked review. The caller still intersects their tools with
  // the exact saved ceiling, so a role-template change cannot widen the old file's authority.
  const primary = member.skill && SKILL_LIBRARY[member.skill] ? [member.skill] : [];
  const templateSkills = (template?.skills ?? []).map((skill) => skill.id).filter((id) => !!SKILL_LIBRARY[id]);
  return [...new Set([...primary, ...templateSkills])];
}

/** Resulting capabilities after the user ticks skills from an old file; never wider than its saved ceiling. */
export function savedPermissionTools(member: AgentConfig, selectedSkillIds: readonly string[]): string[] {
  const savedCeiling = new Set(member.allowedTools ?? []);
  const resolver = new SkillResolver(SKILL_LIBRARY);
  return resolver.allowedToolsForIds([...selectedSkillIds]).filter((tool) => savedCeiling.has(tool));
}

/** The final load notice must not call a partially restored team read-only. */
export function savedPermissionLoadResult(loadedReadOnly: boolean, regainedPermissionAgents: number): string {
  if (regainedPermissionAgents > 0) {
    return `${regainedPermissionAgents} agent(s) regained selected permissions.`;
  }
  return loadedReadOnly ? 'The team is read-only.' : '';
}

/** Any project file not recognised by this installation stays subject to an explicit unticked review. */
export function shouldReviewSavedPermissions(scope: TeamLibraryScope, fingerprintMatched: boolean): boolean {
  return scope === 'workspace' && !fingerprintMatched;
}

/**
 * Remove only permission declarations handled by the separate review. Other fields on the same warning
 * must remain visible (for example `skills, env, backend` still reports `env, backend`).
 */
export function filterReviewedPermissionWarnings(warnings: readonly string[]): string[] {
  const handled = new Set(['skills', 'playbooks']);
  return warnings.flatMap((warning) => {
    if (warning.includes('allowedTools ignored widening values:')) return [];
    const match = /^(.*?ignored host-only fields:\s*)([^.]+)(\..*)$/.exec(warning);
    if (!match) return [warning];
    const remaining = match[2].split(',').map((field) => field.trim()).filter((field) => !handled.has(field));
    return remaining.length > 0 ? [`${match[1]}${remaining.join(', ')}${match[3]}`] : [];
  });
}
