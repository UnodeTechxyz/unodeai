import type { AgentConfig, AgentSkill } from '../types';
import { ROLE_TEMPLATES } from '../roles/RoleConfig';
import { BUILTIN_TOOL_DEFAULTS_REVISION, isExecutePreference, type ExecutePreference } from '../roles/BuiltinToolDefaults';

/** Host-only restore context. Neither a form field nor proof obtained by parsing a file as host-owned. */
export interface SavedCommandPreference {
  roleKey: string;
  preference: ExecutePreference;
}

/** Caller must establish the existing global-library boundary or exact local path+byte fingerprint. */
export function savedCommandPreference(member: AgentConfig, sourceTrusted: boolean): SavedCommandPreference | undefined {
  return sourceTrusted && !!member.roleTemplateKey && Object.hasOwn(ROLE_TEMPLATES, member.roleTemplateKey)
    && isExecutePreference(member.executePreference)
    ? { roleKey: member.roleTemplateKey, preference: member.executePreference } : undefined;
}

/** The trusted preference may override only execute in the original saved ceiling. Nothing else widens. */
export function restoredCommandTools(tools: readonly string[], current: AgentConfig, preference?: SavedCommandPreference): string[] {
  const choice = preference && preference.roleKey === current.roleTemplateKey ? preference.preference : current.executePreference === 'deny' ? 'deny' : undefined;
  if (!choice) return [...tools];
  const result = new Set(tools);
  if (choice === 'deny') result.delete('execute');
  else if (choice === 'allow' || choice === 'template') result.add('execute');
  return [...result].sort();
}

/** The only fields a saved-team confirmation or unticked review is allowed to change on a loaded agent. */
export interface SavedPermissionRestoreSelection {
  skillIds: readonly string[];
  skills: readonly AgentSkill[];
  allowedTools: readonly string[];
  playbooks: readonly string[];
  backendKind: AgentConfig['backend'];
  commandPreference?: SavedCommandPreference;
}

export interface SavedPermissionRestoreAttempt {
  ok: boolean;
  message: string;
  granted: boolean;
}

/** Restore each member independently: one broken profile must not roll the team back to read-only. */
export async function restoreSavedPermissionsIndividually<T extends Pick<AgentConfig, 'name'>>(
  members: readonly T[],
  restore: (member: T) => Promise<SavedPermissionRestoreAttempt>,
): Promise<{ regainedPermissionAgents: number; failures: string[] }> {
  let regainedPermissionAgents = 0;
  const failures: string[] = [];
  for (const member of members) {
    try {
      const result = await restore(member);
      if (!result.ok) {
        failures.push(`${member.name}: ${result.message}`);
      } else if (result.granted) {
        regainedPermissionAgents++;
      }
    } catch (error) {
      failures.push(`${member.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { regainedPermissionAgents, failures };
}

/**
 * Apply an explicit saved-team permission choice without treating it as an Agent Builder edit.
 * This deliberately preserves model/route/prompt/folder settings, including legacy values which a newly
 * selected backend can no longer validate but which are not part of the user-confirmed permission grant.
 */
export function applySavedPermissionRestore(
  config: AgentConfig,
  selection: SavedPermissionRestoreSelection,
): void {
  if (selection.skillIds[0]) config.skill = selection.skillIds[0];
  config.skills = [...selection.skills];
  config.allowedTools = restoredCommandTools(selection.allowedTools, config, selection.commandPreference);
  if (selection.commandPreference && selection.commandPreference.roleKey === config.roleTemplateKey) {
    config.executePreference = selection.commandPreference.preference;
    config.builtinToolDefaultsRevision = BUILTIN_TOOL_DEFAULTS_REVISION;
  }
  config.playbooks = [...selection.playbooks];
  if (selection.backendKind === 'codex') {
    config.toolCeiling = selection.commandPreference || config.executePreference === 'deny' || config.allowedTools.length > 0 ? 'bounded' : 'native-default';
  }
}
