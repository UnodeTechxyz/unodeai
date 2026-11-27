import { describe, it, expect } from 'vitest';
import {
  ROLE_TEMPLATES,
  SKILL_LIBRARY,
  DEFAULT_MODEL_TIERS,
  DEFAULT_ROLE_MODEL_ALIAS,
  DEFAULT_PREMIUM_ROLE_MODEL_ALIAS,
  modelForRole,
  AgentConfigBuilder,
  createTeam,
  TEAM_PRESETS,
} from '../RoleConfig';
import { BUILTIN_CONNECTION_REGISTRY, connectionIdForProviderId, connectionProfile } from '../../routes/ConnectionRegistry';

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

/**
 * v0.9.92 (Owner, 2026-10-02): a built-in role holds the tools its own work needs. Sixteen roles could not run
 * the checks or the calculations their own text promises; the rule that kept them so was least privilege.
 */
describe('a built-in role can do the work it describes', () => {
  const VERIFY = ['tech-writer', 'security', 'reviewer', 'sales-engineer', 'application-security-engineer',
    'cloud-security-engineer', 'knowledge-manager', 'developer-advocate', 'localization-i18n-specialist'];
  const COMPUTE = ['financial-analyst', 'fpa-analyst', 'product-analyst', 'data-analyst',
    'support-operations-analyst', 'revenue-operations-analyst', 'seo-analyst'];
  // Roles whose deliverable is a review, a verdict or an assessment. They write that report. v0.9.102 (design 6):
  // they are no longer told never to change the work it is about; a verdict covers what was reviewed, and a change
  // they make is theirs and needs another reviewer. That is an instruction rather than a missing tool.
  const REPORTING = ['reviewer', 'application-security-engineer', 'privacy-data-protection-officer', 'grc-analyst'];

  it('lets the sixteen checking and calculating roles run commands', () => {
    for (const key of [...VERIFY, ...COMPUTE]) {
      const tools = ROLE_TEMPLATES[key].allowedTools;
      expect(tools, `${key} runs commands`).toContain('execute');
      expect(tools, `${key} does not delegate`).not.toContain('delegate');
    }
  });

  // Owner, 2026-10-02: a reviewer should be able to write its review or quality report. No built-in role is
  // without Write files any more; the Privacy Officer and the GRC Analyst assess by reading and run no commands.
  it('lets every role write its deliverable, and tells the reporting roles what their verdict no longer covers', () => {
    for (const [key, template] of Object.entries(ROLE_TEMPLATES)) {
      expect(template.allowedTools, `${key} writes files`).toContain('write');
    }
    expect([...ROLE_TEMPLATES.reviewer.allowedTools].sort()).toEqual(['execute', 'message', 'read', 'search', 'write']);
    expect([...ROLE_TEMPLATES['application-security-engineer'].allowedTools].sort()).toEqual(['execute', 'message', 'read', 'search', 'write']);
    expect([...ROLE_TEMPLATES['privacy-data-protection-officer'].allowedTools].sort()).toEqual(['execute', 'message', 'read', 'search', 'write']);
    expect([...ROLE_TEMPLATES['grc-analyst'].allowedTools].sort()).toEqual(['execute', 'message', 'read', 'search', 'write']);
    for (const key of REPORTING) {
      const prompt = ROLE_TEMPLATES[key].systemPrompt;
      // Conditional, because a saved agent gets this text while it still has no file-writing tool.
      expect(prompt, key).toMatch(/[Ww]here you can write files/);
      expect(prompt, key).toMatch(/verdict no longer covers\s+what you changed|review no longer covers what you changed|assessment no longer covers that change/);
      expect(prompt, key).not.toMatch(/never change the work you review|never modify the code or configuration you review|do not edit the artifacts you assess/);
    }
  });

  it('carries Run commands in two capabilities that do not carry Write files', () => {
    for (const id of ['verification', 'computation']) {
      const skill = SKILL_LIBRARY[id];
      expect(skill.implementation).toEqual({ type: 'builtin', tools: ['read', 'search', 'execute', 'message'] });
    }
  });

  // A saved agent on a shipped prompt gets the new text at once and keeps its saved tools. A sentence that
  // assumed the tool would make such an agent report a missing capability instead of doing its work.
  it('words every such instruction for an agent that may not hold Run commands yet', () => {
    for (const key of [...VERIFY, ...COMPUTE]) {
      expect(ROLE_TEMPLATES[key].systemPrompt, key).toMatch(/[Ww]here you\s+can run commands/);
      expect(ROLE_TEMPLATES[key].systemPrompt, key).not.toMatch(/(do not|never|without) (run|running|execute|executing) commands/i);
    }
  });

  it('does not describe an action the product has no tool for', () => {
    for (const key of ['sales-development-rep', 'account-executive', 'customer-success-manager']) {
      expect(ROLE_TEMPLATES[key].description, key).toMatch(/for a person to (send|run)/);
      expect(ROLE_TEMPLATES[key].systemPrompt, key).toMatch(/a person (sends|runs)|You do not contact the customer/);
    }
    expect(ROLE_TEMPLATES['sales-development-rep'].description).not.toMatch(/books/);
  });
});

describe('independent Reviewer role', () => {
  // v0.9.92 (Owner): a verdict needs the checks behind it, and a review needs somewhere to be written. Independence
  // is the reviewer's instruction; no tool is withheld to enforce it.
  // v0.9.102 (design 6, 6.1): a reviewer may reproduce and add a test as its own contribution. If it changes the
  // implementation, its verdict no longer covers that change, and it still delivers, saying the change is unreviewed.
  it('exists, can run the checks its verdict rests on and write its report, and binds its verdict to what it reviewed', () => {
    const reviewer = ROLE_TEMPLATES.reviewer;
    expect(reviewer).toBeDefined();
    expect(reviewer.role).toBe('reviewer');
    expect([...reviewer.allowedTools].sort()).toEqual(['execute', 'message', 'read', 'search', 'write']);
    expect(reviewer.allowedTools).not.toContain('delegate');
    const prompt = reviewer.systemPrompt.replace(/\s+/g, ' ');
    expect(prompt).toContain('You may reproduce a problem and add a test or fixture that shows it.');
    expect(prompt).toContain('If you change it, your verdict no longer covers what you changed');
    expect(prompt).toContain('say plainly that the changed version is not yet independently reviewed');
    expect(prompt).toContain('Bind the verdict to what you reviewed');
    expect(prompt).not.toMatch(/never change the work you review/i);
    expect(reviewer.tier).toBe('standard');
  });
});

// v0.9.105 (S3, P0-MODEL): the model a role tier gives a new agent is one its connection lists, and so is every
// per-role override, so the picker can show the model an agent gets. Seven tier ids were missing before 0.9.105.
describe('every tier model and every role override is in its connection\'s static model list', () => {
  it('holds for each provider key of the tier table', () => {
    const missing: string[] = [];
    const listed = (providerKey: string): string[] => {
      const connectionId = connectionIdForProviderId(providerKey, BUILTIN_CONNECTION_REGISTRY);
      const models = connectionId ? connectionProfile(connectionId, BUILTIN_CONNECTION_REGISTRY)?.catalogModels : undefined;
      expect(models, providerKey).toBeDefined();
      return models!.map((model) => model.id);
    };
    for (const [tier, byProvider] of Object.entries(DEFAULT_MODEL_TIERS)) {
      for (const [providerKey, model] of Object.entries(byProvider)) {
        if (!listed(providerKey).includes(model)) missing.push(`${tier} ${providerKey} ${model}`);
      }
    }
    for (const [key, template] of Object.entries(ROLE_TEMPLATES)) {
      for (const [providerKey, model] of Object.entries(template.modelOverride ?? {})) {
        if (!listed(providerKey).includes(model)) missing.push(`override ${key} ${providerKey} ${model}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

// v0.9.106 (first use, Owner 2026-11-17): the three-person starter team is a project manager, a generalist who does the
// work and an independent reviewer. The generalist is a template key of its own on the runtime role `custom`; its tools
// are the union of Code Generation and Documentation, and its tier is the reviewer's, so the two get the same model.
describe('the starter team and its generalist', () => {
  it('names the project manager, the generalist and the reviewer, in that order', () => {
    expect(TEAM_PRESETS.starter.roles).toEqual(['pm', 'generalist', 'reviewer']);
    expect(TEAM_PRESETS.starter.label).toBe('Starter Team');
  });

  it('gives the generalist the union of Code Generation and Documentation, no delegation, on the standard tier', () => {
    const generalist = ROLE_TEMPLATES.generalist;
    expect(generalist.role).toBe('custom');
    expect(generalist.skills.map((skill) => skill.id)).toEqual(['code-generation', 'documentation']);
    const toolsOf = (id: string): string[] => (SKILL_LIBRARY[id].implementation as { tools?: string[] } | undefined)?.tools ?? [];
    const union = new Set([...toolsOf('code-generation'), ...toolsOf('documentation')]);
    expect([...generalist.allowedTools].sort()).toEqual([...union].sort());
    expect([...generalist.allowedTools].sort()).toEqual(['execute', 'message', 'read', 'search', 'write']);
    expect(generalist.allowedTools).not.toContain('delegate');
    expect(generalist.tier).toBe('standard');
    expect(generalist.tier).toBe(ROLE_TEMPLATES.reviewer.tier);
  });

  it('gives the generalist and the reviewer the same model on each built-in connection, from their tier', () => {
    for (const provider of ['unode', 'roam', 'openai', 'openrouter', 'anthropic', 'codex']) {
      const [pm, generalist, reviewer] = createTeam(['pm', 'generalist', 'reviewer'], provider);
      expect(generalist.model, provider).toBe(reviewer.model);
      expect(generalist.roleTemplateKey).toBe('generalist');
      expect(pm.role).toBe('pm');
    }
  });
});
