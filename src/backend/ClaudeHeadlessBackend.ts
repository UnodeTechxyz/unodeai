/*---------------------------------------------------------------------------------------------
 *  UnodeAi - ClaudeHeadlessBackend
 *  Runs an agent as a persistent `claude` process in stream-json mode.
 *
 *  Invocation:
 *    claude -p --output-format stream-json --input-format stream-json --verbose
 *           --model <model> --permission-mode <mode>
 *
 *  We talk to it over stdio: each user turn is one NDJSON line on stdin; the agent streams
 *  back NDJSON events (system/assistant/result) on stdout, which we normalize to BackendEvents.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn as nodeSpawn } from 'child_process';
import type { ServerResponse } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentConfig, AgentModelParams } from '../types';
import {
  AgentBackend,
  BackendEvent,
  BackendEventHandler,
  EgressConsentGate,
  TurnAttachments,
  TurnResult,
} from './AgentBackend';
import { StreamJsonParser } from './StreamJsonParser';
import {
  buildTeamBridgeConfig,
  ClaudeMcpConfig,
  ClaudeMcpServerSpec,
  FILES_BRIDGE_SERVER_ID,
  PERMISSION_SERVER_ID,
  TEAM_BRIDGE_SERVER_ID,
} from '../mcp/ClaudeMcpConfig';
import { createLocalMcpServer, LocalMcpServer, LocalMcpTool } from '../mcp/LocalMcpServer';
import { TeamMcpBridge } from '../mcp/TeamMcpBridge';
import { CommandPolicy } from './CommandPolicy';
import { resolveExecutionHooks, type ExecutionHooksSource } from './ExecutionHooks';
import type { VerificationPlan } from './VerificationPlan';
import { CommandApprover, WorkspaceTools } from './WorkspaceTools';
import { CLAUDE_SHELL_TOOLS, decideCommandPermission, PERMISSION_TOOL_NAME } from './commandPermission';
import { projectContextBlock, replaceProjectContextBlock } from '../session/RulesFile';
import { formatUserTextAttachments, splitUserAttachments } from '../attachments';
import { SkillRegistry } from '../skills/SkillRegistry';
import { resolveWebAccessPolicy, WebAccessPolicyGate, WEB_ACCESS_HUMAN_WINDOW_MS } from './WebAccessPolicy';
import { CheckpointRestoreDisabledReason } from './Checkpoints';
import { beforeStateForWrite, parseClaudeEditIntent, reconstructBeforeFromEdit, ClaudeEditIntent } from './claudeCheckpointEvents';
import { hostAuthoredCloseout, type StreamReadBudget } from './OpenAICompatBackend';
import type { ContentAssetStore } from '../content/ContentAssetStore';
import type { ContentReceiptObservation } from '../content/ContentReceipt';
import { formatTaskAttemptCard, type TaskAttemptCard, type TaskInputResolver } from './TaskContract';
import type { MessageBus } from '../bus/MessageBus';

/** Relative, space-free path for the MCP config we hand claude (safe for shell-spawn on Windows).
 *  Lives under .unode/ — which is gitignored — so a leftover (e.g. after an abnormal exit) carrying the
 *  local team-bridge token can never be accidentally committed. Forward slash works for the CLI arg on
 *  every platform. */
const MCP_CONFIG_FILE = '.unode/mcp.json';
const TOOL_GATE_SETTINGS_FILE = '.unode/claude-tool-gate.json';
const TOOL_GATE_WRAPPER_FILE = process.platform === 'win32'
  ? '.unode/claude-tool-gate.cmd'
  : '.unode/claude-tool-gate.sh';
const CLAUDE_WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'];
/** Tools that mutate filesystem state or create effects outside the current local turn. Denied only when
 *  the user scoped this agent to no-write/read-only (or the workspace is untrusted), never for a normal
 *  trusted write+execute agent. */
const CLAUDE_SCOPE_BREAKING_TOOLS = [
  'EnterWorktree',
  'ExitWorktree',
  'Artifact',
  'CronCreate',
  'CronDelete',
  'RemoteTrigger',
  'PushNotification',
  'ScheduleWakeup',
  'SendMessage',
  // These currently appear in Claude's native advertised surface, but a no-write connection's host
  // policy will refuse their stateful task/monitor effects. Remove them at launch instead of burning a
  // model turn on an offered-then-refused tool (FA-2).
  'Monitor',
  'TaskCreate',
];
const CLAUDE_NATIVE_SUBAGENT_TOOLS = ['Agent', 'Workflow'];
/** `--disallowedTools` is a name filter, not a full capability sandbox. In no-write scopes, also remove
 *  Claude's native delegation/discovery tools that can dynamically reach worktree/external-effect tools
 *  despite the direct names above being denied. Normal trusted write+execute agents keep these tools. */
const CLAUDE_NO_WRITE_ESCAPE_TOOLS = [...CLAUDE_NATIVE_SUBAGENT_TOOLS, 'ToolSearch'];
const UNMEDIATED_SUBAGENT_TOOLS = new Set(CLAUDE_NATIVE_SUBAGENT_TOOLS.map((tool) => tool.toLowerCase()));
const TEAM_BRIDGE_TOOL_NAMES = [
  'list_agents', 'dispatch_task', 'collect_ready_tasks', 'inspect_task_status', 'record_task_disposition', 'close_assignment',
  'delegation_metrics', 'broadcast', 'run_checks', 'publish_content_receipt',
];
const FILES_BRIDGE_TOOL_NAMES = [
  'read_file', 'list_dir', 'search_files', 'read_extracted_content', 'search_extracted_content',
  'report_context_gap', 'publish_task_artifact', 'select_workflow_branch',
];
const CONVERSATION_LOG_BRIDGE_TOOL_NAMES = ['search_conversation_log', 'read_conversation_log'];
// Windows runs the npm-installed `claude.cmd` through cmd.exe. These are the only argv values that
// originate outside this module, so reject shell metacharacters before creating bridges or spawning it.
const SAFE_CLAUDE_CMD_ARGUMENT = /^[a-zA-Z0-9._:/\\-]+$/;
const CLAUDE_HOOK_READ_TOOLS = new Set([
  'read', 'glob', 'grep', 'taskoutput', 'taskstop', 'reportfindings', 'skill', 'toolsearch',
  // Native delegation is allowed. Its child tool calls are independently mediated by this hook.
  'agent', 'workflow',
]);
/** Exact Claude names for `--disallowedTools`, permission rules, and hook matchers. */
const CLAUDE_NETWORK_READ_TOOL_NAMES = ['WebSearch', 'WebFetch'] as const;
/** Native public-web reads are a separate egress axis, never a filesystem-write capability. */
const CLAUDE_NETWORK_READ_TOOLS = new Set(CLAUDE_NETWORK_READ_TOOL_NAMES.map((tool) => tool.toLowerCase()));
const TOOL_GATE_HEARTBEAT_MS = 1_000;
/** A CLI can legitimately be quiet while reading, but the field round's 4000s silent worker was not
 * operationally acceptable. This is deliberately independent of gateway stream deadlines. */
const DEFAULT_CLAUDE_IDLE_WATCHDOG_MS = 15 * 60_000;
/** Gives Claude's seconds-valued hook timeout a small margin beyond our bounded human decision window. */
const TOOL_GATE_CLAUDE_TIMEOUT_SECONDS = Math.ceil(WEB_ACCESS_HUMAN_WINDOW_MS / 1000) + 10;
const CLAUDE_EXTERNAL_EFFECT_TOOLS = new Set([
  'artifact', 'croncreate', 'crondelete', 'remotetrigger', 'pushnotification', 'schedulewakeup',
  'sendmessage', 'enterworktree', 'exitworktree',
]);
const UNODE_LOCAL_MCP_TOOL_PREFIXES = [
  'mcp__unode_team_bridge__',
  'mcp__unode_permission__',
  'mcp__unode_files__',
];

export interface ClaudeToolApprovalRequest {
  toolName: string;
  /** Concise, user-facing description of the effect about to be allowed. */
  detail: string;
  input: Record<string, unknown>;
  /** Bounded human window for hook-mediated approvals. */
  timeoutMs?: number;
}

export interface ClaudeToolApprovalDecision {
  allow: boolean;
  /** Remember an allow/deny answer for this tool for the current agent session. */
  remember?: boolean;
  note?: string;
}

export interface ClaudeHeadlessBackendDeps {
  /** Human-applied restrictive hooks; never populated from the workspace or a model tool call. */
  executionHooks?: ExecutionHooksSource;
  /** Matches the in-process engine's bounded verify/no-op continuation policy. */
  verifyObligation?: boolean;
  /** Egress consent gate: called before the `claude` CLI (which contacts Anthropic / the configured
   *  gateway) is spawned. It acknowledges an opened human decision before awaiting it, so the session
   *  can surface a first-class consent-required state rather than remain silently starting. If it throws,
   *  the process is not started and nothing is sent. Undefined = no gate. */
  onBeforeEgress?: EgressConsentGate;
  /** Load-bearing route assertion, invoked before the Claude model process is spawned. */
  assertResolvedRoute?: () => void;
  localMcpServerFactory?: () => LocalMcpServer;
  teamMcpBridge?: TeamMcpBridge;
  spawn?: typeof nodeSpawn;
  /** Extra READ-only roots for Claude, exposed only through the Unode-enforced files MCP bridge. */
  additionalReadRoots?: string[];
  /** Same expiring user-source store used by in-process delegates. */
  delegationContentAssets?: ContentAssetStore;
  /** Attempt-bound input grants used by the read-only files bridge. */
  taskInputResolver?: TaskInputResolver;
  /** Agent-scoped Activity projection for the read-only conversation-log MCP tools. */
  messageBus?: MessageBus;
  /** Bounded content facts from the files bridge, for run evidence; never source content or queries. */
  onContentReceipt?: (receipt: ContentReceiptObservation) => void;
  /** Writable roots for Folder Access. Undefined preserves legacy cwd-write behavior. */
  writeRoots?: string[];
  /** Explicit Folder Access cannot safely expose an unrestricted child-process shell. */
  restrictShell?: boolean;
  /** Extension-owned skill registry. It is never mounted into the user's workspace or ~/.claude. */
  skillRegistry?: SkillRegistry;
  /** Called when Claude uses a native subagent tool that v0.9.26 can detect but not mediate. */
  onUnmediatedToolUse?: (tool: string, agentName: string) => void;
  /** Command-approval gate so a Claude agent's shell commands honor unode.commandApproval (the approval
   *  card) — wired into claude via --permission-prompt-tool. Absent → no gating (legacy behavior). */
  commandPermission?: {
    policy?: CommandPolicy;
    /** Approver bound to THIS agent's name (so the card says e.g. "Senior Developer wants to run …"). */
    requestApproval?: CommandApprover;
    /** Live Workspace Trust check; when it returns false, shell commands are hard-denied (untrusted workspace). */
    isTrusted?: () => boolean;
    /** Server factory for the per-agent permission server; defaults to createLocalMcpServer (injectable for tests). */
    createServer?: () => LocalMcpServer;
  };
  /** Factory for the agent-local, bearer-authenticated PreToolUse callback server. */
  toolGateServerFactory?: () => LocalMcpServer;
  /** User-facing approval for native Claude external-effect and newly discovered tools. */
  requestToolApproval?: (request: ClaudeToolApprovalRequest) => Promise<ClaudeToolApprovalDecision>;
  /** Read live so toggling unode.writeApproval affects already-running Claude agents. */
  writeApprovalAsk?: () => boolean;
  /** Existing write-approval card, used when Claude's native Write/Edit tool is about to run. */
  requestWriteApproval?: (request: { path: string; before: string | null; after: string }) => Promise<'once' | 'always' | 'deny'>;
  /** Test-only override; production resolves the shipped out/claudeToolGate.cjs runtime asset. */
  toolGateScriptPath?: string;
  /** Route-neutral public-web policy. The same host object is used by gateway `fetch_url`. */
  webAccess?: WebAccessPolicyGate;
  /** Test-only bound for human decisions behind the PreToolUse hook. */
  humanApprovalTimeoutMs?: number;
  /** Test seam for the CLI idle trigger. Production uses the path-specific watchdog threshold. */
  idleWatchdogMs?: number;
  /**
   * Read deadlines for one Claude CLI turn. This deliberately reuses the OpenAI-compatible stream
   * vocabulary: before the first material output use `firstChunkMs`; afterwards use `idleMs`.
   */
  streamReadBudget?: Pick<StreamReadBudget, 'firstChunkMs' | 'idleMs'>;
  /** Host-owned checkpoint persistence for Claude's native file tools. */
  recordCheckpoint?: (entry: {
    agentId: string;
    path: string;
    before: string | null;
    after: string;
    restoreDisabledReason?: CheckpointRestoreDisabledReason;
  }) => void;
  /** Test seam for the post-result file read. It is never called while a tool is merely announced. */
  readAfterFile?: (absolutePath: string) => string;
}

interface PendingClaudeCheckpoint {
  intent: ClaudeEditIntent;
  /** For Write only: existence is safe to observe; file content is never read before the CLI writes. */
  existedBefore?: boolean;
}

export class ClaudeHeadlessBackend implements AgentBackend {
  public readonly agentId: string;

  private proc: ChildProcess | undefined;
  /** Stop may arrive while egress consent is still open, before a child process exists. */
  private startCancelled = false;
  private parser = new StreamJsonParser();
  /** Stream-json callbacks are synchronous, but host hook points are async. Serialize them so a PostWrite
   * decision is observed before a later native tool request or terminal result from the same CLI turn. */
  private eventChain: Promise<void> = Promise.resolve();
  private handlers = new Set<BackendEventHandler>();
  private firstTurnSent = false;
  private readyEmitted = false;
  private mcpConfigPath: string | undefined;
  private localMcpServer: LocalMcpServer | undefined;
  private permissionServer: LocalMcpServer | undefined;
  private filesBridgeServer: LocalMcpServer | undefined;
  /** The files MCP bridge persists for one Claude process; its exact-search cache resets per turn. */
  private filesBridgeTools: WorkspaceTools | undefined;
  /** Always-on loopback endpoint called by Claude's inherited PreToolUse hook. */
  private toolGateServer: LocalMcpServer | undefined;
  private toolGateSettingsPath: string | undefined;
  private toolGateWrapperPath: string | undefined;
  /** The CLI cannot change its advertised tools after spawn. Capture this set once per start. */
  private launchDisallowedNativeTools: readonly string[] | undefined;
  private readonly rememberedToolDecisions = new Map<string, ClaudeToolApprovalDecision>();
  /** Per-agent temporary Claude plugin; deleted with the child process. */
  private skillPluginDirectory: string | undefined;
  /** Plugin manifest name paired with skillPluginDirectory for namespaced skill invocation. */
  private skillPluginName: string | undefined;
  private toolUseNames = new Map<string, string>();
  /** Native Read intents are receipts only after the matching successful tool_result arrives. */
  private toolUseReadPaths = new Map<string, string>();
  /** Native edit intents held until Claude reports their successful result. */
  private pendingCheckpoints = new Map<string, PendingClaudeCheckpoint>();
  /** tool_use id -> shell command. Its tool_result records a host-observed command-exit-zero sensor;
   *  a declared verification plan decides whether that sensor applies to a delegation. */
  private toolUseCommands = new Map<string, string>();
  private unmediatedToolUseReported = false;
  private costBasis: 'billed' | 'api-equivalent' = 'api-equivalent';
  /** Claude native tools are observable in the stream: Write/Edit paths are recorded as changed files,
   *  run_checks results give objective verification, and only mutating shell commands count as unrecorded. */
  private turnEvidence: {
    hadToolActions: boolean;
    unrecordedWrites?: boolean;
    changedFiles: Set<string>;
    verification: { ran: boolean; passed: boolean; source?: 'run-checks' | 'command-exit-zero' };
  } = { hadToolActions: false, changedFiles: new Set(), verification: { ran: false, passed: false } };
  private activeVerificationPlan: VerificationPlan | undefined;
  private activeTaskAttempt?: TaskAttemptCard;
  /** A post-action hook cannot undo a completed native write, but it must stop later tool use and closeout. */
  private hostHookBlockReason: string | undefined;
  /** Text emitted after a host receipt is issued. Hold it until publication either replaces or releases it. */
  private deferredReceiptAssistantText = '';
  private deferredReceiptAssistantDeltas = '';
  /** A host receipt was issued this turn, so later prose may be superseded by publish_content_receipt. */
  private mayPublishContentReceipt = false;
  /** The first material output and each later material output get distinct budgets. Arbitrary CLI bytes,
   * status narration, and stderr do not keep a wedged turn alive. */
  private turnWatchdogActive = false;
  private firstMaterialOutputSeen = false;
  private lastMaterialOutputAt = 0;
  private idleWatchdogTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param mcpConfig optional claude-native MCP config; when present we write it to a relative
   *        `.unode-mcp.json` in the agent cwd and pass `--mcp-config`. claude hosts the servers
   *        itself (we do NOT use the in-process MCPHub for claude agents).
   * @param resolvedParams optional resolved model params (F2). claude's params are set at spawn, so
   *        only fields with a CLI flag apply: `reasoning_effort` → `--effort`. The rest are ignored
   *        (no flags exist — see PRD F1 backend matrix). `--json-schema` needs a concrete schema, so
   *        response_format:json_object is intentionally NOT mapped here (deferred).
   */
  constructor(
    private config: AgentConfig,
    private mcpConfig?: ClaudeMcpConfig,
    private resolvedParams?: AgentModelParams,
    private deps: ClaudeHeadlessBackendDeps = {}
  ) {
    this.agentId = config.id;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  onEvent(handler: BackendEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async start(env: NodeJS.ProcessEnv): Promise<void> {
    if (this.proc) {
      return;
    }
    this.launchDisallowedNativeTools = undefined;
    this.startCancelled = false;
    this.costBasis = env.ANTHROPIC_API_KEY ? 'billed' : 'api-equivalent';
    const writeRoots = this.deps.writeRoots;
    if (writeRoots && writeRoots.length > 1) {
      throw new Error('Claude Headless supports a single writable folder. Split this agent, or switch it to a local OpenAI-compatible model.');
    }
    this.assertSafeCliArguments();
    const toolGateScript = this.assertToolGateScript();
    // Egress consent: before the claude CLI (which reaches Anthropic / the configured gateway) is spawned,
    // obtain the user's one-time consent for the destination host. Throws → nothing is spawned or sent.
    this.deps.assertResolvedRoute?.();
    if (this.deps.onBeforeEgress) {
      await this.deps.onBeforeEgress((pending) => {
        this.emit({ kind: 'consent_required', message: pending.message });
      });
    }
    // A stop while a VS Code consent modal was open cannot dismiss that modal programmatically.
    // Do not spawn Claude after the eventual answer: the owner has already cancelled this start.
    if (this.startCancelled) {
      throw new Error('Claude start was cancelled before egress consent completed.');
    }

    // `--disallowedTools` is static for this Claude process. Snapshot the shared web-policy table at the
    // start boundary; a later setting change still reaches the fail-closed PreToolUse policy below.
    this.launchDisallowedNativeTools = this.disallowedNativeTools();

    const cwd = this.config.workingDirectory || process.cwd();
    await this.prepareToolGate(cwd, toolGateScript);
    let args: string[];
    try {
      const mcpConfig = await this.prepareMcpConfig(cwd);
      this.writeMcpConfig(cwd, mcpConfig);
      this.prepareSkillPlugin();
      // If an MCP config was built but couldn't be written (e.g. unwritable cwd), claude won't know about our
      // local servers — so stop them (don't leak a loopback server) and don't reference them. buildArgs()
      // keys --mcp-config off mcpConfigPath and --permission-prompt-tool off permissionServer (now cleared),
      // so neither dangling flag is emitted.
      if (mcpConfig && !this.mcpConfigPath) {
        await this.stopMcpServers();
      }
      args = this.buildArgs();
    } catch (error) {
      // A bridge/plugin/settings preparation failure happens before the child process exists, so it has no
      // exit handler to tear down the already-started fail-closed endpoint.
      this.cleanupMcpConfig();
      this.cleanupToolGateSettings();
      this.cleanupSkillPlugin();
      await this.stopLocalMcpServer();
      throw error;
    }

    // On Windows the global `claude` is a `.cmd` shim, which Node (post CVE-2024-27980) won't launch
    // directly. We keep the historically-working `shell:true` form (the two shell-free alternatives
    // both prevented claude from starting on Windows). The DEP0190 "args + shell" deprecation is
    // cosmetic here: variable argv values are validated to a command-safe character set before any
    // bridge is started; the long role/system prompt is folded into the first user turn (see
    // sendUserTurn), never the argv.
    const useShell = process.platform === 'win32';
    const spawn = this.deps.spawn ?? nodeSpawn;
    try {
      const proc: ChildProcess = spawn(useShell ? 'claude.cmd' : 'claude', args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: useShell,
      });
      this.proc = proc;

      proc.stdout?.setEncoding('utf8');
      proc.stderr?.setEncoding('utf8');

      proc.stdout?.on('data', (chunk: string) => this.consumeStdout(chunk));

      proc.stderr?.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.trim()) {
            this.emit({ kind: 'log', stream: 'stderr', line: line.trim() });
          }
        }
      });

      proc.on('error', (err: Error) => {
        this.emit({ kind: 'error', message: err.message });
      });

      proc.on('exit', (code: number | null) => {
        this.endTurnWatchdog();
        const tail = this.parser.flush();
        tail.objects.forEach((o) => this.enqueueEvent(o));
        // The terminal result can itself await EndTurn. Do not clear its tool maps or emit `exit` ahead of
        // that ordered hook work merely because the child closed stdout first.
        void this.eventChain.finally(() => {
          this.proc = undefined;
          this.firstTurnSent = false;
          this.readyEmitted = false;
          this.toolUseNames.clear();
          this.toolUseCommands.clear();
          this.cleanupMcpConfig();
          this.cleanupToolGateSettings();
          this.cleanupSkillPlugin();
          void this.stopLocalMcpServer();
          this.emit({ kind: 'exit', code });
        });
      });

      await new Promise<void>((resolve, reject) => {
        proc.once('spawn', () => {
          // `claude -p` block-buffers stdout, so its system/init line doesn't flush until it has
          // received a turn to work on. SessionManager gates the first turn on `ready`, so waiting
          // for init here would deadlock (it waits for input; we wait for init). The process is able
          // to accept a turn the moment it spawns — that's what `ready` means — so emit it now and
          // treat the later system/init purely as metadata enrichment.
          this.emitReady(this.config.model);
          resolve();
        });
        proc.once('error', (err) => reject(err));
      });
    } catch (err) {
      // Spawn failed (e.g. missing/broken claude binary): the 'exit' handler won't fire, so the local
      // permission/team-bridge servers we started above + the .unode/mcp.json we wrote would leak. Clean up
      // explicitly, then rethrow so SessionManager sees the failed start. (Pre-0.8.79 this leaked only the
      // PM bridge; now it would leak a permission server for every non-autoApprove Claude agent.)
      this.proc = undefined;
      this.cleanupMcpConfig();
      this.cleanupToolGateSettings();
      this.cleanupSkillPlugin();
      await this.stopLocalMcpServer();
      throw err;
    }
  }

  /** Emit `ready` exactly once per process lifetime (deduping spawn vs system/init). */
  private emitReady(model?: string, backendSessionId?: string): void {
    if (this.readyEmitted) {
      return;
    }
    this.readyEmitted = true;
    this.emit({ kind: 'ready', model, backendSessionId });
  }

  sendUserTurn(instruction: string, attachments?: TurnAttachments): void {
    this.activeVerificationPlan = attachments?.verificationPlan;
    this.activeTaskAttempt = attachments?.taskAttempt;
    this.hostHookBlockReason = undefined;
    this.deferredReceiptAssistantText = '';
    this.deferredReceiptAssistantDeltas = '';
    this.mayPublishContentReceipt = false;
    this.filesBridgeTools?.beginTurn();
    this.filesBridgeTools?.setWorkflowBranchLabels(attachments?.workflowBranchLabels);
    this.deps.teamMcpBridge?.beginTurnContentReceipts?.();
    this.deps.teamMcpBridge?.setDelegationContentSources?.(attachments?.delegationContentSources);
    this.filesBridgeTools?.setDelegationContentSources(attachments?.delegationContentSources);
    this.filesBridgeTools?.setTaskAttempt(attachments?.taskAttempt);
    if (attachments?.userAttachments?.some((attachment) => attachment.kind === 'pdf')) {
      const message = 'Local PDF attachments require an OpenAI-compatible agent in this release; the Claude CLI backend did not receive PDF bytes.';
      this.emit({ kind: 'error', message });
      this.emit({ kind: 'turn_complete', result: { text: message, isError: true } });
      return;
    }
    this.beginTurnWatchdog();
    this.writeTurn(instruction, attachments);
  }

  /** Send one already-authorized continuation without resetting the coordinator nudge budget. */
  private writeTurn(instruction: string, attachments?: TurnAttachments, preserveEvidence = false): void {
    if (!this.proc?.stdin) {
      this.endTurnWatchdog();
      this.emit({ kind: 'error', message: 'Agent process is not running; cannot send turn.' });
      return;
    }

    if (!preserveEvidence) {
      this.turnEvidence = { hadToolActions: false, changedFiles: new Set(), verification: { ran: false, passed: false } };
    }

    const text = this.composeTurnText(instruction, attachments);
    // Images ride as Anthropic image content blocks so the claude CLI sees them natively; when there are
    // none, keep the plain string content (the common case). Text-file attachments are already inlined
    // into `text` by composeTurnText.
    const images = splitUserAttachments(attachments?.userAttachments).images;
    const content = images.length === 0
      ? text
      : [
          { type: 'text', text },
          ...images.map((image) => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mime, data: image.dataBase64 },
          })),
        ];
    const turn = {
      type: 'user',
      message: { role: 'user', content },
    };

    // Phase A observation: each stream-json user packet opens one Claude provider request. This has no
    // effect on the watchdog, turn lifecycle, or the bytes sent to the CLI.
    this.emit({ kind: 'model_request' });
    this.proc.stdin.write(JSON.stringify(turn) + '\n');
  }

  async stop(forceTimeoutMs = 10000): Promise<void> {
    this.startCancelled = true;
    this.endTurnWatchdog();
    const proc = this.proc;
    if (!proc || proc.pid === undefined) {
      return;
    }

    await new Promise<void>((resolve) => {
      const force = setTimeout(() => this.killTree(proc.pid!), forceTimeoutMs);
      proc.once('exit', () => {
        clearTimeout(force);
        resolve();
      });

      // End stdin first so the agent can finish the current turn, then signal.
      try {
        proc.stdin?.end();
      } catch {
        /* stdin may already be closed */
      }
      proc.kill('SIGTERM');
    });
    await this.stopLocalMcpServer();
  }

  abort(): void {
    this.emit({
      kind: 'log',
      stream: 'stderr',
      line: 'Interrupt requested, but Claude per-turn cancellation is not available in v0.2.0; leaving the process running.',
    });
  }

  /** Update the model for the next spawn. Claude's model is fixed at process start (--model), so this
   *  takes effect when the agent is next restarted, not mid-session. */
  setModel(model: string): void {
    if (model) {
      this.config.model = model;
    }
  }

  isAlive(): boolean {
    return this.proc !== undefined && this.proc.exitCode === null;
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private buildArgs(): string[] {
    const disallowedTools = this.launchDisallowedNativeTools ?? this.disallowedNativeTools();
    const mode = disallowedTools.length > 0 ? 'acceptEdits' : (this.config.autoApprove ? 'bypassPermissions' : 'acceptEdits');
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--input-format', 'stream-json',
      '--verbose',
      '--permission-mode', mode,
    ];
    // This settings file declares the matcher '*' PreToolUse hook. It is written by prepareToolGate
    // before spawning and is mandatory: without it Claude could execute native tools fail-open.
    if (!this.toolGateSettingsPath) {
      throw new Error('Claude Headless refused to start without its PreToolUse gate settings.');
    }
    args.push('--settings', TOOL_GATE_SETTINGS_FILE);
    if (disallowedTools.length > 0) {
      args.push('--disallowedTools', ...disallowedTools);
    }
    // Claude CLI 2.1.x still asks for permission before using MCP tools even in bypassPermissions
    // mode. Auto-allow only exact names on Unode's loopback bridges: team operations retain their
    // TeamTools/CommandPolicy gates, files are read-only, and the permission bridge enforces policy.
    // User-configured MCP servers and native tools are intentionally absent.
    const allowedLocalMcpTools = this.localMcpToolNames();
    if (allowedLocalMcpTools.length > 0) {
      args.push('--allowedTools', ...allowedLocalMcpTools);
    }
    // Route claude's permission requests (e.g. Bash) to our in-process gate so they hit Roam's approval
    // card. Mounted by prepareMcpConfig only in acceptEdits mode (bypassPermissions ignores it).
    if (this.permissionServer) {
      args.push('--permission-prompt-tool', `mcp__${PERMISSION_SERVER_ID}__${PERMISSION_TOOL_NAME}`);
    }
    if (this.config.model) {
      args.push('--model', this.config.model);
    }
    // F1: reasoning effort is the only sampling-ish param the claude CLI exposes (--effort). Resolved
    // params win; fall back to the agent's explicit modelParams. All other params have no CLI flag.
    const effort = this.resolvedParams?.reasoning_effort ?? this.config.modelParams?.reasoning_effort;
    if (effort) {
      args.push('--effort', effort);
    }
    // Claude-native MCP: a relative, space-free config path so the Windows shell-spawn can't mangle
    // it. claude hosts the declared servers itself.
    if (this.mcpConfigPath) {
      args.push('--mcp-config', MCP_CONFIG_FILE);
    }
    if (this.skillPluginDirectory) {
      args.push('--plugin-dir', this.skillPluginDirectory);
    }
    return args;
  }

  private assertSafeCliArguments(): void {
    const effort = this.resolvedParams?.reasoning_effort ?? this.config.modelParams?.reasoning_effort;
    for (const [label, value] of [['model', this.config.model], ['effort', effort]] as const) {
      if (value && !SAFE_CLAUDE_CMD_ARGUMENT.test(value)) {
        throw new Error(`Claude Headless refused unsafe ${label} argument.`);
      }
    }
  }

  /** Resolve and verify the shipped hook before any network egress or child-process spawn. A missing
   * script would make node exit non-2, which Claude treats as fail-open, so this is a hard startup error. */
  private assertToolGateScript(): string {
    const script = this.deps.toolGateScriptPath ?? defaultToolGateScriptPath();
    try {
      fs.accessSync(script, fs.constants.R_OK);
      const stat = fs.statSync(script);
      if (!stat.isFile()) {
        throw new Error('not a file');
      }
    } catch {
      throw new Error(`Claude Headless refused to start: required fail-closed PreToolUse hook is unreadable (${script}).`);
    }
    // The hook command is evaluated by Claude's command runner. Quotes/newlines would make the generated
    // settings command ambiguous, so fail closed rather than trying to escape a path we do not control.
    if (/["\r\n]/.test(script) || /["\r\n]/.test(process.execPath)) {
      throw new Error('Claude Headless refused to start: the PreToolUse hook path is unsafe.');
    }
    return script;
  }

  private async prepareToolGate(cwd: string, script: string): Promise<void> {
    const server = this.deps.toolGateServerFactory?.() ?? createLocalMcpServer();
    server.addJsonEndpoint({
      path: '/gate',
      handler: async (body) => this.handlePreToolUse(body),
      streamHandler: async (body, response) => this.streamPreToolUse(body, response),
    });
    await server.start();
    this.toolGateServer = server;
    const endpoint = `http://127.0.0.1:${server.port}/gate`;
    let wrapperPath: string;
    try {
      wrapperPath = this.writeToolGateWrapper(cwd, script, endpoint, server.token);
      this.toolGateWrapperPath = wrapperPath;
    } catch (error) {
      await server.stop().catch(() => undefined);
      this.toolGateServer = undefined;
      throw new Error(`Claude Headless refused to start: failed to write required PreToolUse wrapper (${String(error)}).`);
    }
    const settings = {
      hooks: {
        PreToolUse: [{
          matcher: '*',
          hooks: [{
            type: 'command',
            // Claude 2.1.206 silently ignores a settings file whose hook object has an `env` property.
            // The schema-valid wrapper sets these variables only for the hook child process instead.
            command: `"${wrapperPath}"`,
            // Claude Code's hook timeout is in seconds. It must exceed our bounded human window; the
            // wrapper still treats a missing ACK/heartbeat as a seconds-scale transport failure.
            timeout: TOOL_GATE_CLAUDE_TIMEOUT_SECONDS,
          }],
        }],
      },
    };
    try {
      const abs = path.join(cwd, TOOL_GATE_SETTINGS_FILE);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(abs, 0o600);
      this.toolGateSettingsPath = abs;
    } catch (error) {
      this.cleanupToolGateWrapper();
      await server.stop().catch(() => undefined);
      this.toolGateServer = undefined;
      throw new Error(`Claude Headless refused to start: failed to write required PreToolUse settings (${String(error)}).`);
    }
  }

  private cleanupToolGateSettings(): void {
    if (!this.toolGateSettingsPath) {
      return;
    }
    try {
      fs.unlinkSync(this.toolGateSettingsPath);
    } catch {
      /* already gone */
    }
    this.toolGateSettingsPath = undefined;
    this.cleanupToolGateWrapper();
  }

  /** Claude hook settings do not accept an `env` object in 2.1.206 (invalid settings are silently ignored
   * in -p mode). Use a private, per-session wrapper so credentials are inherited by the hook process, never
   * placed on Claude's argv. It also pins Electron's Code.exe launcher into Node mode. */
  private writeToolGateWrapper(cwd: string, script: string, endpoint: string, token: string): string {
    const wrapper = path.join(cwd, TOOL_GATE_WRAPPER_FILE);
    if (/["\r\n]/.test(wrapper)) {
      throw new Error('unsafe wrapper path');
    }
    const source = process.platform === 'win32'
      ? [
          '@echo off',
          'setlocal DisableDelayedExpansion',
          'set "ELECTRON_RUN_AS_NODE=1"',
          `set "UNODE_CLAUDE_TOOL_GATE_URL=${endpoint}"`,
          `set "UNODE_CLAUDE_TOOL_GATE_TOKEN=${token}"`,
          `set "UNODE_CLAUDE_TOOL_GATE_TIMEOUT_MS=${WEB_ACCESS_HUMAN_WINDOW_MS}"`,
          `set "UNODE_CLAUDE_TOOL_GATE_LIVENESS_MS=${TOOL_GATE_HEARTBEAT_MS * 3}"`,
          `"${process.execPath}" "${script}"`,
          'if errorlevel 1 exit /b 2',
          'exit /b 0',
          '',
        ].join('\r\n')
      : [
          '#!/bin/sh',
          'export ELECTRON_RUN_AS_NODE=1',
          `export UNODE_CLAUDE_TOOL_GATE_URL='${endpoint}'`,
          `export UNODE_CLAUDE_TOOL_GATE_TOKEN='${token}'`,
          `export UNODE_CLAUDE_TOOL_GATE_TIMEOUT_MS='${WEB_ACCESS_HUMAN_WINDOW_MS}'`,
          `export UNODE_CLAUDE_TOOL_GATE_LIVENESS_MS='${TOOL_GATE_HEARTBEAT_MS * 3}'`,
          `"${process.execPath}" "${script}"`,
          'status=$?',
          '[ "$status" -eq 0 ] && exit 0',
          'exit 2',
          '',
        ].join('\n');
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(wrapper, source, { encoding: 'utf8', mode: 0o700 });
    fs.chmodSync(wrapper, 0o700);
    return wrapper;
  }

  private cleanupToolGateWrapper(): void {
    if (!this.toolGateWrapperPath) {
      return;
    }
    try {
      fs.unlinkSync(this.toolGateWrapperPath);
    } catch {
      /* already gone */
    }
    this.toolGateWrapperPath = undefined;
  }

  /**
   * Mount the agent's granted skills as a temporary claude plugin.
   *
   * Every agent gets this, including read-only and folder-scoped ones. Skills load from `--plugin-dir`
   * without shell/write tools: verified live against claude 2.1.206 with `--disallowedTools Bash
   * PowerShell Write Edit NotebookEdit`. Denying the plugin to restricted agents (B0's
   * Gate 2) would have stripped skills from exactly the privacy-scoped agents that need them, for no
   * security gain: the directory is extension-owned, validated instruction-only content (no scripts, no
   * symlinks) copied to a temp dir, so mounting it widens no filesystem, shell, or write capability.
   */
  private prepareSkillPlugin(): void {
    const registry = this.deps.skillRegistry;
    const documents = registry?.grantedDocuments(this.config.playbooks) ?? [];
    if (documents.length === 0) {
      return;
    }
    try {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unodeai-claude-skills-'));
      // The Windows Claude launch path uses shell:true for the .cmd shim. Do not hand that shell an
      // unquoted path with whitespace; degrade to L1 rather than introduce an argv ambiguity.
      if (!SAFE_CLAUDE_CMD_ARGUMENT.test(directory)) {
        fs.rmSync(directory, { recursive: true, force: true });
        this.emit({ kind: 'log', stream: 'stderr', line: 'Claude skill plugin skipped: temporary path is unsafe for the Windows launcher; using L1 skill summaries.' });
        return;
      }
      const safeAgentId = this.config.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'skill';
      fs.mkdirSync(path.join(directory, '.claude-plugin'), { recursive: true });
      const pluginName = `unode-agent-${safeAgentId}`;
      fs.writeFileSync(
        path.join(directory, '.claude-plugin', 'plugin.json'),
        `${JSON.stringify({ name: pluginName, version: '1.0.0', description: 'Authorized UnodeAi agent skills.' }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 }
      );
      for (const document of documents) {
        const target = path.join(directory, 'skills', document.name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(document.directory, target, { recursive: true, dereference: true, errorOnExist: true });
      }
      this.skillPluginDirectory = directory;
      this.skillPluginName = pluginName;
    } catch (error) {
      this.cleanupSkillPlugin();
      this.emit({ kind: 'log', stream: 'stderr', line: `Claude skill plugin skipped: ${String(error)}` });
    }
  }

  private async prepareMcpConfig(cwd: string): Promise<ClaudeMcpConfig | undefined> {
    const mcpServers: Record<string, ClaudeMcpServerSpec> = { ...(this.mcpConfig?.mcpServers ?? {}) };

    // 1) Command-approval gate for EVERY claude agent: a per-agent local server hosting the
    //    permission-prompt tool, so shell commands honor unode.commandApproval (the approval card) — the
    //    same gate OpenAI-compat agents already get. Only when we'll actually be asked (acceptEdits mode;
    //    bypassPermissions never calls the tool).
    if (this.shouldGateCommands()) {
      const create = this.deps.commandPermission?.createServer ?? createLocalMcpServer;
      const server = create();
      server.addLocalTool(this.buildPermissionTool());
      await server.start();
      this.permissionServer = server;
      mcpServers[PERMISSION_SERVER_ID] = buildTeamBridgeConfig(server);
    }

    // 2) Read-only files bridge for cross-root READ. Never use claude --add-dir: it widens native
    // read+write access. This bridge exposes only read_file/list_dir/search_files backed by WorkspaceTools.
    const filesBridge = await this.prepareFilesBridge(cwd);
    if (filesBridge) {
      mcpServers[FILES_BRIDGE_SERVER_ID] = filesBridge;
    }

    // 3) Team bridge (PM only) — unchanged: lets a Claude PM delegate via list_agents/assign_task/etc.
    if (this.config.role === 'pm') {
      if (this.deps.localMcpServerFactory && this.deps.teamMcpBridge) {
        this.localMcpServer = this.deps.localMcpServerFactory();
        await this.localMcpServer.start(this.deps.teamMcpBridge);
        mcpServers[TEAM_BRIDGE_SERVER_ID] = buildTeamBridgeConfig(this.localMcpServer);
      } else {
        this.emit({ kind: 'log', stream: 'stderr', line: 'Claude PM team bridge skipped: TeamMcpBridge is not available.' });
      }
    }

    return Object.keys(mcpServers).length > 0 ? { mcpServers } : undefined;
  }

  private localMcpToolNames(): string[] {
    const qualified = (serverId: string, names: string[]) => names.map((name) => `mcp__${serverId}__${name}`);
    return [
      ...(this.permissionServer ? qualified(PERMISSION_SERVER_ID, [PERMISSION_TOOL_NAME]) : []),
      ...(this.filesBridgeServer ? qualified(FILES_BRIDGE_SERVER_ID, this.filesBridgeToolNames()) : []),
      ...(this.localMcpServer ? qualified(TEAM_BRIDGE_SERVER_ID, TEAM_BRIDGE_TOOL_NAMES) : []),
    ];
  }

  private async prepareFilesBridge(cwd: string): Promise<ClaudeMcpServerSpec | undefined> {
    const roots = this.filesBridgeReadRoots(cwd);
    if (roots.length === 0 && !this.deps.delegationContentAssets && !this.deps.messageBus) {
      return undefined;
    }

    const tools = new WorkspaceTools(
      cwd,
      new Set(['read']),
      this.agentId,
      undefined,
      undefined,
      undefined,
      undefined,
      this.deps.messageBus,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      roots,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      this.deps.delegationContentAssets,
      this.deps.onContentReceipt,
    );
    tools.setTaskInputResolver(this.deps.taskInputResolver);
    const server = createLocalMcpServer();
    this.filesBridgeTools = tools;
    for (const tool of this.buildFilesBridgeTools(tools)) {
      server.addLocalTool(tool);
    }
    await server.start();
    this.filesBridgeServer = server;
    return buildTeamBridgeConfig(server);
  }

  private filesBridgeReadRoots(cwd: string): string[] {
    const primary = path.resolve(cwd);
    const roots = (this.deps.additionalReadRoots ?? [])
      .map((root) => path.resolve(root))
      .filter((root) => root !== primary && fs.existsSync(root));
    return [...new Set(roots)];
  }

  private filesBridgeToolNames(): string[] {
    return this.deps.messageBus
      ? [...FILES_BRIDGE_TOOL_NAMES, ...CONVERSATION_LOG_BRIDGE_TOOL_NAMES]
      : FILES_BRIDGE_TOOL_NAMES;
  }

  private buildFilesBridgeTools(tools: WorkspaceTools): LocalMcpTool[] {
    return [
      {
        name: 'read_file',
        description: 'Read a UTF-8 text file from the working folder or an allowed read-only root.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path, relative to the working folder/read root or absolute inside an allowed read root.' },
            offset: { type: 'integer', description: '0-indexed line number to start reading from.' },
            limit: { type: 'integer', description: 'Maximum number of lines to return.' },
          },
          required: ['path'],
        },
        handler: async (args) => {
          const result = await tools.run('read_file', args);
          const receipt = result.readContent === undefined
            ? undefined
            : this.deps.teamMcpBridge?.registerTurnContentReceipt?.(result.readContent);
          if (receipt) {
            this.mayPublishContentReceipt = true;
          }
          return receipt ? `${result.output}\n\n[host content receipt: ${receipt.id}]` : result.output;
        },
      },
      {
        name: 'list_dir',
        description: 'List a directory in the working folder or an allowed read-only root.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path, relative to the working folder/read root or absolute inside an allowed read root.' },
          },
          required: ['path'],
        },
        handler: async (args) => tools.runText('list_dir', args),
      },
      {
        name: 'search_files',
        description: 'Search the working folder and allowed read-only roots for a regex or plain substring.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'A JavaScript regular expression, or plain text to find.' },
            path: { type: 'string', description: 'Optional subdirectory/path to limit the search.' },
            max_results: { type: 'integer', description: 'Maximum matches to return.' },
          },
          required: ['query'],
        },
        handler: async (args) => tools.runText('search_files', args),
      },
      {
        name: 'read_extracted_content',
        description: 'Read a page range from an opaque PDF or user-supplied text asset handed off by a coordinator.',
        inputSchema: {
          type: 'object',
          properties: {
            assetId: { type: 'string', description: 'Opaque content asset id from the delegation source receipt.' },
            pages: { type: 'object', properties: { start: { type: 'integer' }, end: { type: 'integer' } } },
          },
          required: ['assetId'],
        },
        handler: async (args) => tools.runText('read_extracted_content', args),
      },
      {
        name: 'search_extracted_content',
        description: 'Search a page range of an opaque PDF or user-supplied text asset handed off by a coordinator.',
        inputSchema: {
          type: 'object',
          properties: {
            assetId: { type: 'string', description: 'Opaque content asset id from the delegation source receipt.' },
            query: { type: 'string', description: 'Text to find.' },
            pages: { type: 'object', properties: { start: { type: 'integer' }, end: { type: 'integer' } } },
          },
          required: ['assetId', 'query'],
        },
        handler: async (args) => tools.runText('search_extracted_content', args),
      },
      {
        name: 'select_workflow_branch',
        description: 'Select exactly one host-declared outcome label for the current workflow step. The host compares this token exactly and never infers it from prose.',
        inputSchema: {
          type: 'object',
          properties: { label: { type: 'string', description: 'One exact label declared in the assigned workflow task.' } },
          required: ['label'],
        },
        handler: async (args) => tools.runText('select_workflow_branch', args),
      },
      {
        name: 'report_context_gap',
        description: 'Report which required declared input is blocking completion. The host derives any access-failure reason from its latest structured observation; the model supplies only inputId.',
        inputSchema: {
          type: 'object',
          properties: { inputId: { type: 'string', description: 'Declared input id from the host task card.' } },
          required: ['inputId'],
        },
        handler: async (args) => tools.runText('report_context_gap', args),
      },
      {
        name: 'publish_task_artifact',
        description: 'Publish one immutable bounded upstream artifact for a later declared task dependency.',
        inputSchema: {
          type: 'object',
          properties: { content: { type: 'string', description: 'Complete bounded artifact content.' } },
          required: ['content'],
        },
        handler: async (args) => tools.runText('publish_task_artifact', args),
      },
      ...(this.deps.messageBus ? [
        {
          name: 'search_conversation_log',
          description: 'Search only this Claude agent\'s own bounded Activity conversation log.',
          inputSchema: {
            type: 'object' as const,
            properties: { query: { type: 'string', description: 'Text to find in this agent\'s own conversation log.' } },
            required: ['query'],
          },
          handler: async (args: Record<string, any>) => tools.runText('search_conversation_log', args),
        },
        {
          name: 'read_conversation_log',
          description: 'Read a small numbered range from this Claude agent\'s own conversation log after searching it.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              entries: {
                type: 'object',
                properties: { start: { type: 'integer' }, end: { type: 'integer' } },
                required: ['start', 'end'],
              },
            },
            required: ['entries'],
          },
          handler: async (args: Record<string, any>) => tools.runText('read_conversation_log', args),
        },
      ] : []),
    ];
  }

  /** Gate commands when an approver is wired and claude will consult it. Read-only Folder Access also
   *  removes native write/shell tools at the CLI level, leaving this gate as defense-in-depth. */
  private shouldGateCommands(): boolean {
    const disallowed = this.launchDisallowedNativeTools ?? this.disallowedNativeTools();
    return !!this.deps.commandPermission && (!this.config.autoApprove || disallowed.length > 0);
  }

  private isReadOnlyFolderScope(): boolean {
    return !!this.deps.writeRoots && this.deps.writeRoots.length === 0;
  }

  private isWorkspaceUntrusted(): boolean {
    return this.deps.commandPermission?.isTrusted?.() === false;
  }

  private isNoWriteScope(): boolean {
    return this.isReadOnlyFolderScope() || !this.hasWriteCapability() || this.isWorkspaceUntrusted();
  }

  private hasWriteCapability(): boolean {
    const configuredTools = this.config.allowedTools;
    return !Array.isArray(configuredTools) || configuredTools.includes('write');
  }

  private disallowedNativeTools(): string[] {
    const configuredTools = this.config.allowedTools;
    const hasToolCeiling = Array.isArray(configuredTools);
    const canExecute = !hasToolCeiling || configuredTools.includes('execute');
    const noWriteScope = this.isNoWriteScope();
    const noExecuteScope = this.isReadOnlyFolderScope() || !canExecute || this.deps.restrictShell || this.isWorkspaceUntrusted();
    const disallowed: string[] = [];
    if (noWriteScope) {
      disallowed.push(...CLAUDE_WRITE_TOOLS);
      disallowed.push(...CLAUDE_SCOPE_BREAKING_TOOLS);
      disallowed.push(...CLAUDE_NO_WRITE_ESCAPE_TOOLS);
    }
    if (noExecuteScope) {
      disallowed.push(...CLAUDE_SHELL_TOOLS);
    }
    if (this.config.disableNativeSubagents) {
      disallowed.push(...CLAUDE_NATIVE_SUBAGENT_TOOLS);
    }
    // F3: a static Claude CLI tool must be removed when this session's shared policy can only deny it.
    // `ask` stays advertised because the reachable F2 approval path can grant it. Direct library consumers
    // without the optional host gate retain the legacy surface; the production factory always supplies it.
    if (!this.canAdvertisePublicWeb()) {
      disallowed.push(...CLAUDE_NETWORK_READ_TOOL_NAMES);
    }
    return [...new Set(disallowed)];
  }

  private canAdvertisePublicWeb(): boolean {
    const webAccess = this.deps.webAccess;
    if (!webAccess) {
      return true;
    }
    return resolveWebAccessPolicy(webAccess.policy(), this.hasReadCapability())?.allow !== false;
  }

  /** Copy must say which real policy denied the native tool, never prescribe disk access for a web read. */
  private disallowedToolReason(toolName: string): string {
    const normalized = toolName.trim().toLowerCase();
    if (CLAUDE_NETWORK_READ_TOOLS.has(normalized)) {
      const webAccess = this.deps.webAccess;
      if (!webAccess) {
        return 'Public web access is unavailable because the host web-policy gate is not configured.';
      }
      const decision = resolveWebAccessPolicy(webAccess.policy(), this.hasReadCapability());
      if (decision && !decision.allow) {
        return decision.reason ?? 'Public web access is denied by unode.webAccess.';
      }
      return 'Public web access is not available to this Claude session.';
    }
    if (this.isNoWriteScope()) {
      return this.noWriteScopeReason(toolName);
    }
    if ((CLAUDE_SHELL_TOOLS as readonly string[]).some((tool) => tool.toLowerCase() === normalized)) {
      return `${toolName} is a shell-command tool and is disabled by this agent's execution policy.`;
    }
    if (UNMEDIATED_SUBAGENT_TOOLS.has(normalized) && this.config.disableNativeSubagents) {
      return `${toolName} is a native-delegation tool and native subagents are disabled for this agent.`;
    }
    return `${toolName} is disabled by this agent's tool policy.`;
  }

  private noWriteScopeReason(toolName: string): string {
    const toolClass = nativeToolClass(toolName);
    if (this.isWorkspaceUntrusted()) {
      return `${toolName} is a ${toolClass}; it is disabled until this workspace is trusted.`;
    }
    if (this.isReadOnlyFolderScope()) {
      if (toolClass === 'unrecognized native tool') {
        return `${toolName} is an unrecognized native tool, so it is denied in this read-only folder scope. Use a supported read-only tool instead.`;
      }
      return `${toolName} is a ${toolClass}; this agent has read-only folder access, so that class is disabled.`;
    }
    if (!this.hasWriteCapability()) {
      return `${toolName} is a ${toolClass}; this connection does not grant the write capability required for it.`;
    }
    return `${toolName} is a ${toolClass} and is disabled by this agent's scope.`;
  }

  /** The permission-prompt tool claude calls before a gated tool use; routes shell commands through the
   *  CommandPolicy + approval card and returns claude's allow/deny JSON. */
  private buildPermissionTool(): LocalMcpTool {
    const gate = this.deps.commandPermission;
    return {
      name: PERMISSION_TOOL_NAME,
      description: 'UnodeAi command-approval gate (invoked by claude --permission-prompt-tool).',
      inputSchema: {
        type: 'object',
        properties: { tool_name: { type: 'string' }, input: { type: 'object' } },
        required: ['tool_name', 'input'],
      },
      handler: async (args) => {
        const toolName = typeof args.tool_name === 'string' ? args.tool_name : '';
        const input = args.input && typeof args.input === 'object' && !Array.isArray(args.input)
          ? (args.input as Record<string, unknown>)
          : {};
        const disallowed = new Set(this.disallowedNativeTools().map((name) => name.toLowerCase()));
        if (disallowed.has(toolName.trim().toLowerCase())) {
          return JSON.stringify({ behavior: 'deny', message: this.disallowedToolReason(toolName) });
        }
        const decision = await this.awaitHumanDecision(decideCommandPermission(toolName, input, {
          policy: gate?.policy,
          requestApproval: gate?.requestApproval,
          isTrusted: gate?.isTrusted ? gate.isTrusted() : undefined,
          readOnly: this.isNoWriteScope(),
        }), () => ({
          behavior: 'deny' as const,
          message: `Nobody approved ${toolName} within ${Math.ceil(this.humanApprovalTimeoutMs() / 60_000)} minutes.`,
        }));
        return JSON.stringify(decision);
      },
    };
  }

  /** The authenticated loopback callback for Claude's matcher-* PreToolUse hook. All malformed hook
   * payloads and policy errors resolve to deny; the standalone hook additionally fails closed on any
   * transport failure by exiting 2. */
  private async handlePreToolUse(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const toolName = typeof body.tool_name === 'string'
        ? body.tool_name
        : typeof body.toolName === 'string'
          ? body.toolName
          : '';
      const rawInput = body.tool_input ?? body.toolInput ?? body.input;
      const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
        ? rawInput as Record<string, unknown>
        : undefined;
      if (!toolName.trim() || !input) {
        return { allow: false, reason: 'Malformed Claude PreToolUse request was denied.' };
      }
      const decision = await this.decidePreToolUse(toolName, input);
      return { allow: decision.allow, ...(decision.note ? { reason: decision.note } : {}) };
    } catch {
      return { allow: false, reason: 'UnodeAi could not evaluate this tool call, so it was denied.' };
    }
  }

  /**
   * The hook process must prove the loopback gate is alive in seconds, while a human decision gets a
   * bounded, human-scale window. Newline-delimited JSON lets the wrapper reset its liveness clock without
   * treating a still-visible approval card as a dead gate.
   */
  private async streamPreToolUse(body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    response.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    response.flushHeaders?.();
    response.write(`${JSON.stringify({ type: 'ack' })}\n`);
    const heartbeat = setInterval(() => {
      if (!response.writableEnded && !response.destroyed) {
        response.write(`${JSON.stringify({ type: 'heartbeat' })}\n`);
      }
    }, TOOL_GATE_HEARTBEAT_MS);
    try {
      const decision = await this.handlePreToolUse(body);
      if (!response.writableEnded && !response.destroyed) {
        response.write(`${JSON.stringify(decision)}\n`);
        response.end();
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async decidePreToolUse(toolName: string, input: Record<string, unknown>): Promise<ClaudeToolApprovalDecision> {
    if (this.hostHookBlockReason) {
      return { allow: false, note: this.hostHookBlockReason };
    }
    const hook = await resolveExecutionHooks(this.deps.executionHooks)?.run('PreTool', { toolName });
    if (hook && !hook.allow) {
      return { allow: false, note: hook.reason };
    }
    const normalized = toolName.trim().toLowerCase();
    const disallowed = new Set(this.disallowedNativeTools().map((name) => name.toLowerCase()));
    if (disallowed.has(normalized)) {
      return { allow: false, note: this.disallowedToolReason(toolName) };
    }
    // A Claude-backed coordinator follows the same self-execution contract as the in-process
    // backend. Native CLI tools must not become a side door around candidate filtering merely
    // because they do not pass through WorkspaceTools.
    const coordinatorTool = (CLAUDE_SHELL_TOOLS as readonly string[]).some((tool) => tool.toLowerCase() === normalized)
      ? 'run_command'
      : CLAUDE_WRITE_TOOLS.some((tool) => tool.toLowerCase() === normalized)
        ? 'write_file'
        : undefined;
    const teamBridge = this.deps.teamMcpBridge;
    if (coordinatorTool && teamBridge?.hasTeammates?.()) {
      const attempt = teamBridge.currentCoordinatorTaskAttempt?.();
      if (!attempt || !teamBridge.canCoordinatorExecute?.(coordinatorTool)) {
        return {
          allow: false,
          note: 'Coordinator execution is not authorised. Submit dispatch_task with a strict task contract. '
            + 'Use execution_strategy=coordinator-only for an atomic task, or delegate-preferred to permit host-filtered fallback. '
            + 'There is no bounce-count escape hatch.',
        };
      }
      this.activeTaskAttempt = attempt;
      this.filesBridgeTools?.setTaskAttempt(attempt);
    }
    if (CLAUDE_NETWORK_READ_TOOLS.has(normalized)) {
      return this.decideNetworkRead(toolName);
    }
    if (this.isNoWriteScope() && !this.readOnlyScopeAllows(normalized)) {
      return { allow: false, note: this.noWriteScopeReason(toolName) };
    }
    if (CLAUDE_HOOK_READ_TOOLS.has(normalized) || isUnodeLocalMcpTool(normalized)) {
      return { allow: true };
    }
    if ((CLAUDE_SHELL_TOOLS as readonly string[]).some((tool) => tool.toLowerCase() === normalized)) {
      const gate = this.deps.commandPermission;
      const permission = await this.awaitHumanDecision(decideCommandPermission(toolName, input, {
        policy: gate?.policy,
        requestApproval: gate?.requestApproval,
        isTrusted: gate?.isTrusted ? gate.isTrusted() : undefined,
        readOnly: this.isNoWriteScope(),
      }), () => ({
        behavior: 'deny' as const,
        message: `Nobody approved ${toolName} within ${Math.ceil(this.humanApprovalTimeoutMs() / 60_000)} minutes.`,
      }));
      return permission.behavior === 'allow'
        ? { allow: true }
        : { allow: false, note: permission.message };
    }
    if (CLAUDE_WRITE_TOOLS.some((tool) => tool.toLowerCase() === normalized)) {
      return this.approveNativeWrite(toolName, input);
    }
    if (CLAUDE_EXTERNAL_EFFECT_TOOLS.has(normalized)) {
      return this.requestToolApproval(toolName, input, nativeToolEffect(toolName, input));
    }
    // User-installed MCP servers and native tool names added by a newer Claude release are never silently
    // allowed. The remembered answer is per agent process, not a machine-wide implicit allowlist.
    return this.requestToolApproval(toolName, input, `Use the ${toolName} tool.`);
  }

  private readOnlyScopeAllows(tool: string): boolean {
    return CLAUDE_HOOK_READ_TOOLS.has(tool) || CLAUDE_NETWORK_READ_TOOLS.has(tool) || isUnodeLocalMcpTool(tool);
  }

  private hasReadCapability(): boolean {
    const configuredTools = this.config.allowedTools;
    return !Array.isArray(configuredTools) || configuredTools.includes('read');
  }

  private humanApprovalTimeoutMs(): number {
    const configured = this.deps.humanApprovalTimeoutMs;
    return typeof configured === 'number' && Number.isFinite(configured) && configured >= 50
      ? configured
      : WEB_ACCESS_HUMAN_WINDOW_MS;
  }

  /** A lapsed human window is an ordinary policy denial, never a broken-hook transport error. */
  private async awaitHumanDecision<T>(decision: Promise<T>, onTimeout: () => T): Promise<T> {
    // A host-owned approval surface is a known, actionable wait. It is not arbitrary CLI chatter, so it
    // legitimately holds the watchdog while the bounded human decision is open.
    this.noteMaterialOutput();
    return await new Promise<T>((resolve) => {
      let settled = false;
      const finish = (value: T) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(onTimeout()), this.humanApprovalTimeoutMs());
      decision.then(finish, () => finish(onTimeout()));
    });
  }

  /** Same policy table as WorkspaceTools.fetchUrl; only the native tool spellings differ. */
  private async decideNetworkRead(toolName: string): Promise<ClaudeToolApprovalDecision> {
    const webAccess = this.deps.webAccess;
    if (!webAccess) {
      return { allow: false, note: 'Web access is unavailable because the host policy gate is not configured.' };
    }
    const policyDecision = resolveWebAccessPolicy(webAccess.policy(), this.hasReadCapability());
    if (policyDecision) {
      return { allow: policyDecision.allow, note: policyDecision.reason };
    }
    const decision = await this.awaitHumanDecision(
      webAccess.requestApproval({ agentName: this.config.name, toolName }),
      () => ({
        allow: false,
        reason: `Nobody approved ${toolName} within ${Math.ceil(this.humanApprovalTimeoutMs() / 60_000)} minutes. Approve web access in chat, or set unode.webAccess to allow or off.`,
      }),
    );
    return { allow: decision.allow, note: decision.reason };
  }

  private async approveNativeWrite(toolName: string, input: Record<string, unknown>): Promise<ClaudeToolApprovalDecision> {
    if (!this.deps.writeApprovalAsk?.()) {
      return { allow: true };
    }
    const preview = nativeWritePreview(this.config.workingDirectory || process.cwd(), toolName, input);
    if (!preview || !this.deps.requestWriteApproval) {
      // We must not turn on write approval and then silently bypass it because a new Claude write-tool
      // input shape cannot produce a safe preview. Surface the same explicit tool approval instead.
      return this.requestToolApproval(toolName, input, `Modify ${nativeToolPath(input) ?? 'a workspace file'} with Claude ${toolName}.`);
    }
    const answer = await this.awaitHumanDecision(
      this.deps.requestWriteApproval(preview),
      () => 'deny' as const,
    );
    return answer === 'deny'
      ? { allow: false, note: 'The user did not approve this file change.' }
      : { allow: true };
  }

  private async requestToolApproval(
    toolName: string,
    input: Record<string, unknown>,
    detail: string
  ): Promise<ClaudeToolApprovalDecision> {
    const key = toolName.trim().toLowerCase();
    const remembered = this.rememberedToolDecisions.get(key);
    if (remembered) {
      return remembered;
    }
    if (!this.deps.requestToolApproval) {
      return { allow: false, note: `${toolName} needs user approval, but no approval surface is available.` };
    }
    const answer = await this.awaitHumanDecision(
      this.deps.requestToolApproval({ toolName, detail, input, timeoutMs: this.humanApprovalTimeoutMs() }),
      () => ({
        allow: false,
        note: `Nobody approved ${toolName} within ${Math.ceil(this.humanApprovalTimeoutMs() / 60_000)} minutes.`,
      }),
    );
    const decision: ClaudeToolApprovalDecision = {
      allow: answer.allow === true,
      remember: answer.remember === true,
      note: answer.note?.trim() || undefined,
    };
    if (decision.remember) {
      this.rememberedToolDecisions.set(key, decision);
    }
    return decision;
  }

  /** Write the agent's MCP config into a relative file in cwd (if any). Best-effort. */
  private writeMcpConfig(cwd: string, mcpConfig: ClaudeMcpConfig | undefined): void {
    if (!mcpConfig) {
      return;
    }
    try {
      const abs = path.join(cwd, MCP_CONFIG_FILE);
      fs.mkdirSync(path.dirname(abs), { recursive: true }); // ensure .unode/ exists
      fs.writeFileSync(abs, JSON.stringify(mcpConfig, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(abs, 0o600); // also tighten a pre-existing file created under a permissive umask
      this.mcpConfigPath = abs;
    } catch (err) {
      this.emit({ kind: 'log', stream: 'stderr', line: `failed to write MCP config: ${String(err)}` });
      this.mcpConfigPath = undefined;
    }
  }

  /** Remove the MCP config file we wrote, if any. */
  private cleanupMcpConfig(): void {
    if (!this.mcpConfigPath) {
      return;
    }
    try {
      fs.unlinkSync(this.mcpConfigPath);
    } catch {
      /* already gone */
    }
    this.mcpConfigPath = undefined;
  }

  private cleanupSkillPlugin(): void {
    const directory = this.skillPluginDirectory;
    this.skillPluginDirectory = undefined;
    this.skillPluginName = undefined;
    if (!directory) {
      return;
    }
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      /* temporary plugin cleanup must not interrupt process cleanup */
    }
  }

  private async stopMcpServers(): Promise<void> {
    const servers = [this.localMcpServer, this.permissionServer, this.filesBridgeServer];
    this.localMcpServer = undefined;
    this.permissionServer = undefined;
    this.filesBridgeServer = undefined;
    for (const server of servers) {
      if (!server) {
        continue;
      }
      try {
        await server.stop();
      } catch {
        /* stopping a local server must not break process cleanup */
      }
    }
  }

  private async stopLocalMcpServer(): Promise<void> {
    const gate = this.toolGateServer;
    this.toolGateServer = undefined;
    await this.stopMcpServers();
    try {
      await gate?.stop();
    } catch {
      /* stopping the PreToolUse callback must not break process cleanup */
    }
  }

  /**
   * Build the text for one user turn. On the first turn we prepend the role/system prompt and a
   * crew-context header so the agent adopts its persona (we deliberately don't pass the prompt as
   * a CLI arg — see start()). Attachments are folded in as a structured footer.
   * Plan mode is best-effort for Claude in v0.2.0 because native tool permissions are fixed at
   * spawn via --permission-mode; hard per-turn gating would require restarting the process.
   */
  private composeTurnText(instruction: string, attachments?: TurnAttachments): string {
    const parts: string[] = [];
    const projectContext = attachments?.projectContext ?? '';

    if (!this.firstTurnSent) {
      if (this.config.systemPrompt) {
        parts.push(`# Your Role: ${this.config.name}\n\n${replaceProjectContextBlock(this.config.systemPrompt, projectContext)}`);
      }
      const skillPrompt = this.deps.skillRegistry?.promptBlock(this.config.playbooks, {
        access: this.skillPluginDirectory ? 'plugin' : 'metadata',
        pluginName: this.skillPluginName,
      });
      if (skillPrompt) {
        parts.push(skillPrompt);
      }
      parts.push(
        `You are agent "${this.config.id}" in a UnodeAi multi-agent team. ` +
          `Other agents may hand you tasks; address only the task below.`
      );
      parts.push('---');
    } else {
      const block = projectContextBlock(projectContext);
      if (block) {
        parts.push(block.trim());
        parts.push('---');
      }
    }
    this.firstTurnSent = true;

    if (attachments?.mode === 'plan') {
      parts.push('[PLAN MODE] Discuss, analyze, and plan only. Do not edit files or run commands.');
    }
    if ((this.deps.additionalReadRoots ?? []).length > 0) {
      parts.push('Files outside your working folder (other workspace folders / additional roots) are read via the `unode_files` MCP tools; your native Read/Grep/Glob only see the working folder.');
    }

    parts.push(instruction);

    if (attachments?.files?.length) {
      parts.push(`\nRelevant files:\n${attachments.files.map((f) => `- ${f}`).join('\n')}`);
    }
    if (attachments?.expectedOutput) {
      parts.push(`\nExpected output: ${attachments.expectedOutput}`);
    }
    if (attachments?.taskAttempt) {
      parts.push(formatTaskAttemptCard(attachments.taskAttempt));
    }
    if (attachments?.context && Object.keys(attachments.context).length > 0) {
      parts.push(`\nContext:\n\`\`\`json\n${JSON.stringify(attachments.context, null, 2)}\n\`\`\``);
    }
    const userTextAttachments = formatUserTextAttachments(attachments?.userAttachments);
    if (userTextAttachments) {
      parts.push(userTextAttachments);
    }
    // Image attachments are NOT inlined as text — they ride as Anthropic image content blocks in the
    // stream-json turn (see sendUserTurn), which the `claude` CLI reads natively (verified: a base64 image
    // block in message.content is described correctly by the model).

    return parts.join('\n\n');
  }

  private consumeStdout(chunk: string): void {
    const { objects, garbage } = this.parser.push(chunk);
    objects.forEach((o) => this.enqueueEvent(o));
    garbage.forEach((line) => this.emit({ kind: 'log', stream: 'stdout', line }));
  }

  private enqueueEvent(raw: unknown): void {
    this.eventChain = this.eventChain
      .then(() => this.handleEvent(raw))
      .catch((error) => this.emit({ kind: 'log', stream: 'stderr', line: `Claude event processing failed: ${error instanceof Error ? error.message : String(error)}` }));
  }

  /**
   * Translate one Claude Code stream-json event into a normalized BackendEvent.
   * Parsing is defensive: unknown shapes are surfaced as logs rather than throwing.
   */
  private async handleEvent(raw: unknown): Promise<void> {
    if (typeof raw !== 'object' || raw === null) {
      return;
    }
    const evt = raw as Record<string, any>;

    switch (evt.type) {
      case 'system':
        if (evt.subtype === 'init') {
          // Usually a no-op (we already emitted `ready` on spawn); acts as a fallback if some
          // platform flushes init before our spawn handler runs.
          this.emitReady(evt.model, evt.session_id);
        }
        return;

      case 'assistant': {
        const content = evt.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text' && block.text) {
              this.noteMaterialOutput();
              this.emitAssistantText(block.text);
            } else if (block?.type === 'tool_use') {
              this.noteMaterialOutput();
              this.turnEvidence.hadToolActions = true;
              recordClaudeToolEvidence(block.name, block.input, this.turnEvidence);
              if (typeof block.id === 'string' && typeof block.name === 'string') {
                this.toolUseNames.set(block.id, block.name);
                const taskPath = claudeTaskReadPath(block.name, block.input);
                if (taskPath) this.toolUseReadPaths.set(block.id, taskPath);
                const shellCommand = claudeToolCommand(block.input);
                if (shellCommand) { this.toolUseCommands.set(block.id, shellCommand); }
                this.rememberCheckpointIntent(block.id, block.name, block.input);
              }
              this.detectUnmediatedToolUse(block.name);
              this.emit({ kind: 'tool_use', name: block.name, input: block.input });
            }
          }
        }
        return;
      }

      case 'stream_event':
        this.handleStreamEvent(evt.event);
        return;

      case 'user':
        {
          const handled = this.handleUserEvent(evt.message);
          if (handled) { await handled; }
        }
        return;

      case 'result': {
        const result: TurnResult = {
          text: typeof evt.result === 'string' ? evt.result : '',
          isError: evt.is_error === true || (typeof evt.subtype === 'string' && evt.subtype !== 'success'),
          usage: evt.usage
            ? {
                // Anthropic reports usage the OPPOSITE way round from every OpenAI-compatible provider:
                // `input_tokens` is the UNCACHED REMAINDER, not the total. The real prompt size is
                // input + cache_creation + cache_read. Reading input_tokens alone made a Claude agent with a
                // high hit rate look like it had barely used any context at all — we were showing a fraction
                // of its true input. (On the OpenAI side the trap is inverted: prompt_tokens INCLUDES the
                // cached part, so there you must SUBTRACT or you double-count.)
                inputTokens: (evt.usage.input_tokens ?? 0)
                  + (evt.usage.cache_creation_input_tokens ?? 0)
                  + (evt.usage.cache_read_input_tokens ?? 0),
                outputTokens: evt.usage.output_tokens ?? 0,
                // Cache reads only. A cache WRITE (cache_creation) costs 1.25x a fresh token on Anthropic,
                // so it is not a discount and must not be counted as one.
                cachedInputTokens: evt.usage.cache_read_input_tokens,
                // The CLI's own billed figure. Authoritative — SessionManager prefers it over our estimate,
                // so the cost stays correct regardless of how we count tokens.
                costUsd: typeof evt.total_cost_usd === 'number' ? evt.total_cost_usd : undefined,
                costBasis: this.costBasis,
              }
            : undefined,
          delegationEvidence: {
            hadToolActions: this.turnEvidence.hadToolActions,
            // Recorded from native Write/Edit tool inputs — the framework's own record, not the reply prose.
            changedFiles: [...this.turnEvidence.changedFiles],
            unrecordedWrites: this.turnEvidence.unrecordedWrites,
            verification: this.activeVerificationPlan
              ? this.turnEvidence.verification
              : { ran: this.turnEvidence.verification.ran, passed: this.turnEvidence.verification.passed },
            ...this.filesBridgeTools?.taskAttemptEvidence(),
          },
          workflowBranchLabel: this.filesBridgeTools?.takeWorkflowBranchLabel(),
        };
        // The terminal declaration is structured and host-validated. Do not let an unconstrained CLI
        // result replace its content after the model has chosen to use that protocol.
        const publishedDelivery = this.deps.teamMcpBridge?.takePublishedTurnDelivery?.();
        if (publishedDelivery) {
          result.text = publishedDelivery.text;
        }
        const hookBlocked = this.hostHookBlockReason;
        if (hookBlocked) {
          result.text = `${result.text}${result.text ? '\n\n' : ''}${hookBlocked}`;
        }
        if (!publishedDelivery) {
          // A coordinator that never accepted a terminal receipt gets its ordinary CLI text unchanged.
          this.flushDeferredReceiptOutput();
        }
        const closeout = this.deps.teamMcpBridge?.coordinatorCloseoutState();
        this.toolUseNames.clear();
        this.toolUseReadPaths.clear();
        this.toolUseCommands.clear();
        this.pendingCheckpoints.clear();
        // Mirror the in-process coordinator's terminal fallback. The bridge already exposes the exact
        // TeamTools closeout state, so this is one host-authored sentence, not a Claude-specific verdict.
        // A cancelled turn does not receive a lecture after the user stopped it.
        if (
          !result.isError &&
          !hookBlocked &&
          !this.startCancelled &&
          closeout?.assignmentOpen &&
          !closeout.assignmentClosed &&
          !closeout.hasLiveDelegationWork
        ) {
          result.text = `${result.text}${result.text ? '\n\n' : ''}${hostAuthoredCloseout(closeout)}`;
        }
        const endTurnHooks = resolveExecutionHooks(this.deps.executionHooks);
        if (endTurnHooks) {
          const endTurn = await endTurnHooks.run('EndTurn', {});
          if (!endTurn.allow) {
            result.text = `${result.text}${result.text ? '\n\n' : ''}Host execution hook blocked turn completion: ${endTurn.reason}`;
          }
        }
        this.deps.teamMcpBridge?.finishCoordinatorAttempt?.('settled');
        this.endTurnWatchdog();
        this.activeVerificationPlan = undefined;
        if (publishedDelivery) {
          this.publishReceiptDelivery(result.text);
        }
        this.emit({ kind: 'turn_complete', result });
        return;
      }

      default:
        return;
    }
  }

  private handleStreamEvent(event: unknown): void {
    if (!event || typeof event !== 'object') {
      return;
    }
    const delta = (event as Record<string, any>).delta;
    if (!delta || typeof delta !== 'object') {
      return;
    }
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      this.noteMaterialOutput();
      this.emitAssistantDelta(delta.text);
    } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      this.emit({ kind: 'reasoning_delta', delta: delta.thinking });
    }
  }

  private shouldDeferReceiptOutput(): boolean {
    // A text block can precede the MCP tool result that accepts publish_content_receipt. Once a host
    // receipt exists, hold that prose until the result boundary: otherwise the raw assertion escapes
    // before the terminal tool can replace it with host-owned content.
    return this.mayPublishContentReceipt || this.deps.teamMcpBridge?.hasPendingTurnDelivery?.() === true;
  }

  private emitAssistantText(text: string): void {
    if (this.shouldDeferReceiptOutput()) {
      this.deferredReceiptAssistantText += text;
      return;
    }
    this.emit({ kind: 'assistant', text });
  }

  private emitAssistantDelta(delta: string): void {
    if (this.shouldDeferReceiptOutput()) {
      this.deferredReceiptAssistantDeltas += delta;
      return;
    }
    this.emit({ kind: 'assistant_delta', delta });
  }

  /** Replay normal output when no terminal receipt was accepted. */
  private flushDeferredReceiptOutput(): void {
    if (this.deferredReceiptAssistantText) {
      this.emit({ kind: 'assistant', text: this.deferredReceiptAssistantText });
    }
    if (this.deferredReceiptAssistantDeltas) {
      this.emit({ kind: 'assistant_delta', delta: this.deferredReceiptAssistantDeltas });
    }
    this.deferredReceiptAssistantText = '';
    this.deferredReceiptAssistantDeltas = '';
    this.mayPublishContentReceipt = false;
  }

  /** Drop deferred raw prose and publish only the host-owned receipt reply on both visible surfaces. */
  private publishReceiptDelivery(text: string): void {
    this.deferredReceiptAssistantText = '';
    this.deferredReceiptAssistantDeltas = '';
    this.mayPublishContentReceipt = false;
    this.emit({ kind: 'assistant', text });
    this.emit({ kind: 'assistant_delta', delta: text });
  }

  private handleUserEvent(message: unknown): Promise<void> | undefined {
    const hooks = resolveExecutionHooks(this.deps.executionHooks);
    if (hooks) {
      return this.processUserToolResults(message, hooks);
    }
    // Preserve the stream-json event contract for the ordinary no-hook path: existing consumers observe
    // a tool result synchronously, while approved hook work is deliberately ordered and awaited above.
    void this.processUserToolResults(message);
    return undefined;
  }

  private async processUserToolResults(message: unknown, hooks?: ReturnType<typeof resolveExecutionHooks>): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }
    const content = (message as Record<string, any>).content;
    if (!Array.isArray(content)) {
      return;
    }
    for (const block of content) {
      if (block?.type !== 'tool_result') {
        continue;
      }
      const detail = flattenClaudeContent(block.content);
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      const name = this.toolUseNames.get(id) ?? 'tool';
      const writtenPath = this.pendingCheckpoints.get(id)?.intent.path;
      const succeeded = block.is_error !== true;
      const readPath = this.toolUseReadPaths.get(id);
      this.noteMaterialOutput();
      this.recordNativeCheckpoint(id, succeeded);
      if (succeeded && readPath && this.activeTaskAttempt) {
        this.deps.taskInputResolver?.noteWorkspaceRead(
          this.activeTaskAttempt.attemptId,
          this.agentId,
          readPath,
        );
      }
      if (succeeded && writtenPath && hooks) {
        const postWrite = await hooks.run('PostWrite', {
          toolName: name,
          writtenPath,
        });
        if (postWrite && !postWrite.allow) {
          // The native write has already completed. Carry the fail-closed decision forward so the tool-gate
          // rejects every later native action and the terminal result cannot present a successful closeout.
          this.hostHookBlockReason = `Host execution hook blocked closeout after writing ${writtenPath}: ${postWrite.reason}`;
        }
      }
      if (!succeeded && hooks) {
        const onFailure = await hooks.run('on-failure', {
          toolName: name,
          failure: summarizeToolResult(detail),
        });
        if (onFailure && !onFailure.allow) {
          this.hostHookBlockReason = `Host execution hook blocked further work after a failed ${name}: ${onFailure.reason}`;
        }
      }
      if (name === 'run_checks') {
        // Objective verification: run_checks reports [checks passed] on success. Trust the framework
        // record (not the teammate's prose), exactly like the OpenAI-compat verify path.
        this.turnEvidence.verification = { ran: true, passed: /^\[checks passed\]/.test(detail.trim()), source: 'run-checks' };
      } else {
        // Bash tool results provide the objective exit-status observation. Do not infer a test framework
        // from the command text: only a declared command-exit-zero sensor can make it applicable.
        const ranCommand = this.toolUseCommands.get(id);
        if (ranCommand) {
          const passed = block.is_error !== true;
          this.turnEvidence.verification = { ran: true, passed, source: 'command-exit-zero' };
          if (passed) {
            this.deps.teamMcpBridge?.noteCoordinatorVerificationPassed();
          }
        }
      }
      this.emit({
        kind: 'tool_result',
        name,
        ok: block.is_error !== true,
        summary: summarizeToolResult(detail),
        detail,
      });
      this.toolUseReadPaths.delete(id);
    }
  }

  /** Keep only what the event itself proves until the CLI reports its tool result. */
  private rememberCheckpointIntent(toolUseId: string, toolName: unknown, input: unknown): void {
    const intent = parseClaudeEditIntent(toolName, input);
    if (!intent) {
      return;
    }
    // Never read bytes here. Claude owns the write and a pre-write content read races it; a late read
    // labelled "before" could make restore overwrite the user's actual work. Existence is enough to
    // distinguish a new Write (restore deletes) from an overwrite (listed, never restorable).
    const existedBefore = intent.kind === 'write'
      ? fs.existsSync(path.resolve(this.config.workingDirectory || process.cwd(), intent.path))
      : undefined;
    this.pendingCheckpoints.set(toolUseId, { intent, existedBefore });
  }

  /** Derive a checkpoint after a successful native tool result, refusing every unprovable before-state. */
  private recordNativeCheckpoint(toolUseId: string, succeeded: boolean): void {
    const pending = this.pendingCheckpoints.get(toolUseId);
    this.pendingCheckpoints.delete(toolUseId);
    if (!pending || !succeeded || !this.deps.recordCheckpoint) {
      return;
    }
    let after: string;
    try {
      // This is deliberately the AFTER read. The CLI has completed the tool; it is not a pre-write
      // snapshot and therefore cannot be misrepresented as one.
      const afterPath = path.resolve(this.config.workingDirectory || process.cwd(), pending.intent.path);
      after = this.deps.readAfterFile?.(afterPath) ?? fs.readFileSync(afterPath, 'utf8');
    } catch {
      return;
    }

    try {
      if (pending.intent.kind === 'edit') {
        const before = reconstructBeforeFromEdit(after, pending.intent);
        if (before.ok) {
          this.deps.recordCheckpoint({ agentId: this.agentId, path: pending.intent.path, before: before.before, after });
        } else {
          this.deps.recordCheckpoint({
            agentId: this.agentId,
            path: pending.intent.path,
            before: null,
            after,
            restoreDisabledReason: before.reason,
          });
        }
        return;
      }

      const before = beforeStateForWrite(pending.existedBefore);
      if (before.ok) {
        this.deps.recordCheckpoint({ agentId: this.agentId, path: pending.intent.path, before: before.before, after });
      } else {
        this.deps.recordCheckpoint({
          agentId: this.agentId,
          path: pending.intent.path,
          before: null,
          after,
          restoreDisabledReason: before.reason,
        });
      }
    } catch {
      // A checkpoint is observability; a host persistence failure must not poison Claude's event stream.
    }
  }

  private killTree(pid: number): void {
    if (process.platform === 'win32') {
      // Shell-spawned `claude.cmd` creates a child tree; SIGKILL on the shell can orphan it.
      nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        this.proc?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }

  private detectUnmediatedToolUse(toolName: unknown): void {
    if (this.unmediatedToolUseReported || typeof toolName !== 'string') {
      return;
    }
    if (!UNMEDIATED_SUBAGENT_TOOLS.has(toolName.trim().toLowerCase())) {
      return;
    }
    this.unmediatedToolUseReported = true;
    this.emit({
      kind: 'log',
      stream: 'stderr',
      line: `${this.config.name} used Claude native ${toolName}; tool calls inside that subagent are mediated by UnodeAi's fail-closed PreToolUse gate.`,
    });
    this.deps.onUnmediatedToolUse?.(toolName, this.config.name);
  }

  private emit(event: BackendEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        /* a faulty sink must not break the backend */
      }
    }
  }

  private beginTurnWatchdog(): void {
    this.turnWatchdogActive = true;
    this.firstMaterialOutputSeen = false;
    this.lastMaterialOutputAt = Date.now();
    this.armIdleWatchdog();
  }

  private endTurnWatchdog(): void {
    this.turnWatchdogActive = false;
    if (this.idleWatchdogTimer) {
      clearTimeout(this.idleWatchdogTimer);
      this.idleWatchdogTimer = undefined;
    }
  }

  /** Only parsed, user-meaningful stream output or a completed tool event renews the CLI watchdog. */
  private noteMaterialOutput(): void {
    if (!this.turnWatchdogActive) {
      return;
    }
    this.firstMaterialOutputSeen = true;
    this.lastMaterialOutputAt = Date.now();
    this.armIdleWatchdog();
  }

  private armIdleWatchdog(): void {
    if (!this.turnWatchdogActive) {
      return;
    }
    if (this.idleWatchdogTimer) {
      clearTimeout(this.idleWatchdogTimer);
    }
    const budget = this.streamReadBudget();
    const delay = this.firstMaterialOutputSeen ? budget.idleMs : budget.firstChunkMs;
    this.idleWatchdogTimer = setTimeout(() => {
      if (!this.turnWatchdogActive) {
        return;
      }
      const idleMs = Date.now() - this.lastMaterialOutputAt;
      if (idleMs < delay) {
        this.armIdleWatchdog();
        return;
      }
      this.turnWatchdogActive = false;
      this.idleWatchdogTimer = undefined;
      this.emit({ kind: 'watchdog_idle', idleMs });
    }, delay);
  }

  private streamReadBudget(): Pick<StreamReadBudget, 'firstChunkMs' | 'idleMs'> {
    const budget = this.deps.streamReadBudget;
    if (budget && Number.isFinite(budget.firstChunkMs) && budget.firstChunkMs >= 1
      && Number.isFinite(budget.idleMs) && budget.idleMs >= 1) {
      return budget;
    }
    // Preserve the existing test seam and user-visible default while allowing production to choose distinct
    // first-output and post-output windows.
    const configured = this.deps.idleWatchdogMs;
    const legacy = typeof configured === 'number' && Number.isFinite(configured) && configured >= 1
      ? configured
      : DEFAULT_CLAUDE_IDLE_WATCHDOG_MS;
    return { firstChunkMs: legacy, idleMs: legacy };
  }
}

/**
 * The fail-closed hook asset always ships at `out/claudeToolGate.cjs`, but this module's `__dirname` differs
 * by build layout: **unbundled** it is `out/backend/` (so the hook is one level up), while the **bundled**
 * VSIX collapses every module into `out/extension.js` (so `__dirname` is already `out/`). Guessing with a
 * single `..` resolved to the extension ROOT in the packaged build — the hook was unreadable and Claude
 * refused to start (fail-closed did its job, but no Claude agent could run). Try both layouts. The extension
 * also passes an explicit `toolGateScriptPath`; this is the defense-in-depth fallback for other hosts/tests.
 */
export function resolveToolGateScript(baseDir: string, exists: (p: string) => boolean = fs.existsSync): string {
  const candidates = [
    path.resolve(baseDir, 'claudeToolGate.cjs'),       // bundled: out/extension.js → out/claudeToolGate.cjs
    path.resolve(baseDir, '..', 'claudeToolGate.cjs'), // unbundled: out/backend/… → out/claudeToolGate.cjs
  ];
  return candidates.find((candidate) => exists(candidate)) ?? candidates[0];
}

function defaultToolGateScriptPath(): string {
  return resolveToolGateScript(__dirname);
}

/**
 * Derive delegation evidence from a Claude native tool call. Write/Edit/NotebookEdit record the touched
 * path as a framework-observed change (so a Claude teammate's writes are visible like OpenAI-compat's, and
 * a verified write can reach `verified`); a write whose path we can't read counts as an unrecorded mutation.
 * Bash/PowerShell only count as an unrecorded mutation when the command looks mutating — a read-only
 * grep/ls/git-log research turn must NOT be forced to `replied-not-verified`.
 */
function recordClaudeToolEvidence(
  name: unknown,
  input: unknown,
  ev: { unrecordedWrites?: boolean; changedFiles: Set<string> }
): void {
  const tool = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (tool === 'write' || tool === 'edit' || tool === 'notebookedit') {
    const path = claudeToolFilePath(input);
    if (path) { ev.changedFiles.add(path); } else { ev.unrecordedWrites = true; }
    return;
  }
  if (tool === 'bash' || tool === 'powershell') {
    if (looksMutatingShellCommand(claudeToolCommand(input))) { ev.unrecordedWrites = true; }
  }
}

function claudeToolFilePath(input: unknown): string | undefined {
  const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : undefined;
  const p = rec?.file_path ?? rec?.notebook_path ?? rec?.path;
  return typeof p === 'string' && p.trim() ? p.trim() : undefined;
}

/** Source-specific native receipt. Glob/Grep prove a search happened, not that one declared file was read. */
function claudeTaskReadPath(name: unknown, input: unknown): string | undefined {
  return typeof name === 'string' && name.trim().toLowerCase() === 'read'
    ? claudeToolFilePath(input)
    : undefined;
}

function claudeToolCommand(input: unknown): string {
  const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : undefined;
  const c = rec?.command ?? rec?.script;
  return typeof c === 'string' ? c : '';
}

/** Heuristic: does a shell command mutate the filesystem/repo? Blacklist, so a read-only research command
 *  reaches `verified`; only clear mutations set the unrecorded-write flag. */
function looksMutatingShellCommand(command: string): boolean {
  if (!command) { return false; }
  return (
    /(^|[\s;&|(])(rm|rmdir|mv|cp|dd|mkdir|touch|tee|chmod|chown|ln|truncate|shred|rsync)\b/i.test(command) ||
    />>?/.test(command) || // redirection into a file
    /\bgit\s+(commit|checkout|reset|clean|apply|stash|rm|mv|push|restore|revert|merge|rebase)\b/i.test(command) ||
    /\b(npm|yarn|pnpm)\s+(i|install|add|remove|uninstall)\b/i.test(command) ||
    /\bpip\s+install\b|\bsed\b[^\n]*\s-i|\bmake\b/i.test(command)
  );
}

function flattenClaudeContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') {
          return block;
        }
        if (block && typeof block === 'object' && typeof (block as Record<string, unknown>).text === 'string') {
          return String((block as Record<string, unknown>).text);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : String(content);
}

function nativeToolPath(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function nativeToolClass(toolName: string): string {
  const normalized = toolName.trim().toLowerCase();
  if (CLAUDE_WRITE_TOOLS.some((tool) => tool.toLowerCase() === normalized)) {
    return 'file-write tool';
  }
  if ((CLAUDE_SHELL_TOOLS as readonly string[]).some((tool) => tool.toLowerCase() === normalized)) {
    return 'shell-command tool';
  }
  if (normalized === 'enterworktree' || normalized === 'exitworktree') {
    return 'worktree-management tool';
  }
  if (CLAUDE_EXTERNAL_EFFECT_TOOLS.has(normalized)) {
    return 'external-effect tool';
  }
  if (UNMEDIATED_SUBAGENT_TOOLS.has(normalized)) {
    return 'native-delegation tool';
  }
  if (normalized === 'toolsearch') {
    return 'tool-discovery tool';
  }
  return 'unrecognized native tool';
}

/** Build the same before/after shape used by the existing write-approval card where Claude's native
 * Write/Edit inputs make that possible. A novel shape intentionally falls back to explicit tool approval. */
function nativeWritePreview(
  cwd: string,
  toolName: string,
  input: Record<string, unknown>
): { path: string; before: string | null; after: string } | undefined {
  const requested = nativeToolPath(input);
  if (!requested) {
    return undefined;
  }
  const absolute = path.resolve(cwd, requested);
  let before: string | null = null;
  try {
    before = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return undefined;
    }
  }
  const tool = toolName.trim().toLowerCase();
  if (tool === 'write' && typeof input.content === 'string') {
    return { path: requested, before, after: input.content };
  }
  if (tool === 'edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string' && before !== null) {
    const replaceAll = input.replace_all === true;
    const after = replaceAll
      ? before.split(input.old_string).join(input.new_string)
      : before.replace(input.old_string, input.new_string);
    return { path: requested, before, after };
  }
  return undefined;
}

function nativeToolEffect(toolName: string, input: Record<string, unknown>): string {
  const path = nativeToolPath(input);
  const tool = toolName.trim();
  if (tool === 'EnterWorktree') {
    return 'Create or enter a Claude worktree (a new working directory and branch).';
  }
  if (tool === 'ExitWorktree') {
    return 'Leave or remove a Claude worktree.';
  }
  if (tool === 'Artifact') {
    return 'Create or publish a Claude artifact.';
  }
  if (/^Cron/i.test(tool)) {
    return `Change Claude scheduled work with ${tool}.`;
  }
  if (/^(RemoteTrigger|PushNotification|ScheduleWakeup|SendMessage)$/i.test(tool)) {
    return `Perform the external effect requested by Claude ${tool}.`;
  }
  return `${tool}${path ? ` for ${path}` : ''} requires approval before it runs.`;
}

/** Only the three extension-owned local bridge IDs bypass the generic unknown-tool approval. Do not use a
 * `mcp__unode_` prefix: a user-controlled MCP server can choose that spelling. */
function isUnodeLocalMcpTool(tool: string): boolean {
  return UNODE_LOCAL_MCP_TOOL_PREFIXES.some((prefix) => tool.startsWith(prefix));
}

function summarizeToolResult(detail: string): string {
  const flat = detail.replace(/\s+/g, ' ').trim();
  if (!flat) {
    return '(no output)';
  }
  return flat.length > 200 ? `${flat.slice(0, 199)}...` : flat;
}
