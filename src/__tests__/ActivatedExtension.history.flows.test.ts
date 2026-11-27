import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * v0.9.102 (the Owner, 2026-11-12): the extension's real entry. `activate()` runs with only the VS Code API and the
 * model's HTTP endpoint stood in; everything between (the session manager, the team tools, the ledger, the access
 * table, the chat and its page) is what activation itself builds and connects. A person's message is typed into the
 * chat page and sent with its Send button; the agents are OpenAI-compatible, and their model is a script that answers
 * each request the way a model would, by agent, with tool calls or text.
 * Not a native VS Code host: no window, no real webview, no network.
 *
 * v0.9.103: the flows of a long history (6.1 one request, one result; 6.2 a long chat across every window and a
 * reload), apart from ActivatedExtension.flows.test.ts so that each file runs within its time.
 */
const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());

vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));
// v0.9.105 S8: the stub editor runs no language server, so the 800 ms wait after each write for its errors only
// slowed every write here. The post-write diagnostics path itself still runs.
vi.mock('../host/postWriteDiagnosticsSettle', () => ({ POST_WRITE_DIAGNOSTICS_SETTLE_MS: 0 }));

import type { AgentConfig } from '../types';
import { PersistenceManager } from '../state/PersistenceManager';
import { RootScopedWorkspaceState } from '../state/RootScopedWorkspaceState';
import { RunLedger } from '../observability/RunLedger';
import { pmLiveRelevant, pmLiveStrip } from '../session/PmLiveStrip';
import { AgentConfigBuilder } from '../roles/RoleConfig';
import { bootWebviewScript, type WebviewBootResult } from '../views/__tests__/support/webviewBoot';
import { MessageBus } from '../bus/MessageBus';
import type { Message } from '../types';
import { OpenAICompatBackend } from '../backend/OpenAICompatBackend';
import { TaskInputResolver } from '../backend/TaskContract';
import { FileSpendLedger } from '../state/SpendStore';
import { SpendHost } from '../host/SpendHost';

import {
  endFakeTimers, flush, memento, scripts, requests, textOf, latestUser, lastToolResult, chatScreen, base, workspace, sibling, elsewhere, context, agent, reloadedStrip, readReloadedStrip, storedDelegations, storedDelegationIn, replies, installActivatedExtension, type ModelRequest, type ModelAnswer, pumpWhile, storedStateQuiet,
} from './support/activatedHarness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let screen: ReturnType<typeof chatScreen>;
let chatProvider: any;
installActivatedExtension(host, (ready) => { chatProvider = ready.chatProvider; screen = ready.screen; });

/*
 * v0.9.103 item 6.2 (transcript integrity and reload): one long PM chat through activate(), whose requests are chosen to
 * cross every stored window of the chat, then a reply seen while it streams, then a delegation whose stage and result
 * arrive after the windows were crossed. What the page renders is read back row by row, then the window "reloads": a new
 * chat view over the same stored state, its page booted from the HTML it serves.
 */
describe('v0.9.103 6.2 the extension through activate(): a long chat crosses every window and reloads the same', () => {
  /** The windows of one chat, as the code has them (verified in chatHistory.ts, chatToolHistory.ts, ChatViewProvider.ts,
   * orchestrationProgress.ts, JobOutcomeAnchor.ts and RequestCloseoutStore.ts). */
  const WINDOWS = { messages: 50, tools: 60, reasoning: 40, delegationSummaries: 12, anchors: 50, closeoutRecords: 100, contextCards: 50 };
  /**
   * 104 requests; every seventh (3, 10, ..., 101) is delegated to Dev, the others are answered after one tool call. Before
   * request 75, one more is delegated to a slow Writer that stays running until the end: fewer than 12 delegations follow
   * it, so its card stays within the delegation window while its messages leave the chat.
   */
  const REQUESTS = 104;
  const SLOW_BEFORE = 75;
  /** The one line at the top of a chat whose oldest messages were dropped (the Owner's "One line + tidy top"). */
  const TOP_LINE = '[history-trimmed] Older messages are not shown here. UnodeAi: Export Messages saves the team\'s most recent messages.';
  const delegated = (k: number) => k % 7 === 3;

  /** The rows of the transcript the page rendered, in order: the class and id each has, then every word it shows. */
  const rowsOf = (page: WebviewBootResult): string[] => {
    const top = ((page.elements.get('transcript') as any).children ?? []) as any[];
    const flat = (node: any): string => [typeof node?.data === 'string' ? node.data : node?.textContent,
      ...(Array.isArray(node?.children) ? node.children.map(flat) : [])].filter(Boolean).join(' ');
    // v0.9.110: a request whose file changes can be put back gets Revert buttons when its recovery marks arrive, which
    // is asynchronous. The rows are compared without them, so a mark landing before or after a read changes nothing.
    return top.flatMap((node) => (node.nodeType === 11 ? node.children : [node]))
      .map((node: any) => `[${node.className}${node.id ? '#' + node.id : ''}] ${flat(node)}`
        .replace(/ Revert to (?:here|before this request)…/g, ''));
  };
  /** The one row that is a user message saying exactly `text`. */
  const userRow = (rows: string[], text: string) => {
    const found = rows.flatMap((row, index) => (row === `[msg user] ${text}` ? [index] : []));
    expect(found, `one user row says ${text}`).toHaveLength(1);
    return found[0];
  };
  /** The one row that is the agent's reply saying `text`. */
  const replyRow = (rows: string[], text: string) => {
    const found = rows.flatMap((row, index) => (row.startsWith('[msg agent') && row.includes(` ${text} `) ? [index] : []));
    expect(found, `one reply row says ${text}`).toHaveLength(1);
    return found[0];
  };
  const contractFor = (file: string) => ({
    version: 2, objective: `Write ${file}.`, expected_deliverable: file,
    effects: { read_files: [], expected_file_effect: 'create' }, inputs: [],
    outputs: [{ output_id: 'out', path: path.join(workspace, file), kind: 'file', required: true }],
    constraints: [], dependencies: [], required_capabilities: { version: 1, capabilities: ['write'] },
    execution_strategy: 'delegate-required' });

  it('every window is crossed, the rows keep their order with no duplicate, a streamed reply and a late delegation update in place, trims are explained, their evidence is reachable, and a reload renders the same rows', async () => {
    const counts = { userMessages: 0, pmToolCalls: 0, reasoning: 0, dispatches: 0 };
    const handles = new Map<string, string>();
    let releaseSlow!: () => void; const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let releaseLive!: () => void; const live = new Promise<void>((resolve) => { releaseLive = resolve; });
    let releaseStage!: () => void; const stage = new Promise<void>((resolve) => { releaseStage = resolve; });
    let releaseResult!: () => void; const result = new Promise<void>((resolve) => { releaseResult = resolve; });
    const spend = context.subscriptions.find(entry => entry instanceof SpendHost) as SpendHost;
    expect(spend).toBeDefined();
    let holdReceipt = false; let receiptHeld = false; let releaseReceipt!: () => void;
    const receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve; });
    const append = FileSpendLedger.prototype.append;
    const receiptWrite = vi.spyOn(FileSpendLedger.prototype, 'append').mockImplementation(async function (this: FileSpendLedger, payload, eventId) {
      if (holdReceipt && payload.kind === 'usage-receipt' && payload.receipt.agentId === 'pm') {
        receiptHeld = true; await receiptGate;
      }
      return append.call(this, payload, eventId);
    });
    scripts.set('pm-model', (request) => {
      const tool = lastToolResult(request);
      const user = latestUser(request);
      if (user.includes('Async delegation result')) {
        const of = /T(\w+)\.txt/.exec(user)?.[1] ?? '';
        if (!tool) { counts.pmToolCalls++; return { calls: [{ name: 'record_task_disposition', args: { handle: handles.get(of), disposition: 'accepted' } }] }; }
        return { text: `Delivered ${of}.` };
      }
      if (user.includes('Qlive')) { counts.reasoning++; return { reasoning: 'Thinking live.', text: 'Live reply starts here and it ends here.', hold: live }; }
      const k = /^Q(\w+)/.exec(user.trim())?.[1] ?? '';
      const delegates = k === 'final' || k === 'slow' || delegated(Number(k));
      if (tool) {
        if (!delegates) return { text: `Reply ${k}.` };
        handles.set(k, /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? '');
        return { text: `Dispatched ${k}.` };
      }
      counts.reasoning++; counts.pmToolCalls++;
      if (!delegates) return { reasoning: `Thinking about ${k}.`, calls: [{ name: 'list_dir', args: { path: '.' } }] };
      counts.dispatches++;
      return { reasoning: `Thinking about ${k}.`, calls: [{ name: 'dispatch_task', args: { agent: k === 'slow' ? 'writer' : 'dev',
        instruction: `Write T${k}.txt.`, contract: contractFor(`T${k}.txt`) } }] };
    });
    let devFile = '';
    let finalCalls = 0;
    scripts.set('dev-model', async (request) => {
      if (!lastToolResult(request)) devFile = /Write (T\w+\.txt)/.exec(latestUser(request))?.[1] ?? '';
      if (devFile === 'Tfinal.txt') {
        // The late delegation: a first step only once the windows are crossed, its result later still.
        finalCalls++;
        if (finalCalls === 1) { await stage; return { calls: [{ name: 'list_dir', args: { path: '.' } }] }; }
        if (finalCalls === 2) { await result; return { calls: [{ name: 'write_file', args: { path: devFile, content: 'final' } }] }; }
        return { text: `Saved ${devFile}.` };
      }
      if (lastToolResult(request)) return { text: `Saved ${devFile}.` };
      return { calls: [{ name: 'write_file', args: { path: devFile, content: devFile } }] };
    });
    // The slow teammate: it writes its file only at the end.
    scripts.set('writer-model', async (request) => {
      if (lastToolResult(request)) return { text: 'Saved Tslow.txt.' };
      await slow;
      return { calls: [{ name: 'write_file', args: { path: 'Tslow.txt', content: 'slow' } }] };
    });
    const s = chatScreen(chatProvider, { readable: true });
    try {
      await s.select('pm');
      const pumpUntil = async (done: () => boolean) => { await pumpWhile(() => !done(), s.pump); };
      expect(chatProvider.loadHistory('pm'), 'this chat starts empty').toEqual([]);
      let lineFrom = -1;
      for (let k = 0; k < REQUESTS; k++) {
        if (k === SLOW_BEFORE) {
          await s.send('Qslow');
          counts.userMessages++;
          await pumpUntil(() => replies('pm').includes('Dispatched slow.'));
          expect(replies('pm')).toContain('Dispatched slow.');
        }
        await s.send(`Q${k}`);
        counts.userMessages++;
        const last = delegated(k) ? `Delivered ${k}.` : `Reply ${k}.`;
        await pumpUntil(() => replies('pm').includes(last));
        expect(replies('pm'), `request ${k}`).toContain(last);
        // The top line is there exactly when the chat no longer keeps its first message (Q0), and it reads so; before
        // that, no line.
        const top = rowsOf(s.page())[0];
        const dropped = (chatProvider.loadHistory('pm') as Array<{ text: string }>)[0].text !== 'Q0';
        expect(top === TOP_LINE, `request ${k}: ${top?.slice(0, 80)}`).toBe(dropped);
        if (dropped && lineFrom < 0) lineFrom = k;
      }
      // The line came only once messages were dropped, well after the first requests.
      expect(lineFrom).toBeGreaterThan(10);

      // A reply seen while it streams: the live row, then the finished reply in its place.
      await s.send('Qlive');
      counts.userMessages++;
      await pumpUntil(() => rowsOf(s.page()).some((row) => row.includes('Live reply starts he')));
      const held = rowsOf(s.page());
      const liveAt = held.findIndex((row) => row.startsWith('[msg agent#live-message]'));
      expect(held.filter((row) => row.includes('Live reply starts')), JSON.stringify(held.slice(-5))).toEqual([held[liveAt]]);
      expect(held[liveAt]).toBe('[msg agent#live-message] Live reply starts he');
      expect(held[liveAt - 1]).toBe('[reasoning#live-reasoning] Analyzing Thinking live.');
      expect(userRow(held, 'Qlive')).toBeLessThan(liveAt);
      const sensorBefore = s.page().postedMessages.length;
      releaseLive();
      await pumpUntil(() => replies('pm').includes('Live reply starts here and it ends here.'));
      for (let i = 0; i < 5; i++) await s.pump();
      const finished = rowsOf(s.page());
      const finalAt = replyRow(finished, 'Live reply starts here and it ends here.');
      expect(finished.filter((row) => row.includes('Live reply starts'))).toEqual([finished[finalAt]]);
      expect(finished[finalAt]).toMatch(/^\[msg agent conclusion\] /);
      expect(finished[finalAt - 1]).toBe('[reasoning] Analysis Thinking live.');
      expect(finished[finalAt - 2]).toMatch(/^\[context-manifest\] /);
      expect(finished[finalAt - 3]).toBe('[msg user] Qlive');
      expect(finished.some((row) => row.includes('#live-'))).toBe(false);
      // The streamed rows became the finished ones: nothing of this turn was reported missing.
      expect(s.page().postedMessages.slice(sensorBefore).filter((m: any) => m.command === 'renderedTranscriptItemsMissing'
        && m.cause !== 'window-trim')).toEqual([]);

      // The late delegation: dispatched now, its stage and its result arrive after every window above was crossed.
      await s.send('Qfinal');
      counts.userMessages++;
      await pumpUntil(() => replies('pm').includes('Dispatched final.'));
      for (let i = 0; i < 5; i++) await s.pump();
      const cardOf = (rows: string[]) => {
        const at = replyRow(rows, 'Dispatched final.') - 1;
        expect(rows[at], JSON.stringify(rows.slice(-8))).toMatch(/^\[delegation-card\] /);
        // Right after the PM's dispatch of this task, right before its reply: the place it was given, and one card.
        expect(rows[at - 1]).toMatch(/^\[tool-card tool\] Tool dispatch_task .*Write Tfinal\.txt\./s);
        expect(rows.slice(userRow(rows, 'Qfinal')).filter((row) => row.startsWith('[delegation-card]'))).toHaveLength(1);
        return { at, text: rows[at] };
      };
      const assigned = cardOf(rowsOf(s.page()));
      expect(assigned.text).toContain('PM delegating to the crew 0 complete');
      expect(assigned.text).toContain('step 1');
      expect(assigned.text).toContain('Write Tfinal.txt.');
      releaseStage();
      await pumpUntil(() => cardOf(rowsOf(s.page())).text.includes('step 2'));
      const staged = cardOf(rowsOf(s.page()));
      expect(staged.at).toBe(assigned.at);
      expect(staged.text).toContain('step 2');
      // A reply can precede its durable spend receipt. Hold the actual write, as on a slow full-suite disk.
      await spend.coordinator.drained(); holdReceipt = true;
      releaseResult();
      await pumpUntil(() => replies('pm').includes('Delivered final.'));
      for (let i = 0; i < 10; i++) await s.pump();

      // The tidy top. The line is first and the Earlier results entry second; then the chat starts at its oldest kept
      // message. The one row above that message is the slow task's card: its request's messages left the chat long ago,
      // and it is still running.
      const firstMessageOf = (rows: string[]) => rows.findIndex((row) => row.startsWith('[msg '));
      const running = rowsOf(s.page());
      expect(running[0]).toBe(TOP_LINE);
      expect(running[1]).toMatch(/^\[earlier-results\] Earlier results /);
      expect(running).not.toContain('[msg user] Qslow');
      const aboveRunning = running.slice(2, firstMessageOf(running));
      expect(aboveRunning, JSON.stringify(aboveRunning.map((row) => row.slice(0, 80)))).toHaveLength(1);
      expect(aboveRunning[0]).toMatch(/^\[delegation-card\] PM delegating to the crew .*Write Tslow\.txt\./);
      // The slow task ends: its result wakes the PM, which reports. Its card is now finished work from before the oldest
      // kept message, and the chat starts at that message.
      releaseSlow();
      await pumpUntil(() => replies('pm').includes('Delivered slow.'));
      for (let i = 0; i < 10; i++) await s.pump();
      expect(fs.readFileSync(path.join(workspace, 'Tslow.txt'), 'utf8')).toBe('slow');
      const liveRows = rowsOf(s.page());
      await pumpUntil(() => receiptHeld);
      expect(liveRows.join('\n')).toMatch(/usage partial/i);
      expect(liveRows[0]).toBe(TOP_LINE);
      expect(liveRows[1]).toMatch(/^\[earlier-results\] /);
      expect(firstMessageOf(liveRows), JSON.stringify(liveRows.slice(0, 4).map((row) => row.slice(0, 80)))).toBe(2);
      expect(liveRows.filter((row) => row === TOP_LINE)).toHaveLength(1);
      const settled = cardOf(liveRows);
      // The page lost its oldest rows to the new ones of the wake turn, so the card moved up by as many; it is still
      // the same card, in the same place among its neighbours, now with its result.
      expect(settled.text).toContain('PM delegated to the crew 1 complete');
      expect(settled.text).toContain('Coordinator accepted');
      expect(fs.readFileSync(path.join(workspace, 'Tfinal.txt'), 'utf8')).toBe('final');

      // Every window was crossed by this flow (counts recorded here), and each stored stream holds exactly its window.
      const state = new RootScopedWorkspaceState(context.workspaceState as never, workspace);
      expect((chatProvider.loadHistory('pm') as unknown[]).length).toBe(WINDOWS.messages);
      expect(counts).toEqual({ userMessages: 107, pmToolCalls: 89 + 16 + 16 + 2, reasoning: 107, dispatches: 17 });
      expect(counts.userMessages * 2).toBeGreaterThan(WINDOWS.messages);
      expect(counts.pmToolCalls).toBeGreaterThan(WINDOWS.tools);
      expect(counts.reasoning).toBeGreaterThan(WINDOWS.reasoning);
      expect(counts.dispatches).toBeGreaterThan(WINDOWS.delegationSummaries);
      expect(counts.userMessages).toBeGreaterThan(WINDOWS.contextCards);
      expect(state.get<unknown[]>('roam.chat.pm')).toHaveLength(WINDOWS.messages);
      expect(state.get<unknown[]>('roam.chat.tools.pm')).toHaveLength(WINDOWS.tools);
      expect(state.get<unknown[]>('roam.chat.reasoning.pm')).toHaveLength(WINDOWS.reasoning);
      expect(state.get<unknown[]>('roam.chat.contextManifests.pm')).toHaveLength(WINDOWS.contextCards);
      // The page is sent the delegation window, 12 cards; those of finished work from before the oldest kept message
      // are not shown, and are still sent (so their leaving is not taken for a loss), stored and recorded.
      const sent = chatProvider.currentState().messages as Array<{ kind: string; beforeOldest?: true; id: string; items?: Array<{ instruction?: string }> }>;
      expect(sent.filter((row) => row.kind === 'delegation')).toHaveLength(WINDOWS.delegationSummaries);
      const hiddenCards = sent.filter((row) => row.kind === 'delegation' && row.beforeOldest);
      expect(hiddenCards.length).toBeGreaterThan(0);
      expect(liveRows.filter((row) => row.startsWith('[delegation-card]'))).toHaveLength(WINDOWS.delegationSummaries - hiddenCards.length);
      const hiddenTools = sent.filter((row) => row.kind === 'tool' && row.beforeOldest);
      expect(hiddenTools.length).toBeGreaterThan(0);
      const storedTools = state.get<Array<{ id: string }>>('roam.chat.tools.pm')!;
      for (const tool of hiddenTools) expect(storedTools.some((stored) => stored.id === tool.id)).toBe(true);
      expect(sent.filter((row) => row.beforeOldest).every((row) => sent.indexOf(row) < sent.findIndex((item) => item.kind === 'message'))).toBe(true);
      // Request closeouts: one per ended PM turn (104 + 15 wakes + the streamed reply + the final dispatch and wake), so
      // the store is past its 100; the records kept are the newest, and every turn the chat still shows has its record.
      const records = chatProvider.deps.requestCloseouts('pm') as Array<{ terminalTurnId: string }>;
      expect(records).toHaveLength(WINDOWS.closeoutRecords);
      const shownTurns = [...chatProvider.retainedTurnIds('pm')] as string[];
      expect(shownTurns.length).toBeGreaterThan(0);
      for (const turn of shownTurns) expect(records.some((record) => record.terminalTurnId === turn), turn).toBe(true);
      // Job outcome anchors: one per closed run, 16, under their window of 50 (not crossed: 51 delegations cost too much).
      expect((state.get<unknown[]>('roam.chat.jobOutcomes.pm') ?? []).length).toBeLessThan(WINDOWS.anchors);

      // Order and duplicates: every request still shown reads question, then its work, then its reply, in request order,
      // each once; a finished reply has its card after it.
      const shown = [...Array(REQUESTS).keys()].filter((k) => liveRows.includes(`[msg user] Q${k}`));
      expect(shown.length).toBeGreaterThan(10);
      expect(shown).toEqual([...Array(shown.length).keys()].map((i) => shown[0] + i));
      let previous = -1;
      let thinking = 0;
      for (const k of shown) {
        const asked = userRow(liveRows, `Q${k}`);
        const answered = replyRow(liveRows, delegated(k) ? `Dispatched ${k}.` : `Reply ${k}.`);
        expect(asked).toBeGreaterThan(previous);
        expect(answered).toBeGreaterThan(asked);
        // Its reasoning, while the reasoning window still holds it, sits between the question and the reply.
        const thought = liveRows.indexOf(`[reasoning] Analysis Thinking about ${k}.`);
        if (thought >= 0) { thinking++; expect(thought).toBeGreaterThan(asked); expect(thought).toBeLessThan(answered); }
        if (delegated(k)) {
          // v0.9.103 (6.1, one request, one result): the request has one card. The dispatching reply has none of its own;
          // the request's Job outcome follows its result, with the dispatching turn's report in its details.
          expect(liveRows[answered + 1]).not.toMatch(/^\[job-outcome/);
          const delivered = replyRow(liveRows, `Delivered ${k}.`);
          expect(liveRows[delivered + 1]).toMatch(/^\[job-outcome\] Job outcome .*Latest of 2 reports/);
          previous = delivered;
        } else {
          expect(liveRows[answered + 1]).toMatch(/^\[job-outcome request-summary\] Request summary /);
          previous = answered;
        }
      }
      expect(thinking).toBeGreaterThan(10);
      const messageRows = liveRows.filter((row) => row.startsWith('[msg '));
      expect(new Set(messageRows).size).toBe(messageRows.length);

      // Trims are explained: every row that left the page left with its stream's window (a Request summary with the
      // reply it follows), or was a Request summary replaced as designed by its run's Job outcome, which the host
      // accepts. The host recorded no lost row.
      const missing = s.page().postedMessages.filter((m: any) => m.command === 'renderedTranscriptItemsMissing') as any[];
      expect(missing.filter((m) => m.cause === 'window-trim').length).toBeGreaterThan(REQUESTS);
      for (const m of missing.filter((m) => m.cause !== 'window-trim')) {
        expect(m.missing.map((item: { id: string }) => item.id.split(':')[0]), JSON.stringify(m.missing)).toEqual(['summary']);
      }
      expect(chatProvider.renderedTranscriptDisappearances).toEqual([]);
      expect(chatProvider.renderedTranscriptWindowTrimObservations).toBeGreaterThan(REQUESTS);

      // Their evidence is reachable. Request 0 and the first delegated request left the chat with every row of theirs.
      for (const gone of ['[msg user] Q0', '[msg user] Q3']) expect(liveRows).not.toContain(gone);
      expect(liveRows.some((row) => row.includes(' Reply 0. ') || row.includes(' Delivered 3. '))).toBe(false);
      // Export > Evidence report still offers the first delegated request's run, and its report names its work; so it
      // does for the slow task, whose card the page no longer shows.
      expect(hiddenCards.some((card) => card.items?.some((task) => task.instruction === 'Write Tslow.txt.'))).toBe(true);
      const picked: Array<{ detail?: string }> = [];
      const opened: string[] = [];
      let wanted = 'Q3';
      host.overrides['vscode.window.showQuickPick'] = async (items: Array<{ detail?: string }>) => {
        picked.push(...items);
        return items.find((item) => item.detail === wanted);
      };
      host.overrides['vscode.window.showSaveDialog'] = async () => undefined;
      host.overrides['vscode.workspace.openTextDocument'] = async (document: { content?: string }) => { opened.push(String(document?.content)); return {}; };
      try {
        await host.commands.get('unode.generateEvidenceReport')!();
        expect(picked.filter((item) => item.detail === 'Q3')).toHaveLength(1);
        expect(opened).toHaveLength(1);
        expect(opened[0]).toContain('- Completion: **Complete**');
        expect(opened[0]).toContain('- `T3.txt`');
        wanted = 'Qslow';
        await host.commands.get('unode.generateEvidenceReport')!();
        expect(opened).toHaveLength(2);
        expect(opened[1]).toContain('- Completion: **Complete**');
        expect(opened[1]).toContain('- `Tslow.txt`');
        // Export > Message log reaches further back than the chat: it holds requests the chat no longer shows, each with its
        // reply, and says how many older items its own window of 300 dropped.
        const exported = path.join(base, 'long-chat-messages.json');
        host.overrides['vscode.window.showSaveDialog'] = async () => ({ fsPath: exported });
        await host.commands.get('unode.exportMessages')!();
        const log = JSON.parse(fs.readFileSync(exported, 'utf8')) as {
          messages: Array<{ content: string }>; truncation?: { occurred: boolean; droppedItems: number; limit: number } };
        const logged = log.messages.flatMap((message) => { const k = /^Q(\d+)\n/.exec(message.content)?.[1]; return k ? [Number(k)] : []; });
        const oldestLogged = Math.min(...logged);
        expect(oldestLogged, JSON.stringify(log.truncation)).toBeLessThan(shown[0]);
        expect(liveRows).not.toContain(`[msg user] Q${oldestLogged}`);
        expect(log.messages.some((message) => message.content.startsWith(`${delegated(oldestLogged) ? 'Dispatched' : 'Reply'} ${oldestLogged}.\n`))).toBe(true);
        expect(log.truncation).toMatchObject({ occurred: true, limit: 300 });
        expect(log.truncation!.droppedItems).toBeGreaterThan(0);
      } finally {
        for (const key of ['vscode.window.showQuickPick', 'vscode.window.showSaveDialog', 'vscode.workspace.openTextDocument']) delete host.overrides[key];
      }

      // Reload: a new chat view over the same stored state, with the request records, the runs and the delegation cards
      // read back from that state by the production loaders, as activation reads them. The page is booted from the HTML
      // it serves. It renders the same rows, in the same order.
      // The runs are saved 750 ms after a change, and the request records on their own write chain. v0.9.105 (CI
      // 44007091429): not one fixed second, which a loaded runner can outrun, but until the stored state is quiet.
      // Capture the reload comparison only after durable facts, not the earlier reply-time snapshot.
      holdReceipt = false; releaseReceipt(); await spend.coordinator.drained();
      await storedStateQuiet();
      const { SessionPresentationModel } = await import('../views/sessionPresentation');
      const { ChatViewProvider } = await import('../views/ChatViewProvider');
      const { RequestCloseoutStore } = await import('../observability/RequestCloseoutStore');
      const { OrchestrationProgressTracker } = await import('../views/orchestrationProgress');
      const reloadedState = new RootScopedWorkspaceState(context.workspaceState as never, workspace);
      let reloaded: InstanceType<typeof ChatViewProvider>;
      const closeouts = new RequestCloseoutStore(reloadedState as never, { retainedTurnIds: (agentId: string) => reloaded.retainedTurnIds(agentId) });
      reloaded = new ChatViewProvider(context.extensionUri as never, {
        ...chatProvider.deps, presentation: new SessionPresentationModel(), onReply: () => () => {},
        requestCloseouts: (agentId: string) => closeouts.list(agentId),
      });
      const hostId = { hostInstanceId: 'activated-flows-window', epoch: `reloaded-${Date.now()}` };
      const ledger = new RunLedger(await new PersistenceManager(context as never, undefined, () => workspace, hostId, undefined, reloadedState).loadRuns(), { host: hostId });
      ledger.reconcileRestoredActiveDelegations();
      const tracker = new OrchestrationProgressTracker((id: string) => ({ dev: 'Dev', pm: 'PM', writer: 'Writer' } as Record<string, string>)[id] ?? id);
      tracker.hydrate(ledger.snapshot());
      tracker.applyRunCloseouts(ledger.closedRunCloseouts());
      reloaded.setDelegationProgress(tracker.snapshot());
      const after = chatScreen(reloaded as never, { readable: true });
      await after.pump();
      const reloadedRows = rowsOf(after.page());
      // Wait for the existing spend/card refresh to reach the page. A missed refresh or lost row still fails.
      await pumpUntil(() => JSON.stringify(rowsOf(s.page())) === JSON.stringify(reloadedRows)).catch(error => {
        const current = rowsOf(s.page());
        const differences = reloadedRows.flatMap((after, index) => after === current[index] ? []
          : [{ index, early: liveRows[index], before: current[index], after }]);
        throw new Error(`${String(error)}\nReload differences: ${JSON.stringify(differences)}`);
      });
      const liveNow = rowsOf(s.page());
      expect(liveNow.filter(row => row.startsWith('[msg '))).toEqual(messageRows);
      expect(liveNow).not.toEqual(liveRows); // The original early-copy comparison is deterministically stale.
      expect(reloadedRows.length).toBe(liveNow.length);
      for (let i = 0; i < liveNow.length; i++) expect(reloadedRows[i], `row ${i}: ${JSON.stringify({ early: liveRows[i], before: liveNow[i], after: reloadedRows[i] })}`).toBe(liveNow[i]);
      expect(after.page().postedMessages.filter((m: any) => m.command === 'renderedTranscriptItemsMissing')).toEqual([]);
      reloaded.dispose();
    } finally {
      holdReceipt = false; releaseReceipt(); await spend.coordinator.drained(); receiptWrite.mockRestore();
      // The tests after this one use the file's own screen again.
      screen = chatScreen(chatProvider);
      await screen.pump();
    }
  }, 300_000);
});

/*
 * v0.9.103 item 6.1 (one request, one result; Codex plan review §2 item 1 and §5 "Result projection"): through activate()
 * and the page the chat serves. Two requests of the PM overlap: A delegates to a slow Dev, B is answered by the PM
 * itself, and A's result lands after B's. Each request has one card; A's card shows its current result and holds its
 * earlier report in its details; each card has at most one main button; B's file opens through the host's registered
 * handler. Then A's replies leave the 50 messages the chat keeps, and A's card stays reachable at the top of the chat,
 * saying why its reply is not shown.
 * Not proven here (native only): the disclosure's layout and focus, the diff and evidence editors, two windows.
 */
describe('v0.9.103 6.1 the extension through activate(): one request, one result', () => {
  const descendants = (node: any): any[] => (Array.isArray(node?.children) ? node.children : []).flatMap((child: any) => [child, ...descendants(child)]);
  const text = (node: any): string => [node?.textContent, ...(Array.isArray(node?.children) ? node.children.map(text) : [])].filter(Boolean).join(' ');
  const classed = (node: any, name: string) => String(node?.className ?? '').split(' ').includes(name);
  /** The host-observed cards on the page, in transcript order: each card's node, its words and its buttons. */
  const topLevel = (node: any): any[] => (Array.isArray(node?.children) ? node.children : [])
    .flatMap((child: any) => (classed(child, 'job-outcome') || classed(child, 'earlier-results') ? [child] : topLevel(child)));
  const shownCards = () => topLevel(screen.page().elements.get('transcript'))
    .filter((node: any) => classed(node, 'job-outcome'))
    .map((node: any) => ({ node, words: text(node), buttons: descendants(node).filter((child: any) => child.type === 'button') }));
  const items = (): any[] => chatProvider.currentState().messages;
  const cardAfter = (reply: string) => {
    const list = items();
    const at = list.findIndex((item) => item.kind === 'message' && item.role === 'agent' && String(item.text).startsWith(reply));
    if (at < 0) return undefined;
    const next = list.slice(at + 1).findIndex((item) => item.kind === 'message');
    return list.slice(at + 1, next < 0 ? undefined : at + 1 + next).find((item) => item.kind === 'requestSummary' || item.kind === 'jobOutcome');
  };
  const replied = (reply: string) => replies('pm').some((text) => text.startsWith(reply));

  it('A delegates to a slow Dev, B is answered directly, A\'s result lands after B: one card each, its result current and its earlier report in details, one main button, the file opens, and A stays reachable after its reply leaves the chat', async () => {
    const opened: string[] = [];
    host.overrides['vscode.workspace.openTextDocument'] = async (uri: { fsPath: string }) => { opened.push(uri.fsPath); return { uri }; };
    host.overrides['vscode.window.showTextDocument'] = async () => ({});
    let release!: () => void;
    const devMayAnswer = new Promise<void>((resolve) => { release = resolve; });
    let handle = '';
    scripts.set('pm-model', (request) => {
      const said = latestUser(request);
      const tool = lastToolResult(request);
      if (said.startsWith('Filler')) return { text: `Noted: ${said}` };
      if (said.includes('today.txt')) {
        return tool ? { text: 'today.txt holds the date.' } : { calls: [{ name: 'write_file', args: { path: 'today.txt', content: '2026-11-14' } }] };
      }
      if (said.includes('Async delegation result')) {
        return tool ? { text: 'plan.txt is written.' } : { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] };
      }
      if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev is writing plan.txt.' }; }
      return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write the plan into plan.txt.', contract: {
        version: 2, objective: 'Write plan.txt.', expected_deliverable: 'plan.txt',
        effects: { read_files: [], expected_file_effect: 'create' }, inputs: [],
        outputs: [{ output_id: 'plan', path: path.join(workspace, 'plan.txt'), kind: 'file', required: true }],
        constraints: [], dependencies: [], required_capabilities: { version: 1, capabilities: ['write'] },
        execution_strategy: 'delegate-required' } } }] };
    });
    scripts.set('dev-model', async (request) => {
      if (lastToolResult(request)) return { text: 'Saved plan.txt.' };
      await devMayAnswer;
      return { calls: [{ name: 'write_file', args: { path: 'plan.txt', content: 'The plan.' } }] };
    });
    const waitFor = async (done: () => boolean, what: string) => {
      await pumpWhile(() => !done(), screen.pump, { detail: () => `${what}: ${JSON.stringify({ strip: screen.strip(), replies: replies('pm').slice(-3), cards: items().filter((item) => item.kind !== 'message').map((item) => [item.kind, item.id, item.reports]).slice(-4) })}` });
      expect(done(), `${what}: ${JSON.stringify({ strip: screen.strip(), replies: replies('pm').slice(-3), cards: items().filter((item) => item.kind !== 'message').map((item) => [item.kind, item.id, item.reports]).slice(-4) })}`).toBe(true);
    };

    await screen.select('pm');
    // A: the PM dispatches to Dev, which is slow, and reports progress.
    await screen.send('Please write the plan into plan.txt.');
    await waitFor(() => replied('Dev is writing plan.txt.'), 'A\'s progress report');
    await waitFor(() => cardAfter('Dev is writing plan.txt.')?.view?.state === 'in-progress', 'A\'s card, in progress');
    const cardA = cardAfter('Dev is writing plan.txt.');
    expect(cardA.kind).toBe('requestSummary');
    const requestA = cardA.requestId as string;
    // B, while A's Dev runs: the PM writes the file itself and answers.
    await screen.send('Please put today\'s date into today.txt.');
    await waitFor(() => replied('today.txt holds the date.'), 'B\'s answer');
    await waitFor(() => cardAfter('today.txt holds the date.')?.kind === 'requestSummary', 'B\'s card');
    const cardB = cardAfter('today.txt holds the date.');
    const requestB = cardB.requestId as string;
    expect(requestB).not.toBe(requestA);
    // A's result lands after B. Every state the page is given from now on is kept, to read what A's card said in each.
    const statesSeen: any[] = [];
    (screen.page().listeners.message as Array<(event: { data: any }) => void>).push((event) => {
      if (event.data?.command === 'state') statesSeen.push(event.data.state);
    });
    release();
    await waitFor(() => replied('plan.txt is written.'), 'A\'s result');
    expect(fs.readFileSync(path.join(workspace, 'plan.txt'), 'utf8')).toBe('The plan.');
    const ofRequest = (requestId: string) => items().filter((item) => item.requestId === requestId);
    await waitFor(() => ofRequest(requestA).length === 1 && cardAfter('plan.txt is written.')?.requestId === requestA
      && (cardAfter('plan.txt is written.')?.reports ?? 0) >= 2, 'A\'s one card, after its result');

    // Host projection: one card per request, after its own latest reply; never merged.
    const resultA = cardAfter('plan.txt is written.');
    expect(resultA.requestId).toBe(requestA);
    const saidOfA = statesSeen.flatMap((state) => (state.messages ?? []).filter((item: any) => item.requestId === requestA)
      .map((item: any) => `${item.kind}: ${item.view.headline.map((segment: any) => segment.text).join(' · ')}`));
    // In no state the page was given did A's card say that its job had not concluded, or point at a Job outcome to follow:
    // it went from In progress to its Job outcome in one state (the reply, its records and the Job outcome together).
    expect(saidOfA.filter((said: string) => /No conclusion recorded|its Job outcome follows/.test(said)), saidOfA.join(' | ')).toEqual([]);
    expect(saidOfA.some((said: string) => said.startsWith('requestSummary: In progress'))).toBe(true);
    expect(ofRequest(requestA)).toHaveLength(1);
    expect(ofRequest(requestB)).toHaveLength(1);
    expect(cardAfter('today.txt holds the date.')).toMatchObject({ kind: 'requestSummary', requestId: requestB });
    expect(cardAfter('Dev is writing plan.txt.')?.requestId).not.toBe(requestA);
    // A's current result, and its earlier report (the dispatching turn's) in its details.
    // A's one card is the Job outcome of its run, and its main action opens A's changes.
    expect(resultA).toMatchObject({ kind: 'jobOutcome', reports: 2, primary: 'reviewChanges' });
    expect(resultA.view.headline[0].text).toBe('Complete');
    // Its earlier report, the dispatching turn's, as it read before the run's close revised it in place, marked as earlier;
    // the revised text, which only points at this card, is not shown.
    const earlierOfA = resultA.earlier as Array<{ id: string; report: number; revised?: true; headline: Array<{ text: string }> }>;
    expect(earlierOfA).toHaveLength(1);
    expect(earlierOfA[0]).toMatchObject({ report: 1, revised: true });
    expect(earlierOfA[0].id).toMatch(new RegExp(`^request-closeout:${requestA}:[^#]+#[0-9]+$`));
    expect(earlierOfA[0].headline.map((segment) => segment.text).slice(0, 2)).toEqual(['In progress', '1 delegated task running after this turn ended']);

    // The emitted renderer.
    await screen.pump();
    // A's card is the one that lists plan.txt and says which of A's reports it shows.
    const shownCardsOfA = () => shownCards().filter((card: any) => card.words.includes(`Latest of ${resultA.reports} reports`) && card.words.includes('plan.txt'));
    // A spend unit can settle after the host projection above was read (CI, run 43760070312: the cost segment changed), so
    // the page is compared with A's current headline once it shows it, bounded.
    const headlineNow = () => (cardAfter('plan.txt is written.')?.view?.headline ?? []) as Array<{ text: string }>;
    await waitFor(() => shownCardsOfA().length === 1 && headlineNow().every((segment) => shownCardsOfA()[0].words.includes(segment.text)),
      'A\'s card as the page shows it, with its current headline');
    const cards = shownCards();
    const shownA = shownCardsOfA();
    expect(shownA).toHaveLength(1);
    expect(shownA[0].words).toContain('Earlier reports');
    expect(shownA[0].words).toContain('Report 1, as it read earlier');
    expect(shownA[0].words).toContain('In progress · 1 delegated task running after this turn ended');
    expect(shownA[0].words).not.toContain('its Job outcome follows');
    for (const segment of headlineNow()) expect(shownA[0].words).toContain(segment.text);
    const shownB = cards.filter((card: any) => card.buttons.some((button: any) => button.textContent === 'Open today.txt'));
    expect(shownB).toHaveLength(1);
    expect(shownB[0].node).not.toBe(shownA[0].node);
    // Each card has at most one main button; A's and B's have one.
    for (const card of cards) expect(card.buttons.filter((button: any) => button.className === 'primary').length, card.words.slice(0, 120)).toBeLessThanOrEqual(1);
    expect(shownA[0].buttons.filter((button: any) => button.className === 'primary')).toHaveLength(1);
    const mainB = shownB[0].buttons.filter((button: any) => button.className === 'primary');
    expect(mainB.map((button: any) => button.textContent)).toEqual(['Open today.txt']);

    // B's file opens through the host's registered handler, from the record of B's card.
    screen.page().dispatchElementEvent(mainB[0], 'click');
    await screen.pump();
    await pumpWhile(() => opened.length === 0, screen.pump);
    expect(opened.map((file) => path.normalize(file))).toEqual([path.join(workspace, 'today.txt')]);

    // A's replies leave the messages the chat keeps; A's card stays reachable at the top, saying why.
    for (let filler = 1; filler <= 26; filler++) {
      await screen.send(`Filler ${filler}.`);
      await waitFor(() => replies('pm').includes(`Noted: Filler ${filler}.`), `filler ${filler}`);
    }
    await waitFor(() => !replied('plan.txt is written.'), 'A\'s result reply left the window');
    // v0.9.103 (6.2, the Owner's "One line + tidy top"): this chat dropped messages, so its first row is the line that
    // says so, and the Earlier results entry is the second.
    await waitFor(() => items()[1]?.kind === 'earlierResults'
      && items()[1].cards.some((card: any) => card.requestId === requestA), 'A in the earlier results');
    expect(items()[0].kind).toBe('historyTrimmed');
    const earlier = items()[1];
    const kept = earlier.cards.filter((card: any) => card.requestId === requestA);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ reply: 'trimmed', id: resultA.id });
    expect(earlier.cards.filter((card: any) => card.requestId === requestB)).toHaveLength(1);
    expect(items().slice(2).some((item) => item.requestId === requestA)).toBe(false);
    await screen.pump();
    expect(descendants(screen.page().elements.get('transcript')).filter((node: any) => classed(node, 'history-trimmed'))).toHaveLength(1);
    const top = topLevel(screen.page().elements.get('transcript'))[0];
    expect(classed(top, 'earlier-results')).toBe(true);
    const disclosure = top.children[0];
    disclosure.open = true;
    screen.page().dispatchElementEvent(disclosure, 'toggle');
    const insideA = topLevel(top.children[0].children[1]).filter((node: any) => classed(node, 'job-outcome')
      && text(node).includes(`Latest of ${resultA.reports} reports`) && text(node).includes('plan.txt'));
    expect(insideA).toHaveLength(1);
    expect(text(top)).toContain('Its reply is older than the 50 messages this chat keeps.');
    expect(descendants(insideA[0]).filter((node: any) => node.type === 'button' && node.className === 'primary')).toHaveLength(1);
    // B's file still opens from there.
    const openB = descendants(top).find((node: any) => node.type === 'button' && node.textContent === 'Open today.txt');
    expect(openB).toBeDefined();
    screen.page().dispatchElementEvent(openB, 'click');
    await pumpWhile(() => opened.length < 2, screen.pump);
    expect(opened).toHaveLength(2);
  });

  /*
   * Finding 2 of the first 6.1 report: in the whole file, A's card once read "No conclusion recorded · no live work or
   * next action recorded". Not another request's owed task: each request's dispatches are a run of its own thread. It
   * was the record of the closing turn, written before the ledger saw that turn's reply, so its run was still open in it;
   * the store and the Job outcome followed 150 ms later. Here two requests of the PM each wait on a teammate and settle
   * in both orders; in no state either card says its job did not conclude, and each ends as its own Job outcome.
   */
  it.each([['the first request\'s task settles first', 'x'], ['the second request\'s task settles first', 'y']] as const)(
    'two requests each wait on a teammate; %s: each card is its own, never "No conclusion recorded", and ends as its Job outcome', async (_name, first) => {
      const gates = { x: Promise.withResolvers<void>(), y: Promise.withResolvers<void>() };
      const handles: Record<string, string> = {};
      const tag = `${first}${Date.now()}`;
      const file = (which: 'x' | 'y') => `pair-${tag}-${which}.txt`;
      const contract = (name: string) => ({
        version: 2, objective: `Write ${name}.`, expected_deliverable: name,
        effects: { read_files: [], expected_file_effect: 'create' }, inputs: [],
        outputs: [{ output_id: 'out', path: path.join(workspace, name), kind: 'file', required: true }],
        constraints: [], dependencies: [], required_capabilities: { version: 1, capabilities: ['write'] },
        execution_strategy: 'delegate-required' });
      const whichOf = (said: string): 'x' | 'y' => (said.includes(file('x')) ? 'x' : 'y');
      scripts.set('pm-model', (request) => {
        const said = latestUser(request);
        const tool = lastToolResult(request);
        const which = whichOf(said);
        if (said.includes('Async delegation result')) {
          return tool ? { text: `${file(which)} is written.` } : { calls: [{ name: 'record_task_disposition', args: { handle: handles[which], disposition: 'accepted' } }] };
        }
        if (tool) { handles[which] = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? ''; return { text: `Working on ${file(which)}.` }; }
        return { calls: [{ name: 'dispatch_task', args: { agent: which === 'x' ? 'writer' : 'dev', instruction: `Write ${file(which)}.`, contract: contract(file(which)) } }] };
      });
      const teammate = (which: 'x' | 'y') => async (request: ModelRequest) => {
        if (lastToolResult(request)) return { text: `Saved ${file(which)}.` };
        await gates[which].promise;
        return { calls: [{ name: 'write_file', args: { path: file(which), content: which } }] };
      };
      scripts.set('writer-model', teammate('x'));
      scripts.set('dev-model', teammate('y'));
      const statesSeen: any[] = [];
      (screen.page().listeners.message as Array<(event: { data: any }) => void>).push((event) => {
        if (event.data?.command === 'state') statesSeen.push(event.data.state);
      });
      const replied = (text: string) => replies('pm').some((reply) => reply.startsWith(text));
      const waitFor = async (done: () => boolean, what: string) => {
        await pumpWhile(() => !done(), screen.pump);
        expect(done(), what).toBe(true);
      };
      const cardOf = (requestId: string) => items().filter((item) => item.requestId === requestId);
      await screen.select('pm');
      await screen.send(`Please write ${file('x')}.`);
      await waitFor(() => replied(`Working on ${file('x')}.`), 'X dispatched');
      await waitFor(() => !!cardAfter(`Working on ${file('x')}.`), 'X\'s card');
      const requestX = cardAfter(`Working on ${file('x')}.`).requestId as string;
      await screen.send(`Please write ${file('y')}.`);
      await waitFor(() => replied(`Working on ${file('y')}.`), 'Y dispatched');
      await waitFor(() => !!cardAfter(`Working on ${file('y')}.`), 'Y\'s card');
      const requestY = cardAfter(`Working on ${file('y')}.`).requestId as string;
      expect(requestY).not.toBe(requestX);
      const second = first === 'x' ? 'y' : 'x';
      const requestOf = { x: requestX, y: requestY };
      gates[first].resolve();
      await waitFor(() => replied(`${file(first)} is written.`), 'the first result');
      await waitFor(() => cardOf(requestOf[first])[0]?.kind === 'jobOutcome', 'the first request\'s Job outcome');
      // The other request's task is still owed; its card says so, and the settled request's card is its own result.
      expect(cardOf(requestOf[second])).toHaveLength(1);
      expect(cardOf(requestOf[second])[0].view.headline[0].text).toBe('In progress');
      expect(cardOf(requestOf[first])[0].view.headline[0].text).toBe('Complete');
      gates[second].resolve();
      await waitFor(() => replied(`${file(second)} is written.`), 'the second result');
      await waitFor(() => cardOf(requestOf[second])[0]?.kind === 'jobOutcome', 'the second request\'s Job outcome');
      for (const requestId of [requestX, requestY]) {
        expect(cardOf(requestId)).toHaveLength(1);
        expect(cardOf(requestId)[0]).toMatchObject({ kind: 'jobOutcome', primary: 'reviewChanges' });
        const said = statesSeen.flatMap((state) => (state.messages ?? []).filter((item: any) => item.requestId === requestId)
          .map((item: any) => item.view.headline.map((segment: any) => segment.text).join(' · ')));
        expect(said.filter((text: string) => /No conclusion recorded|its Job outcome follows/.test(text)), said.join(' | ')).toEqual([]);
      }
    });
});
