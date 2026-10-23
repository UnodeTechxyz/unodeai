/*---------------------------------------------------------------------------------------------
 *  Orchestration host boundary
 *
 *  The extension composition root supplies two ports: one owns a coordinator's live runtime,
 *  the other records the facts that runtime observes. This module deliberately imports no VS Code
 *  API, so the authority paths can be exercised without activating an extension host.
 *--------------------------------------------------------------------------------------------*/

import { realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { formatUserTextAttachments } from '../../attachments';
import { MessageBus } from '../../bus/MessageBus';
import { AgentCommandPolicy } from '../../backend/AgentCommandPolicy';
import { TaskClaimRegistry } from '../../backend/TaskClaimRegistry';
import {
  AsyncDelegationResult,
  CoordinatorTaskStatus,
  DelegationCancellationEvent,
  DelegationDispatchEvent,
  DelegationExecutionObservation,
  DelegationInterruptionEvent,
  DelegationDispositionEvent,
  DelegationEmptyOutcomeEvent,
  DelegationReworkReplyEvent,
  DispatchTurnOrigin,
  FirstActionTeamTool,
  RefusedDispatchEvent,
  TeamRosterEntry,
  TeamTools,
  TeamToolsOptions,
  TeamView,
  TurnDelegationReceipt,
  candidateSnapshot,
} from '../../backend/TeamTools';
import { TaskInputResolver } from '../../backend/TaskContract';
import { intersectTaskWorkspaceAccess, readablePathCeilings, resolveEffectiveRoots } from '../../backend/folderAccess';
import { normalizeAgentReadRoots } from '../../backend/readRoots';
import { resolveFileForOpen, resolveRecordedFileForOpen, type FileOpenRefusal } from '../../views/toolReceipt';
import { classifyLinkDestination, type ChatFileLinkReference, type FileLinkPosition, type FileNavigationRefusal } from '../../views/fileLinks';
import { isPathInsideOrEqual } from '../../backend/pathContainment';
import { AgentConfig, DelegationTaskScope, TaskWorkspaceAccess, UserAttachment } from '../../types';
import { ContextManifestSource, DelegationContentSource } from '../../session/TurnContextManifest';
import { splitUserAttachments } from '../../attachments';
import type { EffectiveExecutionIdentity } from '../../session/EffectiveExecutionIdentity';
import type { TaskAttemptCard } from '../../backend/TaskContract';
import type { ReviewPolicyPreflightDecision } from '../../policy/ReviewPolicyPreflight';
import type { CheckpointProgressSnapshot } from '../../session/TaskCheckpointProgress';

type DelegationEvidenceEvent = Parameters<NonNullable<TeamToolsOptions['onDelegationEvidence']>>[0];

/** Facts supplied by the extension host, not a model, about the current workspace. */
export interface OrchestrationWorkspaceAuthority {
  root(): string;
  roots(): readonly string[];
  isTrusted(): boolean;
  additionalReadRoots(): readonly string[];
  /** v0.9.97: false in a remote window or with a virtual workspace folder; a chat file link then opens nothing. */
  allFoldersLocal?(): boolean;
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
  /** v0.9.97: the host's view of the one execution that carries a delegation handle on a teammate. */
  delegationExecution?(agentId: string, handle: string): DelegationExecutionObservation;
  /** v0.9.97: how far that execution, when it delivers in batches, is from its last saved batch. */
  delegationWorkProgress?(agentId: string, handle: string): CheckpointProgressSnapshot | undefined;
  queueAsyncDelegationWake(
    coordinatorId: string,
    result: AsyncDelegationResult,
    isReady: () => boolean,
    consume: () => boolean,
  ): boolean;
  recoveredAsyncResults(coordinatorId: string): readonly AsyncDelegationResult[];
  retainAsyncResult(coordinatorId: string, result: AsyncDelegationResult): void;
  consumeAsyncResult(coordinatorId: string, handle: string): void;
  warnUser(message: string): void;
  /** Render a host notice in the coordinator's chat, not as coordinator-authored assistant text. */
  publishCoordinatorNotice?(coordinatorId: string, text: string): void;
  /**
   * A turn's dispatch receipt changed after that turn ended. The typed counts patch the footer of the reply they
   * belong to; they are never posted as a new chat item.
   */
  publishDelegationReceiptChange?(coordinatorId: string, receipt: TurnDelegationReceipt): void;
  /**
   * v0.9.93: the turn this coordinator is running now: its thread and its id. Asked when a dispatch call runs,
   * so that a receipt published after the turn has ended still names the turn that issued the dispatch.
   */
  turnOrigin?(coordinatorId: string): DispatchTurnOrigin | undefined;
  /**
   * v0.9.93: a dispatch or `close_assignment` call of this coordinator reached the host, from the backend launch
   * `launchId` names. False means the host already ended that launch or the attempt the call belongs to; the call
   * then runs nothing.
   */
  firstActionCallArrived?(coordinatorId: string, launchId: string, tool: FirstActionTeamTool): boolean;
  /** The host's answer to a call `firstActionCallArrived` let through. */
  firstActionCallAnswered?(coordinatorId: string, launchId: string, tool: FirstActionTeamTool, accepted: boolean): void;
  /** Open a checked file in the editor, at `position` (1-based, clamped to the document) when one is given. */
  openRecordedFile(path: string, position?: FileLinkPosition): Promise<void>;
  /**
   * v0.9.97: a chat file navigation did not open what was asked. The notice offers to copy the reference as it was
   * written, which changes nothing. A host without it shows the plain warning.
   */
  warnFileNavigation?(message: string, reference: string): void;
  /** v0.9.97: the user chooses which of a reply's folders a relative link is read against; undefined is no choice. */
  pickFileLinkFolder?(folders: readonly string[], reference: string): Promise<string | undefined>;
}

/** v0.9.97: what a chat surface says when it found nothing to open, the same on the sidebar and in the Workbench. */
const FILE_NAVIGATION_REFUSALS: Record<FileNavigationRefusal, string> = {
  'not-shown': 'That link is in a conversation this chat does not show now. Open that agent\'s conversation and click it there.',
  'unknown-link': 'This file link is no longer in the conversation UnodeAi keeps, so nothing was opened. Ask the agent for the file again.',
  'unknown-receipt': 'This receipt is no longer in the conversation UnodeAi keeps, so its file was not opened.',
  'changed': 'The conversation shown changed before the file could open, so nothing was opened. Click the link again.',
};

/** A reference as a notice names it: as written, and bounded. */
function shownReference(reference: string): string {
  return reference.length > 120 ? `${reference.slice(0, 117)}...` : reference;
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
  /** Returns the host-authored notice to show only for a genuinely late rework reply. */
  recordLateReworkReply(event: DelegationReworkReplyEvent): string | undefined;
  recordCancelled(event: DelegationCancellationEvent): void;
  recordInterrupted(event: DelegationInterruptionEvent): void;
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
 * Whose calls a coordinator's team tools take. Tools built for a backend name the launch of that backend, so the
 * session can tell a call of the process it runs now from a call of one it has ended or replaced. Tools the host
 * builds for an action of its own belong to no launch and are no provider's attempt.
 */
export type CoordinatorToolsCaller = { launchId: string } | 'host';

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
    // Do not resolve the root during extension activation: a no-folder editor window is a valid idle
    // state. TaskInputResolver evaluates this only when an assignment is attempted and then refuses if
    // the host still has no workspace, so it never invents a process-directory target.
    this.taskInputResolver = new TaskInputResolver(store, () => this.runtime.workspace().root());
    return this.taskInputResolver;
  }

  /** Build a coordinator's TeamTools surface from the two named host ports. */
  createCoordinatorTeamTools(
    config: AgentConfig,
    caller: CoordinatorToolsCaller,
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
      onDelegationReworkReply: (event) => {
        // This is the explicit fallback: the regular path queued an async-result PM turn, but the host
        // could not accept that wake (for example, Stop removed the PM backend).
        const notice = this.evidence.recordLateReworkReply(event);
        if (notice) this.runtime.publishCoordinatorNotice?.(config.id, notice);
      },
      cancelDelegatedWorker: (event) => this.runtime.cancelDelegatedWorker(event),
      stopTeammate: (agentId, reason) => this.runtime.stopTeammate(config.id, agentId, reason),
      onDelegationCancelled: (event) => this.evidence.recordCancelled(event),
      onDelegationInterrupted: (event) => this.evidence.recordInterrupted(event),
      onDelegationEmptyOutcome: (event) => this.evidence.recordEmptyOutcome(event),
      onTurnDelegationReceiptChanged: (event) => this.runtime.publishDelegationReceiptChange?.(config.id, event),
      turnOrigin: () => this.runtime.turnOrigin?.(config.id),
      onAsyncResultReady: (result) => {
        const queued = this.runtime.queueAsyncDelegationWake(
          config.id,
          result,
          () => toolRef.current?.isAsyncResultReady(result.handle) ?? false,
          () => toolRef.current?.consumeAsyncResult(result.handle) ?? false,
        );
        this.evidence.refreshAfterAsyncResult();
        return queued;
      },
      recoveredAsyncResults: this.runtime.recoveredAsyncResults(config.id),
      onAsyncResultRetained: (result) => {
        this.runtime.retainAsyncResult(config.id, result);
        this.evidence.recordDeliveryPending(result.handle);
      },
      onAsyncResultConsumed: (handle) => this.runtime.consumeAsyncResult(config.id, handle),
      onAsyncResultDelivered: (handle, via) => this.evidence.recordDeliveryDelivered(handle, via),
      inspectTaskStatus: (handles) => this.evidence.inspectTaskStatus(config.id, handles),
      // Every call names the launch these tools were built for. A standalone host without the gate lets every
      // call through, as before, and the host's own use of the tools is not gated: it is no provider's attempt.
      firstAction: caller === 'host' ? undefined : {
        arrived: (tool) => this.runtime.firstActionCallArrived?.(config.id, caller.launchId, tool) ?? true,
        answered: (tool, accepted) =>
          this.runtime.firstActionCallAnswered?.(config.id, caller.launchId, tool, accepted),
      },
    });
    toolRef.current = tools;
    return tools;
  }

  /**
   * The candidate set of a coordinator's top-level request, built from the roster as it is now. A request that is
   * started again gets a new one.
   */
  candidateSnapshot(config: AgentConfig): string | undefined {
    return candidateSnapshot(this.runtime.teamEntries(), config.id);
  }

  /** The TeamTools routing view and its task-scope admission share the same host authority. */
  makeTeamView(): TeamView {
    const delegationExecution = this.runtime.delegationExecution?.bind(this.runtime);
    const delegationWorkProgress = this.runtime.delegationWorkProgress?.bind(this.runtime);
    return {
      list: () => this.runtime.teamEntries(),
      resolve: (ref) => this.runtime.resolveTeam(ref),
      ...(delegationExecution ? { execution: (agentId: string, handle: string) => delegationExecution(agentId, handle) } : {}),
      ...(delegationWorkProgress
        ? { workProgress: (agentId: string, handle: string) => delegationWorkProgress(agentId, handle) }
        : {}),
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
      return { reason: 'Task-scoped folder access must name at least one folder or file.' };
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
      return { reason: 'Task-scoped folder access shares no readable folder or file with this agent\'s configured Folder Access. The assignment was not started.' };
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
      this.refuseFileNavigation('unknown-receipt');
      return;
    }
    const roots = this.readCeilingsFor(config);
    if (!roots) {
      this.warnFileNavigation('Open a workspace folder to open files from the chat.', filePath);
      return;
    }
    const primaryRoot = config.workingDirectory || this.runtime.workspace().root();
    const resolved = resolveRecordedFileForOpen(filePath, primaryRoot, roots, realpathSync, statSync);
    await this.openResolvedFile(resolved, filePath);
  }

  /**
   * v0.9.97: the folders a reply's relative file links are read against, recorded when the reply is written. That
   * is the agent's own working folder when the host knows it: a worktree, a folder the user set, or the only
   * workspace folder. Binding a multi-root workspace to its first folder by default is not that knowledge, so such
   * a reply records every folder, and the user chooses one when a link needs it.
   */
  fileLinkRoots(agentId: string, runtimeWorkingDirectory?: string): string[] {
    const config = this.runtime.configForAgent(agentId);
    const folders = [...this.runtime.workspace().roots()];
    const cwd = runtimeWorkingDirectory || config?.workingDirectory;
    if (cwd && path.isAbsolute(cwd)) {
      const defaultBinding = !config?.workingDirectory && folders.length > 1
        && folders.some((folder) => path.relative(path.resolve(folder), path.resolve(cwd)) === '');
      if (!defaultBinding) return [path.resolve(cwd)];
    }
    return folders;
  }

  /**
   * v0.9.97 (FOPEN-N1): the agent's current read ceiling, recorded with a reply as its links' message-time open
   * scope. Narrowing it later revokes an old link; widening it does not open one. Undefined when the agent is gone
   * or the window has no workspace folder to anchor a ceiling, in which case the reply records no scope.
   *
   * FOPEN-RC-N1: each ceiling is recorded as its real path now, so a junction or symlink pointed elsewhere later
   * does not move an old reply's scope. A ceiling whose real path cannot be read is left out: it grants nothing.
   */
  fileLinkCeilings(agentId: string): string[] | undefined {
    const config = this.runtime.configForAgent(agentId);
    const ceilings = config ? this.readCeilingsFor(config) : undefined;
    if (!ceilings) return undefined;
    const physical = new Set<string>();
    for (const ceiling of ceilings) {
      try {
        physical.add(realpathSync(ceiling));
      } catch {
        // No physical identity, no authority.
      }
    }
    return [...physical];
  }

  /** v0.9.97: a chat surface found nothing to open. Every refusal is shown; none is a silent return. */
  refuseFileNavigation(reason: FileNavigationRefusal): void {
    this.runtime.warnUser(FILE_NAVIGATION_REFUSALS[reason]);
  }

  /**
   * v0.9.97: open a file link of a reply, after the chat host found the reply and the link again in what it keeps.
   *
   * The destination is read again under the host's path rules. A relative path is read against a folder recorded
   * with the reply, never against the agent's folder of today; with several recorded folders the user chooses one
   * and nothing is guessed. After that choice the link must still be shown. From there to the editor nothing waits:
   * the agent, its current read folders and the file (real path, regular file) are checked as they are now.
   */
  async openFileReference(agentId: string, reference: ChatFileLinkReference): Promise<void> {
    const written = reference.destination;
    if (this.runtime.workspace().allFoldersLocal?.() === false) {
      this.warnFileNavigation('Chat file links open only in a local window whose workspace folders are on this computer; a remote window or a virtual folder is not supported yet.', written);
      return;
    }
    const target = classifyLinkDestination(written);
    if (target.kind !== 'file') {
      this.warnFileNavigation(`UnodeAi does not open "${shownReference(written)}": it is not a path on this computer.`, written);
      return;
    }
    let candidate: string;
    if (target.absolute) {
      candidate = path.resolve(target.path);
    } else {
      const folders = reference.roots ?? this.runtime.workspace().roots();
      let base: string | undefined;
      if (folders.length === 1) {
        base = folders[0];
      } else if (folders.length > 1) {
        if (!this.runtime.pickFileLinkFolder) {
          this.warnFileNavigation(`"${shownReference(written)}" could be in more than one workspace folder, and UnodeAi does not guess which.`, written);
          return;
        }
        const chosen = await this.runtime.pickFileLinkFolder(folders, written);
        if (!chosen || !folders.includes(chosen)) {
          this.warnFileNavigation(`No folder was chosen for "${shownReference(written)}", so nothing was opened.`, written);
          return;
        }
        base = chosen;
      }
      if (!base) {
        this.warnFileNavigation(`"${shownReference(written)}" is a relative path, and this reply has no workspace folder to read it against.`, written);
        return;
      }
      candidate = path.resolve(base, target.path);
      // The destination holds no `..` segment, so this holds; it is checked rather than assumed.
      if (!isPathInsideOrEqual(base, candidate)) {
        this.warnFileNavigation(this.openRefusalText('outside-read-roots', written), written);
        return;
      }
    }
    if (!reference.stillShown()) {
      this.refuseFileNavigation('changed');
      return;
    }
    const config = this.runtime.configForAgent(agentId);
    if (!config) {
      this.warnFileNavigation(`The agent that wrote "${shownReference(written)}" no longer exists, so its read folders cannot be checked.`, written);
      return;
    }
    const roots = this.readCeilingsFor(config);
    if (!roots) {
      this.warnFileNavigation('Open a workspace folder to open files from the chat.', written);
      return;
    }
    const resolved = resolveFileForOpen(candidate, roots, { realpath: realpathSync, stat: statSync });
    // FOPEN-N1: the physical target must also be inside the read ceiling the agent had WHEN the reply was written,
    // recorded with it. A later widening of the agent's scope must not open an old link; a narrowing already
    // revoked it through the current-ceiling check above. A reply with no recorded ceiling grants nothing.
    if (resolved.ok && resolved.path !== undefined && !this.withinMessageTimeCeiling(reference, resolved.path)) {
      this.warnFileNavigation(this.messageScopeRefusalText(written), written);
      return;
    }
    await this.openResolvedFile(resolved, written, target.position, target.unsupportedFragment);
  }

  /**
   * FOPEN-N1: true when the physical target is inside the read ceiling recorded with the reply (its message-time
   * scope). A reply with no recorded ceiling returns false — its message-time authority cannot be proven, so it
   * opens nothing (an imported or pre-0.9.97 reply has no recorded scope and is fail-closed here).
   *
   * FOPEN-RC-N1: the recorded ceilings are real paths from when the reply was written (`fileLinkCeilings`). They are
   * compared as recorded and never resolved again, so they cannot take on what a link points to now.
   */
  private withinMessageTimeCeiling(reference: ChatFileLinkReference, physicalPath: string): boolean {
    const ceilings = reference.ceilings;
    if (!ceilings || ceilings.length === 0) {
      return false;
    }
    return ceilings.some((physicalRoot) => isPathInsideOrEqual(physicalRoot, physicalPath));
  }

  private messageScopeRefusalText(written: string): string {
    return `"${shownReference(written)}" is outside the read folders the agent had when it wrote this reply, so UnodeAi did not open it. A later change to the agent's folders does not open an old link.`;
  }

  /** The current read ceilings of an agent, or undefined when the window has no workspace folder to anchor them. */
  private readCeilingsFor(config: AgentConfig): string[] | undefined {
    let primaryRoot: string;
    try {
      primaryRoot = config.workingDirectory || this.runtime.workspace().root();
    } catch {
      return undefined;
    }
    return readablePathCeilings(resolveEffectiveRoots({
      grants: config.folderAccess,
      fallbackPrimaryRoot: primaryRoot,
      fallbackReadRoots: this.readRootsForAgent(primaryRoot),
      workspaceRoots: this.runtime.workspace().roots(),
      isTrusted: this.runtime.workspace().isTrusted(),
    }));
  }

  /** Opens what the synchronous check admitted, at once; otherwise says why, with the reference to copy. */
  private async openResolvedFile(
    resolved: ReturnType<typeof resolveFileForOpen>,
    written: string,
    position?: FileLinkPosition,
    unsupportedFragment?: string,
  ): Promise<void> {
    if (!resolved.ok || !resolved.path) {
      this.warnFileNavigation(this.openRefusalText(resolved.reason ?? 'missing', written), written);
      return;
    }
    try {
      await this.runtime.openRecordedFile(resolved.path, position);
    } catch {
      this.warnFileNavigation(`VS Code could not open "${shownReference(written)}".`, written);
      return;
    }
    if (unsupportedFragment !== undefined) {
      this.warnFileNavigation(
        `Opened "${shownReference(written)}" at its start: "#${unsupportedFragment}" is not a line, and UnodeAi goes only to #L12 or :12.`,
        written,
      );
    }
  }

  private openRefusalText(reason: FileOpenRefusal, written: string): string {
    const shown = shownReference(written);
    switch (reason) {
      case 'missing': return `"${shown}" does not exist. It may have been moved, renamed or deleted.`;
      case 'outside-read-roots': return `"${shown}" is outside this agent's current read folders, so UnodeAi did not open it.`;
      case 'directory': return `"${shown}" is a directory. Opening a directory from the chat is not supported yet.`;
      case 'not-regular': return `"${shown}" is not a regular file, so UnodeAi did not open it.`;
      case 'unreadable': return `UnodeAi could not check "${shown}": access was denied.`;
    }
  }

  private warnFileNavigation(message: string, reference: string): void {
    if (this.runtime.warnFileNavigation) {
      this.runtime.warnFileNavigation(message, reference);
    } else {
      this.runtime.warnUser(message);
    }
  }
}

/**
 * The context sources of one chat turn as the user sent it: what its manifest lists at dispatch, and what a
 * coordinator may forward. The request and its @ appendix are listed at dispatch. The attachments are not: the
 * route that runs the turn reports which of them its payload carried, and only those join the manifest (v0.9.97).
 * Their forwarding copies are admitted from the attachments themselves, each as a user attachment with its exact
 * bytes (what `save_attachment` writes); the request and its @ appendix are admitted as turn-supplied text.
 */
export async function userTurnSources(
  store: ContentAssetStore,
  turn: { text: string; expanded: string; mentions: readonly string[]; userAttachments: readonly UserAttachment[] | undefined },
): Promise<{ contextManifestSources: ContextManifestSource[]; delegationContentSources: DelegationContentSource[] }> {
  const contextManifestSources: ContextManifestSource[] = [{
    kind: 'user-request',
    label: 'Current task',
    location: 'chat composer',
    text: turn.text,
    reason: 'user-entered task',
  }];
  // Mention expansion appends resolved material after the original text. Record that exact appendix
  // without changing the string handed to the backend.
  const appendix = turn.expanded.startsWith(turn.text) ? turn.expanded.slice(turn.text.length) : '';
  if (appendix.trim() && turn.mentions.length > 0) {
    contextManifestSources.push({
      kind: 'context-mention',
      label: `Explicit @ context (${turn.mentions.length})`,
      location: turn.mentions.map((mention) => `@${mention}`).join(', '),
      text: appendix,
      reason: 'user @file/@folder/@problems/@url request',
    });
  }
  const attachmentParts = splitUserAttachments(turn.userAttachments);
  const delegationContentSources = await admitDelegationContentSources(
    store,
    contextManifestSources,
    attachmentParts.textFiles,
    attachmentParts.pdfs,
    attachmentParts.images,
  );
  return { contextManifestSources, delegationContentSources };
}

/**
 * Admit only current-turn non-rebuildable user sources to the host-owned asset store. Returned
 * descriptors contain ids and bounded metadata only; raw text and bytes never enter task.assign.
 *
 * v0.9.97: a file the user attached is admitted from the attachment itself, as a user attachment with its exact
 * bytes (what `save_attachment` writes); a text file's readers get the same formatted text as before. The request
 * and its @ appendix stay turn-supplied text. Nothing else becomes a user attachment: the manifest's own entries for
 * text attachments are formatted copies of these files, so they are not stored a second time.
 */
export async function admitDelegationContentSources(
  store: ContentAssetStore,
  manifestSources: readonly ContextManifestSource[],
  textFiles: readonly UserAttachment[],
  pdfs: readonly UserAttachment[],
  images: readonly UserAttachment[],
): Promise<DelegationContentSource[]> {
  const sources: DelegationContentSource[] = [];
  for (const source of manifestSources) {
    if ((source.kind !== 'user-request' && source.kind !== 'context-mention') ||
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
  for (const attachment of textFiles) {
    const text = formatUserTextAttachments([attachment]);
    if (!text) { continue; }
    const bytes = Buffer.from(attachment.dataBase64, 'base64');
    let stored: Awaited<ReturnType<ContentAssetStore['storeTextAttachment']>>;
    try {
      stored = await store.storeTextAttachment(bytes, text);
    } catch {
      continue;
    }
    if ('error' in stored) { continue; }
    sources.push({
      assetId: stored.assetId,
      kind: 'user-attachment',
      label: attachment.name,
      location: 'user text attachment',
      textBytes: stored.byteLength,
      bytes: bytes.byteLength,
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
