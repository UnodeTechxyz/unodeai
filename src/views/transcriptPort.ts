import { ChatHistoryMessage, deserializeChatHistory, serializeChatHistory } from './chatHistory';

export interface ChatTranscriptAgent {
  id: string;
  name: string;
  role: string;
}

export interface MessageLogItem {
  /** Source time in sortable UTC form. `time` remains the locale-formatted display label. */
  timestamp?: string;
  time: string;
  from: string;
  to: string;
  type: string;
  priority: string;
  content: string;
}

/** Honest provenance for a bounded activity-log export. */
export interface TranscriptTruncation {
  occurred: boolean;
  droppedItems: number;
  retainedItems: number;
  limit: number;
}

export type TranscriptKind = 'chat' | 'messages';

export interface TranscriptPayload<TKind extends TranscriptKind, TMessage> {
  version: 1;
  kind: TKind;
  exportedAt: string;
  messages: TMessage[];
  agent?: ChatTranscriptAgent;
  /** Present for message-log exports when the source view has a bounded retained window. */
  truncation?: TranscriptTruncation;
}

export type TranscriptParseResult<T> =
  | { ok: true; messages: T[]; truncation?: TranscriptTruncation }
  | { ok: false; error: string };

export function createChatExportPayload(
  agent: ChatTranscriptAgent,
  messages: ChatHistoryMessage[],
  exportedAt = new Date().toISOString()
): TranscriptPayload<'chat', ChatHistoryMessage> {
  return {
    version: 1,
    kind: 'chat',
    agent,
    exportedAt,
    messages: serializeChatHistory(messages),
  };
}

export function createMessagesExportPayload(
  messages: MessageLogItem[],
  exportedAt = new Date().toISOString(),
  truncation?: TranscriptTruncation,
): TranscriptPayload<'messages', MessageLogItem> {
  return {
    version: 1,
    kind: 'messages',
    exportedAt,
    messages: normalizeMessageLogItems(messages),
    ...(truncation ? { truncation: normalizeTruncation(truncation, messages.length) } : {}),
  };
}

export function parseChatImportPayload(raw: unknown): TranscriptParseResult<ChatHistoryMessage> {
  const base = parseBasePayload(raw, 'chat');
  if (!base.ok) {
    return base;
  }
  return { ok: true, messages: deserializeChatHistory(base.messages), truncation: base.truncation };
}

export function parseMessagesImportPayload(raw: unknown): TranscriptParseResult<MessageLogItem> {
  const base = parseBasePayload(raw, 'messages');
  if (!base.ok) {
    return base;
  }
  return { ok: true, messages: normalizeMessageLogItems(base.messages), truncation: base.truncation };
}

function parseBasePayload(raw: unknown, kind: TranscriptKind): TranscriptParseResult<unknown> {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'Invalid JSON.' };
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Import file must contain a JSON object.' };
  }
  const payload = parsed as { kind?: unknown; messages?: unknown; truncation?: unknown };
  if (payload.kind !== kind) {
    return { ok: false, error: `Import file must have kind "${kind}".` };
  }
  if (!Array.isArray(payload.messages)) {
    return { ok: false, error: 'Import file must contain a messages array.' };
  }
  return { ok: true, messages: payload.messages, truncation: parseTruncation(payload.truncation) };
}

function normalizeMessageLogItems(items: unknown[]): MessageLogItem[] {
  const out: MessageLogItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const candidate = item as Partial<MessageLogItem>;
    if (
      typeof candidate.time !== 'string' ||
      typeof candidate.from !== 'string' ||
      typeof candidate.to !== 'string' ||
      typeof candidate.type !== 'string'
    ) {
      continue;
    }
    out.push({
      timestamp: typeof candidate.timestamp === 'string' && Number.isFinite(Date.parse(candidate.timestamp))
        ? new Date(candidate.timestamp).toISOString()
        : undefined,
      time: candidate.time,
      from: candidate.from,
      to: candidate.to,
      type: candidate.type,
      priority: typeof candidate.priority === 'string' ? candidate.priority : 'normal',
      content: typeof candidate.content === 'string' ? candidate.content : '',
    });
  }
  return out;
}

function normalizeTruncation(value: TranscriptTruncation, messageCount: number): TranscriptTruncation {
  const limit = Math.max(0, Math.floor(Number(value.limit) || 0));
  const droppedItems = Math.max(0, Math.floor(Number(value.droppedItems) || 0));
  return {
    occurred: droppedItems > 0,
    droppedItems,
    retainedItems: messageCount,
    limit,
  };
}

function parseTruncation(value: unknown): TranscriptTruncation | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Partial<TranscriptTruncation>;
  if (!Number.isFinite(candidate.droppedItems) || !Number.isFinite(candidate.limit)) {
    return undefined;
  }
  return normalizeTruncation({
    occurred: candidate.occurred === true,
    droppedItems: Number(candidate.droppedItems),
    retainedItems: Number(candidate.retainedItems),
    limit: Number(candidate.limit),
  }, Number.isFinite(candidate.retainedItems) ? Number(candidate.retainedItems) : 0);
}
