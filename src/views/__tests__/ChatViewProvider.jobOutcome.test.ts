import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  ViewColumn: { One: 1, Active: 1 },
  commands: { executeCommand: vi.fn() },
  window: {
    showInformationMessage: vi.fn(), showErrorMessage: vi.fn(), showWarningMessage: vi.fn(),
  },
}));

import { ChatViewProvider } from '../ChatViewProvider';
import { chatHistoryKey, deserializeChatHistory } from '../chatHistory';
import { parseChatWebviewInboundMessage } from '../chatWebviewProtocol';
import { jobOutcomeView, unavailableJobOutcome, type JobOutcomeViewV1 } from '../../observability/JobOutcome';
import {
  JOB_OUTCOME_ANCHOR_LIMIT,
  deserializeJobOutcomeAnchors,
  jobOutcomeAnchor,
  mergeJobOutcomeAnchors,
  type JobOutcomeAnchorEntry,
  type JobOutcomeAnchorV1,
} from '../../observability/JobOutcomeAnchor';

/* v0.9.93 92-D: one Job outcome card per closed run, after the reply that closed it. Chat keeps the anchor only. */

const OUTCOMES_KEY = 'roam.chat.jobOutcomes.pm';
const at = (second: number): string => new Date(Date.UTC(2026, 9, 4, 10, 0, second)).toISOString();

function anchorOf(runId: string, turnId = 'turn-close', second = 40, coordinatorId = 'pm'): JobOutcomeAnchorV1 {
  return jobOutcomeAnchor({ runId, coordinatorId, closingTurnId: turnId, endedAt: at(second) })!;
}

function viewOf(runId: string, text = 'Complete'): JobOutcomeViewV1 {
  return {
    schemaVersion: 1, id: `outcome:${runId}`, runId, available: true,
    headline: [{ text, tone: 'positive' }],
    sections: [{ title: 'Outcome', rows: [{ label: 'Completion', value: text }] }],
    actions: [{ id: 'openEvidence', label: 'Open evidence', section: 'Outcome', title: 'Open this job\'s evidence report.' }],
  };
}

interface Harness {
  chat: ChatViewProvider;
  reply: (turnId: string, text?: string) => void;
  items: () => any[];
  outcomes: () => any[];
  views: Map<string, JobOutcomeViewV1>;
  actions: Array<{ coordinatorId: string; runId: string; action: string }>;
  viewCalls: () => number;
  send: ReturnType<typeof vi.fn>;
}

function harness(store: Map<string, unknown>): Harness {
  let onReply: ((reply: unknown) => void) | undefined;
  const views = new Map<string, JobOutcomeViewV1>();
  const actions: Harness['actions'] = [];
  let calls = 0;
  const send = vi.fn();
  const chat = new ChatViewProvider({} as never, {
    listAgents: () => [{ id: 'pm', name: 'PM', role: 'pm' }, { id: 'arch', name: 'Architect', role: 'architect' }],
    send, interject: vi.fn(), interrupt: vi.fn(),
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
    jobOutcomeView: (runId: string, anchor: 'anchored' | 'conflict') => {
      calls++;
      return anchor === 'conflict'
        ? jobOutcomeView(unavailableJobOutcome(runId, 'anchor-conflict'))
        : views.get(runId) ?? jobOutcomeView(unavailableJobOutcome(runId, 'run-not-retained'));
    },
    onJobOutcomeAction: (event: { coordinatorId: string; runId: string; action: string }) => { actions.push(event); },
  } as never);
  const items = (): any[] => (chat as any).currentState().messages;
  return {
    chat,
    reply: (turnId, text = 'Done.') => onReply!({ from: 'pm', fromName: 'PM', text, isError: false, completionState: 'complete', turnId }),
    items,
    outcomes: () => items().filter((item) => item.kind === 'jobOutcome'),
    views,
    actions,
    viewCalls: () => calls,
    send,
  };
}

describe('Job outcome card placement', () => {
  it('shows one card right after the reply that closed the run, and keeps one through repeated closes', () => {
    const h = harness(new Map());
    h.views.set('run-1', viewOf('run-1'));
    h.reply('turn-close', 'The review is done.');
    h.chat.upsertJobOutcomeAnchors([anchorOf('run-1')]);
    h.chat.upsertJobOutcomeAnchors([anchorOf('run-1')]);
    h.chat.upsertJobOutcomeAnchors([anchorOf('run-1'), anchorOf('run-1')]);
    expect(h.outcomes()).toHaveLength(1);
    const items = h.items();
    const closing = items.findIndex((item) => item.kind === 'message' && item.turnId === 'turn-close');
    expect(items[closing + 1]).toMatchObject({ kind: 'jobOutcome', id: 'outcome:run-1' });
    expect(items[closing + 1].view).toEqual(viewOf('run-1'));
  });

  it('places no card when the closing reply is not in this transcript: no position is guessed', () => {
    const h = harness(new Map());
    h.views.set('run-1', viewOf('run-1'));
    h.reply('another-turn', 'An unrelated reply.');
    h.chat.upsertJobOutcomeAnchors([anchorOf('run-1', 'turn-never-shown')]);
    expect(h.outcomes()).toEqual([]);
    // The card appears when its own closing reply does, and after that reply.
    h.reply('turn-never-shown', 'Now it closed.');
    const items = h.items();
    expect(items.at(-1)).toMatchObject({ kind: 'jobOutcome', id: 'outcome:run-1' });
    expect(items.at(-2)).toMatchObject({ kind: 'message', turnId: 'turn-never-shown' });
  });

  it('restores the same single card at the same place after a reload', () => {
    const store = new Map<string, unknown>();
    const first = harness(store);
    first.views.set('run-1', viewOf('run-1'));
    first.reply('turn-close');
    first.reply('turn-later', 'A later reply.');
    first.chat.upsertJobOutcomeAnchors([anchorOf('run-1')]);
    const before = first.items().map((item) => item.kind === 'jobOutcome' ? item.id : `msg:${item.turnId}`);

    const reloaded = harness(store);
    reloaded.views.set('run-1', viewOf('run-1'));
    // The restored ledger names the same closed run again.
    reloaded.chat.upsertJobOutcomeAnchors([anchorOf('run-1')]);
    const after = reloaded.items().map((item) => item.kind === 'jobOutcome' ? item.id : `msg:${item.turnId}`);
    expect(after).toEqual(before);
    expect(after).toEqual(['msg:turn-close', 'outcome:run-1', 'msg:turn-later']);
  });

  it('updates the card in place when its facts change, and neither appends nor announces', () => {
    const h = harness(new Map());
    h.views.set('run-1', viewOf('run-1', 'Complete'));
    h.reply('turn-close');
    h.chat.upsertJobOutcomeAnchors([anchorOf('run-1')]);
    const [first] = h.outcomes();
    const announcementBefore = (h.chat as any).announcement?.seq;
    // A late receipt: the host's projection now says something else.
    h.views.set('run-1', viewOf('run-1', 'Complete, usage updated'));
    h.chat.refreshJobOutcomes();
    const [second, ...rest] = h.outcomes();
    expect(rest).toEqual([]);
    expect(second.id).toBe(first.id);
    expect(second.seq).toBe(first.seq);
    expect(second.renderKey).not.toBe(first.renderKey);
    expect(second.view.headline[0].text).toBe('Complete, usage updated');
    expect((h.chat as any).announcement?.seq).toBe(announcementBefore);
  });

  it('shows evidence unavailable, with no figure, when the run is gone or two anchors disagree', () => {
    const h = harness(new Map());
    h.reply('turn-close');
    // The run was retained out: the host has no view of it.
    h.chat.upsertJobOutcomeAnchors([anchorOf('run-gone')]);
    expect(h.outcomes()[0].view).toMatchObject({ available: false, headline: [{ text: 'Outcome evidence unavailable' }] });

    const conflict = harness(new Map());
    conflict.views.set('run-1', viewOf('run-1'));
    conflict.reply('turn-close');
    conflict.chat.upsertJobOutcomeAnchors([anchorOf('run-1', 'turn-close', 40)]);
    conflict.chat.upsertJobOutcomeAnchors([anchorOf('run-1', 'turn-close', 41)]);
    const [card, ...others] = conflict.outcomes();
    expect(others).toEqual([]);
    expect(card.view.available).toBe(false);
    expect(JSON.stringify(card.view)).not.toContain('Complete');
    // A later equal copy does not resolve it.
    conflict.chat.upsertJobOutcomeAnchors([anchorOf('run-1', 'turn-close', 40)]);
    expect(conflict.outcomes()[0].view.available).toBe(false);
  });

  it('keeps the card out of the conversation: the stored transcript has no outcome item', () => {
    const store = new Map<string, unknown>();
    const h = harness(store);
    h.views.set('run-1', viewOf('run-1'));
    h.reply('turn-close');
    h.chat.upsertJobOutcomeAnchors([anchorOf('run-1')]);
    expect(h.outcomes()).toHaveLength(1);
    const history = deserializeChatHistory(store.get(chatHistoryKey('pm')));
    expect(history).toHaveLength(1);
    expect(history.every((message) => message.role === 'user' || message.role === 'agent')).toBe(true);
    expect(JSON.stringify(history)).not.toContain('outcome:');
    expect(h.chat.getMessageCount('pm')).toBe(1);
    // What is stored for the card is the anchor: no headline, no section, no figure.
    expect(JSON.stringify(store.get(OUTCOMES_KEY))).not.toMatch(/headline|sections|Complete/);
    expect(deserializeJobOutcomeAnchors(store.get(OUTCOMES_KEY), 'pm')).toEqual([{ state: 'anchored', anchor: anchorOf('run-1') }]);
  });

  it('shows a coordinator\'s cards in its own conversation only', () => {
    const h = harness(new Map());
    h.views.set('run-1', viewOf('run-1'));
    h.reply('turn-close');
    h.chat.upsertJobOutcomeAnchors([anchorOf('run-1')]);
    h.chat.selectAgent('arch');
    expect(h.outcomes()).toEqual([]);
    h.chat.selectAgent('pm');
    expect(h.outcomes()).toHaveLength(1);
  });

  it('runs only an action the card offers, on a card this chat shows', () => {
    const h = harness(new Map());
    h.views.set('run-1', viewOf('run-1'));
    h.reply('turn-close');
    h.chat.upsertJobOutcomeAnchors([anchorOf('run-1')]);
    const send = (message: unknown) => (h.chat as any).onMessage(message, 'sidebar');
    send({ command: 'jobOutcomeAction', outcomeId: 'outcome:run-1', action: 'openEvidence' });
    send({ command: 'jobOutcomeAction', outcomeId: 'outcome:run-1', action: 'reviewChanges' });
    send({ command: 'jobOutcomeAction', outcomeId: 'outcome:run-unknown', action: 'openEvidence' });
    send({ command: 'jobOutcomeAction', outcomeId: 'outcome:run-1', action: 'deleteEverything' });
    expect(h.actions).toEqual([{ coordinatorId: 'pm', runId: 'run-1', action: 'openEvidence' }]);
  });
});

describe('submitUserRequest (Continue unfinished work)', () => {
  it('starts a new, visible request of the person and never injects one into a running turn', () => {
    const store = new Map<string, unknown>();
    const h = harness(store);
    h.reply('turn-close');
    expect(h.chat.submitUserRequest('pm', '  Continue the unfinished work.  ')).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0].slice(0, 3)).toEqual(['pm', 'Continue the unfinished work.', 'act']);
    const history = deserializeChatHistory(store.get(chatHistoryKey('pm')));
    expect(history.at(-1)).toMatchObject({ role: 'user', text: 'Continue the unfinished work.' });
    // The coordinator is now in that turn: a second request is refused, not folded into it.
    expect(h.chat.submitUserRequest('pm', 'Another request.')).toBe(false);
    expect(h.chat.submitUserRequest('nobody', 'A request.')).toBe(false);
    expect(h.chat.submitUserRequest('pm', '   ')).toBe(false);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

describe('Job outcome anchors', () => {
  it('are a function of the closed run, so two windows write the same bytes', () => {
    const facts = { runId: 'run-1', coordinatorId: 'pm', closingTurnId: 'turn-close', endedAt: at(40) };
    expect(JSON.stringify(jobOutcomeAnchor(facts))).toBe(JSON.stringify(jobOutcomeAnchor({ ...facts })));
    expect(jobOutcomeAnchor(facts)).toEqual({
      kind: 'job-outcome', schemaVersion: 1, id: 'outcome:run-1', runId: 'run-1', coordinatorId: 'pm',
      afterTurnId: 'turn-close', recordedAt: at(40),
    });
    expect(jobOutcomeAnchor({ ...facts, closingTurnId: '' })).toBeUndefined();
    expect(jobOutcomeAnchor({ ...facts, endedAt: 'not a time' })).toBeUndefined();
  });

  it('merge equal copies to one entry and unequal copies to a conflict, in either direction and again', () => {
    const a: JobOutcomeAnchorEntry = { state: 'anchored', anchor: anchorOf('run-1', 'turn-close', 40) };
    const b: JobOutcomeAnchorEntry = { state: 'anchored', anchor: anchorOf('run-1', 'turn-close', 41) };
    expect(mergeJobOutcomeAnchors([a], [a])).toEqual([a]);
    const forward = mergeJobOutcomeAnchors([a], [b]);
    const backward = mergeJobOutcomeAnchors([b], [a]);
    expect(forward).toEqual(backward);
    expect(forward).toEqual([{ state: 'conflict', id: 'outcome:run-1', runId: 'run-1', coordinatorId: 'pm', afterTurnId: 'turn-close' }]);
    expect(mergeJobOutcomeAnchors(forward, [a])).toEqual(forward);
    // Copies that name different turns leave no position at all.
    const moved: JobOutcomeAnchorEntry = { state: 'anchored', anchor: anchorOf('run-1', 'turn-other', 40) };
    expect(mergeJobOutcomeAnchors([a], [moved])).toEqual([{ state: 'conflict', id: 'outcome:run-1', runId: 'run-1', coordinatorId: 'pm' }]);
  });

  it('are bounded, oldest first, and drop a stored entry that is malformed or belongs to another coordinator', () => {
    const many = Array.from({ length: JOB_OUTCOME_ANCHOR_LIMIT + 5 }, (_, index): JobOutcomeAnchorEntry =>
      ({ state: 'anchored', anchor: anchorOf(`run-${index}`, `turn-${index}`, index % 60) }));
    const merged = mergeJobOutcomeAnchors([], many);
    expect(merged).toHaveLength(JOB_OUTCOME_ANCHOR_LIMIT);
    const stored = [
      { state: 'anchored', anchor: anchorOf('run-ok') },
      { state: 'anchored', anchor: { ...anchorOf('run-forged'), id: 'outcome:another-run' } },
      { state: 'anchored', anchor: anchorOf('run-foreign', 'turn-close', 40, 'other-pm') },
      { state: 'anchored', anchor: { ...anchorOf('run-html'), html: '<b>Verified</b>' } },
      'not an entry',
    ];
    const restored = deserializeJobOutcomeAnchors(stored, 'pm');
    expect(restored.map((entry) => (entry.state === 'anchored' ? entry.anchor.runId : entry.runId))).toEqual(['run-html', 'run-ok']);
    expect(JSON.stringify(restored)).not.toContain('<b>');
  });

  it('hold one bound for conflicts and anchors together, and keep the conflicts', () => {
    const name = (index: number): string => String(index).padStart(2, '0');
    const conflicts = (length: number): JobOutcomeAnchorEntry[] => Array.from({ length }, (_, index) =>
      ({ state: 'conflict', id: `outcome:c-${name(index)}`, runId: `c-${name(index)}`, coordinatorId: 'pm' }));
    const anchors = (length: number): JobOutcomeAnchorEntry[] => Array.from({ length }, (_, index) =>
      ({ state: 'anchored', anchor: anchorOf(`run-${name(index)}`, `turn-${index}`, index) }));
    const runIds = (entries: JobOutcomeAnchorEntry[]): string[] =>
      entries.flatMap((entry) => (entry.state === 'anchored' ? [entry.anchor.runId] : []));

    const mixed = mergeJobOutcomeAnchors(conflicts(30), anchors(40));
    expect(mixed).toHaveLength(JOB_OUTCOME_ANCHOR_LIMIT);
    expect(mixed.filter((entry) => entry.state === 'conflict')).toHaveLength(30);
    // The newest anchors fill what the conflicts leave.
    expect(runIds(mixed)).toEqual(Array.from({ length: 20 }, (_, index) => `run-${name(index + 20)}`));
    expect(mergeJobOutcomeAnchors(anchors(40), conflicts(30))).toEqual(mixed);
    expect(mergeJobOutcomeAnchors(mixed, mixed)).toEqual(mixed);
    // A dropped anchor that the run writes again is dropped again: it never displaces a conflict.
    expect(mergeJobOutcomeAnchors(mixed, anchors(1))).toEqual(mixed);

    const crowded = mergeJobOutcomeAnchors(conflicts(JOB_OUTCOME_ANCHOR_LIMIT + 10), anchors(10));
    expect(crowded).toHaveLength(JOB_OUTCOME_ANCHOR_LIMIT);
    expect(crowded.every((entry) => entry.state === 'conflict')).toBe(true);
  });
});

describe('jobOutcomeAction transport', () => {
  it('accepts a card action by name and rejects anything else', () => {
    expect(parseChatWebviewInboundMessage({ command: 'jobOutcomeAction', outcomeId: 'outcome:run-1', action: 'openEvidence' }))
      .toEqual({ ok: true, message: { command: 'jobOutcomeAction', outcomeId: 'outcome:run-1', action: 'openEvidence' } });
    expect(parseChatWebviewInboundMessage({ command: 'jobOutcomeAction', outcomeId: 'outcome:run-1', action: 'rerunChecks' }).ok).toBe(false);
    expect(parseChatWebviewInboundMessage({ command: 'jobOutcomeAction', outcomeId: '', action: 'openEvidence' }).ok).toBe(false);
    expect(parseChatWebviewInboundMessage({ command: 'jobOutcomeAction', outcomeId: 'outcome:run-1', action: 'openEvidence', runId: 'x' }).ok).toBe(false);
  });
});
