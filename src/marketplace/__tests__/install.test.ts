import { describe, expect, it } from 'vitest';
import { toAgentConfig, toMcpServerConfig, mountSkillPlaybooks, stripPlaybooks, applyPlaybooks } from '../install';
import { AgentCatalogEntry, McpCatalogEntry, SkillCatalogEntry } from '../catalog';
import { providerRefForConnectionId, BUILTIN_CONNECTION_REGISTRY } from '../../routes/ConnectionRegistry';

// v0.9.105 (S3): the host resolves the connection and model; the converter takes them as given.
const unode = providerRefForConnectionId('unode', BUILTIN_CONNECTION_REGISTRY)!;

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
    suggestedMcpServers: ['hermes-bridge'],
  };

  it('retains mapped default-role playbooks without injecting their bodies', () => {
    const cfg = toAgentConfig(entry, { name: 'Security Auditor', provider: unode, model: 'chosen-model' });
    expect(cfg.role).toBe('security');
    expect(cfg.name).toBe('Security Auditor');
    expect(cfg.systemPrompt).toBe('You audit code.');
    expect(cfg.provider).toEqual(unode);
    expect(cfg.model).toBe('chosen-model');
    expect(cfg.workingDirectory).toBeUndefined();
    expect(cfg.mcpServers).toBeUndefined();
    expect(cfg.playbooks).toEqual([
      'using-superpowers',
      'owasp-top10-review',
      'secrets-scanning',
      'authz-check',
      'quality-gate-95',
      'verification-before-completion',
      // v0.9.106: a Marketplace install takes the role template's playbooks, the new default included.
      'security-threat-model',
    ]);
    expect(cfg.systemPrompt).not.toContain('## Playbooks');
  });

  it('derives capability tools, and keeps the model the host resolved', () => {
    const cfg = toAgentConfig(entry, { name: 'Security Auditor', provider: unode, model: 'chosen-model' });
    expect(cfg.skills?.map((skill) => skill.id)).toEqual(['security-audit', 'code-review']);
    expect(cfg.allowedTools.length).toBeGreaterThan(0);
    expect(cfg.model).toBe('chosen-model');
  });
});

describe('toMcpServerConfig', () => {
  it('maps stdio fields and drops catalog-only metadata', () => {
    const entry: McpCatalogEntry = {
      id: 'git', name: 'Git', summary: 'Local git ops', icon: 'git-branch', transport: 'stdio',
      command: 'uvx', args: ['mcp-server-git'], prerequisite: 'uv', source: 'https://example.com',
      maintenanceState: 'community', lastVerified: '2026-09-11',
      installIdentity: { ecosystem: 'pypi', value: 'mcp-server-git' },
    };
    expect(toMcpServerConfig(entry)).toEqual({
      id: 'git', name: 'Git', transport: 'stdio', command: 'uvx', args: ['mcp-server-git'],
    });
  });

  it('drops install-time URL prompt metadata', () => {
    const entry: McpCatalogEntry = {
      id: 'hermes-bridge', name: 'Hermes Bridge', summary: 'Connect a local bridge.', transport: 'streamable-http',
      urlPrompt: { title: 'Hermes URL', prompt: 'Enter the bridge endpoint.' }, source: 'https://example.com/hermes',
      maintenanceState: 'community', lastVerified: '2026-09-11',
      installIdentity: { ecosystem: 'endpoint', value: 'https://example.com/hermes' },
    };
    expect(toMcpServerConfig(entry)).toEqual({
      id: 'hermes-bridge', name: 'Hermes Bridge', transport: 'streamable-http',
    });
  });
});
