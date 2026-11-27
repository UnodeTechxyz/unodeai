import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import fspDefault from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatViewProvider, type ChatViewDeps } from '../../views/ChatViewProvider';
import { HistoryService, type HistoryServiceDeps } from '../HistoryService';
import { HistoryStore, type HistoryStoreOptions } from '../HistoryStore';
import { RawCheckpointStore } from '../../backend/RawCheckpointStore';
import { PreChangeCheckpoints } from '../../backend/PreChangeCheckpoints';
import { TaskHistoryController, type TaskHistoryOutbound } from '../../views/taskHistoryController';
import { TASK_HISTORY_STYLE } from '../../views/taskHistoryView';
import { bootWebviewScript, type WebviewBootResult, type WebviewElement } from '../../views/__tests__/support/webviewBoot';
import { chatHistoryKey, serializeChatHistory, type ChatHistoryMessage } from '../../views/chatHistory';
import { bridgeStateKey } from '../LegacyChatProjectionBridge';
import type { RequestChecksObservation, RequestCloseoutRecordV1 } from '../../observability/RequestCloseout';

/**
 * v0.9.110 H1: Task history through its real entries: the Workbench page's own script (the view lives in the Workbench),
 * the chat's protocol, the host controller, the history service and the store on disk; restore points in a real raw
 * store; Resume into the composer the page renders; deletion and housekeeping on real files.
 */
const WORKSPACE = 'h'.repeat(64);
let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-task-history-'));
});
/** Every history a test opened: its queued writes finish before the folder is removed. */
const opened: HistoryService[] = [];
afterEach(async () => {
  // Work a write schedules (a reconcile after a member is selected) joins the queue later: wait for it too.
  const histories = opened.splice(0);
  for (let round = 0; round < 3; round++) {
    for (const history of histories) await history.flush();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await fsp.rm(dir, { recursive: true, force: true });
});

class State {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { const value = this.values.get(key); return value === undefined ? undefined : structuredClone(value) as T; }
  async update(key: string, value: unknown): Promise<void> { if (value === undefined) this.values.delete(key); else this.values.set(key, structuredClone(value)); }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

interface Seed { goal: string; reply?: string; agentId?: string; at?: number; requestId?: string;
  terminal?: 'completed' | 'interrupted' | 'failed'; verification?: 'verified' | 'not-verified'; rawRef?: string }

async function seed(store: HistoryStore, historyId: string, task: Seed): Promise<void> {
  const agentId = task.agentId ?? 'dev';
  const at = task.at ?? NOW - DAY;
  const userId = randomUUID();
  await store.append({ kind: 'transcript-append', agentId, viewGeneration: 'g', messageId: userId,
    message: { role: 'user', text: task.goal, ts: iso(at), messageId: userId }, startsTask: { historyId } });
  if (task.reply !== undefined) {
    const replyId = randomUUID();
    await store.append({ kind: 'transcript-append', agentId, viewGeneration: 'g', messageId: replyId,
      message: { role: 'agent', text: task.reply, ts: iso(at + 1000), messageId: replyId, turnFinal: true, fromName: 'Dev Agent' } });
  }
  if (task.requestId) {
    await store.append({ kind: 'request-admitted', historyId, rootRequestId: task.requestId, agentId });
    if (task.terminal) {
      await store.append({ kind: 'outcome-reference', historyId, outcomeRef: `request-closeout:${task.requestId}:t`, terminal: task.terminal,
        verification: task.verification ?? 'not-verified', endedAt: iso(at + 2000) });
    }
    if (task.rawRef) {
      await store.append({ kind: 'recovery-capture', rootRequestId: task.requestId, agentId, targetId: task.rawRef, displayPath: 'src/a.ts',
        physicalTarget: path.join(dir, 'ws', 'src', 'a.ts'), before: { kind: 'file', sha256: 'a'.repeat(64), size: 6, payloadRef: task.rawRef }, coverage: 'exact' });
      await store.append({ kind: 'recovery-settle', rootRequestId: task.requestId, targetId: task.rawRef, outcome: 'committed',
        after: { kind: 'file', sha256: 'b'.repeat(64), size: 4 } });
    }
  }
}

/** A real raw store, and the history's restore-point port over it, as the extension wires it. */
async function realRaw(limits?: { maxTotalBytes: number }) {
  const { store } = await RawCheckpointStore.open({ directory: path.join(dir, 'raw'), workspaceId: WORKSPACE, ...(limits ? { limits } : {}) });
  const port: NonNullable<HistoryServiceDeps['restorePoints']> = {
    remove: async (ids) => {
      const removed: string[] = [];
      const kept: string[] = [];
      const failed: string[] = [];
      for (const id of ids) {
        const outcome = await store.purge(id);
        (outcome === 'removed' ? removed : outcome === 'in-use' ? kept : failed).push(id);
      }
      return { removed, kept, failed };
    },
    all: async () => ({ points: store.list().map((entry) => ({ ref: entry.id, path: entry.path })) }),
    protect: async (ids) => {
      const held = new Set(store.durablyHeld('favourite'));
      for (const id of held) if (!ids.has(id)) await store.holdDurably(id, 'favourite', false);
      for (const id of ids) if (!held.has(id)) await store.holdDurably(id, 'favourite', true);
    },
    available: async (ids) => new Set(ids.filter((id) => store.get(id))),
  };
  const capture = async (name: string, bytes: string) => {
    const result = await store.capture({ agentId: 'dev', path: name, target: path.join(dir, 'ws', name), bytes: Buffer.from(bytes) });
    if (result.status !== 'captured') throw new Error(result.status === 'refused' ? result.reason : 'not captured');
    result.pin.release();
    await store.idle();
    return result.entry.id;
  };
  return { store, port, capture };
}

function rig(options: {
  running?: Set<string>; members?: Array<{ id: string; name: string }>; confirm?: boolean;
  removed?: string[]; restorePoints?: HistoryServiceDeps['restorePoints']; storeOptions?: Partial<HistoryStoreOptions>;
  checks?: (agentId: string, refs: readonly string[]) => RequestChecksObservation | undefined; picks?: string[];
  /** What the older chat key holds before this window starts. */
  initial?: Record<string, unknown>;
} = {}) {
  const state = new State();
  for (const [key, value] of Object.entries(options.initial ?? {})) state.values.set(key, structuredClone(value));
  const storeDir = path.join(dir, 'history');
  const removedRaw: string[] = [];
  let chat!: ChatViewProvider;
  const history = new HistoryService({
    open: () => HistoryStore.open({ directory: storeDir, workspaceId: WORKSPACE, writerId: randomUUID(), now: () => NOW,
      isRequestRunning: (id) => options.running?.has(id) ?? false, ...options.storeOptions }),
    state,
    onMessagesDeleted: (agentId, ids, digests) => chat.removeHistoryMessages(agentId, ids, digests),
    restorePoints: options.restorePoints ?? { remove: async (ids) => { removedRaw.push(...ids);
      return { removed: ids.filter((id) => !options.removed || options.removed.includes(id)), kept: ids.filter((id) => options.removed !== undefined && !options.removed.includes(id)) }; } },
    now: () => NOW,
  });
  opened.push(history);
  const send = vi.fn();
  const members = options.members ?? [{ id: 'dev', name: 'Dev Agent' }];
  const posted: TaskHistoryOutbound[] = [];
  const pending: Array<Promise<unknown>> = [];
  const picks: string[] = [];
  let page: WebviewBootResult | undefined;
  const fromHost: unknown[] = [];
  const deliver = (message: unknown) => { fromHost.push(message); for (const listener of page?.listeners.message ?? []) listener({ data: message }); };
  const controller = new TaskHistoryController({
    history,
    members: () => members,
    selectedMember: () => chat.getSelectedAgentId() || undefined,
    insertIntoComposer: (agentId, text) => chat.insertIntoComposer(agentId, text),
    pickMember: async (list) => { picks.push(list.map((m) => m.id).join(',')); return options.picks?.shift() ?? list[0]?.id; },
    confirm: async () => options.confirm ?? true,
    post: (message) => { posted.push(message); chat.postTaskHistory(message); },
    checks: options.checks,
    now: () => NOW,
  });
  const deps = {
    listAgents: () => members.map((m) => ({ id: m.id, name: m.name, role: 'Developer', status: 'idle', backend: 'openai' })),
    send, interject: vi.fn(), interrupt: vi.fn(), onReply: () => () => {},
    state, history, getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval: vi.fn(),
    taskHistory: { handle: (message: unknown) => { pending.push(controller.handle(message)); } },
  } as unknown as ChatViewDeps;
  chat = new ChatViewProvider({} as never, deps);
  const panel = {
    visible: true, viewColumn: 1, reveal: vi.fn(), dispose: vi.fn(),
    webview: { cspSource: 'test:', html: '', options: {}, postMessage: vi.fn(async (message: unknown) => { deliver(message); return true; }),
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })) },
    onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })), onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
  };
  chat.restoreWorkbench(panel as never);
  let handled = 0;
  /** Deliver what the Workbench page posted for Task history through the chat's real protocol, until quiet. */
  const settle = async () => {
    for (let round = 0; round < 60; round++) {
      while (page && handled < page.postedMessages.length) {
        const message = page.postedMessages[handled++] as { command?: string };
        if (message?.command === 'taskHistory') (chat as any).onMessage(message, 'workbench');
      }
      if (pending.length === 0) break;
      await Promise.all(pending.splice(0));
    }
  };
  /** Open Task history (the command), then boot the Workbench page the panel shows. */
  const boot = async (width = 1000) => {
    chat.openTaskHistory();
    page = bootWebviewScript((chat as any).getHtml({ cspSource: 'test:' }, 'workbench'), { focusModel: {}, mutations: true, window: { innerWidth: width } });
    await settle();
    return page;
  };
  const el = (id: string) => page!.elements.get(id)!;
  const rows = () => ((el('th-list').children ?? []) as unknown as WebviewElement[]);
  const rowText = (row: WebviewElement) => ((row.children as unknown as WebviewElement[]) ?? []).map((child) => String(child.textContent ?? '')).join(' | ');
  const click = async (element: WebviewElement) => { page!.dispatchElementEvent(element, 'click', {}); await settle(); };
  const open = async (row: WebviewElement) => click((row.children as unknown as WebviewElement[])[0]);
  const store = async () => (await history.store())!;
  const report = () => (posted.filter((m) => m.command === 'report').at(-1) as Extract<TaskHistoryOutbound, { command: 'report' }> | undefined)?.lines.join(' ') ?? '';
  return { state, history, chat, send, controller, posted, boot, rows, rowText, click, open, settle, store, removedRaw, picks, el, report, page: () => page! };
}

const contains = (root: string, text: string): string[] => {
  const found: string[] = [];
  if (!fs.existsSync(root)) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...contains(full, text));
    else if (fs.readFileSync(full, 'utf8').includes(text)) found.push(path.relative(dir, full));
  }
  return found;
};

describe('Task history in the Workbench', () => {
  it('opens in the Workbench; lists, pages, searches, filters and opens tasks; a favourite changed meanwhile is not forced', async () => {
    const r = rig();
    const s = await r.store();
    for (let i = 0; i < 55; i++) {
      await seed(s, `t${i}`, { goal: i === 7 ? 'find the needle' : `task ${i}`, reply: `done ${i}`, requestId: `r${i}`,
        terminal: i % 5 === 0 ? 'interrupted' : 'completed', verification: i % 2 === 0 ? 'verified' : 'not-verified', at: NOW - DAY + i * 1000 });
    }
    const page = await r.boot();
    expect(r.el('th-view').hidden).toBe(false);
    // The view is the Workbench's: the side bar's page has none of it.
    expect((r.chat as any).getHtml({ cspSource: 'test:' }, 'sidebar')).not.toContain('th-view');
    expect(r.rows()).toHaveLength(50);
    expect(r.el('th-more').hidden).toBe(false);
    await r.click(r.el('th-more'));
    expect(r.rows()).toHaveLength(55);
    expect(page.activeElement()).toBe((r.rows()[50].children as unknown as WebviewElement[])[0]);

    r.el('th-search').value = 'NEEDLE';
    await r.click(r.el('th-apply'));
    expect(r.rows()).toHaveLength(1);
    expect(r.rowText(r.rows()[0])).toContain('find the needle');

    r.el('th-search').value = '';
    r.el('th-terminal').value = 'interrupted';
    await r.click(r.el('th-apply'));
    expect(r.rows()).toHaveLength(11);
    expect(r.rows().every((row) => r.rowText(row).includes('Interrupted') && !r.rowText(row).includes('Completed'))).toBe(true);
    r.el('th-terminal').value = 'completed';
    r.el('th-verification').value = 'not-verified';
    await r.click(r.el('th-apply'));
    expect(r.rows().every((row) => r.rowText(row).includes('Completed') && r.rowText(row).includes('Not verified'))).toBe(true);

    const opener = (r.rows()[0].children as unknown as WebviewElement[])[0];
    await r.click(opener);
    expect(r.el('th-details').hidden).toBe(false);
    expect(String(r.el('th-detailsCoverage').textContent)).toContain('No recorded file changes');
    expect(r.el('th-detailsTranscript').children).toHaveLength(2);
    for (const listener of page.listeners.keydown ?? []) listener({ key: 'Escape', preventDefault: () => {} });
    expect(r.el('th-details').hidden).toBe(true);
    expect(page.activeElement()).toBe(opener);

    const star = (r.rows()[0].children as unknown as WebviewElement[])[3];
    const shownId = (r.posted.filter((m) => m.command === 'page').at(-1) as Extract<TaskHistoryOutbound, { command: 'page' }>).rows[0].historyId;
    const shownTask = (await s.task(shownId))!;
    const patched = shownTask.messageIds[1];
    await s.append({ kind: 'transcript-patch', agentId: 'dev', messageId: patched, message: { role: 'agent', text: 'patched later', ts: iso(NOW), messageId: patched, turnFinal: true } });
    await r.click(star);
    expect((await s.task(shownId))!.favourite).toBe(false);
    expect(String(r.el('th-status').textContent)).toMatch(/changed since it was shown/);
    await r.click(star);
    expect((await s.task(shownId))!.favourite).toBe(true);
    expect(String(star.textContent)).toBe('★ Favourite');
  });

  it("smoke H1: the page is the window's size and scrolls inside it, so every control is reachable in a short window", () => {
    // The Workbench centres each child of the body; for this fixed layer that kept it as tall as its content and cut
    // its lower controls off. Measured in headless Edge at 300, 500 and 700 px: the layer is the window's height, scrolls,
    // and its last control is reachable. Here, the rule that makes it so.
    const rule = /#th-view \{([^}]*)\}/.exec(TASK_HISTORY_STYLE)![1];
    for (const declaration of ['position: fixed', 'inset: 0', 'align-self: stretch', 'justify-self: stretch', 'width: auto', 'overflow: auto']) {
      expect(rule).toContain(declaration);
    }
    expect(rule).not.toMatch(/(^|[^-])height:/);
  });

  it('says when nothing is saved yet, and collapses secondary details in a narrow Workbench', async () => {
    const r = rig();
    await r.boot(400);
    expect(String(r.el('th-status').textContent)).toMatch(/No saved tasks yet/);
    expect(r.el('th-view').classList.contains('th-narrow')).toBe(true);
    const wide = rig();
    await wide.boot(1200);
    expect(wide.el('th-view').classList.contains('th-narrow')).toBe(false);
  });

  it('F5: shows the whole saved result and transcript, and the checks of the request\'s closeout record', async () => {
    const checks: RequestChecksObservation = { coverage: 'complete', passed: 2, failed: 1, refused: 0 };
    const r = rig({ checks: (agentId, refs) => (agentId === 'dev' && refs.includes('request-closeout:req:t') ? checks : undefined) });
    const s = await r.store();
    const long = `start ${'z'.repeat(5000)} end`;
    await seed(s, 'task', { goal: 'long one', reply: long, requestId: 'req', terminal: 'completed' });
    await seed(s, 'legacy-like', { goal: 'no closeout' });
    await r.boot();
    await r.open(r.rows().find((row) => r.rowText(row).includes('long one'))!);
    expect(String(r.el('th-detailsResult').textContent)).toBe(long);
    const transcript = r.el('th-detailsTranscript').children as unknown as WebviewElement[];
    expect(((transcript[1].children as unknown as WebviewElement[])[1]).textContent).toBe(long);
    expect(String(r.el('th-detailsChecks').textContent)).toBe('Checks the host ran: 2 passed, 1 failed.');
    await r.open(r.rows().find((row) => r.rowText(row).includes('no closeout'))!);
    expect(String(r.el('th-detailsChecks').textContent)).toMatch(/no closeout record/);
    expect(String(r.el('th-detailsResult').textContent)).toBe('No result was recorded.');
  });
});

describe('Resume', () => {
  it('F4: fills the composer the person is using now, keeps the selected member, and keeps the result\'s references', async () => {
    const r = rig({ members: [{ id: 'dev', name: 'Dev Agent' }, { id: 'qa', name: 'QA' }] });
    const s = await r.store();
    const long = `[Saved result](reports/result.md)\n${'x'.repeat(1500)}${'y'.repeat(1500)}`;
    await seed(s, 'task', { goal: 'Refactor the parser', reply: long, requestId: 'req', terminal: 'completed', rawRef: 'c'.repeat(32) });
    r.chat.selectAgent('qa');
    await r.boot();
    await r.open(r.rows()[0]);
    await r.click(r.el('th-resume'));
    expect(r.chat.getSelectedAgentId()).toBe('qa');
    expect(r.picks).toEqual([]);
    // The draft as the Workbench composer renders it: in QA's box, editable, not sent.
    const input = String(r.el('input').value);
    expect(input).toContain('Goal (as sent):\nRefactor the parser');
    expect(input).toContain('its last 2000 characters; the beginning is cut');
    expect(input).toContain(`${'x'.repeat(500)}${'y'.repeat(1500)}`);
    expect(input).not.toContain('x'.repeat(501));
    expect(input).toContain('- Saved result: reports/result.md');
    expect(input).toContain('- src/a.ts');
    expect(r.el('th-view').hidden).toBe(true);
    expect(r.send).not.toHaveBeenCalled();
  });

  it('asks who continues when the task\'s member was removed, and says when the result was not recorded', async () => {
    const r = rig({ members: [{ id: 'qa', name: 'QA' }, { id: 'ops', name: 'Ops' }], picks: ['ops'] });
    const s = await r.store();
    await seed(s, 'task', { goal: 'Old goal', agentId: 'gone' });
    await r.boot();
    await r.open(r.rows()[0]);
    expect(String(r.el('th-resume').textContent)).toBe('Resume with another member…');
    await r.click(r.el('th-resume'));
    expect(r.picks).toEqual(['qa,ops']);
    expect(r.chat.getSelectedAgentId()).toBe('ops');
    expect(String(r.el('input').value)).toContain('Final result: not recorded.');
    expect(r.send).not.toHaveBeenCalled();
  });
});

describe('Housekeeping', () => {
  it('removes the oldest ended tasks past 30 days and past the count, never a favourite, running or protected task', async () => {
    const r = rig({ running: new Set(['r-running']) });
    const s = await r.store();
    await seed(s, 'old', { goal: 'old', reply: 'x', requestId: 'r-old', terminal: 'completed', at: NOW - 40 * DAY });
    await seed(s, 'old-fav', { goal: 'old favourite', reply: 'x', requestId: 'r-fav', terminal: 'completed', at: NOW - 41 * DAY });
    await s.setFavourite('old-fav', (await s.task('old-fav'))!.revision, true);
    await seed(s, 'running', { goal: 'running', requestId: 'r-running', at: NOW - 50 * DAY });
    await seed(s, 'protected', { goal: 'protected', reply: 'x', requestId: 'r-prot', terminal: 'completed', at: NOW - 45 * DAY });
    for (let i = 0; i < 3; i++) await seed(s, `recent${i}`, { goal: `recent ${i}`, reply: 'x', requestId: `r${i}`, terminal: 'completed', at: NOW - (3 - i) * DAY });
    const outcome = await s.housekeep({ maxAgeMs: 30 * DAY, maxEndedTasks: 5, maxBytes: 16 * 1024 * 1024 }, (task) => task.historyId === 'protected');
    expect(outcome.deleted).toEqual(['old']);
    expect((await s.query()).tasks.map((task) => task.historyId).sort()).toEqual(['old-fav', 'protected', 'recent0', 'recent1', 'recent2', 'running']);
    expect((await s.task('old-fav'))!.favourite).toBe(true);
    const tight = await s.housekeep({ maxAgeMs: 30 * DAY, maxEndedTasks: 1, maxBytes: 16 * 1024 * 1024 }, (task) => task.historyId === 'protected');
    expect(tight.deleted).toEqual(['recent0', 'recent1', 'recent2']);
    expect(tight.overflow).toBe(true);
    expect((await s.query()).tasks.map((task) => task.historyId).sort()).toEqual(['old-fav', 'protected', 'running']);
  });

  it('tells the person once when protected tasks fill the room', async () => {
    let told = 0;
    const history = new HistoryService({ open: () => HistoryStore.open({ directory: path.join(dir, 'hk'), workspaceId: WORKSPACE, writerId: randomUUID() }),
      state: new State(), onStorageFull: () => { told++; }, now: () => NOW });
    const s = (await history.store())!;
    for (let i = 0; i < 2; i++) {
      await seed(s, `f${i}`, { goal: `fav ${i}`, reply: 'x'.repeat(200), requestId: `rf${i}`, terminal: 'completed' });
      await s.setFavourite(`f${i}`, (await s.task(`f${i}`))!.revision, true);
    }
    const realHousekeep = s.housekeep.bind(s);
    (s as any).housekeep = (_limits: unknown, protect: never) => realHousekeep({ maxAgeMs: 30 * DAY, maxEndedTasks: 1, maxBytes: 1 << 30 }, protect);
    await history.housekeep(true);
    await history.housekeep(true);
    expect(told).toBe(1);
  });
});

describe('Favourites keep their restore points (F3)', () => {
  it('a favourite\'s restore point is held through quota pressure and a reopen; unmarked, it can go, and is then not shown as revertible', async () => {
    const raw = await realRaw({ maxTotalBytes: 6 });
    const ref = await raw.capture('a.txt', 'before');
    const r = rig({ restorePoints: raw.port });
    const s = await r.store();
    await seed(s, 'task', { goal: 'favourite work', reply: 'done', requestId: 'req', terminal: 'completed', rawRef: ref });
    await r.boot();
    await r.click((r.rows()[0].children as unknown as WebviewElement[])[3]);
    expect((await s.task('task'))!.favourite).toBe(true);
    // Room is needed for a new restore point: the favourite's is not the one to go.
    expect((await raw.store.capture({ agentId: 'dev', path: 'b.txt', target: path.join(dir, 'ws', 'b.txt'), bytes: Buffer.from('second') })).status).toBe('refused');
    expect((await raw.store.readBefore(ref))).toEqual({ status: 'read', bytes: Buffer.from('before') });
    // The hold is written into the index: another opening of the raw store keeps it.
    const { store: reopened } = await RawCheckpointStore.open({ directory: path.join(dir, 'raw'), workspaceId: WORKSPACE, limits: { maxTotalBytes: 6 } });
    expect(reopened.isPinned(ref)).toBe(true);
    // Unmarked: the history lets it go, and the next capture may take its room.
    await r.click((r.rows()[0].children as unknown as WebviewElement[])[3]);
    expect((await s.task('task'))!.favourite).toBe(false);
    expect(raw.store.isPinned(ref)).toBe(false);
    await raw.capture('b.txt', 'second');
    expect(raw.store.get(ref)).toBeUndefined();
    await r.open(r.rows()[0]);
    expect(String(r.el('th-detailsCoverage').textContent)).toMatch(/^Not revertible/);
  });
});

describe('Deleting from Task history', () => {
  it('Remove conversation view: the task leaves the history and the chat, and its text leaves the disk', async () => {
    const r = rig();
    const s = await r.store();
    r.chat.selectAgent('dev');
    (r.chat as any).onMessage({ command: 'send', agentId: 'dev', requestId: randomUUID(), text: 'secret plan alpha', mode: 'act', attachments: [] }, 'sidebar');
    await r.history.flush();
    await seed(s, 'other', { goal: 'keep this one', reply: 'kept' });
    await r.boot();
    await r.open(r.rows().find((element) => r.rowText(element).includes('secret plan alpha'))!);
    await r.click(r.el('th-deleteView'));
    expect((await s.query()).tasks.map((task) => task.goal)).toEqual(['keep this one']);
    expect(r.chat.exportSelected()!.messages.map((m) => m.text)).not.toContain('secret plan alpha');
    expect(contains(path.join(dir, 'history'), 'secret plan alpha')).toEqual([]);
    const fresh = await HistoryStore.open({ directory: path.join(dir, 'history'), workspaceId: WORKSPACE, writerId: randomUUID() });
    expect((await fresh.query()).tasks.map((task) => task.goal)).toEqual(['keep this one']);
  });

  it('F1: Delete both while a restore point is in use keeps it owed and named; after the work ends and a reopen, any later deletion removes it', async () => {
    const raw = await realRaw();
    const result = await raw.store.capture({ agentId: 'dev', path: 'a.txt', target: path.join(dir, 'ws', 'a.txt'), bytes: Buffer.from('before') });
    if (result.status !== 'captured') throw new Error('not captured');
    const ref = result.entry.id;
    const r = rig({ restorePoints: raw.port });
    await seed(await r.store(), 'task', { goal: 'changed files', reply: 'ok', requestId: 'req', terminal: 'completed', rawRef: ref });
    await seed(await r.store(), 'later', { goal: 'another task', reply: 'ok' });
    const first = await r.history.deleteTasks(['task'], 'both');
    expect(first).toMatchObject({ restorePointsRemoved: 0, restorePointsKept: 1, restorePointsKeptFiles: ['src/a.ts'] });
    result.pin.release();
    await raw.store.idle();
    // A new window: the history is opened again; what is owed is still known.
    const again = rig({ restorePoints: raw.port });
    expect((await again.store()).ownedRestorePoints()).toEqual([{ ref, path: 'src/a.ts', state: 'owed' }]);
    // Deleting only another task's conversation also finishes what is owed.
    const later = await again.history.deleteTasks(['later'], 'view');
    expect(later).toMatchObject({ status: 'deleted', restorePointsRemoved: 1, restorePointsKept: 0 });
    expect((await raw.store.readBefore(ref)).status).not.toBe('read');
    expect((await again.store()).ownedRestorePoints()).toEqual([]);
  });

  it('smoke H2.1: the open details say what a deletion did: restore points deleted, or the task gone', async () => {
    const raw = await realRaw();
    const ref = await raw.capture('a.txt', 'before');
    const r = rig({ restorePoints: raw.port });
    await seed(await r.store(), 'task', { goal: 'changed files', reply: 'ok', requestId: 'req', terminal: 'completed', rawRef: ref });
    await r.boot();
    await r.open(r.rows()[0]);
    expect(String(r.el('th-detailsCoverage').textContent)).toMatch(/^Revertible/);
    await r.click(r.el('th-deleteRestore'));
    expect(r.el('th-details').hidden).toBe(false);
    expect(String(r.el('th-detailsCoverage').textContent)).toBe('Not revertible. Its restore points were deleted.');
    // Removing the conversation then closes the details of a task that is no longer there.
    await r.click(r.el('th-deleteView'));
    expect(r.el('th-details').hidden).toBe(true);
    expect(String(r.el('th-status').textContent)).toContain('That task is no longer in the history.');
  });

  it('smoke H2.1: a refresh never reopens details the person closed', async () => {
    const r = rig();
    await seed(await r.store(), 'one', { goal: 'first task', reply: 'ok' });
    await seed(await r.store(), 'two', { goal: 'second task', reply: 'ok' });
    await r.boot();
    await r.open(r.rows().find((row) => r.rowText(row).includes('first task'))!);
    expect(r.el('th-details').hidden).toBe(false);
    await r.click(r.el('th-closeDetails'));
    expect(r.el('th-details').hidden).toBe(true);
    await r.click(r.el('th-deleteAll'));
    // The host says the task is gone; the page, whose details are closed, neither reopens them nor reports it.
    expect(r.posted.filter((m) => m.command === 'details' || m.command === 'detailsGone').at(-1)).toMatchObject({ command: 'detailsGone', refresh: true });
    expect(r.el('th-details').hidden).toBe(true);
    expect(String(r.el('th-status').textContent)).not.toContain('no longer in the history');
  });

  it('Delete all deletes the Edit history and archived chats once, and reports a failure as partial', async () => {
    const order: string[] = [];
    const ok = rig({ restorePoints: {
      remove: async (ids) => { order.push('restore points'); return { removed: [...ids], kept: [] }; },
      deleteLocalCopies: async () => { order.push('local copies'); return { editHistoryRecords: 3, archivedChats: 2 }; },
    } });
    await seed(await ok.store(), 'task', { goal: 'done work', reply: 'ok', requestId: 'req', terminal: 'completed' });
    const report = await ok.history.deleteAll(['dev']);
    expect(order).toEqual(['local copies']);
    expect(report).toMatchObject({ status: 'deleted', localCopiesRemoved: { editHistoryRecords: 3, archivedChats: 2 } });

    const failing = rig({ restorePoints: {
      remove: async (ids) => ({ removed: [...ids], kept: [] }),
      deleteLocalCopies: async () => { throw new Error('the state could not be written'); },
    } });
    const partial = await failing.history.deleteAll(['dev']);
    expect(partial.status).toBe('partial');
    expect(partial.remaining.join(' ')).toContain('the Edit history and archived chats could not be deleted (the state could not be written)');
    expect(partial.localCopiesRemoved).toBeUndefined();
  });

  it('F1: Delete all finds the restore points of a task whose conversation was already removed', async () => {
    const raw = await realRaw();
    const ref = await raw.capture('a.txt', 'before');
    const r = rig({ restorePoints: raw.port });
    await seed(await r.store(), 'task', { goal: 'hidden later', reply: 'ok', requestId: 'req', terminal: 'completed', rawRef: ref });
    await r.history.deleteTasks(['task'], 'view');
    expect((await raw.store.readBefore(ref)).status).toBe('read');
    const all = await r.history.deleteAll(['dev']);
    expect(all.restorePointsRemoved).toBe(1);
    expect((await raw.store.readBefore(ref)).status).not.toBe('read');
  });

  it('F2: a deletion whose copy could not be written is reported partial, and deleting again completes it', async () => {
    let fail = true;
    const r = rig({ storeOptions: { beforeSnapshotPublish: async () => { if (fail) throw new Error('simulated disk write failure'); } } });
    await seed(await r.store(), 'task', { goal: 'original goal', reply: 'final answer' });
    const first = await r.history.deleteAll(['dev']);
    expect(first.status).toBe('partial');
    expect(first.remaining.join(' ')).toMatch(/could not be written \(simulated disk write failure\)/);
    expect(contains(path.join(dir, 'history'), 'original goal').length).toBeGreaterThan(0);
    fail = false;
    const second = await r.history.deleteAll(['dev']);
    expect(second.status).toBe('deleted');
    expect(contains(path.join(dir, 'history'), 'original goal')).toEqual([]);
  });

  it('F2: a set-aside copy of a healed record goes with the deletion; one still unreadable is named, not claimed deleted', async () => {
    const r = rig();
    const s = await r.store();
    await seed(s, 'task', { goal: 'original goal', reply: 'final answer' });
    const event = path.join(dir, 'history', 'events', '000000000001.json');
    const good = fs.readFileSync(event, 'utf8');
    fs.writeFileSync(event, good.slice(0, -3));
    fs.utimesSync(event, new Date(0), new Date(0));
    const other = await HistoryStore.open({ directory: path.join(dir, 'history'), workspaceId: WORKSPACE, writerId: randomUUID() });
    expect(other.gaps).toEqual([1]);
    expect(fs.existsSync(path.join(dir, 'history', 'quarantine', '000000000001.json'))).toBe(true);
    fs.writeFileSync(event, good);
    await other.refresh();
    const healed = await new HistoryService({ open: async () => other, state: new State() }).deleteAll(['dev']);
    expect(healed.status).toBe('deleted');
    expect(contains(path.join(dir, 'history'), 'original goal')).toEqual([]);

    // A record that stays unreadable cannot be checked: kept, and the report says so.
    await fsp.rm(path.join(dir, 'history'), { recursive: true, force: true });
    const r2 = rig();
    await seed(await r2.store(), 'task2', { goal: 'second goal', reply: 'answer' });
    const event2 = path.join(dir, 'history', 'events', '000000000002.json');
    fs.writeFileSync(event2, fs.readFileSync(event2, 'utf8').slice(0, 10));
    fs.utimesSync(event2, new Date(0), new Date(0));
    const reader = await HistoryStore.open({ directory: path.join(dir, 'history'), workspaceId: WORKSPACE, writerId: randomUUID() });
    const partial = await new HistoryService({ open: async () => reader, state: new State() }).deleteAll(['dev']);
    expect(partial.status).toBe('partial');
    expect(partial.remaining.join(' ')).toMatch(/could not be checked and were kept \(000000000002\.json\)/);
  });

  it('F2: a copy another window published from before the deletion is replaced, never accepted as the purge', async () => {
    let staleWinner: string | undefined;
    const r = rig({ storeOptions: { beforeSnapshotPublish: async (file) => {
      if (!staleWinner) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, staleWinner.replace('"through":0', `"through":${Number(path.basename(file, '.json'))}`));
      staleWinner = undefined;
    } } });
    const s = await r.store();
    await seed(s, 'task', { goal: 'original goal', reply: 'final answer' });
    // What another window would publish: every event as it was, the goal included.
    const events = fs.readdirSync(path.join(dir, 'history', 'events')).sort()
      .map((name) => ({ revision: Number(name.slice(0, 12)), envelope: JSON.parse(fs.readFileSync(path.join(dir, 'history', 'events', name), 'utf8')) }));
    staleWinner = JSON.stringify({ schemaVersion: 1, workspaceId: WORKSPACE, through: 0, events, gaps: [] });
    const report = await r.history.deleteAll(['dev']);
    expect(report.status).toBe('deleted');
    expect(contains(path.join(dir, 'history'), 'original goal')).toEqual([]);
  });

  it('a deleted legacy conversation is not brought back by a stale older copy; a new message still is', async () => {
    const stale: ChatHistoryMessage[] = [{ role: 'user', text: 'legacy secret', ts: iso(NOW - 3 * DAY), seq: 0 }, { role: 'agent', text: 'legacy answer', ts: iso(NOW - 3 * DAY + 1), seq: 1 }];
    const r = rig({ initial: { [chatHistoryKey('dev')]: serializeChatHistory(stale) } });
    const s = await r.store();
    expect(['migrated', 'unchanged']).toContain(await r.history.bridge.reconcile('dev'));
    expect(s.messagesOf('dev').map((entry) => entry.message.text)).toEqual(['legacy secret', 'legacy answer']);
    const legacyTask = (await s.query()).tasks[0];
    expect((await r.history.deleteTasks([legacyTask.historyId], 'both')).status).toBe('deleted');
    await r.state.update(chatHistoryKey('dev'), serializeChatHistory([...stale, { role: 'user', text: 'new in 109', ts: iso(NOW), seq: 2 }]));
    await r.history.bridge.reconcile('dev');
    const texts = s.messagesOf('dev').map((entry) => entry.message.text);
    expect(texts).not.toContain('legacy secret');
    expect(texts).toContain('new in 109');
  });

  it('a deleted 0.9.110 message is not imported back from a copy written without its id, even where no baseline remembers it', async () => {
    const r = rig();
    const s = await r.store();
    r.chat.selectAgent('dev');
    (r.chat as any).onMessage({ command: 'send', agentId: 'dev', requestId: randomUUID(), text: 'sent in 110 then deleted', mode: 'act', attachments: [] }, 'sidebar');
    await r.history.flush();
    await r.history.bridge.reconcile('dev');
    const copy = r.state.get<ChatHistoryMessage[]>(chatHistoryKey('dev'))!;
    const task = (await s.query()).tasks.find((entry) => entry.goal === 'sent in 110 then deleted')!;
    expect((await r.history.deleteTasks([task.historyId], 'view')).status).toBe('deleted');
    await r.state.update(bridgeStateKey('dev'), undefined);
    await r.state.update(chatHistoryKey('dev'), serializeChatHistory([...copy.map(({ messageId: _id, ...rest }) => rest),
      { role: 'user', text: 'really new', ts: iso(NOW + 1), seq: 99 }]));
    await r.history.bridge.reconcile('dev');
    const texts = s.messagesOf('dev').map((entry) => entry.message.text);
    expect(texts).not.toContain('sent in 110 then deleted');
    expect(texts).toContain('really new');
  });

  it('F6: a genuinely new message with its own id is imported even when a deleted one had the same content', async () => {
    const old = { role: 'user' as const, text: 'same saved content', ts: '2026-11-20T00:00:00.000Z', messageId: 'old-uuid' };
    const r = rig({ initial: { [chatHistoryKey('dev')]: [old] } });
    const s = await r.store();
    await r.history.bridge.reconcile('dev');
    const task = (await s.query()).tasks[0];
    await r.history.deleteTasks([task.historyId], 'both');
    await r.state.update(chatHistoryKey('dev'), [old, { ...old, messageId: 'new-uuid' }]);
    await r.history.bridge.reconcile('dev');
    expect(s.hasMessage('new-uuid')).toBe(true);
    expect(s.messagesOf('dev').map((entry) => entry.messageId)).toEqual(['new-uuid']);
    expect((await s.query()).tasks).toHaveLength(1);
    // The same content again, now the only one of its kind in the key: its own id decides, not the deleted digest.
    await r.state.update(chatHistoryKey('dev'), [{ ...old, messageId: 'newest-uuid' }]);
    await r.history.bridge.reconcile('dev');
    expect(s.hasMessage('newest-uuid')).toBe(true);
    // A copy without any id is still held back by the deleted digest.
    await r.state.update(chatHistoryKey('dev'), [{ role: old.role, text: old.text, ts: old.ts }]);
    await r.history.bridge.reconcile('dev');
    expect(s.messagesOf('dev').map((entry) => entry.messageId)).toEqual(['new-uuid', 'newest-uuid']);
  });

  it('Delete all deletes every task, favourites included, keeps running ones and everything that is not history, and reports it', async () => {
    const r = rig({ running: new Set(['r-run']) });
    const s = await r.store();
    await seed(s, 'fav', { goal: 'favourite task', reply: 'x', requestId: 'r-fav', terminal: 'completed', rawRef: 'e'.repeat(32) });
    await s.setFavourite('fav', (await s.task('fav'))!.revision, true);
    await seed(s, 'plain', { goal: 'plain task', reply: 'y', requestId: 'r-plain', terminal: 'failed' });
    await seed(s, 'run', { goal: 'running task', requestId: 'r-run' });
    fs.mkdirSync(path.join(dir, 'spend'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'spend', 'ledger.ndjson'), 'spend record\n');
    await r.state.update('roam.approvals.dev', ['an approval']);
    await r.boot();
    await r.click(r.el('th-storageButton'));
    expect(r.el('th-storage').hidden).toBe(false);
    await r.click(r.el('th-deleteAll'));
    expect((await s.query()).tasks.map((task) => task.historyId)).toEqual(['run']);
    expect(r.removedRaw).toEqual(['e'.repeat(32)]);
    expect(fs.readFileSync(path.join(dir, 'spend', 'ledger.ndjson'), 'utf8')).toBe('spend record\n');
    expect(r.state.get('roam.approvals.dev')).toEqual(['an approval']);
    expect(r.report()).toMatch(/Deleted: 2 task\(s\)/);
    expect(r.report()).toMatch(/Kept: 1 running task\(s\)/);
    expect(r.report()).toMatch(/Not history, so not deleted/);
    expect(contains(path.join(dir, 'history'), 'favourite task')).toEqual([]);
  });

  it('deletes nothing when the person does not confirm', async () => {
    const r = rig({ confirm: false });
    const s = await r.store();
    await seed(s, 'task', { goal: 'keep me', reply: 'x' });
    await r.boot();
    await r.open(r.rows()[0]);
    await r.click(r.el('th-deleteBoth'));
    await r.click(r.el('th-deleteAll'));
    expect((await s.query()).tasks).toHaveLength(1);
  });
});

describe('re-audit of be5edb7e', () => {
  it('F2: an event file a deletion could not remove is reported, and deleting again removes it, in the same window and after a reopen', async () => {
    for (const reopen of [false, true]) {
      await fsp.rm(path.join(dir, 'history'), { recursive: true, force: true });
      const r = rig();
      await seed(await r.store(), 'task', { goal: 'purge sensitive goal', reply: 'answer' });
      const event = path.join(dir, 'history', 'events', '000000000001.json');
      const realRm = fsp.rm;
      const blocked = vi.spyOn(fspDefault, 'rm').mockImplementation(async (file, options) => {
        if (String(file) === event) throw Object.assign(new Error('injected EPERM'), { code: 'EPERM' });
        return realRm(file, options);
      });
      syncBuiltinESMExports();
      let first;
      try { first = await r.history.deleteAll(['dev']); } finally { blocked.mockRestore(); syncBuiltinESMExports(); }
      expect(first.status).toBe('partial');
      expect(first.remaining.join(' ')).toMatch(/older history file\(s\) could not be removed/);
      expect(fs.readFileSync(event, 'utf8')).toContain('purge sensitive goal');
      const again = reopen ? rig() : r;
      const retry = await again.history.deleteAll(['dev']);
      expect(retry.status).toBe('deleted');
      expect(fs.existsSync(event)).toBe(false);
      expect(contains(path.join(dir, 'history'), 'purge sensitive goal')).toEqual([]);
      await r.history.flush();
      await again.history.flush();
    }
  });

  it('F3: a running task marked favourite keeps a restore point it captures afterwards, after its request ends and under room pressure', async () => {
    const raw = await realRaw({ maxTotalBytes: 6 });
    const running = new Set(['req']);
    const r = rig({ restorePoints: raw.port, running });
    await seed(await r.store(), 'task', { goal: 'still running', requestId: 'req' });
    await r.boot();
    await r.click((r.rows()[0].children as unknown as WebviewElement[])[3]);
    expect((await (await r.store()).task('task'))!.favourite).toBe(true);
    const preChange = new PreChangeCheckpoints({ open: async () => raw.store, isRequestRunning: (id) => running.has(id),
      recovery: { captured: (capture) => r.history.recoveryCaptured(capture), settled: (settle) => r.history.recoverySettled(settle) } });
    const target = path.join(dir, 'ws', 'a.txt');
    const kept = await preChange.capture({ agentId: 'dev', requestId: 'req', path: 'a.txt', target, physical: target, bytes: Buffer.from('before') });
    if (kept.status !== 'kept') throw new Error(kept.status);
    await kept.checkpoint.settle({ kind: 'committed', after: { exists: true, size: 5, sha256: 'b'.repeat(64) } });
    await r.history.flush();
    expect(raw.store.durablyHeld('favourite')).toEqual([kept.checkpoint.id]);
    // The request ends: its own pins go; the favourite's hold stays, so a new capture cannot take its room.
    running.delete('req');
    preChange.releaseEndedRequests();
    await raw.store.idle();
    const next = await raw.store.capture({ agentId: 'dev', path: 'b.txt', target: path.join(dir, 'ws', 'b.txt'), bytes: Buffer.from('second') });
    expect(next.status).toBe('refused');
    expect(await raw.store.readBefore(kept.checkpoint.id)).toEqual({ status: 'read', bytes: Buffer.from('before') });
  });

  it('F6: Clear keeps a new message with its own id for the history, even with the content of a deleted one, which stays deleted', async () => {
    const old = { role: 'user' as const, text: 'same identity collision content', ts: '2026-11-25T00:00:00.000Z', messageId: 'old-uuid', seq: 0 };
    const r = rig({ initial: { [chatHistoryKey('dev')]: [old] } });
    const s = await r.store();
    r.chat.selectAgent('dev');
    await r.history.flush();
    await r.history.bridge.reconcile('dev');
    await r.history.deleteTasks([(await s.query()).tasks[0].historyId], 'both');
    // An older version writes the key: only the new message, with its own id and the deleted one's content.
    await r.state.update(chatHistoryKey('dev'), [{ ...old, messageId: 'new-uuid' }]);
    r.chat.clearSelectedAgent();
    await r.history.flush();
    await r.history.bridge.reconcile('dev');
    expect(r.state.get(chatHistoryKey('dev'))).toBeUndefined();
    expect(s.hasMessage('new-uuid')).toBe(true);
    expect(s.messagesOf('dev').map((entry) => entry.messageId)).toEqual(['new-uuid']);
    expect((await s.query()).tasks.map((task) => task.goal)).toEqual(['same identity collision content']);
    expect(s.messagesOf('dev').some((entry) => entry.messageId === 'old-uuid')).toBe(false);
  });

  it('F6: before Clear, a second id-less copy of deleted content is kept as the new message it is; the stale first copy stays deleted', async () => {
    const legacy = { role: 'user' as const, text: 'said twice', ts: '2026-11-20T00:00:00.000Z', seq: 0 };
    const r = rig({ initial: { [chatHistoryKey('dev')]: serializeChatHistory([legacy]) } });
    const s = await r.store();
    r.chat.selectAgent('dev');
    await r.history.flush();
    await r.history.bridge.reconcile('dev');
    await r.history.deleteTasks([(await s.query()).tasks[0].historyId], 'both');
    await r.history.flush();
    expect(s.messagesOf('dev')).toEqual([]);
    // An older version writes the key: the stale copy, then the very same message again (same text, time and place).
    await r.state.update(chatHistoryKey('dev'), [legacy, legacy]);
    r.chat.clearSelectedAgent();
    await r.history.flush();
    await r.history.bridge.reconcile('dev');
    expect(s.messagesOf('dev').map((entry) => entry.message.text)).toEqual(['said twice']);
  });
});

describe('re-audit of da4b6107', () => {
  it('F3: a favourite\'s later capture stays held by its request until the history holds it, even when the capture is still being written as the request ends', async () => {
    const raw = await realRaw({ maxTotalBytes: 6 });
    let running = true;
    const r = rig({ restorePoints: raw.port });
    await seed(await r.store(), 'task', { goal: 'still running', requestId: 'req' });
    await r.boot();
    await r.click((r.rows()[0].children as unknown as WebviewElement[])[3]);
    expect((await (await r.store()).task('task'))!.favourite).toBe(true);
    const preChange = new PreChangeCheckpoints({ open: async () => raw.store, isRequestRunning: () => running,
      recovery: { captured: (capture) => r.history.recoveryCaptured(capture), settled: (settle) => r.history.recoverySettled(settle) } });
    // Only the publication of the capture's history event waits; it then happens as it would.
    let allow!: () => void;
    let entered!: () => void;
    const allowed = new Promise<void>((resolve) => { allow = resolve; });
    const publishing = new Promise<void>((resolve) => { entered = resolve; });
    const realLink = fspDefault.link;
    const held = vi.spyOn(fspDefault, 'link').mockImplementation(async (source, destination) => {
      if (String(source).startsWith(path.join(dir, 'history')) && String(source).includes('rc-')) { entered(); await allowed; }
      return realLink(source, destination);
    });
    syncBuiltinESMExports();
    const target = path.join(dir, 'ws', 'a.txt');
    let next;
    try {
      const kept = await preChange.capture({ agentId: 'dev', requestId: 'req', path: 'a.txt', target, physical: target, bytes: Buffer.from('before') });
      if (kept.status !== 'kept') throw new Error(kept.status);
      await kept.checkpoint.settle({ kind: 'committed', after: { exists: true, size: 5, sha256: 'b'.repeat(64) } });
      await publishing;
      // The request ends while its capture is still being written; the next capture lets go of ended requests itself.
      running = false;
      const other = path.join(dir, 'ws', 'b.txt');
      next = await preChange.capture({ agentId: 'dev', path: 'b.txt', target: other, physical: other, bytes: Buffer.from('second') });
      expect(next.status).toBe('refused');
      expect(await raw.store.readBefore(kept.checkpoint.id)).toEqual({ status: 'read', bytes: Buffer.from('before') });
      allow();
      await r.history.flush();
      expect(raw.store.durablyHeld('favourite')).toEqual([kept.checkpoint.id]);
      // Handed over: the request's own hold goes now, the favourite's stays.
      const third = await preChange.capture({ agentId: 'dev', path: 'b.txt', target: other, physical: other, bytes: Buffer.from('second') });
      expect(third.status).toBe('refused');
      expect(await raw.store.readBefore(kept.checkpoint.id)).toEqual({ status: 'read', bytes: Buffer.from('before') });
      // Unmarked, nothing holds it any more: the request let go of it once the history had taken over. (The row shown
      // is older than the capture: the first click shows it again, as changed, the second one unmarks it.)
      await r.click((r.rows()[0].children as unknown as WebviewElement[])[3]);
      if ((await (await r.store()).task('task'))!.favourite) await r.click((r.rows()[0].children as unknown as WebviewElement[])[3]);
      expect((await (await r.store()).task('task'))!.favourite).toBe(false);
      await r.history.flush();
      expect(raw.store.durablyHeld('favourite')).toEqual([]);
      const fourth = await preChange.capture({ agentId: 'dev', path: 'b.txt', target: other, physical: other, bytes: Buffer.from('second') });
      expect(fourth.status).toBe('kept');
      if (fourth.status === 'kept') await fourth.checkpoint.settle({ kind: 'uncertain' });
    } finally {
      allow();
      held.mockRestore();
      syncBuiltinESMExports();
    }
    await r.history.flush();
  });

  it('F1: an older restore-point directory is empty when absent or another workspace\'s, and an error when it cannot be inspected', async () => {
    const legacy = { directory: path.join(dir, 'raw-v1'), workspaceId: WORKSPACE };
    expect(await RawCheckpointStore.readEntries(legacy)).toEqual([]);
    const { store } = await RawCheckpointStore.open(legacy);
    const saved = await store.capture({ agentId: 'dev', path: 'old.txt', target: path.join(dir, 'ws', 'old.txt'), bytes: Buffer.from('old') });
    if (saved.status !== 'captured') throw new Error(saved.status);
    saved.pin.release();
    await store.idle();
    expect((await RawCheckpointStore.readEntries(legacy)).map((entry) => entry.id)).toEqual([saved.entry.id]);
    expect(await RawCheckpointStore.readEntries({ ...legacy, workspaceId: 'b'.repeat(64) })).toEqual([]);
    const realRead = fspDefault.readFile;
    const realList = fspDefault.readdir;
    const index = path.join(legacy.directory, 'index.json');
    const payloads = path.join(legacy.directory, 'payloads');
    const blockedRead = vi.spyOn(fspDefault, 'readFile').mockImplementation(async (file, ...rest) => {
      if (String(file) === index) throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
      return (realRead as (...args: unknown[]) => Promise<unknown>)(file, ...rest) as never;
    });
    syncBuiltinESMExports();
    try {
      await expect(RawCheckpointStore.readEntries(legacy)).rejects.toThrow(/could not be read \(EACCES\)/);
    } finally { blockedRead.mockRestore(); syncBuiltinESMExports(); }
    const blockedList = vi.spyOn(fspDefault, 'readdir').mockImplementation(async (folder, ...rest) => {
      if (String(folder) === payloads) throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
      return (realList as (...args: unknown[]) => Promise<unknown>)(folder, ...rest) as never;
    });
    syncBuiltinESMExports();
    try {
      await expect(RawCheckpointStore.readEntries(legacy)).rejects.toThrow(/could not be listed \(EACCES\)/);
    } finally { blockedList.mockRestore(); syncBuiltinESMExports(); }
    fs.writeFileSync(index, '{ damaged');
    await expect(RawCheckpointStore.readEntries(legacy)).rejects.toThrow(/not readable/);
  });
});

describe('a closeout record revised later (H0 D5)', () => {
  it('becomes a new outcome reference: the task shows the revised facts', async () => {
    const r = rig();
    const s = await r.store();
    await seed(s, 'task', { goal: 'goal', reply: 'x', requestId: 'req' });
    const record = (revision: number, passed: number) => ({
      recordId: 'request-closeout:req:turn', requestId: 'req', rootAgentId: 'dev', revision, recordedAt: iso(NOW),
      terminal: { kind: 'answered' }, observations: { checks: { coverage: 'complete', passed, failed: 0, refused: 0 } },
    }) as unknown as RequestCloseoutRecordV1;
    r.history.outcomeRecorded(record(1, 0));
    r.history.outcomeRecorded(record(2, 1));
    await r.history.flush();
    await s.refresh();
    expect((await s.task('task'))!.verification).toBe('verified');
  });
});
