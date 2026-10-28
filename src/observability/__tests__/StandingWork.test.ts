import { describe, expect, it } from 'vitest';
import { projectStandingWork, standingStateOf, terminalDispositionOf, type StandingWorkAttempt } from '../StandingWork';

const settled = (handle: string, extra: Partial<StandingWorkAttempt> = {}): StandingWorkAttempt => ({
  handle,
  dispatchedAt: '2026-10-11T10:00:00.000Z',
  lifecycle: 'settled',
  completionState: 'complete',
  dispositions: [],
  ...extra,
});

describe('the standing work of a coordinator', () => {
  it('counts every attempt once when nothing was replaced', () => {
    const projection = projectStandingWork([
      settled('a'),
      settled('b', { completionState: 'partial' }),
      settled('c', { completionState: 'not-observed' }),
      settled('d', { lifecycle: 'working', completionState: undefined }),
      settled('e', { lifecycle: 'cancelled', completionState: undefined }),
    ]);
    expect(projection.counts).toEqual({ working: 1, complete: 1, partial: 1, blocked: 1, cancelled: 1 });
    expect(projection.standing.map((entry) => entry.handle)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(projection.historical).toEqual([]);
  });

  it.each([
    ['complete', settled('old')],
    ['partial', settled('old', { completionState: 'partial' })],
    ['failed', settled('old', { lifecycle: 'failed', completionState: 'not-observed' })],
    ['refused', settled('old', { effects: { refusedOutstanding: 2, succeeded: false } })],
    ['interrupted', settled('old', { lifecycle: 'interrupted', completionState: undefined })],
  ])('keeps a superseded %s attempt as history and counts its replacement once', (_name, old) => {
    const projection = projectStandingWork([
      { ...old, dispositions: [{ disposition: 'superseded' }], declaredCheck: 'failed' },
      settled('new', { declaredCheck: 'passed' }),
    ]);
    expect(projection.counts).toEqual({ working: 0, complete: 1, partial: 0, blocked: 0, cancelled: 0 });
    expect(projection.declaredChecks).toEqual({ passed: 1, failed: 0, 'not-run': 0, 'not-applicable': 0 });
    expect(projection.historical).toEqual([expect.objectContaining({ handle: 'old', historical: 'superseded', terminalDisposition: 'superseded' })]);
    expect(projection.standing.map((entry) => entry.handle)).toEqual(['new']);
    // History is kept: the attempt is still in the projection, with how it ended.
    expect(projection.byHandle.get('old')?.state).toBe(standingStateOf(old));
  });

  it('keeps an abandoned attempt standing, as blocked: it has no replacement', () => {
    const projection = projectStandingWork([
      settled('lost', { lifecycle: 'interrupted', completionState: undefined, dispositions: [{ disposition: 'abandoned' }] }),
    ]);
    expect(projection.counts.blocked).toBe(1);
    expect(projection.standing).toEqual([{ handle: 'lost', state: 'blocked', terminalDisposition: 'abandoned', latestDisposition: 'abandoned' }]);
    expect(projection.historical).toEqual([]);
  });

  it('holds the first superseded or abandoned decision against a later entry', () => {
    expect(terminalDispositionOf([{ disposition: 'superseded' }, { disposition: 'accepted' }])).toBe('superseded');
    expect(terminalDispositionOf([{ disposition: 'accepted' }, { disposition: 'needs-rework' }])).toBeUndefined();
    const projection = projectStandingWork([
      settled('old', { dispositions: [{ disposition: 'superseded' }, { disposition: 'accepted' }] }),
    ]);
    expect(projection.byHandle.get('old')?.historical).toBe('superseded');
    expect(projection.counts.complete).toBe(0);
  });

  it('gives a standing attempt the decision in force and a historical one none', () => {
    const projection = projectStandingWork([
      settled('a', { dispositions: [{ disposition: 'needs-rework' }, { disposition: 'accepted-after-rework' }] }),
      settled('b', { dispositions: [{ disposition: 'superseded' }] }),
      settled('c'),
    ]);
    expect(projection.byHandle.get('a')?.latestDisposition).toBe('accepted-after-rework');
    expect(projection.byHandle.get('b')).not.toHaveProperty('latestDisposition');
    expect(projection.byHandle.get('c')).not.toHaveProperty('latestDisposition');
  });

  it('makes an earlier attempt history through a typed retry link, with no decision recorded', () => {
    const projection = projectStandingWork([
      settled('first', { dispatchedAt: '2026-10-11T10:00:00.000Z' }),
      settled('second', { dispatchedAt: '2026-10-11T10:01:00.000Z', retryOfHandle: 'first', retryStage: 'firm-retry' }),
      settled('third', { dispatchedAt: '2026-10-11T10:02:00.000Z', retryOfHandle: 'second', retryStage: 'fallback-model', lifecycle: 'working', completionState: undefined }),
    ]);
    expect(projection.historical.map((entry) => [entry.handle, entry.historical])).toEqual([['first', 'retried'], ['second', 'retried']]);
    expect(projection.standing.map((entry) => entry.handle)).toEqual(['third']);
    expect(projection.counts).toEqual({ working: 1, complete: 0, partial: 0, blocked: 0, cancelled: 0 });
  });

  it.each([
    ['a parent that is not among the attempts', { retryOfHandle: 'absent', retryStage: 'firm-retry' as const }],
    ['a parent that was not dispatched earlier', { retryOfHandle: 'first', retryStage: 'firm-retry' as const, dispatchedAt: '2026-10-11T10:00:00.000Z' }],
    ['a link the host already rejected', { retryOfHandle: 'first', retryStage: 'firm-retry' as const, retryLinkGap: 'cycle' as const }],
    ['a link without its stage', { retryOfHandle: 'first' }],
  ])('leaves both attempts standing for %s', (_name, link) => {
    const projection = projectStandingWork([
      settled('first', { dispatchedAt: '2026-10-11T10:00:00.000Z' }),
      settled('second', { dispatchedAt: '2026-10-11T10:01:00.000Z', ...link }),
    ]);
    expect(projection.historical).toEqual([]);
    expect(projection.counts.complete).toBe(2);
  });

  it('reads an attempt once when it is handed over twice', () => {
    const projection = projectStandingWork([settled('a'), settled('a', { completionState: 'partial' })]);
    expect(projection.attempts).toHaveLength(1);
    expect(projection.counts).toEqual({ working: 0, complete: 1, partial: 0, blocked: 0, cancelled: 0 });
  });
});

describe('how one attempt ended', () => {
  it('is blocked when every file change it asked for was refused and none was made', () => {
    expect(standingStateOf(settled('a', { effects: { refusedOutstanding: 1, succeeded: false } }))).toBe('blocked');
    expect(standingStateOf(settled('a', { effects: { refusedOutstanding: 3, succeeded: false } }))).toBe('blocked');
  });

  it('is partial when a file change was refused and another was made', () => {
    expect(standingStateOf(settled('a', { effects: { refusedOutstanding: 1, succeeded: true } }))).toBe('partial');
  });

  it('stays complete when nothing was refused, whether or not a file changed', () => {
    // Write authority that was never used proves nothing: a read-only task is complete.
    expect(standingStateOf(settled('a'))).toBe('complete');
    expect(standingStateOf(settled('a', { effects: { refusedOutstanding: 0, succeeded: false } }))).toBe('complete');
    expect(standingStateOf(settled('a', { effects: { refusedOutstanding: 0, succeeded: true } }))).toBe('complete');
  });

  it('keeps the typed terminal shape ahead of the file-change facts', () => {
    expect(standingStateOf(settled('a', { completionState: 'partial', effects: { refusedOutstanding: 1, succeeded: false } }))).toBe('partial');
    expect(standingStateOf(settled('a', { completionState: 'not-observed', effects: { refusedOutstanding: 0, succeeded: true } }))).toBe('blocked');
  });

  it.each([
    ['working', 'working'], ['cancelled', 'cancelled'], ['interrupted', 'blocked'], ['failed', 'blocked'], ['policy-refused', 'blocked'],
  ] as const)('reads lifecycle %s as %s whatever else is recorded', (lifecycle, state) => {
    expect(standingStateOf(settled('a', { lifecycle, effects: { refusedOutstanding: 0, succeeded: true } }))).toBe(state);
  });

  it('counts a record without a typed terminal shape as complete, as it always was', () => {
    expect(standingStateOf(settled('legacy', { completionState: undefined }))).toBe('complete');
  });
});
