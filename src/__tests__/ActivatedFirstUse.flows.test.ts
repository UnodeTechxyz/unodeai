import { describe, expect, it, vi } from 'vitest';

/**
 * v0.9.106 (first use, Owner 2026-11-17; design §9 N2/N3): the first goal through the extension's real entry. The window
 * opens with no agent; activate() runs with only the VS Code API and the model's HTTP endpoint stood in. The person
 * works on the Chat page booted from the HTML the chat view serves: types a goal, presses Send, then a start button.
 * Not a native VS Code host: no window, no real webview, no network. The native reveal, focus, keyboard and widths are
 * N4 field evidence.
 */
const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());

vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));
vi.mock('../host/postWriteDiagnosticsSettle', () => ({ POST_WRITE_DIAGNOSTICS_SETTLE_MS: 0 }));

import { DEFAULT_MODEL_TIERS } from '../roles/RoleConfig';
import { FIRST_USE_RECORD_KEY } from '../firstUse/firstUseRecord';
import { FIRST_USE_REVEAL_HANDLED_KEY } from '../firstUse/installCohort';
import { ChatViewProvider } from '../views/ChatViewProvider';
import {
  chatScreen, context, installActivatedExtension, latestUser, pumpWhile, requests, scripts, workspace,
} from './support/activatedHarness';
import { RootScopedWorkspaceState } from '../state/RootScopedWorkspaceState';
import { secretStorageKey } from '../secrets/secretStorageKey';
import { TeamViewProvider } from '../views/TeamViewProvider';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * v0.9.106 (the Owner, 2026-11-18): what the window runs and opens, recorded; the stand-ins answer as before. A stored
 * key makes this window an upgrade, which opens nothing by itself (a fresh installation:
 * ActivatedFirstUse.workbench.flows.test.ts).
 */
const executed: unknown[][] = [];
host.overrides['vscode.commands.executeCommand'] = (...args: unknown[]) => {
  executed.push(args);
  return (host.stub('vscode.commands.executeCommand') as (...rest: unknown[]) => unknown)(...args);
};
const panelsOpened: string[] = [];
host.overrides['vscode.window.createWebviewPanel'] = (...args: unknown[]) => {
  panelsOpened.push(String(args[0]));
  return (host.stub('vscode.window.createWebviewPanel') as (...rest: unknown[]) => unknown)(...args);
};
const chatOpenings = () => executed.filter((args) => ['unode.chat.open', 'unode.chat.focus', 'unode.openChat'].includes(String(args[0])));
const workbenchesOpened = () => panelsOpened.filter((viewType) => viewType === ChatViewProvider.workbenchViewType);

let screen: ReturnType<typeof chatScreen>;
let chatProvider: any;
installActivatedExtension(host, (ready) => { chatProvider = ready.chatProvider; screen = ready.screen; }, { agents: [] });

/** The secrets the window sees: every key present, except those a flow removes; stored keys are kept. */
const missingSecrets = new Set<string>();
const storedSecrets = new Map<string, string>();
Object.assign(context.secrets, {
  get: async (name: string) => storedSecrets.get(name) ?? (missingSecrets.has(name) ? undefined : 'sk-test'),
  store: async (name: string, value: string) => { storedSecrets.set(name, value); },
});

const descendants = (node: any): any[] => (Array.isArray(node?.children) ? node.children : []).flatMap((child: any) => [child, ...descendants(child)]);
const page = () => screen.page();
const transcriptNodes = () => descendants(page().elements.get('transcript'));
const buttons = () => transcriptNodes().filter((node) => node.type === 'button');
const actionButton = (action: string) => buttons().find((node) => node.dataset?.firstUseAction === action);
const input = () => page().elements.get('input') as any;
const record = () => new RootScopedWorkspaceState(context.workspaceState as never, workspace).get<any>(FIRST_USE_RECORD_KEY);
const agents = () => chatProvider.currentState().agents as Array<{ id: string; name: string; role: string }>;
const command = (name: string) => host.commands.get(name)!;
const config = () => (host.overrides['vscode.workspace.getConfiguration'] as (section?: string) => any)('unode');
/** The Team panel's page as the Team view serves it now. */
const teamHtml = () => String((host.views.get(TeamViewProvider.viewType) as any)._getHtml({ cspSource: 'test:', asWebviewUri: (u: unknown) => u }));
/** The stale reference-price reminder (SpendHost); it is recorded in globalState only when it is shown. */
const staleReminders = () => host.infos.filter((text) => /reference prices UnodeAi shows were captured .* are now stale/.test(text));
const STALE_REMINDED_KEY = 'unode.spend.staleReferenceRemindedAt';

async function typeGoal(text: string) {
  await screen.pump();
  input().value = text;
  page().dispatchElementEvent(input(), 'input');
  page().dispatchElementEvent(input(), 'blur');
  await screen.pump();
}

async function press(action: string) {
  await screen.pump();
  const button = actionButton(action);
  expect(button, `the ${action} control is on the page`).toBeDefined();
  page().dispatchElementEvent(button, 'click');
  await screen.pump();
}

async function emptyRoster() {
  for (const agent of agents()) await command('unode.agentRemove')(agent.id);
  await pumpWhile(() => agents().length > 0 || !chatProvider.currentState().firstUse?.active, () => screen.pump());
}

const modelRequestsWith = (text: string) => requests.filter((request) => latestUser(request).includes(text));

describe('v0.9.106 first use through activate()', () => {
  it('an upgrade with no agent opens nothing by itself: no Workbench, no sidebar Chat', async () => {
    await pumpWhile(() => context.globalState.get(FIRST_USE_REVEAL_HANDLED_KEY) !== true, () => screen.pump());
    await screen.pump();
    expect(workbenchesOpened()).toEqual([]);
    expect(chatOpenings()).toEqual([]);
  });

  it('with no agent the Chat shows only the goal box: heading, one line, three suggestions, the input and Send', async () => {
    await pumpWhile(() => !chatProvider.currentState().firstUse?.active, () => screen.pump());
    const state = chatProvider.currentState();
    expect(state.repair).toBeUndefined();
    expect(page().body.classList.contains('first-use')).toBe(true);
    expect(screen.transcript()).toContain('What do you want to get done?');
    expect(screen.transcript()).not.toContain('Create a team to start working');
    // The only controls in the transcript are the three suggestions and the setup guide's one-line link (v0.9.106, the
    // Owner's Q1), which only opens the guide; nothing starts the task yet.
    expect(buttons().map((node) => node.className)).toEqual(['fu-suggestion', 'fu-suggestion', 'fu-suggestion', 'fu-link']);
    expect(buttons().at(-1)?.dataset?.setupGuide).toBe('open');

    expect(input().disabled).toBe(false);
    expect((page().elements.get('send') as any).disabled).toBe(false);
    // The page hides every other control of the Chat while no agent exists.
    const html = String(chatProvider.getHtml({ cspSource: 'test:', asWebviewUri: (u: unknown) => u }));
    for (const control of ['.topbar', '#sessionSummary', '#autonomyControl', '#commandApprovalControl', '#writeApprovalControl',
      '#codexPermissionControl', '#ctxCompact', '#attach']) {
      expect(html, control).toContain(`body.first-use ${control}`);
    }
  });

  it('with no agent the Team panel has no Status key, and no stale reference-price reminder appears', async () => {
    expect(teamHtml()).toContain('No agents in your team yet.');
    expect(teamHtml()).not.toContain('Status key');
    // The reminder's check runs one view refresh (300 ms) after the roster is restored; give it well over that.
    const until = Date.now() + 1_500;
    await pumpWhile(() => Date.now() < until, () => screen.pump());
    expect(staleReminders(), JSON.stringify(host.infos)).toEqual([]);
    expect(context.globalState.get(STALE_REMINDED_KEY)).toBeUndefined();
  });

  it('Get Started and Open Chat open the goal box instead of asking for a team first; Get Started opens it in the Workbench', async () => {
    host.infos.length = 0;
    expect(await command('unode.onboarding')()).toBe(true);
    expect(workbenchesOpened()).toHaveLength(1);
    expect(chatOpenings()).toEqual([]);
    await command('unode.openChat')();
    // The Workbench is open: Open Chat reveals it, and no second one opens.
    expect(workbenchesOpened()).toHaveLength(1);
    await screen.pump();
    expect(host.infos.filter((text) => /No agents yet|Create a team first/.test(text))).toEqual([]);
    expect(chatProvider.currentState().firstUse?.active).toBe(true);
    expect(agents()).toEqual([]);
  });

  it('the goal is kept by the host and a reloaded page shows it again; a suggestion only fills the box', async () => {
    await screen.pump();
    const suggestion = buttons().find((node) => node.className === 'fu-suggestion');
    page().dispatchElementEvent(suggestion, 'click');
    await screen.pump();
    expect(input().value).toBe(suggestion.textContent);
    expect(requests).toHaveLength(0);
    await typeGoal('Summarise the open issues in this project.');
    expect(record()).toMatchObject({ text: 'Summarise the open issues in this project.' });
    // The page reloads: a new page booted from what the chat view serves now.
    screen = chatScreen(chatProvider);
    await screen.pump();
    expect(input().value).toBe('Summarise the open issues in this project.');
    expect(agents()).toEqual([]);
  });

  it('a different connection: the starter team lands on it, the PM gets the goal once, nothing asks afterwards; then the normal Chat returns', async () => {
    const goal = 'Summarise the open issues in this project.';
    scripts.set(DEFAULT_MODEL_TIERS.premium.openai, () => ({ text: 'Here is the summary.' }));
    host.infos.length = 0;
    host.warnings.length = 0;
    await screen.sendBox();
    await pumpWhile(() => !actionButton('start-team'), () => screen.pump());
    expect(actionButton('repair')).toBeUndefined();
    expect(agents()).toEqual([]);
    expect(requests).toHaveLength(0);
    // "Use a different connection": the existing picker; this goal's connection only.
    host.overrides['vscode.window.showQuickPick'] = vi.fn(async (items: any[]) => items.find((item) => item.connectionId === 'openai'));
    await press('change-connection');
    await pumpWhile(() => !actionButton('start-team'), () => screen.pump());
    expect(screen.transcript()).toContain('Connection: OpenAI Compatible API');
    // Two clicks: one start.
    const start = actionButton('start-team');
    page().dispatchElementEvent(start, 'click');
    page().dispatchElementEvent(start, 'click');
    await pumpWhile(() => modelRequestsWith(goal).length === 0, () => screen.pump());
    const team = agents();
    expect(team.map((agent) => agent.role).sort()).toEqual(['custom', 'pm', 'reviewer', 'solo']);
    const routes = chatProvider.deps.listAgents().map((agent: any) => agent.routeLabel);
    expect(new Set(routes)).toEqual(new Set(['OpenAI Compatible API']));
    expect(modelRequestsWith(goal).map((request) => request.model)).toEqual([DEFAULT_MODEL_TIERS.premium.openai]);
    expect(config().inspect('defaultProvider')?.globalValue).toBeUndefined();
    expect(record()).toMatchObject({ text: '', start: { phase: 'accepted', kind: 'team', connectionId: 'openai' } });
    // The admitted message carries the start's request identity; that, not its text, is what a reload looks for.
    const pm = team.find((agent) => agent.role === 'pm')!;
    const requestId = record().start.requestId as string;
    expect(requestId).toBe(`first-use:${record().start.startId}`);
    expect(chatProvider.loadHistory(pm.id).filter((message: any) => message.role === 'user').map((message: any) => [message.text, message.requestId]))
      .toEqual([[goal, requestId]]);
    expect(chatProvider.hasAdmittedRequest(pm.id, requestId)).toBe(true);
    expect(chatProvider.hasAdmittedRequest(pm.id, 'first-use:another-start')).toBe(false);
    // No post-create prompts: no key prompt, no "Send the PM a task", no command-enablement question.
    expect([...host.infos, ...host.warnings].filter((text) => /Team created|API key|Enable command|commands/i.test(text))).toEqual([]);
    // An agent exists: the normal Chat, with nothing of first use.
    await screen.pump();
    expect(chatProvider.currentState().firstUse).toBeUndefined();
    expect(page().body.classList.contains('first-use')).toBe(false);
    expect(screen.transcript()).not.toContain('What do you want to get done?');
    // The Team panel shows its Status key again, unchanged. The stale reference-price reminder waits for the next
    // window that opens with an agent (ActivatedExtension.checks.flows.test.ts): it does not interrupt this first task.
    expect(teamHtml()).toContain('<summary>Status key</summary>');
    expect(teamHtml()).toContain('Denied — timed out (⌛)');
    expect(staleReminders()).toEqual([]);
    expect(context.globalState.get(STALE_REMINDED_KEY)).toBeUndefined();
  });

  it('a missing key: one repair card, the key is set, the start buttons appear, and only the Solo button starts, also untrusted with commands Off', async () => {
    await emptyRoster();
    const goal = 'List the files that changed this week.';
    await config().update('defaultProvider', 'unode');
    await config().update('commandApproval', 'none');
    missingSecrets.add(secretStorageKey('UNODE_API_KEY'));
    host.overrides['vscode.workspace.isTrusted'] = false;
    scripts.set(DEFAULT_MODEL_TIERS.standard.unode, () => ({ text: 'Two files changed.' }));
    await typeGoal(goal);
    // The goal box keeps the connection chosen for the first goal (OpenAI, ready); this goal goes back to Unode.
    await screen.sendBox();
    await pumpWhile(() => !actionButton('start-team'), () => screen.pump());
    expect(screen.transcript()).toContain('Connection: OpenAI Compatible API');
    host.overrides['vscode.window.showQuickPick'] = vi.fn(async (items: any[]) => items.find((item) => item.connectionId === 'unode'));
    await press('change-connection');
    await pumpWhile(() => !actionButton('repair'), () => screen.pump(), { detail: () => `${JSON.stringify(chatProvider.currentState().firstUse)} | ${screen.transcript()}` });
    expect(screen.transcript()).toContain('Unode needs an API key');

    expect(actionButton('start-team')).toBeUndefined();
    expect(actionButton('change-connection')).toBeDefined();
    const answers = ['sk-entered', ''];
    host.overrides['vscode.window.showInputBox'] = vi.fn(async () => answers.shift());
    host.warnings.length = 0;
    await press('repair');
    await pumpWhile(() => !actionButton('start-solo'), () => screen.pump());
    expect(storedSecrets.get(secretStorageKey('UNODE_API_KEY'))).toBe('sk-entered');
    expect(agents()).toEqual([]);
    expect(modelRequestsWith(goal)).toHaveLength(0);
    const solo = actionButton('start-solo');
    page().dispatchElementEvent(solo, 'click');
    page().dispatchElementEvent(solo, 'click');
    await pumpWhile(() => modelRequestsWith(goal).length === 0, () => screen.pump());
    expect(agents().map((agent) => agent.role)).toEqual(['solo']);
    expect(modelRequestsWith(goal).map((request) => request.model)).toEqual([DEFAULT_MODEL_TIERS.standard.unode]);
    // Explicit Off stays Off, and nothing asked to relax it.
    expect(config().get('commandApproval')).toBe('none');
    expect(host.warnings.filter((text) => /command/i.test(text))).toEqual([]);
    host.overrides['vscode.workspace.isTrusted'] = true;
    missingSecrets.clear();
    await config().update('commandApproval', undefined);
  });

  it('a single agent added outside the goal box takes the unsent goal into its message box, unsent', async () => {
    await emptyRoster();
    // The person works in the sidebar Chat: the Workbench tab is closed (the stand-in panel has no close event) and is
    // not opened again. A hand-over goes to the page that is shown.
    await config().update('workbench.autoOpen', false);
    chatProvider.workbenchPanel = undefined;
    const goal = 'Plan the next release.';
    await typeGoal(goal);
    const before = requests.length;
    // The person adds one agent another way (here Solo from the Team panel's title bar) before starting the goal.
    host.overrides['vscode.window.showQuickPick'] = vi.fn(async (items: any[]) => items.find((item) => item.connectionId === 'openai'));
    await command('unode.startSolo')();
    await pumpWhile(() => agents().length === 0 || input().value !== goal, () => screen.pump(),
      { detail: () => `agents ${agents().length}; box "${input().value}"; first use ${JSON.stringify(chatProvider.currentState().firstUse)}` });
    const solo = agents().find((agent) => agent.role === 'solo');
    expect(chatProvider.currentState().selectedAgentId).toBe(solo?.id);
    await pumpWhile(() => record()?.text !== '', () => screen.pump());
    expect(requests.slice(before).filter((request) => latestUser(request).includes(goal))).toEqual([]);
    expect(chatProvider.currentState().firstUse).toBeUndefined();
  });
});
