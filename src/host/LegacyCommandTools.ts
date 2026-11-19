import type { AgentConfig } from '../types';
import { ROLE_TEMPLATES } from '../roles/RoleConfig';
import { BUILTIN_TOOL_DEFAULTS_REVISION, isExecutePreference } from '../roles/BuiltinToolDefaults';

/** Owner 2026-10-25: old built-in roles adopt the shared command default without a dialog.
 * Explicit choices and custom/unknown role tools remain byte-for-byte unchanged. No task is started. */
export function migrateLegacyCommandTools(members: readonly AgentConfig[]): {
  members: AgentConfig[]; changed: boolean; added: number;
} {
  let changed = false; let added = 0;
  const migrated = members.map(config => {
    if (!config.roleTemplateKey || !Object.hasOwn(ROLE_TEMPLATES, config.roleTemplateKey)
      || isExecutePreference(config.executePreference)) return config;
    changed = true;
    if (config.allowedTools && !config.allowedTools.includes('execute')) added++;
    return { ...config, ...(config.allowedTools ? { allowedTools: [...new Set([...config.allowedTools, 'execute'])].sort() } : {}),
      executePreference: 'template' as const, builtinToolDefaultsRevision: BUILTIN_TOOL_DEFAULTS_REVISION };
  });
  return { members: migrated, changed, added };
}

export function legacyCommandMigrationNotice(added: number): string {
  return `${added} agents from an earlier version can now run commands. Turn it off per agent in Agent Builder.`;
}
