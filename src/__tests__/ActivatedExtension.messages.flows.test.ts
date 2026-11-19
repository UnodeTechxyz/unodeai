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
 * The long-history flows (6.1, 6.2) are in ActivatedExtension.history.flows.test.ts, each file one activate().
 * v0.9.104 D0.4: the former single flow file is split in three so the runner can run them in parallel, each with its
 * own activate(): this file has a teammate's message bound to its task (v0.9.103).
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

import {
  endFakeTimers, flush, memento, scripts, requests, textOf, latestUser, lastToolResult, chatScreen, base, workspace, sibling, elsewhere, context, agent, reloadedStrip, readReloadedStrip, storedDelegations, storedDelegationIn, replies, installActivatedExtension, type ModelRequest, type ModelAnswer, pumpWhile, wallDeadline, beforeDeadline,
} from './support/activatedHarness';
import { perAgent, snapshotOf, unitsReaching, unitsSince, trackBegunRequests } from './support/spendUnits';
import { SpendCoordinator } from '../host/SpendCoordinator';
import { spendEventId } from '../models/spend/SpendTypes';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
// v0.9.105 (Codex's audit of 4c23e140, N1): each spend test's `before` names every request begun before it.
const begunRequests = trackBegunRequests();
afterAll(() => begunRequests.restore());

let screen: ReturnType<typeof chatScreen>;
let chatProvider: any;
installActivatedExtension(host, (ready) => { chatProvider = ready.chatProvider; screen = ready.screen; });


describe('spend unit snapshots between flows', () => {
  it("a late unit of an earlier test's request is not counted; a unit of a request started after the snapshot is", () => {
    const before = snapshotOf([{ usageUnitId: 'u1', requestId: 'earlier' }]);
    const later = [
      { usageUnitId: 'u1', requestId: 'earlier' },
      { usageUnitId: 'u2', requestId: 'earlier' },
      { usageUnitId: 'u3', requestId: 'mine' },
    ];
    expect(unitsSince(later, before).map((unit) => unit.usageUnitId)).toEqual(['u3']);
  });

  it("an earlier request with none of its units written yet is still left out, in the form the ledger stores it (Codex's audit of 4c23e140, N1)", () => {
    const original = SpendCoordinator.prototype.beginRequest;
    const tracker = trackBegunRequests();
    try {
      const coordinator = { requestRoots: new Map(), now: () => 0 } as unknown as SpendCoordinator;
      SpendCoordinator.prototype.beginRequest.call(coordinator, 'earlier', 'pm');
      SpendCoordinator.prototype.beginRequest.call(coordinator, 'an earlier request', 'pm');
      // Nothing is in the ledger yet: a snapshot read from disk alone would name neither request.
      const before = tracker.snapshot([]);
      const late = [
        { usageUnitId: 'u1', requestId: 'earlier' },
        { usageUnitId: 'u2', requestId: spendEventId('an earlier request', 'id') },
        { usageUnitId: 'u3', requestId: 'mine' },
      ];
      expect(late[1].requestId).not.toBe('an earlier request');
      expect(unitsSince(late, before).map((unit) => unit.usageUnitId)).toEqual(['u3']);
    } finally {
      tracker.restore();
    }
    expect(SpendCoordinator.prototype.beginRequest).toBe(original);
  });
});

describe('v0.9.103 the extension through activate(): a teammate\'s message bound to its task', () => {
  const contractFor = (file: string) => ({
    version: 2, objective: `Write ${file}.`, expected_deliverable: file,
    effects: { read_files: [], expected_file_effect: 'create' }, inputs: [],
    outputs: [{ output_id: 'report', path: path.join(workspace, file), kind: 'file', required: true }],
    constraints: [], dependencies: [], required_capabilities: { version: 1, capabilities: ['write'] },
    execution_strategy: 'delegate-required' });
  const gate = () => { let open!: () => void; const shut = new Promise<void>((resolve) => { open = resolve; }); return { open, shut }; };
  /** Waits for a step of the flow, bounded below the file's budget so that a stall names its step. */
  const reach = async (step: Promise<unknown>, what: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([step, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} within 40 s; ${requests.length} model requests so far`)), 40_000);
    })]).finally(() => clearTimeout(timer));
  };
  const messageWake = /on a running task arrived\./;
  /** The handles a turn's dispatch_task calls returned, in call order, with the agent each went to. */
  const dispatched = (tool: string) => [...tool.matchAll(/Dispatched contract \S+ to (\S+)\. Handle: ([^\s.]+)/g)]
    .map((match) => ({ agent: match[1], handle: match[2] }));
  const eventIds = (text: string) => [...text.matchAll(/event (task-message-[0-9a-f-]+)/g)].map((match) => match[1]);
  /** The usage units the window's spend ledger recorded: one per agent turn, with the request it was charged to. */
  const usageUnits = (): Array<{ usageUnitId: string; requestId: string; agentId: string }> => {
    const files: string[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full); else if (entry.name.endsWith('.ndjson')) files.push(full);
      }
    };
    walk(path.join(workspace, '.global', 'spend'));
    const units = new Map<string, { usageUnitId: string; requestId: string; agentId: string }>();
    for (const file of files) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        try {
          const event = JSON.parse(line) as { kind?: string; usageUnitId: string; requestId: string; agentId: string };
          if (event.kind === 'usage-unit-start' && !units.has(event.usageUnitId)) units.set(event.usageUnitId, event);
        } catch { /* a partial or empty line */ }
      }
    }
    return [...units.values()];
  };

  it('Teammate sends a note: the PM is woken once, with the notes of its request together, and nothing is expected back', async () => {
    const pmReply = gate();
    const devMayFinish = gate();
    let dispatched!: () => void;
    const pmDispatched = new Promise<void>((resolve) => { dispatched = resolve; });
    let noted!: () => void;
    const devNoted = new Promise<void>((resolve) => { noted = resolve; });
    let handle = '';
    const noteWakes: string[] = [];
    const receipts: string[] = [];
    let devTurns = 0;
    scripts.set('pm-model', async (request) => {
      const said = latestUser(request);
      const tool = lastToolResult(request);
      if (messageWake.test(said)) { noteWakes.push(said); return { text: 'Dev has the outline\'s headings and first section.' }; }
      if (said.includes('Async delegation result')) {
        return tool ? { text: 'The outline is in outline.txt.' } : { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] };
      }
      if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; dispatched(); await pmReply.shut; return { text: 'Dev is writing the outline.' }; }
      return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write outline.txt.', contract: contractFor('outline.txt') } }] };
    });
    scripts.set('dev-model', async (request) => {
      const tool = lastToolResult(request);
      if (!tool) { devTurns++; return { calls: [{ name: 'send_message', args: { target: 'coordinator', message: 'The outline has its headings.', kind: 'note' } }] }; }
      if (tool.includes('Sent to your coordinator')) {
        receipts.push(tool);
        if (receipts.length === 1) return { calls: [{ name: 'send_message', args: { target: 'coordinator', message: 'The outline has its first section.' } }] };
        noted();
        await devMayFinish.shut;
        return { calls: [{ name: 'write_file', args: { path: 'outline.txt', content: 'The outline.' } }] };
      }
      return { text: 'Saved outline.txt.' };
    });
    await screen.select('pm');
    await screen.send('Please write the outline.');
    await reach(pmDispatched, 'the PM never dispatched the outline');
    await reach(devNoted, 'Dev never sent its two notes');
    // The PM is still in its turn: the notes wait for it, nothing is folded into that turn.
    expect(noteWakes).toEqual([]);
    expect(receipts).toEqual([
      expect.stringContaining('Sent to your coordinator as a note on this task. No answer is expected: carry on with the task.'),
      expect.stringContaining('Sent to your coordinator as a note on this task. No answer is expected: carry on with the task.'),
    ]);
    pmReply.open();
    await pumpWhile(() => !replies('pm').includes('Dev has the outline\'s headings and first section.'), screen.pump);
    expect(noteWakes, JSON.stringify(replies('pm'))).toHaveLength(1);
    expect(noteWakes[0]).toContain('The outline has its headings.');
    expect(noteWakes[0]).toContain('The outline has its first section.');
    expect(noteWakes[0]).toContain('note (no answer expected)');
    expect(new Set(eventIds(noteWakes[0])).size).toBe(2);
    // Each note shows in the PM's chat under its task.
    expect(replies('pm')).toEqual(expect.arrayContaining([
      'Dev sent a note on its task "Write outline.txt.": The outline has its headings.',
      'Dev sent a note on its task "Write outline.txt.": The outline has its first section.',
    ]));
    devMayFinish.open();
    await pumpWhile(() => !replies('pm').includes('The outline is in outline.txt.'), screen.pump);
    expect(replies('pm')).toContain('The outline is in outline.txt.');
    // Nothing came back to Dev, and the notes woke the PM once.
    expect(noteWakes).toHaveLength(1);
    expect(devTurns).toBe(1);
    expect(fs.readFileSync(path.join(workspace, 'outline.txt'), 'utf8')).toBe('The outline.');
  });

  it('Two open requests on one PM: a message for A and a result for B, ready together, take separate turns charged to their own requests', async () => {
    const before = begunRequests.snapshot(usageUnits());
    const pmMayEndB = gate();
    const devMayAsk = gate();
    const devMayFinish = gate();
    let inB!: () => void;
    const pmInB = new Promise<void>((resolve) => { inB = resolve; });
    let asked!: () => void;
    const devAsked = new Promise<void>((resolve) => { asked = resolve; });
    let wroteB!: () => void;
    const writerDone = new Promise<void>((resolve) => { wroteB = resolve; });
    const handles: Record<string, string> = {};
    const wakes: string[] = [];
    scripts.set('pm-model', async (request) => {
      const said = latestUser(request);
      const tool = lastToolResult(request);
      // v0.9.103 slice 2: Dev's question opens an exchange; the PM answers it, or Dev's task would wait for the answer.
      if (messageWake.test(said)) {
        if (tool) return { text: 'Dev asks whether A should use a table.' };
        wakes.push(said);
        return { calls: [{ name: 'reply_to_task', args: { handle: handles.A, exchange_id: /exchange (exchange-[0-9a-f]{8})/.exec(said)?.[1], text: 'No table.' } }] };
      }
      if (said.includes('Async delegation result')) {
        if (!tool) wakes.push(said);
        const which = said.includes('Saved b.txt.') ? 'B' : 'A';
        return tool ? { text: `${which} is delivered.` } : { calls: [{ name: 'record_task_disposition', args: { handle: handles[which], disposition: 'accepted' } }] };
      }
      const which = said.includes('report A') ? 'A' : 'B';
      if (tool) {
        handles[which] = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? '';
        if (which === 'B') { inB(); await pmMayEndB.shut; }
        return { text: which === 'A' ? 'Dev is on A.' : 'Writer is on B.' };
      }
      return { calls: [{ name: 'dispatch_task', args: which === 'A'
        ? { agent: 'dev', instruction: 'Write a.txt.', contract: contractFor('a.txt') }
        : { agent: 'writer', instruction: 'Write b.txt.', contract: contractFor('b.txt') } }] };
    });
    scripts.set('dev-model', async (request) => {
      const tool = lastToolResult(request);
      if (!tool) { await devMayAsk.shut; return { calls: [{ name: 'send_message', args: { target: 'pm', message: 'Should A use a table?', kind: 'question' } }] }; }
      if (tool.includes('Sent to your coordinator')) { asked(); await devMayFinish.shut; return { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'A.' } }] }; }
      return { text: 'Saved a.txt.' };
    });
    scripts.set('writer-model', (request) => {
      if (lastToolResult(request)) { wroteB(); return { text: 'Saved b.txt.' }; }
      return { calls: [{ name: 'write_file', args: { path: 'b.txt', content: 'B.' } }] };
    });
    await screen.select('pm');
    await screen.send('Please write report A.');
    await pumpWhile(() => !replies('pm').includes('Dev is on A.'), screen.pump);
    expect(replies('pm')).toContain('Dev is on A.');
    await screen.send('Please write report B.');
    await reach(pmInB, 'the PM never dispatched B');
    await reach(writerDone, 'Writer never finished B');
    devMayAsk.open();
    await reach(devAsked, 'Dev never asked about A');
    for (let i = 0; i < 5; i++) await screen.pump();
    // Both are ready while the PM is in B's turn; neither is folded into it.
    expect(wakes).toEqual([]);
    pmMayEndB.open();
    await pumpWhile(() => wakes.length < 2, screen.pump);
    expect(wakes, JSON.stringify(replies('pm'))).toHaveLength(2);
    const question = wakes.find((wake) => messageWake.test(wake))!;
    const resultB = wakes.find((wake) => wake.includes('Saved b.txt.'))!;
    expect(question).toContain('Should A use a table?');
    expect(question).toContain('question (answer expected)');
    expect(question).not.toContain('Saved b.txt.');
    expect(resultB).not.toContain('Should A use a table?');
    expect(replies('pm')).toContain('Dev asked a question on its task "Write a.txt.": Should A use a table?');

    devMayFinish.open();
    await pumpWhile(() => !replies('pm').includes('A is delivered.'), screen.pump);
    expect(replies('pm')).toContain('A is delivered.');
    expect(replies('pm')).toContain('B is delivered.');

    // Each turn is charged to its own request: the PM's turns of A (the request, the question, A's result) to the request
    // Dev's task belongs to, and those of B (the request, B's result) to the request Writer's task belongs to.
    // The ledger writes each unit when its turn's first model request is made; the last ones may still be on their way.
    let units = unitsSince(usageUnits(), before);
    const requestOf = (agentId: string) => units.find((unit) => unit.agentId === agentId)?.requestId;
    const pmTurns = (requestId: string | undefined) => units.filter((unit) => unit.agentId === 'pm' && unit.requestId === requestId).length;
    for (const deadline = wallDeadline(); (pmTurns(requestOf('dev')) + pmTurns(requestOf('writer')) < 5) && beforeDeadline(deadline);) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      units = unitsSince(usageUnits(), before);
    }
    // Every turn of this test, once each agent's count arrived: a unit of this test charged to an earlier
    // test's request would be left out by unitsSince, and this count would then come up short (Codex's audit of fbc6c852).
    units = await unitsReaching(usageUnits, before, { pm: 5, dev: 1, writer: 1 });
    expect(perAgent(units), JSON.stringify(units)).toEqual({ pm: 5, dev: 1, writer: 1 });
    const requestA = requestOf('dev');
    const requestB = requestOf('writer');
    expect(requestA, JSON.stringify(units)).toBeDefined();
    expect(requestB).toBeDefined();
    expect(requestA).not.toBe(requestB);
    expect({ A: pmTurns(requestA), B: pmTurns(requestB) }, JSON.stringify(units)).toEqual({ A: 3, B: 2 });

    // The question is recorded with A's task, and not with B's.
    const { ledger } = await reloadedStrip();
    const runOf = (handle: string) => ledger.snapshot().find((run) => run.delegations.some((delegation) => delegation.handle === handle));
    const asks = (handle: string) => (runOf(handle)?.activity ?? [])
      .filter((item) => item.type === 'agent.message' && item.from === 'dev' && item.content.includes('Should A use a table?')).length;
    expect(runOf(handles.A)?.id).toBeDefined();
    expect(runOf(handles.A)?.id).not.toBe(runOf(handles.B)?.id);
    expect({ A: asks(handles.A), B: asks(handles.B) }).toEqual({ A: 1, B: 0 });
  });

  it('A duplicate delivery of the same message starts no turn; a new note still wakes the PM', async () => {
    const devMayGoOn = gate();
    const devMayFinish = gate();
    let firstSent!: () => void;
    const devSentFirst = new Promise<void>((resolve) => { firstSent = resolve; });
    let secondSent!: () => void;
    const devSentSecond = new Promise<void>((resolve) => { secondSent = resolve; });
    let handle = '';
    const noteWakes: string[] = [];
    scripts.set('pm-model', (request) => {
      const said = latestUser(request);
      const tool = lastToolResult(request);
      if (messageWake.test(said)) { noteWakes.push(said); return { text: `Note ${noteWakes.length} read.` }; }
      if (said.includes('Async delegation result')) {
        return tool ? { text: 'The notes are in notes.txt.' } : { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] };
      }
      if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev is writing the notes.' }; }
      return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write notes.txt.', contract: contractFor('notes.txt') } }] };
    });
    let sent = 0;
    scripts.set('dev-model', async (request) => {
      const tool = lastToolResult(request);
      if (!tool) {
        await pumpWhile(() => !replies('pm').includes('Dev is writing the notes.'), () => new Promise<void>((resolve) => setTimeout(resolve, 10)));
        return { calls: [{ name: 'send_message', args: { target: 'coordinator', message: 'The first notes are in.' } }] };
      }
      if (tool.includes('Sent to your coordinator')) {
        sent++;
        if (sent === 1) { firstSent(); await devMayGoOn.shut; return { calls: [{ name: 'send_message', args: { target: 'coordinator', message: 'The last notes are in.' } }] }; }
        secondSent(); await devMayFinish.shut;
        return { calls: [{ name: 'write_file', args: { path: 'notes.txt', content: 'Notes.' } }] };
      }
      return { text: 'Saved notes.txt.' };
    });
    const send = vi.spyOn(MessageBus.prototype, 'send');
    try {
      await screen.select('pm');
      await screen.send('Please write the notes.');
      await reach(devSentFirst, 'Dev never sent its first note');
      await pumpWhile(() => !replies('pm').includes('Note 1 read.'), screen.pump);
      expect(noteWakes).toHaveLength(1);
      const at = send.mock.calls.findIndex((call) => call[2] === 'agent.message' && call[0] === 'dev');
      expect(at).toBeGreaterThanOrEqual(0);
      const bus = send.mock.contexts[at] as MessageBus;
      const original = send.mock.results[at].value as Message;
      expect(original.payload.metadata).toMatchObject({ taskMessage: { kind: 'note' } });
      const modelRequests = requests.length;
      const shown = replies('pm').length;

      // The same message is delivered again, as it was, and once more under a new bus id with the same host event id.
      (bus as unknown as { matchSubscribers(message: Message): void }).matchSubscribers(original);
      bus.send('dev', 'pm', 'agent.message', { message: String(original.payload.message), metadata: { ...original.payload.metadata } }, 'normal', original.correlationId);
      for (let i = 0; i < 10; i++) await screen.pump();
      expect(requests.length).toBe(modelRequests);
      expect(noteWakes).toHaveLength(1);
      expect(replies('pm')).toHaveLength(shown);

      // A genuinely new note still wakes the PM.
      devMayGoOn.open();
      await reach(devSentSecond, 'Dev never sent its second note');
      await pumpWhile(() => !replies('pm').includes('Note 2 read.'), screen.pump);
      expect(noteWakes).toHaveLength(2);
      expect(noteWakes[1]).toContain('The last notes are in.');
      expect(noteWakes[1]).not.toContain('The first notes are in.');
    } finally {
      send.mockRestore();
    }
    devMayFinish.open();
    await pumpWhile(() => !replies('pm').includes('The notes are in notes.txt.'), screen.pump);
    expect(replies('pm')).toContain('The notes are in notes.txt.');
    expect(noteWakes).toHaveLength(2);
  });

  /**
   * A test's spend snapshot: the units written so far. v0.9.105 (nightly
   * 44028065080; Codex's audit of 4c23e140, N1): with every request begun so far, so that an earlier turn's unit is left
   * out however late it is written (trackBegunRequests).
   */
  const settledUnits = () => begunRequests.snapshot(usageUnits());

  /*
   * Audit of 80dde13a, I1: request A delegates a report; the PM accepts it while another task keeps A's run open; during
   * request B the PM asks for rework on A's handle; Dev, in the rework turn, messages "coordinator".
   */
  it('I1: a rework asked during request B reaches the coordinator by "coordinator", and the rework, its question and its result are charged to A', async () => {
    const before = settledUnits();
    const writerMayFinish = gate();
    let handleReport = '';
    let handleOther = '';
    let receipt = '';
    const questionWakes: string[] = [];
    const pmAsked: string[] = [];
    scripts.set('pm-model', (request) => {
      const said = latestUser(request);
      const tool = lastToolResult(request);
      pmAsked.push(`${tool ? `[tool] ${tool.slice(0, 200)} ` : ''}${said.slice(0, 120)}`);
      if (messageWake.test(said)) { questionWakes.push(said); return { text: 'Dev asks whether the totals include tax.' }; }
      if (said.includes('Async delegation result')) {
        const [handle, done] = said.includes('Saved other.txt.') ? [handleOther, 'The other part is accepted.']
          : said.includes('rework reply') ? [handleReport, 'The revised report is accepted.'] : [handleReport, 'The report is accepted.'];
        return tool ? { text: done } : { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] };
      }
      if (said.includes('Please revise the report')) {
        return tool ? { text: 'Dev is revising the report.' }
          : { calls: [{ name: 'record_task_disposition', args: { handle: handleReport, disposition: 'needs-rework', reason: 'Add the totals.' } }] };
      }
      if (!said.includes('Please write report A.')) return { text: 'Nothing else to do.' };
      // Two tasks, one call per step, so that A's run stays open while Writer's runs.
      const [sent] = tool ? dispatched(tool) : [];
      if (sent?.agent === 'writer') { handleOther = sent.handle; return { text: 'Dev and Writer are on A.' }; }
      if (sent?.agent === 'dev') {
        handleReport = sent.handle;
        return { calls: [{ name: 'dispatch_task', args: { agent: 'writer', instruction: 'Write other.txt.', contract: contractFor('other.txt') } }] };
      }
      return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write report.txt.', contract: contractFor('report.txt') } }] };
    });
    scripts.set('dev-model', (request) => {
      const said = latestUser(request);
      const tool = lastToolResult(request);
      if (said.includes('Coordinator requested rework')) {
        if (!tool) return { calls: [{ name: 'send_message', args: { target: 'coordinator', message: 'Should the totals include tax?', kind: 'question' } }] };
        if (!receipt) { receipt = tool; return { calls: [{ name: 'write_file', args: { path: 'report.txt', content: 'Revised report.' } }] }; }
        return { text: 'Saved the revised report.' };
      }
      return tool ? { text: 'Saved report.txt.' } : { calls: [{ name: 'write_file', args: { path: 'report.txt', content: 'Original report.' } }] };
    });
    scripts.set('writer-model', async (request) => {
      if (lastToolResult(request)) return { text: 'Saved other.txt.' };
      await writerMayFinish.shut;
      return { calls: [{ name: 'write_file', args: { path: 'other.txt', content: 'Other.' } }] };
    });
    await screen.select('pm');
    await screen.send('Please write report A.');
    await pumpWhile(() => !replies('pm').includes('The report is accepted.'), screen.pump);
    expect(replies('pm'), JSON.stringify(pmAsked, null, 1)).toContain('The report is accepted.');
    await screen.send('Please revise the report: add the totals.');
    await pumpWhile(() => !replies('pm').includes('The revised report is accepted.'), screen.pump);
    expect(replies('pm'), JSON.stringify(pmAsked, null, 1)).toContain('The revised report is accepted.');
    // The question reached the PM, under its task, and Dev was told so.
    // v0.9.103 slice 2 (audit I1): a rework turn is told no answer comes back into it.
    expect(receipt).toContain('Sent to your coordinator as a question on this task; the PM is told. In a rework turn the answer does not come back into this turn');
    expect(questionWakes).toHaveLength(1);
    expect(questionWakes[0]).toContain('Should the totals include tax?');
    expect(replies('pm')).toContain(`Dev asked a question on its task ${handleReport}: Should the totals include tax?`);
    expect(fs.readFileSync(path.join(workspace, 'report.txt'), 'utf8')).toBe('Revised report.');
    writerMayFinish.open();
    await pumpWhile(() => !replies('pm').includes('The other part is accepted.'), screen.pump);
    expect(replies('pm')).toContain('The other part is accepted.');

    // Spend: Dev's report and its rework, and the PM's turns on them, are A's; B paid only for its own turn.
    let units = unitsSince(usageUnits(), before);
    const requestA = () => units.find((unit) => unit.agentId === 'writer')?.requestId;
    const pmTurns = (inA: boolean) => units.filter((unit) => unit.agentId === 'pm' && (unit.requestId === requestA()) === inA).length;
    for (const deadline = wallDeadline(); (pmTurns(true) + pmTurns(false) < 6) && beforeDeadline(deadline);) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      units = unitsSince(usageUnits(), before);
    }
    // Every turn of this test, once each agent's count arrived: a unit of this test charged to an earlier
    // test's request would be left out by unitsSince, and this count would then come up short (Codex's audit of fbc6c852).
    units = await unitsReaching(usageUnits, before, { pm: 6, dev: 2, writer: 1 });
    expect(perAgent(units), JSON.stringify(units)).toEqual({ pm: 6, dev: 2, writer: 1 });
    expect(requestA(), JSON.stringify(units)).toBeDefined();
    const devUnits = units.filter((unit) => unit.agentId === 'dev');
    expect(devUnits, JSON.stringify(units)).toHaveLength(2);
    expect(devUnits.every((unit) => unit.requestId === requestA()), JSON.stringify(units)).toBe(true);
    // A: the request, Dev's result, the question, the rework's result, Writer's result. B: its own turn.
    expect({ A: pmTurns(true), B: pmTurns(false) }, JSON.stringify(units)).toEqual({ A: 5, B: 1 });
  });

  /*
   * Audit of 80dde13a, I2: Writer's first part of B returns while B's second part keeps B open; the PM reports it
   * without a decision, so B's one automatic review is owed; then Dev's question about A wakes the PM.
   */
  it('I2: a message wake of request A carries none of B\'s automatic review; B\'s review takes its own turn, charged to B', async () => {
    const before = settledUnits();
    const pmMayEndB = gate();
    const devMayAsk = gate();
    const devMayFinish = gate();
    const writerMayDoPartTwo = gate();
    let inB!: () => void;
    const pmInB = new Promise<void>((resolve) => { inB = resolve; });
    let asked!: () => void;
    const devAsked = new Promise<void>((resolve) => { asked = resolve; });
    let partOne!: () => void;
    const partOneDone = new Promise<void>((resolve) => { partOne = resolve; });
    const handles: Record<string, string> = {};
    const questionWakes: string[] = [];
    const reviewTurns: string[] = [];
    scripts.set('pm-model', async (request) => {
      const said = latestUser(request);
      const tool = lastToolResult(request);
      // v0.9.103 slice 2: Dev's question opens an exchange; the PM answers it, or Dev's task would wait for the answer.
      if (messageWake.test(said)) {
        if (tool) return { text: 'Dev asked about A2.' };
        questionWakes.push(said);
        return { calls: [{ name: 'reply_to_task', args: { handle: handles.a2, exchange_id: /exchange (exchange-[0-9a-f]{8})/.exec(said)?.[1], text: 'Yes, a draft.' } }] };
      }
      if (said.includes('This is the one automatic review turn')) {
        if (!tool) reviewTurns.push(said);
        return tool ? { text: 'Part one is accepted.' } : { calls: [{ name: 'record_task_disposition', args: { handle: handles.b1, disposition: 'accepted' } }] };
      }
      if (said.includes('Async delegation result')) {
        if (said.includes('Saved b1.txt.')) return { text: 'Writer finished part one.' };
        const [handle, done] = said.includes('Saved b2.txt.') ? [handles.b2, 'Part two is accepted.'] : [handles.a2, 'A2 is accepted.'];
        return tool ? { text: done } : { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] };
      }
      if (said.includes('Please write A2')) {
        if (tool) { handles.a2 = dispatched(tool)[0]?.handle ?? ''; return { text: 'Dev is on A2.' }; }
        return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write a2.txt.', contract: contractFor('a2.txt') } }] };
      }
      if (!said.includes('Please write both parts of B.')) return { text: 'Nothing else to do.' };
      const [sent] = tool ? dispatched(tool) : [];
      if (sent && handles.b1) {
        handles.b2 = sent.handle;
        inB();
        await pmMayEndB.shut;
        return { text: 'Writer is on B.' };
      }
      if (sent) {
        handles.b1 = sent.handle;
        return { calls: [{ name: 'dispatch_task', args: { agent: 'writer', instruction: 'Write b2.txt.', contract: contractFor('b2.txt') } }] };
      }
      return { calls: [{ name: 'dispatch_task', args: { agent: 'writer', instruction: 'Write b1.txt.', contract: contractFor('b1.txt') } }] };
    });
    scripts.set('dev-model', async (request) => {
      const tool = lastToolResult(request);
      if (!tool) { await devMayAsk.shut; return { calls: [{ name: 'send_message', args: { target: 'coordinator', message: 'Is A2 a draft?', kind: 'question' } }] }; }
      if (tool.includes('Sent to your coordinator')) { asked(); await devMayFinish.shut; return { calls: [{ name: 'write_file', args: { path: 'a2.txt', content: 'A2.' } }] }; }
      return { text: 'Saved a2.txt.' };
    });
    scripts.set('writer-model', async (request) => {
      const partTwo = latestUser(request).includes('Write b2.txt.');
      if (lastToolResult(request)) { if (!partTwo) partOne(); return { text: partTwo ? 'Saved b2.txt.' : 'Saved b1.txt.' }; }
      if (partTwo) await writerMayDoPartTwo.shut;
      return { calls: [{ name: 'write_file', args: { path: partTwo ? 'b2.txt' : 'b1.txt', content: partTwo ? 'B2.' : 'B1.' } }] };
    });
    await screen.select('pm');
    await screen.send('Please write A2.');
    await pumpWhile(() => !replies('pm').includes('Dev is on A2.'), screen.pump);
    expect(replies('pm')).toContain('Dev is on A2.');
    await screen.send('Please write both parts of B.');
    await reach(pmInB, 'the PM never dispatched B');
    await reach(partOneDone, 'Writer never finished part one of B');
    devMayAsk.open();
    await reach(devAsked, 'Dev never asked about A2');
    for (let i = 0; i < 5; i++) await screen.pump();
    pmMayEndB.open();
    await pumpWhile(() => !replies('pm').includes('Part one is accepted.'), screen.pump);
    expect(replies('pm'), JSON.stringify(replies('pm').slice(-6))).toContain('Part one is accepted.');
    expect(replies('pm')).toContain('Writer finished part one.');
    expect(replies('pm')).toContain('Dev asked about A2.');
    // A's question turn carried A's message only; B's review came in a turn of its own.
    expect(questionWakes).toHaveLength(1);
    expect(questionWakes[0]).toContain('Is A2 a draft?');
    expect(questionWakes[0]).not.toContain('no recorded decision');
    expect(reviewTurns).toHaveLength(1);
    expect(reviewTurns[0]).not.toContain('Is A2 a draft?');

    writerMayDoPartTwo.open();
    await pumpWhile(() => !replies('pm').includes('Part two is accepted.'), screen.pump);
    expect(replies('pm')).toContain('Part two is accepted.');
    devMayFinish.open();
    await pumpWhile(() => !replies('pm').includes('A2 is accepted.'), screen.pump);
    expect(replies('pm')).toContain('A2 is accepted.');

    // Spend: A: the request, the question, A2's result. B: the request, part one, its review, part two.
    let units = unitsSince(usageUnits(), before);
    const requestOf = (agentId: string) => units.find((unit) => unit.agentId === agentId)?.requestId;
    const pmTurns = (requestId: string | undefined) => units.filter((unit) => unit.agentId === 'pm' && unit.requestId === requestId).length;
    for (const deadline = wallDeadline(); (pmTurns(requestOf('dev')) + pmTurns(requestOf('writer')) < 7) && beforeDeadline(deadline);) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      units = unitsSince(usageUnits(), before);
    }
    // Every turn of this test, once each agent's count arrived: a unit of this test charged to an earlier
    // test's request would be left out by unitsSince, and this count would then come up short (Codex's audit of fbc6c852).
    units = await unitsReaching(usageUnits, before, { pm: 7, dev: 1, writer: 2 });
    expect(perAgent(units), JSON.stringify(units)).toEqual({ pm: 7, dev: 1, writer: 2 });
    expect(requestOf('dev'), JSON.stringify(units)).toBeDefined();
    expect(requestOf('dev')).not.toBe(requestOf('writer'));
    expect({ A: pmTurns(requestOf('dev')), B: pmTurns(requestOf('writer')) }, JSON.stringify(units)).toEqual({ A: 3, B: 4 });
  });

  /*
   * Audit of 80dde13a, I2, the separate review path: results of A and of B are both reported without a decision while
   * each request keeps another task running, so both automatic reviews end up owed together; each takes its own turn.
   */
  it('I2: owed automatic reviews of two requests take one turn each, each charged to its own request', async () => {
    const before = settledUnits();
    const pmMayEndB = gate();
    const devMayFinishA = gate();
    const devMayDoA2 = gate();
    const writerMayDoB2 = gate();
    let inB!: () => void;
    const pmInB = new Promise<void>((resolve) => { inB = resolve; });
    let firstA!: () => void;
    const devDoneA = new Promise<void>((resolve) => { firstA = resolve; });
    let firstB!: () => void;
    const writerDoneB = new Promise<void>((resolve) => { firstB = resolve; });
    const handles: Record<string, string> = {};
    const reviewTurns: string[] = [];
    const decided: string[] = [];
    scripts.set('pm-model', async (request) => {
      const said = latestUser(request);
      const tool = lastToolResult(request);
      if (said.includes('This is the one automatic review turn')) {
        if (!tool) reviewTurns.push(said); else decided.push(tool.slice(0, 300));
        const handle = said.includes('writer (') ? handles.b1 : handles.a1;
        return tool ? { text: `Review ${reviewTurns.length} of R done.` } : { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] };
      }
      if (said.includes('Async delegation result')) {
        if (said.includes('Saved r-b1.txt.')) return { text: 'Writer finished R-B1.' };
        if (said.includes('Saved r-a1.txt.')) return { text: 'Dev finished R-A1.' };
        const [handle, done] = said.includes('Saved r-b2.txt.') ? [handles.b2, 'R-B2 is accepted.'] : [handles.a2, 'R-A2 is accepted.'];
        return tool ? { text: done } : { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] };
      }
      // Each request dispatches two tasks to one teammate, one call per step; the second keeps its run open.
      const which = said.includes('Please write A1 and A2.') ? 'a' : said.includes('Please write B1 and B2.') ? 'b' : '';
      if (!which) return { text: 'Nothing else to do.' };
      const agent = which === 'a' ? 'dev' : 'writer';
      const [sent] = tool ? dispatched(tool) : [];
      if (sent && handles[`${which}1`]) {
        handles[`${which}2`] = sent.handle;
        if (which === 'b') { inB(); await pmMayEndB.shut; }
        return { text: which === 'a' ? 'Dev is on R-A.' : 'Writer is on R-B.' };
      }
      if (sent) handles[`${which}1`] = sent.handle;
      const n = sent ? 2 : 1;
      return { calls: [{ name: 'dispatch_task', args: { agent, instruction: `Write r-${which}${n}.txt.`, contract: contractFor(`r-${which}${n}.txt`) } }] };
    });
    const teammate = (part: string, mayWork: Promise<void>, done: () => void, second: Promise<void>) => async (request: ModelRequest) => {
      const isSecond = latestUser(request).includes(`Write r-${part}2.txt.`);
      if (lastToolResult(request)) { if (!isSecond) done(); return { text: `Saved r-${part}${isSecond ? 2 : 1}.txt.` }; }
      await (isSecond ? second : mayWork);
      return { calls: [{ name: 'write_file', args: { path: `r-${part}${isSecond ? 2 : 1}.txt`, content: `${part}.` } }] };
    };
    scripts.set('dev-model', teammate('a', devMayFinishA.shut, firstA, devMayDoA2.shut));
    scripts.set('writer-model', teammate('b', Promise.resolve(), firstB, writerMayDoB2.shut));
    await screen.select('pm');
    await screen.send('Please write A1 and A2.');
    await pumpWhile(() => !replies('pm').includes('Dev is on R-A.'), screen.pump);
    expect(replies('pm')).toContain('Dev is on R-A.');
    await screen.send('Please write B1 and B2.');
    await reach(pmInB, 'the PM never dispatched B');
    await reach(writerDoneB, 'Writer never finished B1');
    devMayFinishA.open();
    await reach(devDoneA, 'Dev never finished A1');
    for (let i = 0; i < 5; i++) await screen.pump();
    // Both results wait for the PM; it reports each without a decision, so both reviews are owed.
    pmMayEndB.open();
    await pumpWhile(() => reviewTurns.length < 2, screen.pump);
    await pumpWhile(() => !replies('pm').includes('Review 2 of R done.'), screen.pump);
    expect(replies('pm'), JSON.stringify(replies('pm').slice(-8))).toEqual(expect.arrayContaining(['Writer finished R-B1.', 'Dev finished R-A1.', 'Review 2 of R done.']));
    expect(reviewTurns).toHaveLength(2);
    expect(reviewTurns.map((turn) => [turn.includes('dev ('), turn.includes('writer (')]).sort()).toEqual([[false, true], [true, false]]);

    devMayDoA2.open();
    await pumpWhile(() => !replies('pm').includes('R-A2 is accepted.'), screen.pump);
    writerMayDoB2.open();
    await pumpWhile(() => !replies('pm').includes('R-B2 is accepted.'), screen.pump);
    expect(replies('pm'), JSON.stringify({ decided, handles, reviews: reviewTurns.map((t) => t.slice(0, 120)) })).toEqual(expect.arrayContaining(['R-A2 is accepted.', 'R-B2 is accepted.']));

    // Spend: each request paid for its request turn, its first result, its own review and its second result.
    let units = unitsSince(usageUnits(), before);
    const requestOf = (agentId: string) => units.find((unit) => unit.agentId === agentId)?.requestId;
    const pmTurns = (requestId: string | undefined) => units.filter((unit) => unit.agentId === 'pm' && unit.requestId === requestId).length;
    for (const deadline = wallDeadline(); (pmTurns(requestOf('dev')) + pmTurns(requestOf('writer')) < 8) && beforeDeadline(deadline);) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      units = unitsSince(usageUnits(), before);
    }
    // Every turn of this test, once each agent's count arrived: a unit of this test charged to an earlier
    // test's request would be left out by unitsSince, and this count would then come up short (Codex's audit of fbc6c852).
    units = await unitsReaching(usageUnits, before, { pm: 8, dev: 2, writer: 2 });
    expect(perAgent(units), JSON.stringify(units)).toEqual({ pm: 8, dev: 2, writer: 2 });
    expect(requestOf('dev'), JSON.stringify(units)).toBeDefined();
    expect(requestOf('dev')).not.toBe(requestOf('writer'));
    expect({ A: pmTurns(requestOf('dev')), B: pmTurns(requestOf('writer')) }, JSON.stringify(units)).toEqual({ A: 4, B: 4 });
  });
});

/*
 * v0.9.103 slice 2 (design §4 G2, G3, §5.3, §5.5, §5.6, §7, the acceptance rows of §9 this slice owns): a teammate's
 * question opens an exchange the PM answers with reply_to_task. The answer goes into the running turn where the route
 * confirms it can read it; otherwise the teammate's turn end is a waiting checkpoint, and the answer continues the same
 * attempt. Receipts start nothing; Stop and a reload end an exchange without replaying anything.
 */
