import { describe, expect, it } from 'vitest';
import { RunLedger } from '../RunLedger';

// v0.9.99: what a coordinator's previous turn dispatched, for the team state of its next turn.
describe('RunLedger.dispatchOutcomesBetween', () => {
  const FROM = '2026-10-27T08:00:00.000Z';
  const TO = '2026-10-27T08:05:00.000Z';

  it('counts the accepted dispatches and lists the refusals inside the span, and nothing outside it', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'before', requestedAgent: 'dev', agentId: 'dev', instruction: 'a',
      originCorrelationId: 'turn-0', dispatchedAt: '2026-10-27T07:59:59.999Z',
    });
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'inside-1', requestedAgent: 'dev', agentId: 'dev', instruction: 'b',
      originCorrelationId: 'turn-1', dispatchedAt: FROM,
    });
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'inside-2', requestedAgent: 'qa', agentId: 'qa', instruction: 'c',
      originCorrelationId: 'turn-1', dispatchedAt: '2026-10-27T08:01:00.000Z',
    });
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'at-end', requestedAgent: 'dev', agentId: 'dev', instruction: 'd',
      originCorrelationId: 'turn-2', dispatchedAt: TO,
    });
    ledger.recordDelegationDispatched({
      coordinatorId: 'other-pm', handle: 'foreign', requestedAgent: 'dev', agentId: 'dev', instruction: 'e',
      originCorrelationId: 'turn-x', dispatchedAt: '2026-10-27T08:02:00.000Z',
    });
    ledger.recordRefusedDispatch({
      coordinatorId: 'pm', requestedAgent: 'designer', reason: 'No teammate named designer.',
      originCorrelationId: 'turn-1', recordedAt: '2026-10-27T08:02:00.000Z',
    });

    expect(ledger.dispatchOutcomesBetween('pm', FROM, TO, 'turn-1')).toEqual({
      accepted: 2,
      refused: [{ requestedAgent: 'designer', reason: 'No teammate named designer.' }],
    });
  });

  it('includes a refusal recorded before any run opened, under the named turn only', () => {
    const ledger = new RunLedger();
    ledger.recordRefusedDispatch({
      coordinatorId: 'pm', requestedAgent: 'ghost', reason: 'No teammate named ghost.',
      originCorrelationId: 'turn-1', recordedAt: '2026-10-27T08:01:00.000Z',
    });
    ledger.recordRefusedDispatch({
      coordinatorId: 'pm', requestedAgent: 'elsewhere', reason: 'Another turn.',
      originCorrelationId: 'turn-9', recordedAt: '2026-10-27T08:01:30.000Z',
    });
    expect(ledger.dispatchOutcomesBetween('pm', FROM, TO, 'turn-1')).toEqual({
      accepted: 0,
      refused: [{ requestedAgent: 'ghost', reason: 'No teammate named ghost.' }],
    });
    expect(ledger.dispatchOutcomesBetween('pm', FROM, TO)).toEqual({ accepted: 0, refused: [] });
  });
});
