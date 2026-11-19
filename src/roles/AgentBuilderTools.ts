import type { AgentConfig, AgentSkill } from '../types';
import { SkillResolver } from './SkillResolver';
import { ROLE_TEMPLATES, SKILL_LIBRARY } from './RoleConfig';
import { BUILTIN_TOOL_DEFAULTS_REVISION, carryInstanceTools, materializeBuiltinTools, type ExecutePreference } from './BuiltinToolDefaults';

const skillResolver = new SkillResolver(SKILL_LIBRARY);

/** Codex's native default is an effective tool set, not a bounded list the instance chose. */
function codexNativeDefault(current: AgentConfig): boolean {
  return (current.backend === 'codex' || current.provider.providerId === 'codex')
    && (current.toolCeiling === 'native-default'
      || current.toolCeiling === undefined && (current.allowedTools ?? []).length === 0);
}

/** v0.9.102: the saved agent holds a tool list of its own, so a Builder save carries it through the skill
 * change (carryInstanceTools) instead of recomputing it from every ticked skill. The form's notice uses the
 * same answer to decide whether it compares against the saved list. */
export function builderCarriesInstanceTools(current: AgentConfig | undefined): current is AgentConfig {
  return !!current && Array.isArray(current.allowedTools) && !codexNativeDefault(current);
}

/** Ordinary form edits are not migration decisions or saved-permission reviews. In particular,
 * a checkbox recomputation must neither erase a builtin default nor invent a legacy preference. */
export function agentBuilderTools(input: {
  roleKey: string;
  skills: AgentSkill[];
  current?: AgentConfig;
  backend: AgentConfig['backend'];
  /** Explicit user action, not a skill-checkbox recomputation or saved-ceiling restore. */
  executePreference?: ExecutePreference;
}): Pick<AgentConfig, 'allowedTools' | 'toolCeiling' | 'executePreference' | 'builtinToolDefaultsRevision'> {
  const { current } = input;
  const builtin = Object.hasOwn(ROLE_TEMPLATES, input.roleKey);
  const prior = current?.allowedTools ?? [];
  const native = !!current && codexNativeDefault(current);
  const priorSkillIds = new Set((current?.skills ?? []).map(skill => skill.id));
  const resolved = input.skills.length === 0 && (current?.skills?.length ?? 0) === 0 && prior.length > 0
    ? prior
    // v0.9.102 (design §3.3 with the Owner's decision of 2026-11-10): a name, model or unchanged-skill save
    // no longer gives back a tool the agent does not hold; only a skill ticked in this save adds its tools.
    : builderCarriesInstanceTools(current) ? carryInstanceTools({
      currentTools: prior,
      priorSkillTools: skillResolver.resolveAllowedTools(current.skills ?? []),
      nextSkillTools: skillResolver.resolveAllowedTools(input.skills),
      addedSkillTools: skillResolver.resolveAllowedTools(input.skills.filter(skill => !priorSkillIds.has(skill.id))),
    })
    : skillResolver.resolveAllowedTools(input.skills);
  const preference = builtin ? input.executePreference ?? current?.executePreference ?? (!current ? 'template' : undefined)
    : current?.executePreference === 'deny' ? 'deny' : undefined;
  const allowedTools = materializeBuiltinTools({
    resolvedTools: preference === 'deny' ? resolved.filter(tool => tool !== 'execute') : resolved,
    roleDeniedTools: builtin ? ROLE_TEMPLATES[input.roleKey].deniedTools : undefined,
    source: builtin ? current ? 'host-instance' : 'new-builtin' : 'custom',
    currentTools: native ? [...prior, 'execute'] : prior,
    preference,
  });
  // Codex's native default is an effective tool set, not an empty bounded list. A name/model/skill
  // edit does not constitute consent to turn it into bounded (or to turn bounded-empty into native).
  const toolCeiling = input.backend === 'codex'
    ? native ? 'native-default' : current?.toolCeiling === 'bounded' || allowedTools.length > 0 ? 'bounded' : 'native-default'
    : undefined;
  return {
    allowedTools, toolCeiling,
    executePreference: preference,
    builtinToolDefaultsRevision: preference ? BUILTIN_TOOL_DEFAULTS_REVISION : undefined,
  };
}
