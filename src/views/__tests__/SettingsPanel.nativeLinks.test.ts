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
import { bootWebviewScript, type WebviewElement } from './support/webviewBoot';
import { wordPowerPointRenderingPlatform, type OfficeRendererPreference } from '../../office/OfficeRendererSelection';

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
  it('keeps Team permissions reachable without the optional completion-check projection and opens only the selected User setting', async () => {
    show('team');
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('id="permissions"'));
    const html: string = state.panel.webview.html;
    expect(html).toContain('class="tab active" data-tab="team"');
    expect(html).toContain('class="section active" id="team"');
    expect(html).toContain('These choices apply to all profiles.');
    const buttons = [...html.matchAll(/data-command="openPermissionSettings" data-permission-setting="([^"]+)">([^<]+)<\/button>/g)];
    expect(buttons.map(([, key, label]) => [key, label])).toEqual([
      ['commandApproval', 'Commands'], ['writeApproval', 'File writes'], ['webAccess', 'Network access'], ['autonomy', 'Autonomy'],
    ]);
    const boot = bootWebviewScript(html);
    for (const [, key] of buttons) {
      const button = { dataset: { command: 'openPermissionSettings', permissionSetting: key } } as unknown as WebviewElement;
      boot.listeners.click?.forEach(listener => listener({ target: { closest: (selector: string) => selector === 'button[data-command]' ? button : null } }));
      const message = boot.postedMessages.at(-1);
      expect(message).toMatchObject({ command: 'openPermissionSettings', permissionSetting: key });
      await state.onMessage!(message);
    }
    expect(state.executed).toEqual([
      ['workbench.action.openSettings', '@id:unode.commandApproval'],
      ['workbench.action.openSettings', '@id:unode.writeApproval'],
      ['workbench.action.openSettings', '@id:unode.webAccess'],
      ['workbench.action.openSettings', '@id:unode.autonomy'],
    ]);
    expect(state.panel.webview.html).toBe(html);
    for (const permissionSetting of ['__proto__', 'some.other.setting', {}, undefined]) {
      await state.onMessage!({ command: 'openPermissionSettings', permissionSetting });
    }
    expect(state.executed).toHaveLength(4);
  });

  it('changes only the workspace renderer preference from Documents & images, with no detection or app start', async () => {
    let preference: OfficeRendererPreference = 'automatic'; const refresh = vi.fn(); const saved = vi.fn(async (value: OfficeRendererPreference) => { preference = value; });
    SettingsPanel.createOrShow({} as any, { bridge: { getSnapshot: async () => ({ providers: [], mcpServers: [] }) },
      promptAndStoreSecret: async () => false, openTeamFile() {}, getDefaultProvider: () => 'roam',
      refreshLocalApplications: refresh, getOfficeRendererPreference: () => preference, setOfficeRendererPreference: saved, wordPowerPointRendering: true } as any, 'more');
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('data-renderer-preference="word-powerpoint"'));
    const boot = bootWebviewScript(state.panel.webview.html);
    const button = { dataset: { command: 'setOfficeRendererPreference', rendererPreference: 'word-powerpoint' } } as unknown as WebviewElement;
    boot.listeners.click?.forEach(listener => listener({ target: { closest: (selector: string) => selector === 'button[data-command]' ? button : null } }));
    const message = boot.postedMessages.find((item: any) => item.command === 'setOfficeRendererPreference'); expect(message).toMatchObject({ rendererPreference: 'word-powerpoint' });
    await state.onMessage!(message); expect(saved).toHaveBeenCalledWith('word-powerpoint');
    expect(state.panel.webview.html).toContain('data-renderer-preference="word-powerpoint" aria-pressed="true"');
    await state.onMessage!({ command: 'setOfficeRendererPreference', rendererPreference: 'C:\\injected.exe' }); expect(saved).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled(); expect(state.executed).toEqual([]);
  });
  // v0.9.108 S3(a): the LibreOffice choice says what happens without it; Word/PowerPoint is offered only where it exists.
  it.each([[true, 'win32'], [false, 'darwin'], [false, 'linux']] as const)('offers Word/PowerPoint renderer choices only where that renderer exists (%s, %s)', async (available, platform) => {
    expect(wordPowerPointRenderingPlatform(platform)).toBe(available);
    SettingsPanel.createOrShow({} as any, { bridge: { getSnapshot: async () => ({ providers: [], mcpServers: [] }) },
      promptAndStoreSecret: async () => false, openTeamFile() {}, getDefaultProvider: () => 'roam', refreshLocalApplications: vi.fn(),
      getOfficeRendererPreference: () => 'automatic', setOfficeRendererPreference: vi.fn(), wordPowerPointRendering: wordPowerPointRenderingPlatform(platform) } as any, 'more');
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('data-renderer-preference="libreoffice"'));
    const html = state.panel.webview.html as string;
    expect(html.includes('data-renderer-preference="word-powerpoint"')).toBe(available);
    expect(html.includes('>Prefer LibreOffice (Word/PowerPoint when LibreOffice is not available)</button>')).toBe(available);
    expect(html.includes('>Prefer LibreOffice</button>')).toBe(!available);
    expect(html).toContain('data-renderer-preference="automatic"');
  });
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
