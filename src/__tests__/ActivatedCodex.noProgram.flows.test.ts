import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * v0.9.106 retest R3, through the extension's real entry: a profile that never chose a Codex CLI (unode.codexCliPath
 * empty). A new Codex reviewer's start passed the empty setting to realpath and showed only "ENOENT: no such file or
 * directory, realpath ''". Now an agent's start asks with Check / choose CLI, under a title that says why it opened,
 * and with nothing chosen the chat says no Codex CLI is selected and where to choose one. `activate()` runs with only
 * the VS Code API stood in; the Codex program, once chosen, runs as the scripted fake App Server of
 * ActivatedCodex.flows.test.ts. Not a native VS Code host: no window, no real webview, no network, no real Codex.
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
import { NO_PROGRAM_TEXT } from '../host/cliRuntimeResolver';

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
    update: async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, structuredClone(value)); },
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

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'unode-activated-codex-unset-')));
const workspace = path.join(base, 'ws');
fs.mkdirSync(workspace, { recursive: true });
const context = {
  subscriptions: [] as { dispose(): void }[], globalState: memento(), workspaceState: memento(),
  extensionUri: { fsPath: process.cwd() }, extensionPath: process.cwd(), globalStorageUri: { fsPath: path.join(base, '.global') },
  storageUri: { fsPath: path.join(base, '.storage') }, logUri: { fsPath: path.join(base, '.log') }, extensionMode: 3, extension: { packageJSON: {} },
  secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
  asAbsolutePath: (value: string) => value, environmentVariableCollection: { replace() {}, clear() {} },
};

function codexAgent(id: string, name: string): AgentConfig {
  const config = new AgentConfigBuilder().fromTemplate('solo').setProviderById('codex-cli').setId(id).setName(name).setModel('gpt-test').build();
  config.backend = 'codex';
  return config;
}

/** The person's settings: nothing chosen for the Codex CLI. */
const userValues = new Map<string, unknown>();
/** Every list the window showed, by its title and placeholder. */
const picks: Array<{ title?: string; placeHolder?: string; labels: string[] }> = [];
let onPick: () => void = () => {};
/** The button the person presses on a notification, by its text and buttons; none by default. */
let answerNotice: (text: string, buttons: string[]) => string | undefined = () => undefined;
let screen: ReturnType<typeof chatScreen>;
let chatProvider: any;
const historyText = (agentId: string): string => (chatProvider.loadHistory(agentId) as Array<{ text: string }>).map((m) => m.text).join('\n');

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
    host.overrides[`vscode.window.${method}`] = vi.fn(async (text: string, ...rest: unknown[]) => {
      list.push(String(text));
      return answerNotice(String(text), rest.filter((item): item is string => typeof item === 'string'));
    });
  }
  host.overrides['vscode.window.showQuickPick'] = vi.fn(async (items: unknown, options?: { title?: string; placeHolder?: string }) => {
    const labels = Array.isArray(items) ? items.map((item) => String((item as { label?: unknown }).label ?? '')) : [];
    picks.push({ title: options?.title, placeHolder: options?.placeHolder, labels });
    onPick();
    return undefined;
  });
  setScenario({ escapes: [], sandboxAttemptBetween: false, reply: '' });
  await new PersistenceManager(context as never, undefined, () => workspace, undefined, undefined,
    new RootScopedWorkspaceState(context.workspaceState as never, workspace)).saveAgents([
    codexAgent('declined', 'Codex Reviewer'),
    codexAgent('chosen', 'Second Reviewer'),
  ]);
  const extension = await import('../extension');
  await extension.activate(context as never);
  chatProvider = host.views.get('unode.chat');
  expect(chatProvider, 'activation registers the chat view').toBeDefined();
  screen = chatScreen(chatProvider);
  await screen.pump();
});

afterAll(async () => {
  for (const sub of context.subscriptions.splice(0)) { try { sub.dispose(); } catch { /* ignore */ } }
  await flush(20);
  for (const folder of [base, host.binFolder]) { try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* a process may still hold it */ } }
});

/** Bounded by wall-clock time, so waits in a row cannot add up past the mutation engine's 60 s per case. */
async function until(condition: () => boolean, deadlineMs = 20_000): Promise<void> {
  const deadline = process.hrtime.bigint() + BigInt(deadlineMs) * 1_000_000n;
  while (!condition()) {
    if (process.hrtime.bigint() >= deadline) throw new Error(`Waited ${deadlineMs / 1_000} s by the process clock for: ${condition.toString()}`);
    await screen.pump();
  }
}

// Only this list is counted.
const METADATA_TITLE = 'Allow model metadata requests?';
const TITLE = 'An agent needs a Codex CLI to start: choose one';
const OPEN_PROVIDERS = 'Open Settings: Providers';
const seen = (agentId: string) => historyText(agentId) + '\n' + screen.transcript();

describe.runIf(process.platform === 'win32')('v0.9.106 retest R3: a Codex agent\'s start with no Codex CLI chosen, through activate()', () => {
  it('asks with Check / choose CLI under a title that says why; closed, the chat says no Codex CLI is selected, never realpath', async () => {
    const before = picks.length;
    onPick = () => {};
    // NC-1: the person presses the refusal notice's one button. A registered command runs as VS Code would run it.
    answerNotice = (_text, buttons) => (buttons.includes(OPEN_PROVIDERS) ? OPEN_PROVIDERS : undefined);
    host.overrides['vscode.commands.executeCommand'] = async (name: string, ...args: unknown[]) => host.commands.get(name)?.(...args);
    const warningsBefore = host.warnings.length;
    await screen.select('declined');
    await screen.send('Review add.js.');
    await until(() => seen('declined').includes(NO_PROGRAM_TEXT['codex-cli']));
    expect(picks.slice(before).filter((pick) => pick.title === TITLE)).toHaveLength(1);
    // Retest R3: the list came first. registry.npmjs.org is not allowed, so nothing asked for it and the list says the
    // latest version was not looked up.
    const list = picks.slice(before).find((pick) => pick.title === TITLE)!;
    expect(list.placeHolder).toMatch(/^The latest Codex CLI version was not looked up\. Choose a Codex CLI to check\./);
    expect(picks.slice(before).filter((pick) => pick.title === METADATA_TITLE || pick.labels.includes('registry.npmjs.org'))).toEqual([]);
    expect(seen('declined')).not.toMatch(/ENOENT|realpath/);
    expect(fakeLog()).toEqual([]);
    expect(userValues.has('unode.codexCliPath')).toBe(false);

    // NC-1: the chat names the real places in numbered steps, and the notice opens Settings on its Providers tab.
    expect(historyText('declined')).toContain('To choose one:\n1. Open UnodeAi Settings and its Providers tab.\n'
      + '2. On the Codex CLI card, choose Check / choose CLI…, pick a program and confirm Use this CLI.\n3. Send your message again.');
    await until(() => (host.panels.get('unodeSettings')?.webview.html ?? '').includes('class="tab active" data-tab="providers"'));
    expect(host.warnings.slice(warningsBefore).filter((text) => text.includes('did not start'))).toEqual(['Codex Reviewer did not start: no Codex CLI is selected. In UnodeAi Settings, '
      + 'open Providers, then choose Check / choose CLI… on the Codex CLI card. Then try again.']);
    // Opening Settings chose nothing: no program was saved.
    expect(userValues.has('unode.codexCliPath')).toBe(false);
    answerNotice = () => undefined;
    delete host.overrides['vscode.commands.executeCommand'];

    // Start pressed on the agent's row asks again; closed, the same notice comes once, not the plain error as well.
    const startWarnings = host.warnings.length;
    await host.commands.get('unode.agentStart')!('declined');
    await until(() => host.warnings.slice(startWarnings).some((text) => text.includes('did not start')));
    await screen.pump();
    expect(host.warnings.slice(startWarnings).filter((text) => text.includes('did not start'))).toHaveLength(1);
    expect(host.warnings.slice(startWarnings).filter((text) => text.includes('No Codex CLI is selected'))).toEqual([]);
    expect(picks.slice(before).filter((pick) => pick.title === TITLE)).toHaveLength(2);
    expect(picks.slice(before).filter((pick) => pick.title === METADATA_TITLE)).toEqual([]);

    // The Settings path is unchanged: Check / choose CLI… on the card still asks for registry.npmjs.org before its list.
    const settingsBefore = picks.length;
    const settings = host.panels.get('unodeSettings')!;
    expect(settings.webview.html).toContain('data-command="chooseCliExecutable" data-provider-id="codex"');
    settings.receive!({ command: 'chooseCliExecutable', providerId: 'codex' });
    await until(() => picks.slice(settingsBefore).some((pick) => pick.title === 'Check / choose the Codex CLI'));
    const order = picks.slice(settingsBefore).map((pick) => pick.title);
    expect(order.indexOf(METADATA_TITLE)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(METADATA_TITLE)).toBeLessThan(order.indexOf('Check / choose the Codex CLI'));
    expect(picks.slice(settingsBefore).find((pick) => pick.title === METADATA_TITLE)?.labels).toEqual(['registry.npmjs.org']);
    expect(userValues.has('unode.codexCliPath')).toBe(false);
  });

  it('a program saved while the question is open is the one this start uses', async () => {
    const before = picks.length;
    setScenario({ escapes: [], sandboxAttemptBetween: false, reply: 'Reviewed: no finding.' });
    // What Check / choose CLI saves once the person confirms a program: the setting, which the start reads again.
    onPick = () => { userValues.set('unode.codexCliPath', host.codexExe); };
    await screen.select('chosen');
    await screen.send('Review add.js.');
    await until(() => historyText('chosen').includes('Reviewed: no finding.'));
    expect(picks.slice(before).filter((pick) => pick.title === TITLE)).toHaveLength(1);
    expect(seen('chosen')).not.toContain(NO_PROGRAM_TEXT['codex-cli']);
    expect(fakeLog().some((entry) => entry.event === 'received' && entry.message?.method === 'turn/start')).toBe(true);
  });
});
