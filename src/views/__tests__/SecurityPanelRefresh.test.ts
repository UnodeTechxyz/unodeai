import { describe, expect, it, vi } from 'vitest';

// A panel host whose page HTML and dispose listener the test can see.
const host = vi.hoisted(() => ({
  panel: undefined as undefined | { webview: { html: string }; dispose: () => void },
}));

vi.mock('vscode', () => {
  const disposable = () => ({ dispose: () => undefined });
  return {
    ViewColumn: { One: 1 },
    workspace: { onDidGrantWorkspaceTrust: disposable },
    window: {
      createWebviewPanel: () => {
        let onDispose: (() => void) | undefined;
        const panel = {
          visible: true,
          webview: { html: '', cspSource: 'test:', onDidReceiveMessage: disposable },
          onDidDispose: (listener: () => void) => { onDispose = listener; return disposable(); },
          onDidChangeViewState: disposable,
          reveal: () => undefined,
          dispose: () => onDispose?.(),
        };
        host.panel = panel;
        return panel;
      },
    },
  };
});

import { SecurityPanel, SecuritySnapshot } from '../SecurityPanel';

const snapshot = (agents: string[]): SecuritySnapshot => ({
  workspaceTrusted: true, virtualWorkspace: false, commandApproval: 'ask', writeApproval: 'none',
  concurrencyStrategy: 'optimistic', fetchCatalog: false, egressGrants: [], mcpServers: [], agents: [], providers: [],
  codexSessionNetwork: agents.map((name) => ({ agentId: name.toLowerCase(), agentName: name })),
} as SecuritySnapshot);

/** getState answers in the order the test chooses, not the order it was asked. */
function controlledState() {
  const pending: Array<(state: SecuritySnapshot) => void> = [];
  return {
    pending,
    getState: () => new Promise<SecuritySnapshot>((resolve) => { pending.push(resolve); }),
  };
}

const deps = (getState: () => Promise<SecuritySnapshot>) => ({
  getState, revokeEgressHost: () => undefined, grantLocalReadScope: async () => undefined,
  revokeLocalReadScope: () => undefined, revokeRepositoryCliGrant: () => undefined, openSettings: () => undefined,
});
const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
const NETWORK_ROW = 'Solo · Network · For this session';

describe('an open Security page shows the newest state when redraws overlap (v0.9.102, Codex audit of d6760004)', () => {
  it('an older snapshot finishing last does not bring back network that was removed', async () => {
    const state = controlledState();
    SecurityPanel.createOrShow(deps(state.getState));
    state.pending.shift()!(snapshot([]));
    await settle();

    // Network allowed: a redraw starts and waits. Then it is removed: a second redraw starts and waits.
    SecurityPanel.refreshIfOpen();
    await settle();
    SecurityPanel.refreshIfOpen();
    await settle();
    expect(state.pending).toHaveLength(2);
    const [older, newer] = state.pending.splice(0);
    newer(snapshot([]));
    await settle();
    older(snapshot(['Solo']));
    await settle();
    expect(host.panel!.webview.html).toContain('No Codex agent has network');
    expect(host.panel!.webview.html).not.toContain(NETWORK_ROW);
    host.panel!.dispose();
  });

  it('a redraw that finishes after the page was closed does not write it', async () => {
    const state = controlledState();
    SecurityPanel.createOrShow(deps(state.getState));
    state.pending.shift()!(snapshot([]));
    await settle();
    SecurityPanel.refreshIfOpen();
    await settle();
    const page = host.panel!;
    const before = page.webview.html;
    page.dispose();
    state.pending.shift()!(snapshot(['Solo']));
    await settle();
    expect(page.webview.html).toBe(before);
  });
});
