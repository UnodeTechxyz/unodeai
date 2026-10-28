import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler, BackendStopOutcome } from '../../backend/AgentBackend';
import type { AgentConfig, Message } from '../../types';
import type { TaskAttemptCard } from '../../backend/TaskContract';

/*
 * v0.9.97 L0: a Stop ends the turn at once, and the process only when its backend saw the process tree end.
 * Field incident (2026-10-19): a stopped Claude CLI still called publish_task_artifact 26 s after Stop, and the same
 * agent was later started again by a new message while nothing had shown that the first process was gone.
 *
 * Each test names the design sentence it realises (DESIGN_v0997 review resolution, section 6).
 */

/** A backend whose stop resolves when the test says, with the outcome the test chooses. */
class ObservedStopBackend implements AgentBackend {
  readonly agentId: string;
  pid = 4321;
  readonly calls: string[];
  readonly turns: string[] = [];
  private handler?: BackendEventHandler;
  private alive = false;
  private finish?: (outcome: void | BackendStopOutcome) => void;
  private fail?: (error: Error) => void;
  constructor(config: AgentConfig, calls: string[]) { this.agentId = config.id; this.calls = calls; }
  onEvent(h: BackendEventHandler): () => void {
    this.handler = h;
    return () => (this.handler = undefined);
  }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(instruction: string): void { this.turns.push(instruction); }
  stop(): Promise<void | BackendStopOutcome> {
    this.calls.push(`stop:${this.agentId}`);
    return new Promise((resolve, reject) => { this.finish = resolve; this.fail = reject; });
  }
  abort(): void { this.calls.push(`abort:${this.agentId}`); }
  /** End the stop the session started, with what the backend observed. */
  endStop(outcome: void | BackendStopOutcome): void { this.alive = false; this.finish?.(outcome); }
  failStop(error: Error): void { this.fail?.(error); }
  isAlive(): boolean { return this.alive; }
  emit(e: BackendEvent): void { this.handler?.(e); }
}

function makeConfig(id: string): AgentConfig {
  return {
    id, name: id === 'writer' ? 'Content Strategist' : id, role: 'custom', skill: '',
    provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' },
    model: 'deepseek-v4.1-flash', systemPrompt: '', autoApprove: true, allowedTools: [],
  };
}

const attempt = { attemptId: 'attempt-old', agentId: 'writer' } as unknown as TaskAttemptCard;

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('a Stop ends the turn now and the process only on evidence (L0)', () => {
  let manager: SessionManager | undefined;
  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    vi.useRealTimers();
  });

  async function setup(extra: Partial<AgentConfig> = {}) {
    const bus = new MessageBus();
    const calls: string[] = [];
    const backends: ObservedStopBackend[] = [];
    const created = new SessionManager(5, bus, {
      createBackend: (config) => {
        const backend = new ObservedStopBackend(config, calls);
        backends.push(backend);
        calls.push(`create:${config.id}`);
        return backend;
      },
      resolveEnv: async () => ({}),
      endTaskAttempt: (attemptId) => calls.push(`end-attempt:${attemptId}`),
      forceStopProcessTree: async pid => { calls.push(`force-stop:${pid}`); },
    });
    created.create({ ...makeConfig('writer'), ...extra });
    await created.start('writer', { pin: 'take' });
    backends[0].emit({ kind: 'ready' });
    manager = created;
    return { bus, calls, backends, sessions: created };
  }

  function assign(bus: MessageBus, handle: string, withAttempt = true): Message {
    return bus.send('pm', 'writer', 'task.assign', {
      instruction: 'Draft the article.',
      ...(withAttempt ? { taskAttempt: attempt } : {}),
    }, 'high', handle);
  }

  it.each([true, false])('narrowing may persist after stop=%s while executable starts still require the existing evidence', async stopped => {
    const { sessions, backends } = await setup();
    const prepared = sessions.prepareToolRevocation('writer');
    const assertion = expect(prepared).resolves.toBeUndefined();
    await flush(); expect(backends[0].calls).toContain('stop:writer');
    backends[0].endStop({ stopped }); await assertion;
    expect(sessions.get('writer')?.status).toBe('stopped');
    expect(sessions.isStoppedForToolChange('writer')).toBe(stopped);
    if (!stopped) expect(sessions.get('writer')?.stopEvidence?.state).toBe('unconfirmed');
    expect(backends).toHaveLength(1);
  });

  // §6: "停止请求先使效果授权失效，再启动进程树清理".
  it('ends the stopped turn\'s task attempt before its backend is told to abort or stop', async () => {
    const { bus, calls, sessions } = await setup();
    assign(bus, 'h-old');
    await flush();
    expect(sessions.delegationExecution('writer', 'h-old')).toEqual({ state: 'running' });

    expect(sessions.cancelDelegation('writer', 'h-old', 'User stop.')).toBe(true);
    const order = calls.filter((call) => !call.startsWith('create'));
    expect(order).toEqual(['end-attempt:attempt-old', 'abort:writer', 'stop:writer']);
  });

  // §6: "只有实际停止证据才能显示 stopped，否则 stop-unconfirmed".
  it('shows a stopped turn as stopping, then stopped only when the backend saw its tree stop', async () => {
    const { bus, backends, sessions } = await setup();
    assign(bus, 'h-old');
    await flush();
    sessions.cancelDelegation('writer', 'h-old', 'User stop.');

    expect(sessions.get('writer')?.status).toBe('stopped');
    expect(sessions.get('writer')?.stopEvidence).toEqual({ state: 'stopping' });
    expect(sessions.delegationExecution('writer', 'h-old')).toEqual({ state: 'stopping' });

    backends[0].endStop({ stopped: true });
    await flush();
    expect(sessions.get('writer')?.stopEvidence).toBeUndefined();
    expect(sessions.delegationExecution('writer', 'h-old')).toEqual({ state: 'stopped' });
  });

  it('keeps an unobserved or failed stop as stop-unconfirmed, never stopped', async () => {
    const { bus, backends, sessions } = await setup();
    assign(bus, 'h-old');
    await flush();
    sessions.cancelDelegation('writer', 'h-old', 'User stop.');
    backends[0].endStop({ stopped: false, detail: 'process 4242 was still running' });
    await flush();
    expect(sessions.get('writer')?.stopEvidence).toEqual({ state: 'unconfirmed', detail: 'process 4242 was still running' });
    expect(sessions.delegationExecution('writer', 'h-old')).toEqual({ state: 'stop-unconfirmed', detail: 'process 4242 was still running' });

    const second = await setup();
    assign(second.bus, 'h-two');
    await flush();
    second.sessions.cancelDelegation('writer', 'h-two', 'User stop.');
    second.backends[0].failStop(new Error('taskkill could not run'));
    await flush();
    expect(second.sessions.get('writer')?.stopEvidence).toEqual({ state: 'unconfirmed', detail: 'its cleanup failed: taskkill could not run' });
    expect(second.sessions.delegationExecution('writer', 'h-two').state).toBe('stop-unconfirmed');
  });

  // §6: "否则 stop-unconfirmed 并阻止冲突重启".
  it('starts on demand after a settled unconfirmed stop without reusing its PID or rejecting queued work', async () => {
    const { bus, calls, backends, sessions } = await setup();
    assign(bus, 'h-old');
    await flush();
    sessions.cancelDelegation('writer', 'h-old', 'User stop.');
    backends[0].endStop({ stopped: false, detail: 'process 4242 was still running' });
    await flush();
    const refusals: Message[] = [];
    bus.onType('system.error', (message) => { if (message.correlationId === 'u-new') refusals.push(message); });

    // The user writes to the agent again: the host would start it on demand.
    bus.send('user', 'writer', 'ask.question', { instruction: 'please re-engage' }, 'normal', 'u-new');
    await flush();

    expect(calls.filter((call) => call.startsWith('create'))).toHaveLength(2);
    expect(calls).not.toContain('force-stop:4321');
    expect(sessions.get('writer')?.stopEvidence).toBeUndefined();
    expect(refusals).toHaveLength(0);
  });

  it('lets the person start the agent themselves once the unconfirmed stop was shown', async () => {
    const { bus, calls, backends, sessions } = await setup();
    assign(bus, 'h-old');
    await flush();
    sessions.cancelDelegation('writer', 'h-old', 'User stop.');
    backends[0].endStop({ stopped: false, detail: 'process 4242 was still running' });
    await flush();

    await sessions.start('writer', { pin: 'take' });
    expect(calls.filter((call) => call.startsWith('create'))).toHaveLength(2);
    expect(sessions.get('writer')?.stopEvidence).toBeUndefined();
    // The handle's own record still says what was observed of its stop.
    expect(sessions.delegationExecution('writer', 'h-old').state).toBe('stop-unconfirmed');
  });

  it('makes a start wait for a stop still under way, and starts only after it is confirmed', async () => {
    const { bus, calls, backends, sessions } = await setup();
    assign(bus, 'h-old');
    await flush();
    sessions.cancelDelegation('writer', 'h-old', 'User stop.');

    bus.send('user', 'writer', 'ask.question', { instruction: 'please re-engage' }, 'normal', 'u-new');
    await flush();
    expect(calls.filter((call) => call.startsWith('create'))).toHaveLength(1);

    backends[0].endStop({ stopped: true });
    await flush();
    expect(calls.filter((call) => call.startsWith('create'))).toHaveLength(2);
  });

  it('continues without a stale-PID kill when a stop it waited for settles unconfirmed', async () => {
    const { bus, calls, backends, sessions } = await setup();
    assign(bus, 'h-old');
    await flush();
    sessions.cancelDelegation('writer', 'h-old', 'User stop.');

    const starting = sessions.start('writer', { pin: 'take' });
    backends[0].endStop({ stopped: false, detail: 'the process list could not be read' });
    await starting;
    expect(calls).not.toContain('force-stop:4321');
    expect(calls.filter((call) => call.startsWith('create'))).toHaveLength(2);
  });

  it('treats a stop still under way after the wait as not confirmed', async () => {
    vi.useFakeTimers();
    const { bus, calls, sessions } = await setup();
    assign(bus, 'h-old');
    await vi.advanceTimersByTimeAsync(0);
    sessions.cancelDelegation('writer', 'h-old', 'User stop.');
    const starting = sessions.start('writer', { pin: 'take' });
    const settled = expect(starting).resolves.toMatchObject({ id: 'writer' });
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;
    expect(calls.filter((call) => call.startsWith('create'))).toHaveLength(2);
    expect(calls).toContain('force-stop:4321');
  });

  // §6: "cancel(handle) 只停止这个 attempt ... 不杀同 agent 后来的 turn".
  it('cancels an old handle only when it is the agent\'s own turn or queued, never a later turn', async () => {
    const { bus, calls, sessions } = await setup();
    bus.send('user', 'writer', 'ask.question', { instruction: 'please re-engage' }, 'normal', 'u-new');
    await flush();
    expect(sessions.delegationExecution('writer', 'u-new')).toEqual({ state: 'running' });
    expect(sessions.delegationExecution('writer', 'h-old')).toEqual({ state: 'not-running' });

    expect(sessions.cancelDelegation('writer', 'h-old', 'Stop the old draft.')).toBe(false);
    expect(calls.filter((call) => call.startsWith('abort') || call.startsWith('stop'))).toEqual([]);
    expect(sessions.get('writer')?.status).toBe('running');

    // A queued old assignment is removed from the queue, keeps no authority, and the running turn is not touched.
    assign(bus, 'h-queued');
    await flush();
    expect(sessions.delegationExecution('writer', 'h-queued')).toEqual({ state: 'queued' });
    expect(sessions.cancelDelegation('writer', 'h-queued', 'Stop it.')).toBe(true);
    expect(sessions.delegationExecution('writer', 'h-queued')).toEqual({ state: 'not-running' });
    expect(calls).toContain('end-attempt:attempt-old');
    expect(calls.filter((call) => call.startsWith('abort') || call.startsWith('stop'))).toEqual([]);
  });

  it('counts a backend that runs no outside process as stopped once its stop resolves', async () => {
    const { bus, backends, sessions } = await setup();
    assign(bus, 'h-old');
    await flush();
    sessions.cancelDelegation('writer', 'h-old', 'User stop.');
    backends[0].endStop(undefined);
    await flush();
    expect(sessions.delegationExecution('writer', 'h-old')).toEqual({ state: 'stopped' });
    expect(sessions.get('writer')?.stopEvidence).toBeUndefined();
  });

  /*
   * D11 (the Owner's ruling on Codex's recommendation, 2026-10-20): a CLI or App Server that ends by itself is an
   * unconfirmed stop unless its whole tree was seen to end. No automatic restart follows from it; the person may start
   * the agent after the unconfirmed stop was shown.
   */
  const ENDED_UNWATCHED = 'it ended by itself, and the processes it had started were not seen to end';

  it('records an unconfirmed crash honestly, then restarts without reusing the exited PID', async () => {
    vi.useFakeTimers();
    const { bus, calls, backends, sessions } = await setup({ autoRestart: true });
    assign(bus, 'h-old');
    await vi.advanceTimersByTimeAsync(0);
    // What a coordinator reading the turn's terminal receipt is told of its execution.
    const atReceipt: unknown[] = [];
    bus.onType('system.error', (message) => {
      if (message.correlationId === 'h-old') atReceipt.push(sessions.delegationExecution('writer', 'h-old'));
    });

    // The CLI dies; a child it started (not modelled) may still run.
    backends[0].emit({ kind: 'exit', code: 1 });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(atReceipt).toEqual([{ state: 'stop-unconfirmed', detail: ENDED_UNWATCHED }]);
    expect(calls.filter((call) => call.startsWith('create'))).toHaveLength(2);
    expect(calls).not.toContain('force-stop:4321');
    expect(sessions.get('writer')?.stopEvidence).toBeUndefined();
    expect(sessions.delegationExecution('writer', 'h-old')).toEqual({ state: 'stop-unconfirmed', detail: ENDED_UNWATCHED });

    // A message to the agent would start it on demand: refused while the stop is unconfirmed.
    bus.send('user', 'writer', 'ask.question', { instruction: 'please re-engage' }, 'normal', 'u-new');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((call) => call.startsWith('create'))).toHaveLength(2);
    expect(sessions.get('writer')?.errorMessage).toBeUndefined();
  });

  it('D11: restarts by itself, as configured, after an end whose whole tree the backend saw stop', async () => {
    vi.useFakeTimers();
    const { bus, calls, backends, sessions } = await setup({ autoRestart: true });
    assign(bus, 'h-old');
    await vi.advanceTimersByTimeAsync(0);

    backends[0].emit({ kind: 'exit', code: 1, treeSeenStopped: true });
    expect(sessions.get('writer')?.stopEvidence).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(calls.filter((call) => call.startsWith('create'))).toHaveLength(2);
    expect(sessions.delegationExecution('writer', 'h-old')).toEqual({ state: 'not-running' });
  });

  it('D11: lets the person start the agent after an unconfirmed end, through the shown unconfirmed stop', async () => {
    const { bus, calls, backends, sessions } = await setup();
    const output: string[] = [];
    sessions.on('session.output', (event) => { output.push(String((event.data as { content?: string }).content)); });
    assign(bus, 'h-old');
    await flush();
    backends[0].emit({ kind: 'exit', code: null });
    await flush();

    await sessions.start('writer', { pin: 'take' });
    expect(calls.filter((call) => call.startsWith('create'))).toHaveLength(2);
    expect(sessions.get('writer')?.stopEvidence).toBeUndefined();
    expect(output.join('\n')).toContain('old process ID will not be used');
    expect(calls).not.toContain('force-stop:4321');
    expect(sessions.delegationExecution('writer', 'h-old').state).toBe('stop-unconfirmed');
  });
  it.each(['start', 'team switch'] as const)('%s never kills a stale PID in an exit record', async action => {
    const { sessions, backends, calls } = await setup();
    backends[0].emit({ kind: 'exit', code: 1 }); await flush();
    const record = (sessions as any).stopRecords.get('writer');
    expect(record).toMatchObject({ state: 'unconfirmed' }); expect(record.pid).toBeUndefined();
    expect(sessions.get('writer')?.pid).toBeUndefined();
    // Simulate a pre-fix record: this must not be used as a fallback even when the old PID now names another app.
    record.pid = 998877;
    if (action === 'start') await sessions.start('writer', { pin: 'take' });
    else await sessions.prepareRosterReplacement();
    expect(calls.some(call => call.startsWith('force-stop:'))).toBe(false);
  });
  it('a host runtime notice reaches the chat event without ending a running request or becoming model output', async () => {
    const { sessions, backends, bus } = await setup(); assign(bus, 'h-notice'); await flush();
    const notices: unknown[] = []; const output: unknown[] = [];
    sessions.on('session.runtimeNotice', event => notices.push(event.data)); sessions.on('session.output', event => output.push(event.data));
    backends[0].emit({ kind: 'runtime_notice', text: 'Commands are disabled; choose Automatic or Ask each.' });
    expect(notices).toEqual([{ text: 'Commands are disabled; choose Automatic or Ask each.' }]);
    expect(output).toEqual([]); expect(sessions.get('writer')?.status).toBe('running');
    expect(sessions.delegationExecution('writer', 'h-notice')).toEqual({ state: 'running' });
  });
});
