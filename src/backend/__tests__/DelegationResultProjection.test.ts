import { describe, expect, it } from 'vitest';
import { mergeStandingResults, parseStandingResult, projectDelegationCloseout, projectDelegationResult,
  type StandingResult, type DelegationProjectionInput } from '../DelegationResultProjection';
import { RunLedger } from '../../observability/RunLedger';
import { buildPortableRunEvidence } from '../../observability/PortableRunEvidence';

const at = '2026-10-24T00:00:00.000Z';
const result = (handle = 'B', revision = 1): StandingResult => ({ ref: { handle, revision },
  attemptId: `attempt-${handle}-${revision}`, settledEventId: `event-${handle}-${revision}`, state: 'ready', delivery: 'pending' });
const input = (standing = result()): DelegationProjectionInput => ({ handle: standing.ref.handle, lifecycle: 'settled',
  execution: 'ended', wait: 'not-waiting', standing, historical: false, bodyAvailable: true });

describe('T2 shared result projection', () => {
  it.each(['unlisted-disposition', '__proto__', 'constructor', 'toString'])('defensively blocks an unchecked future consumer disposition %s (audit MN1)', value => {
    // Normal readers already reject this. Pin the projection's own fallback before T2b adds direct callers.
    const untrusted = { ...result(), decision: { value, recordedAt: at } };
    expect(parseStandingResult(untrusted)).toBeUndefined();
    const current = input(untrusted as unknown as StandingResult);
    expect(projectDelegationResult(current)).toMatchObject({ state: 'unknown', nextAction: 'inspect', blocksComplete: true });
    const accepted = input({ ...result('A'), decision: { value: 'accepted', recordedAt: at } });
    expect(projectDelegationCloseout([accepted, current]).blockers).toMatchObject([{ handle: 'B', state: 'unknown' }]);
  });
  it.each([
    ['accepted', 'decided', 'none', false], ['rejected', 'decided', 'none', false],
    ['needs-rework', 'awaiting-rework', 'rework', true], ['needs-human', 'awaiting-human', 'ask-human', true],
    ['deferred', 'decided', 'none', false], ['accepted-with-caveat', 'decided', 'none', false],
    ['accepted-after-rework', 'decided', 'none', false], ['accepted-despite-framework-no-evidence', 'decided', 'none', false],
    ['superseded', 'decided', 'none', false], ['abandoned', 'decided', 'none', false],
  ] as const)('projects %s as %s without confusing a recorded decision with finished obligations', (value, state, nextAction, blocksComplete) => {
    const current = input({ ...result(), delivery: 'delivered', decision: { value, recordedAt: at } });
    expect(projectDelegationResult(current)).toMatchObject({ state, nextAction, blocksComplete, decision: { value } });
    expect(projectDelegationCloseout([current]).blockers).toHaveLength(blocksComplete ? 1 : 0);
  });
  it('keeps rework blocking before dispatch, while running, and on the new undecided result', () => {
    const prior = { ...result(), delivery: 'delivered' as const, decision: { value: 'needs-rework' as const, recordedAt: at } };
    const next = result('B', 2);
    const stages = [input(prior), { ...input(prior), reworkRunning: { revision: 2, attemptId: 'attempt-B-2' } },
      input(next), input({ ...next, delivery: 'delivered' as const }),
      input({ ...next, decision: { value: 'accepted-after-rework' as const, recordedAt: at } })];
    expect(stages.map(stage => projectDelegationResult(stage).blocksComplete)).toEqual([true, true, true, true, false]);
    expect(projectDelegationCloseout([input({ ...result('A'), decision: { value: 'accepted', recordedAt: at } }), stages[0]])
      .blockers).toMatchObject([{ handle: 'B', state: 'awaiting-rework' }]);
  });
  it('does not let the same agent’s old rejected A obscure ready B or running B', () => {
    const a = input({ ...result('A'), delivery: 'delivered', decision: { value: 'rejected', reason: 'old', recordedAt: at } });
    const b = input();
    expect(projectDelegationCloseout([a, b]).blockers).toMatchObject([{ handle: 'B', state: 'ready', nextAction: 'collect' }]);
    expect(projectDelegationCloseout([a, { ...b, execution: 'running' }]).blockers).toMatchObject([{ handle: 'B', state: 'running', nextAction: 'wait' }]);
  });
  it('elapsed wait is neither cancellation nor resumable stop, and a late final is ready', () => {
    const waiting: DelegationProjectionInput = { handle: 'B', lifecycle: 'active', execution: 'running', wait: 'elapsed', historical: false };
    expect(projectDelegationResult(waiting)).toMatchObject({ state: 'running', nextAction: 'wait', wait: 'elapsed' });
    expect(projectDelegationResult({ ...input(), wait: 'elapsed' })).toMatchObject({ state: 'ready', nextAction: 'collect' });
  });
  it('delivered remains pending a decision; typed failure and stop-unconfirmed are not success', () => {
    expect(projectDelegationResult(input({ ...result(), delivery: 'delivered' }))).toMatchObject({ state: 'awaiting-decision', nextAction: 'decide', blocksComplete: true });
    expect(projectDelegationResult(input({ ...result(), state: 'failed' }))).toMatchObject({ state: 'failed', blocksComplete: true });
    expect(projectDelegationResult({ ...input(), execution: 'stop-unconfirmed' })).toMatchObject({ state: 'stop-unconfirmed', blocksComplete: true });
  });
  it('rework revision 2 never displays revision 1’s decision or delivery as current', () => {
    const old = { ...result('B'), delivery: 'delivered' as const, decision: { value: 'needs-rework' as const, recordedAt: at } };
    const projected = projectDelegationResult({ ...input(old), reworkRunning: { revision: 2, attemptId: 'attempt-B-2' } });
    expect(projected).toMatchObject({ ref: { handle: 'B', revision: 2 }, state: 'running', blocksComplete: true });
    expect(projected).not.toHaveProperty('decision'); expect(projected).not.toHaveProperty('delivery');
  });
  it('two ready results coexist, even when one arrives while another is running', () => {
    expect(projectDelegationCloseout([input(result('A')), input(result('B'))]).blockers).toHaveLength(2);
    expect(projectDelegationCloseout([{ ...input(result('A')), execution: 'running' }, input(result('B'))]).blockers.map(row => row.state)).toEqual(['running', 'ready']);
  });
  it('scope closure/suspension is not an accepted disposition and missing bodies stay unknown', () => {
    for (const state of ['closed', 'suspended'] as const) {
      const projected = projectDelegationResult(input({ ...result(), decisionScopes: [{ state,
        cause: state === 'closed' ? 'team-switched' : 'coordinator-stopped', by: 'host-lifecycle', recordedAt: at }] }));
      expect(projected.blocksComplete).toBe(false); expect(projected).not.toHaveProperty('decision');
      expect(projected.state).toBe(state === 'closed' ? 'historical' : 'stopped');
    }
    expect(projectDelegationResult({ ...input(), bodyAvailable: false })).toMatchObject({ state: 'unknown', nextAction: 'inspect', blocksComplete: true });
  });
  it('merges exact duplicate facts idempotently, and same-revision identity/decision conflicts are sticky', () => {
    const a = result();
    expect(mergeStandingResults([a], [a])).toEqual([a]);
    const b = { ...a, settledEventId: 'different-event' };
    const conflict = mergeStandingResults([a], [b]);
    expect(conflict[0].conflict).toBe(true);
    expect(mergeStandingResults([b], [a])).toEqual(conflict);
    expect(mergeStandingResults(conflict, [a])[0].conflict).toBe(true);
    expect(projectDelegationResult(input(conflict[0]))).toMatchObject({ state: 'unknown', blocksComplete: true });
    const accepted = { ...a, decision: { value: 'accepted' as const, recordedAt: at } };
    const rejected = { ...a, decision: { value: 'rejected' as const, recordedAt: at } };
    expect(mergeStandingResults([accepted], [rejected])[0].conflict).toBe(true);
  });
  it('a conflict flag survives merging an exact copy of its own base, not just another contradictory identity (M3)', () => {
    const base = result(); const flagged = { ...base, conflict: true as const };
    for (const [left, right] of [[[flagged], [base]], [[base], [flagged]]]) {
      const merged = mergeStandingResults(left, right);
      expect(merged).toEqual([flagged]);
      expect(projectDelegationResult(input(merged[0]))).toMatchObject({ state: 'unknown', blocksComplete: true });
    }
    // Delivery may legitimately advance without resolving an earlier completion-identity conflict.
    // Its lexically preferred copy must not hide the sticky flag held by the pending copy.
    const delivered = { ...base, delivery: 'delivered' as const };
    for (const [left, right] of [[[flagged], [delivered]], [[delivered], [flagged]]]) {
      expect(mergeStandingResults(left, right)).toEqual([{ ...flagged, delivery: 'delivered' }]);
    }
    const stored = storedLedger(); stored.delegations[0].resultHistory = [flagged];
    const external = structuredClone(stored); external.delegations[0].resultHistory = [base];
    const merged = new RunLedger([stored]).snapshotForPersistence([external]);
    expect(new RunLedger(merged).snapshot()[0].delegations[0].resultHistory).toEqual([flagged]);
  });
  it('parses a closed schema rather than retaining injected bodies or invalid identities', () => {
    expect(parseStandingResult({ ...result(), body: 'private-body' })).not.toHaveProperty('body');
    for (const revision of [0, -1, 1.5, NaN]) expect(parseStandingResult({ ...result(), ref: { handle: 'B', revision } })).toBeUndefined();
    expect(parseStandingResult({ ...result(), decision: { value: 'invented', recordedAt: at } })).toBeUndefined();
  });
});

function storedLedger() {
  const ledger = new RunLedger();
  ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'B', requestedAgent: 'worker', agentId: 'worker', instruction: 'work' });
  const record = ledger.snapshot()[0];
  record.delegations[0].state = 'settled'; record.delegations[0].settledAt = at;
  return record;
}

describe('T2 schema 11 result history persistence', () => {
  it.each(['malformed', 'another-handle'] as const)('does not silently discard %s rows or fabricate a result on a later reload (M10/M11)', cause => {
    const stored = storedLedger();
    stored.delegations[0].resultHistory = [result(), cause === 'malformed'
      ? { ...result('B', 2), settledEventId: '' } : result('OTHER')];
    let records = new RunLedger([stored]).snapshot();
    for (let reload = 0; reload < 2; reload++) {
      const delegation = records[0].delegations[0];
      expect(delegation.resultRecovery).toBe('decision-scope-unknown');
      expect(delegation.resultHistory).toBeUndefined(); expect(delegation.currentResultRevision).toBeUndefined();
      expect(projectDelegationResult({ ...input(), standing: undefined, recovery: delegation.resultRecovery }))
        .toMatchObject({ state: 'unknown', blocksComplete: true });
      records = new RunLedger(records).snapshot();
    }
  });
  it.each([10, 11] as const)('redacts decision reasons in schema %i result history, including old-record migration', schemaVersion => {
    const stored = storedLedger(); stored.schemaVersion = schemaVersion;
    const reason = 'token=private-result-canary; password=private-password-canary';
    if (schemaVersion === 11) stored.delegations[0].resultHistory = [{ ...result(), decision: { value: 'rejected', reason, recordedAt: at } }];
    else stored.delegations[0].dispositions = [{ handle: 'B', agentId: 'worker', disposition: 'rejected', reason, recordedAt: at, outcome: 'replied-not-verified' }];
    const restored = new RunLedger([stored]).snapshot();
    expect(restored[0].delegations[0].resultHistory![0].decision!.reason).toContain('[redacted]');
    expect(JSON.stringify(restored)).not.toContain('private-result-canary');
    expect(JSON.stringify(restored)).not.toContain('private-password-canary');
    expect(JSON.stringify(new RunLedger(restored).snapshot())).not.toContain('private-result-canary');
  });
  it('round-trips revisions and rejects raw body fields through ledger normalization', () => {
    const stored = storedLedger();
    stored.delegations[0].resultHistory = [result('B', 1), { ...result('B', 2), body: 'private-body' } as StandingResult];
    const ledger = new RunLedger([stored]);
    const restored = ledger.snapshot()[0];
    expect(restored.schemaVersion).toBe(11);
    expect(restored.delegations[0]).toMatchObject({ currentResultRevision: 2, resultHistory: [result('B', 1), result('B', 2)] });
    expect(JSON.stringify(restored)).not.toContain('private-body');
    const portable = JSON.stringify(buildPortableRunEvidence(restored));
    expect(portable).not.toContain('settledEventId'); expect(portable).not.toContain('attempt-B-2');
  });
  it('migrates a simple schema 10 result without fabricating a recoverable body', () => {
    const stored = storedLedger(); stored.schemaVersion = 10;
    stored.delegations[0].delivery = { state: 'delivered', observedAt: at, via: 'auto-wake' };
    const restored = new RunLedger([stored]).snapshot()[0].delegations[0];
    expect(restored).toMatchObject({ currentResultRevision: 1, resultRecovery: 'body-unavailable', resultHistory: [{ legacy: true, delivery: 'delivered' }] });
    stored.delegations[0].dispositions.push({ handle: 'B', agentId: 'worker', disposition: 'needs-rework', recordedAt: at, outcome: 'replied-not-verified' });
    const ambiguous = new RunLedger([stored]).snapshot()[0].delegations[0];
    expect(ambiguous.resultRecovery).toBe('decision-scope-unknown');
    expect(ambiguous.resultHistory).toBeUndefined();
  });
  it('merge keeps a higher legitimate revision and marks conflicting copies, not newest timestamp wins', () => {
    const left = storedLedger(); left.delegations[0].resultHistory = [result('B', 1)];
    const right = structuredClone(left); right.delegations[0].resultHistory = [result('B', 2)];
    const ledger = new RunLedger([left]);
    const merged = ledger.snapshotForPersistence([right])[0].delegations[0];
    expect(merged.currentResultRevision).toBe(2); expect(merged.resultHistory).toHaveLength(2);
    right.delegations[0].resultHistory = [{ ...result('B', 2), attemptId: 'conflicting-attempt' }];
    const conflicted = ledger.snapshotForPersistence([right])[0].delegations[0].resultHistory!.find(row => row.ref.revision === 2)!;
    expect(conflicted.conflict).toBe(true);
  });
});
