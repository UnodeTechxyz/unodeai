/*---------------------------------------------------------------------------------------------
 *  Agent-scoped conversation-log projection.
 *
 *  The MessageBus is a team-wide transport, not a team-wide transcript reader. This pure projection
 *  makes an agent's own inbound/outbound messages addressable without exposing a selector for anyone
 *  else's conversation or attachment bytes.
 *--------------------------------------------------------------------------------------------*/

import type { Message } from '../types';

export const CONVERSATION_LOG_MAX_READ_ENTRIES = 20;
export const CONVERSATION_LOG_MAX_OUTPUT_CHARS = 20_000;
export const CONVERSATION_LOG_MAX_SEARCH_RESULTS = 20;
export const CONVERSATION_LOG_SEARCH_EXCERPT_CHARS = 600;

export interface ConversationLogEntry {
  ordinal: number;
  timestamp: string;
  from: string;
  to: string;
  type: string;
  /** Only typed/message text. Attachments and arbitrary metadata are deliberately absent. */
  text: string;
}

/**
 * Return only messages this agent sent or received (plus broadcasts explicitly addressed to everyone).
 * Like D3's asset gate, this projection has no caller-selectable subject: generic read authority must not
 * become authority over another agent's history.
 */
export function ownConversationLog(messages: readonly Message[], agentId: string): ConversationLogEntry[] {
  return messages
    .filter((message) => message.from === agentId || message.to === agentId || message.to === '*')
    .map((message, index) => ({
      ordinal: index + 1,
      timestamp: message.timestamp,
      from: message.from,
      to: message.to,
      type: message.type,
      text: messageText(message),
    }));
}

/** A bounded display projection; record contents stay in the MessageBus and never enter a receipt. */
export function formatConversationEntries(entries: readonly ConversationLogEntry[]): string {
  let remaining = CONVERSATION_LOG_MAX_OUTPUT_CHARS;
  const lines: string[] = [];
  for (const entry of entries) {
    if (remaining <= 0) { break; }
    const header = `[${entry.ordinal}] ${entry.timestamp} | ${entry.from} -> ${entry.to} | ${entry.type}\n`;
    const allowed = Math.max(0, remaining - header.length);
    const text = entry.text.length > allowed ? `${entry.text.slice(0, Math.max(0, allowed - 1))}…` : entry.text;
    const line = `${header}${text}`;
    lines.push(line);
    remaining -= line.length + 2;
  }
  return lines.join('\n\n');
}

export function conversationSearchExcerpt(text: string, query: string): string {
  const at = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (at < 0) { return ''; }
  const start = Math.max(0, at - Math.floor(CONVERSATION_LOG_SEARCH_EXCERPT_CHARS / 3));
  const end = Math.min(text.length, start + CONVERSATION_LOG_SEARCH_EXCERPT_CHARS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function messageText(message: Message): string {
  const candidate = typeof message.payload.instruction === 'string'
    ? message.payload.instruction
    : typeof message.payload.message === 'string'
      ? message.payload.message
      : '';
  return candidate.trim() || '(no textual message content)';
}
