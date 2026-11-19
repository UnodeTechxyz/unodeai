import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../SessionManager';
import { TaskExchanges, exchangeState } from '../TaskExchanges';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler, TurnAttachments, TurnResult } from '../../backend/AgentBackend';
import type { AgentConfig, Message } from '../../types';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { compileTaskContract, TaskInputResolver, type TaskAttemptCard } from '../../backend/TaskContract';
import { WorkspaceTools } from '../../backend/WorkspaceTools';
import { TeamTools } from '../../backend/TeamTools';

/**
 * v0.9.103 slice 2 (design §4 G2, G3, §5.3, §5.5, §5.6, §7): a teammate's question opens an exchange the coordinator
 * answers with reply_to_task; the answer reaches the running turn where the route confirms it, and otherwise the turn end
 * is a waiting checkpoint that a continuation of the same attempt resolves. SessionManager with the real WorkspaceTools
 * and TaskInputResolver; the backends are fakes, one with a route that confirms in-turn notices and one without.
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
  async stop(): Promise<void> { this.alive = false; }
  abort(): void {}
  setModel(): void {}
  isAlive(): boolean { return this.alive; }
  emit(e: BackendEvent): void { this.handler?.(e); }
}

/** A route that confirms an in-turn notice (OpenAI-compatible and Codex do, by steerNotice). */
class SteerableBackend extends FakeBackend {
  accept = true;
  notices: string[] = [];
  steerNotice(text: string): Promise<boolean> { this.notices.push(text); return Promise.resolve(this.accept); }
}

function config(id: string, role: string): AgentConfig {
  return {
    id, name: id === 'dev' ? 'Dev' : id === 'pm' ? 'PM' : id, role: role as AgentConfig['role'], skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' }, model: 'claude-sonnet-4-20250514',
    systemPrompt: '', autoApprove: true, allowedTools: ['message'],
  };
}

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0)); };

describe('v0.9.103 slice 2: a teammate\'s question, its exchange and the answer path', () => {
  let bus: MessageBus;
  let mgr: SessionManager;
  let backends: Map<string, FakeBackend>;
  let steerable: Set<string>;
  let held: boolean;
  let resolver: TaskInputResolver;
  let terminal: string[];
  let ended: string[];
  let notices: Array<{ sessionId: string; text: string }>;
  let accessRequests: Array<string | undefined>;

  beforeEach(async () => {
    accessRequests = [];
    bus = new MessageBus();
    backends = new Map();
    steerable = new Set();
    held = false;
    terminal = [];
    ended = [];
    notices = [];
    resolver = new TaskInputResolver(new ContentAssetStore(), process.cwd());
    mgr = new SessionManager(5, bus, {
      createBackend: (agent) => {
        const backend = steerable.has(agent.id) ? new SteerableBackend(agent) : new FakeBackend(agent);
        backends.set(agent.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
      coordinatorHeld: () => held,
      onTaskAttemptTerminal: (attemptId) => { terminal.push(attemptId); },
      endTaskAttempt: (attemptId) => { ended.push(attemptId); resolver.endAttempt(attemptId, 'cancelled'); },
      // The scope's ceiling as the host resolves it, each time from the assignment's own scope and request.
      resolveTaskWorkspaceAccess: (_config, msg, requestId) => {
        accessRequests.push(requestId);
        return { access: { pathBase: process.cwd(), readRoots: (msg.payload.taskScope?.folderAccess ?? []).map((grant) => grant.path), writeRoots: [] } };
      },
    });
    mgr.on('session.runtimeNotice', (event) => { notices.push({ sessionId: event.sessionId, text: event.data.text }); });
  });

  async function team(options: { steer?: boolean } = {}): Promise<void> {
    if (options.steer) steerable.add('dev');
    for (const [id, role] of [['pm', 'pm'], ['dev', 'senior-dev']] as const) {
      mgr.create(config(id, role));
      await mgr.start(id, { pin: 'take' });
      backends.get(id)!.emit({ kind: 'ready' });
    }
  }

  async function attempt(handle: string): Promise<TaskAttemptCard> {
    const contract = compileTaskContract({
      version: 1, objective: 'Write the summary.', effects: { read_files: [], expected_file_effect: 'none' }, inputs: [],
      required_capabilities: { version: 1, capabilities: ['read'] }, execution_strategy: 'delegate-required',
    }, 'pm').contract!;
    const card = (await resolver.beginAttempt(contract, {
      agentId: 'dev', capabilities: { read: true, write: false, shell: false }, taskScope: 'per-turn',
      verificationSensors: [], authorizedContentAssetIds: [], liveContentAssetIds: [], readyArtifacts: [],
    }, 'pm')).card!;
    resolver.bindAttemptHandle(card.attemptId, handle);
    return card;
  }

  const scope = { folderAccess: [{ path: 'docs', permission: 'read' as const }] };

  /** The person asks the PM; the PM assigns the attempt to Dev under `handle` and ends its turn. Returns the request. */
  async function delegated(handle = 'handle-a'): Promise<{ card: TaskAttemptCard; requestId: string }> {
    bus.send('user', 'pm', 'ask.question', { instruction: 'Request A' });
    const requestId = mgr.currentRequestId('pm')!;
    const card = await attempt(handle);
    bus.send('pm', 'dev', 'task.assign', { instruction: 'Write the summary.', taskAttempt: card, taskScope: scope }, 'high', handle);
    endTurn('pm', 'Dev is on it.');
    await tick();
    return { card, requestId };
  }

  function endTurn(agentId: string, text: string, extra: Partial<TurnResult> = {}): void {
    backends.get(agentId)!.emit({ kind: 'turn_complete', result: { text, isError: false, ...extra } });
  }

  async function ask(card: TaskAttemptCard, question = 'Which format?', kind = 'question'): Promise<string> {
    const tools = new WorkspaceTools(process.cwd(), new Set(['message']), 'dev', undefined, undefined, undefined, undefined, bus);
    tools.setTaskInputResolver(resolver);
    tools.beginTurn();
    tools.setTaskAttempt(card);
    return tools.runText('send_message', { target: 'coordinator', message: question, kind });
  }

  /** Dev asks; the PM is woken with the question and the exchange id under the task. Returns that id. */
  async function asked(card: TaskAttemptCard, question = 'Which format?'): Promise<string> {
    await ask(card, question);
    await tick();
    const wake = backends.get('pm')!.turns.at(-1)!;
    const id = /exchange (exchange-[0-9a-f]{8})/.exec(wake)?.[1];
    expect(id, wake).toBeDefined();
    return id!;
  }

  const records = (fact?: string): Array<Message & { payload: { metadata: { taskExchange: Record<string, unknown> } } }> => bus.query({ type: 'ask.answer' })
    .filter((message) => !fact || (message.payload.metadata as { taskExchange: { fact: string } }).taskExchange.fact === fact) as never;
  const results = (handle = 'handle-a') => bus.query().filter((message) => message.from === 'dev' && message.correlationId === handle
    && (message.type === 'task.complete' || message.type === 'task.partial' || message.type === 'system.error'));

  it('the PM\'s wake shows the question under its task with its exchange id; the answer is delivered into the running turn where the route confirms it', async () => {
    await team({ steer: true });
    const { card } = await delegated();
    const id = await asked(card);
    const pm = backends.get('pm')!;
    expect(pm.turns.at(-1)).toContain('=== dev (handle-a) ===\nMessage from Dev on this task — question (answer expected); event task-message-');
    expect(pm.turns.at(-1)).toContain(`; exchange ${id}:\nWhich format?\nAnswer it with reply_to_task: handle "handle-a", exchange_id "${id}".`);
    expect(pm.turns.at(-1)).toContain('answer it with reply_to_task');
    expect(mgr.taskExchangeFacts('handle-a')).toEqual({ attemptId: card.attemptId, owed: [{ exchangeId: id, kind: 'question', state: 'question-open' }],
      waiting: false, exchangeCount: 1 });
    // The PM's wake took the message: a receipt for Dev, which starts nothing.
    expect(records('message-delivered')).toHaveLength(1);

    const reply = mgr.replyToTask('pm', 'handle-a', id, 'Use Markdown.');
    expect(reply.status).toBe('queued');
    await tick();
    const dev = backends.get('dev') as SteerableBackend;
    expect(dev.notices).toEqual([`Your coordinator answered your question on this task (${id}): Use Markdown.`]);
    expect(mgr.taskExchangeFacts('handle-a')!.owed).toEqual([]);
    expect(records('answer-delivered')).toHaveLength(1);
    expect(records('answer-delivered')[0]).toMatchObject({ from: 'unode', to: 'pm', correlationId: 'handle-a' });
    expect(notices).toContainEqual({ sessionId: 'dev', text: `The PM answered the question on this task (${id}): Use Markdown.` });

    // The PM's own reply goes to the host's wake, as ever; the receipt started no PM turn.
    const pmTurns = pm.turns.length;
    endTurn('pm', 'Answered Dev.');
    await tick();
    expect(pm.turns).toHaveLength(pmTurns);
    // Delivered: Dev's turn end is its result, once, under the original handle.
    endTurn('dev', 'Summary in Markdown.');
    await tick();
    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({ type: 'task.complete', to: 'pm', payload: { instruction: 'Summary in Markdown.' } });
    expect(terminal).toEqual([card.attemptId]);
    expect(dev.turns).toHaveLength(1);
  });

  it('a route that cannot take the answer: the turn end is a waiting checkpoint (no result, no terminal callback, task slot kept), then the same attempt continues and yields exactly one result', async () => {
    await team();
    const { card, requestId } = await delegated();
    const id = await asked(card);
    expect(mgr.replyToTask('pm', 'handle-a', id, 'Use Markdown.').status).toBe('queued');
    endTurn('pm', 'Answered Dev.');
    await tick();
    expect(mgr.taskExchangeFacts('handle-a')!.owed).toEqual([{ exchangeId: id, kind: 'question', state: 'answer-queued' }]);
    const dev = backends.get('dev')!;
    // The request's task has ended its PM turn; Dev's work holds it open.
    expect(mgr.getRecentTaskTokens(50)).toEqual([]);

    // Dev's turn ends while the answer is owed to it.
    endTurn('dev', 'Waiting for the format.', { usage: { inputTokens: 10, outputTokens: 5 } as TurnResult['usage'] });
    // At that turn end: no correlated result, no attempt-terminal callback, no grant cleanup, the slot kept.
    expect(results()).toEqual([]);
    expect(terminal).toEqual([]);
    expect(ended).toEqual([]);
    expect(resolver.isAttemptLive(card.attemptId, 'dev')).toBe(true);
    const note = bus.query({ type: 'task.status' }).filter((message) => (message.payload.metadata as { taskWaiting?: unknown } | undefined)?.taskWaiting);
    expect(note).toHaveLength(1);
    expect(note[0]).toMatchObject({ from: 'dev', to: 'pm', correlationId: 'handle-a', payload: { instruction: 'Waiting for the format.' } });
    expect(mgr.getRecentTaskTokens(50)).toEqual([]);

    // The continuation: the same attempt, handle, scope and request; no new dispatch on the bus.
    await tick();
    expect(dev.turns).toHaveLength(2);
    expect(dev.turns[1]).toContain(`Your question (${id}): Which format?\n  Answer: Use Markdown.`);
    expect(dev.attachments[1]?.taskAttempt?.attemptId).toBe(card.attemptId);
    expect(mgr.currentRequestId('dev')).toBe(requestId);
    // The access is derived again from the same scope and request: nothing is issued again or widened.
    expect(accessRequests).toEqual([requestId, requestId]);
    expect(dev.attachments[1]?.taskWorkspaceAccess).toEqual(dev.attachments[0]?.taskWorkspaceAccess);
    expect(mgr.delegationExecution('dev', 'handle-a')).toEqual({ state: 'running' });
    expect(bus.query({ type: 'task.assign' })).toHaveLength(1);
    expect(mgr.taskExchangeFacts('handle-a')).toMatchObject({ owed: [], waiting: false, exchangeCount: 1 });
    expect(records('answer-delivered')).toHaveLength(1);

    endTurn('dev', 'Summary in Markdown.', { usage: { inputTokens: 10, outputTokens: 5 } as TurnResult['usage'] });
    await tick();
    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({ type: 'task.complete', to: 'pm', correlationId: 'handle-a', payload: { instruction: 'Summary in Markdown.' } });
    expect(terminal).toEqual([card.attemptId]);
    // The request's task finishes with Dev's two turns, the checkpoint's and the continuation's, in it.
    expect(mgr.getRecentTaskTokens(50)).toEqual([expect.objectContaining({ id: requestId, agents: [expect.objectContaining({ agentId: 'dev', inputTokens: 20, outputTokens: 10 })] })]);
  });

  it('the continuation keeps the assignment\'s scope and correlation, and carries no forwarded sources again', async () => {
    await team();
    const { card } = await delegated();
    const id = await asked(card);
    endTurn('pm', 'Asked the person.');
    endTurn('dev', 'Waiting for the format.');
    await tick();
    const scoped: unknown[] = [];
    mgr.on('session.taskScopeApplied', (event) => { scoped.push(event.data); });
    mgr.replyToTask('pm', 'handle-a', id, 'Use Markdown.');
    await tick();
    expect(scoped).toEqual([{ handle: 'handle-a', scope }]);
    const dev = backends.get('dev')!;
    expect(dev.attachments[1]?.taskAttempt).toEqual(card);
    expect(dev.attachments[1]?.delegationContentSources).toBeUndefined();
  });

  it('the teammate ends its turn waiting; the answer comes later and continues the same attempt', async () => {
    await team();
    const { card } = await delegated();
    const id = await asked(card);
    endTurn('pm', 'I will ask the person.');
    endTurn('dev', 'Waiting for the format.');
    await tick();
    expect(results()).toEqual([]);
    expect(mgr.taskExchangeFacts('handle-a')).toMatchObject({ waiting: true, owed: [{ exchangeId: id, state: 'question-open' }] });
    expect(mgr.awaitsExchange('handle-a')).toBe(true);
    // What inspect_task_status reads: waiting for the answer, with its exchange, never "not running".
    expect(mgr.delegationExecution('dev', 'handle-a')).toEqual({ state: 'waiting-for-answer', exchangeIds: [id] });
    expect(mgr.delegationExecution('dev', 'handle-other')).toEqual({ state: 'not-running' });
    expect(backends.get('dev')!.turns).toHaveLength(1);

    const reply = mgr.replyToTask('pm', 'handle-a', id, 'Use Markdown.');
    expect(reply).toMatchObject({ status: 'queued' });
    expect(reply.text).toContain('continues the same task');
    await tick();
    expect(backends.get('dev')!.turns).toHaveLength(2);
    expect(mgr.awaitsExchange('handle-a')).toBe(false);
    endTurn('dev', 'Done in Markdown.');
    await tick();
    expect(results()).toHaveLength(1);
  });

  it('a second answer to the same exchange is refused, and it answers nothing else on the handle', async () => {
    await team();
    const { card } = await delegated();
    const first = await asked(card, 'Which format?');
    endTurn('pm', 'Read it.');
    await tick();
    const second = await asked(card, 'Which title?');
    expect(second).not.toBe(first);
    expect(mgr.replyToTask('pm', 'handle-a', first, 'Markdown.').status).toBe('queued');
    const again = mgr.replyToTask('pm', 'handle-a', first, 'HTML.');
    expect(again).toEqual({ status: 'refused', text: `Error: exchange ${first} was already answered. A second answer is refused, and it answers nothing else on handle handle-a. Nothing was sent.` });
    expect(records('answer-queued')).toHaveLength(1);
    expect(mgr.taskExchangeFacts('handle-a')!.owed).toEqual([
      { exchangeId: first, kind: 'question', state: 'answer-queued' },
      { exchangeId: second, kind: 'question', state: 'question-open' },
    ]);
    expect(mgr.taskExchangeFacts('handle-a')!.exchangeCount).toBe(2);
  });

  it('refuses, with the reason and changing nothing: missing arguments, an unknown or foreign exchange, another handle', async () => {
    await team();
    const { card } = await delegated();
    const id = await asked(card);
    expect(mgr.replyToTask('pm', '', id, 'x').text).toMatch(/^Error: reply_to_task needs both handle and exchange_id/);
    expect(mgr.replyToTask('pm', 'handle-a', '', 'x').text).toMatch(/^Error: reply_to_task needs both handle and exchange_id/);
    expect(mgr.replyToTask('pm', 'handle-a', id, '  ').text).toBe('Error: the answer is empty. Nothing was sent.');
    expect(mgr.replyToTask('pm', 'handle-a', 'exchange-00000000', 'x').text).toMatch(/^Error: no question with exchange_id "exchange-00000000" was asked of you/);
    expect(mgr.replyToTask('dev', 'handle-a', id, 'x').text).toMatch(/^Error: no question with exchange_id/);
    expect(mgr.replyToTask('pm', 'handle-b', id, 'x').text).toBe(`Error: exchange ${id} is not on handle handle-b: it belongs to task handle-a. An answer answers only its own question. Nothing was sent.`);
    expect(records('answer-queued')).toEqual([]);
    expect(mgr.taskExchangeFacts('handle-a')!.owed).toEqual([{ exchangeId: id, kind: 'question', state: 'question-open' }]);
  });

  it('an error at the turn end takes precedence over waiting: terminal as today, the exchange closes undelivered and the result names it', async () => {
    await team();
    const { card } = await delegated();
    const id = await asked(card);
    mgr.replyToTask('pm', 'handle-a', id, 'Use Markdown.');
    endTurn('pm', 'Answered.');
    endTurn('dev', 'The provider failed.', { isError: true });
    await tick();
    expect(results()).toHaveLength(1);
    expect(results()[0].type).toBe('system.error');
    expect(results()[0].payload.metadata).toMatchObject({ taskExchanges: { undelivered: [{ exchangeId: id, kind: 'question' }] } });
    expect(terminal).toEqual([card.attemptId]);
    expect(records('closed')[0].payload.metadata.taskExchange).toMatchObject({ exchangeId: id, delivered: false });
    expect(backends.get('dev')!.turns).toHaveLength(1);
    // An answer to a task that already ended is refused: changing finished work is a rework.
    const late = await (async () => { await tick(); return mgr.replyToTask('pm', 'handle-a', id, 'Again.'); })();
    expect(late.status).toBe('refused');
    expect(late.text).toMatch(/^Error: task handle-a already ended \(the task ended in an error before the answer reached it\), so exchange .* cannot be answered\. A change to finished work is a rework, not an answer: record needs-rework/);
  });

  it('a budget stop while an answer is queued is terminal as today: a partial result naming the undelivered exchange, nothing restarts', async () => {
    await team();
    const { card } = await delegated();
    const id = await asked(card);
    mgr.replyToTask('pm', 'handle-a', id, 'Use Markdown.');
    endTurn('pm', 'Answered.');
    endTurn('dev', 'Stopped at the budget.', { stop: { state: 'stopped', reason: 'budget' } as TurnResult['stop'] });
    await tick();
    expect(results()).toHaveLength(1);
    expect(results()[0].type).toBe('task.partial');
    expect(results()[0].payload.metadata).toMatchObject({ stopped: true, taskExchanges: { undelivered: [{ exchangeId: id }] } });
    expect(backends.get('dev')!.turns).toHaveLength(1);
    expect(mgr.awaitsExchange('handle-a')).toBe(false);
  });

  it('Stop of the teammate while an answer is queued at its checkpoint: cancelled as a stopped turn, the exchange closes undelivered, nothing restarts', async () => {
    await team();
    const { card } = await delegated();
    const id = await asked(card);
    endTurn('pm', 'Asked the person.');
    endTurn('dev', 'Waiting for the format.');
    await tick();
    mgr.interrupt('dev');
    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({ type: 'system.error', to: 'pm', payload: { metadata: { cancelled: true } } });
    expect(ended).toEqual([card.attemptId]);
    expect(mgr.delegationExecution('dev', 'handle-a')).toEqual({ state: 'stopped' });
    expect(records('closed')[0].payload.metadata.taskExchange).toMatchObject({ exchangeId: id, delivered: false });
    const answer = mgr.replyToTask('pm', 'handle-a', id, 'Use Markdown.');
    expect(answer.text).toMatch(/^Error: exchange .* is closed: /);
    await tick();
    expect(backends.get('dev')!.turns).toHaveLength(1);
    expect(mgr.awaitsExchange('handle-a')).toBe(false);
  });

  it('Stop of the teammate during an open question in its running turn: the question is never answered later', async () => {
    await team();
    const { card } = await delegated();
    const id = await asked(card);
    mgr.interrupt('dev');
    expect(mgr.replyToTask('pm', 'handle-a', id, 'Markdown.').status).toBe('refused');
    expect(records('answer-queued')).toEqual([]);
  });

  // Audit I2: a progress note never becomes the task's result. Without a coordinator abort that cancels it (no TeamTools
  // here), an attempt left waiting for nothing is cancelled with the PM's Stop.
  it('the person\'s Stop of the PM ends the exchanges it was asked; an attempt left waiting for nothing is cancelled, its note not made a result', async () => {
    await team();
    const { card } = await delegated();
    const id = await asked(card);
    endTurn('pm', 'I will think.');
    endTurn('dev', 'Waiting for the format.');
    await tick();
    mgr.interrupt('pm');
    expect(mgr.replyToTask('pm', 'handle-a', id, 'Markdown.').text).toMatch(/is closed: the PM was stopped/);
    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({ type: 'system.error', payload: { instruction: 'the PM was stopped',
      metadata: { cancelled: true, taskExchanges: { undelivered: [{ exchangeId: id, reason: 'the PM was stopped' }] } } } });
    expect(ended).toEqual([card.attemptId]);
    expect(terminal).toEqual([]);
    await tick();
    expect(backends.get('dev')!.turns).toHaveLength(1);
  });

  it('cancel_task on a waiting attempt cancels it (cancelDelegation)', async () => {
    await team();
    const { card } = await delegated();
    await asked(card);
    endTurn('pm', 'Asked.');
    endTurn('dev', 'Waiting.');
    await tick();
    expect(mgr.cancelDelegation('dev', 'handle-a', 'Not needed any more.')).toBe(true);
    expect(results()[0]).toMatchObject({ type: 'system.error', payload: { instruction: 'Not needed any more.', metadata: { cancelled: true } } });
    expect(ended).toEqual([card.attemptId]);
  });

  it('receipts and duplicates start no turn: the answer, its receipts and a re-delivered answer are non-actionable', async () => {
    await team();
    const { card } = await delegated();
    const id = await asked(card);
    endTurn('pm', 'Asked.');
    endTurn('dev', 'Waiting.');
    await tick();
    mgr.replyToTask('pm', 'handle-a', id, 'Use Markdown.');
    await tick();
    endTurn('dev', 'Done.');
    await tick();
    const turns = { pm: backends.get('pm')!.turns.length, dev: backends.get('dev')!.turns.length };
    const answers = records();
    expect(answers.map((message) => message.payload.metadata.taskExchange.fact)).toEqual(['message-delivered', 'answer-queued', 'answer-delivered']);
    // Each delivered again, as it was, and once more under a new bus id.
    for (const message of answers) {
      (bus as unknown as { matchSubscribers(message: Message): void }).matchSubscribers(message);
      bus.send(message.from, message.to, 'ask.answer', { ...message.payload }, 'normal', message.correlationId);
    }
    await tick();
    expect({ pm: backends.get('pm')!.turns.length, dev: backends.get('dev')!.turns.length }).toEqual(turns);
    expect(mgr.get('pm')!.status).toBe('idle');
    expect(mgr.get('dev')!.status).toBe('idle');
  });

  it('a note opens no exchange, and nothing waits on it', async () => {
    await team();
    const { card } = await delegated();
    await ask(card, 'Half done.', 'note');
    await tick();
    expect(mgr.taskExchangeFacts('handle-a')).toEqual({ attemptId: card.attemptId, owed: [], waiting: false, exchangeCount: 0 });
    endTurn('pm', 'Noted.');
    endTurn('dev', 'Done.');
    await tick();
    expect(results()).toHaveLength(1);
    expect(mgr.taskExchangeFacts('handle-a')).toBeUndefined();
  });

  it('a question to a held (stopped) PM opens no exchange: nothing waits for an answer that cannot come', async () => {
    await team();
    const { card } = await delegated();
    held = true;
    await ask(card);
    await tick();
    endTurn('dev', 'Assumed Markdown.');
    await tick();
    expect(results()).toHaveLength(1);
  });

  // Audit I2: the loss of a waiting process ends the task as a lost worker's does, interrupted; the note stays progress.
  it('a teammate process that ends while waiting ends the task interrupted, through the lost-worker path; its note stays progress, its exchange closes undelivered', async () => {
    await team();
    const { card, requestId } = await delegated();
    const id = await asked(card);
    endTurn('pm', 'Asked.');
    endTurn('dev', 'Waiting for the process note.', { usage: { inputTokens: 10, outputTokens: 5 } as TurnResult['usage'] });
    await tick();
    expect(mgr.getRecentTaskTokens(50)).toEqual([]);
    backends.get('dev')!.emit({ kind: 'exit', code: 1 });
    expect(results()).toHaveLength(1);
    expect(results()[0].type).toBe('system.error');
    expect(results()[0].payload.metadata).toMatchObject({ isError: true, interrupted: true, interruptionReason: 'worker-lost',
      taskExchanges: { undelivered: [{ exchangeId: id, reason: 'the teammate\'s process ended before the answer reached it' }] } });
    expect(results()[0].payload.instruction).toBe('Dev\'s process ended while its task waited for the coordinator\'s answer: the task '
      + 'did not finish. Its last progress note stays on the task; it is not a result.');
    expect(bus.query({ type: 'task.complete' }).filter((message) => message.from === 'dev')).toEqual([]);
    // The note was published once, as progress, and is still only that.
    expect(bus.query({ type: 'task.status' }).filter((message) => message.payload.instruction === 'Waiting for the process note.')).toHaveLength(1);
    // The attempt's terminal callback and its task slot, each once; nothing starts.
    expect(terminal).toEqual([card.attemptId]);
    expect(mgr.getRecentTaskTokens(50)).toEqual([expect.objectContaining({ id: requestId })]);
    expect(mgr.replyToTask('pm', 'handle-a', id, 'x').text).toMatch(/already ended/);
    await tick();
    expect(results()).toHaveLength(1);
    expect(backends.get('dev')!.turns).toHaveLength(1);
  });

  // Audit I3: no answer-length refusal. A long answer is accepted and reaches the teammate whole, in-turn or continued.
  it('a long answer is accepted and delivered whole, into the running turn and as a continuation', async () => {
    await team({ steer: true });
    const { card } = await delegated();
    const long = `${'All the figures, in full. '.repeat(1_000)}End.`;
    expect(long.length).toBeGreaterThan(20_000);
    const first = await asked(card, 'Which figures?');
    expect(mgr.replyToTask('pm', 'handle-a', first, long).status).toBe('queued');
    await tick();
    const dev = backends.get('dev') as SteerableBackend;
    expect(dev.notices).toEqual([`Your coordinator answered your question on this task (${first}): ${long}`]);
    endTurn('pm', 'Answered.');
    await tick();
    const second = await asked(card, 'And the notes?');
    dev.accept = false;
    expect(mgr.replyToTask('pm', 'handle-a', second, long).status).toBe('queued');
    endTurn('pm', 'Answered again.');
    endTurn('dev', 'Waiting for the notes.');
    await tick();
    expect(dev.turns).toHaveLength(2);
    expect(dev.turns[1]).toContain(`  Answer: ${long}\n`);
  });
});

describe('v0.9.103 slice 2: the exchange facts', () => {
  const input = { coordinatorId: 'pm', teammateId: 'dev', handle: 'h', attemptId: 'a', kind: 'question' as const, question: 'Q?', questionEventId: 'e' };

  it('records question-open, answer-queued, answer-delivered and closed separately and in order, each once', () => {
    const exchanges = new TaskExchanges();
    const exchange = exchanges.open(input);
    expect(exchange.exchangeId).toMatch(/^exchange-[0-9a-f]{8}$/);
    expect(exchangeState(exchange)).toBe('question-open');
    expect(exchanges.delivered(exchange, 'in-turn')).toBe(false);
    expect(exchanges.answer(exchange, 'A.', 'ev')).toBe(true);
    expect(exchanges.answer(exchange, 'B.', 'ev2')).toBe(false);
    expect(exchange.answer).toEqual({ text: 'A.', eventId: 'ev' });
    expect(exchanges.delivered(exchange, 'continuation')).toBe(true);
    expect(exchanges.closeUndelivered(exchange, 'task-ended', 'late')).toBe(false);
    expect(exchange.facts.map((fact) => fact.fact)).toEqual(['question-open', 'answer-queued', 'answer-delivered', 'closed']);
    expect(exchange.closed).toEqual({ delivered: true });
    expect(exchanges.owedOf('a')).toEqual([]);
  });

  it('closes an owed exchange as undelivered with its cause, and counts every exchange of an attempt (no cap)', () => {
    const exchanges = new TaskExchanges();
    const one = exchanges.open(input);
    for (let i = 0; i < 5; i++) exchanges.open(input);
    expect(exchanges.countOf('a')).toBe(6);
    expect(exchanges.closeUndelivered(one, 'coordinator-stopped', 'the PM was stopped')).toBe(true);
    expect(one.closed).toEqual({ delivered: false, cause: 'coordinator-stopped', reason: 'the PM was stopped' });
    expect(one.facts.map((fact) => fact.fact)).toEqual(['question-open', 'closed']);
    expect(exchanges.owedOf('a')).toHaveLength(5);
    expect(exchanges.countOf('a')).toBe(6);
  });
});

describe('v0.9.103 slice 2: reply_to_task on the coordinator\'s tool surface', () => {
  const view = { list: () => [], resolve: () => undefined };

  it('is offered to the coordinator only, requires handle, exchange_id and text, and relays the host\'s answer', async () => {
    const replyToTask = vi.fn((handle: string, exchangeId: string, text: string) => (exchangeId === 'exchange-1'
      ? { status: 'queued' as const, text: `queued ${handle} ${text}` } : { status: 'refused' as const, text: 'Error: no. Nothing was sent.' }));
    const pm = new TeamTools('pm', view, new MessageBus(), { replyToTask });
    const spec = pm.specs().find((entry) => entry.function.name === 'reply_to_task')!.function;
    expect((spec.parameters as { required: string[] }).required).toEqual(['handle', 'exchange_id', 'text']);
    expect(spec.description).toContain('Your ordinary reply goes to the person, not to the teammate.');
    expect(spec.description).toContain('changing finished work is a rework');
    expect(await pm.run('reply_to_task', { handle: 'h', exchange_id: 'exchange-1', text: 'Markdown.' })).toBe('queued h Markdown.');
    expect(replyToTask).toHaveBeenCalledWith('h', 'exchange-1', 'Markdown.');
    await expect(pm.runOutcome('reply_to_task', { handle: 'h', exchange_id: 'exchange-2', text: 'x' }))
      .resolves.toMatchObject({ status: 'failed' });

    const worker = new TeamTools('dev', view, new MessageBus(), { coordinatorId: 'pm', replyToTask });
    expect(worker.specs().map((entry) => entry.function.name)).not.toContain('reply_to_task');
    expect(await worker.run('reply_to_task', { handle: 'h', exchange_id: 'exchange-1', text: 'x' })).toMatch(/^Error: /);
    expect(replyToTask).toHaveBeenCalledTimes(2);
  });

  it('without the host\'s answer path, the tool says it is not available and sends nothing', async () => {
    const tools = new TeamTools('pm', view, new MessageBus(), {});
    expect(tools.specs().some((entry) => entry.function.name === 'reply_to_task')).toBe(true);
    expect(await tools.run('reply_to_task', { handle: 'h', exchange_id: 'e', text: 'x' })).toMatch(/not available in this host/);
  });
});
