import type { AgentConfig, AgentSkill } from '../types';

/** The only fields a saved-team confirmation or unticked review is allowed to change on a loaded agent. */
export interface SavedPermissionRestoreSelection {
  skillIds: readonly string[];
  skills: readonly AgentSkill[];
  allowedTools: readonly string[];
  playbooks: readonly string[];
  backendKind: AgentConfig['backend'];
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
  config.allowedTools = [...selection.allowedTools];
  config.playbooks = [...selection.playbooks];
  if (selection.backendKind === 'codex') {
    config.toolCeiling = selection.allowedTools.length > 0 ? 'bounded' : 'native-default';
  }
}
