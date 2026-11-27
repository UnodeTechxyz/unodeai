import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../SessionManager';
import { reviseForClosedRun } from '../RequestCloseoutAccumulator';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler } from '../../backend/AgentBackend';
import { arbitrateAccountabilityAnchors, jobOutcomeAccountabilityAnchor, requestSummaryAnchor } from '../../observability/AccountabilityAnchor';
import { jobOutcomeAnchor } from '../../observability/JobOutcomeAnchor';
import { requestSummaryState, type RequestCloseoutRecordV1 } from '../../observability/RequestCloseout';
import { RunLedger } from '../../observability/RunLedger';
import type { AgentConfig, Message } from '../../types';

/*
 * v0.9.94: the session manager and the run ledger wired as the extension wires them. A coordinator the person
 * stops before it has replied in a job ends that job at the stop, and the job's card stands at the stopped turn.
 */

class FakeBackend implements AgentBackend {
  readonly agentId: string;
  pid = 1234;
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void {
    this.handler = h;
    return () => (this.handler = undefined);
  }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(): void { /* the test drives the events */ }
  async stop(): Promise<void> {
    this.alive = false;
    this.emit({ kind: 'exit', code: 0 });
  }
  abort(): void { /* the session ends the turn */ }
  isAlive(): boolean { return this.alive; }
  emit(e: BackendEvent): void { this.handler?.(e); }
}

function makeConfig(id: string, role: AgentConfig['role']): AgentConfig {
  return {
    id, name: id, role, skill: '',
    provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' },
    model: 'deepseek-v4.1-flash', systemPrompt: '', autoApprove: true, allowedTools: [],
  };
}

describe('a coordinator stopped before its first reply, session and ledger together', () => {
  let bus: MessageBus;
  let manager: SessionManager;
  let ledger: RunLedger;
  let backends: Map<string, FakeBackend>;
  let records: RequestCloseoutRecordV1[];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T02:00:00.000Z'));
    bus = new MessageBus();
    backends = new Map();
    records = [];
    manager = new SessionManager(5, bus, {
      createBackend: (config) => {
        const created = new FakeBackend(config);
        backends.set(config.id, created);
        return created;
      },
      resolveEnv: async () => ({}),
      resolveTurnRunId: (sessionId, correlationId) => ledger.turnRunId(sessionId, correlationId),
      requestRunFacts: (sessionId, correlationId) => ledger.requestRunFacts(sessionId, { correlationId }),
    });
    // The ledger is told who is in a turn by the session manager itself, as in the extension.
    ledger = new RunLedger([], {
      host: { hostInstanceId: 'window-1', epoch: 'activation-1' },
      activeTurnId: (agentId) => manager.currentTurnId(agentId),
    });
    bus.on('message.sent', (message) => ledger.observeMessage(message as Message));
    manager.on('session.turnEnded', (event) => { ledger.recordTurn(event.sessionId!, event.data); });
    manager.on('session.requestCloseout', (event) => records.push(event.data.record));
    for (const [id, role] of [['pm', 'pm'], ['dev', 'senior-dev']] as Array<[string, AgentConfig['role']]>) {
      manager.create(makeConfig(id, role));
      await manager.start(id, { pin: 'take' });
      backends.get(id)!.emit({ kind: 'ready' });
    }
  });
  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  function dispatch(request: Message, handle: string): string {
    return ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle, requestedAgent: 'dev', agentId: 'dev', instruction: 'Review the diff.',
      originCorrelationId: request.id, originTurnId: request.id, dispatchedAt: new Date().toISOString(),
    })!;
  }

  it('ends the job at the stop and places its card at the stopped turn, with no later message', () => {
    const request = bus.send('user', 'pm', 'ask.question', { instruction: 'review this', mode: 'act' });
    backends.get('pm')!.emit({ kind: 'model_request' });
    const runId = dispatch(request, 'h-1');
    vi.advanceTimersByTime(3_000);
    // The stop takes the coordinator's task with it, then ends the coordinator's own turn.
    ledger.recordDelegationCancelled({ coordinatorId: 'pm', handle: 'h-1', agentId: 'dev', reason: 'delegation cancelled by user', cancelledAt: new Date().toISOString() });
    expect(ledger.get(runId)?.status).toBe('open');
    manager.interrupt('pm');

    expect(ledger.get(runId)).toMatchObject({
      status: 'closed', closeoutCompletionState: 'partial', closeoutBasis: 'stopped-work-resolved', closingTurnId: request.id,
    });
    expect(ledger.closedRunAnchorFacts()).toEqual([
      expect.objectContaining({ runId, coordinatorId: 'pm', closingTurnId: request.id }),
    ]);
    // The stopped turn has its own record. It was frozen while the run was still open.
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ terminalTurnId: request.id, terminal: { kind: 'stopped' } });
    expect(records[0].observations.run).toMatchObject({ runId, state: 'open', tasks: { active: 0, cancelled: 1 } });

    // One card stands at that turn: the job's, not the turn's.
    const anchor = jobOutcomeAnchor(ledger.closedRunAnchorFacts()[0])!;
    const shown = arbitrateAccountabilityAnchors([
      requestSummaryAnchor(records[0]),
      jobOutcomeAccountabilityAnchor({ state: 'anchored', anchor }, true)!,
    ]);
    expect(shown).toEqual([expect.objectContaining({ kind: 'job-outcome', target: { kind: 'user-turn', turnId: request.id } })]);
    // And the turn's record, revised for the closed run, no longer says that the job is open.
    const revised = reviseForClosedRun(records[0], ledger.requestRunFacts('pm', { runId })!)!;
    expect(requestSummaryState(revised)).toBe('job-closed');
  });

  it('keeps the job open while a task of it is still running, and says so on the stopped turn', () => {
    const request = bus.send('user', 'pm', 'ask.question', { instruction: 'review this', mode: 'act' });
    const runId = dispatch(request, 'h-1');
    manager.interrupt('pm');
    expect(ledger.get(runId)?.status).toBe('open');
    expect(ledger.closedRunAnchorFacts()).toEqual([]);
    expect(records[0].observations.run).toMatchObject({ state: 'open', tasks: { active: 1 }, handles: ['h-1'] });
    // When that task is stopped later, the job ends under the turn the person stopped.
    ledger.recordDelegationCancelled({ coordinatorId: 'pm', handle: 'h-1', agentId: 'dev', reason: 'Stopped by user.', cancelledAt: new Date().toISOString() });
    expect(ledger.get(runId)).toMatchObject({ status: 'closed', closingTurnId: request.id });
  });

  it('leaves a stop without a job as a stopped turn: no run is made up for it', () => {
    const request = bus.send('user', 'pm', 'ask.question', { instruction: 'think about it', mode: 'act' });
    manager.interrupt('pm');
    expect(ledger.snapshot()).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ terminalTurnId: request.id, terminal: { kind: 'stopped' } });
    expect(records[0].observations.run).toBeUndefined();
  });

  /*
   * A dispatch tool returns before its task is admitted, and the ledger is told of the dispatch at admission. A
   * stop in between comes before the job exists. The stop's own clean-up then cancels the task. Found in the field
   * on 2026-10-09 with a coordinator stopped right after its dispatch call returned.
   */
  function cancelled(handle: string): void {
    ledger.recordDelegationCancelled({
      coordinatorId: 'pm', handle, agentId: 'dev', reason: 'delegation cancelled by team bridge shutdown', cancelledAt: new Date().toISOString(),
    });
  }

  it('ends a job that was recorded only after the stop under the stopped turn', () => {
    const request = bus.send('user', 'pm', 'ask.question', { instruction: 'review this', mode: 'act' });
    backends.get('pm')!.emit({ kind: 'model_request' });
    vi.advanceTimersByTime(3_000);
    manager.interrupt('pm');
    // The stopped turn was frozen with no job: none existed.
    expect(ledger.snapshot()).toEqual([]);
    expect(records[0].observations.run).toBeUndefined();

    const runId = dispatch(request, 'h-1');
    expect(ledger.get(runId)?.status).toBe('open');
    cancelled('h-1');

    expect(ledger.get(runId)).toMatchObject({
      status: 'closed', closeoutCompletionState: 'partial', closeoutBasis: 'stopped-work-resolved', closingTurnId: request.id,
    });
    // One card stands at the stopped turn, and it is the job's.
    const anchor = jobOutcomeAnchor(ledger.closedRunAnchorFacts()[0])!;
    const shown = arbitrateAccountabilityAnchors([
      requestSummaryAnchor(records[0]),
      jobOutcomeAccountabilityAnchor({ state: 'anchored', anchor }, true)!,
    ]);
    expect(shown).toEqual([expect.objectContaining({ kind: 'job-outcome', target: { kind: 'user-turn', turnId: request.id } })]);
  });

  it('ends every job of the stopped turn there, also one recorded after an earlier one had closed', () => {
    const request = bus.send('user', 'pm', 'ask.question', { instruction: 'review this', mode: 'act' });
    const first = dispatch(request, 'h-1');
    cancelled('h-1');
    manager.interrupt('pm');
    expect(ledger.get(first)).toMatchObject({ status: 'closed', closingTurnId: request.id });

    const second = dispatch(request, 'h-2');
    expect(second).not.toBe(first);
    cancelled('h-2');
    expect(ledger.get(second)).toMatchObject({ status: 'closed', closingTurnId: request.id });
  });

  it('keeps the stopped turn for the thread: a second job recorded after the first had closed ends there too', () => {
    const request = bus.send('user', 'pm', 'ask.question', { instruction: 'review this', mode: 'act' });
    manager.interrupt('pm');
    const first = dispatch(request, 'h-1');
    cancelled('h-1');
    expect(ledger.get(first)).toMatchObject({ status: 'closed', closingTurnId: request.id });

    const second = dispatch(request, 'h-2');
    expect(second).not.toBe(first);
    cancelled('h-2');
    expect(ledger.get(second)).toMatchObject({ status: 'closed', closingTurnId: request.id });
  });

  it('gives a stopped turn only to a job of the same thread', () => {
    bus.send('user', 'pm', 'ask.question', { instruction: 'review this', mode: 'act' });
    manager.interrupt('pm');
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h-1', requestedAgent: 'dev', agentId: 'dev', instruction: 'Review the diff.',
      originCorrelationId: 'another-thread', originTurnId: 'another-turn', dispatchedAt: new Date().toISOString(),
    })!;
    cancelled('h-1');
    // No turn of that thread was stopped, and the coordinator never replied there: no closing turn is guessed.
    expect(ledger.get(runId)?.status).toBe('open');
    expect(ledger.get(runId)?.closingTurnId).toBeUndefined();
  });

  it('gives a stopped turn only to a job of the agent that was stopped', () => {
    const request = bus.send('user', 'dev', 'ask.question', { instruction: 'look at this', mode: 'act' });
    manager.interrupt('dev');
    expect(records[0]).toMatchObject({ terminalTurnId: request.id, terminal: { kind: 'stopped' } });
    const runId = dispatch(request, 'h-1');
    cancelled('h-1');
    expect(ledger.get(runId)?.status).toBe('open');
    expect(ledger.get(runId)?.closingTurnId).toBeUndefined();
  });

  it('does not take a turn that failed for one the person stopped', () => {
    // A terminal error of the coordinator on a thread, with its turn id, that is not a stop.
    bus.send('pm', 'user', 'system.error', { instruction: 'The provider returned an error.', metadata: { isError: true, turnId: 'turn-x' } }, 'normal', 'thread-x');
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h-1', requestedAgent: 'dev', agentId: 'dev', instruction: 'Review the diff.',
      originCorrelationId: 'thread-x', originTurnId: 'turn-x', dispatchedAt: new Date().toISOString(),
    })!;
    cancelled('h-1');
    expect(ledger.get(runId)?.status).toBe('open');
    expect(ledger.get(runId)?.closingTurnId).toBeUndefined();

    // The same with the typed stop: the job ends under that turn.
    bus.send('pm', 'user', 'system.error', { instruction: 'Stopped by user.', metadata: { isError: true, cancelled: true, turnId: 'turn-y' } }, 'normal', 'thread-y');
    const stopped = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h-2', requestedAgent: 'dev', agentId: 'dev', instruction: 'Review the diff.',
      originCorrelationId: 'thread-y', originTurnId: 'turn-y', dispatchedAt: new Date().toISOString(),
    })!;
    cancelled('h-2');
    expect(ledger.get(stopped)).toMatchObject({ status: 'closed', closingTurnId: 'turn-y' });
  });
});
