import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler } from '../../backend/AgentBackend';
import type { CoordinatorTaskStatus } from '../../backend/TeamTools';
import { AccessTable } from '../../host/AccessTable';
import { connectPmLive } from '../../host/pmLiveView';
import type { PmStripTaskFacts } from '../../observability/RunLedger';
import { pmLiveStrip, type PmLiveLine, type PmLiveStrip, type PmQuietCandidate } from '../../session/PmLiveStrip';
import { SessionManager } from '../../session/SessionManager';
import type { AgentConfig } from '../../types';
import { ChatViewProvider } from '../ChatViewProvider';
import { bootWebviewScript, type WebviewBootResult } from './support/webviewBoot';

/*
 * v0.9.103 (slice 3 §4, §6; Codex design PASS R3): the silent-teammate line. Its source is the current attempt's own live
 * turn, read through SessionManager.liveAttemptActivity; the PM strip sends each running task's candidate before the
 * threshold; the page crosses DELEGATION_STALLED_AFTER_MS on its own ticker and keeps one stable line in its own live
 * region. Fake clock throughout. Display only: no model call, no Stop, no grant.
 */

const T0 = Date.parse('2026-11-14T09:00:00.000Z');
const HANDLE = 'h-dev';
const MIN = 60_000;

class FakeBackend implements AgentBackend {
  readonly agentId: string;
  pid = 4321;
  turns = 0;
  stops = 0;
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void { this.handler = h; return () => (this.handler = undefined); }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(): void { this.turns++; }
  async stop(): Promise<void> { this.stops++; this.alive = false; this.emit({ kind: 'exit', code: 0 }); }
  abort(): void { /* the test drives the events */ }
  isAlive(): boolean { return this.alive; }
  emit(e: BackendEvent): void { this.handler?.(e); }
}

function config(id: string, name: string, role: string): AgentConfig {
  return {
    id, name, role: role as AgentConfig['role'], skill: '',
    provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' },
    model: 'deepseek-v4.1-flash', systemPrompt: '', autoApprove: true, allowedTools: [],
  };
}

const activeTask = (handle: string, fields: Partial<CoordinatorTaskStatus> = {}): CoordinatorTaskStatus => ({
  handle, agentId: 'dev', requestedAgent: 'Dev', lifecycle: 'active', recordedState: 'active',
  dispatchedAt: new Date(T0).toISOString(), ...fields,
} as CoordinatorTaskStatus);

/** The text assistive tech reads: nothing under aria-hidden. */
function spoken(node: any): string {
  if (!node || node.getAttribute?.('aria-hidden') === 'true') return '';
  const kids: any[] = Array.isArray(node.children) ? node.children : [];
  return kids.length ? kids.map(spoken).filter(Boolean).join(' ') : String(node.textContent ?? '');
}

/** The text a sighted person reads: the words for assistive tech and the buttons left out. */
function seen(node: any): string {
  if (!node || node.className === 'pm-live-said' || node.type === 'button') return '';
  const kids: any[] = Array.isArray(node.children) ? node.children : [];
  return kids.length ? kids.map(seen).join('') : String(node.textContent ?? '');
}

/** A PM and its teammate Dev in a real SessionManager, the production strip connection, and the chat page. */
async function harness(options: { stripFacts?: Map<string, PmStripTaskFacts>; tasks?: CoordinatorTaskStatus[] } = {}) {
  const bus = new MessageBus();
  const backends = new Map<string, FakeBackend>();
  const table = new AccessTable({
    judge: () => ({ state: 'missing', effective: 'none', source: 'none', granted: 'none', grantIds: [] }),
    identity: (named) => named,
    remote: () => false,
  });
  let held = false;
  let tasks = options.tasks ?? [activeTask(HANDLE)];
  const activityReads: string[] = [];
  const manager = new SessionManager(5, bus, {
    createBackend: (agent) => { const backend = new FakeBackend(agent); backends.set(agent.id, backend); return backend; },
    resolveEnv: async () => ({}),
    coordinatorTaskStatus: (_coordinatorId, keep) => tasks.filter(keep),
    ...(options.stripFacts ? { coordinatorStripFacts: () => options.stripFacts! } : {}),
    coordinatorHeld: () => held,
    pmRepliedAt: () => new Date(T0 - MIN).toISOString(),
    // src/extension.ts's own bridge to the access table.
    attemptAccessWait: ({ requestId, agentId, handle }) => table.attemptAccessWait(requestId, { agentId, handle }),
  });
  manager.create(config('pm', 'Project Manager', 'pm'));
  manager.create(config('dev', 'Dev', 'senior-dev'));
  await manager.start('dev', { pin: 'take' });
  const dev = backends.get('dev')!;
  dev.emit({ kind: 'ready' });

  const chat = new ChatViewProvider({} as never, {
    listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'Project Manager', backend: 'openai' }],
    send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
    state: { get: () => undefined, update: async () => {} },
    getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
  } as never);
  chat.selectAgent('pm');
  let page: WebviewBootResult | undefined;
  const view = {
    visible: true,
    webview: {
      cspSource: 'test:', html: '', options: {},
      postMessage: (message: unknown) => { for (const listener of page?.listeners.message ?? []) listener({ data: message }); return Promise.resolve(true); },
      onDidReceiveMessage: () => ({ dispose() {} }),
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
    show() {},
  };
  chat.resolveWebviewView(view as never, undefined as never, undefined as never);
  page = bootWebviewScript(view.webview.html, { mutations: true });

  const live = connectPmLive({
    sessionManager: {
      coordinatorIds: () => manager.coordinatorIds(),
      coordinatorLiveFacts: (id) => manager.coordinatorLiveFacts(id),
      liveAttemptActivity: (handle) => { activityReads.push(handle); return manager.liveAttemptActivity(handle); },
      on: (event, listener) => manager.on(event, listener),
      off: (event, listener) => manager.off(event, listener),
    },
    accessTable: table,
    runLedger: { onDidChange: () => () => undefined },
    publish: (strips) => chat.setPmLive(strips),
  });
  await vi.advanceTimersByTimeAsync(0);

  const quiet = () => page!.elements.get('pmLiveQuiet') as any;
  const strip = (): PmLiveStrip | undefined => (chat as any).pmLive.get('pm');
  const candidates = (): PmQuietCandidate[] => {
    const line = strip()?.lines.find((entry) => entry.kind === 'quiet') as Extract<PmLiveLine, { kind: 'quiet' }> | undefined;
    return line?.teammates ?? [];
  };
  return {
    bus, manager, dev, table, chat, page: page!, live, quiet, strip, candidates, activityReads,
    hold: (value: boolean) => { held = value; },
    setTasks: (next: CoordinatorTaskStatus[]) => { tasks = next; },
    /** The PM assigns Dev a task under `handle`: the teammate turn that carries it starts. */
    assign: async (handle = HANDLE) => {
      bus.send('pm', 'dev', 'task.assign', { instruction: 'Review the plan.' }, 'high', handle);
      await vi.advanceTimersByTimeAsync(0);
    },
    /** What the quiet region says: to assistive tech, and on screen. */
    said: () => spoken(quiet()),
    shown: () => seen(quiet()),
    /** Every record inside #pmLiveQuiet since `from`. */
    quietRecords: (from: number) => page!.mutations.slice(from).filter((record) => page!.observedUnder(record, quiet())),
    hiddenFromSpeech: (record: { ancestors: unknown[] }) => record.ancestors.some((ancestor: any) => ancestor?.getAttribute?.('aria-hidden') === 'true'),
  };
}

describe('the silent-teammate line, from the attempt\'s own turn to the emitted page (slice 3 §4, §6)', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
  });
  afterEach(() => {
    h?.live.dispose();
    vi.useRealTimers();
  });

  it('enters at the threshold, holds through ticks, repaints and unchanged refreshes, and only real activity resets it', async () => {
    h = await harness();
    await h.assign();
    h.dev.emit({ kind: 'model_request' });
    expect(h.manager.liveAttemptActivity(HANDLE)).toEqual({ startedHere: true, phase: 'provider-wait', lastActivityAt: new Date(T0).toISOString() });
    await vi.advanceTimersByTimeAsync(30_000);
    // The candidate reaches the page before the threshold; the page shows nothing yet.
    expect(h.candidates()).toEqual([{ handle: HANDLE, agent: 'Dev', task: 'Dev\'s task', phase: 'provider-wait', quietSince: new Date(T0).toISOString() }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.quiet().children).toHaveLength(0);

    // Exactly DELEGATION_STALLED_AFTER_MS after the last activity, on the page's own ticker.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.said()).toBe('No activity: Dev, waiting on the model provider Ask the PM');
    expect(h.shown()).toBe('No activity: Dev (2 min, waiting on the model provider)');
    expect(h.quiet().hidden).toBe(false);

    // Two ticks, an unrelated repaint, and the host's unchanged 15-second refreshes reset nothing.
    const from = h.page.mutations.length;
    await vi.advanceTimersByTimeAsync(30_000);
    (h.chat as any).postState();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.candidates()[0].quietSince).toBe(new Date(T0).toISOString());
    expect(h.shown()).toBe('No activity: Dev (3 min, waiting on the model provider)');
    expect(h.said()).toBe('No activity: Dev, waiting on the model provider Ask the PM');
    const records = h.quietRecords(from);
    expect(records.filter((record) => record.type !== 'characterData')).toEqual([]);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => h.hiddenFromSpeech(record))).toBe(true);

    // Real output from the provider is activity: the next host refresh carries it, and the line goes.
    h.dev.emit({ kind: 'reasoning_delta', delta: 'thinking' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.candidates()[0]).toMatchObject({ phase: 'reasoning', quietSince: new Date(T0 + 3 * MIN).toISOString() });
    expect(h.quiet().children).toHaveLength(0);
    // Silent again for the threshold: the line returns, with no context to name.
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(h.shown()).toBe('No activity: Dev (2 min)');
    expect(h.said()).toBe('No activity: Dev Ask the PM');

    // Display only: one teammate turn, no Stop, no grant.
    expect(h.dev.turns).toBe(1);
    expect(h.dev.stops).toBe(0);
    expect(h.table.grantRows.map.size).toBe(0);
  });

  it('names a running tool, and Ask the PM fills the message box with every silent task and sends nothing', async () => {
    h = await harness();
    await h.assign();
    h.dev.emit({ kind: 'tool_use', callId: 'c1', name: 'run_command', input: {} });
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(h.candidates()).toEqual([expect.objectContaining({ phase: 'tool', tool: 'run_command' })]);
    expect(h.shown()).toBe('No activity: Dev (2 min, running run_command)');
    expect(h.said()).toBe('No activity: Dev, running run_command Ask the PM');
    const input = h.page.elements.get('input') as any;
    input.value = '';
    const posted = h.page.postedMessages.length;
    const button = h.quiet().children[0].children.find((child: any) => child.type === 'button');
    expect(button.textContent).toBe('Ask the PM');
    expect(button.title).toContain('Nothing is sent until you press Send');
    h.page.dispatchElementEvent(button, 'click');
    expect(input.value).toBe('Please check whether these teammates are still making progress, and tell me:\n'
      + '- Dev\'s task (handle h-dev): no output for 2 min (running run_command)');
    expect(h.page.postedMessages.slice(posted).filter((message: any) => message?.command === 'send')).toEqual([]);
    expect(h.dev.turns).toBe(1);
  });

  it('shows nothing while the turn waits for an approval, even in a tool phase; an ordinary silent tool stays eligible', async () => {
    h = await harness();
    await h.assign();
    h.dev.emit({ kind: 'tool_use', callId: 'c1', name: 'read_file', input: {} });
    h.manager.approvalStarted('dev', 'approval-1');
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(h.manager.getTurnPhase('dev')).toMatchObject({ phase: 'tool', approvalPending: true });
    expect(h.manager.liveAttemptActivity(HANDLE)).toBeUndefined();
    expect(h.candidates()).toEqual([]);
    expect(h.quiet().children).toHaveLength(0);
    h.manager.approvalFinished('dev', 'approval-1');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.shown()).toBe('No activity: Dev (3 min, running read_file)');
  });

  it('shows nothing while the attempt has an access need the person is asked for, or one it cannot be matched to', async () => {
    h = await harness();
    await h.assign();
    h.dev.emit({ kind: 'tool_use', callId: 'c1', name: 'read_file', input: {} });
    const requestId = h.manager.currentRequestId('dev')!;
    // Another attempt's need is not this one's.
    h.table.addNeed(requestId, '/outside/other', { agentId: 'dev', handle: 'h-other' }, 'read', 'input');
    await vi.advanceTimersByTimeAsync(2 * MIN + 30_000);
    expect(h.table.attemptAccessWait(requestId, { agentId: 'dev', handle: HANDLE })).toBe('none');
    expect(h.shown()).toBe('No activity: Dev (2 min, running read_file)');
    // This attempt's own need: waiting for the person.
    h.table.addNeed(requestId, '/outside/data', { agentId: 'dev', handle: HANDLE }, 'read', 'input');
    expect(h.table.attemptAccessWait(requestId, { agentId: 'dev', handle: HANDLE })).toBe('waiting');
    expect(h.manager.liveAttemptActivity(HANDLE)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.candidates()).toEqual([]);
    expect(h.quiet().children).toHaveLength(0);
    // Released, it no longer waits; a refusal recorded for Dev alone cannot be matched to the attempt: unknown.
    h.table.dropConsumer(requestId, { agentId: 'dev', handle: HANDLE });
    h.table.addNeed(requestId, '/outside/refused', { agentId: 'dev' }, 'read', 'refused');
    expect(h.table.attemptAccessWait(requestId, { agentId: 'dev', handle: HANDLE })).toBe('unknown');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.manager.liveAttemptActivity(HANDLE)).toBeUndefined();
    expect(h.quiet().children).toHaveLength(0);
    // With no access port, the answer is unknown too.
    expect(h.table.grantRows.map.size).toBe(0);
  });

  it('shows nothing while compacting, for a queued task, after the turn ends, or for a task restored with no live turn', async () => {
    h = await harness({ tasks: [activeTask(HANDLE), activeTask('h-queued'), activeTask('h-restored')] });
    await h.assign();
    await h.assign('h-queued');
    h.dev.emit({ kind: 'provider_compaction', phase: 'started' });
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(h.manager.liveAttemptActivity(HANDLE)).toMatchObject({ phase: 'compacting' });
    expect(h.manager.liveAttemptActivity('h-queued')).toBeUndefined();
    // Read after a reload: the record says active, nothing in this window runs it.
    expect(h.manager.liveAttemptActivity('h-restored')).toBeUndefined();
    expect(h.strip()?.lines.find((line) => line.kind === 'running')).toBeDefined();
    expect(h.candidates()).toEqual([]);
    expect(h.quiet().children).toHaveLength(0);
    h.dev.emit({ kind: 'provider_compaction', phase: 'finished' });
    h.dev.emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.manager.liveAttemptActivity(HANDLE)).toBeUndefined();
  });

  it('shows nothing for a task live in another window, or while Stop holds the PM', async () => {
    const elsewhere = new Map<string, PmStripTaskFacts>([[HANDLE, { startedHere: false, liveElsewhere: true, runOpen: true }]]);
    h = await harness({ stripFacts: elsewhere });
    await h.assign();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    // Not listed as running here, so its turn is not even read.
    expect(h.activityReads).toEqual([]);
    expect(h.strip()?.lines.map((line) => line.kind)).toEqual(['elsewhere']);
    expect(h.quiet().children).toHaveLength(0);
    h.live.dispose();

    h = await harness();
    await h.assign();
    h.hold(true);
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(h.manager.liveAttemptActivity(HANDLE)).toBeDefined();
    expect(h.strip()?.lines[0]).toMatchObject({ kind: 'stopped' });
    expect(h.candidates()).toEqual([]);
    expect(h.quiet().children).toHaveLength(0);
  });

  it('a clock set back shows nothing until the threshold is crossed again', async () => {
    h = await harness();
    await h.assign();
    h.dev.emit({ kind: 'model_request' });
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(h.shown()).toBe('No activity: Dev (2 min, waiting on the model provider)');
    vi.setSystemTime(new Date(T0 - 5 * MIN));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.quiet().children).toHaveLength(0);
    expect(h.candidates()[0].quietSince).toBe(new Date(T0).toISOString());
    vi.setSystemTime(new Date(T0 + 2 * MIN));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.shown()).toBe('No activity: Dev (2 min, waiting on the model provider)');
  });
});

describe('a candidate the strip cannot read affirmatively is unknown, and gives no line (slice 3 §4.1)', () => {
  const facts = (activity?: Map<string, any>) => pmLiveStrip({
    held: false, tasks: [activeTask(HANDLE)], repliedAt: new Date(T0).toISOString(), queued: new Set(), starting: 0,
    waitingForAccess: [], agentNames: new Map([['dev', 'Dev']]), ...(activity ? { activity } : {}),
  })!.lines.map((line) => line.kind);
  const at = new Date(T0).toISOString();

  it.each([
    ['no reading', undefined],
    ['not started here', new Map([[HANDLE, { startedHere: false, phase: 'provider-wait', lastActivityAt: at }]])],
    ['a missing time', new Map([[HANDLE, { startedHere: true, phase: 'provider-wait' }]])],
    ['a time that does not parse', new Map([[HANDLE, { startedHere: true, phase: 'provider-wait', lastActivityAt: 'yesterday-ish' }]])],
    ['compacting', new Map([[HANDLE, { startedHere: true, phase: 'compacting', lastActivityAt: at }]])],
    ['another handle\'s reading', new Map([['h-other', { startedHere: true, phase: 'provider-wait', lastActivityAt: at }]])],
  ])('%s', (_name, activity) => {
    expect(facts(activity)).toEqual(['running', 'promise']);
  });

  it('an affirmative reading is a candidate', () => {
    expect(facts(new Map([[HANDLE, { startedHere: true, phase: 'provider-wait', lastActivityAt: at }]]))).toEqual(['running', 'quiet', 'promise']);
  });
});

/*
 * v0.9.103 (slice 3 §4.4, §6 D4-R2): #pmLive is a plain wrapper around two sibling live regions. Ticks and unchanged
 * refreshes rebuild #pmLiveLines but insert, move or replace nothing in #pmLiveQuiet: only the aria-hidden minute counts
 * change. A new silent teammate, or a silent teammate's new context, replaces the quiet text once.
 */
describe('the quiet line\'s announcement boundary in the emitted page (slice 3 §4.4)', () => {
  const html = () => (new ChatViewProvider({} as never, {
    listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'Project Manager', backend: 'openai' }],
    send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
    state: { get: () => undefined, update: async () => {} },
    getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
  } as never) as any).getHtml({ cspSource: 'test:' });
  const candidate = (handle: string, agent: string, phase: PmQuietCandidate['phase'], tool?: string): PmQuietCandidate => ({
    handle, agent, task: `${agent}'s task`, phase, ...(tool ? { tool } : {}), quietSince: new Date(T0 - 3 * MIN).toISOString(),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
  });
  afterEach(() => vi.useRealTimers());

  it('has no live ancestor: the wrapper has no role or aria-live, and its two regions are siblings', () => {
    const markup = /<div class="pm-live" id="pmLive"([^>]*)><div id="pmLiveLines"([^>]*)><\/div><div id="pmLiveQuiet"([^>]*)><\/div><\/div>/.exec(html());
    expect(markup).not.toBeNull();
    expect(markup![1]).not.toMatch(/role=|aria-live=/);
    expect(markup![2]).toMatch(/role="status" aria-live="polite"/);
    expect(markup![3]).toMatch(/role="status" aria-live="polite"/);
  });

  it('two ticks and an unchanged refresh rebuild the lines and leave the quiet text alone; a new teammate or context replaces it once', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'Project Manager', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('pm');
    const base = (provider as any).currentState();
    const page = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }), { mutations: true });
    const lines = page.elements.get('pmLiveLines') as any;
    const quiet = page.elements.get('pmLiveQuiet') as any;
    const show = (teammates: PmQuietCandidate[]) => page.listeners.message?.[0]?.({ data: { command: 'state', state: { ...base, messages: [], pmLive: { lines: [
      { kind: 'running', tasks: [{ agent: 'Dev', since: new Date(T0 - 10 * MIN).toISOString() }, { agent: 'QA', since: new Date(T0 - 10 * MIN).toISOString() }] },
      { kind: 'promise', text: 'The PM reports here when results come back.' },
      ...(teammates.length ? [{ kind: 'quiet', teammates }] : []),
    ] } } } });
    const inQuiet = (from: number) => page.mutations.slice(from).filter((record) => page.observedUnder(record, quiet));
    const replacements = (from: number) => inQuiet(from).filter((record) => record.type === 'childList');

    show([candidate('h-dev', 'Dev', 'tool', 'npm test')]);
    expect(spoken(quiet)).toBe('No activity: Dev, running npm test Ask the PM');
    expect(seen(quiet)).toBe('No activity: Dev (3 min, running npm test)');

    // Two ticks and an unchanged refresh.
    let from = page.mutations.length;
    vi.advanceTimersByTime(30_000);
    show([candidate('h-dev', 'Dev', 'tool', 'npm test')]);
    vi.advanceTimersByTime(30_000);
    expect(page.mutations.slice(from).filter((record) => record.target === lines && record.type === 'childList')).toHaveLength(3);
    expect(inQuiet(from).filter((record) => record.type !== 'characterData')).toEqual([]);
    expect(inQuiet(from).every((record) => record.ancestors.some((node: any) => node?.getAttribute?.('aria-hidden') === 'true'))).toBe(true);
    expect(inQuiet(from)).toHaveLength(1);
    expect(spoken(quiet)).toBe('No activity: Dev, running npm test Ask the PM');
    expect(seen(quiet)).toBe('No activity: Dev (4 min, running npm test)');

    // A teammate joins the silent set: one replacement.
    from = page.mutations.length;
    show([candidate('h-dev', 'Dev', 'tool', 'npm test'), candidate('h-qa', 'QA', 'provider-wait')]);
    expect(replacements(from)).toHaveLength(1);
    expect(replacements(from)[0].target).toBe(quiet);
    expect(spoken(quiet)).toBe('No activity: Dev, running npm test; QA, waiting on the model provider Ask the PM');
    expect(seen(quiet)).toBe('No activity: Dev (4 min, running npm test), QA (4 min, waiting on the model provider)');

    // Dev's context changes from the tool to the provider: one replacement.
    from = page.mutations.length;
    show([candidate('h-dev', 'Dev', 'provider-wait'), candidate('h-qa', 'QA', 'provider-wait')]);
    expect(replacements(from)).toHaveLength(1);
    expect(spoken(quiet)).toBe('No activity: Dev, waiting on the model provider; QA, waiting on the model provider Ask the PM');

    // Nobody is silent: the region is emptied.
    from = page.mutations.length;
    show([]);
    expect(replacements(from)).toHaveLength(1);
    expect(quiet.children).toHaveLength(0);
    expect(quiet.hidden).toBe(true);
  });

  it('a candidate with a time that does not parse is never shown', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'Project Manager', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('pm');
    const page = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }), { mutations: true });
    page.listeners.message?.[0]?.({ data: { command: 'state', state: { ...(provider as any).currentState(), messages: [], pmLive: { lines: [
      { kind: 'running', tasks: [{ agent: 'Dev' }] },
      { kind: 'quiet', teammates: [{ ...candidate('h-dev', 'Dev', 'provider-wait'), quietSince: 'not a time' }, { ...candidate('h-qa', 'QA', 'provider-wait'), quietSince: undefined }] },
    ] } } } });
    vi.advanceTimersByTime(10 * MIN);
    expect((page.elements.get('pmLiveQuiet') as any).children).toHaveLength(0);
  });
});

/* v0.9.103 (slice 3 §3): in the page, an update has no button; an overflow with no reminder hidden has only Show all. */
describe('informational items in the emitted page (slice 3 §3)', () => {
  it('draws an update as text only, and an overflow of updates with Show all and no Ask the PM about all', () => {
    const provider = new ChatViewProvider({} as never, {
      listAgents: () => [{ id: 'pm', name: 'Project Manager', role: 'Project Manager', backend: 'openai' }],
      send() {}, interject() {}, interrupt() {}, onReply: () => ({ dispose() {} }),
      state: { get: () => undefined, update: async () => {} },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval() {},
    } as never);
    provider.selectAgent('pm');
    const page = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }));
    page.listeners.message?.[0]?.({ data: { command: 'state', state: { ...(provider as any).currentState(), messages: [], pmLive: { lines: [
      { kind: 'reminder', text: 'Reminder 1.', prompt: 'Please look at task 1' },
      { kind: 'info', text: 'Dev and the PM have exchanged 3 questions on this task.' },
      { kind: 'more', text: '1 more update.', items: [{ label: 'Task u2', detail: 'update 2' }] },
    ] } } } });
    const rows = (page.elements.get('pmLiveLines') as any).children;
    const buttons = (row: any) => row.children.filter((child: any) => child.type === 'button').map((button: any) => button.textContent);
    expect(rows.map(buttons)).toEqual([['Ask the PM'], [], ['Show all']]);
    expect(rows[1].children[0].textContent).toBe('Dev and the PM have exchanged 3 questions on this task.');
  });
});
