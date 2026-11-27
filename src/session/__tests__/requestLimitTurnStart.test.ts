import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REQUEST_LIMIT_STOP, SessionManager, type RequestLimitsPort, type SpendSessionPort } from '../SessionManager';
import { meteredSpendPort } from '../meteredSpendPort';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler, LiveTurnResult } from '../../backend/AgentBackend';
import { RequestCeilingGate, type RequestCeilingDecision, type RequestCeilingDecisionFacts, type RequestLimits } from '../../host/RequestCeiling';
import { RequestLimitMeter } from '../../host/RequestLimitMeter';
import type { RequestCloseoutRecordV1 } from '../../observability/RequestCloseout';
import type { AgentBackendKind, AgentConfig, Message } from '../../types';

/* v0.9.94: a limited request and the session manager, bound the way the host binds them: the real gate is the
   limits port, the spend port is metered, and Stop request is the manager's own stop. */

class FakeBackend implements AgentBackend {
  readonly agentId: string;
  pid = 1234;
  turns = 0;
  /** Present when the test wants this backend to be one whose context the host can compact. */
  contextControl?: AgentBackend['contextControl'];
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void {
    this.handler = h;
    return () => (this.handler = undefined);
  }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(): void { this.turns += 1; }
  async stop(): Promise<void> {
    this.alive = false;
    this.emit({ kind: 'exit', code: 0 });
  }
  abort(): void { /* the session ends the turn */ }
  isAlive(): boolean { return this.alive; }
  emit(e: BackendEvent): void { this.handler?.(e); }
  /** The process ends by itself, without having been asked to stop. */
  die(): void {
    this.alive = false;
    this.emit({ kind: 'exit', code: 1 });
  }
}

const ROUTES: Record<AgentBackendKind, Pick<AgentConfig, 'provider' | 'model'>> = {
  'openai-compat': { provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' }, model: 'deepseek-v4.1-flash' },
  claude: { provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' }, model: 'claude-sonnet-4-5' },
  codex: { provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' }, model: 'gpt-5-codex' },
};

function makeConfig(id: string, backend?: AgentBackendKind): AgentConfig {
  return {
    id, name: id, role: 'senior-dev', skill: '',
    ...ROUTES[backend ?? 'openai-compat'],
    systemPrompt: '', autoApprove: true, allowedTools: [],
    ...(backend ? { backend } : {}),
  };
}

const reply = (overrides: Partial<LiveTurnResult> = {}): BackendEvent => ({
  kind: 'turn_complete',
  result: { text: 'done', isError: false, responseOutcome: { kind: 'reply' }, ...overrides },
});

interface OpenPrompt {
  facts: RequestCeilingDecisionFacts;
  signal: AbortSignal;
  answer(decision: RequestCeilingDecision): void;
}

/** Let every promise that is already resolvable run. */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

describe('a limited request and the start of its turns', () => {
  let bus: MessageBus;
  let manager: SessionManager;
  let gate: RequestCeilingGate;
  let backends: Map<string, FakeBackend[]>;
  let records: RequestCloseoutRecordV1[];
  let prompts: OpenPrompt[];
  let limits: RequestLimits;
  let spendCalls: string[];
  const backend = (id: string) => backends.get(id)!.at(-1)!;
  const terminal = (from: string): Message[] => bus.query({}).filter((message) =>
    message.from === from && (message.type === 'task.complete' || message.type === 'task.partial' || message.type === 'system.error'));

  async function startTeam(options: {
    limitsPort?: (real: RequestLimitsPort) => RequestLimitsPort;
    /** Every turn's compaction check never returns, so a turn stays between its allowed start and its send. */
    compactionPending?: boolean;
    /** Every turn is compacted first. The callback stands for the turn of its own the compaction took on the route. */
    compacts?: (requestId: string, agentId: string) => void;
  } = {}): Promise<void> {
    bus = new MessageBus();
    backends = new Map();
    records = [];
    prompts = [];
    spendCalls = [];
    gate = new RequestCeilingGate({
      readLimits: () => limits,
      decide: (facts, signal) => new Promise<RequestCeilingDecision>((resolve) => { prompts.push({ facts, signal, answer: resolve }); }),
      stopRequest: (requestId) => { manager.stopRequest(requestId, REQUEST_LIMIT_STOP); },
      reachableRequests: () => manager.reachableRequestIds(),
      timers: { set: () => 0, clear: () => undefined },
    });
    const spend: SpendSessionPort = {
      beginRequest: () => undefined,
      beginUsageUnit: (unit) => { spendCalls.push(`unit ${unit.agentId}`); },
      noteModelRequest: () => undefined,
      noteUsageProgress: () => undefined,
      settleUsageUnit: () => undefined,
      closeUsageUnit: () => undefined,
    };
    manager = new SessionManager(5, bus, {
      createBackend: (config) => {
        const created = new FakeBackend(config);
        if (options.compactionPending || options.compacts) created.contextControl = {} as AgentBackend['contextControl'];
        backends.set(config.id, [...(backends.get(config.id) ?? []), created]);
        return created;
      },
      resolveEnv: async () => ({}),
      ...(options.compactionPending ? { compaction: { run: () => new Promise<never>(() => undefined) } as never } : {}),
      ...(options.compacts ? {
        compaction: {
          run: async (run: { requestId: string; agentId: string }) => {
            options.compacts!(run.requestId, run.agentId);
            return { kind: 'compacted', receipt: {} };
          },
        } as never,
      } : {}),
      spend: meteredSpendPort(spend, new RequestLimitMeter(gate, (agentId) => {
        const route = manager.get(agentId)?.config.backend;
        return route === 'claude' || route === 'codex';
      })),
      requestLimits: options.limitsPort ? options.limitsPort(gate) : gate,
    });
    manager.on('session.requestCloseout', (event) => records.push(event.data.record));
    for (const [id, kind] of [['dev', undefined], ['cli', 'claude'], ['codex', 'codex']] as Array<[string, AgentBackendKind | undefined]>) {
      manager.create(makeConfig(id, kind));
      await manager.start(id, { pin: 'take' });
      backend(id).emit({ kind: 'ready' });
    }
  }

  beforeEach(() => { limits = { providerTurns: 2 }; });
  afterEach(() => { manager?.dispose(); });

  it('starts a turn at once, on the unchanged synchronous path, when no limit is configured', async () => {
    limits = {};
    await startTeam();
    bus.send('user', 'dev', 'ask.question', { instruction: 'explain this', mode: 'act' });

    // No promise was awaited: the turn is with the backend before this line.
    expect(backend('dev').turns).toBe(1);
    backend('dev').emit({ kind: 'model_request' });
    backend('dev').emit(reply());
    expect(records[0].observations.limits).toBeUndefined();
    expect(prompts).toHaveLength(0);
  });

  it('pins the limits when a request begins and starts its first turn without asking anybody', async () => {
    await startTeam();
    bus.send('user', 'dev', 'ask.question', { instruction: 'explain this', mode: 'act' });
    await settle();

    expect(backend('dev').turns).toBe(1);
    expect(prompts).toHaveLength(0);
    // A setting changed while the request runs applies to the next request, not to this one.
    limits = { providerTurns: 50 };
    backend('dev').emit({ kind: 'model_request' });
    backend('dev').emit(reply({ usage: { inputTokens: 100, outputTokens: 10 } }));
    expect(records[0].observations.limits).toMatchObject({
      coverage: 'complete', providerTurns: { ceiling: 2, observed: 1 }, crossings: 0, allowances: 0, decision: 'none',
    });
  });

  it('leaves a request that began without a limit unlimited, whatever is configured while it runs', async () => {
    limits = {};
    await startTeam();
    bus.send('user', 'dev', 'ask.question', { instruction: 'do the work', mode: 'act' });
    const requestId = manager.currentRequestId('dev')!;
    limits = { providerTurns: 1 };
    backend('dev').emit({ kind: 'model_request' });
    backend('dev').emit({ kind: 'model_request' });
    // A turn that continues the request pins nothing: it starts at once, on the synchronous path.
    bus.send('dev', 'cli', 'task.assign', { instruction: 'review the change', mode: 'act' });
    expect(manager.currentRequestId('cli')).toBe(requestId);
    expect(backend('cli').turns).toBe(1);
    expect(gate.governs(requestId)).toBe(false);
    backend('cli').emit(reply());
    backend('dev').emit(reply());
    expect(records[0].observations.limits).toBeUndefined();

    // The next request begins under the limit that is configured now.
    bus.send('user', 'dev', 'ask.question', { instruction: 'and this', mode: 'act' });
    await settle();
    expect(gate.governs(manager.currentRequestId('dev')!)).toBe(true);
    expect(prompts).toHaveLength(0);
  });

  it('counts the model requests of a turn through the same calls the spend records are shown', async () => {
    await startTeam();
    bus.send('user', 'dev', 'ask.question', { instruction: 'explain this', mode: 'act' });
    await settle();
    backend('dev').emit({ kind: 'model_request' });
    backend('dev').emit({ kind: 'model_request' });
    backend('dev').emit(reply({ usage: { inputTokens: 100, outputTokens: 10 } }));

    expect(spendCalls).toEqual(['unit dev']);
    expect(records[0].observations.limits?.providerTurns).toEqual({ ceiling: 2, observed: 2 });
  });

  it('says the limit only observes a turn on the Claude CLI and Codex routes, and holds on the others', async () => {
    await startTeam();
    for (const id of ['cli', 'codex', 'dev']) {
      bus.send('user', id, 'ask.question', { instruction: 'explain this', mode: 'act' });
      await settle();
      backend(id).emit({ kind: 'model_request' });
      backend(id).emit(reply({ text: `done by ${id}`, usage: { inputTokens: 100, outputTokens: 10 } }));
    }

    expect(records.map((record) => [record.rootAgentId, record.observations.limits?.coverage])).toEqual([
      ['cli', 'partial'], ['codex', 'partial'], ['dev', 'complete'],
    ]);
    expect(records[0].coverage.limited).toContain('limits');
    expect(records[2].coverage.limited).not.toContain('limits');
    // What was counted there is the turn the host started, once, and the record says that it is a turn.
    expect(records[0].observations.limits?.providerTurns).toEqual({ ceiling: 2, observed: 1, hostCountedTurns: 1 });
    expect(records[1].observations.limits?.providerTurns).toEqual({ ceiling: 2, observed: 1, hostCountedTurns: 1 });
    expect(records[2].observations.limits?.providerTurns).toEqual({ ceiling: 2, observed: 1 });
  });

  it('counts a turn on a CLI route as it is allowed to start, so two that start together cannot both take the last one', async () => {
    limits = { providerTurns: 2 };
    await startTeam();
    bus.send('user', 'dev', 'ask.question', { instruction: 'do the work', mode: 'act' });
    await settle();
    const requestId = manager.currentRequestId('dev')!;
    backend('dev').emit({ kind: 'model_request' });
    // One model request is counted, one is left, and two teammates on CLI routes are handed work at once.
    bus.send('dev', 'cli', 'task.assign', { instruction: 'review the change', mode: 'act' });
    bus.send('dev', 'codex', 'task.assign', { instruction: 'test the change', mode: 'act' });
    await settle();

    expect([backend('cli').turns, backend('codex').turns]).toEqual([1, 0]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].facts.limits).toMatchObject({ heldBoundary: 'turn-start', decision: 'awaiting' });
    // The started turn is counted once: at its start, and not again when its packet is seen to leave.
    backend('cli').emit({ kind: 'model_request' });
    expect(gate.facts(requestId)?.providerTurns).toEqual({ ceiling: 2, observed: 2, hostCountedTurns: 1 });
  });

  it('asks again before the turn that follows its own compaction on a CLI route, and counts both', async () => {
    limits = { providerTurns: 1 };
    // The compaction is a turn of its own there: the host started it, and it is counted as one.
    await startTeam({ compacts: (requestId, agentId) => gate.noteProviderRequest(requestId, agentId, 'turn') });
    bus.send('user', 'cli', 'ask.question', { instruction: 'do the work', mode: 'act' });
    await settle();
    const requestId = manager.currentRequestId('cli')!;

    // The start that was allowed went to the compaction. The limit of one is reached, so the turn itself waits.
    expect(backend('cli').turns).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].facts).toMatchObject({
      reached: [{ limit: 'providerTurns', configured: 1, allowance: 1, observed: 1 }],
      limits: { heldBoundary: 'turn-start', providerTurns: { ceiling: 1, observed: 1, hostCountedTurns: 1 } },
    });

    prompts[0].answer('continue');
    await settle();
    expect(backend('cli').turns).toBe(1);
    backend('cli').emit({ kind: 'model_request' });
    expect(gate.facts(requestId)?.providerTurns).toEqual({ ceiling: 1, observed: 2, hostCountedTurns: 2 });
  });

  it('names every request a later turn could continue, and none that nothing holds any more', async () => {
    limits = {};
    await startTeam();
    bus.send('user', 'dev', 'ask.question', { instruction: 'a question', mode: 'act' });
    const answered = manager.currentRequestId('dev')!;
    expect(manager.reachableRequestIds()).toEqual(new Set([answered]));
    backend('dev').emit(reply());
    // The turn is over, and its session still names the request until it starts another turn.
    expect(manager.reachableRequestIds().has(answered)).toBe(true);

    bus.send('user', 'dev', 'ask.question', { instruction: 'do the work', mode: 'act' });
    const delegating = manager.currentRequestId('dev')!;
    expect(manager.reachableRequestIds()).toEqual(new Set([delegating]));

    bus.send('dev', 'cli', 'task.assign', { instruction: 'review the change', mode: 'act' });
    expect(manager.currentRequestId('cli')).toBe(delegating);
    backend('cli').emit(reply());
    backend('dev').emit(reply());
    bus.send('user', 'dev', 'ask.question', { instruction: 'another', mode: 'act' });
    bus.send('user', 'cli', 'ask.question', { instruction: 'another', mode: 'act' });
    // No turn of it is running, and it is still named: the result of its delegation could bring it back.
    expect(manager.reachableRequestIds().has(delegating)).toBe(true);
    expect(manager.reachableRequestIds().has(answered)).toBe(false);
  });

  it('gives back the turn a CLI agent was allowed to start when its process ends before the turn made a request', async () => {
    limits = { providerTurns: 5 };
    await startTeam();
    bus.send('user', 'cli', 'ask.question', { instruction: 'do the work', mode: 'act' });
    await settle();
    const requestId = manager.currentRequestId('cli')!;
    // The turn was sent and counted at its start; the backend has not reported a request of it yet.
    expect(backend('cli').turns).toBe(1);
    expect(gate.facts(requestId)?.providerTurns).toEqual({ ceiling: 5, observed: 1 });

    backend('cli').die();
    // The turn made no request, so what it reserved is given back, and its record counts none.
    expect(gate.facts(requestId)?.providerTurns).toEqual({ ceiling: 5, observed: 0 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ rootAgentId: 'cli', terminal: { kind: 'failed', failure: 'process-lost' } });
    expect(records[0].observations.limits?.providerTurns).toEqual({ ceiling: 5, observed: 0 });
  });

  it('does not reach a limit early because a teammate\'s process ended before its turn made a request', async () => {
    limits = { providerTurns: 2 };
    await startTeam();
    bus.send('user', 'dev', 'ask.question', { instruction: 'do the work', mode: 'act' });
    await settle();
    const requestId = manager.currentRequestId('dev')!;
    backend('dev').emit({ kind: 'model_request' });
    // The teammate's turn takes the second and last allowed request as it starts, then its process ends.
    bus.send('dev', 'cli', 'task.assign', { instruction: 'review the change', mode: 'act' });
    await settle();
    expect(backend('cli').turns).toBe(1);
    expect(gate.wouldHold(requestId)).toBe(true);
    backend('cli').die();

    // One request was really made. The agent that is still working has one left, and nobody is asked.
    expect(gate.facts(requestId)?.providerTurns).toEqual({ ceiling: 2, observed: 1 });
    expect(gate.wouldHold(requestId)).toBe(false);
    expect(await gate.boundary(requestId, 'provider-request', undefined, 'dev')).toBe('proceed');
    backend('dev').emit({ kind: 'model_request' });
    expect(gate.facts(requestId)?.providerTurns).toEqual({ ceiling: 2, observed: 2 });
    expect(prompts).toHaveLength(0);
  });

  it('gives back the turn a CLI agent was allowed to start when that turn ends before it was sent', async () => {
    limits = { providerTurns: 5 };
    await startTeam({ compactionPending: true });
    bus.send('user', 'cli', 'ask.question', { instruction: 'do the work', mode: 'act' });
    await settle();
    const requestId = manager.currentRequestId('cli')!;
    // The start was allowed and counted, and the turn is still in its compaction check: nothing was sent.
    expect(backend('cli').turns).toBe(0);
    expect(gate.facts(requestId)?.providerTurns?.observed).toBe(1);

    manager.interrupt('cli');
    await settle();
    expect(backend('cli').turns).toBe(0);
    expect(gate.facts(requestId)?.providerTurns?.observed).toBe(0);
  });

  /** A request of `dev` that has reached its limit, with a teammate's turn of it about to start. */
  async function atLimitWithDelegatedTurn(): Promise<{ requestId: string }> {
    bus.send('user', 'dev', 'ask.question', { instruction: 'do the work', mode: 'act' });
    await settle();
    const requestId = manager.currentRequestId('dev')!;
    backend('dev').emit({ kind: 'model_request' });
    backend('dev').emit({ kind: 'model_request' });
    // The delegated turn inherits the request of the turn that sent it.
    bus.send('dev', 'cli', 'task.assign', { instruction: 'review the change', mode: 'act' });
    await settle();
    return { requestId };
  }

  it('holds the start of a turn of a request at its limit until the person continues', async () => {
    await startTeam();
    const { requestId } = await atLimitWithDelegatedTurn();

    expect(manager.currentRequestId('cli')).toBe(requestId);
    expect(backend('cli').turns).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].facts).toMatchObject({
      requestId,
      reached: [{ limit: 'providerTurns', configured: 2, allowance: 2, observed: 2 }],
      limits: { decision: 'awaiting', heldBoundary: 'turn-start' },
    });
    // The wait is the person's: the held turn's clock is paused for it.
    expect(manager.getTurnPhase('cli')?.approvalPending).toBe(true);

    prompts[0].answer('continue');
    await settle();
    expect(backend('cli').turns).toBe(1);
    expect(manager.getTurnPhase('cli')?.approvalPending).toBe(false);
    expect(gate.facts(requestId)).toMatchObject({ crossings: 1, allowances: 1, decision: 'continued' });
  });

  it('on Stop ends the held turn and every other live turn of the request, and sends nothing', async () => {
    await startTeam();
    const { requestId } = await atLimitWithDelegatedTurn();
    prompts[0].answer('stop');
    await settle();

    expect(backend('cli').turns).toBe(0);
    expect(manager.get('cli')?.status).toBe('stopped');
    expect(manager.get('dev')?.status).toBe('stopped');
    expect(manager.requestRunning(requestId)).toBe(false);
    for (const id of ['cli', 'dev']) {
      const [ended] = terminal(id);
      expect(ended.type).toBe('system.error');
      expect(ended.payload.instruction).toBe(REQUEST_LIMIT_STOP);
    }
    // The top-level turn's record says what stopped it.
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ rootAgentId: 'dev', terminal: { kind: 'stopped' } });
    expect(records[0].observations.limits).toMatchObject({ crossings: 1, allowances: 0, decision: 'stopped', heldBoundary: 'turn-start' });
  });

  it('refuses a later turn of a stopped request at its start, without asking again', async () => {
    await startTeam();
    await atLimitWithDelegatedTurn();
    prompts[0].answer('stop');
    await settle();

    // Work of the stopped request that was still on its way: a second assignment the stopped turn had queued.
    const requestId = records[0].requestId;
    expect(await gate.boundary(requestId, 'turn-start')).toBe('stopped');
    expect(gate.governs(requestId)).toBe(true);
    expect(prompts).toHaveLength(1);
  });

  it('releases a held start when the person stops that agent, and closes the prompt nobody waits on', async () => {
    await startTeam();
    const { requestId } = await atLimitWithDelegatedTurn();
    manager.interrupt('cli');
    await settle();

    expect(backend('cli').turns).toBe(0);
    expect(prompts[0].signal.aborted).toBe(true);
    // The request itself was not stopped: the turn that reached the limit is still live.
    expect(manager.get('dev')?.status).toBe('running');
    expect(gate.facts(requestId)?.decision).toBe('none');
    expect(terminal('cli')[0].payload.instruction).toBe('Stopped by user.');
  });

  it('does not send a turn whose start was allowed after its agent had been stopped', async () => {
    await startTeam();
    await atLimitWithDelegatedTurn();
    manager.interrupt('cli');
    prompts[0].answer('continue');
    await settle();

    expect(backend('cli').turns).toBe(0);
    expect(backends.get('cli')).toHaveLength(1);
  });

  // The decision card of a reached limit is shown in the conversation of the agent the person asked.
  it('names the agent the person asked as the root of a request, whoever is working on it', async () => {
    limits = { providerTurns: 50 };
    await startTeam();
    bus.send('user', 'dev', 'ask.question', { instruction: 'do the work', mode: 'act' });
    await settle();
    const requestId = manager.currentRequestId('dev')!;
    expect(manager.requestRootAgent(requestId)).toBe('dev');

    // A teammate works on it too: the root is still the agent that was asked.
    bus.send('dev', 'cli', 'task.assign', { instruction: 'review the change', mode: 'act' });
    await settle();
    expect(manager.currentRequestId('cli')).toBe(requestId);
    expect(manager.requestRootAgent(requestId)).toBe('dev');

    // The asked agent's turn ends while the teammate's is still out.
    backend('dev').emit(reply());
    await settle();
    expect(manager.liveRequestAgents(requestId)).toEqual(['cli']);
    expect(manager.requestRootAgent(requestId)).toBe('dev');

    // A turn the host starts has no task of the person's behind it: its root is the agent running it.
    bus.send('unode', 'codex', 'ask.question', { instruction: 'the results are in', mode: 'act' });
    await settle();
    const hostRequest = manager.currentRequestId('codex')!;
    expect(hostRequest).not.toBe(requestId);
    expect(manager.requestRootAgent(hostRequest)).toBe('codex');

    // A request that is over has no root, and neither has one that never was.
    backend('cli').emit(reply());
    backend('codex').emit(reply());
    await settle();
    expect(manager.requestRootAgent(requestId)).toBeUndefined();
    expect(manager.requestRootAgent(hostRequest)).toBeUndefined();
    expect(manager.requestRootAgent('no-such-request')).toBeUndefined();
  });

  it('starts no turn when the limits host cannot be asked, and leaves requests unlimited when it cannot be read', async () => {
    await startTeam({
      limitsPort: (real) => ({
        begin: (requestId) => real.begin(requestId),
        governs: (requestId) => real.governs(requestId),
        wouldHold: () => { throw new Error('limits host failed'); },
        markObservedOnly: (requestId) => real.markObservedOnly(requestId),
        boundary: () => { throw new Error('limits host failed'); },
        facts: (requestId) => real.facts(requestId),
      }),
    });
    bus.send('user', 'dev', 'ask.question', { instruction: 'explain this', mode: 'act' });
    await settle();
    // The question that holds a turn could not be asked: that is not a permission.
    expect(backend('dev').turns).toBe(0);
    expect(terminal('dev')[0].payload.instruction).toBe(REQUEST_LIMIT_STOP);
    manager.dispose();

    await startTeam({
      limitsPort: (real) => ({ ...real, begin: () => { throw new Error('limits host failed'); }, governs: () => { throw new Error('limits host failed'); },
        wouldHold: () => false, markObservedOnly: () => undefined, boundary: () => Promise.resolve('stopped'), facts: () => undefined }),
    });
    bus.send('user', 'dev', 'ask.question', { instruction: 'explain this', mode: 'act' });
    // Bookkeeping that fails blocks nothing: the turn starts as a request without a limit does.
    expect(backend('dev').turns).toBe(1);
  });
});
