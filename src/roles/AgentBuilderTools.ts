import type { AgentConfig, AgentSkill } from '../types';
import { SkillResolver } from './SkillResolver';
import { ROLE_TEMPLATES, SKILL_LIBRARY } from './RoleConfig';
import { BUILTIN_TOOL_DEFAULTS_REVISION, materializeBuiltinTools, type ExecutePreference } from './BuiltinToolDefaults';

const skillResolver = new SkillResolver(SKILL_LIBRARY);

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
  const native = current && (current.backend === 'codex' || current.provider.providerId === 'codex')
    && (current.toolCeiling === 'native-default'
      || current.toolCeiling === undefined && prior.length === 0);
  const resolved = input.skills.length === 0 && (current?.skills?.length ?? 0) === 0 && prior.length > 0
    ? prior : skillResolver.resolveAllowedTools(input.skills);
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
