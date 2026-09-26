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
} from './AgentBackend';
import { killProcessTreeByPid } from './processTree';
import { StreamJsonParser } from './StreamJsonParser';
import { estimateTokensUpper } from './TokenCounter';
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
import type { SkillRegistry } from '../skills/SkillRegistry';
import {
  createCodexSkillRoot,
  removeCodexSkillRoot,
  type CodexSkillRoot,
} from './CodexSkillRoot';
import type { ToolSpec } from './WorkspaceTools';
import { resolveMcpServerGrants, type MCPHub, type McpServerGrants } from '../mcp/MCPHub';
import { RUN_SKILL_ACTION_TOOL, type ExecutableSkillHost } from '../skills/ExecutableSkillHost';
import type { TeamMcpBridge } from '../mcp/TeamMcpBridge';
import { hostToolRefused, type HostToolOutcome } from './toolSummary';

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
  private lastAgentMessagePart: string | undefined;
  private turnUsage: TurnUsage | undefined;
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
    if (!this.started || this.stopped || !this.proc) {
      this.emit({ kind: 'error', message: 'Codex App Server is not running; cannot send turn.' });
      return;
    }
    if (this.turnId) {
      this.emit({ kind: 'error', message: 'Codex is already running a turn.' });
      return;
    }
    if (attachments?.userAttachments?.some((attachment) => attachment.kind === 'pdf')) {
      this.failTurn('Local PDF attachments require an OpenAI-compatible agent in this release; Codex CLI did not receive PDF bytes.');
      return;
    }
    void this.runTurn(instruction, attachments);
  }

  async stop(): Promise<void> {
    const wasLive = !!this.proc || this.started || this.starting;
    this.stopped = true;
    this.started = false;
    this.starting = false;
    this.rejectPending(new Error('Codex App Server stopped.'));
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
    return this.threadId ? {
      version: 1,
      messages: [{
        codexThreadId: this.threadId,
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
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => this.consume(chunk));
    proc.stderr?.on('data', (chunk: string) => {
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
    this.turnUsage = undefined;
    this.completedReviewRationales.clear();
    this.activeAttachments = attachments;
    this.managedToolAbortController = new AbortController();
    this.deps?.teamMcpBridge?.beginTurnContentReceipts?.();
    this.deps?.teamMcpBridge?.setDelegationContentSources?.(attachments?.delegationContentSources);
    try {
      const access = this.turnAccess(attachments?.taskWorkspaceAccess);
      if (!access.trusted || access.readRoots.length === 0) {
        throw new Error('Codex turn was blocked because its current Workspace Trust or Folder Access grants no access.');
      }
      const policy = this.sandboxPolicy(access);
      const profile = this.resolvedProfile(access, attachments?.mode ?? 'act');
      const settings = codexProtocolPermissionSettings(profile);
      const threadId = await this.ensureThread(access, policy);
      this.emit({ kind: 'model_request' });
      const response = asObject(await this.request('turn/start', {
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
      }));
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
      pending.reject(new Error(String(error.message ?? 'Codex App Server request failed.')));
    } else pending.resolve(message.result);
  }

  private async handleServerRequest(id: JsonRpcId, method: string, rawParams: unknown): Promise<void> {
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
    return JSON.stringify({ team: !!this.deps?.teamMcpBridge, mcpTools, executableSkills: !!this.deps?.executableSkills?.toolSpec() });
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
    this.emit({ kind: 'tool_use', name: tool, input: args });
    let outcome: HostToolOutcome | undefined;
    let output: string;
    let structuralOk: boolean | undefined;
    if (this.activeAttachments?.mode === 'plan' && tool !== 'list_agents') {
      outcome = hostToolRefused(`${tool} is unavailable in Plan mode.`, 'capability');
      output = outcome.output;
    } else if (tool === RUN_SKILL_ACTION_TOOL && this.deps?.executableSkills?.toolSpec()) {
      const result = await this.deps.executableSkills.run(args);
      outcome = result;
      output = result.output;
      structuralOk = result.status === 'success';
    } else if (this.deps?.teamMcpBridge && (await this.deps.teamMcpBridge.listTools()).some((item) => item.name === tool)) {
      output = await this.deps.teamMcpBridge.callTool(tool, args);
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
    const ok = structuralOk ?? (outcome ? outcome.status === 'success' : !/^Error:/i.test(bounded));
    const failureKind = outcome?.status === 'failed'
      ? outcome.failureKind
      : outcome?.status === 'refused' ? 'blocked' as const : undefined;
    this.emit({ kind: 'tool_result', name: tool, ok, summary: bounded.slice(0, 500), detail: bounded, failureKind });
    return dynamicToolResponse(ok, bounded);
  }

  private async commandApproval(params: JsonObject, legacy: boolean): Promise<JsonObject> {
    const transportedCommand = legacy
      ? stringArray(params.command).join(' ')
      : typeof params.command === 'string' ? params.command : '';
    const actions = Array.isArray(params.commandActions) ? params.commandActions.map(asObject) : [];
    const actionCommands = actions.map((action) => stringValue(action.command)).filter(Boolean);
    const command = codexCommandForPolicy(transportedCommand, actionCommands);
    if (!command) throw new Error('Codex command approval had no command.');
    if (!this.usesUserApprovalProfile()) return commandDecision(false, legacy, 'No host approval card is available in this profile.');
    if (!this.hostAllowsCommand()) return commandDecision(false, legacy, 'Blocked by UnodeAi host policy.');
    const verdict = this.deps?.commandPolicy?.check(command);
    if (verdict?.allowed) return commandDecision(true, legacy);
    const allowlistCard = this.deps?.commandPolicy?.approvalMode === 'allowlist'
      && !/blocked destructive pattern/i.test(verdict?.reason ?? '');
    if (verdict && !verdict.ask && !allowlistCard) {
      return commandDecision(false, legacy, verdict.reason || 'Blocked by UnodeAi command policy.');
    }
    const decision = await this.askUser({
      kind: 'command', title: 'Codex command',
      detail: [command, typeof params.cwd === 'string' ? `Working directory: ${params.cwd}` : '', stringValue(params.reason)].filter(Boolean).join('\n\n'),
      command, timeoutMs: this.approvalTimeoutMs(),
    });
    return commandDecision(decision.allow, legacy, decision.note);
  }

  private async fileApproval(params: JsonObject, legacy: boolean): Promise<JsonObject> {
    const access = this.currentAccess();
    const fileChanges = legacy ? asObject(params.fileChanges) : undefined;
    const itemId = stringValue(params.itemId);
    const changes = legacy
      ? legacyFileChanges(fileChanges)
      : itemId ? this.pendingFileChanges.get(itemId) ?? [] : [];
    if (!this.usesUserApprovalProfile()) return fileDecision(false, legacy, 'No host approval card is available in this profile.');
    const explicitPaths = changes.flatMap((change) => [change.path, change.kind.move_path].filter((value): value is string => !!value));
    if (explicitPaths.length === 0) throw new Error('Codex file approval had no checkpointable changed files.');
    const pathsAllowed = explicitPaths.every((candidate) => isWithinAny(candidate, access.writeRoots, this.workspaceRoot));
    if (!this.hostAllowsWrite() || !pathsAllowed) return fileDecision(false, legacy, 'Blocked by UnodeAi host policy.');
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
      if (!decision.allow) return fileDecision(false, legacy, decision.note);
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

  private hostAllowsCommand(): boolean {
    const access = this.currentAccess();
    return access.trusted && !access.restricted
      && this.activeAttachments?.mode !== 'plan' && !this.activeAttachments?.taskWorkspaceAccess;
  }

  private hostAllowsWrite(): boolean {
    const access = this.currentAccess();
    return access.trusted && access.writeRoots.length > 0 && this.activeAttachments?.mode !== 'plan';
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
    this.emit({ kind: 'host_wait', phase: 'started', waitingOn: 'your approval' });
    try {
      return await Promise.race([
        this.deps.requestApproval(request).catch(() => ({ allow: false })),
        new Promise<CodexApprovalDecision>((resolve) => {
          timer = setTimeout(() => resolve({ allow: false, note: 'The approval window expired.' }), request.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.emit({ kind: 'host_wait', phase: 'completed', waitingOn: 'your approval' });
    }
  }

  private approvalTimeoutMs(): number {
    const configured = this.deps?.approvalTimeoutMs;
    return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? configured : CODEX_APPROVAL_TIMEOUT_MS;
  }

  private respond(id: JsonRpcId, result: unknown): void { this.write({ jsonrpc: '2.0', id, result }); }

  private handleNotification(method: string, rawParams: unknown): void {
    const params = asObject(rawParams);
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
      this.turnUsage = codexUsage(params.tokenUsage ?? params.usage ?? params); return;
    }
    if (method === 'turn/completed') {
      const turn = asObject(params.turn);
      const failed = turn.status === 'failed';
      const failure = failed ? String(asObject(turn.error).message ?? 'Codex turn failed.') : '';
      if (failure && !this.turnText) this.turnText = failure;
      const publishedDelivery = this.deps?.teamMcpBridge?.takePublishedTurnDelivery?.();
      const resultText = publishedDelivery?.text ?? this.turnText;
      const footer = this.deps?.teamMcpBridge?.turnDelegationFooter?.();
      if (footer) this.emit({ kind: 'delegation_receipt', text: footer });
      this.emit({
        kind: 'turn_complete',
        result: { text: resultText, isError: failed, usage: this.turnUsage ?? estimatedUsage(resultText) },
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
    if (item.type === 'agentMessage' && completed && !this.turnText) {
      const text = stringValue(item.text);
      if (text) { this.turnText = text; this.emit({ kind: 'assistant', text }); }
      return;
    }
    if (item.type === 'mcpToolCall') {
      const status = item.status === 'completed' || item.status === 'failed' ? item.status : 'inProgress';
      this.emit({
        kind: 'native_mcp_activity',
        server: stringValue(item.server) || 'unknown server',
        tool: stringValue(item.tool) || 'unknown tool',
        status,
      });
      return;
    }
    if (item.type === 'commandExecution') {
      const name = 'command_execution';
      if (!completed) this.emit({ kind: 'tool_use', name, input: { command: stringValue(item.command) } });
      else {
        const exitCode = typeof item.exitCode === 'number' ? item.exitCode : 1;
        const detail = stringValue(item.aggregatedOutput);
        this.emit({ kind: 'tool_result', name, ok: exitCode === 0, summary: detail.slice(0, 500) || `exit ${exitCode}`, detail });
      }
      return;
    }
    if (item.type === 'fileChange') {
      const itemId = stringValue(item.id);
      if (!completed) {
        const changes = parseFileChanges(item.changes);
        if (itemId && changes.length > 0) this.pendingFileChanges.set(itemId, changes);
        this.emit({ kind: 'tool_use', name: 'file_change', input: { changes: item.changes } });
      }
      else {
        if (itemId) this.pendingFileChanges.delete(itemId);
        const ok = item.status === 'completed';
        this.emit({ kind: 'tool_result', name: 'file_change', ok, summary: ok ? 'File change applied.' : `File change ${String(item.status)}.` });
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
    this.emit({
      kind: 'turn_complete',
      result: { text: this.turnText || message, isError: true, usage: estimatedUsage(this.turnText || message) },
    });
    this.turnId = undefined;
    this.activeAttachments = undefined;
    this.pendingFileChanges.clear();
  }

  private emit(event: BackendEvent): void { this.handlers.forEach((handler) => handler(event)); }
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

function codexUsage(raw: unknown): TurnUsage | undefined {
  const usage = asObject(raw);
  const input = asNumber(usage.inputTokens ?? usage.input_tokens ?? usage.totalInputTokens);
  const output = asNumber(usage.outputTokens ?? usage.output_tokens ?? usage.totalOutputTokens);
  if (input === undefined || output === undefined) return undefined;
  const cached = asNumber(usage.cachedInputTokens ?? usage.cached_input_tokens);
  const reasoning = asNumber(usage.reasoningOutputTokens ?? usage.reasoning_output_tokens) ?? 0;
  return { inputTokens: input, cachedInputTokens: cached, outputTokens: output + reasoning, costBasis: 'api-equivalent' };
}

function estimatedUsage(text: string): TurnUsage {
  return { inputTokens: estimateTokensUpper(text), outputTokens: estimateTokensUpper(text), estimated: true, costBasis: 'api-equivalent' };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
