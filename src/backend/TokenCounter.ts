/*---------------------------------------------------------------------------------------------
 *  UnodeAi - TokenCounter
 *  Deterministic context-window guard. Soft limit signals structured compaction; hard limit is
 *  the emergency safety valve that prevents provider-side truncation.
 *--------------------------------------------------------------------------------------------*/

import { DEFAULT_CONTEXT_WINDOW_TOKENS } from '../contextWindowDefaults';

export interface ContextAssessment {
  tokens: number;
  window: number;
  ratio: number;
  /** At/over the soft threshold: compaction is due. */
  soft: boolean;
  /** At/over the hard threshold: stop issuing new tool calls and force compaction/trimming. */
  hard: boolean;
}

export interface SoftLimitResult<T> {
  triggered: boolean;
  tokens: number;
  limit: number;
  toDrop: T[];
  keep: T[];
}

/**
 * Rough token estimate without a tokenizer — biased to OVER-count, on purpose.
 *
 * "~4 chars per token" holds for English ASCII and nothing else. CJK runs closer to 1–1.5 characters per
 * token, so a flat /4 under-counts Chinese text by three to four times; code and JSON land in between.
 *
 * Both consumers of this number are wrong in ONE direction only, and it is the same direction:
 *
 *  - the context guard (soft limit, compaction, hard trim): under-counting means we believe there is room
 *    and sail past the model's real window;
 *  - the cost reconstruction (reconcileUsage): under-counting the cached prefix under-reports the bill.
 *
 * So when in doubt, count MORE. ASCII keeps the 4:1 rule; every non-ASCII code unit counts as a whole token,
 * which slightly over-counts CJK (real ≈ 1.5 chars/token) and that is exactly the side to be wrong on.
 * (Codex, v0.9.29 review: the estimate's error direction was unguarded, and every test used ASCII — which
 * happens to sit right on the 4:1 rule and therefore proved nothing.)
 */
export function estimateTokens(text: string): number {
  return countTokens(text, 4);
}

/**
 * The same estimate, deliberately biased HIGH — for anything that becomes MONEY.
 *
 * This is NOT an upper bound and nothing here can be. Without the model's own tokenizer, the only true bound
 * on a BPE tokenizer is one token per character, which would over-report English fourfold and be useless. So
 * be honest about what this is: a conservative guess, used only where the error has a direction we care
 * about, and every number derived from it is FLAGGED as an estimate rather than passed off as a bill.
 *
 * 3 chars/token for ASCII rather than 4: dense code and JSON tokenize nearer 3, and prose nearer 4, so the
 * lower divisor is the safe side. Non-ASCII stays 1:1. Two estimators exist on purpose — the context guard
 * wants an accurate number (over-counting there forces premature compaction, which destroys the prompt cache
 * and costs real money), while the cost path wants a cautious one. One function cannot serve both biases,
 * and pretending it could is what let this under-count survive three reviews. (Codex, v0.9.29.)
 */
export function estimateTokensUpper(text: string): number {
  return countTokens(text, 3);
}

function countTokens(text: string, asciiCharsPerToken: number): number {
  const s = String(text ?? '');
  let ascii = 0;
  let wide = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x80) {
      ascii++;
    } else {
      wide++;
    }
  }
  return Math.ceil(ascii / asciiCharsPerToken) + wide;
}

/** What one image block costs. 256 was fiction: a high-detail image runs ~1,100 tokens on OpenAI and up to
 *  ~1,600 on Anthropic. Used for the money path; the context guard keeps the cheaper figure only because
 *  over-counting there would trim history that does not need trimming. */
const IMAGE_TOKENS_UPPER = 1600;
const IMAGE_TOKENS = 256;

export class TokenCounter {
  constructor(
    private window = DEFAULT_CONTEXT_WINDOW_TOKENS,
    private softRatio = 0.7,
    private hardRatio = 0.8
  ) {}

  /**
   * Estimate the context tokens of a set of chat messages.
   *
   * `tool_calls` count. They used to not, and the omission was not cosmetic: an assistant turn that calls
   * `write_file` carries the ENTIRE file in `tool_calls[].function.arguments` and `content: null`, so a
   * history full of large writes read as costing almost nothing. Two things depend on this number and both
   * were wrong —
   *
   *  - the context-window guard (soft limit, compaction, hard trim), which could let us sail past the real
   *    window while believing we were fine; and
   *  - reconcileUsage's prompt floor, which uses "did the conversation shrink?" to know when to stop
   *    trusting the previous prompt size. The degradation ladder's flatten DROPS tool_calls — a huge, real
   *    shrink that this estimate could not see (it even rose slightly, since the flatten leaves a text note
   *    behind). The floor then survived, the next honestly-smaller prompt was read as a cache hit, and we
   *    invented cached tokens that were never served. Found by Codex in the v0.9.29 review.
   */
  estimateMessages(
    messages: Array<{ content?: unknown; tool_calls?: unknown; reasoning_content?: unknown }>
  ): number {
    return this.sumMessages(messages, estimateTokens, IMAGE_TOKENS);
  }

  /** The cautious variant — see estimateTokensUpper. Use for anything that becomes money. */
  estimateMessagesUpper(
    messages: Array<{ content?: unknown; tool_calls?: unknown; reasoning_content?: unknown }>
  ): number {
    return this.sumMessages(messages, estimateTokensUpper, IMAGE_TOKENS_UPPER);
  }

  private sumMessages(
    messages: Array<{ content?: unknown; tool_calls?: unknown; reasoning_content?: unknown }>,
    estimate: (text: string) => number,
    imageTokens: number
  ): number {
    let total = 0;
    for (const m of messages) {
      if (typeof m.content === 'string') {
        total += estimate(m.content);
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
            total += estimate(part.text);
          } else if (part && typeof part === 'object' && 'image_url' in part) {
            total += imageTokens;
          }
        }
      }
      // The arguments ARE the payload on a write/edit turn. Serializing the whole array also picks up the
      // ids and function names, which the model is billed for too.
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        try {
          total += estimate(JSON.stringify(m.tool_calls));
        } catch {
          /* an unserializable tool_call must never break the count that guards the context window */
        }
      }
      // A thinking model's reasoning is PERSISTED and REPLAYED (some gateways 400 without it), so the model
      // is billed for it on every subsequent request. Counting only `content` made a long chain of reasoning
      // turns look free.
      if (typeof m.reasoning_content === 'string') {
        total += estimate(m.reasoning_content);
      }
    }
    return total;
  }

  /** Token budget at the soft threshold. */
  softLimit(): number;
  /** Plan a soft-limit compaction while preserving system messages, the first user anchor, and a recent tail. */
  softLimit<T extends { role?: string; content?: unknown }>(messages: T[], limitOverride?: number): SoftLimitResult<T>;
  /**
   * `limitOverride` exists for compaction the USER asked for.
   *
   * The default threshold is derived from `window`, which is an assumption about the model. When that
   * assumption is too large the threshold never trips — so on the one gateway that rejects the turn, the
   * one control that could fix it plans nothing. A user pressing Compact *is* the trigger; they should not
   * have to satisfy a threshold computed from a number that is already known to be wrong.
   */
  softLimit<T extends { role?: string; content?: unknown }>(messages?: T[], limitOverride?: number): number | SoftLimitResult<T> {
    const limit = Number.isFinite(limitOverride) && (limitOverride as number) > 0
      ? Math.floor(limitOverride as number)
      : Math.floor(this.window * this.softRatio);
    if (!messages) {
      return limit;
    }

    const tokens = this.estimateMessages(messages);
    if (tokens < limit) {
      return { triggered: false, tokens, limit, toDrop: [], keep: messages };
    }

    const systemPrefix: T[] = [];
    let idx = 0;
    while (idx < messages.length && messages[idx].role === 'system') {
      systemPrefix.push(messages[idx]);
      idx++;
    }

    const rest = messages.slice(idx);
    const anchorIdx = rest.findIndex((m) => m.role === 'user');
    const anchor = anchorIdx >= 0 ? rest[anchorIdx] : undefined;
    const body = anchorIdx >= 0 ? rest.slice(anchorIdx + 1) : rest.slice();
    const head = anchor ? [...systemPrefix, anchor] : systemPrefix.slice();
    const tail = body.slice();
    const toDrop: T[] = [];

    while (tail.length > 0 && this.estimateMessages([...head, ...tail]) > limit) {
      toDrop.push(tail.shift()!);
    }
    while (tail.length > 0 && tail[0].role !== 'user') {
      toDrop.push(tail.shift()!);
    }

    return {
      triggered: toDrop.length > 0,
      tokens,
      limit,
      toDrop,
      keep: [...head, ...tail],
    };
  }

  /** Token budget at the hard threshold. */
  hardLimit(): number {
    return Math.floor(this.window * this.hardRatio);
  }

  /**
   * Narrow the window a live counter measures against.
   *
   * Only ever narrows. The one caller is an overflow rejection, which proves the model accepts less than we
   * sent; widening on the same evidence would be incoherent, and allowing it would let a stray call talk the
   * guard into believing there is room that a provider has already refused. Returns whether it took effect.
   */
  narrowWindow(tokens: number): boolean {
    if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens >= this.window) {
      return false;
    }
    this.window = tokens;
    return true;
  }

  /** Classify a token count against the window's soft/hard thresholds. */
  assess(tokens: number): ContextAssessment {
    const ratio = this.window > 0 ? tokens / this.window : 0;
    return {
      tokens,
      window: this.window,
      ratio,
      soft: ratio >= this.softRatio,
      hard: ratio >= this.hardRatio,
    };
  }
}
