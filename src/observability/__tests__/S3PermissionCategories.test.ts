import { describe, expect, it } from 'vitest';
import { RunLedger } from '../RunLedger';
import { buildPortableRunEvidence } from '../PortableRunEvidence';
import { projectJobOutcome, APPROVAL_KIND_LABEL } from '../JobOutcome';
import { parseRequestCloseoutRecord } from '../RequestCloseout';
import { RequestCloseoutAccumulator } from '../../session/RequestCloseoutAccumulator';

describe('S3 permission categories in existing stores and projections', () => {
  it('keeps the new categories on restart and exports only bounded decisions, without private labels or actor ids', () => {
    const ledger = new RunLedger();
    const runId = ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'subject', requestedAgent: 'dev', agentId: 'dev', instruction: 'Public task' });
    for (const kind of ['outward-action', 'security-setting'] as const) {
      for (const decision of ['allowed', 'denied', 'expired'] as const) ledger.recordPermission({ agentId: 'dev', correlationId: 'subject',
        kind, decision, label: 'PRIVATE-COMMAND-OR-PATH', approverId: decision === 'expired' ? undefined : 'PRIVATE-ACTOR' });
    }
    const run = new RunLedger(ledger.snapshot()).get(runId)!;
    expect(run.permissions).toHaveLength(6);
    expect(run.permissions.map(event => event.kind)).toEqual(['outward-action', 'outward-action', 'outward-action', 'security-setting', 'security-setting', 'security-setting']);
    const portable = buildPortableRunEvidence(run);
    expect(portable.permissions.map(event => event.kind)).toEqual(run.permissions.map(event => event.kind));
    expect(JSON.stringify(portable)).not.toMatch(/PRIVATE-(COMMAND-OR-PATH|ACTOR)/);
    const badSnapshot = ledger.snapshot(); badSnapshot[0].permissions.push({ ...badSnapshot[0].permissions[0], kind: 'invented-category' } as never);
    expect(new RunLedger(badSnapshot).get(runId)!.permissions).toHaveLength(6);
  });

  it('includes both exact floors in the existing Job outcome approval totals and labels', () => {
    const ledger = new RunLedger();
    const runId = ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'subject', requestedAgent: 'dev', agentId: 'dev', instruction: 'Public task' });
    ledger.recordPermission({ agentId: 'dev', correlationId: 'subject', kind: 'outward-action', decision: 'allowed' });
    ledger.recordPermission({ agentId: 'dev', correlationId: 'subject', kind: 'security-setting', decision: 'denied' });
    ledger.recordPermission({ agentId: 'dev', correlationId: 'subject', kind: 'security-setting', decision: 'expired' });
    ledger.recordDelegationEvidence({ handle: 'subject', agentId: 'dev', outcome: 'tool-activity-recorded', evidence: {
      outcome: 'tool-activity-recorded', changedFiles: [], hadToolActions: true,
      verification: { ran: false, passed: false }, unrecordedWrites: false,
    } });
    ledger.observeMessage({ id: 'closed', correlationId: runId, from: 'pm', to: 'user', type: 'task.complete', priority: 'normal', timestamp: '2026-10-29T01:00:00.000Z', payload: { instruction: 'Public reply' } });
    const outcome = projectJobOutcome(runId, ledger.get(runId), () => undefined);
    expect(outcome).toMatchObject({ state: 'available', approvals: { total: 3, allowed: 1, denied: 1, expired: 1,
      byKind: [{ kind: 'outward-action', allowed: 1, denied: 0, expired: 0 }, { kind: 'security-setting', allowed: 0, denied: 1, expired: 1 }] } });
    expect(APPROVAL_KIND_LABEL['outward-action']).toBe('Outward actions');
    expect(APPROVAL_KIND_LABEL['security-setting']).toBe('Security-setting changes');
  });

  it('retains exact-floor counts through the real request accumulator and closed parser, without changing other kinds', () => {
    const accumulator = new RequestCloseoutAccumulator({ requestId: 'request', rootAgentId: 'dev', originTurnId: 'turn', terminalTurnId: 'turn' });
    accumulator.approval('command-approval', 'allowed'); accumulator.approval('outward-action', 'allowed');
    accumulator.approval('security-setting', 'denied'); accumulator.approval('security-setting', 'expired');
    const record = accumulator.finish({ terminal: { kind: 'answered' }, recordedAt: '2026-10-29T01:00:00.000Z', eventsCut: false });
    expect(record?.observations.approvals.decisions).toEqual([
      { kind: 'command-approval', allowed: 1, denied: 0, expired: 0 }, { kind: 'outward-action', allowed: 1, denied: 0, expired: 0 },
      { kind: 'security-setting', allowed: 0, denied: 1, expired: 1 },
    ]);
    expect(parseRequestCloseoutRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
    const bad = structuredClone(record)!; bad.observations.approvals.decisions[0].kind = 'invented-category' as never;
    expect(parseRequestCloseoutRecord(bad)).toBeUndefined();
  });
});
