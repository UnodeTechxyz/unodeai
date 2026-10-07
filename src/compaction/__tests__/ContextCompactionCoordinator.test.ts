import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compactionNotice,
  compactionReceiptText,
  ContextCompactionCoordinator,
  type CompactionCoordinatorDeps,
  type CompactionGateInput,
} from '../ContextCompactionCoordinator';
import { bundledSmartCompactionPolicy } from '../BundledSmartCompactionPolicy';
import { resolveSmartCompactionPolicy } from '../SmartCompactionPolicy';
import type { ContextCompactionRequest, ContextCompactionResult, ContextControl } from '../../backend/ContextControl';
import type { AgentConfig } from '../../types';

const agent = (fields: Partial<AgentConfig> = {}): AgentConfig => ({
  id: 'dev', name: 'Dev', role: 'senior-dev', skill: '', provider: { providerId: 'openrouter', apiKeySecretName: 'OPENROUTER_API_KEY' },
  model: 'deepseek/deepseek-v4-pro-0813', systemPrompt: 's', autoApprove: false, roleTemplateKey: 'pm',
  route: { routeVersion: 1, kind: 'openai-compatible', connectionId: 'openrouter', modelId: 'deepseek/deepseek-v4-pro-0813' },
  ...fields,
});

function control(tokens: number, compact?: (request: ContextCompactionRequest) => Promise<ContextCompactionResult>) {
  const requests: ContextCompactionRequest[] = [];
  const value: ContextControl = {
    projectNextTurn: () => ({ tokens, basis: 'host-estimated', window: 1_048_576, windowSource: 'measured' }),
    compact: async (request) => {
      requests.push(request);
      if (compact) return compact(request);
      const unit = request.usage.requestStarted('economy');
      request.usage.requestSettled(unit, { inputTokens: 30_000, outputTokens: 1_500, usageBasis: 'reported' });
      return {
        kind: 'compacted', mechanism: 'host-history', droppedMessages: 120, summary: 'Earlier work.',
        carriedForward: [{ kind: 'effect', count: 4 }, { kind: 'refusal', count: 1 }],
        after: { tokens: 61_000, basis: 'host-estimated', window: 1_048_576, windowSource: 'measured' },
      };
    },
  };
  return { value, requests };
}

function coordinator(overrides: Partial<CompactionCoordinatorDeps> = {}) {
  let clock = 1_000_000;
  const spend = { beginUsageUnit: vi.fn(), noteModelRequest: vi.fn(), settleUsageUnit: vi.fn() };
  let ids = 0;
  const deps: CompactionCoordinatorDeps = {
    resolvePolicy: (config, contextWindow, route) => resolveSmartCompactionPolicy({
      policy: bundledSmartCompactionPolicy(), agent: config, contextWindow, route,
    }),
    admitted: () => true,
    hostSummarizer: () => ({ summarizer: { summarizeChunks: async () => ({ ok: true, summary: 's', requests: 1 }) }, io: { chatCompletion: async () => ({ text: '' }) }, model: 'economy', contextWindow: 128_000 }),
    spend,
    newOperationId: () => `op${++ids}`,
    now: () => clock,
    ...overrides,
  };
  return { coordinator: new ContextCompactionCoordinator(deps), spend, advance: (ms: number) => { clock += ms; } };
}

function input(ctl: ContextControl, fields: Partial<CompactionGateInput> = {}): CompactionGateInput {
  return {
    agentId: 'dev', config: agent(), control: ctl, requestId: 'req-1', modelId: 'deepseek/deepseek-v4-pro-0813',
    pendingTurn: { instruction: 'write it' }, cause: 'automatic', ...fields,
  };
}

afterEach(() => vi.useRealTimers());

describe('context compaction coordinator', () => {
  it('sends below the trigger without compacting, and never gates a route it does not admit or an Off agent', async () => {
    const below = control(199_999);
    expect(await coordinator().coordinator.run(input(below.value))).toEqual({ kind: 'not-needed', reason: 'below-trigger' });
    expect(below.requests).toHaveLength(0);
    const over = control(300_000);
    expect(await coordinator({ admitted: () => false }).coordinator.run(input(over.value))).toEqual({ kind: 'not-needed', reason: 'route-not-admitted' });
    expect(await coordinator().coordinator.run(input(over.value, { config: agent({ smartCompactionMode: 'off' }) })))
      .toEqual({ kind: 'not-needed', reason: 'off' });
    expect(over.requests).toHaveLength(0);
  });

  it('compacts at the DeepSeek evidence cap and records a reproducible receipt with its usage units', async () => {
    const ctl = control(247_000);
    const { coordinator: coord, spend } = coordinator();
    const outcome = await coord.run(input(ctl.value));
    expect(ctl.requests[0]).toMatchObject({
      operationId: 'op1', requestId: 'req-1', agentId: 'dev', cause: 'automatic', pendingTurn: { instruction: 'write it' },
      policy: { activeTriggerTokens: 200_000, winningTerm: 'route-evidence-cap' },
    });
    expect(ctl.requests[0].signal).toBeInstanceOf(AbortSignal);
    expect(spend.beginUsageUnit).toHaveBeenCalledWith({ usageUnitId: 'compact:op1:1', requestId: 'req-1', agentId: 'dev', modelId: 'economy' });
    expect(outcome.kind).toBe('compacted');
    const receipt = outcome.kind === 'compacted' ? outcome.receipt : undefined!;
    expect(receipt).toMatchObject({
      version: 1, id: 'op1', agentId: 'dev', trigger: 'route-evidence-cap', mechanism: 'host-history',
      policy: { mode: 'smart', profile: 'balanced', resolutionSource: 'role-template', ceilingTokens: 250_000, routeEvidenceCapTokens: 200_000, activeTriggerTokens: 200_000 },
      before: { tokens: 247_000 }, after: { tokens: 61_000 }, replacedMessages: 120,
      carriedForward: [{ kind: 'effect', count: 4 }, { kind: 'refusal', count: 1 }],
      summaryVisibility: 'included', summary: 'Earlier work.',
      usage: { usageUnitIds: ['compact:op1:1'], coverage: 'reported' },
    });
    expect(receipt.policy.policyRevision).toMatch(/^[0-9a-f]{12}$/);
    expect(compactionReceiptText(receipt)).toBe(
      "UnodeAi: Compacted this agent's earlier conversation (about 247,000 tokens → about 61,000 tokens) because the next "
      + 'request reached the route evidence cap of 200,000 tokens. Kept word for word: 5 carried-forward records and the '
      + 'newest turns. Cost: 1 summary request (usage reported).',
    );
  });

  // Field run F8: a PM whose instructions, tools and kept records took about 30,000 tokens compacted on Custom 60,000
  // and landed at 55,870, then compacted again on the next turn with no word of why.
  it('says when what must stay word for word keeps a compaction above its working target, and what helps', async () => {
    const crowded = control(247_000, async (request) => {
      request.usage.requestSettled(request.usage.requestStarted('economy'), { inputTokens: 30_000, outputTokens: 1_500, usageBasis: 'reported' });
      return {
        kind: 'compacted', mechanism: 'host-history', droppedMessages: 12, summary: 'Earlier work.', keptTokens: 100_000,
        after: { tokens: 120_000, basis: 'host-estimated', window: 1_048_576, windowSource: 'measured' },
      };
    });
    const outcome = await coordinator().coordinator.run(input(crowded.value));
    const receipt = outcome.kind === 'compacted' ? outcome.receipt : undefined!;
    expect(receipt).toMatchObject({ keptTokens: 100_000, after: { tokens: 120_000 } });
    // The 200,000-token evidence cap sizes an 80,000-token working target.
    expect(compactionReceiptText(receipt)).toBe(
      "UnodeAi: Compacted this agent's earlier conversation (about 247,000 tokens → about 120,000 tokens) because the next "
      + 'request reached the route evidence cap of 200,000 tokens. The newest turns were kept word for word. The '
      + 'instructions, tools, kept records and newest turns alone take about 100,000 tokens, so it stays above its '
      + '80,000-token working target and may compact again soon; a higher ceiling means fewer compactions. Cost: 1 '
      + 'summary request (usage reported).',
    );
    // A receipt saved before this field existed says nothing it cannot back.
    const { keptTokens: _kept, ...older } = receipt;
    expect(compactionReceiptText(older)).not.toMatch(/working target/);
  });

  it('never claims a runtime compaction kept turns word for word, and names a summary it does not show and usage it does not report', async () => {
    // Codex App Server 0.155.1: a contextCompaction item with no summary text and no increase in the thread's usage.
    const ctl = control(247_000, async (request) => {
      request.usage.requestSettled(request.usage.requestStarted('gpt-5.5'));
      return { kind: 'compacted', mechanism: 'native-runtime', after: { basis: 'unavailable' } };
    });
    const outcome = await coordinator().coordinator.run(input(ctl.value));
    const receipt = outcome.kind === 'compacted' ? outcome.receipt : undefined!;
    expect(receipt).toMatchObject({ summaryVisibility: 'runtime-private', usage: { usageUnitIds: ['compact:op1:1'], coverage: 'gap' } });
    expect(compactionReceiptText(receipt)).toBe(
      "UnodeAi: Compacted this agent's earlier conversation (about 247,000 tokens before; the runtime does not report the "
      + 'size after) because the next request reached the route evidence cap of 200,000 tokens. The runtime replaced the '
      + 'conversation with its own summary, which it does not show. Cost: 1 summary request (usage not fully reported).',
    );
  });

  it('suppresses an identical automatic failure for ten minutes, and retries when the bucket, time or cause changes', async () => {
    const failing = control(300_000, async () => ({ kind: 'failed', reason: 'summarizer-failed', detail: 'HTTP 500.' }));
    const { coordinator: coord, advance } = coordinator();
    expect(await coord.run(input(failing.value))).toEqual({ kind: 'failed', reason: 'summarizer-failed', detail: 'HTTP 500.' });
    expect(await coord.run(input(failing.value))).toEqual({ kind: 'suppressed' });
    expect(failing.requests).toHaveLength(1);
    expect(compactionNotice({ kind: 'suppressed' })).toBe('UnodeAi: Automatic compaction was recently unsuccessful; task sent unchanged.');
    // Manual Compact always tries.
    await coord.run(input(failing.value, { cause: 'manual' }));
    expect(failing.requests).toHaveLength(2);
    // A request that grew into another 10k bucket is a new situation.
    const grown = control(311_000, async () => ({ kind: 'failed', reason: 'summarizer-failed', detail: 'HTTP 500.' }));
    await coord.run(input(grown.value));
    expect(grown.requests).toHaveLength(1);
    advance(600_001);
    await coord.run(input(grown.value));
    expect(grown.requests).toHaveLength(2);
  });

  it('gives up after 180 seconds, cancels the operation and reports a timeout', async () => {
    vi.useFakeTimers();
    const hanging = control(300_000, () => new Promise(() => undefined));
    const outcome = coordinator().coordinator.run(input(hanging.value));
    await vi.advanceTimersByTimeAsync(179_999);
    expect(hanging.requests[0].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // Checked before awaiting, so a wrong budget fails here at once rather than hanging to the test timeout.
    expect(hanging.requests[0].signal?.aborted).toBe(true);
    await expect(outcome).resolves.toEqual({ kind: 'failed', reason: 'timeout', detail: 'It did not finish within 180 seconds.' });
  });

  it('runs one compaction per agent at a time: a later caller waits, then measures and runs on its own request', async () => {
    const releases: Array<(result: ContextCompactionResult) => void> = [];
    const slow = control(300_000, () => new Promise((resolve) => { releases.push(resolve); }));
    const { coordinator: coord } = coordinator();
    const first = coord.run(input(slow.value, { requestId: 'req-1', cause: 'manual' }));
    const second = coord.run(input(slow.value, { requestId: 'req-2' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Checked before awaiting, so two concurrent compactions fail here at once rather than hanging to the test timeout.
    expect(slow.requests.map((request) => request.requestId)).toEqual(['req-1']);
    releases[0]({ kind: 'skipped', reason: 'nothing-droppable' });
    expect(await first).toEqual({ kind: 'skipped', reason: 'nothing-droppable' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The later caller never inherits the manual outcome: it compacts for its own request.
    expect(slow.requests.map((request) => request.requestId)).toEqual(['req-1', 'req-2']);
    releases[1]({ kind: 'failed', reason: 'summarizer-failed', detail: 'HTTP 500.' });
    expect(await second).toEqual({ kind: 'failed', reason: 'summarizer-failed', detail: 'HTTP 500.' });
  });

  it('keeps a compaction the backend already applied when Stop arrives before the coordinator reads it', async () => {
    let applied!: (result: ContextCompactionResult) => void;
    const ctl = control(300_000, () => new Promise((resolve) => { applied = resolve; }));
    const stop = new AbortController();
    const outcome = coordinator().coordinator.run(input(ctl.value, { signal: stop.signal }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // In one synchronous step: the backend reports the applied compaction, then the user presses Stop.
    applied({ kind: 'compacted', mechanism: 'host-history', droppedMessages: 10, summary: 'Earlier.', after: { tokens: 61_000, basis: 'host-estimated' } });
    stop.abort();
    const result = await outcome;
    expect(result.kind).toBe('compacted');
    expect(result.kind === 'compacted' ? result.receipt.replacedMessages : undefined).toBe(10);
  });

  it('reports a stopped turn as stopped, without a notice', async () => {
    const stop = new AbortController();
    const ctl = control(300_000, async (request) => {
      stop.abort();
      expect(request.signal?.aborted).toBe(true);
      return { kind: 'failed', reason: 'timeout', detail: 'aborted' };
    });
    const outcome = await coordinator().coordinator.run(input(ctl.value, { signal: stop.signal }));
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'stopped' });
    expect(compactionNotice(outcome)).toBeUndefined();
  });

  it('lets a manual Compact run on an Off agent, below any trigger, and labels it manual', async () => {
    const ctl = control(40_000);
    const outcome = await coordinator().coordinator.run(input(ctl.value, { cause: 'manual', pendingTurn: undefined, config: agent({ smartCompactionMode: 'off' }) }));
    expect(ctl.requests).toHaveLength(1);
    expect(outcome.kind === 'compacted' && outcome.receipt.trigger).toBe('manual');
    expect(outcome.kind === 'compacted' && outcome.receipt.policy.activeTriggerTokens).toBeUndefined();
  });

  it('reports an unavailable policy instead of guessing a trigger', async () => {
    const ctl = control(900_000);
    const outcome = await coordinator({ resolvePolicy: () => ({ status: 'unavailable', mode: 'smart', reason: 'profiles must be an object' }) })
      .coordinator.run(input(ctl.value));
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'profiles must be an object' });
    expect(ctl.requests).toHaveLength(0);
  });
});
