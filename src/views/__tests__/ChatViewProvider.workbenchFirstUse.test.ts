import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * v0.9.106 (the Owner, 2026-11-18): first use opens in the Workbench, the editor-area tab, not in the sidebar Chat. The
 * Workbench page serves the same first-use screen as the sidebar: the goal heading, the suggestions, the box and Send.
 * The fresh-install opening keeps the focus where the person has it; an open Workbench is revealed, never doubled.
 * The rendered Workbench layout (floating and in-column composer) is checked in headless Edge; here the page's script.
 */
const created: Array<{ viewType: string; showOptions: unknown; panel: any }> = [];

vi.mock('vscode', () => ({
  ViewColumn: { Active: -1, One: 1 },
  commands: { executeCommand: vi.fn() },
  window: {
    createWebviewPanel: vi.fn((viewType: string, _title: string, showOptions: unknown) => {
      const panel = {
        title: 'UnodeAi Workbench', visible: true, active: true, viewColumn: 1,
        reveal: vi.fn(), dispose: vi.fn(),
        onDidDispose: () => ({ dispose() {} }),
        onDidChangeViewState: () => ({ dispose() {} }),
        webview: {
          options: {}, html: '', cspSource: 'test:', asWebviewUri: (uri: unknown) => uri,
          posted: [] as unknown[],
          postMessage: vi.fn(async (message: unknown) => { panel.webview.posted.push(message); return true; }),
          onDidReceiveMessage: () => ({ dispose() {} }),
        },
      };
      created.push({ viewType, showOptions, panel });
      return panel;
    }),
    showInformationMessage: vi.fn(), showErrorMessage: vi.fn(), showWarningMessage: vi.fn(),
  },
}));

import { ChatViewProvider } from '../ChatViewProvider';
import { bootWebviewScript } from './support/webviewBoot';

const GOAL_VIEW = { active: true, text: '', revision: 1, phase: 'compose', suggestions: ['One', 'Two', 'Three'] };

function provider() {
  const chat = new ChatViewProvider({} as never, {
    listAgents: () => [],
    send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
    state: { get: () => undefined, update: async () => {} },
    getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    firstUse: { view: () => GOAL_VIEW, draft() {}, action() {}, handoverResult() {} },
  } as never);
  (chat as any).rosterLoaded();
  return chat;
}

const descendants = (node: any): any[] => (Array.isArray(node?.children) ? node.children : []).flatMap((child: any) => [child, ...descendants(child)]);
const text = (node: any): string => [node?.textContent, ...(Array.isArray(node?.children) ? node.children.map(text) : [])].filter(Boolean).join(' ');

describe('v0.9.106 first use in the Workbench', () => {
  beforeEach(() => { created.length = 0; });

  it('the Workbench page with no agent shows the first-use block, the box and Send', () => {
    const chat = provider();
    chat.openWorkbench(true);
    expect(created.map((entry) => entry.viewType)).toEqual([ChatViewProvider.workbenchViewType]);
    const { panel } = created[0];
    const html = String(panel.webview.html);
    expect(html).toContain('<body class="container-workbench">');
    const page = bootWebviewScript(html, { bodyClasses: ['container-workbench'] });
    // What the host posted to this page, and the state as it is now.
    for (const message of [...panel.webview.posted, { command: 'state', state: chat.currentState() }]) {
      for (const listener of page.listeners.message ?? []) listener({ data: message });
    }
    expect(page.body.classList.contains('first-use')).toBe(true);
    const transcript = page.elements.get('transcript');
    expect(text(transcript)).toContain('What do you want to get done?');
    // The three suggestions and the setup guide's one-line link (v0.9.106, the Owner's Q1), which only opens the guide.
    expect(descendants(transcript).filter((node) => node.type === 'button').map((node) => node.className))
      .toEqual(['fu-suggestion', 'fu-suggestion', 'fu-suggestion', 'fu-link']);
    const input = page.elements.get('input') as any;
    const send = page.elements.get('send') as any;
    expect(input.disabled).toBe(false);
    expect(send.disabled).toBe(false);
    expect(send.hidden).not.toBe(true);
    // Send is in the Workbench's composer dock, which first use does not hide; first use hides only the agent controls.
    expect(html).toMatch(/<div class="composer-dock" id="composerDock"[\s\S]*id="send"/);
    expect(html).not.toMatch(/body\.first-use (?:\.composer-dock|\.composer-shell|#composerDock|#send|#input)\b[^{]*\{[^}]*display: none/);
  });

  it('the fresh-install opening keeps the focus; a click takes it; an open Workbench is revealed, not opened again', () => {
    const chat = provider();
    chat.openWorkbench(true);
    expect(created).toHaveLength(1);
    expect(created[0].showOptions).toEqual({ viewColumn: -1, preserveFocus: true });
    chat.openWorkbench(false);
    chat.openWorkbench(true);
    expect(created).toHaveLength(1);
    expect(created[0].panel.reveal.mock.calls).toEqual([[1, false], [1, true]]);

    // A person's own opening (Open Workbench, a roster double-click) is unchanged: the active column, with the focus.
    created.length = 0;
    provider().openWorkbench(false);
    expect(created.map((entry) => entry.showOptions)).toEqual([-1]);
  });
});
