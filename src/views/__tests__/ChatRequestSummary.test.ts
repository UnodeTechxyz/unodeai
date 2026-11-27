import { describe, expect, it, vi } from 'vitest';

// These times are compared with the runtime's own clock; systemClock.test.ts covers a runtime that has no zone.
vi.mock('../systemClock', () => ({ systemClockBias: () => undefined, systemClockZone: () => undefined, onSystemClock: (when: number | string | Date) => new Date(when),
  correctionFor: (bias: number | undefined, offset: number) => (bias !== undefined && bias !== offset ? bias : undefined) }));

vi.mock('vscode', () => ({
  ViewColumn: { One: 1, Active: 1 },
  commands: { executeCommand: vi.fn() },
  window: {
    showInformationMessage: vi.fn(), showErrorMessage: vi.fn(), showWarningMessage: vi.fn(),
  },
}));

import { ChatViewProvider } from '../ChatViewProvider';
import { formatLocalInstant } from '../localInstant';
import { jobOutcomeAnchor } from '../../observability/JobOutcomeAnchor';
import type { JobOutcomeViewV1, JobUsageLookup } from '../../observability/JobOutcome';
import { noJobUsage } from '../../observability/JobOutcomeUsage';
import {
  REQUEST_SUMMARY_STATES, REQUEST_TERMINAL_KINDS, displayedJobOutcomeView, projectRequestSummary, withEarlierRevisions,
  type RequestCloseoutRecordV1, type RequestLimitsObservation, type RequestRunObservation, type RequestSummaryViewV1,
  type RequestTerminalFact,
} from '../../observability/RequestCloseout';
import { RequestCloseoutAccumulator, RequestFileEffects, reviseForClosedRun, reviseForFileEffects, reviseForLimits, type RequestCloseoutFinish } from '../../session/RequestCloseoutAccumulator';
import { TurnOutcomeAccumulator } from '../../session/turnOutcomeReceipt';
import { bootWebviewScript, type WebviewElement } from './support/webviewBoot';
import { revealInOsLabel } from '../../host/fileActions';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import { agentConfig, navigationHost, settle, tempFolder } from './support/fileNavigationHost';
import { evaluateWiring, extensionWiring } from './support/extensionWiring';

/*
 * v0.9.94: one Request summary card per top-level turn, after the item that ended the turn.
 * v0.9.103 (one request, one result): one card per request, after the item that ended its latest turn shown.
 */

const at = (second: number): string => new Date(Date.UTC(2026, 9, 8, 10, 0, second)).toISOString();

function recordOf(turnId: string, second: number, terminal: RequestTerminalFact = { kind: 'answered' }, requestId = 'req-1'): RequestCloseoutRecordV1 {
  const accumulator = new RequestCloseoutAccumulator({ requestId, rootAgentId: 'pm', originTurnId: 'turn-1', terminalTurnId: turnId });
  accumulator.route({ agentId: 'pm', backend: 'claude', model: 'opus' });
  return accumulator.finish({ terminal, recordedAt: at(second), eventsCut: terminal.kind !== 'answered' })!;
}

/** The record of a turn of a request that had a limit. */
function limitedRecordOf(turnId: string, second: number, limits: RequestLimitsObservation, requestId = 'req-1'): RequestCloseoutRecordV1 {
  const accumulator = new RequestCloseoutAccumulator({ requestId, rootAgentId: 'pm', originTurnId: 'turn-1', terminalTurnId: turnId });
  accumulator.route({ agentId: 'pm', backend: 'claude', model: 'opus' });
  return accumulator.finish({ terminal: { kind: 'answered' }, recordedAt: at(second), eventsCut: false, limits })!;
}

function jobView(runId: string): JobOutcomeViewV1 {
  return {
    schemaVersion: 1, id: `outcome:${runId}`, runId, available: true,
    headline: [{ text: 'Complete', tone: 'positive' }],
    sections: [{ title: 'Outcome', rows: [{ label: 'Completion', value: 'Complete' }] }],
    actions: [],
  };
}

interface Harness {
  chat: ChatViewProvider;
  records: RequestCloseoutRecordV1[];
  /** The closed runs the host knows, by id: whose run it is and the turn that closed it. */
  runs: Map<string, { coordinatorId: string; closingTurnId?: string }>;
  reply: (turnId: string, text?: string, isError?: boolean) => void;
  items: () => any[];
  cards: () => any[];
  cleared: string[];
  viewCalls: () => number;
  failViews: { on: boolean; job?: boolean };
  send: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  /** What the host was told of rendered items a later full state left out. */
  lost: ReturnType<typeof vi.fn>;
}

function harness(store: Map<string, unknown>, records: RequestCloseoutRecordV1[] = [], usage: JobUsageLookup = noJobUsage, extra: Record<string, unknown> = {}): Harness {
  let onReply: ((reply: unknown) => void) | undefined;
  const cleared: string[] = [];
  const failViews: { on: boolean; job?: boolean } = { on: false };
  let calls = 0;
  const send = vi.fn();
  const interrupt = vi.fn();
  const lost = vi.fn();
  const runs = new Map<string, { coordinatorId: string; closingTurnId?: string }>();
  const closeouts = (agentId: string): RequestCloseoutRecordV1[] => (agentId === 'pm' ? records : []);
  const chat = new ChatViewProvider({} as never, {
    listAgents: () => [{ id: 'pm', name: 'PM', role: 'pm' }, { id: 'arch', name: 'Architect', role: 'architect' }],
    send, interject: vi.fn(), interrupt,
    onReply: (cb: (reply: unknown) => void) => { onReply = cb; return vi.fn(); },
    state: {
      get: (key: string) => store.get(key),
      update: (key: string, value: unknown) => {
        if (value === undefined) store.delete(key); else store.set(key, structuredClone(value));
        return Promise.resolve();
      },
    },
    getApprovals: () => ({ command: 'ask', write: 'none' }),
    setApproval: vi.fn(),
    // As the extension gives it: the run's view with the limit facts of its closing turn's record.
    jobOutcomeView: (runId: string) => {
      if (failViews.job) throw new Error('projection failed');
      return displayedJobOutcomeView(jobView(runId), runs.get(runId),
        (agentId, turnId) => closeouts(agentId).find((record) => record.terminalTurnId === turnId));
    },
    requestCloseouts: closeouts,
    requestSummaryView: (record: RequestCloseoutRecordV1) => {
      calls += 1;
      if (failViews.on) throw new Error('projection failed');
      return projectRequestSummary(record, { usage });
    },
    clearRequestCloseouts: (agentId: string) => { cleared.push(agentId); },
    onRenderedTranscriptDisappearance: lost,
    ...extra,
  } as never);
  const items = (): any[] => (chat as any).currentState().messages;
  return {
    chat,
    records,
    runs,
    reply: (turnId, text = 'Done.', isError = false) => onReply!({
      from: 'pm', fromName: 'PM', text, isError, completionState: isError ? 'not-observed' : 'complete', turnId,
    }),
    items,
    cards: () => items().filter((item) => item.kind === 'requestSummary'),
    cleared,
    viewCalls: () => calls,
    failViews,
    send,
    interrupt,
    lost,
  };
}

describe('Request summary card placement', () => {
  it('shows one card right after the reply that ended its turn', () => {
    const h = harness(new Map(), [recordOf('turn-1', 10)]);
    h.reply('turn-1', 'It parses the header.');
    const items = h.items();
    const reply = items.findIndex((item) => item.kind === 'message' && item.turnId === 'turn-1');
    expect(h.cards()).toHaveLength(1);
    expect(items[reply + 1]).toMatchObject({ kind: 'requestSummary', id: 'request:req-1', recordId: 'request-closeout:req-1:turn-1' });
    expect(items[reply + 1].view).toMatchObject({ kind: 'request-summary', state: 'answered' });
    expect(items[reply + 1].view.headline[0]).toEqual({ text: 'Answered', tone: 'neutral' });
  });

  it('stays directly under the reply that ended its turn when a later job puts its delegation card on that reply', () => {
    // The Owner's field run of 2026-10-10, the Senior Developer's chat. It answered a direct request at 13:32. At
    // 13:34 a coordinator dispatched a task to it, and that job's card is placed on the latest item before its
    // start, which is that reply. The card came between the reply and the reply's own Request summary, so the
    // summary of the 13:32 turn read as if it belonged to the job above it.
    const h = harness(new Map(), [recordOf('turn-1', 10)]);
    h.reply('turn-1', 'OK');
    const later = new Date(Date.now() + 120_000).toISOString();
    h.chat.setDelegationProgress([{
      id: 'delegation-run-1', coordinatorId: 'arch', coordinatorName: 'Architect', startedAt: later,
      total: 1, done: 0, partial: 0, blocked: 0, working: 1,
      items: [{ agentId: 'pm', agentName: 'PM', state: 'working' }],
    }] as never);
    const order = h.items().map((item) => item.kind);
    const reply = h.items().findIndex((item) => item.kind === 'message' && item.turnId === 'turn-1');
    expect(order.slice(reply, reply + 3)).toEqual(['message', 'requestSummary', 'delegation']);
  });

  it('keeps a Job outcome behind the delegation card placed on its closing reply', () => {
    // The Job outcome is the card of the whole job, so it stays below the job's own delegation card.
    const h = harness(new Map(), [recordOf('turn-close', 40)]);
    h.reply('turn-close', 'The review is done.');
    const later = new Date(Date.now() + 1_000).toISOString();
    h.chat.setDelegationProgress([{
      id: 'delegation-run-1', coordinatorId: 'pm', coordinatorName: 'PM', startedAt: later,
      total: 1, done: 1, partial: 0, blocked: 0, working: 0,
      items: [{ agentId: 'arch', agentName: 'Architect', state: 'done' }],
    }] as never);
    h.chat.upsertJobOutcomeAnchors([jobOutcomeAnchor({ runId: 'run-1', coordinatorId: 'pm', closingTurnId: 'turn-close', endedAt: at(40) })!]);
    const reply = h.items().findIndex((item) => item.kind === 'message' && item.turnId === 'turn-close');
    expect(h.items().map((item) => item.kind).slice(reply, reply + 3)).toEqual(['message', 'delegation', 'jobOutcome']);
  });

  it('places no card when its turn is not in this transcript: no position is guessed', () => {
    const h = harness(new Map(), [recordOf('turn-never-shown', 10)]);
    h.reply('another-turn');
    expect(h.cards()).toEqual([]);
    h.reply('turn-never-shown', 'Now it is here.');
    expect(h.items().at(-1)).toMatchObject({ kind: 'requestSummary' });
    expect(h.items().at(-2)).toMatchObject({ kind: 'message', turnId: 'turn-never-shown' });
  });

  it('follows the host\'s own terminal item for a turn the person stopped', () => {
    const h = harness(new Map(), [recordOf('turn-1', 10, { kind: 'stopped' })]);
    h.reply('turn-1', 'Stopped by user.', true);
    const items = h.items();
    expect(items.at(-1)).toMatchObject({ kind: 'requestSummary' });
    expect(items.at(-1).view.headline[0]).toEqual({ text: 'Stopped', tone: 'caution' });
    expect(items.at(-2)).toMatchObject({ kind: 'message', turnId: 'turn-1', isError: true });
  });

  it('shows the same single card again after a restart', () => {
    const store = new Map<string, unknown>();
    const records = [recordOf('turn-1', 10)];
    const first = harness(store, records);
    first.reply('turn-1');
    const shown = first.cards();
    const restored = harness(store, records);
    expect(restored.cards()).toEqual(shown);
    expect(restored.cards()).toHaveLength(1);
  });

  it('shows the Job outcome and no Request summary for the turn that closed a run', () => {
    const h = harness(new Map(), [recordOf('turn-close', 40)]);
    h.reply('turn-close', 'The review is done.');
    expect(h.cards()).toHaveLength(1);
    h.chat.upsertJobOutcomeAnchors([jobOutcomeAnchor({ runId: 'run-1', coordinatorId: 'pm', closingTurnId: 'turn-close', endedAt: at(40) })!]);
    expect(h.cards()).toEqual([]);
    expect(h.items().filter((item) => item.kind === 'jobOutcome')).toHaveLength(1);
    // v0.9.103: and the turn's own Request summary is not an earlier report of the request either: a turn has one report.
    const [job] = h.items().filter((item) => item.kind === 'jobOutcome');
    expect(job).toMatchObject({ requestId: 'req-1' });
    expect(job.reports).toBeUndefined();
    expect(job.earlier).toBeUndefined();
  });

  it('shows one card for the request whose dispatching turn reported and whose closing turn closed its run: the Job outcome, with the earlier report in its details', () => {
    // v0.9.103 (one request, one result). Until 0.9.103 this request showed two cards, one per turn: the dispatching
    // turn's Request summary and the closing turn's Job outcome.
    const h = harness(new Map(), [recordOf('turn-dispatch', 10), recordOf('turn-close', 40)]);
    h.reply('turn-dispatch', 'Dispatched. I will report back.');
    // Before the run closes, the request's card is its latest report, after the reply of that report's turn.
    h.reply('turn-close', 'The review is done.');
    const pending = h.items().filter((item) => item.kind !== 'message');
    expect(pending.map((item) => `${item.kind}:${item.id}`)).toEqual(['requestSummary:request:req-1']);
    expect(pending[0]).toMatchObject({ recordId: 'request-closeout:req-1:turn-close', reports: 2 });
    expect(pending[0].earlier.map((report: any) => report.id)).toEqual(['request-closeout:req-1:turn-dispatch']);
    expect(h.items().at(-1).kind).toBe('requestSummary');

    h.chat.upsertJobOutcomeAnchors([jobOutcomeAnchor({ runId: 'run-1', coordinatorId: 'pm', closingTurnId: 'turn-close', endedAt: at(40) })!]);
    const kinds = h.items().filter((item) => item.kind !== 'message').map((item) => `${item.kind}:${item.id}`);
    expect(kinds).toEqual(['jobOutcome:outcome:run-1']);
    const [card] = h.items().filter((item) => item.kind === 'jobOutcome');
    // The run's own view, as the run's projection gave it; the request's earlier report beside it, not inside it.
    expect(card.view).toEqual(jobView('run-1'));
    expect(card).toMatchObject({ requestId: 'req-1', reports: 2 });
    expect(card.earlier).toHaveLength(1);
    expect(card.earlier[0]).toMatchObject({ id: 'request-closeout:req-1:turn-dispatch', recordedAt: at(10) });
    expect(card.earlier[0].headline[0]).toEqual({ text: 'Answered', tone: 'neutral' });
    expect(h.items().at(-1).kind).toBe('jobOutcome');
    // The dispatching turn's reply is followed by no card of its own.
    const items = h.items();
    expect(items[items.findIndex((item) => item.turnId === 'turn-dispatch') + 1]).toMatchObject({ kind: 'message', turnId: 'turn-close' });
  });

  it('keeps two requests that ran at the same time apart: each has its own card, after its own latest reply', () => {
    const h = harness(new Map(), [
      recordOf('turn-a1', 10, { kind: 'answered' }, 'req-a'),
      recordOf('turn-b1', 20, { kind: 'answered' }, 'req-b'),
      recordOf('turn-a2', 30, { kind: 'answered' }, 'req-a'),
    ]);
    h.reply('turn-a1', 'A is with Dev.');
    h.reply('turn-b1', 'B is answered.');
    h.reply('turn-a2', 'A is done.');
    const order = h.items().map((item) => (item.kind === 'message' ? `msg:${item.turnId}` : `${item.kind}:${item.id}`));
    expect(order).toEqual(['msg:turn-a1', 'msg:turn-b1', 'requestSummary:request:req-b', 'msg:turn-a2', 'requestSummary:request:req-a']);
    expect(h.cards().map((card) => card.earlier?.map((report: any) => report.id) ?? [])).toEqual([[], ['request-closeout:req-a:turn-a1']]);
    expect(h.chat.requestSummaryCards('pm')).toEqual([
      { recordId: 'request-closeout:req-b:turn-b1', state: 'answered' },
      { recordId: 'request-closeout:req-a:turn-a1', state: 'answered' },
      { recordId: 'request-closeout:req-a:turn-a2', state: 'answered' },
    ]);
  });

  describe('the limit facts of a request whose turn shows a Job outcome', () => {
    // The Owner's field run of 2026-10-10. The request was stopped at its limit after it had become a job. The
    // turn's one card is the Job outcome; the rows that say what the limit did are on the Request summary, which
    // that turn does not show.
    const continued: RequestLimitsObservation = {
      coverage: 'partial', providerTurns: { ceiling: 1, observed: 1, hostCountedTurns: 1 }, crossings: 1, allowances: 1, decision: 'continued',
    };
    const stopped: RequestLimitsObservation = {
      coverage: 'partial', providerTurns: { ceiling: 1, observed: 2, hostCountedTurns: 1 }, crossings: 2, allowances: 1, decision: 'stopped',
    };
    /** The run closes at this turn: the host holds it so, and Chat is given its anchor. */
    const closeAt = (h: Harness, turnId: string): void => {
      h.runs.set('run-1', { coordinatorId: 'pm', closingTurnId: turnId });
      h.chat.upsertJobOutcomeAnchors([jobOutcomeAnchor({ runId: 'run-1', coordinatorId: 'pm', closingTurnId: turnId, endedAt: at(40) })!]);
    };
    const jobCards = (h: Harness) => h.items().filter((item) => item.kind === 'jobOutcome');
    const limitSection = (card: any) => card.view.sections.find((section: any) => section.title === 'Request limit');

    it('shows them on that Job outcome, and still one card for the turn', () => {
      const h = harness(new Map(), [limitedRecordOf('turn-close', 40, stopped)]);
      h.reply('turn-close', 'Dispatched. I will report back.');
      // Alone, the Request summary has the rows.
      expect(JSON.stringify(h.cards()[0].view)).toContain('2 times; continued 1 time; then stopped');

      closeAt(h, 'turn-close');
      expect(h.cards()).toEqual([]);
      const cards = jobCards(h);
      expect(cards).toHaveLength(1);
      expect(limitSection(cards[0])).toEqual({
        title: 'Request limit',
        rows: [
          { label: 'Model requests and host-counted turns against the limit', value: '2 observed (1 host-counted turn), limit 1' },
          { label: 'Limit reached', value: '2 times; continued 1 time; then stopped', tone: 'caution' },
        ],
        note: expect.stringContaining('These totals may be a lower bound.'),
      });
      // The run's own section comes first and is as the run's projection gave it.
      expect(cards[0].view.sections[0]).toEqual({ title: 'Outcome', rows: [{ label: 'Completion', value: 'Complete' }] });
    });

    it('reads them from the record of that exact turn, and from no other turn of the conversation', () => {
      // The dispatching turn's record has limit facts. The closing turn's record has none.
      const h = harness(new Map(), [limitedRecordOf('turn-dispatch', 10, stopped), recordOf('turn-close', 40)]);
      h.reply('turn-dispatch', 'Dispatched. I will report back.');
      h.reply('turn-close', 'The review is done.');
      closeAt(h, 'turn-close');
      expect(limitSection(jobCards(h)[0])).toBeUndefined();
      // v0.9.103: the dispatching turn's report is the request's earlier report, on the request's one card, with its own rows.
      expect(h.cards()).toEqual([]);
      expect(JSON.stringify(jobCards(h)[0].earlier)).toContain('2 times; continued 1 time; then stopped');
    });

    it('adds no section for a request that had no limit', () => {
      const h = harness(new Map(), [recordOf('turn-close', 40)]);
      h.reply('turn-close', 'The review is done.');
      closeAt(h, 'turn-close');
      expect(jobCards(h)[0].view.sections.map((section: any) => section.title)).toEqual(['Outcome']);
    });

    it('shows the facts as the record has them after it was brought up to date, and renders the card again', () => {
      const h = harness(new Map(), [limitedRecordOf('turn-close', 40, continued)]);
      h.reply('turn-close', 'Dispatched. I will report back.');
      closeAt(h, 'turn-close');
      const before = jobCards(h)[0];
      expect(limitSection(before).rows).toContainEqual({ label: 'Limit reached', value: '1 time; continued 1 time', tone: 'caution' });

      // The person stopped the request after that turn had ended; the record is revised.
      h.records[0] = reviseForLimits(h.records[0], stopped)!;
      // The extension's pass: the records first, then the cards are read again.
      h.chat.refreshJobOutcomes();
      h.chat.refreshRequestSummaries();
      const after = jobCards(h)[0];
      expect(limitSection(after).rows).toContainEqual({ label: 'Limit reached', value: '2 times; continued 1 time; then stopped', tone: 'caution' });
      expect(after.id).toBe(before.id);
      expect(after.renderKey).not.toBe(before.renderKey);
      expect(after.renderKey.startsWith(`${after.id}:`)).toBe(true);
      expect(jobCards(h)).toHaveLength(1);
      // Read again with nothing new, the card is the same card: nothing is rendered for it.
      h.chat.refreshJobOutcomes();
      expect(jobCards(h)[0].renderKey).toBe(after.renderKey);
    });

    it('adds nothing of its own to the view it is given: the card is the view the evidence report is written from', () => {
      const h = harness(new Map(), [limitedRecordOf('turn-close', 40, stopped)]);
      h.reply('turn-close', 'Dispatched. I will report back.');
      // The host does not know the run's closing turn, so its view has no limit facts. Chat has the record of
      // that turn and the anchor, and still shows what it was given.
      h.chat.upsertJobOutcomeAnchors([jobOutcomeAnchor({ runId: 'run-1', coordinatorId: 'pm', closingTurnId: 'turn-close', endedAt: at(40) })!]);
      expect(jobCards(h)[0].view).toEqual(jobView('run-1'));
    });
  });

  describe('a Request summary that the Job outcome of its turn replaced', () => {
    // The Owner's field run of 2026-10-10: at the instant a job closed, the log said twice, once for each
    // surface, `display-bug: received full state omitted a rendered transcript item` for the closing turn's
    // Request summary. The summary stands at the turn until the run's close is recorded; the Job outcome then
    // takes its place, as designed. The detector had no word of that.
    const missing = (h: Harness, ids: string[]): void => {
      (h.chat as any).onMessage({
        command: 'renderedTranscriptItemsMissing', agentId: 'pm', cause: 'unexplained',
        previousItemCount: 4, nextItemCount: 4,
        missing: ids.map((id) => ({ id, delivery: 'committed' })),
        previousTurnEpoch: 5, nextTurnEpoch: 5, epochChanged: false,
      }, 'workbench');
    };
    const closed = (h: Harness, turnId: string): void => {
      h.chat.upsertJobOutcomeAnchors([jobOutcomeAnchor({ runId: 'run-1', coordinatorId: 'pm', closingTurnId: turnId, endedAt: at(40) })!]);
    };

    it('is not reported as a rendered item that was lost', () => {
      const h = harness(new Map(), [recordOf('turn-close', 40)]);
      h.reply('turn-close', 'The review is done.');
      expect(h.cards()).toHaveLength(1);
      closed(h, 'turn-close');
      expect(h.cards()).toEqual([]);
      expect(h.items().filter((item) => item.kind === 'jobOutcome')).toHaveLength(1);

      missing(h, ['summary:request-closeout:req-1:turn-close']);
      expect(h.lost).not.toHaveBeenCalled();
      expect((h.chat as any).renderedTranscriptDisappearanceLog()).toHaveLength(0);
    });

    it('still reports a Request summary that left with no Job outcome at its turn', () => {
      const h = harness(new Map(), [recordOf('turn-1', 10), recordOf('turn-close', 40)]);
      h.reply('turn-1', 'It parses the header.');
      h.reply('turn-close', 'The review is done.');
      closed(h, 'turn-close');

      // Another turn's summary is gone: the Job outcome stands at the closing turn, not at this one.
      missing(h, ['summary:request-closeout:req-1:turn-1']);
      expect(h.lost).toHaveBeenCalledTimes(1);
      expect(h.lost.mock.calls[0][0]).toMatchObject({ classification: 'display-bug', missing: [{ id: 'summary:request-closeout:req-1:turn-1', delivery: 'committed' }] });
      // A summary whose record is not kept cannot be shown to have been replaced.
      missing(h, ['summary:request-closeout:req-9:turn-close']);
      expect(h.lost).toHaveBeenCalledTimes(2);
    });

    it('still reports it when no Job outcome is placed at the turn, and reports whatever else left with it', () => {
      const h = harness(new Map(), [recordOf('turn-close', 40)]);
      h.reply('turn-close', 'The review is done.');
      // No run has closed at this turn.
      missing(h, ['summary:request-closeout:req-1:turn-close']);
      expect(h.lost).toHaveBeenCalledTimes(1);

      closed(h, 'turn-close');
      // The summary was replaced; the message that left in the same state was not.
      missing(h, ['summary:request-closeout:req-1:turn-close', 'msg:7']);
      expect(h.lost).toHaveBeenCalledTimes(2);
      expect(h.lost.mock.calls[1][0].missing).toEqual([{ id: 'msg:7', delivery: 'committed' }]);
    });

    it('v0.9.106: a Job outcome that a later report of its request took over is not reported as lost; any other still is', () => {
      // A request with two runs: the first closed at turn 1, the request went on and reported again at its last turn.
      const h = harness(new Map(), [recordOf('turn-1', 10), recordOf('turn-close', 40)]);
      h.reply('turn-1', 'Dev wrote it; the review is next.');
      h.chat.upsertJobOutcomeAnchors([jobOutcomeAnchor({ runId: 'run-1', coordinatorId: 'pm', closingTurnId: 'turn-1', endedAt: at(20) })!]);
      h.reply('turn-close', 'The review is done.');
      const cards = h.items().filter((item) => item.kind === 'jobOutcome' || item.kind === 'requestSummary') as any[];
      // One card for the request: the later report, with the run's Job outcome among its earlier reports.
      expect(cards).toHaveLength(1);
      expect(cards[0].id).not.toBe('outcome:run-1');
      expect((cards[0].earlier ?? []).map((report: { id: string }) => report.id)).toContain('outcome:run-1');

      missing(h, ['outcome:outcome:run-1']);
      expect(h.lost).not.toHaveBeenCalled();
      // A Job outcome no card holds as an earlier report is still a lost item.
      missing(h, ['outcome:outcome:run-9']);
      expect(h.lost).toHaveBeenCalledTimes(1);
    });

    it('still reports it when the Job outcome of its turn could not be shown: nothing took its place', () => {
      const h = harness(new Map(), [recordOf('turn-close', 40)]);
      h.reply('turn-close', 'The review is done.');
      h.failViews.job = true;
      closed(h, 'turn-close');
      expect(h.cards()).toEqual([]);
      expect(h.items().filter((item) => item.kind === 'jobOutcome')).toEqual([]);
      missing(h, ['summary:request-closeout:req-1:turn-close']);
      expect(h.lost).toHaveBeenCalledTimes(1);
    });
  });

  it('replaces a card in place when its record is revised, and never adds one', () => {
    const records = [recordOf('turn-1', 10)];
    const h = harness(new Map(), records);
    h.reply('turn-1');
    h.reply('turn-2', 'A later reply.');
    const before = h.cards()[0];
    records[0] = { ...records[0], revision: 2, terminal: { kind: 'tool-only' } };
    h.chat.refreshRequestSummaries();
    const after = h.cards();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
    expect(after[0].seq).toBe(before.seq);
    expect(after[0].renderKey).not.toBe(before.renderKey);
    expect(after[0].view.headline[0].text).toBe('No conclusion recorded');
    // A later reply did not take the card: it still follows its own turn.
    const items = h.items();
    expect(items[items.findIndex((item) => item.kind === 'requestSummary') - 1]).toMatchObject({ turnId: 'turn-1' });
  });

  it('projects a card once per revision, and again when the facts behind it may have changed', () => {
    const records = [recordOf('turn-1', 10)];
    const h = harness(new Map(), records);
    h.reply('turn-1');
    const projected = h.viewCalls();
    expect(projected).toBeGreaterThan(0);
    h.items();
    h.items();
    expect(h.viewCalls()).toBe(projected);
    // A refresh reads the facts again: a spend unit may have settled.
    h.chat.refreshRequestSummaries();
    expect(h.viewCalls()).toBeGreaterThan(projected);
    // A new revision is projected without waiting for a refresh.
    const afterRefresh = h.viewCalls();
    records[0] = { ...records[0], revision: 2 };
    h.items();
    expect(h.viewCalls()).toBe(afterRefresh + 1);
  });

  it('leaves the card out and the conversation whole when the view cannot be produced', () => {
    const h = harness(new Map(), [recordOf('turn-1', 10)]);
    h.failViews.on = true;
    h.reply('turn-1', 'It parses the header.');
    expect(h.cards()).toEqual([]);
    expect(h.items().filter((item) => item.kind === 'message')).toHaveLength(1);
  });

  it('shows no Request summary for a conversation from before this version, and keeps its Job outcome card', () => {
    // What 0.9.93 left behind: replies with their turn ids, one Job outcome anchor, and no closeout record at all.
    const store = new Map<string, unknown>();
    const before = harness(store, []);
    before.reply('turn-old-1', 'An answer from before the update.');
    before.reply('turn-old-2', 'The review is done.');
    before.chat.upsertJobOutcomeAnchors([jobOutcomeAnchor({ runId: 'run-old', coordinatorId: 'pm', closingTurnId: 'turn-old-2', endedAt: at(40) })!]);

    const after = harness(store, []);
    expect(after.cards()).toEqual([]);
    expect(after.viewCalls()).toBe(0);
    expect(after.items().filter((item) => item.kind === 'jobOutcome').map((item) => item.id)).toEqual(['outcome:run-old']);
    // A turn after the update gets its card; the earlier turns still have none.
    after.records.push(recordOf('turn-new', 50));
    after.reply('turn-new', 'An answer after the update.');
    expect(after.cards().map((card) => card.id)).toEqual(['request:req-1']);
  });

  it('clears the records with the conversation', () => {
    const h = harness(new Map(), [recordOf('turn-1', 10)]);
    h.reply('turn-1');
    h.chat.clearAgent('pm');
    expect(h.cleared).toEqual(['pm']);
  });

  it('names the turns the conversation still shows', () => {
    const h = harness(new Map(), []);
    h.reply('turn-1', 'One.');
    h.reply('turn-2', 'Two.');
    expect([...h.chat.retainedTurnIds('pm')]).toEqual(['turn-1', 'turn-2']);
    expect([...h.chat.retainedTurnIds('arch')]).toEqual([]);
  });

  it('reads and renders only: showing, refreshing and restoring a card starts nothing', () => {
    const store = new Map<string, unknown>();
    const records = [recordOf('turn-1', 10)];
    const h = harness(store, records);
    h.reply('turn-1');
    h.items();
    h.chat.refreshRequestSummaries();
    harness(store, records).items();
    expect(h.viewCalls()).toBeGreaterThan(0);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.interrupt).not.toHaveBeenCalled();
    expect(h.cleared).toEqual([]);
    // The store holds the conversation, and no key of the cards: Chat keeps nothing of a card but what it shows.
    expect([...store.keys()].some((key) => key.includes('requestCloseout'))).toBe(false);
  });
});

/*
 * v0.9.103 (one request, one result): what the request's one card offers, and where a card whose reply is no longer in
 * the transcript stays. The production-entry flow is in ActivatedExtension.flows.test.ts.
 */
describe('a request\'s one card: its entries, its main action and the results whose reply is not shown', () => {
  function writtenRecord(requestId: string, turnId: string, second: number, paths: string[]): RequestCloseoutRecordV1 {
    const effects = new RequestFileEffects();
    paths.forEach((path, index) => effects.effect({ path, key: `k-${turnId}-${index}`, operation: 'write', grade: 'host-verified' }));
    const accumulator = new RequestCloseoutAccumulator({ requestId, rootAgentId: 'pm', originTurnId: turnId, terminalTurnId: turnId }, effects);
    accumulator.route({ agentId: 'pm', backend: 'claude', model: 'opus' });
    return accumulator.finish({ terminal: { kind: 'answered' }, recordedAt: at(second), eventsCut: false })!;
  }

  // v0.9.104 (ROADMAP item 6, L4, the Owner): after Import Chat replaced the chat with an older export, a report newer
  // than the export's newest message was taken as still waiting for its reply, and hidden until a new message came.
  // A turn from before the import can never reply in this chat (its epoch is refused), so its report is not waiting.
  it('L4: after Import Chat replaces the chat with an older export, earlier results show at once; a later report still waits', async () => {
    const store = new Map<string, unknown>();
    const records = [writtenRecord('req-before', 'turn-before', 30, ['docs/before.md'])];
    const h = harness(store, records);
    h.reply('turn-before', 'The answer before the import.');
    expect(h.cards().map((card) => card.id)).toEqual(['request:req-before']);
    // The person imports an export older than that report: its newest message is from second 10.
    expect(h.chat.importToSelected([
      { role: 'user', text: 'An old question.', ts: at(5) },
      { role: 'agent', text: 'An old answer.', ts: at(10), fromName: 'PM' },
    ])).toBe(true);
    const earlier = h.items().find((item) => item.kind === 'earlierResults');
    expect(earlier?.cards.map((card: any) => [card.id, card.reply])).toEqual([['request:req-before', 'not-shown']]);
    // The card keeps its file entry, which the existing Earlier results flow opens.
    expect(JSON.stringify(earlier?.cards[0])).toContain('docs/before.md');
    // Persisted: a new provider on the same storage shows it too.
    const reloaded = harness(store, records);
    expect(reloaded.items().find((item) => item.kind === 'earlierResults')?.cards.map((card: any) => card.id)).toEqual(['request:req-before']);
    // A report recorded after the import whose reply has not reached the chat yet still waits for it, as before.
    const later = new Date(Date.now() + 60_000).toISOString();
    const accumulator = new RequestCloseoutAccumulator({ requestId: 'req-after', rootAgentId: 'pm', originTurnId: 'turn-after', terminalTurnId: 'turn-after' });
    accumulator.route({ agentId: 'pm', backend: 'claude', model: 'opus' });
    records.push(accumulator.finish({ terminal: { kind: 'answered' }, recordedAt: later, eventsCut: false })!);
    const ids = h.items().flatMap((item) => item.kind === 'earlierResults' ? item.cards.map((card: any) => card.id) : item.kind === 'requestSummary' ? [item.id] : []);
    expect(ids).not.toContain('request:req-after');
  });

  // Codex's audit of c6dc2467, F1: with a host clock set back between the result and the import, a time comparison
  // put the result after the import. The results the chat had are named by id, so no clock can misorder them.
  it('L4: a result stays reachable when the host clock was set back before the import of an older export', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(at(30)));
      const store = new Map<string, unknown>();
      const records = [writtenRecord('req-clock', 'turn-clock', 30, ['docs/before.md'])];
      const h = harness(store, records);
      h.reply('turn-clock', 'The answer at second 30.');
      expect(h.cards().map((card) => card.id)).toEqual(['request:req-clock']);
      vi.setSystemTime(new Date(at(20)));
      expect(h.chat.importToSelected([{ role: 'agent', text: 'An old answer.', ts: at(10), fromName: 'PM' }])).toBe(true);
      const ids = (items: any[]) => items.flatMap((item) => item.kind === 'earlierResults' ? item.cards.map((card: any) => card.id) : item.kind === 'requestSummary' ? [item.id] : []);
      expect(ids(h.items())).toEqual(['request:req-clock']);
      expect(ids(harness(store, records).items())).toEqual(['request:req-clock']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('L4: a Job outcome the chat had stays reachable after the import of an older export, like a Request summary', () => {
    const store = new Map<string, unknown>();
    const h = harness(store, [recordOf('turn-close', 40)]);
    h.reply('turn-close', 'The review is done.');
    h.chat.upsertJobOutcomeAnchors([jobOutcomeAnchor({ runId: 'run-1', coordinatorId: 'pm', closingTurnId: 'turn-close', endedAt: at(40) })!]);
    const outcomeIds = (items: any[]) => items.flatMap((item) => item.kind === 'earlierResults'
      ? item.cards.filter((card: any) => card.kind === 'jobOutcome').map((card: any) => card.id)
      : item.kind === 'jobOutcome' ? [item.id] : []);
    const before = outcomeIds(h.items());
    expect(before).toHaveLength(1);
    expect(h.chat.importToSelected([{ role: 'agent', text: 'An old answer.', ts: at(10), fromName: 'PM' }])).toBe(true);
    expect(outcomeIds(h.items())).toEqual(before);
  });

  it('offers the files the request wrote, the first as the one main action, and opens one only from the record of a card it shows', () => {
    const opened: Array<{ agentId: string; path: string; stillShown: () => boolean }> = [];
    const refused: string[] = [];
    const h = harness(new Map(), [writtenRecord('req-1', 'turn-1', 10, ['docs/plan.md', 'src/a.ts'])], noJobUsage, {
      openWorkspaceFile: (agentId: string, path: string, stillShown: () => boolean) => { opened.push({ agentId, path, stillShown }); },
      fileNavigationRefused: (reason: string) => { refused.push(reason); },
    });
    h.reply('turn-1', 'Both are written.');
    const [card] = h.cards();
    // v0.9.108 (L1): each file also offers Reveal, in VS Code's words for this platform.
    const reveal = revealInOsLabel(process.platform);
    expect(card.entries).toEqual([
      { id: 'file:0', label: 'Open plan.md', title: 'Open docs/plan.md in the editor.', section: 'Changes',
        actions: [{ id: 'reveal', label: reveal, title: `${reveal}: show docs/plan.md in its folder.` }] },
      { id: 'file:1', label: 'Open a.ts', title: 'Open src/a.ts in the editor.', section: 'Changes',
        actions: [{ id: 'reveal', label: reveal, title: `${reveal}: show src/a.ts in its folder.` }] },
    ]);
    expect(card.primary).toBe('file:0');
    const send = (message: unknown) => (h.chat as any).onMessage(message, 'sidebar');
    send({ command: 'requestCardOpen', agentId: 'pm', recordId: card.recordId, entry: 'file:1' });
    expect(opened.map((entry) => [entry.agentId, entry.path])).toEqual([['pm', 'src/a.ts']]);
    expect(opened[0].stillShown()).toBe(true);
    // An entry the card does not offer, a record no card shows, and another conversation open nothing.
    send({ command: 'requestCardOpen', agentId: 'pm', recordId: card.recordId, entry: 'file:7' });
    send({ command: 'requestCardOpen', agentId: 'pm', recordId: 'request-closeout:req-9:turn-1', entry: 'file:0' });
    send({ command: 'requestCardOpen', agentId: 'arch', recordId: card.recordId, entry: 'file:0' });
    send({ command: 'requestCardOpen', agentId: 'pm', recordId: card.recordId, entry: 'docs/plan.md' });
    expect(opened).toHaveLength(1);
    expect(refused).toEqual(['unknown-receipt', 'unknown-receipt', 'not-shown']);

    // The emitted renderer: one main button, the rest secondary; pressing it names the record and the entry only.
    const boot = bootWebviewScript((h.chat as any).getHtml({ cspSource: 'test:' }, 'sidebar') as string);
    const all = (node: any): any[] => (Array.isArray(node?.children) ? node.children : []).flatMap((child: any) => [child, ...all(child)]);
    // The Linux reveal label, Open Containing Folder, also starts with "Open "; only the file buttons are counted here.
    const buttons = all(boot.elements.get('transcript')).filter((node) => node.type === 'button' && String(node.textContent).startsWith('Open ') && node.textContent !== reveal);
    expect(buttons.map((button) => [button.textContent, button.className])).toEqual([['Open plan.md', 'primary'], ['Open a.ts', 'secondary']]);
    boot.dispatchElementEvent(buttons[0], 'click');
    expect(boot.postedMessages.at(-1)).toEqual({ command: 'requestCardOpen', agentId: 'pm', recordId: card.recordId, entry: 'file:0' });
  });

  /*
   * v0.9.108 (L1): the delivery card's buttons for a delivered file. Open opens an Office or PDF file with its default
   * app; each file offers Reveal in VS Code's words for the platform; a DOCX or PPTX offers Export PDF only where the
   * native export exists. A press names the record, the entry and the action; the host runs it through the real
   * navigation boundary only when this card offers that action for that entry.
   */
  describe('v0.9.108 L1: a delivered file\'s Open, Reveal and Export PDF on its card', () => {
    function cardOn(platform: NodeJS.Platform, extra: Record<string, unknown> = {}) {
      const h = harness(new Map(), [writtenRecord('req-1', 'turn-1', 10, ['docs/report.docx', 'docs/sheet.xlsx', 'docs/plan.md'])], noJobUsage, { platform, ...extra });
      h.reply('turn-1', 'Written.');
      return { h, card: h.cards()[0] };
    }
    const entryView = (entry: any) => [entry.label, entry.title, (entry.actions ?? []).map((action: any) => `${action.id}:${action.label}`)];

    it('offers the buttons by the file\'s type and the platform', () => {
      expect(cardOn('win32').card.entries.map(entryView)).toEqual([
        ['Open report.docx', 'Open docs/report.docx with its default app.', ['reveal:Reveal in File Explorer', 'export-pdf:Export PDF']],
        ['Open sheet.xlsx', 'Open docs/sheet.xlsx with its default app.', ['reveal:Reveal in File Explorer']],
        ['Open plan.md', 'Open docs/plan.md in the editor.', ['reveal:Reveal in File Explorer']],
      ]);
      expect(cardOn('darwin').card.entries.map(entryView)[0]).toEqual(['Open report.docx', 'Open docs/report.docx with its default app.', ['reveal:Reveal in Finder']]);
      expect(cardOn('linux').card.entries.map(entryView)[0]).toEqual(['Open report.docx', 'Open docs/report.docx with its default app.', ['reveal:Open Containing Folder']]);
    });

    it('runs Reveal and Export PDF through the real navigation boundary, only for an action the card offers that entry', async () => {
      const ws = tempFolder({ 'docs/report.docx': 'docx', 'docs/sheet.xlsx': 'xlsx', 'docs/plan.md': '# plan' });
      try {
        const host = navigationHost([ws.root], [agentConfig('pm'), agentConfig('arch')]);
        const refused: string[] = [];
        const { h, card } = cardOn('win32', {
          // The extension's own wiring of the card's file navigation, over the real boundary.
          openWorkspaceFile: evaluateWiring(extensionWiring('ChatViewProvider', 1, 'openWorkspaceFile'), { orchestrationHost: host.adapter }),
          fileNavigationRefused: (reason: string) => { refused.push(reason); },
        });
        const send = (message: unknown) => (h.chat as any).onMessage(message, 'sidebar');
        send({ command: 'requestCardFileAction', agentId: 'pm', recordId: card.recordId, entry: 'file:0', action: 'export-pdf' });
        send({ command: 'requestCardFileAction', agentId: 'pm', recordId: card.recordId, entry: 'file:2', action: 'reveal' });
        await settle();
        expect(host.exported).toEqual([{ agentId: 'pm', path: path.join(ws.root, 'docs', 'report.docx') }]);
        expect(host.revealed).toEqual([path.join(ws.root, 'docs', 'plan.md')]);
        // Export PDF of a file whose entry does not offer it, an unknown action, another conversation and another
        // record reach nothing; the unknown action is refused at the protocol boundary.
        send({ command: 'requestCardFileAction', agentId: 'pm', recordId: card.recordId, entry: 'file:1', action: 'export-pdf' });
        send({ command: 'requestCardFileAction', agentId: 'pm', recordId: card.recordId, entry: 'file:0', action: 'delete' });
        send({ command: 'requestCardFileAction', agentId: 'arch', recordId: card.recordId, entry: 'file:0', action: 'export-pdf' });
        send({ command: 'requestCardFileAction', agentId: 'pm', recordId: 'request-closeout:req-9:turn-1', entry: 'file:0', action: 'reveal' });
        await settle();
        expect(host.exported).toHaveLength(1);
        expect(host.revealed).toHaveLength(1);
        expect(refused).toEqual(['unknown-receipt', 'not-shown', 'unknown-receipt']);
        // A file deleted after the card was shown: the boundary finds it missing and exports nothing.
        rmSync(path.join(ws.root, 'docs', 'report.docx'));
        send({ command: 'requestCardFileAction', agentId: 'pm', recordId: card.recordId, entry: 'file:0', action: 'export-pdf' });
        await settle();
        expect(host.exported).toHaveLength(1);
        expect(host.notices.at(-1)?.message).toBe('"docs/report.docx" does not exist. It may have been moved, renamed or deleted.');
      } finally {
        ws.cleanup();
      }
    });

    it('the emitted card keeps each file\'s buttons together, and a press names only the record, the entry and the action', () => {
      const { h, card } = cardOn('win32');
      const html = (h.chat as any).getHtml({ cspSource: 'test:' }, 'sidebar') as string;
      // A narrow sidebar (checked at 170, 300 and 420px in headless Edge): a file's buttons wrap as one group, and the
      // card's column takes the card's width instead of running past its clipped edge.
      expect(html).toContain('.job-outcome-file { display: inline-flex; flex-wrap: wrap; gap: 3px; max-width: 100%; }');
      expect(html).toContain('grid-template-columns: repeat(auto-fit, minmax(min(210px, 100%), 1fr));');
      const boot = bootWebviewScript(html);
      const all = (node: any): any[] => (Array.isArray(node?.children) ? node.children : []).flatMap((child: any) => [child, ...all(child)]);
      const groups = all(boot.elements.get('transcript')).filter((node) => String(node.className) === 'job-outcome-file');
      expect(groups.map((group) => group.children.map((button: any) => [button.textContent, button.className]))).toEqual([
        [['Open report.docx', 'primary'], ['Reveal in File Explorer', 'secondary'], ['Export PDF', 'secondary']],
        [['Open sheet.xlsx', 'secondary'], ['Reveal in File Explorer', 'secondary']],
        [['Open plan.md', 'secondary'], ['Reveal in File Explorer', 'secondary']],
      ]);
      expect(groups[0].getAttribute?.('role') ?? groups[0].attributes?.role).toBe('group');
      boot.dispatchElementEvent(groups[0].children[2], 'click');
      expect(boot.postedMessages.at(-1)).toEqual({ command: 'requestCardFileAction', agentId: 'pm', recordId: card.recordId, entry: 'file:0', action: 'export-pdf' });
      boot.dispatchElementEvent(groups[1].children[1], 'click');
      expect(boot.postedMessages.at(-1)).toEqual({ command: 'requestCardFileAction', agentId: 'pm', recordId: card.recordId, entry: 'file:1', action: 'reveal' });
      boot.dispatchElementEvent(groups[0].children[0], 'click');
      expect(boot.postedMessages.at(-1)).toEqual({ command: 'requestCardOpen', agentId: 'pm', recordId: card.recordId, entry: 'file:0' });
    });
  });

  it('marks one main action on a Job outcome: its changes, or else its evidence', () => {
    const h = harness(new Map(), [recordOf('turn-close', 40)]);
    h.reply('turn-close', 'The review is done.');
    h.chat.upsertJobOutcomeAnchors([jobOutcomeAnchor({ runId: 'run-1', coordinatorId: 'pm', closingTurnId: 'turn-close', endedAt: at(40) })!]);
    // jobView offers no action: no main one.
    expect(h.items().find((item) => item.kind === 'jobOutcome').primary).toBeUndefined();
  });

  it('keeps a card whose reply left the messages the chat keeps reachable at the top, saying why, and the sensor does not call that a loss', () => {
    const records = [writtenRecord('req-old', 'turn-old', 10, ['docs/old.md']), recordOf('turn-never', 11, { kind: 'answered' }, 'req-never')];
    const h = harness(new Map(), records);
    h.reply('turn-old', 'The old answer.');
    const boot = bootWebviewScript((h.chat as any).getHtml({ cspSource: 'test:' }, 'sidebar') as string);
    const deliver = () => { for (const listener of boot.listeners.message ?? []) listener({ data: { command: 'state', state: (h.chat as any).currentState() } }); };
    deliver();
    // The record of a turn this chat never showed is reachable too, said as not in this chat.
    expect(h.items()[0]).toMatchObject({ kind: 'earlierResults', cards: [{ id: 'request:req-never', reply: 'not-shown' }] });
    expect(h.cards().map((card) => card.id)).toEqual(['request:req-old']);
    for (let index = 0; index < 50; index++) h.reply(`turn-later-${index}`, `Later ${index}.`);
    deliver();
    const items = h.items();
    expect(items.filter((item) => item.kind === 'message').some((item) => item.turnId === 'turn-old')).toBe(false);
    // v0.9.103 (6.2, the Owner's "One line + tidy top"): the chat dropped messages, so its first row is the one line that
    // says so; the Earlier results entry follows it.
    expect(items[0].kind).toBe('historyTrimmed');
    expect(items[1].kind).toBe('earlierResults');
    // Both are older than every message kept now: by its time, the one never shown is said as trimmed too.
    expect(items[1].cards.map((card: any) => [card.id, card.reply])).toEqual([['request:req-old', 'trimmed'], ['request:req-never', 'trimmed']]);
    expect(items.slice(2).filter((item) => item.kind === 'requestSummary').map((item) => item.id)).not.toContain('request:req-old');
    // Moving to the top is not a disappearance.
    const reported = boot.postedMessages.filter((message: any) => message.command === 'renderedTranscriptItemsMissing') as any[];
    expect(reported.flatMap((message) => message.missing.map((entry: any) => entry.id)).filter((id: string) => !id.startsWith('msg:'))).toEqual([]);
    // The entry builds its cards when opened; the card's file still opens from there.
    const all = (node: any): any[] => (Array.isArray(node?.children) ? node.children : []).flatMap((child: any) => [child, ...all(child)]);
    const entry = all(boot.elements.get('transcript')).find((node) => String(node.className) === 'earlier-results');
    expect(all(entry).some((node) => String(node.className).includes('request-summary'))).toBe(false);
    const disclosure = entry.children[0];
    disclosure.open = true;
    boot.dispatchElementEvent(disclosure, 'toggle');
    const text = (node: any): string => [node?.textContent, ...(Array.isArray(node?.children) ? node.children.map(text) : [])].filter(Boolean).join(' ');
    expect(text(entry)).toContain('2 results whose replies are no longer shown in this chat');
    expect(text(entry)).toContain('Its reply is older than the 50 messages this chat keeps.');
    const open = all(entry).find((node) => node.type === 'button' && node.textContent === 'Open old.md');
    expect(open?.className).toBe('primary');
    boot.dispatchElementEvent(open, 'click');
    expect(boot.postedMessages.at(-1)).toEqual({ command: 'requestCardOpen', agentId: 'pm', recordId: 'request-closeout:req-old:turn-old', entry: 'file:0' });
  });

  /*
   * Finding 1 of the first 6.1 report: the dispatching turn's record is revised in place when its run closes, from "In
   * progress" to "Job closed · its Job outcome follows the closing reply". The card keeps what it said before.
   */
  describe('a report a later fact revised in place', () => {
    const run = (state: 'open' | 'closed'): RequestRunObservation => ({
      runId: 'run-1', state, tasks: { active: state === 'open' ? 1 : 0, settled: state === 'open' ? 0 : 1, cancelled: 0, interrupted: 0 },
      refusedDispatches: 0, policyRefused: 0, handles: state === 'open' ? ['h-1'] : [], omittedHandles: 0,
    });
    const dispatching = () => {
      const accumulator = new RequestCloseoutAccumulator({ requestId: 'req-1', rootAgentId: 'pm', originTurnId: 'turn-dispatch', terminalTurnId: 'turn-dispatch' });
      accumulator.route({ agentId: 'pm', backend: 'claude', model: 'opus' });
      return accumulator.finish({ terminal: { kind: 'answered' }, recordedAt: at(10), eventsCut: false, run: run('open') })!;
    };
    const closeAt = (h: Harness, turnId: string) =>
      h.chat.upsertJobOutcomeAnchors([jobOutcomeAnchor({ runId: 'run-1', coordinatorId: 'pm', closingTurnId: turnId, endedAt: at(40) })!]);

    it('shows the earlier revision as it read then, marked as earlier, and not the revised text that points at this card', () => {
      const before = dispatching();
      const revised = withEarlierRevisions(before, reviseForClosedRun(before, run('closed'))!);
      expect(revised.earlier?.revisions).toEqual([before]);
      const h = harness(new Map(), [revised, recordOf('turn-close', 40)]);
      h.reply('turn-dispatch', 'Dev is writing it.');
      h.reply('turn-close', 'It is written.');
      closeAt(h, 'turn-close');
      const [job] = h.items().filter((item) => item.kind === 'jobOutcome');
      expect(job.reports).toBe(2);
      expect(job.earlier).toHaveLength(1);
      expect(job.earlier[0]).toMatchObject({ id: `${before.recordId}#1`, report: 1, revised: true, recordedAt: at(10) });
      expect(job.earlier[0].headline.slice(0, 2).map((segment: any) => segment.text)).toEqual(['In progress', '1 delegated task running when this turn ended']);
      expect(JSON.stringify(job)).not.toContain('its Job outcome follows');
      const boot = bootWebviewScript((h.chat as any).getHtml({ cspSource: 'test:' }, 'sidebar') as string);
      const all = (node: any): any[] => (Array.isArray(node?.children) ? node.children : []).flatMap((child: any) => [child, ...all(child)]);
      const heads = all(boot.elements.get('transcript')).filter((node) => String(node.className) === 'job-outcome-earlier-report')
        .map((node) => String(node.children[0].textContent));
      expect(heads).toHaveLength(1);
      expect(heads[0]).toMatch(/^Report 1, as it read earlier · .+: In progress · 1 delegated task running when this turn ended/);
    });

    it('shows a record that kept nothing earlier as it reads now, as before', () => {
      const before = dispatching();
      const revised = reviseForClosedRun(before, run('closed'))!;
      const h = harness(new Map(), [revised, recordOf('turn-close', 40)]);
      h.reply('turn-dispatch', 'Dev is writing it.');
      h.reply('turn-close', 'It is written.');
      closeAt(h, 'turn-close');
      const [job] = h.items().filter((item) => item.kind === 'jobOutcome');
      expect(job.earlier).toHaveLength(1);
      expect(job.earlier[0]).toMatchObject({ id: before.recordId, report: 1 });
      expect(job.earlier[0].revised).toBeUndefined();
      expect(job.earlier[0].headline[0].text).toBe('Job closed');
    });
  });

  it('does not show a report whose reply has not reached the chat yet, as before', () => {
    const later = new Date(Date.now() + 60_000).toISOString();
    const accumulator = new RequestCloseoutAccumulator({ requestId: 'req-now', rootAgentId: 'pm', originTurnId: 'turn-now', terminalTurnId: 'turn-now' });
    accumulator.route({ agentId: 'pm', backend: 'claude', model: 'opus' });
    const h = harness(new Map(), [accumulator.finish({ terminal: { kind: 'answered' }, recordedAt: later, eventsCut: false })!]);
    h.reply('turn-before', 'An earlier reply.');
    expect(h.items().filter((item) => item.kind !== 'message')).toEqual([]);
  });
});

describe('Request summary card rendering', () => {
  it('renders both host-observed cards with one function, under their own names', () => {
    const html = (new ChatViewProvider({} as never, {
      listAgents: () => [], send: vi.fn(), interject: vi.fn(), interrupt: vi.fn(),
      onReply: () => vi.fn(),
      state: { get: () => undefined, update: () => Promise.resolve() },
      getApprovals: () => ({ command: 'ask', write: 'none' }), setApproval: vi.fn(),
    } as never) as any).getHtml({ cspSource: 'test:' }, 'sidebar') as string;
    expect(typeof html).toBe('string');
    expect(html).toContain("renderJobOutcome(message, 'Request summary', 'Observed by UnodeAi')");
    expect(html).toContain("if (item.kind === 'requestSummary') return 'summary:' + item.id;");
  });
});

/*
 * v0.9.95: what a person reads on the card, on each chat surface. The sidebar chat and the Workbench are given
 * the same items and run the same script; these tests run that script for each of them and read what it rendered.
 */
describe('Request summary card wording on the sidebar and in the Workbench', () => {
  const SURFACES = ['sidebar', 'workbench'] as const;

  interface ShownCard {
    name: string;
    badge: string;
    spoken: string;
    headline: Array<{ text: string; tone: string }>;
    sections: Array<{ title: string; rows: Array<{ label: string; value: string; tone: string }>; items?: string[]; note?: string }>;
  }

  const kids = (node: WebviewElement | undefined): WebviewElement[] => (Array.isArray(node?.children) ? node.children : []) as WebviewElement[];
  const text = (node: WebviewElement | undefined): string => String(node?.textContent ?? '');
  const classed = (node: WebviewElement | undefined, name: string): WebviewElement | undefined =>
    kids(node).find((child) => String(child.className).split(' ').includes(name));

  /** Every Request summary card the real webview script rendered for this surface, in transcript order. */
  function shown(chat: ChatViewProvider, surface: typeof SURFACES[number]): ShownCard[] {
    const boot = bootWebviewScript((chat as any).getHtml({ cspSource: 'test:' }, surface) as string);
    const transcript = boot.elements.get('transcript');
    if (!transcript) throw new Error('the chat did not render a transcript');
    const cards: WebviewElement[] = [];
    const walk = (node: WebviewElement): void => {
      if (String(node.className).split(' ').includes('request-summary')) cards.push(node);
      else kids(node).forEach(walk);
    };
    walk(transcript);
    return cards.map((card) => {
      const [details] = kids(card);
      const [summary, body] = kids(details);
      return {
        name: text(classed(summary, 'job-outcome-label')),
        badge: text(classed(summary, 'job-outcome-badge')),
        spoken: String((summary.getAttribute as (name: string) => unknown)('aria-label')),
        headline: kids(classed(summary, 'job-outcome-line'))
          .filter((part) => String(part.className).startsWith('job-outcome-segment '))
          .map((part) => ({ text: text(part), tone: String(part.className).replace('job-outcome-segment tone-', '') })),
        sections: kids(body).map((block) => {
          const cells = kids(classed(block, 'job-outcome-rows'));
          const rows: ShownCard['sections'][number]['rows'] = [];
          for (let index = 0; index + 1 < cells.length; index += 2) {
            rows.push({ label: text(cells[index]), value: text(cells[index + 1]), tone: String(cells[index + 1].className).replace('tone-', '') });
          }
          const items = classed(block, 'job-outcome-items');
          const note = classed(block, 'job-outcome-note');
          return {
            title: text(classed(block, 'job-outcome-section-title')),
            rows,
            ...(items ? { items: kids(items).map(text) } : {}),
            ...(note ? { note: text(note) } : {}),
          };
        }),
      };
    });
  }

  /** What the host's view of a card says, in the shape `shown` reads it back. An instant is shown in local time. */
  function stated(view: RequestSummaryViewV1): ShownCard {
    return {
      name: 'Request summary',
      badge: 'Observed by UnodeAi',
      spoken: `Request summary, host-observed. ${view.headline.map((segment) => segment.text).join(', ')}. Show details`,
      headline: view.headline.map((segment) => ({ text: segment.text, tone: segment.tone })),
      sections: view.sections.map((entry) => ({
        title: entry.title,
        rows: entry.rows.map((row) => ({ label: row.label, value: row.instant ? formatLocalInstant(row.instant) : row.value, tone: row.tone ?? 'neutral' })),
        ...(entry.items?.length ? { items: entry.items } : {}),
        ...(entry.note ? { note: entry.note } : {}),
      })),
    };
  }

  const FAILED = { status: 'failed' as const, observedBy: 'host' as const, failureKind: 'error' as const };
  const PASSED = { status: 'success' as const, observedBy: 'host' as const };
  const openRun: RequestRunObservation = {
    runId: 'run-1', state: 'open', tasks: { active: 1, settled: 0, cancelled: 0, interrupted: 0 },
    refusedDispatches: 0, policyRefused: 0, handles: ['h-1'], omittedHandles: 0,
  };
  const idleRun: RequestRunObservation = { ...openRun, tasks: { active: 0, settled: 1, cancelled: 0, interrupted: 0 }, handles: [] };
  const waitingLimit: RequestLimitsObservation = {
    coverage: 'complete', tokens: { ceiling: 1000, observed: 1200 }, crossings: 1, allowances: 0, decision: 'awaiting', heldBoundary: 'provider-request',
  };

  /** The record of one turn: what the host observed in it and how it ended. */
  function observed(
    turnId: string,
    second: number,
    observe: (turn: RequestCloseoutAccumulator) => void = () => undefined,
    end: Partial<RequestCloseoutFinish> = {},
  ): RequestCloseoutRecordV1 {
    // Each turn here is a request of its own: a request shows one card (v0.9.103).
    const accumulator = new RequestCloseoutAccumulator({ requestId: `req-${turnId}`, rootAgentId: 'pm', originTurnId: turnId, terminalTurnId: turnId });
    accumulator.route({ agentId: 'pm', backend: 'claude', model: 'opus' });
    observe(accumulator);
    return accumulator.finish({ terminal: { kind: 'answered' }, recordedAt: at(second), eventsCut: false, ...end })!;
  }

  it('shows every heading the card can lead with, the same on both surfaces', () => {
    const turns: Array<[string, RequestCloseoutRecordV1, { text: string; tone: string }]> = [
      ['answered', observed('turn-1', 1), { text: 'Answered', tone: 'neutral' }],
      ['completed', observed('turn-2', 2, (turn) => turn.fileChanged('src/a.ts', 'write', 'host-verified')), { text: 'Finished — not verified', tone: 'caution' }],
      ['completed', observed('turn-3', 3, (turn) => { turn.fileChanged('src/a.ts', 'write', 'host-verified'); turn.toolResult('run_checks', FAILED); }), { text: 'Finished — checks failed', tone: 'negative' }],
      ['completed', observed('turn-4', 4, (turn) => { turn.fileChanged('src/a.ts', 'write', 'host-verified'); turn.toolResult('run_checks', PASSED); }), { text: 'Verified', tone: 'positive' }],
      ['in-progress', observed('turn-5', 5, undefined, { run: openRun }), { text: 'In progress', tone: 'neutral' }],
      ['needs-you', observed('turn-6', 6, undefined, { limits: waitingLimit }), { text: 'Needs you', tone: 'caution' }],
      ['blocked', observed('turn-7', 7, undefined, { run: { ...idleRun, policyRefused: 1 } }), { text: 'Blocked', tone: 'caution' }],
      ['stopped', observed('turn-8', 8, undefined, { terminal: { kind: 'stopped' }, eventsCut: true }), { text: 'Stopped', tone: 'caution' }],
      ['failed', observed('turn-9', 9, undefined, { terminal: { kind: 'failed', failure: 'turn-error' }, eventsCut: true }), { text: 'Failed', tone: 'negative' }],
      ['no-conclusion', observed('turn-10', 10, undefined, { terminal: { kind: 'tool-only' } }), { text: 'No conclusion recorded', tone: 'caution' }],
      ['job-closed', observed('turn-11', 11, undefined, { run: { ...idleRun, state: 'closed' } }), { text: 'Job closed', tone: 'neutral' }],
      // The other ways a turn can end, each under the heading of its state.
      ['needs-you', observed('turn-12', 12, undefined, { terminal: { kind: 'host-deadline' }, eventsCut: true }), { text: 'Needs you', tone: 'caution' }],
      ['failed', observed('turn-13', 13, undefined, { terminal: { kind: 'failed', failure: 'process-lost' }, eventsCut: true }), { text: 'Failed', tone: 'negative' }],
      ['no-conclusion', observed('turn-14', 14, undefined, { terminal: { kind: 'empty-reply' } }), { text: 'No conclusion recorded', tone: 'caution' }],
      ['no-conclusion', observed('turn-15', 15, undefined, { terminal: { kind: 'no-conclusion' } }), { text: 'No conclusion recorded', tone: 'caution' }],
    ];
    const h = harness(new Map(), turns.map(([, record]) => record));
    for (const [, record] of turns) h.reply(record.terminalTurnId, 'Done.');
    const cards = h.cards();
    expect(cards.map((card) => card.view.state)).toEqual(turns.map(([state]) => state));
    // Every state the card can lead with, and every way a turn can end, has a turn here.
    expect([...new Set(turns.map(([state]) => state))].sort()).toEqual([...REQUEST_SUMMARY_STATES].sort());
    expect([...new Set(turns.map(([, record]) => record.terminal.kind))].sort()).toEqual([...REQUEST_TERMINAL_KINDS].sort());

    for (const surface of SURFACES) {
      const rendered = shown(h.chat, surface);
      expect(rendered.map((card) => card.headline[0]), surface).toEqual(turns.map(([, , heading]) => heading));
      // The heading is what a screen reader is told first, too.
      expect(rendered.map((card) => card.spoken.split('. ')[1].split(', ')[0]), surface).toEqual(turns.map(([, , heading]) => heading.text));
      // The whole card is the host's view and nothing else, section by section.
      expect(rendered, surface).toEqual(cards.map((card) => stated(card.view)));
      expect(JSON.stringify(rendered), surface).not.toContain('Completed');
    }
  });

  it('says the agent ran commands of its own when it tested without a host check, on both surfaces and after a restart (v0.9.102 field T1)', () => {
    // Field T1: the agent ran npm test in its own Bash tool and it passed; no host check ran. The card said "checks not run".
    const records = [observed('turn-1', 11, (turn) => {
      turn.fileChanged('src/a.js', 'write', 'host-verified');
      turn.toolResult('Bash', { status: 'success', observedBy: 'provider' }, 'c1');
    }, { timing: { startedAt: at(0), settledAt: at(11), durationMs: 11_000, approvalWaitMs: 0 } })];
    const store = new Map<string, unknown>();
    const first = harness(store, records, () => undefined);
    first.reply('turn-1', 'Done.');
    const restarted = harness(store, records, () => undefined);
    for (const chat of [first.chat, restarted.chat]) {
      for (const surface of SURFACES) {
        const [card] = shown(chat, surface);
        expect(card.headline.map((segment) => segment.text).join(' · '), surface)
          .toBe('Finished — not verified · 1 file changed, other effects not covered · host checks not run; the agent ran 1 command of its own · 11s · coverage limited');
        expect(card.sections.find((entry) => entry.title === 'Checks')!.rows, surface)
          .toContainEqual({ label: "Agent's own commands", value: "1 ran, 0 ended with an error (not checks; see the agent's command cards)", tone: 'neutral' });
      }
    }
  });

  it('shows the corrected phrases of a turn that changed a file and ran no check, on both surfaces and after a restart', () => {
    // The card the cold readers were shown: a change, three tool calls of which one failed, no verification.
    const receipt = (turnId: string) => {
      const turn = new TurnOutcomeAccumulator();
      for (const [callId, fact] of [['c1', PASSED], ['c2', PASSED], ['c3', FAILED]] as const) {
        turn.use(callId);
        turn.result(callId, fact);
      }
      return turn.finish({ turnId, agentId: 'pm', recordedAt: at(1), delivery: { kind: 'reply' } })!;
    };
    const timing = { startedAt: at(0), settledAt: at(11), durationMs: 11_000, approvalWaitMs: 0 };
    const changed = (turnId: string, second: number, verificationConfigured?: boolean) => observed(turnId, second, (turn) => {
      turn.fileChanged('field-0995.txt', 'write', 'host-verified');
      turn.usageUnit(`unit-${turnId}`);
    }, { turnOutcome: receipt(turnId), timing, ...(verificationConfigured === undefined ? {} : { verificationConfigured }) });
    const records = [changed('turn-1', 11, true), changed('turn-2', 22, false), changed('turn-3', 33)];
    const usage: JobUsageLookup = () => ({
      state: 'settled', quarantined: false, unattributed: false,
      rows: [{ displayClass: 'billed', inputTokens: 900, cachedInputTokens: 0, outputTokens: 100, nanoUsd: '2900000' }],
    });
    const store = new Map<string, unknown>();
    const first = harness(store, records, usage);
    for (const record of records) first.reply(record.terminalTurnId, 'Done.');
    const restarted = harness(store, records, usage);

    const row = (card: ShownCard, title: string, label: string) =>
      card.sections.find((entry) => entry.title === title)!.rows.find((entry) => entry.label === label);
    for (const chat of [first.chat, restarted.chat]) {
      for (const surface of SURFACES) {
        const rendered = shown(chat, surface);
        expect(rendered, surface).toHaveLength(3);
        for (const card of rendered) {
          expect(card.headline.map((segment) => segment.text).join(' · '), surface)
            .toBe('Finished — not verified · 1 file changed · checks not run · $0.0029 · 11s');
          expect(card.headline[0], surface).toEqual({ text: 'Finished — not verified', tone: 'caution' });
          expect(card.sections.find((entry) => entry.title === 'Result')!.note, surface)
            .toBe('A reply was delivered. UnodeAi does not judge whether it is correct.');
          expect(row(card, 'Work', 'Tool calls'), surface).toEqual({ label: 'Tool calls', value: '3: 2 succeeded, 0 refused, 1 failed', tone: 'neutral' });
          expect(row(card, 'Work', 'Tool event record'), surface)
            .toEqual({ label: 'Tool event record', value: 'complete: every observed tool call has one result', tone: 'neutral' });
          expect(row(card, 'Changes', 'Change visibility'), surface)
            .toEqual({ label: 'Change visibility', value: 'complete: every file change UnodeAi observed in this request is listed', tone: 'neutral' });
          expect(card.sections.find((entry) => entry.title === 'Access & approvals'), surface)
            .toEqual({ title: 'Access & approvals', rows: [{ label: 'Approval decisions', value: 'none recorded', tone: 'neutral' }] });
          expect(row(card, 'Usage & timing', 'Usage attribution'), surface)
            .toEqual({ label: 'Usage attribution', value: 'complete: the usage recorded for this turn is settled and attributed', tone: 'neutral' });
          expect(card.sections.find((entry) => entry.title === 'Checks')!.note, surface)
            .toBe('Only a run of the configured verification command that UnodeAi itself started counts here. A command the agent ran, or a result it reported in its reply, does not.');
          // None of the phrases that were replaced is left anywhere on the card.
          const everything = JSON.stringify(card);
          for (const gone of ['Completed', 'Answered means', 'coverage', 'Coverage', 'Approvals', 'none run by UnodeAi', 'route received']) {
            expect(everything, `${surface}: ${gone}`).not.toContain(gone);
          }
        }
        // What the host held of the verification command when each turn closed: yes, no, and not kept.
        expect(rendered.map((card) => row(card, 'Checks', 'Verification runs')), surface).toEqual([
          { label: 'Verification runs', value: 'configured, not run', tone: 'caution' },
          { label: 'Verification runs', value: 'not configured', tone: 'caution' },
          { label: 'Verification runs', value: 'configuration not recorded', tone: 'caution' },
        ]);
      }
    }
  });
});


/*
 * v0.9.97 P5: handoff §7 row P5, "only the existing closeout is updated; an old reply does not overwrite a newer
 * receipt, draft or selection". A request's card is revised when a delegate writes for it after its turn ended, or a
 * restore undoes one of its changes; that revision may arrive while the person is already on a newer request.
 */
describe('a late revision of an older request\'s card', () => {
  function gradedRecord(requestId: string, turnId: string, second: number, effects: RequestFileEffects): RequestCloseoutRecordV1 {
    const accumulator = new RequestCloseoutAccumulator({ requestId, rootAgentId: 'pm', originTurnId: turnId, terminalTurnId: turnId }, effects);
    accumulator.route({ agentId: 'pm', backend: 'claude', model: 'opus' });
    return accumulator.finish({ terminal: { kind: 'answered' }, recordedAt: at(second), eventsCut: false })!;
  }

  it('replaces only that card, in place, and leaves the newer card, the selected agent and the unsent text as they are', () => {
    const older = new RequestFileEffects();
    older.effect({ path: 'docs/plan.md', key: 'k1', operation: 'write', grade: 'host-verified' });
    const newer = new RequestFileEffects();
    newer.effect({ path: 'src/next.ts', key: 'k2', operation: 'write', grade: 'host-verified' });
    const records = [gradedRecord('req-1', 'turn-1', 10, older), gradedRecord('req-2', 'turn-2', 20, newer)];
    const h = harness(new Map(), records);
    h.reply('turn-1');
    h.reply('turn-2');
    const before = h.cards();
    const boot = bootWebviewScript((h.chat as any).getHtml({ cspSource: 'test:' }, 'sidebar') as string);
    const input = boot.elements.get('input')!;
    input.value = 'the next request, not sent yet';

    // A teammate of the older request writes after its turn ended; its record takes the request's effects.
    older.effect({ path: 'docs/guide.md', key: 'k3', operation: 'write', grade: 'native-observed' });
    records[0] = reviseForFileEffects(records[0], 'req-1', older.observation())!;
    expect(reviseForFileEffects(records[1], 'req-1', older.observation())).toBeUndefined();
    h.chat.refreshRequestSummaries();
    const after = h.cards();
    const state = (h.chat as any).currentState();
    expect(boot.listeners.message?.length).toBeGreaterThan(0);
    for (const listener of boot.listeners.message ?? []) listener({ data: { command: 'state', state } });

    expect(after.map((card) => card.id)).toEqual(before.map((card) => card.id));
    expect(after[0].seq).toBe(before[0].seq);
    expect(after[0].renderKey).not.toBe(before[0].renderKey);
    expect(after[0].view.sections.find((section: { title: string }) => section.title === 'Changes').items)
      .toEqual(['docs/plan.md (written, host-verified)', 'docs/guide.md (written, CLI native observed)']);
    expect(after[1]).toEqual(before[1]);
    expect(state.selectedAgentId).toBe('pm');
    expect(input.value).toBe('the next request, not sent yet');
  });
});
