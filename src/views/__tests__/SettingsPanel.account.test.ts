import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  panel: undefined as any,
  onMessage: undefined as ((message: unknown) => Promise<void>) | undefined,
  onDispose: undefined as (() => void) | undefined,
  openExternal: vi.fn(async () => true),
}));

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  Uri: { parse: (value: string) => ({ value }) },
  env: { openExternal: state.openExternal },
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
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
}));

import { SettingsPanel } from '../SettingsPanel';

function provider(hasApiKey: boolean) {
  return {
    providerId: 'unode',
    connectionId: 'unode',
    name: 'Unode',
    apiKeySecretName: 'UNODE_API_KEY',
    canManageApiKey: true,
    hasApiKey,
    authKind: 'api-key',
    catalogKind: 'openai-models',
    presentation: {
      runtimeLabel: 'OpenAI-compatible',
      billingLabel: 'Your Unode connection',
      privacySummary: 'Prompt data goes to Unode.',
      signupUrl: 'https://www.unodetech.xyz/login',
      pricingUrl: 'https://www.unodetech.xyz/pricing',
      balanceAvailable: true,
      setup: { kind: 'api-key', actionLabel: 'Set API key' },
    },
  };
}

function show(hasApiKey: boolean, getProviderBalance = vi.fn(async () => undefined)) {
  SettingsPanel.createOrShow({} as any, {
    bridge: {
      getSnapshot: async () => ({ providers: [provider(hasApiKey)], mcpServers: [] }),
    } as any,
    promptAndStoreSecret: vi.fn(async () => true),
    openTeamFile: () => {},
    getProviderBalance,
  }, 'account');
  return getProviderBalance;
}

afterEach(() => {
  (SettingsPanel as any).current?.dispose();
  SettingsPanel.current = undefined;
  state.panel = undefined;
  state.onMessage = undefined;
  state.onDispose = undefined;
  state.openExternal.mockClear();
});

describe('SettingsPanel Unode Account hub', () => {
  it('shows the no-key state without inventing a signed-in account', async () => {
    const getProviderBalance = show(false);
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('data-account-state="no-key"'));

    const body = state.panel.webview.html.slice(state.panel.webview.html.lastIndexOf('</style>'));
    expect(body).toContain('No Unode API key configured');
    expect(body).toContain('Connect an API key');
    expect(body).toContain('Create account / sign in');
    expect(body).not.toContain('Connected via API key — not signed in');
    expect(getProviderBalance).not.toHaveBeenCalled();
  });

  it('keeps a configured key distinct from sign-in and reports balance states only after an explicit request', async () => {
    const getProviderBalance = show(true, vi.fn(async () => ({ remainingUsd: 1.25, thresholdUsd: 5 })));
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('data-account-state="api-key"'));

    const body = state.panel.webview.html.slice(state.panel.webview.html.lastIndexOf('</style>'));
    expect(body).toContain('Connected via API key — not signed in');
    expect(body).toContain('Check available balance');
    expect(body).toContain('Balance unavailable — no approved metadata response was available from Unode.');
    expect(body).toContain("Low balance: ");
    expect(getProviderBalance).not.toHaveBeenCalled();

    await state.onMessage?.({ command: 'requestBalance', providerId: 'unode' });
    expect(getProviderBalance).toHaveBeenCalledWith('unode');
    expect(state.panel.webview.postMessage).toHaveBeenCalledWith({
      command: 'balance',
      providerId: 'unode',
      balance: { remainingUsd: 1.25, thresholdUsd: 5 },
    });

    await state.onMessage?.({ command: 'requestBalance', providerId: 'custom:attacker' });
    expect(getProviderBalance).toHaveBeenCalledTimes(1);
  });

  it('opens only the host-owned current Unode links, never a webview-supplied destination', async () => {
    show(true);
    await vi.waitFor(() => expect(state.onMessage).toBeTypeOf('function'));

    await state.onMessage?.({ command: 'openSignup', linkKey: 'unode' });
    await state.onMessage?.({ command: 'openPricing', linkKey: 'unode' });
    await state.onMessage?.({ command: 'openSignup', linkKey: 'https://attacker.example/account' });

    expect(state.openExternal).toHaveBeenCalledTimes(2);
    expect(state.openExternal).toHaveBeenNthCalledWith(1, { value: 'https://www.unodetech.xyz/login' });
    expect(state.openExternal).toHaveBeenNthCalledWith(2, { value: 'https://www.unodetech.xyz/pricing' });
  });
});
