/*---------------------------------------------------------------------------------------------
 *  UnodeAi - sanitizeModelParams (v0.1.1 F1)
 *  Validate untrusted model-tuning input from the Settings webview into a clean AgentModelParams.
 *  vscode-free so it's unit-testable; the SettingsPanel imports these before persisting.
 *--------------------------------------------------------------------------------------------*/

import { AgentModelParams } from '../types';

// Union of effort values across providers (OpenAI o-series, Kimi/Moonshot, DeepSeek, …). Not every
// model accepts every value, so the backend drops reasoning_effort and retries if the gateway rejects it.
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const RESPONSE_FORMATS = new Set(['text', 'json_object']);
const THINKING_TYPES = new Set(['enabled', 'disabled']);

/** Clamp a finite number into [min, max]; undefined for empty/non-numeric input. */
function num(v: unknown, min: number, max: number): number | undefined {
  if (v === '' || v === null || v === undefined) {
    return undefined; // empty field = "unset" (Number('') is 0, which we must NOT treat as a value)
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, n));
}

/** Build a clean AgentModelParams from untrusted webview data — only keep valid, in-range fields. */
export function sanitizeParams(raw: unknown): AgentModelParams {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: AgentModelParams = {};
  const temperature = num(r.temperature, 0, 2);
  const topP = num(r.top_p, 0, 1);
  const maxTokens = num(r.max_tokens, 1, 1_000_000);
  const presence = num(r.presence_penalty, -2, 2);
  const frequency = num(r.frequency_penalty, -2, 2);

  if (temperature !== undefined) out.temperature = temperature;
  if (topP !== undefined) out.top_p = topP;
  if (maxTokens !== undefined) out.max_tokens = Math.round(maxTokens);
  if (presence !== undefined) out.presence_penalty = presence;
  if (frequency !== undefined) out.frequency_penalty = frequency;
  if (typeof r.reasoning_effort === 'string' && EFFORTS.has(r.reasoning_effort)) {
    out.reasoning_effort = r.reasoning_effort as AgentModelParams['reasoning_effort'];
  }
  if (typeof r.response_format === 'string' && RESPONSE_FORMATS.has(r.response_format)) {
    out.response_format = { type: r.response_format as 'text' | 'json_object' };
  }
  if (typeof r.stream === 'boolean') {
    out.stream = r.stream;
  }
  const stop = sanitizeStop(r.stop);
  if (stop !== undefined) {
    out.stop = stop;
  }
  if (typeof r.tool_choice === 'string') {
    const toolChoice = r.tool_choice.trim();
    if (toolChoice) {
      out.tool_choice = toolChoice;
    }
  }
  const thinking = sanitizeThinking(r.thinking);
  if (thinking) {
    out.thinking = thinking;
  }
  return out;
}

function sanitizeStop(raw: unknown): string | string[] | undefined {
  const clean = (s: string) => s.trim();
  if (typeof raw === 'string') {
    const s = clean(raw);
    return s ? s : undefined;
  }
  if (Array.isArray(raw)) {
    const values = raw.filter((v): v is string => typeof v === 'string').map(clean).filter(Boolean).slice(0, 4);
    if (values.length === 0) {
      return undefined;
    }
    return values.length === 1 ? values[0] : values;
  }
  return undefined;
}

function sanitizeThinking(raw: unknown): AgentModelParams['thinking'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.type !== 'string' || !THINKING_TYPES.has(r.type)) {
    return undefined;
  }
  if (r.type === 'disabled') {
    return { type: 'disabled' };
  }
  const budget = num(r.budget_tokens, 1, 10_000_000);
  return budget === undefined
    ? { type: 'enabled' }
    : { type: 'enabled', budget_tokens: Math.round(budget) };
}

/** A positive integer context window, or undefined to fall back to the default context window. */
export function sanitizeContextWindow(raw: unknown): number | undefined {
  const n = num(raw, 1, 100_000_000);
  return n === undefined ? undefined : Math.round(n);
}
