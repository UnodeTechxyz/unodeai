import { describe, expect, it } from 'vitest';
import type { ScheduleFailureClass } from '../contracts';
import {
  automaticCheck,
  manualCheck,
  recordAttempt,
  recordFailure,
  recordSuccess,
  retryTime,
  RETRIED_FAILURE_CLASSES,
  UPDATE_SCHEDULE,
  type AutomaticCheckInput,
} from '../updater/schedule';

// ADAPTER §5.10 as amended by Revision 5 §1: no traffic before enrolment; with automatic mode on, at most one attempt
// per 24 h per provider across windows (`schedule.lastAttemptAt`); the first 2 minutes after the window starts, only in
// a trusted window that is not shutting down; retries by class (network / timeout / signature-unavailable at +1 h and
// +6 h, then stop; integrity, signature, host-not-allowed, store-full and file never); the user's Update now at once.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse('2026-10-21T08:00:00Z');
const iso = (time: number) => new Date(time).toISOString();

function input(overrides: Partial<AutomaticCheckInput> = {}): AutomaticCheckInput {
  return {
    now: T0 + 2 * MINUTE,
    window: { startedAt: T0, trusted: true, shuttingDown: false },
    enrolled: true,
    autoMode: true,
    schedule: {},
    targetEntryId: 'e164',
    ...overrides,
  };
}

describe('automaticCheck', () => {
  it('sends nothing before enrolment, with automatic mode off, in an untrusted window or during shutdown', () => {
    expect(automaticCheck(input({ enrolled: false }))).toEqual({ kind: 'never', why: 'not-enrolled' });
    expect(automaticCheck(input({ autoMode: false }))).toEqual({ kind: 'never', why: 'auto-off' });
    expect(automaticCheck(input({ window: { startedAt: T0, trusted: false, shuttingDown: false } }))).toEqual({ kind: 'never', why: 'untrusted' });
    expect(automaticCheck(input({ window: { startedAt: T0, trusted: true, shuttingDown: true } }))).toEqual({ kind: 'never', why: 'shutting-down' });
  });

  it('waits 2 minutes after the window starts before its first attempt', () => {
    expect(automaticCheck(input({ now: T0 }))).toEqual({ kind: 'later', at: T0 + 2 * MINUTE, why: 'window-start' });
    expect(automaticCheck(input({ now: T0 + 2 * MINUTE - 1 }))).toEqual({ kind: 'later', at: T0 + 2 * MINUTE, why: 'window-start' });
    expect(automaticCheck(input({ now: T0 + 2 * MINUTE }))).toEqual({ kind: 'due' });
    expect(UPDATE_SCHEDULE.firstCheckDelayMs).toBe(2 * MINUTE);
  });

  it('attempts at most once per 24 hours, counted from the last attempt any window recorded', () => {
    const last = T0 - 23 * HOUR;
    expect(automaticCheck(input({ schedule: { lastAttemptAt: iso(last) } }))).toEqual({ kind: 'later', at: last + 24 * HOUR, why: 'daily' });
    expect(automaticCheck(input({ now: last + 24 * HOUR, schedule: { lastAttemptAt: iso(last) } }))).toEqual({ kind: 'due' });
    // Long ago: the 2-minute start rule still holds.
    expect(automaticCheck(input({ now: T0 + MINUTE, schedule: { lastAttemptAt: iso(T0 - 72 * HOUR) } }))).toEqual({ kind: 'later', at: T0 + 2 * MINUTE, why: 'window-start' });
  });

  // An extension update that adds entries is a new window start: its check finds the entry, within the same rule.
  it('lets an extension update that adds entries attempt only within the 24-hour rule', () => {
    const recent = T0 - HOUR;
    expect(automaticCheck(input({ targetEntryId: 'e165-new', schedule: { lastAttemptAt: iso(recent) } }))).toEqual({ kind: 'later', at: recent + 24 * HOUR, why: 'daily' });
    expect(automaticCheck(input({ targetEntryId: 'e165-new', schedule: { lastAttemptAt: iso(T0 - 25 * HOUR) } }))).toEqual({ kind: 'due' });
  });

  it('never postpones by more than one interval from now when the clock was set back', () => {
    const future = T0 + 30 * 24 * HOUR;
    const now = T0 + 2 * MINUTE;
    expect(automaticCheck(input({ now, schedule: { lastAttemptAt: iso(future) } }))).toEqual({ kind: 'later', at: now + 24 * HOUR, why: 'daily' });
  });

  // The schedule is an instance fact: a lost or unreadable record can only cause an extra attempt.
  it('treats an unreadable time as no record, which can only cause an extra attempt', () => {
    expect(automaticCheck(input({ schedule: { lastAttemptAt: 'not a time' } }))).toEqual({ kind: 'due' });
  });

  it('retries a passing cause at its retry time, before the 24 hours are over', () => {
    const failedAt = T0 - 30 * MINUTE;
    const schedule = { lastAttemptAt: iso(failedAt), failure: { class: 'network' as const, entryId: 'e164', at: iso(failedAt), attempts: 1, retryAt: iso(failedAt + HOUR), detail: 'x' } };
    expect(automaticCheck(input({ schedule }))).toEqual({ kind: 'later', at: failedAt + HOUR, why: 'retry' });
    expect(automaticCheck(input({ now: failedAt + HOUR, schedule }))).toEqual({ kind: 'due' });
  });

  it('never attempts again automatically an entry whose failure has no retry left, or is never retried', () => {
    const failedAt = T0 - 48 * HOUR;
    for (const failureClass of ['integrity', 'signature', 'host-not-allowed', 'store-full', 'file', 'network'] as ScheduleFailureClass[]) {
      const schedule = { lastAttemptAt: iso(failedAt), failure: { class: failureClass, entryId: 'e164', at: iso(failedAt), attempts: 3, detail: 'x' } };
      expect(automaticCheck(input({ now: T0 + 72 * HOUR, schedule }))).toEqual({ kind: 'never', why: 'not-retried' });
    }
  });

  it('lets a failure of another entry fall back to the 24-hour rule', () => {
    const failedAt = T0 - 25 * HOUR;
    const schedule = { lastAttemptAt: iso(failedAt), failure: { class: 'integrity' as const, entryId: 'e164', at: iso(failedAt), attempts: 1, detail: 'x' } };
    expect(automaticCheck(input({ targetEntryId: 'e165', schedule }))).toEqual({ kind: 'due' });
  });
});

describe('the retry rule by class', () => {
  it('retries network, timeout and signature-unavailable at +1 h and then +6 h, and then stops', () => {
    expect([...RETRIED_FAILURE_CLASSES].sort()).toEqual(['network', 'signature-unavailable', 'timeout']);
    for (const failureClass of ['network', 'timeout', 'signature-unavailable'] as ScheduleFailureClass[]) {
      expect(retryTime(failureClass, 1, T0)).toBe(T0 + HOUR);
      expect(retryTime(failureClass, 2, T0)).toBe(T0 + 6 * HOUR);
      expect(retryTime(failureClass, 3, T0)).toBeUndefined();
    }
  });

  it('never retries integrity, signature, host-not-allowed, store-full or file', () => {
    for (const failureClass of ['integrity', 'signature', 'host-not-allowed', 'store-full', 'file'] as ScheduleFailureClass[]) {
      expect(retryTime(failureClass, 1, T0)).toBeUndefined();
      expect(recordFailure({}, { class: failureClass, entryId: 'e', at: T0, detail: 'x' }).failure).toEqual({ class: failureClass, entryId: 'e', at: iso(T0), attempts: 1, detail: 'x' });
    }
  });

  it('counts consecutive failures of one entry, and starts again for another entry', () => {
    const first = recordFailure({ lastAttemptAt: iso(T0) }, { class: 'network', entryId: 'e', at: T0, detail: 'a' });
    expect(first).toEqual({ lastAttemptAt: iso(T0), failure: { class: 'network', entryId: 'e', at: iso(T0), attempts: 1, retryAt: iso(T0 + HOUR), detail: 'a' } });
    const second = recordFailure(first, { class: 'timeout', entryId: 'e', at: T0 + HOUR, detail: 'b' });
    expect(second.failure).toMatchObject({ attempts: 2, retryAt: iso(T0 + 7 * HOUR) });
    const third = recordFailure(second, { class: 'network', entryId: 'e', at: T0 + 7 * HOUR, detail: 'c' });
    expect(third.failure).toMatchObject({ attempts: 3 });
    expect(third.failure?.retryAt).toBeUndefined();
    expect(recordFailure(third, { class: 'network', entryId: 'other', at: T0, detail: 'd' }).failure).toMatchObject({ entryId: 'other', attempts: 1, retryAt: iso(T0 + HOUR) });
  });

  it('bounds the recorded detail', () => {
    expect(recordFailure({}, { class: 'file', entryId: 'e', at: T0, detail: 'x'.repeat(1000) }).failure?.detail).toHaveLength(300);
  });

  it('records an attempt, and clears only the succeeding entry\'s failure', () => {
    expect(recordAttempt({}, T0)).toEqual({ lastAttemptAt: iso(T0) });
    const failed = recordFailure({}, { class: 'network', entryId: 'e', at: T0, detail: 'x' });
    expect(recordSuccess(failed, 'e')).toEqual({});
    expect(recordSuccess(failed, 'other')).toBe(failed);
  });
});

describe('manualCheck (Update now)', () => {
  it('runs at once, without automatic mode, but needs an enrolment and a trusted window that is not shutting down', () => {
    expect(manualCheck({ window: { trusted: true, shuttingDown: false }, enrolled: true })).toEqual({ kind: 'due' });
    expect(manualCheck({ window: { trusted: true, shuttingDown: false }, enrolled: false })).toEqual({ kind: 'never', why: 'not-enrolled' });
    expect(manualCheck({ window: { trusted: false, shuttingDown: false }, enrolled: true })).toEqual({ kind: 'never', why: 'untrusted' });
    expect(manualCheck({ window: { trusted: true, shuttingDown: true }, enrolled: true })).toEqual({ kind: 'never', why: 'shutting-down' });
  });
});
