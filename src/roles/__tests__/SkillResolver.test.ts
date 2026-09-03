import { describe, it, expect } from 'vitest';
import { SkillResolver, agentMcpGrants } from '../SkillResolver';
import { ROLE_TEMPLATES, AgentConfigBuilder } from '../RoleConfig';
import { AgentConfig, AgentSkill } from '../../types';

const lib = (skills: AgentSkill[]): Record<string, AgentSkill> =>
  Object.fromEntries(skills.map((s) => [s.id, s]));

function skill(id: string, impl?: AgentSkill['implementation']): AgentSkill {
  return { id, name: id, description: id, category: 'development', implementation: impl };
}

describe('SkillResolver', () => {
  it('unions and de-duplicates builtin capability tokens', () => {
    const a = skill('a', { type: 'builtin', tools: ['read', 'write'] });
    const b = skill('b', { type: 'builtin', tools: ['write', 'execute'] });
    const r = new SkillResolver(lib([a, b]));
    expect(r.resolveAllowedTools([a, b]).sort()).toEqual(['execute', 'read', 'write']);
  });

  it('expands composite skills recursively', () => {
    const leaf1 = skill('leaf1', { type: 'builtin', tools: ['read'] });
    const leaf2 = skill('leaf2', { type: 'builtin', tools: ['execute'] });
    const mid = skill('mid', { type: 'composite', skillIds: ['leaf1', 'leaf2'] });
    const top = skill('top', { type: 'composite', skillIds: ['mid'] });
    const r = new SkillResolver(lib([leaf1, leaf2, mid, top]));
    expect(r.resolveAllowedTools([top]).sort()).toEqual(['execute', 'read']);
  });

  it('survives composite cycles without infinite recursion', () => {
    const x = skill('x', { type: 'composite', skillIds: ['y'] });
    const y = skill('y', { type: 'composite', skillIds: ['x'] }); // x <-> y cycle
    const z = skill('z', { type: 'builtin', tools: ['read'] });
    // mutual cycle that also pulls in a real token via a third skill
    const x2 = skill('x', { type: 'composite', skillIds: ['y', 'z'] });
    const r = new SkillResolver(lib([x2, y, z]));
    expect(r.resolveAllowedTools([x2]).sort()).toEqual(['read']);
    expect(() => new SkillResolver(lib([x, y])).resolveAllowedTools([x])).not.toThrow();
  });

  it('treats a skill without implementation as a legacy label (no tools)', () => {
    const legacy = skill('legacy', undefined);
    const r = new SkillResolver(lib([legacy]));
    expect(r.resolveAllowedTools([legacy])).toEqual([]);
  });

  it('ignores unknown skill ids referenced by a composite', () => {
    const c = skill('c', { type: 'composite', skillIds: ['does-not-exist', 'real'] });
    const real = skill('real', { type: 'builtin', tools: ['write'] });
    const r = new SkillResolver(lib([c, real]));
    expect(r.resolveAllowedTools([c])).toEqual(['write']);
  });

  it('contributes no capability tokens for mcp-server skills (those are 段2 MCP tools)', () => {
    const m = skill('gh', { type: 'mcp-server', serverId: 'github', toolFilter: 'all' });
    const r = new SkillResolver(lib([m]));
    expect(r.resolveAllowedTools([m])).toEqual([]);
  });
});

describe('ROLE_TEMPLATES derived allowedTools (regression lock)', () => {
  // Locks the capability tokens each role ends up with after skill-derivation.
  const expected: Record<string, string[]> = {
    architect: ['message', 'read', 'search', 'write'],
    'senior-dev': ['execute', 'message', 'read', 'search', 'write'],
    tester: ['execute', 'message', 'read', 'search', 'write'],
    devops: ['execute', 'message', 'read', 'search', 'write'],
    'tech-writer': ['message', 'read', 'search', 'write'],
    pm: ['delegate', 'execute', 'message', 'read', 'search', 'write'], // working lead: can act on small tasks + delegate
    security: ['message', 'read', 'search', 'write'],
    'data-engineer': ['execute', 'message', 'read', 'search', 'write'],
    reviewer: ['message', 'read', 'search'],
  };

  for (const [role, tools] of Object.entries(expected)) {
    it(`${role} derives ${tools.join('/')}`, () => {
      expect([...ROLE_TEMPLATES[role].allowedTools].sort()).toEqual(tools);
    });
  }

  it('every role template has at least one skill with an implementation', () => {
    for (const tpl of Object.values(ROLE_TEMPLATES)) {
      expect(tpl.skills.some((s) => s.implementation)).toBe(true);
    }
  });
});

describe('AgentConfigBuilder derives allowedTools from skills', () => {
  it('setSkills computes capability tokens from the chosen skills', () => {
    const cfg = new AgentConfigBuilder('custom')
      .setSkills(['code-generation', 'code-review'])
      .build();
    expect([...cfg.allowedTools].sort()).toEqual(['execute', 'message', 'read', 'search', 'write']);
    expect(cfg.skill).toBe('code-generation');
  });

  it('addSkill re-derives allowedTools as skills accumulate', () => {
    const cfg = new AgentConfigBuilder('custom')
      .setSkills(['code-review']) // read/search only
      .addSkill('code-generation') // adds write/execute
      .build();
    expect([...cfg.allowedTools].sort()).toEqual(['execute', 'message', 'read', 'search', 'write']);
  });

  it('explicit setAllowedTools still overrides derivation (escape hatch)', () => {
    const cfg = new AgentConfigBuilder('custom')
      .setSkills(['code-generation']) // would be read/write/search/execute
      .setAllowedTools(['read'])
      .build();
    expect(cfg.allowedTools).toEqual(['read']);
  });
});

describe('SkillResolver MCP grants (段2)', () => {
  const ghSkill: AgentSkill = {
    id: 'github-integration', name: 'GitHub', description: '', category: 'external',
    implementation: { type: 'mcp-server', serverId: 'github', toolFilter: 'all' },
  };
  const webSkill: AgentSkill = {
    id: 'web-search', name: 'Web', description: '', category: 'external',
    implementation: { type: 'mcp-server', serverId: 'browser', toolFilter: 'allowlist', toolList: ['search'] },
  };
  const codeSkill: AgentSkill = {
    id: 'code-generation', name: 'Code', description: '', category: 'development',
    implementation: { type: 'builtin', tools: ['read', 'write'] },
  };
  const bundle: AgentSkill = {
    id: 'fullstack', name: 'Fullstack', description: '', category: 'development',
    implementation: { type: 'composite', skillIds: ['github-integration', 'code-generation'] },
  };
  const lib = Object.fromEntries([ghSkill, webSkill, codeSkill, bundle].map((s) => [s.id, s]));

  const baseConfig = (over: Partial<AgentConfig>): AgentConfig => ({
    id: 'a', name: 'A', role: 'custom', skill: '', provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'm', systemPrompt: '', autoApprove: true, allowedTools: [], ...over,
  });

  it('extracts mcp-server grants from skills, carrying tool filters', () => {
    const r = new SkillResolver(lib);
    const grants = r.resolveMcpServerRefs([ghSkill, webSkill, codeSkill]);
    expect(grants).toEqual([
      { serverId: 'github', toolFilter: 'all', toolList: undefined },
      { serverId: 'browser', toolFilter: 'allowlist', toolList: ['search'] },
    ]);
  });

  it('finds mcp grants nested inside composite skills', () => {
    const r = new SkillResolver(lib);
    expect(r.resolveMcpServerRefs([bundle]).map((g) => g.serverId)).toEqual(['github']);
  });

  it('agentMcpGrants merges skill grants with explicit mcpServers (skill wins on conflict)', () => {
    const r = new SkillResolver(lib);
    const cfg = baseConfig({ skills: [webSkill], mcpServers: ['browser', 'sqlite'] });
    const grants = agentMcpGrants(cfg, r);
    // browser comes from the skill (allowlist), sqlite from explicit (all); no duplicate browser.
    expect(grants).toEqual([
      { serverId: 'browser', toolFilter: 'allowlist', toolList: ['search'] },
      { serverId: 'sqlite', toolFilter: 'all' },
    ]);
  });

  it('default-deny: an agent with no mcp skills and no mcpServers gets no grants', () => {
    const r = new SkillResolver(lib);
    expect(agentMcpGrants(baseConfig({ skills: [codeSkill] }), r)).toEqual([]);
  });
});
