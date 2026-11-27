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
      /** v0.9.99: the input budget the backend's own hard gate admits, when it has one. "Fits" means at or below it. */
      admissibleTokens?: number;
      /** v0.9.99: the pending turn would move the read-reference cutoff, so the history prefix changes anyway. */
      readProjectionMoves?: boolean;
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
        | 'summarizer-window-unavailable' | 'native-unsupported' | 'native-failed' | 'projection-unavailable'
        /** v0.9.99: the history a prepared summary was made from changed before it could be applied. */
        | 'stale';
      detail: string;
    };

/**
 * v0.9.99: one compaction prepared apart from the turns it runs beside. The backend captured, at an idle boundary,
 * exactly which history it summarizes; no history leaves the backend.
 */
export interface BackgroundCompaction {
  /** The host's estimate of what the summary requests will be given, in tokens: the records to summarize. */
  readonly estimatedInputTokens: number;
  /** Runs the summary requests, once. It never marks the backend busy and never changes its history. */
  prepare(): Promise<{ kind: 'prepared' } | Extract<ContextCompactionResult, { kind: 'failed' }>>;
  /**
   * At an idle boundary: apply the prepared summary to the history as it now stands, keeping every message appended
   * since the capture. `failed` with reason `stale` when the captured history changed; `failed` when the result
   * would not shrink the request for `pendingTurn` or would stay at or above the trigger.
   */
  commit(pendingTurn?: { instruction: string; attachments?: TurnAttachments }): ContextCompactionResult;
}

export interface ContextControl {
  /** Project the next request without sending, mutating or emitting anything. */
  projectNextTurn(instruction: string, attachments?: TurnAttachments): ContextProjection;
  /** Compact this backend's context at an idle boundary. Never runs inside a turn. */
  compact(request: ContextCompactionRequest): Promise<ContextCompactionResult>;
  /**
   * v0.9.99: capture a compaction at an idle boundary, to prepare while the agent works and apply at a later idle
   * boundary. A result instead of a handle when there is nothing to prepare. Host-history routes only.
   */
  captureCompaction?(request: ContextCompactionRequest): BackgroundCompaction | Extract<ContextCompactionResult, { kind: 'skipped' | 'failed' }>;
}
