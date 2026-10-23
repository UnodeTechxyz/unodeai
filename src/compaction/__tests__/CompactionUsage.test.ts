import { describe, expect, it, vi } from 'vitest';
import { compactionUsageSink, summaryCompletionUsage } from '../CompactionUsage';

function spend() {
  return { beginUsageUnit: vi.fn(), noteModelRequest: vi.fn(), settleUsageUnit: vi.fn() };
}

describe('compaction usage units', () => {
  it('starts a compact: unit under the causing request immediately before each request', () => {
    const port = spend();
    const sink = compactionUsageSink(port, { operationId: 'op7', requestId: 'req-1', agentId: 'dev' });
    expect(sink.coverage()).toBeUndefined();
    expect(sink.requestStarted('eco-model')).toBe('compact:op7:1');
    expect(sink.requestStarted('eco-model')).toBe('compact:op7:2');
    expect(port.beginUsageUnit).toHaveBeenNthCalledWith(1, { usageUnitId: 'compact:op7:1', requestId: 'req-1', agentId: 'dev', modelId: 'eco-model' });
    expect(port.noteModelRequest).toHaveBeenNthCalledWith(2, 'compact:op7:2');
    expect(sink.unitIds()).toEqual(['compact:op7:1', 'compact:op7:2']);
  });

  it('settles reported usage, turns missing or invalid usage into a gap, and settles each unit once', () => {
    const port = spend();
    const sink = compactionUsageSink(port, { operationId: 'op', requestId: 'r', agentId: 'a' });
    const one = sink.requestStarted('m');
    const two = sink.requestStarted('m');
    sink.requestSettled(one, { inputTokens: 900, outputTokens: 80, usageBasis: 'reported' });
    sink.requestSettled(one, { inputTokens: 1, outputTokens: 1 });
    sink.requestSettled(two, { inputTokens: Number.NaN, outputTokens: 5 });
    expect(port.settleUsageUnit.mock.calls).toEqual([
      [one, { inputTokens: 900, outputTokens: 80, usageBasis: 'reported' }],
      [two, undefined],
    ]);
    expect(sink.coverage()).toBe('gap');
  });

  it('ranks coverage gap > reconstructed > reported-partial > reported, and an unsettled unit as a gap', () => {
    const coverage = (bases: Array<'reported' | 'reported-partial' | 'reconstructed' | undefined>) => {
      const sink = compactionUsageSink(undefined, { operationId: 'op', requestId: 'r', agentId: 'a' });
      for (const basis of bases) {
        const id = sink.requestStarted('m');
        if (basis) sink.requestSettled(id, { inputTokens: 1, outputTokens: 1, usageBasis: basis });
      }
      return sink.coverage();
    };
    expect(coverage(['reported', 'reported'])).toBe('reported');
    expect(coverage(['reported', 'reported-partial'])).toBe('reported-partial');
    expect(coverage(['reported-partial', 'reconstructed'])).toBe('reconstructed');
    expect(coverage(['reconstructed', undefined])).toBe('gap');
  });

  it('reads one summary response\'s usage and never invents it', () => {
    expect(summaryCompletionUsage({ usage: { prompt_tokens: 1_000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 300 } } }))
      .toEqual({ inputTokens: 1_000, outputTokens: 200, cachedInputTokens: 300, usageBasis: 'reported' });
    expect(summaryCompletionUsage({ usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 50 } }))
      .toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 10, usageBasis: 'reported' });
    expect(summaryCompletionUsage({ choices: [] })).toBeUndefined();
    expect(summaryCompletionUsage({ usage: { prompt_tokens: '10', completion_tokens: 2 } })).toBeUndefined();
  });
});
