export type ExecutePreference = 'template' | 'allow' | 'deny';
export const BUILTIN_TOOL_DEFAULTS_REVISION = 1 as const;

export function isExecutePreference(value: unknown): value is ExecutePreference {
  return value === 'template' || value === 'allow' || value === 'deny';
}

/** v0.9.102 (design §3.3, the Owner's decision of 2026-11-10): an existing instance's tools follow its skill
 * change. A held tool goes only when a skill it came from was unticked and no remaining skill gives it; a tool
 * the instance holds on its own stays. A tool comes back only from a skill ticked in this save. execute, role
 * denials and ceilings are applied afterwards by materializeBuiltinTools and the caller. */
export function carryInstanceTools(input: {
  currentTools: readonly string[];
  priorSkillTools: readonly string[];
  nextSkillTools: readonly string[];
  addedSkillTools: readonly string[];
}): string[] {
  const before = new Set(input.priorSkillTools);
  const after = new Set(input.nextSkillTools);
  const tools = new Set(input.currentTools.filter(tool => after.has(tool) || !before.has(tool)));
  for (const tool of input.addedSkillTools) tools.add(tool);
  return [...tools];
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
