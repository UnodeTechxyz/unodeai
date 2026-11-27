import { describe, expect, it } from 'vitest';
import { RunLedger } from '../RunLedger';
import { buildPortableRunEvidence } from '../PortableRunEvidence';

/*
 * v0.9.106 (Codex's audit of 63658176, RC-1): a dispatch can be refused after its request has ended, for example a start
 * refused once the coordinator had replied. Such a refusal waited in memory for a run of its thread that would never
 * open: the coordinator's next turn read it, but the saved runs and the evidence pack did not have it. A refusal now
 * belongs to its request's run even when that request has ended: the closed run of its thread, or, when no run ever held
 * the thread and the coordinator replied on it, the run opened for it then, closed as that reply closes a run. A refusal
 * while its request may still go on is recorded as before.
 */
const at = (minute: number) => `2026-11-18T08:${String(minute).padStart(2, '0')}:00.000Z`;
const reply = (ledger: RunLedger, correlationId: string, minute: number, type: 'task.complete' | 'task.partial' = 'task.complete') =>
  ledger.observeMessage({
    id: `reply-${correlationId}-${minute}`, correlationId, from: 'pm', to: 'user', type, priority: 'normal',
    payload: { instruction: 'Dispatched. I will report back.', metadata: { turnId: `turn-${correlationId}` } }, timestamp: at(minute),
  } as never);
const refuse = (ledger: RunLedger, correlationId: string, minute: number, handle = 'h-refused') => ledger.recordRefusedDispatch({
  coordinatorId: 'pm', handle, requestedAgent: 'reviewer', reason: 'It did not start, so it never took this task. No Codex CLI is selected.',
  originCorrelationId: correlationId, originTurnId: `turn-${correlationId}`, recordedAt: at(minute),
});
const holding = (ledger: RunLedger) => ledger.snapshot().filter((run) => run.refusedDispatches.length > 0);
const reloaded = (ledger: RunLedger) => new RunLedger(ledger.snapshot());
const refusedInPack = (ledger: RunLedger) => ledger.snapshot()
  .map((run) => buildPortableRunEvidence(run, at(59)).accounting.refusedBeforeDispatch).reduce((a, b) => a + b, 0);

describe('v0.9.106 (RC-1): a refusal that comes after its request ended is kept in that request\'s run', () => {
  it('no run ever held the thread and the PM replied: the run is opened for it, closed, and keeps the refusal once', () => {
    const ledger = new RunLedger();
    reply(ledger, 'first', 1);
    refuse(ledger, 'first', 2);
    expect(holding(ledger)).toHaveLength(1);
    expect(holding(ledger)[0]).toMatchObject({
      status: 'closed', delegations: [], correlationIds: expect.arrayContaining(['first']), openingTurnId: 'turn-first',
      closingTurnId: 'turn-first', closingReplyPartial: false, endedAt: at(2),
    });
    expect(holding(ledger)[0].refusedDispatches).toEqual([expect.objectContaining({ handle: 'h-refused', requestedAgent: 'reviewer' })]);
    // Recorded again, and again after a reload: still once.
    refuse(ledger, 'first', 2);
    const after = reloaded(ledger);
    refuse(after, 'first', 2);
    expect(holding(after)).toHaveLength(1);
    expect(holding(after)[0].refusedDispatches).toHaveLength(1);
    expect(refusedInPack(after)).toBe(1);
    // The coordinator's next turn still reads it under its previous turn.
    expect(ledger.dispatchOutcomesBetween('pm', at(0), at(3), 'first').refused).toHaveLength(1);
  });

  it('the thread\'s run already closed: the refusal joins it, once, and changes neither its close nor its tasks', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'dev-task', requestedAgent: 'dev', agentId: 'dev', instruction: 'Write it.',
      originCorrelationId: 'first', dispatchedAt: at(1),
    });
    ledger.recordDelegationEvidence({
      handle: 'dev-task', agentId: 'dev', outcome: 'no-evidence',
      evidence: { outcome: 'no-evidence', completionState: 'complete', changedFiles: [], hadToolActions: false,
        verification: { ran: false, passed: false }, unrecordedWrites: false } as never,
    });
    reply(ledger, 'first', 3);
    const closed = ledger.snapshot()[0];
    expect(closed.status).toBe('closed');
    refuse(ledger, 'first', 4);
    refuse(ledger, 'first', 4);
    const runs = reloaded(ledger).snapshot();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: closed.id, status: 'closed', endedAt: closed.endedAt, closeoutCompletionState: closed.closeoutCompletionState });
    expect(runs[0].delegations.map((row) => row.handle)).toEqual(['dev-task']);
    expect(runs[0].refusedDispatches).toHaveLength(1);
    expect(refusedInPack(ledger)).toBe(1);
  });

  it('while the request may still go on, a refusal is recorded as before: in its open run, or waiting for one', () => {
    // No run and no reply yet: it waits, and a run that opens for the thread takes it.
    const waiting = new RunLedger();
    refuse(waiting, 'first', 1);
    expect(waiting.snapshot()).toEqual([]);
    waiting.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'dev-task', requestedAgent: 'dev', agentId: 'dev', instruction: 'Write it.',
      originCorrelationId: 'first', dispatchedAt: at(2),
    });
    expect(waiting.snapshot()).toHaveLength(1);
    expect(waiting.snapshot()[0]).toMatchObject({ status: 'open' });
    expect(waiting.snapshot()[0].refusedDispatches).toHaveLength(1);
    // An open run takes it at once, and records it each time it is recorded, as before.
    refuse(waiting, 'first', 3, 'h-second');
    expect(waiting.snapshot()[0].refusedDispatches.map((entry) => entry.handle)).toEqual(['h-refused', 'h-second']);
    expect(waiting.snapshot()[0].status).toBe('open');
  });

  it('a policy refusal while the request goes on still opens its run; after the request ended it is kept closed', () => {
    const running = new RunLedger();
    running.recordRefusedDispatch({ coordinatorId: 'pm', handle: 'p1', requestedAgent: 'dev', reason: 'Policy.', taskState: 'policy-refused',
      originCorrelationId: 'first', recordedAt: at(1) });
    expect(running.snapshot()).toEqual([expect.objectContaining({ status: 'open' })]);

    const ended = new RunLedger();
    reply(ended, 'first', 1, 'task.partial');
    ended.recordRefusedDispatch({ coordinatorId: 'pm', handle: 'p1', requestedAgent: 'dev', reason: 'Policy.', taskState: 'policy-refused',
      originCorrelationId: 'first', recordedAt: at(2) });
    expect(ended.snapshot()).toEqual([expect.objectContaining({ status: 'closed', closeoutCompletionState: 'partial', delegations: [] })]);
    expect(ended.snapshot()[0].refusedDispatches).toHaveLength(1);
  });
});

/*
 * v0.9.106 (the Owner, retest 3): a request none of whose dispatches was taken did not finish what it asked for. Each
 * one was refused by team policy or never started (no CLI program chosen, say), and no task ran. Its run closes
 * Partial, not Complete, also when the refusal arrives after the reply closed the run. A run in which a task ran
 * closes as before.
 */
describe('v0.9.106 (retest 3): a request whose dispatches were all refused or never started closes partial', () => {
  const notStarted = (ledger: RunLedger, correlationId: string, minute: number, handle = 'h-not-started') => ledger.recordRefusedDispatch({
    coordinatorId: 'pm', handle, requestedAgent: 'reviewer', reason: 'It did not start, so it never took this task. No Codex CLI is selected.',
    taskState: 'not-started', originCorrelationId: correlationId, originTurnId: `turn-${correlationId}`, recordedAt: at(minute),
  });

  it('a start refused after the reply closed the run: the close is computed again, partial, and a reload keeps it', () => {
    const ledger = new RunLedger();
    reply(ledger, 'first', 1);
    notStarted(ledger, 'first', 2);
    const after = reloaded(ledger).snapshot();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: 'closed', delegations: [], closingReplyPartial: false, closeoutCompletionState: 'partial' });
    expect(after[0].refusedDispatches).toEqual([expect.objectContaining({ handle: 'h-not-started', taskState: 'not-started' })]);
  });

  it('a start refused while the request goes on: the reply closes the run partial', () => {
    const ledger = new RunLedger();
    ledger.recordRefusedDispatch({ coordinatorId: 'pm', handle: 'p0', requestedAgent: 'dev', reason: 'Policy.', taskState: 'policy-refused',
      originCorrelationId: 'first', recordedAt: at(1) });
    notStarted(ledger, 'first', 2);
    reply(ledger, 'first', 3);
    expect(ledger.snapshot()).toEqual([expect.objectContaining({ status: 'closed', closeoutCompletionState: 'partial', delegations: [] })]);
    expect(ledger.snapshot()[0].refusedDispatches.map((entry) => entry.taskState)).toEqual(['policy-refused', 'not-started']);
  });

  it('a request refused by team policy only, then replied to as complete, also closes partial', () => {
    const ledger = new RunLedger();
    ledger.recordRefusedDispatch({ coordinatorId: 'pm', handle: 'p1', requestedAgent: 'dev', reason: 'Policy.', taskState: 'policy-refused',
      originCorrelationId: 'first', recordedAt: at(1) });
    reply(ledger, 'first', 2);
    expect(ledger.snapshot()).toEqual([expect.objectContaining({ status: 'closed', closingReplyPartial: false, closeoutCompletionState: 'partial' })]);
  });

  it('a request in which a task ran closes as it did without the refusal, and an untyped refusal changes nothing', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'dev-task', requestedAgent: 'dev', agentId: 'dev', instruction: 'Write it.',
      originCorrelationId: 'first', dispatchedAt: at(1),
    });
    ledger.recordDelegationEvidence({
      handle: 'dev-task', agentId: 'dev', outcome: 'no-evidence',
      evidence: { outcome: 'no-evidence', completionState: 'complete', changedFiles: [], hadToolActions: false,
        verification: { ran: false, passed: false }, unrecordedWrites: false } as never,
    });
    ledger.recordDisposition({ handle: 'dev-task', agentId: 'dev', disposition: 'accepted', recordedAt: at(2), outcome: 'no-evidence' });
    reply(ledger, 'first', 3);
    const before = ledger.snapshot()[0].closeoutCompletionState;
    expect(before).toBe('complete');
    notStarted(ledger, 'first', 4);
    expect(ledger.snapshot()[0]).toMatchObject({ status: 'closed', closeoutCompletionState: before });

    const untyped = new RunLedger();
    reply(untyped, 'first', 1);
    refuse(untyped, 'first', 2);
    expect(untyped.snapshot()[0]).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
  });
});

/*
 * v0.9.106 retest 4: after one refused start, the first request's Job outcome counted it twice once a later save had
 * merged the in-memory run with its stored copy. The stored copy is rebuilt by the normalizer with its keys in another
 * order, and the merge compared raw JSON. A refusal is now one per dispatch handle, and other entries compare by
 * content whatever their key order. A copy already stored twice is read back once.
 */
describe('v0.9.106 (retest 4): a refusal survives a save merge once', () => {
  const stored = (ledger: RunLedger) => JSON.parse(JSON.stringify(new RunLedger(ledger.snapshot()).snapshot())) as unknown[];

  it('a not-started refusal and a policy refusal, merged with their stored copies, stay one each', () => {
    const ledger = new RunLedger();
    ledger.recordRefusedDispatch({ coordinatorId: 'pm', handle: 'p1', requestedAgent: 'dev', reason: 'Policy.', taskState: 'policy-refused',
      originCorrelationId: 'second', recordedAt: at(1) });
    reply(ledger, 'first', 2);
    ledger.recordRefusedDispatch({
      coordinatorId: 'pm', handle: 'h-not-started', requestedAgent: 'reviewer', reason: 'It did not start, so it never took this task.',
      taskState: 'not-started', originCorrelationId: 'first', originTurnId: 'turn-first', recordedAt: at(3),
    });
    // The live receipt and its stored copy differ in key order only.
    const live = ledger.snapshot().flatMap((run) => run.refusedDispatches);
    const disk = (stored(ledger) as Array<{ refusedDispatches: unknown[] }>).flatMap((run) => run.refusedDispatches);
    expect(disk).toEqual(live);
    expect(disk.map((entry) => JSON.stringify(entry))).not.toEqual(live.map((entry) => JSON.stringify(entry)));

    for (let save = 0; save < 3; save++) ledger.snapshotForPersistence(stored(ledger));
    const runs = ledger.snapshot();
    expect(runs.flatMap((run) => run.refusedDispatches.map((entry) => entry.handle)).sort()).toEqual(['h-not-started', 'p1']);
    const first = runs.find((run) => run.correlationIds.includes('first'))!;
    expect(first.closeoutCompletionState).toBe('partial');
    expect(refusedInPack(ledger)).toBe(2);
  });

  // Codex's audit of fef956c9, R1: two separate attempts refused before a handle was issued can be equal in content.
  it('two separate refusals without a handle, equal in content, stay two through save merges and a reload', () => {
    const ledger = new RunLedger();
    const refusal = () => ledger.recordRefusedDispatch({ coordinatorId: 'pm', requestedAgent: 'reviewer', taskState: 'no-executor',
      reason: 'Error: task state no-executor for "reviewer".', originCorrelationId: 'first', recordedAt: at(1) });
    ledger.recordRefusedDispatch({ coordinatorId: 'pm', handle: 'p1', requestedAgent: 'dev', reason: 'Policy.', taskState: 'policy-refused',
      originCorrelationId: 'first', recordedAt: at(1) });
    refusal();
    refusal();
    for (let save = 0; save < 3; save++) ledger.snapshotForPersistence(stored(ledger));
    expect(ledger.snapshot()[0].refusedDispatches.map((entry) => entry.handle ?? entry.requestedAgent)).toEqual(['p1', 'reviewer', 'reviewer']);
    expect(reloaded(ledger).snapshot()[0].refusedDispatches).toHaveLength(3);
    expect(refusedInPack(reloaded(ledger))).toBe(3);
  });

  it('a run stored with the same refusal twice is read back with it once', () => {
    const ledger = new RunLedger();
    reply(ledger, 'first', 1);
    ledger.recordRefusedDispatch({
      coordinatorId: 'pm', handle: 'h-not-started', requestedAgent: 'reviewer', reason: 'It did not start.',
      taskState: 'not-started', originCorrelationId: 'first', originTurnId: 'turn-first', recordedAt: at(2),
    });
    const [run] = stored(ledger) as Array<{ refusedDispatches: Array<Record<string, unknown>> }>;
    const copy = run.refusedDispatches[0];
    run.refusedDispatches.push(Object.fromEntries(Object.entries(copy).reverse()));
    // Refusals without a handle are kept as stored: two equal ones may be two attempts (Codex's audit of fef956c9, R1).
    run.refusedDispatches.push({ requestedAgent: 'dev', reason: 'No such agent.', recordedAt: at(2) });
    run.refusedDispatches.push({ recordedAt: at(2), reason: 'No such agent.', requestedAgent: 'dev' });
    const read = new RunLedger([run]).snapshot()[0];
    expect(read.refusedDispatches.map((entry) => entry.handle ?? entry.requestedAgent)).toEqual(['h-not-started', 'dev', 'dev']);
  });
});
