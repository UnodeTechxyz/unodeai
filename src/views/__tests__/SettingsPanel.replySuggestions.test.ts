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
import { ReplySuggestionService } from '../../suggestions/ReplySuggestionService';
import { RequestCeilingGate } from '../../host/RequestCeiling';
import { RequestLimitMeter } from '../../host/RequestLimitMeter';

afterEach(() => {
  (SettingsPanel as any).current?.dispose();
  SettingsPanel.current = undefined;
  state.panel = undefined;
  state.onMessage = undefined;
  state.onDispose = undefined;
});

function open(view: { configured: boolean; label: string; problem?: string }) {
  const choose = vi.fn(async () => {});
  const turnOff = vi.fn(async () => {});
  SettingsPanel.createOrShow({} as any, {
    bridge: { getSnapshot: async () => ({ providers: [], mcpServers: [] }) } as any,
    promptAndStoreSecret: async () => false,
    openTeamFile: () => {},
    replySuggestionModel: () => view,
    chooseReplySuggestionModel: choose,
    turnOffReplySuggestions: turnOff,
  });
  return { choose, turnOff };
}

// v0.9.110 S1: the UnodeAI Reply Suggestion Model row in Settings → Providers.
describe('Settings → Providers: UnodeAI Reply Suggestion Model', () => {
  it('shows None with Choose model…, and says what is sent and that it is billed', async () => {
    open({ configured: false, label: 'None' });
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('UnodeAI Reply Suggestion Model'));
    const card = state.panel.webview.html.slice(state.panel.webview.html.indexOf('id="replySuggestionCard"'));
    expect(card).toContain('None');
    expect(card).toContain('data-command="chooseReplySuggestionModel"');
    expect(card.slice(0, card.indexOf('</div>'))).not.toContain('turnOffReplySuggestions');
    expect(card).toContain('which can include code and file content you or a member');
    expect(card).toContain('billed');
    expect(card).toContain('Tab only fills the composer');
  });

  it('shows the connection and exact model with Turn off, and names a connection that cannot be used', async () => {
    open({ configured: true, label: 'My gateway · exact-model-1', problem: 'This connection cannot provide reply suggestions' });
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('id="replySuggestionCard"'));
    const card = state.panel.webview.html.slice(state.panel.webview.html.indexOf('id="replySuggestionCard"'));
    expect(card).toContain('My gateway · exact-model-1');
    expect(card).toContain('This connection cannot provide reply suggestions');
    expect(card).toContain('data-command="turnOffReplySuggestions"');
  });

  it('runs the host action for each button', async () => {
    const actions = open({ configured: true, label: 'Unode · m' });
    await vi.waitFor(() => expect(state.onMessage).toBeDefined());
    await state.onMessage!({ command: 'chooseReplySuggestionModel' });
    await state.onMessage!({ command: 'turnOffReplySuggestions' });
    expect(actions.choose).toHaveBeenCalledTimes(1);
    expect(actions.turnOff).toHaveBeenCalledTimes(1);
  });
});

// Codex audit F6: why the last suggestion gave nothing reaches the rendered Providers row, from the real service.
describe('Settings → Providers: the reply suggestion status from the real service', () => {
  function service(options: { key?: string; status?: number }) {
    const gate = new RequestCeilingGate({ readLimits: () => ({}), decide: async () => 'stop', stopRequest: () => undefined,
      reachableRequests: () => new Set(), timers: { set: () => 0, clear: () => undefined } });
    const sent: string[] = [];
    const real = new ReplySuggestionService({
      readModel: () => ({ connectionId: 'unode', modelId: 'sugg-1' }),
      settingsRevision: () => 1,
      connection: () => ({ connectionId: 'unode', revision: 1, displayName: 'Unode', textApi: true,
        endpointBase: 'https://gateway.example/v1', apiKeySecretName: 'UNODE_API_KEY' }),
      apiKey: async () => options.key,
      approveEgress: async () => undefined,
      fetch: async (url) => { sent.push(url); return { ok: (options.status ?? 200) < 400, status: options.status ?? 200, text: async () => '{}' }; },
      ceiling: gate, meter: new RequestLimitMeter(gate, () => false),
      spend: { beginUsageUnit() {}, noteModelRequest() {}, settleUsageUnit() {}, closeUsageUnit() {} },
      newId: () => 'n1',
    });
    const ask = async () => {
      gate.begin('r1');
      const budget = real.pinBudget('r1');
      await real.suggest({ budget, agentId: 'pm', agentName: 'PM', signal: new AbortController().signal,
        messages: [{ role: 'user', text: 'Fix it.' }, { role: 'agent', text: 'Fixed.' }] });
      budget.release();
    };
    return { real, ask, sent };
  }

  function render(real: ReplySuggestionService, setKey = vi.fn(async () => {})) {
    SettingsPanel.createOrShow({} as any, {
      bridge: { getSnapshot: async () => ({ providers: [], mcpServers: [] }) } as any,
      promptAndStoreSecret: async () => false,
      openTeamFile: () => {},
      replySuggestionModel: () => real.settingView(),
      chooseReplySuggestionModel: async () => {},
      turnOffReplySuggestions: async () => {},
      setReplySuggestionKey: setKey,
    });
    return setKey;
  }

  it('a missing stored key is shown with Set API key…, which runs the key-setting route; nothing was sent', async () => {
    const h = service({ key: undefined });
    await h.ask();
    const setKey = render(h.real);
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('id="replySuggestionCard"'));
    const card = state.panel.webview.html.slice(state.panel.webview.html.indexOf('id="replySuggestionCard"'));
    expect(card).toContain('API key required: no key is stored for this connection');
    expect(card).toContain('data-command="setReplySuggestionKey"');
    await state.onMessage!({ command: 'setReplySuggestionKey' });
    expect(setKey).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual([]);
  });

  it('a provider failure is shown by its status, without a key action', async () => {
    const h = service({ key: 'k', status: 500 });
    await h.ask();
    render(h.real);
    await vi.waitFor(() => expect(state.panel.webview.html).toContain('id="replySuggestionCard"'));
    const card = state.panel.webview.html.slice(state.panel.webview.html.indexOf('id="replySuggestionCard"'));
    expect(card).toContain('The last suggestion request failed: the provider returned HTTP 500');
    expect(card.slice(0, card.indexOf('</div>'))).not.toContain('setReplySuggestionKey');
    expect(h.sent).toHaveLength(1);
  });
});

