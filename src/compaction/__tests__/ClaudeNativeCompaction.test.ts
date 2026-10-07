import { describe, expect, it } from 'vitest';
import {
  claudeCompactionEnvironment,
  claudeCompactionSummary,
  modelUsageTotals,
  usageBetween,
} from '../ClaudeNativeCompaction';

describe('Claude compaction environment (design §6.2)', () => {
  it('installs the trigger as window and share, so 70% of the window is the trigger', () => {
    expect(claudeCompactionEnvironment({ mode: 'smart', activeTriggerTokens: 250_000, windowPercent: 70 })).toEqual({
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '357142', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' },
      nativeThresholdTokens: 249_999,
    });
  });

  it('clamps to Claude\'s documented bounds and says so', () => {
    expect(claudeCompactionEnvironment({ mode: 'custom', activeTriggerTokens: 50_000, windowPercent: 70 })).toEqual({
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' },
      nativeThresholdTokens: 70_000,
      clamped: 'minimum',
    });
    expect(claudeCompactionEnvironment({ mode: 'smart', activeTriggerTokens: 900_000, windowPercent: 70 })).toMatchObject({
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' }, nativeThresholdTokens: 700_000, clamped: 'maximum',
    });
  });

  it('disables Claude\'s own compaction when Off, and sets nothing without a policy', () => {
    expect(claudeCompactionEnvironment({ mode: 'off', windowPercent: 70 })).toEqual({ env: { DISABLE_AUTO_COMPACT: '1' } });
    expect(claudeCompactionEnvironment(undefined)).toEqual({ env: {} });
  });
});

describe('Claude compaction summary', () => {
  // The synthetic message Claude CLI 2.1.209 streamed after an automatic compaction (2026-09-28), shortened.
  const streamed = 'This session is being continued from a previous conversation that ran out of context. The summary below '
    + 'covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent:\n   Reply ok.\n\n'
    + 'If you need specific details from before compaction (like exact code snippets), read the full transcript at: C:\\x.jsonl\n'
    + 'Continue the conversation from where it left off without asking the user any further questions.';

  it('keeps the summary and drops only the CLI\'s own framing', () => {
    expect(claudeCompactionSummary([{ type: 'text', text: streamed }])).toBe('1. Primary Request and Intent:\n   Reply ok.');
    expect(claudeCompactionSummary(streamed)).toBe('1. Primary Request and Intent:\n   Reply ok.');
  });

  it('keeps a differently framed text whole rather than guessing, and returns nothing for no text', () => {
    expect(claudeCompactionSummary('Blue.')).toBe('Blue.');
    expect(claudeCompactionSummary([{ type: 'image' }])).toBeUndefined();
  });
});

describe('control-turn usage from cumulative model usage', () => {
  it('is the increase across all models, with the cost increase', () => {
    const before = modelUsageTotals({ haiku: { inputTokens: 533, outputTokens: 56, cacheReadInputTokens: 0, cacheCreationInputTokens: 31_114 } });
    const after = modelUsageTotals({
      haiku: { inputTokens: 2_007, outputTokens: 824, cacheReadInputTokens: 149_171, cacheCreationInputTokens: 38_198 },
      sonnet: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    expect(usageBetween(before, after, 0.007121, 'api-equivalent')).toEqual({
      inputTokens: (2_017 - 533) + 149_171 + (38_198 - 31_114), outputTokens: 769, cachedInputTokens: 149_171,
      costUsd: 0.007121, costBasis: 'api-equivalent', usageBasis: 'reported',
    });
  });

  it('gives no usage, so a coverage gap, when a snapshot is missing or the totals went down', () => {
    const totals = modelUsageTotals({ m: { inputTokens: 10, outputTokens: 1 } });
    expect(usageBetween(undefined, totals, 0.1, 'billed')).toBeUndefined();
    expect(usageBetween(modelUsageTotals({ m: { inputTokens: 99, outputTokens: 1 } }), totals, 0.1, 'billed')).toBeUndefined();
    expect(modelUsageTotals(undefined)).toBeUndefined();
  });
});
