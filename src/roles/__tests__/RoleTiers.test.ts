import { describe, it, expect } from 'vitest';
import {
  ROLE_TEMPLATES,
  DEFAULT_MODEL_TIERS,
  DEFAULT_ROLE_MODEL_ALIAS,
  DEFAULT_PREMIUM_ROLE_MODEL_ALIAS,
  modelForRole,
  AgentConfigBuilder,
  createTeam,
} from '../RoleConfig';

const DATE_PINNED_MODEL_ID = /(?:^|[-_])(?:19|20)\d{2}(?:[-_]?\d{2}){2}(?:$|[-_])/;

function datePinnedRoleTemplateKeys(templates: typeof ROLE_TEMPLATES): string[] {
  return Object.entries(templates)
    .filter(([, template]) => DATE_PINNED_MODEL_ID.test(template.model))
    .map(([key]) => key);
}

describe('model tiers', () => {
  it('maps tiers to current provider models without changing tier placement', () => {
    expect(DEFAULT_MODEL_TIERS.premium.roam).toBe('claude-opus-5');
    expect(DEFAULT_MODEL_TIERS.premium.unode).toBe('claude-opus-5');
    expect(DEFAULT_MODEL_TIERS.premium.anthropic).toBe('claude-opus-5');
    expect(DEFAULT_MODEL_TIERS.premium.openai).toBe('gpt-5.6-sol');
    expect(DEFAULT_MODEL_TIERS.standard.openai).toBe('gpt-5.6-terra');
    expect(DEFAULT_MODEL_TIERS.economy.openai).toBe('gpt-5.6-luna');
    expect(DEFAULT_MODEL_TIERS.premium.openrouter).toBe('anthropic/claude-opus-5');
    expect(DEFAULT_MODEL_TIERS.standard.roam).toBe('deepseek-v4-pro');
    expect(DEFAULT_MODEL_TIERS.economy.roam).toBe('deepseek-v4-flash');
    expect(DEFAULT_MODEL_TIERS.standard.openrouter).toBe('openai/gpt-4o');
    expect(DEFAULT_MODEL_TIERS.economy.openrouter).toBe('google/gemini-3.5-flash');
  });

  it('leads (PM, Architect) are premium; workers (QA/DevOps/Data) are economy', () => {
    expect(ROLE_TEMPLATES.pm.tier).toBe('premium');
    expect(ROLE_TEMPLATES.architect.tier).toBe('premium');
    for (const role of ['tester', 'devops', 'data-engineer']) {
      expect(ROLE_TEMPLATES[role].tier).toBe('economy');
    }
    expect(ROLE_TEMPLATES['senior-dev'].tier).toBe('standard');
    expect(ROLE_TEMPLATES.security.tier).toBe('standard');
  });

  it('modelForRole resolves the tier model per provider', () => {
    expect(modelForRole(ROLE_TEMPLATES.pm, 'roam')).toBe('claude-opus-5');
    expect(modelForRole(ROLE_TEMPLATES.tester, 'roam')).toBe('deepseek-v4-flash');
    expect(modelForRole(ROLE_TEMPLATES.tester, 'openai')).toBe('gpt-5.6-luna');
    expect(modelForRole(ROLE_TEMPLATES.tester, 'openrouter')).toBe('google/gemini-3.5-flash');
  });

  it('a per-role modelOverride wins over the tier (tech-writer keeps qwen-max on Roam)', () => {
    expect(ROLE_TEMPLATES['tech-writer'].tier).toBe('standard');
    expect(modelForRole(ROLE_TEMPLATES['tech-writer'], 'roam')).toBe('qwen-max');
    expect(modelForRole(ROLE_TEMPLATES['tech-writer'], 'openai')).toBe(DEFAULT_MODEL_TIERS.standard.openai);
  });

  it('falls back to an evergreen family alias when neither override nor tier knows the provider', () => {
    const seniorDev = modelForRole(ROLE_TEMPLATES['senior-dev'], 'some-unknown-provider');
    expect(seniorDev).toBe(DEFAULT_ROLE_MODEL_ALIAS);
    expect(seniorDev).toBe(ROLE_TEMPLATES['senior-dev'].model);
    expect(seniorDev).not.toBe(DEFAULT_MODEL_TIERS.standard.roam);
    expect(modelForRole(ROLE_TEMPLATES.pm, 'some-unknown-provider')).toBe(DEFAULT_PREMIUM_ROLE_MODEL_ALIAS);
    expect(
      modelForRole({ tier: 'standard', model: 'claude-x' } as any, 'nope', {
        premium: {}, standard: {}, economy: {},
      } as any)
    ).toBe('claude-x');
  });

  it('has no date-pinned role-template model ids', () => {
    expect(datePinnedRoleTemplateKeys(ROLE_TEMPLATES)).toEqual([]);
  });

  it('guard mutation proof: a date-pinned role model is detected', () => {
    const mutatedTemplates = {
      ...ROLE_TEMPLATES,
      'senior-dev': {
        ...ROLE_TEMPLATES['senior-dev'],
        model: 'claude-sonnet-4-20250514',
      },
    };

    expect(datePinnedRoleTemplateKeys(mutatedTemplates)).toEqual(['senior-dev']);
  });
});

describe('role-tuned model params (defaults from experience)', () => {
  it('ships deterministic temperatures for code/review/security and higher for writing/architecture', () => {
    expect(ROLE_TEMPLATES.reviewer.modelParams?.temperature).toBe(0.1);
    expect(ROLE_TEMPLATES.security.modelParams?.temperature).toBe(0.1);
    expect(ROLE_TEMPLATES['senior-dev'].modelParams?.temperature).toBe(0.2);
    expect(ROLE_TEMPLATES.pm.modelParams?.temperature).toBe(0.3);
    expect(ROLE_TEMPLATES.architect.modelParams?.temperature).toBe(0.5);
    expect(ROLE_TEMPLATES['tech-writer'].modelParams?.temperature).toBe(0.6);
  });

  it('does not force reasoning_effort by default (opt-in only; some gateways reject it)', () => {
    for (const role of ['architect', 'pm', 'reviewer', 'security', 'tech-writer']) {
      expect(ROLE_TEMPLATES[role].modelParams?.reasoning_effort).toBeUndefined();
    }
  });

  it('builds an agent carrying the role default, as its own (non-aliased) object', () => {
    const a1 = new AgentConfigBuilder().fromTemplate('reviewer').build();
    const a2 = new AgentConfigBuilder().fromTemplate('reviewer').build();
    expect(a1.modelParams?.temperature).toBe(0.1);
    expect(a1.modelParams).not.toBe(a2.modelParams);
  });

  it('createTeam agents each get their role-tuned defaults', () => {
    const team = createTeam(['pm', 'senior-dev', 'reviewer'], 'roam');
    const byRole = Object.fromEntries(team.map((a) => [a.role, a.modelParams?.temperature]));
    expect(byRole.pm).toBe(0.3);
    expect(byRole['senior-dev']).toBe(0.2);
    expect(byRole.reviewer).toBe(0.1);

    const openrouterTeam = createTeam(['pm', 'tester'], 'openrouter');
    expect(openrouterTeam.map((agent) => agent.model)).toEqual([
      DEFAULT_MODEL_TIERS.premium.openrouter,
      DEFAULT_MODEL_TIERS.economy.openrouter,
    ]);
  });
});

describe('independent Reviewer role', () => {
  it('exists and is read-only (an independent validator never edits code)', () => {
    const reviewer = ROLE_TEMPLATES.reviewer;
    expect(reviewer).toBeDefined();
    expect(reviewer.role).toBe('reviewer');
    expect([...reviewer.allowedTools].sort()).toEqual(['message', 'read', 'search']);
    expect(reviewer.allowedTools).not.toContain('write');
    expect(reviewer.allowedTools).not.toContain('execute');
    expect(reviewer.tier).toBe('standard');
  });
});
