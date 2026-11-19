import { describe, expect, it, vi } from 'vitest';

/**
 * v0.9.106 (the Owner, 2026-11-18): first use opens in the Workbench, the editor-area tab, which is as visible as the
 * setup wizard was; the sidebar Chat is no longer where it starts. Through the extension's real entry, in a window of a
 * fresh installation (nothing in globalState, no global storage, no user setting, no stored key) that opens with no
 * agent: activation opens the Workbench once without taking the focus, its page is the goal box, Get Started and the
 * empty Team panel's button reveal the same Workbench, and the goal written there starts the team, after which the
 * Workbench continues in the project manager's conversation. Not a native VS Code host: the native focus and the
 * editor area are N4 field evidence. An upgrade opens nothing: ActivatedFirstUse.flows.test.ts.
 */
const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());

vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));
vi.mock('../host/postWriteDiagnosticsSettle', () => ({ POST_WRITE_DIAGNOSTICS_SETTLE_MS: 0 }));

import { DEFAULT_MODEL_TIERS } from '../roles/RoleConfig';
import { FIRST_USE_REVEAL_HANDLED_KEY } from '../firstUse/installCohort';
import { ChatViewProvider } from '../views/ChatViewProvider';
import { TeamViewProvider } from '../views/TeamViewProvider';
import { chatScreen, context, installActivatedExtension, latestUser, pumpWhile, requests, scripts } from './support/activatedHarness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** A fresh installation stores no key. The person's key arrives later, before the first start. */
let keyStored = false;
Object.assign(context.secrets, {
  get: async () => (keyStored ? 'sk-test' : undefined),
  store: async () => { keyStored = true; },
});

/** Every command the extension runs through VS Code; Get Started, which the Team panel runs, is the registered one. */
const executed: unknown[][] = [];
host.overrides['vscode.commands.executeCommand'] = (...args: unknown[]) => {
  executed.push(args);
  if (args[0] === 'unode.onboarding') return host.commands.get('unode.onboarding')!();
  return (host.stub('vscode.commands.executeCommand') as (...rest: unknown[]) => unknown)(...args);
};

/** Each webview panel opened: its view type, where and how it was shown, its reveals and what the host posted to it. */
type Panel = {
  viewType: string; showOptions: unknown; visible: boolean; viewColumn: number; reveals: unknown[][]; posted: unknown[];
  receive?: (message: unknown) => void; webview: any;
};
const panels: Panel[] = [];
host.overrides['vscode.window.createWebviewPanel'] = (viewType: string, _title: string, showOptions: unknown) => {
  const panel: Panel = {
    viewType, showOptions, visible: true, viewColumn: 1, reveals: [], posted: [],
    webview: undefined,
  };
  let deliver: ((message: unknown) => void) | undefined;
  panel.webview = {
    html: '', cspSource: 'test:', options: {}, asWebviewUri: (uri: unknown) => uri,
    postMessage: (message: unknown) => { panel.posted.push(message); deliver?.(message); return Promise.resolve(true); },
    onDidReceiveMessage: (listener: (message: unknown) => void) => { panel.receive = listener; return { dispose() {} }; },
    /** The booted page receives what is posted from now on. */
    connect: (to: (message: unknown) => void) => { deliver = to; },
  };
  Object.assign(panel, {
    onDidDispose: () => ({ dispose() {} }),
    onDidChangeViewState: () => ({ dispose() {} }),
    reveal: (...args: unknown[]) => { panel.reveals.push(args); },
    dispose() {},
  });
  panels.push(panel);
  return panel;
};
const workbenches = () => panels.filter((panel) => panel.viewType === ChatViewProvider.workbenchViewType);

/** The Workbench page, booted from the HTML the Workbench panel holds, with the host's messages both ways. */
function workbenchScreen(panel: Panel) {
  return chatScreen({
    resolveWebviewView(view: any) {
      view.webview.html = panel.webview.html;
      view.webview.onDidReceiveMessage(panel.receive);
      for (const message of panel.posted) view.webview.postMessage(message);
      panel.webview.connect((message: unknown) => view.webview.postMessage(message));
    },
  });
}

let chatProvider: any;
installActivatedExtension(host, (ready) => { chatProvider = ready.chatProvider; }, { agents: [] });

const descendants = (node: any): any[] => (Array.isArray(node?.children) ? node.children : []).flatMap((child: any) => [child, ...descendants(child)]);
const agents = () => chatProvider.currentState().agents as Array<{ id: string; name: string; role: string }>;
const config = () => (host.overrides['vscode.workspace.getConfiguration'] as (section?: string) => any)('unode');
const ran = (name: string) => executed.filter((args) => args[0] === name);
let screen: ReturnType<typeof chatScreen>;
const page = () => screen.page();
const actionButton = (action: string) => descendants(page().elements.get('transcript'))
  .find((node) => node.type === 'button' && node.dataset?.firstUseAction === action);

describe('v0.9.106 first use opens in the Workbench, through activate()', () => {
  it('a fresh installation opens the Workbench once, in the editor area, without taking the focus, on the goal box', async () => {
    await pumpWhile(() => context.globalState.get(FIRST_USE_REVEAL_HANDLED_KEY) !== true || workbenches().length === 0,
      async () => { await new Promise((resolve) => setTimeout(resolve, 5)); },
      { detail: () => `handled ${String(context.globalState.get(FIRST_USE_REVEAL_HANDLED_KEY))}; panels ${JSON.stringify(panels.map((p) => p.viewType))}` });
    const [workbench] = workbenches();
    expect(workbenches()).toHaveLength(1);
    expect(workbench.showOptions).toEqual({ viewColumn: -1, preserveFocus: true });
    expect(workbench.reveals).toEqual([]);
    // Nothing moves the cursor: the goal box is not focused, and the sidebar Chat is neither opened nor focused.
    expect(workbench.posted.filter((message: any) => message?.command === 'focusFirstUse')).toEqual([]);
    expect([...ran('unode.chat.open'), ...ran('unode.chat.focus'), ...ran('unode.openChat')]).toEqual([]);

    screen = workbenchScreen(workbench);
    await pumpWhile(() => !chatProvider.currentState().firstUse?.active, () => screen.pump());
    await screen.pump();
    expect(page().body.classList.contains('first-use')).toBe(true);
    expect(screen.transcript()).toContain('What do you want to get done?');
    // The three suggestions and the setup guide's one-line link (v0.9.106, the Owner's Q1), which only opens the guide.
    expect(descendants(page().elements.get('transcript')).filter((node) => node.type === 'button').map((node) => node.className))
      .toEqual(['fu-suggestion', 'fu-suggestion', 'fu-suggestion', 'fu-link']);
    expect((page().elements.get('input') as any).disabled).toBe(false);
    expect((page().elements.get('send') as any).disabled).toBe(false);
  });

  it('Get Started reveals the same Workbench with the focus in the goal box, also with the Workbench auto-open setting off', async () => {
    await config().update('workbench.autoOpen', false);
    const [workbench] = workbenches();
    const posted = workbench.posted.length;
    expect(await host.commands.get('unode.onboarding')!()).toBe(true);
    await screen.pump();
    expect(workbenches()).toHaveLength(1);
    expect(workbench.reveals).toEqual([[1, false]]);
    expect(workbench.posted.slice(posted).filter((message: any) => message?.command === 'focusFirstUse')).toHaveLength(1);
    expect([...ran('unode.chat.open'), ...ran('unode.chat.focus'), ...ran('unode.openChat')]).toEqual([]);
    await config().update('workbench.autoOpen', undefined);
  });

  it('the empty Team panel\'s "Start your first task" runs Get Started, which reveals the same Workbench', async () => {
    let fromPage: ((message: unknown) => void) | undefined;
    const team = host.views.get(TeamViewProvider.viewType) as TeamViewProvider;
    team.resolveWebviewView({
      visible: true,
      webview: {
        html: '', options: {}, cspSource: 'test:', asWebviewUri: (uri: unknown) => uri, postMessage: () => Promise.resolve(true),
        onDidReceiveMessage: (listener: (message: unknown) => void) => { fromPage = listener; return { dispose() {} }; },
      },
      onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }), show() {},
    } as never, undefined as never, undefined as never);
    const button = /<button class="cta" data-command="([^"]+)">Start your first task<\/button>/.exec(String((team as any)._getHtml({ cspSource: 'test:', asWebviewUri: (u: unknown) => u } as never)));
    expect(button?.[1]).toBe('getStarted');
    const [workbench] = workbenches();
    const reveals = workbench.reveals.length;
    fromPage!({ command: button![1] });
    await screen.pump();
    expect(ran('unode.onboarding')).toHaveLength(1);
    expect(workbenches()).toHaveLength(1);
    expect(workbench.reveals.slice(reveals)).toEqual([[1, false]]);
  });

  it('the goal written in the Workbench starts the team there, and the Workbench continues in the project manager\'s conversation', async () => {
    keyStored = true;
    const goal = 'List the open questions in this project.';
    for (const tier of ['premium', 'standard', 'economy'] as const) {
      scripts.set(DEFAULT_MODEL_TIERS[tier].unode, () => ({ text: 'Here are the open questions.' }));
    }
    const input = page().elements.get('input') as any;
    input.value = goal;
    page().dispatchElementEvent(input, 'input');
    await screen.sendBox();
    await pumpWhile(() => !actionButton('start-team'), () => screen.pump(),
      { detail: () => `${JSON.stringify(chatProvider.currentState().firstUse)} | ${screen.transcript()}` });
    page().dispatchElementEvent(actionButton('start-team'), 'click');
    await pumpWhile(() => !requests.some((request) => latestUser(request).includes(goal)), () => screen.pump());
    const pm = agents().find((agent) => agent.role === 'pm');
    expect(pm).toBeDefined();
    await pumpWhile(() => page().body.classList.contains('first-use'), () => screen.pump());
    expect(chatProvider.currentState().selectedAgentId).toBe(pm!.id);
    expect((page().elements.get('agent') as any).value).toBe(pm!.id);
    expect(screen.transcript()).toContain(goal);
    expect(screen.transcript()).not.toContain('What do you want to get done?');
    expect(workbenches()).toHaveLength(1);
  });
});
