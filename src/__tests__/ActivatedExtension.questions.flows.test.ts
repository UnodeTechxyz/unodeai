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
 * own activate(): this file has a teammate's question and the PM's answer (v0.9.103).
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
import { perAgent, unitsReaching, unitsSince, trackBegunRequests } from './support/spendUnits';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
// v0.9.105 (Codex's audit of 4c23e140, N1): each spend test's `before` names every request begun before it.
const begunRequests = trackBegunRequests();
afterAll(() => begunRequests.restore());

let screen: ReturnType<typeof chatScreen>;
let chatProvider: any;
installActivatedExtension(host, (ready) => { chatProvider = ready.chatProvider; screen = ready.screen; });


describe('v0.9.103 the extension through activate(): a teammate\'s question and the PM\'s answer', () => {
  const contractFor = (file: string) => ({
    version: 2, objective: `Write ${file}.`, expected_deliverable: file,
    effects: { read_files: [], expected_file_effect: 'create' }, inputs: [],
    outputs: [{ output_id: 'report', path: path.join(workspace, file), kind: 'file', required: true }],
    constraints: [], dependencies: [], required_capabilities: { version: 1, capabilities: ['write'] },
    execution_strategy: 'delegate-required' });
  const gate = () => { let open!: () => void; const shut = new Promise<void>((resolve) => { open = resolve; }); return { open, shut }; };
  const signal = () => { let fire!: () => void; const fired = new Promise<void>((resolve) => { fire = resolve; }); return { fire, fired }; };
  const reach = async (step: Promise<unknown>, what: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([step, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} within 40 s; ${requests.length} model requests so far`)), 40_000);
    })]).finally(() => clearTimeout(timer));
  };
  const messageWake = /on a running task arrived\./;
  const exchangeOf = (text: string) => /exchange (exchange-[0-9a-f]{8})/.exec(text)?.[1] ?? '';
  const userTexts = (request: ModelRequest) => request.messages.filter((message) => message.role === 'user').map((message) => textOf(message.content));
  /** Every message the window's bus sent while `send` spies on it, in order, with the call order of each. */
  const sentOf = (send: ReturnType<typeof vi.spyOn>) => send.mock.results.map((result, index) => ({
    message: result.value as Message, order: send.mock.invocationCallOrder[index] }));
  /** The stored delegation of a handle, read again until it is in `state`: the run ledger is written asynchronously. */
  const storedDelegationIn = async (handle: string, state: string) => {
    let found = (await storedDelegations()).find((delegation) => delegation.handle === handle);
    for (const deadline = wallDeadline(); found?.state !== state && beforeDeadline(deadline);) found = (await storedDelegations()).find((delegation) => delegation.handle === handle);
    return found;
  };
  const exchangeRecords = (send: ReturnType<typeof vi.spyOn>, fact?: string) => sentOf(send).filter(({ message }) => message.type === 'ask.answer'
    && (!fact || (message.payload.metadata as { taskExchange?: { fact?: string } } | undefined)?.taskExchange?.fact === fact));
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

  /*
   * v0.9.103 slice 3 part B (design §2, G4): a waiting checkpoint is active work. Dev asks the PM a question and ends its
   * turn waiting; the PM's turn on that question ends with no reply. Observed together: the run still counts Dev's task
   * as active, the closing turn's request summary reads In progress, and the strip shows the question, with Dev off the
   * Running line. The person's answer then lets the same attempt finish, and the result is reported.
   */
  it('G4 waiting: Dev asks and ends its turn waiting, the PM ends its turn with no reply, and the request reads In progress', async () => {
    let handle = '';
    let id = '';
    // Only a tool result this turn asked for: an earlier flow's turn may have ended on a tool call of its own. The host
    // may add its context after the conversation, as a system message.
    const toolNow = (request: ModelRequest) =>
      ([...request.messages].reverse().find((message) => message.role !== 'system')?.role === 'tool' ? lastToolResult(request) : undefined);
    scripts.set('pm-model', (request) => {
      const said = latestUser(request);
      const tool = toolNow(request);
      if (messageWake.test(said)) {
        id = exchangeOf(said);
        // The PM looks at the task and ends its turn without a word to the person.
        return tool ? { text: '' } : { calls: [{ name: 'inspect_task_status', args: { handle } }] };
      }
      if (said.includes('Tell Dev to use ISO dates.')) {
        return tool ? { text: 'Told Dev to use ISO dates.' } : { calls: [{ name: 'reply_to_task', args: { handle, exchange_id: id, text: 'ISO 8601, please.' } }] };
      }
      if (said.includes('Async delegation result')) {
        return tool ? { text: 'dates.txt is written with ISO dates.' } : { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] };
      }
      if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev is writing dates.txt.' }; }
      return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write dates.txt', contract: contractFor('dates.txt') } }] };
    });
    scripts.set('dev-model', (request) => {
      const tool = toolNow(request);
      if (!tool) {
        return latestUser(request).includes('[Continuation of your assigned task]')
          ? { calls: [{ name: 'write_file', args: { path: 'dates.txt', content: '2026-11-14' } }] }
          : { calls: [{ name: 'send_message', args: { target: 'coordinator', message: 'Which date format?', kind: 'question' } }] };
      }
      if (tool.includes('Sent to your coordinator')) return { text: 'Waiting for the PM on the date format.' };
      return { text: 'Saved dates.txt.' };
    });
    const cards = () => chatProvider.requestSummaryCards('pm') as Array<{ recordId: string; state: string }>;
    const asked = 'Dev asked the PM a question on Dev\'s task "Write dates.txt". To answer, press Ask the PM, then Send.';
    const waitFor = async (done: () => boolean, what: string) => {
      await pumpWhile(() => !done(), screen.pump, { detail: () => `${what}: ${JSON.stringify({ strip: screen.strip(), cards: cards().slice(-2), pm: replies('pm').slice(-2), dev: replies('dev').slice(-2) })}` });
      expect(done(), `${what}: ${JSON.stringify({ strip: screen.strip(), cards: cards().slice(-2), pm: replies('pm').slice(-2), dev: replies('dev').slice(-2) })}`).toBe(true);
    };

    /** The summaries of this request: the dispatching turn's, then the turn on Dev's question. */
    const thisRequest = () => {
      const last = cards().at(-1)?.recordId.split(':')[1];
      return cards().filter((card) => card.recordId.split(':')[1] === last);
    };
    await screen.select('pm');
    await screen.send('Please write dates.txt.');
    await waitFor(() => replies('dev').includes('Waiting for the PM on the date format.'), 'Dev waiting');
    await waitFor(() => id !== '' && replies('pm').at(-1) === '' && thisRequest().length === 2, 'the PM\'s turn on the question');
    await waitFor(() => screen.strip().includes(`${asked} Ask the PM`), 'the question on the strip');
    // Together: the run counts Dev's task as active; the summary of the turn that ended with no reply reads In progress;
    // the strip shows the question, and Dev, waiting, is not on the Running line.
    expect((await storedDelegationIn(handle, 'active'))?.state).toBe('active');
    expect(thisRequest().map((card) => card.state)).toEqual(['in-progress', 'in-progress']);
    // The PM's turn on the question ended with no reply to the person.
    expect(replies('pm').at(-1)).toBe('');
    expect(screen.strip()).toEqual(['The PM reports here when results come back.', `${asked} Ask the PM`]);

    // The person answers through the PM; the same attempt finishes, and the result is reported.
    await screen.send('Tell Dev to use ISO dates.');
    await waitFor(() => replies('pm').some((reply) => reply.startsWith('dates.txt is written with ISO dates.')), 'the report');
    expect(fs.readFileSync(path.join(workspace, 'dates.txt'), 'utf8')).toBe('2026-11-14');
    await waitFor(() => screen.strip().length === 0, 'the strip after the report');
  });


  it('Question answered in-turn: the PM is woken with the question under the task, the answer goes into the running turn, one result wakes the PM; receipts and re-deliveries start nothing', async () => {
    const send = vi.spyOn(MessageBus.prototype, 'send');
    try {
      const devMayGoOn = gate();
      const devAsked = signal();
      let handle = '';
      let answered = '';
      const questionWakes: string[] = [];
      const resultWakes: string[] = [];
      scripts.set('pm-model', (request) => {
        const said = latestUser(request);
        const tool = lastToolResult(request);
        if (messageWake.test(said)) {
          if (tool) { answered = tool; return { text: 'Answered Dev: a bulleted list.' }; }
          questionWakes.push(said);
          return { calls: [{ name: 'reply_to_task', args: { handle, exchange_id: exchangeOf(said), text: 'Use a bulleted list.' } }] };
        }
        if (said.includes('Async delegation result')) {
          if (tool) return { text: 'The list is in list.txt.' };
          resultWakes.push(said);
          return { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] };
        }
        if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev is writing the list.' }; }
        return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write list.txt.', contract: contractFor('list.txt') } }] };
      });
      const devRequests: ModelRequest[] = [];
      scripts.set('dev-model', async (request) => {
        devRequests.push(request);
        const tool = lastToolResult(request);
        if (!tool) return { calls: [{ name: 'send_message', args: { target: 'coordinator', message: 'Bullets or a table?', kind: 'question' } }] };
        if (tool.includes('Sent to your coordinator')) {
          devAsked.fire();
          await devMayGoOn.shut;
          return { calls: [{ name: 'write_file', args: { path: 'list.txt', content: '- one' } }] };
        }
        return { text: 'Saved list.txt as a bulleted list.' };
      });
      await screen.select('pm');
      await screen.send('Please write the list.');
      await reach(devAsked.fired, 'Dev never asked');
      await pumpWhile(() => !answered, screen.pump);
      // The PM was woken with the question under its task, with the exchange id it answers by.
      expect(questionWakes, JSON.stringify(replies('pm').slice(-3))).toHaveLength(1);
      const id = exchangeOf(questionWakes[0]);
      expect(questionWakes[0]).toContain(`=== dev (${handle}) ===\nMessage from Dev on this task — question (answer expected); event task-message-`);
      expect(questionWakes[0]).toContain(`Bullets or a table?\nAnswer it with reply_to_task: handle "${handle}", exchange_id "${id}".`);
      expect(replies('pm')).toContain('Dev asked a question on its task "Write list.txt.": Bullets or a table?');
      expect(answered).toMatch(new RegExp(`^Answer accepted for Dev's question \\(${id}\\)\\. It goes into Dev's running turn`));
      // Dev is still in its turn: the answer was delivered into it, at the route's confirmation.
      await pumpWhile(() => !exchangeRecords(send, 'answer-delivered').length, screen.pump);
      expect(exchangeRecords(send, 'answer-delivered').map(({ message }) => ({ from: message.from, to: message.to, correlationId: message.correlationId })))
        .toEqual([{ from: 'unode', to: 'pm', correlationId: handle }]);
      expect(replies('dev')).toContain(`The PM answered the question on this task (${id}): Use a bulleted list.`);

      devMayGoOn.open();
      await pumpWhile(() => !replies('pm').includes('The list is in list.txt.'), screen.pump);
      expect(replies('pm')).toContain('The list is in list.txt.');
      // The running turn read it; the same attempt produced one result, which woke the PM once.
      expect(devRequests.some((request) => userTexts(request).some((text) => text.includes(`Your coordinator answered your question on this task (${id}): Use a bulleted list.`)))).toBe(true);
      expect(devRequests.filter((request) => !lastToolResult(request))).toHaveLength(1);
      expect(resultWakes).toHaveLength(1);
      expect(resultWakes[0]).toContain('Saved list.txt as a bulleted list.');
      expect(sentOf(send).filter(({ message }) => message.from === 'dev' && message.correlationId === handle
        && (message.type === 'task.complete' || message.type === 'task.partial'))).toHaveLength(1);
      await pumpWhile(() => screen.strip().length, screen.pump);
      expect(screen.strip()).toEqual([]);

      // §5.6: the answer and its receipts are non-actionable host facts. Each delivered again, as it was and under a
      // new bus id, starts no turn and adds nothing to either chat.
      const records = exchangeRecords(send).map(({ message }) => message);
      expect(records.map((message) => (message.payload.metadata as { taskExchange: { fact: string } }).taskExchange.fact))
        .toEqual(['message-delivered', 'answer-queued', 'answer-delivered']);
      const bus = send.mock.contexts[sentOf(send).findIndex(({ message }) => message === records[0])] as MessageBus;
      const before = { requests: requests.length, pm: replies('pm').length, dev: replies('dev').length };
      for (const message of records) {
        (bus as unknown as { matchSubscribers(message: Message): void }).matchSubscribers(message);
        bus.send(message.from, message.to, 'ask.answer', { ...message.payload }, 'normal', message.correlationId);
      }
      for (let i = 0; i < 10; i++) await screen.pump();
      expect({ requests: requests.length, pm: replies('pm').length, dev: replies('dev').length }).toEqual(before);
    } finally {
      send.mockRestore();
    }
  });

  it('Answer queued before the teammate\'s turn ends, on a route that cannot take it: at that turn end no result, no attempt-terminal callback and no grant cleanup; then the same attempt continues and yields exactly one result under the original handle', async () => {
    const before = begunRequests.snapshot(usageUnits());
    const send = vi.spyOn(MessageBus.prototype, 'send');
    const steer = vi.spyOn(OpenAICompatBackend.prototype, 'steerNotice').mockResolvedValue(false);
    const terminalCallback = vi.spyOn(TaskInputResolver.prototype, 'reviewObservationForAttempt');
    const endAttempt = vi.spyOn(TaskInputResolver.prototype, 'endAttempt');
    try {
      const devMayEnd = gate();
      const devAsked = signal();
      let handle = '';
      let answered = '';
      const resultWakes: string[] = [];
      scripts.set('pm-model', (request) => {
        const said = latestUser(request);
        const tool = lastToolResult(request);
        if (messageWake.test(said)) {
          if (tool) { answered = tool; return { text: 'Answered Dev: a table.' }; }
          return { calls: [{ name: 'reply_to_task', args: { handle, exchange_id: exchangeOf(said), text: 'A table.' } }] };
        }
        if (said.includes('Async delegation result')) {
          if (tool) return { text: 'The table is in table.txt.' };
          resultWakes.push(said);
          return { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] };
        }
        if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev is writing the table.' }; }
        return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write table.txt.', contract: contractFor('table.txt') } }] };
      });
      const devRequests: ModelRequest[] = [];
      scripts.set('dev-model', async (request) => {
        devRequests.push(request);
        const tool = lastToolResult(request);
        if (!tool) {
          return latestUser(request).includes('[Continuation of your assigned task]')
            ? { calls: [{ name: 'write_file', args: { path: 'table.txt', content: '| a |' } }] }
            : { calls: [{ name: 'send_message', args: { target: 'coordinator', message: 'Which format, table or list?', kind: 'question' } }] };
        }
        if (tool.includes('Sent to your coordinator')) { devAsked.fire(); await devMayEnd.shut; return { text: 'I wait for the answer on the format.' }; }
        return { text: 'Saved table.txt as a table.' };
      });
      await screen.select('pm');
      await screen.send('Please write the table.');
      await reach(devAsked.fired, 'Dev never asked');
      await pumpWhile(() => !answered, screen.pump);
      expect(answered).toContain('It goes into Dev\'s running turn on this task if that turn can still read it; otherwise it continues the same task');
      // The route refused it in-turn: the answer is queued, owed to Dev's attempt.
      expect(steer).toHaveBeenCalled();
      expect(exchangeRecords(send, 'answer-delivered')).toEqual([]);
      const assign = sentOf(send).find(({ message }) => message.type === 'task.assign' && message.correlationId === handle)!.message;
      const attemptId = assign.payload.taskAttempt!.attemptId;

      devMayEnd.open();
      await pumpWhile(() => !replies('pm').includes('The table is in table.txt.'), screen.pump);
      expect(replies('pm'), JSON.stringify(replies('pm').slice(-4))).toContain('The table is in table.txt.');
      const sent = sentOf(send);
      const waiting = sent.filter(({ message }) => message.type === 'task.status' && message.correlationId === handle
        && (message.payload.metadata as { taskWaiting?: unknown } | undefined)?.taskWaiting);
      const results = sent.filter(({ message }) => message.from === 'dev' && message.correlationId === handle
        && (message.type === 'task.complete' || message.type === 'task.partial' || message.type === 'system.error'));
      // At the turn end: its reply kept as a progress note on the task, and no correlated result.
      expect(waiting.map(({ message }) => message.payload.instruction)).toEqual(['I wait for the answer on the format.']);
      expect(replies('dev')).toContain('I wait for the answer on the format.');
      // Exactly one result, the continuation's, under the original handle, to the original coordinator.
      expect(results.map(({ message }) => ({ type: message.type, to: message.to, text: message.payload.instruction })))
        .toEqual([{ type: 'task.complete', to: 'pm', text: 'Saved table.txt as a table.' }]);
      expect(results[0].order).toBeGreaterThan(waiting[0].order);
      // No attempt-terminal callback and no grant cleanup at the checkpoint: both only with the one result.
      const callbacks = terminalCallback.mock.calls.map((call, index) => ({ id: call[0], order: terminalCallback.mock.invocationCallOrder[index] }))
        .filter((call) => call.id === attemptId);
      expect(callbacks).toHaveLength(1);
      expect(callbacks[0].order).toBeGreaterThan(waiting[0].order);
      const cleanups = endAttempt.mock.calls.map((call, index) => ({ id: call[0], order: endAttempt.mock.invocationCallOrder[index] }))
        .filter((call) => call.id === attemptId);
      expect(cleanups.every((cleanup) => cleanup.order > results[0].order), JSON.stringify(cleanups)).toBe(true);
      // The continuation is the same attempt: no new dispatch, the answer in its input, its request the task's.
      expect(sent.filter(({ message }) => message.type === 'task.assign' && message.to === 'dev')).toHaveLength(1);
      const id = exchangeRecords(send, 'answer-queued')[0].message.payload.metadata!.taskExchange as { exchangeId: string };
      expect(devRequests.filter((request) => !lastToolResult(request)).map(latestUser)[1])
        .toContain(`- Your question (${id.exchangeId}): Which format, table or list?\n  Answer: A table.`);
      expect(exchangeRecords(send, 'answer-delivered')).toHaveLength(1);
      expect(fs.readFileSync(path.join(workspace, 'table.txt'), 'utf8')).toBe('| a |');
      expect(resultWakes).toHaveLength(1);
      let units = unitsSince(usageUnits(), before);
      for (const deadline = wallDeadline(); (units.filter((unit) => unit.agentId === 'dev').length < 2) && beforeDeadline(deadline);) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        units = unitsSince(usageUnits(), before);
      }
      // Every turn of this test, once each agent's count arrived: a unit of this test charged to an earlier
      // test's request would be left out by unitsSince, and this count would then come up short (Codex's audit of fbc6c852).
      units = await unitsReaching(usageUnits, before, { pm: 3, dev: 2 });
      expect(perAgent(units), JSON.stringify(units)).toEqual({ pm: 3, dev: 2 });
      const devUnits = units.filter((unit) => unit.agentId === 'dev');
      expect(devUnits.length, JSON.stringify(units)).toBeGreaterThanOrEqual(2);
      expect(new Set(devUnits.map((unit) => unit.requestId)).size).toBe(1);
      expect(units.filter((unit) => unit.agentId === 'pm').map((unit) => unit.requestId)).toContain(devUnits[0].requestId);
      expect((await storedDelegationIn(handle, 'settled'))?.state).toBe('settled');
      expect((await storedDelegations()).filter((delegation) => delegation.handle === handle)).toHaveLength(1);
    } finally {
      send.mockRestore();
      steer.mockRestore();
      terminalCallback.mockRestore();
      endAttempt.mockRestore();
    }
  });

  it('Teammate ends its turn waiting; the answer comes later and continues the same attempt; a second answer to the same exchange is refused', async () => {
    const before = begunRequests.snapshot(usageUnits());
    const send = vi.spyOn(MessageBus.prototype, 'send');
    const endAttempt = vi.spyOn(TaskInputResolver.prototype, 'endAttempt');
    try {
      let handle = '';
      let id = '';
      let answered = '';
      scripts.set('pm-model', (request) => {
        const said = latestUser(request);
        const tool = lastToolResult(request);
        if (messageWake.test(said)) { id = exchangeOf(said); return { text: 'I asked the person about the format.' }; }
        if (said.includes('Use a table for Dev.')) {
          if (tool) {
            // The backend answers the two calls one after the other: both results follow the person's message.
            const asked = request.messages.map((message) => message.role).lastIndexOf('user');
            answered = request.messages.slice(asked + 1).filter((message) => message.role === 'tool').map((message) => textOf(message.content)).join(' | ');
            return { text: 'Told Dev: a table.' };
          }
          return { calls: [
            { name: 'reply_to_task', args: { handle, exchange_id: id, text: 'A table, please.' } },
            { name: 'reply_to_task', args: { handle, exchange_id: id, text: 'Actually a list.' } },
          ] };
        }
        if (said.includes('Async delegation result')) {
          return tool ? { text: 'The format note is in format.txt.' } : { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] };
        }
        if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev is writing the format note.' }; }
        return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write format.txt.', contract: contractFor('format.txt') } }] };
      });
      const devRequests: ModelRequest[] = [];
      scripts.set('dev-model', (request) => {
        devRequests.push(request);
        const tool = lastToolResult(request);
        if (!tool) {
          return latestUser(request).includes('[Continuation of your assigned task]')
            ? { calls: [{ name: 'write_file', args: { path: 'format.txt', content: 'Table.' } }] }
            : { calls: [{ name: 'send_message', args: { target: 'coordinator', message: 'Table or list?', kind: 'question' } }] };
        }
        if (tool.includes('Sent to your coordinator')) return { text: 'Waiting for the PM on the format.' };
        return { text: 'Saved format.txt.' };
      });
      await screen.select('pm');
      await screen.send('Please write the format note.');
      await pumpWhile(() => !replies('pm').includes('I asked the person about the format.'), screen.pump);
      expect(replies('pm')).toContain('I asked the person about the format.');
      await pumpWhile(() => !replies('dev').includes('Waiting for the PM on the format.'), screen.pump);
      // Dev's turn ended waiting: no result is recorded, its grants stay, its task is still active.
      expect(replies('dev')).toContain('Waiting for the PM on the format.');
      expect(sentOf(send).filter(({ message }) => message.from === 'dev' && message.correlationId === handle
        && (message.type === 'task.complete' || message.type === 'task.partial' || message.type === 'system.error'))).toEqual([]);
      const attemptId = sentOf(send).find(({ message }) => message.type === 'task.assign' && message.correlationId === handle)!.message.payload.taskAttempt!.attemptId;
      expect(endAttempt.mock.calls.filter((call) => call[0] === attemptId)).toEqual([]);
      expect((await storedDelegationIn(handle, 'active'))?.state).toBe('active');
      expect(devRequests.filter((request) => !lastToolResult(request))).toHaveLength(1);

      // The person answers through the PM, in a request of their own; the answer continues Dev's attempt.
      await screen.send('Use a table for Dev.');
      await pumpWhile(() => !replies('pm').includes('The format note is in format.txt.'), screen.pump);
      expect(replies('pm'), JSON.stringify(replies('pm').slice(-4))).toContain('The format note is in format.txt.');
      // A second answer to the same exchange is refused with the reason; it answers nothing else.
      expect(answered).toContain(`Answer accepted for Dev's question (${id}).`);
      expect(answered).toContain(`Error: exchange ${id} was already answered. A second answer is refused, and it answers nothing else on handle ${handle}. Nothing was sent.`);
      expect(exchangeRecords(send, 'answer-queued')).toHaveLength(1);
      const continuation = devRequests.filter((request) => !lastToolResult(request)).map(latestUser);
      expect(continuation).toHaveLength(2);
      expect(continuation[1]).toContain('Answer: A table, please.');
      expect(continuation[1]).not.toContain('Actually a list.');
      expect(fs.readFileSync(path.join(workspace, 'format.txt'), 'utf8')).toBe('Table.');
      // Charged to the request the task belongs to, not to the person's later request that carried the answer.
      let units = unitsSince(usageUnits(), before);
      for (const deadline = wallDeadline(); (units.filter((unit) => unit.agentId === 'dev').length < 2) && beforeDeadline(deadline);) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        units = unitsSince(usageUnits(), before);
      }
      // Every turn of this test, once each agent's count arrived: a unit of this test charged to an earlier
      // test's request would be left out by unitsSince, and this count would then come up short (Codex's audit of fbc6c852).
      units = await unitsReaching(usageUnits, before, { pm: 4, dev: 2 });
      expect(perAgent(units), JSON.stringify(units)).toEqual({ pm: 4, dev: 2 });
      const devUnits = units.filter((unit) => unit.agentId === 'dev');
      expect(new Set(devUnits.map((unit) => unit.requestId)).size, JSON.stringify(units)).toBe(1);
      expect(new Set(units.filter((unit) => unit.agentId === 'pm').map((unit) => unit.requestId)).size).toBe(2);
    } finally {
      send.mockRestore();
      endAttempt.mockRestore();
    }
  });

  it('Stop while an answer is queued: Dev\'s turn ends as a stopped turn does, the exchange closes undelivered and the PM is told; nothing restarts', async () => {
    const send = vi.spyOn(MessageBus.prototype, 'send');
    const steer = vi.spyOn(OpenAICompatBackend.prototype, 'steerNotice').mockResolvedValue(false);
    try {
      const devAsked = signal();
      let handle = '';
      let answered = '';
      scripts.set('pm-model', (request) => {
        const said = latestUser(request);
        const tool = lastToolResult(request);
        if (messageWake.test(said)) {
          if (tool) { answered = tool; return { text: 'Answered Dev: plain text.' }; }
          return { calls: [{ name: 'reply_to_task', args: { handle, exchange_id: exchangeOf(said), text: 'Plain text.' } }] };
        }
        if (said.includes('Async delegation result')) return { text: 'Noted.' };
        if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev is writing the memo.' }; }
        return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write memo.txt.', contract: contractFor('memo.txt') } }] };
      });
      const devRequests: ModelRequest[] = [];
      scripts.set('dev-model', (request) => {
        devRequests.push(request);
        const tool = lastToolResult(request);
        if (!tool) return { calls: [{ name: 'send_message', args: { target: 'coordinator', message: 'Markdown or plain text?', kind: 'question' } }] };
        devAsked.fire();
        return new Promise<ModelAnswer>(() => { /* still working when the person presses Stop */ });
      });
      await screen.select('pm');
      await screen.send('Please write the memo.');
      await reach(devAsked.fired, 'Dev never asked');
      await pumpWhile(() => !answered, screen.pump);
      expect(answered).toContain('Answer accepted');
      const id = (exchangeRecords(send, 'answer-queued')[0].message.payload.metadata!.taskExchange as { exchangeId: string }).exchangeId;

      await screen.select('dev');
      await screen.stop();
      await pumpWhile(() => !exchangeRecords(send, 'closed').length, screen.pump);
      expect(exchangeRecords(send, 'closed').map(({ message }) => message.payload.metadata!.taskExchange))
        .toEqual([expect.objectContaining({ exchangeId: id, handle, delivered: false })]);
      expect(sentOf(send).filter(({ message }) => message.from === 'dev' && message.correlationId === handle && message.type === 'system.error')
        .map(({ message }) => (message.payload.metadata as { cancelled?: unknown }).cancelled)).toEqual([true]);
      expect(replies('pm').some((text) => text.startsWith(`Dev's question on its task ${handle} (${id}) closed without an answer reaching it: the teammate was stopped`)))
        .toBe(true);
      // Nothing restarts: the answer is never delivered, and Dev runs no continuation.
      const count = requests.length;
      for (let i = 0; i < 20; i++) await screen.pump();
      expect(requests.length).toBe(count);
      expect(exchangeRecords(send, 'answer-delivered')).toEqual([]);
      expect(devRequests.some((request) => latestUser(request).includes('[Continuation of your assigned task]'))).toBe(false);
    } finally {
      send.mockRestore();
      steer.mockRestore();
    }
  });

  it('Stop during an open question: the question is not answered later, nothing restarts, and what Dev already said is kept', async () => {
    const send = vi.spyOn(MessageBus.prototype, 'send');
    try {
      const pmInWake = signal();
      let handle = '';
      let id = '';
      let refused = '';
      scripts.set('pm-model', (request) => {
        const said = latestUser(request);
        const tool = lastToolResult(request);
        if (messageWake.test(said)) { id = exchangeOf(said); pmInWake.fire(); return new Promise<ModelAnswer>(() => { /* thinking when the person presses Stop */ }); }
        if (said.includes('Answer Dev now.')) {
          if (tool) { refused = tool; return { text: 'Dev\'s question is closed.' }; }
          return { calls: [{ name: 'reply_to_task', args: { handle, exchange_id: id, text: 'Plain text.' } }] };
        }
        if (said.includes('Async delegation result')) return { text: 'Noted.' };
        if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev is writing the brief.' }; }
        return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write brief.txt.', contract: contractFor('brief.txt') } }] };
      });
      const devRequests: ModelRequest[] = [];
      scripts.set('dev-model', (request) => {
        devRequests.push(request);
        const tool = lastToolResult(request);
        if (!tool) return { calls: [{ name: 'send_message', args: { target: 'coordinator', message: 'How long should the brief be?', kind: 'question' } }] };
        return { text: 'Waiting for the length of the brief.' };
      });
      await screen.select('pm');
      await screen.send('Please write the brief.');
      await reach(pmInWake.fired, 'the PM was never woken with the question');
      await pumpWhile(() => !replies('dev').includes('Waiting for the length of the brief.'), screen.pump);
      await screen.select('pm');
      await screen.stop();
      await pumpWhile(() => !exchangeRecords(send, 'closed').length, screen.pump);
      expect(exchangeRecords(send, 'closed').map(({ message }) => message.payload.metadata!.taskExchange))
        .toEqual([expect.objectContaining({ exchangeId: id, delivered: false })]);

      // Later, the PM tries to answer: refused; Dev is not continued.
      await screen.send('Answer Dev now.');
      await pumpWhile(() => !replies('pm').includes('Dev\'s question is closed.'), screen.pump);
      expect(refused).toMatch(new RegExp(`^Error: exchange ${id} is closed: `));
      expect(refused).toContain('Nothing was sent.');
      expect(devRequests.some((request) => latestUser(request).includes('[Continuation of your assigned task]'))).toBe(false);
      expect(exchangeRecords(send, 'answer-queued')).toEqual([]);
      // What Dev said is kept in its chat.
      expect(replies('dev')).toContain('Waiting for the length of the brief.');
    } finally {
      send.mockRestore();
    }
  });

  it('Reload with an open question: after the reload the task is interrupted, not waiting or running, and nothing is replayed as new work', async () => {
    const send = vi.spyOn(MessageBus.prototype, 'send');
    try {
      let handle = '';
      let woken = false;
      scripts.set('pm-model', (request) => {
        const said = latestUser(request);
        const tool = lastToolResult(request);
        if (messageWake.test(said)) { woken = true; return { text: 'I will ask the person about the audience.' }; }
        if (said.includes('Async delegation result')) return { text: 'Noted.' };
        if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev is writing the abstract.' }; }
        return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write abstract.txt.', contract: contractFor('abstract.txt') } }] };
      });
      scripts.set('dev-model', (request) => (lastToolResult(request)
        ? { text: 'Waiting for the audience.' }
        : { calls: [{ name: 'send_message', args: { target: 'coordinator', message: 'Who is the audience?', kind: 'question' } }] }));
      await screen.select('pm');
      await screen.send('Please write the abstract.');
      await pumpWhile(() => !(woken && replies('dev').includes('Waiting for the audience.')), screen.pump);
      expect(replies('dev')).toContain('Waiting for the audience.');
      expect(handle, 'the PM saw its dispatch handle').not.toBe('');
      // The run ledger is written asynchronously; under load one fixed wait can read it before the write lands.
      expect((await storedDelegationIn(handle, 'active'))?.state).toBe('active');

      // The window reloads: the stored record of the waiting task is read by a new host and reconciled as activation does.
      const reloaded = await reloadedStrip();
      const record = reloaded.ledger.snapshot().flatMap((run) => run.delegations).find((delegation) => delegation.handle === handle);
      expect(record?.state).toBe('interrupted');
      expect(reloaded.lines.some((line) => line.startsWith('Running'))).toBe(false);
      // The question is in the task's record; the bus history a reload restores is never dispatched again.
      const run = reloaded.ledger.snapshot().find((candidate) => candidate.delegations.some((delegation) => delegation.handle === handle))!;
      expect(run.activity.some((item) => item.type === 'agent.message' && item.content.includes('Who is the audience?'))).toBe(true);
      const restored = new MessageBus();
      const dispatched: Message[] = [];
      restored.subscribe({}, (message) => { dispatched.push(message); });
      restored.importMessages(sentOf(send).map(({ message }) => message));
      expect(dispatched).toEqual([]);
      expect(restored.query({ type: 'agent.message' }).some((message) => message.payload.message === 'Who is the audience?')).toBe(true);
    } finally {
      send.mockRestore();
      // This window was not really reloaded: the person stops Dev, which ends its waiting task.
      await (host.commands.get('unode.agentStop') as (id: string) => Promise<unknown>)('dev');
      await screen.pump();
    }
  });

  /**
   * The tool results after the latest user message: this turn's own. A teammate's conversation runs across these flows, and an
   * earlier flow's cut-off call can stand last in it.
   */
  const toolSinceUser = (request: ModelRequest): string | undefined => {
    const at = request.messages.map((message) => message.role).lastIndexOf('user');
    const tools = request.messages.slice(at + 1).filter((message) => message.role === 'tool').map((message) => textOf(message.content));
    return tools.length ? tools.at(-1) : undefined;
  };

  /*
   * Audit of 04d94a29, I1: a rework turn carries no attempt card, so no answer can come back into it. Dev, asked to rework,
   * needs a decision: it asks, is told truthfully how to proceed, and ends its turn saying what it needs; the PM sends the
   * task back with the answer; Dev writes the revision. The artifact and the task's result are observed together.
   */
  it('Rework that needs an answer: the receipt says no answer comes back into a rework turn; Dev says what it needs, the PM sends the task back with the answer, and the revision lands', async () => {
    const send = vi.spyOn(MessageBus.prototype, 'send');
    try {
      let handle = '';
      let receipt = '';
      const questionWakes: string[] = [];
      const reworkReplies: string[] = [];
      const devReworkInputs: string[] = [];
      scripts.set('pm-model', (request) => {
        const said = latestUser(request);
        const tool = lastToolResult(request);
        if (said.includes('Should the ledger totals include tax?')) questionWakes.push(said);
        if (said.includes('[rework reply]')) {
          if (!tool) reworkReplies.push(said);
          if (said.includes('I need to know whether the ledger totals include tax.')) {
            return tool ? { text: 'Sent the tax answer back to Dev.' }
              : { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'needs-rework', reason: 'Answer: include tax in the ledger totals.' } }] };
          }
          return tool ? { text: 'The revised ledger summary is accepted.' }
            : { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] };
        }
        if (said.includes('Async delegation result')) {
          return tool ? { text: 'Asked Dev to add the ledger totals.' }
            : { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'needs-rework', reason: 'Add the ledger totals.' } }] };
        }
        if (messageWake.test(said)) return { text: 'Dev asked about tax in the ledger.' };
        if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev is writing the ledger summary.' }; }
        return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write ledger.txt.', contract: contractFor('ledger.txt') } }] };
      });
      scripts.set('dev-model', (request) => {
        const said = latestUser(request);
        const tool = toolSinceUser(request);
        if (said.includes('include tax in the ledger totals')) {
          if (!tool) devReworkInputs.push(said);
          return tool ? { text: 'Saved ledger.txt with the totals including tax.' }
            : { calls: [{ name: 'write_file', args: { path: 'ledger.txt', content: 'Totals: 110 (tax included).' } }] };
        }
        if (said.includes('Add the ledger totals.')) {
          if (!tool) return { calls: [{ name: 'send_message', args: { target: 'coordinator', message: 'Should the ledger totals include tax?', kind: 'question' } }] };
          receipt = tool;
          // Dev follows the receipt: it cannot go on without the answer, so it says exactly what it needs.
          return { text: 'I need to know whether the ledger totals include tax.' };
        }
        return tool ? { text: 'Saved ledger.txt.' } : { calls: [{ name: 'write_file', args: { path: 'ledger.txt', content: 'Ledger.' } }] };
      });
      await screen.select('pm');
      await screen.send('Please write the ledger summary.');
      // The PM's reply may carry the host's closing note after it.
      const accepted = () => replies('pm').some((text) => text.startsWith('The revised ledger summary is accepted.'));
      await pumpWhile(() => !accepted(), screen.pump);
      expect(accepted(), JSON.stringify(replies('pm').slice(-6))).toBe(true);
      // The receipt told the truth about the rework turn, and the PM's wake offered no answer route into it.
      expect(receipt).toBe('Sent to your coordinator as a question on this task; the PM is told. In a rework turn the answer does '
        + 'not come back into this turn: finish what you can, and if you need the answer, end your turn saying exactly what you '
        + 'need; the PM can send the task back to you with it.');
      expect(questionWakes.length).toBeGreaterThanOrEqual(1);
      expect(questionWakes[0]).toContain(`Asked in a rework turn: no answer can go into it. When Dev's result says what it needs, send the task back with the answer: record_task_disposition needs-rework on handle "${handle}".`);
      expect(questionWakes[0]).not.toMatch(/exchange exchange-/);
      expect(exchangeRecords(send, 'answer-queued')).toEqual([]);
      // Dev's result said what it needed; the PM sent the task back with the answer; Dev's next turn had it.
      expect(reworkReplies[0]).toContain('I need to know whether the ledger totals include tax.');
      expect(devReworkInputs).toHaveLength(1);
      expect(devReworkInputs[0]).toContain('include tax in the ledger totals');
      // The artifact and the task's result, together: the revision, and the result that reports it.
      expect(fs.readFileSync(path.join(workspace, 'ledger.txt'), 'utf8')).toBe('Totals: 110 (tax included).');
      expect(reworkReplies.at(-1)).toContain('Saved ledger.txt with the totals including tax.');
      const results = sentOf(send).filter(({ message }) => message.from === 'dev' && message.correlationId === handle
        && (message.type === 'task.complete' || message.type === 'task.partial' || message.type === 'system.error'));
      expect(results.at(-1)?.message).toMatchObject({ type: 'task.complete', payload: { instruction: 'Saved ledger.txt with the totals including tax.' } });
    } finally {
      send.mockRestore();
    }
  });

  /*
   * Audit of 04d94a29, I2: Dev's turn ends waiting for an answer, then its process is lost. The task ends as a lost
   * worker's does, interrupted; the waiting note is never its result. Observed where results are consumed: the PM is not
   * woken with a result, and the stored task reads interrupted.
   */
  it('A waiting teammate\'s process is lost: the task ends interrupted, its waiting note is no result, the exchange closes undelivered and nothing starts', async () => {
    const send = vi.spyOn(MessageBus.prototype, 'send');
    const turns = vi.spyOn(OpenAICompatBackend.prototype, 'sendUserTurn');
    const endAttempt = vi.spyOn(TaskInputResolver.prototype, 'endAttempt');
    try {
      let handle = '';
      let resultWakes = 0;
      let asked = false;
      scripts.set('pm-model', (request) => {
        const said = latestUser(request);
        const tool = lastToolResult(request);
        if (said.includes('Async delegation result')) { resultWakes++; return { text: 'An audit result came in.' }; }
        if (messageWake.test(said)) { asked = true; return { text: 'I will ask the person about the audit scope.' }; }
        if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev is writing the audit.' }; }
        return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write audit.txt.', contract: contractFor('audit.txt') } }] };
      });
      const devRequests: ModelRequest[] = [];
      scripts.set('dev-model', (request) => {
        devRequests.push(request);
        return toolSinceUser(request) ? { text: 'Waiting for the audit scope.' }
          : { calls: [{ name: 'send_message', args: { target: 'coordinator', message: 'Which audit scope?', kind: 'question' } }] };
      });
      await screen.select('pm');
      await screen.send('Please write the audit.');
      await pumpWhile(() => !(asked && replies('dev').includes('Waiting for the audit scope.')), screen.pump);
      expect(replies('dev')).toContain('Waiting for the audit scope.');
      expect((await storedDelegationIn(handle, 'active'))?.state).toBe('active');
      const assign = sentOf(send).find(({ message }) => message.type === 'task.assign' && message.correlationId === handle)!.message;
      const attemptId = assign.payload.taskAttempt!.attemptId;
      const id = (exchangeRecords(send, 'message-delivered')[0].message.payload.metadata!.taskExchange as { exchangeId: string }).exchangeId;

      // Dev's process is lost while it waits.
      const at = turns.mock.calls.findIndex((call) => String(call[0]).includes('Write audit.txt.'));
      const backend = turns.mock.contexts[at] as unknown as { emit(event: unknown): void };
      backend.emit({ kind: 'exit', code: 1 });
      await pumpWhile(() => !sentOf(send).some(({ message }) => message.from === 'dev' && message.correlationId === handle
        && message.type === 'system.error'), screen.pump);
      for (let i = 0; i < 20; i++) await screen.pump();
      const ends = sentOf(send).filter(({ message }) => message.from === 'dev' && message.correlationId === handle
        && (message.type === 'task.complete' || message.type === 'task.partial' || message.type === 'system.error'));
      expect(ends.map(({ message }) => message.type)).toEqual(['system.error']);
      expect(ends[0].message.payload.metadata).toMatchObject({ interrupted: true, interruptionReason: 'worker-lost',
        taskExchanges: { undelivered: [{ exchangeId: id }] } });
      expect(ends[0].message.payload.instruction).not.toContain('Waiting for the audit scope.');
      // The result consumers: no result woke the PM, and the stored task reads interrupted, not settled.
      expect(resultWakes).toBe(0);
      expect((await storedDelegationIn(handle, 'interrupted'))?.state).toBe('interrupted');
      // Its grants end once, as a lost worker's attempt; the PM is told about the question; nothing starts.
      expect(endAttempt.mock.calls.filter((call) => call[0] === attemptId)).toEqual([[attemptId, 'interrupted']]);
      expect(replies('pm')).toContain(`Dev's question on its task ${handle} (${id}) closed without an answer reaching it: the teammate's process ended before the answer reached it.`);
      expect(devRequests.filter((request) => !lastToolResult(request))).toHaveLength(1);
    } finally {
      send.mockRestore();
      turns.mockRestore();
      endAttempt.mockRestore();
    }
  });

  it('An answer to a finished task: Dev\'s task ended in an error before the answer; the PM\'s answer is refused with the reason, and no rework starts', async () => {
    const send = vi.spyOn(MessageBus.prototype, 'send');
    try {
      let handle = '';
      let refused = '';
      const wakes: string[] = [];
      scripts.set('pm-model', async (request) => {
        const said = latestUser(request);
        const tool = lastToolResult(request);
        if (said.includes('Async delegation result') || messageWake.test(said)) {
          if (tool) { refused = refused || tool; return { text: 'Dev\'s task failed before I could answer.' }; }
          wakes.push(said);
          const id = exchangeOf(said);
          return id ? { calls: [{ name: 'reply_to_task', args: { handle, exchange_id: id, text: 'Use the 2025 figures.' } }] }
            : { text: 'Waiting for Dev.' };
        }
        if (tool) {
          handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle;
          // The PM's turn ends only after Dev's task has ended, so its answer comes after that end.
          await pumpWhile(() => !exchangeRecords(send, 'closed').length, () => new Promise<void>((resolve) => setTimeout(resolve, 10)));
          return { text: 'Dev is writing the figures.' };
        }
        return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write figures.txt.', contract: contractFor('figures.txt') } }] };
      });
      const devRequests: ModelRequest[] = [];
      scripts.set('dev-model', (request) => {
        devRequests.push(request);
        // The model provider fails Dev's next request: its turn ends in an error, a terminal outcome.
        scripts.delete('dev-model');
        return { calls: [{ name: 'send_message', args: { target: 'coordinator', message: 'Which year\'s figures?', kind: 'question' } }] };
      });
      await screen.select('pm');
      await screen.send('Please write the figures.');
      const failed = () => replies('pm').some((text) => text.startsWith('Dev\'s task failed before I could answer.'));
      await pumpWhile(() => !failed(), screen.pump);
      expect(failed(), JSON.stringify(replies('pm').slice(-4))).toBe(true);
      const closed = exchangeRecords(send, 'closed').map(({ message }) => message.payload.metadata!.taskExchange as { exchangeId: string; reason: string });
      expect(closed).toHaveLength(1);
      expect(refused).toMatch(new RegExp(`^Error: task ${handle} already ended \\(the task ended in an error before the answer reached it\\), so exchange ${closed[0].exchangeId} cannot be answered\\. A change to finished work is a rework, not an answer: record needs-rework on its result with record_task_disposition\\.`));
      // The PM was told on the handle, in the result it was woken with.
      expect(wakes.join('\n')).toContain(`[exchanges] Question ${closed[0].exchangeId} closed without its answer reaching the teammate: the task ended in an error before the answer reached it. It cannot be answered any more.`);
      // No silent rework: Dev was not started again.
      expect(devRequests.filter((request) => !lastToolResult(request))).toHaveLength(1);
      expect(exchangeRecords(send, 'answer-queued')).toEqual([]);
    } finally {
      send.mockRestore();
    }
  });

});

/**
 * v0.9.103 (DESIGN_v09103_cli_teammate_messages §3, test 9): the factory activate() itself uses gives a Claude CLI and a
 * Codex CLI agent whose role may message the activation's own bus and resolver, by identity. Built, never started: no
 * process, model or App Server. Supplemental to the adapter and lifecycle tests, which observe the behaviour.
 */
/*
 * v0.9.103 (F1): a restart of the PM that UnodeAi makes, not the person's Stop. The PM's task out with Dev ends
 * interrupted (`host-stopped`), never cancelled: the stored runs and a reload say so, the PM's chat says why without
 * the word "cancelled", and the PM can redo it with replaces_handle. The person presses Restart in the agent's menu
 * (the `unode.agentRestart` command activation registers).
 */
