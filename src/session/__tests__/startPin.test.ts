import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler, BackendStartLaunch } from '../../backend/AgentBackend';
import type { AgentConfig } from '../../types';

/*
 * v0.9.97: a start says who asked for it, and the backend pins its CLI program by it. Only the person's own Start,
 * Restart or configuration edit chooses the program afresh (`take`); a message to a stopped agent, the restart after
 * a confirmed exit and a start queued behind the concurrency cap run the program the session is pinned to (`reuse`).
 */

class RecordingBackend implements AgentBackend {
  readonly agentId: string;
  pid = 99;
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig, private readonly launches: BackendStartLaunch['pin'][]) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void { this.handler = h; return () => (this.handler = undefined); }
  async start(_env: NodeJS.ProcessEnv, launch: BackendStartLaunch): Promise<void> { this.launches.push(launch.pin); this.alive = true; }
  sendUserTurn(): void { /* not needed */ }
  async stop(): Promise<{ stopped: true }> { this.alive = false; return { stopped: true }; }
  abort(): void { /* not needed */ }
  isAlive(): boolean { return this.alive; }
  emit(event: BackendEvent): void { this.handler?.(event); }
}

function makeConfig(id: string, extra: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id, name: id, role: 'custom', skill: '',
    provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' },
    model: 'deepseek-v4.1-flash', systemPrompt: '', autoApprove: true, allowedTools: [], ...extra,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('who asked for a start (v0.9.97 session pins)', () => {
  let manager: SessionManager | undefined;
  afterEach(() => { manager?.dispose(); manager = undefined; vi.useRealTimers(); });

  function setup(max = 5) {
    const launches: BackendStartLaunch['pin'][] = [];
    const backends: RecordingBackend[] = [];
    manager = new SessionManager(max, new MessageBus(), {
      createBackend: (config) => { const backend = new RecordingBackend(config, launches); backends.push(backend); return backend; },
      resolveEnv: async () => ({}),
    });
    return { launches, backends, sessions: manager };
  }

  it('passes the person\'s Start and Restart to the backend as take', async () => {
    const { launches, backends, sessions } = setup();
    sessions.create(makeConfig('dev'));
    await sessions.start('dev', { pin: 'take' });
    backends[0].emit({ kind: 'ready' });
    await sessions.restart('dev');
    expect(launches).toEqual(['take', 'take']);
  });

  it('starts a stopped agent for a message on its pinned program', async () => {
    const bus = new MessageBus();
    const launches: BackendStartLaunch['pin'][] = [];
    manager = new SessionManager(5, bus, {
      createBackend: (config) => new RecordingBackend(config, launches),
      resolveEnv: async () => ({}),
    });
    manager.create(makeConfig('dev'));
    bus.send('pm', 'dev', 'task.assign', { instruction: 'go' });
    await flush();
    expect(launches).toEqual(['reuse']);
  });

  it('restarts after a confirmed unexpected exit on the pinned program', async () => {
    vi.useFakeTimers();
    const { launches, backends, sessions } = setup();
    sessions.create(makeConfig('dev', { autoRestart: true }));
    await sessions.start('dev', { pin: 'take' });
    backends[0].emit({ kind: 'ready' });
    backends[0].emit({ kind: 'exit', code: 1, treeSeenStopped: true });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(launches).toEqual(['take', 'reuse']);
  });

  it('forgets a removed agent\'s pin', async () => {
    const cleared: string[] = [];
    manager = new SessionManager(5, new MessageBus(), {
      createBackend: (config) => new RecordingBackend(config, []),
      resolveEnv: async () => ({}),
      clearRuntimePin: (id) => { cleared.push(id); },
    });
    manager.create(makeConfig('dev'));
    await manager.remove('dev');
    expect(cleared).toEqual(['dev']);
  });

  it('keeps who asked for a start queued behind the concurrency cap', async () => {
    const { launches, backends, sessions } = setup(1);
    sessions.create(makeConfig('first'));
    sessions.create(makeConfig('second'));
    await sessions.start('first', { pin: 'take' });
    backends[0].emit({ kind: 'ready' });
    await sessions.start('second', { pin: 'take' });
    expect(launches).toEqual(['take']);
    await sessions.stop('first');
    await flush();
    expect(launches).toEqual(['take', 'take']);
  });
});
