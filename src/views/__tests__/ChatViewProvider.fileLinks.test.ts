import { rmSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/*---------------------------------------------------------------------------------------------
 *  v0.9.97 FOPEN — a reply's link to a workspace file opens in the editor, through the real wiring:
 *
 *    host Markdown → `liveBlocks` / `state` posted to the webview → the production block renderer builds the link →
 *    a mouse click or Enter runs the production page's `requestFileLinkOpen` → the posted message enters the real
 *    sidebar or Workbench listener → ChatViewProvider finds the reply and the link again → the production navigation
 *    boundary checks the agent's read folders and the file on disk → a recorded editor opens it.
 *
 *  USAGE "File links in a reply" is the contract. Each test names the sentence it realises.
 *--------------------------------------------------------------------------------------------*/

const vscodeState = vi.hoisted(() => ({ panels: [] as Array<Record<string, any>> }));

vi.mock('vscode', () => ({
  ViewColumn: { Active: -1, One: 1 },
  commands: { executeCommand: vi.fn() },
  window: {
    createWebviewPanel: vi.fn(() => {
      const panel: Record<string, any> = {
        visible: true,
        viewColumn: 1,
        reveal: vi.fn(),
        dispose: vi.fn(),
        onDidDispose: vi.fn(() => ({ dispose: () => {} })),
        onDidChangeViewState: vi.fn(() => ({ dispose: () => {} })),
        webview: {
          cspSource: 'test:',
          options: {},
          html: '',
          postMessage: vi.fn(),
          onDidReceiveMessage: vi.fn((listener: (message: unknown) => void) => {
            panel.fire = listener;
            return { dispose: () => {} };
          }),
        },
      };
      vscodeState.panels.push(panel);
      return panel;
    }),
  },
}));

import { ChatAgent, ChatReply, ChatViewDeps, ChatViewProvider } from '../ChatViewProvider';
import { fileReferenceId } from '../fileLinks';
import { descendants, FakeElement, liveBlocksPage } from './support/liveBlocksDom';
import { agentConfig, navigationHost, settle, tempFolder, type NavigationHost } from './support/fileNavigationHost';
import { evaluateWiring, extensionWiring } from './support/extensionWiring';
import type { TaskWorkspaceAccess } from '../../types';

// These flow tests run real persistence, sessions, backends and commands, taking about 0.5-3 s each here and
// several times that on CI. The warm mutation worker keeps Vitest's 5 s default, so the suite's own 30 s budget
// (vitest.config.ts) is set here; CI 42814839194 judged two proofs invalid when a rerun ran past 5 s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const FIELD_FILE = 'PolyFlow_Compliance_Working_Draft_Merged.md';
const dev: ChatAgent = { id: 'agent-1', name: 'Dev', role: 'Developer', backend: 'openai' };
const qa: ChatAgent = { id: 'agent-2', name: 'QA', role: 'Reviewer', backend: 'openai' };

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vscodeState.panels.splice(0);
});

function folder(files: Record<string, string>): string {
  const made = tempFolder(files);
  cleanups.push(made.cleanup);
  return made.root;
}

interface Chat {
  provider: ChatViewProvider;
  deps: ChatViewDeps;
  reply(agentId: string, text: string): void;
  sidebar: { fire(message: unknown): void; posted(): any[] };
  workbench: { fire(message: unknown): void; posted(): any[] };
  /** v0.9.102: every file link result the host posted, the sidebar's first, then the Workbench's. */
  results(): any[];
}

/** One chat host over the real navigation boundary. `cwd` is what the host reports as each agent's folder now. */
function chat(host: NavigationHost, agents: ChatAgent[] = [dev], store = new Map<string, unknown>(), cwd: Record<string, string> = {}): Chat {
  let deliver: ((reply: ChatReply) => void) | undefined;
  const deps = {
    listAgents: () => agents,
    send: vi.fn(),
    interject: vi.fn(),
    interrupt: vi.fn(),
    onReply: (callback: (reply: ChatReply) => void) => { deliver = callback; return () => {}; },
    state: {
      get: <T,>(key: string) => store.get(key) as T | undefined,
      update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
    },
    getApprovals: () => ({ command: 'ask', write: 'none' }),
    setApproval: vi.fn(),
    getCheckpoints: () => [],
    // The production wiring of extension.ts, run over the test host: each is the extension's own property, transpiled.
    ...Object.fromEntries(['openWorkspaceFile', 'openFileReference', 'fileNavigationRefused'].map((name) => [name,
      evaluateWiring(extensionWiring('ChatViewProvider', 1, name), { orchestrationHost: host.adapter })])),
    fileLinkRoots: (agentId) => host.adapter.fileLinkRoots(agentId, cwd[agentId]),
    fileLinkCeilings: (agentId) => host.adapter.fileLinkCeilings(agentId),
  } as ChatViewDeps;
  const provider = new ChatViewProvider({} as never, deps);
  provider.selectAgent(agents[0].id);
  let sidebarListener: ((message: unknown) => void) | undefined;
  const sidebarView = {
    visible: true,
    webview: {
      cspSource: 'test:', html: '', options: {}, postMessage: vi.fn(),
      onDidReceiveMessage: vi.fn((listener: (message: unknown) => void) => { sidebarListener = listener; return { dispose: () => {} }; }),
    },
    onDidChangeVisibility: vi.fn(() => ({ dispose: () => {} })),
    onDidDispose: vi.fn(() => ({ dispose: () => {} })),
  };
  provider.resolveWebviewView(sidebarView as never);
  provider.openWorkbench(false);
  const panel = vscodeState.panels.at(-1)!;
  return {
    provider,
    deps,
    reply: (agentId, text) => deliver?.({ from: agentId, fromName: agentId, text, isError: false }),
    sidebar: { fire: (message) => sidebarListener?.(message), posted: () => sidebarView.webview.postMessage.mock.calls.map(([m]) => m) },
    workbench: { fire: (message) => panel.fire(message), posted: () => panel.webview.postMessage.mock.calls.map(([m]: [unknown]) => m) },
    results: () => [...sidebarView.webview.postMessage.mock.calls.map(([m]) => m),
      ...panel.webview.postMessage.mock.calls.map(([m]: [unknown]) => m)].filter((m: any) => m?.command === 'fileLinkResult'),
  };
}

/** The chat page's own `requestFileLinkOpen`, cut from the HTML the provider serves. */
function pageFunction(provider: ChatViewProvider, name: string): string {
  const html = (provider as any).getHtml({ cspSource: 'test:' }, 'sidebar') as string;
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`the chat page must define ${name}`);
  let depth = 0;
  for (let index = html.indexOf('{', start); index < html.length; index++) {
    if (html[index] === '{') depth++;
    if (html[index] === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`unclosed ${name}`);
}

/** The production renderer and click path of a chat page showing `selectedAgentId`, with what it posts. */
function page(provider: ChatViewProvider, selectedAgentId: string) {
  const posted: unknown[] = [];
  const copied: string[] = [];
  const blocks = liveBlocksPage(`${pageFunction(provider, 'requestFileLinkOpen')}\n${pageFunction(provider, 'requestFileLinkReveal')}`, {
    state: { selectedAgentId },
    vscode: { postMessage: (message: unknown) => posted.push(message) },
    navigator: { clipboard: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } } },
  });
  return { posted, copied, ...blocks };
}

const fileLinks = (root: FakeElement) => descendants(root).filter((element) => element.className === 'md-file-link');

/** The blocks of the newest state's agent message whose text includes `text`. */
function stateBlocks(posted: any[], text: string): unknown[] {
  const state = [...posted].reverse().find((message) => message?.command === 'state')?.state;
  const message = (state?.messages ?? []).find((item: any) => item.kind === 'message' && item.role === 'agent' && String(item.text).includes(text));
  if (!message) throw new Error(`no agent message holding ${text} in the newest state`);
  return message.blocks;
}

describe('a reply file link opens through the real host, webview and host wiring', () => {
  it('opens the field file from the streamed reply, the completed one, a full re-render and after a reload, on both surfaces', async () => {
    const ws = folder({ [FIELD_FILE]: '# Draft' });
    const host = navigationHost([ws], [agentConfig(dev.id)]);
    const store = new Map<string, unknown>();
    const first = chat(host, [dev], store, { [dev.id]: ws });
    const opened = path.join(ws, FIELD_FILE);

    // Streaming: the live frame the host sends, rendered by the production renderer, clicked with the mouse.
    first.provider.appendDelta(dev.id, `Saved to [the merged draft](${FIELD_FILE}).\n\n`);
    (first.provider as any).flushLiveMarkdownFrame(dev.id, 'message', true);
    const frame = [...first.sidebar.posted()].reverse().find((message) => message?.command === 'liveBlocks');
    const live = page(first.provider, dev.id);
    const liveRoot = new FakeElement('div');
    live.replaceLiveBlocks(liveRoot, 0, frame.blocks);
    const [liveLink] = fileLinks(liveRoot);
    expect(liveLink.textContent).toBe('the merged draft');
    expect(liveLink.tabIndex).toBe(0);
    expect(liveLink.getAttribute('role')).toBe('link');
    expect(liveLink.href).toBe('');
    expect(liveLink.dispatch('click').defaultPrevented).toBe(true);
    expect(live.posted).toEqual([{ command: 'openFileReference', agentId: dev.id, referenceId: liveLink.dataset.fileRef }]);
    first.sidebar.fire(live.posted[0]);
    await settle();
    expect(host.opened).toEqual([{ path: opened }]);

    // Complete: the reply is kept; its state rendering carries the same id, and Enter opens it from the Workbench.
    first.reply(dev.id, `Saved to [the merged draft](${FIELD_FILE}).`);
    const done = page(first.provider, dev.id);
    const doneRoot = done.renderBlocks(stateBlocks(first.workbench.posted(), FIELD_FILE));
    const [doneLink] = fileLinks(doneRoot);
    expect(doneLink.dataset.fileRef).toBe(liveLink.dataset.fileRef);
    expect(doneLink.dispatch('keydown', { key: 'a' }).defaultPrevented).toBe(false);
    expect(done.posted).toEqual([]);
    expect(doneLink.dispatch('keydown', { key: 'Enter' }).defaultPrevented).toBe(true);
    first.workbench.fire(done.posted[0]);
    await settle();

    // A full re-render of the page.
    first.provider.refresh();
    const again = page(first.provider, dev.id);
    fileLinks(again.renderBlocks(stateBlocks(first.sidebar.posted(), FIELD_FILE)))[0].dispatch('click');
    first.sidebar.fire(again.posted[0]);
    await settle();

    // Reload: a new host over the same stored conversation rebuilds the same id from the kept reply.
    const reloaded = chat(host, [dev], store, { [dev.id]: ws });
    reloaded.provider.refresh();
    const after = page(reloaded.provider, dev.id);
    const [afterLink] = fileLinks(after.renderBlocks(stateBlocks(reloaded.workbench.posted(), FIELD_FILE)));
    expect(afterLink.dataset.fileRef).toBe(liveLink.dataset.fileRef);
    afterLink.dispatch('click');
    reloaded.workbench.fire(after.posted[0]);
    await settle();

    expect(host.opened).toEqual([{ path: opened }, { path: opened }, { path: opened }, { path: opened }]);
    expect(host.notices).toEqual([]);
  });

  it('never sends the folders a reply recorded to the webview', () => {
    const ws = folder({ 'a.md': 'a' });
    const host = navigationHost([ws], [agentConfig(dev.id)]);
    const view = chat(host, [dev], new Map(), { [dev.id]: ws });
    view.provider.appendDelta(dev.id, '[a](a.md)');
    view.provider.refresh();
    view.reply(dev.id, '[a](a.md)');
    const sent = JSON.stringify([...view.sidebar.posted(), ...view.workbench.posted()]);
    expect(sent).not.toContain('fileLinkRoots');
    expect(sent).not.toContain(JSON.stringify(ws).slice(1, -1));
  });

  it('keeps the recorded folders and the read ceiling out of an exported chat, and drops them from an imported one', async () => {
    const ws = folder({ 'a.md': 'a' });
    const host = navigationHost([ws], [agentConfig(dev.id)]);
    const store = new Map<string, unknown>();
    const view = chat(host, [dev], store, { [dev.id]: ws });
    view.reply(dev.id, '[a](a.md)');
    // Both the relative-link folders and the FOPEN-N1 message-time read ceiling are recorded, host-only.
    expect(JSON.stringify(store.get(`roam.chat.${dev.id}`))).toContain('fileLinkRoots');
    expect(JSON.stringify(store.get(`roam.chat.${dev.id}`))).toContain('fileLinkCeilings');

    const exported = view.provider.exportSelected()!;
    expect(JSON.stringify(exported)).not.toContain('fileLinkRoots');
    expect(JSON.stringify(exported)).not.toContain('fileLinkCeilings');
    const elsewhere = folder({});
    view.provider.importToSelected([{ role: 'agent', text: '[a](a.md)', ts: new Date().toISOString(), seq: 3, fileLinkRoots: [elsewhere], fileLinkCeilings: [ws] }]);
    expect(JSON.stringify(store.get(`roam.chat.${dev.id}`))).not.toContain('fileLinkRoots');
    expect(JSON.stringify(store.get(`roam.chat.${dev.id}`))).not.toContain('fileLinkCeilings');

    // FOPEN-N1: an imported reply's historical scope is dropped, so it has no provable message-time authority and
    // its link opens nothing (fail closed) even though the file is inside the current workspace.
    const shown = page(view.provider, dev.id);
    fileLinks(shown.renderBlocks(stateBlocks(view.sidebar.posted(), '[a]')))[0].dispatch('click');
    view.sidebar.fire(shown.posted[0]);
    await settle();
    expect(host.opened).toEqual([]);
    expect(view.results().at(-1)?.message).toContain('when it wrote this reply');
    expect(host.notices).toEqual([]);
  });

  it('keeps Full access message scope host-only through the real history store and drops a forged imported marker', async () => {
    const ws = folder({});
    const outside = folder({ 'report.md': 'outside' });
    const reference = path.join(outside, 'report.md').split(path.sep).join('/');
    const host = navigationHost([ws], [agentConfig(dev.id)], { fullFileAccess: () => true });
    const store = new Map<string, unknown>([
      ['roam.chat.irrelevant', [{ role: 'agent', text: 'newer irrelevant message', seq: 99 }]],
      ['roam.messages', ['newest unrelated']], ['roam.runs', []],
    ]);
    const first = chat(host, [dev], store, { [dev.id]: ws });
    first.reply(dev.id, `[outside report](${reference})`);
    const saved = store.get(`roam.chat.${dev.id}`) as Array<{ fileLinkCeilings?: string[] }>;
    const marker = saved.at(-1)?.fileLinkCeilings?.find((ceiling) => ceiling.startsWith('\0'));
    expect(marker).toBeDefined();
    expect(JSON.stringify(first.provider.exportSelected())).not.toContain('fileLinkCeilings');
    expect(JSON.stringify([...first.sidebar.posted(), ...first.workbench.posted()])).not.toContain('unode-full-file-access');

    const reloaded = chat(host, [dev], store, { [dev.id]: ws });
    reloaded.provider.refresh();
    const before = page(reloaded.provider, dev.id);
    fileLinks(before.renderBlocks(stateBlocks(reloaded.sidebar.posted(), 'outside report')))[0].dispatch('click');
    reloaded.sidebar.fire(before.posted[0]);
    await settle();
    expect(host.opened).toEqual([{ path: path.join(outside, 'report.md') }]);

    reloaded.provider.importToSelected([{ role: 'agent', text: `[imported report](${reference})`, ts: new Date().toISOString(),
      seq: 8, fileLinkRoots: [ws], fileLinkCeilings: [marker!] }]);
    expect(JSON.stringify(store.get(`roam.chat.${dev.id}`))).not.toContain('fileLinkCeilings');
    const imported = page(reloaded.provider, dev.id);
    fileLinks(imported.renderBlocks(stateBlocks(reloaded.sidebar.posted(), 'imported report')))[0].dispatch('click');
    reloaded.sidebar.fire(imported.posted[0]);
    await settle();
    expect(host.opened).toHaveLength(1);
    expect(reloaded.results().at(-1)?.message).toContain('when it wrote this reply');
  });

  it('keeps an actual outside task file exact across history reload and task end while dropping an imported exact-file marker', async () => {
    const ws = folder({});
    const outside = folder({ 'allowed.md': 'task file', 'sibling.md': 'not admitted' });
    const target = path.join(outside, 'allowed.md');
    const sibling = path.join(outside, 'sibling.md');
    const written = (file: string) => file.split(path.sep).join('/');
    const config = agentConfig(dev.id);
    let active = true;
    let task: TaskWorkspaceAccess | undefined;
    const host = navigationHost([ws], [config], { fullFileAccess: () => true,
      taskScopeActive: () => active, taskWorkspaceAccess: () => task });
    task = host.adapter.resolveTaskWorkspaceAccess(config, { folderAccess: [{ path: target, permission: 'read' }] }).access;
    expect(task).toBeDefined();
    const store = new Map<string, unknown>([['roam.chat.irrelevant', ['newer unrelated']], ['roam.runs', []], ['roam.messages', []]]);
    const first = chat(host, [dev], store, { [dev.id]: ws });
    first.reply(dev.id, `[task file](${written(target)}) and [sibling](${written(sibling)})`);
    const saved = store.get(`roam.chat.${dev.id}`) as Array<{ fileLinkCeilings?: string[] }>;
    const ceilings = saved.at(-1)?.fileLinkCeilings!;
    expect(ceilings).toHaveLength(1);
    expect(ceilings[0]).toMatch(/^\0unode-exact-file/);
    expect(JSON.stringify([...first.sidebar.posted(), ...first.workbench.posted()])).not.toContain('unode-exact-file');
    active = false;
    const reloaded = chat(host, [dev], store, { [dev.id]: ws });
    reloaded.provider.refresh();
    const shown = page(reloaded.provider, dev.id);
    for (const item of fileLinks(shown.renderBlocks(stateBlocks(reloaded.sidebar.posted(), 'task file')))) item.dispatch('click');
    for (const request of shown.posted) reloaded.sidebar.fire(request);
    await settle();
    expect(host.opened).toEqual([{ path: target }]);
    expect(reloaded.results().at(-1)?.message).toContain('when it wrote this reply');

    reloaded.provider.importToSelected([{ role: 'agent', text: `[imported task](${written(target)})`,
      ts: new Date().toISOString(), seq: 10, fileLinkCeilings: ceilings, fileLinkRoots: [outside] }]);
    expect(JSON.stringify(store.get(`roam.chat.${dev.id}`))).not.toContain('fileLinkCeilings');
    const imported = page(reloaded.provider, dev.id);
    fileLinks(imported.renderBlocks(stateBlocks(reloaded.sidebar.posted(), 'imported task')))[0].dispatch('click');
    reloaded.sidebar.fire(imported.posted[0]);
    await settle();
    expect(host.opened).toEqual([{ path: target }]);
  });

  it('reads an old reply against the folder recorded when it was written, after the agent moved to another one', async () => {
    const before = folder({ 'docs/plan.md': 'old plan' });
    const after = folder({ 'docs/plan.md': 'new plan' });
    const config = agentConfig(dev.id, { workingDirectory: before });
    const host = navigationHost([before, after], [config]);
    const cwd = { [dev.id]: before };
    const view = chat(host, [dev], new Map(), cwd);

    view.reply(dev.id, 'Old: [plan](docs/plan.md)');
    host.configs.set(dev.id, { ...config, workingDirectory: after });
    cwd[dev.id] = after;
    view.reply(dev.id, 'New: [plan](docs/plan.md)');

    for (const text of ['Old:', 'New:']) {
      const shown = page(view.provider, dev.id);
      fileLinks(shown.renderBlocks(stateBlocks(view.sidebar.posted(), text)))[0].dispatch('click');
      view.sidebar.fire(shown.posted[0]);
      await settle();
    }
    expect(host.opened).toEqual([{ path: path.join(before, 'docs', 'plan.md') }, { path: path.join(after, 'docs', 'plan.md') }]);
    expect(host.pick).not.toHaveBeenCalled();
  });

  it('FOPEN-N1: after a reload and a later widening, an old reply does not open a link outside its message-time scope', async () => {
    const ws = folder({ 'docs/note.md': 'in scope', 'private/secret.md': 'out of scope at write time' });
    const docsOnly = agentConfig(dev.id, { folderAccess: [{ path: path.join(ws, 'docs'), permission: 'read' }] });
    const host = navigationHost([ws], [docsOnly]);
    const store = new Map<string, unknown>();
    const view = chat(host, [dev], store, { [dev.id]: ws });
    // Written while the agent may read only docs; it links by absolute path to a file in a sibling folder.
    view.reply(dev.id, `See [secret](${path.join(ws, 'private', 'secret.md')})`);

    // Reload over the same stored conversation (the message-time ceiling is restored from history), then widen the
    // agent to the whole workspace. The old reply must not gain the new scope.
    const reloaded = chat(host, [dev], store, { [dev.id]: ws });
    reloaded.provider.refresh();
    host.configs.set(dev.id, agentConfig(dev.id));

    const shown = page(reloaded.provider, dev.id);
    fileLinks(shown.renderBlocks(stateBlocks(reloaded.sidebar.posted(), 'See')))[0].dispatch('click');
    reloaded.sidebar.fire(shown.posted[0]);
    await settle();

    expect(host.opened).toEqual([]);
    expect(reloaded.results().at(-1)?.message).toContain('when it wrote this reply');
  });

  it('asks the user which folder in a multi-root workspace, never guessing by a file of the same name', async () => {
    const first = folder({ 'docs/same.md': 'first' });
    const second = folder({ 'docs/same.md': 'second' });
    const host = navigationHost([first, second], [agentConfig(dev.id)]);
    const view = chat(host, [dev], new Map(), { [dev.id]: first });
    view.reply(dev.id, 'See [same](docs/same.md)');
    host.pick.mockResolvedValueOnce(second);

    const shown = page(view.provider, dev.id);
    fileLinks(shown.renderBlocks(stateBlocks(view.sidebar.posted(), 'See')))[0].dispatch('click');
    view.sidebar.fire(shown.posted[0]);
    await settle();

    expect(host.pick).toHaveBeenCalledWith([first, second], 'docs/same.md');
    expect(host.opened).toEqual([{ path: path.join(second, 'docs', 'same.md') }]);
  });

  it('opens nothing when the conversation changes while the user chooses a folder', async () => {
    const first = folder({ 'docs/same.md': 'first' });
    const second = folder({ 'docs/same.md': 'second' });
    const host = navigationHost([first, second], [agentConfig(dev.id), agentConfig(qa.id)]);
    const view = chat(host, [dev, qa], new Map(), { [dev.id]: first });
    view.reply(dev.id, 'See [same](docs/same.md)');
    host.pick.mockImplementationOnce(async () => { view.provider.selectAgent(qa.id); return second; });

    const shown = page(view.provider, dev.id);
    fileLinks(shown.renderBlocks(stateBlocks(view.sidebar.posted(), 'See')))[0].dispatch('click');
    view.sidebar.fire(shown.posted[0]);
    await settle();

    expect(host.pick).toHaveBeenCalledTimes(1);
    expect(host.opened).toEqual([]);
    expect(host.notices.map((notice) => notice.message)).toEqual([
      'The conversation shown changed before the file could open, so nothing was opened. Click the link again.',
    ]);
  });

  it('refuses a forged id, another conversation\'s link and a cleared reply, each beside the link on its surface, and opens nothing', async () => {
    const ws = folder({ 'a.md': 'a', 'b.md': 'b' });
    const host = navigationHost([ws], [agentConfig(dev.id), agentConfig(qa.id)]);
    const view = chat(host, [dev, qa], new Map(), { [dev.id]: ws, [qa.id]: ws });
    view.reply(dev.id, 'Dev: [a](a.md)');
    view.reply(qa.id, 'QA: [b](b.md)');
    const devShown = page(view.provider, dev.id);
    const devRef = fileLinks(devShown.renderBlocks(stateBlocks(view.sidebar.posted(), 'Dev:')))[0].dataset.fileRef;

    // A well-formed id no reply of this conversation holds.
    view.sidebar.fire({ command: 'openFileReference', agentId: dev.id, referenceId: fileReferenceId(0, 'b.md') });
    view.sidebar.fire({ command: 'openFileReference', agentId: dev.id, referenceId: '999.0123456789abcdef' });
    // The other agent's real link, while this conversation is shown.
    view.provider.selectAgent(qa.id);
    const qaShown = page(view.provider, qa.id);
    view.provider.refresh();
    fileLinks(qaShown.renderBlocks(stateBlocks(view.sidebar.posted(), 'QA:')))[0].dispatch('click');
    view.provider.selectAgent(dev.id);
    view.sidebar.fire(qaShown.posted[0]);
    // A link of a cleared conversation.
    view.provider.clearSelectedAgent();
    view.workbench.fire({ command: 'openFileReference', agentId: dev.id, referenceId: devRef });
    await settle();

    expect(host.opened).toEqual([]);
    // No link the host could find, so no path to copy. The cleared reply's click came from the Workbench.
    expect(view.results().map(({ message, path: copy }) => ({ message, ...(copy ? { copy } : {}) }))).toEqual([
      { message: 'This file link is no longer in the conversation UnodeAi keeps, so nothing was opened. Ask the agent for the file again.' },
      { message: 'This file link is no longer in the conversation UnodeAi keeps, so nothing was opened. Ask the agent for the file again.' },
      { message: 'That link is in a conversation this chat does not show now. Open that agent\'s conversation and click it there.' },
      { message: 'This file link is no longer in the conversation UnodeAi keeps, so nothing was opened. Ask the agent for the file again.' },
    ]);
    expect(view.workbench.posted().filter((m) => m?.command === 'fileLinkResult')).toEqual([
      { command: 'fileLinkResult', agentId: dev.id, referenceId: devRef, message: 'This file link is no longer in the conversation UnodeAi keeps, so nothing was opened. Ask the agent for the file again.' },
    ]);
    expect(host.notices).toEqual([]);
    // A refusal sends nothing to a model and writes nothing.
    expect(view.deps.send).not.toHaveBeenCalled();
    expect(view.deps.interject).not.toHaveBeenCalled();
  });

  it('accepts no path, folder, URI or command from the webview: such a message never reaches a handler', async () => {
    const ws = folder({ 'a.md': 'a' });
    const host = navigationHost([ws], [agentConfig(dev.id)]);
    const view = chat(host, [dev], new Map(), { [dev.id]: ws });
    view.reply(dev.id, '[a](a.md)');
    const ref = fileReferenceId(0, 'a.md');
    for (const message of [
      { command: 'openFileReference', agentId: dev.id, referenceId: path.join(ws, 'a.md') },
      { command: 'openFileReference', agentId: dev.id, referenceId: 'a.md' },
      { command: 'openFileReference', agentId: dev.id, referenceId: ref, path: path.join(ws, 'a.md') },
      { command: 'openFileReference', agentId: dev.id, referenceId: ref, root: ws },
      { command: 'openFileReference', agentId: dev.id, referenceId: ref, uri: 'file:///a.md' },
      { command: 'openFileReference', agentId: dev.id, referenceId: ref, target: 'command:x' },
      { command: 'openFile', agentId: dev.id, path: path.join(ws, 'a.md') },
    ]) {
      view.sidebar.fire(message);
    }
    await settle();
    expect(host.opened).toEqual([]);
    expect(host.notices).toEqual([]);
    expect(view.results()).toEqual([]);

    view.sidebar.fire({ command: 'openFileReference', agentId: dev.id, referenceId: ref });
    await settle();
    expect(host.opened).toEqual([{ path: path.join(ws, 'a.md') }]);
  });

  it('shows a deleted file, a directory and a link out of the read folders beside each link, with the link to copy, and opens nothing', async () => {
    const ws = folder({ 'gone.md': 'soon gone' });
    const outside = folder({ 'secret.md': 'outside' });
    const host = navigationHost([ws], [agentConfig(dev.id)]);
    const view = chat(host, [dev], new Map(), { [dev.id]: ws });
    view.reply(dev.id, `[gone](gone.md) [here](.) [out](${path.join(outside, 'secret.md')})`);
    rmSync(path.join(ws, 'gone.md'));

    const shown = page(view.provider, dev.id);
    for (const link of fileLinks(shown.renderBlocks(stateBlocks(view.sidebar.posted(), 'gone')))) link.dispatch('click');
    for (const message of shown.posted) view.sidebar.fire(message);
    await settle();

    expect(host.opened).toEqual([]);
    expect(host.notices).toEqual([]);
    expect(view.results().map(({ message, path: copy }) => ({ message, copy }))).toEqual([
      { message: '"gone.md" does not exist. It may have been moved, renamed or deleted.', copy: 'gone.md' },
      { message: '"." is a directory. Opening a directory from the chat is not supported yet.', copy: '.' },
      { message: `"${path.join(outside, 'secret.md')}" is outside this agent's current read folders, so UnodeAi did not open it.`, copy: path.join(outside, 'secret.md') },
    ]);
    expect(view.workbench.posted().filter((m) => m?.command === 'fileLinkResult')).toEqual([]);
  });

  it('a receipt failure is shown too, where it used to be a silent return', async () => {
    const ws = folder({ 'a.md': 'a' });
    const host = navigationHost([ws], [agentConfig(dev.id), agentConfig(qa.id)]);
    const view = chat(host, [dev, qa], new Map(), { [dev.id]: ws });
    view.sidebar.fire({ command: 'openToolFile', agentId: dev.id, toolId: 'forged-tool-id' });
    view.sidebar.fire({ command: 'openToolFile', agentId: qa.id, toolId: 'forged-tool-id' });
    await settle();
    expect(host.opened).toEqual([]);
    expect(host.notices.map((notice) => notice.message)).toEqual([
      'This receipt is no longer in the conversation UnodeAi keeps, so its file was not opened.',
      'That link is in a conversation this chat does not show now. Open that agent\'s conversation and click it there.',
    ]);
  });
});

/*
 * v0.9.102: a click on a file link that does not simply open is never only a corner notification. The reason is
 * shown beside the clicked link on the surface that was clicked, with Copy path when the host found the link, and
 * with Reveal when the file is there but opens neither in the editor nor in an app. Reveal is checked like a click.
 */
describe('what a file link click came to is shown beside the link that was clicked', () => {
  const noteOf = (link: FakeElement) => {
    const next = link.parentNode!.childNodes[link.parentNode!.childNodes.indexOf(link) + 1] as FakeElement | undefined;
    return next?.className === 'md-file-link-note' ? next : undefined;
  };
  const buttons = (note: FakeElement) => note.children.filter((child) => child.tagName === 'button');

  it('shows a missing file beside the clicked link on the clicked surface, copies the link as written, and clears on the next click', async () => {
    const ws = folder({ 'kept.md': 'kept', 'gone.md': 'soon gone' });
    const host = navigationHost([ws], [agentConfig(dev.id)]);
    const view = chat(host, [dev], new Map(), { [dev.id]: ws });
    view.reply(dev.id, 'Open [kept](kept.md) or [the report](gone.md).');
    rmSync(path.join(ws, 'gone.md'));

    const shown = page(view.provider, dev.id);
    const root = shown.renderBlocks(stateBlocks(view.workbench.posted(), 'the report'));
    const [kept, gone] = fileLinks(root);
    gone.dispatch('click');
    view.workbench.fire(shown.posted[0]);
    await settle();

    expect(host.opened).toEqual([]);
    expect(host.notices).toEqual([]);
    const [result] = view.results();
    expect(result).toEqual({ command: 'fileLinkResult', agentId: dev.id, referenceId: gone.dataset.fileRef,
      message: '"gone.md" does not exist. It may have been moved, renamed or deleted.', path: 'gone.md' });
    expect(view.sidebar.posted().filter((m) => m?.command === 'fileLinkResult')).toEqual([]);

    // The page's own handler puts it right after the clicked link, and nowhere else.
    shown.showFileLinkResult(root, result);
    const note = noteOf(gone)!;
    expect(note.getAttribute('role')).toBe('status');
    expect(note.children[0].textContent).toBe('"gone.md" does not exist. It may have been moved, renamed or deleted.');
    expect(buttons(note).map((button) => button.textContent)).toEqual(['Copy path', '\u00d7']);
    expect(noteOf(kept)).toBeUndefined();
    buttons(note)[0].dispatch('click');
    expect(shown.copied).toEqual(['gone.md']);

    // The next click on the link clears its last result before asking again; Dismiss removes a result.
    gone.dispatch('click');
    expect(noteOf(gone)).toBeUndefined();
    shown.showFileLinkResult(root, result);
    buttons(noteOf(gone)!)[1].dispatch('click');
    expect(noteOf(gone)).toBeUndefined();
  });

  it('offers Reveal for a file that opens neither in the editor nor in an app, and Reveal checks the link again', async () => {
    const ws = folder({ 'setup.bin': 'binary' });
    const host = navigationHost([ws], [agentConfig(dev.id)]);
    host.notText.value = true;
    const view = chat(host, [dev], new Map(), { [dev.id]: ws });
    view.reply(dev.id, 'Built [the installer](setup.bin).');

    const shown = page(view.provider, dev.id);
    const root = shown.renderBlocks(stateBlocks(view.sidebar.posted(), 'the installer'));
    const [installer] = fileLinks(root);
    installer.dispatch('click');
    view.sidebar.fire(shown.posted[0]);
    await settle();
    const [result] = view.results();
    expect(result).toMatchObject({ reveal: true, path: 'setup.bin' });
    expect(result.message).toContain('VS Code did not open "setup.bin" in the editor: File seems to be binary');
    shown.showFileLinkResult(root, result);
    const reveal = buttons(noteOf(installer)!).find((button) => button.textContent === 'Reveal in File Explorer')!;

    reveal.dispatch('click');
    expect(shown.posted.at(-1)).toEqual({ command: 'revealFileReference', agentId: dev.id, referenceId: installer.dataset.fileRef });
    expect(noteOf(installer)).toBeUndefined();
    view.sidebar.fire(shown.posted.at(-1));
    await settle();
    expect(host.revealed).toEqual([path.join(ws, 'setup.bin')]);

    // The file is deleted before a second Reveal: the same check finds it missing and reveals nothing.
    rmSync(path.join(ws, 'setup.bin'));
    view.sidebar.fire(shown.posted.at(-1));
    await settle();
    expect(host.revealed).toEqual([path.join(ws, 'setup.bin')]);
    expect(view.results().at(-1)?.message).toBe('"setup.bin" does not exist. It may have been moved, renamed or deleted.');
    expect(host.opened).toEqual([]);
    expect(host.notices).toEqual([]);
  });

  it('keeps the notification when the clicked surface is not known, so a result is never lost', async () => {
    const ws = folder({});
    const host = navigationHost([ws], [agentConfig(dev.id)]);
    const view = chat(host, [dev], new Map(), { [dev.id]: ws });
    view.reply(dev.id, 'See [missing](missing.md).');
    const shown = page(view.provider, dev.id);
    fileLinks(shown.renderBlocks(stateBlocks(view.sidebar.posted(), 'missing')))[0].dispatch('click');
    (view.provider as any).onMessage(shown.posted[0], undefined);
    await settle();
    expect(view.results()).toEqual([]);
    expect(host.notices).toEqual([{ message: '"missing.md" does not exist. It may have been moved, renamed or deleted.', reference: 'missing.md' }]);
  });

  // Codex's L1 audit, finding 3: the notification depends on the webview actually taking the result.
  it.each([
    ['answers false', () => Promise.resolve(false)],
    ['rejects', () => Promise.reject(new Error('webview disposed'))],
  ])('notifies once when the clicked surface\'s webview %s, and not when it takes the result', async (_label, failing) => {
    const ws = folder({});
    const host = navigationHost([ws], [agentConfig(dev.id)]);
    const view = chat(host, [dev], new Map(), { [dev.id]: ws });
    view.reply(dev.id, 'See [missing](missing.md) and [gone](gone.md).');
    const sidebar = (view.provider as any).sidebarView.webview.postMessage;
    sidebar.mockImplementation((message: any) => message?.command === 'fileLinkResult' ? failing() : Promise.resolve(true));
    const shown = page(view.provider, dev.id);
    const [missing, gone] = fileLinks(shown.renderBlocks(stateBlocks(view.sidebar.posted(), 'missing')));

    missing.dispatch('click');
    view.sidebar.fire(shown.posted.at(-1));
    await settle();
    expect(view.results()).toHaveLength(1);
    expect(host.notices).toEqual([{ message: '"missing.md" does not exist. It may have been moved, renamed or deleted.', reference: 'missing.md' }]);

    // The same surface takes the next result: it is shown there and nothing is notified.
    sidebar.mockImplementation(() => Promise.resolve(true));
    gone.dispatch('click');
    view.sidebar.fire(shown.posted.at(-1));
    await settle();
    expect(view.results()).toHaveLength(2);
    expect(host.notices).toHaveLength(1);

    // A refusal the chat host makes itself follows the same rule.
    sidebar.mockImplementation((message: any) => message?.command === 'fileLinkResult' ? failing() : Promise.resolve(true));
    view.sidebar.fire({ command: 'openFileReference', agentId: dev.id, referenceId: '999.0123456789abcdef' });
    await settle();
    expect(host.notices.at(-1)).toEqual({ message: 'This file link is no longer in the conversation UnodeAi keeps, so nothing was opened. Ask the agent for the file again.' });
    expect(host.notices).toHaveLength(2);
  });

  // Codex's L1 audit, finding 2: a reparse while the reply streams, and the finished reply replacing the live one,
  // render the link again; its result is shown again beside it.
  it('keeps a failed click\'s reason beside its link through a streaming reparse and the finished reply', async () => {
    const ws = folder({});
    const host = navigationHost([ws], [agentConfig(dev.id)]);
    const view = chat(host, [dev], new Map(), { [dev.id]: ws });
    const shown = page(view.provider, dev.id);
    const live = new FakeElement('div');
    const frame = () => {
      (view.provider as any).flushLiveMarkdownFrame(dev.id, 'message', true);
      const sent = [...view.sidebar.posted()].reverse().find((message) => message?.command === 'liveBlocks');
      shown.replaceLiveBlocks(live, sent.replaceFrom, sent.blocks);
    };

    view.provider.appendDelta(dev.id, 'Open [the report](gone.md) and *word');
    frame();
    const [first] = fileLinks(live);
    first.dispatch('click');
    view.sidebar.fire(shown.posted.at(-1));
    await settle();
    const [result] = view.results();
    shown.showFileLinkResult(live, result);
    expect(noteOf(first)?.children[0].textContent).toBe('"gone.md" does not exist. It may have been moved, renamed or deleted.');

    // The closing * makes the tail emphasis: the paragraph is parsed again and rebuilt.
    const paragraph = live.children[0];
    view.provider.appendDelta(dev.id, '*.');
    frame();
    expect(live.children[0]).not.toBe(paragraph);
    const [again] = fileLinks(live);
    expect(again).not.toBe(first);
    expect(noteOf(again)?.children[0].textContent).toBe('"gone.md" does not exist. It may have been moved, renamed or deleted.');
    expect(descendants(live).filter((element) => element.tagName === 'em').map((element) => element.textContent)).toEqual(['word']);

    // The finished reply replaces the live one.
    view.reply(dev.id, 'Open [the report](gone.md) and *word*.');
    const final = shown.renderBlocks(stateBlocks(view.sidebar.posted(), 'the report'));
    const [done] = fileLinks(final);
    expect(done.dataset.fileRef).toBe(first.dataset.fileRef);
    expect(noteOf(done)?.children[0].textContent).toBe('"gone.md" does not exist. It may have been moved, renamed or deleted.');

    // Dismissed, it is not shown again; nor after the next click, until that click's own result arrives.
    buttons(noteOf(done)!).at(-1)!.dispatch('click');
    expect(fileLinks(shown.renderBlocks(stateBlocks(view.sidebar.posted(), 'the report'))).map(noteOf)).toEqual([undefined]);
    shown.showFileLinkResult(final, result);
    done.dispatch('click');
    expect(fileLinks(shown.renderBlocks(stateBlocks(view.sidebar.posted(), 'the report'))).map(noteOf)).toEqual([undefined]);
    expect(host.notices).toEqual([]);
  });

  it('keeps a result beside its link while the paragraph around it is still being written', () => {
    const shown = liveBlocksPage('function requestFileLinkOpen() {}');
    const root = new FakeElement('div');
    const fileLink = { type: 'fileLink', text: 'draft', target: FIELD_FILE, ref: fileReferenceId(4, FIELD_FILE) };
    const paragraph = (tail: string) => ({ type: 'paragraph', spans: [{ type: 'text', text: 'See ' }, fileLink, { type: 'text', text: tail }] });
    shown.replaceLiveBlocks(root, 0, [paragraph(' now')]);
    const node = root.children[0];
    const [link] = fileLinks(root);
    link.dispatch('click');
    shown.showFileLinkResult(root, { referenceId: fileLink.ref, message: 'Not found.' });

    shown.replaceLiveBlocks(root, 0, [paragraph(' now, and more')]);
    expect(root.children[0]).toBe(node);
    expect(fileLinks(root)[0]).toBe(link);
    expect(noteOf(link)?.children[0].textContent).toBe('Not found.');
    expect(node.textContent).toBe('See draftNot found.\u00d7 now, and more');
  });
});

describe('the live renderer and a growing paragraph with links', () => {
  const paragraph = (spans: unknown[]) => ({ type: 'paragraph', spans });
  const fileLink = { type: 'fileLink', text: 'draft', target: FIELD_FILE, ref: fileReferenceId(4, FIELD_FILE) };
  const refused = { type: 'linkRefused', text: 'run', note: 'link not opened: command: links are not followed' };

  it('keeps the link nodes while the text after them grows, and rebuilds when a link changes', () => {
    const shown = liveBlocksPage('function requestFileLinkOpen() {}');
    const root = new FakeElement('div');
    shown.replaceLiveBlocks(root, 0, [paragraph([{ type: 'text', text: 'See ' }, fileLink, refused, { type: 'text', text: ' now' }])]);
    const node = root.children[0];
    const [link, note] = [node.childNodes[1], node.childNodes[2]];

    shown.replaceLiveBlocks(root, 0, [paragraph([{ type: 'text', text: 'See ' }, fileLink, refused, { type: 'text', text: ' now, then' }])]);
    expect(root.children[0]).toBe(node);
    expect(node.childNodes[1]).toBe(link);
    expect(node.childNodes[2]).toBe(note);
    expect(node.textContent).toBe('See draftrun (link not opened: command: links are not followed) now, then');

    shown.replaceLiveBlocks(root, 0, [paragraph([{ type: 'text', text: 'See ' }, { ...fileLink, ref: fileReferenceId(5, FIELD_FILE) }, refused, { type: 'text', text: ' now, then more' }])]);
    expect(root.children[0]).not.toBe(node);
    expect(fileLinks(root)[0].dataset.fileRef).toBe(fileReferenceId(5, FIELD_FILE));
  });
});

describe('links the page shows but never follows', () => {
  it('shows a reply\'s link of another kind as text with its reason, with nothing to click', () => {
    const ws = folder({});
    const host = navigationHost([ws], [agentConfig(dev.id)]);
    const view = chat(host, [dev], new Map(), { [dev.id]: ws });
    view.reply(dev.id, 'Run [this](command:workbench.action.terminal.new) or [that](javascript:alert(1)) or [web](https://example.com)');

    const shown = page(view.provider, dev.id);
    const root = shown.renderBlocks(stateBlocks(view.sidebar.posted(), 'Run'));
    const anchors = descendants(root).filter((element) => element.tagName === 'a');
    expect(anchors.map((anchor) => anchor.href)).toEqual(['https://example.com']);
    const refused = descendants(root).filter((element) => element.className === 'md-link-refused');
    expect(refused.map((element) => element.textContent)).toEqual([
      'this (link not opened: command: links are not followed)',
      'that (link not opened: javascript: links are not followed)',
    ]);
    expect(JSON.stringify(stateBlocks(view.sidebar.posted(), 'Run'))).not.toContain('workbench.action.terminal.new');
  });

  it('shows a file link in an Analysis card as text: it has no reply to be read against', () => {
    const ws = folder({ 'a.md': 'a' });
    const host = navigationHost([ws], [agentConfig(dev.id)]);
    const view = chat(host, [dev], new Map(), { [dev.id]: ws });
    view.provider.appendReasoning(dev.id, 'Look at [the file](a.md) first.');
    (view.provider as any).finalizeReasoning(dev.id);
    view.provider.refresh();
    const state = [...view.sidebar.posted()].reverse().find((message) => message?.command === 'state').state;
    const reasoning = state.messages.find((item: any) => item.kind === 'reasoning');

    const root = page(view.provider, dev.id).renderBlocks(reasoning.blocks);
    expect(fileLinks(root)).toEqual([]);
    expect(descendants(root).filter((element) => element.className === 'md-file-ref').map((element) => element.title)).toEqual(['a.md']);
  });
});
