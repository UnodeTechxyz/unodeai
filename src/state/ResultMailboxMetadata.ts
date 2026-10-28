import { parseStandingResult } from '../backend/DelegationResultProjection';
import { RESULT_MAILBOX_LIMITS, resultMailboxKey, type ResultMailboxEntry } from './DelegationResultMailbox';
import type { ResultBodyFileRef } from './DelegationResultBodyStore';

export const RESULT_MAILBOX_INDEX_KEY = 'unode.pendingDelegationResult.v2.index';
export const resultMailboxItemKey = (key: string) => `unode.pendingDelegationResult.v2:${key}`;
const HEX = /^[a-f0-9]{64}$/;
export type ResultMailboxMetadata = Omit<ResultMailboxEntry, 'body'> & {
  key: string;
  /** Same bounded item retained after removal from the active index; no second cleanup queue. */
  archiveOwner?: string;
  body?: Omit<NonNullable<ResultMailboxEntry['body']>, 'text'> & { file: ResultBodyFileRef };
};

/** Closed recovery metadata, not a second ledger. No result text ever enters a Memento item or its index. */
export function resultMailboxMetadata(entry: ResultMailboxEntry, file?: ResultBodyFileRef): ResultMailboxMetadata | undefined {
  const body = entry.body && { bytes: entry.body.bytes, sourceBytes: entry.body.sourceBytes, sourceDigest: entry.body.sourceDigest,
    truncated: entry.body.truncated, ...(entry.body.location ? { location: entry.body.location } : {}), file };
  return parseResultMailboxMetadata({ key: resultMailboxKey(entry.coordinatorId, entry.ref), coordinatorId: entry.coordinatorId,
    ref: entry.ref, attemptId: entry.attemptId, settledEventId: entry.settledEventId, state: entry.state,
    ...(entry.delivery ? { delivery: entry.delivery } : {}), ...(entry.deliveredVia ? { deliveredVia: entry.deliveredVia } : {}),
    ...(entry.conflict ? { conflict: true } : {}), ...(entry.deliveryAttempted ? { deliveryAttempted: true } : {}), ...(body ? { body } : {}) });
}

export function parseResultMailboxMetadata(value: unknown): ResultMailboxMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as ResultMailboxMetadata;
  const identity = (text: unknown): text is string => typeof text === 'string' && text.length > 0 && text.length <= 500 && !/[\0\r\n]/.test(text);
  if (!identity(raw.coordinatorId) || !identity(raw.attemptId) || !identity(raw.settledEventId)
    || !raw.ref || !identity(raw.ref.handle) || !Number.isSafeInteger(raw.ref.revision) || raw.ref.revision < 1
    || raw.key !== resultMailboxKey(raw.coordinatorId, raw.ref)) return undefined;
  const base = { key: raw.key, coordinatorId: raw.coordinatorId, ref: { handle: raw.ref.handle, revision: raw.ref.revision },
    attemptId: raw.attemptId, settledEventId: raw.settledEventId };
  let clean: ResultMailboxMetadata;
  if (raw.state === 'reserved') {
    if (raw.body !== undefined || raw.delivery !== undefined || raw.deliveredVia !== undefined) return undefined;
    clean = { ...base, state: 'reserved', ...(raw.conflict ? { conflict: true } : {}) };
  } else {
    const standing = parseStandingResult(raw);
    const body = raw.body; const file = body?.file;
    if (!standing || !body || !file || !HEX.test(file.key) || file.key !== raw.key || !HEX.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > RESULT_MAILBOX_LIMITS.bodyBytes
      || body.bytes !== file.bytes || !Number.isSafeInteger(body.sourceBytes) || body.sourceBytes < body.bytes
      || !HEX.test(body.sourceDigest) || typeof body.truncated !== 'boolean'
      || !body.truncated && body.sourceDigest !== file.sha256
      || body.truncated !== (body.sourceBytes > body.bytes)
      || body.location !== undefined && (!identity(body.location.conversationId) || !identity(body.location.messageId))
      || body.truncated && !body.location) return undefined;
    clean = { ...base, state: standing.state, delivery: standing.delivery,
      ...(raw.deliveryAttempted === true ? { deliveryAttempted: true } : {}),
      ...(standing.deliveredVia ? { deliveredVia: standing.deliveredVia } : {}), ...(standing.conflict ? { conflict: true } : {}),
      body: { bytes: body.bytes, sourceBytes: body.sourceBytes, sourceDigest: body.sourceDigest, truncated: body.truncated,
        file: { key: file.key, bytes: file.bytes, sha256: file.sha256 },
        ...(body.location ? { location: { conversationId: body.location.conversationId, messageId: body.location.messageId } } : {}) } };
  }
  if (raw.archiveOwner !== undefined) {
    if (typeof raw.archiveOwner !== 'string' || !(raw.archiveOwner === 'host-archive' || /^vscode-main:[1-9][0-9]{0,9}$/.test(raw.archiveOwner))
      || clean.state === 'reserved' || !clean.body?.location) return undefined;
    clean.archiveOwner = raw.archiveOwner;
  }
  return Buffer.byteLength(JSON.stringify(clean), 'utf8') <= RESULT_MAILBOX_LIMITS.metadataBytes ? clean : undefined;
}

/** Reject a corrupt index without inventing a ready body or silently evicting an entry. */
export function parseResultMailboxIndex(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > RESULT_MAILBOX_LIMITS.slots
    || value.some(key => typeof key !== 'string' || !HEX.test(key)) || new Set(value).size !== value.length) return undefined;
  return [...value];
}
