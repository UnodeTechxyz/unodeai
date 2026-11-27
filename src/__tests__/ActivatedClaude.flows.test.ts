import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

/**
 * v0.9.103 (the Owner, 2026-11-14; design draft 3, acceptance §4 flows (a)-(f)): a message the person sends while a
 * Claude agent works, through the extension's real entry. `activate()` runs with only the VS Code API stood in and one
 * process start redirected: the configured Claude program (a real file chosen with unode.claudeCliPath) is run as a relay
 * to this test, which plays the Claude CLI over its stream-json stdio with the facts the live probe on Claude CLI 2.1.318
 * showed (design §2). Everything between, the program resolver, the consent, the Claude backend with its loopback
 * bridges, TeamTools, the session manager, the spend ledger, the chat and its page, is what activation itself builds.
 * The one other stand-in is the EndTurn execution hook of flow (d): its declaration is a real setting, its approval and
 * its action are replaced by a barrier the test opens. A person's message is typed into the chat page and sent with its
 * Send button. Not a native VS Code host: no window, no real webview, no network, no real Claude.
 * Its own file, beside the activated flows of v0.9.102: a window has one coordinator, and here it is a Claude PM.
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
  // The Claude program the person chose: a real file in its own folder. Its starts are redirected below.
  const binFolder = nodeFs.realpathSync.native(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'unode-claude-bin-')));
  const claudeExe = nodePath.join(binFolder, 'claude.exe');
  nodeFs.writeFileSync(claudeExe, 'not a real program: its starts run the relay to the test');
  const relay = nodePath.join(process.cwd(), 'src', '__tests__', 'fixtures', 'fakeClaudeRelay.cjs');
  return { overrides, commands, views, warnings, infos, stub, claudeExe, relay, binFolder, port: 0 };
});

/** The EndTurn barrier of flow (d): while `hold` is set, the hook waits for its gate. */
const endTurn = vi.hoisted(() => ({ hold: undefined as undefined | { entered: () => void; gate: Promise<void> } }));

/** Only the start of the chosen Claude program is redirected, to the relay; every other process start is real. */
function routedChildProcess(actual: typeof import('child_process')) {
  const isClaude = (command: unknown) => typeof command === 'string'
    && path.resolve(command.replace(/^"|"$/g, '')).toLowerCase() === host.claudeExe.toLowerCase();
  const spawn = ((command: string, args?: readonly string[] | object, options?: object) => {
    if (!isClaude(command)) return (actual.spawn as any)(command, args, options);
    const argv = Array.isArray(args) ? args : [];
    const opts = Array.isArray(args) ? options : args;
    return actual.spawn(process.execPath, [host.relay, String(host.port), ...argv], { ...(opts as object ?? {}), shell: false } as any);
  }) as typeof actual.spawn;
  return { ...actual, spawn, default: { ...actual, spawn } };
}
vi.mock('child_process', async (importOriginal) => routedChildProcess(await importOriginal<typeof import('child_process')>()));
vi.mock('node:child_process', async (importOriginal) => routedChildProcess(await importOriginal<typeof import('child_process')>()));

/**
 * The program-file hashing worker runs from its own TypeScript source, so these flows need no compiled out/ folder
 * (a mutation sandbox has none). It is the same worker code, transpiled here; the hasher around it is unchanged.
 */
vi.mock('../backend/cliClosure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend/cliClosure')>();
  const ts = await import('typescript');
  const { Worker } = await import('node:worker_threads');
  const source = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'backend', 'cliClosureWorker.ts'), 'utf8') as string;
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  class SourceWorkerHasher extends actual.ClosureHasher {
    constructor(options: ConstructorParameters<typeof actual.ClosureHasher>[0] = {}) {
      super({ ...options, startWorker: options?.startWorker ?? (() => new Worker(code, { eval: true })) });
    }
  }
  return { ...actual, ClosureHasher: SourceWorkerHasher };
});

/** The EndTurn hook's approval and action: the declaration comes from the setting; its action is the barrier. */
vi.mock('../backend/ExecutionHooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend/ExecutionHooks')>();
  return {
    ...actual,
    constructApprovedExecutionHooks: (candidate: { declarations: any[] }) => (candidate.declarations.length === 0 ? undefined
      : new actual.HostExecutionHooks(candidate.declarations as any, new Map([['end-barrier', async () => {
        const hold = endTurn.hold;
        if (hold) { hold.entered(); await hold.gate; }
        return {};
      }]]))),
  };
});

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
    'vscode.workspace.onDidGrantWorkspaceTrust': () => new Disposable(),
    'vscode.workspace.isTrusted': true,
    'vscode.env.appName': 'Visual Studio Code',
    'vscode.env.sessionId': 'activated-claude-flows-window',
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
import { TeamTools, PUBLICATION_STEER_PENDING_ERROR } from '../backend/TeamTools';
import { STEER_QUEUED_NOTICE } from '../session/SessionManager';
import { unreadSteerNotice } from '../backend/AgentBackend';
import { OFFER_ENDED_NOTICE, continueMessageText } from '../host/unrequestedTurnOffer';

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
 * The Claude CLI, played by the test: each relay connection is one CLI process; its stdin packets arrive here, and the
 * events sent back are its stream-json stdout.
 * ------------------------------------------------------------------------------------------------------------------- */
type Packet = { type: string; uuid?: string; message?: { role: string; content: unknown } };
type Cli = { pid: number; argv: string[]; cwd: string; packets: Packet[]; socket: net.Socket; closed: boolean };
const clis: Cli[] = [];
let server: net.Server;

const textOf = (content: unknown): string => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join('') : '');
const send = (cli: Cli, ...events: unknown[]) => { cli.socket.write(events.map((event) => `${JSON.stringify(event)}\n`).join('')); };
const userPackets = (cli: Cli): Packet[] => cli.packets.filter((packet) => packet.type === 'user');
/** The CLI starts a packet: `command_lifecycle` started for its uuid (the acknowledgement that confirms support). */
const acknowledge = (cli: Cli, packet: Packet) => send(cli, { type: 'command_lifecycle', command_uuid: packet.uuid, state: 'started', uuid: randomUUID(), session_id: 's' });
/** The CLI reads a packet: its replay echo with our uuid. */
const echo = (cli: Cli, packet: Packet) => send(cli, { type: 'user', isReplay: true, uuid: packet.uuid, session_id: 's', parent_tool_use_id: null,
  timestamp: new Date().toISOString(), message: packet.message });
const say = (cli: Cli, text: string) => send(cli,
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
  { type: 'assistant', message: { id: `msg-${randomUUID()}`, content: [{ type: 'text', text }] } });
const cliInit = (cli: Cli) => send(cli, { type: 'system', subtype: 'init', model: 'claude-sonnet-4-5', session_id: 's' });
const cliResult = (cli: Cli, text: string, total: number, fields: Record<string, unknown> = {}) => send(cli, {
  type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: total, num_turns: 1,
  usage: { input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 90, output_tokens: 16 }, ...fields,
});

/** A loopback MCP call the CLI makes to one of the bridges the extension gave it in its --mcp-config. */
async function callBridge(cli: Cli, prefix: string, tool: string, args: Record<string, unknown>, toolUseId: string): Promise<{ text: string; isError: boolean }> {
  const at = cli.argv.indexOf('--mcp-config');
  const config = JSON.parse(fs.readFileSync(path.resolve(cli.cwd, cli.argv[at + 1]), 'utf8')) as { mcpServers: Record<string, { url: string; headers?: Record<string, string> }> };
  const entry = Object.entries(config.mcpServers).find(([id]) => id.startsWith(prefix));
  expect(entry, `the CLI was given a ${prefix} bridge`).toBeDefined();
  const url = new URL(entry![1].url);
  const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call',
    params: { name: tool, arguments: args, _meta: { 'claudecode/toolUseId': toolUseId } } });
  const response = await new Promise<any>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: Number(url.port), path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(entry![1].headers ?? {}) } }, (res) => {
      let out = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { out += chunk; }); res.on('end', () => resolve(out ? JSON.parse(out) : undefined));
    });
    req.on('error', reject);
    req.end(body);
  });
  return { text: textOf(response?.result?.content), isError: response?.result?.isError === true };
}

/** The model calls a bridge tool: its tool_use, the MCP call, then the CLI's tool_result with exactly what came back. */
async function bridgeTool(cli: Cli, prefix: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const toolUseId = `toolu_${randomUUID().replace(/-/g, '')}`;
  const serverId = Object.keys(JSON.parse(fs.readFileSync(path.resolve(cli.cwd, cli.argv[cli.argv.indexOf('--mcp-config') + 1]), 'utf8')).mcpServers)
    .find((id) => id.startsWith(prefix))!;
  send(cli, { type: 'assistant', message: { id: `msg-${randomUUID()}`, content: [{ type: 'tool_use', id: toolUseId, name: `mcp__${serverId}__${tool}`, input: args }] } });
  const result = await callBridge(cli, prefix, tool, args, toolUseId);
  send(cli, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: result.text }],
    ...(result.isError ? { is_error: true } : {}) }] } });
  const receiptId = /receipt-[0-9a-f-]{36}/.exec(result.text)?.[0];
  if (prefix === 'unode_files' && receiptId) {
    await until(() => receiptObservation.mock.calls.some(([id], index) => id === receiptId
      && receiptObservation.mock.results[index]?.value === true), 'the host observed the exact CLI tool_result receipt');
  }
  return result;
}

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
  return {
    pump,
    /** The Send button as the person sees it: its glyph and its accessible name. */
    composer: () => {
      const button = page!.elements.get('send') as any;
      return { glyph: String(button.textContent), label: String(button.getAttribute('aria-label')) };
    },
    hint: () => String((page!.elements.get('steerHint') as any)?.textContent ?? ''),
    stop: async () => {
      await pump();
      const button = page!.elements.get('stop') as any;
      expect(button.hidden, 'Stop is shown while the agent is in its turn').toBe(false);
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
 * The window: a real temporary workspace, a team of Claude agents saved there before the window opened, and activate().
 * ------------------------------------------------------------------------------------------------------------------- */
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'unode-activated-claude-')));
const workspace = path.join(base, 'ws');
// The extension's own files that a Claude start reads: the PreToolUse gate it ships at out/claudeToolGate.cjs, and its
// skills. The test runs from source, so they are laid out the way the package has them.
const extensionRoot = path.join(base, 'extension');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(path.join(extensionRoot, 'out'), { recursive: true });
fs.copyFileSync(path.join(process.cwd(), 'src', 'claudeToolGate.cjs'), path.join(extensionRoot, 'out', 'claudeToolGate.cjs'));
fs.cpSync(path.join(process.cwd(), 'skills'), path.join(extensionRoot, 'skills'), { recursive: true });
const context = {
  subscriptions: [] as { dispose(): void }[], globalState: memento(), workspaceState: memento(),
  extensionUri: { fsPath: extensionRoot }, extensionPath: process.cwd(), globalStorageUri: { fsPath: path.join(base, '.global') },
  storageUri: { fsPath: path.join(base, '.storage') }, logUri: { fsPath: path.join(base, '.log') }, extensionMode: 3, extension: { packageJSON: {} },
  secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
  asAbsolutePath: (value: string) => value, environmentVariableCollection: { replace() {}, clear() {} },
};

function claudeAgent(template: string, id: string, name: string): AgentConfig {
  const config = new AgentConfigBuilder().fromTemplate(template).setProviderById('claude-cli').setId(id).setName(name).setModel('claude-sonnet-4-5').build();
  config.backend = 'claude';
  config.autoApprove = true;
  return config;
}

// Call through to production; observe delivery, never mark it from the fixture.
const receiptObservation = vi.spyOn(TeamTools.prototype, 'markTurnContentReceiptDelivered');
let screen: ReturnType<typeof chatScreen>;
let chatProvider: any;
const history = (agentId: string): Array<{ role: string; text: string; runtimeNotice?: boolean }> => chatProvider.loadHistory(agentId);
const replies = (agentId: string): string[] => history(agentId).filter((message) => message.role === 'agent' && !message.runtimeNotice).map((message) => message.text);
const notices = (agentId: string): string[] => history(agentId).filter((message) => message.runtimeNotice).map((message) => message.text);

/** Bounded well below a mutant run's 60 s, so a protection that is gone fails the flow rather than timing it out. */
/** v0.9.105 (CI 44007091429, 44017485725): bounded by wall-clock time from the process clock, never by a count of rounds. */
async function until(condition: () => boolean, label: string, deadlineMs = 30_000): Promise<void> {
  const deadline = process.hrtime.bigint() + BigInt(deadlineMs) * 1_000_000n;
  while (!condition() && process.hrtime.bigint() < deadline) await screen.pump();
  expect(condition(), `${label}: ${diagnosis()}`).toBe(true);
}

/** What the window and the CLI processes show, for a failure message. */
function diagnosis(): string {
  return JSON.stringify({
    clis: clis.map((cli) => ({ pid: cli.pid, closed: cli.closed, packets: cli.packets.map((packet) => [packet.type, textOf(packet.message?.content).slice(-80)]) })),
    warnings: host.warnings.slice(-5), infos: host.infos.slice(-5),
    history: Object.fromEntries(['pm', 'steer-a', 'queue-b', 'stop-e', 'restart-f', 'hold-g', 'wake-h', 'wake-i', 'wake-j'].map((id) => [id, history(id).slice(-6).map((message) => message.text.slice(0, 160))])),
  });
}

/** The CLI process of an agent: the newest open one whose first packet names it. */
function cliOf(agentId: string): Cli | undefined {
  return [...clis].reverse().find((cli) => !cli.closed && textOf(userPackets(cli)[0]?.message?.content).includes(`agent "${agentId}"`));
}

/**
 * The PM's chat selected and a PM process that has confirmed it reads messages sent while it works: the one still
 * running if an earlier case started it, otherwise one started here with a turn of its own, settled before returning.
 * Every case establishes what it needs, so each passes when it is selected alone (as a mutant run selects it).
 */
async function confirmedPm(): Promise<Cli> {
  await screen.select('pm');
  const running = cliOf('pm');
  if (running) return running;
  const settled = persistedReceipts().filter((receipt) => receipt.agentId === 'pm').length;
  await screen.send('Get ready for a few questions.');
  await until(() => !!cliOf('pm'), 'the PM\'s CLI started and got its turn');
  const cli = cliOf('pm')!;
  acknowledge(cli, userPackets(cli)[0]);
  cliResult(cli, 'Ready.', 0.01);
  await until(() => replies('pm').some((text) => text.includes('Ready.')), 'the PM\'s first turn ends');
  await until(() => persistedReceipts().filter((receipt) => receipt.agentId === 'pm').length === settled + 1, 'the PM\'s first turn is settled');
  return cli;
}

/** The usage receipts the spend ledger persisted in this window's storage. */
function persistedReceipts(): any[] {
  const found: any[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if ((value as { kind?: unknown }).kind === 'usage-receipt' && (value as { receipt?: unknown }).receipt) found.push((value as { receipt: unknown }).receipt);
    for (const child of Object.values(value as Record<string, unknown>)) visit(child);
  };
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.ndjson')) {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { visit(JSON.parse(line)); } catch { /* a line still being written */ }
        }
      }
    }
  };
  walk(path.join(context.globalStorageUri.fsPath, 'spend'));
  const unique = new Map<string, any>();
  for (const receipt of found) unique.set(receipt.receiptId, receipt);
  return [...unique.values()];
}

const savedApiKey = process.env.ANTHROPIC_API_KEY;

beforeAll(async () => {
  // The CLI's cost is an API-equivalent figure without an API key in its environment; keep that fixed for the receipts.
  delete process.env.ANTHROPIC_API_KEY;
  server = net.createServer((socket) => {
    let buffer = '';
    let cli: Cli | undefined;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        if (!cli) { cli = { ...parsed.hello, packets: [], socket, closed: false }; clis.push(cli!); continue; }
        cli.packets.push(parsed);
      }
    });
    socket.on('close', () => { if (cli) cli.closed = true; });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host.port = (server.address() as net.AddressInfo).port;
  Object.assign(host.overrides, {
    'vscode.workspace.workspaceFolders': [{ uri: { fsPath: workspace, scheme: 'file', path: workspace, toString: () => `file://${workspace}` }, name: 'w', index: 0 }],
  });
  const declared = (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).contributes.configuration as
    Array<{ properties: Record<string, { default?: unknown }> }> | { properties: Record<string, { default?: unknown }> });
  const defaults = new Map<string, unknown>();
  for (const block of Array.isArray(declared) ? declared : [declared]) {
    for (const [key, spec] of Object.entries(block.properties)) defaults.set(key, spec.default);
  }
  // The person's choices: the Claude program, as Check / choose CLI saves it, and one EndTurn hook declaration.
  const userValues = new Map<string, unknown>([
    ['unode.claudeCliPath', host.claudeExe],
    ['unode.executionHooks', [{ id: 'end-barrier', point: 'EndTurn', appliedBy: 'human', timeoutMs: 60_000, maxOutputBytes: 100, onFailure: 'block' }]],
  ]);
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
  fs.writeFileSync(path.join(workspace, 'old.txt'), 'Old figures: 10, 20.');
  fs.writeFileSync(path.join(workspace, 'new.txt'), 'New figures: 30, 40.');
  fs.writeFileSync(path.join(workspace, 'summary.txt'), 'Summary: all good.');
  fs.writeFileSync(path.join(workspace, 'totals.txt'), 'Summary: all good. Totals: 70.');
  await new PersistenceManager(context as never, undefined, () => workspace, undefined, undefined,
    new RootScopedWorkspaceState(context.workspaceState as never, workspace)).saveAgents([
    claudeAgent('pm', 'pm', 'PM'),
    // One agent per flow, so each starts with its own process and nothing confirmed.
    claudeAgent('senior-dev', 'steer-a', 'Ann'),
    claudeAgent('senior-dev', 'queue-b', 'Bo'),
    claudeAgent('senior-dev', 'stop-e', 'Eve'),
    claudeAgent('senior-dev', 'restart-f', 'Fay'),
    claudeAgent('senior-dev', 'hold-g', 'Gil'),
    claudeAgent('senior-dev', 'wake-h', 'Hal'),
    claudeAgent('senior-dev', 'wake-i', 'Ivy'),
    claudeAgent('senior-dev', 'wake-j', 'Jo'),
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
  for (const cli of clis) cli.socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await flush(20);
  if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
  for (const folder of [base, host.binFolder]) { try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* a process may still hold it */ } }
});

const STEER_GLYPH = '⚡';
const QUEUE_GLYPH = '↓';
const QUEUE_LABEL = 'Queue a follow-up for after this turn';
const STEER_LABEL = 'Send a steering message to the running agent';

// The Claude program the extension resolves is a Windows executable in the field; these flows run on Windows.
describe.runIf(process.platform === 'win32')('v0.9.103 Claude mid-turn messages through activate() (design §4 flows)', () => {
  it('(a) a busy Claude agent takes a composer message as a steer, not a queued turn; ⚡ only after its process confirmed', async () => {
    await screen.select('steer-a');
    await screen.send('Run the three commands one at a time, then summarise.');
    await until(() => !!cliOf('steer-a'), 'the agent\'s CLI started and got its turn');
    const cli = cliOf('steer-a')!;
    expect(cli.argv).toContain('--replay-user-messages');
    const [turn] = userPackets(cli);
    expect(turn.uuid).toMatch(/^[0-9a-f-]{36}$/);
    // Working, not yet confirmed: the composer queues, and says so.
    await screen.pump();
    expect(screen.composer()).toEqual({ glyph: QUEUE_GLYPH, label: QUEUE_LABEL });
    acknowledge(cli, turn);
    await until(() => screen.composer().glyph === STEER_GLYPH, 'the composer promises a steer once the process confirmed');
    expect(screen.composer()).toEqual({ glyph: STEER_GLYPH, label: STEER_LABEL });
    say(cli, 'Running the first command.');
    send(cli, { type: 'assistant', message: { id: 'msg-tool', content: [{ type: 'tool_use', id: 'toolu_a1', name: 'Bash', input: { command: 'echo one' } }] } });
    await screen.send('Change of plan: skip the third command.');
    await until(() => userPackets(cli).length === 2, 'the message was written into the running turn');
    const steer = userPackets(cli)[1];
    expect(steer).toEqual({ type: 'user', uuid: expect.stringMatching(/^[0-9a-f-]{36}$/), message: { role: 'user', content: 'Change of plan: skip the third command.' } });
    expect(notices('steer-a')).not.toContain(STEER_QUEUED_NOTICE);
    // The CLI reads it after the running tool call: same CLI turn, one result.
    send(cli, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', content: 'one' }] } });
    echo(cli, steer);
    acknowledge(cli, steer);
    say(cli, 'Skipped the third command. Printed one.');
    cliResult(cli, 'Skipped the third command. Printed one.', 0.01);
    await until(() => replies('steer-a').some((text) => text.includes('Skipped the third command. Printed one.')), 'the reply is kept');
    // Nothing was queued: no further turn reaches the CLI.
    for (let i = 0; i < 20; i++) await screen.pump();
    expect(userPackets(cli)).toHaveLength(2);
  });

  it('(b) a CLI that never acknowledges: two sends are both queued, each said once, with ↓ and no steering promise', async () => {
    await screen.select('queue-b');
    await screen.send('Do the long task.');
    await until(() => !!cliOf('queue-b'), 'the agent\'s CLI started and got its turn');
    const cli = cliOf('queue-b')!;
    await screen.pump();
    expect(screen.composer()).toEqual({ glyph: QUEUE_GLYPH, label: QUEUE_LABEL });
    expect(screen.hint()).not.toMatch(/will steer it/);
    await screen.send('First follow-up.');
    await screen.send('Second follow-up.');
    await until(() => notices('queue-b').filter((text) => text === STEER_QUEUED_NOTICE).length === 2, 'each queued message is said once');
    expect(userPackets(cli)).toHaveLength(1);
    expect(screen.composer()).toEqual({ glyph: QUEUE_GLYPH, label: QUEUE_LABEL });
    // The turn ends; the queued messages run after it, in order.
    say(cli, 'Long task done.');
    cliResult(cli, 'Long task done.', 0.01);
    await until(() => userPackets(cli).length === 2, 'the first queued message runs as the next turn');
    expect(textOf(userPackets(cli)[1].message?.content)).toContain('First follow-up.');
    cliResult(cli, 'First follow-up done.', 0.02);
    await until(() => userPackets(cli).length === 3, 'the second queued message runs after it');
    expect(textOf(userPackets(cli)[2].message?.content)).toContain('Second follow-up.');
    cliResult(cli, 'Second follow-up done.', 0.03);
    await until(() => replies('queue-b').includes('Second follow-up done.'), 'its reply is kept');
    expect(notices('queue-b').filter((text) => text === STEER_QUEUED_NOTICE)).toHaveLength(2);
  });

  it('(c) D2: a publication while a steer is unread is refused; the steer is read in the same CLI turn; the corrected receipt is the one outcome', async () => {
    await screen.select('pm');
    const receiptsBefore = persistedReceipts().filter((receipt) => receipt.agentId === 'pm').length;
    const finalsBefore = history('pm').filter((message: any) => message.turnFinal).length;
    await screen.send('Show me the figures file.');
    await until(() => !!cliOf('pm'), 'the PM\'s CLI started and got its turn');
    const cli = cliOf('pm')!;
    const [turn] = userPackets(cli);
    acknowledge(cli, turn);
    await until(() => screen.composer().glyph === STEER_GLYPH, 'the PM\'s process confirmed');
    say(cli, 'Let me read the figures.');
    const first = await bridgeTool(cli, 'unode_files', 'read_file', { path: 'old.txt' });
    const firstReceipt = /receipt-[0-9a-f-]{36}/.exec(first.text)?.[0];
    expect(firstReceipt, first.text).toBeDefined();
    await screen.send('Use new.txt instead; old.txt is outdated.');
    await until(() => userPackets(cli).length === 2, 'the correction was written into the running turn');
    const steer = userPackets(cli)[1];
    expect(textOf(steer.message?.content)).toBe('Use new.txt instead; old.txt is outdated.');
    // The model tries to publish before it has read the correction: refused, one tool call.
    const refused = await bridgeTool(cli, 'unode_team_bridge', 'publish_content_receipt', { receipt_id: firstReceipt, state: 'shown' });
    expect(refused.text).toBe(PUBLICATION_STEER_PENDING_ERROR);
    // The CLI reads the correction as soon as that tool call is done: the same CLI turn.
    echo(cli, steer);
    acknowledge(cli, steer);
    const second = await bridgeTool(cli, 'unode_files', 'read_file', { path: 'new.txt' });
    const secondReceipt = /receipt-[0-9a-f-]{36}/.exec(second.text)?.[0];
    const accepted = await bridgeTool(cli, 'unode_team_bridge', 'publish_content_receipt', { receipt_id: secondReceipt, state: 'shown' });
    expect(accepted.text).toMatch(/host is publishing receipt/i);
    say(cli, 'Here are the new figures.');
    cliResult(cli, 'Here are the new figures.', 0.05);
    await until(() => history('pm').filter((message: any) => message.turnFinal).length > finalsBefore, 'the PM\'s turn ends with one outcome');
    for (let i = 0; i < 10; i++) await screen.pump();
    const finals = history('pm').filter((message: any) => message.turnFinal).slice(finalsBefore);
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toContain('New figures: 30, 40.');
    expect(finals[0].text).not.toContain('Old figures');
    // The earlier prose stays in the transcript, and the request is settled once.
    expect(history('pm').map((message) => message.text)).toContain('Let me read the figures.');
    await until(() => persistedReceipts().filter((receipt) => receipt.agentId === 'pm').length > receiptsBefore, 'the turn\'s usage receipt is persisted');
    for (let i = 0; i < 10; i++) await screen.pump();
    expect(persistedReceipts().filter((receipt) => receipt.agentId === 'pm')).toHaveLength(receiptsBefore + 1);
    expect(userPackets(cli)).toHaveLength(2);
  });

  it('(d) D2 finalization barrier: a correction sent while EndTurn holds an accepted turn is queued, said once, and runs as the next turn', async () => {
    // Its own prerequisite, whatever ran before it: the PM's chat selected and a PM process that confirmed support.
    const cli = await confirmedPm();
    const receiptsBefore = persistedReceipts().filter((receipt) => receipt.agentId === 'pm').length;
    const base = userPackets(cli).length;
    let reached = false;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    endTurn.hold = { entered: () => { reached = true; }, gate };
    try {
      await screen.send('Show me the summary.');
      await until(() => userPackets(cli).length === base + 1, 'the PM got its next turn');
      acknowledge(cli, userPackets(cli)[base]);
      const read = await bridgeTool(cli, 'unode_files', 'read_file', { path: 'summary.txt' });
      const receipt = /receipt-[0-9a-f-]{36}/.exec(read.text)?.[0];
      const accepted = await bridgeTool(cli, 'unode_team_bridge', 'publish_content_receipt', { receipt_id: receipt, state: 'shown' });
      expect(accepted.text).toMatch(/host is publishing receipt/i);
      // The final result: the delivery is consumed, and the EndTurn hook holds the turn on the barrier.
      cliResult(cli, 'Here is the summary.', 0.08);
      await until(() => reached, 'the EndTurn hook holds the finishing turn');
      const packets = userPackets(cli).length;
      const queuedBefore = notices('pm').filter((text) => text === STEER_QUEUED_NOTICE).length;
      expect(screen.composer().glyph, 'the turn is still running').toBe(STEER_GLYPH);
      await screen.send('Also include the totals.');
      for (let i = 0; i < 20; i++) await screen.pump();
      // Not written into the finishing turn: queued, and said once.
      expect(userPackets(cli).map((packet) => textOf(packet.message?.content)).slice(packets),
        'admission: no steer packet is written into a turn whose delivery was accepted and consumed').toEqual([]);
      expect(notices('pm').filter((text) => text === STEER_QUEUED_NOTICE),
        'queue: the correction is queued with one "runs after this turn" line').toHaveLength(queuedBefore + 1);
      endTurn.hold = undefined;
      open();
      await until(() => replies('pm').some((text) => text.includes('Summary: all good.') && !text.includes('Totals')), 'the original turn ends with its delivery');
      await until(() => persistedReceipts().filter((receipt) => receipt.agentId === 'pm').length === receiptsBefore + 1, 'the original turn is settled once');
      // The following host turn receives the correction and publishes its revision.
      await until(() => userPackets(cli).length === packets + 1, 'the correction runs as the next turn');
      const next = userPackets(cli)[packets];
      expect(textOf(next.message?.content)).toContain('Also include the totals.');
      acknowledge(cli, next);
      const revisedRead = await bridgeTool(cli, 'unode_files', 'read_file', { path: 'totals.txt' });
      const revised = /receipt-[0-9a-f-]{36}/.exec(revisedRead.text)?.[0];
      const revision = await bridgeTool(cli, 'unode_team_bridge', 'publish_content_receipt', { receipt_id: revised, state: 'shown' });
      expect(revision.text).toMatch(/host is publishing receipt/i);
      cliResult(cli, 'Here are the totals.', 0.11);
      await until(() => replies('pm').some((text) => text.includes('Totals: 70.')), 'the revision is the next turn\'s outcome');
      await until(() => persistedReceipts().filter((receipt) => receipt.agentId === 'pm').length === receiptsBefore + 2, 'the next turn is settled');
      for (let i = 0; i < 10; i++) await screen.pump();
      expect(persistedReceipts().filter((receipt) => receipt.agentId === 'pm')).toHaveLength(receiptsBefore + 2);
    } finally {
      endTurn.hold = undefined;
      open();
    }
    // The test's whole budget (45 s) ends before the EndTurn hook's own 60 s window could: the barrier never times out.
  }, 45_000);

  it('(e) D3 Stop with a known cost: the held segment\'s reported cost survives once as partial; only the unread message is named; nothing restarts', async () => {
    await screen.select('stop-e');
    await screen.send('Summarise the logs.');
    await until(() => !!cliOf('stop-e'), 'the agent\'s CLI started and got its turn');
    const cli = cliOf('stop-e')!;
    acknowledge(cli, userPackets(cli)[0]);
    await until(() => screen.composer().glyph === STEER_GLYPH, 'the process confirmed');
    say(cli, 'The logs look fine.');
    await screen.send('Also check the error count.');
    await until(() => userPackets(cli).length === 2, 'the message was written into the running turn');
    const first = userPackets(cli)[1];
    // The CLI's last request was already in flight (design §2, run B): its result comes before it reads the message,
    // with a cost that is not the reference token price.
    cliResult(cli, 'The logs look fine.', 0.123456);
    // The CLI runs the message as its own next turn, which reads it.
    cliInit(cli);
    echo(cli, first);
    say(cli, 'Counting the errors');
    await until(() => String(chatProvider.liveMessages.get('stop-e')?.text ?? '').includes('Counting the errors'), 'the next CLI turn is under way');
    expect(history('stop-e').some((message: any) => message.turnFinal)).toBe(false);
    await screen.send('And the warning count.');
    await until(() => userPackets(cli).length === 3, 'a second message was written, and not read');
    await screen.stop();
    await until(() => persistedReceipts().some((receipt) => receipt.agentId === 'stop-e'), 'the stopped turn\'s usage receipt is persisted');
    for (let i = 0; i < 20; i++) await screen.pump();
    const receipts = persistedReceipts().filter((receipt) => receipt.agentId === 'stop-e');
    expect(receipts).toHaveLength(1);
    // The reported amount and basis, once; partial; the started CLI turn that reported nothing is an unattributed attempt.
    expect(receipts[0]).toMatchObject({
      providerAttempts: 2,
      coverageGap: 'one-or-more-attempts-unattributed',
      tokens: { input: 1_100, cachedInput: 1_000, output: 16, basis: 'reported-partial' },
      displayCost: { nanoUsd: '123456000', basis: 'api-equivalent', sourceId: 'provider-reported' },
    });
    // The held segment's progress is covered by this receipt, not counted beside it.
    expect(receipts[0].coveredProgressIds).toHaveLength(1);
    // Only the unread message is named, once; the one the agent read is not.
    expect(notices('stop-e').filter((text) => text.startsWith('Your message was not delivered'))).toEqual([unreadSteerNotice('And the warning count.')]);
    // The held result's text is in the kept chat history.
    expect(history('stop-e').map((message) => message.text).join('\n')).toContain('The logs look fine.');
    // Stopped, and nothing starts again: no turn, no process.
    expect(chatProvider.deps.listAgents().find((agent: any) => agent.id === 'stop-e').status).toBe('stopped');
    expect(screen.composer().glyph).toBe('↑');
    const connections = clis.length;
    for (let i = 0; i < 20; i++) await screen.pump();
    expect(userPackets(cli)).toHaveLength(3);
    expect(clis.length).toBe(connections);
  });

  it('(f) process replacement: a restarted agent shows ↓ until its new process confirms; the old process confirms nothing for it', async () => {
    await screen.select('restart-f');
    await screen.send('First task.');
    await until(() => !!cliOf('restart-f'), 'the agent\'s CLI started and got its turn');
    const oldCli = cliOf('restart-f')!;
    const oldTurn = userPackets(oldCli)[0];
    acknowledge(oldCli, oldTurn);
    await until(() => screen.composer().glyph === STEER_GLYPH, 'the first process confirmed');
    cliResult(oldCli, 'First task done.', 0.01);
    await until(() => replies('restart-f').includes('First task done.'), 'the first turn ends');
    const connections = clis.length;
    const restarting = host.commands.get('unode.agentRestart')!('restart-f') as Promise<unknown>;
    // A late word of the old process while it is being replaced.
    acknowledge(oldCli, oldTurn);
    echo(oldCli, oldTurn);
    await restarting;
    await until(() => clis.length > connections, 'the new process started');
    const newCli = clis[clis.length - 1];
    expect(newCli.pid).not.toBe(oldCli.pid);
    await screen.send('Second task.');
    await until(() => userPackets(newCli).length === 1, 'the new process got the turn');
    for (let i = 0; i < 10; i++) await screen.pump();
    expect(screen.composer()).toEqual({ glyph: QUEUE_GLYPH, label: QUEUE_LABEL });
    if (!oldCli.closed) acknowledge(oldCli, oldTurn);
    for (let i = 0; i < 10; i++) await screen.pump();
    expect(screen.composer()).toEqual({ glyph: QUEUE_GLYPH, label: QUEUE_LABEL });
    acknowledge(newCli, userPackets(newCli)[0]);
    await until(() => screen.composer().glyph === STEER_GLYPH, 'the new process confirmed');
    expect(screen.composer()).toEqual({ glyph: STEER_GLYPH, label: STEER_LABEL });
    cliResult(newCli, 'Second task done.', 0.02);
    await until(() => replies('restart-f').includes('Second task done.'), 'the second turn ends');
  });

  /*
   * Codex's audit of 611615ac, I1: a held result's text reached only the live chat buffer. A history restore while the
   * turn was held (as after a host reload) lost a result the person had seen. The held prose is now committed to the
   * kept chat at the hold, the turn keeps running, and the final reply does not show it a second time.
   */
  it('(g) a held result-only text is in the kept chat before anything else happens, and appears once after the turn ends', async () => {
    await screen.select('hold-g');
    await screen.send('Check the logs.');
    await until(() => !!cliOf('hold-g'), 'the agent\'s CLI started and got its turn');
    const cli = cliOf('hold-g')!;
    acknowledge(cli, userPackets(cli)[0]);
    await until(() => screen.composer().glyph === STEER_GLYPH, 'the process confirmed');
    await screen.send('Also count the errors.');
    await until(() => userPackets(cli).length === 2, 'the message was written into the running turn');
    const steer = userPackets(cli)[1];
    // The segment's text arrives only in its result, while the message is unread: the result is held.
    cliResult(cli, 'The logs look fine.', 0.02);
    const shown = () => String(chatProvider.liveMessages.get('hold-g')?.text ?? '') + history('hold-g').map((message) => message.text).join('\n');
    await until(() => shown().includes('The logs look fine.'), 'the held result-only text is on screen');
    // Before any further event: the saved chat state, restored by a fresh production chat view, has the held text.
    const saved = chatProvider.deps.state.get('roam.chat.hold-g', []) as Array<{ role: string; text: string }>;
    expect(saved.filter((message) => message.role === 'agent').map((message) => message.text), 'the saved chat holds the held text')
      .toContain('The logs look fine.');
    const restoredView = () => new chatProvider.constructor(chatProvider.extensionUri, { ...chatProvider.deps, presentation: undefined, onReply: () => () => {} });
    const restored = restoredView().loadHistory('hold-g') as Array<{ role: string; text: string }>;
    expect(restored.filter((message) => message.role === 'agent').map((message) => message.text), 'a fresh view restores the held text')
      .toContain('The logs look fine.');
    // The turn is still running, and the person can still steer it.
    expect(screen.composer()).toEqual({ glyph: STEER_GLYPH, label: STEER_LABEL });
    // The steer's own CLI turn completes the host turn.
    cliInit(cli);
    echo(cli, steer);
    say(cli, 'There are 3 errors.');
    cliResult(cli, 'There are 3 errors.', 0.05);
    await until(() => history('hold-g').some((message: any) => message.turnFinal), 'the turn ends');
    for (let i = 0; i < 5; i++) await screen.pump();
    const agentTexts = (messages: Array<{ role: string; text: string; runtimeNotice?: boolean }>) => messages
      .filter((message) => message.role === 'agent' && !message.runtimeNotice).map((message) => message.text);
    const occurrences = (texts: string[], needle: string) => texts.join('\n').split(needle).length - 1;
    expect(occurrences(agentTexts(history('hold-g')), 'The logs look fine.'), JSON.stringify(agentTexts(history('hold-g')))).toBe(1);
    expect(occurrences(agentTexts(history('hold-g')), 'There are 3 errors.')).toBe(1);
    const final = history('hold-g').find((message: any) => message.turnFinal)!;
    expect(final.text).toBe('There are 3 errors.');
    expect(occurrences(agentTexts(restoredView().loadHistory('hold-g')), 'The logs look fine.')).toBe(1);
    expect(screen.composer().glyph).toBe('↑');
  });
});

/*
 * v0.9.103 F2 (the Owner's option A), activation level (design §4.5; Codex's audit of 6b332fa3, deviation 6 and finding
 * 1): a turn the Claude CLI begins on its own after the request ended. The CLI's background-task notification and its
 * next init reach the real Claude backend and SessionManager; the offer is activation's own non-modal
 * showInformationMessage with Continue, and Continue goes through the chat's own request entry.
 */
const BACKGROUND_SUMMARY = 'Background command "Run sleep 15 then echo done" completed (exit code 0)';
const taskNotification = (cli: Cli, taskId: string, summary = BACKGROUND_SUMMARY) => send(cli, {
  type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: `toolu_${taskId}`, status: 'completed',
  output_file: `C:\\probe-tmp\\tasks\\${taskId}.output`, summary, uuid: randomUUID(), session_id: 's',
});

/** The offers activation shows: each waits for the person's choice, which the flow makes when it chooses. */
function offerWindow() {
  const offers: Array<{ text: string; choose: (choice: string | undefined) => void }> = [];
  const original = host.overrides['vscode.window.showInformationMessage'] as (...args: unknown[]) => unknown;
  host.overrides['vscode.window.showInformationMessage'] = (text: string, ...items: unknown[]) => (items[0] === 'Continue'
    ? new Promise<string | undefined>((resolve) => { offers.push({ text: String(text), choose: resolve }); })
    : original(text, ...items));
  return { offers, restore: () => { host.overrides['vscode.window.showInformationMessage'] = original; } };
}

/** The agent's first request, started and ended through the chat; its CLI is returned idle. */
async function endedFirstRequest(agentId: string, ask: string, answer: string, total: number): Promise<Cli> {
  await screen.select(agentId);
  await screen.send(ask);
  await until(() => !!cliOf(agentId), `${agentId}'s CLI started and got its turn`);
  const cli = cliOf(agentId)!;
  acknowledge(cli, userPackets(cli)[0]);
  cliResult(cli, answer, total);
  await until(() => replies(agentId).includes(answer), `${agentId}'s first request ends`);
  await until(() => persistedReceipts().some((receipt) => receipt.agentId === agentId), `${agentId}'s first receipt is persisted`);
  return cli;
}

const continuePackets = (cli: Cli) => userPackets(cli).filter((packet) => textOf(packet.message?.content).includes('Continue: something you started in the background'));

describe.runIf(process.platform === 'win32')('v0.9.103 F2 through activate(): a turn the Claude CLI began on its own', () => {
  it('(h) one offer with Continue, none for a second wake while it is open; Continue sends one message; each wake is its own receipt of the request before it', async () => {
    const window = offerWindow();
    try {
      const cli = await endedFirstRequest('wake-h', 'Start the background job, h.', 'Started, h.', 0.25);
      // The first wake: the notification, then the CLI's own turn.
      taskNotification(cli, 'bg-h1');
      cliInit(cli);
      await until(() => window.offers.length === 1, 'the offer is shown');
      expect(window.offers[0].text).toBe(`Hal: something it started in the background finished after your request ended (${BACKGROUND_SUMMARY}). `
        + 'It can read files in that turn but cannot run commands or change files. To let it act on the result, press Continue.');
      say(cli, 'Wake one is done.');
      cliResult(cli, 'Wake one is done.', 0.375);
      await until(() => notices('wake-h').some((text) => text === 'Hal, in a turn it began on its own: Wake one is done.'), 'the wake\'s text is shown apart');
      expect(replies('wake-h')).not.toContain('Wake one is done.');
      // A second wake while the offer is open adds no second offer.
      taskNotification(cli, 'bg-h2');
      cliInit(cli);
      for (let i = 0; i < 20; i++) await screen.pump();
      expect(window.offers).toHaveLength(1);

      // Continue: one ordinary message of the person, written to the CLI and held behind the running wake.
      window.offers[0].choose('Continue');
      await until(() => continuePackets(cli).length === 1, 'Continue reached the CLI');
      const continued = continuePackets(cli)[0];
      expect(textOf(continued.message?.content)).toContain(continueMessageText(BACKGROUND_SUMMARY));
      expect(history('wake-h').filter((message) => message.role === 'user' && message.text === continueMessageText(BACKGROUND_SUMMARY))).toHaveLength(1);
      say(cli, 'Wake two is done.');
      cliResult(cli, 'Wake two is done.', 0.5);
      await until(() => notices('wake-h').some((text) => text === 'Hal, in a turn it began on its own: Wake two is done.'), 'the second wake ends');
      // The CLI reads Continue in a turn of its own: the request opens and ends with its own result.
      cliInit(cli);
      echo(cli, continued);
      say(cli, 'Checked the result, h.');
      cliResult(cli, 'Checked the result, h.', 0.75);
      await until(() => replies('wake-h').includes('Checked the result, h.'), 'the Continue request ends');
      await until(() => persistedReceipts().filter((receipt) => receipt.agentId === 'wake-h').length === 4, 'four receipts are persisted');
      for (let i = 0; i < 10; i++) await screen.pump();
      expect(continuePackets(cli)).toHaveLength(1);
      expect(window.offers).toHaveLength(1);

      // Codex's audit of 6b332fa3, finding 1 (the Owner: its own receipt).
      const receipts = persistedReceipts().filter((receipt) => receipt.agentId === 'wake-h');
      const wakes = receipts.filter((receipt) => String(receipt.usageUnitId).startsWith('wake:'));
      const turns = receipts.filter((receipt) => !String(receipt.usageUnitId).startsWith('wake:'));
      expect(turns, JSON.stringify(receipts)).toHaveLength(2);
      const [firstRequest, continueRequest] = turns.sort((a, b) => String(a.observedAt).localeCompare(String(b.observedAt)));
      expect(firstRequest.displayCost.nanoUsd).toBe('250000000');
      expect(wakes.map((receipt) => [receipt.requestId, receipt.displayCost.nanoUsd]))
        .toEqual([[firstRequest.requestId, '125000000'], [firstRequest.requestId, '125000000']]);
      expect(continueRequest.requestId).not.toBe(firstRequest.requestId);
      expect(continueRequest.displayCost.nanoUsd).toBe('250000000');
    } finally { window.restore(); }
  });

  it('(i) a stale offer, after a restart of that agent, sends nothing and says so', async () => {
    const window = offerWindow();
    try {
      const cli = await endedFirstRequest('wake-i', 'Start the background job, i.', 'Started, i.', 0.25);
      taskNotification(cli, 'bg-i1');
      cliInit(cli);
      await until(() => window.offers.length === 1, 'the offer is shown');
      const connections = clis.length;
      await host.commands.get('unode.agentRestart')!('wake-i');
      await until(() => clis.length > connections, 'the new process started');
      const warnings = host.warnings.length;
      window.offers[0].choose('Continue');
      await until(() => host.warnings.length > warnings, 'the person is told');
      expect(host.warnings.slice(warnings)).toEqual([OFFER_ENDED_NOTICE]);
      for (let i = 0; i < 10; i++) await screen.pump();
      for (const each of clis.filter((entry) => textOf(userPackets(entry)[0]?.message?.content).includes('agent "wake-i"'))) {
        expect(continuePackets(each)).toEqual([]);
      }
      expect(history('wake-i').filter((message) => message.role === 'user' && message.text.startsWith('Continue:'))).toEqual([]);
    } finally { window.restore(); }
  });

  it('(j) Continue while the agent works on another request sends nothing and says so', async () => {
    const window = offerWindow();
    try {
      const cli = await endedFirstRequest('wake-j', 'Start the background job, j.', 'Started, j.', 0.25);
      taskNotification(cli, 'bg-j1');
      cliInit(cli);
      await until(() => window.offers.length === 1, 'the offer is shown');
      say(cli, 'Wake is done, j.');
      cliResult(cli, 'Wake is done, j.', 0.375);
      await until(() => notices('wake-j').some((text) => text.startsWith('Jo, in a turn it began on its own:')), 'the wake ends');
      await screen.send('Another request, j.');
      await until(() => userPackets(cli).length === 2, 'the other request reached the CLI');
      const warnings = host.warnings.length;
      window.offers[0].choose('Continue');
      await until(() => host.warnings.length > warnings, 'the person is told');
      expect(host.warnings.slice(warnings)).toEqual(['That agent is working on another request; nothing was sent.']);
      for (let i = 0; i < 10; i++) await screen.pump();
      expect(continuePackets(cli)).toEqual([]);
      expect(history('wake-j').filter((message) => message.role === 'user' && message.text.startsWith('Continue:'))).toEqual([]);
      acknowledge(cli, userPackets(cli)[1]);
      cliResult(cli, 'Done, j.', 0.5);
      await until(() => replies('wake-j').includes('Done, j.'), 'the other request ends');
    } finally { window.restore(); }
  });
});
