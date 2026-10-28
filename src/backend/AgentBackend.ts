/*---------------------------------------------------------------------------------------------
 *  UnodeAi - AgentBackend
 *  Transport-agnostic contract for "how a single agent session actually runs".
 *
 *  v1 ships ClaudeHeadlessBackend (spawns `claude` in stream-json mode). Future backends
 *  (codex, gemini, raw provider API) implement the same interface so SessionManager and the
 *  rest of the extension never care how an agent is powered.
 *--------------------------------------------------------------------------------------------*/

import type { ToolInputProgress } from './ToolInputProgress';
import type { PinMode } from '../host/cliRuntimePin';
import { AgentBackendKind, AgentConfig, AgentModelParams, ChatMode, ContextWindowUsage, TaskWorkspaceAccess, UserAttachment } from '../types';
import type { ContextControl, ContextProjection } from './ContextControl';
import type { ResolvedSmartCompactionPolicy } from '../compaction/SmartCompactionPolicy';
import type { ReadProjectionSidecar } from '../compaction/ReadProjectionSidecar';
import type { DelegationContentSource, TurnContextManifest } from '../session/TurnContextManifest';
import type { VerificationPlan } from './VerificationPlan';
import type { TaskAttemptCard, TaskContextGap, ReadyTaskArtifact, InputGrant } from './TaskContract';
import type { ReviewEvidenceState } from './ReviewEvidence';
import type { TurnDelegationReceipt } from './TeamTools';
import type { ToolResultFact } from './toolSummary';
import type { RequestComposition } from './RequestComposition';
import type { ResponseRetry } from './ResponseRetry';
import type { TurnInterruptionV1 } from './TurnInterruption';
import type { InterruptionDetail } from './InterruptionDetail';

/** v0.9.97: which provider report a live generated-token count came from. */
export type GenerationUsageSource = 'openai-compatible-response' | 'claude-stream-message' | 'codex-thread-usage';

/**
 * Normalized events every backend emits, regardless of the underlying CLI/protocol.
 * SessionManager translates these into session-status changes and MessageBus traffic.
 */
export type BackendEvent =
  | { kind: 'ready'; backendSessionId?: string; model?: string }
  /**
   * The backend has displayed a host-owned consent surface and is deliberately waiting for a
   * human decision before it can make an egressing start.  This is an acknowledgement, not a
   * terminal failure: SessionManager exposes it as an actionable lifecycle state while the
   * decision remains open.
   */
  | { kind: 'consent_required'; message: string }
  /**
   * v0.9.97: what a start that has not finished waits for now, such as the check of the program's files or the
   * person's answer to the adoption question. Shown on the agent's row while it is starting; the start's end,
   * whichever way, clears it.
   */
  | { kind: 'start_pending'; message: string }
  /** Received model output, including hidden reasoning/tool input. No content or action authority. */
  | { kind: 'provider_activity'; activity?: 'tool-input' | 'thinking' | 'output'; toolInput?: ToolInputProgress }
  /** No content/usage/action authority. Parser matches the actual native operation before emitting this. */
  | { kind: 'provider_compaction'; phase: 'started' | 'finished' }
  | { kind: 'assistant_delta'; delta: string }
  /** A real same-response resend. Segments the transcript, never a terminal/tool/usage observation. */
  | { kind: 'response_retry'; retry: ResponseRetry }
  | { kind: 'reasoning_delta'; delta: string }
  | { kind: 'assistant'; text: string }
  /** Host-authored, non-modal transcript line; never assistant text or a terminal outcome. */
  | { kind: 'runtime_notice'; text: string }
  /**
   * Host-authored per-turn coordinator dispatch accounting. The typed counts travel to the conclusion footer; the
   * text is only for the output log. `turn` is TeamTools' turn sequence, used to match a late change.
   */
  | { kind: 'delegation_receipt'; text: string; receipt: { turn: number; accepted: number; refused: number; pending: number } }
  /** Host-observed send. The optional per-response transport fact selects the silence budget, never retries.
   * Missing visibility retains the route default; it is not proof that a streaming gateway exposes every token. */
  | { kind: 'model_request'; outputVisibility?: 'streaming' | 'buffered' }
  /** Private numeric diagnostics for an actual send. Never forwarded as session output or persisted. */
  | { kind: 'request_composition'; attempt: number; measurement?: RequestComposition }
  /**
   * v0.9.99: the backend has invoked its provider transport for this attempt (emitted right after the call, before
   * awaiting it). Work that must never go out ahead of the turn's own request waits for this.
   */
  | { kind: 'provider_request_started'; attempt: number }
  /**
   * One completed OpenAI-compatible provider response that reported its own usage (v0.9.89 §9). `attempt` is the
   * ordinal of the `model_request` that produced it in this turn. Observational only: spend reminders read it and
   * the next provider request never waits for them. Reconstructed or partial usage is never sent this way.
   */
  | { kind: 'usage_progress'; attempt: number; inputTokens: number; cachedInputTokens?: number; outputTokens: number }
  /**
   * v0.9.97: generated tokens the provider reported while the turn runs, for the saved-batch hint only; spend never
   * reads it. `unit` names one provider response or message (or the turn, for a running total); a repeated report of
   * a unit replaces its earlier figure and is never added to it. Input and cache tokens are not generated and never
   * appear here, and no count is reconstructed: a route that reports nothing sends nothing.
   */
  | { kind: 'generation_usage'; source: GenerationUsageSource; unit: string; outputTokens: number; reasoningTokens?: number }
  /** `callId` is the host's turn-local identity for the call (`TurnToolCallIds`), never a provider id. */
  | { kind: 'tool_use'; callId: string; name: string; input: unknown }
  /**
   * `outcome` is the only truth about the result (v0.9.91): no `ok` or failure label travels beside it. Summary,
   * detail and diff are bounded presentation and are never read back into the outcome.
   */
  | { kind: 'tool_result'; callId: string; name: string; outcome: ToolResultFact; summary: string; detail?: string; diff?: string;
      documentWrite?: import('../content/document/DocumentWrite').DocumentWriteFact;
      /** Only a successful host reader may supply it. No text/output/argument is used to reconstruct it. */
      read?: { path?: string } }
  /**
   * The host decided a tool call (a refusal, or a bridge tool's typed result) but the request did not identify
   * which call, so the decision could not be joined to its result. The turn's tool coverage is partial.
   */
  | { kind: 'tool_coverage_gap'; reason: 'host-decision-unjoined' }
  /** Codex-owned native MCP visibility only. Never contributes UnodeAi work or verification evidence. */
  | { kind: 'native_mcp_activity'; callId: string; server: string; tool: string; status: 'inProgress' | 'completed' | 'failed' }
  /** Visible audit trail emitted by Codex's Approve-for-me reviewer. */
  | { kind: 'approval_review'; phase: 'started' | 'completed'; action: string; status?: string; rationale?: string }
  /** A host-owned user decision surface is open (or has just closed). */
  /** A CLI turn missed its first-material-output or later material-output deadline. */
  | { kind: 'watchdog_idle'; idleMs: number }
  /**
   * A provider refused a request for size, and that refusal has been turned into an upper bound on this
   * model's usable window. Emitted only when the bound is NEW and TIGHTER than what the guard already
   * believed — a repeat overflow at an already-known size is not news and must not churn persistence.
   */
  | { kind: 'context_overflow'; model: string; tokens: number; observedAt: string }
  /**
   * v0.9.90: the runtime compacted its own conversation inside a turn (Claude's in-turn threshold). Never emitted
   * for a compaction the host asked for; that one resolves `contextControl.compact` instead.
   */
  | {
      kind: 'native_compaction';
      operationId: string;
      trigger: 'auto';
      before: ContextProjection;
      after: ContextProjection;
      summary?: string;
      /** The policy the runtime was started with, for a reproducible receipt. */
      policy?: ResolvedSmartCompactionPolicy;
    }
  /** Every live terminal path states what the provider delivered (v0.9.91 §4.3). */
  | { kind: 'turn_complete'; result: LiveTurnResult }
  | { kind: 'log'; stream: 'stdout' | 'stderr'; line: string }
  /**
   * v0.9.96: the model the CLI itself says it runs, from its own start event. It may differ from the requested model
   * (an alias, or a provider remapping it). Never filled from the requested model, a default or a guess.
   */
  | { kind: 'model_observed'; model: string }
  /**
   * v0.9.97: the route handed this turn's input to its transport and the transport took it: Claude's stdin got the
   * packet, the provider answered the first request with a success status, App Server accepted `turn/start`.
   * `userAttachments` are positions in `input.userAttachments` of the attachments that payload really carried;
   * `delegatedSources` are the asset ids of delegated sources it carried inline. Anything not named was not sent,
   * and the host never lists it as attached. `input` is the object the turn was sent with, so a late report of an
   * earlier turn cannot be taken for the present one.
   */
  | { kind: 'turn_input_delivered'; input: TurnAttachments; userAttachments: readonly number[]; delegatedSources?: readonly string[] }
  | { kind: 'error'; message: string }
  /**
   * The backend's process ended. v0.9.97 (D11): `treeSeenStopped` is true only when the backend saw every process it
   * had started end. Without it, an end no stop of the host caused is an unconfirmed stop: what the process started
   * may still be running, so the host starts nothing of this agent by itself.
   */
  | { kind: 'exit'; code: number | null; treeSeenStopped?: true };

/**
 * Outcome of one user turn (one task handed to the agent).
 */
export interface TurnResult {
  /** Final assistant text for the turn, if the backend surfaces one. */
  text: string;
  isError: boolean;
  /** Source-owned, content-free interruption fact. Failure semantics are unchanged. */
  interruption?: TurnInterruptionV1;
  /** Host-private live diagnostics. Session must not copy this into any terminal bus payload or stored record. */
  interruptionDetail?: InterruptionDetail;
  usage?: TurnUsage;
  context?: TurnContext;
  /**
   * Framework-observed work evidence for this turn.  This is deliberately separate from the
   * agent's final text: coordinators use it to decide whether a delegated reply is trustworthy.
   */
  delegationEvidence?: DelegationTurnEvidence;
  /**
   * The assistant turn ended, but its assigned task remains unresolved. This is intentionally
   * independent of `isError`: a coordinator may have a useful partial answer while a blocking
   * delegation is still outstanding after its wait timed out.
   */
  unresolvedReason?: 'delegation-timeout';
  /**
   * A host safety boundary ended this turn before the assigned task was complete.  This is neither a
   * successful completion nor a worker failure.  A coordinator may continue it on the same conversation.
   */
  stop?: {
    state: 'stopped';
    reason: 'step-safety-limit' | 'anti-spin' | 'budget';
    steps: number;
    lastActivity: string;
  };
  /** Exact host-declared workflow label selected through a structured tool, if any. */
  workflowBranchLabel?: string;
  /** Host-published exact content inside `text` (v0.9.88 §5.5); absent when the reply claims none. */
  verbatim?: TurnVerbatim;
  /**
   * v0.9.90: what the provider delivered, classified by the backend from protocol events before any host-authored
   * text was appended. Consumers read this instead of inferring an empty reply from `text`. Records restored from
   * before v0.9.90 omit it.
   */
  responseOutcome?: TurnResponseOutcome;
}

/**
 * v0.9.91: a turn result as a backend emits it live. The delivery outcome is required, so a new terminal path
 * cannot leave it out; only data restored from before v0.9.90 lacks it (see RestoredTurnDelivery).
 */
export interface LiveTurnResult extends Omit<TurnResult, 'responseOutcome'> {
  responseOutcome: TurnResponseOutcome;
}

/**
 * A restored turn's delivery. Records from before v0.9.90 are `legacy-unclassified`; their text and `isError`
 * are never used to reconstruct a kind.
 */
export type RestoredTurnDelivery =
  | { classification: 'typed'; outcome: TurnResponseOutcome }
  | { classification: 'legacy-unclassified' };

/**
 * v0.9.90: the route-normalized delivery outcome of one turn. `empty-reply` means every attempt completed
 * successfully with no visible assistant text and no tool call; hidden reasoning is not a visible reply.
 * `tool-only` is a turn that did work but ended without final text.
 *
 * `host-deadline` (v0.9.93) is a turn the host ended because a deadline of its own passed: the provider sent
 * nothing for the first-action budget of a coordinator's turn. No backend reports it; the session does. It is not
 * `stopped`: a deliberate stop publishes no terminal message, and this one publishes exactly one.
 */
export type TurnResponseOutcome =
  | { kind: 'reply' }
  | { kind: 'tool-only' }
  | { kind: 'empty-reply'; attempts: EmptyReplyAttempt[] }
  | { kind: 'error' }
  | { kind: 'stopped' }
  | { kind: 'host-deadline'; deadline: 'first-action' | 'native-compaction' };

/** One provider attempt that completed with nothing visible, with the facts observed about it. */
export interface EmptyReplyAttempt {
  attempt: number;
  inputTokens?: number;
  inputBasis: 'reported' | 'reconstructed' | 'unavailable';
  outputTokens?: number;
  /** The route's own terminal signal: `finish_reason`, the result subtype, or the turn status. */
  finishSignal?: string;
  /** Which route produced it, for example an OpenAI-compatible connection, `claude-cli` or `codex-app-server`. */
  gateway: string;
  upstreamProvider?: string;
  responseId?: string;
}

/**
 * Where a content receipt's exact text sits in a reply, in UTF-16 code units of that reply, and whether the model
 * published only a prefix of it. Text the host appends later (a hook notice) always sits after the span.
 */
export interface TurnVerbatim {
  start: number;
  length: number;
  partial?: true;
}

/** Evidence gathered by the host while an agent turn ran, never supplied by the model itself. */
export interface DelegationTurnEvidence {
  /** The agent invoked at least one framework-visible tool during the turn. */
  hadToolActions: boolean;
  /** Paths reported by successful CheckpointRecorder writes during the turn. */
  changedFiles: string[];
  /** A backend observed a potentially mutating native tool but has no CheckpointRecorder record for it. */
  unrecordedWrites?: boolean;
  /**
   * File changes the host refused during the turn and that no later call of the turn carried out, counted by
   * target. A refused command is not counted: the host cannot tell whether it would have changed anything.
   */
  refusedEffects?: number;
  /** Objective verification observed by the framework (run_checks or the completion gate). */
  verification?: {
    ran: boolean;
    passed: boolean;
    command?: string;
    /** Which framework observation produced this result; legacy records omit it. */
    source?: 'run-checks' | 'command-exit-zero' | 'completion-gate';
  };
  /** Post-write diagnostic observation, separate from a command result. */
  diagnostics?: { observed: boolean; clean: boolean };
  /** Separate task states and explicit artifact receipts; neither is inferred from reply prose. */
  contextGaps?: TaskContextGap[];
  taskArtifacts?: ReadyTaskArtifact[];
  /** Host observations only: supplied/reachable/read. "Understood" is never inferred. */
  inputGrants?: InputGrant[];
  /**
   * v0.9.94: for an admitted review only. Either the bounded receipt of evidence whose citations the host checked
   * against this attempt's own reads and searches, or the explicit fact that none was submitted. It holds counts and
   * the coverage the reviewer reported, never text.
   */
  reviewEvidence?: ReviewEvidenceState;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * The part of `inputTokens` the provider served from its prefix cache — a SUBSET, not an addition.
   * A cache hit costs roughly a tenth of a miss, so pricing every input token as a miss (what we did until
   * now) can overstate the bill ~10x. Undefined = the gateway reported nothing, so the hit rate is unknown;
   * that is different from a known zero and must not be rendered as "0% cached".
   */
  cachedInputTokens?: number;
  /**
   * TRUE when these numbers were RECONSTRUCTED rather than reported: a gateway that relays Anthropic's
   * inverted units (see reconcileUsage), or one that streams no usage chunk at all. We lean the estimate high
   * because under-reporting money is worse than over-reporting it — but an estimate is not a bill, and
   * without the model's own tokenizer no character heuristic can be a true bound. So say so, all the way to
   * the Dashboard, instead of dressing a guess up as an invoice. (Codex, v0.9.29 review.)
   */
  estimated?: boolean;
  /**
   * How these numbers were obtained (v0.9.89). `reported`: every figure came from the provider unchanged.
   * `reported-partial`: a stopped response contributed a usage chunk seen before it completed.
   * `reconstructed`: some figure was estimated. Absent: read `estimated` (true means `reconstructed`).
   */
  usageBasis?: 'reported' | 'reported-partial' | 'reconstructed';
  /** Reasoning tokens reported inside `outputTokens` (a subset), when the provider separates them. */
  reasoningOutputTokens?: number;
  /**
   * How many of this turn's provider attempts the totals account for. Fewer than the observed `model_request`
   * events means some attempt's usage could not be attributed. Absent: every attempt is accounted for.
   */
  attributedAttempts?: number;
  /** USD cost for the turn if the backend reports it. */
  costUsd?: number;
  /** Whether costUsd is actually billed or only an API-equivalent estimate. */
  costBasis?: 'billed' | 'api-equivalent';
}

/** The usage basis of a turn, normalizing the pre-v0.9.89 `estimated` flag. */
export function turnUsageBasis(usage: TurnUsage): 'reported' | 'reported-partial' | 'reconstructed' {
  return usage.usageBasis ?? (usage.estimated ? 'reconstructed' : 'reported');
}

export interface TurnContext extends ContextWindowUsage {}

export type BackendEventHandler = (event: BackendEvent) => void;

/** The one shape every backend emits for a coordinator turn's dispatch receipt. */
export function delegationReceiptEvent(receipt: TurnDelegationReceipt): BackendEvent {
  return {
    kind: 'delegation_receipt',
    text: receipt.text,
    receipt: { turn: receipt.turn, accepted: receipt.accepted, refused: receipt.refused, pending: receipt.pending },
  };
}

/**
 * Host-owned model-egress consent.  The backend calls `onPending` as soon as the visible human
 * decision has been opened, then waits for the decision without imposing a short human timeout.
 * This is the same split-clock contract as the P0 approval path: acknowledge lifecycle progress
 * immediately, while allowing a person as long as they need to read the prompt.
 */
export interface EgressConsentPending {
  host: string;
  message: string;
}

export type EgressConsentGate = (onPending: (pending: EgressConsentPending) => void) => Promise<void>;

/** A human refusal is terminal policy, never a retryable transport or request-shape error. */
export class EgressConsentDeclinedError extends Error {
  readonly code = 'UNODE_EGRESS_CONSENT_DECLINED';

  constructor(readonly host: string, message?: string) {
    super(message ?? `Network egress to ${host} was declined — no prompt or code was sent. Approve the provider to use it.`);
    this.name = 'EgressConsentDeclinedError';
  }
}

export function isEgressConsentDeclined(error: unknown): error is EgressConsentDeclinedError {
  return error instanceof EgressConsentDeclinedError
    || (!!error && typeof error === 'object'
      && (error as { code?: unknown }).code === 'UNODE_EGRESS_CONSENT_DECLINED');
}

/**
 * Serializable conversation state for an agent, so its context survives a restart/crash
 * (L2 recovery). Opaque `messages` — each backend owns its own wire format.
 */
export interface ConversationSnapshot {
  /**
   * v3 adds the host turn marker and the completed-message boundary. v2 made messages an independently bounded
   * durable record; v1 and v2 remain valid migration inputs, and neither says whether its last request finished.
   */
  version: 1 | 2 | 3;
  /**
   * v0.9.94: the backend kind that wrote this snapshot. `messages` is private to that kind: a Codex snapshot holds
   * a reference to its thread and no chat message, and nothing in one kind's snapshot can be continued by
   * another. A snapshot from before this field has none; the backend it is offered to then decides by what the
   * snapshot holds.
   */
  backend?: AgentBackendKind;
  messages: unknown[];
  /**
   * v3: whether the host saw the agent's last request to its terminal outcome. The session writes it, never the
   * backend: `incomplete` before a request is handed to the backend, `complete` once the host has seen that
   * request end. A record read back as `incomplete` was cut off with its host, so nothing in it proves that the
   * request finished. That holds for a backend whose conversation the provider keeps as well: the provider may
   * have accepted the request before the host was gone.
   */
  hostTurnState?: HostTurnState;
  /**
   * v3, for a backend that keeps its messages: how many leading entries of `messages` belong to requests that
   * were answered. What follows is a request without an answer. A restore continues the leading entries only.
   */
  completedMessageCount?: number;
  /**
   * What this session PROVED about how each gateway reports usage. See `reconcileUsage`.
   *
   * A FACT, and only a fact: does `prompt_tokens` mean the whole input (`inclusive`, as every
   * OpenAI-compatible gateway means it) or only the part that MISSED the cache (`exclusive`, which is what
   * Anthropic's `input_tokens` means and what a relay reports when it forgets to add `cache_read` back)?
   * Nothing about the conversation can change the answer, so nothing about the conversation can stale it.
   *
   * Keyed by ROUTE (`baseUrl|model`), because the answer belongs to the gateway, not to the agent: Smart
   * Mode, a fallback escalation, or an Agent Builder edit can move the same conversation onto a model none of
   * this was proved about, and reusing the verdict there would fabricate cache hits on a gateway that did
   * nothing wrong.
   *
   * Deliberately NOT carried: any numeric baseline. An earlier design persisted a "prompt floor" too, and
   * every way that floor could go stale — a trim, a compaction, a restore, a model switch — was a way to
   * invent cache or to lose it. Persisting half a proof and calling it a fact cost a review round on its own.
   * (Codex, v0.9.29 review.)
   */
  usageBaseline?: {
    routes: Array<{ route: string; semantics: 'inclusive' | 'exclusive' }>;
  };
  /**
   * v0.9.90: the provider history after a compaction (rolling summary, carried records, kept turns). `messages`
   * stays the complete record for logs and chat; the next request is built from this. Absent while nothing has
   * been compacted, and ignored by builds that predate it (they rebuild from `messages`).
   */
  providerHistory?: unknown[];
  /** v3: the same boundary as `completedMessageCount`, in `providerHistory`. */
  providerCompletedMessageCount?: number;
  /** v3: what the last restore kept out of the conversation. Evidence for the host; no request carries it. */
  quarantined?: QuarantinedConversationTail;
  /**
   * v0.9.99: turn identity and read provenance of `messages` and `providerHistory`, beside them so a build that does
   * not know them never sends them. Validated against each stored message on restore; ignored by older builds.
   */
  readProjection?: ReadProjectionSidecar;
}

/** Whether the host saw an agent's last request to its terminal outcome. */
export type HostTurnState = 'complete' | 'incomplete';

/**
 * Why a restore kept part of a stored conversation out of the one it continued. Codes for the log, read from
 * the record's structure and its marker and never from what a message says.
 * - `host-turn-incomplete`: the marker does not say that the last request reached its terminal outcome;
 * - `unfinished-tail`: messages follow the completed boundary;
 * - `legacy-unfinished-tail`: a record from before the boundary ends on a request without an answer;
 * - `boundary-invalid`: the stored boundary is missing or does not sit at the end of an answered request, so the
 *   record was read by its structure;
 * - `legacy-thread`: a provider-kept conversation from before the marker, whose last request may be unfinished.
 */
export type ConversationQuarantineReason =
  | 'host-turn-incomplete'
  | 'unfinished-tail'
  | 'legacy-unfinished-tail'
  | 'boundary-invalid'
  | 'legacy-thread';

/** The unanswered end of a stored conversation, kept apart from it within a storage bound. */
export interface QuarantinedConversationTail {
  reasons: ConversationQuarantineReason[];
  /** How many messages the tail held. */
  messageCount: number;
  /** Its first messages, as many as the bound allows. */
  messages: unknown[];
}

/** What a restore left out of the conversation it continued, in counts and reason codes. */
export interface ConversationRestoreReport {
  /**
   * `interrupted`: the host marker says the last request was cut off with its host. `unanswered`: the record
   * ends on a request without an answer and nothing says it was cut off; it may have failed, or it is from
   * before the marker. `legacy-unknown`: the record is from before the marker and its conversation cannot be
   * inspected, so whether its last request finished is not known.
   */
  notice: 'interrupted' | 'unanswered' | 'legacy-unknown';
  reasons: ConversationQuarantineReason[];
  /** Messages kept out of the conversation. */
  quarantinedMessages: number;
  /** Messages the backend continues from. */
  restoredMessages: number;
}

/**
 * v0.9.97: what a backend observed when it stopped. A wrapper or launcher that ended says nothing about the processes
 * it started, so `stopped` is true only when the whole tree the backend started was seen to stop, or it ran none.
 */
export interface BackendStopOutcome {
  stopped: boolean;
  /** Host-authored: why the stop could not be confirmed. */
  detail?: string;
}

/** Who asked for a backend start; CLI backends pin their program by it, the others ignore it. */
export interface BackendStartLaunch {
  pin: PinMode;
}

/**
 * One running (or runnable) agent process.
 *
 * Lifecycle: `start()` spawns the process and resolves once it is ready to accept turns.
 * `sendUserTurn()` hands the agent a task (a natural-language instruction, optionally with
 * file/context attachments). Results come back asynchronously via the event handler as a
 * `turn_complete` event, which SessionManager republishes onto the MessageBus.
 */
export interface AgentBackend {
  readonly agentId: string;

  /** Register the single event sink. Returns a disposer. */
  onEvent(handler: BackendEventHandler): () => void;

  /**
   * Spawn the underlying process. Resolves when the process has spawned (not necessarily ready). `launch.pin` says
   * whether this start may choose the CLI program afresh (`take`) or must start the session's pinned one (`reuse`).
   */
  start(env: NodeJS.ProcessEnv, launch: BackendStartLaunch): Promise<void>;

  /** Hand the agent a user turn (task instruction + optional attachments). */
  sendUserTurn(instruction: string, attachments?: TurnAttachments): void;

  /**
   * Terminate the backend. v0.9.97: a backend that runs a process says what it observed of that stop
   * (`BackendStopOutcome`); one that runs no process outside the extension host may resolve to nothing.
   */
  stop(forceTimeoutMs?: number): Promise<void | BackendStopOutcome>;

  /** Best-effort cancellation of the current turn. Optional per backend. */
  abort?(): void;

  /**
   * G-001 mid-run steering: queue a user message into the CURRENTLY RUNNING turn. It is folded in at the
   * next safe point (the top of the tool loop) and the agent re-plans from it. No-op when idle. Optional
   * per backend — the Claude backend omits it (it runs its own loop).
   */
  /** Fold a user message into the CURRENT turn. Returns false when the backend cannot take it right now
   *  (e.g. it is not actually mid-turn) so the caller can fall back and deliver it another way — a user
   *  message must never be dropped on the floor. */
  interject?(text: string): boolean;

  /** Switch the model used for subsequent turns (tier hot-swap / fallback escalation). The running
   *  backend holds its own config copy, so SessionManager must push the change here, not just into
   *  the stored config. Optional per backend (claude applies it on the next spawn). */
  setModel?(model: string): void;

  /** Whether the process is currently alive. */
  isAlive(): boolean;

  readonly pid: number | undefined;

  /** Exact per-session Claude integrations bridge used only to attribute managed-MCP audit events. */
  managedMcpBridgeId?(): string | undefined;

  /**
   * v0.9.94: the kind this backend writes into its snapshots, and the only kind it takes back. A backend with no
   * kind keeps no conversation across a start, so a stored snapshot is never its own.
   */
  readonly snapshotKind?: AgentBackendKind;

  /**
   * Capture the agent's conversation so it can be restored later. Optional per backend. The backend leaves
   * `hostTurnState` out: the session that stores the snapshot writes it.
   */
  snapshot?(): ConversationSnapshot | undefined;

  /**
   * Seed the agent's conversation from a prior snapshot. Call BEFORE start(). Optional.
   *
   * Returns false when the snapshot is refused: another kind wrote it, or it is not a record this backend can
   * continue. A refused snapshot changes nothing in the backend.
   *
   * A snapshot that is taken is not always continued whole. A request in it that was never answered is not
   * given back to the model, and a provider-kept conversation whose last request may be unfinished is not
   * resumed. `takeRestoreReport` says when that happened.
   */
  restore?(snapshot: ConversationSnapshot): boolean;

  /** What the last restore left out, once. Undefined when it continued everything it was given. */
  takeRestoreReport?(): ConversationRestoreReport | undefined;

  /** Estimated context this backend is carrying, including whether its window was measured or assumed. */
  contextUsage?(): ContextWindowUsage;
  /**
   * v0.9.90: projection of the next request and the backend's own compaction. SessionManager's pre-dispatch
   * gate and manual Compact use it; `contextUsage` remains the composer meter's reading of held history.
   */
  readonly contextControl?: ContextControl;

  /**
   * v0.9.97: how a delegated user source reaches this backend's model. Undefined: through the host's grant-checked
   * content reader tools, so the turn's manifest lists each forwarded source at dispatch. `inline`: the backend has
   * no such reader and puts a granted source into the turn's own input or not at all; the manifest then lists a
   * delegated source only once `turn_input_delivered` names it.
   */
  readonly delegatedSourceDelivery?: 'inline';
  /**
   * v0.9.99: false when the provider sends a tool call only once its arguments are complete, so nothing can be
   * shown while the model writes them. Undefined: argument text streams in as it is written.
   */
  readonly streamsToolInput?: false;
}

export interface TurnAttachments {
  /** Host-private, per-turn configuration snapshot. Never interpolate this object into prompts or persist it. */
  verificationEligibility?: import('./VerificationEligibilitySnapshot').VerificationEligibilitySnapshot;
  mode?: ChatMode;
  files?: string[];
  userAttachments?: UserAttachment[];
  /** Closed outcome vocabulary for the current workflow step. */
  workflowBranchLabels?: string[];
  /** Host-resolved, task-local filesystem ceiling. Absent restores the agent's configured authority. */
  taskWorkspaceAccess?: TaskWorkspaceAccess;
  context?: Record<string, unknown>;
  expectedOutput?: string;
  /** Per-turn model override. Used by OpenAI-compatible Smart Mode without mutating AgentConfig.model. */
  model?: string;
  /** Resolved model/sampling params for this turn (F2). Backends apply what they support. */
  modelParams?: AgentModelParams;
  /** Latest `.unode/rules.md` project memory for this turn (F4). */
  projectContext?: string;
  /** Host-owned disclosure record for this exact assembled turn. It is never injected into the model prompt. */
  contextManifest?: TurnContextManifest;
  /** Opaque user-source receipts available to a coordinator for this turn's delegations. */
  delegationContentSources?: DelegationContentSource[];
  /**
   * v0.9.97: the sources a coordinator handed to this agent with this assignment (a `task.assign` only). Unlike
   * `delegationContentSources`, which a user's turn also carries for the coordinator to forward, these are the
   * agent's own inputs. A backend with `delegatedSourceDelivery: 'inline'` reads them through the host's grant check
   * at send time and puts what it may read into the turn's input.
   */
  receivedContentSources?: DelegationContentSource[];
  /** Host-selected per-task contract. Undefined preserves the legacy workspace-level behavior. */
  verificationPlan?: VerificationPlan;
  /**
   * v0.9.99: set only for a turn the host itself started to deliver async delegation results, read from its typed
   * wake trigger. Numeric diagnostics attribute that turn's text to delegation results; nothing else reads it.
   */
  turnOrigin?: 'delegation-result';
  /** Host-compiled task card and attempt-bound input grants. Never supplied by the model directly. */
  taskAttempt?: TaskAttemptCard;
  /**
   * Cline #2: proactive workspace orientation for THIS turn — the active editor file (capped) + current
   * Error/Warning diagnostics, **pre-formatted host-side into a string**. Injected ephemerally into the
   * trailing request message (NOT persisted to history, so stale file content can't accumulate). Opt-in
   * (`unode.engine.workspaceContext`). Host formats the string; backend caps + injects. (Single contract:
   * string. If the host has structured data, format it before attaching.)
   */
  workspaceContext?: string;
}

/**
 * Factory signature — given an agent config, produce a backend instance.
 * Registered per `AgentConfig.backend` (defaults to 'claude').
 *
 * `launchId` names this one start of the agent's backend. The session that asked for the backend keeps the same
 * id, so a tool surface built here can say which launch a call came from, and a call of a process the session has
 * since ended or replaced is told apart from a call of the one it runs now.
 */
export type BackendFactory = (config: AgentConfig, launchId: string) => AgentBackend;
