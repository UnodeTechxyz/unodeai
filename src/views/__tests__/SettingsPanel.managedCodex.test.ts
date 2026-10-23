import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  panel: undefined as any,
  onMessage: undefined as ((message: unknown) => Promise<void>) | undefined,
}));

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  window: {
    createWebviewPanel: vi.fn(() => {
      const webview = {
        cspSource: 'vscode-webview:',
        html: '',
        onDidReceiveMessage: (callback: (message: unknown) => Promise<void>) => { state.onMessage = callback; return { dispose: () => {} }; },
        postMessage: vi.fn(),
      };
      const panel = { webview, onDidDispose: () => ({ dispose: () => {} }), dispose: () => {}, reveal: vi.fn() };
      state.panel = panel;
      return panel;
    }),
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

import { MANAGED_CODEX_ACTIONS, SettingsPanel, type ManagedCodexCardView } from '../SettingsPanel';

// v0.9.97: the Codex CLI card shows managed Codex's state from the shared store, and its buttons reach the host only
// as one of the named managed Codex actions, which the host then confirms itself.

afterEach(() => {
  (SettingsPanel as any).current?.dispose();
  SettingsPanel.current = undefined;
  state.panel = undefined;
  state.onMessage = undefined;
});

const cli = (providerId: string, authKind: string) => ({
  providerId, connectionId: authKind, revision: 1, name: providerId, hasApiKey: false, canManageApiKey: false, authKind,
  catalogKind: authKind, billingKind: 'cli-account', availability: 'available',
  presentation: { runtimeLabel: providerId, billingLabel: 'account', setup: { kind: 'cli', actionLabel: 'Set up', loginCommand: 'login' } },
});

function open(card: ManagedCodexCardView | undefined, action = vi.fn(async () => {})) {
  SettingsPanel.createOrShow({} as any, {
    bridge: { getSnapshot: async () => ({ providers: [cli('anthropic', 'claude-cli'), cli('codex', 'codex-cli')], mcpServers: [] }) } as any,
    promptAndStoreSecret: async () => false,
    openTeamFile: () => {},
    cliRuntimeStatus: () => ({ origin: 'none' as const }),
    managedCodexCard: () => card,
    managedCodexAction: action,
  });
  return action;
}

describe('SettingsPanel managed Codex (v0.9.97)', () => {
  it('shows the state and the offered actions on the Codex card only', async () => {
    open({
      title: 'Paused in every window',
      lines: ['New sessions use the external CLI.', 'Version <0.164.0> is downloaded & checked.'],
      actions: [{ action: 'use-managed-again', label: 'Use managed Codex again', primary: true }, { action: 'review', label: 'Review', key: '0.164.0-win32-x64-0123456789abcdef' }],
    });
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('Managed Codex:'));
    const html: string = state.panel.webview.html;
    expect(html.match(/<strong>Managed Codex:<\/strong>/g)).toHaveLength(1);
    expect(html).toContain('<strong>Managed Codex:</strong> Paused in every window<br>New sessions use the external CLI.<br>Version &lt;0.164.0&gt; is downloaded &amp; checked.');
    expect(html).toContain('<button class="btn primary" data-command="managedCodexAction" data-managed-action="use-managed-again">Use managed Codex again</button>');
    expect(html).toContain('data-managed-action="review" data-managed-key="0.164.0-win32-x64-0123456789abcdef"');
  });

  it('renders no button for an action outside the named list', async () => {
    open({ title: 'Not set up', lines: [], actions: [{ action: 'delete-everything' as any, label: 'Delete' }, { action: 'set-up', label: 'Set up managed Codex…' }] });
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('Managed Codex:'));
    expect(state.panel.webview.html).not.toContain('delete-everything');
    expect(state.panel.webview.html).toContain('data-managed-action="set-up"');
  });

  it('passes only named actions to the host', async () => {
    const action = open({ title: 'Not set up', lines: [], actions: [] });
    await vi.waitFor(() => expect(state.onMessage).toBeDefined());
    for (const name of MANAGED_CODEX_ACTIONS) await state.onMessage?.({ command: 'managedCodexAction', managedAction: name });
    await state.onMessage?.({ command: 'managedCodexAction', managedAction: 'reset; rm -rf' });
    await state.onMessage?.({ command: 'managedCodexAction', managedAction: { toString: () => 'reset' } });
    await state.onMessage?.({ command: 'managedCodexAction' });
    expect(action.mock.calls.map((call) => (call as unknown[])[0])).toEqual([...MANAGED_CODEX_ACTIONS]);
    // A version key travels as text, bounded; the host checks it against what it rendered.
    action.mockClear();
    await state.onMessage?.({ command: 'managedCodexAction', managedAction: 'review', managedKey: '0.164.0-win32-x64-0123456789abcdef' });
    await state.onMessage?.({ command: 'managedCodexAction', managedAction: 'review', managedKey: 'x'.repeat(65) });
    await state.onMessage?.({ command: 'managedCodexAction', managedAction: 'review', managedKey: 7 });
    expect(action.mock.calls).toEqual([['review', '0.164.0-win32-x64-0123456789abcdef'], ['review', undefined], ['review', undefined]]);
  });

  it('shows nothing for managed Codex where the host offers none', async () => {
    open(undefined);
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('Program:'));
    expect(state.panel.webview.html).not.toContain('Managed Codex:');
  });
});
