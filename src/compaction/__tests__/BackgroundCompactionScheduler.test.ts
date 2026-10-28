import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ContextCompactionCoordinator,
  type BackgroundCompactionEvent,
  type CompactionCoordinatorDeps,
  type CompactionGateInput,
} from '../ContextCompactionCoordinator';
import { bundledSmartCompactionPolicy } from '../BundledSmartCompactionPolicy';
import { resolveSmartCompactionPolicy } from '../SmartCompactionPolicy';
import type { BackgroundCompaction, ContextCompactionResult, ContextControl, ContextProjection } from '../../backend/ContextControl';
import type { AgentConfig } from '../../types';

/** v0.9.99 P6: the gate prepares a summary beside the turn and applies it at a later idle boundary. */
const agent = (): AgentConfig => ({
  id: 'pm', name: 'PM', role: 'pm', skill: '', provider: { providerId: 'openrouter', apiKeySecretName: 'K' },
  model: 'deepseek/deepseek-v4-pro-0813', systemPrompt: 's', autoApprove: false, roleTemplateKey: 'pm',
  route: { routeVersion: 1, kind: 'openai-compatible', connectionId: 'openrouter', modelId: 'deepseek/deepseek-v4-pro-0813' },
});
const WINDOW = 1_048_576;
const COMPACTED: ContextCompactionResult = {
  kind: 'compacted', mechanism: 'host-history', droppedMessages: 40, summary: 'Earlier work.',
  after: { tokens: 60_000, basis: 'host-estimated', window: WINDOW, windowSource: 'measured' },
};

/** A host-history control: `tokens` per projection, a background job whose summary the test releases. */
function fakeControl(options: { tokens: number; admissible?: number; commit?: () => ContextCompactionResult; prepareFails?: boolean }) {
  const state = { tokens: options.tokens, moves: false, captures: 0, prepares: 0, commits: 0, foreground: 0 };
  let release!: () => void;
  const control: ContextControl = {
    projectNextTurn: (): ContextProjection => ({
      tokens: state.tokens, basis: 'host-estimated', window: WINDOW, windowSource: 'measured',
      ...(options.admissible !== undefined ? { admissibleTokens: options.admissible } : {}), readProjectionMoves: state.moves,
    }),
    compact: async () => { state.foreground++; return COMPACTED; },
    captureCompaction: (request): BackgroundCompaction => {
      state.captures++;
      const released = new Promise<void>((resolve) => { release = resolve; });
      // Like the real summarizer, an aborted request ends at once.
      const abortedSignal = new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return {
        estimatedInputTokens: 12_345,
        prepare: async () => {
          state.prepares++;
          // One summary request, as the real summarizer opens one usage unit per request.
          const unit = request.usage.requestStarted('economy');
          await Promise.race([released, abortedSignal]);
          request.usage.requestSettled(unit, request.signal?.aborted ? undefined : { inputTokens: 9_000, outputTokens: 700, usageBasis: 'reported' });
          if (request.signal?.aborted) return { kind: 'failed', reason: 'summarizer-failed', detail: 'aborted' };
          return options.prepareFails ? { kind: 'failed', reason: 'summarizer-failed', detail: 'HTTP 500' } : { kind: 'prepared' };
        },
        commit: () => { state.commits++; return options.commit ? options.commit() : COMPACTED; },
      };
    },
  };
  return { control, state, release: () => release() };
}

function setup(overrides: Partial<CompactionCoordinatorDeps> = {}) {
  const events: BackgroundCompactionEvent[] = [];
  let clock = 1_000_000;
  let ids = 0;
  const deps: CompactionCoordinatorDeps = {
    resolvePolicy: (config, contextWindow, route) => resolveSmartCompactionPolicy({ policy: bundledSmartCompactionPolicy(), agent: config, contextWindow, route }),
    admitted: () => true,
    hostSummarizer: () => ({ summarizer: { summarizeChunks: async () => ({ ok: true, summary: 's' }) }, io: { chatCompletion: async () => ({ text: '' }) }, model: 'economy', contextWindow: 128_000 }),
    newOperationId: () => `op${++ids}`,
    now: () => clock,
    onBackgroundEvent: (event) => events.push(event),
    ...overrides,
  };
  return { coordinator: new ContextCompactionCoordinator(deps), events, advance: (ms: number) => { clock += ms; } };
}
const input = (control: ContextControl, fields: Partial<CompactionGateInput> = {}): CompactionGateInput => ({
  agentId: 'pm', config: agent(), control, requestId: 'req-1', modelId: 'deepseek/deepseek-v4-pro-0813',
  pendingTurn: { instruction: 'next' }, cause: 'automatic', ...fields,
});
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.useRealTimers());

describe('background compaction scheduler (v0.9.99 P6)', () => {
  it('sends a due request that fits at once, starts the summary only when asked, and applies it at the next boundary', async () => {
    const { control, state, release } = fakeControl({ tokens: 300_000, admissible: 900_000 });
    const { coordinator, events } = setup();
    const first = await coordinator.gate(input(control));
    expect(first.outcomes).toEqual([]);
    expect(first.startBackground).toBeTypeOf('function');
    expect(state).toMatchObject({ captures: 1, prepares: 0, foreground: 0 });
    first.startBackground!();
    first.startBackground!();
    expect(state.prepares).toBe(1);
    release();
    await flush();
    expect(events.map((event) => event.state)).toEqual(['prepared']);

    const second = await coordinator.gate(input(control, { requestId: 'req-2' }));
    expect(second.outcomes[0]).toMatchObject({ kind: 'compacted', receipt: { id: 'op1', mechanism: 'host-history' } });
    expect(state.commits).toBe(1);
    expect(events.map((event) => event.state)).toEqual(['prepared', 'applied']);
  });

  it('captures one job at a time while it is preparing', async () => {
    const { control, state } = fakeControl({ tokens: 300_000, admissible: 900_000 });
    const { coordinator } = setup();
    (await coordinator.gate(input(control))).startBackground!();
    const again = await coordinator.gate(input(control));
    expect(again).toEqual({ outcomes: [] });
    expect(state.captures).toBe(1);
  });

  it('applies a ready summary below the trigger only when the read cutoff moves anyway', async () => {
    const { control, state, release } = fakeControl({ tokens: 300_000, admissible: 900_000 });
    const { coordinator } = setup();
    (await coordinator.gate(input(control))).startBackground!();
    release();
    await flush();
    state.tokens = 100_000;
    expect((await coordinator.gate(input(control))).outcomes).toEqual([{ kind: 'not-needed', reason: 'below-trigger' }]);
    expect(state.commits).toBe(0);
    state.moves = true;
    expect((await coordinator.gate(input(control))).outcomes[0]).toMatchObject({ kind: 'compacted' });
    expect(state.commits).toBe(1);
  });

  it('joins a summary being prepared when the request does not fit, instead of starting a foreground one', async () => {
    const { control, state, release } = fakeControl({ tokens: 300_000, admissible: 900_000 });
    const { coordinator } = setup();
    (await coordinator.gate(input(control))).startBackground!();
    state.tokens = 950_000;
    const joining = coordinator.gate(input(control));
    await flush();
    release();
    expect((await joining).outcomes[0]).toMatchObject({ kind: 'compacted' });
    expect(state).toMatchObject({ captures: 1, prepares: 1, commits: 1, foreground: 0 });
  });

  it('falls back to one foreground compaction when a joined summary is stale, or when there is none', async () => {
    const stale = fakeControl({ tokens: 300_000, admissible: 900_000, commit: () => ({ kind: 'failed', reason: 'stale', detail: 'changed' }) });
    const { coordinator, events } = setup();
    (await coordinator.gate(input(stale.control))).startBackground!();
    stale.state.tokens = 950_000;
    const joining = coordinator.gate(input(stale.control));
    await flush();
    stale.release();
    expect((await joining).outcomes[0]).toMatchObject({ kind: 'compacted' });
    expect(stale.state.foreground).toBe(1);
    expect(events.map((event) => event.state)).toEqual(['prepared', 'stale']);

    const none = fakeControl({ tokens: 950_000, admissible: 900_000 });
    expect((await setup().coordinator.gate(input(none.control))).outcomes[0]).toMatchObject({ kind: 'compacted' });
    expect(none.state).toMatchObject({ captures: 0, foreground: 1 });
  });

  it('keeps the foreground gate when the admissible budget is unknown or the route cannot prepare in the background', async () => {
    const unknown = fakeControl({ tokens: 300_000 });
    expect((await setup().coordinator.gate(input(unknown.control))).outcomes[0]).toMatchObject({ kind: 'compacted' });
    expect(unknown.state).toMatchObject({ captures: 0, foreground: 1 });
    const native = fakeControl({ tokens: 300_000, admissible: 900_000 });
    delete (native.control as { captureCompaction?: unknown }).captureCompaction;
    expect((await setup().coordinator.gate(input(native.control))).outcomes[0]).toMatchObject({ kind: 'compacted' });
    expect(native.state.foreground).toBe(1);
  });

  it('reports a background failure once, and suppresses automatic retries as a foreground failure does', async () => {
    const { control, release } = fakeControl({ tokens: 300_000, admissible: 900_000, prepareFails: true });
    const { coordinator, events } = setup();
    (await coordinator.gate(input(control))).startBackground!();
    release();
    await flush();
    expect(events).toEqual([expect.objectContaining({ state: 'failed', outcome: { kind: 'failed', reason: 'summarizer-failed', detail: 'HTTP 500' } })]);
    expect((await coordinator.gate(input(control))).outcomes).toEqual([{ kind: 'suppressed' }]);
  });

  it('times a background summary out after its own 180 seconds', async () => {
    vi.useFakeTimers();
    const { control } = fakeControl({ tokens: 300_000, admissible: 900_000 });
    const { coordinator, events } = setup();
    (await coordinator.gate(input(control))).startBackground!();
    await vi.advanceTimersByTimeAsync(179_999);
    expect(events).toEqual([]);
    // The deadline aborts the summary, and its end is reported as the timeout it was.
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual([expect.objectContaining({ state: 'failed', outcome: { kind: 'failed', reason: 'timeout', detail: 'It did not finish within 180 seconds.' } })]);
  });

  it('never applies or reports a summary cancelled while it was preparing', async () => {
    const { control, state, release } = fakeControl({ tokens: 300_000, admissible: 900_000 });
    const { coordinator, events } = setup();
    (await coordinator.gate(input(control))).startBackground!();
    const settled = coordinator.cancelBackground('pm');
    release();
    await settled;
    expect(events.map((event) => event.state)).toEqual(['cancelled']);
    state.tokens = 950_000;
    await coordinator.gate(input(control));
    expect(state.commits).toBe(0);
  });

  it('cancels a job prepared for a backend that has since been replaced', async () => {
    const old = fakeControl({ tokens: 300_000, admissible: 900_000 });
    const { coordinator, events } = setup();
    (await coordinator.gate(input(old.control))).startBackground!();
    old.release();
    await flush();
    const replacement = fakeControl({ tokens: 300_000, admissible: 900_000 });
    const decision = await coordinator.gate(input(replacement.control));
    expect(old.state.commits).toBe(0);
    expect(events.map((event) => event.state)).toEqual(['prepared', 'cancelled']);
    expect(decision.startBackground).toBeTypeOf('function');
  });

  it('says the turn was stopped when a joined summary is still preparing', async () => {
    const { control, state } = fakeControl({ tokens: 300_000, admissible: 900_000 });
    const { coordinator } = setup();
    (await coordinator.gate(input(control))).startBackground!();
    state.tokens = 950_000;
    const stop = new AbortController();
    const joining = coordinator.gate(input(control, { signal: stop.signal }));
    await flush();
    stop.abort();
    expect((await joining).outcomes).toEqual([{ kind: 'failed', reason: 'stopped', detail: 'The turn was stopped before compaction finished.' }]);
  });

  it('records the numbers of every background state, with unavailable where the host cannot see', async () => {
    const ok = fakeControl({ tokens: 300_000, admissible: 900_000 });
    const { coordinator, events } = setup();
    (await coordinator.gate(input(ok.control))).startBackground!();
    ok.release();
    await flush();
    expect(events[0]).toEqual({
      agentId: 'pm', operationId: 'op1', state: 'prepared', elapsedMs: 0, estimatedInputTokens: 12_345, summaryRequests: 1,
      reportedInputTokens: 9_000, reportedOutputTokens: 700, usageCoverage: 'reported', firstTokenMs: 'unavailable',
    });
    const failing = fakeControl({ tokens: 300_000, admissible: 900_000, prepareFails: true });
    const second = setup();
    (await second.coordinator.gate(input(failing.control))).startBackground!();
    failing.release();
    await flush();
    expect(second.events[0]).toMatchObject({ state: 'failed', failureReason: 'summarizer-failed', summaryRequests: 1 });
    const unstarted = fakeControl({ tokens: 300_000, admissible: 900_000 });
    const third = setup();
    await third.coordinator.gate(input(unstarted.control));
    await third.coordinator.cancelBackground('pm');
    expect(third.events[0]).toMatchObject({ state: 'cancelled', summaryRequests: 0, reportedInputTokens: 'unavailable',
      reportedOutputTokens: 'unavailable', usageCoverage: 'none' });
  });

  it('does not start another paid summary at the boundary where a ready one turned out stale', async () => {
    const stale = fakeControl({ tokens: 300_000, admissible: 900_000, commit: () => ({ kind: 'failed', reason: 'stale', detail: 'changed' }) });
    const { coordinator, events } = setup();
    (await coordinator.gate(input(stale.control))).startBackground!();
    stale.release();
    await flush();
    const decision = await coordinator.gate(input(stale.control));
    expect(decision).toEqual({ outcomes: [] });
    expect(stale.state.captures).toBe(1);
    expect(events.at(-1)).toMatchObject({ state: 'stale', failureReason: 'stale' });
    // A later boundary may decide afresh.
    expect((await coordinator.gate(input(stale.control))).startBackground).toBeTypeOf('function');
  });
});

describe('what the composer ring reads (v0.9.99 P6-UX)', () => {
  const window = { tokens: WINDOW, source: 'measured' as const };

  it('gives the trigger the gate uses, off, or unavailable', () => {
    const { coordinator } = setup();
    const trigger = resolveSmartCompactionPolicy({
      policy: bundledSmartCompactionPolicy(), agent: agent(), contextWindow: window,
      route: { connectionId: 'openrouter', modelId: 'deepseek/deepseek-v4-pro-0813' },
    });
    expect(trigger.status).toBe('resolved');
    expect(coordinator.meterPolicy(agent(), window)).toEqual({
      mode: 'automatic', triggerTokens: (trigger as { policy: { activeTriggerTokens: number } }).policy.activeTriggerTokens,
      basis: 'configured-model',
    });
    expect(coordinator.meterPolicy({ ...agent(), smartCompactionMode: 'off' }, window)).toEqual({ mode: 'off' });
    expect(setup({ admitted: () => false }).coordinator.meterPolicy(agent(), window)).toEqual({ mode: 'unavailable' });
    expect(setup({ resolvePolicy: () => ({ status: 'unavailable', reason: 'no-window' }) as never }).coordinator.meterPolicy(agent(), window))
      .toEqual({ mode: 'unavailable' });
  });

  // Codex's audit of 3ca068c0, M1: Smart Mode may serve a turn with a model whose point differs from the roster model's.
  it('reads the trigger of the model that served the last turn, as the gate does', () => {
    const { coordinator } = setup();
    const roster = { ...agent(), model: 'openai/gpt-5.5', route: { routeVersion: 1 as const, kind: 'openai-compatible' as const, connectionId: 'openrouter', modelId: 'openai/gpt-5.5' } };
    const resolved = (modelId: string) => (resolveSmartCompactionPolicy({
      policy: bundledSmartCompactionPolicy(), agent: roster, contextWindow: window, route: { connectionId: 'openrouter', modelId },
    }) as { policy: { activeTriggerTokens: number } }).policy.activeTriggerTokens;
    expect(resolved('deepseek/deepseek-v4-pro-0813')).not.toBe(resolved('openai/gpt-5.5'));
    expect(coordinator.meterPolicy(roster, window)).toEqual({ mode: 'automatic', triggerTokens: resolved('openai/gpt-5.5'), basis: 'configured-model' });
    expect(coordinator.meterPolicy(roster, window, 'deepseek/deepseek-v4-pro-0813'))
      .toEqual({ mode: 'automatic', triggerTokens: resolved('deepseek/deepseek-v4-pro-0813'), basis: 'served-model' });
  });

  it('reports a background summary as preparing, then ready, and nothing once it is applied', async () => {
    // Applying the summary shrinks the conversation, so no new one is due right after it.
    const fake = fakeControl({ tokens: 300_000, admissible: 900_000, commit: () => { fake.state.tokens = 60_000; return COMPACTED; } });
    const { control, release } = fake;
    const { coordinator } = setup();
    expect(coordinator.backgroundState('pm')).toBeUndefined();
    const first = await coordinator.gate(input(control));
    expect(coordinator.backgroundState('pm')).toBe('preparing');
    first.startBackground!();
    expect(coordinator.backgroundState('pm')).toBe('preparing');
    release();
    await flush();
    expect(coordinator.backgroundState('pm')).toBe('ready');
    await coordinator.gate(input(control, { requestId: 'req-2' }));
    expect(coordinator.backgroundState('pm')).toBeUndefined();
  });
});
