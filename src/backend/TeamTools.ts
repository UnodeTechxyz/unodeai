/*---------------------------------------------------------------------------------------------
 *  UnodeAi - TeamTools
 *  The delegation tool surface given to a coordinator agent (the PM). Lets one agent manage
 *  others: see the roster, hand a task to a teammate and wait for the result, or broadcast.
 *
 *  This is what turns the "pm" role from a teammate that merely writes a plan into an
 *  orchestrator that actually drives the crew. It plugs into the MessageBus we already use, so
 *  an assign_task simply flows through SessionManager's normal routing to the target's backend.
 *
 *  Decoupled from SessionManager via the TeamView interface so the backend layer stays
 *  independent of session/.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { AsyncLocalStorage } from 'async_hooks';
import { killProcessTree } from './processTree';
import { v4 as uuidv4 } from 'uuid';
import { MessageBus } from '../bus/MessageBus';
import { ToolSpec } from './WorkspaceTools';
import { CommandApprover, gateShellCommand } from './ShellCommandGate';
import { sanitizedCommandEnv } from './commandEnv';
import { CommandPolicy } from './CommandPolicy';
import { isMisconfiguredCheckOutput } from './completionGate';
import { TaskClaimRegistry } from './TaskClaimRegistry';
import { DelegationTurnEvidence } from './AgentBackend';
import { DelegationCompletionState, DelegationTaskScope, type SessionStatus } from '../types';
import type { DelegationContentSource } from '../session/TurnContextManifest';
import {
  evaluateVerificationPlan,
  formatVerificationPlan,
  parseVerificationPlan,
  type VerificationPlan,
  type VerificationSensorKind,
} from './VerificationPlan';
import {
  compileTaskContract,
  formatTaskAttemptCard,
  legacyTaskContract,
  normalizeWorkspacePathsInInstruction,
  preflightInputGrants,
  type CandidateContractAgent,
  type ContextGapReason,
  type EffectiveTaskContract,
  type InputGrant,
  type ReadyTaskArtifact,
  type TaskAttemptCard,
  type TaskContextGap,
  TaskInputResolver,
} from './TaskContract';
import type { ReviewPolicyPreflightDecision } from '../policy/ReviewPolicyPreflight';
import {
  hostToolFailed,
  hostToolRefused,
  hostToolSucceeded,
  type HostToolOutcome,
  type HostToolRefusalReason,
} from './toolSummary';

/**
 * Whether the host can narrow this agent's filesystem boundary for one assignment.
 *
 * `per-turn` is the only value a task scope may be dispatched against. A native CLI cannot change its
 * boundary between turns, so a scope aimed at one would have to be either unenforced or refused — and it is
 * refused, correctly, but until this fact reached the roster the refusal arrived *after* the coordinator had
 * already chosen. Fail-closed at the wrong end of the decision still wastes the assignment.
 */
export type TaskScopeCapability = 'per-turn' | 'fixed-session-only' | 'unavailable';

export interface TeamRosterEntry {
  id: string;
  role: string;
  name: string;
  status: string;
  /** Host-only target root for snapshot resolution. list_agents never renders it. */
  workspaceRoot?: string;
  /**
   * What this teammate is *for*, in the words the role template uses.
   *
   * The knowledge-work roles — Content Strategist, Frontend Engineer, Product Designer, SEO Specialist —
   * all carry `role: 'custom'` by design, because the runtime role is a capability class and not a job
   * title. That is fine everywhere except here: `list_agents` rendered id and role only, so the whole
   * Website team arrived at the coordinator as four indistinguishable lines and the choice of specialist
   * was a coin toss it had no way to win. This is the field that makes them different.
   */
  specialty?: string;
  /**
   * What this teammate is equipped to do, by name.
   *
   * Two fields feed it and role templates use them inconsistently — the Content Strategist declares
   * `skills` and no playbooks, the Frontend Engineer declares playbooks and no `skills`. Sending only one
   * would leave whichever specialist chose the other field invisible for exactly the task it exists for.
   */
  skills?: readonly string[];
  /** Host-derived facts for delegation routing. They describe this connection's current usable surface,
   * not a persisted Capability Profile (that richer/provenanced object remains future work). */
  capabilities?: {
    read: boolean;
    write: boolean;
    shell: boolean;
    /** Sensors this exact target can reach through its actual backend/tool surface. */
    verificationSensors?: readonly VerificationSensorKind[];
    toolFamilies: readonly string[];
    /** The runtime behind this agent. A coordinator needs it to know what a scope can be asked of. */
    backend?: string;
    /** Whether a per-assignment folder scope can be enforced. See `TaskScopeCapability`. */
    taskScope?: TaskScopeCapability;
  };
}

/** Minimal read view of the team, supplied by the extension from SessionManager. */
export interface TeamView {
  list(): TeamRosterEntry[];
  resolve(ref: string): { id: string } | undefined;
  /** Host-owned dry run of the real folder-scope intersection; no task is sent when it returns a reason. */
  preflightTaskScope?(agentId: string, scope: DelegationTaskScope): string | undefined;
}

const TEAM_TOOL_NAMES = new Set([
  'list_agents',
  'dispatch_task',
  'collect_ready_tasks',
  'inspect_task_status',
  'cancel_task',
  'publish_content_receipt',
  // Migration-only aliases. They remain callable by a host-owned compatibility path but are never
  // returned from specs(), so a coordinator model cannot select a blocking wait.
  'assign_task',
  'assign_task_async',
  'await_tasks',
  'record_task_disposition',
  'close_assignment',
  'delegation_metrics',
  'broadcast',
  'run_checks',
]);

/** Per-result size cap in await_tasks output, to bound the PM's context/cost. */
const AWAIT_RESULT_MAX = 8000;
const DEFAULT_CANCEL_REASON = 'delegation cancelled by user';
/**
 * A blocking assignment gives the coordinator its turn back at `timeoutMs`, but the worker may
 * still finish. Keep that correlation open for two more normal wait windows: it is long enough for
 * a genuinely slow worker to report back, while ensuring a lost worker cannot retain a bus listener
 * for the rest of the session. Session teardown/cancel closes it sooner.
 */
const LATE_BLOCKING_RESULT_WINDOW_MULTIPLIER = 2;
/** A worker can earn at most two extra blocking windows with host-observed work. */
const MAX_BLOCKING_WAIT_WINDOWS = 3;

/** A host-published receipt never asks the coordinator to serialize source content back to the host. */
export type ReceiptDeliveryState = 'shown' | 'partial' | 'not-delivered';

export interface TurnContentReceipt {
  id: string;
  /** Host-owned source text. It never enters an evidence callback or durable ledger. */
  content: string;
}

export interface PublishedTurnDelivery {
  text: string;
  state: ReceiptDeliveryState;
  receiptId: string;
  visibleCharacters?: number;
}

interface ActiveDispatch {
  cancel: (reason?: string) => void;
  /** Who is running it. Cancelling the wait is not the same as stopping the teammate; both need the id. */
  agentId: string;
}

interface PendingAsyncTask {
  ref: string;
  promise: Promise<string>;
}

export type DelegationWaitState =
  | 'not-started' | 'within-deadline' | 'settled-on-time' | 'cancelled-before-timeout'
  | 'timed-out-window-open' | 'timed-out-result-arrived' | 'timed-out-window-expired' | 'timed-out-cancelled';
export type DelegationResultState = 'pending' | 'ready' | 'delivered' | 'none';
export type DelegationReadReceiptState = 'all-observed' | 'partially-observed' | 'none-observed' | 'not-applicable';

interface LiveDispatchState {
  agentId: string;
  waitState?: DelegationWaitState;
  resultState: DelegationResultState;
  attemptId?: string;
  timedOutAt?: string;
  lateWindowClosesAt?: string;
}

/** A settled async delegation that can be delivered back to an idle coordinator. */
export interface AsyncDelegationResult {
  handle: string;
  ref: string;
  /** Already includes the framework evidence frame when evidenceEnabled is on. */
  text: string;
}

/** Bounded durable facts returned by the host-owned delegation-status query. */
export interface CoordinatorTaskStatus {
  handle: string;
  runId?: string;
  agentId?: string;
  requestedAgent?: string;
  lifecycle: 'active' | 'settled' | 'cancelled' | 'timed-out' | 'policy-refused' | 'unknown';
  workerState?: SessionStatus | 'unknown';
  waitState?: DelegationWaitState;
  resultState?: DelegationResultState;
  readReceiptState?: DelegationReadReceiptState;
  timedOutAt?: string;
  lateWindowClosesAt?: string;
  policyId?: string;
  policyReason?: string;
  dispatchedAt?: string;
  terminalAt?: string;
  delivery?: { state: 'pending' | 'delivered' | 'not-observed'; observedAt?: string; via?: 'auto-wake' | 'collect-ready' | 'blocking-tool' };
  progress?: { observedAt: string; activity: string };
  evidenceOutcome?: DelegationOutcome;
  completionState?: DelegationCompletionState;
  requiredInputCount?: number;
  requiredInputReadNotObservedCount?: number;
  contextGaps?: Array<{ inputId: string; reason: ContextGapReason }>;
  inputReceipts?: Array<{ inputId: string; supplied: boolean; reachable: boolean; readReceipt: 'observed' | 'not-observed' }>;
  disposition?: { value: CoordinatorDisposition; replacementHandle?: string };
}

/** A framework verdict on one delegated reply. Never derived from the worker's self-report alone. */
export type DelegationOutcome =
  | 'verified'
  | 'verification-failed'
  | 'no-applicable-sensor'
  | 'tool-activity-recorded'
  | 'replied-not-verified'
  | 'no-evidence'
  | 'required-input-read-not-observed'
  | 'timed-out';

/** A coordinator's explicit decision about a settled result. It is never inferred from result prose. */
export type CoordinatorDisposition =
  | 'accepted'
  | 'rejected'
  | 'needs-human'
  | 'needs-rework'
  | 'deferred'
  | 'accepted-with-caveat'
  | 'accepted-after-rework'
  | 'accepted-despite-framework-no-evidence'
  | 'superseded';

const COORDINATOR_DISPOSITIONS = new Set<CoordinatorDisposition>([
  'accepted', 'rejected', 'needs-human', 'needs-rework', 'deferred',
  'accepted-with-caveat', 'accepted-after-rework', 'accepted-despite-framework-no-evidence', 'superseded',
]);
const ACCEPTANCE_DISPOSITIONS = new Set<CoordinatorDisposition>([
  'accepted', 'accepted-with-caveat', 'accepted-after-rework', 'accepted-despite-framework-no-evidence',
]);
const REJECTION_DISPOSITIONS = new Set<CoordinatorDisposition>(['rejected', 'needs-rework', 'superseded']);
const REASON_REQUIRED_DISPOSITIONS = new Set<CoordinatorDisposition>([
  'rejected', 'needs-human', 'needs-rework', 'deferred', 'accepted-with-caveat', 'superseded',
]);

export interface DelegationDispositionEvent {
  handle: string;
  agentId: string;
  disposition: CoordinatorDisposition;
  /** Required for a rejection or a human handoff; recorded verbatim (within the bounded tool field). */
  reason?: string;
  recordedAt: string;
  /** The framework evidence shown before the coordinator made this decision. */
  outcome: DelegationOutcome;
  /** A superseded result must point at a real, separately dispatched replacement task. */
  replacementHandle?: string;
}

interface SettledDelegation {
  handle: string;
  agentId: string;
  outcome: DelegationOutcome;
  evidence?: DelegationEvidenceRecord;
  dispositions: DelegationDispositionEvent[];
}

/** A refused dispatch has no settled-result handle, so it is retained as a separate coordinator receipt. */
interface RefusedDispatch {
  ref: string;
  reason: string;
  recordedAt: string;
  disposition: 'rejected-at-dispatch';
}

/** Coordinator states are report-only. They inform a continuation nudge but never lock a turn. */
export interface CoordinatorCloseoutState {
  settledButUndisposed: number;
  /** Settled results with an explicit current coordinator decision; never inferred from zero owed work. */
  recordedDispositionCount: number;
  acceptedButUngated: number;
  /** Explicit plan facts remain reportable instead of being folded into unverified. */
  noApplicableSensor: number;
  verificationNotRun: number;
  verificationFailed: number;
  idleWithNoLiveWork: number;
  /** A result may be settled while a different delegation is still running; that is not a closeout point. */
  hasLiveDelegationWork: boolean;
  /** Whether this coordinator can actually run the project's configured objective check. */
  hasVerificationPath: boolean;
  /** Whether the coordinator has stated a conclusion for the work it took on. */
  assignmentClosed: boolean;
  /** True once anything was dispatched or refused: only then is a conclusion owed. */
  assignmentOpen: boolean;
}

/** A coordinator's own conclusion about the work it was given — not a judgement of any delegate's prose. */
export type AssignmentOutcome = 'complete' | 'partial' | 'blocked';

export interface AssignmentCloseoutEvent {
  outcome: AssignmentOutcome;
  summary: string;
  /** Required for partial and blocked. Each entry names one thing not done and why. */
  incomplete: { item: string; reason: string }[];
  recordedAt: string;
}

export interface DelegationEvidenceRecord {
  outcome: DelegationOutcome;
  /** Host-observed terminal transport shape; independent from framework evidence quality. */
  completionState: DelegationCompletionState;
  changedFiles: string[];
  hadToolActions: boolean;
  verification: { ran: boolean; passed: boolean; command?: string };
  unrecordedWrites: boolean;
  /** The declared, content-free contract selected at task creation, if this is a v0.9.60 task. */
  verificationPlan?: VerificationPlan;
  /** Host evaluation of that specific plan; never inferred from model prose. */
  verificationPlanStatus?: 'no-applicable-sensor' | 'satisfied' | 'not-run' | 'failed';
  verificationSensors?: Array<{ kind: VerificationPlan['sensors'][number]; status: 'passed' | 'not-run' | 'failed' }>;
  /** Host-derived settlement counts. Never populated from a worker's message metadata. */
  requiredInputCount?: number;
  requiredInputReadNotObservedCount?: number;
  receiptSnapshots?: {
    timeout?: RequiredInputReceiptSnapshot;
    terminal?: RequiredInputReceiptSnapshot;
  };
  /** Independent task states and explicit artifact-ready receipts; neither changes DelegationOutcome. */
  contextGaps?: TaskContextGap[];
  taskArtifacts?: ReadyTaskArtifact[];
  inputGrants?: InputGrant[];
}

export interface RequiredInputReceiptSnapshot {
  requiredInputCount: number;
  requiredInputReadNotObservedCount: number;
  observedAt: string;
}

/** A successful hand-off observed by the host. It is a dispatch receipt, not a worker claim. */
export interface DelegationDispatchEvent {
  coordinatorId: string;
  handle: string;
  requestedAgent: string;
  agentId: string;
  instruction: string;
  /** Host-validated task contract. It contains sensor kinds only, never commands or prose. */
  verificationPlan?: VerificationPlan;
  /** Host-compiled immutable contract and its concrete execution attempt. */
  contract?: EffectiveTaskContract;
  attemptId?: string;
  scope?: DelegationTaskScope;
  /** Requested scopes become enforced only after the host's task-start receipt arrives. */
  scopeMode: 'per-turn-requested' | 'fixed-session-permissions';
  /** Host-derived explanation of why this exact agent was selected. */
  routing: DelegationRoutingReceipt;
  dispatchedAt: string;
}

export interface DelegationRoutingReceipt {
  taskClassification: 'implementation' | 'research-or-review' | 'general';
  requiredCapabilities: Array<'read' | 'write' | 'shell'>;
  compatibilityFilters: string[];
  selectionReason: string;
}

/** A terminal receipt for work the host stopped before it produced a result. */
export interface DelegationCancellationEvent {
  coordinatorId: string;
  handle: string;
  agentId: string;
  reason: string;
  cancelledAt: string;
}

/** A refused hand-off has no worker result but still belongs in coordinator accounting. */
export interface RefusedDispatchEvent {
  coordinatorId: string;
  handle?: string;
  requestedAgent: string;
  reason: string;
  recordedAt: string;
  /** Independent orchestration state; absence means an ordinary dispatch refusal. */
  taskState?: 'no-executor' | 'policy-refused';
  policyId?: string;
}

/** A dispatch promise resolves to an error/timeout string on failure (see dispatch()). */
function isTaskFailure(text: string): boolean {
  return /^Error\b/i.test(text.trim());
}

function isAcceptanceDisposition(disposition: CoordinatorDisposition | undefined): boolean {
  return disposition !== undefined && ACCEPTANCE_DISPOSITIONS.has(disposition);
}

function isRejectionDisposition(disposition: CoordinatorDisposition | undefined): boolean {
  return disposition !== undefined && REJECTION_DISPOSITIONS.has(disposition);
}

/** Runs a shell command for the verification gate; injectable so tests need no real build. */
export type CommandRunner = (command: string, cwd: string) => Promise<{ code: number | null; output: string }>;

export interface TeamToolsOptions {
  timeoutMs?: number;
  /** User-configured verify command (e.g. "npm run build"); run by run_checks. Empty = disabled. */
  verifyCommand?: string;
  cwd?: string;
  runCommand?: CommandRunner;
  commandPolicy?: CommandPolicy;
  /** Called when run_checks is blocked by CommandPolicy, so the extension can warn the user (B2).
   *  Kept as a vscode-free callback so TeamTools stays unit-testable. */
  onCommandBlocked?: (reason: string) => void;
  /** Non-blocking warning when a configured verify command names a path outside the workspace. */
  onConfigOutsideRoot?: (message: string, outsidePath: string, command: string) => void;
  /** 'ask'-mode approver, SAME one run_command uses. Without it, run_checks can't get past 'ask' and the
   *  PM deadlocks: its only verify path is blocked while run_command is delegate-gated. Optional for tests. */
  requestApproval?: CommandApprover;
  /** Router v1: called with a one-line audit string when a delegation is routed to a teammate
   *  (e.g. "Routed 'senior-dev' → senior-dev-2 (idle, least-recently-assigned)"). The extension wires
   *  it to the output channel so agent selection is explainable/reproducible. vscode-free for tests. */
  onRoute?: (line: string) => void;
  /** Max async delegations in flight at once (Option B). Beyond this, assign_task_async asks the PM
   *  to collect with await_tasks first — bounds teammate inbox pressure and PM wait time. */
  maxParallelDelegations?: number;
  /** Option B step 2: shared file-ownership registry. When set, assign_task_async's `files` are
   *  claimed and overlapping parallel dispatches are rejected up front. */
  claims?: TaskClaimRegistry;
  /** Host-owned attempt/grant registry shared with every worker tool surface. */
  taskInputResolver?: TaskInputResolver;
  /** Per-dispatch approval for a potentially user-derived coordinator brief crossing destinations. */
  approveCoordinatorBriefEgress?: (
    coordinatorId: string,
    targetAgentId: string,
  ) => Promise<{ allowed: boolean; reason?: string }>;
  /** L3 agent-robustness escalation: switch a stuck teammate (returns nothing twice) to its fallback
   *  model for one more attempt. Wired to SessionManager.escalateToFallback. Returns what happened so
   *  the PM can be told precisely (e.g. "no fallback configured"). Absent in tests that don't need it. */
  escalate?: (agentId: string) => EscalateResult;
  /** Enable framework-verified delegation verdicts. Kept opt-in for standalone/legacy TeamTools hosts. */
  evidenceEnabled?: boolean;
  /** Host-selected coordinator identity. Supplying another id creates a worker-safe tool surface. */
  coordinatorId?: string;
  /** Receives a host-observed dispatch after the assignment was placed on the message bus. */
  onDelegationDispatched?: (event: DelegationDispatchEvent) => void;
  /** Production hosts wait for SessionManager's final identity-policy admission before recording dispatch. */
  waitForTaskAdmission?: boolean;
  /** Applies the same final policy evaluator to coordinator-only/delegate-preferred self execution. */
  admitCoordinatorAttempt?: (attempt: TaskAttemptCard) => ReviewPolicyPreflightDecision;
  /** Receives refusals that occurred before a worker was dispatched. */
  onDelegationRefused?: (event: RefusedDispatchEvent) => void;
  /** Receives the framework verdict so team cards can show it independently of raw task completion. */
  onDelegationEvidence?: (event: { handle: string; agentId: string; outcome: DelegationOutcome; evidence: DelegationEvidenceRecord }) => void;
  /** Receives a coordinator's explicit disposition so every rendered evidence surface can amend in place. */
  onDelegationDisposition?: (event: DelegationDispositionEvent) => void;
  /** The coordinator stated a conclusion for its assignment, including one it could not finish. */
  onAssignmentCloseout?: (event: AssignmentCloseoutEvent) => void;
  /** Ask the host to interrupt this exact worker turn, never an agent selected by identity alone. */
  cancelDelegatedWorker?: (event: DelegationCancellationEvent) => boolean;
  /**
   * Stop a teammate's turn outright, whatever started it.
   *
   * `cancelDelegatedWorker` interrupts a *dispatch*, identified by handle. It cannot reach a turn a teammate
   * began because it received a message — a broadcast, a `send_message`, or the rework note
   * `record_task_disposition` forwards. That gap made a coordinator's authority conditional on how the work
   * had happened to start, which is not authority. Returns whether a running turn was actually stopped.
   */
  stopTeammate?: (agentId: string, reason: string) => boolean;
  /** Receives a terminal cancellation receipt. Cancellation is not a result disposition. */
  onDelegationCancelled?: (event: DelegationCancellationEvent) => void;
  /**
   * Notifies the host that a non-awaited async result is ready. The host may start an idle coordinator
   * turn and then call consumeAsyncResult(handle); until then the result remains collectable by
   * await_tasks. Kept vscode-free so the ownership/race rules are unit-testable here.
   */
  onAsyncResultReady?: (result: AsyncDelegationResult) => void;
  /** Settled-but-undelivered results restored after an extension-host restart. Live work is not resumed. */
  recoveredAsyncResults?: readonly AsyncDelegationResult[];
  /** Store a settled result before it can be collected or auto-delivered. */
  onAsyncResultRetained?: (result: AsyncDelegationResult) => void;
  /** Remove a result from durable storage once the coordinator has consumed or cancelled it. */
  onAsyncResultConsumed?: (handle: string) => void;
  /** Records successful delivery separately from mailbox storage cleanup/cancellation. */
  onAsyncResultDelivered?: (handle: string, via: 'auto-wake' | 'collect-ready' | 'blocking-tool') => void;
  /** Read-only durable status projection scoped by the host to this coordinator. */
  inspectTaskStatus?: (handles?: readonly string[]) => readonly CoordinatorTaskStatus[];
  /**
   * A terminal empty-delegation receipt. Its retry closure is host-owned: no rendered text, target, or
   * command crosses to a UI surface.
   */
  onDelegationEmptyOutcome?: (event: DelegationEmptyOutcomeEvent) => void;
}

/** Structured receipt for the existing `[BLOCKED: … returned nothing …]` terminal state. */
export interface DelegationEmptyOutcomeEvent {
  outcomeId: string;
  agentId: string;
  sessionId: string;
  /** Original host dispatch correlation; retained internally to bind later lifecycle evidence to this run. */
  correlationId: string;
  /** Re-enters contract admission, producing a new handle, attempt and grants on success. */
  retry: () => Promise<boolean>;
}

interface EmptyDelegationOutcomeRecipe {
  outcomeId: string;
  agentId: string;
  requestedRef: string;
  instruction: string;
  contract: EffectiveTaskContract;
  retry?: Promise<boolean>;
}

interface TeamToolOutcomeObservation {
  status: 'success' | 'refused' | 'failed';
  reason?: HostToolRefusalReason;
  /** Set when the failing output carries text this host did not author (worker replies, subprocess). */
  contentSource?: 'host' | 'mixed-external';
}

export type EscalateResult = {
  switched: boolean;
  reason: 'switched' | 'no-fallback' | 'already-on-fallback' | 'unknown-agent';
  from?: string;
  to?: string;
};

export class TeamTools {
  /** Per invocation: parallel delegations must never borrow one another's refusal state. */
  private readonly toolOutcomeObservation = new AsyncLocalStorage<TeamToolOutcomeObservation>();
  private timeoutMs: number;
  private verifyCommand: string;
  /** Last framework-observed passing coordinator check. Evidence records remain immutable. */
  private lastPassingVerificationAt?: number;
  private cwd: string;
  private runCommand: CommandRunner;
  private commandPolicy?: CommandPolicy;
  private onCommandBlocked?: (reason: string) => void;
  private onConfigOutsideRoot?: (message: string, outsidePath: string, command: string) => void;
  private requestApproval?: CommandApprover;
  private onRoute?: (line: string) => void;
  private maxParallel: number;
  private claims?: TaskClaimRegistry;
  private taskInputResolver?: TaskInputResolver;
  private approveCoordinatorBriefEgress?: TeamToolsOptions['approveCoordinatorBriefEgress'];
  private escalate?: (agentId: string) => EscalateResult;
  private evidenceEnabled: boolean;
  private coordinatorId: string;
  private onDelegationDispatched?: TeamToolsOptions['onDelegationDispatched'];
  private waitForTaskAdmission: boolean;
  private admitCoordinatorAttempt?: TeamToolsOptions['admitCoordinatorAttempt'];
  private onDelegationRefused?: TeamToolsOptions['onDelegationRefused'];
  private onDelegationEvidence?: TeamToolsOptions['onDelegationEvidence'];
  private onDelegationDisposition?: TeamToolsOptions['onDelegationDisposition'];
  private onAssignmentCloseout?: TeamToolsOptions['onAssignmentCloseout'];
  private cancelDelegatedWorker?: TeamToolsOptions['cancelDelegatedWorker'];
  private stopTeammate?: TeamToolsOptions['stopTeammate'];
  private onDelegationCancelled?: TeamToolsOptions['onDelegationCancelled'];
  private onAsyncResultReady?: TeamToolsOptions['onAsyncResultReady'];
  private onAsyncResultRetained?: TeamToolsOptions['onAsyncResultRetained'];
  private onAsyncResultConsumed?: TeamToolsOptions['onAsyncResultConsumed'];
  private onAsyncResultDelivered?: TeamToolsOptions['onAsyncResultDelivered'];
  private inspectTaskStatusQuery?: TeamToolsOptions['inspectTaskStatus'];
  private onDelegationEmptyOutcome?: TeamToolsOptions['onDelegationEmptyOutcome'];
  /** Opaque receipt id -> original host-owned dispatch recipe. Never serialized into a model response. */
  private emptyDelegationOutcomes = new Map<string, EmptyDelegationOutcomeRecipe>();
  /** Only user-turn sources that cannot be re-derived by the delegate. Replaced at every coordinator turn. */
  private delegationContentSources: DelegationContentSource[] = [];
  /** In-flight async delegations (Option B): handle -> { ref, promise }. Drained by await_tasks. */
  private pending = new Map<string, PendingAsyncTask>();
  /** Entries atomically claimed by await_tasks. They cannot be auto-woken or double-delivered. */
  private awaiting = new Map<string, PendingAsyncTask>();
  /** Settled pending results, kept until the host successfully starts an auto-wake turn or await_tasks owns them. */
  private readyAsync = new Map<string, AsyncDelegationResult & { task: PendingAsyncTask }>();
  /** Host-owned live overlay. A pending promise is storage, never a liveness inference. */
  private liveDispatchStateByHandle = new Map<string, LiveDispatchState>();
  private asyncWakeFlushQueued = false;
  /** Every teammate wait currently owned by this coordinator, including blocking assign_task retries. */
  private activeDispatches = new Map<string, ActiveDispatch>();
  /** Framework verdict of every delegation that has settled since the coordinator last read this.
   *  The coordinator's turn loop uses it to tell "the worker changed code and nobody verified it"
   *  (nudge) apart from "the worker did read-only research and the framework already called it
   *  verified" (nothing left to do — let the coordinator answer). */
  private settledOutcomes: DelegationOutcome[] = [];
  /** Current coordinator-session period. Entries are explicit framework observations, never prose inference. */
  private settledDelegations = new Map<string, SettledDelegation>();
  /** Cancellation receipts are deliberately outside settled results and coordinator dispositions. */
  private cancelledDelegations = new Map<string, DelegationCancellationEvent>();
  /** Every real task.assign receipt, retained so `superseded` cannot invent a replacement. */
  private dispatchReceipts = new Map<string, { agentId: string; requestedAgent: string }>();
  /** Dispatch attempts include a claim/capability refusal; dispatched counts only messages actually sent. */
  private dispatchAttempts = 0;
  /** The coordinator's own conclusion for this assignment, once it states one. */
  private assignmentCloseout?: AssignmentCloseoutEvent;
  private refusedDispatches: RefusedDispatch[] = [];
  /** Blocking waits that released their coordinator before the teammate settled. This is consumed by
   *  the coordinator backend so SessionManager cannot publish that turn as `task.complete`. */
  private timedOutBlockingDispatches = 0;
  /** Role-spread bookkeeping: how many of THIS coordinator's tasks each teammate is running right now
   *  (so a role ref skips a teammate we've already loaded up), and a monotonic "last assigned" stamp
   *  per teammate (so sequential role delegations round-robin instead of always hitting the first). */
  private busyCount = new Map<string, number>();
  private lastAssigned = new Map<string, number>();
  private dispatchSeq = 0;
  private contractClaimByHandle = new Map<string, string>();
  /** A coordinator-only/fallback attempt authorises self-do tools for this turn; it is not a broad bypass. */
  private coordinatorTaskAttempt?: TaskAttemptCard;
  /** Current-turn host-issued document receipts. They are cleared before the next user/delegated turn. */
  private turnContentReceipts = new Map<string, TurnContentReceipt>();
  /** An accepted terminal delivery remains immutable for the turn, even after its one publication is consumed. */
  private acceptedTurnDelivery?: PublishedTurnDelivery;
  /** The assistant payload waiting for its backend to emit it. */
  private pendingTurnDelivery?: PublishedTurnDelivery;

  constructor(
    private selfId: string,
    private view: TeamView,
    private bus: MessageBus,
    opts: TeamToolsOptions = {}
  ) {
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.verifyCommand = opts.verifyCommand ?? '';
    this.cwd = opts.cwd ?? process.cwd();
    this.runCommand = opts.runCommand ?? defaultRunner;
    this.commandPolicy = opts.commandPolicy;
    this.onCommandBlocked = opts.onCommandBlocked;
    this.onConfigOutsideRoot = opts.onConfigOutsideRoot;
    this.requestApproval = opts.requestApproval;
    this.onRoute = opts.onRoute;
    this.maxParallel = Math.max(1, opts.maxParallelDelegations ?? 5);
    this.claims = opts.claims;
    this.taskInputResolver = opts.taskInputResolver;
    this.approveCoordinatorBriefEgress = opts.approveCoordinatorBriefEgress;
    this.escalate = opts.escalate;
    this.evidenceEnabled = opts.evidenceEnabled ?? false;
    this.coordinatorId = opts.coordinatorId ?? selfId;
    this.onDelegationDispatched = opts.onDelegationDispatched;
    this.waitForTaskAdmission = opts.waitForTaskAdmission ?? false;
    this.admitCoordinatorAttempt = opts.admitCoordinatorAttempt;
    this.onDelegationRefused = opts.onDelegationRefused;
    this.onDelegationEvidence = opts.onDelegationEvidence;
    this.onDelegationDisposition = opts.onDelegationDisposition;
    this.onAssignmentCloseout = opts.onAssignmentCloseout;
    this.cancelDelegatedWorker = opts.cancelDelegatedWorker;
    this.stopTeammate = opts.stopTeammate;
    this.onDelegationCancelled = opts.onDelegationCancelled;
    this.onAsyncResultReady = opts.onAsyncResultReady;
    this.onAsyncResultRetained = opts.onAsyncResultRetained;
    this.onAsyncResultConsumed = opts.onAsyncResultConsumed;
    this.onAsyncResultDelivered = opts.onAsyncResultDelivered;
    this.inspectTaskStatusQuery = opts.inspectTaskStatus;
    this.onDelegationEmptyOutcome = opts.onDelegationEmptyOutcome;
    // A restarted host cannot revive an old worker promise. It can, however, restore the result the
    // worker had already delivered and which the coordinator had not yet collected. Do not auto-wake
    // here: the restored conversation already tells the coordinator to call collect_ready_tasks, and a new
    // backend is not necessarily idle when this constructor runs.
    for (const result of opts.recoveredAsyncResults ?? []) {
      if (!result.handle || !result.ref || typeof result.text !== 'string' || this.pending.has(result.handle)) {
        continue;
      }
      const task: PendingAsyncTask = { ref: result.ref, promise: Promise.resolve(result.text) };
      this.pending.set(result.handle, task);
      this.readyAsync.set(result.handle, { ...result, task });
      this.liveDispatchStateByHandle.set(result.handle, { agentId: result.ref, resultState: 'ready' });
    }
  }

  has(name: string): boolean {
    return TEAM_TOOL_NAMES.has(name);
  }

  /**
   * Start a fresh coordinator turn. This deliberately changes no prompt or nudge text; it only retires
   * receipt ids and terminal state so no publication can reach across turns.
   */
  beginTurnContentReceipts(): void {
    this.turnContentReceipts.clear();
    this.acceptedTurnDelivery = undefined;
    this.pendingTurnDelivery = undefined;
  }

  /**
   * Register one exact text source that a host tool returned this turn. The opaque id is the only thing a
   * model can name later; source bytes remain in this in-memory host record.
   */
  registerTurnContentReceipt(content: string): TurnContentReceipt | undefined {
    if (!content) return undefined;
    const receipt: TurnContentReceipt = {
      id: `receipt-${uuidv4()}`,
      content,
    };
    this.turnContentReceipts.set(receipt.id, receipt);
    return receipt;
  }

  /** Read exactly once after a successful terminal call; this text becomes the real assistant reply. */
  takePublishedTurnDelivery(): PublishedTurnDelivery | undefined {
    const delivery = this.pendingTurnDelivery;
    this.pendingTurnDelivery = undefined;
    return delivery;
  }

  /** Lets a streaming backend defer raw terminal prose until its host-published receipt takes its place. */
  hasPendingTurnDelivery(): boolean {
    return this.pendingTurnDelivery !== undefined;
  }

  /** An old MCP client called a name that a current PM never sees. Keep its conversion auditable. */
  noteCompatibilityAlias(from: string, to: string): void {
    this.onRoute?.(`Compatibility: translated legacy ${from} to ${to}; the current PM tool manifest exposes no blocking wait.`);
  }

  /**
   * Framework verdicts for the delegations that settled since the last call; reading clears them.
   *
   * The coordinator's turn loop uses this to decide whether a delegation left anything to verify. A
   * read-only research/review task comes back 'tool-activity-recorded' (see classifyDelegationEvidence):
   * framework activity is visible, but delivery quality is deliberately not inferred. A write that nobody
   * checked comes back 'replied-not-verified'. An empty/failed task comes back 'no-evidence' and a
   * dispatch that exceeded its wait window comes back 'timed-out' — both still need attention, but the
   * latter must not be mistaken for a worker that simply made no attempt.
   */
  takeSettledOutcomes(): DelegationOutcome[] {
    const outcomes = this.settledOutcomes;
    this.settledOutcomes = [];
    return outcomes;
  }

  /** Number of blocking delegations that timed out since the coordinator last inspected them. */
  takeTimedOutBlockingDispatches(): number {
    const timedOut = this.timedOutBlockingDispatches;
    this.timedOutBlockingDispatches = 0;
    return timedOut;
  }

  /** True when this coordinator has at least one teammate to delegate to. Used to gate the PM's own
   *  write/command tools: with teammates it must delegate; with none, its file tools are a real fallback. */
  hasTeammates(): boolean {
    return this.view.list().some((a) => a.id !== this.selfId);
  }

  /**
   * Set the current coordinator turn's source receipts. Standing workspace knowledge is deliberately
   * absent: every agent independently receives conventions, rules, docs index, memory, and skills from
   * the normal turn-context builder. Keeping this at the turn boundary prevents an old user attachment
   * from leaking into a later, unrelated delegation.
   */
  setDelegationContentSources(sources: readonly DelegationContentSource[] | undefined): void {
    // A new coordinator turn ends any unconsumed self-execution attempt from the prior turn.
    this.finishCoordinatorAttempt('settled');
    this.delegationContentSources = (sources ?? []).flatMap((source) => {
      if (!source || !/^content-[1-9]\d*$/.test(source.assetId)) { return []; }
      if (source.kind !== 'user-request' && source.kind !== 'context-mention' && source.kind !== 'user-attachment') { return []; }
      if (source.mediaKind !== 'text' && source.mediaKind !== 'pdf' && source.mediaKind !== 'image') { return []; }
      return [{
        assetId: source.assetId,
        kind: source.kind,
        label: String(source.label ?? '').slice(0, 240),
        location: String(source.location ?? '').slice(0, 800),
        ...(Number.isSafeInteger(source.textBytes) && source.textBytes! >= 0 ? { textBytes: source.textBytes } : {}),
        ...(Number.isSafeInteger(source.bytes) && source.bytes! >= 0 ? { bytes: source.bytes } : {}),
        mediaKind: source.mediaKind,
      }];
    });
  }

  currentCoordinatorTaskAttempt(): TaskAttemptCard | undefined {
    return this.coordinatorTaskAttempt;
  }

  /** A self-do tool is allowed only after a contract selected the coordinator and only for declared effects. */
  canCoordinatorExecute(toolName: string): boolean {
    const card = this.coordinatorTaskAttempt;
    if (!card || !this.taskInputResolver?.isAttemptLive(card.attemptId, this.selfId)) return false;
    const required = toolName === 'run_command' || toolName === 'check_command' || toolName === 'kill_command'
      ? 'shell'
      : 'write';
    return card.contract.requiredCapabilities.capabilities.includes(required);
  }

  finishCoordinatorAttempt(state: 'cancelled' | 'settled' = 'settled'): void {
    const card = this.coordinatorTaskAttempt;
    if (!card) return;
    this.taskInputResolver?.endAttempt(card.attemptId, state);
    this.claims?.release(card.contractId);
    this.coordinatorTaskAttempt = undefined;
  }

  specs(): ToolSpec[] {
    const specs = [
      spec('list_agents', 'List your teammates (id, role, and connection capability facts) so you can decide who to delegate to.', {}, []),
      spec(
        'dispatch_task',
        'Submit a versioned task contract. The host validates inputs, capabilities, scope, claims and verification sensors before selecting an executor. It dispatches asynchronously, authorises coordinator fallback only when the declared strategy permits it, or returns the distinct no-executor task state.',
        {
          agent: { type: 'string', description: 'Exact teammate id, display name, or role. Exact ids are never silently substituted; roles rotate only among candidates that pass every hard filter.' },
          instruction: { type: 'string', description: 'State the concrete action for the worker. Put any orientation the coordinator already established in contract.coordinator_brief. It cannot create capabilities, grants, scope, or dependencies; the structured contract is authoritative.' },
          contract: taskContractParameter(),
        },
        ['agent', 'instruction', 'contract']
      ),
      spec(
        'collect_ready_tasks',
        'Inspect delegated results that are already settled; this never waits or polls. Omit handles to collect every ready result. Pending handles are reported as pending so you can end the turn and let the host wake you when work settles.',
        {
          handles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional dispatch_task handles. Omit to inspect every task that is ready or still pending.',
          },
        },
        []
      ),
      spec(
        'inspect_task_status',
        'Inspect durable history merged with host-owned live worker, wait, result, and read-receipt state for your own delegation handles. This never waits, consumes a result, wakes a worker, or changes scheduling.',
        {
          handles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional delegation handles, returned in this order. Foreign handles are indistinguishable from unknown handles.',
          },
        },
        []
      ),
      spec(
        'close_assignment',
        'State your conclusion for the work you were given, and end it. Use this when the work is done AND when '
        + 'it cannot be finished: "partial" and "blocked" are real, reportable outcomes, not failures to hide. '
        + 'Never leave an assignment without one — an assignment with no conclusion reads to the user as a '
        + 'coordinator that stopped thinking, and UnodeAi will state the mechanical facts on your behalf.',
        {
          outcome: {
            type: 'string',
            enum: ['complete', 'partial', 'blocked'],
            description: 'complete: everything asked for was delivered. partial: some of it was, some was not. blocked: it cannot proceed as specified.',
          },
          summary: { type: 'string', description: 'What was actually delivered, in your own words. Required.' },
          incomplete: {
            type: 'array',
            description: 'Required for partial and blocked: one entry per thing not delivered, each with a concrete reason.',
            items: {
              type: 'object',
              properties: {
                item: { type: 'string', description: 'The thing that was asked for and not delivered.' },
                reason: { type: 'string', description: 'Why it could not be delivered. "Not done" is not a reason.' },
              },
              required: ['item', 'reason'],
            },
          },
        },
        ['outcome', 'summary']
      ),
      spec(
        'publish_content_receipt',
        'Publish one content receipt the host returned in this coordinator turn. Name its opaque receipt id, never a path and never copy its content. shown publishes the full receipt; partial publishes a host-sliced Unicode-code-point prefix; not-delivered publishes its reason and no receipt content. The accepted terminal state is emitted as the real assistant reply, not as this tool card.',
        {
          receipt_id: { type: 'string', description: 'Opaque host-issued content receipt id from this turn.' },
          state: { type: 'string', enum: ['shown', 'partial', 'not-delivered'], description: 'shown: publish the complete receipt. partial: publish a host-sliced prefix. not-delivered: publish the stated reason with no receipt content.' },
          framing: { type: 'string', description: 'Optional text the host places before shown or partial receipt content. Do not repeat the receipt here.' },
          visible_characters: { type: 'integer', description: 'Required only for partial: a safe integer Unicode-code-point prefix length from 1 through one less than the receipt length. Fractions are refused, never rounded.' },
          reason: { type: 'string', description: 'Required only for not-delivered: the concrete reason no receipt content was published.' },
        },
        ['receipt_id', 'state']
      ),
      spec(
        'record_task_disposition',
        'Record the coordinator decision you actually made about one settled delegated result. This does not judge the reply. Use the vocabulary precisely: needs-rework sends the concrete reason back to the delegate; needs-human escalates outside the agent loop; deferred, superseded, and accepted-with-caveat require their reason. This records coordinator acceptance only, never enterprise/customer acceptance.',
        {
          handle: { type: 'string', description: 'The settled delegation handle printed with the result.' },
          disposition: { type: 'string', enum: [...COORDINATOR_DISPOSITIONS], description: 'Your explicit coordinator decision; it is never inferred from the delegate reply.' },
          reason: { type: 'string', description: 'Required for rejected, needs-rework, needs-human, deferred, superseded, and accepted-with-caveat. State the actionable reason; rework reasons are forwarded to the delegate.' },
          replacement_handle: { type: 'string', description: 'Required only for superseded. First dispatch the replacement as a new task, then provide its real host handle here. This prevents a prose-only claim that work was re-dispatched.' },
        },
        ['handle', 'disposition']
      ),
      spec(
        'delegation_metrics',
        'Show current coordinator-session delegation counters: both framework calibration directions, dispatch attempts versus sent work, and coordinator closeout states. These are framework observations and coordinator decisions, not enterprise/customer acceptance.',
        {},
        []
      ),
      spec(
        'cancel_task',
        'STOP a teammate. Pass a handle to stop one assignment, agent to stop one teammate whatever it is '
        + 'doing, or all=true to stop every teammate. This ENDS their turn — it is not a request. broadcast '
        + 'and send_message only deliver a message and a running teammate finishes regardless, so use this '
        + 'when the user asks you to stop, never a broadcast.',
        {
          handle: { type: 'string', description: 'A delegation handle to stop. Its teammate is stopped too.' },
          agent: { type: 'string', description: 'A teammate id or name to stop, whatever started its turn.' },
          all: { type: 'boolean', description: 'Stop every teammate and cancel every assignment you have out.' },
          reason: { type: 'string', description: 'Why the work is being stopped. Recorded on the cancellation.' },
        },
        []
      ),
      spec(
        'broadcast',
        'Send an informational message to every teammate (fire-and-forget, no reply awaited).',
        { message: { type: 'string', description: 'The announcement to broadcast.' } },
        ['message']
      ),
      spec(
        'run_checks',
        'Build/type-check/test the WHOLE project to catch cross-file breakage after teammates edit different files. Returns pass or the failing output. Run this after implementation and after any fix.',
        {},
        []
      ),
    ];
    return this.isCoordinator()
      ? specs
      : specs.filter((entry) => !isDispatchTool(entry.function.name));
  }

  async run(name: string, args: Record<string, any>): Promise<string> {
    if (isDispatchTool(name) && !this.isCoordinator()) {
      this.markToolRefused('capability');
      return 'Error: task dispatch belongs to the coordinator. Ask the coordinator directly to consider and dispatch the work; no task was dispatched.';
    }
    switch (name) {
      case 'list_agents':
        return this.listAgents();
      case 'assign_task':
        return this.assignWithValidatedScope(String(args.agent ?? ''), String(args.instruction ?? ''), args.scope, args.verification_plan);
      case 'dispatch_task': {
        const compiled = compileTaskContract(args.contract, this.selfId, this.cwd);
        if (!compiled.contract) {
          const error = `Error: invalid task contract. ${compiled.error}`;
          this.recordRefusedDispatch(String(args.agent ?? ''), error);
          return error;
        }
        return this.assignContract(String(args.agent ?? ''), String(args.instruction ?? ''), compiled.contract);
      }
      case 'assign_task_async':
        return this.assignAsyncWithValidatedScope(
          String(args.agent ?? ''),
          String(args.instruction ?? ''),
          Array.isArray(args.files) ? args.files.map(String) : undefined,
          args.scope,
          args.verification_plan,
        );
      case 'collect_ready_tasks':
        return this.collectReadyTasks(Array.isArray(args.handles) ? args.handles.map(String) : undefined);
      case 'inspect_task_status':
        return this.inspectTaskStatus(Array.isArray(args.handles) ? args.handles.map(String) : undefined);
      case 'await_tasks':
        return this.awaitTasks(Array.isArray(args.handles) ? args.handles.map(String) : undefined);
      case 'close_assignment':
        return this.closeAssignment(args);
      case 'publish_content_receipt':
        return this.publishContentReceipt(args);

      case 'record_task_disposition':
        return this.recordTaskDisposition(
          String(args.handle ?? ''),
          String(args.disposition ?? ''),
          typeof args.reason === 'string' ? args.reason : undefined,
          typeof args.replacement_handle === 'string' ? args.replacement_handle : undefined,
        );
      case 'delegation_metrics':
        return this.delegationMetrics();
      case 'cancel_task':
        return this.cancelTask(args);
      case 'broadcast':
        this.bus.broadcast(this.selfId, 'broadcast.info', { instruction: String(args.message ?? '') });
        return 'Broadcast sent to all teammates. NOTE: a broadcast is a message, not a stop — a teammate '
          + 'already running finishes its turn regardless. Use cancel_task to actually stop a teammate.';
      case 'run_checks':
        return this.runChecks();
      default:
        this.markToolFailed();
        return `Error: unknown team tool "${name}".`;
    }
  }

  /**
   * Structured host boundary used by the in-process tool loop. `run` remains the explicit text adapter
   * for the MCP bridge and older embedders; its text is never handed to toolSummary as a host result.
   */
  async runOutcome(name: string, args: Record<string, any>): Promise<HostToolOutcome> {
    const observed: TeamToolOutcomeObservation = { status: 'success' };
    return this.toolOutcomeObservation.run(observed, async () => {
      try {
        const output = await this.run(name, args);
        if (observed.status === 'refused') {
          return hostToolRefused(output, observed.reason ?? 'capability');
        }
        if (observed.status === 'failed') {
          return hostToolFailed(output, { contentSource: observed.contentSource ?? 'host' });
        }
        return hostToolSucceeded(output, { contentSource: 'mixed-external' });
      } catch (error) {
        return hostToolFailed(`Team tool failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /**
   * `contentSource` is about the OUTPUT, not the decision. A failure whose text quotes a worker reply
   * or a subprocess is still a host decision, but its content was not written here and must not be
   * presented as though it were.
   */
  private markToolFailed(contentSource: 'host' | 'mixed-external' = 'host'): void {
    const observed = this.toolOutcomeObservation.getStore();
    if (!observed || observed.status === 'refused') return;
    observed.status = 'failed';
    if (contentSource === 'mixed-external') observed.contentSource = 'mixed-external';
  }

  private markToolRefused(reason: HostToolRefusalReason): void {
    const observed = this.toolOutcomeObservation.getStore();
    if (!observed) return;
    observed.status = 'refused';
    observed.reason = reason;
  }

  /**
   * A delegated subtask that failed is a fact this method already observed. Marking the invocation
   * is what keeps the tool result from being summarised as a successful call; the header is only how
   * that same fact is worded for the model. Both collectors go through here, so neither can carry
   * the wording without the status.
   */
  private delegationFailureHeader(anyFailed: boolean): string {
    if (!anyFailed) {
      return '';
    }
    // The sections this header introduces are worker replies verbatim.
    this.markToolFailed('mixed-external');
    return '[tasks FAILED] one or more delegated tasks failed.\n\n';
  }

  private toolFailure(output: string): string {
    this.markToolFailed();
    return output;
  }

  private toolRefusal(output: string, reason: HostToolRefusalReason): string {
    this.markToolRefused(reason);
    return output;
  }

  private isCoordinator(): boolean {
    return this.selfId === this.coordinatorId;
  }

  /**
   * Stop dispatched work, on the coordinator's own instruction.
   *
   * The machinery for this was complete and unreachable. `activeDispatches` has carried a `cancel` for every
   * dispatch — bus interruption, correlation-scoped, removing the assignment outright if the worker had not
   * started — and `cancelPending` has cancelled all of them since the Stop button needed it. No tool exposed
   * either, so a coordinator asked to stop everything could only broadcast, which delivers a message and
   * stops nothing. Field report, 2026-08-21: a PM told the user it had "sent direct instructions to stop"
   * and then, correctly, that it had no way to enforce them and they should press Stop themselves.
   *
   * **A coordinator's authority must not depend on how the work happened to start.** The first version of
   * this tool cancelled dispatches only, and reported honestly that a turn begun from a message kept
   * running. Owner, 2026-08-21: that limit is the thing to remove, not to document. So it stops the teammate
   * as well — the same power the host's Stop button has — and the caveat it used to carry is gone because
   * the gap it described is gone.
   */
  private cancelTask(args: Record<string, unknown>): string {
    const reason = typeof args.reason === 'string' && args.reason.trim()
      ? args.reason.trim()
      : 'Coordinator cancelled the assignment.';
    const handle = typeof args.handle === 'string' ? args.handle.trim() : '';
    const all = args.all === true;

    const agentRef = typeof args.agent === 'string' ? args.agent.trim() : '';

    if (!all && !handle && !agentRef) {
      return this.toolFailure('Error: cancel_task needs a handle, an agent, or all=true.');
    }

    if (all) {
      const cancelled = this.cancelPending(reason);
      // Every teammate, not only the ones holding a dispatch: a coordinator told to stop everything means
      // everything, and the teammate quietly working from an earlier message is exactly the one it would
      // otherwise miss.
      const stopped = this.delegatableRoster()
        .filter((teammate) => this.stopTeammate?.(teammate.id, reason))
        .map((teammate) => teammate.name);
      if (cancelled === 0 && stopped.length === 0) {
        return 'Nothing was running: no assignments out and no teammate mid-turn.';
      }
      return `Stopped ${stopped.length} teammate(s)${stopped.length ? ` (${stopped.join(', ')})` : ''} `
        + `and cancelled ${cancelled} assignment(s). Their turns are ended, not asked to end.`;
    }

    if (agentRef) {
      const target = this.resolveTarget(agentRef);
      if (!target) {
        return this.toolFailure(`Error: no teammate matches "${agentRef}". Use list_agents to see who is on the team.`);
      }
      const stopped = this.stopTeammate?.(target.id, reason) ?? false;
      return stopped
        ? `Stopped ${agentRef}. Its turn is ended, not asked to end.`
        : `${agentRef} was not running; nothing to stop.`;
    }

    const dispatch = this.activeDispatches.get(handle);
    if (!dispatch) {
      // Distinguish "already finished" from "never existed": a coordinator acting on a stale handle needs
      // to know which, and an error that covers both teaches it to retry the wrong thing.
      const known = this.pending.has(handle) || this.awaiting.has(handle);
      return known
        ? `Assignment ${handle} has already settled; there is nothing running to stop. `
          + 'Its result is still collectable.'
        : this.toolFailure(`Error: no assignment with handle ${handle} is running for you. Use collect_ready_tasks to see `
          + 'what is in flight.');
    }
    const agentId = dispatch.agentId;
    dispatch.cancel(reason);
    // Cancelling the dispatch releases the wait; stopping the teammate ends the turn it is in. Both, because
    // "stop this assignment" means the work stops, not that the coordinator stops listening to it.
    const alsoStopped = agentId ? this.stopTeammate?.(agentId, reason) ?? false : false;
    return `Cancelled ${handle}${alsoStopped ? ' and stopped its teammate' : ''}. `
      + 'The turn is ended, not asked to end.';
  }

  /**
   * Cancel every delegation wait owned by this coordinator. Used when the user presses Stop or the
   * coordinator backend is torn down; releases async file claims immediately so future work is not
   * blocked by stale ownership.
   */
  cancelPending(reason = DEFAULT_CANCEL_REASON): number {
    const active = [...this.activeDispatches.entries()];
    const activeHandles = new Set(active.map(([handle]) => handle));
    for (const [, dispatch] of active) {
      dispatch.cancel(reason);
    }
    const pendingHandles = [...this.pending.keys(), ...this.awaiting.keys()];
    for (const handle of pendingHandles) {
      // An active dispatch was already settled as a cancellation above. A ready result, by contrast,
      // has genuinely completed and is merely being discarded with its coordinator, not re-labelled.
      if (activeHandles.has(handle)) {
        continue;
      }
      this.pending.delete(handle);
      this.awaiting.delete(handle);
      this.readyAsync.delete(handle);
      this.updateLiveDispatch(handle, { resultState: 'none' });
      this.releaseDispatchClaim(handle);
      this.onAsyncResultConsumed?.(handle);
    }
    return activeHandles.size + pendingHandles.filter((handle) => !activeHandles.has(handle)).length;
  }

  /**
   * Capture an already-made coordinator decision. Collecting a result is not acceptance, and requiring
   * ceremony on every delegation would manufacture a signal. A rejection is nevertheless actionable: its
   * reason is delivered to the same delegate before any rework is assigned.
   */
  /**
   * The coordinator states a conclusion for the work it was given, including one it could not finish.
   *
   * Before this existed the vocabulary only covered a delegate's RESULT — nine dispositions, all of them
   * about a task that came back. There was no way to end an assignment that could not be completed, so a
   * coordinator handed an impossible or under-specified job had nothing to say and simply stopped. From the
   * user's side that is indistinguishable from a coordinator that quit thinking. (Owner, 2026-08-12:
   * "PM 也应该能自动收尾而不是悬在那里.")
   *
   * `partial` and `blocked` require per-item reasons for the same reason a rejection does: a bare label is
   * ceremony. And `complete` is REFUSED while a settled result carries no disposition — a conclusion that
   * steps over undisposed work is not a conclusion, and asking the model not to do it would be guidance.
   */
  private closeAssignment(args: Record<string, unknown>): string {
    const outcome = String(args.outcome ?? '') as AssignmentOutcome;
    if (outcome !== 'complete' && outcome !== 'partial' && outcome !== 'blocked') {
      return this.toolFailure('Error: outcome must be one of complete, partial, blocked.');
    }
    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
    if (!summary) {
      return this.toolFailure('Error: summary is required. State what was actually delivered.');
    }
    if (summary.length > 4_000) {
      return this.toolFailure('Error: summary exceeds the 4000-character limit; state the outcome concisely.');
    }
    const rawIncomplete = Array.isArray(args.incomplete) ? args.incomplete : [];
    const incomplete = rawIncomplete
      .map((entry) => (entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}))
      .map((entry) => ({
        item: typeof entry.item === 'string' ? entry.item.trim() : '',
        reason: typeof entry.reason === 'string' ? entry.reason.trim() : '',
      }))
      .filter((entry) => entry.item || entry.reason);
    if (outcome !== 'complete') {
      if (incomplete.length === 0) {
        return this.toolFailure(`Error: ${outcome} requires an incomplete list naming what was not delivered and why. `
          + 'Without it the outcome cannot be acted on by anyone.');
      }
      const bare = incomplete.find((entry) => !entry.item || !entry.reason);
      if (bare) {
        return this.toolFailure('Error: every incomplete entry needs both an item and a concrete reason. "Not done" is not a reason.');
      }
    }
    const closeout = this.coordinatorCloseoutState();
    if (outcome === 'complete' && closeout.settledButUndisposed > 0) {
      return this.toolFailure(`Error: ${closeout.settledButUndisposed} settled delegation(s) still have no disposition. `
        + 'Record those first, or close as partial and say what is unresolved.');
    }
    const event: AssignmentCloseoutEvent = {
      outcome,
      summary,
      incomplete,
      recordedAt: new Date().toISOString(),
    };
    this.assignmentCloseout = event;
    this.onAssignmentCloseout?.(event);
    return outcome === 'complete'
      ? 'Recorded: assignment closed as complete.'
      : `Recorded: assignment closed as ${outcome} with ${incomplete.length} unresolved item(s). `
        + 'This is a reportable outcome; it does not need to be retried before you answer the user.';
  }

  /**
   * Publish host-owned receipt bytes as the final assistant reply. The coordinator chooses which current
   * receipt and state apply, but never retypes bytes the host already owns.
   */
  private publishContentReceipt(args: Record<string, unknown>): string {
    if (this.acceptedTurnDelivery) {
      return this.toolFailure('Error: a terminal content receipt was already accepted for this turn. Start a new turn rather than revising a published state.');
    }
    const receiptId = typeof args.receipt_id === 'string' ? args.receipt_id.trim() : '';
    if (!receiptId) return this.toolFailure('Error: receipt_id is required. Name the opaque receipt id returned by a successful read in this turn.');
    const receipt = this.turnContentReceipts.get(receiptId);
    if (!receipt) {
      return this.toolFailure('Error: unknown or foreign content receipt. A receipt may be published only in the coordinator turn that recorded it.');
    }
    const state = args.state as ReceiptDeliveryState;
    if (state !== 'shown' && state !== 'partial' && state !== 'not-delivered') {
      return this.toolFailure('Error: state must be one of shown, partial, not-delivered.');
    }

    const framing = typeof args.framing === 'string' ? args.framing : '';
    if (framing.length > 4_000) return this.toolFailure('Error: framing exceeds the 4000-character limit; state it concisely.');
    let text: string;
    let visibleCharacters: number | undefined;

    if (state === 'shown') {
      text = frameReceiptContent(framing, receipt.content);
    } else if (state === 'partial') {
      const totalCharacters = unicodeCharacterCount(receipt.content);
      const requestedVisible = args.visible_characters;
      if (typeof requestedVisible !== 'number' || !Number.isSafeInteger(requestedVisible) || requestedVisible <= 0 || requestedVisible >= totalCharacters) {
        return this.toolFailure(`Error: partial requires visible_characters as a safe integer from 1 through ${Math.max(0, totalCharacters - 1)}. Fractions are not rounded.`);
      }
      visibleCharacters = requestedVisible;
      text = frameReceiptContent(framing, unicodePrefix(receipt.content, requestedVisible));
    } else {
      const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
      if (!reason) return this.toolFailure('Error: not-delivered requires a concrete reason.');
      if (reason.length > 4_000) return this.toolFailure('Error: reason exceeds the 4000-character limit; state it concisely.');
      text = reason;
    }

    const delivery: PublishedTurnDelivery = {
      text,
      state,
      receiptId,
      ...(visibleCharacters === undefined ? {} : { visibleCharacters }),
    };
    this.acceptedTurnDelivery = delivery;
    this.pendingTurnDelivery = delivery;
    return state === 'shown'
      ? `Recorded: host is publishing receipt ${receiptId} as the final reply.`
      : state === 'partial'
        ? `Recorded: host is publishing the first ${visibleCharacters} Unicode code point(s) of receipt ${receiptId} as the final reply.`
        : 'Recorded: host is publishing the stated non-delivery reason as the final reply.';
  }

  private recordTaskDisposition(
    handle: string,
    rawDisposition: string,
    rawReason?: string,
    rawReplacementHandle?: string,
  ): string {
    const key = handle.trim();
    const settled = this.settledDelegations.get(key);
    if (!settled) {
      return this.toolFailure('Error: no framework-observed settled delegation has that handle. Use the handle printed with a completed result; do not guess a disposition for an in-flight task.');
    }
    const disposition = rawDisposition as CoordinatorDisposition;
    if (!COORDINATOR_DISPOSITIONS.has(disposition)) {
      return this.toolFailure(`Error: disposition must be one of ${[...COORDINATOR_DISPOSITIONS].join(', ')}.`);
    }
    const reason = rawReason?.trim();
    if (REASON_REQUIRED_DISPOSITIONS.has(disposition) && !reason) {
      return this.toolFailure(`Error: ${disposition} requires a concrete reason. A bare label would be ceremony, not an actionable decision.`);
    }
    if (reason && reason.length > 2_000) {
      return this.toolFailure('Error: disposition reason exceeds the 2000-character limit; state the actionable reason concisely.');
    }
    const replacementHandle = rawReplacementHandle?.trim();
    const replacement = replacementHandle ? this.dispatchReceipts.get(replacementHandle) : undefined;
    if (disposition === 'superseded') {
      if (!replacementHandle) {
        return this.toolFailure('Error: superseded requires replacement_handle from a real new dispatch_task. Record needs-rework when the same teammate should revise its own result.');
      }
      if (!replacement || replacementHandle === settled.handle) {
        return this.toolFailure('Error: superseded replacement_handle must identify a different host-observed dispatch_task. No replacement was inferred from coordinator prose.');
      }
    }

    const event: DelegationDispositionEvent = {
      handle: settled.handle,
      agentId: settled.agentId,
      disposition,
      ...(reason ? { reason } : {}),
      ...(disposition === 'superseded' ? { replacementHandle } : {}),
      recordedAt: new Date().toISOString(),
      outcome: settled.outcome,
    };
    settled.dispositions.push(event);
    this.onDelegationDisposition?.(event);

    if (disposition === 'needs-rework') {
      this.bus.send(
        this.selfId,
        settled.agentId,
        'agent.message',
        { instruction: `Coordinator requested rework for delegation ${settled.handle}. Reason: ${reason}\n\nAddress this specific gap and return the corrected result with concrete evidence.` },
        'high',
        settled.handle,
      );
      return `Recorded needs-rework for ${settled.handle}; the actionable reason was sent to ${settled.agentId}.`;
    }
    if (disposition === 'rejected') {
      // This is a directed, actionable message rather than a status decoration. The worker may be asked to
      // redo the work later, but it receives the reason first (standing rule 15).
      this.bus.send(
        this.selfId,
        settled.agentId,
        'agent.message',
        { instruction: `Coordinator rejected delegation ${settled.handle}. Reason: ${reason}\n\nDo not redo work until you receive a new assignment; retain this reason for that rework.` },
        'high',
        settled.handle,
      );
      return `Recorded coordinator rejection for ${settled.handle}; the reason was sent to ${settled.agentId}. The displayed framework verdict is visibly amended, not rewritten.`;
    }
    if (disposition === 'needs-human') {
      return `Recorded that ${settled.handle} requires human intervention: ${reason}. This is not coordinator acceptance and is not enterprise acceptance.`;
    }
    if (disposition === 'deferred') {
      return `Recorded deferred for ${settled.handle}: ${reason}. The result remains in the append-only decision history.`;
    }
    if (disposition === 'superseded') {
      return `Recorded ${settled.handle} as superseded: ${reason}. Replacement ${replacementHandle} was host-dispatched to ${replacement!.agentId}; the framework verdict is retained for calibration.`;
    }
    if (disposition === 'accepted-with-caveat') {
      return `Recorded coordinator acceptance with caveat for ${settled.handle}: ${reason}. This is not enterprise/customer acceptance.`;
    }
    if (disposition === 'accepted-after-rework') {
      return `Recorded coordinator acceptance after rework for ${settled.handle}. This is not enterprise/customer acceptance.`;
    }
    if (disposition === 'accepted-despite-framework-no-evidence') {
      return `Recorded acceptance despite framework no-evidence for ${settled.handle}. The evidence verdict remains unchanged for calibration.`;
    }
    return `Recorded coordinator acceptance for ${settled.handle}. This is coordinator-accepted only; it is not enterprise/customer acceptance.`;
  }

  /** Current in-memory coordinator-session period. A new coordinator tool surface starts a new period. */
  private delegationMetrics(): string {
    const settled = [...this.settledDelegations.values()];
    const settledCount = settled.length;
    const completeDeliveries = settled.filter((entry) => entry.evidence?.completionState === 'complete').length;
    const partialDeliveries = settled.filter((entry) => entry.evidence?.completionState === 'partial').length;
    const completionNotObserved = settled.filter((entry) => entry.evidence?.completionState === 'not-observed').length;
    const cancelled = this.cancelledDelegations.size;
    const latest = (entry: SettledDelegation) => entry.dispositions.length > 0
      ? entry.dispositions[entry.dispositions.length - 1]
      : undefined;
    const accepted = settled.filter((entry) => isAcceptanceDisposition(latest(entry)?.disposition)).length;
    const greenThenRejected = settled.filter((entry) =>
      entry.outcome === 'verified' && isRejectionDisposition(latest(entry)?.disposition)
    ).length;
    const underCredited = settled.filter((entry) =>
      (entry.outcome === 'no-evidence' || entry.outcome === 'timed-out' || entry.outcome === 'replied-not-verified') &&
      isAcceptanceDisposition(latest(entry)?.disposition)
    ).length;
    const acceptedPartial = settled.filter((entry) =>
      entry.evidence?.completionState === 'partial' && isAcceptanceDisposition(latest(entry)?.disposition)
    ).length;
    const humanIntervention = settled.filter((entry) =>
      entry.dispositions.some((event) => event.disposition === 'needs-human')
    ).length;
    const closeout = this.coordinatorCloseoutState();
    const share = (count: number) => settledCount === 0 ? 'n/a (no settled delegations)' : `${count}/${settledCount} (${((count / settledCount) * 100).toFixed(1)}%)`;
    return [
      '[delegation metrics: current coordinator session]',
      `dispatch attempts: ${this.dispatchAttempts}; dispatched: ${this.dispatchAttempts - this.refusedDispatches.length}; rejected at dispatch: ${this.refusedDispatches.length}.`,
      `delegated tasks settled: ${settledCount}.`,
      `complete deliveries: ${completeDeliveries}.`,
      `partial deliveries: ${partialDeliveries}.`,
      `completion state not observed: ${completionNotObserved}.`,
      `delegated tasks cancelled: ${cancelled}. Cancellation is a terminal receipt, not a result or coordinator disposition.`,
      `coordinator-accepted: ${accepted}/${settledCount}.`,
      `accepted partial deliveries: ${acceptedPartial}/${settledCount}.`,
      `green framework verdict then coordinator-rejected: ${share(greenThenRejected)}.`,
      `framework no-evidence/timed-out/replied-not-verified then coordinator-accepted: ${share(underCredited)}.`,
      `explicit human intervention required: ${share(humanIntervention)}.`,
      `settled-but-undisposed: ${closeout.settledButUndisposed}.`,
      `accepted-but-ungated: ${closeout.acceptedButUngated}.`,
      `idle-with-no-live-work: ${closeout.idleWithNoLiveWork}.`,
      'Limit: coordinator-accepted is an agent coordinator decision, NOT enterprise/customer acceptance. This release has no human acceptance layer and does not claim one.',
    ].join('\n');
  }

  /** Current report-only coordinator closeout state. It never infers result quality from prose. */
  coordinatorCloseoutState(): CoordinatorCloseoutState {
    const settled = [...this.settledDelegations.values()];
    const latest = (entry: SettledDelegation) => entry.dispositions.at(-1);
    const settledButUndisposed = settled.filter((entry) => !latest(entry)).length;
    const recordedDispositionCount = settled.filter((entry) => !!latest(entry)).length;
    const acceptedButUngated = settled.filter((entry) => {
      const evidence = entry.evidence;
      const acceptedAt = Date.parse(latest(entry)?.recordedAt ?? '');
      const acceptanceCoveredByLaterCheck = this.lastPassingVerificationAt !== undefined &&
        Number.isFinite(acceptedAt) && acceptedAt < this.lastPassingVerificationAt;
      return isAcceptanceDisposition(latest(entry)?.disposition) &&
        !!evidence && (evidence.changedFiles.length > 0 || evidence.unrecordedWrites) &&
        evidence.outcome !== 'no-applicable-sensor' &&
        !evidence.verification.passed && !acceptanceCoveredByLaterCheck;
    }).length;
    const noApplicableSensor = settled.filter((entry) => entry.outcome === 'no-applicable-sensor').length;
    const verificationNotRun = settled.filter((entry) => entry.evidence?.verificationPlanStatus === 'not-run').length;
    const verificationFailed = settled.filter((entry) => entry.outcome === 'verification-failed').length;
    const awaitingHuman = settled.some((entry) => latest(entry)?.disposition === 'needs-human');
    const hasLiveDelegationWork = this.hasLiveDelegationWork();
    const idleWithNoLiveWork = settledButUndisposed > 0 && !awaitingHuman && !hasLiveDelegationWork ? 1 : 0;
    return {
      settledButUndisposed,
      recordedDispositionCount,
      acceptedButUngated,
      noApplicableSensor,
      verificationNotRun,
      verificationFailed,
      idleWithNoLiveWork,
      hasLiveDelegationWork,
      hasVerificationPath: this.verifyCommand.trim().length > 0,
      assignmentClosed: !!this.assignmentCloseout,
      // A conclusion is owed only once the coordinator actually took work on. A turn that answered from its
      // own knowledge owes nothing, and demanding a closeout there would be ceremony.
      assignmentOpen: this.dispatchAttempts > 0,
    };
  }

  private hasLiveDelegationWork(): boolean {
    return this.activeDispatches.size > 0 || this.liveAsyncTaskCount() > 0;
  }

  /**
   * An objective coordinator check discharges acceptances that were already recorded when it passed.
   * The delegation evidence is a receipt and must never be rewritten after the fact.
   */
  noteCoordinatorVerificationPassed(observedAt = Date.now()): void {
    this.lastPassingVerificationAt = Math.max(this.lastPassingVerificationAt ?? 0, observedAt);
  }

  /** Refused dispatches are not result dispositions: no worker ran and no settled handle exists. */
  private recordRefusedDispatch(
    ref: string,
    reason: string,
    taskState?: 'no-executor' | 'policy-refused',
    details: { handle?: string; policyId?: string; refusalReason?: HostToolRefusalReason } = {},
  ): void {
    if (details.refusalReason) this.markToolRefused(details.refusalReason);
    else this.markToolFailed();
    const recordedAt = new Date().toISOString();
    this.refusedDispatches.push({ ref, reason, recordedAt, disposition: 'rejected-at-dispatch' });
    this.onDelegationRefused?.({
      coordinatorId: this.selfId,
      requestedAgent: ref,
      reason,
      recordedAt,
      ...(taskState ? { taskState } : {}),
      ...(details.handle ? { handle: details.handle } : {}),
      ...(details.policyId ? { policyId: details.policyId } : {}),
    });
  }

  private rememberSettledDelegation(
    handle: string,
    agentId: string,
    outcome: DelegationOutcome,
    evidence?: DelegationEvidenceRecord,
  ): DelegationEvidenceRecord {
    // A retry cannot create a second settlement, but a late result may add host-held receipt counts to an
    // earlier timeout record. Preserve the original outcome and dispositions while refreshing those facts.
    if (!this.settledDelegations.has(handle)) {
      const observed = evidence ?? noEvidenceRecord(outcome);
      this.settledDelegations.set(handle, { handle, agentId, outcome, evidence: observed, dispositions: [] });
      this.onDelegationEvidence?.({ handle, agentId, outcome, evidence: observed });
    } else if (evidence) {
      const settled = this.settledDelegations.get(handle)!;
      const refreshed: DelegationEvidenceRecord = {
        ...evidence,
        ...(settled.evidence?.receiptSnapshots || evidence.receiptSnapshots
          ? { receiptSnapshots: { ...settled.evidence?.receiptSnapshots, ...evidence.receiptSnapshots } }
          : {}),
      };
      settled.evidence = refreshed;
      this.onDelegationEvidence?.({ handle, agentId: settled.agentId, outcome: settled.outcome, evidence: refreshed });
    }
    return this.settledDelegations.get(handle)!.evidence!;
  }

  /** Derive W5's structural receipt from the resolver held by the host, not any worker-sent metadata. */
  private settlementEvidence(
    outcome: DelegationOutcome,
    evidence: DelegationEvidenceRecord,
    attempt: TaskAttemptCard | undefined,
    preserveOutcome = false,
    snapshotKind: 'timeout' | 'terminal' | undefined = 'terminal',
  ): DelegationEvidenceRecord {
    const summary = attempt ? this.taskInputResolver?.requiredInputReadSummary(attempt.attemptId) : undefined;
    if (!summary) return evidence;
    const allRequiredReadReceiptsNotObserved = summary.requiredInputCount > 0
      && summary.requiredInputReadNotObservedCount === summary.requiredInputCount;
    const snapshot: RequiredInputReceiptSnapshot = {
      requiredInputCount: summary.requiredInputCount,
      requiredInputReadNotObservedCount: summary.requiredInputReadNotObservedCount,
      observedAt: new Date().toISOString(),
    };
    return {
      ...evidence,
      outcome: preserveOutcome || !allRequiredReadReceiptsNotObserved ? outcome : 'required-input-read-not-observed',
      requiredInputCount: summary.requiredInputCount,
      requiredInputReadNotObservedCount: summary.requiredInputReadNotObservedCount,
      ...(snapshotKind ? { receiptSnapshots: { ...evidence.receiptSnapshots, [snapshotKind]: snapshot } } : {}),
    };
  }

  private withDispositionPrompt(text: string, handle: string): string {
    return `${text}\n\n[coordinator disposition] Handle: ${handle}. Before ending this turn, record the decision you actually made: accepted, rejected, needs-rework, deferred, accepted-with-caveat, accepted-after-rework, accepted-despite-framework-no-evidence, superseded, or needs-human. Reasons are required for rejected, needs-rework, deferred, accepted-with-caveat, superseded, and needs-human. needs-rework keeps this same teammate; superseded requires a separate, real dispatch_task first and its replacement_handle. If the result says a user-supplied source is missing, report that gap before widening reach; do not web-search for a user-supplied fact before noting it missing. Do not invent a decision merely because this result arrived.`;
  }

  // ─── Private ──────────────────────────────────────────────────────────

  /** Advertised v0.9.61 path: candidate set first, every hard filter second, rotation last. */
  private async assignContract(ref: string, instruction: string, contract: EffectiveTaskContract): Promise<string> {
    this.dispatchAttempts++;
    if (!this.taskInputResolver) {
      return this.noExecutor(ref, 'the host input resolver is unavailable; no attempt was created');
    }
    if (contract.executionStrategy === 'coordinator-only') return this.authorizeCoordinatorExecution(contract);
    const inFlight = this.liveAsyncTaskCount();
    if (inFlight >= this.maxParallel) {
      const error = `Error: too many parallel tasks in flight (${inFlight}/${this.maxParallel}). End this turn and retry after one settles.`;
      this.recordRefusedDispatch(ref, error);
      return error;
    }
    const candidateSet = this.contractCandidateSet(ref);
    const evaluated = candidateSet.candidates.map((candidate) => ({ candidate, failures: this.contractCandidateFailures(contract, candidate) }));
    const survivors = evaluated.filter((entry) => entry.failures.length === 0).map((entry) => entry.candidate);
    if (candidateSet.exact && evaluated.length > 0 && survivors.length === 0) {
      const reasons = evaluated[0].failures.join('; ');
      return this.noExecutor(ref, `${reasons}; exact-id target was not substituted`);
    }
    if (survivors.length === 0) {
      const reasons = evaluated.length
        ? evaluated.map((entry) => `${entry.candidate.id}: ${entry.failures.join('; ')}`).join(' | ')
        : `no teammate matches "${ref}"`;
      return contract.executionStrategy === 'delegate-preferred'
        ? this.authorizeCoordinatorExecution(contract, reasons)
        : this.noExecutor(ref, reasons);
    }
    const target = this.rotateContractCandidates(survivors);
    const started = await this.startContractAttempt(target.id, ref, instruction, contract);
    if (!started.ok) {
      if (started.briefConsentDeclined) {
        const error = `Error: coordinator brief dispatch was not approved. ${started.error}`;
        this.recordRefusedDispatch(ref, error, undefined, { refusalReason: 'consent' });
        return error;
      }
      if (started.taskState === 'policy-refused') {
        return this.toolRefusal(`Error: task state policy-refused. ${started.error}`, 'capability');
      }
      return contract.executionStrategy === 'delegate-preferred'
        ? this.authorizeCoordinatorExecution(contract, started.error)
        : this.noExecutor(ref, started.error);
    }
    this.onRoute?.(`Routed contract ${contract.contractId} "${ref}" -> ${target.id} (${target.reason})`);
    const compliant = started.promise.then((result) => this.enforceContractCompliance(ref, target.id, instruction, result, contract, started.handle));
    const task: PendingAsyncTask = { ref: target.id, promise: compliant };
    this.pending.set(started.handle, task);
    void compliant.then(
      (text) => this.noteAsyncResultReady(started.handle, task, text),
      (reason) => this.noteAsyncResultReady(started.handle, task, `Error: ${String(reason)}`),
    );
    return `Dispatched contract ${contract.contractId} to ${target.id}. Handle: ${started.handle}. `
      + 'End this turn; UnodeAi opens a later PM turn when the result settles.';
  }

  private contractCandidateSet(ref: string): { exact: boolean; candidates: TeamRosterEntry[] } {
    const needle = ref.trim();
    const roster = this.delegatableRoster();
    const exact = roster.find((entry) => entry.id === needle);
    if (exact) return { exact: true, candidates: [exact] };
    const lower = needle.toLowerCase();
    return { exact: false, candidates: roster.filter((entry) => entry.role.toLowerCase() === lower || entry.name.toLowerCase() === lower) };
  }

  private candidateFacts(entry: TeamRosterEntry, contract?: EffectiveTaskContract): CandidateContractAgent {
    const sourceIds = this.delegationContentSources.map((source) => source.assetId);
    const ownedIds = (contract?.inputs ?? [])
      .filter((input) => input.kind === 'contentAsset')
      .map((input) => input.assetId)
      .filter((assetId) => this.taskInputResolver?.canDelegateOwnedContentAsset(assetId, this.selfId) === true);
    const authorizedContentAssetIds = [...new Set([...sourceIds, ...ownedIds])];
    return {
      agentId: entry.id,
      ...(entry.workspaceRoot ? { workspaceRoot: entry.workspaceRoot } : {}),
      capabilities: entry.capabilities
        ? { read: entry.capabilities.read, write: entry.capabilities.write, shell: entry.capabilities.shell }
        : undefined,
      taskScope: entry.capabilities?.taskScope,
      verificationSensors: entry.capabilities?.verificationSensors,
      authorizedContentAssetIds,
      liveContentAssetIds: this.taskInputResolver?.liveContentAssetIds(authorizedContentAssetIds) ?? [],
      readyArtifacts: this.taskInputResolver?.readyArtifacts() ?? [],
    };
  }

  private contractCandidateFailures(contract: EffectiveTaskContract, entry: TeamRosterEntry): string[] {
    const failures: string[] = [];
    if (isUnavailableStatus(entry.status)) failures.push('connection status is error');
    const preflight = preflightInputGrants(contract, this.candidateFacts(entry, contract));
    failures.push(...preflight.failures.map((failure) => `${failure.filter}: ${failure.reason}`));
    const missingBriefGrant = contract.coordinatorBrief?.basisRefs.find((inputId) =>
      !preflight.decisions.some((decision) => decision.inputId === inputId),
    );
    if (missingBriefGrant) {
      failures.push(`input-grant: coordinator brief cites input "${missingBriefGrant}", which was not granted; grant it or remove the reference`);
    }
    if (contract.effects.writeScope) {
      const scopeFailure = this.view.preflightTaskScope
        ? this.view.preflightTaskScope(entry.id, contract.effects.writeScope)
        : 'host task-scope preflight is unavailable';
      if (scopeFailure) failures.push(`task-scope: ${scopeFailure}`);
    }
    const claimCheck = this.claims?.check(contract.contractId, contractWriteClaims(contract));
    if (claimCheck && !claimCheck.ok) failures.push(`file-claim: ${(claimCheck.conflicts ?? []).join('; ')}`);
    return failures;
  }

  private rotateContractCandidates(candidates: TeamRosterEntry[]): { id: string; reason: string } {
    const ranked = candidates.map((entry) => ({
      entry,
      busy: (this.busyCount.get(entry.id) ?? 0) > 0 || isBusyStatus(entry.status),
      last: this.lastAssigned.get(entry.id) ?? -1,
    })).sort((a, b) => Number(a.busy) - Number(b.busy) || a.last - b.last);
    const selected = ranked[0];
    return {
      id: selected.entry.id,
      reason: candidates.length === 1
        ? 'only candidate surviving every hard filter'
        : `${selected.busy ? 'least-busy' : 'free'}, least-recently-assigned among ${candidates.length} filtered candidates`,
    };
  }

  private async startContractAttempt(
    targetId: string,
    requestedRef: string,
    instruction: string,
    contract: EffectiveTaskContract,
  ): Promise<{ ok: true; handle: string; promise: Promise<string> } | { ok: false; error: string; taskState?: 'policy-refused'; briefConsentDeclined?: true }> {
    const target = this.delegatableRoster().find((entry) => entry.id === targetId);
    if (!target || !this.taskInputResolver) return { ok: false, error: `target ${targetId} is unavailable` };
    const failures = this.contractCandidateFailures(contract, target);
    if (failures.length) return { ok: false, error: failures.join('; ') };
    const approveCoordinatorBriefEgress = this.approveCoordinatorBriefEgress;
    if (contract.coordinatorBrief && !approveCoordinatorBriefEgress) {
      return {
        ok: false,
        error: 'The host cannot obtain destination-specific consent for the coordinator-authored brief; no attempt was created.',
        briefConsentDeclined: true,
      };
    }
    if (contract.coordinatorBrief) {
      const approval = await approveCoordinatorBriefEgress!(this.selfId, target.id);
      if (!approval.allowed) {
        return {
          ok: false,
          error: approval.reason ?? 'The user declined to send the coordinator-authored brief to this destination.',
          briefConsentDeclined: true,
        };
      }
    }
    const handle = uuidv4();
    const claimed = this.claims?.claim(contract.contractId, target.id, contractWriteClaims(contract), instruction);
    if (claimed && !claimed.ok) return { ok: false, error: `file-claim: ${(claimed.conflicts ?? []).join('; ')}` };
    this.contractClaimByHandle.set(handle, contract.contractId);
    const attempt = await this.taskInputResolver.beginAttempt(contract, this.candidateFacts(target, contract), this.selfId);
    if (!attempt.card) {
      this.claims?.release(contract.contractId);
      this.contractClaimByHandle.delete(handle);
      return { ok: false, error: attempt.error ?? 'input grants could not be issued' };
    }
    const dispatched = this.dispatch(
      target.id, instruction, handle, contract.effects.writeScope, contract.verificationPlan,
      contract.effects.readFiles, contract, attempt.card, requestedRef,
    );
    if (!dispatched.ok) {
      this.taskInputResolver.endAttempt(attempt.card.attemptId, 'cancelled');
      this.claims?.release(contract.contractId);
      this.contractClaimByHandle.delete(handle);
      return dispatched;
    }
    return { ok: true, handle: dispatched.handle, promise: dispatched.promise };
  }

  private async enforceContractCompliance(
    ref: string,
    targetId: string,
    instruction: string,
    firstResult: string,
    contract: EffectiveTaskContract,
    originHandle = '',
  ): Promise<string> {
    if (!returnedNothing(firstResult)) return firstResult;
    // Claims are keyed by contractId, and TaskClaimRegistry.check skips an existing claim with that same
    // task ID. This firm retry re-claims the same contractId, so it cannot conflict with its own first
    // attempt. If claim identity is ever narrowed per attempt or handle, releasing the first claim becomes
    // load-bearing again. The retry still acquires a fresh execution lease through startContractAttempt.
    const secondAttempt = await this.startContractAttempt(targetId, targetId, this.firmRetry(instruction), contract);
    if (!secondAttempt.ok) return firstResult;
    const second = await secondAttempt.promise;
    this.contractClaimByHandle.delete(secondAttempt.handle);
    if (!returnedNothing(second)) return second;
    const escalation = this.escalate?.(targetId);
    if (!escalation?.switched) {
      this.recordEmptyDelegationOutcome(ref, targetId, instruction, contract, originHandle);
      return `[BLOCKED: ${ref} returned nothing across a fresh attempt-bound retry and no usable fallback execution exists.]`;
    }
    this.claims?.release(contract.contractId);
    const thirdAttempt = await this.startContractAttempt(targetId, targetId, this.firmRetry(instruction), contract);
    if (!thirdAttempt.ok) return `[BLOCKED: fallback attempt was refused: ${thirdAttempt.error}]`;
    const third = await thirdAttempt.promise;
    this.contractClaimByHandle.delete(thirdAttempt.handle);
    if (returnedNothing(third)) {
      this.recordEmptyDelegationOutcome(ref, targetId, instruction, contract, originHandle);
      return `[BLOCKED: ${ref} returned nothing after a retry and fallback attempt.]`;
    }
    return `[Note: switched ${ref} from ${escalation.from} to ${escalation.to} for a new attempt.]\n\n${third}`;
  }

  private async authorizeCoordinatorExecution(contract: EffectiveTaskContract, delegateFailure?: string): Promise<string> {
    if (this.coordinatorTaskAttempt
      && this.taskInputResolver?.isAttemptLive(this.coordinatorTaskAttempt.attemptId, this.selfId)) {
      return this.noExecutor(this.selfId, `coordinator already has live contract ${this.coordinatorTaskAttempt.contractId}; finish or cancel it before another coordinator attempt`);
    }
    this.coordinatorTaskAttempt = undefined;
    const coordinator = this.view.list().find((entry) => entry.id === this.selfId);
    if (!coordinator || !this.taskInputResolver) return this.noExecutor(this.selfId, 'coordinator capability facts or input resolver unavailable');
    const failures = this.contractCandidateFailures(contract, coordinator);
    if (failures.length) return this.noExecutor(this.selfId, failures.join('; '));
    const claimed = this.claims?.claim(contract.contractId, coordinator.id, contractWriteClaims(contract), contract.objective);
    if (claimed && !claimed.ok) return this.noExecutor(this.selfId, `file-claim: ${(claimed.conflicts ?? []).join('; ')}`);
    const attempt = await this.taskInputResolver.beginAttempt(contract, this.candidateFacts(coordinator, contract), this.selfId);
    if (!attempt.card) {
      this.claims?.release(contract.contractId);
      return this.noExecutor(this.selfId, attempt.error ?? 'coordinator input grants could not be issued');
    }
    const admission = this.admitCoordinatorAttempt?.(attempt.card);
    if (admission && !admission.allowed) {
      this.taskInputResolver.endAttempt(attempt.card.attemptId, 'cancelled');
      this.claims?.release(contract.contractId);
      this.recordRefusedDispatch(this.selfId, admission.reason, 'policy-refused', {
        handle: attempt.card.attemptId,
        policyId: admission.policyId,
        refusalReason: 'capability',
      });
      return `Error: task state policy-refused for "${this.selfId}". ${admission.reason}`;
    }
    this.coordinatorTaskAttempt = attempt.card;
    return `${delegateFailure ? `[delegate filters exhausted] ${delegateFailure}\n\n` : ''}`
      + 'Coordinator execution is authorised for this contract only. Every capability, input, scope, claim and sensor gate was re-evaluated.\n\n'
      + formatTaskAttemptCard(attempt.card);
  }

  private noExecutor(ref: string, reason: string): string {
    const text = `Error: task state no-executor for "${ref}". Unmet conditions: ${reason}. `
      + 'No agent failure was recorded and Solo was not used as a fallback.';
    this.recordRefusedDispatch(ref, text, 'no-executor', { refusalReason: 'capability' });
    return text;
  }

  private releaseDispatchClaim(handle: string): void {
    const claimId = this.contractClaimByHandle.get(handle) ?? handle;
    this.claims?.release(claimId);
    for (const [mappedHandle, mappedClaim] of this.contractClaimByHandle) {
      if (mappedClaim === claimId) this.contractClaimByHandle.delete(mappedHandle);
    }
  }

  private assignWithValidatedScope(ref: string, instruction: string, rawScope: unknown, rawPlan: unknown): Promise<string> {
    const parsed = parseDelegationTaskScope(rawScope);
    if (parsed.error) {
      const error = `Error: invalid task scope. ${parsed.error}`;
      this.recordRefusedDispatch(ref, error);
      return Promise.resolve(error);
    }
    const plan = parseVerificationPlan(rawPlan);
    if (plan.error) {
      const error = `Error: invalid verification plan. ${plan.error}`;
      this.recordRefusedDispatch(ref, error);
      return Promise.resolve(error);
    }
    return this.assignAndAwait(
      ref, instruction, parsed.scope, plan.plan,
      legacyTaskContract(instruction, this.selfId, { writeScope: parsed.scope, verificationPlan: plan.plan }),
    );
  }

  private assignAsyncWithValidatedScope(ref: string, instruction: string, files: string[] | undefined, rawScope: unknown, rawPlan: unknown): string {
    const parsed = parseDelegationTaskScope(rawScope);
    if (parsed.error) {
      const error = `Error: invalid task scope. ${parsed.error}`;
      this.recordRefusedDispatch(ref, error);
      return error;
    }
    const plan = parseVerificationPlan(rawPlan);
    if (plan.error) {
      const error = `Error: invalid verification plan. ${plan.error}`;
      this.recordRefusedDispatch(ref, error);
      return error;
    }
    return this.assignAsync(
      ref, instruction, files, parsed.scope, plan.plan,
      legacyTaskContract(instruction, this.selfId, { readFiles: files, writeScope: parsed.scope, verificationPlan: plan.plan }),
    );
  }

  /** The teammates this coordinator can delegate to: everyone except itself AND the standalone Solo
   *  agent. Solo is a no-delegate generalist the USER talks to directly for quick one-offs — it is not
   *  part of crew orchestration, so it never appears in list_agents or resolves as a delegation target. */
  private delegatableRoster() {
    return this.view.list().filter((a) => a.id !== this.selfId && a.role !== 'solo');
  }

  /** A compact "here's who you can delegate to" line for error recovery (e.g. when a model calls a
   *  delegation tool with an empty/unknown target — list the real roles so it can retry correctly). */
  private rosterHint(): string {
    const roster = this.delegatableRoster();
    if (roster.length === 0) { return 'You have no teammates to delegate to — make the change yourself.'; }
    const roles = [...new Set(roster.map((a) => a.role))].join(', ');
    return `Specify which teammate by role (one of: ${roles}) or id, then call dispatch_task again.`;
  }

  private listAgents(): string {
    const roster = this.delegatableRoster();
    if (roster.length === 0) {
      return 'You have no teammates yet. Ask the user to add agents to the team.';
    }
    // Intentionally DO NOT surface a "stopped"/"idle" status per agent: coordinators read that as
    // "unavailable" and refuse to delegate (they loop list_agents instead). Every teammate is
    // assignable — a stopped one starts automatically when you assign to it. Status is the runtime's
    // job, not the PM's.
    // The name is rendered because `resolveTarget` accepts one — its comment said "the PM sees both in
     // list_agents", and for a long time that was simply untrue: this line emitted the id and the role and
     // nothing else. A resolver that matches on a fact the model was never shown is a resolver nobody can use.
    const lines = roster.map((a) => `- ${a.id} — ${a.name} (role: ${a.role}`
      + `${a.specialty ? `; specialty: ${a.specialty}` : ''}`
      + `${describeSkills(a.skills)}${capabilityFacts(a)})`).join('\n');
    const inFlight = this.liveAsyncTaskDescriptions();
    const retained = inFlight.length > 0
      ? `\n\nStill in flight — do NOT re-dispatch this work yet:\n${inFlight.map((item) => `- ${item}`).join('\n')}\n` +
        'End this turn; a settled result opens a later PM turn automatically. collect_ready_tasks can inspect only results that are already ready.'
      : '';
    return `Your teammates — dispatch work to any of them with dispatch_task. You do NOT ` +
      `need to wait, "check the team", or have them "running" first: a teammate starts automatically when ` +
      `you dispatch a task to it. **Match the work to the specialty, not to whoever is first in the list** — ` +
      `several teammates share role "custom" and are told apart only by their name and specialty. Target by ` +
      `id or by name, then end your turn.\n${lines}${retained}`;
  }

  /** Pending entries include settled results retained for delivery; only the others are still using capacity. */
  private liveAsyncTaskCount(): number {
    let count = this.awaiting.size;
    for (const handle of this.pending.keys()) {
      if (!this.readyAsync.has(handle)) {
        count++;
      }
    }
    return count;
  }

  /** The coordinator needs an explicit view of retained late work before deciding to split or re-dispatch. */
  private liveAsyncTaskDescriptions(): string[] {
    const entries: string[] = [];
    for (const [handle, task] of this.pending) {
      if (!this.readyAsync.has(handle)) {
        entries.push(`${task.ref} (handle ${handle})`);
      }
    }
    for (const [handle, task] of this.awaiting) {
      entries.push(`${task.ref} (handle ${handle}; await_tasks is collecting it)`);
    }
    return entries;
  }

  /**
   * Resolve a delegation target from an id OR a role. Exact id always wins — explicit targeting is
   * never reinterpreted. For a ROLE that matches several teammates, SPREAD the work instead of always
   * picking the first match (the bug where a PM with two "senior-dev"s delegated both tasks to one):
   *   - prefer a teammate this coordinator isn't already running a task on, and that looks idle
   *     (catches parallel assign_task_async fan-out), then
   *   - among equals, prefer the least-recently-assigned / never-assigned one
   *     (round-robins sequential assign_task calls across same-role teammates).
   * Falls back to the extension's own resolver for names/aliases the roster lookup didn't catch.
   */
  private resolveTarget(ref: string): { id: string; reason: string } | undefined {
    const needle = ref.trim();
    if (!needle) { return undefined; }
    const roster = this.delegatableRoster();
    const byId = roster.find((a) => a.id === needle);
    if (byId) { return { id: byId.id, reason: 'pinned by exact id' }; }
    // Match by role OR display name (case-insensitive) — the PM sees both in list_agents and may use
    // either. Whichever matches several teammates, spread the work across them.
    const lc = needle.toLowerCase();
    const candidates = roster.filter((a) => a.role.toLowerCase() === lc || a.name.toLowerCase() === lc);
    if (candidates.length > 0) {
      // Router — hard filter: only an ERRORED teammate is "don't route here". A 'stopped' teammate is NOT
      // unavailable — it just hasn't started and auto-starts when assigned, so it's a FREE target. (If ALL
      // matches are errored, fall back to them so the task still resolves and the audit notes it.)
      const usable = candidates.filter((a) => !isUnavailableStatus(a.status));
      const pool = usable.length > 0 ? usable : candidates;
      // Rank: FREE (idle or stopped — not running a task and not loaded by this PM) before BUSY (running),
      // then least-recently-assigned (round-robin). So a busy agent is skipped for a free one; if every
      // candidate is busy, the least-loaded/least-recent gets it and the task simply queues (delay expected).
      const ranked = pool
        .map((a) => ({
          id: a.id,
          busy: (this.busyCount.get(a.id) ?? 0) > 0 || isBusyStatus(a.status),
          last: this.lastAssigned.get(a.id) ?? -1,
        }))
        .sort((x, y) => Number(x.busy) - Number(y.busy) || x.last - y.last);
      const pick = ranked[0];
      // Auditable "why this teammate" string (Router explainability).
      const reason = candidates.length === 1
        ? `only '${needle}' on the team`
        : `'${needle}': ${pick.busy ? 'least-busy (all candidates busy — will queue)' : 'free'}, ` +
          `least-recently-assigned (1 of ${pool.length}${usable.length === 0 ? ', all currently errored' : ''})`;
      return { id: pick.id, reason };
    }
    const resolved = this.view.resolve(needle);
    if (!resolved) { return undefined; }
    // The standalone Solo agent is never a delegation target — even if a coordinator names it by exact
    // id/alias, it is the user's direct quick-task option, not part of crew orchestration.
    if (this.view.list().some((a) => a.id === resolved.id && a.role === 'solo')) { return undefined; }
    return { id: resolved.id, reason: 'resolved by name/alias' };
  }

  /** Capabilities come only from the versioned declaration; task prose is never interpreted here. */
  private delegationCapabilityMismatch(agentId: string, contract: EffectiveTaskContract): string | undefined {
    const target = this.delegatableRoster().find((entry) => entry.id === agentId);
    const capabilities = target?.capabilities;
    const required = contract.requiredCapabilities.capabilities;
    if (required.length === 0) return undefined; // Explicit compatibility declaration, never an inference.
    if (!target || !capabilities) return `host has no capability facts for required set: ${required.join(', ')}`;
    const missing = required.filter((capability) => !capabilities[capability]);
    if (missing.length === 0) {
      return undefined;
    }
    const families = capabilities.toolFamilies.length > 0 ? capabilities.toolFamilies.join(', ') : 'none';
    return `${target.name} lacks declared capability ${missing.join(', ')} (tool families: ${families}).`;
  }

  /** A declared verification plan is a precondition for dispatch, not a wish we discover is impossible
   * after a worker has spent a turn. The roster supplies host-derived sensor reachability for production
   * agents; older standalone TeamTools hosts without those facts keep their legacy behaviour. */
  private delegationVerificationPlanMismatch(agentId: string, plan: VerificationPlan | undefined): string | undefined {
    if (!plan || plan.sensors.length === 0) {
      return undefined;
    }
    const target = this.delegatableRoster().find((entry) => entry.id === agentId);
    const capabilities = target?.capabilities;
    if (!target || !capabilities) {
      return undefined;
    }
    const reachable = new Set(capabilities.verificationSensors ?? []);
    const unavailable = plan.sensors.filter((sensor) => !reachable.has(sensor));
    if (unavailable.length === 0) {
      return undefined;
    }
    const available = capabilities.verificationSensors?.length
      ? capabilities.verificationSensors.join(', ')
      : 'none';
    return `${target.name} cannot satisfy verification sensor${unavailable.length === 1 ? '' : 's'} ` +
      `${unavailable.map((sensor) => `"${sensor}"`).join(', ')} on this connection ` +
      `(available through this target: ${available}).`;
  }

  /** A scope is a host-enforced ceiling, not advice. Reject before task.assign rather than asking a
   * native CLI to pretend it can shrink a fixed session boundary. */
  private delegationScopeMismatch(agentId: string, scope: DelegationTaskScope | undefined): string | undefined {
    if (!scope) return undefined;
    const target = this.delegatableRoster().find((entry) => entry.id === agentId);
    if (target?.capabilities?.taskScope === 'per-turn') return undefined;
    const compatible = this.delegatableRoster()
      .filter((entry) => entry.capabilities?.taskScope === 'per-turn')
      .map(({ id, name }) => ({ id, name }));
    const targetName = target?.name ?? agentId;
    const capability = target?.capabilities?.taskScope ?? 'unavailable';
    return 'task-scoped dispatch refused before assignment. ' +
      `Reason: ${targetName} has taskScope=${capability}, not per-turn. ` +
      `Compatible candidates: ${JSON.stringify(compatible)}. ` +
      'The named teammate was not substituted and the requested scope was not dropped.';
  }

  /** Record that a task is now running on a teammate (for role-spread). */
  private markBusy(agentId: string): void {
    this.lastAssigned.set(agentId, this.dispatchSeq++);
    this.busyCount.set(agentId, (this.busyCount.get(agentId) ?? 0) + 1);
  }

  /** Record that a task on a teammate finished (for role-spread). */
  private markFree(agentId: string): void {
    const left = (this.busyCount.get(agentId) ?? 1) - 1;
    if (left <= 0) { this.busyCount.delete(agentId); } else { this.busyCount.set(agentId, left); }
  }

  /**
   * Layer 2 — verification gate. Runs the user-configured verify command over the whole project.
   * This is the only reliable detector of cross-file semantic breakage (the compiler/tests), so
   * the PM runs it after implementation and feeds failures back as fix tasks.
   */
  private async runChecks(): Promise<string> {
    if (!this.verifyCommand.trim()) {
      return this.toolFailure('No verification command configured. Ask the user to set "unode.verifyCommand" (e.g. "npm run build" or "npx tsc --noEmit").');
    }
    const gate = await gateShellCommand({
      command: this.verifyCommand,
      roots: this.cwd,
      source: 'config',
      commandPolicy: this.commandPolicy,
      requestApproval: this.requestApproval,
      onConfigOutsideRoot: this.onConfigOutsideRoot,
    });
    if (!gate.ok) {
      if (gate.kind === 'approval') {
        const note = gate.note ? ` The user said: "${gate.note}".` : '';
        return this.toolRefusal(`Verification command not approved by the user.${note} Ask them how to proceed, or delegate the checks to a teammate.`, 'consent');
      }
      // Surface to the user too — otherwise the block is silent (only the LLM sees this string). B2.
      this.onCommandBlocked?.(gate.reason ?? 'command execution is disabled');
      return this.toolRefusal(
        `Verification command blocked by unode.commandApproval: ${gate.reason ?? gate.message}`,
        gate.kind === 'outside-unattended' ? 'scope' : 'capability',
      );
    }
    const { code, output } = await this.runCommand(this.verifyCommand, this.cwd);
    const tail = output.length > 8000 ? output.slice(-8000) : output;
    if (code !== 0 && isMisconfiguredCheckOutput(output)) {
      // The command couldn't even run (wrong tool for this project / not installed / missing script) — this
      // is NOT a code failure. Tell the PM to stop, not to delegate a phantom fix.
      this.markToolFailed('mixed-external');
      return `[checks MISCONFIGURED] \`${this.verifyCommand}\` could not run in this project — this is a wrong or ` +
        `missing verify command, NOT a code defect. Do NOT delegate a fix. Report to the user that ` +
        `\`unode.verifyCommand\` needs to point at this project's real test/build script (or be cleared).\n\n${tail}`;
    }
    if (code === 0) {
      this.noteCoordinatorVerificationPassed();
      return `[checks passed] \`${this.verifyCommand}\` exited 0.\n${tail}`.trimEnd();
    }
    this.markToolFailed('mixed-external');
    return `[checks FAILED] \`${this.verifyCommand}\` exited ${code}. These errors often mean one teammate's change broke a file another teammate depends on — assign a fix to the right teammate, then run_checks again.\n\n${tail}`;
  }

  /**
   * Blocking delegation: dispatch and wait for the one result, with agent-robustness enforcement when
   * a teammate hands back nothing usable (empty / "no output" — the classic weak-model refusal):
   *   L2 — force one firm retry on the same model.
   *   L3 — if still nothing, escalate the teammate to its fallback model and try once more.
   *   If there's no fallback (or the fallback also returns nothing), return a clear "this teammate's
   *   model is refusing; it needs a new/working model" message — which flows back to the PM (the agent
   *   talking to the user) as the assign_task result, so the user gets told.
   * Conservative: only truly-empty output triggers any of this, so a reviewer's legitimate short
   * verdict (or an explicit error) is never second-guessed.
   */
  private async assignAndAwait(
    ref: string,
    instruction: string,
    scope: DelegationTaskScope | undefined,
    verificationPlan: VerificationPlan | undefined,
    contract: EffectiveTaskContract,
  ): Promise<string> {
    this.dispatchAttempts++;
    // Resolve once (role → concrete teammate) so we can audit the choice, then dispatch by the exact
    // id (retries inside enforceCompliance stay on that same teammate).
    const target = this.resolveTarget(ref);
    if (!target) {
      const error = `Error: no teammate "${ref}". ${this.rosterHint()}`;
      this.recordRefusedDispatch(ref, error);
      return error;
    }
    if (target.id === this.selfId) {
      const error = 'Error: you cannot assign a task to yourself.';
      this.recordRefusedDispatch(ref, error);
      return error;
    }
    const first = this.dispatch(target.id, instruction, undefined, scope, verificationPlan, undefined, contract);
    if (!first.ok) {
      this.recordRefusedDispatch(ref, first.error);
      return first.error;
    }
    this.onRoute?.(`Routed "${ref}" → ${target.id} (${target.reason})`); // only after the dispatch is real
    const result = await this.enforceCompliance(ref, target.id, instruction, await first.promise, scope, verificationPlan, undefined, contract, first.handle);
    // A blocking timeout delivers the wait outcome, not the worker's still-pending result. Marking the
    // result delivered here would close the very late-result window inspect_task_status must expose.
    if (this.liveDispatchStateByHandle.get(first.handle)?.waitState === 'settled-on-time') {
      this.updateLiveDispatch(first.handle, { resultState: 'delivered' });
      this.onAsyncResultDelivered?.(first.handle, 'blocking-tool');
    }
    return result;
  }

  /**
   * Shared agent-robustness ladder for a delegated result, used by BOTH the blocking (assign_task)
   * and async (assign_task_async/await_tasks) paths: a teammate that returns nothing usable gets
   *   L2 — one firm retry on the same model, then
   *   L3 — escalation to its fallback model and one more try,
   * else a clear "this teammate's model is refusing; change its model" message. `firstResult` is the
   * awaited result of the initial dispatch; `targetId` is the resolved teammate id (for escalation).
   */
  private async enforceCompliance(
    ref: string,
    targetId: string,
    instruction: string,
    firstResult: string,
    scope?: DelegationTaskScope,
    verificationPlan?: VerificationPlan,
    files?: string[],
    contract: EffectiveTaskContract = legacyTaskContract(instruction, this.selfId),
    originHandle = '',
  ): Promise<string> {
    if (!returnedNothing(firstResult)) { return firstResult; }
    // Retry the SAME teammate (by exact id), never re-resolve the role — under role-spread a role ref
    // would round-robin the retry onto a different teammate.
    const retry = this.dispatch(targetId, this.firmRetry(instruction), undefined, scope, verificationPlan, files, contract);
    if (!retry.ok) { return firstResult; }
    return this.escalateIfStillEmpty(ref, targetId, instruction, retry.promise, scope, verificationPlan, files, contract, originHandle);
  }

  /** Shared firm-retry instruction wrapper used by L2/L3. */
  private firmRetry(instruction: string): string {
    return (
      `Your previous response did not do the task — you returned no usable output. This is required, ` +
      `not optional: carry it out NOW using your tools (read the relevant files, make the change with ` +
      `write_file, run any needed commands) and return the concrete result. Do not return an empty ` +
      `response again.\n\nTask: ${instruction}`
    );
  }

  /** L3: after a firm retry, if the teammate STILL returned nothing, escalate to its fallback model
   *  and try once more; otherwise report that its model is refusing and a new model is needed. */
  private async escalateIfStillEmpty(
    ref: string,
    targetId: string,
    instruction: string,
    retryPromise: Promise<string>,
    scope?: DelegationTaskScope,
    verificationPlan?: VerificationPlan,
    files?: string[],
    contract: EffectiveTaskContract = legacyTaskContract(instruction, this.selfId),
    originHandle = '',
  ): Promise<string> {
    const second = await retryPromise;
    if (!returnedNothing(second)) { return second; }

    const esc = this.escalate?.(targetId);
    if (esc?.switched) {
      const third = this.dispatch(targetId, this.firmRetry(instruction), undefined, scope, verificationPlan, files, contract);
      if (third.ok) {
        const out = await third.promise;
        if (!returnedNothing(out)) {
          return `[Note: ${ref} produced nothing on ${esc.from}; switched it to its fallback model ${esc.to} and retried.]\n\n${out}`;
        }
      }
      this.recordEmptyDelegationOutcome(ref, targetId, instruction, contract, originHandle);
      return `[BLOCKED: ${ref} returned nothing even after switching to its fallback model (${esc.to}). ` +
        `Its model appears to be refusing this task. Tell the user that ${ref} needs a different, working ` +
        `model — Edit the agent and change its model — then retry.]`;
    }

    const why = esc?.reason === 'already-on-fallback'
      ? 'and it is already on its fallback model'
      : 'and no fallback model is configured for it';
    this.recordEmptyDelegationOutcome(ref, targetId, instruction, contract, originHandle);
    return `[BLOCKED: ${ref} returned nothing across a firm retry, ${why}. Its model appears to be ` +
      `refusing this task. Tell the user that ${ref} needs a working model — Edit the agent to change ` +
      `its model (and optionally set a fallback model) — then retry.]`;
  }

  /**
   * Keep the original dispatch recipe solely on the host. A visible card receives only this opaque id
   * plus one bounded action kind; it cannot select a teammate, invent a command, or reconstruct a task.
   */
  private recordEmptyDelegationOutcome(
    requestedRef: string,
    agentId: string,
    instruction: string,
    contract: EffectiveTaskContract,
    correlationId: string,
  ): void {
    const outcomeId = `delegate-empty-${uuidv4()}`;
    this.emptyDelegationOutcomes.set(outcomeId, { outcomeId, agentId, requestedRef, instruction, contract });
    this.onDelegationEmptyOutcome?.({
      outcomeId,
      agentId,
      sessionId: this.selfId,
      correlationId,
      retry: () => this.retryEmptyDelegationOutcome(outcomeId),
    });
  }

  /**
   * A repair retry is a fresh contract admission, never a revival of a settled delivery. The cached
   * promise is the per-outcome idempotence guard for duplicate/concurrent webview clicks.
   */
  private retryEmptyDelegationOutcome(outcomeId: string): Promise<boolean> {
    const recipe = this.emptyDelegationOutcomes.get(outcomeId);
    if (!recipe) return Promise.resolve(false);
    if (recipe.retry) return recipe.retry;
    recipe.retry = (async () => {
      // The outcome belongs to this coordinator session. A card that survived roster/session teardown may
      // describe history, but it must not start new worker work with no coordinator able to receive it.
      const coordinator = this.view.list().find((entry) => entry.id === this.selfId);
      if (!coordinator || coordinator.status === 'stopped' || coordinator.status === 'error') return false;
      const started = await this.startContractAttempt(
        recipe.agentId,
        recipe.requestedRef,
        recipe.instruction,
        recipe.contract,
      );
      if (!started.ok) return false;
      const compliant = started.promise.then((result) =>
        this.enforceContractCompliance(recipe.requestedRef, recipe.agentId, recipe.instruction, result, recipe.contract, started.handle));
      const task: PendingAsyncTask = { ref: recipe.agentId, promise: compliant };
      this.pending.set(started.handle, task);
      void compliant.then(
        (text) => this.noteAsyncResultReady(started.handle, task, text),
        (reason) => this.noteAsyncResultReady(started.handle, task, `Error: ${String(reason)}`),
      );
      this.onRoute?.(`Retried empty delegation ${outcomeId} for ${recipe.agentId} through fresh contract admission.`);
      return true;
    })();
    return recipe.retry;
  }

  /**
   * Non-blocking delegation (Option B): dispatch and return a handle immediately. The teammate runs
   * concurrently; collect its result later with await_tasks. Independent, non-overlapping work only —
   * cross-file collisions are still caught by the FileCoordinator (re-read & retry) and run_checks.
   */
  private assignAsync(
    ref: string,
    instruction: string,
    files: string[] | undefined,
    scope: DelegationTaskScope | undefined,
    verificationPlan: VerificationPlan | undefined,
    contract: EffectiveTaskContract,
  ): string {
    this.dispatchAttempts++;
    // A settled result stays in `pending` until the coordinator collects or receives it, but it is no
    // longer running work. Counting it against the dispatch cap stranded stopped/failed delegates in a
    // slot until a model happened to call await_tasks. Only live promises consume the cap.
    const inFlight = this.liveAsyncTaskCount();
    if (inFlight >= this.maxParallel) {
      const error = `Error: too many parallel tasks in flight (${inFlight}/${this.maxParallel}). End this turn; dispatch again after a result settles. collect_ready_tasks never waits.`;
      this.recordRefusedDispatch(ref, error);
      return error;
    }
    const target = this.resolveTarget(ref);
    if (!target) {
      const error = `Error: no teammate "${ref}". ${this.rosterHint()}`;
      this.recordRefusedDispatch(ref, error);
      return error;
    }
    if (target.id === this.selfId) {
      const error = 'Error: you cannot assign a task to yourself.';
      this.recordRefusedDispatch(ref, error);
      return error;
    }
    // Option B step 2: claim the declared files BEFORE dispatching so two parallel tasks never own
    // overlapping files. The handle doubles as the claim id (released when the task is collected).
    const handle = uuidv4();
    if (this.claims && files && files.length > 0) {
      const verdict = this.claims.claim(handle, target.id, files, instruction);
      if (!verdict.ok) {
        const error = `Error: file conflict — this dispatch was not sent. ${(verdict.conflicts ?? []).join('; ')}. ` +
          'Re-partition ownership with the architect, or await the named in-flight task before re-dispatching.';
        this.recordRefusedDispatch(ref, error);
        return error;
      }
    }
    // Dispatch to the exact resolved id (not the role ref) so the file claim above and the actual
    // target can't diverge under role-spread, and so each parallel fan-out keeps its own teammate.
    const d = this.dispatch(target.id, instruction, handle, scope, verificationPlan, files, contract);
    if (!d.ok) {
      this.releaseDispatchClaim(handle);
      this.recordRefusedDispatch(ref, d.error);
      return d.error;
    }
    // Audit only once the task is actually dispatched (after the file-claim gate), so a conflict-rejected
    // delegation never produces a false "Routed …" line — auditability is the whole point of Router v1.
    this.onRoute?.(`Routed "${ref}" → ${target.id} (${target.reason}) [async]`);
    // Wrap with the same empty-retry + fallback-escalation ladder as the blocking path, so an async
    // teammate that returns nothing is retried/escalated too — not silently collected empty by
    // await_tasks. The file claim is released by awaitTasks AFTER this wrapped promise settles, so
    // retries hold their claim until the final result (no leak).
    const compliant = d.promise.then((r) => this.enforceCompliance(ref, d.ref, instruction, r, scope, verificationPlan, files, contract, d.handle));
    const task: PendingAsyncTask = { ref: d.ref, promise: compliant };
    this.pending.set(d.handle, task);
    // Observe settlement without consuming it. await_tasks atomically moves an entry to `awaiting`
    // before waiting, so its result can never also reach the host auto-wake path.
    void compliant.then(
      (text) => this.noteAsyncResultReady(d.handle, task, text),
      (reason) => this.noteAsyncResultReady(d.handle, task, `Error: ${String(reason)}`)
    );
    const base = `Dispatched to ${d.ref}. Handle: ${d.handle}. End this turn; UnodeAi opens a later PM turn when the result settles. collect_ready_tasks only inspects results that are already ready.`;
    // Conflict protection is opt-in: with no declared files this task isn't claim-guarded against
    // overlapping parallel work. Nudge the PM so it either declares files or serializes.
    const warn = !files || files.length === 0
      ? ' WARNING: no files declared — this task is NOT protected against file conflicts with other parallel tasks. Pass `files`, or dispatch dependent work only after its prerequisite has settled.'
      : '';
    return base + warn;
  }

  /**
   * Return only results already settled at the moment this tool runs.  It atomically consumes those
   * entries, so the normal auto-wake cannot later deliver the same result.  Crucially, it never awaits
   * a worker promise: a coordinator remains reachable while every requested handle is still pending.
   */
  private inspectTaskStatus(handles?: string[]): string {
    if (!this.inspectTaskStatusQuery) {
      return this.toolFailure('Error: durable task-status inspection is not configured for this coordinator.');
    }
    const durableRows = [...this.inspectTaskStatusQuery(handles)];
    const orderedHandles = handles?.length
      ? handles
      : [...new Set([...durableRows.map((row) => row.handle), ...this.liveDispatchStateByHandle.keys()])];
    const durableByHandle = new Map(durableRows.map((row) => [row.handle, row]));
    const rows = orderedHandles.map((handle) => this.projectLiveTaskStatus(
      durableByHandle.get(handle) ?? { handle, lifecycle: 'unknown' },
    ));
    if (rows.length === 0) {
      return 'No durable delegation records were observed for this coordinator.';
    }
    return rows.map((row) => {
      const lines = [
        row.lifecycle === 'unknown'
          ? `handle ${row.handle} · state: unknown`
          : `handle ${row.handle} · ${row.requestedAgent || row.agentId || 'agent'}`,
        `state: ${row.lifecycle}` + (row.delivery
          ? ` · delivery: ${row.delivery.state}${row.delivery.via ? ` via ${row.delivery.via}` : ''}${row.delivery.observedAt ? ` at ${row.delivery.observedAt}` : ''}`
          : ''),
        `worker state: ${row.workerState ?? 'unknown'}`,
        `wait state: ${row.waitState ?? 'not-started'}`,
        `result state: ${row.resultState ?? 'none'}`,
        `read receipt state: ${row.readReceiptState ?? 'not-applicable'}`,
      ];
      if (row.timedOutAt) lines.push(`timed out at: ${row.timedOutAt}`);
      if (row.lateWindowClosesAt) {
        const remainingSeconds = Math.max(0, Math.ceil((Date.parse(row.lateWindowClosesAt) - Date.now()) / 1000));
        lines.push(`late result window closes at: ${row.lateWindowClosesAt} · ${remainingSeconds}s remaining`);
      }
      if (row.runId) lines.push(`run: ${row.runId}`);
      if (row.lifecycle === 'policy-refused') {
        if (row.policyId) lines.push(`policy: ${row.policyId}`);
        if (row.policyReason) lines.push(`reason: ${row.policyReason}`);
      }
      if (row.progress) lines.push(`last observed: ${row.progress.activity} at ${row.progress.observedAt}`);
      if (row.evidenceOutcome) lines.push(`evidence: ${row.evidenceOutcome}`);
      if (typeof row.requiredInputCount === 'number' && typeof row.requiredInputReadNotObservedCount === 'number') {
        lines.push(`required inputs: ${row.requiredInputCount} declared · ${row.requiredInputReadNotObservedCount} read receipt(s) not observed`);
      }
      for (const input of row.inputReceipts ?? []) {
        lines.push(`input ${input.inputId}: supplied ${input.supplied ? 'yes' : 'no'} · reachable ${input.reachable ? 'yes' : 'no'} · read receipt ${input.readReceipt}`);
      }
      lines.push((row.contextGaps?.length ?? 0) > 0
        ? `context gap: ${row.contextGaps!.map((gap) => `${gap.inputId} (${gap.reason})`).join(', ')}`
        : 'context gap: none');
      lines.push(row.disposition
        ? `disposition: ${row.disposition.value}${row.disposition.replacementHandle ? ` · replacement ${row.disposition.replacementHandle}` : ''}`
        : 'disposition: not recorded');
      if (row.resultState === 'ready') {
        lines.push(`next action: call collect_ready_tasks with handle "${row.handle}"`);
      } else if (row.resultState === 'pending') {
        lines.push('next action: end this turn; the host will wake the coordinator when a result arrives');
      }
      return lines.join('\n');
    }).join('\n\n');
  }

  private projectLiveTaskStatus(row: CoordinatorTaskStatus): CoordinatorTaskStatus {
    const live = this.liveDispatchStateByHandle.get(row.handle);
    const rosterStatus = this.view.list().find((entry) => entry.id === (live?.agentId ?? row.agentId))?.status;
    const workerState = isSessionStatus(rosterStatus) ? rosterStatus : 'unknown';
    const resultState: DelegationResultState = live?.resultState
      ?? (row.delivery?.state === 'delivered' ? 'delivered'
        : row.delivery?.state === 'pending' ? 'ready'
          : row.lifecycle === 'active' ? 'pending' : 'none');
    const waitState: DelegationWaitState = live?.waitState
      ?? (row.lifecycle === 'active' ? 'within-deadline'
        : row.lifecycle === 'timed-out'
          ? resultState === 'ready' || resultState === 'delivered' ? 'timed-out-result-arrived' : 'timed-out-window-expired'
          : row.lifecycle === 'settled' ? 'settled-on-time'
            : row.lifecycle === 'cancelled' ? 'cancelled-before-timeout' : 'not-started');
    const currentSummary = live?.attemptId && this.taskInputResolver?.isAttemptLive(live.attemptId, live.agentId)
      ? this.taskInputResolver.requiredInputReadSummary(live.attemptId)
      : undefined;
    const currentInputReceipts = live?.attemptId && this.taskInputResolver?.isAttemptLive(live.attemptId, live.agentId)
      ? this.taskInputResolver.grantsForAttempt(live.attemptId).map((grant) => ({
          inputId: grant.inputId,
          supplied: true,
          reachable: typeof grant.reachableAt === 'string',
          readReceipt: typeof grant.readAt === 'string' ? 'observed' as const : 'not-observed' as const,
        }))
      : undefined;
    const requiredInputCount = currentSummary?.requiredInputCount ?? row.requiredInputCount;
    const requiredInputReadNotObservedCount = currentSummary?.requiredInputReadNotObservedCount
      ?? row.requiredInputReadNotObservedCount;
    const readReceiptState = readReceiptStateFor(requiredInputCount, requiredInputReadNotObservedCount);
    return {
      ...row,
      ...(live?.agentId && !row.agentId ? { agentId: live.agentId } : {}),
      workerState,
      waitState,
      resultState,
      readReceiptState,
      ...(live?.timedOutAt ? { timedOutAt: live.timedOutAt } : {}),
      ...(live?.lateWindowClosesAt && waitState === 'timed-out-window-open'
        ? { lateWindowClosesAt: live.lateWindowClosesAt }
        : {}),
      ...(typeof requiredInputCount === 'number' ? { requiredInputCount } : {}),
      ...(typeof requiredInputReadNotObservedCount === 'number' ? { requiredInputReadNotObservedCount } : {}),
      ...(currentInputReceipts ? { inputReceipts: currentInputReceipts } : {}),
    };
  }

  private updateLiveDispatch(handle: string, patch: Partial<LiveDispatchState>): void {
    const existing = this.liveDispatchStateByHandle.get(handle);
    if (!existing && typeof patch.agentId !== 'string') return;
    this.liveDispatchStateByHandle.set(handle, {
      ...(existing ?? { agentId: patch.agentId!, resultState: 'none' as const }),
      ...patch,
    });
  }

  private collectReadyTasks(handles?: string[]): string {
    const requested = handles && handles.length > 0 ? new Set(handles) : undefined;
    const ready = [...this.readyAsync.values()].filter((entry) =>
      (!requested || requested.has(entry.handle)) && this.pending.get(entry.handle) === entry.task
    );
    const pending = [...this.pending.entries()]
      .filter(([handle]) => (!requested || requested.has(handle)) && !this.readyAsync.has(handle))
      .map(([handle, task]) => `${task.ref} (${handle})`);
    if (ready.length === 0) {
      return pending.length > 0
        ? `No requested task result is ready yet. Still pending: ${pending.join(', ')}. End this turn; UnodeAi starts the result turn when work settles.`
        : 'No delegated result is ready for collection. This does not describe historical task status; use inspect_task_status to inspect a handle.';
    }

    let anyFailed = false;
    const sections = ready.map((entry) => {
      const text = entry.text;
      if (isTaskFailure(text) || text.trimStart().startsWith('[BLOCKED')) {
        anyFailed = true;
      }
      const body = text.length > AWAIT_RESULT_MAX ? text.slice(-AWAIT_RESULT_MAX) : text;
      this.readyAsync.delete(entry.handle);
      this.pending.delete(entry.handle);
      this.updateLiveDispatch(entry.handle, { resultState: 'delivered' });
      this.releaseDispatchClaim(entry.handle);
      this.onAsyncResultConsumed?.(entry.handle);
      this.onAsyncResultDelivered?.(entry.handle, 'collect-ready');
      return `=== ${entry.ref} (${entry.handle}) ===\n${body}`;
    });
    const header = this.delegationFailureHeader(anyFailed);
    const waiting = pending.length > 0 ? `\n\nStill pending: ${pending.join(', ')}.` : '';
    return header + sections.join('\n\n') + waiting;
  }

  /** Legacy owner-only synchronous probe. It is intentionally absent from specs(), so a PM cannot select it. */
  private async awaitTasks(handles?: string[]): Promise<string> {
    const wanted = handles && handles.length > 0
      ? handles.filter((h) => this.pending.has(h))
      : [...this.pending.keys()];
    if (wanted.length === 0) {
      return handles && handles.length > 0
        ? 'No matching pending tasks for those handles (already collected or never dispatched).'
        : 'No pending tasks to await.';
    }

    const entries = wanted.map((h) => ({ handle: h, ...this.pending.get(h)! }));
    // Claim synchronously, before the first await. A result that settles after this point belongs
    // exclusively to this await_tasks call; it must never be auto-fed back into the PM.
    for (const entry of entries) {
      this.pending.delete(entry.handle);
      this.awaiting.set(entry.handle, entry);
      this.readyAsync.delete(entry.handle);
    }
    const settled = await Promise.allSettled(entries.map((e) => e.promise));
    // Remove collected tasks and release their file claims so the paths free up for the next dispatch.
    for (const h of wanted) {
      this.awaiting.delete(h);
      this.updateLiveDispatch(h, { resultState: 'delivered' });
      this.releaseDispatchClaim(h);
      this.onAsyncResultConsumed?.(h);
      this.onAsyncResultDelivered?.(h, 'blocking-tool');
    }

    let anyFailed = false;
    const sections = entries.map((e, i) => {
      const r = settled[i];
      const text = r.status === 'fulfilled' ? r.value : `Error: ${String((r as PromiseRejectedResult).reason)}`;
      // A teammate that stayed empty through retry+escalation comes back as "[BLOCKED …]" — count it
      // as a failed subtask so the whole step is flagged and the PM sees it needs attention.
      if (r.status === 'rejected' || isTaskFailure(text) || text.trimStart().startsWith('[BLOCKED')) {
        anyFailed = true;
      }
      const body = text.length > AWAIT_RESULT_MAX ? text.slice(-AWAIT_RESULT_MAX) : text;
      return `=== ${e.ref} (${e.handle}) ===\n${body}`;
    });

    const header = this.delegationFailureHeader(anyFailed);
    return header + sections.join('\n\n');
  }

  /**
   * Called by the host only after it has atomically started an idle coordinator turn containing this
   * result. Returning false means await_tasks/cancel won the race, so the host must not treat it as
   * delivered. This deliberately is not a model-facing tool.
   */
  consumeAsyncResult(handle: string): boolean {
    const ready = this.readyAsync.get(handle);
    if (!ready || this.pending.get(handle) !== ready.task) {
      return false;
    }
    this.readyAsync.delete(handle);
    this.pending.delete(handle);
    this.updateLiveDispatch(handle, { resultState: 'delivered' });
    this.releaseDispatchClaim(handle);
    this.onAsyncResultConsumed?.(handle);
    this.onAsyncResultDelivered?.(handle, 'auto-wake');
    return true;
  }

  /** True only while this settled result is still eligible for host auto-delivery. */
  isAsyncResultReady(handle: string): boolean {
    const ready = this.readyAsync.get(handle);
    return !!ready && this.pending.get(handle) === ready.task;
  }

  /** Record a settled result, then batch every same-turn completion into one host wake opportunity. */
  private noteAsyncResultReady(handle: string, task: PendingAsyncTask, text: string): void {
    // cancelPending or await_tasks may have claimed this handle before its promise settled.
    if (this.pending.get(handle) !== task) {
      return;
    }
    const result = { handle, ref: task.ref, text, task };
    this.readyAsync.set(handle, result);
    const live = this.liveDispatchStateByHandle.get(handle);
    this.updateLiveDispatch(handle, {
      agentId: task.ref,
      resultState: 'ready',
      ...(live?.waitState === 'timed-out-window-open' ? { waitState: 'timed-out-result-arrived' as const } : {}),
    });
    this.onAsyncResultRetained?.({ handle, ref: task.ref, text });
    if (this.asyncWakeFlushQueued) {
      return;
    }
    this.asyncWakeFlushQueued = true;
    queueMicrotask(() => this.flushAsyncResultReady());
  }

  private flushAsyncResultReady(): void {
    this.asyncWakeFlushQueued = false;
    if (!this.onAsyncResultReady) {
      return;
    }
    // Keep ownership in `pending` while notifying the host. It removes a result only after it has
    // actually started a PM turn; a busy PM therefore leaves every result for await_tasks.
    for (const result of this.readyAsync.values()) {
      if (this.pending.get(result.handle) === result.task) {
        this.onAsyncResultReady({ handle: result.handle, ref: result.ref, text: result.text });
      }
    }
  }

  /**
   * Core dispatch shared by the blocking and async paths. Returns a handle (correlationId) and a
   * promise that resolves to the teammate's final output (or an error/timeout string — never rejects).
   */
  private dispatch(
    ref: string,
    instruction: string,
    handle: string = uuidv4(),
    scope?: DelegationTaskScope,
    verificationPlan?: VerificationPlan,
    files?: string[],
    contract: EffectiveTaskContract = legacyTaskContract(instruction, this.selfId),
    taskAttempt?: TaskAttemptCard,
    requestedRef: string = ref,
  ): { ok: true; handle: string; ref: string; promise: Promise<string> } | { ok: false; error: string; taskState?: 'policy-refused' } {
    const target = this.resolveTarget(ref);
    if (!target) {
      return { ok: false, error: `Error: no teammate "${ref}". ${this.rosterHint()}` };
    }
    if (target.id === this.selfId) {
      return { ok: false, error: 'Error: you cannot assign a task to yourself.' };
    }
    const scopeMismatch = this.delegationScopeMismatch(target.id, scope);
    if (scopeMismatch) {
      this.onRoute?.(`Declined delegation "${ref}" -> ${target.id}: ${scopeMismatch}`);
      return { ok: false, error: `Error: ${scopeMismatch}` };
    }
    const capabilityMismatch = this.delegationCapabilityMismatch(target.id, contract);
    if (capabilityMismatch) {
      this.onRoute?.(`Declined delegation "${ref}" → ${target.id}: ${capabilityMismatch}`);
      return {
        ok: false,
        error: `Error: delegation capability mismatch. ${capabilityMismatch} Choose a teammate with the required capability.`,
      };
    }
    const verificationPlanMismatch = this.delegationVerificationPlanMismatch(target.id, verificationPlan);
    if (verificationPlanMismatch) {
      this.onRoute?.(`Declined delegation "${ref}" → ${target.id}: ${verificationPlanMismatch}`);
      return {
        ok: false,
        error: `Error: verification plan mismatch. ${verificationPlanMismatch} Choose a target that can reach every declared sensor.`,
      };
    }

    // The handle is the correlation id stamped on the assign so even a synchronous completion is
    // matched — SessionManager echoes it back on the teammate's task.complete.
    const pendingId = handle;
    this.markBusy(target.id);

    let resolvePromise!: (text: string) => void;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let lateTask: PendingAsyncTask | undefined;
    let resolveLateResult: ((text: string) => void) | undefined;
    let lateTimer: ReturnType<typeof setTimeout> | undefined;
    let offComplete: () => void = () => undefined;
    let offPartial: () => void = () => undefined;
    let offError: () => void = () => undefined;
    let offStatus: () => void = () => undefined;
    let offAdmitted: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The cap is absolute, not a counter reset by a status event: even a looping worker that keeps
    // touching files cannot make a blocking delegation wait forever.
    const blockingDeadline = Date.now() + this.timeoutMs * MAX_BLOCKING_WAIT_WINDOWS;

    const promise = new Promise<string>((resolve) => {
      resolvePromise = resolve;
    });
    // Default 'no-evidence': an error, an empty reply, or a host with evidence disabled mean "we have no
    // framework proof this task is done" — which is exactly when the coordinator SHOULD still be nudged
    // to keep going. A timeout is deliberately distinct: the worker may still be alive, but the dispatch
    // wait ended without a result.
    const finish = (
      text: string,
      outcome: DelegationOutcome = 'no-evidence',
      evidence?: DelegationEvidenceRecord,
      completionState: DelegationCompletionState = 'not-observed',
    ) => {
      if (settled || cancelled) { return; }
      settled = true;
      offComplete();
      offPartial();
      offError();
      offStatus();
      offAdmitted();
      if (timer) { clearTimeout(timer); }
      if (lateTimer) { clearTimeout(lateTimer); }
      this.activeDispatches.delete(pendingId);
      this.updateLiveDispatch(pendingId, { waitState: 'settled-on-time', resultState: 'pending' });
      if (taskAttempt) this.taskInputResolver?.endAttempt(taskAttempt.attemptId, 'settled');
      this.markFree(target.id);
      const settledEvidence = evidence ?? this.settlementEvidence(outcome, noEvidenceRecord(outcome, completionState), taskAttempt, false, 'terminal');
      this.rememberSettledDelegation(pendingId, target.id, settledEvidence.outcome, settledEvidence);
      this.settledOutcomes.push(settledEvidence.outcome);
      resolvePromise(text);
    };

    /**
     * A cancellation has no worker result and must never enter the evidence/disposition result path.
     * It is intentionally separate from `finish`: the latter is a completed (possibly failed) result.
     */
    const finishCancelled = (reason: string) => {
      if (cancelled || (settled && !timedOut)) { return; }
      cancelled = true;
      settled = true;
      offComplete();
      offPartial();
      offError();
      offStatus();
      offAdmitted();
      if (timer) { clearTimeout(timer); }
      if (lateTimer) { clearTimeout(lateTimer); }
      this.activeDispatches.delete(pendingId);
      this.updateLiveDispatch(pendingId, {
        waitState: timedOut ? 'timed-out-cancelled' : 'cancelled-before-timeout',
        resultState: 'none',
      });
      if (taskAttempt) this.taskInputResolver?.endAttempt(taskAttempt.attemptId, 'cancelled');
      if (!timedOut) {
        this.markFree(target.id);
      }
      this.pending.delete(pendingId);
      this.readyAsync.delete(pendingId);
      this.releaseDispatchClaim(pendingId);
      this.onAsyncResultConsumed?.(pendingId);
      const event: DelegationCancellationEvent = {
        coordinatorId: this.selfId,
        handle: pendingId,
        agentId: target.id,
        reason,
        cancelledAt: new Date().toISOString(),
      };
      this.cancelledDelegations.set(pendingId, event);
      this.onDelegationCancelled?.(event);
      const text = `Error: ${reason}.`;
      if (timedOut) {
        lateTask = undefined;
        resolveLateResult?.(text);
      } else {
        resolvePromise(text);
      }
    };

    /** Resolve the separate late-result handle without treating a cancelled/expired wait as a new
     * coordinator event. `await_tasks` may already own this promise, so it must always settle. */
    const closeLate = (
      text: string,
      notifyCoordinator: boolean,
      outcome: DelegationOutcome = 'timed-out',
      evidence?: DelegationEvidenceRecord,
      completionState: DelegationCompletionState = 'not-observed',
      receiptSnapshotKind?: 'terminal',
    ) => {
      const task = lateTask;
      if (!task) { return; }
      lateTask = undefined;
      offComplete();
      offPartial();
      offError();
      offStatus();
      offAdmitted();
      if (lateTimer) { clearTimeout(lateTimer); }
      this.activeDispatches.delete(pendingId);
      this.updateLiveDispatch(pendingId, {
        waitState: notifyCoordinator ? 'timed-out-result-arrived' : 'timed-out-window-expired',
        resultState: notifyCoordinator ? 'pending' : 'none',
        lateWindowClosesAt: undefined,
      });
      // The dispatch outcome remains timed-out, but a terminal message that arrived inside the late
      // window still settled the attempt. Only expiry/cancellation closes the attempt as cancelled.
      if (taskAttempt) this.taskInputResolver?.endAttempt(taskAttempt.attemptId, notifyCoordinator ? 'settled' : 'cancelled');
      const settledEvidence = evidence ?? this.settlementEvidence(
        outcome,
        noEvidenceRecord(outcome, completionState),
        taskAttempt,
        true,
        receiptSnapshotKind,
      );
      this.rememberSettledDelegation(pendingId, target.id, outcome, settledEvidence);
      if (notifyCoordinator) {
        this.settledOutcomes.push(outcome);
      } else {
        // Stop `lateResult.then(noteAsyncResultReady)` from waking a coordinator after a cancel or
        // an expired window. An in-progress await_tasks holds the same promise in `awaiting` and
        // still receives the error below.
        this.pending.delete(pendingId);
        this.readyAsync.delete(pendingId);
      }
      resolveLateResult?.(text);
    };

    const frameLateResult = (text: string) =>
      `[late blocking result] The earlier assign_task timed out; the teammate later replied. ` +
      `Resume the plan from this result rather than treating the timed-out turn as complete.\n\n${text}`;

    const shownReply = (reply: string) => returnedNothing(reply) ? '(teammate returned no output)' : reply;

    const settleLateCompletion = (
      reply: string,
      metadata: unknown,
      completionState: Extract<DelegationCompletionState, 'complete' | 'partial'>,
    ) => {
      if (!lateTask) { return; }
      if (!this.evidenceEnabled || isTaskFailure(reply)) {
        closeLate(frameLateResult(shownReply(reply)), true, 'timed-out', undefined, completionState, 'terminal');
        return;
      }
      const evidence = delegationEvidenceFromMetadata(metadata);
      const record = this.settlementEvidence(
        'timed-out',
        classifyDelegationEvidence(reply, evidence, verificationPlan, completionState),
        taskAttempt,
        true,
        'terminal',
      );
      // The late reply may be useful, but it cannot revise the dispatch outcome that was already
      // recorded when the blocking wait elapsed. Keep the reply's evidence frame for the coordinator
      // while retaining `timed-out` in the surface and run record.
      closeLate(frameLateResult(this.withDispositionPrompt(formatDelegationEvidence(shownReply(reply), record), pendingId)), true, 'timed-out', record);
    };

    const timeOutBlockingWait = () => {
      if (settled) { return; }
      // A timeout releases only the coordinator's blocking turn. The teammate remains live, so keep
      // its correlation listener and expose a normal async-ready handle for a late result.
      settled = true;
      timedOut = true;
      if (timer) { clearTimeout(timer); }
      this.markFree(target.id);
      // Record the timeout now. A later reply is retained and shown to the coordinator, but it cannot
      // rewrite the fact that this dispatch exhausted its wait window into "no evidence" or a completed
      // task. This is the same distinction the UI and run ledger need to make.
      const timeoutEvidence = this.settlementEvidence('timed-out', noEvidenceRecord('timed-out'), taskAttempt, true, 'timeout');
      this.rememberSettledDelegation(pendingId, target.id, 'timed-out', timeoutEvidence);
      this.settledOutcomes.push('timed-out');
      this.timedOutBlockingDispatches++;
      const latePromise = new Promise<string>((resolve) => { resolveLateResult = resolve; });
      const task: PendingAsyncTask = { ref: target.id, promise: latePromise };
      lateTask = task;
      this.pending.set(pendingId, task);
      const timedOutAt = new Date().toISOString();
      const lateWindowClosesAt = new Date(Date.now() + this.timeoutMs * LATE_BLOCKING_RESULT_WINDOW_MULTIPLIER).toISOString();
      this.updateLiveDispatch(pendingId, {
        waitState: 'timed-out-window-open',
        resultState: 'pending',
        timedOutAt,
        lateWindowClosesAt,
      });
      void latePromise.then((text) => this.noteAsyncResultReady(pendingId, task, text));
      lateTimer = setTimeout(
        () => closeLate(
          `Error: late result window expired after ${Math.round(this.timeoutMs * LATE_BLOCKING_RESULT_WINDOW_MULTIPLIER / 1000)}s waiting for ${ref}.`,
          false
        ),
        this.timeoutMs * LATE_BLOCKING_RESULT_WINDOW_MULTIPLIER
      );
      const lateSeconds = Math.round(this.timeoutMs * LATE_BLOCKING_RESULT_WINDOW_MULTIPLIER / 1000);
      resolvePromise(
        `Error: timed out after ${Math.round(this.timeoutMs / 1000)}s waiting for ${ref}. ` +
        `The late-result window remains open for ${lateSeconds}s. ` +
        'End this turn; the host will wake the coordinator when a result arrives.',
      );
    };

    const armBlockingTimeout = () => {
      if (settled) { return; }
      if (timer) { clearTimeout(timer); }
      // An observed action earns one more normal window, but never past the non-negotiable ceiling.
      const delay = Math.max(0, Math.min(this.timeoutMs, blockingDeadline - Date.now()));
      timer = setTimeout(timeOutBlockingWait, delay);
    };

    const settleCompletion = (
      reply: string,
      metadata: unknown,
      completionState: Extract<DelegationCompletionState, 'complete' | 'partial'>,
    ) => {
      if (timedOut) {
        settleLateCompletion(reply, metadata, completionState);
        return;
      }
      if (!this.evidenceEnabled || isTaskFailure(reply)) {
        finish(shownReply(reply), 'no-evidence', undefined, completionState);
        return;
      }
      const evidence = delegationEvidenceFromMetadata(metadata);
      const classified = classifyDelegationEvidence(reply, evidence, verificationPlan, completionState);
      const record = this.settlementEvidence(classified.outcome, classified, taskAttempt, false, 'terminal');
      finish(this.withDispositionPrompt(formatDelegationEvidence(shownReply(reply), record), pendingId), record.outcome, record);
    };

    offComplete = this.bus.onType('task.complete', (m) => {
      if (m.correlationId !== pendingId) return;
      // Keep the raw reply for evidence. Replacing an empty result with display prose here used to let
      // the placeholder satisfy T4's non-empty-delivery check and incorrectly turn tool activity green.
      settleCompletion(typeof m.payload.instruction === 'string' ? m.payload.instruction : '', m.payload.metadata, 'complete');
    });
    offPartial = this.bus.onType('task.partial', (m) => {
      if (m.correlationId !== pendingId) return;
      settleCompletion(m.payload.instruction, m.payload.metadata, 'partial');
    });
    offError = this.bus.onType('system.error', (m) => {
      if (m.correlationId === pendingId) {
        const policyMetadata = m.payload.metadata as { policyRefused?: unknown; policyId?: unknown } | undefined;
        if (policyMetadata?.policyRefused === true) {
          if (settled || cancelled) return;
          settled = true;
          offComplete();
          offPartial();
          offError();
          offStatus();
          offAdmitted();
          if (timer) clearTimeout(timer);
          this.activeDispatches.delete(pendingId);
          this.updateLiveDispatch(pendingId, { waitState: 'not-started', resultState: 'none' });
          if (taskAttempt) this.taskInputResolver?.endAttempt(taskAttempt.attemptId, 'cancelled');
          this.markFree(target.id);
          this.pending.delete(pendingId);
          this.readyAsync.delete(pendingId);
          this.releaseDispatchClaim(pendingId);
          // Admission never happened, so this handle must not remain eligible as a
          // replacement/retry receipt for a dispatch that the host never started.
          this.dispatchReceipts.delete(pendingId);
          const reason = String(m.payload.instruction ?? 'Team policy refused this attempt.');
          this.recordRefusedDispatch(requestedRef, reason, 'policy-refused', {
            handle: pendingId,
            ...(typeof policyMetadata.policyId === 'string' ? { policyId: policyMetadata.policyId } : {}),
            refusalReason: 'capability',
          });
          resolvePromise(`Error: task state policy-refused. ${reason}`);
          return;
        }
        if ((m.payload.metadata as { cancelled?: unknown } | undefined)?.cancelled === true) {
          finishCancelled(String(m.payload.instruction ?? DEFAULT_CANCEL_REASON));
          return;
        }
        if (timedOut) {
          closeLate(frameLateResult(`Error from ${ref}: ${m.payload.instruction || 'task failed'}`), true, 'timed-out', undefined, 'not-observed', 'terminal');
          return;
        }
        finish(`Error from ${ref}: ${m.payload.instruction || 'task failed'}`);
      }
    });
    offStatus = this.bus.onType('task.status', (m) => {
      if (m.correlationId !== pendingId || timedOut || settled) {
        return;
      }
      // `task.status` by itself is only a claim. The SessionManager adds this field exclusively when
      // it observed a worker tool action; terminal mid-plan status and timer heartbeats cannot renew.
      if (isObservedDelegationProgress(m.payload.metadata)) {
        armBlockingTimeout();
      }
    });
    armBlockingTimeout();
    this.activeDispatches.set(pendingId, {
      agentId: target.id,
      cancel: (reason = DEFAULT_CANCEL_REASON) => {
        if (cancelled || (settled && !timedOut)) { return; }
        const event: DelegationCancellationEvent = {
          coordinatorId: this.selfId,
          handle: pendingId,
          agentId: target.id,
          reason,
          cancelledAt: new Date().toISOString(),
        };
        // The host interruption publishes the same correlation-scoped cancellation back on the bus.
        // If the worker has not yet started, it still removes that exact queued assignment. Either way,
        // do not let a local PM wait cancellation masquerade as a worker result.
        this.cancelDelegatedWorker?.(event);
        finishCancelled(reason);
      },
    });
    this.liveDispatchStateByHandle.set(pendingId, {
      agentId: target.id,
      waitState: 'within-deadline',
      resultState: 'pending',
      ...(taskAttempt ? { attemptId: taskAttempt.attemptId } : {}),
    });

    const dispatchedAt = new Date().toISOString();
    const requiredCapabilities = [...contract.requiredCapabilities.capabilities];
    const routing: DelegationRoutingReceipt = {
      taskClassification: requiredCapabilities.includes('write') || requiredCapabilities.includes('shell')
        ? 'implementation'
        : requiredCapabilities.includes('read') ? 'research-or-review' : 'general',
      requiredCapabilities,
      compatibilityFilters: [
        'target-resolved',
        'declared-capabilities-checked',
        'input-grants-preflighted',
        'file-claims-checked',
        ...(verificationPlan ? ['verification-sensors-checked'] : []),
        scope ? 'task-scope-per-turn-checked' : 'fixed-session-permissions-used',
      ],
      selectionReason: target.reason,
    };
    const grantedAssetIds = new Set(taskAttempt?.grants.flatMap((grant) => grant.resolvedContentAssetId ? [grant.resolvedContentAssetId] : []) ?? []);
    const handedSources = taskAttempt
      ? this.delegationContentSources.filter((source) => grantedAssetIds.has(source.assetId))
      : this.delegationContentSources;
    const dispatchEvent: DelegationDispatchEvent = {
      coordinatorId: this.selfId,
      handle: pendingId,
      requestedAgent: requestedRef,
      agentId: target.id,
      instruction: this.normalizeSharedPaths(instruction),
      contract,
      ...(taskAttempt ? { attemptId: taskAttempt.attemptId } : {}),
      ...(verificationPlan ? { verificationPlan } : {}),
      ...(scope ? { scope } : {}),
      scopeMode: scope ? 'per-turn-requested' : 'fixed-session-permissions',
      routing,
      dispatchedAt,
    };
    let admitted = !this.waitForTaskAdmission;
    if (this.waitForTaskAdmission) {
      offAdmitted = this.bus.onType('task.admitted', (message) => {
        if (message.correlationId !== pendingId || admitted || settled || cancelled) return;
        admitted = true;
        offAdmitted();
        this.onDelegationDispatched?.(dispatchEvent);
      });
    }
    this.dispatchReceipts.set(pendingId, { agentId: target.id, requestedAgent: ref });
    this.bus.send(
      this.selfId,
      target.id,
      'task.assign',
      {
        instruction: this.normalizeSharedPaths(instruction),
        // A declared file remains a task pointer/ownership fact, never a filesystem grant. The receiving
        // SessionManager already carries this through to TurnAttachments for both backend prompt builders.
        ...(files !== undefined ? { files: [...files] } : {}),
        ...(scope ? { taskScope: scope } : {}),
        ...(verificationPlan ? { verificationPlan } : {}),
        ...(taskAttempt ? { taskAttempt } : {}),
        // An explicit empty list is meaningful: it tells a current-version delegate that no user source
        // was supplied, so a task that depends on one must report that gap rather than web-searching.
        delegationContentSources: handedSources,
      },
      'high',
      pendingId,
    );
    if (!this.waitForTaskAdmission) this.onDelegationDispatched?.(dispatchEvent);

    if (settled && !admitted) {
      return { ok: false, error: 'the worker was not started by team policy', taskState: 'policy-refused' };
    }

    return { ok: true, handle: pendingId, ref: target.id, promise };
  }

  /** Convert only root-contained absolute paths to workspace-relative form before a worktree handoff. */
  private normalizeSharedPaths(instruction: string): string {
    return normalizeWorkspacePathsInInstruction(instruction, this.cwd);
  }
}

/**
 * True only when a delegated teammate handed back nothing usable — an empty/whitespace turn or the
 * "(teammate returned no output)" placeholder dispatch() substitutes for a blank result. Deliberately
 * narrow: a non-empty answer (including a reviewer's short verdict or an explicit error) is NOT treated
 * as "nothing", so the firm retry only fires on the unambiguous refusal case. Exported for testing.
 */
/** Render host-derived facts compactly enough that a coordinator sees them before selecting a teammate. */
/**
 * Render a teammate's skills, bounded.
 *
 * A roster is read on every coordinator turn, so an unbounded list is a running token cost paid to say the
 * same thing forever. Six names identify a specialist; the rest are a count, and a coordinator that needs
 * the detail is choosing on something the first six did not already settle.
 */
const MAX_LISTED_SKILLS = 6;

function describeSkills(skills: readonly string[] | undefined): string {
  if (!skills || skills.length === 0) {
    return '';
  }
  const shown = skills.slice(0, MAX_LISTED_SKILLS).join(', ');
  const extra = skills.length - MAX_LISTED_SKILLS;
  return `; skills: ${shown}${extra > 0 ? ` (+${extra} more)` : ''}`;
}

function capabilityFacts(entry: TeamRosterEntry): string {
  const capabilities = entry.capabilities;
  if (!capabilities) {
    return '';
  }
  const families = capabilities.toolFamilies.length > 0 ? capabilities.toolFamilies.join(', ') : 'none';
  // These are the CONNECTION's tool families, not the agent's effective Folder Access. Extra families
  // (e.g. write yes) are NOT a mismatch for a task that needs less: a read-only audit only requires
  // read/search, so an agent that also has write remains assignable to it. list_agents does not report
  // a Folder Access grant or effective filesystem restriction — do not infer one from these facts.
  // A task scope aimed at an agent that cannot enforce one is refused at dispatch. Saying so here is what
  // turns that refusal from a wasted assignment into a choice the coordinator can make correctly first time.
  const scope = capabilities.taskScope
    ? `; task scope: ${capabilities.taskScope}${capabilities.taskScope === 'per-turn'
        ? ' (a per-assignment folder scope CAN be enforced)'
        : ' (a per-assignment folder scope CANNOT be enforced — dispatch to this teammate WITHOUT a task scope, or pick a teammate whose task scope is per-turn)'}`
    : '';
  const backend = capabilities.backend ? `; backend: ${capabilities.backend}` : '';
  const sensors = capabilities.verificationSensors
    ? `; verification sensors: ${capabilities.verificationSensors.length > 0 ? capabilities.verificationSensors.join(', ') : 'none'}`
    : '';
  return `${backend}${scope}${sensors}; connection capabilities: shell ${capabilities.shell ? 'yes' : 'no'}, write ${capabilities.write ? 'yes' : 'no'}, ` +
    `read ${capabilities.read ? 'yes' : 'no'}, tool families: ${families} (these are connection tool ` +
    `families, NOT Folder Access — list_agents does not report an agent's Folder Access grant or ` +
    `effective filesystem restriction; an extra capability, e.g. write yes, is NOT a mismatch for a ` +
    `read-only task: with read/search available the agent IS assignable to a read-only audit)`;
}

/** Unicode code points, rather than JavaScript's UTF-16 code units, are the public partial-delivery unit. */
function unicodeCharacterCount(value: string): number {
  return [...value].length;
}

function unicodePrefix(value: string, count: number): string {
  return [...value].slice(0, count).join('');
}

/** Framing is model prose; receipt content is host-owned and always arrives after it unchanged. */
function frameReceiptContent(framing: string, content: string): string {
  return framing ? `${framing}\n\n${content}` : content;
}

/** The advertised proposal shape. Runtime compilation is stricter and rejects every unknown field. */
function taskContractParameter(): Record<string, unknown> {
  const provenance = {
    type: 'object', additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['user-turn', 'workspace', 'upstream-artifact', 'coordinator-declared'] },
      source_refs: { type: 'array', items: { type: 'string' } },
    },
    required: ['kind', 'source_refs'],
  };
  return {
    type: 'object',
    additionalProperties: false,
    description: 'Untrusted task proposal compiled and enforced by the host. Context is declared as inputs; never paste conversation history.',
    properties: {
      version: { type: 'integer', enum: [1] },
      objective: { type: 'string' },
      expected_deliverable: { type: 'string' },
      effects: {
        type: 'object', additionalProperties: false,
        properties: {
          read_files: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative files the worker should read. This does not widen write authority.' },
          write_scope: {
            type: 'object',
            additionalProperties: false,
            description: 'Optional per-turn read/write ceiling. Use read for context-only roots and readwrite only for intended effects.',
            properties: {
              folder_access: {
                type: 'array', minItems: 1,
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    path: { type: 'string' },
                    permission: { type: 'string', enum: ['read', 'readwrite'] },
                  },
                  required: ['path', 'permission'],
                },
              },
            },
            required: ['folder_access'],
          },
          expected_file_effect: { type: 'string', enum: ['none', 'create', 'modify', 'delete', 'mixed'] },
        },
        required: ['read_files', 'expected_file_effect'],
      },
      inputs: {
        type: 'array',
        items: {
          type: 'object',
          description: 'Discriminated by kind. contentAsset needs asset_id + attempt-start; workspacePath needs path + current/dispatch-snapshot; upstreamArtifact needs artifact_id + artifact-ready.',
          properties: {
            input_id: { type: 'string' },
            kind: { type: 'string', enum: ['contentAsset', 'workspacePath', 'upstreamArtifact'] },
            purpose: { type: 'string' },
            required: { type: 'boolean' },
            provenance,
            freshness: { type: 'string', enum: ['attempt-start', 'current', 'dispatch-snapshot', 'artifact-ready'] },
            asset_id: { type: 'string' },
            path: { type: 'string' },
            artifact_id: { type: 'string' },
          },
          required: ['input_id', 'kind', 'purpose', 'required', 'provenance', 'freshness'],
        },
      },
      constraints: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: { text: { type: 'string' }, basis_refs: { type: 'array', items: { type: 'string' } } },
          required: ['text'],
        },
      },
      coordinator_brief: {
        type: 'object', additionalProperties: false,
        description: 'Optional bounded orientation for the delegate. It is a coordinator claim, not a host fact; it never replaces reading granted inputs or collecting evidence.',
        properties: {
          text: { type: 'string' },
          basis_refs: { type: 'array', items: { type: 'string' } },
        },
        required: ['text'],
      },
      dependencies: { type: 'array', items: { type: 'string' } },
      review: {
        type: 'object', additionalProperties: false,
        description: 'Optional explicit artifact-review relation. input_id must name one required upstreamArtifact input; the host derives every other fact.',
        properties: { input_id: { type: 'string' } },
        required: ['input_id'],
      },
      verification_plan: verificationPlanParameter(),
      required_capabilities: {
        type: 'object', additionalProperties: false,
        properties: {
          version: { type: 'integer', enum: [1] },
          capabilities: { type: 'array', items: { type: 'string', enum: ['read', 'write', 'shell'] } },
        },
        required: ['version', 'capabilities'],
      },
      execution_strategy: { type: 'string', enum: ['delegate-preferred', 'delegate-required', 'coordinator-only'], description: 'Defaults to delegate-preferred when omitted.' },
    },
    required: ['version', 'objective', 'effects', 'inputs', 'required_capabilities'],
  };
}

/** Write claims derive from the same contract field that defines writable effects. Read files never imply writes. */
function contractWriteClaims(contract: EffectiveTaskContract): string[] {
  return contract.effects.writeScope?.folderAccess
    .filter((grant) => grant.permission === 'readwrite')
    .map((grant) => grant.path) ?? [];
}

/** A content-free task contract. The declaration selects sensors; it can never carry a command to run. */
function verificationPlanParameter(): Record<string, unknown> {
  return {
    type: 'object',
    description: 'Optional verification contract selected before the teammate starts. Choose only deterministic host-observed sensors. An empty sensors array is valid and explicitly reports no applicable sensor; it is never treated as a failed check.',
    properties: {
      sensors: {
        type: 'array',
        description: 'Ordered required sensors for this task. Each must be host-observed before the task receives a verified verdict.',
        items: { type: 'string', enum: ['command-exit-zero', 'editor-diagnostics-clean', 'recorded-file-effect', 'run-checks'] },
      },
      none_applies: {
        type: 'string',
        enum: ['report-no-applicable-sensor'],
        description: 'Required policy for a task with no applicable sensor.',
      },
    },
    required: ['sensors', 'none_applies'],
  };
}

/** Validate coordinator-supplied scope before it crosses the message bus. */
function parseDelegationTaskScope(value: unknown): { scope?: DelegationTaskScope; error?: string } {
  if (value === undefined) {
    return {};
  }
  const rawFolderAccess = value && typeof value === 'object'
    ? (value as Record<string, unknown>).folderAccess
    : undefined;
  if (!Array.isArray(rawFolderAccess)) {
    return { error: 'scope.folderAccess must be a non-empty array of { path, permission } entries.' };
  }
  const grants: unknown[] = rawFolderAccess;
  if (grants.length === 0) {
    return { error: 'scope.folderAccess must not be empty.' };
  }
  const folderAccess: DelegationTaskScope['folderAccess'] = [];
  for (const item of grants) {
    if (!item || typeof item !== 'object') {
      return { error: 'each scope folder must be an object.' };
    }
    const candidate = item as Record<string, unknown>;
    const path = typeof candidate.path === 'string' ? candidate.path.trim() : '';
    const permission = candidate.permission;
    if (!path || (permission !== 'read' && permission !== 'readwrite')) {
      return { error: 'each scope folder needs a non-empty path and permission "read" or "readwrite".' };
    }
    folderAccess.push({ path, permission });
  }
  return { scope: { folderAccess } };
}

export function returnedNothing(result: string): boolean {
  const t = (result ?? '').trim();
  return t === '' || t === '(teammate returned no output)';
}

function noEvidenceRecord(
  outcome: DelegationOutcome,
  completionState: DelegationCompletionState = 'not-observed',
): DelegationEvidenceRecord {
  return {
    outcome,
    completionState,
    changedFiles: [],
    hadToolActions: false,
    verification: { ran: false, passed: false },
    unrecordedWrites: false,
  };
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return value === 'stopped' || value === 'starting' || value === 'consent_required'
    || value === 'idle' || value === 'running' || value === 'error' || value === 'stopping';
}

function readReceiptStateFor(
  requiredInputCount: number | undefined,
  readNotObservedCount: number | undefined,
): DelegationReadReceiptState {
  if (!requiredInputCount) return 'not-applicable';
  if (readNotObservedCount === undefined || readNotObservedCount >= requiredInputCount) return 'none-observed';
  if (readNotObservedCount === 0) return 'all-observed';
  return 'partially-observed';
}

/**
 * Progress prose is not evidence. Only SessionManager's host-authored marker, emitted alongside an
 * observed worker tool action, can renew a blocking wait. This keeps a talkative/stuck model from
 * turning the deadline into an unbounded lease by repeatedly saying it is still working.
 */
function isObservedDelegationProgress(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') { return false; }
  const progress = (metadata as Record<string, unknown>).progress;
  if (!progress || typeof progress !== 'object') { return false; }
  const record = progress as Record<string, unknown>;
  return record.source === 'tool' && record.observed === true;
}

/**
 * Convert the backend-only evidence payload back into a narrow, defensive shape. Message metadata
 * can come from an older backend or an external client, so it is treated as untrusted input here.
 */
function delegationEvidenceFromMetadata(metadata: unknown): DelegationTurnEvidence | undefined {
  if (!metadata || typeof metadata !== 'object') { return undefined; }
  const candidate = (metadata as Record<string, unknown>).delegationEvidence;
  if (!candidate || typeof candidate !== 'object') { return undefined; }
  const value = candidate as Record<string, unknown>;
  const verification = value.verification && typeof value.verification === 'object'
    ? value.verification as Record<string, unknown>
    : undefined;
  const contextGaps = Array.isArray(value.contextGaps)
    ? value.contextGaps.flatMap((raw): TaskContextGap[] => {
        if (!raw || typeof raw !== 'object') return [];
        const gap = raw as Record<string, unknown>;
        const reason = gap.reason;
        if (typeof gap.attemptId !== 'string' || typeof gap.contractId !== 'string' || typeof gap.inputId !== 'string'
          || typeof gap.purpose !== 'string' || typeof gap.reportedAt !== 'string'
          || (reason !== 'missing' && reason !== 'expired' && reason !== 'outside-task-scope' && reason !== 'unreadable')) return [];
        return [{ attemptId: gap.attemptId, contractId: gap.contractId, inputId: gap.inputId, reason, purpose: gap.purpose.slice(0, 1_000), reportedAt: gap.reportedAt }];
      })
    : [];
  const taskArtifacts = Array.isArray(value.taskArtifacts)
    ? value.taskArtifacts.flatMap((raw): ReadyTaskArtifact[] => {
        if (!raw || typeof raw !== 'object') return [];
        const artifact = raw as ReadyTaskArtifact;
        if (typeof artifact.artifactId !== 'string' || typeof artifact.contentAssetId !== 'string'
          || typeof artifact.producerAttemptId !== 'string' || typeof artifact.producerAgentId !== 'string'
          || artifact.state !== 'artifact-ready') return [];
        return [{
          ...artifact,
          delegableByAgentIds: Array.isArray(artifact.delegableByAgentIds) ? artifact.delegableByAgentIds.filter((id): id is string => typeof id === 'string') : [],
          provenance: Array.isArray(artifact.provenance) ? artifact.provenance : [],
        }];
      })
    : [];
  const inputGrants = Array.isArray(value.inputGrants)
    ? value.inputGrants.flatMap((raw): InputGrant[] => {
        if (!raw || typeof raw !== 'object') return [];
        const grant = raw as Record<string, unknown>;
        if (typeof grant.attemptId !== 'string' || typeof grant.agentId !== 'string'
          || typeof grant.inputId !== 'string' || typeof grant.sourceRef !== 'string'
          || typeof grant.suppliedAt !== 'string'
          || (grant.kind !== 'contentAsset' && grant.kind !== 'workspacePath' && grant.kind !== 'upstreamArtifact')) return [];
        return [{
          attemptId: grant.attemptId,
          agentId: grant.agentId,
          inputId: grant.inputId,
          kind: grant.kind,
          sourceRef: grant.sourceRef,
          ...(typeof grant.resolvedContentAssetId === 'string' ? { resolvedContentAssetId: grant.resolvedContentAssetId } : {}),
          suppliedAt: grant.suppliedAt,
          ...(typeof grant.reachableAt === 'string' ? { reachableAt: grant.reachableAt } : {}),
          ...(typeof grant.readAt === 'string' ? { readAt: grant.readAt } : {}),
        }];
      })
    : [];
  return {
    hadToolActions: value.hadToolActions === true,
    changedFiles: Array.isArray(value.changedFiles)
      ? [...new Set(value.changedFiles.filter((path): path is string => typeof path === 'string' && path.trim().length > 0))]
      : [],
    unrecordedWrites: value.unrecordedWrites === true,
    verification: verification
      ? {
          ran: verification.ran === true,
          passed: verification.passed === true,
          command: typeof verification.command === 'string' ? verification.command : undefined,
          source: verification.source === 'run-checks' || verification.source === 'command-exit-zero' || verification.source === 'completion-gate'
            ? verification.source : undefined,
        }
      : undefined,
    diagnostics: value.diagnostics && typeof value.diagnostics === 'object'
      ? {
          observed: (value.diagnostics as Record<string, unknown>).observed === true,
          clean: (value.diagnostics as Record<string, unknown>).clean === true,
        }
      : undefined,
    ...(contextGaps.length ? { contextGaps } : {}),
    ...(taskArtifacts.length ? { taskArtifacts } : {}),
    ...(inputGrants.length ? { inputGrants } : {}),
  };
}

/**
 * Decide a delegation outcome from framework records, not from the teammate's prose. Only a recorded
 * write with an observed successful check is verified. Read-only tool activity is explicitly not a
 * delivery verdict: the framework has no mechanical accept/reject surface for its substantive result.
 */
export function classifyDelegationEvidence(
  reply: string,
  evidence?: DelegationTurnEvidence,
  verificationPlan?: VerificationPlan,
  completionState: DelegationCompletionState = 'complete',
): DelegationEvidenceRecord {
  const changedFiles = [...new Set(evidence?.changedFiles ?? [])];
  const verification = evidence?.verification ?? { ran: false, passed: false };
  const hadToolActions = evidence?.hadToolActions === true;
  const planEvaluation = evaluateVerificationPlan(verificationPlan, evidence);

  let outcome: DelegationOutcome;
  // Evidence proves that a mechanism ran, not that anything reached the coordinator. A non-empty reply
  // is the smallest mechanical delivery signal, but deliberately never becomes a quality or delivery
  // assertion here: parsing that question would replace a mechanical fact with an LLM-style judgment.
  if (returnedNothing(reply)) {
    outcome = 'no-evidence';
  } else if (!hadToolActions) {
    outcome = 'no-evidence';
  } else if (verificationPlan) {
    outcome = planEvaluation.status === 'no-applicable-sensor'
      ? 'no-applicable-sensor'
      : planEvaluation.status === 'satisfied'
        ? 'verified'
        : planEvaluation.status === 'failed'
          ? 'verification-failed'
          : 'replied-not-verified';
  } else if (changedFiles.length > 0 || evidence?.unrecordedWrites) {
    // The observed exit status remains ledger evidence, but an undeclared task does not receive a green
    // verdict from a command name or from a command that happened to exit zero.
    outcome = 'replied-not-verified';
  } else if (changedFiles.length === 0 && !evidence?.unrecordedWrites) {
    // There is recorded activity, but no mechanical evidence surface can say whether the answer actually
    // delivered the requested research/review result. Keep this neutral instead of a green delivery claim.
    outcome = 'tool-activity-recorded';
  } else {
    // A future evidence source may supply a mutation state not covered above; remain conservative.
    outcome = 'replied-not-verified';
  }

  return {
    outcome, completionState, changedFiles, hadToolActions, verification,
    unrecordedWrites: evidence?.unrecordedWrites === true,
    ...(verificationPlan ? {
      verificationPlan,
      verificationPlanStatus: planEvaluation.status === 'not-declared' ? undefined : planEvaluation.status,
      verificationSensors: planEvaluation.sensors,
    } : {}),
    ...(evidence?.contextGaps?.length ? { contextGaps: evidence.contextGaps.map((gap) => ({ ...gap })) } : {}),
    ...(evidence?.taskArtifacts?.length ? { taskArtifacts: evidence.taskArtifacts.map((artifact) => ({ ...artifact })) } : {}),
    ...(evidence?.inputGrants?.length ? { inputGrants: evidence.inputGrants.map((grant) => ({ ...grant })) } : {}),
  };
}

/** Frame a teammate's reply with the evidence record the PM must act on. */
export function formatDelegationEvidence(reply: string, evidence: DelegationEvidenceRecord): string {
  const changed = evidence.changedFiles.length > 0
    ? evidence.changedFiles.join(', ')
    : '(none recorded)';
  const verification = evidence.verification.passed
    ? `run_checks${evidence.verification.command ? ` (${evidence.verification.command})` : ''} passed (framework recorded).`
    : evidence.verification.ran
      ? 'run_checks ran but did not pass (framework recorded).'
      : 'run_checks was NOT run (framework recorded).';
  const lines = [
    `[delegation: ${evidence.outcome}]`,
    `completion state (host observed): ${evidence.completionState}.`,
    `changed files (recorded): ${changed}`,
    `tool actions (recorded): ${evidence.hadToolActions ? 'yes' : 'no'}.`,
    `verification: ${verification}`,
  ];
  if (evidence.verificationPlan) {
    lines.push(`verification plan (declared before task): ${formatVerificationPlan(evidence.verificationPlan)}.`);
    lines.push(`verification plan result: ${evidence.verificationPlanStatus ?? 'not observed'}.`);
  }
  if (evidence.unrecordedWrites) {
    lines.push('evidence gap: a potentially mutating native tool ran without a CheckpointRecorder file record.');
  }
  if (typeof evidence.requiredInputCount === 'number' && typeof evidence.requiredInputReadNotObservedCount === 'number') {
    lines.push(`[required input receipts] declared ${evidence.requiredInputCount}; read receipt not observed ${evidence.requiredInputReadNotObservedCount}.`);
    if (evidence.requiredInputCount > 0 && evidence.requiredInputReadNotObservedCount === evidence.requiredInputCount) {
      lines.push('[task state: required-input-read-not-observed] No structured read receipt was observed for any declared required input. This is a sensor boundary, not a claim that bytes were not read.');
    }
  }
  for (const gap of evidence.contextGaps ?? []) {
    lines.push(`[task state: context-gap] input ${gap.inputId}; reason ${gap.reason}; purpose: ${gap.purpose}. `
      + (gap.reason === 'unreadable' ? ' The host observed a read failure; supply, re-scope, or escalate this declared input.' : ' Supply, re-scope, or escalate this declared input.'));
  }
  for (const artifact of evidence.taskArtifacts ?? []) {
    lines.push(`[artifact-ready] ${artifact.artifactId}; declare it as an upstreamArtifact input and dependency before any downstream can read it.`);
  }
  for (const grant of evidence.inputGrants ?? []) {
    lines.push(`[input receipt] ${grant.inputId}: supplied yes; reachable ${grant.reachableAt ? 'yes' : 'no'}; read receipt ${grant.readAt ? 'observed' : 'not-observed'}.`);
  }
  if (evidence.outcome === 'replied-not-verified') {
    lines.push('Do not mark this step done. Run_checks yourself or send it to the reviewer.');
  } else if (evidence.outcome === 'verification-failed') {
    lines.push('The declared verification plan ran and did not pass. Do not mark this step done.');
  } else if (evidence.outcome === 'no-applicable-sensor') {
    lines.push('This task declared no applicable mechanical sensor before it started. That is not a failed check and not a green acceptance.');
  } else if (evidence.outcome === 'tool-activity-recorded') {
    lines.push('Tool activity was recorded; delivery was not mechanically checked. Do not treat this as a green acceptance.');
  } else if (evidence.outcome === 'no-evidence') {
    lines.push('No framework-visible work evidence was recorded. Do not mark this step done.');
  } else if (evidence.outcome === 'required-input-read-not-observed') {
    lines.push('No required input was observed read. Do not treat this as an ordinary completed delivery.');
  } else if (evidence.outcome === 'timed-out') {
    lines.push('This dispatch timed out before a result arrived. The teammate may still produce a retained late result; do not mark this step done.');
  }
  return `${lines.join('\n')}\n\n${reply}`;
}

/** A roster status that means "already working a turn" — used to skip loaded-up same-role teammates
 *  when spreading a role delegation. Matches SessionManager's status vocabulary. */
function isBusyStatus(status: string): boolean {
  const s = (status ?? '').toLowerCase();
  return s === 'running' || s === 'starting' || s === 'consent_required';
}

/** A teammate we should not route new work to (truly broken). 'stopped' is NOT here — a stopped agent is
 *  just not-yet-started and auto-starts on assignment, so it's a valid free target, not "unavailable". */
function isUnavailableStatus(status: string): boolean {
  return (status ?? '').toLowerCase() === 'error';
}

/** Legacy aliases stay executable for old hosts, but all routes that can create or inspect a dispatch are coordinator-only. */
function isDispatchTool(name: string): boolean {
  return name === 'assign_task'
    || name === 'assign_task_async'
    || name === 'dispatch_task'
    || name === 'await_tasks'
    || name === 'collect_ready_tasks'
    || name === 'inspect_task_status';
}

function spec(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[]
): ToolSpec {
  // The surrounding migration aliases stay executable for old hosts, but this exact schema is the sole
  // model-facing contract. Keep collection narrow: accepting an agent/instruction here would invite the PM
  // to dispatch or wait by accident rather than inspect a result that has already settled.
  if (name === 'collect_ready_tasks') {
    return {
      type: 'function',
      function: {
        name,
        description: 'Return only task results that are already settled, plus pending handles. Never waits and never holds the PM turn open.',
        parameters: {
          type: 'object',
          properties: {
            handles: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional dispatch_task handles. Omit to inspect every task that is ready or still pending.',
            },
          },
          required: [],
        },
      },
    };
  }
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

/** Wall-clock cap for run_checks' default runner so a hung/watch-mode verify command can't block the
 *  PM indefinitely and orphan the process (audit #5). */
const RUN_CHECKS_TIMEOUT_MS = 300_000;

const defaultRunner: CommandRunner = (command, cwd) =>
  new Promise((resolve) => {
    const proc = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: sanitizedCommandEnv() });
    let output = '';
    let settled = false;
    const done = (r: { code: number | null; output: string }) => { if (settled) { return; } settled = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => {
      killProcessTree(proc); // Windows: kill the whole tree, not just cmd.exe (audit N2)
      done({ code: null, output: `${output}\n[checks timed out after ${RUN_CHECKS_TIMEOUT_MS / 1000}s — ensure the command exits (not a watch mode) and doesn't wait for input]` });
    }, RUN_CHECKS_TIMEOUT_MS);
    proc.stdout?.on('data', (d) => (output += d.toString()));
    proc.stderr?.on('data', (d) => (output += d.toString()));
    proc.on('close', (code) => done({ code, output }));
    proc.on('error', (err) => done({ code: 1, output: `Failed to run command: ${err.message}` }));
  });
