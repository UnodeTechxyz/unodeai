import { describe, expect, it } from 'vitest';
import { AgentConfigBuilder, ROLE_TEMPLATES, SKILL_LIBRARY } from '../RoleConfig';
import { agentBuilderTools } from '../AgentBuilderTools';

describe('ordinary Agent Builder tool materialization', () => {
  it('switching a denied built-in instance to custom does not let a skill clear its explicit command denial', () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setExecutePreference('deny').build();
    const edit = agentBuilderTools({ roleKey: 'custom', current, skills: [SKILL_LIBRARY.testing], backend: 'openai-compat' });
    expect(edit.executePreference).toBe('deny'); expect(edit.allowedTools).not.toContain('execute');
  });
  it.each(Object.keys(ROLE_TEMPLATES))('preserves %s template commands when skills are recalculated', roleKey => {
    const current = new AgentConfigBuilder().fromTemplate(roleKey).build();
    const edit = agentBuilderTools({ roleKey, current, skills: [SKILL_LIBRARY.documentation], backend: 'openai-compat' });
    expect(edit.allowedTools).toContain('execute');
    expect(edit.executePreference).toBe('template');
    expect(edit.builtinToolDefaultsRevision).toBe(1);
    expect(edit.allowedTools).not.toContain('delegate');
    expect(current).toEqual(new AgentConfigBuilder().fromTemplate(roleKey).setId(current.id).build());
  });

  it.each(['template', 'allow', 'deny'] as const)('preserves explicit %s and role-local delegate denial across skills', preference => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setExecutePreference(preference).build();
    const edit = agentBuilderTools({ roleKey: 'contract-analyst', current,
      skills: [SKILL_LIBRARY['project-management'], SKILL_LIBRARY.testing], backend: 'openai-compat' });
    expect(edit.executePreference).toBe(preference);
    expect(edit.allowedTools?.includes('execute')).toBe(preference !== 'deny');
    expect(edit.allowedTools).not.toContain('delegate');
  });

  it.each([true, false])('keeps legacy execute=%s without fabricating a template decision', execute => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').build();
    delete current.executePreference; delete current.builtinToolDefaultsRevision;
    current.allowedTools = execute ? ['read', 'execute'] : ['read'];
    const edit = agentBuilderTools({ roleKey: 'contract-analyst', current, skills: [SKILL_LIBRARY.testing], backend: 'openai-compat' });
    expect(edit.allowedTools?.includes('execute')).toBe(execute);
    expect(edit.executePreference).toBeUndefined(); expect(edit.builtinToolDefaultsRevision).toBeUndefined();
  });

  it('materializes a new known role, but does not give custom or unknown templates commands', () => {
    const skills = [SKILL_LIBRARY.documentation];
    expect(agentBuilderTools({ roleKey: 'contract-analyst', skills, backend: 'openai-compat' })).toMatchObject({
      executePreference: 'template', builtinToolDefaultsRevision: 1, allowedTools: ['execute', 'message', 'read', 'search', 'write'],
    });
    for (const roleKey of ['custom', '__proto__', 'constructor', 'not-a-role']) {
      const edit = agentBuilderTools({ roleKey, skills, backend: 'openai-compat' });
      expect(edit.allowedTools).not.toContain('execute'); expect(edit.executePreference).toBeUndefined();
    }
  });

  it.each(['native-default', undefined, 'bounded'] as const)('keeps an existing empty Codex %s ceiling through ordinary edits', toolCeiling => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setProviderById('codex').build();
    Object.assign(current, { backend: 'codex', allowedTools: [], toolCeiling });
    delete current.executePreference; delete current.builtinToolDefaultsRevision;
    const edit = agentBuilderTools({ roleKey: 'contract-analyst', current, skills: [SKILL_LIBRARY.documentation], backend: 'codex' });
    expect(edit.toolCeiling).toBe(toolCeiling === 'bounded' ? 'bounded' : 'native-default');
    expect(edit.executePreference).toBeUndefined();
  });

  it('preserves a legacy no-skill tool list rather than stripping its manually configured tools', () => {
    const current = new AgentConfigBuilder().setAllowedTools(['delegate', 'read', 'message']).build();
    expect(agentBuilderTools({ roleKey: 'custom', current, skills: [], backend: 'openai-compat' }).allowedTools)
      .toEqual(['delegate', 'message', 'read']);
  });
});
