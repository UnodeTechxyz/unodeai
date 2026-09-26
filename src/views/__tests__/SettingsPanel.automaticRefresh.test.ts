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
        cspSource: 'vscode-webview:', html: '', postMessage: vi.fn(),
        onDidReceiveMessage: (callback: (message: unknown) => Promise<void>) => {
          state.onMessage = callback;
          return { dispose: () => {} };
        },
      };
      const panel = {
        webview,
        onDidDispose: (callback: () => void) => {
          state.onDispose = callback;
          return { dispose: () => {} };
        },
        dispose: vi.fn(() => {
          if (disposed) return;
          disposed = true;
          state.onDispose?.();
        }),
        reveal: vi.fn(),
      };
      state.panel = panel;
      return panel;
    }),
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

import { SettingsPanel } from '../SettingsPanel';

const provider = (providerId: string) => ({
  providerId,
  connectionId: providerId,
  revision: 1,
  name: providerId,
  hasApiKey: false,
  canManageApiKey: true,
  apiKeySecretName: `${providerId.toUpperCase()}_API_KEY`,
  authKind: 'api-key',
  catalogKind: 'openai-models',
  billingKind: 'gateway-balance',
  baseUrl: `https://${providerId}.example/v1`,
  presentation: {
    runtimeLabel: 'OpenAI-compatible', billingLabel: 'Gateway', privacySummary: 'Prompts go here.',
    setup: { kind: 'api-key', actionLabel: 'Set API key' },
  },
});

afterEach(() => {
  (SettingsPanel as any).current?.dispose();
  SettingsPanel.current = undefined;
  state.panel = undefined;
  state.onMessage = undefined;
  state.onDispose = undefined;
});

describe('Settings automatic refresh controls', () => {
  it('shows only scheduled providers plus a separate global-source toggle', async () => {
    SettingsPanel.createOrShow({} as any, {
      bridge: { getSnapshot: async () => ({ providers: [provider('roam'), provider('openai')], mcpServers: [] }) } as any,
      promptAndStoreSecret: async () => false,
      openTeamFile: () => {},
      getProviderAutomaticRefresh: (id) => id === 'roam' ? true : undefined,
      getGlobalPricingSourcesAutomaticRefresh: () => false,
    });
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('Automatic daily price refresh'));
    expect(state.panel.webview.html).toContain('data-provider-id="roam" checked');
    expect(state.panel.webview.html).not.toContain('data-provider-automatic-refresh data-provider-id="openai"');
    expect(state.panel.webview.html).toContain('data-setting="globalPricingSourcesAutomaticRefresh"');
    expect(state.panel.webview.html).not.toContain('data-setting="globalPricingSourcesAutomaticRefresh" checked');
  });

  it('accepts only rendered provider ids and boolean values', async () => {
    const setProvider = vi.fn(async () => {});
    const setGlobal = vi.fn(async () => {});
    SettingsPanel.createOrShow({} as any, {
      bridge: { getSnapshot: async () => ({ providers: [provider('roam')], mcpServers: [] }) } as any,
      promptAndStoreSecret: async () => false,
      openTeamFile: () => {},
      getProviderAutomaticRefresh: (id) => id === 'roam' ? true : undefined,
      setProviderAutomaticRefresh: setProvider,
      getGlobalPricingSourcesAutomaticRefresh: () => true,
      setGlobalPricingSourcesAutomaticRefresh: setGlobal,
    });
    await vi.waitFor(() => expect(state.onMessage).toBeDefined());
    await state.onMessage!({ command: 'setProviderAutomaticRefresh', providerId: 'roam', value: false });
    await state.onMessage!({ command: 'setProviderAutomaticRefresh', providerId: 'forged', value: true });
    await state.onMessage!({ command: 'setProviderAutomaticRefresh', providerId: 'roam', value: 'false' });
    await state.onMessage!({ command: 'setGlobalPricingSourcesAutomaticRefresh', value: false });
    await state.onMessage!({ command: 'setGlobalPricingSourcesAutomaticRefresh', value: 'false' });
    expect(setProvider).toHaveBeenCalledOnce();
    expect(setProvider).toHaveBeenCalledWith('roam', false);
    expect(setGlobal).toHaveBeenCalledOnce();
    expect(setGlobal).toHaveBeenCalledWith(false);
  });
});
