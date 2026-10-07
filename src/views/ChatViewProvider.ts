import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendChatMessage,
  CHAT_HISTORY_LIMIT,
  ChatHistoryAttachment,
  chatHistoryKey,
  ChatHistoryMessage,
  clampText,
  deserializeChatHistory,
  MAX_AGENT_MESSAGE_CHARS,
  ChatTurnTrigger,
  ChatVerbatim,
  serializeChatHistory,
  TurnDelegationCounts,
} from './chatHistory';
import type { TurnOutcomeReceiptV1 } from '../session/turnOutcomeReceipt';
import { verbatimReplyBlocks } from './verbatimReply';
import {
  ChatToolActivity,
  chatToolsKey,
  CHAT_TOOLS_LIMIT,
  deserializeToolActivities,
  humanWaitOf,
  serializeToolActivities,
  toolCardFailureKind,
  toolCardOk,
} from './chatToolHistory';
import {
  ArchivedChat,
  CHAT_ARCHIVE_KEY,
  deserializeArchives,
  makeArchiveId,
  serializeArchives,
} from './chatArchive';
import { summarizeToolUse, type ToolResultFact } from '../backend/toolSummary';
import { AgentBackendKind, ChatMode, CodexActPermissionProfile, ContextMeterState, type DelegationCompletionState } from '../types';
import { LiveMarkdown, MarkdownBlock, renderMarkdown } from './markdown';
import { WEBVIEW_LIVE_BLOCKS_SOURCE } from './liveBlocks';
import { WEBVIEW_STREAM_PACING_SOURCE } from './streamPacing';
import { ChatTranscriptAgent } from './transcriptPort';
import { TodoItem, parseTodos } from '../backend/Todos';
import { TurnContextManifest } from '../session/TurnContextManifest';
import { csp, esc, escAttr, nonce } from './webviewSecurity';
import {
  ApprovalAttention,
  ApprovalDecisionBroker,
  ApprovalEvent,
  ApprovalQueue,
  ApprovalKind,
  ApprovalSettings,
  ApprovalRequest,
  ParticipantOutcome,
} from './approvals';
import { DELEGATION_PROGRESS_SUMMARY_LIMIT, DELEGATION_STALLED_AFTER_MS, DelegationProgressSummary } from './orchestrationProgress';
import { UserAttachment } from '../types';
import {
  CHAT_WEBVIEW_OUTBOUND_COMMANDS,
  ChatTurnPhase,
  ChatWebviewInboundMessage,
  ChatWebviewOutboundMessage,
  parseChatWebviewInboundMessage,
  type JobOutcomeCardAction,
} from './chatWebviewProtocol';
import { SessionPresentationModel } from './sessionPresentation';
import type { JobOutcomeViewV1 } from '../observability/JobOutcome';
import {
  anchorEntryId,
  deserializeJobOutcomeAnchors,
  mergeJobOutcomeAnchors,
  sameJobOutcomeAnchors,
  type JobOutcomeAnchorEntry,
  type JobOutcomeAnchorV1,
} from '../observability/JobOutcomeAnchor';
import { Checkpoint } from '../backend/Checkpoints';
import { ChangedFileSummary, groupChangedFilesByAgent } from './checkpointSummary';
import type { TurnPhaseSnapshot, TurnTiming } from '../session/TurnTiming';
import { APPROVAL_DOCK_HYSTERESIS_PX, shouldInlineApprovalDock } from './approvalDockLayout';
import { formatLocalInstant } from './localInstant';

export { ApprovalAttention, ApprovalEvent, ApprovalKind, ApprovalSettings, ApprovalRequest, ApprovalDecision, ResolvedApprovalDecision } from './approvals';

const CHAT_TRANSIENT_ITEM_LIMIT = 40;
export const CHAT_REASONING_LIMIT = CHAT_TRANSIENT_ITEM_LIMIT;
const CHAT_REASONING_KEY_PREFIX = 'roam.chat.reasoning.';
const CHAT_NOTICE_KEYS_PREFIX = 'roam.chat.noticeKeys.';
/**
 * v0.9.93: the outcome anchors of one coordinator's chat. Kept beside the transcript, never in it: an anchor is
 * not a message, so nothing that reads the conversation (history, summary, compaction, token counts) can see it.
 */
const CHAT_JOB_OUTCOMES_KEY_PREFIX = 'roam.chat.jobOutcomes.';
/** Where a card sits after its closing reply: behind the reply and behind a delegation card placed on it. */
const JOB_OUTCOME_SEQ_OFFSET = 0.7;
/** A card that appears this long after its run closed is a restored one, and is not announced. */
const JOB_OUTCOME_ANNOUNCE_WINDOW_MS = 120_000;
/** Notice keys remembered per chat; older ones fall back to the transcript itself for dedupe. */
const CHAT_NOTICE_KEYS_KEPT = 500;
const LIVE_MARKDOWN_FRAME_MS = 16;
/** Live tail past which a frame stops being cheap (see scheduleLiveMarkdownFrame). */
const LIVE_MARKDOWN_HEAVY_TAIL = 16_384;
const LIVE_MARKDOWN_HEAVY_FRAME_MS = 150;

export interface ChatAgent {
  id: string;
  name: string;
  role: string;
  icon?: string;
  backend?: AgentBackendKind;
  /** Codex's Act-mode permission profile; Plan mode is always displayed as read-only. */
  codexPermissionProfile?: 'read-only' | CodexActPermissionProfile;
  codexPermissionCapReason?: string;
  status?: string;
  /** False means a message during a turn is queued as a follow-up, never injected mid-turn. */
  canSteer?: boolean;
  /** UI-safe session metadata for the Workbench header; never credentials, URLs, or tool payloads. */
  currentTask?: string;
  routeLabel?: string;
  model?: string;
  costUsd?: number;
  turns?: number;
  /** Human-readable host consent instruction, distinct from an agent/tool failure. */
  consentMessage?: string;
}

export interface ChatReply {
  from: string;
  fromName: string;
  text: string;
  isError: boolean;
  /** Structured host observation; never inferred from reply prose. */
  completionState?: DelegationCompletionState;
  epoch?: number;
  /** Host-observed time, sent alongside rather than appended to the model's text. */
  timing?: TurnTiming;
  /** The origin bus message id of the turn this reply ends. */
  turnId?: string;
  /** Host-counted dispatch receipt for this turn, shown in the reply's footer. */
  delegationReceipt?: TurnDelegationCounts;
  /** Present only when the host itself started this turn. */
  turnTrigger?: ChatTurnTrigger;
  /** Host-published exact content in `text` (v0.9.88 §5.5); it renders verbatim. */
  verbatim?: ChatVerbatim;
  /** v0.9.90: the turn ended with an empty reply; the chat shows this host item once, never a fabricated answer. */
  emptyReply?: { noticeKey: string; text: string };
  /** v0.9.91: the turn's outcome receipt, kept on the reply that ends it. Never shown or sent to the webview. */
  turnOutcome?: TurnOutcomeReceiptV1;
}

/** UI-safe reason the shared conversation cannot accept a turn yet. */
export type ChatRepairState = 'no-team' | 'missing-connection' | 'missing-credential';

export interface ChatViewDeps {
  /** The host approval broker shared with native-modal and route approvals; a private one is used when absent. */
  approvalBroker?: ApprovalDecisionBroker;
  /** The webview's receipt for an attention chime (v0.9.88); logged by the host, never surfaced. */
  onAttentionResult?: (result: { id: string; audioState: string; started: boolean; surface: ChatContainer }) => void;
  /** The application-scoped `unode.attentionSound` setting (v0.9.88); off when absent. */
  attentionSoundEnabled?: () => boolean;
  listAgents: () => ChatAgent[];
  send: (agentId: string, text: string, mode: ChatMode, attachments?: UserAttachment[], turnEpoch?: number) => void;
  /** Host-side audit sink for a composer post that could not begin a turn. */
  onSendRejected?: (event: ComposerSendRejection) => void;
  /** Passive report from a webview when a full-state update unexplainably omits rendered transcript content. */
  onRenderedTranscriptDisappearance?: (event: RenderedTranscriptDisappearance) => void;
  /** Host-owned count of settled delegation results queued behind a coordinator's active turn. */
  delegationWaitingResults?: (agentId: string) => number;
  /** Steer a running agent (G-001). Routed to the backend's interject(). */
  interject: (agentId: string, text: string) => void;
  interrupt: (agentId: string) => void;
  /** Context the selected agent is carrying, including whether its window was measured or assumed. */
  contextMeter?: (agentId: string) => ContextMeterState | undefined;
  /** Compact on the user's instruction. The threshold-driven path is unchanged and still runs. */
  /** Resolves when the compaction has settled, so the transcript can show it running until then. */
  compactContext?: (agentId: string) => Promise<void> | void;
  onSelectAgent?: (agentId: string) => void;
  onReply: (cb: (reply: ChatReply) => void) => () => void;
  state: vscode.Memento;
  /** Current approval settings, surfaced in the chat footer selector. */
  getApprovals: () => ApprovalSettings;
  /** Persist an approval setting changed from the chat footer selector. */
  setApproval: (kind: ApprovalKind, value: string) => void | Promise<void>;
  setCodexPermissionProfile?: (agentId: string, profile: CodexActPermissionProfile) => void | Promise<void>;
  /**
   * Host-owned UI-safe session state. The sidebar and future Workbench must share
   * this model rather than independently caching a transcript or selection.
   */
  presentation?: SessionPresentationModel;
  /** Keeps the package-level Workbench command/menu context in sync with its editor tab. */
  onWorkbenchOpenChange?: (open: boolean) => void;
  /** Identifies a local approval decision without coupling the approval event to VS Code APIs. */
  approverIdentity?: () => string;
  /** Recorded file checkpoints, for the Workbench inspector rail. Host-owned and read-only here:
   *  the rail reports what the crew changed, it does not own the checkpoint store. */
  getCheckpoints?: () => Checkpoint[];
  /** Host-only readiness check for the selected agent. It returns no credential or route detail to the webview. */
  getRepairState?: (agentId: string) => Promise<ChatRepairState | undefined>;
  /** Maps a known repair state to one explicit host-owned setup action. */
  runRepairAction?: (state: ChatRepairState) => void;
  /** Opens the exact host-resolved agent's editor; the webview never supplies the target. */
  openAgentModelSettings?: (agentId: string) => Promise<void> | void;
  /** Opens a host-recorded read_file target after the host re-applies this agent's read-root boundary. */
  openWorkspaceFile?: (agentId: string, filePath: string) => Promise<void> | void;
  /** A host-derived actionable-exception lifecycle fact. The webview never emits this evidence. */
  onOutcomeRepair?: (event: ChatOutcomeRepairEvent) => void;
  /**
   * v0.9.93: the current view of one run's outcome, projected by the host from stored facts. The chat keeps only
   * the anchor: it never stores, derives or edits what the card says. `conflict` asks for the view of an anchor
   * whose copies disagreed.
   */
  jobOutcomeView?: (runId: string, anchor: 'anchored' | 'conflict') => JobOutcomeViewV1 | undefined;
  /** One explicit action on an outcome card, already checked against the actions that card offers. */
  onJobOutcomeAction?: (event: { coordinatorId: string; runId: string; action: JobOutcomeCardAction }) => void;
}

export interface ComposerSendRejection {
  clause: 'empty' | 'unknown-agent';
  requestedAgentId: string;
  selectedAgentId: string;
  requestId?: string;
}

/** Observation only: a later full-state push omitted transcript items this webview had rendered. */
export interface RenderedTranscriptDisappearance {
  source: ChatContainer;
  agentId: string;
  /** A normal FIFO trim is measured separately; this bounded log contains only unexplained omissions. */
  cause: 'unexplained';
  /** A received full-state push removed a previously rendered logical item; this is a display defect. */
  classification: 'display-bug';
  previousItemCount: number;
  nextItemCount: number;
  missing: Array<{ id: string; delivery: 'live' | 'committed' }>;
  previousTurnEpoch?: number;
  nextTurnEpoch?: number;
  epochChanged: boolean;
  observedAt: string;
  undeliveredStatePushes: number;
  lastUndeliveredSurface?: string;
}

/** Closed, content-free fact emitted by the chat host when an outcome card is created or invalidated. */
export interface ChatOutcomeRepairEvent {
  outcomeId: string;
  category: 'consent-timeout' | 'delegate-empty';
  state: 'offered' | 'invoked' | 'unavailable';
  agentId: string;
  sessionId: string;
  /** The host correlation captured when the terminal outcome occurred; never sent to a webview. */
  correlationId?: string;
  recordedAt: string;
}

interface ChatViewMessage extends ChatHistoryMessage {
  kind?: 'message';
  blocks?: MarkdownBlock[];
  live?: boolean;
}

interface ChatToolViewActivity extends ChatToolActivity {
  /** Transient render data. It is derived from the bounded receipt and is never duplicated in workspaceState. */
  detailBlocks?: MarkdownBlock[];
  detailTruncatedChars?: number;
  canOpenFile?: boolean;
}

/** v0.9.91: a tool card's start or its typed result, paired by the host's turn-local call id. */
export type ChatToolEvent =
  | { phase: 'use'; callId: string; name: string; input?: unknown; epoch?: number }
  | { phase: 'result'; callId: string; name: string; outcome: ToolResultFact; summary?: string; detail?: string; diff?: string; humanWaitMs?: number; epoch?: number };

interface ChatMarker {
  kind: 'marker';
  id: string;
  ts: string;
  seq?: number;
  text: string;
}

interface ChatReasoning {
  kind: 'reasoning';
  id: string;
  ts: string;
  seq?: number;
  text: string;
  blocks?: MarkdownBlock[];
  live?: boolean;
}

interface ChatDelegationItem extends DelegationProgressSummary {
  kind: 'delegation';
  ts: string;
  seq?: number;
  /** Changes whenever a status/activity event changes card content, so the webview replaces its DOM node. */
  renderKey: string;
}

interface ChatContextManifestItem {
  kind: 'contextManifest';
  id: string;
  ts: string;
  seq?: number;
  turnEpoch: number;
  manifest: TurnContextManifest;
}

interface ChatSoloSuggestionItem {
  kind: 'soloSuggestion';
  id: string;
  ts: string;
  seq?: number;
  sourceAgentId: string;
  soloAgentId: string;
  text: string;
  mode: ChatMode;
}

/**
 * v0.9.93: one run's outcome card. A host presentation item: it has no role, no text and no author, and exists
 * only in the list a webview renders.
 */
interface ChatJobOutcomeItem {
  kind: 'jobOutcome';
  /** `outcome:<runId>`: the same card across updates, reloads and windows. */
  id: string;
  ts: string;
  seq?: number;
  view: JobOutcomeViewV1;
  /** Changes when what the card says changes, so the webview replaces that one node in place. */
  renderKey: string;
}

type ChatTranscriptItem = ChatViewMessage | ChatToolViewActivity | ChatMarker | ChatReasoning | ChatDelegationItem | ChatContextManifestItem | ChatSoloSuggestionItem | ChatJobOutcomeItem;

interface ChatViewState {
  /** Generated per provider instance; a live webview that sees it change knows the extension host restarted. */
  hostInstanceId: string;
  /** `unode.attentionSound`: the webview starts its audio on the first key or pointer press only when on. */
  attentionSound: boolean;
  agents: ChatAgent[];
  /** Context the selected agent carries, including the source of the guard's denominator. */
  contextMeter?: ContextMeterState;
  selectedAgentId: string;
  messages: ChatTranscriptItem[];
  runningAgentIds: string[];
  /** coordinatorId -> async delegations still in flight (PM is idle but work is out). */
  delegatingCounts: Record<string, number>;
  /** coordinatorId -> the delegations still out, so the webview can run a clock against each. */
  delegatingOut: Record<string, { agentName: string; startedAt: string }[]>;
  /** coordinatorId -> settled async results retained until its current turn reaches an idle transition. */
  waitingResultCounts: Record<string, number>;
  mode: ChatMode;
  compact: boolean;
  todos: TodoItem[];
  approvals: ApprovalSettings;
  pendingApprovals: ApprovalRequest[];
  /** A bounded approval that expired stays visible as an outcome instead of returning silently to idle. */
  approvalAttention?: ApprovalAttention;
  /** Every timeout is a separate outcome; a second one on the same agent cannot overwrite the first. */
  approvalOutcomes: ApprovalAttention[];
  /** Host-issued terminal delegation receipts. The renderer receives no task, command, or target id. */
  outcomeRepairs: ChatOutcomeRepairCard[];
  smoothStreaming: boolean;
  turnEpochs: Record<string, number>;
  /** Start time of each active turn. Transient: never restored as a fake in-progress turn. */
  turnStartedAt: Record<string, string>;
  /** The host-observed live phase of each running turn. Transient, and never derived in the view. */
  turnPhases: Record<string, ChatTurnPhase>;
  /** UX4 inspector rail. Off by default and only ever rendered in the Workbench container — the
   *  sidebar is already the narrow one, and a rail inside it would take the width twice. */
  inspectorOpen: boolean;
  /** Team edits grouped by owner. Derived from the checkpoint store; this rail owns no second copy. */
  changedFileGroups: ChangedFileGroup[];
  /** A repair card replaces an unusable conversation until its one next action is complete. */
  repair?: ChatRepairState;
  /** Host-owned wording for the visible repair card and its matching announcement. */
  repairCopy?: ChatRepairCopy;
  /** One host-composed accessibility event. Webviews use seq to avoid duplicate or restored speech. */
  announcement?: ChatAnnouncement;
  /** A host-delivered selection is applied once by each live composer and acknowledged back. */
  composerInsertion?: ComposerInsertion;
}

interface ChangedFileGroup {
  agentId: string;
  agentName: string;
  files: ChangedFileSummary[];
}

type OutcomeRepairAction =
  | 'configure-agent-model' | 'retry-delegation'
  | 'retry-same-route' | 'switch-route' | 'stop-request';

/** UI-safe projection of a host-owned terminal-outcome recipe. */
interface ChatOutcomeRepairCard {
  outcomeId: string;
  category: 'delegate-empty' | 'first-action-deadline';
  state: 'offered' | 'invoked' | 'unavailable';
  title: string;
  detail: string;
  action?: { kind: OutcomeRepairAction; label: string };
  /** A first-action deadline offers its next steps together, and the person chooses one. */
  actions?: Array<{ kind: OutcomeRepairAction; label: string }>;
}

const FIRST_ACTION_DEADLINE_TITLE = 'No first action within 60 seconds';
const FIRST_ACTION_DEADLINE_DETAIL =
  'The model sent nothing for 60 seconds before it dispatched, closed or replied, so UnodeAi ended the attempt. '
  + 'Nothing was dispatched or changed, and nothing is retried for you. "Retry same route" starts this request '
  + 'again on the same route as a new request; it does not continue the ended attempt.';

interface ChatOutcomeRepairRecord extends ChatOutcomeRepairCard {
  agentId: string;
  sessionId: string;
  correlationId?: string;
  retry: () => Promise<boolean>;
  retryInFlight?: Promise<boolean>;
}

/** The adapter passes this structural host event without exposing TeamTools to the renderer. */
export interface ChatDelegationEmptyOutcome {
  outcomeId: string;
  agentId: string;
  sessionId: string;
  correlationId: string;
  retry: () => Promise<boolean>;
}

/** The host's terminal fact for a coordinator attempt the first-action deadline ended (v0.9.93). */
export interface ChatFirstActionDeadline {
  /** The ended turn. The card's id is derived from it, so one deadline has one card. */
  turnId: string;
  /** The coordinator whose attempt was ended. Its session is stopped. */
  agentId: string;
  /**
   * Submits the original top-level request again, as a new request on the agent's current route. Host-owned and
   * never rendered. Resolves to whether the request was started.
   */
  retry: () => Promise<boolean>;
}

type ChatContainer = 'sidebar' | 'workbench';
type ChatAnnouncementPoliteness = 'assertive' | 'polite';

interface ChatAnnouncement {
  text: string;
  politeness: ChatAnnouncementPoliteness;
  /** Monotonic while this extension host lives; equal wording must still announce on a new event. */
  seq: number;
}

interface ComposerInsertion {
  agentId: string;
  text: string;
  revision: number;
}

interface ChatRepairCopy {
  title: string;
  detail: string;
  action: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'unode.chat';
  public static readonly workbenchViewType = 'unode.workbench';

  /**
   * The sidebar and editor tab deliberately share this provider and its host-owned presentation model.
   * They are two containers for one renderer, not two chat implementations.
   */
  private sidebarView?: vscode.WebviewView;
  private workbenchPanel?: vscode.WebviewPanel;
  /** The text editor that handed focus to the Workbench composer, when there is one to return to. */
  private previousTextEditor?: { uri: vscode.Uri; viewColumn?: vscode.ViewColumn };
  private readonly replyDisposer: () => void;
  private readonly presentation: SessionPresentationModel;
  private liveMessages = new Map<string, ChatHistoryMessage>();
  private liveMessageMarkdown = new Map<string, LiveMarkdown>();
  private liveMessageTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // F-live-analysis: the agent's in-flight reasoning ("Analysis") for the current turn, plus finalized
  // reasoning blocks persisted with the chat stream so segmented turns survive reload.
  private liveReasoning = new Map<string, { id: string; text: string; ts: string; seq?: number }>();
  private liveReasoningMarkdown = new Map<string, LiveMarkdown>();
  private liveReasoningTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reasoningItems = new Map<string, ChatReasoning[]>();
  private toolActivities = new Map<string, ChatToolActivity[]>();
  private nextSeqs = new Map<string, number>();
  private initializedSeqs = new Set<string>();
  private stableSeqs = new Map<string, number>();
  private renderedMarkdownBlocks = new Map<string, MarkdownBlock[]>();
  private delegations: DelegationProgressSummary[] = [];
  // C3: the agent's live checklist (latest update_todos snapshot per agent; transient, not persisted).
  private todos = new Map<string, TodoItem[]>();
  private compactionMarkers = new Map<string, ChatMarker[]>();
  /** agentId -> id of the "compacting…" marker currently shown, so it can be removed when it settles. */
  private pendingCompactions = new Map<string, string>();
  /** State pushes the webview never received. Counted, not retried — see postToWebview. */
  private undeliveredStatePushes = 0;
  private lastUndeliveredSurface?: string;
  /** Bounded passive diagnostics; this is never a second transcript or a recovery queue. */
  private renderedTranscriptDisappearances: RenderedTranscriptDisappearance[] = [];
  /** Routine FIFO trims are classified and counted, but never allowed to evict an unexplained observation. */
  private renderedTranscriptWindowTrimObservations = 0;
  /** Rejected transport shapes are observable diagnostics; parsing never grants authority. */
  private rejectedWebviewMessages = 0;
  /** Per-turn context records are host-authored; they are never reconstructed from rendered prompt text. */
  private contextManifests = new Map<string, ChatContextManifestItem[]>();
  /** Unsent routing advice. It never owns a delegation and only acts on an explicit user handoff. */
  private soloSuggestions = new Map<string, ChatSoloSuggestionItem>();
  /** coordinatorId -> the outcome anchors of its chat. The only thing kept of a card. */
  private jobOutcomeAnchors = new Map<string, JobOutcomeAnchorEntry[]>();
  /** Projected views, kept until the host says the facts behind them may have changed. Never persisted. */
  private jobOutcomeViews = new Map<string, { view: JobOutcomeViewV1; renderKey: string }>();
  private modes = new Map<string, ChatMode>();
  private runningAgentIds = new Set<string>();
  private turnEpochs = new Map<string, number>();
  // Kept only while an agent is genuinely running. The webview owns the ticking clock; the host sends
  // this single timestamp as evidence of when the current turn began.
  private turnStartedAt = new Map<string, string>();
  private turnPhases = new Map<string, ChatTurnPhase>();
  private agentIds = new Set<string>();
  private compact = false;
  /** UX4 rail. Starts closed: the Workbench must be useful without it, so it opts in, never out. */
  private inspectorOpen = false;
  /** Last host-readiness result. No secret name, key, endpoint, or route id reaches webview state. */
  private repairState: ChatRepairState | undefined;
  private repairStateRefreshInFlight = false;
  /** The first resolved repair is initial UI, never an announcement. Later replacements are polite. */
  private repairAnnouncementInitialized = false;
  private lastRepairForAnnouncement: ChatRepairState | undefined;
  /** Accessibility events are shared host state, not inferred independently by each webview. */
  private announcementSeq = 0;
  private announcement?: ChatAnnouncement;
  private composerInsertionSeq = 0;
  private composerInsertion?: ComposerInsertion;
  /** At most one visible document receives each event; see announcementTarget(). */
  private focusedContainer?: ChatContainer;
  /** Subscriptions bound to concrete containers, never to shared session state. */
  private sidebarDisposables: vscode.Disposable[] = [];
  private workbenchDisposables: vscode.Disposable[] = [];
  private approvalListeners = new Set<(event: ApprovalEvent) => void>();
  /** approval id -> timeout outcome. This is deliberately not keyed by agent. */
  private approvalOutcomes = new Map<string, ApprovalAttention & { agentId: string; sessionId: string }>();
  /** Opaque terminal-delegation receipt id -> host-owned rerun closure and UI-safe projection. */
  private outcomeRepairs = new Map<string, ChatOutcomeRepairRecord>();
  /** User-initiated navigation may scroll to a card, but never focuses its allow button. */
  private approvalToReveal?: string;
  // In-panel approval cards. The host approval broker settles them; this view renders and forwards clicks.
  private readonly approvals: ApprovalQueue;
  /** F7-13: identifies this host instance to its webviews, so a send it never received is not left pending. */
  private readonly hostInstanceId = randomUUID();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: ChatViewDeps
  ) {
    this.approvals = new ApprovalQueue(
      () => this.postState(),
      (event) => this.handleApprovalEvent(event),
      deps.approvalBroker,
    );
    this.presentation = deps.presentation ?? new SessionPresentationModel();
    this.replyDisposer = this.deps.onReply((reply) => this.onReply(reply));
  }

  private get selectedAgentId(): string {
    return this.presentation.selectedAgentId;
  }

  private set selectedAgentId(agentId: string) {
    this.presentation.selectAgent(agentId);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    // VS Code may resolve a new view after the old one is hidden/disposed. Session state belongs to the
    // shared presentation model, but event listeners belong to one concrete view and must not accumulate.
    this.disposeSidebarView();
    this.sidebarView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.onDidReceiveMessage((msg) => this.onMessage(msg, 'sidebar'), null, this.sidebarDisposables);
    // Re-sync whenever the view becomes visible: a refresh posted while the chat was hidden/collapsed
    // may not reach the webview, which could leave a stale agent list (e.g. showing a removed agent
    // while the Team panel shows the current roster). Re-syncing on show keeps the two in lockstep.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.refresh();
      } else if (this.focusedContainer === 'sidebar') {
        this.focusedContainer = undefined;
      }
    }, null, this.sidebarDisposables);
    webviewView.onDidDispose?.(() => {
      if (this.sidebarView === webviewView) {
        this.disposeSidebarView();
      }
    }, null, this.sidebarDisposables);
    webviewView.webview.html = this.getHtml(webviewView.webview, 'sidebar');
    void this.refreshRepairState();
  }

  /** Create or reveal the single Workbench editor tab. Only user-initiated callers pass false. */
  openWorkbench(preserveFocus = false): void {
    const existing = this.workbenchPanel;
    if (existing) {
      existing.reveal(existing.viewColumn, preserveFocus);
      this.postState();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ChatViewProvider.workbenchViewType,
      'UnodeAi Workbench',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] },
    );
    this.attachWorkbenchPanel(panel);
  }

  /** Native tab disposal remains the close path; this command merely invokes that native action. */
  closeWorkbench(): void {
    this.workbenchPanel?.dispose();
  }

  /** Used by the panel serializer after VS Code restores an existing editor tab. */
  restoreWorkbench(panel: vscode.WebviewPanel): void {
    this.attachWorkbenchPanel(panel);
  }

  /** The one approved focus toggle: editor/Workbench surface <-> its composer. */
  toggleWorkbenchComposerFocus(): void {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      this.previousTextEditor = { uri: activeEditor.document.uri, viewColumn: activeEditor.viewColumn };
    }
    if (!this.workbenchPanel || !this.workbenchPanel.visible) {
      this.openWorkbench(false);
    }
    this.postToWebview(this.workbenchPanel?.webview, { command: 'toggleComposerFocus' }, 'workbench');
  }

  private attachWorkbenchPanel(panel: vscode.WebviewPanel): void {
    if (this.workbenchPanel && this.workbenchPanel !== panel) {
      this.disposeWorkbenchPanel();
    }
    this.workbenchPanel = panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg, 'workbench'), null, this.workbenchDisposables);
    panel.onDidChangeViewState(() => {
      if (panel.visible) {
        this.refresh();
      } else if (this.focusedContainer === 'workbench') {
        this.focusedContainer = undefined;
      }
    }, null, this.workbenchDisposables);
    panel.onDidDispose(() => {
      if (this.workbenchPanel === panel) {
        this.disposeWorkbenchPanel();
      }
    }, null, this.workbenchDisposables);
    panel.webview.html = this.getHtml(panel.webview, 'workbench');
    this.deps.onWorkbenchOpenChange?.(true);
    void this.refreshRepairState();
  }

  private disposeSidebarView(): void {
    this.sidebarDisposables.forEach((disposable) => disposable.dispose());
    this.sidebarDisposables = [];
    if (this.focusedContainer === 'sidebar') {
      this.focusedContainer = undefined;
    }
    this.sidebarView = undefined;
  }

  private disposeWorkbenchPanel(): void {
    this.workbenchDisposables.forEach((disposable) => disposable.dispose());
    this.workbenchDisposables = [];
    if (this.focusedContainer === 'workbench') {
      this.focusedContainer = undefined;
    }
    this.workbenchPanel = undefined;
    this.deps.onWorkbenchOpenChange?.(false);
  }

  private postToVisible(message: ChatWebviewOutboundMessage): void {
    if (this.sidebarView?.visible) {
      this.postToWebview(this.sidebarView.webview, message, 'sidebar');
    }
    if (this.workbenchPanel?.visible) {
      this.postToWebview(this.workbenchPanel.webview, message, 'workbench');
    }
  }

  /** Reply only to the composer that posted a turn. A hidden/stale sibling must never clear its draft. */
  private postToContainer(source: ChatContainer | undefined, message: ChatWebviewOutboundMessage): void {
    if (source === 'sidebar') {
      this.postToWebview(this.sidebarView?.webview, message, 'sidebar');
    } else if (source === 'workbench') {
      this.postToWebview(this.workbenchPanel?.webview, message, 'workbench');
    }
  }

  /**
   * One accessibility event belongs to one document. When both containers are visible, send it to the
   * one the user is working in; otherwise prefer the Workbench, then the sidebar. If neither is visible,
   * preserve the host event in state but deliberately do not replay it when a container reopens.
   */
  private announcementTarget(): ChatContainer | undefined {
    if (this.focusedContainer === 'sidebar' && this.sidebarView?.visible) {
      return 'sidebar';
    }
    if (this.focusedContainer === 'workbench' && this.workbenchPanel?.visible) {
      return 'workbench';
    }
    if (this.workbenchPanel?.visible) {
      return 'workbench';
    }
    return this.sidebarView?.visible ? 'sidebar' : undefined;
  }

  /**
   * Play the attention chime in exactly one visible chat container (v0.9.88 §5.11): the one the user is working
   * in, else any visible one, by the accessibility-announcement rule. A hidden container never plays, because the
   * playback probe could not show that one can. `container` is only for the Test-mode playback probe. Returns
   * the container asked to play, or undefined when no chat view can (the caller logs the miss).
   */
  playAttention(id: string, options: { container?: ChatContainer } = {}): ChatContainer | undefined {
    const target = options.container ?? this.announcementTarget();
    if (!target || (target === 'workbench' ? !this.workbenchPanel : !this.sidebarView)) {
      return undefined;
    }
    this.postToContainer(target, { command: 'attention', id });
    return target;
  }

  private revealApprovalSurface(): void {
    try {
      // Keep an already-open sidebar current without undoing the user's collapse. The status-bar signal and
      // attention chime advertise a background approval; only the user's explicit alert action expands/focuses
      // its card. The Workbench editor tab is likewise never revealed by background work.
      if (this.sidebarView?.visible) {
        this.sidebarView.show?.(true);
      }
    } catch {
      /* Best-effort reveal: the queue remains fail-closed if VS Code cannot show a container. */
    }
  }

  private focusPreviousEditor(): void {
    const previous = this.previousTextEditor;
    if (!previous) {
      void vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      return;
    }
    void vscode.workspace.openTextDocument(previous.uri).then(
      (document) => vscode.window.showTextDocument(document, { viewColumn: previous.viewColumn, preserveFocus: false }),
      () => vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'),
    );
  }

  refresh(): void {
    this.syncAgents();
    this.postState();
    void this.refreshRepairState();
  }

  /** Refresh readiness without making live transcript updates depend on SecretStorage timing. */
  private async refreshRepairState(): Promise<void> {
    if (!this.deps.getRepairState || this.repairStateRefreshInFlight) {
      return;
    }
    this.repairStateRefreshInFlight = true;
    const agentId = this.selectedAgentId;
    try {
      const state = await this.deps.getRepairState(agentId);
      // Selection can change while SecretStorage resolves. Do not paint agent A's readiness over agent B.
      if (agentId !== this.selectedAgentId) {
        return;
      }
      const next = isChatRepairState(state) ? state : undefined;
      if (next !== this.repairState) {
        this.repairState = next;
        this.postState();
      }
    } catch {
      // A readiness check must not turn an otherwise usable transcript into an opaque error.
      // Backend execution remains fail-closed at its existing route and credential boundaries.
    } finally {
      this.repairStateRefreshInFlight = false;
      if (agentId !== this.selectedAgentId) {
        void this.refreshRepairState();
      }
    }
  }

  /** Per-coordinator count of delegations still working. Drives the 'delegating — N out' composer hint. */
  private delegatingCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const s of this.delegations) {
      if (s.working > 0) { counts[s.coordinatorId] = (counts[s.coordinatorId] ?? 0) + s.working; }
    }
    return counts;
  }

  setDelegationProgress(summaries: DelegationProgressSummary[]): void {
    this.delegations = summaries;
    this.postState();
  }

  selectAgent(agentId: string): void {
    this.syncAgents(agentId);
    this.postState();
    void this.refreshRepairState();
  }

  /** Subscribe a host surface (status bar, badge, roster) to approval lifecycle events. */
  onApprovalEvent(listener: (event: ApprovalEvent) => void): vscode.Disposable {
    this.approvalListeners.add(listener);
    return { dispose: () => this.approvalListeners.delete(listener) };
  }

  pendingApprovalCount(): number {
    return this.approvals.pendingCount();
  }

  /** State for a compact roster row. Viewing it never changes or clears the underlying queue. */
  approvalAttentionForAgent(agentId: string): ApprovalAttention | undefined {
    const pending = this.approvals.list().find((approval) => approval.agentId === agentId);
    if (pending) {
      return {
        state: 'waiting',
        approvalId: pending.id,
        actionSummary: approvalSummary(pending),
      };
    }
    return this.approvalOutcomesForAgent(agentId).at(-1);
  }

  private approvalOutcomesForAgent(agentId: string): ApprovalAttention[] {
    return [...this.approvalOutcomes.values()]
      .filter((outcome) => outcome.agentId === agentId)
      .map(({ agentId: _agentId, sessionId: _sessionId, ...outcome }) => outcome);
  }

  /**
   * Receive the terminal receipt before any renderer sees it. The original task and rerun closure remain
   * host-owned; state contains an opaque id and one bounded next action only.
   */
  recordDelegationEmptyOutcome(event: ChatDelegationEmptyOutcome): void {
    if (this.outcomeRepairs.has(event.outcomeId)) return;
    const targetAvailable = this.deps.listAgents().some((agent) => agent.id === event.agentId);
    const canConfigure = targetAvailable && this.outcomeSessionReachable(event.sessionId) && !!this.deps.openAgentModelSettings;
    const record: ChatOutcomeRepairRecord = {
      outcomeId: event.outcomeId,
      category: 'delegate-empty',
      state: canConfigure ? 'offered' : 'unavailable',
      agentId: event.agentId,
      sessionId: event.sessionId,
      correlationId: event.correlationId,
      title: 'Delegation blocked — no usable reply',
      detail: canConfigure
        ? 'This agent returned no usable reply after the existing retry path. Update its model, then retry the same delegation.'
        : 'This delegation cannot be repaired because the agent or its host action is no longer available.',
      ...(canConfigure ? { action: { kind: 'configure-agent-model' as const, label: 'Edit agent model' } } : {}),
      retry: event.retry,
    };
    this.outcomeRepairs.set(event.outcomeId, record);
    this.emitOutcomeRepair(record, record.state);
    this.postState();
  }

  /**
   * The first-action deadline ended a coordinator's attempt. One card offers the next steps and takes none of them:
   * the request and its resubmission stay host-owned, and state carries an opaque id and labels only. It records
   * nothing in the run ledger, because the attempt belongs to no run.
   */
  recordFirstActionDeadline(event: ChatFirstActionDeadline): void {
    const outcomeId = `first-action-deadline:${event.turnId}`;
    if (this.outcomeRepairs.has(outcomeId)) return;
    this.outcomeRepairs.set(outcomeId, {
      outcomeId,
      category: 'first-action-deadline',
      state: 'offered',
      agentId: event.agentId,
      sessionId: event.agentId,
      title: FIRST_ACTION_DEADLINE_TITLE,
      detail: FIRST_ACTION_DEADLINE_DETAIL,
      actions: [
        { kind: 'retry-same-route', label: 'Retry same route' },
        ...(this.deps.openAgentModelSettings ? [{ kind: 'switch-route' as const, label: 'Switch route' }] : []),
        { kind: 'stop-request', label: 'Stop' },
      ],
      retry: event.retry,
    });
    this.postState();
  }

  /** The person chose one of a deadline card's next steps. A rendered offer is never authority. */
  private async runFirstActionDeadlineAction(record: ChatOutcomeRepairRecord, kind: OutcomeRepairAction): Promise<void> {
    if (!record.actions?.some((action) => action.kind === kind)) return;
    // The coordinator's session is stopped by design, so only its presence on the roster is required.
    const agentAvailable = this.selectedAgentId === record.sessionId
      && this.deps.listAgents().some((agent) => agent.id === record.agentId);
    if (!agentAvailable) {
      this.markOutcomeRepairUnavailable(record);
      return;
    }
    if (kind === 'stop-request') {
      record.state = 'invoked';
      record.detail = 'Stopped. Nothing was dispatched or changed, and the request was not started again.';
      record.actions = undefined;
      this.postState();
      return;
    }
    if (kind === 'switch-route') {
      if (!this.deps.openAgentModelSettings) {
        this.markOutcomeRepairUnavailable(record);
        return;
      }
      record.state = 'invoked';
      record.detail = 'Agent Builder was opened for this agent. Nothing was switched for you: after changing its '
        + 'route or model, start this request again here.';
      record.actions = [
        { kind: 'retry-same-route', label: 'Start this request again' },
        { kind: 'stop-request', label: 'Stop' },
      ];
      this.postState();
      await this.deps.openAgentModelSettings(record.agentId);
      return;
    }
    if (kind !== 'retry-same-route') return;
    if (record.retryInFlight) {
      await record.retryInFlight;
      return;
    }
    record.state = 'invoked';
    record.detail = 'This request was started again on the agent\'s current route, as a new request.';
    record.actions = undefined;
    this.postState();
    const retry = record.retry();
    record.retryInFlight = retry;
    if (!(await retry)) this.markOutcomeRepairUnavailable(record);
  }

  private outcomeRepairsForAgent(agentId: string): ChatOutcomeRepairCard[] {
    return [...this.outcomeRepairs.values()]
      // A delegate-empty terminal appears in the coordinator's transcript. Its repair targets a teammate,
      // but it must be rendered beside the PM result that actually got blocked.
      .filter((record) => record.sessionId === agentId)
      .map(({ agentId: _agentId, sessionId: _sessionId, correlationId: _correlationId, retry: _retry, retryInFlight: _retryInFlight, ...card }) => card);
  }

  /** Re-check both target identity and host reachability at click time; a rendered offer is never authority. */
  private async runOutcomeRepair(outcomeId: string, kind: OutcomeRepairAction): Promise<void> {
    const record = this.outcomeRepairs.get(outcomeId);
    if (!record) return;
    if (record.category === 'first-action-deadline') {
      await this.runFirstActionDeadlineAction(record, kind);
      return;
    }
    const targetAvailable = this.selectedAgentId === record.sessionId
      && this.deps.listAgents().some((agent) => agent.id === record.agentId)
      && this.outcomeSessionReachable(record.sessionId);
    if (!targetAvailable) {
      this.markOutcomeRepairUnavailable(record);
      return;
    }
    if (kind === 'retry-delegation' && record.retryInFlight) {
      await record.retryInFlight;
      return;
    }
    if (record.action?.kind !== kind) return;

    if (kind === 'configure-agent-model') {
      if (!this.deps.openAgentModelSettings) {
        this.markOutcomeRepairUnavailable(record);
        return;
      }
      record.state = 'invoked';
      record.detail = 'The Agent Builder was opened for this exact agent. After changing its model, retry the same delegation.';
      record.action = { kind: 'retry-delegation', label: 'Retry delegation' };
      this.emitOutcomeRepair(record, 'invoked');
      this.postState();
      await this.deps.openAgentModelSettings(record.agentId);
      return;
    }

    record.state = 'invoked';
    record.detail = 'A new delegation attempt has started through the normal admission path.';
    record.action = undefined;
    this.emitOutcomeRepair(record, 'invoked');
    this.postState();
    const retry = record.retry();
    record.retryInFlight = retry;
    const started = await retry;
    if (!started) this.markOutcomeRepairUnavailable(record);
  }

  private markOutcomeRepairUnavailable(record: ChatOutcomeRepairRecord): void {
    if (record.state === 'unavailable' && !record.action && !record.actions) return;
    record.state = 'unavailable';
    record.action = undefined;
    record.actions = undefined;
    if (record.category === 'first-action-deadline') {
      record.detail = 'This request can no longer be started again from here, because the agent is not available. '
        + 'Nothing was dispatched or changed.';
      this.postState();
      return;
    }
    record.detail = 'This repair is no longer available because the agent or its original dispatch is no longer reachable.';
    this.emitOutcomeRepair(record, 'unavailable');
    this.postState();
  }

  private emitOutcomeRepair(record: ChatOutcomeRepairRecord, state: ChatOutcomeRepairEvent['state']): void {
    // A deadline's attempt belongs to no run, so its card leaves nothing in the run ledger.
    if (record.category === 'first-action-deadline') return;
    this.deps.onOutcomeRepair?.({
      outcomeId: record.outcomeId,
      category: record.category,
      state,
      agentId: record.agentId,
      sessionId: record.sessionId,
      ...(record.correlationId ? { correlationId: record.correlationId } : {}),
      recordedAt: new Date().toISOString(),
    });
  }

  /** An idle coordinator can receive the fresh asynchronous result; a stopped/error one cannot. */
  private outcomeSessionReachable(sessionId: string): boolean {
    const session = this.deps.listAgents().find((agent) => agent.id === sessionId);
    return !!session && session.status !== 'stopped' && session.status !== 'error';
  }

  /** User-initiated path from the status bar or highlighted Team row to the one inline decision card. */
  focusPendingApproval(agentId?: string): void {
    const approval = agentId
      ? this.approvals.list().find((item) => item.agentId === agentId)
      : this.approvals.list()[0];
    const hostConsentAgentId = !approval && !agentId
      ? this.deps.listAgents().find((agent) => agent.status === 'consent_required')?.id
      : undefined;
    const targetAgentId = approval?.agentId || agentId || hostConsentAgentId;
    if (targetAgentId) {
      this.selectAgent(targetAgentId);
    }
    this.approvalToReveal = approval?.id || 'consent-required';
    // This is user-initiated, unlike requestApproval(), so moving to the decision is expected.
    this.openWorkbench(false);
    this.postToVisible({ command: 'focusApproval', id: this.approvalToReveal });
  }

  /** True when the chat webview is available to host an approval card (else the caller falls back). */
  canPromptApproval(): boolean {
    return !!this.sidebarView || !!this.workbenchPanel;
  }

  /**
   * Ask the user to approve a pending action inside the chat panel (styled card) instead of a native
   * modal. Refreshes an already-visible sidebar without expanding one the user collapsed, renders the card,
   * and resolves when the user chooses. The caller should only use this when `canPromptApproval()` is true;
   * otherwise fall back to a native prompt so the agent never deadlocks without an attached webview.
   */
  requestApproval(req: Omit<ApprovalRequest, 'id'>, timeoutMs?: number): Promise<ParticipantOutcome> {
    return this.openApproval(req, timeoutMs).outcome;
  }

  /** Same card, also returning its broker id so a caller can let other sessions join it. */
  openApproval(req: Omit<ApprovalRequest, 'id'>, timeoutMs?: number): { approvalId: string; outcome: Promise<ParticipantOutcome> } {
    this.revealApprovalSurface();
    return this.approvals.open(req, timeoutMs);
  }

  private currentTurnEpoch(agentId: string): number {
    return this.turnEpochs.get(agentId) ?? 0;
  }

  private bumpTurnEpoch(agentId: string, requested?: number, postState = false): number {
    const current = this.currentTurnEpoch(agentId);
    const requestedEpoch = normalizeEpoch(requested);
    const next = Math.max(current + 1, requestedEpoch ?? 0);
    this.turnEpochs.set(agentId, next);
    // Timeout cards belong to the denied turn. A later turn is new work, never a revived approval, so it
    // clears only this agent's expired-card observations.
    for (const [outcomeId, outcome] of this.approvalOutcomes) {
      if (outcome.agentId === agentId) this.approvalOutcomes.delete(outcomeId);
    }
    this.turnStartedAt.delete(agentId);
    this.turnPhases.delete(agentId);
    this.clearLiveMarkdown(agentId);
    if (postState && agentId === this.selectedAgentId) {
      this.postState();
    }
    return next;
  }

  private markRunning(agentId: string): boolean {
    const started = !this.runningAgentIds.has(agentId);
    if (started) {
      this.turnStartedAt.set(agentId, new Date().toISOString());
    }
    this.runningAgentIds.add(agentId);
    return started;
  }

  private markStopped(agentId: string): void {
    this.runningAgentIds.delete(agentId);
    this.turnStartedAt.delete(agentId);
    this.turnPhases.delete(agentId);
  }

  private queueAnnouncement(text: string, politeness: ChatAnnouncementPoliteness): void {
    const safeText = text.trim();
    if (!safeText) {
      return;
    }
    this.announcement = {
      text: safeText,
      politeness,
      seq: ++this.announcementSeq,
    };
  }

  private queueTurnStarted(agentId: string): void {
    this.queueAnnouncement(`${this.agentName(agentId)} started a reply.`, 'polite');
  }

  private queueTurnOutcome(agentId: string, isError: boolean, fromName?: string): void {
    const name = fromName || this.agentName(agentId);
    this.queueAnnouncement(
      isError ? `${name} could not finish its reply.` : `${name} finished its reply.`,
      'polite',
    );
  }

  private acceptEventEpoch(agentId: string, epoch?: number): number | undefined {
    const incoming = normalizeEpoch(epoch);
    if (incoming === undefined) {
      return this.currentTurnEpoch(agentId);
    }
    const current = this.currentTurnEpoch(agentId);
    if (incoming < current) {
      return undefined;
    }
    if (incoming > current) {
      this.turnEpochs.set(agentId, incoming);
      this.runningAgentIds.delete(agentId);
      this.turnStartedAt.delete(agentId);
      this.turnPhases.delete(agentId);
      // Commit what the previous turn already put on screen before moving on. Discarding it here is how a
      // completed reply vanished in front of the user: SessionManager bumps the epoch when ANY message
      // reaches the session — a delegate's result waking a PM is enough — so the new turn's first event
      // arrives while the old turn is still streaming. Clearing wiped the rendered text, and the old turn's
      // final reply then arrived with the lower epoch and was refused by this same function, so nothing
      // ever put it back. Reported from the field 2026-08-10: "streams line by line, flashes once, all gone."
      this.flushLiveMessage(agentId);
      this.clearLiveMarkdown(agentId);
      if (agentId === this.selectedAgentId) {
        this.postState();
      }
    }
    return incoming;
  }

  /**
   * v0.9.92: the live phase of an agent's turn as the host observed it, or its end. This view shows the phase it
   * is given and derives none: silence after a request is a wait for the provider because the host says so, not
   * because no text has arrived here.
   */
  setTurnPhase(agentId: string, phase: TurnPhaseSnapshot | undefined, epoch?: number): void {
    this.syncAgents();
    if (!this.agentIds.has(agentId)) {
      return;
    }
    // A phase of an earlier turn, or the end of one, says nothing about the turn that is running now.
    if (this.acceptEventEpoch(agentId, epoch) === undefined) {
      return;
    }
    if (!phase) {
      if (this.turnPhases.delete(agentId) && agentId === this.selectedAgentId) {
        this.postToVisible({ command: 'turnPhase', agentId });
      }
      return;
    }
    const turnPhase: ChatTurnPhase = { ...phase, provider: this.providerLabel(agentId) };
    this.turnPhases.set(agentId, turnPhase);
    // A turn the host started on its own has no user send to mark it running; its first phase does.
    if (this.markRunning(agentId)) {
      this.queueTurnStarted(agentId);
      this.postState();
      return;
    }
    if (agentId === this.selectedAgentId) {
      this.postToVisible({ command: 'turnPhase', agentId, turnPhase });
    }
  }

  /** The name the live line gives the provider this agent is waiting for. */
  private providerLabel(agentId: string): string {
    const agent = this.deps.listAgents().find((candidate) => candidate.id === agentId);
    if (agent?.backend === 'claude') return 'Claude';
    if (agent?.backend === 'codex') return 'Codex';
    return agent?.routeLabel?.trim().slice(0, 40) || 'the provider';
  }

  appendDelta(agentId: string, delta: string, epoch?: number): void {
    this.syncAgents();
    if (!this.agentIds.has(agentId) || delta.length === 0) {
      return;
    }
    const acceptedEpoch = this.acceptEventEpoch(agentId, epoch);
    if (acceptedEpoch === undefined) {
      return;
    }
    // Announce the boundary before adding a live markdown tail. A full state render after the tail exists
    // would parse it immediately and defeat the one-frame streaming budget below.
    const started = this.markRunning(agentId);
    if (started) {
      this.queueTurnStarted(agentId);
      this.postState();
    }
    const live = this.liveMessages.get(agentId) ?? {
      role: 'agent',
      text: '',
      ts: new Date().toISOString(),
      seq: this.allocateSeq(agentId),
      // Carried so a segment flushed mid-turn and the final reply that repeats it share a turn identity.
      // Without it deduplicateFinalReply cannot tell this turn's double-emit from a later deliberate resend,
      // and whichever way it guesses, one of the two is wrong.
      turnEpoch: acceptedEpoch,
      fromName: this.agentName(agentId),
    };
    // Once a live reply has its disclosure suffix it is terminally capped; rebuilding the suffix for
    // every later delta would itself grow the live transcript.
    if (live.text.length > MAX_AGENT_MESSAGE_CHARS) {
      return;
    }
    const bounded = clampText(`${live.text}${delta}`, MAX_AGENT_MESSAGE_CHARS, 'agent message')!;
    const added = bounded.slice(live.text.length);
    if (!added) {
      return;
    }
    live.text = bounded;
    this.liveMessages.set(agentId, live);
    const markdown = this.liveMessageMarkdown.get(agentId) ?? new LiveMarkdown();
    this.liveMessageMarkdown.set(agentId, markdown);
    markdown.push(added);
    this.scheduleLiveMarkdownFrame(agentId, 'message', acceptedEpoch);
  }

  /** Stream the agent's reasoning/"thinking" for the current turn into a live Analysis card. */
  appendReasoning(agentId: string, delta: string, epoch?: number): void {
    this.syncAgents();
    if (!this.agentIds.has(agentId) || delta.length === 0) {
      return;
    }
    const acceptedEpoch = this.acceptEventEpoch(agentId, epoch);
    if (acceptedEpoch === undefined) {
      return;
    }
    const currentText = this.liveReasoning.get(agentId)?.text ?? '';
    const readableDelta = boundedReasoningDelta(currentText, delta);
    // Some reasoning gateways stream hundreds of blank lines (and occasionally indentation-only
    // fragments) before a word. Rendering those bytes produced a multi-screen empty Analysis card even
    // though they conveyed nothing. Preserve paragraph structure, but do not create a card from whitespace
    // alone and never retain more than one blank line between reasoning fragments.
    if (!readableDelta) {
      return;
    }
    // Keep the start announcement outside the live markdown update for the same pacing reason as replies.
    const started = this.markRunning(agentId);
    if (started) {
      this.queueTurnStarted(agentId);
      this.postState();
    }
    const live = this.liveReasoning.get(agentId) ?? {
      id: `reason-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text: '',
      ts: new Date().toISOString(),
      seq: this.allocateSeq(agentId),
    };
    live.text += readableDelta;
    this.liveReasoning.set(agentId, live);
    const markdown = this.liveReasoningMarkdown.get(agentId) ?? new LiveMarkdown();
    this.liveReasoningMarkdown.set(agentId, markdown);
    markdown.push(readableDelta);
    this.scheduleLiveMarkdownFrame(agentId, 'reasoning', acceptedEpoch);
  }

  /** Move the current turn's live reasoning into the finalized (collapsed) transcript on turn end. */
  private finalizeReasoning(agentId: string): ChatReasoning | undefined {
    const live = this.liveReasoning.get(agentId);
    if (!live) {
      return undefined;
    }
    const blocks = this.flushLiveMarkdownFrame(agentId, 'reasoning', true);
    this.liveReasoning.delete(agentId);
    const markdown = this.liveReasoningMarkdown.get(agentId);
    this.liveReasoningMarkdown.delete(agentId);
    if (!live.text.trim()) {
      return undefined;
    }
    const items = this.loadReasoning(agentId);
    const item: ChatReasoning = {
      kind: 'reasoning' as const,
      id: live.id,
      ts: live.ts,
      seq: live.seq ?? this.allocateSeq(agentId),
      text: live.text,
      blocks: blocks ?? markdown?.finish() ?? renderMarkdown(live.text),
    };
    items.push(item);
    this.reasoningItems.set(agentId, trimTransientItems(items));
    void this.deps.state.update(chatReasoningKey(agentId), serializeReasoningItems(this.reasoningItems.get(agentId) ?? []));
    return item;
  }

  private flushLiveMessage(agentId: string): ChatViewMessage | undefined {
    const live = this.liveMessages.get(agentId);
    if (!live) {
      return undefined;
    }
    const blocks = this.flushLiveMarkdownFrame(agentId, 'message', true);
    this.liveMessages.delete(agentId);
    const markdown = this.liveMessageMarkdown.get(agentId);
    this.liveMessageMarkdown.delete(agentId);
    if (!live.text.trim()) {
      return undefined;
    }
    this.append(agentId, live);
    return {
      ...live,
      kind: 'message',
      blocks: blocks ?? markdown?.finish() ?? renderMarkdown(live.text),
    };
  }

  appendToolActivity(agentId: string, event: ChatToolEvent): void {
    this.syncAgents();
    if (!this.agentIds.has(agentId)) {
      return;
    }
    // A tool result's detail/diff was UNBOUNDED, and currentState() re-serializes the whole transcript on
    // every state push — so one multi-megabyte result (a big file read, a binary blob) is copied again on
    // every subsequent update, and persisted. Cap it at the source: the card shows a summary anyway, and a
    // detail nobody can read is not worth an OOM in a shared extension host.
    event = capToolPayload(event);
    const acceptedEpoch = this.acceptEventEpoch(agentId, event.epoch);
    if (acceptedEpoch === undefined) {
      return;
    }
    // C3: update_todos isn't a transcript card — it (re)sets the pinned checklist. Capture the
    // snapshot from the call input and suppress both phases from the tool-card stream.
    if (event.name === 'update_todos') {
      if (event.phase === 'use') {
        this.todos.set(agentId, parseTodos(event.input));
        const started = this.markRunning(agentId);
        if (started) {
          this.queueTurnStarted(agentId);
        }
        if (started || agentId === this.selectedAgentId) {
          this.postState();
        }
      }
      return;
    }
    const finalized: ChatTranscriptItem[] = [];
    if (event.phase === 'use') {
      const reasoning = this.finalizeReasoning(agentId);
      const message = this.flushLiveMessage(agentId);
      if (reasoning) { finalized.push(reasoning); }
      if (message) { finalized.push(message); }
    }
    const current = this.loadTools(agentId);
    const { next, item: changed } = event.phase === 'result'
      ? finishPendingTool(current, event, acceptedEpoch)
      : (() => {
          const started = this.ensureSeq(agentId, toolActivityFromEvent(event, acceptedEpoch));
          return { next: [...current, started], item: started };
        })();
    for (const item of next) {
      this.ensureSeq(agentId, item);
    }
    const trimmed = trimTransientItems(next, CHAT_TOOLS_LIMIT);
    this.toolActivities.set(agentId, trimmed);
    // Durable tool cards (0.6.13): persist on finalize so diffs/output survive a reload. We persist
    // only on 'result' (pending cards are filtered out by serializeToolActivities), which also keeps
    // the write frequency to one per completed tool rather than one per phase.
    if (event.phase === 'result') {
      void this.deps.state.update(chatToolsKey(agentId), serializeToolActivities(trimmed));
    }
    const started = this.markRunning(agentId);
    if (started) {
      this.queueTurnStarted(agentId);
    }
    if (agentId === this.selectedAgentId) {
      for (const item of finalized) {
        this.postToVisible({ command: 'transcriptItem', agentId, item, epoch: acceptedEpoch });
      }
      if (changed) {
        this.postToVisible({
          command: event.phase === 'result' ? 'toolUpdated' : 'toolAppended',
          agentId,
          item: this.toolViewActivity(agentId, changed),
          epoch: acceptedEpoch,
          turnStartedAt: this.turnStartedAt.get(agentId),
        });
      }
    }
    if (started) {
      this.postState();
    }
  }

  /** An agent reported the size of its context. The meter reads it from the session; the view redraws. */
  setContext(agentId: string): void {
    this.syncAgents();
    if (!this.agentIds.has(agentId)) {
      return;
    }
    if (agentId === this.selectedAgentId) {
      this.postState();
    }
  }

  /** Add the disclosure card beside the user turn it describes. It is a record, not prompt text. */
  setContextManifest(agentId: string, manifest: TurnContextManifest, epoch: number): void {
    this.syncAgents();
    if (!this.agentIds.has(agentId)) {
      return;
    }
    const turnEpoch = normalizeEpoch(epoch);
    if (turnEpoch === undefined) {
      return;
    }
    const current = this.contextManifests.get(agentId) ?? [];
    if (current.some((item) => item.turnEpoch === turnEpoch)) {
      return;
    }
    const userTurn = this.loadHistory(agentId).find((message) => message.role === 'user' && message.turnEpoch === turnEpoch);
    current.push({
      kind: 'contextManifest',
      id: `context-${agentId}-${turnEpoch}`,
      ts: userTurn?.ts ?? new Date().toISOString(),
      // A fractional sequence keeps the card immediately after its user turn while never altering that turn.
      seq: userTurn?.seq !== undefined ? userTurn.seq + 0.01 : this.allocateSeq(agentId),
      turnEpoch,
      manifest,
    });
    this.contextManifests.set(agentId, trimTransientItems(current, CHAT_HISTORY_LIMIT));
    if (agentId === this.selectedAgentId) {
      this.postState();
    }
  }

  /**
   * Say that a compaction started, before anything is known about how it ends.
   *
   * Compaction calls a summarizer model, so it can run for many seconds. Until now the transcript said
   * nothing for that whole time and then printed a result — the same silence that made an unlabelled
   * control read as broken. A user who pressed a button is owed an acknowledgement immediately, not an
   * outcome eventually. (Owner, 2026-08-11.)
   */
  beginCompaction(agentId: string): void {
    this.syncAgents();
    if (!this.agentIds.has(agentId) || this.pendingCompactions.has(agentId)) {
      return;
    }
    const id = `compacting-${Date.now()}`;
    const markers = this.compactionMarkers.get(agentId) ?? [];
    markers.push({
      kind: 'marker',
      id,
      ts: new Date().toISOString(),
      seq: this.allocateSeq(agentId),
      text: 'Compacting older turns into a summary…',
    });
    this.compactionMarkers.set(agentId, trimTransientItems(markers));
    this.pendingCompactions.set(agentId, id);
    if (agentId === this.selectedAgentId) {
      this.postState();
    }
  }

  /** Remove the in-progress marker. Always runs, including when the compaction failed or threw. */
  endCompaction(agentId: string): void {
    const id = this.pendingCompactions.get(agentId);
    if (!id) {
      return;
    }
    this.pendingCompactions.delete(agentId);
    const markers = (this.compactionMarkers.get(agentId) ?? []).filter((marker) => marker.id !== id);
    this.compactionMarkers.set(agentId, markers);
    if (agentId === this.selectedAgentId) {
      this.postState();
    }
  }

  /**
   * Run a compaction the user asked for, from any surface.
   *
   * Both the composer button and the palette command land here, so the transcript behaves identically
   * whichever one is used — the same reason the outcome sentence lives in one function.
   */
  async runCompaction(agentId: string): Promise<void> {
    this.syncAgents();
    if (!this.agentIds.has(agentId)) {
      return;
    }
    this.beginCompaction(agentId);
    try {
      await this.deps.compactContext?.(agentId);
    } finally {
      this.endCompaction(agentId);
    }
  }

  /**
   * v0.9.90: show one compaction receipt in the agent's chat, once per operation across reloads and state
   * pushes. The summary, when the route exposes one, is attached collapsed; it is context, never evidence.
   */
  postCompactionReceipt(agentId: string, receiptId: string, text: string, summary: string | undefined): boolean {
    return this.postRuntimeNoticeOnce(agentId, `compaction:${receiptId}`, text, summary?.trim() ? { compactionSummary: summary } : undefined);
  }

  /**
   * Say, in the transcript, that the agent just learned its own ceiling.
   *
   * Silently shrinking the window would leave the user watching compaction fire for reasons they cannot
   * see. This marker is the difference between "the tool changed its mind" and "the provider refused a
   * request this size, so the tool believes it now".
   */
  appendContextWindowMarker(agentId: string, model: string, tokens: number): void {
    this.syncAgents();
    if (!this.agentIds.has(agentId)) {
      return;
    }
    const markers = this.compactionMarkers.get(agentId) ?? [];
    markers.push({
      kind: 'marker',
      id: `ctxwindow-${Date.now()}-${markers.length}`,
      ts: new Date().toISOString(),
      seq: this.allocateSeq(agentId),
      text: `${model} rejected a request of about ${tokens.toLocaleString()} tokens — using that as its context `
        + 'window from now on, and compacting before it is reached.',
    });
    this.compactionMarkers.set(agentId, trimTransientItems(markers));
    if (agentId === this.selectedAgentId) {
      this.postState();
    }
  }

  /** Display name of the currently selected agent (for confirmation prompts), or undefined if none. */
  getSelectedAgentName(): string | undefined {
    return this.selectedAgentId ? this.agentName(this.selectedAgentId) : undefined;
  }

  /** Id of the currently selected chat agent (for the ⚡ Solo/team toggle), or undefined if none. */
  getSelectedAgentId(): string | undefined {
    return this.selectedAgentId || undefined;
  }

  /**
   * Put user-selected editor text into the currently selected conversation without sending a turn.
   * A state-carried revision survives opening a new Workbench webview; the webview acknowledges it so a
   * later refresh never re-inserts text the user has already sent or edited.
   */
  insertIntoSelectedComposer(text: string): boolean {
    this.syncAgents();
    const agentId = this.selectedAgentId;
    if (!agentId || !this.agentIds.has(agentId) || !text.trim()) {
      return false;
    }
    this.composerInsertion = { agentId, text, revision: ++this.composerInsertionSeq };
    this.openWorkbench(false);
    this.postState();
    return true;
  }

  /** Post a UnodeAi notice into an agent's chat transcript (in-panel, not an OS toast). Clears the
   *  agent's "running" state, because a notice is posted in PLACE of a turn — otherwise the composer
   *  would stay stuck on "Stop" with the input disabled (no turn_complete will ever arrive). */
  postNotice(agentId: string, text: string): void {
    this.syncAgents();
    if (!this.agentIds.has(agentId)) {
      return;
    }
    this.markStopped(agentId);
    this.finalizeReasoning(agentId);
    // The notice follows whatever the turn already showed; it never replaces it (field finding F5).
    this.flushLiveMessage(agentId);
    this.clearLiveMarkdown(agentId);
    this.append(agentId, {
      role: 'agent', text, ts: new Date().toISOString(), fromName: 'UnodeAi', runtimeNotice: true,
    });
    if (agentId === this.selectedAgentId) {
      this.postState();
    }
  }

  /** Append a host-observed runtime event without ending the active turn. */
  postRuntimeNotice(agentId: string, text: string): void {
    this.syncAgents();
    if (!this.agentIds.has(agentId)) return;
    this.append(agentId, { role: 'agent', text, ts: new Date().toISOString(), fromName: 'UnodeAi' });
    if (agentId === this.selectedAgentId) this.postState();
  }

  /**
   * v0.9.89: append a host notice exactly once per `noticeKey`, across reloads and state pushes. It never ends
   * or marks the active turn stopped and never enters model context. Returns false when it was already shown
   * or the agent's chat no longer exists.
   */
  postRuntimeNoticeOnce(
    agentId: string,
    noticeKey: string,
    text: string,
    extra?: Pick<ChatHistoryMessage, 'compactionSummary'>,
  ): boolean {
    this.syncAgents();
    if (!this.agentIds.has(agentId) || !noticeKey || !text.trim()) return false;
    const stateKey = `${CHAT_NOTICE_KEYS_PREFIX}${agentId}`;
    const shown = this.deps.state.get<unknown>(stateKey);
    const keys = Array.isArray(shown) ? shown.filter((key): key is string => typeof key === 'string') : [];
    if (keys.includes(noticeKey) || this.loadHistory(agentId).some((message) => message.noticeKey === noticeKey)) {
      return false;
    }
    void this.deps.state.update(stateKey, [...keys, noticeKey].slice(-CHAT_NOTICE_KEYS_KEPT));
    this.append(agentId, {
      role: 'agent', text, ts: new Date().toISOString(), fromName: 'UnodeAi', runtimeNotice: true, noticeKey, ...extra,
    });
    if (agentId === this.selectedAgentId) this.postState();
    return true;
  }

  exportSelected(): { agent: ChatTranscriptAgent; messages: ChatHistoryMessage[] } | undefined {
    const agents = this.syncAgents();
    const agent = agents.find((a) => a.id === this.selectedAgentId);
    if (!agent) {
      return undefined;
    }
    return {
      agent: { id: agent.id, name: agent.name, role: agent.role },
      messages: serializeChatHistory(this.loadHistory(agent.id)),
    };
  }

  hasSelectedMessages(): boolean {
    return (this.exportSelected()?.messages.length ?? 0) > 0;
  }

  importToSelected(messages: ChatHistoryMessage[]): boolean {
    const agents = this.syncAgents();
    const agent = agents.find((a) => a.id === this.selectedAgentId);
    if (!agent) {
      return false;
    }
    this.bumpTurnEpoch(agent.id);
    const next = serializeChatHistory(messages);
    this.presentation.replaceTranscript(agent.id, next);
    this.clearLiveMarkdown(agent.id);
    this.reasoningItems.delete(agent.id);
    this.toolActivities.delete(agent.id);
    this.todos.delete(agent.id);
    this.compactionMarkers.delete(agent.id);
    this.clearRenderedMarkdownCache(agent.id);
    void this.deps.state.update(chatHistoryKey(agent.id), next);
    void this.deps.state.update(chatToolsKey(agent.id), undefined);
    void this.deps.state.update(chatReasoningKey(agent.id), undefined);
    this.postState();
    return true;
  }

  setCompact(compact = !this.compact): boolean {
    this.compact = compact;
    this.postState();
    return this.compact;
  }

  /** One-click clear of the CURRENTLY selected agent's chat transcript (keeps it selected). */
  clearSelectedAgent(): void {
    const agentId = this.selectedAgentId;
    if (!agentId) {
      return;
    }
    this.wipeAgentView(agentId);
    this.postState();
  }

  /**
   * Archive the CURRENTLY selected agent's transcript: save it to the durable archive store, then
   * wipe it from the live panel (like clear, but recoverable via "View Archived Chats"). Returns the
   * number of messages archived (0 when there's nothing to archive / no selection).
   */
  archiveSelectedAgent(): number {
    const agentId = this.selectedAgentId;
    if (!agentId) {
      return 0;
    }
    const messages = this.loadHistory(agentId);
    if (messages.length === 0) {
      return 0;
    }
    const agent = this.syncAgents().find((a) => a.id === agentId);
    const entry: ArchivedChat = {
      id: makeArchiveId(),
      agentId,
      agentName: agent?.name ?? this.agentName(agentId),
      role: agent?.role,
      archivedAt: new Date().toISOString(),
      messages: serializeChatHistory(messages),
    };
    const list = deserializeArchives(this.deps.state.get(CHAT_ARCHIVE_KEY));
    void this.deps.state.update(CHAT_ARCHIVE_KEY, serializeArchives([entry, ...list]));
    this.wipeAgentView(agentId);
    this.postState();
    return messages.length;
  }

  /** Archived chats (newest first), for the picker. */
  listArchivedChats(): ArchivedChat[] {
    return deserializeArchives(this.deps.state.get(CHAT_ARCHIVE_KEY));
  }

  /** Messages currently held for an agent (used to confirm before a restore would replace them). */
  getMessageCount(agentId: string): number {
    return this.loadHistory(agentId).length;
  }

  /**
   * Restore an archived chat back into its agent and select it. Removes the entry from the archive
   * (it's now live again). Fails if the agent is no longer in the team, or the id is unknown.
   */
  restoreArchive(id: string): { ok: boolean; reason?: 'not-found' | 'agent-gone' } {
    const list = this.listArchivedChats();
    const entry = list.find((a) => a.id === id);
    if (!entry) {
      return { ok: false, reason: 'not-found' };
    }
    this.syncAgents();
    if (!this.agentIds.has(entry.agentId)) {
      return { ok: false, reason: 'agent-gone' };
    }
    this.selectedAgentId = entry.agentId;
    this.deps.onSelectAgent?.(entry.agentId);
    this.importToSelected(entry.messages); // sets history + posts state
    void this.deps.state.update(CHAT_ARCHIVE_KEY, serializeArchives(list.filter((a) => a.id !== id)));
    return { ok: true };
  }

  /** Drop every in-memory + persisted trace of an agent's live transcript (shared by clear/archive). */
  private wipeAgentView(agentId: string): void {
    // Keep the bumped epoch for clear/archive: stale in-flight frames from the just-wiped turn must
    // stay fenced even though the agent remains on the team.
    this.bumpTurnEpoch(agentId);
    this.presentation.clearTranscript(agentId);
    this.clearLiveMarkdown(agentId);
    this.reasoningItems.delete(agentId);
    this.toolActivities.delete(agentId);
    this.todos.delete(agentId);
    this.compactionMarkers.delete(agentId);
    this.contextManifests.delete(agentId);
    this.clearSoloSuggestionsForAgent(agentId);
    this.clearRenderedMarkdownCache(agentId);
    this.clearJobOutcomeAnchors(agentId);
    void this.deps.state.update(chatHistoryKey(agentId), undefined);
    void this.deps.state.update(chatToolsKey(agentId), undefined);
    void this.deps.state.update(chatReasoningKey(agentId), undefined);
  }

  clearAgent(agentId: string): void {
    this.bumpTurnEpoch(agentId);
    this.turnEpochs.delete(agentId);
    this.presentation.clearTranscript(agentId);
    this.clearLiveMarkdown(agentId);
    this.reasoningItems.delete(agentId);
    this.toolActivities.delete(agentId);
    this.todos.delete(agentId);
    this.compactionMarkers.delete(agentId);
    this.contextManifests.delete(agentId);
    this.clearSoloSuggestionsForAgent(agentId);
    this.markStopped(agentId);
    this.clearRenderedMarkdownCache(agentId);
    this.clearJobOutcomeAnchors(agentId);
    void this.deps.state.update(chatHistoryKey(agentId), undefined);
    void this.deps.state.update(chatToolsKey(agentId), undefined);
    void this.deps.state.update(chatReasoningKey(agentId), undefined);
    if (this.selectedAgentId === agentId) {
      this.selectedAgentId = '';
    }
    this.refresh();
  }

  dispose(): void {
    this.replyDisposer();
    // Release any in-flight approval waiters as a deny so a torn-down panel never hangs the agent.
    this.approvals.denyAll();
    for (const timer of this.liveMessageTimers.values()) {
      clearTimeout(timer);
    }
    for (const timer of this.liveReasoningTimers.values()) {
      clearTimeout(timer);
    }
    this.liveMessageTimers.clear();
    this.liveReasoningTimers.clear();
    this.disposeSidebarView();
    this.disposeWorkbenchPanel();
  }

  private onMessage(raw: unknown, source?: ChatContainer): void {
    const parsed = parseChatWebviewInboundMessage(raw);
    if (!parsed.ok) {
      this.recordRejectedWebviewMessage(parsed.reason);
      return;
    }
    const msg = parsed.message;
    if (msg.command === 'renderedTranscriptItemsMissing') {
      this.recordRenderedTranscriptDisappearance(msg, source);
      return;
    }
    if (msg.command === 'attentionResult') {
      if (source) {
        this.deps.onAttentionResult?.({ id: msg.id, audioState: msg.audioState, started: msg.started, surface: source });
      }
      return;
    }
    if (msg.command === 'accessibilityFocus') {
      if (!source) {
        return;
      }
      if (msg.focused === true) {
        this.focusedContainer = source;
      } else if (msg.focused === false && this.focusedContainer === source) {
        this.focusedContainer = undefined;
      }
      return;
    }
    if (msg.command === 'focusEditor') {
      this.focusPreviousEditor();
      return;
    }
    if (msg.command === 'composerInsertionApplied') {
      if (msg.revision === this.composerInsertion?.revision) {
        this.composerInsertion = undefined;
      }
      return;
    }
    if (msg.command === 'chatCommand') {
      // The Workbench editor tab has no view title bar of its own, so these buttons live in the webview.
      // A webview may therefore NAME a command, which means the host must decide which names exist: the
      // allowlist is the boundary, and anything outside it is dropped rather than executed.
      const target = WORKBENCH_CHAT_COMMANDS.has(msg.target) ? msg.target : undefined;
      if (target) {
        void vscode.commands.executeCommand(target);
      }
      return;
    }
    if (msg.command === 'repairAction') {
      if (msg.kind === 'configure-agent-model' || msg.kind === 'retry-delegation'
        || msg.kind === 'retry-same-route' || msg.kind === 'switch-route' || msg.kind === 'stop-request') {
        void this.runOutcomeRepair(msg.outcomeId, msg.kind);
      } else {
        this.deps.runRepairAction?.(msg.kind);
      }
      return;
    }
    // The webview supplies only opaque host-issued ids. It never supplies a path: resolve the path from
    // the durable tool receipt, then let the extension re-apply the selected agent's physical read roots.
    if (msg.command === 'openToolFile') {
      if (!this.agentIds.has(msg.agentId) || msg.agentId !== this.selectedAgentId) {
        return;
      }
      const tool = this.loadTools(msg.agentId).find((candidate) =>
        candidate.id === msg.toolId && candidate.phase === 'result' && candidate.ok !== false
      );
      const filePath = tool ? readFilePathFromActivity(tool) : undefined;
      if (filePath) {
        void this.deps.openWorkspaceFile?.(msg.agentId, filePath);
      }
      return;
    }
    // Rail actions carry only a checkpoint id; the host resolves it against its own store, so a
    // webview cannot name a path to open or overwrite.
    if (msg.command === 'openCheckpointDiff' || msg.command === 'restoreCheckpoint') {
      vscode.commands.executeCommand(
        msg.command === 'openCheckpointDiff' ? 'unode.showCheckpointDiff' : 'unode.restoreCheckpointById',
        msg.checkpointId,
      );
      return;
    }
    if (msg.command === 'selectAgent') {
      if (this.agentIds.has(msg.agentId)) {
        this.selectedAgentId = msg.agentId;
        this.loadHistory(msg.agentId);
        this.deps.onSelectAgent?.(msg.agentId);
        this.postState();
        void this.refreshRepairState();
      }
      return;
    }
    if (msg.command === 'setMode') {
      if (this.agentIds.has(msg.agentId)) {
        this.modes.set(msg.agentId, msg.mode);
        this.postState();
      }
      return;
    }
    if (msg.command === 'send') {
      this.syncAgents();
      const agentId = msg.agentId;
      const text = msg.text.trim();
      const requestId = msg.requestId;
      const attachments = msg.attachments;
      const reject = (clause: ComposerSendRejection['clause'], reason: string) => {
        const rejection: ComposerSendRejection = {
          clause,
          requestedAgentId: agentId,
          selectedAgentId: this.selectedAgentId,
          requestId,
        };
        this.deps.onSendRejected?.(rejection);
        this.postToContainer(source, {
          command: 'sendRejected',
          requestId,
          reason,
          requestedAgentId: agentId,
          selectedAgentId: this.selectedAgentId,
        });
      };
      if (!text && attachments.length === 0) {
        reject('empty', 'Your message is empty. It was not sent.');
        return;
      }
      if (!this.agentIds.has(agentId)) {
        reject('unknown-agent', 'That agent is no longer available. Your message was kept. Choose an active agent and send again.');
        return;
      }
      // The webview names an existing agent. Its selection may have raced a state update from the
      // other chat surface, but that is not a reason to discard the user's turn. Make the explicit
      // send authoritative so the accepted bubble remains visible in both shared containers.
      if (agentId !== this.selectedAgentId) {
        this.selectedAgentId = agentId;
        this.loadHistory(agentId);
        this.deps.onSelectAgent?.(agentId);
      }
      if (this.runningAgentIds.has(agentId)) {
        if (!text) {
          reject('empty', 'A steering message needs text. Your attachments were kept.');
          return;
        }
        // Show the steer in the transcript (the normal send path below does this too). Without it the
        // box just clears and the steer feels IGNORED even when the backend folds it in.
        this.append(agentId, { role: 'user', text, ts: new Date().toISOString() });
        this.deps.interject(agentId, text);
        this.postState();
        this.postToContainer(source, { command: 'sendAccepted', requestId });
        return;
      }
      const turnEpoch = this.bumpTurnEpoch(agentId);
      const mode = normalizeChatMode(msg.mode ?? this.modes.get(agentId));
      this.modes.set(agentId, mode);
      this.append(agentId, {
        role: 'user',
        text,
        ts: new Date().toISOString(),
        turnEpoch,
        attachments: attachmentMetadata(attachments),
      });
      if (this.markRunning(agentId)) {
        this.queueTurnStarted(agentId);
      }
      this.deps.send(agentId, text, mode, attachments, turnEpoch);
      this.postState();
      this.postToContainer(source, { command: 'sendAccepted', requestId });
      return;
    }
    if (msg.command === 'jobOutcomeAction') {
      this.runJobOutcomeAction(msg.outcomeId, msg.action);
      return;
    }
    if (msg.command === 'handoffToSolo') {
      const suggestion = this.soloSuggestions.get(msg.id);
      if (!suggestion || !this.agentIds.has(suggestion.soloAgentId)) {
        return;
      }
      this.soloSuggestions.delete(msg.id);
      const soloEpoch = this.bumpTurnEpoch(suggestion.soloAgentId);
      this.append(suggestion.soloAgentId, {
        role: 'user',
        text: suggestion.text,
        ts: new Date().toISOString(),
        turnEpoch: soloEpoch,
      });
      if (this.markRunning(suggestion.soloAgentId)) {
        this.queueTurnStarted(suggestion.soloAgentId);
      }
      // This is a user handoff: no TeamTools call, no PM delegation, and no interruption of the PM turn.
      this.deps.send(suggestion.soloAgentId, suggestion.text, suggestion.mode, [], soloEpoch);
      this.selectedAgentId = suggestion.soloAgentId;
      this.deps.onSelectAgent?.(suggestion.soloAgentId);
      this.postState();
      return;
    }
    if (msg.command === 'compactContext') {
      const agentId = this.selectedAgentId;
      if (agentId && this.agentIds.has(agentId)) {
        void this.runCompaction(agentId);
      }
      return;
    }
    if (msg.command === 'interrupt') {
      if (this.agentIds.has(msg.agentId) && this.runningAgentIds.has(msg.agentId)) {
        // Keep what the stopped turn already put on screen (v0.9.89 field finding F5). The epoch bump below
        // discards live text, and a stopped turn never delivers a final reply that would put it back.
        this.finalizeReasoning(msg.agentId);
        this.flushLiveMessage(msg.agentId);
        this.bumpTurnEpoch(msg.agentId);
        this.deps.interrupt(msg.agentId);
        if (this.runningAgentIds.has(msg.agentId)) {
          this.postNotice(msg.agentId, 'Stopped by user.');
        }
      }
      return;
    }
    if (msg.command === 'approvalDecision') {
      this.approvals.resolve(msg.id, {
        action: msg.action ?? 'deny',
        note: msg.note?.trim() || undefined,
      }, this.deps.approverIdentity?.() || 'local-user');
      return;
    }
    if (msg.command === 'setApproval') {
      if (msg.value) {
        // The setting write is asynchronous (it round-trips through VS Code configuration). Posting state
        // before it lands echoes the OLD value back, and renderApprovalBar() snaps the <select> back to it,
        // so the user's first change looks like it did nothing. Wait for the write, then echo the truth --
        // including when the write fails, because this control states live authority.
        void Promise.resolve(this.deps.setApproval(msg.kind, msg.value))
          .catch(() => undefined)
          .finally(() => this.postState());
      }
      return;
    }
    if (msg.command === 'setCodexPermissionProfile') {
      const agent = this.deps.listAgents().find((candidate) => candidate.id === msg.agentId);
      if (
        agent?.backend !== 'codex'
        || msg.agentId !== this.selectedAgentId
        || normalizeChatMode(this.modes.get(msg.agentId)) !== 'act'
        || agent.codexPermissionCapReason
      ) {
        // A refused change must still re-sync the control, or it keeps showing the choice that was refused.
        this.postState();
        return;
      }
      void Promise.resolve(this.deps.setCodexPermissionProfile?.(msg.agentId, msg.profile))
        .catch(() => undefined)
        .finally(() => this.postState());
      return;
    }
  }

  private recordRenderedTranscriptDisappearance(
    msg: Extract<ChatWebviewInboundMessage, { command: 'renderedTranscriptItemsMissing' }>,
    source: ChatContainer | undefined,
  ): void {
    if (!source) {
      return;
    }
    if (msg.previousItemCount === 0 || msg.missing.length === 0 || msg.missing.length > msg.previousItemCount) {
      return;
    }
    if (msg.cause === 'window-trim') {
      this.renderedTranscriptWindowTrimObservations += 1;
      return;
    }
    const event: RenderedTranscriptDisappearance = {
      source,
      agentId: msg.agentId,
      cause: msg.cause,
      classification: 'display-bug',
      previousItemCount: msg.previousItemCount,
      nextItemCount: msg.nextItemCount,
      missing: msg.missing,
      previousTurnEpoch: msg.previousTurnEpoch,
      nextTurnEpoch: msg.nextTurnEpoch,
      epochChanged: msg.epochChanged,
      observedAt: new Date().toISOString(),
      undeliveredStatePushes: this.undeliveredStatePushes,
      lastUndeliveredSurface: this.lastUndeliveredSurface,
    };
    this.renderedTranscriptDisappearances.push(event);
    if (this.renderedTranscriptDisappearances.length > 50) {
      this.renderedTranscriptDisappearances.splice(0, this.renderedTranscriptDisappearances.length - 50);
    }
    this.deps.onRenderedTranscriptDisappearance?.(event);
    console.warn(
      `[UnodeAi] display-integrity bug: a received full-state push omitted a rendered transcript item (surface=${source}, agent=${event.agentId}, ` +
      `missing=${event.missing.map((item) => `${item.id}:${item.delivery}`).join(',')}, ` +
      `epochChanged=${event.epochChanged}, undeliveredPushes=${event.undeliveredStatePushes})`,
    );
  }

  private onReply(reply: ChatReply): void {
    this.syncAgents();
    if (!this.agentIds.has(reply.from)) {
      return;
    }
    const acceptedEpoch = this.acceptEventEpoch(reply.from, reply.epoch);
    if (acceptedEpoch === undefined) {
      return;
    }
    const wasRunning = this.runningAgentIds.has(reply.from);
    this.markStopped(reply.from);
    const live = this.liveMessages.get(reply.from);
    const hadLiveText = !!live?.text;
    this.finalizeReasoning(reply.from);
    const liveBlocks = hadLiveText ? this.flushLiveMarkdownFrame(reply.from, 'message', true) : undefined;
    this.liveMessages.delete(reply.from);
    this.liveMessageMarkdown.delete(reply.from);
    // Host facts that belong to the reply ending this turn: its conclusion marker and its footer. Text flushed
    // before a tool call never receives them, so a working step can never be styled as the answer.
    const terminal: Pick<ChatHistoryMessage, 'turnFinal' | 'turnTiming' | 'turnId' | 'delegationReceipt' | 'turnTrigger' | 'verbatim' | 'turnOutcome'> = {
      turnFinal: true,
      ...(reply.timing ? { turnTiming: reply.timing } : {}),
      ...(reply.turnId ? { turnId: reply.turnId } : {}),
      ...(reply.delegationReceipt ? { delegationReceipt: reply.delegationReceipt } : {}),
      ...(reply.turnTrigger ? { turnTrigger: reply.turnTrigger } : {}),
      ...(reply.verbatim ? { verbatim: reply.verbatim } : {}),
      ...(reply.turnOutcome ? { turnOutcome: reply.turnOutcome } : {}),
    };
    let finalText = hadLiveText ? reply.text : this.deduplicateFinalReply(reply.from, reply.text, acceptedEpoch);
    if (finalText === undefined) {
      // The terminal text repeats this turn's last agent message. If nothing followed that message, it IS the
      // conclusion: promote it in place so the footer is not lost with the duplicate. If a tool, reasoning or
      // delegation item followed it, the repeat is appended after them instead: a conclusion never sits before
      // the work it concludes, even at the cost of showing the text twice.
      const repeated = this.lastAgentMessage(reply.from);
      if (repeated && this.isLastTranscriptItem(reply.from, repeated)) {
        this.patchHistoryMessage(reply.from, repeated, {
          ...terminal,
          isError: reply.isError,
          completionState: reply.completionState,
        });
        if (wasRunning) {
          this.queueTurnOutcome(reply.from, reply.isError, reply.fromName);
        }
        if (reply.from === this.selectedAgentId || wasRunning) {
          this.postState();
        }
        return;
      }
      finalText = reply.text;
    }
    const item: ChatHistoryMessage = {
      role: 'agent',
      text: finalText,
      ts: new Date().toISOString(),
      seq: hadLiveText ? live?.seq : undefined,
      // Recorded so deduplicateFinalReply can tell a gateway's double-emit of ONE turn from a coordinator
      // deliberately sending the same text again later. Without it the two are indistinguishable, and the
      // deliberate resend is the one that gets thrown away.
      turnEpoch: acceptedEpoch,
      fromName: reply.fromName,
      isError: reply.isError,
      completionState: reply.completionState,
      ...terminal,
    };
    this.append(reply.from, item);
    // Streamed blocks are Markdown; a reply holding exact content is rendered again from its span instead.
    if (liveBlocks && !reply.verbatim && item.seq !== undefined && finalText === live?.text) {
      this.renderedMarkdownBlocks.set(this.renderedMarkdownKey(reply.from, item.seq, finalText), liveBlocks);
    }
    if (reply.emptyReply) this.postRuntimeNoticeOnce(reply.from, reply.emptyReply.noticeKey, reply.emptyReply.text);
    if (wasRunning) {
      this.queueTurnOutcome(reply.from, reply.isError, reply.fromName);
    }
    if (reply.from === this.selectedAgentId || wasRunning) {
      this.postState();
    }
  }

  /**
   * Suppress a final reply that merely repeats what this turn already put on screen.
   *
   * Some gateways emit the completed text twice — once streamed, once as the final message — and rendering
   * both is the defect this exists to prevent. **Repeating the same text in a LATER turn is not that.** A
   * coordinator that re-sends a summary because the user could not see it is making a deliberate second
   * statement, and silently discarding it is how a transcript comes to disagree with what actually
   * happened. The turn is therefore part of the identity: same text plus same turn is a duplicate; same
   * text in a new turn is a new message.
   *
   * Reported from the field 2026-08-09: a long summary was re-sent and vanished again with no trace, which
   * is exactly what an epoch-blind comparison does.
   */
  private deduplicateFinalReply(agentId: string, text: string, epoch: number): string | undefined {
    const last = this.lastAgentMessage(agentId);
    if (!last) {
      return text;
    }
    // Both branches are the same question — is this the SAME turn restating itself, or a later turn
    // speaking again — and only one of them used to ask it. Stripping the prefix without checking the turn
    // silently ate a resent summary whenever the coordinator added a conclusion to it. Found by audit,
    // 2026-08-10, after the exact-match half had already been fixed and tested on its own.
    if (last.turnEpoch !== epoch) {
      return text;
    }
    if (text === last.text) {
      return undefined;
    }
    const prefix = `${last.text}\n\n`;
    return text.startsWith(prefix) ? text.slice(prefix.length) : text;
  }

  private suggestSoloHandoff(sourceAgentId: string, soloAgentId: string, text: string, mode: ChatMode, turnEpoch: number): void {
    const id = `solo-handoff-${sourceAgentId}-${turnEpoch}`;
    const userTurn = this.loadHistory(sourceAgentId).find((message) => message.role === 'user' && message.turnEpoch === turnEpoch);
    this.soloSuggestions.set(id, {
      kind: 'soloSuggestion',
      id,
      ts: new Date().toISOString(),
      seq: userTurn?.seq !== undefined ? userTurn.seq + 0.02 : undefined,
      sourceAgentId,
      soloAgentId,
      text,
      mode,
    });
  }

  private clearSoloSuggestionsForAgent(agentId: string): void {
    for (const [id, suggestion] of this.soloSuggestions) {
      if (suggestion.sourceAgentId === agentId || suggestion.soloAgentId === agentId) {
        this.soloSuggestions.delete(id);
      }
    }
  }

  private lastAgentMessage(agentId: string): ChatHistoryMessage | undefined {
    return this.loadHistory(agentId)
      .filter((m) => m.role === 'agent')
      .sort((a, b) => this.sequenceOf(agentId, b) - this.sequenceOf(agentId, a))[0];
  }

  /** True when nothing (tool, reasoning, delegation, notice) was rendered after this message. */
  private isLastTranscriptItem(agentId: string, message: ChatHistoryMessage): boolean {
    const items = this.transcriptItems(agentId);
    const last = items[items.length - 1];
    return !!last && last.kind === 'message' && this.sequenceOf(agentId, last) === this.sequenceOf(agentId, message);
  }

  /**
   * Replace one persisted message with a patched copy, keeping its position. `loadHistory` returns clones, so the
   * message is found by its transcript sequence (unique per agent), not by object identity.
   */
  private patchHistoryMessage(agentId: string, target: ChatHistoryMessage, patch: Partial<ChatHistoryMessage>): boolean {
    const history = this.loadHistory(agentId);
    const seq = this.sequenceOf(agentId, target);
    const index = history.findIndex((message) =>
      this.sequenceOf(agentId, message) === seq && message.role === target.role && message.text === target.text);
    if (index < 0) {
      return false;
    }
    const next = history.slice();
    next[index] = { ...target, ...patch };
    this.presentation.replaceTranscript(agentId, next);
    void this.deps.state.update(chatHistoryKey(agentId), serializeChatHistory(next));
    return true;
  }

  /**
   * A turn's delegation receipt changed after the turn ended (a queued dispatch was admitted or refused). Patch
   * the footer of the reply that turn produced. This never appends a message and never touches the running
   * state: the coordinator may already be working on its next turn.
   */
  updateTurnReceipt(agentId: string, turnId: string, counts: TurnDelegationCounts): void {
    this.syncAgents();
    if (!this.agentIds.has(agentId)) {
      return;
    }
    const history = this.loadHistory(agentId);
    for (let index = history.length - 1; index >= 0; index--) {
      const message = history[index];
      if (message.role === 'agent' && message.turnId === turnId) {
        if (this.patchHistoryMessage(agentId, message, { delegationReceipt: { ...counts } }) && agentId === this.selectedAgentId) {
          this.postState();
        }
        return;
      }
    }
  }

  private append(agentId: string, message: ChatHistoryMessage): void {
    const before = this.loadHistory(agentId);
    const next = appendChatMessage(before, this.ensureSeq(agentId, message));
    // The window is a FIFO of CHAT_HISTORY_LIMIT and drops the oldest message once it is full.
    //
    // v0.9.50 disclosed each drop with a transcript marker, and that was wrong in a way the finding did not
    // anticipate: this runs on EVERY appended message, so past the limit it dropped exactly one message and
    // added exactly one notice, forever. A disclosure that repeats on every message is not a disclosure —
    // it is a line the reader learns to skip, sitting between them and their conversation. (Owner,
    // 2026-08-11.) The panel limit is documented in USAGE; the transcript is not the place to restate it
    // once per message.
    this.presentation.replaceTranscript(agentId, next);
    void this.deps.state.update(chatHistoryKey(agentId), serializeChatHistory(next));
  }

  private loadHistory(agentId: string): ChatHistoryMessage[] {
    if (this.presentation.hasTranscript(agentId)) {
      return this.presentation.transcript(agentId);
    }
    const restored = deserializeChatHistory(this.deps.state.get(chatHistoryKey(agentId)));
    this.presentation.replaceTranscript(agentId, restored);
    return this.presentation.transcript(agentId);
  }

  /** Tool-card analogue of loadHistory: restores an agent's persisted (finalized) tool cards on first
   *  access so diffs/command output reappear after a reload. */
  private loadTools(agentId: string): ChatToolActivity[] {
    const cached = this.toolActivities.get(agentId);
    if (cached) {
      return cached;
    }
    const restored = deserializeToolActivities(this.deps.state.get(chatToolsKey(agentId)));
    this.toolActivities.set(agentId, restored);
    return restored;
  }

  private loadReasoning(agentId: string): ChatReasoning[] {
    const cached = this.reasoningItems.get(agentId);
    if (cached) {
      return cached;
    }
    const restored = deserializeReasoningItems(this.deps.state.get(chatReasoningKey(agentId)));
    this.reasoningItems.set(agentId, restored);
    return restored;
  }

  private allocateSeq(agentId: string): number {
    this.initializeSeqs(agentId);
    const next = this.nextSeqs.get(agentId) ?? 0;
    this.nextSeqs.set(agentId, next + 1);
    return next;
  }

  private ensureSeq<T extends { seq?: number }>(agentId: string, item: T): T {
    if (!isFiniteSeq(item.seq)) {
      item.seq = this.allocateSeq(agentId);
    }
    return item;
  }

  private sequenceOf(agentId: string, item: { seq?: number }): number {
    this.ensureSeq(agentId, item);
    return item.seq ?? 0;
  }

  /**
   * A card is placed from durable times in each transcript that shows it (F7-20): right after the latest persisted
   * message, reasoning or tool item of this agent that is not later than the card's start, and first when it is
   * older than all of them. It then keeps that position. Live and restored cards follow the same rule, so a chat
   * shows its cards in the same places whenever it is first opened and after a reload. Nothing new is persisted,
   * so existing histories are placed too.
   */
  private delegationSeq(agentId: string, summary: Pick<DelegationProgressSummary, 'id' | 'startedAt' | 'restored'>): number {
    const key = `${agentId}\0delegation:${summary.id}`;
    const existing = this.stableSeqs.get(key);
    if (existing !== undefined) {
      return existing;
    }
    // Every card, live or restored, sits by its start time. A live card used to take the next position the first
    // time its transcript rendered, so in a chat opened later (a worker's, or a PM you were not watching) every card
    // landed after all of that chat's messages (field test, 2026-09-26).
    let anchor: number | undefined;
    let first: number | undefined;
    for (const item of [...this.loadHistory(agentId), ...this.loadReasoning(agentId), ...this.loadTools(agentId)]) {
      const seq = this.sequenceOf(agentId, item);
      first = first === undefined ? seq : Math.min(first, seq);
      if (item.ts <= summary.startedAt && (anchor === undefined || seq > anchor)) {
        anchor = seq;
      }
    }
    const seq = anchor !== undefined ? anchor + 0.5 : first !== undefined ? Math.max(0, first - 0.5) : this.allocateSeq(agentId);
    this.stableSeqs.set(key, seq);
    return seq;
  }

  private sequenceForStableKey(agentId: string, key: string): number {
    const fullKey = `${agentId}\0${key}`;
    const existing = this.stableSeqs.get(fullKey);
    if (existing !== undefined) {
      return existing;
    }
    const seq = this.allocateSeq(agentId);
    this.stableSeqs.set(fullKey, seq);
    return seq;
  }

  private initializeSeqs(agentId: string): void {
    if (this.initializedSeqs.has(agentId)) {
      return;
    }
    this.initializedSeqs.add(agentId);
    let next = 0;
    const visit = (item: { seq?: number }) => {
      if (isFiniteSeq(item.seq)) {
        item.seq = Math.floor(item.seq);
        next = Math.max(next, item.seq + 1);
      } else {
        item.seq = next++;
      }
    };
    for (const item of this.loadHistory(agentId)) {
      visit(item);
    }
    for (const item of this.loadReasoning(agentId)) {
      visit(item);
    }
    for (const item of this.loadTools(agentId)) {
      visit(item);
    }
    for (const item of this.compactionMarkers.get(agentId) ?? []) {
      visit(item);
    }
    this.nextSeqs.set(agentId, next);
  }

  private syncAgents(preferredAgentId?: string): ChatAgent[] {
    const agents = this.deps.listAgents();
    const previousAgentId = this.selectedAgentId;
    this.agentIds = new Set(agents.map((a) => a.id));
    const preferred = preferredAgentId && this.agentIds.has(preferredAgentId) ? preferredAgentId : undefined;
    if (preferred) {
      this.selectedAgentId = preferred;
    } else if (!this.selectedAgentId || !this.agentIds.has(this.selectedAgentId)) {
      this.selectedAgentId = agents[0]?.id ?? '';
    }
    if (this.selectedAgentId) {
      this.loadHistory(this.selectedAgentId);
      if (!this.modes.has(this.selectedAgentId)) {
        this.modes.set(this.selectedAgentId, 'act');
      }
    }
    if (this.selectedAgentId !== previousAgentId) {
      this.deps.onSelectAgent?.(this.selectedAgentId);
    }
    return agents;
  }

  private currentState(): ChatViewState {
    const agents = this.syncAgents();
    const messages = this.selectedAgentId
      ? this.transcriptItems(this.selectedAgentId)
      : [];
    const repair = agents.length === 0 ? 'no-team' : this.repairState;
    return {
      hostInstanceId: this.hostInstanceId,
      attentionSound: this.deps.attentionSoundEnabled?.() === true,
      agents,
      selectedAgentId: this.selectedAgentId,
      messages,
      runningAgentIds: Array.from(this.runningAgentIds),
      // In-flight async delegations per coordinator. After v0.9.28 a PM RELEASES its turn on an async
      // dispatch, so while a teammate works the PM is genuinely idle and the composer correctly says "Send".
      // Without this count the PM looks completely idle and then springs to life on the auto-wake — correct
      // behavior that reads as a glitch. Derived from the delegation summaries the chat already renders.
      delegatingCounts: delegatingCountsFrom(this.delegations),
      delegatingOut: delegatingOutFrom(this.delegations),
      waitingResultCounts: Object.fromEntries(agents
        .map((agent) => [agent.id, this.deps.delegationWaitingResults?.(agent.id) ?? 0] as const)
        .filter(([, count]) => count > 0)),
      mode: this.currentMode(this.selectedAgentId),
      compact: this.compact,
      todos: this.selectedAgentId ? this.todos.get(this.selectedAgentId) ?? [] : [],
      approvals: this.deps.getApprovals(),
      pendingApprovals: this.approvals.list(),
      approvalAttention: this.selectedAgentId ? this.approvalAttentionForAgent(this.selectedAgentId) : undefined,
      approvalOutcomes: this.selectedAgentId ? this.approvalOutcomesForAgent(this.selectedAgentId) : [],
      outcomeRepairs: this.selectedAgentId ? this.outcomeRepairsForAgent(this.selectedAgentId) : [],
      smoothStreaming: smoothStreamingEnabled(),
      turnEpochs: Object.fromEntries(this.turnEpochs),
      turnStartedAt: Object.fromEntries(this.turnStartedAt),
      turnPhases: Object.fromEntries(this.turnPhases),
      inspectorOpen: this.inspectorOpen,
      changedFileGroups: this.changedFileGroups(agents),
      repair,
      repairCopy: repair ? repairCopyFor(repair) : undefined,
      announcement: this.announcement,
      composerInsertion: this.composerInsertion,
      contextMeter: this.selectedAgentId ? this.deps.contextMeter?.(this.selectedAgentId) : undefined,
    };
  }

  /**
   * The rail reports the team, not merely the currently selected conversation. Read the existing
   * per-agent checkpoint record directly so selecting the PM never creates a second edit-history truth.
   */
  private changedFileGroups(agents: ChatAgent[]): ChangedFileGroup[] {
    if (!this.deps.getCheckpoints) { return []; }
    const names = new Map(agents.map((agent) => [agent.id, agent.name]));
    return [...groupChangedFilesByAgent(this.deps.getCheckpoints()).entries()]
      .map(([agentId, files]) => ({ agentId, agentName: names.get(agentId) ?? agentId, files }))
      .sort((a, b) => a.agentName.localeCompare(b.agentName));
  }

  /** Host-owned rail visibility, so the title-bar toggle and the remembered state stay outside the
   *  webview. Posting state is enough — the rail is a CSS class, not a re-render. */
  setInspectorOpen(open: boolean): void {
    if (this.inspectorOpen === open) {
      return;
    }
    this.inspectorOpen = open;
    this.postState();
  }

  isInspectorOpen(): boolean {
    return this.inspectorOpen;
  }

  /** Called when a checkpoint is recorded so the rail reflects an edit that just landed. */
  refreshChangedFiles(): void {
    if (this.inspectorOpen) {
      this.postState();
    }
  }

  /**
   * Post to a webview and NOTICE when it does not arrive.
   *
   * `postMessage` resolves `false` when the message was not delivered. Every call site used to discard that
   * with `void`, which made a dropped push unfalsifiable: no log, no test, no signal — the webview simply
   * kept rendering whatever it last received, and content appeared to vanish. A failure mode nobody can
   * observe cannot be investigated, and it was one of two open candidates for a field report of a
   * disappearing reply.
   *
   * **This counts and reports; it deliberately does not retry.** Retrying an unmeasured failure is a guess
   * wearing a fix's clothes, and it would destroy the very signal this exists to produce.
   */
  private postToWebview(webview: vscode.Webview | undefined, message: ChatWebviewOutboundMessage, surface: string): void {
    if (!webview) {
      return;
    }
    void Promise.resolve(webview.postMessage(message)).then(
      (delivered) => {
        if (delivered === false) {
          this.recordUndeliveredPush(surface, message);
        }
      },
      (err) => this.recordUndeliveredPush(surface, message, err),
    );
  }

  private recordUndeliveredPush(surface: string, message: unknown, err?: unknown): void {
    this.undeliveredStatePushes++;
    this.lastUndeliveredSurface = surface;
    const command = (message as { command?: unknown } | undefined)?.command;
    console.warn(
      `[UnodeAi] webview push not delivered (surface=${surface}, command=${String(command ?? 'unknown')}, `
      + `total=${this.undeliveredStatePushes})${err ? `: ${String(err)}` : ''}`
    );
  }

  /** Malformed webview traffic is dropped at the protocol boundary and counted for diagnosis. */
  private recordRejectedWebviewMessage(reason: string): void {
    this.rejectedWebviewMessages++;
    console.warn(`[UnodeAi] rejected chat webview message (${reason}; total=${this.rejectedWebviewMessages})`);
  }

  /** Rejected webview-message count, exposed only for diagnostics and boundary tests. */
  rejectedWebviewMessageCount(): number {
    return this.rejectedWebviewMessages;
  }

  /** Undelivered-push count, for tests and for anyone deciding whether a vanished message was a lost push. */
  undeliveredPushCount(): number {
    return this.undeliveredStatePushes;
  }

  /** Passive disappearance observations, retained only for the current extension-host lifetime. */
  renderedTranscriptDisappearanceLog(): readonly RenderedTranscriptDisappearance[] {
    return this.renderedTranscriptDisappearances;
  }

  /** Number of ordinary FIFO transcript trims observed by this extension-host lifetime. */
  renderedTranscriptWindowTrimCount(): number {
    return this.renderedTranscriptWindowTrimObservations;
  }

  private postState(): void {
    let state = this.currentState();
    this.observeRepairState(state.repair);
    // observeRepairState can create a new announcement; include it in the state delivered for this event.
    state = this.currentState();
    const announcementTarget = this.announcementTarget();
    if (this.sidebarView?.visible) {
      this.postToWebview(this.sidebarView.webview, {
        command: 'state',
        state,
        announce: announcementTarget === 'sidebar',
      }, 'sidebar');
    }
    if (this.workbenchPanel?.visible) {
      this.postToWebview(this.workbenchPanel.webview, {
        command: 'state',
        state,
        announce: announcementTarget === 'workbench',
      }, 'workbench');
    }
  }

  private observeRepairState(repair: ChatRepairState | undefined): void {
    if (!this.repairAnnouncementInitialized) {
      this.repairAnnouncementInitialized = true;
      this.lastRepairForAnnouncement = repair;
      return;
    }
    if (repair && repair !== this.lastRepairForAnnouncement) {
      const copy = repairCopyFor(repair);
      this.queueAnnouncement(`${copy.title}. ${copy.detail}`, 'polite');
    }
    this.lastRepairForAnnouncement = repair;
  }

  private handleApprovalEvent(event: ApprovalEvent): void {
    if (event.type === 'pending') {
      this.queueAnnouncement(
        `${event.approval.agent.name} needs your approval to ${lowercaseFirst(event.approval.action.summary)}.`,
        'assertive',
      );
    } else if (event.type === 'expired') {
      this.approvalOutcomes.set(event.approvalId, {
        state: 'timed_out',
        approvalId: event.approvalId,
        agentId: event.agent.id,
        sessionId: event.sessionId,
      });
      this.deps.onOutcomeRepair?.({
        outcomeId: event.approvalId,
        category: 'consent-timeout',
        state: 'unavailable',
        agentId: event.agent.id,
        sessionId: event.sessionId,
        recordedAt: event.expiredAt,
      });
      this.queueAnnouncement(`Approval for ${event.agent.name} timed out and was denied.`, 'polite');
    } else {
      if (event.type === 'withdrawn') {
        this.queueAnnouncement(`Approval for ${event.agent.name} was withdrawn because the agent was stopped.`, 'polite');
      }
      // A human decision may clear only its own still-pending outcome. A different timeout on the same
      // agent remains visible until that agent begins a later turn.
      this.approvalOutcomes.delete(event.approvalId);
    }
    for (const listener of this.approvalListeners) {
      listener(event);
    }
  }

  private scheduleLiveMarkdownFrame(agentId: string, kind: 'message' | 'reasoning', epoch: number): void {
    const timers = kind === 'message' ? this.liveMessageTimers : this.liveReasoningTimers;
    if (timers.has(agentId)) {
      return;
    }
    // A frame costs O(live tail), not O(document) — LiveMarkdown settles everything a blank line has closed.
    // But one enormous block (a 200-line code fence, a long table) has no blank line to settle on, so its
    // tail IS the whole thing, and 60 fps of that is what melted the extension host. Back off when the tail
    // gets big: nobody perceives 60 fps in a wall of streaming code, and it bounds the worst case instead of
    // leaving a cliff for the next long reply to fall off.
    const markdown = kind === 'message' ? this.liveMessageMarkdown.get(agentId) : this.liveReasoningMarkdown.get(agentId);
    const heavy = (markdown?.liveTailLength() ?? 0) > LIVE_MARKDOWN_HEAVY_TAIL;
    const handle = setTimeout(() => {
      timers.delete(agentId);
      this.flushLiveMarkdownFrame(agentId, kind, false, epoch);
    }, heavy ? LIVE_MARKDOWN_HEAVY_FRAME_MS : LIVE_MARKDOWN_FRAME_MS);
    timers.set(agentId, handle);
  }

  private flushLiveMarkdownFrame(agentId: string, kind: 'message' | 'reasoning', flush = false, epoch = this.currentTurnEpoch(agentId)): MarkdownBlock[] | undefined {
    if (epoch !== this.currentTurnEpoch(agentId)) {
      return undefined;
    }
    const timers = kind === 'message' ? this.liveMessageTimers : this.liveReasoningTimers;
    const pending = timers.get(agentId);
    if (pending) {
      clearTimeout(pending);
      timers.delete(agentId);
    }
    const markdown = kind === 'message'
      ? this.liveMessageMarkdown.get(agentId)
      : this.liveReasoningMarkdown.get(agentId);
    if (!markdown) {
      return undefined;
    }
    const frame = markdown.snapshot();
    if (frame && agentId === this.selectedAgentId) {
      this.postToVisible({
        command: 'liveBlocks',
        agentId,
        kind,
        replaceFrom: frame.replaceFrom,
        blocks: frame.blocks,
        flush,
        epoch,
        turnStartedAt: this.turnStartedAt.get(agentId),
        fromName: kind === 'message' ? (this.liveMessages.get(agentId)?.fromName ?? 'Agent') : undefined,
      });
    }
    return frame?.allBlocks ?? markdown.finish();
  }

  private clearLiveMarkdown(agentId: string): void {
    this.liveMessages.delete(agentId);
    this.liveMessageMarkdown.delete(agentId);
    this.liveReasoning.delete(agentId);
    this.liveReasoningMarkdown.delete(agentId);
    const messageTimer = this.liveMessageTimers.get(agentId);
    if (messageTimer) {
      clearTimeout(messageTimer);
      this.liveMessageTimers.delete(agentId);
    }
    const reasoningTimer = this.liveReasoningTimers.get(agentId);
    if (reasoningTimer) {
      clearTimeout(reasoningTimer);
      this.liveReasoningTimers.delete(agentId);
    }
  }

  private transcriptItems(agentId: string): ChatTranscriptItem[] {
    const items = this.withLiveItems(
      agentId,
      [
        ...this.loadHistory(agentId).map(({ turnOutcome: _hostOnly, ...m }): ChatViewMessage => ({
          ...m,
          kind: 'message',
          blocks: m.role === 'agent' ? this.renderedBlocksForMessage(agentId, m) : undefined,
        })),
        ...this.loadReasoning(agentId).map((r): ChatReasoning => ({
          ...r,
          blocks: r.blocks ?? this.renderedBlocksForReasoning(agentId, r),
        })),
        ...this.delegationItems(agentId),
        ...this.jobOutcomeItems(agentId),
        ...(this.contextManifests.get(agentId) ?? []),
        ...Array.from(this.soloSuggestions.values()).filter((suggestion) => suggestion.sourceAgentId === agentId),
        ...this.loadTools(agentId).map((tool) => this.toolViewActivity(agentId, tool)),
        ...(this.compactionMarkers.get(agentId) ?? []),
      ]
    );
    for (const item of items) {
      this.ensureTranscriptSeq(agentId, item);
    }
    return items.sort((a, b) => (this.sequenceOf(agentId, a) - this.sequenceOf(agentId, b)) || a.ts.localeCompare(b.ts));
  }

  // ─── Job outcome cards (v0.9.93) ────────────────────────────────────────────────────

  /**
   * Closed runs, as the anchors computed from them. Called when a run closes and whenever the ledger changes or
   * is restored: writing an anchor that is already held changes nothing, so a repeated close, a reload and a
   * second window all leave one card. A copy that differs from the one held becomes a conflict, and that card
   * then shows no figure.
   */
  upsertJobOutcomeAnchors(anchors: readonly JobOutcomeAnchorV1[]): void {
    const byCoordinator = new Map<string, JobOutcomeAnchorV1[]>();
    for (const anchor of anchors) {
      byCoordinator.set(anchor.coordinatorId, [...(byCoordinator.get(anchor.coordinatorId) ?? []), anchor]);
    }
    let selectedChanged = false;
    for (const [coordinatorId, incoming] of byCoordinator) {
      const before = this.loadJobOutcomeAnchors(coordinatorId);
      const merged = mergeJobOutcomeAnchors(before, incoming.map((anchor) => ({ state: 'anchored' as const, anchor })));
      if (sameJobOutcomeAnchors(before, merged)) continue;
      this.jobOutcomeAnchors.set(coordinatorId, merged);
      void this.deps.state.update(`${CHAT_JOB_OUTCOMES_KEY_PREFIX}${coordinatorId}`, merged);
      for (const entry of merged) this.jobOutcomeViews.delete(this.jobOutcomeViewKey(coordinatorId, anchorEntryId(entry)));
      if (coordinatorId !== this.selectedAgentId) continue;
      selectedChanged = true;
      // Announced once, when the card first appears for a run that has just closed. A restored card, a late
      // update and a card of another conversation are silent.
      const known = new Set(before.map(anchorEntryId));
      const placed = new Set(this.jobOutcomeItems(coordinatorId).map((item) => item.id));
      const fresh = merged.find((entry) => entry.state === 'anchored'
        && !known.has(entry.anchor.id) && placed.has(entry.anchor.id)
        && Math.abs(Date.now() - Date.parse(entry.anchor.recordedAt)) <= JOB_OUTCOME_ANNOUNCE_WINDOW_MS);
      if (fresh) this.queueAnnouncement('Job outcome is available below the reply.', 'polite');
    }
    if (selectedChanged) this.postState();
  }

  /**
   * The facts behind the cards may have changed: a late receipt, a later disposition, a settled spend unit. Each
   * placed card is projected again; a card whose content changed is replaced in place, and nothing is appended,
   * focused or announced.
   */
  refreshJobOutcomes(): void {
    const agentId = this.selectedAgentId;
    const previous = new Map<string, string>();
    for (const [key, cached] of this.jobOutcomeViews) previous.set(key, cached.renderKey);
    this.jobOutcomeViews.clear();
    if (!agentId) return;
    const changed = this.jobOutcomeItems(agentId)
      .some((item) => previous.get(this.jobOutcomeViewKey(agentId, item.id)) !== item.renderKey);
    if (changed) this.postState();
  }

  private loadJobOutcomeAnchors(agentId: string): JobOutcomeAnchorEntry[] {
    const cached = this.jobOutcomeAnchors.get(agentId);
    if (cached) return cached;
    const restored = deserializeJobOutcomeAnchors(this.deps.state.get(`${CHAT_JOB_OUTCOMES_KEY_PREFIX}${agentId}`), agentId);
    this.jobOutcomeAnchors.set(agentId, restored);
    return restored;
  }

  private clearJobOutcomeAnchors(agentId: string): void {
    for (const entry of this.jobOutcomeAnchors.get(agentId) ?? []) {
      this.jobOutcomeViews.delete(this.jobOutcomeViewKey(agentId, anchorEntryId(entry)));
    }
    this.jobOutcomeAnchors.set(agentId, []);
    void this.deps.state.update(`${CHAT_JOB_OUTCOMES_KEY_PREFIX}${agentId}`, undefined);
  }

  private jobOutcomeViewKey(agentId: string, outcomeId: string): string {
    return `${agentId}\0${outcomeId}`;
  }

  private jobOutcomeViewFor(agentId: string, entry: JobOutcomeAnchorEntry): { view: JobOutcomeViewV1; renderKey: string } | undefined {
    if (!this.deps.jobOutcomeView) return undefined;
    const id = anchorEntryId(entry);
    const key = this.jobOutcomeViewKey(agentId, id);
    const cached = this.jobOutcomeViews.get(key);
    if (cached) return cached;
    const runId = entry.state === 'anchored' ? entry.anchor.runId : entry.runId;
    // A card is an addition to the transcript. If its view cannot be produced, the card is left out and the
    // conversation renders as it would without it; a failure here must never take the chat down with it.
    let view: JobOutcomeViewV1 | undefined;
    try {
      view = this.deps.jobOutcomeView(runId, entry.state);
    } catch {
      view = undefined;
    }
    if (!view) return undefined;
    const digest = createHash('sha256').update(JSON.stringify(view), 'utf8').digest('hex').slice(0, 16);
    const built = { view, renderKey: `${id}:${digest}` };
    this.jobOutcomeViews.set(key, built);
    return built;
  }

  /**
   * The cards of one conversation, each placed after the reply that ended its run's closing turn. That reply is
   * found by its exact turn id. When it is not in this transcript (the run was closed by the host with no
   * coordinator turn, the chat was cleared, or the reply left the retained window) the card is not shown: it
   * is never put at the end, at a nearby time or after a similar message.
   */
  private jobOutcomeItems(agentId: string): ChatJobOutcomeItem[] {
    const entries = this.loadJobOutcomeAnchors(agentId);
    if (entries.length === 0 || !this.deps.jobOutcomeView) return [];
    const history = this.loadHistory(agentId);
    const items: ChatJobOutcomeItem[] = [];
    const cardsAfter = new Map<number, number>();
    for (const entry of entries) {
      const afterTurnId = entry.state === 'anchored' ? entry.anchor.afterTurnId : entry.afterTurnId;
      if (!afterTurnId) continue;
      const replies = history.filter((message) => message.role === 'agent' && !message.runtimeNotice && message.turnId === afterTurnId);
      const closing = replies.filter((message) => message.turnFinal === true).at(-1) ?? replies.at(-1);
      if (!closing) continue;
      const built = this.jobOutcomeViewFor(agentId, entry);
      if (!built) continue;
      const base = this.sequenceOf(agentId, closing);
      const earlier = cardsAfter.get(base) ?? 0;
      cardsAfter.set(base, earlier + 1);
      items.push({
        kind: 'jobOutcome',
        id: anchorEntryId(entry),
        ts: closing.ts,
        seq: base + JOB_OUTCOME_SEQ_OFFSET + earlier * 0.001,
        view: built.view,
        renderKey: built.renderKey,
      });
    }
    return items;
  }

  /**
   * v0.9.93: start a new request of the person to this agent, shown in its conversation like one typed in the
   * composer. Used when the person chooses to continue unfinished work: a new turn with its own text, never a
   * resumed attempt. Returns false, and starts nothing, when the agent is not on the team or is in a turn: a
   * request is never injected into running work.
   */
  submitUserRequest(agentId: string, text: string): boolean {
    this.syncAgents();
    const request = text.trim();
    if (!request || !this.agentIds.has(agentId) || this.runningAgentIds.has(agentId)) return false;
    if (agentId !== this.selectedAgentId) {
      this.selectedAgentId = agentId;
      this.loadHistory(agentId);
      this.deps.onSelectAgent?.(agentId);
    }
    const turnEpoch = this.bumpTurnEpoch(agentId);
    const mode = normalizeChatMode(this.modes.get(agentId));
    this.modes.set(agentId, mode);
    this.append(agentId, { role: 'user', text: request, ts: new Date().toISOString(), turnEpoch });
    if (this.markRunning(agentId)) {
      this.queueTurnStarted(agentId);
    }
    this.deps.send(agentId, request, mode, [], turnEpoch);
    this.postState();
    return true;
  }

  /** A card's action, named by the webview and decided here: only a card this chat shows, and only what it offers. */
  private runJobOutcomeAction(outcomeId: string, action: JobOutcomeCardAction): void {
    const coordinatorId = this.selectedAgentId;
    if (!coordinatorId) return;
    const entry = this.loadJobOutcomeAnchors(coordinatorId).find((candidate) => anchorEntryId(candidate) === outcomeId);
    if (!entry) return;
    const built = this.jobOutcomeViewFor(coordinatorId, entry);
    if (!built || !built.view.actions.some((offered) => offered.id === action)) return;
    this.deps.onJobOutcomeAction?.({
      coordinatorId,
      runId: entry.state === 'anchored' ? entry.anchor.runId : entry.runId,
      action,
    });
  }

  private delegationItems(agentId: string): ChatDelegationItem[] {
    return this.delegations
      .filter((summary) =>
        summary.coordinatorId === agentId ||
        summary.items.some((item) => item.agentId === agentId)
      )
      .map((summary) => ({
        ...summary,
        kind: 'delegation',
        ts: summary.startedAt,
        seq: this.delegationSeq(agentId, summary),
        renderKey: delegationRenderKey(summary),
        items: summary.items.map((item) => ({ ...item })),
      }));
  }

  private ensureTranscriptSeq(agentId: string, item: ChatTranscriptItem): void {
    if (isFiniteSeq(item.seq)) {
      return;
    }
    if (item.kind === 'delegation') {
      item.seq = this.delegationSeq(agentId, item);
      return;
    }
    this.ensureSeq(agentId, item);
  }

  private renderedBlocksForMessage(agentId: string, message: ChatHistoryMessage): MarkdownBlock[] {
    const seq = this.sequenceOf(agentId, message);
    const span = message.verbatim;
    const key = span
      ? `${this.renderedMarkdownKey(agentId, seq, message.text)}:verbatim:${span.start}:${span.length}:${span.partial ? 'p' : ''}${span.clipped ? 'c' : ''}`
      : this.renderedMarkdownKey(agentId, seq, message.text);
    const cached = this.renderedMarkdownBlocks.get(key);
    if (cached) {
      return cached;
    }
    const blocks = span ? verbatimReplyBlocks(message.text, span) : renderMarkdown(message.text);
    this.renderedMarkdownBlocks.set(key, blocks);
    return blocks;
  }

  private renderedBlocksForReasoning(agentId: string, item: ChatReasoning): MarkdownBlock[] {
    const seq = this.sequenceOf(agentId, item);
    const key = this.renderedMarkdownKey(agentId, seq, item.text);
    const cached = this.renderedMarkdownBlocks.get(key);
    if (cached) {
      return cached;
    }
    const blocks = renderMarkdown(item.text);
    this.renderedMarkdownBlocks.set(key, blocks);
    return blocks;
  }

  private toolViewActivity(agentId: string, card: ChatToolActivity): ChatToolViewActivity {
    // The webview shows a label projected from the typed outcome; the outcome itself stays with the host.
    const { outcome: _hostOnly, ...rest } = card;
    const tool: ChatToolViewActivity = { ...rest, ok: toolCardOk(card), failureKind: toolCardFailureKind(card) };
    const filePath = readFilePathFromActivity(tool);
    if (!filePath || tool.phase !== 'result' || tool.ok === false) {
      return tool;
    }
    const truncated = splitTruncatedDetail(tool.detail);
    const markdown = /\.(?:md|markdown)$/i.test(filePath);
    return {
      ...tool,
      canOpenFile: true,
      detailTruncatedChars: truncated.truncatedChars,
      detailBlocks: markdown && truncated.preview
        ? this.renderedBlocksForTool(agentId, tool, truncated.preview)
        : undefined,
    };
  }

  private renderedBlocksForTool(agentId: string, tool: ChatToolActivity, preview: string): MarkdownBlock[] {
    const seq = this.sequenceOf(agentId, tool);
    const key = this.renderedMarkdownKey(agentId, seq, preview);
    const cached = this.renderedMarkdownBlocks.get(key);
    if (cached) {
      return cached;
    }
    const blocks = renderMarkdown(preview);
    this.renderedMarkdownBlocks.set(key, blocks);
    return blocks;
  }

  private renderedMarkdownKey(agentId: string, seq: number, text: string): string {
    return `${agentId}:${seq}:${text.length}`;
  }

  private clearRenderedMarkdownCache(agentId: string): void {
    for (const key of Array.from(this.renderedMarkdownBlocks.keys())) {
      if (key.startsWith(`${agentId}:`)) {
        this.renderedMarkdownBlocks.delete(key);
      }
    }
  }

  /** Append the current turn's live reasoning (Analysis) and live reply, in stream order. */
  private withLiveItems(agentId: string, messages: ChatTranscriptItem[]): ChatTranscriptItem[] {
    const out = [...messages];
    const liveR = this.liveReasoning.get(agentId);
    if (liveR && liveR.text) {
      out.push({ kind: 'reasoning', id: liveR.id, ts: liveR.ts, seq: liveR.seq, text: liveR.text, blocks: renderMarkdown(liveR.text), live: true });
    }
    const live = this.liveMessages.get(agentId);
    if (live) {
      out.push({ ...live, kind: 'message', blocks: renderMarkdown(live.text), live: true });
    }
    return out;
  }

  private agentName(agentId: string): string {
    return this.deps.listAgents().find((a) => a.id === agentId)?.name ?? 'Agent';
  }

  private currentMode(agentId: string): ChatMode {
    if (!agentId) {
      return 'act';
    }
    const mode = this.modes.get(agentId);
    return mode === 'plan' ? 'plan' : 'act';
  }

  /** One responsive renderer for both the narrow sidebar and wide editor Workbench. */
  private getHtml(webview: vscode.Webview, container: 'sidebar' | 'workbench' = 'sidebar'): string {
    const scriptNonce = nonce();
    const initialState = this.currentState();
    const initialJson = jsonForScript(initialState);
    const initialApprovalFocusId = jsonForScript(this.approvalToReveal || '');
    this.approvalToReveal = undefined;
    const options = initialState.agents.length === 0
      ? '<option value="">No agents yet</option>'
      : initialState.agents.map((a) =>
          `<option value="${escAttr(a.id)}"${a.id === initialState.selectedAgentId ? ' selected' : ''}>${esc(a.name)} (${esc(a.role)})</option>`
        ).join('');
    // One context reading per view (Owner, 2026-10-02). The Workbench gives it the end of the session bar, beside
    // the menu. The sidebar is narrow and has no session bar: there it stays in the row of controls beside Compact,
    // which is already two lines high, because a row of its own above the message box cost the transcript height.
    const contextMeter = '<span class="ctx-meter is-gone" id="ctxMeter"></span>';

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp(webview, scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UnodeAi ${container === 'workbench' ? 'Workbench' : 'New Task'}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 8px;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background: var(--vscode-sideBar-background);
    }
    /* Present to assistive tech but never a visual row in either chat container. */
    .live-announcer {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    /* Workbench only changes the container geometry. The transcript, approvals, and composer below are
       deliberately the same renderer as the sidebar, so the two surfaces cannot grow separate behaviour. */
    body.container-workbench {
      gap: 12px;
      padding: 16px clamp(16px, 4vw, 48px);
      background: var(--vscode-editor-background);
      font-size: var(--vscode-editor-font-size, var(--vscode-font-size, 13px));
    }
    body.container-workbench > * { width: min(100%, 1040px); align-self: center; }
    body.container-workbench #transcript { flex: 1 1 auto; }
    body.container-workbench .topbar { min-height: 34px; }
    /* Centred on the row. The cell on the right is as tall as its 24px menu button and centres its text; without this
       the facts on the left sat at the top of their cell, a few pixels above the meter beside them. */
    body.container-workbench .session-summary { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px 12px; padding: 8px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, transparent); }
    body.container-workbench .session-facts { min-width: 0; color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* The sidebar reaches these actions from its native title bar. The Workbench has one labelled menu
       in the same slot instead of repeating six unrelated glyphs beside the session facts. */
    .session-actions-row { position: relative; display: inline-flex; align-items: center; }
    /* Decoration, not information: the item is aria-hidden and the label beside it says what it does. A
       fixed column keeps the labels aligned when a platform renders one of these wider than the rest. */
    .session-menu .menu-glyph {
      display: inline-block;
      width: 1.35em;
      margin-right: 6px;
      text-align: center;
      opacity: 0.85;
    }
    .session-actions-row .icon-btn {
      width: 24px; height: 24px; padding: 0; font-size: 12px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid transparent; border-radius: 4px; background: transparent;
      color: var(--vscode-foreground); cursor: pointer;
    }
    .session-actions-row .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); border-color: var(--vscode-panel-border); }
    .session-actions-row .icon-btn:focus-visible,
    .session-menu button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .session-menu {
      position: absolute; top: calc(100% + 4px); right: 0; z-index: 1;
      min-width: 190px; padding: 4px;
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 5px;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
      box-shadow: 0 4px 12px color-mix(in srgb, var(--vscode-editor-background) 70%, transparent);
    }
    .session-menu[hidden] { display: none; }
    .session-menu button {
      display: block; width: 100%; padding: 5px 8px;
      border: 0; border-radius: 3px; color: inherit; background: transparent;
      font: inherit; font-size: 12px; text-align: left; cursor: pointer;
    }
    .session-menu button:hover,
    .session-menu button:focus { color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground)); background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground)); }
    .session-summary { display: none; }
    /* The composer floats: it leaves the flex column entirely and the transcript scrolls UNDER it.
       position:sticky used to be here and did nothing — sticky resolves against the nearest
       SCROLLING ancestor, and the scroller in this layout is #transcript, whose sibling the composer is.
       So it was merely the last row of a column, and anything that grew above it (an approval card, a
       long plan) pushed it toward the edge. The transcript now owns the full height and slides beneath
       the transparent floating card; reserving a permanently empty band made the panel look shorter.
       In the sidebar the dock is display:contents and already reserves no phantom gutter. */
    .composer-dock, .composer-shell { display: contents; }
    body.container-workbench .composer-dock {
      display: block; position: fixed; left: 0; right: 0; bottom: 0; width: auto;
      /* Asymmetric, and the left inset is doing real work (Owner, 2026-08-02). Text is legible THROUGH
         the card only in the abstract — you can tell something is behind it, not read it. But seeing the
         first few characters of each line beside the card is enough to keep your place, so the left edge
         is held back far enough to expose the start of every line while the right edge, which only ever
         holds buttons, stays tight. */
      padding: 10px clamp(16px, 4vw, 48px) 12px clamp(56px, 7vw, 96px);
      /* No backdrop. A fade here read as a thick black band above the input and hid the very lines you
         are about to reply to; the transcript must stay legible right up to the card's own edge. The
         dock still catches no clicks — only the card does. */
      pointer-events: none;
      background: transparent;
    }
    body.container-workbench.rail-open .composer-dock { right: 300px; }
    body.container-workbench .composer-shell {
      display: flex; flex-direction: column; gap: 6px;
      width: min(100%, 1040px); margin: 0 auto; padding: 8px 10px 6px;
      pointer-events: auto;
      border: 1px solid var(--vscode-panel-border); border-radius: 10px;
      /* Keep the dock's edge and the gaps between controls nearly clear. The input itself keeps its
         stronger surface below, while the blur and border preserve a legible floating boundary.
         Lowered 20% -> 10% on 2026-08-02 (Owner: "还是不够透明"). The blur, not the fill, is what keeps
         text legible through this — see the @supports block below for hosts that have no blur. */
      background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-editor-background)) 10%, transparent);
      backdrop-filter: blur(14px);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
    }
    body.container-workbench .composer-shell:focus-within { border-color: var(--vscode-focusBorder); }
    body.container-workbench .composer-shell .approval-bar { margin: 0; padding-top: 2px; border-top: 1px solid var(--vscode-panel-border); }
    /* The transcript has no permanent composer reservation. An approval is the last in-flow block,
       though, so a revealed decision needs actual scrollable room below it to remain actionable —
       including in a narrow split or at 200% zoom. The dock is measured in the script below; this
       reservation exists only while a decision is visible, so ordinary transcript content still
       passes beneath the floating composer. */
    body.container-workbench #approvals:not([hidden]) {
      margin-bottom: calc(var(--composer-dock-h, 0px) + 16px);
    }
    body.container-workbench #approvals:not([hidden]) .appr-card {
      scroll-margin-bottom: calc(var(--composer-dock-h, 0px) + 16px);
    }
    /* UX4 inspector rail. A fixed drawer rather than a grid column: the conversation column is
       centered and every child already claims its own width, so reflowing them into a grid would
       rewrite the whole layout to add an optional surface. The body gains matching padding so the
       transcript is never underneath the rail. Rendered only in the Workbench — the sidebar is the
       narrow container, and a rail there would spend the width twice. */
    .inspector { display: none; }
    body.container-workbench.rail-open { padding-right: 300px; }
    body.container-workbench.rail-open .inspector {
      display: flex; flex-direction: column; gap: 8px;
      position: fixed; top: 0; right: 0; bottom: 0; width: 292px; padding: 10px;
      overflow-y: auto; background: var(--vscode-editor-background);
      border-left: 1px solid var(--vscode-panel-border);
    }
    .inspector-title { display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
      color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .inspector-empty { color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; }
    .inspector-group { margin: 0 0 8px; }
    .inspector-group h3 { margin: 0 0 3px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; }
    .inspector-file { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px;
      border: 1px solid transparent; border-radius: 4px; }
    .inspector-file:hover { border-color: var(--vscode-panel-border); background: var(--vscode-list-hoverBackground); }
    .inspector-file .open { min-width: 0; padding: 5px 6px; border: none; background: transparent; color: var(--vscode-textLink-foreground);
      font: inherit; font-size: 11px; text-align: left; cursor: pointer; }
    .inspector-file .open .name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .inspector-file .open .when { display: block; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .inspector-file .restore { padding: 3px 5px; border: none; border-radius: 4px; background: transparent;
      color: var(--vscode-foreground); font: inherit; font-size: 11px; cursor: pointer; opacity: 0; }
    .inspector-file:hover .restore, .inspector-file:focus-within .restore { opacity: 1; }
    .inspector-file .restore:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
    .inspector-file .restore:disabled { opacity: .55; color: var(--vscode-descriptionForeground); cursor: not-allowed; }
    .inspector-file .unavailable { grid-column: 1 / -1; padding: 0 6px 5px; color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.35; }
    /* A narrow editor gives the conversation its full width back — but the rail SHRINKS rather than
       disappearing. Hiding it here left the title action saying "Hide Changed Files" while no files
       were on screen, and a control that lies about its own state is the UX3-R failure again: a
       shrinking container must shrink, not hide. So the body drops its reserved column and the rail
       becomes an overlay drawer over the conversation, still scrollable, still closable by the same
       action that opened it. */
    @media (max-width: 820px) {
      body.container-workbench.rail-open { padding-right: 8px; }
      body.container-workbench.rail-open .inspector {
        width: min(292px, 86vw); z-index: 20;
        box-shadow: -10px 0 26px rgba(0, 0, 0, 0.32);
        /* The rail is its own overlay; do not reserve a second phantom band for the composer. */
        bottom: 0;
      }
      /* The rail overlays rather than reserving a column here, so the dock takes the width back. */
      body.container-workbench.rail-open .composer-dock { right: 0; }
    }
    /* A tall decision can exhaust the flex column even when the viewport itself is not short. These
       declarations intentionally mirror the short-viewport fallback below; a source test keeps all six
       pairs identical so the two ways of returning the dock to flow cannot drift apart. :where() keeps
       the class from changing the existing cascade against the width breakpoints. */
    body.container-workbench:where(.approval-dock-inline) { padding-bottom: 16px; }
    body.container-workbench:where(.approval-dock-inline) .composer-dock {
      position: static; padding: 0; background: none;
    }
    body.container-workbench:where(.approval-dock-inline) .composer-shell {
      width: 100%; box-shadow: none; backdrop-filter: none;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    }
    body.container-workbench:where(.approval-dock-inline) .composer-shell textarea { background: var(--vscode-input-background); }
    body.container-workbench:where(.approval-dock-inline) #transcript { min-height: 72px; }
    body.container-workbench:where(.approval-dock-inline).rail-open .inspector { bottom: 0; }
    /* A floating composer needs a viewport tall enough to float in. At 200% zoom the CSS viewport is
       roughly half as tall, while the column's hard minimums (#transcript's min-height, the topbar, the
       facts line, the approval bar) do not shrink — so the column overflows the body, and because the dock
       is fixed, the overflowing conversation runs UNDERNEATH it. Reserving more space cannot fix that;
       there is no space to reserve. So when the viewport is short the composer stops floating and returns
       to the end of the flex column, where it cannot cover anything. */
    @media (max-height: 560px) {
      body.container-workbench { padding-bottom: 16px; }
      body.container-workbench .composer-dock {
        position: static; padding: 0; background: none;
      }
      body.container-workbench .composer-shell {
        width: 100%; box-shadow: none; backdrop-filter: none;
        background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      }
      body.container-workbench .composer-shell textarea { background: var(--vscode-input-background); }
      body.container-workbench #transcript { min-height: 72px; }
      body.container-workbench.rail-open .inspector { bottom: 0; }
    }
    @media (max-width: 620px) {
      body.container-workbench { padding: 8px; gap: 8px; }
      body.container-workbench .topbar { flex-wrap: wrap; }
      body.container-workbench .topbar select { min-width: 180px; }
      body.container-workbench .approval-bar { gap: 6px; }
      /* Give the margin back (Owner, 2026-08-02): in a narrow panel the exposed line-starts are worth
         less than the width, so the composer takes the strip instead of preserving it. */
      body.container-workbench .composer-dock { padding-left: 8px; padding-right: 8px; }
    }
    .topbar { display: flex; align-items: center; gap: 6px; min-height: 28px; }
    .topbar label { color: var(--vscode-descriptionForeground); font-size: 11px; }
    select {
      flex: 1 1 auto;
      min-width: 0;
      height: 28px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      padding: 3px 6px;
    }
    /* Option popup must be themed too — the generic input tokens leave it white/grey (unreadable in Cursor). */
    select option { background: var(--vscode-dropdown-background, var(--vscode-input-background)); color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground)); }
    .mode-toggle {
      display: inline-flex;
      flex: 0 0 auto;
      gap: 2px;
      padding: 2px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-input-background);
    }
    .mode-toggle button {
      min-width: 42px;
      height: 22px;
      border: 1px solid transparent;
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      cursor: pointer;
      font: inherit;
      font-size: 11px;
    }
    .mode-toggle button.active.plan {
      color: #fff;
      background: var(--vscode-charts-blue);
      border-color: var(--vscode-charts-blue);
    }
    .mode-toggle button.active.act {
      color: #fff;
      background: var(--vscode-charts-green);
      border-color: var(--vscode-charts-green);
    }
    #transcript {
      flex: 1 1 auto;
      min-height: 120px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 4px 1px;
    }
    body.compact #transcript { gap: 4px; }
    /* Trailing scrollable space so the newest line always clears the floating composer (Owner,
       2026-08-02: the last lines were arriving underneath it).
       This is NOT the reservation B1 removed, and the difference is which element carries it. The old
       rule put padding-bottom on the BODY — which is not the scroller, so it was a fixed dead strip
       nothing could ever scroll into, which is why the card floated over permanent emptiness and read as
       opaque. The transcript IS the scroller (it owns overflow-y), so the same padding becomes
       SCROLLABLE room: scroll up and history still slides through the region behind the
       card, and at rest the newest line sits above it. Both properties at once, from one declaration.
       Sized from the measured dock, because at 200% zoom a fixed number is wrong by a factor of two. */
    body.container-workbench #transcript { padding-bottom: calc(var(--composer-dock-h, 0px) + 8px); }
    .empty {
      margin: auto;
      max-width: 240px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    }
    .empty.pm-hint { max-width: 340px; }
    .repair {
      margin: auto;
      max-width: 360px;
      padding: 16px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-editorWidget-background, var(--vscode-input-background));
      text-align: left;
    }
    .repair h2 { margin: 0 0 6px; font-size: 14px; }
    .repair p { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.45; }
    .repair button { margin-top: 12px; }
    .solo-hint {
      margin-top: 12px;
      padding: 10px 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.08));
      text-align: left;
      font-size: 12px;
      line-height: 1.5;
    }
    .solo-hint-btn {
      display: inline-block;
      margin-top: 8px;
      padding: 3px 10px;
      border: none;
      border-radius: 5px;
      cursor: pointer;
      font-weight: 600;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .solo-hint-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .msg {
      max-width: 94%;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 7px 9px;
      line-height: 1.45;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    body.compact .msg {
      max-width: 100%;
      padding: 4px 7px;
      line-height: 1.28;
    }
    body.compact .msg .body,
    body.compact .msg .md {
      max-height: 2.7em;
      overflow: hidden;
      opacity: .78;
    }
    .msg.user {
      align-self: flex-end;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: var(--vscode-button-background);
    }
    .msg.agent {
      align-self: flex-start;
      background: var(--vscode-editor-background);
      position: relative;
    }
    /* Compact, icon-only copy button at the bubble's bottom-right corner (no header line needed). */
    .copy-msg {
      position: absolute;
      bottom: 4px;
      right: 4px;
      width: 20px;
      height: 20px;
      padding: 0;
      font-size: 12px;
      line-height: 20px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      opacity: 0.65;
      transition: opacity 0.1s, background 0.1s;
    }
    .copy-msg:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
    /* Keep the icon clear of long first lines. */
    .msg.agent .body, .msg.agent .md { padding-right: 22px; }
    .turn-footer {
      margin-top: 8px;
      padding-top: 5px;
      border-top: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 400;
    }
    /*
     * The answer, told apart from the work that produced it.
     *
     * Owner, 2026-08-21: a conclusion has to be findable at a glance. Codex hides the process behind a
     * "working for Nm Ns" disclosure; the same clarity is available by marking the answer instead of hiding
     * the steps, which keeps the evidence on screen — and evidence staying on screen is the entire product.
     *
     * **The border is deliberately not green.** Green means "the framework observed this and it passed"
     * everywhere else in this product, and a conclusion is a claim an agent made. Painting every one of
     * them green would put a verified mark on prose nothing verified, which is the one thing this product
     * exists not to do. The accent below is the neutral form; the --unode-conclusion-accent variable is the
     * single place to change when a per-turn verdict exists to colour it by.
     */
    .msg.agent.conclusion {
      --unode-conclusion-accent: var(--vscode-focusBorder, var(--vscode-textLink-foreground));
      border-left: 3px solid var(--unode-conclusion-accent);
      border-radius: 4px;
      padding-left: 10px;
      /* A tint of the accent rather than a fixed colour, so it holds up in light, dark and high contrast. */
      background: color-mix(in srgb, var(--unode-conclusion-accent) 7%, transparent);
      margin-top: 10px;
    }
    /* Heavier than the running text, not heavy enough to read as shouting: a whole paragraph at 600 is
       harder to read than the thing it was meant to emphasise. */
    .msg.agent.conclusion .body,
    .msg.agent.conclusion p { font-weight: 500; }
    .msg.agent.conclusion strong, .msg.agent.conclusion b { font-weight: 700; }
    @supports not (background: color-mix(in srgb, red 7%, transparent)) {
      .msg.agent.conclusion { background: var(--vscode-textBlockQuote-background, transparent); }
    }

    .msg.error { border-color: #dc3545; }
    /* In the flex column, transcript items must not shrink (otherwise long messages/cards collapse
       and overlap). Keeps each bubble/card/marker at its natural height. */
    .msg, .tool-card, .marker, .reasoning, .delegation-card, .context-manifest, .job-outcome { flex-shrink: 0; }
    /* Claude-style status dot: gray (pulsing) = running, green = done, red = blocked/error. */
    .dot {
      flex: 0 0 auto;
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--vscode-descriptionForeground);
      display: inline-block;
    }
    .dot.running { background: var(--vscode-descriptionForeground); animation: unodePulse 1.1s infinite ease-in-out; }
    .dot.ok { background: var(--vscode-charts-green, #3fb950); }
    .dot.unknown { background: var(--vscode-charts-yellow, #d29922); }
    .dot.err { background: var(--vscode-errorForeground, #f85149); }
    @keyframes unodePulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
    /* Analysis (reasoning) card — the agent's thinking for the current turn. */
    .reasoning {
      align-self: stretch;
      border: 1px solid var(--vscode-panel-border);
      border-left: 3px solid var(--vscode-charts-purple, #a371f7);
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
      overflow: hidden;
    }
    .reasoning > summary {
      cursor: pointer;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 6px 8px;
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
    }
    .reasoning > summary::-webkit-details-marker { display: none; }
    .reasoning .reasoning-body {
      padding: 6px 9px 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.4;
      font-style: italic;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border-top: 1px solid var(--vscode-panel-border);
    }
    body.compact .reasoning .reasoning-body { display: none; }
    .delegation-card {
      align-self: stretch;
      border: 1px solid var(--vscode-panel-border);
      border-left: 3px solid var(--vscode-charts-blue, #58a6ff);
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-editor-background) 86%, transparent);
      overflow: hidden;
    }
    .delegation-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 11px;
    }
    .delegation-title {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
    }
    .delegation-count {
      flex: 0 0 auto;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }
    .delegation-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px 8px 7px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .delegation-row {
      display: grid;
      grid-template-columns: minmax(74px, 0.9fr) auto minmax(0, 1.8fr);
      gap: 6px;
      align-items: center;
      min-width: 0;
    }
    .delegation-agent,
    .delegation-task {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .delegation-scope {
      grid-column: 2 / -1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }
    .delegation-status {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 1px 6px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .delegation-status.working { color: var(--vscode-charts-yellow, #d29922); }
    .delegation-status.done { color: var(--vscode-charts-green, #3fb950); }
    .delegation-status.verified { color: var(--vscode-charts-green, #3fb950); }
    .delegation-status.no-applicable-sensor { color: var(--vscode-descriptionForeground); }
    .delegation-status.verification-failed { color: var(--vscode-errorForeground, #f85149); }
    .delegation-status.tool-activity-recorded { color: var(--vscode-charts-yellow, #d29922); }
    .delegation-status.replied-not-verified { color: var(--vscode-charts-yellow, #d29922); }
    .delegation-status.coordinator-accepted { color: var(--vscode-charts-green, #3fb950); }
    .delegation-status.coordinator-rejected, .delegation-status.human-intervention-required { color: var(--vscode-errorForeground, #f85149); }
    .delegation-status.no-evidence { color: var(--vscode-errorForeground, #f85149); }
    .delegation-status.timed-out { color: var(--vscode-errorForeground, #f85149); }
    .delegation-status.blocked { color: var(--vscode-errorForeground, #f85149); }
    .delegation-status.interrupted { color: var(--vscode-errorForeground, #f85149); }
    .delegation-status.cancelled { color: var(--vscode-descriptionForeground); }
    .delegation-status.completion-partial { color: var(--vscode-charts-yellow, #d29922); }
    body.compact .delegation-list { display: none; }
    body.compact .delegation-head { border-bottom: none; padding: 5px 7px; }
    .context-manifest {
      align-self: stretch;
      border: 1px solid var(--vscode-panel-border);
      border-left: 3px solid var(--vscode-charts-purple, #a371f7);
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
      overflow: hidden;
      font-size: 11px;
    }
    .context-manifest > summary {
      cursor: pointer;
      list-style: none;
      padding: 6px 8px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .context-manifest > summary::-webkit-details-marker { display: none; }
    .context-manifest-body { border-top: 1px solid var(--vscode-panel-border); padding: 7px 8px; color: var(--vscode-descriptionForeground); }
    .context-manifest-note { margin: 0 0 7px; font-size: 10px; line-height: 1.4; }
    .context-manifest-list { display: grid; gap: 6px; }
    .context-entry { border-left: 2px solid var(--vscode-panel-border); padding-left: 7px; display: grid; gap: 2px; overflow-wrap: anywhere; }
    .context-entry-title { color: var(--vscode-foreground); font-weight: 600; }
    .context-entry-meta { font-size: 10px; }
    body.compact .context-manifest-body { display: none; }
    /* Job outcome card (v0.9.93): a host item, not a message. No bubble and no avatar. */
    .job-outcome {
      align-self: stretch;
      border: 1px solid var(--vscode-panel-border);
      border-left: 3px solid var(--vscode-charts-green, #3fb950);
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
      overflow: hidden;
      font-size: 11px;
    }
    .job-outcome.unavailable { border-left-color: var(--vscode-charts-yellow, #d29922); }
    .job-outcome summary {
      cursor: pointer;
      list-style: none;
      padding: 6px 8px;
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 3px 7px;
    }
    .job-outcome summary::-webkit-details-marker { display: none; }
    .job-outcome-label { font-weight: 700; color: var(--vscode-foreground); }
    .job-outcome-badge {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 0 6px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .job-outcome-line { min-width: 0; overflow-wrap: anywhere; color: var(--vscode-descriptionForeground); }
    .job-outcome .tone-positive { color: var(--vscode-charts-green, #3fb950); }
    .job-outcome .tone-caution { color: var(--vscode-charts-yellow, #d29922); }
    .job-outcome .tone-negative { color: var(--vscode-errorForeground, #f85149); }
    .job-outcome-segment.tone-positive, .job-outcome-segment.tone-negative { font-weight: 600; }
    /* The state is in the words; the mark repeats it for a reader who cannot rely on colour. */
    .job-outcome-segment.tone-positive::before { content: '✓ '; }
    .job-outcome-segment.tone-caution::before { content: '! '; }
    .job-outcome-segment.tone-negative::before { content: '✕ '; }
    .job-outcome-body {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 8px;
      display: grid;
      gap: 10px 14px;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    }
    .job-outcome-section { min-width: 0; display: grid; gap: 3px; align-content: start; }
    .job-outcome-section-title { font-weight: 700; color: var(--vscode-foreground); }
    .job-outcome-rows { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1px 8px; }
    .job-outcome-rows dt { color: var(--vscode-descriptionForeground); }
    .job-outcome-rows dd { margin: 0; overflow-wrap: anywhere; color: var(--vscode-foreground); }
    .job-outcome-items {
      margin: 2px 0 0;
      padding-left: 15px;
      max-height: 170px;
      overflow: auto;
      overflow-wrap: anywhere;
      color: var(--vscode-foreground);
    }
    .job-outcome-note { color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.4; }
    .job-outcome-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 3px; }
    .job-outcome-actions button { font: inherit; font-size: 11px; }
    .solo-suggestion {
      align-self: stretch;
      border: 1px solid var(--vscode-charts-blue, #58a6ff);
      border-radius: 6px;
      padding: 8px;
      background: color-mix(in srgb, var(--vscode-charts-blue, #58a6ff) 9%, var(--vscode-editor-background));
      font-size: 11px;
    }
    .solo-suggestion-title { font-weight: 600; margin-bottom: 3px; }
    .solo-suggestion-copy { color: var(--vscode-descriptionForeground); line-height: 1.4; }
    .solo-suggestion button { margin-top: 7px; font: inherit; font-size: 11px; }
    .tool-card {
      align-self: stretch;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-editor-background) 84%, transparent);
      overflow: hidden;
    }
    .tool-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 8px;
      cursor: pointer;
    }
    .tool-head-right {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tool-title {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
    }
    /* Codicon classes render with VS Code's product-icon font when available. The text fallback is
       deliberate for webview hosts that do not expose that font: both paths inherit theme colors. */
    .tool-icon {
      flex: 0 0 auto;
      width: 14px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1;
      text-align: center;
    }
    .tool-icon::before { content: attr(data-fallback); }
    .tool-title-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tool-state {
      flex: 0 0 auto;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .tool-body {
      padding: 6px 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .tool-timing {
      margin-top: 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }
    /* A tool card shows its title row only; input/output/diff sit behind the ▶ toggle. A turn with twenty
       tool calls then stays scannable instead of burying the reply. Cards that failed open themselves —
       see renderTool() — because a blocked call is the one thing you never want to have to hunt for. */
    .tool-body { display: none; }
    .tool-card.expanded .tool-body { display: block; }
    .tool-group-body { display: none; flex-direction: column; gap: 6px; }
    .tool-card.expanded .tool-group-body { display: flex; }
    .tool-group-body > .tool-card { align-self: stretch; }
    .tool-card.expanded .tool-head { border-bottom: 1px solid var(--vscode-panel-border); }
    .tool-expand {
      background: none;
      border: none;
      padding: 0 2px;
      cursor: pointer;
      color: var(--vscode-descriptionForeground);
      font-size: 9px;
      line-height: 1;
      transition: transform 120ms ease;
    }
    .tool-expand:hover { color: var(--vscode-foreground); }
    .tool-expand:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; border-radius: 2px; }
    .tool-card.expanded .tool-expand { transform: rotate(90deg); }
    @media (prefers-reduced-motion: reduce) { .tool-expand { transition: none; } }
    body.compact .tool-head { padding: 4px 7px; }
    .tool-card.blocked { border-color: var(--vscode-errorForeground); }
    .tool-card.edit { border-left: 3px solid var(--vscode-charts-green); }
    .tool-card.run { border-left: 3px solid var(--vscode-charts-yellow); }
    .tool-card.read { border-left: 3px solid var(--vscode-charts-blue); }
    .tool-card.mcp, .tool-card.tool { border-left: 3px solid var(--vscode-charts-purple); }
    details.tool-detail {
      margin-top: 6px;
      color: var(--vscode-foreground);
    }
    details.tool-detail summary {
      cursor: pointer;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }
    details.tool-detail pre {
      margin-top: 4px;
      padding: 6px 8px;
      background: var(--vscode-textCodeBlock-background, color-mix(in srgb, var(--vscode-editor-background) 60%, transparent));
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      line-height: 1.4;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 320px;
      overflow: auto;
    }
    details.tool-detail > .md {
      margin-top: 4px;
      padding: 6px 8px;
      max-height: 320px;
      overflow: auto;
      border-radius: 4px;
      background: var(--vscode-textCodeBlock-background, color-mix(in srgb, var(--vscode-editor-background) 60%, transparent));
    }
    .tool-receipt-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 7px; }
    .tool-truncation { color: var(--vscode-notificationsWarningIcon-foreground, var(--vscode-descriptionForeground)); }
    .tool-open-file { font: inherit; font-size: 11px; }
    /* Diff coloring (Cline-style); the Diff/Output details open expanded so changes are visible at a glance. */
    .diff-line { display: block; }
    .diff-add { background: color-mix(in srgb, var(--vscode-charts-green) 16%, transparent); color: var(--vscode-charts-green); }
    .diff-del { background: color-mix(in srgb, var(--vscode-charts-red) 16%, transparent); color: var(--vscode-charts-red); }
    .diff-meta { color: var(--vscode-descriptionForeground); }
    .marker {
      align-self: center;
      max-width: 92%;
      padding: 3px 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      background: var(--vscode-sideBar-background);
    }
    /* Text that wraps as a sentence. As a row of flex items each part wrapped inside its own narrow box, and a
       ~280px sidebar showed the approval wait as three columns (field run, 2026-10-02). */
    .thinking {
      align-self: flex-start;
      padding: 6px 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .thinking .dots { display: inline-flex; gap: 3px; margin-left: 6px; vertical-align: middle; }
    .thinking .dots span {
      width: 5px; height: 5px; border-radius: 50%;
      background: var(--vscode-descriptionForeground);
      animation: unodeBlink 1.2s infinite ease-in-out both;
    }
    .thinking .dots span:nth-child(2) { animation-delay: 0.2s; }
    .thinking .dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes unodeBlink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
    /* The elapsed time is useful information and keeps updating; the pulse is only decoration. */
    @media (prefers-reduced-motion: reduce) {
      .thinking .dots span, .dot.running { animation: none; }
    }
    .body { white-space: pre-wrap; }
    .md { display: flex; flex-direction: column; gap: 6px; }
    .md p, .md h1, .md h2, .md h3, .md ul { margin: 0; }
    .md h1 { font-size: 17px; }
    .md h2 { font-size: 15px; }
    .md h3 { font-size: 13px; }
    .md ul { padding-left: 18px; }
    .md table { border-collapse: collapse; width: 100%; margin: 2px 0; font-size: 12px; display: block; overflow-x: auto; }
    .md th, .md td { border: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); padding: 4px 8px; text-align: left; vertical-align: top; }
    .md th { background: var(--vscode-editorWidget-background, rgba(127,127,127,0.1)); font-weight: 600; }
    .md tr:nth-child(even) td { background: rgba(127, 127, 127, 0.05); }
    .md code.inline {
      padding: 1px 4px;
      border-radius: 4px;
      background: var(--vscode-textCodeBlock-background);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }
    .md a { color: var(--vscode-textLink-foreground); }
    .code {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--vscode-textCodeBlock-background);
    }
    .code-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 26px;
      padding: 3px 6px;
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }
    .code button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      padding: 2px 7px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      cursor: pointer;
      font-size: 10px;
    }
    pre {
      margin: 0;
      padding: 8px;
      overflow-x: auto;
      white-space: pre;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }
    .attach-status {
      margin-top: 4px;
      color: var(--vscode-errorForeground);
      font-size: 11px;
      line-height: 1.35;
    }
    .send-status {
      margin-top: 4px;
      color: var(--vscode-errorForeground);
      font-size: 11px;
      line-height: 1.35;
    }
    .attachment-chips {
      margin-top: 6px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      max-height: 88px;
      overflow-y: auto;
    }
    .attachment-chip {
      min-width: 0;
      max-width: 220px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-size: 11px;
    }
    .attachment-chip img {
      width: 28px;
      height: 28px;
      border-radius: 4px;
      object-fit: cover;
      flex: 0 0 auto;
    }
    .attachment-chip .file-mark {
      width: 28px;
      height: 28px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--vscode-editor-background);
      color: var(--vscode-descriptionForeground);
      flex: 0 0 auto;
      font-size: 12px;
      font-weight: 700;
    }
    .attachment-chip .attach-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .attachment-chip .attach-size {
      color: var(--vscode-descriptionForeground);
      flex: 0 0 auto;
    }
    .attachment-chip button {
      width: 18px;
      height: 18px;
      padding: 0;
      border: none;
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      cursor: pointer;
      flex: 0 0 auto;
    }
    .message-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }
    .message-attachments .attachment-chip {
      background: color-mix(in srgb, var(--vscode-button-background) 80%, var(--vscode-editor-background));
    }
    .msg.agent .message-attachments .attachment-chip {
      background: var(--vscode-input-background);
    }
    /* The editor gets its own full-width row. Insert, Send/Steer, and Stop live below it, so a long
       task does not compete with its controls; this applies to both the sidebar and Workbench. */
    .composer { display: grid; gap: 6px; }
    /* Insert / Send / Stop now sit in the auto-approve row rather than owning one of their own (Owner,
       2026-08-02) — one control row instead of three, which is what fixed the ~300px sidebar pushing
       Stop off the edge behind a horizontal scrollbar. An auto left-margin holds them right while the
       approval controls stay left. */
    .composer-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
    .composer.drag textarea { border-color: var(--vscode-focusBorder); }
    /* The working/steering sentence is no longer PAINTED (Owner, 2026-08-02: it cost width the controls
       needed). It stays in the DOM, clipped to a single pixel, because it is the only place that says a
       message will STEER a running agent rather than queue behind it — a distinction the icons cannot
       make and one a screen-reader user would otherwise lose entirely. Removing the element instead of
       hiding it would trade a layout complaint for an accessibility regression. Sighted users get the
       same fact from the send button, whose icon and tooltip both change while an agent runs. */
    /* The reading and the action are two controls, not one. A single borderless pill carrying both was
       reported as invisible (Owner, 2026-08-11): it read as a caption, so the only way to act on a full
       context was a click nobody could see was available. The meter is text and Compact is a button styled
       like the ones beside it. In the sidebar the text sits in the row of controls, beside the button; in the
       Workbench it sits at the end of the session bar. */
    .composer-actions .ctx-meter {
      font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap;
    }
    .session-actions-row > .ctx-meter {
      max-width: 40vw; margin-right: 6px; font-size: 11px; color: var(--vscode-descriptionForeground);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ctx-meter.warn { color: var(--vscode-editorWarning-foreground, #cca700); }
    /* Icon, not a word (Owner, 2026-08-12). Same 30px square as the attach button next to it, so the
       composer row reads as one set of controls rather than a label wedged between two icons. The meaning
       lives in the meter text and in the accessible name, which stays a full sentence. */
    .composer-actions .ctx-compact {
      width: 30px; height: 30px; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 6px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      cursor: pointer; font-size: 15px; line-height: 1;
    }
    .composer-actions .ctx-compact:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    .composer-actions .ctx-compact:disabled { cursor: default; opacity: 0.6; }
    /* The hidden ATTRIBUTE cannot hide these: the display rules above are author rules and outrank the user
       agent's [hidden] { display: none }. v0.9.50 set .hidden and shipped a permanently visible empty pill
       that read as a broken feature. Hiding is a class, at the same origin as the rule that defeats it. */
    .ctx-meter.is-gone, .composer-actions .ctx-compact.is-gone { display: none; }
    .steer-hint {
      position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
    textarea {
      width: 100%;
      min-width: 0;
      /* Height is driven by JS (autoGrow): grows with content up to max-height, then scrolls.
         Keep min/max here in sync with COMPOSER_MAX_H in the script. */
      min-height: 46px;
      max-height: 200px;
      height: 46px;
      resize: none;
      overflow-y: hidden;
      box-sizing: border-box;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 6px;
      padding: 7px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font: inherit;
      line-height: 1.35;
    }
    /* Only the Workbench composer is a floating dock. Keep the sidebar textarea solid, and restore
       opacity in the short-viewport fallback above where the composer returns to normal flow.
       Lowered 72% -> 48% on 2026-08-02 (Owner: the card still read as opaque against the conversation). */
    body.container-workbench textarea {
      background: color-mix(in srgb, var(--vscode-input-background) 48%, transparent);
    }
    /* Cursor does not render backdrop-filter (trip Part 7). Without the blur, translucency is not a
       frosted surface — it is the transcript showing THROUGH the text you are typing, at full contrast,
       and the lower the fill the worse it reads. So the transparency the Owner asked for is spent only
       where a blur exists to pay for it; hosts without one keep a fill that stays legible. This is a
       capability query, not a Cursor check: any host that gains blur later gets the lighter surface
       automatically, and any host that lacks it stays readable without being named here. */
    @supports not (backdrop-filter: blur(2px)) {
      body.container-workbench .composer-shell {
        background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-editor-background)) 42%, transparent);
      }
      body.container-workbench textarea {
        background: color-mix(in srgb, var(--vscode-input-background) 82%, transparent);
      }
    }
    /* Square and wordless (Owner, 2026-08-02). The label moved into title + aria-label, so the word is a
       hover away for a mouse and always present for a screen reader — it is only the PIXELS that are
       gone. 58px of "Send" bought nothing that an arrow does not say. */
    button.send {
      width: 30px;
      height: 30px;
      border: none;
      border-radius: 6px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
      font-size: 15px;
      line-height: 1;
      font-weight: 600;
    }
    button.send:hover { background: var(--vscode-button-hoverBackground); }
    button.attach {
      width: 30px;
      height: 30px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 6px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      cursor: pointer;
      font-size: 17px;
      line-height: 1;
    }
    button.attach:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.stop {
      width: 30px;
      height: 30px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 6px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      cursor: pointer;
      font-weight: 600;
    }
    button.stop:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled, textarea:disabled, select:disabled { opacity: .55; cursor: default; }
    /* C3: pinned live checklist (the agent's plan for the current task). */
    .plan {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      margin-bottom: 6px;
      background: var(--vscode-sideBar-background);
    }
    .plan[hidden] { display: none; }
    .plan > summary {
      cursor: pointer;
      list-style: none;
      padding: 5px 9px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .plan > summary::-webkit-details-marker { display: none; }
    .plan .plan-count { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .8; text-align: right; }
    .plan.done > summary { color: var(--vscode-charts-green); }
    .plan ul { margin: 0; padding: 2px 9px 7px 9px; list-style: none; display: flex; flex-direction: column; gap: 3px; }
    .plan li { display: flex; align-items: baseline; gap: 7px; font-size: 12px; line-height: 1.3; }
    .plan li .tick { flex: 0 0 auto; width: 13px; text-align: center; }
    .plan li.done .label { text-decoration: line-through; opacity: .6; }
    .plan li.active .label { color: var(--vscode-foreground); font-weight: 600; }
    .plan li.active .tick { color: var(--vscode-charts-yellow); }
    .plan li.done .tick { color: var(--vscode-charts-green); }
    .plan li.pending { color: var(--vscode-descriptionForeground); }
    body.compact .plan ul { display: none; }

    /* In-panel approval cards (replace native modals) */
    .approvals { display: flex; flex-direction: column; gap: 6px; margin: 0 0 6px; }
    .appr-card { border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-charts-yellow));
      border-radius: 6px; background: var(--vscode-editorWidget-background); padding: 8px; font-size: 12px; }
    .appr-card .appr-title { font-weight: 600; margin-bottom: 5px; display: flex; align-items: center; gap: 6px; }
    .appr-card .appr-title .ico { color: var(--vscode-charts-yellow); }
    .appr-card pre { margin: 0 0 6px; max-height: 180px; overflow: auto; background: var(--vscode-textCodeBlock-background);
      padding: 6px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
    .appr-card .appr-cmd { font-family: var(--vscode-editor-font-family, monospace); }
    .appr-card .appr-warn { font-size: 11px; line-height: 1.35; margin: 2px 0 6px; padding: 5px 7px; border-radius: 4px;
      color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
      background: var(--vscode-inputValidation-warningBackground, transparent);
      border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-errorForeground)); overflow-wrap: anywhere; }
    .appr-card .appr-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .appr-card .appr-actions button { font-size: 11px; padding: 3px 9px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
    .appr-card .appr-actions button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .appr-card .appr-actions button.danger { background: transparent; color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
    .appr-card .appr-note { width: 100%; margin-top: 6px; box-sizing: border-box; font-size: 11px;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 4px 6px; }
    .appr-card.consent-required { border-color: var(--vscode-charts-yellow, #d29922); }
    .appr-card.timed-out { border-color: var(--vscode-descriptionForeground); color: var(--vscode-descriptionForeground); }

    /* Footer auto-approve selector (à la Cline/Codex) */
    .approval-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 4px 2px 6px;
      font-size: 11px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }
    .approval-bar .appr-bar-label { display: inline-flex; align-items: center; justify-content: center; width: 18px; font-weight: 600; }
    .approval-bar label { display: flex; align-items: center; gap: 4px; }
    /* An author display rule beats the UA rule for [hidden], so hiding a control needs this. */
    .approval-bar label[hidden] { display: none; }
    /* Narrow: drop the words, keep the dropdowns (Owner, 2026-08-02). The CURRENT VALUE stays visible
       either way — "Ask each" / "Auto (checkpointed)" is the one thing an approval control must never
       hide, so the words go and the selects do not. Each select carries an explicit aria-label, so the
       accessible name is identical at both widths rather than evaporating with the visible text.
       The row may still wrap to two lines here and that is accepted; this only makes it much less
       likely. No container prefix on purpose — a webview has its own viewport, so the ~300px sidebar
       matches this rule directly.
       450px, not the 620px used elsewhere in this file (Owner, 2026-08-02, from measuring the real
       panel): the words fit again well before the other narrow-layout rules need to fire, and reusing
       620px out of tidiness would have dropped them across a whole band where they were still legible. */
    @media (max-width: 450px) {
      .approval-bar .appr-word { display: none; }
    }
    .approval-bar select { font-size: 11px; padding: 1px 4px; background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 4px; }
    .codex-danger { color: var(--vscode-errorForeground); font-weight: 600; }
  </style>
</head>
<body class="container-${container}">
  <div id="announcement-polite" class="live-announcer" aria-live="polite" aria-atomic="true"></div>
  <div id="announcement-assertive" class="live-announcer" aria-live="assertive" aria-atomic="true"></div>
  <div class="topbar">
    <label for="agent">Agent</label>
    <select id="agent">${options}</select>
    <div class="mode-toggle" role="group" aria-label="Chat mode">
      <button id="planMode" type="button" class="plan">Plan</button>
      <button id="actMode" type="button" class="act">Act</button>
    </div>
  </div>
  <div class="session-summary" id="sessionSummary" hidden>
    <span class="session-facts" id="sessionFacts"></span>
    <span class="codex-danger" id="codexSessionWarning" hidden>Full access: no sandbox or approval prompts</span>
    <span class="session-actions-row">
      ${container === 'workbench' ? contextMeter : ''}
      <button id="sessionMenuTrigger" type="button" class="icon-btn" aria-label="Session actions" aria-haspopup="menu" aria-expanded="false" aria-controls="sessionMenu">…</button>
      <span id="sessionMenu" class="session-menu" role="menu" aria-label="Session actions" hidden>
        <button type="button" role="menuitem" tabindex="-1" data-chat-command="unode.archiveChat"><span class="menu-glyph" aria-hidden="true">🗄️</span>Archive Chat</button>
        <button type="button" role="menuitem" tabindex="-1" data-chat-command="unode.clearChat"><span class="menu-glyph" aria-hidden="true">🧹</span>Clear Chat</button>
        <button type="button" role="menuitem" tabindex="-1" data-chat-command="unode.toggleChatCompact"><span class="menu-glyph" aria-hidden="true">⇕</span>Compress Chat View</button>
        <button type="button" role="menuitem" tabindex="-1" data-chat-command="unode.exportChat"><span class="menu-glyph" aria-hidden="true">💾</span>Export Chat</button>
        <button type="button" role="menuitem" tabindex="-1" data-chat-command="unode.importChat"><span class="menu-glyph" aria-hidden="true">📂</span>Import Chat</button>
        <button type="button" role="menuitem" tabindex="-1" data-chat-command="unode.viewArchivedChats"><span class="menu-glyph" aria-hidden="true">🕘</span>View Archived Chats</button>
      </span>
    </span>
  </div>
  <details class="plan" id="plan" open hidden>
    <summary><span>Plan</span><span class="plan-count" id="planCount"></span></summary>
    <ul id="planList"></ul>
  </details>
  <div id="transcript"></div>
  <div id="approvals" class="approvals" hidden></div>
  <div class="composer-dock" id="composerDock">
   <div class="composer-shell">
  <div class="attach-status" id="attachmentStatus" hidden></div>
  <div class="send-status" id="sendStatus" role="status" aria-live="polite" hidden></div>
  <div class="attachment-chips" id="attachmentChips" hidden></div>
  <div class="composer" id="composer">
    <textarea id="input" placeholder="Message the selected agent"></textarea>
  </div>
  <div class="approval-bar">
    <span class="appr-bar-label" title="What agents may do without asking. Eligible prompts also appear here in the panel." aria-label="Agent permissions">⚙</span>
    <label id="commandApprovalControl"><span class="appr-word">Commands</span>
      <select id="cmdApproval" aria-label="Command approval">
        <option value="none">Disabled</option>
        <option value="ask">Ask each</option>
        <option value="allowlist">Allowlist</option>
        <option value="all">All (unsafe)</option>
      </select>
    </label>
    <label id="writeApprovalControl"><span class="appr-word">Writes</span>
      <select id="writeApproval" aria-label="Write approval">
        <option value="none">Auto (checkpointed)</option>
        <option value="ask">Ask each</option>
      </select>
    </label>
    <label id="codexPermissionControl" hidden><span class="appr-word">Permissions</span>
      <select id="codexPermissions" aria-label="Codex permissions" title="Codex permissions follow Plan/Act mode" disabled>
        <option value="read-only">Read only</option>
        <option value="ask-for-approval">Ask for approval</option>
        <option value="approve-for-me">Approve for me</option>
        <option value="full-access">Full access (unsafe)</option>
      </select>
    </label>
    <span class="codex-danger" id="codexComposerWarning" hidden>Full access: unsandboxed, network on, no prompts or checkpoints</span>
    <span class="steer-hint" id="steerHint" hidden>${esc('Agent is working — your message will steer it. Use Stop to cancel.')}</span>
    <div class="composer-actions">
      ${container === 'workbench' ? '' : contextMeter}
      <button class="ctx-compact is-gone" id="ctxCompact" type="button" title="Compact this conversation now" aria-label="Compact this conversation now">⤓</button>
      <button class="attach" id="attach" type="button" title="Attach image, text file, or PDF" aria-label="Attach image, text file, or PDF">📎</button>
      <input id="fileInput" type="file" multiple accept="image/*,application/pdf,.pdf,.txt,.md,.markdown,.json,.csv,.log,.xml,.yaml,.yml" hidden>
      <button class="send" id="send" title="Send" aria-label="Send">&#8593;</button>
      <button class="stop" id="stop" hidden title="Stop the running agent" aria-label="Stop the running agent">&#9632;</button>
    </div>
  </div>
   </div>
  </div>

  <aside class="inspector" id="inspector" aria-label="Edit history">
    <div class="inspector-title"><span>Edit history</span><span id="inspectorAgent"></span></div>
    <div id="inspectorFiles"></div>
  </aside>

  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const APPROVAL_DOCK_HYSTERESIS_PX = ${APPROVAL_DOCK_HYSTERESIS_PX};
    const shouldInlineApprovalDock = ${shouldInlineApprovalDock.toString()};
    const formatLocalInstant = ${formatLocalInstant.toString()};
    // Generated from the same declared host→webview union that types every host send site.
    const declaredHostCommands = new Set(${jsonForScript(CHAT_WEBVIEW_OUTBOUND_COMMANDS)});
    const savedUiState = typeof vscode.getState === 'function' ? (vscode.getState() || {}) : {};
    const initialState = JSON.parse('${initialJson}');
    const initialApprovalFocusId = JSON.parse('${initialApprovalFocusId}');
    const agentSelect = document.getElementById('agent');
    const transcript = document.getElementById('transcript');
    const input = document.getElementById('input');
    const sendButton = document.getElementById('send');
    const stopButton = document.getElementById('stop');
    const attachButton = document.getElementById('attach');
    const fileInput = document.getElementById('fileInput');
    const attachmentChips = document.getElementById('attachmentChips');
    const attachmentStatus = document.getElementById('attachmentStatus');
    const sendStatus = document.getElementById('sendStatus');
    const composer = document.getElementById('composer');
    const steerHint = document.getElementById('steerHint');
    const ctxCompact = document.getElementById('ctxCompact');
    const ctxMeter = document.getElementById('ctxMeter');
    const sessionMenuTrigger = document.getElementById('sessionMenuTrigger');
    const sessionMenu = document.getElementById('sessionMenu');
    const sessionMenuItems = sessionMenu ? Array.from(sessionMenu.querySelectorAll('[role="menuitem"]')) : [];
    // Downward-arrow-to-bar: content driven down into a summary. One character, so it renders identically
    // on every platform — an emoji here would vary in size and baseline between Windows, macOS and Linux.
    const COMPACT_GLYPH = '⤓';
    const COMPACT_BUSY_GLYPH = '⋯';
    // Set the instant the button is pressed and cleared by the next state push. The transcript marker is
    // the real feedback; this only stops a second click landing on a compaction already in flight.
    let compactInFlight = false;
    if (ctxCompact) {
      ctxCompact.addEventListener('click', () => {
        if (compactInFlight || ctxCompact.disabled) { return; }
        compactInFlight = true;
        ctxCompact.disabled = true;
        // The glyph changes rather than the width: a control that resizes mid-press moves everything
        // beside it. The transcript marker is the real feedback; this only marks the button as busy.
        ctxCompact.textContent = COMPACT_BUSY_GLYPH;
        vscode.postMessage({ command: 'compactContext' });
      });
    }
    function setSessionMenuOpen(open, restoreFocus) {
      if (!sessionMenu || !sessionMenuTrigger) return;
      sessionMenu.hidden = !open;
      sessionMenuTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (restoreFocus) sessionMenuTrigger.focus();
    }

    function focusSessionMenuItem(index) {
      if (!sessionMenuItems.length) return;
      const wrapped = (index + sessionMenuItems.length) % sessionMenuItems.length;
      sessionMenuItems[wrapped].focus();
    }

    sessionMenuTrigger?.addEventListener('click', () => {
      const opening = sessionMenu.hidden;
      setSessionMenuOpen(opening, false);
      if (opening) focusSessionMenuItem(0);
    });
    sessionMenuTrigger?.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      setSessionMenuOpen(true, false);
      focusSessionMenuItem(event.key === 'ArrowDown' ? 0 : sessionMenuItems.length - 1);
    });
    sessionMenu?.addEventListener('keydown', (event) => {
      const current = sessionMenuItems.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        setSessionMenuOpen(false, true);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        focusSessionMenuItem(current + (event.key === 'ArrowDown' ? 1 : -1));
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        focusSessionMenuItem(event.key === 'Home' ? 0 : sessionMenuItems.length - 1);
      } else if ((event.key === 'Enter' || event.key === ' ') && current >= 0) {
        event.preventDefault();
        sessionMenuItems[current].click();
      } else if (event.key === 'Tab') {
        setSessionMenuOpen(false, false);
      }
    });

    // Menu items name commands; the host still owns the allowlist boundary. Clicking outside closes the
    // menu, while activating an item closes it and returns focus to the trigger.
    document.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-chat-command]');
      if (button) {
        vscode.postMessage({ command: 'chatCommand', target: button.dataset.chatCommand });
        setSessionMenuOpen(false, true);
        return;
      }
      if (sessionMenu && !sessionMenu.hidden && !sessionMenu.contains(event.target) && !sessionMenuTrigger.contains(event.target)) {
        setSessionMenuOpen(false, false);
      }
    });

    const planMode = document.getElementById('planMode');
    const actMode = document.getElementById('actMode');
    const planEl = document.getElementById('plan');
    const planList = document.getElementById('planList');
    const planCount = document.getElementById('planCount');
    const sessionSummary = document.getElementById('sessionSummary');
    const sessionFacts = document.getElementById('sessionFacts');
    const codexSessionWarning = document.getElementById('codexSessionWarning');
    const inspectorFiles = document.getElementById('inspectorFiles');
    const inspectorAgentLabel = document.getElementById('inspectorAgent');
    const approvalsEl = document.getElementById('approvals');
    const politeAnnouncement = document.getElementById('announcement-polite');
    const assertiveAnnouncement = document.getElementById('announcement-assertive');
    const cmdApprovalSel = document.getElementById('cmdApproval');
    const writeApprovalSel = document.getElementById('writeApproval');
    const commandApprovalControl = document.getElementById('commandApprovalControl');
    const writeApprovalControl = document.getElementById('writeApprovalControl');
    const codexPermissionControl = document.getElementById('codexPermissionControl');
    const codexPermissionsSel = document.getElementById('codexPermissions');
    const codexComposerWarning = document.getElementById('codexComposerWarning');
    const MAX_ATTACHMENTS = 6;
    const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
    const MAX_PDF_ATTACHMENT_BYTES = 10 * 1024 * 1024;
    const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv', 'text/log', 'application/json', 'application/xml', 'text/xml']);
    let pendingAttachments = [];
    let pendingSend;
    let sendRequestSequence = 0;
    // F7-13 (v0.9.88): the host answers every send synchronously. If no answer comes (the extension host
    // restarted under this view), the composer is given back with the draft instead of staying on "Sending…".
    const SEND_ACK_TIMEOUT_MS = 10000;
    const SEND_UNCONFIRMED_NOTICE = 'UnodeAi did not confirm this message. Your draft was kept. If it does not '
      + 'appear above, send it again. If this keeps happening, reload the window.';
    let unconfirmedSend;
    let attachmentGeneration = 0;
    let knownHostInstanceId;
    // v0.9.88 attention signal: a short, quiet two-note chime synthesized with Web Audio when a prompt starts
    // waiting on the user. No audio file ships and the Content Security Policy stays default-src 'none'. An id is
    // played at most once, so a re-delivered message never chimes twice.
    let attentionAudio;
    const playedAttentionIds = [];
    async function playAttention(id) {
      if (typeof id !== 'string' || playedAttentionIds.includes(id)) return;
      playedAttentionIds.push(id);
      if (playedAttentionIds.length > 32) playedAttentionIds.shift();
      let audioState = 'unavailable';
      let started = false;
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          attentionAudio = attentionAudio || new AudioContextClass();
          if (attentionAudio.state === 'suspended' && typeof attentionAudio.resume === 'function') {
            // Without a user activation Chromium can leave resume() pending for ever; never let that hang the receipt.
            try {
              await Promise.race([attentionAudio.resume(), new Promise((resolve) => setTimeout(resolve, 500))]);
            } catch { /* reported below as suspended */ }
          }
          audioState = attentionAudio.state;
          if (audioState === 'running') {
            const now = attentionAudio.currentTime;
            [[880, 0], [1320, 0.14]].forEach(([frequency, offset]) => {
              const oscillator = attentionAudio.createOscillator();
              const gain = attentionAudio.createGain();
              oscillator.type = 'sine';
              oscillator.frequency.value = frequency;
              gain.gain.setValueAtTime(0.0001, now + offset);
              gain.gain.exponentialRampToValueAtTime(0.12, now + offset + 0.02);
              gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.16);
              oscillator.connect(gain);
              gain.connect(attentionAudio.destination);
              oscillator.start(now + offset);
              oscillator.stop(now + offset + 0.18);
            });
            started = true;
          }
        }
      } catch {
        audioState = 'error';
      }
      vscode.postMessage({ command: 'attentionResult', id, audioState, started });
    }
    // The editor may refuse to start audio outside a user gesture (the v0.9.88 probe). Start it during the first
    // key or pointer press in this view instead: a running AudioContext stays running, so one interaction is
    // enough for every later chime, whichever autoplay rule applies. Nothing starts while the setting is off.
    function primeAttentionAudio() {
      if (!state || state.attentionSound !== true) return;
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        attentionAudio = attentionAudio || new AudioContextClass();
        if (attentionAudio.state === 'suspended' && typeof attentionAudio.resume === 'function') {
          attentionAudio.resume().catch(() => {});
        }
      } catch { /* a sound that cannot start never affects the chat */ }
    }
    window.addEventListener('pointerdown', primeAttentionAudio, true);
    window.addEventListener('keydown', primeAttentionAudio, true);
    let state = initialState;
    const MAX_AGENT_DRAFTS = 20;
    const MAX_TOOL_EXPANSION_AGENTS = 20;
    const MAX_EXPANDED_TOOL_IDS_PER_AGENT = 60;
    let draftRevision = 0;
    let lastComposerInsertionRevision = 0;
    const draftsByAgent = readSavedDrafts(savedUiState.draftsByAgent);
    const expandedToolIdsByAgent = readSavedToolExpansion(savedUiState.expandedToolIdsByAgent);
    // Migrate the old one-container shape exactly once. Once a draft is associated with an agent it can
    // never show up under whichever agent happens to be selected later.
    if (Object.keys(draftsByAgent).length === 0 && typeof savedUiState.draft === 'string' && initialState.selectedAgentId) {
      draftsByAgent[initialState.selectedAgentId] = { text: savedUiState.draft, editedAt: ++draftRevision };
    }
    // Keep the card that was brought into view stable across a layout change. The dock's height is
    // measured separately, but scroll-margin only affects a scroll operation; resizing otherwise leaves
    // the previous scroll position in place and can move this card underneath the fixed dock.
    let approvalReservationId = initialApprovalFocusId || '';
    // A restored/revealed container sees the current host state, not a new event. Seed before first
    // render so it never reads a backlog just because it was reopened.
    let lastAnnouncementSeq = announcementSeq(initialState.announcement);
    restoreDraftForAgent(initialState.selectedAgentId);
    applyComposerInsertion(initialState.composerInsertion);
    const reducedMotionQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

    function announcementSeq(announcement) {
      const seq = Number(announcement && announcement.seq);
      return Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0;
    }

    function readSavedDrafts(raw) {
      const result = {};
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
      for (const [agentId, draft] of Object.entries(raw)) {
        if (!agentId || !draft || typeof draft !== 'object') continue;
        const text = typeof draft.text === 'string' ? draft.text : '';
        const editedAt = Number(draft.editedAt);
        if (text) {
          result[agentId] = { text, editedAt: Number.isFinite(editedAt) ? editedAt : 0 };
          draftRevision = Math.max(draftRevision, result[agentId].editedAt);
        }
      }
      return result;
    }

    function readSavedToolExpansion(raw) {
      const result = {};
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
      for (const [agentId, value] of Object.entries(raw).slice(-MAX_TOOL_EXPANSION_AGENTS)) {
        if (!agentId || !value || typeof value !== 'object' || Array.isArray(value)) continue;
        const cards = Array.isArray(value.cards)
          ? Array.from(new Set(value.cards.filter((id) => typeof id === 'string' && id.length <= 240))).slice(-MAX_EXPANDED_TOOL_IDS_PER_AGENT)
          : [];
        const groups = Array.isArray(value.groups)
          ? Array.from(new Set(value.groups.filter((id) => typeof id === 'string' && id.length <= 240))).slice(-MAX_EXPANDED_TOOL_IDS_PER_AGENT)
          : [];
        if (cards.length || groups.length) result[agentId] = { cards, groups };
      }
      return result;
    }

    function toolIds(item) {
      if (item && item.kind === 'toolGroup') {
        return (item.tools || []).map((tool) => tool && tool.id).filter(Boolean);
      }
      return item && item.id ? [item.id] : [];
    }

    function toolExpansion(agentId = state.selectedAgentId) {
      return expandedToolIdsByAgent[agentId] || { cards: [], groups: [] };
    }

    function isToolExpanded(item) {
      const stored = toolExpansion();
      const ids = toolIds(item);
      return item && item.kind === 'toolGroup'
        ? ids.some((id) => stored.cards.includes(id) || stored.groups.includes(id))
        : ids.some((id) => stored.cards.includes(id));
    }

    function setToolExpanded(item, open) {
      const agentId = state.selectedAgentId;
      const ids = toolIds(item);
      if (!agentId || ids.length === 0) return;
      const previous = toolExpansion(agentId);
      let cards = previous.cards.filter((id) => !ids.includes(id));
      let groups = previous.groups.filter((id) => !ids.includes(id));
      if (open) {
        if (item && item.kind === 'toolGroup') groups.push(ids[0]);
        else cards.push(ids[0]);
      }
      cards = cards.slice(-MAX_EXPANDED_TOOL_IDS_PER_AGENT);
      groups = groups.slice(-MAX_EXPANDED_TOOL_IDS_PER_AGENT);
      if (cards.length || groups.length) expandedToolIdsByAgent[agentId] = { cards, groups };
      else delete expandedToolIdsByAgent[agentId];
      persistUiSnapshot();
    }

    function pruneDrafts() {
      let changed = false;
      const live = new Set(state.agents.map((agent) => agent.id));
      for (const agentId of Object.keys(draftsByAgent)) {
        if (!live.has(agentId) || !draftsByAgent[agentId].text) {
          delete draftsByAgent[agentId];
          changed = true;
        }
      }
      const retained = Object.entries(draftsByAgent)
        .sort(([, a], [, b]) => a.editedAt - b.editedAt || a.text.localeCompare(b.text));
      while (retained.length > MAX_AGENT_DRAFTS) {
        const [agentId] = retained.shift();
        delete draftsByAgent[agentId];
        changed = true;
      }
      return changed;
    }

    function restoreDraftForAgent(agentId) {
      input.value = agentId && draftsByAgent[agentId] ? draftsByAgent[agentId].text : '';
    }

    function applyComposerInsertion(insertion) {
      const revision = Number(insertion && insertion.revision);
      if (!insertion || insertion.agentId !== state.selectedAgentId || !Number.isSafeInteger(revision) || revision <= lastComposerInsertionRevision) {
        return;
      }
      const text = typeof insertion.text === 'string' ? insertion.text : '';
      if (!text) return;
      lastComposerInsertionRevision = revision;
      input.value = input.value.trimEnd() ? input.value.trimEnd() + '\\n\\n' + text : text;
      autoGrow();
      persistUiState();
      input.focus();
      vscode.postMessage({ command: 'composerInsertionApplied', revision });
    }

    function renderAnnouncement(announcement, deliver) {
      const seq = announcementSeq(announcement);
      if (seq <= lastAnnouncementSeq) return;
      // Every visible document records the event even when it is not the one chosen to speak. If it
      // later gains focus it must not replay history; the host will give it the next sequence instead.
      lastAnnouncementSeq = seq;
      if (!deliver || !announcement || !announcement.text) return;
      const target = announcement.politeness === 'assertive' ? assertiveAnnouncement : politeAnnouncement;
      const other = announcement.politeness === 'assertive' ? politeAnnouncement : assertiveAnnouncement;
      if (!target) return;
      const spoken = announcement.text;
      if (other) other.textContent = '';
      target.textContent = '';
      // The empty state has to be OBSERVED before the text returns. Clearing and rewriting the same string
      // inside one task is not a change at all by the time the accessibility tree is computed — it sees
      // only the final value, identical to the previous one — so a repeated identical announcement was
      // silent. That is exactly the case the sequence number exists for, and it stayed broken because the
      // unit test asserts the host's sequence, which was always correct; only a screen reader could show
      // that nothing was spoken.
      setTimeout(() => {
        if (seq !== lastAnnouncementSeq) return; // a newer announcement took over while we waited
        target.textContent = spoken;
        // Then wipe it once spoken: the region is visually hidden but still in the accessibility tree, so
        // text left behind is read again whenever the page is read, as speech with no visible source.
        setTimeout(() => { if (target.textContent === spoken) target.textContent = ''; }, 1500);
      }, 50);
    }

    function renderedTranscriptSnapshot(snapshot) {
      const items = snapshot && Array.isArray(snapshot.messages) ? snapshot.messages : [];
      const seen = new Set();
      const result = [];
      for (const item of items) {
        if (!item) continue;
        const id = transcriptObservationKey(item);
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        result.push({ id, delivery: item.live === true ? 'live' : 'committed' });
      }
      return result;
    }

    // Rendering keys deliberately change when a tool/delegation card receives new status. The sensor is
    // about logical transcript disappearance, so it must not treat an in-place card update as a missing
    // item. Live rows keep the same seq-derived key when they become committed, so that normal transition
    // is retained while a genuinely omitted streaming row is still detected.
    function transcriptObservationKey(item) {
      if (item.live && item.kind === 'reasoning') return 'reasoning:' + (item.seq !== undefined ? item.seq : item.id);
      if (item.live) return 'msg:' + (item.seq !== undefined ? item.seq : (item.role + ':' + item.ts + ':' + (item.text ? item.text.length : 0)));
      if (item.kind === 'tool') return 'tool:' + item.id;
      if (item.kind === 'toolGroup') return 'toolGroup:' + item.key;
      if (item.kind === 'delegation') return 'delegation:' + item.id;
      // One logical card per run, whatever it currently says: an in-place update is not a disappearance.
      if (item.kind === 'jobOutcome') return 'outcome:' + item.id;
      return itemKey(item);
    }

    function transcriptObservationStream(item) {
      const separator = item.id.indexOf(':');
      return separator < 0 ? '' : item.id.slice(0, separator);
    }

    function boundedTranscriptStreamLimit(stream) {
      if (stream === 'msg') return ${CHAT_HISTORY_LIMIT};
      if (stream === 'reasoning') return ${CHAT_REASONING_LIMIT};
      if (stream === 'tool') return ${CHAT_TOOLS_LIMIT};
      if (stream === 'delegation') return ${DELEGATION_PROGRESS_SUMMARY_LIMIT};
      if (stream === 'context') return ${CHAT_HISTORY_LIMIT};
      if (stream === 'marker') return ${CHAT_TRANSIENT_ITEM_LIMIT};
      return undefined;
    }

    // Messages, reasoning, tools, delegation summaries, context cards and markers are separate bounded
    // FIFOs merged by seq for display. Their oldest rows are therefore interleaved: a normal message trim
    // is usually NOT a leading run of the merged transcript. Classify each affected FIFO against its own
    // real cap and require every retained row to survive in order. A missing middle/newest/live row still
    // fails this proof and remains an unexplained display-integrity event.
    function isBoundedTranscriptWindowTrim(previousItems, nextItems, missing) {
      const missingIds = new Set(missing.map((item) => item.id));
      const affectedStreams = new Set(missing.map(transcriptObservationStream));
      for (const stream of affectedStreams) {
        // An outcome card has no window of its own: it leaves only together with the reply it follows.
        if (stream === 'outcome') {
          if (!affectedStreams.has('msg')) return false;
          continue;
        }
        const limit = boundedTranscriptStreamLimit(stream);
        if (!limit) return false;
        const previousStream = previousItems.filter((item) => transcriptObservationStream(item) === stream);
        const nextStream = nextItems.filter((item) => transcriptObservationStream(item) === stream);
        const missingStream = previousStream.filter((item) => missingIds.has(item.id));
        if (previousStream.length < limit || nextStream.length < limit) return false;
        if (missingStream.some((item) => item.delivery !== 'committed')) return false;
        if (!missingStream.every((item, index) => previousStream[index] && previousStream[index].id === item.id)) return false;
        let nextIndex = 0;
        for (const item of previousStream.slice(missingStream.length)) {
          while (nextIndex < nextStream.length && nextStream[nextIndex].id !== item.id) nextIndex += 1;
          if (nextIndex === nextStream.length) return false;
          nextIndex += 1;
        }
      }
      return affectedStreams.size > 0;
    }

    function turnEpochFor(snapshot) {
      const epoch = snapshot && snapshot.turnEpochs && snapshot.turnEpochs[snapshot.selectedAgentId];
      return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : undefined;
    }

    function observeRenderedTranscriptReplacement(next) {
      if (!state || !next || !state.selectedAgentId || state.selectedAgentId !== next.selectedAgentId) return;
      const previousItems = renderedTranscriptSnapshot(state);
      if (!previousItems.length) return;
      const nextItems = renderedTranscriptSnapshot(next);
      const nextIds = new Set(nextItems.map((item) => item.id));
      const missing = previousItems.filter((item) => !nextIds.has(item.id));
      if (!missing.length) return;
      const cause = isBoundedTranscriptWindowTrim(previousItems, nextItems, missing) ? 'window-trim' : 'unexplained';
      const previousTurnEpoch = turnEpochFor(state);
      const nextTurnEpoch = turnEpochFor(next);
      vscode.postMessage({
        command: 'renderedTranscriptItemsMissing',
        agentId: state.selectedAgentId,
        cause,
        previousItemCount: previousItems.length,
        nextItemCount: nextItems.length,
        missing,
        previousTurnEpoch,
        nextTurnEpoch,
        epochChanged: previousTurnEpoch !== nextTurnEpoch,
      });
    }

    function renderState(next, announce) {
      noteHostInstance(next);
      observeRenderedTranscriptReplacement(next);
      const previousSelectedAgentId = state.selectedAgentId;
      if (previousSelectedAgentId && previousSelectedAgentId !== next.selectedAgentId) {
        persistUiState(previousSelectedAgentId);
      }
      state = next;
      if (pruneDrafts()) {
        // An agent can disappear without the user changing the select. Persist that removal immediately
        // so a later agent reusing the id cannot inherit its predecessor's private draft.
        persistUiState('', false);
      }
      if (previousSelectedAgentId !== state.selectedAgentId) {
        restoreDraftForAgent(state.selectedAgentId);
        autoGrow();
      }
      applyComposerInsertion(state.composerInsertion);
      if (
        previousSelectedAgentId !== state.selectedAgentId ||
        state.smoothStreaming === false ||
        !state.runningAgentIds.includes(state.selectedAgentId)
      ) {
        flushAllPacing();
      }
      renderCompact();
      renderAgents();
      renderSessionSummary();
      renderInspector();
      renderMode();
      renderPlan();
      renderTranscript();
      renderApprovalBar();
      renderApprovals();
      updateComposer();
      recomputeApprovalReservation();
      renderAnnouncement(state.announcement, announce === true);
    }

    function renderSessionSummary() {
      const agent = state.agents.find((candidate) => candidate.id === state.selectedAgentId);
      sessionSummary.hidden = !agent;
      if (!agent) {
        setSessionMenuOpen(false, false);
        return;
      }
      // No task line and no status here. The Team row states the lifecycle, and the task line spent a
      // whole row telling you there was nothing to tell. What is left is what the row cannot say. The context
      // size is not among it: the meter at the end of this bar is the one reading of it.
      const routeAndModel = [agent.routeLabel || agent.backend, agent.model].filter(Boolean).join(' · ');
      const cost = Number.isFinite(Number(agent.costUsd)) && Number(agent.costUsd) > 0
        ? '$' + Number(agent.costUsd).toFixed(3) + ' used'
        : '';
      const turns = Number.isFinite(Number(agent.turns)) && Number(agent.turns) > 0
        ? Number(agent.turns) + (Number(agent.turns) === 1 ? ' turn' : ' turns')
        : '';
      sessionFacts.textContent = [agent.role, routeAndModel, cost, turns].filter(Boolean).join(' · ');
      if (codexSessionWarning) codexSessionWarning.hidden = agent.codexPermissionProfile !== 'full-access';
    }

    // Team edit history, grouped by owner. It reads the same checkpoint-derived state as each agent's
    // own view; selecting a coordinator must not make the crew's edits look like they did not happen.
    // Built with DOM calls rather than innerHTML — these are workspace paths from an agent's edits.
    function renderInspector() {
      document.body.classList.toggle('rail-open', state.inspectorOpen === true);
      if (!inspectorFiles) return;
      const agent = state.agents.find((candidate) => candidate.id === state.selectedAgentId);
      const groups = Array.isArray(state.changedFileGroups) ? state.changedFileGroups : [];
      const selectedGroup = groups.find((group) => group && group.agentId === state.selectedAgentId);
      if (inspectorAgentLabel) inspectorAgentLabel.textContent = groups.length > 0 ? 'Team' : '';
      if (groups.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'inspector-empty';
        empty.textContent = agent
          ? 'Nobody on this team has changed any files yet.'
          : 'No team is selected.';
        inspectorFiles.replaceChildren(empty);
        return;
      }
      const nodes = [];
      if (agent && !selectedGroup) {
        const note = document.createElement('p');
        note.className = 'inspector-empty';
        note.textContent = agent.name + " hasn't changed any files yet. Showing edits from teammates.";
        nodes.push(note);
      }
      for (const group of groups) {
        if (!group || !Array.isArray(group.files) || group.files.length === 0) continue;
        const section = document.createElement('section');
        section.className = 'inspector-group';
        const heading = document.createElement('h3');
        heading.textContent = group.agentName || group.agentId || 'Unknown agent';
        section.append(heading, ...group.files.map((file) => renderInspectorFile(file)));
        nodes.push(section);
      }
      inspectorFiles.replaceChildren(...nodes);
    }

    function renderInspectorFile(file) {
        const row = document.createElement('div');
        row.className = 'inspector-file';

        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'open';
        open.title = file.path + ' — open the diff for this edit';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = file.path;
        const when = document.createElement('span');
        when.className = 'when';
        when.textContent = relativeTime(file.ts);
        open.append(name, when);
        open.addEventListener('click', () => {
          vscode.postMessage({ command: 'openCheckpointDiff', checkpointId: file.checkpointId });
        });

        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'restore';
        const restoreDisabledReason = typeof file.restoreDisabledReason === 'string' ? file.restoreDisabledReason : '';
        restore.disabled = !!restoreDisabledReason;
        restore.title = restoreDisabledReason
          ? 'Restore unavailable: ' + restoreDisabledReason
          : 'Restore ' + file.path + ' to the version before this edit';
        restore.setAttribute('aria-label', 'Restore ' + file.path);
        restore.textContent = '⟲';
        if (!restoreDisabledReason) {
          restore.addEventListener('click', () => {
            vscode.postMessage({ command: 'restoreCheckpoint', checkpointId: file.checkpointId });
          });
        }

        row.append(open, restore);
        if (restoreDisabledReason) {
          const unavailable = document.createElement('span');
          unavailable.className = 'unavailable';
          unavailable.textContent = 'Restore unavailable: ' + restoreDisabledReason;
          row.appendChild(unavailable);
        }
        return row;
    }

    function relativeTime(ts) {
      const secs = Math.max(0, Math.round((Date.now() - Number(ts)) / 1000));
      if (secs < 60) return secs + 's ago';
      const mins = Math.round(secs / 60);
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.round(mins / 60);
      return hrs < 24 ? hrs + 'h ago' : new Date(Number(ts)).toLocaleDateString();
    }

    function currentTurnEpoch(agentId) {
      const value = state.turnEpochs ? Number(state.turnEpochs[agentId]) : 0;
      return Number.isFinite(value) ? Math.floor(value) : 0;
    }

    function incomingEpoch(msg) {
      if (!msg || msg.epoch === undefined || msg.epoch === null) return undefined;
      const value = Number(msg.epoch);
      return Number.isFinite(value) ? Math.floor(value) : undefined;
    }

    function acceptStreamedEvent(msg) {
      const epoch = incomingEpoch(msg);
      return epoch === undefined || epoch === currentTurnEpoch(msg.agentId);
    }

    function renderApprovalBar() {
      const a = state.approvals || { command: 'ask', write: 'none' };
      if (cmdApprovalSel && cmdApprovalSel.value !== a.command) cmdApprovalSel.value = a.command;
      if (writeApprovalSel && writeApprovalSel.value !== a.write) writeApprovalSel.value = a.write;
      const selected = state.agents.find((candidate) => candidate.id === state.selectedAgentId);
      const isCodex = selected && selected.backend === 'codex';
      if (commandApprovalControl) commandApprovalControl.hidden = !!isCodex;
      if (writeApprovalControl) writeApprovalControl.hidden = !!isCodex;
      if (codexPermissionControl) codexPermissionControl.hidden = !isCodex;
      if (isCodex && codexPermissionsSel) {
        // Read only is a state UnodeAi imposes (Plan, or a trust/folder/tool cap), not an Act choice the host
        // can store. Left selectable, choosing it was rejected silently and the control went on showing Read
        // only while Codex kept running under the stored, writable profile. It stays displayable when forced.
        const readOnlyOption = codexPermissionsSel.querySelector('option[value="read-only"]');
        if (readOnlyOption) readOnlyOption.disabled = true;
        const profile = state.mode === 'plan' ? 'read-only' : (selected.codexPermissionProfile || 'ask-for-approval');
        if (codexPermissionsSel.value !== profile) codexPermissionsSel.value = profile;
        const capReason = state.mode === 'plan' ? 'Plan mode is always read only.' : (selected.codexPermissionCapReason || '');
        codexPermissionsSel.disabled = !!capReason || selectedIsRunning();
        codexPermissionsSel.title = capReason || 'Codex permission profile for this agent';
        if (codexComposerWarning) codexComposerWarning.hidden = profile !== 'full-access';
      } else if (codexComposerWarning) {
        codexComposerWarning.hidden = true;
      }
    }

    function approvalActions(req) {
      // Returns [{action, label, cls}] for the request kind.
      if (req.approveAnyway) {
        return [
          { action: 'once', label: 'Approve anyway', cls: 'primary' },
          { action: 'deny', label: 'Keep denied', cls: 'danger' },
        ];
      }
      if (req.singleUseOnly) {
        return [
          { action: 'once', label: 'Allow once', cls: 'primary' },
          { action: 'deny', label: 'Deny', cls: 'danger' },
        ];
      }
      if (req.kind === 'write') {
        return [
          { action: 'once', label: 'Approve', cls: 'primary' },
          { action: 'always', label: 'Approve all', cls: '' },
          { action: 'deny', label: 'Deny', cls: 'danger' },
        ];
      }
      if (req.kind === 'tool') {
        if (req.crewSessionWebAccess) {
          return [
            { action: 'once', label: 'Allow this request', cls: 'primary' },
            { action: 'always', label: 'Allow crew web access this session', cls: '' },
            { action: 'deny', label: 'Deny', cls: 'danger' },
          ];
        }
        return [
          { action: 'once', label: 'Allow once', cls: 'primary' },
          { action: 'always', label: 'Always allow this tool', cls: '' },
          { action: 'deny', label: 'Deny', cls: 'danger' },
        ];
      }
      const actions = [
        { action: 'once', label: 'Allow once', cls: 'primary' },
        // "This session" alone read as ambiguous (allow or deny?). Make every allow option start with
        // "Allow" so the choice is unmistakable and parallel with the native modal's labels.
        { action: 'session', label: 'Allow this session', cls: '' },
        { action: 'project', label: 'Allow for project', cls: '' },
        { action: 'deny', label: 'Deny', cls: 'danger' },
      ];
      if (req.safeCommandOffer) {
        // Deliberately visible and opt-in: the safe list is reviewed policy, not a hidden grant.
        actions.splice(1, 0, { action: 'safe', label: 'Enable safe commands', cls: '' });
      }
      return actions;
    }

    function renderApprovals() {
      const pending = state.pendingApprovals || [];
      approvalsEl.replaceChildren();
      const selected = (state.agents || []).find((agent) => agent.id === state.selectedAgentId);
      const consentRequired = selected && selected.status === 'consent_required';
      const timedOut = state.approvalOutcomes || (state.approvalAttention && state.approvalAttention.state === 'timed_out'
        ? [state.approvalAttention]
        : []);
      const outcomeRepairs = state.outcomeRepairs || [];
      const stillVisible = approvalReservationId === 'consent-required'
        ? consentRequired
        : pending.some((approval) => approval.id === approvalReservationId);
      if (!stillVisible) {
        approvalReservationId = pending[0]?.id || (consentRequired ? 'consent-required' : '');
      }
      approvalsEl.hidden = pending.length === 0 && !consentRequired && timedOut.length === 0 && outcomeRepairs.length === 0;

      // Host egress consent is a distinct, waiting lifecycle state. It is visible in the same transcript
      // context as a tool approval, but it has no duplicate approve control: the host modal owns it.
      if (consentRequired) {
        const card = document.createElement('div');
        card.className = 'appr-card consent-required';
        card.id = 'consent-required';
        const title = document.createElement('div');
        title.className = 'appr-title';
        title.textContent = '🔐 Consent required — waiting for you';
        const detail = document.createElement('div');
        detail.className = 'appr-warn';
        detail.textContent = selected.consentMessage || 'Respond to the open UnodeAi network-consent dialog to continue this agent.';
        card.append(title, detail);
        approvalsEl.appendChild(card);
      }

      for (const outcome of timedOut) {
        const card = document.createElement('div');
        card.className = 'appr-card timed-out';
        card.id = 'approval-timed-out-' + (outcome.approvalId || 'unknown');
        const title = document.createElement('div');
        title.className = 'appr-title';
        title.textContent = '🔐 Approval denied — timed out';
        const detail = document.createElement('div');
        detail.textContent = 'No decision arrived before the human approval window closed. This request is finished: its caller already received a denial, so it cannot be approved after the timeout.';
        card.append(title, detail);
        approvalsEl.appendChild(card);
      }

      for (const repair of outcomeRepairs) {
        const card = document.createElement('div');
        card.className = 'appr-card outcome-repair ' + repair.state;
        card.id = 'outcome-repair-' + repair.outcomeId;
        const title = document.createElement('div');
        title.className = 'appr-title';
        title.textContent = repair.title;
        const detail = document.createElement('div');
        detail.className = repair.state === 'unavailable' ? 'appr-warn' : '';
        detail.textContent = repair.detail;
        card.append(title, detail);
        if (repair.action) {
          const action = document.createElement('button');
          action.type = 'button';
          action.textContent = repair.action.label;
          action.addEventListener('click', () => vscode.postMessage({
            command: 'repairAction', kind: repair.action.kind, outcomeId: repair.outcomeId,
          }));
          card.appendChild(action);
        }
        // A deadline card offers its next steps together; each is one host action named by the host.
        if (Array.isArray(repair.actions) && repair.actions.length > 0) {
          const row = document.createElement('div');
          row.className = 'appr-actions outcome-actions';
          for (const offered of repair.actions) {
            const action = document.createElement('button');
            action.type = 'button';
            if (offered.kind === 'retry-same-route') action.className = 'primary';
            action.textContent = offered.label;
            action.addEventListener('click', () => vscode.postMessage({
              command: 'repairAction', kind: offered.kind, outcomeId: repair.outcomeId,
            }));
            row.appendChild(action);
          }
          card.appendChild(row);
        }
        approvalsEl.appendChild(card);
      }

      for (const req of pending) {
        const card = document.createElement('div');
        card.className = 'appr-card';
        card.id = 'approval-' + req.id;

        const title = document.createElement('div');
        title.className = 'appr-title';
        const ico = document.createElement('span');
        ico.className = 'ico';
        ico.textContent = '⚠';
        const titleText = document.createElement('span');
        if (req.kind === 'write') {
          titleText.textContent = req.agentName + ' wants to ' + (req.verb || 'write') + ' ' + req.path;
        } else if (req.kind === 'tool') {
          titleText.textContent = req.crewSessionWebAccess
            ? req.agentName + ' wants to access the public web'
            : req.agentName + ' wants to use ' + (req.toolName || 'a tool');
        } else {
          titleText.textContent = req.agentName + ' wants to run a command';
        }
        title.append(ico, titleText);
        card.appendChild(title);

        // Why this is being asked at all when policy would have let it through — e.g. the command names a
        // path outside the agent's folder. The detector reports; the human decides.
        if (req.warning) {
          const warn = document.createElement('div');
          warn.className = 'appr-warn';
          warn.textContent = req.warning;
          card.appendChild(warn);
        }

        const body = document.createElement('pre');
        if (req.kind === 'write') {
          body.textContent = req.diff || '(no preview)';
        } else if (req.kind === 'tool') {
          body.className = 'appr-cmd';
          body.textContent = req.toolDetail || req.toolName || 'Tool use';
        } else {
          body.className = 'appr-cmd';
          body.textContent = (req.command || '') + (req.template
            ? '\\n\\nAllow for project will save this pattern:\\n' + req.template
            : '');
        }
        card.appendChild(body);

        const note = document.createElement('input');
        note.type = 'text';
        note.className = 'appr-note';
        note.placeholder = 'Optional note to the agent (used if you deny)';

        const actions = document.createElement('div');
        actions.className = 'appr-actions';
        for (const a of approvalActions(req)) {
          const btn = document.createElement('button');
          btn.type = 'button';
          if (a.cls) btn.className = a.cls;
          btn.textContent = a.label;
          btn.addEventListener('click', () => {
            vscode.postMessage({
              command: 'approvalDecision',
              id: req.id,
              action: a.action,
              note: a.action === 'deny' ? note.value : '',
            });
          });
          actions.appendChild(btn);
        }
        if (req.kind === 'command' || req.kind === 'tool') {
          card.appendChild(note);
        }
        card.appendChild(actions);
        approvalsEl.appendChild(card);
      }
    }

    function approvalTarget(id) {
      return id === 'consent-required'
        ? document.getElementById('consent-required')
        : document.getElementById('approval-' + id);
    }

    function revealApproval(id, behavior = 'smooth') {
      if (typeof id !== 'string' || !id) return;
      approvalReservationId = id;
      const target = approvalTarget(id);
      target?.scrollIntoView({ block: 'center', behavior });
    }

    function measureApprovalDockHeight() {
      const dock = document.getElementById('composerDock');
      const wasInline = document.body.classList.contains('approval-dock-inline');
      // Measure the dock in the geometry whose height must be reserved. Removing and restoring the
      // class happens synchronously inside one frame, so an already-inline decision cannot paint under
      // the dock while still giving a width change an exact floating height.
      if (wasInline) document.body.classList.remove('approval-dock-inline');
      const height = dock ? Math.max(0, Math.ceil(dock.getBoundingClientRect().height)) : 0;
      if (wasInline) document.body.classList.add('approval-dock-inline');
      document.body.style.setProperty('--composer-dock-h', String(height) + 'px');
    }

    function cssPixels(value) {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function minimumApprovalColumnHeight() {
      const bodyStyle = getComputedStyle(document.body);
      const dock = document.getElementById('composerDock');
      const inFlow = [];
      for (const element of Array.from(document.body.children)) {
        const style = getComputedStyle(element);
        if (element === dock || style.display === 'none' || style.position === 'absolute' || style.position === 'fixed') {
          continue;
        }
        inFlow.push({ element, style });
      }

      let required = cssPixels(bodyStyle.paddingTop) + cssPixels(bodyStyle.paddingBottom);
      required += Math.max(0, inFlow.length - 1) * cssPixels(bodyStyle.rowGap);
      for (const item of inFlow) {
        let height = item.element.getBoundingClientRect().height;
        if (item.element === transcript) {
          // The transcript scrolls internally, so its content does not set the column minimum. Its own
          // measured dock-clearance padding can, however, be taller than min-height (156px in C5-1).
          const paddedBorderBox = cssPixels(item.style.paddingTop) + cssPixels(item.style.paddingBottom)
            + cssPixels(item.style.borderTopWidth) + cssPixels(item.style.borderBottomWidth);
          height = Math.max(cssPixels(item.style.minHeight), paddedBorderBox);
        }
        required += height + cssPixels(item.style.marginTop) + cssPixels(item.style.marginBottom);
      }
      return Math.max(0, Math.ceil(required));
    }

    function recomputeApprovalReservation() {
      if (!document.body.classList.contains('container-workbench')) return;
      measureApprovalDockHeight();
      const id = approvalReservationId || (state.pendingApprovals || [])[0]?.id;
      const hasPendingDecision = (state.pendingApprovals || []).some((approval) => !!approvalTarget(approval.id));
      const currentlyInline = document.body.classList.contains('approval-dock-inline');
      document.body.classList.toggle('approval-dock-inline', shouldInlineApprovalDock({
        viewportHeight: window.innerHeight,
        columnRequiredHeight: hasPendingDecision ? minimumApprovalColumnHeight() : 0,
        hasPendingDecision,
        currentlyInline,
        hysteresisPx: APPROVAL_DOCK_HYSTERESIS_PX,
      }));
      if (id && approvalTarget(id)) {
        // A resize is an ambient layout update, not a user navigation: retain the card's visibility
        // without a second smooth-scroll animation.
        revealApproval(id, 'auto');
      }
    }

    // A width or composer-height change can reflow the transcript/card after its original reveal.
    // Keep the active decision anchored and update its conditional, measured reservation without
    // restoring a permanent composer band below every transcript.
    if (typeof ResizeObserver === 'function' && document.body.classList.contains('container-workbench')) {
      let reservationQueued = false;
      const approvalReflowObserver = new ResizeObserver(() => {
        if (reservationQueued) return;
        reservationQueued = true;
        requestAnimationFrame(() => {
          reservationQueued = false;
          recomputeApprovalReservation();
        });
      });
      approvalReflowObserver.observe(document.body);
      const composerDockForReservation = document.getElementById('composerDock');
      if (composerDockForReservation) approvalReflowObserver.observe(composerDockForReservation);
      recomputeApprovalReservation();
    }

    const TICK = { completed: '☑', in_progress: '▸', pending: '☐' };
    let hasTodoPlan = false;
    let todoPlanExpanded = false;

    planEl.addEventListener('toggle', () => {
      if (!planEl.hidden && hasTodoPlan) {
        todoPlanExpanded = planEl.open;
      }
    });

    function renderPlan() {
      const todos = (state.todos || []);
      if (!todos.length) {
        hasTodoPlan = false;
        todoPlanExpanded = false;
        planEl.hidden = true;
        planEl.open = false;
        planCount.textContent = '';
        planList.replaceChildren();
        return;
      }
      planEl.hidden = false;
      const done = todos.filter((t) => t.status === 'completed').length;
      const allDone = done === todos.length;
      const current = todos.find((t) => t.status === 'in_progress');
      // This is entirely model-reported state: no TODO snapshot means no summary, and "done" counts
      // only items explicitly marked completed by update_todos.
      planCount.textContent = (allDone ? '✓ ' : '') + done + ' of ' + todos.length + ' done' + (current ? ' · ' + current.content : '');
      // A new genuine plan opens as a single compact line. The user can expand it, and later state
      // refreshes preserve that choice instead of snapping the checklist open/closed mid-read.
      if (!hasTodoPlan) {
        todoPlanExpanded = false;
        hasTodoPlan = true;
      }
      planEl.open = todoPlanExpanded;
      planEl.classList.toggle('done', allDone);
      planList.replaceChildren();
      for (const t of todos) {
        const li = document.createElement('li');
        const cls = t.status === 'completed' ? 'done' : (t.status === 'in_progress' ? 'active' : 'pending');
        li.className = cls;
        const tick = document.createElement('span');
        tick.className = 'tick';
        tick.textContent = TICK[t.status] || '☐';
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = t.content;
        li.append(tick, label);
        planList.appendChild(li);
      }
    }

    function renderCompact() {
      document.body.classList.toggle('compact', !!state.compact);
    }

    let lastAgentsSig = null;
    function renderAgents() {
      const agents = state.agents.length ? state.agents : [{ id: '', name: 'No agents yet', role: '' }];
      const sig = agents.map((a) => a.id + '|' + a.name + '|' + a.role + '|' + (a.icon || '')).join('~~');
      if (sig !== lastAgentsSig) {
        // The roster actually changed — rebuild the option list.
        lastAgentsSig = sig;
        const previous = agentSelect.value || state.selectedAgentId;
        agentSelect.replaceChildren();
        for (const agent of agents) {
          const option = document.createElement('option');
          option.value = agent.id;
          option.textContent = agent.role ? agent.name + ' (' + agent.role + ')' : agent.name;
          agentSelect.appendChild(option);
        }
        agentSelect.value = state.selectedAgentId || previous || '';
      } else if (state.selectedAgentId && agentSelect.value !== state.selectedAgentId) {
        // Roster unchanged — only sync the selected value. Do NOT rebuild the <select>: during active
        // work there are many state pushes per second, and replaceChildren() on each one wipes an open
        // dropdown (you'd see only the selected agent until activity calmed down).
        agentSelect.value = state.selectedAgentId;
      }
    }

    function renderMode() {
      const mode = state.mode === 'plan' ? 'plan' : 'act';
      planMode.classList.toggle('active', mode === 'plan');
      actMode.classList.toggle('active', mode === 'act');
      planMode.setAttribute('aria-pressed', mode === 'plan' ? 'true' : 'false');
      actMode.setAttribute('aria-pressed', mode === 'act' ? 'true' : 'false');
    }

    // Incremental render: reuse existing DOM nodes keyed by item identity so a state update doesn't
    // rebuild the whole transcript (no flicker, no perf cliff on long chats), and only stick to the
    // bottom when the user is already there (don't yank them down while they read history).
    let nodeByKey = new Map();
    let lastRenderedAgentId = null;
    let disableAutoScroll = false;
    let bottomSettleTimers = [];
    const AUTO_SCROLL_RESUME_PX = 10;

    function bottomGap() {
      return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
    }

    function isNearBottom(threshold) {
      return bottomGap() < (threshold === undefined ? 48 : threshold);
    }

    function shouldAutoScroll(wasNearBottom) {
      return !disableAutoScroll && wasNearBottom;
    }

    function clearBottomSettleTimers() {
      for (const timer of bottomSettleTimers) clearTimeout(timer);
      bottomSettleTimers = [];
    }

    function pinTranscriptToBottom(behavior) {
      if (disableAutoScroll) return;
      const top = transcript.scrollHeight;
      try {
        if (typeof transcript.scrollTo === 'function') {
          transcript.scrollTo({ top, behavior: behavior || 'auto' });
        } else {
          transcript.scrollTop = top;
        }
      } catch {
        transcript.scrollTop = top;
      }
    }

    function scheduleBottomSettle(smooth) {
      if (disableAutoScroll) return;
      clearBottomSettleTimers();
      pinTranscriptToBottom(smooth ? 'smooth' : 'auto');
      bottomSettleTimers = [
        setTimeout(() => pinTranscriptToBottom('auto'), 40),
        setTimeout(() => pinTranscriptToBottom('auto'), 70),
        setTimeout(() => pinTranscriptToBottom('auto'), 500),
      ];
    }

    // Called by the pacing layer after each animation-frame paint of the live tail. A paced paint adds at
    // most a few words, so measuring nearness after it stays inside the threshold; a reader who scrolled
    // up is still respected through shouldAutoScroll.
    function onPacedPaint() {
      if (shouldAutoScroll(isNearBottom())) pinTranscriptToBottom('auto');
    }

    function handleToolCardToggle(open) {
      if (open) {
        disableAutoScroll = true;
        clearBottomSettleTimers();
        return;
      }
      disableAutoScroll = false;
      scheduleBottomSettle(false);
    }

    function onTranscriptWheel(event) {
      if (event.deltaY < 0) {
        disableAutoScroll = true;
        clearBottomSettleTimers();
      }
    }

    function onTranscriptScroll() {
      if (isNearBottom(AUTO_SCROLL_RESUME_PX)) {
        disableAutoScroll = false;
      }
    }

    function itemKey(m) {
      if (m.live) return m.kind === 'reasoning' ? 'live:reasoning' : 'live:message';
      // Tool cards are NOT immutable: they go use→result (the result phase adds the diff/output). Key by
      // phase too, so the result re-renders instead of reusing the frozen use-phase (input-only) node.
      if (m.kind === 'tool') return 'tool:' + m.id + ':' + m.phase + ':' + String(m.completedAt || '') + (m.ok === false ? ':err' : '');
      if (m.kind === 'toolGroup') return 'toolGroup:' + m.key;
      if (m.kind === 'delegation') return m.renderKey;
      if (m.kind === 'jobOutcome') return 'outcome:' + m.renderKey;
      if (m.kind === 'contextManifest') return 'context:' + m.id;
      if (m.kind === 'soloSuggestion') return 'solo:' + m.id;
      if (m.kind === 'reasoning' || m.kind === 'marker') return m.kind + ':' + (m.seq !== undefined ? m.seq : m.id);
      return 'msg:' + (m.seq !== undefined ? m.seq : (m.role + ':' + m.ts + ':' + (m.text ? m.text.length : 0)));
    }

    function renderTranscript() {
      if (state.selectedAgentId !== lastRenderedAgentId) {
        nodeByKey.clear(); // different agent → its keys don't carry over
        lastRenderedAgentId = state.selectedAgentId;
      }
      if (state.repair) {
        transcript.replaceChildren(repairCard(state.repair));
        nodeByKey.clear();
        clearLivenessClock();
        return;
      }
      if (!state.selectedAgentId) {
        transcript.replaceChildren(empty('No agents yet.'));
        nodeByKey.clear();
        clearLivenessClock();
        return;
      }
      const stick = shouldAutoScroll(isNearBottom());
      const items = coalesceReadToolRuns(state.messages || []);
      const seen = new Set();
      const ordered = [];
      let insertedNewNode = false;
      // Mark every known item as retained before mounting. A later state render restores the exact
      // expanded card rather than rebuilding it.
      for (const m of items) seen.add(itemKey(m));
      for (const m of items) {
        const key = itemKey(m);
        seen.add(key);
        let node;
        const cached = nodeByKey.get(key);
        if (m.live) {
          // The streaming element is owned by the delta path (#live-message / #live-reasoning) — reuse it
          // so in-flight tokens aren't clobbered by a state update.
          const liveId = m.kind === 'reasoning' ? 'live-reasoning' : 'live-message';
          node = document.getElementById(liveId) || cached || renderMessage(m);
        } else {
          node = cached || renderMessage(m); // immutable items: reuse, never rebuild
        }
        if (!cached && !node.isConnected) insertedNewNode = true;
        nodeByKey.set(key, node);
        ordered.push(node);
      }
      for (const key of Array.from(nodeByKey.keys())) {
        if (!seen.has(key)) nodeByKey.delete(key);
      }
      // Move the (reused or new) nodes into order in one pass; only brand-new items are constructed.
      const frag = document.createDocumentFragment();
      for (const n of ordered) frag.appendChild(n);
      transcript.replaceChildren(frag);

      const liveness = currentLiveness(items);
      if (liveness) {
        transcript.appendChild(livenessIndicator(liveness));
        insertedNewNode = true;
      } else if (!items.length) {
        const sel = selectedAgent();
        const solo = (state.agents || []).find((a) => a.role === 'solo');
        if (sel && sel.role === 'pm' && solo && solo.id !== sel.id) {
          transcript.appendChild(pmSoloHint(solo.id));
        } else {
          transcript.appendChild(empty('No messages with this agent yet.'));
        }
        insertedNewNode = true;
      }
      if (stick) {
        scheduleBottomSettle(insertedNewNode);
      }
      syncLivenessClock();
    }

    function coalesceReadToolRuns(items) {
      const out = [];
      let run = [];
      const flush = () => {
        if (run.length === 1) {
          out.push(run[0]);
        } else if (run.length > 1) {
          const first = run[0];
          const last = run[run.length - 1];
          out.push({
            kind: 'toolGroup',
            key: String(first.seq ?? first.id) + ':' + String(last.seq ?? last.id) + ':' + run.map((t) => t.id + ':' + t.phase + ':' + t.ok + ':' + String(t.completedAt || '')).join('|'),
            seq: first.seq,
            ts: first.ts,
            category: first.category,
            tools: run,
          });
        }
        run = [];
      };
      for (const item of items || []) {
        if (isCoalescableTool(item)) {
          if (run.length && run[0].category !== item.category) {
            flush();
          }
          run.push(item);
        } else {
          flush();
          out.push(item);
        }
      }
      flush();
      return out;
    }

    function isCoalescableTool(item) {
      return item &&
        item.kind === 'tool' &&
        (item.category === 'read' || item.category === 'list' || item.category === 'edit' || item.category === 'run') &&
        item.phase !== 'use' &&
        item.ok !== false;
    }

    function toolGroupTitle(tools) {
      const counts = new Map();
      for (const tool of tools || []) {
        counts.set(tool.name, (counts.get(tool.name) || 0) + 1);
      }
      const category = tools && tools[0] ? tools[0].category : '';
      if (category === 'edit') {
        return 'Changed ' + tools.length + ' item' + (tools.length === 1 ? '' : 's');
      }
      if (category === 'run') {
        return 'Ran ' + tools.length + ' command' + (tools.length === 1 ? '' : 's');
      }
      if (category === 'list') {
        const folders = counts.get('list_dir') || 0;
        const agents = counts.get('list_agents') || 0;
        const parts = [];
        if (folders) parts.push(folders + ' folder' + (folders === 1 ? '' : 's'));
        if (agents) parts.push(agents + ' teammate' + (agents === 1 ? '' : 's'));
        for (const [name, count] of counts.entries()) {
          if (name === 'list_dir' || name === 'list_agents') continue;
          parts.push(count + ' ' + name);
        }
        return 'Listed ' + (parts.length ? parts.join(', ') : ((tools || []).length + ' items'));
      }
      const parts = [];
      const files = counts.get('read_file') || 0;
      const folders = counts.get('list_dir') || 0;
      if (files) parts.push(files + ' file' + (files === 1 ? '' : 's'));
      if (folders) parts.push(folders + ' folder' + (folders === 1 ? '' : 's'));
      for (const [name, count] of counts.entries()) {
        if (name === 'read_file' || name === 'list_dir') continue;
        parts.push(count + ' ' + name);
      }
      return 'Read ' + (parts.length ? parts.join(', ') : ((tools || []).length + ' items'));
    }

    // Kept as a small compatibility seam for existing transcript tests and read-only groups.
    function readGroupTitle(tools) {
      return toolGroupTitle(tools);
    }

    // A duration is a measured pair, never a value inferred from when this DOM node happened to render. The time
    // people took to decide while the call was open is in that pair and in no clock: the duration leaves it out and
    // the card names it, as the turn's footer does.
    function measuredToolTiming(tool) {
      const startedMs = Date.parse(String(tool && tool.ts || ''));
      const completedMs = Date.parse(String(tool && tool.completedAt || ''));
      if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) return undefined;
      const humanWaitMs = Math.min(completedMs - startedMs, Math.max(0, Number(tool.humanWaitMs) || 0));
      return {
        startedAt: tool.ts, completedAt: tool.completedAt, durationMs: completedMs - startedMs - humanWaitMs,
        ...(humanWaitMs > 0 ? { humanWaitMs } : {}),
      };
    }

    function formatMeasuredDuration(durationMs) {
      return (Math.max(0, durationMs) / 1000).toFixed(1) + 's';
    }

    function humanWaitText(timing) {
      return timing.humanWaitMs ? ' · human approval ' + formatMeasuredDuration(timing.humanWaitMs) + ' excluded' : '';
    }

    function measuredToolGroupTiming(tools) {
      const timings = (tools || []).map(measuredToolTiming);
      if (!timings.length || timings.some((timing) => !timing)) return { complete: false };
      const startedMs = Math.min(...timings.map((timing) => Date.parse(timing.startedAt)));
      const completedMs = Math.max(...timings.map((timing) => Date.parse(timing.completedAt)));
      const spanMs = Math.max(0, completedMs - startedMs);
      // Waits of calls that ran one after another add up. Calls that overlapped may have waited on the same decision,
      // so only the longest of their waits is certain to be in the span once.
      const ordered = [...timings].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
      const sequential = ordered.every((timing, index) => index === 0
        || Date.parse(timing.startedAt) >= Date.parse(ordered[index - 1].completedAt));
      const waits = timings.map((timing) => timing.humanWaitMs || 0);
      const humanWaitMs = Math.min(spanMs, sequential ? waits.reduce((sum, wait) => sum + wait, 0) : Math.max(...waits));
      return { complete: true, spanMs: spanMs - humanWaitMs, ...(humanWaitMs > 0 ? { humanWaitMs } : {}) };
    }

    const TOOL_ICON_BY_NAME = {
      read_file: { codicon: 'file', fallback: '▤' },
      list_dir: { codicon: 'folder', fallback: '□' },
      list_agents: { codicon: 'organization', fallback: '♙' },
      write_file: { codicon: 'new-file', fallback: '+' },
      apply_edit: { codicon: 'edit', fallback: '✎' },
      apply_patch: { codicon: 'edit', fallback: '✎' },
      delete_file: { codicon: 'trash', fallback: '×' },
      delete_dir: { codicon: 'trash', fallback: '×' },
      search_files: { codicon: 'search', fallback: '⌕' },
      fetch_url: { codicon: 'globe', fallback: '◎' },
      run_command: { codicon: 'terminal', fallback: '›_' },
      check_command: { codicon: 'clock', fallback: '◷' },
      kill_command: { codicon: 'debug-stop', fallback: '■' },
      run_checks: { codicon: 'beaker', fallback: '✓' },
      assign_task: { codicon: 'organization', fallback: '⇄' },
      assign_task_async: { codicon: 'organization', fallback: '⇄' },
      await_tasks: { codicon: 'clock', fallback: '◷' },
      broadcast: { codicon: 'broadcast', fallback: '↗' },
      send_message: { codicon: 'comment-discussion', fallback: '◌' },
      memory_note: { codicon: 'notebook', fallback: '▧' },
      load_skill: { codicon: 'book', fallback: '▤' },
      read_skill_file: { codicon: 'book', fallback: '▤' },
      update_todos: { codicon: 'checklist', fallback: '☑' },
      Read: { codicon: 'file', fallback: '▤' },
      Write: { codicon: 'new-file', fallback: '+' },
      Edit: { codicon: 'edit', fallback: '✎' },
      Bash: { codicon: 'terminal', fallback: '›_' },
      Agent: { codicon: 'organization', fallback: '⇄' },
      ToolSearch: { codicon: 'search', fallback: '⌕' },
    };
    const TOOL_ICON_BY_CATEGORY = {
      read: { codicon: 'file', fallback: '▤' },
      edit: { codicon: 'edit', fallback: '✎' },
      run: { codicon: 'terminal', fallback: '›_' },
      mcp: { codicon: 'plug', fallback: '◌' },
      tool: { codicon: 'tools', fallback: '◆' },
    };
    const TOOL_ICON_FALLBACK = { codicon: 'tools', fallback: '◆' };

    function toolIconSpec(tool) {
      return TOOL_ICON_BY_NAME[tool && tool.name] || TOOL_ICON_BY_CATEGORY[tool && tool.category] || TOOL_ICON_FALLBACK;
    }

    function toolIcon(tool) {
      const spec = toolIconSpec(tool);
      const node = document.createElement('span');
      node.className = 'tool-icon codicon codicon-' + spec.codicon;
      node.dataset.codicon = '$(' + spec.codicon + ')';
      node.dataset.fallback = spec.fallback;
      node.title = '$(' + spec.codicon + ')';
      node.setAttribute('aria-label', node.title);
      return node;
    }

    let livenessTimer;
    const delegationStalledAfterMs = ${DELEGATION_STALLED_AFTER_MS};

    function elapsedSeconds(startedAt) {
      const started = Date.parse(String(startedAt || ''));
      if (!Number.isFinite(started)) return 0;
      return Math.max(0, Math.floor((Date.now() - started) / 1000));
    }

    function elapsedNode(startedAt) {
      const node = document.createElement('span');
      node.className = 'elapsed';
      node.dataset.elapsedStart = String(startedAt || '');
      node.textContent = elapsedSeconds(startedAt) + 's';
      return node;
    }

    function updateLivenessClock() {
      for (const node of transcript.querySelectorAll('[data-elapsed-start]')) {
        node.textContent = elapsedSeconds(node.dataset.elapsedStart) + 's';
      }
      for (const node of transcript.querySelectorAll('[data-delegation-live="true"]')) {
        node.textContent = delegationLiveStatus({
          startedAt: node.dataset.startedAt,
          updatedAt: node.dataset.updatedAt,
          stepCount: Number(node.dataset.stepCount || 0),
          waitingOn: node.dataset.waitingOn || '',
        });
      }
    }

    function clearLivenessClock() {
      if (livenessTimer !== undefined) {
        clearInterval(livenessTimer);
        livenessTimer = undefined;
      }
    }

    function syncLivenessClock() {
      const hasLiveness = !!document.getElementById('thinking-indicator')
        || !!transcript.querySelector('[data-delegation-live="true"]');
      if (hasLiveness && !(typeof document !== 'undefined' && document.hidden)) {
        updateLivenessClock();
        if (livenessTimer === undefined) {
          livenessTimer = setInterval(updateLivenessClock, 1000);
        }
      } else {
        clearLivenessClock();
      }
    }

    function pendingTool(items) {
      for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index];
        if (item && item.kind === 'tool' && item.phase === 'use') return item;
      }
      return undefined;
    }

    function currentLiveness(items) {
      const agentId = state.selectedAgentId;
      if (!agentId) return undefined;
      // A coordinator that has dispatched is idle on purpose: it ended its turn and the work is elsewhere.
      // Nothing was rendered for that state, so a crew hard at work looked exactly like a crew that stopped.
      if (!state.runningAgentIds.includes(agentId)) {
        const out = (state.delegatingOut || {})[agentId] || [];
        return out.length > 0 ? { delegations: out } : undefined;
      }
      // The phase is the host's observation. Nothing here infers one from which events have reached the view.
      const phase = state.turnPhases && state.turnPhases[agentId];
      // Both clocks count what the finished turn will report: the time a person takes to decide is in neither,
      // so the turn clock stands still while a decision is open and the phase clock resumes where it stopped.
      const turnStartedAt = phase
        ? clockStart(phase, phase.activeMs, phase.turnStartedAt)
        : (state.turnStartedAt && state.turnStartedAt[agentId]);
      const phaseStartedAt = phase ? clockStart(phase, phase.phaseActiveMs, phase.phaseStartedAt) : undefined;
      if (phase && phase.approvalPending) {
        return {
          label: 'Waiting for your approval',
          startedAt: phase.approvalStartedAt || phase.phaseStartedAt,
          turnPausedMs: Number(phase.activeMs) || 0,
        };
      }
      const tool = pendingTool(items);
      if (phase && phase.phase === 'tool') {
        // The time beside the label is the host's tool phase, not a card's own start, which would count a
        // decision the person made inside the call. A tool is named only when that time is its own: one call
        // in this tool phase. When calls overlapped the time belongs to none of them, and the line says so.
        const label = phase.phaseToolCalls === 1
          ? (tool ? 'Running ' + toolTarget(tool) : 'Running a tool')
          : 'Tool work, ' + phase.openTools + (phase.openTools === 1 ? ' call open' : ' calls open');
        return { label, startedAt: phaseStartedAt, turnStartedAt };
      }
      if (phase) {
        return { label: turnPhaseLabel(phase), startedAt: phaseStartedAt, turnStartedAt };
      }
      // No phase has been reported for this turn yet: the card is all there is to go by.
      if (tool) {
        return { label: 'Running ' + toolTarget(tool), startedAt: tool.ts, turnStartedAt };
      }
      const sel = selectedAgent();
      // No phase has been reported for this turn yet. 'Working' claims nothing about the model.
      const label = sel && sel.backend === 'claude' && sel.status === 'starting'
        ? 'Starting Claude…'
        : 'Working';
      return { label, startedAt: turnStartedAt, turnStartedAt };
    }

    // Silence after a request is a wait for the provider. It is never labelled as thinking: the host shows
    // reasoning only when the provider sent a reasoning event.
    function turnPhaseLabel(phase) {
      if (phase.phase === 'provider-wait') return 'Waiting for ' + (phase.provider || 'the provider');
      if (phase.phase === 'reasoning') return 'Reasoning';
      if (phase.phase === 'responding') return 'Responding';
      return 'Preparing the request';
    }

    function toolTarget(tool) {
      const title = String(tool.title || tool.name);
      return tool.category === 'run' ? title.replace(/^Run\\s+/, '') : title;
    }

    // The instant a clock would have started to show a time the host reported now: the host gave that time as
    // of one instant, and it has grown by the time since.
    function clockStart(phase, activeMs, fallback) {
      const observedAt = Date.parse(String(phase.observedAt || ''));
      if (!Number.isFinite(observedAt) || typeof activeMs !== 'number') return fallback;
      return new Date(observedAt - activeMs).toISOString();
    }

    function markStreamedRunning(msg) {
      if (!state.runningAgentIds.includes(msg.agentId)) {
        state.runningAgentIds.push(msg.agentId);
      }
      if (msg.turnStartedAt) {
        state.turnStartedAt = state.turnStartedAt || {};
        state.turnStartedAt[msg.agentId] = msg.turnStartedAt;
      }
    }

    function ensureLivenessTail() {
      if (document.getElementById('thinking-indicator')) return;
      const liveness = currentLiveness(coalesceReadToolRuns(state.messages || []));
      if (liveness) transcript.appendChild(livenessIndicator(liveness));
    }

    function livenessIndicator(liveness) {
      const node = document.createElement('div');
      node.className = 'thinking';
      node.id = 'thinking-indicator';
      if (liveness.delegations) {
        // One clock per teammate on one line. The shared ticker already updates every [data-elapsed-start]
        // node in the transcript, so several run without any new timing machinery.
        liveness.delegations.forEach((delegation, index) => {
          if (index > 0) {
            const separator = document.createElement('span');
            separator.className = 'thinking-label';
            separator.textContent = '; ';
            node.appendChild(separator);
          }
          const who = document.createElement('span');
          who.className = 'thinking-label';
          who.textContent = 'delegating to ' + delegation.agentName + ', ';
          node.append(who, elapsedNode(delegation.startedAt));
        });
        const dots = document.createElement('span');
        dots.className = 'dots';
        dots.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
        node.appendChild(dots);
        return node;
      }
      const label = document.createElement('span');
      label.className = 'thinking-label';
      label.textContent = liveness.label + ' – ';
      const dots = document.createElement('span');
      dots.className = 'dots';
      dots.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
      node.append(label, elapsedNode(liveness.startedAt));
      // The phase clock restarts at each phase; the turn clock beside it never does. While a person is deciding
      // it shows the turn time reached so far and does not move.
      if (typeof liveness.turnPausedMs === 'number') {
        const turn = document.createElement('span');
        turn.className = 'thinking-label';
        turn.textContent = ' · turn ' + Math.floor(liveness.turnPausedMs / 1000) + 's (paused)';
        node.appendChild(turn);
      } else if (liveness.turnStartedAt && liveness.turnStartedAt !== liveness.startedAt) {
        const turn = document.createElement('span');
        turn.className = 'thinking-label';
        turn.textContent = ' · turn ';
        node.append(turn, elapsedNode(liveness.turnStartedAt));
      }
      node.appendChild(dots);
      return node;
    }

    // A running card counts what the turn's clocks count. While a person decides on the only call in flight the card
    // says so instead of counting, and when that call is the tool phase's only one its time is the host's phase
    // time, which leaves the decision out. Calls that overlap each count their own span.
    function fillRunningToolState(stateNode, tool) {
      const phase = state.turnPhases && state.turnPhases[state.selectedAgentId];
      const running = (state.messages || []).filter((item) => item && item.kind === 'tool' && item.phase === 'use');
      const alone = !!phase && phase.phase === 'tool' && phase.openTools === 1 && phase.phaseToolCalls === 1
        && running.length === 1;
      stateNode.dataset.runningTool = String(tool.id);
      stateNode.replaceChildren();
      if (alone && phase.approvalPending) {
        stateNode.textContent = 'Waiting for your approval';
        return;
      }
      stateNode.append('Running – ', elapsedNode(alone ? clockStart(phase, phase.phaseActiveMs, tool.ts) : tool.ts));
    }

    // The host's phase for one agent's turn changed. Only the selected agent's live line is on screen.
    function setTurnPhase(msg) {
      state.turnPhases = state.turnPhases || {};
      if (msg.turnPhase) state.turnPhases[msg.agentId] = msg.turnPhase;
      else delete state.turnPhases[msg.agentId];
      if (msg.agentId !== state.selectedAgentId) return;
      // A new line can be taller than the one it replaces. A reader at the bottom stays there.
      const wasNearBottom = isNearBottom();
      const tail = document.getElementById('thinking-indicator');
      if (tail) tail.remove();
      ensureLivenessTail();
      for (const stateNode of transcript.querySelectorAll('[data-running-tool]')) {
        const tool = (state.messages || []).find((item) => item && item.kind === 'tool' && item.phase === 'use'
          && String(item.id) === stateNode.dataset.runningTool);
        if (tool) fillRunningToolState(stateNode, tool);
      }
      if (shouldAutoScroll(wasNearBottom)) pinTranscriptToBottom('auto');
      syncLivenessClock();
    }

    function empty(text) {
      const node = document.createElement('div');
      node.className = 'empty';
      node.textContent = text;
      return node;
    }

    function repairCard(kind) {
      // The host owns this copy so the visible repair and its polite announcement cannot drift.
      const copy = state.repairCopy;
      if (!copy) return empty('Finish setup before sending a task.');
      const card = document.createElement('section');
      card.className = 'repair';
      const title = document.createElement('h2');
      title.textContent = copy.title;
      const detail = document.createElement('p');
      detail.textContent = copy.detail;
      const action = document.createElement('button');
      action.type = 'button';
      action.textContent = copy.action;
      action.addEventListener('click', () => vscode.postMessage({ command: 'repairAction', kind }));
      card.append(title, detail, action);
      return card;
    }

    // First-run nudge shown in the PM's empty chat: the PM orchestrates the whole crew, so for a quick
    // one-off the user can go straight to the standalone Solo agent instead. Deterministic UI (no tokens),
    // with a one-click switch to Solo.
    function pmSoloHint(soloId) {
      const node = document.createElement('div');
      node.className = 'empty pm-hint';
      const base = document.createElement('div');
      base.textContent = 'No messages with the Project Manager yet.';
      const hint = document.createElement('div');
      hint.className = 'solo-hint';
      const tip = document.createElement('div');
      tip.textContent = '💡 The PM orchestrates the whole crew (delegate → review → verify). For a quick, single-file task, message the Solo agent directly instead — one generalist, no delegation overhead.';
      const btn = document.createElement('button');
      btn.className = 'solo-hint-btn';
      btn.type = 'button';
      btn.textContent = 'Switch to Solo';
      btn.addEventListener('click', () => {
        vscode.postMessage({ command: 'selectAgent', agentId: soloId });
      });
      hint.appendChild(tip);
      hint.appendChild(btn);
      node.appendChild(base);
      node.appendChild(hint);
      return node;
    }

    function copyButton(text) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy-msg';
      btn.title = 'Copy reply';
      btn.textContent = '⧉'; // icon-only to save space
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = '✓';
          setTimeout(() => { btn.textContent = '⧉'; }, 1200);
        });
      });
      return btn;
    }

    function selectedAgent() {
      return (state.agents || []).find((agent) => agent.id === state.selectedAgentId);
    }

    function renderMessage(message) {
      if (message.kind === 'tool') {
        return renderTool(message);
      }
      if (message.kind === 'toolGroup') {
        return renderToolGroup(message);
      }
      if (message.kind === 'reasoning') {
        return renderReasoning(message);
      }
      if (message.kind === 'delegation') {
        return renderDelegation(message);
      }
      if (message.kind === 'jobOutcome') {
        return renderJobOutcome(message);
      }
      if (message.kind === 'contextManifest') {
        return renderContextManifest(message);
      }
      if (message.kind === 'soloSuggestion') {
        return renderSoloSuggestion(message);
      }
      if (message.kind === 'marker') {
        const marker = document.createElement('div');
        marker.className = 'marker';
        marker.textContent = message.text;
        return marker;
      }
      const node = document.createElement('div');
      // Only the reply the host marked as ending a turn is its conclusion. Text flushed before each tool call is a
      // finalized message too, but it is a working step: styling every finalized message as an answer is exactly
      // what made the end of a turn unfindable (v0.9.87 field step R4). Rows written before v0.9.88 carry no
      // marker; a recorded turn timing was only ever attached to a terminal reply, so it identifies them.
      const endsTurn = message.role === 'agent' && !message.live && !message.runtimeNotice
        && (message.turnFinal === true || isRecordedTurnTiming(message.turnTiming));
      const isConclusion = endsTurn && !message.isError && !!message.text;
      node.className = 'msg ' + (message.role === 'user' ? 'user' : 'agent')
        + (message.isError ? ' error' : '') + (isConclusion ? ' conclusion' : '');
      if (isConclusion) {
        node.setAttribute('role', 'group');
        node.setAttribute('aria-label', 'Conclusion');
      }
      // No per-message name header: right-aligned bubble = you, left-aligned = the agent you're chatting
      // with. The identity is already clear from alignment, so we save that whole line.
      if (message.role === 'agent' && message.live) {
        node.id = 'live-message';
        node.appendChild(renderLiveBlocks(message.blocks || [], 'liveBody'));
      } else if (message.role === 'agent') {
        // Copy button (top-right) so a finalized agent reply can be copied and relayed.
        if (message.text) {
          node.appendChild(copyButton(message.text));
        }
        node.appendChild(renderBlocks(message.blocks || []));
        if (message.compactionSummary) {
          // A compaction receipt's summary: collapsed, and labelled as the model's words rather than evidence.
          const details = document.createElement('details');
          details.className = 'compaction-summary';
          const label = document.createElement('summary');
          label.textContent = 'What the agent now remembers (a model-written summary, not evidence)';
          const text = document.createElement('div');
          text.className = 'body';
          text.textContent = message.compactionSummary;
          details.append(label, text);
          node.appendChild(details);
        }
        if (endsTurn) {
          const footer = renderTurnFooter(message);
          if (footer) node.appendChild(footer);
        }
      } else {
        const body = document.createElement('div');
        body.className = 'body';
        body.textContent = message.text;
        node.appendChild(body);
        if (message.attachments && message.attachments.length) {
          node.appendChild(renderMessageAttachments(message.attachments));
        }
      }
      return node;
    }

    function renderMessageAttachments(attachments) {
      const wrap = document.createElement('div');
      wrap.className = 'message-attachments';
      for (const attachment of attachments || []) {
        wrap.appendChild(renderAttachmentChip(attachment));
      }
      return wrap;
    }

    /**
     * One footer per turn, in a fixed order, each line only when the host recorded it. Nothing is ever shown as
     * "not recorded": an absent fact is simply absent. Each fact is its own line, so no decorative separator sits
     * between them.
     */
    function renderTurnFooter(message) {
      const lines = [];
      if (message.turnTrigger) lines.push(formatTurnTrigger(message.turnTrigger));
      if (message.delegationReceipt) lines.push(formatDelegationReceipt(message.delegationReceipt));
      if (isRecordedTurnTiming(message.turnTiming)) {
        lines.push(formatTurnTiming(message.turnTiming));
        // A turn recorded before phases existed has no such line: not recorded is never shown as zero.
        const phases = formatTurnTimingPhases(message.turnTiming.phases);
        if (phases) lines.push(phases);
      }
      if (!lines.length) return undefined;
      const footer = document.createElement('div');
      footer.className = 'turn-footer';
      for (const line of lines) {
        const row = document.createElement('div');
        row.textContent = line;
        footer.appendChild(row);
      }
      return footer;
    }

    function isRecordedTurnTiming(timing) {
      return !!timing && typeof timing === 'object' && typeof timing.durationMs === 'number';
    }

    // Why the host started this turn on its own. Several results in one wake are named, never one picked at random.
    function formatTurnTrigger(trigger) {
      const sources = trigger.sources || [];
      const total = sources.length + (trigger.more || 0);
      if (total === 1) {
        const only = sources[0];
        return 'Triggered by ' + only.agentName + (only.reason === 'rework-reply' ? "'s rework reply" : "'s result");
      }
      if (total === 2) return 'Triggered by results from ' + sources[0].agentName + ' and ' + sources[1].agentName;
      return 'Triggered by ' + total + ' results (' + sources[0].agentName + ', ' + sources[1].agentName
        + ', +' + (total - 2) + ' more)';
    }

    // The v0.9.80 B1 wording: shown on every coordinator turn, including 0 accepted · 0 refused.
    function formatDelegationReceipt(receipt) {
      return 'Delegations this turn: ' + receipt.accepted + ' accepted · ' + receipt.refused + ' refused'
        + (receipt.pending > 0 ? ' · ' + receipt.pending + ' pending' : '') + '.';
    }

    function formatTurnTiming(timing) {
      const finished = formatTurnFinishedAt(timing.settledAt);
      const duration = formatTurnTimingDuration(timing.durationMs);
      const turnTime = !timing.approvalWaitMs
        ? 'Turn time: ' + duration
        : 'Turn time: ' + duration + ' · human approval: ' + formatTurnTimingDuration(timing.approvalWaitMs) + ' excluded';
      return finished ? 'Finished ' + finished + ' · ' + turnTime : turnTime;
    }

    // Where the turn time went, as the host observed it. A provider wait is only the absence of a later event.
    function formatTurnTimingPhases(phases) {
      if (!phases || typeof phases !== 'object' || typeof phases.providerWaitMs !== 'number') return '';
      const parts = [];
      const waits = Number(phases.providerWaitCount) || 0;
      parts.push('waiting for provider ' + formatTurnTimingDuration(phases.providerWaitMs)
        + (waits > 1 ? ' (' + waits + ' waits, longest ' + formatTurnTimingDuration(phases.longestProviderWaitMs) + ')' : ''));
      if (phases.reasoningMs > 0) parts.push('reasoning ' + formatTurnTimingDuration(phases.reasoningMs));
      if (phases.respondingMs > 0) parts.push('responding ' + formatTurnTimingDuration(phases.respondingMs));
      if (phases.toolMs > 0) parts.push('tools ' + formatTurnTimingDuration(phases.toolMs));
      if (phases.hostMs > 0) parts.push('host ' + formatTurnTimingDuration(phases.hostMs));
      if (phases.queuedMs > 0) parts.push('queued ' + formatTurnTimingDuration(phases.queuedMs));
      return 'Observed: ' + parts.join(' · ');
    }

    function formatTurnFinishedAt(settledAt) {
      const finished = new Date(settledAt);
      if (Number.isNaN(finished.getTime())) return '';
      const now = new Date();
      const time = finished.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const isToday = finished.getFullYear() === now.getFullYear()
        && finished.getMonth() === now.getMonth()
        && finished.getDate() === now.getDate();
      if (isToday) return time;
      const date = finished.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      return date + ' ' + time;
    }

    function formatTurnTimingDuration(ms) {
      const totalSeconds = Math.max(0, Math.round(Number(ms) / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return minutes ? minutes + 'm ' + seconds + 's' : seconds + 's';
    }

    function coordinatorDispositionLabel(disposition) {
      return disposition === 'accepted' ? 'Coordinator accepted'
        : disposition === 'rejected' ? 'Coordinator rejected — amended'
        : disposition === 'needs-human' ? 'Human intervention required'
        : disposition === 'needs-rework' ? 'Coordinator requested rework'
        : disposition === 'deferred' ? 'Coordinator deferred'
        : disposition === 'accepted-with-caveat' ? 'Coordinator accepted with caveat'
        : disposition === 'accepted-after-rework' ? 'Coordinator accepted after rework'
        : disposition === 'accepted-despite-framework-no-evidence' ? 'Coordinator accepted despite framework no-evidence'
        : disposition === 'superseded' ? 'Coordinator superseded task'
        : disposition === 'abandoned' ? 'Coordinator abandoned task'
        : '';
    }

    function coordinatorDispositionTask(item) {
      if (item.coordinatorDisposition === 'needs-rework' && item.reworkReplyAt) {
        return 'UnodeAi: ' + item.agentName + " replied to the PM's rework request. Ask the PM to review it.";
      }
      if (!item.coordinatorDisposition) return '';
      const label = coordinatorDispositionLabel(item.coordinatorDisposition);
      if (item.coordinatorDisposition === 'rejected') {
        return 'Amended from ' + (item.amendedFrom || 'earlier verdict') + ': ' + (item.dispositionReason || 'coordinator rejected the result');
      }
      const replacement = item.replacementHandle ? ' Replacement: ' + item.replacementHandle + '.' : '';
      return (item.dispositionReason ? label + ': ' + item.dispositionReason : label) + replacement;
    }

    function interruptionStatusLabel(item) {
      if (item.status !== 'interrupted') return '';
      const disposition = item.coordinatorDisposition ? coordinatorDispositionLabel(item.coordinatorDisposition) : '';
      return ['Interrupted — no active worker', disposition].filter(Boolean).join(' · ');
    }

    function interruptionTask(item) {
      if (item.status !== 'interrupted' || !item.interruption) return '';
      const facts = 'Reason: ' + item.interruption.reason
        + '. Last observed: ' + item.interruption.lastObservedAt
        + '. Detected: ' + item.interruption.detectedAt + '.';
      const disposition = coordinatorDispositionTask(item);
      return disposition ? facts + ' ' + disposition : facts;
    }

    function delegationStatusLabel(status) {
      return status === 'working' ? 'Working'
        : status === 'cancelled' ? 'Cancelled'
        : status === 'interrupted' ? 'Interrupted — no active worker'
        : status === 'blocked' ? 'Blocked'
        : status === 'verified' ? 'Verified'
        : status === 'no-applicable-sensor' ? 'No applicable verification sensor'
        : status === 'verification-failed' ? 'Verification failed'
        : status === 'tool-activity-recorded' ? 'Tool activity recorded; delivery not checked'
        : status === 'replied-not-verified' ? 'Replied, not verified'
        : status === 'no-evidence' ? 'No evidence'
        : status === 'required-input-read-not-observed' ? 'Required input read receipt not observed'
        : status === 'timed-out' ? 'Timed out waiting for teammate'
        : status === 'coordinator-accepted' ? 'Coordinator accepted'
        : status === 'coordinator-rejected' ? 'Coordinator rejected — amended'
        : status === 'human-intervention-required' ? 'Human intervention required'
        : status === 'done' ? 'Done'
        : 'Unknown';
    }

    function delegationMinutes(ms) {
      return ms < 60000 ? '<1 min' : Math.floor(ms / 60000) + ' min';
    }

    function delegationLiveStatus(item) {
      const started = Date.parse(String(item.startedAt || ''));
      const updated = Date.parse(String(item.updatedAt || item.startedAt || ''));
      const elapsed = Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
      const quiet = Number.isFinite(updated) ? Math.max(0, Date.now() - updated) : 0;
      return item.waitingOn
        ? 'Waiting on ' + item.waitingOn + ' · step ' + Number(item.stepCount || 0) + ' · ' + delegationMinutes(elapsed)
        : quiet >= delegationStalledAfterMs
        ? 'Stalled · no activity for ' + delegationMinutes(quiet)
        : !item.updatedAt && Number(item.stepCount || 0) === 0
          ? 'Assigned · ' + delegationMinutes(elapsed)
          : 'Working · step ' + Number(item.stepCount || 0) + ' · ' + delegationMinutes(elapsed);
    }

    function renderDelegation(summary) {
      const node = document.createElement('div');
      node.className = 'delegation-card';
      const head = document.createElement('div');
      head.className = 'delegation-head';

      const title = document.createElement('div');
      title.className = 'delegation-title';
      const needsEvidence = summary.closeoutCompletionState === 'partial' || (summary.items || []).some((item) =>
        item.completionState === 'partial' || item.taskState?.kind === 'context-gap' || item.status === 'interrupted' || item.status === 'replied-not-verified' || item.status === 'verification-failed' || item.status === 'no-evidence' || item.status === 'required-input-read-not-observed' || item.status === 'timed-out' || item.status === 'coordinator-rejected' || item.status === 'human-intervention-required'
      );
      const deliveryUnchecked = (summary.items || []).some((item) => item.status === 'tool-activity-recorded');
      title.appendChild(statusDot(summary.working > 0, deliveryUnchecked ? undefined : summary.blocked === 0 && (summary.cancelled ?? 0) === 0 && !needsEvidence));
      const titleText = document.createElement('span');
      titleText.textContent = summary.coordinatorName + ' ' + (summary.working > 0 ? 'delegating' : 'delegated') + ' to the crew';
      title.appendChild(titleText);

      const count = document.createElement('div');
      count.className = 'delegation-count';
      count.textContent = (summary.done || 0) + ' complete · ' + (summary.partial || 0) + ' partial · ' + (summary.blocked || 0) + ' blocked' + ((summary.cancelled ?? 0) > 0 ? ' · ' + summary.cancelled + ' cancelled' : '') + (summary.closeoutCompletionState === 'partial' ? ' · run partial' : '');
      head.append(title, count);

      const list = document.createElement('div');
      list.className = 'delegation-list';
      for (const item of summary.items || []) {
        const row = document.createElement('div');
        row.className = 'delegation-row';
        const agent = document.createElement('span');
        agent.className = 'delegation-agent';
        agent.textContent = item.agentName;
        const status = document.createElement('span');
        status.className = 'delegation-status ' + item.status + (item.completionState === 'partial' ? ' completion-partial' : '');
        if (item.status === 'working') {
          status.dataset.delegationLive = 'true';
          status.dataset.startedAt = item.startedAt || '';
          status.dataset.updatedAt = item.updatedAt || item.startedAt || '';
          status.dataset.stepCount = String(item.stepCount || 0);
          status.dataset.waitingOn = item.waitingOn || '';
        }
        const partialFacts = item.completionState === 'partial'
          ? [item.stopped ? 'Stopped' : 'Partial', item.evidenceOutcome ? delegationStatusLabel(item.evidenceOutcome) : '', item.coordinatorDisposition ? coordinatorDispositionLabel(item.coordinatorDisposition) : ''].filter(Boolean)
          : [];
        status.textContent = item.taskState?.kind === 'context-gap' ? 'Context gap · ' + item.taskState.reason
          : item.coordinatorDisposition === 'needs-rework' && item.reworkReplyAt ? 'Rework reply awaiting PM review'
          : partialFacts.length ? partialFacts.join(' · ')
          : item.status === 'working' ? delegationLiveStatus(item)
          : interruptionStatusLabel(item) || (item.coordinatorDisposition ? coordinatorDispositionLabel(item.coordinatorDisposition)
          : delegationStatusLabel(item.status));
        const task = document.createElement('span');
        task.className = 'delegation-task';
        const taskText = item.taskState?.kind === 'context-gap'
          ? 'Required input ' + item.taskState.inputId + ' (' + item.taskState.reason + '): ' + item.taskState.purpose + '.'
          : interruptionTask(item) || coordinatorDispositionTask(item) || (item.status === 'coordinator-rejected'
          ? 'Amended from ' + (item.amendedFrom || 'earlier verdict') + ': ' + (item.dispositionReason || 'coordinator rejected the result')
          : item.status === 'human-intervention-required'
            ? 'Human intervention required: ' + (item.dispositionReason || 'coordinator requested a human decision')
            : item.activity || item.instruction || '(no instruction)');
        const scopeText = item.scope
          ? (item.scopeMode === 'per-turn-enforced'
            ? (item.status === 'working' ? 'Temporary scope enforced: ' : 'Temporary scope ended: ')
            : 'Temporary scope requested (not yet host-confirmed): ') + item.scope
          : item.scopeMode === 'fixed-session-permissions'
            ? 'Fixed session permissions used (not task-level isolation)'
            : '';
        task.title = [taskText, scopeText].filter(Boolean).join(' — ');
        task.textContent = [taskText, scopeText].filter(Boolean).join(' — ');
        task.textContent = taskText;
        row.append(agent, status, task);
        if (scopeText) {
          const scope = document.createElement('span');
          scope.className = 'delegation-scope';
          scope.textContent = scopeText;
          scope.title = scope.textContent;
          row.appendChild(scope);
        }
        list.appendChild(row);
      }

      node.append(head, list);
      return node;
    }

    // Which outcome cards the person has opened. Kept by card id, so a card that is replaced because its facts
    // changed stays as it was: an update never closes, opens or focuses a card.
    const expandedJobOutcomes = new Set();

    function jobOutcomeTone(tone) {
      return tone === 'positive' || tone === 'caution' || tone === 'negative' ? tone : 'neutral';
    }

    // The card renders the host's view and nothing else: every word, state and action comes in that value.
    // Nothing here decides whether a job is complete, verified or unfinished.
    function renderJobOutcome(item) {
      const view = item.view || {};
      const node = document.createElement('section');
      node.className = 'job-outcome' + (view.available ? '' : ' unavailable');
      node.setAttribute('role', 'group');
      node.setAttribute('aria-label', 'Job outcome, host-observed');
      const details = document.createElement('details');
      details.open = expandedJobOutcomes.has(item.id);
      details.addEventListener('toggle', () => {
        if (details.open) expandedJobOutcomes.add(item.id);
        else expandedJobOutcomes.delete(item.id);
      });
      const summary = document.createElement('summary');
      const label = document.createElement('span');
      label.className = 'job-outcome-label';
      label.textContent = 'Job outcome';
      const badge = document.createElement('span');
      badge.className = 'job-outcome-badge';
      badge.textContent = 'Host-observed';
      const line = document.createElement('span');
      line.className = 'job-outcome-line';
      const segments = Array.isArray(view.headline) ? view.headline : [];
      segments.forEach((segment, index) => {
        if (index > 0) line.appendChild(document.createTextNode(' · '));
        const part = document.createElement('span');
        part.className = 'job-outcome-segment tone-' + jobOutcomeTone(segment && segment.tone);
        part.textContent = String((segment && segment.text) || '');
        line.appendChild(part);
      });
      summary.append(label, badge, line);
      summary.setAttribute('aria-label', 'Job outcome, host-observed. '
        + segments.map((segment) => String((segment && segment.text) || '')).join(', ') + '. Show details');
      const body = document.createElement('div');
      body.className = 'job-outcome-body';
      const actions = Array.isArray(view.actions) ? view.actions : [];
      for (const section of Array.isArray(view.sections) ? view.sections : []) {
        const block = document.createElement('div');
        block.className = 'job-outcome-section';
        const title = document.createElement('div');
        title.className = 'job-outcome-section-title';
        title.textContent = String(section.title || '');
        block.appendChild(title);
        const rowsData = Array.isArray(section.rows) ? section.rows : [];
        if (rowsData.length) {
          const rows = document.createElement('dl');
          rows.className = 'job-outcome-rows';
          for (const row of rowsData) {
            const name = document.createElement('dt');
            name.textContent = String(row.label || '');
            const value = document.createElement('dd');
            value.className = 'tone-' + jobOutcomeTone(row.tone);
            // The host states an instant in UTC. This view is on the person's machine, so it shows that instant
            // in local time and names the zone; the UTC text an exported report carries stays one hover away.
            const localInstant = row.instant ? formatLocalInstant(row.instant) : '';
            value.textContent = localInstant || String(row.value || '');
            if (localInstant) value.title = String(row.value || '') + ' (UTC)';
            rows.append(name, value);
          }
          block.appendChild(rows);
        }
        const itemsData = Array.isArray(section.items) ? section.items : [];
        if (itemsData.length) {
          const list = document.createElement('ul');
          list.className = 'job-outcome-items';
          for (const entry of itemsData) {
            const row = document.createElement('li');
            row.textContent = String(entry);
            list.appendChild(row);
          }
          block.appendChild(list);
        }
        if (section.note) {
          const note = document.createElement('div');
          note.className = 'job-outcome-note';
          note.textContent = String(section.note);
          block.appendChild(note);
        }
        const offered = actions.filter((action) => action && action.section === section.title);
        if (offered.length) {
          const bar = document.createElement('div');
          bar.className = 'job-outcome-actions';
          for (const action of offered) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = String(action.label || '');
            button.title = String(action.title || '');
            button.addEventListener('click', () => vscode.postMessage({
              command: 'jobOutcomeAction', outcomeId: item.id, action: action.id,
            }));
            bar.appendChild(button);
          }
          block.appendChild(bar);
        }
        body.appendChild(block);
      }
      details.append(summary, body);
      node.appendChild(details);
      return node;
    }

    function renderContextManifest(item) {
      const manifest = item.manifest || {};
      const node = document.createElement('details');
      node.className = 'context-manifest';
      const summary = document.createElement('summary');
      const count = Number(manifest.sourceCount || 0);
      const tokens = Number(manifest.estimatedTextTokens || 0);
      // "Attached", not "Context": this number never included the conversation, the system prompt, or the
      // tool definitions, and read as the whole turn's context beside an overflow error that contradicted it.
      summary.textContent = 'Attached context: ' + count + ' source' + (count === 1 ? '' : 's')
        + ' · ~' + tokens.toLocaleString() + ' text tokens (estimate, attached sources only)';
      summary.setAttribute('aria-label', summary.textContent + '. Show context source breakdown');
      const body = document.createElement('div');
      body.className = 'context-manifest-body';
      const note = document.createElement('p');
      note.className = 'context-manifest-note';
      note.textContent = manifest.tokenEstimateLabel
        || 'Attached sources only — the conversation, system prompt, and tool definitions are not counted here. '
          + 'Text token estimate is derived from bytes; non-text sources are excluded.';
      const list = document.createElement('div');
      list.className = 'context-manifest-list';
      for (const entry of manifest.entries || []) {
        const row = document.createElement('div');
        row.className = 'context-entry';
        const title = document.createElement('div');
        title.className = 'context-entry-title';
        title.textContent = String(entry.label || 'Context source');
        const metrics = document.createElement('div');
        metrics.className = 'context-entry-meta';
        const tokenText = entry.estimatedTokens === undefined
          ? 'token estimate unavailable'
          : '~' + entry.estimatedTokens + ' tokens (estimate)';
        metrics.textContent = String(entry.bytes || 0) + ' bytes · ' + tokenText;
        const from = document.createElement('div');
        from.className = 'context-entry-meta';
        from.textContent = 'From: ' + String(entry.location || 'unknown') + ' · Why: ' + String(entry.reason || 'not recorded');
        const sourceFacts = document.createElement('div');
        sourceFacts.className = 'context-entry-meta';
        const staleness = entry.staleness === 'unchanged-90-days-or-more'
          ? 'unchanged for ' + String(entry.ageDays ?? '90+') + ' days (filesystem fact; not a correctness judgement)'
          : entry.staleness === 'modified-within-90-days'
            ? 'modified ' + String(entry.ageDays ?? 0) + ' days ago (filesystem fact)'
            : 'unavailable (not a workspace file source)';
        const sensitivity = entry.sensitivity === 'potentially-sensitive'
          ? 'possible — ' + (Array.isArray(entry.sensitivitySignals) ? entry.sensitivitySignals.join('; ') : 'mechanical signal')
          : entry.sensitivity === 'no-mechanical-signal'
            ? 'no mechanical signal'
            : 'unavailable (not a workspace file source)';
        sourceFacts.textContent = 'Staleness: ' + staleness + ' · Sensitivity: ' + sensitivity;
        row.append(title, metrics, from, sourceFacts);
        list.appendChild(row);
      }
      body.append(note, list);
      node.append(summary, body);
      return node;
    }

    function renderSoloSuggestion(item) {
      const node = document.createElement('section');
      node.className = 'solo-suggestion';
      const title = document.createElement('div');
      title.className = 'solo-suggestion-title';
      title.textContent = 'This fits Solo better.';
      const copy = document.createElement('div');
      copy.className = 'solo-suggestion-copy';
      copy.textContent = 'It names one file and no parallel work. Send a direct copy to Solo? The PM keeps working unless you stop it.';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Send to Solo';
      button.addEventListener('click', () => vscode.postMessage({ command: 'handoffToSolo', id: item.id }));
      node.append(title, copy, button);
      return node;
    }

    function statusDot(running, ok) {
      const dot = document.createElement('span');
      dot.className = 'dot ' + (running ? 'running' : (ok === false ? 'err' : (ok === undefined ? 'unknown' : 'ok')));
      return dot;
    }

    function renderReasoning(item) {
      const node = document.createElement('details');
      node.className = 'reasoning';
      if (item.live) {
        node.id = 'live-reasoning';
        node.open = true;
      }
      const summary = document.createElement('summary');
      summary.appendChild(statusDot(!!item.live, true));
      const label = document.createElement('span');
      label.textContent = item.live ? 'Analyzing' : 'Analysis';
      summary.appendChild(label);
      const body = document.createElement('div');
      body.className = 'reasoning-body';
      body.dataset.reasonBody = 'true';
      if (item.live) {
        body.appendChild(renderLiveBlocks(item.blocks || [], 'reasonBlocks'));
      } else if (item.blocks && item.blocks.length) {
        body.appendChild(renderBlocks(item.blocks));
      } else {
        body.textContent = item.text;
      }
      node.append(summary, body);
      return node;
    }

    function renderTool(tool) {
      const node = document.createElement('div');
      const failureKind = tool.ok === false ? (tool.failureKind || 'error') : undefined;
      const blocked = failureKind === 'blocked';
      node.className = 'tool-card ' + (tool.category || 'tool') + (blocked ? ' blocked' : (failureKind ? ' failed' : ''));
      const head = document.createElement('div');
      head.className = 'tool-head';
      const running = tool.phase === 'use';
      const title = document.createElement('div');
      title.className = 'tool-title';
      const titleText = document.createElement('span');
      titleText.className = 'tool-title-text';
      titleText.textContent = tool.title || tool.name;
      title.append(toolIcon(tool), statusDot(running, tool.ok), titleText);
      const stateNode = document.createElement('div');
      stateNode.className = 'tool-state';
      if (running) {
        fillRunningToolState(stateNode, tool);
      } else {
        const label = tool.ok === false ? toolFailureLabel(failureKind) : 'Done';
        const timing = measuredToolTiming(tool);
        stateNode.textContent = timing
          ? label + ' · ' + formatMeasuredDuration(timing.durationMs) + humanWaitText(timing)
          : label + ' · duration not recorded';
      }

      // Collapsed by default so the title row is all a healthy call costs. A blocked call starts open:
      // its error is the reason the card exists.
      if (blocked || isToolExpanded(tool)) { node.classList.add('expanded'); }
      const expand = document.createElement('button');
      expand.className = 'tool-expand';
      expand.type = 'button';
      expand.textContent = '▶'; // CSS rotates it 90° while the card is open
      const syncExpandLabel = () => {
        const open = node.classList.contains('expanded');
        expand.setAttribute('aria-expanded', String(open));
        expand.title = open ? 'Hide details' : 'Show details';
        expand.setAttribute('aria-label', expand.title);
      };
      syncExpandLabel();

      const right = document.createElement('div');
      right.className = 'tool-head-right';
      right.append(stateNode, expand);
      head.append(title, right);

      // The whole title row is the hit target — the 9px chevron alone is a hard thing to click.
      head.addEventListener('click', () => {
        node.classList.toggle('expanded');
        setToolExpanded(tool, node.classList.contains('expanded'));
        syncExpandLabel();
        handleToolCardToggle(node.classList.contains('expanded'));
      });

      const body = document.createElement('div');
      body.className = 'tool-body';
      body.textContent = tool.summary || tool.name;
      body.appendChild(renderToolTiming(tool));
      if (tool.input) {
        body.appendChild(renderToolDetail('Input', tool.input)); // args — least important, stays collapsed
      }
      if (tool.diff) {
        body.appendChild(renderDiffDetail(tool.diff)); // G-004: expanded + colored
      }
      if (tool.detail && tool.detail !== tool.summary) {
        // G-005: command/test output (run cards) opens expanded and is labeled "Output" — no more
        // clicking to see what npm test printed. Other tools keep a collapsed "Details".
        const isRun = tool.category === 'run';
        const isMarkdown = Array.isArray(tool.detailBlocks);
        body.appendChild(renderToolDetail(
          isRun ? 'Output' : (isMarkdown ? 'Markdown preview' : 'Details'),
          tool.detail,
          isRun,
          tool.detailBlocks,
          tool.detailTruncatedChars,
        ));
      }
      if (tool.canOpenFile) {
        const actions = document.createElement('div');
        actions.className = 'tool-receipt-actions';
        const openFile = document.createElement('button');
        openFile.className = 'tool-open-file';
        openFile.type = 'button';
        openFile.textContent = tool.detailTruncatedChars
          ? 'Open full file in editor'
          : 'Open file in editor';
        openFile.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({ command: 'openToolFile', agentId: state.selectedAgentId, toolId: tool.id });
        });
        actions.appendChild(openFile);
        body.appendChild(actions);
      }
      node.append(head, body);
      return node;
    }

    function toolFailureLabel(kind) {
      if (kind === 'blocked') return 'Blocked';
      if (kind === 'not_found') return 'Not found';
      if (kind === 'integration_error') return 'Integration error';
      return 'Error';
    }

    function absoluteToolTime(value) {
      const when = new Date(value);
      return Number.isFinite(when.getTime()) ? when.toLocaleString() : 'unavailable';
    }

    function renderToolTiming(tool) {
      const timing = measuredToolTiming(tool);
      const node = document.createElement('div');
      node.className = 'tool-timing';
      if (!timing) {
        node.textContent = 'Timing: duration not recorded';
        return node;
      }
      node.textContent = 'Started: ' + absoluteToolTime(timing.startedAt)
        + ' · Finished: ' + absoluteToolTime(timing.completedAt)
        + ' · Duration: ' + formatMeasuredDuration(timing.durationMs) + humanWaitText(timing);
      return node;
    }

    function renderToolGroup(group) {
      const node = document.createElement('div');
      node.className = 'tool-card ' + (group.category || 'tool') + ' tool-group';
      if (isToolExpanded(group)) node.classList.add('expanded');
      const head = document.createElement('div');
      head.className = 'tool-head';
      const title = document.createElement('div');
      title.className = 'tool-title';
      const titleText = document.createElement('span');
      titleText.className = 'tool-title-text';
      titleText.textContent = toolGroupTitle(group.tools || []);
      title.append(toolIcon(group.tools && group.tools[0]), statusDot(false, true), titleText);

      const stateNode = document.createElement('div');
      stateNode.className = 'tool-state';
      const timing = measuredToolGroupTiming(group.tools || []);
      stateNode.textContent = timing.complete
        ? 'Done · span ' + formatMeasuredDuration(timing.spanMs) + humanWaitText(timing)
        : 'Done · partial span';
      const expand = document.createElement('button');
      expand.className = 'tool-expand';
      expand.type = 'button';
      expand.textContent = '▶';
      const syncExpandLabel = () => {
        const open = node.classList.contains('expanded');
        expand.setAttribute('aria-expanded', String(open));
        expand.title = open ? 'Hide details' : 'Show details';
        expand.setAttribute('aria-label', expand.title);
      };
      syncExpandLabel();

      const right = document.createElement('div');
      right.className = 'tool-head-right';
      right.append(stateNode, expand);
      head.append(title, right);
      head.addEventListener('click', () => {
        node.classList.toggle('expanded');
        setToolExpanded(group, node.classList.contains('expanded'));
        syncExpandLabel();
        handleToolCardToggle(node.classList.contains('expanded'));
      });

      const body = document.createElement('div');
      body.className = 'tool-body tool-group-body';
      const timingNote = document.createElement('div');
      timingNote.className = 'tool-timing';
      timingNote.textContent = timing.complete
        ? 'Group span: ' + formatMeasuredDuration(timing.spanMs) + ' (first start to last finish)'
        : 'Group span: partial (duration not recorded for one or more steps)';
      body.appendChild(timingNote);
      for (const tool of group.tools || []) {
        body.appendChild(renderTool(tool));
      }
      node.append(head, body);
      return node;
    }

    function renderToolDetail(label, text, open, blocks, truncatedChars) {
      const details = document.createElement('details');
      details.className = 'tool-detail';
      if (open) { details.open = true; }
      const summary = document.createElement('summary');
      summary.textContent = label;
      details.appendChild(summary);
      if (Array.isArray(blocks)) {
        details.appendChild(renderBlocks(blocks));
      } else {
        const pre = document.createElement('pre');
        pre.textContent = Number.isFinite(truncatedChars) && truncatedChars > 0
          ? String(text).replace(/\\n\\[detail truncated \\d+ chars\\]\\s*$/, '')
          : text;
        details.appendChild(pre);
      }
      if (Number.isFinite(truncatedChars) && truncatedChars > 0) {
        const notice = document.createElement('div');
        notice.className = 'tool-truncation';
        notice.textContent = 'Receipt preview truncated by ' + truncatedChars + ' characters. Open the file for the complete content.';
        details.appendChild(notice);
      }
      return details;
    }

    // G-004: write diffs render EXPANDED + red/green colored, so you see what changed without clicking.
    function renderDiffDetail(text) {
      const details = document.createElement('details');
      details.className = 'tool-detail';
      details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = 'Diff';
      const pre = document.createElement('pre');
      for (const line of String(text).split('\\n')) {
        const span = document.createElement('span');
        const cls =
          (line.startsWith('+') && !line.startsWith('+++')) ? 'diff-add' :
          (line.startsWith('-') && !line.startsWith('---')) ? 'diff-del' :
          (line.startsWith('@@') || line.startsWith('+++') || line.startsWith('---')) ? 'diff-meta' : '';
        span.className = 'diff-line' + (cls ? ' ' + cls : '');
        span.textContent = line;
        pre.appendChild(span);
      }
      details.append(summary, pre);
      return details;
    }

    function renderLiveBlocks(blocks, dataKey) {
      const root = renderBlocks([]);
      root.dataset.liveBlocks = 'true';
      if (dataKey) {
        root.dataset[dataKey] = 'true';
      }
      replaceLiveBlocks(root, 0, blocks || []);
      return root;
    }

    function humanSize(bytes) {
      if (!Number.isFinite(bytes)) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function attachmentKind(file) {
      if (IMAGE_MIMES.has((file.type || '').toLowerCase())) return 'image';
      if ((file.type || '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(file.name || '')) return 'pdf';
      return 'file';
    }

    function allowedAttachment(file) {
      const mime = (file.type || '').toLowerCase();
      if (IMAGE_MIMES.has(mime)) return true;
      if (mime === 'application/pdf' || /\.pdf$/i.test(file.name || '')) return true;
      if (TEXT_MIMES.has(mime)) return true;
      return /\\.(txt|md|markdown|json|csv|log|xml|yaml|yml)$/i.test(file.name || '');
    }

    function setAttachmentStatus(message) {
      attachmentStatus.textContent = message || '';
      attachmentStatus.hidden = !message;
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Unable to read file.'));
        reader.readAsDataURL(file);
      });
    }

    function makeImageThumbnail(dataUrl) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            const max = 96;
            const scale = Math.min(1, max / Math.max(img.width || max, img.height || max));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round((img.width || max) * scale));
            canvas.height = Math.max(1, Math.round((img.height || max) * scale));
            const ctx = canvas.getContext('2d');
            if (!ctx) { resolve(undefined); return; }
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/webp', 0.72));
          } catch {
            resolve(undefined);
          }
        };
        img.onerror = () => resolve(undefined);
        img.src = dataUrl;
      });
    }

    async function addFiles(files) {
      const errors = [];
      for (const file of Array.from(files || [])) {
        if (pendingAttachments.length >= MAX_ATTACHMENTS) {
          errors.push('You can attach at most ' + MAX_ATTACHMENTS + ' files.');
          break;
        }
        const maxBytes = attachmentKind(file) === 'pdf' ? MAX_PDF_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES;
        if (file.size > maxBytes) {
          errors.push(file.name + ' is larger than ' + (maxBytes / (1024 * 1024)) + ' MB.');
          continue;
        }
        if (!allowedAttachment(file)) {
          errors.push(file.name + ' is not a supported image, text file, or PDF.');
          continue;
        }
        try {
          const dataUrl = await readFileAsDataUrl(file);
          const comma = dataUrl.indexOf(',');
          const kind = attachmentKind(file);
          const thumbnailDataUrl = kind === 'image' ? await makeImageThumbnail(dataUrl) : undefined;
          const mime = (file.type || (attachmentKind(file) === 'image' ? 'image/png' : attachmentKind(file) === 'pdf' ? 'application/pdf' : 'text/plain')).toLowerCase();
          attachmentGeneration += 1;
          pendingAttachments.push({
            name: file.name || 'attachment',
            mime,
            size: file.size,
            kind,
            dataUrl,
            thumbnailDataUrl,
            dataBase64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
          });
        } catch {
          errors.push(file.name + ' could not be read.');
        }
      }
      renderAttachmentChips();
      setAttachmentStatus(errors.join(' '));
    }

    function renderAttachmentChips() {
      attachmentChips.replaceChildren();
      attachmentChips.hidden = pendingAttachments.length === 0;
      pendingAttachments.forEach((attachment, index) => {
        attachmentChips.appendChild(renderAttachmentChip(attachment, () => {
          pendingAttachments.splice(index, 1);
          attachmentGeneration += 1;
          renderAttachmentChips();
        }));
      });
    }

    function renderAttachmentChip(attachment, onRemove) {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip';
      if (attachment.kind === 'image' && attachment.dataUrl) {
        const img = document.createElement('img');
        img.src = attachment.thumbnailDataUrl || attachment.dataUrl;
        img.alt = '';
        chip.appendChild(img);
      } else {
        const mark = document.createElement('span');
        mark.className = 'file-mark';
        mark.textContent = attachment.kind === 'pdf' ? 'PDF' : 'TXT';
        chip.appendChild(mark);
      }
      const name = document.createElement('span');
      name.className = 'attach-name';
      name.textContent = attachment.name;
      chip.appendChild(name);
      if (attachment.size !== undefined) {
        const size = document.createElement('span');
        size.className = 'attach-size';
        size.textContent = humanSize(attachment.size);
        chip.appendChild(size);
      }
      if (onRemove) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.title = 'Remove attachment';
        remove.textContent = '×';
        remove.addEventListener('click', onRemove);
        chip.appendChild(remove);
      }
      return chip;
    }

    function attachmentPayload() {
      return pendingAttachments.map((a) => ({
        name: a.name,
        mime: a.mime,
        size: a.size,
        kind: a.kind,
        dataBase64: a.dataBase64,
        thumbnailDataUrl: a.thumbnailDataUrl,
      }));
    }

    function updateComposer() {
      const repair = state.repair;
      const disabled = !state.selectedAgentId || !!repair;
      const running = state.runningAgentIds.includes(state.selectedAgentId);
      const canSteer = state.agents.find((agent) => agent.id === state.selectedAgentId)?.canSteer !== false;
      input.disabled = disabled;
      sendButton.disabled = disabled;
      if (typeof attachButton !== 'undefined' && attachButton) attachButton.disabled = disabled || running;
      // Icon only. The word now lives in title + aria-label, so it is a hover away for a mouse and
      // always present for a screen reader. The GLYPH still carries the state change on its own: an
      // up-arrow sends, a bolt steers a running agent, a down-arrow queues behind one — three different
      // actions that used to be told apart by three different words in the same button.
      const sendLabel = running
        ? (canSteer ? 'Send a steering message to the running agent' : 'Queue a follow-up for after this turn')
        : 'Send';
      sendButton.textContent = running ? (canSteer ? '⚡' : '↓') : '↑';
      sendButton.title = sendLabel;
      sendButton.setAttribute('aria-label', sendLabel);
      stopButton.hidden = !running;
      stopButton.disabled = disabled || !running;
      // A coordinator that dispatched async work RELEASES its turn, so it is genuinely idle and reachable —
      // Send stays enabled (that is the feature). But say that work is still out, or the PM looks idle and
      // then wakes up on its own, which reads as a glitch.
      const out = (state.delegatingCounts || {})[state.selectedAgentId] || 0;
      const waiting = (state.waitingResultCounts || {})[state.selectedAgentId] || 0;
      if (running && waiting > 0) {
        steerHint.hidden = false;
        steerHint.textContent = waiting === 1
          ? '1 delegated result is waiting behind this turn. The PM will handle it when this turn ends.'
          : waiting + ' delegated results are waiting behind this turn. The PM will handle them when this turn ends.';
      } else if (running) {
        steerHint.hidden = false;
        steerHint.textContent = canSteer
          ? 'Agent is working — your message will steer it. Use Stop to cancel.'
          : 'Agent is working — this connection cannot accept mid-turn steering, so your message will run as a follow-up. Use Stop to cancel.';
      } else if (out > 0) {
        steerHint.hidden = false;
        steerHint.textContent = out === 1
          ? 'Delegating — 1 task still out with a teammate. Ask anything; the result is reported when it lands.'
          : 'Delegating — ' + out + ' tasks still out with teammates. Ask anything; results are reported as they land.';
      } else {
        steerHint.hidden = true;
      }
      input.placeholder = repair
        ? 'Complete setup to message an agent'
        : state.mode === 'plan'
        ? '[PLAN] Discuss, analyze, and plan only — @file to attach'
        : 'Message the selected agent — @path to attach a file';
      planMode.disabled = disabled || running;
      actMode.disabled = disabled || running;
      agentSelect.disabled = state.agents.length === 0;

      // The denominator is as consequential as the percentage: a precise-looking ratio against an assumed
      // 1M window is exactly how the guard became invisible. Keep measured, user-configured, provider-refused
      // and assumed distinct rather than teaching people to distrust the label when the value is finally real.
      //
      // And say WHY there is no number. A pill that renders blank when the runtime cannot report reads as a
      // broken control, which is how v0.9.50's meter was reported: "I installed it and there is no button."
      // There was a button. It had nothing to say and said nothing.
      const meter = state.contextMeter;
      const usage = meter && meter.kind === 'usage' ? meter.usage : undefined;
      const hasUsage = usage
        && Number.isFinite(Number(usage.window))
        && Number(usage.window) > 0
        && Number.isFinite(Number(usage.ratio));
      if (ctxCompact && ctxMeter) {
        ctxMeter.classList.toggle('is-gone', !meter);
        ctxMeter.classList.toggle('warn', !!hasUsage && Number(usage.ratio) >= 0.7);
        // The button stays PRESENT whenever an agent is selected, and disabled when there is nothing to
        // compact. Hiding it taught the last release's lesson the hard way: an absent control and an
        // unavailable one look identical, and the meter beside it is where the reason belongs.
        ctxCompact.classList.toggle('is-gone', !meter);
        compactInFlight = false;
        ctxCompact.textContent = COMPACT_GLYPH;
        // A native runtime that has not reported a size yet can still be asked to compact.
        ctxCompact.disabled = !hasUsage && !(meter && meter.kind === 'awaiting-report');
        if (hasUsage) {
          const source = usage.source === 'measured'
            ? 'a measured'
            : usage.source === 'configured'
              ? 'a configured'
              : usage.source === 'observed'
                ? 'a provider-refused'
                : 'an assumed';
          const label = Math.max(0, Math.round(Number(usage.ratio) * 100))
            + '% of ' + source + ' ' + Number(usage.window).toLocaleString() + ' tokens';
          ctxMeter.textContent = label;
          ctxMeter.title = label + ' held by this agent.';
          ctxCompact.title = 'Summarise older turns now. ' + label + '.';
        } else if (meter && meter.kind === 'not-started') {
          ctxMeter.textContent = 'Context — start the agent';
          ctxMeter.title = 'This agent is not running, so there is no conversation to measure yet.';
          ctxCompact.title = 'This agent is not running, so there is nothing held here to compact. '
            + 'Start it and the meter fills in.';
        } else if (meter && meter.kind === 'awaiting-report') {
          ctxMeter.textContent = 'Context — measured after the next reply';
          ctxMeter.title = 'This runtime reports the size of its conversation with each reply. None has arrived since it '
            + 'started or last compacted.';
          ctxCompact.title = 'Ask the runtime to summarise this conversation now. It reports the size again with its next reply.';
        } else if (meter) {
          ctxMeter.textContent = 'Context — managed by the runtime';
          ctxMeter.title = 'This agent runs through a CLI that owns its own context window.';
          ctxCompact.title = 'This agent runs through a CLI that owns its own context window. UnodeAi cannot '
            + 'measure it and has nothing of its own to compact, so it reports that instead of showing a zero.';
        }
        ctxCompact.setAttribute('aria-label', ctxCompact.title);
      }
    }

    function selectedIsRunning() {
      return state.runningAgentIds.includes(state.selectedAgentId);
    }

    // Auto-grow the composer: height follows content up to COMPOSER_MAX_H, then it scrolls.
    // Keep COMPOSER_MAX_H in sync with the textarea max-height in CSS.
    const COMPOSER_MAX_H = 200;
    const COMPOSER_MIN_H = 46; // keep in sync with the textarea's min-height/height in CSS
    function autoGrow() {
      if (!input || !input.style) return; // no-op outside a real DOM (unit-test eval)
      // A height derived from scrollHeight is only meaningful once the box has a width. Measured while
      // the container is still 0-wide — a sidebar mid-reveal — every line wraps, scrollHeight comes back
      // enormous, and the box sticks at its maximum until the next keystroke. Skip and let the resize
      // observer below run it again when the layout is real.
      if (!input.clientWidth) return;
      input.style.height = 'auto';
      const sh = input.scrollHeight || 0;
      input.style.height = Math.max(Math.min(sh, COMPOSER_MAX_H), COMPOSER_MIN_H) + 'px';
      input.style.overflowY = sh > COMPOSER_MAX_H ? 'auto' : 'hidden';
    }

    // The same text needs a different height in a 300px sidebar than in a full-width editor, and the
    // container can change width long after load — on reveal, on a drag, on a zoom change.
    if (input && typeof ResizeObserver === 'function') {
      let lastWidth = 0;
      new ResizeObserver(() => {
        if (input.clientWidth && input.clientWidth !== lastWidth) {
          lastWidth = input.clientWidth;
          autoGrow();
        }
      }).observe(input);
    }
    /**
     * Put the composer back to one line. Send calls THIS, not autoGrow().
     *
     * autoGrow re-derives the height from scrollHeight, which needs the browser to reflow the emptied
     * textarea before we read it — and a read that depends on layout timing, visibility, or a leftover
     * scrollbar is a read that can come back wrong, leaving the box stuck tall after a send. The height
     * after a send is not something to compute: it is a known constant. Set it.
     */
    function resetComposerHeight() {
      if (!input || !input.style) return;
      input.style.height = COMPOSER_MIN_H + 'px';
      input.style.overflowY = 'hidden';
    }

    // VS Code preserves webview state across a hidden/moved/restored Workbench. Merge every field so draft
    // and tool-expansion updates cannot erase one another (or a future state field).
    function persistUiSnapshot() {
      if (typeof vscode.setState !== 'function') return;
      const liveAgents = new Set((state.agents || []).map((agent) => agent.id));
      for (const agentId of Object.keys(expandedToolIdsByAgent)) {
        if (!liveAgents.has(agentId)) delete expandedToolIdsByAgent[agentId];
      }
      const previous = typeof vscode.getState === 'function' ? (vscode.getState() || {}) : {};
      const next = Object.assign({}, previous, { draftsByAgent, expandedToolIdsByAgent });
      delete next.draft;
      vscode.setState(next);
    }

    // Drafts belong to agents, not the container: preserve at most 20 least-recently-edited entries and
    // remove a sent/removed agent's text.
    function persistUiState(agentId = state.selectedAgentId, drop = false) {
      if (agentId) {
        if (drop || !input.value) {
          delete draftsByAgent[agentId];
        } else {
          draftsByAgent[agentId] = { text: input.value, editedAt: Math.max(Date.now(), draftRevision + 1) };
          draftRevision = draftsByAgent[agentId].editedAt;
        }
      }
      pruneDrafts();
      persistUiSnapshot();
    }

    function setSendStatus(message) {
      if (!sendStatus) return;
      sendStatus.textContent = message || '';
      sendStatus.hidden = !message;
    }

    function nextSendRequestId() {
      sendRequestSequence += 1;
      return 'send-' + Date.now().toString(36) + '-' + sendRequestSequence.toString(36);
    }

    function clearComposer(agentId) {
      input.value = '';
      persistUiState(agentId, true);
      if (typeof pendingAttachments !== 'undefined') pendingAttachments = [];
      attachmentGeneration += 1;
      if (typeof renderAttachmentChips === 'function') renderAttachmentChips();
      if (typeof setAttachmentStatus === 'function') setAttachmentStatus('');
      resetComposerHeight();
    }

    // No acknowledgement arrived: give the composer back with the draft untouched. Never resend on its own;
    // the host cannot prove whether a dead process accepted the message.
    function markSendUnconfirmed(requestId) {
      if (!pendingSend || pendingSend.requestId !== requestId) return;
      clearTimeout(pendingSend.timer);
      unconfirmedSend = pendingSend;
      pendingSend = undefined;
      setSendStatus(SEND_UNCONFIRMED_NOTICE);
    }

    // A state from a different host instance means the extension host restarted: the new one cannot answer a send
    // the old one never received, so resolve it now instead of waiting for the timeout.
    function noteHostInstance(next) {
      if (!next || typeof next.hostInstanceId !== 'string') return;
      if (knownHostInstanceId && next.hostInstanceId !== knownHostInstanceId && pendingSend) {
        markSendUnconfirmed(pendingSend.requestId);
      }
      knownHostInstanceId = next.hostInstanceId;
    }

    function acceptComposerSend(message) {
      if (!message) return;
      if (unconfirmedSend && message.requestId === unconfirmedSend.requestId) {
        // Delivered after all. Clear the composer only if it still holds exactly what was sent: no newer send is
        // pending, and neither the draft nor the attachments changed since (edit-then-restore is still a change).
        const late = unconfirmedSend;
        unconfirmedSend = undefined;
        if (!pendingSend && draftRevision === late.draftRevision && attachmentGeneration === late.attachmentGeneration) {
          clearComposer(late.agentId);
        }
        setSendStatus('');
        return;
      }
      if (!pendingSend || message.requestId !== pendingSend.requestId) return;
      clearTimeout(pendingSend.timer);
      const agentId = pendingSend.agentId;
      pendingSend = undefined;
      clearComposer(agentId);
      setSendStatus('');
    }

    function rejectComposerSend(message) {
      if (message && unconfirmedSend && message.requestId === unconfirmedSend.requestId) {
        unconfirmedSend = undefined;
        setSendStatus(typeof message.reason === 'string' && message.reason.trim()
          ? message.reason.trim()
          : 'The message was not sent. Your draft was kept.');
        return;
      }
      if (!pendingSend || !message || message.requestId !== pendingSend.requestId) return;
      clearTimeout(pendingSend.timer);
      const agentId = pendingSend.agentId;
      pendingSend = undefined;
      const reason = typeof message.reason === 'string' && message.reason.trim()
        ? message.reason.trim()
        : 'The message was not sent. Your draft was kept.';
      setSendStatus(reason);
      // The input and persisted draft deliberately stay untouched. The next keystroke keeps the draft
      // durable even if the webview is hidden before the user retries.
      persistUiState(agentId);
      if (typeof input.focus === 'function') input.focus();
    }

    function send() {
      if (pendingSend) return;
      const text = input.value.trim();
      const agentId = agentSelect.value;
      const hasAttachments = typeof pendingAttachments !== 'undefined' && pendingAttachments.length > 0;
      if ((!text && !hasAttachments) || !agentId) return;
      const attachments = typeof attachmentPayload === 'function' ? attachmentPayload() : [];
      const requestId = nextSendRequestId();
      // The draft revision and attachment generation let a late acknowledgement tell whether the composer still
      // holds exactly this message.
      pendingSend = { requestId, agentId, draftRevision, attachmentGeneration };
      pendingSend.timer = setTimeout(() => markSendUnconfirmed(requestId), SEND_ACK_TIMEOUT_MS);
      unconfirmedSend = undefined;
      setSendStatus('Sending…');
      // Do not clear the draft until the host says it accepted this exact post. The host can reject a
      // stale/removed agent; clearing first would make that refusal an irreversible data loss.
      vscode.postMessage({ command: 'send', requestId, agentId, text, mode: state.mode || 'act', attachments });
    }

    function stop() {
      const agentId = state.selectedAgentId;
      if (!agentId || !selectedIsRunning()) return;
      vscode.postMessage({ command: 'interrupt', agentId });
    }

    function setMode(mode) {
      if (!state.selectedAgentId || selectedIsRunning()) return;
      state.mode = mode === 'plan' ? 'plan' : 'act';
      renderMode();
      updateComposer();
      vscode.postMessage({ command: 'setMode', agentId: state.selectedAgentId, mode: state.mode });
    }

    agentSelect.addEventListener('change', () => {
      persistUiState(state.selectedAgentId);
      vscode.postMessage({ command: 'selectAgent', agentId: agentSelect.value });
    });
    planMode.addEventListener('click', () => setMode('plan'));
    actMode.addEventListener('click', () => setMode('act'));
    cmdApprovalSel.addEventListener('change', () => {
      vscode.postMessage({ command: 'setApproval', kind: 'command', value: cmdApprovalSel.value });
    });
    writeApprovalSel.addEventListener('change', () => {
      vscode.postMessage({ command: 'setApproval', kind: 'write', value: writeApprovalSel.value });
    });
    codexPermissionsSel.addEventListener('change', () => {
      const agentId = state.selectedAgentId;
      const choice = codexPermissionsSel.value;
      // Only the three profiles the host can store may leave the webview; anything else snaps back to the
      // truth instead of leaving the control showing a permission level that is not in force.
      if (!agentId || state.mode !== 'act'
        || (choice !== 'ask-for-approval' && choice !== 'approve-for-me' && choice !== 'full-access')) {
        renderApprovalBar();
        return;
      }
      vscode.postMessage({ command: 'setCodexPermissionProfile', agentId, profile: choice });
    });
    sendButton.addEventListener('click', send);
    window.addEventListener('wheel', onTranscriptWheel, { passive: true });
    transcript.addEventListener('scroll', onTranscriptScroll, { passive: true });
    attachButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      void addFiles(fileInput.files);
      fileInput.value = '';
    });
    composer.addEventListener('dragover', (event) => {
      if (!state.selectedAgentId || selectedIsRunning()) return;
      event.preventDefault();
      composer.classList.add('drag');
    });
    composer.addEventListener('dragleave', () => composer.classList.remove('drag'));
    composer.addEventListener('drop', (event) => {
      if (!state.selectedAgentId || selectedIsRunning()) return;
      event.preventDefault();
      composer.classList.remove('drag');
      void addFiles(event.dataTransfer ? event.dataTransfer.files : []);
    });
    stopButton.addEventListener('click', stop);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });
    input.addEventListener('paste', (event) => {
      const files = [];
      for (const item of Array.from(event.clipboardData ? event.clipboardData.items : [])) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        void addFiles(files);
      }
    });
    // Grow/shrink on every edit (typing, newlines, paste, cut), and set the initial single-line height.
    input.addEventListener('input', () => {
      autoGrow();
      persistUiState();
    });
    autoGrow();

    function nowMs() {
      return (window.performance && typeof window.performance.now === 'function') ? window.performance.now() : Date.now();
    }

    function smoothStreamingOn() {
      return state.smoothStreaming !== false &&
        !(reducedMotionQuery && reducedMotionQuery.matches) &&
        !(typeof document !== 'undefined' && document.hidden);
    }

${WEBVIEW_LIVE_BLOCKS_SOURCE}
${WEBVIEW_STREAM_PACING_SOURCE}

    window.addEventListener('blur', flushAllPacing);
    window.addEventListener('unload', clearLivenessClock);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          flushAllPacing();
          clearLivenessClock();
        } else {
          syncLivenessClock();
        }
      });
    }
    if (reducedMotionQuery) {
      const onReducedMotion = () => { if (reducedMotionQuery.matches) flushAllPacing(); };
      if (typeof reducedMotionQuery.addEventListener === 'function') {
        reducedMotionQuery.addEventListener('change', onReducedMotion);
      } else if (typeof reducedMotionQuery.addListener === 'function') {
        reducedMotionQuery.addListener(onReducedMotion);
      }
    }

    function appendLiveBlocks(msg) {
      if (msg.agentId !== state.selectedAgentId) return;
      if (!acceptStreamedEvent(msg)) return;
      const stick = shouldAutoScroll(isNearBottom());
      markStreamedRunning(msg);
      ensureLivenessTail();
      const emptyNode = transcript.querySelector('.empty');
      if (emptyNode) emptyNode.remove();
      const isReasoning = msg.kind === 'reasoning';
      let live = document.getElementById(isReasoning ? 'live-reasoning' : 'live-message');
      const insertedNewLive = !live;
      if (!live) {
        live = isReasoning
          ? renderReasoning({ text: '', ts: new Date().toISOString(), blocks: [], live: true })
          : renderMessage({ role: 'agent', text: '', ts: new Date().toISOString(), fromName: msg.fromName || 'Agent', blocks: [], live: true });
        if (isReasoning) {
          const liveMessage = document.getElementById('live-message');
          const tail = document.getElementById('thinking-indicator');
          transcript.insertBefore(live, liveMessage || tail || null);
        } else {
          transcript.insertBefore(live, document.getElementById('thinking-indicator'));
        }
      }
      const root = live.querySelector('[data-live-blocks="true"]');
      if (root) {
        applyPacedLiveBlocks(root, msg);
      }
      if (stick) scheduleBottomSettle(insertedNewLive);
      syncLivenessClock();
      updateComposer();
    }

    // Declared legacy stream envelopes. Current host code emits liveBlocks; keeping these receivers
    // typed preserves restoration compatibility without inventing an undeclared host command.
    function appendDelta(msg) {
      appendLiveBlocks({ ...msg, kind: 'message', replaceFrom: 0, blocks: msg.blocks || [] });
    }

    function appendReasoning(msg) {
      appendLiveBlocks({ ...msg, kind: 'reasoning', replaceFrom: 0, blocks: msg.blocks || [] });
    }

    function upsertTranscriptItem(item) {
      if (!item) return;
      const messages = Array.isArray(state.messages) ? state.messages.slice() : [];
      const idx = messages.findIndex((m) => sameTranscriptItem(m, item));
      if (idx >= 0) messages[idx] = item;
      else messages.push(item);
      messages.sort(compareTranscriptItems);
      state.messages = messages;
      renderTranscript();
      updateComposer();
    }

    function sameTranscriptItem(a, b) {
      if (a.kind === 'tool' && b.kind === 'tool') return a.id === b.id;
      if (a.kind === b.kind && a.seq !== undefined && b.seq !== undefined) return a.seq === b.seq;
      if ((a.kind === 'reasoning' || a.kind === 'marker') && a.id && b.id) return a.kind === b.kind && a.id === b.id;
      return false;
    }

    function compareTranscriptItems(a, b) {
      const sa = typeof a.seq === 'number' ? a.seq : Number.MAX_SAFE_INTEGER;
      const sb = typeof b.seq === 'number' ? b.seq : Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
      return String(a.ts || '').localeCompare(String(b.ts || ''));
    }
    window.addEventListener('message', (event) => {
      if (!event.data || !declaredHostCommands.has(event.data.command)) return;
      if (event.data.command === 'state') {
        renderState(event.data.state, event.data.announce === true);
      } else if (event.data.command === 'attention') {
        void playAttention(event.data.id);
      } else if (event.data.command === 'sendAccepted') {
        acceptComposerSend(event.data);
      } else if (event.data.command === 'sendRejected') {
        rejectComposerSend(event.data);
      } else if (event.data.command === 'liveBlocks') {
        appendLiveBlocks(event.data);
      } else if (event.data.command === 'delta') {
        if (event.data.agentId === state.selectedAgentId && acceptStreamedEvent(event.data)) {
          appendDelta(event.data);
        }
      } else if (event.data.command === 'reasoningDelta') {
        if (event.data.agentId === state.selectedAgentId && acceptStreamedEvent(event.data)) {
          appendReasoning(event.data);
        }
      } else if (event.data.command === 'transcriptItem' || event.data.command === 'toolAppended' || event.data.command === 'toolUpdated') {
        if (event.data.agentId === state.selectedAgentId && event.data.item && acceptStreamedEvent(event.data)) {
          markStreamedRunning(event.data);
          upsertTranscriptItem(event.data.item);
        }
      } else if (event.data.command === 'turnPhase') {
        setTurnPhase(event.data);
      } else if (event.data.command === 'toggleComposerFocus') {
        if (document.activeElement === input) {
          vscode.postMessage({ command: 'focusEditor' });
        } else {
          input.focus();
        }
      } else if (event.data.command === 'focusApproval') {
        revealApproval(event.data.id);
      }
    });
    // The host uses this only to choose one live region when the sidebar and Workbench are both visible.
    // It never moves focus, and a missing signal simply falls back to the Workbench then the sidebar.
    window.addEventListener('focus', () => vscode.postMessage({ command: 'accessibilityFocus', focused: true }));
    window.addEventListener('blur', () => vscode.postMessage({ command: 'accessibilityFocus', focused: false }));
    renderState(initialState);
    if (initialApprovalFocusId) revealApproval(initialApprovalFocusId);
  </script>
</body>
</html>`;
  }
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Exactly the chat actions the sidebar offers from its view title bar — no more. */
const WORKBENCH_CHAT_COMMANDS = new Set([
  'unode.archiveChat',
  'unode.clearChat',
  'unode.toggleChatCompact',
  'unode.exportChat',
  'unode.importChat',
  'unode.viewArchivedChats',
]);

function isChatRepairState(value: unknown): value is ChatRepairState {
  return value === 'no-team' || value === 'missing-connection' || value === 'missing-credential';
}

function repairCopyFor(kind: ChatRepairState): ChatRepairCopy {
  switch (kind) {
    case 'no-team':
      return {
        title: 'Create a team to start working',
        detail: 'There are no agents in this workspace yet. Create a team, then send the first task here.',
        action: 'Create a team',
      };
    case 'missing-connection':
      return {
        title: 'No runnable connection is configured',
        detail: 'This team has no available connection. Choose one in Settings before sending a task.',
        action: 'Open Settings',
      };
    case 'missing-credential':
      return {
        title: 'This connection needs a credential',
        detail: 'The configured connection has no credential in SecretStorage. Add it in Settings to continue.',
        action: 'Open Settings',
      };
  }
}

function lowercaseFirst(value: string): string {
  return value ? value.slice(0, 1).toLowerCase() + value.slice(1) : value;
}

function smoothStreamingEnabled(): boolean {
  try {
    const cfg = vscode.workspace?.getConfiguration?.('unode');
    return cfg?.get<boolean>('chat.smoothStreaming', true) !== false;
  } catch {
    return true;
  }
}

function normalizeEpoch(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function approvalSummary(approval: ApprovalRequest): string {
  if (approval.kind === 'command') {
    return approval.command || 'Run a command';
  }
  if (approval.kind === 'write') {
    return `${approval.verb || 'write'} ${approval.path || 'a workspace path'}`;
  }
  return approval.toolName || 'Use a tool';
}

/** Resolve only a path captured by the host in a read_file tool receipt. Webviews never provide paths. */
export function readFilePathFromActivity(tool: Pick<ChatToolActivity, 'name' | 'input'>): string | undefined {
  if (tool.name !== 'read_file' || typeof tool.input !== 'string') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(tool.input) as { path?: unknown };
    const filePath = typeof parsed?.path === 'string' ? parsed.path.trim() : '';
    return filePath && filePath.length <= 32_768 ? filePath : undefined;
  } catch {
    return undefined;
  }
}

export function splitTruncatedDetail(detail: string | undefined): { preview: string; truncatedChars?: number } {
  const text = String(detail ?? '');
  const match = text.match(/\n\[detail truncated (\d+) chars\]\s*$/);
  if (!match) {
    return { preview: text };
  }
  const truncatedChars = Number(match[1]);
  return {
    preview: text.slice(0, match.index),
    truncatedChars: Number.isSafeInteger(truncatedChars) && truncatedChars > 0 ? truncatedChars : undefined,
  };
}

function toolActivityFromEvent(event: ChatToolEvent, turnEpoch: number): ChatToolActivity {
  const input = event.phase === 'use' ? event.input : undefined;
  const base = summarizeToolUse(event.name, input);
  const card: ChatToolActivity = {
    kind: 'tool',
    id: `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ts: new Date().toISOString(),
    // A result that arrives without a matching use has no measured start. Do not manufacture a duration.
    phase: event.phase,
    name: event.name,
    title: base.title,
    summary: base.summary,
    category: base.category,
    input: formatToolInput(input),
    callId: event.callId,
    turnEpoch,
  };
  return event.phase === 'result' ? withToolResult(card, event) : card;
}

/** A card's result: its typed outcome and its bounded payloads. */
function withToolResult(card: ChatToolActivity, event: Extract<ChatToolEvent, { phase: 'result' }>): ChatToolActivity {
  return {
    ...card,
    phase: 'result',
    title: event.name === 'read_file' && event.summary ? event.summary : card.title,
    summary: event.summary ?? card.summary,
    outcome: event.outcome,
    detail: event.detail,
    diff: event.diff,
    ...(humanWaitOf(event.humanWaitMs) ? { humanWaitMs: humanWaitOf(event.humanWaitMs) } : {}),
  };
}

function chatReasoningKey(agentId: string): string {
  return `${CHAT_REASONING_KEY_PREFIX}${agentId}`;
}

function serializeReasoningItems(items: ChatReasoning[], limit = CHAT_REASONING_LIMIT): ChatReasoning[] {
  return trimTransientItems(items.filter((item) => item.text.trim()).map(normalizeReasoningItem), limit);
}

function deserializeReasoningItems(value: unknown, limit = CHAT_REASONING_LIMIT): ChatReasoning[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ChatReasoning[] = [];
  for (const item of value) {
    const parsed = parseReasoningItem(item);
    if (parsed) {
      out.push(parsed);
    }
  }
  return trimTransientItems(out, limit);
}

function parseReasoningItem(value: unknown): ChatReasoning | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Partial<ChatReasoning>;
  if (typeof candidate.text !== 'string') {
    return undefined;
  }
  return normalizeReasoningItem({
    kind: 'reasoning',
    id: typeof candidate.id === 'string' ? candidate.id : `reason-${Math.random().toString(36).slice(2)}`,
    ts: typeof candidate.ts === 'string' ? candidate.ts : new Date(0).toISOString(),
    seq: normalizeSeq(candidate.seq),
    text: candidate.text,
  });
}

function normalizeReasoningItem(item: ChatReasoning): ChatReasoning {
  return {
    kind: 'reasoning',
    id: String(item.id),
    ts: item.ts || new Date(0).toISOString(),
    seq: normalizeSeq(item.seq),
    text: String(item.text),
  };
}

/**
 * Keep streamed reasoning readable without rewriting its words. Gateways may send indentation and line
 * breaks as separate deltas, so this is stateful across the already accepted text: leading whitespace is
 * ignored, indentation before real content is preserved, and a run of blank lines is capped at one.
 *
 * One thing is added: a gateway that relays reasoning summaries part by part sends each part's bold title with
 * nothing between one part and the next, so the titles read as one run-together line. A bold run that begins
 * directly after another has ended starts a paragraph of its own.
 */
function boundedReasoningDelta(existing: string, delta: string): string {
  let lineBreaks = existing.trim() ? trailingLineBreaks(existing) : 2;
  // The line being written. The markers of a title can arrive split over several deltas.
  let line = lineBreaks > 0 ? '' : existing.slice(existing.lastIndexOf('\n') + 1);
  let pendingIndent = '';
  let out = '';
  for (const char of delta.replace(/\r/g, '')) {
    if (char === '\n') {
      pendingIndent = '';
      line = '';
      if (lineBreaks < 2) {
        out += '\n';
        lineBreaks++;
      }
      continue;
    }
    if ((char === ' ' || char === '\t') && lineBreaks > 0) {
      pendingIndent += char;
      continue;
    }
    if (pendingIndent) {
      out += pendingIndent;
      line += pendingIndent;
      pendingIndent = '';
    }
    if (char === '*' && endsWithClosedStrongRun(line)) {
      out += '\n\n';
      line = '';
    }
    out += char;
    line += char;
    lineBreaks = 0;
  }
  return out;
}

/** `**title**` at the end of a line, with every bold run on that line closed. `***both***` is not one. */
function endsWithClosedStrongRun(line: string): boolean {
  return /(?:^|[^*])\*\*[^*]+\*\*$/.test(line) && (line.match(/\*\*/g)?.length ?? 0) % 2 === 0;
}

function trailingLineBreaks(text: string): number {
  let count = 0;
  for (let index = text.length - 1; index >= 0 && count < 2; index--) {
    const char = text[index];
    if (char === '\n') {
      count++;
    } else if (char !== ' ' && char !== '\t' && char !== '\r') {
      break;
    }
  }
  return count;
}

/**
 * v0.9.91: finish the card this result belongs to, found by its host call id within its own turn. Call ids restart
 * every turn, so a card still pending from an earlier turn is never finished by a later call with the same id. A
 * result with no pending card of its own is shown as its own card; it never borrows another card by tool name.
 */
function finishPendingTool(
  current: ChatToolActivity[],
  event: Extract<ChatToolEvent, { phase: 'result' }>,
  turnEpoch: number,
): { next: ChatToolActivity[]; item: ChatToolActivity } {
  const next = [...current];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].phase === 'use' && next[i].callId !== undefined && next[i].callId === event.callId
        && next[i].turnEpoch === turnEpoch) {
      next[i] = { ...withToolResult(next[i], event), completedAt: new Date().toISOString() };
      return { next, item: next[i] };
    }
  }
  const unmatched = toolActivityFromEvent(event, turnEpoch);
  return { next: [...next, unmatched], item: unmatched };
}

function trimTransientItems<T>(items: T[], limit = CHAT_TRANSIENT_ITEM_LIMIT): T[] {
  return items.slice(-limit);
}

function isFiniteSeq(seq: unknown): seq is number {
  return typeof seq === 'number' && Number.isFinite(seq) && seq >= 0;
}

function normalizeSeq(seq: unknown): number | undefined {
  return isFiniteSeq(seq) ? Math.floor(seq) : undefined;
}

function formatToolInput(input: unknown): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export function attachmentMetadata(attachments: readonly UserAttachment[]): ChatHistoryAttachment[] | undefined {
  // A local PDF has a temporary content-asset receipt, not durable attachment
  // metadata. In particular its filename must never become chat history.
  const meta: ChatHistoryAttachment[] = attachments.filter((a) => a.kind !== 'pdf').map((a) => ({
    name: a.name,
    mime: a.mime,
    kind: a.kind === 'image' ? 'image' : 'file',
    size: a.size,
    thumbnailDataUrl: a.kind === 'image' ? a.thumbnailDataUrl : undefined,
  }));
  return meta.length > 0 ? meta : undefined;
}

function normalizeChatMode(mode: unknown): ChatMode {
  return mode === 'plan' ? 'plan' : 'act';
}

/**
 * Per-coordinator count of delegations still WORKING. After v0.9.28 a PM releases its turn on an async
 * dispatch, so while a teammate works the PM is genuinely idle and the composer correctly says 'Send'. Without
 * this count the PM looks completely idle and then springs to life on the auto-wake — correct behavior that
 * reads as a glitch. Zero in-flight work MUST produce no entry, or the hint sticks forever.
 */
/**
 * The delegations a coordinator still has out, with the time each one started.
 *
 * A coordinator in delegate mode is idle by design — it dispatched and ended its turn — so the running
 * indicator, which keys off `runningAgentIds`, showed nothing at all. From the user's side that is
 * indistinguishable from a crew that has stopped. Claude keeps a verb and an ellipsis moving; Codex keeps a
 * clock; this surface had one for its own turns and nothing for the state it spends most of its time in.
 *
 * A count would not have been enough. "3 out" says work exists; it does not say which teammate has been
 * quiet for four minutes, which is the thing a person is actually watching for.
 */
export function delegatingOutFrom(
  summaries: readonly DelegationProgressSummary[],
): Record<string, { agentName: string; startedAt: string }[]> {
  const out: Record<string, { agentName: string; startedAt: string }[]> = {};
  for (const summary of summaries) {
    for (const item of summary.items) {
      if (item.status !== 'working') { continue; }
      (out[item.coordinatorId] ??= []).push({ agentName: item.agentName, startedAt: item.startedAt });
    }
  }
  // Longest-waiting first: the one that has been out the longest is the one worth looking at.
  for (const list of Object.values(out)) {
    list.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  }
  return out;
}

export function delegatingCountsFrom(summaries: readonly DelegationProgressSummary[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const summary of summaries) {
    if (summary.working > 0) {
      counts[summary.coordinatorId] = (counts[summary.coordinatorId] ?? 0) + summary.working;
    }
  }
  return counts;
}

/**
 * Transcript nodes are keyed for incremental DOM updates. Completion counters alone do not change when a
 * worker publishes `task.status`, which previously caused the old card to be reused and hid the activity.
 */
export function delegationRenderKey(summary: DelegationProgressSummary): string {
  const itemState = summary.items.map((item) => [
    item.id,
    item.status,
    item.completionState ?? '',
    item.activity ?? '',
    item.phase ?? '',
    item.scope ?? '',
    item.updatedAt ?? '',
    item.completedAt ?? '',
    item.result ?? '',
    item.evidenceOutcome ?? '',
    item.coordinatorDisposition ?? '',
    item.dispositionReason ?? '',
    item.dispositionAt ?? '',
    item.amendedFrom ?? '',
    item.reworkReplyAt ?? '',
  ].join('\u0001')).join('\u0002');
  return `delegation:${summary.id}:${summary.done}:${summary.partial}:${summary.blocked}:${summary.working}:${summary.closeoutCompletionState ?? ''}:${itemState}`;
}

/** Largest tool detail/diff we keep in the transcript. Big enough to read, small enough that re-serializing
 *  the transcript on every state push cannot blow the shared extension host's heap. */
const MAX_TOOL_DETAIL_CHARS = 32_000;

/**
 * Bound a tool event's heavy payloads before they enter the transcript (which is persisted AND re-serialized
 * into every webview state push). Without this, one huge tool result is copied on every subsequent update.
 */
export function capToolPayload(event: ChatToolEvent): ChatToolEvent {
  if (event.phase !== 'result') {
    return event;
  }
  const detail = clampText(event.detail, MAX_TOOL_DETAIL_CHARS, 'output');
  const diff = clampText(event.diff, MAX_TOOL_DETAIL_CHARS, 'diff');
  if (detail === event.detail && diff === event.diff) {
    return event;
  }
  return { ...event, detail, diff };
}
