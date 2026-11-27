/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the chat's link to the canonical task history (v0.9.110 H0)
 *
 *  The chat view keeps its 50-message window and calls this at each change of a member's conversation. Each
 *  call is recorded as one history event, in the order the calls were made, once the store is open. A change
 *  that cannot be recorded leaves the visible conversation as it is and is reported once per member, as
 *  "this task's history was not saved"; work is never stopped for it.
 *
 *  No `vscode` import.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
import { chatHistoryKey, serializeChatHistory, type ChatHistoryMessage } from '../views/chatHistory';
import type { DurableAppendResult, HistoryStore } from './HistoryStore';
import type { HistoryTaskV1, TaskDeletionScope } from './HistoryRecords';
import type { HistoryEventBody, HistoryMessageEntry, HistoryTerminal, HistoryVerification, ViewReplacedReason } from './HistoryRecords';
import { LegacyChatProjectionBridge, type BridgeStatePort } from './LegacyChatProjectionBridge';
import type { RequestChangesObservation, RequestCloseoutRecordV1 } from '../observability/RequestCloseout';
import { recoveryLabel, type RecoveryManifestV1, type RecoveryObserver } from './RecoveryManifest';
import type { RecoveryNoticeV1 } from './RecoveryNotice';
import type { HistoryFileState } from './HistoryRecords';
import { releasableRecoveryOperations, undoRedoReachableRequests } from './TaskRecovery';

/** What the chat view calls. Every method returns at once; recording happens in order, later. */
export interface ChatHistorySink {
  /** The first time this window reads a member's chat key. */
  observe(agentId: string): void;
  /** What the chat shows from the key at its first read: a stale copy of messages that left it is not shown again. */
  visibleProjection(agentId: string, messages: ChatHistoryMessage[]): ChatHistoryMessage[];
  /** Just before the window writes the key: messages another version added there meanwhile, to keep in the view. */
  beforeProjectionWrite(agentId: string): ChatHistoryMessage[];
  /** Just after the window wrote the key. */
  projectionWritten(agentId: string, value: readonly ChatHistoryMessage[] | undefined): void;
  messageAppended(agentId: string, message: ChatHistoryMessage, startsTask?: { historyId: string }): void;
  messagePatched(agentId: string, message: ChatHistoryMessage): void;
  viewReplaced(agentId: string, reason: ViewReplacedReason, messages: readonly ChatHistoryMessage[]): void;
}

export interface HistoryServiceDeps {
  /** Opens the store once; undefined when this workspace has no history (it could not be opened). */
  open: () => Promise<HistoryStore | undefined>;
  state: BridgeStatePort;
  /** Told once per member when a change of its conversation could not be recorded. */
  onNotSaved?: (agentId: string, reason: string) => void;
  log?: (line: string) => void;
  /**
   * v0.9.110 H1: removes restore points (raw entries) of deleted tasks. An entry still in use (pinned) is kept and
   * named back. Absent: restore points cannot be removed in this window.
   */
  restorePoints?: {
    /**
     * `removed`: neither entry nor bytes are left (also when they were already gone); `kept`: still in use (pinned);
     * `failed`: their bytes are still on disk. Kept and failed ones stay owed and are tried again by a later deletion.
     */
    remove(ids: readonly string[]): Promise<{ removed: string[]; kept: string[]; failed?: string[] }>;
    /**
     * v0.9.110 H1 (Delete all): every restore point of this workspace, in every store of it, owned by a task or not.
     * `unlisted`: a store of it that could not be inspected, and so what stays on disk.
     */
    all?(): Promise<{ points: Array<{ ref: string; path: string }>; unlisted?: string }>;
    /** v0.9.110 H1 (favourites): exactly these entries are held for the history; others it held are let go. */
    protect?(ids: ReadonlySet<string>): Promise<void>;
    /**
     * v0.9.110 (Delete all): the other copies this computer keeps of this workspace's work: the Edit history's records
     * (their text copies included) and the archived chats. Records of running work, and those whose restore point is
     * still in use, are kept.
     */
    deleteLocalCopies?(): Promise<{ editHistoryRecords: number; archivedChats: number }>;
    /** Which of these entries still hold their bytes. */
    available?(ids: readonly string[]): Promise<ReadonlySet<string>>;
    /**
     * v0.9.110: let go of what these finished recovery operations hold for Undo revert / Redo revert. Their bytes then
     * age out or are deleted like any other restore point.
     */
    releaseOperations?(operationIds: readonly string[]): Promise<void>;
    /**
     * v0.9.110: the person deletes these restore points: what the recovery operations in `finished` hold of them is
     * let go first (their Undo revert / Redo revert then cannot put those files back). Any other hold stays.
     */
    releaseRecoveryHolds?(ids: readonly string[], finished: ReadonlySet<string>): Promise<void>;
  };
  /** v0.9.110 H1: the chat drops deleted messages from the conversation it shows. */
  onMessagesDeleted?: (agentId: string, messageIds: ReadonlySet<string>, digests: ReadonlySet<string>) => void;
  /** v0.9.110 H1: told once per window when protected tasks alone fill the history's room. */
  onStorageFull?: () => void;
  /** v0.9.110 H1: tasks housekeeping must keep besides running, favourite and Undo/Redo-reachable ones. */
  isProtected?: (task: HistoryTaskV1) => boolean;
  now?: () => number;
}

/** What a deletion did, for the person: deleted, kept because still in use, and what is not history at all. */
export interface HistoryDeletionReport {
  /** `partial`: some copy of the deleted content, or a restore point no longer in use, could not be removed. */
  status: 'deleted' | 'partial' | 'failed';
  reason?: string;
  tasksDeleted: number;
  messagesDeleted: number;
  restorePointsRemoved: number;
  /** Restore points still in use by running work (pinned): kept, to be deleted once that work ends. */
  restorePointsKept: number;
  /** The files whose restore points are still in use, for the person to act on. */
  restorePointsKeptFiles: string[];
  /** Restore points whose bytes could not be removed from disk; they stay owed (and are named in `remaining`). */
  restorePointsFailed: number;
  /** What of the deleted content could not be removed. */
  remaining: string[];
  /** Delete all: running tasks kept, with their conversation. */
  runningTasksKept: number;
  /** v0.9.110 Delete all: the Edit history records and archived chats removed with it. */
  localCopiesRemoved?: { editHistoryRecords: number; archivedChats: number };
}

/** How often housekeeping runs at most. */
export const HISTORY_HOUSEKEEPING_INTERVAL_MS = 10 * 60 * 1000;

export class HistoryService implements ChatHistorySink {
  private storePromise: Promise<HistoryStore | undefined> | undefined;
  /** The store once open, for what must be read without waiting (the notices a request carries). */
  private opened: HistoryStore | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly generation = new Map<string, string>();
  private readonly toldNotSaved = new Set<string>();
  private lastHousekeeping = Number.NEGATIVE_INFINITY;
  private toldStorageFull = false;
  /** The agent of each recovery capture, so a failed settle is reported to the right member. */
  private readonly captureAgents = new Map<string, string>();
  readonly bridge: LegacyChatProjectionBridge;

  constructor(private readonly deps: HistoryServiceDeps) {
    this.bridge = new LegacyChatProjectionBridge({
      state: deps.state,
      store: () => this.store(),
      newGeneration: () => randomUUID(),
      schedule: (work) => this.enqueue(work),
      log: deps.log,
    });
  }

  /** v0.9.110: the store once it opened, for what the chat marks on its rows; undefined before. */
  get openedStore(): HistoryStore | undefined {
    return this.opened;
  }

  store(): Promise<HistoryStore | undefined> {
    this.storePromise ??= this.deps.open().then((store) => { this.opened = store; return store; }, (error) => {
      this.deps.log?.(`Task history is not available in this window: ${(error as Error).message}`);
      return undefined;
    });
    return this.storePromise;
  }

  observe(agentId: string): void {
    this.bridge.observe(agentId);
  }

  visibleProjection(agentId: string, messages: ChatHistoryMessage[]): ChatHistoryMessage[] {
    return this.bridge.visibleProjection(agentId, messages);
  }

  /** Window focus: another version may have written while this window was in the background. */
  reconcileAll(agentIds: readonly string[]): void {
    for (const agentId of agentIds) this.enqueue(() => this.bridge.reconcile(agentId));
  }

  /** One queue for every write of this window, in the order it was asked for. */
  private enqueue(work: () => Promise<unknown>): void {
    void this.run(work);
  }

  /** `enqueue`, with the work's own result. */
  private run<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * v0.9.110 H1: delete tasks (design §3.3): `view`, `restore-points` or `both`. Never workspace files, Spend, approvals
   * or the effect and outcome ledgers. Restore points still in use stay and are counted as kept.
   */
  deleteTasks(historyIds: readonly string[], scope: TaskDeletionScope): Promise<HistoryDeletionReport> {
    return this.run(async () => {
      const store = await this.store();
      if (!store) return failedReport('task history is not available in this window');
      return this.deleteNow(store, historyIds, scope, 'explicit', []);
    });
  }

  /**
   * v0.9.110 H1 (design §5): Delete all history and restore points of this workspace, favourites included. Tasks still
   * running keep their conversation and are counted as kept; their restore points in use stay too. Observations of
   * the older chat key still waiting for import go as well.
   */
  deleteAll(agentIds: readonly string[]): Promise<HistoryDeletionReport> {
    return this.run(async () => {
      const store = await this.store();
      if (!store) return failedReport('task history is not available in this window');
      const all = [];
      for (let page = await store.query(); ; ) {
        all.push(...page.tasks);
        if (!page.nextCursor) break;
        page = await store.query({}, page.nextCursor);
      }
      const running = all.filter((task) => task.terminal === 'running');
      const ids = all.filter((task) => task.terminal !== 'running').map((task) => task.historyId);
      // Every restore point of this workspace, also those no task of the history knows (an older version's).
      const listed = await this.deps.restorePoints?.all?.().catch((error: Error) => {
        this.deps.log?.(`Task history: the restore points of this workspace could not be listed (${error.message}).`);
        return undefined;
      });
      const report = await this.deleteNow(store, ids, 'both', 'delete-all', store.messagesOutsideTasks(), listed?.points ?? []);
      const unlisted = this.deps.restorePoints?.all && !listed
        ? 'the restore points of this workspace could not be listed; those no task names may be left'
        : listed?.unlisted;
      if (unlisted) {
        report.status = report.status === 'failed' ? 'failed' : 'partial';
        report.remaining.push(unlisted);
      }
      for (const agentId of agentIds) this.bridge.forgetPending(agentId);
      // After the restore points: a record whose restore point could not go is still in use, and stays.
      let localCopiesRemoved: HistoryDeletionReport['localCopiesRemoved'];
      if (this.deps.restorePoints?.deleteLocalCopies) {
        try {
          localCopiesRemoved = await this.deps.restorePoints.deleteLocalCopies();
        } catch (error) {
          report.status = report.status === 'failed' ? 'failed' : 'partial';
          report.remaining.push(`the Edit history and archived chats could not be deleted (${(error as Error).message})`);
        }
      }
      return { ...report, runningTasksKept: running.length, ...(localCopiesRemoved ? { localCopiesRemoved } : {}) };
    });
  }

  private async deleteNow(store: HistoryStore, historyIds: readonly string[], scope: TaskDeletionScope,
    reason: 'explicit' | 'delete-all', extraMessageIds: readonly string[],
    extraRestorePoints: ReadonlyArray<{ ref: string; path: string }> = []): Promise<HistoryDeletionReport> {
    const done = await store.deleteTasks({ historyIds, scope, reason, extraMessageIds, extraRestorePoints });
    if (done.status === 'failed') return failedReport(done.reason);
    const { result } = done;
    let removed = 0;
    let failed: string[] = [];
    const remaining = [...result.purge.remaining];
    // The history's own hold on favourites is updated first: a deleted favourite's restore points are not held for it.
    await this.syncProtectionNow(store);
    if (result.payloadRefs.length > 0) {
      // v0.9.110: so are finished reverts' holds on them, as the confirmation said Undo/Redo would stop working.
      const finished = new Set(store.recoveryOperations().filter((operation) => operation.closed).map((operation) => operation.operationId));
      await this.deps.restorePoints?.releaseRecoveryHolds?.(result.payloadRefs, finished)
        .catch((error: Error) => this.deps.log?.(`Task history: restore points held for Undo revert were not let go (${error.message}).`));
      if (this.deps.restorePoints) {
        const outcome = await this.deps.restorePoints.remove(result.payloadRefs)
          .catch(() => ({ removed: [] as string[], kept: [] as string[], failed: [...result.payloadRefs] }));
        removed = outcome.removed.length;
        failed = outcome.failed ?? [];
        // Only a removal that succeeded clears what is owed; the rest stays owed in the history and is tried again.
        if (outcome.removed.length > 0 && !await store.markRestorePointsRemoved(outcome.removed)) {
          remaining.push('the removal of restore points could not be recorded; deleting again finishes it');
        }
      } else {
        remaining.push('restore points cannot be removed in this window; they stay owed and are removed by a later deletion');
      }
    }
    for (const [agentId, deleted] of result.byAgent) {
      try { this.deps.onMessagesDeleted?.(agentId, deleted.messageIds, deleted.digests); } catch { /* the deletion stands */ }
    }
    const owed = store.ownedRestorePoints().filter((point) => point.state === 'owed');
    const failing = new Set(failed);
    const failedPoints = owed.filter((point) => failing.has(point.ref));
    if (failedPoints.length > 0) {
      remaining.push(`${failedPoints.length} restore point(s) could not be removed from disk (${failedPoints.map((point) => point.path).join(', ')})`);
    }
    const inUse = owed.filter((point) => !failing.has(point.ref));
    return { status: remaining.length > 0 ? 'partial' : 'deleted', tasksDeleted: result.historyIds.length, messagesDeleted: result.messageIds.length,
      restorePointsRemoved: removed, restorePointsKept: inUse.length, restorePointsKeptFiles: inUse.map((point) => point.path),
      restorePointsFailed: failedPoints.length, remaining, runningTasksKept: 0 };
  }

  /**
   * v0.9.110 H1 (design §3.3): a favourite task's restore points are protected like its conversation. The raw store
   * holds exactly the favourites' entries for the history (durably, across reloads); unmarking lets them go.
   */
  syncProtection(): Promise<void> {
    return this.run(async () => {
      const store = await this.store();
      if (store) await this.syncProtectionNow(store);
    });
  }

  private async syncProtectionNow(store: HistoryStore): Promise<void> {
    if (!this.deps.restorePoints?.protect) return;
    const wanted = new Set<string>();
    for (let page = await store.query({ favourite: true }); ; ) {
      for (const task of page.tasks) {
        const manifest = task.rootRequestId ? store.recoveryManifest(task.rootRequestId) : undefined;
        for (const file of manifest?.files ?? []) for (const ref of file.effectRefs) if (/^[0-9a-f]{32}$/.test(ref)) wanted.add(ref);
      }
      if (!page.nextCursor) break;
      page = await store.query({ favourite: true }, page.nextCursor);
    }
    await this.deps.restorePoints.protect(wanted).catch((error: Error) => this.deps.log?.(`Task history: favourite restore points not held (${error.message}).`));
  }

  /**
   * v0.9.110 H1: the request's restore manifest, true to what is still kept: a file whose restore point is gone is not
   * shown as revertible.
   */
  async checkedManifest(rootRequestId: string): Promise<RecoveryManifestV1 | undefined> {
    const store = await this.store();
    const manifest = store?.recoveryManifest(rootRequestId);
    if (!manifest || manifest.restorePointsDeleted || !this.deps.restorePoints?.available) return manifest;
    const refs = manifest.files.map((file) => (file.before.kind === 'file' ? file.before.payloadRef : undefined)).filter((ref): ref is string => !!ref);
    if (refs.length === 0) return manifest;
    const available = await this.deps.restorePoints.available(refs).catch(() => new Set<string>());
    const files = manifest.files.map((file) => {
      const ref = file.before.kind === 'file' ? file.before.payloadRef : undefined;
      return ref && !available.has(ref) ? { ...file, coverage: 'unknown' as const, reason: 'its restore point is no longer kept' } : file;
    });
    return { ...manifest, files, label: recoveryLabel(files, manifest.notReversed) };
  }

  /**
   * v0.9.110 H1: housekeeping (30 days, 1,000 ended tasks, 16 MiB), at most every ten minutes, in the history's order.
   * When protected tasks alone fill the room, the person is told once, with where to manage it.
   */
  housekeep(force = false): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    if (!force && now - this.lastHousekeeping < HISTORY_HOUSEKEEPING_INTERVAL_MS) return Promise.resolve();
    this.lastHousekeeping = now;
    return this.run(async () => {
      const store = await this.store();
      if (!store) return;
      // v0.9.110 (deviation 8): a task an Undo revert or Redo revert can still reach keeps its conversation.
      // Read again first, so a revert another window made counts.
      await store.refresh().catch(() => undefined);
      const reachable = undoRedoReachableRequests(store);
      // What reverts no Undo revert or Redo revert can use any more no longer holds its restore points.
      await this.deps.restorePoints?.releaseOperations?.(releasableRecoveryOperations(store))
        .catch((error: Error) => this.deps.log?.(`Task history: restore points held for Undo revert were not let go (${error.message}).`));
      const outcome = await store.housekeep(undefined, (task) => (!!task.rootRequestId && reachable.has(task.rootRequestId))
        || (this.deps.isProtected?.(task) ?? false)).catch(() => undefined);
      if (!outcome) return;
      if (outcome.deleted.length > 0) this.deps.log?.(`Task history: housekeeping removed ${outcome.deleted.length} old task(s).`);
      if (outcome.overflow && !this.toldStorageFull) {
        this.toldStorageFull = true;
        try { this.deps.onStorageFull?.(); } catch { /* a notice never breaks housekeeping */ }
      }
    });
  }

  beforeProjectionWrite(agentId: string): ChatHistoryMessage[] {
    return this.bridge.beforeWrite(agentId);
  }

  projectionWritten(agentId: string, value: readonly ChatHistoryMessage[] | undefined): void {
    this.bridge.written(agentId, value);
  }

  messageAppended(agentId: string, message: ChatHistoryMessage, startsTask?: { historyId: string }): void {
    const stored = storedMessage(message);
    if (!stored) return;
    this.record(agentId, (store) => ({
      kind: 'transcript-append', agentId, viewGeneration: this.generationOf(agentId, store), messageId: stored.messageId!,
      message: stored, ...(startsTask && message.role === 'user' ? { startsTask: { historyId: startsTask.historyId } } : {}),
    }));
  }

  messagePatched(agentId: string, message: ChatHistoryMessage): void {
    const stored = storedMessage(message);
    if (!stored) return;
    this.record(agentId, () => ({ kind: 'transcript-patch', agentId, messageId: stored.messageId!, message: stored }));
  }

  viewReplaced(agentId: string, reason: ViewReplacedReason, messages: readonly ChatHistoryMessage[]): void {
    const viewGeneration = randomUUID();
    const entries: HistoryMessageEntry[] = [];
    for (const message of messages) {
      const stored = storedMessage(message);
      if (stored) entries.push({ messageId: stored.messageId!, message: stored });
    }
    this.generation.set(agentId, viewGeneration);
    this.record(agentId, () => ({ kind: 'view-replaced', agentId, viewGeneration, reason, messages: entries }));
  }

  /** The host admitted the top-level request a chat message began. */
  requestAdmitted(agentId: string, historyId: string, rootRequestId: string): void {
    this.record(agentId, () => ({ kind: 'request-admitted', historyId, rootRequestId, agentId }), { eventId: `req-${rootRequestId}` });
  }

  /**
   * A request's closeout record was written or revised: the history refers to it, the record stays the authority. The
   * request's task is looked up in the history's own order, after the admission this window recorded before it, so a
   * closeout that arrives while that admission is still being written is not lost.
   */
  outcomeRecorded(record: RequestCloseoutRecordV1): void {
    const agentId = record.rootAgentId;
    this.enqueue(async () => {
      const store = await this.store();
      if (!store) return this.notSaved(agentId, 'task history is not available in this window');
      await store.refresh();
      const historyId = store.historyIdOfRequest(record.requestId);
      // A request no chat message began (a workflow, a host-started turn) has no task to refer to.
      if (!historyId) return;
      const result = await store.append({
        kind: 'outcome-reference', historyId, outcomeRef: record.recordId as string,
        terminal: historyTerminal(record), verification: historyVerification(record), endedAt: record.recordedAt,
      }, { eventId: `outcome-${createHash('sha256').update(`${record.recordId}\0${record.revision}`).digest('hex').slice(0, 40)}` })
        .catch((error: Error) => ({ status: 'failed' as const, reason: error.message }));
      if (result.status === 'failed' || result.status === 'read-only') this.notSaved(agentId, result.reason);
    });
    void this.housekeep();
  }

  /**
   * v0.9.110 R1: a request's change took (or could not take) its restore point. v0.9.110 H1: when restore points can be
   * held, the returned promise settles once the history has taken this capture in and, for a favourite task, holds
   * its restore point; the request keeps its own hold until then, so nothing can drop the bytes in between.
   */
  recoveryCaptured(capture: Parameters<RecoveryObserver['captured']>[0]): Promise<void> | undefined {
    this.captureAgents.set(capture.targetId, capture.agentId);
    if (this.captureAgents.size > 10_000) this.captureAgents.delete(this.captureAgents.keys().next().value as string);
    this.record(capture.agentId, () => ({ kind: 'recovery-capture', ...capture }), { eventId: `rc-${capture.targetId}` });
    // v0.9.110 H1: a task marked favourite while it runs keeps what it captures later, before its request lets go.
    if (!this.deps.restorePoints?.protect) return undefined;
    return this.run(async () => {
      const store = await this.store();
      const historyId = store?.historyIdOfRequest(capture.rootRequestId);
      if (store && historyId && (await store.task(historyId))?.favourite) await this.syncProtectionNow(store);
    }).catch(() => undefined);
  }

  /** v0.9.110 R1: how that change ended, read back. */
  recoverySettled(settle: Parameters<RecoveryObserver['settled']>[0]): void {
    this.record(this.captureAgents.get(settle.targetId) ?? '', () => ({ kind: 'recovery-settle', ...settle }), { eventId: `rs-${settle.targetId}` });
  }

  /**
   * v0.9.110 R1: what the host observed of a request's file effects. Effects it could not keep a restore point for are
   * listed in the request's manifest as not reversed: anything a command, shell or provider-native action ran, and
   * each file a provider's own tool changed. `nativeKeys` gives the host's key of those files by path: a file this
   * request also kept an exact restore point of is then not listed (the manifest decides, whichever came first).
   */
  effectsObserved(requestId: string, agentId: string, changes: RequestChangesObservation, nativeKeys: Record<string, string> = {}): void {
    const id = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 40);
    if (changes.notCovered) {
      this.record(agentId, () => ({ kind: 'recovery-uncovered', rootRequestId: requestId, effect: 'command',
        reason: 'A command, a shell or a provider\'s own action ran in this request; file changes it made have no restore point.' }),
      { eventId: `ru-${id(`${requestId}\0command`)}` });
    }
    for (const file of changes.files) {
      if (file.evidence !== 'native-observed') continue;
      const key = Object.prototype.hasOwnProperty.call(nativeKeys, file.path) ? nativeKeys[file.path] : undefined;
      this.record(agentId, () => ({ kind: 'recovery-uncovered', rootRequestId: requestId, effect: 'native-tool', path: file.path,
        ...(key ? { physicalKey: key } : {}),
        reason: 'Changed by the provider\'s own file tool; no exact restore point was taken before it.' }),
      { eventId: `ru-${id(`${requestId}\0native\0${file.path}`)}` });
    }
  }

  /**
   * v0.9.110 R2 (F1, F6): the recovery notices this member has not received in its current conversation view, read
   * again from storage first, so a restore made in another window reaches this member's next request.
   */
  async pendingRecoveryNotices(agentId: string): Promise<RecoveryNoticeV1[]> {
    return (await this.pendingRecoveryNoticesFresh(agentId)).notices;
  }

  /** The same, with the view they are pending in: attach and delivery are recorded against that view. */
  async pendingRecoveryNoticesFresh(agentId: string): Promise<{ viewGeneration: string; notices: RecoveryNoticeV1[] }> {
    const store = await this.store();
    if (!store) return { viewGeneration: '', notices: [] };
    await store.refresh().catch((error: unknown) => this.deps.log?.(`Task history could not be read again: ${(error as Error).message}`));
    const viewGeneration = this.generationOf(agentId, store);
    return { viewGeneration, notices: store.pendingRecoveryNotices(agentId, viewGeneration) };
  }

  /**
   * v0.9.110 R2 (F6): these notices were handed to the member's backend with this request, in this view. They stay
   * pending until the backend reports the request taken: a request stopped or failed before that tells them again.
   */
  recoveryNoticesAttached(agentId: string, noticeIds: readonly string[], requestId: string, viewGeneration: string): void {
    if (noticeIds.length === 0 || !viewGeneration) return;
    this.record(agentId, () => ({ kind: 'recovery-notice-attached', noticeIds: [...noticeIds], agentId, requestId, viewGeneration }),
      { eventId: `na-${createHash('sha256').update(`${requestId}\0${agentId}\0${viewGeneration}`).digest('hex').slice(0, 40)}` });
  }

  /**
   * v0.9.110 R2: the backend took the request carrying these notices. Once per notice, member and conversation view; a
   * view replaced later (an archive restored) is told again what it lacks.
   */
  recoveryNoticesDelivered(agentId: string, noticeIds: readonly string[], requestId: string, viewGeneration?: string): void {
    const view = viewGeneration || this.generation.get(agentId) || this.opened?.currentGeneration(agentId);
    for (const noticeId of noticeIds) {
      this.record(agentId, (store) => {
        const generation = view ?? this.generationOf(agentId, store);
        return { kind: 'recovery-notice-delivered', noticeId, agentId, requestId, viewGeneration: generation };
      }, { eventId: `nd-${createHash('sha256').update(`${noticeId}\0${agentId}\0${view ?? requestId}`).digest('hex').slice(0, 40)}` });
    }
  }

  /** v0.9.110 R2: a single-file restore is told to every member like a revert. */
  restoreNotice(input: { physicalTarget: string; displayPath: string; removed: boolean; current: HistoryFileState }): void {
    const noticeId = randomUUID();
    this.record('', () => ({ kind: 'recovery-notice', noticeId, operationId: noticeId, action: 'restore',
      targets: [{ physicalTarget: input.physicalTarget, displayPath: input.displayPath, state: input.removed ? 'removed' : 'before-request', current: input.current }],
      conflicts: [], notReversed: 0 }), { eventId: `rn-${noticeId}` });
  }

  private generationOf(agentId: string, store: HistoryStore): string {
    let generation = this.generation.get(agentId) ?? store.currentGeneration(agentId);
    if (!generation) generation = randomUUID();
    this.generation.set(agentId, generation);
    return generation;
  }

  private record(agentId: string, build: (store: HistoryStore) => HistoryEventBody, options: { eventId?: string } = {}): void {
    this.enqueue(async () => {
      const store = await this.store();
      if (!store) return this.notSaved(agentId, 'task history is not available in this window');
      let result: DurableAppendResult;
      try {
        result = await store.append(build(store), options);
      } catch (error) {
        return this.notSaved(agentId, (error as Error).message);
      }
      if (result.status === 'failed' || result.status === 'read-only') this.notSaved(agentId, result.reason);
    });
  }

  /** Resolves once everything recorded so far has been tried. */
  flush(): Promise<void> {
    return this.queue.then(() => undefined, () => undefined);
  }

  private notSaved(agentId: string, reason: string): void {
    this.deps.log?.(`Task history: a change in the chat of ${agentId || 'a member'} was not saved (${reason}).`);
    if (!agentId || this.toldNotSaved.has(agentId)) return;
    this.toldNotSaved.add(agentId);
    try { this.deps.onNotSaved?.(agentId, reason); } catch { /* a notice never breaks recording */ }
  }

  get projectionKey(): (agentId: string) => string {
    return chatHistoryKey;
  }
}

function failedReport(reason: string): HistoryDeletionReport {
  return { status: 'failed', reason, tasksDeleted: 0, messagesDeleted: 0, restorePointsRemoved: 0, restorePointsKept: 0,
    restorePointsKeptFiles: [], restorePointsFailed: 0, remaining: [], runningTasksKept: 0 };
}

/** The message as the transcript stores it, with its history id; none without one. */
function storedMessage(message: ChatHistoryMessage): ChatHistoryMessage | undefined {
  if (!message.messageId) return undefined;
  const [stored] = serializeChatHistory([message], 1);
  return stored?.messageId ? stored : undefined;
}

export function historyTerminal(record: RequestCloseoutRecordV1): HistoryTerminal {
  switch (record.terminal.kind) {
    case 'answered':
    case 'tool-only':
      return 'completed';
    case 'stopped':
    case 'host-deadline':
      return 'interrupted';
    case 'failed':
      return 'failed';
    default:
      return 'unfinished';
  }
}

/** Passed or failed only from checks the host ran itself; otherwise not verified, or unknown when it cannot tell. */
export function historyVerification(record: RequestCloseoutRecordV1): HistoryVerification {
  const checks = record.observations.checks;
  if (checks.coverage === 'unavailable' || checks.coverage === 'excluded') return 'unknown';
  if (checks.failed > 0 || checks.lastCompletionCheck?.kind === 'failed') return 'failed';
  if (checks.passed > 0) return 'verified';
  return 'not-verified';
}
