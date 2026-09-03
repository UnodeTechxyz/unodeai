import { describe, it, expect } from 'vitest';
import { validateTeamFile } from '../TeamFileSchema';
import { CUSTOM_GATEWAY_ID, CUSTOM_GATEWAY_SECRET_REF, customGatewayResolver } from '../../routes/__tests__/customGatewayFixture';
import { LEGACY_CUSTOM_MISSING_MODEL_REPAIR } from '../../connections/LegacyCustomGatewayMigration';

const member = {
  id: 'pm',
  name: 'PM',
  role: 'pm',
  skill: 'project-management',
  provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
  model: 'deepseek-v4-flash',
  systemPrompt: 'Coordinate the team.',
  autoApprove: false,
  allowedTools: ['read', 'delegate'],
};

describe('validateTeamFile', () => {
  it('accepts members and MCP servers', () => {
    const doc = validateTeamFile({
      version: '1.0',
      members: [member],
      mcpServers: [{ id: 'github', name: 'GitHub', transport: 'stdio', command: 'npx', args: ['-y', 'x'] }],
    });

    expect(doc.members[0].id).toBe('pm');
    expect(doc.mcpServers[0].id).toBe('github');
  });

  it('keeps legacy delegate-granting workers loadable while stripping their dispatch authority', () => {
    const doc = validateTeamFile({
      members: [
        member,
        { ...member, id: 'dev', name: 'Developer', role: 'senior-dev', allowedTools: ['read', 'delegate'] },
      ],
    });

    expect(doc.members).toHaveLength(2);
    expect(doc.members[1].allowedTools).toEqual(['read']);
    expect(doc.validationWarnings?.join(' ')).toMatch(/Developer.*dropped retired delegate capability/i);
  });

  it('keeps an additional PM as a member but designates only the first PM as coordinator', () => {
    const doc = validateTeamFile({
      members: [
        member,
        { ...member, id: 'pm-2', name: 'Second PM', allowedTools: ['read', 'delegate'] },
      ],
    });

    expect(doc.members).toHaveLength(2);
    expect(doc.members[0].allowedTools).toContain('delegate');
    expect(doc.members[1].allowedTools).not.toContain('delegate');
    expect(doc.validationWarnings?.join(' ')).toMatch(/Second PM.*additional PM.*coordinator is "pm"/i);
  });

  // A pre-0.9.70 editor saved conditional branches as { goto } with no condition, meaning "always".
  // v0.9.70 made `label` required, and a rejected branch fails the WHOLE team file -- members included.
  describe('pre-0.9.70 workflow branches', () => {
    const legacyTeam = (branch: Record<string, unknown>) => ({
      version: '1.0',
      members: [member],
      workflows: [{
        id: 'review',
        name: 'Review',
        steps: [
          { id: 'code', from: 'pm', to: 'dev', action: 'Write it', branches: [branch] },
          { id: 'done', from: 'dev', to: 'pm', action: 'Ship it' },
        ],
      }],
    });
    const warnings = (doc: { validationWarnings?: readonly string[] }) =>
      (doc.validationWarnings ?? []).join(' ~ ');

    it('loads a team file whose branch has no condition, and keeps its members', () => {
      const doc = validateTeamFile(legacyTeam({ goto: 'done' }));

      expect(doc.members).toHaveLength(1);
      expect(doc.members[0].id).toBe('pm');
      const branch = doc.workflows[0].steps[0].branches![0];
      expect(branch.fallback).toBe(true);
      expect(branch.goto).toBe('done');
    });

    it('warns that the unconditional branch became a fallback', () => {
      expect(warnings(validateTeamFile(legacyTeam({ goto: 'done' })))).toMatch(/had no branch condition/i);
    });

    it('normalizes a legacy substring into an exact label and drops the old field', () => {
      const doc = validateTeamFile(legacyTeam({ whenResultContains: 'approved', goto: 'done' }));
      const branch = doc.workflows[0].steps[0].branches![0] as Record<string, unknown>;

      expect(branch.label).toBe('approved');
      expect(branch.fallback).toBeUndefined();
      expect(branch.whenResultContains).toBeUndefined();
      expect(warnings(doc)).toMatch(/migrated whenResultContains/i);
    });

    it('round-trips a migrated file without drifting on reload', () => {
      const once = validateTeamFile(legacyTeam({ goto: 'done' }));
      const twice = validateTeamFile(JSON.parse(JSON.stringify({ ...once, members: [member] })));

      expect(twice.workflows[0].steps[0].branches).toEqual(once.workflows[0].steps[0].branches);
      // Already migrated, so the second load has nothing left to report.
      expect(warnings(twice)).not.toMatch(/had no branch condition/i);
    });

    it('still rejects an explicitly empty new-format label and genuinely corrupt data', () => {
      expect(() => validateTeamFile(legacyTeam({ label: '', goto: 'done' })))
        .toThrow(/label must be a non-empty string/);
      expect(() => validateTeamFile(legacyTeam({ whenResultContains: 7, goto: 'done' })))
        .toThrow(/whenResultContains must be a string/);
      expect(() => validateTeamFile(legacyTeam({ label: 'pass' })))
        .toThrow(/goto must be a non-empty string/);
    });
  });

  it('reports field-level errors instead of accepting malformed config', () => {
    expect(() =>
      validateTeamFile({
        members: [{ ...member, provider: 'bad' }],
        mcpServers: [{ id: 'remote', name: 'Remote', transport: 'streamable-http' }],
      })
    ).toThrow(/provider must be an object.*url is required/s);
  });

  it('supports legacy agents array', () => {
    expect(validateTeamFile({ agents: [member] }).members).toHaveLength(1);
  });

  it('accepts the user opt-out for Claude native subagents', () => {
    const doc = validateTeamFile({
      members: [{ ...member, disableNativeSubagents: true }],
    });

    expect(doc.members[0].disableNativeSubagents).toBe(true);
  });

  it('accepts a measured context window only when its model, count, and advertised field are valid', () => {
    const doc = validateTeamFile({
      members: [{ ...member, measuredContextWindow: { model: 'deepseek-v4-flash', tokens: 128_000, field: 'context_length' } }],
    });
    expect(doc.members[0].measuredContextWindow).toEqual({ model: 'deepseek-v4-flash', tokens: 128_000, field: 'context_length' });
    expect(() => validateTeamFile({
      members: [{ ...member, measuredContextWindow: { model: '', tokens: 0, field: 'made_up' } }],
    })).toThrow(/measuredContextWindow\.model.*measuredContextWindow\.tokens.*measuredContextWindow\.field/s);
  });

  // A ceiling proved by a refusal has to survive a reload, or the agent re-learns it by failing again.
  it('accepts a context ceiling a provider proved, with the provenance that makes it auditable', () => {
    const bound = { model: 'deepseek-v4-flash', tokens: 96_000, observedAt: '2026-08-10T00:00:00.000Z' };
    const doc = validateTeamFile({ members: [{ ...member, observedContextWindow: bound }] });
    expect(doc.members[0].observedContextWindow).toEqual(bound);
    expect(() => validateTeamFile({
      members: [{ ...member, observedContextWindow: { model: '', tokens: -1, observedAt: 'whenever' } }],
    })).toThrow(/observedContextWindow\.model.*observedContextWindow\.tokens.*observedContextWindow\.observedAt/s);
  });

  it('accepts a Codex backend agent in a versionable team file', () => {
    const doc = validateTeamFile({
      members: [{
        ...member,
        id: 'codex-reviewer',
        provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' },
        backend: 'codex',
      }],
    });

    expect(doc.members[0].backend).toBe('codex');
  });

  it('strips a forged endpoint from a registered connection and makes the correction visible', () => {
    const doc = validateTeamFile({
      members: [{ ...member, baseUrl: 'https://attacker.test/v1' }],
    });

    expect(doc.members[0].baseUrl).toBeUndefined();
    expect(doc.validationWarnings).toEqual([
      'members[0].baseUrl was ignored: endpoints are owned by the local connection registry.',
    ]);
  });

  it('strips a custom route endpoint and hydrates its profile-owned credential identity', () => {
    const resolver = customGatewayResolver();
    const { provider: _provider, model: _model, backend: _backend, ...routeOnlyMember } = member;
    const doc = validateTeamFile({
      members: [{
        ...routeOnlyMember,
        route: { routeVersion: 1, kind: 'openai-compatible', connectionId: CUSTOM_GATEWAY_ID, modelId: 'gateway-model' },
        baseUrl: 'https://gateway.example/v1/',
      }],
    }, resolver);
    expect(doc.members[0].baseUrl).toBeUndefined();
    expect(doc.members[0].provider).toEqual({ providerId: CUSTOM_GATEWAY_ID, apiKeySecretName: CUSTOM_GATEWAY_SECRET_REF });
    expect(doc.validationWarnings).toContain('members[0].baseUrl was ignored: endpoints are owned by the local connection registry.');
  });

  it('rejects a custom route paired with another gateway key before the roster can run', () => {
    const resolver = customGatewayResolver();
    expect(() => validateTeamFile({
      members: [{
        ...member,
        provider: { providerId: CUSTOM_GATEWAY_ID, apiKeySecretName: 'ROAM_API_KEY' },
        route: { routeVersion: 1, kind: 'openai-compatible', connectionId: CUSTOM_GATEWAY_ID, modelId: 'gateway-model' },
      }],
    }, resolver)).toThrow(`apiKeySecretName must be "${CUSTOM_GATEWAY_SECRET_REF}" for connection "${CUSTOM_GATEWAY_ID}"`);
  });

  it('keeps an unavailable opaque custom route visible as a repair item', () => {
    const doc = validateTeamFile({
      members: [{
        ...member,
        route: { routeVersion: 1, kind: 'openai-compatible', connectionId: CUSTOM_GATEWAY_ID, modelId: 'gateway-model' },
      }],
    });

    expect(doc.members[0].routeRepair).toMatch(/unavailable on this machine/);
    expect(doc.members[0].provider).toEqual({ providerId: CUSTOM_GATEWAY_ID, apiKeySecretName: '' });
  });

  it('keeps a legacy singleton custom route visible as a migration repair item', () => {
    const doc = validateTeamFile({
      members: [{
        ...member,
        provider: { providerId: 'custom', apiKeySecretName: 'CUSTOM_API_KEY' },
        route: { routeVersion: 1, kind: 'openai-compatible', connectionId: 'custom', modelId: 'legacy-model' },
        baseUrl: 'https://legacy.example/v1',
      }],
    });
    expect(doc.members[0].routeRepair).toMatch(/Legacy Custom gateway migration is required/);
    expect(doc.members[0].baseUrl).toBeUndefined();
  });

  it('turns a malformed legacy route model id into a visible repair instead of passing it to migration', () => {
    const doc = validateTeamFile({
      members: [{
        ...member,
        provider: { providerId: 'custom', apiKeySecretName: 'CUSTOM_API_KEY' },
        route: { routeVersion: 1, kind: 'openai-compatible', connectionId: 'custom', modelId: 42 },
        baseUrl: 'https://legacy.example/v1',
      }],
    });

    expect(doc.members[0].route).toBeUndefined();
    expect(doc.members[0].routeRepair).toMatch(/route is malformed/);
    expect(doc.validationWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining('members[0].route needs repair'),
    ]));
  });

  it('rehydrates a persisted model-less legacy repair without a route or credential identity', () => {
    const doc = validateTeamFile({
      members: [{
        id: 'needs-model',
        name: 'Needs model',
        role: 'custom',
        skill: 'read',
        systemPrompt: 'Repair this member.',
        autoApprove: false,
        allowedTools: ['read'],
        legacyCustomRepair: LEGACY_CUSTOM_MISSING_MODEL_REPAIR,
      }],
    });

    expect(doc.members[0]).toMatchObject({
      provider: { providerId: 'custom', apiKeySecretName: '' },
      model: '',
      backend: 'openai-compat',
    });
    expect(doc.members[0].route).toBeUndefined();
    expect(doc.members[0].routeRepair).toMatch(/no model id/);
  });

  /**
   * The property this has always been about is that an invented field never reaches runtime config. It used
   * to be enforced by rejecting the whole file as well, which is strictly harsher and was strictly worse in
   * practice: our own writer emitted two unsupported fields, so every team file it wrote failed to load and
   * the user was told they had no saved teams. Sanitising is the boundary. Dropping is reported so a reader
   * learns something was removed, rather than losing a roster to a field they never typed.
   */
  it('strips an unknown top-level agent field instead of spreading it into runtime config', () => {
    const doc = validateTeamFile({
      members: [{ ...member, endpointOverride: 'https://attacker.test/v1' }],
    });

    expect(doc.members[0]).not.toHaveProperty('endpointOverride');
    expect(JSON.stringify(doc.members[0])).not.toContain('attacker.test');
    expect(doc.validationWarnings?.join(' ')).toMatch(/dropped unsupported field.*endpointOverride/);
  });

  it('accepts a closed versioned route but rejects credentials hidden inside it', () => {
    const doc = validateTeamFile({
      members: [{
        ...member,
        route: { routeVersion: 1, kind: 'openai-compatible', connectionId: 'roam', modelId: 'claude-opus-4-8' },
      }],
    });
    expect(doc.members[0].route).toMatchObject({ connectionId: 'roam' });
    expect(() => validateTeamFile({
      members: [{
        ...member,
        route: { routeVersion: 1, kind: 'openai-compatible', connectionId: 'roam', modelId: 'claude-opus-4-8', apiKey: 'secret' },
      }],
    })).toThrow(/route is invalid.*unsupported field/);
    expect(() => validateTeamFile({
      members: [{
        ...member,
        route: { routeVersion: 1, kind: 'openai-compatible', connectionId: 'unregistered', modelId: 'model' },
      }],
    })).toThrow(/route is invalid.*unknown or incompatible connection/);
  });

  it('imports a route-only v1 member and rehydrates legacy fields only in memory', () => {
    const doc = validateTeamFile({
      members: [{
        id: 'route-only',
        name: 'Route only',
        role: 'reviewer',
        skill: 'read',
        systemPrompt: 'Review.',
        autoApprove: false,
        allowedTools: ['read'],
        route: { routeVersion: 1, kind: 'claude-headless', connectionId: 'claude-cli', modelId: 'claude-cli-default' },
      }],
    });

    expect(doc.members[0].provider).toEqual({ providerId: 'anthropic', apiKeySecretName: 'CLAUDE_CLI_AUTH' });
    expect(doc.members[0].model).toBe('claude-cli-default');
    expect(doc.members[0].backend).toBe('claude');
  });

  it('accepts prompt-template provenance and the one-level explicit-adopt undo record', () => {
    const doc = validateTeamFile({
      members: [{
        ...member,
        roleTemplateKey: 'pm',
        systemPromptSource: 'custom',
        systemPromptTemplateAtFork: 'Old role default.',
        systemPromptDismissedTemplateHash: 'abc123',
        systemPromptUndo: { prompt: 'My custom prompt.', templateAtFork: 'Old role default.' },
      }],
    });

    expect(doc.members[0].systemPromptSource).toBe('custom');
    expect(doc.members[0].roleTemplateKey).toBe('pm');
    expect(doc.members[0].systemPromptUndo?.prompt).toBe('My custom prompt.');
  });

  it('reports malformed native subagent opt-out values', () => {
    expect(() =>
      validateTeamFile({
        members: [{ ...member, disableNativeSubagents: 'yes' }],
      })
    ).toThrow(/disableNativeSubagents must be a boolean/);
  });

  it('accepts valid custom workflows', () => {
    const doc = validateTeamFile({
      members: [member],
      workflows: [{
        id: 'custom-flow',
        name: 'Custom Flow',
        description: 'A saved workflow',
        steps: [
          { id: 'plan', from: 'pm', to: 'architect', action: 'Plan', autoTransition: true },
          {
            id: 'review',
            from: 'architect',
            to: 'reviewer',
            action: 'Review',
            autoTransition: true,
            branches: [{ label: 'fail', goto: 'plan' }, { label: 'pass', goto: 'done' }],
          },
          { id: 'done', from: 'reviewer', to: 'tester', action: 'Done', autoTransition: true },
        ],
      }],
    });

    expect(doc.workflows[0].id).toBe('custom-flow');
    expect(doc.workflows[0].steps[1].branches?.[0].goto).toBe('plan');
  });

  it('reports malformed workflows and drops invalid entries', () => {
    expect(() =>
      validateTeamFile({
        members: [member],
        workflows: [
          { id: 'bad', name: 'Bad', steps: 'nope' },
          {
            id: 'also-bad',
            name: 'Also Bad',
            steps: [{ id: 's1', from: 'pm', to: '', action: 'x', autoTransition: 'yes' }],
          },
        ],
      })
    ).toThrow(/workflows\[0\]\.steps must be an array.*workflows\[1\]\.steps\[0\]\.to/s);
  });

  it('reports non-array workflows', () => {
    expect(() => validateTeamFile({ members: [member], workflows: {} })).toThrow(/workflows must be an array/);
  });
});
