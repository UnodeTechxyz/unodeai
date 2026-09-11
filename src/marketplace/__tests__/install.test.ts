import { describe, expect, it } from 'vitest';
import { toAgentConfig, toMcpServerConfig, mountSkillPlaybooks, stripPlaybooks, applyPlaybooks } from '../install';
import { AgentCatalogEntry, McpCatalogEntry, SkillCatalogEntry } from '../catalog';

describe('playbook compatibility', () => {
  const catalog: SkillCatalogEntry[] = [{
    id: 'legacy-skill', name: 'Legacy Skill', summary: '', category: 'development', capabilities: ['read'], body: 'legacy body',
  }];
  const legacyPrompt = 'Base.\n\n## Playbooks\n\nThese playbooks were installed.\n\n### Legacy\nlegacy body';

  it('preserves literal Playbooks headings while ids remain on AgentConfig for progressive loading', () => {
    expect(applyPlaybooks(legacyPrompt, ['legacy-skill', 'another-skill'], catalog)).toBe(legacyPrompt);
    expect(mountSkillPlaybooks(legacyPrompt, ['legacy-skill'], catalog)).toBe(legacyPrompt);
    expect(stripPlaybooks('Base.')).toBe('Base.');
  });

  it('does not cap a playbook list or add inline bodies to a fresh prompt', () => {
    expect(applyPlaybooks('Base.', ['a', 'b', 'c', 'd', 'e', 'f', 'g'], catalog)).toBe('Base.');
    expect(mountSkillPlaybooks('Base.', ['legacy-skill'], catalog)).toBe('Base.');
  });
});

describe('toAgentConfig', () => {
  const entry: AgentCatalogEntry = {
    id: 'security-auditor',
    name: 'Security Auditor',
    role: 'security',
    summary: 'Audits code for vulnerabilities.',
    skills: ['security-audit', 'code-review'],
    model: 'claude-opus-4-8',
    tier: 'premium',
    systemPrompt: 'You audit code.',
    icon: 'lock',
    color: '#78909C',
    mcpServers: ['hermes-bridge'],
  };

  it('retains mapped default-role playbooks without injecting their bodies', () => {
    const cfg = toAgentConfig(entry, { name: 'Security Auditor' });
    expect(cfg.role).toBe('security');
    expect(cfg.name).toBe('Security Auditor');
    expect(cfg.systemPrompt).toBe('You audit code.');
    expect(cfg.provider.providerId).toBe('roam');
    expect(cfg.workingDirectory).toBeUndefined();
    expect(cfg.mcpServers).toEqual(['hermes-bridge']);
    expect(cfg.playbooks).toEqual([
      'using-superpowers',
      'owasp-top10-review',
      'secrets-scanning',
      'authz-check',
      'quality-gate-95',
      'verification-before-completion',
    ]);
    expect(cfg.systemPrompt).not.toContain('## Playbooks');
  });

  it('derives capability tools and resolves a model from the tier', () => {
    const cfg = toAgentConfig(entry, { name: 'Security Auditor' });
    expect(cfg.skills?.map((skill) => skill.id)).toEqual(['security-audit', 'code-review']);
    expect(cfg.allowedTools.length).toBeGreaterThan(0);
    expect(cfg.model).toBeTruthy();
  });
});

describe('toMcpServerConfig', () => {
  it('maps stdio fields and drops catalog-only metadata', () => {
    const entry: McpCatalogEntry = {
      id: 'git', name: 'Git', summary: 'Local git ops', icon: 'git-branch', transport: 'stdio',
      command: 'uvx', args: ['mcp-server-git'], requiresApproval: true, prerequisite: 'uv', source: 'https://example.com',
    };
    expect(toMcpServerConfig(entry)).toEqual({
      id: 'git', name: 'Git', transport: 'stdio', command: 'uvx', args: ['mcp-server-git'], requiresApproval: true,
    });
  });

  it('drops install-time URL prompt metadata', () => {
    const entry: McpCatalogEntry = {
      id: 'hermes-bridge', name: 'Hermes Bridge', summary: 'Connect a local bridge.', transport: 'streamable-http',
      urlPrompt: { title: 'Hermes URL', prompt: 'Enter the bridge endpoint.' }, requiresApproval: true,
    };
    expect(toMcpServerConfig(entry)).toEqual({
      id: 'hermes-bridge', name: 'Hermes Bridge', transport: 'streamable-http', requiresApproval: true,
    });
  });
});
