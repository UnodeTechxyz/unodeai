import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ workspace: { workspaceFolders: [] } }));

import { PersistenceManager } from '../PersistenceManager';
import { RunLedger, type RunRecord } from '../../observability/RunLedger';
import { maintainRunOwnershipTick } from '../../observability/RunOwnershipMaintenance';

/**
 * v0.9.100 (audit of 254ccc8b, A3): the mark that a run owes one more turn goes through what every run goes through:
 * real shards, real `loadRuns`, real leases. Every instant here is scripted; nothing waits.
 */
const T0 = '2030-01-01T00:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const A = { hostInstanceId: 'window-a', epoch: 'epoch-a' };
const B = { hostInstanceId: 'window-b', epoch: 'epoch-b' };

function workspace() {
  const values = new Map<string, unknown>();
  const memento = {
    get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback),
    update: async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, structuredClone(value)); },
    keys: () => [...values.keys()],
  };
  const manager = (host: { hostInstanceId: string; epoch: string }) =>
    new PersistenceManager({ workspaceState: memento } as never, undefined, () => '/workspace', host);
  return { manager };
}

/** A coordinator's run whose work is done, with the host decided on one more turn, and the reply that came before it. */
function decided(host = A) {
  const ledger = new RunLedger([], { host, activeTurnId: () => undefined });
  ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'w1', agentId: 'dev', requestedAgent: 'dev', instruction: 'x',
    attemptId: 'attempt', originCorrelationId: 'thread', dispatchedAt: T0 });
  ledger.recordDelegationEvidence({ handle: 'w1', agentId: 'dev', outcome: 'no-evidence', evidence: {
    outcome: 'no-evidence', changedFiles: [], hadToolActions: false, unrecordedWrites: false, verification: { ran: false } } });
  ledger.recordDeliveryDelivered('w1', 'blocking-tool');
  return ledger;
}
const reply = (ledger: RunLedger, metadata: Record<string, unknown>, timestamp: string) => ledger.observeMessage({
  id: `reply-${timestamp}`, from: 'pm', to: 'user', type: 'task.complete', priority: 'normal', correlationId: 'thread', timestamp,
  payload: { instruction: 'done', metadata },
} as never);

describe('a continuation across shards', () => {
  it('an older copy of the run does not lose the mark, in either shard order', async () => {
    const ledger = decided();
    const older = structuredClone(ledger.snapshot());
    ledger.beginContinuation('pm', 'thread', at(1));
    reply(ledger, { continuesInTurn: true, turnId: 'first' }, at(2));
    const newer = ledger.snapshot();
    for (const [first, second] of [[older, newer], [newer, older]] as const) {
      const w = workspace();
      await w.manager(A).saveRuns(first as RunRecord[]);
      await w.manager(B).saveRuns(second as RunRecord[]);
      const [run] = await w.manager({ hostInstanceId: 'window-c', epoch: 'epoch-c' }).loadRuns(at(3)) as RunRecord[];
      expect(run.continuationPending).toMatchObject({ at: at(1), reply: { type: 'task.complete', turnId: 'first' } });
      expect(run.continuationPending?.endedAt).toBeUndefined();
    }
  });

  it('a copy from before the reply does not lose the reply, in either shard order', async () => {
    const ledger = decided();
    ledger.beginContinuation('pm', 'thread', at(1));
    const before = structuredClone(ledger.snapshot());
    reply(ledger, { continuesInTurn: true, turnId: 'first' }, at(2));
    const after = ledger.snapshot();
    for (const [first, second] of [[before, after], [after, before]] as const) {
      const w = workspace();
      await w.manager(A).saveRuns(first as RunRecord[]);
      await w.manager(B).saveRuns(second as RunRecord[]);
      const [run] = await w.manager({ hostInstanceId: 'window-c', epoch: 'epoch-c' }).loadRuns(at(3)) as RunRecord[];
      expect(run.continuationPending?.reply).toMatchObject({ type: 'task.complete', turnId: 'first' });
    }
  });

  it('a continuation that ended is not brought back by an older copy, in either shard order', async () => {
    const ledger = decided();
    ledger.beginContinuation('pm', 'thread', at(1));
    reply(ledger, { continuesInTurn: true, turnId: 'first' }, at(2));
    // A worker went out during the continuation, so its reply leaves the run open.
    ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'w2', agentId: 'dev', requestedAgent: 'dev', instruction: 'y',
      attemptId: 'attempt-2', originCorrelationId: 'thread', dispatchedAt: at(3) });
    const owing = structuredClone(ledger.snapshot());
    reply(ledger, { turnId: 'second' }, at(4));
    const ended = ledger.snapshot();
    expect(ended[0]).toMatchObject({ status: 'open', continuationPending: { endedAt: at(4) } });
    for (const [first, second] of [[owing, ended], [ended, owing]] as const) {
      const w = workspace();
      await w.manager(A).saveRuns(first as RunRecord[]);
      await w.manager(B).saveRuns(second as RunRecord[]);
      const restored = new RunLedger(await w.manager({ hostInstanceId: 'window-c', epoch: 'epoch-c' }).loadRuns(at(5)), { host: { hostInstanceId: 'window-c', epoch: 'epoch-c' } });
      expect(restored.hasOwedContinuations()).toBe(false);
      restored.reconcileRestoredContinuations(at(60));
      expect(restored.snapshot()[0].status).toBe('open');
    }
  });

  it('a later continuation replaces an earlier one', async () => {
    const ledger = decided();
    ledger.beginContinuation('pm', 'thread', at(1));
    const earlier = structuredClone(ledger.snapshot());
    ledger.abandonContinuation('pm', 'thread', at(2));
    ledger.beginContinuation('pm', 'thread', at(3));
    const w = workspace();
    await w.manager(A).saveRuns(earlier);
    await w.manager(B).saveRuns(ledger.snapshot());
    const [run] = await w.manager({ hostInstanceId: 'window-c', epoch: 'epoch-c' }).loadRuns(at(4)) as RunRecord[];
    expect(run.continuationPending).toMatchObject({ at: at(3) });
    expect(run.continuationPending?.endedAt).toBeUndefined();
  });

  it('a run a copy closed drops the mark', async () => {
    const ledger = decided();
    const owing = decided();
    owing.beginContinuation('pm', 'thread', at(1));
    reply(ledger, { turnId: 'closing' }, at(5));
    expect(ledger.snapshot()[0].status).toBe('closed');
    const w = workspace();
    await w.manager(A).saveRuns(owing.snapshot().map((run) => ({ ...run, id: ledger.snapshot()[0].id })));
    await w.manager(B).saveRuns(ledger.snapshot());
    const [run] = await w.manager({ hostInstanceId: 'window-c', epoch: 'epoch-c' }).loadRuns(at(6)) as RunRecord[];
    expect(run.status).toBe('closed');
    expect(run.continuationPending).toBeUndefined();
  });

  it('the same window reloading: read through loadRuns, the run ends as partial', async () => {
    const ledger = decided();
    ledger.beginContinuation('pm', 'thread', at(1));
    reply(ledger, { continuesInTurn: true, turnId: 'first' }, at(2));
    const w = workspace();
    await w.manager(A).saveRuns(ledger.snapshot());
    const reloaded = { hostInstanceId: A.hostInstanceId, epoch: 'epoch-a-2' };
    const restored = new RunLedger(await w.manager(reloaded).loadRuns(at(3)), { host: reloaded });
    expect(restored.reconcileRestoredContinuations(at(3))).toBe(1);
    expect(restored.snapshot()[0]).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial', closingTurnId: 'first' });
  });
});

describe('a continuation and its lease', () => {
  const tick = (ledger: RunLedger, manager: PersistenceManager, seconds: number, previous: number) =>
    maintainRunOwnershipTick(ledger, (observed) => manager.loadRuns(observed), { previousTickAtMs: Date.parse(at(previous)) }, at(seconds));

  it('a living window\'s heartbeat keeps it, past the time the first heartbeat alone would last', async () => {
    const w = workspace();
    const owner = decided();
    const ownerStore = w.manager(A);
    owner.beginContinuation('pm', 'thread', at(1));
    // Maintenance does not treat a run owing a continuation as idle.
    const first = await tick(owner, ownerStore, 40, 35);
    expect(first.skipped).toBeUndefined();
    expect(owner.snapshot()[0].continuationPending?.owner?.heartbeatAt).toBe(at(40));
    await ownerStore.saveRuns(owner.snapshot());

    const observer = new RunLedger(await w.manager(B).loadRuns(at(41)), { host: B });
    expect(observer.reconcileRestoredContinuations(at(41))).toBe(0);
    expect(observer.snapshot()[0].status).toBe('open');
    expect(observer.hasOwedContinuations()).toBe(true);
    // The observer's own tick leaves it alone as well.
    await tick(observer, w.manager(B), 42, 37);
    expect(observer.snapshot()[0].status).toBe('open');
  });

  it('a window that really is gone: when its lease runs out, another window\'s maintenance ends it', async () => {
    const w = workspace();
    const owner = decided();
    owner.beginContinuation('pm', 'thread', at(1));
    reply(owner, { continuesInTurn: true, turnId: 'first' }, at(2));
    await w.manager(A).saveRuns(owner.snapshot());
    const observerStore = w.manager(B);
    const observer = new RunLedger(await observerStore.loadRuns(at(3)), { host: B });
    await tick(observer, observerStore, 10, 5);
    expect(observer.snapshot()[0].status).toBe('open');
    await tick(observer, observerStore, 40, 35);
    expect(observer.snapshot()[0]).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial', closingTurnId: 'first' });
    expect(observer.hasOwedContinuations()).toBe(false);
  });

  it('an observer that stalled and closed it does not close it for the window still running it', async () => {
    const owner = decided();
    owner.beginContinuation('pm', 'thread', at(1));
    reply(owner, { continuesInTurn: true, turnId: 'first' }, at(2));
    const stalled = new RunLedger(owner.snapshot(), { host: B });
    stalled.reconcileRestoredContinuations(at(40));
    expect(stalled.snapshot()[0].status).toBe('closed');
    owner.snapshotForPersistence(stalled.snapshot());
    expect(owner.snapshot()[0].status).toBe('open');
    expect(owner.hasOwedContinuations()).toBe(true);
  });

  it('the same holds for a run this window took over after a reload, whose workers an older epoch owned', async () => {
    const reloaded = { hostInstanceId: A.hostInstanceId, epoch: 'epoch-a-2' };
    const owner = new RunLedger(decided().snapshot(), { host: reloaded });
    owner.beginContinuation('pm', 'thread', at(1));
    reply(owner, { continuesInTurn: true, turnId: 'first' }, at(2));
    const stalled = new RunLedger(owner.snapshot(), { host: B });
    stalled.reconcileRestoredContinuations(at(40));
    expect(stalled.snapshot()[0].status).toBe('closed');
    owner.snapshotForPersistence(stalled.snapshot());
    expect(owner.snapshot()[0].status).toBe('open');
    expect(owner.hasOwedContinuations()).toBe(true);
  });

  it('no mark, no reason to look: an ended one lets maintenance go idle', async () => {
    const w = workspace();
    const ledger = decided();
    ledger.beginContinuation('pm', 'thread', at(1));
    ledger.abandonContinuation('pm', 'thread', at(2));
    const load = vi.fn(async () => []);
    const result = await maintainRunOwnershipTick(ledger, load, { previousTickAtMs: Date.parse(at(5)) }, at(10));
    expect(result.skipped).toBe('idle');
    expect(load).not.toHaveBeenCalled();
    void w;
  });
});
