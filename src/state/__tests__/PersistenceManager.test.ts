import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../types';

const state = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  files: new Map<string, Uint8Array>(),
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
import { PersistenceManager } from '../PersistenceManager';

function context() {
  return {
    workspaceState: {
      get: <T>(key: string, fallback?: T): T | undefined => state.values.has(key)
        ? state.values.get(key) as T
        : fallback,
      update: async (key: string, value: unknown) => {
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
  state.values.clear();
  state.files.clear();
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
