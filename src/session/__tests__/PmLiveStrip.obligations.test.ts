import { describe, expect, it } from 'vitest';
import type { CoordinatorTaskStatus } from '../../backend/TeamTools';
import type { DelegationResultProjection } from '../../backend/DelegationResultProjection';
import type { PmStripTaskFacts } from '../../observability/RunLedger';
import { pmLiveRelevant, pmLiveReminderLines, pmLiveStrip, pmStripItem, PM_REPORTS_HERE, type PmLiveFacts, type PmLiveLine } from '../PmLiveStrip';

/*
 * v0.9.102 (the Owner, 2026-11-13: every leftover item can be resolved; design draft 5 §3–§8, Codex design PASS): each
 * reachable projection class and the overlaps that matter map to live status or to an obligation with its valid action,
 * worded from its facts only. The actions themselves are proven to close their items through the production tool in
 * PmStripObligations.flows.test.ts.
 */

const REPLIED = '2026-11-12T10:00:00.000Z';
const AFTER = '2026-11-12T10:01:00.000Z';
const FINISHED_AT = '2026-11-10T08:28:04.444Z';
const local = (iso: string) => { const d = new Date(iso); const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };

const HERE: PmStripTaskFacts = { startedHere: true, liveElsewhere: false, runOpen: true };
const NOT_HERE: PmStripTaskFacts = { startedHere: false, liveElsewhere: false, runOpen: true };
const ELSEWHERE: PmStripTaskFacts = { startedHere: false, liveElsewhere: true, runOpen: true };

function result(state: DelegationResultProjection['state'], fields: Partial<DelegationResultProjection> = {}): DelegationResultProjection {
  return { handle: 'h', ref: { handle: 'h', revision: 1 }, state, execution: 'ended', wait: 'not-waiting', nextAction: 'decide',
    blocksComplete: true, delivery: 'pending', ...fields };
}
const settled = (projection: DelegationResultProjection, fields: Partial<CoordinatorTaskStatus> = {}): CoordinatorTaskStatus => ({
  handle: 'h', requestedAgent: 'Contract Analyst', lifecycle: 'settled', recordedState: 'settled', terminalAt: FINISHED_AT,
  delivery: { state: 'pending' }, result: projection, ...fields });
const active = (fields: Partial<CoordinatorTaskStatus> = {}): CoordinatorTaskStatus => ({
  handle: 'h', requestedAgent: 'Contract Analyst', lifecycle: 'active', recordedState: 'active', dispatchedAt: AFTER, ...fields });
const interrupted = (reason: 'host-restarted' | 'worker-lost', fields: Partial<CoordinatorTaskStatus> = {}): CoordinatorTaskStatus => ({
  handle: 'h', requestedAgent: 'Contract Analyst', lifecycle: 'interrupted', recordedState: 'interrupted',
  interruption: { reason, lastObservedAt: FINISHED_AT, detectedAt: FINISHED_AT }, ...fields });

const facts = (tasks: CoordinatorTaskStatus[], stripFacts?: Map<string, PmStripTaskFacts>, fields: Partial<PmLiveFacts> = {}): PmLiveFacts => ({
  held: false, tasks, repliedAt: REPLIED, queued: new Set(), starting: 0, waitingForAccess: [], ...(stripFacts ? { stripFacts } : {}), ...fields });
const lines = (tasks: CoordinatorTaskStatus[], stripFacts?: Map<string, PmStripTaskFacts>, fields: Partial<PmLiveFacts> = {}): PmLiveLine[] =>
  pmLiveStrip(facts(tasks, stripFacts, fields))?.lines ?? [];
const text = (line: PmLiveLine | undefined): string => (line && 'text' in line ? line.text : '');

describe('every reachable class is live status, one obligation with its valid action, or nothing (design §3, §9.1)', () => {
  const suspended = { state: 'suspended' as const, cause: 'coordinator-stopped' as const, recordedAt: AFTER, by: 'host-lifecycle' as const };
  const cases: Array<[string, CoordinatorTaskStatus, PmStripTaskFacts, ReturnType<typeof pmStripItem>]> = [
    ['running, started here', settled(result('running', { execution: 'running', nextAction: 'wait' }), { lifecycle: 'active', recordedState: 'active' }), HERE, { kind: 'running' }],
    ['running, another live window\'s', settled(result('running', { execution: 'running', nextAction: 'wait' }), { lifecycle: 'active', recordedState: 'active' }), ELSEWHERE, { kind: 'elsewhere' }],
    ['running, not started here and no live owner', settled(result('running', { execution: 'running', nextAction: 'wait' }), { lifecycle: 'active', recordedState: 'active' }), NOT_HERE, { kind: 'reminder', cause: 'doubt' }],
    ['stop unconfirmed', settled(result('stop-unconfirmed', { execution: 'stop-unconfirmed', nextAction: 'inspect' })), HERE, { kind: 'reminder', cause: 'doubt' }],
    ['the person\'s decision, with a recovery mark', settled(result('awaiting-human', { recovery: 'body-unavailable', nextAction: 'ask-human' })), NOT_HERE, { kind: 'human' }],
    ['rework owed, with a recovery mark', settled(result('awaiting-rework', { recovery: 'delivery-unknown', nextAction: 'rework' })), NOT_HERE, { kind: 'rework' }],
    ['ready', settled(result('ready', { nextAction: 'collect' })), NOT_HERE, { kind: 'finished' }],
    ['awaiting a decision', settled(result('awaiting-decision')), NOT_HERE, { kind: 'finished' }],
    ['failed', settled(result('failed')), NOT_HERE, { kind: 'finished' }],
    ['decided', settled(result('decided', { blocksComplete: false, nextAction: 'none' })), NOT_HERE, { kind: 'finished' }],
    ['saved text not here', settled(result('unknown', { recovery: 'body-unavailable', nextAction: 'inspect' })), NOT_HERE, { kind: 'reminder', cause: 'result' }],
    ['hand-over not known', settled(result('unknown', { recovery: 'delivery-unknown', nextAction: 'inspect' })), NOT_HERE, { kind: 'reminder', cause: 'result' }],
    ['copies conflict', settled(result('unknown', { conflict: true, nextAction: 'inspect' })), NOT_HERE, { kind: 'reminder', cause: 'unresolved' }],
    ['decision scope unknown', settled(result('unknown', { recovery: 'decision-scope-unknown', nextAction: 'inspect' })), NOT_HERE, { kind: 'reminder', cause: 'unresolved' }],
    ['unknown result of an attempt not known to have ended', settled(result('unknown', { recovery: 'body-unavailable', execution: 'unknown' })), HERE, { kind: 'reminder', cause: 'doubt' }],
    ['suspended by Stop', settled(result('stopped', { scope: suspended, nextAction: 'resume', blocksComplete: false })), NOT_HERE, { kind: 'finished' }],
    ['suspended by Stop, its run closed', settled(result('historical', { scope: suspended, nextAction: 'none', blocksComplete: false })), NOT_HERE, { kind: 'finished' }],
    ['cancelled', settled(result('cancelled', { blocksComplete: false, nextAction: 'none' })), NOT_HERE, undefined],
    ['historical', settled(result('historical', { blocksComplete: false, nextAction: 'none' })), NOT_HERE, undefined],
    ['interrupted at a reload', interrupted('host-restarted'), NOT_HERE, { kind: 'reminder', cause: 'interrupted' }],
    ['interrupted, a rework asked before', interrupted('worker-lost', { disposition: { value: 'needs-rework' } }), NOT_HERE, { kind: 'reminder', cause: 'interrupted' }],
    ['interrupted, abandoned', interrupted('host-restarted', { disposition: { value: 'abandoned' } }), NOT_HERE, undefined],
    ['interrupted, superseded', interrupted('host-restarted', { disposition: { value: 'superseded', replacementHandle: 'n' } }), NOT_HERE, undefined],
    ['interrupted, its request closed', interrupted('host-restarted'), { ...NOT_HERE, runOpen: false }, undefined],
    ['active, no result, started here', active(), HERE, { kind: 'running' }],
    ['active, no result, another window\'s', active(), ELSEWHERE, { kind: 'elsewhere' }],
    ['active, execution not known', active({ execution: { state: 'unknown' } }), HERE, { kind: 'reminder', cause: 'doubt' }],
    ['timed out, still active', active({ lifecycle: 'timed-out' }), HERE, { kind: 'running' }],
    ['settled before revisions, undecided', { handle: 'h', lifecycle: 'settled', requestedAgent: 'Contract Analyst' }, NOT_HERE, { kind: 'finished' }],
    ['settled before revisions, decided', { handle: 'h', lifecycle: 'settled', disposition: { value: 'accepted' } }, NOT_HERE, undefined],
  ];
  for (const [name, task, where, expected] of cases) {
    it(name, () => {
      expect(pmStripItem(task, where)).toEqual(expected);
      // A blocking obligation always has a line; nothing that blocks is silently left out.
      if (task.result?.blocksComplete && !['running', 'elsewhere'].includes(expected?.kind ?? '')) expect(expected).toBeDefined();
      const shown = lines([task], new Map([['h', where]]), { repliedAt: '2026-01-01T00:00:00.000Z' });
      if (expected?.kind === 'reminder') {
        expect(shown).toEqual([expect.objectContaining({ kind: 'reminder', prompt: expect.stringContaining('handle h') })]);
      }
      if (expected === undefined) expect(shown).toEqual([]);
    });
  }

  it('reads every interrupted task not ended for good, and leaves an abandoned or superseded one out', () => {
    const keep = pmLiveRelevant(REPLIED);
    expect(keep(interrupted('host-restarted'))).toBe(true);
    expect(keep(interrupted('host-restarted', { disposition: { value: 'needs-rework' } }))).toBe(true);
    expect(keep(interrupted('host-restarted', { disposition: { value: 'abandoned' } }))).toBe(false);
    expect(keep(interrupted('host-restarted', { disposition: { value: 'superseded', replacementHandle: 'n' } }))).toBe(false);
  });
});

describe('the reminder says what is known, from its facts only (design §5, D3)', () => {
  it('a result the PM received says so, with when; never that it was not received', () => {
    const task = settled(result('unknown', { recovery: 'body-unavailable', delivery: 'delivered' }), { delivery: { state: 'delivered', observedAt: AFTER, via: 'auto-wake' } });
    expect(text(lines([task])[0])).toBe(`Reminder: Contract Analyst's task (finished ${local(FINISHED_AT)}): its saved result text is not available in this `
      + `window, and the PM received it ${local(AFTER)}. To clear this, press Ask the PM, then Send: the PM inspects it and records what to do with it.`);
  });

  it('a stored "delivered" beside a hand-over UnodeAi cannot confirm says only the uncertain fact', () => {
    const task = settled(result('unknown', { recovery: 'delivery-unknown', delivery: 'delivered' }), { delivery: { state: 'delivered', observedAt: AFTER } });
    const said = text(lines([task])[0]);
    expect(said).toContain('UnodeAi cannot tell whether the PM received it.');
    expect(said).not.toContain('the PM received it ');
  });

  it('an interruption is said by its recorded reason only', () => {
    expect(text(lines([interrupted('host-restarted')])[0])).toBe(`Reminder: Contract Analyst's task (interrupted ${local(FINISHED_AT)}): it was interrupted `
      + 'when its window closed or reloaded. To clear this, press Ask the PM, then Send: the PM inspects it and records what to do with it.');
    expect(text(lines([interrupted('worker-lost')])[0])).toContain('its teammate\'s session ended before it finished.');
    expect(text(lines([interrupted('worker-lost')])[0])).not.toMatch(/window closed|reload|restart/);
  });

  it('a task another live window owns is said to be handled there, with no button', () => {
    expect(lines([active()], new Map([['h', { ...ELSEWHERE, label: 'Summarise the lease' }]])))
      .toEqual([{ kind: 'elsewhere', text: 'Contract Analyst\'s task "Summarise the lease" is being handled in another UnodeAi window.' }]);
  });

  it('a running task this window did not start and nothing else owns is not said to be running', () => {
    const said = lines([active()], new Map([['h', NOT_HERE]]));
    expect(said).toEqual([expect.objectContaining({ kind: 'reminder', text: expect.stringContaining('this window did not start it and cannot observe it') })]);
    expect(said.some((line) => line.kind === 'running')).toBe(false);
  });

  it('no clause claims what no fact establishes', () => {
    const all = [
      settled(result('unknown', { recovery: 'body-unavailable' })), settled(result('unknown', { recovery: 'delivery-unknown' })),
      settled(result('unknown', { conflict: true })), interrupted('host-restarted'), interrupted('worker-lost'),
    ].flatMap((task) => lines([task]).map(text)).join(' ');
    expect(all).not.toMatch(/never reached|can no longer|cannot be recovered|lost during a restart/);
  });
});

describe('recorded facts come first (F1), and the Owner\'s screen (design §7, §9.6)', () => {
  it('the person\'s decision, rework owed and running work started here outrank a recovery mark', () => {
    expect(lines([settled(result('awaiting-human', { recovery: 'body-unavailable', decision: { value: 'needs-human', reason: 'Which law?', recordedAt: AFTER } }))])
      .map((line) => line.kind)).toEqual(['decision']);
    expect(lines([settled(result('awaiting-rework', { recovery: 'delivery-unknown' }))]).map((line) => line.kind)).toEqual(['continue']);
    expect(lines([settled(result('running', { recovery: 'delivery-unknown', execution: 'running' }), { lifecycle: 'active', recordedState: 'active' })])
      .map((line) => line.kind)).toEqual(['running', 'promise']);
  });

  it('Running plus two older tasks of the same teammate: Running, the promise and two dated, named reminders; no undated doubt', () => {
    const now = active({ handle: 'now' });
    const older = (handle: string, label: string) => settled(result('unknown', { handle, recovery: 'body-unavailable' }), { handle });
    const shown = lines([now, older('old-1', 'a'), older('old-2', 'b')], new Map([
      ['now', { ...HERE, label: 'Review the MetaBlox B300 v2.3 contract' }],
      ['old-1', { ...NOT_HERE, label: 'Review the MetaBlox B300 v2.2 contract' }],
      ['old-2', { ...NOT_HERE, label: 'Compare the B300 and B200 contracts' }],
    ]));
    expect(shown.map((line) => line.kind)).toEqual(['running', 'promise', 'reminder', 'reminder']);
    expect(shown[1]).toEqual({ kind: 'promise', text: PM_REPORTS_HERE });
    expect(text(shown[2])).toMatch(new RegExp(`^Reminder: Contract Analyst's task "(Review the MetaBlox B300 v2\\.2 contract|Compare the B300 and B200 contracts)" \\(finished ${local(FINISHED_AT)}\\): `));
    expect(shown.map(text).join(' ')).not.toContain('cannot confirm');
  });
});

/*
 * v0.9.102 (Codex's audit of 2ddf9c46, F1; the Owner: fix it now): the report owed and the decision owed are two facts.
 * Closing one never hides the other: a decision does not report a result, and a reply does not decide it.
 */
describe('the decision owed and the report owed close only by their own facts (design §3 A, B)', () => {
  const delivered = { delivery: { state: 'delivered' as const, observedAt: AFTER, via: 'auto-wake' as const } };
  const closedByRejection = { state: 'closed' as const, cause: 'handle-abandoned' as const, recordedAt: AFTER, by: 'host-lifecycle' as const };

  it('F1a: a result received after the last reply, closed by the PM\'s rejection, is owed its report until the reply', () => {
    for (const fields of [{ conflict: true as const }, { recovery: 'decision-scope-unknown' as const }]) {
      const task = settled(result('historical', { ...fields, scope: closedByRejection, delivery: 'delivered', nextAction: 'none', blocksComplete: false }), delivered);
      expect(pmLiveRelevant(REPLIED)(task)).toBe(true);
      expect(lines([task])).toEqual([{ kind: 'continue', text: 'Contract Analyst finished, but the PM has not reported on it.', prompt: 'Please review the finished results and report to me.' }]);
      // The PM's final reply after it reports it.
      expect(lines([task], undefined, { repliedAt: '2026-11-12T10:05:00.000Z' })).toEqual([]);
      expect(pmLiveRelevant('2026-11-12T10:05:00.000Z')(task)).toBe(false);
    }
  });

  it('a decided result whose saved text is not here is still owed its report; an uncertain hand-over is not claimed', () => {
    const decided = settled(result('decided', { recovery: 'body-unavailable', delivery: 'delivered', decision: { value: 'rejected', reason: 'No.', recordedAt: AFTER }, blocksComplete: false, nextAction: 'none' }), delivered);
    expect(pmLiveRelevant(REPLIED)(decided)).toBe(true);
    expect(lines([decided]).map((line) => line.kind)).toEqual(['continue']);
    const unknownHandOver = settled(result('decided', { recovery: 'delivery-unknown', delivery: 'delivered', blocksComplete: false, nextAction: 'none' }), delivered);
    expect(pmLiveRelevant(REPLIED)(unknownHandOver)).toBe(false);
  });

  it('F1b: a result the PM replied about without a decision keeps its decision owed: a reminder, not while the PM is in a turn', () => {
    const replied = '2026-11-12T10:05:00.000Z';
    const task = settled(result('awaiting-decision', { delivery: 'delivered', reviewContinuation: 'consumed' }), delivered);
    const shown = lines([task], undefined, { repliedAt: replied });
    expect(shown).toEqual([expect.objectContaining({ kind: 'reminder',
      text: `Reminder: Contract Analyst's task (finished ${local(FINISHED_AT)}): the PM received it ${local(AFTER)} and has not recorded a decision `
        + 'on it. To clear this, press Ask the PM, then Send: the PM inspects it and records what to do with it.',
      prompt: expect.stringContaining('record your decision with record_task_disposition: accepted, rejected or deferred with your reason, needs-rework or needs-human, or superseded') })]);
    // In a turn the PM may record it now; an automatic review still to come is said instead.
    expect(lines([task], undefined, { repliedAt: replied, turn: { startedAt: '2026-11-12T10:06:00.000Z' } })).toEqual([]);
    expect(lines([settled(result('awaiting-decision', { delivery: 'delivered', reviewContinuation: 'scheduled' }), delivered)], undefined, { repliedAt: replied }))
      .toEqual([{ kind: 'finished', text: 'Contract Analyst finished. The PM gets one automatic turn to review it.' }]);
    // Under Stop the reminder stays; a recorded decision ends it.
    expect(lines([task], undefined, { repliedAt: replied, held: true }).map((line) => line.kind)).toEqual(['stopped', 'reminder']);
    expect(lines([settled(result('decided', { delivery: 'delivered', blocksComplete: false, nextAction: 'none' }), delivered)], undefined, { repliedAt: replied })).toEqual([]);
  });
});

describe('more than two open reminders: two named, then one line with Show all and Ask the PM about all (design §8)', () => {
  it('names the two newest, counts the rest, and lists each with its own message', () => {
    const at = (day: number) => `2026-11-0${day}T08:00:00.000Z`;
    const tasks = [1, 2, 3, 4].map((day) => settled(result('unknown', { handle: `t${day}`, recovery: 'body-unavailable' }), { handle: `t${day}`, terminalAt: at(day) }));
    const shown = lines(tasks);
    expect(shown.map((line) => line.kind)).toEqual(['reminder', 'reminder', 'more']);
    expect(shown.slice(0, 2).map((line) => (line as { prompt: string }).prompt.match(/handle (t\d)/)?.[1])).toEqual(['t4', 't3']);
    const more = shown[2] as Extract<PmLiveLine, { kind: 'more' }>;
    // v0.9.103 (slice 3 §3): the overflow counts reminders and updates apart; it no longer says each needs a decision.
    expect(more.text).toBe('2 more reminders.');
    expect(more.items.map((item) => item.prompt?.match(/handle (t\d)/)?.[1])).toEqual(['t4', 't3', 't2', 't1']);
    expect(more.items[0]).toMatchObject({ label: 'Contract Analyst\'s task', detail: `finished ${local(at(4))}: its saved result text is not available in this window, and it has not been handed to the PM yet` });
    expect(more.prompt!.split('\n')).toHaveLength(5);
    expect(more.prompt).toMatch(/^Please look at these 4 tasks and settle each one:\n- Contract Analyst's task \(handle t4, /);
  });
});

/*
 * v0.9.103 (slice 3 §3): an update is informational: no button, no prompt, no decision claimed. In the overflow it comes
 * after the reminders, is counted apart, and the one Ask the PM about all names the reminders only. Slice 2's exchange
 * items are its first producers; these entries stand in for them.
 */
describe('informational items on the strip and in its overflow (slice 3 §3)', () => {
  const reminder = (n: number) => ({ text: `Reminder ${n}.`, label: `Task ${n}`, detail: `detail ${n}`, body: `task ${n} (handle h${n})` });
  const update = (n: number) => ({ text: `Update ${n}.`, label: `Task u${n}`, detail: `update ${n}` });

  it('names an update as text only, after the reminders', () => {
    expect(pmLiveReminderLines([update(1), reminder(1)])).toEqual([
      { kind: 'reminder', text: 'Reminder 1.', prompt: 'Please look at task 1 (handle h1)' },
      { kind: 'info', text: 'Update 1.' },
    ]);
  });

  it('counts hidden reminders and updates apart; Show all lists updates without a prompt; the aggregate names reminders only', () => {
    const shown = pmLiveReminderLines([update(1), reminder(1), reminder(2), reminder(3), reminder(4), update(2)]);
    expect(shown.map((line) => line.kind)).toEqual(['reminder', 'reminder', 'more']);
    const more = shown[2] as Extract<PmLiveLine, { kind: 'more' }>;
    expect(more.text).toBe('2 more reminders and 2 updates.');
    expect(more.items.map((item) => [item.label, item.prompt])).toEqual([
      ['Task 1', 'Please look at task 1 (handle h1)'], ['Task 2', 'Please look at task 2 (handle h2)'],
      ['Task 3', 'Please look at task 3 (handle h3)'], ['Task 4', 'Please look at task 4 (handle h4)'],
      ['Task u1', undefined], ['Task u2', undefined],
    ]);
    expect(more.items.slice(4).every((item) => !('prompt' in item))).toBe(true);
    expect(more.prompt).toBe('Please look at these 4 tasks and settle each one:\n- task 1 (handle h1)\n- task 2 (handle h2)\n- task 3 (handle h3)\n- task 4 (handle h4)');
  });

  it('with only updates hidden, the overflow has no aggregate message', () => {
    const shown = pmLiveReminderLines([reminder(1), reminder(2), update(1)]);
    const more = shown[2] as Extract<PmLiveLine, { kind: 'more' }>;
    expect(more.text).toBe('1 more update.');
    expect(more).not.toHaveProperty('prompt');
    expect(more.items.map((item) => item.label)).toEqual(['Task 1', 'Task 2', 'Task u1']);
  });
});

/*
 * v0.9.103 slice 3 part B (design §3, §4.2, §6): a live task's exchanges with its PM, from slice 2's facts of its current
 * attempt. The status and the count are independent items; a teammate waiting at a checkpoint is not running; a task
 * that awaits an exchange has no silent-teammate line, and another task's exchange does not hide one.
 */
describe('exchange items, the waiting teammate and the silent line, slice 3 part B', () => {
  const at = '2026-11-12T10:00:00.000Z';
  const task = (handle: string, agentId: string) => active({ handle, agentId, requestedAgent: agentId });
  const names = new Map([['dev', 'Dev'], ['qa', 'QA']]);
  const owed = (...states: Array<'question-open' | 'answer-queued'>) =>
    states.map((state, index) => ({ exchangeId: `exchange-0000000${index}`, kind: 'question' as const, state }));
  const exchanges = (entries: Array<[string, Partial<{ owed: ReturnType<typeof owed>; waiting: boolean; exchangeCount: number }>]>) =>
    new Map(entries.map(([handle, value]) => {
      const owedNow = value.owed ?? [];
      const waiting = value.waiting ?? false;
      return [handle, { owed: owedNow, waiting, exchangeCount: value.exchangeCount ?? owedNow.length, awaitsExchange: waiting || owedNow.length > 0 }];
    }));
  const strip = (tasks: CoordinatorTaskStatus[], fields: Partial<PmLiveFacts>) => lines(tasks, undefined, { agentNames: names, ...fields });
  const silent = (handle: string) => [handle, { startedHere: true, phase: 'provider-wait' as const, lastActivityAt: at }] as const;
  const quietOf = (shown: PmLiveLine[]) =>
    (shown.find((line) => line.kind === 'quiet') as Extract<PmLiveLine, { kind: 'quiet' }> | undefined)?.teammates.map((t) => t.handle);

  it('an open question is actionable and says how many; an answer not yet delivered is an update; nothing else is inferred', () => {
    const one = strip([task('h-dev', 'dev')], { exchanges: exchanges([['h-dev', { owed: owed('question-open'), waiting: true }]]) });
    expect(one).toEqual([
      { kind: 'promise', text: PM_REPORTS_HERE },
      { kind: 'reminder', text: 'Dev asked the PM a question on Dev\'s task. To answer, press Ask the PM, then Send.',
        prompt: 'Please look at Dev\'s task (handle h-dev): Dev asked a question (exchange-00000000). Answer it with reply_to_task.' },
    ]);
    const two = strip([task('h-dev', 'dev')], { exchanges: exchanges([['h-dev', { owed: owed('question-open', 'question-open'), waiting: true }]]) });
    expect(text(two[1])).toBe('Dev asked the PM 2 questions on Dev\'s task. To answer, press Ask the PM, then Send.');
    // An open question wins over a queued answer on the same attempt.
    const both = strip([task('h-dev', 'dev')], { exchanges: exchanges([['h-dev', { owed: owed('answer-queued', 'question-open') }]]) });
    expect(both.map((line) => line.kind)).toEqual(['running', 'promise', 'reminder']);
    const queued = strip([task('h-dev', 'dev')], { exchanges: exchanges([['h-dev', { owed: owed('answer-queued'), waiting: true }]]) });
    expect(queued).toEqual([{ kind: 'promise', text: PM_REPORTS_HERE },
      { kind: 'info', text: 'Dev is waiting for the PM\'s answer to be delivered (Dev\'s task).' }]);
    // A checkpoint with nothing owed is not read as an answer, or as anything else.
    expect(strip([task('h-dev', 'dev')], { exchanges: exchanges([['h-dev', { waiting: true }]]) })).toEqual([{ kind: 'promise', text: PM_REPORTS_HERE }]);
  });

  it('a teammate waiting at a checkpoint leaves the Running line; one still in its turn stays on it', () => {
    const shown = strip([task('h-dev', 'dev'), task('h-qa', 'qa')], {
      exchanges: exchanges([['h-dev', { owed: owed('question-open'), waiting: true }], ['h-qa', { owed: owed('question-open') }]]),
    });
    expect(shown[0]).toEqual({ kind: 'running', tasks: [{ agent: 'QA', since: AFTER }] });
    expect(shown.filter((line) => line.kind === 'reminder').map(text)).toEqual([
      'Dev asked the PM a question on Dev\'s task. To answer, press Ask the PM, then Send.',
      'QA asked the PM a question on QA\'s task. To answer, press Ask the PM, then Send.',
    ]);
  });

  it('from three exchanges the count is an update of its own, beside an open question', () => {
    const three = strip([task('h-dev', 'dev')], { exchanges: exchanges([['h-dev', { owed: owed('question-open'), exchangeCount: 3 }]]) });
    expect(three.slice(2)).toEqual([
      { kind: 'reminder', text: 'Dev asked the PM a question on Dev\'s task. To answer, press Ask the PM, then Send.', prompt: expect.stringContaining('reply_to_task') },
      { kind: 'info', text: 'Dev and the PM have exchanged 3 questions on Dev\'s task.' },
    ]);
    const two = strip([task('h-dev', 'dev')], { exchanges: exchanges([['h-dev', { exchangeCount: 2 }]]) });
    expect(two.map((line) => line.kind)).toEqual(['running', 'promise']);
    // The current count, with nothing owed now.
    expect(text(strip([task('h-dev', 'dev')], { exchanges: exchanges([['h-dev', { exchangeCount: 7 }]]) })[2]))
      .toBe('Dev and the PM have exchanged 7 questions on Dev\'s task.');
  });

  it('task A\'s silent line stands beside an open exchange on task B; the same task\'s open exchange hides its own', () => {
    const tasks = [task('h-dev', 'dev'), task('h-qa', 'qa')];
    const activity = new Map([silent('h-dev'), silent('h-qa')]);
    const other = strip(tasks, { activity, exchanges: exchanges([['h-qa', { owed: owed('question-open') }]]) });
    expect(quietOf(other)).toEqual(['h-dev']);
    expect(other.some((line) => line.kind === 'reminder' && line.text.startsWith('QA asked the PM'))).toBe(true);
    expect(quietOf(strip(tasks, { activity }))).toEqual(['h-dev', 'h-qa']);
    // A queued answer and a waiting checkpoint each hide the task's own line too.
    expect(quietOf(strip(tasks, { activity, exchanges: exchanges([['h-dev', { owed: owed('answer-queued') }], ['h-qa', { waiting: true }]]) }))).toBeUndefined();
  });

  it('the overflow keeps updates after reminders, without a prompt, and asks the PM only about the reminders', () => {
    const tasks = ['a', 'b', 'c'].map((id) => task(`h-${id}`, id));
    const shown = strip(tasks, { exchanges: exchanges([
      ['h-a', { owed: owed('question-open'), exchangeCount: 3 }], ['h-b', { owed: owed('answer-queued') }], ['h-c', { owed: owed('question-open') }],
    ]) });
    const more = shown.find((line) => line.kind === 'more') as Extract<PmLiveLine, { kind: 'more' }>;
    expect(shown.filter((line) => line.kind === 'reminder')).toHaveLength(2);
    expect(more.text).toBe('2 more updates.');
    expect(more.items.map((item) => [item.label, !!item.prompt])).toEqual([
      ['a\'s task', true], ['c\'s task', true], ['a\'s task', false], ['b\'s task', false],
    ]);
    expect(more).not.toHaveProperty('prompt');
  });
});
