import { ChatHistoryMessage, deserializeChatHistory, serializeChatHistory } from './chatHistory';

/** Workspace-state key holding the archived-chat list (a single global list, newest first). */
export const CHAT_ARCHIVE_KEY = 'roam.chatArchives';
/** Cap stored archives so workspaceState can't grow without bound (oldest drop off). */
export const CHAT_ARCHIVE_LIMIT = 100;

/**
 * A chat transcript that was *archived* (saved, then hidden from the live panel) rather than cleared
 * (deleted). Restored on demand via "View Archived Chats". Messages reuse the chatHistory schema.
 */
export interface ArchivedChat {
  id: string;
  agentId: string;
  agentName: string;
  role?: string;
  archivedAt: string; // ISO
  messages: ChatHistoryMessage[];
}

/** Stable-ish unique id for an archive entry. */
export function makeArchiveId(now: number = Date.now(), rand: () => number = Math.random): string {
  return `arch-${now.toString(36)}-${rand().toString(36).slice(2, 8)}`;
}

/** Parse + validate a persisted archive list (drops malformed entries; never throws). */
export function deserializeArchives(value: unknown): ArchivedChat[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ArchivedChat[] = [];
  for (const item of value) {
    const parsed = parseArchive(item);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out.slice(0, CHAT_ARCHIVE_LIMIT);
}

/** Normalize + trim a list for persistence (newest first, capped, messages normalized). */
export function serializeArchives(list: ArchivedChat[]): ArchivedChat[] {
  return list.slice(0, CHAT_ARCHIVE_LIMIT).map((a) => ({
    id: a.id,
    agentId: a.agentId,
    agentName: a.agentName,
    role: a.role,
    archivedAt: a.archivedAt,
    messages: serializeChatHistory(a.messages),
  }));
}

/** A one-line preview of an archive for the picker (first message, trimmed). */
export function summarizeArchive(a: ArchivedChat): string {
  const first = a.messages.find((m) => m.text.trim().length > 0);
  const text = (first?.text ?? '').replace(/\s+/g, ' ').trim();
  const count = a.messages.length;
  const snippet = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return snippet ? `${count} message${count === 1 ? '' : 's'} · ${snippet}` : `${count} message${count === 1 ? '' : 's'}`;
}

function parseArchive(value: unknown): ArchivedChat | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const c = value as Partial<ArchivedChat>;
  if (typeof c.id !== 'string' || typeof c.agentId !== 'string') {
    return undefined;
  }
  const messages = deserializeChatHistory(c.messages);
  return {
    id: c.id,
    agentId: c.agentId,
    agentName: typeof c.agentName === 'string' ? c.agentName : c.agentId,
    role: typeof c.role === 'string' ? c.role : undefined,
    archivedAt: typeof c.archivedAt === 'string' ? c.archivedAt : new Date(0).toISOString(),
    messages,
  };
}
