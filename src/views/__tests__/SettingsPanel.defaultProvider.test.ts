import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  panel: undefined as any,
  onMessage: undefined as ((message: unknown) => Promise<void>) | undefined,
  onDispose: undefined as (() => void) | undefined,
}));

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  window: {
    createWebviewPanel: vi.fn(() => {
      let disposed = false;
      const webview = {
        cspSource: 'vscode-webview:',
        html: '',
        onDidReceiveMessage: (callback: (message: unknown) => Promise<void>) => {
          state.onMessage = callback;
          return { dispose: () => {} };
        },
        postMessage: vi.fn(),
      };
      const panel = {
        webview,
        onDidDispose: (callback: () => void) => {
          state.onDispose = callback;
          return { dispose: () => {} };
        },
        dispose: () => {
          if (disposed) { return; }
          disposed = true;
          state.onDispose?.();
        },
        reveal: vi.fn(),
      };
      state.panel = panel;
      return panel;
    }),
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showWarningMessage: vi.fn().mockResolvedValue('Delete'),
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

import { SettingsPanel } from '../SettingsPanel';

afterEach(() => {
  (SettingsPanel as any).current?.dispose();
  SettingsPanel.current = undefined;
  state.panel = undefined;
  state.onMessage = undefined;
  state.onDispose = undefined;
});

describe('SettingsPanel default provider', () => {
  it('renders every capability fact with its provenance and keeps session observations non-persistent', async () => {
    SettingsPanel.createOrShow({} as any, {
      bridge: { getSnapshot: async () => ({ providers: [], mcpServers: [] }) } as any,
      promptAndStoreSecret: async () => false,
      openTeamFile: () => {},
      listAgentTunings: () => [{
        id: 'a1', name: 'Developer', role: 'senior-dev', providerId: 'gateway-a', backend: 'openai-compat' as const, model: 'kimi-k2',
        capabilityProfile: {
          key: 'gateway-a::kimi-k2', connectionId: 'gateway-a', modelId: 'kimi-k2',
          protocol: {
            declared: { source: 'declared', value: { initial: 'native', fallbackAfterTextLeak: 'xml', knownNativeToolLeakRisk: true }, detail: 'Cold-start hint.' },
            observed: { source: 'observed', value: { initial: 'xml', fallbackAfterTextLeak: 'xml', knownNativeToolLeakRisk: true }, detail: 'Gateway leaked a tool call.', observedAt: '2026-08-05T00:00:00.000Z' },
            effective: { source: 'observed', value: { initial: 'xml', fallbackAfterTextLeak: 'xml', knownNativeToolLeakRisk: true }, detail: 'Gateway leaked a tool call.', observedAt: '2026-08-05T00:00:00.000Z' },
          },
          samplingParameters: { declared: { source: 'declared', value: 'accepted', detail: 'Declared.' }, effective: { source: 'declared', value: 'accepted', detail: 'Declared.' } },
          contextWindow: { declared: { source: 'declared', value: { compactionThreshold: 0.7, toolStopThreshold: 0.8 }, detail: 'Declared.' }, effective: { source: 'declared', value: { compactionThreshold: 0.7, toolStopThreshold: 0.8 }, detail: 'Declared.' } },
          recovery: { declared: { source: 'declared', value: { samplingParameter400: 'retry-without-sampling-parameters', textToolCall: 'latch-xml-for-session', requestShape: 'session-self-heal-ladder' }, detail: 'Declared.' }, effective: { source: 'declared', value: { samplingParameter400: 'retry-without-sampling-parameters', textToolCall: 'latch-xml-for-session', requestShape: 'session-self-heal-ladder' }, detail: 'Declared.' } },
        },
      }],
    });

    await vi.waitFor(() => expect(state.panel.webview.html).toContain('Capability profile — gateway-a × kimi-k2'));
    const html = state.panel.webview.html;
    expect(html).toContain('effective: observed');
    expect(html).toContain('2026-08-05T00:00:00.000Z');
    expect(html).toContain('Observations are not saved automatically.');
    expect(html).toContain('Sampling parameters');
    expect(html).toContain('Context window');
    expect(html).toContain('Recovery');
  });

  it('labels built-in key actions clearly without changing their commands or handlers', async () => {
    const promptAndStoreSecret = vi.fn(async () => true);
    const deleteApiKey = vi.fn(async () => {});
    const testConnection = vi.fn(async () => {});

    SettingsPanel.createOrShow({} as any, {
      bridge: {
        getSnapshot: async () => ({
          providers: [{
            providerId: 'unode',
            connectionId: 'unode',
            name: 'Unode',
            apiKeySecretName: 'UNODE_API_KEY',
            hasApiKey: true,
            canManageApiKey: true,
            authKind: 'api-key',
            catalogKind: 'openai-models',
            presentation: {
              runtimeLabel: 'OpenAI-compatible',
              billingLabel: 'Your Unode connection',
              privacySummary: 'Prompt data goes to Unode.',
              setup: { kind: 'api-key', actionLabel: 'Set API key' },
            },
          }],
          mcpServers: [],
        }),
        deleteApiKey,
      } as any,
      promptAndStoreSecret,
      openTeamFile: () => {},
      testConnection,
    });

    await vi.waitFor(() => expect(state.panel.webview.html).toContain('data-command="deleteKey"'));
    const html = state.panel.webview.html;
    const actionRow = html.match(/<div class="actions" style="margin-top:10px">([^]*?)<\/div>/)?.[1] ?? '';
    expect(Array.from(actionRow.matchAll(/data-command="([^"]+)"/g), (match) => match[1])).toEqual([
      'testConnection',
      'setKey',
      'deleteKey',
    ]);
    expect(html).toContain('data-command="setKey" data-secret-name="UNODE_API_KEY">Edit</button>');
    expect(html).toContain('data-command="deleteKey" data-secret-name="UNODE_API_KEY">Clear key</button>');
    expect(html).toContain('<button class="btn primary" data-command="testConnection" data-provider-id="unode">Test connection</button>');
    expect(html).not.toContain('data-secret-name="UNODE_API_KEY">Replace</button>');
    expect(html).not.toContain('data-secret-name="UNODE_API_KEY">Delete</button>');

    await state.onMessage?.({ command: 'setKey', secretName: 'UNODE_API_KEY' });
    await state.onMessage?.({ command: 'deleteKey', secretName: 'UNODE_API_KEY' });
    await state.onMessage?.({
      command: 'testConnection',
      providerId: 'unode',
      baseUrl: 'https://attacker.example/v1',
    } as any);
    await state.onMessage?.({ command: 'testConnection', providerId: 'forged' });
    expect(promptAndStoreSecret).toHaveBeenCalledWith('UNODE_API_KEY');
    expect(deleteApiKey).toHaveBeenCalledWith('UNODE_API_KEY');
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(testConnection).toHaveBeenCalledWith('unode');
  });

  it('renders Claude Headless as selectable and persists only rendered provider ids', async () => {
    let defaultProvider = 'unode';
    const setDefaultProvider = vi.fn(async (providerId: string) => { defaultProvider = providerId; });

    SettingsPanel.createOrShow({} as any, {
      bridge: {
        getSnapshot: async () => ({
          providers: [
            { providerId: 'unode', name: 'Unode', apiKeySecretName: 'UNODE_API_KEY', hasApiKey: true, authKind: 'api-key', presentation: { runtimeLabel: 'OpenAI-compatible', billingLabel: 'Your Unode connection', privacySummary: 'Prompt data goes to Unode.', setup: { kind: 'api-key', actionLabel: 'Set API key' } } },
            { providerId: 'anthropic', name: 'Claude Headless', hasApiKey: false, authKind: 'claude-cli', presentation: { runtimeLabel: 'Claude Headless', billingLabel: 'Your Claude account', setup: { kind: 'cli', actionLabel: 'Set up Claude Headless', installCommand: 'npm install -g @anthropic-ai/claude-code', loginCommand: 'claude login' } } },
          ],
          mcpServers: [],
        }),
      } as any,
      promptAndStoreSecret: async () => false,
      openTeamFile: () => {},
      getDefaultProvider: () => defaultProvider,
      setDefaultProvider,
    });

    await vi.waitFor(() => {
      expect(state.panel.webview.html).toContain('data-command="setDefaultProvider" data-provider-id="anthropic"');
    });

    await state.onMessage?.({ command: 'setDefaultProvider', providerId: 'anthropic' });
    expect(setDefaultProvider).toHaveBeenCalledWith('anthropic');
    expect(state.panel.webview.html).toContain('Default for new agents');

    await state.onMessage?.({ command: 'setDefaultProvider', providerId: 'not-rendered' });
    expect(setDefaultProvider).toHaveBeenCalledTimes(1);
  });

  it('gives a CLI-auth provider a setup action, and reaching it invokes the dep', async () => {
    const openSetup = vi.fn();
    const testConnection = vi.fn();

    SettingsPanel.createOrShow({} as any, {
      bridge: {
        getSnapshot: async () => ({
          providers: [
            { providerId: 'anthropic', name: 'Claude Headless', hasApiKey: false, authKind: 'claude-cli', catalogKind: 'claude-cli', presentation: { runtimeLabel: 'Claude Headless', billingLabel: 'Your Claude account', setup: { kind: 'cli', actionLabel: 'Set up Claude Headless', installCommand: 'npm install -g @anthropic-ai/claude-code', loginCommand: 'claude login' } } },
          ],
          mcpServers: [],
        }),
      } as any,
      promptAndStoreSecret: async () => false,
      openTeamFile: () => {},
      openConnectionSetup: openSetup,
      testConnection,
    });

    await vi.waitFor(() => {
      expect(state.panel.webview.html).toContain('data-command="openConnectionSetup"');
    });
    // Anthropic is the only provider in this snapshot, so a `setKey` button anywhere in the HTML would mean
    // the CLI-auth card is prompting for a key it never stores.
    expect(state.panel.webview.html).not.toContain('data-command="setKey"');
    expect(state.panel.webview.html).not.toContain('data-command="testConnection"');

    await state.onMessage?.({ command: 'openConnectionSetup', providerId: 'anthropic' });
    await state.onMessage?.({ command: 'testConnection', providerId: 'anthropic' });
    expect(openSetup).toHaveBeenCalledTimes(1);
    expect(testConnection).not.toHaveBeenCalled();
  });

  it('renders Codex Headless as Coming soon and never offers setup or default selection', async () => {
    const openedConnections: string[] = [];

    SettingsPanel.createOrShow({} as any, {
      bridge: {
        getSnapshot: async () => ({
          providers: [
            { providerId: 'codex', name: 'Codex Headless', hasApiKey: false, authKind: 'codex-cli', availability: 'coming-soon', availabilityMessage: 'Codex Headless is coming soon and is not available in this release.', presentation: { runtimeLabel: 'Codex Headless', billingLabel: 'Your OpenAI account', setup: { kind: 'cli', actionLabel: 'Set up Codex Headless', installCommand: 'npm install -g @openai/codex', loginCommand: 'codex login', requiredSetting: 'unode.codexCliPath' } } },
          ],
          mcpServers: [],
        }),
      } as any,
      promptAndStoreSecret: async () => false,
      openTeamFile: () => {},
      openConnectionSetup: (id: string) => { openedConnections.push(id); },
    });

    await vi.waitFor(() => expect(state.panel.webview.html).toContain('Coming soon'));
    const html = state.panel.webview.html;
    expect(html).toContain('Codex Headless is coming soon');
    expect(html).not.toContain('data-command="openConnectionSetup"');
    expect(html).not.toContain('data-command="setDefaultProvider"');
    expect(html).not.toContain('npm install -g @openai/codex');
    expect(html).not.toContain('codex login');

    await state.onMessage?.({ command: 'openConnectionSetup', providerId: 'codex' });
    await state.onMessage?.({ command: 'setDefaultProvider', providerId: 'codex' });
    expect(openedConnections).toEqual([]);
  });

  it('renders resolved model defaults and role-tier defaults without changing blank option values', async () => {
    SettingsPanel.createOrShow({} as any, {
      bridge: {
        getSnapshot: async () => ({
          providers: [
            { providerId: 'roam', name: 'Roam', apiKeySecretName: 'ROAM_API_KEY', hasApiKey: true, authKind: 'api-key', presentation: { runtimeLabel: 'OpenAI-compatible', billingLabel: 'Your Roam connection', privacySummary: 'Prompt data goes to Roam.', setup: { kind: 'api-key', actionLabel: 'Set API key' } } },
          ],
          mcpServers: [],
        }),
      } as any,
      promptAndStoreSecret: async () => false,
      openTeamFile: () => {},
      listAgentTunings: () => [{
        id: 'a1',
        name: 'Dev',
        role: 'senior-dev',
        providerId: 'roam',
        backend: 'openai-compat',
        model: 'deepseek-v4-pro',
      }],
      getSmartMode: () => ({
        enabled: true,
        defaultTier: 'economy',
        roleTiers: {},
        taskTierHints: {},
        modelTiers: {
          premium: { roam: 'claude-opus-4-8' },
          standard: { roam: 'deepseek-v4-pro' },
          economy: { roam: 'deepseek-v4-flash' },
        },
        providerIds: ['roam'],
      }),
      modelParamDefaultLabels: () => ({
        temperature: '0.2',
        topP: '0.9',
        maxTokens: '8192',
        presencePenalty: 'provider default',
        frequencyPenalty: 'provider default',
        reasoningEffort: 'high',
        responseFormat: 'json_object',
        stream: 'off',
        thinking: 'provider default',
        toolChoice: 'provider default',
        stop: 'provider default',
        contextWindow: '1048576',
      }),
    });

    await vi.waitFor(() => {
      expect(state.panel.webview.html).toContain('high (default)');
    });

    expect(state.panel.webview.html).toContain('<option value="" selected>high (default)</option>');
    expect(state.panel.webview.html).toContain('<option value="" selected>json_object (default)</option>');
    expect(state.panel.webview.html).toContain('<option value="" selected>off (default)</option>');
    expect(state.panel.webview.html).toContain('standard (role default)');
    expect(state.panel.webview.html).toContain('placeholder="0.2 (default)"');
    expect(state.panel.webview.html).toContain('placeholder="Provider default"');
    expect(state.panel.webview.html).toContain('placeholder="8192 (default)"');
    expect(state.panel.webview.html).toContain('placeholder="1048576"');
    expect(state.panel.webview.html).not.toContain('Default (medium)');
    expect(state.panel.webview.html).not.toContain('Default (text)');
    expect(state.panel.webview.html).not.toContain('provider default (default)');
  });

  it('uses the registry allowlist to hide Codex-ignored tuning controls and rejects a forged save', async () => {
    const setAgentTuning = vi.fn(async () => {});
    const tuning = {
      id: 'codex-agent', name: 'Codex reviewer', role: 'reviewer', providerId: 'codex', backend: 'codex' as const,
      model: 'codex-cli-default', modelParams: { temperature: 0.4, reasoning_effort: 'high' },
      allowedModelParamKeys: ['reasoning_effort'],
    };
    SettingsPanel.createOrShow({} as any, {
      bridge: { getSnapshot: async () => ({ providers: [], mcpServers: [] }) } as any,
      promptAndStoreSecret: async () => false,
      openTeamFile: () => {},
      listAgentTunings: () => [tuning],
      setAgentTuning,
    });

    await vi.waitFor(() => {
      expect(state.panel.webview.html).toContain('Legacy values preserved:');
    });
    const html = state.panel.webview.html;
    expect(html).toContain('data-field-wrap hidden><label title="Sampling randomness, 0-2.">Temperature');
    expect(html).toContain('data-field="reasoning_effort"');
    expect(html).toContain('data-remove-legacy');

    await state.onMessage?.({
      command: 'saveTuning', agentId: 'codex-agent', params: { temperature: 0.7 }, contextWindowTokens: 128000,
    });
    expect(setAgentTuning).not.toHaveBeenCalled();
  });

  it('routes custom gateway actions only to a rendered opaque custom connection', async () => {
    const edit = vi.fn(async () => {});
    const rename = vi.fn(async () => {});
    const endpoint = vi.fn(async () => {});
    const replaceKey = vi.fn(async () => {});
    const clearKey = vi.fn(async () => {});
    const archive = vi.fn(async () => {});
    const testConnection = vi.fn(async () => {});
    const listModels = vi.fn(async () => []);
    const setDefaultProvider = vi.fn(async () => {});
    const customId = 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const secretRef = 'custom-gateway:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccccccccccccccccccccccccccccccc';
    SettingsPanel.createOrShow({} as any, {
      bridge: {
        getSnapshot: async () => ({
          registryRevision: 7,
          providers: [{
            providerId: customId,
            connectionId: customId,
            revision: 3,
            name: 'Personal Gateway',
            apiKeySecretName: secretRef,
            hasApiKey: true,
            canManageApiKey: false,
            authKind: 'api-key',
            catalogKind: 'openai-models',
            billingKind: 'custom-account',
            baseUrl: 'https://gateway.example/v1',
            presentation: { runtimeLabel: 'OpenAI-compatible', billingLabel: 'This user-configured connection', privacySummary: 'Prompt data goes to this endpoint.', setup: { kind: 'api-key', actionLabel: 'Set API key' } },
          }],
          mcpServers: [],
        }),
      } as any,
      promptAndStoreSecret: async () => false,
      openTeamFile: () => {},
      addCustomGateway: async () => {},
      editCustomGateway: edit,
      renameCustomGateway: rename,
      updateCustomGatewayEndpoint: endpoint,
      replaceCustomGatewayKey: replaceKey,
      clearCustomGatewayKey: clearKey,
      testConnection,
      archiveCustomGateway: archive,
      listModels,
      getDefaultProvider: () => 'roam',
      setDefaultProvider,
    });

    await vi.waitFor(() => expect(state.panel.webview.html).toContain('Add custom gateway'));
    const html = state.panel.webview.html;
    const actionRow = html.match(/<div class="actions" style="margin-top:10px">([^]*?)<\/div>/)?.[1] ?? '';
    expect(html.match(/<div class="actions" style="margin-top:10px">/g)).toHaveLength(1);
    expect(Array.from(actionRow.matchAll(/data-command="([^"]+)"/g), (match) => match[1])).toEqual([
      'testConnection',
      'editCustomGateway',
      'setDefaultProvider',
      'listCustomGatewayModels',
      'archiveCustomGateway',
    ]);
    expect(actionRow).toContain(`data-command="testConnection" data-provider-id="${customId}"`);
    expect(actionRow).toContain(`data-command="editCustomGateway" data-provider-id="${customId}" title="Edit endpoint/key while no agent using this gateway is running. Stop the agent first."`);
    expect(actionRow).toContain(`data-command="setDefaultProvider" data-provider-id="${customId}"`);
    expect(actionRow).toContain(`data-command="listCustomGatewayModels" data-provider-id="${customId}" title="Models are loaded only on request."`);
    expect(actionRow).toContain(`data-command="archiveCustomGateway" data-provider-id="${customId}" title="Remove only when no agent, default, or Smart Mode tier points at it. Rebind those first."`);
    expect(actionRow).toContain('>Remove</button>');
    expect(actionRow).not.toContain('>Archive</button>');
    expect(actionRow).not.toContain('<details');
    expect(html).not.toContain('custom-overflow');
    expect(html).toContain('<span class="pill set">✓ Key set</span>');
    expect(html).toContain('<strong>Credential:</strong> managed by UnodeAi · Endpoint: https://gateway.example/v1');
    expect(html).toContain(`data-custom-gateway-models="${customId}"`);
    expect(html).not.toContain('ⓘ');
    expect(html).not.toContain('data-command="renameCustomGateway"');
    expect(html).not.toContain('data-command="updateCustomGatewayEndpoint"');
    expect(html).not.toContain('data-command="replaceCustomGatewayKey"');
    expect(html).not.toContain('data-command="clearCustomGatewayKey"');
    expect(html).not.toContain('data-api-key');
    expect(html).not.toContain(secretRef);
    expect(html).not.toContain('custom-gateway:');

    await state.onMessage?.({ command: 'editCustomGateway', providerId: customId, apiKey: 'forged-secret' } as any);
    await state.onMessage?.({ command: 'renameCustomGateway', providerId: customId });
    await state.onMessage?.({ command: 'updateCustomGatewayEndpoint', providerId: customId });
    await state.onMessage?.({ command: 'replaceCustomGatewayKey', providerId: customId });
    await state.onMessage?.({ command: 'clearCustomGatewayKey', providerId: customId });
    await state.onMessage?.({ command: 'testConnection', providerId: customId });
    await state.onMessage?.({ command: 'listCustomGatewayModels', providerId: customId });
    await state.onMessage?.({ command: 'setDefaultProvider', providerId: customId });
    await state.onMessage?.({ command: 'archiveCustomGateway', providerId: 'roam' });
    await state.onMessage?.({ command: 'archiveCustomGateway', providerId: customId });
    expect(edit).toHaveBeenCalledWith(customId);
    expect(rename).toHaveBeenCalledWith(customId);
    expect(endpoint).toHaveBeenCalledWith(customId);
    expect(replaceKey).toHaveBeenCalledWith(customId);
    expect(clearKey).toHaveBeenCalledWith(customId);
    expect(testConnection).toHaveBeenCalledWith(customId);
    expect(listModels).toHaveBeenCalledWith(customId);
    expect(setDefaultProvider).toHaveBeenCalledWith(customId);
    expect(archive).toHaveBeenCalledTimes(1);
    expect(archive).toHaveBeenCalledWith(customId);
  });

  it('uses a registry display name for custom agent and Smart Mode presentation', async () => {
    const customId = 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    SettingsPanel.createOrShow({} as any, {
      bridge: {
        getSnapshot: async () => ({
          providers: [{
            providerId: customId, connectionId: customId, name: 'Personal Gateway', hasApiKey: true,
            canManageApiKey: false, authKind: 'api-key', billingKind: 'custom-account',
            presentation: { runtimeLabel: 'OpenAI-compatible', billingLabel: 'Custom account', privacySummary: 'Prompt data goes to this endpoint.', setup: { kind: 'api-key', actionLabel: 'Set API key' } },
          }],
          mcpServers: [],
        }),
      } as any,
      promptAndStoreSecret: async () => false,
      openTeamFile: () => {},
      displayNameForProviderId: (providerId: string) => providerId === customId ? 'Personal Gateway' : providerId,
      listAgentTunings: () => [{ id: 'a1', name: 'Developer', role: 'developer', providerId: customId, backend: 'openai-compat' as const, model: 'model-a' }],
      getSmartMode: () => ({
        enabled: true, defaultTier: 'standard', roleTiers: {}, taskTierHints: {},
        modelTiers: { premium: {}, standard: {}, economy: {} }, providerIds: [customId],
      }),
    });

    await vi.waitFor(() => expect(state.panel.webview.html).toContain('Personal Gateway'));
    expect(state.panel.webview.html).toContain(`title="${customId}"`);
    expect(state.panel.webview.html).toContain('no Personal Gateway model');
  });
});
