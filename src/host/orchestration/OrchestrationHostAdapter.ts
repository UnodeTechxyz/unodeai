/*---------------------------------------------------------------------------------------------
 *  Orchestration host boundary
 *
 *  The extension composition root supplies two ports: one owns a coordinator's live runtime,
 *  the other records the facts that runtime observes. This module deliberately imports no VS Code
 *  API, so the authority paths can be exercised without activating an extension host.
 *--------------------------------------------------------------------------------------------*/

import { realpathSync } from 'node:fs';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { MessageBus } from '../../bus/MessageBus';
import { AgentCommandPolicy } from '../../backend/AgentCommandPolicy';
import { TaskClaimRegistry } from '../../backend/TaskClaimRegistry';
import {
  AsyncDelegationResult,
  CoordinatorTaskStatus,
  DelegationCancellationEvent,
  DelegationDispatchEvent,
  DelegationDispositionEvent,
  DelegationEmptyOutcomeEvent,
  RefusedDispatchEvent,
  TeamRosterEntry,
  TeamTools,
  TeamToolsOptions,
  TeamView,
} from '../../backend/TeamTools';
import { TaskInputResolver } from '../../backend/TaskContract';
import { intersectTaskWorkspaceAccess, resolveEffectiveRoots } from '../../backend/folderAccess';
import { normalizeAgentReadRoots } from '../../backend/readRoots';
import { resolveRecordedFileForOpen } from '../../views/toolReceipt';
import { AgentConfig, DelegationTaskScope, TaskWorkspaceAccess, UserAttachment } from '../../types';
import { ContextManifestSource, DelegationContentSource } from '../../session/TurnContextManifest';
import type { EffectiveExecutionIdentity } from '../../session/EffectiveExecutionIdentity';
import type { TaskAttemptCard } from '../../backend/TaskContract';
import type { ReviewPolicyPreflightDecision } from '../../policy/ReviewPolicyPreflight';

type DelegationEvidenceEvent = Parameters<NonNullable<TeamToolsOptions['onDelegationEvidence']>>[0];

/** Facts supplied by the extension host, not a model, about the current workspace. */
export interface OrchestrationWorkspaceAuthority {
  root(): string;
  roots(): readonly string[];
  isTrusted(): boolean;
  additionalReadRoots(): readonly string[];
}

/**
 * Owns live coordinator operation: its team, task authority, command approval and turn lifecycle.
 * It is intentionally named for this responsibility rather than exposing extension-wide state.
 */
export interface CoordinatorRuntimePort {
  /** Host-selected dispatch authority for this team. Optional only for standalone legacy hosts. */
  coordinatorId?(): string | undefined;
  workspace(): OrchestrationWorkspaceAuthority;
  messageBus(): MessageBus;
  teamEntries(): TeamRosterEntry[];
  resolveTeam(ref: string): { id: string } | undefined;
  configForAgent(agentId: string): AgentConfig | undefined;
  effectiveExecutionIdentity(agentId: string): EffectiveExecutionIdentity | undefined;
  admitCoordinatorAttempt(attempt: TaskAttemptCard, identity?: EffectiveExecutionIdentity): ReviewPolicyPreflightDecision;
  backendKindFor(config: AgentConfig): string;
  commandPolicyFor(config: AgentConfig): AgentCommandPolicy;
  verifyCommandFor(config: AgentConfig): string;
  workingDirectoryFor(config: AgentConfig): string;
  requestCommandApproval(
    config: AgentConfig,
    ...request: Parameters<NonNullable<TeamToolsOptions['requestApproval']>>
  ): ReturnType<NonNullable<TeamToolsOptions['requestApproval']>>;
  routeNotice(config: AgentConfig, line: string): void;
  commandBlocked(reason: string): void;
  verifyCommandOutsideRoot(message: string, outsidePath: string, command: string): void;
  /** Per-dispatch consent for a coordinator-authored brief crossing an independently resolved destination. */
  approveCoordinatorBriefEgress?(coordinator: AgentConfig, target: AgentConfig): Promise<{ allowed: boolean; reason?: string }>;
  taskClaims(): TaskClaimRegistry;
  escalateToFallback(agentId: string): ReturnType<NonNullable<TeamToolsOptions['escalate']>>;
  cancelDelegatedWorker(event: DelegationCancellationEvent): boolean;
  stopTeammate(coordinatorId: string, agentId: string, reason: string): boolean;
  queueAsyncDelegationWake(
    coordinatorId: string,
    result: AsyncDelegationResult,
    isReady: () => boolean,
    consume: () => boolean,
  ): void;
  recoveredAsyncResults(coordinatorId: string): readonly AsyncDelegationResult[];
  retainAsyncResult(coordinatorId: string, result: AsyncDelegationResult): void;
  consumeAsyncResult(coordinatorId: string, handle: string): void;
  warnUser(message: string): void;
  openRecordedFile(path: string): Promise<void>;
}

/**
 * Owns durable orchestration receipts and the projections rendered from those receipts. Keeping it
 * separate from the live runtime prevents a dispatch path from reaching arbitrary UI/store state.
 */
export interface OrchestrationEvidencePort {
  recordDispatched(event: DelegationDispatchEvent, coordinator: AgentConfig): void;
  recordRefused(event: RefusedDispatchEvent, coordinator: AgentConfig): void;
  recordEvidence(event: DelegationEvidenceEvent): void;
  recordDisposition(event: DelegationDispositionEvent): void;
  recordCancelled(event: DelegationCancellationEvent): void;
  recordDeliveryPending(handle: string): void;
  recordDeliveryDelivered(handle: string, via: 'auto-wake' | 'collect-ready' | 'blocking-tool'): void;
  inspectTaskStatus(coordinatorId: string, handles?: readonly string[]): readonly CoordinatorTaskStatus[];
  /** Delivers a host-owned empty-delegation receipt to the UI/evidence projection. */
  recordEmptyOutcome(event: DelegationEmptyOutcomeEvent): void;
  runIdForDelegation(handle: string): string | undefined;
  openHumanReview(runId: string): void;
  refreshAfterAsyncResult(): void;
}

/**
 * The single adapter for host orchestration policy. Its two ports are grouped by responsibility,
 * not by whichever extension singleton the previous composition-root functions happened to close over.
 */
export class OrchestrationHostAdapter {
  private taskInputResolver: TaskInputResolver | undefined;

  constructor(
    private readonly runtime: CoordinatorRuntimePort,
    private readonly evidence: OrchestrationEvidencePort,
  ) {}

  /** The resolver is host-owned and shared with coordinator and worker tool surfaces. */
  createTaskInputResolver(store: ContentAssetStore): TaskInputResolver {
    this.taskInputResolver = new TaskInputResolver(store, this.runtime.workspace().root());
    return this.taskInputResolver;
  }

  /** Build a coordinator's TeamTools surface from the two named host ports. */
  createCoordinatorTeamTools(
    config: AgentConfig,
    agentCommandPolicy = this.runtime.commandPolicyFor(config),
  ): TeamTools {
    const resolver = this.taskInputResolver;
    if (!resolver) {
      throw new Error('OrchestrationHostAdapter requires createTaskInputResolver before coordinator tools are created.');
    }
    // The async-result callback is configured during construction but runs only after a delegated
    // promise settles. Keep this reference so the runtime can consume a result only after it has
    // atomically started the corresponding coordinator wake turn.
    const toolRef: { current?: TeamTools } = {};
    const tools = new TeamTools(config.id, this.makeTeamView(), this.runtime.messageBus(), {
      coordinatorId: this.runtime.coordinatorId?.() ?? config.id,
      verifyCommand: this.runtime.verifyCommandFor(config),
      cwd: this.runtime.workingDirectoryFor(config),
      commandPolicy: agentCommandPolicy,
      onCommandBlocked: (reason) => this.runtime.commandBlocked(reason),
      onConfigOutsideRoot: (message, outsidePath, command) =>
        this.runtime.verifyCommandOutsideRoot(message, outsidePath, command),
      requestApproval: (command, context) => this.runtime.requestCommandApproval(config, command, context),
      onRoute: (line) => this.runtime.routeNotice(config, line),
      claims: this.runtime.taskClaims(),
      taskInputResolver: resolver,
      approveCoordinatorBriefEgress: (coordinatorId, targetAgentId) => {
        const coordinator = this.runtime.configForAgent(coordinatorId);
        const target = this.runtime.configForAgent(targetAgentId);
        if (!coordinator || !target || !this.runtime.approveCoordinatorBriefEgress) {
          return Promise.resolve({
            allowed: false,
            reason: 'The host could not resolve the coordinator and worker destinations for brief consent; no attempt was created.',
          });
        }
        return this.runtime.approveCoordinatorBriefEgress(coordinator, target);
      },
      escalate: (agentId) => this.runtime.escalateToFallback(agentId),
      evidenceEnabled: true,
      waitForTaskAdmission: true,
      admitCoordinatorAttempt: (attempt) => this.runtime.admitCoordinatorAttempt(
        attempt,
        this.runtime.effectiveExecutionIdentity(config.id),
      ),
      onDelegationDispatched: (event) => this.evidence.recordDispatched(event, config),
      onDelegationRefused: (event) => this.evidence.recordRefused(event, config),
      onDelegationEvidence: (event) => this.evidence.recordEvidence(event),
      onDelegationDisposition: (event) => {
        this.evidence.recordDisposition(event);
        if (event.disposition === 'needs-human') {
          const runId = this.evidence.runIdForDelegation(event.handle);
          if (runId) { this.evidence.openHumanReview(runId); }
        }
      },
      cancelDelegatedWorker: (event) => this.runtime.cancelDelegatedWorker(event),
      stopTeammate: (agentId, reason) => this.runtime.stopTeammate(config.id, agentId, reason),
      onDelegationCancelled: (event) => this.evidence.recordCancelled(event),
      onDelegationEmptyOutcome: (event) => this.evidence.recordEmptyOutcome(event),
      onAsyncResultReady: (result) => {
        this.runtime.queueAsyncDelegationWake(
          config.id,
          result,
          () => toolRef.current?.isAsyncResultReady(result.handle) ?? false,
          () => toolRef.current?.consumeAsyncResult(result.handle) ?? false,
        );
        this.evidence.refreshAfterAsyncResult();
      },
      recoveredAsyncResults: this.runtime.recoveredAsyncResults(config.id),
      onAsyncResultRetained: (result) => {
        this.runtime.retainAsyncResult(config.id, result);
        this.evidence.recordDeliveryPending(result.handle);
      },
      onAsyncResultConsumed: (handle) => this.runtime.consumeAsyncResult(config.id, handle),
      onAsyncResultDelivered: (handle, via) => this.evidence.recordDeliveryDelivered(handle, via),
      inspectTaskStatus: (handles) => this.evidence.inspectTaskStatus(config.id, handles),
    });
    toolRef.current = tools;
    return tools;
  }

  /** The TeamTools routing view and its task-scope admission share the same host authority. */
  makeTeamView(): TeamView {
    return {
      list: () => this.runtime.teamEntries(),
      resolve: (ref) => this.runtime.resolveTeam(ref),
      preflightTaskScope: (agentId, scope) => {
        const config = this.runtime.configForAgent(agentId);
        return config
          ? this.resolveTaskWorkspaceAccess(config, scope).reason
          : `Agent ${agentId} is no longer available.`;
      },
    };
  }

  /**
   * A requested task scope is a ceiling over the agent's configured authority, never a replacement grant.
   * This is the only host policy that admits a task-scoped folder access request.
   */
  resolveTaskWorkspaceAccess(
    config: AgentConfig,
    scope: DelegationTaskScope | undefined,
  ): { access?: TaskWorkspaceAccess; reason?: string } {
    if (!scope || !Array.isArray(scope.folderAccess) || scope.folderAccess.length === 0) {
      return { reason: 'Task-scoped folder access must name at least one folder.' };
    }
    const kind = this.runtime.backendKindFor(config);
    if (kind !== 'openai-compat') {
      return {
        reason: `Task-scoped folder access is currently enforced only for OpenAI-compatible agents; ${config.name} runs on a native CLI backend that cannot change its filesystem boundary per turn, so the assignment was not started. Re-dispatch it without a task scope, or assign it to an OpenAI-compatible agent.`,
      };
    }
    if (scope.folderAccess.some((grant) =>
      !grant || typeof grant.path !== 'string' || !grant.path.trim() ||
      (grant.permission !== 'read' && grant.permission !== 'readwrite')
    )) {
      return { reason: 'Task-scoped folder access must contain non-empty paths with permission "read" or "readwrite".' };
    }

    const workspace = this.runtime.workspace();
    const primaryRoot = config.workingDirectory || workspace.root();
    const rootOptions = {
      fallbackPrimaryRoot: primaryRoot,
      fallbackReadRoots: this.readRootsForAgent(primaryRoot),
      workspaceRoots: workspace.roots(),
      isTrusted: workspace.isTrusted(),
    };
    const configured = resolveEffectiveRoots({ ...rootOptions, grants: config.folderAccess });
    const requested = resolveEffectiveRoots({ ...rootOptions, grants: scope.folderAccess });
    if (requested.issues.length > 0) {
      return { reason: `Task-scoped folder access was rejected: ${requested.issues.map((issue) => issue.message).join('; ')}` };
    }

    const access = intersectTaskWorkspaceAccess(configured, requested, workspace.isTrusted(), primaryRoot);
    if (!access) {
      return { reason: 'Task-scoped folder access shares no readable folder with this agent\'s configured Folder Access. The assignment was not started.' };
    }
    return { access };
  }

  readRootsForAgent(primaryRoot: string): string[] {
    const workspace = this.runtime.workspace();
    return normalizeAgentReadRoots(
      primaryRoot,
      [...workspace.roots()],
      [...workspace.additionalReadRoots()],
      workspace.isTrusted(),
    );
  }

  /**
   * Open a host-recorded read_file receipt only after physical resolution and a current read-root check.
   * The webview never controls a filesystem path directly.
   */
  async openRecordedWorkspaceFile(agentId: string, filePath: string): Promise<void> {
    const config = this.runtime.configForAgent(agentId);
    if (!config || !filePath.trim()) {
      return;
    }
    const primaryRoot = config.workingDirectory || this.runtime.workspace().root();
    const roots = resolveEffectiveRoots({
      grants: config.folderAccess,
      fallbackPrimaryRoot: primaryRoot,
      fallbackReadRoots: this.readRootsForAgent(primaryRoot),
      workspaceRoots: this.runtime.workspace().roots(),
      isTrusted: this.runtime.workspace().isTrusted(),
    }).readRoots;
    const resolved = resolveRecordedFileForOpen(filePath, primaryRoot, roots, realpathSync);
    if (!resolved.ok && resolved.reason === 'missing') {
      this.runtime.warnUser('That file is no longer available at the path recorded by this receipt.');
      return;
    }
    if (!resolved.ok || !resolved.path) {
      this.runtime.warnUser('That file is not available inside this agent\'s current read folders.');
      return;
    }
    try {
      await this.runtime.openRecordedFile(resolved.path);
    } catch {
      this.runtime.warnUser('VS Code could not open the file recorded by this receipt.');
    }
  }
}

/**
 * Admit only current-turn non-rebuildable user sources to the host-owned asset store. Returned
 * descriptors contain ids and bounded metadata only; raw text and bytes never enter task.assign.
 */
export async function admitDelegationContentSources(
  store: ContentAssetStore,
  manifestSources: readonly ContextManifestSource[],
  pdfs: readonly UserAttachment[],
  images: readonly UserAttachment[],
): Promise<DelegationContentSource[]> {
  const sources: DelegationContentSource[] = [];
  for (const source of manifestSources) {
    if ((source.kind !== 'user-request' && source.kind !== 'context-mention' && source.kind !== 'user-attachment') ||
        typeof source.text !== 'string' || !source.text.trim()) {
      continue;
    }
    let stored: Awaited<ReturnType<ContentAssetStore['storeText']>>;
    try {
      stored = await store.storeText(source.text, 'turn-supplied');
    } catch {
      continue;
    }
    if ('error' in stored) { continue; }
    sources.push({
      assetId: stored.assetId,
      kind: source.kind,
      label: source.label,
      location: source.location,
      textBytes: stored.byteLength,
      mediaKind: 'text',
    });
  }
  for (const attachment of pdfs) {
    let stored: Awaited<ReturnType<ContentAssetStore['storePdf']>>;
    try {
      stored = await store.storePdf(Buffer.from(attachment.dataBase64, 'base64'), 'user-attachment', attachment.mime);
    } catch {
      continue;
    }
    if ('error' in stored) { continue; }
    sources.push({
      assetId: stored.assetId,
      kind: 'user-attachment',
      label: attachment.name,
      location: 'user PDF attachment',
      bytes: stored.byteLength,
      mediaKind: 'pdf',
    });
  }
  for (const attachment of images) {
    let stored: Awaited<ReturnType<ContentAssetStore['storeImage']>>;
    try {
      stored = await store.storeImage(Buffer.from(attachment.dataBase64, 'base64'), 'user-attachment', attachment.mime);
    } catch {
      continue;
    }
    if ('error' in stored) { continue; }
    sources.push({
      assetId: stored.assetId,
      kind: 'user-attachment',
      label: attachment.name,
      location: 'user image attachment',
      bytes: stored.byteLength,
      mediaKind: 'image',
    });
  }
  return sources;
}
