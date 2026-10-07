import { beforeEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler, ConversationSnapshot } from '../../backend/AgentBackend';
import type { AgentConfig, Message } from '../../types';
import { RunLedger } from '../../observability/RunLedger';
import { appendChatMessage, deserializeChatHistory, serializeChatHistory } from '../../views/chatHistory';
import { TurnOutcomeAccumulator, type TurnOutcomeReceiptV1 } from '../turnOutcomeReceipt';

class FakeBackend implements AgentBackend {
  readonly agentId: string;
  readonly pid = 1;
  private handler: BackendEventHandler | undefined;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  sendUserTurn(): void {}
  interject(): void {}
  abort(): void {}
  onEvent(handler: BackendEventHandler): void { this.handler = handler; }
  isAlive(): boolean { return true; }
  snapshot(): ConversationSnapshot { return { version: 1, messages: [] }; }
  restore(): void {}
  emit(event: BackendEvent): void { this.handler?.(event); }
}

function config(id: string, role: string): AgentConfig {
  return {
    id, name: id, role: role as AgentConfig['role'], skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-sonnet-4-20250514', systemPrompt: '', autoApprove: true, allowedTools: [],
  };
}

const terminalReceipt = (message: Message | undefined): TurnOutcomeReceiptV1 | undefined =>
  (message?.payload.metadata as { turnOutcome?: TurnOutcomeReceiptV1 } | undefined)?.turnOutcome;

describe('v0.9.91 turn outcome receipt in Session', () => {
  let bus: MessageBus;
  let backends: Map<string, FakeBackend>;
  let runIds: Array<[string, string]>;
  let mgr: SessionManager;

  beforeEach(() => {
    bus = new MessageBus();
    backends = new Map();
    runIds = [];
    mgr = new SessionManager(5, bus, {
      createBackend: (agent) => {
        const backend = new FakeBackend(agent);
        backends.set(agent.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
      resolveTurnRunId: (sessionId, correlationId) => {
        runIds.push([sessionId, correlationId]);
        return sessionId === 'pm' ? 'run-7' : undefined;
      },
    });
  });

  async function started(id: string, role: string): Promise<FakeBackend> {
    mgr.create(config(id, role));
    await mgr.start(id);
    const backend = backends.get(id)!;
    backend.emit({ kind: 'ready' });
    return backend;
  }

  it('puts one receipt on the terminal message, counted from call ids and typed facts only', async () => {
    const pm = await started('pm', 'pm');
    const origin = bus.send('user', 'pm', 'task.assign', { instruction: 'Coordinate.' });
    pm.emit({ kind: 'tool_use', callId: 'call-1', name: 'Bash', input: { command: 'rm -rf build' } });
    // Wording that a phrase table would read as success: the typed refusal is what counts.
    pm.emit({ kind: 'tool_result', callId: 'call-1', name: 'Bash', outcome: { status: 'refused', observedBy: 'host', reason: 'trust' }, summary: 'all good', detail: 'ok' });
    pm.emit({ kind: 'tool_use', callId: 'call-2', name: 'Read', input: { file_path: 'a.ts' } });
    pm.emit({ kind: 'tool_result', callId: 'call-2', name: 'Read', outcome: { status: 'success', observedBy: 'provider-protocol' }, summary: 'denied: not found' });
    pm.emit({ kind: 'tool_coverage_gap', reason: 'host-decision-unjoined' });
    pm.emit({ kind: 'turn_complete', result: { text: 'Done.', isError: false, responseOutcome: { kind: 'reply' } } });

    const receipt = terminalReceipt(bus.query({ type: 'task.complete' }).at(-1));
    expect(receipt).toEqual({
      schemaVersion: 1,
      receiptId: `turn-outcome:${origin.id}`,
      turnId: origin.id,
      agentId: 'pm',
      correlationId: origin.id,
      runId: 'run-7',
      recordedAt: expect.any(String),
      delivery: { kind: 'reply' },
      tools: {
        coverage: 'partial',
        total: 2, success: 1, refused: 1, failed: 0,
        failureKinds: {}, refusalReasons: { trust: 1 },
        unmatchedUses: 0, unmatchedResults: 0, excludedNativeActivities: 0, unjoinedHostDecisions: 1, observationGaps: 0,
      },
    });
    expect(runIds).toEqual([['pm', origin.id]]);
    expect(JSON.stringify(receipt)).not.toMatch(/Bash|Read|rm -rf|a\.ts|all good|not found|call-1/);
  });

  it('starts every turn with fresh counts, and names native activity it does not mediate', async () => {
    const dev = await started('dev', 'dev');
    bus.send('pm', 'dev', 'task.assign', { instruction: 'First.' }, 'normal', 'handle-1');
    dev.emit({ kind: 'tool_use', callId: 'call-1', name: 'Read', input: {} });
    dev.emit({ kind: 'native_mcp_activity', server: 'docs', tool: 'lookup', status: 'inProgress' });
    dev.emit({ kind: 'native_mcp_activity', server: 'docs', tool: 'lookup', status: 'completed' });
    dev.emit({ kind: 'turn_complete', result: { text: 'First done.', isError: false, responseOutcome: { kind: 'reply' } } });
    expect(terminalReceipt(bus.query({ type: 'task.complete' }).at(-1))?.tools).toMatchObject({
      coverage: 'partial', unmatchedUses: 1, excludedNativeActivities: 1, total: 0,
    });

    bus.send('pm', 'dev', 'task.assign', { instruction: 'Second.' }, 'normal', 'handle-2');
    dev.emit({ kind: 'turn_complete', result: { text: '', isError: false, responseOutcome: { kind: 'tool-only' } } });
    const second = terminalReceipt(bus.query({ type: 'task.complete' }).at(-1));
    expect(second).toMatchObject({ correlationId: 'handle-2', delivery: { kind: 'tool-only' }, tools: { coverage: 'complete', total: 0 } });
    expect(second).not.toHaveProperty('runId');
  });

  it('records a turn whose process died as an error delivery with partial coverage, and starts the next turn fresh', async () => {
    const dev = await started('dev', 'dev');
    const origin = bus.send('pm', 'dev', 'task.assign', { instruction: 'Doomed.' }, 'normal', 'handle-lost');
    dev.emit({ kind: 'tool_use', callId: 'call-1', name: 'Read', input: {} });
    dev.emit({ kind: 'tool_result', callId: 'call-1', name: 'Read', outcome: { status: 'success', observedBy: 'provider-protocol' }, summary: 'ok' });
    dev.emit({ kind: 'tool_use', callId: 'call-2', name: 'Bash', input: {} });
    dev.emit({ kind: 'exit', code: 1 });
    const lost = bus.query({ type: 'system.error' }).at(-1);
    expect((lost?.payload.metadata as { interrupted?: boolean }).interrupted).toBe(true);
    // New v0.9.91 data is never confused with a legacy row: the receipt says what was seen before the stream was cut.
    expect(terminalReceipt(lost)).toMatchObject({
      turnId: origin.id,
      correlationId: 'handle-lost',
      delivery: { kind: 'error' },
      tools: { coverage: 'partial', total: 1, success: 1, unmatchedUses: 1, observationGaps: 1 },
    });

    await mgr.start('dev');
    const restarted = backends.get('dev')!;
    restarted.emit({ kind: 'ready' });
    bus.send('pm', 'dev', 'task.assign', { instruction: 'Again.' }, 'normal', 'handle-again');
    restarted.emit({ kind: 'turn_complete', result: { text: 'Ok.', isError: false, responseOutcome: { kind: 'reply' } } });
    expect(terminalReceipt(bus.query({ type: 'task.complete' }).at(-1))?.tools).toMatchObject({ coverage: 'complete', unmatchedUses: 0 });
  });
});

describe('v0.9.91 one receipt, kept by the transcript and the run ledger', () => {
  it('keeps the identical receipt in both scopes; neither builds its own', async () => {
    const bus = new MessageBus();
    const ledger = new RunLedger();
    bus.subscribe({}, (message) => ledger.observeMessage(message));
    const backends = new Map<string, FakeBackend>();
    const mgr = new SessionManager(5, bus, {
      createBackend: (agent) => {
        const backend = new FakeBackend(agent);
        backends.set(agent.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
      resolveTurnRunId: (sessionId, correlationId) => ledger.turnRunId(sessionId, correlationId),
    });
    mgr.create(config('dev', 'dev'));
    await mgr.start('dev');
    const dev = backends.get('dev')!;
    dev.emit({ kind: 'ready' });
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'handle-dev', requestedAgent: 'dev', agentId: 'dev',
      instruction: 'Fix it.', originCorrelationId: 'root-thread',
    });

    bus.send('pm', 'dev', 'task.assign', { instruction: 'Fix it.' }, 'normal', 'handle-dev');
    dev.emit({ kind: 'tool_use', callId: 'call-1', name: 'Edit', input: {} });
    dev.emit({ kind: 'tool_result', callId: 'call-1', name: 'Edit', outcome: { status: 'failed', observedBy: 'host', failureKind: 'cancelled' }, summary: 'x' });
    dev.emit({ kind: 'turn_complete', result: { text: 'Partly.', isError: false, responseOutcome: { kind: 'reply' } } });

    const terminal = bus.query({ type: 'task.complete' }).at(-1)!;
    const sent = terminalReceipt(terminal)!;
    expect(sent.runId).toBe(runId);
    expect(ledger.get(runId)!.turnOutcomes).toEqual([{ state: 'available', receipt: sent }]);
    const transcript = deserializeChatHistory(JSON.parse(JSON.stringify(serializeChatHistory(appendChatMessage([], {
      role: 'agent', text: 'Partly.', ts: terminal.timestamp, turnFinal: true, turnOutcome: sent,
    })))));
    expect(transcript[0].turnOutcome).toEqual(sent);

    // A replayed terminal event, or another window's copy of the ledger, upserts the same single receipt.
    ledger.observeMessage(terminal);
    expect(new RunLedger(ledger.snapshotForPersistence(ledger.snapshot())).get(runId)!.turnOutcomes).toEqual([{ state: 'available', receipt: sent }]);
  });
});

describe('v0.9.91 Codex-native activity cards', () => {
  it('forwards each native call as a card paired by its host call id, with Codex\'s own status as its fact', async () => {
    const bus = new MessageBus();
    const backends = new Map<string, FakeBackend>();
    const mgr = new SessionManager(5, bus, {
      createBackend: (agent) => {
        const backend = new FakeBackend(agent);
        backends.set(agent.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
    });
    mgr.create(config('dev', 'dev'));
    await mgr.start('dev');
    const dev = backends.get('dev')!;
    dev.emit({ kind: 'ready' });
    const tools: any[] = [];
    mgr.on('session.tool', (event) => tools.push(event.data));
    bus.send('pm', 'dev', 'task.assign', { instruction: 'Look it up.' }, 'normal', 'handle-native');
    for (const [callId, status] of [['call-1', 'inProgress'], ['call-1', 'completed'], ['call-2', 'inProgress'], ['call-2', 'failed']] as const) {
      dev.emit({ kind: 'native_mcp_activity', callId, server: 'docs', tool: 'lookup', status });
    }
    expect(tools.map((tool) => [tool.phase, tool.callId, tool.outcome ?? null])).toEqual([
      ['use', 'call-1', null],
      ['result', 'call-1', { status: 'success', observedBy: 'provider-protocol' }],
      ['use', 'call-2', null],
      ['result', 'call-2', { status: 'failed', observedBy: 'provider-protocol', failureKind: 'error' }],
    ]);
  });
});

describe('v0.9.91 receipts are enough for a later projection', () => {
  // A stand-in for a v0.9.92/93 projector. Its inputs are receipts only: no chat text, tool prose or backend events.
  type Projection = { turns: number; refused: number; failed: number; coverage: 'complete' | 'partial' | 'unavailable' };
  const project = (receipts: Array<TurnOutcomeReceiptV1 | 'conflict' | undefined>): Projection => {
    if (receipts.some((receipt) => receipt === 'conflict' || receipt === undefined)) {
      return { turns: receipts.length, refused: 0, failed: 0, coverage: 'unavailable' };
    }
    const kept = receipts as TurnOutcomeReceiptV1[];
    return {
      turns: kept.length,
      refused: kept.reduce((sum, receipt) => sum + receipt.tools.refused, 0),
      failed: kept.reduce((sum, receipt) => sum + receipt.tools.failed, 0),
      coverage: kept.every((receipt) => receipt.tools.coverage === 'complete') ? 'complete' : 'partial',
    };
  };

  it('projects a run from its ledger entries and a request from its transcript, and never fills a gap', () => {
    const receipt = (turnId: string, refused: number) => {
      const turn = new TurnOutcomeAccumulator();
      for (let index = 0; index < refused; index++) {
        turn.use(`call-${index}`);
        turn.result(`call-${index}`, { status: 'refused', observedBy: 'host', reason: 'consent' });
      }
      return turn.finish({ turnId, agentId: 'dev', recordedAt: '2026-09-30T10:00:00.000Z', delivery: { kind: 'reply' } })!;
    };
    const ledger = new RunLedger();
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h', requestedAgent: 'dev', agentId: 'dev', instruction: 'x', originCorrelationId: 'root',
    });
    for (const [turnId, refused] of [['m-1', 1], ['m-2', 2]] as const) {
      const sent = { id: turnId, correlationId: 'h', from: 'dev', to: 'pm', type: 'task.complete' as const, priority: 'normal' as const,
        payload: { instruction: 'Done.', metadata: { turnOutcome: { ...receipt(turnId, refused), runId } } }, timestamp: '2026-09-30T10:00:00.000Z' };
      ledger.observeMessage(sent);
    }
    const entries = ledger.get(runId)!.turnOutcomes.map((entry) => entry.state === 'available' ? entry.receipt : 'conflict' as const);
    expect(project(entries)).toEqual({ turns: 2, refused: 3, failed: 0, coverage: 'complete' });

    // A request read from its transcript: one turn recorded before v0.9.91 makes the whole projection unavailable.
    const transcript = deserializeChatHistory([
      { role: 'agent', text: 'Old.', ts: 't', turnFinal: true },
      { role: 'agent', text: 'New.', ts: 't', turnFinal: true, turnOutcome: receipt('m-3', 0) },
    ]);
    expect(project(transcript.map((message) => message.turnOutcome))).toMatchObject({ coverage: 'unavailable' });
  });
});
