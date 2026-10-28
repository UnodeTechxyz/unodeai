import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import { AgentConfigBuilder, ROLE_TEMPLATES, SKILL_LIBRARY, TEAM_PRESETS, createTeam } from '../RoleConfig';
import { materializeBuiltinTools } from '../BuiltinToolDefaults';
import { SkillResolver } from '../SkillResolver';
import { serializeVersionedTeamFile } from '../../state/PersistenceManager';
import { validateTeamFile } from '../../state/TeamFileSchema';
import { toAgentConfig } from '../../marketplace/install';
import { roleTemplateCatalogEntries } from '../../marketplace/roleTemplateCatalog';

describe('CAP-1 unified builtin tool defaults', () => {
  it.each(Object.keys(ROLE_TEMPLATES))('%s and its skill recomputations retain execute without widening delegation', key => {
    const template = ROLE_TEMPLATES[key];
    expect(template.allowedTools.filter(tool => tool === 'execute')).toHaveLength(1);
    const builder = new AgentConfigBuilder().fromTemplate(key);
    const agent = builder.setSkills(template.skills.map(skill => skill.id)).addSkill('documentation').build();
    expect(agent.allowedTools).toContain('execute');
    expect(agent.executePreference).toBe('template');
    expect(agent.builtinToolDefaultsRevision).toBe(1);
    expect(agent.allowedTools?.includes('delegate')).toBe(key === 'pm');
    expect(new Set(agent.allowedTools).size).toBe(agent.allowedTools?.length);
    expect(agent).not.toHaveProperty('deniedTools');
    builder.setExecutePreference('deny').setSkills(['code-generation', 'project-management']).addSkill('computation');
    expect(builder.build().allowedTools).not.toContain('execute');
    builder.fromTemplate(key);
    expect(builder.build().executePreference).toBe('deny');
    expect(builder.build().allowedTools).not.toContain('execute');
  });

  it('all preset members use the same new-instance rule', () => {
    for (const preset of Object.values(TEAM_PRESETS)) {
      for (const agent of createTeam(preset.roles)) expect(agent.allowedTools).toContain('execute');
    }
  });

  it('the generic skill resolver and custom roles do not gain template commands', () => {
    const skills = [SKILL_LIBRARY['market-research']];
    expect(new SkillResolver().resolveAllowedTools(skills)).not.toContain('execute');
    expect(new AgentConfigBuilder().setSkills(['market-research']).build().allowedTools).not.toContain('execute');
    expect(() => new AgentConfigBuilder().setExecutePreference('template')).toThrow('known builtin');
  });

  it('unknown legacy instances preserve their command ceiling, rather than inferring template intent', () => {
    expect(materializeBuiltinTools({ source: 'host-instance', resolvedTools: ['read', 'execute'], currentTools: ['read'] })).toEqual(['read']);
    expect(materializeBuiltinTools({ source: 'host-instance', resolvedTools: ['read'], currentTools: ['execute'] })).toEqual(['execute', 'read']);
    expect(materializeBuiltinTools({ source: 'host-instance', preference: 'deny', resolvedTools: ['execute'], currentTools: ['execute'] })).toEqual([]);
    expect(materializeBuiltinTools({ source: 'host-instance', preference: 'allow', resolvedTools: ['read', 'delegate'], roleDeniedTools: ['delegate'] })).toEqual(['execute', 'read']);
  });

  it.each(['template', 'allow', 'deny', undefined] as const)('custom roles ignore builtin preference %s and keep only skill-granted commands', preference => {
    expect(materializeBuiltinTools({ source: 'custom', preference, resolvedTools: ['read', 'execute', 'delegate'], roleDeniedTools: ['delegate'] })).toEqual(['execute', 'read']);
    expect(materializeBuiltinTools({ source: 'custom', preference, resolvedTools: ['read'], currentTools: ['execute'] })).toEqual(['read']);
    expect(materializeBuiltinTools({ source: 'custom', preference, resolvedTools: ['read', 'execute'], ceiling: ['read'] })).toEqual(['read']);
  });

  it('an internal saved ceiling never manufactures a deny preference', () => {
    const builder = new AgentConfigBuilder().fromTemplate('contract-analyst').setAllowedTools(['read']);
    expect(builder.build().executePreference).toBe('template');
    expect(builder.build().allowedTools).toEqual(['read']);
    expect(materializeBuiltinTools({ source: 'host-instance', preference: 'template', resolvedTools: ['read'], ceiling: ['read'] })).toEqual(['read']);
  });

  it('ordinary project serialization excludes command preferences; forged project fields grant nothing', () => {
    const agent = new AgentConfigBuilder().fromTemplate('contract-analyst').setId('contract').build();
    const serialized = serializeVersionedTeamFile({ members: [agent], workflows: [], mcpServers: [] });
    expect(serialized).not.toContain('executePreference');
    expect(serialized).not.toContain('builtinToolDefaultsRevision');
    const forged = JSON.parse(serialized);
    Object.assign(forged.members[0], { executePreference: 'template', builtinToolDefaultsRevision: 1 });
    const read = validateTeamFile(forged);
    expect(read.members[0]).not.toHaveProperty('executePreference');
    expect(read.members[0]).not.toHaveProperty('builtinToolDefaultsRevision');
    expect(read.members[0].allowedTools).not.toContain('execute');
    expect(read.validationWarnings?.join(' ')).toContain('executePreference');
  });

  it('host-owned library validation retains valid preferences but rejects invalid fields', () => {
    const agent = new AgentConfigBuilder().fromTemplate('contract-analyst').build();
    const source = { members: [agent], workflows: [], mcpServers: [] };
    expect(validateTeamFile(source, undefined, { authority: 'host-owned' }).members[0]).toMatchObject({ executePreference: 'template', builtinToolDefaultsRevision: 1 });
    expect(() => validateTeamFile({ ...source, members: [{ ...agent, executePreference: 'yes' }] }, undefined, { authority: 'host-owned' })).toThrow('executePreference');
    expect(() => validateTeamFile({ ...source, members: [{ ...agent, builtinToolDefaultsRevision: 2 }] }, undefined, { authority: 'host-owned' })).toThrow('builtinToolDefaultsRevision');
  });

  it('the shipped marketplace catalog installs through the same builder rule', () => {
    for (const entry of roleTemplateCatalogEntries()) expect(toAgentConfig(entry, { name: entry.name }).allowedTools).toContain('execute');
  });
});
