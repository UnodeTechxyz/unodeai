import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  panel: undefined as any,
  onMessage: undefined as ((message: unknown) => Promise<void>) | undefined,
  executed: [] as unknown[][],
}));

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  commands: {
    executeCommand: vi.fn(async (...args: unknown[]) => { state.executed.push(args); }),
  },
  window: {
    createWebviewPanel: vi.fn(() => {
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
        onDidDispose: () => ({ dispose: () => {} }),
        dispose: () => {},
        reveal: vi.fn(),
      };
      state.panel = panel;
      return panel;
    }),
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

import { SettingsPanel } from '../SettingsPanel';

function show() {
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
    getDefaultProvider: () => 'roam',
  } as any);
}

afterEach(() => {
  (SettingsPanel as any).current?.dispose();
  SettingsPanel.current = undefined;
  state.panel = undefined;
  state.onMessage = undefined;
  state.executed = [];
});

describe('Providers tab can re-run the setup wizard', () => {
  // Field request: after the first-run wizard there was NO way back to it. Changing gateway/base URL meant
  // editing raw VS Code settings — the Providers card only offered "Set key" and "Set as default".
  it('renders a Run Setup Wizard button on the Providers tab', async () => {
    show();
    await vi.waitFor(() => {
      expect(state.panel.webview.html).toContain('data-command="openSetupWizard"');
      expect(state.panel.webview.html).toContain('Run Setup Wizard again');
    });
  });

  it('actually dispatches unode.onboarding when clicked', async () => {
    show();
    await vi.waitFor(() => expect(state.onMessage).toBeTruthy());

    await state.onMessage!({ command: 'openSetupWizard' });

    // A button that renders but dispatches nothing is exactly the class of bug v0.9.28 shipped
    // (a whole panel rendered perfectly and was completely inert).
    expect(state.executed).toContainEqual(['unode.onboarding']);
  });
});
