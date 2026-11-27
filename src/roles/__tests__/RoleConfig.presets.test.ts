import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  ROLE_TEMPLATES,
  TEAM_PRESETS,
  USING_SUPERPOWERS_PLAYBOOK,
  PROMPT_LEVEL_ROLE_VARIANT_PAIRS,
  createTeam,
} from '../RoleConfig';

const withSuperpowers = (playbooks: string[]) => [USING_SUPERPOWERS_PLAYBOOK, ...playbooks];

const EXISTING_TEMPLATE_IDENTITIES = {
  'product-manager': { name: 'Product Manager', role: 'product-manager' },
  architect: { name: 'System Architect', role: 'architect' },
  'senior-dev': { name: 'Senior Developer', role: 'senior-dev' },
  tester: { name: 'QA Engineer', role: 'tester' },
  devops: { name: 'DevOps Engineer', role: 'devops' },
  'tech-writer': { name: 'Technical Writer', role: 'tech-writer' },
  pm: { name: 'Project Manager', role: 'pm' },
  security: { name: 'Security Engineer', role: 'security' },
  'data-engineer': { name: 'Data Engineer', role: 'data-engineer' },
  reviewer: { name: 'Reviewer', role: 'reviewer' },
  solo: { name: 'Solo', role: 'solo' },
  'business-analyst': { name: 'Business Analyst', role: 'custom' },
  'market-researcher': { name: 'Market Researcher', role: 'custom' },
  'financial-analyst': { name: 'Financial Analyst', role: 'custom' },
  'strategy-lead': { name: 'Strategy Lead', role: 'custom' },
  'content-strategist': { name: 'Content Strategist', role: 'custom' },
  'growth-marketer': { name: 'Growth Marketer', role: 'custom' },
  'seo-analyst': { name: 'SEO & Analytics Specialist', role: 'custom' },
  'sales-development-rep': { name: 'Sales Development Rep', role: 'custom' },
  'account-executive': { name: 'Account Executive', role: 'custom' },
  'sales-engineer': { name: 'Sales Engineer', role: 'custom' },
  'customer-success-manager': { name: 'Customer Success Manager', role: 'custom' },
} as const;

const NEW_ROLE_KEYS = [
  'ux-researcher', 'product-designer', 'product-analyst', 'frontend-engineer', 'backend-api-engineer',
  'mobile-engineer', 'sre', 'performance-engineer', 'application-security-engineer',
  'cloud-security-engineer', 'privacy-data-protection-officer', 'grc-analyst', 'data-analyst',
  'ai-ml-engineer', 'knowledge-manager', 'customer-support-agent', 'technical-support-engineer',
  'support-operations-analyst', 'conversation-designer', 'brand-strategist', 'lifecycle-crm-marketer',
  'revenue-operations-analyst', 'partner-channel-manager', 'workflow-automation-specialist', 'fpa-analyst',
  'procurement-analyst', 'program-manager', 'developer-advocate', 'localization-i18n-specialist',
] as const;

const EXISTING_PRESET_IDENTITIES = {
  'bugfix-crew': { label: 'Bugfix Crew', kind: 'pack', roles: ['pm', 'senior-dev', 'reviewer'] },
  'refactor-crew': { label: 'Refactor Crew', kind: 'pack', roles: ['pm', 'architect', 'senior-dev', 'reviewer'] },
  'test-writer-crew': { label: 'Test Writer Crew', kind: 'pack', roles: ['pm', 'tester', 'reviewer'] },
  'release-crew': { label: 'Release Crew', kind: 'pack', roles: ['pm', 'senior-dev', 'devops', 'reviewer'] },
  'security-review-crew': { label: 'Security Review Crew', kind: 'pack', roles: ['pm', 'security', 'reviewer'] },
  'business-planning': { label: 'Business Planning', kind: 'knowledge', roles: ['pm', 'strategy-lead', 'market-researcher', 'financial-analyst'] },
  'business-analysis': { label: 'Business Analysis', kind: 'knowledge', roles: ['pm', 'business-analyst', 'market-researcher'] },
  'financial-analysis': { label: 'Financial Analysis', kind: 'knowledge', roles: ['pm', 'financial-analyst', 'business-analyst'] },
  marketing: { label: 'Marketing', kind: 'knowledge', roles: ['pm', 'content-strategist', 'growth-marketer', 'market-researcher', 'seo-analyst'] },
  sales: { label: 'Sales', kind: 'knowledge', roles: ['pm', 'sales-development-rep', 'account-executive', 'sales-engineer', 'customer-success-manager'] },
} as const;

const NEW_PRESETS = {
  'product-discovery': { kind: 'knowledge', roles: ['pm', 'product-manager', 'business-analyst', 'ux-researcher', 'product-analyst', 'market-researcher'] },
  'experience-design': { kind: 'knowledge', roles: ['pm', 'product-designer', 'ux-researcher', 'frontend-engineer', 'conversation-designer'] },
  'full-stack-delivery': { kind: 'software', roles: ['pm', 'architect', 'senior-dev', 'frontend-engineer', 'backend-api-engineer', 'reviewer'] },
  'mobile-quality': { kind: 'software', roles: ['pm', 'mobile-engineer', 'tester', 'reviewer', 'performance-engineer'] },
  'reliability-engineering': { kind: 'software', roles: ['pm', 'devops', 'sre', 'performance-engineer', 'cloud-security-engineer'] },
  'security-governance': { kind: 'software', roles: ['pm', 'security', 'application-security-engineer', 'cloud-security-engineer', 'privacy-data-protection-officer', 'grc-analyst'] },
  'data-intelligence': { kind: 'knowledge', roles: ['pm', 'data-engineer', 'data-analyst', 'ai-ml-engineer', 'knowledge-manager', 'market-researcher'] },
  'customer-experience': { kind: 'knowledge', roles: ['pm', 'customer-success-manager', 'customer-support-agent', 'technical-support-engineer', 'support-operations-analyst', 'conversation-designer'] },
  'revenue-operations': { kind: 'knowledge', roles: ['pm', 'sales-development-rep', 'account-executive', 'sales-engineer', 'revenue-operations-analyst', 'partner-channel-manager'] },
  'brand-lifecycle': { kind: 'knowledge', roles: ['pm', 'content-strategist', 'growth-marketer', 'seo-analyst', 'brand-strategist', 'lifecycle-crm-marketer'] },
  'business-operations': { kind: 'knowledge', roles: ['pm', 'strategy-lead', 'financial-analyst', 'workflow-automation-specialist', 'fpa-analyst', 'procurement-analyst'] },
  'enablement-localization': { kind: 'knowledge', roles: ['pm', 'product-manager', 'tech-writer', 'program-manager', 'developer-advocate', 'localization-i18n-specialist'] },
} as const;

const NON_PROFESSIONAL_ROLE_KEYS = new Set(['solo']);

function skillIdsOnDisk(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  // A skill's pinned upstream SKILL.md resources are data, not additional published skills.
  if (entries.some(entry => entry.isFile() && entry.name === 'SKILL.md')) return [basename(directory)];
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return skillIdsOnDisk(path);
    return entry.name === 'SKILL.md' ? [basename(directory)] : [];
  });
}

describe('team presets', () => {
  it('preserves every pre-C4 role and preset identity while adding the approved catalog', () => {
    for (const [key, expected] of Object.entries(EXISTING_TEMPLATE_IDENTITIES)) {
      const template = ROLE_TEMPLATES[key];
      expect(template, `${key} must remain a shipped template`).toBeDefined();
      expect({ name: template.name, role: template.role }, `${key} identity`).toEqual(expected);
      expect(template.systemPrompt).toBeTruthy();
    }
    for (const [key, expected] of Object.entries(EXISTING_PRESET_IDENTITIES)) {
      const preset = TEAM_PRESETS[key];
      expect(preset, `${key} must remain a shipped preset`).toBeDefined();
      expect({ label: preset.label, kind: preset.kind, roles: preset.roles }, `${key} identity`).toEqual(expected);
    }
    expect(NEW_ROLE_KEYS).toHaveLength(29);
    // Hardware Technical Analyst extends the 52-role catalog with a reusable procurement specialist.
    // v0.9.106: the starter team's Generalist extends it to 54.
    expect(Object.keys(ROLE_TEMPLATES)).toHaveLength(54);
    // Software Engineering Team was added after this catalog contract; retain the total so a preset
    // cannot disappear silently while the per-preset identity assertions above keep the old catalog stable.
    // Hardware Procurement extends the 25-preset catalog.
    // v0.9.106: the three-person Starter Team extends it to 27.
    expect(Object.keys(TEAM_PRESETS)).toHaveLength(27);
  });

  it('derives the professional catalog from the explicit non-professional exemption', () => {
    const allRoleKeys = Object.keys(ROLE_TEMPLATES);
    const professionalRoleKeys = allRoleKeys.filter((key) => !NON_PROFESSIONAL_ROLE_KEYS.has(key));
    expect(professionalRoleKeys).toHaveLength(allRoleKeys.length - NON_PROFESSIONAL_ROLE_KEYS.size);
    expect(NON_PROFESSIONAL_ROLE_KEYS).toEqual(new Set(['solo']));
  });

  it('defines every new specialist with a real capability, prompt, description, and playbooks', () => {
    for (const key of NEW_ROLE_KEYS) {
      const template = ROLE_TEMPLATES[key];
      expect(template, `${key} must exist`).toBeDefined();
      expect(template.skill).toBeTruthy();
      expect(template.skills.length, `${key} must have capability skills`).toBeGreaterThan(0);
      expect(template.systemPrompt.trim(), `${key} must have a system prompt`).toBeTruthy();
      expect(template.description?.trim(), `${key} must have a description`).toBeTruthy();
      expect(template.playbooks?.length, `${key} must have playbooks`).toBeGreaterThan(1);
    }
  });

  it('defines the twelve new presets exactly as approved and every professional role is reusable from a preset', () => {
    for (const [key, expected] of Object.entries(NEW_PRESETS)) {
      expect(TEAM_PRESETS[key]).toMatchObject(expected);
      expect(TEAM_PRESETS[key].roles).toEqual(expected.roles);
    }
    const presetRoles = new Set(Object.values(TEAM_PRESETS).flatMap((preset) => preset.roles));
    for (const role of Object.keys(ROLE_TEMPLATES)) {
      if (!NON_PROFESSIONAL_ROLE_KEYS.has(role)) {
        expect(presetRoles, `${role} must belong to at least one preset`).toContain(role);
      }
    }
  });

  it('covers every shipped SKILL.md discovered from the real skills tree', () => {
    const shippedSkillIds = skillIdsOnDisk(join(process.cwd(), 'skills')).sort();
    // 51 with v0.9.53: six contract/compliance playbooks filling the gaps a market review named, plus
    // design-system, breakpoint and technical-SEO review for the website team. 57 with v0.9.106: six adapted
    // upstream skills (frontend-design, internal-comms, webapp-testing, mcp-builder, security-threat-model,
    // gh-fix-ci), each attached to the roles the skills spec names.
    expect(shippedSkillIds).toHaveLength(59);
    const attachedPlaybooks = new Set(Object.values(ROLE_TEMPLATES).flatMap((template) => template.playbooks ?? []));
    // New Office resources are available by explicit grant; do not silently migrate role playbooks.
    expect(shippedSkillIds.filter(skillId => !attachedPlaybooks.has(skillId))).toEqual(['docx', 'pptx']);
    for (const skillId of shippedSkillIds.filter(skillId => !['docx', 'pptx'].includes(skillId))) {
      expect(attachedPlaybooks, `${skillId} must be attached to a template`).toContain(skillId);
    }
    for (const previouslyUnassigned of [
      'accessibility-audit', 'component-a11y', 'api-error-handling', 'openapi-lint', 'perf-budget-audit',
      'positioning-and-messaging', 'claim-sourcing-and-citation', 'dependency-risk-triage',
    ]) {
      expect(attachedPlaybooks).toContain(previouslyUnassigned);
    }
    expect(attachedPlaybooks).toContain('executing-plans');
  });

  // v0.9.106 (skills spec 2, R8): each adapted upstream skill is a default playbook of exactly the roles the spec names.
  // No live role prompt names one of them; an agent finds its playbooks through their names and descriptions.
  it('attaches the six adapted skills to exactly the named roles, and no role prompt names them', () => {
    const expected: Record<string, string[]> = {
      'frontend-design': ['frontend-engineer', 'product-designer'],
      'internal-comms': ['content-strategist', 'program-manager', 'tech-writer'],
      'webapp-testing': ['frontend-engineer', 'tester'],
      'mcp-builder': ['backend-api-engineer', 'workflow-automation-specialist'],
      'security-threat-model': ['application-security-engineer', 'architect', 'security'],
      'gh-fix-ci': ['devops', 'sre', 'tester'],
    };
    for (const [skill, roles] of Object.entries(expected)) {
      const carriers = Object.entries(ROLE_TEMPLATES).filter(([, t]) => t.playbooks?.includes(skill)).map(([key]) => key).sort();
      expect(carriers, `${skill} roles`).toEqual(roles);
      for (const role of roles) expect(createTeam([role as keyof typeof ROLE_TEMPLATES])[0].playbooks).toContain(skill);
    }
    for (const [key, template] of Object.entries(ROLE_TEMPLATES)) {
      for (const skill of Object.keys(expected)) {
        expect(template.systemPrompt.includes(skill), `${key} prompt names ${skill}`).toBe(false);
      }
    }
  });

  it('makes PM the sole delegator and locks final tools for privileged role classes', () => {
    for (const [key, template] of Object.entries(ROLE_TEMPLATES)) {
      expect(template.allowedTools.includes('delegate'), `${key} must not delegate by default`).toBe(key === 'pm');
    }
    const expectedTools: Record<string, string[]> = {
      'program-manager': ['execute', 'message', 'read', 'search', 'write'],
      'workflow-automation-specialist': ['execute', 'message', 'read', 'search', 'write'],
      'product-analyst': ['execute', 'message', 'read', 'search', 'write'],
      'support-operations-analyst': ['execute', 'message', 'read', 'search', 'write'],
      'revenue-operations-analyst': ['execute', 'message', 'read', 'search', 'write'],
      'fpa-analyst': ['execute', 'message', 'read', 'search', 'write'],
      'developer-advocate': ['execute', 'message', 'read', 'search', 'write'],
      'application-security-engineer': ['execute', 'message', 'read', 'search', 'write'],
      'privacy-data-protection-officer': ['execute', 'message', 'read', 'search', 'write'],
      'grc-analyst': ['execute', 'message', 'read', 'search', 'write'],
      'frontend-engineer': ['execute', 'message', 'read', 'search', 'write'],
      'backend-api-engineer': ['execute', 'message', 'read', 'search', 'write'],
      'mobile-engineer': ['execute', 'message', 'read', 'search', 'write'],
      'sre': ['execute', 'message', 'read', 'search', 'write'],
      'performance-engineer': ['execute', 'message', 'read', 'search', 'write'],
      'ai-ml-engineer': ['execute', 'message', 'read', 'search', 'write'],
    };
    for (const [key, expected] of Object.entries(expectedTools)) {
      expect([...ROLE_TEMPLATES[key].allowedTools].sort(), `${key} final tools`).toEqual(expected);
    }
    // CAP-1: drafting roles may request commands; execution approval remains a separate live gate.
    for (const key of [
      'customer-support-agent', 'conversation-designer', 'brand-strategist',
      'lifecycle-crm-marketer', 'partner-channel-manager', 'procurement-analyst',
    ]) {
      expect(ROLE_TEMPLATES[key].allowedTools).toContain('execute');
      expect(ROLE_TEMPLATES[key].allowedTools).not.toContain('delegate');
    }
  });

  // v0.9.92 (Owner, 2026-10-02): a role holds the tools its own work needs. The rule this test used to apply,
  // least privilege, left sixteen roles unable to run the checks or the calculations their own text promises.
  it('gives every new catalog role the tools its own work needs, and no others', () => {
    // Implementation and diagnostics; verification of documents, examples and security findings; and figures
    // that have to be calculated rather than asserted.
    // Every role writes its deliverable. The security and governance reviewers write their findings as a report
    // and are told not to change what they review; no role is without Write files.
    const readOnly = new Set<string>();

    for (const key of NEW_ROLE_KEYS) {
      const tools = ROLE_TEMPLATES[key].allowedTools;
      expect(tools.includes('delegate'), `${key} must not delegate`).toBe(false);
      expect(tools.includes('execute'), `${key} execute capability`).toBe(true);
      expect(tools.includes('write'), `${key} write capability`).toBe(!readOnly.has(key));
    }
  });

  it('declares the intended prompt-level variants and no accidental duplicate specialist configurations', () => {
    const keyForConfig = (key: string) => {
      const template = ROLE_TEMPLATES[key];
      return JSON.stringify({
        skills: template.skills.map((skill) => skill.id).sort(),
        playbooks: [...(template.playbooks ?? [])].sort(),
        tools: [...template.allowedTools].sort(),
        tier: template.tier,
      });
    };
    const duplicateGroups = new Map<string, string[]>();
    for (const key of NEW_ROLE_KEYS) {
      const config = keyForConfig(key);
      duplicateGroups.set(config, [...(duplicateGroups.get(config) ?? []), key]);
    }
    const actualPairs = [...duplicateGroups.values()]
      .filter((keys) => keys.length > 1)
      .map((keys) => [...keys].sort())
      .sort((a, b) => a.join('/').localeCompare(b.join('/')));
    const declaredPairs = PROMPT_LEVEL_ROLE_VARIANT_PAIRS
      .map((keys) => [...keys].sort())
      .sort((a, b) => a.join('/').localeCompare(b.join('/')));
    expect(actualPairs).toEqual(declaredPairs);
    for (const [first, second] of PROMPT_LEVEL_ROLE_VARIANT_PAIRS) {
      expect(ROLE_TEMPLATES[first].systemPrompt).not.toBe(ROLE_TEMPLATES[second].systemPrompt);
    }
  });

  it('every preset starts with the PM and only references real role templates', () => {
    for (const [key, preset] of Object.entries(TEAM_PRESETS)) {
      expect(preset.roles[0], `${key} must start with pm`).toBe('pm');
      for (const role of preset.roles) {
        expect(ROLE_TEMPLATES[role], `${role} must exist`).toBeDefined();
      }
    }
  });

  it('builds each preset team with the right number of agents, all message-capable', () => {
    for (const preset of Object.values(TEAM_PRESETS)) {
      const team = createTeam(preset.roles, 'roam');
      expect(team).toHaveLength(preset.roles.length);
      for (const agent of team) {
        expect(agent.allowedTools.length).toBeGreaterThan(0);
        expect(agent.allowedTools).toContain('message');
      }
    }
  });

  it('equips software roles with progressively loaded SKILL.md playbooks', () => {
    const expected: Record<string, string[]> = {
      pm: withSuperpowers([
        'task-decomposition',
        'acceptance-criteria-authoring',
        'recent-activity-scan',
        'brainstorming-to-spec',
        'writing-implementation-plans',
        'dispatching-parallel-agents',
        'proactive-gap-capture',
        'quality-gate-95',
        'draft-only-external-actions',
        'verification-before-completion',
      ]),
      architect: withSuperpowers(['api-contract-review', 'api-versioning-semver', 'brainstorming-to-spec', 'writing-implementation-plans', 'security-threat-model']),
      'senior-dev': withSuperpowers([
        'systematic-debugging',
        'test-driven-development',
        'mutation-validation',
        'verification-before-completion',
        'requesting-code-review',
        'root-cause-analysis',
        'commit-message-quality',
      ]),
      reviewer: withSuperpowers(['pr-review-checklist', 'diff-risk-triage', 'verification-before-completion', 'quality-gate-95']),
      tester: withSuperpowers(['test-driven-development', 'test-coverage-gap', 'flaky-test-triage', 'verification-before-completion', 'webapp-testing', 'gh-fix-ci']),
      security: withSuperpowers(['owasp-top10-review', 'secrets-scanning', 'authz-check', 'quality-gate-95', 'verification-before-completion', 'security-threat-model']),
      devops: withSuperpowers(['dockerfile-best-practices', 'ci-pipeline-review', 'artifact-hash-verification', 'draft-only-external-actions', 'verification-before-completion', 'gh-fix-ci']),
      'data-engineer': withSuperpowers(['data-quality-checks', 'schema-migration-safety', 'verification-before-completion']),
      'tech-writer': withSuperpowers(['documentation-lint', 'readme-quickstart-quality', 'internal-comms']),
    };
    for (const [role, playbooks] of Object.entries(expected)) {
      expect(ROLE_TEMPLATES[role].playbooks).toEqual(playbooks);
      expect(createTeam([role as keyof typeof ROLE_TEMPLATES])[0].playbooks).toEqual(playbooks);
    }
  });

  it('defines the five task packs with verify commands', () => {
    const packs = Object.values(TEAM_PRESETS).filter((p) => p.kind === 'pack');
    expect(packs.map((p) => p.label)).toEqual([
      'Bugfix Crew',
      'Refactor Crew',
      'Test Writer Crew',
      'Release Crew',
      'Security Review Crew',
    ]);
    for (const pack of packs) {
      expect(pack.description).toBeTruthy();
      expect(pack.verifyCommand).toBeTruthy();
    }
  });

  it('new specialist templates derive their tools from skills and never get delegate', () => {
    for (const key of ['business-analyst', 'market-researcher', 'financial-analyst', 'strategy-lead']) {
      const t = ROLE_TEMPLATES[key];
      expect(t).toBeDefined();
      expect(t.systemPrompt.length).toBeGreaterThan(0);
      expect(t.allowedTools).not.toContain('delegate');
      expect(t.playbooks).toContain(USING_SUPERPOWERS_PLAYBOOK);
    }
  });

  // v0.9.102 (design 2.1, 5): the PM template is a work contract. How to delegate (dispatch_task, end the turn while
  // only asynchronous results remain) comes from the runtime rules, which reach every PM, old or new. The template names
  // no tool the PM no longer has, and the lead does a small task itself.
  it('leaves the delegation mechanics to the runtime rules and names no removed tool', () => {
    const prompt = ROLE_TEMPLATES.pm.systemPrompt;
    expect(prompt).not.toMatch(/\bassign_task(_async)?\b|\bawait_tasks\b/);
    for (const tool of ['list_agents', 'update_todos', 'run_checks', 'broadcast']) expect(prompt).toContain(tool);
    expect(prompt).toContain('A small task that is clear, do yourself.');
    expect(prompt).not.toMatch(/Do not attempt coding tasks yourself/i);
  });

  it('forbids the PM only a redundant look at the roster, and sends it back there after a no-match refusal', () => {
    const prompt = ROLE_TEMPLATES.pm.systemPrompt.replace(/\s+/g, ' ');
    // The host tells a coordinator whose dispatch matched nobody to call list_agents. A template that forbade a
    // second call without exception would contradict it, and the model would follow one of the two.
    expect(prompt).not.toMatch(/EXACTLY ONCE/i);
    expect(prompt).not.toMatch(/do not call list_agents (a second time|again|twice)/i);
    expect(prompt).not.toMatch(/never (call|re-?list)[^.]*list_agents/i);
    // Redundant polling is still out.
    expect(prompt).toContain('Do not re-list to "check the team" or to re-check availability');
    // The lookup is allowed where it has a reason, in the lean path and in the full process.
    expect(prompt).toContain('If a dispatch is refused because no teammate matches the target you named, that is the time to look at the roster again: call list_agents and retry with the exact id it shows.');
    expect(prompt).toContain('Look again only for a reason: a dispatch was refused because no teammate matches the target you named, or the references you hold cannot tell you which teammate you need. Then call list_agents and retry with the exact id it shows.');
  });
});
