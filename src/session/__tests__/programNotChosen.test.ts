import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEventHandler } from '../../backend/AgentBackend';
import type { AgentConfig } from '../../types';
import { CliStartRefused, NO_PROGRAM_TEXT } from '../../host/cliRuntimeResolver';

// v0.9.106 retest R3 rerun: the person closed the "An agent needs a Codex CLI to start" list (Keep current CLI). The
// start was refused, the agent was marked `error`, and every later dispatch from the PM was refused with "connection
// status is error", so only a manual Start could ask again. A start refused only because no program is chosen now
// leaves the agent stopped: the refusal still reaches its chat and the queued turn, and the next request starts it
// again. Every other start failure still blocks the agent.

function config(id: string): AgentConfig {
  return {
    id, name: id, role: 'reviewer', skill: '',
    provider: { providerId: 'codex-cli', apiKeySecretName: '' },
    model: 'codex-cli-default', systemPrompt: '', autoApprove: true, allowedTools: [], backend: 'codex',
  } as AgentConfig;
}

class RefusingBackend implements AgentBackend {
  private handler: BackendEventHandler | undefined;
  constructor(readonly agentId: string, private readonly refusal: Error) {}
  onEvent(handler: BackendEventHandler): () => void { this.handler = handler; return () => { this.handler = undefined; }; }
  async start(): Promise<void> { throw this.refusal; }
  sendUserTurn(): void {}
  async stop(): Promise<void> { this.handler?.({ kind: 'exit', code: 0 }); }
  isAlive(): boolean { return false; }
}

class ReadyBackend implements AgentBackend {
  private handler: BackendEventHandler | undefined;
  constructor(readonly agentId: string) {}
  onEvent(handler: BackendEventHandler): () => void { this.handler = handler; return () => { this.handler = undefined; }; }
  async start(): Promise<void> { this.handler?.({ kind: 'ready' }); }
  sendUserTurn(): void {}
  async stop(): Promise<void> { this.handler?.({ kind: 'exit', code: 0 }); }
  isAlive(): boolean { return true; }
}

function setup(refusals: Error[]) {
  const bus = new MessageBus();
  const starts: string[] = [];
  const errors: string[] = [];
  const notChosen: boolean[] = [];
  const manager = new SessionManager(5, bus, {
    createBackend: (agent) => {
      const refusal = refusals.shift();
      starts.push(refusal ? `refused: ${refusal.message}` : 'ready');
      return refusal ? new RefusingBackend(agent.id, refusal) : new ReadyBackend(agent.id);
    },
    resolveEnv: async () => ({}),
  });
  manager.on('session.error', (event) => {
    errors.push(String(event.data?.error));
    notChosen.push(event.data?.programNotChosen === true);
  });
  manager.create(config('reviewer'));
  return { bus, manager, starts, errors, notChosen };
}

describe('v0.9.106: a start refused because no CLI program is chosen leaves the agent startable', () => {
  it('a message to it starts it; refused, it is stopped, not blocked, and the refusal reaches the queued turn; the next message starts it again', async () => {
    const { bus, manager, starts, errors, notChosen } = setup([new CliStartRefused('program-not-chosen', NO_PROGRAM_TEXT['codex-cli'])]);
    // The PM's dispatch: a message to the stopped teammate, which starts it.
    const first = bus.send('pm', 'reviewer', 'ask.question', { instruction: 'Review add.js.' });
    await vi.waitFor(() => expect(bus.query({ type: 'system.error' }).some((m) => m.correlationId === first.id)).toBe(true));

    expect(manager.get('reviewer')).toMatchObject({ status: 'stopped' });
    expect(manager.get('reviewer')?.errorMessage).toBeUndefined();
    expect(errors[0]).toBe(NO_PROGRAM_TEXT['codex-cli']);
    // NC-1: the start's own event says why, so the host offers Open Settings once for this refusal. (The on-demand
    // start's caller reports the same failure again, without the flag.)
    expect(notChosen[0]).toBe(true);
    expect(notChosen.filter(Boolean)).toHaveLength(1);
    const refusal = bus.query({ type: 'system.error' }).find((message) => message.correlationId === first.id);
    expect(refusal?.payload).toMatchObject({ instruction: NO_PROGRAM_TEXT['codex-cli'], metadata: { isError: true, startRefused: true } });

    // The next dispatch starts it again (here the program is chosen, so it starts).
    bus.send('pm', 'reviewer', 'ask.question', { instruction: 'Review add.js again.' });
    await vi.waitFor(() => expect(starts).toEqual([`refused: ${NO_PROGRAM_TEXT['codex-cli']}`, 'ready']));
    await vi.waitFor(() => expect(manager.get('reviewer')?.status).not.toBe('starting'));
    expect(manager.get('reviewer')?.status).not.toBe('error');
  });

  it('any other refused start still blocks the agent with its message', async () => {
    for (const refusal of [
      new CliStartRefused('program-unavailable', 'UnodeAi found no claude.cmd on PATH.'),
      new CliStartRefused('adoption-declined', 'Not now.'),
      new Error('Network egress to chatgpt.com was declined — no prompt or code was sent.'),
    ]) {
      const { manager, notChosen } = setup([refusal]);
      const { errors } = (() => ({ errors: [] as string[] }))();
      manager.on('session.error', (event) => { errors.push(String(event.data?.error)); });
      await manager.start('reviewer', { pin: 'take' }).catch(() => undefined);
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(notChosen).toEqual([false]);
      expect(manager.get('reviewer')).toMatchObject({ status: 'error', errorMessage: refusal.message });
    }
  });
});
