import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as path from 'path';

/**
 * v0.9.106 (setup guide, design §5 group 4 and Q2): the readiness check and its repairs, taken out of first use into
 * the shared readiness service, through the extension's real entry. The Claude CLI the person chose is a real file;
 * only its starts are redirected, at the child-process boundary, to a local stand-in that answers `--version` and
 * `auth status --json` as Claude Code does, signed out or signed in as the flow sets it. No answer of "ready" is
 * injected: the extension's own probes run and read the stand-in's output. The login terminal is the VS Code terminal
 * boundary, recorded. Every process start of the window is recorded too.
 *
 * Windows only, as the other activation flows that start a CLI program: the program is a `.exe` path.
 */
const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());

const cli = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const nodeOs = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const folder = nodeFs.realpathSync.native(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'unode-guide-cli-')));
  const claudeExe = nodePath.join(folder, 'claude.exe');
  nodeFs.writeFileSync(claudeExe, 'not a real program: its starts run the stand-in below');
  const control = nodePath.join(folder, 'control.json');
  nodeFs.writeFileSync(control, JSON.stringify({ loggedIn: false }));
  const standIn = nodePath.join(folder, 'claude-stand-in.cjs');
  nodeFs.writeFileSync(standIn, [
    "const fs = require('fs');",
    'const [control, ...args] = process.argv.slice(2);',
    "const state = JSON.parse(fs.readFileSync(control, 'utf8'));",
    "if (args[0] === '--version') { process.stdout.write('2.1.326 (Claude Code)\\n'); process.exit(0); }",
    "if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write(JSON.stringify({ loggedIn: state.loggedIn }) + '\\n'); process.exit(0); }",
    'process.exit(2);',
  ].join('\n'));
  return { folder, claudeExe, control, standIn, starts: [] as string[][], started: [] as string[] };
});

/** Every process start is recorded; only the chosen Claude program's starts go to the stand-in. */
function routedChildProcess(actual: typeof import('child_process')) {
  const util = require('util') as typeof import('util');
  const isClaude = (command: unknown) => typeof command === 'string' && path.resolve(command).toLowerCase() === cli.claudeExe.toLowerCase();
  const record = (name: string) => {
    const original = (actual as any)[name];
    const wrapped = (...args: unknown[]) => { cli.started.push(`${name} ${String(args[0])}`); return original(...args); };
    const custom = original?.[util.promisify.custom];
    if (custom) (wrapped as any)[util.promisify.custom] = (...args: unknown[]) => { cli.started.push(`${name} ${String(args[0])}`); return custom(...args); };
    return wrapped;
  };
  const spawn = ((command: string, args?: readonly string[] | object, options?: object) => {
    cli.started.push(`spawn ${String(command)}`);
    if (!isClaude(command)) return (actual.spawn as any)(command, args, options);
    const argv = Array.isArray(args) ? [...args] : [];
    cli.starts.push(argv);
    const opts = Array.isArray(args) ? options : args;
    return actual.spawn(process.execPath, [cli.standIn, cli.control, ...argv], { ...(opts as object ?? {}), shell: false } as any);
  }) as typeof actual.spawn;
  const replaced = {
    spawn, execFile: record('execFile'), exec: record('exec'), fork: record('fork'),
    spawnSync: record('spawnSync'), execFileSync: record('execFileSync'), execSync: record('execSync'),
  };
  return { ...actual, ...replaced, default: { ...actual, ...replaced } };
}
vi.mock('child_process', async (importOriginal) => routedChildProcess(await importOriginal<typeof import('child_process')>()));
vi.mock('node:child_process', async (importOriginal) => routedChildProcess(await importOriginal<typeof import('child_process')>()));
vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));
vi.mock('../host/postWriteDiagnosticsSettle', () => ({ POST_WRITE_DIAGNOSTICS_SETTLE_MS: 0 }));

import * as fs from 'fs';
import { FIRST_USE_RECORD_KEY } from '../firstUse/firstUseRecord';
import { FIRST_USE_REVEAL_HANDLED_KEY } from '../firstUse/installCohort';
import { RootScopedWorkspaceState } from '../state/RootScopedWorkspaceState';
import { SetupGuidePanel } from '../views/SetupGuidePanel';
import { base, context, flush, installActivatedExtension, pumpWhile, requests, workspace } from './support/activatedHarness';
import { guidePage, recordPanels, type GuidePage } from './support/setupGuidePage';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const panels = recordPanels(host);
const guides = () => panels.filter((panel) => panel.viewType === SetupGuidePanel.viewType);

const executed: unknown[][] = [];
const ROUTED = new Set(['unode.setupGuide', 'unode.openSettings']);
host.overrides['vscode.commands.executeCommand'] = (...args: unknown[]) => {
  executed.push(args);
  const registered = host.commands.get(String(args[0]));
  if (ROUTED.has(String(args[0])) && registered) return registered(...args.slice(1));
  return (host.stub('vscode.commands.executeCommand') as (...rest: unknown[]) => unknown)(...args);
};
const configListeners: Array<(event: unknown) => void> = [];
const trustListeners: Array<() => void> = [];
host.overrides['vscode.workspace.onDidChangeConfiguration'] = (listener: (event: unknown) => void) => { configListeners.push(listener); return { dispose() {} }; };
host.overrides['vscode.workspace.onDidGrantWorkspaceTrust'] = (listener: () => void) => { trustListeners.push(listener); return { dispose() {} }; };

/** The VS Code terminal boundary: each terminal opened, whether it was shown, and what was typed into it. */
const terminals: Array<{ name: string; shown: number; sent: Array<[string, boolean | undefined]> }> = [];
host.overrides['vscode.window.createTerminal'] = (options: unknown) => {
  const terminal = { name: typeof options === 'string' ? options : String((options as { name?: string })?.name), shown: 0, sent: [] as Array<[string, boolean | undefined]> };
  terminals.push(terminal);
  return { show: () => { terminal.shown++; }, sendText: (text: string, addNewLine?: boolean) => { terminal.sent.push([text, addNewLine]); }, dispose() {} };
};

// UnodeAi's folder for CLI checks must be outside the workspace: a global storage of its own beside it.
context.globalStorageUri.fsPath = path.join(base, '.global');

let chatProvider: any;
let chatScreen: any;
installActivatedExtension(host, (ready) => { chatProvider = ready.chatProvider; chatScreen = ready.screen; }, { agents: [] });

/** No key is stored: the default connection (Unode) cannot run, and the Claude CLI is found on this computer. */
const storedSecrets = new Map<string, string>();
Object.assign(context.secrets, {
  get: async (name: string) => storedSecrets.get(name),
  store: async (name: string, value: string) => { storedSecrets.set(name, value); },
});

/** The Claude CLI's credential variables would make a signed-out status irrelevant; this window has none. */
const CREDENTIAL_VARIABLES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
const savedVariables = new Map<string, string | undefined>();
beforeAll(() => {
  for (const name of Object.keys(process.env)) {
    if (CREDENTIAL_VARIABLES.includes(name.toUpperCase())) { savedVariables.set(name, process.env[name]); delete process.env[name]; }
  }
});
afterAll(() => {
  for (const [name, value] of savedVariables) if (value !== undefined) process.env[name] = value;
  fs.rmSync(cli.folder, { recursive: true, force: true });
});

const config = () => (host.overrides['vscode.workspace.getConfiguration'] as (section?: string) => any)('unode');
const record = () => new RootScopedWorkspaceState(context.workspaceState as never, workspace).get<any>(FIRST_USE_RECORD_KEY);
const agents = () => chatProvider.currentState().agents as Array<{ id: string }>;
const signedIn = (loggedIn: boolean) => fs.writeFileSync(cli.control, JSON.stringify({ loggedIn }));
const descendants = (node: any): any[] => (Array.isArray(node?.children) ? node.children : []).flatMap((child: any) => [child, ...descendants(child)]);

let guide: GuidePage;

describe.runIf(process.platform === 'win32')('v0.9.106 setup guide readiness at the CLI boundary, through activate()', () => {
  it('opening the guide, its steps, Next, Back and refresh events start no program, and the Claude CLI row shows what is known without starting it', async () => {
    await pumpWhile(() => context.globalState.get(FIRST_USE_REVEAL_HANDLED_KEY) !== true, flush);
    await config().update('claudeCliPath', cli.claudeExe);
    for (const listener of configListeners) listener({ affectsConfiguration: (section: string) => section === 'unode' || section === 'unode.claudeCliPath' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = cli.started.length;
    await host.commands.get('unode.setupGuide')!();
    guide = guidePage(guides().at(-1)!);
    await pumpWhile(() => guide.views().length === 0, guide.pump);
    expect(guide.text()).toContain(`Claude CLI Claude CLI · ${cli.claudeExe} (version not checked yet)`);
    for (const step of ['team', 'permissions', 'folders', 'skills', 'continue', 'connections']) await guide.click('step', step);
    for (let i = 0; i < 5; i++) await guide.click('next');
    for (let i = 0; i < 5; i++) await guide.click('back');
    const views = guide.views().length;
    for (const listener of configListeners) listener({ affectsConfiguration: (section: string) => section === 'unode' });
    for (const listener of trustListeners) listener();
    await pumpWhile(() => guide.views().length === views, guide.pump);
    await guide.pump();
    expect(cli.started.slice(before)).toEqual([]);
    expect(cli.starts).toEqual([]);
    expect(terminals).toEqual([]);
  });

  it('Check readiness runs nothing for the default without a key; Use the Claude CLI changes only the guide\'s choice and checks it, starting the CLI', async () => {
    const before = cli.started.length;
    await guide.click('check');
    expect(guide.text()).toContain('Choose how UnodeAi reaches a model');
    // A Codex CLI on this computer's PATH is named too; the Claude CLI comes first.
    expect(guide.text()).toMatch(/UnodeAi found the Claude CLI (and the Codex CLI )?on this computer\./);
    expect(guide.control('repair')?.textContent).toBe('Use the Claude CLI');
    expect(cli.started.slice(before)).toEqual([]);

    signedIn(false);
    await guide.click('repair');
    expect(SetupGuidePanel.openSession()!.creationChoice()).toEqual({ connectionId: 'claude-cli' });
    // The recheck was part of that click: the CLI's version, then its sign-in.
    expect(cli.starts).toEqual([['--version'], ['auth', 'status', '--json']]);
    expect(guide.text()).toContain('The Claude CLI is not signed in');
    expect(guide.text()).toContain('Press Open a terminal to sign in. The sign-in command is typed in it and has not run; press Enter there.');
    expect(guide.control('repair')?.textContent).toBe('Open a terminal');
    // Neither the default connection nor first use changed.
    expect(config().inspect('defaultProvider')?.globalValue).toBeUndefined();
    expect(record()?.connectionId).toBeUndefined();
    expect(terminals).toEqual([]);
  });

  it('the login is typed into a terminal and not run; Check readiness after signing in finds the CLI ready; nothing is sent', async () => {
    const starts = cli.starts.length;
    await guide.click('repair');
    expect(terminals).toEqual([{ name: 'UnodeAi — Claude CLI', shown: 1, sent: [['claude auth login', false]] }]);
    expect(cli.starts.length).toBe(starts);
    // Not checked again by itself: the card's one action is now Check readiness.
    expect(guide.control('repair')).toBeUndefined();
    expect(guide.control('check')?.className).toBe('primary');

    signedIn(true);
    await guide.click('check');
    expect(cli.starts.slice(starts)).toEqual([['--version'], ['auth', 'status', '--json']]);
    expect(guide.text()).toContain('Claude CLI is ready');
    // Retest 3, T2: the row no longer says "version not checked yet" beside the guide's own "is ready". It names the
    // version this check reported, and Settings' record of CLI checks is untouched.
    expect(guide.text()).toContain(`Claude CLI Claude CLI · ${cli.claudeExe} (version 2.1.326, checked by Check readiness here)`);
    expect(guide.text()).not.toContain('version not checked yet');
    expect(guide.text()).toContain(`Claude CLI: ${cli.claudeExe} (version 2.1.326, checked by Check readiness here).`);
    expect(context.globalState.get('unode.cliRuntimeChecks.v1') ?? []).toEqual([]);
    expect(agents()).toEqual([]);
    expect(requests).toHaveLength(0);
    expect(record()?.connectionId).toBeUndefined();
  });

  it('Check / choose CLI reports a cancelled choice as not changed; the row\'s sign-in button types the command with its steps', async () => {
    host.overrides['vscode.window.showQuickPick'] = vi.fn(async () => undefined);
    const starts = cli.starts.length;
    await guide.click('choose-cli', 'claude-cli');
    expect(guide.outcome()).toBe('Not changed. The Claude CLI program UnodeAi starts stays as it was.');
    expect(cli.starts.length).toBe(starts);
    expect(config().get('claudeCliPath')).toBe(cli.claudeExe);

    await guide.click('open-login', 'claude-cli');
    expect(terminals.at(-1)).toEqual({ name: 'UnodeAi — Claude CLI', shown: 1, sent: [['claude auth login', false]] });
    expect(guide.outcome()).toBe('A terminal opened with the Claude CLI sign-in command typed in. It has not run.');
    expect(guide.text()).toContain('Come back here and press Check readiness.');
    expect(cli.starts.length).toBe(starts);
  });

  it('first use, through the same service: Send checks the Claude CLI, the login repair types its command, Check again finds it ready, nothing starts', async () => {
    signedIn(false);
    const screen = chatScreen;
    await pumpWhile(() => !chatProvider.currentState().firstUse?.active, () => screen.pump());
    const input = screen.page().elements.get('input') as any;
    input.value = 'Explain the build.';
    screen.page().dispatchElementEvent(input, 'input');
    screen.page().dispatchElementEvent(input, 'blur');
    await screen.pump();
    const actionButton = (action: string) => descendants(screen.page().elements.get('transcript'))
      .find((node) => node.type === 'button' && node.dataset?.firstUseAction === action);
    const press = async (action: string) => {
      await screen.pump();
      expect(actionButton(action), `${action} is on the page`).toBeDefined();
      screen.page().dispatchElementEvent(actionButton(action), 'click');
      await screen.pump();
    };
    host.overrides['vscode.window.showQuickPick'] = vi.fn(async (items: any[]) => items.find((item) => item.connectionId === 'claude-cli'));
    await screen.sendBox();
    await pumpWhile(() => !actionButton('repair') && !actionButton('start-team'), () => screen.pump());
    // The goal's connection is Unode, with no key and no explicit default: first use offers the Claude CLI.
    expect(screen.transcript()).toContain('Use the Claude CLI');
    const starts = cli.starts.length;
    await press('repair');
    await pumpWhile(() => !screen.transcript().includes('The Claude CLI is not signed in'), () => screen.pump());
    expect(cli.starts.slice(starts)).toEqual([['--version'], ['auth', 'status', '--json']]);
    const terminalsBefore = terminals.length;
    await press('repair');
    await pumpWhile(() => terminals.length === terminalsBefore, () => screen.pump());
    expect(terminals.at(-1)).toEqual({ name: 'UnodeAi — Claude CLI', shown: 1, sent: [['claude auth login', false]] });
    await pumpWhile(() => actionButton('repair')?.textContent !== 'Check again', () => screen.pump());
    expect(cli.starts.length).toBe(starts + 2);
    signedIn(true);
    await press('repair');
    await pumpWhile(() => !actionButton('start-team'), () => screen.pump());
    expect(cli.starts.slice(starts + 2)).toEqual([['--version'], ['auth', 'status', '--json']]);
    expect(screen.transcript()).toContain('Connection: Claude CLI');
    expect(record()).toMatchObject({ text: 'Explain the build.', connectionId: 'claude-cli' });
    expect(agents()).toEqual([]);
    expect(requests).toHaveLength(0);
  });
});
