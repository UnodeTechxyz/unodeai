import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * v0.9.102 R5 (design 8, 10 rows T102-1 and T102-9). Every one of the 26 presets is made by the factory the preset
 * picker uses (`dialogs.instantiateTeam` -> `prepareTeam`), its members are created and started in a real
 * SessionManager, and what is checked is what SessionManager hands to the backend (the runtime config: tools, Run
 * commands choice and the one assembled prompt) and the tool list the real OpenAI-compatible backend builds from it.
 * All 53 templates go the same way in one team. Nothing here compares a static array with itself: the expected
 * defaults are the design's (3.1), and the values checked come out of the factory and the session start.
 *
 * Already proven elsewhere and not repeated here (R3): that presets, Solo, Add Agent, Agent Builder and the
 * Marketplace give each of the 53 templates the same tools, Run commands choice and prompt source, on Claude and on
 * Codex (src/state/__tests__/RoleEntryRoundTrip.test.ts, "every creating entry ...").
 */
vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1 },
  ConfigurationTarget: { Workspace: 2 },
  Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }) },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => '', update: vi.fn() }), isTrusted: true },
  window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn(), showQuickPick: vi.fn(), showInputBox: vi.fn() },
}));
vi.mock('../../backend/CommandApprovalPrompter', () => ({ promptCommandApproval: vi.fn(async () => false) }));

import * as dialogs from '../../dialogs';
import { ROLE_TEMPLATES, TEAM_PRESETS } from '../RoleConfig';
import { MessageBus } from '../../bus/MessageBus';
import { OpenAICompatBackend } from '../../backend/OpenAICompatBackend';
import { runtimeSystemPrompt, SessionManager } from '../../session/SessionManager';
import { defaultBackendKind } from '../../backend/backendKind';
import { BUILTIN_CONNECTION_REGISTRY } from '../../routes/ConnectionRegistry';
import type { AgentConfig } from '../../types';

/** Design 5's template keys, extended with Hardware Technical Analyst. */
const DESIGN_TEMPLATES = [
  'product-manager', 'architect', 'senior-dev', 'tester', 'devops', 'tech-writer', 'pm', 'security', 'data-engineer',
  'reviewer', 'solo', 'business-analyst', 'market-researcher', 'financial-analyst', 'strategy-lead', 'content-strategist',
  'growth-marketer', 'seo-analyst', 'sales-development-rep', 'account-executive', 'sales-engineer',
  'customer-success-manager', 'ux-researcher', 'product-designer', 'product-analyst', 'frontend-engineer',
  'backend-api-engineer', 'mobile-engineer', 'sre', 'performance-engineer', 'application-security-engineer',
  'cloud-security-engineer', 'contract-analyst', 'privacy-data-protection-officer', 'grc-analyst', 'data-analyst',
  'ai-ml-engineer', 'knowledge-manager', 'customer-support-agent', 'technical-support-engineer',
  'support-operations-analyst', 'conversation-designer', 'brand-strategist', 'lifecycle-crm-marketer',
  'revenue-operations-analyst', 'partner-channel-manager', 'workflow-automation-specialist', 'fpa-analyst',
  'procurement-analyst', 'hardware-technical-analyst', 'program-manager', 'developer-advocate', 'localization-i18n-specialist',
  // v0.9.106: the starter team's generalist.
  'generalist',
];
/** Design 8's preset keys, extended with Hardware Procurement. */
const DESIGN_PRESETS = [
  'software-engineering', 'bugfix-crew', 'refactor-crew', 'test-writer-crew', 'release-crew', 'security-review-crew',
  'business-planning', 'business-analysis', 'financial-analysis', 'marketing', 'sales',
  'product-discovery', 'experience-design', 'full-stack-delivery', 'mobile-quality', 'website-delivery',
  'reliability-engineering', 'contract-compliance', 'hardware-procurement', 'security-governance',
  'data-intelligence', 'customer-experience', 'revenue-operations', 'brand-lifecycle', 'business-operations', 'enablement-localization',
  // v0.9.106: the three-person starter team of first use.
  'starter',
];
/** Design 3.1: the shared defaults of a new trusted template; delegate only for the system coordinator. */
const SHARED = ['execute', 'message', 'read', 'search', 'write'];
const HEADING = '## How to work (shared by every agent)';
const LEAD = 'As the lead: do a small task yourself, and divide work only where dividing helps.';
const REVIEWER = 'As a reviewer: first confirm what actually triggers a problem and what it does to the user.';
const DOER = 'Doing the work: focus on the deliverable and the smallest change that achieves it.';

const count = (text: string, part: string) => text.split(part).length - 1;
const sorted = (tools: readonly string[] | undefined) => [...(tools ?? [])].sort();

function dialogDeps(created: AgentConfig[], providerId: string) {
  return {
    sessionManager: { getAll: () => created.map(config => ({ config })), create: (config: AgentConfig) => { created.push(config); } },
    secrets: { has: async () => true, get: async () => undefined, promptAndStore: async () => {} },
    output: { info: () => {} }, commandPolicy: { approvalMode: 'none', reload: () => {} }, reloadCommandPolicy: () => {},
    defaultBackendKind: (config: AgentConfig) => defaultBackendKind(config, BUILTIN_CONNECTION_REGISTRY),
    defaultProvider: () => providerId, suppressInteractivePostCreatePrompts: true,
  } as never;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/**
 * Create `members` in a real SessionManager, then start each. Returns what SessionManager handed to the backend for
 * each agent (the runtime config) and the tool names the real OpenAI-compatible backend built from it, plus whether
 * creating the team alone started anything or asked a model.
 */
async function startTeam(members: readonly AgentConfig[]) {
  const root = await mkdtemp(join(tmpdir(), 'unode-r5-runtime-'));
  const bus = new MessageBus();
  const runtime = new Map<string, { config: AgentConfig; tools: string[] }>();
  let modelRequests = 0;
  const manager = new SessionManager(128, bus, {
    createBackend: (config) => {
      const backend = new OpenAICompatBackend(config, async () => {
        modelRequests++;
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }) };
      });
      const tools = ((backend as unknown as { tools: { specs(): Array<{ function: { name: string } }> } }).tools.specs())
        .map(spec => spec.function.name);
      runtime.set(config.id, { config: structuredClone(config), tools });
      return backend;
    },
    resolveEnv: async () => ({ ROAM_API_KEY: 'sk-test' }),
    resolveWorkingDirectory: async () => root,
  });
  cleanups.push(async () => { await manager.stopAll(); bus.dispose(); await rm(root, { recursive: true, force: true }); });
  for (const member of members) manager.create(member);
  // Making a team starts no agent and asks no model (design 8: no automatic network, deployment or paid run).
  const createdOnly = { started: runtime.size, modelRequests, statuses: manager.getAll().map(session => session.status) };
  for (const member of members) await manager.start(member.id, { pin: 'take' });
  return { runtime, createdOnly, modelRequests: () => modelRequests };
}

/** What every started member must hold (design 3.1, 4; T102-1 and the prompt-level part of T102-9). */
function expectRuntimeDefaults(stored: AgentConfig, run: { config: AgentConfig; tools: string[] }, coordinatorId: string | undefined, label: string) {
  const key = stored.roleTemplateKey!;
  const isLead = stored.id === coordinatorId;
  expect(key in ROLE_TEMPLATES, label).toBe(true);
  // The tools and the Run commands choice reach the backend unchanged: the shared defaults, delegate only for the PM.
  expect(sorted(run.config.allowedTools), label).toEqual(key === 'pm' ? sorted([...SHARED, 'delegate']) : SHARED);
  expect(run.config.executePreference, label).toBe('template');
  // The backend builds the matching tools: read, search, write, run and message.
  for (const tool of ['read_file', 'search_files', 'write_file', 'run_command', 'send_message']) expect(run.tools, `${label} ${tool}`).toContain(tool);
  // The prompt the backend receives is the one assembly: the current role text, the runtime rules, one shared contract.
  expect(run.config.systemPrompt, label).toBe(runtimeSystemPrompt(stored, coordinatorId));
  expect(run.config.systemPrompt.startsWith(ROLE_TEMPLATES[key].systemPrompt), label).toBe(true);
  expect(count(run.config.systemPrompt, HEADING), label).toBe(1);
  // T102-9, prompt level: checking and coordination fitted to impact; the lead does small work itself.
  expect(run.config.systemPrompt, label).toContain('Fit the checking and coordination to the impact and to how easily a mistake can be undone.');
  expect(run.config.systemPrompt, label).toContain('That never waives a check the work needs or a review the project requires.');
  // v0.9.105 S1: the reviewer addendum reaches the review and assessment roles, named by template.
  const REVIEW_TEMPLATES = ['reviewer', 'security', 'application-security-engineer', 'privacy-data-protection-officer', 'grc-analyst'];
  const addendum = isLead ? LEAD : stored.role === 'reviewer' || REVIEW_TEMPLATES.includes(key) ? REVIEWER : DOER;
  expect(run.config.systemPrompt, label).toContain(addendum);
  // v0.9.105 S1: the lead the backend runs is told when a todo is completed and when to run checks.
  if (isLead) {
    expect(run.config.systemPrompt, label).toContain('A todo for that task is completed only when you record it accepted');
    expect(run.config.systemPrompt, label).toContain('Call **run_checks** when the team has a configured check: a configured check is required');
  }
  for (const other of [LEAD, REVIEWER, DOER].filter(part => part !== addendum)) expect(run.config.systemPrompt, label).not.toContain(other);
  // The stored configuration is never rewritten by the assembly.
  expect(stored.systemPrompt, label).toBe(ROLE_TEMPLATES[key].systemPrompt);
}

describe('v0.9.102 R5 T102-1: the catalog the design names', () => {
  it('holds the 54 templates and 27 presets, and every preset names shipped templates and starts with the PM', () => {
    expect(Object.keys(ROLE_TEMPLATES).sort()).toEqual([...DESIGN_TEMPLATES].sort());
    expect(new Set(DESIGN_TEMPLATES).size).toBe(54);
    expect(Object.keys(TEAM_PRESETS).sort()).toEqual([...DESIGN_PRESETS].sort());
    expect(new Set(DESIGN_PRESETS).size).toBe(27);
    for (const [key, preset] of Object.entries(TEAM_PRESETS)) {
      expect(preset.roles[0], key).toBe('pm');
      for (const role of preset.roles) expect(role in ROLE_TEMPLATES, `${key} ${role}`).toBe(true);
    }
  });
});

describe('v0.9.102 R5 T102-1: every preset and every template, made by the preset factory, reaches the runtime with the shared defaults', () => {
  it('each of the 27 presets: the dialogs factory adds Solo, creating the team starts nothing, and every started member holds read, search, write, execute and message, delegate only for the PM, and the one assembled prompt', async () => {
    for (const presetKey of DESIGN_PRESETS) {
      const preset = TEAM_PRESETS[presetKey];
      const members: AgentConfig[] = [];
      const made = await dialogs.instantiateTeam(dialogDeps(members, 'roam'), preset.roles, preset.label);
      expect(made, presetKey).toEqual(members);
      // The factory's own roster: the preset's roles in order, and exactly one Solo.
      expect(members.map(member => member.roleTemplateKey), presetKey)
        .toEqual(preset.roles.includes('solo') ? preset.roles : [...preset.roles, 'solo']);
      for (const member of members) expect(member.backend, `${presetKey} ${member.roleTemplateKey}`).toBe('openai-compat');

      const team = await startTeam(members);
      expect(team.createdOnly.started, presetKey).toBe(0);
      expect(team.createdOnly.modelRequests, presetKey).toBe(0);
      for (const status of team.createdOnly.statuses) expect(status, presetKey).toBe('stopped');
      const coordinatorId = members.find(member => member.role === 'pm')?.id;
      for (const member of members) {
        const run = team.runtime.get(member.id);
        expect(run, `${presetKey} ${member.roleTemplateKey}`).toBeDefined();
        expectRuntimeDefaults(member, run!, coordinatorId, `${presetKey} ${member.roleTemplateKey}`);
      }
      // Starting the team asks no model either: work begins only with a task the person sends.
      expect(team.modelRequests(), presetKey).toBe(0);
      // A verify command a preset suggests is not put on any member (design 8: a suggestion the project can override).
      for (const member of members) expect(JSON.stringify(member), `${presetKey} ${member.roleTemplateKey}`).not.toContain('verifyCommand');
    }
  }, 120_000);

  it('all 54 templates in one team through the same factory: every member reaches the runtime with the shared defaults, and only the PM delegates', async () => {
    const members: AgentConfig[] = [];
    await dialogs.instantiateTeam(dialogDeps(members, 'roam'), DESIGN_TEMPLATES as never, 'Every role');
    expect(members.map(member => member.roleTemplateKey).sort()).toEqual([...DESIGN_TEMPLATES].sort());
    const team = await startTeam(members);
    const coordinatorId = members.find(member => member.role === 'pm')?.id;
    const delegating: string[] = [];
    for (const member of members) {
      const run = team.runtime.get(member.id)!;
      expectRuntimeDefaults(member, run, coordinatorId, member.roleTemplateKey!);
      if (run.config.allowedTools?.includes('delegate')) delegating.push(member.roleTemplateKey!);
    }
    expect(delegating).toEqual(['pm']);
    expect(team.modelRequests()).toBe(0);
  }, 120_000);
});
