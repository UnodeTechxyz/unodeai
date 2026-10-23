import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../../types';
import { withoutIntegrationGrant } from '../IntegrationRemoval';

const skill = (id: string, serverId?: string) => ({
  id, name: id, description: id, category: 'custom' as const,
  ...(serverId ? { implementation: { type: 'mcp-server' as const, serverId, toolFilter: 'all' as const } } : {}),
});

const agent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: 'agent-1', name: 'Researcher', role: 'researcher', model: 'test', provider: { id: 'test' },
  ...overrides,
} as AgentConfig);

describe('withoutIntegrationGrant', () => {
  it('removes direct and Skill-derived grants while preserving unrelated access', () => {
    const result = withoutIntegrationGrant(
      agent({ mcpServers: ['docs', 'calendar'], skills: [skill('docs-skill', 'docs'), skill('calendar-skill', 'calendar'), skill('plain-skill')] }),
      'docs',
      (skills) => skills[0].implementation?.type === 'mcp-server'
        ? [{ serverId: skills[0].implementation.serverId }]
        : [],
    );

    expect(result.mcpServers).toEqual(['calendar']);
    expect(result.skills?.map(({ id }) => id)).toEqual(['calendar-skill', 'plain-skill']);
    expect(result.mcpServers).not.toContain('docs');
  });

  it('does not mutate the live source object before persistence succeeds', () => {
    const source = agent({ mcpServers: ['docs'], skills: [skill('docs-skill', 'docs')] });
    const result = withoutIntegrationGrant(source, 'docs', () => [{ serverId: 'docs' }]);
    expect(source.mcpServers).toEqual(['docs']);
    expect(source.skills?.map(({ id }) => id)).toEqual(['docs-skill']);
    expect(result).toMatchObject({ mcpServers: [], skills: [] });
  });
});
