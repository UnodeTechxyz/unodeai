import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import { AgentBackend, BackendEvent, BackendEventHandler } from '../../backend/AgentBackend';
import { AgentConfig } from '../../types';

function config(id: string): AgentConfig {
  return {
    id,
    name: id,
    role: 'pm',
    skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-sonnet-4-5',
    systemPrompt: '',
    autoApprove: true,
    allowedTools: [],
    backend: 'claude',
  };
}

class ConsentBackend implements AgentBackend {
  readonly agentId: string;
  pid = 42;
  private handler: BackendEventHandler | undefined;
  private resolveDecision: (() => void) | undefined;
  private rejectDecision: ((error: Error) => void) | undefined;
  private alive = false;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  onEvent(handler: BackendEventHandler): () => void {
    this.handler = handler;
    return () => { this.handler = undefined; };
  }

  async start(): Promise<void> {
    // This acknowledgement is sent at the moment the host-owned modal is open, before the human
    // has answered.  It deliberately keeps this promise pending until allow/deny below.
    this.emit({
      kind: 'consent_required',
      message: 'Consent required to contact api.anthropic.com. Respond to the open UnodeAi network-consent dialog to continue this agent.',
    });
    await new Promise<void>((resolve, reject) => {
      this.resolveDecision = resolve;
      this.rejectDecision = reject;
    });
    this.alive = true;
    this.emit({ kind: 'ready' });
  }

  allow(): void { this.resolveDecision?.(); }
  deny(): void { this.rejectDecision?.(new Error('Network egress to api.anthropic.com was declined — no prompt or code was sent.')); }
  sendUserTurn(): void {}
  async stop(): Promise<void> { this.alive = false; this.emit({ kind: 'exit', code: 0 }); }
  isAlive(): boolean { return this.alive; }

  private emit(event: BackendEvent): void { this.handler?.(event); }
}

class ReadyBackend implements AgentBackend {
  readonly agentId: string;
  private handler: BackendEventHandler | undefined;

  constructor(agentId: string) { this.agentId = agentId; }
  onEvent(handler: BackendEventHandler): () => void { this.handler = handler; return () => { this.handler = undefined; }; }
  async start(): Promise<void> { this.handler?.({ kind: 'ready' }); }
  sendUserTurn(): void {}
  async stop(): Promise<void> { this.handler?.({ kind: 'exit', code: 0 }); }
  isAlive(): boolean { return true; }
}

function setup() {
  const backends = new Map<string, ConsentBackend | ReadyBackend>();
  const manager = new SessionManager(5, new MessageBus(), {
    createBackend: (agent) => {
      const backend = agent.id === 'consent' ? new ConsentBackend(agent.id) : new ReadyBackend(agent.id);
      backends.set(agent.id, backend);
      return backend;
    },
    resolveEnv: async () => ({}),
  });
  return { manager, backends };
}

describe('SessionManager egress-consent start lifecycle (B6)', () => {
  it('returns an actionable consent_required state instead of leaving an unanswered modal in starting', async () => {
    const { manager, backends } = setup();
    manager.create(config('consent'));

    const started = await manager.start('consent');

    expect(started.status).toBe('consent_required');
    expect(started.consentMessage).toContain('Respond to the open UnodeAi network-consent dialog');
    expect(manager.isRunning('consent')).toBe(true); // retains its concurrency slot while the decision is open
    expect(manager.getRunningCount()).toBe(1);
    expect(backends.get('consent')).toBeInstanceOf(ConsentBackend);
  });

  it('keeps the established rejected-consent outcome: terminal error, never a silent pending session', async () => {
    const { manager, backends } = setup();
    manager.create(config('consent'));
    await manager.start('consent');

    (backends.get('consent') as ConsentBackend).deny();

    await vi.waitFor(() => {
      expect(manager.get('consent')).toMatchObject({
        status: 'error',
        errorMessage: expect.stringContaining('declined'),
      });
    });
  });

  it('allows a slow-reading user to approve later and complete the same start', async () => {
    vi.useFakeTimers();
    try {
      const { manager, backends } = setup();
      manager.create(config('consent'));
      await manager.start('consent');

      // No human-decision timer exists.  Advancing a long time cannot turn a still-open consent into an error.
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(manager.get('consent')?.status).toBe('consent_required');

      (backends.get('consent') as ConsentBackend).allow();
      await Promise.resolve();
      await Promise.resolve();

      expect(manager.get('consent')).toMatchObject({ status: 'idle' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets startAll continue to the rest of the crew while the first agent awaits consent', async () => {
    const { manager } = setup();
    manager.create(config('consent'));
    manager.create(config('ready'));

    await manager.startAll();

    expect(manager.get('consent')?.status).toBe('consent_required');
    expect(manager.get('ready')?.status).toBe('idle');
  });
});
