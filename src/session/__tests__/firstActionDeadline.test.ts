import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_ACTION_DEADLINE_NOTICE, SessionManager, type TurnEndedEvent } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler, TurnAttachments } from '../../backend/AgentBackend';
import type { FirstActionEvidence } from '../FirstActionGuard';
import { parseTurnOutcomeReceipt } from '../turnOutcomeReceipt';
import type { AgentConfig } from '../../types';

class FakeBackend implements AgentBackend {
  readonly agentId: string;
  pid = 1234;
  turns = 0;
  contexts: string[] = [];
  aborted = 0;
  stops = 0;
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void {
    this.handler = h;
    return () => (this.handler = undefined);
  }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(_instruction: string, attachments?: TurnAttachments): void {
    this.turns += 1;
    this.contexts.push(attachments?.projectContext ?? '');
  }
  async stop(): Promise<void> {
    this.stops += 1;
    this.alive = false;
    this.emit({ kind: 'exit', code: 0 });
  }
  abort(): void { this.aborted += 1; }
  isAlive(): boolean { return this.alive; }
  emit(e: BackendEvent): void { this.handler?.(e); }
}

function makeConfig(id: string, role: AgentConfig['role']): AgentConfig {
  return {
    id, name: id, role, skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-sonnet-4-20250514', systemPrompt: '', autoApprove: true, allowedTools: [],
  };
}

const REPLY = { text: 'done', isError: false, responseOutcome: { kind: 'reply' as const } };
const succeeded = { status: 'success' as const, observedBy: 'host' as const };
const refused = { status: 'refused' as const, reason: 'capability' as const, observedBy: 'host' as const };

describe('first-action deadline of a coordinator turn', () => {
  const START = Date.parse('2026-10-03T00:00:00.000Z');
  let bus: MessageBus;
  let manager: SessionManager;
  let backends: Map<string, FakeBackend[]>;
  let launches: Map<FakeBackend, string>;
  let ended: TurnEndedEvent[];
  let firstActions: Array<{ turnId: string; evidence: FirstActionEvidence; approvalWaitMs: number; phases?: Record<string, number> }>;
  let snapshots: number;
  let usages: Array<{ turnId: string; usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } }>;
  const pm = () => backends.get('pm')!.at(-1)!;
  /** The launch a backend was created for; a call names it, as the team tools built for that backend do. */
  const launchOf = (backend: FakeBackend) => launches.get(backend)!;
  const pmLaunch = () => launchOf(pm());
  const errors = () => bus.query({ type: 'system.error' }).filter((message) => message.from === 'pm');

  async function startTeam(members: Array<[string, AgentConfig['role']]> = [['pm', 'pm'], ['dev', 'senior-dev' as AgentConfig['role']]]): Promise<void> {
    bus = new MessageBus();
    backends = new Map();
    launches = new Map();
    manager = new SessionManager(5, bus, {
      createBackend: (config, launchId) => {
        const backend = new FakeBackend(config);
        backends.set(config.id, [...(backends.get(config.id) ?? []), backend]);
        launches.set(backend, launchId);
        return backend;
      },
      resolveEnv: async () => ({}),
      getProjectContext: () => 'Project notes.',
      candidateSnapshot: (config) => `[Team candidates for this request, supplied by UnodeAi]
- dev (built ${++snapshots} for ${config.id})`,
    });
    ended = [];
    snapshots = 0;
    firstActions = [];
    manager.on('session.turnEnded', (event) => ended.push(event.data));
    manager.on('session.firstAction', (event) => firstActions.push(event.data));
    usages = [];
    manager.on('session.firstActionTurnUsage', (event) => usages.push(event.data));
    for (const [id, role] of members) {
      manager.create(makeConfig(id, role));
      await manager.start(id);
      backends.get(id)!.at(-1)!.emit({ kind: 'ready' });
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START));
  });
  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  it('ends an attempt after 60 seconds of provider silence with one typed terminal message and no retry', async () => {
    await startTeam();
    const request = bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    vi.advanceTimersByTime(2_000); pm().emit({ kind: 'model_request' });
    vi.advanceTimersByTime(59_000);
    expect(manager.get('pm')?.status).toBe('running');
    expect(errors()).toHaveLength(0);

    vi.advanceTimersByTime(1_000);
    const backend = pm();
    expect(manager.get('pm')?.status).toBe('stopped');
    expect(backend.aborted).toBe(1);
    expect(backend.stops).toBe(1);

    // Exactly one terminal message, host-owned and typed. It is neither a cancellation nor a reply.
    const terminal = errors();
    expect(terminal).toHaveLength(1);
    expect(terminal[0].payload.instruction).toBe(FIRST_ACTION_DEADLINE_NOTICE);
    expect(terminal[0].to).toBe('user');
    expect(terminal[0].correlationId ?? terminal[0].id).toBeTruthy();
    const metadata = terminal[0].payload.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      isError: true,
      hostDeadline: 'first-action',
      responseOutcome: { kind: 'host-deadline', deadline: 'first-action' },
      turnId: request.id,
    });
    expect(metadata.cancelled).toBeUndefined();
    // The receipt survives the same parser a restored transcript uses, with the delivery it was written with.
    expect(parseTurnOutcomeReceipt(metadata.turnOutcome)).toMatchObject({
      turnId: request.id, delivery: { kind: 'host-deadline', deadline: 'first-action' }, tools: { coverage: 'partial' },
    });
    expect(bus.query({ type: 'task.complete' })).toHaveLength(0);

    // The turn has an entry, ended by a host boundary, and belongs to no run.
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ turnId: request.id, ended: 'stopped' });
    expect(ended[0].runId).toBeUndefined();
    // The trial's record says where its 62 seconds went: two in the host, then one provider wait of 60.
    expect(firstActions).toEqual([{
      turnId: request.id, evidence: { source: 'host-deadline', kind: 'needs-you', latencyMs: 62_000 }, approvalWaitMs: 0,
      phases: {
        queuedMs: 0, hostMs: 2_000, providerWaitMs: 60_000, reasoningMs: 0, respondingMs: 0, toolMs: 0,
        providerWaitCount: 1, longestProviderWaitMs: 60_000,
      },
    }]);

    // Nothing is retried or switched on its own: no second turn, no new backend, however long nobody acts.
    vi.advanceTimersByTime(600_000);
    expect(backend.turns).toBe(1);
    expect(backends.get('pm')).toHaveLength(1);
    expect(errors()).toHaveLength(1);
  });

  it('raises the turn epoch before the attempt is ended and refuses a call that still arrives from it', async () => {
    await startTeam();
    const order: string[] = [];
    bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    const backend = pm();
    const epochs: number[] = [];
    manager.on('session.turnPhase', (event) => epochs.push(event.data.epoch));
    backend.abort = () => { order.push(`abort:${manager.firstActionCallArrived('pm', launchOf(backend))}`); };
    backend.emit({ kind: 'model_request' });
    const epochOfAttempt = epochs.at(-1)!;
    vi.advanceTimersByTime(60_000);

    // The guard had expired when the attempt was aborted, so a call racing the abort is already refused, while
    // the session still holds the attempt's backend.
    expect(order).toEqual(['abort:false']);
    expect(manager.firstActionCallArrived('pm', launchOf(backend))).toBe(false);
    // The phase that closes the turn carries a later epoch than the attempt's own events did.
    expect(epochs.at(-1)!).toBeGreaterThan(epochOfAttempt);
    // A late event of the ended attempt changes nothing.
    backend.emit({ kind: 'turn_complete', result: REPLY });
    expect(bus.query({ type: 'task.complete' })).toHaveLength(0);
    expect(errors()).toHaveLength(1);
  });

  it('does not fire while the provider keeps producing, a tool runs or a person decides', async () => {
    await startTeam();
    bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    for (let second = 0; second < 300; second += 30) {
      vi.advanceTimersByTime(30_000);
      pm().emit({ kind: 'reasoning_delta', delta: '.' });
    }
    pm().emit({ kind: 'tool_use', callId: 'read-1', name: 'read_file', input: {} });
    vi.advanceTimersByTime(300_000);
    pm().emit({ kind: 'tool_result', callId: 'read-1', name: 'read_file', outcome: succeeded, summary: 'ok' });
    vi.advanceTimersByTime(30_000);
    manager.approvalStarted('pm', 'approval-1');
    vi.advanceTimersByTime(900_000);
    manager.approvalFinished('pm', 'approval-1');
    vi.advanceTimersByTime(29_000);
    expect(manager.get('pm')?.status).toBe('running');
    expect(errors()).toHaveLength(0);
    // The silence that began with the tool result has now run for 60 seconds of its own.
    vi.advanceTimersByTime(1_000);
    expect(manager.get('pm')?.status).toBe('stopped');
    expect(errors()).toHaveLength(1);
  });

  it('takes an accepted dispatch as the first action and stops guarding the turn', async () => {
    await startTeam();
    const request = bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    vi.advanceTimersByTime(40_000);
    pm().emit({ kind: 'tool_use', callId: 'dispatch-1', name: 'dispatch_task', input: {} });
    expect(manager.firstActionCallArrived('pm', pmLaunch())).toBe(true);
    // However long the host takes over the call, the provider has acted.
    vi.advanceTimersByTime(120_000);
    manager.firstActionCallAnswered('pm', pmLaunch(), 'dispatch_task', true);
    pm().emit({ kind: 'tool_result', callId: 'dispatch-1', name: 'dispatch_task', outcome: succeeded, summary: 'ok' });
    // The phases are those at the first action: 40 seconds of provider wait, then the host's 120 over the call.
    expect(firstActions).toEqual([{
      turnId: request.id, evidence: { source: 'provider', kind: 'delegation-accepted', latencyMs: 160_000 }, approvalWaitMs: 0,
      phases: {
        queuedMs: 0, hostMs: 0, providerWaitMs: 40_000, reasoningMs: 0, respondingMs: 0, toolMs: 120_000,
        providerWaitCount: 1, longestProviderWaitMs: 40_000,
      },
    }]);

    // After the first action there is no deadline: the rest of the turn may be silent for as long as it takes.
    vi.advanceTimersByTime(3_600_000);
    expect(manager.get('pm')?.status).toBe('running');
    expect(usages).toHaveLength(0);
    pm().emit({ kind: 'turn_complete', result: { ...REPLY, usage: { inputTokens: 41_000, cachedInputTokens: 27_000, outputTokens: 300 } } });
    expect(errors()).toHaveLength(0);
    expect(firstActions).toHaveLength(1);
    // The turn's usage is published once, when the turn ends, for the trial's record.
    expect(usages).toEqual([{ turnId: request.id, usage: { inputTokens: 41_000, cachedInputTokens: 27_000, outputTokens: 300 } }]);

    // A turn that is not guarded publishes none.
    bus.send('unode', 'pm', 'ask.question', { instruction: 'a result arrived', mode: 'act' });
    pm().emit({ kind: 'turn_complete', result: { ...REPLY, usage: { inputTokens: 10, outputTokens: 1 } } });
    expect(usages).toHaveLength(1);
  });

  it('gives a refused dispatch no fresh budget', async () => {
    await startTeam();
    bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    vi.advanceTimersByTime(45_000);
    pm().emit({ kind: 'tool_use', callId: 'dispatch-1', name: 'dispatch_task', input: {} });
    expect(manager.firstActionCallArrived('pm', pmLaunch())).toBe(true);
    vi.advanceTimersByTime(30_000);
    manager.firstActionCallAnswered('pm', pmLaunch(), 'dispatch_task', false);
    pm().emit({ kind: 'tool_result', callId: 'dispatch-1', name: 'dispatch_task', outcome: refused, summary: 'refused' });
    expect(firstActions).toHaveLength(0);

    vi.advanceTimersByTime(14_000);
    expect(manager.get('pm')?.status).toBe('running');
    vi.advanceTimersByTime(1_000);
    expect(manager.get('pm')?.status).toBe('stopped');
    expect(firstActions.map((entry) => entry.evidence.source)).toEqual(['host-deadline']);
  });

  it('keeps guarding through a refused dispatch and a look at the live roster, and takes the accepted retry as the first action', async () => {
    await startTeam();
    const request = bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    vi.advanceTimersByTime(16_000);
    // The dispatch names an id nobody has; the host refuses it.
    pm().emit({ kind: 'tool_use', callId: 'dispatch-1', name: 'dispatch_task', input: {} });
    expect(manager.firstActionCallArrived('pm', pmLaunch())).toBe(true);
    manager.firstActionCallAnswered('pm', pmLaunch(), 'dispatch_task', false);
    pm().emit({ kind: 'tool_result', callId: 'dispatch-1', name: 'dispatch_task', outcome: refused, summary: 'no teammate matches' });

    // The coordinator reads the live roster, as the refusal told it it may. That is no first action, and while
    // the host runs it nothing expires, however long it takes.
    vi.advanceTimersByTime(20_000);
    pm().emit({ kind: 'tool_use', callId: 'list-1', name: 'list_agents', input: {} });
    vi.advanceTimersByTime(90_000);
    pm().emit({ kind: 'tool_result', callId: 'list-1', name: 'list_agents', outcome: succeeded, summary: 'ok' });
    expect(firstActions).toHaveLength(0);
    expect(manager.get('pm')?.status).toBe('running');

    // The retry with the exact id is accepted, and it is the turn's first action.
    vi.advanceTimersByTime(20_000);
    pm().emit({ kind: 'tool_use', callId: 'dispatch-2', name: 'dispatch_task', input: {} });
    expect(manager.firstActionCallArrived('pm', pmLaunch())).toBe(true);
    manager.firstActionCallAnswered('pm', pmLaunch(), 'dispatch_task', true);
    pm().emit({ kind: 'tool_result', callId: 'dispatch-2', name: 'dispatch_task', outcome: succeeded, summary: 'ok' });
    expect(firstActions).toHaveLength(1);
    expect(firstActions[0]).toMatchObject({
      turnId: request.id, evidence: { source: 'provider', kind: 'delegation-accepted', latencyMs: 146_000 }, approvalWaitMs: 0,
    });
    expect(errors()).toHaveLength(0);
  });

  it('takes a reply that ends the turn as the first action', async () => {
    await startTeam();
    const request = bus.send('user', 'pm', 'ask.question', { instruction: 'what is the status?', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    vi.advanceTimersByTime(5_000); pm().emit({ kind: 'assistant_delta', delta: 'All green.' });
    vi.advanceTimersByTime(1_000); pm().emit({ kind: 'turn_complete', result: REPLY });
    expect(firstActions).toEqual([{
      turnId: request.id, evidence: { source: 'provider', kind: 'terminal-reply', latencyMs: 6_000 }, approvalWaitMs: 0,
      phases: {
        queuedMs: 0, hostMs: 0, providerWaitMs: 5_000, reasoningMs: 0, respondingMs: 1_000, toolMs: 0,
        providerWaitCount: 1, longestProviderWaitMs: 5_000,
      },
    }]);
    vi.advanceTimersByTime(600_000);
    expect(errors()).toHaveLength(0);
  });

  it('treats a stop as a stop: one cancellation, no deadline message, and no expiry left for the next process', async () => {
    await startTeam();
    bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    vi.advanceTimersByTime(30_000);
    const stopped = pmLaunch();
    manager.interrupt('pm');
    vi.advanceTimersByTime(600_000);

    const terminal = errors();
    expect(terminal).toHaveLength(1);
    expect(terminal[0].payload.metadata).toMatchObject({ cancelled: true });
    expect((terminal[0].payload.metadata as Record<string, unknown>).hostDeadline).toBeUndefined();
    expect(firstActions).toHaveLength(0);
    // The stopped process is gone, and a call that still arrives from it runs nothing.
    expect(manager.firstActionCallArrived('pm', stopped)).toBe(false);
    // The stop left nothing behind: the agent's next process is not refused.
    await manager.start('pm');
    pm().emit({ kind: 'ready' });
    expect(manager.firstActionCallArrived('pm', pmLaunch())).toBe(true);
  });

  it('guards only a top-level request to the coordinator of a team', async () => {
    // A worker's turn, however silent.
    await startTeam();
    bus.send('user', 'dev', 'ask.question', { instruction: 'look at this', mode: 'act' });
    backends.get('dev')!.at(-1)!.emit({ kind: 'model_request' });
    // A coordinator turn the host started, not the person.
    bus.send('unode', 'pm', 'ask.question', { instruction: 'a result arrived', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    vi.advanceTimersByTime(600_000);
    expect(manager.get('dev')?.status).toBe('running');
    expect(manager.get('pm')?.status).toBe('running');
    expect(firstActions).toHaveLength(0);
    manager.dispose();

    // A coordinator with nobody to delegate to.
    await startTeam([['pm', 'pm']]);
    bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    vi.advanceTimersByTime(600_000);
    expect(manager.get('pm')?.status).toBe('running');
    expect(firstActions).toHaveLength(0);
  });

  it('does not guard a coordinator whose only other member is Solo, and gives its turn no candidate snapshot', async () => {
    // Solo is nobody the coordinator can dispatch to, so the guard and the snapshot agree that there is no candidate.
    await startTeam([['pm', 'pm'], ['solo', 'solo']]);
    bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    vi.advanceTimersByTime(600_000);
    expect(manager.get('pm')?.status).toBe('running');
    expect(errors()).toHaveLength(0);
    expect(firstActions).toHaveLength(0);
    expect(snapshots).toBe(0);
    expect(pm().contexts).toEqual(['Project notes.']);
    manager.dispose();

    // One teammate beside Solo is enough for both.
    await startTeam([['pm', 'pm'], ['solo', 'solo'], ['dev', 'senior-dev' as AgentConfig['role']]]);
    bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    expect(snapshots).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(manager.get('pm')?.status).toBe('stopped');
    expect(firstActions.map((entry) => entry.evidence.source)).toEqual(['host-deadline']);
  });

  it('gives a guarded coordinator turn one candidate snapshot, built for that turn, and no other turn any', async () => {
    await startTeam();
    const header = '[Team candidates for this request, supplied by UnodeAi]';
    const count = (context: string) => context.split(header).length - 1;

    bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    expect(pm().contexts).toHaveLength(1);
    expect(count(pm().contexts[0])).toBe(1);
    expect(pm().contexts[0]).toBe(`Project notes.

${header}
- dev (built 1 for pm)`);
    pm().emit({ kind: 'turn_complete', result: REPLY });

    // A turn the host opened and a worker's turn carry none.
    bus.send('unode', 'pm', 'ask.question', { instruction: 'a result arrived', mode: 'act' });
    expect(pm().contexts[1]).toBe('Project notes.');
    pm().emit({ kind: 'turn_complete', result: REPLY });
    bus.send('user', 'dev', 'ask.question', { instruction: 'look at this', mode: 'act' });
    expect(backends.get('dev')!.at(-1)!.contexts).toEqual(['Project notes.']);

    // The next request gets a snapshot of its own, not the earlier one.
    bus.send('user', 'pm', 'ask.question', { instruction: 'and the next change', mode: 'act' });
    expect(count(pm().contexts[2])).toBe(1);
    expect(pm().contexts[2]).toContain('built 2 for pm');
    expect(snapshots).toBe(2);
  });

  it('starts the next turn of the coordinator with a fresh guard after a deadline', async () => {
    await startTeam();
    bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    vi.advanceTimersByTime(60_000);
    expect(manager.firstActionCallArrived('pm', pmLaunch())).toBe(false);

    // The person retries: a new process, a new turn, and the earlier attempt's expiry is gone.
    await manager.start('pm');
    pm().emit({ kind: 'ready' });
    const retry = bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    expect(backends.get('pm')).toHaveLength(2);
    expect(pm().turns).toBe(1);
    // The retried request has a candidate snapshot built for it.
    expect(pm().contexts[0]).toContain('built 2 for pm');
    pm().emit({ kind: 'model_request' });
    expect(manager.firstActionCallArrived('pm', pmLaunch())).toBe(true);
    manager.firstActionCallAnswered('pm', pmLaunch(), 'close_assignment', true);
    expect(firstActions.at(-1)).toMatchObject({
      turnId: retry.id, evidence: { source: 'provider', kind: 'assignment-closed' },
    });
  });

  it('refuses the late calls of an ended attempt while the retried turn is armed, and leaves that turn armed', async () => {
    await startTeam();
    const first = bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    vi.advanceTimersByTime(60_000);
    const endedLaunch = pmLaunch();

    // The person retries at once. The ended attempt's process is still closing when the retried turn is armed.
    await manager.start('pm');
    pm().emit({ kind: 'ready' });
    const retry = bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    expect(pmLaunch()).not.toBe(endedLaunch);
    vi.advanceTimersByTime(20_000);

    // Its dispatch and its close reach the host now. Each names the launch that is over, and neither is let in.
    expect(manager.firstActionCallArrived('pm', endedLaunch)).toBe(false);
    expect(manager.firstActionCallArrived('pm', endedLaunch)).toBe(false);
    manager.firstActionCallAnswered('pm', endedLaunch, 'dispatch_task', true);
    manager.firstActionCallAnswered('pm', endedLaunch, 'close_assignment', true);
    expect(firstActions.filter((entry) => entry.evidence.source === 'provider')).toHaveLength(0);

    // The retried turn is still armed, and its silence ran on undisturbed: it ends at its own 60 seconds. A guard
    // that had taken either call for its own would be waiting for the host and could not expire.
    vi.advanceTimersByTime(39_000);
    expect(manager.get('pm')?.status).toBe('running');
    vi.advanceTimersByTime(1_000);
    expect(manager.get('pm')?.status).toBe('stopped');
    expect(firstActions.map((entry) => [entry.turnId, entry.evidence.source])).toEqual([
      [first.id, 'host-deadline'], [retry.id, 'host-deadline'],
    ]);
  });

  it('does not take an answer of an ended process for the answer to the next turn\'s own call', async () => {
    await startTeam();
    bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    // The first attempt's dispatch is with the host when the person stops the turn.
    expect(manager.firstActionCallArrived('pm', pmLaunch())).toBe(true);
    const stopped = pmLaunch();
    manager.interrupt('pm');

    await manager.start('pm');
    pm().emit({ kind: 'ready' });
    const next = bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    // The next turn's own dispatch is with the host when the stopped process's dispatch is answered as accepted.
    expect(manager.firstActionCallArrived('pm', pmLaunch())).toBe(true);
    manager.firstActionCallAnswered('pm', stopped, 'dispatch_task', true);
    expect(firstActions).toHaveLength(0);

    // The turn's own call is refused, then its close is accepted: that, and nothing earlier, is its first action.
    manager.firstActionCallAnswered('pm', pmLaunch(), 'dispatch_task', false);
    expect(firstActions).toHaveLength(0);
    expect(manager.firstActionCallArrived('pm', pmLaunch())).toBe(true);
    manager.firstActionCallAnswered('pm', pmLaunch(), 'close_assignment', true);
    expect(firstActions).toEqual([expect.objectContaining({
      turnId: next.id, evidence: expect.objectContaining({ source: 'provider', kind: 'assignment-closed' }),
    })]);
  });
});
