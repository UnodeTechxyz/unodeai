import { createHash } from 'node:crypto';
import type { AsyncDelegationResult } from '../../backend/TeamTools';
import type { ResultScopeEvent } from '../../backend/DelegationResultProjection';
import { DelegationResultMailbox, resultMailboxKey, type ResultCompletionIdentity } from '../../state/DelegationResultMailbox';
import { DelegationResultBodyStore } from '../../state/DelegationResultBodyStore';
import type { PersistenceManager } from '../../state/PersistenceManager';
import type { RunLedger } from '../../observability/RunLedger';
import type { Message } from '../../types';

type Via = 'auto-wake' | 'collect-ready' | 'blocking-tool';
export interface ResultDeliveryHostPort {
  persistence: PersistenceManager;
  ledger: RunLedger;
  storageUri: { scheme: string; fsPath: string } | undefined;
  workspaceId: string;
  assertCurrent(): void;
  owns(coordinatorId: string, handle: string): boolean;
  /** Existing host conversation journal, not a model-supplied marker. */
  archive(identity: ResultCompletionIdentity, text: string): { conversationId: string; messageId: string };
  hasDelivery(identity: ResultCompletionIdentity, digest: string): boolean;
  recordDelivery(identity: ResultCompletionIdentity, digest: string, via: Via): Promise<void>;
  saveLedger(): Promise<void>;
  saveArchive(): Promise<void>;
  notice(coordinatorId: string, result?: 'unavailable'): boolean | void;
  /** One fixed category per source of the recovery reminder, for the log. Never content, a path or a key. */
  logRecoveryWarning?(coordinatorId: string, source: RecoveryWarningSource): void;
  recoveryReady?(coordinatorId: string, results: readonly AsyncDelegationResult[]): void;
}

export type RecoveryWarningSource = 'closed-result-reclaim' | 'legacy-identity' | 'reservation-refused' | 'settlement-refused'
  | 'retained-save-failed' | 'prepared-save-failed' | 'prepared-save-pending' | 'storage-queue-error' | 'body-unavailable';

/**
 * v0.9.99: how long a delivery's recovery save may stay pending, from the moment its work is created, before the
 * person is told recovery is unavailable or still saving. A save that is merely slow under disk load (the handoff
 * still waits 500 ms for it) is not reported; a failure is reported at once by the failure paths.
 */
export const RECOVERY_PENDING_NOTICE_MS = 30_000;

/** Actual host consumer. The mailbox owns delivery claims; the ledger owns identity and lifecycle.
 * Recovery failure never controls whether a worker can run. No background scheduler or second ownership lease. */
export class ResultDeliveryHost {
  private store?: DelegationResultBodyStore;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly rows = new Map<string, AsyncDelegationResult>();
  private readonly reservations = new Set<string>();
  private readonly held = new Set<string>();
  private readonly warned = new Set<string>();
  private readonly pendingNotices = new Set<string>();
  private readonly unavailable = new Set<string>();
  private readonly identities = new Map<string, ResultCompletionIdentity>();
  private readonly preparations = new Map<string, Promise<unknown>>();
  /** v0.9.99: one recovery-pending deadline per preparation work, cleared when that work settles or on close. */
  private readonly recoveryDeadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  private recovery?: Promise<void>;
  /** v0.9.101 S4.1: open() has started the store and it has neither opened nor failed yet. */
  private storeOpening = false;
  /** v0.9.101 S4.1: settled results held in memory while the store opens, one per result, in the order they settled. */
  private readonly unsaved = new Map<string, { identity: ResultCompletionIdentity; key: string; attempted: boolean }>();
  private readonly mailbox: DelegationResultMailbox;
  constructor(private readonly port: ResultDeliveryHostPort) {
    this.mailbox = new DelegationResultMailbox({
      ownsCoordinator: id => { try { port.assertCurrent(); return !this.held.has(id); } catch { return false; } },
      currentCompletion: identity => this.current(identity),
      currentDelivery: (_context, identity) => this.current(identity),
      archive: async () => undefined, // Cached Memento state is not a durable body-deletion receipt.
      reportStorageError: () => {},
    });
  }
  private current(identity: ResultCompletionIdentity): boolean {
    try {
      this.port.assertCurrent();
      const current = this.port.ledger.resultIdentity(identity.coordinatorId, identity.ref.handle);
      return !this.held.has(identity.coordinatorId) && this.port.owns(identity.coordinatorId, identity.ref.handle)
        && !!current && current.ref.revision === identity.ref.revision && current.attemptId === identity.attemptId
        && current.settledEventId === identity.settledEventId;
    } catch { return false; }
  }
  private warn(id: string, source: RecoveryWarningSource): void {
    try { this.port.logRecoveryWarning?.(id, source); } catch { /* The log never decides what the person is told. */ }
    this.tell(id);
  }
  private tell(id: string): void {
    if (this.warned.has(id)) return;
    if ((this.unavailable.has(id) ? this.port.notice(id, 'unavailable') : this.port.notice(id)) === false) this.pendingNotices.add(id);
    else { this.warned.add(id); this.pendingNotices.delete(id); }
  }
  private enqueue<T>(id: string, action: () => Promise<T>): Promise<T | undefined> {
    const next = this.tail.then(action).catch(() => { this.warn(id, 'storage-queue-error'); return undefined; });
    this.tail = next; return next;
  }
  /** Optional recovery must not keep extension activation waiting on a hung storage device. */
  async open(): Promise<void> {
    this.storeOpening = true; this.recovery = this.recoverStorage(); await this.withinRecoveryBudget(this.recovery);
  }
  private async recoverStorage(): Promise<void> {
    // Every result whose body this recovery found, restored or not: a delivered one is not restored, and it is not lost.
    const found = new Set<string>();
    try {
      const recoveredKeys = new Set<string>();
      let adopted = false;
      for (const run of this.port.ledger.snapshot()) for (const delegation of run.delegations) {
        adopted = this.port.ledger.adoptSettledResultOwner(run.coordinatorId, delegation.handle) || adopted;
        const identity = this.port.ledger.resultIdentity(run.coordinatorId, delegation.handle);
        if (identity) this.identities.set(resultMailboxKey(identity.coordinatorId, identity.ref), identity);
      }
      if (adopted) await this.port.saveLedger();
      this.store = await DelegationResultBodyStore.open({ storageUri: this.port.storageUri, workspaceId: this.port.workspaceId,
        assertCurrent: key => {
          this.port.assertCurrent(); const identity = key && this.identities.get(key);
          if (key && (!identity || !this.current(identity))) throw new Error('Result owner changed');
        }, reservations: () => [...this.reservations] });
      this.storeOpened();
      for (const archived of this.port.persistence.archivedResultBodies()) {
        try { await this.reclaimClosed(archived); }
        catch { this.warn(archived.coordinatorId, 'closed-result-reclaim'); }
      }
      const legacy = this.port.persistence.loadPendingDelegationResults();
      if (legacy.length) {
        for (const row of legacy) {
          const identity = this.port.ledger.adoptLegacyResultIdentity(row.coordinatorId, row.handle, row.ref);
          if (!identity || !this.current(identity)) { this.warn(row.coordinatorId, 'legacy-identity'); continue; }
          this.reserve(row.coordinatorId, row.handle);
          this.mailbox.settle(identity, row.outcome?.status === 'failed' ? 'failed' : 'ready', row.text, this.port.archive(identity, row.text));
          recoveredKeys.add(resultMailboxKey(row.coordinatorId, identity.ref));
        }
        await this.port.saveArchive(); await this.port.saveLedger();
        await this.port.persistence.migratePendingResultMailbox(this.store, row => {
          const identity = this.port.ledger.resultIdentity(row.coordinatorId, row.handle);
          return identity && this.mailbox.lookup(row.coordinatorId, identity.ref);
        }, () => this.port.assertCurrent());
        this.reservations.clear();
      }
      for (const key of this.port.persistence.loadResultMailboxIndex() ?? []) {
        const entry = await this.port.persistence.readResultMailboxEntry(key, this.store, () => this.port.assertCurrent());
        if (!entry?.body || !this.current(entry) || entry.conflict) continue;
        found.add(key);
        const delivered = this.port.hasDelivery(entry, entry.body.sourceDigest);
        const delegation = this.port.ledger.snapshot().flatMap(run => run.delegations).find(row => row.handle === entry.ref.handle);
        if (delivered || entry.delivery === 'delivered' || entry.deliveryAttempted || delegation?.delivery?.state === 'delivered'
          || delegation?.resultRecovery === 'delivery-unknown') {
          this.port.ledger.resultRecovery(entry.coordinatorId, entry.ref.handle, delivered ? undefined : 'delivery-unknown');
          continue; // An intent without a recovered marker is unknown; never blindly replay it.
        }
        if (this.mailbox.restore(entry) || recoveredKeys.has(key)) {
          recoveredKeys.add(key);
          if (delegation) this.rows.set(key, { handle: entry.ref.handle, ref: delegation.agentId, text: entry.body.text, resultRevision: entry.ref.revision });
          this.port.ledger.resultRecovery(entry.coordinatorId, entry.ref.handle, undefined);
        }
      }
      for (const id of new Set(this.mailbox.index().filter(row => recoveredKeys.has(row.key)).map(row => row.coordinatorId))) {
        const results = this.recover(id).filter(result => result.resultRevision
          && recoveredKeys.has(resultMailboxKey(id, { handle: result.handle, revision: result.resultRevision }))
          && this.canDeliver(id, result.handle, result.resultRevision));
        if (results.length) this.port.recoveryReady?.(id, results);
      }
    } catch { /* Optional recovery failure does not refuse ordinary task work. */ }
    if (this.storeOpening) this.dropUnsaved(); // The store did not open.
    await this.reconcileUnavailableResults(found);
  }

  /** v0.9.101 S4.1: the store is ready. Each result held for it is saved once, in the order it settled. */
  private storeOpened(): void {
    this.storeOpening = false;
    for (const [slot, item] of this.unsaved) void this.enqueue(item.identity.coordinatorId, async () => {
      if (this.unsaved.get(slot) !== item) return; // close() came first and reported it.
      this.unsaved.delete(slot);
      this.reservations.add(item.key); // A body is written only under its reservation, as on the ordinary path.
      await this.saveRetained(item.identity, item.key, item.attempted);
      // A decision made while the store was opening found nothing to archive; archive it now that it is saved.
      this.archiveDecided(item.identity.coordinatorId, item.identity.ref.handle);
    });
  }

  /** v0.9.101 S4.1: the store failed to open, or the host closed first. A held result is reported as a failed save. */
  private dropUnsaved(): void {
    this.storeOpening = false;
    const held = [...this.unsaved.values()]; this.unsaved.clear();
    let reported: string | undefined;
    for (const { identity } of held) {
      // As at the ordinary save: a result that stopped being current, or was already handed over, owes no recovery.
      if (!this.current(identity) || this.mailbox.lookup(identity.coordinatorId, identity.ref)?.delivery === 'delivered') continue;
      this.port.ledger.resultRecovery(identity.coordinatorId, identity.ref.handle, 'recovery-data-not-saved');
      this.warn(identity.coordinatorId, 'retained-save-failed'); reported = identity.coordinatorId;
    }
    if (reported) void this.enqueue(reported, () => this.port.saveLedger());
  }

  /**
   * v0.9.100: a result the ledger still calls collectable, whose body nothing here holds, cannot be handed over now.
   * Keeping it collectable would promise a wake that cannot come. Whether its save failed or its file could not be read
   * is one rule: its run stays open until a later reload reads it, the coordinator decides on it, or Stop.
   */
  private async reconcileUnavailableResults(found: ReadonlySet<string>): Promise<void> {
    try {
      let changed = false;
      for (const { coordinatorId, handle } of this.port.ledger.resultsAwaitingCollection()) {
        const identity = this.port.ledger.resultIdentity(coordinatorId, handle);
        if (!identity || !this.current(identity) || this.mailbox.lookup(coordinatorId, identity.ref)
          || found.has(resultMailboxKey(coordinatorId, identity.ref))) continue;
        this.port.ledger.resultRecovery(coordinatorId, handle, 'body-unavailable');
        this.unavailable.add(coordinatorId);
        this.warn(coordinatorId, 'body-unavailable');
        changed = true;
      }
      if (changed) await this.port.saveLedger();
    } catch { /* The next reload reconciles again. */ }
  }

  private async reclaimClosed(entry: import('../../state/ResultMailboxMetadata').ResultMailboxMetadata): Promise<void> {
    if (!this.store || !entry.body?.location) return;
    const assertClosed = () => {
      this.port.assertCurrent();
      if (!this.port.owns(entry.coordinatorId, entry.ref.handle) || !this.closedByLedger(entry)
        || this.port.persistence.loadResultMailboxIndex()?.includes(entry.key)) throw new Error('Archive scope changed');
    };
    assertClosed();
    // The host has archived and decided/closed this result. Journal retention and editor process identity
    // are not extra deletion authorities: they made ordinary window reloads permanently exhaust recovery.
    await this.store.reclaimArchived(entry.body.file, { assertClosed });
    // An already absent body is also reclaimed (e.g. a crash between unlink and metadata cleanup).
    await this.port.persistence.forgetReclaimedResult(entry.key, assertClosed);
    // A directory opened at quota skips its publish probe and is initially read-only. Once reclaiming
    // creates room, restore write capability too; deleting files alone must not leave recovery disabled.
    if (this.store.readOnly) await this.store.checkAdmission();
  }
  private async withinRecoveryBudget(work: Promise<unknown>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work.then(() => true, () => false), new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), 500);
    })]); } finally { if (timer) clearTimeout(timer); }
  }
  private closedByLedger(identity: ResultCompletionIdentity): boolean {
    const run = this.port.ledger.snapshot().find(row => row.coordinatorId === identity.coordinatorId
      && row.delegations.some(item => item.handle === identity.ref.handle));
    const task = run?.delegations.find(row => row.handle === identity.ref.handle);
    const result = task?.resultHistory?.find(row => row.ref.revision === identity.ref.revision);
    if (!result || result.conflict || result.attemptId !== identity.attemptId || result.settledEventId !== identity.settledEventId) return false;
    return result.decisionScopes?.at(-1)?.state === 'closed'
      || !!task?.resultReservation && task.resultReservation.ref.revision > identity.ref.revision
      || !!result.decision && !['needs-rework', 'needs-human'].includes(result.decision.value);
  }

  archiveDecided(coordinatorId: string, handle: string): void {
    void this.enqueue(coordinatorId, async () => {
      if (!this.store) return;
      for (const item of this.mailbox.index().filter(row => row.coordinatorId === coordinatorId && row.ref.handle === handle)) {
        const entry = this.mailbox.lookup(coordinatorId, item.ref);
        if (!entry?.body || entry.conflict || !this.closedByLedger(entry)) continue;
        await this.port.saveArchive(); await this.port.saveLedger();
        const current = () => { this.port.assertCurrent(); if (!this.port.owns(coordinatorId, handle) || !this.closedByLedger(entry)) throw new Error('Archive changed'); };
        if (await this.port.persistence.retireArchivedResult(item.key, 'host-archive', current)) {
          this.mailbox.forgetArchived(coordinatorId, item.ref, entry.body.sourceDigest);
          this.rows.delete(item.key);
          this.preparations.delete(item.key); this.identities.delete(item.key);
          const archived = this.port.persistence.archivedResultBodies().find(row => row.key === item.key);
          if (archived) await this.reclaimClosed(archived);
        }
      }
    });
  }
  reserve(coordinatorId: string, handle: string): void {
    const identity = this.port.ledger.resultIdentity(coordinatorId, handle);
    if (!identity || !this.current(identity)) return;
    const result = this.mailbox.reserve(identity);
    if (result === 'reserved' || result === 'existing') this.identities.set(resultMailboxKey(coordinatorId, identity.ref), identity);
    if (result === 'reserved') this.reservations.add(resultMailboxKey(coordinatorId, identity.ref));
    else if (result !== 'existing') this.warn(coordinatorId, 'reservation-refused');
  }
  recover(coordinatorId: string): AsyncDelegationResult[] {
    return [...this.rows.entries()].filter(([key]) => {
      const row = this.mailbox.index().find(item => item.key === key);
      return row?.coordinatorId === coordinatorId && !this.held.has(coordinatorId);
    }).map(([, result]) => ({ ...result }));
  }
  canDeliver(coordinatorId: string, handle: string, revision?: number): boolean {
    const identity = this.port.ledger.resultIdentity(coordinatorId, handle);
    if (!identity || revision !== undefined && identity.ref.revision !== revision || !this.current(identity)) return false;
    const entry = this.mailbox.lookup(coordinatorId, identity.ref);
    const row = this.port.ledger.snapshot().flatMap(run => run.delegations).find(item => item.handle === handle);
    const result = row?.resultHistory?.find(result => result.ref.revision === identity.ref.revision);
    const scope = result?.decisionScopes?.at(-1);
    if (scope?.state === 'suspended' || scope?.state === 'closed' || result?.decision) return false;
    return entry ? entry.delivery === 'pending' && !entry.conflict : row?.delivery?.state !== 'delivered';
  }
  retain(coordinatorId: string, result: AsyncDelegationResult): number | undefined {
    const identity = this.port.ledger.resultIdentity(coordinatorId, result.handle);
    if (!identity || !this.current(identity)) return;
    this.reserve(coordinatorId, result.handle);
    const location = this.port.archive(identity, result.text);
    const state = result.outcome?.status === 'failed' ? 'failed' : 'ready';
    this.port.ledger.recordResultSettlement(identity, state);
    // v0.9.106: a review's numbered findings, joined to this settlement by host identities (the ledger checks them).
    if (result.reviewReport) this.port.ledger.recordReviewSet(identity, result.reviewReport);
    const settled = this.mailbox.settle(identity, state, result.text, location);
    if (settled !== 'settled' && settled !== 'duplicate') { this.warn(coordinatorId, 'settlement-refused'); return identity.ref.revision; }
    const key = resultMailboxKey(coordinatorId, identity.ref);
    if (settled === 'duplicate' && this.rows.has(key)) return identity.ref.revision;
    this.rows.set(key, { ...result, resultRevision: identity.ref.revision });
    void this.enqueue(coordinatorId, () => this.saveRetained(identity, key));
    return identity.ref.revision;
  }
  /** `attempted`: a handoff of this result began while it was held, so it is saved marked as `prepare()` marks it. */
  private async saveRetained(identity: ResultCompletionIdentity, key: string, attempted = false): Promise<void> {
    const { coordinatorId } = identity;
    try {
      const entry = this.mailbox.lookup(coordinatorId, identity.ref);
      await this.port.saveArchive();
      // v0.9.101 S4.1: the store is still opening. Hold the result and save it when the store opens; report nothing yet.
      if (entry && !this.store && this.storeOpening && !this.closed && this.current(identity)) this.hold(identity, key);
      else {
        const saved = !!entry && !!this.store && this.current(identity) && !!await this.port.persistence.saveResultMailboxEntry(
          attempted ? { ...entry, deliveryAttempted: true } : entry, this.store, () => { if (!this.current(identity)) throw new Error('stale result'); });
        // A result that stopped being the current one while this waited owes no recovery: nothing can be lost by not saving it.
        if (!saved && this.current(identity)) {
          this.port.ledger.resultRecovery(coordinatorId, identity.ref.handle, 'recovery-data-not-saved'); this.warn(coordinatorId, 'retained-save-failed');
        }
      }
      await this.port.saveLedger();
    } finally { this.reservations.delete(key); }
  }
  /** A later revision of the same result replaces the earlier one, which is no longer current and owes nothing. */
  private hold(identity: ResultCompletionIdentity, key: string): void {
    const slot = JSON.stringify([identity.coordinatorId, identity.ref.handle]);
    this.unsaved.delete(slot); this.unsaved.set(slot, { identity, key, attempted: false });
  }
  /** Await before the synchronous handoff. A crash in the gap becomes delivery-unknown, not a duplicate. */
  async prepare(coordinatorId: string, handle: string, revision?: number): Promise<void> {
    const identity = this.port.ledger.resultIdentity(coordinatorId, handle);
    const entry = identity && this.mailbox.lookup(coordinatorId, identity.ref);
    if (!identity || revision !== undefined && identity.ref.revision !== revision || !entry || entry.delivery !== 'pending'
      || entry.conflict || !this.current(identity)) return;
    this.port.ledger.resultRecovery(coordinatorId, handle, 'delivery-unknown');
    const key = resultMailboxKey(coordinatorId, identity.ref);
    let work = this.preparations.get(key);
    if (!work) {
      work = this.enqueue(coordinatorId, async () => {
        this.reservations.add(key);
        try {
          await this.port.saveLedger();
          // v0.9.101 S4.1: a result held for a store still opening is saved, marked as handed over, when the store opens.
          const waiting = this.unsaved.get(JSON.stringify([coordinatorId, handle]));
          if (waiting?.key === key) { waiting.attempted = true; if (!this.store) return; }
          if (!this.store || !await this.port.persistence.saveResultMailboxEntry({ ...entry, deliveryAttempted: true }, this.store,
            () => { if (!this.current(identity)) throw new Error('stale result'); }) && this.current(identity)) this.warn(coordinatorId, 'prepared-save-failed');
        } finally { this.reservations.delete(key); }
      }); this.preparations.set(key, work);
      const pending = work;
      // The deadline counts from the work's creation, so time queued behind earlier work counts too. It can only fire
      // while the work is pending: settling and close() both clear it.
      if (!this.closed) {
        const deadline = setTimeout(() => this.warn(coordinatorId, 'prepared-save-pending'), RECOVERY_PENDING_NOTICE_MS);
        (deadline as { unref?: () => void }).unref?.();
        this.recoveryDeadlines.set(key, deadline);
      }
      void work.finally(() => {
        if (this.preparations.get(key) === pending) this.preparations.delete(key);
        const deadline = this.recoveryDeadlines.get(key);
        if (deadline) { clearTimeout(deadline); this.recoveryDeadlines.delete(key); }
      });
    }
    // The handoff still waits up to 500 ms for the save. A save still pending then is not reported here: the deadline
    // above reports one still pending at 30 s, and a failed save is reported by its own path.
    await this.withinRecoveryBudget(work);
  }
  delivered(coordinatorId: string, handle: string, via: Via, revision?: number): void {
    const identity = this.port.ledger.resultIdentity(coordinatorId, handle);
    if (!identity || revision !== undefined && identity.ref.revision !== revision || !this.current(identity)) return;
    const token = this.mailbox.tryClaim(coordinatorId, identity.ref, via, { coordinatorId, sessionId: coordinatorId, requestId: identity.settledEventId });
    if (!token || !this.mailbox.ackDelivery(token)) return;
    this.rows.delete(resultMailboxKey(coordinatorId, identity.ref));
    void this.enqueue(coordinatorId, async () => {
      const entry = this.mailbox.lookup(coordinatorId, identity.ref);
      if (!entry?.body || !this.current(identity)) return;
      await this.port.recordDelivery(identity, entry.body.sourceDigest, via);
      this.port.ledger.resultRecovery(coordinatorId, handle, undefined);
      if (this.store) await this.port.persistence.saveResultMailboxEntry(entry, this.store, () => { if (!this.current(identity)) throw new Error('stale result'); });
      await this.port.saveLedger();
    });
  }
  /** `turnStopped`: this Stop ended a running turn of the coordinator, the one Stop the reminder says closes a result with no body. */
  scope(coordinatorId: string, cause: ResultScopeEvent['cause'], turnStopped = false): void {
    if (this.pendingNotices.has(coordinatorId)) this.tell(coordinatorId);
    if (cause === 'explicit-resume') this.held.delete(coordinatorId); else this.held.add(coordinatorId);
    const items = this.mailbox.index().filter(row => row.coordinatorId === coordinatorId);
    const history = this.port.ledger.snapshot().filter(run => run.coordinatorId === coordinatorId).flatMap(run => run.delegations);
    const resuming = cause === 'explicit-resume' && items.some(item => history.find(task => task.handle === item.ref.handle)
      ?.resultHistory?.find(result => result.ref.revision === item.ref.revision)?.decisionScopes?.at(-1)?.state === 'suspended');
    const closesUnavailable = cause === 'coordinator-stopped' ? turnStopped : cause !== 'explicit-resume';
    const closed = closesUnavailable ? this.port.ledger.closeUnavailableResults(coordinatorId, cause) : 0;
    for (const handle of new Set(items.map(item => item.ref.handle))) {
      this.port.ledger.resultScope(coordinatorId, handle, { cause, state: cause === 'explicit-resume' ? 'reopened'
        : cause === 'coordinator-stopped' ? 'suspended' : 'closed', recordedAt: new Date().toISOString(), by: 'host-lifecycle' });
    }
    if (items.length || closed) void this.enqueue(coordinatorId, () => this.port.saveLedger());
    if (resuming) this.port.recoveryReady?.(coordinatorId, this.recover(coordinatorId));
    if (cause !== 'explicit-resume' && cause !== 'coordinator-stopped') {
      for (const item of items) this.archiveDecided(coordinatorId, item.ref.handle);
    }
  }
  /** v0.9.99: Stop has stopped or suspended this coordinator until the person resumes it. */
  isHeld(coordinatorId: string): boolean { return this.held.has(coordinatorId); }
  async drain(): Promise<void> { await this.recovery; await this.tail; }
  /** v0.9.99: the owner is going away. Clears every recovery-pending deadline; a late one never warns. */
  close(): void {
    this.closed = true;
    for (const deadline of this.recoveryDeadlines.values()) clearTimeout(deadline);
    this.recoveryDeadlines.clear();
    this.dropUnsaved(); // v0.9.101 S4.1: nothing held is saved after close.
  }
}

export const resultTextDigest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Compare only the closed host identity, not JSON property order or extra recovery-body fields. */
export function resultDeliveryMarkerMatches(message: Message, identity: ResultCompletionIdentity, digest: string): boolean {
  const marker = message.payload.metadata?.resultDelivery as ResultCompletionIdentity | undefined;
  return message.from === 'unode' && message.to === identity.coordinatorId && message.type === 'system.heartbeat'
    && marker?.coordinatorId === identity.coordinatorId && marker.ref?.handle === identity.ref.handle
    && marker.ref.revision === identity.ref.revision && marker.attemptId === identity.attemptId
    && marker.settledEventId === identity.settledEventId && message.payload.metadata?.sourceDigest === digest;
}
