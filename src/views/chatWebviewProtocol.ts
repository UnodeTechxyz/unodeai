import { validateUserAttachments } from '../attachments';
import { ChatMode, UserAttachment } from '../types';

/**
 * The chat webview is an untrusted renderer. These are its complete, bounded requests to the host.
 * Parsing a message proves only its transport shape; every handler must still resolve ids and authority
 * from host-owned state.
 */
export type ChatWebviewInboundMessage =
  | { command: 'send'; agentId: string; text: string; mode?: ChatMode; attachments: UserAttachment[]; requestId?: string }
  | { command: 'interrupt'; agentId: string }
  | { command: 'selectAgent'; agentId: string }
  | { command: 'setMode'; agentId: string; mode: ChatMode }
  | { command: 'approvalDecision'; id: string; action?: string; note?: string }
  | { command: 'setApproval'; kind: 'command' | 'write'; value: string }
  | { command: 'compactContext' }
  | { command: 'focusEditor' }
  | { command: 'openCheckpointDiff'; checkpointId: number }
  | { command: 'restoreCheckpoint'; checkpointId: number }
  | { command: 'openToolFile'; agentId: string; toolId: string }
  | { command: 'repairAction'; kind: 'no-team' | 'missing-connection' | 'missing-credential' }
  | { command: 'repairAction'; kind: 'configure-agent-model' | 'retry-delegation'; outcomeId: string }
  | { command: 'chatCommand'; target: string }
  | { command: 'handoffToSolo'; id: string }
  | { command: 'composerInsertionApplied'; revision: number }
  | { command: 'accessibilityFocus'; focused: boolean }
  | {
      command: 'renderedTranscriptItemsMissing';
      agentId: string;
      cause: 'window-trim' | 'unexplained';
      previousItemCount: number;
      nextItemCount: number;
      missing: Array<{ id: string; delivery: 'live' | 'committed' }>;
      previousTurnEpoch?: number;
      nextTurnEpoch?: number;
      epochChanged: boolean;
    };

/** Outbound names are declared here too, so host send sites cannot invent a receiver-only command. */
export type ChatWebviewOutboundMessage =
  | { command: 'state'; state: unknown; announce: boolean }
  | { command: 'sendAccepted'; requestId?: string }
  | { command: 'sendRejected'; requestId?: string; reason: string; requestedAgentId: string; selectedAgentId: string }
  | { command: 'liveBlocks'; agentId: string; kind: 'message' | 'reasoning'; replaceFrom: number; blocks: unknown[]; flush: boolean; epoch: number; turnStartedAt?: string; fromName?: string }
  /** Legacy stream frames remain declared while the live-block transport is the active producer. */
  | { command: 'delta'; agentId: string; blocks?: unknown[]; epoch?: number; turnStartedAt?: string; fromName?: string }
  | { command: 'reasoningDelta'; agentId: string; blocks?: unknown[]; epoch?: number; turnStartedAt?: string }
  | { command: 'transcriptItem'; agentId: string; item: unknown; epoch: number }
  | { command: 'toolAppended'; agentId: string; item: unknown; epoch: number; turnStartedAt?: string }
  | { command: 'toolUpdated'; agentId: string; item: unknown; epoch: number; turnStartedAt?: string }
  | { command: 'toggleComposerFocus' }
  | { command: 'focusApproval'; id: string };

export const CHAT_WEBVIEW_OUTBOUND_COMMANDS = [
  'state',
  'sendAccepted',
  'sendRejected',
  'liveBlocks',
  'delta',
  'reasoningDelta',
  'transcriptItem',
  'toolAppended',
  'toolUpdated',
  'toggleComposerFocus',
  'focusApproval',
] as const satisfies readonly ChatWebviewOutboundMessage['command'][];

export type ChatWebviewInboundParse =
  | { ok: true; message: ChatWebviewInboundMessage }
  | { ok: false; reason: string };

/**
 * Webview strings are untrusted input. Keep these caps named and exported so the
 * parser and its boundary tests cannot silently drift apart.
 */
export const CHAT_WEBVIEW_PROTOCOL_LIMITS = {
  agentId: 160,
  toolId: 240,
  opaqueId: 240,
  requestId: 120,
} as const;
const NOTE_MAX = 16_384;
const TEXT_MAX = 1_000_000;

const INBOUND_FIELDS: Record<string, readonly string[]> = {
  send: ['command', 'agentId', 'text', 'mode', 'attachments', 'requestId'],
  interrupt: ['command', 'agentId'],
  selectAgent: ['command', 'agentId'],
  setMode: ['command', 'agentId', 'mode'],
  approvalDecision: ['command', 'id', 'action', 'note'],
  setApproval: ['command', 'kind', 'value'],
  compactContext: ['command'],
  focusEditor: ['command'],
  openCheckpointDiff: ['command', 'checkpointId'],
  restoreCheckpoint: ['command', 'checkpointId'],
  openToolFile: ['command', 'agentId', 'toolId'],
  repairAction: ['command', 'kind', 'outcomeId'],
  chatCommand: ['command', 'target'],
  handoffToSolo: ['command', 'id'],
  composerInsertionApplied: ['command', 'revision'],
  accessibilityFocus: ['command', 'focused'],
  renderedTranscriptItemsMissing: ['command', 'agentId', 'cause', 'previousItemCount', 'nextItemCount', 'missing', 'previousTurnEpoch', 'nextTurnEpoch', 'epochChanged'],
};

/** Parse exactly once at the webview boundary. Never turn an invalid message into a permissive default. */
export function parseChatWebviewInboundMessage(value: unknown): ChatWebviewInboundParse {
  if (!isRecord(value)) return reject('message is not an object');
  const command = value.command;
  if (typeof command !== 'string') return reject('command is missing');
  if (!INBOUND_FIELDS[command]) return reject(`unknown command ${command.slice(0, 80)}`);
  if (Object.keys(value).some((key) => !INBOUND_FIELDS[command].includes(key))) {
    return reject(`command ${command} contains an unexpected field`);
  }

  switch (command) {
    case 'send': {
      const agentId = stringField(value.agentId, CHAT_WEBVIEW_PROTOCOL_LIMITS.agentId, 'agentId');
      const text = textField(value.text);
      const mode = optionalMode(value.mode);
      const requestId = optionalString(value.requestId, CHAT_WEBVIEW_PROTOCOL_LIMITS.requestId, 'requestId');
      if (!agentId.ok || !text.ok || !mode.ok || !requestId.ok) return firstFailure(agentId, text, mode, requestId);
      if (value.attachments !== undefined && !Array.isArray(value.attachments)) return reject('attachments must be an array');
      const attachments = validateUserAttachments(value.attachments).attachments;
      return accept({ command, agentId: agentId.value, text: text.value, ...(mode.value ? { mode: mode.value } : {}), attachments, ...(requestId.value ? { requestId: requestId.value } : {}) });
    }
    case 'interrupt':
    case 'selectAgent': {
      const agentId = stringField(value.agentId, CHAT_WEBVIEW_PROTOCOL_LIMITS.agentId, 'agentId');
      return agentId.ok ? accept({ command, agentId: agentId.value }) : agentId;
    }
    case 'setMode': {
      const agentId = stringField(value.agentId, CHAT_WEBVIEW_PROTOCOL_LIMITS.agentId, 'agentId');
      const mode = requiredMode(value.mode);
      return agentId.ok && mode.ok ? accept({ command, agentId: agentId.value, mode: mode.value }) : firstFailure(agentId, mode);
    }
    case 'approvalDecision': {
      const id = stringField(value.id, CHAT_WEBVIEW_PROTOCOL_LIMITS.opaqueId, 'id');
      const action = optionalString(value.action, 80, 'action');
      const note = optionalString(value.note, NOTE_MAX, 'note');
      return id.ok && action.ok && note.ok
        ? accept({ command, id: id.value, ...(action.value ? { action: action.value } : {}), ...(note.value ? { note: note.value } : {}) })
        : firstFailure(id, action, note);
    }
    case 'setApproval': {
      const kind = value.kind === 'command' || value.kind === 'write' ? value.kind : undefined;
      const setting = stringField(value.value, 80, 'value');
      if (!kind) return reject('kind is invalid');
      return setting.ok ? accept({ command, kind, value: setting.value }) : setting;
    }
    case 'compactContext':
    case 'focusEditor':
      return accept({ command });
    case 'openCheckpointDiff':
    case 'restoreCheckpoint': {
      const checkpointId = nonNegativeSafeInteger(value.checkpointId, 'checkpointId');
      return checkpointId.ok ? accept({ command, checkpointId: checkpointId.value }) : checkpointId;
    }
    case 'openToolFile': {
      const agentId = stringField(value.agentId, CHAT_WEBVIEW_PROTOCOL_LIMITS.agentId, 'agentId');
      const toolId = stringField(value.toolId, CHAT_WEBVIEW_PROTOCOL_LIMITS.toolId, 'toolId');
      return agentId.ok && toolId.ok ? accept({ command, agentId: agentId.value, toolId: toolId.value }) : firstFailure(agentId, toolId);
    }
    case 'repairAction': {
      const kind = value.kind;
      if (kind === 'no-team' || kind === 'missing-connection' || kind === 'missing-credential') {
        return value.outcomeId === undefined ? accept({ command, kind }) : reject('readiness repair cannot name an outcome');
      }
      if (kind === 'configure-agent-model' || kind === 'retry-delegation') {
        const outcomeId = stringField(value.outcomeId, CHAT_WEBVIEW_PROTOCOL_LIMITS.opaqueId, 'outcomeId');
        return outcomeId.ok ? accept({ command, kind, outcomeId: outcomeId.value }) : outcomeId;
      }
      return reject('repair kind is invalid');
    }
    case 'chatCommand': {
      const target = stringField(value.target, CHAT_WEBVIEW_PROTOCOL_LIMITS.opaqueId, 'target');
      return target.ok ? accept({ command, target: target.value }) : target;
    }
    case 'handoffToSolo': {
      const id = stringField(value.id, CHAT_WEBVIEW_PROTOCOL_LIMITS.opaqueId, 'id');
      return id.ok ? accept({ command, id: id.value }) : id;
    }
    case 'composerInsertionApplied': {
      const revision = nonNegativeSafeInteger(value.revision, 'revision');
      return revision.ok ? accept({ command, revision: revision.value }) : revision;
    }
    case 'accessibilityFocus':
      return typeof value.focused === 'boolean' ? accept({ command, focused: value.focused }) : reject('focused must be boolean');
    case 'renderedTranscriptItemsMissing':
      return parseRenderedTranscriptItemsMissing(value);
    default:
      return reject(`webview cannot send ${command}`);
  }
}

function parseRenderedTranscriptItemsMissing(value: Record<string, unknown>): ChatWebviewInboundParse {
  const agentId = stringField(value.agentId, CHAT_WEBVIEW_PROTOCOL_LIMITS.agentId, 'agentId');
  const cause = value.cause === 'window-trim' || value.cause === 'unexplained' ? value.cause : undefined;
  const previousItemCount = boundedSafeInteger(value.previousItemCount, 256, 'previousItemCount');
  const nextItemCount = boundedSafeInteger(value.nextItemCount, 256, 'nextItemCount');
  const missing = parseMissing(value.missing);
  const previousTurnEpoch = optionalNonNegativeSafeInteger(value.previousTurnEpoch, 'previousTurnEpoch');
  const nextTurnEpoch = optionalNonNegativeSafeInteger(value.nextTurnEpoch, 'nextTurnEpoch');
  if (!agentId.ok || !cause || !previousItemCount.ok || !nextItemCount.ok || !missing.ok || !previousTurnEpoch.ok || !nextTurnEpoch.ok || typeof value.epochChanged !== 'boolean') {
    return reject('rendered transcript observation is malformed');
  }
  return accept({
    command: 'renderedTranscriptItemsMissing',
    agentId: agentId.value,
    cause,
    previousItemCount: previousItemCount.value,
    nextItemCount: nextItemCount.value,
    missing: missing.value,
    ...(previousTurnEpoch.value === undefined ? {} : { previousTurnEpoch: previousTurnEpoch.value }),
    ...(nextTurnEpoch.value === undefined ? {} : { nextTurnEpoch: nextTurnEpoch.value }),
    epochChanged: value.epochChanged,
  });
}

function parseMissing(value: unknown): Parse<Array<{ id: string; delivery: 'live' | 'committed' }>> {
  if (!Array.isArray(value) || value.length > 256) return reject('missing must be a bounded array');
  const result: Array<{ id: string; delivery: 'live' | 'committed' }> = [];
  for (const item of value) {
    if (!isRecord(item)) return reject('missing item is invalid');
    const id = stringField(item.id, CHAT_WEBVIEW_PROTOCOL_LIMITS.opaqueId, 'missing.id');
    if (!id.ok || (item.delivery !== 'live' && item.delivery !== 'committed')) return reject('missing item is invalid');
    result.push({ id: id.value, delivery: item.delivery });
  }
  return { ok: true, value: result };
}

type Parse<T> = { ok: true; value: T } | { ok: false; reason: string };

function accept(message: ChatWebviewInboundMessage): ChatWebviewInboundParse {
  return { ok: true, message };
}

function reject(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function firstFailure(...values: Array<Parse<unknown>>): { ok: false; reason: string } {
  return values.find((value): value is { ok: false; reason: string } => !value.ok) ?? reject('message is invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: unknown, max: number, name: string): Parse<string> {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? { ok: true, value }
    : reject(`${name} must be a bounded non-empty string`);
}

/** A send may legitimately carry attachments with an empty text field. */
function textField(value: unknown): Parse<string> {
  return typeof value === 'string' && value.length <= TEXT_MAX
    ? { ok: true, value }
    : reject('text must be a bounded string');
}

function optionalString(value: unknown, max: number, name: string): Parse<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return typeof value === 'string' && value.length <= max
    ? { ok: true, value }
    : reject(`${name} must be a bounded string`);
}

function requiredMode(value: unknown): Parse<ChatMode> {
  return value === 'plan' || value === 'act' ? { ok: true, value } : reject('mode is invalid');
}

function optionalMode(value: unknown): Parse<ChatMode | undefined> {
  return value === undefined ? { ok: true, value: undefined } : requiredMode(value);
}

function nonNegativeSafeInteger(value: unknown, name: string): Parse<number> {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { ok: true, value }
    : reject(`${name} must be a non-negative safe integer`);
}

function boundedSafeInteger(value: unknown, max: number, name: string): Parse<number> {
  const parsed = nonNegativeSafeInteger(value, name);
  return parsed.ok && parsed.value <= max ? parsed : reject(`${name} exceeds ${max}`);
}

function optionalNonNegativeSafeInteger(value: unknown, name: string): Parse<number | undefined> {
  return value === undefined ? { ok: true, value: undefined } : nonNegativeSafeInteger(value, name);
}
