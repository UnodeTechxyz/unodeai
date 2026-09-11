import { describe, expect, it, vi } from 'vitest';

/*---------------------------------------------------------------------------------------------
 *  UX7 row 2 — "Sidebar session/agent click focuses the Workbench tab and selects that agent,
 *  no duplicate state."
 *
 *  The command (`unode.chatWithAgent`) is a five-line composition over this provider:
 *  selectAgent(id), then openWorkbench(false) — or, when `workbench.autoOpen` is off, focus the
 *  sidebar view instead. The logic being claimed lives here, so this is where it is pinned.
 *
 *  Two of these assertions exist because the failure they catch is SILENT. A second panel is a
 *  visible bug someone would report; `reveal(col, true)` is not — the tab surfaces without taking
 *  focus, so the user's keystrokes go to whatever they were editing and "focuses the Workbench"
 *  quietly stops being true.
 *--------------------------------------------------------------------------------------------*/

const created: Array<Record<string, unknown>> = [];

function makePanel(): Record<string, unknown> {
  const panel: Record<string, unknown> = {
    visible: true,
    viewColumn: 1,
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidDispose: vi.fn(() => ({ dispose: () => {} })),
    onDidChangeViewState: vi.fn(() => ({ dispose: () => {} })),
    webview: {
      options: {},
      html: '',
      postMessage: vi.fn(),
      onDidReceiveMessage: vi.fn(() => ({ dispose: () => {} })),
    },
  };
  return panel;
}

vi.mock('vscode', () => ({
  ViewColumn: { Active: -1, One: 1 },
  commands: { executeCommand: vi.fn() },
  window: {
    createWebviewPanel: vi.fn(() => {
      const panel = makePanel();
      created.push(panel);
      return panel;
    }),
  },
}));

import { ChatAgent, ChatViewDeps, ChatViewProvider } from '../ChatViewProvider';

const dev: ChatAgent = { id: 'agent-1', name: 'Dev', role: 'Developer', backend: 'openai' };
const qa: ChatAgent = { id: 'agent-2', name: 'QA', role: 'Reviewer', backend: 'openai' };

function provider(): ChatViewProvider {
  const store = new Map<string, unknown>();
  const deps = {
    listAgents: () => [dev, qa],
    send: vi.fn(),
    interject: vi.fn(),
    interrupt: vi.fn(),
    onReply: () => vi.fn(),
    state: {
      get: <T,>(key: string) => store.get(key) as T | undefined,
      update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
    },
    getApprovals: () => ({ command: 'ask', write: 'none' }),
    setApproval: vi.fn(),
    getCheckpoints: () => [],
  } as unknown as ChatViewDeps;
  return new ChatViewProvider({} as never, deps);
}

const stateOf = (p: ChatViewProvider): { selectedAgentId: string } =>
  (p as unknown as { currentState: () => { selectedAgentId: string } }).currentState();

describe('Workbench focus and selection (UX7 row 2)', () => {
  it('selects the agent the caller named', () => {
    const p = provider();
    p.selectAgent(qa.id);
    expect(stateOf(p).selectedAgentId).toBe(qa.id);
  });

  it('is one tab, not one per agent — a second open reveals rather than creating', () => {
    created.length = 0;
    const p = provider();

    p.selectAgent(dev.id);
    p.openWorkbench(false);
    expect(created).toHaveLength(1);

    // Switching agents is the exact motion UX2 refused to grow a tab strip for.
    p.selectAgent(qa.id);
    p.openWorkbench(false);
    p.selectAgent(dev.id);
    p.openWorkbench(false);

    expect(created).toHaveLength(1);
    expect(created[0].reveal).toHaveBeenCalledTimes(2);
    expect(stateOf(p).selectedAgentId).toBe(dev.id); // the reveals did not lose the selection
  });

  it('actually takes focus — a reveal that preserves focus would silently break the claim', () => {
    created.length = 0;
    const p = provider();
    p.openWorkbench(false);
    p.openWorkbench(false); // the reveal path, which is where preserveFocus is passed

    // Second argument is preserveFocus. `true` here means the tab surfaces but keystrokes keep
    // going to the editor the user was in — the row would read as met while being false.
    expect(created[0].reveal).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('leaves no stale panel behind when the tab is closed and reopened', () => {
    created.length = 0;
    const p = provider();
    p.openWorkbench(false);

    // Native tab disposal is the close path; closeWorkbench merely invokes it.
    const onDispose = (created[0].onDidDispose as ReturnType<typeof vi.fn>).mock.calls[0][0] as () => void;
    p.closeWorkbench();
    onDispose(); // VS Code fires this after the tab goes away

    p.openWorkbench(false);
    expect(created).toHaveLength(2); // a fresh panel, because the old one is genuinely gone
    expect(created[1].reveal).not.toHaveBeenCalled(); // created, not revealed — no ghost reference
  });
});
