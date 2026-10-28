import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../../session/SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import { UserRequestEntrance } from '../UserRequestEntrance';
import { prepareAndSubmit, STOPPED_BEFORE_SENDING, stopPreparing, UserRequestPreparations } from '../userRequestPreparations';
import { fetchMentionWithReminders } from '../../session/mentionFetch';
import { expandContextMentions } from '../../session/ContextMentions';
import { parseMentions } from '../../session/FileMentions';
import type { AgentBackend, BackendEventHandler } from '../../backend/AgentBackend';
import type { AgentConfig } from '../../types';

/**
 * v0.9.99 (audit of 036061e6, I1): every Stop of the person ends a message still being prepared, from whichever surface
 * it comes: the chat's Stop, the agent row's Stop and Stop all agents. The extension's own send callback, its Stop
 * callbacks and its registered commands run here unchanged over a real SessionManager, MessageBus and request entrance;
 * the page of an @url mention is held until after the Stop.
 */

class Backend implements AgentBackend {
  pid = 1;
  handler?: BackendEventHandler;
  turns: string[] = [];
  alive = false;
  constructor(readonly agentId: string) {}
  onEvent(handler: BackendEventHandler) { this.handler = handler; return () => { this.handler = undefined; }; }
  async start() { this.alive = true; this.handler?.({ kind: 'ready' }); }
  sendUserTurn(text: string) { this.turns.push(text); }
  async stop() { this.alive = false; }
  abort() {}
  isAlive() { return this.alive; }
}

const source = readFileSync(path.join(__dirname, '..', '..', 'extension.ts'), 'utf8');
const js = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function slice(from: string, to: string, at = 0): string {
  const start = source.indexOf(from, at);
  expect(start, from).toBeGreaterThan(0);
  const end = source.indexOf(to, start);
  expect(end, to).toBeGreaterThan(start);
  return source.slice(start, end);
}

function config(id: string): AgentConfig {
  return {
    id, name: id, role: 'senior-dev', skill: '', model: 'm', backend: 'openai-compat',
    provider: { providerId: 'openai', apiKeySecretName: 'K' } as AgentConfig['provider'],
    systemPrompt: '', autoApprove: true, allowedTools: [],
  };
}

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

async function host(agents: string[]) {
  const bus = new MessageBus();
  const made: Backend[] = [];
  const manager = new SessionManager(4, bus, {
    createBackend: (agent: AgentConfig) => { const backend = new Backend(agent.id); made.push(backend); return backend; },
    resolveEnv: async () => ({}),
  } as never);
  disposers.push(() => manager.dispose());
  for (const id of agents) manager.create(config(id));
  const preparations = new UserRequestPreparations();
  const notices: Array<[string, string]> = [];
  const stoppedWaiting: Array<readonly string[] | 'all'> = [];
  const chatViewProvider = {
    postNotice: (id: string, text: string) => { notices.push([id, text]); }, postRuntimeNotice() {},
    stopWaitingSends: (agentIds: readonly string[] | 'all') => { stoppedWaiting.push(agentIds); },
  };
  const entrance = new UserRequestEntrance({
    bus, beginUserRequest: () => {},
    agents: { has: (id) => !!manager.get(id), isRunning: (id) => manager.isRunning(id), start: (id) => manager.start(id, { pin: 'reuse' }) },
  });
  // Each page is held until the test answers it.
  const pages = new Map<string, { signal: AbortSignal; answer: (text: string) => void }>();
  const waiting = new Map<string, () => void>();
  const fetchMentionUrl = async (url: string, stopped: AbortSignal) => {
    const text = await fetchMentionWithReminders(url, {
      fetch: (_url, signal) => new Promise<string>((answer) => { pages.set(url, { signal, answer }); waiting.get(url)?.(); }),
      remind: () => new Promise(() => {}), setTimer: () => () => {}, now: () => 0,
    }, stopped);
    return { ok: true, text };
  };
  const stopPreparingMessages = new Function('stopPreparing', 'userRequestPreparations', 'chatViewProvider',
    js(`${slice('const stopPreparingMessages =', '\n\n')}\nreturn stopPreparingMessages;`))(
    stopPreparing, preparations, chatViewProvider);
  // A callback of the chat's ports, from its exact head to the next port.
  const callback = (head: string, next: string) => slice(head, next).slice(head.indexOf(': ') + 2).trim().replace(/,$/, '');
  const send = new Function('prepareAndSubmit', 'userRequestPreparations', 'workspaceRoot', 'expandContextMentions',
    'fs', 'diagnosticsSnapshot', 'fetchMentionUrl', 'userTurnSources', 'delegationContentAssets', 'parseMentions',
    'userRequests', js(`return (${callback('send: async (agentId, text, mode, userAttachments, turnEpoch) => {', '\n    interject:')});`))(
    prepareAndSubmit, preparations, () => process.cwd(), expandContextMentions, {}, () => ({ items: [] }),
    fetchMentionUrl, async () => ({ contextManifestSources: [], delegationContentSources: [] }),
    { holdForUserRequest() {} }, parseMentions, entrance,
  ) as (id: string, text: string, mode: string, attachments: unknown[], epoch: number) => Promise<void>;
  const interrupt = new Function('stopPreparingMessages', 'sessionManager',
    js(`return (${callback('interrupt: (agentId) => {', '\n    contextMeter:')});`))(stopPreparingMessages, manager) as (id: string) => void;
  const commands = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  for (const name of ['unode.agentStop', 'unode.stopAllAgents', 'unode.newModelConversation']) {
    const text = slice(`reg('${name}',`, '\n  }));') + '\n  }));';
    new Function('reg', 'guard', 'sessionManager', 'stopPreparingMessages', 'userRequestPreparations', 'isE2EFixtureRequest',
      'extensionContext', 'showResultNotice', 'chatViewProvider', js(text))(
      (_name: string, run: (...args: unknown[]) => Promise<unknown>) => { commands.set(name, run); },
      (run: () => unknown) => run(), manager, stopPreparingMessages, preparations, () => true, undefined, () => {},
      { ...chatViewProvider, getSelectedAgentId: () => 'dev' },
    );
  }
  /** Send a message with an @url and wait until its page is being read; `done` settles when the send callback does. */
  async function sendReading(agentId: string, url: string): Promise<{ done: Promise<void> }> {
    const reading = new Promise<void>((resolve) => waiting.set(url, resolve));
    const done = send(agentId, `Read @${url}`, 'act', [], 1);
    await reading;
    return { done };
  }
  async function settle() { for (let n = 0; n < 40; n += 1) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); }
  const turnsOf = (id: string) => made.filter((backend) => backend.agentId === id).flatMap((backend) => backend.turns);
  return { bus, made, manager, preparations, notices, stoppedWaiting, pages, interrupt, commands, sendReading, settle, turnsOf };
}

describe('every Stop of the person ends a message still being prepared', () => {
  it.each([
    ['the chat\'s Stop', 'interrupt'],
    ['the agent row\'s Stop', 'unode.agentStop'],
    ['Stop all agents', 'unode.stopAllAgents'],
  ])('%s: the page read is aborted, the late page sends nothing and the chat says so', async (_label, surface) => {
    const h = await host(['dev']);
    await h.manager.start('dev', { pin: 'take' });
    const { done: sent } = await h.sendReading('dev', 'https://example.com/a');
    if (surface === 'interrupt') h.interrupt('dev');
    else await h.commands.get(surface)!('dev');
    expect(h.pages.get('https://example.com/a')!.signal.aborted).toBe(true);
    expect(h.preparations.pending('dev')).toBe(0);
    h.pages.get('https://example.com/a')!.answer('Late page.');
    await sent;
    await h.settle();
    expect(h.bus.query({ from: 'user', to: 'dev' })).toHaveLength(0);
    expect(h.turnsOf('dev')).toEqual([]);
    expect(h.notices).toEqual([['dev', STOPPED_BEFORE_SENDING]]);
    // The composers are told too, for a Send still waiting there for its files.
    expect(h.stoppedWaiting).toEqual([surface === 'unode.stopAllAgents' ? 'all' : ['dev']]);
  });

  it('the agent row\'s Stop leaves another agent\'s message being prepared, which is then sent', async () => {
    const h = await host(['dev', 'other']);
    await h.manager.start('dev', { pin: 'take' });
    await h.manager.start('other', { pin: 'take' });
    const { done: devSent } = await h.sendReading('dev', 'https://example.com/dev');
    const { done: otherSent } = await h.sendReading('other', 'https://example.com/other');
    await h.commands.get('unode.agentStop')!('dev');
    expect(h.pages.get('https://example.com/other')!.signal.aborted).toBe(false);
    h.pages.get('https://example.com/dev')!.answer('Dev page.');
    h.pages.get('https://example.com/other')!.answer('Other page.');
    await Promise.all([devSent, otherSent]);
    await h.settle();
    expect(h.turnsOf('dev')).toEqual([]);
    expect(h.turnsOf('other')).toHaveLength(1);
    expect(h.notices).toEqual([['dev', STOPPED_BEFORE_SENDING]]);
  });

  it('Stop all agents also ends a message sent to an agent whose session had already stopped', async () => {
    const h = await host(['dev', 'idle']);
    await h.manager.start('dev', { pin: 'take' });
    // 'idle' never started: its message would start it once prepared.
    const { done: devSent } = await h.sendReading('dev', 'https://example.com/dev');
    const { done: idleSent } = await h.sendReading('idle', 'https://example.com/idle');
    await h.commands.get('unode.stopAllAgents')!();
    h.pages.get('https://example.com/dev')!.answer('Dev page.');
    h.pages.get('https://example.com/idle')!.answer('Idle page.');
    await Promise.all([devSent, idleSent]);
    await h.settle();
    expect(h.turnsOf('dev')).toEqual([]);
    expect(h.turnsOf('idle')).toEqual([]);
    expect(h.manager.get('idle')?.status).toBe('stopped');
    expect(h.notices.sort()).toEqual([['dev', STOPPED_BEFORE_SENDING], ['idle', STOPPED_BEFORE_SENDING]]);
  });

  it('the agent row\'s Stop of an agent that was not running still ends its message being prepared', async () => {
    const h = await host(['dev']);
    const { done: sent } = await h.sendReading('dev', 'https://example.com/a');
    await h.commands.get('unode.agentStop')!('dev');
    h.pages.get('https://example.com/a')!.answer('Late page.');
    await sent;
    await h.settle();
    expect(h.made).toEqual([]);
    expect(h.manager.get('dev')?.status).toBe('stopped');
  });

  // The Owner-facing ruling: a new model conversation keeps the chat, and the message the person sent with it.
  it('a new model conversation keeps a message being prepared, which goes to the new conversation', async () => {
    const h = await host(['dev']);
    await h.manager.start('dev', { pin: 'take' });
    const { done: sent } = await h.sendReading('dev', 'https://example.com/a');
    const [before] = h.made;
    await h.commands.get('unode.newModelConversation')!();
    expect(h.pages.get('https://example.com/a')!.signal.aborted).toBe(false);
    h.pages.get('https://example.com/a')!.answer('Page after the reset.');
    await sent;
    await h.settle();
    expect(before.turns).toEqual([]);
    expect(h.made.length).toBeGreaterThan(1);
    expect(h.made.at(-1)!.turns).toHaveLength(1);
    expect(h.notices).toEqual([]);
    expect(h.stoppedWaiting).toEqual([]);
  });

  it('the Stop of a native-subagent warning ends a message being prepared before it stops the turn', () => {
    expect(source).toMatch(/if \(choice === STOP_AGENT_ACTION\) \{\s*stopPreparingMessages\(\[agentId\]\);\s*sessionManager\.interrupt\(agentId\);/);
  });
});
