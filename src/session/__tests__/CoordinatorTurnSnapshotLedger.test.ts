import { describe, expect, it } from 'vitest';
import { RunLedger } from '../../observability/RunLedger';
import { coordinatorTaskNeedsAttention, renderCoordinatorTurnSnapshot } from '../CoordinatorTurnSnapshot';

// Codex's audit of 4efdab9b, I1: the team state took the ledger's newest 50 rows and only then picked the running and
// undecided ones. Newer finished tasks could push an older live task out, and the block read "none recorded" with
// nothing marked as left out. The records are now selected by need first, across every retained record.
describe('the team state read from the real ledger', () => {
  const evidence = {
    outcome: 'tool-activity-recorded' as const, changedFiles: [], hadToolActions: true,
    verification: { ran: false, passed: false }, unrecordedWrites: false,
  };

  function ledgerWithOwedWorkBehindFinishedWork(finished = 50): RunLedger {
    const ledger = new RunLedger();
    const dispatch = (handle: string, at: string) => ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle, requestedAgent: 'dev', agentId: 'dev', instruction: 'Work.',
      originCorrelationId: 'turn-1', dispatchedAt: at,
    });
    dispatch('h-live', '2026-10-27T07:00:00.000Z');
    dispatch('h-undecided', '2026-10-27T07:00:01.000Z');
    ledger.recordDelegationEvidence({ handle: 'h-undecided', agentId: 'dev', outcome: 'tool-activity-recorded', evidence });
    for (let i = 0; i < finished; i++) {
      const handle = `h-cancelled-${i}`;
      dispatch(handle, `2026-10-27T07:${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`);
      ledger.recordDelegationCancelled({ coordinatorId: 'pm', handle, agentId: 'dev', reason: 'Not needed.', cancelledAt: '2026-10-27T07:30:00.000Z' });
    }
    return ledger;
  }

  const render = (ledger: RunLedger) => renderCoordinatorTurnSnapshot({
    asOf: new Date('2026-10-27T08:00:00.000Z'), requestId: 'req', turnId: 'turn-2', inputs: [], roster: [],
    tasks: ledger.inspectTaskStatusWhere('pm', coordinatorTaskNeedsAttention),
  });

  it('shows an older running task and an older undecided result behind 50 newer finished ones', () => {
    const ledger = ledgerWithOwedWorkBehindFinishedWork();
    // The trap: the newest-50 window holds only the finished tasks.
    expect(ledger.inspectTaskStatus('pm').map((row) => row.handle)).not.toContain('h-live');
    const text = render(ledger);
    expect(text).toContain('Running (1):\n- h-live · dev · dispatched 1h 0m ago');
    expect(text).toMatch(/Results waiting for your decision \(1\):\n- h-undecided · dev/);
    expect(text).not.toContain('none recorded');
    expect(text).not.toContain('h-cancelled');
  });

  it('returns exactly the rows the selection keeps, newest first, from every retained record', () => {
    const ledger = ledgerWithOwedWorkBehindFinishedWork();
    expect(ledger.inspectTaskStatusWhere('pm', coordinatorTaskNeedsAttention).map((row) => row.handle)).toEqual(['h-undecided', 'h-live']);
    expect(ledger.inspectTaskStatusWhere('pm', () => true)).toHaveLength(52);
    expect(ledger.inspectTaskStatusWhere('other-pm', () => true)).toEqual([]);
  });

  it('counts owed work the block has no room for, instead of dropping it unseen', () => {
    const ledger = new RunLedger();
    for (let i = 0; i < 400; i++) {
      ledger.recordDelegationDispatched({
        coordinatorId: 'pm', handle: `h-run-${String(i).padStart(3, '0')}`, requestedAgent: 'dev', agentId: 'dev',
        instruction: 'Work.', originCorrelationId: 'turn-1', dispatchedAt: '2026-10-27T07:59:00.000Z',
      });
    }
    const text = render(ledger);
    const shown = text.split('\n').filter((line) => line.startsWith('- h-run-')).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(400);
    expect(text).toContain(`Running (400):`);
    expect(text).toContain(`Not shown: ${400 - shown} running tasks.`);
  });
});
