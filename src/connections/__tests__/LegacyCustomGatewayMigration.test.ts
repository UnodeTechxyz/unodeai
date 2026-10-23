import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../../types';
import {
  LEGACY_CUSTOM_SECRET_NAME,
  applyLegacyCustomGatewayMigration,
  hasOnlyTerminalLegacyCustomRepairs,
  isLegacySingletonCustomAgent,
  isModelLessLegacyCustomAgent,
  legacyCustomSecretName,
  pendingLegacyCustomMigrationAgents,
  planLegacyCustomGatewayMigration,
} from '../LegacyCustomGatewayMigration';
import { legacyMigrationRosterSignature } from '../LegacyMigrationRosterSignature';

function legacyAgent(id: string, baseUrl?: string, secretName = LEGACY_CUSTOM_SECRET_NAME): AgentConfig {
  return {
    id,
    name: id,
    role: 'custom',
    skill: 'read',
    provider: { providerId: 'custom', apiKeySecretName: secretName },
    model: 'shared-model',
    backend: 'openai-compat',
    ...(baseUrl === undefined ? {} : { baseUrl }),
    systemPrompt: 'test',
    autoApprove: false,
    allowedTools: ['read'],
  };
}

function opaqueIds(...values: string[]): () => string {
  let index = 0;
  return () => values[index++]!;
}

describe('legacy singleton custom migration planner', () => {
  it('recognizes only the retired singleton as migration input', () => {
    expect(isLegacySingletonCustomAgent(legacyAgent('a'))).toBe(true);
    expect(isLegacySingletonCustomAgent({ ...legacyAgent('a'), provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' } })).toBe(false);
    expect(isLegacySingletonCustomAgent({ ...legacyAgent('a'), provider: { providerId: 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', apiKeySecretName: '' } })).toBe(false);
  });

  it('does not throw on a corrupted non-string providerId from workspaceState (C3b class, follow-up)', () => {
    // `?.` guards null/undefined, not type. A numeric providerId in corrupt workspaceState must not reach
    // String#trim in this predicate — it runs throughout activation (filters, decline signature, planner)
    // before the apiKeySecretName guard, so a throw here aborts activation just like the C3b secret case.
    const numericProvider = { ...legacyAgent('bad'), provider: { providerId: 42 as unknown as string, apiKeySecretName: LEGACY_CUSTOM_SECRET_NAME } };
    expect(() => isLegacySingletonCustomAgent(numericProvider)).not.toThrow();
    expect(isLegacySingletonCustomAgent(numericProvider)).toBe(false); // not matched via the provider path
    // Still recognized as a legacy singleton when the RETIRED route carries connectionId 'custom' — via the route.
    const numericProviderLegacyRoute = { ...numericProvider, route: { kind: 'openai-compatible', connectionId: 'custom', modelId: 'x' } as unknown as AgentConfig['route'] };
    expect(isLegacySingletonCustomAgent(numericProviderLegacyRoute)).toBe(true);
    // The planner (called on activation) filters via this predicate — it must not crash on the corrupt member.
    expect(() => planLegacyCustomGatewayMigration({
      trusted: true,
      agents: [numericProviderLegacyRoute],
      nextOpaqueId: opaqueIds('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    })).not.toThrow();
  });

  it('does not create profiles or read credentials for an untrusted workspace', () => {
    const plan = planLegacyCustomGatewayMigration({
      trusted: false,
      agents: [legacyAgent('a', 'https://gateway.example/v1')],
      nextOpaqueId: () => { throw new Error('must not allocate ids while untrusted'); },
    });
    expect(plan.entries).toEqual([]);
    expect(plan.repairs).toEqual([{ agentId: 'a', reason: expect.stringMatching(/untrusted/) }]);
  });

  it('uses a per-agent endpoint before the old global endpoint and keeps credential identities separate', () => {
    const plan = planLegacyCustomGatewayMigration({
      trusted: true,
      agents: [
        legacyAgent('agent-a', 'https://per-agent.example/v1/'),
        legacyAgent('agent-b'),
        legacyAgent('agent-c', 'https://per-agent.example/v1', 'SECOND_LEGACY_KEY'),
      ],
      legacyGlobalEndpoint: 'https://global.example/v1',
      legacySecretNamesWithValues: new Set([LEGACY_CUSTOM_SECRET_NAME, 'SECOND_LEGACY_KEY']),
      nextOpaqueId: opaqueIds(
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111111111111111111111111111',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '22222222222222222222222222222222',
        'cccccccccccccccccccccccccccccccc', '33333333333333333333333333333333',
      ),
    });
    expect(plan.entries).toHaveLength(3);
    expect(plan.entries.map((entry) => [entry.endpointBase, entry.legacySecretName, entry.agentIds])).toEqual([
      ['https://per-agent.example/v1', LEGACY_CUSTOM_SECRET_NAME, ['agent-a']],
      ['https://global.example/v1', LEGACY_CUSTOM_SECRET_NAME, ['agent-b']],
      ['https://per-agent.example/v1', 'SECOND_LEGACY_KEY', ['agent-c']],
    ]);
    expect(plan.entries.map((entry) => entry.connectionId)).toEqual([
      'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'custom:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'custom:cccccccccccccccccccccccccccccccc',
    ]);
  });

  it('groups only same endpoint plus same legacy credential identity and preserves exact models', () => {
    const agents = [legacyAgent('a', 'https://gateway.example/v1'), legacyAgent('b', 'https://gateway.example/v1')];
    agents[1].model = 'different-model';
    const plan = planLegacyCustomGatewayMigration({
      trusted: true,
      agents,
      legacySecretNamesWithValues: new Set([LEGACY_CUSTOM_SECRET_NAME]),
      nextOpaqueId: opaqueIds('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111111111111111111111111111'),
    });
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].agentIds).toEqual(['a', 'b']);
    const migrated = applyLegacyCustomGatewayMigration(agents, plan);
    expect(migrated.map((agent) => agent.route?.connectionId)).toEqual([
      'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ]);
    expect(migrated.map((agent) => agent.route?.modelId)).toEqual(['shared-model', 'different-model']);
    expect(migrated.every((agent) => agent.baseUrl === undefined)).toBe(true);
  });

  it('converges a declined v0.9.30 route when migration is run later without creating another gateway entry', () => {
    const legacy = {
      ...legacyAgent('a', 'https://gateway.example/v1'),
      route: { routeVersion: 1, kind: 'openai-compatible' as const, connectionId: 'custom', modelId: 'shared-model' },
    };
    const plan = planLegacyCustomGatewayMigration({
      trusted: true,
      agents: [legacy],
      nextOpaqueId: opaqueIds('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111111111111111111111111111'),
    });
    const migrated = applyLegacyCustomGatewayMigration([legacy], plan);
    const retryPlan = planLegacyCustomGatewayMigration({
      trusted: true,
      agents: migrated,
      nextOpaqueId: () => { throw new Error('already-migrated agents must not allocate another gateway'); },
    });

    expect(plan.entries).toHaveLength(1);
    expect(retryPlan.entries).toEqual([]);
    expect(applyLegacyCustomGatewayMigration(migrated, plan)).toEqual(migrated);
  });

  it('treats the team-file-stripped endpoint of a 0.9.0 built-in as equal while preserving legacy custom endpoint differences', () => {
    const unodeWorkspaceAgent: AgentConfig = {
      ...legacyAgent('unode-agent'),
      provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' },
      route: { routeVersion: 1, kind: 'openai-compatible', connectionId: 'unode', modelId: 'shared-model' },
      baseUrl: 'https://www.unodetech.xyz/v1',
    };
    const unodeTeamAgent = { ...unodeWorkspaceAgent, baseUrl: undefined };
    const legacyWorkspaceAgent = legacyAgent('legacy-agent', 'https://gateway.example/v1');
    const legacyTeamAgent = {
      ...legacyWorkspaceAgent,
      provider: { providerId: 'custom', apiKeySecretName: '' },
    };

    expect(legacyMigrationRosterSignature([unodeWorkspaceAgent, legacyWorkspaceAgent]))
      .toBe(legacyMigrationRosterSignature([unodeTeamAgent, legacyTeamAgent]));
    expect(legacyMigrationRosterSignature([unodeWorkspaceAgent, legacyWorkspaceAgent]))
      .not.toBe(legacyMigrationRosterSignature([
        unodeTeamAgent,
        { ...legacyTeamAgent, baseUrl: 'https://different-gateway.example/v1' },
      ]));
    expect(legacyMigrationRosterSignature([unodeWorkspaceAgent, legacyWorkspaceAgent]))
      .not.toBe(legacyMigrationRosterSignature([legacyTeamAgent]));
  });

  it('creates visible repair records for invalid endpoints without guessing a built-in route', () => {
    const plan = planLegacyCustomGatewayMigration({
      trusted: true,
      agents: [legacyAgent('bad', 'http://attacker.example/v1')],
      nextOpaqueId: opaqueIds('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    });
    expect(plan.entries).toEqual([]);
    expect(plan.repairs[0]).toMatchObject({ agentId: 'bad', connectionId: 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const migrated = applyLegacyCustomGatewayMigration([legacyAgent('bad', 'http://attacker.example/v1')], plan);
    expect(migrated[0].route).toMatchObject({ connectionId: 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(migrated[0].routeRepair).toMatch(/no valid HTTPS endpoint/);
  });

  it('contains a malformed workspace-state secret reference as a visible repair instead of trimming and aborting activation', () => {
    const corrupt = legacyAgent('bad-secret', 'https://gateway.example/v1');
    (corrupt.provider as { apiKeySecretName?: unknown }).apiKeySecretName = 42;

    // This is the pre-plan value extension.ts must inspect on activation. It is always safe to look up.
    expect(legacyCustomSecretName(corrupt)).toBe(LEGACY_CUSTOM_SECRET_NAME);
    const plan = planLegacyCustomGatewayMigration({
      trusted: true,
      agents: [corrupt],
      nextOpaqueId: opaqueIds('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    });

    expect(plan.entries).toEqual([]);
    expect(plan.repairs).toEqual([expect.objectContaining({
      agentId: 'bad-secret',
      connectionId: 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      reason: expect.stringContaining('invalid credential reference'),
    })]);
    const repaired = applyLegacyCustomGatewayMigration([corrupt], plan);
    expect(repaired[0]?.routeRepair).toContain('invalid credential reference');
  });

  it('classifies model-less legacy members as terminal repairs so a completed migration does not loop', () => {
    const modelLess = legacyAgent('needs-model', 'https://gateway.example/v1');
    modelLess.model = '';
    const plan = planLegacyCustomGatewayMigration({
      trusted: true,
      agents: [modelLess],
      nextOpaqueId: opaqueIds('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    });
    const migrated = applyLegacyCustomGatewayMigration([modelLess], plan);

    expect(plan.entries).toEqual([]);
    expect(plan.repairs).toMatchObject([{ agentId: 'needs-model' }]);
    expect(isModelLessLegacyCustomAgent(migrated[0])).toBe(true);
    expect(hasOnlyTerminalLegacyCustomRepairs(migrated, new Set(['needs-model']))).toBe(true);
    expect(hasOnlyTerminalLegacyCustomRepairs(migrated, new Set<string>())).toBe(false);
    expect(pendingLegacyCustomMigrationAgents(migrated, new Set(['needs-model']))).toEqual([]);
    migrated[0].model = 'selected-model';
    expect(pendingLegacyCustomMigrationAgents(migrated, new Set(['needs-model']))).toEqual(migrated);
  });

  it('creates a keyless profile plan when the legacy key is absent', () => {
    const plan = planLegacyCustomGatewayMigration({
      trusted: true,
      agents: [legacyAgent('a', 'https://gateway.example/v1')],
      nextOpaqueId: opaqueIds('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    });
    expect(plan.entries[0].secretRef).toBeUndefined();
    const migrated = applyLegacyCustomGatewayMigration([legacyAgent('a', 'https://gateway.example/v1')], plan);
    expect(migrated[0].provider.apiKeySecretName).toBe('');
    expect(migrated[0].routeRepair).toMatch(/without an API key/);
  });
});
