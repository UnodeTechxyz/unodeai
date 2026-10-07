/*---------------------------------------------------------------------------------------------
 *  UnodeAi - context control capability (v0.9.90 Smart compaction design, §4.2)
 *
 *  One optional backend capability replaces two unrelated hooks: a projection of the NEXT request's size and
 *  the operation that compacts the backend's own context. SessionManager owns policy, the turn-boundary mutex,
 *  notices and receipts; a backend owns its request serialization and the mutation of its own context.
 *--------------------------------------------------------------------------------------------*/

import type { ContextWindowSource } from '../types';
import type { ChunkedSummaryRequest, ChunkedSummaryResult, SummaryIO } from '../compaction/MapReduceSummarizer';
import type { ResolvedSmartCompactionPolicy } from '../compaction/SmartCompactionPolicy';
import type { TurnAttachments, TurnUsage } from './AgentBackend';

/**
 * The size of the request a backend would send next, including the pending instruction and attachments.
 * `reported-plus-delta` is the provider's report for the last request plus the host's estimate of what the next
 * one adds; `host-estimated` is the host's estimate of the whole serialized request. Neither is an exact
 * tokenizer count. A route that has neither says `unavailable`, never zero.
 */
export type ContextProjection =
  | {
      tokens: number;
      basis: 'reported-plus-delta' | 'host-estimated';
      window?: number;
      windowSource?: ContextWindowSource;
    }
  | {
      basis: 'unavailable';
      window?: number;
      windowSource?: ContextWindowSource;
    };

/** Starts and settles the independently priced usage units of one compaction operation. */
export interface CompactionUsageSink {
  /** Starts one usage unit and records its model request; returns the unit id. */
  requestStarted(modelId: string): string;
  /** Settles that unit; undefined produces the normal no-terminal-usage coverage gap. */
  requestSettled(usageUnitId: string, usage?: TurnUsage): void;
}

export interface ContextCompactionRequest {
  operationId: string;
  requestId: string;
  agentId: string;
  cause: 'automatic' | 'manual';
  policy: ResolvedSmartCompactionPolicy;
  before: ContextProjection;
  pendingTurn?: { instruction: string; attachments?: TurnAttachments };
  usage: CompactionUsageSink;
  hostSummarizer?: {
    summarizer: { summarizeChunks(request: ChunkedSummaryRequest): Promise<ChunkedSummaryResult> };
    io: SummaryIO;
    model: string;
    /** The summarizer model's own resolved window; undefined fails before any egress. */
    contextWindow: number | undefined;
    /** Where that window came from; an `assumed` one is named in any failure it may explain. */
    contextWindowSource?: ContextWindowSource;
  };
  /** Cancels summary requests when the automatic-compaction budget runs out. */
  signal?: AbortSignal;
}

export type ContextCompactionResult =
  | {
      kind: 'compacted';
      mechanism: 'host-history' | 'native-runtime';
      droppedMessages?: number;
      /** What the host carried forward word for word instead of summarizing, by kind. */
      carriedForward?: Array<{ kind: string; count: number }>;
      /** Host-history only: the instructions, tools, carried records and newest turns kept word for word, in tokens. */
      keptTokens?: number;
      summary?: string;
      after: ContextProjection;
    }
  | { kind: 'skipped'; reason: 'below-trigger' | 'nothing-droppable' | 'runtime-managed' | 'too-little-to-gain' }
  | {
      kind: 'failed';
      reason: 'timeout' | 'summarizer-empty' | 'summarizer-failed' | 'required-context-too-large'
        | 'summarizer-window-unavailable' | 'native-unsupported' | 'native-failed' | 'projection-unavailable';
      detail: string;
    };

export interface ContextControl {
  /** Project the next request without sending, mutating or emitting anything. */
  projectNextTurn(instruction: string, attachments?: TurnAttachments): ContextProjection;
  /** Compact this backend's context at an idle boundary. Never runs inside a turn. */
  compact(request: ContextCompactionRequest): Promise<ContextCompactionResult>;
}
