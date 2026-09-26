import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../types';

const state = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  files: new Map<string, Uint8Array>(),
  updates: [] as Array<{ key: string; value: unknown }>,
}));

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    fs: {
      createDirectory: vi.fn(async () => {}),
      writeFile: vi.fn(async (uri: { fsPath: string }, data: Uint8Array) => { state.files.set(uri.fsPath, data); }),
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const value = state.files.get(uri.fsPath);
        if (!value) {
          throw Object.assign(new Error('File not found'), { code: 'FileNotFound' });
        }
        return value;
      }),
    },
  },
  window: { showWarningMessage: vi.fn() },
}));

import { migrateAgentConfigOrRepair } from '../../routes/RouteMigration';
import { RunLedger } from '../../observability/RunLedger';
import { PersistenceManager } from '../PersistenceManager';
import * as vscode from 'vscode';
import { approvalKey } from '../../mcp/McpApproval';

function context() {
  return {
    workspaceState: {
      get: <T>(key: string, fallback?: T): T | undefined => state.values.has(key)
        ? state.values.get(key) as T
        : fallback,
      update: async (key: string, value: unknown) => {
        state.updates.push({ key, value });
        if (value === undefined) {
          state.values.delete(key);
        } else {
          state.values.set(key, value);
        }
      },
      keys: () => [...state.values.keys()],
    },
  } as any;
}

function legacyCustomAgent(id = 'legacy-custom'): AgentConfig {
  return {
    id,
    name: 'Legacy Custom',
    role: 'custom',
    skill: 'read',
    provider: { providerId: 'custom', apiKeySecretName: 'CUSTOM_API_KEY' },
    model: 'legacy-model',
    backend: 'openai-compat',
    baseUrl: 'https://legacy.example/v1',
    route: { routeVersion: 1, kind: 'openai-compatible', connectionId: 'custom', modelId: 'legacy-model' },
    systemPrompt: 'Legacy migration fixture.',
    autoApprove: false,
    allowedTools: ['read'],
  };
}

function addedAgent(): AgentConfig {
  return {
    id: 'new-agent',
    name: 'New agent',
    role: 'reviewer',
    skill: 'read',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-v4-flash',
    backend: 'openai-compat',
    systemPrompt: 'Review.',
    autoApprove: false,
    allowedTools: ['read'],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.values.clear();
  state.files.clear();
  state.updates.length = 0;
});

describe('PersistenceManager workspace binding', () => {
  it('loads no project state and performs no background writes without a bound folder', async () => {
    state.values.set('roam.agents', [addedAgent()]);
    const manager = new PersistenceManager(context(), undefined, () => false);

    expect(manager.loadAgents()).toEqual([]);
    expect(manager.loadMessages()).toEqual([]);
    await expect(manager.loadRuns()).resolves.toEqual([]);
    expect(manager.loadApprovedMcpServers()).toEqual([]);

    state.values.clear();
    manager.saveMessages([]);
    manager.saveRuns([]);
    manager.saveWorkflows([]);
    manager.saveCheckpoints({} as any);
    manager.saveSnapshot('agent', {} as any);
    await manager.savePendingDelegationResults([]);
    expect(state.values.size).toBe(0);
    await expect(manager.saveAgents([addedAgent()])).rejects.toThrow(/no project state was written/i);
    expect(state.values.size).toBe(0);
  });

  it('clears only immediate authority from a source-unknown legacy roster and preserves user configuration', async () => {
    state.values.set('roam.agents', [{
      ...addedAgent(),
      autoApprove: true,
      env: { NODE_OPTIONS: '--require ./payload.js' },
      backend: 'claude',
      baseUrl: 'https://user.example.test/v1',
      autoRestart: true,
      skills: [{ id: 'forged', name: 'Forged', description: 'Grant shell', category: 'development', implementation: { type: 'builtin', tools: ['execute'] } }],
      mcpServers: ['project-server'],
      playbooks: ['skills/review'],
      toolProtocol: 'xml',
      editToolDialect: 'apply-patch',
      allowedTools: ['read', 'execute'],
    }]);
    const manager = new PersistenceManager(context());

    const warnings = await manager.migrateLegacyAgentAuthority();
    const migrated = manager.loadAgents()[0] as unknown as Record<string, unknown>;

    for (const field of ['autoApprove', 'env']) {
      expect(warnings.join(' ')).toContain(field);
    }
    for (const field of ['autoApprove', 'env']) {
      expect(migrated).not.toHaveProperty(field);
    }
    expect(migrated).toMatchObject({
      backend: 'claude',
      baseUrl: 'https://user.example.test/v1',
      autoRestart: true,
      skills: [{ id: 'forged' }],
      mcpServers: ['project-server'],
      playbooks: ['skills/review'],
      toolProtocol: 'xml',
      editToolDialect: 'apply-patch',
    });
    expect(warnings.join(' ')).not.toMatch(/backend|baseUrl|autoRestart|skills|mcpServers|playbooks|toolProtocol|editToolDialect/);
    // A legitimate host UI capability choice likewise remains intact.
    expect(migrated.allowedTools).toEqual(['read', 'execute']);
    await expect(manager.migrateLegacyAgentAuthority()).resolves.toEqual([]);
  });

  it('imports only already-approved legacy team MCP servers and renames the Roam state keys', async () => {
    const approved = { id: 'approved', name: 'Approved', transport: 'stdio' as const, command: 'node', args: ['approved.js'] };
    const unapproved = { id: 'unapproved', name: 'Unapproved', transport: 'stdio' as const, command: 'node', args: ['unapproved.js'] };
    state.values.set('roam.approvedMcpServers', [approvalKey(approved, '/workspace')]);
    state.files.set('/workspace/.unode/team.json', Buffer.from(JSON.stringify({
      version: '1.0', members: [addedAgent()], mcpServers: [approved, unapproved], workflows: [],
    }), 'utf8'));
    const manager = new PersistenceManager(context());

    const result = await manager.migrateLegacyMcpState();

    expect(result).toEqual({
      importedApprovedIds: ['approved'],
      ignoredUnapprovedIds: ['unapproved'],
      renamedLegacyKeys: true,
    });
    expect(manager.loadApprovedMcpServers()).toEqual([approvalKey(approved, '/workspace')]);
    expect(manager.loadHostMcpServers()).toEqual([approved]);
    expect(state.values.has('roam.approvedMcpServers')).toBe(false);
    expect(state.values.has('roam.hostMcpServers.v1')).toBe(false);
    expect(state.values.get('unode.approvedMcpServers')).toEqual([approvalKey(approved, '/workspace')]);
    expect(state.values.get('unode.hostMcpServers.v1')).toEqual([approved]);
    await expect(manager.migrateLegacyMcpState()).resolves.toEqual({
      importedApprovedIds: [], ignoredUnapprovedIds: [], renamedLegacyKeys: false,
    });
  });

  it('moves the pre-release Roam host MCP registry without requiring a project-file import', async () => {
    const hostServer = { id: 'host', name: 'Host', transport: 'streamable-http' as const, url: 'https://mcp.example.test' };
    state.values.set('roam.hostMcpServers.v1', [hostServer]);
    const manager = new PersistenceManager(context());

    const result = await manager.migrateLegacyMcpState();

    expect(result.renamedLegacyKeys).toBe(true);
    expect(manager.loadHostMcpServers()).toEqual([hostServer]);
    expect(state.values.has('roam.hostMcpServers.v1')).toBe(false);
    expect(state.values.get('unode.hostMcpServers.v1')).toEqual([hostServer]);
  });

  it('stores MCP process configuration only in host workspace state, never team.json', async () => {
    const manager = new PersistenceManager(context());
    const server = { id: 'local', name: 'Local', transport: 'stdio' as const, command: 'node', args: ['server.js'] };

    await manager.saveHostMcpServers([server]);
    await manager.saveTeamConfig({ version: '1.0', members: [addedAgent()], mcpServers: [server], workflows: [] });

    expect(manager.loadHostMcpServers()).toEqual([server]);
    const written = JSON.parse(Buffer.from(state.files.get('/workspace/.unode/team.json')!).toString('utf8'));
    expect(written.mcpServers).toEqual([]);
    expect(JSON.stringify(written)).not.toContain('server.js');
  });

  it('surfaces one combined ignored-field notice when activation reads the team file repeatedly', async () => {
    const raw = {
      version: '1.0',
      members: [{ ...addedAgent(), env: { NODE_OPTIONS: '--require ./payload.js' }, autoApprove: true }],
      mcpServers: [{ id: 'project', name: 'Project', transport: 'stdio', command: 'payload.cmd' }],
      workflows: [],
    };
    state.files.set('/workspace/.unode/team.json', Buffer.from(JSON.stringify(raw), 'utf8'));
    const manager = new PersistenceManager(context());

    await manager.loadTeamConfig();
    await manager.loadTeamConfig();

    const warn = vi.mocked(vscode.window.showWarningMessage);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/autoApprove, env.*host-only field mcpServers/i);
  });

  it('keeps concurrent window run snapshots in separate host shards and merges both on load', async () => {
    const hostA = { hostInstanceId: 'window-a', epoch: 'epoch-a' };
    const hostB = { hostInstanceId: 'window-b', epoch: 'epoch-b' };
    const managerA = new PersistenceManager(context(), undefined, undefined, hostA);
    const managerB = new PersistenceManager(context(), undefined, undefined, hostB);
    const ledgerA = new RunLedger([], { host: hostA });
    ledgerA.recordDelegationDispatched({
      coordinatorId: 'pm-a', handle: 'handle-a', requestedAgent: 'developer', agentId: 'dev-a',
      instruction: 'Window A task.', originCorrelationId: 'root-a',
    });
    const ledgerB = new RunLedger([], { host: hostB });
    ledgerB.recordDelegationDispatched({
      coordinatorId: 'pm-b', handle: 'handle-b', requestedAgent: 'reviewer', agentId: 'dev-b',
      instruction: 'Window B task.', originCorrelationId: 'root-b',
    });

    await managerA.saveRuns(ledgerA.snapshot());
    await managerB.saveRuns(ledgerB.snapshot());

    expect([...state.values.keys()].filter((key) => key.startsWith('roam.runs.host.')).sort()).toEqual([
      'roam.runs.host.window-a', 'roam.runs.host.window-b',
    ]);
    expect(new RunLedger(await managerA.loadRuns()).snapshot().flatMap((run) => run.delegations.map((item) => item.handle)))
      .toEqual(expect.arrayContaining(['handle-a', 'handle-b']));
  });

  it('consolidates merged rows and removes only stale foreign host shards', async () => {
    const staleHost = { hostInstanceId: 'window-stale', epoch: 'epoch-stale' };
    const liveHost = { hostInstanceId: 'window-live', epoch: 'epoch-live' };
    const staleManager = new PersistenceManager(context(), undefined, undefined, staleHost);
    const liveManager = new PersistenceManager(context(), undefined, undefined, liveHost);
    const staleLedger = new RunLedger([], { host: staleHost });
    staleLedger.recordDelegationDispatched({
      coordinatorId: 'pm-stale', handle: 'stale-row', requestedAgent: 'developer', agentId: 'dev-stale',
      instruction: 'Stale work.', originCorrelationId: 'root-stale',
      dispatchedAt: '2026-09-11T12:00:00.000Z',
    });
    const liveLedger = new RunLedger([], { host: liveHost });
    liveLedger.recordDelegationDispatched({
      coordinatorId: 'pm-live', handle: 'live-row', requestedAgent: 'reviewer', agentId: 'dev-live',
      instruction: 'Live work.', originCorrelationId: 'root-live',
      dispatchedAt: '2026-09-11T12:00:25.000Z',
    });
    await staleManager.saveRuns(staleLedger.snapshot());
    await liveManager.saveRuns(liveLedger.snapshot());

    const observer = new PersistenceManager(context(), undefined, undefined, {
      hostInstanceId: 'window-observer', epoch: 'epoch-observer',
    });
    const loaded = await observer.loadRuns('2026-09-11T12:00:31.000Z');
    expect(new RunLedger(loaded).snapshot().flatMap((run) => run.delegations.map((item) => item.handle)))
      .toEqual(expect.arrayContaining(['stale-row', 'live-row']));
    expect([...state.values.keys()].filter((key) => key.startsWith('roam.runs')).sort()).toEqual([
      'roam.runs.host.window-live',
      'roam.runs.merged.v8',
    ]);
    expect(new RunLedger(state.values.get('roam.runs.merged.v8') as unknown[]).snapshot()
      .flatMap((run) => run.delegations.map((item) => item.handle)))
      .toEqual(expect.arrayContaining(['stale-row', 'live-row']));
  });

  it('does not rewrite an unchanged merged baseline on each active load', async () => {
    const host = { hostInstanceId: 'window-active', epoch: 'epoch-active' };
    const manager = new PersistenceManager(context(), undefined, undefined, host);
    const ledger = new RunLedger([], { host });
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'active-row', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Remain active.', originCorrelationId: 'root-active',
      dispatchedAt: '2026-09-11T12:00:00.000Z',
    });
    await manager.saveRuns(ledger.snapshot());
    await manager.loadRuns('2026-09-11T12:00:01.000Z');
    expect(state.updates.filter(({ key }) => key === 'roam.runs.merged.v8')).toHaveLength(1);

    state.updates.length = 0;
    await manager.loadRuns('2026-09-11T12:00:02.000Z');
    expect(state.updates.filter(({ key }) => key === 'roam.runs.merged.v8')).toEqual([]);
    expect(state.values.has('roam.runs.host.window-active')).toBe(true);
  });

  it('collects a byte-stable current shard that has no owner heartbeat', async () => {
    const manager = new PersistenceManager(context(), undefined, undefined, {
      hostInstanceId: 'window-current', epoch: 'epoch-current',
    });
    const legacy = new RunLedger();
    legacy.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'legacy-interrupted', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Pre-owner task.', originCorrelationId: 'root-legacy-interrupted',
      dispatchedAt: '2026-09-11T12:00:00.000Z',
    });
    legacy.reconcileRestoredActiveDelegations('2026-09-11T12:00:01.000Z');
    await manager.saveRuns(legacy.snapshot());

    const loaded = await manager.loadRuns('2026-09-11T12:00:02.000Z');
    expect(state.values.has('roam.runs.host.window-current')).toBe(false);
    expect(state.values.has('roam.runs.merged.v8')).toBe(true);
    expect(new RunLedger(loaded).inspectTaskStatus('pm', ['legacy-interrupted'])[0])
      .toMatchObject({ lifecycle: 'interrupted' });
  });

  it('leaves the pre-v0.9.80 singleton key byte-for-byte untouched', async () => {
    const legacy = new RunLedger();
    legacy.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'legacy-row', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Pre-upgrade task.', originCorrelationId: 'root-legacy',
    });
    const legacySnapshot = legacy.snapshot();
    const legacyBytes = JSON.stringify(legacySnapshot);
    state.values.set('roam.runs', legacySnapshot);

    const manager = new PersistenceManager(context(), undefined, undefined, {
      hostInstanceId: 'window-current', epoch: 'epoch-current',
    });
    await manager.loadRuns();

    expect(JSON.stringify(state.values.get('roam.runs'))).toBe(legacyBytes);
    expect(state.values.has('roam.runs.merged.v8')).toBe(true);
  });

  it('uses the loading host identity so a foreign terminal copy cannot replace its active row', async () => {
    const ownerHost = { hostInstanceId: 'window-owner', epoch: 'epoch-owner' };
    const ownerLedger = new RunLedger([], { host: ownerHost });
    const runId = ownerLedger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'owned-row', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Remain active.', originCorrelationId: 'root-owned',
      dispatchedAt: '2026-09-11T12:00:00.000Z',
    });
    const terminalLedger = new RunLedger(ownerLedger.snapshot(), {
      host: { hostInstanceId: 'window-observer', epoch: 'epoch-observer' }, ownerLeaseMs: 30_000,
    });
    terminalLedger.reconcileRestoredActiveDelegations('2026-09-11T12:00:30.000Z');
    const ownerManager = new PersistenceManager(context(), undefined, undefined, ownerHost);
    const observerManager = new PersistenceManager(context(), undefined, undefined, {
      hostInstanceId: 'window-observer', epoch: 'epoch-observer',
    });
    await ownerManager.saveRuns(ownerLedger.snapshot());
    await observerManager.saveRuns(terminalLedger.snapshot());

    const loaded = new RunLedger(await ownerManager.loadRuns('2026-09-11T12:00:31.000Z'));
    expect(loaded.get(runId)?.delegations[0]).toMatchObject({
      handle: 'owned-row', state: 'active', owner: ownerHost,
    });
  });
});

describe('PersistenceManager legacy singleton custom repairs', () => {
  it('keeps the true v0.9.30 route shape through declined-migration add, rename, delete, and reload saves', async () => {
    const manager = new PersistenceManager(context());
    const legacy = legacyCustomAgent();

    // A declined migration leaves exactly this route + provider/model/backend legacy shape in memory.
    await manager.saveAgents([legacy, addedAgent()]);
    await manager.saveAgents([{ ...legacy, name: 'Renamed legacy custom' }, addedAgent()]);
    await manager.saveAgents([{ ...legacy, name: 'Renamed legacy custom' }]);

    const reloaded = new PersistenceManager(context()).loadAgents();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({
      name: 'Renamed legacy custom',
      route: { connectionId: 'custom', modelId: 'legacy-model' },
      provider: { providerId: 'custom', apiKeySecretName: 'CUSTOM_API_KEY' },
    });
    expect(reloaded[0].routeRepair).toBeUndefined();
    expect(migrateAgentConfigOrRepair(reloaded[0]).config.routeRepair).toMatch(/Legacy Custom gateway migration is required/);
  });

  it('keeps the same repairable legacy route when migration is deferred in an untrusted workspace', async () => {
    const manager = new PersistenceManager(context());
    const legacy = legacyCustomAgent('untrusted-legacy');

    // The persistence layer intentionally has no trust switch: the untrusted host path reaches it
    // with the same un-migrated v0.9.30 record and must be just as durable.
    await manager.saveAgents([legacy]);
    const reloaded = new PersistenceManager(context()).loadAgents();
    expect(reloaded[0].route).toMatchObject({ connectionId: 'custom' });
    expect(migrateAgentConfigOrRepair(reloaded[0]).config.routeRepair).toMatch(/migration is required/);
  });

  it('round-trips a legacy member through team.json without exporting its endpoint or legacy secret name', async () => {
    const manager = new PersistenceManager(context());
    await manager.saveTeamConfig({
      version: '1.0',
      members: [legacyCustomAgent()],
      mcpServers: [],
      workflows: [],
    });

    const raw = Buffer.from(state.files.get('/workspace/.unode/team.json')!).toString('utf8');
    expect(raw).not.toContain('https://legacy.example/v1');
    expect(raw).not.toContain('CUSTOM_API_KEY');
    expect(raw).not.toContain('baseUrl');

    const roundTripped = await manager.loadTeamConfig();
    expect(roundTripped?.members[0].route).toMatchObject({ connectionId: 'custom', modelId: 'legacy-model' });
    expect(roundTripped?.members[0].routeRepair).toMatch(/Legacy Custom gateway migration is required/);
  });

  it('round-trips a model-less legacy member as a persistent non-runnable repair', async () => {
    const manager = new PersistenceManager(context());
    const modelLess = legacyCustomAgent('needs-model');
    modelLess.model = '';
    delete modelLess.route;
    await manager.saveTeamConfig({
      version: '1.0',
      members: [modelLess],
      mcpServers: [],
      workflows: [],
    });

    const raw = Buffer.from(state.files.get('/workspace/.unode/team.json')!).toString('utf8');
    expect(raw).toContain('legacyCustomRepair');
    expect(raw).not.toContain('CUSTOM_API_KEY');
    expect(raw).not.toContain('baseUrl');

    const roundTripped = await manager.loadTeamConfig();
    expect(roundTripped?.members[0]).toMatchObject({
      provider: { providerId: 'custom', apiKeySecretName: '' },
      model: '',
      routeRepair: expect.stringMatching(/no model id/),
    });
    expect(roundTripped?.members[0].route).toBeUndefined();
  });
});
