/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Extension Entry Point
 *  Wires SessionManager + MessageBus + backends + SecretStorage + persistence + VS Code UI.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { setCodeNavigationHost } from './navigation/CodeNavigation';
import { VscodeCodeNavigation } from './host/VscodeCodeNavigation';
import { ImageConnectionRegistry } from './image/ImageConnectionRegistry';
import { TranscriptionHost } from './media/TranscriptionHost';
import { createPaidToolAccounting } from './host/PaidToolAccounting';
import type { UnodeTranscriptionModel } from './media/UnodeTranscription';
import { TRANSCRIPTION_MAX_BYTES } from './media/TranscriptionAudio';
import { effectiveMediaModel, parseAgentMediaModels, type MediaCapability, type MediaModel } from './models/MediaModelSelection';
import { ImageGenerationHost } from './image/ImageGenerationHost';
import { ImageOperationHistory } from './image/ImageOperationHistory';
import { OfficeArtifactHistory } from './office/OfficeArtifactHistory';
import { AUTOMATIC_WINDOWS_COM_DEFAULT, OFFICE_RENDERER_PREFERENCE_KEY, officeRendererPreference, wordPowerPointRenderingPlatform, type OfficeRenderPreferences } from './office/OfficeRendererSelection';
import { chooseTeamConnections } from './views/TeamConnectionsPanel';
import { ImagePreviewHost } from './image/ImagePreviewHost';
import { LocalApplicationCatalog } from './office/LocalApplicationCatalog';
import { NativeOfficeRenderer } from './office/NativeOfficeRenderer';
import { PdfSignatureStore, signatureSaveNotice } from './office/pdf/PdfSignatureStore';
import { WorkbookRecalcEngine } from './office/WorkbookRecalcEngine';
import { recheckNativeRenderAuthorities } from './office/NativeRenderOperations';
import { POST_WRITE_DIAGNOSTICS_SETTLE_MS } from './host/postWriteDiagnosticsSettle';
import { openRecordedFile } from './host/openRecordedFile';
import { pdfExportDestination, personPdfExportRefusal, personPdfExportNotReady, personPdfExportResult, revealInOsLabel } from './host/fileActions';
import { runPersonPdfExport, type PersonPdfExportPorts } from './host/personOfficeExport';
import { createHasAgentsContext, followRoster } from './host/hasAgentsContext';
import { contributedSettingProperties } from './settings/contributedSettings';
import { parseTurnInterruption } from './backend/TurnInterruption';
import { REQUEST_LIMIT_STOP, SessionManager, TypedSessionEvent } from './session/SessionManager';
import { backendKindChangeNotice, conversationNotRestoredLogLine, conversationNotRestoredNotice } from './session/ConversationNotRestored';
import { meteredSpendPort } from './session/meteredSpendPort';
import { agentExecutionChanged } from './session/agentExecutionChange';
import { EgressConsentDeclinedError } from './backend/AgentBackend';
import { isCoordinator } from './session/CoordinatorIdentity';
import { createEffectiveExecutionIdentity, type EffectiveExecutionIdentity } from './session/EffectiveExecutionIdentity';
import { assertNoFolderAccessWorktreeConflict } from './session/folderAccessWorktreeConflict';
import { MessageBus } from './bus/MessageBus';
import { AgentConfigBuilder, DEFAULT_MODEL_TIERS, ROLE_TEMPLATES, TEAM_PRESETS, modelForRole } from './roles/RoleConfig';
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
import { selectTier, resolveModelTiers, modelForTier, configuredRoleTier, withRoleTierOverride } from './workflow/SmartMode';
import * as fs from 'fs/promises';
import { existsSync, mkdtempSync, readdirSync, realpathSync, statSync, readFileSync, watch as watchFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { FOLDERLESS_CHAT_NOTICE, FOLDERLESS_UNAVAILABLE_REASON, folderlessChatAllowed, folderlessChatConfig } from './host/FolderlessChat';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as os from 'os';
import { HistoryService } from './history/HistoryService';
import { TaskHistoryController } from './views/taskHistoryController';
import { HistoryStore } from './history/HistoryStore';
import { historyWorkspace } from './history/HistoryWorkspaceIdentity';
import { processIdentityHost, type ProcessIdentityAdapter, type ProcessIdentityRecord } from './host/processIdentity/ProcessIdentityHost';
import { GenerationLease, cachedSelfIdentity } from './history/GenerationLease';
import { HostRegistry } from './history/HostRegistry';
import { FileWriterLeases } from './history/FileWriterLeases';
import { recoveryNoticePort } from './history/RecoveryNotice';
import { TaskRecovery, type RecoveryReport } from './history/TaskRecovery';
import { taskRecoveryPorts } from './backend/TaskRecoveryHost';
import { RulesFile, rulesFilePath } from './session/RulesFile';
import { ProjectKnowledge } from './session/ProjectKnowledge';
import { SharedMemory, memoryFilePath, type MemoryNoteKind } from './session/SharedMemory';
import { memoryWriterLabel } from './session/memoryWriterLabel';
import { ALLOW_CROSS_PROVIDER_DISPATCH_DEFAULT, ALLOW_CROSS_PROVIDER_DISPATCH_SETTING, decideCoordinatorBriefConsent } from './backend/coordinatorBriefConsent';
import { MemoryAttestationStore } from './session/MemoryAttestationStore';
import {
  isE2EFixtureRequest,
  reconcileE2EFixtureApiKey,
} from './testing/E2EFixture';
import { ProjectConventions, resolveVerifyCommand } from './session/ProjectConventions';
import { completionVerificationFields, type TeamFileDocument } from './state/TeamFileSchema';
import { isSameAgentDirectory } from './backend/CompletionVerificationCheck';
import { readHostCompletionGatePolicy, readHostVerificationEligibility, readHostVerificationPolicy, runHostVerificationCheck } from './host/HostCompletionVerification';
import { TeamVerificationEditor } from './host/TeamVerificationEditor';
import { openLegacyVerificationUserSettings } from './host/CompletionVerificationRepair';
import { sameVerificationBinding, verificationExplicitlyRequired, type VerificationPolicyResolution } from './backend/CompletionVerificationPolicy';
import { policyVerifyResult } from './backend/CompletionPolicyVerifier';
import { liveCommandCapability } from './backend/LiveCommandCapability';
import { createPathAccessOffer, PathAccessRequestItems, pathAccessItemView, pathAccessNoticeText } from './host/PathAccessOffer';
import { TaskResumeRefs } from './host/TaskResumeRefs';
import { AccessTable } from './host/AccessTable';
import { connectPmLive, pmReplyStore } from './host/pmLiveView';
import { grantNoticeLine, grantWaitingTaskLine } from './host/grantNoticeText';
import { endedRequestContinuation } from './host/requestContinuation';
import { ClockReporter, onSystemClock } from './views/systemClock';
import { parseCompletionCheckObservation } from './observability/CompletionCheckObservation';
import type { WorktreeVerificationOwner } from './backend/WorktreeVerificationOwner';
import type { Worktree } from './backend/WorktreeManager';
import type { WorkflowCheckRequest } from './workflow/WorkflowEngine';
import { DiagnosticItem, expandContextMentions } from './session/ContextMentions';
import { parseMentions } from './session/FileMentions';
import { ContextManifestSource, createTurnContextManifest, dispatchDelegatedSources, textContextSource } from './session/TurnContextManifest';
import { ContentAssetStore, userRequestHolder } from './content/ContentAssetStore';
import { TaskInputResolver, type TaskAttemptCard } from './backend/TaskContract';
import { TaskCheckpointStore } from './backend/TaskCheckpoints';
import { workspaceRootIdentity } from './state/WorkspaceRootIdentity';
import { savedBatchesDeletePrompt, savedBatchesDocument, savedBatchesPick, workProductLabel } from './views/savedTaskBatches';
import { TeamPolicyStore, reviewPolicyMode } from './policy/TeamPolicy';
import { effectivePolicyView, type EffectivePolicyView } from './settings/EffectivePolicyView';
import { hostFileToolCapabilities } from './host/HostFileToolCapabilities';
import { evaluateReviewPolicy, type ReviewPolicyPreflightDecision } from './policy/ReviewPolicyPreflight';
import { secretPatternSignals } from './security/secretPatterns';
import { keepDelegatedToolResult, noteDelegatedSourcesDelivered, readDelegatedSourceInline, readDelegatedSourcePage } from './content/DelegatedSourceRead';
import { shouldRestartAfterAgentConfigEdit } from './session/sessionLifecycle';
import {
  filterReviewedPermissionWarnings,
  savedPermissionLoadResult,
  savedPermissionSkillIds,
  shouldReviewSavedPermissions,
} from './state/SavedPermissionReview';
import { SAVE_TEAM_SCOPE_DIALOG } from './state/SavedTeamScopeDialog';
import { applySavedPermissionRestore, restoreSavedPermissionsIndividually, savedCommandPreference, restoredCommandTools,
  type SavedCommandPreference } from './state/SavedPermissionRestore';
import { DEFAULT_CONTEXT_WINDOW_TOKENS, decideContextWindowMeasurement, resolveContextWindow } from './contextWindowDefaults';
import { bundledSmartCompactionPolicy } from './compaction/BundledSmartCompactionPolicy';
import {
  applySmartCompactionChoice,
  COMPACTION_WORK_PROFILES,
  isCompactionWorkProfile,
  isSmartCompactionMode,
  primarySkill,
  profileLabel,
  profileOverrideProblems,
  profileTypicalWork,
  resolveSmartCompactionPolicy,
  resolveWorkProfile,
  withoutDefaultCells,
  type SmartCompactionProfileOverrides,
  type SmartCompactionResolution,
} from './compaction/SmartCompactionPolicy';
import {
  describeSmartCompaction,
  type SmartCompactionPreview,
  type SmartCompactionPreviewContext,
} from './compaction/SmartCompactionPreview';
import { CompactionProfileTablePanel, type CompactionProfileTableViewModel } from './views/CompactionProfileTablePanel';
import { claudeCompactionEnvironment } from './compaction/ClaudeNativeCompaction';
import { MapReduceSummarizer, type SummaryCompletion } from './compaction/MapReduceSummarizer';
import { ContextCompactionCoordinator, type CompactionReceipt } from './compaction/ContextCompactionCoordinator';
import { summaryCompletionUsage } from './compaction/CompactionUsage';
import { sendSummaryRequest, summaryEgressScope } from './compaction/SummaryRequest';
import { automaticSnapshotSlug, automaticSnapshotsToPrune, describeTeamEntry, savedTeamDeleteConfirmation, teamSlug, type TeamLibraryEntry, type TeamLibraryRef } from './state/TeamLibrary';
import { compactOutcomeMessage } from './session/compactOutcome';
import { emptyReplyNotice, parseResponseOutcome } from './backend/emptyReplyOutcome';
import { parseTurnOutcomeReceipt } from './session/turnOutcomeReceipt';
import { toolFactSucceeded } from './backend/toolSummary';
import {
  AgentBackendKind,
  AgentConfig,
  AgentModelParams,
  ContextWindowMeasurement,
  ContextWindowSource,
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
import { ChatDraftMirror } from './views/chatDraftMirror';
import { parseChatTurnTrigger, parseChatVerbatim, parseDelegationCounts } from './views/chatHistory';
import { ApprovalDecisionBroker, ApprovalRequest, ParticipantOutcome, settleOnAbort, showRequestLimitCard, toolApprovalLabel } from './views/approvals';
import {
  AttentionSignal,
  attentionAppearance,
  blockingPrompt,
  installAttentionSignal,
  localReadAttentionKey,
  requireAttention,
  untimedPrompt,
  type PromptWait,
} from './views/attentionSignal';
import {
  ADD_SELECTION_TO_UNODE_COMMAND,
  isAcceptableComposerPayloadLength,
  SelectionComposerPayload,
  SelectionToUnodeActionProvider,
} from './editor/SelectionToUnodeAction';
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
import { FirstUseController, type FirstUseConnectionChoice, type FirstUseControllerDeps } from './firstUse/FirstUseController';
import { FIRST_USE_RECORD_KEY } from './firstUse/firstUseRecord';
import {
  ClaudeCliCheckError, hasInheritedCredential, parseClaudeAuthStatus, type ClaudeCliCheck, type FirstUseCli,
  type FirstUseReadinessProbes,
} from './firstUse/firstUseReadiness';
import { createReadinessService, type CliChoiceOutcome, type ReadinessService } from './firstUse/readinessService';
import { SetupGuidePanel } from './views/SetupGuidePanel';
import type { SetupGuideConnection, SetupGuideCreationChoice, SetupGuideHost, SetupGuideSnapshot } from './views/setupGuideSession';
import { classifyInstall, FIRST_USE_REVEAL_HANDLED_KEY, isReturningUser, revealDecision, type InstallCohort } from './firstUse/installCohort';
import { parseTeamUseRecord, returningTeamChoice, TEAM_LAST_USED_KEY, type ReturningTeamChoice } from './firstUse/returningTeam';
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
import { PersistenceManager, TeamReplacementRecoveryError } from './state/PersistenceManager';
import {
  classifyLegacyWorkspaceStateHost,
  RootScopedWorkspaceState,
} from './state/RootScopedWorkspaceState';
import { BackgroundPersistenceReporter, runBackgroundPersistence } from './state/BackgroundPersistenceReporter';
import {
  ClaudeToolApprovalDecision,
  ClaudeToolApprovalRequest,
} from './backend/ClaudeHeadlessBackend';
import { OpenAICompatBackend } from './backend/OpenAICompatBackend';
import { capabilityProfileForAgent } from './capabilities/CapabilityProfile';
import { ActivationWorkspaceTrustNotice } from './workspaceTrustNotice';
import { EngineOptions, FileDiagnostic } from './backend/Diagnostics';
import { physicalPath, resolveInsideRoot, resolveInsideRootPhysical } from './backend/workspacePath';
import { isPathInsideOrEqual, isPathStrictlyInside } from './backend/pathContainment';
import {
  commitCheckpointRestore,
  currentBytesAsPrepared,
  prepareCheckpointRestore,
  type CheckpointRestoreAuthority,
  type CheckpointRestoreContent,
  type CheckpointRestoreOutcome,
  type PreparedCheckpointRestore,
} from './backend/CheckpointRestore';
import { RawCheckpointStore } from './backend/RawCheckpointStore';
import { PreChangeCheckpoints, rawCheckpointLocation, type PreChangeCheckpoint } from './backend/PreChangeCheckpoints';
import { createUnifiedDiff } from './backend/diff';
import { DEFAULT_WEB_ACCESS_POLICY, SessionWebAccessApprover, WebAccessApprovalRequest, WebAccessDecision, WEB_ACCESS_HUMAN_WINDOW_MS, type WebAccessPolicyGate } from './backend/WebAccessPolicy';
import { UnodeSearchHost } from './backend/UnodeSearchHost';
import { BoundedOperationHistory } from './state/BoundedOperationHistory';
import { UNODE_SEARCH_CALLS_PER_TURN, UNODE_SEARCH_MODEL, UNODE_SEARCH_USES_PER_CALL, unodeSearchDiscountNote } from './backend/UnodeSearchPricing';
import { requireHttpsCustomEndpoint, resolveOpenAICompatBaseUrl, OPENAI_COMPAT_DEFAULT_BASE_URL, ROAM_DEFAULT_BASE_URL, UNODE_DEFAULT_BASE_URL } from './backend/openAICompatBaseUrl';
import { webFetch } from './backend/webFetch';
import { AgentBackend, EgressConsentPending } from './backend/AgentBackend';
import { ReworkContinueOutcome, TaskScopeCapability, TeamRosterEntry } from './backend/TeamTools';
import { offerContinueRework } from './host/orchestration/continueRework';
import { fetchMentionWithReminders } from './session/mentionFetch';
import { prepareAndSubmit, stopPreparing, UserRequestPreparations } from './host/userRequestPreparations';

import type { VerificationSensorKind } from './backend/VerificationPlan';
import {
  constructApprovedExecutionHooks,
  normalizeExecutionHookCandidate,
  type ExecutionHookApprovalRecord,
  type NormalizedExecutionHookCandidate,
} from './backend/ExecutionHooks';
import { FileCoordinator, OptimisticFileCoordinator, NoopFileCoordinator } from './backend/FileCoordinator';
import { type AgentFileWrites, FileWritePolicy, requestEffectPath, targetKey, type OverwriteDecisionRequest, type OverwriteDecision } from './backend/fileWritePolicy';
import { SecurityControlLocationAdapter } from './security/SecurityControlLocations';
import type { SecurityControlArtifactLocation } from './security/SecurityControlArtifacts';
import { redactDiagnosticText, redactSecretText } from './security/diagnosticRedaction';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import type { PreparedOutwardEffect } from './backend/OutwardActionPreparation';
import { gitPathStatus } from './backend/gitPathStatus';
import { WorktreeManager, WORKTREES_DIR } from './backend/WorktreeManager';
import { GitMergeOrchestrator, type MergeAdmission } from './backend/MergeOrchestrator';
import { WorktreeCoordinator } from './backend/WorktreeCoordinator';
import { DEFAULT_COMPLETION_GATE_CONFIG } from './backend/completionGate';
import { spawn as cpSpawn, type SpawnOptions } from 'child_process';
import { randomBytes } from 'crypto';
import {
  exactFileGrantsOnFolderRoute,
  readablePathCeilings,
  resolveEffectiveRoots,
  samePath,
  writeRootsForTrust,
} from './backend/folderAccess';
import { namedOutsidePaths, reachesAnotherComputer } from './host/namedOutsidePaths';
import {
  isImpliedLocalReadRoot,
  localReadRootsForScope,
  fullFileAccessGuidance,
  outsidePathGrantGuidance,
  localReadScopeGuidance,
  offerLocalReadScopeRecovery,
  SessionLocalReadScopeConsent,
  type LocalReadScope,
  type LocalReadScopeConsentGate,
  type LocalReadScopePrompt,
} from './backend/localReadScope';
import { accessPhysicalPath, matchPathAccess } from './backend/localReadScope';
import { codexAccessWithGrants, codexExactFileWrites, codexGrantBoundaryNotice, revokedDuringTurn } from './host/codexLiveGrants';
import { hostShutdown, killProcessTree, killProcessTreeByPid, terminateChildProcessTree, terminateProcessTreeObserved } from './backend/processTree';
import type { CommandPreparationFailure, PreparedDirectCommand } from './backend/CommandExecution';
import { trustedExecutionProvider } from './backend/trustedExecution';
import { createDirectCommandPreparer, directChildren, resolveDeclaredDirectShell } from './backend/DirectCommandExecution';
import { prepareOwnedPythonCache, pythonCacheEnvironment, terminalPythonCacheEnvironment, type OwnedPythonCache } from './backend/PythonCache';
import { sanitizedCommandEnv } from './backend/commandEnv';
import { WorktreePanel, WorktreeReview } from './views/WorktreePanel';
import { confirmWorktreeMerge } from './views/confirmWorktreeMerge';
import { TaskClaimRegistry } from './backend/TaskClaimRegistry';
import {
  CommandPolicy,
  CommandApprovalMode,
  type CommandPolicyInputs,
  SAFE_COMMAND_TEMPLATES,
  effectiveCommandApprovalMode,
} from './backend/CommandPolicy';
import { AgentCommandPolicy } from './backend/AgentCommandPolicy';
import { createAgentCommandPolicy, createClaudeBackend, type ClaudeBackendBaseDeps } from './host/claudeBackendComposition';
import { UnrequestedTurnOffers } from './host/unrequestedTurnOffer';
import { CheckpointOperation, CommandApprovalDecision, CommandApprover, WorkspaceTools, WriteApprover } from './backend/WorkspaceTools';
import type { ContentReceiptObservation } from './content/ContentReceipt';
import {
  formatPromptedCommandLog,
  PromptedCommandLog,
  SerializedPromptedCommandLog,
} from './backend/PromptedCommandLog';
import type { CommandApprovalContext } from './backend/ShellCommandGate';
import {
  autoAllowSegments,
  type CommandShellIdentity,
  grammarDisplayName,
  isPersistedCommandShellGrammar,
  type PersistedCommandShellGrammar,
  reviewedSafeApprovalKeys,
  SessionCommandApprovals,
} from './backend/CommandShell';
import { normalizeRunnerCommand, type ProjectCommandInfo } from './backend/commandNormalize';
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
import { hasUnavailableConnectionRepair, migrateAgentConfigOrRepair, RouteMigrationError } from './routes/RouteMigration';
import {
  assertAgentCapabilityCompatibility,
  capabilityViolations,
  connectionProfileForAgent,
  dropUnsupportedGrants,
  supportedModelParams,
  unsupportedModelParamKeys,
} from './routes/CapabilityGuard';
import {
  AgentRoute,
  assertResolvedRoute,
  coordinatorBriefEgressDestinationKey,
  createResolvedAgentRoute,
} from './routes/RouteContracts';
import {
  CodexAccountModel,
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexBackend,
  type CodexProgramFailure,
} from './backend/CodexBackend';
import {
  codexReadCapable,
  resolveCodexPermissionProfile,
} from './backend/CodexPermissionProfile';
import { AUTONOMY_MENU_LABEL, AUTONOMY_MENU_MODES, AutonomyDefaultConsent, autonomyModeForCodexProfile, isAutonomyMode,
  plainAutonomyLimit, resolveAutonomyPolicy, type AutonomyChoice, type AutonomyMode } from './settings/AutonomyPolicy';
import { fullAccessTargetRoot } from './backend/FullFileAccess';
// Before the module-level session network below: tsc's CommonJS output requires each import where it stands.
import { CodexSessionNetwork } from './host/codexSessionNetwork';

let autonomyDefaults: AutonomyDefaultConsent | undefined;
let autonomyPolicyGeneration = 0;
const agentAutonomyGenerations = new Map<string, number>();
const agentAutonomyDecisionGenerations = new Map<string, number>();
const codexAutonomyPendingTurns = new Map<string, string>();
const codexNativePolicySnapshots = new Map<string, { turnId: string; profile: string; current(): string; pythonCache?: string }>();
/** v0.9.102 (R4a): the writable roots each running native Codex turn started with, and the folders already told gone. */
// v0.9.102 (R2, the Owner 2026-11-12): network a person allowed for a Codex agent from a card, for this window only.
const codexSessionNetwork = new CodexSessionNetwork();
const codexTurnWriteScopes = new Map<string, { turnId: string; scope: import('./backend/CodexBackend').CodexTurnWriteScope; told: Set<string> }>();

/**
 * v0.9.102 (R4a, the Owner's plan A): a grant was made, revoked or ended. A running Codex turn keeps the sandbox it
 * started with, so when a folder it could write in is gone for the next turn, its chat says so once, with the existing
 * Stop. Nothing is asked and nothing is stopped; with no running turn nothing is said.
 */
function noticeCodexGrantBoundaries(): void {
  for (const [agentId, entry] of codexTurnWriteScopes) {
    if (sessionManager?.currentTurnId(agentId) !== entry.turnId) { codexTurnWriteScopes.delete(agentId); continue; }
    const gone = revokedDuringTurn(entry.scope, entry.told);
    if (gone.length > 0) chatViewProvider?.postRuntimeNotice(agentId, codexGrantBoundaryNotice(sessionManager.get(agentId)?.config.name ?? agentId, gone));
  }
}
let securityControlLocations: SecurityControlLocationAdapter | undefined;
const runtimeSecurityControlLocations = new Map<string, readonly SecurityControlArtifactLocation[]>();
let expectedAutonomySetting: { mode: AutonomyMode; generation: number | undefined } | undefined;
let lastAutonomyUserSetting: string | undefined;
let lastAutonomyAdvancedFingerprint = '';
import { codexCheckpointRecords, prepareCodexFileCheckpoints } from './backend/CodexFileChanges';
import { discoverCodexCliCandidates, resolveCodexCliLaunchPath } from './backend/codexCliPath';
import type { CliClosure } from './backend/cliClosure';
import { createCliRuntimeHost, type CliRuntimeHost } from './host/cliRuntimeHost';
import type { ManagedLaunchPlan } from './host/managedCli/managedLauncher';
import { isProgramNotChosen, managedChoice } from './host/cliRuntimeResolver';
import { ManagedCodexActions } from './host/managedCodexActions';
import { reconcilePolicy } from './host/managedCli/qualify/policyReconcile';
import { loadCodexAccountModels } from './backend/CodexModelLoader';
import { runTransientCliUse } from './host/transientCliStart';
import { launchCodexProgram } from './host/codexProgramLaunch';
import { runCliProbe, runCodexCliProbe } from './backend/CodexCliProbe';
import {
  CLI_LATEST_HOST,
  CLI_LATEST_LIMITS,
  classifyCliRuntimeFailure,
  classifyCliSource,
  cliLatestVersionUrl,
  cliProgramStamp,
  cliTerminalShell,
  cliUpdateInstructions,
  compareCliVersions,
  discoverClaudeCliCandidates,
  discoverCodexExtensionCandidates,
  parseClaudeCliVersion,
  parseNpmLatestVersion,
  prepareNeutralFolder,
  readBoundedText,
  renderCliUpdateCommand,
  resolveClaudeCliLaunch,
  type ClaudeCliLaunch,
  type CliRuntimeCandidate,
  type CliRuntimeProvider,
} from './backend/cliRuntime';
import { CodexSelectionChangedError, refreshCodexModels, type CodexModelSelection } from './host/CodexModelRefresh';
import {
  cachedCodexModelsFor,
  CODEX_MODEL_CACHE_KEY_V2,
  EMPTY_CODEX_MODEL_CACHE,
  rememberCodexModels,
  restoreCodexModelCacheV2,
  type CodexModelCacheV2,
} from './backend/codexModelCache';
import {
  chooseCliRuntime,
  CLI_PROVIDER_LABEL,
  type CliLatestLookup,
  type CliRuntimeCheck,
  type CliRuntimeChooserPort,
  type CliRuntimeConfirmation,
  type CurrentCliRuntime,
} from './host/CliRuntimeChooser';
import { verifyCodexCliPreflight } from './backend/CodexCliPreflight';
import { codexApprovalPresentation } from './host/CodexApprovalPresentation';
import { TerminalManager } from './terminal/TerminalManager';
import { affectsTerminalProfile } from './terminal/TerminalShellProfile';
import { deleteRestorePoint,
  Checkpoint,
  CheckpointRawRef,
  CheckpointRestoreDisabledReason,
  CheckpointStore,
  checkpointEvidenceLabel,
  checkpointKeepsText,
  checkpointRestoreDisabledMessage,
  checkpointRestorePlan,
} from './backend/Checkpoints';
import { confirmDangerousCommand, confirmFolderDelete, promptCommandApproval, showBlockedWarning } from './backend/CommandApprovalPrompter';
import { FirstWorkspaceBinding } from './backend/WorkspaceBinding';
import { readResultNoticeStyle, RESULT_NOTICE_STYLE_SETTING, showResultNotice } from './resultNotice';
import { hostNativeSpawnOptions, resolveHostExecutable } from './security/HostExecutableResolver';

import { MCPServerConfig } from './types';
import { MCPHub } from './mcp/MCPHub';
import { SharedOperationLeases, type SharedOperationLease } from './mcp/SharedOperationLeases';
import { SharedPromptWaits } from './session/SharedPromptWaits';
import { withoutIntegrationGrant } from './mcp/IntegrationRemoval';
import { testMcpConnection } from './mcp/McpConnectionTest';
import { raceMcpTestCancellation } from './mcp/McpTestTransport';
import {
  describeIntegrationSkillGrant, IntegrationGrantError, integrationGrantTiming, withDirectIntegrationGrant,
  type IntegrationGrantChange,
} from './mcp/IntegrationGrants';
import { punctuateMountDetail } from './mcp/McpMountNotice';
import { sameMcpMountConfig } from './mcp/McpReconfigure';
import { createRealMcpClient } from './mcp/RealMcpClient';
import { integrationStartNoticeActions, prepareManagedIntegrationsForStart, unavailableIntegrationsNotice } from './mcp/ManagedIntegrationStart';
import { managedMcpServerIdFromToolName } from './mcp/ClaudeMcpConfig';
import { TeamMcpBridge } from './mcp/TeamMcpBridge';
import { SkillResolver, agentMcpGrants } from './roles/SkillResolver';
import { SKILL_LIBRARY } from './roles/RoleConfig';
import { agentBuilderTools, builderCarriesInstanceTools } from './roles/AgentBuilderTools';
import { isExecutePreference } from './roles/BuiltinToolDefaults';
import { AgentRosterEdits } from './host/AgentRosterEdits';
import { migrateLegacyCommandTools, legacyCommandMigrationNotice } from './host/LegacyCommandTools';
import { SkillRegistry } from './skills/SkillRegistry';
import { ExecutableSkillHost, type ExecutableSkillApprovalRequest } from './skills/ExecutableSkillHost';
import { ModelCatalog, ModelInfo } from './models/ModelCatalog';
import { resolveModelCatalogBaseUrl } from './models/modelCatalogBaseUrl';
import { intentionallyUnknownPriceLabel, ModelPricing, ModelPrice } from './models/ModelPricing';
import { SpendHost } from './host/SpendHost';
import { DEFAULT_REQUEST_DECISION_TIMEOUT_MS, normalizeRequestLimits, RequestCeilingGate } from './host/RequestCeiling';
import { agentRequestBoundary } from './host/RequestLimitBinding';
import { RequestLimitMeter } from './host/RequestLimitMeter';
import {
  askRequestLimitDecision,
  type OpenRequestLimitCard,
  type RequestLimitCard,
} from './host/RequestLimitPrompt';
import type { RequestBoundary } from './backend/requestBoundary';
import type { SpendCoordinator, SpendRoute } from './host/SpendCoordinator';
import { displayReferenceProvider, isStoredReferencePriceMode } from './models/spend/PriceResolver';
import { currentTimeZone, parseUserTargets, userTargetsToSettings } from './models/spend/SpendTargets';
import { catalogIsStale } from './models/spend/PriceCatalog';
import { LivePriceService, consentedSources, describeGroupRatio, readPriceGroupSetting, readPriceMultiplierSetting, scopedSources } from './models/LivePriceService';
import {
  AutomaticRefreshCoordinator,
  type AutomaticRefreshSettings,
  filterAutomaticPricingSources,
  providerAutomaticRefreshEnabled,
  readAutomaticRefreshSettings,
  scheduleDailyAutomaticRefresh,
  withGlobalPricingSourcesAutomaticRefresh,
  withProviderAutomaticRefresh,
} from './models/AutomaticRefreshPolicy';
import {
  MetadataHostPlan, describePurposes, planModelPicker, planPriceRefresh, unapprovedHosts,
} from './models/metadataPlan';
import { BalanceService } from './models/BalanceService';
import { repairPriceMultipliers, type PriceMultiplierReadRepairResult } from './models/PriceMultiplierReadRepair';
import { createMetadataTransport } from './host/MetadataTransport';
import { deactivateHost } from './host/HostDeactivation';
import { registerCommand } from './host/CommandRegistration';
import { registerUnodeSidebarViews } from './host/ViewRegistration';
import { vscodeSettings } from './host/VscodeHostPorts';
import { UserRequestEntrance } from './host/UserRequestEntrance';
import { OrchestrationHostAdapter, userTurnSources } from './host/orchestration/OrchestrationHostAdapter';
import { registerOrchestrationCommands } from './host/orchestration/OrchestrationCommandRegistration';
import { SettingsBridge, ProviderDef, ConfigStore } from './settings/SettingsBridge';
import {
  AuthoritySettingKey,
  ignoredWorkspaceAuthorityKeys,
  isAuthoritySettingKey,
  isUserExplicitAuthoritySetting,
  readImageGenerationConnection,
  readImageGenerationModel,
  readReplySuggestionModel,
  readTranscriptionDefault,
  readUnodeSetting,
} from './settings/AuthoritySettings';
import { CANNOT_PROVIDE_SUGGESTIONS, ReplySuggestionService, type SuggestionConnection } from './suggestions/ReplySuggestionService';
import { ProjectCommandApprovals } from './settings/ProjectCommandApprovals';
import { createVSCodeCustomGatewayProfileStore } from './connections/CustomGatewayProfileStoreVscode';
import { CustomGatewayProfileStore } from './connections/CustomGatewayProfileStore';
import { CUSTOM_GATEWAY_REGISTRY_FILE_NAME } from './connections/CustomGatewayProfile';
import { loadCustomGatewayRegistryFailClosed } from './connections/CustomGatewayRegistryLoadContainment';
import { legacyMigrationRosterSignature } from './connections/LegacyMigrationRosterSignature';
import { PersistentLegacyCustomMigrationDeclines } from './connections/PersistentLegacyCustomMigrationDeclines';
import { isCustomGatewayEditBlockedStatus, whenCustomGatewayTurnsEnd } from './connections/CustomGatewayEditGuard';
import { customGatewayEditWaitingMessage, customGatewayRemoveBlockedMessage } from './connections/CustomGatewayHelp';
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
  isPersonsOwnLegacyCustomBinding,
  legacyCustomSecretName,
  pendingLegacyCustomMigrationAgents,
  planLegacyCustomGatewayMigration,
} from './connections/LegacyCustomGatewayMigration';
import { ModelParamResolver, modelParamDefaultLabels, reasoningEffortBaseline } from './params/ModelParamResolver';
import {
  jobContinuationRequest,
  jobOutcomeView,
  projectJobOutcome,
  renderJobOutcomeMarkdown,
  unavailableJobOutcome,
  type JobOutcomeV1,
  type JobOutcomeViewV1,
  type JobUsageLookup,
} from './observability/JobOutcome';
import type { JobOutcomeCardAction } from './views/chatWebviewProtocol';
import { jobOutcomeAnchor } from './observability/JobOutcomeAnchor';
import { jobUsageLookup, noJobUsage } from './observability/JobOutcomeUsage';
import {
  closingTurnCloseout,
  displayedJobOutcomeView,
  projectRequestSummary,
  requestLimitSection,
  type FileRestoreOutcome,
  type RequestChangesObservation,
  type RequestCloseoutRecordV1,
  type RequestSummaryViewV1,
} from './observability/RequestCloseout';
import { RequestCloseoutStore } from './observability/RequestCloseoutStore';
import {
  reviseForDelegationReceipt,
  reviseForFileEffects,
  reviseForLimits,
  reviseForRestore,
  reviseForRunNow,
  type RequestCloseoutRunSource,
} from './session/RequestCloseoutAccumulator';
import { sanitizeParams } from './params/sanitizeModelParams';
import { SettingsPanel, type ManagedCodexCardView } from './views/SettingsPanel';
import { SecurityPanel } from './views/SecurityPanel';
import { ConsentGrantKind, ConsentGrantRegistry, MediaConsentKind } from './security/ConsentGrants';
import { CodexEgressConsent } from './security/CodexEgressConsent';
import { AgentToolAlwaysAllow } from './host/AgentToolAlwaysAllow';
import { codexDeclineKey, ConsentDeclines, mediaDeclineKey, modelDeclineKey, resolveImpliedConsent } from './security/ImpliedConsent';
import {
  inspectRepositoryCliConfig,
  repositoryCliTrustKey,
  repositoryCliTrustMatches,
  repositoryCliTrustRecord,
  workspaceRootForCliCwd,
  type RepositoryAutomationMode,
  type RepositoryCliKind,
  type RepositoryCliLaunchApproval,
  type RepositoryCliTrustRecord,
} from './security/RepositoryCliConfig';
import { describeMediaEgress, MediaEgressRequest, validateMediaEgressRequest } from './media/MediaEgress';
import { MediaCapabilityCache } from './media/MediaCapability';
import { MarketplacePanel, MarketplaceViewState, asMarketplaceTab } from './views/MarketplacePanel';
import type { MemberAddResult } from './views/MemberInstructionsAction';
import {
  AgentBuilderPanel,
  agentBuilderModelOption,
  type AgentBuilderModelOption,
  AgentBuilderSavePayload,
  AgentBuilderViewModel,
  commandNarrowingCeiling,
  type AgentBuilderSmartCompactionForm,
  type AgentBuilderSmartCompactionView,
} from './views/AgentBuilderPanel';
import { CoalescedPanelRefresh } from './views/PanelRefreshControl';
import { MAX_AGENT_ICON_BYTES } from './views/agentIcon';
import { MarketplaceCatalog, MarketplaceInstallAction, CatalogSourceName, McpCatalogEntry } from './marketplace/catalog';
import {
  RawCatalog, resolveCatalog, CATALOG_PUBLIC_KEY_PEM, describeHostedCatalogStatus, lastHostedCatalogOutcome,
} from './marketplace/catalogSource';
import { toAgentConfig, toMcpServerConfig, mountSkillPlaybooks, applyPlaybooks, stripPlaybooks } from './marketplace/install';
import { roleTemplateCatalogEntries } from './marketplace/roleTemplateCatalog';
import {
  createChatExportPayload,
  createMessagesExportPayload,
  parseChatImportPayload,
  parseMessagesImportPayload,
} from './views/transcriptPort';
import { ResultDeliveryHost, resultDeliveryMarkerMatches } from './host/orchestration/ResultDeliveryHost';
import { DocumentRenderer } from './content/document/DocumentRenderer';
import { PresentationRenderer } from './office/PresentationRenderer';
import {
  RunLedger,
  RunPermissionDecision,
  RunPermissionKind,
  RunRouteReceipt,
  type RunHostIdentity,
  type RunOwnershipReconciliationDecision,
  type RunRecord,
} from './observability/RunLedger';
import { recordCheckpointFileChange } from './observability/CheckpointFileChange';
import { projectReviewLoop, reviewLoopSection } from './observability/ReviewLoopProjection';
import { isReviewSetV1 } from './backend/ReviewFindings';
import {
  RUN_OWNER_HEARTBEAT_INTERVAL_MS,
  maintainRunOwnershipTick,
  type RunOwnershipMaintenanceState,
} from './observability/RunOwnershipMaintenance';
import { renderRunEvidencePack, renderWorkerTaskProgressReport } from './observability/RunEvidencePack';
import { buildPortableRunEvidence } from './observability/PortableRunEvidence';
import {
  acceptanceRunPickerDescription,
  markdownRunExportPickerLabel,
  portableRunExportPickerLabel,
  runAcceptanceEvidence,
  runEvidenceExportConfirmation,
} from './views/runCloseoutPresentation';
import { approvalKey, needsApproval, shouldRequireApproval } from './mcp/McpApproval';
import { IntegrationEvidenceStore, integrationLifecycle } from './mcp/IntegrationLifecycle';
import { resolveServerPlaceholders } from './mcp/McpPlaceholders';
import { GuidedMcpTransport, isValidMcpUrl, parseMcpArgumentArray, parseMcpArgs, parseMcpEnvInput } from './mcp/McpForm';
import { DEMO_TASKS } from './state/DemoTasks';
import * as dialogs from './dialogs';
import { DialogDeps } from './dialogs';
/** v0.9.99: messages the person sent that are still being prepared, each cancellable by Stop, removal or clear. */
const userRequestPreparations = new UserRequestPreparations();
/**
 * v0.9.99: every Stop of the person ends the named agents' messages still being prepared, before the session stops. A
 * Send still waiting in a composer for its files ends there first, also one whose click has not reached the host yet.
 */
const stopPreparingMessages = (agentIds: readonly string[] | 'all'): void => {
  chatViewProvider?.stopWaitingSends(agentIds);
  stopPreparing(userRequestPreparations, agentIds === 'all' ? userRequestPreparations.agents() : agentIds,
    (agentId, text) => chatViewProvider?.postNotice(agentId, text));
};

let sessionManager: SessionManager;
/** v0.9.89 spend visibility and reminders (never a request gate). */
let spendHost: SpendHost | undefined;
/** v0.9.94: the optional request limits. With none configured it tracks nothing and every boundary proceeds. */
let requestCeiling: RequestCeilingGate | undefined;
/** v0.9.110: reply suggestions. With the setting None (the default) it sends nothing. */
let replySuggestions: ReplySuggestionService | undefined;
/** v0.9.110: changes whenever the reply suggestion setting changes, so an operation begun under another value ends. */
let replySuggestionSettingsRevision = 0;
/** v0.9.110: the setting revision for which a reply suggestion last reached the egress decision. */
let replySuggestionAskedRevision = -1;
/** The open Dashboard was opened to show Spend: that section renders first until it is opened another way. */
let dashboardFocusSpend = false;
/** Set by unode.openSpend for the showDashboard call it makes. */
let dashboardSpendRequested = false;
/**
 * The one settlement authority for human approvals on every route, card or native modal (v0.9.88). It settles
 * each prompt once, lets a stopped session leave, and reports which sessions are waiting on a person.
 */
const approvalBroker = new ApprovalDecisionBroker({ attention: requireAttention });
/** The v0.9.88 attention signal; installed at activation so every blocking prompt reaches it. */
let attentionSignal: AttentionSignal | undefined;

/** `unode.attentionSound` is an authority setting: only the user's own value counts, so a repository cannot silence it. */
function attentionSoundSetting(): boolean {
  return configuredSetting<boolean>('attentionSound', true) !== false;
}
/** The human window every approval gets, card or modal; the same bound the CLI routes use. */
const HUMAN_APPROVAL_WINDOW_MS = WEB_ACCESS_HUMAN_WINDOW_MS;
/** The public-web prompt currently open, which later concurrent requests join instead of opening another. */
let openWebApprovalId: string | undefined;
let messageBus: MessageBus;
let taskInputResolver: TaskInputResolver;
/** v0.9.97: saved task batches of this workspace, on this machine. */
let taskCheckpointStore: TaskCheckpointStore | undefined;
let orchestrationHost: OrchestrationHostAdapter;
let workflowEngine: WorkflowEngine;
let teamViewProvider: TeamViewProvider;
/**
 * The one declared direct shell of this host (cmd.exe or /bin/sh), resolved per invocation as a host executable that
 * no workspace or worktree supplies, and never `shell: true`. The terminal fallback, background commands and both
 * verifiers use it.
 */
const directCommandPreparer = createDirectCommandPreparer({
  shell: () => resolveDeclaredDirectShell({ resolveExecutable: resolveHostProgram }),
  terminateTree: (proc) => terminateChildProcessTree(proc, { resolveExecutable: resolveHostProgram }),
  pythonCache: currentPythonCache,
  onPythonCacheSource: source => outputChannel?.debug(`Python cache source: ${source}`),
});
const terminalManager = new TerminalManager({
  prepareDirect: directCommandPreparer,
  prepareAgentDirect: (agentId) => createDirectCommandPreparer({
    shell: () => resolveDeclaredDirectShell({ resolveExecutable: resolveHostProgram }),
    terminateTree: proc => terminateChildProcessTree(proc, { resolveExecutable: resolveHostProgram }),
    env: () => sanitizedCommandEnv(pythonCacheEnvironment(process.env, undefined, process.platform,
      sessionManager?.get(agentId)?.config.env).environment),
    pythonCache: () => currentPythonCache(agentId),
    onPythonCacheSource: source => outputChannel?.debug(`Python cache source for ${agentId}: ${source}`),
  })(),
  terminalEnvironment: (agentId) => {
    const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    const setting = vscode.workspace.getConfiguration('terminal.integrated').get<Record<string, string | null>>(`env.${platform}`, {});
    const agentEnvironment = sessionManager?.get(agentId)?.config.env ?? {};
    const cache = currentPythonCache(agentId);
    const result = terminalPythonCacheEnvironment(process.env, setting, cache?.current() ? cache.root : undefined,
      process.platform, agentEnvironment);
    outputChannel?.debug(`Terminal Python cache source for ${agentId}: ${result.source}`);
    return result.environment;
  },
  terminateProcessTree: (pid) => terminateProcessTreeObserved(pid, { resolveExecutable: resolveHostProgram }),
});
const agentPythonCaches = new Map<string, OwnedPythonCache>();
function currentPythonCache(agentId = '@host'): OwnedPythonCache | undefined {
  const storage = extensionContext?.globalStorageUri;
  const roots = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
  const workspaceIdentity = vscode.workspace.workspaceFile?.toString() ?? JSON.stringify(roots);
  const key = JSON.stringify([storage?.fsPath, workspaceIdentity, roots, agentId]);
  const previous = agentPythonCaches.get(key);
  if (previous?.current()) return previous;
  const cache = prepareOwnedPythonCache(storage?.scheme === 'file' ? storage.fsPath : undefined, roots, agentId, workspaceIdentity);
  if (cache) agentPythonCaches.set(key, cache); else agentPythonCaches.delete(key);
  return cache;
}
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
/** v0.9.110: this workspace's canonical task history, opened once per window. */
let taskHistory: HistoryService | undefined;
/** v0.9.110: this extension host's id in every store shared with other windows (history writers, restore points). */
const hostInstanceId = randomUUID();
let hostIdentity: { adapter: ProcessIdentityAdapter; self: () => Promise<ProcessIdentityRecord | undefined> } | undefined;

let fileLeaseRegistry: FileWriterLeases | undefined;

/** v0.9.110: the remote authority's name (`wsl`, `ssh-remote`, …) when this extension host is remote; never anything else. */
function remoteAuthorityName(): string | undefined {
  const name: unknown = vscode.env.remoteName;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/**
 * v0.9.110 R1: the writer lease of each physical file across this host's windows, in its global storage, keyed by the
 * remote authority and the file (not by the workspace's roots). Its process identity is read at the first write.
 */
function fileWriterLeases(): FileWriterLeases | undefined {
  const storageRoot = extensionContext?.globalStorageUri?.fsPath;
  if (!storageRoot) return undefined;
  const identity = () => hostProcessIdentity(storageRoot);
  fileLeaseRegistry ??= new FileWriterLeases(path.join(storageRoot, 'file-leases'), {
    hostInstanceId,
    ...(remoteAuthorityName() ? { remoteAuthority: remoteAuthorityName() } : {}),
    selfIdentity: async () => (await identity()).self(),
    identity: {
      platform: process.platform,
      self: async () => (await identity()).adapter.self(),
      identityOf: async (pid) => (await identity()).adapter.identityOf(pid),
      liveness: async (records) => (await identity()).adapter.liveness(records),
    },
  });
  return fileLeaseRegistry;
}

/**
 * v0.9.110: the named process-identity adapter of this platform and this host's own identity, read once at the first
 * need (never at activation). The Windows query runs in a folder of its own under the system temp folder, so a
 * running query never holds the extension's storage open.
 */
async function hostProcessIdentity(_storageRoot: string): Promise<{ adapter: ProcessIdentityAdapter; self: () => Promise<ProcessIdentityRecord | undefined> }> {
  if (hostIdentity) return hostIdentity;
  const processFolder = path.join(os.tmpdir(), 'unodeai-process-query');
  await fs.mkdir(processFolder, { recursive: true });
  const roots = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath);
  const adapter = processIdentityHost({ windows: { request: { ownedFolder: processFolder, ownedTmp: processFolder, workspaceRoots: roots } } });
  hostIdentity = { adapter, self: cachedSelfIdentity(adapter) };
  return hostIdentity;
}
/** v0.9.96: the saved copy of the Workbench composer's unsent text, over the activation-bound workspace state. */
let chatDraftMirror: ChatDraftMirror | undefined;
// The New Task sidebar and Activity panel are projections of this one host-owned model.
// UX2 will receive the same instance rather than creating another session authority.
const sessionPresentation = new SessionPresentationModel();
let orchestrationProgress: OrchestrationProgressTracker;
/** v0.9.102: publishes each PM's live strip; set once the session manager and the chat exist. */
let pmLive: ReturnType<typeof connectPmLive> | undefined;
let secrets: SecretsManager;
let persistence: PersistenceManager;
let teamVerificationEditor: TeamVerificationEditor;
let teamRosterRevision = 0;
const agentRosterEdits = new AgentRosterEdits({
  members: () => sessionManager.getAll().map(s => s.config),
  revision: () => teamRosterRevision,
  currentWorkspace: () => !workspaceBinding.isStale(),
  persist: members => persistence.saveAgents(members),
  reloadFromFile: async () => {
    const actual = await persistence.loadTeamConfig({ strict: true });
    const saved = persistence.loadAgents();
    const disabled = new Map<string, Pick<AgentConfig, 'mediaModels' | 'publicSearch'>>();
    for (const member of [...saved, ...sessionManager.getAll().map(session => session.config)]) {
      const mediaModels = Object.fromEntries(Object.entries(member.mediaModels ?? {}).filter(([, value]) => value === 'off'));
      if (Object.keys(mediaModels).length === 0 && member.publicSearch !== 'off') continue;
      const previous = disabled.get(member.id);
      disabled.set(member.id, {
        mediaModels: { ...previous?.mediaModels, ...mediaModels },
        ...(previous?.publicSearch === 'off' || member.publicSearch === 'off' ? { publicSearch: 'off' } : {}),
      });
    }
    const recovered = (actual?.members ?? saved).map(member => {
      const off = disabled.get(member.id);
      if (!off) return member;
      const { mediaModels, ...search } = off;
      return { ...member, ...search, ...(Object.keys(mediaModels ?? {}).length
        ? { mediaModels: { ...member.mediaModels, ...mediaModels } } : {}) };
    });
    await sessionManager.prepareRosterReplacement();
    await sessionManager.publishStoppedRoster(agentRosterEdits.overlayUnsavedOff(recovered));
    if (!actual) return 'There is no team file. UnodeAi kept your saved team; you can continue working.';
  },
  notice: message => { void showResultNotice('warning', message); },
});
let rootWorkspaceState: RootScopedWorkspaceState;
/** v0.9.99: each Claude agent's "Always allow this tool" answers, kept in this project's storage. */
let agentToolAlwaysAllow: AgentToolAlwaysAllow | undefined;
/** v0.9.99: the host's content asset store, so a removed agent's request hold is released with it. */
let contentAssetStore: ContentAssetStore | undefined;
/** Settled coordinator results that have not yet reached await_tasks or an auto-wake turn. */
let resultDeliveryHost: ResultDeliveryHost;
let documentRenderer: DocumentRenderer;
let presentationRenderer: PresentationRenderer;
let localApplications: LocalApplicationCatalog;
let nativeOfficeRenderer: NativeOfficeRenderer;
/** v0.9.108 (D11): "My signature" and signature provenance records under extension storage. */
let pdfSignatures: PdfSignatureStore | undefined;
let workbookRecalcEngine: WorkbookRecalcEngine | undefined;
let imageConnections: ImageConnectionRegistry | undefined;
let imageGeneration: ImageGenerationHost | undefined;
let transcriptionHost: TranscriptionHost | undefined;
const verifiedTranscriptionUploadBytes: Readonly<Record<UnodeTranscriptionModel, number>> = {
  'gpt-transcribe': TRANSCRIPTION_MAX_BYTES,
  'whisper-1': TRANSCRIPTION_MAX_BYTES,
};

function verifiedUnodeTranscriptionModel(model: MediaModel): model is MediaModel & { modelId: UnodeTranscriptionModel } {
  return model.connectionId === 'unode' && Object.hasOwn(verifiedTranscriptionUploadBytes, model.modelId);
}
function selectedImageConnection(): string | undefined {
  return readImageGenerationConnection(vscode.workspace.getConfiguration('unode'));
}
let imageDefaultUpdate: Promise<void> | undefined;

function saveImageDefault(model: MediaModel | undefined): Promise<void> {
  if (!imageDefaultUpdate && selectedImageConnection() === model?.connectionId
    && (!model || readImageGenerationModel(vscode.workspace.getConfiguration('unode')) === model.modelId)) return Promise.resolve();
  const save = (imageDefaultUpdate ?? Promise.resolve()).catch(() => undefined).then(async () => {
    if (model && imageConnections?.modelForConnection(model.connectionId) !== model.modelId) return;
    const previousConnection = selectedImageConnection();
    const previousModel = readImageGenerationModel(vscode.workspace.getConfiguration('unode'));
    const modelChanged = model && model.modelId !== previousModel;
    try {
      if (modelChanged) await updateUserAuthoritySetting('imageGenerationModel', model.modelId);
      await updateUserAuthoritySetting('imageGenerationConnection', model?.connectionId ?? '');
    } catch (error) {
      if (modelChanged && selectedImageConnection() === previousConnection
        && readImageGenerationModel(vscode.workspace.getConfiguration('unode')) === model.modelId) {
        await Promise.resolve(updateUserAuthoritySetting('imageGenerationModel', previousModel ?? '')).catch(() => undefined);
      }
      throw error;
    }
  });
  imageDefaultUpdate = save;
  imageConnections?.refresh();
  return save.finally(() => {
    if (imageDefaultUpdate !== save) return;
    imageDefaultUpdate = undefined;
    imageConnections?.refresh();
  });
}
/** Durable, run-scoped mechanical observations. Exported independently from the rolling message log. */
let runLedger: RunLedger;
/** v0.9.94: the durable request closeout records. The session manager's events write them; Chat reads them. */
let requestCloseoutStore: RequestCloseoutStore | undefined;
let runHostIdentity: RunHostIdentity;
let runOwnershipMaintenanceState: RunOwnershipMaintenanceState;
/** Serialize workspaceState writes so a result cannot be resurrected by an earlier retain write. */
let fileCoordinator: FileCoordinator;
/** v0.9.97: the one write policy every route of this workspace asks before a structured file change. */
let fileWritePolicy: FileWritePolicy;
/** v0.9.97: each agent's view of that policy, which also says where a file is relative to the agent's own folder. */
const agentFileWrites = new Map<string, AgentFileWrites>();
/**
 * v0.9.108 (L1): what the person's Export PDF needs of each agent: its authority, approvals and live restrictions, from
 * which every export builds host tools of its own (personOfficeExport). Never the agent's model tools.
 */
const agentPersonPdfExports = new Map<string, () => PersonPdfExportPorts>();
/** What each agent offers the person for a path it could not reach. */
const agentPathAccessOffers = new Map<string, (named: string, cause?: import('./host/PathAccessOffer').PathAccessOfferCause, access?: 'read' | 'readwrite', consumer?: { agentId: string; handle?: string }) => void>();
/**
 * v0.9.101 (G3): the retries of tasks a refused file call stopped, and (H2a) the work that waits for access. In memory:
 * a reload issues nothing again and accepts no ref from before it; the run ledger keeps only what the outcome says.
 */
const taskResumeRefs = new TaskResumeRefs({
  openDelegationOf: (agentId) => runLedger?.activeDelegation(sessionManager?.currentTurnCorrelationId(agentId), agentId),
  grantsFor: (requestId) => localReadScopeConsent?.pathAccessFor(requestId) ?? [],
  predecessor: (coordinatorId, handle) => runLedger?.resumePredecessor(coordinatorId, handle),
  currentRequestOf: (coordinatorId) => sessionManager?.currentRequestId(coordinatorId),
  // v0.9.101 (H2a; the Owner 2026-11-07): a waiting dispatch can run when its selected teammate can read each input and
  // write each required output, by the facts admission uses. (H2b) A waiting save needs its destination written and its
  // sources read. Folder Access is a limit no grant changes. Existence is not access: the step reports a missing file.
  needMet: (candidateId, requestId, need) => {
    const config = sessionManager?.get(candidateId)?.config;
    return config && orchestrationHost ? orchestrationHost.accessNeedMet(config, need, requestId) : false;
  },
  // v0.9.101 (the access table, R2 §1): a waiting step's needs are rows of its own consumer; readiness reads them.
  needRows: {
    declare: (requestId, consumer, needs, step) => accessTable.transact(() => {
      for (const need of needs) {
        accessTable.addNeed(requestId, need.target, consumer, need.access,
          step === 'save' ? (need.access === 'readwrite' ? 'save' : 'source') : need.access === 'readwrite' ? 'output' : 'input');
      }
    }),
    state: (requestId, consumer, need) => accessTable.needState(requestId, need.target, consumer),
    drop: (requestId, consumer) => accessTable.dropConsumer(requestId, consumer),
    close: (requestId, reason) => accessTable.setLifecycle(requestId, 'closed', accessCloseReason(reason)),
  },
  // v0.9.101 (H2b): a kept draft's sources, read under its owner's live authority in the request, never a new grant.
  checkSource: async (ownerId, requestId, digests) => {
    const config = sessionManager?.get(ownerId)?.config;
    return config && orchestrationHost ? orchestrationHost.checkTaskSource(config, requestId, digests)
      : { state: 'unreadable', physical: digests[0]?.physical ?? '', inputId: digests[0]?.inputId ?? '' };
  },
  waitChanged: (change) => {
    // v0.9.101 (the access table, R2 §2): the request's lifecycle row changes with its wait; a wait that ends with its
    // request closes it, and what was still missing at that moment is kept.
    try {
      if (change.ended?.closeNow) accessTable.setLifecycle(change.requestId, 'closed', accessCloseReason(change.ended.reason));
      else if (!change.ended) accessTable.setLifecycle(change.requestId, change.needs.length ? 'waiting' : 'running');
    } catch { /* The marker below still records the wait. */ }
    runLedger?.updateAwaitingAccess({
      coordinatorId: change.coordinatorId,
      correlationId: change.correlationId,
      needs: change.needs.map((need) => ({ label: need.label, path: need.target, access: need.access, step: need.step,
        ...withState(accessTable.targetState(change.requestId, need.target)) })),
      ...(change.ended ? { ended: change.ended } : {}),
      ...(change.abandoned ? { abandoned: change.abandoned } : {}),
    });
    // Saved at once: a reload has to find the wait to say what it waited for.
    void persistRunLedger().catch((error) => outputChannel.warn(`[run-ownership] run snapshot save failed: ${String(error)}`));
  },
});
/**
 * v0.9.101 (H2a, H3): the file access items of every request, shared by every agent's offer: one item per request and
 * target. A grant on one first lets the waiting work it makes runnable be owed its wake, then tells the item's own
 * participants.
 */

/**
 * v0.9.101 (the access table; the Owner, 2026-11-07): the project's one record of what each request needs outside the
 * workspace, what is granted and what is still missing. Its grant rows are the deliberate grants (the consent store reads
 * and writes them through its own API); its state rule is the adapter's `judgeAccess`; views read its rows. It is a
 * record, never authority: every file call is still checked at the moment of use.
 */
const accessTable = new AccessTable({
  judge: (consumer, requestId, named, needed, observed) => {
    const config = sessionManager?.get(consumer.agentId)?.config;
    if (!config || !orchestrationHost) return { state: 'missing', effective: 'none', source: 'none', granted: 'none', grantIds: [] };
    return orchestrationHost.judgeAccess(config, requestId, named, needed, observed);
  },
  identity: (named) => {
    if (reachesAnotherComputer(path.resolve(named))) return undefined;
    try { return accessPhysicalPath(named); } catch { return undefined; }
  },
  remote: (named) => reachesAnotherComputer(path.resolve(named)),
  isDirectory: (named) => statSync(named, { throwIfNoEntry: false })?.isDirectory(),
});

/**
 * v0.9.101 (H2a, H3): the file access items of every request, shared by every agent's offer, drawn from the access table's
 * rows. A grant on one first lets the waiting work it makes runnable be owed its wake, then tells the item's participants.
 */
const requestAccessItems = new PathAccessRequestItems({ granted: () => queueAccessWakes() }, accessTable);

/**
 * v0.9.101 (the access table, R2 §5): a waiting request's status line is a view of its rows not met. Redrawn in place on
 * the reply that showed the wait, by its request and turn, never "the latest reply"; it stops once the request no longer
 * waits, so it never overwrites Running, Complete or Stopped.
 */
/** v0.9.101 (R1 §2.4): the table is kept in the workspace's storage, as a record; saved shortly after each change. */
const ACCESS_TABLE_KEY = 'unode.accessTable.v1';
let accessTableSave: ReturnType<typeof setTimeout> | undefined;
let accessTableStore: { update(key: string, value: unknown): Thenable<void> } | undefined;
accessTable.onChange(() => {
  if (!accessTableStore || accessTableSave) return;
  accessTableSave = setTimeout(() => {
    accessTableSave = undefined;
    void Promise.resolve(accessTableStore?.update(ACCESS_TABLE_KEY, accessTable.toSnapshot()))
      .catch((error) => outputChannel?.warn(`[access-table] save failed; this window keeps its table: ${String(error)}`));
  }, 500);
});

// v0.9.101 (the access table): the run marker records each need's state as it is now.
accessTable.onChange((change) => taskResumeRefs.restated(change.requests));

/** v0.9.101 (the access table): how a wait's end closes its request's row. */
function accessCloseReason(reason: string): import('./host/AccessTable').RequestCloseReason {
  return reason === 'stopped' || reason === 'abandoned' || reason === 'coordinator-gone' || reason === 'reload' ? reason : 'done';
}

function withState(state: import('./host/AccessTable').NeedState | undefined): { state?: import('./host/AccessTable').NeedState } {
  return state ? { state } : {};
}

/** v0.9.101: something the access table's state rule reads changed: every live row, or one agent's, is judged again. */
function accessInputsChanged(agentId?: string): void {
  try { accessTable.inputsChanged(agentId); } catch { /* The next event judges again; each call is checked at use anyway. */ }
  // A step this made runnable is owed its wake, as after a grant on an item.
  queueAccessWakes();
  queueMicrotask(recheckNativeRenderAuthorities);
}

/**
 * v0.9.101 (H2a, audit H2a-1): the person replaced the coordinator's model or connection. Its waiting work ends as
 * "coordinator gone", and so do the request grants of the requests that ended with it, as on its removal
 * (`session.removed` below does the same).
 */
function endCoordinatorWaits(coordinatorId: string): void {
  for (const requestId of taskResumeRefs.endCoordinator(coordinatorId, 'coordinator-gone')) {
    accessTable.setLifecycle(requestId, 'closed', 'coordinator-gone');
    localReadScopeConsent.endPathAccessRequest(requestId);
  }
}

/** v0.9.101 (H2a): access changed. Each waiting task whose next step can now run is owed one wake of its coordinator. */
function queueAccessWakes(): void {
  for (const wake of taskResumeRefs.readyWakes()) sessionManager?.queueAccessWake(wake.coordinatorId, wake);
}
/** v0.9.97: this workspace's raw-byte restore points, kept before a host change replaces or removes a file. */
let preChangeCheckpoints: PreChangeCheckpoints | undefined;
/** Worktree fan-out (v0.6.x): isolates eligible agents in per-agent worktrees + merges them back. */
let worktreeCoordinator: WorktreeCoordinator | undefined;

/** Shared across all coordinator agents so parallel file-ownership claims are workspace-global. */
const taskClaims = new TaskClaimRegistry();
let commandPolicy: CommandPolicy;
let mcpHub: MCPHub;
let modelCatalog: ModelCatalog | undefined;
/** v0.9.96: Codex account models per program and version; the 0.9.95 list keyed by version alone is not read. */
let codexModelCache: CodexModelCacheV2 = EMPTY_CODEX_MODEL_CACHE;
/** v0.9.96: the CLI versions UnodeAi measured, by program. A check starts that program; listing never does. */
const CLI_RUNTIME_CHECKS_KEY = 'unode.cliRuntimeChecks.v1';
let cliRuntimeChecks: CliRuntimeCheck[] = [];
/** v0.9.96: the latest published version of each CLI, as last looked up on npm with the user's consent. */
const CLI_LATEST_VERSIONS_KEY = 'unode.cliLatestVersions.v1';
let cliLatestVersions: Partial<Record<CliRuntimeProvider, { version: string; checkedAt: string }>> = {};
/** A lookup younger than this is reused, so one action does not ask npm twice. */
const CLI_LATEST_REUSE_MS = 10 * 60_000;
/** v0.9.96: the Claude CLI program each agent's current process was started with. */
const claudeLaunchByAgent = new Map<string, ClaudeCliLaunch>();
/** v0.9.96: provider errors already offered a CLI repair, so one failure is offered once. */
const offeredCliRepairs = new Set<string>();
/** v0.9.97: the resolver every CLI start goes through, the external adoptions and, where offered, managed Codex. */
let cliRuntime: CliRuntimeHost | undefined;
let managedCodexActions: ManagedCodexActions | undefined;
/** The closures Check / choose CLI hashed for its facts, kept until the person's answer records an adoption. */
const chooserClosures = new Map<string, CliClosure>();

/** Every folder an agent may write or reach through Folder Access: none of them may reach UnodeAi's CLI store. */
function agentReachOfStore(): { writeRoots: string[]; folderAccessGrants: string[] } {
  const workspace = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  const sessions = sessionManager?.getAll() ?? [];
  return {
    writeRoots: [...workspace, ...sessions.map((session) => session.config.workingDirectory).filter((folder): folder is string => !!folder)],
    folderAccessGrants: sessions.flatMap((session) => (session.config.folderAccess ?? []).map((grant) => grant.path)),
  };
}

/** The managed Codex part of the Codex CLI card, or undefined where this host does not offer managed Codex. */
function managedCodexPanel(): ManagedCodexActions | undefined {
  if (managedCodexActions) return managedCodexActions;
  let host: CliRuntimeHost;
  try {
    host = cliRuntimeHost();
  } catch {
    return undefined;
  }
  const managed = host.managed;
  if (!managed) return undefined;
  managedCodexActions = new ManagedCodexActions(managed, {
    ask: (title, lines, buttons) => askManagedCodexQuestion(title, lines, buttons),
    inform: (kind, text) => { void (kind === 'warning' ? showResultNotice('warning', text) : showResultNotice('information', text)); },
    refresh: () => SettingsPanel.refreshCurrent(),
    forgetAdoptions: () => host.forgetAdoptions(),
    storeFolder: managed.roots.root,
    formatTime: (iso) => onSystemClock(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  });
  hostShutdown.onBegin(() => managedCodexActions?.dispose());
  return managedCodexActions;
}

/**
 * The questions of the managed Codex card, each with fixed buttons and Not now first. Every one answers an action the
 * person chose on the card; an unknown set of buttons is refused, not shown.
 */
async function askManagedCodexQuestion(title: string, lines: readonly string[], buttons: readonly string[]): Promise<string | undefined> {
  const detail = lines.join('\n');
  switch (buttons.join('|')) {
    case 'Use external CLI': {
      const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, 'Not now', 'Use external CLI');
      if (choice !== 'Use external CLI') return undefined;
      return choice;
    }
    case 'Reset managed Codex': {
      const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, 'Not now', 'Reset managed Codex');
      if (choice !== 'Reset managed Codex') return undefined;
      return choice;
    }
    case 'Set up and keep it updated|Set up, update only when I ask': {
      const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, 'Not now', 'Set up and keep it updated', 'Set up, update only when I ask');
      if (choice !== 'Set up and keep it updated' && choice !== 'Set up, update only when I ask') return undefined;
      return choice;
    }
    case 'Allow and use for new sessions': {
      const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, 'Not now', 'Allow and use for new sessions');
      if (choice !== 'Allow and use for new sessions') return undefined;
      return choice;
    }
    case 'Check again': {
      const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, 'Not now', 'Check again');
      if (choice !== 'Check again') return undefined;
      return choice;
    }
    case 'Try again': {
      const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, 'Not now', 'Try again');
      if (choice !== 'Try again') return undefined;
      return choice;
    }
    case 'Go back': {
      const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, 'Not now', 'Go back');
      if (choice !== 'Go back') return undefined;
      return choice;
    }
    case 'Confirm these settings|Use external CLI': {
      const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, 'Not now', 'Confirm these settings', 'Use external CLI');
      if (choice !== 'Confirm these settings' && choice !== 'Use external CLI') return undefined;
      return choice;
    }
    case 'Forget them': {
      const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, 'Not now', 'Forget them');
      if (choice !== 'Forget them') return undefined;
      return choice;
    }
    case '':
      // Details: facts to read, with nothing to decide.
      await showResultNotice('information', title, detail);
      return undefined;
    default:
      outputChannel.warn(`Managed Codex asked a question UnodeAi has no buttons for (${buttons.join(', ')}); nothing was asked.`);
      return undefined;
  }
}

/**
 * With automatic updates on, a version the background download checked is announced once in this window. Review opens
 * the question for exactly that version; nothing runs without the OK there.
 */
async function offerManagedCodexReview(key: string, version: string): Promise<void> {
  const view = cliRuntime?.managed?.control.read();
  if (!view || view.kind !== 'readable' || !view.snapshot.record.scheduler.autoMode) return;
  const choice = await vscode.window.showInformationMessage(`Codex ${version} is downloaded and checked. It runs only after your OK.`, 'Review', 'Not now');
  if (choice !== 'Review') return;
  const panel = managedCodexPanel();
  if (!panel) return;
  panel.card();
  await panel.act('review', key);
}

/**
 * After a managed Codex version failed to start an agent at the program's own level: the one check of that version,
 * and what it found. The agent's start stays failed; nothing is started again for it.
 */
async function checkManagedCodexAfterStartFailure(plan: ManagedLaunchPlan, failure: CodexProgramFailure, agentName: string): Promise<void> {
  const managed = cliRuntime?.managed;
  if (!managed) return;
  const version = plan.entry.version;
  outputChannel.warn(`Managed Codex ${version} did not start for ${agentName} (${failure.detail}). UnodeAi checks that version once more; the agent is not started again.`);
  let outcome: Awaited<ReturnType<typeof managed.afterAgentStartFailure>>;
  try {
    outcome = await managed.afterAgentStartFailure(plan.storeId, plan.key, failure);
  } catch (error) {
    outputChannel.warn(`UnodeAi could not check managed Codex ${version} after the failed start (${error instanceof Error ? error.message : String(error)}). Nothing was marked.`);
    return;
  }
  switch (outcome.outcome) {
    case 'local-bad':
      void showResultNotice('warning', `Managed Codex ${version} failed to start for ${agentName}, and UnodeAi's check of it failed too, so it is marked bad on this computer and new sessions do not use it. See the Codex card in Settings.`);
      break;
    case 'stop-unconfirmed':
      void showResultNotice('warning', `Managed Codex ${version} failed to start for ${agentName}, and UnodeAi could not confirm that its check ended, so new sessions do not use it until you choose Check again on the Codex card.`);
      break;
    case 'environmental':
      outputChannel.warn(`Managed Codex ${version} passed UnodeAi's check, so the failed start of ${agentName} came from its setting, login or workspace (${outcome.detail}). The version was not marked.`);
      break;
    case 'not-checked':
      outputChannel.warn(`Managed Codex ${version} was not checked after the failed start (${outcome.detail}). Nothing was marked.`);
      break;
  }
  SettingsPanel.refreshCurrent();
}

function managedCodexCardView(): ManagedCodexCardView | undefined {
  const panel = managedCodexPanel();
  if (!panel) return undefined;
  try {
    return panel.card();
  } catch (error) {
    return { title: 'Cannot be read now', lines: [error instanceof Error ? error.message : String(error)], actions: [] };
  }
}

/**
 * At activation: an interrupted Reset is completed, versions the bundled policy now marks bad are recorded so, the
 * updater's schedule begins, and the store is tidied 5 minutes later and then once a day. Nothing here downloads or
 * starts a program at once.
 */
function startManagedCodex(): void {
  let managed: CliRuntimeHost['managed'];
  try {
    managed = cliRuntimeHost().managed;
  } catch (error) {
    outputChannel.warn(`UnodeAi's CLI programs could not be prepared: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!managed) return;
  const store = managed;
  const enrolled = (): boolean => {
    const view = store.control.read();
    return view.kind === 'readable' && view.snapshot.record.enrolledStoreId !== null;
  };
  if (!enrolled()) return;
  void (async () => {
    try {
      await store.ready;
      await store.store.completePendingReset();
      await reconcilePolicy({ control: store.control, instance: store.instances }, store.policy, () => new Date().toISOString());
    } catch (error) {
      outputChannel.warn(`Managed Codex could not be checked at start: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (hostShutdown.started) return;
    store.updater.start();
    const tidy = (): void => {
      if (hostShutdown.started) return;
      void store.store.collect().catch((error) => outputChannel.warn(`Managed Codex store clean-up: ${String(error)}`));
    };
    const first = setTimeout(() => {
      tidy();
      const daily = setInterval(tidy, 24 * 60 * 60_000);
      hostShutdown.onBegin(() => clearInterval(daily));
    }, 5 * 60_000);
    hostShutdown.onBegin(() => clearTimeout(first));
  })();
}

/**
 * v0.9.99: the person's Run anyway choices for CLI versions a UnodeAi release marked bad. Each names the exact files
 * (closure digest) and the bad-list entry it overrode, so a new bad-list entry or other files ask again.
 */
const CLI_RUN_ANYWAY_KEY = 'unode.cliRunAnyway.v1';
interface CliRunAnywayRecord { provider: CliRuntimeProvider; closureDigest: string; compatibilityPolicyId: string; decidedAt: string }

function cliRunAnywayRecords(): CliRunAnywayRecord[] {
  const raw = extensionContext?.globalState.get<unknown>(CLI_RUN_ANYWAY_KEY);
  return Array.isArray(raw) ? raw.filter((entry): entry is CliRunAnywayRecord => !!entry && typeof entry === 'object'
    && ((entry as CliRunAnywayRecord).provider === 'claude-cli' || (entry as CliRunAnywayRecord).provider === 'codex-cli')
    && typeof (entry as CliRunAnywayRecord).closureDigest === 'string' && typeof (entry as CliRunAnywayRecord).compatibilityPolicyId === 'string') : [];
}

async function recordCliRunAnyway(provider: CliRuntimeProvider, closureDigest: string, compatibilityPolicyId: string): Promise<void> {
  if (!extensionContext) throw new Error('UnodeAi extension storage is unavailable.');
  const others = cliRunAnywayRecords().filter((record) => !(record.provider === provider && record.closureDigest === closureDigest));
  await extensionContext.globalState.update(CLI_RUN_ANYWAY_KEY,
    [...others, { provider, closureDigest, compatibilityPolicyId, decidedAt: new Date().toISOString() }].slice(-32));
}

function cliRuntimeHost(): CliRuntimeHost {
  if (cliRuntime) return cliRuntime;
  const storage = extensionContext?.globalStorageUri.fsPath;
  if (!storage) throw new Error('UnodeAi extension storage is unavailable.');
  cliRuntime = createCliRuntimeHost({
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    extensionVersion: unodeVersion || 'dev',
    globalStorage: storage,
    workspaceRoots: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    agentReach: agentReachOfStore,
    checkFolder: () => cliCheckFolder(),
    externalProgram: (provider) => {
      if (provider === 'claude-cli') {
        const launch = currentClaudeLaunch();
        return { executable: launch.executable, shell: launch.shell };
      }
      return { executable: configuredCodexCliPath(), shell: false };
    },
    physical: (file) => realpathSync.native(file),
    chooseProgram: (provider) => chooseMissingCliProgram(provider),
    agentEnv: () => process.env,
    pins: {
      load: (sessionId) => persistence.loadRuntimePin(sessionId),
      save: (sessionId, pin) => persistence.saveRuntimePin(sessionId, pin),
    },
    runAnyway: (provider, closureDigest, compatibilityPolicyId) =>
      cliRunAnywayRecords().some((record) => record.provider === provider && record.closureDigest === closureDigest
        && record.compatibilityPolicyId === compatibilityPolicyId),
    // A question raised by an agent's start pauses that agent's turn clock; one the person opened waits for them.
    windowAllowed: () => vscode.workspace.isTrusted && !workspaceBinding.isStale(),
    shutdown: hostShutdown,
    onManagedVersionVerified: (key, entry) => { void offerManagedCodexReview(key, entry.version); },
    onManagedTask: (event) => managedCodexPanel()?.taskEvent(event),
    log: (line) => outputChannel.warn(line),
  });
  return cliRuntime;
}
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
  MarketplacePanel.refreshCurrent();
  SetupGuidePanel.refreshCurrent();
});
let rulesFile: RulesFile | undefined;
let teamPolicyStore: TeamPolicyStore;
let projectKnowledge: ProjectKnowledge | undefined;
let teamRulesRosterSyncTimer: ReturnType<typeof setTimeout> | undefined;
let sharedMemory: SharedMemory | undefined;
let memoryAttestationStore: MemoryAttestationStore | undefined;
let projectConventions: ProjectConventions | undefined;
let projectCommandApprovals: ProjectCommandApprovals;
let integrationEvidenceStore: IntegrationEvidenceStore | undefined;
let workspaceBinding: FirstWorkspaceBinding;
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
    authorReportedModelId: facts.authorReportedModelId,
    reviewerIdentity,
  });
  if (decision.allowed) taskInputResolver.recordReviewAdmission(attempt.attemptId, decision);
  return decision;
}
/** Team-level MCP server registry (id -> config), loaded from host-owned workspaceState. */
const mcpRegistry = new Map<string, MCPServerConfig>();
/**
 * v0.9.99 (A8): how long an agent's start waits for granted integrations that are still connecting before it goes
 * ahead without them. Never a failure: they keep connecting in the background.
 */
const MCP_START_READINESS_WAIT_MS = 45_000;
const mcpMountLeases = new SharedOperationLeases<string, 'mounted' | 'skipped' | 'error'>();
/**
 * One mount approval decides for every agent start that is waiting on that server. The decision is shared; the
 * time each start waits for it is that agent's own, and is kept out of the queue time of its request.
 */
const mcpMountWaits = new SharedPromptWaits({
  approvalStarted: (sessionId, approvalId) => sessionManager.approvalStarted(sessionId, approvalId),
  approvalFinished: (sessionId, approvalId) => sessionManager.approvalFinished(sessionId, approvalId),
});
const mcpMountDetails = new Map<string, string>();
const mountedIntegrationFingerprints = new Map<string, string>();
interface IntegrationTestRecord {
  fingerprint: string;
  controller: AbortController;
  state: 'running' | 'passed' | 'failed' | 'cancelled';
  detail: string;
}
const integrationTests = new Map<string, IntegrationTestRecord>();
const removingIntegrations = new Set<string>();
const activeIntegrationTests = new Map<IntegrationTestRecord, Promise<void>>();
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
  // By whole segments: a file under `..cache/` is listed, and a file of another workspace folder, even on another
  // drive where the relative path comes out absolute, is not.
  const rels = uris
    .filter((u) => isPathStrictlyInside(root, u.fsPath))
    .map((u) => path.relative(root, u.fsPath).split(path.sep).join('/'))
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
let runOwnerHeartbeatTimer: NodeJS.Timeout | undefined;
let runOwnershipMaintenanceInFlight = false;

/** One Output channel per agent, holding that agent's own transcript (assistant text + tools). Keyed by id,
 *  but the resolved NAME is kept too — see getAgentChannel: a channel cannot be renamed, so we rebuild it
 *  when the name it was created with turns out to be wrong. */
const agentChannels = new Map<string, { name: string; channel: vscode.OutputChannel }>();

/** A delegation card's name for an agent; an id the roster no longer has reads as removed, never as a bare id. */
function resolveDelegationAgentName(id: string): string {
  if (id === 'user' || id === '*' || id === 'workflow' || sessionManager?.get(id)) {
    return resolveAgentName(id);
  }
  return `Removed agent (${id.slice(0, 8)})`;
}

/** Push the tracker's cards to every surface that shows them. */
function publishDelegationProgress(): void {
  const summaries = orchestrationProgress.snapshot();
  chatViewProvider?.setDelegationProgress(summaries);
  messageLogProvider?.setDelegationProgress(summaries);
  teamViewProvider?.setDelegationProgress(orchestrationProgress.agentStates());
}

function resolveAgentName(id: string): string {
  if (id === 'user') { return 'You'; }
  if (id === '*') { return 'everyone'; }
  if (id === 'workflow') { return 'Workflow'; }
  return sessionManager?.get(id)?.config.name ?? id;
}

function marketplaceViewState(): MarketplaceViewState {
  const root = firstWorkspaceRoot();
  const mounted = new Set(mcpHub.listServers().map((server) => server.id));
  const integrations: MarketplaceViewState['integrations'] = {};
  for (const config of mcpRegistry.values()) {
    const approved = !shouldRequireApproval(config)
      || (!!root && approvedMcp.has(approvalKey(config, root)));
    integrations[config.id] = integrationLifecycle({
      configured: true,
      approved,
      mounted: mounted.has(config.id),
      evidence: integrationEvidenceStore?.evidenceFor(config),
    });
  }
  const agents = sessionManager.getAll().map(({ config }) => config);
  const ownedIntegrations = [...mcpRegistry.values()].map((config) => {
    const grants = agents
      .filter((agent) => effectiveIntegrationGrants(agent).some((grant) => grant.serverId === config.id))
      .map(({ id, name }) => ({ id, name }));
    const pending = mcpMountLeases.has(integrationMountKey(config));
    const reason = persistence.integrationConfigNeedsRepair(config.id)
      ? 'Saved configuration could not be verified. Open Edit to review and save.'
      : mcpMountDetails.get(config.id);
    const repair = persistence.integrationGrantRepairs().find(entry => entry.serverId === config.id);
    const test = integrationTests.get(config.id);
    return {
      id: config.id,
      name: config.name,
      connection: pending
        ? 'awaiting approval' as const
        : mounted.has(config.id)
          ? 'mounted' as const
          : reason
            ? 'failed' as const
            : 'unmounted' as const,
      ...(reason ? { reason } : {}),
      grantedAgents: grants,
      ...(repair ? { pausedDirectGrants: repair.agentIds.map(id => agents.find(agent => agent.id === id)?.name ?? id) } : {}),
      ...(test?.fingerprint === integrationMountKey(config) ? { test: { state: test.state, detail: test.detail } } : {}),
    };
  });
  return {
    agents: agents.map((config) => ({
      id: config.id,
      name: config.name,
      roleTemplateKey: config.roleTemplateKey,
      systemPromptSource: config.systemPromptSource,
    })),
    integrations,
    ownedIntegrations,
  };
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
/** v0.9.106 (first use): the host side of the first goal; undefined until the chat view exists. */
let firstUseController: FirstUseController | undefined;
/** v0.9.106 (first use, §3.5): what this profile held before this activation wrote anything. */
let installCohort: Promise<InstallCohort> | undefined;
/** v0.9.106 (first use, §3.8): the guarded saved-team open path, for the direct "Load your team" action. */
let openSavedTeamForFirstUse: ((ref: TeamLibraryRef) => Promise<AgentConfig[]>) | undefined;
const warnedUnsupportedDefaultProviderIds = new Set<string>();
const consentGrants = new ConsentGrantRegistry();
/** v0.9.99: destinations the person revoked or declined; only these are asked about again before sending. */
const consentDeclines = new ConsentDeclines();
/** Process-lifetime local-read decisions; initialized during activation before backends or commands use it. */
let localReadScopeConsent: SessionLocalReadScopeConsent;
/** The one entrance of a top-level request the person makes of an agent; initialized with the consent above. */
let userRequests: UserRequestEntrance;
/** Runtime observations are scoped by route inside this process-only cache; they never rewrite settings. */
const mediaCapabilityCache = new MediaCapabilityCache();
const EGRESS_CONSENT_KEY = 'unode.egressConsentHosts';
const CODEX_EGRESS_CONSENT_KEY = 'unode.codexEgressConsentHosts.v1';
const EGRESS_CONSENT_DECLINES_KEY = 'unode.egressConsentDeclines.v1';
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
const REPOSITORY_CLI_TRUST_KEY = 'unode.repositoryCliTrust.v1';
const AUTOMATIC_REFRESH_KEY = 'unode.automaticRefresh.v1';
let automaticRefreshSettings: AutomaticRefreshSettings = readAutomaticRefreshSettings(undefined);
const automaticRefreshCoordinator = new AutomaticRefreshCoordinator();

async function persistAutomaticRefreshSettings(): Promise<void> {
  await extensionContext?.globalState.update(AUTOMATIC_REFRESH_KEY, automaticRefreshSettings);
}

function providerHasScheduledPriceRefresh(providerId: string): boolean {
  return providerId === 'roam' || providerId === 'unode';
}

async function setProviderAutomaticRefresh(providerId: string, enabled: boolean): Promise<void> {
  if (!providerHasScheduledPriceRefresh(providerId)) return;
  automaticRefreshSettings = withProviderAutomaticRefresh(automaticRefreshSettings, providerId, enabled);
  await persistAutomaticRefreshSettings();
}

async function setGlobalPricingSourcesAutomaticRefresh(enabled: boolean): Promise<void> {
  automaticRefreshSettings = withGlobalPricingSourcesAutomaticRefresh(automaticRefreshSettings, enabled);
  await persistAutomaticRefreshSettings();
}

const codexEgressConsent = new CodexEgressConsent(
  consentGrants,
  () => persistConsentGrants('codex'),
  stopRunningCodexSessions,
);

/** A setting's scope is part of what the user approves; no scope is ever active by itself. */
type ExecutionHookCandidateOrigin = 'workspace-folder' | 'workspace' | 'global' | 'default';

interface ExecutionHookCandidateSetting {
  value: unknown;
  origin: ExecutionHookCandidateOrigin;
}

function executionHookCandidateSetting(): ExecutionHookCandidateSetting {
  // Use a real workspace folder so folder-scoped settings are neither silently skipped nor given a
  // special auto-apply rule. workspaceState below keeps an approval local to this workspace.
  // v0.9.99: that folder is the activation-time root the approval belongs to, not the editor's current first folder,
  // so a reorder neither drops the bound project's hooks nor reads another folder's.
  const resource = boundRootUri();
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
  const approval = rootWorkspaceState.get<ExecutionHookApprovalRecord>(EXECUTION_HOOK_APPROVAL_KEY);
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
async function applyExecutionHooks(): Promise<void> {
  const setting = executionHookCandidateSetting();
  let candidate: NormalizedExecutionHookCandidate;
  try {
    candidate = normalizeExecutionHookCandidate(setting.value);
  } catch (error) {
    const message = `Execution hooks refused: ${error instanceof Error ? error.message : String(error)}`;
    outputChannel.warn(message);
    void showResultNotice('error', message);
    return;
  }
  if (candidate.declarations.length === 0) {
    void showResultNotice('warning', 'No execution-hook declarations are configured to apply.');
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
    'Do not apply',
    'Apply hooks',
  );
  if (choice !== 'Apply hooks') {
    return;
  }
  const approval: ExecutionHookApprovalRecord = { version: 1, digest: candidate.digest, origin: setting.origin };
  await rootWorkspaceState.update(EXECUTION_HOOK_APPROVAL_KEY, approval);
  outputChannel.info(`Applied ${candidate.declarations.length} restrictive execution hook(s) from ${setting.origin} settings.`);
  void showResultNotice('information', 'Execution hooks applied. Running agents enforce them at their next hook point.');
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

function canonicalDestination(url: string): { destination: string; host: string } | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    const hostname = parsed.hostname.toLowerCase();
    return { destination: `${parsed.protocol}//${hostname}:${port}`, host: parsed.host.toLowerCase() };
  } catch {
    return undefined;
  }
}

interface ModelEgressScope {
  profileId: string;
  profileRevision: number;
}

/**
 * Model egress for one connection profile and revision. v0.9.99: the connection the person set up and chose is
 * the consent; the first request records the grant and shows one non-modal notice. A destination the person
 * revoked or declined is asked about again with the existing question. Returns false only for that "Do not allow".
 */
/**
 * Who a model egress decision is for. `askIfDeclined: false`: work the person did not start, which a standing
 * decline refuses without asking again.
 */
interface EgressOrigin { agentId?: string; sessionId?: string; askIfDeclined?: false; purpose?: 'reply-suggestion' }

async function ensureEgressConsent(
  url: string,
  requester: string,
  onPending?: (pending: EgressConsentPending) => void,
  scope: ModelEgressScope = { profileId: 'direct', profileRevision: 1 },
  origin: EgressOrigin = {},
): Promise<boolean> {
  const target = canonicalDestination(url);
  if (!target) return false;
  const profileLabel = scope.profileId === 'direct'
    ? 'this connection'
    : displayNameForProviderId(scope.profileId, effectiveConnectionRegistry);
  const declineKey = modelDeclineKey(scope.profileId, target.destination);
  return resolveImpliedConsent({
    granted: () => consentGrants.hasModel(scope.profileId, target.destination, scope.profileRevision),
    declined: () => consentDeclines.has(declineKey),
    grant: async () => {
      const created = consentGrants.grantModel(scope.profileId, target.destination, scope.profileRevision, target.host, requester);
      if (created) await persistConsentGrants('model');
      return created;
    },
    notify: () => {
      void vscode.window.showInformationMessage(
        `UnodeAi sends prompts and the workspace files agents read to ${target.destination} for ${requester}, the connection you chose. `
          + 'To stop this, run "UnodeAi: Security" from the Command Palette and choose revoke next to it under Network egress.',
      );
    },
    ask: async () => {
      // v0.9.110: work the person did not start (a reply suggestion) never opens this dialog. A standing decline is
      // its answer; the person allows the connection again in Security.
      if (origin.askIfDeclined === false) return false;
      // Start the visible decision before announcing the pending lifecycle.  The caller can then return an
      // actionable `consent_required` session state immediately, while this promise remains open for as long
      // as the user needs to read the modal (never a five-second human timeout).
      const choice = blockingPrompt(attentionAppearance('model-egress'), () => vscode.window.showWarningMessage(
        `You revoked or declined sending work to ${target.destination} earlier.\n\n` +
        (origin.purpose === 'reply-suggestion'
          ? 'UnodeAi is about to send the visible text of this chat there, to suggest one reply. If you do not allow it, '
            + 'reply suggestions do not ask again until you change the reply suggestion model. '
          : `UnodeAi is about to send this agent's prompt and any selected workspace files there. `) +
        `The grant is bound to this connection profile, exact scheme/host/port, and profile revision. ` +
        `It grants no command, file-write, MCP, or other effect permission.\n\n` +
        `Allow ${profileLabel} (revision ${scope.profileRevision}) to contact ${target.destination}?`,
        { modal: true },
        'Do not allow',
        'Allow'
      ), pausingTurnClock(origin));
      onPending?.({
        host: target.destination,
        message: `Consent required to contact ${target.destination}. Respond to the open UnodeAi network-consent dialog to continue this agent.`,
      });
      return (await choice) === 'Allow';
    },
    rememberDecline: async () => { if (consentDeclines.add(declineKey)) await persistConsentDeclines(); },
    forgetDecline: async () => { if (consentDeclines.delete(declineKey)) await persistConsentDeclines(); },
  });
}

/**
 * A separate disclosure for the first host-owned read outside the workspace. This is intentionally
 * session-only: choosing Allow here is not a permanent filesystem grant, and a missing/dismissed dialog
 * returns false so the tool boundary fails closed.
 */
async function requestLocalReadScopeConsent(absoluteRoot: string, prompt: LocalReadScopePrompt): Promise<boolean> {
  const root = path.resolve(absoluteRoot);
  const volumeWarning = path.resolve(path.parse(root).root) === root
    ? '\n\nThis is a filesystem volume and can include other users\' folders or profiles.'
    : '';
  // Agents that coalesce in one user request share one appearance; a grant the user asked for sounds nothing.
  const attentionKey = prompt.userInitiated ? undefined : localReadAttentionKey(root, prompt.epoch);
  const choice = await blockingPrompt(attentionKey, () => vscode.window.showWarningMessage(
    `UnodeAi is about to let agents read and search:\n\n${root}\n\n`
      + 'A search may walk this whole folder tree, not just one named file. Filenames and file contents returned by these tools may be sent to the model provider configured for the agent. '
      + 'Writes, deletes, and shell commands remain confined to the working folder.'
      + volumeWarning,
    { modal: true },
    'Deny',
    'Allow',
  ), untimedPrompt('Several agents can wait on this one prompt; the gate of each pauses that agent\'s turn clock.'));
  return choice === 'Allow';
}

/** Egress hook passed to backends. Throws (aborting the request, before anything is sent) if the user declines. */
async function egressGate(
  url: string,
  onPending?: (pending: EgressConsentPending) => void,
  requester = 'Model request',
  scope?: ModelEgressScope,
  origin: EgressOrigin = {},
): Promise<void> {
  const target = canonicalDestination(url);
  if (!target || !(await ensureEgressConsent(url, requester, onPending, scope, origin))) {
    throw new EgressConsentDeclinedError(target?.destination ?? url);
  }
}

/**
 * Codex is a user-installed local CLI, not an HTTP transport controlled by UnodeAi. Its first consent
 * therefore states the boundary the generic gateway dialog cannot: Codex connects to OpenAI itself and
 * UnodeAi does not control the CLI's network behaviour.
 */
async function codexEgressGate(
  onPending: ((pending: EgressConsentPending) => void) | undefined,
  requester: string,
  executablePath: string,
  origin: { agentId?: string; sessionId?: string } = {},
): Promise<void> {
  const host = 'api.openai.com';
  const canonicalExecutable = canonicalCodexExecutablePath(executablePath);
  const declineKey = codexDeclineKey(host);
  // v0.9.99: choosing a Codex agent and its program is the consent; a revoked or declined Codex is asked again.
  const allowed = await resolveImpliedConsent({
    granted: () => codexEgressConsent.has(host, canonicalExecutable),
    declined: () => consentDeclines.has(declineKey),
    grant: () => codexEgressConsent.grant(host, canonicalExecutable, requester),
    notify: () => {
      void vscode.window.showInformationMessage(
        `UnodeAi started Codex from ${canonicalExecutable}, the Codex program you chose. Codex connects to OpenAI, or to the `
          + 'provider set in your Codex configuration, under your own login; your prompts and the workspace content it reads go there. '
          + 'To stop this, run "UnodeAi: Security" from the Command Palette and choose revoke next to Codex CLI under Network egress.',
      );
    },
    ask: async () => {
      const choice = blockingPrompt(attentionAppearance('codex-egress'), () => vscode.window.showWarningMessage(
        `You revoked or declined Codex earlier. Start OpenAI Codex App Server and allow its own network connections?\n\n`
          + `Codex runs under your own login. It connects to OpenAI and to the model provider configured in your `
          + `Codex (OpenAI by default). UnodeAi does not control or restrict the CLI's network behaviour. Your `
          + `prompt and any workspace content Codex reads may be sent to that provider.\n\n`
          + `Executable: ${canonicalExecutable}\n\n`
          + `UnodeAi has already run local version and login-status checks. Declining means no App Server or model request will start.`,
        { modal: true },
        'Do not allow',
        'Start Codex',
      ), pausingTurnClock(origin));
      onPending?.({
        host,
        message: 'Consent required to start Codex App Server and let it connect to its configured model provider.',
      });
      return (await choice) === 'Start Codex';
    },
    rememberDecline: async () => { if (consentDeclines.add(declineKey)) await persistConsentDeclines(); },
    forgetDecline: async () => { if (consentDeclines.delete(declineKey)) await persistConsentDeclines(); },
  });
  if (!allowed) throw new EgressConsentDeclinedError(host);
}

function repositoryCliTrustRecords(): RepositoryCliTrustRecord[] {
  const raw = rootWorkspaceState.get<unknown>(REPOSITORY_CLI_TRUST_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is RepositoryCliTrustRecord => {
    const value = entry as Partial<RepositoryCliTrustRecord> | null;
    return !!value && value.version === 1
      && (value.kind === 'claude' || value.kind === 'codex')
      && typeof value.workspaceRoot === 'string'
      && typeof value.cwd === 'string'
      && typeof value.digest === 'string'
      && (value.mode === 'native' || value.mode === 'user-only')
      && typeof value.grantedAt === 'string';
  });
}

async function persistRepositoryCliTrust(record: RepositoryCliTrustRecord): Promise<void> {
  const records = repositoryCliTrustRecords();
  const key = repositoryCliTrustKey(record.kind, record.cwd);
  const next = records.filter((entry) => repositoryCliTrustKey(entry.kind, entry.cwd) !== key);
  next.push(record);
  await rootWorkspaceState.update(REPOSITORY_CLI_TRUST_KEY, next);
}

async function revokeRepositoryCliTrust(kind: RepositoryCliKind, cwd: string, digest: string): Promise<void> {
  const records = repositoryCliTrustRecords();
  const key = repositoryCliTrustKey(kind, cwd);
  const matching = records.find((entry) => repositoryCliTrustKey(entry.kind, entry.cwd) === key && entry.digest === digest);
  if (!matching) return;
  await rootWorkspaceState.update(
    REPOSITORY_CLI_TRUST_KEY,
    records.filter((entry) => !(repositoryCliTrustKey(entry.kind, entry.cwd) === key && entry.digest === digest)),
  );
  const running = sessionManager.getAll().filter((session) => {
    const backend = session.config.backend ?? defaultBackendKind(session.config, effectiveConnectionRegistry);
    return backend === kind;
  });
  await Promise.all(running.map((session) => sessionManager.stop(session.config.id, 10000, 'host')));
  void showResultNotice('information', `${kind === 'claude' ? 'Claude' : 'Codex'} repository-configuration grant revoked; running ${kind} agents were stopped.`);
}

async function repositoryCliLaunchApproval(
  kind: RepositoryCliKind,
  cwd: string,
  requester: string,
  origin: { agentId?: string; sessionId?: string } = {},
): Promise<RepositoryCliLaunchApproval> {
  if (!firstWorkspaceRoot()) throw new Error('Open a workspace folder before starting a CLI agent.');
  const workspaceRoot = workspaceRootForCliCwd(
    (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    cwd,
  );
  if (!workspaceRoot) {
    throw new Error('The CLI agent working directory is outside every open workspace folder; no CLI process was started.');
  }
  const inspection = inspectRepositoryCliConfig(kind, workspaceRoot, cwd);
  const workspaceTrusted = vscode.workspace.isTrusted;
  let mode: RepositoryAutomationMode = workspaceTrusted ? 'native' : 'user-only';

  if (inspection.present) {
    const key = repositoryCliTrustKey(kind, inspection.cwd);
    const stored = repositoryCliTrustRecords().find((entry) => repositoryCliTrustKey(entry.kind, entry.cwd) === key);
    const reusable = repositoryCliTrustMatches(stored, inspection)
      && !(stored?.mode === 'native' && (!workspaceTrusted || inspection.blockedLinks.length > 0));
    if (reusable) {
      mode = stored!.mode;
      // v0.9.99: a decision stored with the byte-exact digest of an earlier release is kept and moved to the
      // authority digest, so Claude Code's own rewrites of settings.local.json no longer ask again.
      if (stored!.digest !== inspection.digest) {
        await persistRepositoryCliTrust({ ...stored!, digest: inspection.digest });
      }
    } else {
      const cliName = kind === 'claude' ? 'Claude Code' : 'Codex CLI';
      const summary = inspection.summary.length > 0
        ? inspection.summary.map((line) => `• ${line}`).join('\n')
        : inspection.configPaths.map((line) => `• ${line}`).join('\n');
      const blocked = inspection.blockedLinks.length > 0
        ? `\n\nTrust and load is unavailable because linked configuration cannot be content-bound:\n${inspection.blockedLinks.join('\n')}`
        : '';
      const detail = [
        `Agent: ${requester}`,
        `Working directory: ${inspection.cwd}`,
        `Configuration digest: ${inspection.digest}`,
        '',
        'This repository can add hooks, MCP servers, plugins, skills, agents, commands, or helpers:',
        summary || '• Project configuration is present.',
        blocked,
        '',
        'Trust and load preserves the native CLI features. Continue without project automation keeps user-level configuration but excludes repository automation.',
      ].filter((line) => line !== '').join('\n');
      const attentionKey = attentionAppearance('repository-cli-config');
      const choice = workspaceTrusted && inspection.blockedLinks.length === 0
        ? await blockingPrompt(attentionKey, () => vscode.window.showWarningMessage(
          `${cliName} found executable configuration supplied by this workspace.`,
          { modal: true, detail },
          'Continue without project automation',
          'Trust and load',
        ), pausingTurnClock(origin))
        : await blockingPrompt(attentionKey, () => vscode.window.showWarningMessage(
          `${cliName} found executable configuration supplied by this workspace.`,
          { modal: true, detail },
          'Continue without project automation',
        ), pausingTurnClock(origin));
      if (choice !== 'Trust and load' && choice !== 'Continue without project automation') {
        throw new Error(`${cliName} start was cancelled before repository configuration was loaded.`);
      }
      mode = choice === 'Trust and load' ? 'native' : 'user-only';
      await persistRepositoryCliTrust(repositoryCliTrustRecord(inspection, mode));
    }
  }

  return {
    mode,
    projectRoot: inspection.workspaceRoot,
    assertCurrent: () => {
      // v0.9.99: with project automation off nothing of the repository's configuration is loaded, so a change to
      // it cannot matter to this start. With Trust and load, only a change to what the configuration can do (not
      // Claude Code's own permission-list rewrites or reformatting) stops the start; the next start asks once.
      if (mode === 'user-only') return;
      const current = inspectRepositoryCliConfig(kind, workspaceRoot, cwd);
      if (current.digest !== inspection.digest || current.present !== inspection.present) {
        throw new Error(`${kind === 'claude' ? 'Claude Code' : 'Codex CLI'} project configuration (hooks, MCP servers or helpers) changed after you approved it, so this start did not load it. Start the agent again to review the change.`);
      }
      if (mode === 'native' && !vscode.workspace.isTrusted) {
        throw new Error('Workspace Trust changed after repository configuration approval. Start again in restricted mode.');
      }
    },
  };
}

/**
 * Ask separately before bytes of an already-obtained asset go to a vision or transcription provider.
 * This is intentionally not `ensureEgressConsent`: that dialog truthfully covers prompts/workspace files,
 * while this one names the media class, bounded quantity and (when known) input price.
 */
async function mediaEgressGate(
  request: MediaEgressRequest,
  requester: string,
  origin: { agentId?: string; sessionId?: string } = {},
): Promise<void> {
  const safe = validateMediaEgressRequest(request);
  const declineKey = mediaDeclineKey(safe.host, safe.kind);
  // v0.9.99: the vision or transcription model the person set up is the consent; a revoked or declined one asks again.
  const allowed = await resolveImpliedConsent({
    granted: () => consentGrants.hasMedia(safe.host, safe.kind),
    declined: () => consentDeclines.has(declineKey),
    grant: async () => {
      const created = consentGrants.grantMedia(safe.host, safe.kind, requester);
      if (created) await persistConsentGrants('media');
      return created;
    },
    notify: () => {
      void vscode.window.showInformationMessage(
        `UnodeAi uploads ${safe.mediaClass} media to ${safe.provider} at ${safe.host} for ${safe.kind}, the model you set up. `
          + 'To stop this, run "UnodeAi: Security" from the Command Palette and choose revoke next to it under Network egress.',
      );
    },
    ask: async () => {
      const choice = blockingPrompt(attentionAppearance('media-egress'), () => vscode.window.showWarningMessage(
      `You revoked or declined media uploads to ${safe.host} earlier. UnodeAi is about to upload ${safe.mediaClass} media to ${safe.provider} at ${safe.host} for ${safe.kind}.\n\n`
        + `${describeMediaEgress(safe)}\n\n`
        + 'This is separate from public-download and ordinary model-request approval. Allow this media upload?',
      { modal: true },
      'Do not allow',
      'Allow',
      ), pausingTurnClock(origin));
      return (await choice) === 'Allow';
    },
    rememberDecline: async () => { if (consentDeclines.add(declineKey)) await persistConsentDeclines(); },
    forgetDecline: async () => { if (consentDeclines.delete(declineKey)) await persistConsentDeclines(); },
  });
  if (!allowed) {
    throw new Error(`Media ${safe.kind} upload to ${safe.host} was declined — no media bytes were sent.`);
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
  return !!host && (consentGrants.hasModelForHost(host) || consentGrants.has('metadata', host));
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
      (connectionId) => staticCatalogModels(connectionId),
      metadataFetch,
      {
        catalogUrl: configuredSetting<string>('modelCatalogUrl', '') || undefined,
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

/** The cached list of the Codex program UnodeAi would start now, unless that program was since measured at another version. */
function cachedCodexAccountModels(): CodexAccountModel[] {
  let program: string | undefined;
  try {
    program = configuredCodexCliPath() || undefined;
  } catch {
    program = undefined;
  }
  // A list is offered only for the program file that was checked; a replaced or retargeted file must be checked again.
  const measured = program ? lastCliRuntimeCheck('codex-cli', program)?.version : undefined;
  if (!measured) return [];
  return cachedCodexModelsFor(codexModelCache, program, measured, sameHostPath)?.models ?? [];
}

function sameHostPath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function restoreCliRuntimeChecks(value: unknown): CliRuntimeCheck[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): CliRuntimeCheck[] => {
    if (!entry || typeof entry !== 'object') return [];
    const { provider, program, version, checkedAt } = entry as Record<string, unknown>;
    if (provider !== 'claude-cli' && provider !== 'codex-cli') return [];
    if (typeof program !== 'string' || !program || program.length > 1024 || !path.isAbsolute(program)) return [];
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) return [];
    if (typeof checkedAt !== 'string' || Number.isNaN(Date.parse(checkedAt))) return [];
    const { stamp } = entry as Record<string, unknown>;
    if (typeof stamp !== 'string' || !stamp || stamp.length > 1400) return [];
    return [{ provider, program, version, checkedAt, stamp }];
  }).slice(0, 16);
}

function restoreCliLatestVersions(value: unknown): typeof cliLatestVersions {
  if (!value || typeof value !== 'object') return {};
  const restored: typeof cliLatestVersions = {};
  for (const provider of ['claude-cli', 'codex-cli'] as const) {
    const entry = (value as Record<string, unknown>)[provider];
    if (!entry || typeof entry !== 'object') continue;
    const { version, checkedAt } = entry as Record<string, unknown>;
    if (typeof version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(version)) continue;
    if (typeof checkedAt !== 'string' || checkedAt.length > 40 || Number.isNaN(Date.parse(checkedAt))) continue;
    restored[provider] = { version, checkedAt };
  }
  return restored;
}

/** The last check of this program, if its file is still the one that was checked. */
function lastCliRuntimeCheck(provider: CliRuntimeProvider, program: string): CliRuntimeCheck | undefined {
  const check = cliRuntimeChecks.find((candidate) => candidate.provider === provider && sameHostPath(candidate.program, program));
  return check && cliProgramStamp(program) === check.stamp ? check : undefined;
}

/** A check made of this program whose file has changed since: its version no longer says anything. */
function cliRuntimeCheckOutdated(provider: CliRuntimeProvider, program: string): boolean {
  return !lastCliRuntimeCheck(provider, program)
    && cliRuntimeChecks.some((candidate) => candidate.provider === provider && sameHostPath(candidate.program, program));
}

/** Records a check only if the program file is still the one that was checked, so a check never vouches for another. */
async function recordCliRuntimeCheck(check: CliRuntimeCheck): Promise<void> {
  if (cliProgramStamp(check.program) !== check.stamp) return;
  cliRuntimeChecks = [check, ...cliRuntimeChecks.filter((existing) =>
    !(existing.provider === check.provider && sameHostPath(existing.program, check.program)))].slice(0, 16);
  await extensionContext?.globalState.update(CLI_RUNTIME_CHECKS_KEY, cliRuntimeChecks);
  SettingsPanel.refreshCurrent();
}

function staticCatalogModels(connectionId: string): ModelInfo[] {
  const registered = (effectiveConnectionRegistry.connectionProfile(connectionId)?.catalogModels ?? []).map(
    (model): ModelInfo => ({ id: model.id, name: model.name, vision: model.vision, source: 'static' }),
  );
  if (connectionId === 'codex-cli') {
    const discovered = cachedCodexAccountModels();
    if (discovered.length > 0) {
      return [...registered, ...discovered.map((model): ModelInfo => ({
        id: model.id,
        name: model.name,
        vision: model.vision,
        source: 'account',
      }))].filter((model, index, all) => all.findIndex((candidate) => candidate.id === model.id) === index);
    }
  }
  return registered;
}

async function rememberCodexAccountModels(models: readonly CodexAccountModel[], program: string, cliVersion: string): Promise<void> {
  if (!cliVersion || models.length === 0) return;
  codexModelCache = rememberCodexModels(codexModelCache, {
    program, cliVersion, capturedAt: new Date().toISOString(), models: [...models],
  }, sameHostPath);
  await extensionContext?.globalState.update(CODEX_MODEL_CACHE_KEY_V2, codexModelCache);
  modelCatalog?.clearCache();
  AgentBuilderPanel.refreshCurrent();
  SettingsPanel.refreshCurrent();
}

function getPricing(): ModelPricing {
  if (!pricing) {
    const priceOverrides = configuredSetting<Record<string, ModelPrice>>('modelPrices', {});
    pricing = new ModelPricing({ ...priceOverrides });
    applyReferencePricesToPicker(pricing);
  }
  return pricing;
}

/**
 * v0.9.89: picker labels with no live or user price show the selected DATED reference, by exact id, labelled
 * with its catalog and date. There is no undated built-in table behind it.
 */
function applyReferencePricesToPicker(table: ModelPricing): void {
  const modeSetting = configuredSetting<unknown>('spend.referencePriceMode', 'unselected');
  const provider = displayReferenceProvider(isStoredReferencePriceMode(modeSetting) ? modeSetting : 'unselected');
  const catalog = spendHost?.references.catalogs()[provider];
  if (!catalog) return;
  const perMillion = (nano: string) => Number(BigInt(nano)) / 1_000_000_000;
  const rows: Record<string, ModelPrice> = {};
  for (const row of catalog.models) {
    rows[row.modelId] = {
      input: perMillion(row.inputNanoUsdPerMillion),
      output: perMillion(row.outputNanoUsdPerMillion),
      ...(row.cachedInputNanoUsdPerMillion !== undefined ? { cachedInput: perMillion(row.cachedInputNanoUsdPerMillion) } : {}),
    };
  }
  table.setReference(rows, `${provider === 'unode' ? 'Unode' : 'Roam'} reference ${catalog.capturedAt.slice(0, 10)}${catalogIsStale(catalog, Date.now()) ? ', stale' : ''}`);
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
 * initially unselected, and the user explicitly ticks whatever they want. Nothing they did not tick is granted.
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
    // A real Enter press must be a decline. Users explicitly tick the hosts they approve.
    picked: false,
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
function revokeEgressConsent(
  host: string,
  kind: ConsentGrantKind = 'model',
  mediaKind?: MediaConsentKind,
  modelScope?: { profileId: string; destination: string; profileRevision: number },
): void {
  if (kind === 'codex') {
    // v0.9.99: a revoke is an explicit decline. It survives, so the next Codex start asks instead of re-granting.
    if (consentDeclines.add(codexDeclineKey(host))) void persistConsentDeclines();
    void codexEgressConsent.revoke(host).catch((error) => {
      outputChannel.warn(`Failed to revoke Codex CLI consent cleanly: ${String(error)}`);
    });
    return;
  }
  if (kind === 'media' && !mediaKind) {
    throw new Error('Revoking media egress consent requires an explicit media kind.');
  }
  const declineKey = kind === 'media'
    ? mediaDeclineKey(host, mediaKind!)
    : kind === 'model' && modelScope ? modelDeclineKey(modelScope.profileId, modelScope.destination) : undefined;
  if (declineKey && consentDeclines.add(declineKey)) void persistConsentDeclines();
  const revoked = kind === 'media'
    ? consentGrants.revokeMedia(host, mediaKind!)
    : kind === 'model' && modelScope
      ? consentGrants.revokeModel(modelScope.profileId, modelScope.destination, modelScope.profileRevision)
      : consentGrants.revoke(kind, host);
  if (revoked) {
    if (kind === 'model') imageConnections?.invalidate(modelScope?.profileId);
    void persistConsentGrants(kind);
  }
  // v0.9.110: a withdrawn model grant ends a reply suggestion of that connection now, also one still waiting for its
  // consent; what it already used stays recorded. A later suggestion asks the existing consent question again.
  if (kind === 'model' && replySuggestions?.invalidateConnection(modelScope?.profileId)) chatViewProvider?.dismissReplySuggestions();
}

function consentKey(kind: ConsentGrantKind): string {
  return kind === 'model'
    ? EGRESS_CONSENT_KEY
    : kind === 'metadata'
      ? METADATA_CONSENT_KEY
      : kind === 'codex'
        ? CODEX_EGRESS_CONSENT_KEY
        : MEDIA_EGRESS_CONSENT_KEY;
}

async function persistConsentGrants(kind: ConsentGrantKind): Promise<void> {
  await extensionContext?.globalState.update(consentKey(kind), consentGrants.serialize(kind));
}

async function persistConsentDeclines(): Promise<void> {
  await extensionContext?.globalState.update(EGRESS_CONSENT_DECLINES_KEY, consentDeclines.serialize());
}

/** Revocation is an immediate runtime boundary: no consent means no live Codex process remains. */
async function stopRunningCodexSessions(): Promise<void> {
  if (!sessionManager) return;
  const codexSessionIds = sessionManager.getAll()
    .filter((session) => sessionManager.getBackend(session.id) instanceof CodexBackend)
    .map((session) => session.id);
  await Promise.all(codexSessionIds.map((id) => sessionManager.stop(id, 10000, 'host')));
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
    const props = contributedSettingProperties(context.extension?.packageJSON?.contributes);
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
      // Never bless a repository-authored legacy value by copying it into the new namespace. In
      // particular, authority settings are user/global only and old workspace allowlists are not approvals.
      if (hasWorkspace && !isAuthoritySettingKey(key)
          && oldI?.workspaceValue !== undefined && newI?.workspaceValue === undefined) {
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
      const p = cpSpawn(resolveHostProgram('git'), ['-C', root, 'worktree', 'repair'], { stdio: 'ignore', shell: false });
      const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve(); }, 15000);
      p.on('close', () => { clearTimeout(t); resolve(); });
      p.on('error', () => { clearTimeout(t); resolve(); });
    });
  } catch (e) {
    outputChannel.warn(`Workspace dir migration (.roam → .unode) skipped: ${String(e)}`);
  }
}

/** v0.9.103 (the clock investigation): one log line per distinct clock comparison, in the UnodeAi output. */
// v0.9.104 (Codex's audit of 5ab8dfb0, F3): a changed correction redraws the Message Log, whose times are host-drawn.
const clockReporter = new ClockReporter((line) => outputChannel.info(line), undefined, () => messageLogProvider?.refresh());

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('UnodeAi', { log: true });
  outputChannel.info('UnodeAi activating...');
  // v0.9.106 (first use, §3.5): read before any migration or initialisation writes to the same stores.
  installCohort = readInstallCohort(context);
  // Integrated terminals are renderer-owned and can survive an extension-host restart. Remove every
  // durably marked terminal from the previous host before binding this host to a workspace root.
  await terminalManager.disposeAll();
  const workspaceTrustNotice = new ActivationWorkspaceTrustNotice({
    isTrusted: () => vscode.workspace.isTrusted,
    workspaceFolderCount: () => vscode.workspace.workspaceFolders?.length ?? 0,
    untrustedWorkspaceDescription: () => context.extension.packageJSON?.capabilities?.untrustedWorkspaces?.description,
    showWarning: (summary, detail) => showResultNotice('warning', summary, detail),
  });
  workspaceTrustNotice.showIfNeeded();
  extensionContext = context;
  // v0.9.110 (N1): definitions and references come from this editor's language service, on every route.
  setCodeNavigationHost(new VscodeCodeNavigation());
  autonomyDefaults = new AutonomyDefaultConsent(context.globalState);
  codexModelCache = restoreCodexModelCacheV2(context.globalState.get<unknown>(CODEX_MODEL_CACHE_KEY_V2));
  cliRuntimeChecks = restoreCliRuntimeChecks(context.globalState.get<unknown>(CLI_RUNTIME_CHECKS_KEY));
  cliLatestVersions = restoreCliLatestVersions(context.globalState.get<unknown>(CLI_LATEST_VERSIONS_KEY));
  automaticRefreshSettings = readAutomaticRefreshSettings(
    context.globalState.get<unknown>(AUTOMATIC_REFRESH_KEY),
  );
  workspaceBinding = new FirstWorkspaceBinding(editorFirstWorkspaceRoot());
  rootWorkspaceState = new RootScopedWorkspaceState(
    context.workspaceState,
    firstWorkspaceRoot(),
    () => firstWorkspaceRoot() !== undefined,
  );
  agentToolAlwaysAllow = new AgentToolAlwaysAllow(rootWorkspaceState, () => {
    outputChannel.warn('An "Always allow this tool" answer could not be saved; it still applies until the window closes.');
  });
  const importedLegacyWorkspaceKeys = await rootWorkspaceState.importLegacyWorkspaceLocalState(
    classifyLegacyWorkspaceStateHost(vscode.env.appName),
  );
  if (importedLegacyWorkspaceKeys.length > 0) {
    outputChannel.info(
      `[workspace-state] imported ${importedLegacyWorkspaceKeys.length} v0.9.81 key(s) into the bound-root namespace.`,
    );
  }
  projectCommandApprovals = new ProjectCommandApprovals(rootWorkspaceState, firstWorkspaceRoot);
  await noticeIgnoredWorkspaceAuthoritySettings();
  integrationEvidenceStore = firstWorkspaceRoot()
    ? new IntegrationEvidenceStore(rootWorkspaceState, firstWorkspaceRoot()!)
    : undefined;
  outputChannel.info(`[workspace-binding] active root="${firstWorkspaceRoot() ?? 'none'}".`);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    accessInputsChanged();
    // Project services and workspaceState were created for the activation-time first folder, and they stay bound to
    // it: a multi-root reorder or folder switch never redirects their writes into a different repository.
    // v0.9.99: the change no longer stops running agents, Integrations or terminals, and later work is not refused.
    // Everything keeps working in the folder UnodeAi started with until the user reloads the window to switch.
    if (!workspaceBinding.observe(editorFirstWorkspaceRoot())) { return; }
    outputChannel.info('[workspace-binding] the first folder changed; UnodeAi keeps the folder it started with until the window reloads.');
    void (async () => {
      const choice = await vscode.window.showInformationMessage(
        'The first workspace folder changed. UnodeAi keeps working in the folder it started with, so running work '
        + 'continues. Reload the window to switch UnodeAi to the new first folder.',
        'Reload Window',
      );
      if (choice === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
    })();
  }));
  promptedCommandLog.restoreFrom(context.globalState.get<SerializedPromptedCommandLog>(PROMPTED_COMMAND_LOG_KEY));
  const migratedEgress = consentGrants.restore('model', context.globalState.get<unknown>(EGRESS_CONSENT_KEY));
  const migratedCodex = codexEgressConsent.restore(context.globalState.get<unknown>(CODEX_EGRESS_CONSENT_KEY));
  const migratedMetadata = consentGrants.restore('metadata', context.globalState.get<unknown>(METADATA_CONSENT_KEY));
  const migratedMedia = consentGrants.restore('media', context.globalState.get<unknown>(MEDIA_EGRESS_CONSENT_KEY));
  consentDeclines.restore(context.globalState.get<unknown>(EGRESS_CONSENT_DECLINES_KEY));
  // A setting remains an inert candidate in every scope. This first check is only diagnostic: it never
  // constructs a hook. A later explicit command is the sole path that records approval.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    // v0.9.101: Local read scope and the other unode settings are reach inputs of the access table's rule.
    if (event.affectsConfiguration('unode')) accessInputsChanged();
    // v0.9.106: an open setup guide shows the settings in effect (a passive read; nothing is started).
    if (event.affectsConfiguration('unode')) { SetupGuidePanel.refreshCurrent(); SecurityPanel.refreshIfOpen(); chatViewProvider?.refresh(); }
    if (event.affectsConfiguration('unode.executionHooks')) {
      activeExecutionHooks(context, { report: true });
    }
  }));
  if (migratedEgress.migratedLegacy) { await persistConsentGrants('model'); }
  if (migratedCodex.migratedLegacy) { await persistConsentGrants('codex'); }
  if (migratedMetadata.migratedLegacy) { await persistConsentGrants('metadata'); }
  if (migratedMedia.migratedLegacy) { await persistConsentGrants('media'); }
  await migrateRoamSettingsToUnode(context); // rebrand: carry legacy roam.* settings into unode.*
  await migrateRoamWorkspaceDir();           // rebrand: move legacy .roam/ workspace data → .unode/
  await noticeIgnoredWorkspaceAuthoritySettings(); // includes legacy workspace values just migrated

  activeExecutionHooks(context, { report: true });

  // Workspace Trust: when the user grants trust mid-session, mount any MCP servers referenced by agents
  // (they were skipped at activation while untrusted). Command execution is checked live, so it needs no
  // re-arming here. Registered on the context so it's disposed on deactivate.
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
    workspaceTrustNotice.onDidGrantWorkspaceTrust();
    accessInputsChanged();
    SetupGuidePanel.refreshCurrent();
    outputChannel.info('Workspace trusted — mounting referenced MCP servers.');
    try { registerReferencedMcpServers(); } catch (e) { outputChannel.warn(`MCP mount after trust failed: ${String(e)}`); }
  }));

  secrets = new SecretsManager(context.secrets);
  localApplications = new LocalApplicationCatalog({ resolveExecutable: resolveHostProgram });
  nativeOfficeRenderer = new NativeOfficeRenderer({ catalog: localApplications, stagingLedger: path.join(context.globalStorageUri.fsPath, 'native-staging-v1') });
  pdfSignatures = new PdfSignatureStore(path.join(context.globalStorageUri.fsPath, 'signature'));
  void pdfSignatures.current();
  await nativeOfficeRenderer.recoverStaging();
  // v0.9.108: recalculation stages share the native staging ledger, so the same recovery reclaims them.
  workbookRecalcEngine = new WorkbookRecalcEngine({ catalog: localApplications, stagingLedger: path.join(context.globalStorageUri.fsPath, 'native-staging-v1') });
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
  securityControlLocations = createSecurityControlLocationAdapter(context);
  await reloadEffectiveConnectionRegistry();
  watchCustomGatewayRegistry(context);
  const runOwnershipActivatedAt = new Date().toISOString();
  runHostIdentity = { hostInstanceId: vscode.env.sessionId, epoch: randomUUID() };
  runOwnershipMaintenanceState = { previousTickAtMs: Date.parse(runOwnershipActivatedAt) };
  outputChannel.info(
    `[run-ownership] resolved source=vscode.env.sessionId hostInstanceId=${JSON.stringify(runHostIdentity.hostInstanceId)} `
    + `epoch=${JSON.stringify(runHostIdentity.epoch)}.`,
  );
  // v0.9.99: project state (team file, project Team Library, verification policy) follows the activation-time root,
  // like every other project service, so a first-folder change never writes or reads another project's files.
  persistence = new PersistenceManager(
    context,
    () => effectiveConnectionRegistry,
    () => firstWorkspaceRoot(),
    runHostIdentity,
    undefined,
    rootWorkspaceState,
  );
  teamPolicyStore = new TeamPolicyStore(rootWorkspaceState);
  teamVerificationEditor = new TeamVerificationEditor({
    workspaceRoot: () => firstWorkspaceRoot() ?? '', rosterRevision: () => teamRosterRevision,
    isCurrentWorkspace: () => !workspaceBinding.isStale() && !hostShutdown.started && agentRosterEdits.admissionAllowed,
    skills: () => sessionManager.getAll().flatMap(session => skillsForAgent(session.config)),
    members: () => sessionManager.getAll().map(session => session.config),
    configuration: () => vscode.workspace.getConfiguration('unode'),
    readDocument: () => persistence.loadTeamConfigForEdit(),
    updateDocument: edit => persistence.updateTeamConfig(edit),
  });
  runLedger = new RunLedger(await persistence.loadRuns(runOwnershipActivatedAt), {
    fileCommitFacts: persistence.loadFileCommitFacts(),
    saveFileCommitFacts: facts => persistence.saveFileCommitFacts(facts),
    host: runHostIdentity,
    // The session manager is created after the ledger; a run the host closes before that has no active turn.
    activeTurnId: (agentId) => sessionManager?.currentTurnId(agentId),
  });
  runLedger.onDidChange(() => scheduleRunSave());
  const activationReconciliationDecisions: RunOwnershipReconciliationDecision[] = [];
  const restoredInterruptions = runLedger.reconcileRestoredActiveDelegations(
    runOwnershipActivatedAt,
    (decision) => activationReconciliationDecisions.push(decision),
  );
  // v0.9.100: after the rows above, whose interrupted work a continuation's run is left waiting on.
  runLedger.reconcileRestoredContinuations(runOwnershipActivatedAt);
  // v0.9.101 (H2a): a wait for access cannot outlive the window: what it waited for is said, and nothing is started.
  runLedger.reconcileRestoredAwaitingAccess(runOwnershipActivatedAt);
  if (activationReconciliationDecisions.length === 0) {
    outputChannel.info('[run-ownership] activation reconciliation branch=no-active-rows.');
  } else {
    for (const decision of activationReconciliationDecisions) {
      logRunOwnershipDecision('activation', decision);
    }
  }
  if (restoredInterruptions.length > 0) {
    outputChannel.warn(
      `Marked ${restoredInterruptions.length} persisted delegation(s) interrupted because worker promises cannot survive an extension-host restart.`,
    );
  }
  checkpointStore.restoreFrom(persistence.loadCheckpoints()); // V1: restore points survive reloads
  // v0.9.97: the exact bytes of a file before a host change replaces or removes it. The store is opened now, in the
  // background, so what a crash left is reconciled at start-up (owned staging only; no workspace file is touched);
  // a change that needs a restore point waits for it.
  const storageRoot = context.globalStorageUri?.fsPath;
  preChangeCheckpoints = new PreChangeCheckpoints({
    open: () => openRawCheckpoints(storageRoot),
    isRequestRunning: (requestId) => sessionManager?.requestRunning(requestId) ?? false,
    // v0.9.110 R1: every restore point a request's change takes, or could not take, reaches its restore manifest.
    recovery: {
      captured: (capture) => taskHistory?.recoveryCaptured(capture),
      settled: (settle) => taskHistory?.recoverySettled(settle),
    },
  });
  // v0.9.110: the shared raw-v2 store takes a cross-window lease, which reads this process's identity (on Windows a
  // PowerShell query). Opened at the first capture or restore, or half a minute after activation, never at it.
  const openRawLater = setTimeout(() => { void preChangeCheckpoints?.store(); }, 30_000);
  (openRawLater as { unref?: () => void }).unref?.();
  context.subscriptions.push({ dispose: () => clearTimeout(openRawLater) });
  messageBus = new MessageBus();
  const recoveredResultMessages = persistence.loadMessages();
  messageBus.importMessages(recoveredResultMessages);
  resultDeliveryHost = new ResultDeliveryHost({
    persistence, ledger: runLedger, storageUri: context.storageUri,
    workspaceId: firstWorkspaceRoot() ? workspaceRootIdentity(firstWorkspaceRoot()!) : '',
    assertCurrent: () => { if (workspaceBinding.isStale() || hostShutdown.started) throw new Error('Result workspace changed'); },
    owns: (id, handle) => {
      const run = runLedger.snapshot().find(row => row.coordinatorId === id && row.delegations.some(item => item.handle === handle));
      const row = run?.delegations.find(item => item.handle === handle);
      return !!run && !!row && (row.owner?.hostInstanceId === runHostIdentity.hostInstanceId
        || !row.owner || Date.now() - Date.parse(row.owner.heartbeatAt) >= 30000);
    },
    archive: (identity, text) => {
      const message = messageBus.send('unode', identity.coordinatorId, 'system.heartbeat', { instruction: text,
        metadata: { resultArchive: identity } }, 'normal', identity.ref.handle);
      return { conversationId: identity.coordinatorId, messageId: message.id };
    },
    hasDelivery: (identity, digest) => recoveredResultMessages.some(message => resultDeliveryMarkerMatches(message, identity, digest)),
    recordDelivery: async (identity, digest, via) => {
      messageBus.send('unode', identity.coordinatorId, 'system.heartbeat', { metadata: {
        resultDelivery: identity, sourceDigest: digest, via } }, 'normal', identity.ref.handle);
      await persistence.saveMessages(messageBus.exportMessages());
    },
    saveLedger: () => persistRunLedger(),
    saveArchive: async () => { await persistence.saveMessages(messageBus.exportMessages()); },
    recoveryReady: (id, results) => { if (sessionManager?.get(id)) orchestrationHost?.offerRecoveredResults(id, results); },
    notice: (id, result) => {
      if (!chatViewProvider) return false;
      chatViewProvider.postRuntimeNotice(id, result === 'unavailable'
        ? 'A teammate\'s finished result is not available after this reload. If it was saved, run Developer: Reload Window later to try again. To go on without it, ask the coordinator to run that work again or to abandon it. Pressing Stop while the coordinator is running closes this result, and it can no longer be recovered; if no other work or usable result is left, the task ends as partial.'
        : 'Work is continuing. Result recovery is unavailable or still saving; a reload may lose or repeat an unsaved result.');
      return true;
    },
    logRecoveryWarning: (id, source) => outputChannel.warn(`[result-recovery] coordinator=${id} source=${source}`),
  });
  await resultDeliveryHost.open();
  documentRenderer = new DocumentRenderer(path.join(context.extensionUri.fsPath, 'out', 'content', 'document', 'DocumentRenderWorker.js'),
    undefined, { forbiddenRoots: () => vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [] });
  presentationRenderer = new PresentationRenderer(path.join(context.extensionUri.fsPath, 'out', 'office', 'PresentationWorker.js'));
  // A user's directed request is an explicit continuation. An automatic backend start is not.
  messageBus.onType('ask.question', message => {
    if (message.from === 'user' && message.to !== '*') resultDeliveryHost.scope(message.to, 'explicit-resume');
  });
  // One process-lifetime gate is shared by every backend and bridge. It deliberately does not use the
  // persistent egress-grant registry: approvals are session-only and declines are request-recoverable.
  localReadScopeConsent = new SessionLocalReadScopeConsent(
    requestLocalReadScopeConsent,
    (root, grant) => {
      void offerLocalReadScopeRecovery(
        root,
        grant,
        (message, action) => vscode.window.showWarningMessage(message, action),
      );
    },
    // v0.9.99: the person's Local read scope choice of "parent" covers the parent folder without a question; one
    // non-modal notice says so. A whole volume, and a root revoked this session, keep the existing question.
    {
      autoGrant: isImpliedLocalReadRoot,
      onAutoGranted: (root) => {
        void vscode.window.showInformationMessage(
          `Agents can now read and search ${root}, the folder that contains this workspace (your Local read scope setting). `
            + 'File names and contents they read may go to the agent\'s model provider; writes and commands stay in your working folder. '
            + 'To stop this, run "UnodeAi: Security" from the Command Palette and choose revoke under Local folder discovery, '
            + 'or set unode.localReadScope to workspace in User Settings.',
        );
      },
    },
    // v0.9.101 (the access table, the Owner's decision to move it in this version): the deliberate grants are its rows.
    // v0.9.102 (R4a): a change of them is also when a running Codex turn's started sandbox can outlive a grant.
    {
      map: accessTable.grantRows.map,
      changed: () => { accessTable.grantRows.changed(); noticeCodexGrantBoundaries(); recheckNativeRenderAuthorities(); SecurityPanel.refreshIfOpen(); },
      changedLater: () => {
        accessTable.grantRows.changedLater();
        queueMicrotask(() => { noticeCodexGrantBoundaries(); recheckNativeRenderAuthorities(); });
        SecurityPanel.refreshIfOpen();
      },
    },
  );
  context.subscriptions.push({ dispose: () => localReadScopeConsent.endPathAccessSession() });
  // v0.9.102 (the Owner, field 2026-11-12): network allowed from a card or removed shows on an open Security page at once.
  context.subscriptions.push({ dispose: codexSessionNetwork.onChange(() => { recheckNativeRenderAuthorities(); SecurityPanel.refreshIfOpen(); SetupGuidePanel.refreshCurrent(); chatViewProvider?.refresh(); }) });
  // v0.9.101 (R1 §2.4): what the table recorded before a reload comes back as history; its requests are closed by the
  // reload and nothing of it grants anything.
  try { accessTable.restore(rootWorkspaceState.get(ACCESS_TABLE_KEY)); } catch { /* A table that cannot be read starts empty. */ }
  accessTableStore = { update: (key, value) => rootWorkspaceState.update(key, value) };
  // Only a genuinely new request of the person releases the crew's earlier local-read decline. Chat, the chat
  // participant and a retried request all enter here; a tool retry, a delegate wake and an automatic continuation
  // never do.
  userRequests = new UserRequestEntrance({
    beginUserRequest: () => localReadScopeConsent.beginUserRequest(),
    bus: messageBus,
    agents: {
      has: (agentId) => sessionManager.get(agentId) !== undefined,
      isRunning: (agentId) => sessionManager.isRunning(agentId),
      // A message to a stopped agent starts it on the program it is pinned to.
      start: (agentId) => sessionManager.start(agentId, { pin: 'reuse' }),
    },
  });
  // One host-owned, expiring store transports opaque assets across delegates. It is not a shared read grant:
  // WorkspaceTools permits only assets explicitly handed to an agent for this turn or created by that agent.
  const officeArtifactHistory = new OfficeArtifactHistory({
    write: (key, record) => rootWorkspaceState.update(key, record),
    failed: () => outputChannel.warn('Office source and image history has not been saved yet. Existing files and live operations are unchanged.'),
    saved: () => rootWorkspaceState.keys().filter(key => key.startsWith('unode.officeArtifact.v1.')).map(key => rootWorkspaceState.get<unknown>(key)),
  });
  context.subscriptions.push({ dispose: () => { void officeArtifactHistory.flush(); } });
  const delegationContentAssets = new ContentAssetStore({ officeHistory: officeArtifactHistory });
  contentAssetStore = delegationContentAssets;
  imageConnections = new ImageConnectionRegistry(
    () => effectiveConnectionRegistry,
    () => imageDefaultUpdate ? undefined : selectedImageConnection(),
    agentId => sessionManager?.get(agentId)?.config.mediaModels?.imageGeneration,
    () => readImageGenerationModel(vscode.workspace.getConfiguration('unode')),
  );
  const imagePreview = new ImagePreviewHost();
  const imageHistory = new ImageOperationHistory({
    write: (key, record) => rootWorkspaceState.update(key, record),
    failed: () => outputChannel.warn('Image operation history has not been saved yet. This does not change image generation or existing image files.'),
  });
  context.subscriptions.push({ dispose: () => { void imageHistory.flush(); } });
  imageGeneration = new ImageGenerationHost(delegationContentAssets, {
    connections: imageConnections, secret: name => secrets.get(name),
    usage: (agentId, attemptId) => {
      const requestId = sessionManager.currentRequestId(agentId);
      const history = imageHistory.capture({ agentId, ...(requestId ? { requestId } : {}), ...(attemptId ? { attemptId } : {}) });
      const spend = requestId ? spendHost?.coordinator.imageGenerationUsage({ requestId, agentId }) : undefined;
      return { started: receipt => { history?.started(receipt); spend?.started(receipt); },
        settled: (receipt, rawUsage) => { history?.settled(receipt, rawUsage); spend?.settled(receipt); } };
    },
    egress: async (connection, signal) => {
      if (signal.aborted) throw Error('cancelled');
      await egressGate(connection.endpointBase + '/images/generations', undefined, 'Image generation (' + connection.modelId + ')',
        { profileId: connection.connectionId, profileRevision: connection.revision }, { agentId: connection.agentId });
    },
    egressCurrent: connection => {
      const target = canonicalDestination(connection.endpointBase);
      return !!target && consentGrants.hasModel(connection.connectionId, target.destination, connection.revision);
    },
    preview: async receipt => {
      if (!receipt.asset_id) return;
      const image = await delegationContentAssets.imageBytesForDocument(receipt.asset_id);
      if (!('error' in image) && image.mimeType === 'image/png' && image.sha256 === receipt.sha256) imagePreview.show(receipt, image.bytes);
    },
  });
  context.subscriptions.push(imageConnections, imageGeneration, imagePreview, vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('unode.imageGenerationConnection') || event.affectsConfiguration('unode.imageGenerationModel')) {
      imageConnections?.refresh();
    }
  }));
  orchestrationHost = new OrchestrationHostAdapter(
    {
      coordinatorId: () => sessionManager.coordinatorId(),
      workspace: () => ({
        root: workspaceRoot,
        roots: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
        isTrusted: () => vscode.workspace.isTrusted,
        additionalReadRoots: configuredAdditionalRoots,
        // v0.9.97: a virtual folder's fsPath is not a path on this computer, and a remote window's file semantics are
        // not yet validated for chat file links, so both refuse them until they are.
        allFoldersLocal: () => !vscode.env.remoteName
          && (vscode.workspace.workspaceFolders ?? []).every((folder) => folder.uri.scheme === 'file'),
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
      fullFileAccess: (config) => autonomyForAgent(config).fullFileAccess,
      taskScopeActive: (agentId) => sessionManager.currentTurnHasTaskScope(agentId),
      taskWorkspaceAccess: (agentId) => sessionManager.currentTurnWorkspaceAccess(agentId),
      effectiveExecutionIdentity: (agentId) => sessionManager.effectiveExecutionIdentity(agentId),
      admitCoordinatorAttempt: (attempt, identity) => admitArtifactReviewAttempt(attempt, identity),
      backendKindFor: (config) => config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry),
      commandPolicyFor: (config) => createAgentCommandPolicy(commandPolicy, config,
        () => sessionManager.get(config.id)?.config ?? config, autonomyForAgent),
      verifyCommandFor: verifyCommandForAgent,
      runVerification: (config, launchId) => runAgentVerification(config, true, launchId),
      workingDirectoryFor: (config) => config.workingDirectory || workspaceRoot(),
      requestCommandApproval: (config, command, commandContext) =>
        requestCommandApproval(command, config.name, commandContext, { agentId: config.id, sessionId: config.id }),
      routeNotice: (config, line) => outputChannel.info(`[route] ${config.id}: ${line}`),
      verifyCommandOutsideRoot: notifyVerifyCommandOutsideRoot,
      approveCoordinatorBriefEgress,
      taskClaims: () => taskClaims,
      escalateToFallback: (agentId) => sessionManager.escalateToFallback(agentId),
      // v0.9.103 (F1): a coordinator whose session the host stopped has already settled the task as interrupted; the
      // teammate's receipt says so. Every other caller cancels.
      cancelDelegatedWorker: (event) => sessionManager.cancelDelegation(event.agentId, event.handle, event.reason,
        event.interruption ? 'interrupt' : 'cancel'),
      delegationExecution: (agentId, handle) => sessionManager.delegationExecution(agentId, handle),
      delegationWorkProgress: (agentId, handle) => sessionManager.checkpointProgressFor(agentId, handle),
      replyToTask: (coordinatorId, handle, exchangeId, text) => sessionManager.replyToTask(coordinatorId, handle, exchangeId, text),
      stopTeammate: (coordinatorId, agentId, reason) => {
        if (agentId === coordinatorId) { return false; }
        const session = sessionManager.get(agentId);
        if (!session || session.status !== 'running') { return false; }
        outputChannel.info(`Coordinator stopped ${session.config.name}: ${reason}`);
        void sessionManager.stop(agentId, 10000, 'host');
        return true;
      },
      pathGrantsFor: (requestId) => localReadScopeConsent.pathAccessFor(requestId),
      offerPathAccess: (agentId, target, access, consumer) => agentPathAccessOffers.get(agentId)?.(target, 'refused', access, consumer),
      noteAdmittedTaskScope: (handle, scope) => {
        if (!orchestrationProgress.recordAdmittedScope(handle, scope)) return;
        const summaries = orchestrationProgress.snapshot();
        chatViewProvider?.setDelegationProgress(summaries);
        messageLogProvider?.setDelegationProgress(summaries);
      },
      currentRequestId: (agentId) => sessionManager.currentRequestId(agentId),
      taskResume: () => taskResumeRefs,
      queueAsyncDelegationWake: (coordinatorId, result, isReady, consume) => {
        return sessionManager.queueAsyncDelegationWake(
          coordinatorId,
          { ...result, runId: runLedger.runIdForDelegation(result.handle) },
          isReady,
          consume,
          () => resultDeliveryHost.prepare(coordinatorId, result.handle, result.resultRevision),
        );
      },
      recoveredAsyncResults: (coordinatorId) => resultDeliveryHost.recover(coordinatorId),
      retainAsyncResult: (coordinatorId, result) => {
        resultDeliveryHost.retain(coordinatorId, result);
      },
      resultRevisionFor: (id, handle) => runLedger.resultIdentity(id, handle)?.ref.revision,
      resolveFindingRefs: (handle, refs, coordinatorId) => runLedger.resolveFindingRefs(handle, refs, coordinatorId),
      undecidedReviewFindings: (handle, coordinatorId) => runLedger.undecidedReviewFindings(handle, coordinatorId),
      consumeAsyncResult: () => {}, // Removal is acknowledged by the typed delivered callback below.
      prepareAsyncResultDelivery: (id, handle, revision) => resultDeliveryHost.prepare(id, handle, revision),
      resultDelivered: (id, handle, via, revision) => resultDeliveryHost.delivered(id, handle, via, revision),
      resultEligible: (id, handle, revision) => revision !== undefined && resultDeliveryHost.canDeliver(id, handle, revision),
      resultCloseoutBlockers: id => runLedger.resultCloseoutBlockers(id),
      resultReworkStarted: (id, handle) => {
        runLedger.beginResultRework(id, handle); resultDeliveryHost.archiveDecided(id, handle); resultDeliveryHost.reserve(id, handle);
      },
      warnUser: (message) => { void showResultNotice('warning', message); },
      // v0.9.103: these lines arrive while the coordinator's turn runs (a dispatch, a blocked check); they never end it.
      publishCoordinatorNotice: (coordinatorId, text) => chatViewProvider?.postRuntimeNotice(coordinatorId, text),
      reworkHeld: (coordinatorId, held, continueRework) => notifyReworkHeld(coordinatorId, held, continueRework),
      publishDelegationReceiptChange: (coordinatorId, receipt) => {
        // Late admission or refusal: patch the footer of the reply this receipt belongs to. Never a new chat item,
        // and never a change to the coordinator's running state (a notice would mark a running PM as stopped).
        // v0.9.102 (field T2): what is still starting from that turn, for its reply's PM status.
        sessionManager.noteDelegationReceiptChange(coordinatorId, receipt);
        pmLive?.schedule();
        const turnId = sessionManager.turnIdForDelegationReceipt(coordinatorId, receipt.turn);
        if (!turnId) return;
        chatViewProvider?.updateTurnReceipt(coordinatorId, turnId, {
          accepted: receipt.accepted,
          refused: receipt.refused,
          pending: receipt.pending,
        });
        // v0.9.103 (G4): that turn's request closeout follows the receipt. While a dispatch of it waits for its teammate,
        // the request is in progress; once the dispatch is taken up its run says so, and one refused, cancelled or lost
        // before that no longer counts. Applied in the closeout sync, after the run an admission records, so no card
        // reads the request as answered between the two.
        noteCloseoutReceipt(coordinatorId, turnId, receipt);
      },
      // v0.9.93: the turn a dispatch call runs in, read while the call runs. Its receipt is published at admission.
      turnOrigin: (coordinatorId) => ({
        correlationId: sessionManager.currentTurnCorrelationId(coordinatorId),
        turnId: sessionManager.currentTurnId(coordinatorId),
      }),
      // v0.9.93: the first-action gate of the coordinator's turn. The session owns the guard; the team tools ask it,
      // naming the backend launch they were built for.
      firstActionCallArrived: (coordinatorId, launchId) => sessionManager.firstActionCallArrived(coordinatorId, launchId),
      firstActionCallAnswered: (coordinatorId, launchId, tool, accepted) =>
        sessionManager.firstActionCallAnswered(coordinatorId, launchId, tool, accepted),
      openRecordedFile: (filePath, position) => openRecordedFile(filePath, position),
      revealRecordedFile: async (filePath) => {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
      },
      // v0.9.108 (L1): the person's Export PDF of a checked file, run by that agent's own export.
      exportRecordedFilePdf: (agentId, filePath) => exportFilePdfForPerson(agentId, filePath),
      warnFileNavigation: (message, reference, reveal) => {
        const actions = reveal ? [REVEAL_IN_OS, COPY_REFERENCE_PATH] : [COPY_REFERENCE_PATH];
        void vscode.window.showWarningMessage(message, ...actions).then((choice) => {
          if (choice === COPY_REFERENCE_PATH) void vscode.env.clipboard.writeText(reference);
          if (choice === REVEAL_IN_OS && reveal) void reveal();
        });
      },
      pickFileLinkFolder: async (folders, reference) => {
        const picked = await vscode.window.showQuickPick(
          folders.map((folder) => ({ label: path.basename(folder) || folder, description: folder, folder })),
          { title: 'Open a file link', placeHolder: `Which folder is "${reference.slice(0, 120)}" in?` },
        );
        return picked?.folder;
      },
    },
    {
      recordDispatched: (event, coordinator) => {
        runLedger.recordDelegationDispatched({
          ...event,
          route: runRouteReceipt(event.agentId),
          ...dispatchOriginOf(event, coordinator.id),
        });
        resultDeliveryHost.reserve(coordinator.id, event.handle);
        if (event.replacesHandle && event.replacementReason) {
          orchestrationProgress.recordDisposition(
            event.replacesHandle,
            'superseded',
            event.replacementReason,
            event.dispatchedAt,
            event.handle,
          );
        }
        // A host retry makes its earlier attempt history. The card counts it that way from this receipt on,
        // not from the retry's result.
        if (event.retryOfHandle && event.retryStage
            && orchestrationProgress.recordRetryLink(event.handle, event.retryOfHandle, event.retryStage)) {
          const summaries = orchestrationProgress.snapshot();
          chatViewProvider?.setDelegationProgress(summaries);
          messageLogProvider?.setDelegationProgress(summaries);
          teamViewProvider?.setDelegationProgress(orchestrationProgress.agentStates());
        }
      },
      recordRefused: (event, coordinator) => runLedger.recordRefusedDispatch({
        ...event,
        ...dispatchOriginOf(event, coordinator.id),
      }),
      recordEvidence: ({ handle, outcome, evidence, agentId, executionEnded }) => {
        runLedger.recordDelegationEvidence({ handle, outcome, evidence, agentId, executionEnded });
        const effectsVisible = evidence.refusedEffects
          ? orchestrationProgress.recordEffects(handle, {
              refusedOutstanding: evidence.refusedEffects,
              succeeded: evidence.changedFiles.length > 0 || evidence.unrecordedWrites,
            })
          : false;
        const evidenceVisible = orchestrationProgress.recordEvidence(handle, outcome);
        const taskStateVisible = (evidence.contextGaps ?? []).reduce(
          (visible, gap) => orchestrationProgress.recordTaskState(handle, { kind: 'context-gap', ...gap }) || visible,
          false,
        );
        if (!effectsVisible && !evidenceVisible && !taskStateVisible) { return; }
        const summaries = orchestrationProgress.snapshot();
        chatViewProvider?.setDelegationProgress(summaries);
        messageLogProvider?.setDelegationProgress(summaries);
        teamViewProvider?.setDelegationProgress(orchestrationProgress.agentStates());
      },
      recordDisposition: (event) => {
        runLedger.recordDisposition(event);
        const coordinatorId = runLedger.snapshot().find(run => run.delegations.some(row => row.handle === event.handle))?.coordinatorId;
        if (coordinatorId) resultDeliveryHost.archiveDecided(coordinatorId, event.handle);
        orchestrationProgress.recordDisposition(
          event.handle,
          event.disposition,
          event.reason,
          event.recordedAt,
          event.replacementHandle,
        );
        const summaries = orchestrationProgress.snapshot();
        chatViewProvider?.setDelegationProgress(summaries);
        messageLogProvider?.setDelegationProgress(summaries);
        teamViewProvider?.setDelegationProgress(orchestrationProgress.agentStates());
      },
      recordLateReworkReply: (event) => {
        const notice = orchestrationProgress.recordLateReworkReply(event.handle, event.repliedAt);
        if (!notice) return undefined;
        const summaries = orchestrationProgress.snapshot();
        chatViewProvider?.setDelegationProgress(summaries);
        messageLogProvider?.setDelegationProgress(summaries);
        teamViewProvider?.setDelegationProgress(orchestrationProgress.agentStates());
        return notice;
      },
      recordCancelled: (event) => {
        runLedger.recordDelegationCancelled(event);
        if (!orchestrationProgress.recordCancellation(event.handle, event.cancelledAt)) return;
        const summaries = orchestrationProgress.snapshot();
        chatViewProvider?.setDelegationProgress(summaries);
        messageLogProvider?.setDelegationProgress(summaries);
        teamViewProvider?.setDelegationProgress(orchestrationProgress.agentStates());
      },
      recordInterrupted: (event) => {
        runLedger.recordDelegationInterrupted(event);
        if (!orchestrationProgress.recordInterruption(event.handle, event)) return;
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
      // v0.9.100 (field, 4c06a304 T2 and S7a): a modal here opened in the middle of the request, over the choice of a file
      // grant the same request was waiting for. A coordinator handing a decision to a person is no reason to stop them.
      openHumanReview: (runId) => {
        void vscode.window.showInformationMessage('A task was handed to you to decide. Its work and evidence are ready to review.', 'Review').then((choice) => {
          if (choice === 'Review') void vscode.commands.executeCommand('unode.reviewRun', runId);
        });
      },
      refreshAfterAsyncResult: () => { chatViewProvider?.refresh(); },
    },
  );
  taskInputResolver = orchestrationHost.createTaskInputResolver(delegationContentAssets);
  const reviewAuthorWorkspace = firstWorkspaceRoot();
  taskInputResolver.setWorkspaceAuthorLookup((_workspace, physicalKey, digest) => reviewAuthorWorkspace
    ? runLedger?.fileCommits.author(reviewAuthorWorkspace, physicalKey, digest)?.reportedModelId : undefined);
  // v0.9.97: saved task batches live in this workspace's own extension storage on this machine: not in the project,
  // not synced, never uploaded. Like all project state they are kept apart by the first folder's root identity. A
  // window without a workspace folder has none, and a task there is told it cannot save.
  const checkpointRoot = firstWorkspaceRoot();
  taskCheckpointStore = new TaskCheckpointStore({
    root: context.storageUri && checkpointRoot
      ? path.join(context.storageUri.fsPath, 'task-checkpoints', workspaceRootIdentity(checkpointRoot).slice(0, 32))
      : undefined,
    // v0.9.99: a task this window knows can still be read by its coordinator, so its batches are never reclaimed.
    isReferenced: (attemptId) => taskInputResolver.deliveryPlanOf(attemptId) !== undefined,
  });
  taskInputResolver.setCheckpointStore(taskCheckpointStore, {
    saved: (attemptId) => { sessionManager?.noteTaskCheckpointSaved(attemptId); },
    due: (attemptId) => sessionManager?.takeCheckpointDueNotice(attemptId),
  });
  void taskCheckpointStore.load().then(async (report) => {
    if (report.discardedUnconfirmed > 0 || report.damaged > 0) {
      outputChannel.info(`[saved batches] ${report.discardedUnconfirmed} unconfirmed partial write(s) removed; `
        + `${report.damaged} unreadable entr${report.damaged === 1 ? 'y' : 'ies'} left on disk and not listed.`);
    }
    await taskCheckpointStore?.pruneExpired();
  }, () => undefined);
  for (const interruption of restoredInterruptions) {
    if (interruption.attemptId) taskInputResolver.endAttempt(interruption.attemptId, 'interrupted');
  }
  context.subscriptions.push({ dispose: () => { void delegationContentAssets.dispose(); } });
  fileCoordinator = makeFileCoordinator();
  fileWritePolicy = makeFileWritePolicy();
  worktreeCoordinator = makeWorktreeCoordinator();
  // Live review board (A2): when a lane's verify state changes (merge gate, re-verify), refresh the
  // open worktree panel so the user sees ✓/✗ flips without reopening it.
  if (worktreeCoordinator) {
    worktreeCoordinator.onChange = () => { void refreshWorktreePanel(); };
  }
  commandPolicy = makeCommandPolicy();
  lastAutonomyUserSetting = configuredSetting<string>('autonomy', 'workspace');
  lastAutonomyAdvancedFingerprint = JSON.stringify([configuredSetting('commandApproval', 'all'),
    configuredSetting('allowedCommands', []), configuredSetting('writeApproval', 'none')]);
  commandPolicy.onFirstBlock = () => showBlockedWarning();
  // MCP host for in-process (openai-compat) agents. Secrets for ${VAR} placeholders are resolved
  // from SecretStorage — never process.env. claude agents use claude's native MCP instead.
  // v0.9.99: no host deadline on a tool call (undefined); a server's own configured timeout still applies.
  mcpHub = new MCPHub(createRealMcpClient, (name) => secrets.get(name), undefined, async (quarantined) => {
    const configured = mcpRegistry.get(quarantined.id);
    if (!configured) throw new Error('the integration is no longer configured');
    const outcome = await mountMcpServer(configured);
    if (outcome !== 'mounted') {
      throw new Error(mcpMountDetails.get(configured.id) ?? 'the approved mount path did not reconnect');
    }
  });
  // SKILL.md is the runtime source of truth. A damaged installed skill stays unavailable while
  // unrelated skills and activation continue; record only diagnostic counts, never source/error contents.
  const agentSkillRegistry = SkillRegistry.load(path.join(context.extensionUri.fsPath, 'skills'));
  if (agentSkillRegistry.issues.length) outputChannel.warn(`Installed skill validation: ${agentSkillRegistry.issues.length} issue(s). Affected skills are unavailable; other work can continue.`);

  // F4/B1: project/team context (.unode/rules.md plus compatible root instruction files and shared notes),
  // attached to every turn. The backend keeps this timestamped state out of its cacheable system prefix.
  const boundRoot = firstWorkspaceRoot();
  if (boundRoot) {
    rulesFile = new RulesFile(rulesFilePath(boundRoot));
    projectKnowledge = new ProjectKnowledge(boundRoot);
    sharedMemory = new SharedMemory(memoryFilePath(boundRoot));
    memoryAttestationStore = new MemoryAttestationStore(rootWorkspaceState, boundRoot);
    // A1/A2: auto-detected project conventions (package.json scripts + how to run them), injected the
    // same way as rules so every agent (even weak ones) uses the right commands instead of inventing them.
    projectConventions = new ProjectConventions(boundRoot);
  }
  // P3: await the initial loads during activation so the very first turn already carries project
  // context — otherwise a user who sends a message the instant the extension loads could get an agent
  // turn with no scripts/rules injected. Both are cheap disk reads; watchers still hot-reload on change.
  // Guarded + skipped without a workspace: these must never abort activation (which happens before the
  // webview providers register below) — otherwise the panels show only their titles, no content. When
  // With no folder open there is no project target. Skip disk work; workspaceRoot() deliberately throws
  // instead of falling back to the editor process directory.
  if (rulesFile && projectKnowledge && sharedMemory && projectConventions) {
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
  // v0.9.94: optional request limits. Unset (the default), no request is tracked and nothing here ever waits.
  const ceiling = new RequestCeilingGate({
    readLimits: () => normalizeRequestLimits({
      providerTurns: configuredSetting<unknown>('requestLimits.providerTurns', null),
      tokens: configuredSetting<unknown>('requestLimits.tokens', null),
    }),
    decide: (facts, signal) => askRequestLimitDecision(facts, signal, {
      openCard: openRequestLimitCard,
      agentNames: (requestId) => sessionManager.liveRequestAgents(requestId)
        .map((agentId) => sessionManager.get(agentId)?.config.name ?? agentId),
      // The card belongs to the conversation the request was asked in. A request no agent was asked for is
      // shown with the first agent working on it.
      askedAgent: (requestId) => {
        const agentId = sessionManager.requestRootAgent(requestId) ?? sessionManager.liveRequestAgents(requestId)[0];
        return agentId ? { id: agentId, name: sessionManager.get(agentId)?.config.name ?? agentId } : undefined;
      },
      windowMs: DEFAULT_REQUEST_DECISION_TIMEOUT_MS,
    }),
    stopRequest: (requestId) => { sessionManager.stopRequest(requestId, REQUEST_LIMIT_STOP); },
    // A limited request is forgotten only once nothing in the session manager can continue it.
    reachableRequests: () => sessionManager.reachableRequestIds(),
  });
  requestCeiling = ceiling;
  // Shown every usage call that the spend records are shown, so the limits count what the records count. On
  // the Claude CLI and Codex routes the CLI makes the model requests inside a turn, so there a turn counts as one.
  const limitMeter = new RequestLimitMeter(ceiling, (agentId) => {
    const backend = sessionManager.get(agentId)?.config.backend;
    return backend === 'claude' || backend === 'codex';
  });
  // The disposed gate stays in place: it refuses what arrives late instead of letting it through.
  context.subscriptions.push({ dispose: () => ceiling.dispose() });
  // v0.9.110 S1: one suggestion request after an answer, on the model chosen in User Settings, accounted under the
  // answer's request: its own Spend unit and the root request's remaining limit tranche. None sends nothing.
  replySuggestions = new ReplySuggestionService({
    readModel: () => readReplySuggestionModel(vscode.workspace.getConfiguration('unode')),
    settingsRevision: () => replySuggestionSettingsRevision,
    connection: (connectionId) => suggestionConnection(connectionId),
    apiKey: (secretName) => secrets.get(secretName),
    // The existing model-egress decision for that connection and revision; it never borrows another connection's grant.
    // A suggestion is not the person's request: under a standing decline it asks at most once for each setting, then
    // refuses without a dialog until the setting changes (Providers says so).
    approveEgress: (url, scope, requester) => {
      const mayAsk = replySuggestionAskedRevision !== replySuggestionSettingsRevision;
      replySuggestionAskedRevision = replySuggestionSettingsRevision;
      return egressGate(url, undefined, requester, scope, { purpose: 'reply-suggestion', ...(mayAsk ? {} : { askIfDeclined: false as const }) });
    },
    fetch: oneTextRequestFetch,
    ceiling,
    meter: limitMeter,
    spend: {
      beginUsageUnit: (unit) => { spendSafely(() => spendHost?.coordinator.beginUsageUnit(unit)); },
      noteModelRequest: (usageUnitId) => { spendSafely(() => spendHost?.coordinator.noteModelRequest(usageUnitId)); },
      settleUsageUnit: (usageUnitId, usage) => spendSafely(() => spendHost?.coordinator.settleUsageUnit(usageUnitId, usage)),
      closeUsageUnit: (usageUnitId) => spendSafely(() => spendHost?.coordinator.closeUsageUnit(usageUnitId)),
    },
    newId: () => randomUUID(),
    log: (message) => outputChannel.warn(message),
    // Why the last suggestion gave nothing is shown in Settings -> Providers, never as a chat turn or a dialog.
    statusChanged: () => SettingsPanel.refreshCurrent(),
  });
  context.subscriptions.push({ dispose: () => replySuggestions?.cancelAll() }, vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('unode.replySuggestions.model')) return;
    // Off, or another connection or model: what is in flight ends now and is never shown.
    replySuggestionSettingsRevision += 1;
    replySuggestions?.cancelAll();
    replySuggestions?.resetStatus();
    chatViewProvider?.dismissReplySuggestions();
    SettingsPanel.refreshCurrent();
  }));
  // v0.9.90: one compaction coordinator for every agent: its pre-dispatch gate and manual Compact.
  const mapReduceSummarizer = new MapReduceSummarizer();
  const compactionCoordinator = new ContextCompactionCoordinator({
    resolvePolicy: (config, contextWindow, route) => resolveSmartCompactionPolicy({
      policy: bundledSmartCompactionPolicy(),
      agent: config,
      teamOverrides: teamCompactionOverrides,
      contextWindow,
      route,
    }),
    // Host-history (OpenAI-compatible), and Claude's and Codex's own compaction at the idle boundary.
    admitted: (config) => ['openai-compat', 'claude', 'codex'].includes(config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry)),
    hostSummarizer: (config) => {
      const model = economyModelFor(config);
      const window = summarizerContextWindow(config, model);
      return {
        summarizer: mapReduceSummarizer,
        io: {
          chatCompletion: (messages, summaryModel, params, signal, onRequestSent) =>
            summaryChatCompletion(config, messages, summaryModel, params, signal, onRequestSent),
        },
        model,
        contextWindow: window.tokens,
        contextWindowSource: window.source,
      };
    },
    // v0.9.99: background compaction progress goes to the session, which exists by the time any job runs.
    // The composer's ring shows the background summary's state, so the chat is redrawn with each event.
    onBackgroundEvent: (event) => {
      sessionManager?.noteBackgroundCompaction(event);
      chatViewProvider?.refresh();
    },
    // Read when a unit starts, not now: the spend host is created later in activation. A spend failure is logged
    // and never reaches compaction, as for ordinary turns.
    spend: {
      // v0.9.94: a compaction's model requests are requests of the request it compacts for, so its limit counts them.
      beginUsageUnit: (unit) => {
        // The host sends each summary request itself, whatever route the agent is on: counted one by one.
        limitMeter.beginUsageUnit(unit, 'request');
        spendSafely(() => spendHost?.coordinator.beginUsageUnit(unit));
      },
      noteModelRequest: (usageUnitId) => {
        limitMeter.noteModelRequest(usageUnitId);
        spendSafely(() => spendHost?.coordinator.noteModelRequest(usageUnitId));
      },
      settleUsageUnit: (usageUnitId, usage) => {
        limitMeter.settleUsageUnit(usageUnitId, usage);
        spendSafely(() => spendHost?.coordinator.settleUsageUnit(usageUnitId, usage));
      },
    },
    newOperationId: () => randomUUID(),
  });
  // v0.9.99: a background summary never outlives the extension.
  context.subscriptions.push({ dispose: () => compactionCoordinator.dispose() });
  // One approval authority for every agent/backend created during this extension-host session. This is
  // intentionally neither persisted nor keyed to a single agent: an explicit crew-wide session allow is
  // exactly what the public-web card promises.
  const crewWebAccess = new SessionWebAccessApprover(requestWebAccessApproval, joinWebAccessApproval);
  const transcriptionHistory = new BoundedOperationHistory(rootWorkspaceState, 'unode.transcription.v1.');
  const paidToolAccounting = createPaidToolAccounting({
    currentRequestId: agentId => sessionManager.currentRequestId(agentId),
    meter: limitMeter,
    spend: () => spendHost?.coordinator,
    onSpendError: () => outputChannel?.warn('Spend tracking skipped an event.'),
  });
  const audioTranscription = new TranscriptionHost({
    route: agentId => {
      const member = sessionManager?.get(agentId)?.config;
      if (!member) return undefined;
      const model = effectiveMediaModel(member.mediaModels?.transcription, readTranscriptionDefault(vscode.workspace.getConfiguration('unode')));
      if (!model || !verifiedUnodeTranscriptionModel(model)) return undefined;
      const profile = effectiveConnectionRegistry.connectionProfile('unode');
      if (profile?.availability !== 'available' || profile.authKind !== 'api-key' || !profile.apiKeySecretName
        || profile.presentation.endpointDefault !== UNODE_DEFAULT_BASE_URL) return undefined;
      return { connectionId: 'unode', revision: profile.revision, endpointBase: UNODE_DEFAULT_BASE_URL,
        model: model.modelId, secretName: profile.apiKeySecretName, verifiedLimit: verifiedTranscriptionUploadBytes[model.modelId] };
    },
    secret: name => secrets.get(name),
    modelEgress: (route, task) => egressGate(route.endpointBase + '/audio/transcriptions', undefined, 'Audio transcription (' + route.model + ')',
      { profileId: route.connectionId, profileRevision: route.revision }, { agentId: task.agentId, sessionId: task.agentId }),
    audioEgress: (request, task) => mediaEgressGate(request, 'Audio transcription', { agentId: task.agentId, sessionId: task.agentId }),
    egressCurrent: route => {
      const target = canonicalDestination(route.endpointBase);
      return !!target && consentGrants.hasModel(route.connectionId, target.destination, route.revision)
        && consentGrants.hasMedia(target.host, 'transcription');
    },
    activity: (task, message) => sessionManager.noteHostToolActivity(task.agentId, task.turnId, message),
    ...paidToolAccounting.transcription,
    receipt: receipt => {
      void transcriptionHistory.write(receipt)
        .catch(() => outputChannel.warn('Audio transcription operation history could not be saved.'));
    },
  });
  transcriptionHost = audioTranscription;
  const paidWebSearch = new SessionWebAccessApprover(requestWebAccessApproval, undefined, false);
  const publicWebPolicy = () => configuredSetting<'ask' | 'allow' | 'off'>('webAccess', DEFAULT_WEB_ACCESS_POLICY);
  const memberSearchOff = (agentId: string) => sessionManager?.get(agentId)?.config.publicSearch === 'off';
  const searchHistory = new BoundedOperationHistory(rootWorkspaceState, 'unode.webSearch.v1.');
  const search = new UnodeSearchHost({
    connection: () => {
      const profile = effectiveConnectionRegistry.connectionProfile('unode');
      if (profile?.availability !== 'available' || profile.authKind !== 'api-key' || !profile.apiKeySecretName
        || profile.presentation.endpointDefault !== UNODE_DEFAULT_BASE_URL) return undefined;
      return { connectionId: profile.id, revision: profile.revision, endpointBase: UNODE_DEFAULT_BASE_URL, secretName: profile.apiKeySecretName };
    },
    secret: name => secrets.get(name),
    policy: agentId => memberSearchOff(agentId) ? 'off' : publicWebPolicy(),
    approve: (turn, query, unitPrice) => paidWebSearch.requestApproval({
      agentId: turn.agentId, sessionId: turn.agentId, agentName: sessionManager.get(turn.agentId)?.config.name ?? turn.agentId,
      toolName: 'web_search', purpose: query,
      paidSearch: { destination: 'Unode', unitPrice, callsPerTurn: UNODE_SEARCH_CALLS_PER_TURN, searchesPerCall: UNODE_SEARCH_USES_PER_CALL },
    }),
    egress: async (agentId, route, signal) => {
      if (signal.aborted) return false;
      try {
        await egressGate(route.endpointBase + '/messages', undefined, 'Public web search (' + UNODE_SEARCH_MODEL + ')',
          { profileId: route.connectionId, profileRevision: route.revision }, { agentId, sessionId: agentId });
        return !signal.aborted;
      } catch { return false; }
    },
    egressCurrent: route => {
      const target = canonicalDestination(route.endpointBase);
      return !!target && consentGrants.hasModel(route.connectionId, target.destination, route.revision);
    },
    activity: (turn, message) => { if (turn.turnId) sessionManager.noteHostToolActivity(turn.agentId, turn.turnId, message); },
    started: paidToolAccounting.search.started,
    settled: (turn, operation, outcome, queries) => {
      const requestId = paidToolAccounting.search.settled(operation, outcome);
      const { connectionId, revision, endpointBase } = operation.route;
      void searchHistory.write({
        agentId: turn.agentId, turnId: turn.turnId, requestId, operationId: operation.operationId,
        connectionId, revision, endpointBase, modelId: UNODE_SEARCH_MODEL, turnCall: operation.turnCall, serviceRequestId: operation.requestId,
        state: outcome.state, mayHaveCost: outcome.may_have_cost, queries,
        ...('details' in outcome ? { usage: outcome.details.usage, displayCost: outcome.details.total } : {}),
      }).catch(() => outputChannel.warn('Public search operation history could not be saved.'));
    },
  });

  // The backend factory decides "how an agent runs", keyed off config.backend (falling back to
  // a provider-based default). Add codex/gemini/etc. factories here as they land.
  const createBackend = (config: AgentConfig, launchId: string): AgentBackend => {
    const onControlFiles = (locations: readonly SecurityControlArtifactLocation[]) => publishRuntimeControlFiles(config.id, launchId, locations);
    // Load-bearing host boundary: config can originate in a webview, team.json, or an older roster.
    // Presentation may hide a control; this assertion makes bypassing that presentation ineffective.
    assertAgentCapabilityCompatibility(config, effectiveConnectionRegistry);
    // Host-side credential boundary: workspace state may select a registered connection, but it
    // may never redirect that connection to another SecretStorage key.
    assertAgentConfigApiKeyOwnership(config, effectiveConnectionRegistry);
    const kind = config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry);
    // v0.9.99: without a folder, only an OpenAI-compatible agent runs, with no file or command tools (see FolderlessChat).
    if (!firstWorkspaceRoot() && !folderlessChatAllowed(kind)) throw new Error(FOLDERLESS_UNAVAILABLE_REASON);
    const routedConfig = kind === 'openai-compat' ? withOpenAICompatBaseUrl(config) : config;
    const runtimeConfig = firstWorkspaceRoot() ? routedConfig : folderlessChatConfig(routedConfig, folderlessChatRoot());
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
    // An exact-file grant is enforced by the host file tools. A native CLI reads and writes with tools of its
    // own, everywhere in its working folder, so such a grant cannot reach it and a file cannot be that folder.
    const exactFiles = kind === 'openai-compat' ? undefined : exactFileGrantsOnFolderRoute(effectiveRoots);
    if (exactFiles?.refused) {
      throw new Error(
        `${runtimeConfig.name}'s Folder Access names files only (${exactFiles.ignored.join(', ')}). Exact-file access is `
        + 'enforced only for OpenAI-compatible agents, so this agent was not started. Grant it a folder, or move it to an '
        + 'OpenAI-compatible connection.',
      );
    }
    for (const ignored of exactFiles?.ignored ?? []) {
      outputChannel.warn(
        `[folderAccess:${runtimeConfig.id}] Exact-file access is enforced only for OpenAI-compatible agents; not given to this agent: ${ignored}`,
      );
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
    const agentCommandPolicy = createAgentCommandPolicy(commandPolicy, scopedConfig,
      () => sessionManager.get(config.id)?.config ?? config, autonomyForAgent);
    const routeBoundary = makeRouteBoundaryAssert(
      scopedConfig,
      kind,
      kind === 'openai-compat' ? (scopedConfig.baseUrl || OPENAI_COMPAT_DEFAULT_BASE_URL)
        : kind === 'codex' ? 'https://api.openai.com'
          : 'https://api.anthropic.com'
    );
    const trustedWriteRoots = writeRootsForTrust(effectiveRoots.writeRoots, vscode.workspace.isTrusted);
    const agentCwd = scopedConfig.workingDirectory || workspaceRoot();
    const currentAutonomy = () => agentAutonomyPolicy(sessionManager.get(config.id)?.config ?? config);
    const fullFileAccess = () => currentAutonomy().fullFileAccess;
    const fullFileAccessRevision = () => JSON.stringify([autonomyPolicyGeneration, agentAutonomyGenerations.get(config.id),
      isAutonomyMode((sessionManager.get(config.id)?.config ?? config).autonomyMode) ? undefined : autonomyDefaults?.revision,
      (sessionManager.get(config.id)?.config ?? config).autonomyMode,
      (sessionManager.get(config.id)?.config ?? config).folderAccess,
      (sessionManager.get(config.id)?.config ?? config).allowedTools,
      sessionManager.currentTurnMode(config.id) ?? chatViewProvider?.getAgentMode(config.id),
      sessionManager.currentTurnId(config.id), vscode.workspace.isTrusted]);
    const livePathAccess: import('./backend/localReadScope').LivePathAccess = () => {
      const current = sessionManager.get(scopedConfig.id)?.config ?? scopedConfig;
      // An independent Folder Access ceiling is deliberate. A new grant never removes it.
      if (!vscode.workspace.isTrusted || current.folderAccess?.length) return [];
      return localReadScopeConsent.pathAccessFor(sessionManager.currentRequestId(scopedConfig.id));
    };
    // v0.9.108 (L1): the person's own Export PDF holds its file authority for as long as the person's authority holds: the
    // member's autonomy and its policy generations, Folder Access, tools, the chat's Plan/Act and Workspace Trust. A model
    // request of the member starting or ending changes none of these, so it neither ends nor widens the person's lease.
    // The model's own revision above stays bound to its turn.
    const personFullFileAccessRevision = () => JSON.stringify([autonomyPolicyGeneration, agentAutonomyGenerations.get(config.id),
      isAutonomyMode((sessionManager.get(config.id)?.config ?? config).autonomyMode) ? undefined : autonomyDefaults?.revision,
      (sessionManager.get(config.id)?.config ?? config).autonomyMode,
      (sessionManager.get(config.id)?.config ?? config).folderAccess,
      (sessionManager.get(config.id)?.config ?? config).allowedTools,
      chatViewProvider?.getAgentMode(config.id), vscode.workspace.isTrusted]);
    // Its path grants are the session's: a grant for one request of the member belongs to that request, not to the person's
    // action. Revocation and Folder Access apply as to the member's own.
    const personPathAccess: import('./backend/localReadScope').LivePathAccess = () => {
      const current = sessionManager.get(scopedConfig.id)?.config ?? scopedConfig;
      if (!vscode.workspace.isTrusted || current.folderAccess?.length) return [];
      return localReadScopeConsent.pathAccessFor(undefined);
    };
    // v0.9.101 (H2a, H3): this agent's offer adds to the request's own items, shared with every agent of the request.
    const fileOutsideRoot = createPathAccessOffer({
      owner: localReadScopeConsent,
      agentId: scopedConfig.id,
      canOffer: () => vscode.workspace.isTrusted && !fullFileAccess() && !(sessionManager.get(scopedConfig.id)?.config ?? scopedConfig).folderAccess?.length,
      captureRequest: () => {
        const requestId = sessionManager.currentRequestId(scopedConfig.id);
        const turnId = sessionManager.currentTurnId(scopedConfig.id);
        if (!requestId || !turnId) return undefined;
        const scopeDecisionCurrent = chatViewProvider?.captureScopeDecision(scopedConfig.id) ?? (() => true);
        return { requestId, isCurrent: () => sessionManager.isCurrentBackendLaunch(scopedConfig.id, launchId)
          && scopeDecisionCurrent()
          && sessionManager.currentRequestId(scopedConfig.id) === requestId
          && sessionManager.currentTurnId(scopedConfig.id) === turnId,
          // v0.9.101 (H2a): a request whose work waits for access is still the person's to grant for.
          requestCurrent: () => sessionManager.requestOwned(requestId),
          decisionCurrent: scopeDecisionCurrent };
      },
      // v0.9.101 (F2): the notice names the target's kind and name first; the request's item for it uses the same handler.
      present: async (named, cause, notice) => await vscode.window.showWarningMessage(
        pathAccessNoticeText(scopedConfig.name, named, cause, notice),
        'Grant access',
      ) === 'Grant access',
      item: (item) => chatViewProvider?.showPathAccessItem(scopedConfig.id, pathAccessItemView(item)),
      satisfied: (label, permission) => {
        void showResultNotice('information', `${label} already has ${permission === 'readwrite' ? 'Read + Write' : 'Read'} access. Nothing was changed.`);
      },
      // A share, device or /net spelling is not asked about: asking would contact that computer (v0.9.101, E2).
      isDirectory: (target) => reachesAnotherComputer(path.resolve(target)) ? undefined
        : statSync(target, { throwIfNoEntry: false })?.isDirectory(),
      // v0.9.101 (G3): the task this agent's turn executes now is the one a later grant lets the PM retry.
      refused: (named, request, access) => taskResumeRefs.capture(scopedConfig.id, request.requestId, named, access),
      choose: async (target, forRequest) => {
        const wholeVolume = path.parse(target.realPath).root === target.realPath;
        const choices = (['request', 'session'] as const).filter((lifetime) => lifetime !== 'request' || forRequest)
          .flatMap((lifetime) => (['read', 'readwrite'] as const).map((permission) => ({
            label: `${permission === 'read' ? 'Read' : 'Read + Write'} — For this ${lifetime}`,
            description: (target.kind === 'file' ? 'This exact file only' : 'This folder and its contents') + ' · Shared by the crew',
            detail: (wholeVolume ? 'Whole volume/share: this can include other users\' profiles. ' : '')
              + 'Read content may reach the crew\'s configured model providers. Explicit tool/task restrictions and command policy still apply.',
            permission, lifetime,
          })));
        const chosen = await vscode.window.showQuickPick(choices, {
          title: `Grant ${target.kind === 'file' ? 'file' : 'folder'} access: ${target.realPath}`,
          placeHolder: 'Choose access and lifetime for the displayed physical file or folder tree.',
          ignoreFocusOut: true,
        });
        return chosen ? { permission: chosen.permission, lifetime: chosen.lifetime } : undefined;
      },
      // v0.9.101 (§4.2): a grant made once its request ended offers Continue, unless a structured preparation of the
      // request continues it: the person's original message, sent again to this agent as a new request, once.
      continuation: (requestId) => endedRequestContinuation({
        agentId: scopedConfig.id,
        hasStructuredPreparation: (id) => sessionManager.requestHasStructuredPreparation(scopedConfig.id, id),
        originalRequest: (id) => {
          const turnId = sessionManager.requestOriginTurnId(id);
          return turnId ? messageBus.getThread(turnId).find((message) => message.id === turnId) : undefined;
        },
        resubmit: (request) => userRequests.resubmit(scopedConfig.id, request),
      }, requestId),
      granted: (grant, _current, requestId, continueOffered) => {
        const capability = grant.permission === 'read' ? 'Read' : 'Read + Write';
        chatViewProvider?.postRuntimeNotice(scopedConfig.id,
          `${capability} file access granted for this ${grant.lifetime}. `
          + 'To revoke it, open UnodeAi: Security from the Command Palette and use revoke under File access grants.');
        // The request it was granted in, whatever this agent is doing by now: the rules are one place's.
        if (!requestId) return;
        // v0.9.101 (H2a): this agent's work in the request waits on this target. The wake its readiness owes is how it is
        // told, once the work can run; a grant that leaves it still waiting starts no turn.
        if (taskResumeRefs.waitsOn(scopedConfig.id, requestId)) {
          chatViewProvider?.postRuntimeNotice(scopedConfig.id, grantWaitingTaskLine());
          return;
        }
        // v0.9.101 (G3): a task of this coordinator that stopped for lack of this access gets its resume_ref here, on the
        // notice this grant sends anyway. A notice that does not reach the agent takes its refs back.
        const notice = taskResumeRefs.grantNotice(scopedConfig.id, requestId,
          `Host scope update: ${capability} access for a requested file or folder is now available for this ${grant.lifetime}. `
          + 'Your next matching file-tool call can use it. This changes no command permission and replays no previous call.');
        sessionManager.tellFileAccessGrant(scopedConfig.id, requestId, notice.text,
          (report) => {
            notice.report(report);
            const line = grantNoticeLine(report, grant.lifetime, continueOffered);
            if (line) chatViewProvider?.postRuntimeNotice(scopedConfig.id, line);
          });
      },
      unavailable: () => { void showResultNotice('information', 'File access was not changed: the choice was dismissed, the agent was stopped or removed, or the target changed.'); },
      requestEnded: () => {
        chatViewProvider?.postRuntimeNotice(scopedConfig.id,
          'File access was not changed: that request ended before you chose, and For this request lasts only while it runs. '
          + 'If the agent still needs this file, send your request again and grant it then.');
      },
    }, requestAccessItems);
    agentPathAccessOffers.set(scopedConfig.id, fileOutsideRoot);
    const grants = effectiveIntegrationGrants(scopedConfig);
    // Tool advertisements are fixed at backend/thread start, but authorization is live. A saved grant
    // removal therefore blocks the very next host-mediated call even before the normal agent restart ends.
    const currentMcpGrants = () => {
      const live = sessionManager.get(scopedConfig.id)?.config;
      return live ? effectiveIntegrationGrants(live) : [];
    };
    // Approval card names the requesting agent, so a teammate's prompt is identifiable from any chat view
    // (the bar is global). Shared by the OpenAI-compat run_command path and the Claude permission gate.
    const approvalOrigin = { agentId: scopedConfig.id, sessionId: scopedConfig.id };
    const requestBoundary = requestBoundaryFor(scopedConfig.id);
    // A CLI route reaches the team tools through a bridge, so the tools themselves ask as well.
    const bridgedTeamTools = () => {
      const tools = orchestrationHost.createCoordinatorTeamTools(scopedConfig, { launchId }, agentCommandPolicy);
      tools.setRequestBoundary(requestBoundary);
      return tools;
    };
    const approveForAgent: CommandApprover = (command, context) => requestCommandApproval(command, scopedConfig.name, context, approvalOrigin);
    // A write is asked for in the agent's name too. Without the origin the card belongs to no agent, and the
    // person's wait counts as that agent's tool time.
    const approveWriteForAgent: WriteApprover = (request) => requestWriteApproval(request, scopedConfig.name, approvalOrigin);
    // v0.9.97: the write policy, seen from this agent: its request's reads and writes, and the person's decision for
    // one change the evidence cannot vouch for, asked in the agent's name.
    const fileWrites = fileWritePolicy.forAgent({
      agentId: scopedConfig.id,
      requestId: () => sessionManager.currentRequestId(scopedConfig.id),
      turnId: () => sessionManager.currentTurnId(scopedConfig.id),
      notice: (message) => chatViewProvider.postRuntimeNotice(scopedConfig.id, message),
      decide: async request => request.purpose === 'security-control'
        ? await requestSecurityControlApproval(request, scopedConfig.name, approvalOrigin)
        // v0.9.108 (D11): each signature placement is its own exact, single-use confirmation.
        : request.purpose === 'pdf-signature' ? await requestSignaturePlacementApproval(request, scopedConfig.name, approvalOrigin)
        : await confirmFolderDelete(request, attentionAppearance('delete-folder'), pausingTurnClock(approvalOrigin)) ? 'once' : 'deny',
      // v0.9.97: a request's closeout lists the files this agent changed relative to its own folder.
      base: agentCwd,
    });
    agentFileWrites.set(scopedConfig.id, fileWrites);
    // v0.9.97: a CLI agent saves a file the user attached on the host's own file tools, reached over the host tool
    // channel the CLI already has (Claude's files bridge, Codex's dynamic tools), with the same write policy, approval
    // card, restore points, Workspace Trust and folders as an OpenAI-compatible agent's tools. Built only for an agent
    // that may write.
    const { write: cliMayWrite, execute: cliMayExecute } = hostFileToolCapabilities(scopedConfig, kind, effectiveRoots.restricted);
    const agentSearch = { host: search, turnId: () => sessionManager.currentTurnId(scopedConfig.id) };
    const transcription = { host: audioTranscription, turnId: agentSearch.turnId };
    const hostFileTools = kind !== 'openai-compat' && (cliMayWrite || cliMayExecute)
      ? cliHostFileTools({
        root: agentCwd,
        agentId: scopedConfig.id,
        mayWrite: cliMayWrite,
        mayExecute: cliMayExecute,
        commandPolicy: agentCommandPolicy,
        requestCommandApproval: approveForAgent,
        livePathAccess,
        fullFileAccess,
        fullFileAccessRevision,
        writeApprovalAsk: () => currentAutonomy().writeReview,
        onFileOutsideRoot: (target, access) => fileOutsideRoot(target, 'refused', access),
        writeRoots: trustedWriteRoots,
        approveWrite: approveWriteForAgent,
        fileWrites,
        requestBoundary,
        contentAssets: delegationContentAssets,
        imageGeneration,
        keepImageToolSignature: kind === 'codex',
        nativeOfficeRenderer,
        pdfSignatures,
        workbookRecalcEngine,
        // The CLI writers' native workbook recalculation follows the same live Web access setting and session approval.
        webAccess: { policy: () => configuredSetting<'ask' | 'allow' | 'off'>('webAccess', DEFAULT_WEB_ACCESS_POLICY),
          requestApproval: (request: WebAccessApprovalRequest) => crewWebAccess.requestApproval({ ...request, agentName: scopedConfig.name, ...approvalOrigin }) },
        officeRenderPreferences: currentOfficeRenderPreferences,
        officeApplicationCatalog: localApplications,
        officeAuthoring: () => currentOfficeAuthoring(scopedConfig.name),
        documentRenderer,
        presentationRenderer,
        onDocumentWritten: (receipt, requestId) => sessionManager.noteDocumentWritten(requestId, receipt),
      })
      : undefined;
    // v0.9.108 (L1): the person's Export PDF: this agent's authority, read when it is clicked, for tools of its own.
    // Its approvals and file effects name no request or turn of the agent; its native restrictions are the agent's
    // backend's, read for the mode the chat shows now.
    const personCapabilities = hostFileToolCapabilities(scopedConfig, kind, effectiveRoots.restricted);
    const personApprovalName = `${scopedConfig.name} · Export PDF you asked for`;
    agentPersonPdfExports.set(scopedConfig.id, (): PersonPdfExportPorts => ({
      root: agentCwd,
      agentId: scopedConfig.id,
      allowed: [
        ...(!Array.isArray(scopedConfig.allowedTools) || scopedConfig.allowedTools.includes('read') ? ['read'] : []),
        ...(personCapabilities.write ? ['write'] : []), ...(personCapabilities.execute ? ['execute'] : []),
      ],
      commandPolicy: agentCommandPolicy,
      approveCommand: (command, context) => requestCommandApproval(command, personApprovalName, context, {}),
      approveWrite: (request) => requestWriteApproval(request, personApprovalName, {}),
      writeApprovalAsk: () => currentAutonomy().writeReview,
      recordCheckpoint: (entry) => recordCheckpoint(entry, 'person'),
      readRoots: effectiveRoots.readRoots,
      writeRoots: trustedWriteRoots,
      fileGrants: { read: effectiveRoots.readFiles, write: writeRootsForTrust(effectiveRoots.writeFiles, vscode.workspace.isTrusted) },
      isTrusted: () => vscode.workspace.isTrusted,
      localScopeReadRoots: configuredLocalReadScopeRoots(),
      localReadScopeConsent: { ensure: (root) => localReadScopeConsent.ensure(root, pausingTurnClock({})),
        granted: (root) => localReadScopeConsent.isGranted(root) },
      livePathAccess: personPathAccess,
      fullFileAccess,
      fullFileAccessRevision: personFullFileAccessRevision,
      fileWrites: fileWritePolicy.forAgent({
        agentId: scopedConfig.id,
        notice: (message) => { void showResultNotice('information', message); },
        decide: async request => request.purpose === 'security-control'
          ? await requestSecurityControlApproval(request, personApprovalName, {})
          : await confirmFolderDelete(request, attentionAppearance('delete-folder'), pausingTurnClock({})) ? 'once' : 'deny',
        base: agentCwd,
      }),
      nativeOfficeRenderer,
      officeRenderPreferences: currentOfficeRenderPreferences,
      officeApplicationCatalog: localApplications,
      officeHistory: officeArtifactHistory,
      nativePolicy: () => {
        const backend = sessionManager.getBackend(scopedConfig.id);
        const mode = chatViewProvider?.getAgentMode(scopedConfig.id) ?? 'act';
        return backend?.personNativeOfficePolicy
          ? backend.personNativeOfficePolicy(mode)
          : `${scopedConfig.name} is not running in this window, so its current restrictions cannot be read. Only this native export is not run.`;
      },
    }));
    // One read-scope prompt can have several agents waiting on it. Each waits with its own turn clock paused.
    const localReadConsentForAgent: LocalReadScopeConsentGate = {
      ensure: (root) => localReadScopeConsent.ensure(root, pausingTurnClock(approvalOrigin)),
      granted: (root) => localReadScopeConsent.isGranted(root),
    };
    const executableSkills = new ExecutableSkillHost({
      registry: agentSkillRegistry,
      grantedNames: scopedConfig.playbooks,
      agentName: scopedConfig.name,
      workspaceRoot: agentCwd,
      runnerPath: extensionContext
        ? path.join(extensionContext.extensionUri.fsPath, 'out', 'skills', 'SkillActionRunner.js')
        : path.join(__dirname, 'skills', 'SkillActionRunner.js'),
      isTrusted: () => vscode.workspace.isTrusted,
      requestApproval: (request) => requestExecutableSkillApproval(request, approvalOrigin),
    });
    const egressRequester = `${scopedConfig.name} via ${displayNameForProviderId(scopedConfig.provider.providerId, effectiveConnectionRegistry)}`;
    const selectedConnection = connectionProfileForAgent(scopedConfig, effectiveConnectionRegistry);
    if (!selectedConnection) throw new Error(`Unknown connection for ${scopedConfig.name}.`);
    const modelEgressScope: ModelEgressScope = {
      profileId: selectedConnection.id,
      profileRevision: selectedConnection.revision,
    };
    const approveModelEgress = (url: string) => egressGate(url, undefined, egressRequester, modelEgressScope, approvalOrigin);
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
      mediaEgressGate(request, `${egressRequester}: ${request.kind} media upload`, approvalOrigin);
    const webAccess = {
      // v0.9.99: absent means the shipped default, Allow; an explicit Ask or Off from User Settings is kept.
      policy: () => configuredSetting<'ask' | 'allow' | 'off'>('webAccess', DEFAULT_WEB_ACCESS_POLICY),
      requestApproval: (request: WebAccessApprovalRequest) => crewWebAccess.requestApproval({
        ...request,
        agentName: scopedConfig.name,
        ...approvalOrigin,
      }),
    };
    if (kind === 'openai-compat') {
      // Coordinator agents (the PM) get delegation tools so they can drive the crew.
      const team = canDelegate(scopedConfig)
        ? orchestrationHost.createCoordinatorTeamTools(scopedConfig, { launchId }, agentCommandPolicy)
        : undefined;
      // In-process agents host MCP via the shared Hub (default-deny: only granted servers).
      const mcp = grants.length > 0 ? { hub: mcpHub, grants: currentMcpGrants } : undefined;
      // Agent robustness: rewrite direct runner calls (e.g. `npx vitest`) into the project's scripts.
      const commandNormalizer = (cmd: string, shell: CommandShellIdentity) => normalizeRunnerCommand(cmd, projectCommandInfo(), shell);
      // Solo mode (v0.3.0): a single agent has no teammates to spread work across. It now shares the
      // same high emergency safety backstop as every other OpenAI-compatible agent.
      const isSolo = scopedConfig.role === 'solo';
      const net = {
        onBeforeEgress: approveModelEgress,
        assertResolvedRoute: routeBoundary,
        connectionResolver: effectiveConnectionRegistry,
        mediaCapabilityCache,
        declaredMediaCapability,
        onBeforeMediaEgress: approveMediaEgress,
        mediaEgressProvider: displayNameForProviderId(scopedConfig.provider.providerId, effectiveConnectionRegistry),
        onRequestBoundary: requestBoundary,
      };
      // A solo agent has no teammates, so the optimistic "read the file before you overwrite it"
      // guard is pure friction (it can't clobber anyone). Skip it for solo; teams keep it.
      // Worktree fan-out: an isolated agent (workingDirectory under .unode/worktrees/) has its own
      // tree, so the optimistic cross-agent guard is pure friction there too — use Noop.
      const isolated = !!scopedConfig.workingDirectory && scopedConfig.workingDirectory.includes(WORKTREES_DIR);
      const coordinator = (isSolo || isolated) ? new NoopFileCoordinator() : fileCoordinator;
      // #13: run the agent's commands in a real VS Code terminal (PTY) so TTY-needing tools (vitest)
      // work and the user sees them; falls back to the declared direct shell where the terminal cannot prove
      // its shell or folder (v0.9.96). Workspace Trust is checked live at execution, so granting trust
      // mid-session takes effect immediately without restarting the agent.
      const commandExecution = trustedExecutionProvider({
        ...terminalManager.executionProviderFor(scopedConfig.id, `Unode: ${scopedConfig.name}`),
        reportUnconfirmedStops: (stops) => reportUnconfirmedBackgroundStops(scopedConfig.name, stops),
      }, () => vscode.workspace.isTrusted);
      // Live thunk so toggling unode.writeApproval applies to running agents without a restart.
      const writeApprovalAsk = () => currentAutonomy().writeReview;
      const memoryWriter = effectiveRoots.restricted
        ? undefined
          : async (agentId: string, note: string, kind: MemoryNoteKind) => {
            if (!vscode.workspace.isTrusted) {
              return 'Error: shared memory is disabled because this workspace is not trusted. The note was NOT saved.';
            }
            const memory = sharedMemory;
            if (!memory) {
              return 'Error: shared memory is unavailable because no workspace is bound. Open a folder and reload the window; the note was NOT saved.';
            }
            // The model supplies only its closed-vocabulary kind. Tier is a host routing fact for this
            // turn, retained privately by SessionManager rather than accepted through tool arguments.
            const tier = sessionManager.currentTurnTier(agentId) ?? configuredRoutingTier(scopedConfig);
            const ok = await memory.append(agentId, note, tier, kind);
            if (!ok) {
              return 'Error: shared memory is unavailable (no workspace folder open, or .unode/memory is not writable). The note was NOT saved.';
            }
            void memory.load();
            return 'Noted to shared team memory.';
          };
      // v0.5.2 Execution Engine: write→feedback diagnostics + verification obligation (each kill-switched).
      const additionalReadRoots = effectiveRoots.readRoots;
      const localScopeReadRoots = configuredLocalReadScopeRoots();
      // Worktree fan-out: in worktree mode, let every agent READ the team's merged work from the
      // integration worktree when a file isn't in its own tree (writes stay isolated). The path is the
      // same for isolated agents (a sibling of their worktree) and the PM (nested under its root).
      const worktreeMode = configuredSetting<string>('concurrencyStrategy', 'optimistic') === 'worktree';
      // v0.9.99: a window without a folder has no integration worktree.
      const integrationRoot = path.join(firstWorkspaceRoot() ?? agentCwd, WORKTREES_DIR, '_integration');
      const verifyCommand = configuredSetting<string>('verifyCommand', '').trim();
      const effectiveVerifyCommand = !vscode.workspace.isTrusted || config.folderAccess?.length
        ? ''
        : resolveVerifyCommand(verifyCommand, projectCommandInfo());
      const gateEnabled = configuredSetting<boolean>('gate.enabled', true);
      const completionGateForTurn = canDelegate(scopedConfig) && !worktreeMode && gateEnabled && !scopedConfig.folderAccess?.length
        ? () => createAgentCompletionGate(scopedConfig, launchId, {
            maxSelfRetries: configuredSetting<number>('gate.maxSelfRetries', DEFAULT_COMPLETION_GATE_CONFIG.maxSelfRetries),
            maxRedelegations: configuredSetting<number>('gate.maxRedelegations', DEFAULT_COMPLETION_GATE_CONFIG.maxRedelegations),
          })
        : undefined;
      const engine: EngineOptions = {
        diagnostics: configuredSetting<boolean>('engine.postWriteDiagnostics', true)
          ? (paths) => collectFileDiagnostics(paths, agentCwd)
          : undefined,
        verifyObligation: configuredSetting<boolean>('engine.verifyObligation', true),
        verificationCommand: effectiveVerifyCommand,
        completionGateForTurn,
        sharedReadRoot: worktreeMode && !!firstWorkspaceRoot() && path.resolve(integrationRoot) !== path.resolve(agentCwd) ? integrationRoot : undefined,
        additionalReadRoots,
        localScopeReadRoots,
        localReadScopeConsent: localReadConsentForAgent,
        livePathAccess,
        fullFileAccess,
        fullFileAccessRevision,
        onFileOutsideRoot: (target, access) => fileOutsideRoot(target, 'refused', access),
        writeRoots: trustedWriteRoots,
        fileGrants: {
          read: effectiveRoots.readFiles,
          write: writeRootsForTrust(effectiveRoots.writeFiles, vscode.workspace.isTrusted),
        },
        isTrusted: () => vscode.workspace.isTrusted, // untrusted workspace → writes/edits/deletes refused
        fileWrites,
        webAccess,
        imageGeneration,
        webSearch: agentSearch,
        transcription,
        nativeOfficeRenderer,
        pdfSignatures,
        workbookRecalcEngine,
        officeRenderPreferences: currentOfficeRenderPreferences,
        officeApplicationCatalog: localApplications,
        officeAuthoring: () => currentOfficeAuthoring(scopedConfig.name),
        documentRenderer,
        presentationRenderer,
        onDocumentWritten: (receipt, requestId) => sessionManager.noteDocumentWritten(requestId, receipt),
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
      return new OpenAICompatBackend(scopedConfig, undefined, team, coordinator, agentCommandPolicy, net, mcp, undefined, approveForAgent, messageBus, commandNormalizer, commandExecution, recordCheckpoint, writeApprovalAsk, approveWriteForAgent, memoryWriter, engine, agentSkillRegistry, executableSkills);
    }
    if (kind === 'codex') {
      const hostSearchTools = new WorkspaceTools(agentCwd, new Set(), scopedConfig.id);
      hostSearchTools.setRequestBoundary(requestBoundary);
      hostSearchTools.setWebSearch({ ...agentSearch,
        nativeOff: () => {
          const active = sessionManager.getBackend(scopedConfig.id);
          return active instanceof CodexBackend && active.nativeSearchIsDisabled();
        },
        cliCanRead: () => {
          const current = sessionManager.get(scopedConfig.id)?.config;
          return !!current && (current.toolCeiling === 'native-default' || !current.allowedTools || current.allowedTools.includes('read'));
        },
      });
      return new CodexBackend(scopedConfig, resolveRouteModelParams(scopedConfig), {
        hostSearchTools,
        transcription,
        disableNativeSearch: () => publicWebPolicy() !== 'allow' || memberSearchOff(scopedConfig.id),
        integrationGrantRevision: persistence.codexIntegrationRevision(scopedConfig.id),
        pythonCache: () => currentPythonCache(scopedConfig.id),
        onPythonCache: (root) => {
          const native = codexNativePolicySnapshots.get(config.id);
          if (native) { native.pythonCache = root; chatViewProvider?.refresh(); }
        },
        onControlFiles,
        permissionProfile: () => currentAutonomy().codexProfile,
        onNativePolicy: (profile, current) => {
          const turnId = sessionManager.currentTurnId(config.id);
          if (turnId) codexNativePolicySnapshots.set(config.id, { turnId, profile, current });
          teamViewProvider?.refresh(); chatViewProvider?.refresh();
        },
        fullFileAccess,
        fullFileAccessRevision,
        // v0.9.97: every App Server start, restarts included, goes through the resolver: the session's pinned program
        // for a start the person did not ask for, managed Codex through its admission, or the external program the
        // person chose, checked by hash at every start.
        launchProgram: (start) => launchCodexProgram({
          resolver: cliRuntimeHost().resolver,
          managedStartFailed: (plan, failure) => { void checkManagedCodexAfterStartFailure(plan, failure, scopedConfig.name); },
        }, scopedConfig.id, start),
        onStartUnanswered: (seconds) => notifyCodexStartUnanswered(scopedConfig.name, seconds),
        skillRegistry: agentSkillRegistry,
        executableSkills,
        teamMcpBridge: canDelegate(scopedConfig) ? new TeamMcpBridge(bridgedTeamTools()) : undefined,
        taskInputResolver,
        // v0.9.103 (CLI teammate messages, C2a): send_message to the task's coordinator, as on the other routes.
        messageBus,
        requestBoundary,
        mcp: grants.length > 0 ? { hub: mcpHub, grants: currentMcpGrants } : undefined,
        // v0.9.97: a handed source reaches Codex in the turn's input, through the reader tools' own grant rule.
        delegationContentAssets,
        delegatedSources: {
          read: (source, attemptId) => readDelegatedSourceInline(delegationContentAssets, taskInputResolver, scopedConfig.id, source, attemptId),
          delivered: (assetIds, attemptId) => noteDelegatedSourcesDelivered(taskInputResolver, scopedConfig.id, attemptId, assetIds),
          // v0.9.99: the rest of a long source or attachment, in pages, under the same grant rule.
          readPage: (assetId, request, attemptId, handed) =>
            readDelegatedSourcePage(delegationContentAssets, taskInputResolver, scopedConfig.id, assetId, attemptId, handed, request),
          // v0.9.99: a long tool result is kept whole for this agent; it reads the rest from the kept copy.
          keepToolResult: (text, attemptId) => keepDelegatedToolResult(delegationContentAssets, scopedConfig.id, text, attemptId),
        },
        clientVersion: unodeVersion || 'dev',
        preflight: async (env, executable) => {
          const stamp = cliProgramStamp(executable);
          const version = await verifyCodexCli(executable, env);
          if (stamp) void recordCliRuntimeCheck({ provider: 'codex-cli', program: executable, version, checkedAt: new Date().toISOString(), stamp });
          return version;
        },
        onBeforeRepositoryConfig: () => repositoryCliLaunchApproval('codex', agentCwd, scopedConfig.name, approvalOrigin),
        // Unlike an API gateway, Codex owns this connection. The dedicated wording states that boundary.
        onBeforeEgress: (executable, onPending) => codexEgressGate(onPending, egressRequester, executable, approvalOrigin),
        assertResolvedRoute: routeBoundary,
        // v0.9.102 (R4a): with the folders this agent may write now through a live Read + Write grant (none when it may
        // not write, or when its own Folder Access caps it); the backend reads it for every turn.
        access: () => codexAccessWithGrants({
          trusted: vscode.workspace.isTrusted,
          restricted: effectiveRoots.restricted,
          readRoots: effectiveRoots.readRoots,
          writeRoots: writeRootsForTrust(effectiveRoots.writeRoots, vscode.workspace.isTrusted),
        }, cliMayWrite ? livePathAccess() : []),
        // v0.9.102 (R4a): exact-file grants are written by the host tools only, never through a sandbox root.
        exactFileWrites: () => codexExactFileWrites(cliMayWrite ? livePathAccess() : []),
        onNativeWriteScope: (scope) => {
          const turnId = sessionManager.currentTurnId(config.id);
          if (turnId) codexTurnWriteScopes.set(config.id, { turnId, scope, told: new Set() });
        },
        // Codex uses its native "Ask for approval" profile. The global Commands/Writes selectors
        // govern UnodeAi-hosted tools and Claude's hook bridge, not routine Codex actions.
        writeApprovalAsk: () => true,
        fileWrites,
        hostFileTools,
        hostReadFile: codexReadCapable(scopedConfig.allowedTools, scopedConfig.toolCeiling),
        onContentReceipt: (receipt) => runLedger.recordContentReceipt({ ...receipt, agentId: scopedConfig.id,
          correlationId: sessionManager.currentTurnCorrelationId(scopedConfig.id) }),
        // v0.9.105 (field smoke F8.3): the host read_file uses the person's live grants and offers Grant access when it
        // refuses, as this agent's other file tools do.
        hostReadAccess: {
          livePathAccess,
          onFileOutsideRoot: (target, access) => fileOutsideRoot(target, 'refused', access),
          // v0.9.105 (audit of b7493e24, F1): the reader's permanent roots are the configured ones; a Read + Write grant
          // folder is in `access` for the native sandbox only, and reaches the reader live, so a revocation ends it.
          configuredReadRoots: () => effectiveRoots.readRoots,
        },
        prepareFileCheckpoint: async (changes) => {
          const writeRoots = writeRootsForTrust(effectiveRoots.writeRoots, vscode.workspace.isTrusted);
          const prepared = prepareCodexFileCheckpoints(agentCwd, writeRoots, changes);
          if (!prepared.ok) return { ok: false, note: prepared.reason };
          try {
            // Each restore point names the file Codex resolves against this agent's folder (v0.9.97).
            const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
            const recorded = codexCheckpointRecords(agentCwd, folders, changes, prepared.entries);
            if (!recorded.ok) return { ok: false, note: recorded.reason };
            for (const record of recorded.records) {
              recordCheckpoint({ agentId: scopedConfig.id, ...record });
            }
            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              note: `UnodeAi could not save a restorable checkpoint: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        },
        // The list belongs to the program that returned it (v0.9.96).
        onModels: (models, cliVersion, program) => (cliVersion ? rememberCodexAccountModels(models, program.executable, cliVersion) : undefined),
        requestApproval: (request) => requestCodexApproval(scopedConfig.name, request, approvalOrigin, {
          // v0.9.102 (R2): "Grant <folder> Read + Write for this session, then run once". The exact folder the card
          // showed, through the same grant owner as Grant access, and only where Grant access itself could be offered.
          grantFolder: async (folder) => {
            const current = sessionManager.get(scopedConfig.id)?.config ?? scopedConfig;
            if (!vscode.workspace.isTrusted || fullFileAccess() || current.folderAccess?.length) return false;
            const requestId = sessionManager.currentRequestId(scopedConfig.id);
            const sameFolder = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
            const grant = await localReadScopeConsent.requestPathAccess(folder, { requestId, isCurrent: () => true },
              async (target) => (target.kind === 'directory' && sameFolder(target.realPath, folder)
                ? { permission: 'readwrite' as const, lifetime: 'session' as const } : undefined));
            if (!grant) return false;
            accessTable.inputsChanged();
            chatViewProvider?.postRuntimeNotice(scopedConfig.id, 'Read + Write file access granted for this session. '
              + 'To revoke it, open UnodeAi: Security from the Command Palette and use revoke under File access grants.');
            return true;
          },
          // v0.9.102 (R2, §15.2): "Allow network for <agent> for this session, then run once", only from the revision the
          // card read: a removal made while the card was open stands.
          allowNetwork: (expected) => {
            const revision = codexSessionNetwork.allowIf(scopedConfig.id, expected);
            if (revision === undefined) return undefined;
            chatViewProvider?.postRuntimeNotice(scopedConfig.id, `Network allowed for ${scopedConfig.name} for this session, `
              + 'from its next turn. To remove it, open UnodeAi: Security from the Command Palette.');
            return revision;
          },
        }),
        // v0.9.102 (R2): network for this agent for this session, as the person chose it on a card (memory only).
        sessionNetwork: () => codexSessionNetwork.get(scopedConfig.id),
        // v0.9.102 (§15.3): a card offers a folder only where Grant access itself could be offered now.
        canOfferFolderGrant: () => vscode.workspace.isTrusted && !fullFileAccess()
          && !(sessionManager.get(scopedConfig.id)?.config ?? scopedConfig).folderAccess?.length,
        // v0.9.102 (R2): what the person's own current request named, for a card's folder option.
        namedTargets: () => {
          const requestId = sessionManager.currentRequestId(scopedConfig.id);
          if (!requestId) return [];
          return accessTable.snapshot(requestId)
            .filter((need) => need.why.includes('named') && need.consumer.agentId === scopedConfig.id)
            .map((need) => need.path);
        },
        onConversationReset: (message) => showResultNotice('warning', `${scopedConfig.name}: ${message}`),
      });
    }
    // Claude receives approved integrations through the same host-owned Hub and filtered loopback proxy as
    // every other route. Secrets never enter the CLI process and users' global Claude config is untouched.
    const mcpConfig = undefined;
    // F1: pass resolved params so buildArgs can map reasoning_effort → --effort at spawn.
    // v0.9.101: the approval entries (command policy, tool, write review, write policy) are not set here. They are
    // composed by createClaudeBackend below from this agent's live Autonomy policy, the code its regression test runs.
    const claudeDeps: ClaudeBackendBaseDeps = {
      officeVisionCapability: model => declaredMediaCapability(model, 'image'),
      onControlFiles,
      // v0.9.90: Claude's in-turn compaction threshold is installed from the agent's policy at process start.
      compactionPolicy: () => {
        const resolution = resolveAgentSmartCompaction(scopedConfig);
        return resolution.status === 'resolved' ? resolution.policy : undefined;
      },
      verifyObligation: configuredSetting<boolean>('engine.verifyObligation', true),
      executionHooks: () => activeExecutionHooks(context).hooks,
      // The fail-closed hook asset ships at <extension>/out/claudeToolGate.cjs. Resolve it from the extension
      // root, NOT from __dirname: a bundled build collapses every module into out/extension.js, so a
      // __dirname-relative guess lands one directory too high and Claude (correctly, fail-closed) refuses to
      // start. Passing the path explicitly makes the packaged and unbundled layouts resolve identically.
      toolGateScriptPath: extensionContext
        ? path.join(extensionContext.extensionUri.fsPath, 'out', 'claudeToolGate.cjs')
        : undefined,
      resolveExecutable: resolveHostProgram,
      // v0.9.96: the Claude program is resolved at each start from unode.claudeCliPath, or as before 0.9.96. Host
      // programs such as taskkill keep resolving through resolveExecutable above. v0.9.97: through the resolver, which
      // checks its files at every start and starts only the session's pinned program when the person did not ask.
      resolveClaudeLaunch: async (start) => {
        const resolved = await cliRuntimeHost().resolver.resolveExternal({
          provider: 'claude-cli', sessionId: scopedConfig.id, pin: start.pin, onPending: start.onPending,
        });
        const launch: ClaudeCliLaunch = {
          executable: resolved.executable,
          shell: resolved.shell,
          route: resolved.shell ? 'npm-cmd' : 'native',
          origin: configuredSetting<string>('claudeCliPath', '').trim() ? 'configured' : 'legacy',
        };
        claudeLaunchByAgent.set(scopedConfig.id, launch);
        return launch;
      },
      // v0.9.99: "Always allow this tool" for this agent's own MCP and newer native tools survives restarts.
      toolAlwaysAllow: agentToolAlwaysAllow?.forAgent(scopedConfig.id),
      fullFileAccess,
      fullFileAccessRevision,
      // Claude applies native edits itself. Its backend derives checkpoints only after a successful
      // tool_result, then uses this same host-owned persistence and rail refresh path as WorkspaceTools.
      recordCheckpoint,
      webAccess,
      publicSearchOff: () => memberSearchOff(scopedConfig.id),
      transcription,
      onBeforeRepositoryConfig: () => repositoryCliLaunchApproval('claude', agentCwd, scopedConfig.name, approvalOrigin),
      // Egress consent: confirm the destination host once before the claude CLI is spawned (nothing sent
      // otherwise). Claude agents reach Anthropic via the user's own `claude` CLI config (api.anthropic.com).
      onBeforeEgress: (onPending) => egressGate('https://api.anthropic.com', onPending, egressRequester, undefined, approvalOrigin),
      assertResolvedRoute: routeBoundary,
      // NOTE: additional read roots are NOT handed to the claude CLI. `--add-dir` grants read+write (subject
      // to permission mode), which would break the "writes stay in the working folder" invariant. Claude
      // agents stay scoped to their cwd; cross-root READ is enforced only via the read-only files MCP bridge.
      additionalReadRoots: vscode.workspace.isTrusted ? effectiveRoots.readRoots : [],
      localScopeReadRoots: configuredLocalReadScopeRoots(),
      localReadScopeConsent: localReadConsentForAgent,
      livePathAccess,
      onOutsideRoot: (target, access) => fileOutsideRoot(target, 'refused', access),
      writeRoots: trustedWriteRoots,
      restrictShell: effectiveRoots.restricted,
      skillRegistry: agentSkillRegistry,
      pythonCache: () => currentPythonCache(scopedConfig.id),
      executableSkills,
      mcp: vscode.workspace.isTrusted && grants.length > 0 ? { hub: mcpHub, grants: currentMcpGrants } : undefined,
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
      // PM also gets the team bridge so a Claude PM can delegate (list_agents/assign_task/…). Its server is the
      // launch's own (the backend's default), so a restarted PM never reaches the team tools of the launch before.
      claudeDeps.teamMcpBridge = new TeamMcpBridge(bridgedTeamTools());
    }
    claudeDeps.requestBoundary = requestBoundary;
    claudeDeps.delegationContentAssets = delegationContentAssets;
    claudeDeps.taskInputResolver = taskInputResolver;
    claudeDeps.hostFileTools = hostFileTools;
    return createClaudeBackend(scopedConfig, mcpConfig, resolveRouteModelParams(scopedConfig), claudeDeps, {
      liveConfig: () => sessionManager.get(config.id)?.config ?? config,
      autonomyPolicy: (live) => agentAutonomyPolicy(live),
      // Command-approval gate: route this Claude agent's shell commands through the CommandPolicy + approval card
      // (named for this agent), as for OpenAI-compatible agents.
      commandPolicy: agentCommandPolicy,
      approveCommand: approveForAgent,
      isTrusted: () => vscode.workspace.isTrusted,
      requestToolApproval: (request) => requestClaudeToolApproval(scopedConfig.name, request, approvalOrigin),
      requestWriteApproval: approveWriteForAgent,
      fileWrites,
    });
  };
  // v0.9.103 (CLI teammate messages, design test 9): the real factory, kept for the Test-mode wiring probe only.
  activationBackendFactory = createBackend;

  // No startup repair, service construction, or warm-up request. Price metadata is reached only after a
  // user action (or later maintenance for hosts that user has already approved).
  context.subscriptions.push(scheduleDailyAutomaticRefresh(
    setInterval,
    () => void refreshPrices({ automatic: true, trigger: 'daily timer' }),
  ));

  // v0.9.89: spend visibility and reminders. Observational only: nothing here gates, delays or stops a turn.
  spendHost = new SpendHost({
    context,
    primaryRoot: firstWorkspaceRoot(),
    log: (message) => outputChannel.info(message),
    resolveRoute: (agentId, modelId) => spendRouteFor(agentId, modelId),
    agentName: (agentId) => sessionManager?.get(agentId)?.config.name,
    stopRequest: (requestId) => sessionManager?.stopRequest(requestId) ?? 0,
    readUserSetting: (key, fallback) => configuredSetting(key, fallback),
    writeUserSetting: async (key, value) => { await updateUserAuthoritySetting(key, value); },
    refreshAccountPrices: (route) => refreshPrices({ scope: route.connectionId, trigger: 'post-turn' }),
    pricingUrl: (provider) => {
      const base = providerEndpoint(provider) ?? (provider === 'roam' ? ROAM_DEFAULT_BASE_URL : UNODE_DEFAULT_BASE_URL);
      try { return new URL('/api/pricing', base).href; } catch { return undefined; }
    },
    metadataFetch,
    ensureMetadataConsent: async (url, requester) => {
      await requestMetadataConsent(planPriceRefresh([{ url }]), { reAsk: true, requester });
      return hasMetadataConsent(hostOf(url));
    },
    postChatNotice: (agentId, noticeKey, text) => chatViewProvider?.postRuntimeNoticeOnce(agentId, noticeKey, text) ?? false,
    refreshViews: () => {
      if (pricing) applyReferencePricesToPicker(pricing);
      teamViewProvider?.refresh();
      scheduleDashboardRefresh();
      SettingsPanel.refreshCurrent();
      // A spend receipt that settles after a run closed updates that run's outcome card in place.
      scheduleJobOutcomeSync();
    },
    openDashboard: async (focusSpend) => {
      dashboardSpendRequested = focusSpend;
      await vscode.commands.executeCommand('unode.showDashboard');
    },
    openSettingsSpend: () => { void vscode.commands.executeCommand('unode.openSettings', 'spend'); },
    workRunning: () => sessionManager?.getAll().some((session) => session.status === 'running' || session.status === 'starting') ?? false,
    requestRunning: (requestId) => sessionManager?.requestRunning(requestId) ?? false,
    premiumCostModel: DEFAULT_MODEL_TIERS.premium.roam,
    rosterAgentCount: () => sessionManager?.getAll().length ?? 0,
  });
  context.subscriptions.push(spendHost, ...spendHost.registerCommands());
  spendHost.start();
  startManagedCodex();
  // A key stored, replaced or cleared in any window invalidates that connection's account prices here too.
  context.subscriptions.push(context.secrets.onDidChange((event) => {
    const owners = effectiveConnectionRegistry.profiles
      .filter((profile) => profile.apiKeySecretName && event.key.endsWith(profile.apiKeySecretName))
      .map((profile) => profile.id);
    if (owners.length > 0) spendHost?.credentialChanged(owners);
    for (const id of owners) imageConnections?.invalidate(id);
    // v0.9.110: a replaced or deleted key ends a reply suggestion of that connection now; a new one uses the new key.
    let suggestionInvalidated = false;
    for (const id of owners) suggestionInvalidated = replySuggestions?.invalidateConnection(id) === true || suggestionInvalidated;
    if (suggestionInvalidated) chatViewProvider?.dismissReplySuggestions();
  }));

  // v0.9.102: kept with the rest of this folder's state, as every other record of its agents is.
  const pmReplies = pmReplyStore(rootWorkspaceState);
  sessionManager = new SessionManager(
    configuredSetting('maxConcurrentAgents', 10),
    messageBus,
    {
      forceStopProcessTree: pid => killProcessTreeByPid(pid, resolveHostProgram),
      showResultNotice: message => { void showResultNotice('warning', message); },
      // v0.9.110 R2 (F1, F5, F6): what a member's next request of the person carries after files were restored, from
      // any entrance; it names only files the member may read when the request is sent.
      recoveryNotices: recoveryNoticePort(() => taskHistory, (agentId, physical) => recoveryNoticeReadable(agentId, physical),
        async () => { await (await taskRecovery())?.settle(); }),
      leaveApprovals: (sessionId) => { approvalBroker.leave(sessionId); },
      logRequestComposition: (line) => outputChannel.info(line),
      // Every restart and removal, from any surface, resets the agent's command lane after its session stopped.
      resetCommandLane: (sessionId) => terminalManager.dispose(sessionId),
      // v0.9.99: without a folder, an agent the host can run without file or command tools still runs (chat).
      workspaceAvailable: (config) => agentRosterEdits.admissionAllowed
        && (!!firstWorkspaceRoot() || (!!config && folderlessChatAllowed(config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry)))),
      rosterChangeAllowed: () => agentRosterEdits.admissionAllowed,
      workspaceUnavailableReason: () => !agentRosterEdits.admissionAllowed
        ? 'The team is being switched or needs recovery. No new agent task was started.'
        : FOLDERLESS_UNAVAILABLE_REASON,
      createBackend,
      resolveEnv,
      prepareBackendStart: prepareManagedIntegrations,
      // Worktree fan-out (v0.6.x): isolate eligible agents in their own worktree. When NOT isolated, root
      // the agent at the CURRENT workspace folder — never a stale per-agent workingDirectory pinned at
      // creation in a different folder (that caused "outside my working folder" on the open project), and
      // never process.cwd() (the extension host's dir). This always wins over the persisted value.
      resolveWorkingDirectory: async (config) => {
        // v0.9.99: without a folder, the agent is rooted in an empty host-owned temporary folder it is not granted.
        if (!firstWorkspaceRoot()) return folderlessChatRoot();
        const worktreeMode = configuredSetting<string>('concurrencyStrategy', 'optimistic') === 'worktree';
        try {
          assertNoFolderAccessWorktreeConflict(config, worktreeMode);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          showResultNotice('error', msg);
          throw err;
        }
        return (await worktreeCoordinator?.assignWorkingDirectory(config)) ?? workspaceRoot();
      },
      onTurnComplete: (agentId, isError, owner) => {
        // Don't drop the merge promise on the floor — a rejection would otherwise surface as an
        // unhandled process-level error. mergeAgent catches internally, but be defensive. (Audit #11.)
        return worktreeCoordinator?.onTurnComplete(agentId, isError, owner)?.catch(
          (e) => outputChannel.warn(`[worktree] merge after turn failed: ${String(e)}`)
        );
      },
      loadSnapshot: (id) => persistence.loadSnapshot(id),
      clearRuntimePin: (id) => persistence.clearRuntimePin(id),
      saveSnapshot: (id, snap) => persistence.saveSnapshot(id, snap),
      clearSnapshot: (id) => persistence.clearSnapshot(id),
      // v0.9.89: one price authority. The spend coordinator prices each turn from a labelled, pinned source
      // and prices the "saved $X" baseline from the same dated reference; there is no hidden table behind it.
      spend: meteredSpendPort(spendHost.coordinator, limitMeter),
      // v0.9.94: a limited request's turn start is asked, and its closeout records what the limits did.
      requestLimits: ceiling,
      resolveRunId: (sessionId, correlationId) => correlationId ? runLedger?.openRunIdForCorrelation(sessionId, correlationId) : undefined,
      resolveTurnRunId: (sessionId, correlationId) => runLedger?.turnRunId(sessionId, correlationId),
      // v0.9.94: a coordinator's top-level turn names its run, read from the ledger when the turn ends.
      requestRunFacts: (sessionId, correlationId) => runLedger?.requestRunFacts(sessionId, { correlationId }),
      requestRunAgents: (runId) => runLedger?.runAgentIds(runId) ?? [],
      verificationSnapshot: readAgentVerificationSnapshot,
      // v0.9.93: a top-level request to the coordinator carries the teammates it can dispatch to, built per turn.
      candidateSnapshot: (config) => orchestrationHost.candidateSnapshot(config),
      // v0.9.99: every coordinator turn starts with its team state, read from the records inspect_task_status reads.
      // The work still owed is selected across every retained record first; only the rendered block is bounded.
      coordinatorTaskStatus: (coordinatorId, keep) => runLedger.inspectTaskStatusWhere(coordinatorId, keep),
      coordinatorStripFacts: (coordinatorId, handles) => runLedger.pmStripFactsOf(coordinatorId, handles),
      // v0.9.103 (slice 3 §4.1): the PM strip's silent-teammate line shows nothing while the person is asked for access the
      // teammate's attempt needs, or for access of that teammate that cannot be matched to an attempt.
      attemptAccessWait: ({ requestId, agentId, handle }) => accessTable.attemptAccessWait(requestId, { agentId, handle }),
      coordinatorDispatchOutcomes: (coordinatorId, from, to, correlationId) =>
        runLedger.dispatchOutcomesBetween(coordinatorId, from, to, correlationId),
      // v0.9.99: the one automatic review turn per returned result revision; v0.9.102: the PM live strip reads it too.
      coordinatorHeld: (coordinatorId) => resultDeliveryHost?.isHeld(coordinatorId) === true,
      // v0.9.102 (the PM live strip): the PM's last final reply, the host's evidence that results were reported.
      pmRepliedAt: (coordinatorId) => pmReplies.get(coordinatorId),
      recordPmReply: (coordinatorId, at) => pmReplies.record(coordinatorId, at),
      recordReviewContinuation: (coordinatorId, ref, state) => {
        const changed = runLedger.recordReviewContinuation(coordinatorId, ref, state);
        // A consumed turn is saved at once, not on the debounce: a reload must not run it again.
        if (changed && state === 'consumed') {
          void persistRunLedger().catch((error) => outputChannel.warn(`[run-ownership] run snapshot save failed: ${String(error)}`));
        }
        return changed;
      },
      consumeReviewContinuationDurably: async (coordinatorId, refs) => {
        const consumed = refs.filter((ref) => runLedger.recordReviewContinuation(coordinatorId, ref, 'consumed'));
        if (!consumed.length) return { consumed, saved: true };
        try {
          await persistRunLedger();
          return { consumed, saved: true };
        } catch (error) {
          outputChannel.warn(`[run-ownership] run snapshot save failed: ${String(error)}`);
          return { consumed, saved: false };
        }
      },
      releaseReviewContinuation: (coordinatorId, ref) => {
        if (runLedger.releaseReviewContinuation(coordinatorId, ref)) {
          void persistRunLedger().catch((error) => outputChannel.warn(`[run-ownership] run snapshot save failed: ${String(error)}`));
        }
      },
      // v0.9.89 field fix: every route is told where its file tools reach. Not a grant.
      readScopeGuidance: (config) => fileReachGuidance(config),
      userRequestStarted: (config, text) => offerNamedOutsidePaths(config, text),
      continuationDecided: (coordinatorId, correlationId) => {
        runLedger.beginContinuation(coordinatorId, correlationId);
        void persistRunLedger().catch((error) => outputChannel.warn(`[run-ownership] run snapshot save failed: ${String(error)}`));
      },
      continuationAbandoned: (coordinatorId, correlationId) => {
        runLedger.abandonContinuation(coordinatorId, correlationId);
        void persistRunLedger().catch((error) => outputChannel.warn(`[run-ownership] run snapshot save failed: ${String(error)}`));
      },
      threadRunOpen: (coordinatorId, correlationId) => runLedger.threadRunOpen(coordinatorId, correlationId),
      // v0.9.101 (H2a): work that waits for access keeps its request owned, and the person's Stop ends it.
      requestAwaitingAccess: (requestId) => taskResumeRefs.hasWaiting(requestId),
      waitingRequestsStopped: (scope) => {
        const ended = 'coordinatorId' in scope
          ? taskResumeRefs.endCoordinator(scope.coordinatorId, 'stopped')
          : (taskResumeRefs.hasWaiting(scope.requestId) ? (taskResumeRefs.endRequest(scope.requestId), [scope.requestId]) : []);
        for (const requestId of ended) {
          accessTable.setLifecycle(requestId, 'closed', 'stopped');
          localReadScopeConsent.endPathAccessRequest(requestId);
        }
      },
      coordinatorGone: (coordinatorId) => endCoordinatorWaits(coordinatorId),
      // v0.9.101 (the access table, R2 §5); v0.9.102: the coordinator whose live strip shows this request's wait.
      waitingStatusShown: (coordinatorId, requestId, turnId) => accessTable.setStatusAnchor(requestId, { agentId: coordinatorId, turnId }),
      replyEndsContinuation: (coordinatorId, correlationId, replyCorrelationId) => runLedger.replyEndsContinuation(coordinatorId, correlationId, replyCorrelationId),

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
      // v0.9.97: a stop ends the stopped turn's attempt before its backend is told to stop.
      endTaskAttempt: (attemptId) => taskInputResolver.endAttempt(attemptId, 'cancelled'),
      onTaskAttemptTerminal: (attemptId) => {
        const observation = taskInputResolver.reviewObservationForAttempt(attemptId);
        if (observation) runLedger.recordReviewObservation(observation);
      },
      // Delegated folder scopes are a per-turn ceiling. The resolver does the path intersection here,
      // at the extension-host authority boundary, before any backend sees the task.
      resolveTaskWorkspaceAccess: (config, msg, requestId) => orchestrationHost.resolveTaskWorkspaceAccess(config, msg.payload.taskScope, requestId),
      // One synchronous snapshot supplies both the prompt and its receipt. A memory_note write or file
      // watcher reload after this point can affect the next turn, never make this turn's receipt diverge.
      getTurnContextBundle: (config, msg, options) => {
        const memorySnapshot = sharedMemory?.promptSnapshot(
          vscode.workspace.isTrusted ? memoryAttestationStore?.attestedDigests() ?? new Set() : new Set()
        ) ?? { block: '', trustCounts: { untrusted: 0, humanAttested: 0 }, selectedDigests: [], omittedCount: 0 };
        const conventions = projectConventions?.get() ?? '';
        const repositoryRules = rulesFile?.getRepositorySummaryContext() ?? '';
        const knowledge = projectKnowledge?.promptBlock() ?? '';
        const projectContext = [
          conventions,
          repositoryRules,
          knowledge,
          memorySnapshot.block,
        ].filter((s) => s.trim()).join('\n\n');
        const suppliedSources = msg.payload.contextManifestSources ?? [];
        // v0.9.97: a route that carries forwarded sources in its input lists each one when it reports it sent.
        const delegatedSources = dispatchDelegatedSources(msg.type, msg.payload.delegationContentSources, options);
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
          textContextSource('project-conventions', 'Project conventions', 'workspace package metadata and layout', conventions, 'fixed project-conventions path'),
          ...(rulesFile?.getRepositorySummarySourcesForManifest() ?? []).map((source) => ({
            kind: 'repository-instruction' as const,
            label: source.relativePath,
            location: source.relativePath,
            text: source.content,
            reason: source.truncated ? 'L1 repository-instruction index; original source had a full-prompt cap' : 'L1 repository-instruction index; full source available on demand through read_file',
          })),
          textContextSource('project-knowledge-index', 'Structured docs index', 'docs/', knowledge, 'L1 project-knowledge index; full documents available on demand through read_file'),
          memorySnapshot.block.trim() ? {
            kind: 'shared-memory' as const,
            label: 'Shared team memory',
            location: '.unode/memory/notes.md',
            text: memorySnapshot.block,
            reason: 'physically confined primary-workspace memory; selected rows are untrusted or exact-row locally attested',
            memoryTrustCounts: memorySnapshot.trustCounts,
          } : undefined,
          textContextSource('skill-summary', 'Authorized skill summaries', 'extension-owned SKILL.md registry', skillPrompt, 'skill grant'),
        ];
        return {
          projectContext,
          contextManifest: createTurnContextManifest(sources.map(enrichContextManifestSource)),
        };
      },
      getWorkspaceContext: async (runtimeRoot?: string) => {
        // v0.9.99: a chat without a folder has no working folder to describe.
        if (!firstWorkspaceRoot()) return undefined;
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
          const localRoots = configuredLocalReadScopeRoots();
          if (localRoots.length > 0) {
            parts.push(
              '--- Local project discovery ---\nA host-owned read-only discovery scope can reach sibling projects. '
              + 'On the first access, UnodeAi shows the user the resolved absolute root and asks whether agents may read and search it; a denial blocks the access. '
              + 'Use a relative sibling path when one is already evidenced in workspace text. This does not grant writes or shell access there. '
              + 'Use inspect_git_tag to prove a local Git tag; do not use run_command for Git metadata.'
            );
          }
          // Richer per-turn orientation (diagnostics + active editor file) stays opt-in via the flag.
          if (configuredSetting<boolean>('engine.workspaceContext', false)) {
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
              if (isPathStrictlyInside(root, abs)) {
                parts.push(`Active file: ${path.relative(root, abs).split(path.sep).join('/')}`);
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
      compaction: compactionCoordinator,
      connectionResolver: () => effectiveConnectionRegistry,
    }
  );
  // v0.9.103 (audit I1): a teammate's turn with no attempt card (a rework) still names its coordinator and handle.
  taskInputResolver.setTurnThreadSource((agentId) => sessionManager.taskThreadOf(agentId));
  // v0.9.99: a removed agent's request holds nothing any more; what it held is reclaimed after the idle period.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (affectsTerminalProfile(event)) {
      // A terminal profile that failed for an agent is tried again under the new settings.
      terminalManager.profileSettingsChanged();
    }
    if (event.affectsConfiguration('unode.verifyCommand')) SettingsPanel.refreshTeamCurrent();
    if (event.affectsConfiguration('unode.maxConcurrentAgents')) {
      sessionManager.setMaxConcurrent(configuredSetting('maxConcurrentAgents', 10));
    }
    if (event.affectsConfiguration('unode.chatParticipant.enabled')) {
      syncUnodeChatParticipant();
    }
    if (event.affectsConfiguration('unode.attentionSound')) {
      chatViewProvider?.refresh();
    }
    if (event.affectsConfiguration('unode.spend')) {
      // Picker labels follow the selected dated reference; spend views follow targets and the mode.
      if (pricing) applyReferencePricesToPicker(pricing);
      teamViewProvider?.refresh();
      scheduleDashboardRefresh();
      SettingsPanel.refreshCurrent();
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
      // The roster row shows the inherited reasoning effort, so it follows the default as the other two do.
      teamViewProvider?.refresh();
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
      reloadCommandPolicy();
      outputChannel.info(`[policy] reloaded: commandApproval=${configuredSetting('commandApproval', 'all')}, allowedCommands=${commandPolicy.allowedCommands.length}, projectApprovals=${commandPolicy.projectApprovals.length}`);
    }
    refreshAutonomyOnConfigurationChange(event);
  }));

  // F4/B1: reload compatible repository instructions when they change so new turns pick up edits.
  // Policy consumers already re-read strictly before execution. This watcher refreshes only the visible
  // Team projection; it must not publish a second policy cache or overwrite edits in Model Tuning.
  const teamConfigurationWatcher = vscode.workspace.createFileSystemWatcher('**/.unode/team.json');
  const refreshTeamConfiguration = () => {
    // v0.9.101: Folder Access and every other reach input of the roster may have changed, here or outside UnodeAi.
    accessInputsChanged();
    // The queued read cannot refresh a projection from the middle of a replacement publication.
    void persistence.loadTeamConfig({ strict: true }).then(() => {
      if (!workspaceBinding.isStale() && agentRosterEdits.admissionAllowed) SettingsPanel.refreshTeamCurrent();
    }).catch(() => { if (agentRosterEdits.admissionAllowed) SettingsPanel.refreshTeamCurrent(); });
  };
  teamConfigurationWatcher.onDidChange(refreshTeamConfiguration);
  teamConfigurationWatcher.onDidCreate(refreshTeamConfiguration);
  teamConfigurationWatcher.onDidDelete(refreshTeamConfiguration);
  context.subscriptions.push(teamConfigurationWatcher);
  const rulesWatcher = vscode.workspace.createFileSystemWatcher('**/{AGENTS.md,CLAUDE.md,.unode/rules.md}');
  const reloadRules = () => {
    void rulesFile?.load().then(() => outputChannel.info('Reloaded repository instruction context.'));
  };
  rulesWatcher.onDidChange(reloadRules);
  rulesWatcher.onDidCreate(reloadRules);
  rulesWatcher.onDidDelete(reloadRules);
  context.subscriptions.push(rulesWatcher);

  // P1: the L1 docs index is a live view just like repository instructions. The actual document bodies are
  // not read into every turn; a change only refreshes the compact index for subsequent turns.
  const projectKnowledgeWatcher = vscode.workspace.createFileSystemWatcher('**/docs/**/*.{md,mdx}');
  const reloadProjectKnowledge = () => {
    void projectKnowledge?.load().then(() => outputChannel.info('Reloaded progressive project-knowledge index.'));
  };
  projectKnowledgeWatcher.onDidChange(reloadProjectKnowledge);
  projectKnowledgeWatcher.onDidCreate(reloadProjectKnowledge);
  projectKnowledgeWatcher.onDidDelete(reloadProjectKnowledge);
  context.subscriptions.push(projectKnowledgeWatcher);

  const memoryWatcher = vscode.workspace.createFileSystemWatcher('**/.unode/memory/notes.md');
  const reloadMemory = () => {
    void sharedMemory?.load().then(() => outputChannel.info('Reloaded .unode/memory/notes.md shared memory.'));
  };
  memoryWatcher.onDidChange(reloadMemory);
  memoryWatcher.onDidCreate(reloadMemory);
  memoryWatcher.onDidDelete(reloadMemory);
  context.subscriptions.push(memoryWatcher);

  // A1: re-detect project conventions when the root package.json changes (scripts added/renamed).
  const pkgWatcher = vscode.workspace.createFileSystemWatcher('**/package.json');
  const reloadConventions = () => { void projectConventions?.load(); };
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
    { tierController, workspaceRoot, runChecks: runWorkflowVerification,
      notifyUser: notifyUnverifiedWorkflowGate },
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

  orchestrationProgress = new OrchestrationProgressTracker(resolveDelegationAgentName, (message) => {
    // The run an assignment belongs to, from the same turn thread the ledger opens runs with (F7-20).
    const correlation = sessionManager.currentTurnCorrelationId(message.from);
    return correlation ? runLedger.runPresentationKeyForCorrelation(message.from, correlation) ?? correlation : undefined;
  });
  orchestrationProgress.hydrate(runLedger.snapshot());
  // A run closed while its card is on screen shows its closeout at once, not only after a reload.
  // v0.9.89 field fix: an interrupted delegation gets one host line at the end of its coordinator's Chat,
  // keyed by its handle, so a reload or a state push never repeats it. Never model context; Stop is excluded.
  const postInterruptionNotices = (): void => {
    for (const interruption of runLedger.unresolvedInterruptions()) {
      const name = sessionManager?.get(interruption.agentId)?.config.name ?? interruption.requestedAgent;
      // v0.9.103 (F1): a stop UnodeAi made is said as that. It is an interruption, never the person's cancellation.
      const reason = interruption.reason === 'host-restarted'
        ? 'the editor window restarted while it was running'
        : interruption.reason === 'host-stopped'
          ? 'its session was stopped by UnodeAi (a restart, a settings change, closing the window, or its process ending) while it was running'
          : 'its session stopped before it reported a result';
      chatViewProvider?.postRuntimeNoticeOnce(
        interruption.coordinatorId,
        `interruption:${interruption.handle}`,
        `UnodeAi: ${name}'s task was interrupted: ${reason}. To go on, ask the PM in this chat to run the task again, or to record it as abandoned.`,
      );
    }
  };
  runLedger.onDidChange(postInterruptionNotices);
  // v0.9.102 (the PM live strip, the Owner's decision): what each PM's team is doing now, above the message box. It is
  // read again when a task record, a session, Stop, the access table or a receipt changes; it starts, schedules and
  // records nothing.
  pmLive = connectPmLive({ sessionManager, accessTable, runLedger, publish: (strips) => chatViewProvider?.setPmLive(strips) });
  context.subscriptions.push({ dispose: () => pmLive?.dispose() });
  setTimeout(postInterruptionNotices, 0);
  runLedger.onDidChange(() => {
    if (orchestrationProgress.applyRunCloseouts(runLedger.closedRunCloseouts())) publishDelegationProgress();
  });
  // v0.9.93: Job outcome cards. Every closed run that has a closing turn has one anchor, computed from the run.
  // Chat keeps the anchor and shows the projection of the run's stored facts, so a repeated close, a late
  // receipt and a restored ledger all end in the same one card.
  runLedger.onDidChange(scheduleJobOutcomeSync);
  context.subscriptions.push({ dispose: () => {
    if (jobOutcomeSyncTimer) clearTimeout(jobOutcomeSyncTimer);
    jobOutcomeSyncTimer = undefined;
  } });

  wireEvents();

  runOwnerHeartbeatTimer = setInterval(() => { void maintainRunOwnership(); }, RUN_OWNER_HEARTBEAT_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => {
    if (runOwnerHeartbeatTimer) clearInterval(runOwnerHeartbeatTimer);
    runOwnerHeartbeatTimer = undefined;
  } });

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
      const global = commandNarrowingCeiling(commandPolicy).allowedCommands;
      const selected = narrowing.allowedCommands.filter((entry) => global.includes(entry.trim().toLowerCase()));
      return `Commands: narrowed (${selected.length} of ${global.length})`;
    },
    // v0.9.100 (the Owner): Autonomy, including native Codex Full access, is shown only in the chat input's menu.
    () => undefined,
    () => spendHost?.teamSummary(),
    // v0.9.93: the reasoning-effort baseline of the roster row, from the authorities Agent Builder and the
    // runtime filter already use. An agent whose connection is unknown shows none.
    (config) => {
      const profile = connectionProfileForAgent(config, effectiveConnectionRegistry);
      return profile
        ? reasoningEffortBaseline(config, modelParamDefaultLabels(makeConfigStore()), profile.capabilities.modelParams.has('reasoning_effort'))
        : undefined;
    },
    firstWorkspaceRoot() ? rootWorkspaceState : undefined,
  );
  // v0.9.97: a running task that delivers in batches says on its row what it saved; a save, or a batch falling due
  // by time, redraws the row.
  teamViewProvider.setWorkProductStatus((agentId) => {
    const progress = sessionManager.checkpointProgressFor(agentId);
    return progress ? workProductLabel(progress, taskInputResolver.checkpointSummary(progress.attemptId)) : undefined;
  });
  sessionManager.on('session.workProduct', () => { teamViewProvider?.refresh(); });
  for (const event of ['session.turnEnded', 'session.stopped', 'session.removed'] as const) {
    sessionManager.on(event, ({ sessionId }) => {
      codexNativePolicySnapshots.delete(sessionId);
      codexTurnWriteScopes.delete(sessionId);
      codexAutonomyPendingTurns.delete(sessionId);
      // v0.9.108: a finished turn forgets saved generated images' records that nothing holds any more.
      imageGeneration?.endTurn();
      if (event === 'session.removed') {
        agentAutonomyGenerations.delete(sessionId);
        agentAutonomyDecisionGenerations.delete(sessionId);
      }
    });
  }
  messageLogProvider = new MessageLogProvider(messageBus, resolveAgentName, sessionPresentation);
  // Waiting on a person is reported from the broker, which knows a prompt is really open, on every route.
  context.subscriptions.push({
    dispose: approvalBroker.subscribe({ onWaitChange: (sessionId, waiting) => sessionManager.noteApprovalWait(sessionId, waiting) }),
  });
  context.subscriptions.push({ dispose: () => approvalBroker.disposeAll() });
  // v0.9.94: one list of request closeout records per agent, in workspace state. A change is shown through the
  // same debounced refresh the Job outcome cards use.
  requestCloseoutStore = new RequestCloseoutStore(rootWorkspaceState, {
    onDiagnostic: (message) => outputChannel.warn(`[request-closeout] ${message}`),
    retainedTurnIds: (agentId) => chatViewProvider?.retainedTurnIds(agentId) ?? new Set<string>(),
  });
  requestCloseoutStore.onDidChange(() => scheduleJobOutcomeSync());
  chatDraftMirror = new ChatDraftMirror({
    get: <T>(key: string) => rootWorkspaceState.get<T>(key),
    update: (key, value) => rootWorkspaceState.update(key, value),
    // No bound root, or an invalidated one: nothing is read or written, and the Workbench says it has no copy.
    available: () => firstWorkspaceRoot() !== undefined,
  });
  // v0.9.110 (H0): every change of a conversation is recorded in this workspace's task history; the chat key stays the
  // 50-message window that 0.9.109 also reads.
  const historyStorage = context.globalStorageUri?.fsPath;
  taskHistory = new HistoryService({
    open: () => openTaskHistory(historyStorage),
    state: rootWorkspaceState,
    onNotSaved: (agentId) => chatViewProvider?.postRuntimeNotice(agentId,
      "This task's history was not saved. The conversation stays here, but Task history may not list it."),
    log: (line) => outputChannel.warn(`[history] ${line}`),
    // v0.9.110 H1: deleting a task's restore points removes their bytes; one still in use stays and is reported kept.
    restorePoints: {
      remove: (ids) => removeHistoryRestorePoints(ids),
      all: () => workspaceRestorePoints(),
      protect: (ids) => holdFavouriteRestorePoints(ids),
      releaseOperations: (operationIds) => releaseRecoveryOperationHolds(operationIds),
      releaseRecoveryHolds: (ids, finished) => releaseRecoveryHoldsOn(ids, finished),
      deleteLocalCopies: () => deleteLocalCopiesOfWork(),
      available: async (ids) => {
        const opened = await preChangeCheckpoints?.store();
        return new Set(opened && !('unavailable' in opened) ? ids.filter((id) => opened.store.get(id)) : []);
      },
    },
    onMessagesDeleted: (agentId, messageIds, digests) => chatViewProvider?.removeHistoryMessages(agentId, messageIds, digests),
    onStorageFull: () => {
      void vscode.window.showInformationMessage(
        'Task history is full of favourite or running tasks, so older ones could not make room. Open Task history, then Manage storage, to free some.',
        'Open Task history',
      ).then((choice) => { if (choice) openTaskHistoryPanel(); });
    },
  });
  // v0.9.110 H1: housekeeping (30 days, 1,000 ended tasks, 16 MiB) a minute after activation, then after outcomes.
  const housekeepLater = setTimeout(() => { void taskHistory?.housekeep(true); }, 60_000);
  (housekeepLater as { unref?: () => void }).unref?.();
  context.subscriptions.push({ dispose: () => clearTimeout(housekeepLater) });
  context.subscriptions.push(
    { dispose: () => { void taskHistory?.store().then((store) => store?.dispose()); } },
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) taskHistory?.reconcileAll(sessionManager.getAll().map((session) => session.config.id));
    }),
  );
  sessionManager.on('session.requestAdmitted', (e) => {
    if (e.data?.historyId) taskHistory?.requestAdmitted(e.sessionId, e.data.historyId, e.data.requestId);
  });
  chatViewProvider = new ChatViewProvider(context.extensionUri, {
    history: taskHistory,
    // v0.9.110 H1: the Workbench's Task history view; its host side resolves every id the page sends.
    taskHistory: { handle: (message) => { void taskHistoryHost()?.handle(message).catch(() => undefined); } },
    // v0.9.110: Revert to here on a request, Revert to before this request on its result, Not verified after restore.
    recoveryMarks: {
      revertStart: (ref) => taskHistory?.openedStore?.revertStart(ref),
      lastRestoreAt: () => taskHistory?.openedStore?.lastRestoreAt(),
    },
    revertToRequest: (agentId, historyId) => { void revertToRequestCommand({ agentId, historyId }).catch((error: Error) => showResultNotice('warning', `Not reverted: ${error.message}`)); },
    approvalBroker,
    attentionSoundEnabled: attentionSoundSetting,
    onAttentionResult: (result) => {
      attentionResultWaiters.get(result.id)?.(result);
      attentionSignal?.noteResult(result);
    },
    listAgents: () => sessionManager.getAll().map((s) => {
      const kind = s.config.backend ?? defaultBackendKind(s.config, effectiveConnectionRegistry);
      const codexPermission = kind === 'codex' ? codexPermissionForAgent(s.config) : undefined;
      return {
      id: s.config.id,
      name: s.config.name,
      role: s.config.role,
      icon: s.config.icon,
      backend: kind,
      codexPermissionProfile: codexPermission?.effective,
      codexPermissionCapReason: codexPermission?.capReason,
      autonomyMenu: autonomyMenuForAgent(s.config, kind),
      effectivePolicy: effectivePolicyForAgent(s.config),
      status: s.status,
      // v0.9.103 §3.8: a route that steers only once its process confirms it (Claude) promises it only then.
      canSteer: agentCanSteer(connectionProfileForAgent(s.config, effectiveConnectionRegistry)?.capabilities, s.steerConfirmed),
      currentTask: s.currentTask,
      routeLabel: connectionProfileForAgent(s.config, effectiveConnectionRegistry)?.presentation.displayName,
      model: s.config.model,
      ...(s.observedModel ? { observedModel: s.observedModel } : {}),
      costUsd: s.usage?.costUsd,
      turns: s.usage?.turns,
      ...(s.usage?.costBasis ? { costBasis: s.usage.costBasis } : {}),
      ...(s.usage?.partial ? { costPartial: true } : {}),
      ...(s.usage?.unknownTurns ? { unknownTurns: s.usage.unknownTurns } : {}),
      consentMessage: s.consentMessage,
      };
    }),
    onSendRejected: ({ clause, requestedAgentId, selectedAgentId, requestId }) => {
      outputChannel.warn(
        `[chat] composer send rejected: clause=${clause}; requestedAgentId=${requestedAgentId || '(empty)'}; ` +
        `selectedAgentId=${selectedAgentId || '(empty)'}; requestId=${requestId ?? '(legacy)'}`,
      );
    },
    onClockReport: (view) => clockReporter.report(view),
    onRenderedTranscriptDisappearance: (event) => {
      outputChannel.warn(
        `[chat] ${event.classification}: received full state omitted a rendered transcript item; surface=${event.source}; agent=${event.agentId}; ` +
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
    jobOutcomeView: (runId, anchor) => {
      try {
        return currentJobOutcomeView(runId, anchor);
      } catch (error) {
        // The card is left out; the conversation is unaffected. The reason goes to the log, once per failure.
        outputChannel.warn(`[job-outcome] run ${runId}: the outcome could not be projected: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    },
    onJobOutcomeAction: (event) => { void guard(() => runJobOutcomeAction(event)); },
    // v0.9.105: the held, frozen records, not a copy of each on every render.
    requestCloseouts: (agentId) => requestCloseoutStore?.view(agentId) ?? [],
    requestSummaryView: (record) => {
      try {
        return currentRequestSummaryView(record);
      } catch (error) {
        // The card is left out; the conversation is unaffected.
        outputChannel.warn(`[request-closeout] turn ${record.terminalTurnId}: the summary could not be projected: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    },
    clearRequestCloseouts: (agentId) => requestCloseoutStore?.clear(agentId),
    // v0.9.99: clearing the conversation also ends a message of it still being prepared; a turn already running stays.
    retirePreparing: (agentId) => userRequestPreparations.cancel(agentId) > 0 && sessionManager.get(agentId)?.status !== 'running',
    forgetFileAccessNotices: (agentId) => sessionManager.forgetFileAccessNotices(agentId),
    delegationWaitingResults: (agentId) => sessionManager.pendingAsyncDelegationWakeCount(agentId),
    // v0.9.99: a Send waiting in the composer for its files is a message being prepared from its click.
    beginPreparation: (agentId) => userRequestPreparations.begin(agentId),
    send: async (agentId, text, mode, userAttachments, turnEpoch, history) => {
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
      // v0.9.99: the preparation has its own cancellation. Stop, removing the agent or clearing its conversation ends it,
      // and a message whose preparation was cancelled is never submitted, however late a read finishes.
      await prepareAndSubmit(userRequestPreparations, agentId, {
        prepare: async (stopped) => {
          const root = workspaceRoot();
          const expanded = await expandContextMentions(text, root, {
            readFile: (p) => fs.readFile(p, 'utf8'),
            stat: (p) => fs.stat(p),
            readDir: (p) => fs.readdir(p, { withFileTypes: true }),
            diagnostics: () => diagnosticsSnapshot(root),
            fetchText: (url) => fetchMentionUrl(url, stopped),
          });
          const sources = await userTurnSources(delegationContentAssets, {
            text,
            expanded,
            mentions: parseMentions(text),
            userAttachments,
          });
          return { expanded, ...sources };
        },
        submit: ({ expanded, contextManifestSources, delegationContentSources }) => {
          // v0.9.99: this request holds what the person sent with it, however long it runs; their next request to this
          // agent takes over, and what this one held is then kept for the idle period unless a task still holds it.
          delegationContentAssets.holdForUserRequest(agentId, delegationContentSources.map((source) => source.assetId));
          // Route as a turn; routeInbound lazy-starts a stopped agent for ask.question. v0.9.110 R2: recovery notices are
          // attached by the session manager for every entrance of the person's requests, not here.
          userRequests.submit(agentId, 'ask.question', {
            instruction: expanded,
            mode,
            userAttachments,
            contextManifestSources,
            delegationContentSources,
            metadata: { turnEpoch, ...(history ? { historyId: history.historyId } : {}) },
          });
        },
      });
    },
    interject: (agentId, text) => {
      localReadScopeConsent.beginUserRequest();
      return sessionManager.interjectAgent(agentId, text);
    },
    interrupt: (agentId) => {
      // v0.9.99: Stop also ends a message still being prepared; it is not sent, and the chat says so.
      stopPreparingMessages([agentId]);
      sessionManager.interrupt(agentId);
    },
    contextMeter: (agentId) => sessionManager.contextMeter(agentId),
    // Report what happened, not what was attempted. Claiming "compacted" while dropping nothing is worse
    // than refusing: the user stops looking for the real problem, which on a rejected turn is usually that
    // the configured context window is larger than the model's real one. Both surfaces derive their
    // sentence from the same outcome, so they cannot contradict each other about one agent.
    compactContext: async (agentId) => {
      const outcome = await sessionManager.compactSession(agentId);
      // A compaction that applied is shown by its receipt; everything else is explained here.
      if (!outcome.compacted) chatViewProvider?.postNotice(agentId, compactOutcomeMessage(outcome));
    },
    onSelectAgent: () => {
      syncSoloContext();
    },
    // Subscribe to ALL completions, not just those addressed to 'user': when the PM delegates to a
    // teammate, the teammate's task.complete is addressed to the PM, so a {to:'user'} filter would
    // never fire for it — leaving that agent's chat stuck on "Stop" and its reply unfinalized. We key
    // by `from` and the handler scopes each completion to that agent's own chat tab.
    onReply: (cb) =>
      messageBus.subscribe({}, (msg) => {
        // v0.9.103 slice 2 (G3): a teammate's turn that ended waiting for its coordinator's answer ends in its chat with its
        // reply, kept as a progress note on the task; its task goes on.
        const waitingNote = msg.type === 'task.status' && !!(msg.payload.metadata as { taskWaiting?: unknown } | undefined)?.taskWaiting;
        if (msg.type === 'task.complete' || msg.type === 'task.partial' || msg.type === 'system.error' || waitingNote) {
          const metadata = msg.payload.metadata as { turnId?: unknown; delegationReceipt?: unknown; turnTrigger?: unknown; verbatim?: unknown; responseOutcome?: unknown; turnOutcome?: unknown; interruption?: unknown } | undefined;
          const delegationReceipt = parseDelegationCounts(metadata?.delegationReceipt);
          const verbatim = parseChatVerbatim(metadata?.verbatim);
          const responseOutcome = parseResponseOutcome(metadata?.responseOutcome);
          const turnOutcome = parseTurnOutcomeReceipt(metadata?.turnOutcome);
          // Names are resolved when the reply arrives and kept with it, so a reload still says who woke the PM.
          const trigger = metadata?.turnTrigger as { sources?: Array<{ agentId?: unknown }> } | undefined;
          const turnTrigger = parseChatTurnTrigger(trigger && Array.isArray(trigger.sources)
            ? { ...trigger, sources: trigger.sources.map((source) => ({ ...source, agentName: resolveAgentName(String(source?.agentId ?? '')) })) }
            : undefined);
          const replyText = String(msg.payload.instruction ?? '');
          const replyIsError = msg.type === 'system.error' || !!(msg.payload.metadata as { isError?: boolean } | undefined)?.isError;
          // v0.9.110: read as the reply is published, before a later turn of the agent can replace it.
          const finishedRequestId = msg.type === 'task.complete' ? sessionManager.finishedTurnRequest(msg.from) : undefined;
          const runtimeNotice = replyIsError ? cliRuntimeFailureNotice(msg.from, replyText, msg.id) : undefined;
          deliverReply(() => cb({
            from: msg.from,
            fromName: resolveAgentName(msg.from),
            text: replyText,
            isError: replyIsError,
            ...(replyIsError && parseTurnInterruption(metadata?.interruption) ? { interruption: parseTurnInterruption(metadata?.interruption) } : {}),
            ...(runtimeNotice ? { runtimeNotice } : {}),
            ...(msg.type === 'task.partial' || waitingNote
              ? { completionState: 'partial' as const }
              : msg.type === 'task.complete'
                ? { completionState: 'complete' as const }
                : msg.type === 'system.error'
                  ? { completionState: 'not-observed' as const }
                  : {}),
            epoch: normalizeEpoch((msg.payload.metadata as { turnEpoch?: unknown } | undefined)?.turnEpoch),
            timing: (msg.payload.metadata as { turnTiming?: import('./session/TurnTiming').TurnTiming } | undefined)?.turnTiming,
            ...(typeof metadata?.turnId === 'string' ? { turnId: metadata.turnId } : {}),
            ...(delegationReceipt ? { delegationReceipt } : {}),
            ...(turnTrigger ? { turnTrigger } : {}),
            ...(verbatim ? { verbatim } : {}),
            ...(responseOutcome?.kind === 'empty-reply'
              ? { emptyReply: { noticeKey: `empty-reply:${msg.id}`, text: emptyReplyNotice(responseOutcome.attempts) } }
              : {}),
            ...(turnOutcome ? { turnOutcome } : {}),
            ...(finishedRequestId ? { requestId: finishedRequestId } : {}),
          }), msg.type === 'task.complete' || msg.type === 'task.partial');
        }
      }),
    draftMirror: chatDraftMirror,
    // v0.9.110: one suggestion after an answer, when a reply suggestion model is set; None offers nothing.
    ...(replySuggestions ? { replySuggestions: {
      enabled: () => replySuggestions?.enabled() === true,
      settingsRevision: () => replySuggestionSettingsRevision,
      workspaceId: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()).sort().join('|'),
      pinBudget: (requestId) => replySuggestions!.pinBudget(requestId),
      suggest: (request) => replySuggestions!.suggest(request),
    } } : {}),
    shuttingDown: () => hostShutdown.started,
    // The roster is restored below, after the views are registered and VS Code may already have restored them.
    waitForRoster: true,
    state: rootWorkspaceState,
    getApprovals: () => {
      return { command: configuredSetting<string>('commandApproval', 'all'), write: configuredSetting<string>('writeApproval', 'none') };
    },
    setAutonomy: setAgentAutonomy,
    onModeChange: () => { teamViewProvider?.refresh(); },
    setApproval: async (kind, value) => {
      const key = kind === 'write' ? 'writeApproval' : 'commandApproval';
      await updateUserAuthoritySetting(key, value);
      if (kind === 'command') {
        reloadCommandPolicy();
      }
    },
    setCodexPermissionProfile: async (agentId, profile) => {
      const session = sessionManager.get(agentId);
      const kind = session?.config.backend ?? (session ? defaultBackendKind(session.config, effectiveConnectionRegistry) : undefined);
      if (!session || kind !== 'codex') return;
      await setAgentAutonomy(agentId, profile === 'full-access' ? 'full-access' : profile === 'ask-for-approval' ? 'review' : 'workspace');
    },
    presentation: sessionPresentation,
    onWorkbenchOpenChange: (open) => {
      void vscode.commands.executeCommand('setContext', 'unode.workbenchOpen', open);
    },
    approverIdentity: localApproverIdentity,
    getCheckpoints: () => checkpointStore.list(),
    openWorkspaceFile: (agentId, filePath, stillShown, action) => orchestrationHost.openRecordedWorkspaceFile(agentId, filePath, stillShown, action),
    openFileReference: (agentId, reference, action) => orchestrationHost.openFileReference(agentId, reference, action),
    fileNavigationRefused: (reason, report) => orchestrationHost.refuseFileNavigation(reason, report),
    fileLinkRoots: (agentId) => orchestrationHost.fileLinkRoots(agentId, sessionManager.get(agentId)?.runtimeWorkingDirectory),
    fileLinkCeilings: (agentId) => orchestrationHost.fileLinkCeilings(agentId),
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
    firstUse: {
      view: () => firstUseController?.view(),
      draft: (text) => { void firstUseController?.draft(text); },
      action: (action, revision) => { void guard(async () => { await firstUseController?.action(action, revision); }); },
      handoverResult: (revision, applied) => { void firstUseController?.handoverResult(revision, applied); },
    },
  });
  firstUseController = new FirstUseController(firstUseDeps());
  // One sound when a prompt starts waiting on the user (v0.9.88 §5.11), played by one visible chat view.
  attentionSignal = new AttentionSignal({
    enabled: attentionSoundSetting,
    play: (attentionId) => chatViewProvider.playAttention(attentionId),
    log: (message) => outputChannel.warn(message),
  });
  installAttentionSignal(attentionSignal);
  context.subscriptions.push({
    dispose: () => {
      attentionSignal?.dispose();
      installAttentionSignal(undefined);
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
  // v0.9.94: the Team panel is drawn again too. Its row of an agent says `Decision needed` or `Approval needed`
  // from the approval that is pending for that agent, and nothing else redraws it while the agent's status stays
  // what it was: in the field a limit card had been open for three minutes and the row still said `Working`.
  context.subscriptions.push(chatViewProvider.onApprovalEvent(() => {
    updateStatusBar();
    teamViewProvider?.refresh();
  }));
  dashboardProvider = new DashboardProvider(context.extensionUri, sessionManager, messageBus, {
    agentStates: () => orchestrationProgress.agentStates(),
    filesByAgent: dashboardFilesByAgent,
    worktreeReview: async () =>
      configuredSetting<string>('concurrencyStrategy', 'optimistic') === 'worktree'
        ? gatherWorktreeReview()
        : undefined,
    recentTaskCount: () => context.globalState.get<number>('roam.dashboard.recentTaskCount', 5),
    concurrencyMode: () => configuredSetting<string>('concurrencyStrategy', 'optimistic'),
    spendView: () => spendHost?.viewModel(),
    focusSpend: () => dashboardFocusSpend,
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
  }, () => hostShutdown.started || workspaceBinding.isStale());
  // The cards of runs that closed before this window loaded: same anchors, so the same one card each.
  scheduleJobOutcomeSync();
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
        userRequests.submit(agentId, 'ask.question', { instruction: prompt, mode: 'act' });
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

  // Restore persisted state (P1#4/#5): first carry legacy MCP approvals/configuration into the
  // host-owned UnodeAi keys, then hydrate approvals, messages, and the roster.
  const legacyMcpMigration = await persistence.migrateLegacyMcpState();
  if (legacyMcpMigration.importedApprovedIds.length > 0 || legacyMcpMigration.ignoredUnapprovedIds.length > 0) {
    const imported = legacyMcpMigration.importedApprovedIds.length > 0
      ? `Imported already-approved integrations: ${legacyMcpMigration.importedApprovedIds.join(', ')}. `
      : '';
    const ignored = legacyMcpMigration.ignoredUnapprovedIds.length > 0
      ? `Ignored unapproved project integrations: ${legacyMcpMigration.ignoredUnapprovedIds.join(', ')}.`
      : '';
    const migrationNotice = `UnodeAi upgraded legacy MCP configuration. ${imported}${ignored}`.trim();
    if (legacyMcpMigration.ignoredUnapprovedIds.length > 0) {
      void showResultNotice('warning', migrationNotice);
    } else {
      void showResultNotice('information', migrationNotice);
    }
  }
  for (const id of persistence.loadApprovedMcpServers()) {
    approvedMcp.add(id);
  }
  // Message history was imported before the result consumer reconciled legacy archive locations.

  registerCommands(context);
  void vscode.commands.executeCommand('setContext', 'unode.teamCompact', false);
  syncConcurrencyContext(); // pick the right concurrency icon for the Team title bar
  await migrateToProviderSplit(context); // 0.9.0: Roam→weroam default; existing roam agents+key kept on Unode
  await migrateLegacySingletonCustomGateways();
  await correctStaleRoamBaseUrl(); // every launch (idempotent): heal a stale persisted unode.baseUrl=unode
  // v0.9.106 quiet first screen: `unode.hasAgents` follows every agent added or removed from here on (the restore
  // below included), and is set once more after the restore, also when it loaded nothing. Until it is first set it
  // is undefined, which the manifest's when clauses read as no agents.
  const hasAgents = createHasAgentsContext({
    agentCount: () => sessionManager.getAll().length,
    setContext: (key, value) => { void vscode.commands.executeCommand('setContext', key, value); },
  });
  followRoster(sessionManager, hasAgents);
  // Only a roster that loaded tells a removed agent from one not loaded yet (v0.9.96). A refused or failed load
  // leaves every draft and its saved copy as they are, and recovery off, until a later start loads the roster.
  let rosterRestored = false;
  try {
    rosterRestored = await restoreRoster();
  } finally {
    if (rosterRestored) chatViewProvider.rosterLoaded();
    else chatViewProvider.rosterNotLoaded();
    teamViewProvider.rosterSettled();
  }
  // Reconcile a manually entered User default only after its current inheriting agents can be named.
  reconcileAutonomyDefaultInBackground();
  // Delegation cards were restored before the roster existed; give them their names now (F7-20).
  if (orchestrationProgress.refreshNames()) publishDelegationProgress();
  hasAgents.sync();
  // v0.9.106 quiet first screen: the stale-reference reminder waited for the restored roster; an empty one keeps it
  // quiet in this window.
  spendHost?.rosterSettled();
  // v0.9.106 (first use): an interrupted start is recovered (never resent), then the presentation is settled.
  try {
    await firstUseController?.rosterLoaded();
  } catch (error) {
    outputChannel.warn(`[first-use] the first goal could not be restored: ${String(error)}`);
  }
  void settleFirstUsePresentation(context, rosterRestored).catch((error) => {
    outputChannel.warn(`[first-use] the first-use presentation was not settled: ${String(error)}`);
  });
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
    ? { __testLocalPdfAttachmentPipeline, __testAttentionPlayback, __testRequestSummaries, __testTerminalBoundary }
    : undefined;
}

/**
 * E2E probe (v0.9.96): drive a dedicated TerminalManager in this extension host with real terminals (or the
 * declared direct fallback where the host's terminal cannot prove its shell) and report what happened. Two
 * commands of one agent must not overlap; another agent's may; a timed-out command's nested child must be gone
 * before the result returns. Only the probe's own agents and terminals are touched.
 */
export async function __testTerminalBoundary(
  fixture: unknown,
  cwd: string,
): Promise<{
  transports: string[];
  shells: string[];
  notices: string[];
  /** Agent terminals that existed once a command was prepared and before it was approved: always none. */
  terminalsBeforeApproval: number;
  serial: { firstEnd: number; secondStart: number };
  parallel: { firstStart: number; firstEnd: number; otherStart: number };
  timeout: { status: string; reason?: string; childPid?: number; childAlive?: boolean };
}> {
  if (!isE2EFixtureRequest(extensionContext?.extensionMode, fixture)) {
    throw new Error('__testTerminalBoundary runs only in the extension-host E2E (Test mode).');
  }
  const manager = new TerminalManager({
    prepareDirect: directCommandPreparer,
    terminateProcessTree: (pid) => terminateProcessTreeObserved(pid, { resolveExecutable: resolveHostProgram }),
  });
  const transports: string[] = [];
  const shells: string[] = [];
  const notices: string[] = [];
  const node = (script: string) => `node -e "${script}"`;
  const stamp = (file: string) => `require('fs').writeFileSync('${file}', String(Date.now()))`;
  const runOnce = async (agentId: string, command: string, timeoutMs: number) => {
    const lease = await manager.executionProviderFor(agentId, `Unode: ${agentId}`).acquire({ cwd });
    if (!lease.ok) throw new Error(`no execution for ${agentId}: ${lease.message}`);
    transports.push(lease.transport);
    shells.push(lease.shell.label);
    if (lease.notice) notices.push(lease.notice);
    try {
      return await lease.execute(command, timeoutMs);
    } finally {
      await lease.release();
    }
  };
  // As an agent does: a command reported as not run because its environment changed is sent once more.
  const run = async (agentId: string, command: string, timeoutMs: number) => {
    const first = await runOnce(agentId, command, timeoutMs);
    return first.status === 'not-started' && first.reason === 'environment-changed' ? runOnce(agentId, command, timeoutMs) : first;
  };
  const readStamp = async (file: string) => Number(await fs.readFile(path.join(cwd, file), 'utf8'));
  try {
    // Nothing is started for a command before its approval: a prepared, unapproved command has no terminal.
    const unapproved = await manager.executionProviderFor('probe-c', 'Unode: probe-c').acquire({ cwd });
    const terminalsBeforeApproval = vscode.window.terminals.filter((terminal) => terminal.name === 'Unode: probe-c').length;
    if (unapproved.ok) await unapproved.release();
    // Each agent proves its terminal once, so the timing below measures the lanes and not a terminal's start.
    await run('probe-a', node('0'), 30_000);
    await run('probe-b', node('0'), 30_000);
    // Long enough that another agent's terminal setup, on a slow runner, still starts within it.
    const slow = node(`${stamp('first.start')}; setTimeout(() => ${stamp('first.end')}, 4000)`);
    await Promise.all([
      run('probe-a', slow, 30_000),
      run('probe-a', node(stamp('second.start')), 30_000),
      run('probe-b', node(stamp('other.start')), 30_000),
    ]);
    const nested = node("const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); "
      + "require('fs').writeFileSync('child.pid', String(c.pid)); setInterval(() => {}, 1000)");
    const timedOut = await run('probe-a', nested, 4_000);
    const childPid = await readStamp('child.pid').catch(() => undefined);
    let childAlive: boolean | undefined;
    if (childPid !== undefined) {
      try { process.kill(childPid, 0); childAlive = true; } catch { childAlive = false; }
    }
    return {
      transports,
      shells,
      notices,
      terminalsBeforeApproval,
      serial: { firstEnd: await readStamp('first.end'), secondStart: await readStamp('second.start') },
      parallel: { firstStart: await readStamp('first.start'), firstEnd: await readStamp('first.end'), otherStart: await readStamp('other.start') },
      timeout: { status: timedOut.status, ...('reason' in timedOut ? { reason: timedOut.reason } : {}), childPid, childAlive },
    };
  } finally {
    await manager.dispose('probe-a');
    await manager.dispose('probe-b');
    await manager.dispose('probe-c');
  }
}

/** v0.9.103 (CLI teammate messages, design test 9): set by activate(); read only by __testBackendWiring. */
let activationBackendFactory: ((config: AgentConfig, launchId: string) => AgentBackend) | undefined;

/**
 * Test-mode probe (v0.9.103, design test 9): a backend built by this activation's own factory, not started, with the
 * bus and resolver this activation holds, so that a test can compare the backend's dependencies by identity.
 */
export function __testBackendWiring(
  fixture: unknown,
  config: AgentConfig,
): { backend: AgentBackend; messageBus: MessageBus; taskInputResolver: TaskInputResolver } {
  if (!isE2EFixtureRequest(extensionContext?.extensionMode, fixture) || !activationBackendFactory) {
    throw new Error('__testBackendWiring runs only in an activated extension in Test mode.');
  }
  return { backend: activationBackendFactory(config, `wiring-probe-${randomUUID()}`), messageBus, taskInputResolver };
}

/**
 * E2E probe (v0.9.94): the request closeout records this activated extension stored for one agent, and the
 * Request summary cards its Chat view holds for them. It reads what the session events, the store and the view
 * produced together; it runs nothing and changes nothing.
 */
export function __testRequestSummaries(
  fixture: unknown,
  agentId: string,
): { records: Array<{ recordId: string; terminal: string; revision: number }>; cards: Array<{ recordId: string; state: string }> } {
  if (!isE2EFixtureRequest(extensionContext?.extensionMode, fixture)) {
    throw new Error('__testRequestSummaries runs only in the extension-host E2E (Test mode).');
  }
  return {
    records: (requestCloseoutStore?.list(agentId) ?? [])
      .map((record) => ({ recordId: record.recordId, terminal: record.terminal.kind, revision: record.revision })),
    cards: chatViewProvider.requestSummaryCards(agentId),
  };
}

/** Attention receipts awaited by the E2E playback probe, keyed by attention id. */
const attentionResultWaiters = new Map<string, (result: { audioState: string; started: boolean; surface: string }) => void>();

/**
 * E2E playback probe (v0.9.88 §5.11): ask the Chat Workbench, visible or hidden behind a text editor, to play the
 * attention chime with no user gesture in it, and return the webview's own receipt. The probe re-asks every half
 * second until the freshly opened webview has loaded and answers; the webview plays one id only once. Production
 * never plays in a hidden container; the probe names the Workbench itself to measure it.
 */
export async function __testAttentionPlayback(
  fixture: unknown,
  options: { hidden: boolean },
): Promise<{ audioState: string; started: boolean; surface: string } | { timedOut: true }> {
  if (!isE2EFixtureRequest(extensionContext?.extensionMode, fixture)) {
    throw new Error('__testAttentionPlayback runs only in the extension-host E2E (Test mode).');
  }
  chatViewProvider.openWorkbench(false);
  if (options.hidden) {
    const document = await vscode.workspace.openTextDocument({ content: 'attention playback probe', language: 'plaintext' });
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Active, preview: false });
  }
  const id = `probe-${randomUUID()}`;
  const answered = new Promise<{ audioState: string; started: boolean; surface: string }>((resolve) => {
    attentionResultWaiters.set(id, resolve);
  });
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      chatViewProvider.playAttention(id, { container: 'workbench' });
      const result = await Promise.race([answered, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500))]);
      if (result) return result;
    }
    return { timedOut: true };
  } finally {
    attentionResultWaiters.delete(id);
  }
}

export async function deactivate(): Promise<void> {
  setCodeNavigationHost(undefined);
  // The order is deactivateHost's: the shutdown begins, the pending saves start, every stop is sent, and only then
  // is anything waited for, the saves last.
  await deactivateHost({
    // The editor ends this host a few seconds from now, and the host's exit ends each direct child at once, which
    // leaves the child's descendants out of reach. From here no direct command starts, and every tree stop sends its
    // kill before it lists.
    beginShutdown: () => {
      hostShutdown.begin();
      outputChannel?.info('UnodeAi deactivating, stopping all agents...');
      if (dashboardRefreshTimer) {
        clearTimeout(dashboardRefreshTimer);
        dashboardRefreshTimer = undefined;
      }
      if (runOwnerHeartbeatTimer) {
        clearInterval(runOwnerHeartbeatTimer);
        runOwnerHeartbeatTimer = undefined;
      }
      // v0.9.99: a recovery-pending deadline must not warn a window that is going away.
      resultDeliveryHost?.close();
    },
    pendingSaves: () => {
      const saves: Array<() => unknown> = [];
      if (resultDeliveryHost) saves.push(() => resultDeliveryHost.drain());
      if (persistence && sessionManager) saves.push(() => agentRosterEdits.retryUnsaved());
      if (messageSaveTimer) {
        clearTimeout(messageSaveTimer);
        saves.push(() => persistence?.saveMessages(messageBus.exportMessages()));
      }
      if (runSaveTimer) {
        clearTimeout(runSaveTimer);
        saves.push(() => persistRunLedger());
      }
      if (checkpointSaveTimer) {
        clearTimeout(checkpointSaveTimer);
        saves.push(() => persistence?.saveCheckpoints(checkpointStore.serialize()));
      }
      // A Workbench draft copy still being written. Like the saves above, it starts now and is waited for last.
      if (chatDraftMirror?.writePending()) {
        saves.push(() => chatDraftMirror?.flush());
      }
      return saves;
    },
    // The stops end every running turn because the window is going away, not because anyone saw the turn end. Said
    // before them, so a request that is cut off here stays recorded as unfinished for the next start.
    hostExiting: () => sessionManager?.hostExiting(),
    stops: [
      () => terminalManager.disposeAll(),
      // Every session is stopped by this call before it returns; it then waits for every backend cleanup, also one an
      // earlier Stop detached.
      () => sessionManager?.shutdown() ?? Promise.resolve(),
      // Every direct child of this host, whoever started it and whether or not anyone waits for its stop.
      () => directChildren.stopAll((proc) => terminateChildProcessTree(proc, { resolveExecutable: resolveHostProgram })),
      () => mcpHub?.stopAll() ?? Promise.resolve(),
      () => Promise.all([...activeIntegrationTests].map(([test, finished]) => {
        test.controller.abort();
        return finished;
      })),
    ],
    // VS Code waits for the promise deactivate returns. The services the stops report through, output channels
    // especially, are disposed only once every stop has settled: a stop that reports into a disposed host can leak
    // the channels created during teardown.
    disposeServices: async () => {
      sessionManager?.dispose();
      await nativeOfficeRenderer?.dispose();
      await workbookRecalcEngine?.dispose();
      messageBus?.dispose();
      // A turn already entering its executor may have created a terminal after the first snapshot.
      await terminalManager.disposeAll();
      for (const { channel } of agentChannels.values()) {
        channel.dispose();
      }
      agentChannels.clear();
    },
    saveFailed: (error) => { outputChannel?.warn(`A save while the window closed failed: ${String(error)}`); },
  });
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
  const tools = new WorkspaceTools(workspaceRoot(), new Set(['read']), 'extension-e2e-pdf');
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
  return {
    enabled: configuredSetting<boolean>('smartMode.enabled', false),
    defaultTier: configuredSetting<ModelTier>('smartMode.defaultTier', 'standard'),
    roleTiers: configuredSetting<Record<string, ModelTier>>('smartMode.roleTiers', {}),
    taskTierHints: configuredSetting<Record<string, ModelTier>>('smartMode.taskTierHints', {}),
  };
}

interface TaskModelSelection {
  tier: ModelTier;
  model?: string;
  modelParams?: AgentModelParams;
}

function configuredRoutingTier(config: AgentConfig): ModelTier {
  const sm = readSmartMode();
  return configuredRoleTier(config, sm);
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
    configuredSetting<Partial<Record<ModelTier, Record<string, string>>>>('modelTiers', {})
  );
  const rawTierParams = configuredSetting<Partial<Record<ModelTier, AgentModelParams>>>('modelTierParams', {});
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
    configuredSetting<Partial<Record<ModelTier, Record<string, string>>>>('modelTiers', {})
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
  const tier: ModelTier = configuredRoleTier(config, sm);
  const tiers = resolveModelTiers(
    configuredSetting<Partial<Record<ModelTier, Record<string, string>>>>('modelTiers', {})
  );
  return { tier, model: tiers[tier]?.[config.provider.providerId] };
}

/** Spend tracking is observational: a failure is logged and never reaches the work it describes. */
function spendSafely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    outputChannel?.warn('Spend tracking skipped an event.');
  }
  return undefined;
}

/**
 * The summarizer model's own window: the agent's resolved window when it summarizes with its own model, otherwise
 * what the gateway advertised for that exact model, otherwise the assumed default.
 */
function summarizerContextWindow(config: AgentConfig, model: string): { tokens: number; source: ContextWindowSource } {
  if (model === config.model) {
    const resolved = resolveContextWindow(config);
    return { tokens: resolved.tokens, source: resolved.source };
  }
  const connectionId = config.route?.connectionId;
  const discovered = connectionId ? discoveredContextWindow(connectionId, model)?.tokens : undefined;
  // An economy model the gateway never described keeps the documented default, and says it is an assumption.
  return discovered !== undefined ? { tokens: discovered, source: 'measured' } : { tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'assumed' };
}

/**
 * One summarizer request with its own usage (v0.9.90 §5.2): compaction is priced like any other model work, so
 * the caller settles a usage unit from exactly this response. A cancelled signal aborts the request.
 */
async function summaryChatCompletion(
  config: AgentConfig,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  model: string,
  params?: AgentModelParams,
  signal?: AbortSignal,
  onRequestSent?: () => void,
): Promise<SummaryCompletion> {
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
  // The same grant as the agent's own requests: its connection profile and revision. Without a scope the gate fell
  // back to a generic host-only grant, so a connection the user had already allowed was asked about again.
  const scope = summaryEgressScope(connectionProfileForAgent(config, effectiveConnectionRegistry), config.name);
  const requester = `${config.name} via ${displayNameForProviderId(config.provider.providerId, effectiveConnectionRegistry)} (conversation summary)`;
  const { ok, status, text } = await sendSummaryRequest(
    { url: summarizerUrl, apiKey, body, scope, ...(signal ? { signal } : {}), ...(onRequestSent ? { onRequestSent } : {}) },
    {
      approveEgress: (url, egressScope) => egressGate(url, undefined, requester, egressScope, { agentId: config.id, sessionId: config.id }),
      fetch: oneTextRequestFetch,
      // v0.9.94: a summary request is held at a reached request limit like the agent's own model requests.
      requestBoundary: (boundarySignal) => requestBoundaryFor(config.id)('provider-request', boundarySignal ? { signal: boundarySignal } : {}),
    },
  );
  if (!ok) {
    throw new Error(`HTTP ${status} while summarizing history: ${String(text).slice(0, 300)}`);
  }
  const data = JSON.parse(text);
  const usage = summaryCompletionUsage(data);
  return {
    text: String(data.choices?.[0]?.message?.content ?? ''),
    ...(usage ? { usage } : {}),
    ...(typeof data.id === 'string' ? { responseId: data.id } : {}),
  };
}

function openAIBaseUrlFor(config: AgentConfig, _env: NodeJS.ProcessEnv): string {
  const route = config.route ?? agentRouteFromLegacyConfig(config, effectiveConnectionRegistry);
  return resolveOpenAICompatBaseUrl(route, effectiveConnectionRegistry);
}

/** Build the run_command gatekeeper from settings. Default-deny: execution is off unless the
 *  user picks a mode and (for allowlist) lists trusted command prefixes. */
function makeCommandPolicy(): CommandPolicy {
  return new CommandPolicy(
    effectiveCommandApprovalMode(
      configuredSetting<CommandApprovalMode>('commandApproval', 'all'),
      projectCommandApprovals.isExecutionEnabled(),
    ),
    effectiveCommandPolicyInputs(),
  );
}

/**
 * v0.2.8 'ask' mode: prompt the user before an agent runs a not-yet-allowlisted command, modeled on
 * Claude Code's Yes / Yes-for-this-project / No. Project approval stores the command TEMPLATE
 * (e.g. "git status", not bare "git") in UnodeAi-owned workspace state and reloads the live policy,
 * so future matching commands run without a prompt — without changing user settings.
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
  const currentRulesFile = rulesFile;
  if (!currentRulesFile) {
    void showWorkspaceBindingRequired('edit team rules');
    return;
  }
  void openTeamRulesPanel({
    rulesFilePath: currentRulesFile.path,
    defaultTemplate: defaultTeamRules(currentTeamKind()),
    initialContent: presetBody,
    onSaved: () => { void syncTeamRulesOnRosterChange(); },
    currentPolicy: () => teamPolicyStore.current(),
    setReviewPolicyFromHumanPanel: async (mode) => { const changed = await teamPolicyStore.setModeFromHumanPanel(mode); SecurityPanel.refreshIfOpen(); SetupGuidePanel.refreshCurrent(); chatViewProvider?.refresh(); return changed; },
    latestPolicyChangeAt: () => teamPolicyStore.changes().at(-1)?.recordedAt,
    canSave: () => !!firstWorkspaceRoot() && sameWorkspaceRoot(currentRulesFile.path, rulesFile?.path),
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
  const currentRulesFile = rulesFile;
  if (!currentRulesFile) { return; }
  await currentRulesFile.load();
  const current = currentRulesFile.get();
  const kind = currentTeamKind();
  const next = syncTeamRulesWithRoster(current, kind, currentTeamRoster());
  if (next === current) { return; }
  try {
    await fs.mkdir(path.dirname(currentRulesFile.path), { recursive: true });
    await fs.writeFile(currentRulesFile.path, next, 'utf8');
    await currentRulesFile.load();
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

// Command templates the user approved for THIS session only (in-memory, not persisted), each bound to the
// shell grammar it was approved under.
const sessionApprovedCommands = new SessionCommandApprovals();

/**
 * Open one brokered approval that the host can withdraw. When the prepared command's signal aborts (the agent
 * was removed, restarted or the host disposed it before the command ran), the card closes at once as
 * `host-disposed` instead of waiting for its deadline.
 */
function abortableBrokeredApproval(
  request: Omit<ApprovalRequest, 'id'>,
  timeoutMs: number,
  showModal: () => Promise<{ action: string; note?: string }>,
  signal?: AbortSignal,
): Promise<ParticipantOutcome> {
  return settleOnAbort(approvalBroker, openBrokeredApproval(request, timeoutMs, showModal), signal);
}

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

/** Run one human approval with the requesting session's turn clock paused for as long as the person takes. */
function timedApproval<T>(
  origin: { agentId?: string; sessionId?: string },
  open: () => Promise<T>,
): Promise<{ startedAtMs: number; outcome: T }> {
  return sessionManager.timeApproval(origin.sessionId ?? origin.agentId, open);
}

/**
 * v0.9.93: the coordinator turn a dispatch receipt or refusal belongs to. The event carries the turn its call ran
 * in, read at that moment. A receipt is published when the worker admits the task, and by then the coordinator may
 * be idle or in another turn. Only an event that carries no turn falls back to the one running now.
 */
function dispatchOriginOf(
  event: { originCorrelationId?: string; originTurnId?: string },
  coordinatorId: string,
): { originCorrelationId?: string; originTurnId?: string } {
  if (event.originCorrelationId || event.originTurnId) {
    return { originCorrelationId: event.originCorrelationId, originTurnId: event.originTurnId };
  }
  return {
    originCorrelationId: sessionManager.currentTurnCorrelationId(coordinatorId),
    originTurnId: sessionManager.currentTurnId(coordinatorId),
  };
}

/**
 * The wait of a blocking prompt raised for an agent. That agent's turn clock stands still until the person has
 * decided: in a running turn, and in the queue time of a request that is waiting for the agent to start. A prompt
 * no agent raised passes an empty origin and pauses nothing.
 */
/** v0.9.94: what one agent asks before a model request leaves or a tool call acts. */
function requestBoundaryFor(agentId: string): RequestBoundary {
  return agentRequestBoundary(agentId, {
    gate: () => requestCeiling,
    currentRequestId: (id) => sessionManager.currentRequestId(id),
    personWait: (id, wait) => sessionManager.timeApproval(id, wait).then(({ outcome }) => outcome),
  });
}

function pausingTurnClock(origin: { agentId?: string; sessionId?: string }): PromptWait {
  return (wait) => timedApproval(origin, async () => wait()).then(({ outcome }) => outcome);
}

function recordApprovalMetric(
  origin: { agentId?: string; sessionId?: string },
  startedAtMs: number,
  decision: RunPermissionDecision,
  kind?: RunPermissionKind,
  approverId?: string,
  label?: string,
): void {
  sessionManager.recordApprovalOutcome(
    origin.sessionId ?? origin.agentId,
    Date.now() - startedAtMs,
    decision !== 'allowed',
    { decision, ...(kind ? { kind } : {}) },
  );
  if (kind) {
    runLedger.recordPermission({
      agentId: origin.sessionId ?? origin.agentId,
      kind,
      decision,
      ...(approverId ? { approverId } : {}),
      ...(label ? { label } : {}),
      correlationId: sessionManager.currentTurnCorrelationId(origin.sessionId ?? origin.agentId ?? ''),
    });
  }
}

function approvalMetricDecision(action: string, expired?: true): RunPermissionDecision {
  return expired ? 'expired' : action === 'deny' ? 'denied' : 'allowed';
}

async function requestCommandApproval(
  command: string,
  agentName = 'An agent',
  context: CommandApprovalContext,
  origin: { agentId?: string; sessionId?: string } = {},
): Promise<CommandApprovalDecision> {
  if (context.outward !== undefined || context.outwardUnknownReason !== undefined) {
    return requestOutwardActionApproval(command, context.outward ?? [], agentName, context, origin);
  }
  if (context.dangerous) {
    if (context.signal?.aborted) return { allow: false, withdrawn: true };
    const allow = await confirmDangerousCommand(command, context.cwd, attentionAppearance('dangerous-command'), pausingTurnClock(origin),
      context.installNote);
    return { allow: allow && !context.signal?.aborted };
  }
  const template = CommandPolicy.commandTemplate(command);
  const shell = context.shell;
  // An opaque command (the guard could not read it) may be approved for this one use only: never remembered,
  // never offered a session/project grant, never matched against a latched grant.
  const singleUse = context.singleUse === true;
  // An unverified provider shell may be approved once and never remembered under any grammar.
  const persistedGrammar = singleUse || !isPersistedCommandShellGrammar(shell.grammar) ? undefined : shell.grammar;
  const hasSafeCommandOffer = !!template && !!persistedGrammar && SAFE_COMMAND_TEMPLATES.includes(template) && !context.forcePrompt;
  // Already approved for this session under THIS grammar → run without prompting again. A session grant is
  // matched PER SEGMENT, so a grant of one command ("git status") can never carry a different command spliced
  // into the same chain ("git status && …"): every segment's own template must be latched, and the whole
  // command must be a supported chain. `forcePrompt` (an out-of-root path) and `singleUse` (opaque) never latch.
  const latchSegments = context.forcePrompt || singleUse ? undefined : autoAllowSegments(command, shell);
  if (latchSegments && latchSegments.length > 0
    && latchSegments.every((segment) => {
      const segmentTemplate = CommandPolicy.commandTemplate(segment);
      return !!segmentTemplate && sessionApprovedCommands.has(shell.grammar, segmentTemplate);
    })) {
    return { allow: true };
  }
  if (context.signal?.aborted) {
    return { allow: false, withdrawn: true };
  }
  // Prefer the in-panel approval card; fall back to a native modal if the chat webview isn't available.
  // This is deliberately after all silent paths and before either UI route: count every actual interruption,
  // never an allowlisted execution or a raw command string.
  recordPromptedCommand(template);
  const safeListNote = hasSafeCommandOffer
    ? `"${template}" is in UnodeAi's reviewed safe command list. Enable that list explicitly for this project to stop prompting for its read/build/test commands; inspect or revoke project approvals with "UnodeAi: Manage Project Command Approvals".`
    : undefined;
  const warning = [context.warning, safeListNote].filter((value): value is string => !!value).join('\n\n') || undefined;
  const request: Omit<ApprovalRequest, 'id'> = {
    kind: 'command', agentName, command, template, warning, safeCommandOffer: hasSafeCommandOffer,
    shellLabel: shell.label,
    ...(persistedGrammar ? {} : { singleUseOnly: true }),
    ...origin,
  };
  const { startedAtMs: approvalStartedAt, outcome } = await timedApproval(origin, () => abortableBrokeredApproval(
    request, HUMAN_APPROVAL_WINDOW_MS,
    () => nativeCommandApprovalChoice(command, template, warning, hasSafeCommandOffer, shell.label, !persistedGrammar),
    context.signal));
  if (outcome.settledBy === 'host-disposed' && context.signal?.aborted) {
    // The host closed the card because the command can no longer run. Nobody decided anything.
    sessionManager.recordApprovalOutcome(origin.sessionId ?? origin.agentId, Date.now() - approvalStartedAt, true);
    return { allow: false, withdrawn: true };
  }
  recordBrokeredApproval(origin, approvalStartedAt, outcome, 'command-approval');
  // Only a contemporaneous human decision can allow the command or persist an approval. An expired,
  // withdrawn or disposed prompt never reaches the side effects in applyCommandApproval.
  if (outcome.settledBy !== 'human') {
    return { allow: false, note: outcome.note, noteOrigin: 'host', ...(outcome.settledBy === 'withdrawn' ? { withdrawn: true } : {}) };
  }
  return applyCommandApproval(outcome.action, outcome.note, template, persistedGrammar);
}

/** Exact outward decisions precede every ordinary command latch and are never remembered. */
async function requestOutwardActionApproval(command: string, effects: readonly PreparedOutwardEffect[], agentName: string,
  context: CommandApprovalContext, origin: { agentId?: string; sessionId?: string }): Promise<CommandApprovalDecision> {
  if (context.signal?.aborted) return { allow: false, withdrawn: true };
  const detail = [
    'Approve only this outward action. No session, project or tool-wide permission is granted.',
    ...effects.map(effect => `${effect.kind}: ${effect.destination}\nContent: ${effect.content}`),
    context.outwardUnknownReason || effects.length === 0
      ? `Destination and content could not be determined before running: ${context.outwardUnknownReason ?? 'The exact effect is unavailable for this recognized action.'}` : '',
    context.dangerous ? 'This command is also potentially destructive. Approval covers that danger for this same invocation only.' : '',
    context.warning ?? '', `Command: ${command}`, `Shell: ${context.shell.label}`, `Folder: ${context.cwd}`,
  ].filter(Boolean).map(value => redactApprovalPreview(value)).join('\n\n');
  const { startedAtMs, outcome } = await timedApproval(origin, () => abortableBrokeredApproval({ kind: 'tool',
    agentName, toolName: 'Outward action', toolDetail: detail, singleUseOnly: true, ...origin }, HUMAN_APPROVAL_WINDOW_MS,
    () => nativeExactEffectApprovalChoice(agentName, 'Outward action', detail), context.signal));
  const allow = outcome.settledBy === 'human' && outcome.action === 'once' && !context.signal?.aborted;
  if (outcome.settledBy === 'host-disposed' && context.signal?.aborted) {
    sessionManager.recordApprovalOutcome(origin.sessionId ?? origin.agentId, Date.now() - startedAtMs, true);
  } else recordBrokeredApproval(origin, startedAtMs, { ...outcome, action: allow ? 'once' : 'deny', note: undefined }, 'outward-action');
  const note = !allow && outcome.settledBy === 'human' && outcome.action === 'deny' && !context.signal?.aborted ? outcome.note?.trim() : undefined;
  return { allow, ...(note ? { note, noteOrigin: 'human' as const } : {}),
    ...(context.signal?.aborted || outcome.settledBy === 'withdrawn' ? { withdrawn: true } : {}) };
}

/** The existing security-setting floor, once for the exact proposal; only an actual human's decline carries their note. */
async function requestSecurityControlApproval(request: OverwriteDecisionRequest, agentName: string,
  origin: { agentId?: string; sessionId?: string }): Promise<OverwriteDecision> {
  if (request.signal?.aborted) return 'deny';
  return requestExactSingleUseDecision(request, agentName, origin,
    { toolName: 'Security-setting change', detail: securityControlApprovalPreview(request), kind: 'security-setting' });
}

/**
 * v0.9.108 (D11, Owner): confirm one signature placement. It acts in the user's name, so it uses the exact single-use
 * card of outward actions; nothing is remembered and only a contemporaneous human Allow places the signature.
 */
async function requestSignaturePlacementApproval(request: OverwriteDecisionRequest, agentName: string,
  origin: { agentId?: string; sessionId?: string }): Promise<OverwriteDecision> {
  if (request.signal?.aborted) return 'deny';
  return requestExactSingleUseDecision(request, agentName, origin, { toolName: 'Place signature',
    detail: request.preview ?? 'Place your saved signature on a PDF page.', kind: 'outward-action', label: 'Place signature' });
}

/**
 * The exact single-use card shared by the security-setting floor and the signature placement: nothing is remembered,
 * only a contemporaneous human Allow while the request is live allows, and only an actual human's decline carries their note.
 */
async function requestExactSingleUseDecision(request: OverwriteDecisionRequest, agentName: string,
  origin: { agentId?: string; sessionId?: string },
  card: { toolName: string; detail: string; kind: RunPermissionKind; label?: string }): Promise<OverwriteDecision> {
  const { toolName, detail } = card;
  const { startedAtMs, outcome } = await timedApproval(origin, () => abortableBrokeredApproval({ kind: 'tool',
    agentName, toolName, toolDetail: detail, singleUseOnly: true, ...origin }, HUMAN_APPROVAL_WINDOW_MS,
    () => nativeExactEffectApprovalChoice(agentName, toolName, detail), request.signal));
  const allow = outcome.settledBy === 'human' && outcome.action === 'once' && !request.signal?.aborted;
  if (outcome.settledBy === 'host-disposed' && request.signal?.aborted) {
    sessionManager.recordApprovalOutcome(origin.sessionId ?? origin.agentId, Date.now() - startedAtMs, true);
  } else recordBrokeredApproval(origin, startedAtMs, { ...outcome, action: allow ? 'once' : 'deny', note: undefined }, card.kind, card.label);
  const userNote = !allow && outcome.settledBy === 'human' && outcome.action === 'deny' && !request.signal?.aborted ? outcome.note?.trim() : undefined;
  return allow ? 'once' : userNote ? { action: 'deny', userNote } : 'deny';
}

/** A two-choice native fallback; it offers none of the ordinary command/write latches. */
async function nativeExactEffectApprovalChoice(agentName: string, title: string, detail: string): Promise<{ action: string }> {
  const DENY = 'Deny'; const ONCE = 'Allow once';
  const answer = await vscode.window.showWarningMessage(`${agentName}: ${title}\n\n${detail}`, { modal: true }, DENY, ONCE);
  if (answer === ONCE) return { action: 'once' };
  return { action: 'deny' };
}

function securityControlApprovalPreview(request: Pick<OverwriteDecisionRequest, 'path' | 'operation' | 'before' | 'after' | 'preview' | 'foreignFiles' | 'securityChanges'>): string {
  const changes = request.securityChanges?.length ? request.securityChanges : [{ path: request.path, kind: 'security-control',
    operation: request.operation, before: request.before, after: request.after }];
  const details = changes.map(change => {
    const binary = change.kind === 'global-state' || change.kind === 'workspace-state' || /[\u0000\uFFFD]/.test(`${change.before ?? ''}${change.after}`);
    const preview = binary ? 'This replaces or removes a whole mixed control artifact. Its security and credential data may change; contents are not displayed.'
      : createUnifiedDiff(change.before === null ? '' : redactApprovalPreview(change.before), redactApprovalPreview(change.after),
        redactApprovalPreview(change.path), { maxChars: Number.MAX_SAFE_INTEGER }).text;
    return `${change.operation === 'delete' ? 'Remove' : 'Change'} ${redactApprovalPreview(change.path)} (${change.kind})\n${preview}`;
  });
  return [
    'This changes security controls. It can affect permissions, future access, credentials or model/provider routing. Approve this exact change only.',
    'Recognized credential values are hidden in this preview. A raw Full access setting does not by itself record its separate enable consent.',
    request.preview ? redactApprovalPreview(request.preview) : '',
    request.foreignFiles?.length ? `The deletion also removes files UnodeAi did not make. There is no folder restore point.\n${request.foreignFiles.map(redactApprovalPreview).join('\n')}` : '',
    ...details,
  ].filter(Boolean).join('\n\n');
}

/** Local preview redaction only. It never transforms proposed bytes or file text delivered to a model. */
function redactApprovalPreview(value: string): string {
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(value, errors, { allowTrailingComma: true });
  const credential = (key: string) => /(?:^|[_-])(?:token|password|secret|authorization|auth|credentials?)$/i.test(key)
    || /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret)$/i.test(key);
  const visit = (item: unknown, privateValues = false): unknown => {
    if (Array.isArray(item)) return item.map(value => visit(value, privateValues));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key,
      visit(entry, privateValues || credential(key) || /^(?:env|headers|authentication)$/i.test(key))]));
    return privateValues && item !== null ? '[redacted credential value]' : item;
  };
  const text = errors.length === 0 && parsed !== undefined && parsed !== null && typeof parsed === 'object'
    ? JSON.stringify(visit(parsed), null, 2) : value;
  return redactSecretText(text)
    .replace(/(["'][^"'\r\n]*(?:api[_-]?key|token|password|secret|credential|authorization)[^"'\r\n]*["']\s*:\s*)(["'])(?:\\.|(?!\2)[^\\\r\n])*\2/gi, '$1"[redacted credential value]"')
    .replace(/((?:--(?:token|password|secret|api[_-]?key))\s+)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+)/gi, '$1[redacted credential value]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^\s&#]*/gi, '$1[redacted credential value]')
    .replace(/((?:^|\n)[^\r\n=]*(?:TOKEN|PASSWORD|SECRET|KEY)[^\r\n=]*=\s*)[^\r\n]*/gi, '$1[redacted credential value]');
}

/**
 * Apply a command-approval action (from the panel card or the native modal) + its side effects. A remembered
 * approval is stored under the grammar of the shell it was given under; an unverified shell remembers nothing.
 */
async function applyCommandApproval(
  action: string,
  note: string | undefined,
  template: string | undefined,
  grammar: PersistedCommandShellGrammar | undefined,
): Promise<CommandApprovalDecision> {
  if (action === 'once') {
    return { allow: true };
  }
  if (!grammar && (action === 'session' || action === 'project' || action === 'safe')) {
    // The card offers only a one-use approval for an unverified shell; any other allow is used once.
    return { allow: true };
  }
  if (action === 'session') {
    if (template && grammar) { sessionApprovedCommands.add(grammar, template); }
    return { allow: true };
  }
  if (action === 'project') {
    if (!template || !grammar || !(await projectCommandApprovals.approve({ grammar, template }))) {
      return { allow: false, note: 'Open a workspace folder before approving a command for this project.', noteOrigin: 'host' };
    }
    reloadCommandPolicy();
    return { allow: true };
  }
  if (action === 'safe' && template && SAFE_COMMAND_TEMPLATES.includes(template)) {
    // The reviewed list for every grammar at once, so the foreground terminal's shell and the direct shell of
    // configured checks agree. Each grammar keeps only the templates it can run.
    if (!(await projectCommandApprovals.approveMany(reviewedSafeApprovalKeys(SAFE_COMMAND_TEMPLATES)))) {
      return { allow: false, note: 'Open a workspace folder before enabling safe commands for this project.', noteOrigin: 'host' };
    }
    reloadCommandPolicy();
    void showResultNotice('information', 'Enabled reviewed safe commands in UnodeAi-owned storage for this workspace. Existing .vscode/settings.json approvals are intentionally ignored.');
    return { allow: true };
  }
  // 'deny' or anything unexpected → deny (optionally with a note for the agent).
  return { allow: false, note: note?.trim() || undefined, noteOrigin: 'human' };
}

/** Native-modal fallback for command approval. Returns the same {action, note} shape as the panel card. */
async function nativeCommandApprovalChoice(
  command: string,
  template?: string,
  warning?: string,
  safeCommandOffer = false,
  shellLabel?: string,
  singleUseOnly = false,
): Promise<{ action: string; note?: string }> {
  const ONCE = 'Allow once';
  const SESSION = 'Allow this session';
  const PROJECT = 'Allow for project';
  const SAFE = 'Enable safe commands';
  const DENY = 'Deny';
  const DENY_NOTE = 'Deny with note…';
  const choice = await vscode.window.showWarningMessage(
    `${warning ? `${warning}\n\n` : ''}An agent wants to run a command:\n\n${command}`
      + `${shellLabel ? `\n\nShell: ${shellLabel}` : ''}`
      + `${template && !singleUseOnly ? `\n\nProject approval pattern: ${template}` : ''}`,
    { modal: true },
    DENY,
    ONCE,
    ...(singleUseOnly ? [] : [SESSION, PROJECT]),
    ...(safeCommandOffer && !singleUseOnly ? [SAFE] : []),
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

async function nativeWriteApprovalChoice(
  agentName: string,
  verb: string,
  targetPath: string,
  preview: string,
): Promise<'once' | 'always' | 'deny'> {
  const DENY = 'Deny';
  const APPROVE = 'Approve';
  const ALL = 'Approve all (session)';
  const choice = await vscode.window.showWarningMessage(
    `${agentName} wants to ${verb} ${targetPath}:\n\n${preview}`,
    { modal: true },
    DENY,
    APPROVE,
    ALL,
  );
  if (choice === ALL) return 'always';
  if (choice === APPROVE) return 'once';
  return 'deny';
}

/** V2: preview a pending file write (diff) and let the user approve once / approve all / deny. */
async function requestWriteApproval(
  req: { path: string; before: string | null; after: string; preview?: string; signal?: AbortSignal },
  agentName: string,
  origin: { agentId?: string; sessionId?: string },
): Promise<OverwriteDecision | 'always'> {
  if (writeApprovedAll) {
    return 'once';
  }
  const preview = req.preview ?? writeDiffPreview(req);
  const verb = req.before === null ? 'create' : 'overwrite';

  // Prefer the in-panel approval card; fall back to a native modal if the chat webview isn't available.
  // v0.9.97: the call's cancellation withdraws the card, so a card is never left for a call that has ended.
  const { startedAtMs: approvalStartedAt, outcome } = await timedApproval(origin, () => abortableBrokeredApproval(
    { kind: 'write', agentName, path: req.path, verb, diff: preview, ...origin },
    HUMAN_APPROVAL_WINDOW_MS,
    async () => ({ action: await nativeWriteApprovalChoice(agentName, verb, req.path, preview) }),
    req.signal,
  ));
  recordBrokeredApproval(origin, approvalStartedAt, outcome, 'write-approval');
  // "Approve all writes" is a session grant: only a contemporaneous human decision may set it.
  if (outcome.settledBy !== 'human') {
    return 'deny';
  }
  if (outcome.action === 'always') {
    writeApprovedAll = true;
    return 'always';
  }
  const userNote = outcome.action === 'deny' && !req.signal?.aborted ? outcome.note?.trim() : undefined;
  return outcome.action === 'once' ? 'once' : userNote ? { action: 'deny', userNote } : 'deny';
}

/**
 * What a write card shows: the change as a bounded text diff. v0.9.97: a change that is not text (a saved attachment)
 * brings its own preview instead, which names the destination, type, size and SHA-256.
 */
function writeDiffPreview(req: { path: string; before: string | null; after: string }): string {
  const { text } = createUnifiedDiff(req.before ?? '', req.after, req.path);
  const MAX_PREVIEW = 1500;
  return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}\n…(diff truncated)` : text;
}

/** Drive `unode.soloActive` (true while Solo is selected) and redraw the Team panel. Before v0.9.106 the key chose the
 *  Team title bar's ⚡ icon; Solo is now a Team Actions entry, and the key is kept for when clauses. */
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

/** v0.9.108: authority-bearing Word settings (User settings only) and the Word user name cached by application detection. */
function currentOfficeAuthoring(memberName: string): import('./office/word/WordAuthor').OfficeAuthoring {
  return { trackChangesDefault: configuredSetting<boolean>('office.trackChangesDefault', true) !== false,
    authorName: String(configuredSetting<string>('office.authorName', '') ?? ''), memberName, wordUserName: localApplications?.wordUserName() };
}

function currentOfficeRenderPreferences(): OfficeRenderPreferences {
  return { preferred: officeRendererPreference(rootWorkspaceState.get(OFFICE_RENDERER_PREFERENCE_KEY)), automaticWindowsCom: AUTOMATIC_WINDOWS_COM_DEFAULT };
}

/**
 * Host tools for attachment saves and document generation by Claude/Codex, plus explicitly enabled Claude
 * bridge commands through the existing command gate. They write only through the
 * shared write policy (its decision card, the per-file lock, the restore point kept before a file is replaced, the
 * commit beside the file and its read-back), ask the same write approval as every host write, record the change like
 * any other, and refuse in an untrusted workspace. The team's read-before-write check is the CLI's own concern: its
 * reads and writes do not go through these tools, so they get none.
 */
function cliHostFileTools(options: {
  root: string;
  agentId: string;
  mayWrite?: boolean;
  mayExecute?: boolean;
  commandPolicy?: CommandPolicy;
  requestCommandApproval?: CommandApprover;
  livePathAccess?: import('./backend/localReadScope').LivePathAccess;
  fullFileAccess?: () => boolean;
  fullFileAccessRevision?: () => unknown;
  writeApprovalAsk?: () => boolean;
  onFileOutsideRoot?: (target: string, access?: 'read' | 'readwrite') => void;
  writeRoots: string[];
  approveWrite: WriteApprover;
  fileWrites: AgentFileWrites;
  requestBoundary: RequestBoundary;
  /** The host's store of what users attached: the only source of a saved file's bytes. */
  contentAssets: ContentAssetStore;
  documentRenderer?: Pick<DocumentRenderer, 'render'>;
  imageGeneration?: ImageGenerationHost;
  keepImageToolSignature?: boolean;
  nativeOfficeRenderer?: Pick<NativeOfficeRenderer, 'render'>;
  pdfSignatures?: PdfSignatureStore;
  workbookRecalcEngine?: WorkbookRecalcEngine;
  webAccess?: WebAccessPolicyGate;
  officeRenderPreferences?: () => OfficeRenderPreferences;
  officeApplicationCatalog?: Pick<LocalApplicationCatalog, 'candidate'>;
  officeAuthoring?: () => import('./office/word/WordAuthor').OfficeAuthoring;
  presentationRenderer?: Pick<PresentationRenderer, 'render'>;
  onDocumentWritten?: (receipt: import('./content/document/DocumentWrite').DocumentReceiptV1, requestId: string | undefined) => void;
}): WorkspaceTools {
  const tools = new WorkspaceTools(
    options.root,
    new Set([...(options.mayWrite !== false ? ['write'] : []), ...(options.mayExecute === true ? ['execute'] : [])]),
    options.agentId,
    new NoopFileCoordinator(),
    options.commandPolicy, undefined, options.requestCommandApproval, undefined, undefined, undefined,
    recordCheckpoint,
    options.writeApprovalAsk ?? (() => configuredSetting<'none' | 'ask'>('writeApproval', 'none') === 'ask'),
    options.approveWrite,
    undefined, undefined, undefined, [],
    () => vscode.workspace.isTrusted,
    options.writeRoots,
    undefined, options.webAccess, undefined,
    options.contentAssets,
  );
  tools.setTaskInputResolver(taskInputResolver);
  tools.setLivePathAccess(options.livePathAccess);
  tools.setFullFileAccess(options.fullFileAccess, options.fullFileAccessRevision);
  tools.setOutsideRootObserver(options.onFileOutsideRoot);
  tools.setFileWrites(options.fileWrites);
  tools.setDocumentRenderer(options.documentRenderer);
  tools.setImageGeneration(options.imageGeneration, options.keepImageToolSignature);
  if (options.nativeOfficeRenderer) tools.useNativeOfficeRenderer(options.nativeOfficeRenderer);
  tools.setPdfSignatures(options.pdfSignatures);
  tools.setWorkbookRecalcEngine(options.workbookRecalcEngine);
  tools.setOfficeRenderPreferences(options.officeRenderPreferences);
  tools.setOfficeApplicationCatalog(options.officeApplicationCatalog);
  tools.setOfficeAuthoring(options.officeAuthoring);
  tools.setPresentationRenderer(options.presentationRenderer);
  tools.setDocumentObserver(options.onDocumentWritten);
  tools.setRequestBoundary(options.requestBoundary);
  return tools;
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

/** Workspace storage key of the host's records of its own file effects: metadata only, never file content. */
const OWN_FILE_EFFECTS_KEY = 'unode.ownFileEffects.v1';

/**
 * v0.9.97: the shared write policy of this workspace. It looks at nothing until a structured change proposes a
 * target: the open editors' unsaved state, that one path in Git, and its records, loaded at that first look. The
 * records live in the bound root's own project state, so another root's records are never read.
 */
function makeFileWritePolicy(): FileWritePolicy {
  return new FileWritePolicy({
    securityControls: target => securityControlLocations?.getLocations(target) ?? [],
    workspaceId: () => firstWorkspaceRoot() ?? 'no-workspace',
    dirtyEditorPaths: () => [
      ...vscode.workspace.textDocuments.filter((doc) => doc.isDirty && doc.uri.scheme === 'file').map((doc) => doc.uri.fsPath),
      ...vscode.workspace.notebookDocuments.filter((doc) => doc.isDirty && doc.uri.scheme === 'file').map((doc) => doc.uri.fsPath),
    ],
    gitPath: gitPathStatus,
    isRequestRunning: (requestId) => sessionManager?.requestRunning(requestId) ?? false,
    ownEffects: {
      load: () => rootWorkspaceState.get(OWN_FILE_EFFECTS_KEY),
      save: (records) => rootWorkspaceState.update(OWN_FILE_EFFECTS_KEY, records),
    },
    checkpoints: preChangeCheckpoints,
    // v0.9.110 R1: one writer per physical file across this host's windows; a busy file is a retryable conflict.
    fileLeases: fileWriterLeases(),
    // v0.9.97: what a change did to a file, as read back, for the closeout of the request it was made for.
    onEffect: (effect) => {
      sessionManager?.noteFileEffect(effect.requestId, {
        ...(effect.path ? { path: effect.path } : {}),
        key: effect.key,
        operation: effect.operation,
        grade: effect.grade,
      }, effect.turnId ? { agentId: effect.agentId, turnId: effect.turnId } : undefined);
      // v0.9.106: the same fact, with its version, for a file a review was bound to (order and version of a fix).
      runLedger?.noteReviewTargetEffect(effect);
      const authorWorkspace = firstWorkspaceRoot();
      if (authorWorkspace) runLedger?.fileCommits.record(authorWorkspace, effect, effect.turnId
        ? sessionManager?.reportedModelForTurn(effect.agentId, effect.turnId) : undefined);
    },
  });
}

/** The host supplies locations; neither team files nor model arguments select the protected roots. */
function createSecurityControlLocationAdapter(context: vscode.ExtensionContext): SecurityControlLocationAdapter {
  const remoteExecution = !!vscode.env.remoteName && context.extension.extensionKind === vscode.ExtensionKind.Workspace;
  return new SecurityControlLocationAdapter({
    globalStorageUri: context.globalStorageUri,
    workspaceStorageUri: context.storageUri,
    customGatewayRegistryPath,
    hostFileSystem: context.globalStorageUri.scheme !== 'file' ? 'unknown' : remoteExecution ? 'remote-extension-host' : 'local-desktop',
    runtimeLocations: () => [...runtimeSecurityControlLocations.values()].flatMap(locations => [...locations]),
  });
}

/** A late cleanup owns only its launch's registration; it cannot clear a replacement launch's files. */
function publishRuntimeControlFiles(agentId: string, launchId: string, locations: readonly SecurityControlArtifactLocation[]): void {
  const key = `${agentId}\0${launchId}`;
  if (locations.length === 0) { runtimeSecurityControlLocations.delete(key); return; }
  if (!sessionManager.isCurrentBackendLaunch(agentId, launchId)) return;
  runtimeSecurityControlLocations.set(key, locations.map(location => ({ ...location })));
}

/**
 * v0.9.97: this workspace's raw-byte restore points, in the extension's own storage under the bound root's identity
 * (never in workspace state, never in another workspace's directory). A record whose restore point is gone goes too,
 * now and whenever the store drops one, and both kinds of restore point share one limit of entries.
 */
async function openRawCheckpoints(storageRoot: string | undefined): Promise<RawCheckpointStore> {
  const root = firstWorkspaceRoot();
  if (!storageRoot || !root) {
    throw new Error('no workspace folder is open');
  }
  // v0.9.110 (R1): the shared raw-v2 directory of this workspace's whole physical root set. Every window of it takes
  // turns under one lease, and pins are written with the host that holds them. 0.9.109 windows keep raw-v1 to
  // themselves; it is only read here.
  const roots = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath);
  const workspace = historyWorkspace(roots, remoteAuthorityName());
  if (workspace.kind !== 'physical') throw new Error('no workspace folder is open');
  const directory = path.join(storageRoot, 'checkpoints', 'raw-v2', workspace.workspaceId);
  const identity = await hostProcessIdentity(storageRoot);
  const hosts = new HostRegistry(path.join(directory, 'hosts'), { hostInstanceId, selfIdentity: identity.self, identity: identity.adapter });
  await hosts.publishSelf();
  const { store, reconciliation } = await RawCheckpointStore.open({
    directory,
    workspaceId: workspace.workspaceId,
    coordination: {
      lease: new GenerationLease(path.join(directory, 'lock'), { hostInstanceId, selfIdentity: identity.self, identity: identity.adapter }),
      hostInstanceId,
      hostsGone: (ids) => hosts.hostsGone(ids),
    },
    onRemoved: (ids) => {
      if (checkpointStore.dropRaw(ids)) {
        scheduleCheckpointSave();
      }
    },
  });
  if (reconciliation.unavailable) {
    outputChannel.warn(`[checkpoints] exact-byte restore points cannot be kept: ${reconciliation.unavailable}`);
  } else {
    // Restore points the records name that are still only in raw-v1 are copied here once, verified, under their ids.
    const legacy = rawCheckpointLocation(storageRoot, root);
    const missing = checkpointStore.rawIds().filter((id) => !store.get(id));
    if (missing.length > 0) {
      const imported = await store.importLegacyEntries(legacy, missing);
      if (imported.length > 0) outputChannel.info(`[checkpoints] ${imported.length} restore point(s) of an earlier version were copied into the shared store.`);
    }
    const kept = new Set(store.list().map((entry) => entry.id));
    if (checkpointStore.dropRaw(checkpointStore.rawIds().filter((id) => !kept.has(id)))) {
      scheduleCheckpointSave();
    }
    const leftovers = reconciliation.removedStaging + reconciliation.removedOrphans + reconciliation.droppedMissing;
    if (leftovers > 0) {
      outputChannel.info(`[checkpoints] reconciled ${leftovers} leftover restore-point file(s) of an interrupted write.`);
    }
  }
  store.attachPeer(checkpointStore);
  checkpointStore.attachPeer(store);
  // v0.9.110 H1: favourite tasks' restore points are held again for the history (and released ones let go).
  void taskHistory?.syncProtection();
  return store;
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
    await vscode.workspace.getConfiguration('unode').update('concurrencyStrategy', 'optimistic', vscode.ConfigurationTarget.Global);
    void showResultNotice('information', 'UnodeAi: switched to Optimistic concurrency (shared workspace). It applies to each agent’s next turn.');
  } else if (choice === INIT) {
    await initGitRepoForWorktree();
  }
}

/** Sync the `unode.worktreeMode` context key so the Team title bar shows the right concurrency icon. */
function syncConcurrencyContext(): void {
  const worktree = configuredSetting<string>('concurrencyStrategy', 'optimistic') === 'worktree';
  void vscode.commands.executeCommand('setContext', 'unode.worktreeMode', worktree);
}

/** Cheap "is the workspace a git repo" check (no WorktreeManager instance needed) for the mode toggle. */
function isWorkspaceGitRepo(): Promise<boolean> {
  return new Promise((resolve) => {
    let git: string;
    try {
      git = resolveHostProgram('git');
    } catch {
      resolve(false);
      return;
    }
    const p = cpSpawn(git, ['rev-parse', '--is-inside-work-tree'], hostNativeSpawnOptions(workspaceRoot()));
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

/** One-click `git init` + a safe .gitignore for the workspace, so worktree mode can engage. Deliberately
 *  does NOT auto-commit — the user reviews what to stage (avoids committing secrets/large files). */
async function initGitRepoForWorktree(): Promise<void> {
  const root = workspaceRoot();
  const runGit = (args: string[]) => new Promise<void>((resolve, reject) => {
    const p = cpSpawn(resolveHostProgram('git'), args, { cwd: root, shell: false });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} exited ${code}`))));
  });
  try {
    const gi = path.join(root, '.gitignore');
    try { await fs.access(gi); } catch { await fs.writeFile(gi, 'node_modules/\n.unode/\n.env\n*.log\n', 'utf8'); }
    await runGit(['init']);
    void showResultNotice('information', `UnodeAi: initialized a git repo at ${root} and added a .gitignore. Review the changes, then commit ` +
        `(git add -A && git commit -m "init") — worktree isolation engages once the tree has a commit.`);
  } catch (e) {
    void showResultNotice('warning', `UnodeAi: couldn't run git init (${e instanceof Error ? e.message : String(e)}). Make sure git is installed, then run 'git init' + commit in a terminal.`);
  }
}

function makeWorktreeCoordinator(): WorktreeCoordinator | undefined {
  const root = firstWorkspaceRoot();
  if (!root) { return undefined; }
  const coordinator: WorktreeCoordinator = new WorktreeCoordinator({
    manager: new WorktreeManager(root),
    orchestrator: new GitMergeOrchestrator(root),
    isEnabled: () => configuredSetting<string>('concurrencyStrategy', 'optimistic') === 'worktree',
    autoMerge: () => configuredSetting<boolean>('worktree.autoMerge', false),
    maxParallel: () => configuredSetting<number>('worktree.maxParallel', 4),
    // The delegating PM and solo agents stay on the live shared tree (the PM must see real state to
    // coordinate; solo has no teammates to isolate from).
    isEligible: (config) => !canDelegate(config) && config.role !== 'solo',
    log: (m) => outputChannel.info(`[worktree] ${m}`),
    onNonGitRepo: () => void warnWorktreeNeedsGit(),
    notifyAgent: (agentId, message) =>
      messageBus.send('user', agentId, 'ask.question', { instruction: message, mode: 'act' }, 'normal'),
    verifyTyped: (wt, owner) => runWorktreeVerification(root, wt, owner),
    revision: async wt => {
      const result = await runGitIn(wt.path, ['rev-parse', 'HEAD']);
      return result.code === 0 && /^[0-9a-f]{40}$/i.test(result.stdout.trim()) ? result.stdout.trim() : undefined;
    },
    laneIsClean: async wt => {
      const result = await runGitIn(wt.path, ['status', '--porcelain']);
      return result.code === 0 && result.stdout.trim() === '';
    },
    withManualMergeAdmission: (wt, operation) => sessionManager.withIdleLaneWork(wt.agentId!, isCurrent => operation(() =>
      isCurrent() && worktreeCoordinator === coordinator && firstWorkspaceRoot() === root && vscode.workspace.isTrusted
      && configuredSetting<string>('concurrencyStrategy', 'optimistic') === 'worktree')),
    // v0.7.0 anti-cheat: surface a passing lane that also edited the tests (review-board flag).
    changedFiles: (wt) => changedFilesInWorktree(wt.path),
    // v0.9.99: a lane whose check could not run, or whose outcome is unknown, merges into integration marked
    // unverified unless the team's policy explicitly requires the check. Never finalized to base automatically.
    unverifiedMergeAdmission: (wt, owner) => worktreeUnverifiedMergeAdmission(root, wt, owner, () => worktreeCoordinator === coordinator),
    notifyUser: notifyUnverifiedWorktreeMerge,
  });
  return coordinator;
}

/**
 * The declared direct shell for unattended verification (the worktree gate and the completion gate). The verify
 * command is a shell command, so it must not run in an untrusted workspace (Workspace Trust).
 */
function verificationPreparer(): PreparedDirectCommand | CommandPreparationFailure {
  if (!vscode.workspace.isTrusted) {
    return {
      ok: false,
      reason: 'shell-compatibility',
      message: 'Verification skipped: this workspace is not trusted, so the verify command was not run. Trust the workspace (Workspace Trust) to enable it.',
    };
  }
  return directCommandPreparer();
}

/** A HARD timeout: the gate is serialized with merges/finalize, so a watch-mode or input-waiting verify command
 *  must never hang the chain. On timeout the whole tree is stopped and observed, and the run fails. */
function verifyTimeoutMs(): number {
  return Math.max(10, configuredSetting<number>('worktree.verifyTimeoutSeconds', 300)) * 1000;
}

/**
 * After a finalize advances the base ref (via update-ref, which doesn't touch the work tree), bring
 * the user's checkout up to it — but only when the tree is clean, so we never clobber their edits.
 */
/** Run git in a given directory. Best-effort: resolves with code/stdout, never throws. */
function runGitIn(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let git: string;
    try {
      git = resolveHostProgram('git');
    } catch {
      resolve({ code: -1, stdout: '' });
      return;
    }
    const p = cpSpawn(git, args, { cwd, shell: false });
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
    void showResultNotice('information', `No changes to show for ${agentName}.`);
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
    const manualHead = wt.agentId ? worktreeCoordinator?.manualLanding(wt.agentId) : undefined;
    const laneHead = manualHead ? await runGitIn(wt.path, ['rev-parse', 'HEAD']) : undefined;
    const agentId = wt.agentId ?? wt.branch;
    lanes.push({
      agentId,
      agent: wt.agentId ? (sessionManager.get(wt.agentId)?.config.name ?? worktreeCoordinator?.agentName(wt.agentId) ?? wt.agentId) : wt.branch,
      branch: wt.branch,
      path: wt.path,
      mergedUnverifiedHead: laneHead?.code === 0 && laneHead.stdout.trim() === manualHead ? manualHead : undefined,
      // v0.7.0 verifier-as-gate: per-lane status for the review board (✓ verified / ✗ failing / ⚠ unverified),
      // plus any test files a passing change also touched (anti-cheat flag).
      verification: v ? { status: v.status, command: v.command, output: v.output, touchedTests: v.touchedTests,
        blocked: v.blocked, observation: parseCompletionCheckObservation(v.check) } : undefined,
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

/**
 * v0.9.103 §3.8: whether the composer may promise that a message sent while the agent works steers it. A route whose
 * steering needs its process's confirmation promises it only after that process confirmed it.
 */
function agentCanSteer(capabilities: { steer: boolean; steerConfirmation?: 'observed' } | undefined, steerConfirmed: boolean | undefined): boolean {
  return capabilities?.steer === true && (capabilities.steerConfirmation !== 'observed' || steerConfirmed === true);
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

/**
 * Cross-provider brief consent. By default the brief goes without a dialog — `unode.allowCrossProviderDispatchWithoutApproval`,
 * an Owner decision in v0.9.79, because the modal appeared on every cross-provider delegation. With the setting off,
 * every cross-destination dispatch needs an explicit visible choice and nothing is cached. Either way an unresolvable
 * destination refuses: the setting skips a dialog, never resolution.
 */
async function approveCoordinatorBriefEgress(
  coordinator: AgentConfig,
  target: AgentConfig,
): Promise<{ allowed: boolean; reason?: string }> {
  const source = coordinatorBriefDestination(coordinator);
  const destination = coordinatorBriefDestination(target);
  const decision = decideCoordinatorBriefConsent({
    sourceKey: source?.key,
    destinationKey: destination?.key,
    // `=== true`: a malformed hand-edited value falls toward asking, not toward silence.
    allowCrossProviderWithoutApproval: configuredSetting(
      ALLOW_CROSS_PROVIDER_DISPATCH_SETTING,
      ALLOW_CROSS_PROVIDER_DISPATCH_DEFAULT,
    ) === true,
  });
  if (decision.kind === 'refuse') return { allowed: false, reason: decision.reason };
  if (decision.kind === 'allow') {
    if (decision.basis === 'user-setting') {
      // Nobody clicked anything for this send, so leave a record of why it went and where.
      outputChannel.info(
        `[coordinator brief] sent to ${target.name}'s model destination (${destination?.host ?? 'unknown host'}) `
        + `without a per-dispatch dialog: unode.${ALLOW_CROSS_PROVIDER_DISPATCH_SETTING} is on.`
      );
    }
    return { allowed: true };
  }
  const SEND = 'Send brief';
  const DONT_SEND = 'Do not send';
  const choice = await blockingPrompt(attentionAppearance('coordinator-brief'), () => vscode.window.showWarningMessage(
    `UnodeAi is about to send a coordinator-authored brief, which may contain user-derived information, `
      + `to ${target.name}'s model destination (${destination?.host ?? 'unknown host'}). This approval applies only to this dispatch.`,
    { modal: true },
    DONT_SEND,
    SEND,
    // Raised inside the coordinator's dispatch_task call: the wait is the person's, not that tool's.
  ), pausingTurnClock({ agentId: coordinator.id, sessionId: coordinator.id }));
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
  const { startedAtMs: approvalStartedAt, outcome } = await timedApproval(origin, () => brokeredApproval(
    { kind: 'tool', agentName, toolName: request.toolName, toolDetail: request.detail, ...origin },
    request.timeoutMs ?? HUMAN_APPROVAL_WINDOW_MS,
    () => nativeClaudeToolApprovalChoice(agentName, request),
  ));
  // v0.9.101: the tool's name, and nothing of its arguments or content, says afterwards which card this was.
  recordBrokeredApproval(origin, approvalStartedAt, outcome, 'tool-approval', toolApprovalLabel(request.toolName));
  // "Always allow this tool" is remembered by the backend: only a contemporaneous human decision may say it.
  const human = outcome.settledBy === 'human';
  return {
    allow: human && (outcome.action === 'once' || outcome.action === 'always'),
    remember: human && outcome.action === 'always',
    note: !human || outcome.action === 'deny' ? outcome.note?.trim() || undefined : undefined,
  };
}

/** Codex App Server approvals are deliberately single-use and webview-only. Closing the approval surface,
 * timing out, or returning an unfamiliar action all decline; no command/path parsing can create a grant. */
async function requestCodexApproval(
  agentName: string,
  request: CodexApprovalRequest,
  origin: { agentId?: string; sessionId?: string } = {},
  lasting: { grantFolder?: (folder: string) => Promise<boolean>; allowNetwork?: (expected: number) => number | undefined } = {},
): Promise<CodexApprovalDecision> {
  if (chatViewProvider?.canPromptApproval() !== true) return { allow: false };
  const { startedAtMs: approvalStartedAt, outcome: resolution } = await timedApproval(origin, () => chatViewProvider!.requestApproval(
    codexApprovalPresentation(agentName, request, origin),
    request.timeoutMs,
  ));
  recordBrokeredApproval(origin, approvalStartedAt, resolution,
    request.kind === 'command' ? 'command-approval' : request.kind === 'file-change' ? 'write-approval' : 'tool-approval');
  const human = resolution.settledBy === 'human';
  const noteOrigin = human ? 'human' as const : 'host' as const;
  // v0.9.102 (R2): a lasting choice is put in place first; the command runs only if it succeeded, and only the option
  // the card offered counts.
  if (human && resolution.action === 'grant-folder' && request.grantFolder && lasting.grantFolder) {
    const granted = await lasting.grantFolder(request.grantFolder).catch(() => false);
    return granted
      ? { allow: true, noteOrigin, granted: { kind: 'folder', folder: request.grantFolder } }
      : { allow: false, note: 'The folder could not be granted, so the command was not run.', noteOrigin: 'host', lastingFailed: true };
  }
  if (human && resolution.action === 'allow-network' && request.offerNetwork && lasting.allowNetwork
    && typeof request.networkRevision === 'number') {
    const revision = lasting.allowNetwork(request.networkRevision);
    return revision === undefined
      ? { allow: false, note: 'Network for this agent changed while the card was open, so nothing was changed or run.', noteOrigin: 'host', lastingFailed: true }
      : { allow: true, noteOrigin, granted: { kind: 'network', revision } };
  }
  // v0.9.105 (D5-1): a lasting Computer Use choice counts only when the card offered it; Codex keeps it, not UnodeAi.
  if (human && request.kind === 'computer-use' && request.computerUse) {
    const persist = resolution.action === 'computer-use-session' ? 'session' as const
      : resolution.action === 'computer-use-always' ? 'always' as const : undefined;
    if (persist && request.computerUse.persist.includes(persist)) return { allow: true, noteOrigin, persist };
  }
  return {
    allow: human && resolution.action === 'once',
    note: resolution.action === 'deny' ? resolution.note?.trim() || undefined : undefined,
    noteOrigin,
  };
}

/** Executable Skills are trusted local code. Approval is always webview-only, run-once, and bound to
 * the full validated tree digest; there is deliberately no session/project persistence option. */
async function requestExecutableSkillApproval(
  request: ExecutableSkillApprovalRequest,
  origin: { agentId?: string; sessionId?: string } = {},
): Promise<{ allow: boolean; note?: string }> {
  if (chatViewProvider?.canPromptApproval() !== true) return { allow: false, note: 'No interactive approval surface is available.' };
  const detail = [
    request.actionDescription,
    `Skill: ${request.skillName}`,
    `Action: ${request.actionId}`,
    `Compiled handler: ${request.handler}`,
    `Declared effects: ${request.declaredEffects.join(', ') || 'none'}`,
    `Exact content digest: sha256:${request.digest}`,
    request.warning,
  ].join('\n\n');
  const { startedAtMs: approvalStartedAt, outcome: resolution } = await timedApproval(origin, () => chatViewProvider!.requestApproval({
    kind: 'tool',
    agentName: request.agentName,
    toolName: `Executable Skill: ${request.skillName}/${request.actionId}`,
    toolDetail: detail,
    warning: request.warning,
    singleUseOnly: true,
    ...origin,
  }, request.timeoutMs));
  recordBrokeredApproval(origin, approvalStartedAt, resolution, 'tool-approval');
  return {
    allow: resolution.settledBy === 'human' && resolution.action === 'once',
    note: resolution.action === 'deny' ? resolution.note?.trim() || undefined : undefined,
  };
}

/**
 * One route-neutral public-web approval. The wording and the explicit session action are deliberately
 * crew-wide: WebSearch/WebFetch/fetch_url may all perform egress, including through a URL itself.
 */
async function requestWebAccessApproval(request: WebAccessApprovalRequest): Promise<WebAccessDecision> {
  const paid = request.paidSearch;
  const discount = paid ? unodeSearchDiscountNote() : undefined;
  const destination = request.url ? `Requested URL: ${request.url}`
    : request.purpose ? `Requested action: ${request.purpose.slice(0, 600)}` : 'Requested action: public web search.';
  const detail = [
    destination,
    ...(paid ? [
      `Recipient: ${paid.destination}.`,
      `Search charge: ${paid.unitPrice}. ${discount ? discount + ' ' : ''}Up to ${paid.searchesPerCall} searches per call and ${paid.callsPerTurn} calls per member turn. Token charges are separate.`,
      'Allow for this session applies to paid Unode search in this VS Code session.',
    ] : [
      'Public web access is egress. A fetched URL can itself carry data.',
      'Allowing this session grants web access to all current and later crew agents for this VS Code session only.',
    ]),
  ].join('\n\n');
  const { startedAtMs: approvalStartedAt, outcome } = await timedApproval(request, () => {
    const opened = openBrokeredApproval({
      kind: 'tool',
      agentName: request.agentName,
      toolName: paid ? 'Paid web search' : 'Web access',
      toolDetail: detail,
      ...(paid ? { paidSessionWebSearch: true } : { crewSessionWebAccess: true }),
      agentId: request.agentId,
      sessionId: request.sessionId,
    }, WEB_ACCESS_HUMAN_WINDOW_MS, () => nativeWebAccessApprovalChoice(request.agentName, detail, !!paid));
    if (!paid) openWebApprovalId = opened.approvalId;
    return opened.outcome;
  });
  return webAccessDecisionOf(request, approvalStartedAt, outcome);
}

/** A concurrent public-web request waits on the prompt already open, as its own participant. */
function joinWebAccessApproval(request: WebAccessApprovalRequest): Promise<WebAccessDecision> | undefined {
  if (!openWebApprovalId || !approvalBroker.isOpen(openWebApprovalId)) {
    return undefined;
  }
  const joined = approvalBroker.join(openWebApprovalId, request.sessionId ?? request.agentId ?? request.agentName);
  if (!joined) return undefined;
  return timedApproval(request, () => joined)
    .then(({ startedAtMs, outcome }) => webAccessDecisionOf(request, startedAtMs, outcome));
}

function webAccessDecisionOf(
  request: WebAccessApprovalRequest,
  approvalStartedAt: number,
  outcome: ParticipantOutcome,
): WebAccessDecision {
  recordBrokeredApproval({ agentId: request.agentId, sessionId: request.sessionId }, approvalStartedAt, outcome, 'web-access-approval');
  // The crew-wide session grant is only ever a contemporaneous human decision.
  const human = outcome.settledBy === 'human';
  const allow = human && (outcome.action === 'once' || outcome.action === 'always');
  return {
    allow,
    remember: human && outcome.action === 'always',
    reason: allow ? undefined : outcome.note?.trim() || 'The user did not approve public web access.',
  };
}

/**
 * Show an approval as a chat card when a chat surface exists, otherwise as a native modal; either way the
 * broker settles it once, owns its deadline, and drops any later answer before it reaches a side effect.
 */
function openBrokeredApproval(
  request: Omit<ApprovalRequest, 'id'>,
  timeoutMs: number,
  showModal: () => Promise<{ action: string; note?: string }>,
): { approvalId: string; outcome: Promise<ParticipantOutcome> } {
  return chatViewProvider?.canPromptApproval() === true
    ? chatViewProvider.openApproval(request, timeoutMs)
    : approvalBroker.openModal(request, timeoutMs, showModal, localApproverIdentity());
}

function brokeredApproval(
  request: Omit<ApprovalRequest, 'id'>,
  timeoutMs: number,
  showModal: () => Promise<{ action: string; note?: string }>,
): Promise<ParticipantOutcome> {
  return openBrokeredApproval(request, timeoutMs, showModal).outcome;
}

const OPEN_CHAT_FOR_REQUEST_LIMIT = 'Open Chat';

/**
 * v0.9.94: the decision card of a reached request limit, on the approval surface of Chat. There is no native
 * dialog behind it: a card can be closed when the wait ends, a dialog cannot. With no chat container on screen
 * the card waits in the queue, and a notice with one action leads to it.
 *
 * The card pauses no turn clock itself. Every boundary held for the decision already pauses the clock of the
 * agent it holds, and the card belongs to a conversation, not to one agent's turn. Its outcome is not a
 * permission decision and is recorded as none.
 */
function openRequestLimitCard(card: RequestLimitCard): OpenRequestLimitCard {
  return showRequestLimitCard(chatViewProvider, card, () => {
    void vscode.window.showWarningMessage(
      'UnodeAi: a request reached a limit you set. Its Stop or Continue decision is waiting in Chat. '
      + 'With no answer the request is stopped.',
      OPEN_CHAT_FOR_REQUEST_LIMIT,
    ).then((choice) => {
      if (choice === OPEN_CHAT_FOR_REQUEST_LIMIT) chatViewProvider?.focusPendingApproval(card.agent?.id);
    }, () => undefined);
  });
}

/**
 * Record one participant's outcome. A withdrawn prompt (the agent was stopped) is not a decision anyone
 * made: its wait still counts for the turn's timing, but no permission decision is recorded.
 */
function recordBrokeredApproval(
  origin: { agentId?: string; sessionId?: string },
  startedAtMs: number,
  outcome: ParticipantOutcome,
  kind: RunPermissionKind,
  label?: string,
): void {
  if (outcome.settledBy === 'withdrawn') {
    sessionManager.recordApprovalOutcome(origin.sessionId ?? origin.agentId, Date.now() - startedAtMs, true);
    return;
  }
  recordApprovalMetric(origin, startedAtMs, approvalMetricDecision(outcome.action, outcome.expired), kind, outcome.approverId, label);
}

async function nativeWebAccessApprovalChoice(agentName: string, detail: string, paid = false): Promise<{ action: string; note?: string }> {
  const ONCE = 'Allow this request';
  const ALWAYS = paid ? 'Allow paid search this session' : 'Allow crew web access this session';
  const DENY = 'Deny';
  const choice = await vscode.window.showWarningMessage(
    `${agentName} ${paid ? 'wants to run paid web search' : 'wants to access the public web'}.\n\n${detail}`,
    { modal: true },
    DENY,
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
  const DENY = 'Deny';
  const DENY_NOTE = 'Deny with note…';
  const choice = await vscode.window.showWarningMessage(
    `${agentName} wants to use Claude ${request.toolName}:\n\n${request.detail}`,
    { modal: true },
    DENY,
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
  if (!isPathStrictlyInside(root, absolutePath)) {
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

function editorFirstWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** The root captured at activation. v0.9.99: a first-folder change does not move it; a reload switches it. */
let taskHistoryController: TaskHistoryController | undefined;

/** v0.9.110 H1: the host side of the Workbench's Task history view, over this window's history and chat. */
function taskHistoryHost(): TaskHistoryController | undefined {
  if (!taskHistory) return undefined;
  taskHistoryController ??= new TaskHistoryController({
    history: taskHistory,
    members: () => sessionManager.getAll().map((session) => ({ id: session.config.id, name: session.config.name })),
    selectedMember: () => chatViewProvider?.getSelectedAgentId() || undefined,
    insertIntoComposer: (agentId, text) => chatViewProvider?.insertIntoComposer(agentId, text) ?? false,
    pickMember: async (members) => (await vscode.window.showQuickPick(members.map((member) => ({ label: member.name, id: member.id })),
      { title: 'Who should continue this task? The draft goes into that member\'s message box; nothing is sent.' }))?.id,
    confirm: (title, detail) => confirmTaskHistoryDeletion(title, detail),
    post: (message) => chatViewProvider?.postTaskHistory(message),
    checks: (agentId, outcomeRefs) => {
      for (const ref of outcomeRefs) {
        const record = requestCloseoutStore?.get(agentId, ref as RequestCloseoutRecordV1['recordId']);
        if (record) return record.observations.checks;
      }
      return undefined;
    },
  });
  return taskHistoryController;
}

/** v0.9.110 H1: Task history opens in the Workbench. */
function openTaskHistoryPanel(): void {
  chatViewProvider?.openTaskHistory();
}

/** v0.9.110 H1: the person confirms a deletion they started in Task history, told what it removes. */
async function confirmTaskHistoryDeletion(title: string, detail: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, "Don't delete", 'Delete');
  return choice === 'Delete';
}

/** v0.9.110 H1: hold exactly these restore points for favourite tasks; release the history's other favourite holds. */
async function holdFavouriteRestorePoints(ids: ReadonlySet<string>): Promise<void> {
  const opened = await preChangeCheckpoints?.store();
  if (!opened || 'unavailable' in opened) return;
  const held = new Set(opened.store.durablyHeld('favourite'));
  for (const id of held) if (!ids.has(id)) await opened.store.holdDurably(id, 'favourite', false);
  for (const id of ids) if (!held.has(id)) await opened.store.holdDurably(id, 'favourite', true);
}

/** v0.9.110: let go of what these finished recovery operations hold (`history:<operation>`) for Undo/Redo revert. */
async function releaseRecoveryOperationHolds(operationIds: readonly string[]): Promise<void> {
  if (operationIds.length === 0) return;
  const opened = await preChangeCheckpoints?.store();
  if (!opened || 'unavailable' in opened) return;
  // As the shared index holds them now: another window may have written these holds.
  const wanted = new Set(operationIds.map((operationId) => `history:${operationId}`));
  for (const entry of await opened.store.listCurrent()) {
    for (const owner of entry.pins ?? []) if (wanted.has(owner)) await opened.store.unpinNamed(entry.id, owner);
  }
}

/**
 * v0.9.110: before the person's deletion of these restore points, let go of what finished recovery operations hold of
 * them. Any other hold stays (an operation still running, in this window or another, or one not recorded yet), and its
 * restore point is reported in use. The favourites' hold is the history's own and is updated separately.
 */
async function releaseRecoveryHoldsOn(ids: readonly string[], finished: ReadonlySet<string>): Promise<void> {
  const opened = await preChangeCheckpoints?.store();
  if (!opened || 'unavailable' in opened) return;
  const wanted = new Set(ids);
  for (const entry of await opened.store.listCurrent()) {
    if (!wanted.has(entry.id)) continue;
    const id = entry.id;
    for (const owner of entry.pins ?? []) {
      const operationId = owner.startsWith('history:') ? owner.slice('history:'.length) : '';
      if (!finished.has(operationId)) continue;
      await opened.store.unpinNamed(id, owner);
    }
  }
}

/** v0.9.110 H1: this workspace's older raw directory (raw-v1), whose restore points raw-v2 takes in under the same ids. */
function legacyRawLocation(): { directory: string; workspaceId: string } | undefined {
  const storageRoot = extensionContext?.globalStorageUri?.fsPath;
  const root = firstWorkspaceRoot();
  return storageRoot && root ? rawCheckpointLocation(storageRoot, root) : undefined;
}

/**
 * v0.9.110 H1: remove the restore points of deleted tasks, and say what is on disk afterwards. In raw-v2: one still
 * pinned by running work stays and is reported kept; one whose bytes could not be removed is reported failed. The same
 * ids in raw-v1 are copies of this workspace's own older restore points: their payload files go too (raw-v1's index is
 * left for its own reconciliation), and one that stays is reported failed. Only what is gone from both is removed.
 */
/**
 * v0.9.110 (Delete all): the Edit history's records, with their text copies, and the archived chats of this workspace
 * go with the history. A record stays only while its work runs or its exact restore point is still in use.
 */
async function deleteLocalCopiesOfWork(): Promise<{ editHistoryRecords: number; archivedChats: number }> {
  const opened = await preChangeCheckpoints?.store();
  const store = opened && !('unavailable' in opened) ? opened.store : undefined;
  const editHistoryRecords = checkpointStore.removeUnless((item) =>
    (!!item.request && (sessionManager?.requestRunning(item.request.id) ?? false))
    || (!!item.raw && !!store?.get(item.raw.id)));
  // Written now and awaited, not after the usual pause: the report says it is done only once it is stored. Written on
  // every Delete all, so deleting again also stores a removal whose earlier write failed.
  if (checkpointSaveTimer) { clearTimeout(checkpointSaveTimer); checkpointSaveTimer = undefined; }
  await persistence.saveCheckpointsSettled(checkpointStore.serialize());
  if (editHistoryRecords > 0) chatViewProvider?.refreshChangedFiles();
  const archivedChats = await (chatViewProvider?.deleteAllArchivedChats() ?? Promise.resolve(0));
  return { editHistoryRecords, archivedChats };
}

async function removeHistoryRestorePoints(ids: readonly string[]): Promise<{ removed: string[]; kept: string[]; failed: string[] }> {
  const opened = await preChangeCheckpoints?.store();
  if (!opened || 'unavailable' in opened) return { removed: [], kept: [], failed: [...ids] };
  // v0.9.110: requests that have ended let go of their restore points now, not at the next change: only running work
  // keeps one from this deletion.
  preChangeCheckpoints?.releaseEndedRequests();
  const legacy = legacyRawLocation();
  const removed: string[] = [];
  const kept: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    const outcome = await opened.store.purge(id);
    if (outcome === 'in-use') { kept.push(id); continue; }
    const legacyGone = !legacy || await RawCheckpointStore.removeEntryBytes(legacy, id);
    (outcome === 'removed' && legacyGone ? removed : failed).push(id);
  }
  return { removed, kept, failed };
}

/**
 * v0.9.110 H1 (Delete all): every restore point of this workspace, in raw-v2 and in its older raw-v1 directory. When
 * the raw-v1 directory is there but cannot be inspected, what raw-v2 holds is still listed, and `unlisted` says what
 * stays on disk.
 */
async function workspaceRestorePoints(): Promise<{ points: Array<{ ref: string; path: string }>; unlisted?: string }> {
  const found = new Map<string, string>();
  const opened = await preChangeCheckpoints?.store();
  if (!opened || 'unavailable' in opened) throw new Error('the restore points of this workspace are not available');
  for (const entry of await opened.store.listCurrent()) found.set(entry.id, entry.path);
  const legacy = legacyRawLocation();
  let unlisted: string | undefined;
  try {
    for (const entry of legacy ? await RawCheckpointStore.readEntries(legacy) : []) if (!found.has(entry.id)) found.set(entry.id, entry.path);
  } catch (error) {
    unlisted = `the older restore points of this workspace could not be read, so any there stay on disk (${(error as Error).message.replace(/\.$/, '')})`;
  }
  return { points: [...found].map(([ref, filePath]) => ({ ref, path: filePath })), ...(unlisted ? { unlisted } : {}) };
}

/**
 * v0.9.110 (H0): the task history of the folders open now, under the extension's own storage (never in the
 * repository). Keyed by the whole set of physical roots and the remote authority; a window without a folder gets a
 * history that can be read but never restores anything.
 */
async function openTaskHistory(storageRoot: string | undefined): Promise<HistoryStore | undefined> {
  if (!storageRoot) return undefined;
  const roots = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath);
  const workspace = historyWorkspace(roots, remoteAuthorityName());
  const identity = await hostProcessIdentity(storageRoot);
  return HistoryStore.open({
    directory: path.join(storageRoot, 'history', 'v1', workspace.workspaceId),
    workspaceId: workspace.workspaceId,
    writerId: hostInstanceId,
    identity: identity.adapter,
    // The same file under two spellings is one file where the platform compares paths that way, as for file writes.
    physicalKey: (physical) => targetKey(physical),
    isRequestRunning: (requestId) => sessionManager.requestRootAgent(requestId) !== undefined,
    log: (line) => outputChannel.info(`[history] ${line}`),
  });
}

function firstWorkspaceRoot(): string | undefined {
  return workspaceBinding.root();
}

/** The activation-time root as a folder URI, for project files and folder-scoped settings. */
function boundRootUri(): vscode.Uri | undefined {
  const root = firstWorkspaceRoot();
  return root === undefined ? undefined : vscode.Uri.file(root);
}

/** Resolve programs UnodeAi itself chose without allowing a workspace-local executable to shadow PATH. */
/**
 * An agent's session ended while background commands of it could not be confirmed stopped. The session is gone, so
 * no chat turn carries this: the output channel and a warning say so. Command text stays in the log only.
 */
function reportUnconfirmedBackgroundStops(agentName: string, stops: readonly { id: string; command: string; detail: string }[]): void {
  for (const stop of stops) {
    outputChannel.warn(`[commands] ${agentName}: background command ${stop.id} (${stop.command.slice(0, 200)}) may still be running; its stop could not be confirmed (${stop.detail}).`);
  }
  // While the host shuts down every stop is sent without being observed, so a warning would say only that, at every
  // reload. The output channel keeps the record.
  if (hostShutdown.started) return;
  const ids = stops.map((stop) => stop.id).join(', ');
  void vscode.window.showWarningMessage(
    `UnodeAi could not confirm that ${stops.length === 1 ? 'a background command' : `${stops.length} background commands`} of ${agentName} stopped (${ids}). `
      + 'It may still be running. Check your running processes; the UnodeAi output channel names the command.',
  );
}

function resolveHostProgram(command: string): string {
  const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  const worktreeRoots = workspaceRoots.map((root) => path.join(root, WORKTREES_DIR));
  return resolveHostExecutable(command, { workspaceRoots, worktreeRoots });
}

/** v0.9.97: the one action a failed chat file navigation offers. Copying the reference as written changes nothing. */
const COPY_REFERENCE_PATH = 'Copy reference path';
/** v0.9.108 (L1): VS Code's words for revealing a file on this platform (File Explorer, Finder, or its folder). */
const REVEAL_IN_OS = revealInOsLabel(process.platform);
const OPEN_EXPORTED_PDF = 'Open PDF';

/**
 * v0.9.108 (L1): the person's Export PDF of a DOCX/PPTX the chat's navigation boundary has just checked. It is an
 * operation of its own (personOfficeExport): its own host tools, with the shown agent's authority as it is now and the
 * mode the chat shows now, and none of a running request's state, so that request goes on undisturbed. The export path
 * is the model's (inspect_office, then export_pdf), so Commands, trust, file access, the native restrictions, the
 * command approval to start the application and the file-write approval all apply; nothing is bypassed. The PDF goes
 * beside its source with the source's name. Resolves with why it did not start, or once it started: a cancellable
 * progress notification follows the export, and its outcome is shown when it ends.
 */
async function exportFilePdfForPerson(agentId: string, sourcePath: string): Promise<{ refused: string } | undefined> {
  const agentName = sessionManager.get(agentId)?.config.name ?? 'This agent';
  const refusal = personPdfExportRefusal({ platform: process.platform, sourcePath, agentName,
    plan: chatViewProvider?.getAgentMode(agentId) === 'plan' });
  if (refusal) return { refused: refusal };
  const ports = agentPersonPdfExports.get(agentId)?.();
  const sourceName = path.basename(sourcePath);
  if (!ports) {
    // The ports are built when the member first starts in this window (createBackend), so a member not started since
    // a reload has none. That is not a permission: only the wording here reads its state, to name the Team view's step.
    return { refused: personPdfExportNotReady(sessionManager.get(agentId)?.status, agentName, sourcePath) };
  }
  const destination = pdfExportDestination(sourcePath);
  void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exporting ${sourceName} to PDF`, cancellable: true },
    async (_progress, token) => {
      const stop = new AbortController();
      const listener = token.onCancellationRequested(() => stop.abort());
      try {
        const shown = personPdfExportResult(await runPersonPdfExport(ports, sourcePath, destination, stop.signal), sourceName, agentName);
        if (!shown.saved) {
          void showResultNotice('warning', shown.message);
          return;
        }
        // The saved PDF opens or is revealed through the same checked navigation as any file of this agent.
        void vscode.window.showInformationMessage(shown.message, OPEN_EXPORTED_PDF, REVEAL_IN_OS).then((choice) => {
          if (choice === OPEN_EXPORTED_PDF) void orchestrationHost.openRecordedWorkspaceFile(agentId, destination);
          if (choice === REVEAL_IN_OS) void orchestrationHost.openRecordedWorkspaceFile(agentId, destination, undefined, 'reveal');
        });
      } catch (error) {
        void showResultNotice('warning', `PDF export of ${sourceName} did not finish: ${error instanceof Error ? error.message : String(error)}. Nothing is confirmed saved.`);
      } finally {
        listener.dispose();
      }
    });
  return undefined;
}

/** v0.9.99: the empty host-owned temporary folder an agent is rooted in when no folder is open. */
let folderlessRoot: string | undefined;
let folderlessNoticeShown = false;
function folderlessChatRoot(): string {
  if (!folderlessNoticeShown) {
    folderlessNoticeShown = true;
    void vscode.window.showInformationMessage(FOLDERLESS_CHAT_NOTICE);
  }
  folderlessRoot ??= mkdtempSync(path.join(tmpdir(), 'unodeai-chat-'));
  return folderlessRoot;
}

function workspaceRoot(): string {
  const root = firstWorkspaceRoot();
  if (!root) {
    throw new Error('Open a workspace folder before using this UnodeAi action.');
  }
  return root;
}

/** Same host-owned resolution used by the backend; repository and VS Code settings are not inputs. */
function codexPermissionForAgent(config: AgentConfig, mode: 'plan' | 'act' = 'act') {
  const primaryRoot = config.workingDirectory || workspaceRoot();
  const roots = resolveEffectiveRoots({
    grants: config.folderAccess,
    fallbackPrimaryRoot: primaryRoot,
    fallbackReadRoots: [primaryRoot],
    workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    isTrusted: vscode.workspace.isTrusted,
  });
  return resolveCodexPermissionProfile({
    configured: autonomyForAgent(config, mode).codexProfile,
    mode,
    trusted: vscode.workspace.isTrusted,
    restricted: roots.restricted,
    writeRoots: writeRootsForTrust(roots.writeRoots, vscode.workspace.isTrusted),
    allowedTools: config.allowedTools,
    toolCeiling: config.toolCeiling,
  });
}

function sameWorkspaceRoot(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return left === right;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

async function showWorkspaceBindingRequired(action: string): Promise<void> {
  if (workspaceBinding.isStale()) {
    const choice = await vscode.window.showWarningMessage(
      `UnodeAi: The first workspace folder changed. Reload the window before you ${action}; UnodeAi will not use stale project state.`,
      { modal: true },
      'Not now',
      'Reload Window',
    );
    if (choice !== 'Reload Window') return;
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `UnodeAi: Open a workspace folder before you ${action}. UnodeAi will not write project state without one.`,
    { modal: true },
    'Not now',
    'Open Folder',
  );
  if (choice !== 'Open Folder') return;
  await vscode.commands.executeCommand('workbench.action.files.openFolder');
}

function projectCommandInfo(): ProjectCommandInfo {
  return projectConventions?.getInfo() ?? { packageManager: 'npm', scripts: {} };
}

function configuredSetting<T>(key: string, fallback: T): T {
  return readUnodeSetting(vscode.workspace.getConfiguration('unode'), key, fallback);
}

function agentAutonomyPolicy(config: AgentConfig, mode: 'plan' | 'act' = sessionManager?.currentTurnMode(config.id) ?? chatViewProvider?.getAgentMode(config.id) ?? 'act') {
  return resolveAutonomyPolicy({ config,
    backend: config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry),
    defaultMode: autonomyDefaults?.effective(configuredSetting('autonomy', 'workspace')) ?? 'workspace',
    trusted: vscode.workspace.isTrusted, mode,
    taskScoped: sessionManager?.currentTurnHasTaskScope(config.id),
    commandMode: commandPolicy?.approvalMode ?? configuredSetting('commandApproval', 'all'),
    writeApproval: configuredSetting('writeApproval', 'none'),
  });
}

/** What this turn tells the agent about its file reach: Full access, as currently resolved, or the extra read root. */
/**
 * v0.9.100 (field, 4523a765): as a person's request starts, Grant access is offered for each path outside the workspace
 * the request names and no current grant covers. The notice came only when a file tool was refused: never when an agent
 * gave up without trying, and after minutes of work when a save was its first call. The offer's own rules still apply:
 * trust, Full access, Folder Access and one offer per path and request.
 */
function offerNamedOutsidePaths(config: AgentConfig, text: string): void {
  const offer = agentPathAccessOffers.get(config.id);
  if (!offer || !vscode.workspace.isTrusted) return;
  const roots = [...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    ...(config.workingDirectory ? [config.workingDirectory] : [])];
  const grants = localReadScopeConsent?.pathAccessFor(sessionManager.currentRequestId(config.id)) ?? [];
  for (const target of namedOutsidePaths(text, roots)) {
    const covered = grants.some(({ target: granted }) => granted.kind === 'file'
      ? samePath(granted.realPath, target) || samePath(granted.lexicalPath, target)
      : isPathInsideOrEqual(granted.realPath, target) || isPathInsideOrEqual(granted.lexicalPath, target));
    if (!covered) offer(target, 'named');
  }
}

function fileReachGuidance(config: AgentConfig): string {
  if (agentAutonomyPolicy(config).fullFileAccess) {
    return fullFileAccessGuidance(config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry));
  }
  const local = localReadScopeGuidance(configuredSetting<LocalReadScope>('localReadScope', 'parent'), firstWorkspaceRoot(), vscode.workspace.isTrusted);
  // v0.9.100 (field, 4523a765): a grant can open an outside path, unless Folder Access caps this agent.
  const grant = vscode.workspace.isTrusted && !config.folderAccess?.length ? outsidePathGrantGuidance() : '';
  return [local, grant].filter(Boolean).join('\n\n');
}

function autonomyForAgent(config: AgentConfig, mode: 'plan' | 'act' = sessionManager?.currentTurnMode(config.id) ?? chatViewProvider?.getAgentMode(config.id) ?? 'act') {
  const policy = agentAutonomyPolicy(config, mode);
  const turnId = sessionManager?.currentTurnId(config.id);
  const native = codexNativePolicySnapshots.get(config.id);
  let pending = codexAutonomyPendingTurns.get(config.id) === turnId;
  if (native && native.turnId === turnId) {
    try { pending = native.profile !== native.current(); }
    catch { pending = true; }
  }
  return turnId && pending
    ? { ...policy, label: 'Custom · native Codex change pending', detail: policy.detail
      + ' Host file policy changes live. The running native Codex turn retains its started policy. To end that turn, press Stop in chat; the next request uses the newly selected native policy.' }
    : policy;
}

/**
 * v0.9.100 (the Owner): the chat input's Autonomy menu, the only place Autonomy is shown. Every item carries the
 * explanation the person reads on hover or keyboard focus; the selected item also carries what differs for this
 * agent. For native Codex the selected position is the saved native profile, so an inherited native Full access is
 * never shown as a lower position. What a running request runs with comes from the snapshot taken when its native
 * turn started; the backend resolver's projection is what the next request runs with (Codex's audit of 1831cae2).
 */
function autonomyMenuForAgent(config: AgentConfig, backend: string) {
  const mode = sessionManager?.currentTurnMode(config.id) ?? chatViewProvider?.getAgentMode(config.id) ?? 'act';
  const policy = autonomyForAgent(config, mode);
  const isCodex = backend === 'codex';
  const selected: AutonomyMode = isCodex ? autonomyModeForCodexProfile(policy.codexProfile) : policy.requested;
  const notes: string[] = [];
  let capped = false;
  if (isCodex) {
    const expected = policy.requested === 'full-access' ? 'full-access' : policy.requested === 'review' ? 'ask-for-approval' : 'approve-for-me';
    if (policy.codexProfile !== expected) {
      notes.push(`Codex's own saved setting: ${AUTONOMY_MENU_LABEL[selected]}.`
        + (policy.codexProfile === 'full-access' ? ' No sandbox and no approval prompts.' : '')
        + ' Choose a position to replace it.');
    }
    const runs = (profile: string) => profile === 'read-only' ? 'read only'
      : profile === 'full-access' || profile === 'ask-for-approval' || profile === 'approve-for-me'
        ? 'as ' + AUTONOMY_MENU_LABEL[autonomyModeForCodexProfile(profile)] : 'under its earlier setting';
    const next = codexPermissionForAgent(config, mode);
    const why = next.effective !== next.configured && next.capReason ? `: ${next.capReason}` : '.';
    const turnId = sessionManager?.currentTurnId(config.id);
    const native = codexNativePolicySnapshots.get(config.id);
    const running = turnId && native?.turnId === turnId ? native.profile : undefined;
    if (running) {
      notes.push(`This request runs ${runs(running)}.`);
      if (native?.pythonCache) notes.push(`UnodeAi Python cache: ${native.pythonCache}. This runtime cache does not grant document Write access.`);
      if (next.effective !== running) notes.push(`The next request runs ${runs(next.effective)}${why}`);
    } else if (next.effective !== next.configured) {
      notes.push(`Codex runs ${runs(next.effective)}${why}`);
    }
    capped = next.effective !== next.configured || running === 'read-only';
  }
  for (const limit of policy.limits) {
    if (limit === 'separate saved native Codex choice') continue;
    // A capped native Codex turn already names Plan or Workspace Trust as its reason.
    if (capped && (limit === 'Plan is read only' || limit === 'Workspace Trust is read only')) continue;
    notes.push(plainAutonomyLimit(limit));
  }
  const items = AUTONOMY_MENU_MODES.map((item) => {
    const description = agentAutonomyPolicy({ ...config, autonomyMode: item }, mode).description;
    return { mode: item, label: AUTONOMY_MENU_LABEL[item],
      description: item === selected && notes.length ? `${notes.join(' ')} ${description}` : description };
  });
  return { selected, items };
}

/** Read-only display projection. Execution always returns to the existing live policy owners. */
function effectivePolicyForAgent(config: AgentConfig): EffectivePolicyView {
  const mode = sessionManager?.currentTurnMode(config.id) ?? chatViewProvider?.getAgentMode(config.id) ?? 'act';
  const autonomy = agentAutonomyPolicy(config, mode);
  const kind = config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry);
  const trusted = vscode.workspace.isTrusted && !!firstWorkspaceRoot();
  // A repository value never takes effect for these settings, so only a User Settings value is the person's choice.
  const settingExplicit = (key: AuthoritySettingKey) => isUserExplicitAuthoritySetting(vscode.workspace.getConfiguration('unode'), key);
  const commands = createAgentCommandPolicy(commandPolicy, config, () => config, () => autonomy);
  const capabilities = hostFileToolCapabilities(config, kind, !!config.folderAccess?.length);
  const commandsAvailable = trusted && mode !== 'plan' && capabilities.execute;
  const writesAvailable = trusted && mode !== 'plan' && capabilities.write;
  const native = kind === 'codex' ? codexPermissionForAgent(config, mode) : undefined;
  const started = codexNativePolicySnapshots.get(config.id);
  const nativeExecution = native ? `${native.effective}${native.capReason ? ' (' + native.capReason + ')' : ''}`
    + (started && started.turnId === sessionManager.currentTurnId(config.id) ? `; running turn started as ${started.profile}` : '') : undefined;
  const imageId = selectedImageConnection();
  const imageModel = readImageGenerationModel(vscode.workspace.getConfiguration('unode'));
  const imageSelection = config.mediaModels?.imageGeneration;
  const effectiveImage = effectiveMediaModel(imageSelection,
    imageId && imageModel ? { connectionId: imageId, modelId: imageModel } : undefined);
  const taskScope = sessionManager?.currentTurnHasTaskScope(config.id) ? '; current task scope also narrows host tools' : '';
  return effectivePolicyView({ agentId: config.id,
    connection: `${connectionProfileForAgent(config, effectiveConnectionRegistry)?.presentation.displayName ?? config.provider.providerId} / ${config.model}`,
    hostCommands: commandsAvailable ? commands.approvalMode : 'none',
    commandExplicit: settingExplicit('commandApproval') || !!config.commandNarrowing || projectCommandApprovals.isExecutionEnabled(),
    commandSource: `Live command policy, agent tool/folder ceiling, Plan and Workspace Trust${taskScope}`,
    hostWrite: writesAvailable ? autonomy.writeReview ? 'ask' : 'automatic' : 'off',
    writeExplicit: settingExplicit('writeApproval') || !!config.autonomyMode,
    writeSource: `Live write/autonomy choice, agent tool ceiling, Plan and Workspace Trust; target and folder grants rechecked per operation${taskScope}`,
    ...(nativeExecution ? { nativeExecution } : {}),
    taskScoped: sessionManager?.currentTurnHasTaskScope(config.id),
    network: `Host web choice: ${configuredSetting<string>('webAccess', 'allow')}; model/media destinations require their existing consent`
      + (native ? `; Codex session network choice for the next turn: ${codexSessionNetwork.get(config.id).allowed ? 'allowed' : 'Off'}; native Full access enables network; a running turn retains its started network policy` : '; native commands have no OS/network sandbox'),
    networkExplicit: settingExplicit('webAccess') ? true : 'unknown',
    reviewMode: reviewPolicyMode(teamPolicyStore.current()), reviewExplicit: teamPolicyStore.changes().length > 0,
    imageOff: imageSelection === 'off',
    ...(effectiveImage ? { imageConnection: {
      id: connectionProfile(effectiveImage.connectionId, effectiveConnectionRegistry)?.presentation.displayName ?? effectiveImage.connectionId,
      modelId: effectiveImage.modelId,
      supported: imageConnections?.modelForConnection(effectiveImage.connectionId) === effectiveImage.modelId,
      selection: typeof imageSelection === 'object' ? 'specific' as const : 'inherit' as const,
    } } : {}),
    rendererSnapshot: localApplications.current(),
  });
}

function notePendingNativeAutonomy(config: AgentConfig): void {
  const kind = config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry);
  const turnId = sessionManager.currentTurnId(config.id);
  if (kind === 'codex' && turnId) codexAutonomyPendingTurns.set(config.id, turnId);
}

const FULL_ACCESS_DISCLOSURE = 'File tools and Claude can read and change files your OS account permits, including personal and credential files. '
  + 'What an agent reads goes to its configured model provider. This does not elevate the OS account. '
  + 'Explicit Off, Ask, Folder Access, Plan, task restrictions and Workspace Trust remain. '
  + 'Host and Claude commands already have no OS filesystem sandbox. Native Codex Full access has no sandbox or approval prompts '
  + 'and bypasses UnodeAi command, deletion, outward-action and checkpoint checks. Enabling this starts no task, scan, model request, download or program.';

async function setAgentAutonomy(agentId: string, choice: AutonomyChoice): Promise<void> {
  if (choice !== 'inherit' && !isAutonomyMode(choice)) return;
  const session = sessionManager.get(agentId);
  if (!session) return;
  const generation = (agentAutonomyDecisionGenerations.get(agentId) ?? 0) + 1;
  agentAutonomyDecisionGenerations.set(agentId, generation);
  if ((session.config.autonomyMode ?? 'inherit') === choice) return;
  if (choice === 'full-access') {
    if (!vscode.workspace.isTrusted) return;
    const ENABLE = 'Enable full access';
    const answer = await vscode.window.showWarningMessage(`Enable Full access (unsafe) for ${session.config.name}?`,
      { modal: true, detail: `This changes only ${session.config.name}; it does not change the User default. `
        + 'For native Codex, this deliberately replaces its saved native profile with Full access for this agent. '
        + FULL_ACCESS_DISCLOSURE }, ENABLE);
    if (answer !== ENABLE || generation !== agentAutonomyDecisionGenerations.get(agentId) || !vscode.workspace.isTrusted
      || sessionManager.get(agentId) !== session) return;
  }
  agentAutonomyGenerations.set(agentId, (agentAutonomyGenerations.get(agentId) ?? 0) + 1);
  if (choice === 'inherit') delete session.config.autonomyMode;
  else session.config.autonomyMode = choice;
  accessInputsChanged(agentId);
  notePendingNativeAutonomy(session.config);
  try { await saveRoster(); }
  catch {
    void showResultNotice('warning', 'Autonomy changed for this extension host, but its saved copy could not be updated. After reloading, check the Autonomy picker beside this agent.');
  } finally {
    teamViewProvider?.refresh();
    chatViewProvider?.refresh();
    SettingsPanel.refreshCurrent();
  }
}

async function setDefaultAutonomy(mode: AutonomyMode): Promise<void> {
  if (!isAutonomyMode(mode) || !autonomyDefaults) return;
  if (configuredSetting<string>('autonomy', 'workspace') === mode && autonomyDefaults.effective(mode) === mode) {
    if (mode !== 'full-access') autonomyDefaults.invalidate();
    return;
  }
  const previous = autonomyDefaults.effective(configuredSetting('autonomy', 'workspace'));
  const generation = autonomyDefaults.revision + 1;
  try {
  const accepted = await autonomyDefaults.choose(mode, {
    trusted: () => vscode.workspace.isTrusted,
    confirm: async () => {
      const names = sessionManager.getAll().filter((s) => !isAutonomyMode(s.config.autonomyMode)).map((s) => s.config.name);
      const ENABLE = 'Enable full access';
      const answer = await vscode.window.showWarningMessage('Enable Full access (unsafe) as the User default?', { modal: true,
        detail: `Current agents inheriting this requested default: ${names.length ? names.join(', ') : 'none'}. `
          + 'This includes legacy Codex Approve for me values with unknown default-versus-explicit origin. '
          + 'Future agents from any trusted project team file inherit it unless independently restricted. '
          + 'Saved native Codex Ask and Full access choices remain separate. ' + FULL_ACCESS_DISCLOSURE }, ENABLE);
      return answer === ENABLE ? ENABLE : undefined;
    },
    write: (selected) => writeAutonomyUserMode(selected, generation),
  });
  if (!accepted && mode === 'full-access' && autonomyDefaults.revision === generation
    && configuredSetting<string>('autonomy', 'workspace') === 'full-access') await writeAutonomyUserMode(previous, generation);
  if (accepted) for (const session of sessionManager.getAll()) if (!isAutonomyMode(session.config.autonomyMode)) notePendingNativeAutonomy(session.config);
  teamViewProvider?.refresh(); chatViewProvider?.refresh(); SettingsPanel.refreshCurrent();
  } finally {
    if (expectedAutonomySetting?.generation === generation) expectedAutonomySetting = undefined;
  }
}

async function writeAutonomyUserMode(mode: AutonomyMode, generation = autonomyDefaults?.revision): Promise<void> {
  expectedAutonomySetting = { mode, generation };
  try {
    const write = updateUserAuthoritySetting('autonomy', mode);
    // Configuration can become readable before its persistence acknowledgement, with no event for a no-op.
    lastAutonomyUserSetting = configuredSetting<string>('autonomy', 'workspace');
    await write;
    lastAutonomyUserSetting = configuredSetting<string>('autonomy', 'workspace');
    if (lastAutonomyUserSetting !== mode && generation === autonomyDefaults?.revision) autonomyDefaults?.invalidate();
  }
  catch (error) { expectedAutonomySetting = undefined; throw error; }
}

function refreshAutonomyOnConfigurationChange(event: vscode.ConfigurationChangeEvent): void {
  if (event.affectsConfiguration('unode.autonomy')) {
    const configured = configuredSetting<string>('autonomy', 'workspace');
    if (configured !== lastAutonomyUserSetting) {
      lastAutonomyUserSetting = configured;
      for (const session of sessionManager.getAll()) if (!isAutonomyMode(session.config.autonomyMode)) notePendingNativeAutonomy(session.config);
      const ownWrite = configured === expectedAutonomySetting?.mode
        && expectedAutonomySetting.generation === autonomyDefaults?.revision;
      if (!ownWrite) {
        autonomyDefaults?.invalidate();
        reconcileAutonomyDefaultInBackground();
      }
    }
    teamViewProvider?.refresh(); chatViewProvider?.refresh(); SettingsPanel.refreshCurrent();
  }
  if (['commandApproval', 'allowedCommands', 'writeApproval'].some((key) => event.affectsConfiguration(`unode.${key}`))) {
    const fingerprint = JSON.stringify([configuredSetting('commandApproval', 'all'),
      configuredSetting('allowedCommands', []), configuredSetting('writeApproval', 'none')]);
    if (fingerprint !== lastAutonomyAdvancedFingerprint) {
      lastAutonomyAdvancedFingerprint = fingerprint;
      autonomyPolicyGeneration++;
      accessInputsChanged();
    }
    teamViewProvider?.refresh(); chatViewProvider?.refresh(); SettingsPanel.refreshCurrent();
  }
}

async function reconcileAutonomyDefault(): Promise<void> {
  if (!autonomyDefaults) return;
  const configured = configuredSetting<string>('autonomy', 'workspace');
  if (configured === 'full-access') {
    if (autonomyDefaults.effective(configured) !== 'full-access') await setDefaultAutonomy('full-access');
  } else if (isAutonomyMode(configured)) {
    await autonomyDefaults.choose(configured, { trusted: () => vscode.workspace.isTrusted,
      confirm: async () => undefined, write: async () => undefined });
  }
}

function reconcileAutonomyDefaultInBackground(): void {
  void reconcileAutonomyDefault().catch(() => {
    void showResultNotice('warning', 'The Autonomy default could not be saved. Choose a position for the agent in the chat input\'s Autonomy menu, or edit unode.autonomy in your User settings.');
  });
}

/**
 * The verification command the host has for one agent: the configured one, or the one found in the project's
 * own scripts. An untrusted workspace and an agent confined to folders have none.
 */
function verifyCommandForAgent(config: AgentConfig): string {
  return !vscode.workspace.isTrusted || config.folderAccess?.length
    ? ''
    : resolveVerifyCommand(configuredSetting<string>('verifyCommand', ''), projectCommandInfo());
}

const IGNORED_AUTHORITY_NOTICE_KEY = 'unode.ignoredAuthoritySettingsNotice.v0980';

/** Tell users once when repository-owned values exist but are deliberately not taking effect. */
async function noticeIgnoredWorkspaceAuthoritySettings(): Promise<void> {
  if (!firstWorkspaceRoot() || rootWorkspaceState.get<boolean>(IGNORED_AUTHORITY_NOTICE_KEY)) return;
  const ignored = ignoredWorkspaceAuthorityKeys(vscode.workspace.getConfiguration('unode'));
  if (ignored.length === 0) return;
  await rootWorkspaceState.update(IGNORED_AUTHORITY_NOTICE_KEY, true);
  void vscode.window.showWarningMessage(
    `UnodeAi ignored ${ignored.length} safety- or cost-sensitive project setting${ignored.length === 1 ? '' : 's'}: `
      + `${ignored.map((key) => `unode.${key}`).join(', ')}. Move trusted values to User Settings.`,
  );
}

/** Authority settings are user-owned in every editor; no activation callback writes a repository layer. */
function updateUserAuthoritySetting(key: AuthoritySettingKey, value: unknown): Thenable<void> {
  return vscode.workspace.getConfiguration('unode').update(key, value, vscode.ConfigurationTarget.Global);
}

/**
 * The two sources of silent command permission, kept apart: the user's own configured templates (any
 * compatible grammar) and the project's human grants (exact grammar only).
 */
function effectiveCommandPolicyInputs(): CommandPolicyInputs {
  return {
    configured: configuredSetting<string[]>('allowedCommands', []),
    project: projectCommandApprovals.list(),
  };
}

function reloadCommandPolicy(): void {
  commandPolicy.reload(
    effectiveCommandApprovalMode(
      configuredSetting<CommandApprovalMode>('commandApproval', 'all'),
      projectCommandApprovals.isExecutionEnabled(),
    ),
    effectiveCommandPolicyInputs(),
  );
  recheckNativeRenderAuthorities();
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
    // The file the change was recorded for; a record that names none provably (before v0.9.97) has no source file.
    return checkpoint.target;
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
    physicalDocumentPath = realpathSync.native(documentPath);
  } catch {
    return false;
  }
  const config = session.config;
  if (sessionManager.currentTurnHasTaskScope(config.id)) {
    const task = sessionManager.currentTurnWorkspaceAccess(config.id);
    if (!task) return false;
    // The running task's admitted physical paths remain a ceiling even under Full access. Do not resolve
    // its roots again: a link retargeted since admission must not move that ceiling to a different folder.
    const insideTaskFolder = [...task.readRoots, ...task.writeRoots]
      .some((root) => isPathInsideOrEqual(root, physicalDocumentPath));
    const exactTaskFile = [...(task.readFiles ?? []), ...(task.writeFiles ?? [])]
      .some((file) => path.relative(file.realPath, physicalDocumentPath) === '');
    if (!insideTaskFolder) {
      try {
        if (!exactTaskFile || !statSync(physicalDocumentPath).isFile()) return false;
      } catch { return false; }
    }
  }
  if (autonomyForAgent(config).fullFileAccess) return true;
  const primaryRoot = config.workingDirectory || workspaceRoot();
  const roots = readablePathCeilings(resolveEffectiveRoots({
    grants: config.folderAccess,
    fallbackPrimaryRoot: primaryRoot,
    fallbackReadRoots: orchestrationHost.readRootsForAgent(primaryRoot),
    workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    isTrusted: vscode.workspace.isTrusted,
  }));
  return roots.some((root) => isPathInsideOrEqual(realpathOrResolved(root), physicalDocumentPath));
}

let taskRecoveryEngine: TaskRecovery | undefined;

/** v0.9.110 R2: the revert engine over this workspace's history, restore points and writer leases. */
async function taskRecovery(): Promise<TaskRecovery | undefined> {
  if (taskRecoveryEngine) return taskRecoveryEngine;
  const store = await taskHistory?.store();
  if (!store) return undefined;
  taskRecoveryEngine = new TaskRecovery(taskRecoveryPorts({
    store,
    raw: async () => {
      const opened = await preChangeCheckpoints?.store();
      return opened && 'store' in opened ? opened.store : undefined;
    },
    leases: fileWriterLeases(),
    authority: checkpointRestoreAuthority(),
    decideSecurityControl: async (preview) => {
      const answer = await vscode.window.showWarningMessage(
        `Restoring ${preview.path} changes a security-control file. Allow this change?`,
        { modal: true, detail: securityControlApprovalPreview({ ...preview, securityChanges: [preview] }) },
        'Keep current file',
        'Allow this change',
      );
      return answer === 'Allow this change';
    },
    isRequestRunning: (requestId) => sessionManager?.requestRunning(requestId) ?? true,
    newId: () => randomUUID(),
  }));
  return taskRecoveryEngine;
}

/** One line per target of a revert's result, for the person and for the member's chat. */
function revertReportText(report: RecoveryReport): string {
  const applied = report.targets.filter((target) => target.outcome === 'applied');
  const left = report.targets.filter((target) => target.outcome !== 'applied');
  const lines = [
    `${report.action === 'revert' ? 'Reverted' : report.action === 'undo' ? 'Undid the revert of' : 'Reverted again'} ${applied.length} file${applied.length === 1 ? '' : 's'}`
      + `${left.length > 0 ? `; ${left.length} left as ${left.length === 1 ? 'it was' : 'they were'}` : ''}.`,
    ...left.map((target) => `- ${target.displayPath}: ${target.reason ?? target.outcome}`),
  ];
  if (report.notReversed.length > 0) lines.push(`Not reversed: ${report.notReversed.length} effect(s) of commands or provider tools.`);
  if (report.incomplete) lines.push(report.incomplete);
  return lines.join('\n');
}

/**
 * v0.9.110 R2: Revert to before a request of a member. The person picks the request, sees exactly what would be put
 * back, removed, or left as it is (and why), and applies it. Nothing is re-run; the files' checks run again at apply.
 */
async function revertToRequestCommand(args?: { agentId?: string; historyId?: string }): Promise<void> {
  const engine = await taskRecovery();
  const store = await taskHistory?.store();
  if (!engine || !store) { showResultNotice('warning', 'Revert is not available: task history could not be opened in this window.'); return; }
  const agentId = args?.agentId ?? chatViewProvider?.getSelectedAgentId();
  if (!agentId) { showResultNotice('warning', 'Select a member in Chat first; Revert works on its requests.'); return; }
  let historyId = args?.historyId;
  if (!historyId) {
    const branch = store.activeBranch;
    const tasks = (await store.tasksOf(agentId)).filter((task) => task.branchId === branch && task.rootRequestId).reverse();
    if (tasks.length === 0) { showResultNotice('information', 'This member has no recorded requests to revert to.'); return; }
    const picked = await vscode.window.showQuickPick(tasks.map((task) => ({
      label: task.goal.split(/\r?\n/)[0].slice(0, 100) || '(empty request)',
      description: onSystemClock(task.startedAt).toLocaleString(),
      detail: store.recoveryManifest(task.rootRequestId!)?.label ?? 'No recorded file changes',
      historyId: task.historyId,
    })), { title: 'Revert to before which request?', placeHolder: 'Files this request and every later request of this member changed go back to before it.' });
    if (!picked) return;
    historyId = picked.historyId;
  }
  const preview = await engine.preview(agentId, historyId);
  if ('refused' in preview) { showResultNotice('warning', `Not reverted: ${preview.refused}`); return; }
  const changing = preview.targets.filter((target) => target.action !== 'conflict');
  const left = preview.targets.filter((target) => target.action === 'conflict');
  if (changing.length === 0) {
    showResultNotice('information', left.length > 0
      ? `Nothing can be reverted: ${left.map((target) => `${target.displayPath} (${target.reason})`).join('; ')}`
      : 'These requests have no recorded file changes to revert.');
    return;
  }
  const detail = [
    ...changing.map((target) => `${target.action === 'remove' ? 'Remove' : 'Restore'}: ${target.displayPath}`),
    ...left.map((target) => `Left as it is: ${target.displayPath} (${target.reason})`),
    ...(preview.notReversed.length > 0 ? [`Not reversed: ${preview.notReversed.length} effect(s) of commands or provider tools.`] : []),
    '', 'Each file is checked again before it is written; Git is not touched. Undo revert can put these files back.',
  ].join('\n');
  const answer = await vscode.window.showWarningMessage(
    `Revert ${changing.length} file${changing.length === 1 ? '' : 's'} to before this request?`, { modal: true, detail }, 'Keep files as they are', 'Revert');
  if (answer !== 'Revert') return;
  const report = await engine.apply(preview.previewId);
  if (report.refused) { showResultNotice('warning', `Not reverted: ${report.refused}`); return; }
  const text = revertReportText(report);
  chatViewProvider?.postRuntimeNotice(agentId, `${text}\nEarlier results and checks in this chat describe the files as they were; they are not verified after this restore.`);
  showResultNotice('information', text.split('\n')[0]);
}

/** v0.9.110 R2: Undo revert / Redo revert of a recent revert, per file, from where each file stands. */
async function stepRevertCommand(action: 'undo' | 'redo'): Promise<void> {
  const engine = await taskRecovery();
  const store = await taskHistory?.store();
  if (!engine || !store) { showResultNotice('warning', 'Task history could not be opened in this window.'); return; }
  // v0.9.110 R2 (F2, re-audit): an operation whose end was never recorded is completed first, so it can be offered.
  await engine.settle();
  // v0.9.110: a revert whose restore points were deleted from Task history is not offered.
  let reverts = store.recoveryOperations().filter((operation) => operation.action === 'revert' && (operation.closed?.applied ?? 0) > 0
    && !store.recoveryRetired(operation.operationId)).reverse();
  // v0.9.110 R2 (F1): a Redo whose revert was followed by a newer request is history, and is not offered.
  if (action === 'redo') {
    const current = await Promise.all(reverts.map((operation) => engine.redoAvailable(operation.operationId)));
    reverts = reverts.filter((_operation, index) => current[index]);
  }
  if (reverts.length === 0) {
    showResultNotice('information', action === 'redo' ? 'There is no revert to redo: one undone before a newer request started is now history.'
      : 'There is no revert to undo or redo.');
    return;
  }
  // v0.9.110 (§4.3): each file of a revert has its own position; the choice shows them, not one flag for all.
  const picked = await vscode.window.showQuickPick(reverts.slice(0, 50).map((operation) => {
    const standing = engine.standing(operation.operationId);
    const files = operation.targets.filter((target) => standing.has(target.targetKey));
    return {
      label: `${files.length} file(s) of ${operation.agentId}`,
      description: operation.operationId.slice(0, 8),
      detail: files.slice(0, 6).map((target) => `${target.displayPath}: ${standing.get(target.targetKey)!.position === 'undone' ? 'undone' : 'reverted'}`)
        .join(' · ') + (files.length > 6 ? ` · ${files.length - 6} more` : ''),
      operationId: operation.operationId, agentId: operation.agentId,
    };
  }), { title: action === 'undo' ? 'Undo which revert?' : 'Redo which revert?' });
  if (!picked) return;
  const report = action === 'undo' ? await engine.undo(picked.operationId) : await engine.redo(picked.operationId);
  if (report.refused) { showResultNotice('information', report.refused); return; }
  const text = revertReportText(report);
  chatViewProvider?.postRuntimeNotice(picked.agentId, text);
  showResultNotice('information', text.split('\n')[0]);
}

/**
 * v0.9.110 R2: whether a member may read this file now, by its current Folder Access, as its tools would allow it. A
 * recovery notice names only such files; any other is counted without a path.
 */
function recoveryNoticeReadable(agentId: string, physical: string): boolean {
  const config = sessionManager.get(agentId)?.config;
  if (!config) return false;
  if (autonomyForAgent(config).fullFileAccess) return true;
  const primaryRoot = config.workingDirectory || workspaceRoot();
  const roots = readablePathCeilings(resolveEffectiveRoots({
    grants: config.folderAccess,
    fallbackPrimaryRoot: primaryRoot,
    fallbackReadRoots: orchestrationHost.readRootsForAgent(primaryRoot),
    workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    isTrusted: vscode.workspace.isTrusted,
  }));
  return roots.some((root) => isPathInsideOrEqual(realpathOrResolved(root), physical));
}

function realpathOrResolved(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function configuredUserAdditionalRoots(): string[] {
  if (!vscode.workspace.isTrusted) { return []; }
  return configuredSetting<string[]>('additionalRoots', [])
    .filter((root): root is string => typeof root === 'string' && root.trim().length > 0);
}

function configuredLocalReadScopeRoots(): string[] {
  // v0.9.99: a window without a folder has no project to discover siblings of.
  if (!vscode.workspace.isTrusted || !firstWorkspaceRoot()) { return []; }
  return localReadRootsForScope(configuredSetting<LocalReadScope>('localReadScope', 'parent'), workspaceRoot(), true);
}

function configuredAdditionalRoots(): string[] {
  const roots = [...configuredUserAdditionalRoots(), ...configuredLocalReadScopeRoots()];
  return [...new Set(roots.filter((root): root is string => typeof root === 'string' && root.trim().length > 0))];
}

// ─── V1 Checkpoints: record file writes + one-click restore ──────────────────

const WORKBENCH_INSPECTOR_KEY = 'unode.workbenchInspectorOpen';

/** Sink injected into each agent's WorkspaceTools — records a restore point per successful write. `target` is the
 *  absolute file the tool changed, resolved against the agent's own folder; a restore names that file (v0.9.97). */
function recordCheckpoint(entry: {
  agentId: string;
  path: string;
  target: string;
  before: string | null;
  after: string;
  operation?: CheckpointOperation;
  restoreDisabledReason?: CheckpointRestoreDisabledReason;
  /** The raw-byte restore point the host kept before the change (v0.9.97). */
  raw?: CheckpointRawRef;
  /** What a saved attachment left, by SHA-256 as read back (v0.9.97): its record's text is not its bytes. */
  afterSha256?: string;
  beforeSha256?: string | null;
  afterContentObserved?: false;
}, owner: 'agent' | 'person' = 'agent'): void {
  const target = path.resolve(entry.target);
  const physicalTarget = physicalPath(target);
  // v0.9.97: the request the change was made for, and where its closeout lists the file, so that a later restore of
  // this change can show on that request's closeout. The closeout itself takes the change from the write policy, as
  // read back, not from this record. v0.9.108 (L1): a change the person's own action made (Export PDF) names no
  // request or turn of the agent, even while one of them runs.
  const person = owner === 'person';
  const requestId = sessionManager.currentRequestId(entry.agentId);
  const requestPath = agentFileWrites.get(entry.agentId)?.effectPath(physicalTarget);
  checkpointStore.record({
    ...entry,
    agentName: resolveAgentName(entry.agentId),
    target,
    physicalTarget,
    operation: entry.operation ?? 'write',
    ...(requestId && !person ? { request: { id: requestId, ...(requestPath ? { path: requestPath } : {}) } } : {}),
  });
  recordCheckpointFileChange(runLedger, entry, person ? undefined : sessionManager.currentTurnCorrelationId(entry.agentId));
  // The rail is a live view of what the crew is doing to the repo, so an edit that just landed shows
  // up without waiting for the next state post. No-op while the rail is closed.
  chatViewProvider?.refreshChangedFiles();
  scheduleCheckpointSave();
}

function scheduleCheckpointSave(): void {
  if (checkpointSaveTimer) { clearTimeout(checkpointSaveTimer); }
  checkpointSaveTimer = setTimeout(() => persistence.saveCheckpoints(checkpointStore.serialize()), 1500);
}

function timeAgo(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) { return `${secs}s ago`; }
  const mins = Math.round(secs / 60);
  if (mins < 60) { return `${mins}m ago`; }
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : onSystemClock(ts).toLocaleString();
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
    showResultNotice('information', 'Could not open checkpoint diff: missing checkpoint id.');
    return;
  }
  const cp = checkpointStore.get(id);
  if (!cp) {
    showResultNotice('information', `Could not find checkpoint #${id}.`);
    return;
  }
  if (cp.truncated) {
    showResultNotice('information', `Checkpoint diff for ${cp.path} is unavailable because the file content was truncated.`);
    return;
  }
  const before = checkpointRef(cp, 'before');
  const left = vscode.Uri.from({ scheme: CHECKPOINT_SCHEME, path: `/${before.path}`, query: before.query });
  // The live side is the file the change was recorded for, and only inside an open workspace folder: a recorded
  // path that escapes them does not get to name the file this opens. A record that does not name its file (written
  // before v0.9.97) gets no live side, rather than the same relative path under some other folder. Both fall back to
  // the recorded content, which is inert.
  const abs = await liveCheckpointFile(cp);
  const liveFile = abs !== undefined && await fileExists(abs);
  if (cp.target && abs === undefined) {
    showResultNotice('information', 'The live checkpoint target was withheld because it is outside the open workspace folders; showing the recorded content instead.');
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
/**
 * v0.9.97: saved task batches of this workspace. Opening one shows it in an unsaved editor and sends nothing; a
 * stopped task's draft is recovered only this way, by the person. A running task's batches cannot be deleted.
 */
async function savedTaskBatchesCommand(): Promise<void> {
  const store = taskCheckpointStore;
  if (!store?.available) {
    showResultNotice('information', 'Saved task batches need an open folder or workspace; none are kept without one.');
    return;
  }
  await store.load();
  const list = store.list();
  if (list.length === 0) {
    showResultNotice('information', 'No saved task batches in this workspace. A task dispatched for delivery in batches saves them here.');
    return;
  }
  const chosen = await vscode.window.showQuickPick(
    list.map((summary) => ({ ...savedBatchesPick(summary, resolveAgentName(summary.agentId)), summary })),
    { placeHolder: 'Saved task batches kept on this machine for this workspace', matchOnDescription: true, matchOnDetail: true },
  );
  if (!chosen) { return; }
  const { summary } = chosen;
  const actions = [
    ...(summary.batches > 0 ? [{ label: '$(go-to-file) Open as an unsaved document', action: 'open' as const }] : []),
    ...(!summary.pinned && !summary.removed ? [{ label: '$(trash) Delete these saved batches…', action: 'delete' as const }] : []),
  ];
  if (actions.length === 0) {
    showResultNotice('information', 'These saved batches are kept while the task runs; stop it first to delete them.');
    return;
  }
  const action = await vscode.window.showQuickPick(actions, { placeHolder: savedBatchesPick(summary, resolveAgentName(summary.agentId)).label });
  if (!action) { return; }
  if (action.action === 'open') {
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: savedBatchesDocument(summary, resolveAgentName(summary.agentId), store.selectedBatches(summary.attemptId)),
    });
    await vscode.window.showTextDocument(document, { preview: false });
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(savedBatchesDeletePrompt(summary), { modal: true }, 'Keep saved batches', 'Delete');
  if (confirmed !== 'Delete') { return; }
  const outcome = await store.deleteAttempt(summary.attemptId);
  if (outcome === 'deleted') {
    showResultNotice('information', 'Saved batches deleted.');
  } else if (outcome === 'running') {
    showResultNotice('warning', 'These saved batches are kept while the task runs; stop it first to delete them.');
  } else {
    showResultNotice('warning', 'The saved batches could not be deleted; nothing was changed.');
  }
}

async function restoreCheckpointCommand(): Promise<void> {
  const items = checkpointStore.restorable();
  if (items.length === 0) {
    showResultNotice('information', checkpointStore.list().length === 0
      ? 'No restore points yet — UnodeAi creates one each time an agent edits a file.'
      : 'No recorded edit can be restored now. The Edit history in the Workbench shows why for each one.');
    return;
  }
  const picks = items.map((c) => ({
    label: `$(history) ${c.path}`,
    description: `${c.agentName} · ${timeAgo(c.ts)}`,
    detail: c.raw
      ? `Restore the exact bytes the file held before this edit (${checkpointEvidenceLabel(c)}).`
      : c.before === null
        ? 'Restoring deletes this file (it did not exist before this edit).'
        : `Restore to the version before this edit (${c.before.length} bytes, ${checkpointEvidenceLabel(c)}).`,
    cp: c,
  }));
  type RestorePick = (typeof picks)[number];
  const picker = vscode.window.createQuickPick<RestorePick>();
  picker.placeholder = 'Restore a file to a previous version. The trash button deletes a restore point.';
  picker.matchOnDescription = true;
  const button: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete this restore point' };
  picker.items = picks.map((pick) => ({ ...pick, buttons: [button] }));
  let chosen: RestorePick | undefined;
  try {
    await new Promise<void>((resolve) => {
      picker.onDidAccept(() => { chosen = picker.selectedItems[0]; picker.hide(); resolve(); });
      picker.onDidHide(() => resolve());
      picker.onDidTriggerItemButton((event) => {
        void deleteRestorePointWithConfirmation(event.item.cp).then((deleted) => {
          if (deleted) picker.items = picker.items.filter((item) => item.cp.id !== event.item.cp.id);
        });
      });
      picker.show();
    });
  } finally { picker.dispose(); }
  if (chosen) await restoreCheckpoint(chosen.cp);
}

/** v0.9.100 (the Owner): a restore point can be deleted. Its file is not touched. */
async function deleteCheckpointCommand(): Promise<void> {
  const items = checkpointStore.list();
  if (items.length === 0) {
    showResultNotice('information', 'No restore points yet — UnodeAi creates one each time an agent edits a file.');
    return;
  }
  const chosen = await vscode.window.showQuickPick(items.map((c) => ({
    label: `$(trash) ${c.path}`,
    description: `${c.agentName} · ${timeAgo(c.ts)}`,
    cp: c,
  })), { placeHolder: 'Delete a restore point. The file itself does not change.', matchOnDescription: true });
  if (chosen) await deleteRestorePointWithConfirmation(chosen.cp);
}

async function deleteRestorePointWithConfirmation(cp: Checkpoint): Promise<boolean> {
  const DELETE = 'Delete restore point';
  const answer = await vscode.window.showWarningMessage(
    `Delete the restore point for ${cp.path}? The file stays as it is, but this edit can no longer be restored.`,
    { modal: true },
    'Keep restore point',
    DELETE,
  );
  if (answer !== DELETE) return false;
  const opened = await preChangeCheckpoints?.store();
  const outcome = await deleteRestorePoint(checkpointStore, opened && 'store' in opened ? opened.store : undefined, cp.id,
    () => preChangeCheckpoints?.releaseEndedRequests());
  if (outcome === 'in-use') {
    showResultNotice('warning', `The restore point for ${cp.path} is in use by a change in progress, so it was not deleted. Try again when that change has finished.`);
    return false;
  }
  if (outcome === 'failed') {
    showResultNotice('warning', `The restore point for ${cp.path} could not be deleted; nothing was changed.`);
    return false;
  }
  scheduleCheckpointSave();
  chatViewProvider?.refreshChangedFiles();
  showResultNotice('information', `Deleted the restore point for ${cp.path}. The file did not change.`);
  return true;
}

/** Restore one checkpoint by id — the Workbench rail's per-file action. The id is resolved against
 *  the host's own store, so a webview never names the path that gets overwritten. */
async function restoreCheckpointByIdCommand(checkpointId: unknown): Promise<void> {
  const id = typeof checkpointId === 'number' ? checkpointId : Number(checkpointId);
  const cp = Number.isFinite(id) ? checkpointStore.get(id) : undefined;
  if (!cp) {
    showResultNotice('information', 'That restore point is no longer available.');
    return;
  }
  const restoreDisabledMessage = checkpointRestoreDisabledMessage(cp);
  if (restoreDisabledMessage) {
    showResultNotice('information', `${cp.path} cannot be restored: ${restoreDisabledMessage}`);
    return;
  }
  // The rail row means "this file", not "this keystroke". See restoreTargetForRow.
  const { target } = restoreTargetForRow(checkpointStore.list(), cp);
  await restoreCheckpoint(target);
}

/** Where the file a record names is now, when it is inside an open workspace folder by its physical path, which also
 *  sees a symlink or a Windows junction. Undefined for a record that names no file provably. */
async function liveCheckpointFile(cp: Checkpoint): Promise<string | undefined> {
  if (!cp.target) {
    return undefined;
  }
  for (const root of checkpointRestoreAuthority(cp.agentId).writeRoots(cp.target)) {
    const resolution = await resolveInsideRootPhysical(root, cp.target);
    if (resolution.status === 'resolved') {
      return resolution.path;
    }
  }
  return undefined;
}

/** What a restore may act under now (v0.9.97). It is the user's own write, so it is bounded by what the user has open:
 *  Workspace Trust, the open workspace folders, and no unsaved editor changes. A restore point grants nothing. */
function checkpointRestoreAuthority(agentId?: string): CheckpointRestoreAuthority {
  const external = (target: string) => {
    const config = agentId ? sessionManager.get(agentId)?.config : undefined;
    if (!config || config.folderAccess?.length || sessionManager.currentTurnHasTaskScope(config.id)) return undefined;
    if (autonomyForAgent(config, 'act').fullFileAccess) return { root: fullAccessTargetRoot(physicalPath(target)),
      revision: JSON.stringify(['full', autonomyPolicyGeneration, agentAutonomyGenerations.get(config.id),
        isAutonomyMode(config.autonomyMode) ? undefined : autonomyDefaults?.revision]) };
    const access = matchPathAccess(localReadScopeConsent.pathAccessFor(sessionManager.currentRequestId(config.id)), target, 'readwrite');
    return access && access.current() ? { root: fullAccessTargetRoot(access.physical), revision: access.grant.id } : undefined;
  };
  return {
    isTrusted: () => vscode.workspace.isTrusted,
    writeRoots: (target) => {
      if (!vscode.workspace.isTrusted) return [];
      const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
      const extra = target ? external(target) : undefined;
      return extra ? [...roots, extra.root] : roots;
    },
    revision: (target) => (vscode.workspace.workspaceFolders ?? []).some((folder) =>
      isPathInsideOrEqual(realpathOrResolved(folder.uri.fsPath), physicalPath(target))) ? undefined : external(target)?.revision,
    securityControlChange: change => fileWritePolicy.securityControlChange(change),
    hasUnsavedChanges: hasUnsavedEditorChanges,
  };
}

/** Whether an open editor holds unsaved changes to this file, under any spelling of its path. */
function hasUnsavedEditorChanges(absolutePath: string): boolean {
  const key = editorFileKey(absolutePath);
  const holds = (uri: vscode.Uri, isDirty: boolean) => isDirty && uri.scheme === 'file' && editorFileKey(uri.fsPath) === key;
  return vscode.workspace.textDocuments.some((document) => holds(document.uri, document.isDirty))
    || (vscode.workspace.notebookDocuments ?? []).some((notebook) => holds(notebook.uri, notebook.isDirty));
}

function editorFileKey(filePath: string): string {
  const physical = physicalPath(path.resolve(filePath));
  return process.platform === 'win32' ? physical.toLowerCase() : physical;
}

/** "Dev's edit", "3 edits by Dev" or "3 edits (2 by Dev, 1 by QA)": what a restore undoes, and whose. */
function describeUndoneEdits(undone: readonly Checkpoint[]): string {
  if (undone.length <= 1) {
    return `${undone[0]?.agentName ?? 'the agent'}'s edit`;
  }
  const byAgent = new Map<string, number>();
  for (const edit of undone) {
    byAgent.set(edit.agentName, (byAgent.get(edit.agentName) ?? 0) + 1);
  }
  return byAgent.size === 1
    ? `${undone.length} edits by ${undone[0].agentName}`
    : `${undone.length} edits (${[...byAgent].map(([name, count]) => `${count} by ${name}`).join(', ')})`;
}

/** The checks, the confirmation and the write. Every restore path goes through here, so neither the checks nor the
 *  modal warning that a file is about to be overwritten (or deleted) can be skipped by adding a new entry point.
 *
 *  A restore is a new write (v0.9.97). It acts on the file the change was recorded for, under the trust, folders and
 *  editors of now, and only while that file holds what UnodeAi last recorded for it: anything else is newer work a
 *  restore must not discard. The confirmation names every recorded edit it undoes, and the decision holds only for
 *  the file as it was when it was asked; the commit checks all of it again. Until v0.9.96 every restore read the
 *  recorded path against the first workspace folder and wrote there unchecked.
 *
 *  The store is also loaded from persisted state, so a record grants nothing by what it says: a hand-edited or
 *  tampered target is still written only inside an open workspace folder by its physical path, which sees a link or
 *  a Windows junction that no string comparison can. */
async function restoreCheckpoint(c: Checkpoint): Promise<void> {
  const planned = checkpointRestorePlan(checkpointStore.list(), c);
  if (!planned.ok) {
    showResultNotice('information', `${c.path} cannot be restored: ${planned.reason}`);
    return;
  }
  const { plan } = planned;
  // A change with exact bytes kept before it is restored from those bytes, held until the restore is done so nothing
  // drops them meanwhile; never from the decoded text in their place.
  const restorePoint = await restorePointContent(c);
  if (!restorePoint.ok) {
    showResultNotice('warning', `${c.path} was not restored: ${restorePoint.reason} The file was not changed.`);
    outputChannel.warn(`[checkpoints] restore of #${c.id} refused: its exact-byte restore point is not available.`);
    return;
  }
  const { content } = restorePoint;
  let keptCurrent: KeptCurrentFile | undefined;
  try {
    const authority = checkpointRestoreAuthority(c.agentId);
    const request = {
      target: plan.target,
      ...(plan.physicalTarget ? { physicalTarget: plan.physicalTarget } : {}),
      content,
      expected: plan.expected,
    };
    let preparation = await prepareCheckpointRestore(request, authority);
    // v0.9.99: newer work, or unsaved editor changes, is no longer a dead end. The same confirmation every restore
    // shows says why and offers "Restore anyway"; only the person's click on it restores over that work, and every
    // other check (trust, folders, path, identity) still holds.
    const overridden = preparation.status === 'refused' ? preparation.overridable : undefined;
    const overriddenReason = preparation.status === 'refused' ? preparation.reason : '';
    if (overridden) preparation = await prepareCheckpointRestore(request, authority, { overNewerWork: true });
    if (preparation.status === 'refused') {
      showResultNotice('warning', `${c.path} was not restored: ${preparation.reason} The file was not changed.`);
      outputChannel.warn(`[checkpoints] restore of #${c.id} refused before confirmation.`);
      return;
    }
    // Say how much is being undone, and by whom. "before their edit" is a false singular when four edits are rolled
    // back, and the user cannot see the count anywhere else.
    const scope = describeUndoneEdits(plan.undoes);
    // Before a restore over newer work, what the file holds now is kept as a restore point of its own, where it can be.
    if (overridden) keptCurrent = await keepCurrentBeforeRestore(c, preparation.prepared);
    const proceed = overridden ? 'Restore anyway' : 'Restore';
    const confirm = await vscode.window.showWarningMessage(
      overridden
        ? `${c.path}: ${overriddenReason} ${content.kind === 'absent' ? 'Delete it anyway' : 'Restore it anyway to the version before'}`
          + `${content.kind === 'absent' ? `? It didn't exist before ${scope}.` : ` ${scope}?`} ${keptCurrent!.summary}`
          + `${overridden === 'unsaved-editor' ? ' Your unsaved text stays in the editor.' : ''}`
        : content.kind === 'absent'
          ? `Delete ${c.path}? It didn't exist before ${scope}.`
          : `Restore ${c.path} to the version before ${scope}? The current contents will be overwritten.`,
      { modal: true, detail: `File: ${preparation.prepared.physical}\nRestore point: ${checkpointEvidenceLabel(c)}`
        + (preparation.prepared.securityControlPreview ? `\n\n${securityControlApprovalPreview({
          ...preparation.prepared.securityControlPreview, securityChanges: [preparation.prepared.securityControlPreview],
        })}` : '') },
      'Keep current file',
      proceed,
    );
    if (confirm !== 'Restore anyway' && confirm !== 'Restore') { return; }
    // v0.9.110 R2: the file's writer lease across this host's windows, taken only now (never across the confirmation)
    // and without waiting: another window writing the file leaves it as it is.
    const lease = await fileWriterLeases()?.acquire(preparation.prepared.physical, { waitMs: 0 });
    if (lease && lease.status !== 'held') {
      const why = lease.status === 'busy' && lease.holder === 'alive'
        ? 'another UnodeAi window is writing this file now'
        : 'UnodeAi cannot confirm that another writer of this file has finished';
      showResultNotice('warning', `${c.path} was not restored: ${why}. The file was not changed.`);
      return;
    }
    let outcome: Awaited<ReturnType<typeof commitCheckpointRestore>>;
    try {
      outcome = await commitCheckpointRestore(preparation.prepared, authority);
    } finally {
      if (lease?.status === 'held') await lease.release();
    }
    await keptCurrent?.settle(outcome);
    keptCurrent = undefined;
    // v0.9.97: the closeouts of the requests whose changes this undid show what the file is now.
    noteRestoreOnRequestCloseouts(plan.undoes, outcome.status === 'restored'
      ? (content.kind === 'absent' ? 'removed' : 'restored')
      : outcome.status === 'effect-uncertain' ? 'uncertain' : undefined);
    switch (outcome.status) {
      case 'restored':
        checkpointStore.markRestored(plan.undoes.map((undone) => undone.id), outcome.sha256);
        scheduleCheckpointSave();
        chatViewProvider?.refreshChangedFiles();
        // v0.9.110 R2: every member learns at its next request that this file was put back.
        taskHistory?.restoreNotice({ physicalTarget: outcome.physical, displayPath: c.path, removed: outcome.sha256 === null,
          current: outcome.sha256 === null ? { kind: 'absent' }
            : { kind: 'file', sha256: outcome.sha256, size: content.kind === 'bytes' ? content.bytes.length : 0 } });
        showResultNotice('information', `Restored ${c.path}.`);
        return;
      case 'refused':
        showResultNotice('warning', `${c.path} was not restored: ${outcome.reason} The file was not changed.`);
        outputChannel.warn(`[checkpoints] restore of #${c.id} refused at commit.`);
        return;
      case 'effect-uncertain':
        showResultNotice('error', `UnodeAi could not confirm that ${c.path} was restored: ${outcome.reason} Check the file; its restore point is kept.`);
        outputChannel.warn(`[checkpoints] restore of #${c.id} has an uncertain effect.`);
        return;
    }
  } finally {
    // A restore that never ran keeps nothing of the current file.
    await keptCurrent?.discard();
    restorePoint.release();
  }
}

/** v0.9.99: the current file, kept before a "Restore anyway" so that the person can bring it back with ⟲. */
interface KeptCurrentFile {
  /** One sentence for the confirmation: whether the current contents can be brought back, and how. */
  summary: string;
  /** After the restore: record the kept contents as a restore point of the person's own change, or drop them. */
  settle(outcome: CheckpointRestoreOutcome): Promise<void>;
  /** The restore did not run: drop what was kept. */
  discard(): Promise<void>;
}

/**
 * v0.9.99: keep what the file holds now before a restore over newer work. Its exact bytes go to this workspace's raw
 * restore points; failing that, short UTF-8 text is kept as a text record; failing both, the confirmation says the
 * current contents cannot be kept. Once the restore is done, the person's own change is recorded under the name
 * "You", so ⟲ on it puts the newer work back.
 */
async function keepCurrentBeforeRestore(c: Checkpoint, prepared: PreparedCheckpointRestore): Promise<KeptCurrentFile> {
  const target = prepared.request.target;
  const absent = prepared.observed.kind === 'absent';
  const current = absent ? undefined : await currentBytesAsPrepared(prepared);
  const currentText = current && Buffer.from(current.toString('utf8'), 'utf8').equals(current) ? current.toString('utf8') : undefined;
  const restoredText = prepared.request.content.kind === 'bytes' ? prepared.request.content.bytes.toString('utf8') : '';
  let kept: PreChangeCheckpoint | undefined;
  let unkept = absent ? undefined : current ? undefined : 'it changed while it was read';
  if (current) {
    const captured = await preChangeCheckpoints?.capture({
      agentId: 'user', path: c.path, target, physical: prepared.physical, bytes: current,
    });
    if (captured?.status === 'kept') kept = captured.checkpoint;
    else if (!(currentText !== undefined && checkpointKeepsText(currentText, restoredText))) {
      unkept = captured?.reason ?? 'there is no restore-point store in this window';
    }
  }
  let done = false;
  /** `afterSha256`: what the restore left, null for a removed file, undefined when that is not known. */
  const record = (rawRef: CheckpointRawRef | undefined, afterSha256: string | null | undefined) => {
    checkpointStore.record({
      agentId: 'user',
      agentName: 'You',
      path: c.path,
      target,
      physicalTarget: prepared.physical,
      operation: afterSha256 === null ? 'delete-file' : 'write',
      before: absent ? null : currentText ?? '',
      after: restoredText,
      ...(rawRef ? { raw: rawRef } : {}),
      ...(!rawRef && !absent && currentText === undefined ? { restoreDisabledReason: 'not-utf8-text' as const } : {}),
      ...(typeof afterSha256 === 'string' ? { afterSha256 } : {}),
    });
    scheduleCheckpointSave();
  };
  return {
    summary: absent
      ? 'It does not exist now; ⟲ on this restore removes the file again.'
      : unkept === undefined
        ? 'UnodeAi keeps its current contents as a new restore point first, so ⟲ can bring them back.'
        : `Its current contents cannot be kept (${unkept.replace(/[.\s]+$/, '')}), so they cannot be brought back.`,
    settle: async (outcome) => {
      if (done) return;
      done = true;
      if (outcome.status === 'refused') {
        await kept?.settle({ kind: 'not-committed' });
        return;
      }
      if (outcome.status === 'effect-uncertain') {
        const ref = await kept?.settle({ kind: 'uncertain' });
        if (ref || absent || unkept === undefined) record(ref, undefined);
        return;
      }
      const after = outcome.sha256 === null
        ? { exists: false as const }
        : { exists: true as const, size: prepared.request.content.kind === 'bytes' ? prepared.request.content.bytes.length : 0, sha256: outcome.sha256 };
      const ref = await kept?.settle({ kind: 'committed', after });
      if (ref || absent || unkept === undefined) record(ref, outcome.sha256);
    },
    discard: async () => {
      if (done) return;
      done = true;
      await kept?.settle({ kind: 'not-committed' });
    },
  };
}

/**
 * v0.9.97: a restore undid these recorded changes. Each one made for a request is shown on that request's closeout:
 * through the request's ledger while it is held here, else on its stored records directly (after a reload).
 */
function noteRestoreOnRequestCloseouts(undone: readonly Checkpoint[], outcome: FileRestoreOutcome | undefined): void {
  if (!outcome || !requestCloseoutStore) return;
  const store = requestCloseoutStore;
  for (const change of undone) {
    const request = change.request;
    if (!request?.path) continue;
    try {
      if (sessionManager.noteFileRestored(request.id, request.path, outcome)) continue;
      reviseRequestCloseouts(store, request.id, (record) => reviseForRestore(record, request.id, request.path!, outcome));
    } catch (error) {
      outputChannel.warn(`[request-closeout] a restore could not be shown on its request's closeout: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** v0.9.97: the stored records of one request take its file effects as they are now; no other request's record does. */
function showRequestFileEffects(requestId: string, changes: RequestChangesObservation): void {
  if (!requestCloseoutStore) return;
  reviseRequestCloseouts(requestCloseoutStore, requestId, (record) => reviseForFileEffects(record, requestId, changes));
}

/** v0.9.97: give every stored record of one request its next revision, where `revise` makes one. */
/**
 * v0.9.103 (G4): each turn's dispatch receipt as it changed after the turn ended, by agent and turn, until the closeout
 * sync has given it to that turn's record. Bounded: the oldest is dropped first.
 */
const closeoutReceipts = new Map<string, { accepted: number; refused: number; pending: number }>();
const CLOSEOUT_RECEIPTS_RETAINED = 64;
const closeoutReceiptKey = (agentId: string, turnId: string) => `${agentId}\u0000${turnId}`;

function noteCloseoutReceipt(agentId: string, turnId: string, receipt: { accepted: number; refused: number; pending: number }): void {
  const key = closeoutReceiptKey(agentId, turnId);
  closeoutReceipts.delete(key);
  closeoutReceipts.set(key, { accepted: receipt.accepted, refused: receipt.refused, pending: receipt.pending });
  while (closeoutReceipts.size > CLOSEOUT_RECEIPTS_RETAINED) closeoutReceipts.delete(closeoutReceipts.keys().next().value!);
  scheduleJobOutcomeSync();
}

function reviseRequestCloseouts(
  store: RequestCloseoutStore,
  requestId: string,
  revise: (record: RequestCloseoutRecordV1) => RequestCloseoutRecordV1 | undefined,
): void {
  for (const session of sessionManager.getAll()) {
    for (const record of store.ofRequest(session.id, requestId)) {
      if (record.requestId !== requestId) continue;
      const revised = revise(record);
      if (!revised) continue;
      const kept = store.upsert(revised);
      if (kept === 'conflict' || kept === 'invalid') {
        outputChannel.warn(`[request-closeout] turn ${record.terminalTurnId}: the revised record was not kept (${kept}).`);
      } else {
        // v0.9.110 H1 (H0's D5): the task history refers to the revised record too.
        taskHistory?.outcomeRecorded(revised);
      }
    }
  }
}

/** What a restore of `c` puts back: the exact bytes kept before the change when it has them, else its text record. */
async function restorePointContent(c: Checkpoint): Promise<
  { ok: true; content: CheckpointRestoreContent; release: () => void } | { ok: false; reason: string }
> {
  if (!c.raw) {
    return {
      ok: true,
      content: c.before === null ? { kind: 'absent' } : { kind: 'bytes', bytes: Buffer.from(c.before, 'utf8') },
      release: () => undefined,
    };
  }
  const opened = await preChangeCheckpoints?.store();
  if (!opened || 'unavailable' in opened) {
    return { ok: false, reason: `the exact bytes kept before this edit cannot be read (${opened?.unavailable ?? 'no restore-point store'}).` };
  }
  // v0.9.110: held in every window before the bytes are relied on.
  const pin = await opened.store.pinDurable(c.raw.id);
  if (!pin) {
    return { ok: false, reason: 'the exact bytes kept before this edit are no longer kept.' };
  }
  const read = await opened.store.readBefore(c.raw.id);
  if (read.status === 'unavailable') {
    pin.release();
    return { ok: false, reason: `the exact bytes kept before this edit cannot be used: ${read.reason}` };
  }
  return {
    ok: true,
    content: read.status === 'absent' ? { kind: 'absent' } : { kind: 'bytes', bytes: read.bytes },
    release: () => pin.release(),
  };
}

function diagnosticsSnapshot(root: string): { items: DiagnosticItem[] } {
  const resolvedRoot = path.resolve(root);
  const items: DiagnosticItem[] = [];
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file') {
      continue;
    }
    const abs = path.resolve(uri.fsPath);
    if (!isPathInsideOrEqual(resolvedRoot, abs)) {
      continue;
    }
    const rel = path.relative(resolvedRoot, abs);
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
  await new Promise((r) => setTimeout(r, POST_WRITE_DIAGNOSTICS_SETTLE_MS)); // let TS/ESLint recompute after the write
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

async function fetchMentionUrl(url: string, stopped?: AbortSignal): Promise<{ ok: boolean; text: string }> {
  // @url only runs for an explicit user-typed mention. webFetch handles the size cap, redirects and practical SSRF
  // checks; failures are treated as "not attached" by the pure expander. v0.9.99 (the Owner's decision): no deadline;
  // a reminder now and then lets the person send without the page or keep waiting.
  const text = await fetchMentionWithReminders(url, {
    fetch: (target, signal) => webFetch(target, { signal }),
    remind: (message, buttons) => vscode.window.showInformationMessage(message, ...buttons),
    setTimer: (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); },
    now: () => Date.now(),
  }, stopped);
  return { ok: !text.startsWith('Error:'), text };
}

function notifyVerifyCommandOutsideRoot(message: string): void {
  outputChannel.warn(`[verify] ${message}`);
  void vscode.window.showWarningMessage(message);
}

/** This ephemeral observation explains a turn; it neither prepares a shell nor grants execution permission. */
async function readAgentVerificationSnapshot(config: AgentConfig, cwd?: string) {
  if (!vscode.workspace.isTrusted || config.folderAccess?.length || sessionManager.currentTurnHasTaskScope(config.id)) {
    return { kind: 'restricted' as const };
  }
  const root = firstWorkspaceRoot();
  if (!root) return { kind: 'unavailable' as const };
  return readHostVerificationEligibility({
    workspaceRoot: () => firstWorkspaceRoot() ?? '',
    agentSkills: () => sessionManager.getAll().flatMap(session => skillsForAgent(session.config)),
    readTeam: () => persistence.loadTeamConfig({ strict: true }),
    configuration: () => vscode.workspace.getConfiguration('unode'),
  }, cwd || root);
}

/** Select an opted-in PM gate at turn end, without granting authorization or executing a command. */
async function createAgentCompletionGate(config: AgentConfig, launchId: string,
  cfg: NonNullable<EngineOptions['completionGate']>['cfg']): Promise<EngineOptions['completionGate']> {
  // Capture before the asynchronous document read, not when a possibly stale factory later runs the check.
  const owner = { requestId: sessionManager.currentRequestId(config.id), turnId: sessionManager.currentTurnId(config.id) };
  const resolution = await readHostCompletionGatePolicy({
    workspaceRoot: () => firstWorkspaceRoot() ?? '',
    agentSkills: () => sessionManager.getAll().flatMap(session => skillsForAgent(session.config)),
    readTeam: () => persistence.loadTeamConfig({ strict: true }),
    configuration: () => vscode.workspace.getConfiguration('unode'),
  });
  if (!resolution) return undefined;
  return { command: '', cfg,
    run: async () => ({ ok: false, blocked: true, output: 'Typed completion verification is required; no legacy fallback was run.' }),
    runTyped: () => runAgentVerification(config, false, launchId, resolution, owner) };
}

async function runAgentVerification(config: AgentConfig, interactive: boolean, launchId?: string,
  capturedResolution?: VerificationPolicyResolution, owner?: { requestId?: string; turnId?: string }) {
  const root = firstWorkspaceRoot() ?? '';
  const cwd = config.workingDirectory || root;
  const requestId = owner ? owner.requestId : sessionManager.currentRequestId(config.id);
  const turnId = owner ? owner.turnId : sessionManager.currentTurnId(config.id);
  const abort = new AbortController();
  const current = () => !!launchId && sessionManager.isCurrentBackendLaunch(config.id, launchId)
    && !!requestId && !!turnId && sessionManager.currentRequestId(config.id) === requestId
    && sessionManager.currentTurnId(config.id) === turnId && sessionManager.get(config.id)?.status === 'running'
    && firstWorkspaceRoot() === root && agentRosterEdits.admissionAllowed;
  const ended = (event: { sessionId: string }) => { if (event.sessionId === config.id) abort.abort(); };
  sessionManager.on('session.turnEnded', ended);
  sessionManager.on('session.stopped', ended);
  sessionManager.on('session.removed', ended);
  try {
    const check = await runHostVerificationCheck({
      workspaceRoot: () => firstWorkspaceRoot() ?? '',
      agentSkills: () => sessionManager.getAll().flatMap(session => skillsForAgent(session.config)),
      readTeam: () => persistence.loadTeamConfig({ strict: true }),
      configuration: () => vscode.workspace.getConfiguration('unode'),
    }, {
      cwd, roots: [root], signal: abort.signal,
      request: { kind: 'session', sessionId: config.id, requestId: requestId ?? '', attemptId: turnId },
      isCurrentRequest: identity => identity.kind === 'session' && identity.sessionId === config.id
        && identity.requestId === requestId && identity.attemptId === turnId && current(),
      isTrusted: () => vscode.workspace.isTrusted,
      directoryAllowed: candidate => {
        const live = sessionManager.get(config.id)?.config;
        return !!root && !!live && !config.folderAccess?.length && !live.folderAccess?.length
          && !sessionManager.currentTurnHasTaskScope(config.id)
          && candidate === cwd && isSameAgentDirectory(cwd, live.workingDirectory || root);
      },
      // v0.9.106 (F-1): the check's own record in the request says it did not run and how to turn commands on (the
      // run_checks card, or the note after the reply); a blocked check adds no "Enable Commands" notice, and leaves
      // that notice to the next ordinary blocked command.
      commandPolicy: () => {
        const live = sessionManager.get(config.id)?.config;
        return live ? new AgentCommandPolicy(commandPolicy, live.commandNarrowing, live.name, undefined, false) : undefined;
      },
      prepare: verificationPreparer, timeoutMs: verifyTimeoutMs(), onConfigOutsideRoot: notifyVerifyCommandOutsideRoot,
      ...(interactive ? { requestApproval: (command, commandContext) => requestCommandApproval(command, config.name,
        commandContext, { agentId: config.id, sessionId: config.id }) } : {}),
    }, capturedResolution);
    sessionManager.recordVerificationCheck(config.id, requestId, turnId, check, interactive ? 'run-checks' : 'completion-gate', launchId);
    return check;
  } finally {
    sessionManager.off('session.turnEnded', ended);
    sessionManager.off('session.stopped', ended);
    sessionManager.off('session.removed', ended);
  }
}

/** Workflow checks use current team policy and global Commands, never an agent's narrowing or approval prompt. */
async function runWorkflowVerification(request: WorkflowCheckRequest) {
  const root = request.workspaceRoot ?? '';
  const reader = {
    workspaceRoot: () => firstWorkspaceRoot() ?? '',
    agentSkills: () => sessionManager.getAll().flatMap(session => skillsForAgent(session.config)),
    readTeam: () => persistence.loadTeamConfig({ strict: true }),
    configuration: () => vscode.workspace.getConfiguration('unode'),
  };
  const check = await runHostVerificationCheck(reader, {
    cwd: root, roots: [root], request: { kind: 'workflow', runId: request.runId }, signal: request.signal,
    isCurrentRequest: identity => identity.kind === 'workflow' && identity.runId === request.runId
      && request.isCurrent() && !!root && firstWorkspaceRoot() === root && agentRosterEdits.admissionAllowed,
    isTrusted: () => vscode.workspace.isTrusted,
    directoryAllowed: cwd => cwd === root && firstWorkspaceRoot() === root,
    commandPolicy: () => commandPolicy,
    prepare: verificationPreparer, timeoutMs: verifyTimeoutMs(),
    onConfigOutsideRoot: notifyVerifyCommandOutsideRoot,
  });
  // v0.9.99: read after the check, so a gate whose check could not run continues unverified only while the policy
  // still does not require it. A policy the host cannot read counts as required.
  let required = true;
  try { required = verificationExplicitlyRequired(await readHostVerificationPolicy(reader)); } catch { /* stays required */ }
  return { ok: check.kind === 'passed', blocked: check.kind !== 'passed' && check.kind !== 'failed',
    output: check.kind === 'not-run' ? check.detail : check.output, check, required };
}

/**
 * v0.9.99: the admission for merging a lane into integration marked unverified. Undefined while the current policy
 * explicitly requires a check (a command the user set, or a policy the host cannot read). Otherwise the merge is bound
 * to the committed head (the coordinator adds it), a clean lane, the completed request, Workspace Trust, the same first
 * folder and worktree mode, all re-read just before the merge. It runs no command.
 */
async function worktreeUnverifiedMergeAdmission(
  root: string, wt: Worktree, owner: WorktreeVerificationOwner, coordinatorCurrent: () => boolean,
): Promise<MergeAdmission | undefined> {
  const reader = {
    workspaceRoot: () => firstWorkspaceRoot() ?? '',
    agentSkills: () => sessionManager.getAll().flatMap(session => skillsForAgent(session.config)),
    readTeam: () => persistence.loadTeamConfig({ strict: true }),
    configuration: () => vscode.workspace.getConfiguration('unode'),
  };
  // Turning off "verify before merge" is the user's own choice not to gate merges, even with a command set; a policy
  // the host cannot read still holds the lane.
  const required = (resolution: VerificationPolicyResolution) => verificationExplicitlyRequired(resolution)
    && (resolution.kind !== 'resolved' || configuredSetting<boolean>('worktree.verifyBeforeMerge', true));
  let latest = await readHostVerificationPolicy(reader);
  if (required(latest)) return undefined;
  let clean = false;
  return {
    refresh: async () => {
      latest = await readHostVerificationPolicy(reader);
      const status = await runGitIn(wt.path, ['status', '--porcelain']);
      clean = status.code === 0 && status.stdout.trim() === '';
    },
    isCurrent: () => clean && !required(latest) && owner.isCurrent() && coordinatorCurrent()
      && !!root && firstWorkspaceRoot() === root && vscode.workspace.isTrusted
      && configuredSetting<string>('concurrencyStrategy', 'optimistic') === 'worktree',
  };
}

/** Verify the completed worker's own lane, with that worker's live narrowing and no interactive approval. */
async function runWorktreeVerification(root: string, wt: Worktree, owner: WorktreeVerificationOwner) {
  const reader = {
    workspaceRoot: () => firstWorkspaceRoot() ?? '',
    agentSkills: () => sessionManager.getAll().flatMap(session => skillsForAgent(session.config)),
    readTeam: () => persistence.loadTeamConfig({ strict: true }),
    configuration: () => vscode.workspace.getConfiguration('unode'),
  };
  const resolution = await readHostVerificationPolicy(reader);
  const enabled = () => configuredSetting<string>('concurrencyStrategy', 'optimistic') === 'worktree'
    && configuredSetting<boolean>('worktree.verifyBeforeMerge', true);
  const directoryAllowed = () => {
    const live = sessionManager.get(owner.request.sessionId);
    return agentRosterEdits.admissionAllowed && !!root && root === firstWorkspaceRoot() && wt.agentId === owner.request.sessionId && !!live
      && !live.config.folderAccess?.length && !owner.hasTaskScope && live.runtimeWorkingDirectory === wt.path
      && delegationCapabilitiesFor(live.config)?.shell === true;
  };
  const livePolicy = () => {
    const live = sessionManager.get(owner.request.sessionId)?.config;
    return live ? new AgentCommandPolicy(commandPolicy, live.commandNarrowing, live.name) : undefined;
  };
  const check = enabled() || resolution.kind === 'configuration-invalid' ? await runHostVerificationCheck(reader, {
    cwd: wt.path, roots: [wt.path], request: owner.request, signal: owner.signal,
    isCurrentRequest: identity => identity.kind === 'session' && identity.sessionId === owner.request.sessionId
      && identity.requestId === owner.request.requestId && identity.attemptId === owner.request.attemptId && owner.isCurrent(),
    isTrusted: () => vscode.workspace.isTrusted,
    directoryAllowed: cwd => enabled() && cwd === wt.path && directoryAllowed(), commandPolicy: livePolicy,
    prepare: verificationPreparer, timeoutMs: verifyTimeoutMs(), onConfigOutsideRoot: notifyVerifyCommandOutsideRoot,
  }, resolution) : { kind: 'not-run' as const, reason: 'disabled' as const, source: resolution.effective.source,
    detail: 'Automatic pre-merge checks are disabled; work was not merged.' };
  let latest = resolution;
  return { ...policyVerifyResult(check), mergeAdmission: {
    refresh: async () => { latest = await readHostVerificationPolicy(reader); },
    isCurrent: () => {
      if (check.kind !== 'passed' || !owner.isCurrent() || !enabled() || !directoryAllowed() || !vscode.workspace.isTrusted
        || latest.kind !== 'resolved' || !sameVerificationBinding(check.binding, latest.effective.binding)) return false;
      const prepared = verificationPreparer();
      return prepared.ok && livePolicy()?.check(check.command, { shell: prepared.shell }).allowed === true;
    },
  } };
}

/**
 * Register every referenced integration in the one host-owned Hub. OpenAI-compatible, Claude and Codex
 * routes advertise different transports to their models, but authorization, secrets and filtering live here.
 */
function registerReferencedMcpServers(): void {
  const wanted = new Set<string>();
  for (const info of sessionManager.getAll()) {
    for (const g of effectiveIntegrationGrants(info.config)) {
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

/** Deduplicate one host-owned mount; each caller owns an independent waiter lease. */
function integrationMountKey(config: MCPServerConfig): string {
  return `${approvalKey(config, firstWorkspaceRoot() ?? '')}:${shouldRequireApproval(config)}`;
}

function isCurrentIntegrationMount(config: MCPServerConfig): boolean {
  const current = mcpRegistry.get(config.id);
  return current !== undefined && !removingIntegrations.has(config.id) && !persistence.integrationConfigNeedsRepair(config.id)
    && integrationMountKey(current) === integrationMountKey(config);
}

function acquireMcpMount(cfg: MCPServerConfig): SharedOperationLease<'mounted' | 'skipped' | 'error'> {
  if (!isCurrentIntegrationMount(cfg)) return { promise: Promise.resolve('skipped'), release() {} };
  if (mcpHub.isRegistered(cfg.id)) {
    return { promise: Promise.resolve('mounted'), release() {} };
  }
  return mcpMountLeases.acquire(integrationMountKey(cfg), (signal) => performMcpMount(cfg, signal));
}

async function mountMcpServer(cfg: MCPServerConfig): Promise<'mounted' | 'skipped' | 'error'> {
  const lease = acquireMcpMount(cfg);
  try {
    return await lease.promise;
  } finally {
    lease.release();
  }
}

function cancelPendingMcpMount(id: string, reason: string): void {
  const config = mcpRegistry.get(id);
  if (config && mcpMountLeases.cancel(integrationMountKey(config))) mcpMountDetails.set(id, reason);
}

/**
 * Mount one MCP server, gating sensitive ones (requiresApproval) behind a one-time user
 * confirmation that is then persisted (P1#4 / MCP design §7.2). The mount returns a typed outcome;
 * agent startup turns any unavailable grant into a visible retry/continue/cancel decision.
 */
/** Freeze a user-approved stdio MCP program to the same safe host path used by Claude and Git. */
function resolveHostMcpProgram(config: MCPServerConfig): MCPServerConfig {
  return config.transport === 'stdio' && config.command
    ? { ...config, command: resolveHostProgram(config.command) }
    : config;
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

/**
 * Keep the affirmative mount decision explicit at the modal boundary.  Callers may race this promise
 * against a readiness deadline, but a late/closed/safe-default response can never become authority.
 */
async function requestMcpMountApproval(cfg: MCPServerConfig): Promise<'Approve & Mount' | undefined> {
  const choice = await blockingPrompt(attentionAppearance('mcp-mount'), () => vscode.window.showWarningMessage(
    `MCP server "${cfg.name}" can access resources beyond the file sandbox (${cfg.transport}). Mount it for this team?`,
    { modal: true },
    'Skip',
    'Approve & Mount',
  ), mcpMountWaits.prompt(cfg.id));
  return choice === 'Approve & Mount' ? choice : undefined;
}

/**
 * v0.9.99: adding a server yourself, in the Marketplace or with Add MCP Server, is its approval, so the mount that
 * follows asks nothing more. The approval is bound to this workspace and this exact launch spec (command, args, URL,
 * environment placeholders), so a server supplied by a file, or a later change to this one, still asks.
 */
async function approveUserAddedMcpServer(cfg: MCPServerConfig): Promise<void> {
  if (!shouldRequireApproval(cfg)) return;
  const key = approvalKey(cfg, workspaceRoot());
  if (approvedMcp.has(key)) return;
  approvedMcp.add(key);
  await persistence.saveApprovedMcpServers([...approvedMcp]);
}

async function performMcpMount(
  cfg: MCPServerConfig,
  signal: AbortSignal,
): Promise<'mounted' | 'skipped' | 'error'> {
  const current = () => !signal.aborted && isCurrentIntegrationMount(cfg);
  if (!current()) return 'skipped';
  lastMcpMountDetail = '';
  mcpMountDetails.delete(cfg.id);
  const setDetail = (detail: string): void => {
    if (!isCurrentIntegrationMount(cfg)) return;
    lastMcpMountDetail = detail;
    mcpMountDetails.set(cfg.id, detail);
  };
  if (signal.aborted) {
    setDetail(`"${cfg.name}" mount was cancelled before it started`);
    return 'skipped';
  }
  // Workspace Trust gate: MCP servers can spawn local processes (stdio: npx/uvx/docker) or reach the
  // network (remote), so never mount them in an untrusted workspace. They are (re)mounted when the user
  // grants trust (see the onDidGrantWorkspaceTrust handler in activate).
  if (!vscode.workspace.isTrusted) {
    setDetail(`"${cfg.name}" is disabled until you trust this workspace (Workspace Trust)`);
    outputChannel.warn(`MCP server "${cfg.id}" not mounted: workspace is not trusted.`);
    return 'skipped';
  }
  // Pre-flight: a stdio server whose command isn't installed would just close the connection — catch it
  // here with a clear, actionable message instead of the opaque MCP "Connection closed" error.
  if (cfg.transport === 'stdio' && cfg.command) {
    try {
      resolveHostMcpProgram(cfg);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setDetail(`"${cfg.name}" can't mount: ${detail}`);
      outputChannel.error(`MCP server "${cfg.id}" can't mount: ${detail} — ${mcpCommandHint(cfg.command)}`);
      return 'error';
    }
  }
  if (needsApproval(cfg, approvedMcp, workspaceRoot())) {
    const approval = requestMcpMountApproval({ ...cfg, name: mcpRegistry.get(cfg.id)?.name ?? cfg.name });
    const choice = await Promise.race([
      approval,
      new Promise<undefined>((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true })),
    ]);
    if (!current()) {
      if (!mcpMountDetails.has(cfg.id)) setDetail(`"${cfg.name}" approval did not finish before the integration readiness deadline`);
      outputChannel.warn(`MCP server "${cfg.id}" ignored a late approval response after startup timed out.`);
      void approval.then(() => outputChannel.warn(`MCP server "${cfg.id}" ignored a late approval response after cancellation.`));
      return 'skipped';
    }
    if (choice !== 'Approve & Mount') {
      setDetail(`"${cfg.name}" was not approved for this workspace`);
      outputChannel.warn(`MCP server "${cfg.id}" skipped (not approved).`);
      return 'skipped';
    }
    approvedMcp.add(approvalKey(cfg, workspaceRoot()));
    await persistence.saveApprovedMcpServers([...approvedMcp]);
    settingsPanelRefresh();
  }
  if (!current()) {
    setDetail(`"${cfg.name}" mount did not finish before the integration readiness deadline`);
    return 'skipped';
  }
  try {
    // Substitute ${WORKDIR} in args/url before spawning (secrets in env are resolved inside the Hub).
    const mountFingerprint = approvalKey(cfg, workspaceRoot());
    const owner = Symbol(cfg.id);
    await mcpHub.register(resolveServerPlaceholders(resolveHostMcpProgram(cfg), { WORKDIR: workspaceRoot() }), { current, owner, signal });
    if (!current()) {
      await mcpHub.unregister(cfg.id, owner);
      setDetail(`"${cfg.name}" finished too late and was disconnected; restart the agent to retry`);
      outputChannel.warn(`MCP server "${cfg.id}" completed after startup timed out and was disconnected.`);
      return 'skipped';
    }
    mcpHub.renameRegisteredServer(cfg.id, mcpRegistry.get(cfg.id)?.name ?? cfg.name);
    outputChannel.info(`MCP server "${cfg.id}" mounted.`);
    mountedIntegrationFingerprints.set(cfg.id, mountFingerprint);
    settingsPanelRefresh();
    return 'mounted';
  } catch (err) {
    if (!current()) return 'skipped';
    const detail = err instanceof Error ? err.message : String(err);
    setDetail(`"${cfg.name}" failed to mount: ${detail}`);
    outputChannel.error(`MCP server "${cfg.id}" failed to mount: ${detail}`);
    return 'error';
  }
}

/**
 * v0.9.99 (A8): granted UnodeAi-managed integrations never hold or fail an agent's start. Each mounts on its own;
 * the start waits for those still connecting for at most MCP_START_READINESS_WAIT_MS and then goes ahead without
 * the ones that are not ready, which keep connecting in the background. The agent's chat names what is missing, and
 * a notification offers Retry; neither waits for an answer. A missing integration is never offered as mounted.
 */
async function prepareManagedIntegrations(config: AgentConfig): Promise<void> {
  // Untrusted workspaces deliberately disable managed MCP. Let each backend apply its normal read-only/trust
  // policy instead of presenting an integration failure for a surface the host intentionally removed.
  if (!vscode.workspace.isTrusted) return;
  const serverIds = [...new Set(effectiveIntegrationGrants(config).map((grant) => grant.serverId))];
  if (serverIds.length === 0) return;
  const toolsFollowLive = (config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry)) === 'openai-compat';
  const connectedLater = (cfg: MCPServerConfig) => chatViewProvider?.postRuntimeNotice(config.id, toolsFollowLive
    ? `${cfg.name} is connected; its tools are offered from this agent's next request.`
    : `${cfg.name} is connected; restart the agent to give it its tools.`);
  const unavailable = await prepareManagedIntegrationsForStart(config.id, serverIds, MCP_START_READINESS_WAIT_MS, {
    isRegistered: (id) => mcpHub.isRegistered(id),
    config: (id) => mcpRegistry.get(id),
    acquireMount: acquireMcpMount,
    waitAs: (key, sessionId, pending, timeoutMs) => mcpMountWaits.waitAs(key, sessionId, pending, timeoutMs),
    continueInBackground: (cfg) => {
      void mountMcpServer(cfg).then((outcome) => { if (outcome === 'mounted') connectedLater(cfg); }, () => undefined);
    },
    mountDetail: (id) => mcpMountDetails.get(id),
    configurationRepair: (id) => persistence.integrationConfigNeedsRepair(id),
    now: () => Date.now(),
  });
  if (unavailable.length === 0) return;
  outputChannel.warn(`[managed-mcp:${config.id}] Started without: ${unavailable.map((item) => item.id).join(', ')}.`);
  const notice = unavailableIntegrationsNotice(unavailable, toolsFollowLive);
  chatViewProvider?.postRuntimeNotice(config.id, notice);
  // v0.9.100 (field): an integration with no configuration here has nothing to retry. The chat line says what to do;
  // repeating it as a notification for every agent at every start is noise.
  const { actions, retryable } = integrationStartNoticeActions(unavailable);
  if (!actions.length) return;
  // Non-modal: the start has already gone ahead. Retry re-enters the ordinary approved mount path; it grants nothing.
  void vscode.window.showWarningMessage(`${config.name}: ${notice}`, ...actions).then((choice) => {
    if (choice === 'Open Integrations') {
      return vscode.commands.executeCommand('unode.openMarketplace', 'mcp');
    }
    if (choice !== 'Retry') return;
    for (const item of retryable) {
      const cfg = mcpRegistry.get(item.id);
      if (!cfg || mcpHub.isRegistered(cfg.id)) continue;
      void mountMcpServer(cfg).then((outcome) => {
        if (outcome === 'mounted') connectedLater(cfg);
        else chatViewProvider?.postRuntimeNotice(config.id, `${cfg.name} still did not connect: ${mcpMountDetails.get(cfg.id) ?? 'see View > Output > UnodeAi'}.`);
      }, () => undefined);
    }
  }, () => undefined);
}

/** A user-facing message for an MCP mount outcome (the server is already saved to the team file either way). */
function mcpMountMessage(
  name: string,
  outcome: 'mounted' | 'skipped' | 'error',
  change: 'added' | 'updated' = 'added',
): { ok: boolean; message: string } {
  const configured = change === 'updated' ? `Configuration updated for "${name}"` : `Configuration added for "${name}"`;
  if (outcome === 'mounted') {
    return { ok: true, message: `${configured} and the MCP server mounted. No agent was granted access.` };
  }
  if (outcome === 'skipped') {
    return { ok: false, message: `${configured}, but it was not approved or mounted. No agent was granted access.` };
  }
  // If we know WHY it failed (e.g. a missing command), say so in the toast instead of only the output channel.
  const why = lastMcpMountDetail
    ? ` ${punctuateMountDetail(lastMcpMountDetail)}`
    : ' See the UnodeAi output channel for details.';
  return { ok: false, message: `${configured}, but mounting failed.${why} No agent was granted access.` };
}

/** Nudge registry-backed panels (if open) after MCP/connection changes. */
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
  imageConnections?.refresh();
  // v0.9.110: a suggestion begun under the previous registry is not sent or shown under this one.
  replySuggestions?.cancelAll();
  chatViewProvider?.dismissReplySuggestions();
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
    get: <T>(key: string, fallback: T) => configuredSetting<T>(key, fallback),
    update: (key: string, value: unknown) => Promise.resolve(
      vscode.workspace.getConfiguration('unode').update(
        key,
        value,
        isAuthoritySettingKey(key) ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace,
      ),
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
    void showResultNotice('warning', `UnodeAi: ${resolved.repairMessage} ${resolved.providerId === LEGACY_CUSTOM_PROVIDER_ID
        ? 'Choose a named gateway in Settings before creating new agents.'
        : 'New agents will use Unode until you choose another available connection.'}`);
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

/** A persisted path remains authoritative; auto-detection runs only after an explicit user action. */
function configuredCodexCliPath(): string {
  const configuredPath = configuredSetting<string>('codexCliPath', '').trim();
  return configuredPath ? resolveCodexCliLaunchPath(configuredPath) : configuredPath;
}

function canonicalCodexExecutablePath(binaryPath: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(binaryPath);
  } catch {
    canonical = path.resolve(binaryPath);
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** Check the exact user-selected executable and its local login state before model egress is allowed. */
async function verifyCodexCli(binaryPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  return verifyCodexCliPreflight(binaryPath, env, runCodexCli);
}

async function runCodexCli(binaryPath: string, args: string[], env: NodeJS.ProcessEnv) {
  const cwd = cliCheckFolder();
  return runCodexCliProbe(binaryPath, args, env, (proc) => { killProcessTree(proc, resolveHostProgram); }, cwd);
}

/**
 * The host-owned folder a CLI check or update terminal starts in, prepared and checked outside every workspace folder,
 * also after links are resolved. Throws with the reason, so nothing starts in the extension host's current directory.
 */
function cliCheckFolder(): string {
  return prepareNeutralFolder(
    extensionContext ? path.join(extensionContext.globalStorageUri.fsPath, 'cli-runtime-check') : undefined,
    (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  );
}

/** The Claude program a start uses now: unode.claudeCliPath, or the PATH lookup used before 0.9.96. */
function currentClaudeLaunch(): ClaudeCliLaunch {
  return resolveClaudeCliLaunch(configuredSetting<string>('claudeCliPath', ''), resolveHostProgram);
}

const CLAUDE_CHECK_CREDENTIAL_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

/** Start one Claude program with `--version` and read its version. */
async function checkClaudeCliVersion(program: string, shell: boolean): Promise<string> {
  const cwd = cliCheckFolder();
  const result = await runCliProbe(program, ['--version'], process.env, (proc) => { killProcessTree(proc, resolveHostProgram); }, {
    label: 'Claude CLI', credentialKeys: CLAUDE_CHECK_CREDENTIAL_KEYS, shell, cwd,
  });
  const version = result.code === 0 ? parseClaudeCliVersion(result.output) : undefined;
  if (!version) {
    throw new Error(`Claude CLI version check failed for ${program} (exit ${result.code ?? 'none'}${result.signal ? `, signal ${result.signal}` : ''}; ${result.output.slice(0, 400) || 'no output'}).`);
  }
  return version;
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

/**
 * v0.9.99: wait until no agent using this gateway is mid-turn, then let the edit be saved. The person is told once
 * that the change waits and how to apply it now; nothing is refused. Agents restart before their next request on
 * the changed profile, as before.
 */
function customGatewayTurnsEnded(connectionId: string, gatewayName: string): Promise<void> {
  const busyAgentNames = () => sessionManager.getAll().filter((session) => {
    const selected = session.config.route?.connectionId
      ?? connectionIdForProviderId(session.config.provider.providerId, effectiveConnectionRegistry);
    return selected === connectionId && isCustomGatewayEditBlockedStatus(session.status);
  }).map((session) => session.config.name || session.id);
  return whenCustomGatewayTurnsEnd({
    busyAgentNames,
    onStatusChange: (listener) => {
      sessionManager.on('session.status', listener);
      sessionManager.on('session.stopped', listener);
      sessionManager.on('session.removed', listener);
      return () => {
        sessionManager.off('session.status', listener);
        sessionManager.off('session.stopped', listener);
        sessionManager.off('session.removed', listener);
      };
    },
  }, (names) => { void vscode.window.showInformationMessage(customGatewayEditWaitingMessage(gatewayName, names)); });
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
  const save = await vscode.window.showInformationMessage(
    `Create ${displayName} at ${endpointBase}?`,
    {
      modal: true,
      detail: 'Background requests: none. Custom gateways currently load models, balances, and other metadata only after a user action. Saving this gateway does not authorize automatic network traffic.',
    },
    'Not now',
    'Create gateway',
  );
  if (save !== 'Create gateway') { return; }
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
  const changesProfile = displayName !== profile.presentation.displayName || endpointBase !== profile.presentation.endpointDefault;
  if (!changesProfile && keyAction.action === 'keep') { return; }

  const affected = changesEndpointOrKey ? customGatewayReferences(connectionId) : [];
  const affectedDetail = affected.length > 0
    ? ` Known local references: ${affected.join(', ')}.`
    : '';
  const confirmed = await vscode.window.showWarningMessage(
    `Save changes to ${profile.presentation.displayName}?${changesEndpointOrKey ? ` Existing agents must restart before another request.${affectedDetail}` : ''}`,
    { modal: true },
    'Keep current settings',
    'Save changes',
  );
  if (confirmed !== 'Save changes') { return; }
  if (changesEndpointOrKey) {
    await customGatewayTurnsEnded(connectionId, profile.presentation.displayName);
  }

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
  const endpointBase = await promptCustomGatewayEndpoint('Edit custom gateway endpoint', profile.presentation.endpointDefault);
  if (!endpointBase || endpointBase === profile.presentation.endpointDefault) { return; }
  const affected = customGatewayReferences(connectionId);
  const affectedDetail = affected.length > 0
    ? ` Known local references: ${affected.join(', ')}.`
    : ' No known local agent, default, or Smart Mode reference was found.';
  const confirmed = await vscode.window.showWarningMessage(
    `Change ${profile.presentation.displayName} endpoint from ${profile.presentation.endpointDefault} to ${endpointBase}? Existing agents must restart before another request.${affectedDetail}`,
    { modal: true },
    'Keep current endpoint',
    'Change endpoint',
  );
  if (confirmed !== 'Change endpoint') { return; }
  await customGatewayTurnsEnded(connectionId, profile.presentation.displayName);
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
  const apiKey = await promptCustomGatewayApiKey(`Replace API key for ${profile.presentation.displayName}`);
  if (!apiKey) { return; }
  await customGatewayTurnsEnded(connectionId, profile.presentation.displayName);
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
  const confirmed = await vscode.window.showWarningMessage(
    `Clear the stored API key for ${profile.presentation.displayName}? Agents using it cannot start until a key is replaced.`,
    { modal: true },
    'Keep key',
    'Clear key',
  );
  if (confirmed !== 'Clear key') { return; }
  await customGatewayTurnsEnded(connectionId, profile.presentation.displayName);
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
  void showResultNotice('information', `${tested.displayName} responded to a model catalog request.`);
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
    'Keep gateway',
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
    void showResultNotice('information', profile?.availabilityMessage ?? 'This connection is not available in this release.');
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

function cliProviderForConnection(connectionOrProviderId: string): CliRuntimeProvider | undefined {
  const connectionId = connectionIdForProviderId(connectionOrProviderId, effectiveConnectionRegistry);
  const profile = connectionId ? connectionProfile(connectionId, effectiveConnectionRegistry) : undefined;
  return profile?.authKind === 'codex-cli' || profile?.authKind === 'claude-cli' ? profile.authKind : undefined;
}

/**
 * v0.9.106 (retest R3): an agent is starting and no program is set for its CLI, as in a profile that never chose a
 * Codex CLI. Asks with Check / choose CLI, the same list, checks and confirmation, under a title that says why it
 * opened. Settles once the choice was saved or declined; the start reads the setting again and, with nothing chosen,
 * is refused with the way out. Nothing is asked in a window that may not start programs.
 */
async function chooseMissingCliProgram(provider: CliRuntimeProvider): Promise<void> {
  if (!vscode.workspace.isTrusted || hostShutdown.started || workspaceBinding.isStale()) return;
  const label = CLI_PROVIDER_LABEL[provider];
  try {
    // v0.9.106 (retest R3): the list comes first. The latest version is looked up only if registry.npmjs.org is already
    // allowed; the metadata question is left to Check / choose CLI in Settings.
    await chooseCliRuntime(provider, cliRuntimePort(provider, `An agent needs a ${label} to start: choose one`, 'only-if-allowed'));
  } catch (error) {
    outputChannel.warn(`UnodeAi could not ask for a ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Check / choose CLI. v0.9.106 (setup guide; Codex's design PASS R2): it also tells what it did. 'changed' only when a
 * program was chosen, checked and confirmed; a cancelled pick, a kept program or a refusal is 'unchanged'. Every caller
 * that ignores the outcome (Settings, first use, the update instructions, the too-old notice) behaves as before.
 */
async function chooseCliExecutable(connectionOrProviderId: string): Promise<CliChoiceOutcome> {
  const provider = cliProviderForConnection(connectionOrProviderId);
  if (!provider) return 'unchanged';
  const choice = await chooseCliRuntime(provider, cliRuntimePort(provider));
  if (choice?.latest && compareCliVersions(choice.version, choice.latest) === -1) void offerCliUpdate(provider, choice.version, choice.latest);
  if (provider === 'codex-cli' && choice?.changed) {
    const pick = await vscode.window.showInformationMessage(
      `Codex models are listed per program. Refresh the list from Codex ${choice.version}?`,
      'Refresh models from Codex',
    );
    if (pick === 'Refresh models from Codex') {
      try {
        const result = await loadCodexModelsForPicker('codex');
        void showResultNotice('information', result.message);
      } catch (error) {
        void showResultNotice('warning', `UnodeAi could not refresh Codex models: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return choice?.changed ? 'changed' : 'unchanged';
}

/** What UnodeAi starts for a CLI now, found without starting it. */
function currentCliRuntime(provider: CliRuntimeProvider): CurrentCliRuntime {
  if (provider === 'claude-cli') {
    const settingValue = configuredSetting<string>('claudeCliPath', '').trim();
    try {
      const launch = currentClaudeLaunch();
      return { program: launch.executable, origin: launch.origin, source: classifyCliSource(provider, settingValue || launch.executable), settingValue };
    } catch (error) {
      return {
        origin: settingValue ? 'configured' : 'none',
        problem: settingValue
          ? (error instanceof Error ? error.message : String(error))
          : 'UnodeAi found no claude.cmd on PATH. Choose the Claude CLI with Check / choose CLI.',
        settingValue,
      };
    }
  }
  const settingValue = configuredSetting<string>('codexCliPath', '').trim();
  if (!settingValue) return { origin: 'none', problem: 'No Codex CLI is selected. Choose it with Check / choose CLI.', settingValue };
  try {
    const program = configuredCodexCliPath();
    if (!existsSync(program)) throw new Error(`The selected Codex CLI was not found at ${program}.`);
    return { program, origin: 'configured', source: classifyCliSource(provider, settingValue), settingValue };
  } catch (error) {
    return { origin: 'configured', problem: error instanceof Error ? error.message : String(error), settingValue };
  }
}

/**
 * `latestLookup`: `ask` asks for registry.npmjs.org in the metadata consent prompt when it is not allowed yet, as
 * Check / choose CLI in Settings always did. `only-if-allowed` never asks: without that consent the latest version is
 * not looked up (v0.9.106, the list an agent's start opens).
 */
function cliRuntimePort(
  provider: CliRuntimeProvider,
  title = `Check / choose the ${CLI_PROVIDER_LABEL[provider]}`,
  latestLookup: 'ask' | 'only-if-allowed' = 'ask',
): CliRuntimeChooserPort {
  const label = CLI_PROVIDER_LABEL[provider];
  const backendKind = provider === 'claude-cli' ? 'claude' : 'codex';
  return {
    current: () => currentCliRuntime(provider),
    latest: () => lookUpLatestCliVersion(provider, 'Check / choose CLI', latestLookup),
    candidates: (): CliRuntimeCandidate[] => provider === 'claude-cli'
      ? discoverClaudeCliCandidates(process.env)
      : [
        ...discoverCodexCliCandidates(process.env).map((candidate): CliRuntimeCandidate => ({
          path: candidate.path, source: candidate.source, route: 'native',
        })),
        ...discoverCodexExtensionCandidates(process.env),
      ],
    lastCheck: (program) => lastCliRuntimeCheck(provider, program),
    pick: async (items, placeHolder) => {
      const picked = await vscode.window.showQuickPick(
        items.map((item) => ({ label: item.label, description: item.description, ...(item.kind === 'candidate' ? { detail: item.detail } : {}), item })),
        { title, placeHolder, matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true },
      );
      return picked?.item;
    },
    browse: async () => (await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: `Choose the ${label} program`,
      filters: process.platform === 'win32' ? { Programs: ['exe', 'cmd'] } : undefined,
    }))?.[0]?.fsPath,
    prepare: (chosen) => {
      if (provider === 'claude-cli') {
        const launch = resolveClaudeCliLaunch(path.resolve(chosen), resolveHostProgram);
        return {
          settingValue: path.resolve(chosen), program: launch.executable, route: launch.route,
          source: classifyCliSource(provider, chosen), stamp: requireProgramStamp(launch.executable),
        };
      }
      // Codex is never started through a shell: npm's .cmd resolves to the native program beside it. The resolved
      // program is saved, not a link to it: a version manager that moves a link needs Check / choose CLI again.
      const program = resolveHostProgram(resolveCodexCliLaunchPath(path.resolve(chosen)));
      return { settingValue: program, program, route: 'native', source: classifyCliSource(provider, chosen), stamp: requireProgramStamp(program) };
    },
    // v0.9.97: what is known of the program without starting it; the compatibility check and the adoption record
    // follow only the person's OK to the adoption question.
    facts: async (prepared) => {
      const known = await cliRuntimeHost().facts(provider, prepared.program);
      if (known.closure) chooserClosures.set(`${provider}|${prepared.program}`, known.closure);
      return known;
    },
    probe: (prepared) => cliRuntimeHost().probe(provider, { executable: prepared.program, shell: prepared.route === 'npm-cmd' }),
    adopt: async (prepared, _facts, outcome) => {
      const closure = chooserClosures.get(`${provider}|${prepared.program}`);
      if (!closure) throw new Error('UnodeAi no longer holds the checked files of this program. Choose it again.');
      cliRuntimeHost().adopt(provider, closure, outcome);
    },
    recordRunAnyway: (_prepared, facts) => recordCliRunAnyway(provider, facts.closureDigest, facts.compatibilityPolicyId!),
    check: (prepared) => provider === 'claude-cli'
      ? checkClaudeCliVersion(prepared.program, prepared.route === 'npm-cmd')
      : verifyCodexCli(prepared.program, process.env),
    confirm: (question) => confirmCliRuntime(question),
    persist: async (settingValue) => {
      await vscode.workspace.getConfiguration('unode').update(provider === 'claude-cli' ? 'claudeCliPath' : 'codexCliPath', settingValue, vscode.ConfigurationTarget.Global);
      SettingsPanel.refreshCurrent();
    },
    record: (check) => recordCliRuntimeCheck(check),
    blocked: () => hostShutdown.started || workspaceBinding.isStale(),
    runningAgents: () => sessionManager.getAll().filter((session) =>
      (session.config.backend ?? defaultBackendKind(session.config, effectiveConnectionRegistry)) === backendKind
      && session.pid !== undefined).length,
    report: (kind, message) => {
      void (kind === 'warning' ? showResultNotice('warning', message) : showResultNotice('information', message));
    },
    now: () => new Date(),
    samePath: sameHostPath,
  };
}

function requireProgramStamp(program: string): string {
  const stamp = cliProgramStamp(program);
  if (!stamp) throw new Error(`UnodeAi could not read the program file ${program}.`);
  return stamp;
}

const KEEP_CURRENT_CLI = 'Keep current CLI';
const USE_THIS_CLI = 'Use this CLI';

async function confirmCliRuntime(question: CliRuntimeConfirmation): Promise<boolean> {
  const label = CLI_PROVIDER_LABEL[question.provider];
  // v0.9.99: a version a release marked bad: a warning with Run anyway (the person's own program, their choice).
  if (question.kind === 'run-anyway' && question.next.facts.verdict === 'blocked-bad') {
    const facts = question.next.facts;
    const choice = await vscode.window.showWarningMessage(
      `A UnodeAi release marked this ${label} version bad: ${facts.reason}.`,
      {
        modal: true,
        detail: `Program: ${question.next.program} (${facts.version ?? 'version unknown'})\n\n`
          + 'It may not work correctly with UnodeAi. '
          + (facts.runAnyway ? '' : 'Run anyway first runs the compatibility check and uses the program only if it passes. ')
          + 'Every start of it shows this warning. Updating the program, or choosing another one here, is the better fix.',
      },
      'Not now',
      'Run anyway',
    );
    return choice === 'Run anyway';
  }
  // v0.9.97: an unqualified program gets the adoption question, whose lines and buttons are the facts' own.
  if (question.kind === 'adopt' && question.next.facts.verdict === 'needs-adoption') {
    const dialog = question.next.facts.dialog;
    const choice = await vscode.window.showWarningMessage(dialog.title, { modal: true, detail: dialog.lines.join('\n') }, 'Not now', 'Check and use this program');
    if (choice !== 'Check and use this program') return false;
    return true;
  }
  const now = question.current.program
    ? `${question.current.program} (${question.currentVersion ?? 'version not checked'})`
    : 'none';
  const choice = await vscode.window.showWarningMessage(
    `Use this ${label}?`,
    {
      modal: true,
      detail: `Now: ${now}\nNew: ${question.next.program} (${question.next.version}, ${question.next.source})\n`
        + (question.latest ? `Latest published: ${question.latest}\n` : '')
        + '\nAgents that are already running keep their program until you restart them. Choosing a program sends nothing to a model and grants nothing.',
    },
    KEEP_CURRENT_CLI,
    USE_THIS_CLI,
  );
  if (choice !== USE_THIS_CLI) return false;
  return true;
}

/**
 * The latest published version of a CLI, from npm's public `latest` document for its package. Looked up only from
 * Check / choose CLI and Update instructions, only once the user allows registry.npmjs.org in the metadata consent
 * prompt, and only through the consent-gated metadata fetch. No key, prompt or workspace content is sent; the answer
 * is bounded in time and size, and only its version is kept. A lookup younger than ten minutes is reused.
 */
async function lookUpLatestCliVersion(
  provider: CliRuntimeProvider,
  requester: string,
  consent: 'ask' | 'only-if-allowed' = 'ask',
): Promise<CliLatestLookup> {
  const label = CLI_PROVIDER_LABEL[provider];
  const known = cliLatestVersions[provider];
  if (known && Date.now() - Date.parse(known.checkedAt) < CLI_LATEST_REUSE_MS) {
    return { version: known.version, note: `Latest published on npm: ${label} ${known.version}.` };
  }
  // v0.9.106 (retest R3): the list an agent's start opens asks nothing before it. Not allowed yet: not looked up.
  if (consent === 'only-if-allowed' && !hasMetadataConsent(CLI_LATEST_HOST)) {
    return { note: `The latest ${label} version was not looked up.` };
  }
  await requestMetadataConsent(
    [{ host: CLI_LATEST_HOST, purposes: ['cli-version'], authenticated: false }],
    { requester },
  );
  if (!hasMetadataConsent(CLI_LATEST_HOST)) {
    return { note: `The latest ${label} version was not looked up, because ${CLI_LATEST_HOST} is not allowed.` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLI_LATEST_LIMITS.timeoutMs);
  try {
    const version = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Looking up the latest ${label} on npm` },
      async () => {
        const response = await metadataFetch(cliLatestVersionUrl(provider), {
          headers: { accept: 'application/json' }, signal: controller.signal, redirect: 'error',
        });
        if (!response.ok) throw new Error(`npm answered ${response.status}.`);
        return parseNpmLatestVersion(provider, await readBoundedText(response, CLI_LATEST_LIMITS.bytes));
      },
    );
    cliLatestVersions = { ...cliLatestVersions, [provider]: { version, checkedAt: new Date().toISOString() } };
    await extensionContext?.globalState.update(CLI_LATEST_VERSIONS_KEY, cliLatestVersions);
    SettingsPanel.refreshCurrent();
    return { version, note: `Latest published on npm: ${label} ${version}.` };
  } catch (error) {
    const reason = controller.signal.aborted
      ? `npm did not answer within ${CLI_LATEST_LIMITS.timeoutMs / 1000} seconds.`
      : error instanceof Error ? error.message : String(error);
    return { note: `The latest ${label} version could not be looked up: ${reason.slice(0, 300)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Types the update command in a new terminal, without pressing Enter: the user reads it and runs it. The terminal is
 * started with the shell the command was written for, in UnodeAi's own folder rather than the workspace. Starting a
 * terminal starts that shell with the user's own startup files and settings; the update command itself runs only
 * when the user presses Enter.
 */
function typeCliUpdateInTerminal(provider: CliRuntimeProvider, line: string, shellPath: string): void {
  const label = CLI_PROVIDER_LABEL[provider];
  let cwd: string;
  try {
    cwd = cliCheckFolder();
  } catch (error) {
    void showResultNotice('warning', `${error instanceof Error ? error.message : String(error)} Copy the command from Update instructions instead.`);
    return;
  }
  const name = `UnodeAi: update ${label}`;
  const terminal = vscode.window.createTerminal({ name, cwd, shellPath, isTransient: true });
  terminal.show();
  terminal.sendText(line, false);
  const backendKind = provider === 'claude-cli' ? 'claude' : 'codex';
  const running = sessionManager.getAll().filter((session) =>
    (session.config.backend ?? defaultBackendKind(session.config, effectiveConnectionRegistry)) === backendKind
    && session.pid !== undefined).length;
  const stop = running > 0
    ? ` ${running === 1 ? 'One agent uses' : `${running} agents use`} this CLI now; stop ${running === 1 ? 'it' : 'them'} first, or the update may not be able to replace the program.`
    : '';
  void showResultNotice('information', `The update command is typed in the terminal "${name}" and has not run. Press Enter there to run it.${stop} `
    + `When it has finished, use Check / choose CLI to check the ${label} again.`);
}

/** After a check found the program older than the latest published version. */
async function offerCliUpdate(provider: CliRuntimeProvider, version: string, latest: string): Promise<void> {
  const label = CLI_PROVIDER_LABEL[provider];
  const pick = await vscode.window.showWarningMessage(
    `${label} ${version} is older than the latest published version, ${latest}.`,
    'Update instructions',
  );
  if (pick === 'Update instructions') await showCliUpdateInstructions(provider === 'claude-cli' ? 'anthropic' : 'codex');
}

/** How to update the installation UnodeAi starts. The command is copied, or typed in a terminal; UnodeAi runs none. */
async function showCliUpdateInstructions(connectionOrProviderId: string): Promise<void> {
  const provider = cliProviderForConnection(connectionOrProviderId);
  if (!provider) return;
  const label = CLI_PROVIDER_LABEL[provider];
  const current = currentCliRuntime(provider);
  if (!current.program) {
    void showResultNotice('warning', `${current.problem ?? `No ${label} is selected.`}`);
    return;
  }
  const program = current.program;
  const instructions = cliUpdateInstructions(provider, program, current.source ?? 'chosen file');
  const latest = await lookUpLatestCliVersion(provider, 'Update instructions');
  const measured = lastCliRuntimeCheck(provider, program)?.version;
  // The command is written for this shell, and the terminal is started with this shell, whatever the default is then.
  const shellPath = vscode.env.shell;
  const shell = cliTerminalShell(shellPath);
  const typed = instructions.update && shell ? renderCliUpdateCommand(instructions.update, shell) : undefined;
  const copied = typed ?? (instructions.update
    ? renderCliUpdateCommand(instructions.update, process.platform === 'win32' ? 'cmd' : 'posix')
    : undefined);
  const items = [
    ...(typed ? [{ label: '$(terminal) Update in terminal', detail: `Types "${typed}" in a new terminal. It runs only when you press Enter there.`, action: 'terminal' as const }] : []),
    ...(copied ? [{ label: '$(copy) Copy the update command', detail: copied, action: 'copy' as const }] : []),
    { label: '$(link-external) Open the official setup guide', detail: instructions.docsUrl, action: 'docs' as const },
    { label: '$(search) Check / choose CLI…', detail: 'Check the program again after updating, or choose another installation.', action: 'check' as const },
  ];
  const versions = `${measured ? `This program was measured at ${measured}.` : 'Its version was not checked yet.'} ${latest.note}`;
  const picked = await vscode.window.showQuickPick(items, {
    title: `Update ${label}: ${program}`, placeHolder: `${instructions.summary} ${versions}`, ignoreFocusOut: true,
  });
  if (!picked) return;
  if (picked.action === 'terminal' && typed) {
    typeCliUpdateInTerminal(provider, typed, shellPath);
  } else if (picked.action === 'copy' && copied) {
    await vscode.env.clipboard.writeText(copied);
    void showResultNotice('information', `Update command copied. Run it in a terminal yourself, then use Check / choose CLI to check the ${label} UnodeAi starts again.`);
  } else if (picked.action === 'docs') {
    await vscode.env.openExternal(vscode.Uri.parse(instructions.docsUrl));
  } else if (picked.action === 'check') {
    await chooseCliExecutable(connectionOrProviderId);
  }
}

/** Settings shows the program UnodeAi starts and what was measured about it, without starting anything. */
function cliRuntimeStatus(connectionOrProviderId: string) {
  const provider = cliProviderForConnection(connectionOrProviderId);
  if (!provider) return undefined;
  const current = currentCliRuntime(provider);
  const check = current.program ? lastCliRuntimeCheck(provider, current.program) : undefined;
  const latest = cliLatestVersions[provider];
  return {
    program: current.program,
    origin: current.origin,
    source: current.source,
    problem: current.problem,
    version: check?.version,
    checkedAt: check?.checkedAt,
    changedSinceCheck: !check && !!current.program && cliRuntimeCheckOutdated(provider, current.program),
    latest: latest?.version,
    latestCheckedAt: latest?.checkedAt,
    behindLatest: !!check && !!latest && compareCliVersions(check.version, latest.version) === -1,
  };
}

const OPEN_PROVIDER_SETTINGS = 'Open Settings: Providers';

/**
 * v0.9.106 (NC-1): an agent's start was refused because no program is chosen for its CLI. The chat and the refused task
 * already carry the numbered steps; this is the direct way there, as the older-CLI repair below offers its own: one
 * button that opens UnodeAi Settings on the Providers tab, where the CLI's card has Check / choose CLI…. It changes no
 * setting. Each refused start offers it once, whichever way the start came (a message, the PM's dispatch, Start).
 */
function offerCliProgramChoice(agentId: string): void {
  const session = sessionManager?.get(agentId);
  if (!session) return;
  const kind = session.config.backend ?? defaultBackendKind(session.config, effectiveConnectionRegistry);
  const provider: CliRuntimeProvider | undefined = kind === 'claude' ? 'claude-cli' : kind === 'codex' ? 'codex-cli' : undefined;
  if (!provider) return;
  const label = CLI_PROVIDER_LABEL[provider];
  void Promise.resolve(vscode.window.showWarningMessage(
    `${session.config.name} did not start: no ${label} is selected. In UnodeAi Settings, open Providers, then choose `
      + `Check / choose CLI… on the ${label} card. Then try again.`,
    OPEN_PROVIDER_SETTINGS,
  )).then((pick) => {
    if (pick === OPEN_PROVIDER_SETTINGS) void vscode.commands.executeCommand('unode.openSettings', 'providers');
  }, () => undefined);
}

/**
 * A provider error that names a too-old CLI. The agent's chat gets a host line; the user gets a notice with the
 * repair actions, once. The failed turn stays failed and nothing is resent.
 */
function cliRuntimeFailureNotice(agentId: string, text: string, messageId: string): { noticeKey: string; text: string } | undefined {
  const session = sessionManager?.get(agentId);
  if (!session) return undefined;
  const kind = session.config.backend ?? defaultBackendKind(session.config, effectiveConnectionRegistry);
  const provider: CliRuntimeProvider | undefined = kind === 'claude' ? 'claude-cli' : kind === 'codex' ? 'codex-cli' : undefined;
  const failure = provider ? classifyCliRuntimeFailure(provider, text) : undefined;
  if (!provider || !failure) return undefined;
  const program = (provider === 'claude-cli' ? claudeLaunchByAgent.get(agentId)?.executable : undefined)
    ?? currentCliRuntime(provider).program;
  const check = program ? lastCliRuntimeCheck(provider, program) : undefined;
  const label = CLI_PROVIDER_LABEL[provider];
  const measured = check ? `UnodeAi last measured ${check.version} for it.` : 'UnodeAi has not measured its version.';
  const notice = `${label}: the provider says this CLI is ${failure.reportedVersion} and that the model needs ${failure.requiredVersion} or newer. `
    + `UnodeAi started ${program ?? 'an unknown program'}. ${measured} Update that installation, or choose another one with `
    + 'Check / choose CLI, then restart this agent and send your message again. Nothing was resent.';
  const key = `cli-runtime:${messageId}`;
  if (!offeredCliRepairs.has(key)) {
    offeredCliRepairs.add(key);
    void vscode.window.showWarningMessage(
      `${session.config.name}: the ${label} is older than this model needs (${failure.reportedVersion}; ${failure.requiredVersion} or newer is required).`,
      'Check / choose CLI',
      'Update instructions',
    ).then((pick) => {
      if (pick === 'Check / choose CLI') void chooseCliExecutable(provider === 'claude-cli' ? 'anthropic' : 'codex');
      else if (pick === 'Update instructions') void showCliUpdateInstructions(provider === 'claude-cli' ? 'anthropic' : 'codex');
    });
  }
  return { noticeKey: key, text: notice };
}

/**
 * The Codex program a model refresh uses, captured before its first check: the setting, the program and the
 * identity of its file. With nothing configured, the one the user chooses, checks and saves in Check / choose CLI.
 */
async function configuredOrChosenCodexExecutable(): Promise<CodexModelSelection | undefined> {
  const setting = configuredSetting<string>('codexCliPath', '').trim();
  if (!setting) {
    const choice = await chooseCliRuntime('codex-cli', cliRuntimePort('codex-cli'));
    return choice?.changed ? { setting: choice.settingValue, program: choice.program, version: choice.version, stamp: choice.stamp } : undefined;
  }
  // v0.9.97: the configured program runs for its checks only once UnodeAi qualified it or the person chose it.
  const program = (await cliRuntimeHost().resolver.resolveExternalTransient({ provider: 'codex-cli' })).physical;
  const stamp = cliProgramStamp(program) ?? '';
  const version = await verifyCodexCli(program, process.env);
  await recordCliRuntimeCheck({ provider: 'codex-cli', program, version, checkedAt: new Date().toISOString(), stamp });
  return { setting, program, version, stamp };
}

/**
 * Whether a Codex selection is still what UnodeAi would start: the same setting, resolving to the same program file,
 * with the window not closing and its workspace unchanged.
 */
function codexSelectionCurrent(selection: CodexModelSelection): boolean {
  if (hostShutdown.started || workspaceBinding.isStale()) return false;
  if (configuredSetting<string>('codexCliPath', '').trim() !== selection.setting) return false;
  try {
    const program = configuredCodexCliPath();
    return !!selection.stamp && sameHostPath(program, selection.program) && cliProgramStamp(program) === selection.stamp;
  } catch {
    return false;
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
    if (effectiveIntegrationGrants(info.config).some((g) => g.serverId === serverId)) {
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
  const backend = config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry);
  const codexNativeDefault = backend === 'codex' && (
    config.toolCeiling === 'native-default'
    || (config.toolCeiling === undefined && (!config.allowedTools || config.allowedTools.length === 0))
  );
  const allows = (tool: string) => codexNativeDefault
    || !Array.isArray(config.allowedTools)
    || config.allowedTools.includes(tool);
  const c = profile.capabilities;
  const read = c.read && (allows('read') || allows('search'));
  const write = c.write && allows('write');
  const commandAvailability = liveCommandCapability({ connection: c.command, tool: allows('execute'),
    trusted: vscode.workspace.isTrusted,
    policy: new AgentCommandPolicy(commandPolicy, config.commandNarrowing, config.name).approvalMode });
  const shell = commandAvailability.canRequest;
  const verificationSensors: VerificationSensorKind[] = [
    ...(shell ? ['command-exit-zero' as const] : []),
    ...(write ? ['recorded-file-effect' as const] : []),
    ...(backend === 'openai-compat' && write && configuredSetting<boolean>('engine.postWriteDiagnostics', true)
      ? ['editor-diagnostics-clean' as const] : []),
    ...((backend === 'openai-compat' || backend === 'claude' || backend === 'codex') && canDelegate(config) &&
      vscode.workspace.isTrusted && !config.folderAccess?.length &&
      !!resolveVerifyCommand(configuredSetting<string>('verifyCommand', ''), projectCommandInfo())
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
    read, write, shell, commandAvailability, verificationSensors, toolFamilies,
    backend,
    taskScope: taskScopeCapabilityFor(config),
  };
}

/**
 * Refresh the cost table from live gateway /api/pricing endpoints — the Roam gateway (unode.baseUrl)
 * plus any new-api-compatible gateways the user lists in unode.pricingSources. Called by the daily timer
 * and user-initiated price/model surfaces, so prices refresh online and stay current. Best-effort:
 * a failing source logs and leaves the static/override table in place.
 *
 * EVERY source is filtered through `hasMetadataConsent` — a price refresh rides on an approved host or it
 * does not happen. On a fresh install the background call is a no-op: zero network.
 *
 * `interactive` is the difference between a background refresh and a user asking for prices. The daily
 * background timer may NEVER prompt — it skips silently and the built-in table stands in. A
 * user-initiated path (model picker, provider switch, the Refresh Model Prices command) MAY ask, because the
 * user just asked for the thing the question is about. Pass it only from a path a user actually clicked.
 */
async function pricingSources(): Promise<Array<{ providerId?: string; url: string; apiKey?: string; group?: string }>> {
  // These are profile-pinned endpoints. `unode.baseUrl` and `unode.unodeBaseUrl` may exist in old
  // settings files but must never redirect a stored gateway key, even for metadata requests.
  const roamBase = providerEndpoint('roam') ?? ROAM_DEFAULT_BASE_URL;
  const unodeBase = providerEndpoint('unode') ?? UNODE_DEFAULT_BASE_URL;
  // A billing group belongs to the KEY, not to the account (confirmed with the gateway operator,
  // 2026-08-21): two keys on one account can sit in different groups, with different prices AND different
  // callable models. A single global string could not express that — pinning it correctly for one gateway
  // made it wrong for the other — so the setting also accepts a map keyed by connection id.
  const priceGroupFor = readPriceGroupSetting(configuredSetting<unknown>('priceGroup', ''));
  // Each gateway is fetched WITH that gateway's own key so /api/pricing returns the account's discount
  // group (group_ratio); keys are NOT sent to third-party pricingSources. Roam = weroam, Unode = unodetech.
  const roamKeyName = connectionProfile('roam', effectiveConnectionRegistry)?.apiKeySecretName;
  const unodeKeyName = connectionProfile('unode', effectiveConnectionRegistry)?.apiKeySecretName;
  const roamKey = roamKeyName ? await secrets.get(roamKeyName) : undefined;
  const unodeKey = unodeKeyName ? await secrets.get(unodeKeyName) : undefined;
  return [
    { providerId: 'roam', url: roamBase, apiKey: roamKey, group: priceGroupFor('roam') },
    { providerId: 'unode', url: unodeBase, apiKey: unodeKey, group: priceGroupFor('unode') },
    ...configuredSetting<string[]>('pricingSources', []).map((url) => ({ url })),
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
async function ensureModelPickerConsent(providerId: string, endpointBaseUrl?: string, isCurrent: () => boolean = () => true): Promise<void> {
  const catalogUrl = configuredSetting<string>('modelCatalogUrl', '') || undefined;
  // Only the SELECTED provider's own price source. Direct providers (OpenAI, Anthropic…) have none — their
  // prices come from the built-in table — so for them this is simply absent, and nothing is asked about it.
  const ownPriceSource = (await pricingSources()).find((s) => s.providerId === providerId);
  const connectionId = connectionIdForProviderId(providerId, effectiveConnectionRegistry);
  const secretRef = connectionId ? connectionProfile(connectionId, effectiveConnectionRegistry)?.apiKeySecretName : undefined;
  const apiKey = secretRef ? await secrets.get(secretRef) : undefined;
  if (!isCurrent()) return;
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
        `${reason === 'Settings' ? 'While opening Settings' : 'While refreshing model prices'}, UnodeAi set a price coefficient of 1 (list price) for ${result.added.length} existing connection(s). `
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

/**
 * A price-coefficient read repair is maintenance attached to a user action, never a prerequisite for it.
 * Keep the promise contained here so command handlers receive no repair promise they could put ahead of
 * the work the user requested.
 */
function startPriceMultiplierReadRepairAfterUserAction(
  reason: 'Settings' | 'Refresh model prices',
  onChanged?: () => void,
): void {
  void repairPriceMultipliersAfterUserAction(reason).then(
    (result) => {
      if (result.changed) {
        onChanged?.();
      }
    },
    (err) => {
      const detail = err instanceof Error ? err.message : String(err);
      outputChannel.warn(`[price coefficient read repair after ${reason}] skipped: ${detail}`);
      const uninterruptedAction = reason === 'Settings'
        ? 'UnodeAi Settings opened'
        : 'UnodeAi: Refresh Model Prices completed';
      void vscode.window.showWarningMessage(
        `${uninterruptedAction}, but the editor could not update unode.priceMultiplier. `
        + 'Fix errors or warnings in User Settings JSON, then run the command again.',
        'Open User Settings (JSON)',
      ).then((choice) => {
        if (choice === 'Open User Settings (JSON)') {
          void vscode.commands.executeCommand('workbench.action.openSettingsJson');
        }
      });
    },
  );
}

type PriceRefreshTrigger = 'daily timer' | 'explicit command' | 'credential change' | 'Add Agent model picker' | 'Agent Builder model picker' | 'Settings Smart picker' | 'post-turn';

async function refreshPrices(opts: {
  interactive?: boolean;
  scope?: string;
  automatic?: boolean;
  trigger?: PriceRefreshTrigger;
} = {}): Promise<void> {
  const trigger = opts.trigger ?? 'explicit command';
  outputChannel.info(`[price-refresh] trigger="${trigger}" scope="${opts.scope ?? 'all'}" automatic=${opts.automatic === true}.`);
  const livePriceService = getLivePrices();
  const priceTable = getPricing();
  // Read per refresh rather than cached at activation: a user who fixes their coefficient wants the next
  // refresh to use it, not the next window.
  const priceMultiplierFor = readPriceMultiplierSetting(
    configuredSetting<unknown>('priceMultiplier', {}),
  );
  // Scope BEFORE consent. Consent says which hosts may EVER be contacted; scope says which of those THIS
  // action contacts. Narrowing only the prompt was not enough: a user who had approved Roam and Unode last
  // week opened the OpenAI picker and — with no modal, because everything was already consented — still sent
  // both gateways a price request. The picker paths pass their providerId; the daily timer and the explicit
  // Refresh command stay unscoped, because there every gateway is legitimately in play.
  // (Codex, v0.9.29 review: the prompt scope and the actual reach must narrow together.)
  let configured = scopedSources(await pricingSources(), opts.scope);
  if (opts.automatic) {
    configured = filterAutomaticPricingSources(automaticRefreshSettings, configured);
  }
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
      // v0.9.89: a result fetched under an older credential generation never becomes an account price.
      const generationAtStart = providerId ? spendHost?.accountPrices.generation(providerId) : undefined;
      const fetchPrices = () => livePriceService.fetchGatewayPricesDetailed(
        url, apiKey, group, stated, { scope: providerId ?? url },
      );
      const refreshed = opts.automatic
        ? await automaticRefreshCoordinator.run(`prices:${providerId ?? url}`, fetchPrices)
        : await fetchPrices();
      if (!refreshed) {
        outputChannel.debug(`Automatic price refresh for ${providerId ?? url} is backing off after a failure.`);
        continue;
      }
      const { prices, resolution, cacheState, snapshot } = refreshed;
      if (providerId && generationAtStart !== undefined && snapshot) {
        spendHost?.accountPrices.record(providerId, generationAtStart, snapshot);
      }
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
    // Repository authority values are ignored and left untouched; only repair the user's own value.
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
  if (!rootWorkspaceState.get<boolean>(ROSTER_FLAG)) {
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
      const workspaceMigration = migrate(last);
      const team = await persistence.loadTeamConfig();
      if (team?.members?.length) {
        const r = migrate(team.members);
        if (r.changed) {
          await persistence.updateTeamConfig((current) => ({ ...current!, members: r.configs }), team.members);
          agentsMoved += r.changed;
        }
      }
      if (workspaceMigration.changed) {
        await persistence.saveAgents(workspaceMigration.configs);
        agentsMoved += workspaceMigration.changed;
      }
      await rootWorkspaceState.update(ROSTER_FLAG, true);
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

/** True once the roster is loaded, even an empty one; false when a route was refused and no agent was started. */
async function restoreRoster(): Promise<boolean> {
  const authorityMigrationWarnings = await persistence.migrateLegacyAgentAuthority();
  if (authorityMigrationWarnings.length > 0) {
    void showResultNotice('warning',
      `UnodeAi removed legacy roster authority that might have come from .unode/team.json: ${authorityMigrationWarnings.join('; ')} `
      + 'Re-enable trusted capabilities in the Agent Builder and approvals in the chat controls; project files cannot set a process environment.'
    );
  }
  // Load the host-owned MCP server registry first, so backends built below can resolve grants.
  const startupTeam = await persistence.loadTeamConfigForStartup();
  const teamConfig = startupTeam.kind === 'ready' ? startupTeam.document : undefined;
  teamCompactionOverrides = teamConfig?.smartCompactionProfiles;
  mcpRegistry.clear();
  for (const cfg of persistence.loadHostMcpServers()) {
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
    return false;
  }
  const legacyCommands = migrateLegacyCommandTools(agents);
  agents = legacyCommands.members;
  if (legacyCommands.added > 0) outputChannel.info(legacyCommandMigrationNotice(legacyCommands.added));
  const promptMigrationChanged = agents.reduce((changed, config) => migratePromptTemplateSource(config) || changed, false);
  if (routeMigrationChanged || promptMigrationChanged || legacyCommands.changed) {
    // Persist the explicit source marker immediately. This makes future upgrades deterministic while
    // preserving every prompt we could not prove was an untouched shipped default.
    try {
      if (lastUsed.length === 0 && teamConfig) {
        await persistence.updateTeamConfig((current) => ({ ...current!, members: agents }), teamConfig.members);
      }
      await persistence.saveAgents(agents);
    } catch (error) {
      outputChannel.error(`Roster migration persistence refused: ${String(error)}`);
      void showResultNotice('warning', 'This team is available in this window, but its updated settings could not be saved. You can save the team again later.');
    }
    if (routeMigrationChanged) {
      void vscode.window.showInformationMessage('UnodeAi updated this roster to versioned connection routes. Model names did not choose a new connection.');
    }
  }
  for (const config of agents) {
    sessionManager.create(config);
  }
  // v0.9.99: an agent whose saved connection this machine cannot migrate no longer stops the roster. It is held in
  // the repair state on its card, the others load, and one non-modal line says which agent and what to do.
  const held = agents.filter(hasUnavailableConnectionRepair).map((config) => config.name || config.id);
  if (held.length > 0) {
    outputChannel.warn(`Route migration held ${held.length} agent(s) for repair; the rest of the roster loaded.`);
    void vscode.window.showWarningMessage(`UnodeAi started this team without ${held.join(', ')}: `
      + `${held.length === 1 ? 'its connection is' : 'their connections are'} not available on this machine. `
      + 'Edit the agent to choose a connection, or recreate it.');
  }
  if (agents.length > 0) {
    outputChannel.info(
      `Restored ${agents.length} agent(s) from ${lastUsed.length > 0 ? 'last workspace state' : '.unode/team.json'}.`
    );
    teamViewProvider?.refresh();
  }
  if (mcpRegistry.size > 0) {
    outputChannel.info(`Loaded ${mcpRegistry.size} MCP server(s) from host-owned workspace state.`);
    registerReferencedMcpServers();
  }
  return true;
}


async function saveRoster(): Promise<void> {
  await agentRosterEdits.save();
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
// Native notification actions share a single, editor-owned row. Keep labels compact so all three
// remain readable in narrow sidebars and small editor windows.
const DISABLE_NATIVE_SUBAGENTS_ACTION = 'Disable subagents';
const LEARN_MORE_ACTION = 'Learn more';

function handleClaudeUnmediatedToolUse(agentId: string, tool: string, agentName: string): void {
  const message =
    `${agentName} used Claude's native ${tool} tool. Tool calls inside that subagent are mediated ` +
    `by UnodeAi's fail-closed PreToolUse gate, including command approval. ` +
    `You can disable Claude's native subagents for this agent only.`;
  outputChannel.warn(message);
  void vscode.window.showWarningMessage(
    message,
    STOP_AGENT_ACTION,
    DISABLE_NATIVE_SUBAGENTS_ACTION,
    LEARN_MORE_ACTION
  ).then((choice) => {
    if (choice === STOP_AGENT_ACTION) {
      stopPreparingMessages([agentId]);
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
  sessionManager.interrupt(agentId, undefined, undefined, 'host');
  void showResultNotice('information', `Disabled Claude native subagents for ${session.config.name}.`);
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
    void showResultNotice('warning', `Could not open SECURITY.md: ${String(err)}`);
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
    teamRosterRevision++;
    SettingsPanel.refreshTeamCurrent();
    if (orchestrationProgress.refreshNames()) publishDelegationProgress();
    refreshTeam();
    void firstUseController?.rosterChanged();
    MarketplacePanel.refreshCurrent();
    SetupGuidePanel.refreshCurrent();
    saveRosterInBackground();
    scheduleTeamRulesOnRosterChange();
  });
  sessionManager.on('session.removed', (e) => {
    // v0.9.99: a message to a removed agent that is still being prepared is never submitted.
    userRequestPreparations.cancel(e.sessionId);
    // v0.9.101 (H2a): a removed coordinator's waiting work ends; a later grant on its items starts nothing.
    for (const requestId of taskResumeRefs.endCoordinator(e.sessionId, 'coordinator-gone')) localReadScopeConsent.endPathAccessRequest(requestId);
    resultDeliveryHost.scope(e.sessionId, 'coordinator-removed');
    void agentToolAlwaysAllow?.forget(e.sessionId);
    // v0.9.99: what the removed agent's request still held gets the ordinary idle period.
    contentAssetStore?.release(userRequestHolder(e.sessionId));
    teamRosterRevision++;
    SettingsPanel.refreshTeamCurrent();
    chatViewProvider?.clearAgent(e.sessionId);
    refreshTeam();
    void firstUseController?.rosterChanged();
    MarketplacePanel.refreshCurrent();
    SetupGuidePanel.refreshCurrent();
    saveRosterInBackground();
    agentChannels.get(e.sessionId)?.channel.dispose();
    agentChannels.delete(e.sessionId);
    void worktreeCoordinator?.release(e.sessionId); // tear down the agent's worktree, if any
    scheduleTeamRulesOnRosterChange();
  });
  sessionManager.on('session.started', event => {
    orchestrationHost.offerRecoveredResults(event.sessionId);
    refreshTeam();
  });
  sessionManager.on('session.stopped', (event) => {
    if (event.data.resultScope === 'suspend') resultDeliveryHost.scope(event.sessionId, 'coordinator-stopped', event.data.turnStopped === true);
    // The normal worker-loss path publishes a correlated interruption first. This fallback covers a
    // host/backend path that vanished before it could publish that message; terminal ledger state is
    // idempotent, so an already-accounted stop produces no duplicate receipt.
    const interruptions = runLedger.recordWorkerInterrupted(event.sessionId, 'worker-lost', event.timestamp);
    for (const interruption of interruptions) {
      messageBus.send(
        interruption.agentId,
        interruption.coordinatorId,
        'system.error',
        {
          instruction: 'Worker session stopped before a terminal result was observed.',
          metadata: {
            isError: true,
            interrupted: true,
            interruptionReason: interruption.reason,
            lastObservedAt: interruption.lastObservedAt,
            detectedAt: interruption.detectedAt,
          },
        },
        'normal',
        interruption.handle,
      );
      if (interruption.attemptId) taskInputResolver?.endAttempt(interruption.attemptId, 'interrupted');
      orchestrationProgress.recordInterruption(interruption.handle, interruption);
    }
    if (interruptions.length > 0) {
      const summaries = orchestrationProgress.snapshot();
      chatViewProvider?.setDelegationProgress(summaries);
      messageLogProvider?.setDelegationProgress(summaries);
      teamViewProvider?.setDelegationProgress(orchestrationProgress.agentStates());
    }
    refreshTeam();
  });
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
    if (e.data?.programNotChosen) offerCliProgramChoice(e.sessionId);
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
  sessionManager.on('session.runtimeNotice', e => {
    if (e.sessionId) chatViewProvider?.postRuntimeNotice(e.sessionId, e.data.text);
  });
  // v0.9.103 (F2, the Owner's option A): one non-modal Continue for a turn an agent's CLI began on its own. Continue is
  // an ordinary request of the person through the chat's own entry; a busy, restarted, removed or stopped agent gets nothing.
  const unrequestedTurnOffers = new UnrequestedTurnOffers({
    show: (text, action) => vscode.window.showInformationMessage(text, action),
    inform: (text) => { void showResultNotice('warning', text); },
    agentName: (sessionId) => sessionManager.get(sessionId)?.config.name,
    isCurrentLaunch: (sessionId, launchId) => sessionManager.isCurrentBackendLaunch(sessionId, launchId),
    sendPersonMessage: (sessionId, text) => {
      if (!chatViewProvider?.submitUserRequest(sessionId, text)) {
        void showResultNotice('warning', 'That agent is working on another request; nothing was sent.');
      }
    },
  });
  sessionManager.on('session.unrequestedTurn', (e) => {
    if (e.sessionId && e.data.phase === 'started') {
      unrequestedTurnOffers.offer({ sessionId: e.sessionId, launchId: e.data.launchId,
        ...(e.data.taskId ? { taskId: e.data.taskId } : {}), ...(e.data.summary ? { summary: e.data.summary } : {}) });
    }
  });
  sessionManager.on('session.stream', (e) => {
    if (e.sessionId && e.data?.delta) {
      chatViewProvider?.appendDelta(e.sessionId, e.data.delta, e.data.epoch);
    }
  });
  sessionManager.on('session.responseRetry', (e) => {
    if (e.sessionId) chatViewProvider?.sealRetriedResponse(e.sessionId, e.data.retry, e.data.epoch);
  });
  sessionManager.on('session.segmentHeld', (e) => {
    if (e.sessionId) chatViewProvider?.commitHeldSegment(e.sessionId, e.data.text, e.data.epoch);
  });
  sessionManager.on('session.interruptionDetail', (e) => {
    if (!e.sessionId) return;
    const { interruption, detail, turnId, epoch } = e.data;
    chatViewProvider?.recordInterruptionDetail(e.sessionId, turnId, epoch, detail);
    const message = detail?.message?.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ') ?? '';
    outputChannel.warn(`[turn-interruption] turn=${turnId} kind=${interruption.kind} phase=${interruption.phase} retry=${interruption.retry}`
      + (interruption.attempts !== undefined ? ` attempts=${interruption.attempts}` : '')
      + (detail ? ` ${detail.name}${detail.code ? ` [${detail.code}]` : ''}${message ? `: ${message}` : ''}` : ''));
  });
  sessionManager.on('session.reasoning', (e) => {
    if (e.sessionId && e.data?.delta) {
      chatViewProvider?.appendReasoning(e.sessionId, e.data.delta, e.data.epoch);
    }
  });
  sessionManager.on('session.tool', (e) => {
    if (e.sessionId && e.data) {
      const serverId = mcpGrantExercisedByTool(e.data.name, e.sessionId);
      if (serverId) {
        const config = mcpRegistry.get(serverId);
        if (config) {
          const evidenceUpdate = integrationEvidenceStore?.noteExercised(config, e.data.phase === 'result' && toolFactSucceeded(e.data.outcome));
          if (evidenceUpdate) {
            void evidenceUpdate.then(() => MarketplacePanel.refreshCurrent());
          }
        }
        if (e.data.phase === 'use') {
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
  sessionManager.on('session.approvalReview', (e) => {
    if (!e.sessionId || !e.data) return;
    const text = e.data.phase === 'started'
      ? `Codex auto-review is reviewing: ${e.data.action}.`
      : `Codex auto-review ${e.data.status || 'completed'}: ${e.data.action}.`
        + (e.data.rationale ? ` ${e.data.rationale}` : '');
    chatViewProvider?.postRuntimeNotice(e.sessionId, text);
    getAgentChannel(e.sessionId).appendLine(text);
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
  // v0.9.92: every ended turn of a run leaves its entry in the ledger: timing, how it ended, its spend unit.
  sessionManager.on('session.turnEnded', (e) => {
    if (e.sessionId && e.data) {
      runLedger.recordTurn(e.sessionId, e.data);
    }
  });
  // v0.9.94: every ended top-level turn leaves its request closeout record. The store keeps it durably, and the
  // turn's card is placed when the reply that ends the turn reaches Chat.
  sessionManager.on('session.requestCloseout', (e) => {
    if (!e.data) return;
    // v0.9.110: the task history refers to the record; the record stays the authority for the outcome.
    taskHistory?.outcomeRecorded(e.data.record);
    if (e.data.record.terminal.kind === 'stopped' && e.sessionId === e.data.record.rootAgentId) {
      localReadScopeConsent.endPathAccessRequest(e.data.record.requestId);
      // v0.9.101 (G3): Stop voids the request's resume_refs. A later decision does not revive them.
      taskResumeRefs.endRequest(e.data.record.requestId);
    }
    const kept = requestCloseoutStore?.upsert(e.data.record);
    if (kept === 'conflict' || kept === 'invalid') {
      outputChannel.warn(`[request-closeout] turn ${e.data.record.terminalTurnId}: the record was not kept (${kept}).`);
    }
  });
  // v0.9.97: a request's file effects changed after some of its records were written (a delegate wrote for it, a
  // later turn of it did, a restore undid a change). Those records, and no record of another request, take them.
  sessionManager.on('session.requestFileEffects', (e) => {
    if (!e.data) return;
    showRequestFileEffects(e.data.requestId, e.data.changes);
    // v0.9.110 R1: effects without a restore point are listed as not reversed in the request's restore manifest.
    taskHistory?.effectsObserved(e.data.requestId, e.sessionId, e.data.changes, e.data.nativeKeys);
  });
  // v0.9.93: what a guarded coordinator turn did first, or that the host's deadline ended the attempt before it did
  // anything. The line is the evidence an acceptance trial keeps. A deadline also gets its one card in Chat.
  sessionManager.on('session.firstAction', (e) => {
    if (!e.sessionId || !e.data) return;
    const agentId = e.sessionId;
    const { turnId, evidence, approvalWaitMs, phases } = e.data;
    outputChannel.info(
      `[first-action] ${agentId}: ${evidence.kind} (${evidence.source}) after ${evidence.latencyMs} ms`
      + `${approvalWaitMs > 0 ? `, human approval ${approvalWaitMs} ms excluded` : ''}; turn ${turnId}`
      + (phases
        ? `; phases ms: queued ${phases.queuedMs}, host ${phases.hostMs}, provider wait ${phases.providerWaitMs}`
          + ` (${phases.providerWaitCount} waits, longest ${phases.longestProviderWaitMs}), reasoning ${phases.reasoningMs}`
          + `, responding ${phases.respondingMs}, tools ${phases.toolMs}, compacting ${phases.compactingMs ?? 'not-recorded'}`
        : ''),
    );
    if (evidence.source !== 'host-deadline') return;
    const request = messageBus.getThread(turnId).find((message) => message.id === turnId);
    chatViewProvider?.recordFirstActionDeadline({
      turnId,
      agentId,
      silenceBudgetMs: evidence.silenceBudgetMs,
      deadline: evidence.deadline,
      compactionPauseMs: evidence.compactionPauseMs,
      // The deadline ended the agent's process, so a retry is a new process on the agent's current route. The
      // original top-level request enters again as a new request of the person: its turn is composed afresh, with
      // a new candidate snapshot, and nothing of the ended attempt is replayed.
      retry: () => userRequests.resubmit(agentId, request),
    });
  });
  sessionManager.on('session.firstActionTurnUsage', (e) => {
    if (!e.sessionId || !e.data) return;
    const { inputTokens, cachedInputTokens, outputTokens } = e.data.usage;
    outputChannel.info(
      `[first-action] ${e.sessionId}: turn ${e.data.turnId} used ${inputTokens} input tokens`
      + `${cachedInputTokens === undefined
        ? ' (cache not reported)'
        : ` (${cachedInputTokens} from cache, ${Math.max(0, inputTokens - cachedInputTokens)} fresh)`}`
      + ` and ${outputTokens} output tokens`,
    );
  });
  // The host is the only source of a live phase; the chat shows what it is told.
  sessionManager.on('session.turnPhase', (e) => {
    if (e.sessionId && e.data) {
      chatViewProvider?.setTurnPhase(e.sessionId, e.data.phase, e.data.epoch);
    }
  });
  sessionManager.on('session.context', (e) => {
    if (e.sessionId && e.data) {
      chatViewProvider?.setContext(e.sessionId);
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
  // v0.9.90: a failed or suppressed automatic compaction is a host notice in that agent's chat, never model input.
  sessionManager.on('session.compactionNotice', (e) => {
    if (e.sessionId && e.data) {
      chatViewProvider?.postRuntimeNotice(e.sessionId, e.data.text);
    }
  });
  // v0.9.94: a stored conversation another backend kind wrote, or one that is no conversation, is discarded when the
  // agent starts. The person is told in that agent's chat when there is something to tell; the log gets the reason
  // and the kinds, and no content.
  sessionManager.on('session.conversationNotRestored', (e) => {
    if (e.sessionId && e.data) {
      const notice = conversationNotRestoredNotice(e.data);
      if (notice) chatViewProvider?.postRuntimeNotice(e.sessionId, notice);
      outputChannel.info(`Stored conversation of ${e.sessionId} not restored (${conversationNotRestoredLogLine(e.data)}).`);
    }
  });
  // A receipt is shown once per operation, restored with the chat, and never enters model context.
  messageBus.subscribe({}, (msg) => {
    if (msg.type !== 'system.compaction' || msg.from !== 'unode') return;
    const receipt = (msg.payload.metadata as { compactionReceipt?: CompactionReceipt } | undefined)?.compactionReceipt;
    if (receipt && typeof receipt.id === 'string') {
      chatViewProvider?.postCompactionReceipt(msg.to, receipt.id, msg.payload.instruction ?? '', receipt.summary);
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
let jobOutcomeSyncTimer: ReturnType<typeof setTimeout> | undefined;
let jobUsageLookupCache: { aggregate: object; lookup: JobUsageLookup } | undefined;

/**
 * v0.9.103: a reply is shown together with what it closed. The run ledger reads a coordinator's reply before Chat does
 * and closes the run; the records and the Job outcome were brought up to date 150 ms later, and in between the
 * request's card said that the job had not concluded, or that its Job outcome follows. A reply that can close a run
 * now brings them up to date at once, and Chat shows the reply, its records and its Job outcome in one state.
 */
function deliverReply(show: () => void, mayClose: boolean): void {
  const deliver = () => {
    show();
    if (mayClose) flushJobOutcomeSync();
  };
  if (chatViewProvider) chatViewProvider.holdPosts(deliver);
  else deliver();
}

/** The refresh scheduleJobOutcomeSync has waiting, now. Nothing is waiting: nothing to do. */
function flushJobOutcomeSync(): void {
  if (!jobOutcomeSyncTimer) return;
  clearTimeout(jobOutcomeSyncTimer);
  jobOutcomeSyncTimer = undefined;
  try {
    syncJobOutcomes();
  } catch (error) {
    outputChannel?.warn(`[job-outcome] refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One refresh for a burst of ledger or spend changes. It reads and renders; it changes no run. */
function scheduleJobOutcomeSync(): void {
  if (jobOutcomeSyncTimer) return;
  jobOutcomeSyncTimer = setTimeout(() => {
    jobOutcomeSyncTimer = undefined;
    try {
      syncJobOutcomes();
    } catch (error) {
      outputChannel?.warn(`[job-outcome] refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 150);
}

function syncJobOutcomes(): void {
  if (!chatViewProvider || !runLedger) return;
  const anchors = runLedger.closedRunAnchorFacts().flatMap((facts) => {
    const anchor = jobOutcomeAnchor(facts);
    return anchor ? [anchor] : [];
  });
  // The records first: a Job outcome reads the limit facts of its closing turn's record, as they are now.
  syncRequestCloseoutRuns();
  chatViewProvider.upsertJobOutcomeAnchors(anchors);
  chatViewProvider.refreshJobOutcomes();
  chatViewProvider.refreshRequestSummaries();
}

/**
 * v0.9.94: a stored record follows its coordinated run. One that reported its run as open is revised when that
 * run has closed: its card then says that the job closed and that the Job outcome follows. One that was written
 * before its run was recorded, because the task was taken up after the turn ended, is given that run. A run a
 * record holds is read by its exact id; nothing else of the record changes.
 */
function syncRequestCloseoutRuns(): void {
  if (!requestCloseoutStore || !runLedger || !sessionManager) return;
  const runs = requestCloseoutRunSource(runLedger);
  for (const session of sessionManager.getAll()) {
    for (const record of requestCloseoutStore.list(session.id)) {
      const revised = reviseForRunNow(record, runs);
      if (revised) requestCloseoutStore.upsert(revised);
      // The limit facts of the record's request as they are now: after an answer of the person, when the
      // totals can no longer be called exact, and in full once the record's run has closed.
      const limited = reviseForLimits(revised ?? record, requestCeiling?.facts(record.requestId));
      if (limited) requestCloseoutStore.upsert(limited);
      // v0.9.103 (G4): then the turn's dispatch receipt as it is now, after the run its admission recorded.
      const key = closeoutReceiptKey(record.rootAgentId, record.terminalTurnId);
      const receipt = closeoutReceipts.get(key);
      if (receipt) {
        closeoutReceipts.delete(key);
        const received = reviseForDelegationReceipt(limited ?? revised ?? record, receipt);
        if (received) requestCloseoutStore.upsert(received);
      }
    }
  }
}

/** Where a stored request closeout record reads its coordinated run: by the run's exact id, or by the turn that opened it. */
function requestCloseoutRunSource(ledger: RunLedger): RequestCloseoutRunSource {
  return {
    byId: (agentId, runId) => ledger.requestRunFacts(agentId, { runId }),
    openedBy: (agentId, turnId) => ledger.requestRunFacts(agentId, { openingTurnId: turnId }),
  };
}

/**
 * v0.9.94: the Request summary of one top-level turn as Chat shows it. Projected from the stored record and the
 * spend records each time it is asked for. Nothing is run, fetched, checked or written to produce it.
 */
function currentRequestSummaryView(record: RequestCloseoutRecordV1): RequestSummaryViewV1 {
  let usage: JobUsageLookup = noJobUsage;
  try {
    const aggregate = spendHost?.coordinator.aggregateForRead();
    if (aggregate) {
      if (jobUsageLookupCache?.aggregate !== aggregate) jobUsageLookupCache = { aggregate, lookup: jobUsageLookup(aggregate) };
      usage = jobUsageLookupCache.lookup;
    }
  } catch {
    usage = noJobUsage;
  }
  return projectRequestSummary(record, { usage, agentName: (agentId) => sessionManager?.get(agentId)?.config.name });
}

/**
 * v0.9.93: the Job outcome of one run as every surface shows it: Chat's card, its expanded state and the
 * evidence report. Projected from the stored run and the spend records each time it is asked for. Nothing is
 * run, fetched, checked or written to produce it.
 *
 * v0.9.94: with the limit facts of the request, from the closeout record of the run's closing turn. They are
 * added here and nowhere else, so no surface shows the outcome without them.
 */
function currentJobOutcomeView(runId: string, anchor: 'anchored' | 'conflict' = 'anchored'): JobOutcomeViewV1 {
  const labels = { agentName: (agentId: string) => sessionManager?.get(agentId)?.config.name };
  if (anchor === 'conflict') return jobOutcomeView(unavailableJobOutcome(runId, 'anchor-conflict'), labels);
  return withReviewLoop(displayedRunOutcomeView(runId, labels), runLedger?.get(runId), labels.agentName);
}

/** The run's own view, with the limit facts of its closing turn. */
function displayedRunOutcomeView(runId: string, labels: { agentName: (agentId: string) => string | undefined }): JobOutcomeViewV1 {
  return displayedJobOutcomeView(jobOutcomeView(currentJobOutcome(runId), labels), runLedger?.get(runId), storedRequestCloseout);
}

/**
 * v0.9.106: the request's review loop, as a Review section after Checks: every finding of its reviews with its derived
 * state, the reviews whose findings are not linked, and the files the request's own agent changed that no review was
 * bound to. Derived on each read from the run ledger and the closing turn's record; it stores nothing and starts nothing.
 */
function withReviewLoop(view: JobOutcomeViewV1, run: RunRecord | undefined, agentName: (agentId: string) => string | undefined): JobOutcomeViewV1 {
  if (!run || !view.available || !runLedger) return view;
  try {
    const chain = runLedger.requestRunsOf(run);
    const loop = projectReviewLoop(chain);
    const delegations = chain.flatMap((entry) => entry.delegations);
    const root = firstWorkspaceRoot();
    const reviewed = new Set(delegations.flatMap((delegation) => (delegation.reviewSets ?? []).filter(isReviewSetV1)
      .flatMap((set) => set.review.target && root ? [path.relative(root, set.review.target.lexicalPath).split(path.sep).join('/')] : [])));
    const closing = run.closingTurnId ? storedRequestCloseout(run.coordinatorId, run.closingTurnId) : undefined;
    const own = (closing?.observations.changes.files ?? []).filter((file) => file.origin === 'own' && !file.restore && !reviewed.has(file.path))
      .map((file) => file.path);
    const section = reviewLoopSection(loop, { agentName, unreviewedOwnFiles: own,
      reviewerOf: (handle) => delegations.find((delegation) => delegation.handle === handle)?.agentId });
    if (!section) return view;
    const after = view.sections.findIndex((entry) => entry.title === 'Checks');
    const sections = [...view.sections];
    sections.splice(after >= 0 ? after + 1 : sections.length, 0, section);
    return { ...view, sections };
  } catch {
    return view;
  }
}

/** The closeout record kept for one agent's turn. */
function storedRequestCloseout(agentId: string, terminalTurnId: string): RequestCloseoutRecordV1 | undefined {
  return requestCloseoutStore?.ofTurn(agentId, terminalTurnId);
}

/** The projection behind that view. Reads the stored run and the spend records; changes neither. */
function currentJobOutcome(runId: string): JobOutcomeV1 {
  let usage: JobUsageLookup = noJobUsage;
  try {
    const aggregate = spendHost?.coordinator.aggregateForRead();
    if (aggregate) {
      if (jobUsageLookupCache?.aggregate !== aggregate) jobUsageLookupCache = { aggregate, lookup: jobUsageLookup(aggregate) };
      usage = jobUsageLookupCache.lookup;
    }
  } catch {
    usage = noJobUsage;
  }
  const root = firstWorkspaceRoot();
  return projectJobOutcome(runId, runLedger?.get(runId), usage, (recorded) => {
    if (!root || !path.isAbsolute(recorded)) return undefined;
    try { return requestEffectPath(physicalPath(path.resolve(root)), physicalPath(recorded)); } catch { return undefined; }
  });
}

/**
 * v0.9.93: the evidence report of one run. It formats the same view the Job outcome card shows, so the two cannot
 * disagree. Writing it runs no check, reads no file of the workspace and looks at no checkpoint time window: what
 * was observed when the job ran is all it says.
 */
async function openJobOutcomeEvidence(runId: string, offerSave: boolean): Promise<void> {
  const md = renderJobOutcomeMarkdown(currentJobOutcomeView(runId), new Date().toISOString());
  if (offerSave && await saveMarkdownPayload(`unode-job-outcome-${timestampForFile()}.md`, md)) return;
  // Opened unsaved from the card, or when the save dialog was declined: the report is shown either way.
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
  await vscode.window.showTextDocument(doc, {
    preview: false,
    viewColumn: vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
  });
}

/** Choose a closed run. Newest first; a run that is still open has no outcome and is not offered. */
async function pickClosedRun(title: string): Promise<string | undefined> {
  const closed = runLedger.list().filter((run) => run.status === 'closed');
  if (closed.length === 0) {
    void showResultNotice('information', 'UnodeAi: no finished team job to report yet. A report exists once a coordinated job has closed.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(closed.map((run) => ({
    label: `${run.closeoutCompletionState === 'partial' ? '$(warning)' : '$(pass)'} ${resolveAgentName(run.coordinatorId)} — ${run.closeoutCompletionState ?? 'completion not recorded'}`,
    description: `started ${run.startedAt}`,
    detail: run.objective ? run.objective.replace(/\s+/g, ' ').slice(0, 140) : undefined,
    runId: run.id,
  })), {
    title,
    placeHolder: 'Choose a finished job. Its report is written from what was recorded; nothing is run again.',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.runId;
}

/**
 * Continue unfinished work: a new, explicit request of the person to the job's coordinator. The person sees the
 * exact text and confirms it; it then enters like a message typed in Chat. No earlier attempt is resumed, retried
 * or replayed, and the closed run is not changed.
 */
async function continueUnfinishedWork(coordinatorId: string, runId: string): Promise<void> {
  const outcome = currentJobOutcome(runId);
  if (outcome.state !== 'available' || outcome.remaining.state !== 'some') {
    void showResultNotice('information', 'UnodeAi: this job has no recorded unfinished work to continue.');
    return;
  }
  if (!sessionManager.get(coordinatorId)) {
    void showResultNotice('warning', 'UnodeAi: the coordinator of that job is no longer on the team, so no request was started.');
    return;
  }
  const request = jobContinuationRequest(outcome, { agentName: (agentId) => sessionManager?.get(agentId)?.config.name });
  const name = resolveAgentName(coordinatorId);
  const choice = await vscode.window.showInformationMessage(
    `Start a new request to ${name} for the unfinished work?`,
    { modal: true, detail: `This sends the request below as a new message. Nothing is resumed or retried by itself, and the finished job is not changed.\n\n${request}` },
    'Not now',
    'Start new request',
  );
  if (choice !== 'Start new request') return;
  if (chatViewProvider.submitUserRequest(coordinatorId, request)) return;
  // The coordinator is in a turn: a request is never injected into running work. The text waits in the composer.
  chatViewProvider.selectAgent(coordinatorId);
  if (chatViewProvider.insertIntoSelectedComposer(request)) {
    void showResultNotice('information', `UnodeAi: ${name} is working. The request was placed in the message box; send it when ${name} is idle.`);
  } else {
    void showResultNotice('warning', `UnodeAi: ${name} is working, so no request was started. Try again when it is idle.`);
  }
}

/**
 * One explicit action of a Job outcome card. Each goes to a surface or command that already exists and keeps its
 * own confirmation; none of them changes the closed run, runs a check or resumes work.
 */
async function runJobOutcomeAction(event: { coordinatorId: string; runId: string; action: JobOutcomeCardAction }): Promise<void> {
  switch (event.action) {
    case 'reviewChanges':
      // The team's recorded edits, grouped by agent, with a diff for each: the Workbench's change rail.
      chatViewProvider.selectAgent(event.coordinatorId);
      chatViewProvider.openWorkbench(false);
      await vscode.commands.executeCommand('unode.showWorkbenchInspector');
      return;
    case 'openEvidence':
      await openJobOutcomeEvidence(event.runId, false);
      return;
    case 'continueUnfinished':
      await continueUnfinishedWork(event.coordinatorId, event.runId);
      return;
    case 'changeTarget':
      await vscode.commands.executeCommand('unode.changeSpendTarget');
      return;
    case 'resetCounter':
      await vscode.commands.executeCommand('unode.resetSpendCounter');
      return;
  }
}

function scheduleRunSave(): void {
  if (runSaveTimer) {
    clearTimeout(runSaveTimer);
  }
  runSaveTimer = setTimeout(() => {
    runSaveTimer = undefined;
    void persistRunLedger().catch((error) => {
      outputChannel.warn(`[run-ownership] run snapshot save failed: ${String(error)}`);
    });
  }, 750);
}

async function persistRunLedger(): Promise<void> {
  await persistence.saveRuns(runLedger.snapshot());
}

/** Renew this window's leases and adopt only foreign rows whose heartbeat proves their owner is gone. */
async function maintainRunOwnership(): Promise<void> {
  if (runOwnershipMaintenanceInFlight) return;
  runOwnershipMaintenanceInFlight = true;
  const observedAt = new Date().toISOString();
  try {
    const result = await maintainRunOwnershipTick(
      runLedger,
      (at) => persistence.loadRuns(at),
      runOwnershipMaintenanceState,
      observedAt,
    );
    if (result.skipped === 'host-stall') {
      outputChannel.info('[run-ownership] maintenance branch=host-stall; skipped foreign lease judgment for one tick.');
    }
    for (const decision of result.decisions.filter((item) => item.action === 'interrupt')) {
      logRunOwnershipDecision('maintenance', decision);
    }
    const interruptions = result.interruptions;
    for (const interruption of interruptions) {
      if (interruption.attemptId) taskInputResolver?.endAttempt(interruption.attemptId, 'interrupted');
      orchestrationProgress?.recordInterruption(interruption.handle, interruption);
    }
    if (interruptions.length === 0) return;
    outputChannel.warn(`Marked ${interruptions.length} delegation(s) interrupted after their owning host lease expired.`);
    const summaries = orchestrationProgress.snapshot();
    chatViewProvider?.setDelegationProgress(summaries);
    messageLogProvider?.setDelegationProgress(summaries);
    teamViewProvider?.setDelegationProgress(orchestrationProgress.agentStates());
  } catch (error) {
    outputChannel.warn(`[run-ownership] maintenance failed without changing ownership: ${String(error)}`);
  } finally {
    runOwnershipMaintenanceInFlight = false;
  }
}

function logRunOwnershipDecision(
  phase: 'activation' | 'maintenance',
  decision: RunOwnershipReconciliationDecision,
): void {
  const owner = decision.owner
    ? ` ownerHostInstanceId=${JSON.stringify(decision.owner.hostInstanceId)}`
      + ` ownerEpoch=${JSON.stringify(decision.owner.epoch)}`
    : '';
  const heartbeat = decision.heartbeatAgeMs === undefined
    ? ''
    : ` heartbeatAgeMs=${decision.heartbeatAgeMs}`;
  outputChannel.info(
    `[run-ownership] ${phase} handle=${JSON.stringify(decision.handle)} branch=${decision.branch}`
    + ` action=${decision.action}${owner}${heartbeat}.`,
  );
}

/** A configured server id is the only label retained for an exercised MCP grant; never retain tool input. */
function mcpGrantExercisedByTool(toolName: string, sessionId: string): string | undefined {
  const exactClaudeBridgeId = sessionManager.getBackend(sessionId)?.managedMcpBridgeId?.();
  return managedMcpServerIdFromToolName(toolName, mcpRegistry.keys(), exactClaudeBridgeId);
}

// ─── Commands ─────────────────────────────────────────────────────────

/**
 * "UnodeAi: Reset Workspace State" — wipe this workspace's persisted Roam state so the user can
 * start clean (e.g. after a stale roster/chat history bleeds across reinstalls). Optionally clears
 * stored provider API keys too. Reloads the window so everything re-initializes from empty (the
 * Chat then shows the first-task screen, because no agents are restored).
 */
async function resetWorkspaceStateCommand(): Promise<void> {
  const RESET = 'Reset';
  const RESET_KEYS = 'Reset + clear API keys';
  const choice = await vscode.window.showWarningMessage(
    'Reset UnodeAi in this workspace? This permanently clears the team roster (including .unode/team.json), all chat history, the message log, saved conversations, workflows, approved MCP servers and an unsent first goal for this workspace, then reloads the window. This cannot be undone.',
    { modal: true },
    'Keep current workspace',
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

  // The Workbench draft copy stops writing first: a removal's late write must not bring agent ids back after the wipe.
  await chatDraftMirror?.retire();
  await persistence.resetWorkspaceState();
  await rootWorkspaceState.update(FIRST_USE_RECORD_KEY, undefined);
  // Also drop .unode/team.json — otherwise the now-empty workspaceState would re-seed the cleared
  // roster from it on reload (the "Browser keeps coming back after Reset" bug).
  try {
    await persistence.deleteTeamFile();
  } catch (error) {
    outputChannel.error(`Workspace state was cleared, but removing team.json could not be confirmed: ${String(error)}`);
    await showResultNotice('error', 'Workspace state was cleared, but UnodeAi could not confirm removal of .unode/team.json. '
      + 'API keys were not cleared and the window was not reloaded. Fix access to that file, then run Reset again; '
      + 'reloading now may restore the old team from the file.');
    return;
  }

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

/** Local exact-row review surface. It is command-palette UI and is never exposed as a model tool. */
async function reviewSharedMemory(): Promise<void> {
  const memory = sharedMemory;
  const attestations = memoryAttestationStore;
  if (!memory || !attestations) {
    void showWorkspaceBindingRequired('review shared memory');
    return;
  }
  await memory.load();
  const trustedWorkspace = vscode.workspace.isTrusted;
  const attested = trustedWorkspace ? attestations.attestedDigests() : new Set<string>();
  const rows = memory.reviewRows(attested);
  if (rows.length === 0) {
    void showResultNotice('information', 'Shared memory has no rows to review in the primary workspace folder.');
    return;
  }
  if (trustedWorkspace) {
    await attestations.prune(new Set(rows.map((row) => row.digest)));
  }
  const selected = await vscode.window.showQuickPick(
    [...rows].reverse().map((row) => ({
      label: `${row.trust === 'human-attested' ? '$(verified-filled)' : '$(warning)'} ${row.trust}`,
      description: `${row.kind} · ${memoryWriterLabel(row.agentId, sessionManager.get(row.agentId)?.config.name)} · ${row.tier}`,
      detail: row.displayText,
      row,
    })),
    {
      title: 'Review Shared Memory — primary workspace folder',
      placeHolder: trustedWorkspace
        ? 'Choose an exact row to attest or revoke. Dismiss to make no trust decision.'
        : 'Workspace is untrusted: rows are context only and new attestations are disabled.',
      matchOnDescription: true,
      matchOnDetail: true,
    }
  );
  if (!selected) return;

  if (selected.row.trust === 'human-attested') {
    const confirmation = await vscode.window.showWarningMessage(
      'Revoke local attestation for this exact row? It will return to untrusted context; the Markdown row is not deleted.',
      { modal: true },
      'Keep attestation',
      'Revoke attestation'
    );
    if (confirmation !== 'Revoke attestation') return;
    await attestations.revoke(selected.row.digest);
    void showResultNotice('information', 'Shared-memory row is now untrusted.');
    return;
  }

  if (!vscode.workspace.isTrusted) {
    void showResultNotice('warning', 'Shared-memory attestation is disabled until you trust this workspace. All rows remain untrusted.');
    return;
  }
  if (!selected.row.attestable) {
    void showResultNotice('warning', 'This row cannot be attested because its exact content exceeds the bounded review display or requires whitespace normalization. Shorten or normalize the row, then review it again.');
    return;
  }
  const confirmation = await vscode.window.showInformationMessage(
    'Attest this exact row as reviewed team guidance? This changes retention and display only. It does not verify truth, identify a person, or grant authority.',
    { modal: true },
    'Keep untrusted',
    'Attest exact row'
  );
  if (confirmation !== 'Attest exact row') return;
  if (!vscode.workspace.isTrusted) {
    void showResultNotice('warning', 'Workspace Trust changed before attestation was recorded. The row remains untrusted.');
    return;
  }
  await attestations.attest(selected.row.digest);
  void showResultNotice('information', 'Shared-memory row is now human-attested guidance.');
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
    void showResultNotice('information', 'This run still has active delegated work. It remains unjudged until the work settles.');
    return;
  }
  const continueChoice = await vscode.window.showInformationMessage(
    runAcceptanceEvidence(run),
    { modal: true },
    'Not now',
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
    void showResultNotice('error', 'UnodeAi could not record that verdict. The run may have changed; reopen the review and try again.');
    return;
  }
  void showResultNotice('information', `Recorded human verdict: ${choice.verdict}.`);
}

function defaultJsonUri(fileName: string): vscode.Uri | undefined {
  // v0.9.99: the Save dialog suggests the folder UnodeAi works in (the activation-time root); the person still picks.
  const folder = boundRootUri();
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

/** v0.9.99: a workflow went on past a check that could not run; non-modal, owes no answer. */
/** v0.9.99 (B14): offer Continue rework for a request held at the automatic cap; non-modal, owes no answer. */
function notifyReworkHeld(
  coordinatorId: string,
  held: { agentName: string; rounds: number },
  continueRework: () => ReworkContinueOutcome,
): void {
  offerContinueRework({
    show: (text, button) => vscode.window.showInformationMessage(text, button),
    onUserStop: (listener) => {
      const onStopped = (event: TypedSessionEvent<'session.stopped'>) => {
        if (event.sessionId === coordinatorId && event.data?.resultScope === 'suspend') listener();
      };
      sessionManager?.on('session.stopped', onStopped);
      return () => sessionManager?.off('session.stopped', onStopped);
    },
    post: (text) => chatViewProvider?.postRuntimeNotice(coordinatorId, text),
  }, sessionManager?.get(coordinatorId)?.config.name ?? 'The PM', held, continueRework);
}

/** v0.9.99 (Owner decision): Codex has not answered at start; non-modal, the start keeps waiting. */
function notifyCodexStartUnanswered(agentName: string, seconds: number): void {
  void vscode.window.showWarningMessage(
    `${agentName}: Codex has not answered for ${seconds} s, so this Codex CLI version looks bad. Update the Codex CLI in `
      + 'Settings → Providers → Codex CLI → Check / choose CLI…. The start keeps waiting; press Stop to cancel.',
    'Open Codex CLI settings',
  ).then((choice) => {
    if (choice === 'Open Codex CLI settings') void vscode.commands.executeCommand('unode.openSettings', 'providers');
  }, () => undefined);
}

function notifyUnverifiedWorkflowGate(message: string): void {
  void vscode.window.showInformationMessage(message);
}

/** v0.9.99: a worktree lane merged into integration unverified; non-modal, owes no answer. */
function notifyUnverifiedWorktreeMerge(message: string): void {
  void vscode.window.showInformationMessage(message);
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
        const result = await orchestrationHost.createCoordinatorTeamTools(coordinator, 'host').run('cancel_task', toolArgs);
        return { result, agents: snapshot() };
      });
    },
  });
  reg('unode.reviewSharedMemory', () => guard(() => reviewSharedMemory()));
  reg('unode.applyExecutionHooks', () => guard(() => applyExecutionHooks()));

  // Focus the Team VIEW, not just its container. Revealing the container is a no-op when the sidebar is
  // already showing UnodeAi, so "Finish takes you to create a team" was invisible to a user who had opened
  // the panel earlier in setup — the destination has to be observable to be a destination.
  reg('unode.showTeamPanel', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.unode');
    await vscode.commands.executeCommand(`${TeamViewProvider.viewType}.focus`);
  });

  reg('unode.showDashboard', () => guard(async () => {
    // Only unode.openSpend asks for the Spend section first; every other open keeps the usual order.
    dashboardFocusSpend = dashboardSpendRequested;
    dashboardSpendRequested = false;
    if (dashboardPanel) {
      dashboardPanel.reveal(vscode.ViewColumn.One);
      await refreshDashboardPanel();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'unodeDashboard',
      'UnodeAi Dashboard',
      vscode.ViewColumn.One,
      { enableScripts: false, enableCommandUris: true, retainContextWhenHidden: true }
    );
    dashboardPanel = panel;
    panel.onDidDispose(() => { if (dashboardPanel === panel) { dashboardPanel = undefined; dashboardFocusSpend = false; } });
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
        description: 'Markdown, one finished job',
        detail: 'The Job outcome of a finished job as UnodeAi recorded it: completion, checks, changes, usage, timing and what remains. Nothing is run again to write it.',
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

  // v0.9.93: the report is the Job outcome of one chosen run, formatted from the same projection the card in
  // Chat shows. It used to take the latest orchestration snapshot, list files by a checkpoint time window and
  // run the verify command again; a report of a finished job now only says what was recorded when it ran.
  reg('unode.generateEvidenceReport', (runId?: unknown) => guard(async () => {
    const chosen = typeof runId === 'string' && runLedger.get(runId) ? runId : await pickClosedRun('Evidence report');
    if (!chosen) return;
    await openJobOutcomeEvidence(chosen, true);
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
      showResultNotice('information', 'Select an agent chat first, then export it.');
      return;
    }
    const saved = await saveJsonPayload(
      `unode-chat-${safeFilePart(selected.agent.name)}-${timestampForFile()}.json`,
      createChatExportPayload(selected.agent, selected.messages)
    );
    if (saved) {
      showResultNotice('information', `Exported chat with ${selected.agent.name}.`);
    }
  }));

  reg('unode.importChat', () => guard(async () => {
    const who = chatViewProvider?.getSelectedAgentName();
    if (!who) {
      showResultNotice('information', 'Select an agent chat first, then import into it.');
      return;
    }
    const raw = await readJsonFromDialog();
    if (raw === undefined) {
      return;
    }
    const parsed = parseChatImportPayload(raw);
    if (!parsed.ok) {
      showResultNotice('error', `Could not import chat: ${parsed.error}`);
      return;
    }
    if (chatViewProvider.hasSelectedMessages()) {
      const REPLACE = 'Replace';
      const choice = await vscode.window.showWarningMessage(
        `Importing this chat will replace the current visible chat with ${who}.`,
        { modal: true },
        'Keep current chat',
        REPLACE
      );
      if (choice !== REPLACE) {
        return;
      }
    }
    if (chatViewProvider.importToSelected(parsed.messages, parsed.dropped === true)) {
      showResultNotice('information', `Imported ${parsed.messages.length} chat message(s) into ${who}.`);
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
      showResultNotice('information', omitted > 0
          ? `Exported ${snapshot.items.length} message log item(s); ${omitted} older item(s) were omitted by the ${snapshot.truncation.limit}-item retained window.`
          : `Exported ${snapshot.items.length} message log item(s).`);
    }
  }));

  reg('unode.exportRun', () => guard(async () => {
    const runs = runLedger.list();
    if (runs.length === 0) {
      void showResultNotice('information', 'No run has dispatched work yet. A run begins with the coordinator\'s first real delegation.');
      return;
    }
    const selected = await vscode.window.showQuickPick(runs.map((run) => ({
      label: markdownRunExportPickerLabel(run, resolveAgentName(run.coordinatorId)),
      description: onSystemClock(run.startedAt).toLocaleString(),
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
      void showResultNotice('error', 'The selected run is no longer available.');
      return;
    }
    const saved = await saveMarkdownPayload(
      `unode-run-${safeFilePart(resolveAgentName(run.coordinatorId))}-${timestampForFile()}.md`,
      // v0.9.94: with what the limits of the run's request did, from the record of its closing turn.
      renderRunEvidencePack(run, undefined, { requestLimits: requestLimitSection(closingTurnCloseout(run, storedRequestCloseout)) }),
    );
    if (saved) {
      void showResultNotice('information', runEvidenceExportConfirmation(run));
    }
  }));

  // Deliberately a SECOND export rather than an option on the first. The evidence pack retains the user's
  // objective and every task instruction and says so; it is an internal record. This one is built to leave
  // the organisation, so it carries no prose at all — see PortableRunEvidence for why that is the rule
  // rather than redaction.
  reg('unode.exportPortableRun', () => guard(async () => {
    const runs = runLedger.list();
    if (runs.length === 0) {
      void showResultNotice('information', 'No run has dispatched work yet. A run begins with the coordinator\'s first real delegation.');
      return;
    }
    const selected = await vscode.window.showQuickPick(runs.map((run) => ({
      label: portableRunExportPickerLabel(run, resolveAgentName(run.coordinatorId)),
      description: onSystemClock(run.startedAt).toLocaleString(),
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
      void showResultNotice('error', 'The selected run is no longer available.');
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
      void showResultNotice('information', 'Exported portable run evidence. No request text, instructions, command lines, file contents, raw '
        + 'approver identities, or private gateway hostnames. It does carry workspace-relative changed paths, '
        + 'timestamps, and validated SHA-256 digests, which its "retained" section declares.');
    }
  }));

  reg('unode.exportWorkerProgress', () => guard(async () => {
    const saved = await saveMarkdownPayload(
      `unode-worker-progress-${timestampForFile()}.md`,
      renderWorkerTaskProgressReport(runLedger.snapshot()),
    );
    if (saved) {
      void showResultNotice('information', 'Exported Phase A worker no-material-progress distribution.');
    }
  }));

  reg('unode.importMessages', () => guard(async () => {
    const raw = await readJsonFromDialog();
    if (raw === undefined) {
      return;
    }
    const parsed = parseMessagesImportPayload(raw);
    if (!parsed.ok) {
      showResultNotice('error', `Could not import messages: ${parsed.error}`);
      return;
    }
    if (messageLogProvider?.hasItems()) {
      const REPLACE = 'Replace';
      const choice = await vscode.window.showWarningMessage(
        'Importing messages will replace the current visible team activity feed.',
        { modal: true },
        'Keep current feed',
        REPLACE
      );
      if (choice !== REPLACE) {
        return;
      }
    }
    messageLogProvider?.importItems(parsed.messages, parsed.truncation);
    showResultNotice('information', `Imported ${parsed.messages.length} message(s) into the activity feed for viewing (not restored to history — cleared on reload).`);
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
      showResultNotice('information', 'Select an agent chat first, then compact its context.');
      return;
    }
    // Same path as the composer button: the transcript shows it running, then the outcome. Without this
    // the palette produced a silent pause and a toast, and the chat showed nothing at all.
    await chatViewProvider?.runCompaction(agentId);
    showResultNotice('information', `Compaction finished for ${who}. The result is in the chat transcript.`);
  }));
  reg('unode.newModelConversation', () => guard(async () => {
    const id = chatViewProvider?.getSelectedAgentId();
    if (!id) { showResultNotice('information', 'Select an agent in UnodeAi Chat, then run New Model Conversation (keep chat).'); return; }
    await sessionManager.newModelConversation(id);
    chatViewProvider?.postRuntimeNotice(id, 'Started a new model conversation. The visible chat is kept; the model has not seen the earlier messages. Send your next request with the context it needs.');
  }));
  reg('unode.clearChat', () => guard(async () => {
    const who = chatViewProvider?.getSelectedAgentName();
    if (!who) {
      showResultNotice('information', 'Select an agent chat first, then clear it.');
      return;
    }
    const CLEAR = 'Clear';
    // v0.9.94: the words say what the command does. It removes the messages UnodeAi shows and keeps; it does not
    // touch the conversation the agent's backend holds, live or stored. The earlier words promised the second.
    const choice = await vscode.window.showWarningMessage(
      `Clear the visible chat with ${who}? This permanently deletes the messages shown in Chat. It does not reset the model's conversation, so the model may still remember them.`,
      { modal: true },
      'Keep chat',
      CLEAR
    );
    if (choice === CLEAR) {
      chatViewProvider?.clearSelectedAgent();
    }
  }));
  reg('unode.archiveChat', () => guard(async () => {
    const who = chatViewProvider?.getSelectedAgentName();
    if (!who) {
      showResultNotice('information', 'Select an agent chat first, then archive it.');
      return;
    }
    const archived = chatViewProvider?.archiveSelectedAgent() ?? 0;
    if (archived === 0) {
      showResultNotice('information', `Nothing to archive — the chat with ${who} is empty.`);
      return;
    }
    showResultNotice('information', `Archived the chat with ${who}. It's hidden but not deleted — restore it via "UnodeAi: View Archived Chats".`);
  }));
  // v0.9.110 H1: Task history (design §5): search, favourites, Resume and Manage storage.
  reg('unode.taskHistory', () => guard(async () => { openTaskHistoryPanel(); }));
  reg('unode.viewArchivedChats', () => guard(async () => {
    const archives = chatViewProvider?.listArchivedChats() ?? [];
    if (archives.length === 0) {
      showResultNotice('information', 'No archived chats yet. Use the Archive button in the Chat panel to save one.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      archives.map((a) => ({
        label: a.agentName,
        description: onSystemClock(a.archivedAt).toLocaleString(),
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
        'Keep current chat',
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
      showResultNotice('warning', msg);
      return;
    }
    void vscode.commands.executeCommand('unode.chat.focus').then(undefined, () => { /* view focus is best-effort */ });
    showResultNotice('information', `Restored the archived chat with ${pick.label}.`);
  }));
  reg('unode.clearMessageLog', () => guard(async () => {
    const CLEAR = 'Clear';
    const choice = await vscode.window.showWarningMessage(
      "Clear all team messages? This empties the cross-agent activity feed and its saved history. It can't be undone.",
      { modal: true },
      'Keep messages',
      CLEAR
    );
    if (choice === CLEAR) {
      messageBus.clearMessages();
      void persistence.saveMessages([]);
      messageLogProvider?.clear();
    }
  }));

  reg('unode.startAllAgents', () => guard(async () => {
    for (const session of sessionManager.getAll()) resultDeliveryHost.scope(session.id, 'explicit-resume');
    const result = await sessionManager.startAll();
    showResultNotice('information', 'Starting all UnodeAi agents...');
    return result;
  }));

  reg('unode.stopAllAgents', (options?: unknown) => guard(async () => {
    // v0.9.99: also the messages of agents whose session had already stopped when they were sent.
    stopPreparingMessages('all');
    await sessionManager.stopAll();
    if (!isE2EFixtureRequest(extensionContext?.extensionMode, options)) {
      showResultNotice('information', 'All UnodeAi agents stopped');
    }
    return sessionManager.getAll();
  }));

  // Existing callers pass an agent id; the roster gear's Smart compaction row passes { agentId, focus }.
  reg('unode.openAgentBuilder', (target?: string | { agentId?: unknown; focus?: unknown }) =>
    guard(async () => {
      const agentId = typeof target === 'string'
        ? target
        : typeof target?.agentId === 'string' ? target.agentId : undefined;
      const focus = typeof target === 'object' && (target?.focus === 'smart-compaction' || target?.focus === 'instructions') ? target.focus : undefined;
      if (!agentId) { assertDefaultProviderCanCreateAgents(); }
      return AgentBuilderPanel.createOrShow(context.extensionUri, {
      getViewModel: (id) => agentBuilderViewModel(context.extensionUri, id),
      listModels: (providerId, baseUrl, discovery) => agentBuilderListModels(providerId, baseUrl, 'Agent Builder model picker', discovery),
      chooseMediaModel: pickMemberMediaModel,
      loadModels: (providerId) => loadCodexModelsForPicker(providerId),
      save: (payload) => handleAgentBuilderSave(payload, context.extensionUri),
      pickIcon: () => pickAgentBuilderIcon(),
      pickFolderAccessFolder: () => pickAgentBuilderFolderAccessFolder(),
      resolveFolderAccessIssues: (grants) => resolveAgentBuilderFolderAccessIssues(grants),
      modelParamDefaultLabels: () => modelParamDefaultLabels(makeConfigStore()),
      promptTemplateAction: (id, action) => handlePromptTemplateAction(id, action),
      previewSmartCompaction: (form, id) => previewBuilderSmartCompaction(form, id),
      openCompactionProfileTable: () => openCompactionProfileTable(),
      openSkillLibrary: async () => {
        const DEFAULT_SKILL_LIBRARY_URL = 'https://github.com/UnodeTechxyz/unode-skills';
        const raw = configuredSetting<string>('marketplace.skillLibraryUrl', DEFAULT_SKILL_LIBRARY_URL);
        const resolved = resolveHttpsExternalUrl(raw ?? DEFAULT_SKILL_LIBRARY_URL, DEFAULT_SKILL_LIBRARY_URL);
        if (!resolved) {
          void showResultNotice('warning', `UnodeAi did not open the skill library: the configured link is not an https URL (${String(raw)}).`);
          return;
        }
        if (!resolved.isDefault) {
          // Off-default and user-chosen: name the destination before navigating.
          const choice = await vscode.window.showWarningMessage(
            `Open the skill library at ${resolved.origin}? This link was set in your user settings, not by UnodeAi.`,
            'Cancel',
            'Open'
          );
          if (choice !== 'Open') { return; }
        }
        await vscode.env.openExternal(vscode.Uri.parse(resolved.url));
      },
      // Open the MCP Marketplace (its MCP tab) — what users expect from "Browse MCP Marketplace…" in the
      // builder. Installing there registers the server; the builder refreshes its grant list on focus.
      addMcpServer: async () => { await vscode.commands.executeCommand('unode.openMarketplace', 'mcp'); },
      }, agentId, focus);
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
  async function snapshotRosterBeforeReplace(verificationSource?: { document: TeamFileDocument | undefined }, protectedRef?: TeamLibraryRef): Promise<boolean> {
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
        verificationSource,
      );
      for (const stale of automaticSnapshotsToPrune(await persistence.listSavedTeams(), protectedRef)) {
        await persistence.deleteSavedTeam({ scope: 'workspace', slug: stale.slug });
      }
      return true;
    } catch (err) {
      outputChannel.error(`Could not snapshot the current team before replacing it: ${String(err)}`);
      void showResultNotice('warning', 'The current team could not be saved as a snapshot. Switching will continue, but this switch cannot be undone from that snapshot.');
      return true;
    }
  }

  /** Saved teams and prepared presets share roster/policy publication and stop-evidence handling. */
  async function restoreTeamDocument(document: TeamFileDocument, isCurrent: () => boolean,
    sourceCurrent?: () => Promise<boolean>, protectedRef?: TeamLibraryRef, trustedPermissions?: readonly AgentConfig[]): Promise<boolean> {
    return agentRosterEdits.replace(isCurrent, async () => {
      if (rosterNotifyTimer) { clearTimeout(rosterNotifyTimer); rosterNotifyTimer = undefined; }
      teamRosterRevision++; // invalidate old settings cards even when A -> B -> A uses equal policy bytes
      const rosterUnchanged = agentRosterEdits.capture();
      const outgoingIds = sessionManager.getAll().map(session => session.id);
      const assertCurrent = () => {
        if (hostShutdown.started || !rosterUnchanged()) throw new Error('The team or workspace changed. The selected team was not applied.');
      };
      const legacyCommands = migrateLegacyCommandTools(agentRosterEdits.overlayUnsavedOff(document.members));
      if (legacyCommands.added > 0) outputChannel.info(legacyCommandMigrationNotice(legacyCommands.added));
      const members = legacyCommands.members.map(config => {
        const saved = trustedPermissions?.find(member => member.id === config.id);
        const { mediaModels: _untrustedMediaModels, publicSearch: _untrustedPublicSearch, ...member } = config;
        return {
          ...member,
          ...(saved?.mediaModels ? { mediaModels: saved.mediaModels } : {}),
          ...(saved?.publicSearch ? { publicSearch: saved.publicSearch } : {}),
          ...((member.backend ?? defaultBackendKind(member, effectiveConnectionRegistry)) === 'codex'
            ? { codexPermissionProfile: saved?.codexPermissionProfile ?? 'approve-for-me' as const } : {}),
        };
      });
      try {
        return await persistence.replaceSavedTeam({ ...document, members }, {
          currentMembers: () => sessionManager.getAll().map(session => session.config), assertCurrent,
          snapshotOutgoing: current => snapshotRosterBeforeReplace({ document: current }, protectedRef),
          beforeIncomingPublish: async () => {
            if (sourceCurrent && !await sourceCurrent()) throw new Error('The selected saved team changed while switching. Reopen the picker and try again.');
          },
          stopAndPrepare: async () => {
            for (const run of workflowEngine.getActiveWorkflows()) if (run.status === 'running') workflowEngine.cancel(run.id);
            await sessionManager.prepareRosterReplacement();
            // Drain old merge/release work before the file commit; a verifier in that chain may still
            // need the outgoing policy read. New same-ID agents must not race an old lane deletion.
            for (const id of outgoingIds) await worktreeCoordinator?.release(id);
          },
          publish: async next => {
            await sessionManager.publishStoppedRoster(next);
            // session.removed also queues releases. Observe that queue before admitting the new team.
            for (const id of outgoingIds) await worktreeCoordinator?.release(id);
          },
        });
      } catch (error) {
        if (error instanceof TeamReplacementRecoveryError) agentRosterEdits.requireRecovery();
        throw error;
      } finally {
        teamRosterRevision++;
        teamViewProvider?.refresh(); chatViewProvider?.refresh?.();
      }
    }).finally(() => { SettingsPanel.refreshTeamCurrent(); });
  }

  async function saveCurrentTeam(): Promise<void> {
    const members = sessionManager.getAll().map((session) => session.config);
    if (members.length === 0) {
      void showResultNotice('information', 'There is no team to save yet. Create or switch to a team first.');
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
    const scopeChoice = await vscode.window.showInformationMessage(
      'Where should this team be saved?',
      {
        modal: true,
        detail: SAVE_TEAM_SCOPE_DIALOG.detail,
      },
      'Save to This project',
      'Save to All projects',
    );
    if (scopeChoice !== 'Save to This project' && scopeChoice !== 'Save to All projects') return;
    const scope = scopeChoice === 'Save to This project' ? 'workspace' as const : 'global' as const;
    const existing = (await persistence.listSavedTeams()).find((entry) => entry.scope === scope && entry.slug === slug);
    if (existing) {
      const OVERWRITE = 'Overwrite';
      const choice = await vscode.window.showWarningMessage(
        `A saved team named "${existing.label}" already exists (${describeTeamEntry(existing)}). Overwrite it?`,
        { modal: true },
        'Keep saved team',
        OVERWRITE,
      );
      if (choice !== OVERWRITE) {
        return;
      }
    }
    await persistence.saveTeamToLibrary({ scope, slug }, label, members);
    void showResultNotice('information', scope === 'workspace'
        ? `Saved "${label}" to This project (.unode/teams/${slug}.json). It will load read-only until you confirm its saved permissions.`
        : `Saved "${label}" to All projects (your personal UnodeAi library).`);
  }

  reg('unode.saveTeam', () => guard(saveCurrentTeam));

  /**
   * The one saved-team home: system presets, save, manual saves, and snapshot recovery share one picker.
   * Only actual saved-team rows receive the destructive affordance; presets and automatic snapshots do not.
   */
  async function pickCreateOrLoadTeamAction(): Promise<dialogs.TeamActionItem | undefined> {
    const DELETE_BUTTON: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('trash'),
      tooltip: 'Delete this saved team',
    };
    type Item = (dialogs.TeamActionItem | vscode.QuickPickItem) & { buttons?: readonly vscode.QuickInputButton[] };
    const isAction = (item: Item): item is dialogs.TeamActionItem => 'action' in item;
    const isSavedTeamAction = (item: Item): item is Extract<dialogs.TeamActionItem, { action: 'saved' }> =>
      isAction(item) && item.action === 'saved';
    const picker = vscode.window.createQuickPick<Item>();
    picker.title = 'Create/Save/Load a Team';
    picker.placeholder = 'Choose a system default or manage one of your saved teams';
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;

    const refresh = async () => {
      const actions = dialogs.teamActionItems(sessionManager.getAll().length, await persistence.listSavedTeams(), teamSaveIconUri());
      picker.items = actions.map((item): Item => isAction(item)
        ? { ...item, ...(dialogs.teamActionHasDeleteControl(item) ? { buttons: [DELETE_BUTTON] } : {}) }
        : item);
    };

    const confirmDelete = async (item: Extract<dialogs.TeamActionItem, { action: 'saved' }>): Promise<boolean> => {
      const entry = (await persistence.listSavedTeams()).find((candidate) =>
        candidate.scope === item.ref.scope && candidate.slug === item.ref.slug,
      );
      const label = entry?.label ?? item.ref.slug;
      const DELETE = 'Delete';
      const choice = await vscode.window.showWarningMessage(
        savedTeamDeleteConfirmation(item.ref, label),
        { modal: true },
        'Keep saved team',
        DELETE,
      );
      if (choice !== DELETE) return false;
      await persistence.deleteSavedTeam(item.ref);
      return true;
    };

    try {
      await refresh();
      return await new Promise<dialogs.TeamActionItem | undefined>((resolve) => {
        picker.onDidAccept(() => {
          const selected = picker.selectedItems[0];
          // A group heading: nothing to do, and the choice is still to be made.
          if (selected && !isAction(selected)) { picker.selectedItems = []; return; }
          picker.hide();
          resolve(selected);
        });
        picker.onDidTriggerItemButton(async (event) => {
          if (!isSavedTeamAction(event.item)) return;
          if (await confirmDelete(event.item)) await refresh();
        });
        picker.onDidHide(() => resolve(undefined));
        picker.show();
      });
    } finally {
      picker.dispose();
    }
  }

  /**
   * Automatic snapshots have their own list, because they are a recovery history rather than named saved
   * teams. Manual saves are managed only through Create/Save/Load a Team.
   */
  async function pickPreviousTeamSnapshot(): Promise<TeamLibraryRef | undefined> {
    const DELETE_BUTTON: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('trash'),
      tooltip: 'Delete this saved team',
    };
    type Item = vscode.QuickPickItem & { ref: TeamLibraryRef };

    const toItem = (entry: TeamLibraryEntry): Item => ({
      label: `$(history) ${entry.label}`,
      description: `${describeTeamEntry(entry)} · this project`,
      detail: 'Saved automatically before a team was replaced.',
      ref: { scope: entry.scope, slug: entry.slug },
      buttons: [DELETE_BUTTON],
    });

    const visibleEntries = (entries: readonly TeamLibraryEntry[]) => entries.filter((entry) => entry.automatic);
    const picker = vscode.window.createQuickPick<Item>();
    picker.title = 'Restore a previous team';
    picker.placeholder = 'The current team is snapshotted before it is replaced';
    picker.matchOnDescription = true;
    picker.items = visibleEntries(await persistence.listSavedTeams()).map(toItem);

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
            `Delete the automatic snapshot "${label}"? This cannot be undone. Your running team is unaffected.`,
            { modal: true },
            'Keep saved team',
            DELETE,
          );
          if (choice !== DELETE) {
            return;
          }
          await persistence.deleteSavedTeam(event.item.ref);
          const remaining = visibleEntries(await persistence.listSavedTeams());
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

  type SavedPermissionPick = vscode.QuickPickItem & {
    permissionKind: 'skill' | 'playbook';
    id: string;
  };

  function permissionToolLabel(tool: string): string {
    switch (tool) {
      case 'write': return 'write files';
      case 'execute': return 'run commands';
      case 'delegate': return 'delegate';
      case 'read': return 'read files';
      case 'search': return 'search';
      case 'message': return 'message';
      default: return tool;
    }
  }

  function savedPermissionSummary(members: readonly AgentConfig[], loadedMembers = sessionManager.getAll().map(session => session.config)): string {
    return members.map((member) => {
      const skillNames = (member.skills ?? []).map((skill) => skill.name);
      const playbooks = member.playbooks ?? [];
      const tools = new Set(member.allowedTools ?? []);
      const permissions = [
        ...(skillNames.length ? [`skills: ${skillNames.join(', ')}`] : []),
        ...(playbooks.length ? [`playbooks: ${playbooks.map((id) => id.split('/').pop() ?? id).join(', ')}`] : []),
        ...(tools.has('write') ? ['write'] : []),
        ...(tools.has('execute') && !loadedMembers.some(loaded => loaded.id === member.id && loaded.roleTemplateKey
          && Object.hasOwn(ROLE_TEMPLATES, loaded.roleTemplateKey) && (!loaded.allowedTools || loaded.allowedTools.includes('execute'))) ? ['run commands'] : []),
        ...(tools.has('delegate') ? ['delegate'] : []),
      ];
      return `${member.name}: ${permissions.join('; ') || 'no extra permissions'}`;
    }).join('\n');
  }

  function permissionPicks(member: AgentConfig): SavedPermissionPick[] {
    const desiredTools = new Set(member.allowedTools ?? []);
    const loaded = sessionManager.get(member.id)?.config;
    if (loaded?.roleTemplateKey && Object.hasOwn(ROLE_TEMPLATES, loaded.roleTemplateKey)
      && (!loaded.allowedTools || loaded.allowedTools.includes('execute'))) desiredTools.delete('execute');
    const skills = savedPermissionSkillIds(member)
      .map((id) => {
        const skill = SKILL_LIBRARY[id];
        const resulting = skillResolver.allowedToolsForIds([id]).filter((tool) => desiredTools.has(tool));
        return {
          label: `$(tools) ${skill.name}`,
          description: 'Skill',
          detail: `Resulting permissions: ${resulting.map(permissionToolLabel).join(', ') || 'read-only'}`,
          picked: false,
          permissionKind: 'skill' as const,
          id,
        };
      }).filter(pick => pick.detail !== 'Resulting permissions: read-only');
    return skills;
  }

  async function offerAgentBuilderForUnrestorablePermissions(
    member: AgentConfig,
    lostPermissions: readonly string[],
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const OPEN = 'Open in Agent Builder';
    const choice = await vscode.window.showInformationMessage(
      `${member.name} lost ${lostPermissions.map(permissionToolLabel).join(', ')}, but this save has no installed Skill that can restore them automatically.`,
      { modal: true },
      'Load read-only',
      OPEN,
    );
    if (choice !== OPEN || !isCurrent()) return;
    await vscode.commands.executeCommand('unode.openAgentBuilder', member.id);
  }

  async function reviewSavedPermissions(members: readonly AgentConfig[], isCurrent: () => boolean = () => true): Promise<number> {
    let regainedPermissionAgents = 0;
    const catalog = await loadMarketplaceCatalog(context.extensionUri);
    const knownPlaybooks = new Set(catalog.skills.map((entry) => entry.id));
    for (const member of members) {
      if (!isCurrent()) return regainedPermissionAgents;
      const playbooks: SavedPermissionPick[] = (member.playbooks ?? [])
        .filter((id) => knownPlaybooks.has(id))
        .map((id) => ({
      label: `$(book) ${id.split('/').pop() ?? id}`,
      description: 'Playbook',
      detail: 'Resulting permissions: instructions only',
      picked: false,
      permissionKind: 'playbook' as const,
      id,
    }));
      const items = [...permissionPicks(member), ...playbooks];
      if (items.length === 0) {
        const savedTools = new Set(member.allowedTools ?? []);
        const loaded = sessionManager.get(member.id)?.config;
        const lostPermissions = ['write', 'execute', 'delegate'].filter((tool) => savedTools.has(tool)
          && !(tool === 'execute' && loaded?.roleTemplateKey && Object.hasOwn(ROLE_TEMPLATES, loaded.roleTemplateKey)
            && (!loaded.allowedTools || loaded.allowedTools.includes('execute'))));
        if (lostPermissions.length === 0) continue;
        await offerAgentBuilderForUnrestorablePermissions(member, lostPermissions, isCurrent);
        continue;
      }
      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: `Review permissions for ${member.name}`,
        placeHolder: 'All extra permissions start unticked. Select only what this agent should regain.',
      });
      if (!isCurrent()) return regainedPermissionAgents;
      if (!selected) continue;
      let result: { ok: boolean; message: string; granted: boolean };
      try {
        result = await applySavedAgentPermissions(
          member,
          selected.filter((item) => item.permissionKind === 'skill').map((item) => item.id),
          selected.filter((item) => item.permissionKind === 'playbook').map((item) => item.id),
          isCurrent,
        );
      } catch (error) {
        void showResultNotice('error', `Could not grant permissions to ${member.name}: ${error instanceof Error ? error.message : String(error)} The agent remains read-only.`);
        continue;
      }
      if (!result.ok) {
        void showResultNotice('error', `Could not grant permissions to ${member.name}: ${result.message} The agent remains read-only.`);
      } else if (result.granted) {
        regainedPermissionAgents++;
      }
    }
    return regainedPermissionAgents;
  }

  async function applySavedAgentPermissions(
    desired: AgentConfig,
    skillIds: readonly string[],
    playbooks: readonly string[],
    isCurrent: () => boolean = () => true,
    commandPreference?: SavedCommandPreference,
    sourceCurrent?: () => Promise<boolean>,
  ): Promise<{ ok: boolean; message: string; granted: boolean }> {
    const current = sessionManager.get(desired.id)?.config;
    if (!current || !isCurrent()) return { ok: false, message: `Agent ${desired.name} is no longer in the loaded team.`, granted: false };
    const targetCurrent = () => isCurrent() && sessionManager.get(desired.id)?.config === current;
    const existingTools = new Set(current.allowedTools ?? []);
    const roleKey = current.roleTemplateKey && ROLE_TEMPLATES[current.roleTemplateKey]
      ? current.roleTemplateKey
      : 'custom';
    const catalog = await loadMarketplaceCatalog(context.extensionUri);
    const knownPlaybooks = new Set(catalog.skills.map((entry) => entry.id));
    const result = await handleAgentBuilderSave({
      id: current.id,
      name: current.name,
      roleKey,
      ...(roleKey === 'custom' ? { customRole: current.role } : {}),
      icon: current.icon,
      iconExplicit: true,
      color: current.color,
      providerId: current.provider.providerId,
      model: current.model,
      fallbackModel: current.fallbackModel,
      toolProtocol: current.toolProtocol ?? 'auto',
      systemPrompt: stripPlaybooks(current.systemPrompt),
      skillIds: [...skillIds],
      allowedToolCeiling: [...(desired.allowedTools ?? [])],
      permissionRestoreOnly: true,
      playbooks: playbooks.filter((id) => knownPlaybooks.has(id)),
      mcpServers: [],
    }, context.extensionUri, targetCurrent, commandPreference, sourceCurrent);
    if (!result.ok) return { ...result, granted: false };

    // A changed Skill definition cannot widen an old confirmation: Builder-derived tools are capped to
    // the exact declaration in the fingerprinted file. Project restores never regain Codex native-default.
    const updated = sessionManager.get(desired.id)?.config;
    if (!updated) return { ok: false, message: `Agent ${desired.name} disappeared while restoring permissions.`, granted: false };
    if (!isCurrent()) return { ok: false, message: 'The loaded team changed. No further permissions were restored.', granted: false };
    return {
      ...result,
      granted: (updated.allowedTools ?? []).some((tool) => !existingTools.has(tool)),
    };
  }

  async function restoreAllSavedPermissions(members: readonly AgentConfig[], isCurrent: () => boolean = () => true,
    sourceTrusted = false, sourceCurrent?: () => Promise<boolean>): Promise<{
    regainedPermissionAgents: number;
    failures: string[];
  }> {
    return restoreSavedPermissionsIndividually(members, (member) => applySavedAgentPermissions(
      member,
      savedPermissionSkillIds(member),
      member.playbooks ?? [],
      isCurrent,
      savedCommandPreference(member, sourceTrusted),
      sourceCurrent,
    ));
  }

  async function openSavedTeam(ref: TeamLibraryRef): Promise<AgentConfig[]> {
    const currentTarget = agentRosterEdits.capture();
    const entries = await persistence.listSavedTeams();
    if (entries.length === 0) {
      void showResultNotice('information', 'No saved teams yet. Open "UnodeAi: Create/Save/Load a Team…" to save the current team.');
      return [];
    }
    // Read the name from the file before anything replaces the roster, so the confirmation quotes what the
    // user typed rather than the slug it was filed under.
    const label = entries.find((entry) => entry.scope === ref.scope && entry.slug === ref.slug)?.label ?? ref.slug;
    const loaded = await persistence.loadSavedTeamWithTrust(ref);
    let document = loaded?.document;
    if (!loaded || !document || document.members.length === 0) {
      void showResultNotice('error', 'That saved team could not be read. It is left on disk unchanged.');
      return [];
    }
    // Only the host-owned global library can supply its preference before a permission confirmation.
    // Project-library parsing never supplies this context, even when it exposes a permission preview.
    if (ref.scope === 'global') document = { ...document, members: document.members.map(member => {
      const preference = savedCommandPreference(member, true);
      if (preference?.preference === 'deny' && (member.backend ?? defaultBackendKind(member, effectiveConnectionRegistry)) === 'codex') {
        throw new Error('This saved Codex agent requests Run commands Off, which its native connection cannot enforce. Choose a different connection before loading it.');
      }
      return preference ? { ...member, allowedTools: restoredCommandTools(member.allowedTools ?? [], member, preference) } : member;
    }) };
    // An unsupported field is stripped and warned about rather than rejecting the file. That warning has to
    // reach somebody: `.unode/team.json` surfaces its warnings on load, and this path did not, so the one
    // entrance where a stripped field changes what you are about to be given was the one that said nothing.
    let restoreSavedPermissions = false;
    if (ref.scope === 'workspace' && loaded.fingerprintMatched) {
      // v0.9.99: UnodeAi recognises the exact project team file it saved for this person, so its saved permissions
      // load with no "Restore saved permissions / Load read-only" question. An agent saved with Run commands Off
      // stays Off on this path too. A file UnodeAi did not save (copied or edited) keeps the read-only review below.
      restoreSavedPermissions = true;
      document = { ...document, members: document.members.map(member => {
        const declared = loaded.permissionSource?.find(source => source.id === member.id);
        const preference = declared && savedCommandPreference(declared, true);
        return preference?.preference === 'deny' ? { ...member, executePreference: 'deny' as const, builtinToolDefaultsRevision: 1 as const } : member;
      }) };
    }
    if (!currentTarget() || !await persistence.savedTeamSourceMatches(ref, loaded.sourceVersion)) {
      void showResultNotice('warning', 'The selected saved team changed. Reopen the picker; no team was loaded.'); return [];
    }
    if (!await restoreTeamDocument(document, currentTarget, () => persistence.savedTeamSourceMatches(ref, loaded.sourceVersion), ref,
      ref.scope === 'global' || restoreSavedPermissions ? loaded.permissionSource : undefined)) return [];
    const warnings = filterReviewedPermissionWarnings(document.validationWarnings ?? [], loaded.fingerprintMatched, false,
      restoreSavedPermissions && !!loaded.permissionSource);
    if (warnings.length > 0) {
      void showResultNotice('warning',
        `"${label}" contains ${warnings.length} settings this version does not recognise. They were ignored; you can review them in the team file.`);
    }
    const loadedRevision = teamRosterRevision;
    const loadedSessions = sessionManager.getAll();
    const stillLoaded = () => agentRosterEdits.admissionAllowed && loadedRevision === teamRosterRevision
      && loadedSessions.length === sessionManager.getAll().length
      && loadedSessions.every(session => sessionManager.get(session.id) === session);
    let loadedReadOnly = ref.scope === 'workspace' && !restoreSavedPermissions;
    let regainedPermissionAgents = 0;
    if (ref.scope === 'workspace' && restoreSavedPermissions) {
      const restored = await restoreAllSavedPermissions(loaded.permissionSource ?? [], stillLoaded, loaded.fingerprintMatched,
        () => persistence.savedTeamSourceMatches(ref, loaded.sourceVersion));
      if (!stillLoaded()) return [];
      regainedPermissionAgents = restored.regainedPermissionAgents;
      loadedReadOnly = regainedPermissionAgents === 0;
      if (restored.failures.length > 0) {
        void showResultNotice(
          'error',
          `Saved permissions could not be restored for ${restored.failures.join('; ')}. Those agent(s) remain read-only.`,
        );
      }
    } else if (shouldReviewSavedPermissions(ref.scope, loaded.fingerprintMatched)) {
      void showResultNotice('warning', `Opened "${label}" without restoring these saved permissions:\n${savedPermissionSummary(loaded.permissionSource ?? [])}\nBuilt-in agents can still run commands; turn it off per agent in Agent Builder.`);
      regainedPermissionAgents = await reviewSavedPermissions(loaded.permissionSource ?? [], stillLoaded);
      loadedReadOnly = regainedPermissionAgents === 0;
    }
    if (!stillLoaded()) return [];
    const permissionResult = loadedReadOnly && sessionManager.getAll().some(session => session.config.roleTemplateKey
      && Object.hasOwn(ROLE_TEMPLATES, session.config.roleTemplateKey) && (!session.config.allowedTools || session.config.allowedTools.includes('execute')))
      ? 'Built-in agents can still run commands; turn it off per agent in Agent Builder.'
      : savedPermissionLoadResult(loadedReadOnly, regainedPermissionAgents);
    void showResultNotice('information', `Opened "${label}" — ${document.members.length} agent(s) restored. ${permissionResult} `
      + 'Agents remain stopped until you start them.');
    // v0.9.106 (first use, §3.8): which saved team was opened last, so a returning person is offered it first.
    void recordTeamUse(ref);
    return sessionManager.getAll().map((session) => session.config);
  }
  openSavedTeamForFirstUse = openSavedTeam;

  async function restorePreviousTeam(): Promise<AgentConfig[]> {
    const automatic = (await persistence.listSavedTeams()).filter((entry) => entry.automatic);
    if (automatic.length === 0) {
      void showResultNotice('information', 'There are no automatic team snapshots to restore.');
      return [];
    }
    const ref = await pickPreviousTeamSnapshot();
    return ref ? openSavedTeam(ref) : [];
  }

  async function createOrLoadTeam(): Promise<AgentConfig[]> {
    const action = await pickCreateOrLoadTeamAction();
    if (!action) return [];
    if (action.action === 'save') {
      await saveCurrentTeam();
      return [];
    }
    if (action.action === 'saved') {
      return openSavedTeam(action.ref);
    }
    if (action.action === 'restore') {
      return restorePreviousTeam();
    }
    // Stage the complete preset before the same guarded transaction used by saved-team loading.
    const result = await dialogs.createTeamFromPreset({
      ...dialogDeps(),
      captureRosterTarget: () => agentRosterEdits.capture(),
      replacePresetTeam: restoreTeamDocument,
      listSavedTeams: () => persistence.listSavedTeams(),
      openSavedTeam,
      saveCurrentTeam,
      restorePreviousTeam,
      assertCanCreateTeam: assertDefaultProviderCanCreateAgents,
    }, action);
    if (result.length && context.extensionMode !== vscode.ExtensionMode.Test) {
      void syncTeamRulesOnRosterChange();
    }
    teamViewProvider?.refresh();
    return result;
  }

  reg('unode.openSavedTeam', () => guard(createOrLoadTeam));
  reg('unode.createTeamPreset', () => guard(createOrLoadTeam));
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
  // agent, it stays on Solo. Since v0.9.106 it is a Team Actions entry (no longer a title-bar icon); the entry
  // runs the variant that matches whether Solo is selected.
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
  reg('unode.agentStart', (id: string) => guard(() => {
    resultDeliveryHost.scope(id, 'explicit-resume'); return sessionManager.start(id, { pin: 'take' });
  }));
  reg('unode.agentStop', (id: string) => guard(async () => {
    stopPreparingMessages([id]);
    await sessionManager.stop(id);
    return sessionManager.getAll();
  }));
  // A restart is the lifecycle reset of the agent's command lane too: a quarantine and a cached profile failure end
  // with it, and a pending command approval closes at once instead of waiting for its deadline.
  reg('unode.agentRestart', (id: string) => guard(async () => {
    const result = await sessionManager.restart(id); resultDeliveryHost.scope(id, 'explicit-resume'); return result;
  }));
  reg('unode.agentRemove', (id: string) => guard(async () => { const r = await sessionManager.remove(id); syncSoloContext(); return r; }));
  // #13 Phase 2: reveal an agent's command terminal (from the Team panel). Creates one on demand
  // so every agent — even a PM that only delegates — has its own visible terminal thread.
  reg('unode.showAgentTerminal', (id: string) => terminalManager.reveal(id, `Unode: ${resolveAgentName(id)}`, workspaceRoot()));
  // V1 Checkpoints: revert a file an agent edited back to a previous version.
  reg('unode.restoreCheckpoint', () => guard(() => restoreCheckpointCommand()));
  // v0.9.110 R2: Revert to before a request, Undo revert, Redo revert.
  reg('unode.revertToRequest', (args?: { agentId?: string; historyId?: string }) => guard(() => revertToRequestCommand(args)));
  reg('unode.undoRevert', () => guard(() => stepRevertCommand('undo')));
  reg('unode.redoRevert', () => guard(() => stepRevertCommand('redo')));
  reg('unode.deleteCheckpoint', () => guard(() => deleteCheckpointCommand()));
  reg('unode.showCheckpointDiff', (checkpointId: unknown) => guard(() => showCheckpointDiffCommand(checkpointId)));
  reg('unode.restoreCheckpointById', (checkpointId: unknown) => guard(() => restoreCheckpointByIdCommand(checkpointId)));
  // v0.9.97: the person's view of saved task batches: open one as an unsaved draft, or delete it.
  reg('unode.savedTaskBatches', () => guard(() => savedTaskBatchesCommand()));
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
    const accepted = await promptCommandApproval(commandPolicy.approvalMode, projectCommandApprovals);
    if (accepted) {
      reloadCommandPolicy();
    }
  });
  reg('unode.manageProjectCommandApprovals', () => guard(async () => {
    const approvals = projectCommandApprovals.list();
    const executionEnabled = projectCommandApprovals.isExecutionEnabled();
    if (approvals.length === 0 && !executionEnabled) {
      void showResultNotice('information', 'UnodeAi: this project has no saved command approvals.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      [
        ...(executionEnabled ? [{ label: '$(circle-slash) Disable command execution for this project', action: 'disable' as const }] : []),
        // Each approval belongs to one shell grammar, and revoking it removes exactly the key shown.
        ...approvals.map((key) => ({ label: `${grammarDisplayName(key.grammar)} · ${key.template}`, action: 'command' as const, key })),
      ],
      {
        title: 'Project Command Approvals',
        placeHolder: 'Select an approval to inspect or revoke',
      },
    );
    if (!picked) return;
    if (picked.action === 'disable') {
      const choice = await vscode.window.showWarningMessage(
        'Disable command execution for this project and revoke all of its saved command approvals?',
        { modal: true },
        'Keep approval',
        'Disable for project',
      );
      if (choice !== 'Disable for project') return;
      await projectCommandApprovals.disableExecution();
      reloadCommandPolicy();
      void showResultNotice('information', 'UnodeAi: command execution and saved approvals were revoked for this project.');
      return;
    }
    const shown = `${grammarDisplayName(picked.key.grammar)} · ${picked.key.template}`;
    const choice = await vscode.window.showWarningMessage(
      `Revoke the project command approval "${shown}"?`,
      { modal: true },
      'Keep approval',
      'Revoke approval',
    );
    if (choice !== 'Revoke approval') return;
    await projectCommandApprovals.revoke(picked.key);
    reloadCommandPolicy();
    void showResultNotice('information', `UnodeAi: revoked project approval for "${shown}".`);
  }));
  reg('unode.agentEdit', (id: string) => guard(() => dialogs.showEditAgentDialog(dialogDeps(), id)));
  reg('unode.showAgentOutput', (id: string) => getAgentChannel(id).show());

  // Flip the concurrency mode from the Team-panel title-bar icon (or command palette). Switching to Worktree
  // on a non-git folder reuses the same git-init / Optimistic prompt agents hit at runtime. The toolbar shows
  // one of two icons gated on the unode.worktreeMode context key (set here + on activation + on config change).
  reg('unode.toggleConcurrencyMode', () => guard(async () => {
    const cfg = vscode.workspace.getConfiguration('unode');
    const next = configuredSetting<string>('concurrencyStrategy', 'optimistic') === 'worktree' ? 'optimistic' : 'worktree';
    await cfg.update('concurrencyStrategy', next, vscode.ConfigurationTarget.Global);
    syncConcurrencyContext();
    teamViewProvider?.refresh();
    if (next === 'optimistic') {
      void showResultNotice('information', 'UnodeAi: switched to Optimistic mode — agents share this workspace. Applies to each agent’s next turn.');
    } else if (await isWorkspaceGitRepo()) {
      void showResultNotice('information', 'UnodeAi: switched to Worktree mode — each agent gets an isolated git worktree on its next start.');
    } else {
      worktreeGitWarningShown = false; // let the non-git warning surface for this explicit switch
      await warnWorktreeNeedsGit();
    }
  }));
  // The two title-bar icons (Optimistic vs Worktree) both just trigger the toggle; the icon shown indicates
  // the CURRENT mode (see package.json view/title when-clauses on unode.worktreeMode).
  reg('unode.concurrencyMode.optimistic', () => vscode.commands.executeCommand('unode.toggleConcurrencyMode'));
  reg('unode.concurrencyMode.worktree', () => vscode.commands.executeCommand('unode.toggleConcurrencyMode'));

  // v0.9.106: the Team title bar pins at most four icons (New Task/Workbench, Add Agent, this menu and Settings).
  // A title bar is a fixed-width row: every icon beyond what fits goes into VS Code's own unlabelled "..."
  // overflow, so on a narrow sidebar a long pinned row is the same as no row at all. Every other team-level action
  // lives here instead — named, and always one click deep no matter how thin the sidebar gets. Solo, Send Message
  // and Collapse/Expand were title-bar icons before 0.9.106; Dashboard, Workflows and Saved Task Batches were
  // reachable only from the Command Palette, which now lists only the everyday entries and this menu.
  reg('unode.teamActions', () => guard(async () => {
    const worktree = configuredSetting<string>('concurrencyStrategy', 'optimistic') === 'worktree';
    const compact = teamViewProvider?.isCompact() === true;
    const soloSelected = isSoloSelected();
    const items: Array<vscode.QuickPickItem & { target: string }> = [
      {
        label: '$(zap) Solo Agent (toggle)',
        description: soloSelected ? 'Solo is selected: switch the chat back to your team' : 'Create or select one agent that works alone',
        target: soloSelected ? 'unode.startSoloActive' : 'unode.startSolo',
      },
      { label: '$(send) Send Message to Agent', description: 'Pick an agent and send it a message', target: 'unode.sendMessage' },
      compact
        ? { label: '$(expand-all) Expand Team Cards', description: 'Show each session as a row', target: 'unode.expandTeam' }
        : { label: '$(collapse-all) Collapse Team to Icons', description: 'Show the roster as one chip strip', target: 'unode.collapseTeam' },
      { label: '$(person-add) Build an Agent', description: 'Role, model, tools, playbooks, MCP grants', target: 'unode.openAgentBuilder' },
      { label: '$(organization) Create/Save/Load a Team…', description: 'System defaults and saved teams', target: 'unode.createTeamPreset' },
      {
        label: '$(milestone) Setup guide…',
        description: 'Connections, team, permissions, folders, skills and MCP: what is set and where to change it',
        target: 'unode.setupGuide',
      },
      { label: '$(play) Start All Agents', target: 'unode.startAllAgents' },
      { label: '$(debug-stop) Stop All Agents', description: 'End every running turn now — also in the status bar while agents run', target: 'unode.stopAllAgents' },
      { label: '$(law) Edit Team Rules', target: 'unode.editTeamRules' },
      { label: '$(run-all) Run Workflow', target: 'unode.runWorkflow' },
      { label: '$(type-hierarchy-sub) Edit Workflow', target: 'unode.editWorkflow' },
      { label: '$(archive) Saved Task Batches…', description: 'Open a saved batch as a draft, or delete it', target: 'unode.savedTaskBatches' },
      { label: '$(history) Restore File Checkpoint…', target: 'unode.restoreCheckpoint' },
      { label: '$(trash) Delete File Checkpoint…', target: 'unode.deleteCheckpoint' },
      {
        label: worktree ? '$(git-branch) Concurrency — Worktree' : '$(files) Concurrency — Optimistic',
        description: `Click to switch to ${worktree ? 'Optimistic' : 'Worktree'}`,
        target: 'unode.toggleConcurrencyMode',
      },
      { label: '$(dashboard) Dashboard', description: 'Lanes, latest tasks and Spend', target: 'unode.showDashboard' },
      { label: '$(extensions) Marketplace', description: 'Skills, MCP servers and agent packs', target: 'unode.openMarketplace' },
      { label: '$(account) Unode Account / Profile', description: 'Connection status, balance, credits and pricing', target: 'unode.openAccount' },
      { label: '$(shield) Security', target: 'unode.showSecurity' },
      // Settings stays a pinned icon and is deliberately not repeated here — a menu that lists what is
      // already on screen is the sub-panel UX3-R removed.
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
      showResultNotice('warning', 'No agents configured. Add an agent first.');
      return;
    }
    return dialogs.showSendMessageDialog(dialogDeps(), agents.map((a) => a.config), request);
  }));

  // v0.9.106 (first use, design §3.1): with no agent the Chat opens on its goal box, where the person writes the goal
  // first; it no longer asks to create a team before anything can be typed. With agents nothing changed.
  reg('unode.openChat', () => guard(async () => {
    const noAgents = sessionManager.getAll().length === 0;
    chatViewProvider.refresh();
    let container: 'workbench' | 'sidebar';
    if (vscode.workspace.getConfiguration('unode').get<boolean>('workbench.autoOpen', true)) {
      chatViewProvider.openWorkbench(false);
      container = 'workbench';
    } else {
      await vscode.commands.executeCommand('unode.chat.focus');
      container = 'sidebar';
    }
    if (noAgents) chatViewProvider.focusFirstUse(container);
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
      // Safe to expose only in Test mode; it proves fixture setup without exposing a secret value.
      return reconcileE2EFixtureApiKey(
        {
          read: () => secrets.get('UNODE_API_KEY'),
          writeFixture: async () => { await secrets.set('UNODE_API_KEY', 'sk-e2e-offline'); },
          removeFixture: () => secrets.delete('UNODE_API_KEY'),
        },
        (options as { clear?: unknown }).clear === true,
      );
    }
    await dialogs.showSetApiKeyDialog(dialogDeps());
  }));

  // v0.9.106 (first use, design §6): the setup wizard was removed. Its command, the Settings button and the empty Team
  // panel open the Workbench (the Owner, 2026-11-18), which with no agent is the goal box; with agents, as Open
  // Workbench does.
  reg('unode.onboarding', () => guard(async () => {
    openFirstUseWorkbench(false);
    return true;
  }));

  // v0.9.106 (setup guide, the Owner, 2026-11-18): the optional guide through the basic setup, in the editor area. Only a
  // person opens it (this command, Team Actions, Settings → Providers, the link under the first-task screen); it is
  // never opened at activation, records no completion and sends nothing.
  reg('unode.setupGuide', () => guard(async () => {
    SetupGuidePanel.createOrShow(setupGuideHost());
  }));

  reg('unode.runDemoTask', (taskId?: string) => guard(() => runDemoTask(taskId)));

  // The explicit "I want live prices now" path. Everything else that fetches prices is either background
  // (silent, approved hosts only) or incidental to another action; this is the one the user can reach on
  // purpose, and it reports what actually happened instead of failing quietly.
  reg('unode.refreshPrices', () => guard(async () => {
    await refreshPrices({ interactive: true, trigger: 'explicit command' });
    const live = (await pricingSources()).filter((s) => hasMetadataConsent(hostOf(s.url)));
    void showResultNotice('information', live.length > 0
        ? `Live prices refreshed from ${live.map((s) => hostOf(s.url)).join(', ')}.`
        : 'No gateway is approved for price lookups, so UnodeAi is using its built-in price table. '
          + 'Approve a gateway when asked, or run an agent turn, to see your account\'s discounted prices.');
    // The user-requested refresh and its result are complete. Legacy-key maintenance starts only now and
    // settles independently, so a rejected User Settings write cannot abort or rewrite that result.
    startPriceMultiplierReadRepairAfterUserAction('Refresh model prices');
  }));

  reg('unode.showSecurity', () =>
    SecurityPanel.createOrShow({
      displayNameForProviderId: (providerId) => displayNameForProviderId(providerId, effectiveConnectionRegistry),
      getState: async () => {
        const folders = vscode.workspace.workspaceFolders ?? [];
        return {
          workspaceTrusted: vscode.workspace.isTrusted,
          virtualWorkspace: folders.length > 0 && folders.every((f) => f.uri.scheme !== 'file'),
          commandApproval: configuredSetting<string>('commandApproval', 'all'),
          writeApproval: configuredSetting<string>('writeApproval', 'none'),
          concurrencyStrategy: configuredSetting<string>('concurrencyStrategy', 'optimistic'),
          fetchCatalog: configuredSetting<boolean>('marketplace.fetchCatalog', false),
          // The EFFECTIVE state, not the setting: with no bundled signing key the catalog is never fetched,
          // however the setting reads. Rendering this pure function's answer keeps the panel honest, and
          // computing it never triggers a fetch (the hosted catalog stays lazy).
          catalogStatus: describeHostedCatalogStatus({
            enabled: configuredSetting<boolean>('marketplace.fetchCatalog', false),
            url: configuredSetting<string>('marketplace.catalogUrl', ''),
            publicKeyPem: CATALOG_PUBLIC_KEY_PEM,
            outcome: lastHostedCatalogOutcome(),
          }),
          egressGrants: consentGrants.list('model'),
          codexGrants: codexEgressConsent.list(),
          metadataGrants: consentGrants.list('metadata'),
          mediaGrants: consentGrants.list('media'),
          localReadScopes: localReadScopeConsent.list(),
          pathAccessGrants: localReadScopeConsent.listPathAccess(),
          codexSessionNetwork: codexSessionNetwork.allowedAgents().map((agentId) => ({
            agentId, agentName: sessionManager.get(agentId)?.config.name ?? agentId,
          })),
          repositoryCliGrants: repositoryCliTrustRecords(),
          mcpServers: mcpHub.listServers(),
          agents: sessionManager.getAll().map((session) => ({
            id: session.config.id,
            name: session.config.name,
            backend: session.config.backend ?? defaultBackendKind(session.config, effectiveConnectionRegistry),
            folderAccess: session.config.folderAccess ?? [],
            mcpServers: session.config.mcpServers ?? [],
            alwaysAllowedTools: agentToolAlwaysAllow?.list(session.config.id) ?? [],
            effectivePolicy: effectivePolicyForAgent(session.config),
          })),
          providers: (await settingsBridge.getProviderStatuses()).map((p) => ({ providerId: p.providerId, hasApiKey: p.hasApiKey })),
        };
      },
      revokeEgressHost: (host, kind, mediaKind, modelScope) => revokeEgressConsent(host, kind, mediaKind, modelScope),
      revokeAlwaysAllowedTool: (agentId, toolName) => agentToolAlwaysAllow?.forget(agentId, toolName),
      revokePathAccess: (id) => { localReadScopeConsent.revokePathAccess(id); },
      // v0.9.102 (R2): the next turn starts without network; a running turn keeps the sandbox it started with.
      removeCodexSessionNetwork: (agentId) => {
        if (!codexSessionNetwork.remove(agentId)) return;
        const name = sessionManager.get(agentId)?.config.name ?? agentId;
        chatViewProvider?.postRuntimeNotice(agentId, `${name}: network was removed. A Codex turn running now started with it `
          + 'and keeps it until that turn ends; the next turn starts without it. To end the running turn now, press Stop. '
          + 'Stop does not undo what was already sent.');
      },
      revokeRepositoryCliGrant: (kind, cwd, digest) => {
        void revokeRepositoryCliTrust(kind, cwd, digest).catch((error) => {
          outputChannel.error(`Failed to revoke repository CLI grant: ${String(error)}`);
        });
      },
      grantLocalReadScope: async (root) => {
        const decision = localReadScopeConsent.list().find((candidate) => candidate.absoluteRoot === path.resolve(root));
        if (decision?.status !== 'declined') { return; }
        await localReadScopeConsent.requestGrant(decision.absoluteRoot);
      },
      revokeLocalReadScope: (root) => {
        const decision = localReadScopeConsent.list().find((candidate) => candidate.absoluteRoot === path.resolve(root));
        if (decision?.status === 'granted') {
          localReadScopeConsent.revoke(decision.absoluteRoot);
        }
      },
      openSettings: () => vscode.commands.executeCommand('unode.openSettings'),
    }));

  reg('unode.openDocumentSettings', () => vscode.commands.executeCommand('unode.openSettings', 'more'));
  reg('unode.openSettings', (tab?: unknown) => {
    SettingsPanel.createOrShow(context.extensionUri, {
      getCompletionVerification: () => teamVerificationEditor.prepare(),
      getResultRecoveryStatus: () => persistence.getResultRecoveryStatus(),
      saveCompletionVerification: (token, policy) => teamVerificationEditor.save(token, policy),
      openLegacyVerificationUserSettings,
      displayNameForProviderId: (providerId) => displayNameForProviderId(providerId, effectiveConnectionRegistry),
      bridge: settingsBridge,
      getLocalApplications: () => localApplications.current(),
      refreshLocalApplications: async () => { await localApplications.detect(true); SecurityPanel.refreshIfOpen(); SetupGuidePanel.refreshCurrent(); chatViewProvider?.refresh(); },
      getSignatureStatus: () => pdfSignatures?.cachedStatus(),
      chooseSignature: async () => {
        if (!pdfSignatures) return;
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false,
          filters: { 'PNG image': ['png'] }, openLabel: 'Use as my signature' });
        if (!picked?.[0]) return;
        const bytes = Buffer.from(await vscode.workspace.fs.readFile(picked[0]));
        const saved = await pdfSignatures.save(bytes);
        if (saved.ok) void showResultNotice('information', signatureSaveNotice(saved));
        else void showResultNotice('warning', signatureSaveNotice(saved));
      },
      deleteSignature: async () => { await pdfSignatures?.delete(); },
      getOfficeRendererPreference: () => currentOfficeRenderPreferences().preferred,
      setOfficeRendererPreference: async preference => { await rootWorkspaceState.update(OFFICE_RENDERER_PREFERENCE_KEY, preference); },
      wordPowerPointRendering: wordPowerPointRenderingPlatform(process.platform),
      getImageConnection: selectedImageConnection,
      getImageModel: () => readImageGenerationModel(vscode.workspace.getConfiguration('unode')),
      supportsImageConnection: connectionId => imageConnections?.supports(connectionId) === true,
      imageModelForConnection: connectionId => imageConnections?.modelForConnection(connectionId),
      setImageConnection: async connectionId => {
        const modelId = connectionId ? imageConnections?.modelForConnection(connectionId) : undefined;
        if (connectionId && !modelId) return;
        await saveImageDefault(connectionId && modelId ? { connectionId, modelId } : undefined);
      },
      mediaDefaultsLabel: configured => {
        const settings = vscode.workspace.getConfiguration('unode');
        const image = readImageGenerationConnection(settings);
        const model = readImageGenerationModel(settings);
        const audio = readTranscriptionDefault(settings);
        const label = (id: string, modelId: string | undefined, supported: boolean) => {
          const profile = mediaConnectionProfile(id);
          const reason = !profile ? 'Connection unavailable' : !configured.has(id) ? 'API key required'
            : !supported ? 'Model unavailable on this connection' : undefined;
          return [profile?.presentation.displayName ?? id, modelId, reason].filter(Boolean).join(' · ');
        };
        return {
          image: image ? label(image, model, !!model && imageConnections?.modelForConnection(image) === model) : 'None',
          transcription: audio ? label(audio.connectionId, audio.modelId, verifiedUnodeTranscriptionModel(audio)) : 'None',
        };
      },
      prepareMediaDefault: async capability => {
        const model = await pickMemberMediaModel(capability, () => !hostShutdown.started && !workspaceBinding.isStale());
        if (!model) return;
        if (capability === 'image-generation') {
          if (imageConnections?.modelForConnection(model.connectionId) !== model.modelId) {
            void showResultNotice('information', 'This model is unavailable for image generation on the selected connection. Choose a supported model.');
            return;
          }
          await saveImageDefault(model);
        } else {
          await updateUserAuthoritySetting('transcriptionDefault', model);
        }
      },
      clearTranscriptionDefault: async () => { await updateUserAuthoritySetting('transcriptionDefault', null); },
      replySuggestionModel: () => replySuggestions?.settingView() ?? { configured: false, label: 'None' },
      chooseReplySuggestionModel: () => chooseReplySuggestionModel(),
      turnOffReplySuggestions: async () => { await updateUserAuthoritySetting('replySuggestions.model', null); },
      // The existing key-setting route, for the key the host itself names; the page names nothing.
      setReplySuggestionKey: async () => {
        const secretName = replySuggestions?.settingView().keyAction?.secretName;
        if (secretName) await dialogs.promptAndStoreProviderKey(dialogDeps(), secretName);
      },
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
      getAllowCrossProviderDispatch: () => configuredSetting(
        ALLOW_CROSS_PROVIDER_DISPATCH_SETTING,
        ALLOW_CROSS_PROVIDER_DISPATCH_DEFAULT,
      ) === true,
      setAllowCrossProviderDispatch: async (allowWithoutApproval) => {
        // Application-scoped: user settings are the only place it can live.
        await vscode.workspace.getConfiguration('unode')
          .update(ALLOW_CROSS_PROVIDER_DISPATCH_SETTING, allowWithoutApproval, vscode.ConfigurationTarget.Global);
      },
      getResultNoticeStyle: () => readResultNoticeStyle(vscode.workspace.getConfiguration('unode')),
      setResultNoticeStyle: async (style) => {
        if (style !== 'dialog' && style !== 'quiet') { return; }
        await vscode.workspace.getConfiguration('unode')
          .update(RESULT_NOTICE_STYLE_SETTING, style, vscode.ConfigurationTarget.Global);
      },
      getProviderAutomaticRefresh: (providerId) => providerHasScheduledPriceRefresh(providerId)
        ? providerAutomaticRefreshEnabled(automaticRefreshSettings, providerId)
        : undefined,
      setProviderAutomaticRefresh,
      getGlobalPricingSourcesAutomaticRefresh: () => automaticRefreshSettings.globalPricingSources,
      setGlobalPricingSourcesAutomaticRefresh,
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
          void showResultNotice('warning', `Kept your explicit ${contextWindowTokens.toLocaleString()}-token context window; `
            + `${profile.presentation.displayName} reported ${measurement.tokens.toLocaleString()} via ${measurement.field}.`);
        }
        info.config.contextWindowTokens = contextWindowTokens;
        await saveRoster();
        teamViewProvider?.refresh();
      },
      getSmartMode: () => {
        const sm = readSmartMode();
        const tiers = resolveModelTiers(
          configuredSetting<Partial<Record<ModelTier, Record<string, string>>>>('modelTiers', {})
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
            await cfg.update('smartMode.roleTiers', withRoleTierOverride(readSmartMode().roleTiers, patch.role, patch.value));
            break;
          }
          case 'modelTierCell': {
            // Store only deltas in unode.modelTiers so future default changes still flow through.
            const raw = configuredSetting<Record<string, Record<string, string>>>('modelTiers', {});
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
      chooseCliExecutable,
      showCliUpdateInstructions,
      cliRuntimeStatus,
      managedCodexCard: () => managedCodexCardView(),
      managedCodexAction: async (action, key) => { await managedCodexPanel()?.act(action, key); },
      // Reuse the Agent Builder's live model source so the tier-matrix datalists suggest each provider's real ids.
      listModels: (providerId, baseUrl) => agentBuilderListModels(providerId, baseUrl, 'Settings Smart picker'),
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
      // v0.9.89 Settings → Spend: host-validated, User Settings only, no secret in the view model.
      getSpendSettings: () => spendSettingsView(),
      saveSpendTargets: async (raw) => {
        const knownAgents = new Set(sessionManager.getAll().map((session) => session.config.id));
        const candidate = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
        if (candidate.agents && typeof candidate.agents === 'object') {
          // A share can only name an agent this host knows; anything else is dropped, not stored.
          candidate.agents = Object.fromEntries(Object.entries(candidate.agents as Record<string, unknown>).filter(([id]) => knownAgents.has(id)));
        }
        const parsed = parseUserTargets(candidate);
        await updateUserAuthoritySetting('spend.targets', userTargetsToSettings(parsed));
        return parsed.diagnostics;
      },
      setReferencePriceMode: async (mode) => {
        await updateUserAuthoritySetting('spend.referencePriceMode', mode);
      },
      spendAction: async (action) => {
        switch (action) {
          case 'updateUnode': await vscode.commands.executeCommand('unode.updateUnodeReferencePrices'); return;
          case 'updateRoam': await vscode.commands.executeCommand('unode.updateRoamReferencePrices'); return;
          case 'repair': await vscode.commands.executeCommand('unode.repairSpendTracking'); return;
          case 'reviewProposal': await vscode.commands.executeCommand('unode.reviewRepositorySpendTargets'); return;
          case 'enableReview': await spendHost?.enableRepositoryReview(); return;
          case 'openSpend': await vscode.commands.executeCommand('unode.openSpend'); return;
        }
      },
    }, tab === 'account' ? 'account' : tab === 'spend' ? 'spend' : tab === 'more' ? 'more' : 'providers');
    // Opening the product panel must not depend on a best-effort write to the editor's User Settings.
    // Cursor rejects configuration updates while settings.json has an error/warning; awaiting this repair
    // before createOrShow made the command visibly do nothing. The panel is already open now, and the repair
    // settles independently with both an output-channel record and a human-visible recovery path.
    startPriceMultiplierReadRepairAfterUserAction('Settings', () => SettingsPanel.refreshCurrent());
  });

  // Account work stays in the Settings panel (not another Team title-bar icon). The Account tab itself
  // contains only host-owned browser routes and status derived from SecretStorage/metadata consent.
  reg('unode.openAccount', () => vscode.commands.executeCommand('unode.openSettings', 'account'));

  reg('unode.openMarketplace', (tab?: unknown) =>
    MarketplacePanel.createOrShow(
      context.extensionUri,
      (action) => handleMarketplaceInstall(action, context.extensionUri, restoreTeamDocument),
      asMarketplaceTab(tab),
      marketplaceViewState,
      removeManagedIntegration,
      grantManagedIntegration,
      editManagedIntegration,
      manageIntegrationTest,
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
    void showResultNotice('information', `UnodeAi: ${msg}`);
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
        void showResultNotice('warning', `UnodeAi: that lane (${action.agentId}) is no longer active.`);
        return;
      }
      const agentName = sessionManager.get(wt.agentId)?.config.name ?? wt.agentId;
      if (action.command === 'mergeLaneUnverified') {
        const result = await worktreeCoordinator?.mergeWithoutVerification(wt.agentId, review => confirmWorktreeMerge({
          ...review, agentName: sessionManager.get(review.agentId)?.config.name ?? review.agentName,
        }));
        if (result?.kind === 'result') {
          const r = result.result;
          if (r.status === 'merged' || r.status === 'nothing') {
            void showResultNotice('information', `Merged ${wt.branch} into integration — unverified. Finalize is a separate action.`);
          } else {
            void showResultNotice('warning', `Lane not merged: ${r.message}`);
          }
        } else if (result?.kind !== 'cancelled') {
          void showResultNotice('warning', 'Lane not merged. It may be in use, have uncommitted changes, or have changed since review. Refresh and try again when it is idle.');
        }
        await refreshWorktreePanel();
        return;
      }
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
          void showResultNotice('warning', 'UnodeAi: could not resolve the base commit for this lane.');
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
        const r = await sessionManager.withCompletedTurnWork(wt.agentId, owner => worktreeCoordinator?.reverify(wt.agentId!, owner) ?? Promise.resolve(undefined));
        void showResultNotice('information', !r ? 'This lane has no current completed task to re-verify. Wait for its active task to finish, or inspect it manually.'
          : r.check?.kind === 'outcome-unknown' ? 'No new check started: the previous verification outcome is still unknown. The lane remains unmerged.'
            : r.check?.kind === 'not-run' ? `Check not run (${r.check.reason}). The lane remains unmerged.`
              : `Re-verified ${agentName}: ${r.status}.`);
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
      void showResultNotice('information', `Handed the lane back to ${agentName}.`);
    }
  ));

}

async function guidedAddMcpServer(): Promise<void> {
  if (!firstWorkspaceRoot()) {
    await showWorkspaceBindingRequired('add integration configuration');
    return;
  }
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
    showResultNotice('error', `UnodeAi: ${parsedEnv.error}`);
    return;
  }

  const cfg: MCPServerConfig = {
    id: userMcpServerId(name),
    name: name.trim(),
    transport,
    command: command?.trim() || undefined,
    args,
    url: url?.trim() || undefined,
    env: parsedEnv.env,
  };
  await saveManagedIntegration(undefined, cfg);
  await approveUserAddedMcpServer(cfg);
  settingsPanelRefresh();
  const res = mcpMountMessage(cfg.name, await mountMcpServer(cfg));
  if (res.ok) { showResultNotice('information', `UnodeAi: ${res.message}`); }
  else { showResultNotice('warning', `UnodeAi: ${res.message}`); }
}

function userMcpServerId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server';
  return `user-${slug}-${Date.now().toString(36)}`;
}

/** Open (creating if needed) the versionable .unode/team.json. */
async function openTeamFile(): Promise<void> {
  const root = firstWorkspaceRoot();
  if (!root) {
    await showWorkspaceBindingRequired('open .unode/team.json');
    return;
  }
  const uri = vscode.Uri.joinPath(vscode.Uri.file(root), '.unode', 'team.json');
  await persistence.ensureTeamFile();
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
    // v0.9.106 (NC-1): a start refused because no CLI program is chosen has its own notice, with Open Settings.
    if (!isProgramNotChosen(err)) showResultNotice('error', `UnodeAi: ${msg}`);
    return undefined;
  }
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
    // v0.9.106 (first use): with no agent the demo task becomes the goal in the Chat's goal box, when that box is empty.
    // Nothing is sent; the person chooses how to start it.
    await firstUseController?.offerGoal(task.prompt);
    await vscode.commands.executeCommand('unode.openChat');
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
  showResultNotice('information', `Sent "${task.title}" to ${pm.config.name}.`);
}

// ─── First use (v0.9.106) ───────────────────────────────────────────────

/**
 * §3.5: what this VS Code profile held before this activation wrote anything. The synchronous stores are read at once;
 * SecretStorage is read asynchronously, which no activation step writes. A store that cannot be read makes the cohort
 * unknown, which never opens the Workbench.
 */
function readInstallCohort(context: vscode.ExtensionContext): Promise<InstallCohort> {
  let globalStateKeys: readonly string[] | undefined;
  try { globalStateKeys = [...context.globalState.keys()]; } catch { globalStateKeys = undefined; }
  let globalStorageNonEmpty: boolean | undefined;
  try {
    const folder = context.globalStorageUri.fsPath;
    globalStorageNonEmpty = existsSync(folder) && readdirSync(folder).length > 0;
  } catch { globalStorageNonEmpty = undefined; }
  let explicitUserSettings: boolean | undefined;
  try {
    // v0.9.106: the manifest declares two settings sections (an array); read every section's keys.
    const declared = contributedSettingProperties(context.extension?.packageJSON?.contributes);
    const settings = vscode.workspace.getConfiguration('unode');
    explicitUserSettings = Object.keys(declared).some((key) => key.startsWith('unode.')
      && settings.inspect(key.slice('unode.'.length))?.globalValue !== undefined);
  } catch { explicitUserSettings = undefined; }
  const secretNames = [...new Set(CONNECTION_PROFILES.flatMap((profile) => profile.apiKeySecretName ? [profile.apiKeySecretName] : []))];
  const storedSecret = Promise.all(secretNames.map((name) => Promise.resolve(context.secrets.get(name)).then((value) => !!value)))
    .then((found) => found.some(Boolean), () => undefined);
  return storedSecret.then((secret) => classifyInstall({ globalStateKeys, globalStorageNonEmpty, explicitUserSettings, storedSecret: secret }),
    () => 'unknown' as const);
}

/**
 * §3.5 and §3.8, after the roster was restored: tell the Team panel whether this is a returning person, and reveal the
 * Workbench (first use) once for a fresh installation with no agent. The reveal keeps the focus where it is.
 */
async function settleFirstUsePresentation(context: vscode.ExtensionContext, rosterRestored: boolean): Promise<void> {
  const cohort = await (installCohort ?? Promise.resolve<InstallCohort>('unknown'));
  const entries = await persistence.listSavedTeams().catch(() => []);
  const root = workspaceRoot();
  const returning = isReturningUser(cohort, {
    savedTeams: entries.some((entry) => !entry.automatic),
    automaticSnapshots: entries.some((entry) => entry.automatic),
    projectTeamFile: !!root && existsSync(path.join(root, '.unode', 'team.json')),
  });
  void vscode.commands.executeCommand('setContext', 'unode.returningUser', returning);
  const decision = revealDecision({
    cohort,
    handled: context.globalState.get<boolean>(FIRST_USE_REVEAL_HANDLED_KEY, false) === true,
    rosterEmpty: rosterRestored && sessionManager.getAll().length === 0,
    returning,
  });
  outputChannel.info(`[first-use] install cohort ${cohort}; returning user ${returning}; reveal ${decision}.`);
  if (decision === 'none') return;
  await context.globalState.update(FIRST_USE_REVEAL_HANDLED_KEY, true);
  if (decision !== 'reveal') return;
  try {
    // The Workbench, in the editor area (the Owner, 2026-11-18); the focus stays where the person has it.
    openFirstUseWorkbench(true);
  } catch (error) {
    outputChannel.warn(`[first-use] the Workbench could not be opened: ${String(error)}`);
  }
}

/**
 * v0.9.106 (the Owner, 2026-11-18): first use happens in the Workbench, the editor-area tab, which is as visible as the
 * setup wizard was. An open Workbench is revealed; a second one is never opened. `preserveFocus` leaves the focus where
 * the person has it (the fresh-install reveal); a person's own click puts the cursor into the goal box.
 */
function openFirstUseWorkbench(preserveFocus: boolean): void {
  const noAgents = sessionManager.getAll().length === 0;
  chatViewProvider.refresh();
  chatViewProvider.openWorkbench(preserveFocus);
  if (noAgents && !preserveFocus) chatViewProvider.focusFirstUse('workbench');
}

/** §3.8: remember which saved team was opened last, in the store of its own scope. */
async function recordTeamUse(ref: TeamLibraryRef): Promise<void> {
  const record = { scope: ref.scope, slug: ref.slug, at: new Date().toISOString() };
  try {
    if (ref.scope === 'workspace') await rootWorkspaceState.update(TEAM_LAST_USED_KEY, record);
    else await extensionContext?.globalState.update(TEAM_LAST_USED_KEY, record);
  } catch (error) {
    outputChannel.warn(`[first-use] which team was opened last could not be saved: ${String(error)}`);
  }
}

async function currentReturningTeamChoice(): Promise<ReturningTeamChoice | undefined> {
  const entries = await persistence.listSavedTeams();
  return returningTeamChoice(entries, [
    parseTeamUseRecord(rootWorkspaceState.get<unknown>(TEAM_LAST_USED_KEY)),
    parseTeamUseRecord(extensionContext?.globalState.get<unknown>(TEAM_LAST_USED_KEY)),
  ]);
}

function providerKeyForFirstUse(choice: FirstUseConnectionChoice): { providerKey: string; model?: string } {
  const providerKey = legacyProviderIdForConnectionId(choice.connectionId, effectiveConnectionRegistry);
  if (!providerKey) throw new Error(`The connection "${choice.connectionId}" is not available.`);
  return { providerKey, ...(choice.model ? { model: choice.model } : {}) };
}

/** §3.3 and §3.7: the starter team on exactly the first goal's connection, with no post-create prompts. */
async function createFirstUseTeam(choice: FirstUseConnectionChoice): Promise<string | undefined> {
  const preset = TEAM_PRESETS.starter;
  const members = await dialogs.instantiateTeam({
    ...dialogDeps({ suppressInteractivePostCreatePrompts: true }),
    explicitConnection: providerKeyForFirstUse(choice),
  }, preset.roles, preset.label);
  if (members.length > 0 && extensionContext?.extensionMode !== vscode.ExtensionMode.Test) void syncTeamRulesOnRosterChange();
  teamViewProvider?.refresh();
  return members.find((member) => member.role === 'pm')?.id;
}

/** §3.7: Solo on exactly the first goal's connection, with no post-create prompts. */
async function createFirstUseSolo(choice: FirstUseConnectionChoice): Promise<string | undefined> {
  const config = await dialogs.createSoloAgent({
    ...dialogDeps({ suppressInteractivePostCreatePrompts: true }),
    explicitConnection: providerKeyForFirstUse(choice),
  });
  if (!config) return undefined;
  teamViewProvider?.refresh();
  syncSoloContext();
  return config.id;
}

/** §3.2 (N0, 2026-11-17): the Claude CLI starts, reports its version and, where it has one, answers `auth status`. */
async function checkClaudeCliForFirstUse(): Promise<ClaudeCliCheck> {
  let launch: ClaudeCliLaunch;
  try {
    launch = currentClaudeLaunch();
  } catch (error) {
    throw new ClaudeCliCheckError('not-found', error instanceof Error ? error.message : String(error));
  }
  let version: string;
  try {
    version = await checkClaudeCliVersion(launch.executable, launch.shell);
  } catch (error) {
    throw new ClaudeCliCheckError('version', error instanceof Error ? error.message : String(error));
  }
  const setup = connectionProfile('claude-cli', effectiveConnectionRegistry)?.presentation.setup;
  const registryLogin = setup?.kind === 'cli' && setup.loginCommand ? setup.loginCommand : 'claude auth login';
  // The task's Claude CLI inherits its environment, and Claude Code signs in with a credential variable there. The
  // local checks run without those variables, so a status of "signed out" would describe a different sign-in. Presence
  // only: the value is not read, logged, shown or tried.
  if (hasInheritedCredential(await firstUseClaudeEnvironment(), CLAUDE_CHECK_CREDENTIAL_KEYS)) {
    return { loggedIn: undefined, inheritedCredential: true, loginCommand: registryLogin, version };
  }
  try {
    // Only `loggedIn` is read from the answer; it also names the account, which is neither kept nor logged.
    const result = await runCliProbe(launch.executable, ['auth', 'status', '--json'], process.env, (proc) => { killProcessTree(proc, resolveHostProgram); }, {
      label: 'Claude CLI', credentialKeys: CLAUDE_CHECK_CREDENTIAL_KEYS, shell: launch.shell, cwd: cliCheckFolder(),
    });
    const loggedIn = parseClaudeAuthStatus(result.output);
    if (loggedIn !== undefined) return { loggedIn, loginCommand: registryLogin, version };
  } catch {
    // A CLI without the command: its sign-in is confirmed by the first task.
  }
  return { loggedIn: undefined, loginCommand: registryLogin, version };
}

/**
 * The environment a Claude CLI agent created for the first goal starts with: the backend's own construction
 * (resolveEnv) for a new agent on the Claude CLI connection, which has no environment of its own.
 */
async function firstUseClaudeEnvironment(): Promise<NodeJS.ProcessEnv> {
  try {
    const probe = new AgentConfigBuilder('solo').fromTemplate('solo').build();
    const provider = providerRefForConnectionId('claude-cli', effectiveConnectionRegistry);
    if (provider) probe.provider = provider;
    probe.backend = 'claude';
    probe.route = routeForConnectionId('claude-cli', probe.model, effectiveConnectionRegistry);
    return await resolveEnv(probe);
  } catch {
    // The same inherited process environment, without the per-agent additions a new agent does not have.
    return { ...process.env };
  }
}

/** CLIs found on this computer without starting them, for a person who has not chosen a connection. */
function detectedFirstUseClis(): FirstUseCli[] {
  const found: FirstUseCli[] = [];
  try { currentClaudeLaunch(); found.push('claude-cli'); } catch { /* not found */ }
  try {
    const configured = configuredCodexCliPath();
    if (configured ? existsSync(configured) : discoverCodexCliCandidates(process.env).length > 0) found.push('codex-cli');
  } catch { /* not found */ }
  return found;
}

function firstUseReadinessProbes(): FirstUseReadinessProbes {
  return {
    profile: (connectionId) => connectionProfile(connectionId, effectiveConnectionRegistry),
    hasSecret: async (secretName) => !!(await secrets.get(secretName)),
    codexPreflight: () => verifyCodexCli(configuredCodexCliPath(), process.env),
    claudeCheck: checkClaudeCliForFirstUse,
    detectedClis: detectedFirstUseClis,
  };
}

/** Prefill (never run) a CLI's login command in a terminal of its own. The person runs it there. */
function openCliLoginTerminal(cli: FirstUseCli, command: string): void {
  const setup = connectionProfile(cli, effectiveConnectionRegistry)?.presentation.setup;
  const terminal = vscode.window.createTerminal(setup?.kind === 'cli' && setup.terminalName ? setup.terminalName : `UnodeAi — ${cli}`);
  terminal.show();
  terminal.sendText(command, false);
}

/**
 * v0.9.106 (setup guide, design §4.3): the readiness check and the key, CLI and login-terminal repairs, shared by first
 * use and the setup guide. Every call reads the registry, the secrets and the configuration as they are then.
 */
let connectionReadinessService: ReadinessService | undefined;
function connectionReadiness(): ReadinessService {
  connectionReadinessService ??= createReadinessService({
    probes: firstUseReadinessProbes,
    storeKey: (secretName) => dialogs.promptAndStoreProviderKey(dialogDeps(), secretName),
    chooseCli: chooseCliExecutable,
    openLoginTerminal: openCliLoginTerminal,
    openProviders: async () => { await vscode.commands.executeCommand('unode.openSettings', 'providers'); },
  });
  return connectionReadinessService;
}

/** The existing model picker of one connection (a custom gateway has no built-in list); undefined when cancelled. */
async function chooseModelForConnection(connectionId: string): Promise<string | undefined> {
  const providerKey = legacyProviderIdForConnectionId(connectionId, effectiveConnectionRegistry);
  const profile = connectionProfile(connectionId, effectiveConnectionRegistry);
  if (!providerKey || !profile) return undefined;
  const apiKey = profile.apiKeySecretName ? await secrets.get(profile.apiKeySecretName) : undefined;
  return (await dialogs.pickModel(dialogDeps(), providerKey, '', profile.presentation.endpointDefault, apiKey))?.id;
}

/** Explicit Browse only. CLI choices come from the local registry and never launch/account-query the CLI. */
async function chooseTeamRoleModel(connectionId: string): Promise<string | undefined> {
  const profile = connectionProfile(connectionId, effectiveConnectionRegistry);
  if (!profile || profile.availability !== 'available') return undefined;
  if (profile.authKind === 'claude-cli' || profile.authKind === 'codex-cli') {
    const picked = await vscode.window.showQuickPick(profile.catalogModels.map(model => ({ label: model.id, description: model.name, model: model.id })),
      { title: `${profile.presentation.displayName} — local model choices`, placeHolder: 'Choose a local model ID, or cancel and type one in the role row' });
    return picked?.model;
  }
  return chooseModelForConnection(connectionId);
}

/**
 * v0.9.106 (setup guide, design §3 step 2 and §4.5): a team created from the setup guide, on exactly the connection
 * (and, for a custom gateway, the model) chosen in the guide. It creates the roster only: no task is sent, the default
 * connection is not written, nor is any first-use connection, model or start (first use's own hand-over of an unsent
 * goal to a new roster stays as it is), and the post-create suggestions (a missing key, "Send the PM a
 * task", enabling commands) are not shown. The model picker of a gateway with no model chosen, the key prompts, the
 * consent questions and every later permission stay as they are. Returns the members actually created.
 */
async function createTeamOnConnection(preset: 'starter' | 'solo', choice: SetupGuideCreationChoice): Promise<AgentConfig[]> {
  const roles = preset === 'starter' ? TEAM_PRESETS.starter.roles : ['solo' as const];
  const created = await dialogs.instantiateTeam({
    ...dialogDeps({ suppressInteractivePostCreatePrompts: true }),
    explicitConnection: providerKeyForFirstUse(choice),
    roleConnections: choice.roleConnections,
  }, roles, preset === 'starter' ? TEAM_PRESETS.starter.label : 'Solo');
  if (created.length > 0) {
    if (extensionContext?.extensionMode !== vscode.ExtensionMode.Test) void syncTeamRulesOnRosterChange();
    syncSoloContext();
  }
  teamViewProvider?.refresh();
  return created;
}

/** v0.9.106 (setup guide): Settings → Providers' "set as default" for one connection, by its id. */
async function setDefaultConnection(connectionId: string): Promise<void> {
  const profile = connectionProfile(connectionId, effectiveConnectionRegistry);
  if (!profile || profile.availability !== 'available') {
    throw new Error(profile?.availabilityMessage ?? `Unsupported default connection: ${connectionId}.`);
  }
  await makeConfigStore().update('defaultProvider', profile.id);
}

const SETUP_GUIDE_CLI_STATUS_NONE = 'No program found. Use Check / choose CLI.';

/**
 * v0.9.106 (setup guide, design §3): what the guide shows, read without starting a program or making a request: the
 * key-presence booleans of the Settings snapshot, the CLI program UnodeAi finds and what was last measured about it,
 * the default connection, the roster and the permissions in effect. Never a key or a raw MCP configuration.
 */
async function setupGuideSnapshot(): Promise<SetupGuideSnapshot> {
  const settings = await settingsBridge.getSnapshot();
  const defaultConnectionId = connectionIdForProviderId(resolveDefaultProvider(), effectiveConnectionRegistry) ?? 'unode';
  const connections = settings.providers.flatMap((provider): SetupGuideConnection[] => {
    const id = provider.connectionId ?? connectionIdForProviderId(provider.providerId, effectiveConnectionRegistry);
    if (!id || provider.availability !== 'available') return [];
    if (provider.authKind === 'claude-cli' || provider.authKind === 'codex-cli') {
      const runtime = cliRuntimeStatus(id);
      const measured = runtime?.version ? `version ${runtime.version}, checked ${String(runtime.checkedAt ?? '').slice(0, 10)}` : 'version not checked yet';
      return [{
        id, name: provider.name, kind: provider.authKind, configured: !!runtime?.program, hasKey: false, canSetKey: false,
        status: runtime?.program ? `${runtime.program} (${measured})` : runtime?.problem ?? SETUP_GUIDE_CLI_STATUS_NONE,
        ...(runtime?.program ? { program: runtime.program } : {}),
      }];
    }
    const custom = id.startsWith('custom:');
    return [{
      id, name: provider.name, kind: custom ? 'custom-gateway' : 'api-key',
      configured: custom || provider.hasApiKey,
      hasKey: provider.hasApiKey,
      canSetKey: !custom && provider.canManageApiKey && !!provider.apiKeySecretName,
      status: provider.hasApiKey ? 'API key set' : 'No API key',
    }];
  });
  const inspected = vscode.workspace.getConfiguration('unode').inspect<string>('defaultProvider');
  const commandInspected = vscode.workspace.getConfiguration('unode').inspect<string>('commandApproval');
  const commandSetting = configuredSetting<CommandApprovalMode>('commandApproval', 'all');
  const projectEnabled = projectCommandApprovals.isExecutionEnabled();
  const mcpNames = new Map(mcpHub.listServers().map((server) => [server.id, server.name]));
  return {
    connections,
    defaultConnectionId,
    defaultExplicit: inspected?.globalValue !== undefined || inspected?.workspaceValue !== undefined,
    agents: sessionManager.getAll().map((session) => {
      const config = session.config;
      const policy = agentAutonomyPolicy(config);
      return {
        id: config.id,
        name: config.name,
        role: config.role,
        connection: connectionProfileForAgent(config, effectiveConnectionRegistry)?.presentation.displayName ?? config.provider.providerId,
        model: config.model,
        autonomy: policy.label,
        autonomyLimits: policy.limits,
        effectivePolicy: effectivePolicyForAgent(config),
        folders: (config.folderAccess ?? []).map((grant) => ({ path: grant.path, permission: grant.permission })),
        mcp: (config.mcpServers ?? []).map((id) => mcpNames.get(id) ?? id),
        skills: config.skills?.length ?? 0,
        playbooks: config.playbooks?.length ?? 0,
      };
    }),
    selectedAgentId: chatViewProvider?.getSelectedAgentId(),
    permissions: {
      commandSetting,
      commandExplicit: commandInspected?.globalValue !== undefined || commandInspected?.workspaceValue !== undefined,
      projectEnabled,
      commandEffective: effectiveCommandApprovalMode(commandSetting, projectEnabled),
      writeApproval: configuredSetting<string>('writeApproval', 'none'),
      autonomyDefault: autonomyDefaults?.effective(configuredSetting('autonomy', 'workspace')) ?? 'workspace',
      webAccess: configuredSetting<string>('webAccess', 'allow'),
      trusted: vscode.workspace.isTrusted,
    },
    mcpServers: mcpHub.listServers().map((server) => ({ id: server.id, name: server.name, ready: server.ready, toolCount: server.toolCount })),
  };
}

function setupGuideHost(): SetupGuideHost {
  return {
    snapshot: setupGuideSnapshot,
    readiness: connectionReadiness(),
    secretNameFor: (connectionId) => {
      const profile = connectionProfile(connectionId, effectiveConnectionRegistry);
      return profile && profile.authKind === 'api-key' && !profile.id.startsWith('custom:') ? profile.apiKeySecretName : undefined;
    },
    loginCommandFor: (cli) => {
      const setup = connectionProfile(cli, effectiveConnectionRegistry)?.presentation.setup;
      return setup?.kind === 'cli' && setup.loginCommand ? setup.loginCommand : cli === 'claude-cli' ? 'claude auth login' : 'codex login';
    },
    chooseModel: chooseModelForConnection,
    addGateway: addCustomGateway,
    testConnection,
    setDefault: setDefaultConnection,
    createTeam: async (preset, choice) => (await createTeamOnConnection(preset, choice)).map((member) => ({ name: member.name, role: member.role })),
    configureRoles: choice => chooseTeamConnections(dialogs.teamConnectionForm(TEAM_PRESETS.starter.roles,
      legacyProviderIdForConnectionId(choice.connectionId, effectiveConnectionRegistry) ?? resolveDefaultProvider(), effectiveConnectionRegistry, choice),
      'Use these choices', agentRosterEdits.capture(), chooseTeamRoleModel),
    run: async (command, ...args) => vscode.commands.executeCommand(command, ...args),
    log: (line) => outputChannel.info(line),
  };
}

function firstUseDeps(): FirstUseControllerDeps {
  return {
    state: rootWorkspaceState,
    listAgents: () => sessionManager.getAll().map((session) => ({ id: session.config.id, role: session.config.role })),
    defaultConnectionId: () => connectionIdForProviderId(resolveDefaultProvider(), effectiveConnectionRegistry) ?? 'unode',
    defaultExplicit: () => {
      const inspected = vscode.workspace.getConfiguration('unode').inspect<string>('defaultProvider');
      return inspected?.globalValue !== undefined || inspected?.workspaceValue !== undefined;
    },
    connectionLabel: (connectionId) => connectionProfile(connectionId, effectiveConnectionRegistry)?.presentation.displayName,
    readiness: (input) => connectionReadiness().check(input),
    chooseConnection: async (current) => {
      const marked = legacyProviderIdForConnectionId(current, effectiveConnectionRegistry) ?? current;
      const picked = await vscode.window.showQuickPick(dialogs.connectionChoiceItems(marked, effectiveConnectionRegistry), {
        title: 'UnodeAi — Connection for this task',
        placeHolder: 'Select connection and billing path. The default for new agents does not change.',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      return picked?.connectionId;
    },
    chooseModel: chooseModelForConnection,
    runRepair: (action) => connectionReadiness().runFirstUseRepair(action),
    createTeam: createFirstUseTeam,
    createSolo: createFirstUseSolo,
    admit: (agentId, text, requestId) => chatViewProvider.admitFirstUseTask(agentId, text, requestId),
    admitted: (agentId, requestId) => chatViewProvider.hasAdmittedRequest(agentId, requestId),
    selectAgent: (agentId) => chatViewProvider.selectAgent(agentId),
    insertIntoComposer: (agentId, text) => { chatViewProvider.insertIntoComposer(agentId, text); },
    openCustomTeam: async () => { await vscode.commands.executeCommand('unode.createTeamPreset'); },
    returningOffer: async () => {
      const choice = await currentReturningTeamChoice();
      return choice ? { label: choice.label, detail: choice.detail } : undefined;
    },
    loadReturningTeam: async () => {
      const choice = await currentReturningTeamChoice();
      if (!choice || !openSavedTeamForFirstUse) return;
      await openSavedTeamForFirstUse(choice.ref);
      teamViewProvider?.refresh();
    },
    openOtherSavedTeams: async () => { await vscode.commands.executeCommand('unode.openSavedTeam'); },
    handoverContainer: () => chatViewProvider.handoverContainer(),
    changed: () => chatViewProvider?.refresh(),
    newId: () => randomUUID(),
    now: () => new Date(),
    log: (line) => outputChannel.info(line),
  };
}

// ─── Dialogs ──────────────────────────────────────────────────────────

async function handleCredentialChanged(secretName: string, connectionId?: string): Promise<void> {
  // A replaced key makes both derived tables wrong at once. Drop the catalogue outright rather than
  // waiting out its TTL, and re-fetch prices scoped to the connection whose credential just changed.
  modelCatalog?.clearCache();
  const owner = effectiveConnectionRegistry.profiles.find((profile) => profile.apiKeySecretName === secretName);
  // v0.9.89: the old key's account price and any refresh in flight for it can no longer be used.
  spendHost?.credentialChanged([connectionId ?? owner?.id].filter((id): id is string => !!id));
  await refreshPrices({ scope: connectionId ?? owner?.id, trigger: 'credential change' });
  SettingsPanel.refreshCurrent();
  AgentBuilderPanel.refreshCurrent();
  SetupGuidePanel.refreshCurrent();
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
function teamSaveIconUri(): vscode.Uri | undefined {
  return extensionContext && vscode.Uri.joinPath(extensionContext.extensionUri, 'images', 'team-save.svg');
}

function dialogDeps(options: Pick<DialogDeps, 'suppressInteractivePostCreatePrompts' | 'skipExistingTeamWarning' | 'useDefaultConnection'> = {}): DialogDeps {
  return {
    captureRosterTarget: () => agentRosterEdits.capture(),
    teamSaveIcon: teamSaveIconUri(),
    sessionManager,
    messageBus,
    workflowEngine,
    secrets,
    modelCatalog: getModelCatalog(),
    pricing: getPricing(),
    output: outputChannel,
    commandPolicy, projectCommandApprovals, reloadCommandPolicy, refreshPrices, ensureModelPickerConsent,
    storeUserInitiatedProviderKey: (secretName, value, connectionId) => persistUserInitiatedProviderKey({
      secretName,
      value,
      connectionId,
      storeSecret: () => secrets.set(secretName, value),
    }),
    defaultBackendKind: (config) => defaultBackendKind(config, effectiveConnectionRegistry),
    defaultProvider: resolveDefaultProvider,
    connectionResolver: effectiveConnectionRegistry,
    currentConnectionResolver: () => effectiveConnectionRegistry,
    chooseTeamConnections: options.useDefaultConnection || options.suppressInteractivePostCreatePrompts ? undefined : (roles, providerKey) =>
      chooseTeamConnections(dialogs.teamConnectionForm(roles, providerKey, effectiveConnectionRegistry), 'Create team', agentRosterEdits.capture(), chooseTeamRoleModel),
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
  const bundled: RawCatalog = { agents: roleTemplateCatalogEntries(), mcp: await read('mcp'), skills: await read('skills') };
  const url = configuredSetting<string>('marketplace.catalogUrl', '').trim();
  const hosted = configuredSetting<boolean>('marketplace.fetchCatalog', false) && url
    ? { url, timeoutMs: 5000, verify: { publicKeyPem: CATALOG_PUBLIC_KEY_PEM } }
    : undefined;
  const resolved = await resolveCatalog({ bundled, hosted, warn: (m) => outputChannel.warn(`Marketplace: ${m}`) });
  cachedMarketplaceCatalog = { ...resolved, agents: roleTemplateCatalogEntries() };
  return cachedMarketplaceCatalog;
}

// ─── v0.9.90 Smart compaction settings ──────────────────────────────────────
/** This team's edits to the Smart work-profile table, from .unode/team.json. Replaced after every table save. */
let teamCompactionOverrides: SmartCompactionProfileOverrides | undefined;

/** One agent's compaction policy, from the bundled data and this team's table, for the model that will serve it. */
function resolveAgentSmartCompaction(config: AgentConfig): SmartCompactionResolution {
  const window = resolveContextWindow(config);
  return resolveSmartCompactionPolicy({
    policy: bundledSmartCompactionPolicy(),
    agent: config,
    teamOverrides: teamCompactionOverrides,
    contextWindow: { tokens: window.tokens, source: window.source },
    route: config.route ? { connectionId: config.route.connectionId, modelId: config.route.modelId } : undefined,
  });
}

function describeAgentSmartCompaction(config: AgentConfig): SmartCompactionPreview {
  const policy = bundledSmartCompactionPolicy();
  const window = resolveContextWindow(config);
  const backend = config.backend ?? defaultBackendKind(config, effectiveConnectionRegistry);
  let auto: SmartCompactionPreviewContext['auto'];
  if (policy.smart.ok) {
    // What Auto would choose, even when the agent has picked a profile explicitly.
    const resolved = resolveWorkProfile({ ...config, smartCompactionProfile: undefined }, policy.smart.value);
    const sourceName = resolved.source === 'role-template' && config.roleTemplateKey
      ? ROLE_TEMPLATES[config.roleTemplateKey]?.name
      : resolved.source === 'skill-category' ? primarySkill(config.skills)?.name : undefined;
    auto = { ...resolved, ...(sourceName ? { sourceName } : {}) };
  }
  const resolution = resolveAgentSmartCompaction(config);
  const native = backend === 'claude' && resolution.status === 'resolved'
    ? claudeCompactionEnvironment(resolution.policy)
    : undefined;
  return describeSmartCompaction(resolution, {
    ...(native?.nativeThresholdTokens !== undefined
      ? { nativeThreshold: { tokens: native.nativeThresholdTokens, ...(native.clamped ? { clamped: native.clamped } : {}) } }
      : {}),
    contextWindow: { tokens: window.tokens, source: window.source },
    mechanism: backend === 'claude'
      ? { kind: 'native-runtime', runtimeName: 'Claude' }
      : backend === 'codex' ? { kind: 'native-runtime', runtimeName: 'Codex' } : { kind: 'host-history' },
    ...(backend === 'codex' ? { runtimeOwnThreshold: true } : {}),
    auto,
  });
}

function smartCompactionBuilderView(agent: AgentConfig | undefined): AgentBuilderSmartCompactionView {
  const policy = bundledSmartCompactionPolicy();
  // A new agent's preview is replaced by the webview's first request, which carries the chosen role and model.
  const subject = agent ?? ({ id: '', name: '', model: '', skills: [], backend: 'openai-compat' } as unknown as AgentConfig);
  return {
    mode: isSmartCompactionMode(agent?.smartCompactionMode) ? agent.smartCompactionMode : 'smart',
    profile: isCompactionWorkProfile(agent?.smartCompactionProfile) ? agent.smartCompactionProfile : '',
    windowPercent: agent?.smartCompactionWindowPercent,
    ceilingTokens: agent?.smartCompactionCeilingTokens,
    ...(policy.custom.ok
      ? { customDefaults: { windowPercent: policy.custom.value.windowPercent, ceilingTokens: policy.custom.value.ceilingTokens } }
      : { customUnavailable: policy.custom.error }),
    profiles: COMPACTION_WORK_PROFILES.map((id) => ({ id, label: profileLabel(id), typicalWork: profileTypicalWork(id) })),
    preview: describeAgentSmartCompaction(subject),
  };
}

/** The preview for unsaved builder values, resolved exactly as a save of those values would be. */
function previewBuilderSmartCompaction(form: AgentBuilderSmartCompactionForm, agentId?: string): SmartCompactionPreview {
  const existing = agentId ? sessionManager.get(agentId)?.config : undefined;
  const connectionId = connectionIdForProviderId(form.providerId, effectiveConnectionRegistry);
  const profile = connectionId ? connectionProfile(connectionId, effectiveConnectionRegistry) : undefined;
  let route: AgentConfig['route'];
  try {
    route = connectionId && form.model ? routeForConnectionId(connectionId, form.model, effectiveConnectionRegistry) : undefined;
  } catch {
    route = undefined;
  }
  const measured = connectionId && form.model ? discoveredContextWindow(connectionId, form.model) : undefined;
  const hypothetical = {
    id: existing?.id ?? '',
    name: existing?.name ?? '',
    model: form.model,
    route,
    backend: profile?.backendKind,
    roleTemplateKey: ROLE_TEMPLATES[form.roleKey] ? form.roleKey : undefined,
    skills: form.skillIds.map((id) => SKILL_LIBRARY[id]).filter(Boolean),
    contextWindowTokens: form.contextWindowTokens,
    measuredContextWindow: measured ?? existing?.measuredContextWindow,
    observedContextWindow: existing?.observedContextWindow,
  } as AgentConfig;
  applySmartCompactionChoice(hypothetical, form);
  return describeAgentSmartCompaction(hypothetical);
}

function openCompactionProfileTable(): void {
  CompactionProfileTablePanel.createOrShow({
    getViewModel: () => compactionProfileTableViewModel(),
    save: (overrides) => saveCompactionProfileTable(overrides),
  });
}

async function compactionProfileTableViewModel(): Promise<CompactionProfileTableViewModel> {
  const policy = bundledSmartCompactionPolicy();
  const teamFileExists = await persistence.teamFileExists();
  if (!policy.smart.ok) return { unavailableReason: policy.smart.error, teamFileExists };
  const data = policy.smart.value;
  const agentsByRow = new Map<string, string[]>();
  for (const { config } of sessionManager.getAll()) {
    // Only Smart agents read the table; an absent or unrecognized mode is Smart.
    if (isSmartCompactionMode(config.smartCompactionMode) && config.smartCompactionMode !== 'smart') continue;
    const { profile } = resolveWorkProfile(config, data);
    agentsByRow.set(profile, [...(agentsByRow.get(profile) ?? []), config.name]);
  }
  return {
    teamFileExists,
    rows: COMPACTION_WORK_PROFILES.map((id) => ({
      id,
      label: profileLabel(id),
      typicalWork: profileTypicalWork(id),
      defaults: data.profiles[id],
      overrides: teamCompactionOverrides?.[id] ?? {},
      agents: agentsByRow.get(id) ?? [],
    })),
  };
}

async function saveCompactionProfileTable(
  candidate: SmartCompactionProfileOverrides,
): Promise<{ ok: boolean; message: string }> {
  const policy = bundledSmartCompactionPolicy();
  if (!policy.smart.ok) return { ok: false, message: `The Smart profile table is unavailable: ${policy.smart.error}.` };
  if (!firstWorkspaceRoot()) return { ok: false, message: 'Open a workspace folder before editing the team profile table.' };
  const problems = profileOverrideProblems(candidate, policy.smart.value.profiles);
  if (problems.length > 0) return { ok: false, message: `Nothing was saved. ${problems.join(' ')}` };
  const overrides = withoutDefaultCells(candidate, policy.smart.value.profiles);
  try {
    await persistence.saveSmartCompactionProfiles(overrides);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  teamCompactionOverrides = overrides;
  AgentBuilderPanel.refreshSmartCompactionPreview();
  return { ok: true, message: 'Saved the team work-profile table in .unode/team.json. Smart agents use it from their next turn.' };
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
    configuredSetting<Partial<Record<ModelTier, Record<string, string>>>>('modelTiers', {})
  );
  // The provider the user actually chose in Setup / "Set as default" — NOT a hardcoded one. This was the
  // exact bug `resolveDefaultProvider`'s doc-comment warns about ("MUST be the single read site"): the Agent
  // Builder was the read site that got missed, so it pinned every role to 'roam' regardless. A user who set
  // up on Unode or Claude Headless got a Roam agent the moment they picked a role.
  const defaultProviderId = resolveDefaultProvider();
  const defaultConnectionId = connectionIdForProviderId(defaultProviderId, effectiveConnectionRegistry) ?? 'unode';
  const defaultProfile = connectionProfile(defaultConnectionId, effectiveConnectionRegistry);
  const defaultCatalogModels = staticCatalogModels(defaultConnectionId);
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
    commandToolDefaults: { deniedTools: template.deniedTools ?? [] },
    providerId: defaultProviderId,
    // Fall back through the default provider's own catalog before the built-in Roam model, so a role on a
    // provider that has no mapping still opens on a model that provider can actually serve.
    model: (defaultProfile?.id.startsWith('custom:') ? undefined : modelForRole(template, defaultProviderId))
      ?? modelForTier('standard', defaultProviderId, tiers)
      ?? (defaultConnectionId === 'codex-cli'
        ? cachedCodexAccountModels().find((candidate) => candidate.isDefault)?.id
        : undefined)
      ?? defaultCatalogModels[0]?.id
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
      models: staticCatalogModels(profile.id).map((model) => agentBuilderModelOption(model)),
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
      playbooksAvailable: c.playbooks,
      folderAccessAvailable: c.folderAccess,
      toolProtocolAvailable: c.toolProtocol,
      smartModeAvailable: c.smartMode,
      mcpAvailable: c.mcp,
      coordinatorAvailable: c.coordinator,
      capabilitySummary: `Plan ${c.plan ? 'available' : 'unavailable'}; Act ${c.act ? 'available' : 'unavailable'}; commands ${c.command ? c.commandApproval : 'unavailable'}.`,
      modelLoadAction: profile.catalogKind === 'codex-cli' ? 'codex-cli' as const : undefined,
    }];
  });
  const capabilities = Object.values(SKILL_LIBRARY).map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    category: skill.category,
    requiredTools: skillResolver.allowedToolsForIds([skill.id]),
  }));
  const pausedServers = new Set(agent ? persistence.integrationGrantRepairs()
    .filter(repair => repair.agentIds.includes(agent.id)).map(repair => repair.serverId) : []);
  const mcpServers = [...mcpRegistry.values()].map((cfg) => ({
    id: cfg.id,
    name: cfg.name,
    transport: cfg.transport,
    connected: !!mcpHub.listServers().find((s) => s.id === cfg.id),
    requiresApproval: shouldRequireApproval(cfg),
    paused: pausedServers.has(cfg.id),
  }));
  const unavailableMediaModels: Array<'imageGeneration' | 'transcription'> = [];
  if (agent?.mediaModels) {
    for (const feature of ['imageGeneration', 'transcription'] as const) {
      const choice = agent.mediaModels[feature];
      if (typeof choice !== 'object') continue;
      const profile = mediaConnectionProfile(choice.connectionId);
      if (!profile?.apiKeySecretName || !await secrets.get(profile.apiKeySecretName)
        || (feature === 'imageGeneration' && !imageGeneration?.availableFor(agent.id))
        || (feature === 'transcription' && !transcriptionHost?.availableFor(agent.id))) unavailableMediaModels.push(feature);
    }
  }
  return {
    mode: agent ? 'edit' : 'new',
    mediaModelsAvailable: true,
    publicSearchAvailable: true,
    unavailableMediaModels,
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
      mcpServers: persistence.restrictUnconfirmedGrants(agent).mcpServers ?? [],
      mediaModels: agent.mediaModels,
      publicSearch: agent.publicSearch,
      // v0.9.102: only a tool list the save carries through (builderCarriesInstanceTools) is compared against.
      ...(builderCarriesInstanceTools(agent) ? { savedTools: [...agent.allowedTools!] } : {}),
      executePreference: agent.executePreference,
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
    smartCompaction: smartCompactionBuilderView(agent),
    roles,
    providers,
    capabilities,
    mcpServers,
    catalog,
    globalCommandPolicy: commandNarrowingCeiling(commandPolicy),
    skillLibraryUrl: configuredSetting<string>(
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
      'Keep current instructions',
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

/**
 * v0.9.110: what the reply suggestion service may know of a connection: whether it has a text API one plain request can
 * be sent to, its endpoint as the registry pins it, its revision and its key's name. Never a key value.
 */
function suggestionConnection(connectionId: string): SuggestionConnection | undefined {
  const profile = connectionProfile(connectionId, effectiveConnectionRegistry);
  if (!profile) return undefined;
  const textApi = profile.availability === 'available' && profile.kind === 'openai-compatible'
    && profile.backendKind === 'openai-compat' && profile.authKind === 'api-key';
  let endpointBase: string | undefined;
  if (textApi) {
    try {
      endpointBase = resolveOpenAICompatBaseUrl({ routeVersion: 1, kind: 'openai-compatible', connectionId: profile.id, modelId: 'reply-suggestion' }, effectiveConnectionRegistry);
    } catch {
      endpointBase = undefined;
    }
  }
  return {
    connectionId: profile.id,
    revision: profile.revision,
    displayName: profile.presentation.displayName,
    textApi,
    ...(endpointBase ? { endpointBase } : {}),
    ...(profile.apiKeySecretName ? { apiKeySecretName: profile.apiKeySecretName } : {}),
  };
}

/**
 * The network call of the host's one-request text transport (a conversation summary, a reply suggestion), reached only
 * after that request's consent and last check. One POST; it never retries.
 */
function oneTextRequestFetch(url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal }) {
  return (globalThis as any).fetch(url, init) as Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

/** v0.9.110: Settings, Providers, Choose model: an API connection, then its exact model ID. Writes User Settings only. */
async function chooseReplySuggestionModel(): Promise<void> {
  const connections = effectiveConnectionRegistry.profiles
    .filter((profile) => profile.availability === 'available')
    .map((profile) => {
      const connection = suggestionConnection(profile.id);
      const usable = !!connection?.textApi && !!connection.endpointBase;
      return {
        label: profile.presentation.displayName,
        description: !usable ? CANNOT_PROVIDE_SUGGESTIONS : connection?.apiKeySecretName ? undefined : 'API key required',
        connectionId: profile.id,
        usable,
      };
    });
  const picked = await vscode.window.showQuickPick(connections, {
    title: 'UnodeAI Reply Suggestion Model: connection',
    placeHolder: 'The API connection that suggests one reply after an answer (billed to it)',
  });
  if (!picked) return;
  if (!picked.usable) {
    void showResultNotice('information', `${CANNOT_PROVIDE_SUGGESTIONS}. Choose an API connection.`);
    return;
  }
  const catalog = connectionProfile(picked.connectionId, effectiveConnectionRegistry)?.catalogModels ?? [];
  const enterExact = '$(edit) Enter an exact model ID…';
  let modelId: string | undefined;
  if (catalog.length > 0) {
    const chosen = await vscode.window.showQuickPick(
      [...catalog.map((model) => ({ label: model.id, description: model.name !== model.id ? model.name : undefined })), { label: enterExact, description: undefined }],
      { title: 'UnodeAI Reply Suggestion Model: model' },
    );
    if (!chosen) return;
    modelId = chosen.label === enterExact ? undefined : chosen.label;
  }
  if (!modelId) {
    // Any exact ID the connection offers is accepted, not only the ones the offline catalog lists.
    modelId = (await vscode.window.showInputBox({
      title: 'UnodeAI Reply Suggestion Model: exact model ID',
      prompt: `The exact model ID on ${picked.label}`,
      validateInput: (value) => (value.trim() ? undefined : 'Enter a model ID.'),
    }))?.trim();
  }
  if (!modelId) return;
  await updateUserAuthoritySetting('replySuggestions.model', { connectionId: picked.connectionId, modelId });
}

function mediaConnectionProfile(id: string) {
  const profile = connectionProfile(id, effectiveConnectionRegistry);
  return profile?.availability === 'available' && profile.authKind === 'api-key'
    && profile.backendKind === 'openai-compat' && profile.apiKeySecretName ? profile : undefined;
}

let mediaModelCatalog: ModelCatalog | undefined;

async function pickMemberMediaModel(capability: MediaCapability, isCurrent: () => boolean): Promise<MediaModel | undefined> {
  const forImage = capability === 'image-generation';
  const title = forImage ? 'Image generation model' : 'Audio transcription model';
  const candidates = await Promise.all(effectiveConnectionRegistry.profiles.flatMap(({ id }) => {
    const profile = mediaConnectionProfile(id);
    const supported = forImage ? !!imageConnections?.modelForConnection(id) : id === 'unode';
    return profile && supported ? [(async () => await secrets.get(profile.apiKeySecretName!)
      ? { label: profile.presentation.displayName, id } : undefined)()] : [];
  }));
  if (!isCurrent()) return undefined;
  const connections = candidates.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (!connections.length) {
    const open = 'Open Providers';
    const choice = await vscode.window.showInformationMessage('Configure an API-key connection before choosing a media model.', open);
    if (choice === open && isCurrent()) await vscode.commands.executeCommand('unode.openSettings', 'providers');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(connections, { title, placeHolder: 'Choose a configured API connection' });
  if (!picked || !isCurrent()) return undefined;
  const profile = mediaConnectionProfile(picked.id);
  const base = profile && resolveModelCatalogBaseUrl(profile.id, effectiveConnectionRegistry);
  if (!profile || !base) return undefined;
  const current = () => isCurrent() && mediaConnectionProfile(profile.id)?.revision === profile.revision;
  await ensureModelPickerConsent(profile.id, base, current);
  const apiKey = await secrets.get(profile.apiKeySecretName!);
  if (!apiKey || !current() || !hasMetadataConsent(hostOf(base))) return undefined;
  mediaModelCatalog ??= new ModelCatalog(() => [], metadataFetch, {
    canReadMetadata: url => hasMetadataConsent(hostOf(url)), requireEndpoint: true,
  });
  let rows: ModelInfo[];
  try {
    rows = await mediaModelCatalog.list(`media:${profile.id}:${profile.revision}`, base, apiKey);
  } catch {
    if (current()) void showResultNotice('information',
      `${profile.presentation.displayName} could not list available media models. Check the connection in Settings → Providers or choose another connection.`);
    return undefined;
  }
  const currentKey = await secrets.get(profile.apiKeySecretName!);
  if (!current() || !hasMetadataConsent(hostOf(base)) || currentKey !== apiKey) return undefined;
  const verifiedImageModel = forImage ? imageConnections?.modelForConnection(profile.id) : undefined;
  const models = rows.filter(row => row.source === 'endpoint'
    && (!row.supportedEndpointTypes || row.supportedEndpointTypes.includes(capability))
    && (forImage ? row.id === verifiedImageModel : verifiedUnodeTranscriptionModel({ connectionId: profile.id, modelId: row.id })))
    .map(row => ({ label: row.name ?? row.id, description: row.id, modelId: row.id }));
  if (!models.length) {
    void showResultNotice('information', forImage
      ? 'This connection did not list a verified image model. Choose another connection or keep the current selection.'
      : 'Unode did not list a supported transcription model. Check the Unode connection in Settings > Providers.');
    return undefined;
  }
  const selected = await vscode.window.showQuickPick(models, { title, placeHolder: 'Choose the media model' });
  if (!selected || !current()) return undefined;
  const selectedKey = await secrets.get(profile.apiKeySecretName!);
  if (!current() || selectedKey !== apiKey || !hasMetadataConsent(hostOf(base))) return undefined;
  return { connectionId: profile.id, modelId: selected.modelId };
}

async function agentBuilderListModels(
  providerId: string,
  _baseUrl?: string,
  trigger: Extract<PriceRefreshTrigger, 'Agent Builder model picker' | 'Settings Smart picker'> = 'Agent Builder model picker',
  discovery?: { allowRemote: boolean; isCurrent(): boolean },
): Promise<AgentBuilderModelOption[]> {
  // Webviews are untrusted. A disabled Coming soon option is only presentation; do not let a forged
  // list-models message reach metadata consent, pricing, or a catalog request for that connection.
  const connectionId = connectionIdForProviderId(providerId, effectiveConnectionRegistry);
  const profile = connectionId ? connectionProfile(connectionId, effectiveConnectionRegistry) : undefined;
  if (!connectionId || !profile || profile.availability !== 'available') {
    return [];
  }
  // Codex account models come only from its already-consented App Server session. The picker itself must
  // neither spawn the CLI nor substitute an unrelated HTTP /models request.
  if (profile.catalogKind === 'codex-cli') {
    return staticCatalogModels(connectionId).map((model) => agentBuilderModelOption(model));
  }
  if (profile.catalogKind === 'claude-cli' && discovery) {
    return (await getModelCatalog().list(connectionId, undefined, undefined, { cachedOnly: true }))
      .map(model => agentBuilderModelOption(model, modelPriceLabel(model.id, connectionId)));
  }
  // Don't let a slow /api/pricing (or an extra pricing source) hang the model dropdown: wait briefly
  // for live (discounted) prices, but fall through after 1.5s and return models with whatever prices are
  // already cached. refreshPrices keeps running and the cache is warm for the next provider switch.
  // The consent question is asked OUTSIDE the race — a modal the user is still reading must not be
  // "timed out" by a 1.5s budget meant for a slow HTTP call. And it asks about EVERY host this function is
  // about to contact, not just the pricing ones: the model endpoint below is a network call too.
  const resolvedBase = resolveModelCatalogBaseUrl(connectionId, effectiveConnectionRegistry);
  const cached = async () => {
    const key = profile.apiKeySecretName ? await secrets.get(profile.apiKeySecretName) : undefined;
    return (await getModelCatalog().list(connectionId, resolvedBase, key, { cachedOnly: true }))
      .map(model => agentBuilderModelOption(model, modelPriceLabel(model.id, connectionId)));
  };
  if (discovery && (!discovery.allowRemote || !discovery.isCurrent())) return cached();
  await ensureModelPickerConsent(connectionId, resolvedBase, discovery?.isCurrent);
  if (discovery && !discovery.isCurrent()) return cached();
  // Scoped for the same reason as the prompt above it: this dropdown is about ONE provider, so approved-but-
  // unrelated gateways are not contacted either.
  await Promise.race([
    refreshPrices({ scope: connectionId, trigger }),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
  const apiKey = profile.apiKeySecretName ? await secrets.get(profile.apiKeySecretName) : undefined;
  if (discovery && !discovery.isCurrent()) return cached();
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
  return models.map((model) => agentBuilderModelOption(model, modelPriceLabel(model.id, connectionId)));
}

async function loadCodexModelsForPicker(
  providerId: string,
): Promise<{ models: AgentBuilderModelOption[]; message: string }> {
  const connectionId = connectionIdForProviderId(providerId, effectiveConnectionRegistry);
  const profile = connectionId ? connectionProfile(connectionId, effectiveConnectionRegistry) : undefined;
  if (profile?.availability !== 'available' || profile.catalogKind !== 'codex-cli') {
    throw new Error('This connection cannot load models from Codex.');
  }
  // v0.9.97: with managed Codex set up and selected, the list comes from the managed version new sessions use, started
  // through its admission like any managed start.
  const runtime = cliRuntimeHost();
  if (runtime.managed && managedChoice(runtime.managed.store.status()).kind === 'managed') {
    if (!extensionContext) throw new Error('UnodeAi extension storage is unavailable.');
    const storage = extensionContext.globalStorageUri.fsPath;
    // The version's lease is given up only after the list's process tree was seen to stop.
    const { value: models, started } = await runTransientCliUse((spawn) => runtime.resolver.startTransient({
      provider: 'codex-cli',
      beforeStart: (executable) => codexEgressGate(undefined, 'Agent Builder model loader', executable),
    }, spawn), (program) => loadCodexAccountModels({
      assertCurrent: () => { if (hostShutdown.started || workspaceBinding.isStale()) throw new CodexSelectionChangedError(); },
      binaryPath: program.executable,
      neutralWorkingDirectory: path.join(storage, 'codex-model-discovery'),
      workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      env: process.env,
      clientVersion: unodeVersion || 'dev',
      spawn: ((command: string, args: readonly string[], options: SpawnOptions) => {
        const child = cpSpawn(command, args, options);
        program.spawned(child);
        return child;
      }) as typeof cpSpawn,
      onStopped: program.stopped,
    }), (line) => outputChannel.warn(line));
    if (models.length > 0 && started.version) await rememberCodexAccountModels(models, started.executable, started.version);
    return {
      models: await agentBuilderListModels(providerId),
      message: models.length > 0 ? `${models.length} model${models.length === 1 ? '' : 's'} loaded from managed Codex ${started.version ?? ''}.` : 'Managed Codex returned no account models. Nothing was saved.',
    };
  }
  // The version and login are checked before network consent: a failed local check creates neither a consent grant
  // nor an App Server process. The selection is confirmed again before each later step (see refreshCodexModels).
  return refreshCodexModels({
    select: () => configuredOrChosenCodexExecutable(),
    stillSelected: (selection) => codexSelectionCurrent(selection),
    consent: (program) => codexEgressGate(undefined, 'Agent Builder model loader', program),
    discover: (program, assertCurrent) => {
      if (!extensionContext) throw new Error('UnodeAi extension storage is unavailable.');
      return loadCodexAccountModels({
        // Checked again right before App Server is spawned, after the loader's own folder preparation.
        assertCurrent,
        binaryPath: program,
        neutralWorkingDirectory: path.join(extensionContext.globalStorageUri.fsPath, 'codex-model-discovery'),
        workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
        env: process.env,
        clientVersion: unodeVersion || 'dev',
      });
    },
    remember: (models, selection) => rememberCodexAccountModels(models, selection.program, selection.version),
    list: () => agentBuilderListModels(providerId),
  });
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
  return `$${p.input}/$${p.output} per 1M · ${priceProviderLabel(providerId)} (${resolved.sourceLabel ?? resolved.source})`;
}

/** Settings → Spend view model: validated targets and statuses only. No key, login or fingerprint. */
function spendSettingsView() {
  const parsed = parseUserTargets(configuredSetting<unknown>('spend.targets', { schemaVersion: 1 }));
  const settings = userTargetsToSettings(parsed);
  const modeSetting = configuredSetting<unknown>('spend.referencePriceMode', 'unselected');
  const catalogs = spendHost?.references.catalogs() ?? {};
  const repositoryState = spendHost?.repositoryState() ?? { state: 'none' as const };
  const decision = spendHost?.coordinator.repositoryDecision();
  const repository = repositoryState.state === 'invalid'
    ? { state: 'invalid' as const, detail: repositoryState.reason }
    : repositoryState.state === 'valid'
      ? decision?.mode === 'ignore-project'
        ? { state: 'ignored' as const }
        : decision?.mode === 'accepted-digest' && decision.contentDigest === repositoryState.budget.contentDigest
          ? { state: 'accepted' as const }
          : { state: 'proposed' as const }
      : decision?.mode === 'ignore-project' ? { state: 'ignored' as const } : { state: 'none' as const };
  const priceSources: string[] = [];
  for (const connectionId of ['unode', 'roam']) {
    const snapshot = spendHost?.accountPrices.snapshot(connectionId);
    if (!snapshot) continue;
    const name = connectionId === 'unode' ? 'Unode' : 'Roam';
    priceSources.push(`${name}: account price list loaded ${snapshot.capturedAt.slice(0, 16).replace('T', ' ')} UTC${snapshot.fresh ? '' : ' (stale; display only until refreshed)'}.`);
  }
  return {
    targets: {
      ...(settings.request ? { request: settings.request } : {}),
      ...(settings.project ? { project: settings.project } : {}),
      agents: settings.agents ?? {},
    },
    diagnostics: parsed.diagnostics,
    referenceMode: isStoredReferencePriceMode(modeSetting) ? modeSetting : 'unselected' as const,
    catalogs: (['unode', 'roam'] as const)
      .map((provider) => catalogs[provider])
      .filter((catalog): catalog is NonNullable<typeof catalog> => !!catalog)
      .map((catalog) => ({ provider: catalog.provider, capturedAt: catalog.capturedAt, stale: catalogIsStale(catalog, Date.now()), models: catalog.models.length })),
    repository,
    suggestedTimeZone: currentTimeZone(),
    agents: sessionManager.getAll().map((session) => ({ id: session.config.id, name: session.config.name })),
    priceSources,
    dollarCoverage: (spendHost?.coordinator.dollarCoverage(sessionManager.getAll().map((session) => ({
      agentId: session.config.id,
      modelId: session.config.model,
    }))) ?? []).map((row) => ({
      agentName: sessionManager.get(row.agentId)?.config.name ?? row.agentId,
      connectionName: row.connectionName,
      detail: row.detail,
    })),
  };
}

/** The exact connection route of an agent's turn, for spend pricing. Never inferred from model output. */
function spendRouteFor(agentId: string, _modelId: string): SpendRoute | undefined {
  const config = sessionManager?.get(agentId)?.config;
  if (!config) return undefined;
  const profile = connectionProfileForAgent(config, effectiveConnectionRegistry);
  if (!profile) return undefined;
  return {
    connectionId: profile.id,
    connectionName: profile.presentation.displayName,
    route: profile.billingKind === 'cli-account' ? 'subscription' : 'gateway',
  };
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
    void showResultNotice('warning', 'Use a small icon under 64 KB');
    return undefined;
  }

  const mime = mimeForAgentIcon(uri.fsPath);
  if (!mime) {
    void showResultNotice('warning', 'Choose a PNG, JPEG, WebP, or SVG icon.');
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
  return isPathStrictlyInside(root, uri.fsPath) ? rel : uri.fsPath;
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
  extensionUri: vscode.Uri,
  isCurrent: () => boolean = () => true,
  commandPreference?: SavedCommandPreference,
  sourceCurrent?: () => Promise<boolean>,
): Promise<MemberAddResult> {
  const saveTarget = agentRosterEdits.capture();
  const connectionId = connectionIdForProviderId(payload.providerId, effectiveConnectionRegistry);
  const profileForSave = connectionId ? connectionProfile(connectionId, effectiveConnectionRegistry) : undefined;
  const provider = connectionId ? providerRefForConnectionId(connectionId, effectiveConnectionRegistry) : undefined;
  if (!connectionId || !profileForSave || !provider || profileForSave.availability !== 'available') {
    return { ok: false, message: 'Unknown provider.' };
  }
  // A connection that does not load a selected grant cannot hold it. Claude CLI and Codex CLI both retain
  // instruction Playbooks; their adapters mount the same validated registry through their respective native
  // Skill mechanisms. Keep capability Skills and MCP grants separate because route support can differ. The
  // builder keeps unsupported existing selections greyed out, so drop them before deriving the tool ceiling,
  // playbook prompt and capability checks, then report the adaptation explicitly.
  const adapted = dropUnsupportedGrants(payload, profileForSave.capabilities);
  payload = adapted.selection;
  const droppedSkillGrants = adapted.droppedSkills;
  const droppedPlaybookGrants = adapted.droppedPlaybooks;
  const droppedMcpGrants = adapted.droppedMcp;
  const droppedGrantsNotice = [
    droppedSkillGrants ? `${profileForSave.presentation.displayName} does not load UnodeAi capability Skills, so they were removed from this agent.` : '',
    droppedPlaybookGrants ? `${profileForSave.presentation.displayName} does not load UnodeAi Playbooks, so they were removed from this agent.` : '',
    droppedMcpGrants ? `${profileForSave.presentation.displayName} does not load UnodeAi MCP grants, so they were removed from this agent.` : '',
  ].filter(Boolean).map((line) => ` ${line}`).join('');
  const template = payload.roleKey !== 'custom' && Object.hasOwn(ROLE_TEMPLATES, payload.roleKey)
    ? ROLE_TEMPLATES[payload.roleKey] : undefined;
  if (payload.roleKey !== 'custom' && !template) {
    return { ok: false, message: 'Unknown role template.' };
  }
  if (!payload.permissionRestoreOnly && payload.executePreference !== undefined
    && (!template || !isExecutePreference(payload.executePreference))) {
    return { ok: false, message: 'Run commands requires a known role and a valid command choice. No changes were saved.' };
  }
  const catalog = await loadMarketplaceCatalog(extensionUri);
  if (!isCurrent() || !saveTarget()) return { ok: false, message: 'The agent or team changed. No changes were saved.' };
  const roleName = payload.roleKey === 'custom' ? payload.customRole! : template!.role;
  const role = roleName as AgentConfig['role'];
  const skills = payload.skillIds.map((id) => SKILL_LIBRARY[id]).filter(Boolean);
  const systemPrompt = applyPlaybooks(payload.systemPrompt, payload.playbooks, catalog.skills);
  const existing = payload.id ? sessionManager.get(payload.id) : undefined;
  if (payload.id && !existing) return { ok: false, message: 'Agent no longer exists. No changes were saved.' };
  const baseline = payload.mcpGrantBaseline;
  if (payload.mcpServers.some(id => removingIntegrations.has(id))) {
    return { ok: false, message: 'An integration is being removed. Refresh Agent Builder before saving its assignment.' };
  }
  let pausedBuilderGrants: string[] = [];
  if (existing && baseline) {
    const direct = persistence.restrictUnconfirmedGrants(existing.config).mcpServers ?? [];
    if (direct.length !== baseline.length || direct.some(id => !baseline.includes(id))) {
      return { ok: false, message: 'Direct integration grants changed while this form was open. Reopen Agent Builder to see the current grants.' };
    }
    pausedBuilderGrants = (existing.config.mcpServers ?? []).filter(id => !direct.includes(id));
    if (payload.mcpServers.some(id => pausedBuilderGrants.includes(id))) {
      return { ok: false, message: 'This direct grant is paused. Use Grant to… on its Marketplace card to review the assignment.' };
    }
  }
  const rosterUnchanged = agentRosterEdits.capture();
  const rosterCurrent = () => !hostShutdown.started && isCurrent() && rosterUnchanged();
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
  // Capture the old values before constructing the detached candidate.
  const priorBackendKind = existing
    ? existing.config.backend ?? defaultBackendKind(existing.config, effectiveConnectionRegistry)
    : undefined;
  const priorSkills = existing?.config.skills ?? [];
  const priorTools = existing?.config.allowedTools ?? [];
  const priorFork = existing?.config.systemPromptTemplateAtFork;
  const priorDismissed = existing?.config.systemPromptDismissedTemplateHash;
  const priorMeasuredContextWindow = existing?.config.measuredContextWindow;
  const resolvedTools = skillResolver.resolveAllowedTools(skills);
  const legacyNoSkillMeta = priorSkills.length === 0 && priorTools.length > 0;
  const requestedToolsBeforeCeiling = (skills.length === 0 && legacyNoSkillMeta) ? priorTools : resolvedTools;
  const allowedToolCeiling = payload.allowedToolCeiling ? new Set(payload.allowedToolCeiling) : undefined;
  const restoredTools = allowedToolCeiling
    ? requestedToolsBeforeCeiling.filter((tool) => allowedToolCeiling.has(tool))
    : requestedToolsBeforeCeiling;
  // A saved-team confirmation/review is deliberately not an Agent Builder edit. Older Claude CLI configs
  // may retain a legacy `temperature` setting that a current Claude route rejects. Passing the loaded
  // config through ordinary edit validation made one failed agent roll an entire restored team back to
  // read-only. This branch runs before model/capability validation and leaves every non-permission field
  // on the existing config untouched.
  if (payload.permissionRestoreOnly) {
    if (!existing) {
      return { ok: false, message: 'The loaded agent is no longer available to restore.' };
    }
    if (commandPreference?.preference === 'deny' && profileForSave.backendKind === 'codex') {
      return { ok: false, message: 'This Codex connection cannot enforce saved Run commands Off. No permissions were restored.' };
    }
    const config = structuredClone(existing.config);
    applySavedPermissionRestore(config, {
      skillIds: payload.skillIds,
      skills,
      allowedTools: restoredTools,
      playbooks: payload.playbooks,
      backendKind: profileForSave.backendKind,
      commandPreference,
    });
    if (profileForSave.backendKind === 'codex' && allowedToolCeiling) {
      config.toolCeiling = 'bounded';
      // v0.9.102 R3 F1: the load already chose this profile from its source (restoreTeamDocument: the saved one only for
      // the global library or a recognised project save, otherwise Approve for me). Restoring tools does not reset it.
      config.codexPermissionProfile ??= 'approve-for-me';
    }
    const committed = await agentRosterEdits.commit(config, existing.config, rosterCurrent, () => { existing.config = config; }, sourceCurrent);
    if (!committed) return { ok: false, message: 'The loaded team changed. No permissions were restored.' };
    scheduleTeamRulesOnRosterChange();
    if (shouldRestartAfterAgentConfigEdit(existing.status)) {
      await sessionManager.restart(existing.id);
    }
    teamViewProvider?.refresh();
    chatViewProvider?.refresh();
    MarketplacePanel.refreshCurrent();
    return { ok: true, message: `Restored saved permissions for ${config.name}.${droppedGrantsNotice}` };
  }
  const requestedMedia = payload.mediaModels === undefined ? undefined : parseAgentMediaModels(payload.mediaModels);
  if (payload.mediaModels !== undefined && !requestedMedia) {
    return { ok: false, message: 'Choose a valid media connection and model before saving.' };
  }
  for (const feature of ['imageGeneration', 'transcription'] as const) {
    const selected = requestedMedia?.[feature];
    if (typeof selected !== 'object') continue;
    const prior = existing?.config.mediaModels?.[feature];
    if (typeof prior === 'object' && prior.connectionId === selected.connectionId && prior.modelId === selected.modelId) continue;
    const profile = mediaConnectionProfile(selected.connectionId);
    if (!profile?.apiKeySecretName || !await secrets.get(profile.apiKeySecretName)) {
      return { ok: false, message: 'The selected media connection is no longer configured. Choose a connection in Media models.' };
    }
    if (feature === 'imageGeneration' && imageConnections?.modelForConnection(selected.connectionId) !== selected.modelId) {
      return { ok: false, message: 'Unverified – not usable yet. Choose a verified image model in Media models before saving.' };
    }
    if (feature === 'transcription' && !verifiedUnodeTranscriptionModel(selected)) {
      return { ok: false, message: 'Choose a supported Unode audio model in Media models before saving.' };
    }
  }
  const toolSelection = agentBuilderTools({ roleKey: payload.roleKey, skills,
    current: existing?.config, backend: profileForSave.backendKind,
    executePreference: payload.executePreference });
  if (profileForSave.backendKind === 'codex' && toolSelection.executePreference === 'deny') {
    return { ok: false, message: 'This Codex connection cannot disable native commands independently. No changes were saved. Choose a connection that can enforce Run commands off.' };
  }
  const requestedTools = allowedToolCeiling
    ? toolSelection.allowedTools!.filter(tool => allowedToolCeiling.has(tool)) : toolSelection.allowedTools!;
  const requestedToolCeiling = allowedToolCeiling && profileForSave.backendKind === 'codex'
    ? 'bounded' as const : toolSelection.toolCeiling;
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
    toolCeiling: requestedToolCeiling,
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
  const config = existing ? structuredClone(existing.config) : new AgentConfigBuilder(role)
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
  config.allowedTools = requestedTools;
  config.executePreference = toolSelection.executePreference;
  config.builtinToolDefaultsRevision = toolSelection.builtinToolDefaultsRevision;
  if (profileForSave.backendKind === 'codex') {
    config.toolCeiling = requestedToolCeiling;
  } else {
    delete config.toolCeiling;
  }
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
  config.mcpServers = adapted.droppedMcp || !profileForSave.capabilities.mcp
    ? payload.mcpServers : [...payload.mcpServers, ...pausedBuilderGrants];
  if (requestedMedia) config.mediaModels = { ...existing?.config.mediaModels, ...requestedMedia };
  else if (existing?.config.mediaModels) config.mediaModels = existing.config.mediaModels;
  const publicSearch = payload.publicSearch ?? existing?.config.publicSearch;
  if (publicSearch === 'inherit' || publicSearch === 'off') config.publicSearch = publicSearch;
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
  // v0.9.90 Smart compaction: mode, work profile or Custom numbers. Absent leaves the saved choice alone.
  if (payload.smartCompaction) applySmartCompactionChoice(config, payload.smartCompaction);

  for (const id of payload.mcpServers) {
    const cfg = mcpRegistry.get(id);
    if (cfg) {
      await mountMcpServer(cfg);
    }
  }

  if (existing) {
    // v0.9.101 (H2a, audit H2a-1): the model or the connection it runs on, before this edit replaces the configuration.
    // Replacing either ends the agent's waiting work as "coordinator gone" (SessionManager.configEdited).
    const executionChanged = agentExecutionChanged(existing.config, config, priorBackendKind);
    const publish = () => {
      const previousImage = existing.config.mediaModels?.imageGeneration;
      existing.config = config;
      if (JSON.stringify(previousImage) !== JSON.stringify(config.mediaModels?.imageGeneration)) imageConnections?.invalidateMember(config.id);
    };
    let committed: boolean;
    if (existing.config.allowedTools?.includes('execute') && !config.allowedTools?.includes('execute') && config.executePreference === 'deny') {
      if (!rosterCurrent()) return { ok: false, message: 'The team changed. Run commands was not changed.' };
      try {
        committed = await agentRosterEdits.revokeCommands(config, existing.config, rosterCurrent,
          () => sessionManager.prepareToolRevocation(existing.id), publish,
          () => !hostShutdown.started && isCurrent());
      } catch {
        teamViewProvider?.refresh(); chatViewProvider?.refresh();
        return { ok: false, message: `Run commands is off for ${existing.config.name} in this window; it could not be saved yet. Other work can continue; UnodeAi will try saving again.` };
      }
    } else {
      committed = await agentRosterEdits.commit(config, existing.config, rosterCurrent, publish);
    }
    if (!committed) return { ok: false, message: 'The team changed while saving. This edit was not applied; reopen the agent and try again.' };
    // A role edit can change the generated roster label/duty without creating or removing a session.
    // Coalesce it with any lifecycle events so the owned rules block stays current as well.
    scheduleTeamRulesOnRosterChange();
    // v0.9.94: the session manager restarts a live agent, as before, and discards the stored conversation when the
    // save changed the backend kind, also for an agent it does not restart. An agent changed to another kind and
    // back before it starts would otherwise get its old conversation back, after this message said twice that it
    // would not.
    const backendKindChanged = priorBackendKind !== profileForSave.backendKind;
    await sessionManager.configEdited(existing.id, { backendKindChanged, executionChanged });
    accessInputsChanged(existing.id);
    teamViewProvider?.refresh();
    chatViewProvider?.refresh();
    MarketplacePanel.refreshCurrent();
    const backendChangeNotice = backendKindChanged ? backendKindChangeNotice(priorBackendKind, profileForSave.backendKind) : '';
    return { ok: true, message: `Updated ${config.name}.${backendChangeNotice}${contextWindowNotice}${droppedGrantsNotice}` };
  }

  const committed = await agentRosterEdits.commit(config, undefined, rosterCurrent, () => { sessionManager.create(config); });
  if (!committed) return { ok: false, message: 'The team changed while saving. This agent was not added; reopen the builder and try again.' };
  notifyPmRosterChange();
  return { ok: true, message: `Added ${config.name} to your team.${contextWindowNotice}${droppedGrantsNotice}`, addedMember: { agentId: config.id, name: config.name } };
}

/**
 * M4: perform a marketplace install chosen in the panel. Agent additions use the serialized roster
 * save lane; new teams use the saved-team replacement transaction. Integrations retain their existing
 * host configuration and approval path. Skills land in Phase 3.
 */
/** Icons the current roster wears, for de-duplicating a newly created agent's glyph. */
function rosterIcons(): string[] {
  return sessionManager.getAll().map((s) => s.config.icon).filter((icon): icon is string => !!icon);
}

async function handleMarketplaceInstall(
  action: MarketplaceInstallAction,
  extensionUri: vscode.Uri,
  replaceTeam: (document: TeamFileDocument, isCurrent: () => boolean) => Promise<boolean>,
): Promise<MemberAddResult | undefined> {
  if (!firstWorkspaceRoot()) {
    return { ok: false, message: 'Open a workspace folder and reload the window before changing this project; nothing was written.' };
  }
  const capturedRoster = agentRosterEdits.capture();
  const rosterCurrent = () => !hostShutdown.started && capturedRoster();
  const catalog = await loadMarketplaceCatalog(extensionUri);

  if (action.kind === 'agent') {
    const entry = catalog.agents.find((e) => e.id === action.entryId);
    if (!entry) { return { ok: false, message: 'Unknown agent preset.' }; }
    if (!agentRosterEdits.admissionAllowed || !rosterCurrent() || hostShutdown.started) {
      return { ok: false, message: 'The team changed. Reopen the marketplace and try again; no agent was added.' };
    }
    // No cwd: the runtime resolves the working root per session — don't pin it onto the installed config.
    // v0.9.105 (S3): the default connection and that connection's model for the role, with the template's own
    // per-provider override, resolved as Add Agent resolves them; no longer always Roam.
    const installDeps = dialogDeps();
    const shippedTemplate = entry.roleTemplateKey && Object.hasOwn(ROLE_TEMPLATES, entry.roleTemplateKey)
      ? ROLE_TEMPLATES[entry.roleTemplateKey] : undefined;
    const connection = dialogs.newAgentConnection(installDeps, resolveDefaultProvider(), shippedTemplate ?? { tier: entry.tier, model: entry.model });
    const config = toAgentConfig(entry, {
      name: dialogs.uniqueAgentName(installDeps, entry.name),
      provider: connection.selection.provider,
      model: connection.model,
    });
    dialogs.applyNewAgentConnection(config, connection.selection, installDeps);
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
    if (action.target === 'new-team') {
      const current = sessionManager.getAll();
      if (current.length > 0) {
        const choice = await vscode.window.showWarningMessage(
          `Start a new team with "${entry.name}"? This replaces your current ${current.length} agent(s), after saving a recovery snapshot.`,
          { modal: true }, 'Keep current team', 'Replace'
        );
        if (choice !== 'Replace') { return { ok: false, message: 'Cancelled — team unchanged.' }; }
      }
      if (hostShutdown.started || !agentRosterEdits.admissionAllowed || !rosterCurrent()) {
        return { ok: false, message: 'The team changed during confirmation. Reopen the marketplace; no team was replaced.' };
      }
      // Stage and validate before stopping anything. Never remove members one by one or inherit the
      // outgoing verification command: use the same snapshot/stop/policy/rollback lane as saved teams.
      if (!await replaceTeam({ version: '1.0', members: [config], mcpServers: [], workflows: [] }, rosterCurrent)) {
        return { ok: false, message: 'The new team was not applied; the current team was retained.' };
      }
    } else if (!await agentRosterEdits.commit(config, undefined, rosterCurrent, () => sessionManager.create(config))) {
      return { ok: false, message: 'The team changed while saving. Reopen the marketplace; no agent was added.' };
    }
    notifyPmRosterChange();
    const suggested = entry.suggestedMcpServers?.length
      ? ` Suggested integrations: ${entry.suggestedMcpServers.join(', ')}; none was configured or granted.`
      : '';
    return { ok: true, message: `Added ${config.name} to your team.${suggested}`,
      ...(action.target === 'current-team' ? { addedMember: { agentId: config.id, name: config.name } } : {}) };
  }

  if (action.kind === 'mcp') {
    const entry = catalog.mcp.find((e) => e.id === action.entryId);
    if (!entry) { return { ok: false, message: 'Unknown MCP server.' }; }
    if (mcpRegistry.has(entry.id)) {
      return editManagedIntegration(entry.id);
    }
    const cfg = toMcpServerConfig(entry);
    const promptedUrl = await promptMarketplaceMcpUrl(entry);
    if (promptedUrl === undefined && entry.urlPrompt) {
      return { ok: false, message: 'Cancelled — MCP server unchanged.' };
    }
    if (promptedUrl) {
      cfg.url = promptedUrl.trim();
    }
    await saveManagedIntegration(undefined, cfg);
    await approveUserAddedMcpServer(cfg);
    settingsPanelRefresh();
    return mcpMountMessage(cfg.name, await mountMcpServer(cfg), 'added');
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

async function saveManagedIntegration(original: MCPServerConfig | undefined, next: MCPServerConfig | undefined): Promise<void> {
  const id = (next ?? original)!.id;
  const root = firstWorkspaceRoot();
  const repair = persistence.integrationConfigNeedsRepair(id);
  const expected = repair ? persistence.loadHostMcpServers().find(server => server.id === id) : original;
  const launchChanged = !original || !next || repair || !sameMcpMountConfig(original, next);
  const assertCurrent = () => {
    if (!root || firstWorkspaceRoot() !== root || mcpRegistry.get(id) !== original) {
      throw new Error('The integration or workspace changed. Open its current Marketplace card and try again.');
    }
  };
  let disconnected: Promise<void> | undefined;
  try {
    await persistence.commitIntegrationConfiguration(id, expected, next, assertCurrent, () => {
      if (launchChanged) {
        discardIntegrationTest(id);
        cancelPendingMcpMount(id, 'The integration configuration changed.');
        mountedIntegrationFingerprints.delete(id);
        disconnected = mcpHub.unregister(id);
      } else if (next) {
        mcpHub.renameRegisteredServer(id, next.name);
      }
      if (next) mcpRegistry.set(id, next);
      else mcpRegistry.delete(id);
      mcpMountDetails.delete(id);
    });
  } catch (error) {
    if (persistence.integrationConfigNeedsRepair(id)) {
      discardIntegrationTest(id);
      cancelPendingMcpMount(id, 'Configuration could not be verified. Open Edit to repair it.');
      mountedIntegrationFingerprints.delete(id);
      disconnected = mcpHub.unregister(id);
      mcpMountDetails.set(id, 'Configuration could not be verified. Open Edit to repair it.');
    }
    throw error;
  } finally {
    await disconnected;
    settingsPanelRefresh();
  }
}

function discardIntegrationTest(serverId: string): void {
  const test = integrationTests.get(serverId);
  integrationTests.delete(serverId);
  test?.controller.abort();
}

function manageIntegrationTest(serverId: string, action: 'start' | 'stop'): void {
  const previous = integrationTests.get(serverId);
  if (action === 'stop') {
    if (previous?.state === 'running') previous.controller.abort();
    return;
  }
  const config = mcpRegistry.get(serverId);
  if (removingIntegrations.has(serverId)) {
    void showResultNotice('information', 'This integration is being removed. Test is available from its card if it is still configured.');
    return;
  }
  if (!config || previous?.state === 'running') return;
  const test: IntegrationTestRecord = {
    fingerprint: integrationMountKey(config), controller: new AbortController(),
    state: 'running', detail: 'Checking the connection…',
  };
  integrationTests.set(serverId, test);
  MarketplacePanel.refreshCurrent();
  const finished = runManagedIntegrationTest(config, test).finally(() => { activeIntegrationTests.delete(test); });
  activeIntegrationTests.set(test, finished);
}

async function runManagedIntegrationTest(config: MCPServerConfig, test: IntegrationTestRecord): Promise<void> {
  const signal = test.controller.signal;
  const current = () => !hostShutdown.started && vscode.workspace.isTrusted && integrationTests.get(config.id) === test
    && test.fingerprint === integrationMountKey(config) && isCurrentIntegrationMount(config);
  try {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before testing integrations.');
    if (!current()) throw new Error('Open Edit and save a verified configuration before testing again.');
    const root = workspaceRoot();
    let launch: MCPServerConfig;
    try {
      launch = resolveServerPlaceholders(resolveHostMcpProgram(config), { WORKDIR: root });
    } catch {
      throw new Error('The integration command could not be found. Install it, or open Edit to change the command.');
    }
    if (needsApproval(config, approvedMcp, root)) {
      // The test starts a private connection and uses the same launch approval as the next live mount.
      const askToTest = async () => {
        const choice = await blockingPrompt(attentionAppearance('mcp-mount'), () => vscode.window.showWarningMessage(
          `Start a test instance of "${config.name}" (${config.transport}) to list its tools? This also approves the same launch configuration for future starts.`,
          { modal: true }, 'Skip', 'Approve & Test',
        ), mcpMountWaits.prompt(`test:${test.fingerprint}`));
        return choice === 'Approve & Test';
      };
      if (!await raceMcpTestCancellation(askToTest(), signal)) {
        test.state = 'cancelled';
        test.detail = 'Cancelled before connecting.';
        return;
      }
      if (!current()) return;
      signal.throwIfAborted();
      const key = approvalKey(config, root);
      if (!await persistence.approveIntegrationTest(key, () => current() && !signal.aborted) || !current()) return;
      approvedMcp.add(key);
    }
    if (!current()) return;
    signal.throwIfAborted();
    const count = await testMcpConnection(launch, name => secrets.get(name), signal);
    if (!current()) return;
    signal.throwIfAborted();
    test.state = 'passed';
    test.detail = `Connected · ${count} ${count === 1 ? 'tool' : 'tools'} found.`;
  } catch (error) {
    if (signal.aborted) {
      test.state = 'cancelled';
      test.detail = 'Cancelled.';
    } else {
      test.state = 'failed';
      test.detail = error instanceof Error ? redactDiagnosticText(error.message) : 'Could not complete the integration test.';
    }
  } finally {
    if (integrationTests.get(config.id) === test) {
      if (test.state === 'running') {
        test.state = 'cancelled';
        test.detail = 'Cancelled because the configuration or workspace changed.';
      }
      MarketplacePanel.refreshCurrent();
    }
  }
}

async function editManagedIntegration(serverId: string): Promise<{ ok: boolean; message: string } | undefined> {
  const original = mcpRegistry.get(serverId);
  if (!original) return { ok: false, message: 'That integration is no longer configured.' };
  const title = `Edit ${original.name}`;
  const name = await vscode.window.showInputBox({
    title, prompt: 'Display name', value: original.name, ignoreFocusOut: true,
    validateInput: value => value.trim() ? null : 'Enter a display name.',
  });
  if (name === undefined) return undefined;
  const transports: GuidedMcpTransport[] = ['stdio', 'streamable-http', 'sse'];
  const transportChoice = await vscode.window.showQuickPick(
    [original.transport, ...transports.filter(transport => transport !== original.transport)]
      .map(transport => ({ label: transport, transport })),
    { title, placeHolder: `Transport (current: ${original.transport})`, ignoreFocusOut: true },
  );
  if (!transportChoice) return undefined;
  const { transport } = transportChoice;
  let launch: Pick<MCPServerConfig, 'args' | 'command' | 'url'>;
  if (transport === 'stdio') {
    const command = await vscode.window.showInputBox({
      title, prompt: 'Command to start the integration', value: original.command,
      ignoreFocusOut: true, validateInput: value => value.trim() ? null : 'Enter a command.',
    });
    if (command === undefined) return undefined;
    const input = await vscode.window.showInputBox({
      title, prompt: 'Command arguments as a JSON array', value: JSON.stringify(original.args ?? []), ignoreFocusOut: true,
      validateInput: value => { const result = parseMcpArgumentArray(value); return result.ok ? null : result.error; },
    });
    if (input === undefined) return undefined;
    const parsed = parseMcpArgumentArray(input);
    if (!parsed.ok) return { ok: false, message: parsed.error };
    launch = { command: command.trim(), args: parsed.args.length ? parsed.args : original.args?.length === 0 ? [] : undefined, url: undefined };
  } else {
    const url = await vscode.window.showInputBox({
      title, prompt: 'MCP endpoint', value: original.url, ignoreFocusOut: true,
      validateInput: value => isValidMcpUrl(value) ? null : 'Use a valid http:// or https:// URL.',
    });
    if (url === undefined) return undefined;
    if (!isValidMcpUrl(url)) return { ok: false, message: 'Use a valid MCP endpoint URL.' };
    launch = { url: url.trim(), args: undefined, command: undefined };
  }
  const input = await vscode.window.showInputBox({
    title, prompt: 'Environment placeholders (KEY=${VAR}). Press Enter to save.',
    value: Object.entries(original.env ?? {}).map(([key, value]) => `${key}=${value}`).join(', '),
    ignoreFocusOut: true, validateInput: value => { const result = parseMcpEnvInput(value); return result.ok ? null : result.error; },
  });
  if (input === undefined) return undefined;
  const env = parseMcpEnvInput(input);
  if (!env.ok) return { ok: false, message: env.error };
  if (!name.trim() || (transport === 'stdio' && !launch.command)) {
    return { ok: false, message: 'Enter a display name and the required launch fields.' };
  }
  const next: MCPServerConfig = { ...original, name: name.trim(), transport, ...launch, env: env.env };
  const keptMount = sameMcpMountConfig(original, next) && !persistence.integrationConfigNeedsRepair(serverId);
  try {
    await saveManagedIntegration(original, next);
    return { ok: true, message: keptMount ? `Saved "${next.name}".`
      : `Saved "${next.name}". It will connect the next time a member with access starts.` };
  } catch {
    return { ok: false, message: persistence.integrationConfigNeedsRepair(serverId)
      ? 'The integration is paused because the configuration could not be verified. Open Edit to repair it.'
      : 'Could not save the integration. Check .unode/team.json and open Edit again.' };
  }
}

function effectiveIntegrationGrants(agent: AgentConfig) {
  return agentMcpGrants(persistence.restrictUnconfirmedGrants(agent), skillResolver);
}

const openIntegrationGrantPickers = new Set<string>();

async function grantManagedIntegration(serverId: string): Promise<{ ok: boolean; message: string } | undefined> {
  if (removingIntegrations.has(serverId)) return { ok: false, message: 'This integration is being removed. Reopen its card if it is still configured.' };
  if (openIntegrationGrantPickers.has(serverId)) return undefined;
  const config = mcpRegistry.get(serverId);
  const root = firstWorkspaceRoot();
  if (!config || !root) return { ok: false, message: 'Open a workspace with this integration configured before assigning it.' };
  const sessions = sessionManager.getAll();
  const rosterCurrent = agentRosterEdits.capture();
  const fingerprint = approvalKey(config, root);
  const isCurrent = () => {
    const current = mcpRegistry.get(serverId);
    return !removingIntegrations.has(serverId) && current === config && approvalKey(current, root) === fingerprint && rosterCurrent();
  };
  const isDirect = (member: AgentConfig) => member.mcpServers?.includes(serverId) === true;
  const isCodex = (member: AgentConfig) =>
    (member.backend ?? defaultBackendKind(member, effectiveConnectionRegistry)) === 'codex';
  const canAdd = (member: AgentConfig) => {
    const capabilities = connectionProfileForAgent(member, effectiveConnectionRegistry)?.capabilities;
    return capabilities !== undefined && !dropUnsupportedGrants(
      { skillIds: [], playbooks: [], mcpServers: [serverId] }, capabilities,
    ).droppedMcp;
  };
  const timing = (id: string) => {
    const backend = sessionManager.getBackend(id);
    const status = sessionManager.get(id)?.status;
    const currentMount = mcpHub.isRegistered(serverId) && mountedIntegrationFingerprints.get(serverId) === fingerprint;
    return integrationGrantTiming((status === 'idle' || status === 'running')
      && backend instanceof OpenAICompatBackend && backend.mcpAttachedAtStart, currentMount);
  };
  const duplicatedName = (name: string) => sessions.filter(({ config: member }) => member.name === name).length > 1;
  type Item = vscode.QuickPickItem & { agentId?: string };
  const repair = persistence.integrationGrantRepairs().find(item => item.serverId === serverId);
  const unsupported: string[] = [];
  const items: Item[] = sessions.flatMap(({ config: member }) => {
    const label = duplicatedName(member.name) ? `${member.name} · ${member.id}` : member.name;
    const skill = skillResolver.resolveMcpServerRefs(member.skills ?? []).find(grant => grant.serverId === serverId);
    if (!isDirect(member) && !canAdd(member)) {
      unsupported.push(label);
      return [];
    }
    return [{
      agentId: member.id,
      label,
      description: skill ? describeIntegrationSkillGrant(skill) : undefined,
      detail: isCodex(member)
        ? 'Changing this assignment starts a new Codex conversation on next start. The current context does not carry over.'
        : isDirect(member) ? 'Clear to revoke direct access from the next tool call.' : timing(member.id),
    }];
  });
  if (!items.length && !repair) {
    return { ok: false, message: 'This team has no members with an MCP-capable connection. Use Agent Builder to set a member’s connection.' };
  }
  openIntegrationGrantPickers.add(serverId);
  try {
    const picker = vscode.window.createQuickPick<Item>();
    const title = `Grant to… ${config.name}`;
    picker.title = unsupported.length ? `${title} · MCP unavailable: ${unsupported.join(', ')}` : title;
    picker.placeholder = repair ? 'Review the paused direct grants and press Enter to save' : 'Select members for direct access, then press Enter to save';
    picker.canSelectMany = true;
    picker.matchOnDescription = true;
    picker.items = items;
    picker.selectedItems = items.filter(item => sessions.some(({ config: member }) =>
      member.id === item.agentId && isDirect(persistence.restrictUnconfirmedGrants(member))));
    let selection: readonly string[] | undefined;
    try {
      selection = await new Promise<readonly string[] | undefined>((resolve) => {
        picker.onDidAccept(() => {
          resolve(picker.selectedItems.flatMap(item => item.agentId ? [item.agentId] : []));
          picker.hide();
        });
        picker.onDidHide(() => resolve(undefined));
        picker.show();
      });
    } finally {
      picker.dispose();
    }
    if (!selection) return undefined;
    const selected = new Set(selection);
    if (!isCurrent() || [...selected].some(id => !sessions.some(({ config: member }) => member.id === id))) {
      return { ok: false, message: 'The team or integration changed. Open Grant to… again.' };
    }
    if (sessions.some(({ config: member }) => selected.has(member.id) && !isDirect(member) && !canAdd(member))) {
      return { ok: false, message: 'A selected member’s connection no longer supports MCP. Open Grant to… again.' };
    }
    const changes: IntegrationGrantChange[] = sessions.flatMap(({ config: member }) =>
      selected.has(member.id) === isDirect(member) ? [] : [{ agentId: member.id, granted: selected.has(member.id) }]);
    if (!changes.length && !repair) return undefined;
    const codexAgentIds = sessions.filter(({ config: member }) => isCodex(member)
      && (changes.some(change => change.agentId === member.id) || repair?.agentIds.includes(member.id))).map(({ id }) => id);
    try {
      await agentRosterEdits.commitIntegrationGrants(
        () => isCurrent() && !sessions.some(({ config: member }) => selected.has(member.id) && !isDirect(member) && !canAdd(member)),
        (members, assertCurrent) => persistence.saveIntegrationGrants(serverId, members, changes, codexAgentIds, assertCurrent, () => {
          for (const { agentId, granted } of changes) {
            const member = sessionManager.get(agentId)!.config;
            member.mcpServers = withDirectIntegrationGrant(member, serverId, granted).mcpServers;
          }
          teamRosterRevision++;
        }),
      );
    } catch (error) {
      return {
        ok: false,
        message: error instanceof IntegrationGrantError ? error.message : 'Direct grants were not saved. Open Grant to… and try again.',
      };
    } finally {
      teamViewProvider?.refresh();
      chatViewProvider?.refresh();
      AgentBuilderPanel.refreshCurrent();
    }
    const summary = changes.flatMap(({ agentId, granted }) => {
      const member = sessionManager.get(agentId)?.config;
      if (!member) return [];
      const label = duplicatedName(member.name) ? `${member.name} · ${member.id}` : member.name;
      const skill = !granted ? skillResolver.resolveMcpServerRefs(member.skills ?? []).find(grant => grant.serverId === serverId) : undefined;
      const assignment = granted ? timing(agentId) : skill ? describeIntegrationSkillGrant(skill) : 'Direct access revoked';
      return [isCodex(member) ? `${label}: ${assignment}. Starts a new Codex conversation on next start.` : `${label}: ${assignment}.`];
    });
    return { ok: true, message: [`Saved direct grants for "${config.name}".`, ...summary].join(' ') };
  } finally {
    openIntegrationGrantPickers.delete(serverId);
  }
}

/** Persist revocation before disconnecting so a failed registry write leaves a safe, ungranted config. */
async function removeManagedIntegration(serverId: string): Promise<{ ok: boolean; message: string }> {
  if (removingIntegrations.has(serverId)) return { ok: false, message: 'This integration is already being removed.' };
  const config = mcpRegistry.get(serverId);
  if (!config) return { ok: false, message: 'That integration is no longer configured.' };
  const sessions = sessionManager.getAll();
  const rosterCurrent = agentRosterEdits.capture();
  const affected = sessions.filter(({ config: agent }) =>
    agentMcpGrants(agent, skillResolver).some((grant) => grant.serverId === serverId));
  const affectedNames = affected.map(({ config: agent }) => agent.name);
  const detail = affectedNames.length > 0
    ? `This also revokes access from: ${affectedNames.join(', ')}.`
    : 'No agent currently has a grant.';
  const choice = await vscode.window.showWarningMessage(
    `Remove integration "${config.name}"? ${detail}`,
    { modal: true },
    'Keep Existing',
    'Remove & Revoke',
  );
  if (choice !== 'Remove & Revoke') return { ok: false, message: 'Removal cancelled; nothing changed.' };
  if (removingIntegrations.has(serverId) || mcpRegistry.get(serverId) !== config || !agentRosterEdits.admissionAllowed || !rosterCurrent()) {
    return { ok: false, message: 'The team or integration changed during confirmation. Review the integration again.' };
  }
  removingIntegrations.add(serverId);
  discardIntegrationTest(serverId);
  try {
    return await finishManagedIntegrationRemoval(config, sessions, rosterCurrent, affectedNames.length);
  } finally {
    removingIntegrations.delete(serverId);
    AgentBuilderPanel.refreshCurrent();
    MarketplacePanel.refreshCurrent();
  }
}

async function finishManagedIntegrationRemoval(
  config: MCPServerConfig, sessions: ReturnType<SessionManager['getAll']>, rosterCurrent: () => boolean, affectedCount: number,
): Promise<{ ok: boolean; message: string }> {
  const serverId = config.id;
  const updated = sessions.map(({ config: agent }) => withoutIntegrationGrant(
    agent,
    serverId,
    (skills) => skillResolver.resolveMcpServerRefs(skills),
  ));
  try {
    await persistence.removeProjectIntegrationGrants(serverId, skills => skillResolver.resolveMcpServerRefs(skills), () => {
      if (!agentRosterEdits.admissionAllowed || !rosterCurrent()) throw new Error('The team changed before grant revocation. Review the integration again.');
    });
    const committed = await agentRosterEdits.commitRoster(updated, rosterCurrent, () => {
      for (const session of sessions) {
        const next = updated.find(agent => agent.id === session.config.id);
        if (next) { session.config.mcpServers = next.mcpServers; session.config.skills = next.skills; }
      }
    });
    if (!committed) return { ok: false, message: 'The team changed before grant revocation. Review the integration again.' };
  } catch (error) {
    return { ok: false, message: `Could not persist grant revocation; the integration remains configured. ${String(error)}` };
  }

  cancelPendingMcpMount(serverId, `"${config.name}" was removed while its mount was pending`);
  await mcpHub.unregister(serverId);

  const root = firstWorkspaceRoot();
  const approval = root ? approvalKey(config, root) : undefined;
  if (approval) approvedMcp.delete(approval);
  try {
    if (approval) await persistence.revokeIntegrationApproval(approval);
  } catch (error) {
    if (approval) approvedMcp.add(approval);
    settingsPanelRefresh();
    return {
      ok: false,
      message: `Agent grants were revoked and active calls were cancelled, but the integration approval record could not be removed. The integration remains configured but ungranted. ${String(error)}`,
    };
  }

  try {
    await persistence.clearIntegrationGrantRepair(serverId);
    await saveManagedIntegration(config, undefined);
  } catch (error) {
    settingsPanelRefresh();
    return {
      ok: false,
      message: `Agent grants were revoked and active calls were cancelled, but the integration registry could not be updated. It remains configured but ungranted. ${String(error)}`,
    };
  }
  mcpMountDetails.delete(serverId);
  mountedIntegrationFingerprints.delete(serverId);
  settingsPanelRefresh();
  teamViewProvider?.refresh();
  chatViewProvider?.refresh();
  return {
    ok: true,
    message: `Removed "${config.name}" and revoked ${affectedCount} agent grant${affectedCount === 1 ? '' : 's'}. Running agents will refuse stale advertised tools; Codex refreshes its tool list on the next start.`,
  };
}

/**
 * Trusted, user-confirmed import for the retired singleton custom gateway. The migration plan is
 * persisted before the first profile mutation, so a restart reuses the same opaque ids rather than
 * using endpoint equality or a display name as an accidental cross-workspace identity.
 */
async function migrateLegacySingletonCustomGateways(): Promise<void> {
  // This migration owns project roster/state. A folderless window has no source or destination and
  // must activate read-only without trying to clear a root-scoped journal.
  if (!firstWorkspaceRoot()) return;
  const declines = new PersistentLegacyCustomMigrationDeclines(rootWorkspaceState);
  const workspaceAgents = persistence.loadAgents();
  const startupTeam = await persistence.loadTeamConfigForStartup();
  // Do not rewrite/clear migration state using a document whose verification configuration did not validate.
  if (startupTeam.kind === 'configuration-invalid') return;
  const teamConfig = startupTeam.document;
  const teamAgents = await hydratedLegacyTeamAgents(teamConfig?.members ?? []);
  const workspaceLegacy = workspaceAgents.filter(isLegacySingletonCustomAgent);
  const teamLegacy = teamAgents.filter(isLegacySingletonCustomAgent);
  let state = readLegacyCustomGatewayMigrationState();
  const terminalRepairs = state ? undefined : readLegacyCustomGatewayTerminalRepairs();
  if (workspaceLegacy.length === 0 && teamLegacy.length === 0) {
    // A crash after both roster writes but before clearing the journal is already fully applied.
    const snapshot = state ? await loadCustomGatewayRegistryOrFallback() : undefined;
    if (state && state.plan.entries.every((entry) => snapshot?.profiles.some((profile) => profile.connectionId === entry.connectionId))) {
      await rootWorkspaceState.update(LEGACY_CUSTOM_GATEWAY_MIGRATION_KEY, undefined);
    }
    if (terminalRepairs) {
      await rootWorkspaceState.update(LEGACY_CUSTOM_GATEWAY_TERMINAL_REPAIRS_KEY, undefined);
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
    const legacyGlobalEndpoint = configuredSetting<string>('customBaseUrl', '');
    let plan: LegacyCustomGatewayMigrationPlan;
    try {
      plan = planLegacyCustomGatewayMigration({
        trusted: true,
        agents: migrationAgents,
        legacyGlobalEndpoint,
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
    // v0.9.99: a migration that only recreates the person's own binding (their legacy Custom key, to their User-level
    // legacy endpoint) runs without the old modal, which held the roster restore at activation. It sends nothing and
    // keeps the legacy keys and settings for other workspaces; a notice below says what moved. A decline recorded by
    // an earlier release is still honoured above (shouldSuppressPrompt).
    //
    // Any other endpoint or stored key named by a record may be the project's choice, wherever the record is stored:
    // restoring .unode/team.json saves the project's members into workspace state. Migrating it would bind one of the
    // person's keys to that endpoint, and the first request would then send it. So such a migration runs only after the
    // person agrees to the listed endpoints and keys, as before this release.
    if (!plan.entries.every((entry) => isPersonsOwnLegacyCustomBinding(entry, legacyGlobalEndpoint))) {
      const choice = await vscode.window.showWarningMessage(
        legacyCustomGatewayMigrationPreview(plan, legacyGlobalEndpoint),
        { modal: true },
        'Do not migrate',
        'Migrate custom gateways',
      );
      if (choice !== 'Migrate custom gateways') {
        await declines.remember(migrationAgents);
        return;
      }
    } else {
      outputChannel.info(`Migrating ${plan.entries.length} legacy Custom gateway profile(s) without a prompt.`);
    }
    state = {
      schemaVersion: 1,
      sourceAgentIds: migrationAgents.filter(isLegacySingletonCustomAgent).map((agent) => agent.id).sort(),
      plan,
    };
    await rootWorkspaceState.update(LEGACY_CUSTOM_GATEWAY_MIGRATION_KEY, state);
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
    if (teamConfig) {
      await persistence.updateTeamConfig((current) => ({ ...current!, members: migrated }), teamConfig.members);
    }
    await persistence.saveAgents(migrated);
    const configuredDefault = makeConfigStore().get<string>('defaultProvider', 'unode').trim().toLowerCase();
    if (configuredDefault === LEGACY_CUSTOM_PROVIDER_ID && state.plan.entries.length === 1) {
      await makeConfigStore().update('defaultProvider', state.plan.entries[0].connectionId);
    } else if (configuredDefault === LEGACY_CUSTOM_PROVIDER_ID) {
      void showResultNotice('warning', 'Legacy Custom was your default provider, but migration produced zero or multiple named gateways. Choose a default custom gateway in Settings before creating new agents.');
    }
    if (!migrated.some(isLegacySingletonCustomAgent)) {
      await rootWorkspaceState.update(LEGACY_CUSTOM_GATEWAY_MIGRATION_KEY, undefined);
      await rootWorkspaceState.update(LEGACY_CUSTOM_GATEWAY_TERMINAL_REPAIRS_KEY, undefined);
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
      await rootWorkspaceState.update(LEGACY_CUSTOM_GATEWAY_MIGRATION_KEY, undefined);
      await rootWorkspaceState.update(LEGACY_CUSTOM_GATEWAY_TERMINAL_REPAIRS_KEY, {
        schemaVersion: 1,
        agentIds: [...completedRepairIds].sort(),
      } satisfies LegacyCustomGatewayTerminalRepairState);
    }
    void showResultNotice('information', legacyCustomGatewayMigrationNotice(state.plan));
  } catch (error) {
    outputChannel.warn(`Legacy Custom gateway migration paused: ${error instanceof Error ? error.message : String(error)}`);
    void showResultNotice('warning', `UnodeAi paused legacy Custom gateway migration: ${error instanceof Error ? error.message : String(error)} No model request was sent.`);
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
  // v0.9.99: the team file of the activation-time root, the same one PersistenceManager reads.
  const folder = boundRootUri();
  if (!folder) { return new Map(); }
  try {
    const uri = vscode.Uri.joinPath(folder, '.unode', 'team.json');
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

function readLegacyCustomGatewayMigrationState(): LegacyCustomGatewayMigrationState | undefined {
  const state = rootWorkspaceState.get<LegacyCustomGatewayMigrationState>(LEGACY_CUSTOM_GATEWAY_MIGRATION_KEY);
  return state?.schemaVersion === 1 && Array.isArray(state.sourceAgentIds) && state.plan?.schemaVersion === 1
    ? state
    : undefined;
}

function readLegacyCustomGatewayTerminalRepairs(): LegacyCustomGatewayTerminalRepairState | undefined {
  const state = rootWorkspaceState.get<LegacyCustomGatewayTerminalRepairState>(LEGACY_CUSTOM_GATEWAY_TERMINAL_REPAIRS_KEY);
  return state?.schemaVersion === 1 && Array.isArray(state.agentIds) && state.agentIds.every((agentId) => typeof agentId === 'string')
    ? state
    : undefined;
}

/**
 * The question for a legacy Custom migration that binds a key or endpoint other than the person's own legacy setup: each
 * endpoint, and each stored key it would get.
 */
function legacyCustomGatewayMigrationPreview(plan: LegacyCustomGatewayMigrationPlan, legacyGlobalEndpoint: string): string {
  const groups = plan.entries.map((entry) =>
    `${entry.displayName}: ${entry.endpointBase} (${entry.agentIds.length} agent${entry.agentIds.length === 1 ? '' : 's'}; `
    + `${entry.secretRef ? `your stored key "${entry.legacySecretName}" would be used with this endpoint` : 'no stored key is used'})`
    + (isPersonsOwnLegacyCustomBinding(entry, legacyGlobalEndpoint) ? ' - your own Custom endpoint and key' : ''),
  );
  const repairs = plan.repairs.length > 0 ? `\n${plan.repairs.length} agent(s) need repair and will not be started.` : '';
  return 'This project\'s team has old Custom gateways. Migrate them into named gateways?\n\n'
    + `${groups.join('\n') || 'No valid HTTPS endpoints were found.'}${repairs}\n\n`
    + 'An endpoint or key other than your own Custom setup may come from the project (its .unode/team.json), not from '
    + 'you. Migrate only if you trust them. Nothing is sent now; an agent sends its requests, with that key, to its '
    + 'endpoint.';
}

/** v0.9.99: what the silent legacy Custom gateway migration did, in one non-modal notice with the next step. */
function legacyCustomGatewayMigrationNotice(plan: LegacyCustomGatewayMigrationPlan): string {
  const names = plan.entries.map((entry) => entry.displayName).join(', ');
  const moved = plan.entries.length > 0
    ? `UnodeAi moved your old Custom gateway setting into ${plan.entries.length} named gateway${plan.entries.length === 1 ? '' : 's'} (${names}); the agents that used it now use ${plan.entries.length === 1 ? 'it' : 'them'}. Nothing was sent.`
    : 'UnodeAi found an old Custom gateway setting with no usable HTTPS endpoint. Nothing was sent.';
  const repairs = plan.repairs.length > 0
    ? ` ${plan.repairs.length} agent${plan.repairs.length === 1 ? '' : 's'} still need${plan.repairs.length === 1 ? 's' : ''} a model or a gateway: open each in Agent Builder and choose one.`
    : '';
  return `${moved}${repairs} To review the gateways, open UnodeAi Settings, Providers tab.`;
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
      // An approval, a consent and a request limit decision are all counted here, so the word covers all three.
      approvalStatusBarItem.tooltip = `${pendingApprovals} UnodeAi decision${pendingApprovals === 1 ? '' : 's'} waiting for you — click to decide`;
      approvalStatusBarItem.show();
    } else {
      approvalStatusBarItem.hide();
    }
  }
  // The activity-bar container is a subscriber too. Its badge is intentionally not updated by approval code.
  teamViewProvider?.setApprovalBadge(pendingApprovals);
}
