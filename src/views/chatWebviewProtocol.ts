import { parseStagedAttachmentReference, STAGED_UPLOAD_ID, validateUserAttachments, type UserAttachmentInput } from '../attachments';
import { ChatMode, CodexActPermissionProfile } from '../types';
import { ATTACHMENT_CHUNK_MAX_BYTES } from './attachmentStaging';
import { CHAT_DRAFT_LIMITS, type DraftBackupResult, type DraftSnapshotEntry } from './chatDraftMirror';

/**
 * The chat webview is an untrusted renderer. These are its complete, bounded requests to the host.
 * Parsing a message proves only its transport shape; every handler must still resolve ids and authority
 * from host-owned state.
 */
export type ChatWebviewInboundMessage =
  | {
      command: 'send'; agentId: string; text: string; mode?: ChatMode; requestId?: string;
      /**
       * v0.9.99: each file inline, or (from the composer) named by the upload id of the copy the host already holds.
       * The host resolves an upload id only from its own staged copies of the view that sent it.
       */
      attachments: UserAttachmentInput[];
      /** v0.9.99: what the host could not take of the attachments named, one sentence per file, for the person. */
      attachmentErrors?: string[];
      /** v0.9.96: the Workbench page's generation and the draft revision it sends, so its saved copy is retired. */
      draftSurface?: string; draftRevision?: number;
      /** v0.9.99: the Send this is, when it waited for its files; announced at the click by `sendWaiting`. */
      intentId?: string;
      /** v0.9.99: the last Stop generation the composer had seen when Send was pressed. */
      stopSeen?: number;
    }
  /**
   * v0.9.99: the person pressed Send while files of the message were still being attached. The host counts the message
   * as being prepared from this click, so a Stop of the person ends it as it ends any message not yet sent.
   */
  | { command: 'sendWaiting'; agentId: string; intentId: string; stopSeen?: number }
  /** v0.9.99: the waiting Send ended without being sent (its files were removed, or a Stop ended it). */
  | { command: 'sendWaitingEnd'; intentId: string }
  /**
   * v0.9.99: piece `index` of a file the composer is attaching, base64. Piece 0 starts the upload; `total` is the
   * file's size in bytes. The host acknowledges each piece.
   */
  | { command: 'attachmentChunk'; uploadId: string; index: number; total: number; data: string }
  /** v0.9.99: the person removed a file before sending; the host lets go of its copy. */
  | { command: 'attachmentDiscard'; uploadId: string }
  /**
   * v0.9.96: one composer edit of the live Workbench page, for the host's saved copy. Empty text deletes the copy;
   * `overLimit` says the page holds more than the copy keeps, and carries no text.
   */
  | { command: 'draftEdit'; surface: string; agentId: string; text: string; revision: number; epoch: number; overLimit?: true }
  /** v0.9.96: the drafts a restored Workbench page holds, once when it starts. */
  | { command: 'draftSync'; surface: string; drafts: DraftSyncEntry[] }
  | { command: 'interrupt'; agentId: string }
  | { command: 'selectAgent'; agentId: string }
  /** Hides one host-projected reminder group; never an approval or repair answer. */
  | { command: 'dismissNotice'; agentId: string; noticeKey: string }
  | { command: 'setMode'; agentId: string; mode: ChatMode }
  | { command: 'approvalDecision'; id: string; action?: string; note?: string }
  | { command: 'setApproval'; kind: 'command' | 'write'; value: string }
  | { command: 'setCodexPermissionProfile'; agentId: string; profile: CodexActPermissionProfile }
  | { command: 'compactContext' }
  | { command: 'focusEditor' }
  /** v0.9.97: the Workbench's Edit history close button or Escape. The host closes it; the page changes nothing itself. */
  | { command: 'closeInspector' }
  | { command: 'openCheckpointDiff'; checkpointId: number }
  | { command: 'restoreCheckpoint'; checkpointId: number }
  | { command: 'openToolFile'; agentId: string; toolId: string }
  /**
   * v0.9.97: a click on a file link in a reply. It names the conversation shown and the link's host-issued id, and
   * nothing else: no path, folder, URI, command or claim of authority.
   */
  | { command: 'openFileReference'; agentId: string; referenceId: string }
  | { command: 'repairAction'; kind: 'no-team' | 'missing-connection' | 'missing-credential' }
  | {
      command: 'repairAction';
      kind: 'configure-agent-model' | 'retry-delegation' | 'retry-same-route' | 'switch-route' | 'stop-request';
      outcomeId: string;
    }
  | { command: 'chatCommand'; target: string }
  | { command: 'handoffToSolo'; id: string }
  /** v0.9.93: one explicit action on a Job outcome card. The card is named by its id; the host resolves the run. */
  | { command: 'jobOutcomeAction'; outcomeId: string; action: JobOutcomeCardAction }
  | { command: 'composerInsertionApplied'; revision: number }
  | { command: 'accessibilityFocus'; focused: boolean }
  /** The webview's receipt for one attention chime: whether Web Audio actually started playing it. */
  | { command: 'attentionResult'; id: string; audioState: AttentionAudioState; started: boolean }
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

/** The actions a Job outcome card can ask for. Which of them a given card offers is decided by the host. */
export const JOB_OUTCOME_CARD_ACTIONS = ['reviewChanges', 'openEvidence', 'continueUnfinished', 'changeTarget', 'resetCounter'] as const;
export type JobOutcomeCardAction = typeof JOB_OUTCOME_CARD_ACTIONS[number];

/**
 * v0.9.92: the live phase of an agent's turn as the host observed it, with the provider's display name. The
 * webview shows it and derives no phase of its own.
 */
export interface ChatTurnPhase {
  progressSummary?: string;
  lastActivityAt?: string;
  preparingTool?: boolean;
  phase: 'host' | 'provider-wait' | 'reasoning' | 'responding' | 'tool' | 'compacting';
  phaseStartedAt: string;
  turnStartedAt: string;
  openTools: number;
  /** The turn time so far without human waits, true at `observedAt`; it stands still while an approval is pending. */
  activeMs: number;
  /** The same measure for the current phase alone. */
  phaseActiveMs: number;
  /** Tool calls that have been open in the current tool phase. Only with one is the phase time that call's own. */
  phaseToolCalls: number;
  observedAt: string;
  approvalPending: boolean;
  approvalStartedAt?: string;
  provider: string;
}

/** Outbound names are declared here too, so host send sites cannot invent a receiver-only command. */
export type ChatWebviewOutboundMessage =
  | { command: 'state'; state: unknown; announce: boolean }
  /** `draftSeq` marks the Workbench's saved copy of the sent text as sent (v0.9.96). */
  | { command: 'sendAccepted'; requestId?: string; draftSeq?: number }
  | { command: 'sendRejected'; requestId?: string; reason: string; requestedAgentId: string; selectedAgentId: string }
  /**
   * v0.9.99: a Send waiting for its files is ended. By `intentId`: the host ended the one it was told of (a Stop, a
   * removal or a clear). By `agentIds` or `all`: a Stop of the person for those agents, also of a Send whose click has
   * not reached the host yet.
   */
  | { command: 'sendWaitingStopped'; intentId: string; reason?: string }
  | { command: 'sendWaitingStopped'; agentIds: string[]; stopGeneration: number }
  | { command: 'sendWaitingStopped'; all: true; stopGeneration: number }
  | { command: 'liveBlocks'; agentId: string; kind: 'message' | 'reasoning'; replaceFrom: number; blocks: unknown[]; flush: boolean; epoch: number; turnStartedAt?: string; fromName?: string }
  /** Legacy stream frames remain declared while the live-block transport is the active producer. */
  | { command: 'delta'; agentId: string; blocks?: unknown[]; epoch?: number; turnStartedAt?: string; fromName?: string }
  | { command: 'reasoningDelta'; agentId: string; blocks?: unknown[]; epoch?: number; turnStartedAt?: string }
  | { command: 'transcriptItem'; agentId: string; item: unknown; epoch: number }
  | { command: 'toolAppended'; agentId: string; item: unknown; epoch: number; turnStartedAt?: string }
  | { command: 'toolUpdated'; agentId: string; item: unknown; epoch: number; turnStartedAt?: string }
  /** The host's phase for one agent's turn changed; no `turnPhase` means that no turn of this agent is live. */
  | { command: 'turnPhase'; agentId: string; turnPhase?: ChatTurnPhase }
  | { command: 'toggleComposerFocus' }
  | { command: 'focusApproval'; id: string }
  /** Play the attention chime once for a prompt that now waits on the user; the id is opaque and bounded. */
  | { command: 'attention'; id: string }
  /** v0.9.96: what became of the Workbench page's draft edits in the host's saved copy, once the write settled. */
  | { command: 'draftBackup'; surface: string; results: DraftBackupResult[] }
  /** v0.9.96: drafts of a restored page that a later send or agent removal made stale; the page drops them. */
  | { command: 'draftDropped'; surface: string; agentIds: string[] }
  /**
   * v0.9.99: the host kept piece `index` of an upload (`received` bytes so far), or could not, and why in the person's
   * words; after an error the upload is over and its file is not attached.
   */
  | { command: 'attachmentChunkAck'; uploadId: string; index: number; received?: number; error?: string };

/** One draft of a restored Workbench page. An over-limit draft carries no text, only the fact. */
export type DraftSyncEntry = DraftSnapshotEntry & { overLimit?: true };

export const CHAT_WEBVIEW_OUTBOUND_COMMANDS = [
  'state',
  'sendAccepted',
  'sendRejected',
  'sendWaitingStopped',
  'liveBlocks',
  'delta',
  'reasoningDelta',
  'transcriptItem',
  'toolAppended',
  'toolUpdated',
  'turnPhase',
  'toggleComposerFocus',
  'focusApproval',
  'attention',
  'draftBackup',
  'draftDropped',
  'attachmentChunkAck',
] as const satisfies readonly ChatWebviewOutboundMessage['command'][];

/** Web Audio states a webview may report, plus the two it reports when there is no usable context. */
export const ATTENTION_AUDIO_STATES = ['running', 'suspended', 'closed', 'interrupted', 'unavailable', 'error'] as const;
export type AttentionAudioState = typeof ATTENTION_AUDIO_STATES[number];
/** An attention id is host-generated and opaque; it never carries a path or other prompt content. */
export const ATTENTION_ID_MAX = 64;

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
  /** A Workbench page generation is a host-issued UUID. */
  draftSurface: 64,
  /** v0.9.97: a file link id is a reply sequence and a 16-digit digest. */
  fileReferenceId: 40,
} as const;
/** The only shape a file link id has; anything else is refused before a handler sees it. */
const FILE_REFERENCE_ID = /^\d{1,15}\.[0-9a-f]{16}$/;
const NOTE_MAX = 16_384;
const TEXT_MAX = 1_000_000;

const INBOUND_FIELDS: Record<string, readonly string[]> = {
  send: ['command', 'agentId', 'text', 'mode', 'attachments', 'requestId', 'draftSurface', 'draftRevision', 'intentId', 'stopSeen'],
  sendWaiting: ['command', 'agentId', 'intentId', 'stopSeen'],
  sendWaitingEnd: ['command', 'intentId'],
  attachmentChunk: ['command', 'uploadId', 'index', 'total', 'data'],
  attachmentDiscard: ['command', 'uploadId'],
  draftEdit: ['command', 'surface', 'agentId', 'text', 'revision', 'epoch', 'overLimit'],
  draftSync: ['command', 'surface', 'drafts'],
  interrupt: ['command', 'agentId'],
  selectAgent: ['command', 'agentId'],
  dismissNotice: ['command', 'agentId', 'noticeKey'],
  setMode: ['command', 'agentId', 'mode'],
  approvalDecision: ['command', 'id', 'action', 'note'],
  setApproval: ['command', 'kind', 'value'],
  setCodexPermissionProfile: ['command', 'agentId', 'profile'],
  compactContext: ['command'],
  focusEditor: ['command'],
  closeInspector: ['command'],
  openCheckpointDiff: ['command', 'checkpointId'],
  restoreCheckpoint: ['command', 'checkpointId'],
  openToolFile: ['command', 'agentId', 'toolId'],
  openFileReference: ['command', 'agentId', 'referenceId'],
  repairAction: ['command', 'kind', 'outcomeId'],
  chatCommand: ['command', 'target'],
  handoffToSolo: ['command', 'id'],
  jobOutcomeAction: ['command', 'outcomeId', 'action'],
  composerInsertionApplied: ['command', 'revision'],
  accessibilityFocus: ['command', 'focused'],
  attentionResult: ['command', 'id', 'audioState', 'started'],
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
      const draftSurface = optionalString(value.draftSurface, CHAT_WEBVIEW_PROTOCOL_LIMITS.draftSurface, 'draftSurface');
      const draftRevision = optionalNonNegativeSafeInteger(value.draftRevision, 'draftRevision');
      const intentId = optionalString(value.intentId, CHAT_WEBVIEW_PROTOCOL_LIMITS.requestId, 'intentId');
      const stopSeen = optionalNonNegativeSafeInteger(value.stopSeen, 'stopSeen');
      if (!agentId.ok || !text.ok || !mode.ok || !requestId.ok || !draftSurface.ok || !draftRevision.ok || !intentId.ok || !stopSeen.ok) {
        return firstFailure(agentId, text, mode, requestId, draftSurface, draftRevision, intentId, stopSeen);
      }
      if ((draftSurface.value === undefined) !== (draftRevision.value === undefined)) {
        return reject('draftSurface and draftRevision come together');
      }
      if (value.attachments !== undefined && !Array.isArray(value.attachments)) return reject('attachments must be an array');
      const { attachments, errors: attachmentErrors } = parseSendAttachments(value.attachments);
      return accept({
        command, agentId: agentId.value, text: text.value, ...(mode.value ? { mode: mode.value } : {}), attachments,
        ...(attachmentErrors.length > 0 ? { attachmentErrors } : {}),
        ...(requestId.value ? { requestId: requestId.value } : {}),
        ...(draftSurface.value !== undefined && draftRevision.value !== undefined
          ? { draftSurface: draftSurface.value, draftRevision: draftRevision.value } : {}),
        ...(intentId.value ? { intentId: intentId.value } : {}),
        ...(stopSeen.value !== undefined ? { stopSeen: stopSeen.value } : {}),
      });
    }
    case 'sendWaiting': {
      const agentId = stringField(value.agentId, CHAT_WEBVIEW_PROTOCOL_LIMITS.agentId, 'agentId');
      const intentId = stringField(value.intentId, CHAT_WEBVIEW_PROTOCOL_LIMITS.requestId, 'intentId');
      const stopSeen = optionalNonNegativeSafeInteger(value.stopSeen, 'stopSeen');
      return agentId.ok && intentId.ok && stopSeen.ok
        ? accept({ command, agentId: agentId.value, intentId: intentId.value, ...(stopSeen.value !== undefined ? { stopSeen: stopSeen.value } : {}) })
        : firstFailure(agentId, intentId, stopSeen);
    }
    case 'sendWaitingEnd': {
      const intentId = stringField(value.intentId, CHAT_WEBVIEW_PROTOCOL_LIMITS.requestId, 'intentId');
      return intentId.ok ? accept({ command, intentId: intentId.value }) : intentId;
    }
    case 'attachmentChunk': {
      const uploadId = uploadIdField(value.uploadId);
      const index = nonNegativeSafeInteger(value.index, 'index');
      const total = nonNegativeSafeInteger(value.total, 'total');
      if (!uploadId.ok || !index.ok || !total.ok) return firstFailure(uploadId, index, total);
      // A piece is bounded; the file is not. The base64 text of one piece is at most 4/3 of its bytes.
      if (typeof value.data !== 'string' || value.data.length > Math.ceil(ATTACHMENT_CHUNK_MAX_BYTES / 3) * 4
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) {
        return reject('data must be a bounded base64 piece');
      }
      return accept({ command, uploadId: uploadId.value, index: index.value, total: total.value, data: value.data });
    }
    case 'attachmentDiscard': {
      const uploadId = uploadIdField(value.uploadId);
      return uploadId.ok ? accept({ command, uploadId: uploadId.value }) : uploadId;
    }
    case 'draftEdit':
      return parseDraftEdit(value);
    case 'draftSync':
      return parseDraftSync(value);
    case 'interrupt':
    case 'selectAgent': {
      const agentId = stringField(value.agentId, CHAT_WEBVIEW_PROTOCOL_LIMITS.agentId, 'agentId');
      return agentId.ok ? accept({ command, agentId: agentId.value }) : agentId;
    }
    case 'dismissNotice': {
      const agentId = stringField(value.agentId, CHAT_WEBVIEW_PROTOCOL_LIMITS.agentId, 'agentId');
      const noticeKey = stringField(value.noticeKey, 71, 'noticeKey');
      if (!agentId.ok || !noticeKey.ok) return firstFailure(agentId, noticeKey);
      return /^notice:[0-9a-f]{64}$/.test(noticeKey.value)
        ? accept({ command, agentId: agentId.value, noticeKey: noticeKey.value }) : reject('invalid noticeKey');
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
    case 'setCodexPermissionProfile': {
      const agentId = stringField(value.agentId, CHAT_WEBVIEW_PROTOCOL_LIMITS.agentId, 'agentId');
      const profile = value.profile === 'ask-for-approval'
        || value.profile === 'approve-for-me'
        || value.profile === 'full-access'
        ? value.profile : undefined;
      if (!profile) return reject('profile is invalid');
      return agentId.ok ? accept({ command, agentId: agentId.value, profile }) : agentId;
    }
    case 'compactContext':
    case 'focusEditor':
    case 'closeInspector':
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
    case 'openFileReference': {
      const agentId = stringField(value.agentId, CHAT_WEBVIEW_PROTOCOL_LIMITS.agentId, 'agentId');
      const referenceId = stringField(value.referenceId, CHAT_WEBVIEW_PROTOCOL_LIMITS.fileReferenceId, 'referenceId');
      if (!agentId.ok || !referenceId.ok) return firstFailure(agentId, referenceId);
      return FILE_REFERENCE_ID.test(referenceId.value)
        ? accept({ command, agentId: agentId.value, referenceId: referenceId.value })
        : reject('referenceId is not a file link id');
    }
    case 'repairAction': {
      const kind = value.kind;
      if (kind === 'no-team' || kind === 'missing-connection' || kind === 'missing-credential') {
        return value.outcomeId === undefined ? accept({ command, kind }) : reject('readiness repair cannot name an outcome');
      }
      if (kind === 'configure-agent-model' || kind === 'retry-delegation'
        || kind === 'retry-same-route' || kind === 'switch-route' || kind === 'stop-request') {
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
    case 'jobOutcomeAction': {
      const outcomeId = stringField(value.outcomeId, CHAT_WEBVIEW_PROTOCOL_LIMITS.opaqueId, 'outcomeId');
      if (!outcomeId.ok) return outcomeId;
      const action = JOB_OUTCOME_CARD_ACTIONS.find((candidate) => candidate === value.action);
      return action ? accept({ command, outcomeId: outcomeId.value, action }) : reject('action is not a card action');
    }
    case 'composerInsertionApplied': {
      const revision = nonNegativeSafeInteger(value.revision, 'revision');
      return revision.ok ? accept({ command, revision: revision.value }) : revision;
    }
    case 'accessibilityFocus':
      return typeof value.focused === 'boolean' ? accept({ command, focused: value.focused }) : reject('focused must be boolean');
    case 'attentionResult': {
      const id = stringField(value.id, ATTENTION_ID_MAX, 'id');
      if (!id.ok) return id;
      if (!ATTENTION_AUDIO_STATES.includes(value.audioState as AttentionAudioState)) return reject('audioState is not a known state');
      if (typeof value.started !== 'boolean') return reject('started must be boolean');
      return accept({ command, id: id.value, audioState: value.audioState as AttentionAudioState, started: value.started });
    }
    case 'renderedTranscriptItemsMissing':
      return parseRenderedTranscriptItemsMissing(value);
    default:
      return reject(`webview cannot send ${command}`);
  }
}

/** One draft as the page reports it. Text beyond the copy's per-draft limit is never carried: the page says so instead. */
function draftEntry(value: Record<string, unknown>, withBasis: boolean): Parse<DraftSyncEntry> {
  const agentId = stringField(value.agentId, CHAT_WEBVIEW_PROTOCOL_LIMITS.agentId, 'agentId');
  const revision = nonNegativeSafeInteger(value.revision, 'revision');
  const epoch = nonNegativeSafeInteger(value.epoch, 'epoch');
  const basis: Parse<number> = withBasis ? nonNegativeSafeInteger(value.basis, 'basis') : { ok: true, value: 0 };
  if (!agentId.ok || !revision.ok || !epoch.ok || !basis.ok) return firstFailure(agentId, revision, epoch, basis);
  if (typeof value.text !== 'string' || value.text.length > CHAT_DRAFT_LIMITS.draftChars) return reject('draft text must be a bounded string');
  if (value.overLimit !== undefined && (value.overLimit !== true || value.text !== '')) return reject('an over-limit draft carries no text');
  return {
    ok: true,
    value: {
      agentId: agentId.value, text: value.text, revision: revision.value, epoch: epoch.value, basis: basis.value,
      ...(value.overLimit === true ? { overLimit: true as const } : {}),
    },
  };
}

function parseDraftEdit(value: Record<string, unknown>): ChatWebviewInboundParse {
  const surface = stringField(value.surface, CHAT_WEBVIEW_PROTOCOL_LIMITS.draftSurface, 'surface');
  if (!surface.ok) return surface;
  const entry = draftEntry(value, false);
  if (!entry.ok) return entry;
  const { basis: _basis, ...edit } = entry.value;
  return accept({ command: 'draftEdit', surface: surface.value, ...edit });
}

const DRAFT_SYNC_FIELDS = ['agentId', 'text', 'revision', 'epoch', 'basis', 'overLimit'];

function parseDraftSync(value: Record<string, unknown>): ChatWebviewInboundParse {
  const surface = stringField(value.surface, CHAT_WEBVIEW_PROTOCOL_LIMITS.draftSurface, 'surface');
  if (!surface.ok) return surface;
  if (!Array.isArray(value.drafts) || value.drafts.length > CHAT_DRAFT_LIMITS.drafts) return reject('drafts must be a bounded array');
  const drafts: DraftSyncEntry[] = [];
  const seen = new Set<string>();
  for (const item of value.drafts) {
    if (!isRecord(item) || Object.keys(item).some((key) => !DRAFT_SYNC_FIELDS.includes(key))) return reject('draft is invalid');
    const entry = draftEntry(item, true);
    if (!entry.ok) return entry;
    if (seen.has(entry.value.agentId)) return reject('a draft is listed twice');
    seen.add(entry.value.agentId);
    drafts.push(entry.value);
  }
  return accept({ command: 'draftSync', surface: surface.value, drafts });
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

function uploadIdField(value: unknown): Parse<string> {
  return typeof value === 'string' && STAGED_UPLOAD_ID.test(value) ? { ok: true, value } : reject('uploadId is invalid');
}

/**
 * v0.9.99: a send's attachments in the order the view lists them: inline files checked by the host validator, and
 * staged files by their metadata and upload id (their bytes are the host's own copy). A file that fails is skipped
 * and named in `errors`, so the person is told; it never fails the send.
 */
function parseSendAttachments(raw: unknown): { attachments: UserAttachmentInput[]; errors: string[] } {
  const attachments: UserAttachmentInput[] = [];
  const errors: string[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (isRecord(item) && item.uploadId !== undefined) {
      const staged = parseStagedAttachmentReference(item);
      if (staged.ok) attachments.push(staged.value); else errors.push(staged.error);
      continue;
    }
    const inline = validateUserAttachments([item]);
    attachments.push(...inline.attachments);
    errors.push(...inline.errors);
  }
  return { attachments, errors };
}

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
