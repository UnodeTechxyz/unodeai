import { expect, it, vi } from 'vitest';

/**
 * v0.9.106 retest R3, finding C, through the extension's real entry (Codex's audit of 4cc9cfd9, C-1). The PM dispatches a
 * review to a Codex Reviewer while no Codex CLI is chosen. The list "An agent needs a Codex CLI to start" stays open while
 * the PM ends its turn with a progress reply, as `dispatch_task` tells it to; then the person closes the list. Before,
 * the refusal reached the reviewer's chat but never the PM, and the task, settled as a result nobody could deliver, owed
 * a decision forever: a later request's accepted result could not close `complete`, and every PM reply ended with
 * "1 delegation result still needs a decision". Now a start refused before the teammate took the task ends that dispatch
 * as a refused dispatch, with its reason, as a team policy refusal before admission does: the PM's next turn lists it
 * under its previous turn, and no decision is owed. `activate()` runs with production admission, result delivery, the
 * run ledger and its persistence; only the VS Code API and the models' HTTP replies are stood in. No Codex program runs.
 */
const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());
vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));

import {
  scripts, requests, lastToolResult, replies, installActivatedExtension, pumpWhile, agent, workspace, context,
  storedStateQuiet, readReloadedStrip, type chatScreen, type ModelRequest,
} from './support/activatedHarness';
import { AgentConfigBuilder } from '../roles/RoleConfig';
import { NO_PROGRAM_TEXT } from '../host/cliRuntimeResolver';
import { RunLedger } from '../observability/RunLedger';
import { PersistenceManager } from '../state/PersistenceManager';
import { RootScopedWorkspaceState } from '../state/RootScopedWorkspaceState';
import { buildPortableRunEvidence } from '../observability/PortableRunEvidence';
import { jobOutcomeView, projectJobOutcome } from '../observability/JobOutcome';
import { TeamViewProvider } from '../views/TeamViewProvider';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
(context.storageUri as { scheme?: string }).scheme = 'file';

const reviewer = new AgentConfigBuilder().fromTemplate('reviewer').setProviderById('codex-cli').setId('reviewer')
  .setName('Codex Reviewer').setModel('gpt-test').build();
reviewer.backend = 'codex';

let screen: ReturnType<typeof chatScreen>;
let chatProvider: any;
installActivatedExtension(host, (ready) => { screen = ready.screen; chatProvider = ready.chatProvider; },
  { agents: [agent('pm', 'pm', 'PM', 'pm-model'), reviewer, agent('senior-dev', 'dev', 'Dev', 'dev-model')] });

const contract = (objective: string) => ({
  version: 1, objective, expected_deliverable: 'A reply.', effects: { read_files: [], expected_file_effect: 'none' },
  inputs: [], constraints: [], dependencies: [], required_capabilities: { version: 1, capabilities: [] },
  execution_strategy: 'delegate-required',
});
const OLD_OBLIGATION = /delegation results? still needs? a decision/;
const REFUSAL_LINE = '- refused for reviewer: It did not start, so it never took this task. No Codex CLI is selected, so nothing was started.';
const sent = (request: ModelRequest) => JSON.stringify(request.messages);
const pmRequests = () => requests.filter((request) => request.model === 'pm-model');
/** The Team panel's row of an agent, by the title its button carries ("Name — status — detail — open ..."). */
const teamRow = (name: string) => {
  const html = String((host.views.get(TeamViewProvider.viewType) as any)._getHtml({ cspSource: 'test:', asWebviewUri: (u: unknown) => u }));
  const start = html.indexOf(`title="${name} — `);
  return start < 0 ? '' : html.slice(start + 7, html.indexOf('"', start + 7));
};

it('a refused start reaches the PM as a refused dispatch; a later accepted result then closes complete, with no old obligation', async () => {
  let release!: () => void;
  const heldList = new Promise<undefined>((resolve) => { release = () => resolve(undefined); });
  let listShown = 0;
  host.overrides['vscode.window.showQuickPick'] = async (_items: unknown, options?: { title?: string }) => {
    if (options?.title === 'An agent needs a Codex CLI to start: choose one') { listShown++; return heldList; }
    return undefined;
  };
  let phase: 'first' | 'later' = 'first';
  let firstDispatched = false;
  let laterDispatched = false;
  let laterHandle = '';
  let acceptResult = '';
  let closeResult = '';
  scripts.set('dev-model', () => ({ text: 'LATER-RESULT: the later task is answered.' }));
  scripts.set('pm-model', (request) => {
    const result = lastToolResult(request) ?? '';
    if (phase === 'first') {
      if (!firstDispatched) {
        firstDispatched = true;
        return { calls: [{ name: 'dispatch_task', args: { agent: 'reviewer', instruction: 'Review add.js.', contract: contract('Review add.js.') } }] };
      }
      return { text: 'FIRST-PM-WAITING' };
    }
    if (!laterDispatched) {
      laterDispatched = true;
      return { calls: [{ name: 'dispatch_task', args: { agent: 'dev', instruction: 'Answer the later task.', contract: contract('Answer the later task.') } }] };
    }
    if (!laterHandle) laterHandle = result.match(/Handle: ([0-9a-f-]+)/i)?.[1] ?? '';
    if (!sent(request).includes('LATER-RESULT')) return { text: 'LATER-PM-WAITING' };
    if (!acceptResult) {
      acceptResult = 'pending';
      return { calls: [{ name: 'record_task_disposition', args: { handle: laterHandle, disposition: 'accepted' } }] };
    }
    if (acceptResult === 'pending') {
      acceptResult = result;
      return { calls: [{ name: 'close_assignment', args: { outcome: 'complete', summary: 'The later task is complete.' } }] };
    }
    if (!closeResult) closeResult = result;
    return { text: 'LATER-PM-DONE' };
  });
  const history = (id: string) => (chatProvider.loadHistory(id) as Array<{ text: string }>).map((message) => message.text).join('\n');

  await screen.select('pm');
  await screen.send('FIRST: ask the Codex reviewer to review add.js.');
  // The list stays open while the PM ends its turn with a progress reply.
  await pumpWhile(() => listShown === 0 || !replies('pm').some((text) => text.includes('FIRST-PM-WAITING')), screen.pump);
  const firstRequests = pmRequests().length;
  const firstTurnId = (chatProvider.loadHistory('pm') as Array<{ text: string; turnId?: string }>)
    .find((message) => message.text.includes('FIRST-PM-WAITING'))?.turnId;
  expect(firstTurnId).toBeTruthy();
  release();

  // The refusal reaches the reviewer's chat, and the window's one notice.
  await pumpWhile(() => !history('reviewer').includes(NO_PROGRAM_TEXT['codex-cli']), screen.pump);
  await pumpWhile(() => !host.warnings.some((text) => text.includes('Codex Reviewer did not start')), screen.pump);
  expect(listShown).toBe(1);
  // The PM's progress reply now counts its dispatch as refused, not as still starting.
  const firstReceipt = () => (chatProvider.loadHistory('pm') as Array<{ text: string; delegationReceipt?: { refused?: number } }>)
    .find((message) => message.text.includes('FIRST-PM-WAITING'))?.delegationReceipt;
  await pumpWhile(() => firstReceipt()?.refused !== 1, screen.pump);
  expect(firstReceipt()).toMatchObject({ accepted: 0, refused: 1, pending: 0 });
  // Retest 3, T4: the agent never took the task, so nothing calls it Blocked. The PM's task card says Did not start
  // and counts it apart from the tasks; the Team panel shows the agent as it is, stopped.
  await pumpWhile(() => !screen.transcript().includes('1 did not start'), screen.pump);
  expect(screen.transcript()).toContain('0 complete · 0 partial · 0 blocked · 1 did not start');
  expect(screen.transcript()).toContain('Did not start');
  expect(screen.transcript()).not.toMatch(/Blocked/);
  expect(teamRow('Codex Reviewer')).toMatch(/^Codex Reviewer — /);
  expect(teamRow('Codex Reviewer')).not.toMatch(/Blocked|blocked on/);

  // A later request. Its first PM request lists the refused dispatch, with its reason, under the PM's previous turn.
  phase = 'later';
  await screen.send('LATER: give the later task to Dev and accept it.');
  await pumpWhile(() => !replies('pm').some((text) => text.includes('LATER-PM-DONE')), screen.pump);
  const laterFirst = pmRequests()[firstRequests];
  expect(sent(laterFirst)).toContain('LATER: give the later task to Dev');
  expect(sent(laterFirst)).toContain('0 dispatches accepted, 1 refused');
  expect(sent(laterFirst)).toContain(REFUSAL_LINE);
  // Dev's real result came back; the PM accepted it and closed the assignment as complete.
  expect(acceptResult).not.toMatch(/^Error/);
  expect(closeResult).toMatch(/^Recorded: assignment closed as complete/);
  for (const reply of replies('pm')) expect(reply).not.toMatch(OLD_OBLIGATION);
  expect(replies('pm').at(-1)).toContain('LATER-PM-DONE');

  // Nothing was decided for the PM: the refused task has no delegation row, and the later task has the PM's acceptance.
  await storedStateQuiet();
  const ledger = new RunLedger(await new PersistenceManager(context as never, undefined, () => workspace, undefined, undefined,
    new RootScopedWorkspaceState(context.workspaceState as never, workspace)).loadRuns());
  const delegations = ledger.snapshot().flatMap((run) => run.delegations);
  expect(delegations.filter((row) => row.agentId === 'reviewer')).toEqual([]);
  expect(delegations.find((row) => row.handle === laterHandle)?.dispositions?.map((event) => event.disposition)).toEqual(['accepted']);
  // Codex's audit of 63658176 (RC-1): the refusal is kept once, after a reload, in the run of the request that
  // dispatched it. That request had ended, so its run is closed; it holds no delegation and no decision.
  const runs = ledger.snapshot();
  const holding = runs.filter((run) => run.refusedDispatches.length > 0);
  expect(holding).toHaveLength(1);
  expect(holding[0]).toMatchObject({ status: 'closed', delegations: [], openingTurnId: firstTurnId });
  expect(holding[0].refusedDispatches).toHaveLength(1);
  expect(holding[0].refusedDispatches[0]).toMatchObject({ requestedAgent: 'reviewer' });
  expect(holding[0].refusedDispatches[0].reason).toMatch(/^It did not start, so it never took this task\. No Codex CLI is selected/);
  expect(runs.find((run) => run.delegations.some((row) => row.handle === laterHandle))?.refusedDispatches).toEqual([]);
  // The evidence pack counts it once.
  expect(runs.map((run) => buildPortableRunEvidence(run).accounting.refusedBeforeDispatch).reduce((a, b) => a + b, 0)).toBe(1);
  // Retest 3 (the Owner): that request took no work, so it closes Partial, not Complete, and its Job outcome says why:
  // the refusal arrived after the PM's reply had closed the run, and the close was computed again with it.
  expect(holding[0].refusedDispatches[0].taskState).toBe('not-started');
  expect(holding[0].closeoutCompletionState).toBe('partial');
  const outcome = projectJobOutcome(holding[0].id, holding[0], () => undefined);
  expect(outcome).toMatchObject({ completion: 'partial', remaining: { state: 'some', closeoutPartial: false,
    blocked: [{ requested: 'reviewer', reason: 'not-started' }] } });
  const view = jobOutcomeView(outcome, { agentName: (id) => (id === 'reviewer' ? 'Codex Reviewer' : undefined) });
  const remaining = view.sections.find((section) => section.title === 'Remaining');
  expect(remaining?.items).toEqual(['Codex Reviewer: did not start, so it never took this task']);
  expect(remaining?.note).not.toContain('nothing listed here accounts for it');
  // The later request, whose task ran and was accepted, still closes complete.
  expect(runs.find((run) => run.delegations.some((row) => row.handle === laterHandle))?.closeoutCompletionState).toBe('complete');
  expect(host.warnings.filter((text) => text.includes('Codex Reviewer did not start'))).toHaveLength(1);
  // Nor does the PM's strip keep a reminder of it after a reload.
  const { lines } = await readReloadedStrip();
  expect(lines.filter((line) => line.includes('Review add.js') || /Reminder/.test(line))).toEqual([]);
});
