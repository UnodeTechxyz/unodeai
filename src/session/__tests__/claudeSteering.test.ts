import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager, SpendSessionPort, STEER_QUEUED_NOTICE } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import { AgentBackend, BackendEvent, BackendEventHandler, TurnUsage, unreadSteerNotice } from '../../backend/AgentBackend';
import type { AgentConfig } from '../../types';

/*
 * v0.9.103 (the Owner, 2026-11-14; design draft 3 §3.7-§3.8): what SessionManager does with a message sent while an agent
 * works. A refused steer is queued and said once; the composer's confirmation belongs to one backend process; a Stop
 * names only the messages its backend has not read, before it is detached; and the stopped backend's usage-only
 * terminal settles the turn's usage unit once.
 */

class SteerBackend implements AgentBackend {
  readonly agentId: string;
  readonly turns: string[] = [];
  readonly interjected: string[] = [];
  accept = true;
  unread: string[] = [];
  readonly calls: string[] = [];
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig, private readonly withInterject = true) {
    this.agentId = config.id;
    if (!withInterject) (this as { interject?: unknown }).interject = undefined;
  }
  onEvent(h: BackendEventHandler): () => void { this.handler = h; return () => (this.handler = undefined); }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(instruction: string): void { this.turns.push(instruction); }
  interject(text: string): boolean { this.interjected.push(text); return this.accept; }
  unreadSteers(): string[] { this.calls.push('unreadSteers'); return [...this.unread]; }
  async stop(): Promise<void> { this.calls.push('stop'); this.alive = false; }
  isAlive(): boolean { return this.alive; }
  readonly pid = 777;
  emit(event: BackendEvent): void { this.handler?.(event); }
}

function config(id: string): AgentConfig {
  return {
    id, name: id, role: 'senior-dev', skill: '',
    provider: { providerId: 'claude-cli', apiKeySecretName: '' },
    model: 'claude-sonnet-4-5', systemPrompt: '', autoApprove: true, allowedTools: [], backend: 'claude',
  } as AgentConfig;
}

class RecordingSpend implements SpendSessionPort {
  calls: Array<[string, ...unknown[]]> = [];
  beginRequest(): void { /* not read here */ }
  beginUsageUnit(unit: { usageUnitId: string }): void { this.calls.push(['beginUsageUnit', unit.usageUnitId]); }
  noteModelRequest(usageUnitId: string): void { this.calls.push(['noteModelRequest', usageUnitId]); }
  noteUsageProgress(usageUnitId: string, progress: { attempt: number }): void { this.calls.push(['noteUsageProgress', usageUnitId, progress.attempt]); }
  settleUsageUnit(usageUnitId: string, usage: TurnUsage | undefined) { this.calls.push(['settleUsageUnit', usageUnitId, usage]); return undefined; }
  closeUsageUnit(usageUnitId: string): void { this.calls.push(['closeUsageUnit', usageUnitId]); }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('v0.9.103 SessionManager and a message sent while an agent works', () => {
  let manager: SessionManager | undefined;
  afterEach(() => { manager?.dispose(); manager = undefined; });

  async function setup(options: { withInterject?: boolean } = {}) {
    const bus = new MessageBus();
    const backends: SteerBackend[] = [];
    const spend = new RecordingSpend();
    const created = new SessionManager(5, bus, {
      createBackend: (c) => { const backend = new SteerBackend(c, options.withInterject !== false); backends.push(backend); return backend; },
      resolveEnv: async () => ({}),
      spend,
    });
    created.create(config('claude'));
    await created.start('claude', { pin: 'take' });
    backends[0].emit({ kind: 'ready' });
    manager = created;
    const notices: string[] = [];
    created.on('session.runtimeNotice', (event) => notices.push(event.data.text));
    const statusChanges: string[] = [];
    created.on('session.started', () => statusChanges.push('started'));
    bus.send('user', 'claude', 'ask.question', { instruction: 'Do the work.' });
    await flush();
    expect(created.get('claude')?.status).toBe('running');
    return { bus, backends, spend, sessions: created, notices, statusChanges };
  }

  it('a refused steer is queued and says once that it runs after this turn; an accepted one says nothing', async () => {
    const { backends, sessions, notices } = await setup();
    sessions.interjectAgent('claude', 'Steered in.');
    expect(backends[0].interjected).toEqual(['Steered in.']);
    expect(notices).toEqual([]);
    backends[0].accept = false;
    sessions.interjectAgent('claude', 'First queued.');
    sessions.interjectAgent('claude', 'Second queued.');
    expect(notices).toEqual([STEER_QUEUED_NOTICE, STEER_QUEUED_NOTICE]);
    expect(STEER_QUEUED_NOTICE).toBe('Your message will run after this turn.');
    // Both run, in order, as the following turns.
    backends[0].emit({ kind: 'turn_complete', result: { text: 'done', isError: false, responseOutcome: { kind: 'reply' } } });
    await flush();
    expect(backends[0].turns.at(-1)).toContain('First queued.');
  });

  it('a backend without interject is queued and said once as well', async () => {
    const { sessions, notices } = await setup({ withInterject: false });
    sessions.interjectAgent('claude', 'Queued.');
    expect(notices).toEqual([STEER_QUEUED_NOTICE]);
  });

  it('the confirmation is bound to the backend that observed it: set once, cleared at exit and on a new backend, never set by a stale one', async () => {
    const { backends, sessions, statusChanges } = await setup();
    expect(sessions.get('claude')?.steerConfirmed).toBeUndefined();
    const before = statusChanges.length;
    backends[0].emit({ kind: 'steer_support_observed' });
    expect(sessions.get('claude')?.steerConfirmed).toBe(true);
    expect(statusChanges.length).toBe(before + 1);
    backends[0].emit({ kind: 'steer_support_observed' });
    expect(statusChanges.length).toBe(before + 1);
    // Restart: a new backend has confirmed nothing, and the old one's late word does not confirm it.
    await sessions.restart('claude');
    await flush();
    expect(backends).toHaveLength(2);
    expect(sessions.get('claude')?.steerConfirmed).toBeUndefined();
    backends[0].emit({ kind: 'steer_support_observed' });
    expect(sessions.get('claude')?.steerConfirmed).toBeUndefined();
    backends[1].emit({ kind: 'ready' });
    backends[1].emit({ kind: 'steer_support_observed' });
    expect(sessions.get('claude')?.steerConfirmed).toBe(true);
    // The live process exits: its confirmation goes with it.
    backends[1].emit({ kind: 'exit', code: 1 });
    expect(sessions.get('claude')?.steerConfirmed).toBeUndefined();
  });

  it('Stop names each unread message once, asked before the backend is detached; its own later notice reaches nobody', async () => {
    const { backends, sessions, notices } = await setup();
    backends[0].unread = ['Second correction, never read.'];
    sessions.interrupt('claude');
    expect(backends[0].calls.indexOf('unreadSteers')).toBeLessThan(backends[0].calls.indexOf('stop'));
    expect(notices).toEqual([unreadSteerNotice('Second correction, never read.')]);
    expect(notices[0]).toBe('Your message was not delivered: the agent stopped before reading it. "Second correction, never read." Send it again if you still need it.');
    backends[0].emit({ kind: 'runtime_notice', text: 'late notice of a detached backend' });
    expect(notices).toHaveLength(1);
    expect(sessions.get('claude')?.status).toBe('stopped');
  });

  it('a Stop with every message read names none', async () => {
    const { backends, sessions, notices } = await setup();
    backends[0].unread = [];
    sessions.interrupt('claude');
    expect(notices).toEqual([]);
  });

  it('the stopped backend\'s usage-only terminal settles its unit once, with the reported cost, even when an exit follows', async () => {
    const { backends, sessions, spend } = await setup();
    backends[0].emit({ kind: 'model_request' });
    backends[0].emit({ kind: 'usage_progress', attempt: 1, inputTokens: 1_100, cachedInputTokens: 1_000, outputTokens: 16 });
    backends[0].emit({ kind: 'model_request' });
    sessions.interrupt('claude');
    const usage: TurnUsage = { inputTokens: 1_100, outputTokens: 16, cachedInputTokens: 1_000, costUsd: 0.123456,
      costBasis: 'api-equivalent', usageBasis: 'reported-partial', attributedAttempts: 1 };
    backends[0].emit({ kind: 'turn_complete', result: { text: '', isError: true, usage, responseOutcome: { kind: 'stopped' } } });
    backends[0].emit({ kind: 'exit', code: 1 });
    backends[0].emit({ kind: 'turn_complete', result: { text: 'late', isError: true, responseOutcome: { kind: 'error' } } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const settled = spend.calls.filter((call) => call[0] === 'settleUsageUnit');
    expect(settled).toHaveLength(1);
    expect(settled[0][2]).toEqual(usage);
    expect(spend.calls.filter((call) => call[0] === 'closeUsageUnit')).toEqual([]);
    expect(sessions.get('claude')?.status).toBe('stopped');
  });
});
