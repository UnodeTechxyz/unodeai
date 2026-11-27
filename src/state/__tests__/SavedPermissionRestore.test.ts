import { describe, expect, it } from 'vitest';
import { SKILL_LIBRARY } from '../../roles/RoleConfig';
import type { AgentConfig } from '../../types';
import { applySavedPermissionRestore, restoreSavedPermissionsIndividually, savedCommandPreference, restoredCommandTools } from '../SavedPermissionRestore';

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
  it('mismatching role, untrusted declaration and legacy absence cannot use the execute-only exception', () => {
    const current = { ...loadedAgent('a'), roleTemplateKey: 'contract-analyst', allowedTools: ['read'] };
    expect(savedCommandPreference({ ...current, executePreference: 'template' }, false)).toBeUndefined();
    expect(savedCommandPreference(current, true)).toBeUndefined();
    expect(restoredCommandTools(['read'], current, { roleKey: 'pm', preference: 'allow' })).toEqual(['read']);
    expect(restoredCommandTools(['read', 'write', 'delegate'], { ...current, executePreference: 'deny' })).toEqual(['delegate', 'read', 'write']);
    const denied = { ...current, executePreference: 'deny' as const };
    expect(restoredCommandTools(['read', 'execute'], denied, savedCommandPreference(denied, true))).toEqual(['read']);
  });
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

describe('v0.9.102 R3: a restore keeps the Run commands a loaded built-in holds (design 3.2)', () => {
  it('keeps On and template only where the agent holds execute, never for a custom role, and Off still wins', () => {
    const builtin = { ...loadedAgent('b'), roleTemplateKey: 'contract-analyst' };
    // Loaded with Run commands by its role default or an On choice: a saved list without execute is not Off.
    expect(restoredCommandTools(['read', 'write'], { ...builtin, executePreference: 'template', allowedTools: ['execute', 'read'] })).toEqual(['execute', 'read', 'write']);
    expect(restoredCommandTools(['read'], { ...builtin, executePreference: 'allow', allowedTools: ['execute', 'read'] })).toEqual(['execute', 'read']);
    expect(restoredCommandTools(['read'], { ...builtin, executePreference: 'template', allowedTools: undefined as unknown as string[] })).toEqual(['execute', 'read']);
    // A restore never adds Run commands the agent did not hold.
    expect(restoredCommandTools(['read'], { ...builtin, executePreference: 'template', allowedTools: ['read'] })).toEqual(['read']);
    // A custom role, or an unknown key, has no role default to keep.
    expect(restoredCommandTools(['read'], { ...loadedAgent('c'), executePreference: 'template', allowedTools: ['execute', 'read'] })).toEqual(['read']);
    expect(restoredCommandTools(['read'], { ...builtin, roleTemplateKey: '__proto__', executePreference: 'allow', allowedTools: ['execute'] })).toEqual(['read']);
    // Off still removes it, and a trusted saved choice still decides.
    expect(restoredCommandTools(['execute', 'read'], { ...builtin, executePreference: 'deny', allowedTools: ['read'] })).toEqual(['read']);
    expect(restoredCommandTools(['read'], { ...builtin, executePreference: 'template', allowedTools: ['execute'] }, { roleKey: 'contract-analyst', preference: 'deny' })).toEqual(['read']);
  });
});
