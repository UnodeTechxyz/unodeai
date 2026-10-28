import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ApprovalDecision,
  ApprovalDecisionBroker,
  ApprovalEvent,
  ApprovalQueue,
  REQUEST_LIMIT_ACTIONS,
  openRequestLimitCard,
  settleOnAbort,
  requestLimitSessionId,
  requestLimitSettlementOfEvent,
  showRequestLimitCard,
} from '../approvals';
import type { RequestLimitCard, RequestLimitCardEnd, RequestLimitCardSettlement } from '../../host/RequestLimitPrompt';

describe('ApprovalQueue', () => {
  it('resolves a request with the user decision and removes it from the queue', async () => {
    const q = new ApprovalQueue();
    const p = q.request({ kind: 'command', agentName: 'Dev', command: 'npm test' });
    expect(q.list()).toHaveLength(1);
    expect(q.pendingCount()).toBe(1);

    const id = q.list()[0].id;
    expect(q.resolve(id, { action: 'session' })).toBe(true);
    await expect(p).resolves.toEqual({ action: 'session' });
    expect(q.list()).toHaveLength(0);
    expect(q.pendingCount()).toBe(0);
  });

  it('carries a deny note through to the awaiter', async () => {
    const q = new ApprovalQueue();
    const p = q.request({ kind: 'command', agentName: 'Dev', command: 'rm -rf /' });
    q.resolve(q.list()[0].id, { action: 'deny', note: 'use npm run clean' });
    await expect(p).resolves.toEqual({ action: 'deny', note: 'use npm run clean' });
  });

  it('keeps multiple requests independent and resolvable out of order', async () => {
    const q = new ApprovalQueue();
    const a = q.request({ kind: 'write', agentName: 'A', path: 'a.ts', verb: 'create', diff: '+1' });
    const b = q.request({ kind: 'write', agentName: 'B', path: 'b.ts', verb: 'overwrite', diff: '+2' });
    expect(q.list()).toHaveLength(2);
    const [idA, idB] = q.list().map((r) => r.id);

    q.resolve(idB, { action: 'always' });
    await expect(b).resolves.toEqual({ action: 'always' });
    expect(q.list().map((r) => r.id)).toEqual([idA]);

    q.resolve(idA, { action: 'once' });
    await expect(a).resolves.toEqual({ action: 'once' });
    expect(q.list()).toHaveLength(0);
  });

  it('resolve() returns false for an unknown or already-resolved id', () => {
    const q = new ApprovalQueue();
    q.request({ kind: 'command', agentName: 'Dev', command: 'ls' });
    const id = q.list()[0].id;
    expect(q.resolve(id, { action: 'once' })).toBe(true);
    expect(q.resolve(id, { action: 'once' })).toBe(false);
    expect(q.resolve('nope', { action: 'once' })).toBe(false);
  });

  it('denyAll() resolves everything pending as a deny (so a torn-down panel never hangs)', async () => {
    const q = new ApprovalQueue();
    const a = q.request({ kind: 'command', agentName: 'A', command: 'x' });
    const b = q.request({ kind: 'write', agentName: 'B', path: 'b', verb: 'create', diff: '' });
    q.denyAll();
    await expect(a).resolves.toEqual({ action: 'deny' });
    await expect(b).resolves.toEqual({ action: 'deny' });
    expect(q.list()).toHaveLength(0);
    expect(q.pendingCount()).toBe(0);
  });

  it('fires onChange when the queue changes', () => {
    const onChange = vi.fn();
    const q = new ApprovalQueue(onChange);
    q.request({ kind: 'command', agentName: 'Dev', command: 'ls' });
    expect(onChange).toHaveBeenCalledTimes(1);
    q.resolve(q.list()[0].id, { action: 'once' });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('emits transport-neutral pending and decided events with the approver identity', async () => {
    const events: ApprovalEvent[] = [];
    const q = new ApprovalQueue(undefined, (event) => events.push(event));
    const pending = q.request({
      kind: 'command',
      agentId: 'agent-42',
      sessionId: 'session-42',
      agentName: 'Developer',
      command: 'npm test',
    }, 500);
    const id = q.list()[0].id;

    expect(events[0]).toMatchObject({
      type: 'pending',
      approval: {
        id,
        agent: { id: 'agent-42', name: 'Developer' },
        sessionId: 'session-42',
        action: { kind: 'command', summary: 'Run a command', target: 'npm test' },
        deadline: expect.any(String),
      },
    });
    // The event is ordinary data: safe for a future mobile/web subscriber and contains no editor object.
    expect(JSON.stringify(events[0]).toLowerCase()).not.toContain('vscode');

    q.resolve(id, { action: 'once' }, 'local:owner-1');
    await expect(pending).resolves.toEqual({ action: 'once' });
    expect(events[1]).toMatchObject({
      type: 'decided',
      approvalId: id,
      agent: { id: 'agent-42', name: 'Developer' },
      sessionId: 'session-42',
      decision: { action: 'once' },
      approverId: 'local:owner-1',
    });
  });

  it('returns the host-attached actor only for a contemporaneous human decision', async () => {
    const q = new ApprovalQueue();
    const decided = q.requestWithIdentity({ kind: 'command', agentName: 'Dev', command: 'npm test' });
    q.resolve(q.list()[0].id, { action: 'once' }, 'local:machine-canary');
    await expect(decided).resolves.toMatchObject({
      action: 'once', approverId: 'local:machine-canary', approvalId: expect.stringMatching(/^appr-/),
    });

    const disposed = q.requestWithIdentity({ kind: 'write', agentName: 'Dev', path: 'a.ts', verb: 'create' });
    q.denyAll();
    await expect(disposed).resolves.toMatchObject({ action: 'deny', approvalId: expect.stringMatching(/^appr-/) });
  });

  it('removes a bounded approval and returns a clean deny when its human window lapses', async () => {
    vi.useFakeTimers();
    try {
      const events: ApprovalEvent[] = [];
      const q = new ApprovalQueue(undefined, (event) => events.push(event));
      const pending = q.requestWithIdentity({ kind: 'tool', agentId: 'researcher', agentName: 'Researcher', toolName: 'Web access' }, 60);
      expect(q.pendingCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toMatchObject({
        action: 'deny', note: 'The approval window expired.', expired: true, approvalId: expect.stringMatching(/^appr-/),
      });
      expect(q.pendingCount()).toBe(0);
      expect(q.list()).toEqual([]);
      expect(events.at(-1)).toMatchObject({
        type: 'expired',
        agent: { id: 'researcher', name: 'Researcher' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never revives an expired approval as approved or reuses its opaque id', async () => {
    vi.useFakeTimers();
    try {
      const q = new ApprovalQueue();
      const expired = q.requestWithIdentity({ kind: 'command', agentName: 'Dev', command: 'npm test' }, 60);
      const expiredId = q.list()[0].id;
      await vi.advanceTimersByTimeAsync(60);
      await expect(expired).resolves.toMatchObject({ action: 'deny', expired: true, approvalId: expiredId });
      expect(q.resolve(expiredId, { action: 'once' })).toBe(false);

      const fresh = q.requestWithIdentity({ kind: 'command', agentName: 'Dev', command: 'npm test' }, 60);
      const freshId = q.list()[0].id;
      expect(freshId).not.toBe(expiredId);
      expect(q.resolve(freshId, { action: 'once' })).toBe(true);
      await expect(fresh).resolves.toMatchObject({ action: 'once', approvalId: freshId });

      // Mutation canary: restoring a resolver in expire(), or resolving the old id after it has left the
      // queue, turns a timed-out consent into an approval without a fresh human decision.
    } finally {
      vi.useRealTimers();
    }
  });
});

// v0.9.88 §5.10: one settlement authority for every approval, card or modal.
describe('ApprovalDecisionBroker', () => {
  const command = (sessionId: string) => ({ kind: 'command' as const, agentName: sessionId, agentId: sessionId, sessionId, command: 'npm test' });

  it('settles a prompt once and drops every later answer', async () => {
    const broker = new ApprovalDecisionBroker();
    const { approvalId, outcome } = broker.open(command('dev'));
    expect(broker.settle(approvalId, { action: 'once' }, 'human', 'local:owner')).toBe(true);
    expect(broker.settle(approvalId, { action: 'always' }, 'human', 'local:owner')).toBe(false);
    await expect(outcome).resolves.toMatchObject({ action: 'once', settledBy: 'human', approverId: 'local:owner' });
    expect(broker.list()).toEqual([]);
  });

  it('expires a native-modal prompt at its deadline and drops the modal answer that comes later', async () => {
    vi.useFakeTimers();
    try {
      const events: ApprovalEvent[] = [];
      const broker = new ApprovalDecisionBroker();
      broker.subscribe({ onEvent: (event) => events.push(event) });
      let answer!: (decision: ApprovalDecision) => void;
      const { outcome } = broker.openModal(command('dev'), 60, () => new Promise((resolve) => { answer = resolve; }), 'local:owner');
      await vi.advanceTimersByTimeAsync(60);
      await expect(outcome).resolves.toMatchObject({ action: 'deny', expired: true, settledBy: 'expired' });
      // The person clicks "Allow for project" on the modal VS Code could not dismiss: nothing happens.
      answer({ action: 'project' });
      await vi.advanceTimersByTimeAsync(0);
      expect(events.map((event) => event.type)).toEqual(['pending', 'expired']);
      expect(broker.list('modal')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets one session leave a shared prompt while the other keeps waiting and alone receives the later allow', async () => {
    const broker = new ApprovalDecisionBroker();
    const waits: Array<[string, boolean]> = [];
    broker.subscribe({ onWaitChange: (sessionId, waiting) => waits.push([sessionId, waiting]) });
    const { approvalId, outcome: first } = broker.open(command('researcher'), { timeoutMs: 60_000 });
    const second = broker.join(approvalId, 'developer')!;

    expect(broker.leave('researcher')).toBe(1);
    await expect(first).resolves.toMatchObject({ action: 'deny', withdrawn: true, settledBy: 'withdrawn' });
    expect(broker.isOpen(approvalId)).toBe(true);
    expect(broker.list()).toHaveLength(1);

    expect(broker.settle(approvalId, { action: 'always' }, 'human', 'local:owner')).toBe(true);
    await expect(second).resolves.toMatchObject({ action: 'always', settledBy: 'human' });
    await expect(first).resolves.toMatchObject({ settledBy: 'withdrawn' });
    expect(waits).toEqual([
      ['researcher', true],
      ['developer', true],
      ['researcher', false],
      ['developer', false],
    ]);
  });

  it('withdraws a prompt when its last participant leaves, removing the card for good', async () => {
    const broker = new ApprovalDecisionBroker();
    const events: ApprovalEvent[] = [];
    broker.subscribe({ onEvent: (event) => events.push(event) });
    const { approvalId, outcome } = broker.open(command('dev'), { timeoutMs: 60_000 });

    broker.leave('dev');
    await expect(outcome).resolves.toMatchObject({ action: 'deny', withdrawn: true });
    expect(events.map((event) => event.type)).toEqual(['pending', 'withdrawn']);
    expect(broker.list()).toEqual([]);
    // A click that arrives after Stop grants nothing.
    expect(broker.settle(approvalId, { action: 'project' }, 'human', 'local:owner')).toBe(false);
  });

  it('reports one wait per session across overlapping prompts, ending only when the last one settles', () => {
    const broker = new ApprovalDecisionBroker();
    const waits: Array<[string, boolean]> = [];
    broker.subscribe({ onWaitChange: (sessionId, waiting) => waits.push([sessionId, waiting]) });
    const a = broker.open(command('dev'));
    const b = broker.open({ ...command('dev'), command: 'npm run build' });
    broker.settle(a.approvalId, { action: 'deny' }, 'human');
    expect(waits).toEqual([['dev', true]]);
    broker.settle(b.approvalId, { action: 'once' }, 'human');
    expect(waits).toEqual([['dev', true], ['dev', false]]);
  });

  it('settles everything open as a denial on disposal, with no human approver', async () => {
    const broker = new ApprovalDecisionBroker();
    const card = broker.open(command('dev'));
    const modal = broker.openModal(command('qa'), 60_000, () => new Promise(() => undefined), 'local:owner');
    broker.disposeAll();
    for (const outcome of [card.outcome, modal.outcome]) {
      const settled = await outcome;
      expect(settled).toMatchObject({ action: 'deny', settledBy: 'host-disposed' });
      expect(settled.approverId).toBeUndefined();
    }
    expect(broker.pendingCount()).toBe(0);
  });

  it('shows cards in the chat queue and keeps modal prompts out of it', () => {
    const broker = new ApprovalDecisionBroker();
    const queue = new ApprovalQueue(undefined, undefined, broker);
    queue.request(command('dev'));
    broker.openModal(command('qa'), 60_000, () => new Promise(() => undefined), 'local:owner');
    expect(queue.list().map((request) => request.sessionId)).toEqual(['dev']);
    expect(broker.list('modal').map((request) => request.sessionId)).toEqual(['qa']);
    expect(queue.pendingCount()).toBe(2);
  });

  // v0.9.88 §5.11: the broker is the one place every approval opens, so it raises the attention sound.
  it('sounds once when a card prompt opens, keyed by its id, before any decision', () => {
    const keys: string[] = [];
    const broker = new ApprovalDecisionBroker({ attention: (key) => keys.push(key) });
    const { approvalId } = broker.open(command('dev'));
    expect(keys).toEqual([`approval:${approvalId}`]);
    broker.settle(approvalId, { action: 'once' }, 'human');
    expect(keys).toHaveLength(1);
  });

  it('sounds a native-modal prompt as it opens, before the modal is shown', async () => {
    const keys: string[] = [];
    const broker = new ApprovalDecisionBroker({ attention: (key) => keys.push(key) });
    let soundsWhenShown = -1;
    const { outcome } = broker.openModal(command('dev'), 60_000, async () => {
      soundsWhenShown = keys.length;
      return { action: 'deny' };
    }, 'local:owner');
    await outcome;
    expect(soundsWhenShown).toBe(1);
    expect(keys).toHaveLength(1);
  });

  it('adds no sound when another session joins the prompt, when one leaves, or when it expires', async () => {
    vi.useFakeTimers();
    try {
      const keys: string[] = [];
      const broker = new ApprovalDecisionBroker({ attention: (key) => keys.push(key) });
      const { approvalId, outcome } = broker.open(command('dev'), { timeoutMs: 100 });
      const joined = broker.join(approvalId, 'qa');
      broker.leave('qa');
      await vi.advanceTimersByTimeAsync(100);
      await outcome;
      await joined;
      expect(keys).toEqual([`approval:${approvalId}`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the prompt even when the sound throws', async () => {
    const broker = new ApprovalDecisionBroker({ attention: () => { throw new Error('player gone'); } });
    const { approvalId, outcome } = broker.open(command('dev'));
    expect(broker.isOpen(approvalId)).toBe(true);
    broker.settle(approvalId, { action: 'deny' }, 'human');
    await expect(outcome).resolves.toMatchObject({ action: 'deny', settledBy: 'human' });
  });
});

// v0.9.94: the decision of a reached request limit is a card on this surface. It is not a permission.
describe('the request limit card on the approval surface', () => {
  const card: RequestLimitCard = {
    requestId: 'request-1',
    agent: { id: 'pm', name: 'PM' },
    message: 'A request reached the limit you set.',
    paragraphs: ['Model requests: 12 observed, allowance 12.', 'Held until you decide: the next model request.'],
  };
  const surface = () => {
    const events: ApprovalEvent[] = [];
    const sounds: string[] = [];
    const broker = new ApprovalDecisionBroker({ attention: (key) => sounds.push(key) });
    broker.subscribe({ onEvent: (event) => events.push(event) });
    return { broker, events, sounds };
  };
  const settledEvent = (events: ApprovalEvent[]) => {
    const last = events.at(-1)!;
    if (last.type === 'pending') throw new Error('the card did not settle');
    return last;
  };

  it('opens one card of its own kind under its own session, with no deadline and one sound', () => {
    const { broker, events, sounds } = surface();
    openRequestLimitCard(broker, card);

    const [request] = broker.list('card');
    expect(broker.list('card')).toHaveLength(1);
    expect(broker.list('modal')).toEqual([]);
    expect(request).toMatchObject({
      kind: 'request-limit',
      agentId: 'pm',
      agentName: 'PM',
      sessionId: requestLimitSessionId('request-1'),
      limitMessage: card.message,
      limitDetail: card.paragraphs,
    });
    // Nothing of an approval card: no command, path, tool, grant flag or warning.
    expect(Object.keys(request).sort()).toEqual(['agentId', 'agentName', 'id', 'kind', 'limitDetail', 'limitMessage', 'sessionId']);
    expect(events).toEqual([expect.objectContaining({
      type: 'pending',
      approval: expect.objectContaining({
        agent: { id: 'pm', name: 'PM' },
        action: { kind: 'request-limit', summary: 'Stop or continue a request at its limit' },
        // The broker runs no clock for it: whoever opened the card closes it.
        deadline: null,
      }),
    })]);
    expect(sounds).toEqual([`approval:${request.id}`]);
  });

  it('offers Stop request first and Continue request second, and nothing else', () => {
    expect(REQUEST_LIMIT_ACTIONS).toEqual([
      { action: 'stop', label: 'Stop request' },
      { action: 'continue', label: 'Continue request' },
    ]);
  });

  it('is continued by a person\'s Continue click only: every other click stops', async () => {
    const answerOf = async (action: string): Promise<RequestLimitCardSettlement> => {
      const { broker } = surface();
      const queue = new ApprovalQueue(undefined, undefined, broker);
      const opened = openRequestLimitCard(broker, card);
      expect(queue.resolve(queue.list()[0].id, { action }, 'local:owner')).toBe(true);
      return opened.settled;
    };

    expect(await answerOf('continue')).toBe('continued');
    // The Stop action, the actions of every approval card, and anything a view could send by mistake.
    for (const action of ['stop', 'once', 'always', 'session', 'project', 'safe', 'deny', 'Continue', 'continue ', '']) {
      expect(await answerOf(action), JSON.stringify(action)).toBe('stopped');
    }
  });

  it('closes at once for every reason the wait can end, and drops a Continue that comes later', async () => {
    const endings: Array<[RequestLimitCardEnd, RequestLimitCardSettlement, ApprovalEvent['type']]> = [
      ['expired', 'expired', 'expired'],
      ['withdrawn', 'withdrawn', 'withdrawn'],
      ['ended', 'ended', 'decided'],
      ['disposed', 'ended', 'decided'],
    ];
    for (const [end, settlement, eventType] of endings) {
      const { broker, events, sounds } = surface();
      const opened = openRequestLimitCard(broker, card);
      const { id } = broker.list()[0];
      opened.close(end);

      // Gone from the queue in the same call: no card is left that offers an action.
      expect(broker.list(), end).toEqual([]);
      expect(broker.isOpen(id), end).toBe(false);
      expect(events.at(-1)?.type, end).toBe(eventType);
      expect(broker.settle(id, { action: 'continue' }, 'human', 'local:owner'), end).toBe(false);
      expect(await opened.settled, end).toBe(settlement);
      // Closing twice, or after an answer, changes nothing, and no ending sounds.
      opened.close('expired');
      expect(events, end).toHaveLength(2);
      expect(sounds, end).toHaveLength(1);
    }
  });

  it('keeps the answer the person gave when the wait is closed afterwards', async () => {
    const { broker, events } = surface();
    const opened = openRequestLimitCard(broker, card);
    broker.settle(broker.list()[0].id, { action: 'continue' }, 'human', 'local:owner');
    opened.close('expired');

    expect(await opened.settled).toBe('continued');
    expect(events.map((event) => event.type)).toEqual(['pending', 'decided']);
  });

  it('is not withdrawn when the agent whose conversation it is in is stopped', async () => {
    const { broker } = surface();
    const waits: Array<[string, boolean]> = [];
    broker.subscribe({ onWaitChange: (sessionId, waiting) => waits.push([sessionId, waiting]) });
    const opened = openRequestLimitCard(broker, card);

    expect(broker.leave('pm')).toBe(0);
    expect(broker.list()).toHaveLength(1);
    // No agent is reported as waiting on an approval because of it.
    expect(waits).toEqual([[requestLimitSessionId('request-1'), true]]);
    opened.close('withdrawn');
    expect(await opened.settled).toBe('withdrawn');
  });

  it('is closed, never continued, when the surface is torn down', async () => {
    const torn = surface();
    const queue = new ApprovalQueue(undefined, undefined, torn.broker);
    const denied = openRequestLimitCard(torn.broker, card);
    queue.denyAll();
    expect(await denied.settled).toBe('ended');

    const system = surface();
    const systemQueue = new ApprovalQueue(undefined, undefined, system.broker);
    const closed = openRequestLimitCard(system.broker, card);
    // A system actor is not a person, whatever action it carries.
    expect(systemQueue.resolve(systemQueue.list()[0].id, { action: 'continue' }, 'system:test')).toBe(true);
    expect(await closed.settled).toBe('ended');
  });

  it('reads the event of a settlement exactly as it reads the outcome', async () => {
    const settle: Array<(broker: ApprovalDecisionBroker, id: string, opened: ReturnType<typeof openRequestLimitCard>) => void> = [
      (broker, id) => { broker.settle(id, { action: 'continue' }, 'human', 'local:owner'); },
      (broker, id) => { broker.settle(id, { action: 'continue' }, 'human'); },
      (broker, id) => { broker.settle(id, { action: 'stop' }, 'human', 'local:owner'); },
      (broker, id) => { broker.settle(id, { action: 'always' }, 'human', 'local:owner'); },
      (broker, id) => { broker.settle(id, { action: 'continue' }, 'human', 'system:test'); },
      (broker, id) => { broker.settle(id, { action: 'continue' }, 'human', ''); },
      (broker, id) => { broker.settle(id, { action: 'continue' }, 'host-disposed', 'local:owner'); },
      (broker, id) => { broker.settle(id, { action: 'continue' }, 'expired', 'local:owner'); },
      (broker) => { broker.disposeAll(); },
      (broker) => { broker.leave(requestLimitSessionId('request-1')); },
      (broker, id) => { broker.withdraw(id); },
      (_broker, _id, opened) => { opened.close('expired'); },
      (_broker, _id, opened) => { opened.close('withdrawn'); },
      (_broker, _id, opened) => { opened.close('ended'); },
      (_broker, _id, opened) => { opened.close('disposed'); },
    ];
    const seen: RequestLimitCardSettlement[] = [];
    for (const [index, act] of settle.entries()) {
      const { broker, events } = surface();
      const opened = openRequestLimitCard(broker, card);
      act(broker, broker.list()[0].id, opened);
      const settlement = await opened.settled;
      expect(requestLimitSettlementOfEvent(settledEvent(events)), `way ${index}`).toBe(settlement);
      seen.push(settlement);
    }
    expect(seen).toEqual([
      'continued', 'continued', 'stopped', 'stopped', 'ended', 'ended', 'ended', 'expired',
      'ended', 'withdrawn', 'withdrawn', 'expired', 'withdrawn', 'ended', 'ended',
    ]);
  });

  it('opens in no agent\'s conversation when none is known', () => {
    const { broker } = surface();
    openRequestLimitCard(broker, { ...card, agent: undefined });
    const [request] = broker.list();
    expect(request.agentId).toBeUndefined();
    expect(request.agentName).toBe('UnodeAi');
  });

  it('points at Chat only when no chat container is on screen to show the card', () => {
    const opened = { settled: Promise.resolve<RequestLimitCardSettlement>('stopped'), close: () => undefined };
    const chat = (showing: boolean) => {
      const cards: RequestLimitCard[] = [];
      return { cards, openRequestLimitCard: (shown: RequestLimitCard) => { cards.push(shown); return opened; }, isShowing: () => showing };
    };
    let notices = 0;

    const visible = chat(true);
    expect(showRequestLimitCard(visible, card, () => { notices += 1; })).toBe(opened);
    expect(visible.cards).toEqual([card]);
    expect(notices).toBe(0);

    // Hidden: the card is opened all the same and waits, and the person is told once.
    const hidden = chat(false);
    expect(showRequestLimitCard(hidden, card, () => { notices += 1; })).toBe(opened);
    expect(hidden.cards).toEqual([card]);
    expect(notices).toBe(1);

    // A notice that cannot be shown does not take the card away.
    expect(showRequestLimitCard(chat(false), card, () => { throw new Error('no window'); })).toBe(opened);
  });

  it('opens nothing and throws when there is no chat surface at all', () => {
    let notices = 0;
    expect(() => showRequestLimitCard(undefined, card, () => { notices += 1; })).toThrow('No chat surface');
    expect(notices).toBe(0);
  });
});

describe('ApprovalDecisionBroker withdraw', () => {
  it('ends one prompt for everyone waiting on it, grants nothing, and leaves the others open', async () => {
    const broker = new ApprovalDecisionBroker();
    const events: ApprovalEvent[] = [];
    const waits: Array<[string, boolean]> = [];
    broker.subscribe({ onEvent: (event) => events.push(event), onWaitChange: (sessionId, waiting) => waits.push([sessionId, waiting]) });
    const command = (sessionId: string) => ({ kind: 'command' as const, agentName: sessionId, agentId: sessionId, sessionId, command: 'npm test' });
    const first = broker.open(command('dev'), { timeoutMs: 60_000 });
    const joined = broker.join(first.approvalId, 'qa')!;
    const other = broker.open(command('ops'));

    expect(broker.withdraw(first.approvalId)).toBe(true);
    for (const outcome of [first.outcome, joined]) {
      const settled = await outcome;
      expect(settled).toMatchObject({ action: 'deny', withdrawn: true, settledBy: 'withdrawn', approvalId: first.approvalId });
      expect(settled.approverId).toBeUndefined();
    }
    expect(events.map((event) => event.type)).toEqual(['pending', 'pending', 'withdrawn']);
    expect(broker.list().map((request) => request.sessionId)).toEqual(['ops']);
    expect(broker.isOpen(other.approvalId)).toBe(true);
    expect(waits).toEqual([['dev', true], ['qa', true], ['ops', true], ['dev', false], ['qa', false]]);
    // Its deadline went with it, a second withdrawal finds nothing, and a late answer grants nothing.
    expect(broker.withdraw(first.approvalId)).toBe(false);
    expect(broker.withdraw('unknown')).toBe(false);
    expect(broker.settle(first.approvalId, { action: 'project' }, 'human', 'local:owner')).toBe(false);
  });
});

// §5.10 point 9: every approval the extension raises names its session, so Stop can withdraw it and the
// waiting state belongs to the right agent.
describe('extension approval call sites', () => {
  it('pass the requesting session into every brokered prompt', () => {
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    // v0.9.97: the write cards moved to the abortable helper; they are calls of the same kind.
    const calls = [...source.matchAll(/(?:abortableBrokeredApproval|brokeredApproval|openBrokeredApproval|chatViewProvider!?\.requestApproval)\(\s*/g)]
      .map((match) => match.index!)
      // Skip the helper definitions themselves.
      .filter((index) => !/function\s+$/.test(source.slice(Math.max(0, index - 12), index)));
    expect(calls.length).toBeGreaterThanOrEqual(7);
    for (const index of calls) {
      const call = source.slice(index, source.indexOf(');', index) + 2);
      expect(call, call.slice(0, 120)).toMatch(/\.\.\.origin|sessionId: request\.sessionId|\brequest\b,/);
    }
  });

  // `...origin` in the prompt names nobody when the origin is a default. A backend calls its approver with the
  // request alone, so one that is handed the approval function itself asks in no agent's name: the card belongs
  // to no agent, Stop cannot withdraw it, and the person's wait counts as the agent's tool time. The
  // OpenAI-compatible route's write approval was wired that way until a v0.9.92 field run showed a write card
  // reading `Done · 31.6s` under a footer that had excluded only another prompt.
  it('never hand a backend an approval function without the agent it asks for', () => {
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    const approvals = [
      'requestWriteApproval', 'requestCommandApproval', 'requestExecutableSkillApproval', 'requestClaudeToolApproval',
      'requestCodexApproval', 'egressGate', 'codexEgressGate', 'mediaEgressGate', 'repositoryCliLaunchApproval',
    ];
    for (const name of approvals) {
      // Every mention is a call, the declaration, or a property of that name. None is the function as a value.
      const asValue = [...source.matchAll(new RegExp(`\\b${name}\\b(?![(:])`, 'g'))]
        .map((match) => source.slice(match.index! - 40, match.index! + name.length + 20));
      expect(asValue, name).toEqual([]);
    }
    // Both hosted tool loops ask for a write through the one approver that names the agent.
    expect(source).toContain('const approveWriteForAgent: WriteApprover = (request) => requestWriteApproval(request, scopedConfig.name, approvalOrigin);');
    expect(source).toMatch(/new OpenAICompatBackend\([^\n]*, writeApprovalAsk, approveWriteForAgent, memoryWriter, /);
    expect(source).toContain('requestWriteApproval: approveWriteForAgent,');
    // No default for whose write it is, so the compiler refuses the function where an approver is expected.
    expect(source).toMatch(/async function requestWriteApproval\(\s+req: \{[^}]*\},\s+agentName: string,\s+origin: \{ agentId\?: string; sessionId\?: string \},\s+\): Promise/);
  });

  // v0.9.92: the time a person takes is not the agent's. This covers the approvals that go through the broker or
  // the chat card; the blocking prompts are covered by the next test.
  it('wait for every brokered approval with the turn clock paused', () => {
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    const opened = [...source.matchAll(/(?:brokeredApproval|abortableBrokeredApproval|openBrokeredApproval|chatViewProvider!?\.(?:requestApproval|openRequestLimitCard)|showRequestLimitCard)\(/g)]
      .map((match) => match.index!)
      .filter((index) => !/function\s+$/.test(source.slice(Math.max(0, index - 12), index)))
      // `brokeredApproval` and `abortableBrokeredApproval` only forward to `openBrokeredApproval`; the wait is at
      // their callers.
      .filter((index) => !source.slice(index).startsWith('openBrokeredApproval(request, timeoutMs, showModal).outcome'))
      .filter((index) => !source.slice(index).startsWith('openBrokeredApproval(request, timeoutMs, showModal), signal);'));
    // One exception, by name: the request limit card (v0.9.94) pauses no clock where it is opened. The wait for
    // it is paused at every boundary it holds; the next test pins that, and why a second pause would be wrong.
    const unpaused = opened.filter((index) => source.slice(index).startsWith('showRequestLimitCard(chatViewProvider, card, '));
    expect(unpaused).toHaveLength(1);
    const prompts = opened.filter((index) => !unpaused.includes(index));
    expect(prompts.length).toBeGreaterThanOrEqual(6);
    for (const index of prompts) {
      const before = source.slice(Math.max(0, index - 60), index);
      expect(before, source.slice(index, index + 80)).toMatch(/timedApproval\((?:origin|request), \(\) => (?:\{\s+const opened = )?$/);
    }
    // A request that joins a prompt already open waits as long as the one that opened it.
    expect(source).toContain('timedApproval(request, () => joined)');
    expect(source).toMatch(/function timedApproval<T>\([\s\S]{0,160}?return sessionManager\.timeApproval\(origin\.sessionId \?\? origin\.agentId, open\);/);
  });

  // v0.9.94: the request limit card is the one prompt on the approval surface that is opened without
  // `timedApproval`, and it has to be. The wait for its decision is already counted where it is spent: every
  // boundary held for the decision pauses the turn clock of the agent it holds (`personWait`). The card belongs to
  // a conversation, not to one agent's turn, so a pause of its own would count the same wait a second time for a
  // held agent, or charge it to an agent that is not waiting at all.
  it('open the request limit card without a pause of its own, as a card and never as a dialog', () => {
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    // One opener, and it is what the gate's decision is wired to.
    expect(source.match(/\bshowRequestLimitCard\(/g)).toHaveLength(1);
    expect(source.match(/\.openRequestLimitCard\(/g)).toBeNull();
    expect(source).toMatch(/decide: \(facts, signal\) => askRequestLimitDecision\(facts, signal, \{\s+openCard: openRequestLimitCard,/);
    const opener = source.slice(source.indexOf('function openRequestLimitCard('));
    const body = opener.slice(0, opener.indexOf('\n}\n'));
    expect(body).toContain('return showRequestLimitCard(chatViewProvider, card, () => {');
    expect(body).not.toMatch(/timedApproval|timeApproval|approvalStarted|pausingTurnClock/);
    // The pause that does cover the wait.
    expect(source).toContain('personWait: (id, wait) => sessionManager.timeApproval(id, wait).then(({ outcome }) => outcome),');
    // No dialog, also not as a fallback: the notice that points at Chat is not modal and has one action.
    expect(body).not.toMatch(/modal|blockingPrompt|openModal|brokeredApproval/);
    expect(body).toMatch(/showWarningMessage\(\s+'[^']+'\s+\+ '[^']+',\s+OPEN_CHAT_FOR_REQUEST_LIMIT,\s+\)/);
    expect(body).toContain('if (choice === OPEN_CHAT_FOR_REQUEST_LIMIT) chatViewProvider?.focusPendingApproval(card.agent?.id);');
    // The decision is not a permission: nothing of it reaches the approval metric or the run ledger.
    const wiring = source.slice(source.indexOf('const ceiling = new RequestCeilingGate({'));
    expect(`${body}${wiring.slice(0, wiring.indexOf('requestCeiling = ceiling;'))}`)
      .not.toMatch(/recordBrokeredApproval|recordApprovalMetric|recordApprovalOutcome|recordPermission/);
    expect(source).not.toContain('showRequestLimitPrompt');
  });

  // `blockingPrompt` has no default for whose wait a prompt is, so the compiler makes every call state it. This
  // pins what the calls state: the raising agent's turn clock, or for the two prompts that several agents can
  // wait on, the clock of each agent that waits.
  it('pause a turn clock for every blocking prompt: the raising agent\'s, or each waiting agent\'s for a shared one', () => {
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    const calls = source.match(/\bblockingPrompt\(/g) ?? [];
    const paused = source.match(/\n\s*\), pausingTurnClock\(/g) ?? [];
    const untimed = [...source.matchAll(/\n\s*\), untimedPrompt\('((?:[^'\\]|\\.)*)'\)\);/g)].map((match) => match[1]);
    const mount = source.match(/\n\s*\), mcpMountWaits\.prompt\(cfg\.id\)\);/g) ?? [];
    // v0.9.99 (A8): the start's Retry / Start without integrations dialog is gone, so one call fewer than before.
    expect(calls.length).toBeGreaterThanOrEqual(8);
    expect(paused.length + untimed.length + mount.length).toBe(calls.length);
    // The read-scope prompt pauses nothing itself: each agent's own gate pauses that agent's clock. It is the only
    // one. The request limit decision (v0.9.94) is no blocking prompt: it is a card in Chat, covered above.
    expect(untimed).toEqual([
      expect.stringContaining('Several agents can wait on this one prompt'),
    ]);
    expect(source).toContain('personWait: (id, wait) => sessionManager.timeApproval(id, wait).then(({ outcome }) => outcome),');
    expect(source).toContain('ensure: (root) => localReadScopeConsent.ensure(root, pausingTurnClock(approvalOrigin)),');
    expect(source.match(/localReadScopeConsent: localReadConsentForAgent,/g)).toHaveLength(2);
    // The MCP mount prompt pauses every start that is waiting on that mount, for as long as that start waits.
    expect(mount).toHaveLength(1);
    // A start waits on the mount through `waitAs`, which counts it among the waiters until it goes ahead and no
    // longer. The combined behaviour, with the lease and a retry behind an old dialog, has its own tests.
    expect(source).toContain('waitAs: (key, sessionId, pending, timeoutMs) => mcpMountWaits.waitAs(key, sessionId, pending, timeoutMs),');
    // v0.9.99 (A8): the start itself raises no dialog and never fails for an integration; its Retry is a plain notice.
    const start = source.slice(source.indexOf('async function prepareManagedIntegrations('));
    const startBody = start.slice(0, start.indexOf('\n}\n'));
    expect(startBody).not.toMatch(/blockingPrompt|modal: true|throw new Error/);
    expect(startBody).toMatch(/void vscode\.window\.showWarningMessage\(`\$\{config\.name\}: \$\{notice\}`, 'Retry'\)/);
    expect(source).toMatch(/const mcpMountWaits = new SharedPromptWaits\(\{\s+approvalStarted: \(sessionId, approvalId\) => sessionManager\.approvalStarted\(sessionId, approvalId\),\s+approvalFinished: \(sessionId, approvalId\) => sessionManager\.approvalFinished\(sessionId, approvalId\),/);
    // A prompt raised inside the coordinator's dispatch_task call pauses the coordinator's clock.
    const brief = source.slice(source.indexOf('async function approveCoordinatorBriefEgress('));
    expect(brief.slice(0, brief.indexOf('\n}\n'))).toContain('), pausingTurnClock({ agentId: coordinator.id, sessionId: coordinator.id }));');
    expect(source).toMatch(/function pausingTurnClock\(origin: \{[^}]*\}\): PromptWait \{\s+return \(wait\) => timedApproval\(origin, async \(\) => wait\(\)\)\.then\(\(\{ outcome \}\) => outcome\);/);
  });
});

// v0.9.92: the host's turn facts reach their two consumers. The ledger keeps every ended turn; the chat shows the phase.
describe('extension turn fact wiring', () => {
  it('hands each ended turn to the run ledger and each live phase to the chat', () => {
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    expect(source).toMatch(/sessionManager\.on\('session\.turnEnded', \(e\) => \{\s+if \(e\.sessionId && e\.data\) \{\s+runLedger\.recordTurn\(e\.sessionId, e\.data\);/);
    expect(source).toMatch(/sessionManager\.on\('session\.turnPhase', \(e\) => \{\s+if \(e\.sessionId && e\.data\) \{\s+chatViewProvider\?\.setTurnPhase\(e\.sessionId, e\.data\.phase, e\.data\.epoch\);/);
  });
});

describe('settleOnAbort (v0.9.96)', () => {
  it('closes an open command approval at once as host-disposed when its command can no longer run', async () => {
    const broker = new ApprovalDecisionBroker();
    const abort = new AbortController();
    const opened = broker.open({ kind: 'command', agentName: 'Dev', agentId: 'dev', sessionId: 'dev', command: 'npm run deploy' });
    const outcome = settleOnAbort(broker, opened, abort.signal);
    abort.abort();
    await expect(outcome).resolves.toMatchObject({ action: 'deny', settledBy: 'host-disposed' });
    // A click that arrives afterwards is dropped like any late answer.
    expect(broker.settle(opened.approvalId, { action: 'once' }, 'human', 'local:owner')).toBe(false);
  });

  it('closes a prompt opened after the abort at once, and leaves a prompt without a signal alone', async () => {
    const broker = new ApprovalDecisionBroker();
    const abort = new AbortController();
    abort.abort();
    const late = broker.open({ kind: 'command', agentName: 'Dev', command: 'npm test' });
    await expect(settleOnAbort(broker, late, abort.signal)).resolves.toMatchObject({ settledBy: 'host-disposed' });
    const plain = broker.open({ kind: 'command', agentName: 'Dev', command: 'npm test' });
    const outcome = settleOnAbort(broker, plain);
    expect(broker.settle(plain.approvalId, { action: 'once' }, 'human', 'local:owner')).toBe(true);
    await expect(outcome).resolves.toMatchObject({ action: 'once', settledBy: 'human' });
  });
});
