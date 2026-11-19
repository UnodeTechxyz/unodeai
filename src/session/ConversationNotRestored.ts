import type { AgentBackendKind } from '../types';
import type { ConversationRestoreGap } from './SessionManager';

/**
 * v0.9.94: what the person is told, in the agent's chat, when a stored model conversation was not given to the
 * backend that started. A notice of the host: it is never model input.
 *
 * The conversation a model has is kept by its backend, and each backend kind keeps it in a form of its own. When
 * an agent's backend kind changes, what the earlier kind kept cannot be continued, and the model starts with
 * nothing. The messages in Chat stay where they are, so the notice says that the model has not seen them.
 *
 * The same holds for one request at the end of a conversation the backend did take. A request that was never
 * answered is not given back to the model, which would carry it out beside the next one. The person is told
 * to send it again, because that is the only way it is carried out.
 */
export interface ConversationNotRestored {
  reason: ConversationRestoreGap;
  writtenBy?: AgentBackendKind;
  startedAs?: AgentBackendKind;
  restoredMessages?: number;
  quarantinedMessages?: number;
  reasonCodes?: readonly string[];
}

/** Said when the host's own record shows that a request was cut off with its host. */
export const REQUEST_INTERRUPTED_NOTICE =
  'Your earlier request was interrupted and was not resumed. Send it again if you still want it.';

/**
 * Said when a stored conversation ends on a request without an answer and nothing shows that it was cut off: the
 * request may have failed, or the conversation was saved before that was recorded. It does not say "interrupted".
 */
export const REQUEST_UNANSWERED_NOTICE =
  'Your earlier request ended without an answer and was not resumed. Send it again if you still want it.';

/**
 * Said once for a conversation the provider keeps, saved before UnodeAi recorded whether a request had finished.
 * It does not call the last request interrupted: that is not known.
 */
export const LEGACY_CONVERSATION_NOTICE =
  'This conversation was saved by an earlier version of UnodeAi, which did not record whether its last request '
  + 'had finished. The agent starts a new conversation; the messages above stay as history.';

const KIND_NAMES: Record<AgentBackendKind, string> = {
  claude: 'Claude CLI',
  codex: 'Codex CLI',
  'openai-compat': 'an OpenAI-compatible connection',
};

const NEW_CONVERSATION = 'The model starts a new conversation: it has not seen the messages above.';

export function conversationNotRestoredNotice(event: ConversationNotRestored): string | undefined {
  // A backend that keeps no conversation across a start, as the Claude CLI backend does, loses nothing here: its
  // model starts new at every start. What was stored for the agent is an earlier kind's leftover. The log is
  // told; the chat is not, because nothing changes that the person could see.
  if (!event.startedAs) return undefined;
  if (event.reason === 'request-interrupted') return REQUEST_INTERRUPTED_NOTICE;
  if (event.reason === 'request-unanswered') return REQUEST_UNANSWERED_NOTICE;
  if (event.reason === 'legacy-completion-unknown') return LEGACY_CONVERSATION_NOTICE;
  if (event.reason === 'not-a-conversation') {
    return 'UnodeAi: This agent\'s saved model conversation could not be read as a conversation of its provider '
      + `type, so it was discarded and nothing of it is sent. ${NEW_CONVERSATION}`;
  }
  const writer = event.writtenBy ? KIND_NAMES[event.writtenBy] : 'another provider type';
  return `UnodeAi: This agent's saved model conversation was kept by ${writer} and cannot be continued by `
    + `${KIND_NAMES[event.startedAs]}, so it was discarded. ${NEW_CONVERSATION}`;
}

/**
 * The same fact for the log: the reason and the two kinds, and nothing of the conversation. For a request that
 * was left out it adds how many messages were continued, how many were kept out, and the reason codes.
 */
export function conversationNotRestoredLogLine(event: ConversationNotRestored): string {
  return [
    `reason=${event.reason}`,
    ...(event.writtenBy ? [`writtenBy=${event.writtenBy}`] : []),
    ...(event.startedAs ? [`startedAs=${event.startedAs}`] : []),
    ...(event.restoredMessages !== undefined ? [`restoredMessages=${event.restoredMessages}`] : []),
    ...(event.quarantinedMessages !== undefined ? [`quarantinedMessages=${event.quarantinedMessages}`] : []),
    ...(event.reasonCodes?.length ? [`codes=${event.reasonCodes.join(',')}`] : []),
  ].join(' ');
}

/** Said by Agent Builder when an edit changes an existing agent's backend kind. */
export function backendKindChangeNotice(from: AgentBackendKind | undefined, to: AgentBackendKind | undefined): string {
  if (!from || !to || from === to) return '';
  return ` Its provider type changed from ${KIND_NAMES[from]} to ${KIND_NAMES[to]}, so the model starts a new `
    + 'conversation: the earlier messages stay in Chat, but the new model has not seen them.';
}
