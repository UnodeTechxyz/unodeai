import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompletionVerificationSettingsView } from '../../host/CompletionVerificationSettings';
import { TeamVerificationEditor } from '../../host/TeamVerificationEditor';
import type { TeamFileDocument } from '../../state/TeamFileSchema';
import { ResultBodyRecovery, RESULT_RECOVERY_UNAVAILABLE } from '../../state/ResultBodyRecovery';
import { PersistenceManager } from '../../state/PersistenceManager';
import { bootWebviewScript } from './support/webviewBoot';

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
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
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

function open(view: CompletionVerificationSettingsView, openLegacy = vi.fn(async () => {})) {
  const openTeamFile = vi.fn();
  SettingsPanel.createOrShow({} as never, {
    bridge: { getSnapshot: async () => ({ providers: [], mcpServers: [] }) } as never,
    promptAndStoreSecret: async () => false,
    openTeamFile,
    getCompletionVerification: () => view,
    openLegacyVerificationUserSettings: openLegacy,
  }, 'team');
  return { openLegacy, openTeamFile };
}

describe('Settings → Team: completion verification', () => {
  it('shows the same fixed recovery limitation from the real status port, with no error text or permission action', async () => {
    const persistence = new PersistenceManager({ workspaceState: { get: (_key: string, fallback: unknown) => fallback } } as never);
    await ResultBodyRecovery.connect({ storageUri: undefined, workspaceId: 'a'.repeat(64),
      assertCurrent() {}, reservations: () => [] }, { retainInConversationAndMemory() {}, notice() {},
      statusChanged: status => persistence.setResultRecoveryStatus(status) });
    SettingsPanel.createOrShow({} as never, {
      bridge: { getSnapshot: async () => ({ providers: [], mcpServers: [] }) } as never,
      promptAndStoreSecret: async () => false, openTeamFile: () => {},
      getCompletionVerification: () => ({ kind: 'unavailable', detail: 'test' }),
      getResultRecoveryStatus: () => persistence.getResultRecoveryStatus(),
    }, 'team');
    await vi.waitFor(() => expect(state.panel.webview.html.includes(RESULT_RECOVERY_UNAVAILABLE)).toBe(true));
    expect(state.panel.webview.html).toContain('Work continues with results in the conversation and memory.');
    expect(state.panel.webview.html).not.toContain('safe-publish-unavailable');
  });
  it('does not offer the withdrawn legacy command confirmation', async () => {
    open({ kind: 'unavailable', detail: 'test' });
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('test'));
    expect(state.panel.webview.html).not.toContain('reviewLegacyCommandTools');
  });
  it('a slow completion projection cannot publish old HTML after a newer render finishes (MN-E)', async () => {
    let finish!: (view: CompletionVerificationSettingsView) => void; let reads = 0;
    SettingsPanel.createOrShow({} as never, {
      bridge: { getSnapshot: async () => ({ providers: [], mcpServers: [] }) } as never,
      promptAndStoreSecret: async () => false, openTeamFile: () => {},
      getCompletionVerification: () => ++reads === 1 ? new Promise(resolve => { finish = resolve; })
        : { kind: 'unavailable', detail: 'current-projection-sentinel' },
    }, 'team');
    await vi.waitFor(() => expect(reads).toBe(1));
    SettingsPanel.refreshCurrent();
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('current-projection-sentinel'));
    const html = state.panel.webview.html;
    finish({ kind: 'unavailable', detail: 'old-projection-sentinel' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(state.panel.webview.html).toBe(html);
    expect(state.panel.webview.html).not.toContain('old-projection-sentinel');
  });
  it('a stale snapshot cannot replace the message allowlists after a newer render completes', async () => {
    let finish!: (snapshot: unknown) => void;
    let reads = 0;
    const bridge = { getSnapshot: () => ++reads === 1 ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve({ providers: [], mcpServers: [] }) };
    SettingsPanel.createOrShow({} as never, { bridge: bridge as never, promptAndStoreSecret: async () => false,
      openTeamFile: () => {} });
    SettingsPanel.refreshCurrent();
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('data-tab="providers"'));
    const html = state.panel.webview.html;
    finish({ providers: [{ providerId: 'stale', authKind: 'api-key', canManageApiKey: true, apiKeySecretName: 'STALE_KEY' }], mcpServers: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(state.panel.webview.html).toBe(html);
    expect((SettingsPanel.current as any).allowedSecretNames.size).toBe(0);
    expect((SettingsPanel.current as any).knownProviderIds.size).toBe(0);
  });

  it('runs the actual form click through the host parser and one-shot editor, retaining an Off command draft', async () => {
    let document: TeamFileDocument = { members: [], mcpServers: [], workflows: [] };
    const editor = new TeamVerificationEditor({ workspaceRoot: () => '/repo', rosterRevision: () => 1, isCurrentWorkspace: () => true,
      members: () => [], skills: () => [], configuration: () => ({ inspect: () => ({ globalValue: 'npm test' as any }) }),
      readDocument: async () => document, updateDocument: async edit => { document = edit(document); } });
    SettingsPanel.createOrShow({} as never, {
      bridge: { getSnapshot: async () => ({ providers: [], mcpServers: [] }) } as never,
      promptAndStoreSecret: async () => false, openTeamFile: () => {},
      getCompletionVerification: () => editor.prepare(), saveCompletionVerification: (token, policy) => editor.save(token, policy),
    }, 'team');
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('data-save-verification'));
    const html = state.panel.webview.html as string;
    const token = /data-edit-token="([^"]+)"/.exec(html)![1];
    expect(html).toContain('Save command for this team'); expect(html).toContain('Stop using legacy command');
    const mode = { value: 'disabled' }; const input = { value: 'npm test' }; const row = { hidden: false };
    const form = { dataset: { editToken: token }, querySelector: (selector: string) => selector === '[data-verification-mode]' ? mode
      : selector === '[data-verification-command]' ? input : row };
    const button = { closest: () => form, hasAttribute: () => false };
    const boot = bootWebviewScript(html);
    const target = { closest: (selector: string) => selector === '[data-save-verification],[data-auto-verification]' ? button : null,
      matches: () => false };
    for (const listener of boot.listeners.click) listener({ target });
    const message = boot.postedMessages.find((m: any) => m.command === 'saveCompletionVerification');
    expect(message).toEqual({ command: 'saveCompletionVerification', key: token, patch: { mode: 'disabled' } });
    expect(input.value).toBe('npm test');
    await state.onMessage!(message);
    expect(document.completionVerification).toEqual({ mode: 'disabled' });
  });

  it('does not expose the Team tab until the host supplies the new policy projection', async () => {
    const getSnapshot = vi.fn(async () => ({ providers: [], mcpServers: [] }));
    SettingsPanel.createOrShow({} as never, {
      bridge: { getSnapshot } as never,
      promptAndStoreSecret: async () => false,
      openTeamFile: () => {},
    }, 'team');
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('data-tab="providers"'));
    expect(state.panel.webview.html).not.toContain('data-tab="team"');
    expect(state.panel.webview.html).not.toContain('id="team"');

    await state.onMessage!({ command: 'selectSettingsTab', value: 'team' });
    SettingsPanel.refreshTeamCurrent();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getSnapshot).toHaveBeenCalledOnce();
  });

  it('renders the effective mode, source, command and cwd without calling an executor', async () => {
    open({
      kind: 'ready', mode: 'command', command: 'node check.js <input.txt', source: 'team-document',
      sourceLabel: 'Team file configuration (not command authorization)', teamKind: 'software', cwd: 'C:/repo',
    });
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('Specified command'));
    const html = state.panel.webview.html;
    expect(html).toContain('Team file configuration (not command authorization)');
    expect(html).toContain('<code>node check.js &lt;input.txt</code>');
    expect(html).not.toContain('<code>node check.js <input.txt</code>');
    expect(html).toContain('<code>C:/repo</code>');
    expect(html).toContain('configuration, not command authorization');
    expect(html).toContain("vscode.postMessage({ command: 'selectSettingsTab', value: tab })");
  });

  it('shows the fixed invalid legacy reason and repair action', async () => {
    open({
      kind: 'configuration-invalid', source: 'legacy-global',
      sourceLabel: 'User Settings compatibility command (configuration only)', teamKind: 'software', cwd: '/repo',
      detail: 'The command contains a CR or LF line break; it must be a single line. No fallback is used.',
      repair: 'legacy-user-settings',
    });
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('Invalid — not run'));
    expect(state.panel.webview.html).toContain('data-command="openLegacyVerificationUserSettings"');
  });

  it('keeps the rest of Settings usable when the optional projection fails', async () => {
    SettingsPanel.createOrShow({} as never, {
      bridge: { getSnapshot: async () => ({ providers: [], mcpServers: [] }) } as never,
      promptAndStoreSecret: async () => false,
      openTeamFile: () => {},
      getCompletionVerification: async () => {
        throw new Error('private projection failure');
      },
    }, 'team');
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('Completion-check settings could not be read'));
    expect(state.panel.webview.html).toContain('data-tab="providers"');
    expect(state.panel.webview.html).toContain('data-tab="team"');
    expect(state.panel.webview.html).not.toContain('private projection failure');
  });

  it('routes the legacy repair through the fixed host callback and ignores webview targets', async () => {
    const { openLegacy } = open({
      kind: 'configuration-invalid', source: 'legacy-global',
      sourceLabel: 'User Settings compatibility command (configuration only)', teamKind: 'software', cwd: '/repo',
      detail: 'The command is invalid. No fallback is used.', repair: 'legacy-user-settings',
    });
    await vi.waitFor(() => expect(state.onMessage).toBeDefined());
    await state.onMessage!({
      command: 'openLegacyVerificationUserSettings',
      value: 'workspace', target: 'workbench.action.openWorkspaceSettings',
    });
    expect(openLegacy).toHaveBeenCalledOnce();
    expect(openLegacy).toHaveBeenCalledWith();
  });

  it('opens the team file for an invalid team policy', async () => {
    const { openTeamFile } = open({
      kind: 'configuration-invalid', source: 'team-document',
      sourceLabel: 'Team file configuration (not command authorization)', teamKind: 'software', cwd: '/repo',
      detail: 'completionVerification is invalid in .unode/team.json. No fallback is used.', repair: 'team-file',
    });
    await vi.waitFor(() => expect(state.onMessage).toBeDefined());
    await state.onMessage!({ command: 'openTeamFile' });
    expect(openTeamFile).toHaveBeenCalledOnce();
  });

  it('refreshes only when a real webview tab selection makes Team visible', async () => {
    const getCompletionVerification = vi.fn((): CompletionVerificationSettingsView => ({
      kind: 'ready', mode: 'auto', source: 'legacy-default', sourceLabel: 'Compatibility default',
      teamKind: 'software', cwd: '/repo',
    }));
    SettingsPanel.createOrShow({} as never, {
      bridge: { getSnapshot: async () => ({ providers: [], mcpServers: [] }) } as never,
      promptAndStoreSecret: async () => false, openTeamFile: () => {}, getCompletionVerification,
    }, 'providers');
    await vi.waitFor(() => expect(getCompletionVerification).toHaveBeenCalledOnce());
    SettingsPanel.refreshTeamCurrent();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getCompletionVerification).toHaveBeenCalledOnce();

    await state.onMessage!({ command: 'selectSettingsTab', value: 'team' });
    SettingsPanel.refreshTeamCurrent();
    await vi.waitFor(() => expect(getCompletionVerification).toHaveBeenCalledTimes(2));

    await state.onMessage!({ command: 'selectSettingsTab', value: 'tuning' });
    SettingsPanel.refreshTeamCurrent();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getCompletionVerification).toHaveBeenCalledTimes(2);
  });
});
