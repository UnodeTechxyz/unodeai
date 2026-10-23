import { describe, expect, it } from 'vitest';
import { RunLedger } from '../RunLedger';

/* v0.9.89 field fix: an interrupted delegation that still needs the coordinator's decision is listed once per
 * handle for a Chat notice; a user Stop (cancelled) and resolved interruptions are not. */

const host = { hostInstanceId: 'window-1', epoch: 'activation-1' };
const at = (minute: number) => `2026-09-27T10:${String(minute).padStart(2, '0')}:00.000Z`;
const dispatch = (ledger: RunLedger, handle: string, origin: string, minute: number, extra: Record<string, unknown> = {}) =>
  ledger.recordDelegationDispatched({
    coordinatorId: 'pm', handle, requestedAgent: 'dev', agentId: 'dev', instruction: `Task ${handle}`,
    originCorrelationId: origin, dispatchedAt: at(minute), ...extra,
  });

describe('RunLedger unresolved interruptions', () => {
  it('lists an interrupted delegation until it is replaced or abandoned, and never a stopped one', () => {
    const ledger = new RunLedger([], { host });
    dispatch(ledger, 'h-lost', 'origin-a', 0);
    dispatch(ledger, 'h-stopped', 'origin-a', 0);
    ledger.recordDelegationInterrupted({ coordinatorId: 'pm', handle: 'h-lost', agentId: 'dev', reason: 'worker-lost', lastObservedAt: at(1), detectedAt: at(1) });
    ledger.recordDelegationCancelled({ coordinatorId: 'pm', handle: 'h-stopped', agentId: 'dev', reason: 'Stopped by user.', cancelledAt: at(1) });
    expect(ledger.unresolvedInterruptions()).toEqual([
      { handle: 'h-lost', coordinatorId: 'pm', agentId: 'dev', requestedAgent: 'dev', reason: 'worker-lost' },
    ]);
    dispatch(ledger, 'h-new', 'origin-b', 2, { replacesHandle: 'h-lost', replacementReason: 'The worker was lost.' });
    expect(ledger.unresolvedInterruptions()).toEqual([]);
  });
});
