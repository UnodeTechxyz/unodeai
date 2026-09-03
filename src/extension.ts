/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Extension Entry Point
 *  Wires SessionManager + MessageBus + backends + SecretStorage + persistence + VS Code UI.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SessionManager, TypedSessionEvent } from './session/SessionManager';
import { isCoordinator } from './session/CoordinatorIdentity';
import { createEffectiveExecutionIdentity, type EffectiveExecutionIdentity } from './session/EffectiveExecutionIdentity';
import { assertNoFolderAccessWorktreeConflict } from './session/folderAccessWorktreeConflict';
import { MessageBus } from './bus/MessageBus';
import { AgentConfigBuilder, DEFAULT_MODEL_TIERS, ROLE_TEMPLATES, modelForRole } from './roles/RoleConfig';
import {
  adoptCurrentPromptTemplate,
  dismissPromptTemplateUpdate,
  migratePromptTemplateSource,
  promptTemplateStatus,
  recordCustomRoleSave,
  recordSystemPromptSave,
  retainReplacedPrompt,
  templatePromptDiff,
  undoAdoptCurrentPromptTemplate,
} from './roles/PromptTemplateState';
import { selectTier, resolveModelTiers, modelForTier } from './workflow/SmartMode';
import * as fs from 'fs/promises';
import { existsSync, realpathSync, statSync, readFileSync, watch as watchFile } from 'node:fs';
import * as path from 'path';
import { RulesFile, rulesFilePath } from './session/RulesFile';
import { ProjectKnowledge } from './session/ProjectKnowledge';
import { SharedMemory, memoryFilePath, type MemoryNoteKind } from './session/SharedMemory';
import { decideFixtureApiKeyAction, isE2EFixtureRequest } from './testing/E2EFixture';
import { ProjectConventions, resolveVerifyCommand } from './session/ProjectConventions';
import { DiagnosticItem, expandContextMentions } from './session/ContextMentions';
import { parseMentions } from './session/FileMentions';
import { ContextManifestSource, createTurnContextManifest, delegatedContentManifestSource, textContextSource } from './session/TurnContextManifest';
import { ContentAssetStore } from './content/ContentAssetStore';
import { TaskInputResolver, type TaskAttemptCard } from './backend/TaskContract';
import { TeamPolicyStore } from './policy/TeamPolicy';
import { evaluateReviewPolicy, type ReviewPolicyPreflightDecision } from './policy/ReviewPolicyPreflight';
import { secretPatternSignals } from './security/secretPatterns';
import { formatUserTextAttachments, splitUserAttachments } from './attachments';
import { buildEvidenceReport, EvidenceChecks, EvidenceWorkStatus } from './backend/evidenceReport';
import { shouldRestartAfterAgentConfigEdit } from './session/sessionLifecycle';
import { decideContextWindowMeasurement } from './contextWindowDefaults';
import { automaticSnapshotSlug, automaticSnapshotsToPrune, describeTeamEntry, teamSlug, type TeamLibraryEntry, type TeamLibraryRef } from './state/TeamLibrary';
import { compactOutcomeMessage } from './session/compactOutcome';
import {
  AgentBackendKind,
  AgentConfig,
  AgentModelParams,
  ContextWindowMeasurement,
  ContextWindowUsage,
  FolderGrant,
  Message,
  ModelTier,
  SmartModeConfig,
  UserAttachment,
} from './types';
import { TeamViewProvider } from './views/TeamViewProvider';
import { DashboardProvider } from './views/DashboardProvider';
import { MessageLogProvider } from './views/MessageLogProvider';
import { ChatRepairState, ChatViewProvider } from './views/ChatViewProvider';
import {
  ADD_SELECTION_TO_UNODE_COMMAND,
  isAcceptableComposerPayloadLength,
  SelectionComposerPayload,
  SelectionToUnodeActionProvider,
} from './editor/SelectionToUnodeAction';
import { firstRunDestination } from './views/firstRunDestination';
import { restoreTargetForRow } from './views/checkpointSummary';
import { distinctAgentIcon, iconForSavedAgent } from './roles/agentIconPalette';
import { SessionPresentationModel } from './views/sessionPresentation';
import {
  CHECKPOINT_SCHEME,
  LANE_BASE_SCHEME,
  checkpointDiffTitle,
  checkpointRef,
  laneBaseRef,
  laneDiffTitle,
  parseCheckpointRef,
  parseLaneBaseRef,
} from './views/diffUris';
import { OrchestrationProgressTracker } from './views/orchestrationProgress';
import { summarizeArchive } from './views/chatArchive';
import { registerUnodeChatParticipant } from './chat/UnodeChatParticipant';
import { WorkflowEditor } from './views/WorkflowEditor';
import { OnboardingWizard } from './views/OnboardingWizard';
import { resolveHttpsExternalUrl } from './views/webviewSecurity';
import {
  openTeamRulesPanel,
  defaultTeamRules,
  syncTeamRulesWithRoster,
  TeamRosterMember,
  TeamRulesKind,
  TEAM_RULES_PRESETS,
  teamKindFromSkills,
} from './views/TeamRulesPanel';
import { WorkflowEngine } from './workflow/WorkflowEngine';
import { TierController } from './workflow/TierController';
import { SecretsManager } from './secrets/SecretsManager';
import {
  storeUserInitiatedProviderKey,
  type UserInitiatedProviderKeyStoreInput,
} from './secrets/UserInitiatedProviderKeyStore';
import { PersistenceManager } from './state/PersistenceManager';
import { BackgroundPersistenceReporter, runBackgroundPersistence } from './state/BackgroundPersistenceReporter';
import {
  ClaudeHeadlessBackend,
  ClaudeHeadlessBackendDeps,
  ClaudeToolApprovalDecision,
  ClaudeToolApprovalRequest,
} from './backend/ClaudeHeadlessBackend';
import { OpenAICompatBackend } from './backend/OpenAICompatBackend';
import { capabilityProfileForAgent } from './capabilities/CapabilityProfile';
import { EngineOptions, FileDiagnostic } from './backend/Diagnostics';
import { sanitizedCommandEnv } from './backend/commandEnv';
import { resolveInsideRoot, resolveInsideRootPhysical } from './backend/workspacePath';
import { createUnifiedDiff } from './backend/diff';
import { SessionWebAccessApprover, WebAccessApprovalRequest, WebAccessDecision, WEB_ACCESS_HUMAN_WINDOW_MS } from './backend/WebAccessPolicy';
import { requireHttpsCustomEndpoint, resolveOpenAICompatBaseUrl, OPENAI_COMPAT_DEFAULT_BASE_URL, ROAM_DEFAULT_BASE_URL, UNODE_DEFAULT_BASE_URL } from './backend/openAICompatBaseUrl';
import { webFetch } from './backend/webFetch';
import { AgentBackend, EgressConsentPending } from './backend/AgentBackend';
import { TaskScopeCapability, TeamRosterEntry } from './backend/TeamTools';
import type { VerificationSensorKind } from './backend/VerificationPlan';
import {
  constructApprovedExecutionHooks,
  normalizeExecutionHookCandidate,
  type ExecutionHookApprovalRecord,
  type NormalizedExecutionHookCandidate,
} from './backend/ExecutionHooks';
import { FileCoordinator, OptimisticFileCoordinator, NoopFileCoordinator } from './backend/FileCoordinator';
import { WorktreeManager, WORKTREES_DIR } from './backend/WorktreeManager';
import { GitMergeOrchestrator } from './backend/MergeOrchestrator';
import { WorktreeCoordinator } from './backend/WorktreeCoordinator';
import { Verifier } from './backend/Verifier';
import { DEFAULT_COMPLETION_GATE_CONFIG } from './backend/completionGate';
import { spawn as cpSpawn } from 'child_process';
import { randomBytes } from 'crypto';
import { resolveEffectiveRoots, writeRootsForTrust } from './backend/folderAccess';
import { killProcessTree } from './backend/processTree';
import { WorktreePanel, WorktreeReview } from './views/WorktreePanel';
import { TaskClaimRegistry } from './backend/TaskClaimRegistry';
import { CommandPolicy, CommandApprovalMode, SAFE_COMMAND_TEMPLATES, windowsCmdletCompatibilityWarning } from './backend/CommandPolicy';
import { AgentCommandPolicy } from './backend/AgentCommandPolicy';
import { CheckpointOperation, CommandApprovalDecision, CommandApprover, WorkspaceTools } from './backend/WorkspaceTools';
import type { ContentReceiptObservation } from './content/ContentReceipt';
import {
  formatPromptedCommandLog,
  PromptedCommandLog,
  SerializedPromptedCommandLog,
} from './backend/PromptedCommandLog';
import { gateShellCommand } from './backend/ShellCommandGate';
import { normalizeRunnerCommand } from './backend/commandNormalize';
import { defaultBackendKind } from './backend/backendKind';
import {
  agentRouteFromLegacyConfig,
  apiKeySecretNameForRoute,
  assertActiveConnectionProfile,
  assertAgentConfigApiKeyOwnership,
  authIdentityRefForRoute,
  captureActiveConnectionProfile,
  connectionIdForProviderId,
  connectionProfile,
  displayNameForProviderId,
  CONNECTION_PROFILES,
  BUILTIN_CONNECTION_REGISTRY,
  ConnectionResolver,
  legacyProviderIdForConnectionId,
  providerRefForConnectionId,
  routeForConnectionId,
  resolveAvailableDefaultProviderId,
} from './routes/ConnectionRegistry';
import { migrateAgentConfigOrRepair, RouteMigrationError } from './routes/RouteMigration';
import {
  assertAgentCapabilityCompatibility,
  capabilityViolations,
  connectionProfileForAgent,
  supportedModelParams,
  unsupportedModelParamKeys,
} from './routes/CapabilityGuard';
import {
  AgentRoute,
  assertResolvedRoute,
  coordinatorBriefEgressDestinationKey,
  createResolvedAgentRoute,
} from './routes/RouteContracts';
import { CodexBackend, isSupportedCodexCliVersion } from './backend/CodexBackend';
import { resolveCodexCliLaunchPath } from './backend/codexCliPath';
import { TerminalManager } from './terminal/TerminalManager';
import { Checkpoint, CheckpointRestoreDisabledReason, CheckpointStore, checkpointRestoreDisabledMessage } from './backend/Checkpoints';
import { promptCommandApproval, showBlockedWarning } from './backend/CommandApprovalPrompter';

import { MCPServerConfig } from './types';
import { MCPHub, McpServerGrant } from './mcp/MCPHub';
import { createRealMcpClient } from './mcp/RealMcpClient';
import { buildClaudeMcpConfig } from './mcp/ClaudeMcpConfig';
import { createLocalMcpServer, LocalMcpServer } from './mcp/LocalMcpServer';
import { TeamMcpBridge } from './mcp/TeamMcpBridge';
import { SkillResolver, agentMcpGrants } from './roles/SkillResolver';
import { SKILL_LIBRARY } from './roles/RoleConfig';
import { SkillRegistry } from './skills/SkillRegistry';
import { ModelCatalog, ModelInfo } from './models/ModelCatalog';
import { resolveModelCatalogBaseUrl } from './models/modelCatalogBaseUrl';
import { intentionallyUnknownPriceLabel, ModelPricing, DEFAULT_MODEL_PRICES, ModelPrice } from './models/ModelPricing';
import { LivePriceService, consentedSources, describeGroupRatio, readPriceGroupSetting, readPriceMultiplierSetting, scopedSources } from './models/LivePriceService';
import {
  MetadataHostPlan, describePurposes, planModelPicker, planPriceRefresh, unapprovedHosts,
} from './models/metadataPlan';
import { BalanceService } from './models/BalanceService';
import { repairPriceMultipliers, type PriceMultiplierReadRepairResult } from './models/PriceMultiplierReadRepair';
import { createMetadataTransport } from './host/MetadataTransport';
import { registerCommand } from './host/CommandRegistration';
import { registerUnodeSidebarViews } from './host/ViewRegistration';
import { vscodeSettings } from './host/VscodeHostPorts';
import { OrchestrationHostAdapter, admitDelegationContentSources } from './host/orchestration/OrchestrationHostAdapter';
import { registerOrchestrationCommands } from './host/orchestration/OrchestrationCommandRegistration';
import { SettingsBridge, ProviderDef, ConfigStore } from './settings/SettingsBridge';
import { createVSCodeCustomGatewayProfileStore } from './connections/CustomGatewayProfileStoreVscode';
import { CustomGatewayProfileStore } from './connections/CustomGatewayProfileStore';
import { CUSTOM_GATEWAY_REGISTRY_FILE_NAME } from './connections/CustomGatewayProfile';
import { loadCustomGatewayRegistryFailClosed } from './connections/CustomGatewayRegistryLoadContainment';
import { legacyMigrationRosterSignature } from './connections/LegacyMigrationRosterSignature';
import { PersistentLegacyCustomMigrationDeclines } from './connections/PersistentLegacyCustomMigrationDeclines';
import { isCustomGatewayEditBlockedStatus } from './connections/CustomGatewayEditGuard';
import { customGatewayEditBlockedMessage, customGatewayRemoveBlockedMessage } from './connections/CustomGatewayHelp';
import { testApiKeyConnection } from './connections/ConnectionTest';
import {
  assertCustomGatewayRegistryWatchCurrent,
  CustomGatewayRegistryWatchSupervisor,
} from './connections/CustomGatewayRegistryWatchSupervisor';
import {
  LEGACY_CUSTOM_PROVIDER_ID,
  LegacyCustomGatewayMigrationPlan,
  applyLegacyCustomGatewayMigration,
  hasOnlyTerminalLegacyCustomRepairs,
  isLegacySingletonCustomAgent,
  legacyCustomSecretName,
  pendingLegacyCustomMigrationAgents,
  planLegacyCustomGatewayMigration,
} from './connections/LegacyCustomGatewayMigration';
import { ModelParamResolver, modelParamDefaultLabels } from './params/ModelParamResolver';
import { sanitizeParams } from './params/sanitizeModelParams';
import { SettingsPanel } from './views/SettingsPanel';
import { SecurityPanel } from './views/SecurityPanel';
import { ConsentGrantKind, ConsentGrantRegistry, MediaConsentKind } from './security/ConsentGrants';
import { describeMediaEgress, MediaEgressRequest, validateMediaEgressRequest } from './media/MediaEgress';
import { MediaCapabilityCache } from './media/MediaCapability';
import { MarketplacePanel, asMarketplaceTab } from './views/MarketplacePanel';
import { AgentBuilderPanel, AgentBuilderSavePayload, AgentBuilderViewModel } from './views/AgentBuilderPanel';
import { CoalescedPanelRefresh } from './views/PanelRefreshControl';
import { MAX_AGENT_ICON_BYTES } from './views/agentIcon';
import { MarketplaceCatalog, MarketplaceInstallAction, CatalogSourceName, McpCatalogEntry } from './marketplace/catalog';
import {
  RawCatalog, resolveCatalog, CATALOG_PUBLIC_KEY_PEM, describeHostedCatalogStatus, lastHostedCatalogOutcome,
} from './marketplace/catalogSource';
import { toAgentConfig, toMcpServerConfig, mountSkillPlaybooks, applyPlaybooks } from './marketplace/install';
import {
  createChatExportPayload,
  createMessagesExportPayload,
  parseChatImportPayload,
  parseMessagesImportPayload,
} from './views/transcriptPort';
import { LlmSummarizer } from './session/Summarizer';
import { PendingDelegationResults } from './state/PendingDelegationResults';
import { RunLedger, RunPermissionDecision, RunPermissionKind, RunRouteReceipt } from './observability/RunLedger';
import { renderRunEvidencePack, renderWorkerTaskProgressReport } from './observability/RunEvidencePack';
import { buildPortableRunEvidence } from './observability/PortableRunEvidence';
import {
  acceptanceRunPickerDescription,
  markdownRunExportPickerLabel,
  portableRunExportPickerLabel,
  runAcceptanceEvidence,
  runEvidenceExportConfirmation,
} from './views/runCloseoutPresentation';
import { approvalKey, needsApproval } from './mcp/McpApproval';
import { resolveServerPlaceholders } from './mcp/McpPlaceholders';
import { GuidedMcpTransport, isValidMcpUrl, parseMcpArgs, parseMcpEnvInput } from './mcp/McpForm';
import { DEMO_TASKS } from './state/DemoTasks';
import * as dialogs from './dialogs';
import { DialogDeps } from './dialogs';

let sessionManager: SessionManager;
let messageBus: MessageBus;
let taskInputResolver: TaskInputResolver;
let orchestrationHost: OrchestrationHostAdapter;
let workflowEngine: WorkflowEngine;
let teamViewProvider: TeamViewProvider;
const terminalManager = new TerminalManager();
const checkpointStore = new CheckpointStore();
let checkpointSaveTimer: ReturnType<typeof setTimeout> | undefined;
let dashboardProvider: DashboardProvider;
/** The open Dashboard webview panel (retained so the N-control + task events can re-render it). */
let dashboardPanel: vscode.WebviewPanel | undefined;
let dashboardRefreshTimer: ReturnType<typeof setTimeout> | undefined;
/** Re-render the Dashboard panel if it's open. */
async function refreshDashboardPanel(): Promise<void> {
  if (!dashboardPanel) { return; }
  try {
    dashboardPanel.webview.html = await dashboardProvider.getDashboardHtml(dashboardPanel.webview);
  } catch { /* a refresh failure must never throw into an event handler */ }
}
/**
 * Coalesce Dashboard re-renders. Usage events arrive per streamed chunk; rebuilding the whole webview that
 * often would thrash it (and reset scroll). One trailing render per burst is enough to look live.
 */
function scheduleDashboardRefresh(): void {
  if (!dashboardPanel || dashboardRefreshTimer) { return; }
  dashboardRefreshTimer = setTimeout(() => {
    dashboardRefreshTimer = undefined;
    void refreshDashboardPanel();
  }, 500);
}
let messageLogProvider: MessageLogProvider;
let chatViewProvider: ChatViewProvider;
// The New Task sidebar and Activity panel are projections of this one host-owned model.
// UX2 will receive the same instance rather than creating another session authority.
const sessionPresentation = new SessionPresentationModel();
let orchestrationProgress: OrchestrationProgressTracker;
let secrets: SecretsManager;
let persistence: PersistenceManager;
/** Settled coordinator results that have not yet reached await_tasks or an auto-wake turn. */
let pendingDelegationResults: PendingDelegationResults;
/** Durable, run-scoped mechanical observations. Exported independently from the rolling message log. */
let runLedger: RunLedger;
/** Serialize workspaceState writes so a result cannot be resurrected by an earlier retain write. */
let pendingDelegationResultsSave: Promise<void> = Promise.resolve();
let fileCoordinator: FileCoordinator;
/** Worktree fan-out (v0.6.x): isolates eligible agents in per-agent worktrees + merges them back. */
let worktreeCoordinator: WorktreeCoordinator | undefined;

/** Shared across all coordinator agents so parallel file-ownership claims are workspace-global. */
const taskClaims = new TaskClaimRegistry();
let commandPolicy: CommandPolicy;
let mcpHub: MCPHub;
let modelCatalog: ModelCatalog | undefined;
let pricing: ModelPricing | undefined;
let livePrices: LivePriceService | undefined;
/** When the live price table was last refreshed. A money figure with no timestamp has no provenance. */
let lastPriceRefreshAt: string | undefined;
/** Measurements obtained only from a user-triggered model-picker response; never populated at activation. */
const discoveredContextWindows = new Map<string, ContextWindowMeasurement>();
let balanceService: BalanceService | undefined;
/** One user-triggered repair at a time. Two commands must not race to write the same global setting. */
let priceMultiplierReadRepairInFlight: Promise<PriceMultiplierReadRepairResult> | undefined;
let settingsBridge: SettingsBridge;
let effectiveConnectionRegistry: ConnectionResolver = BUILTIN_CONNECTION_REGISTRY;
let customGatewayProfileStore: CustomGatewayProfileStore;
let customGatewayRegistryPath = '';
let customGatewayRegistryLoadFailureReported = false;
let customGatewayRegistryWatchSupervisor: CustomGatewayRegistryWatchSupervisor | undefined;
const panelRefreshCoalescer = new CoalescedPanelRefresh(() => {
  SettingsPanel.refreshCurrent();
  AgentBuilderPanel.refreshCurrent();
  OnboardingWizard.refreshCurrent();
});
let rulesFile: RulesFile;
let teamPolicyStore: TeamPolicyStore;
let projectKnowledge: ProjectKnowledge;
let teamRulesRosterSyncTimer: ReturnType<typeof setTimeout> | undefined;
let sharedMemory: SharedMemory;
let projectConventions: ProjectConventions;
const skillResolver = new SkillResolver(SKILL_LIBRARY);

/** One evaluator for delegated, queued, retry/fallback and coordinator-only attempt admission. */
function admitArtifactReviewAttempt(
  attempt: TaskAttemptCard,
  reviewerIdentity?: EffectiveExecutionIdentity,
): ReviewPolicyPreflightDecision {
  taskInputResolver.bindAttemptExecutionIdentity(attempt.attemptId, reviewerIdentity);
  const facts = taskInputResolver.reviewPolicyFacts(attempt.attemptId);
  const decision = evaluateReviewPolicy({
    review: facts.review,
    policy: teamPolicyStore.current(),
    authorIdentity: facts.authorIdentity,
    reviewerIdentity,
  });
  if (decision.allowed) taskInputResolver.recordReviewAdmission(attempt.attemptId, decision);
  return decision;
}
/** Team-level MCP server registry (id -> config), loaded from .unode/team.json. */
const mcpRegistry = new Map<string, MCPServerConfig>();
const WORKSPACE_CONTEXT_ACTIVE_FILE_CHAR_CAP = 12000;
const WORKSPACE_CONTEXT_ACTIVE_FILE_LINE_CAP = 150;
const WORKSPACE_CONTEXT_DIAGNOSTIC_LIMIT = 40; // bounded so diagnostics don't crowd out the file within the backend's ~6 KB cap
const WORKSPACE_TREE_FILE_CAP = 200; // bounded file listing — enough to ground the model, capped to stay small
const LEGACY_CUSTOM_GATEWAY_MIGRATION_KEY = 'unode.migration.legacyCustomGateway.v1';
const LEGACY_CUSTOM_GATEWAY_TERMINAL_REPAIRS_KEY = 'unode.migration.legacyCustomGateway.terminalRepairs.v1';

interface LegacyCustomGatewayMigrationState {
  schemaVersion: 1;
  sourceAgentIds: readonly string[];
  plan: LegacyCustomGatewayMigrationPlan;
}

interface LegacyCustomGatewayTerminalRepairState {
  schemaVersion: 1;
  agentIds: readonly string[];
}

/** A compact, relative file listing of the workspace so the model uses REAL paths instead of
 *  confabulating an absolute sandbox path (the grounding Cline/Kilo provide by default). Respects the
 *  user's files.exclude/search.exclude via findFiles, and skips heavy build/vendor dirs. */
async function listWorkspaceTree(root: string): Promise<string> {
  let uris: vscode.Uri[];
  try {
    uris = await vscode.workspace.findFiles(
      '**/*',
      '**/{node_modules,.git,dist,out,build,.next,coverage,.venv,venv,__pycache__,target,bin,obj}/**',
      WORKSPACE_TREE_FILE_CAP
    );
  } catch {
    return '';
  }
  if (uris.length === 0) { return ''; }
  const rels = uris
    .map((u) => path.relative(root, u.fsPath).split(path.sep).join('/'))
    .filter((r) => r && !r.startsWith('..'))
    .sort();
  if (rels.length === 0) { return ''; }
  const capped = rels.length >= WORKSPACE_TREE_FILE_CAP;
  return rels.join('\n') + (capped ? '\n… (listing capped — use list_dir / search_files for the rest)' : '');
}
/** Sensitive MCP servers the user has approved to mount (persisted; P1#4). */
const approvedMcp = new Set<string>();
/** Debounce handle for persisting message history (P1#5). */
let messageSaveTimer: NodeJS.Timeout | undefined;
let runSaveTimer: NodeJS.Timeout | undefined;

/** One Output channel per agent, holding that agent's own transcript (assistant text + tools). Keyed by id,
 *  but the resolved NAME is kept too — see getAgentChannel: a channel cannot be renamed, so we rebuild it
 *  when the name it was created with turns out to be wrong. */
const agentChannels = new Map<string, { name: string; channel: vscode.OutputChannel }>();

function resolveAgentName(id: string): string {
  if (id === 'user') { return 'You'; }
  if (id === '*') { return 'everyone'; }
  if (id === 'workflow') { return 'Workflow'; }
  return sessionManager?.get(id)?.config.name ?? id;
}

/**
 * An Output channel's name is fixed at creation and VS Code cannot rename one — so a name resolved from a
 * roster that isn't loaded yet gets BAKED IN as a raw UUID, permanently. That is why "UnodeAi · Project
 * Manager" could be missing from the dropdown while a `UnodeAi · 9c922492-…` channel sat there instead, and
 * why renaming an agent left its channel stuck on the old name forever.
 *
 * So key the cache on the name as well as the id, and rebuild the channel when the name changes. Rebuilding
 * loses that channel's scrollback, which is a fair price for a channel the user can actually find — and it
 * only happens on a rename or a late-resolving roster, not in the steady state.
 */
function getAgentChannel(id: string): vscode.OutputChannel {
  const name = `UnodeAi · ${resolveAgentName(id)}`;
  const existing = agentChannels.get(id);
  if (existing) {
    if (existing.name === name) {
      return existing.channel;
    }
    existing.channel.dispose();
  }
  const channel = vscode.window.createOutputChannel(name);
  agentChannels.set(id, { name, channel });
  return channel;
}

/** Commit this bundle was built from — injected by esbuild (`define`). `tsc`-only builds and tests never
 *  define it, hence the guard: this must never be the thing that breaks a build. */
declare const __BUILD_SHA__: string | undefined;
const BUILD_SHA: string = typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'dev';

let outputChannel: vscode.LogOutputChannel;
let statusBarItem: vscode.StatusBarItem;
const PROMPTED_COMMAND_LOG_KEY = 'unode.promptedCommandLog.v1';
const promptedCommandLog = new PromptedCommandLog();
let promptedCommandLogSave: Promise<void> = Promise.resolve();
let promptedCommandOutputChannel: vscode.OutputChannel | undefined;
/** Global, click-through approval signal. The version/status anchor remains separate. */
let approvalStatusBarItem: vscode.StatusBarItem | undefined;
/**
 * The brake. Visible only while something is running, and one click from anywhere.
 *
 * `UnodeAi: Stop All Agents` already existed, in the Team panel's overflow menu. Field report, 2026-08-21:
 * a user asked their coordinator to stop everything and was told to open each agent's Workbench and press
 * Stop one at a time — because the coordinator does not know this command exists either. **A control buried
 * in a menu is not a brake.** Nothing about the stop was missing except being able to reach it in the second
 * you want it.
 */
let stopAllStatusBarItem: vscode.StatusBarItem | undefined;
let unodeVersion = ''; // set at activate; kept in every status-bar text so the version always shows

// ─── Network egress consent ───────────────────────────────────────────
// No prompt or code leaves the machine until the user has explicitly approved the destination gateway
// host. Consent is per-host and persisted (globalState), so each provider is confirmed once.
let extensionContext: vscode.ExtensionContext | undefined;
/** True only while the Test-mode E2E fixture owns the offline key it wrote into an empty slot. */
let e2eFixtureCreatedApiKey = false;
const warnedUnsupportedDefaultProviderIds = new Set<string>();
const consentGrants = new ConsentGrantRegistry();
/** Runtime observations are scoped by route inside this process-only cache; they never rewrite settings. */
const mediaCapabilityCache = new MediaCapabilityCache();
const EGRESS_CONSENT_KEY = 'unode.egressConsentHosts';
/** Media uploads are a distinct, class-specific decision; model-host approval never implies this grant. */
const MEDIA_EGRESS_CONSENT_KEY = 'unode.mediaEgressConsent';
/**
 * The SECOND, weaker consent: hosts approved for METADATA only — the gateway's price list and, if a key is
 * stored, that account's discount tier and balance. No prompt, no code, no workspace content, ever.
 *
 * It is a separate set because reusing the model-egress consent for a price fetch would require showing the
 * model-egress modal ("UnodeAi is about to send this agent's prompt — and any workspace files it includes")
 * to authorize a request that sends none of those things. That is not a consent dialog, it is a false
 * statement. Two questions, two prompts, each true.
 *
 * The implication runs one way and only one way: approving a host to receive YOUR CODE necessarily approves
 * it to receive a price query (see hasMetadataConsent). The reverse must never hold — letting a user's "yes,
 * fetch prices" silently authorize shipping their source code would be the exact escalation this whole gate
 * exists to prevent.
 */
const METADATA_CONSENT_KEY = 'unode.metadataConsentHosts';
const EXECUTION_HOOK_APPROVAL_KEY = 'unode.executionHooks.approval.v1';

/** A setting's scope is part of what the user approves; no scope is ever active by itself. */
type ExecutionHookCandidateOrigin = 'workspace-folder' | 'workspace' | 'global' | 'default';

interface ExecutionHookCandidateSetting {
  value: unknown;
  origin: ExecutionHookCandidateOrigin;
}

function executionHookCandidateSetting(): ExecutionHookCandidateSetting {
  // Use a real workspace folder so folder-scoped settings are neither silently skipped nor given a
  // special auto-apply rule. workspaceState below keeps an approval local to this workspace.
  const resource = vscode.workspace.workspaceFolders?.[0]?.uri;
  const configuration = vscode.workspace.getConfiguration('unode', resource);
  const inspected = configuration.inspect<unknown>('executionHooks');
  if (inspected?.workspaceFolderValue !== undefined) {
    return { value: inspected.workspaceFolderValue, origin: 'workspace-folder' };
  }
  if (inspected?.workspaceValue !== undefined) {
    return { value: inspected.workspaceValue, origin: 'workspace' };
  }
  if (inspected?.globalValue !== undefined) {
    return { value: inspected.globalValue, origin: 'global' };
  }
  return { value: inspected?.defaultValue ?? [], origin: 'default' };
}

function activeExecutionHooks(
  context: vscode.ExtensionContext,
  options: { report?: boolean } = {},
): { hooks: ReturnType<typeof constructApprovedExecutionHooks>; candidate?: NormalizedExecutionHookCandidate } {
  const setting = executionHookCandidateSetting();
  let candidate: NormalizedExecutionHookCandidate;
  try {
    candidate = normalizeExecutionHookCandidate(setting.value);
  } catch (error) {
    if (options.report) {
      outputChannel.warn(`Execution hooks refused: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { hooks: undefined };
  }
  if (candidate.declarations.length === 0) {
    return { hooks: undefined, candidate };
  }
  const approval = context.workspaceState.get<ExecutionHookApprovalRecord>(EXECUTION_HOOK_APPROVAL_KEY);
  const hooks = constructApprovedExecutionHooks(candidate, approval, setting.origin);
  if (!hooks && options.report) {
    outputChannel.warn(
      `Execution hooks from ${setting.origin} settings are inert until you run "UnodeAi: Apply Execution Hooks". ` +
      'The recorded approval does not match this exact normalized declaration and origin.'
    );
  }
  return { hooks, candidate };
}

/** Show the exact candidate in a read-only editor before a human can record approval. */
async function applyExecutionHooks(context: vscode.ExtensionContext): Promise<void> {
  const setting = executionHookCandidateSetting();
  let candidate: NormalizedExecutionHookCandidate;
  try {
    candidate = normalizeExecutionHookCandidate(setting.value);
  } catch (error) {
    const message = `Execution hooks refused: ${error instanceof Error ? error.message : String(error)}`;
    outputChannel.warn(message);
    void vscode.window.showErrorMessage(message);
    return;
  }
  if (candidate.declarations.length === 0) {
    void vscode.window.showWarningMessage('No execution-hook declarations are configured to apply.');
    return;
  }
  const document = await vscode.workspace.openTextDocument({ content: candidate.normalized, language: 'json' });
  await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
  const choice = await vscode.window.showWarningMessage(
    'Apply the full execution-hook declaration shown in the editor? Hooks can only block actions; they cannot grant permissions.',
    {
      modal: true,
      detail: `Origin: ${setting.origin}. Digest: ${candidate.digest}. Any edit or origin change invalidates this approval.`,
    },
    'Apply hooks',
    'Cancel',
  );
  if (choice !== 'Apply hooks') {
    return;
  }
  const approval: ExecutionHookApprovalRecord = { version: 1, digest: candidate.digest, origin: setting.origin };
  await context.workspaceState.update(EXECUTION_HOOK_APPROVAL_KEY, approval);
  outputChannel.info(`Applied ${candidate.declarations.length} restrictive execution hook(s) from ${setting.origin} settings.`);
  void vscode.window.showInformationMessage('Execution hooks applied. Running agents enforce them at their next hook point.');
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

/** Ask once per gateway host before any model request. Returns false if the user declines (nothing is sent). */
async function ensureEgressConsent(
  host: string,
  requester: string,
  onPending?: (pending: EgressConsentPending) => void,
): Promise<boolean> {
  if (!host || consentGrants.has('model', host)) { return true; }
  // Start the visible decision before announcing the pending lifecycle.  The caller can then return an
  // actionable `consent_required` session state immediately, while this promise remains open for as long
  // as the user needs to read the modal (never a five-second human timeout).
  const choice = vscode.window.showWarningMessage(
    `UnodeAi is about to send this agent's prompt — and any workspace files it includes — to “${host}” to generate a response.\n\n` +
    `Your prompts and code go only to the AI provider you configure; UnodeAi has no servers of its own, no telemetry, and no other network destinations.\n\n` +
    `Allow UnodeAi to contact ${host}?`,
    { modal: true },
    'Allow',
    'Cancel'
  );
  onPending?.({
    host,
    message: `Consent required to contact ${host}. Respond to the open UnodeAi network-consent dialog to continue this agent.`,
  });
  if ((await choice) !== 'Allow') { return false; }
  if (consentGrants.grant('model', host, requester)) {
    await persistConsentGrants('model');
  }
  return true;
}

/** Egress hook passed to backends. Throws (aborting the request, before anything is sent) if the user declines. */
async function egressGate(
  url: string,
  onPending?: (pending: EgressConsentPending) => void,
  requester = 'Model request',
): Promise<void> {
  const host = hostOf(url);
  if (!(await ensureEgressConsent(host, requester, onPending))) {
    throw new Error(`Network egress to ${host} was declined — no prompt or code was sent. Approve the provider to use it.`);
  }
}

/**
 * Ask separately before bytes of an already-obtained asset go to a vision or transcription provider.
 * This is intentionally not `ensureEgressConsent`: that dialog truthfully covers prompts/workspace files,
 * while this one names the media class, bounded quantity and (when known) input price.
 */
async function mediaEgressGate(request: MediaEgressRequest, requester: string): Promise<void> {
  const safe = validateMediaEgressRequest(request);
  if (consentGrants.hasMedia(safe.host, safe.kind)) { return; }
  const choice = await vscode.window.showWarningMessage(
    `UnodeAi is about to upload ${safe.mediaClass} media to ${safe.provider} at ${safe.host} for ${safe.kind}.\n\n`
      + `${describeMediaEgress(safe)}\n\n`
      + 'This is separate from public-download and ordinary model-request approval. Allow this media upload?',
    { modal: true },
    'Allow',
    'Cancel',
  );
  if (choice !== 'Allow') {
    throw new Error(`Media ${safe.kind} upload to ${safe.host} was declined — no media bytes were sent.`);
  }
  if (consentGrants.grantMedia(safe.host, safe.kind, requester)) {
    await persistConsentGrants('media');
  }
}

/**
 * May we contact this host for METADATA (price list, discount tier, balance)? Read-only — never prompts.
 *
 * This is the gate for the extension's only two requests that no user action asks for. A convenience may
 * never be the thing that OPENS a network relationship:
 *
 *   a price refresh may RIDE ON a host the user already approved — it may never INITIATE one.
 *
 * v0.9.29 called refreshPrices() unconditionally from activate(), so a fresh install with no key, no
 * configured provider and no approved host still reached out to two vendor gateways the moment VS Code
 * finished starting. That is a phone-home on install: it contradicted this extension's own published promise
 * ("no telemetry, no other network destinations"; billing endpoints "only if a key is stored"), and
 * install→unsolicited-vendor-beacon is precisely the behavioural signature that gets an extension classified
 * as unwanted software — the most plausible explanation we have for the 0.9.8 takedown.
 *
 * Model-egress consent implies metadata consent (code is strictly more than a price query). Never the
 * reverse. (Codex, v0.9.29 Marketplace review.)
 */
function hasMetadataConsent(host: string): boolean {
  return !!host && (consentGrants.has('model', host) || consentGrants.has('metadata', host));
}

/**
 * THE fetch every metadata service is built on — prices, balance, and the model catalog (both its curated
 * `modelCatalogUrl` and the live `{base}/models` endpoint). It refuses any host the user has not approved,
 * before a packet moves.
 *
 * There is deliberately only ONE of these, and the services take it in their constructor, because the first
 * version of this fix put the check at the price CALL SITE — and review immediately found ModelCatalog
 * fetching straight past it. Guarding call sites means the next service someone adds is ungated by default.
 * Guarding the fetch means it is gated by default and there is nothing to remember.
 */
const metadataFetch = createMetadataTransport(hasMetadataConsent);

/**
 * Metadata services are intentionally created at their first actual use.  Constructing one is cheap, but
 * doing it eagerly hid the distinction between activation and a user reaching a metadata surface.  The
 * transport they receive remains consent-gated, so lazy construction is never permission to fetch.
 */
function getModelCatalog(): ModelCatalog {
  if (!modelCatalog) {
    modelCatalog = new ModelCatalog(
      (connectionId) =>
        (effectiveConnectionRegistry.connectionProfile(connectionId)?.catalogModels ?? []).map(
          (m): ModelInfo => ({ id: m.id, name: m.name, vision: m.vision, source: 'static' })
        ),
      metadataFetch,
      {
        catalogUrl: vscode.workspace.getConfiguration('unode').get<string>('modelCatalogUrl', '') || undefined,
        // Read on every call, not captured at activation: user-edited extra models apply without reload.
        userModels: (connectionId) => {
          const byConnection = vscode.workspace
            .getConfiguration('unode')
            .get<Record<string, unknown>>('extraModels', {}) ?? {};
          return (byConnection[connectionId] ?? []) as ModelInfo[];
        },
        canReadMetadata: (url) => hasMetadataConsent(hostOf(url)),
      },
    );
  }
  return modelCatalog;
}

function getPricing(): ModelPricing {
  if (!pricing) {
    const priceOverrides = vscode.workspace.getConfiguration('unode').get<Record<string, ModelPrice>>('modelPrices', {});
    pricing = new ModelPricing({ ...DEFAULT_MODEL_PRICES, ...priceOverrides });
  }
  return pricing;
}

function getLivePrices(): LivePriceService {
  return livePrices ??= new LivePriceService(metadataFetch, {
    canReadMetadata: (url) => hasMetadataConsent(hostOf(url)),
  });
}

function getBalanceService(): BalanceService {
  return balanceService ??= new BalanceService(metadataFetch, {
    canReadMetadata: (url) => hasMetadataConsent(hostOf(url)),
  });
}

/**
 * Ask to fetch live prices from a host — ONLY from a path the user actively initiated (opening the model
 * picker, switching provider, running the Refresh Model Prices command).
 *
 * Never call this from activation or the daily timer. A modal at startup, before the user has asked for
 * anything, is the pattern consent dialogs exist to prevent; background refresh SKIPS SILENTLY instead and
 * the built-in price table stands in. But when the user opens the model picker they are asking to compare
 * prices, so showing them the list price of a gateway they hold a discount on is its own kind of wrong —
 * that is the moment it is right to ask.
 *
 * The text says what this request actually is. It must never be the model-egress modal: that one promises
 * to send prompts and workspace files, which a price query does not do.
 */
/**
 * Hosts the user declined THIS SESSION. In memory only, never persisted.
 *
 * "Not now" must mean not now — not "ask me again every time I open the picker". Nagging is how a consent
 * prompt becomes a thing users dismiss without reading. It is deliberately NOT persisted: a decline is a
 * decision about this moment, not a permanent refusal we would then have to build UI to undo.
 * The explicit "Refresh Model Prices" command re-asks, because there the user is asking us to.
 */
const declinedMetadataHosts = new Set<string>();

/**
 * ONE interaction for a whole plan: every unapproved host, each with what it will actually be asked for, all
 * pre-selected, and the user unticks whatever they don't want. Nothing they did not tick is granted.
 *
 * It replaces a sequence of per-host modals. Opening the OpenAI model picker used to prompt for weroam, then
 * unodetech, then openai — three dialogs, two about hosts the action would never contact (see metadataPlan).
 * A prompt that asks for more than the action needs teaches the user to click through it, and a consent the
 * user clicks through protects nobody.
 *
 * Declining (Escape, or unticking everything) ends the whole plan: no requests, and no second dialog in this
 * action. The picker falls back to the static model list and the built-in price table, immediately.
 */
async function requestMetadataConsent(
  plan: MetadataHostPlan[],
  opts: { reAsk?: boolean; requester?: string } = {},
): Promise<void> {
  const pending = unapprovedHosts(plan, hasMetadataConsent)
    .filter((p) => opts.reAsk || !declinedMetadataHosts.has(p.host));
  if (pending.length === 0) { return; }

  const items = pending.map((p) => ({
    label: p.host,
    description: describePurposes(p),
    detail: p.authenticated
      ? 'Authenticated with your stored API key for this host. No prompts, code, or workspace content are sent.'
      : 'No API key, prompts, code, or workspace content are sent.',
    picked: true,
    host: p.host,
  }));

  const chosen = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    ignoreFocusOut: true,
    title: 'Allow model metadata requests?',
    placeHolder: 'UnodeAi will contact only the hosts you keep ticked. Press Escape to use built-in data instead.',
  });

  // Escape / dismiss ⇒ undefined ⇒ nothing granted, nothing fetched, no follow-up dialog. Unticking a host is
  // the same answer for that host. Either way the decline is remembered for the session so we do not re-ask.
  const granted = new Set((chosen ?? []).map((c) => c.host));
  let changed = false;
  for (const p of pending) {
    if (granted.has(p.host)) {
      changed = consentGrants.grant(
        'metadata',
        p.host,
        `${opts.requester ?? 'Model metadata request'}: ${describePurposes(p)}`,
      ) || changed;
      declinedMetadataHosts.delete(p.host);
    } else {
      declinedMetadataHosts.add(p.host);
    }
  }
  if (changed) {
    await persistConsentGrants('metadata');
  }
}

/**
 * Forget ONE grant for a host (Security panel). It is re-prompted before the next request of that kind.
 *
 * The two grants are revoked independently — revoking "prices & balance" must not silently also revoke
 * "prompts + workspace files", nor the reverse. Note the asymmetry that follows from model-egress implying
 * metadata (see hasMetadataConsent): revoking the MODEL grant on a host that never separately approved
 * metadata correctly stops its price lookups too, because the only thing that authorized them was the model
 * grant. That is not over-revoking; that is the implication running backwards, as it must.
 */
function revokeEgressConsent(host: string, kind: ConsentGrantKind = 'model', mediaKind?: MediaConsentKind): void {
  if (kind === 'media' && !mediaKind) {
    throw new Error('Revoking media egress consent requires an explicit media kind.');
  }
  const revoked = kind === 'media'
    ? consentGrants.revokeMedia(host, mediaKind!)
    : consentGrants.revoke(kind, host);
  if (revoked) {
    void persistConsentGrants(kind);
  }
}

function consentKey(kind: ConsentGrantKind): string {
  return kind === 'model' ? EGRESS_CONSENT_KEY : kind === 'metadata' ? METADATA_CONSENT_KEY : MEDIA_EGRESS_CONSENT_KEY;
}

async function persistConsentGrants(kind: ConsentGrantKind): Promise<void> {
  await extensionContext?.globalState.update(consentKey(kind), consentGrants.serialize(kind));
}

// ─── Activation ───────────────────────────────────────────────────────

/**
 * One-time migration of user settings from the legacy `roam.*` configuration namespace to `unode.*`
 * (the extension was rebranded from its legacy name to UnodeAi). Reads the extension's own declared `unode.*`
 * config keys and copies any value the user explicitly set under the old `roam.*` key, unless the new
 * key is already set. Provider ids, secrets, and per-extension state are untouched. Idempotent via a
 * globalState flag. Best-effort: failures are logged, never fatal.
 */
async function migrateRoamSettingsToUnode(context: vscode.ExtensionContext): Promise<void> {
  const FLAG = 'unode.migration.namespace.v1';
  if (context.globalState.get(FLAG)) { return; }
  try {
    const props: Record<string, unknown> =
      (context.extension?.packageJSON?.contributes?.configuration?.properties) ?? {};
    const oldCfg = vscode.workspace.getConfiguration('roam');
    const newCfg = vscode.workspace.getConfiguration('unode');
    const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    let migrated = 0;
    for (const fullKey of Object.keys(props)) {
      if (!fullKey.startsWith('unode.')) { continue; }
      const key = fullKey.slice('unode.'.length);
      const oldI = oldCfg.inspect(key);
      const newI = newCfg.inspect(key);
      if (oldI?.globalValue !== undefined && newI?.globalValue === undefined) {
        await newCfg.update(key, oldI.globalValue, vscode.ConfigurationTarget.Global);
        migrated++;
      }
      if (hasWorkspace && oldI?.workspaceValue !== undefined && newI?.workspaceValue === undefined) {
        await newCfg.update(key, oldI.workspaceValue, vscode.ConfigurationTarget.Workspace);
        migrated++;
      }
    }
    await context.globalState.update(FLAG, true);
    if (migrated > 0) { outputChannel.info(`Migrated ${migrated} setting(s) from roam.* to unode.* namespace.`); }
  } catch (e) {
    outputChannel.warn(`Settings migration (roam.* → unode.*) skipped: ${String(e)}`);
  }
}

/**
 * One-time migration of the per-workspace data directory `.roam/` → `.unode/` (rebrand). Holds the
 * team roster (team.json), project/shared memory (rules.md, memory/), MCP config, and worktrees.
 * Renames the directory if the old one exists and the new one does not, then repairs any git worktrees
 * whose gitdir links the move invalidated. Best-effort; failures are logged, never fatal.
 */
async function migrateRoamWorkspaceDir(): Promise<void> {
  try {
    if ((vscode.workspace.workspaceFolders?.length ?? 0) === 0) { return; } // never touch process.cwd() fallback
    const root = workspaceRoot();
    const oldDir = path.join(root, '.roam');
    const newDir = path.join(root, '.unode');
    const exists = async (p: string) => { try { await fs.access(p); return true; } catch { return false; } };
    if (!(await exists(oldDir)) || (await exists(newDir))) { return; }
    await fs.rename(oldDir, newDir);
    outputChannel.info('Migrated workspace data dir .roam/ → .unode/');
    // The move broke gitdir links for any worktrees under .unode/worktrees; repair them (best-effort).
    await new Promise<void>((resolve) => {
      const p = cpSpawn('git', ['-C', root, 'worktree', 'repair'], { stdio: 'ignore' });
      const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve(); }, 15000);
      p.on('close', () => { clearTimeout(t); resolve(); });
      p.on('error', () => { clearTimeout(t); resolve(); });
    });
  } catch (e) {
    outputChannel.warn(`Workspace dir migration (.roam → .unode) skipped: ${String(e)}`);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('UnodeAi', { log: true });
  outputChannel.info('UnodeAi activating...');
  extensionContext = context;
  promptedCommandLog.restoreFrom(context.globalState.get<SerializedPromptedCommandLog>(PROMPTED_COMMAND_LOG_KEY));
  const migratedEgress = consentGrants.restore('model', context.globalState.get<unknown>(EGRESS_CONSENT_KEY));
  const migratedMetadata = consentGrants.restore('metadata', context.globalState.get<unknown>(METADATA_CONSENT_KEY));
  const migratedMedia = consentGrants.restore('media', context.globalState.get<unknown>(MEDIA_EGRESS_CONSENT_KEY));
  // A setting remains an inert candidate in every scope. This first check is only diagnostic: it never
  // constructs a hook. A later explicit command is the sole path that records approval.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('unode.executionHooks')) {
      activeExecutionHooks(context, { report: true });
    }
  }));
  if (migratedEgress.migratedLegacy) { await persistConsentGrants('model'); }
  if (migratedMetadata.migratedLegacy) { await persistConsentGrants('metadata'); }
  if (migratedMedia.migratedLegacy) { await persistConsentGrants('media'); }
  await migrateRoamSettingsToUnode(context); // rebrand: carry legacy roam.* settings into unode.*
  await migrateRoamWorkspaceDir();           // rebrand: move legacy .roam/ workspace data → .unode/

  activeExecutionHooks(context, { report: true });

  // Workspace Trust: when the user grants trust mid-session, mount any MCP servers referenced by agents
  // (they were skipped at activation while untrusted). Command execution is checked live, so it needs no
  // re-arming here. Registered on the context so it's disposed on deactivate.
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
    outputChannel.info('Workspace trusted — mounting referenced MCP servers.');
    try { registerReferencedMcpServers(); } catch (e) { outputChannel.warn(`MCP mount after trust failed: ${String(e)}`); }
  }));

  secrets = new SecretsManager(context.secrets);
  customGatewayProfileStore = createVSCodeCustomGatewayProfileStore(context, {
    reservedDisplayNames: CONNECTION_PROFILES.map((profile) => profile.presentation.displayName),
    storeUserInitiatedProviderKey: persistUserInitiatedProviderKey,
    // Visible but non-fatal: an orphaned secret we could not delete is unreferenced by any profile, so it
    // cannot route anything. Surfacing it in the log keeps the retry loop observable without blocking start.
    onOrphanCleanupFailed: (secretRef, error) => {
      outputChannel.warn(
        `Could not remove an unused stored credential (${secretRef}); it will be retried later. ${String(error)}`
      );
    },
    // Normal with several windows open: another window holds the lock, so this read served the last durable
    // state and skipped recovery/cleanup. Custom gateways stay available; the next quiet load catches up.
    onDegradedRead: (error) => {
      outputChannel.warn(
        `Custom gateway registry was read without the cross-window lock; another window is busy. ${String(error)}`
      );
    },
  });
  customGatewayRegistryPath = path.join(context.globalStorageUri.fsPath, CUSTOM_GATEWAY_REGISTRY_FILE_NAME);
  await reloadEffectiveConnectionRegistry();
  watchCustomGatewayRegistry(context);
  persistence = new PersistenceManager(context, () => effectiveConnectionRegistry);
  teamPolicyStore = new TeamPolicyStore(context.workspaceState);
  pendingDelegationResults = new PendingDelegationResults(persistence.loadPendingDelegationResults());
  runLedger = new RunLedger(persistence.loadRuns());
  runLedger.onDidChange(() => scheduleRunSave());
  checkpointStore.restoreFrom(persistence.loadCheckpoints()); // V1: restore points survive reloads
  messageBus = new MessageBus();
  // One host-owned, expiring store transports opaque assets across delegates. It is not a shared read grant:
  // WorkspaceTools permits only assets explicitly handed to an agent for this turn or created by that agent.
  const delegationContentAssets = new ContentAssetStore();
  orchestrationHost = new OrchestrationHostAdapter(
    {
      coordinatorId: () => sessionManager.coordinatorId(),
      workspace: () => ({
        root: workspaceRoot,
        roots: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
        isTrusted: () => vscode.workspace.isTrusted,
        additionalReadRoots: configuredAdditionalRoots,
      }),
      messageBus: () => messageBus,
      teamEntries: () => sessionManager.getAll().map((s) => ({
        id: s.id,
        role: s.config.role,
        name: s.config.name,
        status: s.status,
        workspaceRoot: s.config.workingDirectory || workspaceRoot(),
        ...(specialtyForAgent(s.config) ? { specialty: specialtyForAgent(s.config)! } : {}),
        ...(skillsForAgent(s.config).length > 0 ? { skills: skillsForAgent(s.config) } : {}),
        capabilities: delegationCapabilitiesFor(s.config),
      })),
      resolveTeam: (ref) => sessionManager.resolveByRoleOrId(ref),
      configForAgent: (agentId) => sessionManager.get(agentId)?.config,
      effectiveExecutionIdentity: (agentId) => sessionManager.effectiveExecutionIdentity(agentId),
      admitCoordinatorAttempt: (attempt, identity) => admitArtifactReviewAttempt(attempt, identity),
      backendKindFor: (config) => config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry),
      commandPolicyFor: (config) => new AgentCommandPolicy(commandPolicy, config.commandNarrowing, config.name),
      verifyCommandFor: (config) => !vscode.workspace.isTrusted || config.folderAccess?.length
        ? ''
        : resolveVerifyCommand(
            vscode.workspace.getConfiguration('unode').get<string>('verifyCommand', ''),
            projectConventions.getInfo(),
          ),
      workingDirectoryFor: (config) => config.workingDirectory || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
      requestCommandApproval: (config, command, commandContext) =>
        requestCommandApproval(command, config.name, commandContext, { agentId: config.id, sessionId: config.id }),
      routeNotice: (config, line) => outputChannel.info(`[route] ${config.id}: ${line}`),
      commandBlocked: notifyCommandBlocked,
      verifyCommandOutsideRoot: notifyVerifyCommandOutsideRoot,
      approveCoordinatorBriefEgress,
      taskClaims: () => taskClaims,
      escalateToFallback: (agentId) => sessionManager.escalateToFallback(agentId),
      cancelDelegatedWorker: (event) => sessionManager.cancelDelegation(event.agentId, event.handle, event.reason),
      stopTeammate: (coordinatorId, agentId, reason) => {
        if (agentId === coordinatorId) { return false; }
        const session = sessionManager.get(agentId);
        if (!session || session.status !== 'running') { return false; }
        outputChannel.info(`Coordinator stopped ${session.config.name}: ${reason}`);
        void sessionManager.stop(agentId);
        return true;
      },
      queueAsyncDelegationWake: (coordinatorId, result, isReady, consume) => {
        sessionManager.queueAsyncDelegationWake(
          coordinatorId,
          { ...result, runId: runLedger.runIdForDelegation(result.handle) },
          isReady,
          consume,
        );
      },
      recoveredAsyncResults: (coordinatorId) => pendingDelegationResults.forCoordinator(coordinatorId)
        .map(({ handle, ref, text }) => ({ handle, ref, text })),
      retainAsyncResult: (coordinatorId, result) => {
        pendingDelegationResults.remember({ coordinatorId, ...result });
        savePendingDelegationResults();
      },
      consumeAsyncResult: (coordinatorId, handle) => {
        pendingDelegationResults.consume(coordinatorId, handle);
        savePendingDelegationResults();
      },
      warnUser: (message) => { void vscode.window.showWarningMessage(message); },
      openRecordedFile: async (filePath) => {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(document, { preview: false });
      },
    },
    {
      recordDispatched: (event, coordinator) => runLedger.recordDelegationDispatched({
        ...event,
        route: runRouteReceipt(event.agentId),
        originCorrelationId: sessionManager.currentTurnCorrelationId(coordinator.id),
      }),
      recordRefused: (event, coordinator) => runLedger.recordRefusedDispatch({
        ...event,
        originCorrelationId: sessionManager.currentTurnCorrelationId(coordinator.id),
      }),
      recordEvidence: ({ handle, outcome, evidence, agentId }) => {
        runLedger.recordDelegationEvidence({ handle, outcome, evidence, agentId });
        const evidenceVisible = orchestrationProgress.recordEvidence(handle, outcome);
        const taskStateVisible = (evidence.contextGaps ?? []).reduce(
          (visible, gap) => orchestrationProgress.recordTaskState(handle, { kind: 'context-gap', ...gap }) || visible,
          false,
        );
        if (!evidenceVisible && !taskStateVisible) { return; }
        const summaries = orchestrationProgress.snapshot();
        chatViewProvider?.setDelegationProgress(summaries);
        messageLogProvider?.setDelegationProgress(summaries);
        teamViewProvider?.setDelegationProgress(orchestrationProgress.agentStates());
      },
      recordDisposition: (event) => {
        runLedger.recordDisposition(event);
        orchestrationProgress.recordDisposition(event.handle, event.disposition, event.reason, event.recordedAt);
        const summaries = orchestrationProgress.snapshot();
        chatViewProvider?.setDelegationProgress(summaries);
        messageLogProvider?.setDelegationProgress(summaries);
        teamViewProvider?.setDelegationProgress(orchestrationProgress.agentStates());
      },
      recordCancelled: (event) => {
        runLedger.recordDelegationCancelled(event);
        if (!orchestrationProgress.recordCancellation(event.handle, event.cancelledAt)) return;
        const summaries = orchestrationProgress.snapshot();
        chatViewProvider?.setDelegationProgress(summaries);
        messageLogProvider?.setDelegationProgress(summaries);
        teamViewProvider?.setDelegationProgress(orchestrationProgress.agentStates());
      },
      recordDeliveryPending: (handle) => runLedger.recordDeliveryPending(handle),
      recordDeliveryDelivered: (handle, via) => runLedger.recordDeliveryDelivered(handle, via),
      inspectTaskStatus: (coordinatorId, handles) => runLedger.inspectTaskStatus(coordinatorId, handles),
      recordEmptyOutcome: (event) => chatViewProvider?.recordDelegationEmptyOutcome(event),
      runIdForDelegation: (handle) => runLedger.runIdForDelegation(handle),
      openHumanReview: (runId) => { void vscode.commands.executeCommand('unode.reviewRun', runId); },
      refreshAfterAsyncResult: () => { chatViewProvider?.refresh(); },
    },
  );
  taskInputResolver = orchestrationHost.createTaskInputResolver(delegationContentAssets);
  context.subscriptions.push({ dispose: () => { void delegationContentAssets.dispose(); } });
  fileCoordinator = makeFileCoordinator();
  worktreeCoordinator = makeWorktreeCoordinator();
  // Live review board (A2): when a lane's verify state changes (merge gate, re-verify), refresh the
  // open worktree panel so the user sees ✓/✗ flips without reopening it.
  worktreeCoordinator.onChange = () => { void refreshWorktreePanel(); };
  commandPolicy = makeCommandPolicy();
  commandPolicy.onFirstBlock = () => showBlockedWarning();
  // MCP host for in-process (openai-compat) agents. Secrets for ${VAR} placeholders are resolved
  // from SecretStorage — never process.env. claude agents use claude's native MCP instead.
  mcpHub = new MCPHub(createRealMcpClient, (name) => secrets.get(name));
  // SKILL.md is the runtime source of truth. Fail activation loudly if the shipped instruction-only
  // library is malformed rather than silently granting a different set of procedures.
  const agentSkillRegistry = SkillRegistry.load(path.join(context.extensionUri.fsPath, 'skills'));

  // F4/B1: project/team context (.unode/rules.md plus compatible root instruction files and shared notes),
  // attached to every turn. The backend keeps this timestamped state out of its cacheable system prefix.
  rulesFile = new RulesFile(rulesFilePath(workspaceRoot()));
  projectKnowledge = new ProjectKnowledge(workspaceRoot());
  sharedMemory = new SharedMemory(memoryFilePath(workspaceRoot()));
  // A1/A2: auto-detected project conventions (package.json scripts + how to run them), injected the
  // same way as rules so every agent (even weak ones) uses the right commands instead of inventing them.
  projectConventions = new ProjectConventions(workspaceRoot());
  // P3: await the initial loads during activation so the very first turn already carries project
  // context — otherwise a user who sends a message the instant the extension loads could get an agent
  // turn with no scripts/rules injected. Both are cheap disk reads; watchers still hot-reload on change.
  // Guarded + skipped without a workspace: these must never abort activation (which happens before the
  // webview providers register below) — otherwise the panels show only their titles, no content. When
  // no folder is open, workspaceRoot() falls back to process.cwd() (e.g. an unwritable `/` on macOS
  // launched from the Dock), so there's no project to attach memory to: just skip the disk work.
  if (vscode.workspace.workspaceFolders?.length) {
    try {
      await rulesFile.ensureExists();
      await rulesFile.load();
      await projectKnowledge.load();
      await sharedMemory.load();
      await projectConventions.load();
    } catch (err) {
      outputChannel.warn(`Project memory/conventions load skipped: ${String(err)}`);
    }
  }

  // F2: resolve effective model/sampling params (agent override > global unode.modelDefaults > defaults).
  const modelParamResolver = new ModelParamResolver(makeConfigStore());
  /**
   * Runtime boundary for model parameters. Persisted legacy values remain intact until the user
   * removes them, but an unsupported key is never handed to a backend that would ignore it.
   */
  const resolveRouteModelParams = (config: AgentConfig, tierParams?: AgentModelParams): AgentModelParams => {
    const profile = connectionProfileForAgent(config, effectiveConnectionRegistry);
    if (!profile) {
      throw new Error(`Unknown connection "${config.provider.providerId}".`);
    }
    const resolved = modelParamResolver.resolve(config, tierParams);
    const unsupported = unsupportedModelParamKeys(profile.capabilities, resolved);
    if (unsupported.length > 0) {
      outputChannel.warn(`[capabilities:${config.id}] omitted unsupported model parameters for ${profile.id}: ${unsupported.join(', ')}`);
    }
    return Object.fromEntries(Object.entries(resolved).filter(([key]) => profile.capabilities.modelParams.has(key))) as AgentModelParams;
  };
  const summarizer = new LlmSummarizer();
  const localMcpServerFactory = createSharedLocalMcpServerFactory();
  // One approval authority for every agent/backend created during this extension-host session. This is
  // intentionally neither persisted nor keyed to a single agent: an explicit crew-wide session allow is
  // exactly what the public-web card promises.
  const crewWebAccess = new SessionWebAccessApprover(requestWebAccessApproval);

  // The backend factory decides "how an agent runs", keyed off config.backend (falling back to
  // a provider-based default). Add codex/gemini/etc. factories here as they land.
  const SOLO_MAX_TOOL_ITERATIONS = 25;
  const createBackend = (config: AgentConfig): AgentBackend => {
    // Load-bearing host boundary: config can originate in a webview, team.json, or an older roster.
    // Presentation may hide a control; this assertion makes bypassing that presentation ineffective.
    assertAgentCapabilityCompatibility(config, effectiveConnectionRegistry);
    // Host-side credential boundary: workspace state may select a registered connection, but it
    // may never redirect that connection to another SecretStorage key.
    assertAgentConfigApiKeyOwnership(config, effectiveConnectionRegistry);
    const kind = config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry);
    const runtimeConfig = kind === 'openai-compat' ? withOpenAICompatBaseUrl(config) : config;
    const agentCwdForRoots = runtimeConfig.workingDirectory || workspaceRoot();
    const effectiveRoots = resolveEffectiveRoots({
      grants: runtimeConfig.folderAccess,
      fallbackPrimaryRoot: agentCwdForRoots,
      fallbackReadRoots: orchestrationHost.readRootsForAgent(agentCwdForRoots),
      workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      isTrusted: vscode.workspace.isTrusted,
    });
    for (const issue of effectiveRoots.issues) {
      outputChannel.warn(`[folderAccess:${runtimeConfig.id}] ${issue.message}`);
    }
    // A child process is not an OS filesystem sandbox. For an explicit Folder Access scope, keep
    // execution out of the model tool surface and enforce writes through the guarded file tools.
    const scopedAllowedTools = effectiveRoots.restricted
      ? runtimeConfig.allowedTools?.filter((tool) => tool !== 'execute')
      : runtimeConfig.allowedTools;
    const scopedConfig: AgentConfig = {
      ...runtimeConfig,
      workingDirectory: effectiveRoots.primaryRoot,
      allowedTools: scopedAllowedTools,
    };
    // The global policy remains live and authoritative. This per-backend view can only reduce it and
    // re-intersects saved selections on every check, including after a global allowlist shrinks.
    const agentCommandPolicy = new AgentCommandPolicy(commandPolicy, scopedConfig.commandNarrowing, scopedConfig.name);
    const routeBoundary = makeRouteBoundaryAssert(
      scopedConfig,
      kind,
      kind === 'openai-compat' ? (scopedConfig.baseUrl || OPENAI_COMPAT_DEFAULT_BASE_URL)
        : kind === 'codex' ? 'https://api.openai.com'
          : 'https://api.anthropic.com'
    );
    const trustedWriteRoots = writeRootsForTrust(effectiveRoots.writeRoots, vscode.workspace.isTrusted);
    const grants = agentMcpGrants(scopedConfig, skillResolver);
    // Approval card names the requesting agent, so a teammate's prompt is identifiable from any chat view
    // (the bar is global). Shared by the OpenAI-compat run_command path and the Claude permission gate.
    const approvalOrigin = { agentId: scopedConfig.id, sessionId: scopedConfig.id };
    const approveForAgent: CommandApprover = (command, context) => requestCommandApproval(command, scopedConfig.name, context, approvalOrigin);
    const egressRequester = `${scopedConfig.name} via ${displayNameForProviderId(scopedConfig.provider.providerId, effectiveConnectionRegistry)}`;
    const approveModelEgress = (url: string) => egressGate(url, undefined, egressRequester);
    const mediaConnectionId = scopedConfig.route?.connectionId
      ?? effectiveConnectionRegistry.connectionIdForProviderId(scopedConfig.provider.providerId)
      ?? scopedConfig.provider.providerId;
    const declaredMediaCapability = (modelId: string, mediaClass: 'image' | 'audio'): boolean | undefined => {
      // v0.9.58 routes only image assets. No transcription implementation may infer audio support from a
      // vision declaration, and a free-typed/custom model with no record remains unknown.
      if (mediaClass !== 'image') { return undefined; }
      return effectiveConnectionRegistry.connectionProfile(mediaConnectionId)?.catalogModels
        .find((candidate) => candidate.id === modelId)?.vision;
    };
    const approveMediaEgress = (request: MediaEgressRequest) =>
      mediaEgressGate(request, `${egressRequester}: ${request.kind} media upload`);
    const webAccess = {
      policy: () => vscode.workspace.getConfiguration('unode').get<'ask' | 'allow' | 'off'>('webAccess', 'ask'),
      requestApproval: (request: WebAccessApprovalRequest) => crewWebAccess.requestApproval({
        ...request,
        agentName: scopedConfig.name,
        ...approvalOrigin,
      }),
    };
    if (kind === 'openai-compat') {
      // Coordinator agents (the PM) get delegation tools so they can drive the crew.
      const team = canDelegate(scopedConfig) ? orchestrationHost.createCoordinatorTeamTools(scopedConfig, agentCommandPolicy) : undefined;
      // In-process agents host MCP via the shared Hub (default-deny: only granted servers).
      const mcp = grants.length > 0 ? { hub: mcpHub, grants } : undefined;
      // Agent robustness: rewrite direct runner calls (e.g. `npx vitest`) into the project's scripts.
      const commandNormalizer = (cmd: string) => normalizeRunnerCommand(cmd, projectConventions.getInfo());
      // Solo mode (v0.3.0): a single agent has no teammates to spread work across, so give it more
      // tool-loop iterations to finish a whole task itself.
      const isSolo = scopedConfig.role === 'solo';
      const net = {
        ...(isSolo ? { maxToolIterations: SOLO_MAX_TOOL_ITERATIONS } : {}),
        onBeforeEgress: approveModelEgress,
        assertResolvedRoute: routeBoundary,
        connectionResolver: effectiveConnectionRegistry,
        mediaCapabilityCache,
        declaredMediaCapability,
        onBeforeMediaEgress: approveMediaEgress,
        mediaEgressProvider: displayNameForProviderId(scopedConfig.provider.providerId, effectiveConnectionRegistry),
      };
      // A solo agent has no teammates, so the optimistic "read the file before you overwrite it"
      // guard is pure friction (it can't clobber anyone). Skip it for solo; teams keep it.
      // Worktree fan-out: an isolated agent (workingDirectory under .unode/worktrees/) has its own
      // tree, so the optimistic cross-agent guard is pure friction there too — use Noop.
      const isolated = !!scopedConfig.workingDirectory && scopedConfig.workingDirectory.includes(WORKTREES_DIR);
      const coordinator = (isSolo || isolated) ? new NoopFileCoordinator() : fileCoordinator;
      // #13: run the agent's commands in a real VS Code terminal (PTY) so TTY-needing tools (vitest)
      // work and the user sees them; falls back to raw spawn where shell integration is unavailable.
      const rawCommandExecutor = terminalManager.executorFor(scopedConfig.id, `Unode: ${scopedConfig.name}`);
      // Workspace Trust gate: never execute a shell command in an untrusted workspace (checked live, so
      // granting trust mid-session takes effect immediately without restarting the agent).
      const commandExecutor: typeof rawCommandExecutor = (command, opts) =>
        vscode.workspace.isTrusted
          ? rawCommandExecutor(command, opts)
          : Promise.resolve({ code: null, output: 'Blocked: this workspace is not trusted, so shell commands are disabled. Trust the workspace (Workspace Trust) to enable them.' });
      // Live thunk so toggling unode.writeApproval applies to running agents without a restart.
      const writeApprovalAsk = () => vscode.workspace.getConfiguration('unode').get<'none' | 'ask'>('writeApproval', 'none') === 'ask';
      const memoryWriter = effectiveRoots.restricted
        ? undefined
        : async (agentId: string, note: string, kind: MemoryNoteKind) => {
            if (!vscode.workspace.isTrusted) {
              return 'Error: shared memory is disabled because this workspace is not trusted. The note was NOT saved.';
            }
            // The model supplies only its closed-vocabulary kind. Tier is a host routing fact for this
            // turn, retained privately by SessionManager rather than accepted through tool arguments.
            const tier = sessionManager.currentTurnTier(agentId) ?? configuredRoutingTier(scopedConfig);
            const ok = await sharedMemory.append(agentId, note, tier, kind);
            if (!ok) {
              return 'Error: shared memory is unavailable (no workspace folder open, or .unode/memory is not writable). The note was NOT saved.';
            }
            void sharedMemory.load();
            return 'Noted to shared team memory.';
          };
      // v0.5.2 Execution Engine: write→feedback diagnostics + verification obligation (each kill-switched).
      const engineCfg = vscode.workspace.getConfiguration('unode');
      const agentCwd = scopedConfig.workingDirectory || workspaceRoot();
      const additionalReadRoots = effectiveRoots.readRoots;
      // Worktree fan-out: in worktree mode, let every agent READ the team's merged work from the
      // integration worktree when a file isn't in its own tree (writes stay isolated). The path is the
      // same for isolated agents (a sibling of their worktree) and the PM (nested under its root).
      const worktreeMode = engineCfg.get<string>('concurrencyStrategy', 'optimistic') === 'worktree';
      const integrationRoot = path.join(workspaceRoot(), WORKTREES_DIR, '_integration');
      const verifyCommand = engineCfg.get<string>('verifyCommand', '').trim();
      const effectiveVerifyCommand = !vscode.workspace.isTrusted || config.folderAccess?.length
        ? ''
        : resolveVerifyCommand(verifyCommand, projectConventions.getInfo());
      const gateEnabled = engineCfg.get<boolean>('gate.enabled', true);
      const completionGate = canDelegate(scopedConfig) && !worktreeMode && gateEnabled && verifyCommand
        ? {
            command: verifyCommand,
            run: runVerifyChecks,
            cfg: {
              maxSelfRetries: engineCfg.get<number>('gate.maxSelfRetries', DEFAULT_COMPLETION_GATE_CONFIG.maxSelfRetries),
              maxRedelegations: engineCfg.get<number>('gate.maxRedelegations', DEFAULT_COMPLETION_GATE_CONFIG.maxRedelegations),
            },
          }
        : undefined;
      const engine: EngineOptions = {
        diagnostics: engineCfg.get<boolean>('engine.postWriteDiagnostics', true)
          ? (paths) => collectFileDiagnostics(paths, agentCwd)
          : undefined,
        verifyObligation: engineCfg.get<boolean>('engine.verifyObligation', true),
        verificationCommand: effectiveVerifyCommand,
        completionGate,
        sharedReadRoot: worktreeMode && path.resolve(integrationRoot) !== path.resolve(agentCwd) ? integrationRoot : undefined,
        additionalReadRoots,
        writeRoots: trustedWriteRoots,
        isTrusted: () => vscode.workspace.isTrusted, // untrusted workspace → writes/edits/deletes refused
        webAccess,
        delegationContentAssets,
        taskInputResolver,
        // Resolve at each hook point: approval may happen after this backend starts, and an edited setting
        // must revoke the old approval immediately. The provider only receives a host-owned registry.
        executionHooks: () => activeExecutionHooks(context).hooks,
        onContentReceipt: (receipt) => runLedger.recordContentReceipt({
          ...receipt,
          agentId: scopedConfig.id,
          correlationId: sessionManager.currentTurnCorrelationId(scopedConfig.id),
        }),
      };
      return new OpenAICompatBackend(scopedConfig, undefined, team, coordinator, agentCommandPolicy, net, mcp, undefined, approveForAgent, messageBus, commandNormalizer, commandExecutor, recordCheckpoint, writeApprovalAsk, requestWriteApproval, memoryWriter, engine, agentSkillRegistry);
    }
    if (kind === 'codex') {
      const binaryPath = configuredCodexCliPath();
      return new CodexBackend(scopedConfig, resolveRouteModelParams(scopedConfig), {
        binaryPath,
        preflight: () => verifyCodexCli(binaryPath),
        // The direct model destination used by the CLI protocol; the actual transport is re-probed in C5.
        onBeforeEgress: () => approveModelEgress('https://api.openai.com'),
        assertResolvedRoute: routeBoundary,
      });
    }
    // Claude agents use claude's NATIVE MCP: translate their granted servers into --mcp-config. Workspace
    // Trust: in an untrusted workspace, hand claude NO MCP servers (they spawn processes / reach the network).
    const mcpConfig = vscode.workspace.isTrusted
      ? buildClaudeMcpConfig(grantedServerConfigs(grants, { approvedOnly: true }))
      : undefined;
    // F1: pass resolved params so buildArgs can map reasoning_effort → --effort at spawn.
    const claudeDeps: ClaudeHeadlessBackendDeps = {
      verifyObligation: vscode.workspace.getConfiguration('unode').get<boolean>('engine.verifyObligation', true),
      executionHooks: () => activeExecutionHooks(context).hooks,
      // The fail-closed hook asset ships at <extension>/out/claudeToolGate.cjs. Resolve it from the extension
      // root, NOT from __dirname: a bundled build collapses every module into out/extension.js, so a
      // __dirname-relative guess lands one directory too high and Claude (correctly, fail-closed) refuses to
      // start. Passing the path explicitly makes the packaged and unbundled layouts resolve identically.
      toolGateScriptPath: extensionContext
        ? path.join(extensionContext.extensionUri.fsPath, 'out', 'claudeToolGate.cjs')
        : undefined,
      // Command-approval gate: route this Claude agent's shell commands through Roam's CommandPolicy +
      // approval card (named for this agent) — unifies "Ask each" across Claude and OpenAI-compat agents.
      commandPermission: { policy: agentCommandPolicy, requestApproval: approveForAgent, isTrusted: () => vscode.workspace.isTrusted },
      // PreToolUse is inherited by Claude native subagents. It uses this same in-panel approval surface
      // for unknown/external native tools, and the existing write card for native Write/Edit previews.
      requestToolApproval: (request) => requestClaudeToolApproval(scopedConfig.name, request, approvalOrigin),
      writeApprovalAsk: () => vscode.workspace.getConfiguration('unode').get<'none' | 'ask'>('writeApproval', 'none') === 'ask',
      requestWriteApproval: (request) => requestWriteApproval(request, scopedConfig.name, approvalOrigin),
      // Claude applies native edits itself. Its backend derives checkpoints only after a successful
      // tool_result, then uses this same host-owned persistence and rail refresh path as WorkspaceTools.
      recordCheckpoint,
      webAccess,
      // Egress consent: confirm the destination host once before the claude CLI is spawned (nothing sent
      // otherwise). Claude agents reach Anthropic via the user's own `claude` CLI config (api.anthropic.com).
      onBeforeEgress: (onPending) => egressGate('https://api.anthropic.com', onPending, egressRequester),
      assertResolvedRoute: routeBoundary,
      // NOTE: additional read roots are NOT handed to the claude CLI. `--add-dir` grants read+write (subject
      // to permission mode), which would break the "writes stay in the working folder" invariant. Claude
      // agents stay scoped to their cwd; cross-root READ is enforced only via the read-only files MCP bridge.
      additionalReadRoots: vscode.workspace.isTrusted ? effectiveRoots.readRoots : [],
      writeRoots: trustedWriteRoots,
      restrictShell: effectiveRoots.restricted,
      skillRegistry: agentSkillRegistry,
      onUnmediatedToolUse: (tool, agentName) => handleClaudeUnmediatedToolUse(scopedConfig.id, tool, agentName),
      messageBus,
      onContentReceipt: (receipt) => runLedger.recordContentReceipt({
        ...receipt,
        agentId: scopedConfig.id,
        correlationId: sessionManager.currentTurnCorrelationId(scopedConfig.id),
      }),
      taskInputResolver,
    };
    if (canDelegate(scopedConfig)) {
      // PM also gets the team bridge so a Claude PM can delegate (list_agents/assign_task/…).
      claudeDeps.localMcpServerFactory = localMcpServerFactory;
      claudeDeps.teamMcpBridge = new TeamMcpBridge(orchestrationHost.createCoordinatorTeamTools(scopedConfig, agentCommandPolicy));
    }
    claudeDeps.delegationContentAssets = delegationContentAssets;
    claudeDeps.taskInputResolver = taskInputResolver;
    return new ClaudeHeadlessBackend(scopedConfig, mcpConfig, resolveRouteModelParams(scopedConfig), claudeDeps);
  };

  // No startup repair, service construction, or warm-up request. Price metadata is reached only after a
  // user action (or later maintenance for hosts that user has already approved).
  const priceTimer = setInterval(() => void refreshPrices(), 24 * 60 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(priceTimer) });

  sessionManager = new SessionManager(
    vscode.workspace.getConfiguration('unode').get('maxConcurrentAgents', 10),
    messageBus,
    {
      createBackend,
      resolveEnv,
      // Worktree fan-out (v0.6.x): isolate eligible agents in their own worktree. When NOT isolated, root
      // the agent at the CURRENT workspace folder — never a stale per-agent workingDirectory pinned at
      // creation in a different folder (that caused "outside my working folder" on the open project), and
      // never process.cwd() (the extension host's dir). This always wins over the persisted value.
      resolveWorkingDirectory: async (config) => {
        const worktreeMode = vscode.workspace.getConfiguration('unode').get<string>('concurrencyStrategy', 'optimistic') === 'worktree';
        try {
          assertNoFolderAccessWorktreeConflict(config, worktreeMode);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(msg);
          throw err;
        }
        return (await worktreeCoordinator?.assignWorkingDirectory(config)) ?? workspaceRoot();
      },
      onTurnComplete: (agentId, isError) => {
        // Don't drop the merge promise on the floor — a rejection would otherwise surface as an
        // unhandled process-level error. mergeAgent catches internally, but be defensive. (Audit #11.)
        worktreeCoordinator?.onTurnComplete(agentId, isError)?.catch(
          (e) => outputChannel.warn(`[worktree] merge after turn failed: ${String(e)}`)
        );
      },
      loadSnapshot: (id) => persistence.loadSnapshot(id),
      saveSnapshot: (id, snap) => persistence.saveSnapshot(id, snap),
      clearSnapshot: (id) => persistence.clearSnapshot(id),
      estimateCost: (model, inTok, outTok, providerId) => getPricing().estimate(model, inTok, outTok, providerId),
      premiumCostModel: DEFAULT_MODEL_TIERS.premium.roam, // top-tier baseline for the "saved $X" comparison

      resolveModelParams: (config, tierParams) => resolveRouteModelParams(config, tierParams),
      resolveTaskModel: (config, msg) => resolveTaskModelSelection(config, msg)?.model,
      resolveTaskModelParams: (config, msg) => resolveTaskModelSelection(config, msg)?.modelParams,
      resolveTaskTier: (config, msg) => hostSelectedRoutingTier(config, msg),
      resolveEffectiveExecutionIdentity: (config, reportedModelId) => {
        const profile = connectionProfileForAgent(config, effectiveConnectionRegistry);
        return profile
          ? createEffectiveExecutionIdentity(reportedModelId, profile.id, profile.revision)
          : undefined;
      },
      admitTaskExecution: (attempt, identity) => admitArtifactReviewAttempt(attempt, identity),
      onTaskAttemptTerminal: (attemptId) => {
        const observation = taskInputResolver.reviewObservationForAttempt(attemptId);
        if (observation) runLedger.recordReviewObservation(observation);
      },
      // Delegated folder scopes are a per-turn ceiling. The resolver does the path intersection here,
      // at the extension-host authority boundary, before any backend sees the task.
      resolveTaskWorkspaceAccess: (config, msg) => orchestrationHost.resolveTaskWorkspaceAccess(config, msg.payload.taskScope),
      getProjectContext: () => [projectConventions.get(), rulesFile.getRepositorySummaryContext(), projectKnowledge.promptBlock(), sharedMemory.block()].filter((s) => s.trim()).join('\n\n'),
      getTurnContextManifest: (config, msg) => {
        const suppliedSources = msg.payload.contextManifestSources ?? [];
        const delegatedSources = msg.type === 'task.assign'
          ? (msg.payload.delegationContentSources ?? []).map(delegatedContentManifestSource)
          : [];
        const skillPrompt = config.backend === 'claude'
          ? agentSkillRegistry.promptBlock(config.playbooks, { l1Only: true })
          : agentSkillRegistry.promptBlock(config.playbooks);
        const sources = [
          // Chat routing records the original task and any expanded @ appendix separately. Do not count
          // the expanded final instruction a second time; delegated/framework messages have no such record.
          ...(suppliedSources.some((source) => source.kind === 'user-request' && source.text !== undefined)
            ? []
            : [textContextSource('user-request', 'Current task', 'chat / delegated instruction', msg.payload.instruction, 'message routed to this agent')]),
          ...suppliedSources,
          ...delegatedSources,
          textContextSource('project-conventions', 'Project conventions', 'workspace package metadata and layout', projectConventions.get(), 'fixed project-conventions path'),
          ...rulesFile.getRepositorySummarySourcesForManifest().map((source) => ({
            kind: 'repository-instruction' as const,
            label: source.relativePath,
            location: source.relativePath,
            text: source.content,
            reason: source.truncated ? 'L1 repository-instruction index; original source had a full-prompt cap' : 'L1 repository-instruction index; full source available on demand through read_file',
          })),
          textContextSource('project-knowledge-index', 'Structured docs index', 'docs/', projectKnowledge.promptBlock(), 'L1 project-knowledge index; full documents available on demand through read_file'),
          textContextSource('shared-memory', 'Shared team memory', '.unode/memory/notes.md', sharedMemory.block(), 'fixed shared-memory path'),
          textContextSource('skill-summary', 'Authorized skill summaries', 'extension-owned SKILL.md registry', skillPrompt, 'skill grant'),
        ];
        return createTurnContextManifest(sources.map(enrichContextManifestSource));
      },
      getWorkspaceContext: async (runtimeRoot?: string) => {
        try {
          // Ground to the agent's ACTUAL runtime root (a worktree path when isolated), not the global
          // workspace — otherwise an isolated worker is told the wrong folder and its shared-path use is
          // (correctly) sandbox-blocked. Falls back to the workspace root when no runtime root is known.
          const root = runtimeRoot || workspaceRoot();
          const parts: string[] = [];
          // Explicit working-directory grounding. Claude models are trained in a Linux sandbox and
          // confabulate a '/Users/dev/workspace-<id>/' working folder (a different random id each turn),
          // both in prose and as file-path prefixes. State the REAL root and that there is no such sandbox
          // so the model uses workspace-relative paths. (File ops also get re-rooted downstream, but this
          // stops the model from *reporting* a wrong folder and reduces bad path prefixes up front.)
          parts.push(
            `--- Your working directory ---\n${root}\nAll file paths are relative to this folder. You are ` +
            `NOT in a Unix sandbox such as /Users/<name>/workspace-... or /workspace/... — do not prefix ` +
            `paths with one. If asked your working folder, it is exactly the path above.`
          );
          // ALWAYS ground the model with the real file listing — this prevents a strong model (e.g. Claude)
          // from confabulating an absolute sandbox path when it only knows the root string. On by default,
          // unlike the richer diagnostics/active-file context below.
          const tree = await listWorkspaceTree(root);
          if (tree) {
            parts.push(`--- Files in your workspace (paths are relative to ${root}) ---`);
            parts.push(tree);
          }
          // Richer per-turn orientation (diagnostics + active editor file) stays opt-in via the flag.
          const cfg = vscode.workspace.getConfiguration('unode');
          if (cfg.get<boolean>('engine.workspaceContext', false)) {
            const editor = vscode.window.activeTextEditor;
            // Diagnostics FIRST: compact + high-value, so they survive the backend's total cap even when the
            // active file is large (the agent can always read_file for the full file, but lost errors hurt).
            const diags = diagnosticsSnapshot(root).items.slice(0, WORKSPACE_CONTEXT_DIAGNOSTIC_LIMIT);
            if (diags.length > 0) {
              parts.push('--- Diagnostics ---');
              for (const d of diags) {
                parts.push(`${d.file}:${d.line}:${d.col} [${d.severity}] ${d.message}`);
              }
            }
            if (editor?.document?.uri.scheme === 'file') {
              const abs = editor.document.uri.fsPath;
              const rel = path.relative(root, abs);
              if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                parts.push(`Active file: ${rel.split(path.sep).join('/')}`);
                parts.push('--- Active editor snippet ---');
                parts.push(capWorkspaceContextFile(editor.document.getText()));
              }
            }
          }
          return parts.length > 0 ? parts.join('\n') : undefined;
        } catch (err) {
          outputChannel.warn(`Workspace context gather failed: ${String(err)}`);
          return undefined;
        }
      },
      summarizer,
      summarizerIO: (config) => ({ chatCompletion: (messages, model, params) => summarizerChatCompletion(config, messages, model, params) }),
      summarizerModel: (config) => economyModelFor(config),
      connectionResolver: () => effectiveConnectionRegistry,
    }
  );
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('unode.maxConcurrentAgents')) {
      sessionManager.setMaxConcurrent(vscode.workspace.getConfiguration('unode').get('maxConcurrentAgents', 10));
    }
    if (event.affectsConfiguration('unode.chatParticipant.enabled')) {
      syncUnodeChatParticipant();
    }
    if (event.affectsConfiguration('unode.concurrencyStrategy')) {
      syncConcurrencyContext(); // keep the title-bar icon in sync when changed from Settings
      teamViewProvider?.refresh();
      void refreshDashboardPanel();
    }
    // Smart Mode on/off, role tiers, or the tier→model matrix changed → re-render the team cards so the
    // ⚡ Smart → <model> badge reflects reality immediately (Settings-panel edits AND raw settings.json edits).
    if (event.affectsConfiguration('unode.smartMode') || event.affectsConfiguration('unode.modelTiers')) {
      teamViewProvider?.refresh();
    }
    if (event.affectsConfiguration('unode.modelDefaults')) {
      SettingsPanel.refreshCurrent();
      AgentBuilderPanel.refreshCurrent();
    }
    // Added a model id by hand → see it in the picker now. Results are cached per (provider, baseUrl)
    // for 5 minutes, so without dropping the cache the edit would appear whenever the TTL happened to
    // lapse, which reads as the setting not working.
    if (event.affectsConfiguration('unode.extraModels') || event.affectsConfiguration('unode.modelCatalogUrl')) {
      // The catalog URL is captured when the lazy service is constructed. Recreate on a URL change; a
      // simple cache clear would continue contacting the old configured host until window reload.
      if (event.affectsConfiguration('unode.modelCatalogUrl')) {
        modelCatalog = undefined;
      } else {
        modelCatalog?.clearCache();
      }
      SettingsPanel.refreshCurrent();
      AgentBuilderPanel.refreshCurrent();
    }
    // Keep the LIVE command gate in sync with Settings-UI edits. Without this, changing
    // unode.commandApproval / unode.allowedCommands in Settings had no effect until a window reload (the
    // policy only reloaded via the approval-bar dropdown / "Allow for project") — so an emptied allowlist
    // or a switch to "ask" silently didn't take, and commands kept running ungated.
    if (event.affectsConfiguration('unode.commandApproval') || event.affectsConfiguration('unode.allowedCommands')) {
      const cfg = vscode.workspace.getConfiguration('unode');
      commandPolicy.reload(cfg.get<CommandApprovalMode>('commandApproval', 'ask'), cfg.get<string[]>('allowedCommands', []));
      outputChannel.info(`[policy] reloaded: commandApproval=${cfg.get('commandApproval', 'ask')}, allowedCommands=${(cfg.get<string[]>('allowedCommands', []) ?? []).length}`);
    }
  }));

  // F4/B1: reload compatible repository instructions when they change so new turns pick up edits.
  const rulesWatcher = vscode.workspace.createFileSystemWatcher('**/{AGENTS.md,CLAUDE.md,.unode/rules.md}');
  const reloadRules = () => {
    void rulesFile.load().then(() => outputChannel.info('Reloaded repository instruction context.'));
  };
  rulesWatcher.onDidChange(reloadRules);
  rulesWatcher.onDidCreate(reloadRules);
  rulesWatcher.onDidDelete(reloadRules);
  context.subscriptions.push(rulesWatcher);

  // P1: the L1 docs index is a live view just like repository instructions. The actual document bodies are
  // not read into every turn; a change only refreshes the compact index for subsequent turns.
  const projectKnowledgeWatcher = vscode.workspace.createFileSystemWatcher('**/docs/**/*.{md,mdx}');
  const reloadProjectKnowledge = () => {
    void projectKnowledge.load().then(() => outputChannel.info('Reloaded progressive project-knowledge index.'));
  };
  projectKnowledgeWatcher.onDidChange(reloadProjectKnowledge);
  projectKnowledgeWatcher.onDidCreate(reloadProjectKnowledge);
  projectKnowledgeWatcher.onDidDelete(reloadProjectKnowledge);
  context.subscriptions.push(projectKnowledgeWatcher);

  const memoryWatcher = vscode.workspace.createFileSystemWatcher('**/.unode/memory/notes.md');
  const reloadMemory = () => {
    void sharedMemory.load().then(() => outputChannel.info('Reloaded .unode/memory/notes.md shared memory.'));
  };
  memoryWatcher.onDidChange(reloadMemory);
  memoryWatcher.onDidCreate(reloadMemory);
  memoryWatcher.onDidDelete(reloadMemory);
  context.subscriptions.push(memoryWatcher);

  // A1: re-detect project conventions when the root package.json changes (scripts added/renamed).
  const pkgWatcher = vscode.workspace.createFileSystemWatcher('**/package.json');
  const reloadConventions = () => { void projectConventions.load(); };
  pkgWatcher.onDidChange(reloadConventions);
  pkgWatcher.onDidCreate(reloadConventions);
  pkgWatcher.onDidDelete(reloadConventions);
  context.subscriptions.push(pkgWatcher);
  // L3 recovery: persist running workflow instances whenever they change.
  // Gate machinery (P2): tier hot-swap across agents + objective run_checks for gated workflows.
  const tierController = new TierController({
    listAgents: () =>
      sessionManager.getAll().map((s) => ({ id: s.id, role: s.config.role, providerId: s.config.provider.providerId })),
    setModel: (id, m) => sessionManager.setModel(id, m),
  });
  workflowEngine = new WorkflowEngine(
    sessionManager,
    messageBus,
    () => persistence.saveWorkflows(workflowEngine.exportState()),
    { tierController, runChecks: runVerifyChecks },
    persistence
  );

  // SettingsBridge centralizes config/secret/MCP access (powers the Settings panel + trims wiring).
  settingsBridge = new SettingsBridge(
    secrets,
    makeConfigStore(),
    providerDefs,
    () => effectiveConnectionRegistry.revision,
    {
      registry: mcpRegistry,
      connected: (id) => mcpHub.listServers().find((s) => s.id === id),
      grantedTo: (id) => agentsGrantedServer(id),
    }
  );

  orchestrationProgress = new OrchestrationProgressTracker(resolveAgentName);
  orchestrationProgress.hydrate(runLedger.snapshot());

  wireEvents();

  teamViewProvider = new TeamViewProvider(
    context.extensionUri,
    sessionManager,
    messageBus,
    context.extension.packageJSON.version,
    smartModeCardPreview,
    () => checkpointStore.list(),
    (providerId) => displayNameForProviderId(providerId, effectiveConnectionRegistry),
    (agentId) => chatViewProvider?.approvalAttentionForAgent(agentId),
    (config) => {
      const narrowing = config.commandNarrowing;
      if (!narrowing) {
        return undefined;
      }
      const global = commandPolicy.allowedCommands;
      const selected = narrowing.allowedCommands.filter((entry) => global.includes(entry.trim().toLowerCase()));
      return `Commands: narrowed (${selected.length} of ${global.length})`;
    },
  );
  messageLogProvider = new MessageLogProvider(messageBus, resolveAgentName, sessionPresentation);
  const prewarmClaudeAgent = (agentId: string): void => {
    const info = sessionManager.get(agentId);
    if (!info) {
      return;
    }
    const backend = info.config.backend ?? defaultBackendKind(info.config, effectiveConnectionRegistry);
    if (backend !== 'claude') {
      return;
    }
    if (info.status !== 'stopped' && info.status !== 'error') {
      return;
    }
    void sessionManager.start(agentId).catch((err) => {
      outputChannel.warn(`[chat] Claude prewarm failed for ${resolveAgentName(agentId)}: ${String(err)}`);
    });
  };
  chatViewProvider = new ChatViewProvider(context.extensionUri, {
    listAgents: () => sessionManager.getAll().map((s) => ({
      id: s.config.id,
      name: s.config.name,
      role: s.config.role,
      icon: s.config.icon,
      backend: s.config.backend ?? defaultBackendKind(s.config, effectiveConnectionRegistry),
      status: s.status,
      canSteer: connectionProfileForAgent(s.config, effectiveConnectionRegistry)?.capabilities.steer === true,
      currentTask: s.currentTask,
      routeLabel: connectionProfileForAgent(s.config, effectiveConnectionRegistry)?.presentation.displayName,
      model: s.config.model,
      costUsd: s.usage?.costUsd,
      turns: s.usage?.turns,
      consentMessage: s.consentMessage,
    })),
    onSendRejected: ({ clause, requestedAgentId, selectedAgentId, requestId }) => {
      outputChannel.warn(
        `[chat] composer send rejected: clause=${clause}; requestedAgentId=${requestedAgentId || '(empty)'}; ` +
        `selectedAgentId=${selectedAgentId || '(empty)'}; requestId=${requestId ?? '(legacy)'}`,
      );
    },
    onRenderedTranscriptDisappearance: (event) => {
      outputChannel.warn(
        `[chat] ${event.cause} rendered transcript item missing from later state: surface=${event.source}; agent=${event.agentId}; ` +
        `missing=${event.missing.map((item) => `${item.id}:${item.delivery}`).join(',')}; ` +
        `epoch=${event.previousTurnEpoch ?? 'unknown'}→${event.nextTurnEpoch ?? 'unknown'}; ` +
        `epochChanged=${event.epochChanged}; undeliveredPushes=${event.undeliveredStatePushes}; ` +
        `lastUndeliveredSurface=${event.lastUndeliveredSurface ?? 'none'}`,
      );
    },
    onOutcomeRepair: (event) => {
      runLedger.recordOutcomeRepair({
        outcomeId: event.outcomeId,
        category: event.category,
        state: event.state,
        recordedAt: event.recordedAt,
        correlationId: event.correlationId ?? sessionManager.currentTurnCorrelationId(event.sessionId || event.agentId),
      });
    },
    openAgentModelSettings: (agentId) => { void vscode.commands.executeCommand('unode.agentEdit', agentId); },
    delegationWaitingResults: (agentId) => sessionManager.pendingAsyncDelegationWakeCount(agentId),
    send: async (agentId, text, mode, userAttachments, turnEpoch) => {
      // There was once a preflight here that regex-scanned the user's PROSE for an absolute path outside
      // the agent's root and refused the turn before the model ever saw it. It was removed, on purpose.
      //
      // Guessing paths out of natural language cannot be made correct: `https://github.com/u/r` ends its
      // scheme in a letter and two slashes, so it parsed as drive `s:` and every task that merely quoted a
      // URL was refused. Each patch bought a new false positive, and a false positive here costs the whole
      // turn.
      //
      // It was also redundant. The real boundary is enforcement, not detection: read_file/write_file
      // path.resolve() the argument and check isInside(root), which `..` cannot walk around. When the model
      // actually reaches outside, that throws BLOCKED_OUTSIDE_WORKDIR, and OpenAICompatBackend turns it into
      // the same "open that project in a new window" message this preflight was racing to print — except it
      // fires on a real access rather than on a guess about one.
      //
      // C1: expand explicit @file/@folder/@problems/@url mentions before routing the turn.
      const root = workspaceRoot();
      const expanded = await expandContextMentions(text, root, {
        readFile: (p) => fs.readFile(p, 'utf8'),
        stat: (p) => fs.stat(p),
        readDir: (p) => fs.readdir(p, { withFileTypes: true }),
        diagnostics: () => diagnosticsSnapshot(root),
        fetchText: fetchMentionUrl,
      });
      const contextManifestSources: ContextManifestSource[] = [];
      contextManifestSources.push({
        kind: 'user-request',
        label: 'Current task',
        location: 'chat composer',
        text,
        reason: 'user-entered task',
      });
      // Mention expansion appends resolved material after the original text. Record that exact appendix
      // without changing the string handed to the backend.
      const appendix = expanded.startsWith(text) ? expanded.slice(text.length) : '';
      const mentions = parseMentions(text);
      if (appendix.trim() && mentions.length > 0) {
        contextManifestSources.push({
          kind: 'context-mention',
          label: `Explicit @ context (${mentions.length})`,
          location: mentions.map((mention) => `@${mention}`).join(', '),
          text: appendix,
          reason: 'user @file/@folder/@problems/@url request',
        });
      }
      const attachmentParts = splitUserAttachments(userAttachments);
      for (const attachment of attachmentParts.textFiles) {
        const supplied = formatUserTextAttachments([attachment]);
        if (supplied) {
          contextManifestSources.push({
            kind: 'user-attachment',
            label: attachment.name,
            location: 'user text attachment',
            text: supplied,
            reason: 'user attached a text file',
          });
        }
      }
      for (const attachment of attachmentParts.images) {
        contextManifestSources.push({
          kind: 'user-attachment',
          label: attachment.name,
          location: 'user image attachment',
          bytes: attachment.size ?? 0,
          reason: 'user attached an image; image token estimate is unavailable',
        });
      }
      for (const attachment of attachmentParts.pdfs) {
        contextManifestSources.push({
          kind: 'user-attachment',
          label: attachment.name,
          location: 'user PDF attachment',
          bytes: attachment.size ?? 0,
          reason: 'user attached a PDF; content is available only through the bounded content-asset reader',
        });
      }
      const delegationContentSources = await admitDelegationContentSources(
        delegationContentAssets,
        contextManifestSources,
        attachmentParts.pdfs,
        attachmentParts.images,
      );
      // Route as a turn; routeInbound lazy-starts a stopped agent for ask.question.
      messageBus.send('user', agentId, 'ask.question', {
        instruction: expanded,
        mode,
        userAttachments,
        contextManifestSources,
        delegationContentSources,
        metadata: { turnEpoch },
      }, 'normal');
    },
    interject: (agentId, text) => sessionManager.interjectAgent(agentId, text),
    interrupt: (agentId) => sessionManager.interrupt(agentId),
    contextMeter: (agentId) => sessionManager.contextMeter(agentId),
    // Report what happened, not what was attempted. Claiming "compacted" while dropping nothing is worse
    // than refusing: the user stops looking for the real problem, which on a rejected turn is usually that
    // the configured context window is larger than the model's real one. Both surfaces derive their
    // sentence from the same outcome, so they cannot contradict each other about one agent.
    compactContext: async (agentId) => {
      chatViewProvider?.postNotice(agentId, compactOutcomeMessage(await sessionManager.compactSession(agentId)));
    },
    onSelectAgent: (agentId) => {
      syncSoloContext();
      prewarmClaudeAgent(agentId);
    },
    // Subscribe to ALL completions, not just those addressed to 'user': when the PM delegates to a
    // teammate, the teammate's task.complete is addressed to the PM, so a {to:'user'} filter would
    // never fire for it — leaving that agent's chat stuck on "Stop" and its reply unfinalized. We key
    // by `from` and the handler scopes each completion to that agent's own chat tab.
    onReply: (cb) =>
      messageBus.subscribe({}, (msg) => {
        if (msg.type === 'task.complete' || msg.type === 'task.partial' || msg.type === 'system.error' || msg.type === 'ask.answer') {
          cb({
            from: msg.from,
            fromName: resolveAgentName(msg.from),
            text: String(msg.payload.instruction ?? ''),
            isError: msg.type === 'system.error' || !!(msg.payload.metadata as { isError?: boolean } | undefined)?.isError,
            ...(msg.type === 'task.partial'
              ? { completionState: 'partial' as const }
              : msg.type === 'task.complete'
                ? { completionState: 'complete' as const }
                : msg.type === 'system.error'
                  ? { completionState: 'not-observed' as const }
                  : {}),
            epoch: normalizeEpoch((msg.payload.metadata as { turnEpoch?: unknown } | undefined)?.turnEpoch),
            timing: (msg.payload.metadata as { turnTiming?: import('./session/TurnTiming').TurnTiming } | undefined)?.turnTiming,
          });
        }
      }),
    state: context.workspaceState,
    getApprovals: () => {
      const cfg = vscode.workspace.getConfiguration('unode');
      return { command: cfg.get<string>('commandApproval', 'ask'), write: cfg.get<string>('writeApproval', 'none') };
    },
    setApproval: async (kind, value) => {
      const cfg = vscode.workspace.getConfiguration('unode');
      const key = kind === 'write' ? 'writeApproval' : 'commandApproval';
      await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
      if (kind === 'command') {
        commandPolicy.reload(cfg.get<CommandApprovalMode>('commandApproval', 'ask'), cfg.get<string[]>('allowedCommands', []));
      }
    },
    presentation: sessionPresentation,
    onWorkbenchOpenChange: (open) => {
      void vscode.commands.executeCommand('setContext', 'unode.workbenchOpen', open);
    },
    approverIdentity: localApproverIdentity,
    getCheckpoints: () => checkpointStore.list(),
    openWorkspaceFile: (agentId, filePath) => orchestrationHost.openRecordedWorkspaceFile(agentId, filePath),
    getRepairState: async (agentId: string): Promise<ChatRepairState | undefined> => {
      const session = sessionManager.get(agentId) ?? sessionManager.getAll()[0];
      if (!session) {
        return 'no-team';
      }
      const profile = connectionProfileForAgent(session.config, effectiveConnectionRegistry);
      if (!profile || profile.availability !== 'available') {
        return 'missing-connection';
      }
      // A CLI-backed profile owns its login flow and is therefore the runnable route. API-key routes
      // are usable only once their SecretStorage reference resolves; neither a key nor its name leaves
      // this host callback.
      if (profile.authKind !== 'api-key') {
        return undefined;
      }
      if (!profile.apiKeySecretName) {
        return 'missing-connection';
      }
      return await secrets.get(profile.apiKeySecretName) ? undefined : 'missing-credential';
    },
    runRepairAction: (state) => {
      if (state === 'no-team') {
        void vscode.commands.executeCommand('unode.createTeamPreset');
        return;
      }
      void vscode.commands.executeCommand('unode.openSettings');
    },
  });
  void vscode.commands.executeCommand('setContext', 'unode.workbenchOpen', false);
  // The rail's open/closed state is remembered per workspace, and the context key drives which of the
  // two title-bar icons is shown (same idiom as collapse/expand on the Team panel).
  const inspectorOpen = context.workspaceState.get<boolean>(WORKBENCH_INSPECTOR_KEY, false);
  chatViewProvider.setInspectorOpen(inspectorOpen);
  void vscode.commands.executeCommand('setContext', 'unode.inspectorOpen', inspectorOpen);
  approvalStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  approvalStatusBarItem.command = 'unode.focusPendingApproval';
  approvalStatusBarItem.tooltip = 'Show the pending UnodeAi approval';
  context.subscriptions.push(approvalStatusBarItem);
  // Priority above the approval item: when both are showing, the thing that stops everything sits furthest
  // left and is the easier target. A brake you have to aim at is a brake that arrives late.
  stopAllStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
  stopAllStatusBarItem.command = 'unode.stopAllAgents';
  stopAllStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  context.subscriptions.push(stopAllStatusBarItem);
  context.subscriptions.push(chatViewProvider.onApprovalEvent(() => updateStatusBar()));
  dashboardProvider = new DashboardProvider(context.extensionUri, sessionManager, messageBus, {
    agentStates: () => orchestrationProgress.agentStates(),
    filesByAgent: dashboardFilesByAgent,
    worktreeReview: async () =>
      vscode.workspace.getConfiguration('unode').get<string>('concurrencyStrategy', 'optimistic') === 'worktree'
        ? gatherWorktreeReview()
        : undefined,
    recentTaskCount: () => context.globalState.get<number>('roam.dashboard.recentTaskCount', 5),
    concurrencyMode: () => vscode.workspace.getConfiguration('unode').get<string>('concurrencyStrategy', 'optimistic'),
  });
  // Live-refresh the open Dashboard. It used to redraw ONLY on 'session.taskTokens', which fires once a
  // whole orchestration finalizes — so tokens, cache %, cost and the lanes all sat frozen while the crew
  // worked, and you had to close and reopen the panel to see anything. Every card reads the live roster at
  // render time, so any of these can change it.
  for (const event of ['session.taskTokens', 'session.context', 'session.status', 'session.started', 'session.stopped'] as const) {
    sessionManager.on(event, scheduleDashboardRefresh);
  }

  registerCommand(context.subscriptions, ADD_SELECTION_TO_UNODE_COMMAND, (payload: unknown) => {
      const candidate = payload as Partial<SelectionComposerPayload> | undefined;
      if (!candidate || !isSelectionUri(candidate.uri) || typeof candidate.text !== 'string' || !candidate.text.trim()) {
        return;
      }
      // The provider enforces this cap when it renders the lightbulb, but the command is a public
      // entry point: any extension can invoke it directly with a payload the provider never saw.
      if (!isAcceptableComposerPayloadLength(candidate.text)) {
        return;
      }
      // The team or selected agent may have changed since VS Code first rendered the lightbulb.
      if (!selectedAgentCanAttachSelection(candidate.uri)) {
        return;
      }
      chatViewProvider.insertIntoSelectedComposer(candidate.text);
  });
  registerUnodeSidebarViews(context.subscriptions, {
    team: teamViewProvider,
    activity: messageLogProvider,
    chat: chatViewProvider,
  });
  context.subscriptions.push(
    // The "before" side of a checkpoint and the base side of a lane have no file on disk. Giving each
    // a URI is what lets file changes open in the NATIVE diff editor instead of a flat scratch buffer.
    vscode.workspace.registerTextDocumentContentProvider(CHECKPOINT_SCHEME, virtualDiffContentProvider),
    vscode.workspace.registerTextDocumentContentProvider(LANE_BASE_SCHEME, virtualDiffContentProvider),
    vscode.languages.registerCodeActionsProvider(
      [{ scheme: 'file' }, { scheme: CHECKPOINT_SCHEME }, { scheme: LANE_BASE_SCHEME }],
      new SelectionToUnodeActionProvider({
        getSelectedAgentId: () => chatViewProvider.getSelectedAgentId(),
        canAttachSelection: selectedAgentCanAttachSelection,
      }),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    chatViewProvider,
    outputChannel
  );

  // @unode Chat-panel participant — ADDITIVE (the extension views above are untouched; both run at once).
  // The handler routes the goal to the crew's PM (or first agent) on UnodeAi's OWN backend, streaming
  // the run into the chat panel. Toggle live via unode.chatParticipant.enabled.
  const runCrewGoal = async (
    prompt: string,
    onText: (md: string) => void,
    token: vscode.CancellationToken
  ): Promise<{ ok: boolean; agentName?: string; error?: string }> => {
    const agents = sessionManager.getAll();
    const target = agents.find((s) => canDelegate(s.config)) ?? agents[0];
    if (!target) {
      return { ok: false, error: 'No agents yet. Open the UnodeAi sidebar and run "Create Default Team", then try @unode again.' };
    }
    const agentId = target.config.id;
    const agentName = target.config.name;
    let anyDelta = false;
    const onStream = (e: TypedSessionEvent<'session.stream'>) => {
      if (e.sessionId === agentId && e.data?.delta) { anyDelta = true; onText(e.data.delta); }
    };
    sessionManager.on('session.stream', onStream);
    try {
      const result = await new Promise<{ ok: boolean; error?: string; finalText?: string }>((resolve) => {
        const off = messageBus.subscribe({}, (msg) => {
          if (msg.from !== agentId) { return; }
          if (msg.type === 'task.complete') { off(); resolve({ ok: true, finalText: String(msg.payload.instruction ?? '') }); }
          else if (msg.type === 'system.error') { off(); resolve({ ok: false, error: String(msg.payload.instruction ?? 'the crew reported an error') }); }
        });
        token.onCancellationRequested(() => { off(); sessionManager.interrupt(agentId); resolve({ ok: false, error: 'Cancelled.' }); });
        // Route the goal as a turn (routeInbound lazy-starts a stopped agent for ask.question).
        messageBus.send('user', agentId, 'ask.question', { instruction: prompt, mode: 'act' }, 'normal');
      });
      // If the backend didn't stream deltas (non-streaming model), surface the final text once.
      if (result.ok && !anyDelta && result.finalText) { onText(result.finalText); }
      return { ok: result.ok, agentName, error: result.error };
    } finally {
      sessionManager.off('session.stream', onStream);
    }
  };
  let unodeChatParticipant: vscode.Disposable | undefined;
  const syncUnodeChatParticipant = () => {
    const enabled = vscode.workspace.getConfiguration('unode').get<boolean>('chatParticipant.enabled', true);
    if (enabled && !unodeChatParticipant) {
      try {
        unodeChatParticipant = registerUnodeChatParticipant(context.extensionUri, { runGoal: runCrewGoal });
        context.subscriptions.push(unodeChatParticipant);
      } catch (err) {
        outputChannel.warn(`[chat] @unode participant registration failed: ${String(err)}`);
      }
    } else if (!enabled && unodeChatParticipant) {
      unodeChatParticipant.dispose();
      unodeChatParticipant = undefined;
    }
  };
  syncUnodeChatParticipant();

  // Always-visible anchor: shows the build version no matter which sidebar sections are collapsed
  // (a collapsed Team section folds away its title-bar version), and one click reopens the Unode sidebar.
  unodeVersion = String(context.extension.packageJSON.version ?? '');
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = `$(organization) Unode v${unodeVersion}`;
  statusBarItem.command = 'unode.showTeamPanel';
  statusBarItem.tooltip = 'UnodeAi — show the Team panel';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Restore persisted state (P1#4/#5): approved MCP servers, message history, then roster.
  for (const id of persistence.loadApprovedMcpServers()) {
    approvedMcp.add(id);
  }
  messageBus.importMessages(persistence.loadMessages());

  registerCommands(context);
  void vscode.commands.executeCommand('setContext', 'unode.teamCompact', false);
  syncConcurrencyContext(); // pick the right concurrency icon for the Team title bar
  await migrateToProviderSplit(context); // 0.9.0: Roam→weroam default; existing roam agents+key kept on Unode
  await migrateLegacySingletonCustomGateways(context);
  await correctStaleRoamBaseUrl(); // every launch (idempotent): heal a stale persisted unode.baseUrl=unode
  await restoreRoster();
  // Show the restored history — AFTER the roster, never before. The feed resolves each agent id to a name
  // and BAKES it into the item, so hydrating first prints a wall of raw UUIDs that no later refresh can
  // undo. (The bus itself only replays into its queryable store and never re-dispatches to subscribers,
  // which is why the feed needs telling at all.)
  // Project the complete retained bus history before applying the 300-line presentation cap. Repeated
  // activities may fold to one line, so slicing raw events first would change counts after a reload.
  messageLogProvider.hydrate(messageBus.query(), messageBus.getMessageCount());
  syncSoloContext(); // solid ⚡ only while the current chat target is Solo
  // L3: resume any workflows that were mid-flight before the reload (agents now exist).
  workflowEngine.restore(persistence.loadWorkflows());
  updateStatusBar();

  // Setup is deliberately user-initiated. Activating a window must never take over the editor, and a
  // workspace-local completion flag cannot be a reliable proxy for a user's global intent.

  // The BUILD, not just the version. package.json's version does not move between hotfixes, so "is the user
  // running the build I just handed them?" is otherwise unanswerable — and we have already lost a debugging
  // round to a probe that looked broken when it may simply have not been installed.
  outputChannel.info(`UnodeAi activated (v${unodeVersion}, build ${BUILD_SHA})`);
  // Test-only exports let the packaged E2E use this activated module instance. Requiring out/extension.js
  // separately creates a second instance with no ExtensionContext, which would weaken or bypass the mode
  // boundary around host proof seams.
  return context.extensionMode === vscode.ExtensionMode.Test
    ? { __testLocalPdfAttachmentPipeline }
    : undefined;
}

export async function deactivate(): Promise<void> {
  outputChannel?.info('UnodeAi deactivating, stopping all agents...');
  if (dashboardRefreshTimer) {
    clearTimeout(dashboardRefreshTimer);
    dashboardRefreshTimer = undefined;
  }
  if (messageSaveTimer) {
    clearTimeout(messageSaveTimer);
    persistence?.saveMessages(messageBus.exportMessages());
  }
  if (runSaveTimer) {
    clearTimeout(runSaveTimer);
    persistence?.saveRuns(runLedger.snapshot());
  }
  if (checkpointSaveTimer) {
    clearTimeout(checkpointSaveTimer);
    persistence?.saveCheckpoints(checkpointStore.serialize());
  }
  // VS Code waits for a returned promise during deactivation. Finish backend cleanup while host services
  // (especially output channels) still exist; fire-and-forget shutdown can emit into a disposed host and
  // leak dynamically-created channels during extension-host teardown.
  await sessionManager?.stopAll();
  sessionManager?.dispose();
  messageBus?.dispose();
  terminalManager.disposeAll();
  await mcpHub?.stopAll();
  for (const { channel } of agentChannels.values()) {
    channel.dispose();
  }
  agentChannels.clear();
}

/**
 * Extension-host proof seam for the local-PDF boundary. It is deliberately not a
 * command and has no production caller: it requires both ExtensionMode.Test and
 * the explicit E2E fixture marker. The packaged E2E suite imports the bundled
 * extension module, hands this one user attachment to the same
 * WorkspaceTools path as OpenAICompatBackend, then checks its receipt and a
 * non-total page read. Keeping that proof at the host boundary caught the
 * v0.9.57 worker-packaging regression that source-only tests could not see.
 */
export async function __testLocalPdfAttachmentPipeline(attachment: UserAttachment, fixture: unknown): Promise<{
  intake: string;
  read: string;
  receipts: ContentReceiptObservation[];
  durableMessage: Message;
}> {
  if (!isE2EFixtureRequest(extensionContext?.extensionMode, fixture)) {
    throw new Error('__testLocalPdfAttachmentPipeline runs only in the extension-host E2E (Test mode).');
  }
  const receipts: ContentReceiptObservation[] = [];
  const tools = new WorkspaceTools(process.cwd(), new Set(['read']), 'extension-e2e-pdf');
  tools.setContentReceiptObserver((receipt) => receipts.push(receipt));
  try {
    const intake = await tools.importUserAttachedPdfs([attachment]);
    const match = intake.match(/temporary asset (content-\d+)/);
    const read = match
      ? await tools.runText('read_extracted_content', { assetId: match[1], pages: { start: 2, end: 2 } })
      : '';
    const bus = new MessageBus();
    try {
      bus.send('user', 'extension-e2e-pdf', 'ask.question', {
        instruction: 'Read the local PDF attachment.',
        userAttachments: [attachment],
      });
      const durableMessage = bus.exportMessages()[0];
      if (!durableMessage) {
        throw new Error('Local PDF E2E probe did not retain its message receipt.');
      }
      return { intake, read, receipts, durableMessage };
    } finally {
      bus.dispose();
    }
  } finally {
    await tools.disposeBackground();
  }
}

// ─── Backend env (joins config with SecretStorage) ────────────────────

async function resolveEnv(config: AgentConfig): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...config.env };
  const route = config.route ?? agentRouteFromLegacyConfig(config, effectiveConnectionRegistry);
  const secretName = apiKeySecretNameForRoute(route, effectiveConnectionRegistry);
  if (secretName) {
    const key = await secrets.get(secretName);
    if (key) {
      env[secretName] = key;
    }
  }
  env.ROAM_AGENT_ID = config.id;
  env.ROAM_AGENT_ROLE = config.role;

  // For a claude agent that hosts MCP servers, inject the secrets those servers reference via
  // ${VAR} so claude can expand them when it spawns the servers (no secrets written to disk).
  const kind = config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry);
  if (kind === 'claude') {
    const grants = agentMcpGrants(config, skillResolver);
    for (const cfg of grantedServerConfigs(grants, { approvedOnly: true })) {
      for (const varName of secretVarsInServer(cfg)) {
        if (env[varName]) {
          continue;
        }
        const secretVal = await secrets.get(varName);
        if (secretVal) {
          env[varName] = secretVal;
        }
      }
    }
  }
  return env;
}

function withOpenAICompatBaseUrl(config: AgentConfig): AgentConfig {
  const route = config.route ?? agentRouteFromLegacyConfig(config, effectiveConnectionRegistry);
  const baseUrl = resolveOpenAICompatBaseUrl(route, effectiveConnectionRegistry);
  return baseUrl === config.baseUrl ? config : { ...config, baseUrl };
}

/**
 * The final route boundary. E3 writes versioned routes for every roster, but this legacy conversion remains
 * for the compatibility window and rejects conflicting hand-edited fields rather than guessing. A
 * route-bearing config is stricter: the persisted user choice and the runtime envelope must remain identical.
 */
function makeRouteBoundaryAssert(
  config: AgentConfig,
  backendKind: AgentBackendKind,
  endpointBase: string,
  selectedRouteAtConstruction?: AgentRoute
): () => void {
  // Legacy config has no persisted route until E3. Freeze its selected connection/backend now while
  // allowing the existing hot model-selection paths to keep changing only the model field. Persisted
  // routes are already strict: their exact model is the user-selected route authority.
  const selectedRoute = selectedRouteAtConstruction ?? config.route ?? agentRouteFromLegacyConfig(config, effectiveConnectionRegistry);
  const activeProfileAtConstruction = captureActiveConnectionProfile(selectedRoute, effectiveConnectionRegistry);
  return () => {
    // A healthy watcher is only a UI optimization. If it fails, deny custom gateway egress rather
    // than trusting this process's cached endpoint/key snapshot.
    assertCustomGatewayRegistryWatchCurrent(selectedRoute.connectionId, customGatewayRegistryWatchSupervisor);
    assertActiveConnectionProfile(activeProfileAtConstruction, selectedRoute, effectiveConnectionRegistry);
    const runtimeRoute = agentRouteFromLegacyConfig({ ...config, backend: backendKind }, effectiveConnectionRegistry);
    const selected = config.route ? selectedRoute : { ...selectedRoute, modelId: runtimeRoute.modelId } as AgentRoute;
    const selectedProfile = connectionProfile(selected.connectionId, effectiveConnectionRegistry);
    const runtimeProfile = connectionProfile(runtimeRoute.connectionId, effectiveConnectionRegistry);
    if (!selectedProfile || !runtimeProfile) {
      throw new Error('Resolved route boundary rejected an unknown connection.');
    }
    // The selected envelope deliberately uses the registry-pinned endpoint, while the runtime
    // envelope uses the exact endpoint about to be handed to the backend. Comparing two copies of
    // config.baseUrl would make a forged workspace value self-consistent and therefore invisible.
    const selectedEndpointBase = selected.kind === 'openai-compatible'
      ? resolveOpenAICompatBaseUrl(selected, effectiveConnectionRegistry)
      : endpointBase;
    const selectedEnvelope = createResolvedAgentRoute({
      route: selected,
      profile: selectedProfile,
      endpointBase: selectedEndpointBase,
      authIdentityRef: authIdentityRefForRoute(selected, effectiveConnectionRegistry),
      toolProtocol: config.toolProtocol,
    });
    const runtimeEnvelope = createResolvedAgentRoute({
      route: runtimeRoute,
      profile: runtimeProfile,
      endpointBase,
      authIdentityRef: authIdentityRefForRoute(runtimeRoute, effectiveConnectionRegistry),
      toolProtocol: config.toolProtocol,
    });
    assertResolvedRoute(selectedEnvelope, runtimeEnvelope);
  };
}

/** Read the current Smart Mode config from settings (F3). */
function readSmartMode(): SmartModeConfig {
  const cfg = vscode.workspace.getConfiguration('unode');
  return {
    enabled: cfg.get<boolean>('smartMode.enabled', false),
    defaultTier: cfg.get<ModelTier>('smartMode.defaultTier', 'standard'),
    roleTiers: cfg.get<Record<string, ModelTier>>('smartMode.roleTiers', {}),
    taskTierHints: cfg.get<Record<string, ModelTier>>('smartMode.taskTierHints', {}),
  };
}

interface TaskModelSelection {
  tier: ModelTier;
  model?: string;
  modelParams?: AgentModelParams;
}

function configuredRoutingTier(config: AgentConfig): ModelTier {
  const sm = readSmartMode();
  return config.tier ?? sm.roleTiers?.[config.role] ?? ROLE_TEMPLATES[config.role]?.tier ?? sm.defaultTier;
}

/** The tier is the host's routing choice for this turn, not a provider-reported identity. */
function hostSelectedRoutingTier(config: AgentConfig, msg: Message): ModelTier {
  const configuredTier = configuredRoutingTier(config);
  const sm = readSmartMode();
  return sm.enabled && (config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry)) === 'openai-compat'
    ? selectTier(msg, sm, configuredTier)
    : configuredTier;
}

/** Smart Mode (F3): pick the model and optional tier params for this task.
 *  Reuses the existing tier tables (DEFAULT_MODEL_TIERS + unode.modelTiers override). */
function resolveTaskModelSelection(config: AgentConfig, msg: Message): TaskModelSelection | undefined {
  if ((config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry)) !== 'openai-compat') {
    return undefined;
  }
  const sm = readSmartMode();
  if (!sm.enabled) {
    return undefined;
  }
  const tier = hostSelectedRoutingTier(config, msg);
  const tiers = resolveModelTiers(
    vscode.workspace.getConfiguration('unode').get<Partial<Record<ModelTier, Record<string, string>>>>('modelTiers', {})
  );
  const rawTierParams = vscode.workspace
    .getConfiguration('unode')
    .get<Partial<Record<ModelTier, AgentModelParams>>>('modelTierParams', {});
  const modelParams = sanitizeParams(rawTierParams[tier]);
  const providerModel = tiers[tier]?.[config.provider.providerId];
  if (!providerModel) {
    // No model is defined for THIS agent's provider at this tier. Do NOT fall back to another provider's id
    // (it would 400 here — exactly what the Settings tier matrix warns about). Skip the swap entirely so the
    // agent runs its own configured model. Fill the provider's column in the tier matrix to enable Smart Mode.
    return undefined;
  }
  return {
    tier,
    model: providerModel,
    modelParams: Object.keys(modelParams).length > 0 ? modelParams : undefined,
  };
}

function economyModelFor(config: AgentConfig): string {
  const tiers = resolveModelTiers(
    vscode.workspace.getConfiguration('unode').get<Partial<Record<ModelTier, Record<string, string>>>>('modelTiers', {})
  );
  // Exact economy model for THIS provider, else the agent's own configured model (always valid for its
  // provider). Never fall back to another provider's id — that would 400 (e.g. during summarization).
  return tiers.economy?.[config.provider.providerId] ?? config.model;
}

/** Team-card Smart Mode preview: the tier + the model an agent will ACTUALLY run on (its provider's exact
 *  tier model), or undefined when Smart Mode is off. `model` undefined = no tier model for this provider →
 *  the agent keeps its configured model (mirrors resolveTaskModelSelection's no-cross-provider-swap rule). */
function smartModeCardPreview(
  config: { role: string; tier?: string; provider: { providerId: string } }
): { tier: ModelTier; model?: string } | undefined {
  const sm = readSmartMode();
  if (!sm.enabled) {
    return undefined;
  }
  const tier: ModelTier =
    (config.tier as ModelTier | undefined) ?? sm.roleTiers?.[config.role] ?? ROLE_TEMPLATES[config.role]?.tier ?? sm.defaultTier;
  const tiers = resolveModelTiers(
    vscode.workspace.getConfiguration('unode').get<Partial<Record<ModelTier, Record<string, string>>>>('modelTiers', {})
  );
  return { tier, model: tiers[tier]?.[config.provider.providerId] };
}

async function summarizerChatCompletion(
  config: AgentConfig,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  model: string,
  params?: AgentModelParams
): Promise<string> {
  const selectedRoute = config.route ?? agentRouteFromLegacyConfig(config, effectiveConnectionRegistry);
  const secretName = apiKeySecretNameForRoute(selectedRoute, effectiveConnectionRegistry);
  const env = await resolveEnv(config);
  const apiKey = secretName ? env[secretName] ?? '' : '';
  if (!apiKey) {
    throw new Error(`No API key for ${secretName ?? selectedRoute.connectionId}.`);
  }

  const body: Record<string, unknown> = { model, messages, stream: false };
  if (params?.temperature !== undefined) {
    body.temperature = params.temperature;
  }
  if (params?.max_tokens !== undefined) {
    body.max_tokens = params.max_tokens;
  }

  const summarizerUrl = `${openAIBaseUrlFor(config, env)}/chat/completions`;
  // This is model-content egress too. It runs outside OpenAICompatBackend, so it needs the same final
  // route assertion rather than relying on that backend's guard.
  makeRouteBoundaryAssert(
    { ...config, backend: 'openai-compat', model },
    'openai-compat',
    openAIBaseUrlFor(config, env),
    selectedRoute
  )();
  await egressGate(summarizerUrl, undefined, 'Conversation summarization'); // egress consent — no content sent until the host is approved
  const res = await (globalThis as any).fetch(summarizerUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while summarizing history: ${String(text).slice(0, 300)}`);
  }
  const data = JSON.parse(text);
  return String(data.choices?.[0]?.message?.content ?? '');
}

function openAIBaseUrlFor(config: AgentConfig, _env: NodeJS.ProcessEnv): string {
  const route = config.route ?? agentRouteFromLegacyConfig(config, effectiveConnectionRegistry);
  return resolveOpenAICompatBaseUrl(route, effectiveConnectionRegistry);
}

/** Build the run_command gatekeeper from settings. Default-deny: execution is off unless the
 *  user picks a mode and (for allowlist) lists trusted command prefixes. */
function makeCommandPolicy(): CommandPolicy {
  const cfg = vscode.workspace.getConfiguration('unode');
  const mode = cfg.get<CommandApprovalMode>('commandApproval', 'ask');
  const allowlist = cfg.get<string[]>('allowedCommands', []);
  return new CommandPolicy(mode, allowlist);
}

/**
 * v0.2.8 'ask' mode: prompt the user before an agent runs a not-yet-allowlisted command, modeled on
 * Claude Code's Yes / Yes-for-this-project / No. "Always allow" appends the command's TEMPLATE
 * (e.g. "git status", not bare "git") to unode.allowedCommands and reloads the live policy, so future
 * matching commands run without a prompt — without green-lighting dangerous siblings.
 */
/**
 * #4b: after a team is created, prompt the user to review team policy and advisory guidance. Only
 * nags when no guidance exists yet, so
 * re-creating a team with existing rules is quiet. Modal so it's a deliberate choice, but skippable.
 */
/** Classify the CURRENT roster so the Team Rules default matches the team you actually created. Keyed on
 *  each agent's SKILL — knowledge specialists' role templates are all role:'custom', so role can't tell a
 *  Business Planning team from a software crew (the bug this fixes); skill can. */
function currentTeamKind(): TeamRulesKind {
  return teamKindFromSkills(sessionManager.getAll().map((s) => s.config.skill));
}

/** The generated rules block is deliberately a roster index, not a second copy of agent biographies. */
function currentTeamRoster(): TeamRosterMember[] {
  return sessionManager.getAll().map((session) => {
    const config = session.config;
    const template = config.roleTemplateKey ? ROLE_TEMPLATES[config.roleTemplateKey] : undefined;
    const role = template?.name
      ?? (config.role === 'custom' ? config.name : humanizeRole(config.role));
    const duty = config.description
      ?? template?.description
      ?? SKILL_LIBRARY[config.skill]?.description
      ?? 'Contribute within the assigned scope.';
    return { name: config.name, role, duty };
  });
}

function humanizeRole(role: string): string {
  return role.split(/[-_\s]+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ') || 'Team member';
}

/** Open the Team Rules editor directly, seeded by the current team kind. A `presetBody` (from the preset
 *  picker) is loaded as the editor content so Save replaces the current rules. */
function openRulesEditor(presetBody?: string): void {
  void openTeamRulesPanel({
    rulesFilePath: rulesFile.path,
    defaultTemplate: defaultTeamRules(currentTeamKind()),
    initialContent: presetBody,
    onSaved: () => { void syncTeamRulesOnRosterChange(); },
    currentPolicy: () => teamPolicyStore.current(),
    setReviewPolicyFromHumanPanel: (enabled) => teamPolicyStore.setFromHumanPanel(enabled),
    latestPolicyChangeAt: () => teamPolicyStore.changes().at(-1)?.recordedAt,
  });
}

/** The Rules-button menu: edit the rules yourself, or replace them with one of the prepared presets. */
async function showTeamRulesMenu(): Promise<void> {
  type Item = vscode.QuickPickItem & { action: 'edit' | 'preset' };
  const pick = await vscode.window.showQuickPick<Item>([
    { label: '$(edit) Edit rules yourself', detail: 'Open the current team rules to write or tweak them', action: 'edit' },
    { label: '$(list-selection) Use a rules preset…', detail: 'Replace the rules with a prepared template you can still edit', action: 'preset' },
  ], { title: 'Team Rules', placeHolder: "Set your team's rules" });
  if (!pick) { return; }
  if (pick.action === 'edit') { openRulesEditor(); return; }

  // Preset flow — list the prepared presets, the current team kind first.
  const kind = currentTeamKind();
  const ordered = [...TEAM_RULES_PRESETS].sort((a, b) => Number(b.id === kind) - Number(a.id === kind));
  type PresetItem = vscode.QuickPickItem & { id: string };
  const chosen = await vscode.window.showQuickPick<PresetItem>(
    ordered.map((p) => ({ label: p.label, detail: p.description, id: p.id })),
    { title: 'Team Rules — pick a preset', placeHolder: 'Choose a starter template (you can still edit it before saving)' }
  );
  if (!chosen) { return; }
  const preset = TEAM_RULES_PRESETS.find((p) => p.id === chosen.id);
  if (preset) { openRulesEditor(preset.body); }
}

/**
 * After a team or role change, update only the owned roster block. Empty rules receive the current kind's
 * static template; a previous unmodified kind default may switch templates, while custom rules stay intact.
 */
async function syncTeamRulesOnRosterChange(): Promise<void> {
  await rulesFile.load();
  const current = rulesFile.get();
  const kind = currentTeamKind();
  const next = syncTeamRulesWithRoster(current, kind, currentTeamRoster());
  if (next === current) { return; }
  try {
    await fs.mkdir(path.dirname(rulesFile.path), { recursive: true });
    await fs.writeFile(rulesFile.path, next, 'utf8');
    await rulesFile.load();
  } catch { /* best-effort — never block team creation on a rules write */ }
}

/** Coalesce create/remove bursts (including a team switch) into one complete-roster rewrite. */
function scheduleTeamRulesOnRosterChange(): void {
  if (teamRulesRosterSyncTimer) { return; }
  teamRulesRosterSyncTimer = setTimeout(() => {
    teamRulesRosterSyncTimer = undefined;
    void syncTeamRulesOnRosterChange();
  }, 0);
}

// Command templates the user approved for THIS session only (in-memory, not persisted).
const sessionApprovedCommands = new Set<string>();

/**
 * AR3: record only the policy's narrow template, only once an actual approval prompt is about to be shown.
 * The setting is application-scoped and defaults off; this never sends data anywhere.
 */
function recordPromptedCommand(template: string): void {
  if (!template || !vscode.workspace.getConfiguration('unode').get<boolean>('debug.promptedCommandLog', false)) {
    return;
  }
  promptedCommandLog.record(template);
  const context = extensionContext;
  if (!context) {
    return;
  }
  const snapshot = promptedCommandLog.serialize();
  promptedCommandLogSave = promptedCommandLogSave
    .catch((error) => outputChannel.warn(`Could not save prompted-command frequencies: ${String(error)}`))
    .then(() => context.globalState.update(PROMPTED_COMMAND_LOG_KEY, snapshot));
}

function showPromptedCommandLog(context: vscode.ExtensionContext): void {
  if (!promptedCommandOutputChannel) {
    promptedCommandOutputChannel = vscode.window.createOutputChannel('UnodeAi: Prompted Commands');
    context.subscriptions.push(promptedCommandOutputChannel);
  }
  const enabled = vscode.workspace.getConfiguration('unode').get<boolean>('debug.promptedCommandLog', false);
  promptedCommandOutputChannel.clear();
  promptedCommandOutputChannel.appendLine('UnodeAi prompted-command approval frequency (local only)');
  promptedCommandOutputChannel.appendLine(`Logging is ${enabled ? 'enabled' : 'disabled'}; raw commands and arguments are never recorded.`);
  if (!enabled) {
    promptedCommandOutputChannel.appendLine('Enable the User setting unode.debug.promptedCommandLog to collect future approval prompts.');
  }
  promptedCommandOutputChannel.appendLine('');
  for (const line of formatPromptedCommandLog(promptedCommandLog.ranked())) {
    promptedCommandOutputChannel.appendLine(line);
  }
  promptedCommandOutputChannel.show(true);
}

/** Product metric for the human portion of a turn; no prompt contents or approval choices are retained. */
function localApproverIdentity(): string {
  return `local:${vscode.env.machineId}`;
}

function recordApprovalMetric(
  origin: { agentId?: string; sessionId?: string },
  startedAtMs: number,
  decision: RunPermissionDecision,
  kind?: RunPermissionKind,
  approverId?: string,
): void {
  sessionManager.recordApprovalOutcome(origin.sessionId ?? origin.agentId, Date.now() - startedAtMs, decision !== 'allowed');
  if (kind) {
    runLedger.recordPermission({
      agentId: origin.sessionId ?? origin.agentId,
      kind,
      decision,
      ...(approverId ? { approverId } : {}),
      correlationId: sessionManager.currentTurnCorrelationId(origin.sessionId ?? origin.agentId ?? ''),
    });
  }
}

function approvalMetricDecision(action: string, expired?: true): RunPermissionDecision {
  return expired ? 'expired' : action === 'deny' ? 'denied' : 'allowed';
}

function savePendingDelegationResults(): void {
  const snapshot = pendingDelegationResults.snapshot();
  pendingDelegationResultsSave = pendingDelegationResultsSave
    .then(() => persistence.savePendingDelegationResults(snapshot))
    .catch((error) => outputChannel.warn(`Could not save a settled delegation result: ${String(error)}`));
}

async function requestCommandApproval(
  command: string,
  agentName = 'An agent',
  context?: { warning?: string; forcePrompt?: boolean; activeShell?: 'cmd' },
  origin: { agentId?: string; sessionId?: string } = {},
): Promise<CommandApprovalDecision> {
  const template = CommandPolicy.commandTemplate(command);
  const hasSafeCommandOffer = !!template && SAFE_COMMAND_TEMPLATES.includes(template) && !context?.forcePrompt;
  // WorkspaceTools uses cmd.exe, while Claude can use a native PowerShell tool. Scope the compatibility
  // warning to the former; a global Windows check would incorrectly block the latter.
  const cmdletWarning = context?.activeShell === 'cmd' ? windowsCmdletCompatibilityWarning(template) : undefined;
  // Already approved for this session → run without prompting again. `forcePrompt` overrides that: the
  // latch was granted to the command TEMPLATE (`type`), not to this command's new out-of-root argument.
  if (template && sessionApprovedCommands.has(template) && !context?.forcePrompt) {
    return cmdletWarning ? { allow: false, note: cmdletWarning } : { allow: true };
  }
  // Prefer the in-panel approval card; fall back to a native modal if the chat webview isn't available.
  // This is deliberately after all silent paths and before either UI route: count every actual interruption,
  // never an allowlisted execution or a raw command string.
  recordPromptedCommand(template);
  const safeListNote = hasSafeCommandOffer
    ? `"${template}" is in UnodeAi's reviewed safe command list. Enable that list explicitly for this workspace to stop prompting for its read/build/test commands; you can inspect or remove entries later in unode.allowedCommands.`
    : undefined;
  const warning = [context?.warning, cmdletWarning, safeListNote].filter((value): value is string => !!value).join('\n\n') || undefined;
  const approvalStartedAt = Date.now();
  const inPanel = chatViewProvider?.canPromptApproval() === true;
  const { action, note, approverId, expired } = inPanel
    ? await chatViewProvider!.requestApproval({ kind: 'command', agentName, command, template, warning, safeCommandOffer: hasSafeCommandOffer, ...origin })
    : { ...await nativeCommandApprovalChoice(command, template, warning, hasSafeCommandOffer), approverId: localApproverIdentity(), expired: undefined };
  recordApprovalMetric(origin, approvalStartedAt, approvalMetricDecision(action, expired), 'command-approval', approverId);
  return applyCommandApproval(action, note, template, context?.activeShell);
}

/** Apply a command-approval action (from the panel card or the native modal) + its side effects. */
async function applyCommandApproval(
  action: string,
  note: string | undefined,
  template?: string,
  activeShell?: 'cmd'
): Promise<CommandApprovalDecision> {
  const cmdletWarning = activeShell === 'cmd' ? windowsCmdletCompatibilityWarning(template ?? '') : undefined;
  if (action !== 'deny' && cmdletWarning) {
    // The warning was rendered before the user chose an allow action. Do not persist or execute a prefix
    // that WorkspaceTools can never run; tell the agent to use cmd.exe syntax instead.
    return { allow: false, note: cmdletWarning };
  }
  if (action === 'once') {
    return { allow: true };
  }
  if (action === 'session') {
    if (template) { sessionApprovedCommands.add(template); }
    return { allow: true };
  }
  if (action === 'project') {
    const cfg = vscode.workspace.getConfiguration('unode');
    const list = cfg.get<string[]>('allowedCommands', []);
    if (template && !list.map((p) => p.toLowerCase()).includes(template)) {
      await cfg.update('allowedCommands', [...list, template], vscode.ConfigurationTarget.Workspace);
    }
    commandPolicy.reload(
      cfg.get<CommandApprovalMode>('commandApproval', 'ask'),
      cfg.get<string[]>('allowedCommands', [])
    );
    return { allow: true };
  }
  if (action === 'safe' && template && SAFE_COMMAND_TEMPLATES.includes(template)) {
    const cfg = vscode.workspace.getConfiguration('unode');
    const existing = cfg.get<string[]>('allowedCommands', []);
    const existingLower = new Set(existing.map((entry) => entry.toLowerCase()));
    const merged = [...existing, ...SAFE_COMMAND_TEMPLATES.filter((entry) => !existingLower.has(entry.toLowerCase()))];
    await cfg.update('allowedCommands', merged, vscode.ConfigurationTarget.Workspace);
    commandPolicy.reload(cfg.get<CommandApprovalMode>('commandApproval', 'ask'), merged);
    void vscode.window.showInformationMessage(
      'Enabled reviewed safe commands for this workspace. Review or remove them anytime in unode.allowedCommands.'
    );
    return { allow: true };
  }
  // 'deny' or anything unexpected → deny (optionally with a note for the agent).
  return { allow: false, note: note?.trim() || undefined };
}

/** Native-modal fallback for command approval. Returns the same {action, note} shape as the panel card. */
async function nativeCommandApprovalChoice(command: string, template?: string, warning?: string, safeCommandOffer = false): Promise<{ action: string; note?: string }> {
  const ONCE = 'Allow once';
  const SESSION = 'Allow this session';
  const PROJECT = template ? `Allow for project ("${template}")` : 'Allow for project';
  const SAFE = 'Enable safe commands';
  const DENY_NOTE = 'Deny with note…';
  const choice = await vscode.window.showWarningMessage(
    `${warning ? `${warning}\n\n` : ''}An agent wants to run a command:\n\n${command}`,
    { modal: true },
    ONCE,
    SESSION,
    PROJECT,
    ...(safeCommandOffer ? [SAFE] : []),
    DENY_NOTE
  );
  if (choice === ONCE) { return { action: 'once' }; }
  if (choice === SESSION) { return { action: 'session' }; }
  if (choice === PROJECT) { return { action: 'project' }; }
  if (choice === SAFE) { return { action: 'safe' }; }
  if (choice === DENY_NOTE) {
    const note = await vscode.window.showInputBox({
      title: 'Deny command — note to the agent (optional)',
      prompt: 'Tell the agent why, or what to do instead. Leave empty to just deny.',
      placeHolder: 'e.g. don\'t use rm; clean the build with "npm run clean" instead',
      ignoreFocusOut: true,
    });
    return { action: 'deny', note: note?.trim() || undefined };
  }
  return { action: 'deny' };
}

// V2: session latch for "Approve all writes" — once set, stop prompting for this VS Code session.
let writeApprovedAll = false;

/** V2: preview a pending file write (diff) and let the user approve once / approve all / deny. */
async function requestWriteApproval(
  req: { path: string; before: string | null; after: string },
  agentName = 'An agent',
  origin: { agentId?: string; sessionId?: string } = {},
): Promise<'once' | 'always' | 'deny'> {
  if (writeApprovedAll) {
    return 'once';
  }
  const { text } = createUnifiedDiff(req.before ?? '', req.after, req.path);
  const MAX_PREVIEW = 1500;
  const preview = text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}\n…(diff truncated)` : text;
  const verb = req.before === null ? 'create' : 'overwrite';

  // Prefer the in-panel approval card; fall back to a native modal if the chat webview isn't available.
  const approvalStartedAt = Date.now();
  let action: string;
  let approverId: string | undefined;
  let expired: true | undefined;
  if (chatViewProvider?.canPromptApproval()) {
    const resolution = await chatViewProvider.requestApproval({ kind: 'write', agentName, path: req.path, verb, diff: preview, ...origin });
    action = resolution.action;
    approverId = resolution.approverId;
    expired = resolution.expired;
  } else {
    const APPROVE = 'Approve';
    const ALL = 'Approve all (session)';
    const choice = await vscode.window.showWarningMessage(
      `An agent wants to ${verb} ${req.path}:\n\n${preview}`,
      { modal: true },
      APPROVE,
      ALL
    );
    action = choice === ALL ? 'always' : choice === APPROVE ? 'once' : 'deny';
    approverId = localApproverIdentity();
  }
  recordApprovalMetric(origin, approvalStartedAt, approvalMetricDecision(action, expired), 'write-approval', approverId);

  if (action === 'always') {
    writeApprovedAll = true;
    return 'always';
  }
  return action === 'once' ? 'once' : 'deny';
}

/** Drive `unode.soloActive` so the Team toolbar shows the solid ⚡ only while Solo is selected. */
function syncSoloContext(): void {
  const selectedIsSolo = isSoloSelected();
  void vscode.commands.executeCommand('setContext', 'unode.soloActive', selectedIsSolo);
  teamViewProvider?.refresh();
}

function isSoloSelected(): boolean {
  const agents = sessionManager?.getAll() ?? [];
  const selected = chatViewProvider?.getSelectedAgentId();
  return selected
    ? agents.some((s) => s.id === selected && s.config.role === 'solo')
    : agents.length === 1 && agents[0]?.config.role === 'solo';
}

/**
 * Build the SHARED file-concurrency coordinator. In `worktree` mode, isolated agents get their own
 * tree (handled by the WorktreeCoordinator + a per-agent Noop in createBackend); the shared coordinator
 * still guards any agents left on the shared root (the PM, or fallback when git/clean checks fail).
 * Optimistic CAS is the right shared guard in both modes.
 */
function makeFileCoordinator(): FileCoordinator {
  return new OptimisticFileCoordinator();
}

/** Worktree fan-out (v0.6.x): wire the per-agent worktree + merge-back coordinator from config. */
/** One-time toast when worktree mode is on but the workspace isn't a git repo (so isolation silently can't
 *  engage and Roam uses the shared workspace). Offers a one-click switch to Optimistic. */
let worktreeGitWarningShown = false;
async function warnWorktreeNeedsGit(): Promise<void> {
  if (worktreeGitWarningShown) {
    return;
  }
  worktreeGitWarningShown = true;
  const OPTIMISTIC = 'Switch to Optimistic';
  const INIT = 'Initialize Git';
  const choice = await vscode.window.showWarningMessage(
    'UnodeAi: Worktree mode needs a git repository, but this workspace isn’t one — agents are sharing the ' +
      'workspace (no per-agent isolation). Switch to Optimistic mode, or initialize a git repo to enable isolation.',
    OPTIMISTIC,
    INIT
  );
  if (choice === OPTIMISTIC) {
    await vscode.workspace.getConfiguration('unode').update('concurrencyStrategy', 'optimistic', vscode.ConfigurationTarget.Workspace);
    void vscode.window.showInformationMessage('UnodeAi: switched to Optimistic concurrency (shared workspace). It applies to each agent’s next turn.');
  } else if (choice === INIT) {
    await initGitRepoForWorktree();
  }
}

/** Sync the `unode.worktreeMode` context key so the Team title bar shows the right concurrency icon. */
function syncConcurrencyContext(): void {
  const worktree = vscode.workspace.getConfiguration('unode').get<string>('concurrencyStrategy', 'optimistic') === 'worktree';
  void vscode.commands.executeCommand('setContext', 'unode.worktreeMode', worktree);
}

/** Cheap "is the workspace a git repo" check (no WorktreeManager instance needed) for the mode toggle. */
function isWorkspaceGitRepo(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = cpSpawn('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workspaceRoot(), shell: process.platform === 'win32' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

/** One-click `git init` + a safe .gitignore for the workspace, so worktree mode can engage. Deliberately
 *  does NOT auto-commit — the user reviews what to stage (avoids committing secrets/large files). */
async function initGitRepoForWorktree(): Promise<void> {
  const root = workspaceRoot();
  const runGit = (args: string[]) => new Promise<void>((resolve, reject) => {
    const p = cpSpawn('git', args, { cwd: root, shell: process.platform === 'win32' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} exited ${code}`))));
  });
  try {
    const gi = path.join(root, '.gitignore');
    try { await fs.access(gi); } catch { await fs.writeFile(gi, 'node_modules/\n.unode/\n.env\n*.log\n', 'utf8'); }
    await runGit(['init']);
    void vscode.window.showInformationMessage(
      `UnodeAi: initialized a git repo at ${root} and added a .gitignore. Review the changes, then commit ` +
        `(git add -A && git commit -m "init") — worktree isolation engages once the tree has a commit.`
    );
  } catch (e) {
    void vscode.window.showWarningMessage(
      `UnodeAi: couldn't run git init (${e instanceof Error ? e.message : String(e)}). Make sure git is installed, then run 'git init' + commit in a terminal.`
    );
  }
}

function makeWorktreeCoordinator(): WorktreeCoordinator {
  const root = workspaceRoot();
  const cfg = () => vscode.workspace.getConfiguration('unode');
  return new WorktreeCoordinator({
    manager: new WorktreeManager(root),
    orchestrator: new GitMergeOrchestrator(root),
    isEnabled: () => cfg().get<string>('concurrencyStrategy', 'optimistic') === 'worktree',
    autoMerge: () => cfg().get<boolean>('worktree.autoMerge', false),
    maxParallel: () => cfg().get<number>('worktree.maxParallel', 4),
    // The delegating PM and solo agents stay on the live shared tree (the PM must see real state to
    // coordinate; solo has no teammates to isolate from).
    isEligible: (config) => !canDelegate(config) && config.role !== 'solo',
    log: (m) => outputChannel.info(`[worktree] ${m}`),
    onNonGitRepo: () => void warnWorktreeNeedsGit(),
    notifyAgent: (agentId, message) =>
      messageBus.send('user', agentId, 'ask.question', { instruction: message, mode: 'act' }, 'normal'),
    // v0.7.0 verifier-as-gate: run the project's verify command in the worker's worktree before merge.
    // Returns 'skipped' (→ no gating) when worktree mode or the gate is off, or no verifyCommand is set.
    verify: (cwd) => {
      const c = cfg();
      const gateOn = c.get<string>('concurrencyStrategy', 'optimistic') === 'worktree'
        && c.get<boolean>('worktree.verifyBeforeMerge', true);
      if (!gateOn) {
        return Promise.resolve({ status: 'skipped' as const, command: '', output: 'Verify gate disabled.' });
      }
      return new Verifier({
        command: () => c.get<string>('verifyCommand', ''),
        run: verifyCommandRunner,
        commandPolicy,
        onConfigOutsideRoot: notifyVerifyCommandOutsideRoot,
      }).verify(cwd);
    },
    // v0.7.0 anti-cheat: surface a passing lane that also edited the tests (review-board flag).
    changedFiles: (wt) => changedFilesInWorktree(wt.path),
  });
}

/** Spawn the verify command in a worktree and capture exit code + combined output (sanitized env).
 *  Has a HARD timeout: the gate is serialized with merges/finalize, so a watch-mode or input-waiting
 *  verify command must never hang the chain — on timeout we kill it and report failure (exit non-zero),
 *  which blocks the (unverifiable) merge and tells the agent. Timeout via unode.worktree.verifyTimeoutSeconds. */
const verifyCommandRunner = (command: string, cwd: string): Promise<{ code: number | null; output: string }> =>
  new Promise((resolve) => {
    // Workspace Trust gate: the verify command is a shell command, so it must not run in an untrusted workspace.
    if (!vscode.workspace.isTrusted) {
      resolve({ code: null, output: 'Verification skipped: this workspace is not trusted, so the verify command was not run. Trust the workspace (Workspace Trust) to enable it.' });
      return;
    }
    const seconds = Math.max(10, vscode.workspace.getConfiguration('unode').get<number>('worktree.verifyTimeoutSeconds', 300));
    const proc = cpSpawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: sanitizedCommandEnv() });
    let output = '';
    let settled = false;
    const done = (r: { code: number | null; output: string }) => { if (settled) { return; } settled = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => {
      killProcessTree(proc); // Windows: kill the whole tree, not just cmd.exe (audit N2)
      done({ code: null, output: `${output}\n[verify timed out after ${seconds}s — ensure unode.verifyCommand exits (e.g. not a watch mode) and doesn't wait for input]` });
    }, seconds * 1000);
    proc.stdout?.on('data', (d) => (output += d.toString()));
    proc.stderr?.on('data', (d) => (output += d.toString()));
    proc.on('close', (code) => done({ code, output }));
    proc.on('error', (err) => done({ code: 1, output: `Failed to run verify command: ${err.message}` }));
  });

/**
 * After a finalize advances the base ref (via update-ref, which doesn't touch the work tree), bring
 * the user's checkout up to it — but only when the tree is clean, so we never clobber their edits.
 */
/** Run git in a given directory. Best-effort: resolves with code/stdout, never throws. */
function runGitIn(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const p = cpSpawn('git', args, { cwd });
    let stdout = '';
    p.stdout?.on('data', (d) => { stdout += d.toString(); });
    p.on('close', (code) => resolve({ code: code ?? -1, stdout }));
    p.on('error', () => resolve({ code: -1, stdout: '' }));
  });
}

/** Run git in the workspace root. Best-effort: resolves with code/stdout, never throws. */
function runGitInRoot(args: string[]): Promise<{ code: number; stdout: string }> {
  return runGitIn(workspaceRoot(), args);
}

/** v0.7.0 anti-cheat: files a worktree's branch changed vs the base branch (for test-tamper flagging). */
async function changedFilesInWorktree(worktreePath: string): Promise<string[]> {
  const base = (await runGitInRoot(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'HEAD';
  const r = await runGitIn(worktreePath, ['diff', '--name-only', `${base}...HEAD`]);
  return r.code === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
}

/** The base branch as a full commit SHA, for pinning a lane diff to an immutable snapshot. */
async function resolveBaseSha(): Promise<string | undefined> {
  const branch = (await runGitInRoot(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'HEAD';
  const resolved = await runGitInRoot(['rev-parse', `${branch}^{commit}`]);
  const sha = resolved.stdout.trim();
  return resolved.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
}

/** Which file of a lane to diff, when the request was lane-level rather than per-file. One changed
 *  file needs no question; none means there is nothing to show and says so. */
async function pickLaneFile(worktreePath: string, agentName: string): Promise<string | undefined> {
  const files = await changedFilesInWorktree(worktreePath);
  if (files.length === 0) {
    void vscode.window.showInformationMessage(`No changes to show for ${agentName}.`);
    return undefined;
  }
  if (files.length === 1) {
    return files[0];
  }
  return vscode.window.showQuickPick(files, {
    title: `${agentName}'s lane`,
    placeHolder: 'Open a changed file in the diff editor',
  });
}

/** Re-render the open worktree review panel (if any) from a fresh snapshot. Wired to the
 *  coordinator's onChange so lane verify-state changes refresh the board live. Best-effort. */
async function refreshWorktreePanel(): Promise<void> {
  if (!WorktreePanel.current) { return; }
  try {
    WorktreePanel.current.update(await gatherWorktreeReview());
  } catch (err) {
    outputChannel.warn(`[worktree] panel refresh failed: ${String(err)}`);
  }
}

/** Snapshot of the crew's worktree/integration state for the review panel. */
async function gatherWorktreeReview(): Promise<WorktreeReview> {
  const base = (await runGitInRoot(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'HEAD';
  const integrationBranch = 'unode/integration';
  const lanes: WorktreeReview['lanes'] = [];
  for (const wt of worktreeCoordinator?.active() ?? []) {
    const v = wt.agentId ? worktreeCoordinator?.verification(wt.agentId) : undefined;
    const agentId = wt.agentId ?? wt.branch;
    lanes.push({
      agentId,
      agent: wt.agentId ? (sessionManager.get(wt.agentId)?.config.name ?? wt.agentId) : wt.branch,
      branch: wt.branch,
      path: wt.path,
      // v0.7.0 verifier-as-gate: per-lane status for the review board (✓ verified / ✗ failing / ⚠ unverified),
      // plus any test files a passing change also touched (anti-cheat flag).
      verification: v ? { status: v.status, command: v.command, output: v.output, touchedTests: v.touchedTests } : undefined,
      // 0.8.x review board (A2): the files this lane changed vs base, so the panel can show them
      // per-agent and open a diff. Best-effort — a failure to diff just yields an empty list.
      changedFiles: await changedFilesInWorktree(wt.path),
    });
  }
  const hasIntegration =
    (await runGitInRoot(['show-ref', '--verify', '--quiet', `refs/heads/${integrationBranch}`])).code === 0;
  let integrationFiles: string[] = [];
  if (hasIntegration) {
    const diff = await runGitInRoot(['diff', '--name-only', `${base}...${integrationBranch}`]);
    if (diff.code === 0) {
      integrationFiles = diff.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
  }
  return { base, integrationBranch, hasIntegration, lanes, integrationFiles };
}

function dashboardFilesByAgent(): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const cp of checkpointStore.list()) {
    const files = grouped.get(cp.agentId) ?? [];
    if (!files.includes(cp.path)) {
      files.push(cp.path);
    }
    grouped.set(cp.agentId, files);
  }
  return grouped;
}

/** Only the host-selected coordinator gets delegation tools; role labels and capabilities do not confer it. */
function canDelegate(config: AgentConfig): boolean {
  return isCoordinator(config, sessionManager.coordinatorId());
}

/** Exact internal route receipt for one dispatched worker. Portable export classifies it later. */
function runRouteReceipt(agentId: string): RunRouteReceipt | undefined {
  const config = sessionManager.get(agentId)?.config;
  if (!config) {
    return undefined;
  }
  try {
    const route = config.route ?? agentRouteFromLegacyConfig(config, effectiveConnectionRegistry);
    const profile = connectionProfile(route.connectionId, effectiveConnectionRegistry);
    if (!profile) {
      return undefined;
    }
    const endpointBase = route.kind === 'openai-compatible'
      ? resolveOpenAICompatBaseUrl(route, effectiveConnectionRegistry)
      : route.kind === 'claude-headless'
        ? 'https://api.anthropic.com'
        : 'https://api.openai.com';
    const resolved = createResolvedAgentRoute({
      route,
      profile,
      endpointBase,
      // This receipt does not retain or compare auth. Supplying a fixed opaque label avoids reading a
      // SecretStorage key name for an artifact whose only concern here is destination and privacy domain.
      authIdentityRef: 'run-evidence-route',
      toolProtocol: config.toolProtocol,
    });
    return {
      routeId: resolved.connectionId,
      connectionKind: resolved.connectionKind,
      executionDomain: resolved.executionDomain.canonicalEndpointBase,
      privacyDomain: { id: resolved.privacyDomain.id, status: resolved.privacyDomain.status },
    };
  } catch {
    // A broken/retired route is already non-runnable. Do not invent a destination receipt for it.
    return undefined;
  }
}

/**
 * A coordinator brief is potentially user-derived text. Compare real retention/privacy domains rather
 * than model labels: routes sharing a provider name can be separate gateways, while two route labels can
 * intentionally resolve to the same processor domain. Manual unresolved privacy metadata never inherits
 * equality; it falls back to the exact canonical execution endpoint.
 */
function coordinatorBriefDestination(config: AgentConfig): { key: string; host: string } | undefined {
  try {
    const route = config.route ?? agentRouteFromLegacyConfig(config, effectiveConnectionRegistry);
    const profile = connectionProfile(route.connectionId, effectiveConnectionRegistry);
    if (!profile) return undefined;
    const endpointBase = route.kind === 'openai-compatible'
      ? resolveOpenAICompatBaseUrl(route, effectiveConnectionRegistry)
      : route.kind === 'claude-headless'
        ? 'https://api.anthropic.com'
        : 'https://api.openai.com';
    const resolved = createResolvedAgentRoute({
      route,
      profile,
      endpointBase,
      authIdentityRef: 'coordinator-brief-consent',
      toolProtocol: config.toolProtocol,
    });
    const execution = resolved.executionDomain.canonicalEndpointBase;
    return {
      key: coordinatorBriefEgressDestinationKey(resolved),
      host: new URL(execution).host,
    };
  } catch {
    return undefined;
  }
}

/** This is intentionally not cached: every cross-destination dispatch needs an explicit visible choice. */
async function approveCoordinatorBriefEgress(
  coordinator: AgentConfig,
  target: AgentConfig,
): Promise<{ allowed: boolean; reason?: string }> {
  const source = coordinatorBriefDestination(coordinator);
  const destination = coordinatorBriefDestination(target);
  if (!source || !destination) {
    return {
      allowed: false,
      reason: 'The host could not resolve the coordinator and worker destinations for brief consent; no attempt was created.',
    };
  }
  if (source.key === destination.key) return { allowed: true };
  const SEND = 'Send brief';
  const choice = await vscode.window.showWarningMessage(
    `UnodeAi is about to send a coordinator-authored brief, which may contain user-derived information, `
      + `to ${target.name}'s model destination (${destination.host}). This approval applies only to this dispatch.`,
    { modal: true },
    SEND,
    'Cancel',
  );
  return choice === SEND
    ? { allowed: true }
    : { allowed: false, reason: 'The user declined to send the coordinator-authored brief to this destination.' };
}


/** Approval card for a Claude native external-effect or a tool introduced after this extension shipped.
 * `remember` is scoped to the running Claude agent by ClaudeHeadlessBackend, never persisted globally. */
async function requestClaudeToolApproval(
  agentName: string,
  request: ClaudeToolApprovalRequest,
  origin: { agentId?: string; sessionId?: string } = {},
): Promise<ClaudeToolApprovalDecision> {
  const approvalStartedAt = Date.now();
  const inPanel = chatViewProvider?.canPromptApproval() === true;
  const { action, note, approverId, expired } = inPanel
    ? await chatViewProvider!.requestApproval({
        kind: 'tool',
        agentName,
        toolName: request.toolName,
        toolDetail: request.detail,
        ...origin,
      }, request.timeoutMs)
    : { ...await nativeClaudeToolApprovalChoice(agentName, request), approverId: localApproverIdentity(), expired: undefined };
  recordApprovalMetric(origin, approvalStartedAt, approvalMetricDecision(action, expired), 'tool-approval', approverId);
  return {
    allow: action === 'once' || action === 'always',
    remember: action === 'always',
    note: action === 'deny' ? note?.trim() || undefined : undefined,
  };
}

/**
 * One route-neutral public-web approval. The wording and the explicit session action are deliberately
 * crew-wide: WebSearch/WebFetch/fetch_url may all perform egress, including through a URL itself.
 */
async function requestWebAccessApproval(request: WebAccessApprovalRequest): Promise<WebAccessDecision> {
  const destination = request.url ? `Requested URL: ${request.url}` : 'Requested action: public web search.';
  const detail = [
    destination,
    'Public web access is egress. A fetched URL can itself carry data.',
    'Allowing this session grants web access to all current and later crew agents for this VS Code session only.',
  ].join('\n\n');
  const approvalStartedAt = Date.now();
  const inPanel = chatViewProvider?.canPromptApproval() === true;
  const { action, note, approverId, expired } = inPanel
    ? await chatViewProvider!.requestApproval({
        kind: 'tool',
        agentName: request.agentName,
        toolName: 'Web access',
        toolDetail: detail,
        crewSessionWebAccess: true,
        agentId: request.agentId,
        sessionId: request.sessionId,
      }, WEB_ACCESS_HUMAN_WINDOW_MS)
    : { ...await nativeWebAccessApprovalChoice(request.agentName, detail), approverId: localApproverIdentity(), expired: undefined };
  recordApprovalMetric(
    { agentId: request.agentId, sessionId: request.sessionId },
    approvalStartedAt,
    approvalMetricDecision(action, expired),
    'web-access-approval',
    approverId,
  );
  return {
    allow: action === 'once' || action === 'always',
    remember: action === 'always',
    reason: action === 'deny' ? note?.trim() || 'The user did not approve public web access.' : undefined,
  };
}

async function nativeWebAccessApprovalChoice(agentName: string, detail: string): Promise<{ action: string; note?: string }> {
  const ONCE = 'Allow this request';
  const ALWAYS = 'Allow crew web access this session';
  const choice = await vscode.window.showWarningMessage(
    `${agentName} wants to access the public web.\n\n${detail}`,
    { modal: true },
    ONCE,
    ALWAYS,
  );
  if (choice === ONCE) { return { action: 'once' }; }
  if (choice === ALWAYS) { return { action: 'always' }; }
  return { action: 'deny' };
}

async function nativeClaudeToolApprovalChoice(
  agentName: string,
  request: ClaudeToolApprovalRequest
): Promise<{ action: string; note?: string }> {
  const ONCE = 'Allow once';
  const ALWAYS = 'Always allow this tool';
  const DENY_NOTE = 'Deny with note…';
  const choice = await vscode.window.showWarningMessage(
    `${agentName} wants to use Claude ${request.toolName}:\n\n${request.detail}`,
    { modal: true },
    ONCE,
    ALWAYS,
    DENY_NOTE
  );
  if (choice === ONCE) { return { action: 'once' }; }
  if (choice === ALWAYS) { return { action: 'always' }; }
  if (choice === DENY_NOTE) {
    const note = await vscode.window.showInputBox({
      title: `Deny Claude ${request.toolName}`,
      prompt: 'Tell the agent why, or what to do instead. Leave empty to just deny.',
      ignoreFocusOut: true,
    });
    return { action: 'deny', note: note?.trim() || undefined };
  }
  return { action: 'deny' };
}

function createSharedLocalMcpServerFactory(): () => LocalMcpServer {
  let shared = createLocalMcpServer();
  let refs = 0;
  return () => ({
    get port() {
      return shared.port;
    },
    get token() {
      return shared.token;
    },
    addLocalTool(tool) {
      shared.addLocalTool(tool);
    },
    addJsonEndpoint(endpoint) {
      shared.addJsonEndpoint(endpoint);
    },
    async start(bridge) {
      if (refs === 0) {
        await shared.start(bridge);
      }
      refs++;
    },
    async stop() {
      if (refs > 0) {
        refs--;
      }
      if (refs === 0) {
        await shared.stop();
        shared = createLocalMcpServer();
      }
    },
  });
}

/** The workspace root (the ${WORKDIR} placeholder for MCP server args). */
/**
 * Add host-observed filesystem facts to a manifest source when its declared location is a workspace
 * path. This is deliberately best-effort and read-only: an unknown path stays unknown rather than being
 * guessed from its prose, and no fact changes prompt assembly.
 */
function enrichContextManifestSource(source: ContextManifestSource | undefined): ContextManifestSource | undefined {
  if (!source) {
    return undefined;
  }
  const relativePath = workspaceRelativeManifestPath(source.location);
  if (!relativePath) {
    return source;
  }
  const root = workspaceRoot();
  const absolutePath = path.resolve(root, relativePath);
  const fromRoot = path.relative(root, absolutePath);
  if (fromRoot === '' || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
    return source;
  }
  try {
    const stat = statSync(absolutePath);
    // A directory's mtime only says entries changed, not when the indexed source text changed. Keep it
    // unavailable rather than manufacturing a misleading freshness fact for a generated directory index.
    if (!stat.isFile()) {
      return source;
    }
    const text = (() => { try { return readFileSync(absolutePath, 'utf8'); } catch { return source.text; } })();
    const signals = new Set(secretPatternSignals(text));
    const normal = relativePath.replace(/\\/g, '/').toLowerCase();
    if (/(^|\/)(?:\.env(?:\.|$)|secrets?|credentials?|id_rsa|\.npmrc$)|\.(?:pem|key|p12|pfx)$/i.test(normal)) {
      signals.add('sensitive path convention');
    }
    return {
      ...source,
      modifiedAt: stat.mtime.toISOString(),
      fileMode: stat.mode & 0o777,
      gitIgnored: workspaceGitignoreMatches(root, normal),
      sensitivitySignals: [...signals],
    };
  } catch {
    return source;
  }
}

/** Accept only simple, workspace-relative locations; labels such as "chat composer" are not paths. */
function workspaceRelativeManifestPath(location: string): string | undefined {
  const candidate = location.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!candidate || /[\r\n]/.test(candidate) || candidate.includes('://') || /\s/.test(candidate)) {
    return undefined;
  }
  return candidate;
}

/** A conservative, dependency-free subset of .gitignore matching used only as a sensitivity signal. */
function workspaceGitignoreMatches(root: string, relativePath: string): boolean {
  try {
    const lines = readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/);
    return lines.some((raw) => {
      const rule = raw.trim().replace(/\\/g, '/');
      if (!rule || rule.startsWith('#') || rule.startsWith('!')) {
        return false;
      }
      const normalized = rule.replace(/^\//, '');
      if (normalized.endsWith('/')) {
        return relativePath.startsWith(normalized);
      }
      if (!/[?*]/.test(normalized)) {
        return relativePath === normalized || relativePath.startsWith(`${normalized}/`);
      }
      const expression = '^' + normalized
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]') + '$';
      return new RegExp(expression).test(relativePath);
    });
  } catch {
    return false;
  }
}

function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

function normalizeEpoch(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/** The code action handles live and UnodeAi virtual diff documents, never arbitrary editor schemes. */
function selectionDocumentPath(uri: vscode.Uri): string | undefined {
  if (uri.scheme === 'file') {
    return uri.fsPath;
  }
  if (uri.scheme === CHECKPOINT_SCHEME) {
    const ref = parseCheckpointRef(uri.query);
    const checkpoint = ref ? checkpointStore.get(ref.id) : undefined;
    if (!checkpoint || checkpoint.path !== uri.path.replace(/^\/+/, '')) {
      return undefined;
    }
    const resolution = resolveInsideRoot(workspaceRoot(), checkpoint.path);
    return resolution.status === 'resolved' ? resolution.path : undefined;
  }
  if (uri.scheme === LANE_BASE_SCHEME) {
    const ref = parseLaneBaseRef(uri.query, uri.path);
    if (!ref) { return undefined; }
    const resolution = resolveInsideRoot(workspaceRoot(), ref.file);
    return resolution.status === 'resolved' ? resolution.path : undefined;
  }
  return undefined;
}

function isSelectionUri(value: unknown): value is vscode.Uri {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<vscode.Uri>;
  return typeof candidate.scheme === 'string' && typeof candidate.path === 'string' && typeof candidate.fsPath === 'string';
}

/**
 * A selection is user-provided context, but its source file still has to be inside the selected agent's
 * existing read roots. This keeps an editor lightbulb from becoming a side door around Folder Access.
 */
function selectedAgentCanAttachSelection(uri: vscode.Uri): boolean {
  const agentId = chatViewProvider.getSelectedAgentId();
  const session = agentId ? sessionManager.get(agentId) : undefined;
  const documentPath = selectionDocumentPath(uri);
  if (!session || !documentPath) {
    return false;
  }
  let physicalDocumentPath: string;
  try {
    physicalDocumentPath = realpathSync(documentPath);
  } catch {
    return false;
  }
  const config = session.config;
  const primaryRoot = config.workingDirectory || workspaceRoot();
  const roots = resolveEffectiveRoots({
    grants: config.folderAccess,
    fallbackPrimaryRoot: primaryRoot,
    fallbackReadRoots: orchestrationHost.readRootsForAgent(primaryRoot),
    workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    isTrusted: vscode.workspace.isTrusted,
  }).readRoots;
  return roots.some((root) => isPathInside(realpathOrResolved(root), physicalDocumentPath));
}

function realpathOrResolved(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function configuredAdditionalRoots(): string[] {
  if (!vscode.workspace.isTrusted) { return []; }
  const inspected = vscode.workspace.getConfiguration('unode').inspect<string[]>('additionalRoots');
  const roots = [
    ...(inspected?.globalValue ?? []),
    ...(inspected?.workspaceValue ?? []),
    ...(inspected?.workspaceFolderValue ?? []),
  ];
  return roots.filter((root): root is string => typeof root === 'string' && root.trim().length > 0);
}

// ─── V1 Checkpoints: record file writes + one-click restore ──────────────────

const WORKBENCH_INSPECTOR_KEY = 'unode.workbenchInspectorOpen';

/** Sink injected into each agent's WorkspaceTools — records a restore point per successful write. */
function recordCheckpoint(entry: {
  agentId: string;
  path: string;
  before: string | null;
  after: string;
  operation?: CheckpointOperation;
  restoreDisabledReason?: CheckpointRestoreDisabledReason;
}): void {
  checkpointStore.record({ ...entry, agentName: resolveAgentName(entry.agentId) });
  runLedger.recordFileChange({
    agentId: entry.agentId,
    path: entry.path,
    before: entry.before,
    after: entry.after,
    ...(entry.operation ? { operation: entry.operation } : {}),
    contentObserved: !entry.restoreDisabledReason,
    correlationId: sessionManager.currentTurnCorrelationId(entry.agentId),
  });
  // The rail is a live view of what the crew is doing to the repo, so an edit that just landed shows
  // up without waiting for the next state post. No-op while the rail is closed.
  chatViewProvider?.refreshChangedFiles();
  if (checkpointSaveTimer) { clearTimeout(checkpointSaveTimer); }
  checkpointSaveTimer = setTimeout(() => persistence.saveCheckpoints(checkpointStore.serialize()), 1500);
}

function timeAgo(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) { return `${secs}s ago`; }
  const mins = Math.round(secs / 60);
  if (mins < 60) { return `${mins}m ago`; }
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : new Date(ts).toLocaleString();
}

/** Materialises the sides of a diff that have no file on disk. Checkpoint contents are immutable
 *  per id, so there is no change event to fire; a lane's base can move under a long-open tab, which
 *  is why the base side is labelled rather than presented as live. Anything unparseable or missing
 *  resolves to empty rather than to some other file's content. */
const virtualDiffContentProvider: vscode.TextDocumentContentProvider = {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.scheme === CHECKPOINT_SCHEME) {
      const ref = parseCheckpointRef(uri.query);
      const cp = ref ? checkpointStore.get(ref.id) : undefined;
      if (!ref || !cp || cp.truncated) {
        return '';
      }
      if (ref.side === 'before' && cp.restoreDisabledReason) {
        return `Before-state unavailable: ${checkpointRestoreDisabledMessage(cp) || 'the original file contents could not be proved.'}\n\nThis change is shown for review, but restore is disabled to avoid overwriting user work with a guess.`;
      }
      return ref.side === 'before' ? cp.before ?? '' : cp.after;
    }
    const lane = parseLaneBaseRef(uri.query, uri.path);
    if (!lane) {
      return '';
    }
    // Read from the MAIN repo, not the lane's worktree: worktrees share one object database, so the
    // pinned commit is readable from either — and reading here keeps an open diff tab valid after the
    // lane itself is cleaned up. A file the lane ADDED does not exist on the base and git exits
    // non-zero for it; empty is the correct left-hand side there, since the diff is then all
    // additions, which is what happened.
    const shown = await runGitInRoot(['show', `${lane.baseSha}:${lane.file}`]);
    return shown.code === 0 ? shown.stdout : '';
  },
};

/** Open a recorded checkpoint in the NATIVE diff editor (from a changed-files link).
 *
 *  The right-hand side is the real file whenever it still exists, so the diff is navigable with F7,
 *  foldable, theme-correct, and directly editable — you can fix an agent's edit in the diff you are
 *  reviewing. It falls back to the recorded "after" content only when the file is gone, so the tab
 *  still explains what happened instead of failing to open. */
async function showCheckpointDiffCommand(checkpointId: unknown): Promise<void> {
  const id = typeof checkpointId === 'number' ? checkpointId : Number(checkpointId);
  if (!Number.isFinite(id)) {
    vscode.window.showInformationMessage('Could not open checkpoint diff: missing checkpoint id.');
    return;
  }
  const cp = checkpointStore.get(id);
  if (!cp) {
    vscode.window.showInformationMessage(`Could not find checkpoint #${id}.`);
    return;
  }
  if (cp.truncated) {
    vscode.window.showInformationMessage(`Checkpoint diff for ${cp.path} is unavailable because the file content was truncated.`);
    return;
  }
  const before = checkpointRef(cp, 'before');
  const left = vscode.Uri.from({ scheme: CHECKPOINT_SCHEME, path: `/${before.path}`, query: before.query });
  // Same containment rule as restore: a recorded path that escapes the workspace does not get to
  // name the file this opens. It falls back to the recorded content, which is inert.
  const resolution = await resolveInsideWorkspace(cp.path);
  const abs = resolution.status === 'resolved' ? resolution.path : undefined;
  const liveFile = abs !== undefined && await fileExists(abs);
  if (resolution.status === 'refused') {
    vscode.window.showInformationMessage('The live checkpoint target was withheld because it is outside the current workspace scope; showing the recorded content instead.');
  }
  const after = checkpointRef(cp, 'after');
  const right = liveFile
    ? vscode.Uri.file(abs)
    : vscode.Uri.from({ scheme: CHECKPOINT_SCHEME, path: `/${after.path}`, query: after.query });
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    checkpointDiffTitle(cp.path, cp.agentName, liveFile),
    { preview: false, viewColumn: vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One },
  );
}

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    return (await fs.stat(absolutePath)).isFile();
  } catch {
    return false;
  }
}

/** Pick a restore point and revert that file to its pre-edit content (or delete it if it was new). */
async function restoreCheckpointCommand(): Promise<void> {
  const items = checkpointStore.restorable();
  if (items.length === 0) {
    vscode.window.showInformationMessage('No restore points yet — UnodeAi creates one each time an agent edits a file.');
    return;
  }
  const picks = items.map((c) => ({
    label: `$(history) ${c.path}`,
    description: `${c.agentName} · ${timeAgo(c.ts)}`,
    detail: c.before === null
      ? 'Restoring deletes this file (it did not exist before this edit).'
      : `Restore to the version before this edit (${c.before.length} bytes).`,
    cp: c,
  }));
  const chosen = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Restore a file to a previous version',
    matchOnDescription: true,
  });
  if (!chosen) { return; }
  await restoreCheckpoint(chosen.cp);
}

/** Restore one checkpoint by id — the Workbench rail's per-file action. The id is resolved against
 *  the host's own store, so a webview never names the path that gets overwritten. */
async function restoreCheckpointByIdCommand(checkpointId: unknown): Promise<void> {
  const id = typeof checkpointId === 'number' ? checkpointId : Number(checkpointId);
  const cp = Number.isFinite(id) ? checkpointStore.get(id) : undefined;
  if (!cp) {
    vscode.window.showInformationMessage('That restore point is no longer available.');
    return;
  }
  const restoreDisabledMessage = checkpointRestoreDisabledMessage(cp);
  if (restoreDisabledMessage) {
    vscode.window.showInformationMessage(`${cp.path} cannot be restored: ${restoreDisabledMessage}`);
    return;
  }
  // The rail row means "this file", not "this keystroke". See restoreTargetForRow.
  const { target, edits } = restoreTargetForRow(checkpointStore.list(), cp);
  await restoreCheckpoint(target, edits);
}

/** Physical path for a recorded workspace-relative path, or undefined when it escapes the workspace
 *  — including through a symlink or a Windows junction, which no string comparison can see. */
async function resolveInsideWorkspace(relativePath: string) {
  return resolveInsideRootPhysical(workspaceRoot(), relativePath);
}

/** The confirmation and the write. Every restore path goes through here, so the modal warning that
 *  a file is about to be overwritten (or deleted) cannot be skipped by adding a new entry point. */
async function restoreCheckpoint(c: Checkpoint, edits = 1): Promise<void> {
  // Say how much is being undone. "before their edit" is a false singular when four edits are rolled back,
  // and the user cannot see the count anywhere else.
  const scope = edits > 1 ? `${edits} edits by ${c.agentName}` : `${c.agentName}'s edit`;
  const confirm = await vscode.window.showWarningMessage(
    c.before === null
      ? `Delete ${c.path}? It didn't exist before ${scope}.`
      : `Restore ${c.path} to the version before ${scope}? The current contents will be overwritten.`,
    { modal: true },
    'Restore'
  );
  if (confirm !== 'Restore') { return; }
  const resolution = await resolveInsideWorkspace(c.path);
  if (resolution.status !== 'resolved') {
    // A checkpoint path is recorded by a write the tool layer already confined to the workspace, so
    // this should be unreachable from an agent. It is checked anyway because the store is ALSO loaded
    // from a persisted file: without this, a hand-edited or tampered checkpoint record turns "restore
    // this file" into an arbitrary file write. The check is PHYSICAL, not lexical: `linked/x.txt` is
    // inside the workspace by name while `linked` points anywhere on the machine, and a write follows
    // it. Re-verify at the site that performs the write.
    const reason = resolution.status === 'refused'
      ? 'it is outside the current workspace scope'
      : 'the target could not be resolved';
    vscode.window.showErrorMessage(`Could not restore ${c.path}: ${reason}.`);
    outputChannel.warn(`[checkpoints] restore withheld (${resolution.status === 'refused' ? 'scope' : resolution.reason}).`);
    return;
  }
  const abs = resolution.path;
  try {
    if (c.before === null) {
      await fs.rm(abs, { force: true });
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, c.before, 'utf8');
    }
    vscode.window.showInformationMessage(`Restored ${c.path}.`);
  } catch (err) {
    vscode.window.showErrorMessage(`Could not restore ${c.path}: ${String(err)}`);
  }
}

function diagnosticsSnapshot(root: string): { items: DiagnosticItem[] } {
  const resolvedRoot = path.resolve(root);
  const items: DiagnosticItem[] = [];
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file') {
      continue;
    }
    const abs = path.resolve(uri.fsPath);
    const rel = path.relative(resolvedRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      continue;
    }
    for (const d of diagnostics) {
      const severity = diagnosticSeverity(d.severity);
      if (severity !== 'error' && severity !== 'warning') {
        continue;
      }
      items.push({
        file: rel.split(path.sep).join('/'),
        line: d.range.start.line + 1,
        col: d.range.start.character + 1,
        severity,
        message: d.message,
        code: diagnosticCode(d.code),
      });
    }
  }
  return { items };
}

function capWorkspaceContextFile(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines.length > WORKSPACE_CONTEXT_ACTIVE_FILE_LINE_CAP) {
    return lines.slice(0, WORKSPACE_CONTEXT_ACTIVE_FILE_LINE_CAP).join('\n') + '\n(truncated - use read_file for the rest)';
  }
  if (text.length > WORKSPACE_CONTEXT_ACTIVE_FILE_CHAR_CAP) {
    return text.slice(0, WORKSPACE_CONTEXT_ACTIVE_FILE_CHAR_CAP) + '\n(truncated - use read_file for the rest)';
  }
  return text;
}

/**
 * v0.5.2 Execution Engine: collect the editor's diagnostics for files an agent just wrote. Lets the
 * language servers settle briefly first (an edit retriggers TS/ESLint asynchronously), then reads only
 * Error/Warning for the given paths. Paths are echoed back verbatim so the agent sees the name it used.
 */
async function collectFileDiagnostics(paths: string[], cwd: string): Promise<FileDiagnostic[]> {
  await new Promise((r) => setTimeout(r, 800)); // let TS/ESLint recompute after the write
  const out: FileDiagnostic[] = [];
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.file(abs);
    } catch {
      continue;
    }
    for (const d of vscode.languages.getDiagnostics(uri)) {
      const severity = diagnosticSeverity(d.severity);
      if (severity !== 'error' && severity !== 'warning') {
        continue;
      }
      out.push({
        path: p,
        line: d.range.start.line + 1,
        severity,
        message: typeof d.message === 'string' ? d.message : String(d.message),
        source: d.source,
      });
    }
  }
  return out;
}

function diagnosticSeverity(severity: vscode.DiagnosticSeverity): DiagnosticItem['severity'] {
  if (severity === vscode.DiagnosticSeverity.Error) {
    return 'error';
  }
  if (severity === vscode.DiagnosticSeverity.Warning) {
    return 'warning';
  }
  if (severity === vscode.DiagnosticSeverity.Information) {
    return 'info';
  }
  return 'hint';
}

function diagnosticCode(code: vscode.Diagnostic['code']): string | undefined {
  if (typeof code === 'string' || typeof code === 'number') {
    return String(code);
  }
  if (code && typeof code === 'object' && 'value' in code) {
    return String(code.value);
  }
  return undefined;
}

async function fetchMentionUrl(url: string): Promise<{ ok: boolean; text: string }> {
  // @url only runs for an explicit user-typed mention. webFetch handles timeout, size cap, redirects,
  // and practical SSRF checks; failures are treated as "not attached" by the pure expander.
  const text = await webFetch(url);
  return { ok: !text.startsWith('Error:'), text };
}

/** B2: when a command is blocked by unode.commandApproval, warn the user (not just the LLM) — with a
 *  shortcut to the setting. Debounced so a PM looping run_checks can't spam toasts. */
let lastCommandBlockedToast = 0;
function notifyCommandBlocked(reason: string): void {
  outputChannel.warn(`Command blocked by unode.commandApproval: ${reason}`);
  const now = Date.now();
  if (now - lastCommandBlockedToast < 30_000) {
    return;
  }
  lastCommandBlockedToast = now;
  void vscode.window
    .showWarningMessage(`Command blocked by unode.commandApproval: ${reason}`, 'Open Settings')
    .then((choice) => {
      if (choice === 'Open Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'unode.commandApproval');
      }
    });
}

function notifyVerifyCommandOutsideRoot(message: string): void {
  outputChannel.warn(`[verify] ${message}`);
  void vscode.window.showWarningMessage(message);
}

/**
 * Objective gate check for gated workflows (P2): run the user-configured unode.verifyCommand over the
 * whole project. Empty command = no objective gate (passes). The command is user-set (not LLM-chosen),
 * so it bypasses CommandPolicy by design — same trust model as TeamTools.run_checks.
 */
async function runVerifyChecks(): Promise<{ ok: boolean; output?: string; blocked?: boolean }> {
  const cmd = vscode.workspace.getConfiguration('unode').get<string>('verifyCommand', '').trim();
  if (!cmd) {
    return { ok: true };
  }
  const gate = await gateShellCommand({
    command: cmd,
    roots: workspaceRoot(),
    source: 'config',
    commandPolicy,
    onConfigOutsideRoot: notifyVerifyCommandOutsideRoot,
  });
  if (!gate.ok) {
    // blocked = config problem (execution disabled / not allowlisted), not a quality failure.
    notifyCommandBlocked(gate.reason ?? 'command execution is disabled');
    return { ok: false, blocked: true, output: `Verification command blocked by unode.commandApproval: ${gate.reason ?? gate.message}` };
  }
  // Reuse the worktree verify runner: cp.spawn + a hard timeout that SIGKILLs the child. The old
  // cp.exec({timeout}) did NOT reliably kill the child on Windows and lost output on timeout, so a
  // watch-mode/stdin-waiting test could stall the whole gate for the full window. (Audit #3.)
  const { code, output } = await verifyCommandRunner(cmd, workspaceRoot());
  return { ok: code === 0, output: (output ?? '').slice(-4000) };
}

/** Resolve a set of grants to the server configs in the team registry (skipping unknown ids).
 *  ${WORKDIR} in args/url is substituted here so claude's --mcp-config gets a concrete path. */
function grantedServerConfigs(grants: McpServerGrant[], opts: { approvedOnly?: boolean } = {}): MCPServerConfig[] {
  const out: MCPServerConfig[] = [];
  for (const g of grants) {
    const cfg = mcpRegistry.get(g.serverId);
    if (cfg) {
      if (opts.approvedOnly && needsApproval(cfg, approvedMcp, workspaceRoot())) {
        outputChannel.warn(`Agent references MCP server "${g.serverId}" but it is not approved for this workspace/spec.`);
        continue;
      }
      out.push(resolveServerPlaceholders(cfg, { WORKDIR: workspaceRoot() }));
    } else {
      outputChannel.warn(`Agent references MCP server "${g.serverId}" which is not in .unode/team.json mcpServers.`);
    }
  }
  return out;
}

/** Names referenced as ${VAR} in a server's env (so claude can be handed those secrets at spawn). */
function secretVarsInServer(cfg: MCPServerConfig): string[] {
  const names: string[] = [];
  for (const raw of Object.values(cfg.env ?? {})) {
    for (const m of raw.matchAll(/\$\{(\w+)\}/g)) {
      names.push(m[1]);
    }
  }
  return names;
}

/**
 * Register (in the background) every MCP server referenced by an in-process (openai-compat) agent.
 * claude agents host their own servers, so we skip them here. A slow/failed server doesn't block
 * activation; getToolSpecs simply omits servers that aren't ready yet.
 */
function registerReferencedMcpServers(): void {
  const wanted = new Set<string>();
  for (const info of sessionManager.getAll()) {
    const kind = info.config.backend ?? defaultBackendKind(info.config, effectiveConnectionRegistry);
    if (kind !== 'openai-compat') {
      continue; // claude hosts its own MCP servers
    }
    for (const g of agentMcpGrants(info.config, skillResolver)) {
      wanted.add(g.serverId);
    }
  }
  for (const id of wanted) {
    const cfg = mcpRegistry.get(id);
    if (!cfg || mcpHub.isRegistered(id)) {
      continue;
    }
    void mountMcpServer(cfg);
  }
}

/**
 * Mount one MCP server, gating sensitive ones (requiresApproval) behind a one-time user
 * confirmation that is then persisted (P1#4 / MCP design §7.2). Best-effort: a declined or failed
 * mount is logged and skipped — getToolSpecs simply omits servers that aren't ready.
 */
/** Best-effort PATH check for a stdio server's bare command (uvx/npx/docker), so a missing tool gives a
 *  clear "X isn't installed" instead of an opaque "Connection closed". */
function mcpCommandOnPath(command: string): boolean {
  if (!command) { return true; }
  if (command.includes('/') || command.includes('\\')) { return existsSync(command); }
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) { continue; }
    for (const ext of exts) {
      if (existsSync(path.join(dir, command + ext))) { return true; }
    }
  }
  return false;
}

/** Actionable hint for a missing MCP command. */
function mcpCommandHint(command: string): string {
  const c = command.toLowerCase();
  if (c === 'uvx' || c === 'uv') { return `needs uv (the Python tool that provides uvx) — install it: https://docs.astral.sh/uv/`; }
  if (c === 'npx' || c === 'node') { return `needs Node.js — install it: https://nodejs.org/`; }
  if (c === 'docker') { return `needs Docker installed and running.`; }
  return `needs "${command}" installed and on your PATH.`;
}

/** Extra detail for the most recent mount failure (e.g. a missing command), surfaced in the user toast. */
let lastMcpMountDetail = '';

async function mountMcpServer(cfg: MCPServerConfig): Promise<'mounted' | 'skipped' | 'error'> {
  lastMcpMountDetail = '';
  // Workspace Trust gate: MCP servers can spawn local processes (stdio: npx/uvx/docker) or reach the
  // network (remote), so never mount them in an untrusted workspace. They are (re)mounted when the user
  // grants trust (see the onDidGrantWorkspaceTrust handler in activate).
  if (!vscode.workspace.isTrusted) {
    lastMcpMountDetail = `"${cfg.name}" is disabled until you trust this workspace (Workspace Trust).`;
    outputChannel.warn(`MCP server "${cfg.id}" not mounted: workspace is not trusted.`);
    return 'skipped';
  }
  // Pre-flight: a stdio server whose command isn't installed would just close the connection — catch it
  // here with a clear, actionable message instead of the opaque MCP "Connection closed" error.
  if (cfg.transport === 'stdio' && cfg.command && !mcpCommandOnPath(cfg.command)) {
    lastMcpMountDetail = `"${cfg.name}" ${mcpCommandHint(cfg.command)}`;
    outputChannel.error(`MCP server "${cfg.id}" can't mount: command "${cfg.command}" not found on PATH — ${mcpCommandHint(cfg.command)}`);
    return 'error';
  }
  if (needsApproval(cfg, approvedMcp, workspaceRoot())) {
    const choice = await vscode.window.showWarningMessage(
      `MCP server "${cfg.name}" can access resources beyond the file sandbox (${cfg.transport}). Mount it for this team?`,
      { modal: true },
      'Approve & Mount',
      'Skip'
    );
    if (choice !== 'Approve & Mount') {
      outputChannel.warn(`MCP server "${cfg.id}" skipped (not approved).`);
      return 'skipped';
    }
    approvedMcp.add(approvalKey(cfg, workspaceRoot()));
    await persistence.saveApprovedMcpServers([...approvedMcp]);
  }
  try {
    // Substitute ${WORKDIR} in args/url before spawning (secrets in env are resolved inside the Hub).
    await mcpHub.register(resolveServerPlaceholders(cfg, { WORKDIR: workspaceRoot() }));
    outputChannel.info(`MCP server "${cfg.id}" mounted.`);
    settingsPanelRefresh();
    return 'mounted';
  } catch (err) {
    outputChannel.error(`MCP server "${cfg.id}" failed to mount: ${String(err)}`);
    return 'error';
  }
}

/** A user-facing message for an MCP mount outcome (the server is already saved to the team file either way). */
function mcpMountMessage(name: string, outcome: 'mounted' | 'skipped' | 'error'): { ok: boolean; message: string } {
  if (outcome === 'mounted') {
    return { ok: true, message: `Added MCP server "${name}". Grant it to an agent (Settings or Agent Builder) to use it.` };
  }
  if (outcome === 'skipped') {
    return { ok: false, message: `"${name}" was saved but NOT mounted (approval skipped). Mount it later from Settings → MCP Servers.` };
  }
  // If we know WHY it failed (e.g. a missing command), say so in the toast instead of only the output channel.
  const why = lastMcpMountDetail ? ` ${lastMcpMountDetail}.` : ' See the UnodeAi output channel for details.';
  return { ok: false, message: `"${name}" was saved but FAILED to mount —${why}` };
}

/** Nudge the Settings panel (if open) to re-render after MCP/connection changes. */
function settingsPanelRefresh(): void {
  panelRefreshCoalescer.request();
}

/**
 * Read the machine-local registry without letting corrupt data or a held lock abort activation.
 * A failed read deliberately discards every custom profile, preserving only the built-in resolver
 * so an old in-memory custom endpoint can never remain runnable.
 */
async function loadCustomGatewayRegistryOrFallback() {
  const result = await loadCustomGatewayRegistryFailClosed(customGatewayProfileStore);
  effectiveConnectionRegistry = result.resolver;
  if (result.error === undefined) {
    customGatewayRegistryLoadFailureReported = false;
    return result.snapshot;
  }
  if (!customGatewayRegistryLoadFailureReported) {
    customGatewayRegistryLoadFailureReported = true;
    const location = customGatewayRegistryPath || CUSTOM_GATEWAY_REGISTRY_FILE_NAME;
    // Deliberately does NOT assert the file is corrupt: this path also catches lock, lease, and
    // SecretStorage failures, and telling a user to "repair" a valid file sends them to fix the wrong thing.
    // The underlying cause is logged immediately below and named in the Output channel.
    const message = `Custom gateway registry at "${location}" could not be loaded, so custom gateways are unavailable this session. Built-in connections still work. See View → Output → UnodeAi for the reason, then use Retry.`;
    outputChannel.error(`${message} ${String(result.error)}`);
    void vscode.window.showErrorMessage(message, 'Retry').then((choice) => {
      if (choice === 'Retry') {
        void reloadEffectiveConnectionRegistry();
      }
    });
  }
  return undefined;
}

/** Re-read the machine-local registry after recovery, mutation, or a cross-window file event. */
async function reloadEffectiveConnectionRegistry(): Promise<boolean> {
  const snapshot = await loadCustomGatewayRegistryOrFallback();
  settingsPanelRefresh();
  return snapshot !== undefined;
}

/** The file watcher accelerates UI refresh; watcher failures deny custom egress until revalidated. */
function watchCustomGatewayRegistry(context: vscode.ExtensionContext): void {
  const registryPath = customGatewayRegistryPath;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleReload = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      void reloadEffectiveConnectionRegistry().then((loaded) => {
        if (loaded) {
          supervisor.markCurrent();
        }
      });
    }, 50);
  };
  const supervisor = new CustomGatewayRegistryWatchSupervisor({
    directory: context.globalStorageUri.fsPath,
    registryFileName: CUSTOM_GATEWAY_REGISTRY_FILE_NAME,
    watchDirectory: (directory, onChange) => watchFile(directory, { persistent: false }, (eventType, fileName) => {
      onChange(eventType, fileName ?? undefined);
    }),
    onRegistryChange: scheduleReload,
    onWatcherError: (error) => {
      outputChannel.warn(`Custom gateway registry watcher failed; custom gateway egress is denied until monitoring recovers: ${String(error)}`);
    },
    onWatcherRecovered: () => {
      void reloadEffectiveConnectionRegistry().then((loaded) => {
        if (loaded) {
          supervisor.markCurrent();
        }
      });
    },
  });
  customGatewayRegistryWatchSupervisor = supervisor;
  supervisor.start();
  context.subscriptions.push(new vscode.Disposable(() => {
    if (timer) {
      clearTimeout(timer);
    }
    supervisor.dispose();
    if (customGatewayRegistryWatchSupervisor === supervisor) {
      customGatewayRegistryWatchSupervisor = undefined;
    }
  }));
  // The registry could be replaced between the initial load and watcher installation.
  if (existsSync(registryPath)) {
    scheduleReload();
  }
}

/** A ConfigStore adapter over the roam.* configuration section (for SettingsBridge). */
function makeConfigStore(): ConfigStore {
  return {
    get: <T>(key: string, fallback: T) => vscode.workspace.getConfiguration('unode').get<T>(key, fallback),
    update: (key: string, value: unknown) =>
      Promise.resolve(
        vscode.workspace.getConfiguration('unode').update(key, value, vscode.ConfigurationTarget.Workspace)
      ),
  };
}

/**
 * The provider new agents are created with (`unode.defaultProvider`), written by the setup wizard and the
 * Settings → Providers "set as default" action. An unknown/unsupported value normally falls back to
 * 'unode', except the retired singleton Custom setting: that remains an explicit repair so a new
 * agent is never silently sent to another gateway.
 * This MUST be the single read site — the setting was previously written-only, so choosing Claude Headless
 * in setup silently still produced Unode agents.
 */
function resolveDefaultProvider(): string {
  const configured = makeConfigStore().get<string>('defaultProvider', 'unode');
  const resolved = resolveAvailableDefaultProviderId(configured, effectiveConnectionRegistry);
  if (!resolved.repairMessage) {
    return resolved.providerId;
  }
  // These historic schema values never had a runtime implementation. Make the repair visible once;
  // silently preserving an unsupported default only postpones the failure until Add Agent.
  if (!warnedUnsupportedDefaultProviderIds.has(configured)) {
    warnedUnsupportedDefaultProviderIds.add(configured);
    void vscode.window.showWarningMessage(
      `UnodeAi: ${resolved.repairMessage} ${resolved.providerId === LEGACY_CUSTOM_PROVIDER_ID
        ? 'Choose a named gateway in Settings before creating new agents.'
        : 'New agents will use Unode until you choose another available connection.'}`,
    );
  }
  return resolved.providerId;
}

function assertDefaultProviderCanCreateAgents(): void {
  const configured = makeConfigStore().get<string>('defaultProvider', 'unode');
  const resolved = resolveAvailableDefaultProviderId(configured, effectiveConnectionRegistry);
  if (resolved.providerId === LEGACY_CUSTOM_PROVIDER_ID && resolved.repairMessage) {
    throw new Error('Legacy Custom is still the default provider. Complete migration, then choose a named gateway in Settings > Providers before creating new agents.');
  }
}

/** Codex is deliberately not resolved from PATH: an IDE-bundled alpha and a logged-in npm CLI can coexist. */
function configuredCodexCliPath(): string {
  const configuredPath = vscode.workspace.getConfiguration('unode').get<string>('codexCliPath', '').trim();
  return configuredPath ? resolveCodexCliLaunchPath(configuredPath) : configuredPath;
}

/** Check the exact user-selected executable and its local login state before model egress is allowed. */
async function verifyCodexCli(binaryPath: string): Promise<void> {
  if (!binaryPath || !path.isAbsolute(binaryPath) || !existsSync(binaryPath)) {
    throw new Error('Codex CLI is not configured. Set unode.codexCliPath to the absolute path of a supported, logged-in Codex CLI executable.');
  }
  const version = await runCodexCli(binaryPath, ['--version']);
  if (version.code !== 0 || !isSupportedCodexCliVersion(version.output)) {
    throw new Error(`Unsupported Codex CLI version (${version.output || 'unknown'}). UnodeAi supports stable codex-cli 0.137.0 through 0.144.x; select that executable in unode.codexCliPath.`);
  }
  const login = await runCodexCli(binaryPath, ['login', 'status']);
  if (login.code !== 0 || /not logged in/i.test(login.output)) {
    throw new Error('Codex CLI is not logged in. Run `codex login` in a terminal for the executable selected by unode.codexCliPath, then try again.');
  }
}

function runCodexCli(binaryPath: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const proc = cpSpawn(binaryPath, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => { output += chunk; });
    proc.stderr?.on('data', (chunk: string) => { output += chunk; });
    proc.once('error', reject);
    proc.once('exit', (code) => resolve({ code, output: output.trim() }));
  });
}

/** Settings connection cards derive from the route registry; the panel receives no provider-id-specific setup copy. */
function providerDefs(): ProviderDef[] {
  return effectiveConnectionRegistry.profiles.map((profile) => {
    const id = legacyProviderIdForConnectionId(profile.id, effectiveConnectionRegistry)!;
    return {
      providerId: id,
      connectionId: profile.id,
      revision: profile.revision,
      name: profile.presentation.displayName,
      apiKeySecretName: profile.apiKeySecretName,
      canManageApiKey: !profile.id.startsWith('custom:'),
      billingKind: profile.billingKind,
      baseUrl: profile.authKind === 'api-key' ? profile.presentation.endpointDefault : undefined,
      authKind: profile.authKind,
      catalogKind: profile.catalogKind,
      availability: profile.availability,
      availabilityMessage: profile.availabilityMessage,
      presentation: profile.presentation,
    };
  });
}

function customGatewayProfileForMutation(connectionId: string) {
  const profile = connectionProfile(connectionId, effectiveConnectionRegistry);
  if (!profile || !profile.id.startsWith('custom:')) {
    throw new Error('The selected custom gateway is no longer available. Refresh Settings and try again.');
  }
  return profile;
}

async function promptCustomGatewayName(title: string, value = ''): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    prompt: 'Name shown in connection pickers. It must be unique among built-in and custom connections.',
    value,
    ignoreFocusOut: true,
    validateInput: (input) => {
      const trimmed = input.trim();
      return trimmed && trimmed.length <= 80 && !/[\u0000-\u001f\u007f]/.test(trimmed)
        ? null
        : 'Use 1-80 visible characters without control characters.';
    },
  }).then((input) => input?.trim());
}

async function promptCustomGatewayEndpoint(title: string, value = ''): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    prompt: 'HTTPS base URL. Credentials, query strings, and fragments are not allowed.',
    value,
    ignoreFocusOut: true,
    validateInput: (input) => {
      try {
        requireHttpsCustomEndpoint(input);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : 'Enter a valid HTTPS endpoint.';
      }
    },
  }).then((input) => input === undefined ? undefined : requireHttpsCustomEndpoint(input));
}

/** API keys are collected in the host-only native prompt and never appear in a webview payload. */
async function promptCustomGatewayApiKey(title: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    prompt: 'API key is stored only in VS Code SecretStorage.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (input) => input.trim() ? null : 'Enter a non-empty API key.',
  }).then((input) => input?.trim());
}

function customGatewayReferences(connectionId: string): string[] {
  const references = sessionManager.getAll()
    .filter((session) => (session.config.route?.connectionId ?? connectionIdForProviderId(session.config.provider.providerId, effectiveConnectionRegistry)) === connectionId)
    .map((session) => session.config.name || session.config.id);
  const defaultConnection = connectionIdForProviderId(resolveDefaultProvider(), effectiveConnectionRegistry);
  if (defaultConnection === connectionId) {
    references.push('default provider');
  }
  const smartModeTiers = makeConfigStore().get<Partial<Record<ModelTier, Record<string, string>>>>('modelTiers', {});
  if (Object.values(smartModeTiers).some((tier) => !!tier?.[connectionId])) {
    references.push('Smart Mode model tier');
  }
  return references;
}

function assertCustomGatewayHasNoKnownReferences(connectionId: string): void {
  const references = customGatewayReferences(connectionId);
  if (references.length > 0) {
    throw new CustomGatewayReferenceError(references);
  }
}

class CustomGatewayReferenceError extends Error {
  constructor(readonly references: readonly string[]) {
    super(customGatewayRemoveBlockedMessage(references));
  }
}

function customGatewayReferencingAgentId(connectionId: string): string | undefined {
  return sessionManager.getAll().find((session) =>
    (session.config.route?.connectionId
      ?? connectionIdForProviderId(session.config.provider.providerId, effectiveConnectionRegistry)) === connectionId,
  )?.config.id;
}

async function offerCustomGatewayRebind(connectionId: string, error: CustomGatewayReferenceError): Promise<void> {
  const hasSettingsReference = error.references.some((reference) =>
    reference === 'default provider' || reference === 'Smart Mode model tier',
  );
  const choice = await vscode.window.showWarningMessage(
    error.message,
    'Go to Agent Builder',
    ...(hasSettingsReference ? ['Open Settings'] : []),
  );
  if (choice === 'Go to Agent Builder') {
    await vscode.commands.executeCommand('unode.openAgentBuilder', customGatewayReferencingAgentId(connectionId));
  } else if (choice === 'Open Settings') {
    await vscode.commands.executeCommand('unode.openSettings');
  }
}

function assertCustomGatewayHasNoActiveSession(connectionId: string): void {
  const active = sessionManager.getAll().filter((session) => {
    const selected = session.config.route?.connectionId
      ?? connectionIdForProviderId(session.config.provider.providerId, effectiveConnectionRegistry);
    return selected === connectionId && isCustomGatewayEditBlockedStatus(session.status);
  });
  if (active.length > 0) {
    throw new Error(customGatewayEditBlockedMessage(active.map((session) => session.config.name || session.id)));
  }
}

/**
 * Native-only custom-gateway creation shared by Settings and onboarding. The only value returned
 * to a caller is the new opaque connection id; the API key never leaves this host flow.
 */
async function addCustomGateway(): Promise<string | undefined> {
  const displayName = await promptCustomGatewayName('Add custom gateway');
  if (!displayName) { return; }
  const endpointBase = await promptCustomGatewayEndpoint('Add custom gateway endpoint');
  if (!endpointBase) { return; }
  const apiKey = await promptCustomGatewayApiKey(`Set API key for ${displayName}`);
  if (!apiKey) { return; }
  const snapshot = await customGatewayProfileStore.add({
    expectedRegistryRevision: effectiveConnectionRegistry.revision,
    displayName,
    endpointBase,
    apiKey,
  });
  const profile = snapshot.profiles.find((item) => item.displayName === displayName && item.endpointBase === endpointBase);
  if (!profile) {
    throw new Error('Custom gateway creation did not return the created profile.');
  }
  await reloadEffectiveConnectionRegistry();
  return profile.connectionId;
}

async function renameCustomGateway(connectionId: string): Promise<void> {
  const profile = customGatewayProfileForMutation(connectionId);
  const displayName = await promptCustomGatewayName('Rename custom gateway', profile.presentation.displayName);
  if (!displayName || displayName === profile.presentation.displayName) { return; }
  await customGatewayProfileStore.update({
    expectedRegistryRevision: effectiveConnectionRegistry.revision,
    expectedProfileRevision: profile.revision,
    connectionId: profile.id as `custom:${string}`,
    displayName,
  });
  await reloadEffectiveConnectionRegistry();
}

/**
 * One native-only edit flow for a custom connection.  The webview supplies only the validated
 * connection id; names, endpoint and any API key stay in VS Code's native prompts until written
 * to the profile store / SecretStorage.
 */
async function editCustomGateway(connectionId: string): Promise<void> {
  const profile = customGatewayProfileForMutation(connectionId);
  const displayName = await promptCustomGatewayName('Edit custom gateway name', profile.presentation.displayName);
  if (!displayName) { return; }
  const endpointBase = await promptCustomGatewayEndpoint('Edit custom gateway endpoint', profile.presentation.endpointDefault);
  if (!endpointBase) { return; }

  const keyAction = await vscode.window.showQuickPick([
    { label: 'Keep current API key', action: 'keep' as const },
    { label: 'Replace API key', action: 'replace' as const },
    ...(profile.apiKeySecretName ? [{ label: 'Clear API key', action: 'clear' as const }] : []),
  ], {
    title: 'Custom gateway API key',
    placeHolder: 'Optional: choose how to handle the stored API key',
    ignoreFocusOut: true,
  });
  if (!keyAction) { return; }

  const apiKey = keyAction.action === 'replace'
    ? await promptCustomGatewayApiKey(`Replace API key for ${displayName}`)
    : undefined;
  if (keyAction.action === 'replace' && !apiKey) { return; }

  const changesEndpointOrKey = endpointBase !== profile.presentation.endpointDefault || keyAction.action !== 'keep';
  if (changesEndpointOrKey) {
    assertCustomGatewayHasNoActiveSession(connectionId);
  }
  const changesProfile = displayName !== profile.presentation.displayName || endpointBase !== profile.presentation.endpointDefault;
  if (!changesProfile && keyAction.action === 'keep') { return; }

  const affected = changesEndpointOrKey ? customGatewayReferences(connectionId) : [];
  const affectedDetail = affected.length > 0
    ? ` Known local references: ${affected.join(', ')}.`
    : '';
  const confirmed = await vscode.window.showWarningMessage(
    `Save changes to ${profile.presentation.displayName}?${changesEndpointOrKey ? ` Existing agents must restart before another request.${affectedDetail}` : ''}`,
    { modal: true },
    'Save changes',
  );
  if (confirmed !== 'Save changes') { return; }

  if (changesProfile) {
    await customGatewayProfileStore.update({
      expectedRegistryRevision: effectiveConnectionRegistry.revision,
      expectedProfileRevision: profile.revision,
      connectionId: profile.id as `custom:${string}`,
      displayName,
      endpointBase,
    });
    await reloadEffectiveConnectionRegistry();
  }

  if (keyAction.action === 'keep') { return; }
  const latest = customGatewayProfileForMutation(connectionId);
  if (keyAction.action === 'replace') {
    await customGatewayProfileStore.replaceApiKey({
      expectedRegistryRevision: effectiveConnectionRegistry.revision,
      expectedProfileRevision: latest.revision,
      connectionId: latest.id as `custom:${string}`,
      apiKey: apiKey!,
    });
  } else {
    await customGatewayProfileStore.clearApiKey({
      expectedRegistryRevision: effectiveConnectionRegistry.revision,
      expectedProfileRevision: latest.revision,
      connectionId: latest.id as `custom:${string}`,
    });
  }
  await reloadEffectiveConnectionRegistry();
}

async function updateCustomGatewayEndpoint(connectionId: string): Promise<void> {
  const profile = customGatewayProfileForMutation(connectionId);
  assertCustomGatewayHasNoActiveSession(connectionId);
  const endpointBase = await promptCustomGatewayEndpoint('Edit custom gateway endpoint', profile.presentation.endpointDefault);
  if (!endpointBase || endpointBase === profile.presentation.endpointDefault) { return; }
  const affected = customGatewayReferences(connectionId);
  const affectedDetail = affected.length > 0
    ? ` Known local references: ${affected.join(', ')}.`
    : ' No known local agent, default, or Smart Mode reference was found.';
  const confirmed = await vscode.window.showWarningMessage(
    `Change ${profile.presentation.displayName} endpoint from ${profile.presentation.endpointDefault} to ${endpointBase}? Existing agents must restart before another request.${affectedDetail}`,
    { modal: true },
    'Change endpoint',
  );
  if (confirmed !== 'Change endpoint') { return; }
  await customGatewayProfileStore.update({
    expectedRegistryRevision: effectiveConnectionRegistry.revision,
    expectedProfileRevision: profile.revision,
    connectionId: profile.id as `custom:${string}`,
    endpointBase,
  });
  await reloadEffectiveConnectionRegistry();
}

async function replaceCustomGatewayKey(connectionId: string): Promise<void> {
  const profile = customGatewayProfileForMutation(connectionId);
  assertCustomGatewayHasNoActiveSession(connectionId);
  const apiKey = await promptCustomGatewayApiKey(`Replace API key for ${profile.presentation.displayName}`);
  if (!apiKey) { return; }
  await customGatewayProfileStore.replaceApiKey({
    expectedRegistryRevision: effectiveConnectionRegistry.revision,
    expectedProfileRevision: profile.revision,
    connectionId: profile.id as `custom:${string}`,
    apiKey,
  });
  await reloadEffectiveConnectionRegistry();
}

async function clearCustomGatewayKey(connectionId: string): Promise<void> {
  const profile = customGatewayProfileForMutation(connectionId);
  assertCustomGatewayHasNoActiveSession(connectionId);
  const confirmed = await vscode.window.showWarningMessage(
    `Clear the stored API key for ${profile.presentation.displayName}? Agents using it cannot start until a key is replaced.`,
    { modal: true },
    'Clear key',
  );
  if (confirmed !== 'Clear key') { return; }
  await customGatewayProfileStore.clearApiKey({
    expectedRegistryRevision: effectiveConnectionRegistry.revision,
    expectedProfileRevision: profile.revision,
    connectionId: profile.id as `custom:${string}`,
  });
  await reloadEffectiveConnectionRegistry();
}

/** A user-initiated, metadata-only connectivity check for one exact registered API-key connection. */
async function testConnection(connectionId: string): Promise<void> {
  const tested = await testApiKeyConnection(connectionId, {
    resolver: effectiveConnectionRegistry,
    getSecret: (secretRef) => secrets.get(secretRef),
    ensureConsent: ensureModelPickerConsent,
    metadataFetch,
  });
  void vscode.window.showInformationMessage(`${tested.displayName} responded to a model catalog request.`);
}

async function archiveCustomGateway(connectionId: string): Promise<void> {
  const profile = customGatewayProfileForMutation(connectionId);
  try {
    assertCustomGatewayHasNoKnownReferences(connectionId);
  } catch (error) {
    if (error instanceof CustomGatewayReferenceError) {
      await offerCustomGatewayRebind(connectionId, error);
      return;
    }
    throw error;
  }
  const confirmed = await vscode.window.showWarningMessage(
    `Remove ${profile.presentation.displayName} from your gateways? Agents still using it will show a repair prompt until you rebind them. Its opaque connection id remains tombstoned so it can never silently point somewhere else.`,
    { modal: true },
    'Remove gateway',
  );
  if (confirmed !== 'Remove gateway') { return; }
  await customGatewayProfileStore.archive({
    expectedRegistryRevision: effectiveConnectionRegistry.revision,
    expectedProfileRevision: profile.revision,
    connectionId: profile.id as `custom:${string}`,
    assertNoKnownReferences: async () => {
      try {
        assertCustomGatewayHasNoKnownReferences(connectionId);
      } catch (error) {
        if (error instanceof CustomGatewayReferenceError) {
          await offerCustomGatewayRebind(connectionId, error);
        }
        throw error;
      }
    },
  });
  await reloadEffectiveConnectionRegistry();
}

/** User-initiated Settings setup, fully described by the selected connection profile. */
function openConnectionSetup(connectionOrProviderId: string): void {
  const connectionId = connectionIdForProviderId(connectionOrProviderId, effectiveConnectionRegistry);
  const profile = connectionId ? connectionProfile(connectionId, effectiveConnectionRegistry) : undefined;
  const setup = profile?.presentation.setup;
  if (profile?.availability !== 'available') {
    void vscode.window.showInformationMessage(profile?.availabilityMessage ?? 'This connection is not available in this release.');
    return;
  }
  if (!profile || !setup || setup.kind !== 'cli' || !setup.loginCommand || !setup.terminalName) {
    return;
  }
  const terminal = vscode.window.createTerminal(setup.terminalName);
  terminal.show();
  terminal.sendText(setup.loginCommand, false);
  if (setup.requiredSetting) {
    void vscode.commands.executeCommand('workbench.action.openSettings', setup.requiredSetting);
  }
}

/** The endpoint a provider's stored key authenticates against, shown on its Providers-tab card. */
function providerEndpoint(providerId: string): string | undefined {
  const connectionId = connectionIdForProviderId(providerId, effectiveConnectionRegistry);
  const profile = connectionId ? connectionProfile(connectionId, effectiveConnectionRegistry) : undefined;
  return profile?.presentation.endpointDefault;
}

/** Agent ids currently granted a given MCP server (default-deny visibility for the Settings panel). */
function agentsGrantedServer(serverId: string): string[] {
  const out: string[] = [];
  for (const info of sessionManager.getAll()) {
    if (agentMcpGrants(info.config, skillResolver).some((g) => g.serverId === serverId)) {
      out.push(info.config.name);
    }
  }
  return out;
}

/**
 * What this agent is for, from the shipped role template it was built from.
 *
 * Read from `roleTemplateKey` rather than `role`: several knowledge-work templates deliberately share the
 * runtime role `custom`, so `role` cannot tell a Content Strategist from a Frontend Engineer. A user-written
 * description wins when there is one — they know their own team better than a template does.
 */
function specialtyForAgent(config: AgentConfig): string | undefined {
  const described = config.description?.trim();
  if (described) {
    return described;
  }
  const template = config.roleTemplateKey ? ROLE_TEMPLATES[config.roleTemplateKey] : undefined;
  return template?.description?.trim() || undefined;
}

/**
 * What an agent is equipped to do, by name, for the coordinator's routing decision.
 *
 * Merges two fields because role templates populate them inconsistently: `skills` carries capability tokens
 * with display names, `playbooks` carries the SKILL.md procedures the agent actually runs. The Content
 * Strategist has the first and not the second; the Frontend Engineer has the second and not the first.
 * Sending one field would hide whichever specialist chose the other, for exactly the work it exists for.
 *
 * Playbook ids are already readable (`technical-seo-audit`), so they are passed through rather than
 * prettified — a rewrite here would drift from the id the agent is actually granted.
 */
function skillsForAgent(config: AgentConfig): string[] {
  const named = (config.skills ?? []).map((skill) => skill.name).filter(Boolean);
  const playbooks = (config.playbooks ?? []).filter(Boolean);
  return [...new Set([...named, ...playbooks])];
}

/**
 * Whether a per-assignment folder scope can be enforced for this agent.
 *
 * This mirrors `orchestrationHost.resolveTaskWorkspaceAccess`, the enforcement point. The two must agree:
 * a roster that advertises `per-turn` for an agent the dispatcher then refuses is worse than saying nothing,
 * because the coordinator would have chosen it *on the strength of the advertisement*.
 */
function taskScopeCapabilityFor(config: AgentConfig): TaskScopeCapability {
  const kind = config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry);
  if (kind !== 'openai-compat') {
    // A native CLI holds its filesystem boundary for the life of the session. Whatever Folder Access the
    // agent is configured with still applies; what cannot happen is narrowing it for one assignment.
    return 'fixed-session-only';
  }
  return 'per-turn';
}

/** Current, host-derived delegation facts. Keep this deliberately small: 0.9.37 needs the coordinator to
 * avoid assigning impossible work, while the versioned Capability Profile/provenance model remains 0.9.40+. */
function delegationCapabilitiesFor(config: AgentConfig): TeamRosterEntry['capabilities'] {
  const profile = connectionProfileForAgent(config, effectiveConnectionRegistry);
  if (!profile) {
    return undefined;
  }
  const allows = (tool: string) => !Array.isArray(config.allowedTools) || config.allowedTools.includes(tool);
  const c = profile.capabilities;
  const read = c.read && (allows('read') || allows('search'));
  const write = c.write && allows('write');
  const shell = c.command && allows('execute');
  const backend = config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry);
  const verificationSensors: VerificationSensorKind[] = [
    ...(shell ? ['command-exit-zero' as const] : []),
    ...(write ? ['recorded-file-effect' as const] : []),
    ...(backend === 'openai-compat' && write && vscode.workspace.getConfiguration('unode').get<boolean>('engine.postWriteDiagnostics', true)
      ? ['editor-diagnostics-clean' as const] : []),
    ...((backend === 'openai-compat' || backend === 'claude') && canDelegate(config) &&
      vscode.workspace.isTrusted && !config.folderAccess?.length &&
      !!resolveVerifyCommand(vscode.workspace.getConfiguration('unode').get<string>('verifyCommand', ''), projectConventions.getInfo())
      ? ['run-checks' as const] : []),
  ];
  const toolFamilies = [
    ...(allows('read') && c.read ? ['read'] : []),
    ...(allows('search') && c.read ? ['search'] : []),
    ...(write ? ['write'] : []),
    ...(shell ? ['execute'] : []),
    ...(allows('delegate') && c.delegation ? ['delegate'] : []),
  ];
  return {
    read, write, shell, verificationSensors, toolFamilies,
    backend,
    taskScope: taskScopeCapabilityFor(config),
  };
}

/**
 * Refresh the cost table from live gateway /api/pricing endpoints — the Roam gateway (unode.baseUrl)
 * plus any new-api-compatible gateways the user lists in unode.pricingSources. Called on activation,
 * daily, and when the model picker opens, so prices refresh online and stay current. Best-effort:
 * a failing source logs and leaves the static/override table in place.
 *
 * EVERY source is filtered through `hasMetadataConsent` — a price refresh rides on an approved host or it
 * does not happen. On a fresh install the background call is a no-op: zero network.
 *
 * `interactive` is the difference between a background refresh and a user asking for prices. Background
 * (activation, daily timer) may NEVER prompt — it skips silently and the built-in table stands in. A
 * user-initiated path (model picker, provider switch, the Refresh Model Prices command) MAY ask, because the
 * user just asked for the thing the question is about. Pass it only from a path a user actually clicked.
 */
async function pricingSources(): Promise<Array<{ providerId?: string; url: string; apiKey?: string; group?: string }>> {
  const cfg = vscode.workspace.getConfiguration('unode');
  // These are profile-pinned endpoints. `unode.baseUrl` and `unode.unodeBaseUrl` may exist in old
  // settings files but must never redirect a stored gateway key, even for metadata requests.
  const roamBase = providerEndpoint('roam') ?? ROAM_DEFAULT_BASE_URL;
  const unodeBase = providerEndpoint('unode') ?? UNODE_DEFAULT_BASE_URL;
  // A billing group belongs to the KEY, not to the account (confirmed with the gateway operator,
  // 2026-08-21): two keys on one account can sit in different groups, with different prices AND different
  // callable models. A single global string could not express that — pinning it correctly for one gateway
  // made it wrong for the other — so the setting also accepts a map keyed by connection id.
  const priceGroupFor = readPriceGroupSetting(cfg.get('priceGroup'));
  // Each gateway is fetched WITH that gateway's own key so /api/pricing returns the account's discount
  // group (group_ratio); keys are NOT sent to third-party pricingSources. Roam = weroam, Unode = unodetech.
  const roamKeyName = connectionProfile('roam', effectiveConnectionRegistry)?.apiKeySecretName;
  const unodeKeyName = connectionProfile('unode', effectiveConnectionRegistry)?.apiKeySecretName;
  const roamKey = roamKeyName ? await secrets.get(roamKeyName) : undefined;
  const unodeKey = unodeKeyName ? await secrets.get(unodeKeyName) : undefined;
  return [
    { providerId: 'roam', url: roamBase, apiKey: roamKey, group: priceGroupFor('roam') },
    { providerId: 'unode', url: unodeBase, apiKey: unodeKey, group: priceGroupFor('unode') },
    ...cfg.get<string[]>('pricingSources', []).map((url) => ({ url })),
  ].filter((s) => typeof s.url === 'string' && s.url.length > 0);
}

/**
 * Offer a set of hosts for metadata approval — one question per host, at most once each, ever.
 *
 * USER-INITIATED PATHS ONLY. Kept separate from the fetch so a caller can ask FIRST and then bound how long
 * it waits for the answer's payload: the Agent Builder dropdown races the fetch against 1.5s so a slow
 * gateway cannot hang the UI, and a modal inside that race would be answered after the race had already
 * given up. Ask, then race.
 *
 * A decline stores nothing, so the next time the user asks for prices we ask again — and never in between.
 */
/**
 * Ask about exactly the hosts opening THIS provider's model picker will contact: its own `/models` endpoint,
 * the curated catalog URL if one is configured, and — only if this provider has one — its own price endpoint.
 *
 * Not `pricingSources()`. That list always contains both default gateways, so the first version of this
 * prompted for weroam and unodetech while the user was picking an OpenAI model. Another gateway's price list
 * is not something this action needs, so it is not something this action may ask for.
 */
async function ensureModelPickerConsent(providerId: string, endpointBaseUrl?: string): Promise<void> {
  const catalogUrl = vscode.workspace.getConfiguration('unode').get<string>('modelCatalogUrl', '') || undefined;
  // Only the SELECTED provider's own price source. Direct providers (OpenAI, Anthropic…) have none — their
  // prices come from the built-in table — so for them this is simply absent, and nothing is asked about it.
  const ownPriceSource = (await pricingSources()).find((s) => s.providerId === providerId);
  const connectionId = connectionIdForProviderId(providerId, effectiveConnectionRegistry);
  const secretRef = connectionId ? connectionProfile(connectionId, effectiveConnectionRegistry)?.apiKeySecretName : undefined;
  const apiKey = secretRef ? await secrets.get(secretRef) : undefined;
  await requestMetadataConsent(planModelPicker({
    endpointUrl: endpointBaseUrl,
    catalogUrl,
    priceUrl: ownPriceSource?.url,
    hasKey: !!apiKey,
  }), { requester: 'Model picker' });
}

/**
 * Give legacy stored keys an explicit coefficient only after the user deliberately reaches a price surface.
 *
 * This is an idempotent read repair, not an activation migration. A connection with no safely inferred rate
 * remains unstated until the user supplies one; the repair writes only the conservative list-price default
 * for old stored keys and says why it did so.
 */
async function repairPriceMultipliersAfterUserAction(
  reason: 'Settings' | 'Refresh model prices',
): Promise<PriceMultiplierReadRepairResult> {
  if (priceMultiplierReadRepairInFlight) {
    return priceMultiplierReadRepairInFlight;
  }
  const repair = (async () => {
    const settings = vscodeSettings('unode');
    const result = await repairPriceMultipliers({
      readSetting: () => settings.read<unknown>('priceMultiplier'),
      connectionsWithStoredKeys: async () => {
        const withKeys: string[] = [];
        for (const profile of effectiveConnectionRegistry.profiles) {
          if (profile.authKind !== 'api-key' || !profile.apiKeySecretName) { continue; }
          if (await secrets.has(profile.apiKeySecretName)) { withKeys.push(profile.id); }
        }
        return withKeys;
      },
      writeSetting: (next) => settings.writeGlobal('priceMultiplier', next),
    });
    if (result.changed) {
      outputChannel.info(
        `[price coefficient read repair after ${reason}] defaulted to 1 (list price) for ${result.added.join(', ')}. `
        + 'A gateway does not report the rate a key settles at; set "unode.priceMultiplier" when a key pays a fraction of list.'
      );
      void vscode.window.showInformationMessage(
        `While opening ${reason}, UnodeAi set a price coefficient of 1 (list price) for ${result.added.length} existing connection(s). `
        + 'If a key pays a discounted rate, set it so cost estimates are right.',
        'Open setting',
      ).then((choice) => {
        if (choice === 'Open setting') {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'unode.priceMultiplier');
        }
      });
    }
    return result;
  })();
  priceMultiplierReadRepairInFlight = repair;
  try {
    return await repair;
  } finally {
    if (priceMultiplierReadRepairInFlight === repair) {
      priceMultiplierReadRepairInFlight = undefined;
    }
  }
}

async function refreshPrices(opts: { interactive?: boolean; scope?: string } = {}): Promise<void> {
  const livePriceService = getLivePrices();
  const priceTable = getPricing();
  // Read per refresh rather than cached at activation: a user who fixes their coefficient wants the next
  // refresh to use it, not the next window.
  const priceMultiplierFor = readPriceMultiplierSetting(
    vscode.workspace.getConfiguration('unode').get('priceMultiplier'),
  );
  // Scope BEFORE consent. Consent says which hosts may EVER be contacted; scope says which of those THIS
  // action contacts. Narrowing only the prompt was not enough: a user who had approved Roam and Unode last
  // week opened the OpenAI picker and — with no modal, because everything was already consented — still sent
  // both gateways a price request. The picker paths pass their providerId; activation, the daily timer and
  // the explicit Refresh command stay unscoped, because there every gateway is legitimately in play.
  // (Codex, v0.9.29 review: the prompt scope and the actual reach must narrow together.)
  const configured = scopedSources(await pricingSources(), opts.scope);
  if (opts.interactive) {
    // The user explicitly asked for this refresh, so re-ask even hosts they declined earlier in the session —
    // a "not now" from an earlier picker must not silently make this command do nothing.
    await requestMetadataConsent(planPriceRefresh(configured), { reAsk: true, requester: 'Refresh model prices' });
  }

  const { allowed: sources, skipped } = consentedSources(configured, hasMetadataConsent);
  for (const s of skipped) {
    outputChannel.debug(
      `Price refresh skipped for ${hostOf(s.url)} — that host is not approved for network access yet. `
      + 'Built-in prices are in use; live prices load once you approve the gateway.'
    );
  }

  for (const { providerId, url, apiKey, group } of sources) {
    try {
      // Exactly one discount is applied, and the service decides which. A stated coefficient and a
      // gateway group ratio are two answers to the same question — multiplying them answered it twice and
      // displayed 0.1089 of list when both were 0.33.
      const stated = providerId ? priceMultiplierFor(providerId) : undefined;
      const { prices, resolution, cacheState } = await livePriceService.fetchGatewayPricesDetailed(
        url, apiKey, group, stated, { scope: providerId ?? url },
      );
      const count = Object.keys(prices).length;
      if (count > 0) {
        priceTable.merge(prices, providerId);
        lastPriceRefreshAt = new Date().toISOString();
        // The basis is logged with the count because a price is a claim about money, and a claim about
        // money with no stated basis is one nobody can check. A gateway that offers several price groups
        // and will not say which one bills is the case that produced a display of a third of the real rate.
        outputChannel.info(
          `Refreshed ${count} model price(s) from ${providerId ? `${providerId} (${url})` : url} `
          + `— ${describeGroupRatio(resolution)}. Last refresh: ${lastPriceRefreshAt}.`
        );
        if (cacheState === 'stale') {
          outputChannel.warn(
            `Live prices for ${providerId ?? hostOf(url)} could not be refreshed; displaying the previous, stale result.`,
          );
        }
        if (resolution.basis === 'assumed-undiscounted') {
          outputChannel.warn(
            `${providerId ?? hostOf(url)} offers price groups ${(resolution.ambiguousGroups ?? []).join(', ')} `
            + 'and does not report which one bills this key. Prices shown are the undiscounted rate. '
            + 'Set "unode.priceGroup" to your group to see what you are actually charged.'
          );
        }
      }
    } catch (err) {
      outputChannel.warn(`Price refresh failed for ${url}: ${String(err)}`);
    }
  }
}

// ─── Persistence ──────────────────────────────────────────────────────

/**
 * 0.9.0 provider split: Roam now defaults to the weroam gateway; the previous endpoint is the separate
 * "Unode" provider. One-time, idempotent (globalState-guarded) migration so existing users are NOT broken:
 *  - the existing ROAM_API_KEY is actually a Unode key → preserve it as UNODE_API_KEY, then clear ROAM_API_KEY
 *    (so Roam awaits a fresh weroam key instead of 401'ing with the unode one — its value is kept under Unode);
 *  - existing roam agents (on the old unode endpoint, or no explicit base) move to the `unode` provider so
 *    they keep running unchanged. New roam agents (weroam, no base) are unaffected because this runs once.
 */
/**
 * Cosmetic, idempotent, runs EVERY launch (not flag-guarded): reset a persisted unode.baseUrl that still
 * points at the old unode endpoint to the weroam default, so the Settings UI matches historic expectations.
 * Model and metadata egress are now profile-pinned; this is compatibility-only cleanup for users who launched
 * 0.9.0 before this landed, whose once-migration flag is already set. A no-op once the value is canonical.
 */
async function correctStaleRoamBaseUrl(): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration('unode');
    const inspected = cfg.inspect<string>('baseUrl');
    const staleUnode = (v?: string) => !!v && /unodetech\.xyz/i.test(v);
    if (staleUnode(inspected?.workspaceValue)) { await cfg.update('baseUrl', ROAM_DEFAULT_BASE_URL, vscode.ConfigurationTarget.Workspace); }
    if (staleUnode(inspected?.globalValue)) { await cfg.update('baseUrl', ROAM_DEFAULT_BASE_URL, vscode.ConfigurationTarget.Global); }
  } catch (err) {
    outputChannel.warn(`unode.baseUrl correction skipped: ${String(err)}`);
  }
}

async function migrateToProviderSplit(context: vscode.ExtensionContext): Promise<void> {
  // The SECRET move is GLOBAL (VS Code SecretStorage is global) → guard it in globalState, once per install.
  // The AGENT-ROSTER move is PER-WORKSPACE (workspaceState + .unode/team.json) → guard it in workspaceState,
  // so a second/older workspace opened later still migrates its own old roam agents (Codex fix). Splitting
  // the two guards prevents the first workspace from consuming a global flag that then skips other rosters.
  const SECRET_FLAG = 'roam.migration.providerSplit.v0_9';
  const ROSTER_FLAG = 'roam.migration.providerSplitRoster.v0_9';

  let movedKey = false;
  if (!context.globalState.get<boolean>(SECRET_FLAG)) {
    const roamKey = await secrets.get('ROAM_API_KEY');
    const unodeKey = await secrets.get('UNODE_API_KEY');
    if (roamKey && !unodeKey) {
      await secrets.set('UNODE_API_KEY', roamKey);
      await secrets.delete('ROAM_API_KEY');
      movedKey = true;
    }
    await context.globalState.update(SECRET_FLAG, true);
  }

  let agentsMoved = 0;
  if (!context.workspaceState.get<boolean>(ROSTER_FLAG)) {
    const migrate = (configs: AgentConfig[]): { configs: AgentConfig[]; changed: number } => {
      let changed = 0;
      const out = configs.map((c) => {
        if (c.provider?.providerId !== 'roam') { return c; }
        const base = c.baseUrl?.trim();
        if (base && !/unodetech\.xyz/i.test(base)) { return c; } // a genuinely custom roam base — leave it
        changed++;
        return { ...c, provider: { providerId: 'unode', apiKeySecretName: 'UNODE_API_KEY' }, baseUrl: UNODE_DEFAULT_BASE_URL };
      });
      return { configs: out, changed };
    };
    try {
      const last = persistence.loadAgents();
      if (last.length) {
        const r = migrate(last);
        if (r.changed) { await persistence.saveAgents(r.configs); agentsMoved += r.changed; }
      }
      const team = await persistence.loadTeamConfig();
      if (team?.members?.length) {
        const r = migrate(team.members);
        if (r.changed) { await persistence.saveTeamConfig({ ...team, members: r.configs }); agentsMoved += r.changed; }
      }
      await context.workspaceState.update(ROSTER_FLAG, true);
    } catch (err) {
      outputChannel.warn(`Provider-split agent migration skipped: ${String(err)}`); // leave the flag unset → retry next launch
    }
  }

  if (movedKey || agentsMoved) {
    void vscode.window.showInformationMessage(
      'UnodeAi now defaults to the Unode gateway. Your existing agents and API key were kept on ' +
      'Unode (unchanged). To use the partner gateway, add your partner-gateway API key in Settings.'
    );
  }
}

async function restoreRoster(): Promise<void> {
  // Load the team-level MCP server registry first, so backends built below can resolve grants.
  const teamConfig = await persistence.loadTeamConfig();
  mcpRegistry.clear();
  for (const cfg of teamConfig?.mcpServers ?? []) {
    mcpRegistry.set(cfg.id, cfg);
  }

  const lastUsed = persistence.loadAgents();
  const fromFile = teamConfig?.members ?? [];
  const sourceAgents = lastUsed.length > 0 ? lastUsed : fromFile;
  let agents: AgentConfig[];
  let routeMigrationChanged = false;
  try {
    const migrated = sourceAgents.map((config) => migrateAgentConfigOrRepair(config, effectiveConnectionRegistry));
    agents = migrated.map((result) => result.config);
    routeMigrationChanged = migrated.some((result) => result.changed);
  } catch (error) {
    const message = error instanceof RouteMigrationError || error instanceof Error ? error.message : String(error);
    outputChannel.error(`Route migration stopped: ${message}`);
    void vscode.window.showErrorMessage(`UnodeAi did not start this roster. ${message} Edit the connection in .unode/team.json or recreate the affected agent.`);
    return;
  }
  const promptMigrationChanged = agents.reduce((changed, config) => migratePromptTemplateSource(config) || changed, false);
  if (routeMigrationChanged || promptMigrationChanged) {
    // Persist the explicit source marker immediately. This makes future upgrades deterministic while
    // preserving every prompt we could not prove was an untouched shipped default.
    await persistence.saveAgents(agents);
    if (lastUsed.length === 0 && teamConfig) {
      await persistence.saveTeamConfig({ ...teamConfig, members: agents });
    }
    if (routeMigrationChanged) {
      void vscode.window.showInformationMessage('UnodeAi updated this roster to versioned connection routes. Model names did not choose a new connection.');
    }
  }
  for (const config of agents) {
    sessionManager.create(config);
  }
  if (agents.length > 0) {
    outputChannel.info(
      `Restored ${agents.length} agent(s) from ${lastUsed.length > 0 ? 'last workspace state' : '.unode/team.json'}.`
    );
    teamViewProvider?.refresh();
  }
  if (mcpRegistry.size > 0) {
    outputChannel.info(`Loaded ${mcpRegistry.size} MCP server(s) from .unode/team.json.`);
    registerReferencedMcpServers();
  }
}

async function saveRoster(): Promise<void> {
  await persistence.saveAgents(sessionManager.getAll().map((s) => s.config));
}

const backgroundRosterSaveReporter = new BackgroundPersistenceReporter({
  logError: (message) => outputChannel.error(message),
  showError: (message) => vscode.window.showErrorMessage(message),
});

/** Session events cannot await persistence, so rejected saves must be made visible rather than dropped. */
function saveRosterInBackground(): void {
  runBackgroundPersistence(saveRoster, backgroundRosterSaveReporter, 'save the agent roster');
}

const STOP_AGENT_ACTION = 'Stop agent';
const DISABLE_NATIVE_SUBAGENTS_ACTION = 'Disable native subagents for this agent';
const LEARN_MORE_ACTION = 'Learn more';

function handleClaudeUnmediatedToolUse(agentId: string, tool: string, agentName: string): void {
  const message =
    `${agentName} used Claude's native ${tool} tool. Tool calls inside that subagent are mediated ` +
    `by UnodeAi's fail-closed PreToolUse gate, including command approval.`;
  outputChannel.warn(message);
  void vscode.window.showWarningMessage(
    message,
    STOP_AGENT_ACTION,
    DISABLE_NATIVE_SUBAGENTS_ACTION,
    LEARN_MORE_ACTION
  ).then((choice) => {
    if (choice === STOP_AGENT_ACTION) {
      sessionManager.interrupt(agentId);
      return;
    }
    if (choice === DISABLE_NATIVE_SUBAGENTS_ACTION) {
      void disableNativeSubagentsForAgent(agentId);
      return;
    }
    if (choice === LEARN_MORE_ACTION) {
      void openSecurityNativeSubagentsSection();
    }
  });
}

async function disableNativeSubagentsForAgent(agentId: string): Promise<void> {
  const session = sessionManager.get(agentId);
  if (!session) {
    return;
  }
  session.config.disableNativeSubagents = true;
  await saveRoster();
  teamViewProvider?.refresh();
  chatViewProvider?.postNotice(
    agentId,
    'Claude native Agent/Workflow tools are now disabled for this agent. The current Claude process was stopped so the setting takes effect on the next run.'
  );
  sessionManager.interrupt(agentId);
  void vscode.window.showInformationMessage(`Disabled Claude native subagents for ${session.config.name}.`);
}

async function openSecurityNativeSubagentsSection(): Promise<void> {
  try {
    const base = extensionContext?.extensionUri.fsPath ?? workspaceRoot();
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(base, 'SECURITY.md')));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const lines = doc.getText().split(/\r?\n/);
    const line = lines.findIndex((text) => /native subagent|Agent\/Workflow|permission-prompt-tool/i.test(text));
    if (line >= 0) {
      const range = new vscode.Range(line, 0, line, 0);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(range.start, range.start);
    }
  } catch (err) {
    void vscode.window.showWarningMessage(`Could not open SECURITY.md: ${String(err)}`);
  }
}

// ─── Events ───────────────────────────────────────────────────────────

function wireEvents(): void {
  const refreshTeam = () => {
    teamViewProvider?.refresh();
    chatViewProvider?.refresh();
    updateStatusBar();
  };

  sessionManager.on('session.created', () => {
    refreshTeam();
    saveRosterInBackground();
    scheduleTeamRulesOnRosterChange();
  });
  sessionManager.on('session.removed', (e) => {
    chatViewProvider?.clearAgent(e.sessionId);
    refreshTeam();
    saveRosterInBackground();
    agentChannels.get(e.sessionId)?.channel.dispose();
    agentChannels.delete(e.sessionId);
    void worktreeCoordinator?.release(e.sessionId); // tear down the agent's worktree, if any
    scheduleTeamRulesOnRosterChange();
  });
  sessionManager.on('session.started', refreshTeam);
  sessionManager.on('session.stopped', refreshTeam);
  // B1: start deferred by the concurrency cap — tell the user it's queued, not failed.
  sessionManager.on('session.queued', (e) => {
    refreshTeam();
    const name = resolveAgentName(e.sessionId);
    outputChannel.info(`Agent ${name} queued: ${e.data.reason}`);
    void vscode.window.showInformationMessage(
      `Agent '${name}' queued — it will start when a slot frees (${e.data.reason}).`
    );
  });
  sessionManager.on('session.status', () => {
    teamViewProvider?.refresh();
    chatViewProvider?.refresh();
  });
  sessionManager.on('session.error', (e) => {
    refreshTeam();
    outputChannel.error(`Agent ${resolveAgentName(e.sessionId)}: ${e.data?.error ?? 'error'}`);
    getAgentChannel(e.sessionId).appendLine(`❌ ERROR: ${e.data?.error ?? 'error'}`);
  });
  // A persistently-failing primary model was swapped to its fallback — make it visible.
  sessionManager.on('session.modelSwitched', (e) => {
    refreshTeam();
    const note = `Switched ${resolveAgentName(e.sessionId)} to fallback model ${e.data.to} (${e.data.reason}).`;
    outputChannel.warn(note);
    getAgentChannel(e.sessionId).appendLine(`↪ ${note}`);
  });
  // Each agent's own transcript (assistant text + tool calls) goes to its dedicated channel.
  sessionManager.on('session.output', (e) => {
    const content = e.data?.content;
    if (content && e.sessionId) {
      getAgentChannel(e.sessionId).appendLine(String(content).trimEnd());
    }
  });
  sessionManager.on('session.stream', (e) => {
    if (e.sessionId && e.data?.delta) {
      chatViewProvider?.appendDelta(e.sessionId, e.data.delta, e.data.epoch);
    }
  });
  sessionManager.on('session.reasoning', (e) => {
    if (e.sessionId && e.data?.delta) {
      chatViewProvider?.appendReasoning(e.sessionId, e.data.delta, e.data.epoch);
    }
  });
  sessionManager.on('session.tool', (e) => {
    if (e.sessionId && e.data) {
      if (e.data.phase === 'use') {
        const serverId = mcpGrantExercisedByTool(e.data.name);
        if (serverId) {
          runLedger.recordPermission({
            agentId: e.sessionId,
            kind: 'mcp-grant',
            label: serverId,
            decision: 'allowed',
            correlationId: e.data.correlationId,
          });
        }
      }
      chatViewProvider?.appendToolActivity(e.sessionId, e.data);
    }
  });
  sessionManager.on('session.taskProgress', (e) => {
    if (e.sessionId && e.data) {
      runLedger.recordDelegationProgress({
        handle: e.data.correlationId,
        agentId: e.sessionId,
        progress: e.data.progress,
      });
    }
  });
  sessionManager.on('session.context', (e) => {
    if (e.sessionId && e.data) {
      chatViewProvider?.setContext(e.sessionId, e.data);
      // Stash the latest usage on the session so the Dashboard can show per-agent context %.
      const info = sessionManager.get(e.sessionId);
      if (info) {
        info.contextUsage = e.data as ContextWindowUsage;
      }
      teamViewProvider?.refresh(); // live ctx%/cost in the Team panel cards
    }
  });
  sessionManager.on('session.contextManifest', (e) => {
    if (e.sessionId && e.data) {
      runLedger.recordContextManifest(e.sessionId, e.data.manifest, e.data.correlationId);
      chatViewProvider?.setContextManifest(e.sessionId, e.data.manifest, e.data.epoch);
    }
  });
  sessionManager.on('session.taskScopeApplied', (e) => {
    if (e.sessionId && e.data) {
      runLedger.recordTaskScopeApplied(e.data.handle, e.data.scope, e.timestamp);
      if (orchestrationProgress.recordTaskScopeApplied(e.data.handle)) {
        const summaries = orchestrationProgress.snapshot();
        chatViewProvider?.setDelegationProgress(summaries);
        messageLogProvider?.setDelegationProgress(summaries);
        teamViewProvider?.setDelegationProgress(orchestrationProgress.agentStates());
      }
    }
  });
  sessionManager.on('session.compacted', (e) => {
    if (e.sessionId && e.data) {
      chatViewProvider?.appendCompactionMarker(e.sessionId, e.data.dropped);
    }
  });
  // Persisted here rather than in SessionManager: the roster is this layer's to write, and a ceiling the
  // provider proved is worth exactly as much as its survival across a reload.
  sessionManager.on('session.contextWindowObserved', (e) => {
    if (e.sessionId && e.data) {
      chatViewProvider?.appendContextWindowMarker(e.sessionId, e.data.model, e.data.tokens);
      outputChannel.info(
        `${e.sessionId}: ${e.data.model} rejected a request for size; recorded a ${e.data.tokens.toLocaleString()}-token context ceiling.`
      );
      saveRosterInBackground();
    }
  });

  messageBus.on('message.sent', (msg) => {
    runLedger.observeMessage(msg as Message);
    if (orchestrationProgress.recordMessage(msg as Message)) {
      const summaries = orchestrationProgress.snapshot();
      chatViewProvider?.setDelegationProgress(summaries);
      messageLogProvider?.setDelegationProgress(summaries);
      teamViewProvider?.setDelegationProgress(orchestrationProgress.agentStates());
    }
    messageLogProvider?.refresh();
    scheduleMessageSave();
  });
}

/** Debounced persistence of recent message history (P1#5), so the log survives a reload. */
function scheduleMessageSave(): void {
  if (messageSaveTimer) {
    clearTimeout(messageSaveTimer);
  }
  messageSaveTimer = setTimeout(() => {
    persistence.saveMessages(messageBus.exportMessages());
  }, 1500);
}

/** Persist the run ledger separately from the rolling message store. Open runs survive host restart. */
function scheduleRunSave(): void {
  if (runSaveTimer) {
    clearTimeout(runSaveTimer);
  }
  runSaveTimer = setTimeout(() => {
    runSaveTimer = undefined;
    persistence.saveRuns(runLedger.snapshot());
  }, 750);
}

/** A configured server id is the only label retained for an exercised MCP grant; never retain tool input. */
function mcpGrantExercisedByTool(toolName: string): string | undefined {
  for (const serverId of mcpRegistry.keys()) {
    if (toolName.startsWith(`${serverId}__`) || toolName.startsWith(`mcp__${serverId}__`)) {
      return serverId;
    }
  }
  return undefined;
}

// ─── Commands ─────────────────────────────────────────────────────────

/**
 * "UnodeAi: Reset Workspace State" — wipe this workspace's persisted Roam state so the user can
 * start clean (e.g. after a stale roster/chat history bleeds across reinstalls). Optionally clears
 * stored provider API keys too. Reloads the window so everything re-initializes from empty (the
 * setup wizard then reopens because no agents are restored).
 */
async function resetWorkspaceStateCommand(): Promise<void> {
  const RESET = 'Reset';
  const RESET_KEYS = 'Reset + clear API keys';
  const choice = await vscode.window.showWarningMessage(
    'Reset UnodeAi in this workspace? This permanently clears the team roster (including .unode/team.json), all chat history, the message log, saved conversations, workflows, and approved MCP servers for this workspace, then reopens the setup wizard. This cannot be undone.',
    { modal: true },
    RESET,
    RESET_KEYS
  );
  if (choice !== RESET && choice !== RESET_KEYS) {
    return;
  }

  // Stop deactivate() from flushing the in-memory message buffer back into the state we're wiping.
  if (messageSaveTimer) {
    clearTimeout(messageSaveTimer);
    messageSaveTimer = undefined;
  }

  if (runSaveTimer) {
    clearTimeout(runSaveTimer);
    runSaveTimer = undefined;
  }

  // Tear down live agents first (shrinks the persisted roster and clears their chat entries).
  for (const session of [...sessionManager.getAll()]) {
    await sessionManager.remove(session.config.id).catch(() => undefined);
  }

  await persistence.resetWorkspaceState();
  // Also drop .unode/team.json — otherwise the now-empty workspaceState would re-seed the cleared
  // roster from it on reload (the "Browser keeps coming back after Reset" bug).
  await persistence.deleteTeamFile();

  if (choice === RESET_KEYS) {
    // Custom gateway profiles are machine-scoped and must be changed through their durable store,
    // not a workspace reset that would leave their profile record pointing at a missing secret.
    const names = new Set(effectiveConnectionRegistry.profiles
      .filter((profile) => !profile.id.startsWith('custom:'))
      .flatMap((profile) => profile.apiKeySecretName ? [profile.apiKeySecretName] : []));
    for (const name of names) {
      await secrets.delete(name);
    }
  }

  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

const JSON_FILTERS = { JSON: ['json'] };

function timestampForFile(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join('');
}

function safeFilePart(value: string): string {
  return value.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'transcript';
}

/** Native acceptance surface: reached from needs-human and available later from the command palette. */
async function reviewRunAcceptance(runId?: string): Promise<void> {
  let run = typeof runId === 'string' ? runLedger.get(runId) : undefined;
  if (!run) {
    const choices = runLedger.list().map((candidate) => ({
      label: `${candidate.verdict ? '$(pass-filled)' : '$(question)'} ${resolveAgentName(candidate.coordinatorId)} — ${candidate.verdict ?? 'unjudged'}`,
      description: acceptanceRunPickerDescription(candidate),
      runId: candidate.id,
    }));
    const selected = await vscode.window.showQuickPick(choices, {
      title: 'Review delivered work',
      placeHolder: 'Choose a run to judge, or dismiss to leave every run unjudged.',
      matchOnDescription: true,
    });
    run = selected ? runLedger.get(selected.runId) : undefined;
  }
  if (!run) { return; }
  if (run.delegations.some((delegation) => delegation.state === 'active')) {
    void vscode.window.showInformationMessage('This run still has active delegated work. It remains unjudged until the work settles.');
    return;
  }
  const continueChoice = await vscode.window.showInformationMessage(
    runAcceptanceEvidence(run),
    { modal: true },
    'Record a human verdict',
  );
  if (continueChoice !== 'Record a human verdict') { return; }
  const choice = await vscode.window.showQuickPick([
    { label: 'Accept delivered work', detail: 'Records a human acceptance.', verdict: 'accepted' as const },
    { label: 'Accept with exceptions', detail: 'Records acceptance and the remaining unresolved items.', verdict: 'accepted-with-exceptions' as const },
    { label: 'Reject delivered work', detail: 'Records a human rejection; this is a valid measured outcome.', verdict: 'rejected' as const },
  ], {
    title: 'Human acceptance verdict',
    placeHolder: 'Choose a verdict, or dismiss to leave this run unjudged.',
  });
  if (!choice) { return; }
  let unresolvedItems: string[] = [];
  if (choice.verdict === 'accepted-with-exceptions') {
    const entered = await vscode.window.showInputBox({
      title: 'Unresolved items',
      prompt: 'Required for acceptance with exceptions. Separate items with semicolons.',
      placeHolder: 'Example: add release note; confirm production rollout',
      validateInput: (value) => value.split(';').some((item) => item.trim()) ? undefined : 'Enter at least one unresolved item, or cancel.',
    });
    if (entered === undefined) { return; }
    unresolvedItems = entered.split(';').map((item) => item.trim()).filter(Boolean);
  }
  const now = new Date().toISOString();
  if (!runLedger.recordVerdict({
    runId: run.id,
    verdict: choice.verdict,
    approverId: localApproverIdentity(),
    evidenceReviewedAt: now,
    unresolvedItems,
    recordedAt: now,
  })) {
    void vscode.window.showErrorMessage('UnodeAi could not record that verdict. The run may have changed; reopen the review and try again.');
    return;
  }
  void vscode.window.showInformationMessage(`Recorded human verdict: ${choice.verdict}.`);
}

function defaultJsonUri(fileName: string): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder ? vscode.Uri.joinPath(folder, fileName) : undefined;
}

async function saveJsonPayload(defaultName: string, payload: unknown): Promise<boolean> {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: defaultJsonUri(defaultName),
    filters: JSON_FILTERS,
  });
  if (!uri) {
    return false;
  }
  await fs.writeFile(uri.fsPath, JSON.stringify(payload, null, 2), 'utf8');
  return true;
}

async function saveMarkdownPayload(defaultName: string, content: string): Promise<boolean> {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: defaultJsonUri(defaultName),
    filters: { Markdown: ['md'] },
  });
  if (!uri) {
    return false;
  }
  await fs.writeFile(uri.fsPath, content, 'utf8');
  // Opening what was just written is how a user confirms they got the file they asked for, and it is the
  // step that made the old untitled-document flow feel like it had produced something.
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
  return true;
}

async function readJsonFromDialog(): Promise<string | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: JSON_FILTERS,
  });
  const uri = uris?.[0];
  return uri ? await fs.readFile(uri.fsPath, 'utf8') : undefined;
}

function registerCommands(context: vscode.ExtensionContext) {
  const reg = (cmd: string, handler: (...args: any[]) => any) =>
    registerCommand(context.subscriptions, cmd, handler);

  registerOrchestrationCommands(reg, {
    reviewRun: (runId?: string) => guard(() => reviewRunAcceptance(runId)),
    coordinatorCancelTask: (options?: unknown) => {
      if (!isE2EFixtureRequest(extensionContext?.extensionMode, options)) {
        throw new Error('unode.coordinatorCancelTask runs only in the extension-host E2E (Test mode).');
      }
      return guard(async () => {
        const { e2e: _e2e, coordinatorId, observe, ...toolArgs } =
          options as { e2e: true; coordinatorId?: string; observe?: boolean } & Record<string, unknown>;
        const coordinator = typeof coordinatorId === 'string' ? sessionManager.get(coordinatorId)?.config : undefined;
        if (!coordinator) {
          throw new Error(`No agent ${String(coordinatorId)} on the roster to act as coordinator.`);
        }
        const snapshot = () => sessionManager.getAll().map((session) => ({
          id: session.id,
          name: session.config.name,
          role: session.config.role,
          status: session.status,
        }));
        if (observe === true) {
          return { result: '', agents: snapshot() };
        }
        const result = await orchestrationHost.createCoordinatorTeamTools(coordinator).run('cancel_task', toolArgs);
        return { result, agents: snapshot() };
      });
    },
  });
  reg('unode.applyExecutionHooks', () => guard(() => applyExecutionHooks(context)));

  // Focus the Team VIEW, not just its container. Revealing the container is a no-op when the sidebar is
  // already showing UnodeAi, so "Finish takes you to create a team" was invisible to a user who had opened
  // the panel earlier in setup — the destination has to be observable to be a destination.
  reg('unode.showTeamPanel', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.unode');
    await vscode.commands.executeCommand(`${TeamViewProvider.viewType}.focus`);
  });

  reg('unode.showDashboard', () => guard(async () => {
    if (dashboardPanel) { dashboardPanel.reveal(vscode.ViewColumn.One); await refreshDashboardPanel(); return; }
    const panel = vscode.window.createWebviewPanel(
      'unodeDashboard',
      'UnodeAi Dashboard',
      vscode.ViewColumn.One,
      { enableScripts: false, enableCommandUris: true, retainContextWhenHidden: true }
    );
    dashboardPanel = panel;
    panel.onDidDispose(() => { if (dashboardPanel === panel) { dashboardPanel = undefined; } });
    panel.webview.html = await dashboardProvider.getDashboardHtml(panel.webview);
  }));

  // "Latest tasks" panel N control (command-URI link from the scripts-disabled dashboard). Clamps to a
  // sane range, persists, and re-renders the open dashboard.
  reg('unode.setDashboardTaskCount', (n: unknown) => guard(async () => {
    const parsed = Math.round(Number(n));
    const count = Number.isFinite(parsed) ? Math.min(50, Math.max(1, parsed)) : 5;
    await context.globalState.update('roam.dashboard.recentTaskCount', count);
    await refreshDashboardPanel();
  }));

  // Brand icon in the editor title bar (top-right) opens the UnodeAi Dashboard tab, like the one-click
  // "open in tab" icon Claude/GPT/Kilo place there. The legacy command id stays for existing keybindings.
  reg('unode.openMissionControl', () => vscode.commands.executeCommand('unode.showDashboard'));

  // Evidence Report: turn the crew's recent run into a skimmable "what happened + was it verified"
  // Markdown doc — the verifier-gate made tangible. Gathers delegations (orchestration tracker),
  // changed files (checkpoints), and runs the project's checks for the verdict.
  /**
   * One export entry, because six near-identical titles in the palette produced a real wrong choice.
   *
   * The Owner wanted the run accounting and ran `Generate Evidence Report`, which records file changes and
   * check results and contains no delegation accounting at all. The artifact came back empty and nobody
   * noticed until it was audited. A palette entry has room for a title and nothing else, so six titles
   * beginning "Export…" cannot say what they each produce — a chooser can, and that description is the
   * whole fix. The individual commands stay registered and keybindable; only the ambiguous list is gone.
   */
  reg('unode.export', () => guard(async () => {
    const picked = await vscode.window.showQuickPick([
      {
        label: '$(law) Portable run evidence',
        description: 'JSON, safe to share',
        detail: 'One run: dispatches, decisions, approvals, changed-file paths and usage. Carries no request text, instructions, file contents or absolute paths, and declares what it withheld.',
        command: 'unode.exportPortableRun',
      },
      {
        label: '$(checklist) Run evidence pack',
        description: 'Markdown, internal',
        detail: 'The same run in full, including the request and each task instruction. Keep this one inside the organisation.',
        command: 'unode.exportRun',
      },
      {
        label: '$(output) Evidence report',
        description: 'Markdown, latest run',
        detail: 'Files changed and verification result for the most recent work. No delegation accounting.',
        command: 'unode.generateEvidenceReport',
      },
      {
        label: '$(graph) Worker progress distribution',
        description: 'Markdown, all runs',
        detail: 'Per-cohort duration and no-progress quantiles across recorded worker tasks.',
        command: 'unode.exportWorkerProgress',
      },
      {
        label: '$(comment-discussion) Chat transcript',
        description: 'JSON, selected agent',
        detail: 'The conversation with the currently selected agent.',
        command: 'unode.exportChat',
      },
      {
        label: '$(mail) Message log',
        description: 'JSON, whole team',
        detail: 'The retained team message log, including its truncation metadata.',
        command: 'unode.exportMessages',
      },
    ], {
      title: 'Export from UnodeAi',
      placeHolder: 'Choose what to export — each line says what the file contains',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (picked) {
      await vscode.commands.executeCommand(picked.command);
    }
  }));

  reg('unode.generateEvidenceReport', () => guard(async () => {
    const summaries = orchestrationProgress.snapshot();
    const agents = summaries.flatMap((s) => s.items.map((it) => ({
      agentName: it.agentName,
      task: it.instruction,
      // The report's older work-status vocabulary is intentionally coarse; delegation evidence
      // remains visible in the live cards/tool result, while only a framework error is "blocked".
      status: (it.status === 'working' ? 'working' : it.status === 'blocked' ? 'blocked' : 'done') as EvidenceWorkStatus,
      result: it.result,
    })));
    // Only count files changed DURING this run — the checkpoint store persists ~200 points across
    // sessions, so without a cutoff the report would list files from earlier/older tasks. Use the
    // earliest delegation's start as the boundary; with no delegations, fall back to all (best effort).
    const runStartMs = summaries.length ? Date.parse(summaries[0].startedAt) : NaN;
    const since = Number.isFinite(runStartMs) ? runStartMs : 0;
    const filesChanged = [...new Set(
      checkpointStore.list().filter((c) => (c.ts ?? 0) >= since).map((c) => c.path)
    )];
    if (agents.length === 0 && filesChanged.length === 0) {
      void vscode.window.showInformationMessage('UnodeAi: no recent crew activity to report yet — run a task first.');
      return;
    }
    const cmd = vscode.workspace.getConfiguration('unode').get<string>('verifyCommand', '').trim();
    let checks: EvidenceChecks | undefined;
    let verified = false;
    let blocked = false;
    if (cmd) {
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `UnodeAi: verifying (${cmd})…` },
        () => runVerifyChecks()
      );
      checks = { command: cmd, passed: !!r.ok, outputTail: r.output };
      verified = !!r.ok;
      blocked = !!r.blocked; // verify command blocked by policy → 🚧 Blocked, not silently Unverified
    }
    const md = buildEvidenceReport({
      goal: 'UnodeAi — latest run',
      coordinatorName: summaries.length ? summaries[summaries.length - 1].coordinatorName : undefined,
      agents,
      filesChanged,
      checks,
      verified,
      blocked,
      startedAt: summaries.length ? summaries[0].startedAt : undefined,
      completedAt: summaries.length ? summaries[summaries.length - 1].completedAt : undefined,
    });
    // This used to open an untitled document and stop there. Saving it was then VS Code's untitled flow,
    // which proposes the first line of the file as the name — so the report landed as
    // "# Evidence Report — UnodeAi — latest run.md", a leading "#" that needs escaping in every shell
    // (docs/FINDING_evidence_report_hash_filename.md recorded that and left it). Offering the folder and a
    // plain file name first fixes both: where it goes, and what it is called.
    const saved = await saveMarkdownPayload(`unode-evidence-report-${timestampForFile()}.md`, md);
    if (saved) {
      return;
    }
    // Declining the dialog is not a reason to lose the report — show it unsaved, as before.
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.window.showTextDocument(doc, {
      preview: false,
      viewColumn: vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
    });
  }));

  reg('unode.showMessageLog', () => vscode.commands.executeCommand('unode.activityPanel.focus'));
  reg('unode.showPromptedCommandLog', () => showPromptedCommandLog(context));

  // Team panel compact mode: collapse agents to icon chips to free room for New Task.
  const setTeamCompact = (compact: boolean) => {
    teamViewProvider?.setCompact(compact);
    void vscode.commands.executeCommand('setContext', 'unode.teamCompact', compact);
  };
  reg('unode.collapseTeam', () => setTeamCompact(true));
  reg('unode.expandTeam', () => setTeamCompact(false));

  reg('unode.exportChat', () => guard(async () => {
    const selected = chatViewProvider?.exportSelected();
    if (!selected) {
      vscode.window.showInformationMessage('Select an agent chat first, then export it.');
      return;
    }
    const saved = await saveJsonPayload(
      `unode-chat-${safeFilePart(selected.agent.name)}-${timestampForFile()}.json`,
      createChatExportPayload(selected.agent, selected.messages)
    );
    if (saved) {
      vscode.window.showInformationMessage(`Exported chat with ${selected.agent.name}.`);
    }
  }));

  reg('unode.importChat', () => guard(async () => {
    const who = chatViewProvider?.getSelectedAgentName();
    if (!who) {
      vscode.window.showInformationMessage('Select an agent chat first, then import into it.');
      return;
    }
    const raw = await readJsonFromDialog();
    if (raw === undefined) {
      return;
    }
    const parsed = parseChatImportPayload(raw);
    if (!parsed.ok) {
      vscode.window.showErrorMessage(`Could not import chat: ${parsed.error}`);
      return;
    }
    if (chatViewProvider.hasSelectedMessages()) {
      const REPLACE = 'Replace';
      const choice = await vscode.window.showWarningMessage(
        `Importing this chat will replace the current visible chat with ${who}.`,
        { modal: true },
        REPLACE
      );
      if (choice !== REPLACE) {
        return;
      }
    }
    if (chatViewProvider.importToSelected(parsed.messages)) {
      vscode.window.showInformationMessage(`Imported ${parsed.messages.length} chat message(s) into ${who}.`);
    }
  }));

  reg('unode.exportMessages', () => guard(async () => {
    const snapshot = messageLogProvider?.exportSnapshot() ?? {
      items: [],
      truncation: { occurred: false, droppedItems: 0, retainedItems: 0, limit: 300 },
    };
    const saved = await saveJsonPayload(
      `unode-messages-${timestampForFile()}.json`,
      createMessagesExportPayload(snapshot.items, undefined, snapshot.truncation)
    );
    if (saved) {
      const omitted = snapshot.truncation.droppedItems;
      vscode.window.showInformationMessage(
        omitted > 0
          ? `Exported ${snapshot.items.length} message log item(s); ${omitted} older item(s) were omitted by the ${snapshot.truncation.limit}-item retained window.`
          : `Exported ${snapshot.items.length} message log item(s).`
      );
    }
  }));

  reg('unode.exportRun', () => guard(async () => {
    const runs = runLedger.list();
    if (runs.length === 0) {
      void vscode.window.showInformationMessage('No run has dispatched work yet. A run begins with the coordinator\'s first real delegation.');
      return;
    }
    const selected = await vscode.window.showQuickPick(runs.map((run) => ({
      label: markdownRunExportPickerLabel(run, resolveAgentName(run.coordinatorId)),
      description: new Date(run.startedAt).toLocaleString(),
      detail: run.objective || 'No user request retained before the first dispatch',
      runId: run.id,
    })), {
      title: 'Export one run evidence pack',
      placeHolder: 'Choose the run to export as standalone Markdown',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!selected) {
      return;
    }
    const run = runLedger.get(selected.runId);
    if (!run) {
      void vscode.window.showErrorMessage('The selected run is no longer available.');
      return;
    }
    const saved = await saveMarkdownPayload(
      `unode-run-${safeFilePart(resolveAgentName(run.coordinatorId))}-${timestampForFile()}.md`,
      renderRunEvidencePack(run),
    );
    if (saved) {
      void vscode.window.showInformationMessage(runEvidenceExportConfirmation(run));
    }
  }));

  // Deliberately a SECOND export rather than an option on the first. The evidence pack retains the user's
  // objective and every task instruction and says so; it is an internal record. This one is built to leave
  // the organisation, so it carries no prose at all — see PortableRunEvidence for why that is the rule
  // rather than redaction.
  reg('unode.exportPortableRun', () => guard(async () => {
    const runs = runLedger.list();
    if (runs.length === 0) {
      void vscode.window.showInformationMessage('No run has dispatched work yet. A run begins with the coordinator\'s first real delegation.');
      return;
    }
    const selected = await vscode.window.showQuickPick(runs.map((run) => ({
      label: portableRunExportPickerLabel(run, resolveAgentName(run.coordinatorId)),
      description: new Date(run.startedAt).toLocaleString(),
      runId: run.id,
    })), {
      title: 'Export portable run evidence (no composed prose)',
      placeHolder: 'Choose the run to export as portable JSON',
      matchOnDescription: true,
    });
    if (!selected) {
      return;
    }
    const run = runLedger.get(selected.runId);
    if (!run) {
      void vscode.window.showErrorMessage('The selected run is no longer available.');
      return;
    }
    // The file name is part of what gets shared. Naming it after the coordinator put a configured agent name
    // — a name a person chose, possibly after a client or a deal — on the outside of an artifact whose whole
    // premise is that the inside carries none. The run id says the same thing and says nothing else.
    const saved = await saveJsonPayload(
      `unode-portable-run-${safeFilePart(run.id)}-${timestampForFile()}.json`,
      buildPortableRunEvidence(run, {
        // Resolved from the live roster, and validated against a closed vocabulary inside the builder — so a
        // role that is not one of the shipped names is dropped rather than carried.
        roles: Object.fromEntries(
          sessionManager.getAll().map((session) => [session.config.id, session.config.role]),
        ),
      }),
    );
    if (saved) {
      void vscode.window.showInformationMessage(
        'Exported portable run evidence. No request text, instructions, command lines, file contents, raw '
        + 'approver identities, or private gateway hostnames. It does carry workspace-relative changed paths, '
        + 'timestamps, and validated SHA-256 digests, which its "retained" section declares.'
      );
    }
  }));

  reg('unode.exportWorkerProgress', () => guard(async () => {
    const saved = await saveMarkdownPayload(
      `unode-worker-progress-${timestampForFile()}.md`,
      renderWorkerTaskProgressReport(runLedger.snapshot()),
    );
    if (saved) {
      void vscode.window.showInformationMessage('Exported Phase A worker no-material-progress distribution.');
    }
  }));

  reg('unode.importMessages', () => guard(async () => {
    const raw = await readJsonFromDialog();
    if (raw === undefined) {
      return;
    }
    const parsed = parseMessagesImportPayload(raw);
    if (!parsed.ok) {
      vscode.window.showErrorMessage(`Could not import messages: ${parsed.error}`);
      return;
    }
    if (messageLogProvider?.hasItems()) {
      const REPLACE = 'Replace';
      const choice = await vscode.window.showWarningMessage(
        'Importing messages will replace the current visible team activity feed.',
        { modal: true },
        REPLACE
      );
      if (choice !== REPLACE) {
        return;
      }
    }
    messageLogProvider?.importItems(parsed.messages, parsed.truncation);
    vscode.window.showInformationMessage(
      `Imported ${parsed.messages.length} message(s) into the activity feed for viewing (not restored to history — cleared on reload).`
    );
  }));

  reg('unode.toggleChatCompact', () => {
    const compact = chatViewProvider?.setCompact();
    void vscode.commands.executeCommand('setContext', 'unode.chatCompact', compact === true);
  });

  reg('unode.toggleMessagesCompact', () => {
    const compact = messageLogProvider?.setCompact();
    void vscode.commands.executeCommand('setContext', 'unode.messagesCompact', compact === true);
  });

  // Clear buttons (view title bars) — with a light confirmation noting the consequences.
  // The same action as the composer pill, reachable without it — the pill is absent on a runtime that owns
  // its own context, and a command is the only surface a user can bind a key to.
  reg('unode.compactContext', () => guard(async () => {
    const agentId = chatViewProvider?.getSelectedAgentId();
    const who = chatViewProvider?.getSelectedAgentName();
    if (!agentId || !who) {
      vscode.window.showInformationMessage('Select an agent chat first, then compact its context.');
      return;
    }
    // Same path as the composer button: the transcript shows it running, then the outcome. Without this
    // the palette produced a silent pause and a toast, and the chat showed nothing at all.
    await chatViewProvider?.runCompaction(agentId);
    vscode.window.showInformationMessage(`Compaction finished for ${who}. The result is in the chat transcript.`);
  }));
  reg('unode.clearChat', () => guard(async () => {
    const who = chatViewProvider?.getSelectedAgentName();
    if (!who) {
      vscode.window.showInformationMessage('Select an agent chat first, then clear it.');
      return;
    }
    const CLEAR = 'Clear';
    const choice = await vscode.window.showWarningMessage(
      `Clear the chat with ${who}? This permanently deletes the saved conversation history with this agent. It can't be undone.`,
      { modal: true },
      CLEAR
    );
    if (choice === CLEAR) {
      chatViewProvider?.clearSelectedAgent();
    }
  }));
  reg('unode.archiveChat', () => guard(async () => {
    const who = chatViewProvider?.getSelectedAgentName();
    if (!who) {
      vscode.window.showInformationMessage('Select an agent chat first, then archive it.');
      return;
    }
    const archived = chatViewProvider?.archiveSelectedAgent() ?? 0;
    if (archived === 0) {
      vscode.window.showInformationMessage(`Nothing to archive — the chat with ${who} is empty.`);
      return;
    }
    vscode.window.showInformationMessage(
      `Archived the chat with ${who}. It's hidden but not deleted — restore it via "UnodeAi: View Archived Chats".`
    );
  }));
  reg('unode.viewArchivedChats', () => guard(async () => {
    const archives = chatViewProvider?.listArchivedChats() ?? [];
    if (archives.length === 0) {
      vscode.window.showInformationMessage('No archived chats yet. Use the Archive button in the Chat panel to save one.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      archives.map((a) => ({
        label: a.agentName,
        description: new Date(a.archivedAt).toLocaleString(),
        detail: summarizeArchive(a),
        id: a.id,
        agentId: a.agentId,
      })),
      { placeHolder: 'Restore an archived chat…', matchOnDescription: true, matchOnDetail: true }
    );
    if (!pick) {
      return;
    }
    // Restoring overwrites the agent's current transcript — confirm if there's live content to lose.
    const liveCount = chatViewProvider?.getMessageCount(pick.agentId) ?? 0;
    if (liveCount > 0) {
      const RESTORE = 'Restore';
      const choice = await vscode.window.showWarningMessage(
        `Restore this archived chat into "${pick.label}"? Its current ${liveCount} message(s) will be replaced (archive or clear them first to keep them).`,
        { modal: true },
        RESTORE
      );
      if (choice !== RESTORE) {
        return;
      }
    }
    const result = chatViewProvider?.restoreArchive(pick.id);
    if (!result?.ok) {
      const msg = result?.reason === 'agent-gone'
        ? `Can't restore — "${pick.label}" is no longer in the team. Re-add the agent, then restore.`
        : 'Could not restore that archived chat.';
      vscode.window.showWarningMessage(msg);
      return;
    }
    void vscode.commands.executeCommand('unode.chat.focus').then(undefined, () => { /* view focus is best-effort */ });
    vscode.window.showInformationMessage(`Restored the archived chat with ${pick.label}.`);
  }));
  reg('unode.clearMessageLog', () => guard(async () => {
    const CLEAR = 'Clear';
    const choice = await vscode.window.showWarningMessage(
      "Clear all team messages? This empties the cross-agent activity feed and its saved history. It can't be undone.",
      { modal: true },
      CLEAR
    );
    if (choice === CLEAR) {
      messageBus.clearMessages();
      void persistence.saveMessages([]);
      messageLogProvider?.clear();
    }
  }));

  reg('unode.startAllAgents', () => guard(async () => {
    const result = await sessionManager.startAll();
    vscode.window.showInformationMessage('Starting all UnodeAi agents...');
    return result;
  }));

  reg('unode.stopAllAgents', (options?: unknown) => guard(async () => {
    await sessionManager.stopAll();
    if (!isE2EFixtureRequest(extensionContext?.extensionMode, options)) {
      vscode.window.showInformationMessage('All UnodeAi agents stopped');
    }
    return sessionManager.getAll();
  }));

  reg('unode.openAgentBuilder', (agentId?: string) =>
    guard(async () => {
      if (!agentId) { assertDefaultProviderCanCreateAgents(); }
      return AgentBuilderPanel.createOrShow(context.extensionUri, {
      getViewModel: (id) => agentBuilderViewModel(context.extensionUri, id),
      listModels: (providerId, baseUrl) => agentBuilderListModels(providerId, baseUrl),
      save: (payload) => handleAgentBuilderSave(payload, context.extensionUri),
      pickIcon: () => pickAgentBuilderIcon(),
      pickFolderAccessFolder: () => pickAgentBuilderFolderAccessFolder(),
      resolveFolderAccessIssues: (grants) => resolveAgentBuilderFolderAccessIssues(grants),
      modelParamDefaultLabels: () => modelParamDefaultLabels(makeConfigStore()),
      promptTemplateAction: (id, action) => handlePromptTemplateAction(id, action),
      openSkillLibrary: async () => {
        const DEFAULT_SKILL_LIBRARY_URL = 'https://github.com/UnodeTechxyz/unode-skills';
        const raw = vscode.workspace.getConfiguration('unode').get<string>(
          'marketplace.skillLibraryUrl',
          DEFAULT_SKILL_LIBRARY_URL
        );
        // A workspace can set this link; never hand a raw workspace string straight to openExternal.
        const resolved = resolveHttpsExternalUrl(raw ?? DEFAULT_SKILL_LIBRARY_URL, DEFAULT_SKILL_LIBRARY_URL);
        if (!resolved) {
          void vscode.window.showWarningMessage(
            `UnodeAi did not open the skill library: the configured link is not an https URL (${String(raw)}).`
          );
          return;
        }
        if (!resolved.isDefault) {
          // Off-default and workspace-chosen: name the destination before navigating.
          const choice = await vscode.window.showWarningMessage(
            `Open the skill library at ${resolved.origin}? This link was set by workspace configuration, not by UnodeAi.`,
            'Open',
            'Cancel'
          );
          if (choice !== 'Open') { return; }
        }
        await vscode.env.openExternal(vscode.Uri.parse(resolved.url));
      },
      // Open the MCP Marketplace (its MCP tab) — what users expect from "Browse MCP Marketplace…" in the
      // builder. Installing there registers the server; the builder refreshes its grant list on focus.
      addMcpServer: async () => { await vscode.commands.executeCommand('unode.openMarketplace', 'mcp'); },
      }, typeof agentId === 'string' ? agentId : undefined);
    })
  );

  reg('unode.addMcpServer', () => guard(() => guidedAddMcpServer()));

  reg('unode.addAgent', () => guard(() => {
    assertDefaultProviderCanCreateAgents();
    return dialogs.showAddAgentDialog(dialogDeps());
  }));
  // D1 UI: pick a team preset (software crew or a knowledge-work team) and create it.
  /**
   * Snapshot the roster before anything replaces it.
   *
   * Switching teams removes every session, and everything that made the outgoing crew yours went with it.
   * The user had no way back short of configuring it again by hand.
   *
   * Called once the user has confirmed the replace and before anything is removed. Not earlier: a snapshot
   * written before the confirmation backs up a switch that may never happen, and ten of those would prune a
   * restore point someone actually needs.
   *
   * A snapshot that cannot be written does not block the switch — being unable to back a team up is not a
   * reason to trap someone in it — but it is not swallowed either. The user is told what failed and decides,
   * because "your safety net is gone" is exactly the fact you cannot leave in an output channel. Returns
   * false only when the user answers that they would rather not switch after all.
   */
  async function snapshotRosterBeforeReplace(): Promise<boolean> {
    const members = sessionManager.getAll().map((session) => session.config);
    if (members.length === 0) {
      return true;
    }
    try {
      const savedAt = new Date().toISOString();
      await persistence.saveTeamToLibrary({
        scope: 'workspace',
        slug: automaticSnapshotSlug(new Date(savedAt)),
      },
        `Before switching · ${members.length} agent${members.length === 1 ? '' : 's'}`,
        members,
        savedAt,
      );
      for (const stale of automaticSnapshotsToPrune(await persistence.listSavedTeams())) {
        await persistence.deleteSavedTeam({ scope: 'workspace', slug: stale.slug });
      }
      return true;
    } catch (err) {
      outputChannel.error(`Could not snapshot the current team before replacing it: ${String(err)}`);
      const SWITCH = 'Switch anyway';
      const choice = await vscode.window.showWarningMessage(
        `Could not save a snapshot of the current ${members.length}-agent team, so switching cannot be undone.`,
        { modal: true, detail: String(err) },
        SWITCH,
      );
      return choice === SWITCH;
    }
  }

  /** Replace the live roster with a saved document. The snapshot above has already run. */
  async function restoreTeamMembers(members: readonly AgentConfig[]): Promise<void> {
    for (const session of [...sessionManager.getAll()]) {
      await sessionManager.remove(session.id);
    }
    for (const config of members) {
      sessionManager.create(config);
    }
    await saveRoster();
    teamViewProvider?.refresh();
    chatViewProvider?.refresh?.();
  }

  reg('unode.saveTeam', () => guard(async () => {
    const members = sessionManager.getAll().map((session) => session.config);
    if (members.length === 0) {
      void vscode.window.showInformationMessage('There is no team to save yet. Create or switch to a team first.');
      return;
    }
    const label = (await vscode.window.showInputBox({
      title: 'Save this team',
      prompt: `Name this ${members.length}-agent team so you can bring it back later.`,
      placeHolder: 'Contract review crew',
      validateInput: (value) => teamSlug(value) ? null : 'Enter a name.',
    }))?.trim();
    if (!label) {
      return;
    }
    const slug = teamSlug(label);
    if (!slug) {
      return;
    }
    const scopeChoice = await vscode.window.showQuickPick([
      { label: 'This project', description: 'Save in .unode/teams/ so the project can share it', scope: 'workspace' as const },
      { label: 'All projects', description: 'Save in your personal UnodeAi library', scope: 'global' as const },
    ], { title: 'Where should this team be saved?', placeHolder: 'This project' });
    if (!scopeChoice) return;
    const scope = scopeChoice.scope;
    const existing = (await persistence.listSavedTeams()).find((entry) => entry.scope === scope && entry.slug === slug);
    if (existing) {
      const OVERWRITE = 'Overwrite';
      const choice = await vscode.window.showWarningMessage(
        `A saved team named "${existing.label}" already exists (${describeTeamEntry(existing)}). Overwrite it?`,
        { modal: true },
        OVERWRITE,
      );
      if (choice !== OVERWRITE) {
        return;
      }
    }
    await persistence.saveTeamToLibrary({ scope, slug }, label, members);
    void vscode.window.showInformationMessage(
      scope === 'workspace'
        ? `Saved "${label}" to .unode/teams/${slug}.json. Bring it back with "UnodeAi: Open Saved Team…".`
        : `Saved "${label}" to your personal team library. Bring it back with "UnodeAi: Open Saved Team…".`
    );
  }));

  /**
   * The saved-team picker, with a delete affordance on each row.
   *
   * Deleting lives here rather than behind its own command because this list is the only place a saved team
   * is ever visible: a separate "Delete Saved Team…" would make someone find a second list to act on what
   * they are already looking at. The list rebuilds after a delete instead of closing, since removing two
   * old snapshots is one intention, not two.
   *
   * Resolves to the chosen slug, or undefined if the picker was dismissed — including when it was dismissed
   * after deleting something, which is a completed action and not a cancelled one.
   */
  async function pickSavedTeam(): Promise<TeamLibraryRef | undefined> {
    const DELETE_BUTTON: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('trash'),
      tooltip: 'Delete this saved team',
    };
    type Item = vscode.QuickPickItem & { ref: TeamLibraryRef };

    const toItem = (entry: TeamLibraryEntry): Item => ({
      label: `${entry.automatic ? '$(history)' : '$(organization)'} ${entry.label}`,
      description: `${describeTeamEntry(entry)} · ${entry.scope === 'workspace' ? 'this project' : 'all projects'}`,
      detail: entry.automatic
        ? 'Saved automatically before a team was replaced.'
        : entry.scope === 'workspace' ? `.unode/teams/${entry.slug}.json` : 'Personal team library',
      ref: { scope: entry.scope, slug: entry.slug },
      buttons: [DELETE_BUTTON],
    });

    const picker = vscode.window.createQuickPick<Item>();
    picker.title = 'Open a saved team';
    picker.placeholder = 'The current team is snapshotted before it is replaced';
    picker.matchOnDescription = true;
    picker.items = (await persistence.listSavedTeams()).map(toItem);

    try {
      return await new Promise<TeamLibraryRef | undefined>((resolve) => {
        picker.onDidAccept(() => {
          const ref = picker.selectedItems[0]?.ref;
          picker.hide();
          resolve(ref);
        });
        picker.onDidTriggerItemButton(async (event) => {
          const label = event.item.label.replace(/^\$\([a-z-]+\)\s*/, '');
          // A modal, because this removes a file and there is no undo. The name is in the question so the
          // answer is about the team the user meant, not about whichever row the mouse was over.
          const DELETE = 'Delete';
          const choice = await vscode.window.showWarningMessage(
            `Delete the saved team "${label}"? This cannot be undone.`,
            { modal: true },
            DELETE,
          );
          if (choice !== DELETE) {
            return;
          }
          await persistence.deleteSavedTeam(event.item.ref);
          const remaining = await persistence.listSavedTeams();
          picker.items = remaining.map(toItem);
          if (remaining.length === 0) {
            // Nothing left to open. Leaving an empty list on screen would be a dead end.
            picker.hide();
            resolve(undefined);
          }
        });
        picker.onDidHide(() => resolve(undefined));
        picker.show();
      });
    } finally {
      picker.dispose();
    }
  }

  reg('unode.openSavedTeam', () => guard(async () => {
    if ((await persistence.listSavedTeams()).length === 0) {
      void vscode.window.showInformationMessage(
        'No saved teams yet. Configure a team, then run "UnodeAi: Save Team…" to keep it.'
      );
      return;
    }
    const ref = await pickSavedTeam();
    if (!ref) {
      return;
    }
    // Read the name from the file before anything replaces the roster, so the confirmation quotes what the
    // user typed rather than the slug it was filed under.
    const label = (await persistence.listSavedTeams()).find((entry) => entry.scope === ref.scope && entry.slug === ref.slug)?.label ?? ref.slug;
    const document = await persistence.loadSavedTeam(ref);
    if (!document || document.members.length === 0) {
      void vscode.window.showErrorMessage('That saved team could not be read. It is left on disk unchanged.');
      return;
    }
    // An unsupported field is stripped and warned about rather than rejecting the file. That warning has to
    // reach somebody: `.unode/team.json` surfaces its warnings on load, and this path did not, so the one
    // entrance where a stripped field changes what you are about to be given was the one that said nothing.
    // Asked before the replace, because afterwards the roster it would have described is already gone.
    const warnings = document.validationWarnings ?? [];
    if (warnings.length > 0) {
      const OPEN = 'Open anyway';
      const choice = await vscode.window.showWarningMessage(
        `"${label}" contains ${warnings.length} setting(s) this version does not recognise. They will be `
        + 'ignored, so the restored team may differ from the one that was saved.',
        { modal: true, detail: warnings.slice(0, 10).join('\n') },
        OPEN,
      );
      if (choice !== OPEN) {
        return;
      }
    }
    if (!(await snapshotRosterBeforeReplace())) {
      return;
    }
    await restoreTeamMembers(document.members);
    void vscode.window.showInformationMessage(
      `Opened "${label}" — ${document.members.length} agent(s) restored. `
      + 'The team you were on was saved first.'
    );
  }));

  reg('unode.createTeamPreset', () => guard(async () => {
    assertDefaultProviderCanCreateAgents();
    // The preset switch replaces the roster too, and it is the path users already had. A safety net that
    // only covers the new command would leave the old one exactly as lossy as it was. The dialog calls back
    // at its own destructive boundary rather than here, so cancelling the picker writes nothing.
    const result = await dialogs.createTeamFromPreset({
      ...dialogDeps(),
      beforeReplaceRoster: snapshotRosterBeforeReplace,
    });
    if (result.length && context.extensionMode !== vscode.ExtensionMode.Test) {
      void syncTeamRulesOnRosterChange();
    }
    teamViewProvider?.refresh();
    return result;
  }));
  reg('unode.createDefaultTeam', (options?: unknown) => guard(async () => {
    assertDefaultProviderCanCreateAgents();
    const result = await dialogs.createDefaultTeam(dialogDeps({
      suppressInteractivePostCreatePrompts: isE2EFixtureRequest(extensionContext?.extensionMode, options),
      skipExistingTeamWarning: isE2EFixtureRequest(extensionContext?.extensionMode, options),
      useDefaultConnection: isE2EFixtureRequest(extensionContext?.extensionMode, options),
    }));
    // Prompt for team rules on real user-driven creation only — never in headless e2e (a modal
    // would break the test), and don't block/alter the command's return value (the created agents).
    if (context.extensionMode !== vscode.ExtensionMode.Test) {
      void syncTeamRulesOnRosterChange();
    }
    return result;
  }));
  // Solo / Fast mode (v0.3.0): one generalist agent, the fast path for simple asks.
  // ⚡ toggles between the Solo agent and the team: if you're already viewing Solo, it flips the chat
  // back to the first (team) agent; otherwise it creates/focuses the Solo agent. If Solo is the only
  // agent, it stays on Solo. The toolbar icon is the outline ⚡ normally, solid ⚡ while Solo is selected.
  const soloToggleHandler = () => guard(async () => {
    const agents = sessionManager.getAll();
    const solo = agents.find((s) => s.config.role === 'solo');
    const selected = chatViewProvider?.getSelectedAgentId();
    if (solo && selected === solo.id) {
      const first = agents[0];
      if (first && first.id !== solo.id) {
        chatViewProvider?.selectAgent(first.id);
        await vscode.commands.executeCommand('unode.chatWithAgent', first.id);
        return first.config;
      }
      return solo.config; // Solo is the first/only agent — stay on it
    }
    const config = await dialogs.createSoloAgent(dialogDeps());
    if (!config) { return undefined; } // user cancelled
    teamViewProvider?.refresh();
    chatViewProvider?.refresh();
    syncSoloContext();
    await vscode.commands.executeCommand('unode.chatWithAgent', config.id);
    return config;
  });
  reg('unode.startSolo', soloToggleHandler);
  reg('unode.startSoloActive', soloToggleHandler); // solid-icon variant shown while a Solo agent exists
  reg('unode.editTeamRules', () => guard(() => showTeamRulesMenu()));
  reg('unode.agentStart', (id: string) => guard(() => sessionManager.start(id)));
  reg('unode.agentStop', (id: string) => guard(async () => {
    await sessionManager.stop(id);
    return sessionManager.getAll();
  }));
  reg('unode.agentRestart', (id: string) => guard(() => sessionManager.restart(id)));
  reg('unode.agentRemove', (id: string) => guard(async () => { terminalManager.dispose(id); const r = await sessionManager.remove(id); syncSoloContext(); return r; }));
  // #13 Phase 2: reveal an agent's command terminal (from the Team panel). Creates one on demand
  // so every agent — even a PM that only delegates — has its own visible terminal thread.
  reg('unode.showAgentTerminal', (id: string) => terminalManager.reveal(id, `Unode: ${resolveAgentName(id)}`, workspaceRoot()));
  // V1 Checkpoints: revert a file an agent edited back to a previous version.
  reg('unode.restoreCheckpoint', () => guard(() => restoreCheckpointCommand()));
  reg('unode.showCheckpointDiff', (checkpointId: unknown) => guard(() => showCheckpointDiffCommand(checkpointId)));
  reg('unode.restoreCheckpointById', (checkpointId: unknown) => guard(() => restoreCheckpointByIdCommand(checkpointId)));
  // Two commands rather than one toggle, so the Workbench title bar can show the icon for the action
  // available now (the same idiom as collapse/expand on the Team panel and open/close on the Workbench).
  const setInspectorOpen = async (open: boolean): Promise<void> => {
    chatViewProvider?.setInspectorOpen(open);
    await context.workspaceState.update(WORKBENCH_INSPECTOR_KEY, open);
    await vscode.commands.executeCommand('setContext', 'unode.inspectorOpen', open);
  };
  reg('unode.showWorkbenchInspector', () => guard(() => setInspectorOpen(true)));
  reg('unode.hideWorkbenchInspector', () => guard(() => setInspectorOpen(false)));
  reg('unode.resetWorkspaceState', () => guard(() => resetWorkspaceStateCommand()));

  // F2: one-click guided command-execution enablement
  registerCommand(context.subscriptions, 'unode.enableCommands', async () => {
    const accepted = await promptCommandApproval(commandPolicy.approvalMode);
    if (accepted) {
      const cfg = vscode.workspace.getConfiguration('unode');
      commandPolicy.reload(
        cfg.get<CommandApprovalMode>('commandApproval', 'ask'),
        cfg.get<string[]>('allowedCommands', [])
      );
    }
  });
  reg('unode.agentEdit', (id: string) => guard(() => dialogs.showEditAgentDialog(dialogDeps(), id)));
  reg('unode.showAgentOutput', (id: string) => getAgentChannel(id).show());

  // Flip the concurrency mode from the Team-panel title-bar icon (or command palette). Switching to Worktree
  // on a non-git folder reuses the same git-init / Optimistic prompt agents hit at runtime. The toolbar shows
  // one of two icons gated on the unode.worktreeMode context key (set here + on activation + on config change).
  reg('unode.toggleConcurrencyMode', () => guard(async () => {
    const cfg = vscode.workspace.getConfiguration('unode');
    const next = cfg.get<string>('concurrencyStrategy', 'optimistic') === 'worktree' ? 'optimistic' : 'worktree';
    await cfg.update('concurrencyStrategy', next, vscode.ConfigurationTarget.Workspace);
    syncConcurrencyContext();
    teamViewProvider?.refresh();
    if (next === 'optimistic') {
      void vscode.window.showInformationMessage('UnodeAi: switched to Optimistic mode — agents share this workspace. Applies to each agent’s next turn.');
    } else if (await isWorkspaceGitRepo()) {
      void vscode.window.showInformationMessage('UnodeAi: switched to Worktree mode — each agent gets an isolated git worktree on its next start.');
    } else {
      worktreeGitWarningShown = false; // let the non-git warning surface for this explicit switch
      await warnWorktreeNeedsGit();
    }
  }));
  // The two title-bar icons (Optimistic vs Worktree) both just trigger the toggle; the icon shown indicates
  // the CURRENT mode (see package.json view/title when-clauses on unode.worktreeMode).
  reg('unode.concurrencyMode.optimistic', () => vscode.commands.executeCommand('unode.toggleConcurrencyMode'));
  reg('unode.concurrencyMode.worktree', () => vscode.commands.executeCommand('unode.toggleConcurrencyMode'));

  // The Team title bar pins four icons and this one. A title bar is a fixed-width row: every icon beyond
  // what fits goes into VS Code's own unlabelled "..." overflow, so on a narrow sidebar a long pinned row
  // is the same as no row at all. Everything not pinned lives here instead — named, and always one click
  // deep no matter how thin the sidebar gets.
  reg('unode.teamActions', () => guard(async () => {
    const worktree = vscode.workspace.getConfiguration('unode').get<string>('concurrencyStrategy', 'optimistic') === 'worktree';
    const compact = teamViewProvider?.isCompact() === true;
    const items: Array<vscode.QuickPickItem & { target: string }> = [
      // Collapse/Expand is pinned too, but it is the LAST pinned icon and therefore the first to be pushed
      // into the host overflow on a narrow sidebar. It is listed here so it is never the stranded one.
      compact
        ? { label: '$(expand-all) Expand Team Cards', description: 'Show each session as a row', target: 'unode.expandTeam' }
        : { label: '$(collapse-all) Collapse Team to Icons', description: 'Show the roster as one chip strip', target: 'unode.collapseTeam' },
      { label: '$(person-add) Build an Agent', description: 'Role, model, tools, playbooks, MCP grants', target: 'unode.openAgentBuilder' },
      { label: '$(organization) Create or Switch Team…', description: 'Software crew or knowledge-work team', target: 'unode.createTeamPreset' },
      // Directly under the command that replaces a roster, because that is the moment someone needs to know
      // the roster can be kept. A feature reachable only by typing its exact name into the palette is a
      // feature most people never find.
      { label: '$(save) Save Team…', description: 'Keep this roster under a name you choose', target: 'unode.saveTeam' },
      { label: '$(folder-opened) Open Saved Team…', description: 'Bring back a team you saved earlier', target: 'unode.openSavedTeam' },
      { label: '$(play) Start All Agents', target: 'unode.startAllAgents' },
      { label: '$(debug-stop) Stop All Agents', description: 'End every running turn now — also in the status bar while agents run', target: 'unode.stopAllAgents' },
      { label: '$(law) Edit Team Rules', target: 'unode.editTeamRules' },
      { label: '$(history) Restore File Checkpoint…', target: 'unode.restoreCheckpoint' },
      {
        label: worktree ? '$(git-branch) Concurrency — Worktree' : '$(files) Concurrency — Optimistic',
        description: `Click to switch to ${worktree ? 'Optimistic' : 'Worktree'}`,
        target: 'unode.toggleConcurrencyMode',
      },
      { label: '$(extensions) Marketplace', description: 'Skills, MCP servers and agent packs', target: 'unode.openMarketplace' },
      { label: '$(account) Unode Account / Profile', description: 'Connection status, balance, credits and pricing', target: 'unode.openAccount' },
      { label: '$(shield) Security', target: 'unode.showSecurity' },
      // Settings stays a pinned icon and is deliberately not repeated here — a menu that lists what is
      // already on screen is the sub-panel UX3-R removed. Marketplace lost its pin to Open Workbench and
      // is listed above, because the title bar holds seven icons before the eighth becomes invisible.
      { label: '$(checklist) Generate Evidence Report', target: 'unode.generateEvidenceReport' },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'UnodeAi Team',
      placeHolder: 'Team actions and setup',
      matchOnDescription: true,
    });
    if (picked) {
      await vscode.commands.executeCommand(picked.target);
    }
  }));

  reg('unode.sendMessage', (request?: unknown) => guard(async () => {
    const agents = sessionManager.getAll();
    if (agents.length === 0) {
      vscode.window.showWarningMessage('No agents configured. Add an agent first.');
      return;
    }
    return dialogs.showSendMessageDialog(dialogDeps(), agents.map((a) => a.config), request);
  }));

  reg('unode.openChat', () => guard(async () => {
    if (sessionManager.getAll().length === 0) {
      const pick = await vscode.window.showInformationMessage(
        'No agents yet. Create a team first?', 'Create Team'
      );
      if (pick === 'Create Team') {
        await vscode.commands.executeCommand('unode.createTeamPreset');
      }
      if (sessionManager.getAll().length === 0) {
        return;
      }
    }
    chatViewProvider.refresh();
    if (vscode.workspace.getConfiguration('unode').get<boolean>('workbench.autoOpen', true)) {
      chatViewProvider.openWorkbench(false);
    } else {
      await vscode.commands.executeCommand('unode.chat.focus');
    }
  }));

  reg('unode.chatWithAgent', (agentId: string) => guard(async () => {
    if (typeof agentId === 'string') {
      chatViewProvider.selectAgent(agentId);
      syncSoloContext();
    }
    if (vscode.workspace.getConfiguration('unode').get<boolean>('workbench.autoOpen', true)) {
      chatViewProvider.openWorkbench(false);
    } else {
      await vscode.commands.executeCommand('unode.chat.focus');
    }
  }));
  // The roster's double-click is an explicit navigation action. It deliberately bypasses the
  // single-click auto-open preference while retaining the same selected-agent state.
  reg('unode.openAgentWorkbench', (agentId: string) => guard(async () => {
    if (typeof agentId !== 'string') {
      return;
    }
    chatViewProvider.selectAgent(agentId);
    syncSoloContext();
    chatViewProvider.openWorkbench(false);
  }));

  reg('unode.openWorkbench', () => {
    chatViewProvider.refresh();
    chatViewProvider.openWorkbench(false);
  });
  reg('unode.closeWorkbench', () => chatViewProvider.closeWorkbench());
  reg('unode.toggleWorkbenchComposerFocus', () => chatViewProvider.toggleWorkbenchComposerFocus());
  reg('unode.focusPendingApproval', (agentId?: string) => chatViewProvider.focusPendingApproval(
    typeof agentId === 'string' ? agentId : undefined,
  ));

  reg('unode.runWorkflow', () => guard(() => dialogs.showRunWorkflowDialog(dialogDeps())));
  reg('unode.editWorkflow', () => guard(() =>
    WorkflowEditor.createOrShow(context.extensionUri, {
      listWorkflows: () => workflowEngine.listWorkflows(),
      listAgents: () => sessionManager.getAll().map((session) => ({
        id: session.config.id,
        name: session.config.name,
        role: session.config.role,
      })),
      saveWorkflow: (workflow) => workflowEngine.saveWorkflow(workflow),
      deleteWorkflow: (id) => workflowEngine.deleteWorkflow(id),
    })
  ));
  reg('unode.setApiKey', (options?: unknown) => guard(async () => {
    if (isE2EFixtureRequest(extensionContext?.extensionMode, options)) {
      const action = decideFixtureApiKeyAction({
        clearRequested: (options as { clear?: unknown }).clear === true,
        keyExists: await secrets.has('UNODE_API_KEY'),
        createdByFixture: e2eFixtureCreatedApiKey,
      });
      if (action === 'create') {
        await secrets.set('UNODE_API_KEY', 'sk-e2e-offline');
        e2eFixtureCreatedApiKey = true;
      } else if (action === 'remove') {
        await secrets.delete('UNODE_API_KEY');
        e2eFixtureCreatedApiKey = false;
      }
      // Safe to expose only in Test mode; it proves fixture setup without exposing a secret value.
      return action;
    }
    await dialogs.showSetApiKeyDialog(dialogDeps());
  }));

  reg('unode.onboarding', (options?: unknown) => guard(async () => {
    if (isOnboardingCompleteRequest(options)) {
      // Programmatic/test completion hook: just set the flag (no UI). The command-execution prompt
      // belongs to the real wizard "Finish" (onboardingDeps().complete()), not this hook.
      await context.workspaceState.update('roam.onboardingComplete', true);
      return context.workspaceState.get<boolean>('roam.onboardingComplete', false);
    }
    OnboardingWizard.createOrShow(context.extensionUri, onboardingDeps(context));
    return true;
  }));

  reg('unode.runDemoTask', (taskId?: string) => guard(() => runDemoTask(taskId)));

  // The explicit "I want live prices now" path. Everything else that fetches prices is either background
  // (silent, approved hosts only) or incidental to another action; this is the one the user can reach on
  // purpose, and it reports what actually happened instead of failing quietly.
  reg('unode.refreshPrices', () => guard(async () => {
    await repairPriceMultipliersAfterUserAction('Refresh model prices');
    await refreshPrices({ interactive: true });
    const live = (await pricingSources()).filter((s) => hasMetadataConsent(hostOf(s.url)));
    void vscode.window.showInformationMessage(
      live.length > 0
        ? `Live prices refreshed from ${live.map((s) => hostOf(s.url)).join(', ')}.`
        : 'No gateway is approved for price lookups, so UnodeAi is using its built-in price table. '
          + 'Approve a gateway when asked, or run an agent turn, to see your account\'s discounted prices.'
    );
  }));

  reg('unode.showSecurity', () =>
    SecurityPanel.createOrShow({
      displayNameForProviderId: (providerId) => displayNameForProviderId(providerId, effectiveConnectionRegistry),
      getState: async () => {
        const cfg = vscode.workspace.getConfiguration('unode');
        const folders = vscode.workspace.workspaceFolders ?? [];
        return {
          workspaceTrusted: vscode.workspace.isTrusted,
          virtualWorkspace: folders.length > 0 && folders.every((f) => f.uri.scheme !== 'file'),
          commandApproval: cfg.get<string>('commandApproval', 'ask'),
          writeApproval: cfg.get<string>('writeApproval', 'none'),
          concurrencyStrategy: cfg.get<string>('concurrencyStrategy', 'optimistic'),
          fetchCatalog: cfg.get<boolean>('marketplace.fetchCatalog', false),
          // The EFFECTIVE state, not the setting: with no bundled signing key the catalog is never fetched,
          // however the setting reads. Rendering this pure function's answer keeps the panel honest, and
          // computing it never triggers a fetch (the hosted catalog stays lazy).
          catalogStatus: describeHostedCatalogStatus({
            enabled: cfg.get<boolean>('marketplace.fetchCatalog', false),
            url: cfg.get<string>('marketplace.catalogUrl', ''),
            publicKeyPem: CATALOG_PUBLIC_KEY_PEM,
            outcome: lastHostedCatalogOutcome(),
          }),
          egressGrants: consentGrants.list('model'),
          metadataGrants: consentGrants.list('metadata'),
          mediaGrants: consentGrants.list('media'),
          mcpServers: mcpHub.listServers(),
          agents: sessionManager.getAll().map((session) => ({
            id: session.config.id,
            name: session.config.name,
            backend: session.config.backend ?? defaultBackendKind(session.config, effectiveConnectionRegistry),
            folderAccess: session.config.folderAccess ?? [],
            mcpServers: session.config.mcpServers ?? [],
          })),
          providers: (await settingsBridge.getProviderStatuses()).map((p) => ({ providerId: p.providerId, hasApiKey: p.hasApiKey })),
        };
      },
      revokeEgressHost: (host, kind, mediaKind) => revokeEgressConsent(host, kind, mediaKind),
      openSettings: () => vscode.commands.executeCommand('unode.openSettings'),
    }));

  reg('unode.openSettings', async (tab?: unknown) => {
    await repairPriceMultipliersAfterUserAction('Settings');
    SettingsPanel.createOrShow(context.extensionUri, {
      displayNameForProviderId: (providerId) => displayNameForProviderId(providerId, effectiveConnectionRegistry),
      bridge: settingsBridge,
      promptAndStoreSecret: (secretName) => dialogs.promptAndStoreProviderKey(dialogDeps(), secretName),
      addCustomGateway: () => guard(addCustomGateway).then(() => undefined),
      editCustomGateway: (connectionId) => guard(() => editCustomGateway(connectionId)).then(() => undefined),
      renameCustomGateway: (connectionId) => guard(() => renameCustomGateway(connectionId)).then(() => undefined),
      updateCustomGatewayEndpoint: (connectionId) => guard(() => updateCustomGatewayEndpoint(connectionId)).then(() => undefined),
      replaceCustomGatewayKey: (connectionId) => guard(() => replaceCustomGatewayKey(connectionId)).then(() => undefined),
      clearCustomGatewayKey: (connectionId) => guard(() => clearCustomGatewayKey(connectionId)).then(() => undefined),
      testConnection: (connectionId) => guard(() => testConnection(connectionId)).then(() => undefined),
      archiveCustomGateway: (connectionId) => guard(() => archiveCustomGateway(connectionId)).then(() => undefined),
      openConnectionSetup,
      openTeamFile: () => guard(openTeamFile),
      resetWorkspace: () => vscode.commands.executeCommand('unode.resetWorkspaceState'),
      listAgentTunings: () =>
        sessionManager.getAll().map((s) => ({
          id: s.config.id,
          name: s.config.name,
          role: s.config.role,
          providerId: s.config.provider?.providerId ?? '',
          backend: s.config.backend ?? defaultBackendKind(s.config, effectiveConnectionRegistry),
          model: s.config.model,
          modelParams: s.config.modelParams,
          allowedModelParamKeys: [...(connectionProfileForAgent(s.config, effectiveConnectionRegistry)?.capabilities.modelParams ?? [])],
          contextWindowTokens: s.config.contextWindowTokens,
          capabilityProfile: sessionManager.getBackend(s.id) instanceof OpenAICompatBackend
            ? (sessionManager.getBackend(s.id) as OpenAICompatBackend).getCapabilityProfile()
            : capabilityProfileForAgent(s.config),
        })),
      setAgentTuning: async (id, modelParams, contextWindowTokens, removeLegacyModelParams) => {
        const info = sessionManager.get(id);

        if (!info) {
          return;
        }
        const profile = connectionProfileForAgent(info.config, effectiveConnectionRegistry);
        if (!profile) {
          throw new Error(`Unknown connection "${info.config.provider.providerId}".`);
        }
        const requestedUnsupported = unsupportedModelParamKeys(profile.capabilities, modelParams);
        if (requestedUnsupported.length > 0) {
          throw new Error(`${profile.presentation.displayName} does not accept: ${requestedUnsupported.join(', ')}. No settings were changed.`);
        }
        // Legacy values may have been saved before this route acquired its allowlist. Preserve them
        // until the user explicitly checks the removal control; regardless, resolveRouteModelParams
        // prevents them from reaching a backend that would ignore them.
        const legacy = removeLegacyModelParams
          ? {}
          : Object.fromEntries(
            Object.entries(info.config.modelParams ?? {}).filter(([key]) => !profile.capabilities.modelParams.has(key))
          );
        // Applies on the agent's next turn (openai-compat reads config each request via the resolver);
        // contextWindowTokens is read when the backend starts, so it takes effect on next start.
        const merged = { ...legacy, ...modelParams } as AgentModelParams;
        info.config.modelParams = Object.keys(merged).length > 0 ? merged : undefined;
        const measurement = info.config.measuredContextWindow;
        if (
          contextWindowTokens !== undefined
          && measurement?.model === info.config.model
          && measurement.tokens !== contextWindowTokens
        ) {
          void vscode.window.showWarningMessage(
            `Kept your explicit ${contextWindowTokens.toLocaleString()}-token context window; `
            + `${profile.presentation.displayName} reported ${measurement.tokens.toLocaleString()} via ${measurement.field}.`,
          );
        }
        info.config.contextWindowTokens = contextWindowTokens;
        await saveRoster();
        teamViewProvider?.refresh();
      },
      getSmartMode: () => {
        const sm = readSmartMode();
        const tiers = resolveModelTiers(
          vscode.workspace.getConfiguration('unode').get<Partial<Record<ModelTier, Record<string, string>>>>('modelTiers', {})
        );
        const providerIds = Array.from(new Set([
          ...Object.keys(tiers.premium),
          ...sessionManager.getAll().map((s) => s.config.provider.providerId),
        ]));
        return {
          enabled: sm.enabled,
          defaultTier: sm.defaultTier,
          roleTiers: sm.roleTiers ?? {},
          taskTierHints: sm.taskTierHints ?? {},
          modelTiers: tiers,
          providerIds,
        };
      },
      updateSmartMode: async (patch) => {
        const cfg = makeConfigStore();
        switch (patch.kind) {
          case 'enabled':
            await cfg.update('smartMode.enabled', patch.value);
            break;
          case 'defaultTier':
            await cfg.update('smartMode.defaultTier', patch.value);
            break;
          case 'roleTier': {
            const rt: Record<string, ModelTier> = { ...readSmartMode().roleTiers };
            if (patch.value) {
              rt[patch.role] = patch.value;
            } else {
              delete rt[patch.role];
            }
            await cfg.update('smartMode.roleTiers', rt);
            break;
          }
          case 'modelTierCell': {
            // Store only deltas in unode.modelTiers so future default changes still flow through.
            const raw = vscode.workspace.getConfiguration('unode').get<Record<string, Record<string, string>>>('modelTiers', {});
            const next: Record<string, Record<string, string>> = { ...raw, [patch.tier]: { ...(raw[patch.tier] ?? {}) } };
            if (patch.value) {
              next[patch.tier][patch.provider] = patch.value;
            } else {
              delete next[patch.tier][patch.provider];
            }
            await cfg.update('modelTiers', next);
            break;
          }
          case 'taskTierHints':
            await cfg.update('smartMode.taskTierHints', patch.value);
            break;
        }
      },
      modelParamDefaultLabels: () => modelParamDefaultLabels(makeConfigStore()),
      // Reuse the Agent Builder's live model source so the tier-matrix datalists suggest each provider's real ids.
      listModels: (providerId, baseUrl) => agentBuilderListModels(providerId, baseUrl),
      // 0.9.8: live balance for ANY provider's Providers-tab card. Read host-side with that provider's stored
      // key (never sent to the webview); only the computed numbers + threshold cross the boundary. The billing
      // endpoint is new-api-style, so Roam/Unode (and custom new-api gateways) return a figure and others
      // (OpenAI/Anthropic/OpenRouter) just resolve to undefined → the card shows nothing.
      getProviderBalance: async (providerId: string) => {
        const connectionId = connectionIdForProviderId(providerId, effectiveConnectionRegistry);
        const provider = connectionId ? connectionProfile(connectionId, effectiveConnectionRegistry) : undefined;
        if (!provider || !provider.presentation.balanceAvailable || !provider.apiKeySecretName) { return undefined; }
        const apiKey = await secrets.get(provider.apiKeySecretName);
        if (!apiKey) { return undefined; }
        const base = providerEndpoint(providerId);
        if (!base) { return undefined; }
        // Same rule as the price refresh: a balance lookup rides on an approved host, it never opens one.
        // A stored key is NOT consent to contact the host — the user may have pasted it and not yet run a
        // turn. This path renders a whole tab of provider cards, so it must not prompt (that would be one
        // modal per provider on tab open); the card simply shows nothing until the gateway is approved for
        // model traffic or the user fetches prices from it. (See hasMetadataConsent.)
        if (consentedSources([{ url: base }], hasMetadataConsent).allowed.length === 0) { return undefined; }
        const { balance: info, cacheState } = await getBalanceService().fetchBalanceDetailed(base, apiKey, {
          scope: connectionId ?? providerId,
        });
        if (!info) { return undefined; }
        if (cacheState === 'stale') {
          outputChannel.warn(`Balance for ${providerId} could not be refreshed; displaying the previous, stale result.`);
        }
        const thresholdUsd = vscode.workspace.getConfiguration('unode').get<number>('lowBalanceThresholdUsd', 5);
        return { ...info, thresholdUsd };
      },
      getDefaultProvider: resolveDefaultProvider,
      setDefaultProvider: async (providerId: string) => {
        const connectionId = connectionIdForProviderId(providerId, effectiveConnectionRegistry);
        const profile = connectionId ? connectionProfile(connectionId, effectiveConnectionRegistry) : undefined;
        if (!profile || profile.availability !== 'available') {
          throw new Error(profile?.availabilityMessage ?? `Unsupported default connection: ${providerId}.`);
        }
        await makeConfigStore().update('defaultProvider', connectionId);
      },
    }, tab === 'account' ? 'account' : 'providers');
  });

  // Account work stays in the Settings panel (not another Team title-bar icon). The Account tab itself
  // contains only host-owned browser routes and status derived from SecretStorage/metadata consent.
  reg('unode.openAccount', () => vscode.commands.executeCommand('unode.openSettings', 'account'));

  reg('unode.openMarketplace', (tab?: unknown) =>
    MarketplacePanel.createOrShow(
      context.extensionUri,
      (action) => handleMarketplaceInstall(action, context.extensionUri),
      asMarketplaceTab(tab)
    )
  );

  // Worktree fan-out: the "approve" action — merge the integration branch (all agents' reviewed work)
  // into your branch and refresh the checkout.
  reg('unode.worktree.finalize', () => guard(async () => {
    if (!worktreeCoordinator) { return; }
    const review = await gatherWorktreeReview();
    const r = await worktreeCoordinator.finalize(review.base);
    const msg =
      r.status === 'merged' ? `Merged the team's worktree work into ${r.branch}.`
      : r.status === 'nothing' ? 'Nothing to finalize — no new worktree work on the integration branch.'
      : r.status === 'conflict' ? `Finalize conflicted on: ${(r.conflictedFiles ?? []).join(', ')}. Resolve in the integration branch, then retry.`
      : `Finalize failed: ${r.message}`;
    void vscode.window.showInformationMessage(`UnodeAi: ${msg}`);
  }));

  // Worktree fan-out: the review board — each agent's isolation lane + what's staged on integration,
  // with a Finalize → your branch button.
  reg('unode.openWorktreeReview', () => WorktreePanel.createOrShow(
    context.extensionUri,
    gatherWorktreeReview,
    async () => {
      const review = await gatherWorktreeReview();
      const r = await worktreeCoordinator?.finalize(review.base);
      if (!r) { return { ok: false, message: 'Worktree mode is not active.' }; }
      const message =
        r.status === 'merged' ? `Merged the crew's work into ${r.branch}.`
        : r.status === 'nothing' ? 'Nothing to finalize yet.'
        : r.status === 'conflict' ? `Conflict on: ${(r.conflictedFiles ?? []).join(', ')} — resolve on the integration branch, then retry.`
        : `Finalize failed: ${r.message}`;
      return { ok: r.status === 'merged' || r.status === 'nothing', message };
    },
    // A2 lane actions use stable agentId; display names are not unique and can change mid-review.
    async (action) => {
      const wt = (worktreeCoordinator?.active() ?? []).find(
        (w) => w.agentId === action.agentId
      );
      if (!wt || !wt.agentId) {
        void vscode.window.showWarningMessage(`UnodeAi: that lane (${action.agentId}) is no longer active.`);
        return;
      }
      const agentName = sessionManager.get(wt.agentId)?.config.name ?? wt.agentId;
      if (action.command === 'openLaneDiff') {
        // The native diff editor compares two files, so a lane-level request resolves to a file
        // first. That is a better answer than the flat dump it replaces: one file at a time, each
        // navigable and editable, instead of a scratch buffer you can only read.
        const file = action.file ?? await pickLaneFile(wt.path, agentName);
        if (!file) {
          return;
        }
        // Pin the base to a COMMIT here, at open time. Resolving a branch name later would let the
        // left-hand side move under an open tab, and VS Code caches virtual documents per URI, so
        // the same tab could also be re-served stale content with no way to tell which base it shows.
        const baseSha = await resolveBaseSha();
        if (!baseSha) {
          void vscode.window.showWarningMessage('UnodeAi: could not resolve the base commit for this lane.');
          return;
        }
        const base = laneBaseRef({ baseSha, file });
        await vscode.commands.executeCommand(
          'vscode.diff',
          vscode.Uri.from({ scheme: LANE_BASE_SCHEME, path: `/${base.path}`, query: base.query }),
          vscode.Uri.file(path.join(wt.path, file)),
          laneDiffTitle(file, agentName, baseSha),
          { preview: false, viewColumn: vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One },
        );
        return;
      }
      if (action.command === 'reverifyLane') {
        const r = await worktreeCoordinator?.reverify(wt.agentId);
        void vscode.window.showInformationMessage(
          r ? `Re-verified ${agentName}: ${r.status}.` : 'Verification is not configured for this workspace.'
        );
        await refreshWorktreePanel();
        return;
      }
      // handBackLane: send the agent back to finish its worktree (its branch stays intact).
      messageBus.send('user', wt.agentId, 'ask.question', {
        instruction:
          `Please return to your worktree (${wt.branch}) and finish the task: review your changes, run ` +
          `the project's checks, fix anything failing, and complete the work. Your branch is intact.`,
        mode: 'act',
      }, 'normal');
      void vscode.window.showInformationMessage(`Handed the lane back to ${agentName}.`);
    }
  ));

}

async function guidedAddMcpServer(): Promise<void> {
  const start = await vscode.window.showQuickPick(
    [
      { label: '$(server) Add with guided form', action: 'guided' as const },
      { label: '$(json) Open .unode/team.json instead', action: 'open' as const },
    ],
    { title: 'Add MCP Server', placeHolder: 'Use the guided form or edit the team file directly' }
  );
  if (!start) {
    return;
  }
  if (start.action === 'open') {
    await openTeamFile();
    return;
  }

  const name = await vscode.window.showInputBox({
    title: 'Add MCP Server: Name',
    prompt: 'Enter a display name for this MCP server.',
    placeHolder: 'GitHub MCP',
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? null : 'Enter a server name.',
  });
  if (name === undefined) {
    return;
  }

  const transportPick = await vscode.window.showQuickPick(
    [
      { label: 'stdio', description: 'Run a local MCP command', transport: 'stdio' as const },
      { label: 'streamable-http', description: 'Connect to an HTTP MCP endpoint', transport: 'streamable-http' as const },
      { label: 'sse', description: 'Connect to an SSE MCP endpoint', transport: 'sse' as const },
      { label: '$(json) Open .unode/team.json instead', description: 'Edit the raw team file', transport: undefined },
    ],
    { title: 'Add MCP Server: Transport', placeHolder: 'Choose how UnodeAi connects to this server' }
  );
  if (!transportPick) {
    return;
  }
  if (!transportPick.transport) {
    await openTeamFile();
    return;
  }
  const transport: GuidedMcpTransport = transportPick.transport;

  let command: string | undefined;
  let args: string[] | undefined;
  let url: string | undefined;
  if (transport === 'stdio') {
    command = await vscode.window.showInputBox({
      title: 'Add MCP Server: Command',
      prompt: 'Enter the command that starts the MCP server.',
      placeHolder: 'npx',
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? null : 'Enter a command.',
    });
    if (command === undefined) {
      return;
    }
    const rawArgs = await vscode.window.showInputBox({
      title: 'Add MCP Server: Arguments',
      prompt: 'Optional: enter command arguments separated by spaces.',
      placeHolder: '-y @modelcontextprotocol/server-filesystem ${WORKDIR}',
      ignoreFocusOut: true,
    });
    if (rawArgs === undefined) {
      return;
    }
    args = parseMcpArgs(rawArgs);
  } else {
    url = await vscode.window.showInputBox({
      title: 'Add MCP Server: Endpoint',
      prompt: 'Enter the MCP endpoint URL.',
      placeHolder: 'https://example.com/mcp',
      ignoreFocusOut: true,
      validateInput: (value) => isValidMcpUrl(value) ? null : 'Use a valid http:// or https:// URL.',
    });
    if (url === undefined) {
      return;
    }
  }

  const rawEnv = await vscode.window.showInputBox({
    title: 'Add MCP Server: Environment',
    prompt: 'Optional: KEY=${VAR} placeholders only. Separate multiple entries with commas or semicolons.',
    placeHolder: 'GITHUB_TOKEN=${GITHUB_TOKEN}',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const parsed = parseMcpEnvInput(value);
      return parsed.ok ? null : parsed.error;
    },
  });
  if (rawEnv === undefined) {
    return;
  }
  const parsedEnv = parseMcpEnvInput(rawEnv);
  if (!parsedEnv.ok) {
    vscode.window.showErrorMessage(`UnodeAi: ${parsedEnv.error}`);
    return;
  }

  const approvalPick = await vscode.window.showQuickPick(
    [
      { label: 'Yes, require approval', description: 'Recommended for local commands, network, files, and credentials', requiresApproval: true },
      { label: 'No', description: 'Mount without the sensitive-server approval prompt', requiresApproval: false },
    ],
    { title: 'Add MCP Server: Approval', placeHolder: 'Should this server require approval before mounting?' }
  );
  if (!approvalPick) {
    return;
  }

  const entry: McpCatalogEntry = {
    id: userMcpServerId(name),
    name: name.trim(),
    summary: 'User-added MCP server.',
    transport,
    command: command?.trim() || undefined,
    args,
    url: url?.trim() || undefined,
    env: parsedEnv.env,
    requiresApproval: approvalPick.requiresApproval,
  };
  const cfg = toMcpServerConfig(entry);
  mcpRegistry.set(cfg.id, cfg);
  await persistMcpServerToTeamFile(cfg);
  const res = mcpMountMessage(cfg.name, await mountMcpServer(cfg));
  if (res.ok) { vscode.window.showInformationMessage(`UnodeAi: ${res.message}`); }
  else { vscode.window.showWarningMessage(`UnodeAi: ${res.message}`); }
}

function userMcpServerId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server';
  return `user-${slug}-${Date.now().toString(36)}`;
}

/** Open (creating if needed) the versionable .unode/team.json. */
async function openTeamFile(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage('Open a workspace folder to use .unode/team.json.');
    return;
  }
  const uri = vscode.Uri.joinPath(folder.uri, '.unode', 'team.json');
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    const seed = Buffer.from(JSON.stringify({ version: '1.0', members: [], mcpServers: [] }, null, 2), 'utf8');
    await vscode.workspace.fs.writeFile(uri, seed);
  }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
    preview: false,
    viewColumn: vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
  });
}

async function guard<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.error(msg);
    vscode.window.showErrorMessage(`UnodeAi: ${msg}`);
    return undefined;
  }
}

function onboardingDeps(context: vscode.ExtensionContext) {
  return {
    // The wizard supplies only a registry connection id. Credentials and defaults are resolved here,
    // never by browser-provided provider/auth strings.
    getCurrentConnectionId: () => connectionIdForProviderId(resolveDefaultProvider(), effectiveConnectionRegistry) ?? 'unode',
    saveProvider: async (connectionId: string, apiKey: string | undefined) => {
      const store = makeConfigStore();
      const profile = connectionProfile(connectionId, effectiveConnectionRegistry);
      if (!profile) {
        throw new Error(`Unsupported connection: ${connectionId}.`);
      }
      if (profile.availability !== 'available') {
        throw new Error(profile.availabilityMessage ?? `${profile.presentation.displayName} is not available in this release.`);
      }
      const legacyProviderId = legacyProviderIdForConnectionId(profile.id, effectiveConnectionRegistry);
      if (!legacyProviderId) {
        throw new Error(`Connection ${connectionId} has no supported runtime adapter.`);
      }
      if (profile.authKind !== 'api-key') {
        await store.update('defaultProvider', profile.id);
        return;
      }
      if (profile.id.startsWith('custom:')) {
        if (apiKey) {
          throw new Error('Manage custom gateway endpoint and key from Settings > Providers.');
        }
        await store.update('defaultProvider', profile.id);
        return;
      }
      await store.update('defaultProvider', profile.id);
      if (apiKey && profile.apiKeySecretName) {
        await persistUserInitiatedProviderKey({
          secretName: profile.apiKeySecretName,
          value: apiKey,
          connectionId: profile.id,
          storeSecret: () => secrets.set(profile.apiKeySecretName!, apiKey),
        });
      }
    },
    createQuickStartTeam: async () => {
      // D1: the Team door now offers a preset picker (software crew or a knowledge-work team).
      // The command returns the created configs; the count is the wizard's ground truth. A dismissed
      // picker returns [] — and the wizard must say so instead of announcing a team that isn't there.
      const result = await vscode.commands.executeCommand('unode.createTeamPreset');
      return Array.isArray(result) ? result.length : 0;
    },
    createSolo: async () => {
      // Returns the Solo config when one is ready (created or already present); undefined on cancel.
      const config = await vscode.commands.executeCommand('unode.startSolo');
      return !!config;
    },
    createCustomAgent: async () => {
      await vscode.commands.executeCommand('unode.addAgent');
    },
    runDemoTask,
    complete: async () => {
      await context.workspaceState.update('roam.onboardingComplete', true);
      // When the user finishes the real wizard, offer to enable command execution (F2).
      await vscode.commands.executeCommand('unode.enableCommands');
      // Finish is a human action, so this navigation may reveal a surface. Do not send a new user
      // with no team into an empty Workbench: the Team panel owns the one clear create-team action.
      // With a team, reuse openChat so the user's workbench.autoOpen preference remains authoritative.
      if (firstRunDestination(sessionManager.getAll().length) === 'team-panel') {
        await vscode.commands.executeCommand('unode.showTeamPanel');
      } else {
        await vscode.commands.executeCommand('unode.openChat');
      }
    },
    openCommand: async (command: string) => {
      await vscode.commands.executeCommand(command);
    },
    openExternal: async (href: string) => {
      await vscode.env.openExternal(vscode.Uri.parse(href));
    },
    openConnectionSetup: async (connectionId: string) => openConnectionSetup(connectionId),
    addCustomGateway: () => guard(addCustomGateway),
    connectionResolver: () => effectiveConnectionRegistry,
    demoTasks: DEMO_TASKS,
  };
}

async function runDemoTask(taskId?: string): Promise<void> {
  let task = typeof taskId === 'string' ? DEMO_TASKS.find((t) => t.id === taskId) : undefined;
  if (!task) {
    const pick = await vscode.window.showQuickPick(
      DEMO_TASKS.map((t) => ({
        label: t.title,
        description: t.description,
        detail: t.expectedOutcome,
        id: t.id,
      })),
      { title: 'UnodeAi: Run Demo Task', placeHolder: 'Choose a demo task to send to the Project Manager' }
    );
    if (!pick) {
      return;
    }
    task = DEMO_TASKS.find((t) => t.id === pick.id);
  }
  if (!task) {
    return;
  }

  const sessions = sessionManager.getAll();
  if (sessions.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'No agents yet. Run the Setup Wizard first?', 'Run Setup Wizard'
    );
    if (choice === 'Run Setup Wizard') {
      await vscode.commands.executeCommand('unode.onboarding');
    }
    return;
  }

  let pm = sessions.find((s) => s.config.role === 'pm');
  if (!pm) {
    const choice = await vscode.window.showInformationMessage(
      'No Project Manager found. Create a team?', 'Create Team'
    );
    if (choice === 'Create Team') {
      await vscode.commands.executeCommand('unode.createTeamPreset');
      pm = sessionManager.getAll().find((s) => s.config.role === 'pm');
    }
  }
  if (!pm) {
    return;
  }

  messageBus.send('user', pm.config.id, 'task.assign', { instruction: task.prompt, files: [] }, 'normal');
  outputChannel.info(`Demo task sent to ${pm.config.name}: ${task.title}`);
  vscode.window.showInformationMessage(`Sent "${task.title}" to ${pm.config.name}.`);
}

function isOnboardingCompleteRequest(value: unknown): value is { completeImmediately: true } {
  return !!value && typeof value === 'object' && (value as { completeImmediately?: unknown }).completeImmediately === true;
}

// ─── Dialogs ──────────────────────────────────────────────────────────

async function handleCredentialChanged(secretName: string, connectionId?: string): Promise<void> {
  // A replaced key makes both derived tables wrong at once. Drop the catalogue outright rather than
  // waiting out its TTL, and re-fetch prices scoped to the connection whose credential just changed.
  modelCatalog?.clearCache();
  const owner = effectiveConnectionRegistry.profiles.find((profile) => profile.apiKeySecretName === secretName);
  await refreshPrices({ scope: connectionId ?? owner?.id });
  SettingsPanel.refreshCurrent();
  AgentBuilderPanel.refreshCurrent();
}

type StoredUserProviderKey = Omit<
  UserInitiatedProviderKeyStoreInput,
  'promptForPriceMultiplier' | 'onCredentialChanged'
>;

/**
 * The production implementation of the single provider-key write boundary.  Every interactive
 * door supplies its storage operation here; migration and E2E fixture writes never do.
 */
async function persistUserInitiatedProviderKey(input: StoredUserProviderKey): Promise<void> {
  await storeUserInitiatedProviderKey({
    ...input,
    promptForPriceMultiplier: (connectionId) => dialogs.promptForKeyPriceMultiplier(
      dialogDeps(),
      undefined,
      connectionId,
    ),
    onCredentialChanged: handleCredentialChanged,
  });
}

/** Bundle the singletons the extracted dialog flows need (see dialogs.ts). */
function dialogDeps(options: Pick<DialogDeps, 'suppressInteractivePostCreatePrompts' | 'skipExistingTeamWarning' | 'useDefaultConnection'> = {}): DialogDeps {
  return {
    sessionManager,
    messageBus,
    workflowEngine,
    secrets,
    modelCatalog: getModelCatalog(),
    pricing: getPricing(),
    output: outputChannel,
    commandPolicy, refreshPrices, ensureModelPickerConsent,
    storeUserInitiatedProviderKey: (secretName, value, connectionId) => persistUserInitiatedProviderKey({
      secretName,
      value,
      connectionId,
      storeSecret: () => secrets.set(secretName, value),
    }),
    defaultBackendKind: (config) => defaultBackendKind(config, effectiveConnectionRegistry),
    defaultProvider: resolveDefaultProvider,
    connectionResolver: effectiveConnectionRegistry,
    chooseConnection: options.useDefaultConnection ? undefined : (items, title) => vscode.window.showQuickPick(items, {
      title,
      placeHolder: 'Select connection and billing path',
      matchOnDescription: true,
      matchOnDetail: true,
    }),
    onRosterChanged: () => { teamViewProvider?.refresh(); updateStatusBar(); saveRosterInBackground(); notifyPmRosterChange(); },
    suppressInteractivePostCreatePrompts: options.suppressInteractivePostCreatePrompts,
    skipExistingTeamWarning: options.skipExistingTeamWarning,
  };
}

/** Debounce so a bulk team-creation (several agents at once) tells the PM ONCE, not per agent. */
let rosterNotifyTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * #3: when the team gains or loses an agent, tell the Project Manager so it can adjust assignments to the
 * new personnel/resources. The roster itself is already persisted (saveRoster) and queryable via
 * list_agents; this is the PROACTIVE nudge. Debounced; no-op when there's no PM coordinator to tell.
 */
function notifyPmRosterChange(): void {
  if (rosterNotifyTimer) { clearTimeout(rosterNotifyTimer); }
  rosterNotifyTimer = setTimeout(() => {
    const sessions = sessionManager.getAll();
    const pm = sessions.find((s) => s.config.role === 'pm');
    if (!pm) { return; } // no coordinator → nobody to tell (Solo / no-PM team)
    const teammates = sessions
      .filter((s) => s.config.id !== pm.config.id)
      .map((s) => `${s.config.name} (${s.config.role})`);
    const roster = teammates.length ? teammates.join(', ') : '(no teammates)';
    messageBus.send('user', pm.config.id, 'ask.question', {
      instruction:
        `[Team update] Your roster changed — current teammates: ${roster}. ` +
        `If this affects your plan (a new capability is now available, or someone you intended to delegate ` +
        `to is gone), adjust your assignments accordingly. Otherwise just acknowledge briefly — no work needed.`,
      mode: 'act',
    }, 'normal');
  }, 1500);
}

// ─── Marketplace install (M4) ──────────────────────────────────────────

let cachedMarketplaceCatalog: MarketplaceCatalog | undefined;

/** Load + cache the effective marketplace catalog (bundled + optional hosted), matching the panel. */
async function loadMarketplaceCatalog(extensionUri: vscode.Uri): Promise<MarketplaceCatalog> {
  if (cachedMarketplaceCatalog) { return cachedMarketplaceCatalog; }
  const read = async (name: CatalogSourceName): Promise<unknown> => {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, 'marketplace', `${name}.json`));
      return JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      return [];
    }
  };
  const bundled: RawCatalog = { agents: await read('agents'), mcp: await read('mcp'), skills: await read('skills') };
  const cfg = vscode.workspace.getConfiguration('unode');
  const url = cfg.get<string>('marketplace.catalogUrl', '').trim();
  const hosted = cfg.get<boolean>('marketplace.fetchCatalog', false) && url
    ? { url, timeoutMs: 5000, verify: { publicKeyPem: CATALOG_PUBLIC_KEY_PEM } }
    : undefined;
  cachedMarketplaceCatalog = await resolveCatalog({ bundled, hosted, warn: (m) => outputChannel.warn(`Marketplace: ${m}`) });
  return cachedMarketplaceCatalog;
}

async function agentBuilderViewModel(extensionUri: vscode.Uri, agentId?: string): Promise<AgentBuilderViewModel> {
  const catalog = await loadMarketplaceCatalog(extensionUri);
  const agent = agentId ? sessionManager.get(agentId)?.config : undefined;
  const rootForFolderIssues = agent?.workingDirectory || workspaceRoot();
  const folderAccessIssues = agent?.folderAccess?.length
    ? resolveEffectiveRoots({
      grants: agent.folderAccess,
      fallbackPrimaryRoot: rootForFolderIssues,
      fallbackReadRoots: orchestrationHost.readRootsForAgent(rootForFolderIssues),
      workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      isTrusted: vscode.workspace.isTrusted,
    }).issues
    : [];
  const tiers = resolveModelTiers(
    vscode.workspace.getConfiguration('unode').get<Partial<Record<ModelTier, Record<string, string>>>>('modelTiers', {})
  );
  // The provider the user actually chose in Setup / "Set as default" — NOT a hardcoded one. This was the
  // exact bug `resolveDefaultProvider`'s doc-comment warns about ("MUST be the single read site"): the Agent
  // Builder was the read site that got missed, so it pinned every role to 'roam' regardless. A user who set
  // up on Unode or Claude Headless got a Roam agent the moment they picked a role.
  const defaultProviderId = resolveDefaultProvider();
  const defaultConnectionId = connectionIdForProviderId(defaultProviderId, effectiveConnectionRegistry) ?? 'unode';
  const defaultProfile = connectionProfile(defaultConnectionId, effectiveConnectionRegistry);
  const roles = Object.entries(ROLE_TEMPLATES).map(([id, template]) => ({
    id,
    name: template.name,
    role: template.role,
    description: template.description,
    icon: template.icon,
    color: template.color,
    systemPrompt: template.systemPrompt,
    skillIds: template.skills.map((s) => s.id),
    playbookIds: template.playbooks ?? [],
    tier: template.tier,
    providerId: defaultProviderId,
    // Fall back through the default provider's own catalog before the built-in Roam model, so a role on a
    // provider that has no mapping still opens on a model that provider can actually serve.
    model: (defaultProfile?.id.startsWith('custom:') ? undefined : modelForRole(template, defaultProviderId))
      ?? modelForTier('standard', defaultProviderId, tiers)
      ?? defaultProfile?.catalogModels[0]?.id
      ?? template.model,
  }));
  const providers = effectiveConnectionRegistry.profiles.flatMap((profile) => {
    const id = legacyProviderIdForConnectionId(profile.id, effectiveConnectionRegistry);
    if (!id) { return []; }
    const c = profile.capabilities;
    return [{
      id,
      connectionId: profile.id,
      name: profile.presentation.displayName,
      baseUrl: profile.presentation.endpointDefault,
      models: profile.catalogModels.map((model) => ({ id: model.id, name: model.name })),
      runtimeLabel: profile.presentation.runtimeLabel,
      billingLabel: profile.presentation.billingLabel,
      privacySummary: profile.presentation.privacySummary,
      availability: profile.availability,
      availabilityMessage: profile.availabilityMessage,
      allowedModelParamKeys: [...profile.capabilities.modelParams],
      // A context window is a runtime planning bound rather than a request parameter. Connections that
      // cannot plan keep the override out of the builder instead of presenting a setting they ignore.
      contextWindowAvailable: c.plan,
      supportedToolKeys: [
        ...(c.read ? ['read', 'search'] : []),
        ...(c.write ? ['write'] : []),
        ...(c.command ? ['execute'] : []),
        ...(c.delegation ? ['delegate'] : []),
        'message',
      ],
      skillsAvailable: c.skills,
      folderAccessAvailable: c.folderAccess,
      toolProtocolAvailable: c.toolProtocol,
      smartModeAvailable: c.smartMode,
      mcpAvailable: c.mcp,
      coordinatorAvailable: c.coordinator,
      capabilitySummary: `Plan ${c.plan ? 'available' : 'unavailable'}; Act ${c.act ? 'available' : 'unavailable'}; commands ${c.command ? c.commandApproval : 'unavailable'}.`,
    }];
  });
  const capabilities = Object.values(SKILL_LIBRARY).map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    category: skill.category,
    requiredTools: skillResolver.allowedToolsForIds([skill.id]),
  }));
  const mcpServers = [...mcpRegistry.values()].map((cfg) => ({
    id: cfg.id,
    name: cfg.name,
    transport: cfg.transport,
    connected: !!mcpHub.listServers().find((s) => s.id === cfg.id),
    requiresApproval: !!cfg.requiresApproval,
  }));
  return {
    mode: agent ? 'edit' : 'new',
    defaultProviderId,
    agent: agent ? {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      roleKey: agent.roleTemplateKey,
      roleLabel: agent.role,
      icon: agent.icon,
      color: agent.color,
      providerId: agent.provider.providerId,
      model: agent.model,
      fallbackModel: agent.fallbackModel,
      toolProtocol: agent.toolProtocol ?? 'auto', // undefined (stored) = Auto in the builder UI
      systemPrompt: agent.systemPrompt,
      skillIds: (agent.skills ?? []).map((s) => s.id),
      playbooks: agent.playbooks ?? [],
      mcpServers: agent.mcpServers ?? [],
      backend: agent.backend ?? defaultBackendKind(agent, effectiveConnectionRegistry),
      folderAccess: agent.folderAccess ?? [],
      folderAccessIssues,
      commandNarrowing: agent.commandNarrowing,
      modelParams: agent.modelParams,
      contextWindowTokens: agent.contextWindowTokens,
      tier: agent.tier ?? '',
      smartModeEnabled: readSmartMode().enabled,
      promptTemplate: promptTemplateBuilderState(agent),
    } : undefined,
    roles,
    providers,
    capabilities,
    mcpServers,
    catalog,
    globalCommandPolicy: {
      approvalMode: commandPolicy.approvalMode,
      allowedCommands: [...commandPolicy.allowedCommands],
    },
    skillLibraryUrl: vscode.workspace.getConfiguration('unode').get<string>(
      'marketplace.skillLibraryUrl',
      'https://github.com/UnodeTechxyz/unode-skills'
    ),
  };
}

function promptTemplateBuilderState(agent: AgentConfig): NonNullable<AgentBuilderViewModel['agent']>['promptTemplate'] {
  const status = promptTemplateStatus(agent);
  switch (status.state) {
    case 'template-current':
      return {
        state: status.state,
        label: 'On current role template',
        detail: 'This agent automatically receives the latest shipped guidance for its role.',
        showUpdateNotice: false,
        canReset: !!status.currentTemplate,
        canUndo: !!agent.systemPromptUndo,
      };
    case 'custom-current':
      return {
        state: status.state,
        label: 'Customized (based on current default)',
        detail: 'Your instructions are preserved. The template you started from is still current.',
        showUpdateNotice: false,
        canReset: !!status.currentTemplate,
        canUndo: !!agent.systemPromptUndo,
      };
    case 'custom-outdated':
      return {
        state: status.state,
        label: 'Customized (default has since changed)',
        detail: 'Your instructions are untouched. Review the default-to-default diff, keep yours, or explicitly reset.',
        showUpdateNotice: status.showUpdateNotice,
        diff: status.templateAtFork && status.currentTemplate
          ? templatePromptDiff(status.templateAtFork, status.currentTemplate.systemPrompt)
          : undefined,
        canReset: !!status.currentTemplate,
        canUndo: !!agent.systemPromptUndo,
      };
    case 'custom-origin-unknown':
      return {
        state: status.state,
        label: 'Customized (template origin unavailable)',
        detail: 'UnodeAi preserved this older prompt because it cannot prove which default it came from. Review the current guidance or reset only if you want it.',
        showUpdateNotice: status.showUpdateNotice,
        canReset: !!status.currentTemplate,
        canUndo: !!agent.systemPromptUndo,
      };
    case 'custom-no-template':
      return {
        state: status.state,
        label: 'Custom role instructions',
        detail: 'This role has no shipped default template; your instructions are entirely yours.',
        showUpdateNotice: false,
        canReset: false,
        canUndo: !!agent.systemPromptUndo,
      };
  }
}

async function handlePromptTemplateAction(
  agentId: string,
  action: 'dismiss' | 'adopt' | 'undo'
): Promise<{ ok: boolean; message: string }> {
  const session = sessionManager.get(agentId);
  if (!session) {
    return { ok: false, message: 'Agent no longer exists.' };
  }
  const config = session.config;
  migratePromptTemplateSource(config);
  let changed = false;
  if (action === 'dismiss') {
    changed = dismissPromptTemplateUpdate(config);
    if (!changed) {
      return { ok: false, message: 'There is no new default guidance to dismiss.' };
    }
  } else if (action === 'adopt') {
    const status = promptTemplateStatus(config);
    if (!status.currentTemplate) {
      return { ok: false, message: 'This custom role has no default template to adopt.' };
    }
    if (status.state === 'template-current') {
      return { ok: false, message: 'This agent already uses the current role template.' };
    }
    const choice = await vscode.window.showWarningMessage(
      `Replace ${config.name}'s customized instructions with the current ${status.currentTemplate.name} template? Your current instructions are kept for Undo.`,
      { modal: true },
      'Adopt current template'
    );
    if (choice !== 'Adopt current template') {
      return { ok: false, message: 'Kept your instructions unchanged.' };
    }
    changed = adoptCurrentPromptTemplate(config);
  } else {
    changed = undoAdoptCurrentPromptTemplate(config);
    if (!changed) {
      return { ok: false, message: 'There is no template reset to undo.' };
    }
  }

  if (!changed) {
    return { ok: false, message: 'No prompt-template change was made.' };
  }
  await saveRoster();
  if (action !== 'dismiss' && shouldRestartAfterAgentConfigEdit(session.status)) {
    await sessionManager.restart(agentId);
  }
  teamViewProvider?.refresh();
  chatViewProvider?.refresh();
  return action === 'dismiss'
    ? { ok: true, message: 'Kept your instructions. This default version will stay quiet; a later template update will appear again.' }
    : action === 'undo'
      ? { ok: true, message: 'Restored your customized instructions.' }
      : { ok: true, message: 'Adopted the current template. Use Undo template reset to restore your prior instructions.' };
}

async function agentBuilderListModels(
  providerId: string,
  _baseUrl?: string
): Promise<Array<{ id: string; name: string; price?: string }>> {
  // Webviews are untrusted. A disabled Coming soon option is only presentation; do not let a forged
  // list-models message reach metadata consent, pricing, or a catalog request for that connection.
  const connectionId = connectionIdForProviderId(providerId, effectiveConnectionRegistry);
  const profile = connectionId ? connectionProfile(connectionId, effectiveConnectionRegistry) : undefined;
  if (!connectionId || !profile || profile.availability !== 'available') {
    return [];
  }
  // Don't let a slow /api/pricing (or an extra pricing source) hang the model dropdown: wait briefly
  // for live (discounted) prices, but fall through after 1.5s and return models with whatever prices are
  // already cached. refreshPrices keeps running and the cache is warm for the next provider switch.
  // The consent question is asked OUTSIDE the race — a modal the user is still reading must not be
  // "timed out" by a 1.5s budget meant for a slow HTTP call. And it asks about EVERY host this function is
  // about to contact, not just the pricing ones: the model endpoint below is a network call too.
  const resolvedBase = resolveModelCatalogBaseUrl(connectionId, effectiveConnectionRegistry);
  await ensureModelPickerConsent(connectionId, resolvedBase);
  // Scoped for the same reason as the prompt above it: this dropdown is about ONE provider, so approved-but-
  // unrelated gateways are not contacted either.
  await Promise.race([refreshPrices({ scope: connectionId }), new Promise((resolve) => setTimeout(resolve, 1500))]);
  const apiKey = profile.apiKeySecretName ? await secrets.get(profile.apiKeySecretName) : undefined;
  // Declined hosts throw inside metadataFetch; ModelCatalog catches per source and falls back to the static
  // list, so this returns the built-in models rather than failing.
  const models = await getModelCatalog().list(connectionId, resolvedBase, apiKey);
  // This response was reached only after the user opened the picker and its metadata-consent plan completed.
  // Remember a report for the save path, but never make a request here (or anywhere at activation) just to
  // obtain one. Static/catalog rows have no measurement, so a gateway that omits the field changes nothing.
  for (const model of models) {
    if (model.measuredContextWindow) {
      discoveredContextWindows.set(contextWindowDiscoveryKey(connectionId, model.id), model.measuredContextWindow);
    }
  }
  // Our price table is the gateway's pricing — it applies to the Roam AND Unode gateways (both fetch
  // /api/pricing into the same table), but NOT to a model served by another provider (e.g. gpt-4o billed by
  // OpenAI directly), so don't show a misleading gateway price there. Selected defaults with an unverified
  // rate show that fact explicitly; they never borrow an older model's price or silently look free.
  return models.map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    price: modelPriceLabel(model.id, connectionId),
  }));
}

function contextWindowDiscoveryKey(connectionId: string, model: string): string {
  // Model IDs are opaque and may be case-sensitive, so do not normalize them into a different requested id.
  return `${connectionId}\u0000${model}`;
}

function discoveredContextWindow(connectionId: string, model: string): ContextWindowMeasurement | undefined {
  return discoveredContextWindows.get(contextWindowDiscoveryKey(connectionId, model));
}

function modelPriceLabel(modelId: string, providerId?: string): string | undefined {
  const resolved = getPricing().priceInfoFor(modelId, providerId);
  if (!resolved) { return intentionallyUnknownPriceLabel(modelId); }
  const p = resolved.price;
  return `$${p.input}/$${p.output} per 1M · ${priceProviderLabel(providerId)} (${resolved.source})`;
}

function priceProviderLabel(providerId?: string): string {
  const connectionId = providerId ? connectionIdForProviderId(providerId, effectiveConnectionRegistry) : undefined;
  return (connectionId ? connectionProfile(connectionId, effectiveConnectionRegistry)?.presentation.displayName : undefined)
    ?? providerId?.trim()
    ?? 'Default';
}

async function pickAgentBuilderIcon(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { Images: ['png', 'jpg', 'jpeg', 'webp', 'svg'] },
    title: 'Choose Agent Icon',
  });
  const uri = picked?.[0];
  if (!uri) {
    return undefined;
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.byteLength > MAX_AGENT_ICON_BYTES) {
    void vscode.window.showWarningMessage('Use a small icon under 64 KB');
    return undefined;
  }

  const mime = mimeForAgentIcon(uri.fsPath);
  if (!mime) {
    void vscode.window.showWarningMessage('Choose a PNG, JPEG, WebP, or SVG icon.');
    return undefined;
  }
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

async function pickAgentBuilderFolderAccessFolder(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: 'Choose Folder Access Scope',
  });
  const uri = picked?.[0];
  if (!uri || uri.scheme !== 'file') {
    return undefined;
  }
  const root = workspaceRoot();
  const rel = path.relative(root, uri.fsPath);
  if (rel === '') {
    return '.';
  }
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : uri.fsPath;
}

function resolveAgentBuilderFolderAccessIssues(grants: FolderGrant[]): Array<{ kind: string; path: string; message: string }> {
  const root = workspaceRoot();
  return resolveEffectiveRoots({
    grants,
    fallbackPrimaryRoot: root,
    fallbackReadRoots: orchestrationHost.readRootsForAgent(root),
    workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    isTrusted: vscode.workspace.isTrusted,
  }).issues;
}

function mimeForAgentIcon(filePath: string): string | undefined {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    default: return undefined;
  }
}

async function handleAgentBuilderSave(
  payload: AgentBuilderSavePayload,
  extensionUri: vscode.Uri
): Promise<{ ok: boolean; message: string }> {
  const connectionId = connectionIdForProviderId(payload.providerId, effectiveConnectionRegistry);
  const profileForSave = connectionId ? connectionProfile(connectionId, effectiveConnectionRegistry) : undefined;
  const provider = connectionId ? providerRefForConnectionId(connectionId, effectiveConnectionRegistry) : undefined;
  if (!connectionId || !profileForSave || !provider || profileForSave.availability !== 'available') {
    return { ok: false, message: 'Unknown provider.' };
  }
  const template = payload.roleKey === 'custom' ? undefined : ROLE_TEMPLATES[payload.roleKey];
  if (payload.roleKey !== 'custom' && !template) {
    return { ok: false, message: 'Unknown role template.' };
  }
  const catalog = await loadMarketplaceCatalog(extensionUri);
  const roleName = payload.roleKey === 'custom' ? payload.customRole! : template!.role;
  const role = roleName as AgentConfig['role'];
  const skills = payload.skillIds.map((id) => SKILL_LIBRARY[id]).filter(Boolean);
  const systemPrompt = applyPlaybooks(payload.systemPrompt, payload.playbooks, catalog.skills);
  const existing = payload.id ? sessionManager.get(payload.id) : undefined;
  const desiredTemplateKey = template ? payload.roleKey : undefined;
  const roleTemplateChanged = !!existing && existing.config.roleTemplateKey !== desiredTemplateKey;
  // A confirmed role-template switch is a prompt replacement, so retain the old prompt just as
  // Reset-to-template does. Capture before mutating the shared Session config.
  const roleSwitchUndo = existing && payload.roleTemplateAdopted && template && roleTemplateChanged
    ? {
      prompt: existing.config.systemPrompt,
      templateAtFork: existing.config.systemPromptTemplateAtFork,
      dismissedTemplateHash: existing.config.systemPromptDismissedTemplateHash,
    }
    : undefined;
  // Capture BEFORE the mutations below (config === existing.config, so these get overwritten).
  const priorSkills = existing?.config.skills ?? [];
  const priorTools = existing?.config.allowedTools ?? [];
  const priorFork = existing?.config.systemPromptTemplateAtFork;
  const priorDismissed = existing?.config.systemPromptDismissedTemplateHash;
  const priorMeasuredContextWindow = existing?.config.measuredContextWindow;
  const resolvedTools = skillResolver.resolveAllowedTools(skills);
  const legacyNoSkillMeta = priorSkills.length === 0 && priorTools.length > 0;
  const requestedTools = (skills.length === 0 && legacyNoSkillMeta) ? priorTools : resolvedTools;
  const suppliedModelParams = payload.modelParams;
  const templateModelParams = !existing && suppliedModelParams === undefined ? template?.modelParams : undefined;
  const requestedModelParams = suppliedModelParams ?? templateModelParams;
  const unsupportedRequestedParams = unsupportedModelParamKeys(profileForSave.capabilities, requestedModelParams);
  if (suppliedModelParams !== undefined && unsupportedRequestedParams.length > 0) {
    return {
      ok: false,
      message: `${profileForSave.presentation.displayName} does not accept: ${unsupportedRequestedParams.join(', ')}. No changes were saved.`,
    };
  }
  const compatibleTemplateParams = suppliedModelParams === undefined
    ? supportedModelParams(profileForSave.capabilities, requestedModelParams)
    : suppliedModelParams;
  const preservedLegacyParams = payload.removeLegacyModelParams
    ? {} as AgentModelParams
    : Object.fromEntries(
      Object.entries(existing?.config.modelParams ?? {}).filter(([key]) => !profileForSave.capabilities.modelParams.has(key))
    ) as AgentModelParams;
  const capabilityProbe = {
    ...(existing?.config ?? {}),
    provider: { ...provider },
    role,
    skills,
    allowedTools: requestedTools,
    playbooks: payload.playbooks,
    mcpServers: payload.mcpServers,
    folderAccess: payload.folderAccess,
    commandNarrowing: payload.commandNarrowing,
    toolProtocol: payload.toolProtocol === 'native' ? 'native' : payload.toolProtocol === 'xml' ? 'xml' : undefined,
    tier: payload.tier,
    backend: profileForSave.backendKind,
    route: routeForConnectionId(connectionId, payload.model, effectiveConnectionRegistry),
  } as AgentConfig;
  const unsupportedCapabilities = capabilityViolations(capabilityProbe, effectiveConnectionRegistry);
  if (unsupportedCapabilities.length > 0) {
    return { ok: false, message: unsupportedCapabilities.map((violation) => violation.message).join(' ') };
  }
  const config = existing?.config ?? new AgentConfigBuilder(role)
    .setName(payload.name)
    .setProviderRef(provider)
    .setModel(payload.model)
    .setSystemPrompt(systemPrompt)
    .setSkills(payload.skillIds)
    .setAutoApprove(false)
    // No setWorkingDirectory: the runtime resolves the root per session (SessionInfo.runtimeWorkingDirectory).
    // Pinning the workspace-at-save went stale when the agent later ran elsewhere ("outside working folder").
    .build();

  config.name = payload.name;
  config.role = role;
  config.roleTemplateKey = desiredTemplateKey;
  config.skill = payload.skillIds[0] ?? payload.customRole ?? String(role);
  config.skills = skills;
  // Data-loss guard: a legacy/external/hand-written agent may have allowedTools but no skill metadata
  // to render as checkboxes. If so, saving with no skills selected must NOT wipe its tools (which would
  // strip a PM's delegate/message/read/search). Keep the prior tools only for that case; a normal
  // skills-based agent still re-derives (so unchecking skills genuinely reduces it).
  config.allowedTools = (skills.length === 0 && legacyNoSkillMeta) ? priorTools : resolvedTools;
  config.provider = { ...provider };
  config.model = payload.model;
  config.route = routeForConnectionId(connectionId, payload.model, effectiveConnectionRegistry);
  config.backend = profileForSave.backendKind;
  if (profileForSave.kind === 'openai-compatible') {
    config.baseUrl = profileForSave.presentation.endpointDefault;
  } else {
    delete config.baseUrl;
  }
  config.fallbackModel = payload.fallbackModel || undefined;
  // 'auto' (the default) persists as undefined so the backend can start known tool-call leakers
  // (Kimi/Moonshot/GLM/MiniMax) in XML automatically (v0.8.14). Only an explicit Native/XML is stored.
  config.toolProtocol = payload.toolProtocol === 'native' ? 'native' : payload.toolProtocol === 'xml' ? 'xml' : undefined;
  if (roleSwitchUndo && template) {
    // The webview asked first. Start from the newly chosen template so a subsequent typed change
    // correctly records THAT template as its fork, then retain the prior prompt for Undo.
    config.systemPrompt = template.systemPrompt;
    config.systemPromptSource = 'template';
    delete config.systemPromptTemplateAtFork;
    delete config.systemPromptDismissedTemplateHash;
    recordSystemPromptSave(config, systemPrompt);
    config.systemPromptUndo = roleSwitchUndo;
  } else if (!template) {
    // An explicitly chosen "Custom role" must not be reinterpreted back into a shipped template by text match.
    recordCustomRoleSave(config, systemPrompt);
  } else {
    // Includes the safe out-of-band edit check: stale source metadata is never enough to replace
    // a text value from a hand-edited team.json file.
    migratePromptTemplateSource(config);
    recordSystemPromptSave(config, systemPrompt);
  }
  // Instructions a role switch replaced and the user did not restore in-panel. The webview's copy dies with
  // the panel, so without this a new agent's hand-written prompt was gone for good.
  retainReplacedPrompt(config, payload.roleSwitchStashedPrompt, {
    templateAtFork: priorFork,
    dismissedTemplateHash: priorDismissed,
  });
  // The panel writes the role's default into the icon field on every role switch, so a submitted value
  // is not evidence of a choice — `iconExplicit` is what separates the two. See iconForSavedAgent.
  config.icon = iconForSavedAgent({
    submitted: payload.icon,
    explicit: payload.iconExplicit === true,
    templateIcon: template?.icon,
    isEdit: !!existing,
    taken: rosterIcons(),
  });
  config.color = payload.color || template?.color;
  config.mcpServers = payload.mcpServers;
  config.playbooks = payload.playbooks;
  config.folderAccess = payload.folderAccess && payload.folderAccess.length > 0 ? payload.folderAccess : undefined;
  config.commandNarrowing = payload.commandNarrowing;
  // Do NOT pin/persist a workingDirectory here. It used to be set to the workspace-at-save, which went stale
  // when the agent later ran in a different folder ("outside working folder"). The runtime resolves the root
  // each session (worktree path or current workspace) and records it on SessionInfo.runtimeWorkingDirectory —
  // that is the single source of truth. Leaving config.workingDirectory unset keeps team.json portable.
  // Per-agent model fine-tuning: the user's edits from the builder win. If they left every field blank,
  // a brand-new agent falls back to the role template's defaults; an edited agent clears to global defaults.
  const persistedModelParams = { ...preservedLegacyParams, ...(compatibleTemplateParams ?? {}) } as AgentModelParams;
  config.modelParams = Object.keys(persistedModelParams).length > 0 ? persistedModelParams : undefined;
  // An explicit number is a user statement, never a slot a metadata response may overwrite. A measured
  // value is persisted only when the field stays blank, and only from the user-triggered model-picker
  // response cached for this exact provider/model pair. No measurement (the common gateway response) leaves
  // prior state untouched and reports the assumed fallback instead of inventing a value.
  config.contextWindowTokens = payload.contextWindowTokens;
  const freshlyMeasuredContextWindow = discoveredContextWindow(connectionId, payload.model);
  const priorMeasurementForModel = priorMeasuredContextWindow?.model === payload.model
    ? priorMeasuredContextWindow
    : undefined;
  const reportedContextWindow = freshlyMeasuredContextWindow ?? priorMeasurementForModel;
  let contextWindowNotice = '';
  const measurementDecision = decideContextWindowMeasurement({
    model: payload.model,
    explicitTokens: payload.contextWindowTokens,
    prior: priorMeasuredContextWindow,
    discovered: freshlyMeasuredContextWindow,
  });
  if (measurementDecision.applied) {
    config.measuredContextWindow = measurementDecision.measurement;
  }
  if (payload.contextWindowTokens !== undefined) {
    if (reportedContextWindow && reportedContextWindow.tokens !== payload.contextWindowTokens) {
      contextWindowNotice = ` Kept your explicit ${payload.contextWindowTokens.toLocaleString()}-token context window; `
        + `${profileForSave.presentation.displayName} reported ${reportedContextWindow.tokens.toLocaleString()} via ${reportedContextWindow.field}.`;
    }
  } else if (measurementDecision.applied && freshlyMeasuredContextWindow) {
    contextWindowNotice = ` Using the ${freshlyMeasuredContextWindow.tokens.toLocaleString()}-token context window `
      + `advertised by ${profileForSave.presentation.displayName} via ${freshlyMeasuredContextWindow.field}.`;
  } else if (!priorMeasurementForModel) {
    contextWindowNotice = ` ${profileForSave.presentation.displayName} did not advertise a context window for ${payload.model}; `
      + 'using the assumed 1,048,576-token default.';
  }
  // Per-agent Smart Mode tier override (undefined = follow the role/default tier).
  config.tier = payload.tier;

  for (const id of payload.mcpServers) {
    const cfg = mcpRegistry.get(id);
    if (cfg) {
      await mountMcpServer(cfg);
    }
  }

  if (existing) {
    await saveRoster();
    // A role edit can change the generated roster label/duty without creating or removing a session.
    // Coalesce it with any lifecycle events so the owned rules block stays current as well.
    scheduleTeamRulesOnRosterChange();
    if (shouldRestartAfterAgentConfigEdit(existing.status)) {
      await sessionManager.restart(existing.id);
    }
    teamViewProvider?.refresh();
    chatViewProvider?.refresh();
    return { ok: true, message: `Updated ${config.name}.${contextWindowNotice}` };
  }

  sessionManager.create(config);
  notifyPmRosterChange();
  return { ok: true, message: `Added ${config.name} to your team.${contextWindowNotice}` };
}

/**
 * M4: perform a marketplace install chosen in the panel. Agents reuse the normal add path
 * (AgentConfigBuilder → sessionManager.create, which auto-persists the roster); MCP servers are
 * written to .unode/team.json + mounted through the existing approval gate. Skills land in Phase 3.
 */
/** Icons the current roster wears, for de-duplicating a newly created agent's glyph. */
function rosterIcons(): string[] {
  return sessionManager.getAll().map((s) => s.config.icon).filter((icon): icon is string => !!icon);
}

async function handleMarketplaceInstall(
  action: MarketplaceInstallAction,
  extensionUri: vscode.Uri
): Promise<{ ok: boolean; message: string }> {
  const catalog = await loadMarketplaceCatalog(extensionUri);

  if (action.kind === 'agent') {
    const entry = catalog.agents.find((e) => e.id === action.entryId);
    if (!entry) { return { ok: false, message: 'Unknown agent preset.' }; }
    if (action.target === 'new-team') {
      const current = sessionManager.getAll();
      if (current.length > 0) {
        const choice = await vscode.window.showWarningMessage(
          `Start a new team with "${entry.name}"? This removes your current ${current.length} agent(s).`,
          { modal: true }, 'Replace', 'Cancel'
        );
        if (choice !== 'Replace') { return { ok: false, message: 'Cancelled — team unchanged.' }; }
        for (const s of [...current]) { await sessionManager.remove(s.id); }
      }
    }
    // No cwd: the runtime resolves the working root per session — don't pin it onto the installed config.
    const config = toAgentConfig(entry, { name: dialogs.uniqueAgentName(dialogDeps(), entry.name) });
    // A marketplace entry ships a preferred icon like a role template does, and lands in a roster that
    // already exists — so it deduplicates on the same rule as every other creation path.
    config.icon = distinctAgentIcon(config.icon, rosterIcons());
    config.backend = defaultBackendKind(config, effectiveConnectionRegistry);
    const marketplaceCapabilityIssues = capabilityViolations(config, effectiveConnectionRegistry);
    if (marketplaceCapabilityIssues.length > 0) {
      return { ok: false, message: marketplaceCapabilityIssues.map((issue) => issue.message).join(' ') };
    }
    // B2 "members come equipped": fold the member's skill playbooks (skills.json bodies) into its
    // system prompt so the agent carries them as standing procedure.
    config.systemPrompt = mountSkillPlaybooks(config.systemPrompt, entry.skills, catalog.skills);
    sessionManager.create(config); // fires session.created → roster persisted + team panel refresh
    notifyPmRosterChange();
    return { ok: true, message: `Added ${config.name} to your team.` };
  }

  if (action.kind === 'mcp') {
    const entry = catalog.mcp.find((e) => e.id === action.entryId);
    if (!entry) { return { ok: false, message: 'Unknown MCP server.' }; }
    const cfg = toMcpServerConfig(entry);
    const promptedUrl = await promptMarketplaceMcpUrl(entry);
    if (promptedUrl === undefined && entry.urlPrompt) {
      return { ok: false, message: 'Cancelled — MCP server unchanged.' };
    }
    if (promptedUrl) {
      cfg.url = promptedUrl.trim();
    }
    mcpRegistry.set(cfg.id, cfg);
    await persistMcpServerToTeamFile(cfg);
    // Reflect the REAL mount outcome (declined approval / failed) instead of always claiming success.
    return mcpMountMessage(cfg.name, await mountMcpServer(cfg));
  }

  return { ok: false, message: 'Skill install arrives in Phase 3.' };
}

async function promptMarketplaceMcpUrl(entry: McpCatalogEntry): Promise<string | undefined> {
  if (!entry.urlPrompt) {
    return undefined;
  }
  return vscode.window.showInputBox({
    title: entry.urlPrompt.title,
    prompt: entry.urlPrompt.prompt,
    placeHolder: entry.urlPrompt.placeHolder,
    value: entry.urlPrompt.value,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return 'Enter an MCP endpoint URL.';
      }
      try {
        const parsed = new URL(trimmed);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
          ? null
          : 'Use an http:// or https:// MCP endpoint.';
      } catch {
        return 'Enter a valid MCP endpoint URL.';
      }
    },
  }).then((value) => value?.trim());
}

/** Read-modify-write the team MCP registry in .unode/team.json (best-effort; in-memory registry already updated). */
async function persistMcpServerToTeamFile(cfg: MCPServerConfig): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.[0]) { return; } // no workspace → in-memory registry only (lost on reload)
  // Keep this read-modify-write path on PersistenceManager so adding an MCP server cannot re-export
  // stale provider/model/backend fields after E3 made `route` the sole team-file route authority.
  const current = await persistence.loadTeamConfig();
  const servers = current?.mcpServers ?? [];
  await persistence.saveTeamConfig({
    version: current?.version ?? '1.0',
    members: current?.members ?? persistence.loadAgents(),
    mcpServers: [...servers.filter((server) => server.id !== cfg.id), cfg],
    workflows: current?.workflows ?? [],
  });
}

/**
 * Trusted, user-confirmed import for the retired singleton custom gateway. The migration plan is
 * persisted before the first profile mutation, so a restart reuses the same opaque ids rather than
 * using endpoint equality or a display name as an accidental cross-workspace identity.
 */
async function migrateLegacySingletonCustomGateways(context: vscode.ExtensionContext): Promise<void> {
  const declines = new PersistentLegacyCustomMigrationDeclines(context.workspaceState);
  const workspaceAgents = persistence.loadAgents();
  const teamConfig = await persistence.loadTeamConfig();
  const teamAgents = await hydratedLegacyTeamAgents(teamConfig?.members ?? []);
  const workspaceLegacy = workspaceAgents.filter(isLegacySingletonCustomAgent);
  const teamLegacy = teamAgents.filter(isLegacySingletonCustomAgent);
  let state = readLegacyCustomGatewayMigrationState(context);
  const terminalRepairs = state ? undefined : readLegacyCustomGatewayTerminalRepairs(context);
  if (workspaceLegacy.length === 0 && teamLegacy.length === 0) {
    // A crash after both roster writes but before clearing the journal is already fully applied.
    const snapshot = state ? await loadCustomGatewayRegistryOrFallback() : undefined;
    if (state && state.plan.entries.every((entry) => snapshot?.profiles.some((profile) => profile.connectionId === entry.connectionId))) {
      await context.workspaceState.update(LEGACY_CUSTOM_GATEWAY_MIGRATION_KEY, undefined);
    }
    if (terminalRepairs) {
      await context.workspaceState.update(LEGACY_CUSTOM_GATEWAY_TERMINAL_REPAIRS_KEY, undefined);
    }
    await declines.clear();
    return;
  }

  if (!vscode.workspace.isTrusted) {
    outputChannel.warn('Legacy Custom gateway migration deferred because this workspace is untrusted.');
    return;
  }
  if (
    workspaceAgents.length > 0 &&
    teamConfig &&
    legacyMigrationRosterSignature(workspaceAgents) !== legacyMigrationRosterSignature(teamAgents) &&
    !isJournaledLegacyMigrationSplit(workspaceAgents, teamAgents, state)
  ) {
    void vscode.window.showWarningMessage(
      'UnodeAi found different rosters in workspace state and .unode/team.json. No legacy Custom profiles or credentials were changed; repair the roster copies before migration.',
    );
    return;
  }

  const canonicalAgents = workspaceLegacy.length > 0 ? workspaceAgents : teamAgents;
  const terminalRepairIds = new Set(terminalRepairs?.agentIds ?? []);
  const migrationAgents = state
    ? canonicalAgents
    : pendingLegacyCustomMigrationAgents(canonicalAgents, terminalRepairIds);
  if (!state && migrationAgents.filter(isLegacySingletonCustomAgent).length === 0) {
    // A completed model-less migration remains a visible route repair during restore. Do not reopen
    // the profile migration modal until the user supplies a model for one of those members.
    return;
  }
  if (declines.shouldSuppressPrompt(state !== undefined, migrationAgents)) {
    outputChannel.info('Legacy Custom gateway migration remains declined for this unchanged roster; leaving the visible repair unchanged.');
    return;
  }
  if (state && !legacyAgentIdsAreCoveredByJournal(state.sourceAgentIds, canonicalAgents.filter(isLegacySingletonCustomAgent))) {
    void vscode.window.showWarningMessage(
      'UnodeAi found a pending legacy Custom gateway migration for a different roster. No profiles or credentials were changed; repair the roster before retrying migration.',
    );
    return;
  }
  if (!state) {
    const legacySecretNames = new Set(
      migrationAgents
        .filter(isLegacySingletonCustomAgent)
        .map(legacyCustomSecretName),
    );
    const secretNamesWithValues = new Set<string>();
    for (const secretName of legacySecretNames) {
      if (await secrets.has(secretName)) {
        secretNamesWithValues.add(secretName);
      }
    }
    const snapshot = await loadCustomGatewayRegistryOrFallback();
    if (!snapshot) {
      return;
    }
    const usedOpaqueIds = new Set<string>([
      ...snapshot.profiles.map((profile) => profile.connectionId.slice('custom:'.length)),
      ...snapshot.tombstones.map((tombstone) => tombstone.connectionId.slice('custom:'.length)),
    ]);
    const nextOpaqueId = () => {
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const value = randomBytes(16).toString('hex');
        if (!usedOpaqueIds.has(value)) {
          usedOpaqueIds.add(value);
          return value;
        }
      }
      throw new Error('Unable to allocate a unique opaque id for legacy Custom gateway migration.');
    };
    let plan: LegacyCustomGatewayMigrationPlan;
    try {
      plan = planLegacyCustomGatewayMigration({
        trusted: true,
        agents: migrationAgents,
        legacyGlobalEndpoint: vscode.workspace.getConfiguration('unode').get<string>('customBaseUrl', ''),
        legacySecretNamesWithValues: secretNamesWithValues,
        reservedDisplayNames: effectiveConnectionRegistry.profiles.map((profile) => profile.presentation.displayName),
        nextOpaqueId,
      });
    } catch (error) {
      const message = `Legacy Custom gateway migration could not be planned. Repair the affected team member before retrying.`;
      outputChannel.error(`${message} ${String(error)}`);
      void vscode.window.showErrorMessage(message);
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      legacyCustomGatewayMigrationPreview(plan),
      { modal: true },
      'Migrate custom gateways',
    );
    if (choice !== 'Migrate custom gateways') {
      await declines.remember(migrationAgents);
      return;
    }
    state = {
      schemaVersion: 1,
      sourceAgentIds: migrationAgents.filter(isLegacySingletonCustomAgent).map((agent) => agent.id).sort(),
      plan,
    };
    await context.workspaceState.update(LEGACY_CUSTOM_GATEWAY_MIGRATION_KEY, state);
  }

  try {
    for (const entry of state.plan.entries) {
      const snapshot = await loadCustomGatewayRegistryOrFallback();
      if (!snapshot) {
        return;
      }
      const existing = snapshot.profiles.find((profile) => profile.connectionId === entry.connectionId);
      if (existing) {
        if (
          existing.displayName !== entry.displayName ||
          existing.endpointBase !== entry.endpointBase ||
          existing.secretRef !== entry.secretRef
        ) {
          throw new Error(`Migrated profile "${entry.connectionId}" no longer matches the pending migration journal. Repair the profile before retrying.`);
        }
        continue;
      }
      const legacyApiKey = entry.secretRef ? await secrets.get(entry.legacySecretName) : undefined;
      if (entry.secretRef && !legacyApiKey) {
        throw new Error(`Legacy key "${entry.legacySecretName}" is no longer available. Set a key manually after repairing this migration.`);
      }
      await customGatewayProfileStore.importLegacy({
        expectedRegistryRevision: snapshot.registryRevision,
        connectionId: entry.connectionId,
        displayName: entry.displayName,
        endpointBase: entry.endpointBase,
        ...(entry.secretRef === undefined ? {} : { secretRef: entry.secretRef, apiKey: legacyApiKey! }),
      });
    }
    await reloadEffectiveConnectionRegistry();
    const migrated = applyLegacyCustomGatewayMigration(canonicalAgents, state.plan);
    await persistence.saveAgents(migrated);
    if (teamConfig) {
      await persistence.saveTeamConfig({ ...teamConfig, members: migrated });
    }
    const configuredDefault = makeConfigStore().get<string>('defaultProvider', 'unode').trim().toLowerCase();
    if (configuredDefault === LEGACY_CUSTOM_PROVIDER_ID && state.plan.entries.length === 1) {
      await makeConfigStore().update('defaultProvider', state.plan.entries[0].connectionId);
    } else if (configuredDefault === LEGACY_CUSTOM_PROVIDER_ID) {
      void vscode.window.showWarningMessage(
        'Legacy Custom was your default provider, but migration produced zero or multiple named gateways. Choose a default custom gateway in Settings before creating new agents.',
      );
    }
    if (!migrated.some(isLegacySingletonCustomAgent)) {
      await context.workspaceState.update(LEGACY_CUSTOM_GATEWAY_MIGRATION_KEY, undefined);
      await context.workspaceState.update(LEGACY_CUSTOM_GATEWAY_TERMINAL_REPAIRS_KEY, undefined);
      await declines.clear();
    } else {
      const completedRepairIds = new Set([
        ...terminalRepairIds,
        ...state.plan.repairs.map((repair) => repair.agentId),
      ]);
      if (!hasOnlyTerminalLegacyCustomRepairs(migrated, completedRepairIds)) {
        return;
      }
      // The profile mutations are complete. Keep model-less members as visible non-runnable repairs
      // but clear this operation journal so their immutable missing-model state cannot replay it.
      await context.workspaceState.update(LEGACY_CUSTOM_GATEWAY_MIGRATION_KEY, undefined);
      await context.workspaceState.update(LEGACY_CUSTOM_GATEWAY_TERMINAL_REPAIRS_KEY, {
        schemaVersion: 1,
        agentIds: [...completedRepairIds].sort(),
      } satisfies LegacyCustomGatewayTerminalRepairState);
    }
    void vscode.window.showInformationMessage(
      `UnodeAi migrated ${state.plan.entries.length} legacy Custom gateway profile(s). ${state.plan.repairs.length} agent(s) remain visible for repair.`,
    );
  } catch (error) {
    outputChannel.warn(`Legacy Custom gateway migration paused: ${error instanceof Error ? error.message : String(error)}`);
    void vscode.window.showWarningMessage(
      `UnodeAi paused legacy Custom gateway migration: ${error instanceof Error ? error.message : String(error)} No model request was sent.`,
    );
  }
}

/** Read only an old per-agent endpoint from the raw team file; all other fields use schema-sanitized data. */
async function hydratedLegacyTeamAgents(agents: readonly AgentConfig[]): Promise<AgentConfig[]> {
  const endpoints = await legacyTeamEndpointOverrides();
  return agents.map((agent) => isLegacySingletonCustomAgent(agent) && endpoints.has(agent.id)
    ? { ...agent, baseUrl: endpoints.get(agent.id) }
    : agent,
  );
}

async function legacyTeamEndpointOverrides(): Promise<Map<string, string>> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { return new Map(); }
  try {
    const uri = vscode.Uri.joinPath(folder.uri, '.unode', 'team.json');
    const raw = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')) as { members?: unknown; agents?: unknown };
    const members = Array.isArray(raw.members) ? raw.members : Array.isArray(raw.agents) ? raw.agents : [];
    return new Map(members.flatMap((item): Array<[string, string]> => {
      if (!item || typeof item !== 'object') { return []; }
      const record = item as { id?: unknown; baseUrl?: unknown; provider?: { providerId?: unknown }; route?: { connectionId?: unknown } };
      return typeof record.id === 'string' && typeof record.baseUrl === 'string' &&
        isLegacySingletonCustomAgent({ provider: record.provider as AgentConfig['provider'], route: record.route as AgentConfig['route'] })
        ? [[record.id, record.baseUrl]]
        : [];
    }));
  } catch {
    return new Map();
  }
}

function legacyAgentIdsAreCoveredByJournal(expected: readonly string[], agents: readonly AgentConfig[]): boolean {
  const expectedIds = new Set(expected);
  return agents.every((agent) => expectedIds.has(agent.id));
}

/**
 * The only accepted roster divergence is a crash between the two plan-derived writes. Recompute
 * the expected migrated roster from the still-legacy side; all other disagreement remains a
 * fail-closed repair because the host cannot safely decide which arbitrary roster is authoritative.
 */
function isJournaledLegacyMigrationSplit(
  workspaceAgents: readonly AgentConfig[],
  teamAgents: readonly AgentConfig[],
  state: LegacyCustomGatewayMigrationState | undefined,
): boolean {
  if (!state) { return false; }
  const workspaceHasLegacy = workspaceAgents.some(isLegacySingletonCustomAgent);
  const teamHasLegacy = teamAgents.some(isLegacySingletonCustomAgent);
  if (workspaceHasLegacy === teamHasLegacy) { return false; }
  const legacySide = workspaceHasLegacy ? workspaceAgents : teamAgents;
  const migratedSide = workspaceHasLegacy ? teamAgents : workspaceAgents;
  if (!legacyAgentIdsAreCoveredByJournal(state.sourceAgentIds, legacySide.filter(isLegacySingletonCustomAgent))) {
    return false;
  }
  return legacyMigrationRosterSignature(applyLegacyCustomGatewayMigration(legacySide, state.plan)) === legacyMigrationRosterSignature(migratedSide);
}

function readLegacyCustomGatewayMigrationState(context: vscode.ExtensionContext): LegacyCustomGatewayMigrationState | undefined {
  const state = context.workspaceState.get<LegacyCustomGatewayMigrationState>(LEGACY_CUSTOM_GATEWAY_MIGRATION_KEY);
  return state?.schemaVersion === 1 && Array.isArray(state.sourceAgentIds) && state.plan?.schemaVersion === 1
    ? state
    : undefined;
}

function readLegacyCustomGatewayTerminalRepairs(context: vscode.ExtensionContext): LegacyCustomGatewayTerminalRepairState | undefined {
  const state = context.workspaceState.get<LegacyCustomGatewayTerminalRepairState>(LEGACY_CUSTOM_GATEWAY_TERMINAL_REPAIRS_KEY);
  return state?.schemaVersion === 1 && Array.isArray(state.agentIds) && state.agentIds.every((agentId) => typeof agentId === 'string')
    ? state
    : undefined;
}

function legacyCustomGatewayMigrationPreview(plan: LegacyCustomGatewayMigrationPlan): string {
  const groups = plan.entries.map((entry) =>
    `${entry.displayName}: ${entry.endpointBase} (${entry.agentIds.length} agent${entry.agentIds.length === 1 ? '' : 's'}; ${entry.secretRef ? 'copy stored legacy key' : 'no legacy key found'})`,
  );
  const repairs = plan.repairs.length > 0 ? `\n${plan.repairs.length} agent(s) need repair and will not be started.` : '';
  return `Migrate legacy Custom gateway routes into named local profiles?\n\n${groups.join('\n') || 'No valid HTTPS endpoints were found.'}${repairs}\n\nNo network request will be made. Existing legacy keys and settings are retained for other workspaces.`;
}

// ─── Status Bar ────────────────────────────────────────────────────────

function updateStatusBar(): void {
  const sessions = sessionManager.getAll();
  const active = sessions.filter((s) => s.status === 'running' || s.status === 'idle').length;
  const total = sessions.length;

  // Keep the version in every state (the always-visible anchor); agent count rides alongside it.
  const v = unodeVersion ? ` v${unodeVersion}` : '';
  if (total === 0) {
    statusBarItem.text = `$(organization) Unode${v}`;
  } else if (active > 0) {
    statusBarItem.text = `$(pulse) Unode${v} · ${active}/${total}`;
  } else {
    statusBarItem.text = `$(circle-slash) Unode${v} · ${total}`;
  }

  if (stopAllStatusBarItem) {
    // Shown while anything is running and hidden the moment nothing is, so its presence is itself the
    // answer to "is the crew still working" — the question the user was asking when they said stop.
    if (active > 0) {
      stopAllStatusBarItem.text = `$(debug-stop) Stop ${active}`;
      stopAllStatusBarItem.tooltip = `Stop all ${active} running UnodeAi agent${active === 1 ? '' : 's'} now. `
        + 'This ends their turns; it is not a message asking them to stop.';
      stopAllStatusBarItem.show();
    } else {
      stopAllStatusBarItem.hide();
    }
  }

  const queued = chatViewProvider?.pendingApprovalCount?.() ?? 0;
  const hostConsent = sessions.filter((session) => session.status === 'consent_required').length;
  const pendingApprovals = queued + hostConsent;
  if (approvalStatusBarItem) {
    if (pendingApprovals > 0) {
      approvalStatusBarItem.text = `🔐 ${pendingApprovals} waiting`;
      approvalStatusBarItem.tooltip = `${pendingApprovals} UnodeAi approval${pendingApprovals === 1 ? '' : 's'} waiting — click to decide`;
      approvalStatusBarItem.show();
    } else {
      approvalStatusBarItem.hide();
    }
  }
  // The activity-bar container is a subscriber too. Its badge is intentionally not updated by approval code.
  teamViewProvider?.setApprovalBadge(pendingApprovals);
}
