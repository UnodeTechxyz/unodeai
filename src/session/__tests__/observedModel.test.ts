import { describe, expect, it } from 'vitest';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import { AgentBackend, BackendEvent, BackendEventHandler } from '../../backend/AgentBackend';
import { AgentConfig } from '../../types';

/*
 * v0.9.96: the model a CLI process says it runs is kept beside the requested one, for as long as that process runs.
 */

function config(id: string): AgentConfig {
  return {
    id, name: id, role: 'dev', skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-requested-1', systemPrompt: '', autoApprove: true, allowedTools: [], backend: 'claude',
  };
}

class CliBackend implements AgentBackend {
  readonly agentId: string;
  pid: number | undefined;
  private handler: BackendEventHandler | undefined;
  constructor(agentId: string, pid: number) { this.agentId = agentId; this.pid = pid; }
  onEvent(handler: BackendEventHandler): () => void { this.handler = handler; return () => { this.handler = undefined; }; }
  async start(): Promise<void> { this.emit({ kind: 'ready' }); }
  sendUserTurn(): void {}
  async stop(): Promise<void> { this.emit({ kind: 'exit', code: 0 }); }
  isAlive(): boolean { return true; }
  emit(event: BackendEvent): void { this.handler?.(event); }
}

function setup() {
  const backends: CliBackend[] = [];
  const manager = new SessionManager(5, new MessageBus(), {
    createBackend: (agent) => {
      const backend = new CliBackend(agent.id, 100 + backends.length);
      backends.push(backend);
      return backend;
    },
    resolveEnv: async () => ({}),
  });
  return { manager, backends };
}

describe('the model a CLI process reports (v0.9.96)', () => {
  it('is unknown until the process reports one, and never the requested model in its place', async () => {
    const { manager, backends } = setup();
    manager.create(config('dev'));
    await manager.start('dev', { pin: 'take' });
    expect(manager.get('dev')?.observedModel).toBeUndefined();
    backends[0].emit({ kind: 'model_observed', model: 'claude-remapped-1' });
    expect(manager.get('dev')).toMatchObject({ observedModel: 'claude-remapped-1', config: { model: 'claude-requested-1' } });
  });

  it('is kept across a second ready of the same process, and dropped with the process', async () => {
    const { manager, backends } = setup();
    manager.create(config('dev'));
    await manager.start('dev', { pin: 'take' });
    backends[0].emit({ kind: 'model_observed', model: 'claude-remapped-1' });
    backends[0].emit({ kind: 'ready' });
    expect(manager.get('dev')?.observedModel).toBe('claude-remapped-1');
    backends[0].emit({ kind: 'exit', code: 0 });
    expect(manager.get('dev')?.observedModel).toBeUndefined();
  });

  it('does not carry over to a new process', async () => {
    const { manager, backends } = setup();
    manager.create(config('dev'));
    await manager.start('dev', { pin: 'take' });
    backends[0].emit({ kind: 'model_observed', model: 'from-the-first-process' });
    await manager.restart('dev');
    expect(backends).toHaveLength(2);
    expect(manager.get('dev')?.observedModel).toBeUndefined();
  });
});
