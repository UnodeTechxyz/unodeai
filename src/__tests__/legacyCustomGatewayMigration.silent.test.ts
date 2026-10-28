import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../types';
import {
  applyLegacyCustomGatewayMigration, hasOnlyTerminalLegacyCustomRepairs, isLegacySingletonCustomAgent, isPersonsOwnLegacyCustomBinding,
  LEGACY_CUSTOM_PROVIDER_ID,
  LEGACY_CUSTOM_SECRET_NAME, legacyCustomSecretName, pendingLegacyCustomMigrationAgents, planLegacyCustomGatewayMigration,
} from '../connections/LegacyCustomGatewayMigration';
import { PersistentLegacyCustomMigrationDeclines } from '../connections/PersistentLegacyCustomMigrationDeclines';
import { legacyMigrationRosterSignature } from '../connections/LegacyMigrationRosterSignature';

/**
 * v0.9.99 B21: the real `migrateLegacySingletonCustomGateways` of extension.ts. The retired singleton Custom gateway
 * is migrated at activation without the modal that held the roster restore; one notice says what moved. A decline
 * recorded by an earlier release is still honoured.
 */
const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function extensionFunction(name: string, host: object) {
  const found: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node); ts.forEachChild(node, visit); };
  visit(source);
  expect(found).toHaveLength(1);
  const code = ts.transpileModule(found[0].getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('host', `with (host) { ${code}; return ${name}; }`)(host);
}

const OWN_ENDPOINT = 'https://legacy.example.test/v1';

function legacyAgent(id: string, legacy: { secretName?: string; baseUrl?: string } = {}): AgentConfig {
  return {
    id, name: id, role: 'custom', skill: 'read', model: 'shared-model', backend: 'openai-compat',
    provider: { providerId: 'custom', apiKeySecretName: legacy.secretName ?? LEGACY_CUSTOM_SECRET_NAME },
    ...(legacy.baseUrl ? { baseUrl: legacy.baseUrl } : {}),
    systemPrompt: 'test', autoApprove: false, allowedTools: ['read'],
  };
}

/**
 * `workspace` is the roster in workspace state, `team` the members of .unode/team.json. `state` carries workspace state
 * across two harnesses, as across a reload. `trusted` is read at each call.
 */
function harness(options: {
  declined?: boolean; fromTeamFile?: boolean; answer?: string; workspace?: AgentConfig[]; team?: AgentConfig[];
  state?: Map<string, unknown>; trust?: { trusted: boolean }; ownEndpoint?: string;
} = {}) {
  const workspaceState = options.state ?? new Map<string, unknown>();
  const stateStore = {
    get: <T>(key: string) => workspaceState.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { if (value === undefined) workspaceState.delete(key); else workspaceState.set(key, value); },
  };
  const defaults = [legacyAgent('dev'), legacyAgent('qa')];
  let agents = options.workspace ?? (options.fromTeamFile ? [] : defaults);
  const team = options.team ?? (options.fromTeamFile ? defaults : undefined);
  if (options.declined) void new PersistentLegacyCustomMigrationDeclines(stateStore).remember(agents);
  const trust = options.trust ?? { trusted: true };
  const profiles: Array<{ connectionId: string; displayName: string; endpointBase: string; secretRef?: string }> = [];
  const warnings: unknown[][] = [];
  const notices: Array<[string, string]> = [];
  const host: Record<string, unknown> = {
    vscode: { workspace: { get isTrusted() { return trust.trusted; } }, window: { showWarningMessage: vi.fn((...args: unknown[]) => { warnings.push(args); return Promise.resolve(options.answer); }), showErrorMessage: vi.fn() } },
    firstWorkspaceRoot: () => '/workspace',
    rootWorkspaceState: stateStore,
    PersistentLegacyCustomMigrationDeclines,
    persistence: {
      loadAgents: () => agents,
      loadTeamConfigForStartup: async () => ({ kind: 'ready', document: team ? { members: team } : undefined }),
      updateTeamConfig: vi.fn(),
      saveAgents: vi.fn(async (next: AgentConfig[]) => { agents = next; }),
    },
    hydratedLegacyTeamAgents: async (members: AgentConfig[]) => members,
    isLegacySingletonCustomAgent, isPersonsOwnLegacyCustomBinding, pendingLegacyCustomMigrationAgents, legacyCustomSecretName,
    planLegacyCustomGatewayMigration,
    applyLegacyCustomGatewayMigration, hasOnlyTerminalLegacyCustomRepairs, legacyMigrationRosterSignature, LEGACY_CUSTOM_PROVIDER_ID,
    readLegacyCustomGatewayMigrationState: () => workspaceState.get('journal'),
    readLegacyCustomGatewayTerminalRepairs: () => undefined,
    LEGACY_CUSTOM_GATEWAY_MIGRATION_KEY: 'journal',
    LEGACY_CUSTOM_GATEWAY_TERMINAL_REPAIRS_KEY: 'repairs',
    isJournaledLegacyMigrationSplit: () => false,
    legacyAgentIdsAreCoveredByJournal: () => true,
    secrets: { has: async () => true, get: async () => 'legacy-key' },
    loadCustomGatewayRegistryOrFallback: async () => ({ registryRevision: profiles.length, profiles: [...profiles], tombstones: [] }),
    randomBytes,
    configuredSetting: (key: string) => key === 'customBaseUrl' ? (options.ownEndpoint ?? OWN_ENDPOINT) : '',
    effectiveConnectionRegistry: { profiles: [] },
    customGatewayProfileStore: { importLegacy: vi.fn(async (entry: { connectionId: string; displayName: string; endpointBase: string; secretRef?: string }) => { profiles.push(entry); }) },
    reloadEffectiveConnectionRegistry: async () => {},
    makeConfigStore: () => ({ get: () => 'unode', update: vi.fn() }),
    showResultNotice: vi.fn((kind: string, message: string) => { notices.push([kind, message]); }),
    outputChannel: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  host.legacyCustomGatewayMigrationNotice = extensionFunction('legacyCustomGatewayMigrationNotice', host);
  host.legacyCustomGatewayMigrationPreview = extensionFunction('legacyCustomGatewayMigrationPreview', host);
  const migrate = extensionFunction('migrateLegacySingletonCustomGateways', host) as () => Promise<void>;
  return { migrate, warnings, notices, profiles, agents: () => agents, saveAgents: (next: AgentConfig[]) => { agents = next; } };
}

describe('v0.9.99 B21: legacy Custom gateway migration without a modal', () => {
  it('migrates at activation without asking, and says what moved and where to review it', async () => {
    const h = harness();
    await h.migrate();
    expect(h.warnings).toEqual([]);
    expect(h.profiles).toHaveLength(1);
    expect(h.agents().some(isLegacySingletonCustomAgent)).toBe(false);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0][0]).toBe('information');
    expect(h.notices[0][1]).toContain('named gateway');
    expect(h.notices[0][1]).toContain('Nothing was sent.');
    expect(h.notices[0][1]).toContain('UnodeAi Settings, Providers tab');
  });

  it('a decline recorded by an earlier release is still honoured: nothing is migrated or asked', async () => {
    const h = harness({ declined: true });
    await h.migrate();
    expect(h.warnings).toEqual([]);
    expect(h.profiles).toEqual([]);
    expect(h.agents().every(isLegacySingletonCustomAgent)).toBe(true);
  });
});

// v0.9.99 (security re-audit): where a legacy record is stored does not show who chose it. Restoring a project's
// .unode/team.json saves its members into workspace state, so a key name or endpoint there may be the project's. Only a
// migration that recreates the person's own binding (the retired Custom key, to their User-level legacy endpoint) runs
// without asking; any other key or endpoint is migrated only after the person agrees to it.
describe('a legacy Custom migration that binds any other key or endpoint asks first, wherever the record is stored', () => {
  const projectKey = 'OPENROUTER_API_KEY';

  it('untrusted first open, roster saved from the team file, then trust and reload: still asks before copying the key', async () => {
    const project = [legacyAgent('repository-agent', { secretName: projectKey })];
    const state = new Map<string, unknown>();
    const trust = { trusted: false };
    const first = harness({ workspace: [], team: project, state, trust, answer: 'Do not migrate' });
    await first.migrate();
    expect(first.warnings).toEqual([]);
    expect(first.profiles).toEqual([]);
    // Roster restoration then saves the project's members into workspace state, as activation does.
    first.saveAgents(structuredClone(project));
    trust.trusted = true;
    const reloaded = harness({ workspace: first.agents(), team: project, state, trust, answer: 'Do not migrate' });
    await reloaded.migrate();
    expect(reloaded.warnings).toHaveLength(1);
    const [message, options, ...buttons] = reloaded.warnings[0] as [string, { modal: boolean }, ...string[]];
    expect(options).toEqual({ modal: true });
    expect(buttons).toEqual(['Do not migrate', 'Migrate custom gateways']);
    expect(message).toContain(OWN_ENDPOINT);
    expect(message).toContain(`your stored key "${projectKey}" would be used with this endpoint`);
    expect(message).toContain('may come from the project');
    expect(reloaded.profiles).toEqual([]);
    expect(reloaded.notices).toEqual([]);
    // The decline is kept in workspace state: the next activation (a new harness on the same state) does not ask again.
    const again = harness({ workspace: reloaded.agents(), team: project, state, trust, answer: 'Migrate custom gateways' });
    await again.migrate();
    expect(again.warnings).toEqual([]);
    expect(again.profiles).toEqual([]);
  });

  it('an endpoint other than the User-level legacy endpoint asks, even with the retired Custom key', async () => {
    const h = harness({ workspace: [legacyAgent('dev', { baseUrl: 'https://elsewhere.example.test/v1' })], answer: undefined });
    await h.migrate();
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0][0]).toContain('https://elsewhere.example.test/v1');
    // Closing the question copies nothing.
    expect(h.profiles).toEqual([]);
  });

  it('with no User-level legacy endpoint, a record\'s own endpoint asks', async () => {
    const h = harness({ workspace: [legacyAgent('dev', { baseUrl: OWN_ENDPOINT })], ownEndpoint: '', answer: undefined });
    await h.migrate();
    expect(h.warnings).toHaveLength(1);
    expect(h.profiles).toEqual([]);
  });

  it('migrates after the person agrees', async () => {
    const h = harness({ workspace: [legacyAgent('dev', { secretName: projectKey })], answer: 'Migrate custom gateways' });
    await h.migrate();
    expect(h.warnings).toHaveLength(1);
    expect(h.profiles).toHaveLength(1);
    expect(h.profiles[0].secretRef).toBeDefined();
  });

  it('team-file members that use only the person\'s own Custom key and endpoint migrate without a question', async () => {
    const h = harness({ fromTeamFile: true });
    await h.migrate();
    expect(h.warnings).toEqual([]);
    expect(h.profiles).toHaveLength(1);
  });

  it('the rule: own endpoint, and either the retired Custom key or no key copied', () => {
    const entry = { endpointBase: OWN_ENDPOINT, legacySecretName: LEGACY_CUSTOM_SECRET_NAME, secretRef: 'ref' };
    expect(isPersonsOwnLegacyCustomBinding(entry, OWN_ENDPOINT)).toBe(true);
    expect(isPersonsOwnLegacyCustomBinding({ ...entry, legacySecretName: projectKey }, OWN_ENDPOINT)).toBe(false);
    expect(isPersonsOwnLegacyCustomBinding({ ...entry, legacySecretName: projectKey, secretRef: undefined }, OWN_ENDPOINT)).toBe(true);
    expect(isPersonsOwnLegacyCustomBinding({ ...entry, endpointBase: 'https://elsewhere.example.test/v1' }, OWN_ENDPOINT)).toBe(false);
    expect(isPersonsOwnLegacyCustomBinding(entry, '')).toBe(false);
    expect(isPersonsOwnLegacyCustomBinding(entry, 'http://legacy.example.test/v1')).toBe(false);
  });
});
