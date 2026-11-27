import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * v0.9.106 (setup guide, the Owner, 2026-11-18; design §5 groups 1, 2, 3, 5, 6, 7): the setup guide through the
 * extension's real entry. The window opens with no agent and every built-in key stored, so it is an upgrade that opens
 * nothing by itself; activate() runs with only the VS Code API and the model's HTTP endpoint stood in. The guide page is
 * booted from the HTML its panel holds and driven by its own delegated clicks; the Settings and Team panels by the
 * messages their rendered buttons post. Every process start and every request is recorded. Not a native VS Code host:
 * no window, no real webview, no network; native focus, the real webview and its layout are field evidence.
 */
const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());

/** Every process start of the window, recorded; each still runs as it would. */
const started = vi.hoisted(() => [] as string[]);
function recordingChildProcess(actual: typeof import('child_process')) {
  const util = require('util') as typeof import('util');
  const wrap = (name: 'spawn' | 'execFile' | 'exec' | 'fork' | 'spawnSync' | 'execFileSync' | 'execSync') => {
    const original = (actual as any)[name];
    const wrapped = (...args: unknown[]) => { started.push(`${name} ${String(args[0])}`); return original(...args); };
    const custom = original?.[util.promisify.custom];
    if (custom) (wrapped as any)[util.promisify.custom] = (...args: unknown[]) => { started.push(`${name} ${String(args[0])}`); return custom(...args); };
    return wrapped;
  };
  const replaced = {
    spawn: wrap('spawn'), execFile: wrap('execFile'), exec: wrap('exec'), fork: wrap('fork'),
    spawnSync: wrap('spawnSync'), execFileSync: wrap('execFileSync'), execSync: wrap('execSync'),
  };
  return { ...actual, ...replaced, default: { ...actual, ...replaced } };
}
vi.mock('child_process', async (importOriginal) => recordingChildProcess(await importOriginal<typeof import('child_process')>()));
vi.mock('node:child_process', async (importOriginal) => recordingChildProcess(await importOriginal<typeof import('child_process')>()));
vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));
vi.mock('../host/postWriteDiagnosticsSettle', () => ({ POST_WRITE_DIAGNOSTICS_SETTLE_MS: 0 }));

import { FIRST_USE_RECORD_KEY } from '../firstUse/firstUseRecord';
import { FIRST_USE_REVEAL_HANDLED_KEY } from '../firstUse/installCohort';
import { RootScopedWorkspaceState } from '../state/RootScopedWorkspaceState';
import { ChatViewProvider } from '../views/ChatViewProvider';
import { SetupGuidePanel } from '../views/SetupGuidePanel';
import { context, flush, installActivatedExtension, pumpWhile, requests, workspace } from './support/activatedHarness';
import { guidePage, recordPanels, type GuidePage } from './support/setupGuidePage';
import { bootWebviewScript } from '../views/__tests__/support/webviewBoot';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const panels = recordPanels(host);
const guides = () => panels.filter((panel) => panel.viewType === SetupGuidePanel.viewType);
const workbenches = () => panels.filter((panel) => panel.viewType === ChatViewProvider.workbenchViewType);

/** The commands the window runs through VS Code. The ones the guide and its entries lead to run as registered. */
const executed: unknown[][] = [];
const ROUTED = new Set(['unode.setupGuide', 'unode.onboarding', 'unode.openAgentWorkbench', 'unode.enableCommands', 'unode.openSettings']);
host.overrides['vscode.commands.executeCommand'] = (...args: unknown[]) => {
  executed.push(args);
  const registered = host.commands.get(String(args[0]));
  if (ROUTED.has(String(args[0])) && registered) return registered(...args.slice(1));
  return (host.stub('vscode.commands.executeCommand') as (...rest: unknown[]) => unknown)(...args);
};
const ran = (name: string) => executed.filter((args) => args[0] === name);

/** The configuration and trust events, as VS Code would fire them. */
const configListeners: Array<(event: unknown) => void> = [];
const trustListeners: Array<() => void> = [];
host.overrides['vscode.workspace.onDidChangeConfiguration'] = (listener: (event: unknown) => void) => { configListeners.push(listener); return { dispose() {} }; };
host.overrides['vscode.workspace.onDidGrantWorkspaceTrust'] = (listener: () => void) => { trustListeners.push(listener); return { dispose() {} }; };

/** The model picker: the person accepts `next` (a typed model id) or cancels (undefined). */
let pickerAnswers: Array<string | undefined> = [];
let pickersShown = 0;
host.overrides['vscode.window.createQuickPick'] = () => {
  const listeners: Record<string, Array<(value?: unknown) => void>> = { accept: [], hide: [], value: [] };
  const picker: any = {
    items: [], activeItems: [], selectedItems: [], value: '', busy: false, title: '', placeholder: '',
    onDidChangeValue: (listener: () => void) => { listeners.value.push(listener); return { dispose() {} }; },
    onDidAccept: (listener: () => void) => { listeners.accept.push(listener); return { dispose() {} }; },
    onDidHide: (listener: () => void) => { listeners.hide.push(listener); return { dispose() {} }; },
    show: () => {
      pickersShown++;
      const answer = pickerAnswers.shift();
      setTimeout(() => {
        if (answer === undefined) { for (const listener of listeners.hide) listener(); return; }
        picker.value = answer;
        for (const listener of listeners.accept) listener();
      }, 0);
    },
    hide: () => { for (const listener of listeners.hide) listener(); },
    dispose() {},
  };
  return picker;
};

let chatProvider: any;
let chatScreenRef: any;
installActivatedExtension(host, (ready) => { chatProvider = ready.chatProvider; chatScreenRef = ready.screen; }, { agents: [] });

/** Every built-in key is stored, except those a flow removes; stored keys are kept. */
const storedSecrets = new Map<string, string>();
Object.assign(context.secrets, {
  get: async (name: string) => storedSecrets.get(name) ?? 'sk-test',
  store: async (name: string, value: string) => { storedSecrets.set(name, value); },
});

/** Every request the window makes, by URL. The harness's model endpoint stays behind it. */
const fetched: string[] = [];
beforeAll(() => {
  const inner = globalThis.fetch;
  vi.stubGlobal('fetch', (input: unknown, init?: unknown) => { fetched.push(String(input)); return (inner as any)(input, init); });
});

const descendants = (node: any): any[] => (Array.isArray(node?.children) ? node.children : []).flatMap((child: any) => [child, ...descendants(child)]);
const command = (name: string) => host.commands.get(name)!;
const config = () => (host.overrides['vscode.workspace.getConfiguration'] as (section?: string) => any)('unode');
/** A setting changed as VS Code changes it: the value, then the configuration event. */
async function setSetting(key: string, value: unknown) {
  await config().update(key, value);
  for (const listener of configListeners) listener({ affectsConfiguration: (section: string) => section === 'unode' || section === `unode.${key}` });
  await flush();
}
const agents = () => chatProvider.currentState().agents as Array<{ id: string; name: string; role: string }>;
const listed = () => chatProvider.deps.listAgents() as Array<{ id: string; role: string; routeLabel?: string; model?: string }>;
const record = () => new RootScopedWorkspaceState(context.workspaceState as never, workspace).get<any>(FIRST_USE_RECORD_KEY);
/** What the first-use record says about a connection, a model and a start: the guide writes none of them. */
const firstUseChoice = () => ({ connectionId: record()?.connectionId, model: record()?.model, start: record()?.start });
const userMessages = () => agents().flatMap((agent) => (chatProvider.loadHistory(agent.id) as Array<{ role: string }>).filter((message) => message.role === 'user'));

async function emptyRoster() {
  for (const agent of agents()) await command('unode.agentRemove')(agent.id);
  await pumpWhile(() => agents().length > 0, flush);
}

let guide: GuidePage;
async function openGuide(): Promise<GuidePage> {
  await command('unode.setupGuide')();
  expect(SetupGuidePanel.openSession(), 'the command opened the guide').toBeDefined();
  guide = guidePage(guides().at(-1)!);
  await pumpWhile(() => guide.views().length === 0, guide.pump);
  return guide;
}

describe('v0.9.106 the setup guide through activate()', () => {
  it('is never opened at activation; the first-task link, Settings and Team Actions open the one guide, and Start a task still opens first use', async () => {
    await pumpWhile(() => context.globalState.get(FIRST_USE_REVEAL_HANDLED_KEY) !== true, flush);
    await flush();
    expect(guides()).toEqual([]);
    // The command is in the Command Palette, under its own name.
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    expect(manifest.contributes.commands.find((entry: any) => entry.command === 'unode.setupGuide')?.title).toBe('UnodeAi: Setup Guide');
    expect(manifest.contributes.menus.commandPalette.some((entry: any) => entry.command === 'unode.setupGuide')).toBe(false);

    // The first-task screen's one line at the bottom: a link that opens the guide and does nothing else.
    const screen = chatScreenRef;
    await pumpWhile(() => !chatProvider.currentState().firstUse?.active, () => screen.pump());
    await screen.pump();
    const link = descendants(screen.page().elements.get('transcript')).find((node) => node.dataset?.setupGuide === 'open');
    expect(link?.textContent).toBe('Open the setup guide');
    expect(screen.transcript()).toMatch(/Want to set everything up first\?\s+Open the setup guide$/);
    screen.page().dispatchElementEvent(link, 'click');
    await screen.pump();
    await pumpWhile(() => guides().length === 0, () => screen.pump());
    expect(guides()).toHaveLength(1);
    expect(guides()[0].title).toBe('UnodeAi Setup Guide');
    expect(guides()[0].showOptions).toBe(-1);
    expect(agents()).toEqual([]);

    // Settings → Providers: the Setup guide button shows the same guide; the first-task button stays and opens first use.
    await command('unode.openSettings')();
    const settings = panels.find((panel) => panel.viewType === 'unodeSettings')!;
    await pumpWhile(() => !String(settings.webview.html).includes('data-command="openSetupGuide"'), flush);
    const html = String(settings.webview.html);
    const guideButton = /<button class="btn" data-command="([^"]+)"[^>]*>Setup guide<\/button>/.exec(html);
    const firstTask = /<button class="btn" data-command="([^"]+)"[^>]*>Start a task<\/button>/.exec(html);
    expect(guideButton?.[1]).toBe('openSetupGuide');
    expect(firstTask?.[1]).toBe('openSetupWizard');
    const reveals = guides()[0].reveals.length;
    await settings.receive!({ command: guideButton![1] });
    await flush();
    expect(guides()).toHaveLength(1);
    expect(guides()[0].reveals.length).toBe(reveals + 1);
    expect(ran('unode.onboarding')).toEqual([]);
    await settings.receive!({ command: firstTask![1] });
    await flush();
    expect(ran('unode.onboarding')).toHaveLength(1);
    expect(workbenches()).toHaveLength(1);
    expect(chatProvider.currentState().firstUse?.active).toBe(true);

    // Team Actions… → Setup guide… shows the same guide again.
    host.overrides['vscode.window.showQuickPick'] = vi.fn(async (items: any[]) => items.find((item) => item.target === 'unode.setupGuide'));
    await command('unode.teamActions')();
    await flush();
    expect(guides()).toHaveLength(1);
    expect(guides()[0].reveals.length).toBe(reveals + 2);
    expect(requests).toHaveLength(0);
    expect(firstUseChoice()).toEqual({ connectionId: undefined, model: undefined, start: undefined });
  });

  it('opening it, Next, Back, the steps and a configuration, trust, roster or key change start no program and make no request', async () => {
    // The guide is closed; the window settles; then a new guide opens while everything is watched.
    (guides()[0] as unknown as { dispose(): void }).dispose();
    expect(SetupGuidePanel.openSession()).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const startedBefore = started.length;
    const fetchedBefore = fetched.length;
    await openGuide();
    expect(guides()).toHaveLength(2);
    expect(guide.view().step).toBe('connections');
    await command('unode.setupGuide')();
    await guide.pump();
    for (const step of ['team', 'permissions', 'folders', 'skills', 'continue', 'connections']) {
      await guide.click('step', step);
      expect(guide.view().step).toBe(step);
    }
    for (let i = 0; i < 5; i++) await guide.click('next');
    expect(guide.view().step).toBe('continue');
    expect(guide.control('next').disabled).toBe(true);
    for (let i = 0; i < 5; i++) await guide.click('back');
    expect(guide.view().step).toBe('connections');

    // A configuration change and a trust grant redraw the open guide.
    let views = guide.views().length;
    for (const listener of configListeners) listener({ affectsConfiguration: (section: string) => section === 'unode' || section === 'unode.webAccess' });
    await pumpWhile(() => guide.views().length === views, guide.pump);
    views = guide.views().length;
    for (const listener of trustListeners) listener();
    await pumpWhile(() => guide.views().length === views, guide.pump);
    // A roster change (Solo from Team Actions) and back.
    host.overrides['vscode.window.showQuickPick'] = vi.fn(async (items: any[]) => items.find((item) => item.connectionId === 'openai'));
    await command('unode.startSolo')();
    await pumpWhile(() => agents().length === 0 || !guide.views().at(-1).steps.some((step: any) => step.id === 'team' && step.mark === 'ready'), guide.pump);
    await emptyRoster();
    await pumpWhile(() => guide.views().at(-1).steps.some((step: any) => step.id === 'team' && step.mark === 'ready'), guide.pump);
    // A key stored through the guide's own Set API key (the native prompt): the open guide shows it.
    host.overrides['vscode.window.showInputBox'] = vi.fn(async () => 'sk-entered');
    await guide.click('set-key', 'openai');
    expect(guide.outcome()).toBe('The API key for OpenAI Compatible API is stored.');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await guide.pump();

    expect(started.slice(startedBefore)).toEqual([]);
    expect(fetched.slice(fetchedBefore)).toEqual([]);
    expect(requests).toHaveLength(0);
    expect(guides()).toHaveLength(2);
    // The key never reaches the page.
    expect(JSON.stringify(guides().at(-1)!.posted) + guides().at(-1)!.webview.html).not.toMatch(/sk-entered|sk-test/);
  });

  it('step 3 shows an explicit Off as Off and asks nothing; Enable commands for this project and Set as default act only when pressed', async () => {
    await setSetting('commandApproval', 'none');
    host.infos.length = 0;
    host.warnings.length = 0;
    await guide.click('step', 'permissions');
    expect(guide.text()).toContain('In effect here: Off.');
    expect(guide.text()).toContain('Default: Automatic. Your setting: Off.');
    expect(guide.text()).toContain('Agents cannot run shell commands.');
    expect(guide.text()).toContain('No review for each write.');
    expect(guide.text()).toContain('This is not the same as commands Off.');
    expect(guide.control('enable-commands')).toBeDefined();
    expect([...host.infos, ...host.warnings].filter((text) => /command/i.test(text))).toEqual([]);
    expect(ran('unode.enableCommands')).toEqual([]);

    // Pressed: the existing confirmation asks, and the person enables commands for this project. The setting stays Off.
    const asked: string[] = [];
    host.overrides['vscode.window.showInformationMessage'] = vi.fn(async (text: string) => { asked.push(String(text)); return 'Enable Command Execution'; });
    await guide.click('enable-commands');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Enable command execution?');
    expect(guide.outcome()).toBe('Commands for this project: Ask each.');
    expect(guide.text()).toContain('In effect here: Ask each. Your setting is Off; this project enabled commands, so each one asks first.');
    expect(guide.control('enable-commands')).toBeUndefined();
    expect(config().get('commandApproval')).toBe('none');
    host.overrides['vscode.window.showInformationMessage'] = vi.fn(async (text: string) => { host.infos.push(String(text)); return undefined; });
    await setSetting('commandApproval', undefined);

    // Set as default: navigating changed nothing; the button changes the default for new agents, and only that.
    await guide.click('step', 'connections');
    expect(config().inspect('defaultProvider')?.globalValue).toBeUndefined();
    await guide.click('set-default', 'openai');
    expect(config().get('defaultProvider')).toBe('openai');
    expect(guide.outcome()).toBe('OpenAI Compatible API is now the default connection for new agents.');
    expect(guide.control('set-default', 'openai')).toBeUndefined();
    await setSetting('defaultProvider', undefined);
    expect(agents()).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  let gatewayId = '';
  it('a custom gateway with a key and no model: the guide lists it, the model is chosen in the guide, and the starter team lands on it, sending nothing', async () => {
    // Add custom gateway: the existing native prompts and its confirmation.
    const answers = ['Team Gateway', 'https://gateway.example.test/v1', 'sk-gw-secret'];
    host.overrides['vscode.window.showInputBox'] = vi.fn(async () => answers.shift());
    host.overrides['vscode.window.showInformationMessage'] = vi.fn(async (text: string) => {
      host.infos.push(String(text));
      return String(text).startsWith('Create Team Gateway at') ? 'Create gateway' : undefined;
    });
    host.overrides['vscode.window.showQuickPick'] = vi.fn(async () => undefined);
    await guide.click('add-gateway');
    expect(guide.outcome()).toBe('Team Gateway was added. Choose it below for a new team, or set it as the default.');
    await pumpWhile(() => !guide.text().includes('Team Gateway'), guide.pump);
    expect(guide.text()).toContain('Team Gateway Custom gateway · API key set');
    // Not filtered by readiness: the gateway without a model is offered for a new team.
    gatewayId = guide.options().find((option) => option.text.startsWith('Team Gateway'))!.value;
    expect(gatewayId).toMatch(/^custom:/);
    await guide.choose(gatewayId);
    expect(SetupGuidePanel.openSession()!.creationChoice()).toEqual({ connectionId: gatewayId });
    expect(guide.text()).toContain('Model: not chosen yet');

    // Check readiness: the gateway needs a model; the card's Choose a model is the gateway's own model picker.
    await guide.click('check');
    expect(guide.text()).toContain('Choose a model on Team Gateway');
    pickerAnswers = [undefined];
    await guide.click('repair');
    expect(guide.outcome()).toBe('Cancelled. The model was not changed.');
    expect(SetupGuidePanel.openSession()!.creationChoice()).toEqual({ connectionId: gatewayId });
    expect(agents()).toEqual([]);
    pickerAnswers = ['gw-model-a'];
    await guide.click('repair');
    expect(SetupGuidePanel.openSession()!.creationChoice()).toEqual({ connectionId: gatewayId, model: 'gw-model-a' });
    expect(guide.text()).toContain('Team Gateway is ready');

    // Create: on the chosen connection and model, with no second picker and no post-create prompt.
    await guide.click('step', 'team');
    const shown = pickersShown;
    host.infos.length = 0;
    host.warnings.length = 0;
    await guide.click('create-team');
    expect(pickersShown).toBe(shown);
    expect(agents().map((agent) => agent.role).sort()).toEqual(['custom', 'pm', 'reviewer', 'solo']);
    expect(new Set(listed().map((agent) => agent.routeLabel))).toEqual(new Set(['Team Gateway']));
    expect(new Set(listed().map((agent) => agent.model))).toEqual(new Set(['gw-model-a']));
    expect(guide.outcome()).toMatch(/^Created on Team Gateway: .+\. No task was sent\.$/);
    for (const agent of agents()) expect(guide.outcome()).toContain(agent.name);
    expect([...host.infos, ...host.warnings].filter((text) => /Team created|API key|Enable command|commands/i.test(text))).toEqual([]);
    // Nothing else changed: no default, no first-use connection, model or start, no task.
    expect(config().inspect('defaultProvider')?.globalValue).toBeUndefined();
    expect(firstUseChoice()).toEqual({ connectionId: undefined, model: undefined, start: undefined });
    expect(requests).toHaveLength(0);
    expect(userMessages()).toEqual([]);
    expect(guide.text()).toContain('Your team.');
  });

  it('with no model chosen in the guide, the gateway\'s picker asks at creation: cancelling creates nothing, a model creates the team on it', async () => {
    await emptyRoster();
    await pumpWhile(() => !guide.control('create-team'), guide.pump);
    // Another connection and back: the model belonged to the earlier choice.
    await guide.choose('openai');
    await guide.choose(gatewayId);
    expect(SetupGuidePanel.openSession()!.creationChoice()).toEqual({ connectionId: gatewayId });
    pickerAnswers = [undefined];
    const shown = pickersShown;
    await guide.click('create-team');
    expect(pickersShown).toBe(shown + 1);
    expect(guide.outcome()).toBe('Cancelled: no model was chosen, so no agents were created.');
    expect(agents()).toEqual([]);
    pickerAnswers = ['gw-model-b'];
    await guide.click('create-team');
    expect(agents().map((agent) => agent.role).sort()).toEqual(['custom', 'pm', 'reviewer', 'solo']);
    expect(new Set(listed().map((agent) => agent.model))).toEqual(new Set(['gw-model-b']));
    expect(new Set(listed().map((agent) => agent.routeLabel))).toEqual(new Set(['Team Gateway']));
    expect(config().inspect('defaultProvider')?.globalValue).toBeUndefined();
    expect(firstUseChoice()).toEqual({ connectionId: undefined, model: undefined, start: undefined });
    expect(requests).toHaveLength(0);
    expect(userMessages()).toEqual([]);
  });

  it('Continue in Workbench selects the project manager although another member is selected, and admits no task', async () => {
    const pm = agents().find((agent) => agent.role === 'pm')!;
    const reviewer = agents().find((agent) => agent.role === 'reviewer')!;
    chatProvider.selectAgent(reviewer.id);
    expect(chatProvider.currentState().selectedAgentId).toBe(reviewer.id);
    await guide.click('step', 'continue');
    expect(guide.text()).toContain(`This opens the conversation of ${pm.name} in the Workbench. Nothing is sent`);
    await guide.click('continue');
    expect(ran('unode.openAgentWorkbench').at(-1)).toEqual(['unode.openAgentWorkbench', pm.id]);
    expect(chatProvider.currentState().selectedAgentId).toBe(pm.id);
    expect(workbenches()).toHaveLength(1);
    expect(guide.outcome()).toBe(`The Workbench opened on the conversation of ${pm.name}. Nothing was sent.`);
    expect(requests).toHaveLength(0);
    expect(userMessages()).toEqual([]);
  });

  // Codex's design PASS R2, note (b): the existing hand-over of an unsent goal stays; the guide adds no first-use write.
  it('a goal already written on the first-task screen moves to the new team unsent; the guide writes no connection, model or start of first use', async () => {
    await emptyRoster();
    const screen = chatScreenRef;
    await pumpWhile(() => !chatProvider.currentState().firstUse?.active, () => screen.pump());
    const input = screen.page().elements.get('input') as any;
    input.value = 'Plan the next release.';
    screen.page().dispatchElementEvent(input, 'input');
    screen.page().dispatchElementEvent(input, 'blur');
    await pumpWhile(() => record()?.text !== 'Plan the next release.', () => screen.pump());
    await guide.click('step', 'team');
    await guide.choose('openai');
    await guide.click('create-team');
    const pm = agents().find((agent) => agent.role === 'pm')!;
    expect(pm).toBeDefined();
    expect(new Set(listed().map((agent) => agent.routeLabel))).toEqual(new Set(['OpenAI Compatible API']));
    // First use's own lifecycle: the goal is handed to the project manager, or already put into its message box.
    await pumpWhile(() => record()?.handover?.agentId !== pm.id && record()?.text !== '', () => screen.pump());
    expect(firstUseChoice()).toEqual({ connectionId: undefined, model: undefined, start: undefined });
    expect(requests).toHaveLength(0);
    expect(userMessages()).toEqual([]);
    expect(config().inspect('defaultProvider')?.globalValue).toBeUndefined();
  });

  it('with Solo alone, Continue in Workbench selects Solo and admits no task', async () => {
    await emptyRoster();
    await guide.click('step', 'team');
    await guide.choose('openai');
    await guide.click('create-solo');
    expect(agents().map((agent) => agent.role)).toEqual(['solo']);
    expect(listed()[0].routeLabel).toBe('OpenAI Compatible API');
    const solo = agents()[0];
    await guide.click('step', 'continue');
    expect(guide.text()).toContain(`This opens the conversation of ${solo.name} in the Workbench.`);
    await guide.click('continue');
    expect(ran('unode.openAgentWorkbench').at(-1)).toEqual(['unode.openAgentWorkbench', solo.id]);
    expect(chatProvider.currentState().selectedAgentId).toBe(solo.id);
    expect(requests).toHaveLength(0);
    expect(userMessages()).toEqual([]);
    expect(config().inspect('defaultProvider')?.globalValue).toBeUndefined();
  });

  it('refuses forged ids, actions, fields and setting keys, and never shows a key', async () => {
    const panel = guides().at(-1)!;
    const choiceBefore = SetupGuidePanel.openSession()!.creationChoice();
    const executedBefore = executed.length;
    const inputs = vi.fn(async () => 'sk-forged');
    host.overrides['vscode.window.showInputBox'] = inputs;
    const forged: unknown[] = [
      { command: 'action', action: 'set-default', id: 'custom:forged' },
      { command: 'action', action: 'set-key', id: 'custom:forged' },
      { command: 'action', action: 'set-key', id: gatewayId },
      { command: 'action', action: 'select-connection', id: 'custom:forged' },
      { command: 'action', action: 'edit-agent', id: 'not-an-agent' },
      { command: 'action', action: 'open-agent-chat', id: 'not-an-agent' },
      { command: 'action', action: 'open-setting', id: 'unode.claudeCliPath' },
      { command: 'action', action: 'open-setting', id: '__proto__' },
      { command: 'action', action: 'open-setting', id: 'toString' },
      { command: 'action', action: 'run', id: 'workbench.action.terminal.new' },
      { command: 'executeCommand', target: 'unode.agentRemove' },
      { command: 'action', action: 'continue', target: 'unode.agentRemove' },
      { command: 'action', action: 'create-team', roles: ['pm'] },
      { command: 'action', action: 'test-connection', id: 'openai', secretName: 'OPENAI_API_KEY' },
      { command: 'action', action: 'enable-commands' },
    ];
    for (const message of forged) {
      await panel.receive!(message);
      await flush(2);
    }
    await guide.pump();
    expect(executed.slice(executedBefore)).toEqual([]);
    expect(inputs).not.toHaveBeenCalled();
    expect(config().inspect('defaultProvider')?.globalValue).toBeUndefined();
    expect(SetupGuidePanel.openSession()!.creationChoice()).toEqual(choiceBefore);
    expect(agents().map((agent) => agent.role)).toEqual(['solo']);
    expect(guide.outcome()).toBe('That action does not apply to what is shown now. The page shows the current state.');
    // Keys and their names never reach the page.
    const page = JSON.stringify(panel.posted) + panel.webview.html;
    expect(page).not.toMatch(/sk-test|sk-gw-secret|sk-entered|sk-forged|_API_KEY/);
    expect(requests).toHaveLength(0);
  });
  it('v107 stages row-level CLI models through the guide and creates the mixed stopped team without starting programs or requests', async () => {
    await emptyRoster(); await openGuide(); await guide.click('step', 'team'); await guide.choose('unode');
    const startedBefore = started.length; const fetchedBefore = fetched.length; const firstBefore = firstUseChoice();
    const priorPanels = panels.length; const editing = guide.click('configure-roles');
    await pumpWhile(() => !panels.slice(priorPanels).some(panel => panel.viewType === 'unode.teamConnections'), flush);
    const editor = panels.slice(priorPanels).find(panel => panel.viewType === 'unode.teamConnections')!;
    const page = bootWebviewScript(editor.webview.html); const rows = page.elements.get('roles')!.children as any[];
    rows[0].children[1].value = 'claude-cli'; rows[0].children[2].value = 'pm-user-model';
    rows[2].children[1].value = 'codex-cli'; rows[2].children[2].value = 'reviewer-user-model';
    const previousPicker = host.overrides['vscode.window.showQuickPick']; const localPicker = vi.fn(async (items: any[]) => items[0]);
    host.overrides['vscode.window.showQuickPick'] = localPicker;
    try {
      page.dispatchElementEvent(rows[0].children[3], 'click'); await editor.receive!(page.postedMessages.at(-1));
      for (const message of editor.posted) for (const listener of page.listeners.message ?? []) listener({ data: message });
      expect(localPicker).toHaveBeenCalledOnce(); expect(String(rows[0].children[2].value)).not.toBe('');
      expect(localPicker.mock.calls[0][0].every((item: any) => item.model && item.label === item.model)).toBe(true);
    } finally { host.overrides['vscode.window.showQuickPick'] = previousPicker; }
    rows[0].children[2].value = 'pm-user-model';
    page.dispatchElementEvent(page.elements.get('save')!, 'click'); await editor.receive!(page.postedMessages.at(-1)); await editing;
    expect(agents()).toEqual([]); expect(guide.text()).toContain('pm-user-model'); expect(guide.text()).toContain('reviewer-user-model');
    expect(started.slice(startedBefore)).toEqual([]); expect(fetched.slice(fetchedBefore)).toEqual([]);
    await guide.click('create-team'); await guide.pump();
    expect(listed().find(agent => agent.role === 'pm')?.model).toBe('pm-user-model');
    expect(listed().find(agent => agent.role === 'reviewer')?.model).toBe('reviewer-user-model');
    expect(agents()).toHaveLength(4); expect(userMessages()).toEqual([]);
    expect(started.slice(startedBefore)).toEqual([]); expect(fetched.slice(fetchedBefore)).toEqual([]);
    expect(firstUseChoice()).toEqual(firstBefore);
    await emptyRoster();
  });
});
