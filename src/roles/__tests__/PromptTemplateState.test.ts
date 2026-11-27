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
    const config = pm({ roleTemplateKey: 'pm', systemPromptSource: 'template', systemPrompt: ROLE_TEMPLATES.pm.systemPrompt, playbooks: ['quality-gate-95'] });

    expect(resolveRuntimeSystemPrompt(config)).toBe(ROLE_TEMPLATES.pm.systemPrompt);
    expect(config.systemPrompt).toBe(ROLE_TEMPLATES.pm.systemPrompt);
    expect(config.playbooks).toEqual(['quality-gate-95']);
  });

  it('does not invent template provenance for pre-existing agents without a recorded key', () => {
    const oldTemplate = ROLE_TEMPLATES.pm.systemPrompt;
    ROLE_TEMPLATES.pm.systemPrompt = `${oldTemplate}\n\nA newer shipped PM rule.`;
    try {
      // Both records predate explicit template identity. A matching role or shipped prompt hash is
      // not evidence that the user created either agent from that template.
      const untouched = pm({ systemPromptSource: undefined, systemPrompt: oldTemplate });
      const customized = pm({ systemPromptSource: undefined, systemPrompt: 'My carefully customized PM rules.' });

      expect(migratePromptTemplateSource(untouched)).toBe(true);
      expect(untouched.systemPromptSource).toBe('custom');
      expect(untouched.systemPrompt).toBe(oldTemplate);
      expect(untouched.roleTemplateKey).toBeUndefined();
      expect(promptTemplateStatus(untouched).state).toBe('custom-no-template');
      expect(migratePromptTemplateSource(customized)).toBe(true);
      expect(customized.systemPromptSource).toBe('custom');
      expect(customized.systemPrompt).toBe('My carefully customized PM rules.');
      expect(promptTemplateStatus(customized).state).toBe('custom-no-template');
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
    const config = pm({ roleTemplateKey: 'pm', systemPromptSource: 'template' });
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
      roleTemplateKey: 'pm',
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
      roleTemplateKey: 'pm',
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
    const config = pm({ roleTemplateKey: 'pm', systemPromptSource: 'custom', systemPrompt: 'An old prompt whose baseline is unavailable.' });
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

// v0.9.102 R2 (design 7): every role prompt changed, and the text an existing agent holds must still prove it was
// shipped, so that agent gets the new text instead of being treated as custom.
describe('the 0.9.101 role prompts stay recognised after the 0.9.102 rewrite', () => {
  // SHA-256 of each role prompt as published in 0.9.101 (68e4cca7).
  const PUBLISHED_0_9_101: Record<string, string> = {
    'product-manager': '7d4d90191c7e8de182420b0ff6b3b8b354af1efacc70ba0f8d1b7e143e810511',
    'architect': 'ab44ed5f6c7400d8bd679567c691f69538c9b0885abc6f73074768fc9969ca40',
    'senior-dev': '280d3596011017c9e94308ac74123e8f76f2cd3a57be259a9e6917cf8c524b90',
    'tester': 'b07c9fdde39378b316956c2c8ffafa8a13b42f4c1d05dbe05e57ad8c849ddbd3',
    'devops': '402f78d5f208262cbfb3c05233450156224dbcd24d682c8a32c461369aa34cf4',
    'tech-writer': '100d2e0a5b7119520cf181c45fe3cac7565c864d701055287bfea92d80da8cf9',
    'pm': '01ab9fedbf26ae3e3224e0d49e35e0447e5cc45a345bb08405ca35bad2ad9970',
    'security': '0baf0ad8fda071eee063ec0a5f3b8673f1e7f7d3d31fe4bd1a08abc10521384d',
    'data-engineer': '879fdb11c6a3ee783a4b6dbd8a22225ac530206d25bd584f85c367f9a2ff5b1a',
    'reviewer': '4317fbaaeef2bbb2dda2e1a3fde378f90e6bde8e8157ffc458ae6e9a631f8b85',
    'solo': 'd1cc9ec68adccbbce05445b4c2006a87297ec94c3b1d9b0d60f8f9ef3902f7d9',
    'business-analyst': 'eeb7e82191da09590894a19b53978adfd2cc9bd8ede941f8136ee580807294bf',
    'market-researcher': '8c8cfbaba5b774be99b4ac078dd8c08f3971c127f2d6db9993fe72397c5bdd1b',
    'financial-analyst': '4364a887e24402ec612ff083816b0f12d25e49d9e2a44355221b147e50e15811',
    'strategy-lead': 'c632a7f0b20dfdc3d26066e15c6de0f1c32027173e3d7808243f86ce93ab99da',
    'content-strategist': 'db48735f1864a651f7bf2aa013e4b0e8f6bc34a6f4cf934168c98710320f586e',
    'growth-marketer': 'd22bea26472d564ac17ce8958850a6f4a08af1936cde383423e32b0c03ff5273',
    'seo-analyst': '9535bce531c07d799b445f3834838382ec561c2f130cf0c0d655906d3e67132a',
    'sales-development-rep': '4c29f7229e3ee0b7775cd053e58ae1ea86bc94f5c9c46dfb66c770e7ca052493',
    'account-executive': '9e9887ae7f278707ae8139ac457a9904a62db6d012ca35ddc4382848ebde2b4c',
    'sales-engineer': 'a7bfd244c73f66ee477e26b28d3d1c77438b137215332cd8583d84d9c489aef0',
    'customer-success-manager': '6446d08f77d393200d7bba1d937a198db12d9fa713f674489e42ff5533047804',
    'ux-researcher': '2964930ed00c586ef538f1a6c795a609b86d8370a2b8495ed35fcd00a4d60ace',
    'product-designer': 'fbddedaa9c853849859769d6b892fb0204ed5e8ada321c74216b32fc04732c59',
    'product-analyst': '722a014eae3dd953ac17c3f1b0cfb01ee51662b02951e4f34a921cc784bf5cfb',
    'frontend-engineer': '22baa44e5b08eeb29d3a4c270a2059e85b86441a5e32ef6f0d581cb985fd73f8',
    'backend-api-engineer': '243799145620aec20ec04ee62f3ff9bcab6dc7efb708f92f3a4c8ed328829d6a',
    'mobile-engineer': '17961e905d489daadb5c61a3ddfbf57b414a932b87e66d00c84871287b5e3b3e',
    'sre': '82ad80f4a37b4ea535c23560d305b70c485b669a58f53838e090bf5c14c65dee',
    'performance-engineer': 'ce58bca722f798b0f758f495451e365b061da883e060757dbb9a892f84c70f5f',
    'application-security-engineer': '949ee90720ae2ae284d282df335a3445190082662b6406d0455cd682f9e2509d',
    'cloud-security-engineer': '66a25b2b424edb6e5038cbe67d65c51b9e77627b180e4275a5398c93b1e6d180',
    'contract-analyst': 'dbffc07a8380b36496abb7a6172995a5efa1b394dbf754ddc030bc47b551c2a9',
    'privacy-data-protection-officer': 'df634ae9f00ba3bace2fe5448ceec70fc2fb0bf9e0b549943dc5c1280d24ddfa',
    'grc-analyst': '87bbc431d2390a2514b46c691e325ea34c0ae05a9afa351b58e01fc968783f25',
    'data-analyst': 'c7986f3551cc4dcf057d868f10e3702db3f53d7aca8318a2fc93999cff2b1540',
    'ai-ml-engineer': '587accd64b0aa10113ffffcda2f58519b123aadd5728cc51b4a95badce01728b',
    'knowledge-manager': '75976cebe7b4b7b3ecf58c002aea06be2bef144ce5bdec2c73e3c914d45e7922',
    'customer-support-agent': '109e04275a1d1bb0d3bcbb06968e63b7138026d61f9c47f6cf60b6f42a412d7a',
    'technical-support-engineer': '050727897bc425b9c0aa3574a7ac89544fcaa2040452b4a3d86632cef872776c',
    'support-operations-analyst': 'e7bacc1c3c8683de7071c04d81efb4476c2a38d3402e6cfcd6b2fbebd42f7db4',
    'conversation-designer': 'a42f0c3c1a7bbeccf722b9a43488eda87d13c74e571b8c8c06166d805524d1f6',
    'brand-strategist': '75070cc3974ee854da7bab432f622380e7a0bc81c82038f4d5ee6643ac5e230f',
    'lifecycle-crm-marketer': '60a66edef5dd6b5bd513ebae7cc9076e5e540b8177399c1719d747a0dbd6f5ec',
    'revenue-operations-analyst': '259a10f30ea528d683a4703a3bed3a427fccecb8c381ac58770fd6103e829fc3',
    'partner-channel-manager': '9f5e18f33a87ba6b3a7e9c8ce0e5f5e1fd58b25bd0d9cab6664c89b5c5aac9b3',
    'workflow-automation-specialist': 'a50e5693c8bd9efba0fd265def948f8f9c133a068d88b3e406e0e64db4b75ea9',
    'fpa-analyst': '6f9c7ca044a9add41a0feb4d8b9755587e65eaaf17622f092be22f8293cc3ea5',
    'procurement-analyst': 'dc0d3d2d3fb60351d25c1761ddccc49382c1be792df7ab4cf02e9331c7b6c1d1',
    'program-manager': '9e388944eee636d4ae11445364620473e1de42074404ce58546a4fba8e1a0e87',
    'developer-advocate': 'ce45202823f188bab19e69a333359481440369bbb365eeb2627f861312298c81',
    'localization-i18n-specialist': 'f24ca3d2cbafedd1bc6edc4025ebe360b04286613c1ac553138759a05e2f2056',
  };

  it('keeps the hash of every 0.9.101 prompt, and registers the new one', () => {
    // Roles first shipped after 0.9.101 (0.9.102: Hardware Technical Analyst; 0.9.106: Generalist) had no 0.9.101
    // prompt; their current hash is checked above.
    const NEW_IN_0_9_102 = ['hardware-technical-analyst', 'generalist'];
    expect(Object.keys(PUBLISHED_0_9_101).sort()).toEqual(Object.keys(ROLE_TEMPLATES).filter((key) => !NEW_IN_0_9_102.includes(key)).sort());
    for (const [key, hash] of Object.entries(PUBLISHED_0_9_101)) {
      expect(SHIPPED_TEMPLATE_PROMPT_HASHES[key], key).toContain(hash);
      const current = promptTemplateHash(ROLE_TEMPLATES[key].systemPrompt);
      expect(current, key).not.toBe(hash);
      expect(SHIPPED_TEMPLATE_PROMPT_HASHES[key], key).toContain(current);
    }
  });
});
