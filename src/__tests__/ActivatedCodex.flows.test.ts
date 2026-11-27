import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * v0.9.102 (the Owner, 2026-11-12): Codex sandbox crossings through the extension's real entry. `activate()` runs with
 * only the VS Code API stood in and one process start redirected: the configured Codex program (a real file chosen with
 * unode.codexCliPath) is run as a scripted fake App Server. Everything between, the program resolver and its checks,
 * the consent, the Codex backend, the approval broker, the chat and its page, is what activation itself builds.
 * A person's message is typed into the chat page and sent with its Send button; the card is answered on the page.
 * Not a native VS Code host: no window, no real webview, no network, no real Codex.
 */
const host = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const nodeOs = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const overrides: Record<string, unknown> = {};
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const views = new Map<string, unknown>();
  const warnings: string[] = [];
  const infos: string[] = [];
  function stub(path: string): unknown {
    const cache = new Map<PropertyKey, unknown>();
    return new Proxy(function () {} as object, {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        if (prop === Symbol.toPrimitive) return () => '';
        if (prop === Symbol.iterator) return function* () {};
        const key = `${path}.${String(prop)}`;
        if (key in overrides) return overrides[key];
        if (!cache.has(prop)) cache.set(prop, stub(key));
        return cache.get(prop);
      },
      apply(_target, _this, args) { return path.endsWith('.get') ? args[1] : stub(`${path}()`); },
      construct() { return stub(`new ${path}`) as object; },
    });
  }
  // The Codex program the person chose: a real file in its own folder. Its starts are redirected below.
  const binFolder = nodeFs.realpathSync.native(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'unode-codex-bin-')));
  const codexExe = nodePath.join(binFolder, 'codex.exe');
  nodeFs.writeFileSync(codexExe, 'not a real program: its starts run the scripted fake App Server');
  const control = nodePath.join(binFolder, 'control.json');
  const fakeScript = nodePath.join(process.cwd(), 'src', '__tests__', 'fixtures', 'fakeCodexAppServer.cjs');
  const panels = new Map<string, { webview: { html: string }; receive?: (message: unknown) => void }>();
  return { overrides, commands, views, panels, warnings, infos, stub, codexExe, control, fakeScript, binFolder };
});

/** Only the start of the chosen Codex program is redirected, to the fake; every other process start is real. */
function routedChildProcess(actual: typeof import('child_process')) {
  const isCodex = (command: unknown) => typeof command === 'string'
    && path.resolve(command).toLowerCase() === host.codexExe.toLowerCase();
  const spawn = ((command: string, args?: readonly string[] | object, options?: object) => {
    if (!isCodex(command)) return (actual.spawn as any)(command, args, options);
    const argv = Array.isArray(args) ? args : [];
    const opts = Array.isArray(args) ? options : args;
    return actual.spawn(process.execPath, [host.fakeScript, host.control, ...argv], { ...(opts as object ?? {}), shell: false } as any);
  }) as typeof actual.spawn;
  return { ...actual, spawn, default: { ...actual, spawn } };
}
vi.mock('child_process', async (importOriginal) => routedChildProcess(await importOriginal<typeof import('child_process')>()));
vi.mock('node:child_process', async (importOriginal) => routedChildProcess(await importOriginal<typeof import('child_process')>()));

vi.mock('vscode', async () => {
  const nodeFs = await import('fs');
  const root = host.stub('vscode') as Record<PropertyKey, unknown>;
  class EventEmitter<T> {
    private listeners: ((value: T) => void)[] = [];
    event = (listener: (value: T) => void) => { this.listeners.push(listener); return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } }; };
    fire(value: T) { for (const listener of [...this.listeners]) listener(value); }
    dispose() { this.listeners = []; }
  }
  class Disposable { constructor(private readonly done?: () => void) {} dispose() { this.done?.(); } static from() { return new Disposable(); } }
  const Uri = {
    file: (fsPath: string) => ({ fsPath, scheme: 'file', path: fsPath.replace(/\\/g, '/'), toString: () => `file://${fsPath}`, with: () => Uri.file(fsPath) }),
    joinPath: (uri: { fsPath: string }, ...parts: string[]) => Uri.file(require('path').join(uri.fsPath, ...parts)),
    parse: (value: string) => Uri.file(value.replace(/^file:\/\//, '')),
  };
  const notFound = (error: unknown) => Object.assign(new Error(String(error)), { code: 'FileNotFound' });
  Object.assign(host.overrides, {
    'vscode.EventEmitter': EventEmitter, 'vscode.Disposable': Disposable, 'vscode.Uri': Uri,
    'vscode.FileType': { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    'vscode.QuickPickItemKind': { Separator: -1, Default: 0 },
    'vscode.ExtensionMode': { Production: 1, Development: 2, Test: 3 },
    'vscode.ConfigurationTarget': { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    'vscode.ViewColumn': { One: 1, Two: 2, Active: -1, Beside: -2 },
    'vscode.commands.registerCommand': (name: string, handler: (...args: unknown[]) => unknown) => {
      host.commands.set(name, handler); return new Disposable();
    },
    'vscode.window.registerWebviewViewProvider': (id: string, provider: unknown) => { host.views.set(id, provider); return new Disposable(); },
    // A webview panel (the Security panel): its HTML is kept, and the handler of its page's messages is captured.
    'vscode.window.createWebviewPanel': (viewType: string) => {
      const panel = {
        viewType,
        webview: {
          html: '', cspSource: 'test:', options: {},
          asWebviewUri: (uri: unknown) => uri,
          postMessage: () => Promise.resolve(true),
          onDidReceiveMessage: (listener: (message: unknown) => void) => { panel.receive = listener; return new Disposable(); },
        },
        receive: undefined as ((message: unknown) => void) | undefined,
        onDidDispose: () => new Disposable(),
        onDidChangeViewState: () => new Disposable(),
        reveal() {}, dispose() {},
      };
      host.panels.set(viewType, panel);
      return panel;
    },
    'vscode.workspace.onDidGrantWorkspaceTrust': () => new Disposable(),
    'vscode.workspace.isTrusted': true,
    'vscode.env.appName': 'Visual Studio Code',
    // VS Code always gives a window a session id; the run ledger's owner of a delegation is that window. Without it,
    // every delegation still active at a 5 s ownership tick read as owner-less and was marked interrupted (the
    // v0.9.102 release chain: a result that never woke the PM, only when a slow machine let a tick land mid-task).
    'vscode.env.sessionId': 'activated-flows-window',
    'vscode.workspace.fs': {
      readFile: async (uri: { fsPath: string }) => { try { return nodeFs.readFileSync(uri.fsPath); } catch (e) { throw notFound(e); } },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        nodeFs.mkdirSync(require('path').dirname(uri.fsPath), { recursive: true }); nodeFs.writeFileSync(uri.fsPath, bytes);
      },
      createDirectory: async (uri: { fsPath: string }) => { nodeFs.mkdirSync(uri.fsPath, { recursive: true }); },
      delete: async (uri: { fsPath: string }) => { nodeFs.rmSync(uri.fsPath, { recursive: true, force: true }); },
      stat: async (uri: { fsPath: string }) => {
        try { const s = nodeFs.statSync(uri.fsPath); return { type: s.isDirectory() ? 2 : 1, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }; } catch (e) { throw notFound(e); }
      },
      readDirectory: async (uri: { fsPath: string }) => {
        try { return nodeFs.readdirSync(uri.fsPath, { withFileTypes: true }).map((d) => [d.name, d.isDirectory() ? 2 : 1]); } catch (e) { throw notFound(e); }
      },
    },
  });
  return new Proxy({}, { has: () => true, get: (_target, prop) => (prop === 'then' ? undefined : root[prop]) });
});

import type { AgentConfig } from '../types';
import { PersistenceManager } from '../state/PersistenceManager';
import { RootScopedWorkspaceState } from '../state/RootScopedWorkspaceState';
import { AgentConfigBuilder } from '../roles/RoleConfig';
import { bootWebviewScript, type WebviewBootResult } from '../views/__tests__/support/webviewBoot';
import { CODEX_COMMAND_CARD_WARNING, CODEX_REDIRECT_LINE, CODEX_REDIRECT_NOTE } from '../backend/codexCrossing';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const flush = async (rounds = 4) => {
  for (let round = 0; round < rounds; round++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
};

function memento() {
  const values = new Map<string, unknown>();
  return { get: (key: string, fallback?: unknown) => (values.has(key) ? structuredClone(values.get(key)) : fallback),
    update: async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, JSON.parse(JSON.stringify(value))); },
    keys: () => [...values.keys()], setKeysForSync() {} };
}

/* ---------------------------------------------------------------------------------------------------------------------
 * The fake App Server's script and its log: what it received from the extension, and the answers it got.
 * ------------------------------------------------------------------------------------------------------------------- */
type LogEntry = { pid: number; t?: number; event: string; argv?: string[]; message?: any; id?: string; decision?: unknown };
const logFile = path.join(host.binFolder, 'log.jsonl');
function setScenario(scenario: { escapes: string[]; sandboxAttemptBetween: boolean; reply: string;
  sandboxAttemptCommand?: string; sandboxAttemptOutput?: string; networkContext?: boolean; escapeBeforeTurnReply?: boolean;
  computerUse?: { app: string; persist: string[] }; readFile?: { path: string } }) {
  fs.writeFileSync(host.control, JSON.stringify({ log: logFile, scenario }));
}
const fakeLog = (): LogEntry[] => (fs.existsSync(logFile)
  ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as LogEntry) : []);

/* ---------------------------------------------------------------------------------------------------------------------
 * The chat on screen: the real ChatViewProvider activation registered, its page booted from the HTML it serves.
 * ------------------------------------------------------------------------------------------------------------------- */
function chatScreen(provider: { resolveWebviewView(view: unknown, ...rest: unknown[]): void }) {
  let page: WebviewBootResult | undefined;
  const queued: unknown[] = [];
  let fromPage: ((message: unknown) => void) | undefined;
  const deliver = (message: unknown) => { for (const listener of page?.listeners.message ?? []) listener({ data: message }); };
  const view = {
    visible: true,
    webview: {
      cspSource: 'test:', html: '', options: {},
      asWebviewUri: (uri: unknown) => uri,
      postMessage: (message: unknown) => { if (page) deliver(message); else queued.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: (listener: (message: unknown) => void) => { fromPage = listener; return { dispose() {} }; },
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
    show() {},
  };
  provider.resolveWebviewView(view, undefined, undefined);
  page = bootWebviewScript(view.webview.html);
  let sent = 0;
  const pump = async () => {
    for (const message of queued.splice(0)) deliver(message);
    while (sent < page!.postedMessages.length) fromPage?.(page!.postedMessages[sent++]);
    await flush();
  };
  const descendants = (node: any): any[] => (Array.isArray(node?.children) ? node.children : []).flatMap((child: any) => [child, ...descendants(child)]);
  const text = (node: any): string => [node?.textContent, ...(Array.isArray(node?.children) ? node.children.map(text) : [])].filter(Boolean).join(' ');
  const cards = () => (page!.elements.get('approvals') as any)?.children?.filter((node: any) => node.className === 'appr-card') ?? [];
  return {
    pump,
    transcript: () => text(page!.elements.get('transcript')),
    /** The approval cards on the page: their warning, their command body, their buttons. */
    cards: () => cards().map((card: any) => ({
      card,
      warning: descendants(card).find((node: any) => node.className === 'appr-warn')?.textContent ?? '',
      body: descendants(card).find((node: any) => node.className === 'appr-cmd')?.textContent ?? '',
      /** Every text on the card (v0.9.105: a tool card's name and detail are not in its command line). */
      text: text(card),
      buttons: descendants(descendants(card).find((node: any) => node.className === 'appr-actions'))
        .map((node: any) => node.textContent).filter(Boolean),
    })),
    /** The person presses a button on the first card. */
    press: async (label: string) => {
      await pump();
      const button = descendants(cards()[0]).find((node: any) => node.textContent === label);
      expect(button, `the card's ${label} button`).toBeDefined();
      page!.dispatchElementEvent(button, 'click');
      await pump();
    },
    select: async (agentId: string) => {
      await pump();
      const select = page!.elements.get('agent') as any;
      select.value = agentId;
      page!.dispatchElementEvent(select, 'change');
      await pump();
    },
    send: async (message: string) => {
      await pump();
      (page!.elements.get('input') as any).value = message;
      page!.dispatchElementEvent(page!.elements.get('send') as never, 'click');
      await pump();
    },
  };
}

/* ---------------------------------------------------------------------------------------------------------------------
 * The window: a real temporary workspace, two Codex Solo agents saved there before the window opened, and activate().
 * ------------------------------------------------------------------------------------------------------------------- */
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'unode-activated-codex-')));
const workspace = path.join(base, 'ws');
const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'unode-codex-outside-')));
// Flow 3's own folder, and flow 5's folder whose name is itself sensitive (design test 20a).
const granted = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'unode-codex-granted-')));
const sensitive = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'privatevalue-')));
// Test 20b's crew folder, the grant-failure folder (deleted before the click), and the ceiling flow's named folder.
const crewFolder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'unode-codex-crew-')));
const doomed = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'unode-codex-doomed-')));
const ceilingNamed = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'unode-codex-ceiling-')));
fs.mkdirSync(workspace, { recursive: true });
const context = {
  subscriptions: [] as { dispose(): void }[], globalState: memento(), workspaceState: memento(),
  extensionUri: { fsPath: process.cwd() }, extensionPath: process.cwd(), globalStorageUri: { fsPath: path.join(base, '.global') },
  storageUri: { fsPath: path.join(base, '.storage') }, logUri: { fsPath: path.join(base, '.log') }, extensionMode: 3, extension: { packageJSON: {} },
  secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
  asAbsolutePath: (value: string) => value, environmentVariableCollection: { replace() {}, clear() {} },
};

function codexSolo(id: string, name: string, profile?: 'ask-for-approval'): AgentConfig {
  const config = new AgentConfigBuilder().fromTemplate('solo').setProviderById('codex-cli').setId(id).setName(name).setModel('gpt-test').build();
  config.backend = 'codex';
  if (profile) config.codexPermissionProfile = profile;
  return config;
}

let screen: ReturnType<typeof chatScreen>;
let chatProvider: any;
const history = (agentId: string): Array<{ role: string; text: string }> => chatProvider.loadHistory(agentId) as Array<{ role: string; text: string }>;
const historyText = (agentId: string): string => history(agentId).map((message) => message.text).join('\n');

beforeAll(async () => {
  Object.assign(host.overrides, {
    'vscode.workspace.workspaceFolders': [{ uri: { fsPath: workspace, scheme: 'file', path: workspace, toString: () => `file://${workspace}` }, name: 'w', index: 0 }],
  });
  const declared = (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).contributes.configuration as
    Array<{ properties: Record<string, { default?: unknown }> }> | { properties: Record<string, { default?: unknown }> });
  const defaults = new Map<string, unknown>();
  for (const block of Array.isArray(declared) ? declared : [declared]) {
    for (const [key, spec] of Object.entries(block.properties)) defaults.set(key, spec.default);
  }
  // The person's one choice: the Codex program, as Check / choose CLI saves it.
  const userValues = new Map<string, unknown>([['unode.codexCliPath', host.codexExe]]);
  host.overrides['vscode.workspace.getConfiguration'] = (section?: string) => {
    const full = (key: string) => (section ? `${section}.${key}` : key);
    return {
      get: (key: string, fallback?: unknown) => {
        const name = full(key);
        if (userValues.has(name)) return structuredClone(userValues.get(name));
        return defaults.has(name) && defaults.get(name) !== undefined ? structuredClone(defaults.get(name)) : fallback;
      },
      has: (key: string) => defaults.has(full(key)) || userValues.has(full(key)),
      inspect: (key: string) => ({ key: full(key), defaultValue: defaults.get(full(key)),
        ...(userValues.has(full(key)) ? { globalValue: userValues.get(full(key)) } : {}) }),
      update: async (key: string, value: unknown) => { if (value === undefined) userValues.delete(full(key)); else userValues.set(full(key), value); },
    };
  };
  for (const [method, list] of [['showWarningMessage', host.warnings], ['showInformationMessage', host.infos], ['showErrorMessage', host.warnings]] as const) {
    host.overrides[`vscode.window.${method}`] = vi.fn(async (text: string) => { list.push(String(text)); return undefined; });
  }
  setScenario({ escapes: [], sandboxAttemptBetween: false, reply: '' });
  await new PersistenceManager(context as never, undefined, () => workspace, undefined, undefined,
    new RootScopedWorkspaceState(context.workspaceState as never, workspace)).saveAgents([
    codexSolo('solo', 'Solo'),
    codexSolo('asker', 'Asker', 'ask-for-approval'),
    // One fresh agent per later flow, so each starts with no grant, no network and its own App Server.
    codexSolo('granter', 'Granter'),
    codexSolo('networker', 'Networker'),
    codexSolo('keeper', 'Keeper'),
    codexSolo('crew-a', 'CrewA'),
    codexSolo('crew-b', 'CrewB'),
    codexSolo('racer', 'Racer'),
    codexSolo('failer', 'Failer'),
    // An agent with a Folder Access ceiling: Read + Write to the workspace only.
    { ...codexSolo('fenced', 'Fenced'), folderAccess: [{ path: workspace, permission: 'readwrite' as const }] },
  ]);
  const extension = await import('../extension');
  await extension.activate(context as never);
  const chat = host.views.get('unode.chat') as Parameters<typeof chatScreen>[0];
  expect(chat, 'activation registers the chat view').toBeDefined();
  chatProvider = chat;
  screen = chatScreen(chat);
  await screen.pump();
});

afterAll(async () => {
  for (const sub of context.subscriptions.splice(0)) { try { sub.dispose(); } catch { /* ignore */ } }
  await flush(20);
  for (const folder of [base, outside, granted, sensitive, crewFolder, doomed, ceilingNamed, host.binFolder]) { try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* a process may still hold it */ } }
});

/** The section 3 smoke escape: a shell write into a folder no grant covers, with a secret in the same command. */
const escapeCommand = () => `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Set-Content -LiteralPath '${path.join(outside, 'cmd.txt')}' -Value hi; # token=privatevalue"`;

/**
 * v0.9.105 (CI 44007091429, 44017485725): bounded by wall-clock time from the process clock, never by a count of rounds,
 * about what the 400 rounds gave; one that runs out fails here, so waits in a row cannot add up past the mutation
 * engine's 60 s per case.
 */
async function until(condition: () => boolean, deadlineMs = 30_000): Promise<void> {
  const deadline = process.hrtime.bigint() + BigInt(deadlineMs) * 1_000_000n;
  while (!condition()) {
    if (process.hrtime.bigint() >= deadline) throw new Error(`Waited ${deadlineMs / 1_000} s by the process clock for: ${condition.toString()}`);
    await screen.pump();
  }
}

// The Codex program the extension resolves is a Windows executable in the field; these flows run on Windows.
describe.runIf(process.platform === 'win32')('v0.9.102 Codex sandbox crossings through activate(): sandbox first, then the person', () => {
  // Codex's audit of db06e059, finding 2: the escape reached the host before the answer carrying the turn's id; the chat
  // said the sandbox-first note was sent, but it was never sent. It is held until the id arrives, then sent on that turn.
  it('Approve for me, the escape before the turn\'s id: the sandbox-first note is still sent on that turn, after the decline', async () => {
    const command = escapeCommand();
    setScenario({ escapes: [command], sandboxAttemptBetween: false, reply: 'Early: I will try inside the sandbox.', escapeBeforeTurnReply: true });
    const before = fakeLog().length;
    await screen.select('solo');
    await screen.send(`Using a shell command, create early.txt containing hi in ${outside}.`);
    await until(() => historyText('solo').includes('Early: I will try inside the sandbox.'));
    const steers = () => fakeLog().slice(before).filter((entry) => entry.event === 'received' && entry.message?.method === 'turn/steer');
    await until(() => steers().length > 0);
    const log = fakeLog().slice(before);
    expect(log.filter((entry) => entry.event === 'answer')).toEqual([expect.objectContaining({ id: 'escape-1', decision: 'decline' })]);
    expect(steers()).toHaveLength(1);
    expect(steers()[0].message.params).toMatchObject({ expectedTurnId: 'turn-1', input: [{ type: 'text', text: CODEX_REDIRECT_NOTE }] });
    const indexOf = (predicate: (entry: LogEntry) => boolean) => log.findIndex(predicate);
    expect(indexOf((e) => e.event === 'answer' && e.id === 'escape-1')).toBeLessThan(indexOf((e) => e.message?.method === 'turn/steer'));
    expect(historyText('solo') + screen.transcript()).toContain(CODEX_REDIRECT_LINE);
  });

  it('Approve for me: the first escape is declined with the sandbox-first note; asked again after a sandbox failure, it is the card, and Deny declines it', async () => {
    const command = escapeCommand();
    setScenario({ escapes: [command, command], sandboxAttemptBetween: true, reply: 'The folder is not writable; I did not create cmd.txt.' });
    const before = fakeLog().length;
    await screen.select('solo');
    await screen.send(`Using a shell command, create cmd.txt containing hi in ${outside}.`);
    await until(() => screen.cards().length > 0);
    const log = fakeLog().slice(before);
    const answers = log.filter((entry) => entry.event === 'answer');
    // The first escape: declined, then the note on the same turn; nothing was accepted.
    expect(answers, JSON.stringify({ log: log.map((e) => [e.event, e.message?.method, e.id, e.decision]), warnings: host.warnings, history: historyText('solo') }))
      .toEqual([expect.objectContaining({ id: 'escape-1', decision: 'decline' })]);
    const steers = log.filter((entry) => entry.event === 'received' && entry.message?.method === 'turn/steer');
    expect(steers).toHaveLength(1);
    expect(steers[0].message.params).toMatchObject({ expectedTurnId: 'turn-1', input: [{ type: 'text', text: CODEX_REDIRECT_NOTE }] });
    const indexOf = (predicate: (entry: LogEntry) => boolean) => log.findIndex(predicate);
    expect(indexOf((e) => e.event === 'answer' && e.id === 'escape-1')).toBeLessThan(indexOf((e) => e.message?.method === 'turn/steer'));
    expect(historyText('solo') + screen.transcript()).toContain(CODEX_REDIRECT_LINE);

    // The second escape is a card on the page: the exact command, the outside-run warning, and two choices.
    const [card] = screen.cards();
    expect(card.body.startsWith(command)).toBe(true);
    expect(card.warning).toBe(CODEX_COMMAND_CARD_WARNING);
    // The command's target is inside the inline -Command script, so the folder comes from what the person's own message
    // named: exactly that physical folder, and never the program's own folder (C:\Windows\System32\...).
    expect(card.buttons).toEqual(['Allow once', `Grant ${outside} Read + Write to the crew for this session, then run once`, 'Deny']);
    expect(card.buttons.join(' ')).not.toMatch(/System32/i);
    expect(fakeLog().filter((entry) => entry.event === 'answer' && entry.id === 'escape-2')).toEqual([]);

    await screen.press('Deny');
    await until(() => historyText('solo').includes('The folder is not writable'));
    const after = fakeLog().slice(before);
    expect(after.filter((entry) => entry.event === 'answer').map((entry) => [entry.id, entry.decision]))
      .toEqual([['escape-1', 'decline'], ['escape-2', 'decline']]);
    expect(after.some((entry) => entry.event === 'answer' && entry.decision === 'accept')).toBe(false);
    expect(fs.existsSync(path.join(outside, 'cmd.txt'))).toBe(false);
    // The card's kept record: the program and the choice, nothing of the command.
    const records = history('solo').filter((message) => /^Codex command \(/.test(message.text));
    expect(records.map((message) => message.text), historyText('solo')).toEqual([expect.stringMatching(/^Codex command \(powershell\): declined at \d\d:\d\d\.$/)]);
    expect(records[0].text).not.toContain('privatevalue');
    expect(records[0].text).not.toContain(outside);
    expect(screen.cards()).toEqual([]);
  });

  it('Ask for approval: the same escape is the card at once, with no note', async () => {
    const command = escapeCommand();
    setScenario({ escapes: [command], sandboxAttemptBetween: false, reply: 'I did not create cmd.txt.' });
    const before = fakeLog().length;
    await screen.select('asker');
    await screen.send(`Using a shell command, create cmd.txt containing hi in ${outside}.`);
    await until(() => screen.cards().length > 0);
    const [card] = screen.cards();
    expect(card?.body.startsWith(command), JSON.stringify({ log: fakeLog().slice(before).map((e) => [e.event, e.message?.method, e.id]), warnings: host.warnings })).toBe(true);
    expect(card.warning).toBe(CODEX_COMMAND_CARD_WARNING);
    expect(fakeLog().slice(before).filter((entry) => entry.event === 'answer')).toEqual([]);
    await screen.press('Deny');
    await until(() => historyText('asker').includes('I did not create cmd.txt.'));
    const log = fakeLog().slice(before);
    expect(log.filter((entry) => entry.event === 'answer').map((entry) => [entry.id, entry.decision])).toEqual([['escape-1', 'decline']]);
    expect(log.filter((entry) => entry.event === 'received' && entry.message?.method === 'turn/steer')).toEqual([]);
    expect(historyText('asker')).not.toContain(CODEX_REDIRECT_LINE);
    expect(fs.existsSync(path.join(outside, 'cmd.txt'))).toBe(false);
  });
});

/** A shell write into a folder, as App Server 0.165 transports it from Windows PowerShell. */
const writeInto = (folder: string, secret = 'token=privatevalue') => `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Set-Content -LiteralPath '${path.join(folder, 'cmd.txt')}' -Value hi; # ${secret}"`;
/** A download, as App Server 0.165 transports it: no file path anywhere in it. */
const download = (target = 'https://example.com') => `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Invoke-WebRequest -UseBasicParsing -Uri '${target}' -OutFile page.html"`;
const NETWORK_FAILURE = 'Invoke-WebRequest : 无法连接到远程服务器';
/** Measured in the Windows sandbox with network off (Codex 0.165, 2026-11-12), as PowerShell 5.1 wraps native stderr. */
const NPM_NETWORK_FAILURE = 'npm : npm error code EACCES\r\n    + CategoryInfo          : NotSpecified: (npm error code EACCES:String) [], RemoteException\r\n'
  + '    + FullyQualifiedErrorId : NativeCommandError\r\nnpm error errno EACCES\r\n'
  + "npm error FetchError: request to https://registry.npmjs.org/left-pad failed, reason: \r\nnpm error   code: 'EACCES',";
const NODE_NETWORK_FAILURE = 'node:internal/process/promises:332\r\n    triggerUncaughtException(err, true /* fromPromise */);\r\n'
  + 'TypeError: fetch failed\r\n    at node:internal/deps/undici/undici:13181:23 {\r\n  [cause]: AggregateError [EACCES]: \r\n'
  + '      at internalConnectMultiple (node:net:1193:18)';
const NPM_CERTIFICATE_FAILURE = 'npm error code CERT_HAS_EXPIRED\r\nnpm error FetchError: request to https://registry.npmjs.org/left-pad failed, reason: certificate has expired';
const GRANT_NOTICE = 'Read + Write file access granted for this session.';
const sameFolder = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
/** The newest sandbox policy the fake App Server received on a turn start. */
const lastTurnPolicy = (since: number) => fakeLog().slice(since)
  .filter((entry) => entry.event === 'received' && entry.message?.method === 'turn/start').at(-1)?.message.params.sandboxPolicy;

// The Codex program the extension resolves is a Windows executable in the field; these flows run on Windows.
describe.runIf(process.platform === 'win32')('v0.9.102 Codex card choices through activate(): a lasting grant, network for the session, a sensitive folder', () => {
  it('Grant then run once: the folder is granted first, only then is the command accepted, and the next turn\'s sandbox can write there', async () => {
    const command = writeInto(granted);
    setScenario({ escapes: [command, command], sandboxAttemptBetween: true, reply: 'Created cmd.txt.' });
    const before = fakeLog().length;
    await screen.select('granter');
    await screen.send(`Using a shell command, create cmd.txt containing hi in ${granted}.`);
    await until(() => screen.cards().length > 0);
    const grantLabel = `Grant ${granted} Read + Write to the crew for this session, then run once`;
    expect(screen.cards()[0].buttons, JSON.stringify(fakeLog().slice(before).map((e) => [e.event, e.message?.method, e.id, e.decision])))
      .toEqual(['Allow once', grantLabel, 'Deny']);
    // Nothing is accepted before the person's click.
    expect(fakeLog().slice(before).filter((entry) => entry.event === 'answer').map((entry) => [entry.id, entry.decision])).toEqual([['escape-1', 'decline']]);
    expect(pathGrantId(await securityPage(), granted)).toBeUndefined();
    await screen.press(grantLabel);
    await until(() => historyText('granter').includes('Created cmd.txt.'));
    // The Security page, open before the choice, lists the grant with no Refresh and no reopening.
    await until(() => pathGrantId(openSecurityHtml(), granted) !== undefined);
    expect(pathGrantId(openSecurityHtml(), granted)).toBeDefined();
    const log = fakeLog().slice(before);
    const accept = log.find((entry) => entry.event === 'answer' && entry.id === 'escape-2');
    expect(accept?.decision).toBe('accept');
    // The grant is made first: its notice is in the chat no later than the accept reached App Server.
    const notice = history('granter').find((message) => message.text.startsWith(GRANT_NOTICE)) as { text: string; ts: string } | undefined;
    expect(notice, historyText('granter')).toBeDefined();
    expect(Date.parse(notice!.ts)).toBeLessThanOrEqual(accept!.t!);
    expect(notice!.text).not.toContain(granted);
    // The card's kept record: run once, outside the sandbox, and nothing of the command or its folder.
    const records = history('granter').filter((message) => /^Codex command \(/.test(message.text));
    expect(records.map((message) => message.text)).toEqual([expect.stringMatching(/^Codex command \(powershell\): grant folder, then run once at \d\d:\d\d, outside the sandbox\.$/)]);
    expect(records[0].text).not.toContain('privatevalue');
    expect(records[0].text).not.toContain(granted);

    // The next turn: the sandbox it starts with can write in the granted folder, so no escape is needed there.
    setScenario({ escapes: [], sandboxAttemptBetween: false, reply: 'Next turn done.' });
    const nextTurn = fakeLog().length;
    await screen.send('Thanks. Anything else?');
    await until(() => historyText('granter').includes('Next turn done.'));
    const policy = lastTurnPolicy(nextTurn);
    expect(policy?.type, JSON.stringify({ log: fakeLog().slice(nextTurn).map((e) => [e.pid, e.event, e.message?.method, e.argv?.[0]]), history: history('granter').slice(-6), warnings: host.warnings.slice(-5), infos: host.infos.slice(-5) })).toBe('workspaceWrite');
    expect((policy.writableRoots as string[]).some((root) => sameFolder(root, granted)), JSON.stringify(policy)).toBe(true);
    expect(fakeLog().slice(nextTurn).filter((entry) => entry.message?.method === 'item/commandExecution/requestApproval')).toEqual([]);
  });

  it('Network for the session: a card for a command that differs from the failed one has no network choice; the same command after a connection failure does, and the next turn runs with network on', async () => {
    await screen.select('networker');
    // A connection failure of another command is no evidence for this one: no network choice.
    setScenario({ escapes: [download('https://example.com/a'), download('https://example.com/b')], sandboxAttemptBetween: true,
      sandboxAttemptCommand: download('https://example.com/a'), sandboxAttemptOutput: NETWORK_FAILURE, reply: 'Nothing downloaded.' });
    let before = fakeLog().length;
    await screen.send('Download the example page.');
    await until(() => screen.cards().length > 0);
    expect(screen.cards()[0].buttons, JSON.stringify(fakeLog().slice(before).map((e) => [e.event, e.message?.method, e.id, e.decision])))
      .toEqual(['Allow once', 'Deny']);
    await screen.press('Deny');
    await until(() => historyText('networker').includes('Nothing downloaded.'));

    // The same command that just failed to connect inside the sandbox: the card offers network for this agent.
    const command = download();
    setScenario({ escapes: [command, command], sandboxAttemptBetween: true, sandboxAttemptCommand: command,
      sandboxAttemptOutput: NETWORK_FAILURE, reply: 'Downloaded page.html.' });
    before = fakeLog().length;
    await screen.send('Please try the download again.');
    await until(() => screen.cards().length > 0);
    const allowLabel = 'Allow network for Networker for this session, then run once';
    expect(screen.cards()[0].buttons, JSON.stringify(fakeLog().slice(before).map((e) => [e.event, e.message?.method, e.id, e.decision])))
      .toEqual(['Allow once', allowLabel, 'Deny']);
    expect(fakeLog().slice(before).filter((entry) => entry.event === 'answer').map((entry) => [entry.id, entry.decision])).toEqual([['escape-1', 'decline']]);
    // The Security page is open before the choice (field 2026-11-12: it kept the old state until Refresh).
    expect(await securityPage()).not.toContain('Networker · Network · For this session');
    await screen.press(allowLabel);
    await until(() => historyText('networker').includes('Downloaded page.html.'));
    // The open page shows it with no Refresh and no reopening.
    await until(() => openSecurityHtml().includes('Networker · Network · For this session'));
    expect(openSecurityHtml()).toContain('Networker · Network · For this session');
    expect(fakeLog().slice(before).filter((entry) => entry.event === 'answer').map((entry) => [entry.id, entry.decision]))
      .toEqual([['escape-1', 'decline'], ['escape-2', 'accept']]);
    // The card's kept record names the actual choice, and nothing of the command.
    expect(history('networker').filter((message) => /^Codex command \(/.test(message.text)).map((message) => message.text).at(-1))
      .toMatch(/^Codex command \(powershell\): allow network, then run once at \d\d:\d\d, outside the sandbox\.$/);

    // The next turn: a new App Server with network on in its sandbox, and the turn's sandbox policy says so.
    setScenario({ escapes: [], sandboxAttemptBetween: false, reply: 'Network turn done.' });
    const nextTurn = fakeLog().length;
    await screen.send('Thanks. Anything else?');
    await until(() => historyText('networker').includes('Network turn done.'));
    const after = fakeLog().slice(nextTurn);
    const started = after.filter((entry) => entry.event === 'start' && entry.argv?.[0] === 'app-server');
    expect(started.length, JSON.stringify(after.map((e) => [e.event, e.message?.method]))).toBeGreaterThanOrEqual(1);
    expect(started.at(-1)!.argv).toEqual(expect.arrayContaining(['sandbox_workspace_write.network_access=true']));
    const policy = lastTurnPolicy(nextTurn);
    expect(policy, JSON.stringify(after.map((e) => [e.event, e.message?.method]))).toMatchObject({ type: 'workspaceWrite', networkAccess: true });
  });

  it('npm and Node fetch failing to connect in the sandbox (measured Windows output): the card shows the network choice; a certificate error does not', async () => {
    // Solo's own flows are done by now; the activated host runs at most ten agents, so no new agent is added.
    await screen.select('solo');
    const allowLabel = 'Allow network for Solo for this session, then run once';
    const cases: Array<[string, string, string, boolean]> = [
      ['npm i', NPM_NETWORK_FAILURE, 'Install declined.', true],
      [`node -e "fetch('https://registry.npmjs.org/left-pad').then(r=>console.log(r.status))"`, NODE_NETWORK_FAILURE, 'Fetch declined.', true],
      ['npm i', NPM_CERTIFICATE_FAILURE, 'Certificate case declined.', false],
    ];
    for (const [inner, output, reply, offered] of cases) {
      const command = `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "${inner.replace(/"/g, '\\"')}"`;
      setScenario({ escapes: [command, command], sandboxAttemptBetween: true, sandboxAttemptCommand: command,
        sandboxAttemptOutput: output, reply });
      const before = fakeLog().length;
      const cardsBefore = screen.cards().length;
      await screen.send(`Run ${inner}`);
      await until(() => screen.cards().length > cardsBefore);
      expect(screen.cards().at(-1)!.buttons, JSON.stringify(fakeLog().slice(before).map((e) => [e.event, e.message?.method, e.id, e.decision])))
        .toEqual(offered ? ['Allow once', allowLabel, 'Deny'] : ['Allow once', 'Deny']);
      await screen.press('Deny');
      await until(() => historyText('solo').includes(reply));
      // The first request was sent back to the sandbox; the card's request was declined by the person.
      expect(fakeLog().slice(before).filter((entry) => entry.event === 'answer').map((entry) => entry.decision)).toEqual(['decline', 'decline']);
    }
  });

  it('A sensitive folder name: granting it keeps the name out of every record the card adds', async () => {
    const approvalEvents: unknown[] = [];
    const subscription = chatProvider.onApprovalEvent((event: unknown) => approvalEvents.push(event));
    try {
      const command = writeInto(sensitive, 'note');
      setScenario({ escapes: [command, command], sandboxAttemptBetween: true, reply: 'Done.' });
      const before = fakeLog().length;
      const historyBefore = history('keeper').length;
      await screen.select('keeper');
      await screen.send(`Using a shell command, create cmd.txt containing hi in ${sensitive}.`);
      await until(() => screen.cards().length > 0);
      const grantLabel = `Grant ${sensitive} Read + Write to the crew for this session, then run once`;
      // The live card shows the exact folder: the person must see what is granted.
      expect(screen.cards()[0].buttons).toContain(grantLabel);
      // The folder's own Grant access item, which the person's message named, is already in the chat before the card is
      // answered: it is the existing grant record, not something the card adds, and it names the full path by design.
      const accessItems = history('keeper').filter((message) => String((message as { noticeKey?: string }).noticeKey ?? '').startsWith('outcome-repair/path-access-'));
      expect(accessItems.map((message) => message.text.includes(sensitive)), JSON.stringify(history('keeper'))).toEqual([true]);
      const accessKey = (accessItems[0] as { noticeKey?: string }).noticeKey;
      await screen.press(grantLabel);
      await until(() => historyText('keeper').includes('Done.'));
      expect(fakeLog().slice(before).filter((entry) => entry.event === 'answer').map((entry) => [entry.id, entry.decision]))
        .toEqual([['escape-1', 'decline'], ['escape-2', 'accept']]);
      // Every chat entry this turn added except, by identity, the person's own message and the folder's pre-existing
      // Grant access item: replies, notices, the kept record. The command's own activity card is not a chat history
      // entry.
      const added = history('keeper').slice(historyBefore)
        .filter((message) => message.role !== 'user' && (message as { noticeKey?: string }).noticeKey !== accessKey);
      expect(added.some((message) => message.text.startsWith(GRANT_NOTICE)), JSON.stringify(added)).toBe(true);
      expect(added.some((message) => /^Codex command \(powershell\): grant folder, then run once at \d\d:\d\d, outside the sandbox\.$/.test(message.text)), JSON.stringify(added)).toBe(true);
      expect(added.filter((message) => message.text.includes('privatevalue')), JSON.stringify(added)).toEqual([]);
      // The approval events the card produced.
      expect(approvalEvents.length).toBeGreaterThan(0);
      expect(JSON.stringify(approvalEvents)).not.toContain('privatevalue');
    } finally {
      subscription.dispose();
    }
  });
});

/* ---------------------------------------------------------------------------------------------------------------------
 * The Security panel, opened with its command as a person opens it; a page message is posted through the handler the
 * panel itself registered, exactly as its revoke and remove buttons post them.
 * ------------------------------------------------------------------------------------------------------------------- */
/** The open Security page as it is now, without running the command (which would redraw it). */
const openSecurityHtml = (): string => host.panels.get('unode.security')?.webview.html ?? '';
async function securityPage(): Promise<string> {
  await host.commands.get('unode.showSecurity')!();
  await flush(10);
  return host.panels.get('unode.security')!.webview.html;
}
async function securityMessage(message: Record<string, unknown>): Promise<void> {
  await securityPage();
  const panel = host.panels.get('unode.security')!;
  expect(panel.receive, 'the Security panel listens to its page').toBeDefined();
  panel.receive!(message);
  await flush(10);
  await screen.pump();
}
/** The id behind a File access grant's revoke button, found in the row that names the folder. */
const pathGrantId = (html: string, folder: string): string | undefined => html.split('<li>')
  .find((row) => row.includes(`<code>${folder}</code>`) && row.includes('data-path-grant='))
  ?.match(/data-path-grant="([^"]+)"/)?.[1];
const writableRoots = (policy: any): string[] => (Array.isArray(policy?.writableRoots) ? policy.writableRoots : []);
const answersSince = (since: number) => fakeLog().slice(since).filter((entry) => entry.event === 'answer').map((entry) => [entry.id, entry.decision]);
/** One turn of an agent that only replies: returns the sandbox policy its turn started with. */
async function plainTurn(agentId: string, reply: string): Promise<any> {
  setScenario({ escapes: [], sandboxAttemptBetween: false, reply });
  const since = fakeLog().length;
  await screen.select(agentId);
  await screen.send('Any news?');
  const replied = () => history(agentId).some((message) => message.role === 'agent' && message.text === reply);
  await until(replied);
  expect(replied(), JSON.stringify(fakeLog().slice(since).map((e) => [e.event, e.message?.method]))).toBe(true);
  return lastTurnPolicy(since);
}

describe.runIf(process.platform === 'win32')('v0.9.102 Codex card choices through activate(): the crew grant, a stale network card, a failed grant, a ceiling', () => {
  it('20b: a folder granted from one agent\'s card reaches the next turns of that agent and another; revoked in Security, it reaches neither', async () => {
    const command = writeInto(crewFolder);
    setScenario({ escapes: [command, command], sandboxAttemptBetween: true, reply: 'CrewA wrote cmd.txt.' });
    await screen.select('crew-a');
    await screen.send(`Using a shell command, create cmd.txt containing hi in ${crewFolder}.`);
    await until(() => screen.cards().length > 0);
    const grantLabel = `Grant ${crewFolder} Read + Write to the crew for this session, then run once`;
    expect(screen.cards()[0].buttons).toEqual(['Allow once', grantLabel, 'Deny']);
    await screen.press(grantLabel);
    await until(() => historyText('crew-a').includes('CrewA wrote cmd.txt.'));
    // The grant is the crew's: the next turn of A and a turn of B both start with the folder writable.
    const sinceA = fakeLog().length;
    const policyA = await plainTurn('crew-a', 'CrewA next turn.');
    expect(writableRoots(policyA).some((root) => sameFolder(root, crewFolder)), JSON.stringify({ crewFolder, policyA,
      log: fakeLog().slice(sinceA).map((e) => [e.pid, e.event, e.message?.method, e.message?.params?.sandboxPolicy?.writableRoots ?? e.message?.params?.runtimeWorkspaceRoots]),
      history: history('crew-a').map((m) => m.text.slice(0, 120)) })).toBe(true);
    expect(writableRoots(await plainTurn('crew-b', 'CrewB first turn.')).some((root) => sameFolder(root, crewFolder))).toBe(true);

    // The person revokes it in Security.
    const id = pathGrantId(await securityPage(), crewFolder);
    expect(id, await securityPage()).toBeDefined();
    await securityMessage({ command: 'revokePathAccess', id });
    expect(pathGrantId(await securityPage(), crewFolder)).toBeUndefined();
    expect(writableRoots(await plainTurn('crew-a', 'CrewA after revoke.')).some((root) => sameFolder(root, crewFolder))).toBe(false);
    expect(writableRoots(await plainTurn('crew-b', 'CrewB after revoke.')).some((root) => sameFolder(root, crewFolder))).toBe(false);
  });

  // v0.9.103 (release chain on 42a84185): the escape reached the host before the answer carrying the turn's id, and the
  // card's record line and the decline's reason were dropped from the chat. Here that order is made certain.
  it('17b: an escape that arrives before the turn\'s id still writes its card record in the chat when it is declined', async () => {
    await screen.select('racer');
    const command = download();
    setScenario({ escapes: [command], sandboxAttemptBetween: false, networkContext: true, reply: 'Racer early download.', escapeBeforeTurnReply: true });
    const since = fakeLog().length;
    await screen.send('Download it early.');
    await until(() => screen.cards().length > 0);
    expect(screen.cards()[0].buttons).toContain('Deny');
    await screen.press('Deny');
    await until(() => historyText('racer').includes('Racer early download.'));
    expect(answersSince(since)).toEqual([['escape-1', 'decline']]);
    await until(() => /Codex command \(powershell\): declined at/.test(historyText('racer')));
    expect(historyText('racer'), JSON.stringify(history('racer').map((m) => m.text.slice(0, 160)))).toMatch(/Codex command \(powershell\): declined at/);
  });

  // Codex's audit of bb22ed26: in the same order, the person's note on Deny went nowhere: it was kept with no turn id and
  // never sent. It is sent on this turn, with the id the turn has by then.
  it('17c: an escape that arrives before the turn\'s id: the note typed on Deny reaches Codex on that turn', async () => {
    await screen.select('racer');
    const command = download();
    setScenario({ escapes: [command], sandboxAttemptBetween: false, networkContext: true, reply: 'Racer noted download.', escapeBeforeTurnReply: true });
    const since = fakeLog().length;
    await screen.send('Download it, early again.');
    await until(() => screen.cards().length > 0);
    const field = (screen.cards()[0].card.children as any[]).flatMap(function all(node: any): any[] { return [node, ...((node?.children ?? []) as any[]).flatMap(all)]; })
      .find((node: any) => node.className === 'appr-note');
    expect(field, 'the card note field').toBeDefined();
    field.value = 'Use the local archive instead of downloading.';
    await screen.press('Deny');
    await until(() => historyText('racer').includes('Racer noted download.'));
    expect(answersSince(since)).toEqual([['escape-1', 'decline']]);
    const steers = () => fakeLog().slice(since).filter((entry) => entry.event === 'received' && entry.message?.method === 'turn/steer');
    await until(() => steers().length > 0);
    expect(steers()).toHaveLength(1);
    expect(steers()[0].message.params.expectedTurnId).toBe('turn-1');
    expect(JSON.stringify(steers()[0].message.params.input)).toContain('Use the local archive instead of downloading.');
  });

  it('17: a network card answered after network was removed in Security changes nothing and runs nothing; the next turn has network off', async () => {
    await screen.select('racer');
    const command = download();
    const allowLabel = 'Allow network for Racer for this session, then run once';
    // Network is allowed for Racer from a card, as in the network flow.
    setScenario({ escapes: [command], sandboxAttemptBetween: false, networkContext: true, reply: 'Racer first download.' });
    let since = fakeLog().length;
    await screen.send('Download the example page.');
    await until(() => screen.cards().length > 0);
    expect(screen.cards()[0].buttons).toContain(allowLabel);
    await screen.press(allowLabel);
    await until(() => historyText('racer').includes('Racer first download.'));
    expect(answersSince(since)).toEqual([['escape-1', 'accept']]);

    // A new card opens; before the person answers it, network is removed in Security.
    setScenario({ escapes: [command], sandboxAttemptBetween: false, networkContext: true, reply: 'Racer second download.' });
    since = fakeLog().length;
    await screen.send('Download it once more.');
    await until(() => screen.cards().length > 0);
    expect(screen.cards()[0].buttons).toContain(allowLabel);
    await securityMessage({ command: 'removeCodexSessionNetwork', agentId: 'racer' });
    await screen.press(allowLabel);
    await until(() => historyText('racer').includes('Racer second download.'));
    expect(answersSince(since)).toEqual([['escape-1', 'decline']]);
    // The notice is posted by its own update, which under the full suite's load can come after the turn's reply
    // (release chain on aab3fa18, Node 25): wait for it, bounded, before asserting it.
    await until(() => historyText('racer').includes('Network for this agent changed while the card was open'));
    expect(historyText('racer'), JSON.stringify(history('racer').map((m) => m.text.slice(0, 160)))).toContain('Network for this agent changed while the card was open');

    // The next turn: a new App Server with network off, and the turn's sandbox says so.
    since = fakeLog().length;
    const policy = await plainTurn('racer', 'Racer third turn.');
    expect(policy, JSON.stringify(fakeLog().slice(since).map((e) => [e.event, e.message?.method]))).toMatchObject({ type: 'workspaceWrite', networkAccess: false });
    const started = fakeLog().slice(since).filter((entry) => entry.event === 'start' && entry.argv?.[0] === 'app-server');
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(started.at(-1)!.argv).toEqual(expect.arrayContaining(['sandbox_workspace_write.network_access=false']));
  });

  it('a folder that is gone when Grant is pressed: nothing is granted and nothing runs, and the chat says why', async () => {
    const command = writeInto(doomed);
    setScenario({ escapes: [command, command], sandboxAttemptBetween: true, reply: 'Failer could not write.' });
    const since = fakeLog().length;
    await screen.select('failer');
    await screen.send(`Using a shell command, create cmd.txt containing hi in ${doomed}.`);
    await until(() => screen.cards().length > 0);
    const grantLabel = `Grant ${doomed} Read + Write to the crew for this session, then run once`;
    expect(screen.cards()[0].buttons).toContain(grantLabel);
    fs.rmSync(doomed, { recursive: true, force: true });
    await screen.press(grantLabel);
    await until(() => historyText('failer').includes('Failer could not write.'));
    expect(answersSince(since)).toEqual([['escape-1', 'decline'], ['escape-2', 'decline']]);
    expect(historyText('failer'), JSON.stringify(history('failer').map((m) => m.text.slice(0, 160)))).toContain('The folder could not be granted');
    expect(pathGrantId(await securityPage(), doomed)).toBeUndefined();
  });

  it('an agent with a Folder Access ceiling: an escape is refused before any card, so no folder grant is ever offered', async () => {
    const command = writeInto(ceilingNamed);
    setScenario({ escapes: [command, command], sandboxAttemptBetween: true, reply: 'Fenced did not write.' });
    const since = fakeLog().length;
    await screen.select('fenced');
    await screen.send(`Using a shell command, create cmd.txt containing hi in ${ceilingNamed}.`);
    // Watch the page the whole time: no card appears for this agent's escapes.
    let cardsSeen = 0;
    await until(() => {
      cardsSeen = Math.max(cardsSeen, screen.cards().length);
      return history('fenced').some((message) => message.role === 'agent' && message.text === 'Fenced did not write.');
    });
    expect(history('fenced').some((message) => message.role === 'agent' && message.text === 'Fenced did not write.'),
      JSON.stringify(fakeLog().slice(since).filter((e) => e.event !== 'start').map((e) => [e.event, e.message?.method, e.id, e.decision]))).toBe(true);
    expect(cardsSeen).toBe(0);
    // The Folder Access ceiling is a host floor: both escapes are declined at once, with no redirect and no grant.
    expect(answersSince(since)).toEqual([['escape-1', 'decline'], ['escape-2', 'decline']]);
    expect(historyText('fenced')).not.toContain(CODEX_REDIRECT_LINE);
    expect(historyText('fenced')).not.toMatch(/^Codex command \(/m);
    expect(pathGrantId(await securityPage(), ceilingNamed)).toBeUndefined();
  });
});

/*
 * v0.9.105 (field smoke F8.3): a Codex agent read an installed skill outside the workspace with the host's read_file; it
 * was refused and nothing offered Grant access. Through activate(), the fake App Server calls read_file on a file in a
 * folder no grant covers: the read is refused, and the person is offered Grant access for that file, as a notice and as
 * the request's item on the chat page. Nothing here is emitted by the test.
 */
describe.runIf(process.platform === 'win32')('v0.9.105 Codex host read_file outside every folder, through activate()', () => {
  it('a refused read_file offers Grant access for the file: a notice and an item on the chat page', async () => {
    // A folder of its own, so no grant an earlier flow made can cover it; the agent is one already running (the window
    // runs at most 10 agents).
    const skill = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'unode-codex-skill-')));
    const target = path.join(skill, 'SKILL.md');
    fs.writeFileSync(target, 'field word');
    setScenario({ escapes: [], sandboxAttemptBetween: false, reply: 'I could not read the skill.', readFile: { path: target } });
    const before = fakeLog().length;
    const warningsBefore = host.warnings.length;
    await screen.select('solo');
    await screen.send('What is the field word? Use your installed skill.');
    await until(() => historyText('solo').includes('I could not read the skill.'));
    const answer = fakeLog().slice(before).find((entry) => entry.event === 'answer' && entry.id === 'read-file-1') as (LogEntry & { result?: { success?: boolean; contentItems?: Array<{ text?: string }> } }) | undefined;
    expect(answer?.result?.success, JSON.stringify({ answer, warnings: host.warnings.slice(warningsBefore) })).toBe(false);
    expect(answer?.result?.contentItems?.[0]?.text).toContain('workspace-escape');
    expect(answer?.result?.contentItems?.[0]?.text).not.toContain('field word');
    const notices = host.warnings.slice(warningsBefore);
    expect(notices.filter((text) => text.includes('Solo could not reach it with the file tools') && text.includes(target)),
      JSON.stringify(notices)).toHaveLength(1);
    await until(() => screen.transcript().includes('File SKILL.md — not granted yet'));
    expect(screen.transcript()).toContain('File SKILL.md — not granted yet');
    fs.rmSync(skill, { recursive: true, force: true });
  });
});

/*
 * v0.9.105 D5-1: Codex's own per-app Computer Use card, through activate(). The fake App Server sends the request in the
 * shape the probe of 2026-11-16 recorded on Codex 0.169; before D5-1 UnodeAi declined it without
 * showing it. The card asks Codex's own question, offers only the lasting choices Codex offered, and the answer reaches
 * App Server in the form Codex's own client uses.
 */
describe.runIf(process.platform === 'win32')('v0.9.105 Codex Computer Use card through activate()', () => {
  const computerUseTurn = async (persist: string[], press: string, reply: string) => {
    setScenario({ escapes: [], sandboxAttemptBetween: false, reply, computerUse: { app: 'Notepad', persist } });
    const before = fakeLog().length;
    await screen.select('asker');
    await screen.send('Look at Notepad and tell me its window title.');
    await until(() => screen.cards().length > 0);
    const [card] = screen.cards();
    const text = card.text;
    // Nothing is answered before the person's click.
    expect(fakeLog().slice(before).filter((entry) => entry.event === 'answer')).toEqual([]);
    const buttons = card.buttons;
    await screen.press(press);
    await until(() => historyText('asker').includes(reply));
    const answers = fakeLog().slice(before).filter((entry) => entry.event === 'answer') as Array<LogEntry & { persist?: string; result?: unknown }>;
    return { buttons, text, answers };
  };

  it('the card asks Codex\'s question with the choices Codex offered; "Allow for this conversation" answers accept with persist session', async () => {
    const { buttons, text, answers } = await computerUseTurn(['session', 'always'], 'Allow for this conversation', 'Notepad is open.');
    expect(buttons).toEqual(['Allow once', 'Allow for this conversation', 'Always allow Notepad', 'Deny']);
    expect(text).toContain('Allow Codex to use Notepad?');
    expect(text).toContain('Computer Use: Notepad');
    expect(answers.map((entry) => [entry.id, entry.decision, entry.persist])).toEqual([['computer-use-1', 'accept', 'session']]);
    expect(answers[0].result).toEqual({ action: 'accept', content: {}, _meta: { persist: 'session' } });
    // v0.9.105 (D5-1, Codex's audit of bad9b468): the Computer Use action itself arrives as Codex's own MCP item; its
    // row on the chat page says Codex ran it and UnodeAi did not approve or check it, and that Codex's own permission
    // question (the card just answered) is shown as a card. Nothing here is emitted by the test: the fake App Server
    // sends the item, and the row is what the real page shows.
    await until(() => screen.transcript().includes('Codex-native MCP · node_repl · js'));
    const shown = screen.transcript();
    expect(shown).toContain('Run by Codex itself; UnodeAi does not approve or check this call.');
    expect(shown).toContain('such as Computer Use asking to use an app, is shown to you as a card');
    expect(shown).not.toContain('not approved or mediated by UnodeAi');
  });

  it('"Always allow" answers accept with persist always; "Allow once" answers accept with no lasting choice', async () => {
    const always = await computerUseTurn(['session', 'always'], 'Always allow Notepad', 'Notepad is open again.');
    expect(always.answers[0].result).toEqual({ action: 'accept', content: {}, _meta: { persist: 'always' } });
    const once = await computerUseTurn(['session', 'always'], 'Allow once', 'Notepad is open once.');
    expect(once.answers[0].result).toEqual({ action: 'accept', content: {} });
  });

  it('a choice Codex did not offer is not on the card, and Deny declines it', async () => {
    const { buttons, answers } = await computerUseTurn(['always'], 'Deny', 'I could not use Notepad.');
    expect(buttons).toEqual(['Allow once', 'Always allow Notepad', 'Deny']);
    expect(answers.map((entry) => [entry.id, entry.decision, entry.persist])).toEqual([['computer-use-1', 'decline', undefined]]);
    expect(answers[0].result).toEqual({ action: 'decline' });
  });
});
