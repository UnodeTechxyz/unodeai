import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, type SessionManagerDeps, type TurnEndedEvent } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler, TurnAttachments } from '../../backend/AgentBackend';
import type { FirstActionEvidence } from '../FirstActionGuard';
import type { AgentConfig } from '../../types';
import { OpenAICompatBackend, type StreamFetchFn } from '../../backend/OpenAICompatBackend';

class FakeBackend implements AgentBackend {
  readonly agentId: string;
  pid = 1234;
  turns = 0;
  contexts: string[] = [];
  contextControl?: AgentBackend['contextControl'];
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

describe('live turn status without a first-action deadline', () => {
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

  async function startTeam(members: Array<[string, AgentConfig['role']]> = [['pm', 'pm'], ['dev', 'senior-dev' as AgentConfig['role']]], pmConfig: Partial<AgentConfig> = {}, deps: Partial<SessionManagerDeps> = {}): Promise<void> {
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
      ...deps,
    });
    ended = [];
    snapshots = 0;
    firstActions = [];
    manager.on('session.turnEnded', (event) => ended.push(event.data));
    manager.on('session.firstAction', (event) => firstActions.push(event.data));
    usages = [];
    manager.on('session.firstActionTurnUsage', (event) => usages.push(event.data));
    for (const [id, role] of members) {
      manager.create({ ...makeConfig(id, role), ...pmConfig });
      await manager.start(id, { pin: 'take' });
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


  it.each(['claude', 'codex', 'openai-compat'] as const)('%s does not stop a silent PM or worker after ten minutes', async backend => {
    const provider = backend === 'codex' ? { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' }
      : backend === 'openai-compat' ? { providerId: 'openai', apiKeySecretName: 'OPENAI_API_KEY' }
        : { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' };
    await startTeam(undefined, { backend, provider });
    const phases: Array<{ sessionId?: string; data: { phase?: { lastActivityAt?: string } } }> = [];
    manager.on('session.turnPhase', event => phases.push(event));
    bus.send('user', 'pm', 'ask.question', { instruction: 'work', mode: 'act' });
    bus.send('user', 'dev', 'ask.question', { instruction: 'work', mode: 'act' });
    const worker = backends.get('dev')!.at(-1)!;
    pm().emit({ kind: 'model_request', outputVisibility: 'buffered' });
    worker.emit({ kind: 'model_request' });
    vi.advanceTimersByTime(600_000);
    for (const id of ['pm', 'dev']) {
      expect(manager.get(id)?.status).toBe('running');
      expect(phases.filter(event => event.sessionId === id)).toHaveLength(602);
      expect(manager.getTurnPhase(id)?.lastActivityAt).toBe(new Date(START).toISOString());
      expect(manager.getTurnPhase(id)?.progressSummary).toContain('This task is still running.');
    }
    expect(errors()).toHaveLength(0); expect(ended).toHaveLength(0); expect(firstActions).toHaveLength(0);
    expect(pm().aborted).toBe(0); expect(worker.aborted).toBe(0);
    // The existing launch remains usable after the former deadline.
    expect(manager.firstActionCallArrived('pm', pmLaunch())).toBe(true);
    manager.firstActionCallAnswered('pm', pmLaunch(), 'dispatch_task', true);
    expect(firstActions[0].evidence).toMatchObject({ source: 'provider', kind: 'delegation-accepted', latencyMs: 600_000 });
  });

  it('treats the legacy Claude idle observation as progress, not a stop', async () => {
    await startTeam(); bus.send('user', 'pm', 'ask.question', { instruction: 'work', mode: 'act' });
    pm().emit({ kind: 'model_request' }); vi.advanceTimersByTime(900_000);
    pm().emit({ kind: 'watchdog_idle', idleMs: 900_000 });
    expect(manager.get('pm')?.status).toBe('running'); expect(pm().aborted).toBe(0);
    expect(manager.getTurnPhase('pm')?.progressSummary).toContain('This task is still running.');
    expect(ended).toHaveLength(0); expect(errors()).toHaveLength(0);
    manager.interrupt('pm'); expect(pm().aborted).toBe(1);
  });

  it('records long compaction without a pause budget or a host-deadline outcome', async () => {
    await startTeam();
    bus.send('user', 'pm', 'ask.question', { instruction: 'work', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    pm().emit({ kind: 'provider_compaction', phase: 'started' });
    vi.advanceTimersByTime(600_000);
    expect(manager.getTurnPhase('pm')?.phase).toBe('compacting');
    pm().emit({ kind: 'provider_compaction', phase: 'finished' });
    pm().emit({ kind: 'turn_complete', result: REPLY });
    expect(ended[0]).toMatchObject({ ended: 'completed', timing: { phases: { compactingMs: 600_000 } } });
    expect(firstActions[0].evidence.source).toBe('provider'); expect(errors()).toHaveLength(0);
    expect(manager.getTurnPhase('pm')).toBeUndefined();
    const ticks = vi.getTimerCount(); vi.advanceTimersByTime(600_000);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(ticks);
  });

  it('updates the activity timestamp on repeated output in one phase, not on repeated sends', async () => {
    await startTeam();
    bus.send('user', 'pm', 'ask.question', { instruction: 'work', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    vi.advanceTimersByTime(21_000); pm().emit({ kind: 'model_request' });
    expect(manager.getTurnPhase('pm')?.lastActivityAt).toBe(new Date(START).toISOString());
    for (const event of [
      { kind: 'assistant_delta', delta: 'reply' },
      { kind: 'reasoning_delta', delta: 'thinking' },
      { kind: 'provider_activity', activity: 'tool-input' },
      { kind: 'provider_activity', activity: 'tool-input' },
    ] as BackendEvent[]) {
      vi.advanceTimersByTime(30_000); pm().emit(event);
      expect(manager.getTurnPhase('pm')?.lastActivityAt).toBe(new Date(Date.now()).toISOString());
    }
    expect(manager.getTurnPhase('pm')?.preparingTool).toBe(true);
    manager.interrupt('pm'); expect(manager.getTurnPhase('pm')).toBeUndefined();
    expect(errors()[0].payload.metadata).toMatchObject({ cancelled: true });
  });

  it('summarizes real progress during silence and keeps recording the work that follows', async () => {
    await startTeam(); bus.send('user', 'pm', 'ask.question', { instruction: 'work', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    pm().emit({ kind: 'tool_use', callId: 'read', name: 'read_file', input: { path: 'src/a.ts' } });
    pm().emit({ kind: 'tool_result', callId: 'read', name: 'read_file', outcome: succeeded,
      read: { path: 'src/a.ts' }, summary: 'untrusted tool prose must not become the progress summary' });
    pm().emit({ kind: 'tool_use', callId: 'write', name: 'write_file', input: {} });
    vi.advanceTimersByTime(20_000);
    const progress = manager.getTurnPhase('pm')?.progressSummary!;
    expect(progress).toContain('read_file: 1 succeeded'); expect(progress).toContain('Files read: src/a.ts.');
    expect(progress).toContain('Still awaiting a recorded result: write_file (1).');
    expect(progress).not.toContain('untrusted tool prose');
    expect(manager.get('pm')?.status).toBe('running'); expect(pm().turns).toBe(1);
    pm().emit({ kind: 'tool_result', callId: 'write', name: 'write_file', outcome: succeeded, summary: 'ok' });
    expect(manager.getTurnPhase('pm')?.progressSummary).toBeUndefined();
    vi.advanceTimersByTime(20_000);
    expect(manager.getTurnPhase('pm')?.progressSummary).toContain('write_file: 1 succeeded');
    expect(manager.getTurnPhase('pm')?.progressSummary).not.toContain('write_file (1)');
    pm().emit({ kind: 'assistant_delta', delta: 'continuing' });
    expect(manager.getTurnPhase('pm')?.progressSummary).toBeUndefined();
    manager.interrupt('pm'); expect(manager.getTurnPhase('pm')).toBeUndefined();
    expect(ended).toHaveLength(1); expect(ended[0].ended).toBe('stopped');
  });

  it('refused dispatches remain measurements, never restart or end the request', async () => {
    await startTeam(); bus.send('user', 'pm', 'ask.question', { instruction: 'work', mode: 'act' });
    pm().emit({ kind: 'model_request' }); vi.advanceTimersByTime(45_000);
    expect(manager.firstActionCallArrived('pm', pmLaunch())).toBe(true);
    manager.firstActionCallAnswered('pm', pmLaunch(), 'dispatch_task', false);
    vi.advanceTimersByTime(600_000);
    expect(manager.get('pm')?.status).toBe('running'); expect(firstActions).toHaveLength(0);
    expect(backends.get('pm')).toHaveLength(1); expect(errors()).toHaveLength(0);
  });

  it('binds a completion-check receipt to its original running request and turn, not the next task', async () => {
    await startTeam();
    const closeouts: any[] = [];
    manager.on('session.requestCloseout', event => closeouts.push(event.data.record));
    bus.send('user', 'pm', 'ask.question', { instruction: 'first task', mode: 'act' });
    const requestId = manager.currentRequestId('pm'); const turnId = manager.currentTurnId('pm');
    const check = { kind: 'not-run' as const, source: 'team-document' as const, reason: 'disabled' as const, detail: 'private-detail' };
    expect(manager.recordVerificationCheck('pm', 'other-request', turnId, check, 'completion-gate', pmLaunch())).toBe(false);
    expect(manager.recordVerificationCheck('pm', requestId, 'other-turn', check, 'completion-gate', pmLaunch())).toBe(false);
    expect(manager.recordVerificationCheck('pm', requestId, turnId, check, 'completion-gate', 'old-launch')).toBe(false);
    expect(manager.recordVerificationCheck('pm', requestId, turnId, check, 'completion-gate', pmLaunch())).toBe(true);
    pm().emit({ kind: 'turn_complete', result: REPLY });
    expect(closeouts[0].observations.checks).toMatchObject({ passed: 0, failed: 0,
      lastCompletionCheck: { kind: 'not-run', reason: 'disabled', source: 'team-document' } });
    expect(JSON.stringify(closeouts[0])).not.toContain('private-detail');
    bus.send('user', 'pm', 'ask.question', { instruction: 'second task', mode: 'act' });
    expect(manager.recordVerificationCheck('pm', requestId, turnId, check, 'completion-gate', pmLaunch())).toBe(false);
    pm().emit({ kind: 'turn_complete', result: REPLY });
    expect(closeouts[1].observations.checks.lastCompletionCheck).toBeUndefined();
  });

  it('observes output-only progress for a long dispatch without inventing a reply or first action', async () => {
    await startTeam();
    const streamed: unknown[] = [];
    manager.on('session.stream', e => streamed.push(e.data));
    bus.send('user', 'pm', 'ask.question', { instruction: 'dispatch a detailed brief', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    pm().emit({ kind: 'assistant_delta', delta: 'Preparing the brief.' });
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(30_000);
      pm().emit({ kind: 'provider_activity' });
      expect(firstActions).toHaveLength(0);
      expect(manager.get('pm')?.status).toBe('running');
    }
    expect(streamed).toHaveLength(1);
    expect(errors()).toHaveLength(0);
    pm().emit({ kind: 'tool_use', callId: 'dispatch-long', name: 'dispatch_task', input: {} });
    expect(manager.firstActionCallArrived('pm', pmLaunch())).toBe(true);
    manager.firstActionCallAnswered('pm', pmLaunch(), 'dispatch_task', true);
    expect(firstActions).toHaveLength(1);
    expect(firstActions[0].evidence.kind).toBe('delegation-accepted');
    vi.advanceTimersByTime(120_000);
    expect(errors()).toHaveLength(0);
  });

  it.each(['native-input', 'xml', 'hidden-thinking'] as const)(
    'keeps a real %s SSE stream alive through more than 60 seconds of hidden generation', async format => {
      await startTeam();
      bus.send('user', 'pm', 'ask.question', { instruction: 'write a detailed dispatch', mode: 'act' });
      const encode = (delta: unknown) => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      const streamFetch: StreamFetchFn = async () => ({ ok: true, status: 200, body: (async function* () {
        yield encode({ content: 'Preparing the task.' });
        const fragments = format === 'native-input'
          ? [{ tool_calls: [{ index: 0, id: 'brief', function: { name: 'dispatch_task', arguments: '{"brief":"' } }] },
            { tool_calls: [{ index: 0, function: { arguments: 'long brief' } }] },
            { tool_calls: [{ index: 0, function: { arguments: '"}' } }] }]
          : (format === 'xml' ? ['<dispatch_task><brief>', 'long brief', '</brief></dispatch_task>']
            : ['<thinking>', 'private reasoning', '</thinking>']).map(content => ({ content }));
        for (const delta of fragments) {
          await vi.advanceTimersByTimeAsync(30_000);
          yield encode(delta);
        }
        yield new TextEncoder().encode('data: [DONE]\n\n');
      })() });
      const backend = new OpenAICompatBackend({ ...makeConfig('wire', 'pm'),
        provider: { providerId: 'openai', apiKeySecretName: 'OPENAI_API_KEY' }, model: 'gpt-4o', workingDirectory: process.cwd() },
      async () => { throw new Error('No non-streaming fallback expected'); },
      undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, streamFetch);
      const observed: BackendEvent[] = [];
      backend.onEvent(event => { observed.push(event); pm().emit(event); });
      const result = await (backend as any).chatStream([{ type: 'function', function: { name: 'dispatch_task', parameters: {} } }]);
      expect(manager.get('pm')?.status).toBe('running');
      expect(errors()).toHaveLength(0);
      expect(firstActions).toHaveLength(0);
      expect(observed.filter(e => e.kind === 'provider_activity')).toHaveLength(4);
      expect(observed.filter(e => e.kind === 'assistant_delta')).toEqual([{ kind: 'assistant_delta', delta: 'Preparing the task.' }]);
      if (format === 'native-input') {
        expect(result.choices[0].message.tool_calls[0].function.arguments).toBe('{"brief":"long brief"}');
        pm().emit({ kind: 'tool_use', callId: 'brief', name: 'dispatch_task', input: { brief: 'long brief' } });
        expect(manager.firstActionCallArrived('pm', pmLaunch())).toBe(true);
        manager.firstActionCallAnswered('pm', pmLaunch(), 'dispatch_task', true);
        expect(firstActions[0].evidence.kind).toBe('delegation-accepted');
      } else {
        await vi.advanceTimersByTimeAsync(600_000);
        expect(errors()).toHaveLength(0);
      }
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
        queuedMs: 0, hostMs: 0, providerWaitMs: 40_000, reasoningMs: 0, respondingMs: 0, toolMs: 120_000, compactingMs: 0,
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
        queuedMs: 0, hostMs: 0, providerWaitMs: 5_000, reasoningMs: 0, respondingMs: 1_000, toolMs: 0, compactingMs: 0,
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
    await manager.start('pm', { pin: 'take' });
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

  it('gives a guarded coordinator turn one candidate snapshot, built for that turn, and no other turn any', async () => {
    await startTeam();
    const header = '[Team candidates for this request, supplied by UnodeAi]';
    const count = (context: string) => context.split(header).length - 1;

    bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    expect(pm().contexts).toHaveLength(1);
    expect(count(pm().contexts[0])).toBe(1);
    // v0.9.99: every coordinator turn then carries its team state; the candidate snapshot stays the request's own.
    const teamState = '\n\n[Team state for this turn, supplied by UnodeAi]\n';
    expect(pm().contexts[0].startsWith(`Project notes.

${header}
- dev (built 1 for pm)${teamState}`)).toBe(true);
    pm().emit({ kind: 'turn_complete', result: REPLY });

    // A turn the host opened carries the team state and no candidate snapshot; a worker's turn carries neither.
    bus.send('unode', 'pm', 'ask.question', { instruction: 'a result arrived', mode: 'act' });
    expect(count(pm().contexts[1])).toBe(0);
    expect(pm().contexts[1].startsWith(`Project notes.${teamState}`)).toBe(true);
    pm().emit({ kind: 'turn_complete', result: REPLY });
    bus.send('user', 'dev', 'ask.question', { instruction: 'look at this', mode: 'act' });
    expect(backends.get('dev')!.at(-1)!.contexts).toEqual(['Project notes.']);

    // The next request gets a snapshot of its own, not the earlier one.
    bus.send('user', 'pm', 'ask.question', { instruction: 'and the next change', mode: 'act' });
    expect(count(pm().contexts[2])).toBe(1);
    expect(pm().contexts[2]).toContain('built 2 for pm');
    expect(snapshots).toBe(2);
  });

  it('does not take an answer of an ended process for the answer to the next turn\'s own call', async () => {
    await startTeam();
    bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    pm().emit({ kind: 'model_request' });
    // The first attempt's dispatch is with the host when the person stops the turn.
    expect(manager.firstActionCallArrived('pm', pmLaunch())).toBe(true);
    const stopped = pmLaunch();
    manager.interrupt('pm');

    await manager.start('pm', { pin: 'take' });
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
