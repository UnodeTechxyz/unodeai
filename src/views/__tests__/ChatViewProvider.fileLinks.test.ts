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
    // The production wiring of extension.ts, over the test host.
    openWorkspaceFile: (agentId: string, filePath: string) => host.adapter.openRecordedWorkspaceFile(agentId, filePath),
    openFileReference: (agentId, reference) => host.adapter.openFileReference(agentId, reference),
    fileNavigationRefused: (reason) => host.adapter.refuseFileNavigation(reason),
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
  const blocks = liveBlocksPage(pageFunction(provider, 'requestFileLinkOpen'), {
    state: { selectedAgentId },
    vscode: { postMessage: (message: unknown) => posted.push(message) },
  });
  return { posted, ...blocks };
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
    expect(host.notices.at(-1)?.message).toContain('when it wrote this reply');
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
    expect(host.notices.at(-1)?.message).toContain('when it wrote this reply');
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

  it('refuses a forged id, another conversation\'s link and a cleared reply, each with a notice and nothing opened', async () => {
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
    expect(host.notices.map((notice) => notice.message)).toEqual([
      'This file link is no longer in the conversation UnodeAi keeps, so nothing was opened. Ask the agent for the file again.',
      'This file link is no longer in the conversation UnodeAi keeps, so nothing was opened. Ask the agent for the file again.',
      'That link is in a conversation this chat does not show now. Open that agent\'s conversation and click it there.',
      'This file link is no longer in the conversation UnodeAi keeps, so nothing was opened. Ask the agent for the file again.',
    ]);
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

    view.sidebar.fire({ command: 'openFileReference', agentId: dev.id, referenceId: ref });
    await settle();
    expect(host.opened).toEqual([{ path: path.join(ws, 'a.md') }]);
  });

  it('shows a deleted file, a directory and a link out of the read folders as notices, and opens nothing', async () => {
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
    expect(host.notices).toEqual([
      { message: '"gone.md" does not exist. It may have been moved, renamed or deleted.', reference: 'gone.md' },
      { message: '"." is a directory. Opening a directory from the chat is not supported yet.', reference: '.' },
      { message: `"${path.join(outside, 'secret.md')}" is outside this agent's current read folders, so UnodeAi did not open it.`, reference: path.join(outside, 'secret.md') },
    ]);
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
