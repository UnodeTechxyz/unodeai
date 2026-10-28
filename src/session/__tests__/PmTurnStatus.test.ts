import { describe, expect, it } from 'vitest';
import type { CoordinatorTaskStatus } from '../../backend/TeamTools';
import type { DelegationResultProjection } from '../../backend/DelegationResultProjection';
import { formatPmTurnStatus, parsePmTurnStatus, pmStatusRelevant, pmTurnStatus, type PmStatusFacts } from '../PmTurnStatus';

// v0.9.99 P4: the closed, first-match PM status table, with Codex's two R3 conditions: awaiting-rework is its own row
// and never a review continuation, and nothing claims "nothing is running" while a handle is uncertain.
const result = (handle: string, state: DelegationResultProjection['state'], fields: Partial<DelegationResultProjection> = {}): DelegationResultProjection => ({
  handle, ref: { handle, revision: 2 }, state, execution: 'ended', wait: 'not-waiting', nextAction: 'decide', blocksComplete: true, ...fields,
});
const task = (handle: string, state: DelegationResultProjection['state'], fields: Partial<DelegationResultProjection> = {}): CoordinatorTaskStatus => ({
  handle, requestedAgent: 'Dev', lifecycle: 'settled', result: result(handle, state, fields),
});
const runningTask = (handle: string): CoordinatorTaskStatus => ({ handle, requestedAgent: 'QA', lifecycle: 'active', execution: { state: 'running' } });
const facts = (fields: Partial<PmStatusFacts> = {}): PmStatusFacts => ({
  turnEnd: 'answered', held: false, tasks: [], refused: [], accepted: 0, closed: false, ...fields,
});
const row = (fields: Partial<PmStatusFacts>) => pmTurnStatus(facts(fields));

const RUNNING = runningTask('run-aaaaaaaa');
const UNCERTAIN = task('unc-bbbbbbbb', 'stop-unconfirmed');
const HUMAN = task('hum-cccccccc', 'awaiting-human', { decision: { value: 'needs-human', reason: 'Which jurisdiction applies?', recordedAt: '2026-10-27T08:00:00.000Z' } });
const SCHEDULED = task('sch-dddddddd', 'awaiting-decision', { reviewContinuation: 'scheduled' });
const CONSUMED = task('con-eeeeeeee', 'awaiting-decision', { reviewContinuation: 'consumed' });
const REWORK = task('rwk-ffffffff', 'awaiting-rework', { decision: { value: 'needs-rework', recordedAt: '2026-10-27T08:00:00.000Z' } });
const REFUSED = [{ requestedAgent: 'Dev', reason: 'no such agent' }];

describe('the PM status table, one test per row', () => {
  it('row 1: Stop, which promises no automatic PM turn and still names running and unconfirmed work', () => {
    const status = row({ turnEnd: 'stopped', tasks: [RUNNING, UNCERTAIN, CONSUMED] });
    expect(status).toMatchObject({ row: 1, state: 'Stopped', why: 'you pressed Stop',
      next: 'No automatic PM turn is scheduled. Your next message resumes the team.' });
    expect(status.now).toBe('1 task still running · 1 result not yet reviewed. UnodeAi cannot confirm the state of Dev (unc-bbbb) rev 2.');
    expect(formatPmTurnStatus(status)).not.toMatch(/Nothing runs automatically/);
    expect(row({ held: true }).row).toBe(1);
  });

  it('row 2: a person must decide, quoted from the recorded reason, with where to answer and no background promise', () => {
    const status = row({ tasks: [HUMAN, RUNNING] });
    expect(status).toMatchObject({ row: 2, state: 'Awaiting your decision', why: 'a result needs a person' });
    expect(status.now).toBe('Dev (hum-cccc) rev 2 needs your decision: "Which jurisdiction applies?".');
    expect(status.next).toBe('Answer it in Review Delivered Work: open the Command Palette and run "UnodeAi: Review Delivered Work".');
    expect(status.next).not.toMatch(/automatic/);
  });

  it('row 3: timed out or failed with work running; the wake is promised', () => {
    expect(row({ turnEnd: 'host-deadline', tasks: [RUNNING] })).toMatchObject({ row: 3, state: 'Timed out',
      now: 'Still running: QA (run-aaaa).', why: 'the turn timed out',
      next: 'Their results will wake the PM automatically. No action is needed now.' });
    expect(row({ turnEnd: 'failed', tasks: [RUNNING] })).toMatchObject({ row: 3, state: 'Turn failed', why: 'the turn failed' });
  });

  it('row 4: timed out with a scheduled review continuation', () => {
    expect(row({ turnEnd: 'host-deadline', tasks: [SCHEDULED] })).toMatchObject({ row: 4, state: 'Timed out',
      next: 'The PM gets one automatic turn to review Dev (sch-dddd) rev 2.' });
  });

  it('row 5: timed out with nothing running, scheduled or uncertain', () => {
    expect(row({ turnEnd: 'failed' })).toMatchObject({ row: 5, state: 'Turn failed', now: 'Nothing is running.',
      next: 'Nothing is scheduled. The team continues when you send a message.' });
    expect(row({ turnEnd: 'failed', tasks: [CONSUMED] }).now).toBe('Not yet reviewed: Dev (con-eeee) rev 2.');
  });

  it('row 6: running in background; an uncertain handle is named and is not covered by the promise', () => {
    expect(row({ tasks: [RUNNING] })).toMatchObject({ row: 6, state: 'Running in background',
      now: 'Running: QA (run-aaaa).', why: 'waiting for background results',
      next: 'When a result returns, the PM resumes automatically and reviews it.' });
    expect(row({ tasks: [RUNNING, UNCERTAIN] }).now).toBe('Running: QA (run-aaaa). UnodeAi cannot confirm the state of Dev (unc-bbbb) rev 2.');
  });

  it('row 7: a result without a decision has its one automatic review turn scheduled', () => {
    expect(row({ tasks: [SCHEDULED] })).toMatchObject({ row: 7, state: 'Awaiting PM review',
      why: 'the PM ended without recording a decision', next: 'The PM gets one automatic turn to review Dev (sch-dddd) rev 2.' });
  });

  it('row 8: the automatic turn was used; no further turn is promised', () => {
    expect(row({ tasks: [CONSUMED] })).toMatchObject({ row: 8, state: 'Awaiting PM review',
      why: 'no decision after the automatic review turn',
      next: 'No further automatic turn. The team continues when you send a message.' });
    // A result that never had a turn (delivered before this window opened) does not claim one was used.
    expect(row({ tasks: [task('old-11111111', 'awaiting-decision')] })).toMatchObject({ row: 8,
      why: 'the PM has not recorded a decision', next: 'No automatic turn is scheduled. The team continues when you send a message.' });
  });

  it('awaiting rework is its own row: a recorded decision, never a review continuation, no automatic promise', () => {
    const status = row({ tasks: [REWORK] });
    expect(status).toMatchObject({ row: 8.5, state: 'Awaiting PM review', why: 'rework was requested but no rework is running',
      now: 'Rework requested, not running: Dev (rwk-ffff) rev 2.' });
    expect(status.next).toBe('No automatic turn is scheduled. The team continues when you send a message.');
  });

  it('row 9: no task dispatched', () => {
    expect(row({ refused: REFUSED })).toMatchObject({ row: 9, state: 'No task dispatched', now: 'Refused: Dev: no such agent.',
      next: 'Nothing is running and nothing is scheduled. The team continues when you send a message.' });
  });

  it('row 10: complete only when the assignment was closed', () => {
    expect(row({ closed: true })).toMatchObject({ row: 10, state: 'Complete', now: 'Nothing is running.', why: 'the PM closed the assignment' });
  });

  it('row 11: idle needs positive proof of every empty fact and an ordinary turn end', () => {
    for (const turnEnd of ['answered', 'tool-only', 'empty-reply', 'no-conclusion'] as const) {
      expect(row({ turnEnd })).toMatchObject({ row: 11, state: 'Idle', now: 'Nothing is running.' });
    }
  });

  it('row 12: anything the table does not prove, including an unconfirmed stop', () => {
    const status = row({ tasks: [UNCERTAIN] });
    expect(status).toMatchObject({ row: 12, state: 'Status unavailable', next: 'UnodeAi cannot confirm whether work is still running.' });
    expect(status.now).toBe('UnodeAi cannot confirm the state of Dev (unc-bbbb) rev 2.');
    expect(row({ tasks: [task('rec-22222222', 'awaiting-decision', { recovery: 'delivery-unknown' })] }).row).toBe(12);
  });
});

describe('the precedence pairs', () => {
  it.each([
    ['1 over 2', { turnEnd: 'stopped', tasks: [HUMAN] }, 1],
    ['2 over 3', { turnEnd: 'host-deadline', tasks: [HUMAN, RUNNING] }, 2],
    ['3 over 6', { turnEnd: 'host-deadline', tasks: [RUNNING] }, 3],
    ['6 over 7', { tasks: [RUNNING, SCHEDULED] }, 6],
    ['7 over 8', { tasks: [SCHEDULED, CONSUMED] }, 7],
    ['8 over 9', { tasks: [CONSUMED], refused: REFUSED }, 8],
    ['9 over 10', { refused: REFUSED, closed: true }, 9],
    ['10 over 11', { closed: true }, 10],
  ] as const)('%s', (_name, fields, expected) => {
    expect(row(fields as Partial<PmStatusFacts>).row).toBe(expected);
  });

  it('a refusal with nothing accepted and an unconfirmed stop is row 12, never "nothing is running"', () => {
    const status = row({ refused: REFUSED, tasks: [UNCERTAIN] });
    expect(status.row).toBe(12);
    expect(formatPmTurnStatus(status)).not.toMatch(/nothing is running|Nothing is running|nothing is scheduled/);
  });

  it('a failed turn with an uncertain handle never says nothing is scheduled', () => {
    const status = row({ turnEnd: 'failed', tasks: [UNCERTAIN] });
    expect(status.row).toBe(12);
    expect(status.why).toBe('the turn failed');
  });
});

describe('what the status reads and carries', () => {
  it('reads running, uncertain and owed records, and leaves decided, historical and cancelled ones out', () => {
    expect(pmStatusRelevant(RUNNING)).toBe(true);
    expect(pmStatusRelevant(UNCERTAIN)).toBe(true);
    expect(pmStatusRelevant(SCHEDULED)).toBe(true);
    expect(pmStatusRelevant(REWORK)).toBe(true);
    expect(pmStatusRelevant(task('d', 'decided'))).toBe(false);
    expect(pmStatusRelevant(task('h', 'historical'))).toBe(false);
    expect(pmStatusRelevant({ handle: 'c', lifecycle: 'cancelled' })).toBe(false);
    expect(pmStatusRelevant({ handle: 'l', lifecycle: 'settled', disposition: { value: 'accepted' } })).toBe(false);
  });

  it('round-trips through metadata and drops anything malformed', () => {
    const status = row({ tasks: [SCHEDULED] });
    expect(parsePmTurnStatus(JSON.parse(JSON.stringify(status)))).toEqual(status);
    expect(parsePmTurnStatus({ row: 7, state: 'Awaiting PM review' })).toBeUndefined();
    expect(parsePmTurnStatus('PM status')).toBeUndefined();
  });
});
