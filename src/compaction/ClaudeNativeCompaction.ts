/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Claude native compaction helpers (v0.9.90 Smart compaction design, §6.2)
 *
 *  Pure pieces of the Claude route: the process environment that installs the agent's threshold, the summary the
 *  CLI puts in its stream after a compaction, and the usage a control turn caused. Live-verified on Claude CLI
 *  2.1.209 (2026-09-28): the two threshold variables make the CLI compact on its own; success and failure arrive
 *  as `system/status` (`compact_result`), then `system/compact_boundary` (`trigger`, `pre_tokens`), then a synthetic
 *  user message carrying the summary; a `/compact` control turn's own `result.usage` is zero.
 *--------------------------------------------------------------------------------------------*/

import type { TurnUsage } from '../backend/AgentBackend';
import type { ResolvedSmartCompactionPolicy } from './SmartCompactionPolicy';

/** Claude documents these bounds for `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. */
export const CLAUDE_AUTO_COMPACT_WINDOW_RANGE = { min: 100_000, max: 1_000_000 } as const;

export interface ClaudeCompactionEnvironment {
  env: Record<string, string>;
  /** Where Claude will compact on its own inside a long turn, before its cap at the real model window. */
  nativeThresholdTokens?: number;
  /** Set when the documented window bounds moved the in-turn threshold away from the agent's trigger. */
  clamped?: 'minimum' | 'maximum';
}

/**
 * The child-process environment for one agent's policy (design §6.2). Smart and Custom install their trigger `T`
 * and share `P` as `window = clamp(floor(T / (P / 100)))`, `pct = P`; Off disables Claude's own compaction. The
 * host's pre-dispatch check still applies the exact trigger; only the in-turn threshold can be clamped.
 */
export function claudeCompactionEnvironment(
  policy: Pick<ResolvedSmartCompactionPolicy, 'mode' | 'activeTriggerTokens' | 'windowPercent'> | undefined,
): ClaudeCompactionEnvironment {
  if (!policy) return { env: {} };
  if (policy.mode === 'off') return { env: { DISABLE_AUTO_COMPACT: '1' } };
  if (policy.activeTriggerTokens === undefined) return { env: {} };
  const wanted = Math.floor(policy.activeTriggerTokens / (policy.windowPercent / 100));
  const window = Math.min(CLAUDE_AUTO_COMPACT_WINDOW_RANGE.max, Math.max(CLAUDE_AUTO_COMPACT_WINDOW_RANGE.min, wanted));
  return {
    env: {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window),
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(policy.windowPercent),
    },
    nativeThresholdTokens: Math.floor(window * policy.windowPercent / 100),
    ...(wanted < CLAUDE_AUTO_COMPACT_WINDOW_RANGE.min ? { clamped: 'minimum' as const } : {}),
    ...(wanted > CLAUDE_AUTO_COMPACT_WINDOW_RANGE.max ? { clamped: 'maximum' as const } : {}),
  };
}

const SUMMARY_HEADER = 'This session is being continued from a previous conversation that ran out of context. '
  + 'The summary below covers the earlier portion of the conversation.';
const SUMMARY_FOOTER = '\n\nIf you need specific details from before compaction';

/**
 * The summary in the CLI's synthetic continuation message. Only the CLI's own framing is removed; when the framing
 * is not the one observed, the whole text is kept rather than guessed at.
 */
export function claudeCompactionSummary(content: unknown): string | undefined {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text : '')).join('\n')
      : '';
  let summary = text.trim();
  if (summary.startsWith(SUMMARY_HEADER)) summary = summary.slice(SUMMARY_HEADER.length).trim();
  const footer = summary.lastIndexOf(SUMMARY_FOOTER.trim());
  if (footer > 0) summary = summary.slice(0, footer).trim();
  if (summary.startsWith('Summary:')) summary = summary.slice('Summary:'.length).trim();
  return summary || undefined;
}

/** Cumulative per-model counts from a result's `modelUsage`, for the usage a control turn caused. */
export interface ModelUsageTotals {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

export function modelUsageTotals(modelUsage: unknown): ModelUsageTotals | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
  const totals: ModelUsageTotals = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  let any = false;
  for (const entry of Object.values(modelUsage as Record<string, Record<string, unknown>>)) {
    if (!entry || typeof entry !== 'object') continue;
    any = true;
    totals.input += count(entry.inputTokens);
    totals.cacheRead += count(entry.cacheReadInputTokens);
    totals.cacheCreation += count(entry.cacheCreationInputTokens);
    totals.output += count(entry.outputTokens);
  }
  return any ? totals : undefined;
}

/**
 * The usage between two cumulative snapshots, as one turn's usage. Undefined when either snapshot is missing or the
 * totals went down (a new process), so the caller records a coverage gap instead of a guess.
 */
export function usageBetween(
  before: ModelUsageTotals | undefined,
  after: ModelUsageTotals | undefined,
  costUsd: number | undefined,
  costBasis: TurnUsage['costBasis'],
): TurnUsage | undefined {
  if (!before || !after) return undefined;
  const delta = {
    input: after.input - before.input,
    cacheRead: after.cacheRead - before.cacheRead,
    cacheCreation: after.cacheCreation - before.cacheCreation,
    output: after.output - before.output,
  };
  if (Object.values(delta).some((value) => value < 0)) return undefined;
  return {
    inputTokens: delta.input + delta.cacheRead + delta.cacheCreation,
    outputTokens: delta.output,
    cachedInputTokens: delta.cacheRead,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(costBasis ? { costBasis } : {}),
    usageBasis: 'reported',
  };
}
