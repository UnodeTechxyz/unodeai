import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DelegationResultMailbox, RESULT_MAILBOX_LIMITS, resultMailboxKey,
  type ResultArchiveReceipt, type ResultCompletionIdentity, type ResultDeliveryContext, type ResultDeliveryToken } from '../DelegationResultMailbox';
import type { ResultScopeEvent } from '../../backend/DelegationResultProjection';

const location = { conversationId: 'worker-thread', messageId: 'worker-final' };
const context: ResultDeliveryContext = { coordinatorId: 'pm', sessionId: 'pm-session', requestId: 'pm-request' };
const identity = (handle = 'h', revision = 1, coordinatorId = 'pm'): ResultCompletionIdentity => ({
  coordinatorId, ref: { handle, revision }, attemptId: `attempt-${handle}-${revision}`, settledEventId: `event-${handle}-${revision}` });
const scope: ResultScopeEvent = { state: 'closed', cause: 'team-switched', by: 'host-lifecycle', recordedAt: '2026-10-25T01:00:00Z' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let owner = true; let activeRequest = 'pm-request'; let current = true;
  const archive = vi.fn(async (entry: ReturnType<DelegationResultMailbox['lookup']>): Promise<ResultArchiveReceipt | undefined> => entry && ({
    coordinatorId: entry.coordinatorId, ref: entry.ref, ...(entry.body ? { location, sourceDigest: entry.body.sourceDigest } : {}) }));
  const report = vi.fn();
  const currentCompletion = vi.fn((_identity: ResultCompletionIdentity) => current);
  const currentDelivery = vi.fn((request: ResultDeliveryContext, _identity: ResultCompletionIdentity) => request.sessionId === context.sessionId && request.requestId === activeRequest);
  const mailbox = new DelegationResultMailbox({ ownsCoordinator: () => owner, currentCompletion, currentDelivery, archive, reportStorageError: report });
  const ready = (id = identity(), text = 'typed result') => { expect(mailbox.reserve(id)).toBe('reserved'); expect(mailbox.settle(id, 'ready', text, location)).toBe('settled'); return id; };
  return { mailbox, ready, archive, report, currentCompletion, currentDelivery,
    owner: (value: boolean) => { owner = value; }, request: (value: string) => { activeRequest = value; }, current: (value: boolean) => { current = value; } };
}

describe('T2b bounded result mailbox kernel (not production wiring)', () => {
  it('reserves 64 KiB before dispatch: only 128 full reservations fit in 8 MiB', () => {
    const h = fixture();
    for (let i = 0; i < 128; i++) expect(h.mailbox.reserve(identity(`h-${i}`))).toBe('reserved');
    expect(h.mailbox.usage()).toEqual({ slots: 128, reservedBytes: 8 * 1024 * 1024, bodyBytes: 0, totalBytes: 8 * 1024 * 1024 });
    expect(h.mailbox.reserve(identity('one-too-many'))).toBe('capacity');
    expect(h.mailbox.usage().slots).toBe(128);
  });
  it('replaces reservations with actual UTF-8 body bytes but never exceeds 256 retained slots', () => {
    const h = fixture();
    for (let i = 0; i < 256; i++) h.ready(identity(`h-${i}`), '中');
    expect(h.mailbox.usage()).toEqual({ slots: 256, reservedBytes: 0, bodyBytes: 768, totalBytes: 768 });
    expect(h.mailbox.reserve(identity('over-count'))).toBe('capacity');
  });
  it('rework reserves an independent slot while the old result is retained; same agent/handle does not overwrite it', () => {
    const h = fixture(); const prior = h.ready(); const next = identity('h', 2);
    expect(h.mailbox.reserve(next)).toBe('reserved');
    expect(h.mailbox.lookup('pm', prior.ref)?.body?.text).toBe('typed result');
    expect(h.mailbox.lookup('pm', next.ref)?.state).toBe('reserved'); expect(h.mailbox.usage().slots).toBe(2);
    expect(h.mailbox.reserve(next)).toBe('existing'); expect(h.mailbox.usage().slots).toBe(2);
  });
  it.each(['auto-wake', 'collect-ready', 'blocking-tool'] as const)('%s claim is synchronous/exclusive; delivery leaves body owed and queryable', via => {
    const h = fixture(); const id = h.ready();
    const token = h.mailbox.tryClaim('pm', id.ref, via, context); expect(token).toBeDefined();
    expect(h.mailbox.tryClaim('pm', id.ref, 'collect-ready', context)).toBeUndefined();
    expect(h.mailbox.ackDelivery(token!)).toBe(true); expect(h.mailbox.ackDelivery(token!)).toBe(false);
    expect(h.mailbox.lookup('pm', id.ref)).toMatchObject({ delivery: 'delivered', deliveredVia: via, body: { text: 'typed result' } });
    expect(h.mailbox.tryClaim('pm', id.ref, 'auto-wake', context)).toBeUndefined(); expect(h.mailbox.usage().slots).toBe(1);
  });
  it('a busy wake can look up a ref without taking a claim; collect wins and later idle flush cannot inject again', () => {
    const h = fixture(); const id = h.ready(); expect(h.mailbox.lookup('pm', id.ref)?.delivery).toBe('pending');
    const collect = h.mailbox.tryClaim('pm', id.ref, 'collect-ready', context)!;
    expect(h.mailbox.ackDelivery(collect)).toBe(true);
    const retrieval = h.mailbox.lookup('pm', id.ref); expect(retrieval?.body?.text).toBe('typed result');
    expect(h.mailbox.tryClaim('pm', id.ref, 'auto-wake', context)).toBeUndefined();
  });
  it('failed handoff releases its claim without deleting the body; fabricated tokens cannot ack', () => {
    const h = fixture(); const id = h.ready(); const first = h.mailbox.tryClaim('pm', id.ref, 'auto-wake', context)!;
    expect(h.mailbox.ackDelivery({} as ResultDeliveryToken)).toBe(false); expect(h.mailbox.releaseClaim(first)).toBe(true);
    expect(h.mailbox.ackDelivery(first)).toBe(false); const next = h.mailbox.tryClaim('pm', id.ref, 'collect-ready', context)!;
    expect(next).toBeDefined(); expect(h.mailbox.ackDelivery(next)).toBe(true); expect(h.mailbox.lookup('pm', id.ref)?.body).toBeDefined();
  });
  it.each(['request', 'owner', 'completion'] as const)('invalid %s authority refuses ack without falsely marking delivered', kind => {
    const h = fixture(); const id = h.ready(); const token = h.mailbox.tryClaim('pm', id.ref, 'auto-wake', context)!;
    if (kind === 'request') h.request('new-request'); if (kind === 'owner') h.owner(false); if (kind === 'completion') h.current(false);
    expect(h.mailbox.ackDelivery(token)).toBe(false); expect(h.mailbox.lookup('pm', id.ref)?.delivery).toBe('pending');
    expect(h.mailbox.lookup('pm', id.ref)?.body?.text).toBe('typed result');
  });
  it('does not pass body content to delivery/completion authority callbacks and snapshots cannot mutate live state', () => {
    const h = fixture(); const id = h.ready(); const token = h.mailbox.tryClaim('pm', id.ref, 'auto-wake', context)!;
    h.mailbox.ackDelivery(token);
    for (const args of h.currentCompletion.mock.calls) expect(args[0]).not.toHaveProperty('body');
    for (const args of h.currentDelivery.mock.calls) expect(args[1]).not.toHaveProperty('body');
    const copy = h.mailbox.lookup('pm', id.ref)!; copy.body!.text = 'changed'; copy.ref.revision = 99;
    expect(h.mailbox.lookup('pm', id.ref)?.body?.text).toBe('typed result');
    expect(h.mailbox.index()[0]).not.toHaveProperty('body'); expect(h.mailbox.index()[0]).not.toHaveProperty('text');
  });
  it('bounds multibyte head/tail to 64 KiB, keeps the full-source digest/location and never calls it complete', () => {
    const h = fixture(); const id = identity(); const text = '起'.repeat(30000) + '🛰️'.repeat(20000) + '終'.repeat(30000);
    expect(h.mailbox.reserve(id)).toBe('reserved'); expect(h.mailbox.settle(id, 'ready', text)).toBe('body-location-required');
    expect(h.mailbox.usage().reservedBytes).toBe(65536);
    expect(h.mailbox.settle(id, 'ready', text, location)).toBe('settled'); const body = h.mailbox.lookup('pm', id.ref)!.body!;
    expect(body.bytes).toBe(Buffer.byteLength(body.text)); expect(body.bytes).toBeLessThanOrEqual(RESULT_MAILBOX_LIMITS.bodyBytes);
    expect(body.text).not.toContain('\ufffd'); expect(body.text).toContain('[truncated;'); expect(body.truncated).toBe(true);
    expect(body.sourceBytes).toBe(Buffer.byteLength(text)); expect(body.location).toEqual(location);
    expect(body.sourceDigest).toBe(createHash('sha256').update(text).digest('hex')); expect(h.mailbox.usage().bodyBytes).toBe(body.bytes);
  });
  it('the exact 64 KiB boundary is UTF-8, not characters; decomposed text is not normalised', () => {
    const h = fixture(); const full = '🛰'.repeat(16384); const id = h.ready(identity('exact'), full);
    expect(h.mailbox.lookup('pm', id.ref)?.body).toMatchObject({ bytes: 65536, truncated: false, text: full });
    const decomposed = '한국어 각'; const jamo = h.ready(identity('jamo'), decomposed);
    expect(h.mailbox.lookup('pm', jamo.ref)?.body?.text).toBe(decomposed);
    expect(h.mailbox.lookup('pm', jamo.ref)?.body?.text).not.toBe(decomposed.normalize('NFC'));
  });
  it('duplicate host events are idempotent; contradictory same-event bodies become sticky conflict even when retained head/tail match', () => {
    const h = fixture(); const id = h.ready(identity(), 'A'.repeat(40000) + 'middle-A' + 'Z'.repeat(40000));
    expect(h.mailbox.settle(id, 'ready', 'A'.repeat(40000) + 'middle-A' + 'Z'.repeat(40000), location)).toBe('duplicate');
    expect(h.mailbox.settle(id, 'ready', 'A'.repeat(40000) + 'middle-B' + 'Z'.repeat(40000), location)).toBe('conflict');
    expect(h.mailbox.lookup('pm', id.ref)?.conflict).toBe(true); expect(h.mailbox.tryClaim('pm', id.ref, 'auto-wake', context)).toBeUndefined();
    expect(h.mailbox.settle(id, 'ready', 'A'.repeat(40000) + 'middle-A' + 'Z'.repeat(40000), location)).toBe('conflict');
  });
  it('refuses stale event/attempt callbacks and never derives failure from final wording', () => {
    const h = fixture(); const id = h.ready(identity(), 'Error: this is only quoted text');
    expect(h.mailbox.lookup('pm', id.ref)?.state).toBe('ready');
    expect(h.mailbox.settle({ ...id, attemptId: 'old-attempt' }, 'failed', 'late')).toBe('stale');
    expect(h.mailbox.lookup('pm', id.ref)?.state).toBe('ready');
    const failure = identity('failed'); expect(h.mailbox.reserve(failure)).toBe('reserved');
    expect(h.mailbox.settle(failure, 'failed', 'All good')).toBe('settled'); expect(h.mailbox.lookup('pm', failure.ref)?.state).toBe('failed');
  });
  it('checks UTF-8 metadata bounds and request/ref ownership, without charging an invalid entry', () => {
    const h = fixture(); expect(h.mailbox.reserve({ ...identity(), coordinatorId: '中'.repeat(500), attemptId: '文'.repeat(500) })).toBe('invalid');
    expect(h.mailbox.reserve({ ...identity(), ref: { handle: 'h', revision: 0 } })).toBe('invalid'); expect(h.mailbox.usage().slots).toBe(0);
    const id = h.ready(); expect(h.mailbox.tryClaim('pm', id.ref, 'auto-wake', { ...context, coordinatorId: 'another-pm' })).toBeUndefined();
    expect(resultMailboxKey('pm', id.ref)).not.toBe(resultMailboxKey('other-pm', id.ref));
  });
  it('scope release is idempotent and the existing ledger, not a second mailbox tombstone store, refuses old-scope reservations', async () => {
    const h = fixture(); const id = h.ready(); h.archive.mockImplementationOnce(async entry => {
      h.current(false); return entry && { coordinatorId: entry.coordinatorId, ref: entry.ref, location, sourceDigest: entry.body!.sourceDigest };
    });
    expect(await h.mailbox.releaseAfterArchive('pm', id.ref, scope)).toBe('released');
    expect(await h.mailbox.releaseAfterArchive('pm', id.ref, scope)).toBe('missing');
    expect(h.mailbox.reserve(id)).toBe('stale'); expect(h.mailbox.usage().slots).toBe(0);
  });
  it('does not release body/quota/claims before the durable archive receipt; late final and new claims cannot reopen a closing scope', async () => {
    const h = fixture(); const id = h.ready(); const token = h.mailbox.tryClaim('pm', id.ref, 'auto-wake', context)!;
    const receipt = deferred<ResultArchiveReceipt | undefined>(); h.archive.mockImplementationOnce(() => receipt.promise);
    const closing = h.mailbox.releaseAfterArchive('pm', id.ref, scope);
    expect(h.mailbox.usage().slots).toBe(1); expect(h.mailbox.lookup('pm', id.ref)?.body).toBeDefined();
    expect(h.mailbox.tryClaim('pm', id.ref, 'collect-ready', context)).toBeUndefined(); expect(h.mailbox.ackDelivery(token)).toBe(false);
    expect(h.mailbox.settle(id, 'ready', 'late replacement')).toBe('stale');
    receipt.resolve({ coordinatorId: 'pm', ref: id.ref, location, sourceDigest: h.mailbox.lookup('pm', id.ref)!.body!.sourceDigest });
    expect(await closing).toBe('released'); expect(h.mailbox.usage().slots).toBe(0); expect(h.mailbox.ackDelivery(token)).toBe(false);
  });
  it.each(['throw', 'missing', 'wrong-digest', 'wrong-ref'] as const)('failed %s archive preserves the only body and active allocation', async failure => {
    const h = fixture(); const id = h.ready();
    if (failure === 'throw') h.archive.mockRejectedValueOnce(new Error('storage unavailable'));
    if (failure === 'missing') h.archive.mockResolvedValueOnce(undefined);
    if (failure === 'wrong-digest') h.archive.mockResolvedValueOnce({ coordinatorId: 'pm', ref: id.ref, location, sourceDigest: 'wrong' });
    if (failure === 'wrong-ref') h.archive.mockResolvedValueOnce({ coordinatorId: 'pm', ref: { handle: 'wrong', revision: 1 }, location, sourceDigest: 'wrong' });
    expect(await h.mailbox.releaseAfterArchive('pm', id.ref, scope)).toBe('storage-error');
    expect(h.mailbox.usage().slots).toBe(1); expect(h.mailbox.lookup('pm', id.ref)?.body?.text).toBe('typed result');
    expect(h.mailbox.tryClaim('pm', id.ref, 'collect-ready', context)).toBeDefined();
  });
});
