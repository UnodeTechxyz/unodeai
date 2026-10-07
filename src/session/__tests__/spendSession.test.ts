import { beforeEach, describe, expect, it } from 'vitest';
import { SessionManager, SpendSessionPort } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import { AgentBackend, BackendEvent, BackendEventHandler, TurnAttachments, TurnUsage } from '../../backend/AgentBackend';
import { AgentConfig } from '../../types';
import { createTurnContextManifest } from '../TurnContextManifest';

/* v0.9.89 §4, §13.3: request identity, one usage unit per backend turn, and usage from a stopped backend. */

class FakeBackend implements AgentBackend {
  readonly agentId: string;
  turns: string[] = [];
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void { this.handler = h; return () => (this.handler = undefined); }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(instruction: string, _attachments?: TurnAttachments): void { this.turns.push(instruction); }
  async stop(): Promise<void> { this.alive = false; }
  abort(): void { /* the test decides what a stopped backend still reports */ }
  isAlive(): boolean { return this.alive; }
  emit(e: BackendEvent): void { this.handler?.(e); }
}

function config(id: string, role: string): AgentConfig {
  return {
    id, name: id, role: role as AgentConfig['role'], skill: '',
    provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' },
    model: 'm1', systemPrompt: '', autoApprove: true, allowedTools: [],
  };
}

type Call = [string, ...unknown[]];

class RecordingSpend implements SpendSessionPort {
  calls: Call[] = [];
  units = new Map<string, { requestId: string; agentId: string }>();
  beginRequest(requestId: string, rootAgentId: string): void { this.calls.push(['beginRequest', requestId, rootAgentId]); }
  beginUsageUnit(unit: { usageUnitId: string; requestId: string; agentId: string; modelId: string }): void {
    this.units.set(unit.usageUnitId, unit);
    this.calls.push(['beginUsageUnit', unit.usageUnitId, unit.requestId, unit.agentId, unit.modelId]);
  }
  noteModelRequest(usageUnitId: string): void { this.calls.push(['noteModelRequest', usageUnitId]); }
  noteUsageProgress(usageUnitId: string, progress: { attempt: number }): void { this.calls.push(['noteUsageProgress', usageUnitId, progress.attempt]); }
  settleUsageUnit(usageUnitId: string, usage: TurnUsage | undefined) {
    this.calls.push(['settleUsageUnit', usageUnitId, usage?.inputTokens]);
    return usage ? { costUsd: 0.25, costBasis: 'estimated' as const } : undefined;
  }
  closeUsageUnit(usageUnitId: string): void { this.calls.push(['closeUsageUnit', usageUnitId]); }
  requestOf(agentId: string): string[] {
    return [...this.units.values()].filter((unit) => unit.agentId === agentId).map((unit) => unit.requestId);
  }
}

describe('SessionManager spend identity', () => {
  let bus: MessageBus;
  let mgr: SessionManager;
  let backends: Map<string, FakeBackend>;
  let spend: RecordingSpend;

  beforeEach(async () => {
    bus = new MessageBus();
    backends = new Map();
    spend = new RecordingSpend();
    mgr = new SessionManager(5, bus, {
      createBackend: (c) => { const b = new FakeBackend(c); backends.set(c.id, b); return b; },
      resolveEnv: async () => ({}),
      spend,
    });
    for (const [id, role] of [['pm', 'pm'], ['dev', 'senior-dev']]) {
      mgr.create(config(id, role));
      await mgr.start(id);
      backends.get(id)!.emit({ kind: 'ready' });
    }
  });

  it('gives each top-level user request a new id and one usage unit per backend turn', () => {
    bus.send('user', 'pm', 'task.assign', { instruction: 'first' });
    backends.get('pm')!.emit({ kind: 'model_request' });
    backends.get('pm')!.emit({ kind: 'model_request' });
    backends.get('pm')!.emit({ kind: 'turn_complete', result: { text: 'ok', isError: false, usage: { inputTokens: 5, outputTokens: 1 } } });
    bus.send('user', 'pm', 'task.assign', { instruction: 'second' });
    const [first, second] = spend.requestOf('pm');
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
    const unitCalls = spend.calls.filter((call) => call[0] === 'beginUsageUnit');
    expect(unitCalls).toHaveLength(2);
    expect(spend.calls.filter((call) => call[0] === 'noteModelRequest' && call[1] === unitCalls[0][1])).toHaveLength(2);
    expect(spend.calls).toContainEqual(['settleUsageUnit', unitCalls[0][1], 5]);
    // The legacy projection comes from the coordinator's pinned source, not a hidden table.
    expect(mgr.get('pm')!.usage).toMatchObject({ costUsd: 0.25, costBasis: 'estimated', turns: 1 });
  });

  it('lets delegated work inherit the request that dispatched it, even when queued', () => {
    bus.send('user', 'pm', 'task.assign', { instruction: 'lead' });
    const [request] = spend.requestOf('pm');
    // dev is busy with something else first, so the delegation queues.
    bus.send('user', 'dev', 'task.assign', { instruction: 'own work' });
    bus.send('pm', 'dev', 'task.assign', { instruction: 'delegated' }, 'normal', 'handle-1');
    backends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
    const devRequests = spend.requestOf('dev');
    expect(devRequests).toHaveLength(2);
    expect(devRequests[1]).toBe(request);
    expect(devRequests[0]).not.toBe(request);
  });

  it('continues the delegating request in an async-result wake', async () => {
    bus.send('user', 'pm', 'task.assign', { instruction: 'lead' });
    const [request] = spend.requestOf('pm');
    bus.send('pm', 'dev', 'task.assign', { instruction: 'delegated' }, 'normal', 'handle-7');
    backends.get('pm')!.emit({ kind: 'turn_complete', result: { text: 'dispatched', isError: false } });
    backends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'result', isError: false } });
    mgr.queueAsyncDelegationWake('pm', { handle: 'handle-7', ref: 'dev', text: 'result' }, () => true, () => true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(spend.requestOf('pm')).toEqual([request, request]);
  });

  it('keeps a stopped backend\'s late usage and closes it once', () => {
    bus.send('user', 'dev', 'task.assign', { instruction: 'work' });
    backends.get('dev')!.emit({ kind: 'model_request' });
    const stopped = backends.get('dev')!;
    const unit = spend.calls.find((call) => call[0] === 'beginUsageUnit')![1];
    mgr.interrupt('dev');
    // The detached backend still reports the cut-off turn: it is settled, not dropped.
    stopped.emit({ kind: 'usage_progress', attempt: 1, inputTokens: 10, outputTokens: 2 });
    stopped.emit({ kind: 'turn_complete', result: { text: '[Stopped by user]', isError: true, usage: { inputTokens: 12, outputTokens: 3, usageBasis: 'reported-partial' } } });
    stopped.emit({ kind: 'turn_complete', result: { text: 'again', isError: true, usage: { inputTokens: 99, outputTokens: 9 } } });
    expect(spend.calls.filter((call) => call[1] === unit).map((call) => call[0])).toEqual([
      'beginUsageUnit', 'noteModelRequest', 'noteUsageProgress', 'settleUsageUnit',
    ]);
    // No transcript effect: the session stays stopped and shows no second completion.
    expect(mgr.get('dev')!.status).toBe('stopped');
  });

  it('still settles a stopped turn whose usage arrives just after the backend reported exit', async () => {
    bus.send('user', 'dev', 'task.assign', { instruction: 'work' });
    backends.get('dev')!.emit({ kind: 'model_request' });
    const stopped = backends.get('dev')!;
    const unit = spend.calls.find((call) => call[0] === 'beginUsageUnit')![1];
    mgr.interrupt('dev');
    stopped.emit({ kind: 'exit', code: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    stopped.emit({ kind: 'turn_complete', result: { text: '[Stopped by user]', isError: true, usage: { inputTokens: 7, outputTokens: 1, usageBasis: 'reported-partial' } } });
    expect(spend.calls.filter((call) => call[1] === unit).map((call) => call[0])).toEqual([
      'beginUsageUnit', 'noteModelRequest', 'settleUsageUnit',
    ]);
  });

  it('turns a dead process\'s running turn into a coverage gap', () => {
    bus.send('user', 'dev', 'task.assign', { instruction: 'work' });
    backends.get('dev')!.emit({ kind: 'model_request' });
    const unit = spend.calls.find((call) => call[0] === 'beginUsageUnit')![1];
    backends.get('dev')!.emit({ kind: 'exit', code: 1 });
    expect(spend.calls).toContainEqual(['closeUsageUnit', unit]);
  });

  it('stops only the live turns of one request', () => {
    bus.send('user', 'pm', 'task.assign', { instruction: 'lead' });
    const [request] = spend.requestOf('pm');
    bus.send('pm', 'dev', 'task.assign', { instruction: 'delegated' }, 'normal', 'handle-2');
    expect(mgr.stopRequest('unknown-request')).toBe(0);
    expect(mgr.stopRequest(request)).toBe(2);
    expect(mgr.get('pm')!.status).toBe('stopped');
    expect(mgr.get('dev')!.status).toBe('stopped');
    expect(mgr.stopRequest(request)).toBe(0);
  });

  // Field finding F7: Codex reports ready again at every thread/resume, inside a running turn.
  it('keeps a Codex teammate that reports ready mid-turn running, so Stop this request still reaches it', () => {
    bus.send('user', 'pm', 'task.assign', { instruction: 'lead' });
    const [request] = spend.requestOf('pm');
    bus.send('pm', 'dev', 'task.assign', { instruction: 'delegated' }, 'normal', 'handle-3');
    backends.get('pm')!.emit({ kind: 'turn_complete', result: { text: 'dispatched', isError: false } });
    backends.get('dev')!.emit({ kind: 'ready', backendSessionId: 'thread-1' });
    backends.get('dev')!.emit({ kind: 'model_request' });
    expect(mgr.get('dev')!.status).toBe('running');
    expect(mgr.get('dev')!.backendSessionId).toBe('thread-1');
    expect(mgr.stopRequest(request)).toBe(1);
    expect(mgr.get('dev')!.status).toBe('stopped');
  });

  it('hands a teammate its next queued task only when the running one ends, not on a mid-turn ready', () => {
    bus.send('user', 'dev', 'task.assign', { instruction: 'first' });
    bus.send('user', 'dev', 'task.assign', { instruction: 'second' });
    backends.get('dev')!.emit({ kind: 'ready', backendSessionId: 'thread-1' });
    expect(backends.get('dev')!.turns).toEqual(['first']);
    backends.get('dev')!.emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
    expect(backends.get('dev')!.turns).toEqual(['first', 'second']);
  });

  it('reports a request as running exactly while Stop this request would find a turn (field finding F9)', () => {
    bus.send('user', 'pm', 'task.assign', { instruction: 'lead' });
    const [request] = spend.requestOf('pm');
    bus.send('pm', 'dev', 'task.assign', { instruction: 'delegated' }, 'normal', 'handle-4');
    backends.get('pm')!.emit({ kind: 'turn_complete', result: { text: 'dispatched', isError: false } });
    expect(mgr.requestRunning(request)).toBe(true);
    expect(mgr.requestRunning('unknown-request')).toBe(false);
    mgr.interrupt('dev');
    // The stopped teammate's final usage report arrives after this point; the request is no longer running.
    expect(mgr.requestRunning(request)).toBe(false);
    expect(mgr.stopRequest(request)).toBe(0);
  });

  it('never lets a spend failure reach the turn', () => {
    const throwing = new SessionManager(5, new MessageBus(), {
      createBackend: (c) => new FakeBackend(c),
      resolveEnv: async () => ({}),
      spend: { ...spend, beginUsageUnit: () => { throw new Error('boom'); } } as unknown as SpendSessionPort,
    });
    expect(() => throwing.create(config('x', 'senior-dev'))).not.toThrow();
  });
});

describe('read-root guidance (v0.9.89 field fix)', () => {
  it('reaches the turn context and its manifest, and grants nothing', async () => {
    const bus = new MessageBus();
    const attachments: Array<TurnAttachments | undefined> = [];
    const mgr = new SessionManager(5, bus, {
      createBackend: (c) => {
        const backend = new FakeBackend(c);
        const send = backend.sendUserTurn.bind(backend);
        backend.sendUserTurn = (instruction, attached) => { attachments.push(attached); send(instruction, attached); };
        return backend;
      },
      resolveEnv: async () => ({}),
      getProjectContext: () => 'Project rules.',
      getTurnContextManifest: () => createTurnContextManifest([]),
      readScopeGuidance: () => '## Local read reach (host setting)\nnot granted yet',
    });
    mgr.create(config('dev', 'senior-dev'));
    await mgr.start('dev');
    const backend = (mgr as unknown as { backends: Map<string, FakeBackend> }).backends.get('dev')!;
    backend.emit({ kind: 'ready' });
    bus.send('user', 'dev', 'task.assign', { instruction: 'look around' });
    expect(attachments[0]?.projectContext).toBe('Project rules.\n\n## Local read reach (host setting)\nnot granted yet');
  });
});
