/*---------------------------------------------------------------------------------------------
 *  UnodeAi - AgentBackend
 *  Transport-agnostic contract for "how a single agent session actually runs".
 *
 *  v1 ships ClaudeHeadlessBackend (spawns `claude` in stream-json mode). Future backends
 *  (codex, gemini, raw provider API) implement the same interface so SessionManager and the
 *  rest of the extension never care how an agent is powered.
 *--------------------------------------------------------------------------------------------*/

import { AgentConfig, AgentModelParams, ChatMode, ContextWindowUsage, TaskWorkspaceAccess, UserAttachment } from '../types';
import type { ContextControl, ContextProjection } from './ContextControl';
import type { ResolvedSmartCompactionPolicy } from '../compaction/SmartCompactionPolicy';
import type { DelegationContentSource, TurnContextManifest } from '../session/TurnContextManifest';
import type { VerificationPlan } from './VerificationPlan';
import type { TaskAttemptCard, TaskContextGap, ReadyTaskArtifact, InputGrant } from './TaskContract';
import type { TurnDelegationReceipt } from './TeamTools';
import type { ToolResultFact } from './toolSummary';

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
  | { kind: 'assistant_delta'; delta: string }
  | { kind: 'reasoning_delta'; delta: string }
  | { kind: 'assistant'; text: string }
  /**
   * Host-authored per-turn coordinator dispatch accounting. The typed counts travel to the conclusion footer; the
   * text is only for the output log. `turn` is TeamTools' turn sequence, used to match a late change.
   */
  | { kind: 'delegation_receipt'; text: string; receipt: { turn: number; accepted: number; refused: number; pending: number } }
  /** One host-observed attempt to contact the model provider. Observational only; it does not alter retries. */
  | { kind: 'model_request' }
  /**
   * One completed OpenAI-compatible provider response that reported its own usage (v0.9.89 §9). `attempt` is the
   * ordinal of the `model_request` that produced it in this turn. Observational only: spend reminders read it and
   * the next provider request never waits for them. Reconstructed or partial usage is never sent this way.
   */
  | { kind: 'usage_progress'; attempt: number; inputTokens: number; cachedInputTokens?: number; outputTokens: number }
  /** `callId` is the host's turn-local identity for the call (`TurnToolCallIds`), never a provider id. */
  | { kind: 'tool_use'; callId: string; name: string; input: unknown }
  /**
   * `outcome` is the only truth about the result (v0.9.91): no `ok` or failure label travels beside it. Summary,
   * detail and diff are bounded presentation and are never read back into the outcome.
   */
  | { kind: 'tool_result'; callId: string; name: string; outcome: ToolResultFact; summary: string; detail?: string; diff?: string }
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
  | { kind: 'error'; message: string }
  | { kind: 'exit'; code: number | null };

/**
 * Outcome of one user turn (one task handed to the agent).
 */
export interface TurnResult {
  /** Final assistant text for the turn, if the backend surfaces one. */
  text: string;
  isError: boolean;
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
  | { kind: 'host-deadline'; deadline: 'first-action' };

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
  /** v2 makes messages an independently bounded durable record; v1 remains a valid lossy migration input. */
  version: 1 | 2;
  messages: unknown[];
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

  /** Spawn the underlying process. Resolves when the process has spawned (not necessarily ready). */
  start(env: NodeJS.ProcessEnv): Promise<void>;

  /** Hand the agent a user turn (task instruction + optional attachments). */
  sendUserTurn(instruction: string, attachments?: TurnAttachments): void;

  /** Gracefully terminate (SIGTERM), force-killing after `forceTimeoutMs`. */
  stop(forceTimeoutMs?: number): Promise<void>;

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

  /** Capture the agent's conversation so it can be restored later. Optional per backend. */
  snapshot?(): ConversationSnapshot | undefined;

  /** Seed the agent's conversation from a prior snapshot. Call BEFORE start(). Optional. */
  restore?(snapshot: ConversationSnapshot): void;

  /** Estimated context this backend is carrying, including whether its window was measured or assumed. */
  contextUsage?(): ContextWindowUsage;
  /**
   * v0.9.90: projection of the next request and the backend's own compaction. SessionManager's pre-dispatch
   * gate and manual Compact use it; `contextUsage` remains the composer meter's reading of held history.
   */
  readonly contextControl?: ContextControl;
}

export interface TurnAttachments {
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
  /** Host-selected per-task contract. Undefined preserves the legacy workspace-level behavior. */
  verificationPlan?: VerificationPlan;
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
