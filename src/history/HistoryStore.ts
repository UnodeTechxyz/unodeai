/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the canonical task history store (v0.9.110 H0, design §3.2–3.4)
 *
 *  Layout, under VS Code storage at `history/v1/<workspaceId>/`:
 *    events/<revision>.json     one event each, published once by exclusive link (durableFiles.ts)
 *    snapshots/<revision>.json  every accepted event through that revision; older event files may then go
 *    staging/<writerId>/        a writer's private names before publish; never read
 *    writers/<writerId>.json    the writer's process identity, so a crashed writer's staging can be proven stale
 *    quarantine/                event files that could not be read, set aside with their revision
 *
 *  Each window writes only new names; nobody rewrites an index. The revision order is the history's order; dates
 *  are display only. An event id delivered twice is recorded once (the first revision wins). A newer schema makes
 *  the store read-only; an unreadable event is set aside and shown as a gap, never repaired or guessed.
 *
 *  No `vscode` import.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { ChatHistoryMessage } from '../views/chatHistory';
import { publishExclusive, PublishTakenError, writeDurably, type PublishState } from './durableFiles';
import {
  HISTORY_SCHEMA_VERSION,
  MAX_HISTORY_EVENT_BYTES,
  parseHistoryEnvelope,
  type HistoryEventBody,
  type HistoryEventEnvelope,
  type HistoryTaskV1,
  type HistoryTerminal,
  type HistoryVerification,
  type TaskDeletionReason,
  type TaskDeletionScope,
  MAX_DELETION_IDS,
} from './HistoryRecords';
import { RecoveryManifestBuilder, type CaptureInOrder, type RecoveryManifestV1 } from './RecoveryManifest';
import type { HistoryFileState, RecoveryAction, RecoveryTargetPhase } from './HistoryRecords';
import { legacyMessageDigest } from './LegacyChatProjectionBridge';
import {
  parseProcessIdentityRecord,
  type ProcessIdentityAdapter,
  type ProcessIdentityRecord,
} from '../host/processIdentity/ProcessIdentityHost';

const REVISION_FILE = /^(\d{12})\.json$/;
/**
 * A young unreadable event may still be being written by a writer on a file system without hard links. A reader cannot
 * tell from its own publishing how another writer publishes, so this holds for every reader.
 */
const PENDING_GRACE_MS = 10_000;
/*
 * A gap's event file is never removed, at any age: a writer that stalled (a suspended machine) may still complete it,
 * and its file is then the only complete copy. Gaps are read again at every refresh, below a snapshot as well.
 */
/** Event files after the newest snapshot before this writer folds them into a new one. */
export const HISTORY_COMPACT_AFTER = 2_000;
const SNAPSHOTS_KEPT = 2;
const PUBLISH_ATTEMPTS = 64;
export const HISTORY_PAGE_SIZE = 50;

/** v0.9.110 H1 (design §3.3): what housekeeping keeps, whichever limit is reached first. */
export const HISTORY_HOUSEKEEPING = {
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxEndedTasks: 1_000,
  maxBytes: 16 * 1024 * 1024,
};
export type HistoryHousekeepingLimits = typeof HISTORY_HOUSEKEEPING;

export interface HistoryUsage {
  tasks: number;
  endedTasks: number;
  favourites: number;
  running: number;
  /** Transcript and metadata of the tasks shown, as stored text. */
  bytes: number;
  oldestStartedAt?: string;
}

export interface TaskDeletionResult {
  historyIds: string[];
  messageIds: string[];
  /** Restore points (raw-v2 entry ids) the deleted tasks' requests kept; for the caller to remove when asked. */
  payloadRefs: string[];
  /** The deleted messages of each member, so a visible chat can drop them too. */
  byAgent: Map<string, { messageIds: Set<string>; digests: Set<string> }>;
  /** Whether every copy of the deleted content the history holds is gone; what remains when it is not. */
  purge: PurgeOutcome;
}

interface CompactionOutcome {
  published: boolean;
  /** What could not be done; `stale-winner` when another window's copy still holds deleted content. */
  problems: string[];
}

export interface PurgeOutcome {
  complete: boolean;
  remaining: string[];
}

/** A restore point the history owns, by raw entry id, with the file it kept. */
export interface OwnedRestorePoint {
  ref: string;
  path: string;
  /** `owed`: its deletion was asked and its removal has not succeeded yet. */
  state: 'owned' | 'owed';
}
/**
 * The writer's process identity is read this long after its first write, never at activation: on Windows the read
 * starts a PowerShell query of about a second, and a window that never writes history runs none.
 */
export const HISTORY_IDENTITY_DELAY_MS = 30_000;

export type DurableAppendResult =
  | { status: 'durable'; revision: number; eventId: string }
  | { status: 'duplicate'; revision: number; eventId: string }
  | { status: 'read-only'; reason: string }
  | { status: 'failed'; reason: string };

export class HistoryConflictError extends Error {
  constructor(readonly historyId: string, readonly expected: number, readonly actual: number | undefined) {
    super(actual === undefined ? 'That task is not in the history.' : 'That task changed since it was shown; read it again.');
  }
}

export interface HistoryFilter {
  text?: string;
  agentId?: string;
  terminal?: HistoryTerminal;
  verification?: HistoryVerification;
  favourite?: boolean;
  /** ISO times, inclusive; compared with `startedAt` for display filtering only. */
  since?: string;
  until?: string;
}

export interface HistoryPage {
  tasks: HistoryTaskV1[];
  nextCursor?: string;
  /** Event revisions set aside as unreadable: the history has gaps there. */
  gaps: number[];
  readOnly?: string;
}

export interface HistoryStoreOptions {
  /** `history/v1/<workspaceId>` */
  directory: string;
  workspaceId: string;
  /** This extension host instance; a new UUID per start. */
  writerId: string;
  identity?: ProcessIdentityAdapter;
  now?: () => number;
  log?: (line: string) => void;
  /** Tests: start without hard links. */
  hardLinks?: boolean;
  /** Tests: when the writer identity is read after the first write. */
  identityDelayMs?: number;
  /** Tests: runs just before this window publishes a snapshot, with its final path. */
  beforeSnapshotPublish?: (snapshotPath: string) => Promise<void>;
  /** How physical paths compare on this platform (case folded on Windows); exact by default. */
  physicalKey?: (physical: string) => string;
  /** Whether a request is running now; a task without an outcome is `running` then, otherwise `unfinished`. */
  isRequestRunning?: (rootRequestId: string) => boolean;
  compactAfter?: number;
}

interface MessageRecord {
  agentId: string;
  viewGeneration: string;
  revision: number;
  message: ChatHistoryMessage;
  historyId?: string;
}

interface TaskStart {
  historyId: string;
  agentId: string;
  messageId: string;
  viewGeneration: string;
  legacy: boolean;
  revision: number;
}

/** One target of a recovery operation, as its journal events left it. */
export interface RecoveryTargetRecord {
  targetKey: string;
  physicalTarget: string;
  displayPath: string;
  phase: RecoveryTargetPhase;
  restoreTo?: HistoryFileState;
  expected?: HistoryFileState;
  inverse?: HistoryFileState;
  observed?: HistoryFileState;
  reason?: string;
}

export interface RecoveryOperationRecord {
  operationId: string;
  action: RecoveryAction;
  agentId: string;
  requestIds: string[];
  targetOperationId?: string;
  fromHistoryId?: string;
  /** The store revision that began it. */
  revision: number;
  /** The window (history writer) that began it; only it, or a window that proves it gone, completes it. */
  writerId: string;
  targets: RecoveryTargetRecord[];
  /** `revision`: where its end was recorded. */
  closed?: { applied: number; branchId?: string; revision: number };
}

/** Everything folded from the events, rebuilt from a snapshot plus later events. */
class HistoryFold {
  readonly envelopes = new Map<number, HistoryEventEnvelope>();
  readonly byEventId = new Map<string, number>();
  readonly messages = new Map<string, MessageRecord>();
  readonly agentOrder = new Map<string, string[]>();
  readonly generation = new Map<string, string>();
  readonly starts = new Map<string, TaskStart>();
  readonly taskOrder: string[] = [];
  readonly currentTask = new Map<string, string>();
  readonly requestOf = new Map<string, string>();
  readonly historyOfRequest = new Map<string, string>();
  readonly outcomes = new Map<string, { refs: string[]; terminal: HistoryTerminal; verification: HistoryVerification; endedAt: string }>();
  readonly favourites = new Map<string, boolean>();
  readonly taskRevision = new Map<string, number>();
  readonly migrated = new Map<string, string>();
  readonly legacyImports = new Set<string>();
  readonly gaps: number[] = [];
  readonly recovery: RecoveryManifestBuilder;
  readonly operations = new Map<string, { record: RecoveryOperationRecord; targets: Map<string, RecoveryTargetRecord> }>();
  /** Where later requests continue, by the revision that moved the tip. */
  readonly branchChanges: Array<{ revision: number; branchId: string }> = [];
  /** v0.9.110 R2: the window (history writer) that admitted each request, and the revision of each admission. */
  readonly admittedBy = new Map<string, string>();
  readonly admissions: number[] = [];
  /** Recovery notices in history order, and which members they went out to. */
  readonly notices: Array<Extract<HistoryEventBody, { kind: 'recovery-notice' }>> = [];
  /** The revision each notice was recorded at. */
  readonly noticeRevision = new Map<string, number>();
  /** `notice \0 agent \0 view generation`: the backend took a request carrying the notice in that view. */
  readonly noticeDeliveries = new Set<string>();
  /** Same key: handed to the backend with this request, delivery not (yet) confirmed. */
  readonly noticeAttachments = new Map<string, string>();
  /**
   * `agent \0 view generation` of a view that began empty (a cleared chat, a removed agent): the revision it began at.
   * Notices recorded before it describe files that view never saw, so it is not told them.
   */
  readonly emptyViewSince = new Map<string, number>();
  /** v0.9.110 H1: tasks whose conversation was deleted, and tasks whose restore points were. */
  readonly deletedViews = new Set<string>();
  readonly deletedRestorePoints = new Set<string>();
  /** Deleted messages: their ids and content digests. No text is kept. */
  readonly tombstoned = new Set<string>();
  /** Deleted content digests, counted: two identical deleted copies block two copies, not every later one. */
  readonly tombstonedDigests = new Map<string, number>();
  /**
   * v0.9.110 H1: every restore point (raw entry id) the history owns, independent of which tasks are shown. Fed by
   * capture events and by deletion events, which are never redacted, so a removal still owed survives a reload.
   */
  readonly restoreInventory = new Map<string, { path: string; state: 'owned' | 'owed' | 'removed' }>();
  head = 0;

  constructor(physicalKey: (physical: string) => string = (physical) => physical) {
    this.recovery = new RecoveryManifestBuilder(physicalKey);
  }

  touch(historyId: string | undefined, revision: number): void {
    if (historyId) this.taskRevision.set(historyId, Math.max(this.taskRevision.get(historyId) ?? 0, revision));
  }

  private addMessage(agentId: string, viewGeneration: string, messageId: string, message: ChatHistoryMessage, revision: number,
    starts: { historyId: string; legacy: boolean } | undefined): void {
    if (this.messages.has(messageId) || this.tombstoned.has(messageId)) return;
    if (starts && !this.starts.has(starts.historyId)) {
      this.starts.set(starts.historyId, { historyId: starts.historyId, agentId, messageId, viewGeneration, legacy: starts.legacy, revision });
      this.taskOrder.push(starts.historyId);
      this.currentTask.set(agentId, starts.historyId);
    }
    const historyId = this.currentTask.get(agentId);
    this.messages.set(messageId, { agentId, viewGeneration, revision, message: { ...message, messageId }, historyId });
    const order = this.agentOrder.get(agentId) ?? [];
    order.push(messageId);
    this.agentOrder.set(agentId, order);
    this.touch(historyId, revision);
  }

  /**
   * Messages that arrive without a request record start a task of their own when the person wrote them. They came
   * from another version's window: a request this window is still answering keeps its later replies.
   */
  private addUnrecorded(agentId: string, viewGeneration: string, entries: Array<{ messageId: string; message: ChatHistoryMessage }>,
    revision: number, keepLiveTask: boolean): void {
    const live = keepLiveTask ? this.currentTask.get(agentId) : undefined;
    for (const entry of entries) {
      this.addMessage(agentId, viewGeneration, entry.messageId, entry.message, revision,
        entry.message.role === 'user' ? { historyId: `legacy-${entry.messageId}`, legacy: true } : undefined);
    }
    if (live && !this.starts.get(live)?.legacy) this.currentTask.set(agentId, live);
  }

  apply(revision: number, envelope: HistoryEventEnvelope): void {
    this.head = Math.max(this.head, revision);
    if (this.byEventId.has(envelope.eventId)) return;
    this.byEventId.set(envelope.eventId, revision);
    this.envelopes.set(revision, envelope);
    const body = envelope.body;
    switch (body.kind) {
      case 'transcript-append':
        this.generation.set(body.agentId, body.viewGeneration);
        this.addMessage(body.agentId, body.viewGeneration, body.messageId, body.message, revision,
          body.startsTask ? { historyId: body.startsTask.historyId, legacy: false } : undefined);
        break;
      case 'transcript-patch': {
        const record = this.messages.get(body.messageId);
        if (record && record.agentId === body.agentId) {
          record.message = { ...body.message, messageId: body.messageId };
          this.touch(record.historyId, revision);
        }
        break;
      }
      case 'request-admitted':
        if (!this.requestOf.has(body.historyId) && !this.historyOfRequest.has(body.rootRequestId)) {
          this.requestOf.set(body.historyId, body.rootRequestId);
          this.historyOfRequest.set(body.rootRequestId, body.historyId);
          this.admittedBy.set(body.rootRequestId, envelope.writerId);
          this.admissions.push(revision);
          this.touch(body.historyId, revision);
        }
        break;
      case 'outcome-reference': {
        const held = this.outcomes.get(body.historyId);
        const refs = held ? [...new Set([...held.refs, body.outcomeRef])] : [body.outcomeRef];
        // The latest closeout fact replaces the earlier one; the references accumulate.
        this.outcomes.set(body.historyId, { refs, terminal: body.terminal, verification: body.verification, endedAt: body.endedAt });
        this.touch(body.historyId, revision);
        break;
      }
      case 'favourite':
        // A change made against an older reading of the task is recorded but not applied: compare-and-set in the log.
        if ((this.taskRevision.get(body.historyId) ?? -1) === body.expectedRevision) {
          this.favourites.set(body.historyId, body.value);
          this.touch(body.historyId, revision);
        }
        break;
      case 'view-replaced':
        this.generation.set(body.agentId, body.viewGeneration);
        if (body.messages.length === 0) this.emptyViewSince.set(`${body.agentId}\0${body.viewGeneration}`, revision);
        this.currentTask.delete(body.agentId);
        this.addUnrecorded(body.agentId, body.viewGeneration, body.messages, revision, false);
        break;
      case 'legacy-import':
        this.legacyImports.add(`${body.agentId}\0${body.projectionKey}\0${body.observedDigest}`);
        this.generation.set(body.agentId, body.viewGeneration);
        this.addUnrecorded(body.agentId, body.viewGeneration, body.messages, revision, true);
        break;
      case 'migration-marker':
        if (!this.migrated.has(`${body.agentId}\0${body.projectionKey}`)) this.migrated.set(`${body.agentId}\0${body.projectionKey}`, body.observedDigest);
        break;
      case 'recovery-capture':
        this.recovery.capture(body);
        if (body.before.kind === 'file' && body.before.payloadRef && !this.restoreInventory.has(body.before.payloadRef)) {
          this.restoreInventory.set(body.before.payloadRef, { path: body.displayPath, state: 'owned' });
        }
        this.touch(this.historyOfRequest.get(body.rootRequestId), revision);
        break;
      case 'recovery-settle':
        this.recovery.settle(body);
        this.touch(this.historyOfRequest.get(body.rootRequestId), revision);
        break;
      case 'recovery-uncovered':
        this.recovery.uncovered(body);
        this.touch(this.historyOfRequest.get(body.rootRequestId), revision);
        break;
      case 'recovery-operation':
        if (!this.operations.has(body.operationId)) {
          this.operations.set(body.operationId, {
            record: { operationId: body.operationId, action: body.action, agentId: body.agentId, requestIds: [...body.requestIds],
              ...(body.targetOperationId ? { targetOperationId: body.targetOperationId } : {}),
              ...(body.fromHistoryId ? { fromHistoryId: body.fromHistoryId } : {}), revision, writerId: envelope.writerId, targets: [] },
            targets: new Map(),
          });
        }
        break;
      case 'recovery-target': {
        const operation = this.operations.get(body.operationId);
        if (!operation || operation.record.closed) break;
        const held = operation.targets.get(body.targetKey);
        // Each step keeps what earlier steps recorded; a later phase replaces the phase.
        operation.targets.set(body.targetKey, {
          targetKey: body.targetKey, physicalTarget: body.physicalTarget, displayPath: body.displayPath, phase: body.phase,
          ...((body.restoreTo ?? held?.restoreTo) ? { restoreTo: body.restoreTo ?? held?.restoreTo } : {}),
          ...((body.expected ?? held?.expected) ? { expected: body.expected ?? held?.expected } : {}),
          ...((body.inverse ?? held?.inverse) ? { inverse: body.inverse ?? held?.inverse } : {}),
          ...((body.observed ?? held?.observed) ? { observed: body.observed ?? held?.observed } : {}),
          ...((body.reason ?? held?.reason) ? { reason: body.reason ?? held?.reason } : {}),
        });
        break;
      }
      case 'recovery-notice':
        if (!this.notices.some((notice) => notice.noticeId === body.noticeId)) {
          this.notices.push(body);
          this.noticeRevision.set(body.noticeId, revision);
        }
        break;
      case 'recovery-notice-attached':
        // A member whose view was never recorded (no message stored yet) keeps the view its notices went out in.
        if (!this.generation.has(body.agentId)) this.generation.set(body.agentId, body.viewGeneration);
        for (const noticeId of body.noticeIds) this.noticeAttachments.set(`${noticeId}\0${body.agentId}\0${body.viewGeneration}`, body.requestId);
        break;
      case 'recovery-notice-delivered':
        if (body.viewGeneration && !this.generation.has(body.agentId)) this.generation.set(body.agentId, body.viewGeneration);
        // A delivery recorded without a view (before views were part of it) counts for every view of the member.
        this.noticeDeliveries.add(`${body.noticeId}\0${body.agentId}\0${body.viewGeneration ?? '*'}`);
        break;
      case 'recovery-closed': {
        const operation = this.operations.get(body.operationId);
        if (!operation || operation.record.closed) break;
        operation.record.closed = { applied: body.applied, ...(body.branchId ? { branchId: body.branchId } : {}), revision };
        if (body.branchId) this.branchChanges.push({ revision, branchId: body.branchId });
        break;
      }
      case 'restore-points-removed':
        for (const ref of body.refs) {
          const held = this.restoreInventory.get(ref);
          this.restoreInventory.set(ref, { path: held?.path ?? '', state: 'removed' });
        }
        break;
      case 'task-deletion':
        for (const digest of body.digests) this.tombstonedDigests.set(digest, (this.tombstonedDigests.get(digest) ?? 0) + 1);
        for (const payload of body.payloads ?? []) {
          if (this.restoreInventory.get(payload.ref)?.state !== 'removed') this.restoreInventory.set(payload.ref, { path: payload.path, state: 'owed' });
        }
        for (const messageId of body.messageIds) this.removeMessage(messageId);
        for (const historyId of body.historyIds) {
          if (body.scope !== 'restore-points') this.deletedViews.add(historyId);
          if (body.scope !== 'view') this.deletedRestorePoints.add(historyId);
        }
        break;
    }
  }

  /** v0.9.110: the tasks of the requests the revert an operation belongs to (itself, or the revert it stepped) reverted. */
  private revertTasksOf(operationId: string): string[] {
    const operation = this.operations.get(operationId)?.record;
    const revert = operation?.action === 'revert' ? operation
      : operation?.targetOperationId ? this.operations.get(operation.targetOperationId)?.record : undefined;
    return (revert?.requestIds ?? []).map((id) => this.historyOfRequest.get(id)).filter((id): id is string => !!id);
  }

  /**
   * v0.9.110: the person deleted the restore points of a request this operation's revert reverted: the revert can no
   * longer be undone or redone, and nothing holds its restore points for it.
   */
  recoveryRetired(operationId: string): boolean {
    return this.revertTasksOf(operationId).some((historyId) => this.deletedRestorePoints.has(historyId));
  }

  /**
   * v0.9.110: the conversation of a request this operation's revert reverted was deleted: its notice (which names that
   * request) is no longer told or kept, and is not recorded again.
   */
  noticeErased(operationId: string): boolean {
    return this.revertTasksOf(operationId).some((historyId) => this.deletedViews.has(historyId));
  }

  /** A deleted message leaves the history; only its id stays, so it is never recorded again. */
  private removeMessage(messageId: string): void {
    this.tombstoned.add(messageId);
    const record = this.messages.get(messageId);
    if (!record) return;
    this.messages.delete(messageId);
    const order = this.agentOrder.get(record.agentId);
    if (order) this.agentOrder.set(record.agentId, order.filter((id) => id !== messageId));
  }

  /**
   * An event as a snapshot may keep it after deletions: without deleted messages, and without the restore records of
   * requests whose restore points were deleted. Undefined when nothing of it is kept.
   */
  redact(envelope: HistoryEventEnvelope): HistoryEventEnvelope | undefined {
    const body = envelope.body;
    switch (body.kind) {
      case 'transcript-append':
      case 'transcript-patch':
        return this.tombstoned.has(body.messageId) ? undefined : envelope;
      case 'view-replaced':
      case 'legacy-import': {
        const messages = body.messages.filter((entry) => !this.tombstoned.has(entry.messageId));
        return messages.length === body.messages.length ? envelope : { ...envelope, body: { ...body, messages } };
      }
      case 'recovery-capture':
      case 'recovery-settle':
      case 'recovery-uncovered': {
        const historyId = this.historyOfRequest.get(body.rootRequestId);
        return historyId && this.deletedRestorePoints.has(historyId) ? undefined : envelope;
      }
      case 'recovery-notice':
        return this.noticeErased(body.operationId) ? undefined : envelope;
      // v0.9.110: a revert whose requests lost both their conversation and their restore points (Delete both, Delete
      // all) leaves no record behind: its files' paths and hashes go too, and it is unknown to Undo and Redo.
      case 'recovery-operation':
      case 'recovery-target':
      case 'recovery-closed':
        return this.recoveryRetired(body.operationId) && this.noticeErased(body.operationId) ? undefined : envelope;
      default:
        return envelope;
    }
  }
}

export class HistoryStore {
  private fold: HistoryFold;
  private identityNow?: Promise<void>;
  private loadedThrough = 0;
  private snapshotThrough = 0;
  private highest = 0;
  private readOnlyReason: string | undefined;
  private readonly publishState: PublishState;
  private queue: Promise<unknown> = Promise.resolve();
  private refreshing: Promise<void> | undefined;
  private refreshAgain: Promise<void> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly eventsDir: string;
  private readonly snapshotsDir: string;
  private readonly stagingDir: string;
  private readonly writersDir: string;
  private readonly quarantineDir: string;
  private tasksCache: HistoryTaskV1[] | undefined;
  private disposed = false;

  private identityTimer: ReturnType<typeof setTimeout> | undefined;
  private identityScheduled = false;

  private constructor(private readonly options: HistoryStoreOptions) {
    this.fold = new HistoryFold(options.physicalKey);
    this.publishState = { hardLinks: options.hardLinks ?? true };
    this.now = options.now ?? Date.now;
    this.eventsDir = path.join(options.directory, 'events');
    this.snapshotsDir = path.join(options.directory, 'snapshots');
    this.stagingDir = path.join(options.directory, 'staging', options.writerId);
    this.writersDir = path.join(options.directory, 'writers');
    this.quarantineDir = path.join(options.directory, 'quarantine');
  }

  static async open(options: HistoryStoreOptions): Promise<HistoryStore> {
    const store = new HistoryStore(options);
    for (const dir of [store.eventsDir, store.snapshotsDir, store.stagingDir, store.writersDir, store.quarantineDir]) {
      await fsp.mkdir(dir, { recursive: true });
    }
    await store.refresh();
    return store;
  }

  get workspaceId(): string { return this.options.workspaceId; }
  get readOnly(): string | undefined { return this.readOnlyReason; }
  get head(): number { return this.fold.head; }
  get gaps(): readonly number[] { return this.fold.gaps; }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Append one event. Appends from this window are published in the order they were made. */
  append(body: HistoryEventBody, options: { eventId?: string } = {}): Promise<DurableAppendResult> {
    const run = this.queue.then(() => this.appendNow(body, options.eventId ?? randomUUID()));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async appendNow(body: HistoryEventBody, eventId: string): Promise<DurableAppendResult> {
    if (this.disposed) return { status: 'failed', reason: 'the history store was closed' };
    const envelope: HistoryEventEnvelope = {
      schemaVersion: HISTORY_SCHEMA_VERSION, eventId, workspaceId: this.options.workspaceId,
      writerId: this.options.writerId, at: new Date(this.now()).toISOString(), body,
    };
    // What is written must read back as the same event; anything the parser would drop is refused here instead.
    const parsed = parseHistoryEnvelope(JSON.parse(JSON.stringify(envelope)));
    if (parsed.status !== 'ok') return { status: 'failed', reason: `the event is not valid (${parsed.status === 'invalid' ? parsed.reason : 'schema'})` };
    const text = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_HISTORY_EVENT_BYTES) return { status: 'failed', reason: 'the event is larger than 4 MiB' };
    try {
      for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
        await this.refresh();
        if (this.readOnlyReason) return { status: 'read-only', reason: this.readOnlyReason };
        const known = this.fold.byEventId.get(eventId);
        if (known !== undefined) return { status: 'duplicate', revision: known, eventId };
        const revision = this.highest + 1;
        try {
          await publishExclusive(path.join(this.stagingDir, `${eventId}.${attempt}.json`), this.revisionPath(revision), text,
            this.publishState, (line) => this.log(line));
        } catch (error) {
          if (error instanceof PublishTakenError) continue;
          throw error;
        }
        this.highest = Math.max(this.highest, revision);
        this.scheduleIdentity();
        await this.refresh();
        let recorded = this.fold.byEventId.get(eventId);
        // A young file another writer left half-written (no hard links) can hold the read back for a moment.
        for (let wait = 0; recorded === undefined && wait < 3; wait++) {
          await this.refresh();
          recorded = this.fold.byEventId.get(eventId);
        }
        void this.compactIfDue();
        if (recorded === revision) return { status: 'durable', revision, eventId };
        if (recorded !== undefined) return { status: 'duplicate', revision: recorded, eventId };
        // Published, but an earlier event another writer is still writing holds the reading back: it is durable and
        // joins the history in its place once that one is complete.
        if (this.loadedThrough < revision) return { status: 'durable', revision, eventId };
        return { status: 'failed', reason: 'the published event did not read back' };
      }
      return { status: 'failed', reason: 'other windows kept taking the next revision' };
    } catch (error) {
      return { status: 'failed', reason: (error as Error).message };
    }
  }

  /** Read what other windows (and this one) published since the last read. */
  refresh(): Promise<void> {
    // A read already under way may have listed the folder before the caller's own publish: run one more after it.
    if (this.refreshing) {
      this.refreshAgain ??= this.refreshing.catch(() => undefined).then(() => {
        this.refreshAgain = undefined;
        return this.refresh();
      });
      return this.refreshAgain;
    }
    this.refreshing = this.readNew().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async readNew(): Promise<void> {
    const before = this.fold.head;
    const beforeGaps = this.fold.gaps.length;
    for (let restart = 0; restart < 3; restart++) {
      const snapshot = await this.newestSnapshot();
      if (snapshot && snapshot.through > this.loadedThrough) {
        this.resetFrom(snapshot.through, snapshot.events, snapshot.gaps);
      }
      const names = await this.listRevisions(this.eventsDir);
      this.highest = Math.max(this.highest, names.at(-1) ?? 0, snapshot?.through ?? 0, this.snapshotThrough);
      let vanished = false;
      for (const revision of names) {
        if (revision <= this.loadedThrough) continue;
        const read = await this.readEvent(revision);
        if (read === 'vanished') { vanished = true; break; }
        if (read === 'pending') break;
        this.loadedThrough = revision;
      }
      if (!vanished) break;
      // A listed event was folded into a snapshot and removed meanwhile: start again from the snapshot.
    }
    const healed = await this.healGaps();
    if (healed || this.fold.head !== before || this.fold.gaps.length !== beforeGaps) {
      this.tasksCache = undefined;
      for (const listener of [...this.listeners]) {
        try { listener(); } catch { /* a listener never breaks the store */ }
      }
    }
  }

  /**
   * A gap whose file now reads as a whole event joins the history in its own place: the fold is rebuilt in revision
   * order, so nothing published later moves ahead of it.
   */
  private async healGaps(): Promise<boolean> {
    const healed: Array<{ revision: number; envelope: HistoryEventEnvelope }> = [];
    for (const gap of this.fold.gaps) {
      let text: string;
      try {
        text = await fsp.readFile(this.revisionPath(gap), 'utf8');
      } catch {
        continue;
      }
      let value: unknown;
      try { value = JSON.parse(text); } catch { continue; }
      const parsed = parseHistoryEnvelope(value);
      if (parsed.status === 'ok' && parsed.envelope.workspaceId === this.options.workspaceId) healed.push({ revision: gap, envelope: parsed.envelope });
    }
    if (healed.length === 0) return false;
    const healedRevisions = new Set(healed.map((entry) => entry.revision));
    const all = [...this.fold.envelopes].map(([revision, envelope]) => ({ revision, envelope })).concat(healed)
      .sort((a, b) => a.revision - b.revision);
    const gaps = this.fold.gaps.filter((gap) => !healedRevisions.has(gap));
    const head = this.fold.head;
    this.fold = new HistoryFold(this.options.physicalKey);
    this.fold.gaps.push(...gaps);
    for (const { revision, envelope } of all) this.fold.apply(revision, envelope);
    this.fold.head = Math.max(this.fold.head, head);
    // The set-aside copy of a healed event is redundant now; it goes, so no stale copy of it outlives a deletion.
    for (const revision of healedRevisions) {
      await fsp.rm(path.join(this.quarantineDir, `${String(revision).padStart(12, '0')}.json`), { force: true }).catch(() => undefined);
    }
    this.log(`Task history: event${healed.length === 1 ? '' : 's'} ${[...healedRevisions].join(', ')} became readable and joined the history.`);
    return true;
  }

  private resetFrom(through: number, events: Array<{ revision: number; envelope: HistoryEventEnvelope }>, snapshotGaps: number[]): void {
    const gaps = [...new Set([...snapshotGaps, ...this.fold.gaps.filter((gap) => gap > through)])];
    this.fold = new HistoryFold(this.options.physicalKey);
    this.fold.gaps.push(...gaps);
    for (const { revision, envelope } of events) this.fold.apply(revision, envelope);
    this.fold.head = Math.max(this.fold.head, through);
    this.loadedThrough = through;
    this.snapshotThrough = through;
  }

  private async readEvent(revision: number): Promise<'ok' | 'pending' | 'vanished' | 'set-aside'> {
    const file = this.revisionPath(revision);
    let text: string;
    let mtimeMs = 0;
    try {
      const stat = await fsp.stat(file);
      mtimeMs = stat.mtimeMs;
      if (stat.size > MAX_HISTORY_EVENT_BYTES + 1024) return this.setAside(revision, file, 'larger than an event can be');
      text = await fsp.readFile(file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return 'vanished';
      // Briefly held by another program (a scanner, a backup): read it on the next refresh.
      if (code === 'EBUSY' || code === 'EACCES' || code === 'EPERM') return 'pending';
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // Possibly another writer still writing it by exclusive create, whatever this reader's own file system does.
      if (this.now() - mtimeMs < PENDING_GRACE_MS) return 'pending';
      return this.setAside(revision, file, 'not JSON');
    }
    const parsed = parseHistoryEnvelope(value);
    if (parsed.status === 'newer-schema') {
      this.readOnlyReason = `a newer UnodeAi wrote this history (schema ${parsed.schemaVersion}); it is shown read-only`;
      this.fold.head = Math.max(this.fold.head, revision);
      return 'ok';
    }
    if (parsed.status === 'invalid' || parsed.envelope.workspaceId !== this.options.workspaceId) {
      return this.setAside(revision, file, parsed.status === 'invalid' ? parsed.reason : 'another workspace');
    }
    this.fold.apply(revision, parsed.envelope);
    return 'ok';
  }

  /**
   * A copy goes aside under its revision; the history shows a gap there. The file itself stays where it is, so its
   * revision number stays taken and no later event can be published under a number a reader has already passed.
   */
  private async setAside(revision: number, file: string, reason: string): Promise<'set-aside'> {
    if (!this.fold.gaps.includes(revision)) this.log(`Task history: event ${revision} could not be read (${reason}); a copy was set aside.`);
    await fsp.copyFile(file, path.join(this.quarantineDir, `${String(revision).padStart(12, '0')}.json`), fsp.constants.COPYFILE_EXCL).catch(() => undefined);
    if (!this.fold.gaps.includes(revision)) this.fold.gaps.push(revision);
    this.fold.head = Math.max(this.fold.head, revision);
    return 'set-aside';
  }

  private async listRevisions(dir: string): Promise<number[]> {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return names.map((name) => REVISION_FILE.exec(name)).filter((m): m is RegExpExecArray => !!m)
      .map((m) => Number(m[1])).sort((a, b) => a - b);
  }

  private revisionPath(revision: number): string {
    return path.join(this.eventsDir, `${String(revision).padStart(12, '0')}.json`);
  }

  private async newestSnapshot(): Promise<{ through: number; events: Array<{ revision: number; envelope: HistoryEventEnvelope }>; gaps: number[] } | undefined> {
    const revisions = (await this.listRevisions(this.snapshotsDir)).reverse();
    for (const through of revisions) {
      if (through <= this.loadedThrough) return undefined;
      try {
        const value = JSON.parse(await fsp.readFile(path.join(this.snapshotsDir, `${String(through).padStart(12, '0')}.json`), 'utf8')) as {
          schemaVersion?: unknown; workspaceId?: unknown; through?: unknown; events?: unknown; gaps?: unknown;
        };
        if (typeof value.schemaVersion === 'number' && value.schemaVersion > HISTORY_SCHEMA_VERSION) {
          this.readOnlyReason = `a newer UnodeAi wrote this history (schema ${value.schemaVersion}); it is shown read-only`;
          continue;
        }
        if (value.schemaVersion !== HISTORY_SCHEMA_VERSION || value.workspaceId !== this.options.workspaceId
          || value.through !== through || !Array.isArray(value.events)) continue;
        const events: Array<{ revision: number; envelope: HistoryEventEnvelope }> = [];
        let valid = true;
        for (const item of value.events as Array<{ revision?: unknown; envelope?: unknown }>) {
          const parsed = parseHistoryEnvelope(item?.envelope);
          if (parsed.status !== 'ok' || typeof item.revision !== 'number' || item.revision > through) { valid = false; break; }
          events.push({ revision: item.revision, envelope: parsed.envelope });
        }
        const gaps = Array.isArray(value.gaps)
          ? value.gaps.filter((gap): gap is number => Number.isSafeInteger(gap) && gap > 0 && gap <= through) : [];
        if (valid) return { through, events, gaps };
      } catch {
        // An unreadable snapshot is skipped; the events it replaced are kept until a readable one exists.
      }
    }
    return undefined;
  }

  /**
   * Fold the events into a snapshot once enough have accumulated. The folded event files then go, but only those the
   * snapshot that was actually published holds as events: whoever won the publication, its content decides, never this
   * window's own candidate. A gap's file always stays, to be read again (and to join the history if it completes).
   */
  private async compactIfDue(options: { force?: boolean } = {}): Promise<CompactionOutcome> {
    const threshold = this.options.compactAfter ?? HISTORY_COMPACT_AFTER;
    if (this.readOnlyReason) return { published: false, problems: [`the history is read-only: ${this.readOnlyReason}`] };
    if (this.loadedThrough <= this.snapshotThrough) return { published: false, problems: [] };
    if (!options.force && this.loadedThrough - this.snapshotThrough < threshold) return { published: false, problems: [] };
    const through = this.loadedThrough;
    // v0.9.110 H1: a snapshot never keeps what was deleted. Revisions whose whole content was deleted are listed as
    // redacted: covered by the snapshot, so their event files go, but not kept in it.
    const events: Array<{ revision: number; envelope: HistoryEventEnvelope }> = [];
    const redacted: number[] = [];
    const changed: Array<[number, HistoryEventEnvelope | undefined]> = [];
    for (const [revision, envelope] of [...this.fold.envelopes].filter(([revision]) => revision <= through).sort(([a], [b]) => a - b)) {
      const kept = this.fold.redact(envelope);
      if (kept) events.push({ revision, envelope: kept }); else redacted.push(revision);
      if (kept !== envelope) changed.push([revision, kept]);
    }
    const gaps = this.fold.gaps.filter((gap) => gap <= through);
    const text = `${JSON.stringify({ schemaVersion: HISTORY_SCHEMA_VERSION, workspaceId: this.options.workspaceId, through, events, gaps, redacted })}\n`;
    const snapshotPath = path.join(this.snapshotsDir, `${String(through).padStart(12, '0')}.json`);
    try {
      await this.options.beforeSnapshotPublish?.(snapshotPath);
      await publishExclusive(path.join(this.stagingDir, `snapshot-${through}.${randomUUID()}.json`), snapshotPath, text, this.publishState);
    } catch (error) {
      if (!(error instanceof PublishTakenError)) {
        this.log(`Task history: snapshot not written (${(error as Error).message}).`);
        return { published: false, problems: [`a copy of the history without the deleted content could not be written (${(error as Error).message})`] };
      }
    }
    // The snapshot that won, read back: only the events it holds may leave as files. Unreadable, nothing is removed.
    const published = await this.readSnapshotCoverage(snapshotPath, through);
    if (!published) return { published: false, problems: ['the copy of the history written for this deletion could not be read back'] };
    const problems: string[] = [];
    // Another window may have won this publication with a copy written before the deletion: it must hold none of it.
    if (await this.snapshotHoldsDeleted(snapshotPath)) problems.push('stale-winner');
    else {
      // Nor does this window hold the deleted content in memory any longer. Only now: until a copy without it is
      // published, a later attempt must still list the revisions it redacts, or their files would never be removed.
      for (const [revision, kept] of changed) {
        if (kept) this.fold.envelopes.set(revision, kept); else this.fold.envelopes.delete(revision);
      }
    }
    this.snapshotThrough = Math.max(this.snapshotThrough, through);
    const keep = new Set([...this.fold.gaps, ...gaps, ...published.gaps]);
    // v0.9.110 H1: after a deletion, an event file the snapshot no longer names (an earlier purge could not remove it,
    // and the snapshot that redacted it is gone) is still found: by what it holds, never by what memory remembers.
    const leftover = new Set<number>();
    if (options.force) {
      for (const revision of await this.listRevisions(this.eventsDir)) {
        if (revision <= through && !published.events.has(revision) && !keep.has(revision) && await this.eventHoldsDeleted(revision)) leftover.add(revision);
      }
    }
    for (const revision of await this.listRevisions(this.eventsDir)) {
      if (revision <= through && (published.events.has(revision) || leftover.has(revision)) && !keep.has(revision)) {
        await fsp.rm(this.revisionPath(revision), { force: true }).catch(() => undefined);
      }
    }
    // After a deletion, an older snapshot may still hold what was deleted: only the one just published stays.
    const snapshots = await this.listRevisions(this.snapshotsDir);
    const older = options.force ? snapshots.filter((revision) => revision < through) : snapshots.slice(0, Math.max(0, snapshots.length - SNAPSHOTS_KEPT));
    for (const old of older) {
      await fsp.rm(path.join(this.snapshotsDir, `${String(old).padStart(12, '0')}.json`), { force: true }).catch(() => undefined);
    }
    if (options.force) {
      // Observed, not assumed: every file that should have gone is looked for.
      const leftEvents = (await this.listRevisions(this.eventsDir))
        .filter((revision) => revision <= through && (published.events.has(revision) || leftover.has(revision)) && !keep.has(revision));
      if (leftEvents.length > 0) problems.push(`${leftEvents.length} older history file(s) could not be removed`);
      const leftSnapshots = (await this.listRevisions(this.snapshotsDir)).filter((revision) => revision < through);
      if (leftSnapshots.length > 0) problems.push(`${leftSnapshots.length} older copy(ies) of the history could not be removed`);
    }
    return { published: true, problems };
  }

  /** v0.9.110 H1: whether one event file still holds deleted content. An unreadable file is a gap's, and is left. */
  private async eventHoldsDeleted(revision: number): Promise<boolean> {
    try {
      const parsed = parseHistoryEnvelope(JSON.parse(await fsp.readFile(this.revisionPath(revision), 'utf8')));
      return parsed.status === 'ok' && this.fold.redact(parsed.envelope) !== parsed.envelope;
    } catch {
      return false;
    }
  }

  /** Whether a published snapshot still holds a deleted message or a deleted task's restore records. */
  private async snapshotHoldsDeleted(file: string): Promise<boolean> {
    try {
      const value = JSON.parse(await fsp.readFile(file, 'utf8')) as { events?: Array<{ envelope?: unknown }> };
      for (const item of value.events ?? []) {
        const parsed = parseHistoryEnvelope(item?.envelope);
        if (parsed.status !== 'ok') continue;
        if (this.fold.redact(parsed.envelope) !== parsed.envelope) return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  /**
   * After a deletion: copies set aside for gaps that have since healed are removed; a gap still unreadable cannot be
   * checked, so it is kept and named in what remains.
   */
  private async purgeQuarantine(): Promise<string[]> {
    let names: string[];
    try { names = await fsp.readdir(this.quarantineDir); } catch { return []; }
    const remaining: string[] = [];
    for (const name of names) {
      const match = /^(\d{12})\.json$/.exec(name);
      if (!match) continue;
      if (this.fold.gaps.includes(Number(match[1]))) { remaining.push(name); continue; }
      await fsp.rm(path.join(this.quarantineDir, name), { force: true }).catch(() => undefined);
    }
    const stillThere = new Set(await fsp.readdir(this.quarantineDir).catch(() => [] as string[]));
    const failed = names.filter((name) => stillThere.has(name) && !remaining.includes(name));
    const lines: string[] = [];
    if (remaining.length > 0) lines.push(`${remaining.length} unreadable history record(s) could not be checked and were kept (${remaining.join(', ')})`);
    if (failed.length > 0) lines.push(`${failed.length} set-aside history record(s) could not be removed (${failed.join(', ')})`);
    return lines;
  }

  /** The revisions a published snapshot holds as events, and the gaps it lists; undefined when it cannot be read whole. */
  private async readSnapshotCoverage(file: string, through: number): Promise<{ events: Set<number>; gaps: number[] } | undefined> {
    try {
      const value = JSON.parse(await fsp.readFile(file, 'utf8')) as { schemaVersion?: unknown; workspaceId?: unknown; through?: unknown;
        events?: unknown; gaps?: unknown; redacted?: unknown };
      if (value.schemaVersion !== HISTORY_SCHEMA_VERSION || value.workspaceId !== this.options.workspaceId || value.through !== through
        || !Array.isArray(value.events)) return undefined;
      const events = new Set<number>();
      for (const item of value.events as Array<{ revision?: unknown; envelope?: unknown }>) {
        if (typeof item?.revision !== 'number' || parseHistoryEnvelope(item.envelope).status !== 'ok') return undefined;
        events.add(item.revision);
      }
      // Revisions whose content was deleted are covered by the snapshot too: their files go.
      if (Array.isArray(value.redacted)) {
        for (const revision of value.redacted) if (Number.isSafeInteger(revision) && revision > 0 && revision <= through) events.add(revision);
      }
      const gaps = Array.isArray(value.gaps) ? value.gaps.filter((gap): gap is number => Number.isSafeInteger(gap)) : [];
      return { events, gaps };
    } catch {
      return undefined;
    }
  }

  // ─── Writer identity and stale staging ─────────────────────────────────────────

  /** After the first write: publish who this writer is, then look for staging a crashed writer left. Once. */
  private scheduleIdentity(): void {
    if (this.identityScheduled || !this.options.identity) return;
    this.identityScheduled = true;
    this.identityTimer = setTimeout(() => {
      this.identityTimer = undefined;
      if (this.disposed) return;
      void this.publishWriterIdentity().then(() => this.removeStaleStaging()).catch((error) => {
        this.log(`Task history: stale staging check did not run (${(error as Error).message}).`);
      });
    }, this.options.identityDelayMs ?? HISTORY_IDENTITY_DELAY_MS);
    (this.identityTimer as { unref?: () => void }).unref?.();
  }

  private async publishWriterIdentity(): Promise<void> {
    const identity = await this.options.identity?.self();
    const record = identity && identity !== 'unknown' ? identity : undefined;
    const file = path.join(this.writersDir, `${this.options.writerId}.json`);
    // Published once and whole; a writer without a provable identity has no record, and its staging is never removed.
    if (record) await writeDurably(file, `${JSON.stringify({ writerId: this.options.writerId, identity: record })}\n`).catch(() => undefined);
  }

  /** Another writer's staging goes only when its process is proven gone. Alive or unknown keeps it. */
  async removeStaleStaging(): Promise<string[]> {
    const removed: string[] = [];
    const identity = this.options.identity;
    if (!identity) return removed;
    let writers: string[];
    try {
      writers = await fsp.readdir(path.dirname(this.stagingDir));
    } catch {
      return removed;
    }
    const candidates: Array<{ writerId: string; record: ProcessIdentityRecord }> = [];
    for (const writerId of writers) {
      if (writerId === this.options.writerId) continue;
      try {
        const stored = JSON.parse(await fsp.readFile(path.join(this.writersDir, `${writerId}.json`), 'utf8')) as { writerId?: unknown; identity?: unknown };
        const record = parseProcessIdentityRecord(stored.identity);
        if (stored.writerId === writerId && record) candidates.push({ writerId, record });
      } catch {
        // No record: the writer never proved who it was. Its staging stays.
      }
    }
    if (candidates.length === 0) return removed;
    const answers = await identity.liveness(candidates.map((candidate) => candidate.record));
    for (const [index, candidate] of candidates.entries()) {
      if (answers[index] !== 'gone') continue;
      await fsp.rm(path.join(path.dirname(this.stagingDir), candidate.writerId), { recursive: true, force: true });
      await fsp.rm(path.join(this.writersDir, `${candidate.writerId}.json`), { force: true });
      removed.push(candidate.writerId);
    }
    return removed;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.identityTimer) clearTimeout(this.identityTimer);
    this.identityTimer = undefined;
    await this.queue.catch(() => undefined);
    await fsp.rm(this.stagingDir, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(path.join(this.writersDir, `${this.options.writerId}.json`), { force: true }).catch(() => undefined);
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  // ─── Reading ───────────────────────────────────────────────────────────────────

  /** Recorded, or recorded and then deleted: either way the same id is never recorded again. */
  hasMessage(messageId: string): boolean {
    return this.fold.messages.has(messageId) || this.fold.tombstoned.has(messageId);
  }

  /** v0.9.110 H1: a message with this content digest was deleted; an older copy of it is not imported again. */
  isTombstonedDigest(digest: string, occurrence = 0): boolean {
    return occurrence < (this.fold.tombstonedDigests.get(digest) ?? 0);
  }

  /** The messages of one task, oldest first; undefined when the task is not (or no longer) in the history. */
  async taskTranscript(historyId: string): Promise<ChatHistoryMessage[] | undefined> {
    const task = await this.task(historyId);
    if (!task) return undefined;
    return task.messageIds.map((id) => this.fold.messages.get(id)).filter((record): record is MessageRecord => !!record)
      .map((record) => ({ ...record.message }));
  }

  /** v0.9.110 H1: what the history holds now, for Manage storage. */
  async usage(): Promise<HistoryUsage> {
    await this.refresh();
    const tasks = this.tasks();
    let bytes = 0;
    for (const task of tasks) bytes += this.taskBytes(task);
    return {
      tasks: tasks.length,
      endedTasks: tasks.filter((task) => task.terminal !== 'running').length,
      favourites: tasks.filter((task) => task.favourite).length,
      running: tasks.filter((task) => task.terminal === 'running').length,
      bytes,
      ...(tasks.length > 0 ? { oldestStartedAt: tasks[tasks.length - 1].startedAt } : {}),
    };
  }

  private taskBytes(task: HistoryTaskV1): number {
    let bytes = 0;
    for (const id of task.messageIds) {
      const record = this.fold.messages.get(id);
      if (record) bytes += Buffer.byteLength(JSON.stringify(record.message), 'utf8');
    }
    return bytes + 256;
  }

  /** Every message id that belongs to no task (a notice before any request, for example), for Delete all. */
  messagesOutsideTasks(): string[] {
    return [...this.fold.messages].filter(([, record]) => !record.historyId).map(([messageId]) => messageId);
  }

  /**
   * v0.9.110 H1 (design §3.3): delete tasks. `view` removes their conversation and they leave the history; `restore-points`
   * withdraws their requests' restore points (the caller removes the bytes); `both`. A tombstone of ids and digests stays.
   * After a deletion of conversations a snapshot without them is published at once, and the event files and older
   * snapshots that held them are removed. Nothing outside the history (workspace files, Spend, approvals, the
   * effect and outcome ledgers) is touched here.
   */
  async deleteTasks(input: { historyIds: readonly string[]; scope: TaskDeletionScope; reason: TaskDeletionReason;
    extraMessageIds?: readonly string[];
    /** Delete all: every restore point of this workspace found in its stores, owned by a task or not. */
    extraRestorePoints?: ReadonlyArray<{ ref: string; path: string }> }):
    Promise<{ status: 'deleted'; result: TaskDeletionResult } | { status: 'failed'; reason: string }> {
    await this.refresh();
    if (this.readOnlyReason) return { status: 'failed', reason: this.readOnlyReason };
    const tasks = this.tasks().filter((task) => input.historyIds.includes(task.historyId));
    // v0.9.110: Delete all also takes the restore points of finished tasks whose conversation was removed earlier. They
    // are no longer listed, but they still own restore points, and reverts may rely on them. A task with no recorded end
    // may still be running and keeps them.
    const hidden = input.reason === 'delete-all' && input.scope !== 'view'
      // From records a removed conversation leaves behind (the request's admission, its end, the deletion), not from the
      // message that began the task: that message is gone after a reload.
      ? [...this.fold.requestOf.keys()].filter((historyId) => this.fold.deletedViews.has(historyId)
        && !this.fold.deletedRestorePoints.has(historyId) && this.fold.outcomes.has(historyId))
      : [];
    const ownRequests = [...tasks.map((task) => task.rootRequestId), ...hidden.map((historyId) => this.fold.requestOf.get(historyId))]
      .filter((id): id is string => !!id);
    // Restore points to remove now: the tasks' own, every removal still owed, and for Delete all the whole inventory.
    const removeNow = new Map<string, string>();
    for (const [ref, held] of this.fold.restoreInventory) {
      if (held.state === 'owed' || (input.reason === 'delete-all' && input.scope !== 'view' && held.state === 'owned')) removeNow.set(ref, held.path);
    }
    // They are recorded as owed with the rest, so a removal that fails or waits is tried again by any later deletion.
    for (const point of input.scope !== 'view' ? input.extraRestorePoints ?? [] : []) {
      if (/^[0-9a-f]{32}$/.test(point.ref) && !removeNow.has(point.ref)) removeNow.set(point.ref, this.fold.restoreInventory.get(point.ref)?.path || point.path);
    }
    const byAgent = new Map<string, { messageIds: Set<string>; digests: Set<string> }>();
    const messages: Array<{ messageId: string; digest: string }> = [];
    const payloadRefs = new Set<string>();
    const deletesView = input.scope !== 'restore-points';
    const take = (messageId: string) => {
      const record = this.fold.messages.get(messageId);
      if (!record) return;
      const digest = legacyMessageDigest(record.message);
      messages.push({ messageId, digest });
      const held = byAgent.get(record.agentId) ?? { messageIds: new Set<string>(), digests: new Set<string>() };
      held.messageIds.add(messageId);
      held.digests.add(digest);
      byAgent.set(record.agentId, held);
    };
    for (const task of tasks) if (deletesView) for (const id of task.messageIds) take(id);
    for (const rootRequestId of input.scope !== 'view' ? ownRequests : []) {
      for (const file of this.fold.recovery.manifest(rootRequestId)?.files ?? []) {
        for (const ref of file.effectRefs) {
          if (/^[0-9a-f]{32}$/.test(ref)) { payloadRefs.add(ref); removeNow.set(ref, this.fold.restoreInventory.get(ref)?.path || file.displayPath); }
        }
      }
    }
    if (deletesView) for (const id of input.extraMessageIds ?? []) take(id);
    // v0.9.110: a revert of these requests can no longer be undone once their restore points go: what it kept of the
    // files before it wrote them (for Undo revert) goes with them.
    if (input.scope !== 'view') {
      const requests = new Set(ownRequests);
      for (const { record, targets } of this.fold.operations.values()) {
        const revert = record.action === 'revert' ? record : record.targetOperationId ? this.fold.operations.get(record.targetOperationId)?.record : undefined;
        if (!revert?.requestIds.some((id) => requests.has(id))) continue;
        for (const target of targets.values()) {
          const ref = target.inverse?.kind === 'file' ? target.inverse.payloadRef : undefined;
          if (ref && /^[0-9a-f]{32}$/.test(ref) && !removeNow.has(ref)) removeNow.set(ref, target.displayPath);
        }
      }
    }
    const historyIds = tasks.map((task) => task.historyId);
    // The event names the hidden tasks too, so their restore points count as deleted (and reverts of them retire).
    const recorded = [...historyIds, ...hidden];
    // One event per bounded batch: the tasks in the first, the messages spread over as many as needed.
    const owed = [...removeNow].map(([ref, filePath]) => ({ ref, path: (filePath || '(file not recorded)').slice(0, 4096) }));
    for (let start = 0; start === 0 || start < messages.length || start < owed.length; start += MAX_DELETION_IDS) {
      const batch = messages.slice(start, start + MAX_DELETION_IDS);
      const payloads = owed.slice(start, start + MAX_DELETION_IDS);
      const result = await this.append({
        kind: 'task-deletion', historyIds: start === 0 ? recorded.slice(0, MAX_DELETION_IDS) : [], scope: input.scope, reason: input.reason,
        messageIds: batch.map((entry) => entry.messageId), digests: batch.map((entry) => entry.digest),
        ...(payloads.length > 0 ? { payloads } : {}),
      });
      if (result.status === 'failed' || result.status === 'read-only') return { status: 'failed', reason: result.reason };
    }
    for (let start = MAX_DELETION_IDS; start < recorded.length; start += MAX_DELETION_IDS) {
      const result = await this.append({ kind: 'task-deletion', historyIds: recorded.slice(start, start + MAX_DELETION_IDS), scope: input.scope,
        reason: input.reason, messageIds: [], digests: [] });
      if (result.status === 'failed' || result.status === 'read-only') return { status: 'failed', reason: result.reason };
    }
    const purge = await this.purge();
    return { status: 'deleted', result: { historyIds, messageIds: messages.map((entry) => entry.messageId), payloadRefs: [...removeNow.keys()], byAgent, purge } };
  }

  /**
   * Remove every copy of deleted content the history holds, and say what could not be removed. A copy another window
   * published from before the deletion is replaced once by a newer copy; nothing is ever claimed removed unseen.
   */
  private async purge(): Promise<PurgeOutcome> {
    let outcome = await this.compactIfDue({ force: true });
    if (outcome.problems.includes('stale-winner')) {
      // A body-free event moves the history on, and a newer copy without the deleted content is written.
      await this.append({ kind: 'task-deletion', historyIds: [], scope: 'view', reason: 'explicit', messageIds: [], digests: [] });
      outcome = await this.compactIfDue({ force: true });
    }
    const remaining = outcome.problems.map((problem) => problem === 'stale-winner'
      ? 'another window wrote a copy of the history that still holds deleted content' : problem);
    remaining.push(...await this.purgeQuarantine());
    if (this.fold.gaps.length > 0) remaining.push(`${this.fold.gaps.length} unreadable history file(s) stay where they are, because they cannot be checked`);
    return { complete: remaining.length === 0, remaining };
  }

  /** v0.9.110 H1: restore points whose removal succeeded (or that were already gone): nothing of them is owed any more. */
  async markRestorePointsRemoved(refs: readonly string[]): Promise<boolean> {
    for (let start = 0; start < refs.length; start += MAX_DELETION_IDS) {
      const result = await this.append({ kind: 'restore-points-removed', refs: refs.slice(start, start + MAX_DELETION_IDS) });
      if (result.status === 'failed' || result.status === 'read-only') return false;
    }
    return true;
  }

  /** v0.9.110 H1: the restore points the history owns and has not removed. */
  ownedRestorePoints(): OwnedRestorePoint[] {
    return [...this.fold.restoreInventory].filter(([, held]) => held.state !== 'removed')
      .map(([ref, held]) => ({ ref, path: held.path, state: held.state as 'owned' | 'owed' }));
  }

  /**
   * v0.9.110 H1 (design §3.3): keep the history within 30 days, 1,000 ended tasks and 16 MiB, whichever comes first, by
   * deleting the oldest ended tasks that are not protected. Running, favourite and `isProtected` tasks (Undo/Redo
   * reachable, from R2) are never deleted, and a favourite is never unmarked. `overflow`: the protected tasks alone
   * are over a limit; nothing more can be deleted for them.
   */
  async housekeep(limits: HistoryHousekeepingLimits = HISTORY_HOUSEKEEPING, isProtected: (task: HistoryTaskV1) => boolean = () => false):
    Promise<{ deleted: string[]; overflow: boolean }> {
    await this.refresh();
    if (this.readOnlyReason) return { deleted: [], overflow: false };
    const tasks = this.tasks();
    const now = this.now();
    let ended = tasks.filter((task) => task.terminal !== 'running').length;
    let bytes = 0;
    const sizes = new Map<string, number>();
    for (const task of tasks) {
      const size = this.taskBytes(task);
      sizes.set(task.historyId, size);
      bytes += size;
    }
    const doomed: string[] = [];
    // Oldest first.
    for (const task of [...tasks].reverse()) {
      if (task.terminal === 'running' || task.favourite || isProtected(task)) continue;
      const time = Date.parse(task.endedAt ?? task.startedAt);
      const tooOld = Number.isFinite(time) && now - time > limits.maxAgeMs;
      if (!tooOld && ended <= limits.maxEndedTasks && bytes <= limits.maxBytes) continue;
      doomed.push(task.historyId);
      ended--;
      bytes -= sizes.get(task.historyId) ?? 0;
    }
    if (doomed.length > 0) {
      const done = await this.deleteTasks({ historyIds: doomed, scope: 'view', reason: 'housekeeping' });
      if (done.status === 'failed') return { deleted: [], overflow: false };
    }
    return { deleted: doomed, overflow: ended > limits.maxEndedTasks || bytes > limits.maxBytes };
  }

  hasLegacyImport(agentId: string, projectionKey: string, observedDigest: string): boolean {
    return this.fold.legacyImports.has(`${agentId}\0${projectionKey}\0${observedDigest}`);
  }

  migrationMarker(agentId: string, projectionKey: string): string | undefined {
    return this.fold.migrated.get(`${agentId}\0${projectionKey}`);
  }

  currentGeneration(agentId: string): string | undefined {
    return this.fold.generation.get(agentId);
  }

  historyIdOfRequest(rootRequestId: string): string | undefined {
    return this.fold.historyOfRequest.get(rootRequestId);
  }

  /** v0.9.110 R2: one recovery operation and its targets, as journaled. */
  recoveryOperation(operationId: string): RecoveryOperationRecord | undefined {
    const held = this.fold.operations.get(operationId);
    return held ? { ...held.record, targets: [...held.targets.values()].map((target) => ({ ...target })) } : undefined;
  }

  /** v0.9.110 R2: every recovery operation, oldest first. */
  recoveryOperations(): RecoveryOperationRecord[] {
    return [...this.fold.operations.keys()].map((id) => this.recoveryOperation(id)!).sort((a, b) => a.revision - b.revision);
  }

  /** v0.9.110 R2: every capture of a physical file, in history order, across requests. */
  capturesOf(physicalTarget: string): CaptureInOrder[] {
    return this.fold.recovery.capturesOf(physicalTarget);
  }

  /** v0.9.110 R2: a physical path as this store compares it (case folded on Windows). */
  physicalKey(physicalTarget: string): string {
    return this.fold.recovery.key(physicalTarget);
  }

  /**
   * v0.9.110 R2 (F1, F6): the recovery notices this member has not received in this conversation view, oldest first.
   * `viewGeneration` defaults to the member's current view. A view that began empty is not told notices recorded
   * before it began; a view replaced by older content (an archive restored, an import) is told again what it lacks.
   * `attached` marks a notice already handed to the backend in this view whose delivery was never confirmed.
   */
  pendingRecoveryNotices(agentId: string, viewGeneration = this.fold.generation.get(agentId) ?? ''):
    Array<Extract<HistoryEventBody, { kind: 'recovery-notice' }> & { attached?: true }> {
    const since = this.fold.emptyViewSince.get(`${agentId}\0${viewGeneration}`);
    return this.fold.notices.filter((notice) => {
      if (this.fold.noticeErased(notice.operationId)) return false;
      if (since !== undefined && (this.fold.noticeRevision.get(notice.noticeId) ?? 0) < since) return false;
      return !this.fold.noticeDeliveries.has(`${notice.noticeId}\0${agentId}\0${viewGeneration}`)
        && !this.fold.noticeDeliveries.has(`${notice.noticeId}\0${agentId}\0*`);
    }).map((notice) => ({ ...structuredClone(notice),
      ...(this.fold.noticeAttachments.has(`${notice.noticeId}\0${agentId}\0${viewGeneration}`) ? { attached: true as const } : {}) }));
  }

  /** v0.9.110 R2 (F1): whether a request was admitted after revision `after`, up to and including `upTo`. */
  requestAdmittedBetween(after: number, upTo: number): boolean {
    return this.fold.admissions.some((revision) => revision > after && revision <= upTo);
  }

  /** v0.9.110 R2 (F3): whether the history shows a request ended, and which window admitted it. */
  requestState(rootRequestId: string): { ended: boolean; writerId?: string } {
    const historyId = this.fold.historyOfRequest.get(rootRequestId);
    const writerId = this.fold.admittedBy.get(rootRequestId);
    return { ended: !!historyId && this.fold.outcomes.has(historyId), ...(writerId ? { writerId } : {}) };
  }

  /** v0.9.110 R2 (F2): whether a notice was recorded for this operation. */
  hasRecoveryNotice(operationId: string): boolean {
    return this.fold.notices.some((notice) => notice.operationId === operationId);
  }

  /** v0.9.110: this operation's revert can no longer be undone or redone: restore points it reverted were deleted. */
  recoveryRetired(operationId: string): boolean {
    return this.fold.recoveryRetired(operationId);
  }

  /** v0.9.110: this operation's notice was erased with a conversation it names, and is not recorded again. */
  recoveryNoticeErased(operationId: string): boolean {
    return this.fold.noticeErased(operationId);
  }

  /** This window's history writer. */
  get writerId(): string {
    return this.options.writerId;
  }

  /**
   * v0.9.110 R2 (F2, F3): whether another window's history writer still runs, from the identity it published. One that
   * never published one is `unknown`; so is one whose identity cannot be checked now.
   */
  async writerLiveness(writerId: string): Promise<'self' | 'alive' | 'gone' | 'unknown'> {
    if (writerId === this.options.writerId) return 'self';
    const identity = this.options.identity;
    if (!identity) return 'unknown';
    try {
      const stored = JSON.parse(await fsp.readFile(path.join(this.writersDir, `${writerId}.json`), 'utf8')) as { writerId?: unknown; identity?: unknown };
      const record = parseProcessIdentityRecord(stored.identity);
      if (stored.writerId !== writerId || !record) return 'unknown';
      const [answer] = await identity.liveness([record]);
      return answer === 'gone' ? 'gone' : answer === 'alive' ? 'alive' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * v0.9.110 R2 (F2): publish this writer's process identity now, before a recovery operation is journaled, so a
   * window that stops in the middle of one can be proven gone by another. Once per store.
   */
  async publishIdentityNow(): Promise<void> {
    this.identityNow ??= this.publishWriterIdentity().catch(() => undefined);
    await this.identityNow;
  }

  /**
   * v0.9.110: the task a Revert can start from, for the chat's row of the request (its result) or of the message that
   * began it. Only a request on the active branch with a recorded file change it can still put back. Read as folded,
   * without reading storage again: it only decides whether a button is shown; Revert itself reads everything again.
   */
  revertStart(ref: { rootRequestId?: string; messageId?: string }): string | undefined {
    const fold = this.fold;
    let historyId = ref.rootRequestId ? fold.historyOfRequest.get(ref.rootRequestId) : undefined;
    if (!historyId && ref.messageId) {
      const record = fold.messages.get(ref.messageId);
      if (record?.historyId && fold.starts.get(record.historyId)?.messageId === ref.messageId) historyId = record.historyId;
    }
    const start = historyId ? fold.starts.get(historyId) : undefined;
    const rootRequestId = historyId ? fold.requestOf.get(historyId) : undefined;
    if (!historyId || !start || !rootRequestId || start.legacy || fold.deletedRestorePoints.has(historyId)) return undefined;
    if (branchAt(fold.branchChanges, start.revision) !== this.activeBranch) return undefined;
    const manifest = fold.recovery.manifest(rootRequestId);
    return manifest && manifest.files.length > 0 ? historyId : undefined;
  }

  /**
   * v0.9.110: when files of this workspace were last put back (a Revert, Undo revert, Redo revert or single-file
   * Restore that changed at least one file). A check or result from before it describes files as they were.
   */
  lastRestoreAt(): string | undefined {
    const fold = this.fold;
    let latest = 0;
    for (const { record } of fold.operations.values()) {
      if (record.closed && record.closed.applied > 0) latest = Math.max(latest, record.closed.revision);
    }
    for (const notice of fold.notices) {
      if (notice.action === 'restore' && notice.targets.length > 0) latest = Math.max(latest, fold.noticeRevision.get(notice.noticeId) ?? 0);
    }
    return latest > 0 ? fold.envelopes.get(latest)?.at : undefined;
  }

  /** v0.9.110 R2: the branch new requests continue on. */
  get activeBranch(): string {
    return this.fold.branchChanges.at(-1)?.branchId ?? 'main';
  }

  /** v0.9.110 R2: one member's tasks, oldest first. */
  async tasksOf(agentId: string): Promise<HistoryTaskV1[]> {
    await this.refresh();
    return this.tasks().filter((task) => task.agentId === agentId).reverse();
  }

  /** v0.9.110 R1: what this request's file changes can be put back to, as recorded. */
  recoveryManifest(rootRequestId: string): RecoveryManifestV1 | undefined {
    const historyId = this.fold.historyOfRequest.get(rootRequestId);
    // v0.9.110 H1: its restore points were deleted; nothing of it can be put back.
    if (historyId && this.fold.deletedRestorePoints.has(historyId)) {
      return { rootRequestId, files: [], notReversed: [], label: 'Not revertible', restorePointsDeleted: true };
    }
    return this.fold.recovery.manifest(rootRequestId);
  }

  /** Every recorded message of a member, oldest first, across its views. */
  messagesOf(agentId: string): Array<{ messageId: string; viewGeneration: string; message: ChatHistoryMessage }> {
    return (this.fold.agentOrder.get(agentId) ?? []).map((messageId) => {
      const record = this.fold.messages.get(messageId)!;
      return { messageId, viewGeneration: record.viewGeneration, message: { ...record.message } };
    });
  }

  async task(historyId: string): Promise<HistoryTaskV1 | undefined> {
    await this.refresh();
    return this.tasks().find((task) => task.historyId === historyId);
  }

  async query(filter: HistoryFilter = {}, cursor?: string): Promise<HistoryPage> {
    await this.refresh();
    const text = filter.text?.trim().toLocaleLowerCase();
    const matching = this.tasks().filter((task) =>
      (!filter.agentId || task.agentId === filter.agentId)
      && (!filter.terminal || task.terminal === filter.terminal)
      && (!filter.verification || task.verification === filter.verification)
      && (filter.favourite === undefined || task.favourite === filter.favourite)
      && (!filter.since || task.startedAt >= filter.since)
      && (!filter.until || task.startedAt <= filter.until)
      && (!text || task.goal.toLocaleLowerCase().includes(text) || (task.conclusion ?? '').toLocaleLowerCase().includes(text)));
    const offset = decodeCursor(cursor);
    const page = matching.slice(offset, offset + HISTORY_PAGE_SIZE);
    return {
      tasks: page,
      ...(offset + HISTORY_PAGE_SIZE < matching.length ? { nextCursor: encodeCursor(offset + HISTORY_PAGE_SIZE) } : {}),
      gaps: [...this.fold.gaps].sort((a, b) => a - b),
      ...(this.readOnlyReason ? { readOnly: this.readOnlyReason } : {}),
    };
  }

  /** Change a task's favourite mark against the revision it was read at; a newer task revision refuses it. */
  async setFavourite(historyId: string, expectedRevision: number, value: boolean): Promise<void> {
    await this.refresh();
    const actual = this.fold.taskRevision.get(historyId);
    if (!this.fold.starts.has(historyId) || actual !== expectedRevision) throw new HistoryConflictError(historyId, expectedRevision, actual);
    const result = await this.append({ kind: 'favourite', historyId, value, expectedRevision });
    if (result.status === 'read-only' || result.status === 'failed') throw new Error(`The favourite was not saved: ${result.reason}.`);
    if (this.fold.favourites.get(historyId) !== value) throw new HistoryConflictError(historyId, expectedRevision, this.fold.taskRevision.get(historyId));
  }

  /** Tasks, newest first. */
  private tasks(): HistoryTaskV1[] {
    if (this.tasksCache) return this.tasksCache;
    const fold = this.fold;
    const tasks: HistoryTaskV1[] = [];
    const segments = new Map<string, string[]>();
    for (const [messageId, record] of fold.messages) {
      if (!record.historyId) continue;
      const list = segments.get(record.historyId) ?? [];
      list.push(messageId);
      segments.set(record.historyId, list);
    }
    for (const historyId of [...fold.taskOrder].reverse()) {
      const start = fold.starts.get(historyId)!;
      // A deleted conversation leaves the history; so does a task whose first message was deleted.
      if (fold.deletedViews.has(historyId) || !fold.messages.has(start.messageId)) continue;
      const messageIds = (segments.get(historyId) ?? []).sort((a, b) => fold.messages.get(a)!.revision - fold.messages.get(b)!.revision);
      const startMessage = fold.messages.get(start.messageId)!.message;
      let conclusion: ChatHistoryMessage | undefined;
      for (const id of messageIds) {
        const message = fold.messages.get(id)!.message;
        if (message.role === 'agent' && message.turnFinal === true) conclusion = message;
      }
      const outcome = fold.outcomes.get(historyId);
      const rootRequestId = fold.requestOf.get(historyId);
      const running = !outcome && !!rootRequestId && (this.options.isRequestRunning?.(rootRequestId) ?? false);
      tasks.push({
        schemaVersion: 1,
        historyId,
        workspaceId: this.options.workspaceId,
        branchId: branchAt(fold.branchChanges, start.revision),
        ...(rootRequestId ? { rootRequestId } : {}),
        agentId: start.agentId,
        transcriptRef: `${start.agentId}/${start.viewGeneration}`,
        outcomeRefs: outcome ? [...outcome.refs] : [],
        ...(rootRequestId && fold.recovery.has(rootRequestId) ? { recoveryManifestRef: rootRequestId } : {}),
        startedAt: startMessage.ts,
        ...(outcome ? { endedAt: outcome.endedAt } : {}),
        terminal: outcome ? outcome.terminal : running ? 'running' : 'unfinished',
        verification: outcome ? outcome.verification : 'unknown',
        favourite: fold.favourites.get(historyId) ?? false,
        goal: startMessage.text,
        ...(conclusion ? { conclusion: conclusion.text } : {}),
        legacy: start.legacy,
        revision: fold.taskRevision.get(historyId) ?? start.revision,
        messageIds,
      });
    }
    this.tasksCache = tasks;
    return tasks;
  }
}

/** The branch that was the tip when a task began. */
function branchAt(changes: ReadonlyArray<{ revision: number; branchId: string }>, revision: number): string {
  let branch = 'main';
  for (const change of changes) {
    if (change.revision >= revision) break;
    branch = change.branchId;
  }
  return branch;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; offset?: unknown };
    return value.v === 1 && typeof value.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0 ? value.offset : 0;
  } catch {
    return 0;
  }
}
