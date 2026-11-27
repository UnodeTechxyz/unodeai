import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({ workspace: { workspaceFolders: [] } }));
import { cleanupResultDeliveryCases, setup } from './resultDeliveryHostFixture';
import { ResultDeliveryHost, resultDeliveryMarkerMatches } from '../ResultDeliveryHost';
import { MessageBus } from '../../../bus/MessageBus';
import { SessionManager } from '../../../session/SessionManager';
import type { AgentBackend } from '../../../backend/AgentBackend';
import type { AgentConfig } from '../../../types';
import { TeamTools } from '../../../backend/TeamTools';
import { DelegationResultBodyStore } from '../../../state/DelegationResultBodyStore';
import { projectJobOutcome } from '../../../observability/JobOutcome';
import { TaskInputResolver } from '../../../backend/TaskContract';
import { ContentAssetStore } from '../../../content/ContentAssetStore';
import { DelegationResultMailbox } from '../../../state/DelegationResultMailbox';
import { workspaceRootIdentity } from '../../../state/WorkspaceRootIdentity';

afterEach(cleanupResultDeliveryCases);

describe('T2b actual host consumer with real body files and PersistenceManager', () => {
  // v0.9.103 (G5): only assign_task's wait times out. A dispatch_task arms no wait timer: its result, however late, is
  // its only settlement.
  it.each([
    ['assign_task', 'task.complete', 0], ['dispatch_task', 'task.complete', 0], ['dispatch_task', 'task.partial', 1],
  ] as const)('F4: %s past its wait, then a late %s, leaves %s unfinished', async (tool, completion, unfinished) => {
    const h = await setup(); const bus = new MessageBus();
    const mailboxSettlement = vi.spyOn(DelegationResultMailbox.prototype, 'settle');
    let handle = '';
    const team = new TeamTools('pm', { list: () => [{ id: 'dev', name: 'Dev', role: 'custom', status: 'idle' }],
      resolve: () => ({ id: 'dev' }) }, bus, {
      timeoutMs: 100, evidenceEnabled: true, cwd: process.cwd(),
      taskInputResolver: new TaskInputResolver(new ContentAssetStore(), process.cwd()),
      onDelegationDispatched: event => {
        handle = event.handle;
        h.ledger().recordDelegationDispatched({ ...event, originCorrelationId: 'user-task' });
        h.host().reserve('pm', event.handle);
      },
      onDelegationEvidence: event => h.ledger().recordDelegationEvidence(event),
      onAsyncResultRetained: result => { h.host().retain('pm', result); },
      resultRevisionFor: value => h.ledger().resultIdentity('pm', value)?.ref.revision,
      isAsyncResultEligible: (value, revision) => h.host().canDeliver('pm', value, revision),
      prepareAsyncResultDelivery: (value, revision) => h.host().prepare('pm', value, revision),
      onAsyncResultDelivered: (value, via, revision) => {
        h.host().delivered('pm', value, via, revision); h.ledger().recordDeliveryDelivered(value, via);
      },
    });
    vi.useFakeTimers();
    try {
      const waiting = team.run(tool, { agent: 'dev', instruction: 'Return the draft.', contract: {
        version: 1, objective: 'Return the draft.', expected_deliverable: 'The draft.',
        effects: { read_files: [], expected_file_effect: 'none' }, inputs: [], constraints: [], dependencies: [],
        required_capabilities: { version: 1, capabilities: [] }, execution_strategy: 'delegate-required',
      } });
      await vi.advanceTimersByTimeAsync(100);
      expect(await waiting).toContain(tool === 'assign_task' ? 'ended only the wait' : 'Dispatched contract');
      if (tool === 'assign_task') {
        expect(h.ledger().snapshot()[0].delegations[0]).toMatchObject({ state: 'active', evidence: { outcome: 'timed-out' } });
      } else {
        expect(h.ledger().snapshot()[0].delegations[0]).toMatchObject({ state: 'active' });
        expect(h.ledger().snapshot()[0].delegations[0].evidence).toBeUndefined();
      }
      bus.send('dev', 'pm', completion, { instruction: 'The completed late draft.' }, 'normal', handle);
      await Promise.resolve(); await Promise.resolve();
    } finally { vi.useRealTimers(); }
    try {
      await h.host().drain();
      expect(await team.run('collect_ready_tasks', {})).toContain('The completed late draft.');
      await h.host().drain();
      expect(h.notice).not.toHaveBeenCalled();
      expect(mailboxSettlement.mock.results.map(row => row.value)).toEqual(['settled']);
      expect(h.ledger().inspectTaskStatus('pm', [handle])[0]).toMatchObject({ lifecycle: 'settled', delivery: { state: 'delivered' } });
      if (tool === 'dispatch_task') {
        const receipts = h.ledger().snapshot()[0].delegations[0].evidence?.receiptSnapshots;
        expect(receipts).toMatchObject({ terminal: { requiredInputCount: 0 } });
        expect(receipts?.timeout).toBeUndefined();
        expect(h.ledger().snapshot()[0].delegations[0].evidence?.outcome).not.toBe('timed-out');
      }
      h.ledger().observeMessage(bus.send('pm', 'user', 'task.complete', { instruction: 'Used the late draft.' }, 'normal', 'user-task'));
      const run = h.ledger().snapshot()[0];
      expect(projectJobOutcome(run.id, run, () => undefined)).toMatchObject({ work: { unfinished } });
    } finally { mailboxSettlement.mockRestore(); team.cancelPending('test cleanup'); bus.dispose(); }
  });
  // Audit of 35f593f8 (I1): a result whose save failed could never be handed over after a reload, yet it stayed
  // collectable and kept its run open for a wake that could not come.
  describe('a result whose body did not survive a reload', () => {
    const lost = async () => {
      const h = await setup();
      h.dispatch();
      const save = vi.spyOn(h.persistence, 'saveResultMailboxEntry').mockResolvedValue(false);
      await h.settle();
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBe('recovery-data-not-saved');
      save.mockRestore();
      h.notice.mockClear();
      await h.reload();
      return h;
    };
    const reply = (h: Awaited<ReturnType<typeof setup>>) => h.ledger().observeMessage({ id: 'closing', from: 'pm', to: 'user', type: 'task.complete',
      payload: { instruction: 'done' }, priority: 'normal', correlationId: 'user-task', timestamp: new Date().toISOString() } as never);

    it('stops saying it can be collected, tells the person, and saves that', async () => {
      const h = await lost();
      expect(h.host().recover('pm')).toEqual([]);
      const row = h.ledger().snapshot()[0].delegations[0];
      expect(row.resultRecovery).toBe('body-unavailable');
      expect(h.ledger().resultsAwaitingCollection()).toEqual([]);
      expect(h.notice).toHaveBeenCalledWith('pm', 'unavailable');
      expect(h.logRecoveryWarning).toHaveBeenCalledWith('pm', 'body-unavailable');
      expect(h.notice).toHaveBeenCalledOnce();
      // Saved, so the next reload neither reports it again nor needs to find it out again.
      await h.reload();
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBe('body-unavailable');
      expect(h.notice).toHaveBeenCalledOnce();
    });

    it('a result that settles while recovery is still running is held, not lost', async () => {
      const h = await setup();
      let release = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const realOpen = DelegationResultBodyStore.open.bind(DelegationResultBodyStore);
      const open = vi.spyOn(DelegationResultBodyStore, 'open').mockImplementation(async (options) => { await gate; return realOpen(options); });
      const reloading = h.reload();
      await vi.waitFor(() => expect(open).toHaveBeenCalled());
      h.ledger().recordDelegationDispatched({ coordinatorId: 'pm', handle: 'late', agentId: 'dev', requestedAgent: 'dev',
        instruction: 'do the work', attemptId: 'attempt-late', originCorrelationId: 'user-task' });
      h.ledger().recordDelegationEvidence({ handle: 'late', agentId: 'dev', outcome: 'no-evidence', evidence: {
        outcome: 'no-evidence', completionState: 'complete', changedFiles: [], hadToolActions: false, unrecordedWrites: false, verification: { ran: false } } });
      h.host().retain('pm', { handle: 'late', ref: 'dev', text: 'late answer' });
      release();
      await reloading;
      open.mockRestore();
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).not.toBe('body-unavailable');
      expect(h.host().recover('pm').map((result) => result.handle)).toEqual(['late']);
    });

    it('keeps its run open: a reply is not what ends the wait', async () => {
      const h = await lost();
      reply(h);
      expect(h.ledger().snapshot()[0]).toMatchObject({ status: 'open' });
      expect(h.ledger().snapshot()[0].closeoutCompletionState).toBeUndefined();
    });

    it('a body that is really there stays collectable, and a later reload that finds it clears the state', async () => {
      const h = await setup();
      h.dispatch();
      await h.settle();
      await h.reload();
      expect(h.ledger().resultsAwaitingCollection()).toEqual([{ coordinatorId: 'pm', handle: 'h' }]);
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBeUndefined();
      expect(h.notice).not.toHaveBeenCalled();
      expect(h.host().recover('pm')).toHaveLength(1);
      // The store is unreadable for one reload. It comes back on the next one.
      const read = vi.spyOn(h.persistence, 'readResultMailboxEntry').mockResolvedValue(undefined as never);
      await h.reload();
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBe('body-unavailable');
      read.mockRestore();
      await h.reload();
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBeUndefined();
      expect(h.ledger().resultsAwaitingCollection()).toHaveLength(1);
    });

    it('a result another window owns is not touched', async () => {
      const h = await lost();
      h.ledger().resultRecovery('pm', 'h', 'recovery-data-not-saved');
      const owned = new ResultDeliveryHost({ persistence: h.persistence, ledger: h.ledger(), storageUri: { scheme: 'file', fsPath: h.dir },
        workspaceId: workspaceRootIdentity(h.dir), assertCurrent: () => {}, owns: () => false, archive: h.archive, hasDelivery: () => false,
        recordDelivery: async () => {}, saveArchive: async () => {}, saveLedger: async () => {}, notice: h.notice });
      await owned.open(); await owned.drain(); owned.close();
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBe('recovery-data-not-saved');
    });

    it('an open failure of the store is reconciled too', async () => {
      const h = await setup();
      h.dispatch();
      await h.settle();
      const open = vi.spyOn(DelegationResultBodyStore, 'open').mockRejectedValue(new Error('storage gone'));
      await h.reload();
      open.mockRestore();
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBe('body-unavailable');
    });
  });

  // Audit of 9d8c5bcb (D1): an ordinary reply must not make a body that may still be there unreachable, which would turn
  // a brief disk problem into paid rework. Owner, 2026-11-01: not saved and unreadable are one rule.
  describe('a saved result that could not be read at a reload', () => {
    const unreadable = async () => {
      const h = await setup();
      h.dispatch();
      await h.settle();
      h.notice.mockClear();
      const read = vi.spyOn(h.persistence, 'readResultMailboxEntry').mockResolvedValue(undefined as never);
      await h.reload();
      read.mockRestore();
      return h;
    };
    const reply = (h: Awaited<ReturnType<typeof setup>>) => h.ledger().observeMessage({ id: 'closing', from: 'pm', to: 'user', type: 'task.complete',
      payload: { instruction: 'done' }, priority: 'normal', correlationId: 'user-task', timestamp: new Date().toISOString() } as never);

    it('offers no collection and tells the person once', async () => {
      const h = await unreadable();
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBe('body-unavailable');
      expect(h.ledger().resultsAwaitingCollection()).toEqual([]);
      expect(h.notice).toHaveBeenCalledWith('pm', 'unavailable');
      expect(h.notice).toHaveBeenCalledOnce();
      // Still unreadable at the next reload: the saved state stands, and the person is not told again.
      const read = vi.spyOn(h.persistence, 'readResultMailboxEntry').mockResolvedValue(undefined as never);
      await h.reload();
      read.mockRestore();
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBe('body-unavailable');
      expect(h.notice).toHaveBeenCalledOnce();
    });

    it('survives an ordinary reply, and the next good reload recovers it once, for delivery', async () => {
      const h = await unreadable();
      // The person's next message is how a coordinator gets to reply. It closes nothing.
      h.host().scope('pm', 'explicit-resume');
      reply(h);
      expect(h.ledger().snapshot()[0].status).toBe('open');
      expect(h.recoveryReady).not.toHaveBeenCalled();
      await h.reload();
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBeUndefined();
      expect(h.host().recover('pm').map((result) => result.text)).toEqual(['worker answer']);
      expect(h.recoveryReady).toHaveBeenCalledOnce();
    });

    it('a decision ends the wait, and the run can then end', async () => {
      const h = await unreadable();
      h.ledger().recordDisposition({ handle: 'h', coordinatorId: 'pm', agentId: 'dev', disposition: 'abandoned', reason: 'Gave up on it.', recordedAt: new Date().toISOString() } as never);
      reply(h);
      // Its only task was abandoned, so the run ends partial (Owner, 2026-11-02: never Complete beside unfinished work).
      expect(h.ledger().snapshot()[0]).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial' });
    });

    const stoppedTurn = (h: Awaited<ReturnType<typeof setup>>) => {
      h.ledger().observeMessage({ id: 'stop', from: 'pm', to: 'user', type: 'system.error', priority: 'normal', correlationId: 'user-task',
        payload: { instruction: 'stopped', metadata: { isError: true, cancelled: true, turnId: 'stopped-turn' } }, timestamp: new Date().toISOString() } as never);
      h.host().scope('pm', 'coordinator-stopped', true);
    };

    it('Stop of a running turn closes it for good: the task ends now, as partial, and a later reload does not bring it back', async () => {
      const h = await unreadable();
      stoppedTurn(h);
      const run = h.ledger().snapshot()[0];
      expect(run).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial', closingTurnId: 'stopped-turn' });
      expect(run.delegations[0].resultHistory?.[0].decisionScopes?.at(-1)).toMatchObject({ state: 'closed', cause: 'coordinator-stopped' });
      await h.reload();
      expect(h.ledger().snapshot()[0].status).toBe('closed');
      expect(h.ledger().resultsAwaitingCollection()).toEqual([]);
      expect(h.host().recover('pm')).toEqual([]);
      expect(h.host().canDeliver('pm', 'h')).toBe(false);
    });

    it('Stop closes only that result while the task still has other work, and the task goes on', async () => {
      const h = await setup();
      h.dispatch('gone');
      await h.settle('gone');
      h.notice.mockClear();
      const read = vi.spyOn(h.persistence, 'readResultMailboxEntry').mockResolvedValue(undefined as never);
      await h.reload();
      read.mockRestore();
      h.dispatch('running');
      stoppedTurn(h);
      const run = h.ledger().snapshot()[0];
      expect(run.status).toBe('open');
      const gone = run.delegations.find((row) => row.handle === 'gone')!;
      expect(gone.resultHistory?.[0].decisionScopes?.at(-1)?.state).toBe('closed');
      expect(run.delegations.find((row) => row.handle === 'running')?.state).toBe('active');
      reply(h);
      expect(h.ledger().snapshot()[0].status).toBe('open');
    });

    it('stopping an agent with no turn running changes nothing about it: only the coordinator\'s decision or a later reload does', async () => {
      const h = await unreadable();
      h.host().scope('pm', 'coordinator-stopped', false);
      const run = h.ledger().snapshot()[0];
      expect(run.status).toBe('open');
      expect(run.delegations[0].resultHistory?.[0].decisionScopes ?? []).toEqual([]);
      await h.reload();
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBeUndefined();
      expect(h.host().recover('pm')).toHaveLength(1);
    });

    it('a team switch closes it too, and the person resuming does not reopen it', async () => {
      const h = await unreadable();
      h.host().scope('pm', 'team-switched');
      h.host().scope('pm', 'explicit-resume');
      expect(h.ledger().snapshot()[0].delegations[0].resultHistory?.[0].decisionScopes?.at(-1)?.state).toBe('closed');
    });
  });

  // Audit of the first design (A3): a hand-over a reload cut short has no confirmation, so it ends as partial and is not replayed.
  describe('a hand-over a reload cut short', () => {
    const replyOf = (h: Awaited<ReturnType<typeof setup>>) => h.ledger().observeMessage({ id: 'closing', from: 'pm', to: 'user', type: 'task.complete',
      payload: { instruction: 'done' }, priority: 'normal', correlationId: 'user-task', timestamp: new Date().toISOString() } as never);

    it('a reply may end the task, as partial, and nothing is handed over again', async () => {
      const h = await setup();
      h.dispatch();
      await h.settle();
      await h.host().prepare('pm', 'h', 1);
      await h.host().drain();
      await h.reload();
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBe('delivery-unknown');
      expect(h.host().recover('pm')).toEqual([]);
      expect(h.recoveryReady).not.toHaveBeenCalled();
      replyOf(h);
      expect(h.ledger().snapshot()[0]).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial' });
    });

    it('a reply right after a confirmed hand-over is complete, before the saves behind it have run', async () => {
      const h = await setup();
      h.dispatch();
      await h.settle();
      await h.host().prepare('pm', 'h', 1);
      h.host().delivered('pm', 'h', 'auto-wake', 1);
      h.ledger().recordDeliveryDelivered('h', 'auto-wake');
      // The mark that the hand-over might have been cut short is cleared by queued work that has not run yet.
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBe('delivery-unknown');
      replyOf(h);
      expect(h.ledger().snapshot()[0]).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
      await h.host().drain();
    });

    it('a hand-over confirmed before the reload is complete, and is not repeated', async () => {
      const h = await setup();
      h.dispatch();
      await h.settle();
      await h.host().prepare('pm', 'h', 1);
      h.host().delivered('pm', 'h', 'auto-wake', 1);
      h.ledger().recordDeliveryDelivered('h', 'auto-wake');
      await h.host().drain();
      await h.reload();
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBeUndefined();
      expect(h.host().recover('pm')).toEqual([]);
      replyOf(h);
      expect(h.ledger().snapshot()[0]).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
    });
  });

  describe('the recovery reminder', () => {
    it('a new workspace, whose extension storage folder does not exist yet, saves a result, warns of nothing and restores it after a reload', async () => {
      // Field, 4c06a304: every result of every new workspace logged retained-save-failed and prepared-save-failed.
      const h = await setup({ storageFolder: 'not-created-yet' });
      h.dispatch();
      await h.settle();
      await h.host().prepare('pm', 'h', 1);
      await h.host().drain();
      expect(h.logRecoveryWarning).not.toHaveBeenCalled();
      expect(h.notice).not.toHaveBeenCalled();

      const fresh = await setup({ storageFolder: 'not-created-yet' });
      fresh.dispatch();
      await fresh.settle();
      await fresh.reload();
      expect(fresh.logRecoveryWarning).not.toHaveBeenCalled();
      expect(fresh.recoveryReady).toHaveBeenCalledWith('pm', [expect.objectContaining({ handle: 'h', text: 'worker answer' })]);
    });

    it('a real save failure still tells the person, and the log names its source', async () => {
      const h = await setup();
      h.dispatch();
      const save = vi.spyOn(h.persistence, 'saveResultMailboxEntry').mockResolvedValue(false as never);
      await h.settle();
      save.mockRestore();
      expect(h.logRecoveryWarning).toHaveBeenCalledWith('pm', 'retained-save-failed');
      expect(h.notice).toHaveBeenCalledWith('pm');
      expect(h.notice).toHaveBeenCalledOnce();
    });

    it('each further source is logged, and the person is told only once', async () => {
      const h = await setup();
      h.dispatch();
      const save = vi.spyOn(h.persistence, 'saveResultMailboxEntry').mockResolvedValue(false as never);
      await h.settle();
      await h.host().prepare('pm', 'h', 1);
      await h.host().drain();
      save.mockRestore();
      expect(h.logRecoveryWarning.mock.calls.map((call) => call[1])).toEqual(['retained-save-failed', 'prepared-save-failed']);
      expect(h.notice).toHaveBeenCalledOnce();
    });

    it('a result that stopped being current while its save waited owes no reminder', async () => {
      const h = await setup();
      h.dispatch();
      let release = () => {};
      h.holdLedger(new Promise<void>((resolve) => { release = resolve; }));
      // A save ahead of it in the queue is still running when the result is replaced.
      h.ledger().recordDelegationEvidence({ handle: 'h', agentId: 'dev', outcome: 'no-evidence', evidence: {
        outcome: 'no-evidence', completionState: 'complete', changedFiles: [], hadToolActions: false, unrecordedWrites: false, verification: { ran: false } } });
      void h.host().archiveDecided('pm', 'h');
      h.host().retain('pm', { handle: 'h', ref: 'dev', text: 'answer' });
      h.ledger().beginResultRework('pm', 'h');
      release();
      h.holdLedger(undefined);
      await h.host().drain();
      expect(h.logRecoveryWarning).not.toHaveBeenCalled();
      expect(h.notice).not.toHaveBeenCalled();
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).not.toBe('recovery-data-not-saved');
    });

    it('a failing log never changes what the person is told', async () => {
      const h = await setup();
      h.logRecoveryWarning.mockImplementation(() => { throw new Error('log gone'); });
      h.dispatch();
      const save = vi.spyOn(h.persistence, 'saveResultMailboxEntry').mockResolvedValue(false as never);
      await h.settle();
      save.mockRestore();
      expect(h.notice).toHaveBeenCalledOnce();
    });
  });

  // v0.9.100 field (K2): the state three failed two-agent runs left behind: the run closed "complete" while the
  // second worker's settled result was still waiting to be handed over.
  it('a result that settles during the first wake turn keeps the run open, and its own wake ends it', async () => {
    const h = await setup(); const bus = new MessageBus();
    const handles: string[] = []; const ready: string[] = [];
    const team = new TeamTools('pm', { list: () => ['dev', 'rev'].map(id => ({ id, name: id, role: 'custom', status: 'idle' })),
      resolve: (ref: string) => ({ id: ref }) }, bus, {
      timeoutMs: 60_000, evidenceEnabled: true, cwd: process.cwd(),
      taskInputResolver: new TaskInputResolver(new ContentAssetStore(), process.cwd()),
      onDelegationDispatched: event => {
        handles.push(event.handle);
        h.ledger().recordDelegationDispatched({ ...event, originCorrelationId: 'user-task' });
        h.host().reserve('pm', event.handle);
      },
      onDelegationEvidence: event => h.ledger().recordDelegationEvidence(event),
      onAsyncResultReady: result => { ready.push(result.handle); return true; },
      onAsyncResultRetained: result => { h.host().retain('pm', result); h.ledger().recordDeliveryPending(result.handle); },
      resultRevisionFor: value => h.ledger().resultIdentity('pm', value)?.ref.revision,
      isAsyncResultEligible: (value, revision) => h.host().canDeliver('pm', value, revision),
      prepareAsyncResultDelivery: (value, revision) => h.host().prepare('pm', value, revision),
      onAsyncResultDelivered: (value, via, revision) => {
        h.host().delivered('pm', value, via, revision); h.ledger().recordDeliveryDelivered(value, via);
      },
    });
    const contract = (objective: string) => ({ version: 1, objective, expected_deliverable: 'An answer.',
      effects: { read_files: [], expected_file_effect: 'none' }, inputs: [], constraints: [], dependencies: [],
      required_capabilities: { version: 1, capabilities: [] }, execution_strategy: 'delegate-required' });
    const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
    const reply = (text: string) => h.ledger().observeMessage(bus.send('pm', 'unode', 'task.complete', { instruction: text }, 'normal', 'user-task'));
    try {
      await team.run('dispatch_task', { agent: 'dev', instruction: 'First.', contract: contract('First.') });
      await team.run('dispatch_task', { agent: 'rev', instruction: 'Second.', contract: contract('Second.') });
      const [first, second] = handles;
      expect(second).toBeTruthy();

      // The first result wakes the coordinator.
      bus.send('dev', 'pm', 'task.complete', { instruction: 'The first answer.' }, 'normal', first);
      await tick(); await h.host().drain();
      expect(team.consumeAsyncResult(first)).toBe(true);
      await h.host().drain();

      // The second settles during that turn. The turn's reply was written without it.
      bus.send('rev', 'pm', 'task.complete', { instruction: 'The second answer.' }, 'normal', second);
      await tick(); await h.host().drain();
      expect(ready).toContain(second);
      reply('Accepted the first. The other is still running.');
      expect(h.ledger().snapshot()[0]).toMatchObject({ status: 'open' });
      expect(h.ledger().snapshot()[0].closeoutCompletionState).toBeUndefined();
      expect(h.host().canDeliver('pm', second, h.ledger().resultIdentity('pm', second)?.ref.revision)).toBe(true);
      expect(team.isAsyncResultReady(second)).toBe(true);
      expect(h.ledger().inspectTaskStatus('pm', [second])[0]).toMatchObject({ lifecycle: 'settled', delivery: { state: 'pending' } });

      // Its wake reaches the coordinator, and that reply ends the run.
      expect(team.consumeAsyncResult(second)).toBe(true);
      await h.host().drain();
      expect(h.ledger().inspectTaskStatus('pm', [second])[0]).toMatchObject({ delivery: { state: 'delivered' } });
      reply('Merged both answers.');
      expect(h.ledger().snapshot()[0]).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
      // A normal two-worker run, with everything saved, gives no recovery reminder.
      expect(h.notice).not.toHaveBeenCalled();
      expect(h.logRecoveryWarning).not.toHaveBeenCalled();
    } finally { team.cancelPending('test cleanup'); bus.dispose(); }
  });

  it('the host does not close a resolved run while a settled result waits for its wake', async () => {
    const h = await setup(); const bus = new MessageBus();
    h.dispatch('lost'); h.dispatch('done');
    h.ledger().recordDelegationInterrupted({ coordinatorId: 'pm', handle: 'lost', agentId: 'dev', reason: 'worker-lost', lastObservedAt: new Date().toISOString() });
    await h.settle('done');
    h.ledger().recordDisposition({ handle: 'lost', disposition: 'abandoned', reason: 'not needed', recordedAt: new Date().toISOString() });
    h.ledger().observeMessage(bus.send('pm', 'user', 'task.complete', { instruction: 'Elsewhere.' }, 'normal', 'another-thread'));
    expect(h.ledger().snapshot().find(run => run.delegations.some(row => row.handle === 'done'))).toMatchObject({ status: 'open' });
    bus.dispose();
  });

  it('a reply does not wait for a result the coordinator already decided or the person stopped', async () => {
    const h = await setup();
    const reply = () => h.ledger().observeMessage(new MessageBus().send('pm', 'unode', 'task.complete', { instruction: 'Done.' }, 'normal', 'user-task'));
    h.dispatch('decided'); await h.settle('decided');
    h.ledger().recordDisposition({ handle: 'decided', disposition: 'abandoned', reason: 'not needed', recordedAt: new Date().toISOString() });
    h.dispatch('stopped'); await h.settle('stopped');
    h.host().scope('pm', 'coordinator-stopped');
    reply();
    expect(h.ledger().snapshot()[0]).toMatchObject({ status: 'closed' });
  });

  it.each(['shutdown', 'config-edit', 'user-stop'] as const)('%s preserves the right pending-result delivery scope through reload', async cause => {
    const h = await setup(); h.dispatch(); await h.settle();
    const bus = new MessageBus();
    const turns: string[] = [];
    const manager = new SessionManager(1, bus, { resolveEnv: async () => ({}), createBackend: config => ({
      agentId: config.id, onEvent: () => () => {}, start: async () => {}, stop: async () => {},
      sendUserTurn(instruction: string) { turns.push(instruction); }, isAlive: () => true,
    } as AgentBackend) });
    manager.create({ id: 'pm', name: 'PM', role: 'senior-dev', skill: '', provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' },
      model: 'deepseek-v4.1-flash', systemPrompt: '', autoApprove: true, allowedTools: [] } as AgentConfig);
    manager.on('session.stopped', event => {
      if (event.data?.resultScope === 'suspend') h.host().scope('pm', 'coordinator-stopped');
    });
    try {
      await manager.start('pm', { pin: 'take' });
      if (cause === 'shutdown') await manager.shutdown();
      else if (cause === 'config-edit') {
        manager.get('pm')!.status = 'idle'; // The model route has finished its ready handshake.
        await manager.configEdited('pm', { backendKindChanged: false, executionChanged: false });
      }
      else await manager.stop('pm');
      await h.reload();
      if (cause === 'user-stop') {
        expect(h.host().canDeliver('pm', 'h')).toBe(false); expect(h.recoveryReady).not.toHaveBeenCalled();
      } else {
        expect(h.recoveryReady).toHaveBeenCalledExactlyOnceWith('pm', [expect.objectContaining({ handle: 'h' })]);
        expect(h.host().canDeliver('pm', 'h')).toBe(true);
        await manager.start('pm', { pin: 'take' });
        manager.get('pm')!.status = 'idle'; // Complete the fake model's ready handshake after host startup.
        const result = h.host().recover('pm')[0];
        const offer = () => manager.queueAsyncDelegationWake('pm', result, () => h.host().canDeliver('pm', result.handle),
          () => { if (!h.host().canDeliver('pm', result.handle)) return false; h.host().delivered('pm', result.handle, 'auto-wake'); return true; },
          () => h.host().prepare('pm', result.handle));
        offer();
        await vi.waitFor(() => { expect(turns).toHaveLength(1); expect(turns[0]).toContain('worker answer'); });
        await h.host().drain();
        offer(); await new Promise(resolve => setTimeout(resolve, 0)); expect(turns).toHaveLength(1);
        await h.reload(); expect(h.recoveryReady).toHaveBeenCalledTimes(1);
      }
    } finally { await manager.shutdown(); manager.dispose(); bus.dispose(); }
  });
  it('retries an interrupted archive cleanup on window reload without another owner or journal proof', async () => {
    const h = await setup(); h.dispatch(); await h.settle();
    await h.host().prepare('pm', 'h'); h.host().delivered('pm', 'h', 'collect-ready'); await h.host().drain();
    h.ledger().recordDisposition({ handle: 'h', disposition: 'accepted', recordedAt: new Date().toISOString() });
    const reclaim = vi.spyOn(DelegationResultBodyStore.prototype, 'reclaimArchived').mockRejectedValueOnce(new Error('busy'));
    try {
      h.host().archiveDecided('pm', 'h'); await h.host().drain();
      expect(h.persistence.archivedResultBodies()).toHaveLength(1);
      await h.reload();
      expect(h.persistence.archivedResultBodies()).toHaveLength(0);
      expect(reclaim).toHaveBeenCalledTimes(2);
    } finally { reclaim.mockRestore(); }
  });
  // v0.9.99 (Owner, 2026-10-27): a save that is only slow is not reported. The handoff still waits 500 ms; a save still
  // pending 30 s after its work was created gives one reminder, and a failed one is reported by its own path.
  describe('the recovery-pending reminder', () => {
    async function held() {
      const h = await setup(); h.dispatch(); await h.settle();
      let release!: () => void; h.holdLedger(new Promise<void>(resolve => { release = resolve; }));
      vi.useFakeTimers();
      return { h, release: () => release() };
    }
    const finish = async (h: Awaited<ReturnType<typeof setup>>, release: () => void) => {
      release(); h.holdLedger(undefined); vi.useRealTimers(); await h.host().drain();
    };

    it('does not keep delivery waiting, says nothing at 29,999 ms and once at 30,000 ms', async () => {
      const { h, release } = await held();
      try {
        const preparing = h.host().prepare('pm', 'h', 1);
        await vi.advanceTimersByTimeAsync(500); await preparing;
        expect(h.host().canDeliver('pm', 'h', 1)).toBe(true);
        expect(h.notice).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(29_499);
        expect(h.notice).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(h.notice).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.notice).toHaveBeenCalledTimes(1);
      } finally { await finish(h, release); }
    });

    it.each([600, 29_000])('says nothing for a save that completes at %i ms, and clears its deadline', async (at) => {
      const { h, release } = await held();
      try {
        const preparing = h.host().prepare('pm', 'h', 1);
        await vi.advanceTimersByTimeAsync(at); await preparing;
        release();
        // The rest of the save is real file I/O, which fake time does not advance: wait for the work itself.
        await h.host().drain();
        expect((h.host() as unknown as { recoveryDeadlines: Map<string, unknown> }).recoveryDeadlines.size).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.notice).not.toHaveBeenCalled();
      } finally { await finish(h, release); }
    });

    it('reports a save that fails at 600 ms once, from the failure path, and the deadline adds nothing', async () => {
      const { h, release } = await held();
      try {
        const preparing = h.host().prepare('pm', 'h', 1);
        await vi.advanceTimersByTimeAsync(600); await preparing;
        h.fail(true); release();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.notice).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.notice).toHaveBeenCalledTimes(1);
      } finally { h.fail(false); await finish(h, release); }
    });

    it('says nothing after close(), and a prepare after close() sets no deadline', async () => {
      const { h, release } = await held();
      try {
        const preparing = h.host().prepare('pm', 'h', 1);
        await vi.advanceTimersByTimeAsync(500); await preparing;
        h.host().close();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.notice).not.toHaveBeenCalled();
        expect((h.host() as unknown as { recoveryDeadlines: Map<string, unknown> }).recoveryDeadlines.size).toBe(0);
      } finally { await finish(h, release); }
    });

    it('sets no deadline for a prepare after close()', async () => {
      const h = await setup(); h.dispatch('h'); h.dispatch('h2'); await h.settle('h'); await h.settle('h2');
      let release!: () => void; h.holdLedger(new Promise<void>(resolve => { release = resolve; }));
      vi.useFakeTimers();
      try {
        h.host().close();
        const preparing = h.host().prepare('pm', 'h2', 1);
        expect((h.host() as unknown as { recoveryDeadlines: Map<string, unknown> }).recoveryDeadlines.size).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000); await preparing;
        expect(h.notice).not.toHaveBeenCalled();
      } finally { await finish(h, () => release()); }
    });

    it('keeps one deadline for two prepares of the same result', async () => {
      const { h, release } = await held();
      try {
        const first = h.host().prepare('pm', 'h', 1);
        const second = h.host().prepare('pm', 'h', 1);
        expect((h.host() as unknown as { recoveryDeadlines: Map<string, unknown> }).recoveryDeadlines.size).toBe(1);
        await vi.advanceTimersByTimeAsync(500); await first; await second;
      } finally { await finish(h, release); }
    });
  });
  it('joins a saved marker to an entry by exact identity, not extra body fields or JSON order', async () => {
    const h = await setup(); h.dispatch(); const identity = h.ledger().resultIdentity('pm', 'h')!;
    const bus = new MessageBus();
    try {
      const digest = 'a'.repeat(64); const message = bus.send('unode', 'pm', 'system.heartbeat', {
        metadata: { resultDelivery: identity, sourceDigest: digest } });
      expect(resultDeliveryMarkerMatches(message, { ...identity, state: 'ready' } as typeof identity, digest)).toBe(true);
      expect(resultDeliveryMarkerMatches(message, { ...identity, ref: { handle: 'h', revision: 2 } }, digest)).toBe(false);
      expect(resultDeliveryMarkerMatches({ ...message, from: 'dev' }, identity, digest)).toBe(false);
      expect(resultDeliveryMarkerMatches(message, identity, 'b'.repeat(64))).toBe(false);
    } finally { bus.dispose(); }
  });

  it('two rebuilt tool instances cannot collect the same recovered result, or mistake an old revision for rework', async () => {
    const h = await setup(); h.dispatch(); await h.settle(); await h.reload();
    const bus = new MessageBus();
    try {
      const make = () => new TeamTools('pm', { list: () => [], resolve: () => undefined }, bus, {
        recoveredAsyncResults: h.host().recover('pm'),
        prepareAsyncResultDelivery: (handle, revision) => h.host().prepare('pm', handle, revision),
        isAsyncResultEligible: (handle, revision) => h.host().canDeliver('pm', handle, revision),
        onAsyncResultDelivered: (handle, via, revision) => { h.host().delivered('pm', handle, via, revision); h.ledger().recordDeliveryDelivered(handle, via); },
        resultCloseoutBlockers: () => h.ledger().resultCloseoutBlockers('pm'),
      });
      const first = make(); const stale = make();
      expect(await first.run('collect_ready_tasks', {})).toContain('worker answer');
      expect(await first.run('close_assignment', { outcome: 'complete', summary: 'done' })).toContain('still needs');
      h.ledger().recordDisposition({ handle: 'h', disposition: 'needs-human', reason: 'need a person', recordedAt: new Date().toISOString() });
      expect(h.ledger().inspectTaskStatus('pm', ['h'])[0].result?.state).toBe('awaiting-human');
      expect(await first.run('close_assignment', { outcome: 'complete', summary: 'done' })).toContain('still needs');
      expect(await stale.run('collect_ready_tasks', {})).not.toContain('worker answer');
      await h.host().drain(); await h.host().prepare('pm', 'h', 1);
      expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBeUndefined();
      h.ledger().beginResultRework('pm', 'h'); h.host().reserve('pm', 'h');
      h.host().retain('pm', { handle: 'h', ref: 'dev', text: 'second revision' }); await h.host().drain();
      expect(h.host().canDeliver('pm', 'h', 1)).toBe(false); expect(h.host().canDeliver('pm', 'h', 2)).toBe(true);
      expect(await stale.run('collect_ready_tasks', {})).not.toContain('worker answer');
      expect(h.host().canDeliver('pm', 'h', 2)).toBe(true);
    } finally { bus.dispose(); }
  });


  it('retires only a completely proven legacy source and keeps an ambiguous legacy result unchanged', async () => {
    const h = await setup(); h.dispatch(); await h.settle();
    const old = [{ coordinatorId: 'pm', handle: 'h', ref: 'dev', text: 'worker answer' }];
    await h.persistence.savePendingDelegationResults(old); await h.reload();
    expect(h.persistence.loadPendingDelegationResults()).toEqual([]); expect(h.host().recover('pm')).toHaveLength(1);
    const ambiguous = [{ coordinatorId: 'pm', handle: 'unknown', ref: 'dev', text: 'irreplaceable old answer' }];
    await h.persistence.savePendingDelegationResults(ambiguous); await h.reload();
    expect(h.persistence.loadPendingDelegationResults()).toEqual(ambiguous);
  });
  it('does not hand off a ready result after the coordinator already decided to abandon it', async () => {
    const h = await setup(); h.dispatch(); await h.settle();
    expect(h.host().canDeliver('pm', 'h', 1)).toBe(true);
    h.ledger().recordDisposition({ handle: 'h', disposition: 'abandoned', recordedAt: new Date().toISOString() });
    expect(h.host().canDeliver('pm', 'h', 1)).toBe(false);
    h.host().archiveDecided('pm', 'h'); await h.host().drain();
    expect(h.host().recover('pm')).toEqual([]);
    expect(h.host().canDeliver('pm', 'h', 1)).toBe(false);
    await h.reload(); expect(h.host().recover('pm')).toEqual([]);
    expect(h.host().canDeliver('pm', 'h', 1)).toBe(false);
    expect(h.markers.size).toBe(0); // Closing an undelivered result never invents a delivery acknowledgement.
  });
  it('restores an undelivered body, delivers once, then never reoffers it on a second reload', async () => {
    const h = await setup(); h.dispatch(); await h.settle();
    await h.reload(); expect(h.host().recover('pm')).toEqual([{ handle: 'h', ref: 'dev', text: 'worker answer', resultRevision: 1 }]);
    await h.host().prepare('pm', 'h'); h.host().delivered('pm', 'h', 'collect-ready'); await h.host().drain();
    expect(h.markers.size).toBe(1); await h.reload(); expect(h.host().recover('pm')).toEqual([]);
    expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBeUndefined();
  });
  it('crash between persisted handoff intent and observed delivery is unknown, not automatically replayed', async () => {
    const h = await setup(); h.dispatch(); await h.settle(); await h.host().prepare('pm', 'h');
    await h.reload(); expect(h.host().recover('pm')).toEqual([]); expect(h.markers.size).toBe(0);
    expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBe('delivery-unknown');
  });
  it('keeps a delivered result queryable for a decision; needs-rework gets a different preallocated completion', async () => {
    const h = await setup(); h.dispatch(); const first = h.ledger().resultIdentity('pm', 'h')!; await h.settle();
    await h.host().prepare('pm', 'h'); h.host().delivered('pm', 'h', 'auto-wake'); await h.host().drain();
    h.ledger().recordDisposition({ handle: 'h', disposition: 'needs-rework', reason: 'fix the output', recordedAt: new Date().toISOString() });
    h.ledger().beginResultRework('pm', 'h'); h.host().reserve('pm', 'h');
    const second = h.ledger().resultIdentity('pm', 'h')!;
    expect(second.ref.revision).toBe(2); expect(second.settledEventId).not.toBe(first.settledEventId);
    h.host().retain('pm', { handle: 'h', ref: 'dev', text: 'revised answer' }); await h.host().drain();
    await h.reload(); expect(h.host().recover('pm')[0].text).toBe('revised answer');
    expect(h.ledger().snapshot()[0].delegations[0].resultHistory).toHaveLength(2);
  });
  it('does not run a stale completion after Stop/removal, or resurrect its scope on a replacement start', async () => {
    const h = await setup(); h.dispatch(); await h.settle(); h.host().scope('pm', 'coordinator-stopped');
    expect(h.host().recover('pm')).toEqual([]); h.host().delivered('pm', 'h', 'auto-wake'); await h.host().drain(); expect(h.markers.size).toBe(0);
    await h.reload(); expect(h.host().canDeliver('pm', 'h', 1)).toBe(false);
    h.host().scope('pm', 'explicit-resume'); expect(h.host().recover('pm')).toHaveLength(1);
    expect(h.host().canDeliver('pm', 'h', 1)).toBe(true);
    h.host().scope('pm', 'coordinator-removed'); h.host().scope('pm', 'explicit-resume');
    await h.reload(); expect(h.host().recover('pm')).toEqual([]);
  });
  it('retains live work and gives one reminder when storage fails; does not revive the old whole-array writer', async () => {
    const h = await setup(); h.dispatch(); h.fail(true); await h.settle();
    expect(h.host().recover('pm')[0].text).toBe('worker answer'); await h.host().prepare('pm', 'h');
    expect(h.notice).toHaveBeenCalledTimes(1); expect(h.data.has('roam.pendingDelegationResults')).toBe(false);
  });
  it('uses original ledger identities and never imports a body for a different coordinator', async () => {
    const h = await setup(); h.dispatch(); await h.settle(); expect(h.host().recover('other')).toEqual([]);
    h.stale(); h.host().delivered('pm', 'h', 'auto-wake'); await h.host().drain(); expect(h.markers.size).toBe(0);
  });
});

describe('ready-host fixture waits for real recovery initialization', () => {
  it('keeps its ready promise pending after the nonblocking open budget expires', async () => {
    for (let iteration = 0; iteration < 25; iteration++) {
      let release!: () => void; let entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const realOpen = DelegationResultBodyStore.open;
      const open = vi.spyOn(DelegationResultBodyStore, 'open').mockImplementation(async options => {
        entered(); await held; return realOpen.call(DelegationResultBodyStore, options);
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const ready = vi.fn();
      const pending = setup().then(h => { ready(); return h; });
      try {
        await started;
        await vi.advanceTimersByTimeAsync(500);
        expect(ready).not.toHaveBeenCalled();
        release();
        const h = await pending;
        h.dispatch(); await h.settle();
        expect(h.notice).not.toHaveBeenCalled();
      } finally {
        release();
        const h = await pending;
        await h.host().drain(); h.host().close();
        vi.useRealTimers(); open.mockRestore();
      }
    }
  }, 30_000);
});

// v0.9.101 S4.1: activation's open() returns after 500 ms; a result that settles before the store is ready is held in
// memory and saved when it opens, not reported as lost.
describe('a result that settles before its store is ready', () => {
  /** A reload whose store opens only when released, after open() has already returned at its 500 ms budget. */
  async function slowStore(h: Awaited<ReturnType<typeof setup>>) {
    let release!: () => void; let entered!: () => void; let fails = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const realOpen = DelegationResultBodyStore.open;
    const open = vi.spyOn(DelegationResultBodyStore, 'open').mockImplementation(async options => {
      entered(); await held; if (fails) throw new Error('storage gone'); return realOpen.call(DelegationResultBodyStore, options);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const reloading = h.reloadUntilOpenReturns();
      await started;
      await vi.advanceTimersByTimeAsync(500);
      await reloading; // open() has returned; the store is still opening.
    } finally { vi.useRealTimers(); }
    const saves = vi.spyOn(h.persistence, 'saveResultMailboxEntry');
    const opened = async () => { release(); await h.host().drain(); open.mockRestore(); };
    return { opened, failOpen: () => { fails = true; }, saves };
  }
  const savedRevisions = (saves: { mock: { calls: unknown[][] } }) =>
    saves.mock.calls.map(([entry]) => (entry as { ref: { handle: string; revision: number } }).ref);

  it('is saved once when the store opens, recoverable after a reload, and nothing reports it lost', async () => {
    const h = await setup();
    const store = await slowStore(h);
    h.dispatch('late'); await h.settleNow('late', 'late answer');
    expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBeUndefined();
    expect(h.logRecoveryWarning).not.toHaveBeenCalled();
    expect(store.saves).not.toHaveBeenCalled();
    await store.opened();
    expect(savedRevisions(store.saves)).toEqual([{ handle: 'late', revision: 1 }]);
    expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBeUndefined();
    expect(h.logRecoveryWarning).not.toHaveBeenCalled();
    expect(h.notice).not.toHaveBeenCalled();
    await h.reload();
    expect(h.recoveryReady).toHaveBeenCalledWith('pm', [expect.objectContaining({ handle: 'late', text: 'late answer' })]);
    expect(h.host().recover('pm').map(result => result.text)).toEqual(['late answer']);
    expect(h.notice).not.toHaveBeenCalled();
  });

  it('is reported as not saved, once, when the store fails to open', async () => {
    const h = await setup();
    const store = await slowStore(h);
    h.dispatch('late'); await h.settleNow('late', 'late answer');
    expect(h.notice).not.toHaveBeenCalled();
    store.failOpen(); await store.opened();
    expect(store.saves).not.toHaveBeenCalled();
    expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBe('recovery-data-not-saved');
    expect(h.logRecoveryWarning.mock.calls).toEqual([['pm', 'retained-save-failed']]);
    expect(h.notice).toHaveBeenCalledOnce();
  });

  it('is not saved after the host closes, and the close reports it once', async () => {
    const h = await setup();
    const store = await slowStore(h);
    h.dispatch('late'); await h.settleNow('late', 'late answer');
    h.host().close();
    expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBe('recovery-data-not-saved');
    await store.opened();
    expect(store.saves).not.toHaveBeenCalled();
    expect(h.logRecoveryWarning.mock.calls).toEqual([['pm', 'retained-save-failed']]);
    expect(h.notice).toHaveBeenCalledOnce();
  });

  it('a later revision replaces the earlier one: only it is saved, and the handed-over first one is not offered again', async () => {
    const h = await setup();
    const store = await slowStore(h);
    h.dispatch('late'); await h.settleNow('late', 'first answer');
    await h.host().prepare('pm', 'late', 1); h.host().delivered('pm', 'late', 'auto-wake', 1); h.ledger().recordDeliveryDelivered('late', 'auto-wake');
    await h.queued();
    h.ledger().recordDisposition({ handle: 'late', disposition: 'needs-rework', reason: 'fix the output', recordedAt: new Date().toISOString() });
    h.ledger().beginResultRework('pm', 'late'); h.host().reserve('pm', 'late');
    await h.settleNow('late', 'revised answer');
    await store.opened();
    expect(savedRevisions(store.saves)).toEqual([{ handle: 'late', revision: 2 }]);
    expect(h.notice).not.toHaveBeenCalled();
    await h.reload();
    expect(h.host().recover('pm')).toEqual([expect.objectContaining({ handle: 'late', text: 'revised answer', resultRevision: 2 })]);
    expect(h.markers.size).toBe(1);
  });

  it('handed over while the store opened, it is saved as delivered and never delivered again', async () => {
    const h = await setup();
    const store = await slowStore(h);
    h.dispatch('late'); await h.settleNow('late', 'late answer');
    await h.host().prepare('pm', 'late', 1); h.host().delivered('pm', 'late', 'auto-wake', 1); h.ledger().recordDeliveryDelivered('late', 'auto-wake');
    await h.queued();
    expect(h.notice).not.toHaveBeenCalled();
    await store.opened();
    expect(savedRevisions(store.saves)).toEqual([{ handle: 'late', revision: 1 }]);
    await h.reload();
    expect(h.recoveryReady).not.toHaveBeenCalled();
    expect(h.host().recover('pm')).toEqual([]);
    expect(h.markers.size).toBe(1);
    expect(h.logRecoveryWarning).not.toHaveBeenCalled();
  });

  it('a handoff begun while the store opened and cut short by a reload is unknown, not replayed', async () => {
    const h = await setup();
    const store = await slowStore(h);
    h.dispatch('late'); await h.settleNow('late', 'late answer');
    await h.host().prepare('pm', 'late', 1);
    expect(h.notice).not.toHaveBeenCalled();
    await store.opened();
    expect(store.saves.mock.calls.map(([entry]) => (entry as { deliveryAttempted?: boolean }).deliveryAttempted)).toEqual([true]);
    await h.reload();
    expect(h.host().recover('pm')).toEqual([]);
    expect(h.markers.size).toBe(0);
    expect(h.ledger().snapshot()[0].delegations[0].resultRecovery).toBe('delivery-unknown');
  });
});
