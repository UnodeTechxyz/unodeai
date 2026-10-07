import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, turnEndingOf, type TurnEndedEvent } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler } from '../../backend/AgentBackend';
import type { AgentConfig } from '../../types';
import type { TurnPhaseSnapshot } from '../TurnTiming';
import { blockingPrompt, type PromptWait } from '../../views/attentionSignal';

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
  abort(): void { /* nothing to abort */ }
  isAlive(): boolean { return this.alive; }
  emit(e: BackendEvent): void { this.handler?.(e); }
  /** The process dies without the host having asked it to. */
  die(): void {
    this.alive = false;
    this.emit({ kind: 'exit', code: 1 });
  }
}

function makeConfig(id: string): AgentConfig {
  return {
    id, name: id, role: 'senior-dev' as AgentConfig['role'], skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-sonnet-4-20250514', systemPrompt: '', autoApprove: true, allowedTools: [],
  };
}

const toolResult = (callId: string): BackendEvent => ({
  kind: 'tool_result', callId, name: 'read_file', outcome: { status: 'success', observedBy: 'provider-protocol' }, summary: 'ok',
});

describe('host-observed turn phases', () => {
  const START = Date.parse('2026-10-02T00:00:00.000Z');
  let bus: MessageBus;
  let manager: SessionManager;
  let backend: FakeBackend;
  let phases: Array<TurnPhaseSnapshot | undefined>;
  let ended: TurnEndedEvent[];
  let runOfTurn: string | undefined;
  let units: string[];

  async function startAgent(): Promise<void> {
    bus = new MessageBus();
    units = [];
    manager = new SessionManager(5, bus, {
      createBackend: (config) => (backend = new FakeBackend(config)),
      resolveEnv: async () => ({}),
      resolveTurnRunId: () => runOfTurn,
      spend: {
        beginRequest() {}, beginUsageUnit: (unit: { usageUnitId: string }) => { units.push(unit.usageUnitId); },
        noteModelRequest() {}, noteUsageProgress() {}, settleUsageUnit: () => undefined, closeUsageUnit() {},
      },
    });
    phases = [];
    ended = [];
    manager.on('session.turnPhase', (event) => phases.push(event.data.phase));
    manager.on('session.turnEnded', (event) => ended.push(event.data));
    manager.create(makeConfig('dev'));
    await manager.start('dev');
    backend.emit({ kind: 'ready' });
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START));
    runOfTurn = undefined;
    await startAgent();
  });
  afterEach(() => vi.useRealTimers());

  it('publishes each phase once, from the host, and no phase after the turn ends', () => {
    bus.send('user', 'dev', 'task.assign', { instruction: 'inspect phases' });
    vi.advanceTimersByTime(1_000); backend.emit({ kind: 'model_request' });
    // Silence after the request is a wait for the provider. Nothing here calls it reasoning.
    vi.advanceTimersByTime(60_000);
    expect(manager.getTurnPhase('dev')).toMatchObject({ phase: 'provider-wait' });
    backend.emit({ kind: 'reasoning_delta', delta: 'a' });
    vi.advanceTimersByTime(500); backend.emit({ kind: 'reasoning_delta', delta: 'b' });
    vi.advanceTimersByTime(500); backend.emit({ kind: 'tool_use', callId: 'c1', name: 'read_file', input: {} });
    vi.advanceTimersByTime(250); backend.emit({ kind: 'tool_use', callId: 'c2', name: 'read_file', input: {} });
    // Content that arrives while a call is open does not end the tool phase.
    vi.advanceTimersByTime(250); backend.emit({ kind: 'assistant_delta', delta: 'x' });
    vi.advanceTimersByTime(500); backend.emit(toolResult('c1'));
    vi.advanceTimersByTime(500); backend.emit(toolResult('c2'));
    vi.advanceTimersByTime(2_000); backend.emit({ kind: 'assistant_delta', delta: 'done' });
    vi.advanceTimersByTime(1_000); backend.emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });

    expect(phases.map((phase) => phase && [phase.phase, phase.openTools])).toEqual([
      ['host', 0], ['provider-wait', 0], ['reasoning', 0], ['tool', 1], ['tool', 2], ['tool', 1], ['provider-wait', 0],
      ['responding', 0], undefined,
    ]);
    expect(manager.getTurnPhase('dev')).toBeUndefined();
    const timing = bus.query({ type: 'task.complete' }).at(-1)?.payload.metadata?.turnTiming;
    expect(timing).toMatchObject({
      durationMs: 66_500,
      approvalWaitMs: 0,
      phases: {
        queuedMs: 0, hostMs: 1_000, providerWaitMs: 62_000, reasoningMs: 1_000, respondingMs: 1_000, toolMs: 1_500,
        providerWaitCount: 2, longestProviderWaitMs: 60_000,
      },
    });
  });

  it('pauses the turn clock for a human approval and shows it ahead of the tool', () => {
    bus.send('user', 'dev', 'task.assign', { instruction: 'write a file' });
    backend.emit({ kind: 'model_request' });
    vi.advanceTimersByTime(1_000); backend.emit({ kind: 'tool_use', callId: 'c1', name: 'write_file', input: {} });
    vi.advanceTimersByTime(500); manager.approvalStarted('dev', 'approval-1');
    expect(manager.getTurnPhase('dev')).toMatchObject({ phase: 'tool', approvalPending: true });
    vi.advanceTimersByTime(90_000); manager.approvalFinished('dev', 'approval-1');
    expect(manager.getTurnPhase('dev')).toMatchObject({ phase: 'tool', approvalPending: false });
    vi.advanceTimersByTime(500); backend.emit(toolResult('c1'));
    vi.advanceTimersByTime(1_000); backend.emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });

    const timing = bus.query({ type: 'task.complete' }).at(-1)?.payload.metadata?.turnTiming;
    expect(timing).toMatchObject({ durationMs: 3_000, approvalWaitMs: 90_000, phases: { toolMs: 1_000, providerWaitMs: 2_000 } });
    // An approval for a session with no running turn, or with no session, changes nothing.
    manager.approvalStarted('dev', 'late');
    manager.approvalStarted(undefined, 'nobody');
    expect(manager.getTurnPhase('dev')).toBeUndefined();
  });

  it('tells the result of a call how long a person took to decide while it was open', () => {
    const results: unknown[] = [];
    manager.on('session.tool', (event) => { if (event.data.phase === 'result') results.push(event.data); });
    bus.send('user', 'dev', 'task.assign', { instruction: 'list the folder' });
    backend.emit({ kind: 'model_request' });
    vi.advanceTimersByTime(1_000); backend.emit({ kind: 'tool_use', callId: 'c1', name: 'list_dir', input: {} });
    vi.advanceTimersByTime(200); manager.approvalStarted('dev', 'read-scope');
    vi.advanceTimersByTime(40_000); manager.approvalFinished('dev', 'read-scope');
    vi.advanceTimersByTime(300); backend.emit(toolResult('c1'));
    vi.advanceTimersByTime(100); backend.emit({ kind: 'tool_use', callId: 'c2', name: 'read_file', input: {} });
    vi.advanceTimersByTime(100); backend.emit(toolResult('c2'));

    expect(results).toEqual([
      expect.objectContaining({ callId: 'c1', humanWaitMs: 40_000 }),
      expect.not.objectContaining({ humanWaitMs: expect.anything() }),
    ]);
  });

  it('releases the turn clock when a prompt ends, also when it throws', async () => {
    bus.send('user', 'dev', 'task.assign', { instruction: 'two prompts' });
    backend.emit({ kind: 'model_request' });
    vi.advanceTimersByTime(1_000); backend.emit({ kind: 'tool_use', callId: 'c1', name: 'write_file', input: {} });

    const answered = manager.timeApproval('dev', async () => {
      expect(manager.getTurnPhase('dev')).toMatchObject({ approvalPending: true });
      vi.advanceTimersByTime(20_000);
      return 'allow';
    });
    await expect(answered).resolves.toEqual({ startedAtMs: START + 1_000, outcome: 'allow' });
    expect(manager.getTurnPhase('dev')).toMatchObject({ approvalPending: false });

    const broken = manager.timeApproval('dev', async () => {
      vi.advanceTimersByTime(30_000);
      throw new Error('the prompt could not be shown');
    });
    await expect(broken).rejects.toThrow('the prompt could not be shown');
    expect(manager.getTurnPhase('dev')).toMatchObject({ approvalPending: false });

    vi.advanceTimersByTime(1_000); backend.emit(toolResult('c1'));
    backend.emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
    const timing = bus.query({ type: 'task.complete' }).at(-1)?.payload.metadata?.turnTiming;
    expect(timing).toMatchObject({ durationMs: 2_000, approvalWaitMs: 50_000, phases: { toolMs: 1_000 } });
  });

  it('takes the wait for a prompt raised inside a dispatch_task call out of that call\'s tool time', async () => {
    // How the host passes an agent's turn clock to a blocking prompt it raises for that agent.
    const pausingTurnClock = (sessionId: string): PromptWait =>
      (wait) => manager.timeApproval(sessionId, async () => wait()).then(({ outcome }) => outcome);
    bus.send('user', 'dev', 'task.assign', { instruction: 'delegate to another provider' });
    backend.emit({ kind: 'model_request' });
    vi.advanceTimersByTime(2_000); backend.emit({ kind: 'tool_use', callId: 'd1', name: 'dispatch_task', input: {} });
    vi.advanceTimersByTime(500);

    // The coordinator-brief prompt opens inside the call and the person takes 45 s to answer it.
    const choice = await blockingPrompt('coordinator-brief:test', async () => {
      expect(manager.getTurnPhase('dev')).toMatchObject({ phase: 'tool', approvalPending: true, activeMs: 2_500 });
      vi.advanceTimersByTime(45_000);
      return 'Send brief';
    }, pausingTurnClock('dev'));
    expect(choice).toBe('Send brief');
    expect(manager.getTurnPhase('dev')).toMatchObject({ phase: 'tool', approvalPending: false, activeMs: 2_500 });

    vi.advanceTimersByTime(500); backend.emit(toolResult('d1'));
    vi.advanceTimersByTime(1_000); backend.emit({ kind: 'turn_complete', result: { text: 'dispatched', isError: false } });
    const timing = bus.query({ type: 'task.complete' }).at(-1)?.payload.metadata?.turnTiming;
    expect(timing).toMatchObject({
      durationMs: 4_000, approvalWaitMs: 45_000, phases: { providerWaitMs: 3_000, toolMs: 1_000 },
    });
  });

  it('keeps a wait that a queued request sat through out of that request\'s queue time', async () => {
    bus.send('user', 'dev', 'task.assign', { instruction: 'first' });
    backend.emit({ kind: 'model_request' });
    vi.advanceTimersByTime(1_000); backend.emit({ kind: 'tool_use', callId: 'c1', name: 'write_file', input: {} });
    const answered = manager.timeApproval('dev', async () => {
      // The second request arrives 10 s into a 30 s decision and queues behind the first turn.
      vi.advanceTimersByTime(10_000);
      bus.send('user', 'dev', 'task.assign', { instruction: 'second' });
      vi.advanceTimersByTime(20_000);
      return 'allow';
    });
    await answered;
    vi.advanceTimersByTime(1_000); backend.emit(toolResult('c1'));
    vi.advanceTimersByTime(3_000); backend.emit({ kind: 'turn_complete', result: { text: 'first done', isError: false } });

    backend.emit({ kind: 'model_request' });
    vi.advanceTimersByTime(2_000); backend.emit({ kind: 'turn_complete', result: { text: 'second done', isError: false } });
    const timings = bus.query({ type: 'task.complete' }).map((message) => message.payload.metadata?.turnTiming);
    expect(timings[0]).toMatchObject({ durationMs: 5_000, approvalWaitMs: 30_000 });
    // It queued for 24 s, 20 s of which a person was deciding.
    expect(timings[1]).toMatchObject({ durationMs: 6_000, approvalWaitMs: 20_000, phases: { queuedMs: 4_000, providerWaitMs: 2_000 } });
  });

  it('records a completed turn with the run resolved at its end and the spend unit it used', () => {
    bus.send('user', 'dev', 'task.assign', { instruction: 'coordinate' });
    backend.emit({ kind: 'model_request' });
    // The run is created during the turn: at its start there was none to name.
    runOfTurn = 'run-1';
    vi.advanceTimersByTime(2_000); backend.emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });

    const origin = bus.query({ type: 'task.assign' }).at(-1)!;
    expect(ended).toEqual([{
      turnId: origin.id, correlationId: origin.id, runId: 'run-1', usageUnitId: units[0], ended: 'completed',
      timing: expect.objectContaining({ durationMs: 2_000 }),
    }]);
    expect(units).toHaveLength(1);
  });

  it('records a failed turn as failed and a turn outside any run without a run id', () => {
    bus.send('user', 'dev', 'task.assign', { instruction: 'fail' });
    backend.emit({ kind: 'model_request' });
    vi.advanceTimersByTime(1_000); backend.emit({ kind: 'turn_complete', result: { text: 'provider error', isError: true } });

    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ ended: 'failed' });
    expect(ended[0]).not.toHaveProperty('runId');
  });

  it('records a stopped turn, which has no outcome receipt, with its timing and spend unit', () => {
    runOfTurn = 'run-2';
    bus.send('user', 'dev', 'task.assign', { instruction: 'long task' });
    backend.emit({ kind: 'model_request' });
    vi.advanceTimersByTime(5_000);
    manager.interrupt('dev');

    expect(ended).toEqual([expect.objectContaining({ runId: 'run-2', usageUnitId: units[0], ended: 'stopped' })]);
    expect(ended[0].timing.phases).toMatchObject({ providerWaitMs: 5_000 });
    expect(phases.at(-1)).toBeUndefined();
    expect(manager.getTurnPhase('dev')).toBeUndefined();
  });

  it('records a turn a host boundary stopped as stopped, never as completed', () => {
    runOfTurn = 'run-4';
    bus.send('user', 'dev', 'task.assign', { instruction: 'a long plan' });
    backend.emit({ kind: 'model_request' });
    vi.advanceTimersByTime(4_000);
    backend.emit({
      kind: 'turn_complete',
      result: {
        text: 'Stopped at the step limit.', isError: false,
        stop: { state: 'stopped', reason: 'step-safety-limit', steps: 40, lastActivity: 'read_file' },
      },
    });

    expect(ended).toEqual([expect.objectContaining({ runId: 'run-4', usageUnitId: units[0], ended: 'stopped' })]);
    // The reply says the same thing: the task is not complete.
    expect(bus.query({ type: 'task.partial' })).toHaveLength(1);

    const stop = { state: 'stopped' as const, reason: 'budget' as const, steps: 3, lastActivity: '' };
    expect(turnEndingOf({ isError: false })).toBe('completed');
    expect(turnEndingOf({ isError: true })).toBe('failed');
    expect(turnEndingOf({ isError: false, unresolvedReason: 'delegation-timeout' })).toBe('failed');
    // A stop comes first: a turn the host ended is not the agent's failure, whatever else its result says.
    expect(turnEndingOf({ isError: true, stop })).toBe('stopped');
  });

  it('records a turn whose process died as interrupted', () => {
    runOfTurn = 'run-3';
    bus.send('user', 'dev', 'task.assign', { instruction: 'doomed' });
    backend.emit({ kind: 'model_request' });
    vi.advanceTimersByTime(3_000);
    backend.die();

    expect(ended).toEqual([expect.objectContaining({ runId: 'run-3', usageUnitId: units[0], ended: 'interrupted' })]);
    expect(manager.getTurnPhase('dev')).toBeUndefined();
  });
});
