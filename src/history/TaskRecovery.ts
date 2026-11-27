/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Revert to before a request, Undo revert, Redo revert (v0.9.110 R2, design §4.2–4.3)
 *
 *  A revert puts back, for every file a member's requests from the chosen one onward changed, the state before the
 *  first of those changes. Per file, it folds that chain of changes: the first before is what it restores, the last
 *  read-back after is what the file must still hold. A file another request changed in between, one without an exact
 *  restore point, one whose last change was never confirmed, or one a still-running request touches is a conflict and
 *  is left as it is. Every other file is restored on its own; nothing is promised across files.
 *
 *  Each target is journaled in the history before and after it is written: planned (with what it restores, what the
 *  file must hold and the current content kept first, so the operation can be undone), intent (durable before the file
 *  is written), then applied / failed / unknown from the read-back. If the journal itself cannot be written, no file
 *  is touched. Nothing is ever written again from the journal. An operation that stopped before its end was recorded
 *  (this window's journal failed, or its window is proven gone) is completed from the journal and a read of each file:
 *  a target found holding what it restores counts as applied, one found as it was counts as not written, anything else
 *  is unknown. A window still running, or one that cannot be proven gone, keeps its operation.
 *
 *  A request another window admitted, that has no recorded end, counts as running while that window is not proven
 *  gone. Under each target's writer lease the history is read again: a file another request changed since the plan,
 *  or a request that is running again, makes that target a conflict, even when the bytes match.
 *
 *  Redo revert is for the current files only until the next request starts: after that it is history.
 *
 *  Undo revert puts back the content each applied target had before the revert; Redo revert applies the revert again.
 *  Both act per target, from where each target stands, through the same checks. Nothing here re-runs a request.
 *
 *  No `vscode` import: the host gives the restore checks, the restore points and the store.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import type { HistoryEventBody, HistoryFileState, RecoveryAction } from './HistoryRecords';
import type { DurableAppendResult, RecoveryOperationRecord } from './HistoryStore';
import type { HistoryTaskV1 } from './HistoryRecords';
import type { CaptureInOrder, RecoveryManifestV1, RecoveryUncoveredV1 } from './RecoveryManifest';

export interface RecoveryPreviewTarget {
  targetKey: string;
  displayPath: string;
  physicalTarget: string;
  action: 'restore' | 'remove' | 'conflict';
  restoreTo?: HistoryFileState;
  expected?: HistoryFileState;
  reason?: string;
  /** The ids of every capture of this file the plan saw, in order; any change of them since makes it a conflict. */
  chain?: string[];
  /** The selected requests that changed this file. */
  touchedBy?: string[];
}

export interface RecoveryPreview {
  previewId: string;
  agentId: string;
  fromHistoryId: string;
  /** The requests the revert covers, oldest first. */
  requestIds: string[];
  targets: RecoveryPreviewTarget[];
  notReversed: RecoveryUncoveredV1[];
}

export interface RecoveryReportTarget {
  targetKey: string;
  displayPath: string;
  outcome: 'applied' | 'conflict' | 'failed' | 'unknown' | 'not-attempted';
  reason?: string;
}

export interface RecoveryReport {
  action: RecoveryAction;
  operationId?: string;
  /** Set when nothing was attempted, with why. */
  refused?: string;
  targets: RecoveryReportTarget[];
  notReversed: RecoveryUncoveredV1[];
  /** Where later requests continue, when at least one target was applied by a revert and its end was recorded. */
  branchId?: string;
  /** v0.9.110 R2 (F2): files were changed but the history could not record all of it; it is completed later. */
  incomplete?: string;
}

export type RestoreContent = { kind: 'absent' } | { kind: 'bytes'; bytes: Buffer };

export interface PreparedRestore {
  /** Writes the file, after every check once more, and reads it back. */
  commit(): Promise<{ status: 'restored'; observed: HistoryFileState } | { status: 'refused'; reason: string } | { status: 'effect-uncertain'; reason: string }>;
  /** Gives the file's writer lease back. Idempotent. */
  release(): Promise<void>;
}

export interface TaskRecoveryStore {
  refresh(): Promise<void>;
  append(body: HistoryEventBody, options?: { eventId?: string }): Promise<DurableAppendResult>;
  tasksOf(agentId: string): Promise<HistoryTaskV1[]>;
  recoveryManifest(rootRequestId: string): RecoveryManifestV1 | undefined;
  capturesOf(physicalTarget: string): CaptureInOrder[];
  recoveryOperation(operationId: string): RecoveryOperationRecord | undefined;
  recoveryOperations(): RecoveryOperationRecord[];
  readonly activeBranch: string;
  physicalKey(physicalTarget: string): string;
  requestAdmittedBetween(after: number, upTo: number): boolean;
  requestState(rootRequestId: string): { ended: boolean; writerId?: string };
  hasRecoveryNotice(operationId: string): boolean;
  /** v0.9.110: restore points this operation's revert reverted were deleted: no Undo revert or Redo revert of it. */
  recoveryRetired(operationId: string): boolean;
  /** v0.9.110: this operation's notice was erased with a conversation it names; it is not recorded again. */
  recoveryNoticeErased(operationId: string): boolean;
  readonly writerId: string;
  writerLiveness(writerId: string): Promise<'self' | 'alive' | 'gone' | 'unknown'>;
  publishIdentityNow(): Promise<void>;
}

export interface TaskRecoveryPorts {
  store: TaskRecoveryStore;
  isRequestRunning(rootRequestId: string): boolean;
  /** The exact bytes of a restore point; undefined when it is no longer kept or does not verify. */
  readPayload(payloadRef: string): Promise<Buffer | undefined>;
  /** Pin restore points under the operation's name so Undo/Redo can still use them; false when one could not be. */
  pinPayloads(operationId: string, payloadRefs: readonly string[]): Promise<boolean>;
  /** Keep the file's current content exactly, pinned under the operation, before it is replaced. */
  keepCurrent(input: { operationId: string; physicalTarget: string; displayPath: string; expected: HistoryFileState }):
    Promise<{ state: HistoryFileState } | { refused: string }>;
  /**
   * Every check of a restore (trust, write scope, unsaved editor, physical target, the file still holding `expected`,
   * the file's writer lease taken without waiting) and the existing security-control decision when one is needed.
   */
  prepare(input: { physicalTarget: string; displayPath: string; content: RestoreContent; expected: HistoryFileState }):
    Promise<{ status: 'ready'; restore: PreparedRestore } | { status: 'conflict'; reason: string }>;
  /** What a file holds now, for completing a stopped operation; undefined when it cannot be read. */
  observe(physicalTarget: string): Promise<HistoryFileState | undefined>;
  newId(): string;
}

/** Why a revert of these requests cannot touch a file. */
const REASONS = {
  interleaved: 'another request changed this file after these requests did; restoring it would undo that work too.',
  noRestorePoint: 'no exact restore point was kept for it before these requests changed it.',
  afterUnknown: 'what its last change left could not be confirmed.',
  running: 'a request that changed it is still running.',
  runningElsewhere: 'a request that changed it may still be running in another UnodeAi window.',
  changedSincePlan: 'another request changed it after the preview; restoring it would undo that work too.',
  restorePointsDeleted: 'The restore points of this revert were deleted from Task history, so it can no longer be undone or redone.',
  redoRetired: 'A newer request started after this revert was undone, so Redo revert is now history: it no longer changes the current files.',
  incomplete: 'The history could not record all of this operation. It is completed from the files the next time Revert, Undo revert or Redo revert is opened.',
} as const;

function sameState(a: HistoryFileState | undefined, b: HistoryFileState | undefined): boolean {
  if (!a || !b) return false;
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind;
  return a.sha256 === b.sha256 && a.size === b.size;
}

/** What the revert chain reads from the history. */
export type RevertChainStore = Pick<TaskRecoveryStore, 'recoveryOperation' | 'recoveryOperations' | 'requestAdmittedBetween' | 'recoveryRetired'>;

/**
 * v0.9.110 R2 (F1, re-audit): where a revert's chain stands. The redo chain became history once a request started
 * while any of its targets stood undone: that request continued from the undone files. The steps are replayed in the
 * order they ended; the answer never turns back, whatever later Undo, partial or failed steps, or a reload recorded.
 * `undoReachable`: some target stands reverted; `redoReachable`: some target stands undone and Redo is not history.
 */
export function revertChain(store: RevertChainStore, operationId: string): { redoRetired: boolean; undoReachable: boolean; redoReachable: boolean } {
  const revert = store.recoveryOperation(operationId);
  // Its restore points were deleted: nothing of it can be put back either way.
  if (!revert || revert.action !== 'revert' || !revert.closed || store.recoveryRetired(operationId)) {
    return { redoRetired: true, undoReachable: false, redoReachable: false };
  }
  const position = new Map<string, 'reverted' | 'undone'>();
  for (const target of revert.targets) if (target.phase === 'applied') position.set(target.targetKey, 'reverted');
  const steps = store.recoveryOperations().filter((later) => later.targetOperationId === operationId && later.closed)
    .sort((a, b) => a.closed!.revision - b.closed!.revision);
  // While some target stands undone: the revision the latest step began (a request admitted during it counts).
  let undoneSince: number | undefined;
  let retired = false;
  for (const step of steps) {
    // A request admitted while targets stood undone, up to this step's end, even one this step then redid.
    if (undoneSince !== undefined && store.requestAdmittedBetween(undoneSince, step.closed!.revision)) retired = true;
    for (const target of step.targets) {
      if (target.phase !== 'applied' || !position.has(target.targetKey)) continue;
      position.set(target.targetKey, step.action === 'undo' ? 'undone' : 'reverted');
    }
    undoneSince = [...position.values()].includes('undone') ? step.revision : undefined;
  }
  if (undoneSince !== undefined && store.requestAdmittedBetween(undoneSince, Number.POSITIVE_INFINITY)) retired = true;
  const positions = [...position.values()];
  return { redoRetired: retired, undoReachable: positions.includes('reverted'), redoReachable: !retired && positions.includes('undone') };
}

/**
 * v0.9.110 (deviation 8): the requests an Undo revert or Redo revert can still reach. Housekeeping keeps their tasks.
 */
export function undoRedoReachableRequests(store: RevertChainStore): Set<string> {
  const reachable = new Set<string>();
  for (const operation of store.recoveryOperations()) {
    if (operation.action !== 'revert' || !operation.closed || operation.closed.applied === 0) continue;
    const chain = revertChain(store, operation.operationId);
    if (chain.undoReachable || chain.redoReachable) for (const id of operation.requestIds) reachable.add(id);
  }
  return reachable;
}

/**
 * v0.9.110: finished operations whose kept restore points no Undo revert or Redo revert can use any more: the revert
 * (or the revert an Undo/Redo stepped) has nothing left to undo and its Redo is history. Their holds can go; the bytes
 * then age out like any other restore point. An unfinished operation is never named.
 */
export function releasableRecoveryOperations(store: RevertChainStore): string[] {
  const releasable: string[] = [];
  const chains = new Map<string, boolean>();
  for (const operation of store.recoveryOperations()) {
    if (!operation.closed) continue;
    const revertId = operation.action === 'revert' ? operation.operationId : operation.targetOperationId;
    if (!revertId) continue;
    let reachable = chains.get(revertId);
    if (reachable === undefined) {
      const chain = revertChain(store, revertId);
      reachable = chain.undoReachable || chain.redoReachable;
      chains.set(revertId, reachable);
    }
    if (!reachable) releasable.push(operation.operationId);
  }
  return releasable;
}

export class TaskRecovery {
  private readonly previews = new Map<string, RecoveryPreview>();
  /** Operations this window is running now; only these are never completed from the journal here. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly ports: TaskRecoveryPorts) {}

  /** What a revert to before `fromHistoryId` would do, without changing anything. */
  async preview(agentId: string, fromHistoryId: string): Promise<RecoveryPreview | { refused: string }> {
    await this.ports.store.refresh();
    await this.reconcile();
    const plan = await this.plan(agentId, fromHistoryId);
    if ('refused' in plan) return plan;
    this.previews.set(plan.previewId, plan);
    if (this.previews.size > 32) this.previews.delete(this.previews.keys().next().value as string);
    return plan;
  }

  private async plan(agentId: string, fromHistoryId: string): Promise<RecoveryPreview | { refused: string }> {
    const store = this.ports.store;
    await store.refresh();
    const branch = store.activeBranch;
    const tasks = (await store.tasksOf(agentId)).filter((task) => task.branchId === branch);
    const index = tasks.findIndex((task) => task.historyId === fromHistoryId);
    if (index < 0) return { refused: 'That request is not on the current branch of this conversation.' };
    const scope = tasks.slice(index);
    const requestIds = scope.map((task) => task.rootRequestId).filter((id): id is string => !!id);
    const selected = new Set(requestIds);
    const files = new Map<string, { first?: { order: number; before: HistoryFileState; coverage: string; display: string; physical: string };
      last?: { order: number; after?: HistoryFileState }; running: false | 'here' | 'elsewhere'; touchedBy: string[] }>();
    const notReversed: RecoveryUncoveredV1[] = [];
    const liveness = new Map<string, Promise<'self' | 'alive' | 'gone' | 'unknown'>>();
    for (const requestId of requestIds) {
      const manifest = store.recoveryManifest(requestId);
      if (!manifest) continue;
      notReversed.push(...manifest.notReversed);
      const running = await this.running(requestId, liveness);
      for (const file of manifest.files) {
        const captures = store.capturesOf(file.physicalTarget);
        const mine = captures.filter((capture) => capture.rootRequestId === requestId);
        if (mine.length === 0) continue;
        const key = store.physicalKey(file.physicalTarget);
        const held = files.get(key) ?? { running: false, touchedBy: [] };
        const firstOrder = mine[0].order;
        const lastOrder = mine[mine.length - 1].order;
        if (!held.first || firstOrder < held.first.order) {
          held.first = { order: firstOrder, before: file.before, coverage: file.coverage, display: file.displayPath, physical: file.physicalTarget };
        }
        if (!held.last || lastOrder > held.last.order) held.last = { order: lastOrder, ...(file.after ? { after: file.after } : {}) };
        held.running = held.running === 'here' || running === 'here' ? 'here' : held.running || running;
        held.touchedBy.push(requestId);
        files.set(key, held);
      }
    }
    const targets: RecoveryPreviewTarget[] = [];
    for (const [key, file] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const first = file.first!;
      const chain = store.capturesOf(first.physical);
      const base = { targetKey: key, displayPath: first.display, physicalTarget: first.physical,
        chain: chain.map((capture) => capture.targetId), touchedBy: file.touchedBy };
      const interleaved = chain.some((capture) => capture.order > first.order && !selected.has(capture.rootRequestId));
      const reason = file.running === 'here' ? REASONS.running : file.running === 'elsewhere' ? REASONS.runningElsewhere
        : interleaved ? REASONS.interleaved
          : first.coverage !== 'exact' || (first.before.kind === 'file' && !first.before.payloadRef) ? REASONS.noRestorePoint
            : !file.last?.after ? REASONS.afterUnknown : undefined;
      if (reason) { targets.push({ ...base, action: 'conflict', reason }); continue; }
      if (sameState(first.before, file.last!.after)) continue;
      targets.push({ ...base, action: first.before.kind === 'absent' ? 'remove' : 'restore', restoreTo: first.before, expected: file.last!.after });
    }
    return { previewId: this.ports.newId(), agentId, fromHistoryId, requestIds, targets, notReversed: dedupe(notReversed) };
  }

  /** Apply a preview the person saw. It is planned again first; anything that moved since refuses it. */
  async apply(previewId: string): Promise<RecoveryReport> {
    const seen = this.previews.get(previewId);
    if (!seen) return { action: 'revert', refused: 'That preview is no longer current. Open Revert again.', targets: [], notReversed: [] };
    this.previews.delete(previewId);
    const now = await this.plan(seen.agentId, seen.fromHistoryId);
    if ('refused' in now) return { action: 'revert', refused: now.refused, targets: [], notReversed: [] };
    if (!samePlan(seen, now)) {
      return { action: 'revert', refused: 'The files or the history changed since the preview. Open Revert again to see what it would do now.',
        targets: [], notReversed: now.notReversed };
    }
    const operationId = this.ports.newId();
    return this.run(operationId, 'revert', seen.agentId, now.requestIds, undefined, now.fromHistoryId,
      now.targets.map((target) => target.action === 'conflict'
        ? { ...target, conflict: target.reason }
        : { ...target, content: target.restoreTo!, expected: target.expected!, keepInverse: true }),
      now.notReversed);
  }

  /** Put back what each target held before the revert, where the revert was applied and has not been undone. */
  async undo(operationId: string): Promise<RecoveryReport> {
    return this.step(operationId, 'undo');
  }

  /** Apply the revert again to each target that was undone. */
  async redo(operationId: string): Promise<RecoveryReport> {
    return this.step(operationId, 'redo');
  }

  /** Where each applied target of a revert stands now: reverted, or undone. */
  async positions(operationId: string): Promise<Map<string, { position: 'reverted' | 'undone'; current: HistoryFileState }>> {
    await this.ports.store.refresh();
    await this.reconcile();
    return this.positionsNow(operationId);
  }

  /**
   * v0.9.110 R2: complete what the journal left unfinished and repair missing notices, without writing any file.
   * Commands call it before they list operations, and a request of the person calls it before its notices are read.
   */
  async settle(): Promise<void> {
    await this.ports.store.refresh();
    await this.reconcile();
  }

  /** v0.9.110 R2 (F1): whether Redo revert can still change the current files: its chain is not yet history. */
  async redoAvailable(operationId: string): Promise<boolean> {
    await this.ports.store.refresh();
    const revert = this.ports.store.recoveryOperation(operationId);
    return !!revert?.closed && !this.redoRetired(operationId);
  }

  /**
   * v0.9.110 R2 (F1, re-audit): the redo chain became history once a request started while any of its targets stood
   * undone: that request continued from the undone files. The steps are replayed in the order they ended; the answer
   * never turns back, whatever later Undo, partial or failed steps, or a reload recorded.
   */
  private redoRetired(operationId: string): boolean {
    return revertChain(this.ports.store, operationId).redoRetired;
  }

  /**
   * Whether a request is running: in this window as the session tells it; one another window admitted counts as
   * running until the history shows its end or that window is proven gone.
   */
  private async running(requestId: string, liveness: Map<string, Promise<'self' | 'alive' | 'gone' | 'unknown'>>): Promise<false | 'here' | 'elsewhere'> {
    if (this.ports.isRequestRunning(requestId)) return 'here';
    const store = this.ports.store;
    const state = store.requestState(requestId);
    if (state.ended || !state.writerId || state.writerId === store.writerId) return false;
    let answer = liveness.get(state.writerId);
    if (!answer) {
      answer = store.writerLiveness(state.writerId);
      liveness.set(state.writerId, answer);
    }
    return await answer === 'gone' ? false : 'elsewhere';
  }

  /**
   * v0.9.110 R2 (F2): complete every operation whose end was never recorded, when it is this window's and no longer
   * running here, or its window is proven gone. Each target found holding what it restores counts as applied, one
   * found as the operation expected it before counts as not written, anything else is unknown. Nothing is written to a
   * file. Event ids are fixed per operation and target, so two windows completing one operation record it once.
   */
  private async reconcile(): Promise<void> {
    const store = this.ports.store;
    for (const operation of store.recoveryOperations()) {
      if (this.inFlight.has(operation.operationId)) continue;
      // A finished operation needs nothing here unless it changed files and its notice was never recorded.
      if (operation.closed && (operation.closed.applied === 0 || store.hasRecoveryNotice(operation.operationId)
        || store.recoveryNoticeErased(operation.operationId))) continue;
      const owner = await store.writerLiveness(operation.writerId);
      if (owner !== 'self' && owner !== 'gone') continue;
      if (operation.closed) {
        await this.repairNotice(operation, operation.closed.branchId);
        continue;
      }
      const report: RecoveryReportTarget[] = [];
      let applied = 0;
      let recorded = true;
      for (const target of operation.targets) {
        const where = { operationId: operation.operationId, targetKey: target.targetKey, physicalTarget: target.physicalTarget,
          displayPath: target.displayPath };
        const eventId = `rc-${operation.operationId}-${createHash('sha256').update(target.targetKey).digest('hex').slice(0, 32)}`;
        if (target.phase === 'applied') { applied++; report.push({ targetKey: target.targetKey, displayPath: target.displayPath, outcome: 'applied' }); continue; }
        if (target.phase !== 'intent' && target.phase !== 'planned') {
          report.push({ targetKey: target.targetKey, displayPath: target.displayPath, outcome: target.phase === 'conflict' ? 'conflict'
            : target.phase === 'failed' ? 'failed' : 'unknown', ...(target.reason ? { reason: target.reason } : {}) });
          continue;
        }
        let body: HistoryEventBody;
        if (target.phase === 'planned') {
          // Its intent was never recorded, so it was never written.
          body = { kind: 'recovery-target', ...where, phase: 'failed', reason: 'it was not written: the operation stopped first.' };
        } else {
          const now = await this.ports.observe(target.physicalTarget);
          if (now && sameState(now, target.restoreTo)) {
            body = { kind: 'recovery-target', ...where, phase: 'applied', observed: now };
          } else if (now && sameState(now, target.expected)) {
            body = { kind: 'recovery-target', ...where, phase: 'failed', reason: 'it was not written before the operation stopped.' };
          } else {
            body = { kind: 'recovery-target', ...where, phase: 'unknown', reason: 'the operation stopped before its result was recorded, and the file now holds something else.' };
          }
        }
        const result = await store.append(body, { eventId }).catch(() => undefined);
        if (result?.status !== 'durable' && result?.status !== 'duplicate') { recorded = false; break; }
        if (body.kind === 'recovery-target' && body.phase === 'applied') applied++;
        report.push({ targetKey: target.targetKey, displayPath: target.displayPath,
          outcome: body.kind === 'recovery-target' && body.phase === 'applied' ? 'applied' : body.kind === 'recovery-target' && body.phase === 'failed' ? 'failed' : 'unknown',
          ...(body.kind === 'recovery-target' && body.reason ? { reason: body.reason } : {}) });
      }
      if (!recorded) continue;
      const branchId = operation.action === 'revert' && applied > 0 ? `branch-${operation.operationId}` : undefined;
      const closed = await store.append({ kind: 'recovery-closed', operationId: operation.operationId, applied, ...(branchId ? { branchId } : {}) },
        { eventId: `rc-closed-${operation.operationId}` }).catch(() => undefined);
      if (closed?.status !== 'durable' && closed?.status !== 'duplicate') continue;
      if (applied > 0 && !store.hasRecoveryNotice(operation.operationId) && !store.recoveryNoticeErased(operation.operationId)) {
        const plans = operation.targets.map((target) => ({ targetKey: target.targetKey, displayPath: target.displayPath,
          physicalTarget: target.physicalTarget, content: target.restoreTo }));
        const body = await this.noticeBody(operation.operationId, operation.action, plans, report, this.notReversedOf(operation),
          { agentId: operation.agentId, fromHistoryId: operation.fromHistoryId, targetOperationId: operation.targetOperationId, branchId });
        await store.append(body, { eventId: `rc-notice-${operation.operationId}` }).catch(() => undefined);
      }
    }
    await store.refresh();
  }

  /**
   * v0.9.110 R2 (F2, re-audit): a finished operation that changed files but whose notice could not be recorded gets
   * it now, from what its journal holds. Nothing is written to a file; the notice id is the operation's, so a notice
   * recorded twice (two windows, or a late first append) counts once.
   */
  private async repairNotice(operation: RecoveryOperationRecord, branchId: string | undefined): Promise<void> {
    const report: RecoveryReportTarget[] = operation.targets.map((target) => ({
      targetKey: target.targetKey, displayPath: target.displayPath,
      outcome: target.phase === 'applied' ? 'applied' as const : target.phase === 'conflict' ? 'conflict' as const
        : target.phase === 'failed' ? 'failed' as const : target.phase === 'planned' ? 'not-attempted' as const : 'unknown' as const,
      ...(target.reason ? { reason: target.reason } : {}),
    }));
    if (!report.some((target) => target.outcome === 'applied')) return;
    const plans = operation.targets.map((target) => ({ targetKey: target.targetKey, displayPath: target.displayPath,
      physicalTarget: target.physicalTarget, content: target.restoreTo }));
    const body = await this.noticeBody(operation.operationId, operation.action, plans, report, this.notReversedOf(operation),
      { agentId: operation.agentId, fromHistoryId: operation.fromHistoryId, targetOperationId: operation.targetOperationId, branchId });
    await this.ports.store.append(body, { eventId: `rc-notice-${operation.operationId}` }).catch(() => undefined);
  }

  /** What a revert's requests could not reverse, as their manifests say. */
  private notReversedOf(operation: RecoveryOperationRecord): RecoveryUncoveredV1[] {
    if (operation.action !== 'revert') return [];
    return dedupe(operation.requestIds.flatMap((id) => this.ports.store.recoveryManifest(id)?.notReversed ?? []));
  }

  /** v0.9.110: where each applied target of a revert stands, as last read (after `settle`), without reading again. */
  standing(operationId: string): Map<string, { position: 'reverted' | 'undone'; current: HistoryFileState }> {
    return this.positionsNow(operationId);
  }

  private positionsNow(operationId: string): Map<string, { position: 'reverted' | 'undone'; current: HistoryFileState }> {
    const store = this.ports.store;
    const revert = store.recoveryOperation(operationId);
    const positions = new Map<string, { position: 'reverted' | 'undone'; current: HistoryFileState }>();
    if (!revert || revert.action !== 'revert') return positions;
    for (const target of revert.targets) {
      if (target.phase === 'applied' && target.observed) positions.set(target.targetKey, { position: 'reverted', current: target.observed });
    }
    for (const later of store.recoveryOperations()) {
      if (later.targetOperationId !== operationId || !later.closed) continue;
      for (const target of later.targets) {
        if (target.phase !== 'applied' || !target.observed || !positions.has(target.targetKey)) continue;
        positions.set(target.targetKey, { position: later.action === 'undo' ? 'undone' : 'reverted', current: target.observed });
      }
    }
    return positions;
  }

  private async step(operationId: string, action: 'undo' | 'redo'): Promise<RecoveryReport> {
    await this.ports.store.refresh();
    await this.reconcile();
    const revert = this.ports.store.recoveryOperation(operationId);
    if (!revert || revert.action !== 'revert' || !revert.closed) {
      return { action, refused: 'There is no finished revert with that id.', targets: [], notReversed: [] };
    }
    if (this.ports.store.recoveryRetired(operationId)) {
      return { action, refused: REASONS.restorePointsDeleted, targets: [], notReversed: [] };
    }
    if (action === 'redo' && this.redoRetired(operationId)) {
      return { action, refused: REASONS.redoRetired, targets: [], notReversed: [] };
    }
    const positions = this.positionsNow(operationId);
    const wanted = action === 'undo' ? 'reverted' : 'undone';
    const plans = revert.targets.filter((target) => positions.get(target.targetKey)?.position === wanted).map((target) => {
      const content = action === 'undo' ? target.inverse : target.restoreTo;
      const base = { targetKey: target.targetKey, displayPath: target.displayPath, physicalTarget: target.physicalTarget,
        action: (content?.kind === 'absent' ? 'remove' : 'restore') as 'remove' | 'restore' };
      return content
        ? { ...base, content, expected: positions.get(target.targetKey)!.current, keepInverse: false }
        : { ...base, action: 'conflict' as const, conflict: 'what it held before the revert was not kept.' };
    });
    if (plans.length === 0) {
      return { action, refused: action === 'undo' ? 'Nothing of that revert is left to undo.' : 'Nothing of that revert is undone.', targets: [], notReversed: [] };
    }
    return this.run(this.ports.newId(), action, revert.agentId, revert.requestIds, operationId, undefined, plans, []);
  }

  private async run(
    operationId: string, action: RecoveryAction, agentId: string, requestIds: string[], targetOperationId: string | undefined,
    fromHistoryId: string | undefined,
    plans: Array<{ targetKey: string; displayPath: string; physicalTarget: string; conflict?: string; content?: HistoryFileState;
      expected?: HistoryFileState; keepInverse?: boolean; chain?: string[]; touchedBy?: string[] }>,
    notReversed: RecoveryUncoveredV1[],
  ): Promise<RecoveryReport> {
    this.inFlight.add(operationId);
    try {
      return await this.runOperation(operationId, action, agentId, requestIds, targetOperationId, fromHistoryId, plans, notReversed);
    } finally {
      this.inFlight.delete(operationId);
    }
  }

  /**
   * v0.9.110 R2 (F3, F4): looked at again while the target's writer lease is held. The history is read again: a capture
   * of this file the plan did not see (another request changed it since, even back to the same bytes), or a request
   * that changed it running now, here or in another window, makes it a conflict.
   */
  private async movedSincePlan(plan: { physicalTarget: string; chain?: string[]; touchedBy?: string[] }): Promise<string | undefined> {
    if (!plan.chain) return undefined;
    const store = this.ports.store;
    await store.refresh();
    const now = store.capturesOf(plan.physicalTarget).map((capture) => capture.targetId);
    if (now.join('\0') !== plan.chain.join('\0')) return REASONS.changedSincePlan;
    const liveness = new Map<string, Promise<'self' | 'alive' | 'gone' | 'unknown'>>();
    for (const requestId of plan.touchedBy ?? []) {
      const running = await this.running(requestId, liveness);
      if (running) return running === 'here' ? REASONS.running : REASONS.runningElsewhere;
    }
    return undefined;
  }

  private async runOperation(
    operationId: string, action: RecoveryAction, agentId: string, requestIds: string[], targetOperationId: string | undefined,
    fromHistoryId: string | undefined,
    plans: Array<{ targetKey: string; displayPath: string; physicalTarget: string; conflict?: string; content?: HistoryFileState;
      expected?: HistoryFileState; keepInverse?: boolean; chain?: string[]; touchedBy?: string[] }>,
    notReversed: RecoveryUncoveredV1[],
  ): Promise<RecoveryReport> {
    const store = this.ports.store;
    // A window that stops in the middle of this operation can then be proven gone by another, which completes it.
    await store.publishIdentityNow().catch(() => undefined);
    const journal = async (body: HistoryEventBody): Promise<boolean> => {
      const result = await store.append(body).catch(() => undefined);
      return result?.status === 'durable' || result?.status === 'duplicate';
    };
    // What the operation relies on later (the states it restores) is pinned first.
    const refs = plans.map((plan) => plan.content).filter((state): state is HistoryFileState & { kind: 'file' } => state?.kind === 'file' && !!state.payloadRef)
      .map((state) => state.payloadRef!);
    const pinned = refs.length === 0 || await this.ports.pinPayloads(operationId, refs);
    if (!await journal({ kind: 'recovery-operation', operationId, action, agentId, requestIds,
      ...(targetOperationId ? { targetOperationId } : {}), ...(fromHistoryId ? { fromHistoryId } : {}) })) {
      return { action, refused: 'The history could not record this operation, so no file was changed.', targets: [], notReversed };
    }
    const report: RecoveryReportTarget[] = [];
    let applied = 0;
    let stopped = false;
    for (const plan of [...plans].sort((a, b) => (a.physicalTarget < b.physicalTarget ? -1 : a.physicalTarget > b.physicalTarget ? 1 : 0))) {
      const where = { operationId, targetKey: plan.targetKey, physicalTarget: plan.physicalTarget, displayPath: plan.displayPath };
      if (stopped) { report.push({ targetKey: plan.targetKey, displayPath: plan.displayPath, outcome: 'not-attempted', reason: 'the history stopped recording' }); continue; }
      const conflict = async (reason: string) => {
        report.push({ targetKey: plan.targetKey, displayPath: plan.displayPath, outcome: 'conflict', reason });
        if (!await journal({ kind: 'recovery-target', ...where, phase: 'conflict', reason })) stopped = true;
      };
      if (plan.conflict || !plan.content || !plan.expected) { await conflict(plan.conflict ?? 'nothing to restore'); continue; }
      if (!pinned && plan.content.kind === 'file') { await conflict('its restore point could not be kept for Undo and Redo.'); continue; }
      let content: RestoreContent;
      if (plan.content.kind === 'absent') content = { kind: 'absent' };
      else {
        const bytes = plan.content.payloadRef ? await this.ports.readPayload(plan.content.payloadRef) : undefined;
        if (!bytes) { await conflict('its restore point is no longer kept, or no longer verifies.'); continue; }
        content = { kind: 'bytes', bytes };
      }
      const prepared = await this.ports.prepare({ physicalTarget: plan.physicalTarget, displayPath: plan.displayPath, content, expected: plan.expected });
      if (prepared.status === 'conflict') { await conflict(prepared.reason); continue; }
      const restore = prepared.restore;
      try {
        const moved = await this.movedSincePlan(plan);
        if (moved) { await conflict(moved); continue; }
        let inverse: HistoryFileState | undefined;
        if (plan.keepInverse) {
          const kept = await this.ports.keepCurrent({ operationId, physicalTarget: plan.physicalTarget, displayPath: plan.displayPath, expected: plan.expected });
          if ('refused' in kept) { await conflict(`what it holds now could not be kept first, so it was left as it is (${kept.refused})`); continue; }
          inverse = kept.state;
        }
        // The journal holds the target's plan and intent, durably, before the file is written.
        if (!await journal({ kind: 'recovery-target', ...where, phase: 'planned', restoreTo: plan.content, expected: plan.expected,
          ...(inverse ? { inverse } : {}) })
          || !await journal({ kind: 'recovery-target', ...where, phase: 'intent' })) {
          stopped = true;
          report.push({ targetKey: plan.targetKey, displayPath: plan.displayPath, outcome: 'not-attempted', reason: 'the history stopped recording' });
          continue;
        }
        const outcome = await restore.commit();
        if (outcome.status === 'restored') {
          applied++;
          report.push({ targetKey: plan.targetKey, displayPath: plan.displayPath, outcome: 'applied' });
          if (!await journal({ kind: 'recovery-target', ...where, phase: 'applied', observed: outcome.observed })) stopped = true;
        } else if (outcome.status === 'refused') {
          report.push({ targetKey: plan.targetKey, displayPath: plan.displayPath, outcome: 'failed', reason: outcome.reason });
          if (!await journal({ kind: 'recovery-target', ...where, phase: 'failed', reason: outcome.reason })) stopped = true;
        } else {
          report.push({ targetKey: plan.targetKey, displayPath: plan.displayPath, outcome: 'unknown', reason: outcome.reason });
          if (!await journal({ kind: 'recovery-target', ...where, phase: 'unknown', reason: outcome.reason })) stopped = true;
        }
      } finally {
        await restore.release().catch(() => undefined);
      }
    }
    if (stopped) {
      // Files may have changed that the journal does not show yet: the end is not recorded now, so the operation is
      // completed from the files later, in this window or another, never claimed here.
      return { action, operationId, targets: report, notReversed, ...(applied > 0 ? { incomplete: REASONS.incomplete } : {}) };
    }
    const branchId = action === 'revert' && applied > 0 ? `branch-${operationId}` : undefined;
    if (!await journal({ kind: 'recovery-closed', operationId, applied, ...(branchId ? { branchId } : {}) })) {
      return { action, operationId, targets: report, notReversed, ...(applied > 0 ? { incomplete: REASONS.incomplete } : {}) };
    }
    // F1 (design §4.3): every member learns, at its next request, which files now hold which state. No file content.
    if (applied > 0 && !await journal(await this.noticeBody(operationId, action, plans, report, notReversed,
      { agentId, fromHistoryId, targetOperationId, branchId }))) {
      return { action, operationId, targets: report, notReversed, ...(branchId ? { branchId } : {}),
        incomplete: 'The files were changed, but the history could not record the note that tells the team members.' };
    }
    return { action, operationId, targets: report, notReversed, ...(branchId ? { branchId } : {}) };
  }

  /** The note every member gets at its next request, for the targets an operation applied. No file content. */
  private async noticeBody(operationId: string, action: RecoveryAction,
    plans: Array<{ targetKey: string; displayPath: string; physicalTarget: string; content?: HistoryFileState }>,
    report: RecoveryReportTarget[], notReversed: RecoveryUncoveredV1[],
    context: { agentId: string; fromHistoryId?: string; targetOperationId?: string; branchId?: string }): Promise<HistoryEventBody> {
    const byKey = new Map(plans.map((plan) => [plan.targetKey, plan]));
    const targets = report.filter((entry) => entry.outcome === 'applied').map((entry) => {
      const plan = byKey.get(entry.targetKey)!;
      const state: 'before-request' | 'removed' | 'after-request' = action === 'undo' ? 'after-request'
        : plan.content?.kind === 'absent' ? 'removed' : 'before-request';
      return { physicalTarget: plan.physicalTarget, displayPath: plan.displayPath, state, current: plan.content! };
    });
    const conflicts = report.filter((entry) => entry.outcome !== 'applied').map((entry) => ({
      physicalTarget: byKey.get(entry.targetKey)!.physicalTarget, displayPath: entry.displayPath,
      reason: entry.reason ?? (entry.outcome === 'unknown' ? 'its result could not be confirmed' : 'it was not changed'),
    }));
    return { kind: 'recovery-notice', noticeId: `notice-${operationId}`, operationId, action, targets, conflicts, notReversed: notReversed.length,
      ...(context.branchId ? { branchId: context.branchId } : {}),
      ...(await this.selectedRequest(context.agentId, context.fromHistoryId, context.targetOperationId)),
      ...(notReversed.length > 0 ? { notReversedRefs: notReversed.map((entry) => ({ ...entry })) } : {}) };
  }


  /** F5: the request a revert went back to before (an Undo's or Redo's: its revert's), as its notice names it. */
  private async selectedRequest(agentId: string, fromHistoryId: string | undefined, targetOperationId: string | undefined):
    Promise<{ selected?: { historyId: string; rootRequestId?: string; goal: string } }> {
    const historyId = fromHistoryId ?? (targetOperationId ? this.ports.store.recoveryOperation(targetOperationId)?.fromHistoryId : undefined);
    if (!historyId) return {};
    const task = (await this.ports.store.tasksOf(agentId).catch(() => [] as HistoryTaskV1[])).find((entry) => entry.historyId === historyId);
    return { selected: { historyId, ...(task?.rootRequestId ? { rootRequestId: task.rootRequestId } : {}),
      goal: (task?.goal ?? '').replace(/\s+/g, ' ').trim().slice(0, 400) } };
  }
}

function samePlan(a: RecoveryPreview, b: RecoveryPreview): boolean {
  if (a.requestIds.join('\0') !== b.requestIds.join('\0') || a.targets.length !== b.targets.length) return false;
  return a.targets.every((target, index) => {
    const other = b.targets[index];
    return target.targetKey === other.targetKey && target.action === other.action
      && JSON.stringify(target.restoreTo ?? null) === JSON.stringify(other.restoreTo ?? null)
      && JSON.stringify(target.expected ?? null) === JSON.stringify(other.expected ?? null);
  });
}

function dedupe(entries: RecoveryUncoveredV1[]): RecoveryUncoveredV1[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.effect}\0${entry.path ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
