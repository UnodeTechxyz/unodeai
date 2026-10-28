import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const state = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), values: new Map<string, unknown>() }));
vi.mock('vscode', () => ({
  Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }), joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }) },
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    fs: {
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const bytes = state.files.get(uri.fsPath);
        if (!bytes) throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
        return bytes;
      }),
      createDirectory: vi.fn(async () => {}),
      writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => { state.files.set(uri.fsPath, bytes); }),
    },
  },
  window: { showWarningMessage: vi.fn() },
}));

import * as vscode from 'vscode';
import { PersistenceManager, serializeVersionedTeamFile } from '../PersistenceManager';
import { completionVerificationFields, TeamVerificationConfigurationError } from '../TeamFileSchema';
import { AgentConfigBuilder } from '../../roles/RoleConfig';
import type { AgentConfig } from '../../types';
import { withoutIntegrationGrant } from '../../mcp/IntegrationRemoval';
import { PersistentLegacyCustomMigrationDeclines } from '../../connections/PersistentLegacyCustomMigrationDeclines';
import {
  applyLegacyCustomGatewayMigration, isLegacySingletonCustomAgent, planLegacyCustomGatewayMigration,
  LEGACY_CUSTOM_PROVIDER_ID,
} from '../../connections/LegacyCustomGatewayMigration';
import { legacyMigrationRosterSignature } from '../../connections/LegacyMigrationRosterSignature';
import { AgentRosterEdits } from '../../host/AgentRosterEdits';
import { migrateLegacyCommandTools, legacyCommandMigrationNotice } from '../../host/LegacyCommandTools';
import { hasUnavailableConnectionRepair } from '../../routes/RouteMigration';

const TEAM = '/workspace/.unode/team.json';
const JOURNAL = 'unode.migration.legacyCustomGateway.v1';
const context = () => ({ workspaceState: {
  get: (key: string, fallback: unknown) => state.values.has(key) ? state.values.get(key) : fallback,
  update: async (key: string, value: unknown) => { state.values.set(key, value); }, keys: () => [...state.values.keys()],
} }) as any;

/** Run the actual extension functions against the real persistence class, following cliRuntimeWiring.test.ts.
 * Only unrelated host services are stand-ins. This is a restore-path test, not a full VS Code activation test. */
function startupFunctions(persistence: PersistenceManager) {
  const source = ts.createSourceFile('extension.ts', readFileSync(resolve('src/extension.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const wanted = [
    'restoreRoster', 'migrateLegacySingletonCustomGateways', 'removeManagedIntegration', 'persistMcpServerToTeamFile',
    'readLegacyCustomGatewayMigrationState', 'readLegacyCustomGatewayTerminalRepairs',
    'isJournaledLegacyMigrationSplit', 'legacyAgentIdsAreCoveredByJournal',
  ];
  const bodies = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
    && !!node.name && wanted.includes(node.name.text));
  expect(bodies.map((node) => node.name!.text).sort()).toEqual([...wanted].sort());
  const host = {
    migrateLegacyCommandTools, legacyCommandMigrationNotice,
    persistence, vscode, completionVerificationFields, teamCompactionOverrides: undefined, mcpRegistry: new Map(),
    firstWorkspaceRoot: () => '/workspace', rootWorkspaceState: context().workspaceState,
    PersistentLegacyCustomMigrationDeclines,
    hydratedLegacyTeamAgents: vi.fn(() => { throw new Error('invalid file must not reach migration'); }),
    effectiveConnectionRegistry: {},
    migrateAgentConfigOrRepair: (config: unknown) => ({ config, changed: false }),
    hasUnavailableConnectionRepair,
    migratePromptTemplateSource: () => false,
    sessionManager: { create: vi.fn(), getAll: (): Array<{ config: AgentConfig }> => [] },
    outputChannel: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    showResultNotice: vi.fn(), teamViewProvider: { refresh: vi.fn() }, registerReferencedMcpServers: vi.fn(),
    agentMcpGrants: (agent: AgentConfig) => (agent.mcpServers ?? []).map((serverId) => ({ serverId })),
    skillResolver: { resolveMcpServerRefs: () => [] }, withoutIntegrationGrant,
    cancelPendingMcpMount: vi.fn(), mcpHub: { unregister: vi.fn() },
    approvalKey: () => undefined, approvedMcp: new Set<string>(), mcpMountDetails: new Map(),
    settingsPanelRefresh: vi.fn(), chatViewProvider: { refresh: vi.fn() },
    isLegacySingletonCustomAgent, applyLegacyCustomGatewayMigration, legacyMigrationRosterSignature,
    LEGACY_CUSTOM_PROVIDER_ID, LEGACY_CUSTOM_GATEWAY_MIGRATION_KEY: JOURNAL,
    LEGACY_CUSTOM_GATEWAY_TERMINAL_REPAIRS_KEY: 'unode.migration.legacyCustomGateway.terminalRepairs.v1',
    loadCustomGatewayRegistryOrFallback: vi.fn(async (): Promise<{ profiles: unknown[] }> => ({ profiles: [] })),
    reloadEffectiveConnectionRegistry: vi.fn(), makeConfigStore: () => ({ get: () => 'unode' }),
  };
  const js = ts.transpileModule(bodies.map((node) => node.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  Object.assign(host, { agentRosterEdits: new AgentRosterEdits({
    members: () => host.sessionManager.getAll().map(session => session.config), revision: () => 0,
    currentWorkspace: () => true, persist: members => persistence.saveAgents(members),
  }) });
  return { host, functions: new Function('host', `with (host) { ${js}; return { ${wanted.join(', ')} }; }`)(host) as {
    restoreRoster(): Promise<boolean>;
    migrateLegacySingletonCustomGateways(): Promise<void>;
    removeManagedIntegration(id: string): Promise<{ ok: boolean; message: string }>;
    persistMcpServerToTeamFile(config: unknown): Promise<void>;
  } };
}

beforeEach(() => { state.files.clear(); state.values.clear(); vi.clearAllMocks(); });

describe('T1a I1: invalid policy cannot abort the live startup restore path', () => {
  it('strict verification reads distinguish genuine absence from malformed or unreadable team files', async () => {
    const manager = new PersistenceManager(context());
    await expect(manager.loadTeamConfig({ strict: true })).resolves.toBeUndefined();
    state.files.set(TEAM, Buffer.from('{malformed'));
    await expect(manager.loadTeamConfig({ strict: true })).rejects.toBeInstanceOf(SyntaxError);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    // The startup/best-effort reader retains its existing recovery behavior.
    await expect(manager.loadTeamConfig()).resolves.toBeUndefined();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('ignored'));
    vi.mocked(vscode.window.showWarningMessage).mockClear();
    vi.mocked(vscode.workspace.fs.readFile).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'NoPermissions' }));
    await expect(manager.loadTeamConfig({ strict: true })).rejects.toMatchObject({ code: 'NoPermissions' });
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });
  it.each([
    [{ mode: 'Auto' }, true], [{ mode: 'Auto' }, false],
    [{ mode: 'auto', extra: true }, true], [{ mode: 'command', command: 'npm test\n' }, false],
  ])('restores saved-or-empty roster, reports once, and preserves invalid %j (saved=%s)', async (policy, saved) => {
    const manager = new PersistenceManager(context());
    const agent = new AgentConfigBuilder().fromTemplate('senior-dev').setId('saved').build();
    if (saved) await manager.saveAgents([agent]);
    const original = Buffer.from(JSON.stringify({ members: [agent], mcpServers: [], workflows: [], completionVerification: policy }));
    state.files.set(TEAM, original);
    const { host, functions } = startupFunctions(manager);
    await expect(functions.migrateLegacySingletonCustomGateways()).resolves.toBeUndefined();
    expect(host.hydratedLegacyTeamAgents).not.toHaveBeenCalled();
    await expect(functions.restoreRoster()).resolves.toBe(true);
    expect(host.sessionManager.create).toHaveBeenCalledTimes(saved ? 1 : 0);
    if (saved) expect(host.sessionManager.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'saved' }));
    expect(state.files.get(TEAM)).toEqual(original);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('completionVerification'));
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('team file was not changed'));
    // Recovery is not the verification reader: it carries a distinct invalid result, not missing/disabled.
    const startupRead = await manager.loadTeamConfigForStartup();
    expect(startupRead).toMatchObject({ kind: 'configuration-invalid', error: expect.any(TeamVerificationConfigurationError) });
    await expect(manager.loadTeamConfig()).rejects.toBeInstanceOf(TeamVerificationConfigurationError);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('startup recovery does not swallow unrelated errors', async () => {
    const manager = new PersistenceManager(context());
    vi.spyOn(manager, 'loadTeamConfig').mockRejectedValueOnce(new Error('unexpected host failure'));
    await expect(manager.loadTeamConfigForStartup()).rejects.toThrow('unexpected host failure');
  });

  it('distinguishes absence and a valid policy after the file is explicitly repaired', async () => {
    const manager = new PersistenceManager(context());
    expect(await manager.loadTeamConfigForStartup()).toEqual({ kind: 'ready', document: undefined });
    state.files.set(TEAM, Buffer.from('{"completionVerification":{"mode":"Auto"}}'));
    expect((await manager.loadTeamConfigForStartup()).kind).toBe('configuration-invalid');
    state.files.set(TEAM, Buffer.from('{"members":[],"completionVerification":{"mode":"disabled"}}'));
    expect(await manager.loadTeamConfigForStartup()).toMatchObject({ kind: 'ready', document: { completionVerification: { mode: 'disabled' } } });
  });

  it('integration revocation returns the configuration refusal rather than rejecting outside its handler', async () => {
    state.files.set(TEAM, Buffer.from('{"completionVerification":{"mode":"Auto"}}'));
    const { host, functions } = startupFunctions(new PersistenceManager(context()));
    host.mcpRegistry.set('mcp', { id: 'mcp', name: 'Example' });
    const showWarning = vi.mocked(vscode.window.showWarningMessage);
    showWarning.mockResolvedValueOnce('Remove & Revoke' as any);
    await expect(functions.removeManagedIntegration('mcp')).resolves.toMatchObject({ ok: false, message: expect.stringContaining('completionVerification') });
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('MCP addition refuses before saving any host integration when the team policy is invalid', async () => {
    state.files.set(TEAM, Buffer.from('{"completionVerification":{"mode":"Auto"}}'));
    const manager = new PersistenceManager(context());
    const saveHost = vi.spyOn(manager, 'saveHostMcpServers');
    const { functions } = startupFunctions(manager);
    await expect(functions.persistMcpServerToTeamFile({ id: 'mcp' })).rejects.toBeInstanceOf(TeamVerificationConfigurationError);
    expect(saveHost).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('completionVerification'));
  });

  it('MCP addition preserves a policy/profile edit committed after its preflight read', async () => {
    const manager = new PersistenceManager(context());
    await manager.saveTeamConfig({ members: [], workflows: [], mcpServers: [], completionVerification: { mode: 'auto' } });
    vi.spyOn(manager, 'saveHostMcpServers').mockImplementationOnce(async () => {
      await manager.updateTeamConfig((current) => ({
        ...current!, completionVerification: { mode: 'disabled' }, smartCompactionProfiles: { balanced: { windowPercent: 60 } },
      }));
    });
    const { functions } = startupFunctions(manager);
    await functions.persistMcpServerToTeamFile({ id: 'mcp' });
    expect(await manager.loadTeamConfig({ strict: true })).toMatchObject({
      completionVerification: { mode: 'disabled' }, smartCompactionProfiles: { balanced: { windowPercent: 60 } },
    });
  });

  it('MCP addition does not replace malformed JSON or save a host server after a failed preflight', async () => {
    const original = Buffer.from('{ broken'); state.files.set(TEAM, original);
    const manager = new PersistenceManager(context());
    const saveHost = vi.spyOn(manager, 'saveHostMcpServers');
    const { functions } = startupFunctions(manager);
    await expect(functions.persistMcpServerToTeamFile({ id: 'mcp' })).rejects.toThrow('could not be read');
    expect(saveHost).not.toHaveBeenCalled();
    expect(state.files.get(TEAM)).toEqual(original);
  });

  it('startup refuses a stale roster migration before overwriting host workspace state', async () => {
    const manager = new PersistenceManager(context());
    const original = new AgentConfigBuilder().fromTemplate('senior-dev').setId('outgoing').build();
    const incoming = new AgentConfigBuilder().fromTemplate('senior-dev').setId('incoming').build();
    await manager.saveTeamConfig({ members: [original], workflows: [], mcpServers: [] });
    const update = manager.updateTeamConfig.bind(manager);
    vi.spyOn(manager, 'updateTeamConfig').mockImplementationOnce((edit, expected) => {
      state.files.set(TEAM, Buffer.from(serializeVersionedTeamFile({
        members: [incoming], workflows: [], mcpServers: [], completionVerification: { mode: 'disabled' },
      })));
      return update(edit, expected);
    });
    const saveAgents = vi.spyOn(manager, 'saveAgents');
    const { host, functions } = startupFunctions(manager);
    host.migratePromptTemplateSource = () => true;
    await expect(functions.restoreRoster()).resolves.toBe(true);
    expect(host.showResultNotice).toHaveBeenCalledWith('warning', expect.stringContaining('could not be saved'));
    expect(saveAgents).not.toHaveBeenCalled();
    expect(host.sessionManager.create).toHaveBeenCalled();
    expect((await manager.loadTeamConfig({ strict: true }))?.members.map((agent) => agent.id)).toEqual(['incoming']);
  });

  it('revokes from the latest queued file members, not the captured live roster', async () => {
    const manager = new PersistenceManager(context());
    const live = { ...new AgentConfigBuilder().fromTemplate('senior-dev').setId('live').build(), mcpServers: ['mcp', 'keep'] };
    const incoming = { ...live, id: 'incoming', name: 'New file member' };
    await manager.saveAgents([live]);
    await manager.saveTeamConfig({ members: [live], workflows: [], mcpServers: [], completionVerification: { mode: 'auto' } });
    const { host, functions } = startupFunctions(manager);
    host.mcpRegistry.set('mcp', { id: 'mcp', name: 'Example' });
    vi.spyOn(host.sessionManager, 'getAll').mockReturnValue([{ config: live }]);
    // The handler has captured the live roster when the modal opens. Another edit commits before
    // revocation enters the persistence queue, with both a different roster and a new policy.
    vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(async () => {
      await manager.updateTeamConfig((current) => ({
        ...current!, members: [incoming], completionVerification: { mode: 'disabled' },
      }));
      return 'Remove & Revoke' as any;
    });
    await expect(functions.removeManagedIntegration('mcp')).resolves.toMatchObject({ ok: true });
    const file = await manager.loadTeamConfig({ strict: true });
    expect(file?.members.map((agent) => ({ id: agent.id, name: agent.name })))
      .toEqual([{ id: 'incoming', name: 'New file member' }]);
    // Ordinary project files cannot carry host-only integration grants, including the unrelated one.
    expect(file?.members[0].mcpServers).toBeUndefined();
    expect(JSON.parse(Buffer.from(state.files.get(TEAM)!).toString('utf8')).members[0].mcpServers).toBeUndefined();
    expect(file?.completionVerification).toEqual({ mode: 'disabled' });
    expect(manager.loadAgents().map((agent) => ({ id: agent.id, mcpServers: agent.mcpServers })))
      .toEqual([{ id: 'live', mcpServers: ['keep'] }]);
    expect(live.mcpServers).toEqual(['keep']);
    expect(host.mcpHub.unregister).toHaveBeenCalledWith('mcp');
  });

  it('a refused Custom gateway file migration leaves host state untouched and its journal resumable', async () => {
    const manager = new PersistenceManager(context());
    const legacy: AgentConfig = {
      ...new AgentConfigBuilder().fromTemplate('senior-dev').setId('legacy').build(),
      provider: { providerId: 'custom', apiKeySecretName: 'CUSTOM_API_KEY' }, route: undefined,
      backend: undefined, model: 'model', baseUrl: undefined,
    };
    await manager.saveAgents([legacy]);
    const seedLegacy = (members: AgentConfig[]) => state.files.set(TEAM, Buffer.from(JSON.stringify({
      members, workflows: [], mcpServers: [], completionVerification: { mode: 'disabled' },
    })));
    // This is a pre-versioned legacy file; the new writer intentionally cannot create retired routes.
    seedLegacy([legacy]);
    const canonicalHost = manager.loadAgents();
    expect(legacyMigrationRosterSignature((await manager.loadTeamConfig({ strict: true }))!.members))
      .toBe(legacyMigrationRosterSignature(canonicalHost));
    const plan = planLegacyCustomGatewayMigration({
      trusted: true, agents: canonicalHost, legacyGlobalEndpoint: 'https://gateway.example/v1',
      nextOpaqueId: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(plan.entries).toHaveLength(1);
    const journal = { schemaVersion: 1, sourceAgentIds: ['legacy'], plan };
    state.values.set(JOURNAL, journal);
    const { host, functions } = startupFunctions(manager);
    host.hydratedLegacyTeamAgents = vi.fn((agents: AgentConfig[]) => agents) as any;
    // A pending journal may already have imported its profile before a crash. Reuse the exact
    // planned profile; resumption must not import a new identity or ask for approval again.
    host.loadCustomGatewayRegistryOrFallback.mockResolvedValue({ profiles: plan.entries.map((entry) => ({ ...entry })) });
    const update = manager.updateTeamConfig.bind(manager);
    vi.spyOn(manager, 'updateTeamConfig').mockImplementationOnce((edit, expected) => {
      seedLegacy([{ ...legacy, id: 'incoming' }]);
      return update(edit, expected);
    });
    const saveAgents = vi.spyOn(manager, 'saveAgents');
    await functions.migrateLegacySingletonCustomGateways();
    expect(host.showResultNotice).toHaveBeenCalledWith('warning', expect.stringContaining('team roster changed'));
    expect(saveAgents).not.toHaveBeenCalled();
    expect(manager.loadAgents()).toEqual(canonicalHost);
    expect(state.values.get(JOURNAL)).toEqual(journal);
    expect((await manager.loadTeamConfig({ strict: true }))?.members.map((agent) => agent.id)).toEqual(['incoming']);

    // Explicit repair restores the intended roster. The same actual migration consumes the retained
    // journal, writes the team file before host state, and clears it only after both writes succeed.
    seedLegacy([legacy]);
    await functions.migrateLegacySingletonCustomGateways();
    expect(saveAgents).toHaveBeenCalledTimes(1);
    const migrated = applyLegacyCustomGatewayMigration(canonicalHost, plan);
    expect(saveAgents).toHaveBeenCalledWith(migrated);
    expect(manager.loadAgents()).toEqual(migrated.map(({ routeRepair: _derived, ...agent }) => agent));
    expect((await manager.loadTeamConfig({ strict: true }))?.members[0].route?.connectionId).toBe(plan.entries[0].connectionId);
    expect((await manager.loadTeamConfig({ strict: true }))?.completionVerification).toEqual({ mode: 'disabled' });
    expect(state.values.get(JOURNAL)).toBeUndefined();
    // Ambient schema warnings are expected; a resumed journal must not open a migration modal.
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls.every((args) => args.length === 1)).toBe(true);
  });
});
