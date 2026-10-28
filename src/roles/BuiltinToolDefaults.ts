export type ExecutePreference = 'template' | 'allow' | 'deny';
export const BUILTIN_TOOL_DEFAULTS_REVISION = 1 as const;

export function isExecutePreference(value: unknown): value is ExecutePreference {
  return value === 'template' || value === 'allow' || value === 'deny';
}

/** The SkillResolver stays generic. Only a host-selected builtin or an explicit host preference adds execute.
 * Legacy/imported instances keep their existing execute ceiling until an actual user decision is made. */
export function materializeBuiltinTools(input: {
  resolvedTools: readonly string[];
  roleDeniedTools?: readonly string[];
  source: 'new-builtin' | 'host-instance' | 'custom';
  preference?: ExecutePreference;
  currentTools?: readonly string[];
  ceiling?: readonly string[];
}): string[] {
  const denied = new Set(input.roleDeniedTools?.filter(tool => tool !== 'execute'));
  const tools = new Set(input.resolvedTools.filter(tool => !denied.has(tool)));
  const execute = input.source === 'custom' ? tools.has('execute')
    : input.preference === 'deny' ? false
    : input.preference === 'allow' || input.preference === 'template' ? true
    : input.source === 'new-builtin' ? true
    : input.source === 'host-instance' ? input.currentTools?.includes('execute') === true
    : tools.has('execute');
  tools.delete('execute');
  if (execute) tools.add('execute');
  // Restoring a saved ceiling is not an explicit user command preference.
  if (input.ceiling) for (const tool of tools) if (!input.ceiling.includes(tool)) tools.delete(tool);
  return [...tools].sort();
}
