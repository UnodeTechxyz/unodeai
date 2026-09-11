import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  CONNECTION_PROFILES,
  CONNECTION_SETUP_GROUPS,
  agentRouteFromLegacyConfig,
  apiKeySecretNameForRoute,
  assertActiveConnectionProfile,
  assertAgentConfigApiKeyOwnership,
  authIdentityRefForRoute,
  captureActiveConnectionProfile,
  connectionProfile,
  displayNameForProviderId,
  manifestDefaultConnectionIds,
  resolveAvailableDefaultProviderId,
} from '../ConnectionRegistry';
import { ModelPricing } from '../../models/ModelPricing';
import { CUSTOM_GATEWAY_ID, CUSTOM_GATEWAY_SECRET_REF, customGatewayResolver } from './customGatewayFixture';
import {
  AGENT_ROUTE_VERSION,
  assertAgentRoute,
  assertResolvedRoute,
  assertRuntimeCapabilities,
  canonicalEndpointBase,
  coordinatorBriefEgressDestinationKey,
  createResolvedAgentRoute,
  serializeAgentRoute,
} from '../RouteContracts';
import {
  canCoordinateTeam,
  capabilityViolations,
  unsupportedModelParamKeys,
} from '../CapabilityGuard';
import { resolveOpenAICompatBaseUrl } from '../../backend/openAICompatBaseUrl';

const MODELS = ['claude-opus-4-8', 'gpt-5-codex', 'codex-cli-default', 'Claude/../gpt', 'ＡＡ'];

function envelope(connectionId: string, modelId = 'model-a') {
  const profile = connectionProfile(connectionId)!;
  const kind = profile.kind;
  const route = kind === 'claude-headless'
    ? { routeVersion: AGENT_ROUTE_VERSION, kind, connectionId: 'claude-cli' as const, modelId }
    : kind === 'codex-headless'
      ? { routeVersion: AGENT_ROUTE_VERSION, kind, connectionId: 'codex-cli' as const, modelId }
      : { routeVersion: AGENT_ROUTE_VERSION, kind, connectionId, modelId };
  return createResolvedAgentRoute({ route, profile, endpointBase: 'https://Api.Example.test:443/v1/', authIdentityRef: 'OPAQUE_KEY', toolProtocol: 'native' });
}

describe('E0 route contracts', () => {
  it('uses the registry display name for known provider ids and retains an unknown id for repair', () => {
    const resolver = customGatewayResolver({ displayName: 'Personal Gateway' });
    expect(displayNameForProviderId(CUSTOM_GATEWAY_ID, resolver)).toBe('Personal Gateway');
    expect(displayNameForProviderId('custom:tombstoned', resolver)).toBe('custom:tombstoned');
  });

  it('does not let a model spelling choose a connection, backend, or billing kind', () => {
    for (const profile of CONNECTION_PROFILES) {
      for (const model of MODELS) {
        const config: any = {
          provider: { providerId: profile.id === 'claude-cli' ? 'anthropic' : profile.id === 'codex-cli' ? 'codex' : profile.id },
          model,
          // Codex was introduced as an explicit legacy backend; omitting it is a malformed Codex
          // record, not a license to infer a subscription route.
          backend: profile.backendKind,
        };
        const route = agentRouteFromLegacyConfig(config);
        const resolved = envelope(route.connectionId, route.modelId);
        expect(resolved.connectionId).toBe(profile.id);
        expect(resolved.backendKind).toBe(profile.backendKind);
        expect(resolved.billingKind).toBe(profile.billingKind);
      }
    }
  });

  it('canonicalizes only the pinned endpoint components, never a lossy path form', () => {
    expect(canonicalEndpointBase('HTTPS://API.Example.test:443/v1/')).toBe('https://api.example.test/v1');
    expect(canonicalEndpointBase('http://API.Example.test:80/v1')).toBe('http://api.example.test/v1');
    expect(canonicalEndpointBase('https://api.example.test:444/v1')).toBe('https://api.example.test:444/v1');
    expect(canonicalEndpointBase('https://api.example.test/v1/%2e')).not.toBe(canonicalEndpointBase('https://api.example.test/v1/.'));
    expect(canonicalEndpointBase('https://api.example.test/V1')).not.toBe(canonicalEndpointBase('https://api.example.test/v1'));
  });

  it('compares coordinator brief destinations by privacy domain, with exact execution fallback only for unresolved manual routes', () => {
    const selected = envelope('roam', 'model-a');
    const sameKnownPrivacy = createResolvedAgentRoute({
      route: selected.route,
      profile: connectionProfile('roam')!,
      endpointBase: 'https://other.example.test/v1',
      authIdentityRef: 'OPAQUE_KEY',
      privacyDomain: { id: 'shared-retention-domain', status: 'known' },
    });
    const sameKnownPrivacyElsewhere = createResolvedAgentRoute({
      route: selected.route,
      profile: connectionProfile('roam')!,
      endpointBase: 'https://third.example.test/v1',
      authIdentityRef: 'OPAQUE_KEY',
      privacyDomain: { id: 'shared-retention-domain', status: 'known' },
    });
    const unresolvedSameEndpointOtherModel = createResolvedAgentRoute({
      route: { ...selected.route, modelId: 'model-b' },
      profile: connectionProfile('roam')!,
      endpointBase: 'https://manual.example.test/v1',
      authIdentityRef: 'OPAQUE_KEY',
    });
    const unresolvedSameEndpoint = createResolvedAgentRoute({
      route: { ...selected.route, modelId: 'model-c' },
      profile: connectionProfile('roam')!,
      endpointBase: 'https://manual.example.test/v1',
      authIdentityRef: 'OPAQUE_KEY',
    });
    const unresolvedOtherEndpoint = createResolvedAgentRoute({
      route: { ...selected.route, modelId: 'model-c' },
      profile: connectionProfile('roam')!,
      endpointBase: 'https://different-manual.example.test/v1',
      authIdentityRef: 'OPAQUE_KEY',
    });

    expect(coordinatorBriefEgressDestinationKey(sameKnownPrivacy))
      .toBe(coordinatorBriefEgressDestinationKey(sameKnownPrivacyElsewhere));
    expect(coordinatorBriefEgressDestinationKey(unresolvedSameEndpointOtherModel))
      .toBe(coordinatorBriefEgressDestinationKey(unresolvedSameEndpoint));
    expect(coordinatorBriefEgressDestinationKey(unresolvedSameEndpoint))
      .not.toBe(coordinatorBriefEgressDestinationKey(unresolvedOtherEndpoint));
  });

  it('rejects a mismatched resolved envelope before an egress caller can use it', () => {
    const selected = envelope('roam', 'claude-opus-4-8');
    const differentEndpoint = createResolvedAgentRoute({
      route: selected.route,
      profile: connectionProfile('roam')!,
      endpointBase: 'https://other.example.test/v1',
      authIdentityRef: 'OPAQUE_KEY',
      toolProtocol: 'native',
    });
    const sameHostDifferentBasePath = createResolvedAgentRoute({
      route: selected.route,
      profile: connectionProfile('roam')!,
      endpointBase: 'https://api.example.test/v2',
      authIdentityRef: 'OPAQUE_KEY',
      toolProtocol: 'native',
    });
    const differentAuth = createResolvedAgentRoute({
      route: selected.route,
      profile: connectionProfile('roam')!,
      endpointBase: 'https://api.example.test/v1',
      authIdentityRef: 'OTHER_OPAQUE_KEY',
      toolProtocol: 'native',
    });
    const differentModel = envelope('roam', 'gpt-5-codex');
    expect(() => assertResolvedRoute(selected, selected)).not.toThrow();
    expect(() => assertResolvedRoute(selected, differentEndpoint)).toThrow(/endpoint base/);
    expect(() => assertResolvedRoute(selected, sameHostDifferentBasePath)).toThrow(/endpoint base/);
    expect(() => assertResolvedRoute(selected, differentAuth)).toThrow(/auth identity/);
    expect(() => assertResolvedRoute(selected, differentModel)).toThrow(/model/);
  });

  it('pins a registered route to its profile endpoint instead of a runtime config endpoint', () => {
    const route = { routeVersion: AGENT_ROUTE_VERSION, kind: 'openai-compatible' as const, connectionId: 'roam', modelId: 'model-a' };
    const selected = createResolvedAgentRoute({
      route,
      profile: connectionProfile('roam')!,
      endpointBase: resolveOpenAICompatBaseUrl(route),
      authIdentityRef: 'ROAM_API_KEY',
    });
    const forgedRuntimeEnvelope = createResolvedAgentRoute({
      route,
      profile: connectionProfile('roam')!,
      endpointBase: 'https://attacker.test/v1',
      authIdentityRef: 'ROAM_API_KEY',
    });
    expect(selected.executionDomain.canonicalEndpointBase).toBe('https://ai.weroam.xyz/v1');
    expect(() => assertResolvedRoute(selected, forgedRuntimeEnvelope)).toThrow(/endpoint base/);
  });

  it('derives the credential identity from the registered connection and rejects a forged config key', () => {
    const resolver = customGatewayResolver();
    const custom = {
      routeVersion: AGENT_ROUTE_VERSION,
      kind: 'openai-compatible' as const,
      connectionId: CUSTOM_GATEWAY_ID,
      modelId: 'model-a',
    };
    const roam = { ...custom, connectionId: 'roam' as const };
    expect(authIdentityRefForRoute(custom, resolver)).toBe(CUSTOM_GATEWAY_SECRET_REF);
    expect(apiKeySecretNameForRoute(roam)).toBe('ROAM_API_KEY');
    expect(() => assertAgentConfigApiKeyOwnership({
      provider: { providerId: CUSTOM_GATEWAY_ID, apiKeySecretName: 'ROAM_API_KEY' },
      model: 'model-a',
      backend: 'openai-compat',
      route: custom,
    }, resolver)).toThrow(`must use SecretStorage key "${CUSTOM_GATEWAY_SECRET_REF}"`);
  });

  it('rejects a stale custom runtime profile after endpoint or key identity changes', () => {
    const route = {
      routeVersion: AGENT_ROUTE_VERSION,
      kind: 'openai-compatible' as const,
      connectionId: CUSTOM_GATEWAY_ID,
      modelId: 'model-a',
    };
    const initial = customGatewayResolver();
    const captured = captureActiveConnectionProfile(route, initial);

    expect(() => assertActiveConnectionProfile(captured, route, initial)).not.toThrow();
    expect(() => assertActiveConnectionProfile(
      captured,
      route,
      customGatewayResolver({ endpoint: 'https://other-gateway.example/v1', revision: 2 }),
    )).toThrow(/changed or is unavailable/);
    expect(() => assertActiveConnectionProfile(
      captured,
      route,
      customGatewayResolver({ secretRef: 'custom-gateway:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:22222222222222222222222222222222', revision: 2 }),
    )).toThrow(/changed or is unavailable/);
  });

  it('does not treat a custom display-name change as a runtime identity change', () => {
    const route = {
      routeVersion: AGENT_ROUTE_VERSION,
      kind: 'openai-compatible' as const,
      connectionId: CUSTOM_GATEWAY_ID,
      modelId: 'model-a',
    };
    const captured = captureActiveConnectionProfile(route, customGatewayResolver({ displayName: 'Gateway One' }));
    expect(() => assertActiveConnectionProfile(
      captured,
      route,
      customGatewayResolver({ displayName: 'Gateway Renamed' }),
    )).not.toThrow();
  });

  it('keeps the host-side final boundary on registry-derived credential identities', () => {
    const extensionSource = fs.readFileSync(path.resolve(process.cwd(), 'src/extension.ts'), 'utf8');
    expect(extensionSource).toContain('authIdentityRef: authIdentityRefForRoute(selected, effectiveConnectionRegistry)');
    expect(extensionSource).toContain('authIdentityRef: authIdentityRefForRoute(runtimeRoute, effectiveConnectionRegistry)');
    expect(extensionSource).not.toContain('authIdentityRef: config.provider.apiKeySecretName');
  });

  it('binds both executable routes to the same public-web policy row', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    const extensionSource = fs.readFileSync(path.resolve(process.cwd(), 'src/extension.ts'), 'utf8');
    const gatewaySource = fs.readFileSync(path.resolve(process.cwd(), 'src/backend/WorkspaceTools.ts'), 'utf8');
    const claudeSource = fs.readFileSync(path.resolve(process.cwd(), 'src/backend/ClaudeHeadlessBackend.ts'), 'utf8');

    expect(pkg.contributes.configuration.properties['unode.webAccess']).toMatchObject({
      default: 'ask',
      enum: ['ask', 'allow', 'off'],
    });
    expect(extensionSource).toContain('new SessionWebAccessApprover(requestWebAccessApproval)');
    expect(extensionSource).toContain('webAccess,');
    expect(gatewaySource).toContain('resolveWebAccessPolicy(this.webAccess.policy(), true)');
    expect(claudeSource).toContain("'WebSearch'");
    expect(claudeSource).toContain("'WebFetch'");
    expect(claudeSource).toContain('resolveWebAccessPolicy(webAccess.policy(), this.hasReadCapability())');
  });

  it('makes credentials unrepresentable in serialized routes and rejects dynamic invalid capabilities', () => {
    const route = { routeVersion: AGENT_ROUTE_VERSION, kind: 'openai-compatible' as const, connectionId: 'roam', modelId: 'claude-opus-4-8' };
    expect(serializeAgentRoute(route)).toBe(JSON.stringify(route));
    expect(() => assertAgentRoute({ ...route, apiKey: 'secret' })).toThrow(/unsupported field/);
    expect(() => assertRuntimeCapabilities({
      ...CONNECTION_PROFILES[0].capabilities,
      command: true,
      commandApproval: 'none',
    } as any)).toThrow(/approval mechanism/);
  });

  // The CLI has no model-list command to ask (no `claude models`; an unknown --model exits 0), so a
  // pinned-only catalog silently rots — that is how claude-opus-5 came to be missing from the picker
  // while typing it by hand worked. The always-latest aliases are what keep it from happening again, so
  // losing them is a regression even though nothing would visibly break.
  it('offers Claude Headless the CLI family aliases, so the newest model needs no release', () => {
    const claude = connectionProfile('claude-cli');
    expect(claude?.catalogKind).toBe('claude-cli');
    const ids = (claude?.catalogModels ?? []).map((model) => model.id);
    for (const alias of ['opus', 'sonnet', 'haiku', 'fable']) {
      expect(ids).toContain(alias);
    }
    // Aliases lead: they are the answer that stays right, so they are what the picker suggests first.
    expect(ids.slice(0, 4)).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
    // Every alias must be spendable, or an aliased agent estimates at zero and reads as free.
    for (const alias of ['opus', 'sonnet', 'haiku', 'fable']) {
      expect(new ModelPricing().priceFor(alias)).toBeDefined();
    }
  });

  it('gives every connection a data-owned setup and truthful billing/privacy presentation', () => {
    for (const connection of CONNECTION_PROFILES) {
      expect(connection.presentation.displayName).not.toBe('');
      expect(connection.presentation.runtimeLabel).not.toBe('');
      expect(connection.presentation.billingLabel).not.toBe('');
      expect(connection.presentation.privacySummary).not.toBe('');
      expect(connection.presentation.setup.actionLabel).not.toBe('');
      if (connection.authKind === 'api-key') {
        expect(connection.presentation.setup.kind).toBe('api-key');
        expect(connection.apiKeySecretName).toMatch(/_API_KEY$/);
      } else {
        expect(connection.presentation.setup.kind).toBe('cli');
        expect(connection.presentation.setup.loginCommand).toBeTruthy();
        expect(connection.apiKeySecretName).toBeUndefined();
      }
    }
    expect(CONNECTION_SETUP_GROUPS.map((group) => group.kind)).toEqual([
      'openai-compatible', 'claude-headless', 'codex-headless',
    ]);
    for (const group of CONNECTION_SETUP_GROUPS) {
      expect(CONNECTION_PROFILES.some((connection) => connection.kind === group.kind)).toBe(true);
    }
    for (const id of ['roam', 'unode', 'openrouter', 'openai']) {
      expect(connectionProfile(id)?.presentation.endpointDefault).toMatch(/^https:\/\//);
    }
    expect(connectionProfile('custom')).toBeUndefined();
  });

  it('does not statically enumerate default connections because custom ids are machine-local', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    const setting = pkg.contributes.configuration.properties['unode.defaultProvider'];
    expect(setting.default).toBe('unode');
    expect(setting.enum).toBeUndefined();
    expect(manifestDefaultConnectionIds()).toContain('unode');
  });

  it.each(['google', 'ollama', 'unknown-provider'])('repairs an unsupported persisted default %s to Unode', (configured) => {
    expect(resolveAvailableDefaultProviderId(configured)).toEqual({
      providerId: 'unode',
      repairMessage: `unsupported default connection "${configured}".`,
    });
  });

  it('does not silently keep a Coming soon connection as the new-agent default', () => {
    expect(resolveAvailableDefaultProviderId('codex')).toEqual({
      providerId: 'unode',
      repairMessage: 'Codex Headless is coming soon and is not available in this release.',
    });
  });

  it('keeps the retired singleton custom default as an explicit repair instead of falling back', () => {
    expect(resolveAvailableDefaultProviderId('custom')).toEqual({
      providerId: 'custom',
      repairMessage: 'legacy Custom default requires migration and an explicit named gateway selection.',
    });
  });

  it('derives every host-side capability rejection from the same profile row used for presentation', () => {
    for (const profile of CONNECTION_PROFILES) {
      const providerId = profile.id === 'claude-cli' ? 'anthropic' : profile.id === 'codex-cli' ? 'codex' : profile.id;
      const violations = capabilityViolations({
        provider: { providerId },
        backend: profile.backendKind,
        role: 'pm',
        allowedTools: ['read', 'search', 'write', 'execute', 'delegate'],
        mcpServers: ['fixture'],
        skills: [{}],
        playbooks: ['fixture'],
        folderAccess: [{ path: 'src', permission: 'read' }],
        toolProtocol: 'native',
        tier: 'standard',
      } as any);
      const names = violations.map((violation) => violation.capability);
      expect(names.includes('write')).toBe(!profile.capabilities.write);
      expect(names.includes('command')).toBe(!profile.capabilities.command);
      expect(names.includes('delegation')).toBe(!profile.capabilities.delegation);
      expect(names.includes('coordinator')).toBe(!profile.capabilities.coordinator);
      expect(names.includes('mcp')).toBe(!profile.capabilities.mcp);
      expect(names.includes('skills')).toBe(!profile.capabilities.skills);
      expect(names.includes('folderAccess')).toBe(!profile.capabilities.folderAccess);
      // tier (Smart Mode) and toolProtocol are inapplicable preferences, not blocking capabilities — a route
      // that doesn't use them ignores them; they must NEVER appear as violations (regression: a Claude
      // Headless PM with a Smart Mode tier was hard-rejected and stuck in STARTING).
      expect(names.includes('toolProtocol')).toBe(false);
      expect(names.includes('smartMode')).toBe(false);
      expect(names.includes('availability')).toBe(profile.availability !== 'available');
      expect(canCoordinateTeam(providerId)).toBe(profile.capabilities.coordinator);
    }
  });

  it('does not reject a Claude Headless PM that carries a Smart Mode tier or tool protocol (they are ignored)', () => {
    // Regression: a Claude Headless PM built by a Smart-Mode team carried `tier`, and the capability guard
    // hard-rejected it ("does not use UnodeAi Smart Mode tiers on this route"), leaving it stuck in STARTING.
    // A tier/toolProtocol on a route that doesn't use them is an inapplicable preference, not a violation.
    const violations = capabilityViolations({
      provider: { providerId: 'anthropic' }, // claude-cli connection (Claude Headless)
      backend: 'claude',
      role: 'pm',
      tier: 'standard',
      toolProtocol: 'native',
    } as any);
    const names = violations.map((v) => v.capability);
    expect(names).not.toContain('smartMode');
    expect(names).not.toContain('toolProtocol');
    expect(violations).toEqual([]); // a plain Claude Headless PM with only these preferences starts cleanly
  });

  it('retains the legacy Codex route for migration but rejects it before any backend can be constructed', () => {
    const codex = connectionProfile('codex-cli')!;
    expect(codex.availability).toBe('coming-soon');
    expect(manifestDefaultConnectionIds()).not.toContain('codex-cli');
    expect(capabilityViolations({
      provider: { providerId: 'codex' }, backend: 'codex', role: 'reviewer', allowedTools: ['read'],
    } as any)).toContainEqual(expect.objectContaining({
      capability: 'availability',
      message: expect.stringContaining('coming soon'),
    }));
  });

  it('keeps unsupported saved model parameters visible to persistence but excludes them at the request boundary', () => {
    const codex = connectionProfile('codex-cli')!;
    expect(unsupportedModelParamKeys(codex.capabilities, { temperature: 0.4, reasoning_effort: 'high' }))
      .toEqual(['temperature']);
    expect(unsupportedModelParamKeys(connectionProfile('roam')!.capabilities, { temperature: 0.4 }))
      .toEqual([]);
  });

  it('rejects an unknown hand-edited tool token instead of treating it as a future capability', () => {
    expect(capabilityViolations({
      provider: { providerId: 'codex' }, backend: 'codex', role: 'reviewer', allowedTools: ['read', 'shell-everything'],
    } as any)).toContainEqual(expect.objectContaining({ capability: 'tool', message: expect.stringContaining('shell-everything') }));
  });
});
