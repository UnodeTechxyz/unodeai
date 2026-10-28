import { describe, expect, it, vi } from 'vitest';
import { RunLedger } from '../RunLedger';
import { maintainRunOwnershipTick } from '../RunOwnershipMaintenance';

describe('run ownership maintenance', () => {
  it('renews the existing lease while a settled result still needs delivery or a decision', async () => {
    const owner = new RunLedger([], { host: { hostInstanceId: 'window-a', epoch: 'epoch-a' } });
    owner.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'ready', requestedAgent: 'dev', agentId: 'dev',
      instruction: 'work', dispatchedAt: '2026-10-25T00:00:00.000Z' });
    const identity = owner.resultIdentity('pm', 'ready')!;
    owner.recordResultSettlement(identity, 'ready');
    expect(owner.hasActiveDelegations()).toBe(false); expect(owner.hasOpenResultScopes()).toBe(true);
    const load = vi.fn(async () => owner.snapshot());
    await maintainRunOwnershipTick(owner, load, { previousTickAtMs: Date.parse('2026-10-25T00:00:00.000Z') }, '2026-10-25T00:00:05.000Z');
    expect(load).toHaveBeenCalledOnce(); expect(owner.snapshot()[0].delegations[0].owner?.heartbeatAt).toBe('2026-10-25T00:00:05.000Z');
    const observer = new RunLedger(owner.snapshot(), { host: { hostInstanceId: 'window-b', epoch: 'epoch-b' } });
    expect(observer.adoptSettledResultOwner('pm', 'ready', '2026-10-25T00:00:06.000Z')).toBe(false);
    expect(observer.adoptSettledResultOwner('pm', 'ready', '2026-10-25T00:00:36.000Z')).toBe(true);
    expect(observer.snapshot()[0].delegations[0]).toMatchObject({ state: 'settled', owner: { hostInstanceId: 'window-b', epoch: 'epoch-b' } });
  });

  it('does not read persisted shards on an idle tick', async () => {
    const ledger = new RunLedger([], {
      host: { hostInstanceId: 'window-b', epoch: 'epoch-b' },
    });
    const loadRuns = vi.fn(async () => []);

    const result = await maintainRunOwnershipTick(
      ledger,
      loadRuns,
      { previousTickAtMs: Date.parse('2026-09-11T14:00:00.000Z') },
      '2026-09-11T14:00:05.000Z',
    );

    expect(result).toEqual({ skipped: 'idle', interruptions: [], decisions: [] });
    expect(loadRuns).not.toHaveBeenCalled();
  });

  it('keeps a fresh foreign owner active and interrupts it on the first tick at lease expiry', async () => {
    const owner = new RunLedger([], {
      host: { hostInstanceId: 'window-a', epoch: 'epoch-a' }, ownerLeaseMs: 30_000,
    });
    owner.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'foreign-live', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Keep working.', originCorrelationId: 'root-foreign',
      dispatchedAt: '2026-09-11T14:00:00.000Z',
    });
    const persisted = owner.snapshot();
    const observer = new RunLedger(persisted, {
      host: { hostInstanceId: 'window-b', epoch: 'epoch-b' }, ownerLeaseMs: 30_000,
    });
    const loadRuns = vi.fn(async () => persisted);
    const state = { previousTickAtMs: Date.parse('2026-09-11T14:00:00.000Z') };

    const freshTick = await maintainRunOwnershipTick(observer, loadRuns, state, '2026-09-11T14:00:29.999Z');
    expect(freshTick.interruptions)
      .toEqual([]);
    expect(freshTick.decisions).toEqual([
      expect.objectContaining({ handle: 'foreign-live', branch: 'foreign-owner-lease-active', action: 'keep-active' }),
    ]);
    expect(observer.snapshot()[0].delegations[0].state).toBe('active');
    const expiredTick = await maintainRunOwnershipTick(observer, loadRuns, state, '2026-09-11T14:00:30.000Z');
    expect(expiredTick.interruptions)
      .toEqual([expect.objectContaining({ handle: 'foreign-live', reason: 'host-restarted' })]);
    expect(expiredTick.decisions).toEqual([
      expect.objectContaining({ handle: 'foreign-live', branch: 'foreign-owner-lease-expired', action: 'interrupt' }),
    ]);
    expect(observer.snapshot()[0].delegations[0].state).toBe('interrupted');
  });

  it('skips foreign judgment after a host stall while renewing this host own rows', async () => {
    const ledger = new RunLedger([], {
      host: { hostInstanceId: 'window-a', epoch: 'epoch-a' }, ownerLeaseMs: 30_000,
    });
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'owned-live', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Keep working.', originCorrelationId: 'root-owned',
      dispatchedAt: '2026-09-11T14:00:00.000Z',
    });
    const loadRuns = vi.fn(async () => []);

    const result = await maintainRunOwnershipTick(
      ledger,
      loadRuns,
      { previousTickAtMs: Date.parse('2026-09-11T14:00:00.000Z') },
      '2026-09-11T14:00:35.001Z',
    );

    expect(result).toEqual({ skipped: 'host-stall', interruptions: [], decisions: [] });
    expect(loadRuns).not.toHaveBeenCalled();
    expect(ledger.snapshot()[0].delegations[0].owner?.heartbeatAt).toBe('2026-09-11T14:00:35.001Z');
  });
});
