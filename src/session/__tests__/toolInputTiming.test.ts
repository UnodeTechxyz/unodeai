import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnTimingTracker, parseTurnTimingPhases } from '../TurnTiming';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import type { AgentBackend, BackendEvent, BackendEventHandler, TurnAttachments } from '../../backend/AgentBackend';
import type { AgentConfig } from '../../types';
import { createTurnContextManifest } from '../TurnContextManifest';

// v0.9.99 P7: the live line shows the call being written and how much has arrived, and the timing record keeps
// "writing the tool call" apart from "running the tool".
function clock(start = 10_000) {
  const state = { now: start };
  return { state, tracker: new TurnTimingTracker(() => state.now) };
}

describe('tool input in the turn clock', () => {
  it('keeps the latest progress of the call being written, and drops it once the model does something else', () => {
    const { tracker } = clock(); tracker.begin('pm', undefined); tracker.modelRequest('pm');
    tracker.providerActivity('pm', 'tool-input', { tool: 'write_file', bytes: 10 });
    expect(tracker.snapshot('pm')).toMatchObject({ preparingTool: true, toolInput: { tool: 'write_file', bytes: 10 } });
    tracker.providerActivity('pm', 'tool-input');
    expect(tracker.snapshot('pm')?.toolInput).toEqual({ tool: 'write_file', bytes: 10 });
    tracker.providerActivity('pm', 'tool-input', { tool: 'write_file', target: 'a.ts', bytes: 4_000 });
    expect(tracker.snapshot('pm')?.toolInput).toEqual({ tool: 'write_file', target: 'a.ts', bytes: 4_000 });
    tracker.toolStarted('pm', 'call-1');
    expect(tracker.snapshot('pm')?.toolInput).toBeUndefined();
    tracker.toolFinished('pm', 'call-1');
    tracker.providerActivity('pm', 'output');
    expect(tracker.snapshot('pm')).toMatchObject({ preparingTool: false });
    expect(tracker.snapshot('pm')?.toolInput).toBeUndefined();
  });

  it('records the time spent writing tool calls apart from the time the tools ran', () => {
    const { state, tracker } = clock(0); tracker.begin('pm', undefined); tracker.modelRequest('pm');
    state.now = 1_000; tracker.providerActivity('pm', 'tool-input', { tool: 'write_file', bytes: 1 });
    state.now = 61_000; tracker.toolStarted('pm', 'call-1');
    state.now = 61_400; tracker.toolFinished('pm', 'call-1');
    state.now = 62_000;
    const timing = tracker.finish('pm')!;
    expect(timing.phases?.preparingToolMs).toBe(60_000);
    expect(timing.phases?.toolMs).toBe(400);
    // A part of the provider time: the six buckets still add up to the turn.
    const p = timing.phases!;
    expect(p.queuedMs + p.hostMs + p.providerWaitMs + p.reasoningMs + p.respondingMs + p.toolMs + (p.compactingMs ?? 0)).toBe(timing.durationMs);
    expect(parseTurnTimingPhases(p, timing.durationMs)).toEqual(p);
  });

  it('reads it back only when it fits inside the provider time; older records have none', () => {
    const phases = { queuedMs: 0, hostMs: 0, providerWaitMs: 5_000, reasoningMs: 1_000, respondingMs: 1_000, toolMs: 3_000,
      providerWaitCount: 1, longestProviderWaitMs: 5_000 };
    expect(parseTurnTimingPhases({ ...phases, preparingToolMs: 7_000 }, 10_000)?.preparingToolMs).toBe(7_000);
    expect(parseTurnTimingPhases({ ...phases, preparingToolMs: 7_001 }, 10_000)).toEqual(phases);
    expect(parseTurnTimingPhases({ ...phases, preparingToolMs: -1 }, 10_000)).toEqual(phases);
    expect(parseTurnTimingPhases(phases, 10_000)).not.toHaveProperty('preparingToolMs');
  });
});

class FakeBackend implements AgentBackend {
  readonly agentId: string;
  pid = 1;
  streamsToolInput?: false;
  private handler?: BackendEventHandler;
  private alive = false;
  constructor(config: AgentConfig) { this.agentId = config.id; if (config.backend === 'codex') this.streamsToolInput = false; }
  onEvent(h: BackendEventHandler): () => void { this.handler = h; return () => (this.handler = undefined); }
  async start(): Promise<void> { this.alive = true; }
  sendUserTurn(_instruction: string, _attachments?: TurnAttachments): void { /* the test drives events */ }
  async stop(): Promise<void> { this.alive = false; }
  abort(): void { /* nothing */ }
  isAlive(): boolean { return this.alive; }
  emit(e: BackendEvent): void { this.handler?.(e); }
}

describe('the live line while a large file is written', () => {
  afterEach(() => { vi.useRealTimers(); });

  async function oneAgent(backend: 'openai-compat' | 'codex') {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T08:00:00.000Z'));
    const bus = new MessageBus();
    let created: FakeBackend | undefined;
    const manager = new SessionManager(5, bus, {
      createBackend: (agent) => (created = new FakeBackend(agent)),
      resolveEnv: async () => ({}),
      getTurnContextBundle: () => ({ projectContext: '', contextManifest: createTurnContextManifest([]) }),
    });
    const provider = backend === 'codex' ? { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' } : { providerId: 'openai', apiKeySecretName: 'K' };
    manager.create({ id: 'dev', name: 'Dev', role: 'senior-dev', skill: '', provider: provider as AgentConfig['provider'],
      model: 'm', systemPrompt: '', autoApprove: true, allowedTools: ['write'], backend });
    await manager.start('dev', { pin: 'take' });
    created!.emit({ kind: 'ready' });
    const phases: Array<Record<string, unknown> | undefined> = [];
    manager.on('session.turnPhase', (e) => phases.push((e.data as { phase?: Record<string, unknown> }).phase));
    bus.send('user', 'dev', 'ask.question', { instruction: 'Write the contract.', mode: 'act' });
    created!.emit({ kind: 'provider_request_started' } as BackendEvent);
    return { manager, backend: created!, phases };
  }

  it('shows the amount growing at least once every 2 s during a write of 10 KB or more', async () => {
    const { manager, backend, phases } = await oneAgent('openai-compat');
    let bytes = 0;
    const shown: number[] = [];
    for (let ms = 0; ms < 6_000; ms += 250) {
      bytes += 1_024;
      backend.emit({ kind: 'provider_activity', activity: 'tool-input', toolInput: { tool: 'write_file', target: 'contract.md', bytes } });
      await vi.advanceTimersByTimeAsync(250);
      const latest = phases.at(-1)?.toolInput as { bytes?: number } | undefined;
      if (ms % 1_000 === 750 && latest?.bytes !== undefined) shown.push(latest.bytes);
    }
    expect(bytes).toBeGreaterThanOrEqual(10 * 1_024);
    expect(shown.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < shown.length; i++) expect(shown[i]).toBeGreaterThan(shown[i - 1]);
    expect(phases.at(-1)).toMatchObject({ preparingTool: true, toolInput: { tool: 'write_file', target: 'contract.md' } });
    expect(phases.at(-1)?.toolInputNotStreamed).toBeUndefined();
    manager.dispose();
  });

  it('says on a route that sends a call only when complete that its writing cannot be shown', async () => {
    const { manager, phases } = await oneAgent('codex');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(phases.at(-1)).toMatchObject({ toolInputNotStreamed: true });
    manager.dispose();
  });
});
