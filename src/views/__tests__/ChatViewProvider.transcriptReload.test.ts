import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ChatViewProvider, type ChatViewDeps } from '../ChatViewProvider';
import { parseChatImportPayload } from '../transcriptPort';
import { bootWebviewScript, type WebviewElement } from './support/webviewBoot';

vi.mock('vscode', () => ({}));

/**
 * v0.9.103 item 6.2: rows written before the transcript stored a sequence (`seq` is optional in every stored stream).
 * Their sequence is derived when the chat first reads them. The order the person sees must not change from one reload
 * to the next, whichever stream is written again in between.
 */
function chatOver(store: Map<string, unknown>) {
  const deps: ChatViewDeps = {
    listAgents: () => [{ id: 'pm', name: 'PM', role: 'pm', backend: 'openai', status: 'stopped' }],
    send: vi.fn(), interject: vi.fn(), interrupt: vi.fn(), onReply: () => () => {},
    state: { get: <T>(key: string) => structuredClone(store.get(key)) as T | undefined,
      update: async (key, value) => { if (value === undefined) store.delete(key); else store.set(key, structuredClone(value)); } },
    getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval: vi.fn(),
    openAgentModelSettings: vi.fn(),
  };
  const provider = new ChatViewProvider({} as never, deps);
  provider.selectAgent('pm');
  return provider;
}

const flat = (node: WebviewElement): string => [node?.textContent, ...((Array.isArray(node?.children) ? node.children : []) as WebviewElement[]).map(flat)]
  .filter(Boolean).join(' ');
/** The rows the emitted script rendered into the transcript, in order, each as the text it shows. */
function renderedRows(provider: ChatViewProvider): string[] {
  // Text nodes are modelled only under `mutations`; without it a reply's words would not be in the rows.
  const page = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }, 'sidebar'), { mutations: true });
  const transcript = page.elements.get('transcript')!;
  // The renderer fills one fragment and moves it in; the stub keeps the fragment as the transcript's first child.
  const fragment = (transcript.children as unknown as WebviewElement[])[0];
  return ((fragment?.children ?? []) as unknown as WebviewElement[]).map(flat);
}
const rowOf = (rows: string[], marker: string) => {
  const found = rows.filter((row) => row.includes(marker));
  expect(found, `one row shows ${marker}: ${JSON.stringify(rows)}`).toHaveLength(1);
  return rows.indexOf(found[0]);
};

const T = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString();
/** A chat stored by a build that wrote no `seq`: a question, a reasoning step, a tool, then the answer. */
function legacyStore(): Map<string, unknown> {
  return new Map<string, unknown>([
    ['roam.chat.pm', [
      { role: 'user', text: 'Old question one', ts: T(0) },
      { role: 'agent', text: 'Old answer one', ts: T(3), turnFinal: true },
      { role: 'user', text: 'Old question two', ts: T(4) },
      { role: 'agent', text: 'Old answer two', ts: T(6), turnFinal: true },
    ]],
    ['roam.chat.reasoning.pm', [{ kind: 'reasoning', id: 'old-reasoning', text: 'Old thinking step', ts: T(1) }]],
    ['roam.chat.tools.pm', [{ kind: 'tool', id: 'old-tool', ts: T(2), phase: 'result', name: 'read_file', title: 'Read notes.md',
      summary: 'Old tool read notes.md', category: 'read', ok: true }]],
  ]);
}
const OLD = ['Old question one', 'Old answer one', 'Old question two', 'Old answer two', 'Old thinking step', 'Old tool read notes.md'];
/** The order the old rows happened in: each stream's own order, merged by time. */
const CHRONOLOGICAL = ['Old question one', 'Old thinking step', 'Old tool read notes.md', 'Old answer one', 'Old question two', 'Old answer two'];
const storedSeqs = (store: Map<string, unknown>) => ['roam.chat.pm', 'roam.chat.reasoning.pm', 'roam.chat.tools.pm']
  .map((key) => (store.get(key) as Array<{ seq?: number }>).map((row) => row.seq));

describe('v0.9.103 6.2: old rows keep their order across reloads', () => {
  it('a new message between two reloads does not move the old reasoning and tool rows behind it', () => {
    const store = legacyStore();
    const first = chatOver(store);
    const before = renderedRows(first);
    const oldOrder = OLD.map((marker) => rowOf(before, marker));
    expect(CHRONOLOGICAL.map((marker) => rowOf(before, marker))).toEqual([0, 1, 2, 3, 4, 5]);
    // The sequences derived on this first read are stored with the rows, in every stream.
    expect(storedSeqs(store)).toEqual([[0, 3, 4, 5], [1], [2]]);
    // A second read in the same window shows the same order.
    expect(renderedRows(first)).toEqual(before);
    // The person keeps talking in this window: only the message stream is written again.
    first.postRuntimeNoticeOnce('pm', 'new-1', 'A newer message after the old ones');
    const live = renderedRows(first);
    expect(OLD.map((marker) => rowOf(live, marker))).toEqual(oldOrder);
    const newerAt = rowOf(live, 'A newer message after the old ones');
    expect(newerAt).toBeGreaterThan(Math.max(...oldOrder));
    first.dispose();

    // Reload: a new provider over the same stored state, rendered by the emitted script. Then once more.
    for (let reload = 0; reload < 2; reload++) {
      const again = chatOver(store);
      const rows = renderedRows(again);
      expect(rows, `reload ${reload + 1}`).toEqual(live);
      again.dispose();
    }
  });

  it('a new tool between two reloads does not move the old messages or reasoning', () => {
    const store = legacyStore();
    const first = chatOver(store);
    const before = renderedRows(first);
    const oldOrder = OLD.map((marker) => rowOf(before, marker));
    // Only the tool stream is written again: a finished tool card of a new turn.
    first.appendToolActivity('pm', { phase: 'use', callId: 'c-new', name: 'run_command', input: { command: 'echo newer' } });
    first.appendToolActivity('pm', { phase: 'result', callId: 'c-new', name: 'run_command', outcome: { status: 'success', observedBy: 'host' },
      summary: 'A newer tool ran echo' });
    const live = renderedRows(first);
    expect(OLD.map((marker) => rowOf(live, marker))).toEqual(oldOrder);
    expect(rowOf(live, 'echo newer')).toBeGreaterThan(Math.max(...oldOrder));
    first.dispose();
    for (let reload = 0; reload < 2; reload++) {
      const again = chatOver(store);
      expect(renderedRows(again), `reload ${reload + 1}`).toEqual(live);
      again.dispose();
    }
  });
});

const manifest = (label: string) => ({
  schemaVersion: 1 as const, sourceCount: 1, totalBytes: 40, estimatedTextTokens: 10,
  tokenEstimateLabel: 'Attached sources only' as never,
  entries: [{ kind: 'user-request' as never, label, location: 'chat', bytes: 40, estimatedTokens: 10, tokenEstimate: 'bytes / 4' as const,
    reason: 'message routed to this agent', staleness: 'unavailable' as const, sensitivity: 'unavailable' as const }],
});
const sendText = (provider: ChatViewProvider, text: string) => (provider as any).onMessage({ command: 'send', agentId: 'pm', text, mode: 'act' }, 'sidebar');

describe('v0.9.103 6.2: old rows keep their order when a new row comes first', () => {
  it('a new message written before the chat was ever shown keeps the old rows above it, in their order, across reloads', () => {
    const store = legacyStore();
    // Nothing reads the chat first: the host appends a message to a chat this window has not shown yet.
    const first = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'pm', name: 'PM', role: 'pm', backend: 'openai', status: 'stopped' }],
      send: vi.fn(), interject: vi.fn(), interrupt: vi.fn(), onReply: () => () => {},
      state: { get: <T>(key: string) => structuredClone(store.get(key)) as T | undefined,
        update: async (key, value) => { store.set(key, structuredClone(value)); } },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval: vi.fn(),
    });
    first.postRuntimeNoticeOnce('pm', 'first-new', 'The first new message');
    first.selectAgent('pm');
    const rows = renderedRows(first);
    expect([...CHRONOLOGICAL, 'The first new message'].map((marker) => rowOf(rows, marker))).toEqual([0, 1, 2, 3, 4, 5, 6]);
    first.dispose();
    for (let reload = 0; reload < 2; reload++) expect(renderedRows(chatOver(store)), `reload ${reload + 1}`).toEqual(rows);
  });
});

describe('v0.9.103 6.2: a context card stays beside its turn across a reload', () => {
  it('the card of each turn is shown again after a reload, and a new turn with an old turn number gets its own card beside it', async () => {
    const store = new Map<string, unknown>();
    const first = chatOver(store);
    await sendText(first, 'First question');
    first.setContextManifest('pm', manifest('First sources'), 1);
    first.postRuntimeNoticeOnce('pm', 'answer-1', 'First answer');
    await sendText(first, 'Second question');
    first.setContextManifest('pm', manifest('Second sources'), 2);
    // The same turn reported again is one card.
    first.setContextManifest('pm', manifest('Second sources'), 2);
    const live = renderedRows(first);
    expect(live.filter((row) => row.includes('Second sources'))).toHaveLength(1);
    expect(rowOf(live, 'First sources')).toBe(rowOf(live, 'First question') + 1);
    expect(rowOf(live, 'Second sources')).toBe(rowOf(live, 'Second question') + 1);
    first.dispose();

    // Reload: the same rows in the same order, the cards included.
    const again = chatOver(store);
    expect(renderedRows(again)).toEqual(live);
    // Turn numbers start again in the new window: its first turn is number 1 again. Its card goes beside it, not beside
    // the earlier window's first question, and the earlier card stays.
    await sendText(again, 'Third question');
    again.setContextManifest('pm', manifest('Third sources'), 1);
    const after = renderedRows(again);
    expect(after.slice(0, live.length)).toEqual(live);
    expect(rowOf(after, 'Third sources')).toBe(rowOf(after, 'Third question') + 1);
    expect(rowOf(after, 'Third question')).toBeGreaterThan(rowOf(after, 'Second sources'));
    again.dispose();

    // Clearing the conversation takes its cards with it, also after a reload.
    const third = chatOver(store);
    third.clearSelectedAgent();
    third.dispose();
    expect(renderedRows(chatOver(store)).some((row) => row.includes('sources'))).toBe(false);
  });

  it('a stored card that is not a whole card is left out, and its turn shows without it', () => {
    const store = new Map<string, unknown>([
      ['roam.chat.pm', [{ role: 'user', text: 'Kept question', ts: T(0), seq: 0, turnEpoch: 1 }]],
      ['roam.chat.contextManifests.pm', [
        { kind: 'contextManifest', id: 'bad', ts: T(0), seq: 0.01, turnEpoch: 1, manifest: { schemaVersion: 2, entries: [] } },
        { kind: 'contextManifest', id: 'good', ts: T(0), seq: 0.01, turnEpoch: 1, manifest: manifest('Whole card') },
      ]],
    ]);
    const rows = renderedRows(chatOver(store));
    expect(rows).toHaveLength(2);
    expect(rowOf(rows, 'Whole card')).toBe(1);
  });
});

describe('v0.9.103 6.2: a row added after an import goes below the imported conversation', () => {
  it('with the imported rows numbered above this chat, or without numbers, the new row is last, also after a reload', () => {
    for (const imported of [[100, 101, 102], [undefined, undefined, undefined]]) {
      const store = new Map<string, unknown>();
      const provider = chatOver(store);
      provider.postRuntimeNoticeOnce('pm', 'local', 'A local message');
      expect(provider.importToSelected(imported.map((seq, index) => ({ role: 'agent' as const, text: `Imported ${index}`, ts: T(index), seq }))))
        .toBe(true);
      provider.postRuntimeNoticeOnce('pm', 'after', 'After the import');
      const rows = renderedRows(provider);
      expect(['Imported 0', 'Imported 1', 'Imported 2', 'After the import'].map((marker) => rowOf(rows, marker)), JSON.stringify(rows))
        .toEqual([0, 1, 2, 3]);
      expect(rows.some((row) => row.includes('A local message'))).toBe(false);
      provider.dispose();
      expect(renderedRows(chatOver(store))).toEqual(rows);
    }
  });
});

/*
 * v0.9.103 (6.2, the Owner's "One line + tidy top"): once a chat dropped messages at its window, it says so in one line at
 * its top, and the page no longer shows finished work from before its oldest kept message. Work still running or waiting,
 * and a row without a time, are shown. Nothing is removed from what the chat keeps.
 */
describe('v0.9.103 6.2: one line and a tidy top after the oldest messages leave the chat', () => {
  const TOP_LINE = 'Older messages are not shown here. UnodeAi: Export Messages saves the team\'s most recent messages.';
  const delegationCard = (id: string, startedAt: string, working: boolean) => ({
    id, coordinatorId: 'pm', coordinatorName: 'PM', startedAt, ...(working ? {} : { completedAt: startedAt }),
    total: 1, done: working ? 0 : 1, partial: 0, blocked: 0, working: working ? 1 : 0,
    items: [{ id: `${id}-task`, coordinatorId: 'pm', coordinatorName: 'PM', agentId: 'dev', agentName: 'Dev', instruction: `Task of ${id}.`,
      scopeMode: 'fixed-session-permissions', status: working ? 'working' : 'done', startedAt, stepCount: 1 }],
  }) as never;
  const bootOf = (provider: ChatViewProvider) => bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }, 'sidebar'), { mutations: true });
  const rowsIn = (page: ReturnType<typeof bootWebviewScript>) =>
    (((page.elements.get('transcript')!.children as unknown as WebviewElement[])[0]?.children ?? []) as unknown as WebviewElement[]).map(flat);
  const deliver = (page: ReturnType<typeof bootWebviewScript>, provider: ChatViewProvider) => {
    for (const listener of page.listeners.message ?? []) listener({ data: { command: 'state', state: (provider as any).currentState() } });
  };
  const missingWork = (page: ReturnType<typeof bootWebviewScript>) => page.postedMessages
    .filter((m: any) => m.command === 'renderedTranscriptItemsMissing' && m.missing.some((item: any) => !item.id.startsWith('msg:')));

  it('no line before a message is dropped; then one line first, finished work before the oldest kept message hidden, running work shown, the same after a reload', () => {
    const store = new Map<string, unknown>();
    const chat = chatOver(store);
    // Work from before every message: a finished tool, a running tool, a finished and a running delegation.
    chat.appendToolActivity('pm', { phase: 'use', callId: 'done-1', name: 'run_command', input: { command: 'echo finished early' } });
    chat.appendToolActivity('pm', { phase: 'result', callId: 'done-1', name: 'run_command', outcome: { status: 'success', observedBy: 'host' }, summary: 'finished early' });
    chat.appendToolActivity('pm', { phase: 'use', callId: 'run-1', name: 'run_command', input: { command: 'echo still running' } });
    const early = new Date(Date.now() - 60_000).toISOString();
    chat.setDelegationProgress([delegationCard('run-finished', early, false), delegationCard('run-working', early, true)]);
    for (let index = 0; index < 50; index++) chat.postRuntimeNoticeOnce('pm', `n-${index}`, `Message ${index}`);
    const page = bootOf(chat);
    const full = rowsIn(page);
    // Fifty messages, none dropped: no line, and every row is shown.
    expect(full.some((row) => row.includes('Older messages'))).toBe(false);
    for (const marker of ['finished early', 'still running', 'Task of run-finished.', 'Task of run-working.', 'Message 0 ']) rowOf(full, marker);
    expect(store.has('roam.chat.historyTrimmed.pm')).toBe(false);

    chat.postRuntimeNoticeOnce('pm', 'n-50', 'Message 50');
    deliver(page, chat);
    const tidy = rowsIn(page);
    expect(tidy[0]).toBe(TOP_LINE);
    expect(tidy.filter((row) => row === TOP_LINE)).toHaveLength(1);
    expect(tidy.some((row) => row.includes('Message 0 '))).toBe(false);
    // The finished work is not shown; the running tool and the working delegation are, above the oldest kept message.
    expect(tidy.some((row) => row.includes('finished early') || row.includes('Task of run-finished.'))).toBe(false);
    const oldest = rowOf(tidy, 'Message 1 ');
    expect(rowOf(tidy, 'still running')).toBeLessThan(oldest);
    expect(rowOf(tidy, 'Task of run-working.')).toBeLessThan(oldest);
    expect(tidy.slice(1, oldest).filter((row) => !row.includes('still running') && !row.includes('Task of run-working.'))).toEqual([]);
    // Hidden from the page only: the finished tool is still kept, and still sent, so the page does not take it for lost.
    expect((store.get('roam.chat.tools.pm') as Array<{ summary: string }>).some((tool) => tool.summary === 'finished early')).toBe(true);
    expect((chat as any).currentState().messages.filter((row: any) => row.beforeOldest).map((row: any) => row.kind).sort()).toEqual(['delegation', 'tool']);
    expect(missingWork(page)).toEqual([]);
    expect(store.get('roam.chat.historyTrimmed.pm')).toBe(true);

    // The delegation finishes: now it is finished work from before the oldest message too.
    chat.setDelegationProgress([delegationCard('run-finished', early, false), delegationCard('run-working', early, false)]);
    deliver(page, chat);
    expect(rowsIn(page).some((row) => row.includes('Task of run-working.'))).toBe(false);
    expect(missingWork(page)).toEqual([]);
    const settled = rowsIn(page);
    chat.dispose();

    // Reload: the line and the tidy top are the same. (A tool still running when a window closes is the new window's
    // to settle; it is left out of the comparison.)
    const again = chatOver(store);
    again.setDelegationProgress([delegationCard('run-finished', early, false), delegationCard('run-working', early, false)]);
    const reloaded = rowsIn(bootOf(again));
    expect(reloaded[0]).toBe(TOP_LINE);
    expect(reloaded.filter((row) => !row.includes('still running'))).toEqual(settled.filter((row) => !row.includes('still running')));

    // Clearing the conversation takes the line away with its messages.
    again.clearSelectedAgent();
    expect(rowsIn(bootOf(again)).some((row) => row.includes('Older messages'))).toBe(false);
    expect(store.has('roam.chat.historyTrimmed.pm')).toBe(false);
  });

  it('a row without a time stays shown, and an import says whether it dropped messages', () => {
    const minute = (n: number) => new Date(Date.UTC(2026, 9, 2, 10, n)).toISOString();
    const store = new Map<string, unknown>([
      ['roam.chat.pm', [...Array(50).keys()].map((index) => ({ role: 'agent', text: `Kept ${index}`, ts: minute(10 + index), seq: 10 + index }))],
      ['roam.chat.historyTrimmed.pm', true],
      ['roam.chat.tools.pm', [
        { kind: 'tool', id: 'no-time', seq: 1, ts: new Date(0).toISOString(), phase: 'result', name: 'read_file', title: 'Read untimed.md', summary: 'Untimed row', category: 'read', ok: true },
        { kind: 'tool', id: 'timed', seq: 2, ts: minute(1), phase: 'result', name: 'read_file', title: 'Read timed.md', summary: 'Timed row', category: 'read', ok: true },
      ]],
    ]);
    const rows = renderedRows(chatOver(store));
    expect(rows[0]).toBe(TOP_LINE);
    expect(rowOf(rows, 'Untimed row')).toBe(1);
    expect(rows.some((row) => row.includes('Timed row'))).toBe(false);
    expect(rowOf(rows, 'Kept 0')).toBe(2);

    const importer = chatOver(new Map());
    importer.importToSelected([...Array(51).keys()].map((index) => ({ role: 'agent' as const, text: `Imported ${index}`, ts: minute(index) })));
    expect(renderedRows(importer)[0]).toBe(TOP_LINE);
    importer.importToSelected([{ role: 'agent', text: 'Short import', ts: minute(0) }]);
    expect(renderedRows(importer).some((row) => row.includes('Older messages'))).toBe(false);
  });

  // Codex's audit of a499ced2, finding 3: two imports into the same open chat whose messages carry the same sequence.
  // The page kept each message under its sequence and showed the first conversation again after the second import.
  it('a second import into the same open chat shows the new conversation, whatever sequences the files carry', () => {
    const minute = (n: number) => new Date(Date.UTC(2026, 9, 2, 11, n)).toISOString();
    const provider = chatOver(new Map());
    let page: ReturnType<typeof bootWebviewScript> | undefined;
    const pending: unknown[] = [];
    const deliver = (message: unknown) => { for (const listener of page?.listeners.message ?? []) listener({ data: message }); };
    const view = {
      visible: true,
      webview: { cspSource: 'test:', html: '', options: {},
        postMessage: (message: unknown) => { if (page) deliver(message); else pending.push(message); return Promise.resolve(true); },
        onDidReceiveMessage: () => ({ dispose() {} }) },
      onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }), show() {},
    };
    provider.resolveWebviewView(view as never, undefined as never, undefined as never);
    page = bootWebviewScript(view.webview.html, { mutations: true });
    for (const message of pending.splice(0)) deliver(message);
    const shown = () => {
      const transcript = page!.elements.get('transcript')!;
      const fragment = (transcript.children as unknown as WebviewElement[])[0];
      return ((fragment?.children ?? []) as unknown as WebviewElement[]).map(flat).join(' | ');
    };
    const file = (texts: string[], seq?: number) => parseChatImportPayload({ kind: 'chat',
      messages: texts.map((text, index) => ({ role: 'agent', text, ts: minute(index), ...(seq !== undefined ? { seq } : {}) })) });
    const imported = (texts: string[], seq?: number) => {
      const parsed = file(texts, seq);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) provider.importToSelected(parsed.messages, parsed.dropped === true);
    };
    imported(['Original conversation A'], 0);
    expect(shown()).toContain('Original conversation A');
    imported(['Replacement conversation B'], 0);
    expect(shown()).toContain('Replacement conversation B');
    expect(shown()).not.toContain('Original conversation A');
    // Files without sequences are numbered by the chat; they too never take an earlier message's place.
    imported(['Unnumbered C one', 'Unnumbered C two']);
    expect(shown()).toContain('Unnumbered C one');
    expect(shown()).toContain('Unnumbered C two');
    expect(shown()).not.toContain('Replacement conversation B');
    expect(shown().indexOf('Unnumbered C one')).toBeLessThan(shown().indexOf('Unnumbered C two'));
  });

  // The way Import Chat runs (extension.ts): the file is parsed first, which keeps its newest 50 messages, and the chat is
  // told whether older ones were left out. Before, the chat judged by the 50 it was given and never showed the line.
  it('Import Chat of a file with more messages than a chat keeps shows the line; one that fits does not', () => {
    const minute = (n: number) => new Date(Date.UTC(2026, 9, 2, 10, n)).toISOString();
    const file = (count: number) => ({ kind: 'chat', messages: [...Array(count).keys()].map((index) => ({ role: 'agent', text: `Imported ${index}`, ts: minute(index) })) });
    const importer = chatOver(new Map());
    const long = parseChatImportPayload(file(70));
    expect(long.ok).toBe(true);
    if (!long.ok) return;
    importer.importToSelected(long.messages, long.dropped === true);
    const rows = renderedRows(importer);
    expect(rows[0]).toBe(TOP_LINE);
    expect(rowOf(rows, 'Imported 20')).toBe(1);
    const fits = parseChatImportPayload(file(50));
    if (!fits.ok) return;
    importer.importToSelected(fits.messages, fits.dropped === true);
    expect(renderedRows(importer).some((row) => row.includes('Older messages'))).toBe(false);
    expect(readFileSync('src/extension.ts', 'utf8')).toContain('chatViewProvider.importToSelected(parsed.messages, parsed.dropped === true)');
  });
});
