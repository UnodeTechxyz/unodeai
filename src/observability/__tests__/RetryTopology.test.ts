import { describe, expect, it } from 'vitest';
import { parseRetryLink } from '../../backend/TaskContract';
import { projectRetryTopology, rejectedRetryLinks, type RetryTopologyAttempt } from '../RetryTopology';
import { RunLedger, type StoredRunRecord } from '../RunLedger';
import { buildPortableRunEvidence, PORTABLE_SCHEMA_FIELDS } from '../PortableRunEvidence';
import { deriveRunMechanicalAccounting, renderRunEvidencePack } from '../RunEvidencePack';

const at = (second: number): string => `2026-10-04T10:00:${String(second).padStart(2, '0')}.000Z`;
const attempt = (handle: string, second: number, link: Partial<RetryTopologyAttempt> = {}): RetryTopologyAttempt =>
  ({ handle, dispatchedAt: at(second), ...link });

describe('retry link pair', () => {
  it('is both fields or neither', () => {
    expect(parseRetryLink({})).toEqual({ state: 'absent' });
    expect(parseRetryLink(undefined)).toEqual({ state: 'absent' });
    expect(parseRetryLink({ retryOfHandle: 'h-1', retryStage: 'firm-retry' }))
      .toEqual({ state: 'valid', link: { retryOfHandle: 'h-1', retryStage: 'firm-retry' } });
    expect(parseRetryLink({ retryOfHandle: 'h-1' })).toEqual({ state: 'rejected', gap: 'half-pair' });
    expect(parseRetryLink({ retryStage: 'fallback-model' })).toEqual({ state: 'rejected', gap: 'half-pair' });
  });

  it('rejects a stage outside the vocabulary and a handle that is not an id', () => {
    expect(parseRetryLink({ retryOfHandle: 'h-1', retryStage: 'replacement' })).toEqual({ state: 'rejected', gap: 'invalid-shape' });
    expect(parseRetryLink({ retryOfHandle: 'has space', retryStage: 'firm-retry' })).toEqual({ state: 'rejected', gap: 'invalid-shape' });
    expect(parseRetryLink({ retryOfHandle: 7, retryStage: 'firm-retry' })).toEqual({ state: 'rejected', gap: 'invalid-shape' });
  });
});

describe('run-level retry rules', () => {
  it('accepts a chain whose every parent is an earlier attempt of the run', () => {
    const attempts = [
      attempt('a', 1),
      attempt('b', 2, { retryOfHandle: 'a', retryStage: 'firm-retry' }),
      attempt('c', 3, { retryOfHandle: 'b', retryStage: 'fallback-model' }),
    ];
    expect(rejectedRetryLinks(attempts).size).toBe(0);
    expect(projectRetryTopology(attempts)).toEqual({
      tasks: [{ rootHandle: 'a', attempts: ['a', 'b', 'c'], stages: ['firm-retry', 'fallback-model'] }],
      attempts: 3,
      retryChains: 1,
      gaps: [],
    });
  });

  it('rejects a self-link, a missing parent and a parent dispatched later', () => {
    const rejected = rejectedRetryLinks([
      attempt('self', 1, { retryOfHandle: 'self', retryStage: 'firm-retry' }),
      attempt('orphan', 2, { retryOfHandle: 'nowhere', retryStage: 'firm-retry' }),
      attempt('early', 3, { retryOfHandle: 'late', retryStage: 'firm-retry' }),
      attempt('late', 4),
    ]);
    expect(Object.fromEntries(rejected)).toEqual({ self: 'self-link', orphan: 'missing-parent', early: 'not-earlier' });
  });

  it('rejects every link of a cycle, whatever the dispatch times say', () => {
    const attempts = [
      attempt('x', 5, { retryOfHandle: 'y', retryStage: 'firm-retry' }),
      attempt('y', 5, { retryOfHandle: 'x', retryStage: 'firm-retry' }),
    ];
    expect(Object.fromEntries(rejectedRetryLinks(attempts))).toEqual({ x: 'cycle', y: 'cycle' });
    const topology = projectRetryTopology(attempts);
    expect(topology.retryChains).toBe(0);
    expect(topology.tasks.map((task) => task.attempts)).toEqual([['x'], ['y']]);
    expect(topology.gaps).toEqual([{ handle: 'x', gap: 'cycle' }, { handle: 'y', gap: 'cycle' }]);
    // With different times the time rule alone would reject one link and keep the other as a chain.
    const staggered = [
      attempt('x', 5, { retryOfHandle: 'y', retryStage: 'firm-retry' }),
      attempt('y', 6, { retryOfHandle: 'x', retryStage: 'firm-retry' }),
      attempt('tail', 7, { retryOfHandle: 'y', retryStage: 'fallback-model' }),
    ];
    // The attempt that only leads into the cycle is not on it: its own link stands.
    expect(Object.fromEntries(rejectedRetryLinks(staggered))).toEqual({ x: 'cycle', y: 'cycle' });
    expect(projectRetryTopology(staggered).tasks.map((task) => task.attempts)).toEqual([['x'], ['y', 'tail']]);
  });

  it('rejects a link between attempts dispatched at the same instant: no order between them was recorded', () => {
    // Spelling would put the fallback before the firm retry, and the firm retry would then be read as the last attempt.
    const sameInstant = [
      attempt('root', 5),
      attempt('z-firm', 5, { retryOfHandle: 'root', retryStage: 'firm-retry' }),
      attempt('a-fallback', 5, { retryOfHandle: 'z-firm', retryStage: 'fallback-model' }),
    ];
    expect(Object.fromEntries(rejectedRetryLinks(sameInstant))).toEqual({ 'z-firm': 'not-earlier', 'a-fallback': 'not-earlier' });
    const topology = projectRetryTopology(sameInstant);
    expect(topology.retryChains).toBe(0);
    expect(topology.tasks.every((task) => task.attempts.length === 1)).toBe(true);
    expect(topology.gaps).toEqual([{ handle: 'z-firm', gap: 'not-earlier' }, { handle: 'a-fallback', gap: 'not-earlier' }]);
    // The same handles in a recorded order: one task, and its last attempt is the fallback.
    const ordered = [
      attempt('root', 5),
      attempt('z-firm', 6, { retryOfHandle: 'root', retryStage: 'firm-retry' }),
      attempt('a-fallback', 7, { retryOfHandle: 'z-firm', retryStage: 'fallback-model' }),
    ];
    expect(projectRetryTopology(ordered).tasks).toEqual([
      { rootHandle: 'root', attempts: ['root', 'z-firm', 'a-fallback'], stages: ['firm-retry', 'fallback-model'] },
    ]);
  });

  it('groups nothing for attempts without links: two same-agent dispatches seconds apart are two tasks', () => {
    const topology = projectRetryTopology([attempt('first', 1), attempt('second', 2)]);
    expect(topology).toMatchObject({ attempts: 2, retryChains: 0, gaps: [] });
    expect(topology.tasks).toHaveLength(2);
  });

  it('groups nothing through half a pair: a handle without a stage names no retry', () => {
    const topology = projectRetryTopology([attempt('a', 1), attempt('b', 2, { retryOfHandle: 'a' })]);
    expect(topology.retryChains).toBe(0);
    expect(topology.tasks.map((task) => task.attempts)).toEqual([['a'], ['b']]);
  });

  it('keeps an attempt whose link was already rejected as a task of its own, with the gap', () => {
    const topology = projectRetryTopology([attempt('a', 1), attempt('b', 2, { retryLinkGap: 'half-pair' })]);
    expect(topology.tasks).toHaveLength(2);
    expect(topology.gaps).toEqual([{ handle: 'b', gap: 'half-pair' }]);
  });
});

function dispatch(ledger: RunLedger, handle: string, second: number, extra: Record<string, unknown> = {}, origin = 'origin-1'): string {
  return ledger.recordDelegationDispatched({
    coordinatorId: 'pm', handle, requestedAgent: 'dev', agentId: 'dev', instruction: 'Build it.',
    originCorrelationId: origin, dispatchedAt: at(second), ...extra,
  });
}

describe('RunLedger retry links', () => {
  it('keeps a valid link through dispatch, restore and export', () => {
    const ledger = new RunLedger();
    dispatch(ledger, 'h-1', 1);
    dispatch(ledger, 'h-2', 2, { retryOfHandle: 'h-1', retryStage: 'firm-retry' });
    const [run] = new RunLedger(ledger.snapshot()).snapshot();
    expect(run.delegations[1]).toMatchObject({ retryOfHandle: 'h-1', retryStage: 'firm-retry' });
    expect(run.delegations[1].retryLinkGap).toBeUndefined();
    expect(deriveRunMechanicalAccounting(run)).toMatchObject({ dispatched: 2, logicalTasks: 1, retryChains: 1, retryLinkGaps: 0 });
    expect(renderRunEvidencePack(run)).toContain('Host retry (firm-retry) of attempt `h-1`');
    const portable = buildPortableRunEvidence(run);
    expect(portable.delegations[1]).toMatchObject({ retryOfHandle: 'h-1', retryStage: 'firm-retry' });
    expect(portable.delegations[0].retryOfHandle).toBeUndefined();
    expect(PORTABLE_SCHEMA_FIELDS.delegation).toEqual(expect.arrayContaining(['retryOfHandle', 'retryStage']));
    expect(portable.omitted.unavailable.map((entry) => entry.field)).not.toContain('delegation.retryLink');
  });

  it('drops a half-pair, a self-link and a missing parent at dispatch and says why', () => {
    const ledger = new RunLedger();
    dispatch(ledger, 'h-1', 1);
    dispatch(ledger, 'half', 2, { retryOfHandle: 'h-1' });
    dispatch(ledger, 'self', 3, { retryOfHandle: 'self', retryStage: 'firm-retry' });
    dispatch(ledger, 'orphan', 4, { retryOfHandle: 'never-dispatched', retryStage: 'fallback-model' });
    const [run] = ledger.snapshot();
    expect(run.delegations.map((delegation) => [delegation.handle, delegation.retryOfHandle, delegation.retryLinkGap])).toEqual([
      ['h-1', undefined, undefined],
      ['half', undefined, 'half-pair'],
      ['self', undefined, 'self-link'],
      ['orphan', undefined, 'missing-parent'],
    ]);
    expect(deriveRunMechanicalAccounting(run)).toMatchObject({ logicalTasks: 4, retryChains: 0, retryLinkGaps: 3 });
    const portable = buildPortableRunEvidence(run);
    expect(portable.delegations.every((delegation) => delegation.retryOfHandle === undefined)).toBe(true);
    expect(portable.omitted.unavailable.map((entry) => entry.field)).toContain('delegation.retryLink');
  });

  it('records a host retry in the run of the attempt it retries, whatever turn the coordinator is in', () => {
    const ledger = new RunLedger();
    const runA = dispatch(ledger, 'run-a-1', 1, {}, 'origin-a');
    // The retry is dispatched when the first result arrives: the coordinator is on another request by then.
    const retryRun = dispatch(ledger, 'run-a-2', 2, { retryOfHandle: 'run-a-1', retryStage: 'firm-retry' }, 'origin-b');
    expect(retryRun).toBe(runA);
    expect(ledger.snapshot()).toHaveLength(1);
    expect(ledger.get(runA)!.delegations[1]).toMatchObject({ handle: 'run-a-2', retryOfHandle: 'run-a-1', retryStage: 'firm-retry' });
  });

  it('does not let a malformed retry field choose the run: the dispatch stays in its own request', () => {
    const ledger = new RunLedger();
    const runA = dispatch(ledger, 'run-a-1', 1, {}, 'origin-a');
    const runB = dispatch(ledger, 'run-b-1', 2, {}, 'origin-b');
    expect(runB).not.toBe(runA);
    // Both runs are open. Each field below names run A's attempt and is not a valid link.
    expect(dispatch(ledger, 'half', 3, { retryOfHandle: 'run-a-1' }, 'origin-b')).toBe(runB);
    expect(dispatch(ledger, 'odd-stage', 4, { retryOfHandle: 'run-a-1', retryStage: 'replacement' }, 'origin-b')).toBe(runB);
    expect(ledger.get(runA)!.delegations.map((delegation) => delegation.handle)).toEqual(['run-a-1']);
    expect(ledger.get(runB)!.delegations.map((delegation) => [delegation.handle, delegation.retryOfHandle, delegation.retryLinkGap])).toEqual([
      ['run-b-1', undefined, undefined],
      ['half', undefined, 'half-pair'],
      ['odd-stage', undefined, 'invalid-shape'],
    ]);
    // A well-formed link to the same attempt still joins run A.
    expect(dispatch(ledger, 'run-a-2', 5, { retryOfHandle: 'run-a-1', retryStage: 'firm-retry' }, 'origin-b')).toBe(runA);
  });

  it('does not let a link its parent\'s run refuses choose the run: a retry at its parent\'s instant stays in its own request', () => {
    const ledger = new RunLedger();
    const runA = dispatch(ledger, 'run-a-1', 5, {}, 'origin-a');
    const runB = dispatch(ledger, 'run-b-1', 6, {}, 'origin-b');
    // Both runs are open. Each link is a well-formed pair that names run A's attempt, and run A refuses it.
    const link = { retryOfHandle: 'run-a-1', retryStage: 'firm-retry' };
    expect(dispatch(ledger, 'same-instant', 5, link, 'origin-b')).toBe(runB);
    expect(dispatch(ledger, 'before-parent', 4, link, 'origin-b')).toBe(runB);
    expect(ledger.get(runA)!.delegations.map((delegation) => delegation.handle)).toEqual(['run-a-1']);
    expect(ledger.get(runB)!.delegations.map((delegation) => [delegation.handle, delegation.retryOfHandle, delegation.retryLinkGap])).toEqual([
      ['run-b-1', undefined, undefined],
      ['same-instant', undefined, 'not-earlier'],
      ['before-parent', undefined, 'not-earlier'],
    ]);
    // A request that has no run yet opens its own; it does not join run A either.
    const runC = dispatch(ledger, 'new-request', 5, link, 'origin-c');
    expect(runC).not.toBe(runA);
    expect(runC).not.toBe(runB);
    expect(ledger.get(runC)!.delegations.map((delegation) => [delegation.handle, delegation.retryLinkGap])).toEqual([['new-request', 'not-earlier']]);
    expect(ledger.get(runA)!.delegations).toHaveLength(1);
    // Within one run the refused link changes nothing about where the dispatch is recorded.
    expect(dispatch(ledger, 'same-run-same-instant', 5, link, 'origin-a')).toBe(runA);
    expect(ledger.get(runA)!.delegations[1]).toMatchObject({ handle: 'same-run-same-instant', retryLinkGap: 'not-earlier' });
    expect(ledger.get(runA)!.delegations[1].retryOfHandle).toBeUndefined();
  });

  it('refuses a link to an attempt of another run', () => {
    const ledger = new RunLedger();
    const runA = dispatch(ledger, 'run-a-1', 1, {}, 'origin-a');
    // The parent's run has closed, so the retry cannot join it and is recorded where its own turn puts it.
    ledger.recordDelegationCancelled({ coordinatorId: 'pm', handle: 'run-a-1', agentId: 'dev', reason: 'stopped', cancelledAt: at(2) });
    ledger.observeMessage({
      id: 'close-a', correlationId: 'origin-a', from: 'pm', to: 'user', type: 'task.complete', priority: 'normal',
      payload: { instruction: 'Done.' }, timestamp: at(3),
    });
    expect(ledger.get(runA)!.status).toBe('closed');
    dispatch(ledger, 'run-b-1', 4, { retryOfHandle: 'run-a-1', retryStage: 'firm-retry' }, 'origin-b');
    const runB = ledger.snapshot().find((run) => run.delegations.some((delegation) => delegation.handle === 'run-b-1'))!;
    expect(runB.id).not.toBe(runA);
    expect(runB.delegations[0]).toMatchObject({ retryLinkGap: 'cross-run' });
    expect(runB.delegations[0].retryOfHandle).toBeUndefined();
  });

  it('does not let a stored link become valid when its parent is in no run, and never re-accepts a rejected link', () => {
    const ledger = new RunLedger();
    dispatch(ledger, 'h-1', 1);
    dispatch(ledger, 'h-2', 2, { retryOfHandle: 'h-1', retryStage: 'firm-retry' });
    const stored = ledger.snapshot() as StoredRunRecord[];
    const tampered = structuredClone(stored);
    tampered[0].delegations[1].retryOfHandle = 'h-9';
    expect(new RunLedger(tampered).snapshot()[0].delegations[1]).toMatchObject({ retryLinkGap: 'missing-parent' });
    const halved = structuredClone(stored);
    delete halved[0].delegations[1].retryStage;
    expect(new RunLedger(halved).snapshot()[0].delegations[1]).toMatchObject({ retryLinkGap: 'half-pair' });
    const rejectedOnce = structuredClone(stored);
    rejectedOnce[0].delegations[1].retryLinkGap = 'conflict';
    const restored = new RunLedger(rejectedOnce).snapshot()[0].delegations[1];
    expect(restored.retryLinkGap).toBe('conflict');
    expect(restored.retryOfHandle).toBeUndefined();
  });

  it('leaves attempts written before the link existed ungrouped', () => {
    const ledger = new RunLedger();
    dispatch(ledger, 'old-1', 1);
    dispatch(ledger, 'old-2', 2);
    const [run] = new RunLedger(ledger.snapshot()).snapshot();
    expect(run.delegations.every((delegation) => delegation.retryOfHandle === undefined && delegation.retryLinkGap === undefined)).toBe(true);
    expect(deriveRunMechanicalAccounting(run)).toMatchObject({ logicalTasks: 2, retryChains: 0, retryLinkGaps: 0 });
  });

  it('merges equal copies of a link unchanged and turns disagreeing copies into a conflict in both directions', () => {
    const origin = new RunLedger();
    dispatch(origin, 'h-1', 1);
    dispatch(origin, 'h-2', 2, { retryOfHandle: 'h-1', retryStage: 'firm-retry' });
    const shared = origin.snapshot();

    const same = new RunLedger(shared);
    expect(same.snapshotForPersistence(shared)[0].delegations[1]).toMatchObject({ retryOfHandle: 'h-1', retryStage: 'firm-retry' });

    const other = structuredClone(shared) as StoredRunRecord[];
    other[0].delegations[1].retryStage = 'fallback-model';
    const leftToRight = new RunLedger(shared).snapshotForPersistence(other)[0].delegations[1];
    const rightToLeft = new RunLedger(other).snapshotForPersistence(shared)[0].delegations[1];
    for (const merged of [leftToRight, rightToLeft]) {
      expect(merged.retryLinkGap).toBe('conflict');
      expect(merged.retryOfHandle).toBeUndefined();
      expect(merged.retryStage).toBeUndefined();
    }
  });
});
