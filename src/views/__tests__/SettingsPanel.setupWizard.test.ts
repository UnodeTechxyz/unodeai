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

describe('Providers tab leads to the first-task screen', () => {
  // v0.9.106 (first use): the setup wizard was removed. The Providers tab keeps its entry, which runs Get Started and
  // so opens the Workbench (the Owner, 2026-11-18); with no agent it is the first-task screen. That the command reaches
  // it is proven through activate() in src/__tests__/ActivatedFirstUse.workbench.flows.test.ts.
  it('renders a Start a task button on the Providers tab', async () => {
    show();
    await vi.waitFor(() => {
      expect(state.panel.webview.html).toContain('data-command="openSetupWizard"');
      expect(state.panel.webview.html).toContain('>Start a task</button>');
      expect(state.panel.webview.html).not.toContain('Run Setup Wizard');
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

  // v0.9.106 (setup guide, design §2, Codex F1): the guide has its own button; the first-task button above stays. That
  // each reaches its destination through activate() is in src/__tests__/ActivatedSetupGuide.flows.test.ts.
  it('renders a separate Setup guide button beside it, which runs unode.setupGuide and nothing else', async () => {
    show();
    await vi.waitFor(() => expect(state.onMessage).toBeTruthy());
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('data-command="openSetupGuide"'));
    expect(state.panel.webview.html).toMatch(/data-command="openSetupGuide"[^>]*>Setup guide<\/button>/);
    expect(state.panel.webview.html).toContain('data-command="openSetupWizard"');

    await state.onMessage!({ command: 'openSetupGuide' });

    expect(state.executed).toEqual([['unode.setupGuide']]);
  });
});
