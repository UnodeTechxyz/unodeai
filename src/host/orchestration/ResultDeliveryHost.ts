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
  notice(coordinatorId: string): boolean | void;
  recoveryReady?(coordinatorId: string, results: readonly AsyncDelegationResult[]): void;
}

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
  private readonly identities = new Map<string, ResultCompletionIdentity>();
  private readonly preparations = new Map<string, Promise<unknown>>();
  /** v0.9.99: one recovery-pending deadline per preparation work, cleared when that work settles or on close. */
  private readonly recoveryDeadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  private recovery?: Promise<void>;
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
  private warn(id: string): void {
    if (this.warned.has(id)) return;
    if (this.port.notice(id) === false) this.pendingNotices.add(id);
    else { this.warned.add(id); this.pendingNotices.delete(id); }
  }
  private enqueue<T>(id: string, action: () => Promise<T>): Promise<T | undefined> {
    const next = this.tail.then(action).catch(() => { this.warn(id); return undefined; });
    this.tail = next; return next;
  }
  /** Optional recovery must not keep extension activation waiting on a hung storage device. */
  async open(): Promise<void> { this.recovery = this.recoverStorage(); await this.withinRecoveryBudget(this.recovery); }
  private async recoverStorage(): Promise<void> {
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
      for (const archived of this.port.persistence.archivedResultBodies()) {
        try { await this.reclaimClosed(archived); }
        catch { this.warn(archived.coordinatorId); }
      }
      const legacy = this.port.persistence.loadPendingDelegationResults();
      if (legacy.length) {
        for (const row of legacy) {
          const identity = this.port.ledger.adoptLegacyResultIdentity(row.coordinatorId, row.handle, row.ref);
          if (!identity || !this.current(identity)) { this.warn(row.coordinatorId); continue; }
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
    else if (result !== 'existing') this.warn(coordinatorId);
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
    const settled = this.mailbox.settle(identity, state, result.text, location);
    if (settled !== 'settled' && settled !== 'duplicate') { this.warn(coordinatorId); return identity.ref.revision; }
    const key = resultMailboxKey(coordinatorId, identity.ref);
    if (settled === 'duplicate' && this.rows.has(key)) return identity.ref.revision;
    this.rows.set(key, { ...result, resultRevision: identity.ref.revision });
    void this.enqueue(coordinatorId, async () => {
      try {
        const entry = this.mailbox.lookup(coordinatorId, identity.ref);
        await this.port.saveArchive();
        if (!entry || !this.store || !this.current(identity)
          || !await this.port.persistence.saveResultMailboxEntry(entry, this.store, () => { if (!this.current(identity)) throw new Error('stale result'); })) {
          this.port.ledger.resultRecovery(coordinatorId, result.handle, 'recovery-data-not-saved'); this.warn(coordinatorId);
        }
        await this.port.saveLedger();
      } finally { this.reservations.delete(key); }
    });
    return identity.ref.revision;
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
          if (!this.store || !await this.port.persistence.saveResultMailboxEntry({ ...entry, deliveryAttempted: true }, this.store,
            () => { if (!this.current(identity)) throw new Error('stale result'); })) this.warn(coordinatorId);
        } finally { this.reservations.delete(key); }
      }); this.preparations.set(key, work);
      const pending = work;
      // The deadline counts from the work's creation, so time queued behind earlier work counts too. It can only fire
      // while the work is pending: settling and close() both clear it.
      if (!this.closed) {
        const deadline = setTimeout(() => this.warn(coordinatorId), RECOVERY_PENDING_NOTICE_MS);
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
  scope(coordinatorId: string, cause: ResultScopeEvent['cause']): void {
    if (this.pendingNotices.has(coordinatorId)) this.warn(coordinatorId);
    if (cause === 'explicit-resume') this.held.delete(coordinatorId); else this.held.add(coordinatorId);
    const items = this.mailbox.index().filter(row => row.coordinatorId === coordinatorId);
    const history = this.port.ledger.snapshot().filter(run => run.coordinatorId === coordinatorId).flatMap(run => run.delegations);
    const resuming = cause === 'explicit-resume' && items.some(item => history.find(task => task.handle === item.ref.handle)
      ?.resultHistory?.find(result => result.ref.revision === item.ref.revision)?.decisionScopes?.at(-1)?.state === 'suspended');
    for (const item of items) {
      this.port.ledger.resultScope(coordinatorId, item.ref.handle, { cause, state: cause === 'explicit-resume' ? 'reopened'
        : cause === 'coordinator-stopped' ? 'suspended' : 'closed', recordedAt: new Date().toISOString(), by: 'host-lifecycle' });
    }
    if (items.length) void this.enqueue(coordinatorId, () => this.port.saveLedger());
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
