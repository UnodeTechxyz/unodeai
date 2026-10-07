import { parseTurnTimingPhases, type TurnTiming } from '../session/TurnTiming';
import { parseTurnOutcomeReceipt, type TurnOutcomeReceiptV1 } from '../session/turnOutcomeReceipt';
import type { DelegationCompletionState } from '../types';

export const CHAT_HISTORY_LIMIT = 50;
export const CHAT_HISTORY_KEY_PREFIX = 'roam.chat.';
/** Agent replies are persisted and re-serialized into every state push, so retain the same practical
 * bound as tool details and disclose every dropped character to the transcript reader. */
export const MAX_AGENT_MESSAGE_CHARS = 32_000;

export type ChatHistoryRole = 'user' | 'agent';

/** Host-counted dispatch outcomes of one coordinator turn (v0.9.80 B1). Never parsed from a receipt's text. */
export interface TurnDelegationCounts {
  accepted: number;
  refused: number;
  pending: number;
}

/** Why the host itself started this turn: the results that woke the coordinator, names resolved on arrival. */
export interface ChatTurnTrigger {
  sources: Array<{ agentId: string; agentName: string; reason: 'delegation-result' | 'rework-reply' }>;
  /** Results in the same wake beyond the listed sources. */
  more: number;
}

const MAX_DELEGATION_COUNT = 10_000;
const MAX_TRIGGER_SOURCES = 4;
const MAX_TRIGGER_NAME = 80;
const TURN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ChatHistoryAttachment {
  name: string;
  mime: string;
  kind: 'image' | 'file';
  size?: number;
  thumbnailDataUrl?: string;
}

export interface ChatHistoryMessage {
  role: ChatHistoryRole;
  text: string;
  ts: string;
  seq?: number;
  /** Correlates a user-visible turn record (such as its context manifest) with this message. */
  turnEpoch?: number;
  fromName?: string;
  isError?: boolean;
  /** Host-observed terminal state for delegated or asynchronously resumed turns. */
  completionState?: DelegationCompletionState;
  /** Host-authored notice, not a model turn; it must never receive a turn-timing footer. */
  runtimeNotice?: boolean;
  /**
   * v0.9.89: the stable identity of a host notice that must appear once, such as one spend-reminder threshold
   * or one interrupted delegation. Restoring or re-sending the same key never shows it twice.
   */
  noticeKey?: string;
  /** Host-observed timing, never model-authored prose. Absent or null means none was recorded; neither renders. */
  turnTiming?: TurnTiming | null;
  /**
   * Host-stamped on the one reply that ends a turn. Text flushed before a tool call is a finalized message too,
   * but it is a working step; only this marker makes a message the turn's conclusion (v0.9.88).
   */
  turnFinal?: true;
  /** The origin bus message id of the turn. Opaque; used only to patch a delegation receipt that changes late. */
  turnId?: string;
  /** The turn's dispatch receipt, shown in the conclusion footer instead of a separate chat item. */
  delegationReceipt?: TurnDelegationCounts;
  /** Present only on a turn the host started itself (an async-result wake). */
  turnTrigger?: ChatTurnTrigger;
  /** Host-published exact content in this reply (v0.9.88 §5.5). */
  verbatim?: ChatVerbatim;
  /** v0.9.90: the model-written summary a compaction receipt carries; shown collapsed, never as evidence. */
  compactionSummary?: string;
  /**
   * v0.9.91: the turn's content-free outcome receipt, on the reply that ends it. Absent on rows written before
   * v0.9.91: that turn's outcome was not recorded, which is not a turn without tools.
   */
  turnOutcome?: TurnOutcomeReceiptV1;
  attachments?: ChatHistoryAttachment[];
}

export function chatHistoryKey(agentId: string): string {
  return `${CHAT_HISTORY_KEY_PREFIX}${agentId}`;
}

export function appendChatMessage(
  history: ChatHistoryMessage[],
  message: ChatHistoryMessage,
  limit = CHAT_HISTORY_LIMIT
): ChatHistoryMessage[] {
  return trimChatHistory([...history, normalizeMessage(message)], limit);
}

export function serializeChatHistory(history: ChatHistoryMessage[], limit = CHAT_HISTORY_LIMIT): ChatHistoryMessage[] {
  return trimChatHistory(history.map(normalizeMessage), limit);
}

export function deserializeChatHistory(value: unknown, limit = CHAT_HISTORY_LIMIT): ChatHistoryMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const messages: ChatHistoryMessage[] = [];
  for (const item of value) {
    const parsed = parseMessage(item);
    if (parsed) {
      messages.push(parsed);
    }
  }
  return trimChatHistory(messages, limit);
}

function trimChatHistory(history: ChatHistoryMessage[], limit: number): ChatHistoryMessage[] {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) {
    return [];
  }
  return history.slice(-safeLimit);
}

function parseMessage(value: unknown): ChatHistoryMessage | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Partial<ChatHistoryMessage>;
  if ((candidate.role !== 'user' && candidate.role !== 'agent') || typeof candidate.text !== 'string') {
    return undefined;
  }
  return normalizeMessage({
    role: candidate.role,
    text: candidate.text,
    ts: typeof candidate.ts === 'string' ? candidate.ts : new Date(0).toISOString(),
    seq: normalizeSeq(candidate.seq),
    turnEpoch: normalizeSeq(candidate.turnEpoch),
    fromName: typeof candidate.fromName === 'string' ? candidate.fromName : undefined,
    isError: typeof candidate.isError === 'boolean' ? candidate.isError : undefined,
    completionState: normalizeCompletionState(candidate.completionState),
    runtimeNotice: candidate.runtimeNotice === true ? true : undefined,
    noticeKey: candidate.noticeKey,
    // A missing value stays missing. Older builds wrote `null` for "not recorded"; that is kept as-is and, like
    // a missing value, renders nothing.
    turnTiming: candidate.turnTiming === null ? null : parseTurnTiming(candidate.turnTiming),
    turnFinal: candidate.turnFinal,
    turnId: candidate.turnId,
    delegationReceipt: candidate.delegationReceipt,
    turnTrigger: candidate.turnTrigger,
    verbatim: candidate.verbatim,
    compactionSummary: candidate.compactionSummary,
    turnOutcome: candidate.turnOutcome,
    attachments: parseAttachments(candidate.attachments),
  });
}

function normalizeMessage(message: ChatHistoryMessage): ChatHistoryMessage {
  const attachments = parseAttachments(message.attachments);
  const turnTiming = message.turnTiming === null ? null : parseTurnTiming(message.turnTiming);
  const turnId = normalizeTurnId(message.turnId);
  const delegationReceipt = parseDelegationCounts(message.delegationReceipt);
  const turnTrigger = parseChatTurnTrigger(message.turnTrigger);
  // Only the reply that ends a turn carries its receipt, rebuilt from its bounded fields every time.
  const turnOutcome = message.role === 'agent' && message.turnFinal === true
    ? parseTurnOutcomeReceipt(message.turnOutcome)
    : undefined;
  const kept = message.role === 'agent'
    ? clampTextDetailed(String(message.text), MAX_AGENT_MESSAGE_CHARS, 'agent message')
    : { text: String(message.text), keptBodyLength: String(message.text).length };
  const verbatim = message.role === 'agent' ? verbatimWithinBody(parseChatVerbatim(message.verbatim), kept.keptBodyLength) : undefined;
  return {
    role: message.role,
    text: kept.text,
    ts: message.ts || new Date(0).toISOString(),
    seq: normalizeSeq(message.seq),
    turnEpoch: normalizeSeq(message.turnEpoch),
    fromName: message.fromName,
    isError: message.isError === true ? true : undefined,
    completionState: normalizeCompletionState(message.completionState),
    runtimeNotice: message.runtimeNotice === true ? true : undefined,
    ...(message.role === 'agent' && normalizeNoticeKey(message.noticeKey) ? { noticeKey: normalizeNoticeKey(message.noticeKey) } : {}),
    ...(turnTiming !== undefined ? { turnTiming } : {}),
    // Turn metadata belongs to agent replies only; a user message never ends a turn.
    ...(message.role === 'agent' && message.turnFinal === true ? { turnFinal: true as const } : {}),
    ...(message.role === 'agent' && turnId ? { turnId } : {}),
    ...(message.role === 'agent' && delegationReceipt ? { delegationReceipt } : {}),
    ...(message.role === 'agent' && turnTrigger ? { turnTrigger } : {}),
    ...(verbatim ? { verbatim } : {}),
    ...(message.role === 'agent' && message.runtimeNotice === true && typeof message.compactionSummary === 'string'
      && message.compactionSummary.trim()
      ? { compactionSummary: message.compactionSummary.slice(0, MAX_COMPACTION_SUMMARY_CHARS) }
      : {}),
    ...(turnOutcome ? { turnOutcome } : {}),
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

/** A final summary is at most 8,192 tokens; this bounds the stored copy even for dense text. */
const MAX_COMPACTION_SUMMARY_CHARS = 40_000;

const NOTICE_KEY_PATTERN = /^[A-Za-z0-9._:|@/+-]{1,600}$/;

function normalizeNoticeKey(value: unknown): string | undefined {
  return typeof value === 'string' && NOTICE_KEY_PATTERN.test(value) ? value : undefined;
}

function normalizeTurnId(value: unknown): string | undefined {
  return typeof value === 'string' && TURN_ID_PATTERN.test(value) ? value : undefined;
}

/** A trigger is kept whole or dropped: one malformed source drops it rather than showing a partial reason. */
export function parseChatTurnTrigger(value: unknown): ChatTurnTrigger | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as { sources?: unknown; more?: unknown };
  if (!Array.isArray(candidate.sources) || candidate.sources.length === 0 || candidate.sources.length > MAX_TRIGGER_SOURCES) {
    return undefined;
  }
  const sources: ChatTurnTrigger['sources'] = [];
  for (const source of candidate.sources as Array<{ agentId?: unknown; agentName?: unknown; reason?: unknown }>) {
    if (typeof source?.agentId !== 'string' || !TURN_ID_PATTERN.test(source.agentId)) return undefined;
    if (typeof source.agentName !== 'string' || !source.agentName.trim()) return undefined;
    if (source.reason !== 'delegation-result' && source.reason !== 'rework-reply') return undefined;
    sources.push({ agentId: source.agentId, agentName: source.agentName.trim().slice(0, MAX_TRIGGER_NAME), reason: source.reason });
  }
  const more = candidate.more;
  if (typeof more !== 'number' || !Number.isSafeInteger(more) || more < 0 || more > MAX_DELEGATION_COUNT) {
    return undefined;
  }
  return { sources, more };
}

/** All three counts or nothing: a partial or out-of-range receipt is dropped, never repaired. */
export function parseDelegationCounts(value: unknown): TurnDelegationCounts | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Partial<Record<keyof TurnDelegationCounts, unknown>>;
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_DELEGATION_COUNT;
  if (!count(candidate.accepted) || !count(candidate.refused) || !count(candidate.pending)) {
    return undefined;
  }
  return {
    accepted: candidate.accepted as number,
    refused: candidate.refused as number,
    pending: candidate.pending as number,
  };
}

function normalizeCompletionState(value: unknown): DelegationCompletionState | undefined {
  return value === 'complete' || value === 'partial' || value === 'not-observed' ? value : undefined;
}

function parseTurnTiming(value: unknown): TurnTiming | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Partial<TurnTiming>;
  if (
    typeof candidate.startedAt !== 'string' ||
    typeof candidate.settledAt !== 'string' ||
    typeof candidate.durationMs !== 'number' || !Number.isFinite(candidate.durationMs) || candidate.durationMs < 0 ||
    typeof candidate.approvalWaitMs !== 'number' || !Number.isFinite(candidate.approvalWaitMs) || candidate.approvalWaitMs < 0
  ) {
    return undefined;
  }
  const durationMs = Math.floor(candidate.durationMs);
  // A breakdown is kept only when it is one the host could have recorded for this duration. A turn from before
  // v0.9.92, or a stored breakdown that does not add up, keeps its total and has no phases: not recorded.
  const phases = parseTurnTimingPhases(candidate.phases, durationMs);
  return {
    startedAt: candidate.startedAt,
    settledAt: candidate.settledAt,
    durationMs,
    approvalWaitMs: Math.floor(candidate.approvalWaitMs),
    ...(phases ? { phases } : {}),
  };
}

/**
 * Shared transcript cap: omitted content is named rather than silently disappearing.
 *
 * **The result fits inside `limit`, notice included, so a second pass is a no-op.** That is not tidiness:
 * `normalizeMessage` runs on every append, serialize and parse, so a clamped message is re-normalized many
 * times over its life. A clamp returning `limit + notice` characters exceeded its own limit and was cut
 * again next pass, each time re-deriving the count from already-truncated text. Measured on the first
 * version of this: a message correctly reporting "8,000 more characters not kept" reported **"77"** after
 * five re-serializations, while the truth was still 8,000. A disclosure that converges on a number two
 * orders of magnitude too small is worse than silence — silence does not hand you a lie you can act on.
 */
export function clampText(text: string | undefined, limit: number, what: string): string | undefined {
  return typeof text === 'string' ? clampTextDetailed(text, limit, what).text : text;
}

/**
 * `clampText`, also reporting how much of the original text the result keeps before its truncation notice, so an
 * exact-content span can stop there instead of running into the notice (v0.9.88 §5.5).
 */
export function clampTextDetailed(text: string, limit: number, what: string): { text: string; keptBodyLength: number } {
  if (text.length <= limit) {
    return { text, keptBodyLength: text.length };
  }
  // Reserve room for the notice up front so the total lands at or under `limit`, and derive the count
  // from what is actually kept rather than from `limit`.
  const body = text.slice(0, Math.max(0, limit - TRUNCATION_NOTICE_RESERVE));
  const dropped = text.length - body.length;
  return {
    text: `${body}\n\n… [${what} truncated — ${dropped.toLocaleString()} more characters not kept in the transcript]`,
    keptBodyLength: body.length,
  };
}

/**
 * Host-published exact content in an agent reply (v0.9.88 §5.5): a span of the reply text in UTF-16 code units.
 * It comes from the host's typed receipt publication, never from the text itself.
 */
export interface ChatVerbatim {
  start: number;
  length: number;
  /** The model published only a prefix of the receipt. */
  partial?: true;
  /** The transcript limit cut the reply inside the span; the part kept is still exact. */
  clipped?: true;
}

export function parseChatVerbatim(value: unknown): ChatVerbatim | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as { start?: unknown; length?: unknown; partial?: unknown; clipped?: unknown };
  const { start, length } = candidate;
  if (typeof start !== 'number' || typeof length !== 'number' || !Number.isSafeInteger(start)
      || !Number.isSafeInteger(length) || start < 0 || length <= 0) {
    return undefined;
  }
  return {
    start,
    length,
    ...(candidate.partial === true ? { partial: true as const } : {}),
    ...(candidate.clipped === true ? { clipped: true as const } : {}),
  };
}

/** Keep a span inside the kept body: cut at the transcript limit, or dropped when none of it was kept. */
function verbatimWithinBody(span: ChatVerbatim | undefined, keptBodyLength: number): ChatVerbatim | undefined {
  if (!span || span.start >= keptBodyLength) {
    return undefined;
  }
  const end = span.start + span.length;
  return end <= keptBodyLength ? span : { ...span, length: keptBodyLength - span.start, clipped: true };
}

/** Upper bound on the truncation notice, so a clamped result never exceeds the limit it was clamped to. */
const TRUNCATION_NOTICE_RESERVE = 160;

function normalizeSeq(seq: unknown): number | undefined {
  return typeof seq === 'number' && Number.isFinite(seq) && seq >= 0 ? Math.floor(seq) : undefined;
}

function parseAttachments(value: unknown): ChatHistoryAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ChatHistoryAttachment[] = [];
  for (const item of value.slice(0, 6)) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const a = item as Partial<ChatHistoryAttachment>;
    if (typeof a.name !== 'string' || typeof a.mime !== 'string' || (a.kind !== 'image' && a.kind !== 'file')) {
      continue;
    }
    out.push({
      name: a.name.slice(0, 160),
      mime: a.mime.slice(0, 120),
      kind: a.kind,
      size: typeof a.size === 'number' && Number.isFinite(a.size) ? Math.max(0, Math.floor(a.size)) : undefined,
      thumbnailDataUrl: typeof a.thumbnailDataUrl === 'string' && a.thumbnailDataUrl.startsWith('data:image/')
        ? a.thumbnailDataUrl.slice(0, 200_000)
        : undefined,
    });
  }
  return out;
}
