import { describe, it, expect } from 'vitest';
import { SettingsBridge, SecretStore, ConfigStore, ProviderDef, McpStateSource } from '../SettingsBridge';
import { MCPServerConfig } from '../../types';

function fakeSecrets(initial: Record<string, string> = {}): SecretStore & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    has: async (n) => store.has(n),
    delete: async (n) => { store.delete(n); },
  };
}

function fakeConfig(initial: Record<string, unknown> = {}): ConfigStore & { values: Map<string, unknown> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: <T>(k: string, fb: T) => (values.has(k) ? (values.get(k) as T) : fb),
    update: async (k, v) => { values.set(k, v); },
  };
}

const PROVIDERS: ProviderDef[] = [
  { providerId: 'roam', name: 'Roam', apiKeySecretName: 'ROAM_API_KEY', baseUrl: 'https://gw/v1', authKind: 'api-key', catalogKind: 'openai-models', presentation: { displayName: 'Roam', runtimeLabel: 'OpenAI-compatible', billingLabel: 'Roam', privacySummary: 'gateway', setup: { kind: 'api-key', actionLabel: 'Set API key' } } },
  { providerId: 'anthropic', name: 'Claude Headless', authKind: 'claude-cli', catalogKind: 'claude-cli', presentation: { displayName: 'Claude Headless', runtimeLabel: 'Claude Headless', billingLabel: 'Claude account', privacySummary: 'CLI', setup: { kind: 'cli', actionLabel: 'Set up Claude', installCommand: 'npm install -g @anthropic-ai/claude-code', loginCommand: 'claude login' } } },
  { providerId: 'openai', name: 'OpenAI', apiKeySecretName: 'OPENAI_API_KEY', authKind: 'api-key', catalogKind: 'openai-models', presentation: { displayName: 'OpenAI', runtimeLabel: 'OpenAI-compatible', billingLabel: 'OpenAI', privacySummary: 'API', setup: { kind: 'api-key', actionLabel: 'Set API key' } } },
];

describe('SettingsBridge (P1#4b)', () => {
  it('reports hasApiKey without ever exposing the key value', async () => {
    const secrets = fakeSecrets({ ROAM_API_KEY: 'sk-super-secret' });
    const bridge = new SettingsBridge(secrets, fakeConfig(), PROVIDERS);
    const statuses = await bridge.getProviderStatuses();

    const roam = statuses.find((s) => s.providerId === 'roam')!;
    expect(roam.hasApiKey).toBe(true);
    expect(roam.baseUrl).toBe('https://gw/v1');
    expect(roam.catalogKind).toBe('openai-models');
    // Nothing in the serialized snapshot may contain the secret value.
    expect(JSON.stringify(statuses)).not.toContain('sk-super-secret');

    const openai = statuses.find((s) => s.providerId === 'openai')!;
    expect(openai.hasApiKey).toBe(false);
  });

  it('marks CLI-auth providers (claude) as not needing a stored key', async () => {
    const secrets = fakeSecrets({ ANTHROPIC_API_KEY: 'should-be-ignored' });
    const bridge = new SettingsBridge(secrets, fakeConfig(), PROVIDERS);
    const anthropic = (await bridge.getProviderStatuses()).find((s) => s.providerId === 'anthropic')!;
    expect(anthropic.authKind).toBe('claude-cli');
    expect(anthropic.hasApiKey).toBe(false); // CLI auth — we don't use the stored key
  });

  it('can delete an API key but deliberately has no setter bypass', async () => {
    const secrets = fakeSecrets({ OPENAI_API_KEY: 'sk-new' });
    const bridge = new SettingsBridge(secrets, fakeConfig(), PROVIDERS);
    expect('setApiKey' in bridge).toBe(false);
    await bridge.deleteApiKey('OPENAI_API_KEY');
    expect(secrets.store.has('OPENAI_API_KEY')).toBe(false);
  });

  it('maps the MCP registry to backend-aware status (connected/grantedTo)', async () => {
    const registry = new Map<string, MCPServerConfig>([
      ['fs', { id: 'fs', name: 'Filesystem', transport: 'stdio', requiresApproval: true }],
      ['gh', { id: 'gh', name: 'GitHub', transport: 'stdio' }],
    ]);
    const mcp: McpStateSource = {
      registry,
      connected: (id) => (id === 'fs' ? { ready: true, toolCount: 5 } : undefined),
      grantedTo: (id) => (id === 'fs' ? ['dev', 'reviewer'] : []),
    };
    const bridge = new SettingsBridge(fakeSecrets(), fakeConfig(), PROVIDERS, mcp);
    const servers = bridge.getMcpServers();

    const fs = servers.find((s) => s.id === 'fs')!;
    expect(fs).toMatchObject({ requiresApproval: true, connected: true, toolCount: 5, grantedTo: ['dev', 'reviewer'] });
    const gh = servers.find((s) => s.id === 'gh')!;
    expect(gh).toMatchObject({ requiresApproval: false, connected: false, toolCount: 0, grantedTo: [] });
  });

  it('passes config reads/writes through to the config store (single source of truth)', async () => {
    const config = fakeConfig({ maxConcurrentAgents: 4 });
    const bridge = new SettingsBridge(fakeSecrets(), config, PROVIDERS);
    expect(bridge.getConfig('maxConcurrentAgents', 0)).toBe(4);
    await bridge.setConfig('verifyCommand', 'npm run build');
    expect(config.values.get('verifyCommand')).toBe('npm run build');
  });
});
