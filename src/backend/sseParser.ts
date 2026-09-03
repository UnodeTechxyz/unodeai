export type SseChunk = string | Uint8Array;

export interface OpenAIStreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /**
   * Cached-prefix input, reported two different ways depending on the upstream:
   *  - DeepSeek (and new-api gateways passing it through): `prompt_cache_hit_tokens` / `_miss_tokens`,
   *    where `prompt_tokens === hit + miss`.
   *  - OpenAI: `prompt_tokens_details.cached_tokens`, a subset of `prompt_tokens`.
   * A cache hit costs roughly a tenth of a miss, so pricing every input token as a miss — which is what we
   * did until now — can overstate the bill by ~10x. Read both shapes; treat both as a SUBSET of
   * `prompt_tokens`, never as an addition to it.
   */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/** Cached input tokens for this response, normalized across the two upstream shapes. Always a subset of
 *  `prompt_tokens`. Returns 0 when the gateway reports nothing (we then simply cannot see the hit rate). */
export function cachedInputTokens(usage: OpenAIStreamUsage | undefined): number {
  if (!usage) {
    return 0;
  }
  return usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
}

export interface ReconstructedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ReconstructedMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ReconstructedToolCall[];
  /**
   * Thinking-model "reasoning" text. Some gateways (e.g. DeepSeek thinking mode) REQUIRE the prior
   * assistant turn's reasoning_content to be echoed back on the next request, or they 400. We capture
   * it here so the tool loop can replay it. It is not user-visible chat content.
   */
  reasoning_content?: string;
}

export interface OpenAIStreamResult {
  /** `finish_reason: 'length'` means the model was cut off at the output-token limit. If that happens
   *  mid tool call, the accumulated `arguments` are a truncated JSON string — the caller must say so
   *  rather than reporting invalid JSON, which tells the model nothing about how to recover. */
  choices: Array<{ message: ReconstructedMessage; finish_reason?: string }>;
  usage?: OpenAIStreamUsage;
}

interface OpenAIStreamToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    /** Spec says a JSON *string*, streamed in fragments. Some OpenAI-compatible gateways send the
     *  finished arguments as a JSON *object* instead — see `appendToolCallArguments`. */
    arguments?: string | Record<string, unknown>;
  };
}

/**
 * Append one `function.arguments` fragment.
 *
 * The OpenAI spec streams arguments as fragments of a JSON string, so the accumulator concatenates.
 * Several OpenAI-compatible gateways (observed on the Unode gateway with DeepSeek) instead deliver the
 * completed arguments as an already-parsed **object**. Concatenating that yields `"[object Object]"`,
 * which then fails `JSON.parse` and collapses to `{}` — the model is told it "omitted" parameters it
 * actually sent, and blind-retries the identical call. Serialize non-strings instead of stringifying
 * them by coercion.
 */
function appendToolCallArguments(existing: string, fragment: string | Record<string, unknown>): string {
  if (typeof fragment === 'string') {
    return existing + fragment;
  }
  try {
    // A whole object arrives at once: it replaces (never concatenates onto) any partial string.
    return JSON.stringify(fragment);
  } catch {
    return existing;
  }
}

interface OpenAIStreamChoice {
  finish_reason?: string | null;
  delta?: {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: OpenAIStreamToolCallDelta[];
  };
}

interface OpenAIStreamEvent {
  choices?: OpenAIStreamChoice[];
  usage?: OpenAIStreamUsage | null;
}

export class OpenAIStreamReconstructor {
  private content = '';
  private reasoningContent = '';
  private usageValue: OpenAIStreamUsage | undefined;
  private toolCalls = new Map<number, ReconstructedToolCall>();
  /** Slot of the tool call currently being streamed — used to attach index-less continuation deltas. */
  private lastToolCallIndex = 0;
  private finishReasonValue: string | undefined;

  accept(event: unknown): { delta?: string; reasoningDelta?: string; toolCallDelta?: true } {
    if (!event || typeof event !== 'object') {
      return {};
    }
    const chunk = event as OpenAIStreamEvent;
    if (chunk.usage) {
      this.usageValue = chunk.usage;
    }
    // The terminal chunk carries finish_reason. 'length' = truncated at the output-token limit.
    const reason = chunk.choices?.[0]?.finish_reason;
    if (typeof reason === 'string' && reason) {
      this.finishReasonValue = reason;
    }

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) {
      return {};
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = this.resolveToolCallIndex(call);
        this.lastToolCallIndex = index;
        const existing = this.toolCalls.get(index) ?? {
          id: '',
          type: 'function' as const,
          function: { name: '', arguments: '' },
        };
        if (call.id) {
          existing.id = call.id;
        }
        if (call.type === 'function') {
          existing.type = 'function';
        }
        if (call.function?.name) {
          existing.function.name = call.function.name;
        }
        if (call.function?.arguments) {
          existing.function.arguments = appendToolCallArguments(existing.function.arguments, call.function.arguments);
        }
        this.toolCalls.set(index, existing);
      }
    }

    const out: { delta?: string; reasoningDelta?: string; toolCallDelta?: true } = {};

    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      out.toolCallDelta = true;
    }

    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      // Accumulate thinking text so it can be echoed back to the gateway (some thinking modes 400
      // without it), AND surface it as a live reasoning delta so the UI can show the agent's analysis.
      this.reasoningContent += delta.reasoning_content;
      out.reasoningDelta = delta.reasoning_content;
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      this.content += delta.content;
      out.delta = delta.content;
    }
    return out;
  }

  /**
   * Resolve which tool-call slot a streamed delta belongs to. The OpenAI streaming format keys each tool
   * call by `index`; some gateways OMIT it on argument-continuation deltas. A naive `toolCalls.size`
   * fallback then splits ONE call into many — each argument fragment becomes a new bogus call, and the
   * named call (e.g. assign_task) is left with empty arguments — which breaks tool calls with large
   * arguments while small ones (run_checks) survive. So when `index` is absent: treat the delta as a
   * CONTINUATION of the call in progress, opening a new slot only when it carries a genuinely new `id`
   * (or no call exists yet). With `index` present (the common case) behavior is unchanged.
   */
  private resolveToolCallIndex(call: OpenAIStreamToolCallDelta): number {
    if (typeof call.index === 'number') {
      return call.index;
    }
    if (this.toolCalls.size === 0) {
      return 0;
    }
    const currentId = this.toolCalls.get(this.lastToolCallIndex)?.id;
    if (call.id && currentId && call.id !== currentId) {
      return this.toolCalls.size; // a different id with no index → a genuinely new (parallel) call
    }
    return this.lastToolCallIndex; // index-less continuation of the in-progress call
  }

  result(): OpenAIStreamResult {
    const toolCalls = Array.from(this.toolCalls.entries())
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({
        ...call,
        id: call.id || `tool_${index}`,
      }));
    const message: ReconstructedMessage = {
      role: 'assistant',
      content: this.content || (toolCalls.length > 0 ? null : ''),
    };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }
    if (this.reasoningContent) {
      message.reasoning_content = this.reasoningContent;
    }
    return {
      choices: [{ message, finish_reason: this.finishReasonValue }],
      usage: this.usageValue,
    };
  }
}

export async function* parseSseEvents(chunks: AsyncIterable<SseChunk> | Iterable<SseChunk>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventLines: string[] = [];

  for await (const chunk of toAsync(chunks)) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newlineIndex = findLineBreak(buffer);
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex);
      const breakLength = buffer[newlineIndex] === '\r' && buffer[newlineIndex + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(newlineIndex + breakLength);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      const parsed = parseLine(line, eventLines);
      eventLines = parsed.eventLines;
      if (parsed.done) {
        return;
      }
      if (parsed.event !== undefined) {
        yield parsed.event;
      }
      newlineIndex = findLineBreak(buffer);
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    const parsed = parseLine(buffer, eventLines);
    eventLines = parsed.eventLines;
    if (parsed.done) {
      return;
    }
    if (parsed.event !== undefined) {
      yield parsed.event;
    }
  }
  const event = flushEvent(eventLines);
  if (event.done) {
    return;
  }
  if (event.value !== undefined) {
    yield event.value;
  }
}

function parseLine(
  line: string,
  current: string[]
): { eventLines: string[]; event?: unknown; done?: boolean } {
  if (line === '') {
    const flushed = flushEvent(current);
    return { eventLines: [], event: flushed.value, done: flushed.done };
  }
  if (line.startsWith(':')) {
    return { eventLines: current };
  }
  if (line.startsWith('data:')) {
    const value = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
    return { eventLines: [...current, value] };
  }
  return { eventLines: current };
}

function flushEvent(lines: string[]): { value?: unknown; done?: boolean } {
  if (lines.length === 0) {
    return {};
  }
  const data = lines.join('\n').trim();
  if (!data) {
    return {};
  }
  if (data === '[DONE]') {
    return { done: true };
  }
  return { value: JSON.parse(data) };
}

function findLineBreak(value: string): number {
  const n = value.indexOf('\n');
  const r = value.indexOf('\r');
  if (n < 0) {
    return r;
  }
  if (r < 0) {
    return n;
  }
  return Math.min(n, r);
}

async function* toAsync(chunks: AsyncIterable<SseChunk> | Iterable<SseChunk>): AsyncGenerator<SseChunk> {
  for await (const chunk of chunks as AsyncIterable<SseChunk>) {
    yield chunk;
  }
}
