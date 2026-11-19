import { describe, expect, it } from 'vitest';
import {
  ACCOUNTABILITY_ANCHOR_LIMIT,
  arbitrateAccountabilityAnchors,
  jobOutcomeAccountabilityAnchor,
  requestSummaryAnchor,
  type AccountabilityAnchorCandidate,
} from '../AccountabilityAnchor';
import { jobOutcomeAnchor, type JobOutcomeAnchorEntry } from '../JobOutcomeAnchor';
import { limitedCoverageAreas, type RequestCloseoutRecordV1 } from '../RequestCloseout';

function record(turn: string, overrides: Partial<RequestCloseoutRecordV1> = {}): RequestCloseoutRecordV1 {
  const built = {
    schemaVersion: 1 as const,
    recordId: `request-closeout:req-1:${turn}` as const,
    requestId: 'req-1',
    rootAgentId: 'pm',
    originTurnId: 'turn-1',
    terminalTurnId: turn,
    recordedAt: '2026-10-08T01:00:00.000Z',
    revision: 1,
    terminal: { kind: 'answered' as const },
    usageUnitIds: [],
    observations: {
      changes: { coverage: 'complete' as const, files: [], omitted: 0, droppedPaths: 0 },
      checks: { coverage: 'complete' as const, passed: 0, failed: 0, refused: 0 },
      approvals: { coverage: 'complete' as const, decisions: [] },
      context: { coverage: 'complete' as const, sources: 0, estimatedTextTokens: 0 },
      routes: { coverage: 'unavailable' as const, agents: [], omitted: 0 },
      reasoning: { visibleItems: 0 },
    },
    coverage: { events: 'complete' as const, limited: [] as RequestCloseoutRecordV1['coverage']['limited'] },
    ...overrides,
  };
  built.coverage = { events: built.coverage.events, limited: limitedCoverageAreas(built) };
  return built;
}

function jobEntry(runId: string, closingTurnId: string, endedAt = '2026-10-08T01:05:00.000Z'): JobOutcomeAnchorEntry {
  return { state: 'anchored', anchor: jobOutcomeAnchor({ runId, coordinatorId: 'pm', closingTurnId, endedAt })! };
}

describe('requestSummaryAnchor', () => {
  it('follows the reply of a turn that answered, and the request of one that did not', () => {
    expect(requestSummaryAnchor(record('turn-1')).anchor).toEqual({
      schemaVersion: 1,
      anchorId: 'request-closeout:req-1:turn-1',
      kind: 'request-summary',
      target: { kind: 'assistant-turn', turnId: 'turn-1' },
      requestId: 'req-1',
      revision: 1,
    });
    expect(requestSummaryAnchor(record('turn-1', { terminal: { kind: 'stopped' } })).anchor.target).toEqual({ kind: 'user-turn', turnId: 'turn-1' });
    expect(requestSummaryAnchor(record('turn-1', { terminal: { kind: 'host-deadline' } })).anchor.target.kind).toBe('user-turn');
  });
});

describe('jobOutcomeAccountabilityAnchor', () => {
  it('adapts a Job outcome anchor, and targets the request when the closing turn had no reply', () => {
    expect(jobOutcomeAccountabilityAnchor(jobEntry('run-1', 'turn-2'))).toEqual({
      anchor: {
        schemaVersion: 1, anchorId: 'outcome:run-1', kind: 'job-outcome',
        target: { kind: 'assistant-turn', turnId: 'turn-2' }, runId: 'run-1', revision: 1,
      },
      recordedAt: '2026-10-08T01:05:00.000Z',
    });
    expect(jobOutcomeAccountabilityAnchor(jobEntry('run-1', 'turn-2'), true)?.anchor.target).toEqual({ kind: 'user-turn', turnId: 'turn-2' });
  });

  it('gives a conflict that kept its turn a place, and one that lost it none', () => {
    const kept: JobOutcomeAnchorEntry = { state: 'conflict', id: 'outcome:run-1', runId: 'run-1', coordinatorId: 'pm', afterTurnId: 'turn-2' };
    expect(jobOutcomeAccountabilityAnchor(kept)).toMatchObject({ conflict: true, anchor: { kind: 'job-outcome', target: { turnId: 'turn-2' } } });
    expect(jobOutcomeAccountabilityAnchor({ state: 'conflict', id: 'outcome:run-1', runId: 'run-1', coordinatorId: 'pm' })).toBeUndefined();
  });
});

describe('arbitrateAccountabilityAnchors', () => {
  it('shows the Job outcome and not the Request summary for the turn that closed a run', () => {
    const summary = requestSummaryAnchor(record('turn-2'));
    const job = jobOutcomeAccountabilityAnchor(jobEntry('run-1', 'turn-2'))!;
    for (const order of [[summary, job], [job, summary]]) {
      expect(arbitrateAccountabilityAnchors(order).map((anchor) => anchor.kind)).toEqual(['job-outcome']);
    }
  });

  it('keeps the summary of the dispatching turn and the Job outcome of the closing turn: two turns, two cards', () => {
    const dispatching = requestSummaryAnchor(record('turn-1'));
    const closing = requestSummaryAnchor(record('turn-2', { recordedAt: '2026-10-08T01:05:00.000Z' }));
    const job = jobOutcomeAccountabilityAnchor(jobEntry('run-1', 'turn-2'))!;
    expect(arbitrateAccountabilityAnchors([dispatching, closing, job]).map((anchor) => `${anchor.kind}@${anchor.target.turnId}`))
      .toEqual(['request-summary@turn-1', 'job-outcome@turn-2']);
  });

  it('takes the larger revision of one turn, then the smaller id, whatever order they arrive in', () => {
    const first = requestSummaryAnchor(record('turn-1'));
    const revised = requestSummaryAnchor(record('turn-1', { revision: 2 }));
    expect(arbitrateAccountabilityAnchors([first, revised])[0].revision).toBe(2);
    expect(arbitrateAccountabilityAnchors([revised, first])[0].revision).toBe(2);
    const a: AccountabilityAnchorCandidate = { anchor: { ...first.anchor, anchorId: 'a' } };
    const b: AccountabilityAnchorCandidate = { anchor: { ...first.anchor, anchorId: 'b' } };
    expect(arbitrateAccountabilityAnchors([b, a])[0].anchorId).toBe('a');
    expect(arbitrateAccountabilityAnchors([a, b])[0].anchorId).toBe('a');
  });

  it('keeps conflicts first and fills the rest with the newest', () => {
    const summaries = Array.from({ length: ACCOUNTABILITY_ANCHOR_LIMIT + 3 }, (_unused, index) =>
      requestSummaryAnchor(record(`turn-${index}`, { recordedAt: new Date(Date.UTC(2026, 9, 8, 2, 0, 0) + index * 1000).toISOString() })));
    const conflict = jobOutcomeAccountabilityAnchor({ state: 'conflict', id: 'outcome:run-x', runId: 'run-x', coordinatorId: 'pm', afterTurnId: 'turn-old' })!;
    const kept = arbitrateAccountabilityAnchors([...summaries, conflict]);
    expect(kept).toHaveLength(ACCOUNTABILITY_ANCHOR_LIMIT);
    expect(kept[0].anchorId).toBe('outcome:run-x');
    expect(kept.map((anchor) => anchor.target.turnId)).not.toContain('turn-3');
    expect(kept.at(-1)?.target.turnId).toBe(`turn-${ACCOUNTABILITY_ANCHOR_LIMIT + 2}`);
  });

  it('gives the same answer for the same candidates', () => {
    const candidates = [requestSummaryAnchor(record('turn-1')), jobOutcomeAccountabilityAnchor(jobEntry('run-1', 'turn-2'))!];
    expect(arbitrateAccountabilityAnchors(candidates)).toEqual(arbitrateAccountabilityAnchors([...candidates].reverse()));
  });
});
