import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler, LiveTurnResult } from '../../backend/AgentBackend';
import { parseRequestCloseoutRecord, type RequestCloseoutRecordV1, type RequestRunObservation } from '../../observability/RequestCloseout';
import type { AgentConfig, Message } from '../../types';

class FakeBackend implements AgentBackend {
  readonly agentId: string;
  pid = 1234;
  turns = 0;
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
  die(): void {
    this.alive = false;
    this.emit({ kind: 'exit', code: 1 });
  }
}

function makeConfig(id: string, role: AgentConfig['role']): AgentConfig {
  return {
    id, name: id, role, skill: '',
    provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' },
    model: 'deepseek-v4.1-flash', systemPrompt: '', autoApprove: true, allowedTools: [],
  };
}

const ok = { status: 'success' as const, observedBy: 'host' as const };
const NO_GRADES = { hostVerified: 0, nativeObserved: 0, uncertain: 0 };

/** v0.9.97: a host write read back as written, for the request the agent's turn has now, as the write policy tells it. */
function hostWrote(manager: SessionManager, agentId: string, path: string): void {
  manager.noteFileEffect(manager.currentRequestId(agentId), { path, key: path, operation: 'write', grade: 'host-verified' });
}
const reply = (overrides: Partial<LiveTurnResult> = {}): BackendEvent => ({
  kind: 'turn_complete',
  result: { text: 'done', isError: false, responseOutcome: { kind: 'reply' }, ...overrides },
});

describe('request closeout of a top-level turn', () => {
  let bus: MessageBus;
  let manager: SessionManager;
  let backends: Map<string, FakeBackend[]>;
  let records: RequestCloseoutRecordV1[];
  let runFacts: RequestRunObservation | undefined;
  let runQueries: Array<[string, string]>;
  const backend = (id: string) => backends.get(id)!.at(-1)!;
  const terminal = (from: string): Message[] => bus.query({}).filter((message) =>
    message.from === from && (message.type === 'task.complete' || message.type === 'task.partial' || message.type === 'system.error'));
  const closeoutOf = (message: Message) =>
    parseRequestCloseoutRecord((message.payload.metadata as { requestCloseout?: unknown } | undefined)?.requestCloseout);

  async function startTeam(): Promise<void> {
    bus = new MessageBus();
    backends = new Map();
    records = [];
    runFacts = undefined;
    runQueries = [];
    manager = new SessionManager(5, bus, {
      createBackend: (config) => {
        const created = new FakeBackend(config);
        backends.set(config.id, [...(backends.get(config.id) ?? []), created]);
        return created;
      },
      resolveEnv: async () => ({}),
      requestRunFacts: (sessionId, correlationId) => {
        runQueries.push([sessionId, correlationId]);
        return runFacts;
      },
      requestRunAgents: (runId) => (runId === 'run-1' ? ['dev', 'gone'] : []),
    });
    manager.on('session.requestCloseout', (event) => records.push(event.data.record));
    for (const [id, role] of [['dev', 'senior-dev'], ['pm', 'pm']] as Array<[string, AgentConfig['role']]>) {
      manager.create(makeConfig(id, role));
      await manager.start(id, { pin: 'take' });
      backend(id).emit({ kind: 'ready' });
    }
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T01:00:00.000Z'));
    await startTeam();
  });
  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  it('closes an answered turn into one record, carried by the turn\'s terminal message', () => {
    const request = bus.send('user', 'dev', 'ask.question', { instruction: 'what does this function do?', mode: 'act' });
    vi.advanceTimersByTime(4_000);
    backend('dev').emit(reply());

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toMatchObject({
      schemaVersion: 1,
      recordId: `request-closeout:${record.requestId}:${request.id}`,
      rootAgentId: 'dev',
      originTurnId: request.id,
      terminalTurnId: request.id,
      revision: 1,
      terminal: { kind: 'answered' },
      coverage: { events: 'complete', limited: [] },
    });
    expect(record.turnOutcome?.turnId).toBe(request.id);
    expect(record.timing?.durationMs).toBe(4_000);
    expect(record.observations.routes.agents).toEqual([{ agentId: 'dev', backend: 'unode', model: 'deepseek-v4.1-flash' }]);
    // The same value travels on the terminal message, and it is a record the parser accepts.
    expect(terminal('dev')).toHaveLength(1);
    expect(closeoutOf(terminal('dev')[0])).toEqual(record);
    // No reply text is in it.
    expect(JSON.stringify(record)).not.toContain('done');
  });

  it('records what the host observed during the turn and nothing the reply says', () => {
    bus.send('user', 'dev', 'ask.question', { instruction: 'fix the bug', mode: 'act' });
    const dev = backend('dev');
    dev.emit({ kind: 'reasoning_delta', delta: 'I should claim that all 12 checks passed.' });
    dev.emit({ kind: 'tool_use', callId: 'c1', name: 'write_file', input: { path: 'src/a.ts', content: 'secret body' } });
    hostWrote(manager, 'dev', 'src/a.ts');
    dev.emit({ kind: 'tool_result', callId: 'c1', name: 'write_file', outcome: ok, summary: 'wrote src/a.ts', detail: 'secret body' });
    dev.emit({ kind: 'tool_use', callId: 'c2', name: 'run_checks', input: {} });
    dev.emit({ kind: 'tool_result', callId: 'c2', name: 'run_checks', outcome: ok, summary: '[checks passed]' });
    manager.recordApprovalOutcome('dev', 1200, false, { decision: 'allowed', kind: 'write-approval' });
    manager.recordApprovalOutcome('dev', 300, true, { decision: 'denied', kind: 'command-approval' });
    dev.emit(reply({ text: 'Verified: 12/12 checks passed, 9 files changed, cost $0.' }));

    const [record] = records;
    expect(record.observations.changes).toEqual({
      coverage: 'complete',
      files: [{ path: 'src/a.ts', operation: 'write', evidence: 'host-verified' }],
      omitted: 0,
      droppedPaths: 0,
      grades: { ...NO_GRADES, hostVerified: 1 },
    });
    expect(record.observations.checks).toEqual({ coverage: 'complete', passed: 1, failed: 0, refused: 0 });
    expect(record.observations.approvals.decisions).toEqual([
      { kind: 'command-approval', allowed: 0, denied: 1, expired: 0 },
      { kind: 'write-approval', allowed: 1, denied: 0, expired: 0 },
    ]);
    expect(record.observations.reasoning).toEqual({ visibleItems: 1 });
    expect(record.turnOutcome?.tools).toMatchObject({ coverage: 'complete', total: 2, success: 2 });
    const text = JSON.stringify(record);
    for (const leaked of ['12/12', '9 files', 'secret body', 'I should claim', 'fix the bug']) expect(text).not.toContain(leaked);
  });

  it.each([
    ['a tool-only turn', { responseOutcome: { kind: 'tool-only' as const } }, { kind: 'tool-only' }],
    ['an empty reply', { text: '', responseOutcome: { kind: 'empty-reply' as const, attempts: [{ attempt: 1, gateway: 'unode', inputBasis: 'unavailable' as const }] } }, { kind: 'empty-reply' }],
    ['an error delivery', { isError: true, responseOutcome: { kind: 'error' as const } }, { kind: 'failed', failure: 'turn-error' }],
    ['a turn a host boundary stopped', { stop: { state: 'stopped' as const, reason: 'tool-round budget' } }, { kind: 'stopped' }],
    ['an unresolved turn', { unresolvedReason: 'no conclusion' }, { kind: 'failed', failure: 'turn-error' }],
  ])('types %s as what it is', (_name, result, expected) => {
    bus.send('user', 'dev', 'ask.question', { instruction: 'go', mode: 'act' });
    backend('dev').emit(reply(result as Partial<LiveTurnResult>));
    expect(records).toHaveLength(1);
    expect(records[0].terminal).toEqual(expected);
    expect(closeoutOf(terminal('dev')[0])).toEqual(records[0]);
  });

  it('closes a turn the person stops, with a stopped receipt and partial events', () => {
    const request = bus.send('user', 'dev', 'ask.question', { instruction: 'long task', mode: 'act' });
    backend('dev').emit({ kind: 'tool_use', callId: 'c1', name: 'run_command', input: { command: 'npm test' } });
    vi.advanceTimersByTime(3_000);
    manager.interrupt('dev');

    expect(records).toHaveLength(1);
    const [record] = records;
    // The record is frozen while the turn's origin is still held: it names the stopped turn, not nothing.
    expect(record.terminalTurnId).toBe(request.id);
    expect(record.terminal).toEqual({ kind: 'stopped' });
    expect(record.coverage.events).toBe('partial');
    expect(record.turnOutcome).toMatchObject({ turnId: request.id, delivery: { kind: 'stopped' }, tools: { coverage: 'partial', unmatchedUses: 1 } });
    const [stopMessage] = terminal('dev');
    const metadata = stopMessage.payload.metadata as Record<string, unknown>;
    expect(metadata.cancelled).toBe(true);
    expect(metadata.responseOutcome).toEqual({ kind: 'stopped' });
    expect(closeoutOf(stopMessage)).toEqual(record);
  });

  it('closes a turn whose process was lost as failed, with what was seen', () => {
    const request = bus.send('user', 'dev', 'ask.question', { instruction: 'go', mode: 'act' });
    backend('dev').die();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ terminalTurnId: request.id, terminal: { kind: 'failed', failure: 'process-lost' }, coverage: { events: 'partial' } });
    expect(closeoutOf(terminal('dev')[0])).toEqual(records[0]);
  });

  it('closes a coordinator attempt the first-action deadline ended as a host deadline', () => {
    const request = bus.send('user', 'pm', 'ask.question', { instruction: 'ship it', mode: 'act' });
    backend('pm').emit({ kind: 'model_request' });
    vi.advanceTimersByTime(61_000);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ rootAgentId: 'pm', terminalTurnId: request.id, terminal: { kind: 'host-deadline' }, coverage: { events: 'partial' } });
    expect(closeoutOf(terminal('pm')[0])).toEqual(records[0]);
  });

  it('gives a delegated turn no closeout of its own', () => {
    bus.send('pm', 'dev', 'task.assign', { instruction: 'review the diff' });
    backend('dev').emit(reply());
    expect(backend('dev').turns).toBe(1);
    expect(records).toEqual([]);
    expect(closeoutOf(terminal('dev')[0])).toBeUndefined();
  });

  it('gives a turn the host started its own record', () => {
    const wake = bus.send('unode', 'pm', 'ask.question', { instruction: 'A teammate returned a result.' });
    backend('pm').emit(reply());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ rootAgentId: 'pm', originTurnId: wake.id, terminalTurnId: wake.id });
  });

  it('takes the run of the turn from the run ledger, by the turn\'s own thread', () => {
    runFacts = {
      runId: 'run-1', state: 'open', tasks: { active: 1, settled: 0, cancelled: 0, interrupted: 0 },
      refusedDispatches: 1, policyRefused: 0, handles: ['h-1'], omittedHandles: 0,
    };
    const request = bus.send('user', 'pm', 'ask.question', { instruction: 'review this', mode: 'act' });
    backend('pm').emit({ kind: 'delegation_receipt', text: 'Delegations this turn: 1 accepted · 1 refused', receipt: { turn: 1, accepted: 1, refused: 1, pending: 0 } });
    backend('pm').emit(reply());
    expect(runQueries).toEqual([['pm', request.id]]);
    expect(records[0].observations.run).toEqual(runFacts);
    expect(records[0].observations.delegation).toEqual({ accepted: 1, refused: 1, pending: 0 });
    // The run's teammates stand beside the coordinator, each with its configured route; one no longer on the
    // team is named without a route.
    expect(records[0].observations.routes).toEqual({
      coverage: 'complete',
      agents: [
        { agentId: 'pm', backend: 'unode', model: 'deepseek-v4.1-flash' },
        { agentId: 'dev', backend: 'unode', model: 'deepseek-v4.1-flash' },
        { agentId: 'gone' },
      ],
      omitted: 0,
    });
  });

  it('survives a run ledger that throws: the record simply has no run', () => {
    manager.dispose();
    bus = new MessageBus();
    backends = new Map();
    records = [];
    manager = new SessionManager(5, bus, {
      createBackend: (config) => {
        const created = new FakeBackend(config);
        backends.set(config.id, [created]);
        return created;
      },
      resolveEnv: async () => ({}),
      requestRunFacts: () => { throw new Error('ledger gone'); },
    });
    manager.on('session.requestCloseout', (event) => records.push(event.data.record));
    manager.create(makeConfig('dev', 'senior-dev' as AgentConfig['role']));
    return manager.start('dev', { pin: 'take' }).then(() => {
      backend('dev').emit({ kind: 'ready' });
      bus.send('user', 'dev', 'ask.question', { instruction: 'go', mode: 'act' });
      backend('dev').emit(reply());
      expect(records).toHaveLength(1);
      expect(records[0].observations.run).toBeUndefined();
    });
  });

  it('gives each turn its own record and keeps nothing of the turn before', () => {
    const first = bus.send('user', 'dev', 'ask.question', { instruction: 'one', mode: 'act' });
    hostWrote(manager, 'dev', 'src/a.ts');
    backend('dev').emit(reply());
    const second = bus.send('user', 'dev', 'ask.question', { instruction: 'two', mode: 'act' });
    backend('dev').emit(reply());

    expect(records.map((record) => record.terminalTurnId)).toEqual([first.id, second.id]);
    expect(records[0].requestId).not.toBe(records[1].requestId);
    expect(records[1].observations.changes.files).toEqual([]);
    // A change noted while no top-level turn runs belongs to no record.
    hostWrote(manager, 'dev', 'src/b.ts');
    manager.interrupt('dev');
    expect(records).toHaveLength(2);
  });

  describe('whether a verification command was configured', () => {
    // v0.9.95: the card of a turn in which UnodeAi ran no verification says whether there was a command to run.
    // The host is asked as the turn closes, and the record keeps the answer of that moment.
    async function startWith(verificationConfigured: (sessionId: string) => boolean | undefined): Promise<void> {
      manager.dispose();
      bus = new MessageBus();
      backends = new Map();
      records = [];
      manager = new SessionManager(5, bus, {
        createBackend: (config) => {
          const created = new FakeBackend(config);
          backends.set(config.id, [created]);
          return created;
        },
        resolveEnv: async () => ({}),
        verificationConfigured,
      });
      manager.on('session.requestCloseout', (event) => records.push(event.data.record));
      manager.create(makeConfig('dev', 'senior-dev' as AgentConfig['role']));
      await manager.start('dev', { pin: 'take' });
      backend('dev').emit({ kind: 'ready' });
    }

    it('asks the host once, as the turn closes, and keeps that answer in the turn\'s record', async () => {
      let configured = true;
      const asked: string[] = [];
      await startWith((sessionId) => { asked.push(sessionId); return configured; });

      bus.send('user', 'dev', 'ask.question', { instruction: 'fix the bug', mode: 'act' });
      hostWrote(manager, 'dev', 'src/a.ts');
      // Nothing is asked while the turn runs.
      expect(asked).toEqual([]);
      backend('dev').emit(reply());
      expect(asked).toEqual(['dev']);
      expect(records[0].observations.checks).toEqual({ coverage: 'complete', passed: 0, failed: 0, refused: 0, verificationConfigured: true });
      expect(closeoutOf(terminal('dev')[0])).toEqual(records[0]);

      // The person clears the command afterwards. The record of the closed turn is as it was written; the
      // next turn keeps the answer of its own close.
      configured = false;
      bus.send('user', 'dev', 'ask.question', { instruction: 'and the other one', mode: 'act' });
      backend('dev').emit(reply());
      expect(asked).toEqual(['dev', 'dev']);
      expect(records.map((record) => record.observations.checks.verificationConfigured)).toEqual([true, false]);
    });

    it('keeps the answer for a turn the person stopped and for one whose process was lost', async () => {
      await startWith(() => false);
      bus.send('user', 'dev', 'ask.question', { instruction: 'long task', mode: 'act' });
      manager.interrupt('dev');
      expect(records).toHaveLength(1);
      expect(records[0].terminal).toEqual({ kind: 'stopped' });
      expect(records[0].observations.checks).toEqual({ coverage: 'partial', passed: 0, failed: 0, refused: 0, verificationConfigured: false });

      await startWith(() => true);
      bus.send('user', 'dev', 'ask.question', { instruction: 'go', mode: 'act' });
      backend('dev').die();
      expect(records).toHaveLength(1);
      expect(records[0].terminal).toEqual({ kind: 'failed', failure: 'process-lost' });
      expect(records[0].observations.checks.verificationConfigured).toBe(true);
    });

    it.each([
      ['does not know', () => undefined],
      ['throws', () => { throw new Error('settings gone'); }],
      ['answers with something that is no yes or no', () => 'yes' as unknown as boolean],
    ])('keeps the record, without the fact, when the host %s', async (_name, answer) => {
      await startWith(answer);
      bus.send('user', 'dev', 'ask.question', { instruction: 'go', mode: 'act' });
      backend('dev').emit(reply());
      expect(records).toHaveLength(1);
      expect(records[0].observations.checks).toEqual({ coverage: 'complete', passed: 0, failed: 0, refused: 0 });
      expect(closeoutOf(terminal('dev')[0])).toEqual(records[0]);
    });

    it('is answered by the extension from the command it gives that agent\'s run_checks', () => {
      // The extension cannot be loaded here, so its wiring is read: one function gives the team tools their
      // verification command and the closeout its answer.
      const extension = readFileSync(join(__dirname, '..', '..', 'extension.ts'), 'utf8').replace(/\r\n/g, '\n');
      expect(extension).toContain('      verifyCommandFor: verifyCommandForAgent,\n');
      expect(extension).toContain(
        '      verificationConfigured: (sessionId) => {\n'
        + '        const config = sessionManager.get(sessionId)?.config;\n'
        + '        return config ? verifyCommandForAgent(config).trim().length > 0 : undefined;\n'
        + '      },\n',
      );
      expect(extension.match(/function verifyCommandForAgent\(/g)).toHaveLength(1);
    });
  });
});
