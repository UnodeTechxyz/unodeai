/* Content-free diagnostics only. Never use this projection for cost, limits, permissions or requests. */
import { TokenCounter, estimateTokens } from './TokenCounter';
import { HOST_WORKSPACE_TOOL_NAMES, HOST_TEAM_TOOL_NAMES } from './HostToolNames';

export const COMPOSITION_ESTIMATOR = 'unode-context-ascii4-wide1-image256-v1';
export const COMPOSITION_CATEGORIES = [
  'system', 'tools', 'history_text', 'history_tool_results', 'turn_input', 'attachments', 'host_context',
] as const;
export type CompositionCategory = typeof COMPOSITION_CATEGORIES[number];
type Counts = Record<CompositionCategory, number>;

// Deliberately closed: neither external MCP names nor configuration strings are diagnostic labels.
const SAFE_TOOLS = [...HOST_WORKSPACE_TOOL_NAMES, ...HOST_TEAM_TOOL_NAMES] as const;
type SafeTool = typeof SAFE_TOOLS[number] | 'external-tool' | 'unknown-tool';
export function compositionToolLabel(name: unknown): SafeTool {
  return typeof name === 'string' && (SAFE_TOOLS as readonly string[]).includes(name)
    ? name as SafeTool : typeof name === 'string' && name.startsWith('mcp__') ? 'external-tool' : 'unknown-tool';
}

/** Host-authored ranges in one FINAL outgoing text atom. Never infer these from prose or delimiters. */
export interface CompositionSpan { start: number; end: number; category: CompositionCategory }
/** Lengths come from the composer, not from searching user-controlled headings in the resulting text. */
export function joinedCompositionSpans(parts: readonly { length: number; category: CompositionCategory }[], separatorLength: number): CompositionSpan[] {
  const spans: CompositionSpan[] = [];
  let offset = 0;
  parts.forEach((part, index) => {
    const end = offset + (index ? separatorLength : 0) + part.length;
    if (end > offset) spans.push({ start: offset, end, category: part.category });
    offset = end;
  });
  return spans;
}
export interface MessageCompositionSource {
  text?: readonly CompositionSpan[];
  parts?: ReadonlyMap<number, readonly CompositionSpan[]>;
  /** Excludes the current host turn, temporary tail, queued images, and system messages. */
  history?: boolean;
  /** Reviewed fallback/legacy precision loss, explicitly supplied by the host transform. */
  precision?: 'partial';
  /** XML results have no wire call id. Only the host's typed injection may supply this fact. */
  xmlToolResult?: { tool: string };
  /**
   * v0.9.99: who wrote a history user message, as the host knows it: a person's turn or steering, or the host's own
   * delivery of delegation results. Without it a user message's history text is attributed to `other`.
   */
  historySource?: 'user' | 'delegation-result';
}

/** v0.9.99: the partition of `history_text` by host provenance. Its parts sum to `history_text`. */
export const HISTORY_TEXT_SOURCES = ['user', 'assistant', 'delegation-result', 'other'] as const;
export type HistoryTextSource = typeof HISTORY_TEXT_SOURCES[number];
type SourceCounts = Record<HistoryTextSource, number>;
const sourceCounts = (): SourceCounts => ({ user: 0, assistant: 0, 'delegation-result': 0, other: 0 });

/** v0.9.99: what the read projection did to one request, in numbers only. */
export interface ReadProjectionComposition {
  projection_revision: number;
  /** History messages in this request before the first message of the cutoff turn; 0 without a cutoff. */
  watermark_index: number;
  /** Estimated tokens the references removed from history tool results, net of the references themselves. */
  history_tool_results_referenced: number;
  referenced_result_count: number;
  /** The net saving the cutoff move at this turn's start weighed, moved or not. */
  new_eligible_savings_tokens: number;
}
const READ_PROJECTION_FIELDS = [
  'projection_revision', 'watermark_index', 'history_tool_results_referenced', 'referenced_result_count', 'new_eligible_savings_tokens',
] as const;
interface Message {
  role?: unknown; content?: unknown; tool_calls?: unknown; reasoning_content?: unknown; tool_call_id?: unknown;
}
interface Largest { tool: SafeTool; estimated_tokens: number }
interface ProviderComposition extends Counts {
  boundary: 'provider-attempt'; total: number; body_utf8_bytes: number; history_message_count: number;
  file_reads: number; unknown_tool_result_tokens: number; largest_tool_result: Largest | null;
  attribution: 'complete' | 'partial'; reported_input_tokens: 'not-yet-reported';
  history_text_by_source: SourceCounts;
  /** Absent when the composer reported none; the record then says not-observable. */
  read_projection?: ReadProjectionComposition;
}
interface HostComposition {
  boundary: 'host-turn-submit'; internal_requests: 'not-observable'; attribution: 'not-observable';
  system: 'not-observable'; tools: 'not-observable'; history_text: 'not-observable';
  history_tool_results: 'not-observable'; file_reads: 'not-observable'; history_message_count: 'not-observable';
  largest_tool_result: 'not-observable'; reported_input_tokens: 'not-observable';
  host_observed: Counts; host_observed_total: number; body_utf8_bytes: number;
  installed_system_estimate: number | 'not-observable'; installed_tools_estimate: number | 'not-observable';
}
export type RequestComposition = ProviderComposition | HostComposition;

const counts = (): Counts => ({ system: 0, tools: 0, history_text: 0, history_tool_results: 0, turn_input: 0, attachments: 0, host_context: 0 });
function whole(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function sum(values: readonly number[]): number {
  const total = values.reduce((a, b) => a + b, 0);
  if (!values.every(whole) || !whole(total)) throw new Error('measurement-unavailable');
  return total;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Allocate the SAME estimator's whole-string total, not the sum of separately rounded fragments. */
function textCounts(text: string, fallback: CompositionCategory, spans?: readonly CompositionSpan[]): Counts {
  const result = counts();
  const total = estimateTokens(text);
  if (!spans) { result[fallback] = total; return result; }
  const weights = counts();
  let cursor = 0;
  for (const span of spans) {
    if (!whole(span.start) || !whole(span.end) || span.start !== cursor || span.end <= span.start
      || span.end > text.length || !COMPOSITION_CATEGORIES.includes(span.category)) throw new Error('measurement-unavailable');
    weights[span.category] = sum([weights[span.category], estimateTokens(text.slice(span.start, span.end))]);
    cursor = span.end;
  }
  if (cursor !== text.length) throw new Error('measurement-unavailable');
  const weight = sum(Object.values(weights));
  if (weight === 0) return result;
  const denominator = BigInt(weight);
  const remainders = COMPOSITION_CATEGORIES.map((category, order) => {
    const numerator = BigInt(total) * BigInt(weights[category]);
    result[category] = Number(numerator / denominator);
    return { category, order, remainder: numerator % denominator };
  }).sort((a, b) => a.remainder === b.remainder ? a.order - b.order : a.remainder > b.remainder ? -1 : 1);
  const left = total - sum(Object.values(result));
  for (let i = 0; i < left; i++) result[remainders[i].category]++;
  return result;
}
function add(into: Counts, extra: Counts): void {
  for (const category of COMPOSITION_CATEGORIES) into[category] = sum([into[category], extra[category]]);
}

/** The final object paired with its serialized body at egress. Never re-parse/copy large image payloads. */
export function projectProviderComposition(
  finalBody: unknown, bodyUtf8Bytes: number, sources: ReadonlyMap<number, MessageCompositionSource> = new Map(),
  readProjection?: ReadProjectionComposition,
): ProviderComposition | undefined {
  try {
    const body = object(finalBody);
    if (!body || !whole(bodyUtf8Bytes) || !Array.isArray(body.messages)) return undefined;
    if (readProjection && !READ_PROJECTION_FIELDS.every((field) => whole(readProjection[field]))) return undefined;
    const messages = body.messages as Message[];
    const result = counts();
    const bySource = sourceCounts();
    let partial = false;
    let history = 0;
    let fileReads = 0;
    let unknown = 0;
    let largest: Largest | null = null;
    // Request-local map only. An ambiguous/reused id must not prove a file read.
    const calls = new Map<string, SafeTool | undefined>();
    for (let index = 0; index < messages.length; index++) {
      const message = object(messages[index]);
      if (!message) return undefined;
      const source = sources.get(index);
      if (source?.precision === 'partial') partial = true;
      const isXmlResult = source?.xmlToolResult !== undefined;
      const isResult = message.role === 'tool' || isXmlResult;
      const fallback = isResult ? 'history_tool_results' : message.role === 'system' ? 'system' : 'history_text';
      // Missing hints can identify the bytes, but cannot prove which user atom is this turn's input.
      const inHistory = message.role !== 'system' && (source?.history === true || !source);
      if (source?.history === true && message.role !== 'system') history++;
      else if (!source && message.role !== 'system') { history++; if (!isResult) partial = true; }
      const historyTextBefore = result.history_text;
      let resultTokens = 0;
      const text = (value: string, spans?: readonly CompositionSpan[]) => {
        const measured = textCounts(value, fallback, spans);
        // A result's entire payload is a result even if a malformed hint tries to reclassify it.
        if (isResult && COMPOSITION_CATEGORIES.some(category => category !== 'history_tool_results' && measured[category] > 0)) {
          throw new Error('measurement-unavailable');
        }
        add(result, measured);
        resultTokens = sum([resultTokens, measured.history_tool_results]);
      };
      if (typeof message.content === 'string') text(message.content, source?.text);
      else if (Array.isArray(message.content)) {
        for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
          const part = object(message.content[partIndex]);
          if (typeof part?.text === 'string') text(part.text, source?.parts?.get(partIndex));
          else if (part && 'image_url' in part) result.attachments = sum([result.attachments, 256]);
          else partial = true; // Match the existing estimator's ignored blocks, not a guessed token count.
        }
      } else if (message.content != null) partial = true;
      if (typeof message.reasoning_content === 'string') result.history_text = sum([result.history_text, estimateTokens(message.reasoning_content)]);
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        result.history_text = sum([result.history_text, estimateTokens(JSON.stringify(message.tool_calls))]);
      }
      // Attributed by the role the host appended and its own typed provenance, never by what the text says.
      const textSource: HistoryTextSource = !inHistory ? 'other'
        : message.role === 'assistant' ? 'assistant'
          : message.role === 'user' && source?.historySource ? source.historySource : 'other';
      bySource[textSource] = sum([bySource[textSource], result.history_text - historyTextBefore]);
      // Associate a native result only with an earlier assistant call, never a name inside result prose.
      if (isResult) {
        const label = isXmlResult ? compositionToolLabel(source!.xmlToolResult!.tool)
          : typeof message.tool_call_id === 'string' ? calls.get(message.tool_call_id) : undefined;
        if (label === undefined) { unknown = sum([unknown, resultTokens]); partial = true; }
        if (label === 'read_file' || label === 'read_extracted_content') fileReads = sum([fileReads, resultTokens]);
        if (largest === null || resultTokens > largest.estimated_tokens) largest = { tool: label ?? 'unknown-tool', estimated_tokens: resultTokens };
      }
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const raw of message.tool_calls) {
          const call = object(raw);
          if (typeof call?.id !== 'string') continue;
          const fn = object(call.function);
          calls.set(call.id, calls.has(call.id) ? undefined : compositionToolLabel(fn?.name));
        }
      }
    }
    if (body.tools !== undefined) result.tools = sum([result.tools, estimateTokens(JSON.stringify(body.tools))]);
    const total = new TokenCounter().estimateMessages(messages) + (body.tools !== undefined ? estimateTokens(JSON.stringify(body.tools)) : 0);
    if (sum(Object.values(result)) !== total || !whole(total) || fileReads > result.history_tool_results) return undefined;
    if (sum(Object.values(bySource)) !== result.history_text) return undefined;
    return { ...result, boundary: 'provider-attempt', total, body_utf8_bytes: bodyUtf8Bytes,
      history_message_count: history, file_reads: fileReads, unknown_tool_result_tokens: unknown,
      largest_tool_result: largest, attribution: partial ? 'partial' : 'complete', reported_input_tokens: 'not-yet-reported',
      history_text_by_source: bySource,
      ...(readProjection ? { read_projection: { ...readProjection } } : {}) };
  } catch { return undefined; }
}

/** Visible CLI packet atoms only; adapter owns the match to its actual packet and successful setup. */
export function projectHostSubmitComposition(input: {
  wirePacket: string;
  texts: readonly { text: string; spans?: readonly CompositionSpan[] }[];
  imageCount: number;
  installed?: { system?: number; tools?: number };
}): HostComposition | undefined {
  try {
    if (!whole(input.imageCount) || input.installed && [input.installed.system, input.installed.tools].some(value => value !== undefined && !whole(value))) return undefined;
    const observed = counts();
    for (const atom of input.texts) add(observed, textCounts(atom.text, 'turn_input', atom.spans));
    observed.attachments = sum([observed.attachments, input.imageCount * 256]);
    return { boundary: 'host-turn-submit', internal_requests: 'not-observable', attribution: 'not-observable',
      system: 'not-observable', tools: 'not-observable', history_text: 'not-observable',
      history_tool_results: 'not-observable', file_reads: 'not-observable', history_message_count: 'not-observable',
      largest_tool_result: 'not-observable', reported_input_tokens: 'not-observable',
      host_observed: observed, host_observed_total: sum(Object.values(observed)), body_utf8_bytes: Buffer.byteLength(input.wirePacket, 'utf8'),
      installed_system_estimate: input.installed?.system ?? 'not-observable', installed_tools_estimate: input.installed?.tools ?? 'not-observable' };
  } catch { return undefined; }
}

export interface CompositionCoordinates {
  /** Host-generated runtime/launch UUID only; never provider ids or an imported AgentConfig.id. */
  session: string; turn: number; attempt: number; route: 'openai-compatible' | 'claude' | 'codex';
}
const unavailable = '[request-composition] {"status":"measurement-unavailable"}';
function validCoordinates(coordinates: CompositionCoordinates): boolean {
  return typeof coordinates.session === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(coordinates.session)
    && whole(coordinates.turn) && coordinates.turn > 0 && whole(coordinates.attempt) && coordinates.attempt > 0
    && ['openai-compatible', 'claude', 'codex'].includes(coordinates.route);
}
function checkedCounts(value: unknown): Counts {
  const raw = object(value);
  if (!raw) throw new Error('measurement-unavailable');
  const result = counts();
  for (const category of COMPOSITION_CATEGORIES) {
    if (!whole(raw[category])) throw new Error('measurement-unavailable');
    result[category] = raw[category];
  }
  sum(Object.values(result));
  return result;
}
/** Rebuild the fixed vocabulary. Never serialize a caller's object, even one typed as a numeric result. */
export function formatRequestComposition(coordinates: CompositionCoordinates, measurement: RequestComposition | undefined): string {
  try {
    if (!validCoordinates(coordinates) || !measurement
      || !whole(measurement.body_utf8_bytes)) return unavailable;
    const identity = { session: coordinates.session, turn: coordinates.turn, attempt: coordinates.attempt, route: coordinates.route, estimator: COMPOSITION_ESTIMATOR };
    let record: object;
    if (measurement.boundary === 'provider-attempt') {
      if (coordinates.route !== 'openai-compatible') return unavailable;
      const main = checkedCounts(measurement);
      if (sum(Object.values(main)) !== measurement.total || !whole(measurement.history_message_count)
        || !whole(measurement.file_reads) || !whole(measurement.unknown_tool_result_tokens)
        || measurement.file_reads + measurement.unknown_tool_result_tokens > main.history_tool_results
        || !['complete', 'partial'].includes(measurement.attribution)) return unavailable;
      const largest = measurement.largest_tool_result;
      if (largest && (!whole(largest.estimated_tokens) || largest.estimated_tokens > main.history_tool_results
        || compositionToolLabel(largest.tool) !== largest.tool && !['external-tool', 'unknown-tool'].includes(largest.tool))) return unavailable;
      const bySourceRaw = object(measurement.history_text_by_source);
      if (!bySourceRaw || !HISTORY_TEXT_SOURCES.every((source) => whole(bySourceRaw[source]))) return unavailable;
      const bySource = sourceCounts();
      for (const source of HISTORY_TEXT_SOURCES) bySource[source] = bySourceRaw[source] as number;
      if (sum(Object.values(bySource)) !== main.history_text) return unavailable;
      const projectionRaw = measurement.read_projection === undefined ? undefined : object(measurement.read_projection);
      if (measurement.read_projection !== undefined && (!projectionRaw || !READ_PROJECTION_FIELDS.every((field) => whole(projectionRaw[field])))) {
        return unavailable;
      }
      const projection = Object.fromEntries(READ_PROJECTION_FIELDS.map((field) => [field, projectionRaw ? projectionRaw[field] : 'not-observable']));
      if (projectionRaw && (projectionRaw.history_tool_results_referenced as number) > 0 && (projectionRaw.referenced_result_count as number) === 0) {
        return unavailable;
      }
      record = { ...identity, boundary: 'provider-attempt', ...main, total: measurement.total,
        body_utf8_bytes: measurement.body_utf8_bytes, history_message_count: measurement.history_message_count,
        file_reads: measurement.file_reads, unknown_tool_result_tokens: measurement.unknown_tool_result_tokens,
        largest_tool_result: largest ? { tool: largest.tool, estimated_tokens: largest.estimated_tokens } : null,
        attribution: measurement.attribution, reported_input_tokens: 'not-yet-reported',
        history_text_by_source: bySource, ...projection };
    } else if (measurement.boundary === 'host-turn-submit') {
      if (coordinates.route === 'openai-compatible') return unavailable;
      const observed = checkedCounts(measurement.host_observed);
      if (sum(Object.values(observed)) !== measurement.host_observed_total
        || ![measurement.installed_system_estimate, measurement.installed_tools_estimate].every(value => value === 'not-observable' || whole(value))) return unavailable;
      record = { ...identity, boundary: 'host-turn-submit', internal_requests: 'not-observable', attribution: 'not-observable',
        system: 'not-observable', tools: 'not-observable', history_text: 'not-observable', history_tool_results: 'not-observable',
        file_reads: 'not-observable', history_message_count: 'not-observable', largest_tool_result: 'not-observable', reported_input_tokens: 'not-observable',
        history_text_by_source: 'not-observable',
        ...Object.fromEntries(READ_PROJECTION_FIELDS.map((field) => [field, 'not-observable'])),
        host_observed: observed, host_observed_total: measurement.host_observed_total, body_utf8_bytes: measurement.body_utf8_bytes,
        installed_system_estimate: measurement.installed_system_estimate, installed_tools_estimate: measurement.installed_tools_estimate };
    } else return unavailable;
    const line = `[request-composition] ${JSON.stringify(record)}`;
    return Buffer.byteLength(line, 'utf8') <= 4096 ? line : unavailable;
  } catch { return unavailable; }
}

/** Later provider-reported usage only. CLI turn totals never acquire an individual request identity. */
export function formatCompositionUsage(coordinates: CompositionCoordinates,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }, scope: 'request' | 'turn'): string {
  try {
    if (!['request', 'turn'].includes(scope) || !validCoordinates(coordinates) || !whole(usage.inputTokens) || !whole(usage.outputTokens)
      || usage.cachedInputTokens !== undefined && (!whole(usage.cachedInputTokens) || usage.cachedInputTokens > usage.inputTokens)
      || (scope === 'request') !== (coordinates.route === 'openai-compatible')) throw new Error('measurement-unavailable');
    return `[request-usage] ${JSON.stringify({ session: coordinates.session, turn: coordinates.turn,
      attempt: scope === 'request' ? coordinates.attempt : 'not-observable', route: coordinates.route,
      usage_scope: scope, reported_input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
      ...(usage.cachedInputTokens !== undefined ? { cached_input_tokens: usage.cachedInputTokens } : {}) })}`;
  } catch { return '[request-usage] {"status":"measurement-unavailable"}'; }
}
