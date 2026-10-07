// Durable tool cards (0.6.13): persist an agent's finalized tool activity — write diffs and command
// output especially — so they survive a window reload and aren't lost like before (they used to live
// only in a transient in-memory map). Mirrors chatHistory.ts. Cline keeps the full transcript; this
// brings the diff/output half of it to parity.

import { parseToolResultFact, toolFactDisplayKind, toolFactSucceeded, type ToolResultFact } from '../backend/toolSummary';

export const CHAT_TOOLS_LIMIT = 60;
export const CHAT_TOOLS_KEY_PREFIX = 'roam.chat.tools.';

export type ChatToolPhase = 'use' | 'result';
export type ChatToolCategory = 'read' | 'list' | 'edit' | 'run' | 'mcp' | 'tool';
export type ChatToolFailureKind = 'blocked' | 'not_found' | 'error' | 'integration_error' | 'cancelled' | 'outcome_unknown';

export interface ChatToolActivity {
  kind: 'tool';
  id: string;
  ts: string;
  /** Set only when a recorded `use` card actually transitions to `result`; absent means not measured. */
  completedAt?: string;
  seq?: number;
  phase: ChatToolPhase;
  name: string;
  title: string;
  summary: string;
  category: ChatToolCategory;
  input?: string;
  /** v0.9.91: the host's turn-local call id and the turn it belongs to; together they pair a result with its start. */
  callId?: string;
  turnEpoch?: number;
  /** v0.9.91: the result's typed fact. Every card finalized since v0.9.91 has one, and no label beside it. */
  outcome?: ToolResultFact;
  /**
   * A card written before v0.9.91 restores its old label here, through the storage decoder only. A new card never
   * writes these; a later outcome projector treats a card without `outcome` as not classified.
   */
  ok?: boolean;
  failureKind?: ChatToolFailureKind;
  detail?: string;
  diff?: string;
  /**
   * v0.9.92: how long people took to decide while this call was open. It is inside the card's span and in no clock,
   * so the card's duration leaves it out and names it. Absent when nobody did.
   */
  humanWaitMs?: number;
}

/** Presentation only: whether a card reads as succeeded, projected from its typed outcome when it has one. */
export function toolCardOk(card: Pick<ChatToolActivity, 'outcome' | 'ok'>): boolean | undefined {
  return card.outcome ? toolFactSucceeded(card.outcome) : card.ok;
}

/** Presentation only: a card's failure label, projected from its typed outcome when it has one. */
export function toolCardFailureKind(card: Pick<ChatToolActivity, 'outcome' | 'failureKind'>): ChatToolFailureKind | undefined {
  return card.outcome ? toolFactDisplayKind(card.outcome) : card.failureKind;
}

const CATEGORIES = new Set<ChatToolCategory>(['read', 'list', 'edit', 'run', 'mcp', 'tool']);
const CALL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const FAILURE_KINDS = new Set<ChatToolFailureKind>(['blocked', 'not_found', 'error', 'integration_error', 'cancelled', 'outcome_unknown']);

export function chatToolsKey(agentId: string): string {
  return `${CHAT_TOOLS_KEY_PREFIX}${agentId}`;
}

/**
 * What we persist: only FINALIZED tool cards (phase 'result'). A still-pending ('use') card would
 * otherwise be restored as a forever-"Running" card after a reload mid-turn. Trimmed to the most
 * recent CHAT_TOOLS_LIMIT to bound workspaceState size.
 */
export function serializeToolActivities(items: ChatToolActivity[], limit = CHAT_TOOLS_LIMIT): ChatToolActivity[] {
  return trim(items.filter((t) => t.phase === 'result').map(normalize), limit);
}

export function deserializeToolActivities(value: unknown, limit = CHAT_TOOLS_LIMIT): ChatToolActivity[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ChatToolActivity[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (parsed) {
      out.push(parsed);
    }
  }
  return trim(out, limit);
}

function trim(items: ChatToolActivity[], limit: number): ChatToolActivity[] {
  const n = Math.max(0, Math.floor(limit));
  return n === 0 ? [] : items.slice(-n);
}

function parse(value: unknown): ChatToolActivity | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const c = value as Partial<ChatToolActivity>;
  if (typeof c.name !== 'string') {
    return undefined;
  }
  return normalize({
    kind: 'tool',
    id: typeof c.id === 'string' ? c.id : `tool-${Math.random().toString(36).slice(2)}`,
    ts: typeof c.ts === 'string' ? c.ts : new Date(0).toISOString(),
    completedAt: validTimestamp(c.completedAt),
    seq: normalizeSeq(c.seq),
    phase: 'result',
    name: c.name,
    title: typeof c.title === 'string' ? c.title : c.name,
    summary: typeof c.summary === 'string' ? c.summary : '',
    category: (c.category && CATEGORIES.has(c.category)) ? c.category : 'tool',
    input: typeof c.input === 'string' ? c.input : undefined,
    callId: c.callId,
    turnEpoch: c.turnEpoch,
    outcome: c.outcome,
    ok: typeof c.ok === 'boolean' ? c.ok : undefined,
    failureKind: (c.failureKind && FAILURE_KINDS.has(c.failureKind)) ? c.failureKind : undefined,
    detail: typeof c.detail === 'string' ? c.detail : undefined,
    diff: typeof c.diff === 'string' ? c.diff : undefined,
    humanWaitMs: c.humanWaitMs,
  });
}

function normalize(t: ChatToolActivity): ChatToolActivity {
  // A card holds its typed outcome or, restored from before v0.9.91, its old label: never both as competing truths.
  // A card that has an outcome field was written since v0.9.91, so an invalid one leaves it unclassified; its label
  // is never consulted in that outcome's place.
  const hasOutcome = t.outcome !== undefined;
  const outcome = parseToolResultFact(t.outcome);
  const callId = typeof t.callId === 'string' && CALL_ID_PATTERN.test(t.callId) ? t.callId : undefined;
  return {
    kind: 'tool',
    id: String(t.id),
    ts: t.ts || new Date(0).toISOString(),
    completedAt: validTimestamp(t.completedAt),
    seq: normalizeSeq(t.seq),
    // Persisted cards are always finalized — render them as done, never as a phantom "Running".
    phase: 'result',
    name: String(t.name),
    title: String(t.title ?? t.name),
    summary: String(t.summary ?? ''),
    category: CATEGORIES.has(t.category) ? t.category : 'tool',
    input: typeof t.input === 'string' ? t.input : undefined,
    ...(callId ? { callId } : {}),
    ...(callId && normalizeSeq(t.turnEpoch) !== undefined ? { turnEpoch: normalizeSeq(t.turnEpoch) } : {}),
    ...(outcome
      ? { outcome }
      : hasOutcome
        ? {}
        : {
            ok: typeof t.ok === 'boolean' ? t.ok : undefined,
            failureKind: t.failureKind && FAILURE_KINDS.has(t.failureKind) ? t.failureKind : undefined,
          }),
    detail: typeof t.detail === 'string' ? t.detail : undefined,
    diff: typeof t.diff === 'string' ? t.diff : undefined,
    ...(humanWaitOf(t.humanWaitMs) ? { humanWaitMs: humanWaitOf(t.humanWaitMs) } : {}),
  };
}

/** A wait worth naming: a whole number of milliseconds above zero. Anything else is no wait. */
export function humanWaitOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function normalizeSeq(seq: unknown): number | undefined {
  return typeof seq === 'number' && Number.isFinite(seq) && seq >= 0 ? Math.floor(seq) : undefined;
}
