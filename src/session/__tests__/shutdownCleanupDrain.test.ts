import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler } from '../../backend/AgentBackend';
import type { AgentConfig } from '../../types';

/*
 * v0.9.96: a Stop is a UI action and returns before its backend has wound down; the backend's cleanup (its
 * background commands' tree stops) goes on. When the host shuts down it waits for every such cleanup, also one an
 * earlier Stop detached, before the services that cleanup reports through are disposed.
 */

/** A backend whose stop ends only when the test says so, and says with which force timeout it was asked. */
class SlowStopBackend implements AgentBackend {
  readonly agentId: string;
  pid = 4321;
  readonly stops: number[] = [];
  private handler?: BackendEventHandler;
  private alive = false;
  private finishStop?: () => void;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(h: BackendEventHandler): () => void {
    this.handler = h;
    return () => (this.handler = undefined);
  }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(): void { /* not used */ }
  stop(forceTimeoutMs?: number): Promise<void> {
    this.stops.push(forceTimeoutMs ?? -1);
    return new Promise<void>((resolve) => { this.finishStop = () => { this.alive = false; resolve(); }; });
  }
  /** End the cleanup the last stop started. */
  endCleanup(): void { this.finishStop?.(); }
  abort(): void { /* the session ends the turn */ }
  isAlive(): boolean { return this.alive; }
  emit(e: BackendEvent): void { this.handler?.(e); }
}

function makeConfig(id: string): AgentConfig {
  return {
    id, name: id, role: 'senior-dev', skill: '',
    provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' },
    model: 'deepseek-v4.1-flash', systemPrompt: '', autoApprove: true, allowedTools: [],
  };
}

/** Whether a promise has settled, after the microtasks queued so far. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  return done;
}

describe('the host shutdown drains every backend cleanup', () => {
  let manager: SessionManager | undefined;
  let backends: Map<string, SlowStopBackend>;
  afterEach(() => {
    for (const backend of backends?.values() ?? []) backend.endCleanup();
    manager?.dispose();
    manager = undefined;
  });

  async function started(ids: string[]): Promise<SessionManager> {
    backends = new Map();
    const created = new SessionManager(5, new MessageBus(), {
      createBackend: (config) => {
        const backend = new SlowStopBackend(config);
        backends.set(config.id, backend);
        return backend;
      },
      resolveEnv: async () => ({}),
    });
    for (const id of ids) {
      created.create(makeConfig(id));
      await created.start(id, { pin: 'take' });
      backends.get(id)!.emit({ kind: 'ready' });
    }
    manager = created;
    return created;
  }

  it('keeps a Stop immediate while its cleanup goes on, and does not finish shutting down before that cleanup and each live one settle', async () => {
    const sessions = await started(['dev', 'qa']);
    const dev = backends.get('dev')!;
    const qa = backends.get('qa')!;

    // The person presses Stop on dev: the session is stopped at once, the backend's cleanup is still running.
    await sessions.stop('dev');
    expect(sessions.get('dev')?.status).toBe('stopped');
    expect(dev.stops).toHaveLength(1);

    // The host then shuts down: qa is stopped too, with the short force timeout, and the shutdown waits.
    const shutdown = sessions.shutdown();
    expect(sessions.get('qa')?.status).toBe('stopped');
    expect(qa.stops).toEqual([1500]);
    expect(await settled(shutdown)).toBe(false);

    // The live session's cleanup ends; the one dev's Stop detached earlier is still running, so it still waits.
    qa.endCleanup();
    expect(await settled(shutdown)).toBe(false);

    dev.endCleanup();
    expect(await settled(shutdown)).toBe(true);
  });

  it('a cleanup that fails is reported and counts as settled', async () => {
    const sessions = await started(['dev']);
    const dev = backends.get('dev')!;
    dev.stop = (forceTimeoutMs?: number) => { dev.stops.push(forceTimeoutMs ?? -1); return Promise.reject(new Error('tree stop failed')); };
    const said: string[] = [];
    sessions.on('session.output', (event) => { said.push(String((event.data as { content?: string }).content)); });

    await sessions.shutdown();
    expect(said).toContain('Background cleanup after Stop failed: tree stop failed');
  });

  it('the plain stopAll stays a UI stop: it returns before the cleanups end', async () => {
    const sessions = await started(['dev']);
    const all = sessions.stopAll();
    expect(await settled(all)).toBe(true);
    expect(backends.get('dev')!.stops).toEqual([10000]);
  });
});
