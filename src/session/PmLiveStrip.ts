import type { CoordinatorTaskStatus } from '../backend/TeamTools';
import type { DelegationResultProjection } from '../backend/DelegationResultProjection';
import type { PmStripTaskFacts } from '../observability/RunLedger';
import { pmStatusRelevant } from './PmTurnStatus';
import type { TurnTimingPhase } from './TurnTiming';

/**
 * v0.9.102 (the Owner's decision): what a PM's team is doing now, shown in one
 * strip above the message box. Replies record only their own turn; this is the one place that follows the work. Every
 * line is read from typed host state at the moment it is drawn, nothing from model prose, and the strip is hidden only
 * when there is positively nothing to say.
 *
 * Finished work is owed a report to the person from the moment its result is placed into a PM turn until the PM ends a
 * later turn with a final reply. That reply is the host's only evidence of a report: it does not read what the reply
 * says. A recorded decision is not a report, so a decided result stays owed until that reply.
 *
 * v0.9.102 (the Owner, 2026-11-13: every leftover item can be resolved): the strip shows two things. Live status is what
 * this window observes now and changes by itself. An open obligation stays until its own closing fact is recorded, and
 * is shown with the task (teammate, instruction, date), what is known about it, and a button that starts the action the
 * host accepts for it. A decision owed closes with a disposition the tool accepts; a report owed with the PM's final
 * reply; the person's decision in Review Delivered Work; rework owed when it starts; doubt about execution only with an
 * observed end.
 */
export interface PmLiveFacts {
  /** Stop holds this PM: no result wake and no automatic turn runs until the person sends a message. */
  held: boolean;
  /** The PM's current turn, when it is in one: when it started. */
  turn?: { startedAt: string };
  /**
   * The PM's task records `pmLiveRelevant` keeps. Undefined: the records could not be read, and nothing is said about
   * the tasks.
   */
  tasks: readonly CoordinatorTaskStatus[] | undefined;
  /**
   * What only the strip reads about each task, by handle (RunLedger.pmStripFactsOf). A task without an entry is read as
   * started in this window, owned by no other window, in an open request, with no label.
   */
  stripFacts?: ReadonlyMap<string, PmStripTaskFacts>;
  /** When the PM last ended a turn with a final reply to the person; results placed into a turn after it are owed. */
  repliedAt: string;
  /** Results waiting in a queued wake that has not started a PM turn yet. */
  queued: ReadonlySet<string>;
  /** Dispatches accepted but whose teammate has not been admitted yet: they have no task record until then. */
  starting: number;
  /** What the PM's waiting request still needs, each target and access once. */
  waitingForAccess: ReadonlyArray<{ label: string; path: string; access: 'read' | 'readwrite' }>;
  /**
   * Each teammate's display name by agent id. A task is named by its teammate's name; without one, by the name the PM
   * asked for.
   */
  agentNames?: ReadonlyMap<string, string>;
  /**
   * v0.9.103 (slice 3 §4.1): the live turn of each task the strip lists as running, by handle, from
   * SessionManager.liveAttemptActivity. A task without an entry is unknown, and has no silent-teammate line.
   */
  activity?: ReadonlyMap<string, PmAttemptActivity>;
  /**
   * v0.9.103 (slice 3 §3, §4.2): the exchanges of each task the strip lists as running, by handle, from
   * SessionManager.taskExchangeFacts and awaitsExchange. A task without an entry has none known in this window.
   */
  exchanges?: ReadonlyMap<string, PmTaskExchanges>;
}

/** v0.9.103 (slice 3 §3): what this window knows of a task's current attempt's exchanges with its PM. */
export interface PmTaskExchanges {
  /** Questions and blockers still owed to the teammate: one with no answer yet, or one whose answer is not delivered. */
  owed: ReadonlyArray<{ exchangeId: string; kind: 'question' | 'blocker'; state: 'question-open' | 'answer-queued' }>;
  /** The attempt ended its turn waiting for an answer, at a checkpoint. A checkpoint alone never means an answer exists. */
  waiting: boolean;
  /** How many exchanges the attempt opened, closed ones included. */
  exchangeCount: number;
  /** SessionManager.awaitsExchange: an exchange is owed or the attempt waits at a checkpoint. */
  awaitsExchange: boolean;
}

/** v0.9.103 (slice 3 §3, Q1): from this many exchanges on one attempt, the strip says how many there have been. */
export const PM_EXCHANGES_NAMED_FROM = 3;

/**
 * v0.9.103 (slice 3 §4.1): what the host observes of a task's current attempt in this window, from the teammate turn that
 * carries its handle. `startedHere` is affirmative: only a matched live turn says it, and nothing defaults it.
 */
export interface PmAttemptActivity {
  startedHere: boolean;
  phase: TurnTimingPhase;
  /** The last provider output, tool start or finish, or compaction the host observed in that turn. */
  lastActivityAt: string;
  /** The one open tool call, by the name its start gave, when the turn runs a tool. */
  tool?: string;
}

/** The phases in which a turn that shows nothing counts as silent. Compaction says what it is doing on its own. */
export type PmQuietPhase = 'host' | 'provider-wait' | 'reasoning' | 'responding' | 'tool';

/**
 * v0.9.103 (slice 3 §4.3): a running task that may be silent. The page shows it once `quietSince` is
 * DELEGATION_STALLED_AFTER_MS old, on its own ticker, so the host sends it before the threshold and nothing when a minute
 * passes.
 */
export interface PmQuietCandidate {
  handle: string;
  agent: string;
  /** "Dev's task "Review the contract"", as a reminder names it; the Ask the PM draft names the task by it. */
  task: string;
  phase: PmQuietPhase;
  tool?: string;
  quietSince: string;
}

/**
 * One item in the overflow list: what Show all offers. An item with a prompt is actionable: Ask the PM puts its prompt in
 * the message box, and Ask the PM about all names it. An item without one is informational: text only (slice 3 §3).
 */
export interface PmLiveReminderItem { label: string; detail: string; prompt?: string }

export type PmLiveLine =
  | { kind: 'unavailable'; text: string }
  | { kind: 'stopped'; text: string }
  /** The person owes a decision: its button runs "UnodeAi: Review Delivered Work". */
  | { kind: 'decision'; text: string; review?: true }
  | { kind: 'access'; text: string }
  /** The page writes each task's minutes from `since`, its dispatch time; a task without one shows no minutes. */
  | { kind: 'running'; tasks: Array<{ agent: string; since?: string }> }
  | { kind: 'starting'; text: string }
  | { kind: 'promise'; text: string }
  | { kind: 'finished'; text: string }
  /**
   * Nothing will move this on by itself: the button (`button`, default Continue) fills the message box with `prompt`;
   * the person presses Send.
   */
  | { kind: 'continue'; text: string; prompt: string; button?: 'Continue rework' }
  /** Live in another UnodeAi window: nothing to do here. */
  | { kind: 'elsewhere'; text: string }
  /** An open obligation of one task: Ask the PM fills the message box with `prompt`; the person presses Send. */
  | { kind: 'reminder'; text: string; prompt: string }
  /** v0.9.103 (slice 3 §3): an update that asks nothing of anyone: text only, no button. */
  | { kind: 'info'; text: string }
  /**
   * More open items than are named: Show all lists each, a reminder with its own Ask the PM, an update as text. Ask the PM
   * about all (`prompt`) names the reminders only, and is absent when no reminder is hidden.
   */
  | { kind: 'more'; text: string; items: PmLiveReminderItem[]; prompt?: string }
  /**
   * v0.9.103 (slice 3 §4): running tasks that may be silent. The page draws them in their own live region, once each has
   * been quiet for DELEGATION_STALLED_AFTER_MS, with one Ask the PM that fills the message box.
   */
  | { kind: 'quiet'; teammates: PmQuietCandidate[] };

export interface PmLiveStrip { lines: PmLiveLine[] }

export const PM_REPORTS_HERE = 'The PM reports here when results come back.';
export const CONTINUE_REPORT = 'Please review the finished results and report to me.';
export const CONTINUE_REWORK = 'Please start the rework you requested, or tell me why not.';

const MAX_DECISIONS = 2;
const MAX_REMINDERS = 2;
const FINISHED_STATES: ReadonlySet<string> = new Set(['ready', 'awaiting-decision', 'failed', 'decided']);

const time = (iso: string | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

/**
 * The result was placed into a PM turn no earlier than `repliedAt`, the PM's last final reply. A result placed at the
 * moment of a reply (a wake that starts as the turn before it ends) cannot have been reported in it.
 */
function deliveredSince(task: CoordinatorTaskStatus, repliedAt: string): boolean {
  if (task.delivery?.state !== 'delivered') return false;
  const at = time(task.delivery.observedAt);
  const replied = time(repliedAt);
  return Number.isFinite(at) && (!Number.isFinite(replied) || at >= replied);
}

/** The attempt was interrupted (worker lost, or found active when its window restarted). */
const interruptedTask = (task: CoordinatorTaskStatus): boolean => task.lifecycle === 'interrupted' || task.recordedState === 'interrupted';
/**
 * A result Stop suspended, or one the person's message resumed after its request closed (design §3 B): the resumption
 * ends the suspension, not the report. Either is owed until the PM's next final reply, whatever its run says.
 */
const resumedOrSuspended = (result: NonNullable<CoordinatorTaskStatus['result']>): boolean =>
  result.scope?.state === 'suspended' || result.scope?.state === 'reopened' && result.state === 'historical';

/**
 * v0.9.102 (Codex's audit of 2ddf9c46, F1a): the PM's own accepted decision closed this result's scope (design §4.1).
 * That ends the decision owed, not the report: a result the PM received after its last reply is still owed one.
 */
const closedByDecision = (result: NonNullable<CoordinatorTaskStatus['result']>): boolean =>
  result.state === 'historical' && result.scope?.state === 'closed'
  && (result.scope.cause === 'handle-superseded' || result.scope.cause === 'handle-abandoned');

/** Superseded or abandoned: the task ended for good. Any other decision (a rework asked before it) leaves it open. */
const endedForGood = (task: CoordinatorTaskStatus): boolean =>
  task.disposition?.value === 'superseded' || task.disposition?.value === 'abandoned';

/**
 * The records the strip reads: anything running, uncertain or owing a decision, every interrupted task not yet
 * superseded or abandoned, and every result still owed a report. A result Stop suspended is owed unless the PM replied
 * after it was placed into a turn.
 *
 * v0.9.102 (Codex's audit of 2ddf9c46, F1): the report owed and the decision owed are separate facts; neither closes the
 * other. A decided result, or one the PM's decision closed, that reached the PM after its last reply is read whatever is
 * known about its saved text: only an uncertain hand-over says nothing about a report.
 */
export function pmLiveRelevant(repliedAt: string): (task: CoordinatorTaskStatus) => boolean {
  return (task) => {
    if (interruptedTask(task)) return !endedForGood(task);
    if (pmStatusRelevant(task)) return true;
    const result = task.result;
    if (!result) return false;
    if ((FINISHED_STATES.has(result.state) || closedByDecision(result)) && result.recovery !== 'delivery-unknown'
      && deliveredSince(task, repliedAt)) return true;
    if (result.recovery) return false;
    if (resumedOrSuspended(result)) return task.delivery?.state !== 'delivered' || deliveredSince(task, repliedAt);
    return false;
  };
}

/** Why a task owes the PM an action that only the PM can take, and so what the reminder asks for. */
export type PmReminderCause =
  /** A settled result whose saved text or hand-over is not known: a settled-result decision closes it. */
  | 'result'
  /** A result whose copies conflict or whose decision scope is unknown: a real replacement or a rejection closes it. */
  | 'unresolved'
  /** Interrupted work: abandoned or a real replacement closes it. */
  | 'interrupted'
  /** Not known to have ended: only an observed end closes it; cancel_task stops it. */
  | 'doubt'
  /** A result the PM received and replied about without recording a decision: its decision is still owed (F1b). */
  | 'undecided';

type Item =
  | { kind: 'running' | 'elsewhere' | 'human' | 'rework' | 'finished' }
  | { kind: 'reminder'; cause: PmReminderCause };

const RUNNING: Item = { kind: 'running' };
const ELSEWHERE: Item = { kind: 'elsewhere' };
const FINISHED: Item = { kind: 'finished' };
const reminder = (cause: PmReminderCause): Item => ({ kind: 'reminder', cause });
const DEFAULT_FACTS: PmStripTaskFacts = { startedHere: true, liveElsewhere: false, runOpen: true };

/** Live work is shown running only where this window started it; elsewhere it is another window's, or in doubt. */
const live = (facts: PmStripTaskFacts): Item =>
  facts.startedHere ? RUNNING : facts.liveElsewhere ? ELSEWHERE : reminder('doubt');
const doubt = (facts: PmStripTaskFacts): Item => (facts.liveElsewhere ? ELSEWHERE : reminder('doubt'));
/** Execution states that say a task's work is over. Anything else (running, unknown, stop-unconfirmed) is not. */
const EXECUTION_OVER: ReadonlySet<string> = new Set(['ended', 'stopped', 'not-running']);

/**
 * Every projected result state, read in the order the design fixes: the recorded state first (the person's decision,
 * rework owed, running work started here), then what is not known about the result. A new state does not compile until
 * it is placed here.
 */
const BY_RESULT_STATE = {
  running: (_task, facts) => live(facts),
  'stop-unconfirmed': (_task, facts) => doubt(facts),
  'awaiting-human': () => ({ kind: 'human' }),
  'awaiting-rework': () => ({ kind: 'rework' }),
  ready: () => FINISHED,
  'awaiting-decision': () => FINISHED,
  failed: () => FINISHED,
  decided: () => FINISHED,
  // Not known to have ended: doubt about execution, whatever is known of its result (design §3 E).
  unknown: (task, facts) => !EXECUTION_OVER.has(task.result?.execution ?? 'unknown') ? doubt(facts)
    : reminder(task.result?.conflict || task.result?.recovery === 'decision-scope-unknown' ? 'unresolved' : 'result'),
  // A result Stop suspended is read before this table; a stopped attempt with no result is interrupted work.
  stopped: () => reminder('interrupted'),
  cancelled: () => undefined,
  // The PM's own decision closed it: the decision is not owed any more, the report may be (F1a).
  historical: (task) => (task.result && closedByDecision(task.result) && task.delivery?.state === 'delivered' ? FINISHED : undefined),
} satisfies Record<DelegationResultProjection['state'], (task: CoordinatorTaskStatus, facts: PmStripTaskFacts) => Item | undefined>;

/** What one task record is on the strip: live status, an obligation, or nothing. */
export function pmStripItem(task: CoordinatorTaskStatus, facts: PmStripTaskFacts = DEFAULT_FACTS): Item | undefined {
  // Interrupted work takes only abandoned or a real replacement, whatever its last result said.
  if (interruptedTask(task)) return endedForGood(task) || !facts.runOpen ? undefined : reminder('interrupted');
  const result = task.result;
  if (result) {
    // v0.9.102: Stop suspended it in the result mailbox; the person's next message offers it to the PM again. Its run may
    // have closed with the stopped turn, which projects it as historical: the suspension is what still holds, and after
    // the person's message the report is still owed until the PM's final reply (design §3 B, §9.3).
    if (resumedOrSuspended(result)) return FINISHED;
    return BY_RESULT_STATE[result.state](task, facts);
  }
  // No standing result yet: the attempt is running, ended without one, or its state is not known.
  if (task.lifecycle === 'active' || task.lifecycle === 'timed-out' && task.recordedState === 'active') {
    return task.execution?.state === 'unknown' || task.execution?.state === 'stop-unconfirmed' ? doubt(facts) : live(facts);
  }
  if (task.lifecycle === 'unknown') return doubt(facts);
  // A result settled before results had revisions, with no decision recorded: owed, never continued.
  return task.lifecycle === 'settled' && !task.disposition ? FINISHED : undefined;
}

/** "2026-11-10 08:28", local time; empty when the time is not known. */
function localTime(value: string | undefined): string {
  const at = time(value);
  if (!Number.isFinite(at)) return '';
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** When, as the reminder names the task: finished, interrupted or started, with its date. */
function whenOf(task: CoordinatorTaskStatus, cause: PmReminderCause): string {
  const at = cause === 'interrupted' ? localTime(task.interruption?.detectedAt ?? task.terminalAt)
    : cause === 'doubt' ? localTime(task.dispatchedAt) : localTime(task.terminalAt);
  if (!at) return '';
  return `${cause === 'interrupted' ? 'interrupted' : cause === 'doubt' ? 'started' : 'finished'} ${at}`;
}

/**
 * What is known, composed from independent facts; nothing a fact does not establish (design §5). When facts disagree,
 * the uncertain one is said and no certainty beside it.
 */
function knownOf(task: CoordinatorTaskStatus, cause: PmReminderCause, facts: PmStripTaskFacts): string {
  if (cause === 'interrupted') {
    return task.interruption?.reason === 'worker-lost' ? 'its teammate\'s session ended before it finished'
      : task.interruption?.reason === 'host-restarted' ? 'it was interrupted when its window closed or reloaded'
        : 'it was interrupted before it finished';
  }
  if (cause === 'doubt') {
    return facts.startedHere ? 'UnodeAi cannot confirm whether it is still running' : 'this window did not start it and cannot observe it';
  }
  if (cause === 'unresolved') return 'UnodeAi cannot tell which decision applies to it';
  if (cause === 'undecided') {
    const at = localTime(task.delivery?.state === 'delivered' ? task.delivery.observedAt : undefined);
    return `the PM received it${at ? ` ${at}` : ''} and has not recorded a decision on it`;
  }
  const result = task.result;
  const clauses: string[] = [];
  if (result?.recovery === 'body-unavailable') clauses.push('its saved result text is not available in this window');
  if (result?.recovery === 'recovery-data-not-saved') clauses.push('its saved copy could not be written');
  if (result?.recovery === 'delivery-unknown') clauses.push('UnodeAi cannot tell whether the PM received it');
  else if (result?.delivery === 'delivered') {
    const at = localTime(task.delivery?.state === 'delivered' ? task.delivery.observedAt : undefined);
    clauses.push(at ? `the PM received it ${at}` : 'the PM received it');
  } else if (result?.delivery === 'pending') clauses.push('it has not been handed to the PM yet');
  return clauses.length ? clauses.join(', and ') : 'UnodeAi cannot use its result';
}

/** What the PM is asked to do, listing only what the host accepts for this record (design §4). */
function askOf(handle: string, cause: PmReminderCause): string {
  switch (cause) {
    case 'result':
      return 'Inspect it with inspect_task_status. If the work is still needed, redo it (dispatch_task, then '
        + 'record_task_disposition superseded with the new handle, or needs-rework for the same teammate); if it is not, '
        + 'record rejected or deferred with your reason.';
    case 'unresolved':
      return 'Inspect it with inspect_task_status. Redo it (dispatch_task, then record_task_disposition superseded with the '
        + 'new handle) or, if it is not needed, record rejected with your reason; either closes it.';
    case 'interrupted':
      return `Inspect it with inspect_task_status. Redo it (dispatch_task with replaces_handle "${handle}") or record_task_disposition `
        + 'abandoned with your reason.';
    case 'doubt':
      return 'Inspect it with inspect_task_status; if it should not continue, stop it with cancel_task. Record a decision '
        + 'only after its end is observed.';
    case 'undecided':
      return 'Inspect it with inspect_task_status and record your decision with record_task_disposition: accepted, rejected '
        + 'or deferred with your reason, needs-rework or needs-human, or superseded with the handle of a real new dispatch_task.';
  }
}

/** A finished result whose decision is still owed: undecided, or settled before results had revisions and undecided. */
function decisionOwed(task: CoordinatorTaskStatus): boolean {
  const result = task.result;
  if (!result) return task.lifecycle === 'settled' && !task.disposition;
  return (result.state === 'ready' || result.state === 'awaiting-decision' || result.state === 'failed') && result.blocksComplete;
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
const it = (tasks: readonly unknown[]): string => (tasks.length === 1 ? 'it' : 'them');

/** v0.9.103 (slice 3 §4.1): the handles the strip lists as running, the only tasks whose live turn the publisher reads. */
export function pmLiveRunningHandles(facts: Pick<PmLiveFacts, 'tasks' | 'stripFacts'>): string[] {
  return (facts.tasks ?? [])
    .filter((task) => pmStripItem(task, facts.stripFacts?.get(task.handle) ?? DEFAULT_FACTS)?.kind === 'running')
    .map((task) => task.handle);
}

/**
 * v0.9.103 (slice 3 §4.2, §7), the slice 2 seam: whether this task's current attempt has an open exchange with the PM or a
 * waiting checkpoint, as SessionManager.awaitsExchange answered it for this read. Each shows its own item, so such an
 * attempt has no silent-teammate line. A task with no exchange facts has none.
 */
export function attemptHasOpenExchangeOrCheckpoint(task: CoordinatorTaskStatus, exchanges: PmLiveFacts['exchanges']): boolean {
  return exchanges?.get(task.handle)?.awaitsExchange === true;
}

/**
 * v0.9.103 (slice 3 §3): a live task's exchange items, two independent ones.
 * - Its status, the first that applies: open questions, actionable (Ask the PM asks the PM to answer them); else an
 *   answer not yet delivered, an update. A checkpoint with nothing owed cannot occur (slice 2 opens one only for an owed
 *   exchange) and gives no item: a checkpoint alone is never read as an answer.
 * - From PM_EXCHANGES_NAMED_FROM exchanges, an update with the current count. It blocks nothing and asks nothing.
 */
function exchangeEntriesOf(task: CoordinatorTaskStatus, exchanges: PmTaskExchanges | undefined, agent: string, name: string): PmLiveEntry[] {
  if (!exchanges) return [];
  const entries: PmLiveEntry[] = [];
  const open = exchanges.owed.filter((exchange) => exchange.state === 'question-open');
  if (open.length) {
    const asked = open.length === 1 ? 'a question' : `${open.length} questions`;
    entries.push({
      text: `${agent} asked the PM ${asked} on ${name}. To answer, press Ask the PM, then Send.`,
      label: name,
      detail: `${agent} asked the PM ${asked}; ${agent} gets the answer when the PM replies with reply_to_task`,
      body: `${name} (handle ${task.handle}): ${agent} asked ${asked} (${open.map((exchange) => exchange.exchangeId).join(', ')}). `
        + `Answer ${open.length === 1 ? 'it' : 'each'} with reply_to_task.`,
    });
  } else if (exchanges.owed.some((exchange) => exchange.state === 'answer-queued')) {
    const text = `${agent} is waiting for the PM's answer to be delivered (${name}).`;
    entries.push({ text, label: name, detail: `${agent} is waiting for the PM's answer to be delivered` });
  }
  if (exchanges.exchangeCount >= PM_EXCHANGES_NAMED_FROM) {
    entries.push({
      text: `${agent} and the PM have exchanged ${exchanges.exchangeCount} questions on ${name}.`,
      label: name,
      detail: `${agent} and the PM have exchanged ${exchanges.exchangeCount} questions on this task`,
    });
  }
  return entries;
}

const QUIET_PHASES: ReadonlySet<string> = new Set<PmQuietPhase>(['host', 'provider-wait', 'reasoning', 'responding', 'tool']);

/** v0.9.103 (slice 3 §3): one item the strip names or Show all lists. One with `body` is actionable; one without is an update. */
export interface PmLiveEntry { text: string; label: string; detail: string; body?: string }

/**
 * v0.9.103 (slice 3 §3): the named items and the overflow line. Actionable items come first, in the order given, then
 * updates. The first MAX_REMINDERS are named; the rest are counted by kind on the overflow line. Its Show all lists every
 * item; its Ask the PM about all names the actionable ones only, and is offered only when one of them is hidden.
 */
export function pmLiveReminderLines(entries: readonly PmLiveEntry[]): PmLiveLine[] {
  const actionable = entries.filter((entry) => entry.body !== undefined);
  const ordered = [...actionable, ...entries.filter((entry) => entry.body === undefined)];
  const promptOf = (entry: PmLiveEntry): string | undefined => (entry.body !== undefined ? `Please look at ${entry.body}` : undefined);
  const lines: PmLiveLine[] = ordered.slice(0, MAX_REMINDERS).map((entry): PmLiveLine => {
    const prompt = promptOf(entry);
    return prompt ? { kind: 'reminder', text: entry.text, prompt } : { kind: 'info', text: entry.text };
  });
  const hidden = ordered.slice(MAX_REMINDERS);
  if (!hidden.length) return lines;
  const hiddenReminders = hidden.filter((entry) => entry.body !== undefined).length;
  const hiddenUpdates = hidden.length - hiddenReminders;
  const counted = [hiddenReminders ? count(hiddenReminders, 'reminder') : '', hiddenUpdates ? count(hiddenUpdates, 'update') : '']
    .filter(Boolean).join(' and ');
  lines.push({
    kind: 'more',
    text: `${counted.replace(/^(\d+) /, '$1 more ')}.`,
    items: ordered.map((entry) => {
      const prompt = promptOf(entry);
      return { label: entry.label, detail: entry.detail, ...(prompt ? { prompt } : {}) };
    }),
    ...(hiddenReminders
      ? { prompt: `Please look at these ${actionable.length} tasks and settle each one:\n${actionable.map((entry) => `- ${entry.body}`).join('\n')}` }
      : {}),
  });
  return lines;
}

export function pmLiveStrip(facts: PmLiveFacts): PmLiveStrip | undefined {
  const lines: PmLiveLine[] = [];
  const starting = Math.max(0, facts.starting);
  const inTurn = !!facts.turn;
  const turnStart = time(facts.turn?.startedAt);
  const agentOf = (task: CoordinatorTaskStatus): string =>
    (task.agentId ? facts.agentNames?.get(task.agentId) : undefined) || task.requestedAgent || 'A teammate';
  const factsOf = (task: CoordinatorTaskStatus): PmStripTaskFacts => facts.stripFacts?.get(task.handle) ?? DEFAULT_FACTS;
  /** "Dev's task "Review the contract"": the teammate, and the start of the instruction when it is known. */
  const taskName = (task: CoordinatorTaskStatus): string => {
    const label = factsOf(task).label;
    return `${agentOf(task)}'s task${label ? ` "${label}"` : ''}`;
  };
  /** Each agent once, in the order first seen: "Dev", "Dev and Writer", "Dev, Writer and Analyst". */
  const names = (named: readonly CoordinatorTaskStatus[]): string => {
    const unique = [...new Set(named.map(agentOf))];
    if (unique.length <= 1) return unique[0] ?? 'A teammate';
    return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
  };

  if (!facts.tasks) {
    lines.push({ kind: 'unavailable', text: 'UnodeAi cannot read its task records now, so it cannot show what the team is doing.' });
  }
  const items = (facts.tasks ?? []).map((task) => ({ task, item: pmStripItem(task, factsOf(task)) }));
  const of = (kind: Item['kind']) => items.filter((entry) => entry.item?.kind === kind).map((entry) => entry.task);
  const live = of('running');
  // v0.9.103 (slice 3 §4.2): a teammate waiting at a checkpoint is not running; its exchange item says what it waits for.
  const waitingAt = (task: CoordinatorTaskStatus): boolean => facts.exchanges?.get(task.handle)?.waiting === true;
  const running = live.filter((task) => !waitingAt(task));
  const waiting = live.filter(waitingAt);
  const elsewhere = of('elsewhere');
  const human = of('human');
  const rework = of('rework');

  if (facts.held) {
    lines.push({ kind: 'stopped', text: running.length
      ? `Stopped. ${count(running.length, 'task')} still running; the PM does not continue until you send a message.`
      : 'Stopped. The PM does not continue until you send a message.' });
  }
  for (const task of human.slice(0, MAX_DECISIONS)) {
    const reason = task.result?.decision?.reason;
    lines.push({ kind: 'decision', text: `Needs your decision: ${taskName(task)}${reason ? ` — ${reason}` : ''}.`, review: true });
  }
  if (human.length > MAX_DECISIONS) {
    lines.push({ kind: 'decision', text: `${count(human.length - MAX_DECISIONS, 'more result')} also need your decision.`, review: true });
  }
  if (facts.waitingForAccess.length) {
    const shown = facts.waitingForAccess.slice(0, 3)
      .map((need) => `${need.access === 'readwrite' ? 'Read + Write' : 'Read'} for ${need.label} (${need.path})`).join('; ');
    const more = facts.waitingForAccess.length > 3 ? `; ${facts.waitingForAccess.length - 3} more` : '';
    lines.push({ kind: 'access', text: `Waiting for your access: ${shown}${more}. Choose Grant access on its item.` });
  }
  if (running.length) {
    lines.push({ kind: 'running', tasks: running.map((task) => ({
      agent: agentOf(task),
      ...(Number.isFinite(time(task.dispatchedAt)) ? { since: task.dispatchedAt } : {}),
    })) });
  }
  // v0.9.103 (slice 3 §4): each running task whose own live turn here may be silent, sent before the page's threshold.
  // Only an affirmative reading of that turn counts; a held PM shows Stopped instead.
  const quiet = facts.held ? [] : running.flatMap((task): PmQuietCandidate[] => {
    const activity = facts.activity?.get(task.handle);
    if (activity?.startedHere !== true || !QUIET_PHASES.has(activity.phase)) return [];
    if (!Number.isFinite(time(activity.lastActivityAt)) || attemptHasOpenExchangeOrCheckpoint(task, facts.exchanges)) return [];
    return [{ handle: task.handle, agent: agentOf(task), task: taskName(task), phase: activity.phase as PmQuietPhase,
      ...(activity.phase === 'tool' && activity.tool ? { tool: activity.tool } : {}), quietSince: activity.lastActivityAt }];
  });
  if (quiet.length) lines.push({ kind: 'quiet', teammates: quiet });
  for (const task of elsewhere) {
    lines.push({ kind: 'elsewhere', text: `${taskName(task)} is being handled in another UnodeAi window.` });
  }
  if (starting) lines.push({ kind: 'starting', text: `Starting: ${count(starting, 'task')}.` });
  // The promise holds only while a result can wake the PM: never under Stop.
  // A teammate waiting for an answer is still owed a result: the promise holds for it as for running work.
  if ((running.length || waiting.length || starting) && !facts.held) lines.push({ kind: 'promise', text: PM_REPORTS_HERE });

  // Finished work, by what happens to it next. Each task is in exactly one group.
  const reviewingNow: CoordinatorTaskStatus[] = [];
  const queuedBehind: CoordinatorTaskStatus[] = [];
  const aboutToStart: CoordinatorTaskStatus[] = [];
  const automatic: CoordinatorTaskStatus[] = [];
  const notYet: CoordinatorTaskStatus[] = [];
  const owed: CoordinatorTaskStatus[] = [];
  /** Reported on, but its decision still owed (F1b): a reminder, unless the PM is in a turn that may record it now. */
  const undecided: CoordinatorTaskStatus[] = [];
  for (const task of of('finished')) {
    const delivered = task.delivery?.state === 'delivered';
    const reported = delivered && !deliveredSince(task, facts.repliedAt);
    const scheduled = task.result?.reviewContinuation === 'scheduled' && task.result.state !== 'decided';
    if (reported) {
      // The PM has replied since it received this result. An automatic review turn it is still owed is said. Without one,
      // a decision the PM has still not recorded is a reminder (v0.9.102, Codex's audit of 2ddf9c46, F1b): the reply
      // reported it, it did not decide it.
      if (scheduled && !facts.held) automatic.push(task);
      else if (decisionOwed(task) && (facts.held || !inTurn)) undecided.push(task);
      continue;
    }
    if (!delivered && facts.queued.has(task.handle) && !facts.held) {
      (inTurn ? queuedBehind : aboutToStart).push(task);
    } else if (delivered && inTurn && !facts.held && time(task.delivery?.observedAt) >= turnStart) {
      reviewingNow.push(task);
    } else if (scheduled && !facts.held && !inTurn) {
      automatic.push(task);
    } else if (inTurn && !facts.held) {
      // The PM is in a turn that did not receive this result: it may still take it up. Nothing is promised.
      notYet.push(task);
    } else {
      owed.push(task);
    }
  }
  if (reviewingNow.length) lines.push({ kind: 'finished', text: `${names(reviewingNow)} finished. The PM is reviewing ${it(reviewingNow)} now.` });
  if (aboutToStart.length) lines.push({ kind: 'finished', text: `${names(aboutToStart)} finished. The PM is about to review ${it(aboutToStart)}.` });
  if (queuedBehind.length) {
    lines.push({ kind: 'finished', text: `${names(queuedBehind)} finished. The PM gets ${queuedBehind.length === 1 ? 'the result' : 'the results'} when its current turn ends.` });
  }
  if (automatic.length) lines.push({ kind: 'finished', text: `${names(automatic)} finished. The PM gets one automatic turn to review ${it(automatic)}.` });
  if (notYet.length) lines.push({ kind: 'finished', text: `${names(notYet)} finished. The PM has not reported on ${it(notYet)} yet.` });
  if (owed.length) {
    lines.push({ kind: 'continue', text: `${names(owed)} finished, but the PM has not reported on ${it(owed)}.`, prompt: CONTINUE_REPORT });
  }
  const reminders = [
    ...items.filter((entry): entry is { task: CoordinatorTaskStatus; item: { kind: 'reminder'; cause: PmReminderCause } } => entry.item?.kind === 'reminder'),
    ...undecided.map((task) => ({ task, item: { kind: 'reminder' as const, cause: 'undecided' as const } })),
  ]
    .map(({ task, item }) => {
      const taskFacts = factsOf(task);
      const when = whenOf(task, item.cause);
      const known = knownOf(task, item.cause, taskFacts);
      const subject = `${taskName(task)} (handle ${task.handle}${when ? `, ${when}` : ''})`;
      return {
        task,
        at: time(item.cause === 'doubt' ? task.dispatchedAt : item.cause === 'interrupted' ? task.interruption?.detectedAt ?? task.terminalAt : task.terminalAt),
        text: `Reminder: ${taskName(task)}${when ? ` (${when})` : ''}: ${known}. To clear this, press Ask the PM, then Send: `
          + (item.cause === 'doubt' ? 'the PM inspects it and stops it if it should not continue.' : 'the PM inspects it and records what to do with it.'),
        detail: `${when ? `${when}: ` : ''}${known}`,
        body: `${subject}: ${known}. ${askOf(task.handle, item.cause)}`,
      };
    })
    // Newest first; a task with no known time last.
    .sort((a, b) => (Number.isFinite(b.at) ? b.at : -Infinity) - (Number.isFinite(a.at) ? a.at : -Infinity));
  if (rework.length) {
    const text = `Rework requested from ${names(rework)}, but none is running.`;
    lines.push(inTurn && !facts.held ? { kind: 'finished', text } : { kind: 'continue', text, prompt: CONTINUE_REWORK, button: 'Continue rework' });
  }
  // v0.9.103 (slice 3 §3): each live task's exchange status and its exchange count, independent of each other.
  const exchangeEntries = live.flatMap((task) => exchangeEntriesOf(task, facts.exchanges?.get(task.handle), agentOf(task), taskName(task)));
  lines.push(...pmLiveReminderLines([...exchangeEntries, ...reminders.map((entry) => ({
    text: entry.text, label: taskName(entry.task), detail: entry.detail, body: entry.body,
  }))]));
  return lines.length ? { lines } : undefined;
}

/** The strip says the same thing to the person. */
export function samePmLiveStrip(a: PmLiveStrip | undefined, b: PmLiveStrip | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
