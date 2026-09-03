import type { AgentRoute } from './routes/RouteContracts';
import type { ContextManifestSource, DelegationContentSource } from './session/TurnContextManifest';
import type { VerificationPlan } from './backend/VerificationPlan';

/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Multi-Agent AI Team for VS Code
 *  Core type definitions
 *--------------------------------------------------------------------------------------------*/

/**
 * Team configuration loaded from .teamrc / team.config.json
 */
export interface TeamConfig {
  version: '1.0';
  name: string;
  description?: string;
  members: AgentConfig[];
  workflows: WorkflowConfig[];
  settings: TeamSettings;
  /** 段2: team-level MCP server registry. Agents reference these by id (default-deny). */
  mcpServers?: MCPServerConfig[];
  /** F3: Smart Mode tier auto-selection. Absent = off. */
  smartMode?: SmartModeConfig;
  /** F3: optional override of DEFAULT_MODEL_TIERS (tier → provider → model). Absent = built-in. */
  modelTiers?: Record<ModelTier, Record<string, string>>;
}

/**
 * 段2: an MCP server the team can mount. stdio = local subprocess; streamable-http/sse = remote.
 * `env` values may contain ${VAR} placeholders resolved from SecretStorage at runtime — never
 * stored resolved (no secrets on disk). A server is exposed to an agent ONLY when that agent's
 * skills (type 'mcp-server') or `mcpServers` explicitly reference it (default-deny).
 */
export interface MCPServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'streamable-http' | 'sse';
  command?: string; // stdio
  args?: string[]; // stdio
  url?: string; // http/sse
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Sensitive servers (filesystem, github, …) should require explicit user approval to mount. */
  requiresApproval?: boolean;
}

/**
 * Configuration for a single AI agent
 */
export interface AgentConfig {
  id: string;
  name: string;
  role: AgentRole;
  skill: string;
  skills?: AgentSkill[];
  provider: ProviderRef;
  model: string;
  /**
   * Versioned connection/model selection. E3 migrates every persisted roster and new writes emit it.
   * It contains no endpoint credential or CLI auth path.
   */
  route?: AgentRoute;
  /**
   * Host-authored, non-persisted explanation for a closed-shape custom route whose machine-local
   * profile is missing or archived. The session remains visible for repair but cannot start.
   */
  routeRepair?: string;
  systemPrompt: string;
  /** Stable key of the shipped role template this agent was created from (for example `pm` or `sales-engineer`).
   * Separate from `role`: several knowledge-work templates intentionally share the runtime `custom` role. */
  roleTemplateKey?: string;
  /**
   * Whether `systemPrompt` follows the role template or is a user-owned fork. Template prompts are
   * resolved from the current shipped role at session start, so guidance fixes reach existing agents.
   * Absent is a legacy config and is safely classified during roster restoration.
   */
  systemPromptSource?: 'template' | 'custom';
  /** The exact role-template prompt a user forked when they customized their instructions. */
  systemPromptTemplateAtFork?: string;
  /** Hash of a newer template update the user explicitly dismissed; a later template update reappears. */
  systemPromptDismissedTemplateHash?: string;
  /** One-level undo record for an explicit "adopt current template" action. */
  systemPromptUndo?: {
    prompt: string;
    templateAtFork?: string;
    dismissedTemplateHash?: string;
  };
  description?: string;
  icon?: string;
  color?: string;
  autoApprove: boolean;
  allowedTools: string[];
  /** @deprecated v0.1.1 — prefer `modelParams.max_tokens`; kept as a fallback for old team.json. */
  maxTokens?: number;
  /** @deprecated v0.1.1 — prefer `modelParams.temperature`; kept as a fallback for old team.json. */
  temperature?: number;
  /** Advanced model/sampling parameters (F2). Falls back to global defaults then hard defaults. */
  modelParams?: AgentModelParams;
  /** Per-agent Smart Mode tier override. When Smart Mode is on, this beats the role's tier so two
   *  same-role agents can run at different tiers. Absent = follow the role/default tier. */
  tier?: ModelTier;
  workingDirectory?: string;
  env?: Record<string, string>;
  /** Which runtime powers this agent. Defaults to 'claude' (headless stream-json). */
  backend?: AgentBackendKind;
  /** Endpoint base URL for HTTP backends (e.g. 算力仓 / any OpenAI-compatible gateway). */
  baseUrl?: string;
  /** Restart automatically (with backoff) if the process exits unexpectedly. */
  autoRestart?: boolean;
  /** Fallback model to switch to after repeated turn failures on the primary model (P1#6). */
  fallbackModel?: string;
  /** Context window (tokens) for the soft/hard context gates (P2). Defaults to DEFAULT_CONTEXT_WINDOW_TOKENS. */
  contextWindowTokens?: number;
  /**
   * A context window the selected gateway advertised for this exact model through its user-initiated
   * `/models` response. This is deliberately separate from `contextWindowTokens`: the latter is the
   * user's statement and must always win over a measurement.
   */
  measuredContextWindow?: ContextWindowMeasurement;
  /**
   * An upper bound the provider PROVED by refusing a request of a known size.
   *
   * A rejection is evidence no advertisement can contradict: whatever the model's window is, it is smaller
   * than what we just sent. Recorded so the guard stops re-deriving its threshold from a number the gateway
   * has already disproved — without it, the same conversation overflows again at the same place and the
   * user has to press Compact by hand every time.
   */
  observedContextWindow?: ContextWindowBound;
  /** 段2: extra MCP server ids this agent may use (all tools). Merged with skill-derived grants. */
  mcpServers?: string[];
  /**
   * Agent Skill ids granted to this agent. Separate from `skills` (capability tokens → allowedTools):
   * playbooks are progressively disclosed from extension-owned SKILL.md files, not folded into the
   * system prompt. Optional/absent = no attached procedural skills; existing saved arrays remain valid.
   */
  playbooks?: string[];
  /**
   * How an openai-compat agent calls tools (design C). 'native' = OpenAI function calling (default);
   * 'xml' = Cline-style XML tool calls in the prompt, which weaker models follow more reliably.
   */
  toolProtocol?: ToolProtocolKind;
  /**
   * Edit tool surface selected for this connection/model capability profile. Absent preserves the
   * exact-snippet `apply_edit` surface; `apply-patch` is an explicit, user-owned compatibility override.
   */
  editToolDialect?: EditToolDialect;
  /**
   * Per-agent filesystem scope. Absent = workspace default; present = the agent sees only these folders.
   */
  folderAccess?: FolderGrant[];
  /**
   * Optional command ceiling for this agent. It can only narrow the workspace CommandPolicy; absent means
   * inherit the global setting exactly. The persisted allowlist is re-intersected with the live global list
   * on every check, so a later global removal can never leave a stale grant behind.
   */
  commandNarrowing?: AgentCommandNarrowing;
  /**
   * User opt-out for Claude native Agent/Workflow tools. v0.9.26 never disables these by default; when
   * the user chooses this after a warning, the flag adds Agent/Workflow to this agent's --disallowedTools.
   */
  disableNativeSubagents?: boolean;
}

/** The spelling a gateway used when it advertised a model's context window. */
export type ContextWindowField = 'context_length' | 'max_context_length' | 'context_window';

/** A provider-advertised window, bound to the model it described rather than treated as a global default. */
export interface ContextWindowMeasurement {
  model: string;
  tokens: number;
  field: ContextWindowField;
}

/**
 * An upper bound on a model's usable window, derived from a request it refused as too large.
 *
 * Deliberately not a `ContextWindowMeasurement`: that type carries the gateway FIELD that advertised the
 * number, and there is no field here. This is an observation about behaviour, and it is weaker in one
 * respect (it is a bound, not the window) and stronger in another (advertisements are routinely larger
 * than what the endpoint in front of the model will actually accept).
 */
export interface ContextWindowBound {
  model: string;
  /** At most this many tokens: our estimate of a request the provider rejected for size. */
  tokens: number;
  /** ISO-8601 instant of the rejection, so a bound carried forward is legible rather than anonymous. */
  observedAt: string;
}

/** What kind of fact supplied the window currently used by the context guard. */
export type ContextWindowSource = 'assumed' | 'measured' | 'configured' | 'observed';

/** The context estimate exposed to the UI, including whether its denominator was measured or assumed. */
export interface ContextWindowUsage {
  tokens: number;
  window: number;
  ratio: number;
  source: ContextWindowSource;
}

/**
 * What the composer's context meter can honestly say about the selected agent right now.
 *
 * Three states, because "no number" has three different causes and a user cannot act on the same word for
 * all of them. The v0.9.50 meter collapsed them into an empty pill reading only "Compact", which reads as a
 * broken feature rather than as a runtime that does not report — a field report on 2026-08-11.
 */
export type ContextMeterState =
  | { kind: 'usage'; usage: ContextWindowUsage }
  /** This runtime does report a window, but no backend exists yet — the agent has not been started. */
  | { kind: 'not-started' }
  /** The runtime owns its own context. The host cannot measure it and has nothing to compact. */
  | { kind: 'unsupported' };

export type ToolProtocolKind = 'native' | 'xml';
export type EditToolDialect = 'apply-edit' | 'apply-patch';

export type AgentBackendKind = 'claude' | 'codex' | 'openai-compat';
export type ChatMode = 'plan' | 'act';

/** One directory an agent may touch, and how. `readwrite` implies read. */
export interface FolderGrant {
  path: string;
  permission: FolderPermission;
}

export type FolderPermission = 'read' | 'readwrite';

export type CommandApprovalMode = 'none' | 'allowlist' | 'ask' | 'all';

export interface AgentCommandNarrowing {
  /** Explicit only when the editor is in “Restrict to selected” mode; absence means inherit. */
  approvalMode: CommandApprovalMode;
  /** Chosen only from the workspace allowlist by the editor; host enforcement intersects it again. */
  allowedCommands: string[];
}

/** A coordinator-requested, one-turn filesystem ceiling. It is always intersected with AgentConfig.folderAccess. */
export interface DelegationTaskScope {
  folderAccess: FolderGrant[];
}

/** Host-resolved intersection for one turn; backends receive roots, never an authority grant. */
export interface TaskWorkspaceAccess {
  /** Base for every model-supplied relative filesystem path. This is not an authority root. */
  pathBase: string;
  /** Working directory for shell commands. It stays inside an effective writable task scope. */
  commandCwd: string;
  /** Authorisation ceilings checked after a model path has been resolved once against pathBase. */
  readRoots: string[];
  writeRoots: string[];
}

/**
 * Quality/cost tier for a role (v0.1.1 F3). Decouples "how capable a model a role needs" from a
 * specific model id; `DEFAULT_MODEL_TIERS` (RoleConfig) maps each tier→model per provider.
 * Lives here (not RoleConfig) so TeamConfig/SmartModeConfig can reference it without a cycle.
 */
export type ModelTier = 'premium' | 'standard' | 'economy';

/**
 * Smart Mode (v0.1.1 F3): auto-select a model tier per task instead of pinning one model per agent.
 * Reuses the existing tier infra — `selectTier()` resolves a tier, then TierController/modelFor maps
 * it to a concrete model for the agent's provider and hot-swaps it (openai-compat: next turn).
 */
export interface SmartModeConfig {
  enabled: boolean;
  /** Fallback tier when nothing more specific matches. */
  defaultTier: ModelTier;
  /** Per-role tier override (role → tier); beats the role template's tier, loses to a task hint. */
  roleTiers?: Record<string, ModelTier>;
  /** Per-message-type tier hint (msg.type → tier), e.g. { 'review.request': 'economy' }. */
  taskTierHints?: Record<string, ModelTier>;
}

/**
 * Advanced model/sampling parameters for an agent (v0.1.1 F1). All optional — resolved layer-by-layer
 * by ModelParamResolver: agent.modelParams > smart tier > global unode.modelDefaults.* > hard defaults.
 *
 * BACKEND SUPPORT: the full surface applies to OpenAI-compatible backends (passed in the request
 * body). The `claude` headless CLI only honors `reasoning_effort` (→ --effort) and, partially,
 * `response_format` (→ --json-schema); all other fields are ignored for claude agents (no CLI flags).
 */
export interface AgentModelParams {
  // ── Sampling ──
  temperature?: number; // 0.0–2.0
  top_p?: number; // 0.0–1.0
  // ── Penalties ──
  presence_penalty?: number; // -2.0–2.0
  frequency_penalty?: number; // -2.0–2.0
  // ── Thinking / Reasoning ──
  thinking?: { type: 'enabled'; budget_tokens?: number } | { type: 'disabled' };
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  // ── Output control ──
  max_tokens?: number;
  stop?: string | string[]; // max 4
  response_format?: { type: 'text' | 'json_object' };
  // ── Tool behavior ──
  tool_choice?: 'auto' | 'none' | string;
  stream?: boolean;
}

/**
 * Predefined or custom agent roles
 */
export type AgentRole =
  | 'architect'
  | 'developer'
  | 'reviewer'
  | 'qa'
  | 'pm'
  | 'product-manager'
  | 'devops'
  | 'tech-writer'
  | 'security'
  | 'data-engineer'
  | 'senior-dev'
  | 'tester'
  | 'solo'
  | 'custom';

export type SkillCategory =
  | 'development'
  | 'testing'
  | 'design'
  | 'documentation'
  | 'management'
  | 'security'
  | 'infrastructure'
  | 'data'
  | 'external'; // 段2: MCP-backed external services (GitHub, browser, DB …)

/**
 * How a skill is actually fulfilled — turns a skill from a label into a capability declaration.
 *  - builtin:   grants capability tokens consumed by WorkspaceTools/TeamTools
 *               ('read' | 'write' | 'execute' | 'search' | 'delegate'). NOT low-level function
 *               names — WorkspaceTools maps 'read'→read_file/list_dir, 'write'→write_file,
 *               'execute'→run_command; 'delegate' gates TeamTools (PM delegation).
 *  - composite: the union of other skills (recursively resolved, cycle-safe).
 *  - mcp-server: tools from a mounted MCP server (consumed in 段2, not by allowedTools).
 */
export type SkillImplementation =
  | { type: 'builtin'; tools: string[] }
  | { type: 'composite'; skillIds: string[] }
  | { type: 'mcp-server'; serverId: string; toolFilter: 'all' | 'allowlist' | 'denylist'; toolList?: string[] };

/**
 * Agent skill definition (goes beyond the simple role string).
 * `implementation` is optional: a skill without it is a legacy label that grants no tools, so
 * existing configs keep relying on their explicit `allowedTools` (backward compatible).
 */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  implementation?: SkillImplementation;
}

/**
 * Reference to a provider configuration
 */
export interface ProviderRef {
  providerId: string;
  apiKeySecretName: string;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  id: string;
  name: string;
  type: 'openai' | 'anthropic' | 'google' | 'ollama' | 'custom';
  baseUrl: string;
  apiKeySecretName: string;
  models: ModelConfig[];
  rateLimit?: {
    requestsPerMinute: number;
    tokensPerMinute: number;
  };
  costPerToken?: {
    input: number;
    output: number;
  };
}

/**
 * Individual model configuration within a provider
 */
export interface ModelConfig {
  id: string;
  name: string;
  maxTokens: number;
  supportsStreaming: boolean;
  supportsVision: boolean;
}

/**
 * Team-wide settings
 */
export interface TeamSettings {
  maxConcurrentAgents: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  messageRetentionDays: number;
  autoSaveInterval: number;
}

/**
 * Workflow configuration
 */
export interface WorkflowConfig {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  triggers?: WorkflowTrigger[];
}

/**
 * A single step in a workflow
 */
export interface WorkflowStep {
  id: string;
  from: string;
  to: string;
  action: string;
  condition?: string;
  autoTransition: boolean;
  /**
   * P2 conditional routing: after this step completes, the first matching branch wins and the
   * workflow jumps to `goto` (enables if/else and loops). No match → linear next step.
   */
  branches?: WorkflowBranch[];
}

/** A conditional transition selected by an exact, host-declared structured label. */
export interface WorkflowBranch {
  /** Exact token the completing agent may select through the structured workflow tool. */
  label: string;
  /** A pre-0.9.70 unconditional branch, migrated. It is never offered to the agent and is taken only
   *  when no declared label matched, which is what "no condition" meant before labels existed. */
  fallback?: true;
  /** Step id to jump to when this branch matches. */
  goto: string;
}

/**
 * Trigger that activates a workflow
 */
export interface WorkflowTrigger {
  type: 'message' | 'file_change' | 'git_event' | 'schedule';
  config: Record<string, unknown>;
}

/*---------------------------------------------------------------------------------------------
 *  Session
 *--------------------------------------------------------------------------------------------*/

export type SessionStatus =
  | 'stopped'
  | 'starting'
  /** A host-owned model-egress consent dialog is open; answer it to resume this start. */
  | 'consent_required'
  | 'idle'
  | 'running'
  | 'error'
  | 'stopping';

export interface SessionInfo {
  id: string;
  config: AgentConfig;
  status: SessionStatus;
  pid?: number;
  backendSessionId?: string;
  startedAt?: string;
  lastActiveAt?: string;
  currentTask?: string;
  errorMessage?: string;
  /** Actionable copy while a model-egress consent dialog is awaiting a human decision. */
  consentMessage?: string;
  /** True when start was requested but deferred by the concurrency cap. */
  pendingStart?: boolean;
  /** The ACTUAL root the running backend/tools are sandboxed to this session (a worktree path, or the
   *  current workspace) — resolved at start, NOT persisted. The single source of truth for "where this
   *  agent operates": use it for workspace grounding, chat preflight, and diagnostics. config.workingDirectory
   *  may be stale/absent; never trust it for the runtime root. */
  runtimeWorkingDirectory?: string;
  restartCount: number;
  /** Rolling token/cost totals for this session, accumulated from turn results. */
  usage?: { inputTokens: number; outputTokens: number; costUsd: number; turns: number;
    costBasis?: 'billed' | 'api-equivalent';
    /** The part of `inputTokens` the gateway served from its prefix cache — a SUBSET, not an addition, and
     *  priced at roughly a tenth. Undefined = no gateway has reported it, which is NOT a known zero: render
     *  that as "unknown", never as "0% cached". */
    cachedInputTokens?: number;
    /** True once any turn's numbers were RECONSTRUCTED rather than reported — a gateway relaying Anthropic's
     *  inverted units, or one that streams no usage at all. Sticky. The UI must mark these as estimates: we
     *  bias them high on purpose, but a guess is not a bill. */
    estimated?: boolean;
    /** What the same tokens would have cost on a top-tier premium model — the baseline for the
     *  "mixed routing saved you $X" comparison. Accrued in parallel with costUsd. */
    premiumCostUsd?: number };
  /** Latest context-window usage (from the backend's session.context event). */
  contextUsage?: ContextWindowUsage;
}

export interface SessionEvent {
  type: 'start' | 'stop' | 'error' | 'status_change' | 'message';
  sessionId: string;
  timestamp: string;
  data?: unknown;
}

/*---------------------------------------------------------------------------------------------
 *  Messages
 *--------------------------------------------------------------------------------------------*/

export type MessageType =
  | 'task.assign'
  | 'task.admitted'
  | 'task.status'
  | 'task.complete'
  | 'task.partial'
  | 'review.request'
  | 'review.feedback'
  | 'ask.question'
  | 'ask.answer'
  | 'handoff'
  | 'broadcast.info'
  | 'agent.message'
  | 'system.error'
  | 'system.heartbeat';

export type MessagePriority = 'high' | 'normal' | 'low';

/** Host-observed terminal shape of one delegated turn. It is independent from evidence quality. */
export type DelegationCompletionState = 'complete' | 'partial' | 'not-observed';

/** A run closes only on a complete or partial coordinator result; errors leave it open. */
export type RunCloseoutCompletionState = Exclude<DelegationCompletionState, 'not-observed'>;

/**
 * `pdf` is deliberately distinct from a generic file: it is never inlined into a
 * model turn or durable chat transcript. The host stores and exposes it only via
 * the bounded content-asset read/search surface.
 */
export type UserAttachmentKind = 'image' | 'file' | 'pdf';

export interface UserAttachment {
  name: string;
  mime: string;
  kind: UserAttachmentKind;
  dataBase64: string;
  /** Original byte size from the webview, re-validated host-side before routing. */
  size?: number;
  /** Optional small display thumbnail for chat history; never used as model input. */
  thumbnailDataUrl?: string;
}

export interface MessagePayload {
  instruction?: string;
  message?: string;
  mode?: ChatMode;
  files?: string[];
  userAttachments?: UserAttachment[];
  /** Closed outcome vocabulary declared by the current workflow step. */
  workflowBranchLabels?: string[];
  /** Optional coordinator-requested narrowing for one delegated assignment. Never persisted on the agent. */
  taskScope?: DelegationTaskScope;
  /** Context sources resolved before the message is routed (for example explicit @file/@folder mentions). */
  contextManifestSources?: ContextManifestSource[];
  /** Opaque, expiring handles for the current user's non-rebuildable sources forwarded to a delegate. */
  delegationContentSources?: DelegationContentSource[];
  /** Per-task, host-observed verification contract selected at dispatch. */
  verificationPlan?: VerificationPlan;
  /** Host-compiled task card. Grants inside it are valid only for this correlation-bound attempt. */
  taskAttempt?: import('./backend/TaskContract').TaskAttemptCard;
  context?: Record<string, unknown>;
  expectedOutput?: string;
  metadata?: Record<string, unknown>;
}

/** The new terminal transport preserves the report and carries its unfinished plan fact separately. */
export type TaskPartialPayload = Omit<MessagePayload, 'instruction' | 'metadata'> & {
  instruction: string;
  metadata: Record<string, unknown> & {
    completionState: 'partial';
    unfinishedActivity: string;
  };
};

export type MessagePayloadFor<T extends MessageType> = T extends 'task.partial'
  ? TaskPartialPayload
  : MessagePayload;

interface MessageBase<T extends MessageType> {
  id: string;
  correlationId?: string;
  from: string;
  to: string | '*';
  type: T;
  priority: MessagePriority;
  payload: MessagePayloadFor<T>;
  timestamp: string;
  ttl?: number;
}

/** Distributive generic keeps `type: task.partial` correlated with its literal payload contract. */
export type Message<T extends MessageType = MessageType> = T extends MessageType ? MessageBase<T> : never;

export type MessageHandler = (message: Message) => void | Promise<void>;

export interface MessagePattern {
  type?: MessageType;
  from?: string;
  to?: string;
  priority?: MessagePriority;
}

export interface MessageFilter {
  before?: string;
  after?: string;
  from?: string;
  to?: string;
  type?: MessageType;
  limit?: number;
}

/*---------------------------------------------------------------------------------------------
 *  Workflow Runtime
 *--------------------------------------------------------------------------------------------*/

export type WorkflowStatus = 'pending' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';

export interface WorkflowInstance {
  id: string;
  config: WorkflowConfig;
  status: WorkflowStatus;
  currentStep?: string;
  startedAt: string;
  completedAt?: string;
  context: Record<string, unknown>;
}

export interface WorkflowEvent {
  type: 'start' | 'step_complete' | 'complete' | 'pause' | 'resume' | 'cancel' | 'error';
  workflowId: string;
  timestamp: string;
  data?: unknown;
}

/*---------------------------------------------------------------------------------------------
 *  Usage / Cost Tracking
 *--------------------------------------------------------------------------------------------*/

export interface UsageStats {
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  requests: number;
  lastUsed: string;
}

/*---------------------------------------------------------------------------------------------
 *  Extension State
 *--------------------------------------------------------------------------------------------*/

export interface UnodeCrewState {
  teamConfig: TeamConfig | null;
  sessions: SessionInfo[];
  messages: Message[];
  providers: ProviderConfig[];
  activeWorkflows: WorkflowInstance[];
  usageStats: UsageStats[];
}
