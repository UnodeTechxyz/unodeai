/*---------------------------------------------------------------------------------------------
 *  UnodeAi - system-prompt template tracking
 *
 *  Role prompts used to be copied into AgentConfig forever. This module makes a default prompt a
 *  live template reference while recording the exact template text whenever a user deliberately
 *  forks it. The fork point gives the UI an honest template-to-template diff without ever diffing
 *  (or overwriting) the user's private customization.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { AgentConfig } from '../types';
import { ROLE_TEMPLATES, RoleTemplate } from './RoleConfig';

export type PromptTemplateState =
  | 'template-current'
  | 'custom-current'
  | 'custom-outdated'
  | 'custom-origin-unknown'
  | 'custom-no-template';

export interface PromptTemplateStatus {
  state: PromptTemplateState;
  /** The role template currently shipped for this agent's role, if it has one. */
  currentTemplate?: RoleTemplate;
  /** The default template from which a known customization was forked. */
  templateAtFork?: string;
  /** The exact prompt sent to the backend for this config. */
  effectivePrompt: string;
  /** A non-intrusive update cue should be shown (until this template version is dismissed). */
  showUpdateNotice: boolean;
}

/**
 * Hashes of role-template prompts shipped before template tracking existed. They are intentionally
 * hashes, not old prompt text: migration only needs to recognize an untouched default, and retaining
 * historic prompt bodies would add stale guidance to the shipped extension. Regenerate when a role
 * template changes so the next release recognizes the previous default safely.
 */
export const SHIPPED_TEMPLATE_PROMPT_HASHES: Readonly<Record<string, readonly string[]>> = {
  'product-manager': ['7d4d90191c7e8de182420b0ff6b3b8b354af1efacc70ba0f8d1b7e143e810511'],
  architect: ['4f84970acfc5412916bec5f1308f9c5827a2e7246b84617f918fd4b20e50d2ad', 'ab44ed5f6c7400d8bd679567c691f69538c9b0885abc6f73074768fc9969ca40'],
  'senior-dev': ['280d3596011017c9e94308ac74123e8f76f2cd3a57be259a9e6917cf8c524b90'],
  tester: ['b07c9fdde39378b316956c2c8ffafa8a13b42f4c1d05dbe05e57ad8c849ddbd3'],
  devops: ['402f78d5f208262cbfb3c05233450156224dbcd24d682c8a32c461369aa34cf4'],
  'tech-writer': ['c21bf1468557553f07c9a20f208f662a6743d772afd3da9790827c004a41025d'],
  pm: [
    '0c1dadbcd779053acfe1fe5fe2e9817c3fca8adfdd324853cdf5f61c5897b8d7',
    '18c48cea3cbd9a3827498073e9b94337aa12b893eeeb76b8a4aaaacc39cc3099',
    '293d90bf637a5e04584239755d1635f009a11e968e7d5e05eb40107b7767ba5a',
    '2d1fa5fb0665e4afaeba04b679f8311286329ba0a1ba55dc0d5225d3e96b4aef',
    '3cb556d8fe5afd5d8bd22d3251aa77ea2efb3b7d0fc670defcfceea95eb09f4c',
    '46dc54dcb44be40e1c86f3fbd8ab4941637cc17d579a30e71d96ed49ae576caa',
    '6109c4e4898b18665fb77fa0d462bc4e801560b69d6f2f5e941e3489b2b52801',
    '66a1257272d8f9c3f1dff5405f9f9b2b96423e83eee4fcef6bbce917b8ba27da',
    'd9f3aa1286bbe8849ce002dbe44e6db394653cf091161622483e162877ca6799',
    '7eae5d8f483ae431b9dc84d4229874fb07542952788d92187013eefc6c3ceb25',
    '89fb6f5f343d47af1b8a19658f10090c95ff2e01a5a65f1f791dabde5ca78992',
    '8f1d22bfba43fb7a8658a85e7d1986ad371f0365fb6c2621227726d6c4b80168',
    '903e3ad4b21a83ffc0a5916df68eb3d8d81a1661a09a90bb7b0cc3b96003f924',
    'c5a65f76c7c6769819da3ed844799f24b104240b98c9a7d08f6398ce8daa6213',
    'cc9031173d95e4accd8c65c4044fff90b474b2a8def8ee834e5c1339e8a3cf80',
    'd851bcb897626cb73954b1d6cc0cf04e3d8a30da558cb55efe093b77a1b01489',
    'e8d216220a697c910d87d705c7ea58a32f2f06f29bddbcda116b67930f254782',
  ],
  'business-analyst': ['eeb7e82191da09590894a19b53978adfd2cc9bd8ede941f8136ee580807294bf'],
  'market-researcher': ['8c8cfbaba5b774be99b4ac078dd8c08f3971c127f2d6db9993fe72397c5bdd1b'],
  'financial-analyst': ['600eafeb11f29c87285180cb28da0da33272f439d50007b4a3dee7fb28bcb8b4'],
  'strategy-lead': ['c632a7f0b20dfdc3d26066e15c6de0f1c32027173e3d7808243f86ce93ab99da'],
  'content-strategist': ['db48735f1864a651f7bf2aa013e4b0e8f6bc34a6f4cf934168c98710320f586e'],
  'growth-marketer': ['d22bea26472d564ac17ce8958850a6f4a08af1936cde383423e32b0c03ff5273'],
  'seo-analyst': ['3aa84fcf628231fd86692632a7b63ee14a46a8f299372ce21d2e5a8cf78ae658'],
  'sales-development-rep': ['e2b77cc772359c9f34e8913532b96fe4d9f42be35094270584e7fa5624308cdf'],
  'account-executive': ['d487c8fffa6bf51c263bbbf9630073a142722eaeb360d68d3df45f045e589c60'],
  'sales-engineer': ['5e3c5414bfd6149ad73fdff197279b54bbda7bd619982df1ae5e5553af6d2138'],
  'customer-success-manager': ['d10bfa8db99af2a671cabff86f76f80e284470195c9a9a4d076d8447f5f0bac4'],
  security: ['bfa57db1c3d0150074220ab7d1e885ce5d131fda5fdc55b900b7abeee9526b8f'],
  'data-engineer': ['879fdb11c6a3ee783a4b6dbd8a22225ac530206d25bd584f85c367f9a2ff5b1a'],
  reviewer: ['53cf3d172839a525c1753421cd84082ba8d7cebe2a4ac415e087a86fbcba077d'],
  solo: ['d1cc9ec68adccbbce05445b4c2006a87297ec94c3b1d9b0d60f8f9ef3902f7d9'],
  'ux-researcher': ['2964930ed00c586ef538f1a6c795a609b86d8370a2b8495ed35fcd00a4d60ace'],
  'product-designer': ['8ffe3c53f202a31f8d8a7447b0d8e308a03d1841af68e8a6de4d7a48c7f77b99'],
  'product-analyst': ['d3f4183bc4bb82248d17dd3b9d4b6c72771a4c9feabfe1520f545f25f47adb66'],
  'frontend-engineer': ['22baa44e5b08eeb29d3a4c270a2059e85b86441a5e32ef6f0d581cb985fd73f8'],
  'backend-api-engineer': ['243799145620aec20ec04ee62f3ff9bcab6dc7efb708f92f3a4c8ed328829d6a'],
  'mobile-engineer': ['17961e905d489daadb5c61a3ddfbf57b414a932b87e66d00c84871287b5e3b3e'],
  sre: ['82ad80f4a37b4ea535c23560d305b70c485b669a58f53838e090bf5c14c65dee'],
  'performance-engineer': ['ce58bca722f798b0f758f495451e365b061da883e060757dbb9a892f84c70f5f'],
  'application-security-engineer': ['7d1837787d4cba02a16b028d84169ea028e3f27abd35dcc1fcb7d0d7bc458b72'],
  'cloud-security-engineer': ['e14ef009bd45c50d5331bdfb0eb964965dbd105939766302b93706d613a763f6'],
  'privacy-data-protection-officer': ['c28b7fc3879c325588c570ec091299746b6708752e86c4caf634bf740702d284'],
  'contract-analyst': ['ec79675f07c46dd6884c542129cb7f1f8c6bcf12c315afc9007f3174e3d2aa09'],
  'grc-analyst': ['63bae967a2446eddcde0fa1803e33ed18256f4b1467b74bc65b1433bebc203ba'],
  'data-analyst': ['6d7542b4cbc42cbdac55ad1aa2feafb4211fef174eca5c816d6657d5ee7e2411'],
  'ai-ml-engineer': ['587accd64b0aa10113ffffcda2f58519b123aadd5728cc51b4a95badce01728b'],
  'knowledge-manager': ['a2dbaf95a5d6bae726d101e79a148c507bd09bb659022a5b059be1273eecc147'],
  'customer-support-agent': ['109e04275a1d1bb0d3bcbb06968e63b7138026d61f9c47f6cf60b6f42a412d7a'],
  'technical-support-engineer': ['050727897bc425b9c0aa3574a7ac89544fcaa2040452b4a3d86632cef872776c'],
  'support-operations-analyst': ['b97a26b79c6a621ed43b77fece6b77479a0fa9494d2bd4a75be1d32d5e7d340e'],
  'conversation-designer': ['a42f0c3c1a7bbeccf722b9a43488eda87d13c74e571b8c8c06166d805524d1f6'],
  'brand-strategist': ['75070cc3974ee854da7bab432f622380e7a0bc81c82038f4d5ee6643ac5e230f'],
  'lifecycle-crm-marketer': ['60a66edef5dd6b5bd513ebae7cc9076e5e540b8177399c1719d747a0dbd6f5ec'],
  'revenue-operations-analyst': ['902f61319a62f98c0f2db631f29124959d1ad9d40735e790e76e3203f56c0642'],
  'partner-channel-manager': ['9f5e18f33a87ba6b3a7e9c8ce0e5f5e1fd58b25bd0d9cab6664c89b5c5aac9b3'],
  'workflow-automation-specialist': ['a50e5693c8bd9efba0fd265def948f8f9c133a068d88b3e406e0e64db4b75ea9'],
  'fpa-analyst': ['f737f4caa80e4d9894a8724054c414ea5ee2f23b13653be245b4409ff4b7dafd'],
  'procurement-analyst': ['dc0d3d2d3fb60351d25c1761ddccc49382c1be792df7ab4cf02e9331c7b6c1d1'],
  'program-manager': ['9e388944eee636d4ae11445364620473e1de42074404ce58546a4fba8e1a0e87'],
  'developer-advocate': ['1b43e2612564959d9386454b918465020bb9409ce6fd90b1af2b460355270b23'],
  'localization-i18n-specialist': ['9689fe3861e0ff22efe12d5d042f50313393cc80f3c0b31b8002abfe2b6a00c7'],
};

export function promptTemplateHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

/** Resolve identity by persisted template key. Runtime `role` is deliberately not enough: eleven
 * knowledge-work templates share `role: 'custom'`. Old non-custom configs may fall back only where
 * the runtime role maps to exactly one template; an ambiguous old custom config stays unclassified. */
export function currentRoleTemplateKey(config: Pick<AgentConfig, 'role' | 'roleTemplateKey'>): string | undefined {
  if (config.roleTemplateKey && ROLE_TEMPLATES[config.roleTemplateKey]) {
    return config.roleTemplateKey;
  }
  if (config.role === 'custom') {
    return undefined;
  }
  const matches = Object.entries(ROLE_TEMPLATES).filter(([, template]) => template.role === config.role);
  return matches.length === 1 ? matches[0][0] : undefined;
}

export function currentRoleTemplate(config: Pick<AgentConfig, 'role' | 'roleTemplateKey'>): RoleTemplate | undefined {
  const key = currentRoleTemplateKey(config);
  return key ? ROLE_TEMPLATES[key] : undefined;
}

/** True only when this text exactly matches the current or a shipped historic prompt for THIS template. */
export function isShippedTemplatePrompt(templateKey: string | undefined, prompt: string): boolean {
  if (!templateKey) {
    return false;
  }
  const current = ROLE_TEMPLATES[templateKey]?.systemPrompt;
  return current === prompt || SHIPPED_TEMPLATE_PROMPT_HASHES[templateKey]?.includes(promptTemplateHash(prompt)) === true;
}

/** For an old `role: custom` config without a key, infer one only from an exact, unambiguous
 * shipped-template match. Never use a matching prompt from another role to reinterpret a
 * config which already has an unambiguous runtime role. */
function shippedTemplateKeyForPrompt(config: AgentConfig): string | undefined {
  // `custom` is an explicit ownership claim. Do not reinterpret an intentionally custom role
  // merely because its text happens to equal a shipped prompt.
  if (config.systemPromptSource === 'custom') {
    return undefined;
  }
  const declared = currentRoleTemplateKey(config);
  if (declared) {
    return isShippedTemplatePrompt(declared, config.systemPrompt) ? declared : undefined;
  }
  const candidates = Object.keys(ROLE_TEMPLATES)
    .filter((key) => isShippedTemplatePrompt(key, config.systemPrompt));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Classify a config conservatively. A stale `source: template` is NOT authority to overwrite text. */
function effectiveSource(config: AgentConfig, templateKey: string | undefined): 'template' | 'custom' {
  if (config.systemPromptSource === 'custom') {
    return 'custom';
  }
  // `template` and absent legacy source use the exact same proof: current text or a known shipped hash.
  return isShippedTemplatePrompt(templateKey, config.systemPrompt) ? 'template' : 'custom';
}

export function promptTemplateStatus(config: AgentConfig): PromptTemplateStatus {
  const templateKey = currentRoleTemplateKey(config) ?? shippedTemplateKeyForPrompt(config);
  const currentTemplate = templateKey ? ROLE_TEMPLATES[templateKey] : undefined;
  const source = effectiveSource(config, templateKey);
  if (source === 'template' && currentTemplate) {
    return {
      state: 'template-current',
      currentTemplate,
      effectivePrompt: currentTemplate.systemPrompt,
      showUpdateNotice: false,
    };
  }
  if (!currentTemplate) {
    return {
      state: 'custom-no-template',
      effectivePrompt: config.systemPrompt,
      showUpdateNotice: false,
    };
  }

  const templateAtFork = config.systemPromptTemplateAtFork;
  if (!templateAtFork) {
    const currentHash = promptTemplateHash(currentTemplate.systemPrompt);
    return {
      state: 'custom-origin-unknown',
      currentTemplate,
      effectivePrompt: config.systemPrompt,
      // We cannot prove the old baseline, but users should still get one quiet chance to review
      // the current default. Dismissal remains version-scoped just like a known fork.
      showUpdateNotice: config.systemPromptDismissedTemplateHash !== currentHash,
    };
  }
  if (templateAtFork === currentTemplate.systemPrompt) {
    return {
      state: 'custom-current',
      currentTemplate,
      templateAtFork,
      effectivePrompt: config.systemPrompt,
      showUpdateNotice: false,
    };
  }
  const currentHash = promptTemplateHash(currentTemplate.systemPrompt);
  return {
    state: 'custom-outdated',
    currentTemplate,
    templateAtFork,
    effectivePrompt: config.systemPrompt,
    showUpdateNotice: config.systemPromptDismissedTemplateHash !== currentHash,
  };
}

/**
 * Safely annotate old persisted configs. Only an exact match against a shipped default becomes
 * template-managed; every uncertain prompt remains untouched as a user customization.
 */
export function migratePromptTemplateSource(config: AgentConfig): boolean {
  const before = JSON.stringify({
    templateKey: config.roleTemplateKey,
    source: config.systemPromptSource,
    prompt: config.systemPrompt,
    fork: config.systemPromptTemplateAtFork,
    dismissed: config.systemPromptDismissedTemplateHash,
  });
  const templateKey = currentRoleTemplateKey(config) ?? shippedTemplateKeyForPrompt(config);
  const template = templateKey ? ROLE_TEMPLATES[templateKey] : undefined;
  const source = effectiveSource(config, templateKey);
  config.systemPromptSource = source;
  // Persist a key whenever we can prove a template identity. It is independent from `role`
  // because knowledge-work templates intentionally all use runtime role `custom`.
  if (!config.roleTemplateKey && templateKey) {
    config.roleTemplateKey = templateKey;
  }
  if (source === 'template' && template) {
    config.systemPrompt = template.systemPrompt;
    delete config.systemPromptTemplateAtFork;
    delete config.systemPromptDismissedTemplateHash;
  }
  return before !== JSON.stringify({
    templateKey: config.roleTemplateKey,
    source: config.systemPromptSource,
    prompt: config.systemPrompt,
    fork: config.systemPromptTemplateAtFork,
    dismissed: config.systemPromptDismissedTemplateHash,
  });
}

/** Resolve the prompt on every session start; playbooks and runtime blocks are applied elsewhere. */
export function resolveRuntimeSystemPrompt(config: AgentConfig): string {
  return promptTemplateStatus(config).effectivePrompt;
}

/** Record an explicit Agent Builder edit without ever replacing the user's typed prompt. */
export function recordSystemPromptSave(config: AgentConfig, nextPrompt: string): void {
  // Agent Builder saves all fields together. A model/checkbox-only save must never revoke the
  // only retained copy of a prompt replaced by an explicit Reset-to-template action.
  if (nextPrompt === config.systemPrompt) {
    return;
  }
  const before = promptTemplateStatus(config);
  const template = currentRoleTemplate(config);
  config.systemPrompt = nextPrompt;
  delete config.systemPromptUndo;
  if (template && nextPrompt === template.systemPrompt) {
    config.systemPromptSource = 'template';
    delete config.systemPromptTemplateAtFork;
    delete config.systemPromptDismissedTemplateHash;
    return;
  }
  config.systemPromptSource = 'custom';
  // A template-managed agent has a precise current fork point. For a legacy customization whose
  // origin is unknown, retain that honesty rather than inventing a baseline it never used.
  if (before.state === 'template-current' && template) {
    config.systemPromptTemplateAtFork = template.systemPrompt;
  }
  delete config.systemPromptDismissedTemplateHash;
}

/**
 * Save an agent the user explicitly gave the "Custom role".
 *
 * Custom is an ownership claim, and it must survive a round trip. `migratePromptTemplateSource` infers a
 * template identity by matching the prompt text against every shipped default, so an agent deliberately made
 * Custom whose instructions still happened to equal (say) the Senior Developer default was silently handed
 * that role's identity back: it reopened in Agent Builder as Senior Developer and resolved to the Senior
 * Developer template at runtime. Pin the identity so no inference can reclaim it.
 */
export function recordCustomRoleSave(config: AgentConfig, nextPrompt: string): void {
  recordSystemPromptSave(config, nextPrompt);
  config.systemPromptSource = 'custom';
  delete config.roleTemplateKey;
  delete config.systemPromptTemplateAtFork;
  delete config.systemPromptDismissedTemplateHash;
}

/**
 * Retain instructions that a role switch replaced, so they stay recoverable after the panel closes.
 *
 * The Agent Builder holds the replaced text in webview memory and offers it back in-panel. That copy dies
 * with the panel, so a user who switched role and saved without restoring lost their text permanently — and
 * for a NEW agent it was the only copy that ever existed. Deliberately independent of whether the agent
 * already existed, of the role picked, and of whether the template key changed: the red line is that the
 * user's prompt is never unrecoverable.
 *
 * Call AFTER `recordSystemPromptSave`, which clears the undo record whenever the prompt actually changed.
 */
export function retainReplacedPrompt(
  config: AgentConfig,
  replaced: string | undefined,
  prior: { templateAtFork?: string; dismissedTemplateHash?: string } = {}
): boolean {
  if (!replaced || !replaced.trim() || replaced === config.systemPrompt) {
    return false;
  }
  config.systemPromptUndo = {
    prompt: replaced,
    templateAtFork: prior.templateAtFork,
    dismissedTemplateHash: prior.dismissedTemplateHash,
  };
  return true;
}

/** Explicit, confirm-before-call choice: replace a prompt with the current default and retain undo data. */
export function adoptCurrentPromptTemplate(config: AgentConfig): boolean {
  const status = promptTemplateStatus(config);
  if (!status.currentTemplate || status.state === 'template-current') {
    return false;
  }
  config.systemPromptUndo = {
    prompt: config.systemPrompt,
    templateAtFork: config.systemPromptTemplateAtFork,
    dismissedTemplateHash: config.systemPromptDismissedTemplateHash,
  };
  config.systemPrompt = status.currentTemplate.systemPrompt;
  config.systemPromptSource = 'template';
  delete config.systemPromptTemplateAtFork;
  delete config.systemPromptDismissedTemplateHash;
  return true;
}

/** Restore the exact user prompt replaced by the most recent explicit adopt action. */
export function undoAdoptCurrentPromptTemplate(config: AgentConfig): boolean {
  const undo = config.systemPromptUndo;
  if (!undo) {
    return false;
  }
  config.systemPrompt = undo.prompt;
  config.systemPromptSource = 'custom';
  if (undo.templateAtFork) {
    config.systemPromptTemplateAtFork = undo.templateAtFork;
  } else {
    delete config.systemPromptTemplateAtFork;
  }
  if (undo.dismissedTemplateHash) {
    config.systemPromptDismissedTemplateHash = undo.dismissedTemplateHash;
  } else {
    delete config.systemPromptDismissedTemplateHash;
  }
  delete config.systemPromptUndo;
  return true;
}

/** Silence the current template version only; a new template hash intentionally reopens the notice. */
export function dismissPromptTemplateUpdate(config: AgentConfig): boolean {
  const status = promptTemplateStatus(config);
  if ((status.state !== 'custom-outdated' && status.state !== 'custom-origin-unknown') || !status.currentTemplate) {
    return false;
  }
  config.systemPromptDismissedTemplateHash = promptTemplateHash(status.currentTemplate.systemPrompt);
  return true;
}

/** A small, readable template-to-template diff. Never includes the user's customized prompt. */
export function templatePromptDiff(previous: string, current: string): string {
  const oldLines = previous.split('\n');
  const newLines = current.split('\n');
  const table = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      table[i][j] = oldLines[i] === newLines[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines = ['--- Default guidance when you customized', '+++ Current default guidance'];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      lines.push(` ${oldLines[i++]}`);
      j++;
    } else if (j < newLines.length && (i === oldLines.length || table[i][j + 1] >= table[i + 1][j])) {
      lines.push(`+${newLines[j++]}`);
    } else {
      lines.push(`-${oldLines[i++]}`);
    }
  }
  return lines.join('\n');
}
