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
 * own activate(): this file has the PM and its teammate (v0.9.102), the PM restart (F1) and the CLI bus;
 * ActivatedExtension.messages.flows.test.ts and ActivatedExtension.questions.flows.test.ts have the rest.
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
  endFakeTimers, flush, memento, scripts, requests, textOf, latestUser, lastToolResult, chatScreen, base, workspace, sibling, elsewhere, context, agent, reloadedStrip, readReloadedStrip, storedDelegations, storedDelegationIn, replies, installActivatedExtension, type ModelRequest, type ModelAnswer, untilCurrent, pumpWhile, wallDeadline, beforeDeadline,
} from './support/activatedHarness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let screen: ReturnType<typeof chatScreen>;
let chatProvider: any;
installActivatedExtension(host, (ready) => { chatProvider = ready.chatProvider; screen = ready.screen; });


describe('v0.9.102 the extension through activate(): a PM and its teammate on scripted models', () => {
  it('a message to the PM, typed and sent in the chat, reaches its model and its reply is kept in the PM\'s chat', async () => {
    scripts.set('pm-model', () => ({ text: 'Hello from the PM.' }));
    await screen.select('pm');
    await screen.send('Hello?');
    await pumpWhile(() => !replies('pm').includes('Hello from the PM.'), screen.pump);
    expect(requests.some((request) => request.model === 'pm-model')).toBe(true);
    expect(replies('pm')).toContain('Hello from the PM.');
    // The reply's footer holds its turn's facts only.
    expect(screen.footers().join(' ')).not.toMatch(/PM status/);
  });

  it('the PM delegates: the strip says the teammate runs, then the result wakes the PM, it reports, and the strip is empty', async () => {
    let release!: () => void;
    const devMayAnswer = new Promise<void>((resolve) => { release = resolve; });
    let handle = '';
    scripts.set('pm-model', (request) => {
      const tool = lastToolResult(request);
      const woken = latestUser(request).includes('Async delegation result');
      if (woken && !tool) return { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] };
      if (woken) return { text: 'The summary is saved in summary.txt.' };
      if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev is writing the summary.' }; }
      return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write a one-line summary into summary.txt.', contract: {
        version: 2, objective: 'Write a one-line summary.', expected_deliverable: 'summary.txt',
        effects: { read_files: [], expected_file_effect: 'create' }, inputs: [],
        outputs: [{ output_id: 'summary', path: path.join(workspace, 'summary.txt'), kind: 'file', required: true }],
        constraints: [], dependencies: [], required_capabilities: { version: 1, capabilities: ['write'] },
        execution_strategy: 'delegate-required' } } }] };
    });
    scripts.set('dev-model', async (request) => {
      if (lastToolResult(request)) return { text: 'Saved summary.txt.' };
      await devMayAnswer;
      return { calls: [{ name: 'write_file', args: { path: 'summary.txt', content: 'A one-line summary.' } }] };
    });
    await screen.select('pm');
    await screen.send('Please write the summary.');
    await pumpWhile(() => !replies('pm').includes('Dev is writing the summary.'), screen.pump);
    expect(replies('pm'), JSON.stringify({ replies: replies('pm'), tools: requests.filter((r) => r.model === 'pm-model').map((r) => lastToolResult(r)?.slice(0, 400)), warnings: host.warnings.slice(2) })).toContain('Dev is writing the summary.');
    await pumpWhile(() => !screen.strip().some((line) => line.startsWith('Running: Dev')), screen.pump);
    expect(screen.strip()[0]).toMatch(/^Running: Dev \((under 1 min|\d+ min)\)\.$/);
    expect(screen.strip()).toContain('The PM reports here when results come back.');
    // The teammate finishes: its result wakes the PM, which reports; nothing is left to show.
    release();
    await pumpWhile(() => !replies('pm').includes('The summary is saved in summary.txt.'), screen.pump);
    expect(replies('pm'), JSON.stringify({ requests: requests.map((r) => r.model), strip: screen.strip() })).toContain('The summary is saved in summary.txt.');
    expect(fs.readFileSync(path.join(workspace, 'summary.txt'), 'utf8')).toBe('A one-line summary.');
    await pumpWhile(() => screen.strip().length, screen.pump);
    expect(screen.strip()).toEqual([]);
    expect(screen.footers().join(' ')).not.toMatch(/PM status/);
  });

  const reportContract = (file: string) => ({
    version: 2, objective: `Write ${file}.`, expected_deliverable: file,
    effects: { read_files: [], expected_file_effect: 'create' }, inputs: [],
    outputs: [{ output_id: 'report', path: path.join(workspace, file), kind: 'file', required: true }],
    constraints: [], dependencies: [], required_capabilities: { version: 1, capabilities: ['write'] },
    execution_strategy: 'delegate-required' });

  it('Stop while the teammate runs: its task is cancelled, and the strip says only that the PM does not continue', async () => {
    let pmInTurn!: () => void;
    const pmWaiting = new Promise<void>((resolve) => { pmInTurn = resolve; });
    scripts.set('pm-model', (request) => {
      if (lastToolResult(request)) { pmInTurn(); return new Promise<ModelAnswer>(() => { /* still thinking at Stop */ }); }
      return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write draft.txt.', contract: reportContract('draft.txt') } }] };
    });
    scripts.set('dev-model', () => new Promise<ModelAnswer>(() => { /* works until it is cancelled */ }));
    await screen.select('pm');
    await screen.send('Please write the draft.');
    await pmWaiting;
    await screen.stop();
    await pumpWhile(() => !screen.strip().some((line) => line.startsWith('Stopped.')), screen.pump);
    expect(screen.strip()).toEqual(['Stopped. The PM does not continue until you send a message.']);
    expect(replies('dev').at(-1)).toBe('delegation cancelled by user');
    // v0.9.105 (field run 3 of 2026-11-16): the stopped turn's timing line says when it stopped, not that it finished.
    await pumpWhile(() => !screen.footers().some((footer) => footer.startsWith('Stopped ')), screen.pump);
    const stoppedFooter = screen.footers().at(-1) ?? '';
    expect(stoppedFooter, JSON.stringify(screen.footers())).toMatch(/^Stopped \S.* · Turn time: /);
  });

  it('Stop before the PM reports a result: the result is owed, with Continue, until the PM, continued, reports it', async () => {
    let pmInTurn!: () => void;
    const pmWaiting = new Promise<void>((resolve) => { pmInTurn = resolve; });
    scripts.set('pm-model', (request) => {
      const said = latestUser(request);
      if (said.includes('Please review the finished results')) return { text: 'The report is in report.txt.' };
      // The result's wake: the PM is still reading it when the person presses Stop.
      if (said.includes('Async delegation result')) { pmInTurn(); return new Promise<ModelAnswer>(() => { /* reading */ }); }
      if (lastToolResult(request)) return { text: 'Dev is writing the report.' };
      return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write report.txt.', contract: reportContract('report.txt') } }] };
    });
    scripts.set('dev-model', (request) => (lastToolResult(request) ? { text: 'Saved report.txt.' }
      : { calls: [{ name: 'write_file', args: { path: 'report.txt', content: 'The report.' } }] }));
    await screen.select('pm');
    await screen.send('Please write the report.');
    // Bounded below the file's 60 s budget, so a stall names its step (the v0.9.102 release chain timed out here on
    // Node 22 under the whole suite, twice, and never alone).
    let wakeTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pmWaiting, new Promise<never>((_, reject) => {
      wakeTimer = setTimeout(() => reject(new Error(
        `the PM never received Dev's result within 45 s: report.txt ${fs.existsSync(path.join(workspace, 'report.txt')) ? 'was' : 'was not'} written; `
        + `${requests.length} model requests so far`)), 45_000);
    })]).finally(() => clearTimeout(wakeTimer));
    expect(fs.readFileSync(path.join(workspace, 'report.txt'), 'utf8')).toBe('The report.');
    await screen.stop();
    const owed = 'Dev finished, but the PM has not reported on it. Continue';
    await pumpWhile(() => !screen.strip().includes(owed), screen.pump);
    expect(screen.strip()).toEqual(['Stopped. The PM does not continue until you send a message.', owed]);
    expect(screen.strip().join(' ')).not.toContain('The PM reports here');
    expect(replies('pm')).not.toContain('The report is in report.txt.');

    // Continue fills the box and sends nothing; the person sends it, the PM reports, and nothing is owed any more.
    const before = requests.length;
    expect(await screen.continueFromStrip()).toBe('Please review the finished results and report to me.');
    await screen.pump();
    expect(requests.length).toBe(before);
    await screen.sendBox();
    await pumpWhile(() => (screen.strip().length || !replies('pm').includes('The report is in report.txt.')), screen.pump);
    expect(replies('pm')).toContain('The report is in report.txt.');
    expect(screen.strip()).toEqual([]);
    // The PM's final reply is kept where activation keeps it: this window's workspace state.
    const kept = new RootScopedWorkspaceState(context.workspaceState as never, workspace).get<Record<string, string>>('unode.pmRepliedAt')!;
    expect(Date.now() - Date.parse(kept.pm)).toBeLessThan(60_000);
  });

  /*
   * Field fix 7 (T2 smoke): a refused save in a folder the agent can read says it has Read and saving needs Read + Write,
   * once, never "could not reach it"; a folder it cannot read still says that, after the notice its naming put up.
   */
  it('fix 7: a refused save in a folder Dev can read says Dev has Read and saving needs Read + Write, once', async () => {
    const target = path.join(sibling, 'notes.txt');
    let attempts = 0;
    scripts.set('dev-model', (request) => {
      if (!lastToolResult(request)) attempts = 0;
      attempts++;
      return attempts <= 2 ? { calls: [{ name: 'write_file', args: { path: target, content: 'Notes.' } }] } : { text: 'I could not save it.' };
    });
    await screen.select('dev');
    host.warnings.length = 0;
    await screen.send(`Save the notes into the folder ${sibling}`);
    await pumpWhile(() => !replies('dev').includes('I could not save it.'), screen.pump);
    expect(replies('dev')).toContain('I could not save it.');
    expect(fs.existsSync(target)).toBe(false);
    const upgrade = host.warnings.filter((warning) => warning.includes('has Read access; saving there needs Read + Write'));
    expect(upgrade, JSON.stringify(host.warnings)).toHaveLength(1);
    expect(upgrade[0]).toMatch(new RegExp(` — Dev has Read access; saving there needs Read \\+ Write\\. Full path: ${sibling.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`));
    expect(host.warnings.join('\n')).not.toContain('could not reach it');
  });

  it('fix 7 control: a folder outside every folder Dev can read is named first, then said to be out of reach', async () => {
    const target = path.join(elsewhere, 'notes.txt');
    scripts.set('dev-model', (request) => (lastToolResult(request) ? { text: 'I could not save it there.' }
      : { calls: [{ name: 'write_file', args: { path: target, content: 'Notes.' } }] }));
    host.warnings.length = 0;
    await screen.send(`Save the notes into the folder ${elsewhere}`);
    await pumpWhile(() => !replies('dev').includes('I could not save it there.'), screen.pump);
    expect(fs.existsSync(target)).toBe(false);
    expect(host.warnings, JSON.stringify(host.warnings)).toHaveLength(2);
    expect(host.warnings[0]).toContain('your request names it, outside this workspace, and Dev cannot reach it yet.');
    expect(host.warnings[1]).toContain(`Dev could not reach it with the file tools. Current work continues without it. Full path: ${elsewhere}`);
    expect(host.warnings.join('\n')).not.toContain('has Read access');
  });

  /*
   * Field, 2026-11-12 (the Owner's InfiniteCompute window, Codex's handoff): an older task of the same PM and teammate had
   * ended long before; only its saved result was unavailable (settled, reserved, delivery pending, body-unavailable).
   * After a newer review completed and was accepted, the strip still said "UnodeAi cannot confirm whether Contract Analyst
   * is still running". The older record reaches this window as stored runs do, through the run-ownership merge.
   */
  it('field: an older ended task whose result cannot be used is said as that, not as running, after a newer review is accepted', async () => {
    const older = new RunLedger([], {});
    older.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'older-review', agentId: 'dev', requestedAgent: 'dev',
      instruction: 'Review the older contract.', attemptId: 'attempt-older-review', originCorrelationId: 'older-request' });
    older.recordDelegationEvidence({ handle: 'older-review', agentId: 'dev', outcome: 'no-evidence', evidence: {
      outcome: 'no-evidence', completionState: 'complete', changedFiles: [], hadToolActions: false, unrecordedWrites: false,
      verification: { ran: false } } });
    const identity = older.resultIdentity('pm', 'older-review');
    expect(identity, 'the older task holds a result reservation').toBeDefined();
    older.recordResultSettlement(identity!, 'ready');
    older.resultRecovery('pm', 'older-review', 'body-unavailable');
    const stored = new RootScopedWorkspaceState(context.workspaceState as never, workspace);
    await stored.update('roam.runs.merged.v8', [...(stored.get<unknown[]>('roam.runs.merged.v8') ?? []), ...older.snapshot()]);

    let release!: () => void;
    const devMayAnswer = new Promise<void>((resolve) => { release = resolve; });
    let handle = '';
    scripts.set('pm-model', (request) => {
      const tool = lastToolResult(request);
      const woken = latestUser(request).includes('Async delegation result');
      if (woken && !tool) return { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted-with-caveat', reason: 'One clause to check.' } }] };
      if (woken) return { text: 'The revised review is delivered.' };
      if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev is reviewing the contract.' }; }
      return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Review the contract into review.txt.', contract: reportContract('review.txt') } }] };
    });
    scripts.set('dev-model', async (request) => {
      if (lastToolResult(request)) return { text: 'Saved review.txt.' };
      await devMayAnswer;
      return { calls: [{ name: 'write_file', args: { path: 'review.txt', content: 'The review.' } }] };
    });
    await screen.select('pm');
    await screen.send('Please review the contract again.');
    // While Dev works, the run-ownership tick merges the stored older record; the strip then shows it (before v0.9.102's
    // field corrections, it said Dev might still be running).
    const older$ = (line: string) => line.startsWith(`Reminder: Dev's task "Review the older contract."`) || line.includes('cannot confirm whether');
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && !screen.strip().some(older$)) await screen.pump();
    expect(screen.strip().some(older$), JSON.stringify(screen.strip())).toBe(true);
    release();
    await pumpWhile(() => !replies('pm').includes('The revised review is delivered.'), screen.pump);
    expect(replies('pm')).toContain('The revised review is delivered.');
    expect(fs.readFileSync(path.join(workspace, 'review.txt'), 'utf8')).toBe('The review.');
    await pumpWhile(() => screen.strip().some((line) => line.startsWith('Running:')), screen.pump);
    const strip = screen.strip();
    // No line says the older, ended task may still be running. v0.9.102 (the Owner, 2026-11-13: every leftover item can be
    // resolved): its line names the task, says what is known, and what clears it, with the button that starts it.
    expect(strip.join(' '), JSON.stringify(strip)).not.toMatch(/still running|Running:/);
    expect(strip).toContainEqual(expect.stringMatching(
      /^Reminder: Dev's task "Review the older contract\." \(finished \d{4}-\d\d-\d\d \d\d:\d\d\): its saved result text is not available in this window, and it has not been handed to the PM yet\. To clear this, press Ask the PM, then Send: the PM inspects it and records what to do with it\. Ask the PM$/));

    // Ask the PM fills the box and sends nothing; the person sends it; the PM records the decision the tool accepts.
    let disposition = '';
    scripts.set('pm-model', (request) => {
      const tool = lastToolResult(request);
      if (tool) { disposition = tool; return { text: 'The older review is closed.' }; }
      return latestUser(request).includes('handle older-review')
        ? { calls: [{ name: 'record_task_disposition', args: { handle: 'older-review', disposition: 'rejected', reason: 'The revised review replaces it.' } }] }
        : { text: 'Nothing to do.' };
    });
    const before = requests.length;
    const asked = await screen.pressOnStrip('Ask the PM');
    expect(asked).toMatch(/^Please look at Dev's task "Review the older contract\." \(handle older-review, finished [^)]+\): its saved result text is not available in this window, and it has not been handed to the PM yet\. Inspect it with inspect_task_status\. .*record rejected or deferred with your reason\.$/);
    await screen.pump();
    expect(requests.length).toBe(before);
    await screen.sendBox();
    await pumpWhile(() => !replies('pm').includes('The older review is closed.'), screen.pump);
    expect(disposition).toContain('Recorded coordinator rejection for older-review');
    await pumpWhile(() => screen.strip().some((line) => line.startsWith('Reminder:')), screen.pump);
    expect(screen.strip()).toEqual([]);
    // After a reload of this window it stays closed, and its request no longer waits on it.
    const reloaded = await reloadedStrip();
    expect(reloaded.lines).toEqual([]);
    expect(reloaded.ledger.inspectTaskStatus('pm', ['older-review'])[0].result).toMatchObject({ state: 'decided', blocksComplete: false });
  });

  /*
   * v0.9.102 (design §9.3, Codex's D2 flow): a result the PM received and accepted, then Stop before its report. The
   * report stays owed, also after a reload. The person's message ends the suspension; it is not the report: until the
   * PM's final reply the result is still owed, and that reply clears it.
   */
  it('D2: an accepted result Stop cut off before its report stays owed after a reload and after Send, until the PM\'s reply', async () => {
    let pmInTurn!: () => void;
    const pmWaiting = new Promise<void>((resolve) => { pmInTurn = resolve; });
    let mayReport!: () => void;
    const reportGate = new Promise<void>((resolve) => { mayReport = resolve; });
    let reportAsked = false;
    let handle = '';
    scripts.set('pm-model', async (request) => {
      const said = latestUser(request);
      const tool = lastToolResult(request);
      if (said.includes('Please review the finished results')) { reportAsked = true; await reportGate; return { text: 'The accepted summary is in accepted.txt.' }; }
      if (said.includes('Async delegation result')) {
        if (!tool) return { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] };
        pmInTurn(); return new Promise<ModelAnswer>(() => { /* writing the report when the person presses Stop */ });
      }
      if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev is writing it.' }; }
      return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write accepted.txt.', contract: reportContract('accepted.txt') } }] };
    });
    scripts.set('dev-model', (request) => (lastToolResult(request) ? { text: 'Saved accepted.txt.' }
      : { calls: [{ name: 'write_file', args: { path: 'accepted.txt', content: 'Accepted.' } }] }));
    await screen.select('pm');
    await screen.send('Please write the accepted summary.');
    let wakeTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pmWaiting, new Promise<never>((_, reject) => {
      wakeTimer = setTimeout(() => reject(new Error(`the PM never accepted Dev's result within 45 s; ${requests.length} model requests so far`)), 45_000);
    })]).finally(() => clearTimeout(wakeTimer));
    await screen.stop();
    const owed = 'Dev finished, but the PM has not reported on it. Continue';
    await pumpWhile(() => !screen.strip().includes(owed), screen.pump);
    expect(screen.strip()).toEqual(['Stopped. The PM does not continue until you send a message.', owed]);
    // The window reloads: the accepted result is still owed its report.
    expect((await reloadedStrip((lines) => lines.includes('Dev finished, but the PM has not reported on it.'))).lines)
      .toContain('Dev finished, but the PM has not reported on it.');

    expect(await screen.continueFromStrip()).toBe('Please review the finished results and report to me.');
    await screen.sendBox();
    await pumpWhile(() => !reportAsked, screen.pump);
    expect(reportAsked).toBe(true);
    // Sent, and the PM is working on it: the report is still owed.
    for (let i = 0; i < 5; i++) await screen.pump();
    await untilCurrent(() => screen.strip(), (strip) => strip.some((line) => line.startsWith('Dev finished')), screen.pump);
    expect(screen.strip().some((line) => line.startsWith('Dev finished')), JSON.stringify(screen.strip())).toBe(true);
    const stillOwed = await reloadedStrip((lines) => lines.some((line) => line.startsWith('Dev finished')));
    expect(stillOwed.lines.some((line) => line.startsWith('Dev finished')), JSON.stringify(stillOwed.lines)).toBe(true);
    mayReport();
    await pumpWhile(() => (screen.strip().length || !replies('pm').includes('The accepted summary is in accepted.txt.')), screen.pump);
    expect(replies('pm')).toContain('The accepted summary is in accepted.txt.');
    expect(screen.strip()).toEqual([]);
    expect((await reloadedStrip((lines) => lines.length === 0)).lines).toEqual([]);
  });

  /*
   * v0.9.103 (slice 3 §5, Codex design PASS R3): report coverage by revision, through the production path. A result is
   * covered only by a PM final reply after it was delivered into a PM turn. 1. Task A's first result is delivered and
   * the PM reports. 2. A's revision (rework on the same handle) is delivered later and enters a PM turn. 3. While that
   * turn runs, task B's result is ready and queued; it does not enter that turn. 4. The PM closes that turn with a final
   * reply: A's revision is reported; B is unreported and still owes its report and its decision; the request closeout
   * agrees. 5. B is then delivered into the next PM turn, and only the reply after that covers it.
   */
  it('§5: an early report never covers a later revision of the same task, and one task\'s report never covers another\'s', async () => {
    let handleA = '';
    let handleB = '';
    let inRevisionTurn!: () => void;
    const revisionTurn = new Promise<void>((resolve) => { inRevisionTurn = resolve; });
    let closeRevisionTurn!: () => void;
    const revisionTurnMayClose = new Promise<void>((resolve) => { closeRevisionTurn = resolve; });
    let inTurnOfB!: () => void;
    const turnOfB = new Promise<void>((resolve) => { inTurnOfB = resolve; });
    let closeTurnOfB!: () => void;
    const turnOfBMayClose = new Promise<void>((resolve) => { closeTurnOfB = resolve; });
    let finishB!: () => void;
    const bMayFinish = new Promise<void>((resolve) => { finishB = resolve; });
    const decide = (handle: string) => ({ calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] });
    scripts.set('pm-model', async (request) => {
      const said = latestUser(request);
      const tool = lastToolResult(request);
      if (said.includes('Saved b.txt.')) {
        if (!tool) { inTurnOfB(); await turnOfBMayClose; return decide(handleB); }
        return { text: 'b.txt is written.' };
      }
      if (said.includes('Revised a.txt.')) {
        if (!tool) { inRevisionTurn(); await revisionTurnMayClose; return decide(handleA); }
        return { text: 'a.txt now has its second line.' };
      }
      if (said.includes('Saved a.txt.')) {
        if (!tool) {
          return { calls: [
            { name: 'record_task_disposition', args: { handle: handleA, disposition: 'needs-rework', reason: 'Add a second line to a.txt.' } },
            { name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write b.txt.', contract: reportContract('b.txt') } },
          ] };
        }
        handleB = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handleB;
        return { text: 'a.txt is written. Dev is adding its second line, then writes b.txt.' };
      }
      if (tool) { handleA = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handleA; return { text: 'Dev is writing a.txt.' }; }
      return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write a.txt.', contract: reportContract('a.txt') } }] };
    });
    scripts.set('dev-model', async (request) => {
      const said = latestUser(request);
      const tool = lastToolResult(request);
      if (said.includes('Add a second line')) {
        return tool ? { text: 'Revised a.txt.' } : { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'Line one.\nLine two.' } }] };
      }
      if (said.includes('b.txt')) {
        if (tool) return { text: 'Saved b.txt.' };
        await bMayFinish;
        return { calls: [{ name: 'write_file', args: { path: 'b.txt', content: 'B.' } }] };
      }
      return tool ? { text: 'Saved a.txt.' } : { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'Line one.' } }] };
    });
    const waitFor = async (done: () => boolean, what: string) => {
      await pumpWhile(() => !done(), screen.pump, { detail: () => `${what}: ${JSON.stringify({ strip: screen.strip(), replies: replies('pm').slice(-3) })}` });
      expect(done(), `${what}: ${JSON.stringify({ strip: screen.strip(), replies: replies('pm').slice(-3) })}`).toBe(true);
    };
    const within = async (promise: Promise<void>, what: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not happen within 40 s: ${JSON.stringify({ strip: screen.strip(), replies: replies('pm').slice(-3) })}`)), 40_000);
      })]).finally(() => clearTimeout(timer));
    };

    await screen.select('pm');
    await screen.send('Please write a.txt, then b.txt.');
    // 1. A's first result is delivered into a PM turn, and the PM reports it.
    await waitFor(() => replies('pm').includes('a.txt is written. Dev is adding its second line, then writes b.txt.'), 'the PM reports A');
    expect(handleA).not.toBe('');
    expect(handleB).not.toBe('');

    // 2. A's revision, on the same handle, is delivered later and enters a PM turn.
    await within(revisionTurn, 'the turn of A\'s revision');
    expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toBe('Line one.\nLine two.');
    // 3. While that turn runs, B's result is ready and queued: it does not enter that turn.
    finishB();
    const queuedB = 'Dev finished. The PM gets the result when its current turn ends.';
    await waitFor(() => screen.strip().includes(queuedB), 'B queued behind the turn');
    expect(screen.strip()).toEqual(['Dev finished. The PM is reviewing it now.', queuedB]);

    // 4. The PM closes that turn with a final reply. A's revision is reported; B is not: it is reviewed only now, in the
    // next turn, and is owed its report and its decision until that turn's reply.
    closeRevisionTurn();
    await within(turnOfB, 'B\'s turn');
    const replyTo = (start: string) => replies('pm').find((reply) => reply.startsWith(start));
    await waitFor(() => !!replyTo('a.txt now has its second line.'), 'the reply to A\'s revision');
    // The host's own close of that turn names B's decision as still owed.
    expect(replyTo('a.txt now has its second line.')).toContain('1 delegation result still needs a decision');
    await waitFor(() => screen.strip().length === 1, 'the strip after A\'s report');
    expect(screen.strip()).toEqual(['Dev finished. The PM is reviewing it now.']);
    expect(replyTo('b.txt is written.')).toBeUndefined();
    // The request closeout agrees: the turn that reported A did not conclude the request, whose run is still open.
    const cards = () => chatProvider.requestSummaryCards('pm') as Array<{ recordId: string; state: string }>;
    await waitFor(() => cards().length > 0, 'the request summary');
    const requestOf = (recordId: string) => recordId.split(':')[1];
    const thisRequest = () => cards().filter((card) => requestOf(card.recordId) === requestOf(cards().at(-1)!.recordId)).map((card) => card.state);
    // The dispatch turn and A's first report: work was running. The turn that reported A's revision: nothing runs, B's
    // decision is owed, the run is open, so the turn did not conclude the request. Never answered, completed or closed.
    expect(thisRequest()).toEqual(['in-progress', 'in-progress', 'no-conclusion']);

    // 5. B's result is delivered into this turn; only the reply after that delivery covers it.
    closeTurnOfB();
    await waitFor(() => !!replyTo('b.txt is written.'), 'the reply to B');
    await waitFor(() => screen.strip().length === 0, 'the strip after B\'s report');
    expect(screen.strip()).toEqual([]);
    expect(fs.readFileSync(path.join(workspace, 'b.txt'), 'utf8')).toBe('B.');
    // Nothing of the request is owed any more: the close of B's turn names no decision.
    expect(replyTo('b.txt is written.')).toBe('b.txt is written.');
  });

  /*
   * v0.9.103 (G4, design §2): a request reads In progress while a task it needs runs or waits to start. A dispatch to a
   * teammate busy with other work is queued: its run is recorded only when the teammate takes it up, after the PM's turn
   * has closed. The turn's own dispatch receipt still counts it as pending, so the request summary reads In progress; the
   * admission, the result and the PM's report follow as they always do.
   */
  it('G4: a dispatch queued behind the teammate\'s other work keeps the request In progress after the PM\'s turn closes', async () => {
    let releaseOther!: () => void;
    const otherMayEnd = new Promise<void>((resolve) => { releaseOther = resolve; });
    let otherStarted!: () => void;
    const busy = new Promise<void>((resolve) => { otherStarted = resolve; });
    let handle = '';
    scripts.set('dev-model', async (request) => {
      const said = latestUser(request);
      const tool = lastToolResult(request);
      if (said.includes('Tidy your notes')) { otherStarted(); await otherMayEnd; return { text: 'Notes tidied.' }; }
      return tool ? { text: 'Saved queued.txt.' } : { calls: [{ name: 'write_file', args: { path: 'queued.txt', content: 'Queued work.' } }] };
    });
    scripts.set('pm-model', (request) => {
      const tool = lastToolResult(request);
      const woken = latestUser(request).includes('Async delegation result');
      if (woken && !tool) return { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] };
      if (woken) return { text: 'queued.txt is written.' };
      if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev will write queued.txt when it is free.' }; }
      return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write queued.txt.', contract: reportContract('queued.txt') } }] };
    });
    const cards = () => chatProvider.requestSummaryCards('pm') as Array<{ recordId: string; state: string }>;
    const waitFor = async (done: () => boolean, what: string) => {
      await pumpWhile(() => !done(), screen.pump, { detail: () => `${what}: ${JSON.stringify({ strip: screen.strip(), cards: cards().slice(-2), replies: replies('pm').slice(-2) })}` });
      expect(done(), `${what}: ${JSON.stringify({ strip: screen.strip(), cards: cards().slice(-2), replies: replies('pm').slice(-2) })}`).toBe(true);
    };

    // Dev is busy with work of its own.
    await screen.select('dev');
    await screen.send('Tidy your notes.');
    await busy;
    // The PM dispatches to Dev, and its turn closes while the task waits behind that work.
    await screen.select('pm');
    const before = cards().length;
    await screen.send('Please write queued.txt.');
    await waitFor(() => replies('pm').some((reply) => reply.startsWith('Dev will write queued.txt when it is free.')), 'the PM\'s reply');
    await waitFor(() => cards().length > before, 'the request summary');
    expect(handle).not.toBe('');
    // The strip is drawn by its own update, after the card: under the full suite's load it had not arrived yet when it
    // was read at once (release chain on bf1c3ece, Node 25), and the stuck task then failed every later flow.
    await waitFor(() => screen.strip().includes('Starting: 1 task.'), 'the strip');
    expect(screen.strip()).toContain('Starting: 1 task.');
    // No run is recorded for it yet; the turn's receipt counts the dispatch as pending, and the request is in progress.
    expect((await storedDelegations()).some((delegation) => delegation.handle === handle)).toBe(false);
    expect(cards().at(-1)!.state).toBe('in-progress');

    // Dev finishes its own work, takes the task up, and its result wakes the PM, which reports it.
    releaseOther();
    await waitFor(() => replies('pm').some((reply) => reply.startsWith('queued.txt is written.')), 'the PM\'s report');
    expect(fs.readFileSync(path.join(workspace, 'queued.txt'), 'utf8')).toBe('Queued work.');
    expect((await storedDelegationIn(handle, 'settled'))?.state).toBe('settled');
    await waitFor(() => screen.strip().length === 0, 'the strip after the report');
  });

  /*
   * v0.9.103 (G4): the other side. A queued dispatch that ends before its teammate takes it up (the PM cancels it) leaves
   * its turn's pending count, and that turn's request summary no longer reads In progress for it.
   */
  it('G4: a queued dispatch cancelled before its teammate takes it up no longer keeps the request In progress', async () => {
    let releaseOther!: () => void;
    const otherMayEnd = new Promise<void>((resolve) => { releaseOther = resolve; });
    let otherStarted!: () => void;
    const busy = new Promise<void>((resolve) => { otherStarted = resolve; });
    let handle = '';
    scripts.set('dev-model', async (request) => {
      if (latestUser(request).includes('Sort your inbox')) { otherStarted(); await otherMayEnd; return { text: 'Inbox sorted.' }; }
      return lastToolResult(request) ? { text: 'Saved unwanted.txt.' }
        : { calls: [{ name: 'write_file', args: { path: 'unwanted.txt', content: 'Not needed.' } }] };
    });
    scripts.set('pm-model', (request) => {
      const said = latestUser(request);
      const tool = lastToolResult(request);
      if (said.includes('Cancel the unwanted task')) {
        return tool ? { text: 'The unwanted task is cancelled.' }
          : { calls: [{ name: 'cancel_task', args: { handle, reason: 'The person no longer needs it.' } }] };
      }
      if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev will write unwanted.txt when it is free.' }; }
      return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write unwanted.txt.', contract: reportContract('unwanted.txt') } }] };
    });
    const cards = () => chatProvider.requestSummaryCards('pm') as Array<{ recordId: string; state: string }>;
    const waitFor = async (done: () => boolean, what: string) => {
      await pumpWhile(() => !done(), screen.pump, { detail: () => `${what}: ${JSON.stringify({ strip: screen.strip(), cards: cards().slice(-2), replies: replies('pm').slice(-2) })}` });
      expect(done(), `${what}: ${JSON.stringify({ strip: screen.strip(), cards: cards().slice(-2), replies: replies('pm').slice(-2) })}`).toBe(true);
    };

    await screen.select('dev');
    await screen.send('Sort your inbox.');
    await busy;
    await screen.select('pm');
    await screen.send('Please write unwanted.txt.');
    await waitFor(() => replies('pm').some((reply) => reply.startsWith('Dev will write unwanted.txt when it is free.')), 'the PM\'s reply');
    await waitFor(() => cards().some((card) => card.state === 'in-progress'), 'the request summary');
    const dispatching = cards().at(-1)!.recordId;
    expect(cards().at(-1)!.state).toBe('in-progress');

    // The PM cancels the task while it still waits behind Dev's own work.
    await screen.send('Cancel the unwanted task.');
    await waitFor(() => replies('pm').some((reply) => reply.startsWith('The unwanted task is cancelled.')), 'the PM\'s cancel');
    // The dispatching turn's summary follows its receipt: nothing of it runs or waits any more.
    await waitFor(() => cards().find((card) => card.recordId === dispatching)?.state === 'answered', 'the dispatching turn\'s summary');
    await waitFor(() => !screen.strip().includes('Starting: 1 task.'), 'the strip');

    // Dev finishes its own work; the cancelled task never starts.
    releaseOther();
    await waitFor(() => replies('dev').some((reply) => reply.startsWith('Inbox sorted.')), 'Dev\'s own work');
    for (let i = 0; i < 20; i++) await screen.pump();
    expect(fs.existsSync(path.join(workspace, 'unwanted.txt'))).toBe(false);
    expect(cards().find((card) => card.recordId === dispatching)?.state).toBe('answered');
  });

  /*
   * Field, 2026-11-12 (the Owner's InfiniteCompute window): Contract Analyst finished about 21 minutes after the PM
   * assigned it. The PM's wait had ended at 5 minutes and the late window at 15: the row turned red "Timed out waiting
   * for teammate" and the PM never got the result. A teammate's finished work wakes the PM with it, however late. (That
   * the task keeps its grants until it ends, the Owner's decision, is proven in TeamToolsAttemptLifecycle: a write in
   * the workspace does not depend on them.)
   */
  it('field: a teammate that finishes 25 minutes after the PM assigned it wakes the PM with its result, and its row is not timed out', async () => {
    // Only the timers move; the run ledger's 5 s ownership tick and the clock stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      let release!: () => void;
      const devMayAnswer = new Promise<void>((resolve) => { release = resolve; });
      let handle = '';
      let wake = '';
      scripts.set('pm-model', (request) => {
        const tool = lastToolResult(request);
        const woken = latestUser(request).includes('Async delegation result');
        if (woken && !tool) { wake = latestUser(request); return { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] }; }
        if (woken) return { text: 'The late analysis is delivered.' };
        if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev is analysing the contract.' }; }
        return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Analyse the contract into analysis.txt.', contract: reportContract('analysis.txt') } }] };
      });
      scripts.set('dev-model', async (request) => {
        if (lastToolResult(request)) return { text: 'Saved analysis.txt.' };
        await devMayAnswer;
        return { calls: [{ name: 'write_file', args: { path: 'analysis.txt', content: 'The analysis.' } }] };
      });
      await screen.select('pm');
      await screen.send('Please analyse the contract.');
      await pumpWhile(() => !replies('pm').includes('Dev is analysing the contract.'), screen.pump);
      expect(replies('pm')).toContain('Dev is analysing the contract.');
      // The PM's wait ends at 5 minutes. Where the late window closed before, at 15, nothing ends now.
      await vi.advanceTimersByTimeAsync(25 * 60_000);
      for (let i = 0; i < 5; i++) await screen.pump();
      expect(replies('pm')).not.toContain('The late analysis is delivered.');
      await untilCurrent(() => screen.strip(), (strip) => strip.some((line) => line.startsWith('Running: Dev')), screen.pump);
      expect(screen.strip().some((line) => line.startsWith('Running: Dev')), JSON.stringify(screen.strip())).toBe(true);

      release();
      await pumpWhile(() => !replies('pm').includes('The late analysis is delivered.'), screen.pump);
      expect(replies('pm'), JSON.stringify({ strip: screen.strip(), warnings: host.warnings.slice(-3) })).toContain('The late analysis is delivered.');
      expect(wake).toContain('Saved analysis.txt.');
      expect(fs.readFileSync(path.join(workspace, 'analysis.txt'), 'utf8')).toBe('The analysis.');
      // The PM's progress card is on screen, and its Dev row is not "Timed out waiting for teammate".
      expect(screen.transcript()).toMatch(/PM delegat(ing|ed) to the crew/);
      expect(screen.transcript()).not.toContain('Timed out waiting for teammate');
    } finally {
      await endFakeTimers();
    }
  });

  /*
   * v0.9.103 (G5, the Owner's decision of 2026-11-12): a dispatch has no internal wait timer. The PM ends its turn at the
   * dispatch, with the progress report its return asks for; a slow teammate is never recorded or shown as timed out; the
   * request reads In progress until the result lands, and the result wakes the PM once.
   */
  it('G5: a slow teammate is never timed out: past 5 minutes nothing records a timeout, the request is In progress, and the result wakes the PM once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      let release!: () => void;
      const devMayAnswer = new Promise<void>((resolve) => { release = resolve; });
      let handle = '';
      let dispatched = '';
      const wakes: string[] = [];
      scripts.set('pm-model', (request) => {
        const tool = lastToolResult(request);
        const woken = latestUser(request).includes('Async delegation result');
        if (woken && !tool) { wakes.push(latestUser(request)); return { calls: [{ name: 'record_task_disposition', args: { handle, disposition: 'accepted' } }] }; }
        if (woken) return { text: 'The slow review is delivered.' };
        if (tool) { dispatched = tool; handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: 'Dev is reviewing the plan; it is still running.' }; }
        return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Review the plan into review.txt.', contract: reportContract('review.txt') } }] };
      });
      scripts.set('dev-model', async (request) => {
        if (lastToolResult(request)) return { text: 'Saved review.txt.' };
        await devMayAnswer;
        return { calls: [{ name: 'write_file', args: { path: 'review.txt', content: 'The review.' } }] };
      });
      await screen.select('pm');
      await screen.send('Please review the plan.');
      await pumpWhile(() => !replies('pm').includes('Dev is reviewing the plan; it is still running.'), screen.pump);
      expect(replies('pm')).toContain('Dev is reviewing the plan; it is still running.');
      // The dispatch's own return asks for the progress report: this is where the PM ends its turn.
      expect(dispatched).toContain('End this turn with a progress report to the user: what is delivered, what is still running and what blocks it.');
      expect(dispatched).toContain('It is not the end of the request');

      // Well past the 5-minute wait that dispatch_task had until 0.9.102.
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      for (let i = 0; i < 5; i++) await screen.pump();
      expect(replies('pm')).not.toContain('The slow review is delivered.');
      expect(wakes).toEqual([]);
      await untilCurrent(() => screen.strip(), (strip) => strip.some((line) => line.startsWith('Running: Dev')), screen.pump);
      expect(screen.strip().some((line) => line.startsWith('Running: Dev')), JSON.stringify(screen.strip())).toBe(true);
      expect(screen.transcript()).not.toContain('Timed out waiting for teammate');
      const running = (await storedDelegations()).find((delegation) => delegation.handle === handle);
      expect(running, 'the dispatch is stored').toBeDefined();
      expect(running!.state).toBe('active');
      expect(running!.evidence?.outcome).not.toBe('timed-out');
      // The request is in progress on the PM strip, and nothing of this request on screen says it timed out.
      await untilCurrent(() => screen.strip(), (strip) => strip.length === 2 && strip[1] === 'The PM reports here when results come back.', screen.pump);
      expect(screen.strip()).toEqual([expect.stringMatching(/^Running: Dev \((under 1 min|\d+ min)\)\.$/), 'The PM reports here when results come back.']);
      // v0.9.103 (G4): and in its request summary, whether the run was recorded before the turn closed or after it.
      const cards = chatProvider.requestSummaryCards('pm') as Array<{ recordId: string; state: string }>;
      expect(cards.at(-1)?.state, JSON.stringify(cards.slice(-3))).toBe('in-progress');
      const thisRequest = screen.transcript().split('Please review the plan.').at(-1)!;
      expect(thisRequest).toContain('Request summary');
      expect(thisRequest).not.toMatch(/timed out/i);

      release();
      await pumpWhile(() => !replies('pm').includes('The slow review is delivered.'), screen.pump);
      expect(replies('pm'), JSON.stringify({ strip: screen.strip(), warnings: host.warnings.slice(-3) })).toContain('The slow review is delivered.');
      for (let i = 0; i < 5; i++) await screen.pump();
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toContain('Saved review.txt.');
      expect(fs.readFileSync(path.join(workspace, 'review.txt'), 'utf8')).toBe('The review.');
      const settled = (await storedDelegations()).find((delegation) => delegation.handle === handle)!;
      expect(settled.state).toBe('settled');
      expect(settled.evidence?.outcome).not.toBe('timed-out');
      expect(screen.transcript()).not.toContain('Timed out waiting for teammate');
    } finally {
      await endFakeTimers();
    }
  });
});

/*
 * v0.9.103 slice 1 (design §4 G1, §5.2, §5.6, the acceptance rows of §9 this slice owns): a teammate's send_message to
 * the coordinator of its live task is bound by the host to that task, wakes the PM in the lane of the task's results,
 * is charged to the request its task belongs to, and a second delivery of the same message starts nothing.
 */
describe('v0.9.103 F1 the extension through activate(): a restart of the PM interrupts its delegation', () => {
  const f1Contract = (file: string) => ({
    version: 2, objective: `Write ${file}.`, expected_deliverable: file,
    effects: { read_files: [], expected_file_effect: 'create' }, inputs: [],
    outputs: [{ output_id: 'report', path: path.join(workspace, file), kind: 'file', required: true }],
    constraints: [], dependencies: [], required_capabilities: { version: 1, capabilities: ['write'] },
    execution_strategy: 'delegate-required' });

  /** The PM dispatches `file` to Dev, which works until it is stopped; the PM is restarted. Returns the task's handle. */
  async function restartedWhileDevRuns(file: string, ask: string, replyText: string): Promise<string> {
    let handle = '';
    scripts.set('pm-model', (request) => {
      const tool = lastToolResult(request);
      if (tool) { handle = /Handle: ([^\s.]+)/.exec(tool)?.[1] ?? handle; return { text: replyText }; }
      return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: `Write ${file}.`, contract: f1Contract(file) } }] };
    });
    scripts.set('dev-model', () => new Promise<ModelAnswer>(() => { /* works until it is stopped */ }));
    await screen.select('pm');
    await screen.send(ask);
    await pumpWhile(() => !replies('pm').includes(replyText), screen.pump);
    expect(replies('pm')).toContain(replyText);
    expect(handle).not.toBe('');
    expect(await storedDelegationIn(handle, 'active')).toMatchObject({ state: 'active' });
    await host.commands.get('unode.agentRestart')!('pm');
    await screen.pump();
    return handle;
  }

  it('2: the task is interrupted, durably and after a reload, its result is not delivered, and the restarted PM replaces it', async () => {
    const send = vi.spyOn(MessageBus.prototype, 'send');
    let handle = '';
    try {
      handle = await restartedWhileDevRuns('f1-api-report.txt', 'Please write the F1 API report.', 'F1: Dev is writing the API report.');
      // The worker's own receipt, through activation's real cancelDelegatedWorker wiring: interrupted, never cancelled.
      const receipts = send.mock.calls.filter((call) => call[0] === 'dev' && call[2] === 'system.error' && call[5] === handle);
      expect(receipts.length).toBeGreaterThan(0);
      for (const receipt of receipts) {
        const metadata = (receipt[3] as { metadata?: Record<string, unknown> }).metadata;
        expect(metadata).toMatchObject({ interrupted: true, interruptionReason: 'host-stopped' });
        expect(metadata?.cancelled).toBeUndefined();
      }
    } finally { send.mockRestore(); }
    const stored = await storedDelegationIn(handle, 'interrupted');
    expect(stored).toMatchObject({ state: 'interrupted', interruption: { reason: 'host-stopped' } });
    expect(stored?.cancelledAt).toBeUndefined();
    const { ledger } = await reloadedStrip();
    expect(ledger.inspectTaskStatus('pm', [handle])[0]).toMatchObject({ lifecycle: 'interrupted', interruption: { reason: 'host-stopped' } });

    // The person asks for it again; the restarted PM replaces the interrupted task, and Dev's new task is taken up.
    let replacement = '';
    scripts.set('pm-model', (request) => {
      const tool = lastToolResult(request);
      if (tool) { replacement = tool; return { text: 'F1: Dev is redoing the API report.' }; }
      return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Write f1-api-report.txt again.',
        contract: f1Contract('f1-api-report.txt'), replaces_handle: handle, replacement_reason: 'Interrupted when the PM restarted.' } }] };
    });
    await screen.send('Please redo the F1 API report.');
    await pumpWhile(() => !replies('pm').includes('F1: Dev is redoing the API report.'), screen.pump);
    // Admitted, and not queued behind the interrupted task's claim: that claim was released.
    expect(replacement).toMatch(new RegExp(`^Dispatched contract .*Interrupted handle ${handle} will be superseded`, 's'));
    let superseded = (await storedDelegations()).find((row) => row.handle === handle);
    for (const deadline = wallDeadline(); (!superseded?.dispositions.some((entry) => entry.disposition === 'superseded')) && beforeDeadline(deadline);) {
      superseded = (await storedDelegations()).find((row) => row.handle === handle);
    }
    expect(superseded?.dispositions).toContainEqual(expect.objectContaining({ disposition: 'superseded', replacementHandle: /Handle: ([^\s.]+)/.exec(replacement)?.[1] }));
    // Its result never reached the PM: nothing woke it with this task's result.
    expect(requests.filter((request) => request.model === 'pm-model')
      .some((request) => latestUser(request).includes('Async delegation result') && latestUser(request).includes(handle))).toBe(false);
    // Dev's replacement is stopped so that the next flow starts from an idle team.
    await host.commands.get('unode.agentStop')!('dev');
    await screen.pump();
  });

  it('7: the PM\'s chat says the task was interrupted because UnodeAi stopped its session, and never says cancelled', async () => {
    const handle = await restartedWhileDevRuns('f1-notice-report.txt', 'Please write the F1 notice report.', 'F1: Dev is writing the notice report.');
    await storedDelegationIn(handle, 'interrupted');
    let notice: { text: string } | undefined;
    for (const deadline = wallDeadline(); (!notice) && beforeDeadline(deadline);) {
      await screen.pump();
      notice = (chatProvider.loadHistory('pm') as Array<{ text: string; noticeKey?: string }>).find((message) => message.noticeKey === `interruption:${handle}`);
    }
    expect(notice?.text).toBe('UnodeAi: Dev\'s task was interrupted: its session was stopped by UnodeAi (a restart, a settings change, closing '
      + 'the window, or its process ending) while it was running. To go on, ask the PM in this chat to run the task again, or to record it as abandoned.');
    // v0.9.103 (action-needed messages): the person's line names no tool parameter.
    expect(notice?.text).not.toContain('replaces_handle');
    expect(notice?.text).not.toMatch(/cancel/i);
  });
});

describe('v0.9.103 the extension through activate(): CLI teammates get the host bus for send_message', () => {
  it('passes the activation MessageBus and TaskInputResolver to Claude and Codex backends it builds', async () => {
    const extension = await import('../extension');
    for (const backendKind of ['claude', 'codex'] as const) {
      const config = new AgentConfigBuilder().fromTemplate('senior-dev').setProviderById(`${backendKind}-cli`)
        .setId(`wiring-${backendKind}`).setName(`Wiring ${backendKind}`).setModel('wiring-model').build();
      config.backend = backendKind;
      config.allowedTools = [...new Set([...(config.allowedTools ?? []), 'read', 'message'])];
      const wired = extension.__testBackendWiring({ e2e: true }, config);
      const deps = (wired.backend as unknown as { deps: { messageBus?: unknown; taskInputResolver?: unknown } }).deps;
      expect(deps.messageBus, backendKind).toBe(wired.messageBus);
      expect(deps.taskInputResolver, backendKind).toBe(wired.taskInputResolver);
      await (wired.backend as unknown as { stop?: (ms: number) => Promise<unknown> }).stop?.(10);
    }
  });
});
