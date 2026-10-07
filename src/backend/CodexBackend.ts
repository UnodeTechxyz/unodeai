/*---------------------------------------------------------------------------------------------
 *  UnodeAi - CodexBackend
 *  Consent-gated Codex App Server client. Codex owns its network and credentials; UnodeAi owns the
 *  start decision and host boundary. Eligible escalations use Codex's native "Ask for approval"
 *  policy; routine in-workspace work follows Codex's own sandbox.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn as nodeSpawn } from 'child_process';
import * as path from 'node:path';
import { AgentConfig, AgentModelParams, ChatMode, TaskWorkspaceAccess } from '../types';
import {
  AgentBackend,
  BackendEvent,
  BackendEventHandler,
  ConversationSnapshot,
  EgressConsentGate,
  TurnAttachments,
  TurnUsage,
  delegationReceiptEvent,
} from './AgentBackend';
import { APPROVAL_TIMER_GRACE_MS } from './WebAccessPolicy';
import { killProcessTreeByPid } from './processTree';
import { StreamJsonParser } from './StreamJsonParser';
import { EmptyReplyTracker } from './EmptyReplyTracker';
import { requireAbsoluteWorkingDirectory } from './WorkspaceBinding';
import type { RepositoryCliLaunchApproval } from '../security/RepositoryCliConfig';
import type { CommandPolicy } from './CommandPolicy';
import type { CodexFileChange } from './CodexFileChanges';
import {
  CODEX_BANNED_FLAGS,
  assertSafeCodexSpawnArgs,
  buildCodexAppServerArgs,
  codexProtocolPermissionSettings,
  codexProjectTrustOverride,
  codexWriteCapable,
} from './CodexSpawnArgs';
import {
  resolveCodexPermissionProfile,
  type ResolvedCodexPermissionProfile,
} from './CodexPermissionProfile';
import { CodexAccountModel, parseCodexAccountModels } from './CodexModelLoader';
import { resolveContextWindow } from '../contextWindowDefaults';
import { estimateTokens } from './TokenCounter';
import type { ContextCompactionRequest, ContextCompactionResult, ContextControl, ContextProjection } from './ContextControl';
import type { SkillRegistry } from '../skills/SkillRegistry';
import {
  createCodexSkillRoot,
  removeCodexSkillRoot,
  type CodexSkillRoot,
} from './CodexSkillRoot';
import { WorkspaceTools, type ToolSpec } from './WorkspaceTools';
import { runContentReceiptRead } from './contentReceiptRead';
import { turnVerbatimOf } from './TurnContentDelivery';
import { resolveMcpServerGrants, type MCPHub, type McpServerGrants } from '../mcp/MCPHub';
import { RUN_SKILL_ACTION_TOOL, type ExecutableSkillHost } from '../skills/ExecutableSkillHost';
import type { TeamMcpBridge } from '../mcp/TeamMcpBridge';
import {
  externalToolOutcome,
  hostToolRefused,
  providerToolFailed,
  providerToolSucceeded,
  summarizeToolResult,
  toolFactSucceeded,
  toolOutcomeFact,
  type HostToolRefusalReason,
  type ToolOutcome,
  type ToolResultFact,
} from './toolSummary';
import { TurnProviderFacts, TurnToolCallIds } from './toolCallIds';

export type { CodexAccountModel } from './CodexModelLoader';

export {
  CODEX_BANNED_FLAGS, assertSafeCodexSpawnArgs, buildCodexAppServerArgs, codexProjectTrustOverride,
  codexWriteCapable,
};

const SAFE_CLI_ARGUMENT = /^[A-Za-z0-9._:/-]+$/;
const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const CODEX_APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;
const DYNAMIC_TOOL_ARGUMENT_BYTES = 64 * 1024;
const DYNAMIC_TOOL_RESULT_CHARACTERS = 64 * 1024;
/**
 * A coordinator's receipt read stays within this many UTF-8 bytes (v0.9.88 §5.5). Codex cuts model-visible tool
 * output at 10,000 approximate tokens counted as bytes / 4 (`truncation_policy` on every model 0.155.1 lists; the
 * probe measured the count); the margin covers the script-output header and some escaping.
 */
const CODEX_RECEIPT_READ_BYTES = 32_000;

/** The host read a Codex coordinator uses for content receipts; the same schema as the Claude files bridge. */
const COORDINATOR_READ_FILE_SPEC: ToolSpec = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the working folder or an allowed read root. The result starts with a host '
      + 'content receipt line and ends with its check code; use them to show the user exact file content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the working folder or absolute inside an allowed read root.' },
        offset: { type: 'integer', description: '0-indexed line number to start reading from.' },
        limit: { type: 'integer', description: 'Maximum number of lines to return.' },
      },
      required: ['path'],
    },
  },
};
/** Let the authenticated Codex CLI choose the account-supported default instead of forcing an API model id. */
export const CODEX_CLI_DEFAULT_MODEL = 'codex-cli-default';
export const CODEX_MINIMUM_VERSION = '0.155.0';
export const CODEX_VALIDATED_VERSION = '0.155.1';

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number;
type CodexSandboxPolicy =
  | { type: 'readOnly'; networkAccess: false }
  | { type: 'dangerFullAccess' }
  | {
      type: 'workspaceWrite';
      writableRoots: string[];
      networkAccess: false;
      excludeTmpdirEnvVar: true;
      excludeSlashTmp: true;
    };

export interface CodexRuntimeAccess {
  trusted: boolean;
  restricted: boolean;
  readRoots: string[];
  writeRoots: string[];
}

export interface CodexApprovalRequest {
  kind: 'command' | 'file-change' | 'permission' | 'mcp-tool' | 'guardian-denied';
  title: string;
  detail: string;
  command?: string;
  fileChanges?: CodexFileChange[];
  server?: string;
  tool?: string;
  timeoutMs: number;
  approveAnyway?: boolean;
}

export interface CodexApprovalDecision {
  allow: boolean;
  note?: string;
}

/**
 * Codex 0.155.1 wraps Windows shell requests in the native Windows PowerShell executable. Unwrap only
 * that exact measured shape. Any new shell, flag spelling, quoting form, or malformed wrapper remains
 * opaque so the approval card and any optional host policy use the complete transported command.
 */
function unwrapMeasuredPowerShellCommand(command: string): string | undefined {
  const match = /^"[A-Za-z]:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1\.0\\\\powershell\.exe" -Command (.+)$/i.exec(command);
  if (!match) return undefined;
  const inner = match[1];
  if (!inner.startsWith("'")) return inner.startsWith('"') ? undefined : inner;
  if (inner.length < 2 || !inner.endsWith("'")) return undefined;
  return inner.slice(1, -1).replace(/''/g, "'");
}

/** Bind an App Server parse hint to the full command before display or optional host-policy evaluation. */
export function codexCommandForPolicy(transportedCommand: string, actionCommands: readonly string[]): string {
  const executableCommand = unwrapMeasuredPowerShellCommand(transportedCommand) ?? transportedCommand;
  return actionCommands.length === 1 && actionCommands[0] === executableCommand
    ? actionCommands[0]
    : transportedCommand;
}

export interface CodexBackendDeps {
  /** An explicit, version-checked CLI executable. Never resolve an arbitrary `codex` from PATH here. */
  binaryPath: string;
  /** Resolve binary version and CLI login only after model-egress consent, before App Server spawn. */
  preflight?: (env: NodeJS.ProcessEnv) => Promise<string | void>;
  /** Detect and approve content-bound repository configuration before any CLI/helper process starts. */
  onBeforeRepositoryConfig?: () => Promise<RepositoryCliLaunchApproval>;
  /** Called before the CLI exists. Rejection means no process and no egress. */
  onBeforeEgress?: EgressConsentGate;
  /** Load-bearing route assertion, invoked immediately before the consent and spawn path. */
  assertResolvedRoute?: () => void;
  /** Live host authority. Workspace Trust and Folder Access changes take effect at the next gate. */
  access?: () => CodexRuntimeAccess;
  /** Single-use user decision. The backend never remembers or infers an approval from command text. */
  requestApproval?: (request: CodexApprovalRequest) => Promise<CodexApprovalDecision>;
  /** Optional embedding policy for eligible escalation callbacks; production Codex does not use the composer Commands setting. */
  commandPolicy?: Pick<CommandPolicy, 'check' | 'approvalMode'>;
  /** Optional embedding mode for eligible file callbacks; production Codex always binds this to Ask. */
  writeApprovalAsk?: () => boolean;
  /** Record every before-state before App Server is allowed to apply the pending change. */
  prepareFileCheckpoint?: (changes: readonly CodexFileChange[]) => Promise<{ ok: boolean; note?: string }>;
  /** Account-visible model list discovered only after Codex consent and App Server initialization. */
  onModels?: (models: readonly CodexAccountModel[], cliVersion?: string) => Promise<void> | void;
  spawn?: typeof nodeSpawn;
  killProcessTree?: (pid: number) => Promise<void>;
  approvalTimeoutMs?: number;
  /** Test-only override of the backend net's grace after the human window (production: APPROVAL_TIMER_GRACE_MS). */
  approvalTimerGraceMs?: number;
  /** Actual extension version advertised to App Server; never hard-code a future release number. */
  clientVersion?: string;
  /** Extension-owned, validated instruction playbooks available to this one agent. */
  skillRegistry?: SkillRegistry;
  /** Host-owned team surface. App Server receives it as client-handled dynamic tools. */
  teamMcpBridge?: TeamMcpBridge;
  /** The same approved, SecretStorage-backed integration hub used by every other route. */
  mcp?: { hub: MCPHub; grants: McpServerGrants };
  /** Host-mediated executable Skill lane; never exposes handler code to App Server. */
  executableSkills?: ExecutableSkillHost;
  /** Visible notice when App Server cannot resume a thread because its immutable tool surface changed. */
  onConversationReset?: (message: string) => void;
}

/** Newer builds are admitted only if their live App Server handshake and effective-policy checks also pass. */
export function isValidatedCodexCliVersion(version: string): boolean {
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)([-+][0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  const minimum = CODEX_MINIMUM_VERSION.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  // Semver: a prerelease sorts below its release, so `0.155.0-alpha.16` does not meet a 0.155.0 floor. That is
  // exactly the editor-bundled preview found on PATH on the validation machine; build metadata (`+…`) is fine.
  return !match[4]?.startsWith('-');
}

/** @deprecated Use isValidatedCodexCliVersion; retained for source compatibility with older callers. */
export const isSupportedCodexCliVersion = isValidatedCodexCliVersion;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CodexBackend implements AgentBackend {
  public readonly agentId: string;
  private readonly handlers = new Set<BackendEventHandler>();
  private readonly parser = new StreamJsonParser();
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private proc: ChildProcess | undefined;
  private started = false;
  private stopped = false;
  private starting = false;
  private threadId: string | undefined;
  /** Immutable App Server dynamic-tool surface for this thread; never recomputed from live grants. */
  private threadDynamicToolSignature: string | undefined;
  private turnId: string | undefined;
  private turnText = '';
  /** The host ids of this turn's tool calls, found again from Codex item ids. */
  private readonly toolCallIds = new TurnToolCallIds();
  /** The host's refusals of native items this turn, by item id; reported when the item completes. */
  private readonly hostItemRefusals = new TurnProviderFacts<HostToolRefusalReason>(this.toolCallIds);
  private lastAgentMessagePart: string | undefined;
  /**
   * v0.9.89 §9: App Server reports CUMULATIVE thread usage. Each turn is charged the positive delta from the
   * thread's previous observation. Baselines never cross thread ids; a new thread starts at zero.
   */
  private threadUsageBaselines = new Map<string, CodexUsageBreakdown>();
  /** A resumed thread whose baseline was not recorded: its first turn cannot be attributed. */
  private unknownBaselineThreads = new Set<string>();
  private turnUsageThreadId: string | undefined;
  private turnUsageTotal: CodexUsageBreakdown | undefined;
  private turnUsageLast: CodexUsageBreakdown | undefined;
  private turnUsageUpdates = 0;
  private turnUsageReset = false;
  /** v0.9.90: the latest provider request's size (`usage.last`) on a thread, for the next-turn projection. */
  private lastRequestUsage: { threadId: string; inputTokens: number; outputTokens: number } | undefined;
  /** v0.9.90: the model window App Server reported with its usage (`modelContextWindow`). */
  private reportedContextWindow: number | undefined;

  /** v0.9.90: the next request's projected size, and compaction through App Server's `thread/compact/start`. */
  readonly contextControl: ContextControl = {
    projectNextTurn: (instruction, attachments) => this.projectNextTurn(instruction, attachments),
    compact: (request) => this.compactNatively(request),
  };
  /** The running host-triggered compaction; its turn is never this.turnId and never completes a user turn. */
  private compaction: CodexCompaction | undefined;
  /** This App Server process rejected `thread/compact/start` as an unknown method. */
  private nativeCompactUnsupported = false;
  /** A replacement App Server starting after a compaction of uncertain fate; the next turn waits for it. */
  private appServerRestart: Promise<void> | undefined;
  /** The environment the agent was started with, for a replacement's preflight. */
  private launchEnv: NodeJS.ProcessEnv = {};
  /** v0.9.90 §7: what each attempt of the running turn delivered. */
  private replies: EmptyReplyTracker | undefined;
  /** The exact turn/start of the running turn: a blank attempt is started again with it, on the same thread. */
  private lastTurnStart: JsonObject | undefined;
  /** Whether each attempt of the running turn reported usage. */
  private attemptReportedUsage: boolean[] = [];
  private requestSequence = 0;
  private runtimeEnv: NodeJS.ProcessEnv = {};
  private activeAttachments: TurnAttachments | undefined;
  private readonly workspaceRoot: string;
  private repositoryLaunchApproval: RepositoryCliLaunchApproval | undefined;
  private effectiveModelProvider: string | undefined;
  private cliVersion: string | undefined;
  private readonly pendingFileChanges = new Map<string, CodexFileChange[]>();
  private readonly completedReviewRationales = new Set<string>();
  private spawnedProfile: ResolvedCodexPermissionProfile = 'ask-for-approval';
  /** Private native-Skill root registered only with this agent's dedicated App Server process. */
  private skillRoot: CodexSkillRoot | undefined;
  private managedToolAbortController: AbortController | undefined;
  /** The coordinator host read_file for the current turn; see coordinatorReadToolsForTurn. */
  private coordinatorReadTools: WorkspaceTools | undefined;

  constructor(private config: AgentConfig, private resolvedParams?: AgentModelParams, private deps?: CodexBackendDeps) {
    this.agentId = config.id;
    this.workspaceRoot = requireAbsoluteWorkingDirectory(config.workingDirectory);
  }

  get pid(): number | undefined { return this.proc?.pid; }

  onEvent(handler: BackendEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async start(env: NodeJS.ProcessEnv): Promise<void> {
    if (this.started || this.starting) return;
    if (!this.deps?.binaryPath) {
      throw new Error('Codex CLI is not configured. Set unode.codexCliPath to the absolute path of the validated Codex executable.');
    }
    this.starting = true;
    this.stopped = false;
    this.launchEnv = env;
    // A fresh start crosses the whole boundary itself, dialogs included; an earlier failed replacement is forgotten.
    this.appServerRestart = undefined;
    try {
      this.assertSafeArguments();
      this.repositoryLaunchApproval = await this.deps.onBeforeRepositoryConfig?.();
      this.assertHostCanStart();
      this.deps.assertResolvedRoute?.();
      await this.deps.onBeforeEgress?.((pending) => this.emit({
        kind: 'consent_required', message: pending.message,
      }));
      if (this.stopped) throw new Error('Codex start was cancelled before the CLI was launched.');
      const version = await this.deps.preflight?.(env);
      this.cliVersion = typeof version === 'string' ? version.trim() : undefined;
      if (this.stopped) throw new Error('Codex start was cancelled before the App Server was launched.');
      this.repositoryLaunchApproval?.assertCurrent();
      this.runtimeEnv = sanitizedCodexEnv(env);
      this.spawnAppServer();
      await this.initializeAppServer();
      if (this.stopped) throw new Error('Codex start was cancelled.');
      this.started = true;
      this.emit({ kind: 'ready', model: this.config.model, backendSessionId: this.threadId });
    } catch (error) {
      await this.killRunningProcess();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  sendUserTurn(instruction: string, attachments?: TurnAttachments): void {
    // During a restart there is briefly no process; the turn waits for the new one instead of failing.
    if (!this.started || this.stopped || (!this.proc && !this.appServerRestart)) {
      this.emit({ kind: 'error', message: 'Codex App Server is not running; cannot send turn.' });
      return;
    }
    if (this.turnId) {
      this.emit({ kind: 'error', message: 'Codex is already running a turn.' });
      return;
    }
    // App Server interrupts a running turn to start a compaction and the reverse is unmeasured: never overlap them.
    if (this.compaction && !this.compaction.abandoned) {
      this.emit({ kind: 'error', message: 'Codex is compacting its context; the turn was not sent.' });
      return;
    }
    if (attachments?.userAttachments?.some((attachment) => attachment.kind === 'pdf')) {
      this.failTurn('Local PDF attachments require an OpenAI-compatible agent in this release; Codex CLI did not receive PDF bytes.');
      return;
    }
    this.toolCallIds.reset();
    this.hostItemRefusals.reset();
    void this.runTurn(instruction, attachments);
  }

  async stop(): Promise<void> {
    const wasLive = !!this.proc || this.started || this.starting;
    this.stopped = true;
    this.started = false;
    this.starting = false;
    this.rejectPending(new Error('Codex App Server stopped.'));
    this.dropCompaction('Codex App Server stopped while compacting.');
    this.managedToolAbortController?.abort();
    await this.killRunningProcess();
    this.turnId = undefined;
    this.activeAttachments = undefined;
    if (wasLive) this.emit({ kind: 'exit', code: 0 });
  }

  abort(): void {
    const threadId = this.threadId;
    const turnId = this.turnId;
    this.managedToolAbortController?.abort();
    if (!threadId || !turnId || !this.proc) return;
    void this.request('turn/interrupt', { threadId, turnId }).catch((error) => {
      this.emit({ kind: 'log', stream: 'stderr', line: `Codex turn interrupt failed: ${String(error)}` });
    });
  }

  interject(text: string): boolean {
    const threadId = this.threadId;
    const turnId = this.turnId;
    if (!threadId || !turnId || !this.proc || !text.trim()) return false;
    void this.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text, text_elements: [] }],
    }).catch((error) => {
      this.emit({ kind: 'error', message: `Codex could not steer the active turn: ${String(error)}` });
    });
    return true;
  }

  setModel(model: string): void { if (model) this.config.model = model; }
  isAlive(): boolean { return this.started && !this.stopped && !!this.proc; }

  snapshot(): ConversationSnapshot | undefined {
    const baseline = this.threadId ? this.threadUsageBaselines.get(this.threadId) : undefined;
    const lastRequest = this.lastRequestUsage?.threadId === this.threadId ? this.lastRequestUsage : undefined;
    return this.threadId ? {
      version: 1,
      messages: [{
        codexThreadId: this.threadId,
        ...(baseline ? { codexUsageBaseline: baseline } : {}),
        // The resumed thread keeps its size, so a restart must not forget it: without these the first task after
        // every restart had no projection and skipped the automatic compaction check.
        ...(lastRequest ? { codexLastRequest: { inputTokens: lastRequest.inputTokens, outputTokens: lastRequest.outputTokens } } : {}),
        ...(this.reportedContextWindow ? { codexContextWindow: { model: this.config.model, tokens: this.reportedContextWindow } } : {}),
        // Dynamic tools are persisted by App Server at thread/start. Remember whether this thread was
        // created with the v0.9.85 surface so an older worker thread is never resumed as a coordinator.
        codexDynamicTools: this.threadDynamicToolSignature ?? this.dynamicToolSignature(),
      }],
    } : undefined;
  }

  restore(snapshot: ConversationSnapshot): void {
    const item = snapshot.messages[0];
    if (item && typeof item === 'object' && typeof (item as { codexThreadId?: unknown }).codexThreadId === 'string') {
      const restored = item as { codexThreadId: string; codexDynamicTools?: unknown };
      // App Server does not accept dynamicTools on thread/resume. If a pre-v0.9.85 snapshot is now assigned
      // team/MCP tools, or the granted surface changed, start a fresh thread so its advertisement stays exact.
      const currentDynamicTools = this.dynamicToolSignature();
      const legacyWorker = restored.codexDynamicTools === undefined && !this.hasDynamicToolSources();
      if (!legacyWorker && restored.codexDynamicTools !== currentDynamicTools) {
        const message = 'Codex started a fresh conversation because its UnodeAi team or managed-integration tool set changed; App Server cannot change dynamic tools on a resumed thread.';
        this.emit({ kind: 'log', stream: 'stderr', line: message });
        this.deps?.onConversationReset?.(message);
        return;
      }
      this.threadId = restored.codexThreadId;
      const baseline = codexBreakdown((item as { codexUsageBaseline?: unknown }).codexUsageBaseline);
      if (baseline) {
        this.threadUsageBaselines.set(restored.codexThreadId, baseline);
      } else {
        this.unknownBaselineThreads.add(restored.codexThreadId);
      }
      // The last request's size belongs to this thread; the reported window belongs to the model that reported it.
      const lastRequest = asObject((item as { codexLastRequest?: unknown }).codexLastRequest);
      const lastInput = wholeTokens(lastRequest.inputTokens);
      const lastOutput = wholeTokens(lastRequest.outputTokens);
      if (lastInput !== undefined && lastInput > 0 && lastOutput !== undefined) {
        this.lastRequestUsage = { threadId: restored.codexThreadId, inputTokens: lastInput, outputTokens: lastOutput };
      }
      const window = asObject((item as { codexContextWindow?: unknown }).codexContextWindow);
      const windowTokens = wholeTokens(window.tokens);
      if (windowTokens !== undefined && windowTokens > 0 && window.model === this.config.model) {
        this.reportedContextWindow = windowTokens;
      }
      this.threadDynamicToolSignature = typeof restored.codexDynamicTools === 'string'
        ? restored.codexDynamicTools
        : this.dynamicToolSignature();
    }
  }

  buildArgs(): string[] {
    this.assertSafeArguments();
    this.spawnedProfile = this.resolvedProfile(this.baseAccess(), 'act');
    // The trust override must also cover the working directory and every folder up to the workspace root:
    // otherwise Codex keys a subfolder agent by the subfolder and writes a trust entry into the user's config.
    return buildCodexAppServerArgs(
      this.repositoryLaunchApproval ? { ...this.repositoryLaunchApproval, cwd: this.workspaceRoot } : undefined,
      this.spawnedProfile,
    );
  }

  private assertHostCanStart(): void {
    const access = this.baseAccess();
    if (!access.trusted) {
      throw new Error('Codex CLI will not start in an untrusted workspace. Trust the workspace, then try again.');
    }
    if (access.readRoots.length === 0) {
      throw new Error('Codex CLI will not start because Folder Access grants no readable folder.');
    }
  }

  private spawnAppServer(): void {
    const spawn = this.deps?.spawn ?? nodeSpawn;
    const args = this.buildArgs();
    assertSafeCodexSpawnArgs(args, this.spawnedProfile);
    const proc = spawn(this.deps!.binaryPath, args, {
      cwd: this.workspaceRoot,
      env: this.runtimeEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    this.proc = proc;
    this.parser.reset();
    this.nativeCompactUnsupported = false;
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    // A replaced process may still flush output; only the current one speaks for this agent.
    proc.stdout?.on('data', (chunk: string) => { if (proc === this.proc) this.consume(chunk); });
    proc.stderr?.on('data', (chunk: string) => {
      if (proc !== this.proc) return;
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) this.emit({ kind: 'log', stream: 'stderr', line: line.trim() });
    });
    proc.once('error', (error: Error) => this.onProcessFailure(proc, error));
    proc.once('exit', (code: number | null) => this.onProcessExit(proc, code));
  }

  private async initializeAppServer(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'unodeai', title: 'UnodeAi', version: this.deps?.clientVersion || 'dev' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        extensions: {},
      },
    });
    this.notify('initialized');
    await this.assertEffectiveProcessConfig();
    await this.installNativeSkillRoot();
    await this.discoverAccountModels();
  }

  private async installNativeSkillRoot(): Promise<void> {
    this.cleanupNativeSkillRoot();
    this.skillRoot = createCodexSkillRoot(this.deps?.skillRegistry, this.config.playbooks, this.agentId);
    const extraRoots = this.skillRoot ? [this.skillRoot.root] : [];
    try {
      await this.request('skills/extraRoots/set', { extraRoots });
      if (!this.skillRoot) return;
      const response = asObject(await this.request('skills/list', {
        cwds: [this.workspaceRoot],
        forceReload: true,
      }));
      this.assertNativeSkillInventory(response);
    } catch (error) {
      this.cleanupNativeSkillRoot();
      throw error;
    }
  }

  private assertNativeSkillInventory(response: JsonObject): void {
    const expected = this.skillRoot?.skills ?? [];
    const entries = Array.isArray(response.data) ? response.data.map(asObject) : [];
    const skills = entries.flatMap((entry) => Array.isArray(entry.skills) ? entry.skills.map(asObject) : []);
    const errors = entries.flatMap((entry) => Array.isArray(entry.errors) ? entry.errors.map(asObject) : []);
    const rootKey = this.skillRoot ? pathKey(this.skillRoot.root) : '';
    const rootErrors = errors.filter((error) => {
      const errorPath = stringValue(error.path);
      return errorPath && rootKey && isInside(rootKey, pathKey(errorPath));
    });
    if (rootErrors.length > 0) {
      throw new Error(`Codex rejected an UnodeAi native Skill: ${rootErrors.map((error) => stringValue(error.message) || stringValue(error.path)).join('; ')}`);
    }
    for (const item of expected) {
      const matches = skills.filter((skill) => stringValue(skill.name) === item.nativeName);
      if (matches.length !== 1) {
        throw new Error(`Codex native Skill collision or discovery failure for ${item.sourceName}.`);
      }
      const returnedPath = stringValue(matches[0].path);
      if (!returnedPath || pathKey(returnedPath) !== pathKey(item.path)) {
        throw new Error(`Codex native Skill source mismatch for ${item.sourceName}.`);
      }
      if (matches[0].enabled !== true) {
        throw new Error(`Codex reported the UnodeAi native Skill ${item.sourceName} as disabled.`);
      }
    }
  }

  /** Ask App Server for its own merged view; the extension never opens CODEX_HOME or ~/.codex itself. */
  private async assertEffectiveProcessConfig(): Promise<void> {
    const response = asObject(await this.request('config/read', { cwd: this.workspaceRoot, includeLayers: true }));
    const config = asObject(response.config);
    const provider = stringValue(config.model_provider);
    // 0.155.1 reports `model_provider: null` when the authenticated account default is in use. Preserve
    // that native default by omitting the thread override; pin only a provider the CLI actually names.
    this.effectiveModelProvider = provider || undefined;
    const analytics = asObject(config.analytics);
    if (analytics.enabled !== false) {
      throw new Error('Codex refused to start: analytics remained enabled despite the privacy override.');
    }
    const otel = asObject(config.otel);
    if (otel.exporter !== 'none') {
      throw new Error('Codex refused to start: OTel export remained enabled despite the privacy override.');
    }
    const expected = codexProtocolPermissionSettings(this.spawnedProfile);
    if (config.approval_policy !== expected.approvalPolicy) {
      throw new Error('Codex refused to start: the host-owned approval policy did not win over local configuration.');
    }
    if (
      expected.sandboxMode === 'workspace-write'
      && process.platform === 'win32'
      && config.sandbox_mode === 'read-only'
    ) {
      throw new Error(
        'Codex downgraded workspace-write to read-only. Configure `[windows] sandbox = "unelevated"` '
        + '(or `"elevated"`) in your Codex configuration, then restart the agent.',
      );
    }
    if (config.sandbox_mode !== expected.sandboxMode) {
      throw new Error('Codex refused to start: the host-owned sandbox profile did not win over local configuration.');
    }
    const effectiveNetwork = asObject(config.sandbox_workspace_write).network_access;
    if (effectiveNetwork !== undefined && effectiveNetwork !== expected.networkAccess) {
      throw new Error('Codex refused to start: the host-owned sandbox network setting did not win over local configuration.');
    }
    if (config.approvals_reviewer !== expected.approvalsReviewer) {
      throw new Error('Codex refused to start: the host-owned approval reviewer did not win over local configuration.');
    }
    const appDefaults = asObject(asObject(config.apps)._default);
    if (
      appDefaults.default_tools_approval_mode !== expected.appApprovalMode
      || appDefaults.approvals_reviewer !== expected.appApprovalsReviewer
    ) {
      throw new Error('Codex refused to start: MCP tool approval did not match the host-owned permission profile.');
    }
    const projectLayers = Array.isArray(response.layers)
      ? response.layers.map(asObject).filter((layer) => asObject(layer.name).type === 'project')
      : [];
    if (this.repositoryLaunchApproval?.mode === 'native' && projectLayers.some((layer) => typeof layer.disabledReason === 'string')) {
      throw new Error('Codex refused to start: Trust and load did not enable the project configuration layer.');
    }
    if (this.repositoryLaunchApproval?.mode === 'user-only' && projectLayers.some((layer) => typeof layer.disabledReason !== 'string')) {
      throw new Error('Codex refused to start: Continue without project automation did not disable the project configuration layer.');
    }
  }

  private async discoverAccountModels(): Promise<void> {
    try {
      const models = parseCodexAccountModels(await this.request('model/list', { limit: 100, includeHidden: false }));
      if (models.length > 0) await this.deps?.onModels?.(models, this.cliVersion);
    } catch (error) {
      this.emit({ kind: 'log', stream: 'stderr', line: `Codex model discovery skipped: ${String(error)}` });
    }
  }

  private async runTurn(instruction: string, attachments?: TurnAttachments): Promise<void> {
    this.turnText = '';
    this.lastAgentMessagePart = undefined;
    this.turnUsageThreadId = undefined;
    this.turnUsageTotal = undefined;
    this.turnUsageLast = undefined;
    this.turnUsageUpdates = 0;
    this.turnUsageReset = false;
    this.settledTurnUsage = undefined;
    this.replies = new EmptyReplyTracker(CODEX_REPLY_GATEWAY);
    this.replies.beginAttempt();
    this.lastTurnStart = undefined;
    this.attemptReportedUsage = [false];
    this.completedReviewRationales.clear();
    this.activeAttachments = attachments;
    this.managedToolAbortController = new AbortController();
    this.coordinatorReadTools = undefined;
    this.deps?.teamMcpBridge?.beginTurnContentReceipts?.();
    this.deps?.teamMcpBridge?.setDelegationContentSources?.(attachments?.delegationContentSources);
    try {
      // A restart after an uncertain compaction finishes first; if it failed, this turn fails with its reason.
      if (this.appServerRestart) {
        await this.appServerRestart.catch((error) => {
          throw new Error(`Codex App Server could not be restarted: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      const access = this.turnAccess(attachments?.taskWorkspaceAccess);
      if (!access.trusted || access.readRoots.length === 0) {
        throw new Error('Codex turn was blocked because its current Workspace Trust or Folder Access grants no access.');
      }
      const policy = this.sandboxPolicy(access);
      const profile = this.resolvedProfile(access, attachments?.mode ?? 'act');
      const settings = codexProtocolPermissionSettings(profile);
      const threadId = await this.ensureThread(access, policy);
      this.emit({ kind: 'model_request' });
      const turnStart: JsonObject = {
        threadId,
        input: [{ type: 'text', text: this.composeTurnText(instruction, attachments), text_elements: [] }],
        cwd: this.workspaceRoot,
        runtimeWorkspaceRoots: this.runtimeRoots(access, policy),
        approvalPolicy: settings.approvalPolicy,
        approvalsReviewer: settings.approvalsReviewer,
        sandboxPolicy: policy,
        // No `environments`: omitted selects Codex's local default, while `[]` *disables* environment access and
        // with it the escalated-retry path, so no escalation could ever reach the user or the reviewer (measured
        // on 0.155.1). Remote environments exist only via environment/add, which UnodeAi never calls.
        ...(this.selectedModel() ? { model: this.selectedModel() } : {}),
        ...(this.selectedEffort() ? { effort: this.selectedEffort() } : {}),
      };
      this.lastTurnStart = turnStart;
      const response = asObject(await this.request('turn/start', turnStart));
      const turn = asObject(response.turn);
      if (typeof turn.id !== 'string' || !turn.id) throw new Error('Codex App Server returned no turn id.');
      this.turnId = turn.id;
    } catch (error) {
      this.failTurn(error instanceof Error ? error.message : String(error));
    }
  }

  private async ensureThread(access: CodexRuntimeAccess, policy: CodexSandboxPolicy): Promise<string> {
    const profile = this.resolvedProfile(access, this.activeAttachments?.mode ?? 'act');
    const settings = codexProtocolPermissionSettings(profile);
    const method = this.threadId ? 'thread/resume' : 'thread/start';
    const startingDynamicToolSignature = method === 'thread/start' ? this.dynamicToolSignature() : undefined;
    const params: JsonObject = {
      ...(this.threadId ? { threadId: this.threadId } : {}),
      cwd: this.workspaceRoot,
      runtimeWorkspaceRoots: this.runtimeRoots(access, policy),
      approvalPolicy: settings.approvalPolicy,
      approvalsReviewer: settings.approvalsReviewer,
      ...(this.effectiveModelProvider ? { modelProvider: this.effectiveModelProvider } : {}),
      sandbox: settings.sandboxMode,
      config: {
        analytics: { enabled: false }, otel: { exporter: 'none' },
        approval_policy: settings.approvalPolicy, approvals_reviewer: settings.approvalsReviewer,
        sandbox_mode: settings.sandboxMode,
        // Explicit, because thread/resume otherwise reports both exclusions false (measured on 0.155.1),
        // which would make the temp folders writable outside the workspace.
        sandbox_workspace_write: {
          network_access: settings.networkAccess, exclude_tmpdir_env_var: true, exclude_slash_tmp: true,
        },
        apps: { _default: {
          default_tools_approval_mode: settings.appApprovalMode,
          approvals_reviewer: settings.appApprovalsReviewer,
        } },
      },
      // Preserve Codex's native harness/tool guidance. The UnodeAi role is an additive developer layer.
      developerInstructions: this.config.systemPrompt,
      // Deliberately no `environments: []` (see runTurn): empty disables the escalated-retry path.
      ...(method === 'thread/start' ? { dynamicTools: await this.dynamicToolSpecs() } : {}),
      ...(this.selectedModel() ? { model: this.selectedModel() } : {}),
    };
    const response = asObject(await this.request(method, params));
    this.assertThreadPolicy(response, access, policy);
    const thread = asObject(response.thread);
    if (typeof thread.id !== 'string' || !thread.id) throw new Error('Codex App Server returned no thread id.');
    this.threadId = thread.id;
    if (startingDynamicToolSignature) this.threadDynamicToolSignature = startingDynamicToolSignature;
    this.emit({ kind: 'ready', model: this.config.model, backendSessionId: this.threadId });
    return this.threadId;
  }

  private assertThreadPolicy(response: JsonObject, access: CodexRuntimeAccess, policy: CodexSandboxPolicy): void {
    const profile = this.resolvedProfile(access, this.activeAttachments?.mode ?? 'act');
    const settings = codexProtocolPermissionSettings(profile);
    if (response.approvalPolicy !== settings.approvalPolicy || response.approvalsReviewer !== settings.approvalsReviewer) {
      throw new Error('Codex refused to start: the host-owned approval policy did not win over the user configuration.');
    }
    if (this.effectiveModelProvider && response.modelProvider !== this.effectiveModelProvider) {
      throw new Error('Codex refused to start: App Server changed the user-selected model provider.');
    }
    if (typeof response.cwd !== 'string' || pathKey(response.cwd) !== pathKey(this.workspaceRoot)) {
      throw new Error('Codex refused to start: App Server returned an unexpected working directory.');
    }
    // App Server 0.155.1 reports the primary workspace through `cwd` and may omit it from
    // runtimeWorkspaceRoots. Any root it does report must still be one the host supplied.
    const returnedRoots = stringArray(response.runtimeWorkspaceRoots).map(normalizeWindowsPath);
    const unexpectedRoots = returnedRoots.filter(
      (root) => !access.readRoots.some((allowed) => isInside(normalizeWindowsPath(allowed), root)),
    );
    if (unexpectedRoots.length > 0) {
      throw new Error(
        `Codex refused to start: App Server added runtime workspace root(s) this agent was not given: `
        + `${unexpectedRoots.join(', ')}.`,
      );
    }
    const actual = asObject(response.sandbox);
    const sandboxMatches = policy.type === 'dangerFullAccess'
      ? actual.type === 'dangerFullAccess'
      : actual.type === policy.type && actual.networkAccess === false;
    if (!sandboxMatches) {
      throw new Error('Codex refused to start: App Server did not retain the host-owned sandbox and network policy.');
    }
    if (policy.type === 'workspaceWrite') {
      const returnedWritableRoots = stringArray(actual.writableRoots).map(normalizeWindowsPath);
      const unexpected = returnedWritableRoots.filter(
        (root) => !policy.writableRoots.some((allowed) => isInside(normalizeWindowsPath(allowed), root)),
      );
      if (unexpected.length > 0) {
        // Name the root: a bare refusal can be neither acted on by the user nor diagnosed from a field report.
        throw new Error(
          `Codex refused to start: App Server added writable root(s) outside this agent's write access: `
          + `${unexpected.join(', ')}. Allowed: ${policy.writableRoots.join(', ') || '(none)'}.`,
        );
      }
      if (actual.excludeTmpdirEnvVar !== true || actual.excludeSlashTmp !== true) {
        throw new Error('Codex refused to start: App Server made the temp folders writable outside the workspace.');
      }
    }
  }

  /**
   * The roots Codex may treat as workspace roots. Measured on 0.155.1: `thread/resume` makes every runtime
   * workspace root **writable** under workspace-write (thread/start ignores them), so a read-only grant such
   * as the default `localReadScope: parent` became a write grant over the whole parent folder. Under a
   * workspace-write sandbox only the write roots may be sent. Codex's reads are not confined to these roots
   * anyway, so dropping read-only extras loses no capability.
   */
  private runtimeRoots(access: CodexRuntimeAccess, policy: CodexSandboxPolicy): string[] {
    return policy.type === 'readOnly' ? access.readRoots : access.writeRoots;
  }

  private sandboxPolicy(access: CodexRuntimeAccess): CodexSandboxPolicy {
    const profile = this.resolvedProfile(access, this.activeAttachments?.mode ?? 'act');
    if (profile === 'full-access') return { type: 'dangerFullAccess' };
    if (profile === 'read-only') {
      return { type: 'readOnly', networkAccess: false };
    }
    return {
      type: 'workspaceWrite',
      writableRoots: access.writeRoots,
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
  }

  private resolvedProfile(access: CodexRuntimeAccess, mode: ChatMode): ResolvedCodexPermissionProfile {
    // A task-scoped grant is itself a narrower Folder Access boundary. Full access cannot represent it,
    // so resolve downward instead of claiming the task roots still constrain an unsandboxed process.
    const taskScoped = !!this.activeAttachments?.taskWorkspaceAccess;
    return resolveCodexPermissionProfile({
      configured: this.config.codexPermissionProfile,
      mode,
      trusted: access.trusted,
      restricted: access.restricted,
      writeRoots: taskScoped ? [] : access.writeRoots,
      allowedTools: this.config.allowedTools,
      toolCeiling: this.config.toolCeiling,
    }).effective;
  }

  private baseAccess(): CodexRuntimeAccess {
    const access = this.deps?.access?.();
    return access
      ? normalizeAccess(access)
      : { trusted: true, restricted: false, readRoots: [this.workspaceRoot], writeRoots: [this.workspaceRoot] };
  }

  private turnAccess(taskAccess?: TaskWorkspaceAccess): CodexRuntimeAccess {
    const base = this.baseAccess();
    if (!taskAccess) return base;
    return normalizeAccess({
      trusted: base.trusted,
      restricted: true,
      readRoots: intersectRoots(base.readRoots, taskAccess.readRoots),
      writeRoots: intersectRoots(base.writeRoots, taskAccess.writeRoots),
    });
  }

  private request(method: string, params: unknown, timeoutMs = APP_SERVER_REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = ++this.requestSequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  private write(message: JsonObject): void {
    if (!this.proc?.stdin?.writable) throw new Error('Codex App Server stdin is unavailable.');
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: string): void {
    const parsed = this.parser.push(chunk);
    parsed.objects.forEach((message) => this.handleMessage(message));
    parsed.garbage.forEach((line) => this.emit({ kind: 'log', stream: 'stdout', line }));
  }

  private handleMessage(raw: unknown): void {
    const message = asObject(raw);
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      this.resolveResponse(message);
      return;
    }
    if (typeof message.method !== 'string') return;
    if (message.id !== undefined) {
      void this.handleServerRequest(message.id as JsonRpcId, message.method, message.params);
      return;
    }
    this.handleNotification(message.method, message.params);
  }

  private resolveResponse(message: JsonObject): void {
    const id = message.id as JsonRpcId;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      const error = asObject(message.error);
      // The JSON-RPC code travels with the error: an unknown method is a capability answer, not a failure.
      pending.reject(Object.assign(new Error(String(error.message ?? 'Codex App Server request failed.')), { code: error.code }));
    } else pending.resolve(message.result);
  }

  private async handleServerRequest(id: JsonRpcId, method: string, rawParams: unknown): Promise<void> {
    // An approval, a dynamic tool call or an elicitation: this attempt is never retried as blank.
    this.replies?.noteActivity();
    try {
      const params = asObject(rawParams);
      switch (method) {
        case 'item/commandExecution/requestApproval':
          this.respond(id, await this.commandApproval(params, false)); return;
        case 'execCommandApproval':
          this.respond(id, await this.commandApproval(params, true)); return;
        case 'item/fileChange/requestApproval':
          this.respond(id, await this.fileApproval(params, false)); return;
        case 'applyPatchApproval':
          this.respond(id, await this.fileApproval(params, true)); return;
        case 'item/permissions/requestApproval':
          this.respond(id, await this.permissionApproval(params)); return;
        case 'mcpServer/elicitation/request':
          this.respond(id, await this.mcpToolApproval(params)); return;
        case 'item/tool/call':
          this.respond(id, await this.dynamicToolCall(params)); return;
        default:
          this.write({
            jsonrpc: '2.0', id,
            error: { code: -32601, message: `UnodeAi declined unknown Codex App Server request: ${method}` },
          });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (method === 'item/permissions/requestApproval') this.respond(id, deniedPermissions());
      else if (method === 'mcpServer/elicitation/request') this.respond(id, { action: 'decline' });
      else if (method === 'item/tool/call') this.respond(id, dynamicToolResponse(false, reason));
      else if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
        this.respond(id, { decision: { denied: { rejection: reason } } });
      } else if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        this.respond(id, { decision: 'decline' });
      } else {
        this.write({ jsonrpc: '2.0', id, error: { code: -32602, message: `UnodeAi declined malformed request: ${reason}` } });
      }
    }
  }

  private async dynamicToolSpecs(): Promise<JsonObject[]> {
    const teamSpecs = this.deps?.teamMcpBridge ? await this.deps.teamMcpBridge.listTools() : [];
    const specs: ToolSpec[] = [
      ...teamSpecs.map((spec) => ({
        type: 'function' as const,
        function: {
          name: spec.name,
          description: spec.description ?? '',
          parameters: spec.inputSchema ?? { type: 'object', properties: {} },
        },
      })),
      // A coordinator reads through the host so what it shows the user can be exact content (v0.9.88 §5.5).
      ...(this.deps?.teamMcpBridge ? [COORDINATOR_READ_FILE_SPEC] : []),
      ...(this.deps?.mcp
        ? this.deps.mcp.hub.getToolSpecs(resolveMcpServerGrants(this.deps.mcp.grants))
        : []),
      ...(this.deps?.executableSkills?.toolSpec() ? [this.deps.executableSkills.toolSpec()!] : []),
    ];
    const names = new Set<string>();
    return specs.map((spec) => {
      const name = spec.function.name;
      if (names.has(name)) throw new Error(`Codex dynamic tool collision: ${name}.`);
      names.add(name);
      return {
        name,
        description: spec.function.description ?? '',
        inputSchema: spec.function.parameters ?? { type: 'object', properties: {} },
      };
    });
  }

  private hasDynamicToolSources(): boolean {
    return !!this.deps?.teamMcpBridge
      || (this.deps?.mcp ? resolveMcpServerGrants(this.deps.mcp.grants).length > 0 : false)
      || !!this.deps?.executableSkills?.toolSpec();
  }

  private dynamicToolSignature(): string {
    const mcpTools = (this.deps?.mcp
      ? this.deps.mcp.hub.getToolSpecs(resolveMcpServerGrants(this.deps.mcp.grants))
      : [])
      .map((spec) => spec.function.name)
      .sort();
    return JSON.stringify({
      team: !!this.deps?.teamMcpBridge,
      // Its own bit: coordinators were already team, and a thread started without read_file must start fresh once.
      // Present only when true, so a worker's signature, and with it the worker's conversation, is unchanged.
      ...(this.deps?.teamMcpBridge ? { hostReadFile: true } : {}),
      mcpTools,
      executableSkills: !!this.deps?.executableSkills?.toolSpec(),
    });
  }

  private async dynamicToolCall(params: JsonObject): Promise<JsonObject> {
    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId);
    const callId = stringValue(params.callId);
    const tool = stringValue(params.tool);
    if (!threadId || threadId !== this.threadId || !turnId || turnId !== this.turnId || !callId || !tool) {
      throw new Error('Codex dynamic tool request was not bound to this active agent turn.');
    }
    if (params.namespace !== null && params.namespace !== undefined) {
      throw new Error('Codex dynamic tool request used an unexpected namespace.');
    }
    const args = asStrictObject(params.arguments);
    if (Buffer.byteLength(JSON.stringify(args), 'utf8') > DYNAMIC_TOOL_ARGUMENT_BYTES) {
      throw new Error('Codex dynamic tool arguments exceeded the 64 KiB host limit.');
    }
    // Codex's own callId only binds this request to the turn; the card and receipt use the host's id.
    const hostCallId = this.toolCallIds.open();
    this.emit({ kind: 'tool_use', callId: hostCallId, name: tool, input: args });
    let outcome: ToolOutcome;
    let output: string;
    /** Set only by a receipt read: the output without the lines the host added for the model. */
    let cardOutput: string | undefined;
    if (this.activeAttachments?.mode === 'plan' && tool !== 'list_agents') {
      outcome = hostToolRefused(`${tool} is unavailable in Plan mode.`, 'capability');
      output = outcome.output;
    } else if (tool === RUN_SKILL_ACTION_TOOL && this.deps?.executableSkills?.toolSpec()) {
      const result = await this.deps.executableSkills.run(args);
      outcome = result;
      output = result.output;
    } else if (tool === COORDINATOR_READ_FILE_SPEC.function.name && this.deps?.teamMcpBridge) {
      const bridge = this.deps.teamMcpBridge;
      const access = this.currentAccess();
      if (!access.trusted) {
        outcome = hostToolRefused('read_file is blocked because the workspace is not trusted.', 'trust');
        output = outcome.output;
      } else {
        // Codex cannot show the host what the model saw, so its receipts carry an end check (Owner decision).
        const read = await runContentReceiptRead(this.coordinatorReadToolsForTurn(access), args, {
          unit: 'bytes',
          limit: CODEX_RECEIPT_READ_BYTES,
          delivery: 'end-check',
          register: (content, delivery) => bridge.registerTurnContentReceipt?.(content, delivery),
        });
        outcome = read.result;
        output = read.text;
        cardOutput = read.displayText;
      }
    } else if (this.deps?.teamMcpBridge && (await this.deps.teamMcpBridge.listTools()).some((item) => item.name === tool)) {
      // The bridge keeps the team tool's host decision; a bridge without it is external text judged by transport.
      const bridge = this.deps.teamMcpBridge;
      outcome = typeof bridge.callToolOutcome === 'function'
        ? await bridge.callToolOutcome(tool, args)
        : externalToolOutcome(await bridge.callTool(tool, args));
      output = outcome.output;
    } else if (this.deps?.mcp) {
      const currentGrants = resolveMcpServerGrants(this.deps.mcp.grants);
      const access = this.currentAccess();
      outcome = access.trusted
        ? await this.deps.mcp.hub.executeTool(tool, args, currentGrants, this.managedToolAbortController?.signal)
        : hostToolRefused(`MCP tool "${tool}" is blocked because the workspace is not trusted.`, 'trust');
      output = outcome.output;
    } else {
      outcome = hostToolRefused(`Dynamic tool "${tool}" is not granted to this agent.`, 'consent');
      output = outcome.output;
    }
    const bounded = boundDynamicToolResult(output);
    // The outcome is the only truth: Codex's success flag and the card are projections of it, never of the text.
    const fact = toolOutcomeFact(outcome);
    if (tool === COORDINATOR_READ_FILE_SPEC.function.name) {
      // The card shows the file the way the other routes do; the receipt and check lines are for the model.
      const card = summarizeToolResult(tool, args, { ...outcome, output: boundDynamicToolResult(cardOutput ?? output) });
      this.emit({ kind: 'tool_result', callId: hostCallId, name: tool, outcome: fact, summary: card.summary, detail: card.detail });
    } else {
      this.emit({ kind: 'tool_result', callId: hostCallId, name: tool, outcome: fact, summary: bounded.slice(0, 500), detail: bounded });
    }
    return dynamicToolResponse(toolFactSucceeded(fact), bounded);
  }

  private async commandApproval(params: JsonObject, legacy: boolean): Promise<JsonObject> {
    const transportedCommand = legacy
      ? stringArray(params.command).join(' ')
      : typeof params.command === 'string' ? params.command : '';
    const actions = Array.isArray(params.commandActions) ? params.commandActions.map(asObject) : [];
    const actionCommands = actions.map((action) => stringValue(action.command)).filter(Boolean);
    const command = codexCommandForPolicy(transportedCommand, actionCommands);
    if (!command) throw new Error('Codex command approval had no command.');
    // A host boundary is named before the missing approval card it implies.
    const hostRefusal = this.hostCommandRefusal();
    if (hostRefusal) {
      this.refuseItem(params, hostRefusal);
      return commandDecision(false, legacy, 'Blocked by UnodeAi host policy.');
    }
    if (!this.usesUserApprovalProfile()) {
      this.refuseItem(params, 'consent');
      return commandDecision(false, legacy, 'No host approval card is available in this profile.');
    }
    const verdict = this.deps?.commandPolicy?.check(command);
    if (verdict?.allowed) return commandDecision(true, legacy);
    const allowlistCard = this.deps?.commandPolicy?.approvalMode === 'allowlist'
      && !/blocked destructive pattern/i.test(verdict?.reason ?? '');
    if (verdict && !verdict.ask && !allowlistCard) {
      this.refuseItem(params, 'capability');
      return commandDecision(false, legacy, verdict.reason || 'Blocked by UnodeAi command policy.');
    }
    const decision = await this.askUser({
      kind: 'command', title: 'Codex command',
      detail: [command, typeof params.cwd === 'string' ? `Working directory: ${params.cwd}` : '', stringValue(params.reason)].filter(Boolean).join('\n\n'),
      command, timeoutMs: this.approvalTimeoutMs(),
    });
    if (!decision.allow) this.refuseItem(params, 'consent');
    return commandDecision(decision.allow, legacy, decision.note);
  }

  private async fileApproval(params: JsonObject, legacy: boolean): Promise<JsonObject> {
    const access = this.currentAccess();
    const fileChanges = legacy ? asObject(params.fileChanges) : undefined;
    const itemId = stringValue(params.itemId);
    const changes = legacy
      ? legacyFileChanges(fileChanges)
      : itemId ? this.pendingFileChanges.get(itemId) ?? [] : [];
    // A host boundary is named before the missing approval card it implies.
    const hostRefusal = this.hostWriteRefusal();
    if (hostRefusal) {
      this.refuseItem(params, hostRefusal);
      return fileDecision(false, legacy, 'Blocked by UnodeAi host policy.');
    }
    if (!this.usesUserApprovalProfile()) {
      this.refuseItem(params, 'consent');
      return fileDecision(false, legacy, 'No host approval card is available in this profile.');
    }
    const explicitPaths = changes.flatMap((change) => [change.path, change.kind.move_path].filter((value): value is string => !!value));
    if (explicitPaths.length === 0) throw new Error('Codex file approval had no checkpointable changed files.');
    if (!explicitPaths.every((candidate) => isWithinAny(candidate, access.writeRoots, this.workspaceRoot))) {
      this.refuseItem(params, 'scope');
      return fileDecision(false, legacy, 'Blocked by UnodeAi host policy.');
    }
    const reason = stringValue(params.reason);
    const grantRoot = stringValue(params.grantRoot);
    const request: CodexApprovalRequest = {
      kind: 'file-change', title: 'Codex file change',
      detail: [
        `Files:\n${explicitPaths.join('\n')}`,
        ...changes.map((change) => change.diff),
        grantRoot ? `Requested root: ${grantRoot}` : '', reason,
      ].filter(Boolean).join('\n\n'),
      fileChanges: changes,
      timeoutMs: this.approvalTimeoutMs(),
    };
    if (this.deps?.writeApprovalAsk?.()) {
      const decision = await this.askUser(request);
      if (!decision.allow) {
        this.refuseItem(params, 'consent');
        return fileDecision(false, legacy, decision.note);
      }
    }
    const checkpoint = await this.deps?.prepareFileCheckpoint?.(changes);
    if (!checkpoint?.ok) {
      const note = checkpoint?.note || 'UnodeAi could not save a restorable checkpoint for this Codex change.';
      if (!this.deps?.writeApprovalAsk?.()) {
        await this.askUser({
          ...request,
          title: 'Codex write blocked',
          detail: `${request.detail}\n\n${note}\n\nAuto could not protect this change, so it was blocked.`,
        });
      }
      // The host refuses a change it cannot make restorable.
      this.refuseItem(params, 'safety-limit');
      return fileDecision(false, legacy, note);
    }
    return fileDecision(true, legacy);
  }

  private async permissionApproval(params: JsonObject): Promise<JsonObject> {
    if (!this.usesUserApprovalProfile()) return deniedPermissions();
    const requested = asObject(params.permissions);
    if (!this.hostAllowsPermission(requested)) return deniedPermissions();
    const decision = await this.askUser({
      kind: 'permission', title: 'Codex permission escalation',
      detail: [stringValue(params.reason) || 'Codex requested additional permissions.', JSON.stringify(requested, null, 2)].join('\n\n'),
      timeoutMs: this.approvalTimeoutMs(),
    });
    return decision.allow ? { permissions: requested, scope: 'turn', strictAutoReview: true } : deniedPermissions();
  }

  /**
   * Codex 0.155.1 transports a prompted MCP tool call as an empty `form` elicitation. Treat only that
   * exact shape as an approval. Real MCP form elicitations stay fail-closed instead of being mistaken for
   * permission to execute a tool.
   */
  private async mcpToolApproval(params: JsonObject): Promise<JsonObject> {
    if (!this.usesUserApprovalProfile()) return { action: 'decline' };
    const server = stringValue(params.serverName);
    const message = stringValue(params.message);
    const schema = asObject(params.requestedSchema);
    const properties = asObject(schema.properties);
    const match = /^Allow the (.+) MCP server to run tool "([^"]+)"\?$/.exec(message);
    if (
      params.mode !== 'form'
      || !server
      || !match
      || match[1] !== server
      || Object.keys(properties).length !== 0
    ) {
      throw new Error('Codex MCP elicitation was not the validated tool-approval shape.');
    }
    const tool = match[2];
    const access = this.currentAccess();
    if (!access.trusted || access.restricted || !this.threadId || this.activeAttachments?.mode === 'plan') {
      return { action: 'decline' };
    }
    const decision = await this.askUser({
      kind: 'mcp-tool',
      title: `Codex MCP tool: ${server} / ${tool}`,
      detail: `${message}\n\nThis MCP server is configured in Codex. Allowing this request permits this exact call once; UnodeAi does not claim the server is safe.`,
      server,
      tool,
      timeoutMs: this.approvalTimeoutMs(),
    });
    return decision.allow ? { action: 'accept', content: {} } : { action: 'decline' };
  }

  /**
   * Why host policy refuses a native command, or undefined when it allows one. Boundaries are named in order:
   * Workspace Trust, then task and folder scope, then capability.
   */
  private hostCommandRefusal(): HostToolRefusalReason | undefined {
    const access = this.currentAccess();
    if (!access.trusted) return 'trust';
    if (this.activeAttachments?.taskWorkspaceAccess) return 'task-scope';
    if (access.restricted) return 'scope';
    if (this.activeAttachments?.mode === 'plan') return 'capability';
    return undefined;
  }

  /** Why host policy refuses a native file change, or undefined when it allows one; named in the same order. */
  private hostWriteRefusal(): HostToolRefusalReason | undefined {
    const access = this.currentAccess();
    if (!access.trusted) return 'trust';
    if (access.writeRoots.length === 0) return 'scope';
    if (this.activeAttachments?.mode === 'plan') return 'capability';
    return undefined;
  }

  /**
   * The host declined a native item: its completion reports this refusal, whatever Codex says about the item.
   * A request without an item id cannot be joined; the turn's tool coverage becomes partial instead.
   */
  private refuseItem(params: JsonObject, reason: HostToolRefusalReason): void {
    const itemId = stringValue(params.itemId);
    if (itemId) this.hostItemRefusals.note(itemId, reason);
    else this.emit({ kind: 'tool_coverage_gap', reason: 'host-decision-unjoined' });
  }

  /**
   * A native item's result: the host's refusal when it declined the item, otherwise what Codex reported. A refusal
   * whose item id named more than one item joins nothing, and the turn's coverage becomes partial.
   */
  private nativeItemFact(itemId: string, succeeded: boolean): ToolResultFact {
    const refusal = itemId ? this.hostItemRefusals.take(itemId) : { unjoined: false };
    if (refusal.unjoined) this.emit({ kind: 'tool_coverage_gap', reason: 'host-decision-unjoined' });
    if (refusal.fact) return { status: 'refused', observedBy: 'host', reason: refusal.fact };
    return succeeded ? providerToolSucceeded() : providerToolFailed();
  }

  private hostAllowsPermission(requested: JsonObject): boolean {
    if (this.activeAttachments?.mode === 'plan') return false;
    const access = this.currentAccess();
    if (!access.trusted) return false;
    const network = asObject(requested.network);
    if (network.enabled === true) return false;
    const fileSystem = asObject(requested.fileSystem);
    if (Array.isArray(fileSystem.entries) && fileSystem.entries.length > 0) return false;
    const reads = nullableStringArray(fileSystem.read);
    const writes = nullableStringArray(fileSystem.write);
    return reads.every((candidate) => isWithinAny(candidate, access.readRoots, this.workspaceRoot))
      && writes.every((candidate) => isWithinAny(candidate, access.writeRoots, this.workspaceRoot));
  }

  private currentAccess(): CodexRuntimeAccess {
    return this.turnAccess(this.activeAttachments?.taskWorkspaceAccess);
  }

  /**
   * The coordinator's host read_file for this turn. It can never widen the sandbox: read only, **no write roots**
   * (the constructor otherwise makes its root writable, and every write root is readable), exactly the turn's read
   * roots, and relative paths from the task scope's path base. Rebuilt each turn, so a scope never outlives it.
   */
  private coordinatorReadToolsForTurn(access: CodexRuntimeAccess): WorkspaceTools {
    if (!this.coordinatorReadTools) {
      const pathBase = this.activeAttachments?.taskWorkspaceAccess?.pathBase ?? this.workspaceRoot;
      this.coordinatorReadTools = new WorkspaceTools(
        pathBase,
        new Set(['read']),
        this.agentId,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined,
        undefined, // no shared integration view
        [...access.readRoots],
        () => this.currentAccess().trusted,
        [],
      );
    }
    return this.coordinatorReadTools;
  }

  private usesUserApprovalProfile(): boolean {
    return this.resolvedProfile(this.currentAccess(), this.activeAttachments?.mode ?? 'act') === 'ask-for-approval';
  }

  private async askUser(request: CodexApprovalRequest): Promise<CodexApprovalDecision> {
    if (!this.deps?.requestApproval || this.stopped) return { allow: false };
    const profile = this.resolvedProfile(this.currentAccess(), this.activeAttachments?.mode ?? 'act');
    // Approve for me belongs to Codex's reviewer; Full access promises no prompts. The only exception is
    // the measured, single-use recovery path for a reviewer denial carrying its original protocol event.
    if (request.kind === 'guardian-denied' ? profile !== 'approve-for-me' : profile !== 'ask-for-approval') {
      return { allow: false };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The host broker owns the card, its deadline and the waiting state. This timer is a last-resort net that
    // fires a grace period after the same window, so the broker always settles the card and decision first.
    try {
      return await Promise.race([
        this.deps.requestApproval(request).catch(() => ({ allow: false })),
        new Promise<CodexApprovalDecision>((resolve) => {
          timer = setTimeout(
            () => resolve({ allow: false, note: 'The approval window expired.' }),
            request.timeoutMs + this.approvalTimerGraceMs(),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private approvalTimerGraceMs(): number {
    const configured = this.deps?.approvalTimerGraceMs;
    return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0 ? configured : APPROVAL_TIMER_GRACE_MS;
  }

  private approvalTimeoutMs(): number {
    const configured = this.deps?.approvalTimeoutMs;
    return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? configured : CODEX_APPROVAL_TIMEOUT_MS;
  }

  private respond(id: JsonRpcId, result: unknown): void { this.write({ jsonrpc: '2.0', id, result }); }

  private handleNotification(method: string, rawParams: unknown): void {
    const params = asObject(rawParams);
    if (this.compaction && this.consumeCompactionNotification(this.compaction, method, params)) return;
    if (method === 'item/autoApprovalReview/started' || method === 'item/autoApprovalReview/completed') {
      const completed = method.endsWith('/completed');
      const review = asObject(params.review);
      const action = guardianActionSummary(params.action);
      const status = stringValue(review.status);
      const rationale = stringValue(review.rationale);
      this.emit({
        kind: 'approval_review',
        phase: completed ? 'completed' : 'started',
        action,
        ...(status ? { status } : {}),
        ...(rationale ? { rationale } : {}),
      });
      if (completed && rationale) this.completedReviewRationales.add(rationale.trim());
      if (completed && status === 'denied') void this.offerApproveGuardianDeniedAction(params, action, rationale);
      return;
    }
    // Under Approve for me the reviewer decides instead of the user, so these are the only way it can tell
    // the user anything. 0.155.1 sends both; dropping them left the user blind to the reviewer's warnings.
    if (method === 'guardianWarning') {
      const message = stringValue(params.message);
      if (message && !this.completedReviewRationales.has(message.trim())) {
        this.emit({ kind: 'approval_review', phase: 'completed', action: 'Reviewer warning', status: 'warning', rationale: message });
      }
      return;
    }
    if (method === 'autoApprovalReview/strictReviewRequired') {
      this.emit({ kind: 'approval_review', phase: 'started', action: 'Strict review required', status: 'strict' });
      return;
    }
    if (method === 'item/agentMessage/delta') {
      const delta = stringValue(params.delta);
      const partIdentity = codexAgentMessagePartIdentity(params);
      this.replies?.noteText(delta);
      if (delta) {
        const separator = partIdentity && this.lastAgentMessagePart && partIdentity !== this.lastAgentMessagePart ? '\n\n' : '';
        this.turnText += separator + delta;
        if (separator) this.emit({ kind: 'assistant', text: separator });
        this.emit({ kind: 'assistant', text: delta });
        if (partIdentity) this.lastAgentMessagePart = partIdentity;
      }
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      this.handleItem(method, asObject(params.item)); return;
    }
    if (method === 'thread/tokenUsage/updated') {
      this.observeTokenUsage(params); return;
    }
    if (method === 'turn/completed') {
      const turn = asObject(params.turn);
      const failed = turn.status === 'failed';
      // v0.9.90 §7: a completed attempt with nothing visible starts once more, unchanged, on the same thread,
      // before any host text is appended and without a turn completion in between.
      if (turn.status === 'completed' && this.endReplyAttempt(turn) && this.retryBlankTurn()) return;
      const failure = failed ? String(asObject(turn.error).message ?? 'Codex turn failed.') : '';
      if (failure && !this.turnText) this.turnText = failure;
      const publishedDelivery = this.deps?.teamMcpBridge?.takePublishedTurnDelivery?.();
      const resultText = publishedDelivery?.text ?? this.turnText;
      const verbatim = turnVerbatimOf(publishedDelivery);
      const receipt = this.deps?.teamMcpBridge?.turnDelegationReceipt?.();
      if (receipt) this.emit(delegationReceiptEvent(receipt));
      const turnUsage = this.attemptAttributedUsage(this.settleTurnUsage());
      this.emit({
        kind: 'turn_complete',
        result: {
          text: resultText,
          isError: failed,
          ...(turnUsage ? { usage: turnUsage } : {}),
          ...(verbatim ? { verbatim } : {}),
          responseOutcome: failed
            ? { kind: 'error' }
            : turn.status === 'interrupted' ? { kind: 'stopped' } : this.replies?.outcome() ?? { kind: 'reply' },
        },
      });
      this.turnId = undefined;
      this.activeAttachments = undefined;
      this.managedToolAbortController = undefined;
      this.lastAgentMessagePart = undefined;
      return;
    }
    if (method === 'error') {
      const error = asObject(params.error);
      this.failTurn(String(error.message ?? params.message ?? 'Codex turn failed.'));
    }
  }

  private async offerApproveGuardianDeniedAction(params: JsonObject, action: string, rationale: string): Promise<void> {
    const denialEvent = asObject(params.event);
    // The measured notification schema does not declare `event`, although the live approve method exists
    // and requires it. Never synthesize protocol state: expose the escape hatch only when Codex supplies it.
    if (!this.threadId || !stringValue(denialEvent.id)) return;
    const decision = await this.askUser({
      kind: 'guardian-denied',
      title: 'Codex reviewer denied an action',
      detail: [action, rationale].filter(Boolean).join('\n\n'),
      timeoutMs: this.approvalTimeoutMs(),
      approveAnyway: true,
    });
    if (!decision.allow || !this.threadId || this.stopped) return;
    try {
      await this.request('thread/approveGuardianDeniedAction', { threadId: this.threadId, event: denialEvent });
    } catch (error) {
      this.emit({ kind: 'log', stream: 'stderr', line: `Codex approve-anyway request failed: ${String(error)}` });
    }
  }

  private handleItem(method: string, item: JsonObject): void {
    const completed = method === 'item/completed';
    if (item.type === 'agentMessage') this.replies?.noteText(stringValue(item.text));
    // Any item that is not the conversation itself is work a retry could repeat.
    else if (typeof item.type === 'string' && !CODEX_CONVERSATION_ITEMS.has(item.type)) this.replies?.noteActivity();
    if (item.type === 'contextCompaction') {
      // Codex compacted on its own threshold inside this turn. It exposes no summary or policy to receipt.
      if (completed) {
        this.lastRequestUsage = undefined;
        this.emit({ kind: 'log', stream: 'stderr', line: 'Codex compacted this conversation on its own threshold during the turn.' });
      }
      return;
    }
    if (item.type === 'agentMessage' && completed && !this.turnText) {
      const text = stringValue(item.text);
      if (text) { this.turnText = text; this.emit({ kind: 'assistant', text }); }
      return;
    }
    if (item.type === 'mcpToolCall') {
      const status = item.status === 'completed' || item.status === 'failed' ? item.status : 'inProgress';
      const itemId = stringValue(item.id);
      this.emit({
        kind: 'native_mcp_activity',
        // A host id like every other tool card, so the chat pairs its completion with its start, never by name.
        callId: completed ? this.toolCallIds.close(itemId) : this.toolCallIds.open(itemId || undefined),
        server: stringValue(item.server) || 'unknown server',
        tool: stringValue(item.tool) || 'unknown tool',
        status,
      });
      return;
    }
    if (item.type === 'commandExecution') {
      const name = 'command_execution';
      const itemId = stringValue(item.id);
      if (!completed) this.emit({ kind: 'tool_use', callId: this.toolCallIds.open(itemId || undefined), name, input: { command: stringValue(item.command) } });
      else {
        const exitCode = typeof item.exitCode === 'number' ? item.exitCode : 1;
        const detail = stringValue(item.aggregatedOutput);
        this.emit({ kind: 'tool_result', callId: this.toolCallIds.close(itemId), name, outcome: this.nativeItemFact(itemId, exitCode === 0), summary: detail.slice(0, 500) || `exit ${exitCode}`, detail });
      }
      return;
    }
    if (item.type === 'fileChange') {
      const itemId = stringValue(item.id);
      if (!completed) {
        const changes = parseFileChanges(item.changes);
        if (itemId && changes.length > 0) this.pendingFileChanges.set(itemId, changes);
        this.emit({ kind: 'tool_use', callId: this.toolCallIds.open(itemId || undefined), name: 'file_change', input: { changes: item.changes } });
      }
      else {
        if (itemId) this.pendingFileChanges.delete(itemId);
        const ok = item.status === 'completed';
        this.emit({ kind: 'tool_result', callId: this.toolCallIds.close(itemId), name: 'file_change', outcome: this.nativeItemFact(itemId, ok), summary: ok ? 'File change applied.' : `File change ${String(item.status)}.` });
      }
    }
  }

  private composeTurnText(instruction: string, attachments?: TurnAttachments): string {
    const parts = [instruction];
    if (attachments?.projectContext) parts.push(`<project_context>\n${attachments.projectContext}\n</project_context>`);
    if (attachments?.workspaceContext) parts.push(attachments.workspaceContext);
    if (attachments?.mode === 'plan') parts.push('[PLAN MODE] Analyze and plan only. Do not mutate files or run commands.');
    return parts.filter(Boolean).join('\n\n');
  }

  private selectedModel(): string | undefined {
    return this.config.model && this.config.model !== CODEX_CLI_DEFAULT_MODEL ? this.config.model : undefined;
  }

  private selectedEffort(): string | undefined {
    return this.resolvedParams?.reasoning_effort ?? this.config.modelParams?.reasoning_effort;
  }

  private assertSafeArguments(): void {
    for (const [label, value] of [['model', this.config.model], ['reasoning effort', this.selectedEffort()]] as const) {
      if (value && !SAFE_CLI_ARGUMENT.test(value)) throw new Error(`Codex refused unsafe ${label} argument.`);
    }
  }

  private async killRunningProcess(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    if (!proc?.pid) {
      this.cleanupNativeSkillRoot();
      return;
    }
    try { proc.stdin?.end(); } catch { /* already closed */ }
    await (this.deps?.killProcessTree ?? killProcessTreeByPid)(proc.pid);
    this.cleanupNativeSkillRoot();
  }

  private onProcessFailure(proc: ChildProcess, error: Error): void {
    if (proc !== this.proc) return;
    this.cleanupNativeSkillRoot();
    this.rejectPending(error);
    if (!this.stopped) this.failTurn(error.message);
  }

  private onProcessExit(proc: ChildProcess, code: number | null): void {
    if (proc !== this.proc) return;
    const tail = this.parser.flush();
    tail.objects.forEach((message) => this.handleMessage(message));
    tail.garbage.forEach((line) => this.emit({ kind: 'log', stream: 'stdout', line }));
    this.proc = undefined;
    this.started = false;
    this.cleanupNativeSkillRoot();
    this.rejectPending(new Error(`Codex App Server exited with code ${code ?? 'unknown'}.`));
    this.dropCompaction(`Codex App Server exited with code ${code ?? 'unknown'} while compacting.`);
    if (!this.stopped) {
      this.failTurn(`Codex App Server exited with code ${code ?? 'unknown'}.`);
      this.emit({ kind: 'exit', code });
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private cleanupNativeSkillRoot(): void {
    removeCodexSkillRoot(this.skillRoot);
    this.skillRoot = undefined;
  }

  private failTurn(message: string): void {
    if (this.stopped) return;
    this.emit({ kind: 'error', message });
    const usage = this.attemptAttributedUsage(this.settleTurnUsage());
    this.emit({
      kind: 'turn_complete',
      result: { text: this.turnText || message, isError: true, ...(usage ? { usage } : {}), responseOutcome: { kind: 'error' } },
    });
    this.turnId = undefined;
    this.activeAttachments = undefined;
    this.pendingFileChanges.clear();
  }

  private emit(event: BackendEvent): void { this.handlers.forEach((handler) => handler(event)); }

  /** Record one cumulative `thread/tokenUsage/updated` observation for the current turn. */
  private observeTokenUsage(params: JsonObject): void {
    const threadId = stringValue(params.threadId) || this.threadId;
    const usage = asObject(params.tokenUsage ?? params.usage);
    const total = codexBreakdown(usage.total);
    if (!threadId || !total) return;
    if ((this.threadId && threadId !== this.threadId) || (this.turnUsageThreadId && this.turnUsageThreadId !== threadId)) {
      // A different thread's cumulative figure is never compared with this turn's baseline.
      this.emit({ kind: 'log', stream: 'stderr', line: 'Codex reported usage for another thread; not attributed to this turn.' });
      return;
    }
    this.turnUsageThreadId = threadId;
    const baseline = this.threadUsageBaselines.get(threadId);
    if (baseline && total.totalTokens < baseline.totalTokens) {
      // The thread's total went down: reset its baseline, charge nothing and invent no gap.
      this.emit({ kind: 'log', stream: 'stderr', line: 'Codex reported a lower cumulative token total than before; the usage baseline for this thread was reset.' });
      this.threadUsageBaselines.set(threadId, total);
      this.turnUsageReset = true;
    }
    this.turnUsageTotal = total;
    this.turnUsageLast = codexBreakdown(usage.last);
    this.turnUsageUpdates += 1;
    if (this.attemptReportedUsage.length > 0) this.attemptReportedUsage[this.attemptReportedUsage.length - 1] = true;
    // A `last` with no input is App Server's post-compaction marker (only `totalTokens` set), not a request.
    if (this.turnUsageLast && this.turnUsageLast.inputTokens > 0) {
      this.lastRequestUsage = { threadId, inputTokens: this.turnUsageLast.inputTokens, outputTokens: this.turnUsageLast.outputTokens };
    }
    const window = asNumber(usage.modelContextWindow);
    if (window !== undefined && Number.isSafeInteger(window) && window > 0) this.reportedContextWindow = window;
  }

  /**
   * The last request's reported size on this thread plus the host's estimate of the next composed input. The
   * last request's output is included because it is history for the next one. A thread without a usable report
   * yet (a new or resumed thread) has no baseline, and the projection says so.
   */
  private projectNextTurn(instruction: string, attachments?: TurnAttachments): ContextProjection {
    const last = this.lastRequestUsage;
    if (!last || !this.threadId || last.threadId !== this.threadId) return { basis: 'unavailable', ...this.windowFields() };
    return {
      tokens: last.inputTokens + last.outputTokens + estimateTokens(this.composeTurnText(instruction, attachments)),
      basis: 'reported-plus-delta',
      ...this.windowFields(),
    };
  }

  /** Record the completed attempt with the facts App Server reported for it. Returns whether it was blank. */
  private endReplyAttempt(turn: JsonObject): boolean {
    if (!this.replies) return false;
    const reported = this.attemptReportedUsage[this.attemptReportedUsage.length - 1] === true && this.turnUsageLast;
    return this.replies.endAttempt({
      inputBasis: reported ? 'reported' : 'unavailable',
      ...(reported ? { inputTokens: this.turnUsageLast!.inputTokens, outputTokens: this.turnUsageLast!.outputTokens } : {}),
      ...(typeof turn.status === 'string' ? { finishSignal: turn.status } : {}),
      ...(stringValue(turn.id) ? { responseId: stringValue(turn.id) } : {}),
    });
  }

  /** Start the blank attempt's turn once more on the same thread. Returns false when the retry is not available. */
  private retryBlankTurn(): boolean {
    const turnStart = this.lastTurnStart;
    if (!turnStart || this.stopped || !this.proc || !this.replies?.takeRetry()) return false;
    this.emit({ kind: 'log', stream: 'stderr', line: 'empty reply (no text, no tool call); starting the same turn once more.' });
    this.replies.beginAttempt();
    this.attemptReportedUsage.push(false);
    this.emit({ kind: 'model_request' });
    void this.request('turn/start', turnStart).then((response) => {
      const turn = asObject(asObject(response).turn);
      if (typeof turn.id !== 'string' || !turn.id) throw new Error('Codex App Server returned no turn id.');
      this.turnId = turn.id;
    }).catch((error) => this.failTurn(error instanceof Error ? error.message : String(error)));
    return true;
  }

  /** After a retry, the turn's cumulative delta covers both attempts; say how many of them reported usage. */
  private attemptAttributedUsage(usage: TurnUsage | undefined): TurnUsage | undefined {
    if (!usage || this.attemptReportedUsage.length < 2) return usage;
    return { ...usage, attributedAttempts: this.attemptReportedUsage.filter(Boolean).length };
  }

  /** The user's number and a proven overflow bound outrank App Server's report; the report outranks an assumption. */
  private windowFields(): { window: number; windowSource: NonNullable<ContextProjection['windowSource']> } {
    const resolved = resolveContextWindow(this.config);
    return resolved.source === 'configured' || resolved.source === 'observed' || !this.reportedContextWindow
      ? { window: resolved.tokens, windowSource: resolved.source }
      : { window: this.reportedContextWindow, windowSource: 'measured' };
  }

  /**
   * Host-triggered compaction (design §6.3, live-verified on 0.155.1): `thread/compact/start` at an idle boundary
   * runs one compaction turn on the same thread (turn/started, a `contextCompaction` item, turn/completed). That turn
   * is consumed here: it never becomes this.turnId, chat output, a turn completion or delegation output. A failure
   * keeps the thread; the pending task is then sent on it unchanged.
   */
  private async compactNatively(request: ContextCompactionRequest): Promise<ContextCompactionResult> {
    if (this.nativeCompactUnsupported) {
      return { kind: 'failed', reason: 'native-unsupported', detail: 'This Codex App Server does not compact on request.' };
    }
    if (this.turnId) throw new Error('Compaction runs only between turns; this agent is in a turn.');
    if (this.compaction) return { kind: 'failed', reason: 'native-failed', detail: 'Codex is still finishing an earlier compaction.' };
    if (this.appServerRestart) return { kind: 'failed', reason: 'native-failed', detail: 'Codex App Server is restarting.' };
    if (!this.started || this.stopped || !this.proc) return { kind: 'failed', reason: 'native-failed', detail: 'Codex App Server is not running.' };
    if (!this.threadId) return { kind: 'skipped', reason: 'nothing-droppable' };
    let threadId: string;
    try {
      // The same resume every turn makes: a restored thread is loaded, and the host-owned policy is re-asserted.
      const access = this.baseAccess();
      threadId = await this.ensureThread(access, this.sandboxPolicy(access));
    } catch (error) {
      return { kind: 'failed', reason: 'native-failed', detail: error instanceof Error ? error.message : String(error) };
    }
    return new Promise<ContextCompactionResult>((resolve) => {
      let finished = false;
      let unitId: string | undefined;
      let usageClosed = false;
      const op: CodexCompaction = {
        threadId,
        sawItem: false,
        abandoned: false,
        finish: (result) => {
          if (finished) return;
          finished = true;
          request.signal?.removeEventListener('abort', onAbort);
          resolve(result);
        },
        // Accepted or started, whichever App Server says first: from here the operation may reach the model.
        startUnit: () => {
          if (unitId === undefined && !usageClosed) unitId = request.usage.requestStarted(this.config.model);
        },
        settle: (usage) => {
          if (usageClosed) return;
          usageClosed = true;
          if (unitId !== undefined) request.usage.requestSettled(unitId, usage);
        },
      };
      const onAbort = () => this.abandonCompaction(op);
      request.signal?.addEventListener('abort', onAbort, { once: true });
      this.compaction = op;
      this.request('thread/compact/start', { threadId }).then(() => op.startUnit(), (error: unknown) => {
        if (this.compaction === op) this.compaction = undefined;
        op.settle(undefined);
        const code = (error as { code?: unknown } | undefined)?.code;
        const detail = error instanceof Error ? error.message : String(error);
        if (code === -32601 || (code === -32600 && /unknown variant/i.test(detail))) {
          this.nativeCompactUnsupported = true;
          op.finish({ kind: 'failed', reason: 'native-unsupported', detail: 'This Codex App Server does not compact on request.' });
          return;
        }
        op.finish({ kind: 'failed', reason: 'native-failed', detail });
      });
    });
  }

  /** Route one notification of the running compaction's turn. Returns true when it belonged to that turn. */
  private consumeCompactionNotification(op: CodexCompaction, method: string, params: JsonObject): boolean {
    const threadId = stringValue(params.threadId);
    if (threadId && threadId !== op.threadId) return false;
    if (method === 'turn/started') {
      if (op.turnId) return false;
      op.turnId = stringValue(asObject(params.turn).id) || undefined;
      if (op.turnId) op.startUnit();
      return op.turnId !== undefined;
    }
    const turnId = method === 'turn/completed' ? stringValue(asObject(params.turn).id) : stringValue(params.turnId);
    if (!op.turnId || turnId !== op.turnId) return false;
    if (method === 'item/completed' && asObject(params.item).type === 'contextCompaction') op.sawItem = true;
    else if (method === 'thread/tokenUsage/updated') op.total = codexBreakdown(asObject(params.tokenUsage ?? params.usage).total) ?? op.total;
    else if (method === 'error') op.error = stringValue(asObject(params.error).message) || stringValue(params.message) || op.error;
    else if (method === 'turn/completed') this.endCompaction(op, asObject(params.turn));
    return true;
  }

  private endCompaction(op: CodexCompaction, turn: JsonObject): void {
    if (this.compaction === op) this.compaction = undefined;
    op.settle(this.compactionUsage(op));
    if (turn.status === 'completed' && op.sawItem) {
      // The last request's size no longer describes the thread; the next reported request replaces it.
      this.lastRequestUsage = undefined;
      op.finish({ kind: 'compacted', mechanism: 'native-runtime', after: { basis: 'unavailable', ...this.windowFields() } });
      return;
    }
    const failure = stringValue(asObject(turn.error).message) || op.error;
    op.finish({
      kind: 'failed',
      reason: 'native-failed',
      detail: failure || (turn.status === 'completed' ? 'Codex ended the compaction turn without compacting.' : `Codex compaction ended ${String(turn.status)}.`),
    });
  }

  /**
   * The compaction's usage: the positive increase in the thread's cumulative total, which then becomes the thread's
   * baseline so the next turn is not charged it again. 0.155.1 reports no increase, so the unit is a coverage gap.
   */
  private compactionUsage(op: CodexCompaction): TurnUsage | undefined {
    const total = op.total;
    if (!total) return undefined;
    const unknownBaseline = this.unknownBaselineThreads.has(op.threadId) && !this.threadUsageBaselines.has(op.threadId);
    const baseline = this.threadUsageBaselines.get(op.threadId) ?? zeroCodexBreakdown();
    this.threadUsageBaselines.set(op.threadId, total);
    this.unknownBaselineThreads.delete(op.threadId);
    if (unknownBaseline || total.totalTokens < baseline.totalTokens) return undefined;
    const delta = subtractCodexBreakdown(total, baseline);
    return delta.totalTokens > 0 ? codexTurnUsage(delta) : undefined;
  }

  /**
   * The host stopped waiting. A compaction turn App Server already started is interrupted and stays registered so
   * its remaining events are still consumed as its own; one it never started cannot be correlated and is dropped.
   */
  private abandonCompaction(op: CodexCompaction): void {
    op.finish({ kind: 'failed', reason: 'timeout', detail: 'Codex did not finish compacting in time.' });
    op.abandoned = true;
    if (!op.turnId) {
      // Whether App Server will still start this compaction is unknown. A late start would overlap the next task and
      // its events could pass for an ordinary turn, so the process is replaced: nothing of it can arrive any more, and
      // the thread resumes on the new process before the next turn is sent.
      this.dropCompaction('Codex did not start the compaction it was asked for in time.');
      this.restartAppServer('Codex App Server is being restarted: a compaction it was asked for neither started nor '
        + 'failed in time, and its late events could overlap the next task.');
      return;
    }
    void this.request('turn/interrupt', { threadId: op.threadId, turnId: op.turnId }).catch((error) => {
      this.emit({ kind: 'log', stream: 'stderr', line: `Codex compaction interrupt failed: ${String(error)}` });
    });
  }

  /**
   * Replace the App Server process in place: pending requests fail, the old process is killed and ignored, and a new
   * one is initialized with the same host-owned settings. Turns wait for it; a failed restart fails them visibly.
   */
  private restartAppServer(reason: string): void {
    this.emit({ kind: 'log', stream: 'stderr', line: reason });
    const restart = (async () => {
      this.rejectPending(new Error('Codex App Server was restarted.'));
      await this.killRunningProcess();
      if (this.stopped) return;
      // The replacement crosses the same launch boundary as the first start, without repeating dialogs already
      // answered: a changed repository configuration, a revoked trust or folder grant, a changed route or a changed
      // CLI stops it here, and the waiting turn fails with that reason.
      this.assertSafeArguments();
      this.assertHostCanStart();
      this.deps?.assertResolvedRoute?.();
      const version = await this.deps?.preflight?.(this.launchEnv);
      if (this.stopped) return;
      if (typeof version === 'string') this.cliVersion = version.trim();
      this.repositoryLaunchApproval?.assertCurrent();
      this.spawnAppServer();
      await this.initializeAppServer();
    })();
    this.appServerRestart = restart;
    restart.then(() => { if (this.appServerRestart === restart) this.appServerRestart = undefined; }, () => undefined);
  }

  /** End the running compaction without its terminal event; a started unit becomes a coverage gap. */
  private dropCompaction(detail: string): void {
    const op = this.compaction;
    if (!op) return;
    this.compaction = undefined;
    op.settle(undefined);
    op.finish({ kind: 'failed', reason: 'native-failed', detail });
  }

  /**
   * The turn's usage: the positive delta of the thread's cumulative total since its last observation, or
   * undefined when nothing attributable arrived (a coverage gap, never an invented figure). Idempotent within
   * one completion; the baseline advances when the turn settles.
   */
  private settleTurnUsage(): TurnUsage | undefined {
    const threadId = this.turnUsageThreadId;
    const total = this.turnUsageTotal;
    if (!threadId || !total) return undefined;
    const unknownBaseline = this.unknownBaselineThreads.has(threadId) && !this.threadUsageBaselines.has(threadId);
    const baseline = this.threadUsageBaselines.get(threadId) ?? zeroCodexBreakdown();
    const delta = subtractCodexBreakdown(total, baseline);
    const usage: TurnUsage | undefined = unknownBaseline
      ? undefined
      : delta.totalTokens > 0
        ? codexTurnUsage(delta)
        : this.turnUsageReset
          ? { inputTokens: 0, outputTokens: 0, usageBasis: 'reported', costBasis: 'api-equivalent' }
          // A zero delta (e.g. an interrupt repeating the previous total) is not a zero-cost claim.
          : undefined;
    if (usage && this.turnUsageUpdates === 1 && this.turnUsageLast && !unknownBaseline && delta.totalTokens > 0
      && this.turnUsageLast.totalTokens !== delta.totalTokens) {
      this.emit({ kind: 'log', stream: 'stderr', line: 'Codex per-request usage differs from the cumulative delta; the cumulative delta is used.' });
    }
    // Advance once: a second call for the same completion must return the same value.
    if (this.turnUsageUpdates > 0) {
      this.threadUsageBaselines.set(threadId, total);
      this.unknownBaselineThreads.delete(threadId);
      this.turnUsageUpdates = 0;
      this.settledTurnUsage = usage;
      return usage;
    }
    return this.settledTurnUsage;
  }

  private settledTurnUsage: TurnUsage | undefined;
}

/** The route name in an empty-reply attempt record. */
const CODEX_REPLY_GATEWAY = 'codex-app-server';

/** Thread items that are the conversation itself; every other item type is work (a command, a file change, a tool). */
const CODEX_CONVERSATION_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning', 'contextCompaction']);

/** One host-triggered `thread/compact/start` and the compaction turn App Server runs for it. */
interface CodexCompaction {
  threadId: string;
  /** App Server's id for the compaction turn, from its turn/started. */
  turnId?: string;
  /** The completed `contextCompaction` item: the only proof of success (the deprecated thread/compacted is not). */
  sawItem: boolean;
  error?: string;
  /** The thread's cumulative usage as reported during the compaction turn. */
  total?: CodexUsageBreakdown;
  /** The host stopped waiting; its late events are still consumed here. */
  abandoned: boolean;
  finish(result: ContextCompactionResult): void;
  /** Opens the operation's one usage unit; idempotent, and a no-op once usage is settled. */
  startUnit(): void;
  /** Settles that unit once; undefined is a coverage gap. Rejected before any unit started, it records nothing. */
  settle(usage?: TurnUsage): void;
}

interface CodexUsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

function zeroCodexBreakdown(): CodexUsageBreakdown {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
}

/** A `TokenUsageBreakdown` from App Server 0.155.1 (camelCase), or undefined when a required field is missing. */
function codexBreakdown(raw: unknown): CodexUsageBreakdown | undefined {
  const value = asObject(raw);
  const input = asNumber(value.inputTokens);
  const output = asNumber(value.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  const reasoning = asNumber(value.reasoningOutputTokens) ?? 0;
  return {
    inputTokens: input,
    cachedInputTokens: Math.min(asNumber(value.cachedInputTokens) ?? 0, input),
    outputTokens: output,
    reasoningOutputTokens: reasoning,
    totalTokens: asNumber(value.totalTokens) ?? input + output,
  };
}

function subtractCodexBreakdown(total: CodexUsageBreakdown, baseline: CodexUsageBreakdown): CodexUsageBreakdown {
  const minus = (a: number, b: number) => Math.max(0, a - b);
  return {
    inputTokens: minus(total.inputTokens, baseline.inputTokens),
    cachedInputTokens: minus(total.cachedInputTokens, baseline.cachedInputTokens),
    outputTokens: minus(total.outputTokens, baseline.outputTokens),
    reasoningOutputTokens: minus(total.reasoningOutputTokens, baseline.reasoningOutputTokens),
    totalTokens: minus(total.totalTokens, baseline.totalTokens),
  };
}

/**
 * Reasoning tokens are part of the output when `total = input + output`; only a total that also counts them
 * separately adds them. The measured schema carries the total, so it decides.
 */
function codexTurnUsage(delta: CodexUsageBreakdown): TurnUsage {
  const reasoningSeparate = delta.reasoningOutputTokens > 0
    && delta.totalTokens === delta.inputTokens + delta.outputTokens + delta.reasoningOutputTokens;
  const outputTokens = delta.outputTokens + (reasoningSeparate ? delta.reasoningOutputTokens : 0);
  return {
    inputTokens: delta.inputTokens,
    cachedInputTokens: Math.min(delta.cachedInputTokens, delta.inputTokens),
    outputTokens,
    ...(delta.reasoningOutputTokens > 0 ? { reasoningOutputTokens: Math.min(delta.reasoningOutputTokens, outputTokens) } : {}),
    usageBasis: 'reported',
    costBasis: 'api-equivalent',
  };
}

function commandDecision(allow: boolean, legacy: boolean, note?: string): JsonObject {
  if (!legacy) return { decision: allow ? 'accept' : 'decline' };
  return allow ? { decision: 'approved' }
    : { decision: { denied: { rejection: note || 'The user did not approve this command.' } } };
}

function fileDecision(allow: boolean, legacy: boolean, note?: string): JsonObject {
  if (!legacy) return { decision: allow ? 'accept' : 'decline' };
  return allow ? { decision: 'approved' }
    : { decision: { denied: { rejection: note || 'The user did not approve this file change.' } } };
}

function deniedPermissions(): JsonObject {
  return { permissions: {}, scope: 'turn', strictAutoReview: true };
}

function normalizeAccess(access: CodexRuntimeAccess): CodexRuntimeAccess {
  return {
    trusted: access.trusted === true,
    restricted: access.restricted === true,
    readRoots: uniquePaths(access.readRoots),
    writeRoots: uniquePaths(access.writeRoots),
  };
}

function sanitizedCodexEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe = { ...env };
  for (const key of Object.keys(safe)) {
    if (key.toUpperCase() === 'OPENAI_API_KEY' || key.toUpperCase() === 'CODEX_API_KEY') delete safe[key];
  }
  return safe;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function asStrictObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Codex dynamic tool arguments must be a JSON object.');
  }
  return value as JsonObject;
}

function codexAgentMessagePartIdentity(params: JsonObject): string | undefined {
  const item = stringValue(params.itemId) || stringValue(params.item_id) || stringValue(params.id);
  const part = stringValue(params.partId) || stringValue(params.part_id)
    || (typeof params.contentIndex === 'number' ? String(params.contentIndex) : '')
    || (typeof params.content_index === 'number' ? String(params.content_index) : '');
  return item || part ? `${item}\u0000${part}` : undefined;
}

function boundDynamicToolResult(value: string): string {
  if (value.length <= DYNAMIC_TOOL_RESULT_CHARACTERS) return value;
  return `${value.slice(0, DYNAMIC_TOOL_RESULT_CHARACTERS)}\n\n[UnodeAi truncated this tool result at 64 KiB.]`;
}

function dynamicToolResponse(success: boolean, text: string): JsonObject {
  return { success, contentItems: [{ type: 'inputText', text: boundDynamicToolResult(text) }] };
}

function stringValue(value: unknown): string { return typeof value === 'string' ? value : ''; }
function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}
function guardianActionSummary(value: unknown): string {
  const action = asObject(value);
  const type = stringValue(action.type) || 'action';
  const detail = stringValue(action.command)
    || stringValue(action.toolName)
    || stringValue(action.name)
    || stringValue(action.url)
    || stringValue(action.path);
  return detail ? `${type}: ${detail}`.slice(0, 1_000) : type;
}
function nullableStringArray(value: unknown): string[] { return value === null || value === undefined ? [] : stringArray(value); }

function uniquePaths(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))].sort(pathSort);
}

function intersectRoots(left: readonly string[], right: readonly string[]): string[] {
  const roots: string[] = [];
  for (const a of left) for (const b of right) {
    const resolvedA = path.resolve(a);
    const resolvedB = path.resolve(b);
    if (isInside(resolvedA, resolvedB)) roots.push(resolvedB);
    else if (isInside(resolvedB, resolvedA)) roots.push(resolvedA);
  }
  return uniquePaths(roots);
}

function isWithinAny(candidate: string, roots: readonly string[], base: string): boolean {
  const absolute = path.resolve(base, candidate);
  return roots.some((root) => isInside(root, absolute));
}

/**
 * Codex on Windows may report canonical extended-length paths (`\\?\C:\...`, `\\?\UNC\server\share`).
 * `path.relative` treats those as a different root from the plain drive path the host supplied, so a
 * root that is really inside the workspace would read as outside it. Strip the prefix before comparing.
 */
function normalizeWindowsPath(value: string): string {
  if (process.platform !== 'win32') return path.resolve(value);
  if (/^\\\\\?\\UNC\\/i.test(value)) return path.resolve(`\\\\${value.slice(8)}`);
  if (value.startsWith('\\\\?\\')) return path.resolve(value.slice(4));
  return path.resolve(value);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathKey(value: string): string {
  const resolved = normalizeWindowsPath(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function pathSort(a: string, b: string): number { return pathKey(a).localeCompare(pathKey(b)); }

function parseFileChanges(value: unknown): CodexFileChange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): CodexFileChange[] => {
    const change = asObject(raw);
    const kind = asObject(change.kind);
    const type = stringValue(kind.type);
    const candidatePath = stringValue(change.path);
    const diff = stringValue(change.diff);
    if (!candidatePath || !diff || (type !== 'add' && type !== 'delete' && type !== 'update')) return [];
    const movePath = kind.move_path === null ? null : stringValue(kind.move_path) || undefined;
    return [{ path: candidatePath, diff, kind: { type, ...(movePath !== undefined ? { move_path: movePath } : {}) } }];
  });
}

function legacyFileChanges(value: JsonObject | undefined): CodexFileChange[] {
  if (!value) return [];
  return Object.entries(value).flatMap(([candidatePath, raw]): CodexFileChange[] => {
    const change = asObject(raw);
    const type = stringValue(change.type);
    if (type === 'add' || type === 'delete') {
      const content = stringValue(change.content);
      return [{ path: candidatePath, diff: '', content, kind: { type } }];
    }
    if (type === 'update') {
      const diff = stringValue(change.unified_diff);
      const movePath = change.move_path === null ? null : stringValue(change.move_path) || undefined;
      if (!diff) return [];
      return [{ path: candidatePath, diff, kind: { type, ...(movePath !== undefined ? { move_path: movePath } : {}) } }];
    }
    return [];
  });
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A saved token count: a whole, non-negative, safe number, or nothing. */
function wholeTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
