import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler } from '../../backend/AgentBackend';
import type { AgentConfig, Message } from '../../types';
import type { TaskAttemptCard } from '../../backend/TaskContract';
import { incrementalContract } from '../../backend/__tests__/checkpointFixtures';
import { CHECKPOINT_DUE_AFTER_MS, NO_RECOVERABLE_PRODUCT_AFTER_MS } from '../TaskCheckpointProgress';

/*
 * v0.9.97 L1: the host watches a task that delivers in batches for how long it goes without a saved batch. It only
 * observes: nothing it sees stops, extends, resends or starts anything.
 * Each test names the design sentence it realises (DESIGN_v0997 review resolution, sections 7.1 and 7.3).
 */

class ScriptedBackend implements AgentBackend {
  readonly agentId: string;
  readonly turns: string[] = [];
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; }
  onEvent(handler: BackendEventHandler): () => void {
    this.handler = handler;
    return () => (this.handler = undefined);
  }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(instruction: string): void { this.turns.push(instruction); }
  async stop(): Promise<void> { this.alive = false; }
  abort(): void { /* nothing to abort */ }
  isAlive(): boolean { return this.alive; }
  emit(event: BackendEvent): void { this.handler?.(event); }
}

function makeConfig(id: string): AgentConfig {
  return {
    id, name: id, role: 'custom', skill: '',
    provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' },
    model: 'deepseek-v4.1-flash', systemPrompt: '', autoApprove: true, allowedTools: [],
  };
}

const incremental = { attemptId: 'attempt-1', agentId: 'writer', contract: incrementalContract(), grants: [] } as unknown as TaskAttemptCard;
const single = { attemptId: 'attempt-2', agentId: 'writer', contract: incrementalContract({ delivery: undefined }), grants: [] } as unknown as TaskAttemptCard;

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('the host watches a task that delivers in batches (§7.1)', () => {
  let manager: SessionManager | undefined;
  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    vi.useRealTimers();
  });

  async function setup() {
    const bus = new MessageBus();
    const backends: ScriptedBackend[] = [];
    const sessions = new SessionManager(5, bus, {
      createBackend: (config) => {
        const backend = new ScriptedBackend(config);
        backends.push(backend);
        return backend;
      },
      resolveEnv: async () => ({}),
    });
    sessions.create(makeConfig('writer'));
    await sessions.start('writer', { pin: 'take' });
    backends[0].emit({ kind: 'ready' });
    manager = sessions;
    const statuses: Message[] = [];
    bus.onType('task.status', (message) => { statuses.push(message); });
    const workProduct: Array<{ attemptId: string; state?: string }> = [];
    sessions.on('session.workProduct', (event) => { workProduct.push(event.data as { attemptId: string; state?: string }); });
    return { bus, backend: () => backends[0], sessions, statuses, workProduct };
  }

  function assign(bus: MessageBus, handle: string, taskAttempt: TaskAttemptCard): void {
    bus.send('pm', 'writer', 'task.assign', { instruction: 'Draft the article.', taskAttempt }, 'high', handle);
  }

  it('watches the handle of a task dispatched for batches only, and only while its turn runs', async () => {
    const { bus, backend, sessions } = await setup();
    assign(bus, 'h-1', incremental);
    await flush();
    expect(sessions.checkpointProgressFor('writer', 'h-1')).toMatchObject({ attemptId: 'attempt-1', handle: 'h-1', state: 'on-track', batchesSaved: 0 });
    // Another handle of the same agent is not this task.
    expect(sessions.checkpointProgressFor('writer', 'h-other')).toBeUndefined();
    backend().emit({ kind: 'turn_complete', result: { text: 'done', isError: false } });
    await flush();
    expect(sessions.checkpointProgressFor('writer')).toBeUndefined();
    // A usage report that arrives late, after the turn ended, belongs to no task.
    backend().emit({ kind: 'generation_usage', source: 'claude-stream-message', unit: 'msg_late', outputTokens: 9_000 });
    expect(sessions.checkpointProgressFor('writer')).toBeUndefined();

    assign(bus, 'h-2', single);
    await flush();
    expect(sessions.checkpointProgressFor('writer')).toBeUndefined();
  });

  // §7.1: "token 计数来源、更新时点和估算标识必须显式".
  it('counts the generated tokens a backend reported, and says where they came from', async () => {
    const { bus, backend, sessions } = await setup();
    assign(bus, 'h-1', incremental);
    await flush();
    expect(sessions.checkpointProgressFor('writer', 'h-1')?.generated).toEqual({ status: 'unavailable' });
    backend().emit({ kind: 'generation_usage', source: 'openai-compatible-response', unit: 'response-1', outputTokens: 4_000, reasoningTokens: 3_000 });
    backend().emit({ kind: 'generation_usage', source: 'openai-compatible-response', unit: 'response-1', outputTokens: 4_000, reasoningTokens: 3_000 });
    backend().emit({ kind: 'generation_usage', source: 'openai-compatible-response', unit: 'response-2', outputTokens: 4_500 });
    expect(sessions.checkpointProgressFor('writer', 'h-1')).toMatchObject({
      state: 'checkpoint-due', dueReasons: ['generated-tokens'],
      generated: { status: 'reported', outputTokens: 8_500, reasoningTokens: 3_000, sources: ['openai-compatible-response'] },
    });
    expect(sessions.takeCheckpointDueNotice('attempt-1')).toMatch(/^\[host\] A batch is due: 8500 provider-reported output tokens/);
    expect(sessions.takeCheckpointDueNotice('attempt-1')).toBeUndefined();
    expect(sessions.noteTaskCheckpointSaved('attempt-1')).toBe(true);
    expect(sessions.checkpointProgressFor('writer', 'h-1')).toMatchObject({ state: 'on-track', batchesSaved: 1, generated: { sinceLastBatch: { outputTokens: 0 } } });
    expect(sessions.noteTaskCheckpointSaved('attempt-unknown')).toBe(false);
  });

  // §7.3: "这不自动授权 … 提高预算" / §7.1 "不因 checkpoint 自动续期": a save is not the observed action that renews a wait.
  it('reports a save as activity without the observed-action mark that renews a blocking wait', async () => {
    const { bus, backend, statuses } = await setup();
    assign(bus, 'h-1', incremental);
    await flush();
    statuses.length = 0;
    backend().emit({ kind: 'tool_use', callId: 'c1', name: `mcp__unode_files_${'a'.repeat(32)}__save_task_checkpoint`, input: { sequence: 1, section: 'intro', text: 'x' } });
    backend().emit({ kind: 'tool_use', callId: 'c2', name: 'save_task_checkpoint', input: { sequence: 2, section: 'body', text: 'y' } });
    backend().emit({ kind: 'tool_use', callId: 'c3', name: 'read_file', input: { path: 'a.txt' } });
    const progress = statuses.filter((message) => message.correlationId === 'h-1').map((message) => message.payload.metadata?.progress);
    expect(progress).toEqual([undefined, undefined, { source: 'tool', observed: true }]);
  });

  // §7.1: "不读推理文本 … 普通提示/配置阈值不能强制模型在隐藏推理中途吐正文" - a long reasoning step with no text.
  it('counts no token from reasoning text, and lets only time make a long silent reasoning step due', async () => {
    vi.useFakeTimers();
    const { bus, backend, sessions } = await setup();
    assign(bus, 'h-1', incremental);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 200; i++) backend().emit({ kind: 'reasoning_delta', delta: 'x'.repeat(1_000) });
    await vi.advanceTimersByTimeAsync(CHECKPOINT_DUE_AFTER_MS + 100);
    const snapshot = sessions.checkpointProgressFor('writer', 'h-1')!;
    expect(snapshot.generated).toEqual({ status: 'unavailable' });
    expect(snapshot).toMatchObject({ state: 'checkpoint-due', dueReasons: ['elapsed'] });
    // Nothing was injected into the running turn: one instruction, and the turn still runs.
    expect(backend().turns).toHaveLength(1);
    expect(sessions.get('writer')?.status).toBe('running');
  });

  // §7.1: "两分钟没有持久工作产品 … 四分钟仍无可读成果 … 待审批时间单列".
  it('falls due after two minutes of active time, leaves approval waits out, and says when no product exists at four', async () => {
    vi.useFakeTimers();
    const { bus, sessions, workProduct } = await setup();
    assign(bus, 'h-1', incremental);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(CHECKPOINT_DUE_AFTER_MS + 100);
    expect(sessions.checkpointProgressFor('writer', 'h-1')?.state).toBe('checkpoint-due');
    expect(workProduct).toEqual([{ attemptId: 'attempt-1', state: 'checkpoint-due' }]);

    sessions.approvalStarted('writer', 'approval-1');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const waiting = sessions.checkpointProgressFor('writer', 'h-1')!;
    expect(waiting.state).toBe('checkpoint-due');
    expect(waiting.approvalWaitMs).toBeGreaterThanOrEqual(10 * 60_000);
    expect(waiting.activeMsSinceProduct).toBeLessThan(NO_RECOVERABLE_PRODUCT_AFTER_MS);
    sessions.approvalFinished('writer', 'approval-1');

    await vi.advanceTimersByTimeAsync(NO_RECOVERABLE_PRODUCT_AFTER_MS - CHECKPOINT_DUE_AFTER_MS + 1_000);
    expect(sessions.checkpointProgressFor('writer', 'h-1')?.state).toBe('no-recoverable-product');
    expect(workProduct.at(-1)).toEqual({ attemptId: 'attempt-1', state: 'no-recoverable-product' });
    // Nothing was stopped, resent or started: the turn still runs, and the backend got one instruction.
    expect(sessions.get('writer')?.status).toBe('running');
  });
});
