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
import { storedTextAttachmentSource } from '../../attachments';
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
  FindingRefResolution,
  FirstActionTeamTool,
  RefusedDispatchEvent,
  ReworkContinueOutcome,
  TeamRosterEntry,
  TeamTools,
  TeamToolsOptions,
  TeamView,
  TurnDelegationReceipt,
  UndecidedReviewFinding,
  candidateSnapshot,
} from '../../backend/TeamTools';
import { TaskInputResolver, type OutsideCurrentRead, type OutsideInputAccess, type OutsideOutputAccess } from '../../backend/TaskContract';
import { intersectTaskWorkspaceAccess, readablePathCeilings, resolveEffectiveRoots, samePath,
  type ResolvedWorkspaceScope } from '../../backend/folderAccess';
import { normalizeAgentReadRoots } from '../../backend/readRoots';
import { fullAccessTargetRoot } from '../../backend/FullFileAccess';
import { resolveFileForOpen, resolveRecordedFileForOpen, type FileOpenRefusal } from '../../views/toolReceipt';
import {
  classifyLinkDestination, type ChatFileLinkReference, type FileLinkAction, type FileLinkPosition, type FileNavigationRefusal,
} from '../../views/fileLinks';
import { FileNotOpenedAsText } from '../fileNotOpenedAsText';
import { isPathInsideOrEqual } from '../../backend/pathContainment';
import { matchPathAccess, type SessionPathAccessGrant } from '../../backend/localReadScope';
import { fileToolReachesAnotherComputer, heldBySpelling, reachesAnotherComputer } from '../namedOutsidePaths';
import { physicalPath, readRegularFileInsideRoot } from '../../backend/workspacePath';
import type { SourceCheck, SourceDigest } from '../../backend/DocumentDraftCustody';
import { hostReadMemoryBudget } from '../../content/ContentAssetStore';
import { createHash } from 'node:crypto';
import type { ResolvedFileGrant } from '../../types';
import { AgentConfig, DelegationTaskScope, TaskWorkspaceAccess, UserAttachment } from '../../types';
import { ContextManifestSource, DelegationContentSource } from '../../session/TurnContextManifest';
import { splitUserAttachments } from '../../attachments';
import type { EffectiveExecutionIdentity } from '../../session/EffectiveExecutionIdentity';
import type { TaskAttemptCard } from '../../backend/TaskContract';
import type { ReviewPolicyPreflightDecision } from '../../policy/ReviewPolicyPreflight';
import type { CheckpointProgressSnapshot } from '../../session/TaskCheckpointProgress';
import { accessNeedLabel, type AccessNeed, type TaskResumeAdmission } from '../TaskResumeRefs';
import type { AccessJudgement, NeedState } from '../AccessTable';

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
  /** Current confirmed base host policy; never read from a reply or suppressed by a task ceiling. */
  fullFileAccess?(config: AgentConfig): boolean;
  /** An explicit task suppresses broad navigation; task admission still intersects its declared scope with base policy. */
  taskScopeActive?(agentId: string): boolean;
  /** Actual admitted, origin-bound task ceiling, never reconstructed from a model declaration. */
  taskWorkspaceAccess?(agentId: string): TaskWorkspaceAccess | undefined;
  /** v0.9.100: the deliberate file grants the crew shares in this request: its own and the session's. A task scope may name what they cover. */
  pathGrantsFor?(requestId: string | undefined): readonly SessionPathAccessGrant[];
  /**
   * v0.9.100: offer the person the file grant for a path, in this agent's name, as a refused file tool does. Never a
   * question. v0.9.101: `access` is what the work needs of it, when the caller knows: Read + Write keeps a Read from
   * closing its item.
   */
  offerPathAccess?(agentId: string, target: string, access?: 'read' | 'readwrite', consumer?: { agentId: string; handle?: string }): void;
  /** v0.9.100: the scope a dispatched task was admitted with, for Activity to show. */
  noteAdmittedTaskScope?(handle: string, scope: string): void;
  /** The logical request of an agent's turn in progress, as the host recorded it. */
  currentRequestId?(agentId: string): string | undefined;
  /** v0.9.101 (G3): the host's single-use resume_refs for retrying a task that lacked file access. */
  taskResume?(): TaskResumeAdmission | undefined;
  effectiveExecutionIdentity(agentId: string): EffectiveExecutionIdentity | undefined;
  admitCoordinatorAttempt(attempt: TaskAttemptCard, identity?: EffectiveExecutionIdentity): ReviewPolicyPreflightDecision;
  backendKindFor(config: AgentConfig): string;
  commandPolicyFor(config: AgentConfig): AgentCommandPolicy;
  verifyCommandFor(config: AgentConfig): string;
  runVerification?(config: AgentConfig, launchId?: string): ReturnType<NonNullable<TeamToolsOptions['runVerification']>>;
  workingDirectoryFor(config: AgentConfig): string;
  requestCommandApproval(
    config: AgentConfig,
    ...request: Parameters<NonNullable<TeamToolsOptions['requestApproval']>>
  ): ReturnType<NonNullable<TeamToolsOptions['requestApproval']>>;
  routeNotice(config: AgentConfig, line: string): void;
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
  /** v0.9.103 slice 2 (G2): the coordinator's answer to one question of a teammate's live task (`reply_to_task`). */
  replyToTask?(coordinatorId: string, handle: string, exchangeId: string, text: string): { status: 'queued' | 'refused'; text: string };
  queueAsyncDelegationWake(
    coordinatorId: string,
    result: AsyncDelegationResult,
    isReady: () => boolean,
    consume: () => boolean,
  ): boolean;
  recoveredAsyncResults(coordinatorId: string): readonly AsyncDelegationResult[];
  retainAsyncResult(coordinatorId: string, result: AsyncDelegationResult): void;
  resultRevisionFor?(coordinatorId: string, handle: string): number | undefined;
  /** v0.9.106: the ledger's answer to a coordinator's finding references, made in a decision about `handle`. */
  resolveFindingRefs?(handle: string, refs: readonly string[], coordinatorId: string): FindingRefResolution;
  /** v0.9.106: the findings of a review's latest set that no decision of its request names yet. */
  undecidedReviewFindings?(handle: string, coordinatorId: string): readonly UndecidedReviewFinding[];
  consumeAsyncResult(coordinatorId: string, handle: string): void;
  prepareAsyncResultDelivery?(coordinatorId: string, handle: string, revision?: number): Promise<void>;
  resultDelivered?(coordinatorId: string, handle: string, via: 'auto-wake' | 'collect-ready' | 'blocking-tool', revision?: number): void;
  resultReworkStarted?(coordinatorId: string, handle: string): void;
  resultEligible?(coordinatorId: string, handle: string, revision?: number): boolean;
  resultCloseoutBlockers?(coordinatorId: string): ReturnType<NonNullable<TeamToolsOptions['resultCloseoutBlockers']>>;
  warnUser(message: string): void;
  /** Render a host notice in the coordinator's chat, not as coordinator-authored assistant text. */
  publishCoordinatorNotice?(coordinatorId: string, text: string): void;
  /** v0.9.99: the coordinator's `close_assignment` was recorded with this outcome; its PM status reads it. */
  assignmentClosed?(coordinatorId: string, outcome: string): void;
  /**
   * v0.9.99 (B14): a rework request was held at the automatic cap. The host tells the person; `continueRework`
   * sends the held request and returns false when nothing is held any more.
   */
  reworkHeld?(
    coordinatorId: string,
    held: { agentName: string; rounds: number },
    continueRework: () => ReworkContinueOutcome,
  ): void;
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
   * written, which changes nothing. A host without it shows the plain warning. v0.9.102: `reveal`, when given, is
   * offered too: the file was checked and is there, but opens neither in the editor nor in an app.
   */
  warnFileNavigation?(message: string, reference: string, reveal?: () => Promise<void>): void;
  /** v0.9.102: show a checked file in the system's file manager (File Explorer on Windows). */
  revealRecordedFile?(path: string): Promise<void>;
  /** v0.9.97: the user chooses which of a reply's folders a relative link is read against; undefined is no choice. */
  pickFileLinkFolder?(folders: readonly string[], reference: string): Promise<string | undefined>;
}

/**
 * v0.9.102: how one file navigation shows what it came to: beside the clicked link, or as a notification. With
 * `revealable`, the checked file is there but opens neither in the editor nor in an app, and revealing it is offered.
 * Revealing it later goes through the same boundary again, so it is checked as things are when it is clicked. The
 * promise settles once the result was shown, or its delivery failed and it was notified instead.
 */
type NavigationWarning = (message: string, revealable?: boolean) => Promise<void>;

/** v0.9.102: whether a chat surface showed a result; a delivery that failed or threw shows nothing. */
async function shownBeside<T>(report: (value: T) => boolean | Promise<boolean>, value: T): Promise<boolean> {
  try {
    return await report(value) === true;
  } catch {
    return false;
  }
}

/** v0.9.102: why opening or revealing failed, in the failing component's words, on one bounded line. */
function failureReason(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error ?? '')).replace(/\s+/g, ' ').trim()
    .replace(/[.。]$/, '');
  if (!text) return 'no reason was given';
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/** v0.9.97: what a chat surface says when it found nothing to open, the same on the sidebar and in the Workbench. */
const FILE_NAVIGATION_REFUSALS: Record<FileNavigationRefusal, string> = {
  'not-shown': 'That link is in a conversation this chat does not show now. Open that agent\'s conversation and click it there.',
  'unknown-link': 'This file link is no longer in the conversation UnodeAi keeps, so nothing was opened. Ask the agent for the file again.',
  'unknown-receipt': 'This receipt is no longer in the conversation UnodeAi keeps, so its file was not opened.',
  'changed': 'The conversation shown changed before the file could open, so nothing was opened. Click the link again.',
};

/** Host-only historical scope; impossible as a filesystem path, stripped by chat import/export with ceilings. */
const FULL_FILE_LINK_CEILING = '\0unode-full-file-access/v1';
const EXACT_FILE_LINK_CEILING = '\0unode-exact-file/v1:';

/** A reference as a notice names it: as written, and bounded. */
function shownReference(reference: string): string {
  return reference.length > 120 ? `${reference.slice(0, 117)}...` : reference;
}

/** v0.9.101 (T101-8): which of an agent's authorities reach an outside input: what `contractInputAccess` counted. */
interface OutsideReadReach {
  /** A configured read folder: the workspace's, Folder Access or a read root. */
  root: boolean;
  /** An exact file of the agent's own Folder Access. */
  file: boolean;
  /** Confirmed Full access. */
  full: boolean;
  /** A deliberate request or session grant, as the grant store holds it now. */
  grant: boolean;
}

/**
 * v0.9.101 (T101-8): the agent's own UnodeAi file tool that reads an outside `current` input during its task and checks,
 * at that read, an authority that reaches it. A host grant is never counted for a tool that does not check it, and a
 * native tool is never counted: a host grant is not native access (design §5.2).
 * - OpenAI-compatible: its file tools are the host's WorkspaceTools, given the read roots, the exact Folder Access
 *   files, Full access and the live grants (extension.ts, the engine options). Any of them is read under.
 * - Claude: the UnodeAi files bridge's read_file (ClaudeHeadlessBackend.prepareFilesBridge) has the read roots, Full
 *   access and the live grants, and no exact Folder Access files. Claude's native Read checks none of them.
 * - Codex: none. Its host read_file takes the read roots and Full access, but no live grant and no task attempt, so it
 *   records no read of the input; the route gets no task card naming the input; and its native reads are fixed when
 *   it starts and are not confined by host read roots. A snapshot the host takes delivers such an input instead.
 */
function outsideCurrentRead(backend: string, reach: OutsideReadReach): OutsideCurrentRead | undefined {
  if (backend === 'openai-compat') return 'host-file-tools';
  if (backend === 'claude') return reach.root || reach.full || reach.grant ? 'files-bridge' : undefined;
  return undefined;
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

  /** Recovery offers an existing result to the normal idle-wake lane; it never starts a worker. */
  offerRecoveredResults(coordinatorId: string, recovered?: readonly AsyncDelegationResult[]): void {
    for (const result of recovered ?? this.runtime.recoveredAsyncResults(coordinatorId)) {
      this.runtime.queueAsyncDelegationWake(coordinatorId, result,
        () => this.runtime.resultEligible?.(coordinatorId, result.handle, result.resultRevision) ?? false,
        () => {
          if (!this.runtime.resultEligible?.(coordinatorId, result.handle, result.resultRevision)) return false;
          this.runtime.resultDelivered?.(coordinatorId, result.handle, 'auto-wake', result.resultRevision);
          this.evidence.recordDeliveryDelivered(result.handle, 'auto-wake'); return true;
        });
    }
  }

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
      ...(this.runtime.runVerification ? { runVerification: () => this.runtime.runVerification!(config, caller === 'host' ? undefined : caller.launchId) } : {}),
      cwd: this.runtime.workingDirectoryFor(config),
      commandPolicy: agentCommandPolicy,
      // v0.9.106 (F-1): the line in the coordinator's chat is the one record of a blocked check; no toast repeats it.
      onCommandBlocked: (reason) => {
        this.runtime.publishCoordinatorNotice?.(config.id, reason);
      },
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
      onDelegationDispatched: (event) => {
        this.evidence.recordDispatched(event, config);
        const notice = this.outsideScopeNotice(event);
        if (notice) this.runtime.publishCoordinatorNotice?.(config.id, notice);
        const admitted = this.admittedScopeText(event);
        if (admitted) this.runtime.noteAdmittedTaskScope?.(event.handle, admitted);
      },
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
      onReworkHeld: (event) => this.runtime.reworkHeld?.(
        config.id,
        { agentName: this.runtime.configForAgent(event.agentId)?.name ?? event.agentId, rounds: event.rounds },
        () => toolRef.current?.continueHeldRework(event.handle, event.holdId) ?? 'decided',
      ),
      cancelDelegatedWorker: (event) => this.runtime.cancelDelegatedWorker(event),
      stopTeammate: (agentId, reason) => this.runtime.stopTeammate(config.id, agentId, reason),
      onDelegationCancelled: (event) => this.evidence.recordCancelled(event),
      onDelegationInterrupted: (event) => this.evidence.recordInterrupted(event),
      onDelegationEmptyOutcome: (event) => this.evidence.recordEmptyOutcome(event),
      onTurnDelegationReceiptChanged: (event) => this.runtime.publishDelegationReceiptChange?.(config.id, event),
      onAssignmentCloseout: (event) => this.runtime.assignmentClosed?.(config.id, event.outcome),
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
      resultRevisionFor: handle => this.runtime.resultRevisionFor?.(config.id, handle),
      ...(this.runtime.resolveFindingRefs ? { resolveFindingRefs: (handle: string, refs: readonly string[]) => this.runtime.resolveFindingRefs!(handle, refs, config.id) } : {}),
      ...(this.runtime.undecidedReviewFindings ? { undecidedReviewFindings: (handle: string) => this.runtime.undecidedReviewFindings!(handle, config.id) } : {}),
      onAsyncResultConsumed: (handle) => this.runtime.consumeAsyncResult(config.id, handle),
      onAsyncResultDelivered: (handle, via, revision) => {
        if (this.runtime.resultEligible && !this.runtime.resultEligible(config.id, handle, revision)) return;
        this.runtime.resultDelivered?.(config.id, handle, via, revision);
        this.evidence.recordDeliveryDelivered(handle, via);
      },
      prepareAsyncResultDelivery: this.runtime.prepareAsyncResultDelivery
        ? (handle, revision) => this.runtime.prepareAsyncResultDelivery!(config.id, handle, revision) : undefined,
      onResultReworkStarted: handle => this.runtime.resultReworkStarted?.(config.id, handle),
      isAsyncResultEligible: (handle, revision) => this.runtime.resultEligible?.(config.id, handle, revision) ?? true,
      resultCloseoutBlockers: () => this.runtime.resultCloseoutBlockers?.(config.id) ?? [],
      inspectTaskStatus: (handles) => this.evidence.inspectTaskStatus(config.id, handles),
      taskResume: this.runtime.taskResume?.(),
      ...(this.runtime.replyToTask
        ? { replyToTask: (handle: string, exchangeId: string, text: string) => this.runtime.replyToTask!(config.id, handle, exchangeId, text) }
        : {}),
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
      preflightTaskScope: (agentId, scope, dispatcherId) => {
        const config = this.runtime.configForAgent(agentId);
        return config
          ? this.resolveTaskWorkspaceAccess(config, scope, this.runtime.currentRequestId?.(dispatcherId)).reason
          : `Agent ${agentId} is no longer available.`;
      },
      offerTaskScopeAccess: (agentId, scope, dispatcherId) => {
        const config = this.runtime.configForAgent(agentId);
        if (!config) return;
        const { outOfReach } = this.resolveTaskWorkspaceAccess(config, scope, this.runtime.currentRequestId?.(dispatcherId));
        for (const target of outOfReach ?? []) this.runtime.offerPathAccess?.(dispatcherId, target);
      },
      taskScopeShortfall: (agentId, scope, dispatcherId) => {
        const config = this.runtime.configForAgent(agentId);
        if (!config) return [];
        const resolved = this.resolveTaskWorkspaceAccess(config, scope, this.runtime.currentRequestId?.(dispatcherId));
        return resolved.access ? resolved.outOfReach ?? [] : [];
      },
      contractInputAccess: (agentId, target, dispatcherId) => {
        const config = this.runtime.configForAgent(agentId);
        return config
          ? this.contractInputAccess(config, target, this.runtime.currentRequestId?.(dispatcherId))
          : { status: 'unavailable', detail: `agent ${agentId} is no longer available` };
      },
      offerInputAccess: (target, dispatcherId, access, consumer) => this.runtime.offerPathAccess?.(dispatcherId, target, access, consumer),
      contractOutputAccess: (agentId, target, dispatcherId) => {
        const config = this.runtime.configForAgent(agentId);
        return config
          ? this.contractOutputAccess(config, target, this.runtime.currentRequestId?.(dispatcherId))
          : { status: 'unavailable', detail: `agent ${agentId} is no longer available` };
      },
    };
  }

  /**
   * v0.9.101 (the access table's state rule, R1 §2.2 and R2 §1): one consumer's access to one target now, by the facts
   * admission uses: Read by `contractInputAccess`, Read + Write by `contractOutputAccess`, under the consumer's own reach
   * (its Folder Access, working folder, the workspace and its read roots, Full access, trust) and the grants of
   * `requestId` and of the session. `observed` is the target row's operative identity (R3): when given, it is the
   * physical path judged, so a link that now leads elsewhere is judged where it leads.
   * - Existence is not access: a file its authority reaches that is not there (yet) is `met`.
   * - `partial`: Read is reached and Read + Write is needed.
   * - `limit`: outside the agent's own Folder Access, which no grant widens.
   * - `granted` is what the person's own grants give; other reach is never reported as granted.
   */
  judgeAccess(config: AgentConfig, requestId: string | undefined, named: string, needed: 'read' | 'readwrite', observed?: string): AccessJudgement {
    const physical = (abs: string) => (observed ?? physicalPath(abs));
    const read = this.contractInputAccess(config, named, requestId, { physical, stat: statSync }).status;
    const reachedRead = read === 'readable' || read === 'missing-input';
    // v0.9.102 (field T2): `effective` is what the consumer reaches whatever this need asks, so an item can tell a
    // folder the agent can only read from one it can already write. The need's own state still reads only what it needs.
    const write = needed === 'readwrite' || reachedRead ? this.contractOutputAccess(config, named, requestId, physical).status : undefined;
    const reachedWrite = write === 'writable';
    const state: NeedState = (needed === 'read' ? read === 'explicit-limit' : write === 'explicit-limit') ? 'limit'
      : needed === 'read' ? (reachedRead ? 'met' : 'missing')
      : reachedWrite ? 'met' : reachedRead ? 'partial' : 'missing';
    const grants = config.folderAccess?.length ? [] : this.runtime.pathGrantsFor?.(requestId) ?? [];
    const writeGrant = grants.length ? matchPathAccess(grants, named, 'readwrite') : undefined;
    const readGrant = writeGrant ?? (grants.length ? matchPathAccess(grants, named, 'read') : undefined);
    const granted = writeGrant ? 'readwrite' as const : readGrant ? 'read' as const : 'none' as const;
    const effective = reachedWrite ? 'readwrite' as const : reachedRead ? 'read' as const : 'none' as const;
    const source = effective === 'none' ? 'none' as const
      : granted !== 'none' ? 'grant' as const
      : !config.folderAccess?.length && this.baseFullFileAccess(config) ? 'full' as const : 'configured' as const;
    return { state, effective, source, granted, grantIds: [...new Set([writeGrant, readGrant].flatMap((match) => match ? [match.grant.id] : []))] };
  }

  /**
   * v0.9.101 (H2a, H2b): whether the access one need of waiting work names is there for `config` in `requestId`, by the
   * access table's state rule (`judgeAccess`). `'limit'`: outside the agent's own Folder Access, which no grant widens.
   */
  accessNeedMet(config: AgentConfig, need: Pick<AccessNeed, 'target' | 'access'>, requestId: string | undefined): boolean | 'limit' {
    const state = this.judgeAccess(config, requestId, need.target, need.access).state;
    return state === 'limit' ? 'limit' : state === 'met';
  }

  /**
   * v0.9.101 (G1): whether an agent can write `target`, an outside file or folder a task contract names as an output, by
   * the facts `contractInputAccess` uses, for write: the agent's configured write reach, Full access, and the readwrite
   * grants of `requestId` and of the session. A read grant is not write. It grants nothing, and an output that is not
   * there yet is judged by what holds it. Folder Access is a ceiling, as for an input. A share, device or `/net` spelling
   * is judged by spelling alone until Full access, a readwrite Folder Access entry or a readwrite grant covers it.
   * `physical` exists so a test can see that no such check is made; the host passes none.
   */
  contractOutputAccess(
    config: AgentConfig,
    target: string,
    requestId: string | undefined,
    physical: (abs: string) => string = physicalPath,
  ): OutsideOutputAccess {
    if (!path.isAbsolute(target)) return { status: 'unavailable', detail: 'it is not a local path on this computer' };
    const lexical = path.resolve(target);
    const ceiling = config.folderAccess?.length ? config.folderAccess : undefined;
    const full = !ceiling && this.baseFullFileAccess(config);
    const grants = (ceiling ? [] : this.runtime.pathGrantsFor?.(requestId) ?? []).filter((grant) => grant.permission === 'readwrite');
    if (reachesAnotherComputer(lexical)) {
      const holds = (root: string) => isPathInsideOrEqual(root, lexical);
      const named = full
        || (ceiling ?? []).some((entry) => entry.permission === 'readwrite' && path.isAbsolute(entry.path) && holds(path.resolve(entry.path)))
        || grants.some(({ target: granted }) => granted.kind === 'file'
          ? samePath(granted.lexicalPath, lexical) || samePath(granted.realPath, lexical)
          : holds(granted.lexicalPath) || holds(granted.realPath));
      if (!named) return ceiling ? { status: 'explicit-limit', unprobed: true } : { status: 'grant-needed', unprobed: true };
    }
    let primaryRoot: string;
    try { primaryRoot = config.workingDirectory || this.runtime.workspace().root(); } catch {
      return { status: 'unavailable', detail: 'no workspace folder is open' };
    }
    const resolved = physical(lexical);
    const configured = resolveEffectiveRoots({
      grants: config.folderAccess,
      fallbackPrimaryRoot: primaryRoot,
      fallbackReadRoots: this.readRootsForAgent(primaryRoot),
      workspaceRoots: this.runtime.workspace().roots(),
      isTrusted: this.runtime.workspace().isTrusted(),
    });
    const reached = configured.writeRoots.some((root) => isPathInsideOrEqual(root, resolved))
      || configured.writeFiles.some((file) => samePath(file.realPath, resolved))
      || (full && !!fullAccessTargetRoot(resolved))
      || (grants.length > 0 && matchPathAccess(grants, lexical, 'readwrite') !== undefined);
    return reached ? { status: 'writable' } : { status: ceiling ? 'explicit-limit' : 'grant-needed' };
  }

  /**
   * v0.9.101 (A1): whether an agent can read `target`, an outside file a task contract names as an input, by the facts
   * the host already owns: the agent's configured reach (its Folder Access, or the workspace and its read folders),
   * Full access, and the deliberate grants of `requestId` and of the session. It grants nothing and adds no rule:
   * - Folder Access is a ceiling: outside it is `explicit-limit`, and no grant or Full access is counted.
   * - Authority is decided before existence, so a permission gap is never reported as a missing file.
   * - A share, device or `/net` spelling is judged by spelling alone until Full access, a Folder Access entry or a grant
   *   covers it by its spelling: no metadata or other disk check reaches another computer before that.
   * `probe` exists so a test can see that no such check is made; the host passes none.
   */
  contractInputAccess(
    config: AgentConfig,
    target: string,
    requestId: string | undefined,
    probe: { physical(abs: string): string; stat(abs: string): { isFile(): boolean } } = { physical: physicalPath, stat: statSync },
  ): OutsideInputAccess {
    // A spelling of another platform names nothing here, and is not called reachable.
    if (!path.isAbsolute(target)) return { status: 'unavailable', detail: 'it is not a local path on this computer' };
    const lexical = path.resolve(target);
    const ceiling = config.folderAccess?.length ? config.folderAccess : undefined;
    const full = !ceiling && this.baseFullFileAccess(config);
    const grants = ceiling ? [] : this.runtime.pathGrantsFor?.(requestId) ?? [];
    if (reachesAnotherComputer(lexical)) {
      const holds = (root: string) => isPathInsideOrEqual(root, lexical);
      const named = full
        || (ceiling ?? []).some((entry) => path.isAbsolute(entry.path) && holds(path.resolve(entry.path)))
        || grants.some(({ target: granted }) => granted.kind === 'file'
          ? samePath(granted.lexicalPath, lexical) || samePath(granted.realPath, lexical)
          : holds(granted.lexicalPath) || holds(granted.realPath));
      if (!named) return { status: ceiling ? 'explicit-limit' : 'grant-needed', unprobed: true };
    }
    let primaryRoot: string;
    try { primaryRoot = config.workingDirectory || this.runtime.workspace().root(); } catch {
      return { status: 'unavailable', detail: 'no workspace folder is open' };
    }
    const physical = probe.physical(lexical);
    const configured = resolveEffectiveRoots({
      grants: config.folderAccess,
      fallbackPrimaryRoot: primaryRoot,
      fallbackReadRoots: this.readRootsForAgent(primaryRoot),
      workspaceRoots: this.runtime.workspace().roots(),
      isTrusted: this.runtime.workspace().isTrusted(),
    });
    const reach: OutsideReadReach = {
      root: configured.readRoots.some((root) => isPathInsideOrEqual(root, physical)),
      file: configured.readFiles.some((file) => samePath(file.realPath, physical)),
      full: full && !!fullAccessTargetRoot(physical),
      grant: grants.length > 0 && matchPathAccess(grants, lexical, 'read') !== undefined,
    };
    if (!reach.root && !reach.file && !reach.full && !reach.grant) return { status: ceiling ? 'explicit-limit' : 'grant-needed' };
    try {
      if (!probe.stat(physical).isFile()) return { status: 'missing-input', detail: 'it is not a regular file' };
    } catch (error) {
      // v0.9.101 (H2b, audit H2b-1): only a file that is positively not there is missing. One whose status could not be
      // read (no permission, locked, an I/O error) could not be inspected: nothing is known of it, and no grant helps.
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing-input' };
      return { status: 'unavailable', detail: 'its file status could not be read' };
    }
    const currentRead = outsideCurrentRead(this.runtime.backendKindFor(config), reach);
    return { status: 'readable', physical, ...(currentRead ? { currentRead } : {}) };
  }

  /**
   * v0.9.101 (H2b): the sources a draft was prepared from, compared with what they are now, under the draft owner's live
   * authority in `requestId`: the facts `contractInputAccess` uses for reading an input. Each recorded physical file is
   * read only when that authority reaches it, below the folder that holds it, and its SHA-256 compared with the digest
   * of the bytes first read. It never makes or widens a grant to read. Only a source read now whose bytes differ, or
   * whose path now leads to another file, is `changed`; one a grant could open is `grantable`; one outside the owner's
   * Folder Access is `limit`. Every other failure to compare (the file is not there or not a regular file, its status or
   * bytes could not be read) is `unreadable`: no change is claimed and the draft is kept. A change takes precedence over
   * a limit, a limit over a missing grant, and a missing grant over a failed read.
   */
  async checkTaskSource(config: AgentConfig, requestId: string | undefined, digests: readonly SourceDigest[]): Promise<SourceCheck> {
    let limit: SourceCheck | undefined;
    let grantable: SourceCheck | undefined;
    let unreadable: SourceCheck | undefined;
    for (const digest of digests) {
      const access = this.contractInputAccess(config, digest.physical, requestId);
      if (access.status === 'explicit-limit') {
        limit ??= { state: 'limit', physical: digest.physical, inputId: digest.inputId,
          text: `${accessNeedLabel(digest.physical)} is outside ${config.name}'s Folder Access; a grant cannot change that.` };
        continue;
      }
      if (access.status === 'grant-needed') { grantable ??= { state: 'grantable', physical: digest.physical, inputId: digest.inputId }; continue; }
      if (access.status !== 'readable') { unreadable ??= { state: 'unreadable', physical: digest.physical, inputId: digest.inputId }; continue; }
      let read: Awaited<ReturnType<typeof readRegularFileInsideRoot>>;
      try { read = await readRegularFileInsideRoot(path.dirname(access.physical), access.physical, hostReadMemoryBudget()); } catch {
        unreadable ??= { state: 'unreadable', physical: digest.physical, inputId: digest.inputId };
        continue;
      }
      if (read.status !== 'read') { unreadable ??= { state: 'unreadable', physical: digest.physical, inputId: digest.inputId }; continue; }
      if (!samePath(read.physicalPath, digest.physical) || createHash('sha256').update(read.bytes).digest('hex') !== digest.sha256) {
        return { state: 'changed', inputId: digest.inputId };
      }
    }
    return limit ?? grantable ?? unreadable ?? { state: 'unchanged' };
  }

  /**
   * A requested task scope is a ceiling over the agent's configured authority, never a replacement grant.
   * This is the only host policy that admits a task-scoped folder access request. `requestId` is the logical request
   * the task belongs to: its own grants count, and no other request's do.
   */
  resolveTaskWorkspaceAccess(
    config: AgentConfig,
    scope: DelegationTaskScope | undefined,
    requestId: string | undefined,
  ): {
    access?: TaskWorkspaceAccess;
    reason?: string;
    /**
     * The physical targets outside the workspace a grant could open, when a grant counts: every one named when the scope
     * shared nothing, and, beside an admitted scope, those it cannot reach with the access asked for.
     */
    outOfReach?: readonly string[];
  } {
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
    // v0.9.101 (E2, T101-12, named by the Owner 2026-11-03): a scope entry with a share, device or `/net` spelling that
    // nothing this agent holds names is judged by its spelling: resolving it opened SMB to that server with the person's
    // credentials and blocked until it failed. It is left out of the resolution and named as out of reach, so Grant
    // access is offered for it as for any outside target; under a Folder Access ceiling nothing is offered.
    const ceiling = config.folderAccess?.length ? config.folderAccess : undefined;
    const heldGrants = ceiling ? [] : this.runtime.pathGrantsFor?.(requestId) ?? [];
    const unheldRemote = (entryPath: string): boolean => {
      const target = path.resolve(primaryRoot, entryPath);
      if (!fileToolReachesAnotherComputer(target) || (!ceiling && this.baseFullFileAccess(config))) return false;
      const folders = [primaryRoot, ...workspace.roots(), ...(ceiling ?? []).map((entry) => path.resolve(primaryRoot, entry.path)),
        ...heldGrants.filter(({ target: granted }) => granted.kind === 'directory').flatMap(({ target: granted }) => [granted.lexicalPath, granted.realPath])];
      const files = heldGrants.filter(({ target: granted }) => granted.kind === 'file').flatMap(({ target: granted }) => [granted.lexicalPath, granted.realPath]);
      return !heldBySpelling(target, folders, files);
    };
    const unprobed = scope.folderAccess.filter((entry) => unheldRemote(entry.path));
    const offeredUnprobed = ceiling ? [] : unprobed.map((entry) => path.resolve(primaryRoot, entry.path));
    const withUnprobed = (outOfReach: readonly string[] | undefined): { outOfReach?: readonly string[] } => {
      const all = [...(outOfReach ?? []), ...offeredUnprobed];
      return all.length ? { outOfReach: all } : {};
    };
    const resolvable = scope.folderAccess.filter((entry) => !unprobed.includes(entry));
    if (resolvable.length === 0) {
      // v0.9.101 (H1): only share or device spellings a grant could open: the task waits for them at its calls.
      const pending = ceiling || !workspace.isTrusted() ? undefined : this.pendingTaskAccess({ readRoots: [], writeRoots: [], readFiles: [], writeFiles: [] },
        undefined, [], unprobed.map((entry) => ({ path: path.resolve(primaryRoot, entry.path), permission: entry.permission })));
      if (pending) {
        return { access: { pathBase: path.resolve(primaryRoot), readRoots: [], writeRoots: [], readFiles: [], writeFiles: [], pending },
          ...withUnprobed(undefined) };
      }
      return { reason: 'Task-scoped folder access shares no readable folder or file with what this agent can reach, so the assignment was not started. For a path outside the workspace, the user can choose Grant access for this session or set the agent to Full access.',
        ...withUnprobed(undefined) };
    }
    const configured = resolveEffectiveRoots({ ...rootOptions, grants: config.folderAccess });
    const requested = resolveEffectiveRoots({ ...rootOptions, grants: resolvable });
    if (requested.issues.length > 0) {
      return { reason: `Task-scoped folder access was rejected: ${requested.issues.map((issue) => issue.message).join('; ')}` };
    }

    if (this.baseFullFileAccess(config)) {
      // A confirmed Full policy already covers these OS-visible targets. Derive only their physical volumes/shares,
      // then keep the existing more-specific intersection: a requested file remains one file, not its whole volume.
      configured.readRoots.push(...new Set([...requested.readRoots, ...requested.readFiles.map((file) => file.realPath)]
        .map((target) => fullAccessTargetRoot(target)).filter(Boolean)));
      configured.writeRoots.push(...new Set([...requested.writeRoots, ...requested.writeFiles.map((file) => file.realPath)]
        .map((target) => fullAccessTargetRoot(target)).filter(Boolean)));
    }

    if (!config.folderAccess?.length) {
      for (const grant of this.runtime.pathGrantsFor?.(requestId) ?? []) {
        if (grant.target.kind === 'file') {
          configured.readFiles.push(grant.target as ResolvedFileGrant);
          if (grant.permission === 'readwrite') configured.writeFiles.push(grant.target as ResolvedFileGrant);
        } else {
          configured.readRoots.push(grant.target.realPath);
          if (grant.permission === 'readwrite') configured.writeRoots.push(grant.target.realPath);
        }
      }
    }

    const intersected = intersectTaskWorkspaceAccess(configured, requested, workspace.isTrusted(), primaryRoot);
    const roots = workspace.roots().map((root) => physicalPath(path.resolve(root)));
    // v0.9.101 (H1, the Owner 2026-11-07: ask for access, never remove capability): what the task needs outside the
    // workspace, and a grant in its request could open, stays in its ceiling as `pending`. It grants nothing: each call is
    // still checked against what is held then, and a later grant reaches this task without dispatching it again. A
    // Folder Access agent has a ceiling a grant never widens, and an untrusted workspace offers no grant, so nothing is
    // pending for either.
    const pending = config.folderAccess?.length || !workspace.isTrusted() ? undefined : this.pendingTaskAccess(requested, intersected, roots,
      unprobed.map((entry) => ({ path: path.resolve(primaryRoot, entry.path), permission: entry.permission })));
    const access = intersected ? { ...intersected, ...(pending ? { pending } : {}) }
      // A task that can reach nothing yet, though everything it names can be granted, is still admitted: it waits for
      // the grants at its calls, in its own path base, with no root of its own.
      : pending ? { pathBase: path.resolve(primaryRoot), readRoots: [], writeRoots: [], readFiles: [], writeFiles: [], pending } : undefined;
    // v0.9.100 (field, 7fc21c4b T2): a scope that reached part of what it named outside the workspace is admitted
    // narrowed, as the Owner decided for S7 (what the teammate can already reach decides). It was admitted with no word
    // of the rest and nothing to grant it: the summary's folder was admitted read-only beside the workspace, and its write
    // and the agreement were dropped. The outside targets it cannot reach with the access it asked for are now named, so
    // the dispatcher is told and each is offered for Grant access. Narrowing inside the workspace is unchanged. An agent's
    // own Folder Access is a ceiling a grant never widens, so nothing is offered for it.
    if (access) {
      if (config.folderAccess?.length) return { access };
      const writable = (target: string) => access.writeRoots.some((root) => isPathInsideOrEqual(root, target))
        || (access.writeFiles ?? []).some((file) => samePath(file.realPath, target));
      const readable = (target: string) => writable(target) || access.readRoots.some((root) => isPathInsideOrEqual(root, target))
        || (access.readFiles ?? []).some((file) => samePath(file.realPath, target));
      const missing = [
        ...[...requested.writeRoots, ...requested.writeFiles.map(({ realPath }) => realPath)].filter((target) => !writable(target)),
        ...[...requested.readRoots, ...requested.readFiles.map(({ realPath }) => realPath)].filter((target) => !readable(target)),
      ].filter((target, index, all) => !roots.some((root) => isPathInsideOrEqual(root, target))
        && all.findIndex((other) => samePath(other, target)) === index);
      return { access, ...withUnprobed(missing.length ? missing : undefined) };
    }
    return {
      reason: 'Task-scoped folder access shares no readable folder or file with what this agent can reach, so the assignment was not started. For a path outside the workspace, the user can choose Grant access for this session or set the agent to Full access.',
      // An agent's own Folder Access is a ceiling a grant never widens, so a grant cannot help it.
      ...(config.folderAccess?.length ? {} : withUnprobed([...requested.readRoots, ...requested.readFiles.map(({ realPath }) => realPath)]
        .filter((target) => !roots.some((root) => isPathInsideOrEqual(root, target))))),
    };
  }

  /**
   * v0.9.101 (H1): the requested entries outside the workspace that the admitted access does not reach with the
   * permission asked for, and a grant could open. Callers ask it only in a trusted workspace with no Folder Access, where a
   * grant can be given. A share or device spelling nothing holds is kept as written: resolving it would contact that computer.
   */
  private pendingTaskAccess(
    requested: { readRoots: string[]; writeRoots: string[]; readFiles: ResolvedFileGrant[]; writeFiles: ResolvedFileGrant[] },
    access: TaskWorkspaceAccess | undefined,
    roots: readonly string[],
    unprobed: ReadonlyArray<{ path: string; permission: 'read' | 'readwrite' }>,
  ): TaskWorkspaceAccess['pending'] {
    const outside = (target: string) => !roots.some((root) => isPathInsideOrEqual(root, target));
    const writable = (target: string) => !!access && (access.writeRoots.some((root) => isPathInsideOrEqual(root, target))
      || (access.writeFiles ?? []).some((file) => samePath(file.realPath, target)));
    const readable = (target: string) => !!access && (writable(target) || access.readRoots.some((root) => isPathInsideOrEqual(root, target))
      || (access.readFiles ?? []).some((file) => samePath(file.realPath, target)));
    const pending = {
      readRoots: [...requested.readRoots.filter((target) => outside(target) && !readable(target)), ...unprobed.map((entry) => entry.path)],
      writeRoots: [...requested.writeRoots.filter((target) => outside(target) && !writable(target)),
        ...unprobed.filter((entry) => entry.permission === 'readwrite').map((entry) => entry.path)],
      readFiles: requested.readFiles.filter((file) => outside(file.realPath) && !readable(file.realPath)),
      writeFiles: requested.writeFiles.filter((file) => outside(file.realPath) && !writable(file.realPath)),
    };
    return pending.readRoots.length || pending.writeRoots.length || pending.readFiles.length || pending.writeFiles.length
      ? pending : undefined;
  }

  /**
   * v0.9.100 (the Owner): a task that reaches outside the workspace is allowed, and the person is told, without a
   * question. It names what was admitted, by physical path and permission, not what the contract asked for: a request
   * can be narrowed, and a relative name can lead outside through a link.
   */
  private outsideScopeNotice(event: DelegationDispatchEvent): string | undefined {
    const worker = this.runtime.configForAgent(event.agentId);
    if (!worker) return undefined;
    const roots = this.runtime.workspace().roots().map((root) => physicalPath(path.resolve(root)));
    const reach = new Map<string, 'Read' | 'Read + Write'>();
    const scope = event.contract?.effects.writeScope ?? event.scope;
    // A task scope is the worker's whole file reach: a read file outside it stays out of reach, so it is not named.
    if (scope) this.collectAdmittedReach(worker, scope, event.coordinatorId, reach);
    // v0.9.101 (A1): an outside input is a file the task reads too.
    else for (const file of [...event.contract?.effects.readFiles ?? [], ...(event.contract?.inputs ?? []).flatMap((input) =>
      input.kind === 'workspacePath' && path.isAbsolute(input.path) ? [input.path] : [])]) {
      this.collectAdmittedReach(worker, { folderAccess: [{ path: file, permission: 'read' }] }, event.coordinatorId, reach);
    }
    const named = [...reach].filter(([target]) => !roots.some((root) => isPathInsideOrEqual(root, target)))
      .map(([target, permission]) => `${target} (${permission})`);
    if (named.length === 0) return undefined;
    return `This task lets ${worker.name} reach outside this workspace: ${named.join(', ')}. It applies to this task only. To stop it, use Stop.`;
  }

  private collectAdmittedReach(worker: AgentConfig, scope: DelegationTaskScope, coordinatorId: string, reach: Map<string, 'Read' | 'Read + Write'>): void {
    const access = this.resolveTaskWorkspaceAccess(worker, scope, this.runtime.currentRequestId?.(coordinatorId)).access;
    if (!access) return;
    for (const target of [...access.readRoots, ...(access.readFiles ?? []).map((file) => file.realPath)]) {
      if (!reach.has(target)) reach.set(target, 'Read');
    }
    for (const target of [...access.writeRoots, ...(access.writeFiles ?? []).map((file) => file.realPath)]) reach.set(target, 'Read + Write');
  }

  /**
   * v0.9.100 (field, 4c06a304 S7c and S7d): the task's scope as Activity shows it, by the rule of the notice above: what
   * was admitted, not what was asked. Activity said read/write for a file the person had allowed to be read, and named
   * a link instead of where it leads.
   */
  private admittedScopeText(event: DelegationDispatchEvent): string | undefined {
    const worker = this.runtime.configForAgent(event.agentId);
    const scope = event.contract?.effects.writeScope ?? event.scope;
    if (!worker || !scope) return undefined;
    const reach = new Map<string, 'Read' | 'Read + Write'>();
    this.collectAdmittedReach(worker, scope, event.coordinatorId, reach);
    if (reach.size === 0) return undefined;
    return [...reach].map(([target, permission]) => `${permission === 'Read' ? 'read-only' : 'read/write'} ${target}`).join(', ').slice(0, 160);
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
  async openRecordedWorkspaceFile(
    agentId: string,
    filePath: string,
    stillShown?: () => boolean,
    action: FileLinkAction = 'open',
  ): Promise<void> {
    // v0.9.102: a later Reveal from the notification asks the chat surface again whether the receipt is still shown.
    if (stillShown && !stillShown()) {
      this.refuseFileNavigation('changed');
      return;
    }
    const config = this.runtime.configForAgent(agentId);
    if (!config || !filePath.trim()) {
      this.refuseFileNavigation('unknown-receipt');
      return;
    }
    let primaryRoot: string;
    try { primaryRoot = config.workingDirectory || this.runtime.workspace().root(); }
    catch {
      this.warnFileNavigation('Open a workspace folder to open files from the chat.', filePath);
      return;
    }
    const candidate = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(primaryRoot, filePath);
    const roots = this.readCeilingsFor(config, candidate);
    if (!roots) {
      this.warnFileNavigation('Open a workspace folder to open files from the chat.', filePath);
      return;
    }
    const resolved = resolveRecordedFileForOpen(filePath, primaryRoot, roots, realpathSync.native, statSync);
    const warn: NavigationWarning = async (message, revealable) => {
      this.warnFileNavigation(message, filePath, revealable && this.runtime.revealRecordedFile
        ? () => this.openRecordedWorkspaceFile(agentId, filePath, stillShown, 'reveal') : undefined);
    };
    await this.openResolvedFile(resolved, filePath, warn, undefined, undefined, action);
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
    const navigation = config ? this.navigationScopeFor(config) : undefined;
    if (!navigation) return undefined;
    // Full access is a host-authored historical fact, not a snapshot of enumerated drives. It still requires
    // current Full access when clicked. Put it first so the chat's existing bounded snapshot retains it.
    const physical = new Set<string>(navigation.full ? [FULL_FILE_LINK_CEILING] : []);
    for (const ceiling of navigation.scope.readRoots) {
      try {
        const current = realpathSync(ceiling);
        // Pinned task roots are physical identities already: resolving a replaced root must not move its scope.
        if ((!navigation.pinned || samePath(current, ceiling)) && statSync(current).isDirectory()) physical.add(current);
      } catch {
        // No physical identity, no authority.
      }
    }
    for (const file of navigation.scope.readFiles) {
      try {
        const current = realpathSync(file.realPath);
        if (samePath(current, file.realPath) && statSync(current).isFile()) {
          physical.add(`${EXACT_FILE_LINK_CEILING}${file.realPath}`);
        }
      } catch { /* A missing/replaced exact file grants no historical authority. */ }
    }
    return [...physical];
  }

  /**
   * v0.9.97: a chat surface found nothing to open. Every refusal is shown; none is a silent return. v0.9.102:
   * `report` shows it beside the clicked link, and the notification is shown only when that surface is gone.
   */
  refuseFileNavigation(reason: FileNavigationRefusal, report?: (message: string) => boolean | Promise<boolean>): Promise<void> | void {
    const message = FILE_NAVIGATION_REFUSALS[reason];
    if (!report) {
      this.runtime.warnUser(message);
      return;
    }
    return shownBeside(report, message).then((shown) => {
      if (!shown) this.runtime.warnUser(message);
    });
  }

  /**
   * v0.9.97: open a file link of a reply, after the chat host found the reply and the link again in what it keeps.
   *
   * The destination is read again under the host's path rules. A relative path is read against a folder recorded
   * with the reply, never against the agent's folder of today; with several recorded folders the user chooses one
   * and nothing is guessed. After that choice the link must still be shown. From there to the editor nothing waits:
   * the agent, its current read folders and the file (real path, regular file) are checked as they are now.
   *
   * v0.9.102: `reveal` runs every one of these checks too, and then shows the file in the system's file manager
   * instead of opening it. What the click came to, when it did not simply open, is shown beside the clicked link
   * (`reference.report`); only when that chat surface is gone is it a notification.
   */
  async openFileReference(agentId: string, reference: ChatFileLinkReference, action: FileLinkAction = 'open'): Promise<void> {
    const written = reference.destination;
    const warn: NavigationWarning = async (message, revealable) => {
      const reveal = revealable === true && this.runtime.revealRecordedFile !== undefined;
      if (reference.report && await shownBeside(reference.report, { message, ...(reveal ? { reveal: true as const } : {}) })) return;
      // The notification's Reveal is a new request through this boundary, checked when it is clicked.
      this.warnFileNavigation(message, written, reveal ? () => this.openFileReference(agentId, reference, 'reveal') : undefined);
    };
    if (this.runtime.workspace().allFoldersLocal?.() === false) {
      await warn('Chat file links open only in a local window whose workspace folders are on this computer; a remote window or a virtual folder is not supported yet.');
      return;
    }
    const target = classifyLinkDestination(written);
    if (target.kind !== 'file') {
      await warn(`UnodeAi does not open "${shownReference(written)}": it is not a path on this computer.`);
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
          await warn(`"${shownReference(written)}" could be in more than one workspace folder, and UnodeAi does not guess which.`);
          return;
        }
        const chosen = await this.runtime.pickFileLinkFolder(folders, written);
        if (!chosen || !folders.includes(chosen)) {
          await warn(`No folder was chosen for "${shownReference(written)}", so nothing was opened.`);
          return;
        }
        base = chosen;
      }
      if (!base) {
        await warn(`"${shownReference(written)}" is a relative path, and this reply has no workspace folder to read it against.`);
        return;
      }
      candidate = path.resolve(base, target.path);
      // The destination holds no `..` segment, so this holds; it is checked rather than assumed.
      if (!isPathInsideOrEqual(base, candidate)) {
        await warn(this.openRefusalText('outside-read-roots', written));
        return;
      }
    }
    if (!reference.stillShown()) {
      this.refuseFileNavigation('changed');
      return;
    }
    const config = this.runtime.configForAgent(agentId);
    if (!config) {
      await warn(`The agent that wrote "${shownReference(written)}" no longer exists, so its read folders cannot be checked.`);
      return;
    }
    const roots = this.readCeilingsFor(config, candidate);
    if (!roots) {
      await warn('Open a workspace folder to open files from the chat.');
      return;
    }
    const resolved = resolveFileForOpen(candidate, roots, { realpath: realpathSync.native, stat: statSync });
    // FOPEN-N1: the physical target must also be inside the read ceiling the agent had WHEN the reply was written,
    // recorded with it. A later widening of the agent's scope must not open an old link; a narrowing already
    // revoked it through the current-ceiling check above. A reply with no recorded ceiling grants nothing.
    if (resolved.ok && resolved.path !== undefined && !this.withinMessageTimeCeiling(reference, resolved.path, config)) {
      await warn(this.messageScopeRefusalText(written));
      return;
    }
    await this.openResolvedFile(resolved, written, warn, target.position, target.unsupportedFragment, action);
  }

  /**
   * FOPEN-N1: true when the physical target is inside the read ceiling recorded with the reply (its message-time
   * scope). A reply with no recorded ceiling returns false — its message-time authority cannot be proven, so it
   * opens nothing (an imported or pre-0.9.97 reply has no recorded scope and is fail-closed here).
   *
   * FOPEN-RC-N1: the recorded ceilings are real paths from when the reply was written (`fileLinkCeilings`). They are
   * compared as recorded and never resolved again, so they cannot take on what a link points to now.
   */
  private withinMessageTimeCeiling(reference: ChatFileLinkReference, physicalPath: string, config: AgentConfig): boolean {
    const ceilings = reference.ceilings;
    if (!ceilings || ceilings.length === 0) {
      return false;
    }
    if (ceilings.includes(FULL_FILE_LINK_CEILING) && this.baseFullFileAccess(config)) return true;
    return ceilings.some((physicalRoot) => physicalRoot.startsWith(EXACT_FILE_LINK_CEILING)
      ? samePath(physicalRoot.slice(EXACT_FILE_LINK_CEILING.length), physicalPath)
      : physicalRoot !== FULL_FILE_LINK_CEILING && isPathInsideOrEqual(physicalRoot, physicalPath));
  }

  private messageScopeRefusalText(written: string): string {
    return `"${shownReference(written)}" is outside the read folders the agent had when it wrote this reply, so UnodeAi did not open it. A later change to the agent's folders does not open an old link.`;
  }

  /** The current read ceilings of an agent, or undefined when the window has no workspace folder to anchor them. */
  private readCeilingsFor(config: AgentConfig, target?: string): string[] | undefined {
    const navigation = this.navigationScopeFor(config);
    if (!navigation) return undefined;
    if (target) {
      try {
        const physical = realpathSync.native(target);
        if (navigation.full) {
          // Inspect only the named physical target. Its own volume/share works for cross-drive paths and UNC
          // receipts without enumerating disks or changing relative-link selection roots.
          const root = fullAccessTargetRoot(physical);
          if (root) return [root];
        }
        // A pinned exact-file ceiling never becomes a subtree if that name is replaced by a directory.
        return [
          ...navigation.scope.readRoots.filter((root) => isPathInsideOrEqual(root, physical)),
          ...navigation.scope.readFiles.filter((file) => samePath(file.realPath, physical)).map((file) => file.realPath),
        ];
      } catch { /* The shared resolver reports the existing missing/unreadable reason. */ }
    }
    return readablePathCeilings(navigation.scope);
  }

  private navigationScopeFor(config: AgentConfig): { scope: ResolvedWorkspaceScope; full: boolean; pinned: boolean } | undefined {
    let primaryRoot: string;
    try {
      primaryRoot = config.workingDirectory || this.runtime.workspace().root();
    } catch {
      return undefined;
    }
    const configured = resolveEffectiveRoots({
      grants: config.folderAccess,
      fallbackPrimaryRoot: primaryRoot,
      fallbackReadRoots: this.readRootsForAgent(primaryRoot),
      workspaceRoots: this.runtime.workspace().roots(),
      isTrusted: this.runtime.workspace().isTrusted(),
    });
    const task = this.runtime.taskScopeActive?.(config.id) === true
      ? this.runtime.taskWorkspaceAccess?.(config.id) : undefined;
    if (!task) return { scope: configured, full: this.hasFullFileAccess(config), pinned: false };
    const requested: ResolvedWorkspaceScope = {
      readRoots: [...new Set([...task.readRoots, ...task.writeRoots])], writeRoots: [...task.writeRoots],
      readFiles: [...(task.readFiles ?? []), ...(task.writeFiles ?? [])], writeFiles: [...(task.writeFiles ?? [])],
    };
    // A pinned snapshot is a ceiling, not a grant that survives revocation. Base Full covers its named targets;
    // otherwise keep only its intersection with the agent's CURRENT configured read authority.
    const physicalRoots = (roots: readonly string[]) => roots.flatMap((root) => {
      try { return [realpathSync(root)]; } catch { return []; }
    });
    const current = this.baseFullFileAccess(config) ? requested
      : intersectTaskWorkspaceAccess({ ...configured, readRoots: physicalRoots(configured.readRoots),
        writeRoots: physicalRoots(configured.writeRoots) }, requested, this.runtime.workspace().isTrusted(), primaryRoot);
    return { full: false, pinned: true, scope: {
      readRoots: current?.readRoots ?? [], writeRoots: current?.writeRoots ?? [],
      readFiles: current?.readFiles ?? [], writeFiles: current?.writeFiles ?? [],
    } };
  }

  private hasFullFileAccess(config: AgentConfig): boolean {
    return this.baseFullFileAccess(config) && this.runtime.taskScopeActive?.(config.id) !== true;
  }

  private baseFullFileAccess(config: AgentConfig): boolean {
    return this.runtime.fullFileAccess?.(config) === true && this.runtime.workspace().isTrusted()
      && !config.folderAccess?.length;
  }

  /**
   * Opens (or reveals) what the synchronous check admitted, at once; otherwise says why through `warn`. v0.9.102: a
   * failure names its reason, and a file that opens neither in the editor nor in an app is offered for revealing.
   */
  private async openResolvedFile(
    resolved: ReturnType<typeof resolveFileForOpen>,
    written: string,
    warn: NavigationWarning,
    position?: FileLinkPosition,
    unsupportedFragment?: string,
    action: FileLinkAction = 'open',
  ): Promise<void> {
    if (!resolved.ok || !resolved.path) {
      await warn(this.openRefusalText(resolved.reason ?? 'missing', written));
      return;
    }
    if (action === 'reveal') {
      if (!this.runtime.revealRecordedFile) {
        await warn(`UnodeAi cannot reveal "${shownReference(written)}" in this window.`);
        return;
      }
      try {
        await this.runtime.revealRecordedFile(resolved.path);
      } catch (error) {
        await warn(`UnodeAi could not reveal "${shownReference(written)}": ${failureReason(error)}.`);
      }
      return;
    }
    try {
      await this.runtime.openRecordedFile(resolved.path, position);
    } catch (error) {
      if (error instanceof FileNotOpenedAsText) await warn(error.message, true);
      else await warn(`UnodeAi could not open "${shownReference(written)}": ${failureReason(error)}.`);
      return;
    }
    if (unsupportedFragment !== undefined) {
      await warn(`Opened "${shownReference(written)}" at its start: "#${unsupportedFragment}" is not a line, and UnodeAi goes only to #L12 or :12.`);
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

  private warnFileNavigation(message: string, reference: string, reveal?: () => Promise<void>): void {
    if (this.runtime.warnFileNavigation) {
      this.runtime.warnFileNavigation(message, reference, reveal);
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
    // v0.9.99: an image too large to show a model is kept too, so the agent can save it into the workspace.
    [...attachmentParts.images, ...attachmentParts.largeImages],
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
    // v0.9.99: the readers page through the whole file, never a copy cut where the turn's inlined part ends.
    const text = storedTextAttachmentSource(attachment);
    if (!text) { continue; }
    const bytes = Buffer.from(attachment.dataBase64, 'base64');
    let stored: Awaited<ReturnType<ContentAssetStore['storeTextAttachment']>>;
    try {
      stored = await store.storeTextAttachment(bytes, text);
    } catch {
      continue;
    }
    if ('error' in stored) { continue; }
    // v0.9.99: the turn names this copy where a long file's inlined part ends, for the paged read of the rest.
    attachment.contentAssetId = stored.assetId;
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
    attachment.contentAssetId = stored.assetId;
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
    // v0.9.99: the turn names this copy for an image too large to show, so the agent can save it.
    attachment.contentAssetId = stored.assetId;
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
