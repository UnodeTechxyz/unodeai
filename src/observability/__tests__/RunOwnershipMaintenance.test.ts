import { describe, expect, it, vi } from 'vitest';
import { RunLedger } from '../RunLedger';
import { maintainRunOwnershipTick } from '../RunOwnershipMaintenance';

describe('run ownership maintenance', () => {
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
