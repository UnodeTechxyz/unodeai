import { createHash } from 'node:crypto';
import { parseResultRef, parseStandingResult, type ResultRef, type ResultScopeEvent } from '../backend/DelegationResultProjection';

export const RESULT_MAILBOX_LIMITS = Object.freeze({ slots: 256, bodyBytes: 64 * 1024, totalBytes: 8 * 1024 * 1024, metadataBytes: 2048 });
export interface ResultCompletionIdentity {
  coordinatorId: string;
  ref: ResultRef;
  attemptId: string;
  /** Allocated before dispatch/rework, not while processing the final callback. */
  settledEventId: string;
}
export interface ResultBodyLocation { conversationId: string; messageId: string }
export interface ResultMailboxBody {
  text: string;
  bytes: number;
  sourceBytes: number;
  sourceDigest: string;
  truncated: boolean;
  location?: ResultBodyLocation;
}
export interface ResultMailboxEntry extends ResultCompletionIdentity {
  state: 'reserved' | 'ready' | 'failed';
  delivery?: 'pending' | 'delivered';
  deliveredVia?: 'auto-wake' | 'collect-ready' | 'blocking-tool';
  body?: ResultMailboxBody;
  conflict?: true;
  /** Persisted before a handoff. Without a recovered conversation marker it means unknown, not pending. */
  deliveryAttempted?: true;
}
export interface ResultDeliveryContext { coordinatorId: string; sessionId: string; requestId: string }
declare const deliveryToken: unique symbol;
export type ResultDeliveryToken = { readonly [deliveryToken]: true };
export interface ResultArchiveReceipt {
  coordinatorId: string;
  ref: ResultRef;
  /** Required for a settled body; the port has observed its durable existing-conversation record. */
  location?: ResultBodyLocation;
  sourceDigest?: string;
}
export interface ResultMailboxAuthority {
  ownsCoordinator(coordinatorId: string): boolean;
  /** Existing ledger authority: exact current attempt/event/revision AND an open/reopened decision scope.
   * A successful archive closes/suspends it before returning; this kernel keeps no second tombstone store. */
  currentCompletion(identity: ResultCompletionIdentity): boolean;
  currentDelivery(context: ResultDeliveryContext, identity: ResultCompletionIdentity): boolean;
  /** Persist lifecycle and the existing conversation location BEFORE returning a qualified receipt. */
  archive(entry: Readonly<ResultMailboxEntry>, scope: ResultScopeEvent): Promise<ResultArchiveReceipt | undefined>;
  reportStorageError(error: unknown): void;
}
type HeldEntry = { value: ResultMailboxEntry; closing: boolean; claim?: ResultDeliveryToken };
type Claim = { key: string; context: ResultDeliveryContext; via: NonNullable<ResultMailboxEntry['deliveredVia']> };
export type MailboxAdmission = 'reserved' | 'existing' | 'capacity' | 'invalid' | 'stale' | 'conflict';

/** Bounded in-memory kernel for the existing pending-result store. This class owns no files/database,
 * starts no worker, infers no disposition, and cannot mint a completion identity or host lease.
 * Production consumers must supply the existing ledger/session authority and per-item persistence port. */
export class DelegationResultMailbox {
  private readonly rows = new Map<string, HeldEntry>();
  private readonly claims = new WeakMap<ResultDeliveryToken, Claim>();
  constructor(private readonly authority: ResultMailboxAuthority) {}

  /** Host recovery only. Reconstruct an existing result, never a live worker or an in-flight claim. */
  restore(entry: ResultMailboxEntry): boolean {
    const identity = cleanIdentity(entry);
    if (!identity || !entry.body || !['ready', 'failed'].includes(entry.state)
      || !this.authority.ownsCoordinator(identity.coordinatorId) || !this.authority.currentCompletion(identity)) return false;
    const key = resultMailboxKey(identity.coordinatorId, identity.ref);
    if (this.rows.has(key)) return false;
    const usage = this.usage();
    if (usage.slots >= RESULT_MAILBOX_LIMITS.slots || usage.totalBytes + entry.body.bytes > RESULT_MAILBOX_LIMITS.totalBytes) return false;
    this.rows.set(key, { value: structuredClone(entry), closing: false }); return true;
  }

  usage(): { slots: number; reservedBytes: number; bodyBytes: number; totalBytes: number } {
    let reservedBytes = 0; let bodyBytes = 0;
    for (const { value } of this.rows.values()) {
      if (value.state === 'reserved') reservedBytes += RESULT_MAILBOX_LIMITS.bodyBytes;
      else bodyBytes += value.body?.bytes ?? 0;
    }
    return { slots: this.rows.size, reservedBytes, bodyBytes, totalBytes: reservedBytes + bodyBytes };
  }

  reserve(identity: ResultCompletionIdentity): MailboxAdmission {
    const clean = cleanIdentity(identity); if (!clean || metadataBytes({ ...clean, state: 'reserved' }) > RESULT_MAILBOX_LIMITS.metadataBytes) return 'invalid';
    if (!this.authority.ownsCoordinator(clean.coordinatorId) || !this.authority.currentCompletion(structuredClone(clean))) return 'stale';
    const key = resultMailboxKey(clean.coordinatorId, clean.ref); const existing = this.rows.get(key);
    if (existing) {
      if (existing.closing) return 'stale';
      if (existing.value.conflict || !sameCompletion(existing.value, clean)) { existing.value.conflict = true; return 'conflict'; }
      return 'existing';
    }
    const usage = this.usage();
    if (usage.slots >= RESULT_MAILBOX_LIMITS.slots || usage.totalBytes + RESULT_MAILBOX_LIMITS.bodyBytes > RESULT_MAILBOX_LIMITS.totalBytes) return 'capacity';
    this.rows.set(key, { value: { ...clean, state: 'reserved' }, closing: false }); return 'reserved';
  }

  settle(identity: ResultCompletionIdentity, state: 'ready' | 'failed', text: string,
    location?: ResultBodyLocation): 'settled' | 'duplicate' | 'conflict' | 'invalid' | 'stale' | 'body-location-required' {
    const clean = cleanIdentity(identity);
    if (!clean || !['ready', 'failed'].includes(state) || typeof text !== 'string' || location !== undefined && !validLocation(location)) return 'invalid';
    if (!this.authority.ownsCoordinator(clean.coordinatorId) || !this.authority.currentCompletion(structuredClone(clean))) return 'stale';
    const row = this.rows.get(resultMailboxKey(clean.coordinatorId, clean.ref));
    if (!row || row.closing || !sameCompletion(row.value, clean)) return 'stale';
    if (row.value.conflict) return 'conflict';
    const body = boundedResultBody(text, location);
    if (body.truncated && !body.location) return 'body-location-required';
    if (row.value.state !== 'reserved') {
      if (row.value.state === state && row.value.body?.sourceDigest === body.sourceDigest) return 'duplicate';
      row.value.conflict = true; return 'conflict';
    }
    const next: ResultMailboxEntry = { ...clean, state, delivery: 'pending', body };
    if (metadataBytes({ ...next, delivery: 'delivered', deliveredVia: 'blocking-tool' }) > RESULT_MAILBOX_LIMITS.metadataBytes) return 'invalid';
    row.value = next; return 'settled';
  }

  /** No claim is taken by a wake queue or an ordinary lookup. Call only at the synchronous handoff. */
  tryClaim(coordinatorId: string, ref: ResultRef, via: NonNullable<ResultMailboxEntry['deliveredVia']>,
    context: ResultDeliveryContext): ResultDeliveryToken | undefined {
    const cleanRef = parseResultRef(ref);
    const cleanContext = context && { coordinatorId: context.coordinatorId, sessionId: context.sessionId, requestId: context.requestId };
    if (!cleanRef || !['auto-wake', 'collect-ready', 'blocking-tool'].includes(via)
      || !cleanContext || cleanContext.coordinatorId !== coordinatorId || !identityText(cleanContext.sessionId) || !identityText(cleanContext.requestId)) return undefined;
    const key = resultMailboxKey(coordinatorId, cleanRef); const row = this.rows.get(key);
    if (!row || row.closing || row.claim || row.value.conflict || row.value.state === 'reserved' || row.value.delivery !== 'pending'
      || !this.authority.ownsCoordinator(coordinatorId) || !this.authority.currentCompletion(cleanIdentity(row.value)!)
      || !this.authority.currentDelivery({ ...cleanContext }, cleanIdentity(row.value)!)) return undefined;
    const token = Object.freeze({}) as ResultDeliveryToken;
    this.claims.set(token, { key, context: cleanContext, via }); row.claim = token; return token;
  }

  ackDelivery(token: ResultDeliveryToken): boolean {
    const claim = this.claims.get(token); const row = claim && this.rows.get(claim.key);
    if (!claim || !row || row.claim !== token || row.closing) return false;
    if (row.value.conflict || !this.authority.ownsCoordinator(row.value.coordinatorId) || !this.authority.currentCompletion(cleanIdentity(row.value)!)
      || !this.authority.currentDelivery({ ...claim.context }, cleanIdentity(row.value)!)) { this.releaseClaim(token); return false; }
    row.value.delivery = 'delivered'; row.value.deliveredVia = claim.via;
    this.releaseClaim(token); return true; // Body remains queryable and allocated until a durable scope/decision release.
  }

  releaseClaim(token: ResultDeliveryToken): boolean {
    const claim = this.claims.get(token); const row = claim && this.rows.get(claim.key);
    if (!claim || !row || row.claim !== token) return false;
    delete row.claim; this.claims.delete(token); return true;
  }

  lookup(coordinatorId: string, ref: ResultRef): ResultMailboxEntry | undefined {
    const cleanRef = parseResultRef(ref); if (!cleanRef) return undefined;
    const row = this.rows.get(resultMailboxKey(coordinatorId, cleanRef)); return row && structuredClone(row.value);
  }

  /** Host already archived this exact decided/closed result and released its active index. Not a body deletion. */
  forgetArchived(coordinatorId: string, ref: ResultRef, digest: string): boolean {
    const key = resultMailboxKey(coordinatorId, ref); const row = this.rows.get(key);
    if (!row || row.value.conflict || row.value.body?.sourceDigest !== digest) return false;
    if (row.claim) this.releaseClaim(row.claim); this.rows.delete(key); return true;
  }

  /** Content-free bounded inventory for a per-item index; never returns an array of all bodies. */
  index(): Array<{ key: string; coordinatorId: string; ref: ResultRef; bodyBytes: number; reservedBytes: number }> {
    return [...this.rows].map(([key, { value }]) => ({ key, coordinatorId: value.coordinatorId, ref: { ...value.ref },
      bodyBytes: value.body?.bytes ?? 0, reservedBytes: value.state === 'reserved' ? RESULT_MAILBOX_LIMITS.bodyBytes : 0 }));
  }

  /** Never free the only body to make capacity green. A failed archive retains allocation and claims. */
  async releaseAfterArchive(coordinatorId: string, ref: ResultRef, scope: ResultScopeEvent): Promise<'released' | 'missing' | 'stale' | 'storage-error'> {
    const cleanRef = parseResultRef(ref);
    if (!cleanRef || !this.authority.ownsCoordinator(coordinatorId)) return 'stale';
    const key = resultMailboxKey(coordinatorId, cleanRef); const row = this.rows.get(key);
    if (!row) return 'missing'; if (row.closing) return 'stale';
    const scopeCheck = parseStandingResult({ ...row.value, state: 'ready', delivery: 'pending', decisionScopes: [scope] });
    if (!scopeCheck || scope.bodyRef !== undefined && !validLocation(scope.bodyRef)
      || scope.state === 'reopened' || scope.state === 'suspended' && scope.cause !== 'coordinator-stopped'
      || scope.state === 'closed' && scope.cause === 'coordinator-stopped') return 'stale';
    row.closing = true;
    try {
      const receipt = await this.authority.archive(structuredClone(row.value), scopeCheck.decisionScopes![0]);
      if (!receipt || receipt.coordinatorId !== coordinatorId || receipt.ref.handle !== cleanRef.handle || receipt.ref.revision !== cleanRef.revision
        || row.value.body && (!validLocation(receipt.location) || receipt.sourceDigest !== row.value.body.sourceDigest)) return 'storage-error';
      if (this.rows.get(key) !== row || !this.authority.ownsCoordinator(coordinatorId)) return 'stale';
      if (row.claim) this.releaseClaim(row.claim);
      this.rows.delete(key); return 'released';
    } catch (error) { this.authority.reportStorageError(error); return 'storage-error'; }
    finally { row.closing = false; }
  }
}

export function resultMailboxKey(coordinatorId: string, ref: ResultRef): string {
  return createHash('sha256').update(JSON.stringify([coordinatorId, ref.handle, ref.revision]), 'utf8').digest('hex');
}
function identityText(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\0\r\n]/.test(value); }
function validLocation(value: unknown): value is ResultBodyLocation {
  const location = value as ResultBodyLocation | undefined;
  return !!location && identityText(location.conversationId) && identityText(location.messageId);
}
function cleanIdentity(value: ResultCompletionIdentity): ResultCompletionIdentity | undefined {
  const ref = value && parseResultRef(value.ref);
  return ref && identityText(value.coordinatorId) && identityText(value.attemptId) && identityText(value.settledEventId)
    ? { coordinatorId: value.coordinatorId, ref, attemptId: value.attemptId, settledEventId: value.settledEventId } : undefined;
}
function sameCompletion(a: ResultCompletionIdentity, b: ResultCompletionIdentity): boolean {
  return a.coordinatorId === b.coordinatorId && a.ref.handle === b.ref.handle && a.ref.revision === b.ref.revision
    && a.attemptId === b.attemptId && a.settledEventId === b.settledEventId;
}
function metadataBytes(value: object): number {
  const { body, ...metadata } = value as ResultMailboxEntry;
  const bodyMetadata = body && { bytes: body.bytes, sourceBytes: body.sourceBytes, sourceDigest: body.sourceDigest,
    truncated: body.truncated, ...(body.location ? { location: body.location } : {}) };
  return Buffer.byteLength(JSON.stringify({ ...metadata, ...(bodyMetadata ? { body: bodyMetadata } : {}) }), 'utf8');
}
export function boundedResultBody(text: string, location?: ResultBodyLocation): ResultMailboxBody {
  const sourceBytes = Buffer.byteLength(text, 'utf8'); const hash = createHash('sha256');
  // Bound transient UTF-8 encoding allocations too; do not split a surrogate pair between hash updates.
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 32768, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    hash.update(text.slice(offset, end), 'utf8'); offset = end;
  }
  const truncated = sourceBytes > RESULT_MAILBOX_LIMITS.bodyBytes;
  let kept = text;
  if (truncated) {
    const marker = '\n\n[truncated; read the worker conversation for the full result]\n\n';
    const headRoom = Math.floor((RESULT_MAILBOX_LIMITS.bodyBytes - Buffer.byteLength(marker)) / 2);
    const tailRoom = RESULT_MAILBOX_LIMITS.bodyBytes - Buffer.byteLength(marker) - headRoom;
    const head = Buffer.from(text.slice(0, RESULT_MAILBOX_LIMITS.bodyBytes + 2), 'utf8');
    let end = Math.min(headRoom, head.length); while (end > 0 && (head[end] & 0xc0) === 0x80) end--;
    const tail = Buffer.from(text.slice(-RESULT_MAILBOX_LIMITS.bodyBytes - 2), 'utf8');
    let start = Math.max(0, tail.length - tailRoom); while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
    kept = head.subarray(0, end).toString('utf8') + marker + tail.subarray(start).toString('utf8');
  }
  return { text: kept, bytes: Buffer.byteLength(kept, 'utf8'), sourceBytes, sourceDigest: hash.digest('hex'), truncated,
    ...(location ? { location: { conversationId: location.conversationId, messageId: location.messageId } } : {}) };
}
