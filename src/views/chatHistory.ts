import type { TurnTiming } from '../session/TurnTiming';
import type { DelegationCompletionState } from '../types';

export const CHAT_HISTORY_LIMIT = 50;
export const CHAT_HISTORY_KEY_PREFIX = 'roam.chat.';
/** Agent replies are persisted and re-serialized into every state push, so retain the same practical
 * bound as tool details and disclose every dropped character to the transcript reader. */
export const MAX_AGENT_MESSAGE_CHARS = 32_000;

export type ChatHistoryRole = 'user' | 'agent';

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
  /** Host-observed timing, never model-authored prose. Null means this historical turn was not timed. */
  turnTiming?: TurnTiming | null;
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
    turnTiming: Object.prototype.hasOwnProperty.call(candidate, 'turnTiming')
      ? (candidate.turnTiming === null ? null : parseTurnTiming(candidate.turnTiming))
      : null,
    attachments: parseAttachments(candidate.attachments),
  });
}

function normalizeMessage(message: ChatHistoryMessage): ChatHistoryMessage {
  const attachments = parseAttachments(message.attachments);
  const turnTiming = message.turnTiming === null ? null : parseTurnTiming(message.turnTiming);
  return {
    role: message.role,
    text: message.role === 'agent'
      ? clampText(String(message.text), MAX_AGENT_MESSAGE_CHARS, 'agent message')!
      : String(message.text),
    ts: message.ts || new Date(0).toISOString(),
    seq: normalizeSeq(message.seq),
    turnEpoch: normalizeSeq(message.turnEpoch),
    fromName: message.fromName,
    isError: message.isError === true ? true : undefined,
    completionState: normalizeCompletionState(message.completionState),
    ...(turnTiming !== undefined ? { turnTiming } : {}),
    attachments: attachments.length > 0 ? attachments : undefined,
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
  return {
    startedAt: candidate.startedAt,
    settledAt: candidate.settledAt,
    durationMs: Math.floor(candidate.durationMs),
    approvalWaitMs: Math.floor(candidate.approvalWaitMs),
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
  if (typeof text !== 'string' || text.length <= limit) {
    return text;
  }
  // Reserve room for the notice up front so the total lands at or under `limit`, and derive the count
  // from what is actually kept rather than from `limit`.
  const body = text.slice(0, Math.max(0, limit - TRUNCATION_NOTICE_RESERVE));
  const dropped = text.length - body.length;
  return `${body}\n\n… [${what} truncated — ${dropped.toLocaleString()} more characters not kept in the transcript]`;
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
