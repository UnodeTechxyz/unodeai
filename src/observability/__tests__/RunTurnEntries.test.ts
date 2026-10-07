import { describe, expect, it } from 'vitest';
import type { Message } from '../../types';
import { TurnTimingTracker, type TurnTiming } from '../../session/TurnTiming';
import { RunLedger, RUN_SCHEMA_VERSIONS, type StoredRunRecord } from '../RunLedger';
import { mergeRunTurnEntries, parseRunTurnEntry, type RunTurnEntry } from '../RunTurnEntries';

/** A timing fact exactly as the tracker builds it. */
function timing(startMs = 1_000, waitMs = 2_000): TurnTiming {
  let now = startMs;
  const tracker = new TurnTimingTracker(() => now);
  tracker.begin('agent', new Date(startMs - 500).toISOString());
  now += 250; tracker.modelRequest('agent');
  now += waitMs; tracker.responding('agent');
  now += 750;
  return tracker.finish('agent')!;
}

const recorded = (overrides: Record<string, unknown> = {}) => ({
  state: 'recorded', runId: 'run-1', turnId: 'turn-1', agentId: 'pm', correlationId: 'thread-1', ended: 'completed',
  usageUnitId: 'unit-1', timing: timing(), ...overrides,
});

function message(from: string, to: string, type: Message['type'], correlationId: string): Message {
  return {
    id: `${from}-${to}-${type}-${correlationId}`, correlationId, from, to, type, priority: 'normal',
    payload: { instruction: '' }, timestamp: '2026-10-02T00:00:10.000Z',
  } as Message;
}

/** A run with one delegation: `pm` owns thread `root`, `dev` holds handle `h1`. */
function runWithDelegation(ledger = new RunLedger()): { ledger: RunLedger; runId: string } {
  const runId = ledger.recordDelegationDispatched({
    coordinatorId: 'pm', handle: 'h1', requestedAgent: 'dev', agentId: 'dev', instruction: 'Do it.',
    originCorrelationId: 'root',
  });
  return { ledger, runId: runId! };
}

describe('run turn entry', () => {
  it('rebuilds a recorded entry field by field', () => {
    const entry = parseRunTurnEntry({ ...recorded(), smuggled: 'prose' });
    expect(entry).toEqual(recorded());
    expect(entry).not.toHaveProperty('smuggled');
    expect(parseRunTurnEntry(recorded({ usageUnitId: undefined }))).not.toHaveProperty('usageUnitId');
    expect(parseRunTurnEntry({ state: 'conflict', runId: 'run-1', turnId: 'turn-1', agentId: 'pm', timing: timing() }))
      .toEqual({ state: 'conflict', runId: 'run-1', turnId: 'turn-1', agentId: 'pm' });
  });

  it('refuses a timing whose phases do not add up to its duration', () => {
    const fact = timing();
    const padded = { ...fact, phases: { ...fact.phases!, toolMs: fact.phases!.toolMs + 1 } };
    expect(parseRunTurnEntry(recorded({ timing: padded }))).toBeUndefined();
    // A longer duration with the same phases is the same lie from the other side.
    expect(parseRunTurnEntry(recorded({ timing: { ...fact, durationMs: fact.durationMs + 1 } }))).toBeUndefined();
    expect(parseRunTurnEntry(recorded({ timing: { ...fact, approvalWaitMs: 5 } }))).toBeUndefined();
    const longest = { ...fact, phases: { ...fact.phases!, longestProviderWaitMs: fact.phases!.providerWaitMs + 1 } };
    expect(parseRunTurnEntry(recorded({ timing: longest }))).toBeUndefined();
  });

  it('refuses an entry with no phase breakdown, an unknown ending or a malformed id', () => {
    const { phases: _phases, ...total } = timing();
    expect(parseRunTurnEntry(recorded({ timing: total }))).toBeUndefined();
    expect(parseRunTurnEntry(recorded({ ended: 'succeeded' }))).toBeUndefined();
    expect(parseRunTurnEntry(recorded({ turnId: 'has space' }))).toBeUndefined();
    expect(parseRunTurnEntry(recorded({ usageUnitId: '' }))).toBeUndefined();
    expect(parseRunTurnEntry(recorded({ correlationId: undefined }))).toBeUndefined();
    expect(parseRunTurnEntry(recorded({ state: 'available' }))).toBeUndefined();
  });

  it('merges the same entry to one and a different entry under the same turn to a conflict that stays', () => {
    const first = parseRunTurnEntry(recorded())!;
    const other = parseRunTurnEntry(recorded({ timing: timing(1_000, 9_000) }))!;
    expect(mergeRunTurnEntries([first], [structuredClone(first)])).toEqual([first]);

    const conflict: RunTurnEntry = { state: 'conflict', runId: 'run-1', turnId: 'turn-1', agentId: 'pm' };
    expect(mergeRunTurnEntries([first], [other])).toEqual([conflict]);
    expect(mergeRunTurnEntries([other], [first])).toEqual([conflict]);
    // Neither copy can win later, and merging again changes nothing.
    expect(mergeRunTurnEntries([conflict], [first])).toEqual([conflict]);
    expect(mergeRunTurnEntries(mergeRunTurnEntries([first], [other]), [other])).toEqual([conflict]);
  });

  it('keeps entries in turn order whichever copy is merged into which', () => {
    const a = parseRunTurnEntry(recorded({ turnId: 'turn-a' }))!;
    const b = parseRunTurnEntry(recorded({ turnId: 'turn-b', agentId: 'dev', correlationId: 'h1' }))!;
    expect(mergeRunTurnEntries([b], [a])).toEqual([a, b]);
    expect(mergeRunTurnEntries([a], [b])).toEqual([a, b]);
  });
});

describe('RunLedger turn entries', () => {
  it('keeps the coordinator turn that created the run and the worker turn of its delegation', () => {
    const { ledger, runId } = runWithDelegation();
    expect(ledger.recordTurn('pm', {
      turnId: 'turn-pm', correlationId: 'root', runId, usageUnitId: 'unit-pm', ended: 'completed', timing: timing(),
    })).toBe(true);
    expect(ledger.recordTurn('dev', {
      turnId: 'turn-dev', correlationId: 'h1', runId, usageUnitId: 'unit-dev', ended: 'stopped', timing: timing(5_000),
    })).toBe(true);

    const run = ledger.get(runId)!;
    expect(run.schemaVersion).toBe(10);
    expect(run.turns.map((entry) => entry.state === 'recorded' && [entry.turnId, entry.agentId, entry.ended, entry.usageUnitId]))
      .toEqual([['turn-dev', 'dev', 'stopped', 'unit-dev'], ['turn-pm', 'pm', 'completed', 'unit-pm']]);
    // The same entry again changes nothing.
    expect(ledger.recordTurn('pm', {
      turnId: 'turn-pm', correlationId: 'root', runId, usageUnitId: 'unit-pm', ended: 'completed', timing: timing(),
    })).toBe(false);
  });

  it('refuses a turn with no run, an unknown run, or a thread the run does not hold', () => {
    const { ledger, runId } = runWithDelegation();
    const event = { turnId: 't', correlationId: 'root', ended: 'completed' as const, timing: timing() };
    expect(ledger.recordTurn('pm', event)).toBe(false);
    expect(ledger.recordTurn('pm', { ...event, runId: 'no-such-run' })).toBe(false);
    // The run id alone is not membership: the agent must own the thread or hold the delegation.
    expect(ledger.recordTurn('pm', { ...event, runId, correlationId: 'another-thread' })).toBe(false);
    expect(ledger.recordTurn('dev', { ...event, runId, correlationId: 'root' })).toBe(false);
    expect(ledger.recordTurn('other', { ...event, runId, correlationId: 'h1' })).toBe(false);
    expect(ledger.get(runId)!.turns).toEqual([]);
  });

  it('counts an entry it cannot rebuild instead of keeping it', () => {
    const { ledger, runId } = runWithDelegation();
    const fact = timing();
    const broken = { ...fact, phases: { ...fact.phases!, hostMs: fact.phases!.hostMs + 7 } };
    expect(ledger.recordTurn('pm', { turnId: 't', correlationId: 'root', runId, ended: 'completed', timing: broken })).toBe(true);
    expect(ledger.get(runId)).toMatchObject({ turns: [], droppedTurns: 1 });
  });

  it('takes the closing turn of a run that its terminal message has already closed', () => {
    const { ledger, runId } = runWithDelegation();
    ledger.recordDelegationEvidence({
      handle: 'h1', agentId: 'dev', outcome: 'verified',
      evidence: {
        outcome: 'verified', completionState: 'complete', changedFiles: [], hadToolActions: true,
        verification: { ran: true, passed: true, command: 'npm test' }, unrecordedWrites: false,
      },
    });
    const done = message('pm', 'user', 'task.partial', 'root');
    done.payload.metadata = { completionState: 'partial', unfinishedActivity: 'One item remains.' };
    ledger.observeMessage(done);
    expect(ledger.get(runId)!.status).toBe('closed');

    expect(ledger.recordTurn('pm', { turnId: 'closing', correlationId: 'root', runId, ended: 'completed', timing: timing() })).toBe(true);
    expect(ledger.get(runId)!.turns).toHaveLength(1);
  });

  it('survives a reload, and a second window with another fact for the same turn makes a conflict', () => {
    const { ledger, runId } = runWithDelegation();
    ledger.recordTurn('pm', { turnId: 'turn-pm', correlationId: 'root', runId, usageUnitId: 'unit-pm', ended: 'completed', timing: timing() });
    const stored = structuredClone(ledger.snapshot());

    const reloaded = new RunLedger(stored);
    expect(reloaded.get(runId)!.turns).toEqual(ledger.get(runId)!.turns);

    const otherWindow = structuredClone(stored) as StoredRunRecord[];
    (otherWindow[0].turns![0] as { timing: TurnTiming }).timing = timing(1_000, 30_000);
    const merged = reloaded.snapshotForPersistence(otherWindow).find((run) => run.id === runId)!;
    expect(merged.turns).toEqual([{ state: 'conflict', runId, turnId: 'turn-pm', agentId: 'pm' }]);
    // The conflict stays through another reload.
    expect(new RunLedger(structuredClone(reloaded.snapshot())).get(runId)!.turns)
      .toEqual([{ state: 'conflict', runId, turnId: 'turn-pm', agentId: 'pm' }]);
  });

  it('reads a row written before v10 as not recorded, and drops a stored entry that is not one the host wrote', () => {
    const { ledger, runId } = runWithDelegation();
    ledger.recordTurn('pm', { turnId: 'turn-pm', correlationId: 'root', runId, ended: 'completed', timing: timing() });
    const [row] = structuredClone(ledger.snapshot()) as StoredRunRecord[];

    const v9 = structuredClone(row);
    v9.schemaVersion = 9;
    const old = new RunLedger([v9]).get(runId)!;
    expect(RUN_SCHEMA_VERSIONS.at(-1)).toBe(10);
    // An older build never wrote turns, so whatever sits in that field of a v9 row is not evidence.
    expect(old).toMatchObject({ schemaVersion: 10, turns: [], droppedTurns: 0 });

    const tampered = structuredClone(row);
    tampered.turns = [
      ...row.turns!,
      { ...(row.turns![0] as object), turnId: 'padded', timing: { ...timing(), durationMs: 1 } } as RunTurnEntry,
      { ...(row.turns![0] as object), turnId: 'foreign', runId: 'another-run' } as RunTurnEntry,
    ];
    expect(new RunLedger([tampered]).get(runId)).toMatchObject({ droppedTurns: 2 });
    expect(new RunLedger([tampered]).get(runId)!.turns).toHaveLength(1);
  });
});
