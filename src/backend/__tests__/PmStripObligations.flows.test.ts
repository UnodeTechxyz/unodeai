import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ workspace: { workspaceFolders: [] } }));

import { TeamTools, type DelegationExecutionObservation, type TeamRosterEntry, type TeamView } from '../TeamTools';
import { MessageBus } from '../../bus/MessageBus';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { TaskInputResolver } from '../TaskContract';
import { RunLedger, type RunHostIdentity, type RunRecord } from '../../observability/RunLedger';
import { PersistenceManager } from '../../state/PersistenceManager';
import { pmLiveRelevant, pmLiveStrip, type PmLiveLine } from '../../session/PmLiveStrip';

/*
 * v0.9.102 (the Owner, 2026-11-13: every leftover item can be resolved; design draft 5, Codex design PASS): each open
 * item on the PM strip is closed by the action it offers, through the production tool, and stays closed after the
 * window reloads. A reload is the production path: the runs are saved and loaded by PersistenceManager, a new RunLedger
 * is built from them, and the activation's reconciliation runs. Nothing here is a model: the PM's decisions are the
 * tool calls a PM makes.
 */

const WINDOW: RunHostIdentity = { hostInstanceId: 'window-a', epoch: 'epoch-1' };
const RELOADED: RunHostIdentity = { hostInstanceId: 'window-a', epoch: 'epoch-2' };
const OTHER_WINDOW: RunHostIdentity = { hostInstanceId: 'window-b', epoch: 'epoch-b' };
const REPLIED = '2026-11-01T00:00:00.000Z';
const FINISHED_AT = '2026-11-10T08:28:04.444Z';

function contract(): Record<string, unknown> {
  return {
    version: 1, objective: 'Redo the review.', expected_deliverable: 'Return the review.',
    effects: { read_files: [], expected_file_effect: 'none' }, inputs: [], constraints: [], dependencies: [],
    required_capabilities: { version: 1, capabilities: [] }, execution_strategy: 'delegate-required',
  };
}

function storage() {
  const values = new Map<string, unknown>();
  const memento = {
    get: <T>(key: string, fallback?: T) => (values.has(key) ? structuredClone(values.get(key)) as T : fallback),
    update: async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, structuredClone(value)); },
    keys: () => [...values.keys()],
  };
  return { manager: (host: RunHostIdentity) => new PersistenceManager({ workspaceState: memento } as never, undefined, () => '/workspace', host) };
}

/** The window reloads: its runs are saved, loaded again by a new host epoch, and reconciled as activation does. */
async function reload(ledger: RunLedger, host: RunHostIdentity = RELOADED): Promise<RunLedger> {
  const disk = storage();
  await disk.manager(WINDOW).saveRuns(ledger.snapshot());
  const next = new RunLedger(await disk.manager(host).loadRuns(), { host });
  next.reconcileRestoredActiveDelegations();
  return next;
}

const teams: TeamTools[] = [];
const buses: MessageBus[] = [];
afterEach(() => {
  for (const team of teams.splice(0)) team.cancelPending('test cleanup');
  for (const bus of buses.splice(0)) bus.dispose();
});

/** The PM's team tools in a window, connected to that window's ledger as activation connects them. */
function pmTools(ledger: RunLedger, executions = new Map<string, DelegationExecutionObservation>()) {
  const bus = new MessageBus();
  buses.push(bus);
  const roster: TeamRosterEntry[] = [
    { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
    { id: 'analyst', role: 'custom', name: 'Contract Analyst', status: 'idle' },
  ];
  const view: TeamView = {
    list: () => roster,
    resolve: (ref) => { const found = roster.find((entry) => entry.id === ref || entry.name === ref); return found ? { id: found.id } : undefined; },
    preflightTaskScope: () => undefined,
    execution: (agentId, handle) => executions.get(`${agentId}:${handle}`) ?? { state: 'not-running' },
  };
  const team = new TeamTools('pm', view, bus, {
    timeoutMs: 60_000,
    evidenceEnabled: true,
    cwd: process.cwd(),
    taskInputResolver: new TaskInputResolver(new ContentAssetStore(), process.cwd()),
    onDelegationDispatched: (event) => ledger.recordDelegationDispatched({ ...event, originCorrelationId: 'redo-request' }),
    onDelegationEvidence: (event) => ledger.recordDelegationEvidence(event),
    onDelegationCancelled: (event) => ledger.recordDelegationCancelled(event),
    onDelegationInterrupted: (event) => ledger.recordDelegationInterrupted(event),
    onDelegationDisposition: (event) => ledger.recordDisposition(event),
    // As activation connects it (OrchestrationHostAdapter → extension.ts resultReworkStarted).
    onResultReworkStarted: (handle) => ledger.beginResultRework('pm', handle),
    inspectTaskStatus: (handles) => ledger.inspectTaskStatus('pm', handles),
  });
  teams.push(team);
  return { team, executions };
}

/** A finished review of an earlier request, written by an earlier window: settled, its result reserved and stored. */
function earlierWindowResult(handle: string, instruction = 'Review the MetaBlox B300 v2.2 contract and list every risk.\nDetails follow.'): RunLedger {
  const earlier = new RunLedger([], { host: WINDOW });
  earlier.recordDelegationDispatched({ coordinatorId: 'pm', handle, agentId: 'analyst', requestedAgent: 'Contract Analyst',
    instruction, attemptId: `attempt-${handle}`, originCorrelationId: `request-${handle}`, dispatchedAt: '2026-11-10T08:00:00.000Z' });
  earlier.recordDelegationEvidence({ handle, agentId: 'analyst', outcome: 'no-evidence', settledAt: FINISHED_AT, evidence: {
    outcome: 'no-evidence', completionState: 'complete', changedFiles: [], hadToolActions: false, unrecordedWrites: false,
    verification: { ran: false } } } as never);
  const identity = earlier.resultIdentity('pm', handle);
  expect(identity, 'the task holds a result reservation').toBeDefined();
  earlier.recordResultSettlement(identity!, 'ready');
  return earlier;
}

/** The stored runs with the result's copies made to conflict: two settlements of the same revision. */
function withConflict(ledger: RunLedger, handle: string): RunLedger {
  const runs = structuredClone(ledger.snapshot()) as RunRecord[];
  const delegation = runs.flatMap((run) => run.delegations).find((row) => row.handle === handle)!;
  delegation.resultHistory = [...delegation.resultHistory!, { ...delegation.resultHistory![0], settledEventId: 'a-second-settlement' }];
  return new RunLedger(runs, { host: WINDOW });
}

/** What the strip shows for the PM, read from this ledger as the window reads it, with the PM's last final reply. */
function strip(ledger: RunLedger, repliedAt = REPLIED): PmLiveLine[] {
  const tasks = ledger.inspectTaskStatusWhere('pm', pmLiveRelevant(repliedAt));
  return pmLiveStrip({ held: false, tasks, stripFacts: ledger.pmStripFactsOf('pm', tasks.map((task) => task.handle)),
    repliedAt, queued: new Set(), starting: 0, waitingForAccess: [], agentNames: new Map([['analyst', 'Contract Analyst']]) })?.lines ?? [];
}
const texts = (lines: PmLiveLine[]): string[] => lines.map((line) => ('text' in line ? line.text : `Running: ${line.tasks.map((task) => task.agent).join(', ')}`));
const row = (ledger: RunLedger, handle: string) => ledger.inspectTaskStatus('pm', [handle]).find((entry) => entry.handle === handle)!;
/** Whether the request this task belongs to can close: nothing of it blocks completion. */
const blocks = (ledger: RunLedger, handle: string): boolean => row(ledger, handle).result?.blocksComplete === true;

/** A real replacement: the PM dispatches the work again; the host observes the new handle. */
async function redo(team: TeamTools): Promise<string> {
  const out = await team.run('dispatch_task', { agent: 'analyst', instruction: 'Redo the contract review.', contract: contract() });
  const handle = /Handle: ([0-9a-f-]+)/i.exec(out)?.[1];
  expect(handle, out).toBeDefined();
  return handle!;
}

describe('a finished result whose saved text is not available here: the reminder, and each decision that closes it', () => {
  it('after a reload it is a dated, labelled reminder with Ask the PM; abandoned is refused; rejected closes it for good', async () => {
    const ledger = await reload(Object.assign(earlierWindowResult('older-review'), {}));
    ledger.resultRecovery('pm', 'older-review', 'body-unavailable');
    const [reminder, ...rest] = strip(ledger);
    expect(rest).toEqual([]);
    expect(reminder).toMatchObject({ kind: 'reminder', prompt: expect.stringContaining('handle older-review') });
    expect((reminder as { text: string }).text).toMatch(new RegExp('^Reminder: Contract Analyst\'s task "Review the MetaBlox B300 v2\\.2 contract and '
      + 'list every risk\\." \\(finished \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\): its saved result text is not available in this window, and it has not '
      + 'been handed to the PM yet\\. To clear this, press Ask the PM, then Send: the PM inspects it and records what to do with it\\.$'));
    // The PM's own hint names the decisions a settled result takes, never abandoned.
    const { team } = pmTools(ledger);
    const inspected = await team.run('inspect_task_status', { handles: ['older-review'] });
    expect(inspected).toContain('record rejected or deferred with your reason');
    expect(inspected).not.toContain('abandoned, if the task can go on without it');
    expect(await team.run('record_task_disposition', { handle: 'older-review', disposition: 'abandoned', reason: 'Not needed.' }))
      .toMatch(/^Error: abandoned is only valid for interrupted work/);
    expect(blocks(ledger, 'older-review')).toBe(true);

    expect(await team.run('record_task_disposition', { handle: 'older-review', disposition: 'rejected', reason: 'The newer review replaces it.' }))
      .toContain('Recorded coordinator rejection for older-review');
    expect(strip(ledger)).toEqual([]);
    expect(blocks(ledger, 'older-review')).toBe(false);
    const after = await reload(ledger, { hostInstanceId: 'window-a', epoch: 'epoch-3' });
    expect(strip(after)).toEqual([]);
    expect(blocks(after, 'older-review')).toBe(false);
  });

  it('superseded by a real new dispatch closes it; the new task is the one shown running', async () => {
    const ledger = await reload(earlierWindowResult('older-review'));
    ledger.resultRecovery('pm', 'older-review', 'body-unavailable');
    const { team } = pmTools(ledger);
    // Superseded needs a host-observed replacement; a handle the PM names without dispatching is refused.
    expect(await team.run('record_task_disposition', { handle: 'older-review', disposition: 'superseded', reason: 'Redone.', replacement_handle: 'made-up' }))
      .toMatch(/^Error: superseded replacement_handle must identify a different host-observed dispatch_task/);
    const replacement = await redo(team);
    expect(await team.run('record_task_disposition', { handle: 'older-review', disposition: 'superseded', reason: 'Redone.', replacement_handle: replacement }))
      .toContain('Recorded older-review as superseded');
    expect(blocks(ledger, 'older-review')).toBe(false);
    expect(texts(strip(ledger))).toEqual(['Running: Contract Analyst', 'The PM reports here when results come back.']);
    const after = await reload(ledger, { hostInstanceId: 'window-a', epoch: 'epoch-3' });
    expect(blocks(after, 'older-review')).toBe(false);
    expect(texts(strip(after)).join(' ')).not.toContain('older-review');
  });
});

describe('a result whose copies conflict or whose decision scope is unknown (design §4.1): only a replacement or a rejection closes it', () => {
  const cases = [
    ['conflicting copies', (ledger: RunLedger) => withConflict(ledger, 'older-review')],
    ['decision scope unknown', (ledger: RunLedger) => { ledger.resultRecovery('pm', 'older-review', 'decision-scope-unknown'); return ledger; }],
  ] as const;

  for (const [name, make] of cases) {
    it(`${name}: other decisions are refused with the two that work, and change nothing`, async () => {
      const ledger = await reload(make(earlierWindowResult('older-review')));
      expect(row(ledger, 'older-review').result).toMatchObject({ state: 'unknown', blocksComplete: true });
      expect(strip(ledger)).toEqual([expect.objectContaining({ kind: 'reminder',
        text: expect.stringContaining('UnodeAi cannot tell which decision applies to it'),
        prompt: expect.stringContaining('record rejected with your reason; either closes it') })]);
      const { team } = pmTools(ledger);
      expect(await team.run('inspect_task_status', { handles: ['older-review'] })).toContain('It cannot be accepted, deferred or sent for rework.');
      for (const [disposition, reason] of [['accepted', undefined], ['deferred', 'Later.'], ['needs-human', 'Ask.'], ['needs-rework', 'Fix it.']] as const) {
        expect(await team.run('record_task_disposition', { handle: 'older-review', disposition, ...(reason ? { reason } : {}) }))
          .toMatch(/^Error: UnodeAi cannot tell which result of task older-review a decision would apply to .* Record superseded with the replacement_handle of a real new dispatch_task .* or rejected with your reason .* The ledger was not changed\.$/);
      }
      expect(row(ledger, 'older-review').disposition).toBeUndefined();
      expect(blocks(ledger, 'older-review')).toBe(true);
    });

    it(`${name}: rejected closes it, and it stays closed after a reload, with its history kept`, async () => {
      const ledger = await reload(make(earlierWindowResult('older-review')));
      const { team } = pmTools(ledger);
      expect(await team.run('record_task_disposition', { handle: 'older-review', disposition: 'rejected', reason: 'Not needed any more.' }))
        .toContain('Recorded coordinator rejection for older-review');
      for (const read of [ledger, await reload(ledger, { hostInstanceId: 'window-a', epoch: 'epoch-3' })]) {
        expect(row(read, 'older-review').result).toMatchObject({ state: 'historical', blocksComplete: false,
          scope: { state: 'closed', cause: 'handle-abandoned', by: 'host-lifecycle' } });
        expect(strip(read)).toEqual([]);
      }
      const stored = ledger.snapshot().flatMap((run) => run.delegations).find((entry) => entry.handle === 'older-review')!;
      if (name === 'conflicting copies') expect(stored.resultHistory?.[0].conflict).toBe(true);
      else expect(stored.resultRecovery).toBe('decision-scope-unknown');
    });

    it(`${name}: superseded by a real new dispatch closes it, and it stays closed after a reload`, async () => {
      const ledger = await reload(make(earlierWindowResult('older-review')));
      const { team } = pmTools(ledger);
      const replacement = await redo(team);
      expect(await team.run('record_task_disposition', { handle: 'older-review', disposition: 'superseded', reason: 'Redone.', replacement_handle: replacement }))
        .toContain('Recorded older-review as superseded');
      for (const read of [ledger, await reload(ledger, { hostInstanceId: 'window-a', epoch: 'epoch-3' })]) {
        expect(row(read, 'older-review').result).toMatchObject({ state: 'historical', blocksComplete: false, scope: { state: 'closed', cause: 'handle-superseded' } });
        expect(texts(strip(read)).join(' ')).not.toContain('which decision applies');
      }
    });
  }

  it('copies from two windows that conflict, one already superseded by a real dispatch, are closed when they merge', async () => {
    const base = earlierWindowResult('older-review');
    // Another window's copy of the same run settled the same revision differently.
    const otherCopy = structuredClone(base.snapshot()) as RunRecord[];
    otherCopy.flatMap((run) => run.delegations).find((entry) => entry.handle === 'older-review')!.resultHistory![0].settledEventId = 'window-b-settlement';
    const ledger = await reload(base);
    const { team } = pmTools(ledger);
    const replacement = await redo(team);
    expect(await team.run('record_task_disposition', { handle: 'older-review', disposition: 'superseded', reason: 'Redone.', replacement_handle: replacement }))
      .toContain('Recorded older-review as superseded');
    expect(row(ledger, 'older-review').result).toMatchObject({ state: 'decided' });
    ledger.snapshotForPersistence(otherCopy);
    expect(row(ledger, 'older-review').result).toMatchObject({ state: 'historical', blocksComplete: false, conflict: true, scope: { cause: 'handle-superseded' } });
  });

  it('a conflicting result an earlier version already recorded as superseded is closed when its runs are loaded', async () => {
    const ledger = await reload(withConflict(earlierWindowResult('older-review'), 'older-review'));
    const { team } = pmTools(ledger);
    const replacement = await redo(team);
    expect(await team.run('record_task_disposition', { handle: 'older-review', disposition: 'superseded', reason: 'Redone.', replacement_handle: replacement }))
      .toContain('Recorded older-review as superseded');
    // As an earlier version stored it: the terminal decision recorded, no closed scope written.
    const runs = structuredClone(ledger.snapshot()) as RunRecord[];
    for (const result of runs.flatMap((run) => run.delegations).find((entry) => entry.handle === 'older-review')!.resultHistory!) delete result.decisionScopes;
    const loaded = await reload(new RunLedger(runs, { host: WINDOW }), { hostInstanceId: 'window-a', epoch: 'epoch-3' });
    expect(row(loaded, 'older-review').result).toMatchObject({ state: 'historical', blocksComplete: false, scope: { cause: 'handle-superseded' } });
  });
});

/*
 * v0.9.102 (Codex's audit of 2ddf9c46, F1; the Owner, 2026-11-13: fix it now): the decision owed and the report owed
 * close only by their own facts. A decision does not report a result; a reply does not decide it.
 */
describe('the decision owed and the report owed are separate: neither closes the other', () => {
  it('F1a: a conflicting result the PM received is owed its report after the PM rejects it, until the PM\'s reply, also after a reload', async () => {
    const ledger = await reload(withConflict(earlierWindowResult('older-review'), 'older-review'));
    const deliveredAt = '2026-11-13T08:00:03.000Z';
    ledger.recordDeliveryDelivered('older-review', 'auto-wake', deliveredAt);
    const { team } = pmTools(ledger);
    expect(await team.run('record_task_disposition', { handle: 'older-review', disposition: 'rejected', reason: 'Not needed any more.' }))
      .toContain('Recorded coordinator rejection for older-review');
    expect(row(ledger, 'older-review').result).toMatchObject({ state: 'historical', blocksComplete: false });
    const owed = [{ kind: 'continue', text: 'Contract Analyst finished, but the PM has not reported on it.', prompt: 'Please review the finished results and report to me.' }];
    const lastReply = '2026-11-13T08:00:00.000Z';
    expect(strip(ledger, lastReply)).toEqual(owed);
    const reloaded = await reload(ledger, { hostInstanceId: 'window-a', epoch: 'epoch-3' });
    expect(strip(reloaded, lastReply)).toEqual(owed);
    // The PM's final reply after it reports it.
    expect(strip(reloaded, '2026-11-13T08:01:00.000Z')).toEqual([]);
  });

  it('F1b: a result the PM replied about without a decision keeps its decision owed until the PM records one, also after a reload', async () => {
    const ledger = await reload(earlierWindowResult('older-review'));
    const deliveredAt = '2026-11-13T08:00:03.000Z';
    ledger.recordDeliveryDelivered('older-review', 'auto-wake', deliveredAt);
    expect(row(ledger, 'older-review').result).toMatchObject({ state: 'awaiting-decision', blocksComplete: true });
    // The PM replies after it received the result, and records no decision.
    const replied = '2026-11-13T08:01:00.000Z';
    for (const read of [ledger, await reload(ledger, { hostInstanceId: 'window-a', epoch: 'epoch-3' })]) {
      expect(strip(read, replied)).toEqual([expect.objectContaining({ kind: 'reminder',
        text: expect.stringMatching(/^Reminder: Contract Analyst's task "Review the MetaBlox B300 v2\.2 contract and list every risk\." \(finished [^)]+\): the PM received it [^ ]+ [^ ]+ and has not recorded a decision on it\./),
        prompt: expect.stringContaining('handle older-review') })]);
    }
    const { team } = pmTools(ledger);
    expect(await team.run('record_task_disposition', { handle: 'older-review', disposition: 'accepted' }))
      .toContain('Recorded coordinator acceptance for older-review');
    expect(strip(ledger, replied)).toEqual([]);
    expect(strip(await reload(ledger, { hostInstanceId: 'window-a', epoch: 'epoch-4' }), replied)).toEqual([]);
  });
});

describe('interrupted work: abandoned or a real replacement closes it', () => {
  it('a task running when its window reloaded is an interrupted reminder, never "Running"; abandoned closes it for good', async () => {
    const first = new RunLedger([], { host: WINDOW });
    const { team } = pmTools(first);
    const handle = await redo(team);
    expect(texts(strip(first))).toEqual(['Running: Contract Analyst', 'The PM reports here when results come back.']);
    const ledger = await reload(first);
    const lines = strip(ledger);
    expect(lines).toEqual([expect.objectContaining({ kind: 'reminder',
      text: expect.stringMatching(/^Reminder: Contract Analyst's task "Redo the contract review\." \(interrupted \d{4}-\d\d-\d\d \d\d:\d\d\): it was interrupted when its window closed or reloaded\./),
      prompt: expect.stringContaining(`dispatch_task with replaces_handle "${handle}") or record_task_disposition abandoned with your reason`) })]);
    const { team: reloaded } = pmTools(ledger);
    expect(await reloaded.run('record_task_disposition', { handle, disposition: 'rejected', reason: 'No.' }))
      .toMatch(/^Error: interrupted work accepts only superseded or abandoned/);
    expect(await reloaded.run('record_task_disposition', { handle, disposition: 'abandoned', reason: 'No longer needed.' }))
      .toContain(`Recorded interrupted assignment ${handle} as abandoned`);
    expect(strip(ledger)).toEqual([]);
    expect(strip(await reload(ledger, { hostInstanceId: 'window-a', epoch: 'epoch-3' }))).toEqual([]);
  });

  it('a rework running when its window reloaded is interrupted, not running; abandoned lets its request close', async () => {
    const earlier = earlierWindowResult('older-review');
    earlier.recordDisposition({ handle: 'older-review', agentId: 'analyst', disposition: 'needs-rework', reason: 'Add the risks.',
      recordedAt: '2026-11-10T09:00:00.000Z', outcome: 'no-evidence' });
    earlier.beginResultRework('pm', 'older-review');
    expect(row(earlier, 'older-review').result).toMatchObject({ state: 'running' });
    const ledger = await reload(earlier);
    expect(row(ledger, 'older-review').recordedState).toBe('interrupted');
    expect(row(ledger, 'older-review').result?.state).not.toBe('running');
    expect(strip(ledger)).toEqual([expect.objectContaining({ kind: 'reminder', text: expect.stringContaining('it was interrupted when its window closed or reloaded') })]);
    const { team } = pmTools(ledger);
    expect(await team.run('record_task_disposition', { handle: 'older-review', disposition: 'abandoned', reason: 'Not needed.' }))
      .toContain('as abandoned');
    expect(blocks(ledger, 'older-review')).toBe(false);
    expect(strip(ledger)).toEqual([]);
  });
});

describe('a person\'s decision and rework owed change into their next state; they are not cleared by a disposition', () => {
  it('needs-human becomes the person\'s decision with Review Delivered Work; needs-rework becomes rework owed, then running when it starts', async () => {
    const ledger = await reload(earlierWindowResult('older-review'));
    ledger.resultRecovery('pm', 'older-review', 'body-unavailable');
    const { team } = pmTools(ledger);
    expect(await team.run('record_task_disposition', { handle: 'older-review', disposition: 'needs-human', reason: 'Which jurisdiction applies?' }))
      .toContain('requires human intervention');
    expect(strip(ledger)).toEqual([{ kind: 'decision', review: true,
      text: 'Needs your decision: Contract Analyst\'s task "Review the MetaBlox B300 v2.2 contract and list every risk." — Which jurisdiction applies?.' }]);

    const second = await reload(earlierWindowResult('second-review'));
    second.resultRecovery('pm', 'second-review', 'body-unavailable');
    const { team: tools } = pmTools(second);
    expect(await tools.run('record_task_disposition', { handle: 'second-review', disposition: 'needs-rework', reason: 'Add the risks.' }))
      .toContain('Recorded needs-rework for second-review');
    // The rework was sent, so it started here: a rework of an old handle after a restart is live, and is shown running.
    expect(texts(strip(second))).toEqual(['Running: Contract Analyst', 'The PM reports here when results come back.']);
  });
});

describe('what the strip knows about where a task runs (R1): this window\'s own attempts only', () => {
  it('a dispatch and a rework started here are; restored, merged and adopted records are not', async () => {
    const first = new RunLedger([], { host: WINDOW });
    const { team } = pmTools(first);
    const handle = await redo(team);
    expect(first.pmStripFactsOf('pm', [handle]).get(handle)).toEqual({ label: 'Redo the contract review.', startedHere: true, liveElsewhere: false, runOpen: true });

    // Restored after a reload: not started here (and reconciled as interrupted).
    const restored = await reload(first);
    expect(restored.pmStripFactsOf('pm', [handle]).get(handle)?.startedHere).toBe(false);

    // Merged from another live window: not started here, live there; said as that, with no button.
    const other = new RunLedger([], { host: OTHER_WINDOW });
    other.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'theirs', agentId: 'analyst', requestedAgent: 'Contract Analyst',
      instruction: 'Summarise the lease.', attemptId: 'attempt-theirs', originCorrelationId: 'their-request', dispatchedAt: new Date().toISOString() });
    const here = new RunLedger([], { host: RELOADED });
    here.snapshotForPersistence(other.snapshot());
    expect(here.pmStripFactsOf('pm', ['theirs']).get('theirs')).toMatchObject({ startedHere: false, liveElsewhere: true });
    expect(strip(here)).toEqual([{ kind: 'elsewhere', text: 'Contract Analyst\'s task "Summarise the lease." is being handled in another UnodeAi window.' }]);

    // A settled result whose owner this window adopts is not an attempt it started.
    const adopted = await reload(earlierWindowResult('older-review'), { hostInstanceId: 'window-c', epoch: 'epoch-c' });
    expect(adopted.adoptSettledResultOwner('pm', 'older-review', new Date(Date.now() + 3_600_000).toISOString())).toBe(true);
    expect(adopted.pmStripFactsOf('pm', ['older-review']).get('older-review')?.startedHere).toBe(false);

    // A rework this window starts on that old handle is.
    adopted.beginResultRework('pm', 'older-review');
    expect(adopted.pmStripFactsOf('pm', ['older-review']).get('older-review')?.startedHere).toBe(true);
    expect(texts(strip(adopted))).toEqual(['Running: Contract Analyst', 'The PM reports here when results come back.']);
  });
});
