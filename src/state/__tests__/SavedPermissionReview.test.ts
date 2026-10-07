import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../../types';
import {
  filterReviewedPermissionWarnings,
  savedPermissionLoadResult,
  savedPermissionSkillIds,
  savedPermissionTools,
  shouldReviewSavedPermissions,
} from '../SavedPermissionReview';

function oldProjectAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'frontend',
    name: 'Frontend Engineer',
    role: 'custom',
    roleTemplateKey: 'frontend-engineer',
    skill: 'code-generation',
    provider: { providerId: 'codex', apiKeySecretName: '' },
    model: 'codex-cli-default',
    systemPrompt: 'Build the website.',
    autoApprove: false,
    allowedTools: ['read', 'write', 'search', 'execute', 'message'],
    ...overrides,
  };
}

describe('pre-0.9.87 saved permission review', () => {
  it('offers the surviving primary skill and the role-template skills for an old tools-without-skills shape', () => {
    const member = oldProjectAgent();
    expect(member.skills).toBeUndefined();

    const offered = savedPermissionSkillIds(member);
    expect(offered).toEqual(['code-generation', 'testing', 'ui-ux', 'documentation']);
    expect(savedPermissionTools(member, [])).toEqual([]);
    expect(savedPermissionTools(member, offered)).toEqual(expect.arrayContaining(['write', 'execute']));
  });

  it('falls back to role-template skills when the old primary id is no longer installed', () => {
    const member = oldProjectAgent({ skill: 'removed-skill' });
    expect(savedPermissionSkillIds(member)).toEqual(expect.arrayContaining([
      'code-generation', 'testing', 'ui-ux', 'documentation',
    ]));
  });

  it('removes reviewed permission fields without hiding other stripped fields on the same warning', () => {
    expect(filterReviewedPermissionWarnings([
      "members[0] ignored host-only fields: skills, env, backend, playbooks. Configure trusted capabilities in UnodeAi's Agent Builder.",
    ])).toEqual([
      "members[0] ignored host-only fields: env, backend. Configure trusted capabilities in UnodeAi's Agent Builder.",
    ]);
  });

  it('reports restored agents after an unticked review instead of calling the team read-only', () => {
    expect(savedPermissionLoadResult(true, 2)).toBe('2 agent(s) regained selected permissions.');
    expect(savedPermissionLoadResult(true, 0)).toBe('The team is read-only.');
  });

  it('requires an unticked review for every unrecognised project save, never for the personal library', () => {
    expect(shouldReviewSavedPermissions('workspace', false)).toBe(true);
    expect(shouldReviewSavedPermissions('workspace', true)).toBe(false);
    expect(shouldReviewSavedPermissions('global', false)).toBe(false);
  });
});
