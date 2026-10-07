import { describe, expect, it } from 'vitest';
import { SKILL_LIBRARY } from '../../roles/RoleConfig';
import type { AgentConfig } from '../../types';
import { applySavedPermissionRestore, restoreSavedPermissionsIndividually } from '../SavedPermissionRestore';

function loadedAgent(id: string, backend: AgentConfig['backend'] = 'claude'): AgentConfig {
  return {
    id,
    name: id === 'claude' ? 'Claude CLI agent' : `Agent ${id}`,
    role: 'custom',
    skill: 'documentation',
    skills: [],
    provider: { providerId: backend === 'claude' ? 'anthropic' : 'unode', apiKeySecretName: '' },
    model: backend === 'claude' ? 'claude-cli-default' : 'model',
    systemPrompt: 'Leave this prompt alone.',
    autoApprove: false,
    backend,
    allowedTools: [],
    modelParams: { temperature: 0.2 },
    contextWindowTokens: 12345,
    tier: 'premium',
    folderAccess: [{ path: '/workspace', permission: 'read' }],
  };
}

describe('saved permission restore', () => {
  it.each(['fingerprint restore', 'unticked review'])('%s changes permissions without validating or replacing a Claude legacy temperature', (_path) => {
    const team = [loadedAgent('claude'), ...Array.from({ length: 6 }, (_, index) => loadedAgent(String(index)))];
    for (const agent of team) {
      const priorSettings = {
        modelParams: agent.modelParams,
        contextWindowTokens: agent.contextWindowTokens,
        tier: agent.tier,
        folderAccess: agent.folderAccess,
        systemPrompt: agent.systemPrompt,
      };
      applySavedPermissionRestore(agent, {
        skillIds: ['code-generation'],
        skills: [SKILL_LIBRARY['code-generation']],
        allowedTools: ['read', 'write'],
        playbooks: [],
        backendKind: agent.backend,
      });
      expect(agent.allowedTools).toEqual(['read', 'write']);
      expect(agent.modelParams).toEqual({ temperature: 0.2 });
      expect(agent).toMatchObject(priorSettings);
    }
  });

  it('leaves only a genuinely failing agent read-only and continues restoring the other six', async () => {
    const team = Array.from({ length: 7 }, (_, index) => loadedAgent(`agent-${index}`));
    const attempted: string[] = [];
    const result = await restoreSavedPermissionsIndividually(team, async (agent) => {
      attempted.push(agent.name);
      if (agent.id === 'agent-3') return { ok: false, message: 'profile unavailable', granted: false };
      applySavedPermissionRestore(agent, {
        skillIds: ['code-generation'],
        skills: [SKILL_LIBRARY['code-generation']],
        allowedTools: ['read', 'write'],
        playbooks: [],
        backendKind: agent.backend,
      });
      return { ok: true, message: 'restored', granted: true };
    });

    expect(attempted).toHaveLength(7);
    expect(result).toEqual({ regainedPermissionAgents: 6, failures: ['Agent agent-3: profile unavailable'] });
    expect(team.filter((agent) => agent.id !== 'agent-3').every((agent) => agent.allowedTools.includes('write'))).toBe(true);
    expect(team.find((agent) => agent.id === 'agent-3')?.allowedTools).toEqual([]);
  });
});
