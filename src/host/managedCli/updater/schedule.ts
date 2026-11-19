/*---------------------------------------------------------------------------------------------
 *  UnodeAi - when the managed Codex updater may download (v0.9.97)
 *  Before enrolment there is no updater traffic at all. With automatic mode on, a download is attempted at most once
 *  per 24 hours per provider across all windows: the attempt's time is the instance's `schedule.lastAttemptAt`, which
 *  every window reads. The first attempt of a window comes 2 minutes after the window started, and only in a trusted
 *  window that is not shutting down, so it never competes with the user's first turn. An extension update that adds
 *  entries reaches the user the same way: its window's first check finds the new entry, within the same 24-hour rule.
 *
 *  Choosing what to download is a local lookup in the bundled policy (`installable.ts`) and sends nothing; only a
 *  download task is traffic, so only a task's start is recorded as an attempt.
 *
 *  A failed attempt is retried automatically only for a passing cause: `network`, `timeout` and
 *  `signature-unavailable` get up to 2 retries, 1 hour after the first failure and 6 hours after the second, and then
 *  stop. Unexpected bytes (`integrity`), a definite signature failure (`signature`), a download host outside the
 *  consent (`host-not-allowed`), a full store (`store-full`) and a file-system failure (`file`) are never retried
 *  automatically. A version that is downloaded and checked and waits for the user's click is never downloaded again
 *  (the target lookup skips it). The user's **Update now** tries at once, whatever this file says, but still needs a
 *  valid enrolment and the consent of every host it uses.
 *
 *  The schedule is an instance fact, so it may be lost: a lost or unreadable record can only cause one extra attempt
 *  (an attempt it would have waited for, or one retry of a cause that is never retried), never a download that the
 *  enrolment and the consented hosts do not allow. Pure: the caller passes the time.
 *--------------------------------------------------------------------------------------------*/

import type { InstanceContent, ScheduleFailureClass } from '../contracts';

export type UpdateSchedule = InstanceContent['schedule'];
export type ScheduleFailure = NonNullable<UpdateSchedule['failure']>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const UPDATE_SCHEDULE = Object.freeze({
  /** After the window starts, before its first automatic attempt. */
  firstCheckDelayMs: 2 * MINUTE,
  /** Between two automatic attempts, across windows. */
  attemptIntervalMs: 24 * HOUR,
  /** The automatic retries of a passing cause, each counted from the failure before it. */
  retryDelaysMs: Object.freeze([1 * HOUR, 6 * HOUR]),
});

/** The causes that may pass by themselves; every other class waits for the user. */
export const RETRIED_FAILURE_CLASSES: ReadonlySet<ScheduleFailureClass> = new Set(['network', 'timeout', 'signature-unavailable']);

/** The window an automatic attempt would run in. */
export interface ScheduleWindow {
  /** When this window's updater started, in milliseconds. */
  startedAt: number;
  /** Trusted, with a current workspace binding. */
  trusted: boolean;
  shuttingDown: boolean;
}

export interface AutomaticCheckInput {
  now: number;
  window: ScheduleWindow;
  /** Control names an enrolled instance. */
  enrolled: boolean;
  autoMode: boolean;
  schedule: UpdateSchedule;
  /** The policy entry the target lookup chose. */
  targetEntryId: string;
}

export type AutomaticCheck =
  | { kind: 'due' }
  | { kind: 'later'; at: number; why: 'window-start' | 'daily' | 'retry' }
  | { kind: 'never'; why: 'not-enrolled' | 'auto-off' | 'untrusted' | 'shutting-down' | 'not-retried' };

/** A time the record holds, or undefined when it cannot be read (which can only cause an extra attempt). */
function timeOf(value: string | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

/** Whether an automatic download of `targetEntryId` may start now, later, or not at all. */
export function automaticCheck(input: AutomaticCheckInput): AutomaticCheck {
  if (!input.enrolled) return { kind: 'never', why: 'not-enrolled' };
  if (!input.autoMode) return { kind: 'never', why: 'auto-off' };
  if (input.window.shuttingDown) return { kind: 'never', why: 'shutting-down' };
  if (!input.window.trusted) return { kind: 'never', why: 'untrusted' };
  const earliest = input.window.startedAt + UPDATE_SCHEDULE.firstCheckDelayMs;
  const at = (time: number, why: 'window-start' | 'daily' | 'retry'): AutomaticCheck => {
    const when = Math.max(earliest, time);
    if (when <= input.now) return { kind: 'due' };
    return { kind: 'later', at: when, why: earliest > time ? 'window-start' : why };
  };

  const failure = input.schedule.failure;
  if (failure && failure.entryId === input.targetEntryId) {
    const retryAt = timeOf(failure.retryAt);
    // A failure of this entry with no retry left, or of a class never retried, waits for the user's Update now.
    if (retryAt === undefined) {
      if (failure.retryAt === undefined) return { kind: 'never', why: 'not-retried' };
    } else {
      return at(retryAt, 'retry');
    }
  }
  const last = timeOf(input.schedule.lastAttemptAt);
  if (last === undefined) return at(earliest, 'window-start');
  // A clock set back never postpones the next attempt by more than one interval from now.
  return at(Math.min(last, input.now) + UPDATE_SCHEDULE.attemptIntervalMs, 'daily');
}

export interface ManualCheckInput {
  window: Pick<ScheduleWindow, 'trusted' | 'shuttingDown'>;
  enrolled: boolean;
}

/** The user's Update now: at once, in a trusted window that is not shutting down, with an enrolment. */
export function manualCheck(input: ManualCheckInput): { kind: 'due' } | { kind: 'never'; why: 'not-enrolled' | 'untrusted' | 'shutting-down' } {
  if (!input.enrolled) return { kind: 'never', why: 'not-enrolled' };
  if (input.window.shuttingDown) return { kind: 'never', why: 'shutting-down' };
  if (!input.window.trusted) return { kind: 'never', why: 'untrusted' };
  return { kind: 'due' };
}

/** When the automatic retry after this failure is due, or undefined when there is none. */
export function retryTime(failureClass: ScheduleFailureClass, attempts: number, failedAt: number): number | undefined {
  if (!RETRIED_FAILURE_CLASSES.has(failureClass)) return undefined;
  const delay = UPDATE_SCHEDULE.retryDelaysMs[attempts - 1];
  return delay === undefined ? undefined : failedAt + delay;
}

/** The schedule after a task started its download: the attempt every window counts the 24 hours from. */
export function recordAttempt(schedule: UpdateSchedule, at: number): UpdateSchedule {
  return { ...schedule, lastAttemptAt: new Date(at).toISOString() };
}

/** The schedule after a failed task: consecutive failures of one entry are counted together. */
export function recordFailure(
  schedule: UpdateSchedule,
  failure: { class: ScheduleFailureClass; entryId: string; at: number; detail: string },
): UpdateSchedule {
  const previous = schedule.failure;
  const attempts = previous && previous.entryId === failure.entryId && Number.isSafeInteger(previous.attempts) && previous.attempts > 0
    ? previous.attempts + 1
    : 1;
  const retryAt = retryTime(failure.class, attempts, failure.at);
  return {
    ...schedule,
    failure: {
      class: failure.class,
      entryId: failure.entryId,
      at: new Date(failure.at).toISOString(),
      attempts,
      ...(retryAt !== undefined ? { retryAt: new Date(retryAt).toISOString() } : {}),
      detail: failure.detail.slice(0, 300),
    },
  };
}

/** The schedule after a task promoted its entry, or found it promoted: that entry's failure is over. */
export function recordSuccess(schedule: UpdateSchedule, entryId: string): UpdateSchedule {
  if (!schedule.failure || schedule.failure.entryId !== entryId) return schedule;
  const { failure: _done, ...rest } = schedule;
  return rest;
}
