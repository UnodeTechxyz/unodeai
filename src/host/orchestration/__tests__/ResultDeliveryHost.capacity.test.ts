import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({ workspace: { workspaceFolders: [] } }));
// v0.9.105 S8: the store's capacity cases, at 16 slots instead of the product's 256. They fill the store, and go past it,
// through the same real host, body files and PersistenceManager; the capacity logic does not depend on the number, and
// 256 and 300 real files took 16 and 18 s alone and over 120 s in the complete suite on a busy Windows disk.
vi.mock('../../../state/DelegationResultMailbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../state/DelegationResultMailbox')>();
  return { ...actual, RESULT_MAILBOX_LIMITS: Object.freeze({ ...actual.RESULT_MAILBOX_LIMITS, slots: 16 }) };
});
import { DelegationResultBodyStore } from '../../../state/DelegationResultBodyStore';
import { RESULT_MAILBOX_LIMITS } from '../../../state/DelegationResultMailbox';
import { cleanupResultDeliveryCases, setup } from './resultDeliveryHostFixture';

afterEach(cleanupResultDeliveryCases);

describe('result store capacity through the real host (v0.9.105 S8: 16 slots)', () => {
  it('runs with the reduced capacity, and the product keeps 256', async () => {
    expect(RESULT_MAILBOX_LIMITS.slots).toBe(16);
    const actual = await vi.importActual<typeof import('../../../state/DelegationResultMailbox')>('../../../state/DelegationResultMailbox');
    expect(actual.RESULT_MAILBOX_LIMITS.slots).toBe(256);
  });

  it('reopens a full store of cleanup-pending files, reclaims them, and actually stores the next result', async () => {
    const h = await setup();
    const busy = vi.spyOn(DelegationResultBodyStore.prototype, 'reclaimArchived').mockRejectedValue(new Error('busy'));
    try {
      for (let i = 0; i < RESULT_MAILBOX_LIMITS.slots; i++) {
        const handle = `old-${i}`; h.dispatch(handle); await h.settle(handle);
        await h.host().prepare('pm', handle); h.host().delivered('pm', handle, 'collect-ready'); await h.host().drain();
        h.ledger().recordDisposition({ handle, disposition: 'accepted', recordedAt: new Date().toISOString() });
        h.host().archiveDecided('pm', handle); await h.host().drain();
      }
      expect(h.persistence.archivedResultBodies()).toHaveLength(RESULT_MAILBOX_LIMITS.slots);
    } finally { busy.mockRestore(); }
    await h.reload(); expect(h.persistence.archivedResultBodies()).toHaveLength(0); h.notice.mockClear();
    h.dispatch('after-reclaim'); await h.settle('after-reclaim');
    expect(h.persistence.loadResultMailboxIndex()).toHaveLength(1);
    expect(h.notice).not.toHaveBeenCalled();
    await h.reload(); expect(h.host().recover('pm')).toEqual([expect.objectContaining({ handle: 'after-reclaim', text: 'worker answer' })]);
  }, 60_000);

  it('reclaims more decided results than the store holds, in one process, without storageOwner or a retained journal copy', async () => {
    const h = await setup();
    for (let i = 0; i < RESULT_MAILBOX_LIMITS.slots + RESULT_MAILBOX_LIMITS.slots / 4; i++) {
      const handle = `full-${i}`; h.dispatch(handle); await h.settle(handle);
      await h.host().prepare('pm', handle); h.host().delivered('pm', handle, 'collect-ready'); await h.host().drain();
      h.ledger().recordDisposition({ handle, disposition: 'accepted', recordedAt: new Date().toISOString() });
      h.host().archiveDecided('pm', handle); await h.host().drain();
      expect(h.persistence.archivedResultBodies()).toHaveLength(0);
      expect(h.notice).not.toHaveBeenCalled();
    }
    expect(h.persistence.loadResultMailboxIndex()).toEqual([]);
    await h.reload(); expect(h.persistence.archivedResultBodies()).toHaveLength(0);
    h.dispatch('after-full'); await h.settle('after-full'); expect(h.host().recover('pm')[0].handle).toBe('after-full');
  }, 60_000);
});
