import { describe, expect, it } from 'vitest';
import type { AgentBackendKind, AgentConfig } from '../../types';
import { agentRouteFromLegacyConfig } from '../ConnectionRegistry';
import {
  exportVersionedAgentConfig,
  migrateAgentConfig,
  migrateAgentConfigOrRepair,
  migrateUpdatedLegacyFields,
  withRouteModel,
} from '../RouteMigration';
import { LEGACY_CUSTOM_MISSING_MODEL_REPAIR } from '../../connections/LegacyCustomGatewayMigration';
import { CUSTOM_GATEWAY_ID, CUSTOM_GATEWAY_SECRET_REF, customGatewayResolver } from './customGatewayFixture';

function legacy(providerId: string, backend?: AgentBackendKind, model = 'example-model'): AgentConfig {
  return {
    id: `${providerId}-${backend ?? 'default'}`,
    name: 'Route test',
    role: 'custom',
    skill: 'read',
    provider: { providerId, apiKeySecretName: `${providerId.toUpperCase()}_KEY` },
    model,
    backend,
    systemPrompt: 'test',
    autoApprove: false,
    allowedTools: ['read'],
  };
}

describe('v0.9.30 route migration', () => {
  it.each([
    ['roam', 'openai-compat', 'roam'],
    ['unode', 'openai-compat', 'unode'],
    ['openrouter', 'openai-compat', 'openrouter'],
    ['openai', 'openai-compat', 'openai'],
  ] as const)('keeps explicit OpenAI-compatible provider %s on its own connection', (provider, backend, connectionId) => {
    const route = agentRouteFromLegacyConfig(legacy(provider, backend, 'claude-opus-looking-name'));
    expect(route).toEqual({ routeVersion: 1, kind: 'openai-compatible', connectionId, modelId: 'claude-opus-looking-name' });
  });

  it('maps the CLI providers only from their explicit provider/backend pair', () => {
    expect(agentRouteFromLegacyConfig(legacy('anthropic', 'claude'))).toMatchObject({ kind: 'claude-headless', connectionId: 'claude-cli' });
    expect(agentRouteFromLegacyConfig(legacy('codex', 'codex'))).toMatchObject({ kind: 'codex-headless', connectionId: 'codex-cli' });
    expect(() => agentRouteFromLegacyConfig(legacy('codex'))).toThrow(/requires backend "codex"/);
  });

  it('covers every legacy provider × backend combination without inferring a route from the model', () => {
    const providers = ['roam', 'unode', 'openrouter', 'openai', 'anthropic', 'codex'] as const;
    const backends: Array<AgentBackendKind | undefined> = [undefined, 'openai-compat', 'claude', 'codex'];
    for (const provider of providers) {
      for (const backend of backends) {
        const expectedBackend = provider === 'anthropic'
          ? 'claude'
          : provider === 'codex'
            ? 'codex'
            : 'openai-compat';
        const isLegacyDefault = backend === undefined && provider !== 'codex';
        const isConsistent = backend === expectedBackend;
        const config = legacy(provider, backend, 'model-spelling-is-not-a-route');
        if (isLegacyDefault || isConsistent) {
          expect(agentRouteFromLegacyConfig(config)).toMatchObject({
            connectionId: provider === 'anthropic' ? 'claude-cli' : provider === 'codex' ? 'codex-cli' : provider,
          });
        } else {
          expect(() => agentRouteFromLegacyConfig(config)).toThrow(/conflicts|requires backend/i);
        }
      }
    }
  });

  it.each([
    ['roam', 'claude'], ['roam', 'codex'],
    ['anthropic', 'openai-compat'], ['anthropic', 'codex'],
    ['codex', 'openai-compat'], ['codex', 'claude'],
    ['missing-provider', 'openai-compat'],
    ['custom', 'openai-compat'],
  ] as const)('rejects conflicting or hand-edited legacy pair %s / %s instead of guessing', (provider, backend) => {
    expect(() => agentRouteFromLegacyConfig(legacy(provider, backend))).toThrow(/conflicts|requires backend|unknown provider/i);
  });

  it('migrates an opaque custom connection only through the current effective resolver', () => {
    const resolver = customGatewayResolver();
    const config = legacy(CUSTOM_GATEWAY_ID, 'openai-compat', 'gateway-model');
    config.provider.apiKeySecretName = CUSTOM_GATEWAY_SECRET_REF;

    expect(migrateAgentConfig(config, resolver).config.route).toEqual({
      routeVersion: 1,
      kind: 'openai-compatible',
      connectionId: CUSTOM_GATEWAY_ID,
      modelId: 'gateway-model',
    });
    expect(() => migrateAgentConfig(config)).toThrow(/unknown provider/);
  });

  it('retains an unavailable opaque custom route only as a non-runnable repair record', () => {
    const config = {
      ...legacy('roam', 'openai-compat', 'gateway-model'),
      route: { routeVersion: 1, kind: 'openai-compatible' as const, connectionId: CUSTOM_GATEWAY_ID, modelId: 'gateway-model' },
    };

    const repaired = migrateAgentConfigOrRepair(config);
    expect(repaired.config.routeRepair).toMatch(/unavailable on this machine/);
    expect(repaired.config.provider).toEqual({ providerId: CUSTOM_GATEWAY_ID, apiKeySecretName: '' });
    expect(migrateAgentConfigOrRepair(config, customGatewayResolver()).config.routeRepair).toBeUndefined();

    const restored = { ...repaired.config };
    delete restored.routeRepair;
    expect(migrateAgentConfigOrRepair(restored).changed).toBe(false);
  });

  it('keeps the true v0.9.30 singleton route as a persistable non-runnable repair item', () => {
    const source = legacy('custom', 'openai-compat', 'legacy-model');
    source.baseUrl = 'https://legacy.example/v1';
    source.route = { routeVersion: 1, kind: 'openai-compatible', connectionId: 'custom', modelId: 'legacy-model' };
    const repaired = migrateAgentConfigOrRepair(source);
    expect(repaired.changed).toBe(false);
    expect(repaired.config.route).toEqual(source.route);
    expect(repaired.config.routeRepair).toMatch(/Legacy Custom gateway migration is required/);
    expect(repaired.config.provider.providerId).toBe('custom');

    const exported = exportVersionedAgentConfig(repaired.config);
    expect(exported.route).toEqual(source.route);
    expect(exported).not.toHaveProperty('provider');
    expect(exported).not.toHaveProperty('baseUrl');
  });

  it('exports a model-less legacy repair as a closed marker without its legacy secret or endpoint', () => {
    const source = legacy('custom', 'openai-compat', '');
    source.baseUrl = 'https://legacy.example/v1';
    const repaired = migrateAgentConfigOrRepair(source);
    const exported = exportVersionedAgentConfig(repaired.config);

    expect(exported).toMatchObject({ legacyCustomRepair: LEGACY_CUSTOM_MISSING_MODEL_REPAIR });
    expect(exported).not.toHaveProperty('route');
    expect(exported).not.toHaveProperty('provider');
    expect(exported).not.toHaveProperty('baseUrl');
  });

  it('marks a registered keyless custom profile non-runnable without borrowing another key', () => {
    const source = legacy(CUSTOM_GATEWAY_ID, 'openai-compat', 'gateway-model');
    source.provider.apiKeySecretName = '';
    const repaired = migrateAgentConfigOrRepair(source, customGatewayResolver({ includeSecret: false }));
    expect(repaired.config.routeRepair).toMatch(/has no API key configured/);
    expect(repaired.config.provider.apiKeySecretName).toBe('');
  });

  it('is idempotent and makes the route, not legacy model spelling, authoritative', () => {
    const first = migrateAgentConfig(legacy('roam', 'openai-compat', 'codex-via-gateway'));
    const second = migrateAgentConfig(first.config);
    expect(first.config.route).toEqual({ routeVersion: 1, kind: 'openai-compatible', connectionId: 'roam', modelId: 'codex-via-gateway' });
    expect(second.changed).toBe(false);
    expect(second.config).toEqual(first.config);
  });

  it('rebuilds a route only for an explicit user provider/model edit', () => {
    const current = migrateAgentConfig(legacy('roam', 'openai-compat', 'old-model')).config;
    const changed = migrateUpdatedLegacyFields({
      ...current,
      provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
      backend: 'claude',
      model: 'claude-sonnet-5',
    }).config;
    expect(changed.route).toEqual({ routeVersion: 1, kind: 'claude-headless', connectionId: 'claude-cli', modelId: 'claude-sonnet-5' });
  });

  it('keeps a versioned connection fixed when only its model changes', () => {
    const current = migrateAgentConfig(legacy('openrouter', 'openai-compat', 'first')).config;
    const changed = withRouteModel(current, 'second');
    expect(changed.model).toBe('second');
    expect(changed.route).toEqual({ routeVersion: 1, kind: 'openai-compatible', connectionId: 'openrouter', modelId: 'second' });
  });

  it('fails visibly for malformed persisted provider data', () => {
    const malformed = { ...legacy('roam', 'openai-compat'), provider: undefined } as unknown as AgentConfig;
    expect(() => migrateAgentConfig(malformed)).toThrow(/unknown provider/);
  });

  it('exports only the versioned selection and hydrates it when a new team file is read', () => {
    const source = migrateAgentConfig(legacy('roam', 'openai-compat', 'claude-name-through-gateway')).config;
    const exported = exportVersionedAgentConfig(source);
    expect(exported).not.toHaveProperty('provider');
    expect(exported).not.toHaveProperty('model');
    expect(exported).not.toHaveProperty('backend');
    expect(exported.route).toEqual({
      routeVersion: 1,
      kind: 'openai-compatible',
      connectionId: 'roam',
      modelId: 'claude-name-through-gateway',
    });

    const rehydrated = migrateAgentConfig(exported as AgentConfig).config;
    expect(rehydrated.provider).toEqual({ providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' });
    expect(rehydrated.model).toBe('claude-name-through-gateway');
    expect(rehydrated.backend).toBe('openai-compat');
  });
});
