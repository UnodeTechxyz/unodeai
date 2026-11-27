/*---------------------------------------------------------------------------------------------
 *  UnodeAi - What a reply suggestion is made from (v0.9.110)
 *
 *  Only the visible user and agent text of the conversation shown: at most the last 8 messages and 12,000 code
 *  points together, the last user message at most 4,000 and the last answer at most 6,000; the rest of the budget
 *  goes to earlier messages, newest first. Text is redacted before it is counted. A message cut to its tail says so.
 *  Attachments, tool output, host notices, hidden and cleared content are never part of it. Code or file content
 *  that a person or member quoted into visible text is part of it, and the disclosure says so.
 *
 *  VS Code-free and deterministic: the caller gives the messages, this decides exactly what text leaves.
 *--------------------------------------------------------------------------------------------*/

import { redactSecretText } from '../security/diagnosticRedaction';

export const SUGGESTION_MAX_MESSAGES = 8;
export const SUGGESTION_MAX_TOTAL_CODE_POINTS = 12_000;
export const SUGGESTION_MAX_LAST_USER_CODE_POINTS = 4_000;
export const SUGGESTION_MAX_LAST_ANSWER_CODE_POINTS = 6_000;
export const SUGGESTION_MAX_OUTPUT_CODE_POINTS = 300;
/** Placed before a message's kept tail when its beginning was cut. */
export const SUGGESTION_TRUNCATION_MARKER = '[earlier part of this message omitted]\n';

/** One visible chat message, as the host holds it. Only the fields that decide whether it may be sent. */
export interface SuggestionSourceMessage {
  role: 'user' | 'agent';
  text: string;
  isError?: boolean;
  /** A host notice, not a turn of the conversation. */
  runtimeNotice?: boolean;
  noticeKey?: string;
  /** Text of a reply attempt that did not complete, kept for display only. */
  incompleteReply?: unknown;
  interruptedReply?: boolean;
  /** A compaction receipt's model-written summary: not conversation text. */
  compactionSummary?: string;
}

export interface SuggestionPromptMessage {
  role: 'user' | 'agent';
  text: string;
  truncated: boolean;
}

function codePoints(text: string): string[] {
  return Array.from(text);
}

/** The last `limit` code points of `text`, with whether anything was cut. */
function tail(text: string, limit: number): { text: string; truncated: boolean } {
  const points = codePoints(text);
  if (points.length <= limit) return { text, truncated: false };
  return { text: points.slice(points.length - Math.max(0, limit)).join(''), truncated: true };
}

/** Whether a message is visible conversation text that a suggestion may be made from. */
export function isSuggestionSource(message: SuggestionSourceMessage): boolean {
  if (message.role !== 'user' && message.role !== 'agent') return false;
  if (message.isError || message.runtimeNotice || message.noticeKey !== undefined) return false;
  if (message.incompleteReply !== undefined || message.interruptedReply) return false;
  if (message.compactionSummary !== undefined) return false;
  return typeof message.text === 'string' && message.text.trim().length > 0;
}

/**
 * Choose the text a suggestion is made from. Redacted first, then counted. Returns nothing when the conversation does
 * not end with an answer that follows a user message.
 */
export function selectSuggestionInput(messages: readonly SuggestionSourceMessage[]): SuggestionPromptMessage[] {
  const visible = messages.filter(isSuggestionSource).map((message) => ({
    role: message.role,
    text: redactSecretText(message.text),
  }));
  const recent = visible.slice(-SUGGESTION_MAX_MESSAGES);
  if (recent.length === 0 || recent[recent.length - 1].role !== 'agent') return [];
  const lastAnswerIndex = recent.length - 1;
  let lastUserIndex = -1;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    if (recent[index].role === 'user') { lastUserIndex = index; break; }
  }
  const chosen = new Map<number, SuggestionPromptMessage>();
  const answer = tail(recent[lastAnswerIndex].text, SUGGESTION_MAX_LAST_ANSWER_CODE_POINTS);
  chosen.set(lastAnswerIndex, { role: 'agent', ...answer });
  let used = codePoints(answer.text).length;
  if (lastUserIndex >= 0) {
    const user = tail(recent[lastUserIndex].text, SUGGESTION_MAX_LAST_USER_CODE_POINTS);
    chosen.set(lastUserIndex, { role: 'user', ...user });
    used += codePoints(user.text).length;
  }
  // The rest of the budget, newest first. A message that does not fit whole keeps its tail; then nothing older.
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    if (chosen.has(index)) continue;
    const remaining = SUGGESTION_MAX_TOTAL_CODE_POINTS - used;
    if (remaining <= 0) break;
    const kept = tail(recent[index].text, remaining);
    chosen.set(index, { role: recent[index].role, ...kept });
    used += codePoints(kept.text).length;
    if (kept.truncated) break;
  }
  return [...chosen.entries()].sort(([a], [b]) => a - b).map(([, message]) => message);
}

/** The instruction the suggestion model receives. Plain words; it is never given tools or a way to act. */
export const SUGGESTION_SYSTEM_PROMPT = [
  'You suggest the next message the user might send in this conversation with their AI assistant.',
  'Reply with exactly one short sentence the user could send, in the language of the user\'s last message,',
  'at most 300 characters, plain text, no quotes, no markdown, no explanation.',
  'Do not promise or approve payments, publishing, deployment, or changes to security or permission settings.',
  'If no useful next message exists, reply with an empty message.',
].join(' ');

/** The chat-completions messages for the chosen input. Truncated messages carry the marker before their tail. */
export function suggestionRequestMessages(input: readonly SuggestionPromptMessage[]): Array<{ role: 'system' | 'user'; content: string }> {
  const transcript = input.map((message) => {
    const speaker = message.role === 'user' ? 'User' : 'Assistant';
    return `${speaker}:\n${message.truncated ? SUGGESTION_TRUNCATION_MARKER : ''}${message.text}`;
  }).join('\n\n');
  return [
    { role: 'system', content: SUGGESTION_SYSTEM_PROMPT },
    { role: 'user', content: `Conversation so far:\n\n${transcript}\n\nSuggest the user's next message.` },
  ];
}

/**
 * The suggestion as it may be shown: one line of plain text of at most 300 code points, or nothing. Output that is
 * not text, is longer than the limit, or carries control characters is not shown at all rather than cut.
 */
export function normalizeSuggestionOutput(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let text = raw.trim();
  // A model that wrapped its sentence in one pair of quotes still gave one sentence.
  const quoted = /^(["'“‘])([\s\S]*)(["'”’])$/u.exec(text);
  if (quoted) text = quoted[2].trim();
  if (!text) return undefined;
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(text) || /[\r\n]/u.test(text)) return undefined;
  if (codePoints(text).length > SUGGESTION_MAX_OUTPUT_CODE_POINTS) return undefined;
  return text;
}
