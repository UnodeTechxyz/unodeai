import { describe, expect, it } from 'vitest';
import { SessionManager, type SessionManagerDeps } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler } from '../../backend/AgentBackend';
import type { BackgroundCompactionEvent } from '../../compaction/ContextCompactionCoordinator';
import type { AgentConfig, ContextMeterCompaction } from '../../types';

// v0.9.99 P6-UX: the meter the composer's ring draws carries what it fills toward and the background summary state.
class MeasuredBackend implements AgentBackend {
  readonly agentId: string;
  pid = 1;
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void { this.handler = h; return () => (this.handler = undefined); }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(): void { /* nothing */ }
  async stop(): Promise<void> { this.alive = false; this.emit({ kind: 'exit', code: 0 }); }
  abort(): void { /* nothing */ }
  isAlive(): boolean { return this.alive; }
  emit(e: BackendEvent): void { this.handler?.(e); }
  contextUsage() { return { tokens: 60_000, window: 1_000_000, ratio: 0.06, source: 'measured' as const }; }
}

const config: AgentConfig = {
  id: 'dev', name: 'Dev', role: 'senior-dev', skill: '', provider: { providerId: 'openai', apiKeySecretName: 'K' },
  model: 'm', systemPrompt: '', autoApprove: true, allowedTools: [], backend: 'openai-compat',
};

const event = (state: BackgroundCompactionEvent['state']): BackgroundCompactionEvent => ({
  agentId: 'dev', operationId: 'op1', state, elapsedMs: 0, estimatedInputTokens: 0, summaryRequests: 0,
  reportedInputTokens: 'unavailable', reportedOutputTokens: 'unavailable', usageCoverage: 'none', firstTokenMs: 'unavailable',
});

async function managerWith(compaction: Partial<NonNullable<SessionManagerDeps['compaction']>>): Promise<SessionManager> {
  const manager = new SessionManager(5, new MessageBus(), {
    createBackend: (agent) => new MeasuredBackend(agent),
    resolveEnv: async () => ({}),
    compaction: { run: async () => ({ kind: 'not-needed', reason: 'below-trigger' }), ...compaction },
  });
  manager.create(config);
  await manager.start('dev', { pin: 'take' });
  return manager;
}

describe('the context meter for the composer ring', () => {
  it('carries the policy the ring fills toward, asked with the measured window', async () => {
    const windows: unknown[] = [];
    const policy: ContextMeterCompaction = { mode: 'automatic', triggerTokens: 120_000 };
    const manager = await managerWith({ meterPolicy: (_agent, window) => { windows.push(window); return policy; } });
    expect(manager.contextMeter('dev')).toEqual({
      kind: 'usage', usage: { tokens: 60_000, window: 1_000_000, ratio: 0.06, source: 'measured' }, compaction: policy,
    });
    expect(windows).toEqual([{ tokens: 1_000_000, source: 'measured' }]);
    manager.dispose();
  });

  it('says unavailable, not an invented trigger, when the policy cannot be read', async () => {
    const manager = await managerWith({ meterPolicy: () => { throw new Error('no policy'); } });
    expect(manager.contextMeter('dev')).toMatchObject({ compaction: { mode: 'unavailable' } });
    manager.dispose();
  });

  it('shows a live background summary first, then how the last one ended, until a new one is prepared', async () => {
    let live: 'preparing' | 'ready' | undefined = 'preparing';
    const manager = await managerWith({ backgroundState: () => live });
    expect(manager.contextMeter('dev')).toMatchObject({ background: 'preparing' });
    live = undefined;
    expect(manager.contextMeter('dev')).not.toHaveProperty('background');
    for (const [state, shown] of [['applied', 'applied'], ['failed', 'failed'], ['cancelled', 'cancelled'], ['stale', 'not-applied'], ['not-applied', 'not-applied']] as const) {
      manager.noteBackgroundCompaction(event(state));
      expect(manager.contextMeter('dev')).toMatchObject({ background: shown });
    }
    manager.noteBackgroundCompaction(event('prepared'));
    expect(manager.contextMeter('dev')).not.toHaveProperty('background');
    manager.noteBackgroundCompaction(event('applied'));
    live = 'ready';
    expect(manager.contextMeter('dev')).toMatchObject({ background: 'ready' });
    manager.dispose();
  });
});

describe('the model the ring reads the trigger for (Codex’s audit of 3ca068c0, M1)', () => {
  it('is the configured model before any turn, then the model that served the latest turn', async () => {
    const asked: Array<string | undefined> = [];
    let backend: MeasuredBackend | undefined;
    const bus = new MessageBus();
    const manager = new SessionManager(5, bus, {
      createBackend: (agent) => (backend = new MeasuredBackend(agent)),
      resolveEnv: async () => ({}),
      resolveTaskModel: () => 'served-model-x',
      compaction: {
        run: async () => ({ kind: 'not-needed', reason: 'below-trigger' }),
        meterPolicy: (_agent, _window, servedModel) => { asked.push(servedModel); return { mode: 'off' }; },
      },
    });
    manager.create(config);
    await manager.start('dev', { pin: 'take' });
    backend!.emit({ kind: 'ready' });
    manager.contextMeter('dev');
    bus.send('user', 'dev', 'ask.question', { instruction: 'Go.', mode: 'act' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    manager.contextMeter('dev');
    expect(asked).toEqual([undefined, 'served-model-x']);
    manager.dispose();
  });
});
