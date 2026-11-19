import { beforeEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler, TurnAttachments } from '../../backend/AgentBackend';
import type { AgentConfig, Message } from '../../types';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { compileTaskContract, TaskInputResolver, type TaskAttemptCard } from '../../backend/TaskContract';
import { WorkspaceTools } from '../../backend/WorkspaceTools';

/**
 * v0.9.103 slice 1 (design §4 G1, §5.2, §5.6): a teammate's message to the coordinator of its live task is bound by the
 * host to that attempt, wakes the coordinator in the lane of the task's results, takes its request from the attempt's
 * saved binding, is batched only within its request, and a delivery of the same event id starts nothing.
 */
class FakeBackend implements AgentBackend {
  readonly agentId: string;
  pid = 1;
  turns: string[] = [];
  attachments: Array<TurnAttachments | undefined> = [];
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void { this.handler = h; return () => { this.handler = undefined; }; }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(instruction: string, attachments?: TurnAttachments): void { this.turns.push(instruction); this.attachments.push(attachments); }
  async stop(): Promise<void> { this.alive = false; this.emit({ kind: 'exit', code: 0 }); }
  abort(): void {}
  setModel(): void {}
  isAlive(): boolean { return this.alive; }
  emit(e: BackendEvent): void { this.handler?.(e); }
}

function config(id: string, role: string): AgentConfig {
  return {
    id, name: id === 'dev' ? 'Dev' : id === 'pm' ? 'PM' : id, role: role as AgentConfig['role'], skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' }, model: 'claude-sonnet-4-20250514',
    systemPrompt: '', autoApprove: true, allowedTools: ['message'],
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('v0.9.103 a teammate\'s message bound to its task', () => {
  let bus: MessageBus;
  let mgr: SessionManager;
  let backends: Map<string, FakeBackend>;
  let held: boolean;
  let notices: string[];
  let resolver: TaskInputResolver;

  beforeEach(async () => {
    bus = new MessageBus();
    backends = new Map();
    held = false;
    notices = [];
    resolver = new TaskInputResolver(new ContentAssetStore(), process.cwd());
    mgr = new SessionManager(5, bus, {
      createBackend: (agent) => { const backend = new FakeBackend(agent); backends.set(agent.id, backend); return backend; },
      resolveEnv: async () => ({}),
      coordinatorHeld: () => held,
    });
    mgr.on('session.runtimeNotice', (event) => { if (event.sessionId === 'pm') notices.push(event.data.text); });
    // As activation wires it: a turn with no attempt card is on the thread the session manager says it is on.
    resolver.setTurnThreadSource((agentId) => mgr.taskThreadOf(agentId));
    for (const [id, role] of [['pm', 'pm'], ['dev', 'senior-dev'], ['writer', 'senior-dev']] as const) {
      mgr.create(config(id, role));
      await mgr.start(id, { pin: 'take' });
      backends.get(id)!.emit({ kind: 'ready' });
    }
  });

  /** A live attempt the coordinator `pm` gave to `agentId` under `handle`, as TeamTools makes and binds one. */
  async function attempt(agentId: string, handle: string, objective: string): Promise<TaskAttemptCard> {
    const contract = compileTaskContract({
      version: 1, objective, effects: { read_files: [], expected_file_effect: 'none' }, inputs: [],
      required_capabilities: { version: 1, capabilities: ['read'] }, execution_strategy: 'delegate-required',
    }, 'pm').contract!;
    const card = (await resolver.beginAttempt(contract, {
      agentId, capabilities: { read: true, write: false, shell: false }, taskScope: 'per-turn',
      verificationSensors: [], authorizedContentAssetIds: [], liveContentAssetIds: [], readyArtifacts: [],
    }, 'pm')).card!;
    resolver.bindAttemptHandle(card.attemptId, handle);
    return card;
  }

  /** The person's request to the PM: its turn starts, and its request id is returned. */
  function personAsks(text: string): string {
    bus.send('user', 'pm', 'ask.question', { instruction: text });
    return mgr.currentRequestId('pm')!;
  }

  /** The PM, in its turn, assigns the attempt to its teammate under the handle (TeamTools' task.assign). */
  function assign(card: TaskAttemptCard, handle: string): void {
    bus.send('pm', card.agentId, 'task.assign', { instruction: card.contract.objective, taskAttempt: card }, 'high', handle);
  }

  function endTurn(agentId: string, text: string): void {
    backends.get(agentId)!.emit({ kind: 'turn_complete', result: { text, isError: false } });
  }

  /** The teammate's own tool surface, in its running turn on `card`. */
  function teammateTools(card: TaskAttemptCard): WorkspaceTools {
    const tools = new WorkspaceTools(process.cwd(), new Set(['message']), card.agentId, undefined, undefined, undefined, undefined, bus);
    tools.setTaskInputResolver(resolver);
    tools.beginTurn();
    tools.setTaskAttempt(card);
    return tools;
  }

  const wakes = (): Message[] => bus.query({ type: 'ask.question' }).filter((message) => message.from === 'unode');

  it('a note about request A wakes the PM in a turn of request A, though the PM was serving request B when it came', async () => {
    const requestA = personAsks('Request A');
    const card = await attempt('dev', 'handle-a', 'Write the summary.');
    assign(card, 'handle-a');
    endTurn('pm', 'Dev is on it.');
    const requestB = personAsks('Request B');
    expect(requestB).not.toBe(requestA);

    const sent = await teammateTools(card).runText('send_message', { target: 'coordinator', message: 'Half of the summary is written.' });
    expect(sent).toBe('Sent to your coordinator as a note on this task. No answer is expected: carry on with the task.');
    await tick();
    // The PM is busy with B: nothing is folded into B's turn.
    expect(backends.get('pm')!.turns).toEqual(['Request A', 'Request B']);
    expect(notices).toEqual(['Dev sent a note on its task "Write the summary.": Half of the summary is written.']);

    endTurn('pm', 'B is answered.');
    await tick();
    const pm = backends.get('pm')!;
    expect(pm.turns).toHaveLength(3);
    expect(mgr.currentRequestId('pm')).toBe(requestA);
    expect(pm.turns[2]).toContain('A teammate\'s message on a running task arrived.');
    expect(pm.turns[2]).toContain('=== dev (handle-a) ===\nMessage from Dev on this task — note (no answer expected); event task-message-');
    expect(pm.turns[2]).toContain('Half of the summary is written.');
    expect(pm.turns[2]).not.toContain('record the decision with record_task_disposition');
    expect(pm.attachments[2]?.turnOrigin).toBe('delegation-result');
    expect(wakes().at(-1)?.payload.metadata).toMatchObject({ trigger: { sources: [{ agentId: 'dev', reason: 'task-message' }], more: 0 } });
    // Nothing is expected back: the PM's reply goes to the host's wake, not to the teammate.
    endTurn('pm', 'Noted.');
    expect(bus.query({ type: 'task.complete' }).at(-1)).toMatchObject({ from: 'pm', to: 'unode' });
    await tick();
    expect(pm.turns).toHaveLength(3);
  });

  it('a message for request A and a result for request B, ready together, go to separate PM turns, each of its own request', async () => {
    const requestA = personAsks('Request A');
    const cardA = await attempt('dev', 'handle-a', 'Write A.');
    assign(cardA, 'handle-a');
    endTurn('pm', 'Dev is on A.');
    const requestB = personAsks('Request B');
    const cardB = await attempt('writer', 'handle-b', 'Write B.');
    assign(cardB, 'handle-b');
    // While the PM is still in B's turn: Dev asks about A, and B's result is ready (no run ledger here: one run for all).
    await teammateTools(cardA).runText('send_message', { target: 'pm', message: 'Which format for A?', kind: 'question' });
    mgr.queueAsyncDelegationWake('pm', { handle: 'handle-b', ref: 'writer', text: 'B is written.' }, () => true, () => true);
    await tick();
    endTurn('pm', 'Writer is on B.');
    await tick();
    const pm = backends.get('pm')!;
    expect(pm.turns).toHaveLength(3);
    expect(mgr.currentRequestId('pm')).toBe(requestA);
    expect(pm.turns[2]).toContain('Which format for A?');
    expect(pm.turns[2]).toContain('question (answer expected)');
    expect(pm.turns[2]).not.toContain('B is written.');

    endTurn('pm', 'Told the person about A.');
    await tick();
    expect(pm.turns).toHaveLength(4);
    expect(mgr.currentRequestId('pm')).toBe(requestB);
    expect(pm.turns[3]).toContain('Async delegation result arrived');
    expect(pm.turns[3]).toContain('B is written.');
    expect(pm.turns[3]).not.toContain('Which format for A?');
  });

  it('notes of one request that are ready together wake the PM once, each with its own event id', async () => {
    personAsks('Request A');
    const card = await attempt('dev', 'handle-a', 'Write A.');
    assign(card, 'handle-a');
    const tools = teammateTools(card);
    // The PM is still in its turn: both notes wait for it.
    await tools.runText('send_message', { target: 'pm', message: 'First part done.' });
    await tools.runText('send_message', { target: 'pm', message: 'Second part done.' });
    mgr.queueAsyncDelegationWake('pm', { handle: 'handle-a', ref: 'dev', text: 'All of A is written.' }, () => true, () => true);
    endTurn('pm', 'Dev is on A.');
    await tick();
    const pm = backends.get('pm')!;
    expect(pm.turns).toHaveLength(2);
    const ids = [...pm.turns[1].matchAll(/event (task-message-[0-9a-f-]+)/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(pm.turns[1]).toContain('Async delegation result arrived');
    expect(pm.turns[1]).toContain('All of A is written.');
    expect(wakes().at(-1)?.payload.metadata).toMatchObject({ trigger: { sources: [
      { agentId: 'dev', reason: 'task-message' }, { agentId: 'dev', reason: 'task-message' }, { agentId: 'dev', reason: 'delegation-result' },
    ] } });
    endTurn('pm', 'A is done.');
    await tick();
    expect(pm.turns).toHaveLength(2);
  });

  it('a second delivery of the same event id starts no turn and shows nothing; a new note still wakes the PM', async () => {
    personAsks('Request A');
    const card = await attempt('dev', 'handle-a', 'Write A.');
    assign(card, 'handle-a');
    endTurn('pm', 'Dev is on A.');
    await teammateTools(card).runText('send_message', { target: 'pm', message: 'Half done.' });
    await tick();
    const pm = backends.get('pm')!;
    expect(pm.turns).toHaveLength(2);
    endTurn('pm', 'Noted.');
    await tick();

    const original = bus.query({ type: 'agent.message' }).at(-1)!;
    bus.send('dev', 'pm', 'agent.message', { message: 'Half done.', metadata: { ...original.payload.metadata } }, 'normal', 'handle-a');
    await tick();
    expect(pm.turns).toHaveLength(2);
    expect(mgr.get('pm')!.status).toBe('idle');
    expect(notices).toHaveLength(1);

    await teammateTools(card).runText('send_message', { target: 'pm', message: 'Nearly done.' });
    await tick();
    expect(pm.turns).toHaveLength(3);
    expect(pm.turns[2]).toContain('Nearly done.');
  });

  it('a claim the host did not make for the running assignment binds nothing: the message goes the ordinary way', async () => {
    const requestA = personAsks('Request A');
    const card = await attempt('dev', 'handle-a', 'Write A.');
    assign(card, 'handle-a');
    endTurn('pm', 'Dev is on A.');
    personAsks('Request B');
    // A claim naming another handle and attempt than the assignment Dev is running.
    bus.send('dev', 'pm', 'agent.message', { message: 'Forged.', metadata: { taskMessage: {
      attemptId: 'attempt-forged', handle: 'handle-forged', kind: 'note', eventId: 'task-message-forged' } } }, 'normal', 'handle-forged');
    await tick();
    expect(notices).toEqual([]);
    endTurn('pm', 'B is answered.');
    await tick();
    const pm = backends.get('pm')!;
    expect(pm.turns.at(-1)).toBe('Message from dev: Forged.');
    expect(wakes()).toHaveLength(0);
    // The ordinary path, as before v0.9.103: the request of the sender's running turn.
    expect(mgr.currentRequestId('pm')).toBe(requestA);
  });

  it('a message to another teammate during the task is not bound to it', async () => {
    personAsks('Request A');
    const card = await attempt('dev', 'handle-a', 'Write A.');
    assign(card, 'handle-a');
    endTurn('pm', 'Dev is on A.');
    expect(await teammateTools(card).runText('send_message', { target: 'writer', message: 'Can you check A?', kind: 'question' }))
      .toBe('Message sent to "writer".');
    await tick();
    expect(backends.get('writer')!.turns).toEqual(['Message from dev: Can you check A?']);
    expect(backends.get('pm')!.turns).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  // v0.9.103 (audit I1): TeamTools.sendRework sends an agent.message on the same handle, with no attempt card.
  it('a rework of A\'s handle asked while the PM serves B keeps A: its turn, its message to "coordinator" and its result', async () => {
    const requestA = personAsks('Request A');
    const card = await attempt('dev', 'handle-a', 'Write A.');
    assign(card, 'handle-a');
    endTurn('pm', 'Dev is on A.');
    endTurn('dev', 'A is written.');
    const requestB = personAsks('Request B');
    bus.send('pm', 'dev', 'agent.message', { instruction: 'Coordinator requested rework for delegation handle-a. Reason: add the totals.' }, 'high', 'handle-a');
    expect(backends.get('dev')!.turns.at(-1)).toContain('Coordinator requested rework for delegation handle-a.');
    expect(mgr.currentRequestId('dev')).toBe(requestA);
    expect(mgr.taskThreadOf('dev')).toEqual({ coordinatorId: 'pm', handle: 'handle-a' });

    const tools = new WorkspaceTools(process.cwd(), new Set(['message']), 'dev', undefined, undefined, undefined, undefined, bus);
    tools.setTaskInputResolver(resolver);
    tools.beginTurn();
    // v0.9.103 slice 2 (audit I1): the rework turn is told that no answer comes back into it.
    expect(await tools.runText('send_message', { target: 'coordinator', message: 'Should the totals include tax?', kind: 'question' }))
      .toContain('Sent to your coordinator as a question on this task; the PM is told. In a rework turn the answer does not come back into this turn');
    expect(notices).toEqual(['Dev asked a question on its task handle-a: Should the totals include tax?']);
    endTurn('pm', 'B is answered.');
    await tick();
    const pm = backends.get('pm')!;
    expect(pm.turns.at(-1)).toContain('Should the totals include tax?');
    expect(mgr.currentRequestId('pm')).toBe(requestA);
    endTurn('pm', 'Asked the person about tax.');
    await tick();

    // The rework's reply wakes the PM under A too: the handle's saved binding was not rewritten to B.
    endTurn('dev', 'A is revised.');
    mgr.queueAsyncDelegationWake('pm', { handle: 'handle-a', ref: 'dev', text: 'A is revised.', reason: 'rework-reply' }, () => true, () => true);
    await tick();
    expect(pm.turns.at(-1)).toContain('A is revised.');
    expect(mgr.currentRequestId('pm')).toBe(requestA);
    expect(mgr.currentRequestId('pm')).not.toBe(requestB);
  });

  // v0.9.103 (audit I2): a wake carries only the owed reviews of its own request.
  it('a message wake of request A carries none of request B\'s owed review, which then takes a turn of its own under B', async () => {
    const requestA = personAsks('Request A');
    const cardA = await attempt('dev', 'handle-a', 'Write A.');
    assign(cardA, 'handle-a');
    endTurn('pm', 'Dev is on A.');
    const requestB = personAsks('Request B');
    const cardB = await attempt('writer', 'handle-b', 'Write B.');
    assign(cardB, 'handle-b');
    // B's result was reported without a decision: its one automatic review is owed.
    (mgr as unknown as { pendingReviewContinuations: Map<string, unknown[]> }).pendingReviewContinuations
      .set('pm', [{ handle: 'handle-b', revision: 1, agent: 'writer' }]);
    await teammateTools(cardA).runText('send_message', { target: 'pm', message: 'Is A a draft?' });
    endTurn('pm', 'Writer is on B.');
    await tick();
    const pm = backends.get('pm')!;
    expect(pm.turns).toHaveLength(3);
    expect(pm.turns[2]).toContain('Is A a draft?');
    expect(pm.turns[2]).not.toContain('no recorded decision');
    expect(mgr.currentRequestId('pm')).toBe(requestA);
    expect(wakes().at(-1)?.payload.metadata).not.toHaveProperty('reviewContinuation');

    endTurn('pm', 'Noted.');
    await tick();
    expect(pm.turns).toHaveLength(4);
    expect(pm.turns[3]).toContain('Delegated results still have no recorded decision');
    expect(pm.turns[3]).not.toContain('Is A a draft?');
    expect(mgr.currentRequestId('pm')).toBe(requestB);
  });

  // v0.9.103 (audit I2, the separate path): owed reviews of two requests take one turn each, under their own request.
  describe('owed reviews of two requests on the separate review path', () => {
    type Internals = {
      pendingReviewContinuations: Map<string, unknown[]>;
      deps: { consumeReviewContinuationDurably?: unknown; coordinatorTaskStatus?: unknown };
    };
    /** Requests A and B, each with a result the PM reported without a decision; both reviews owed while the PM is in B. */
    async function twoOwed(): Promise<{ requestA: string; requestB: string; pm: FakeBackend }> {
      const requestA = personAsks('Request A');
      assign(await attempt('dev', 'handle-a', 'Write A.'), 'handle-a');
      endTurn('pm', 'Dev is on A.');
      const requestB = personAsks('Request B');
      assign(await attempt('writer', 'handle-b', 'Write B.'), 'handle-b');
      (mgr as unknown as Internals).pendingReviewContinuations.set('pm', [
        { handle: 'handle-a', revision: 1, agent: 'dev' }, { handle: 'handle-b', revision: 1, agent: 'writer' },
      ]);
      return { requestA, requestB, pm: backends.get('pm')! };
    }
    const reviewOf = (turn: string | undefined) => [...(turn ?? '').matchAll(/(dev|writer) \(handle-/g)].map((match) => match[1]);

    it('without a durable save: two turns, A\'s review under A, then B\'s under B', async () => {
      const { requestA, requestB, pm } = await twoOwed();
      endTurn('pm', 'Writer is on B.');
      await tick();
      expect(pm.turns).toHaveLength(3);
      expect(reviewOf(pm.turns[2])).toEqual(['dev']);
      expect(mgr.currentRequestId('pm')).toBe(requestA);
      endTurn('pm', 'A reviewed.');
      await tick();
      expect(pm.turns).toHaveLength(4);
      expect(reviewOf(pm.turns[3])).toEqual(['writer']);
      expect(mgr.currentRequestId('pm')).toBe(requestB);
      endTurn('pm', 'B reviewed.');
      await tick();
      expect(pm.turns).toHaveLength(4);
    });

    it('with the durable save: each request\'s reviews are saved as consumed with its own turn, and one no longer owed hands on to the next', async () => {
      const { requestB, pm } = await twoOwed();
      const saved: string[][] = [];
      const internals = mgr as unknown as Internals;
      // A's review was taken elsewhere meanwhile: the save consumes only B's.
      internals.deps.consumeReviewContinuationDurably = async (_coordinator: string, refs: Array<{ handle: string; revision: number }>) => {
        saved.push(refs.map((ref) => ref.handle));
        return { consumed: refs.filter((ref) => ref.handle !== 'handle-a'), saved: true };
      };
      internals.deps.coordinatorTaskStatus = () => ['handle-a', 'handle-b'].map((handle) => ({
        handle, lifecycle: 'settled', result: { ref: { handle, revision: 1 }, state: 'awaiting-decision', delivery: 'delivered' } }));
      endTurn('pm', 'Writer is on B.');
      for (let i = 0; i < 5; i++) await tick();
      expect(saved).toEqual([['handle-a'], ['handle-b']]);
      expect(pm.turns).toHaveLength(3);
      expect(reviewOf(pm.turns[2])).toEqual(['writer']);
      expect(mgr.currentRequestId('pm')).toBe(requestB);
    });
  });

  it('a message queued for a held (stopped) PM is not delivered', async () => {
    personAsks('Request A');
    const card = await attempt('dev', 'handle-a', 'Write A.');
    assign(card, 'handle-a');
    await teammateTools(card).runText('send_message', { target: 'pm', message: 'Half done.' });
    held = true;
    endTurn('pm', 'Dev is on A.');
    await tick();
    expect(backends.get('pm')!.turns).toHaveLength(1);
    expect(mgr.pendingAsyncDelegationWakeCount('pm')).toBe(0);
  });
});
