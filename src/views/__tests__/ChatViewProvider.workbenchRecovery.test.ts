import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * v0.9.96: the Workbench composer's saved copy and the recovery of a Workbench tab that VS Code kept after an
 * extension host restart. These tests drive the real view and the real webview script through the production
 * attach paths (create, serializer restore, recovery), with the page's messages going through the real parser.
 */

interface FakePanel {
  panel: any;
  messages: Array<(message: unknown) => void>;
  disposeListeners: Array<() => void>;
}

const created: FakePanel[] = [];

function fakePanel(viewColumn: number): FakePanel {
  const fake: FakePanel = { panel: undefined, messages: [], disposeListeners: [] };
  const subscribe = <T>(list: T[]) => (listener: T, _thisArg?: unknown, disposables?: Array<{ dispose(): void }>) => {
    list.push(listener);
    const disposable = { dispose: () => { list.splice(list.indexOf(listener), 1); } };
    disposables?.push(disposable);
    return disposable;
  };
  fake.panel = {
    title: 'UnodeAi Workbench', visible: true, active: true, viewColumn,
    reveal: vi.fn(),
    dispose: vi.fn(() => { [...fake.disposeListeners].forEach((listener) => listener()); }),
    onDidDispose: subscribe(fake.disposeListeners),
    onDidChangeViewState: subscribe<() => void>([]),
    webview: {
      options: {}, html: '', cspSource: 'test:',
      postMessage: vi.fn(async () => true),
      onDidReceiveMessage: subscribe(fake.messages),
    },
  };
  return fake;
}

vi.mock('vscode', () => ({
  ViewColumn: { Active: -1, One: 1, Two: 2 },
  commands: { executeCommand: vi.fn() },
  window: {
    createWebviewPanel: vi.fn((_type: string, _title: string, column: number) => {
      const fake = fakePanel(column === -1 ? 1 : column);
      created.push(fake);
      return fake.panel;
    }),
  },
}));

import { ChatAgent, ChatViewDeps, ChatViewProvider } from '../ChatViewProvider';
import { ChatDraftMirror, CHAT_DRAFT_MIRROR_KEY, type ChatDraftMirrorStore } from '../chatDraftMirror';
import { bootWebviewScript } from './support/webviewBoot';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { migrateAgentConfigOrRepair, RouteMigrationError } from '../../routes/RouteMigration';
import { BUILTIN_CONNECTION_REGISTRY } from '../../routes/ConnectionRegistry';

const pm: ChatAgent = { id: 'pm', name: 'PM', role: 'Project Manager', backend: 'openai' };
const dev: ChatAgent = { id: 'dev', name: 'Dev', role: 'Developer', backend: 'openai' };

function storeFor() {
  const values = new Map<string, unknown>();
  const pending: Array<() => void> = [];
  let hold = false;
  const store: ChatDraftMirrorStore = {
    available: () => true,
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: (key, value) => new Promise<void>((resolve) => {
      const write = () => { values.set(key, JSON.parse(JSON.stringify(value))); resolve(); };
      if (hold) pending.push(write); else write();
    }),
  };
  return {
    store,
    copy: () => (values.get(CHAT_DRAFT_MIRROR_KEY) as { drafts: Record<string, { text: string }> } | undefined)?.drafts ?? {},
    incarnations: () => Object.keys((values.get(CHAT_DRAFT_MIRROR_KEY) as { incarnations?: Record<string, unknown> } | undefined)?.incarnations ?? {}),
    hold: () => { hold = true; },
    release: () => { hold = false; pending.splice(0).forEach((write) => write()); },
  };
}

function chat(options: { agents?: ChatAgent[]; backing?: ReturnType<typeof storeFor>; shuttingDown?: boolean; waitForRoster?: boolean } = {}) {
  let agents = options.agents ?? [pm, dev];
  const backing = options.backing ?? storeFor();
  const mirror = new ChatDraftMirror(backing.store);
  const chatState = new Map<string, unknown>();
  const shutting = { now: options.shuttingDown ?? false };
  const deps = {
    listAgents: () => agents,
    send: vi.fn(),
    interject: vi.fn(),
    interrupt: vi.fn(),
    onReply: () => vi.fn(),
    draftMirror: mirror,
    shuttingDown: () => shutting.now,
    waitForRoster: options.waitForRoster,
    state: {
      get: <T>(key: string) => chatState.get(key) as T | undefined,
      update: (key: string, value: unknown) => { chatState.set(key, value); return Promise.resolve(); },
    },
    getApprovals: () => ({ command: 'ask', write: 'none' }),
    setApproval: vi.fn(),
  } as unknown as ChatViewDeps;
  const provider = new ChatViewProvider({} as never, deps);
  return {
    provider, deps, mirror, backing, shutting,
    setAgents: (next: ChatAgent[]) => { agents = next; },
  };
}

/** The booted page of a panel, wired both ways: page posts reach the host handler, host posts reach the page. */
function page(fake: FakePanel, savedState?: unknown) {
  const boot = bootWebviewScript(fake.panel.webview.html, { state: savedState });
  let forwarded = 0;
  const pump = () => {
    while (forwarded < boot.postedMessages.length) {
      const message = boot.postedMessages[forwarded++];
      [...fake.messages].forEach((listener) => listener(message));
    }
  };
  fake.panel.webview.postMessage.mockImplementation(async (message: unknown) => {
    (boot.listeners.message ?? []).forEach((listener) => listener({ data: message }));
    return true;
  });
  const input = boot.elements.get('input')!;
  const settle = async () => {
    for (let round = 0; round < 6; round += 1) {
      pump();
      for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    }
  };
  return {
    boot, pump, input, settle,
    posted: (command: string) => boot.postedMessages.filter((message: any) => message.command === command) as any[],
    status: () => {
      const element = boot.elements.get('draftStatus')!;
      return element.hidden ? '' : String(element.textContent);
    },
    type: (text: string) => {
      input.value = text;
      (boot.listeners.input ?? []).forEach((listener) => listener());
    },
    send: () => (boot.listeners.click ?? []).find((listener) => listener.name === 'send')!(),
  };
}

const openWorkbench = (provider: ChatViewProvider) => {
  provider.openWorkbench(false);
  return created.at(-1)!;
};

beforeEach(() => {
  created.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the Workbench composer\'s saved copy (v0.9.96)', () => {
  it('copies a draft after a pause in typing, and shows a slow copy as pending until the write settles', async () => {
    const backing = storeFor();
    const { provider, mirror } = chat({ backing });
    provider.selectAgent(dev.id);
    const workbench = page(openWorkbench(provider));
    await workbench.settle();
    expect(workbench.posted('draftSync')).toHaveLength(1);
    const devEpoch = mirror.epochOf('dev');
    expect(devEpoch).toBeGreaterThan(0);
    backing.hold();
    workbench.type('half a thought');
    await vi.advanceTimersByTimeAsync(749);
    expect(workbench.posted('draftEdit')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await workbench.settle();
    expect(workbench.posted('draftEdit')).toEqual([expect.objectContaining({ agentId: 'dev', text: 'half a thought', epoch: devEpoch })]);
    expect(backing.copy()).toEqual({});
    await vi.advanceTimersByTimeAsync(2000);
    expect(workbench.status()).toBe('Saving a copy of this draft…');
    backing.release();
    await workbench.settle();
    expect(backing.copy().dev.text).toBe('half a thought');
    expect(workbench.status()).toBe('');
  });

  it('still copies at least every two seconds while typing never pauses', async () => {
    const { provider } = chat();
    provider.selectAgent(dev.id);
    const workbench = page(openWorkbench(provider));
    await workbench.settle();
    for (let keystroke = 1; keystroke <= 10; keystroke += 1) {
      workbench.type('x'.repeat(keystroke));
      await vi.advanceTimersByTimeAsync(500);
    }
    await workbench.settle();
    expect(workbench.posted('draftEdit').map((edit) => edit.text.length)).toEqual([4, 8]);
  });

  it('marks text typed after an unconfirmed send as newer than that send once its late acknowledgement arrives', async () => {
    const { provider } = chat();
    provider.selectAgent(dev.id);
    const fake = openWorkbench(provider);
    const workbench = page(fake);
    await workbench.settle();
    workbench.type('first message');
    // The acknowledgement is held back, as when the host was busy or restarting.
    fake.panel.webview.postMessage.mockImplementation(async () => true);
    workbench.send();
    workbench.pump();
    await vi.advanceTimersByTimeAsync(10_000);
    workbench.type('typed while unconfirmed');
    const accepted = (fake.panel.webview.postMessage.mock.calls as any[][])
      .map(([message]) => message).find((message: any) => message.command === 'sendAccepted');
    expect(accepted.draftSeq).toBeGreaterThan(0);
    (workbench.boot.listeners.message ?? []).forEach((listener) => listener({ data: accepted }));
    expect(workbench.input.value).toBe('typed while unconfirmed');
    const saved = workbench.boot.savedStates.at(-1) as { draftsByAgent: Record<string, { basis: number }> };
    expect(saved.draftsByAgent.dev.basis).toBeGreaterThanOrEqual(accepted.draftSeq);
  });

  it('copies a deletion at once, so a reload cannot bring back what the user removed', async () => {
    const backing = storeFor();
    const { provider } = chat({ backing });
    provider.selectAgent(dev.id);
    const workbench = page(openWorkbench(provider));
    workbench.type('remove me');
    await vi.advanceTimersByTimeAsync(750);
    await workbench.settle();
    expect(backing.copy().dev.text).toBe('remove me');
    workbench.type('');
    await vi.advanceTimersByTimeAsync(0);
    await workbench.settle();
    expect(backing.copy()).toEqual({});
  });

  it('says so when a draft is too long for a copy, and sends no text of it', async () => {
    const { provider } = chat();
    provider.selectAgent(dev.id);
    const workbench = page(openWorkbench(provider));
    workbench.type('z'.repeat(1_000_001));
    await vi.advanceTimersByTimeAsync(750);
    await workbench.settle();
    expect(workbench.posted('draftEdit').at(-1)).toMatchObject({ agentId: 'dev', text: '', overLimit: true });
    expect(workbench.status()).toBe('This draft is longer than 1,000,000 characters, so it has no saved copy. Only this tab holds it.');
  });

  it('keeps the sidebar out of it: VS Code reconnects the sidebar itself, so it sends no draft message', async () => {
    const { provider, mirror } = chat();
    const listeners: Array<(message: unknown) => void> = [];
    const view: any = {
      visible: true,
      webview: { options: {}, html: '', cspSource: 'test:', postMessage: vi.fn(async () => true), onDidReceiveMessage: (listener: any) => { listeners.push(listener); return { dispose() {} }; } },
      onDidChangeVisibility: () => ({ dispose() {} }),
      onDidDispose: () => ({ dispose() {} }),
    };
    provider.resolveWebviewView(view);
    const sidebar = bootWebviewScript(view.webview.html);
    expect(sidebar.postedMessages.some((message: any) => message.command === 'draftSync')).toBe(false);
    // A sidebar message naming the Workbench's generation is still not the Workbench.
    const workbench = page(openWorkbench(provider));
    await workbench.settle();
    const surface = workbench.posted('draftSync')[0].surface;
    listeners.forEach((listener) => listener({ command: 'draftEdit', surface, agentId: 'dev', text: 'forged', revision: 99, epoch: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(mirror.seed(new Set(['dev']))).toEqual([]);
  });

  it('retires the copy only when the host accepts that send, and a sidebar send leaves the Workbench copy alone', async () => {
    const backing = storeFor();
    const { provider, deps } = chat({ backing });
    provider.selectAgent(dev.id);
    const workbench = page(openWorkbench(provider));
    workbench.type('ship it');
    await vi.advanceTimersByTimeAsync(750);
    await workbench.settle();
    expect(backing.copy().dev.text).toBe('ship it');

    // A send of the same agent from the sidebar is another composer's text, even one naming the Workbench's generation.
    const surface = workbench.posted('draftSync')[0].surface;
    (provider as any).onMessage({
      command: 'send', requestId: 'sidebar-1', agentId: 'dev', text: 'from the sidebar', mode: 'act', draftSurface: surface, draftRevision: Number.MAX_SAFE_INTEGER,
    }, 'sidebar');
    await workbench.settle();
    expect(backing.copy().dev.text).toBe('ship it');

    workbench.send();
    await workbench.settle();
    const [sent] = workbench.posted('send');
    expect(sent).toMatchObject({ agentId: 'dev', text: 'ship it', draftSurface: expect.any(String), draftRevision: expect.any(Number) });
    // The sidebar's send left dev running, so this one is accepted as a steering message.
    expect(deps.interject).toHaveBeenCalledWith('dev', 'ship it');
    expect(backing.copy()).toEqual({});
    expect(workbench.input.value).toBe('');
  });

  it('keeps the copy when the host rejects the send', async () => {
    const backing = storeFor();
    const { provider, setAgents } = chat({ backing });
    provider.selectAgent(dev.id);
    const workbench = page(openWorkbench(provider));
    workbench.type('keep me');
    await vi.advanceTimersByTimeAsync(750);
    await workbench.settle();
    setAgents([pm]);
    workbench.send();
    await workbench.settle();
    expect(workbench.input.value).toBe('keep me');
    expect(workbench.posted('send')).toHaveLength(1);
    // A rejected send retires nothing: the saved copy still holds the text.
    expect(backing.copy().dev.text).toBe('keep me');
    // That revision was already copied, so it is not sent for copying again, and no save is shown as waiting.
    await vi.advanceTimersByTimeAsync(3000);
    await workbench.settle();
    expect(workbench.posted('draftEdit')).toHaveLength(1);
    expect(workbench.status()).toBe('');
  });

  it('retires the copy when a steering message is accepted', async () => {
    const backing = storeFor();
    const { provider, deps } = chat({ backing });
    provider.selectAgent(dev.id);
    provider.appendDelta(dev.id, 'working');
    const workbench = page(openWorkbench(provider));
    workbench.type('steer this way');
    await vi.advanceTimersByTimeAsync(750);
    await workbench.settle();
    workbench.send();
    await workbench.settle();
    expect(deps.interject).toHaveBeenCalledWith('dev', 'steer this way');
    expect(backing.copy()).toEqual({});
  });

  it('ignores a draft message of a replaced page generation, though it arrives on the live subscription', async () => {
    const { provider, mirror, shutting } = chat();
    provider.selectAgent(dev.id);
    const first = page(openWorkbench(provider));
    await first.settle();
    const oldSurface = first.posted('draftSync')[0].surface;
    shutting.now = true;
    created[0].panel.dispose();
    shutting.now = false;
    const restored = fakePanel(1);
    provider.restoreWorkbench(restored.panel, undefined);
    restored.messages.forEach((listener) => listener({ command: 'draftEdit', surface: oldSurface, agentId: 'dev', text: 'late', revision: 10, epoch: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(mirror.seed(new Set(['dev']))).toEqual([]);
  });

  it('clears the copy when the user closes the Workbench, and keeps it when the window is closing', async () => {
    const backing = storeFor();
    const { provider, shutting } = chat({ backing });
    provider.selectAgent(dev.id);
    const closing = page(openWorkbench(provider));
    closing.type('survives a reload');
    await vi.advanceTimersByTimeAsync(750);
    await closing.settle();
    shutting.now = true;
    created[0].panel.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(backing.copy().dev.text).toBe('survives a reload');
    shutting.now = false;
    const reopened = page(openWorkbench(provider));
    await reopened.settle();
    created[1].panel.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(backing.copy()).toEqual({});
  });
});

describe('a Workbench rebuilt after an extension host restart (v0.9.96)', () => {
  async function savedCopy(text: string, agentId = 'dev') {
    const backing = storeFor();
    const before = chat({ backing });
    before.provider.selectAgent(agentId);
    const old = page(openWorkbench(before.provider));
    old.type(text);
    await vi.advanceTimersByTimeAsync(750);
    await old.settle();
    // The old host is gone without closing its page, as Restart Extension Host leaves it.
    created.length = 0;
    return backing;
  }

  it('restores the saved text and the agent in the old group, says it may be older, and sends nothing', async () => {
    const backing = await savedCopy('unsent words');
    const { provider, deps } = chat({ backing });
    // The new host starts on its first agent; nobody chose one in it.
    expect((provider as any).currentState().selectedAgentId).toBe('pm');
    provider.openRecoveredWorkbench(2);
    expect(created).toHaveLength(1);
    expect(created[0].panel.viewColumn).toBe(2);
    const rebuilt = page(created[0]);
    await rebuilt.settle();
    expect((provider as any).currentState().selectedAgentId).toBe('dev');
    expect(rebuilt.input.value).toBe('unsent words');
    expect(rebuilt.status()).toBe('This Workbench restored unsent text from its last saved copy. Text typed in the old tab after that copy was saved is not here.');
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.interject).not.toHaveBeenCalled();
    rebuilt.type('unsent words, continued');
    expect(rebuilt.status()).toBe('');
  });

  it('accepts one explicit new send from the rebuilt Workbench, exactly once, and retires its copy', async () => {
    const backing = await savedCopy('send this now');
    const { provider, deps } = chat({ backing });
    provider.openRecoveredWorkbench(1);
    const rebuilt = page(created[0]);
    await rebuilt.settle();
    rebuilt.send();
    await rebuilt.settle();
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledWith('dev', 'send this now', 'act', [], expect.any(Number));
    expect(rebuilt.boot.postedMessages.filter((message: any) => message.command === 'send')).toHaveLength(1);
    expect(rebuilt.input.value).toBe('');
    expect(backing.copy()).toEqual({});
  });

  it('says when there was no saved copy to restore', async () => {
    const { provider } = chat();
    provider.openRecoveredWorkbench(1);
    const rebuilt = page(created[0]);
    await rebuilt.settle();
    expect(rebuilt.input.value).toBe('');
    expect(rebuilt.status()).toBe('UnodeAi had no saved copy of unsent text from the old Workbench tab.');
  });

  it('never opens a second live Workbench: a rebuild when one is attached, or an open recovery takes, creates none', () => {
    const { provider } = chat();
    openWorkbench(provider);
    provider.openRecoveredWorkbench(2);
    expect(created).toHaveLength(1);
    const gated = chat();
    gated.provider.setWorkbenchRecovery({ interceptOpen: () => true, changed: () => undefined });
    gated.provider.openWorkbench(false);
    expect(created).toHaveLength(1);
  });

  it('shows a tab the serializer restores while a Workbench is live as an older copy that runs nothing', async () => {
    const { provider } = chat();
    openWorkbench(provider);
    const late = fakePanel(2);
    provider.restoreWorkbench(late.panel, { draftsByAgent: { dev: { text: '<b>keep</b> & copy', editedAt: 5 } } });
    expect(late.panel.title).toBe('UnodeAi Workbench (older copy)');
    expect(late.panel.webview.options.enableScripts).toBe(false);
    expect(late.panel.webview.html).not.toContain('<script');
    expect(late.panel.webview.html).toContain('&lt;b&gt;keep&lt;/b&gt; &amp; copy');
    expect(late.panel.webview.html).toContain('<h2>Dev</h2>');
    expect(late.messages).toHaveLength(0);
    expect(provider.liveWorkbenchPlacement()).toEqual({ viewColumn: 1, visible: true });
  });

  it('drops a restored draft its agent\'s removal made stale, so an agent with the reused id inherits nothing', async () => {
    const { provider, mirror } = chat();
    provider.selectAgent(dev.id);
    provider.clearAgent('dev');
    expect(mirror.epochOf('dev')).toBeGreaterThan(0);
    provider.selectAgent(dev.id);
    const restored = fakePanel(1);
    provider.restoreWorkbench(restored.panel, { draftsByAgent: { dev: { text: 'for the removed dev', editedAt: 3 } } });
    const reloaded = page(restored, { draftsByAgent: { dev: { text: 'for the removed dev', editedAt: 3 } } });
    await reloaded.settle();
    expect(reloaded.input.value).toBe('');
    expect(reloaded.posted('draftSync')[0].drafts).toEqual([]);
  });

  it('drops restored text the host already accepted as a send, when the reload came before the page heard so', async () => {
    const backing = storeFor();
    const before = chat({ backing });
    before.provider.selectAgent(dev.id);
    const live = page(openWorkbench(before.provider));
    await live.settle();
    const surface = live.posted('draftSync')[0].surface;
    // The host accepts the send; the page never processes the acknowledgement before the window reloads.
    (before.provider as any).onMessage({ command: 'send', requestId: 'r1', agentId: 'dev', text: 'already sent', mode: 'act', draftSurface: surface, draftRevision: 7 }, 'workbench');
    await before.mirror.flush();
    const { provider } = chat({ backing });
    provider.selectAgent(dev.id);
    const restored = fakePanel(1);
    const saved = { draftsByAgent: { dev: { text: 'already sent', editedAt: 7, epoch: 0, basis: 0 } } };
    provider.restoreWorkbench(restored.panel, saved);
    const reloaded = page(restored, saved);
    expect(reloaded.input.value).toBe('already sent');
    await reloaded.settle();
    expect(reloaded.input.value).toBe('');
  });
});

/** The sidebar chat page, wired both ways like `page`. */
function sidebarPage(provider: ChatViewProvider, savedState?: unknown) {
  const listeners: Array<(message: unknown) => void> = [];
  const view: any = {
    visible: true,
    webview: {
      options: {}, html: '', cspSource: 'test:',
      postMessage: vi.fn(async () => true),
      onDidReceiveMessage: (listener: (message: unknown) => void) => { listeners.push(listener); return { dispose() {} }; },
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
  };
  provider.resolveWebviewView(view);
  const boot = bootWebviewScript(view.webview.html, { state: savedState });
  view.webview.postMessage.mockImplementation(async (message: unknown) => {
    (boot.listeners.message ?? []).forEach((listener) => listener({ data: message }));
    return true;
  });
  const drafts = () => ((boot.savedStates.at(-1) ?? savedState) as { draftsByAgent?: Record<string, { text: string; epoch: number }> } | undefined)?.draftsByAgent ?? {};
  return { boot, input: boot.elements.get('input')!, drafts };
}

/** A Workbench whose send is accepted by the host but whose acknowledgement never reaches the page. */
async function unacknowledgedSend(provider: ChatViewProvider, text: string) {
  const fake = openWorkbench(provider);
  const live = page(fake);
  await live.settle();
  live.type(text);
  const withheld: unknown[] = [];
  fake.panel.webview.postMessage.mockImplementation(async (message: any) => {
    if (message.command === 'sendAccepted') withheld.push(message);
    else (live.boot.listeners.message ?? []).forEach((listener) => listener({ data: message }));
    return true;
  });
  live.send();
  live.pump();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(withheld).toHaveLength(1);
  return { fake, live, deliver: () => (live.boot.listeners.message ?? []).forEach((listener) => listener({ data: withheld[0] })) };
}

/** A reload: a new host with the same stored copy restores the Workbench from the page's saved state. */
async function reload(backing: ReturnType<typeof storeFor>, saved: unknown, select = dev.id) {
  const after = chat({ backing });
  after.provider.selectAgent(select);
  const restored = fakePanel(1);
  after.provider.restoreWorkbench(restored.panel, saved);
  const reloaded = page(restored, saved);
  await reloaded.settle();
  return { ...after, reloaded };
}

describe('the draft copy after Codex\'s audit of 0ec9c7e (v0.9.96)', () => {
  it('R1: choosing another agent after an unconfirmed send does not bring the sent text back after a reload', async () => {
    const backing = storeFor();
    const before = chat({ backing });
    before.provider.selectAgent(dev.id);
    const { live } = await unacknowledgedSend(before.provider, 'already accepted');
    before.provider.selectAgent(pm.id);
    const saved = structuredClone(live.boot.savedStates.at(-1));
    await before.mirror.flush();
    const { reloaded } = await reload(backing, saved);
    expect(reloaded.input.value).toBe('');
    expect(backing.copy()).not.toHaveProperty('dev');
  });

  it('R1: choosing another agent before the late acknowledgement still clears the sent draft, and only that one', async () => {
    const backing = storeFor();
    const before = chat({ backing });
    before.provider.selectAgent(pm.id);
    const fake = openWorkbench(before.provider);
    const pmPage = page(fake);
    await pmPage.settle();
    pmPage.type('pm text, not sent');
    before.provider.selectAgent(dev.id);
    pmPage.type('already accepted');
    const withheld: unknown[] = [];
    fake.panel.webview.postMessage.mockImplementation(async (message: any) => {
      if (message.command === 'sendAccepted') withheld.push(message);
      else (pmPage.boot.listeners.message ?? []).forEach((listener) => listener({ data: message }));
      return true;
    });
    pmPage.send();
    pmPage.pump();
    await vi.advanceTimersByTimeAsync(10_000);
    before.provider.selectAgent(pm.id);
    expect(pmPage.input.value).toBe('pm text, not sent');
    // Editing another agent's text is not a change to the sent draft either.
    pmPage.type('pm text, still not sent');
    (pmPage.boot.listeners.message ?? []).forEach((listener) => listener({ data: withheld[0] }));
    expect(pmPage.input.value).toBe('pm text, still not sent');
    const saved = pmPage.boot.savedStates.at(-1) as { draftsByAgent: Record<string, { text: string }> };
    expect(saved.draftsByAgent).not.toHaveProperty('dev');
    expect(saved.draftsByAgent.pm.text).toBe('pm text, still not sent');
  });

  it('R1 control: text really typed after the unconfirmed send survives the reload', async () => {
    const backing = storeFor();
    const before = chat({ backing });
    before.provider.selectAgent(dev.id);
    const { live } = await unacknowledgedSend(before.provider, 'already accepted');
    live.type('already accepted, and more');
    before.provider.selectAgent(pm.id);
    await vi.advanceTimersByTimeAsync(750);
    await live.settle();
    const saved = structuredClone(live.boot.savedStates.at(-1));
    await before.mirror.flush();
    const { reloaded } = await reload(backing, saved);
    expect(reloaded.input.value).toBe('already accepted, and more');
    expect(backing.copy().dev.text).toBe('already accepted, and more');
  });

  it('R2: a sidebar draft of a removed agent never reappears under a new agent with the same id', async () => {
    const { provider, mirror } = chat();
    provider.selectAgent(dev.id);
    const firstDev = mirror.epochOf('dev');
    provider.clearAgent('dev');
    provider.selectAgent(dev.id);
    expect(mirror.epochOf('dev')).not.toBe(firstDev);
    const sidebar = sidebarPage(provider, { draftsByAgent: { dev: { text: 'for the first dev', editedAt: 5, epoch: firstDev, basis: 0 } } });
    expect(sidebar.input.value).toBe('');
    expect(sidebar.drafts()).not.toHaveProperty('dev');
  });

  it('R2: untagged drafts of an earlier UnodeAi are kept for the first roster\'s agents, and dropped for a recreated one', async () => {
    const { provider, mirror } = chat();
    provider.selectAgent(pm.id);
    provider.clearAgent('dev');
    provider.selectAgent(pm.id);
    const sidebar = sidebarPage(provider, {
      draftsByAgent: { pm: { text: 'typed in 0.9.95', editedAt: 5 }, dev: { text: 'old dev, 0.9.95', editedAt: 6 } },
    });
    expect(sidebar.input.value).toBe('typed in 0.9.95');
    expect(sidebar.drafts().pm).toMatchObject({ text: 'typed in 0.9.95', epoch: mirror.epochOf('pm') });
    expect(sidebar.drafts()).not.toHaveProperty('dev');
  });

  it('a reload that restores the Workbench before the roster keeps its drafts, and copies them once the roster is in', async () => {
    const backing = storeFor();
    const qa: ChatAgent = { id: 'qa', name: 'QA', role: 'Reviewer', backend: 'openai' };
    const before = chat({ backing, agents: [pm, dev, qa] });
    before.provider.selectAgent(dev.id);
    const live = page(openWorkbench(before.provider));
    await live.settle();
    live.type('survives');
    await vi.advanceTimersByTimeAsync(750);
    await live.settle();
    // The last words never reached the copy before the reload; only the page's own state holds them.
    live.type('survives the reload');
    const saved = structuredClone(live.boot.savedStates.at(-1));
    await before.mirror.flush();
    expect(backing.copy().dev.text).toBe('survives');
    expect(backing.incarnations()).toContain('qa');

    // The new host registers the views before it restores the roster, and VS Code restores the tab at once.
    const after = chat({ backing, waitForRoster: true, agents: [] });
    const restored = fakePanel(1);
    after.provider.restoreWorkbench(restored.panel, saved);
    const reloaded = page(restored, saved);
    await reloaded.settle();
    expect((reloaded.boot.savedStates.at(-1) as { draftsByAgent: Record<string, unknown> }).draftsByAgent).toHaveProperty('dev');
    expect(reloaded.posted('draftSync')).toHaveLength(1);
    expect((after.provider as any).currentState()).toMatchObject({ rosterReady: false, draftEpochs: {}, draftAdopts: [] });

    // qa was removed from the team file between the two windows.
    after.setAgents([pm, dev]);
    after.provider.rosterLoaded();
    await reloaded.settle();
    after.provider.selectAgent(dev.id);
    await reloaded.settle();
    expect(reloaded.input.value).toBe('survives the reload');
    expect(backing.copy().dev.text).toBe('survives the reload');
    expect(backing.incarnations()).not.toContain('qa');
  });

  it('a Workbench opened before the roster is in deletes nothing from the copy it was not seeded with', async () => {
    const backing = storeFor();
    const before = chat({ backing });
    before.provider.selectAgent(dev.id);
    const live = page(openWorkbench(before.provider));
    live.type('kept in the copy');
    await vi.advanceTimersByTimeAsync(750);
    await live.settle();
    await before.mirror.flush();
    created.length = 0;

    const after = chat({ backing, waitForRoster: true, agents: [] });
    const opened = page(openWorkbench(after.provider));
    await opened.settle();
    expect(opened.posted('draftSync')[0].drafts).toEqual([]);
    after.setAgents([pm, dev]);
    after.provider.rosterLoaded();
    await opened.settle();
    await after.mirror.flush();
    expect(backing.copy().dev.text).toBe('kept in the copy');
  });

  it('a Reload Window selects the agent last chosen once the roster is in, as Reopen Workbench does (v0.9.96)', async () => {
    const backing = storeFor();
    const before = chat({ backing });
    before.provider.selectAgent(dev.id);
    await before.mirror.flush();

    // The new host restores the tab before the roster: nothing to select yet.
    const after = chat({ backing, waitForRoster: true, agents: [] });
    after.provider.restoreWorkbench(fakePanel(1).panel, undefined);
    expect((after.provider as any).currentState().selectedAgentId).toBe('');
    after.setAgents([pm, dev]);
    after.provider.rosterLoaded();
    expect((after.provider as any).currentState().selectedAgentId).toBe('dev');

    // Removed between the two windows: the first agent, as before.
    const removed = chat({ backing, waitForRoster: true, agents: [] });
    removed.setAgents([pm]);
    removed.provider.rosterLoaded();
    expect((removed.provider as any).currentState().selectedAgentId).toBe('pm');

    // No agent was ever chosen: the first agent.
    const fresh = chat({ waitForRoster: true, agents: [] });
    fresh.setAgents([pm, dev]);
    fresh.provider.rosterLoaded();
    expect((fresh.provider as any).currentState().selectedAgentId).toBe('pm');
  });

  it('a choice made before the roster loads is kept, and the first agent picked by default is not a choice (v0.9.96)', async () => {
    const backing = storeFor();
    const before = chat({ backing });
    before.provider.selectAgent(dev.id);
    await before.mirror.flush();

    // Agents already listed before the roster loads: the first one is shown, but nobody chose it.
    const shown = chat({ backing, waitForRoster: true, agents: [pm, dev] });
    expect((shown.provider as any).currentState().selectedAgentId).toBe('pm');
    shown.provider.rosterLoaded();
    expect((shown.provider as any).currentState().selectedAgentId).toBe('dev');

    // The user chose PM in this start, before the roster loaded: that choice stays.
    const chosen = chat({ backing, waitForRoster: true, agents: [pm, dev] });
    chosen.provider.selectAgent(pm.id);
    chosen.provider.rosterLoaded();
    expect((chosen.provider as any).currentState().selectedAgentId).toBe('pm');
  });

  it('every way the user moves to another agent saves that choice for the next start (v0.9.96)', async () => {
    const solo: ChatAgent = { id: 'solo', name: 'Solo', role: 'solo', backend: 'openai' };
    const { provider, mirror } = chat({ agents: [pm, dev, solo] });

    // Continuing unfinished work with an agent.
    provider.selectAgent(pm.id);
    expect(provider.submitUserRequest(dev.id, 'Continue the unfinished work.')).toBe(true);
    expect(mirror.selectedAgentId()).toBe('dev');

    // Handing a request to Solo.
    provider.selectAgent(pm.id);
    (provider as any).suggestSoloHandoff(pm.id, solo.id, 'Trim the trailing spaces.', 'act', 1);
    const [suggestion] = Array.from((provider as any).soloSuggestions.keys()) as string[];
    await (provider as any).onMessage({ command: 'handoffToSolo', id: suggestion });
    expect(mirror.selectedAgentId()).toBe('solo');

    // Restoring an archived conversation.
    provider.selectAgent(dev.id);
    (provider as any).append(dev.id, { role: 'user', text: 'bring me back', ts: new Date().toISOString() });
    expect(provider.archiveSelectedAgent()).toBeGreaterThan(0);
    provider.selectAgent(pm.id);
    expect(provider.restoreArchive(provider.listArchivedChats()[0].id).ok).toBe(true);
    expect(mirror.selectedAgentId()).toBe('dev');
  });

  it('a sidebar resolved before the roster keeps its drafts', async () => {
    const { provider, setAgents, mirror } = chat({ waitForRoster: true, agents: [] });
    setAgents([]);
    const sidebar = sidebarPage(provider, { draftsByAgent: { dev: { text: 'sidebar text', editedAt: 5 } } });
    expect(sidebar.drafts()).toHaveProperty('dev');
    setAgents([pm, dev]);
    provider.rosterLoaded();
    provider.selectAgent(dev.id);
    expect(sidebar.input.value).toBe('sidebar text');
    expect(sidebar.drafts().dev).toMatchObject({ epoch: mirror.epochOf('dev') });
  });

  it('is wired so the provider waits for the roster the extension restores after registering the views', () => {
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    const deps = source.slice(source.indexOf('chatViewProvider = new ChatViewProvider('), source.indexOf('registerUnodeSidebarViews(context.subscriptions'));
    expect(deps).toContain('waitForRoster: true,');
    const registered = source.indexOf('registerUnodeSidebarViews(context.subscriptions');
    const restored = source.indexOf('rosterRestored = await restoreRoster();');
    expect(registered).toBeGreaterThan(0);
    expect(restored).toBeGreaterThan(registered);
  });

  it('copies no draft and recovers nothing before the roster is in', async () => {
    const backing = storeFor();
    const { provider } = chat({ backing, waitForRoster: true, agents: [] });
    expect(provider.isRosterLoaded()).toBe(false);
    const workbench = page(openWorkbench(provider));
    await workbench.settle();
    const [sync] = workbench.posted('draftSync');
    (provider as any).onMessage({ command: 'draftEdit', surface: sync.surface, agentId: 'dev', text: 'too early', revision: 99, epoch: 0 }, 'workbench');
    await workbench.settle();
    expect(backing.copy()).toEqual({});
    expect(provider.isRosterLoaded()).toBe(false);
  });
});

/**
 * extension.ts's own code, compiled alone and run against stand-ins for the module state it reads, as
 * deactivate.test.ts does: the extension does not load outside VS Code.
 */
function extensionPart(from: string, to: string, wrap: (body: string) => string, name: string): (state: Record<string, unknown>) => any {
  const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const js = ts.transpileModule(wrap(source.slice(start, end)), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return (state) => new Function('state', `with (state) { ${js}; return ${name}; }`)(state);
}

/** The roster loader. */
const loadRestoreRoster = extensionPart('async function restoreRoster(): Promise<boolean> {', '\nasync function saveRoster()', (body) => body, 'restoreRoster');
/** The lines of activate() right after the roster loader, which open the draft gate or keep it closed. */
const loadRosterGate = extensionPart('  let rosterRestored = false;', '  // Delegation cards were restored before the roster existed',
  (body) => `async function rosterGate() {\n${body}}`, 'rosterGate');

/** A stored agent whose connection this machine does not have: the loader's existing refusal path. */
const unrunnableDev = {
  id: 'dev', name: 'Dev', role: 'custom', skill: 'read', systemPrompt: 'test', autoApprove: false, allowedTools: ['read'],
  provider: { providerId: 'missing-provider', apiKeySecretName: '' }, backend: 'openai-compat', model: 'example-model',
};

/** What the roster loader reads, for a stored roster; `migrate` defaults to the real route migration. */
function rosterLoaderState(stored: unknown[], migrate: (config: any, registry: unknown) => unknown = migrateAgentConfigOrRepair) {
  const errors: string[] = [];
  const started: unknown[] = [];
  const state = {
    persistence: {
      migrateLegacyAgentAuthority: async () => [],
      loadTeamConfig: async () => undefined,
      loadHostMcpServers: () => [],
      loadAgents: () => stored,
      saveAgents: async () => undefined,
      saveTeamConfig: async () => undefined,
    },
    showResultNotice: async () => undefined,
    teamCompactionOverrides: undefined,
    mcpRegistry: new Map(),
    effectiveConnectionRegistry: BUILTIN_CONNECTION_REGISTRY,
    migrateAgentConfigOrRepair: migrate,
    RouteMigrationError,
    migratePromptTemplateSource: () => false,
    outputChannel: { error: () => undefined, info: () => undefined },
    vscode: { window: { showErrorMessage: (message: string) => { errors.push(message); }, showInformationMessage: () => undefined } },
    sessionManager: { create: (config: unknown) => { started.push(config); } },
    teamViewProvider: { refresh: () => undefined },
    registerReferencedMcpServers: () => undefined,
  };
  return { state, errors, started };
}

/** The page's sends reach the host; the host's acknowledgements are held back until delivered. */
function holdAcknowledgements(fake: FakePanel, live: ReturnType<typeof page>) {
  const held: any[] = [];
  fake.panel.webview.postMessage.mockImplementation(async (message: any) => {
    if (message.command === 'sendAccepted') held.push(message);
    else (live.boot.listeners.message ?? []).forEach((listener) => listener({ data: message }));
    return true;
  });
  return { held, deliver: (index = 0) => (live.boot.listeners.message ?? []).forEach((listener) => listener({ data: held[index] })) };
}

describe('the draft copy after Codex\'s re-audit of 3f83edc (v0.9.96)', () => {
  it('RR1: restoreRoster reports a refused route as not loaded, and a loaded roster, also an empty one, as loaded', async () => {
    const refused = rosterLoaderState([unrunnableDev]);
    await expect(loadRestoreRoster(refused.state)()).resolves.toBe(false);
    expect(refused.errors).toHaveLength(1);
    expect(refused.errors[0]).toMatch(/^UnodeAi did not start this roster\./);
    expect(refused.started).toEqual([]);

    const empty = rosterLoaderState([]);
    await expect(loadRestoreRoster(empty.state)()).resolves.toBe(true);
    expect(empty.errors).toEqual([]);

    const runnable = { ...unrunnableDev, provider: { providerId: 'unode', apiKeySecretName: '' } };
    const loaded = rosterLoaderState([runnable], (config) => ({ config, changed: false }));
    await expect(loadRestoreRoster(loaded.state)()).resolves.toBe(true);
    expect(loaded.started).toEqual([runnable]);
  });

  it('RR1: activation opens the draft gate only for a roster that loaded, and keeps it closed after a refusal or a failure', async () => {
    const outcomes: Array<[string, () => Promise<boolean>, string[]]> = [
      ['loaded', async () => true, ['rosterLoaded']],
      ['refused', async () => false, ['rosterNotLoaded']],
    ];
    for (const [name, restoreRoster, expected] of outcomes) {
      const calls: string[] = [];
      const chatViewProvider = { rosterLoaded: () => calls.push('rosterLoaded'), rosterNotLoaded: () => calls.push('rosterNotLoaded') };
      await loadRosterGate({ restoreRoster, chatViewProvider })();
      expect(calls, name).toEqual(expected);
    }
    const calls: string[] = [];
    const failure = new Error('the stored roster could not be read');
    const chatViewProvider = { rosterLoaded: () => calls.push('rosterLoaded'), rosterNotLoaded: () => calls.push('rosterNotLoaded') };
    await expect(loadRosterGate({ restoreRoster: async () => { throw failure; }, chatViewProvider })()).rejects.toBe(failure);
    expect(calls).toEqual(['rosterNotLoaded']);
  });

  it('RR1: a refused roster keeps the restored page\'s drafts and the saved copy, keeps recovery off, and a later start loads them', async () => {
    const backing = storeFor();
    const before = chat({ backing });
    before.provider.selectAgent(dev.id);
    const live = page(openWorkbench(before.provider));
    await live.settle();
    live.type('kept through a refused route');
    await vi.advanceTimersByTimeAsync(750);
    await live.settle();
    const saved = structuredClone(live.boot.savedStates.at(-1));
    await before.mirror.flush();
    const incarnations = backing.incarnations();
    expect(incarnations).toEqual(expect.arrayContaining(['pm', 'dev']));

    // The next start refuses the stored route: the real loader and the real lines after it in activate().
    const after = chat({ backing, waitForRoster: true, agents: [] });
    const fake = fakePanel(1);
    after.provider.restoreWorkbench(fake.panel, saved);
    const restored = page(fake, saved);
    await restored.settle();
    const refused = rosterLoaderState([unrunnableDev]);
    await loadRosterGate({ restoreRoster: loadRestoreRoster(refused.state), chatViewProvider: after.provider })();
    await restored.settle();
    await after.mirror.flush();
    expect(refused.errors).toHaveLength(1);
    expect(after.provider.isRosterLoaded()).toBe(false);
    expect((after.provider as any).currentState()).toMatchObject({ rosterReady: false, rosterFailed: true });
    expect(backing.copy().dev.text).toBe('kept through a refused route');
    expect(backing.incarnations()).toEqual(incarnations);
    expect((restored.boot.savedStates.at(-1) as any).draftsByAgent.dev.text).toBe('kept through a refused route');

    // An agent created meanwhile opens nothing: its draft is not copied, and the page says so.
    const qa: ChatAgent = { id: 'qa', name: 'QA', role: 'Reviewer', backend: 'openai' };
    after.setAgents([qa]);
    after.provider.rosterLoaded();
    expect(after.provider.isRosterLoaded()).toBe(false);
    after.provider.selectAgent(qa.id);
    await restored.settle();
    restored.type('typed for the new agent');
    await vi.advanceTimersByTimeAsync(750);
    await restored.settle();
    await after.mirror.flush();
    expect(restored.posted('draftEdit').map((edit) => edit.agentId)).toEqual(['qa']);
    expect(backing.copy()).not.toHaveProperty('qa');
    expect(restored.status()).toBe('UnodeAi did not load the team, so no copy of this draft is being saved. Only this tab holds its current text.');
    expect((restored.boot.savedStates.at(-1) as any).draftsByAgent.dev.text).toBe('kept through a refused route');

    // A later start whose roster loads takes the draft back as usual.
    const later = chat({ backing, waitForRoster: true, agents: [] });
    const again = fakePanel(1);
    const savedAgain = structuredClone(restored.boot.savedStates.at(-1));
    later.provider.restoreWorkbench(again.panel, savedAgain);
    const reloaded = page(again, savedAgain);
    await reloaded.settle();
    later.setAgents([pm, dev]);
    later.provider.rosterLoaded();
    later.provider.selectAgent(dev.id);
    await reloaded.settle();
    await later.mirror.flush();
    expect(later.provider.isRosterLoaded()).toBe(true);
    expect(reloaded.input.value).toBe('kept through a refused route');
    expect(backing.copy().dev.text).toBe('kept through a refused route');
  });

  it('RR2: text typed after Send survives an acknowledgement that comes before the timeout, with its saved copy', async () => {
    const backing = storeFor();
    const { provider, mirror } = chat({ backing });
    provider.selectAgent(dev.id);
    const fake = openWorkbench(provider);
    const live = page(fake);
    await live.settle();
    live.type('first message');
    const acks = holdAcknowledgements(fake, live);
    live.send();
    live.pump();
    expect(acks.held).toHaveLength(1);
    expect(live.input.disabled).toBe(false);
    live.type('second message, never sent');
    await vi.advanceTimersByTimeAsync(750);
    await live.settle();
    expect(backing.copy().dev.text).toBe('second message, never sent');
    acks.deliver();
    await vi.advanceTimersByTimeAsync(0);
    await live.settle();
    await mirror.flush();
    expect(live.input.value).toBe('second message, never sent');
    expect(backing.copy().dev.text).toBe('second message, never sent');
    const saved = live.boot.savedStates.at(-1) as { draftsByAgent: Record<string, { text: string; basis: number }> };
    expect(saved.draftsByAgent.dev.text).toBe('second message, never sent');
    expect(saved.draftsByAgent.dev.basis).toBeGreaterThanOrEqual(acks.held[0].draftSeq);
    const { reloaded } = await reload(backing, structuredClone(saved));
    expect(reloaded.input.value).toBe('second message, never sent');
  });

  it('RR2: on either side of the timeout, unchanged text is cleared and edited-then-restored text is kept', async () => {
    for (const wait of [9_999, 10_000]) {
      for (const edited of [false, true]) {
        const label = `${wait} ms, ${edited ? 'edited then restored' : 'unchanged'}`;
        created.length = 0;
        const backing = storeFor();
        const { provider, mirror } = chat({ backing });
        provider.selectAgent(dev.id);
        const fake = openWorkbench(provider);
        const live = page(fake);
        await live.settle();
        live.type('the message');
        await vi.advanceTimersByTimeAsync(750);
        await live.settle();
        const acks = holdAcknowledgements(fake, live);
        live.send();
        live.pump();
        if (edited) {
          live.type('the message, changed');
          live.type('the message');
        }
        await vi.advanceTimersByTimeAsync(wait);
        await live.settle();
        acks.deliver();
        await vi.advanceTimersByTimeAsync(0);
        await live.settle();
        await mirror.flush();
        expect(live.input.value, label).toBe(edited ? 'the message' : '');
        expect(backing.copy().dev?.text, label).toBe(edited ? 'the message' : undefined);
        expect(live.status(), label).toBe('');
      }
    }
  });

  it('RR2: an acknowledgement before the timeout clears only the sent agent\'s draft while another agent is shown', async () => {
    const backing = storeFor();
    const { provider, mirror } = chat({ backing });
    provider.selectAgent(pm.id);
    const fake = openWorkbench(provider);
    const live = page(fake);
    await live.settle();
    live.type('pm text, not sent');
    provider.selectAgent(dev.id);
    live.type('for dev');
    const acks = holdAcknowledgements(fake, live);
    live.send();
    live.pump();
    provider.selectAgent(pm.id);
    expect(live.input.value).toBe('pm text, not sent');
    live.type('pm text, still not sent');
    acks.deliver();
    await vi.advanceTimersByTimeAsync(750);
    await live.settle();
    await mirror.flush();
    expect(live.input.value).toBe('pm text, still not sent');
    const saved = live.boot.savedStates.at(-1) as { draftsByAgent: Record<string, { text: string }> };
    expect(saved.draftsByAgent).not.toHaveProperty('dev');
    expect(saved.draftsByAgent.pm.text).toBe('pm text, still not sent');
    expect(backing.copy()).not.toHaveProperty('dev');
    expect(backing.copy().pm.text).toBe('pm text, still not sent');
  });
});
