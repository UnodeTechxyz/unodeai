/*---------------------------------------------------------------------------------------------
 *  UnodeAi - compaction usage units (v0.9.90 Smart compaction design, §5.2)
 *
 *  Compaction is model work and is never free or hidden. Each summary request, or each host-triggered native
 *  control turn, is its own independently priced usage unit with the deterministic id
 *  `compact:<operationId>:<ordinal>`, begun immediately before egress under the request that caused it and
 *  settled exactly once. Missing or invalid terminal usage becomes the normal coverage gap, never zero.
 *--------------------------------------------------------------------------------------------*/

import { turnUsageBasis, type TurnUsage } from '../backend/AgentBackend';
import type { CompactionUsageSink } from '../backend/ContextControl';

/** The part of SpendCoordinator a compaction operation uses. */
export interface CompactionSpendPort {
  beginUsageUnit(unit: { usageUnitId: string; requestId: string; agentId: string; modelId: string }): void;
  noteModelRequest(usageUnitId: string): void;
  settleUsageUnit(usageUnitId: string, usage: TurnUsage | undefined): unknown;
}

/** Receipt coverage for one operation: gap > reconstructed > reported-partial > reported. */
export type CompactionUsageCoverage = 'reported' | 'reported-partial' | 'reconstructed' | 'gap';

export interface RecordingCompactionUsageSink extends CompactionUsageSink {
  /** Every unit this operation started, in order. */
  unitIds(): string[];
  /** Undefined when no unit started (for example, a failure before egress). */
  coverage(): CompactionUsageCoverage | undefined;
}

const COVERAGE_RANK: Record<CompactionUsageCoverage, number> = { reported: 0, 'reported-partial': 1, reconstructed: 2, gap: 3 };

export function compactionUsageSink(
  spend: CompactionSpendPort | undefined,
  ids: { operationId: string; requestId: string; agentId: string },
): RecordingCompactionUsageSink {
  const started: string[] = [];
  const settled = new Map<string, CompactionUsageCoverage>();
  return {
    requestStarted(modelId: string): string {
      const usageUnitId = `compact:${ids.operationId}:${started.length + 1}`;
      started.push(usageUnitId);
      spend?.beginUsageUnit({ usageUnitId, requestId: ids.requestId, agentId: ids.agentId, modelId });
      spend?.noteModelRequest(usageUnitId);
      return usageUnitId;
    },
    requestSettled(usageUnitId: string, usage?: TurnUsage): void {
      if (!started.includes(usageUnitId) || settled.has(usageUnitId)) return;
      settled.set(usageUnitId, usage && validUsage(usage) ? turnUsageBasis(usage) : 'gap');
      spend?.settleUsageUnit(usageUnitId, usage && validUsage(usage) ? usage : undefined);
    },
    unitIds: () => [...started],
    coverage(): CompactionUsageCoverage | undefined {
      if (started.length === 0) return undefined;
      let worst: CompactionUsageCoverage = 'reported';
      for (const id of started) {
        const coverage = settled.get(id) ?? 'gap';
        if (COVERAGE_RANK[coverage] > COVERAGE_RANK[worst]) worst = coverage;
      }
      return worst;
    },
  };
}

function validUsage(usage: TurnUsage): boolean {
  const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  return count(usage.inputTokens) && count(usage.outputTokens)
    && (usage.cachedInputTokens === undefined || count(usage.cachedInputTokens));
}

/**
 * One summary response's usage, read from an OpenAI-compatible body. Absent or malformed fields give no usage,
 * which the sink records as a coverage gap.
 */
export function summaryCompletionUsage(body: unknown): TurnUsage | undefined {
  const usage = (body as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  if (typeof input !== 'number' || typeof output !== 'number' || !Number.isFinite(input) || !Number.isFinite(output)) {
    return undefined;
  }
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const cached = typeof details?.cached_tokens === 'number'
    ? details.cached_tokens
    : typeof usage.prompt_cache_hit_tokens === 'number' ? usage.prompt_cache_hit_tokens : undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cached !== undefined ? { cachedInputTokens: Math.min(cached, input) } : {}),
    usageBasis: 'reported',
  };
}
