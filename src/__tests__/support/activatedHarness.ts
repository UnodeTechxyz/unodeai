/*
 * The activate() harness of the flows (moved from ActivatedExtension.flows.test.ts; what it does is unchanged): the
 * scripted model behind a stubbed fetch, the chat on screen, the workspace, and one activate() per test file.
 * A test file mocks 'vscode' with activatedVscode.ts first, then calls installActivatedExtension() at its top level.
 */
import { afterAll, beforeAll, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ActivatedHost } from './activatedVscode';
import type { AgentConfig } from '../../types';
import { PersistenceManager } from '../../state/PersistenceManager';
import { RootScopedWorkspaceState } from '../../state/RootScopedWorkspaceState';
import { RunLedger } from '../../observability/RunLedger';
import { pmLiveRelevant, pmLiveStrip } from '../../session/PmLiveStrip';
import { AgentConfigBuilder } from '../../roles/RoleConfig';
import { bootWebviewScript, type WebviewBootResult } from '../../views/__tests__/support/webviewBoot';
import { MessageBus } from '../../bus/MessageBus';
import type { Message } from '../../types';
import { OpenAICompatBackend } from '../../backend/OpenAICompatBackend';
import { TaskInputResolver } from '../../backend/TaskContract';


/**
 * v0.9.103: ends a flow's fake timers without stranding one. A fake timer still pending when real timers return never
 * fires, and a module-level debounce guarded by it never runs again for the rest of the file: the extension's Job outcome
 * and request closeout sync (`jobOutcomeSyncTimer`), the strip's publisher, the run and message saves. Every timer due
 * within the next two seconds, and those they schedule in turn, runs first.
 */
export async function endFakeTimers(): Promise<void> {
  for (let step = 0; step < 10; step++) await vi.advanceTimersByTimeAsync(200);
  vi.useRealTimers();
}

/**
 * v0.9.104 D0.5 (ROADMAP item 12, test efficiency B): wait until `read` shows the state a flow is about to assert, then
 * return it. Each round pumps the page; the bound is wall-clock time from the process clock, which fake timers do not
 * stop, never a count of rounds (a count that suffices on a quiet machine runs out under a loaded suite). On the
 * deadline it returns the last value, so the assertion that follows fails with what was actually there.
 * `node scripts/check-flow-immediate-reads.mjs` requires a strip assertion to follow such a wait.
 */
export async function untilCurrent<T>(read: () => T | Promise<T>, done: (value: T) => boolean, pump: () => Promise<unknown>,
  deadlineMs = 40_000): Promise<T> {
  const deadline = process.hrtime.bigint() + BigInt(deadlineMs) * 1_000_000n;
  let value = await read();
  while (!done(value) && process.hrtime.bigint() < deadline) {
    await pump();
    value = await read();
  }
  return value;
}

/** A wall-clock deadline `ms` from now, from the process clock, which fake timers do not stop. */
/**
 * v0.9.105 (CI 44017485725): the waits of the activation flows end within WAIT_DEADLINE_MS. A proof that fails because the
 * state it waits for never comes must end inside the warm mutation engine's 60 s per case (CASE_TIMEOUT_MS), or a killed
 * mutant is recorded as invalid. 20 s is above what the round counts these waits replaced gave (about 5 to 15 s).
 */
export const WAIT_DEADLINE_MS = 20_000;
export const wallDeadline = (ms = WAIT_DEADLINE_MS): bigint => process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
export const beforeDeadline = (deadline: bigint): boolean => process.hrtime.bigint() < deadline;

/**
 * v0.9.105 (CI 44007091429): pump while `waiting()` holds, bounded by wall-clock time as untilCurrent is, never by a
 * count of rounds. 0.9.105 S8 made each round cheaper, and counts that sufficed before ran out in the three-worker
 * mutation baseline. A wait that ends early costs nothing.
 * v0.9.105 (CI 44017485725): each wait is for a state the flow expects, so one that runs out fails here, naming what it
 * waited for (and `detail`, when given). Two waits in a row would otherwise each take the whole deadline before the
 * assertion after them, and a failing proof would outlast the mutation engine's per-case time.
 */
export async function pumpWhile(waiting: () => boolean, pump: () => Promise<unknown>,
  options: { deadlineMs?: number; detail?: () => string } = {}): Promise<void> {
  const deadlineMs = options.deadlineMs ?? WAIT_DEADLINE_MS;
  const deadline = wallDeadline(deadlineMs);
  while (waiting()) {
    if (!beforeDeadline(deadline)) {
      throw new Error(`Waited ${deadlineMs / 1_000} s by the process clock, and this still held: ${waiting.toString()}`
        + (options.detail ? `\n${options.detail()}` : ''));
    }
    await pump();
  }
}

export const flush = async (rounds = 4) => {
  for (let round = 0; round < rounds; round++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
};

export function memento() {
  const values = new Map<string, unknown>();
  return { get: (key: string, fallback?: unknown) => (values.has(key) ? structuredClone(values.get(key)) : fallback),
    update: async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, structuredClone(value)); },
    keys: () => [...values.keys()], setKeysForSync() {} };
}

/* ---------------------------------------------------------------------------------------------------------------------
 * The model: each request to the chat completions endpoint is answered by the script of the agent whose model it names.
 * A script returns tool calls or text; the request's messages are what the backend actually sent.
 * ------------------------------------------------------------------------------------------------------------------- */
export type ModelRequest = { model: string; messages: Array<{ role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }>; tools?: Array<{ function: { name: string } }> };
export type ModelAnswer = ({ text: string } | { calls: Array<{ name: string; args: Record<string, unknown> }> }) & {
  /** v0.9.103 (6.2): reasoning the model streams before its answer. */
  reasoning?: string;
  /** v0.9.103 (6.2): the text streams its first half, then waits for this before the rest: a reply seen while it is live. */
  hold?: Promise<void>;
};
export const scripts = new Map<string, (request: ModelRequest) => ModelAnswer | Promise<ModelAnswer>>();
export const requests: ModelRequest[] = [];
let callSeq = 0;

export function sse(answer: ModelAnswer, model: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
    id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const usage = `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model, choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`;
  const thinking = answer.reasoning ? chunk({ role: 'assistant', reasoning_content: answer.reasoning }, null) : '';
  if ('text' in answer) return thinking + chunk({ role: 'assistant', content: answer.text }, null) + chunk({}, 'stop') + usage + 'data: [DONE]\n\n';
  const calls = answer.calls.map((call, index) => ({ index, id: `call_${++callSeq}`, type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) } }));
  return thinking + chunk({ role: 'assistant', tool_calls: calls }, null) + chunk({}, 'tool_calls') + usage + 'data: [DONE]\n\n';
}

export async function fakeFetch(input: unknown, init?: { body?: unknown; signal?: AbortSignal }): Promise<Response> {
  const url = String(input);
  if (!url.endsWith('/chat/completions')) return new Response('{}', { status: 404 });
  const request = JSON.parse(String(init?.body)) as ModelRequest;
  requests.push(request);
  const script = scripts.get(request.model);
  if (!script) return new Response(JSON.stringify({ error: { message: `no script for ${request.model}` } }), { status: 400 });
  // Stop aborts a request in flight, as it aborts a real one.
  const aborted = new Promise<never>((_resolve, reject) => {
    if (init?.signal?.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const answer = await Promise.race([Promise.resolve(script(request)), aborted]);
  if ((request as { stream?: boolean }).stream === false) {
    const message = 'text' in answer ? { role: 'assistant', content: answer.text }
      : { role: 'assistant', content: null, tool_calls: answer.calls.map((call) => ({ id: `call_${++callSeq}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) };
    return new Response(JSON.stringify({ id: 'x', choices: [{ index: 0, message, finish_reason: 'text' in answer ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const hold = answer.hold;
  if (hold && 'text' in answer) {
    // The reasoning and the first half of the text, then nothing until the hold is released, then the rest of the stream.
    const half = Math.floor(answer.text.length / 2);
    const chunk = (delta: Record<string, unknown>) => `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk',
      created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
    const first = (answer.reasoning ? chunk({ role: 'assistant', reasoning_content: answer.reasoning }) : '')
      + chunk({ role: 'assistant', content: answer.text.slice(0, half) });
    const rest = sse({ text: answer.text.slice(half) }, request.model);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(first));
        await hold;
        controller.enqueue(encoder.encode(rest));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  return new Response(sse(answer, request.model), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join('')
    : '';
/** What the latest user-role message of the request says: this turn's instruction, not earlier turns'. */
export const latestUser = (request: ModelRequest): string => textOf([...request.messages].reverse().find((message) => message.role === 'user')?.content);
/**
 * The tool results the backend sent back after the model's last tool calls, for a script that reacts to them; undefined
 * when the request does not answer a tool call (a new turn).
 */
export const lastToolResult = (request: ModelRequest): string | undefined => {
  let index = request.messages.length - 1;
  while (index >= 0 && request.messages[index].role !== 'assistant') index--;
  if (index < 0 || !request.messages[index].tool_calls) return undefined;
  const results = request.messages.slice(index + 1).filter((message) => message.role === 'tool').map((message) => textOf(message.content));
  return results.length ? results.join(' | ') : undefined;
};

/* ---------------------------------------------------------------------------------------------------------------------
 * The chat on screen: the real ChatViewProvider activation registered, resolved in a sidebar view, its page booted
 * from the HTML it serves, every post delivered both ways.
 * ------------------------------------------------------------------------------------------------------------------- */
export function chatScreen(provider: { resolveWebviewView(view: unknown, ...rest: unknown[]): void }, options: { readable?: boolean } = {}) {
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
  // v0.9.103 (6.2): a readable page. Its text nodes hold their words (`mutations`), its streaming row is the one the
  // script builds (`liveRows`), and it is shown with reduced motion, so streamed text appears at once: the stub runs no
  // animation frames.
  page = bootWebviewScript(view.webview.html, options.readable ? { mutations: true, liveRows: true,
    window: { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) } } : {});
  let sent = 0;
  const pump = async () => {
    for (const message of queued.splice(0)) deliver(message);
    while (sent < page!.postedMessages.length) fromPage?.(page!.postedMessages[sent++]);
    await flush();
  };
  const descendants = (node: any): any[] => (Array.isArray(node?.children) ? node.children : []).flatMap((child: any) => [child, ...descendants(child)]);
  const text = (node: any): string => [node?.textContent, ...(Array.isArray(node?.children) ? node.children.map(text) : [])].filter(Boolean).join(' ');
  return {
    page: () => page!,
    pump,
    footers: () => descendants(page!.elements.get('transcript')).filter((node) => node.className === 'turn-footer').map(text),
    transcript: () => text(page!.elements.get('transcript')),
    strip: (): string[] => {
      // v0.9.103 (slice 3 §4.4): #pmLive is the wrapper; its lines are in #pmLiveLines, the silent line in #pmLiveQuiet.
      const node = page!.elements.get('pmLive') as any;
      const lines = page!.elements.get('pmLiveLines') as any;
      return !node || node.hidden ? [] : (lines?.children ?? []).map(text);
    },
    /** The person presses Stop beside the message box. */
    stop: async () => {
      await pump();
      const button = page!.elements.get('stop') as any;
      expect(button.hidden, 'Stop is shown while the PM is in its turn').toBe(false);
      page!.dispatchElementEvent(button, 'click');
      await pump();
    },
    /** The person presses Continue on the strip: returns what the message box then holds. */
    continueFromStrip: async (): Promise<string> => {
      await pump();
      const button = descendants(page!.elements.get('pmLiveLines')).find((node) => node.textContent === 'Continue');
      expect(button, 'Continue on the strip').toBeDefined();
      page!.dispatchElementEvent(button, 'click');
      return String((page!.elements.get('input') as any).value ?? '');
    },
    /** The person presses a button on the strip by its label: returns what the message box then holds. */
    pressOnStrip: async (label: string): Promise<string> => {
      await pump();
      const button = [...descendants(page!.elements.get('pmLiveLines')), ...descendants(page!.elements.get('pmLiveQuiet'))]
        .find((node) => node.type === 'button' && node.textContent === label);
      expect(button, `${label} on the strip`).toBeDefined();
      page!.dispatchElementEvent(button, 'click');
      return String((page!.elements.get('input') as any).value ?? '');
    },
    /** Presses Send on what the message box holds. */
    sendBox: async () => {
      page!.dispatchElementEvent(page!.elements.get('send') as never, 'click');
      await pump();
    },
    /** The person picks another agent's chat. */
    select: async (agentId: string) => {
      await pump();
      const select = page!.elements.get('agent') as any;
      select.value = agentId;
      page!.dispatchElementEvent(select, 'change');
      await pump();
    },
    /** The person types a message into the box and presses Send. */
    send: async (message: string) => {
      await pump();
      (page!.elements.get('input') as any).value = message;
      page!.dispatchElementEvent(page!.elements.get('send') as never, 'click');
      await pump();
    },
  };
}

/* ---------------------------------------------------------------------------------------------------------------------
 * The window: a real temporary workspace folder, a team saved there before the window opened, and activate().
 * ------------------------------------------------------------------------------------------------------------------- */
// The workspace and a folder beside it share a parent, which unode.localReadScope's default ("parent") lets agents read;
// another folder elsewhere is outside every folder they can read.
export const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'unode-activated-')));
export const workspace = path.join(base, 'ws');
export const sibling = path.join(base, 'out');
export const elsewhere = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'unode-elsewhere-')));
for (const folder of [workspace, sibling]) fs.mkdirSync(folder, { recursive: true });
export const context = {
  subscriptions: [] as { dispose(): void }[], globalState: memento(), workspaceState: memento(),
  extensionUri: { fsPath: process.cwd() }, extensionPath: process.cwd(), globalStorageUri: { fsPath: path.join(workspace, '.global') },
  storageUri: { fsPath: path.join(workspace, '.storage') }, logUri: { fsPath: path.join(workspace, '.log') }, extensionMode: 3, extension: { packageJSON: {} },
  secrets: { get: async () => 'sk-test', store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
  asAbsolutePath: (value: string) => value, environmentVariableCollection: { replace() {}, clear() {} },
};

export function agent(template: string, id: string, name: string, model: string): AgentConfig {
  const config = new AgentConfigBuilder().fromTemplate(template).setProviderById('openai').setId(id).setName(name).setModel(model).build();
  config.backend = 'openai-compat';
  config.autoApprove = true;
  return config;
}

/**
 * v0.9.102 (design §9): what the PM's strip says in this workspace after a reload: the runs this window stored, loaded by
 * the production persistence path into a new ledger with a new host epoch and reconciled as activation does, read with
 * the PM's stored last reply.
 */
/**
 * v0.9.105 (CI 44007091429): wait until this window's stored state has not changed for `quietMs`, by the process clock,
 * at most `deadlineMs`. The window saves its runs 750 ms after a change and its request records on their own write
 * chain; one fixed second, which a loaded runner can outrun, let a reload read the copy from before the last change.
 */
export async function storedStateQuiet(quietMs = 1_500, deadlineMs = WAIT_DEADLINE_MS): Promise<void> {
  const state = context.workspaceState as unknown as { keys(): string[]; get(key: string): unknown };
  const now = () => JSON.stringify(state.keys().sort().map((key) => [key, state.get(key)]));
  const deadline = wallDeadline(deadlineMs);
  let last = now();
  let quietSince = process.hrtime.bigint();
  while (beforeDeadline(deadline) && process.hrtime.bigint() - quietSince < BigInt(quietMs) * 1_000_000n) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const current = now();
    if (current !== last) { last = current; quietSince = process.hrtime.bigint(); }
  }
}

export async function reloadedStrip(settled: (lines: string[]) => boolean = () => true): Promise<{ lines: string[]; ledger: RunLedger }> {
  // The window saves its runs 750 ms after a change; a reload sooner would read the copy before it.
  await storedStateQuiet();
  let read = await readReloadedStrip();
  // v0.9.104 D0.5: polled until it shows what the caller waits for, within 10 s of wall-clock time, not 20 rounds.
  const deadline = process.hrtime.bigint() + 10_000_000_000n;
  while (!settled(read.lines) && process.hrtime.bigint() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    read = await readReloadedStrip();
  }
  return read;
}

export async function readReloadedStrip(): Promise<{ lines: string[]; ledger: RunLedger }> {
  const state = new RootScopedWorkspaceState(context.workspaceState as never, workspace);
  const host = { hostInstanceId: 'activated-flows-window', epoch: `reloaded-${Date.now()}` };
  const ledger = new RunLedger(await new PersistenceManager(context as never, undefined, () => workspace, host, undefined, state).loadRuns(), { host });
  ledger.reconcileRestoredActiveDelegations();
  const replies = state.get<Record<string, string>>('unode.pmRepliedAt') ?? {};
  const repliedAt = replies.pm ?? replies['*'] ?? new Date(0).toISOString();
  const tasks = ledger.inspectTaskStatusWhere('pm', pmLiveRelevant(repliedAt));
  const strip = pmLiveStrip({ held: false, tasks, stripFacts: ledger.pmStripFactsOf('pm', tasks.map((task) => task.handle)), repliedAt,
    queued: new Set(), starting: 0, waitingForAccess: [], agentNames: new Map([['dev', 'Dev']]) });
  return { lines: (strip?.lines ?? []).map((line) => ('text' in line ? line.text : 'Running')), ledger };
}

/**
 * v0.9.103 (G5): the delegations this window stored, as the production persistence path loads them, unreconciled. The
 * window saves its runs 750 ms after a change; under fake timers that save is due once the timers have moved past it.
 */
export async function storedDelegations() {
  await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  const state = new RootScopedWorkspaceState(context.workspaceState as never, workspace);
  const runs = await new PersistenceManager(context as never, undefined, () => workspace, undefined, undefined, state).loadRuns();
  return runs.flatMap((run) => run.delegations);
}

/**
 * One task's stored record once it is there in `state`. The run ledger is written asynchronously: under load a single
 * read after the fixed wait can come before the write, so read again (at most ten more times) before asserting.
 */
export async function storedDelegationIn(handle: string, state: string) {
  let found = (await storedDelegations()).find((delegation) => delegation.handle === handle);
  for (let i = 0; i < 10 && found?.state !== state; i++) found = (await storedDelegations()).find((delegation) => delegation.handle === handle);
  return found;
}

let screen: ReturnType<typeof chatScreen>;
let chatProvider: any;
let host: ActivatedHost;
/** The agent replies the chat keeps for this agent, as its history holds them. */
export const replies = (agentId: string): string[] => (chatProvider.loadHistory(agentId) as Array<{ role: string; text: string }>)
  .filter((message) => message.role === 'agent').map((message) => message.text);

/**
 * One activate() for the test file that calls this, at its top level: before its tests, the team is saved and the
 * extension activated; after them, everything is disposed and the folders removed. `ready` is given the chat view
 * and its screen.
 */
export function installActivatedExtension(
  activatedHost: ActivatedHost,
  ready: (chat: { chatProvider: any; screen: ReturnType<typeof chatScreen> }) => void,
  /** v0.9.106: the roster saved before the window opens; the PM, Dev and Writer when absent, none for a first use. */
  options: { agents?: AgentConfig[] } = {},
): void {
  host = activatedHost;
  beforeAll(async () => {
    vi.stubGlobal('fetch', fakeFetch);
    Object.assign(host.overrides, {
      'vscode.workspace.workspaceFolders': [{ uri: { fsPath: workspace, scheme: 'file', path: workspace, toString: () => `file://${workspace}` }, name: 'w', index: 0 }],
    });
    // The configuration: every setting at its declared default (package.json), nothing set by the workspace.
    const declared = (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).contributes.configuration as
      Array<{ properties: Record<string, { default?: unknown }> }> | { properties: Record<string, { default?: unknown }> });
    const defaults = new Map<string, unknown>();
    for (const block of Array.isArray(declared) ? declared : [declared]) {
      for (const [key, spec] of Object.entries(block.properties)) defaults.set(key, spec.default);
    }
    const userValues = new Map<string, unknown>();
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
    await new PersistenceManager(context as never, undefined, () => workspace, undefined, undefined,
      new RootScopedWorkspaceState(context.workspaceState as never, workspace)).saveAgents(options.agents ?? [
      agent('pm', 'pm', 'PM', 'pm-model'),
      agent('senior-dev', 'dev', 'Dev', 'dev-model'),
      // v0.9.103: a second teammate, so that two requests of the PM can have work running at once.
      agent('senior-dev', 'writer', 'Writer', 'writer-model'),
    ]);
    const extension = await import('../../extension');
    await extension.activate(context as never);
    const chat = host.views.get('unode.chat') as Parameters<typeof chatScreen>[0];
    expect(chat, 'activation registers the chat view').toBeDefined();
    chatProvider = chat;
    screen = chatScreen(chat);
    await screen.pump();
    ready({ chatProvider, screen });
  });

  afterAll(async () => {
    for (const sub of context.subscriptions.splice(0)) { try { sub.dispose(); } catch { /* ignore */ } }
    vi.unstubAllGlobals();
    for (const folder of [base, elsewhere]) fs.rmSync(folder, { recursive: true, force: true });
  });
}
