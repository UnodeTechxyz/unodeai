import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
      const panel = { webview, onDidDispose: () => ({ dispose: () => {} }), dispose: () => {}, reveal: vi.fn() };
      state.panel = panel;
      return panel;
    }),
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

import { NATIVE_SETTINGS_QUERY, SettingsPanel, type SettingsPanelTab } from '../SettingsPanel';

function show(tab?: SettingsPanelTab) {
  SettingsPanel.createOrShow({} as any, {
    bridge: { getSnapshot: async () => ({ providers: [], mcpServers: [] }) } as any,
    promptAndStoreSecret: async () => false,
    openTeamFile: () => {},
    getDefaultProvider: () => 'roam',
  } as any, tab);
}

/** The part of the page above the tab strip: present whatever tab is selected. */
function topbar(): string {
  const html: string = state.panel.webview.html;
  return html.slice(html.indexOf('<div class="topbar">'), html.indexOf('<div class="tabs">'));
}

afterEach(() => {
  (SettingsPanel as any).current?.dispose();
  SettingsPanel.current = undefined;
  state.panel = undefined;
  state.onMessage = undefined;
  state.executed = [];
});

describe('v0.9.106 the Settings panel links to VS Code\'s own settings on every tab', () => {
  it('filters the native Settings editor to this extension\'s real id', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { publisher: string; name: string };
    expect(NATIVE_SETTINGS_QUERY).toBe(`@ext:${manifest.publisher}.${manifest.name}`);
  });

  for (const tab of ['providers', 'spend', 'more'] as const) {
    it(`shows All settings and Open settings file (JSON) above the tabs when ${tab} is open`, async () => {
      show(tab);
      await vi.waitFor(() => expect(topbar()).toContain('data-command="openSettingsJson"'));
      expect(topbar()).toMatch(/data-command="openNativeSettings"[^>]*>All settings<\/button>/);
      expect(topbar()).toMatch(/data-command="openSettingsJson"[^>]*>Open settings file \(JSON\)<\/button>/);
    });
  }

  it('All settings opens the native Settings editor filtered to UnodeAi, and nothing else', async () => {
    show();
    await vi.waitFor(() => expect(state.onMessage).toBeTruthy());
    await state.onMessage!({ command: 'openNativeSettings' });
    expect(state.executed).toEqual([['workbench.action.openSettings', NATIVE_SETTINGS_QUERY]]);
  });

  it('Open settings file (JSON) runs the editor\'s own command, and nothing else', async () => {
    show();
    await vi.waitFor(() => expect(state.onMessage).toBeTruthy());
    await state.onMessage!({ command: 'openSettingsJson' });
    expect(state.executed).toEqual([['workbench.action.openSettingsJson']]);
  });
});
