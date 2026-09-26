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
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
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

function open(allow: boolean, set = vi.fn(async (_allow: boolean) => {})) {
  SettingsPanel.createOrShow({} as any, {
    bridge: { getSnapshot: async () => ({ providers: [], mcpServers: [] }) } as any,
    promptAndStoreSecret: async () => false,
    openTeamFile: () => {},
    getAllowCrossProviderDispatch: () => allow,
    setAllowCrossProviderDispatch: set,
  });
  return set;
}

describe('Settings → More: cross-provider dispatch toggle', () => {
  it('renders the toggle checked when dispatch without approval is allowed (the default)', async () => {
    open(true);
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('Allow cross-provider dispatch without approval'));
    const more = state.panel.webview.html.slice(state.panel.webview.html.indexOf('id="more"'));
    expect(more).toContain('data-setting="allowCrossProviderDispatch" checked');
  });

  it('renders it unchecked once the user has asked to approve every dispatch', async () => {
    open(false);
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('Allow cross-provider dispatch without approval'));
    expect(state.panel.webview.html).not.toContain('data-setting="allowCrossProviderDispatch" checked');
  });

  it('persists a boolean from the webview and ignores anything that is not one', async () => {
    const set = open(true);
    await vi.waitFor(() => expect(state.onMessage).toBeDefined());
    await state.onMessage!({ command: 'setAllowCrossProviderDispatch', value: false });
    expect(set).toHaveBeenCalledWith(false);
    await state.onMessage!({ command: 'setAllowCrossProviderDispatch', value: 'no' });
    await state.onMessage!({ command: 'setAllowCrossProviderDispatch' });
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('omits the toggle entirely for a host that does not supply the setting', async () => {
    SettingsPanel.createOrShow({} as any, {
      bridge: { getSnapshot: async () => ({ providers: [], mcpServers: [] }) } as any,
      promptAndStoreSecret: async () => false,
      openTeamFile: () => {},
    });
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('id="more"'));
    expect(state.panel.webview.html).not.toContain('Allow cross-provider dispatch without approval');
  });
});

describe('Settings → More: result-notice style', () => {
  function openResultStyle(style: 'dialog' | 'quiet', set = vi.fn(async (_style: 'dialog' | 'quiet') => {})) {
    SettingsPanel.createOrShow({} as any, {
      bridge: { getSnapshot: async () => ({ providers: [], mcpServers: [] }) } as any,
      promptAndStoreSecret: async () => false,
      openTeamFile: () => {},
      getResultNoticeStyle: () => style,
      setResultNoticeStyle: set,
    });
    return set;
  }

  it('renders quiet on and dialog off', async () => {
    openResultStyle('quiet');
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('Show results as quiet corner notifications'));
    expect(state.panel.webview.html).toContain('data-setting="quietResultNotices" checked');
    (SettingsPanel as any).current?.dispose();
    SettingsPanel.current = undefined;
    openResultStyle('dialog');
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('data-setting="quietResultNotices"'));
    expect(state.panel.webview.html).not.toContain('data-setting="quietResultNotices" checked');
  });

  it('persists only the two host-validated values', async () => {
    const set = openResultStyle('dialog');
    await vi.waitFor(() => expect(state.onMessage).toBeDefined());
    await state.onMessage!({ command: 'setResultNoticeStyle', value: 'quiet' });
    await state.onMessage!({ command: 'setResultNoticeStyle', value: 'dialog' });
    await state.onMessage!({ command: 'setResultNoticeStyle', value: 'silent-forever' });
    expect(set.mock.calls.map(([value]) => value)).toEqual(['quiet', 'dialog']);
  });
});
