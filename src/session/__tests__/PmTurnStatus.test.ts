import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoordinatorTaskStatus } from '../../backend/TeamTools';
import type { DelegationResultProjection } from '../../backend/DelegationResultProjection';
import { classifyPmTasks, pmStatusRelevant, pmTaskKind } from '../PmTurnStatus';
import { CONTINUE_REPORT, CONTINUE_REWORK, PM_REPORTS_HERE, pmLiveRelevant, pmLiveStrip, samePmLiveStrip, type PmLiveFacts } from '../PmLiveStrip';
import { connectPmLive, PM_LIVE_REFRESH_MS, PM_LIVE_SESSION_EVENTS, PM_REPLIED_AT_KEY, pmLivePublisher, pmReplyStore } from '../../host/pmLiveView';

// v0.9.102 (the Owner's decision): replies carry no PM status; one live strip
// above the message box says what the PM's team is doing now. One test per line, and Codex's design review findings:
// a finished result stays owed until a final reply, queued is not reviewing, rework not running and unreadable records
// are said, and an access line never states more access than the need.
const REPLIED = '2026-11-12T10:00:00.000Z';
const BEFORE = '2026-11-12T09:59:00.000Z';
const AFTER = '2026-11-12T10:01:00.000Z';
const TURN_START = '2026-11-12T10:02:00.000Z';
const IN_TURN = '2026-11-12T10:03:00.000Z';

const result = (handle: string, state: DelegationResultProjection['state'], fields: Partial<DelegationResultProjection> = {}): DelegationResultProjection => ({
  handle, ref: { handle, revision: 2 }, state, execution: 'ended', wait: 'not-waiting', nextAction: 'decide', blocksComplete: true, ...fields,
});
const finished = (handle: string, deliveredAt: string | undefined, fields: Partial<DelegationResultProjection> = {}, state: DelegationResultProjection['state'] = 'ready'): CoordinatorTaskStatus => ({
  handle, requestedAgent: 'Dev', lifecycle: 'settled', result: result(handle, state, fields),
  ...(deliveredAt ? { delivery: { state: 'delivered', observedAt: deliveredAt } } : { delivery: { state: 'pending' } }),
});
const running = (handle: string, agent = 'QA', dispatchedAt = BEFORE): CoordinatorTaskStatus => ({
  handle, requestedAgent: agent, lifecycle: 'active', execution: { state: 'running' }, dispatchedAt,
});
const UNCERTAIN = finished('unc', undefined, {}, 'stop-unconfirmed');
const HUMAN = finished('hum', AFTER, { decision: { value: 'needs-human', reason: 'Which jurisdiction applies?', recordedAt: AFTER } }, 'awaiting-human');
const REWORK = finished('rwk', AFTER, { decision: { value: 'needs-rework', recordedAt: AFTER } }, 'awaiting-rework');

const facts = (fields: Partial<PmLiveFacts> = {}): PmLiveFacts => ({
  held: false, tasks: [], repliedAt: REPLIED, queued: new Set(), starting: 0, waitingForAccess: [], ...fields,
});
const lines = (fields: Partial<PmLiveFacts>) => pmLiveStrip(facts(fields))?.lines;
const OWED = { kind: 'continue', text: 'Dev finished, but the PM has not reported on it.', prompt: CONTINUE_REPORT };

describe('the PM live strip, one test per line', () => {
  it('is hidden only when there is positively nothing to show', () => {
    expect(pmLiveStrip(facts())).toBeUndefined();
    // A decided result the PM has replied about since it received it is not shown again.
    expect(pmLiveStrip(facts({ tasks: [finished('old', BEFORE, {}, 'decided')] }))).toBeUndefined();
  });

  it('says when the task records cannot be read, and invents nothing about the tasks', () => {
    expect(lines({ tasks: undefined })).toEqual([{ kind: 'unavailable', text: 'UnodeAi cannot read its task records now, so it cannot show what the team is doing.' }]);
  });

  it('Stop: says the PM does not continue, counts work still running, and makes no promise', () => {
    expect(lines({ held: true })).toEqual([{ kind: 'stopped', text: 'Stopped. The PM does not continue until you send a message.' }]);
    const shown = lines({ held: true, tasks: [running('r1')], starting: 1 })!;
    expect(shown[0]).toEqual({ kind: 'stopped', text: 'Stopped. 1 task still running; the PM does not continue until you send a message.' });
    expect(shown.map((line) => line.kind)).toEqual(['stopped', 'running', 'starting']);
  });

  it('a decision owed by the person: the task, the quoted reason and Review Delivered Work; at most two, then a count', () => {
    expect(lines({ tasks: [HUMAN] })).toEqual([{ kind: 'decision',
      text: 'Needs your decision: Dev\'s task — Which jurisdiction applies?.', review: true }]);
    // v0.9.102 (design §8): the task is named by the start of its instruction when the strip knows it.
    expect(lines({ tasks: [HUMAN], stripFacts: new Map([['hum', { label: 'Check the lease', startedHere: false, liveElsewhere: false, runOpen: true }]]) }))
      .toEqual([{ kind: 'decision', text: 'Needs your decision: Dev\'s task "Check the lease" — Which jurisdiction applies?.', review: true }]);
    const three = lines({ tasks: [HUMAN, { ...HUMAN, handle: 'h2' }, { ...HUMAN, handle: 'h3' }] })!;
    expect(three.map((line) => line.kind)).toEqual(['decision', 'decision', 'decision']);
    expect(three[2]).toEqual({ kind: 'decision', text: '1 more result also need your decision.', review: true });
  });

  it('access: each need at its own level, never more than the need; three shown, then a count', () => {
    expect(lines({ waitingForAccess: [{ label: 'Reports', path: 'D:\\Reports', access: 'read' }] })).toEqual([{ kind: 'access',
      text: 'Waiting for your access: Read for Reports (D:\\Reports). Choose Grant access on its item.' }]);
    const four = lines({ waitingForAccess: [
      { label: 'A', path: 'D:\\A', access: 'readwrite' }, { label: 'B', path: 'D:\\B', access: 'read' },
      { label: 'C', path: 'D:\\C', access: 'read' }, { label: 'D', path: 'D:\\D', access: 'read' },
    ] })!;
    expect(four[0]).toEqual({ kind: 'access',
      text: 'Waiting for your access: Read + Write for A (D:\\A); Read for B (D:\\B); Read for C (D:\\C); 1 more. Choose Grant access on its item.' });
  });

  it('running work: each task with its dispatch time, what is starting, and the promise to report', () => {
    expect(lines({ tasks: [running('r1', 'QA', BEFORE), running('r2', 'Writer', 'not a time')], starting: 2 })).toEqual([
      { kind: 'running', tasks: [{ agent: 'QA', since: BEFORE }, { agent: 'Writer' }] },
      { kind: 'starting', text: 'Starting: 2 tasks.' },
      { kind: 'promise', text: PM_REPORTS_HERE },
    ]);
    expect(lines({ starting: 1 })).toEqual([{ kind: 'starting', text: 'Starting: 1 task.' }, { kind: 'promise', text: PM_REPORTS_HERE }]);
  });

  it('a finished result the PM received after its last reply is owed, decided or not, with Continue while the PM is idle', () => {
    expect(lines({ tasks: [finished('f1', AFTER)] })).toEqual([OWED]);
    // A recorded decision is not a report.
    expect(lines({ tasks: [finished('f1', AFTER, { decision: { value: 'accepted', recordedAt: AFTER } }, 'decided')] })).toEqual([OWED]);
    // Under Stop it is still owed, beside the Stop line.
    expect(lines({ held: true, tasks: [finished('f1', AFTER)] })).toEqual([
      { kind: 'stopped', text: 'Stopped. The PM does not continue until you send a message.' }, OWED]);
    // A result settled and never placed into a PM turn, with no wake, is owed too.
    expect(lines({ tasks: [finished('f1', undefined)] })).toEqual([OWED]);
  });

  it('while the PM is in a turn: a result placed into that turn is being reviewed; an earlier one is not promised', () => {
    const turn = { startedAt: TURN_START };
    expect(lines({ turn, tasks: [finished('f1', IN_TURN)] })).toEqual([{ kind: 'finished', text: 'Dev finished. The PM is reviewing it now.' }]);
    expect(lines({ turn, tasks: [finished('f1', AFTER)] })).toEqual([{ kind: 'finished', text: 'Dev finished. The PM has not reported on it yet.' }]);
  });

  it('a queued result: about to be reviewed when the PM is idle, waits behind a busy turn, and is owed under Stop', () => {
    const queued = new Set(['f1']);
    expect(lines({ queued, tasks: [finished('f1', undefined)] })).toEqual([{ kind: 'finished', text: 'Dev finished. The PM is about to review it.' }]);
    expect(lines({ queued, turn: { startedAt: TURN_START }, tasks: [finished('f1', undefined)] })).toEqual([
      { kind: 'finished', text: 'Dev finished. The PM gets the result when its current turn ends.' }]);
    expect(lines({ queued, held: true, tasks: [finished('f1', undefined)] })!.at(-1)).toEqual(OWED);
  });

  it('a scheduled automatic review is said only while the PM is idle and not held', () => {
    const scheduled = finished('f1', AFTER, { reviewContinuation: 'scheduled' }, 'awaiting-decision');
    expect(lines({ tasks: [scheduled] })).toEqual([{ kind: 'finished', text: 'Dev finished. The PM gets one automatic turn to review it.' }]);
    // Replied about since, and still scheduled: the automatic turn is still said.
    expect(lines({ tasks: [{ ...scheduled, delivery: { state: 'delivered', observedAt: BEFORE } }] })).toEqual([
      { kind: 'finished', text: 'Dev finished. The PM gets one automatic turn to review it.' }]);
    expect(lines({ held: true, tasks: [scheduled] })!.at(-1)).toEqual(OWED);
    // Consumed: no further automatic turn is promised.
    expect(lines({ tasks: [{ ...scheduled, result: { ...scheduled.result!, reviewContinuation: 'consumed' } }] })).toEqual([OWED]);
  });

  it('a result Stop suspended is owed, unless the PM replied after it was placed into a turn', () => {
    const scope = { cause: 'coordinator-stopped' as const, state: 'suspended' as const, recordedAt: AFTER, by: 'host-lifecycle' as const };
    // Its run open (stopped) or closed with the stopped turn (historical): the suspension is what counts.
    const suspended = (deliveredAt: string | undefined, state: 'stopped' | 'historical' = 'historical') =>
      finished('s1', deliveredAt, { nextAction: 'resume', blocksComplete: false, scope }, state);
    expect(lines({ tasks: [suspended(AFTER, 'stopped')] })).toEqual([OWED]);
    // v0.9.102 (design §3 B): resumed by the person's message after its request closed: the report is still owed until
    // the PM's final reply, and a reply after it was placed into a turn clears it.
    const resumed = (deliveredAt: string) => finished('s1', deliveredAt, { nextAction: 'none', blocksComplete: false,
      scope: { ...scope, state: 'reopened', cause: 'explicit-resume' } }, 'historical');
    expect(lines({ tasks: [resumed(AFTER)] })).toEqual([OWED]);
    expect(lines({ turn: { startedAt: TURN_START }, tasks: [resumed(AFTER)] })).toEqual([{ kind: 'finished', text: 'Dev finished. The PM has not reported on it yet.' }]);
    expect(pmLiveRelevant(REPLIED)(resumed(AFTER))).toBe(true);
    expect(pmLiveRelevant(REPLIED)(resumed(BEFORE))).toBe(false);
    expect(lines({ held: true, tasks: [suspended(AFTER)] })).toEqual([
      { kind: 'stopped', text: 'Stopped. The PM does not continue until you send a message.' }, OWED]);
    expect(lines({ tasks: [suspended(undefined)] })).toEqual([OWED]);
    expect(pmLiveRelevant(REPLIED)(suspended(AFTER))).toBe(true);
    expect(pmLiveRelevant(REPLIED)(suspended(undefined))).toBe(true);
    expect(pmLiveRelevant(REPLIED)(suspended(BEFORE))).toBe(false);
    expect(pmTaskKind(suspended(AFTER))).toBe('suspended');
  });

  it('rework requested and not running is said, with Continue while the PM is idle', () => {
    expect(lines({ tasks: [REWORK] })).toEqual([{ kind: 'continue', text: 'Rework requested from Dev, but none is running.', prompt: CONTINUE_REWORK, button: 'Continue rework' }]);
    expect(lines({ turn: { startedAt: TURN_START }, tasks: [REWORK] })).toEqual([{ kind: 'finished', text: 'Rework requested from Dev, but none is running.' }]);
  });

  it('a task whose state is not known is named with what clears it, never shown as running or finished', () => {
    expect(lines({ tasks: [UNCERTAIN] })).toEqual([{ kind: 'reminder',
      text: 'Reminder: Dev\'s task: UnodeAi cannot confirm whether it is still running. To clear this, press Ask the PM, then Send: '
        + 'the PM inspects it and stops it if it should not continue.',
      prompt: 'Please look at Dev\'s task (handle unc): UnodeAi cannot confirm whether it is still running. Inspect it with '
        + 'inspect_task_status; if it should not continue, stop it with cancel_task. Record a decision only after its end is observed.' }]);
  });

  // Field, 2026-11-12: an older task had ended; only its saved result was unavailable. The strip said the teammate might
  // still be running. v0.9.102 (design §5): a missing result whose execution ended is said from its facts only, with
  // what clears it; real execution doubt stays doubt.
  it('a result that cannot be used, after its work ended, says what is known and what clears it, never "running"', () => {
    const at = '2026-11-10T08:28:04.444Z';
    const local = (() => { const d = new Date(at); const two = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; })();
    const missing: CoordinatorTaskStatus = { ...finished('old', undefined, { recovery: 'body-unavailable', delivery: 'pending' }, 'unknown'), terminalAt: at };
    expect(lines({ tasks: [missing] })).toEqual([{ kind: 'reminder',
      text: `Reminder: Dev's task (finished ${local}): its saved result text is not available in this window, and it has not been `
        + 'handed to the PM yet. To clear this, press Ask the PM, then Send: the PM inspects it and records what to do with it.',
      prompt: `Please look at Dev's task (handle old, finished ${local}): its saved result text is not available in this window, `
        + 'and it has not been handed to the PM yet. Inspect it with inspect_task_status. If the work is still needed, redo it '
        + '(dispatch_task, then record_task_disposition superseded with the new handle, or needs-rework for the same teammate); '
        + 'if it is not, record rejected or deferred with your reason.' }]);
    // Each fact in its own words; none says "still running", "never" or "can no longer".
    for (const [fields, words] of [
      [{ recovery: 'delivery-unknown', delivery: 'pending' }, 'UnodeAi cannot tell whether the PM received it'],
      [{ recovery: 'decision-scope-unknown', delivery: 'pending' }, 'UnodeAi cannot tell which decision applies to it'],
      [{ conflict: true, delivery: 'delivered' }, 'UnodeAi cannot tell which decision applies to it'],
    ] as const) {
      const text = lines({ tasks: [finished('r', undefined, fields, 'unknown')] })!.map((line) => ('text' in line ? line.text : '')).join(' ');
      expect(text).toBe(`Reminder: Dev's task: ${words}. To clear this, press Ask the PM, then Send: the PM inspects it and records what to do with it.`);
      expect(text).not.toMatch(/running|never|can no longer/);
    }
  });

  it('a result recovery while the execution is not known to have ended is still doubt about running, and other work stays', () => {
    for (const execution of ['unknown', 'stop-unconfirmed', 'running'] as const) {
      const doubt = finished('d', undefined, { recovery: 'body-unavailable', execution }, 'unknown');
      expect(lines({ tasks: [doubt] })![0]).toMatchObject({ kind: 'reminder', text: expect.stringContaining('UnodeAi cannot confirm whether it is still running') });
    }
    // An ended task's missing result does not hide another task of the same teammate that is running.
    const missing = finished('old', undefined, { recovery: 'body-unavailable' }, 'unknown');
    const shown = lines({ tasks: [missing, running('now', 'Dev')] })!;
    expect(shown[0]).toEqual({ kind: 'running', tasks: [{ agent: 'Dev', since: BEFORE }] });
    expect(shown.filter((line) => line.kind === 'reminder')).toHaveLength(1);
    expect(shown.map((line) => ('text' in line ? line.text : '')).join(' ')).not.toContain('cannot confirm');
  });

  it('names a task by its teammate\'s name, or by the name the PM asked for when the teammate has none', () => {
    const byId = { ...running('r1', 'dev'), agentId: 'agent-7' };
    expect(lines({ tasks: [byId], agentNames: new Map([['agent-7', 'Developer']]) })![0]).toEqual({ kind: 'running', tasks: [{ agent: 'Developer', since: BEFORE }] });
    expect(lines({ tasks: [byId] })![0]).toEqual({ kind: 'running', tasks: [{ agent: 'dev', since: BEFORE }] });
  });

  it('names each agent once, in order, and keeps one fixed order of lines', () => {
    const shown = lines({
      held: false,
      tasks: [UNCERTAIN, REWORK, finished('f1', AFTER), { ...finished('f2', AFTER), requestedAgent: 'Writer' }, running('r1'), HUMAN],
      waitingForAccess: [{ label: 'A', path: 'D:\\A', access: 'read' }],
    })!;
    expect(shown.map((line) => line.kind)).toEqual(['decision', 'access', 'running', 'promise', 'continue', 'continue', 'reminder']);
    expect(shown[4]).toEqual({ kind: 'continue', text: 'Dev and Writer finished, but the PM has not reported on them.', prompt: CONTINUE_REPORT });
  });
});

describe('what the strip reads', () => {
  it('reads running, uncertain and owed records, and every result still owed a report, decided or not', () => {
    const keep = pmLiveRelevant(REPLIED);
    expect(keep(running('r'))).toBe(true);
    expect(keep(UNCERTAIN)).toBe(true);
    expect(keep(finished('d', AFTER, {}, 'decided'))).toBe(true);
    expect(keep(finished('d', REPLIED, {}, 'decided'))).toBe(true);
    expect(keep(finished('d', BEFORE, {}, 'decided'))).toBe(false);
    expect(keep(finished('d', AFTER, { recovery: 'delivery-unknown' }, 'decided'))).toBe(false);
    expect(keep(finished('h', AFTER, {}, 'historical'))).toBe(false);
    expect(keep({ handle: 'c', lifecycle: 'cancelled' })).toBe(false);
  });

  it('reads running, uncertain and owed records, and leaves decided, historical and cancelled ones out', () => {
    expect(pmStatusRelevant(running('r'))).toBe(true);
    expect(pmStatusRelevant(UNCERTAIN)).toBe(true);
    expect(pmStatusRelevant(REWORK)).toBe(true);
    expect(pmStatusRelevant(finished('d', AFTER, {}, 'decided'))).toBe(false);
    expect(pmStatusRelevant(finished('h', AFTER, {}, 'historical'))).toBe(false);
    expect(pmStatusRelevant({ handle: 'c', lifecycle: 'cancelled' })).toBe(false);
    expect(pmStatusRelevant({ handle: 'l', lifecycle: 'settled', disposition: { value: 'accepted' } })).toBe(false);
  });

  it('sorts each record into one kind: unknown execution and unsettled recovery are uncertain', () => {
    expect(pmTaskKind(running('r'))).toBe('running');
    expect(pmTaskKind({ ...running('r'), execution: { state: 'unknown' } })).toBe('uncertain');
    expect(pmTaskKind({ handle: 't', lifecycle: 'timed-out', recordedState: 'active' })).toBe('running');
    expect(pmTaskKind(finished('f', AFTER, { recovery: 'body-unavailable' }))).toBe('uncertain');
    expect(pmTaskKind({ handle: 'l', lifecycle: 'settled' })).toBe('undisposed');
    expect(pmTaskKind(finished('f', AFTER, {}, 'decided'))).toBe('decided');
    expect(classifyPmTasks([HUMAN, REWORK, running('r')])).toMatchObject({
      human: [{ handle: 'hum', reason: 'Which jurisdiction applies?' }], awaitingRework: [{ handle: 'rwk' }], running: [{ handle: 'r' }],
    });
  });

  it('compares two strips by what they say', () => {
    expect(samePmLiveStrip(undefined, undefined)).toBe(true);
    expect(samePmLiveStrip(pmLiveStrip(facts({ starting: 1 })), pmLiveStrip(facts({ starting: 1 })))).toBe(true);
    expect(samePmLiveStrip(pmLiveStrip(facts({ starting: 1 })), pmLiveStrip(facts({ starting: 2 })))).toBe(false);
  });
});

describe('the PM reply store and the strip publisher', () => {
  afterEach(() => { vi.useRealTimers(); });

  const memento = (initial?: unknown) => {
    const data = new Map<string, unknown>(initial === undefined ? [] : [[PM_REPLIED_AT_KEY, initial]]);
    return { data, get: <T>(key: string) => data.get(key) as T | undefined, update: async (key: string, value: unknown) => { data.set(key, value); } };
  };

  it('keeps the latest final reply per PM across reloads; before any, the first use, so older results are never owed', () => {
    const store = memento();
    const first = pmReplyStore(store, () => REPLIED);
    expect(first.get('pm')).toBe(REPLIED);
    first.record('pm', AFTER);
    first.record('pm', BEFORE);
    expect(first.get('pm')).toBe(AFTER);
    const reloaded = pmReplyStore(store, () => IN_TURN);
    expect(reloaded.get('pm')).toBe(AFTER);
    expect(reloaded.get('other')).toBe(REPLIED);
    // A malformed saved value is dropped, never read as a time.
    expect(pmReplyStore(memento({ pm: 'yesterday', '*': REPLIED })).get('pm')).toBe(REPLIED);
  });

  it('publishes every PM in one read per burst, leaves out a PM it cannot read, and reads again while something shows', () => {
    vi.useFakeTimers();
    const published: Array<ReadonlyMap<string, unknown>> = [];
    let starting = 1;
    const publisher = pmLivePublisher({
      coordinatorIds: () => ['pm', 'broken', 'worker'],
      facts: (id) => {
        if (id === 'broken') throw new Error('no records');
        return id === 'worker' ? undefined : { held: false, tasks: [], repliedAt: REPLIED, queued: new Set<string>(), starting };
      },
      waitingForAccess: () => [],
      publish: (strips) => { published.push(strips); },
    });
    publisher.schedule();
    publisher.schedule();
    vi.advanceTimersByTime(0);
    expect(published).toHaveLength(1);
    expect([...published[0].keys()]).toEqual(['pm']);
    // Nothing reported the change; the refresh still shows it.
    starting = 0;
    vi.advanceTimersByTime(PM_LIVE_REFRESH_MS);
    // The refresh's own read is a 0 ms timer created at the end of that advance: fake timers run it on the next tick.
    vi.advanceTimersByTime(1);
    expect(published).toHaveLength(2);
    expect(published[1].size).toBe(0);
    // Nothing shows: no further refresh.
    vi.advanceTimersByTime(PM_LIVE_REFRESH_MS * 3);
    expect(published).toHaveLength(2);
    publisher.dispose();
    publisher.schedule();
    vi.advanceTimersByTime(0);
    expect(published).toHaveLength(2);
  });

  it('connects the strip to every source of change: the task records, the access table and each session event; dispose ends them', () => {
    vi.useFakeTimers();
    const listeners = { ledger: new Set<() => void>(), table: new Set<() => void>(), session: new Map<string, Set<() => void>>() };
    let starting = 0;
    const published: number[] = [];
    const live = connectPmLive({
      sessionManager: {
        coordinatorIds: () => ['pm'],
        coordinatorLiveFacts: () => ({ held: false, tasks: [], repliedAt: REPLIED, queued: new Set<string>(), starting }),
        on: (event, listener) => { const set = listeners.session.get(event) ?? new Set(); set.add(listener); listeners.session.set(event, set); },
        off: (event, listener) => { listeners.session.get(event)?.delete(listener); },
      },
      accessTable: {
        waitingNeedsOf: () => [],
        onChange: (listener) => { listeners.table.add(listener); return () => { listeners.table.delete(listener); }; },
      },
      runLedger: { onDidChange: (listener) => { listeners.ledger.add(listener); return () => { listeners.ledger.delete(listener); }; } },
      publish: (strips) => { published.push(strips.get('pm')?.lines.length ?? 0); },
    });
    vi.advanceTimersByTime(1);
    expect(published).toEqual([0]);
    const fire = (set: Set<() => void> | undefined) => { for (const listener of set ?? []) listener(); vi.advanceTimersByTime(1); };
    starting = 1;
    fire(listeners.ledger);
    expect(published).toEqual([0, 2]);
    starting = 0;
    fire(listeners.table);
    expect(published).toEqual([0, 2, 0]);
    for (const event of PM_LIVE_SESSION_EVENTS) {
      starting = starting ? 0 : 1;
      fire(listeners.session.get(event));
    }
    expect(published).toHaveLength(3 + PM_LIVE_SESSION_EVENTS.length);
    expect(PM_LIVE_SESSION_EVENTS).toEqual(['session.created', 'session.status', 'session.turnEnded', 'session.stopped', 'session.removed']);
    live.dispose();
    expect(listeners.ledger.size + listeners.table.size + [...listeners.session.values()].reduce((n, set) => n + set.size, 0)).toBe(0);
  });
});
