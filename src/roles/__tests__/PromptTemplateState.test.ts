import { describe, expect, it } from 'vitest';
import { AgentConfig } from '../../types';
import { ROLE_TEMPLATES } from '../RoleConfig';
import {
  SHIPPED_TEMPLATE_PROMPT_HASHES,
  adoptCurrentPromptTemplate,
  dismissPromptTemplateUpdate,
  migratePromptTemplateSource,
  promptTemplateHash,
  promptTemplateStatus,
  recordCustomRoleSave,
  recordSystemPromptSave,
  resolveRuntimeSystemPrompt,
  retainReplacedPrompt,
  templatePromptDiff,
  undoAdoptCurrentPromptTemplate,
} from '../PromptTemplateState';

function pm(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'pm',
    name: 'PM',
    role: 'pm',
    skill: 'project-management',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'm',
    systemPrompt: ROLE_TEMPLATES.pm.systemPrompt,
    autoApprove: false,
    allowedTools: ['delegate'],
    ...overrides,
  };
}

describe('prompt-template tracking', () => {
  it('refreshes a template-managed agent at runtime without touching its persisted frozen copy', () => {
    const config = pm({ systemPromptSource: 'template', systemPrompt: ROLE_TEMPLATES.pm.systemPrompt, playbooks: ['quality-gate-95'] });

    expect(resolveRuntimeSystemPrompt(config)).toBe(ROLE_TEMPLATES.pm.systemPrompt);
    expect(config.systemPrompt).toBe(ROLE_TEMPLATES.pm.systemPrompt);
    expect(config.playbooks).toEqual(['quality-gate-95']);
  });

  it('migrates a pre-existing shipped default to a newer template and preserves an uncertain customization verbatim', () => {
    const oldTemplate = ROLE_TEMPLATES.pm.systemPrompt;
    ROLE_TEMPLATES.pm.systemPrompt = `${oldTemplate}\n\nA newer shipped PM rule.`;
    try {
      // This unmarked config mirrors an agent created before the role-template change. Its old
      // prompt hash is in the shipped-default registry, so migration can refresh it safely.
      const untouched = pm({ systemPromptSource: undefined, systemPrompt: oldTemplate });
      const customized = pm({ systemPromptSource: undefined, systemPrompt: 'My carefully customized PM rules.' });

      expect(migratePromptTemplateSource(untouched)).toBe(true);
      expect(untouched.systemPromptSource).toBe('template');
      expect(untouched.systemPrompt).toContain('A newer shipped PM rule.');
      expect(migratePromptTemplateSource(customized)).toBe(true);
      expect(customized.systemPromptSource).toBe('custom');
      expect(customized.systemPrompt).toBe('My carefully customized PM rules.');
      expect(promptTemplateStatus(customized).state).toBe('custom-origin-unknown');
    } finally {
      ROLE_TEMPLATES.pm.systemPrompt = oldTemplate;
    }
  });

  it('never trusts stale template metadata over a hand edit in team.json', () => {
    const handwritten = 'My hand-written PM instruction: always ask before acting.';
    const config = pm({
      systemPrompt: handwritten,
      systemPromptSource: 'template',
      roleTemplateKey: 'pm',
    });

    expect(migratePromptTemplateSource(config)).toBe(true);
    expect(config.systemPrompt).toBe(handwritten);
    expect(config.systemPromptSource).toBe('custom');
    expect(promptTemplateStatus(config).state).toBe('custom-origin-unknown');
  });

  it('records a customization fork, reports only the template diff, and re-notifies after a new change', () => {
    const oldTemplate = ROLE_TEMPLATES.pm.systemPrompt;
    const config = pm({ systemPromptSource: 'template' });
    recordSystemPromptSave(config, 'My PM additions.');
    expect(config.systemPromptSource).toBe('custom');
    expect(config.systemPromptTemplateAtFork).toBe(oldTemplate);

    ROLE_TEMPLATES.pm.systemPrompt = `${oldTemplate}\n\nNew async delegation guidance.`;
    try {
      const status = promptTemplateStatus(config);
      expect(status.state).toBe('custom-outdated');
      expect(status.showUpdateNotice).toBe(true);
      const diff = templatePromptDiff(status.templateAtFork!, status.currentTemplate!.systemPrompt);
      expect(diff).toContain('+New async delegation guidance.');
      expect(diff).not.toContain('My PM additions.');

      expect(dismissPromptTemplateUpdate(config)).toBe(true);
      expect(promptTemplateStatus(config).showUpdateNotice).toBe(false);

      ROLE_TEMPLATES.pm.systemPrompt += '\nA newer guidance revision.';
      expect(promptTemplateStatus(config).showUpdateNotice).toBe(true);
    } finally {
      ROLE_TEMPLATES.pm.systemPrompt = oldTemplate;
    }
  });

  it('only adopts the current default explicitly and can undo back to the untouched custom prompt', () => {
    const config = pm({
      systemPromptSource: 'custom',
      systemPrompt: 'My exact custom PM prompt.',
      systemPromptTemplateAtFork: 'Old default guidance.',
    });

    expect(adoptCurrentPromptTemplate(config)).toBe(true);
    expect(config.systemPromptSource).toBe('template');
    expect(config.systemPrompt).toBe(ROLE_TEMPLATES.pm.systemPrompt);
    expect(undoAdoptCurrentPromptTemplate(config)).toBe(true);
    expect(config.systemPromptSource).toBe('custom');
    expect(config.systemPrompt).toBe('My exact custom PM prompt.');
    expect(config.systemPromptTemplateAtFork).toBe('Old default guidance.');
  });

  it('keeps Reset-to-template undo data when a later save did not change the prompt', () => {
    const config = pm({
      systemPromptSource: 'custom',
      systemPrompt: 'My valuable custom prompt.',
      systemPromptTemplateAtFork: 'Old default guidance.',
    });

    expect(adoptCurrentPromptTemplate(config)).toBe(true);
    const undo = config.systemPromptUndo;
    recordSystemPromptSave(config, config.systemPrompt);
    expect(config.systemPromptUndo).toEqual(undo);
    expect(undoAdoptCurrentPromptTemplate(config)).toBe(true);
    expect(config.systemPrompt).toBe('My valuable custom prompt.');
  });

  it('contains every current role template hash in the shipped registry', () => {
    for (const [key, template] of Object.entries(ROLE_TEMPLATES)) {
      expect(SHIPPED_TEMPLATE_PROMPT_HASHES[key]).toContain(promptTemplateHash(template.systemPrompt));
    }
  });

  it('uses a persisted key to resolve an SDR template rather than the first custom template', () => {
    const config = pm({
      role: 'custom',
      roleTemplateKey: 'sales-development-rep',
      systemPromptSource: 'template',
      systemPrompt: ROLE_TEMPLATES['sales-development-rep'].systemPrompt,
    });

    const status = promptTemplateStatus(config);
    expect(status.currentTemplate).toBe(ROLE_TEMPLATES['sales-development-rep']);
    expect(status.currentTemplate).not.toBe(ROLE_TEMPLATES['business-analyst']);
    expect(resolveRuntimeSystemPrompt(config)).toBe(ROLE_TEMPLATES['sales-development-rep'].systemPrompt);
  });

  it('shows a one-time review notice when a customization origin is unknown', () => {
    const config = pm({ systemPromptSource: 'custom', systemPrompt: 'An old prompt whose baseline is unavailable.' });
    expect(promptTemplateStatus(config).state).toBe('custom-origin-unknown');
    expect(promptTemplateStatus(config).showUpdateNotice).toBe(true);
    expect(dismissPromptTemplateUpdate(config)).toBe(true);
    expect(promptTemplateStatus(config).showUpdateNotice).toBe(false);
  });
});

describe('a role switch never makes a user-written prompt unrecoverable (red line)', () => {
  it('retains the replaced prompt for a BRAND-NEW agent, which has no prior config to fall back on', () => {
    // Field path: create a blank agent, hand-write Instructions, then pick a role (which adopts the role's
    // template), then Save without clicking Restore. The replaced text lived only in webview memory, so it
    // died with the panel — and a new agent has no earlier saved copy either. It was gone for good.
    const handWritten = '我手写的指令：永远先问我再动手。';
    const config = pm({ systemPrompt: ROLE_TEMPLATES.pm.systemPrompt, roleTemplateKey: 'pm' });

    expect(retainReplacedPrompt(config, handWritten)).toBe(true);
    expect(config.systemPromptUndo?.prompt).toBe(handWritten);
    expect(undoAdoptCurrentPromptTemplate(config)).toBe(true);
    expect(config.systemPrompt).toBe(handWritten);
  });

  it('does not invent an undo record when nothing was actually replaced', () => {
    const config = pm({ roleTemplateKey: 'pm' });
    expect(retainReplacedPrompt(config, undefined)).toBe(false);
    expect(retainReplacedPrompt(config, '   ')).toBe(false);
    expect(retainReplacedPrompt(config, config.systemPrompt)).toBe(false);   // user typed it back by hand
    expect(config.systemPromptUndo).toBeUndefined();
  });
});

describe('an explicitly chosen Custom role is never reinterpreted as a shipped template', () => {
  it('keeps Custom even when the instructions still match a shipped default exactly', () => {
    // Field path: new agent → pick Senior Developer → pick "Custom role" without editing the text → Save.
    // The prompt still equals the Senior Developer default, so template inference matched it and silently
    // handed the agent that role's identity back: it reopened as Senior Developer and ran on its template.
    const seniorDev = ROLE_TEMPLATES['senior-dev'];
    const config = pm({
      role: 'CEO' as AgentConfig['role'],   // an explicit custom role name
      systemPrompt: seniorDev.systemPrompt,
      roleTemplateKey: undefined,
    });

    recordCustomRoleSave(config, seniorDev.systemPrompt);

    expect(config.systemPromptSource).toBe('custom');
    expect(config.roleTemplateKey).toBeUndefined();
    expect(promptTemplateStatus(config).state).toBe('custom-no-template');
    expect(resolveRuntimeSystemPrompt(config)).toBe(seniorDev.systemPrompt);   // its own text, not a template

    // …and it must still be Custom after a reload, i.e. a migration pass must not reclaim it.
    migratePromptTemplateSource(config);
    expect(config.systemPromptSource).toBe('custom');
    expect(config.roleTemplateKey).toBeUndefined();
  });

  it('clears a template identity the agent used to carry', () => {
    const config = pm({ roleTemplateKey: 'pm', systemPromptSource: 'template' });
    recordCustomRoleSave(config, 'Only my words now.');
    expect(config.roleTemplateKey).toBeUndefined();
    expect(config.systemPromptSource).toBe('custom');
    expect(config.systemPromptTemplateAtFork).toBeUndefined();
    expect(config.systemPrompt).toBe('Only my words now.');
  });
});
