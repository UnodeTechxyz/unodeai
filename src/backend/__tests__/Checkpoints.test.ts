import { describe, it, expect } from 'vitest';
import { CheckpointStore } from '../Checkpoints';

const base = { agentId: 'a1', agentName: 'Dev', path: 'src/x.ts' };

describe('CheckpointStore', () => {
  it('records a write and lists it (newest first) with assigned id/ts', () => {
    const s = new CheckpointStore();
    const cp = s.record({ ...base, before: 'old', after: 'new' });
    expect(cp).toMatchObject({ id: 1, path: 'src/x.ts', before: 'old', after: 'new' });
    expect(typeof cp!.ts).toBe('number');
    const cp2 = s.record({ ...base, path: 'src/y.ts', before: null, after: 'created' });
    expect(s.list().map((c) => c.id)).toEqual([2, 1]); // newest first
    expect(cp2!.before).toBeNull(); // new-file checkpoint
  });

  it('skips a no-op edit (before === after)', () => {
    const s = new CheckpointStore();
    expect(s.record({ ...base, before: 'same', after: 'same' })).toBeUndefined();
    expect(s.list()).toHaveLength(0);
  });

  it('marks oversized content non-restorable and drops the blobs', () => {
    const s = new CheckpointStore();
    const huge = 'x'.repeat(200_001);
    const cp = s.record({ ...base, before: huge, after: 'small' });
    expect(cp!.truncated).toBe(true);
    expect(cp!.before).toBeNull();
    expect(s.restorable()).toHaveLength(0);
    expect(s.list()).toHaveLength(1); // still listed (visible), just not restorable
  });

  it('keeps an unprovable native edit visible but excludes it from restore', () => {
    const s = new CheckpointStore();
    const cp = s.record({
      ...base,
      before: null,
      after: 'observed after-state',
      restoreDisabledReason: 'replace-all-ambiguous',
    });
    expect(cp).toMatchObject({
      before: null,
      after: 'observed after-state',
      restoreDisabledReason: 'replace-all-ambiguous',
    });
    expect(s.list()).toHaveLength(1);
    expect(s.restorable()).toEqual([]);
  });

  it('caps entries, dropping the oldest', () => {
    const s = new CheckpointStore(3);
    for (let i = 0; i < 5; i++) {
      s.record({ ...base, before: `b${i}`, after: `a${i}` });
    }
    const ids = s.list().map((c) => c.id);
    expect(ids).toEqual([5, 4, 3]); // oldest (1,2) fell off
  });

  it('round-trips through serialize/restoreFrom and keeps id monotonic', () => {
    const s = new CheckpointStore();
    s.record({ ...base, before: 'a', after: 'b' });
    s.record({ ...base, before: 'b', after: 'c' });
    const blob = s.serialize();

    const s2 = new CheckpointStore();
    s2.restoreFrom(blob);
    expect(s2.list().map((c) => c.id)).toEqual([2, 1]);
    const next = s2.record({ ...base, before: 'c', after: 'd' });
    expect(next!.id).toBe(3); // continues, no id collision
  });

  it('restoreFrom ignores garbage/missing without throwing or wiping state', () => {
    const s = new CheckpointStore();
    s.record({ ...base, before: 'a', after: 'b' });
    s.restoreFrom(undefined);
    s.restoreFrom({ version: 2 as unknown as 1, nextId: 9, items: [] });
    expect(s.list()).toHaveLength(1); // unchanged
  });

  it('get() finds by id; restorable excludes truncated', () => {
    const s = new CheckpointStore();
    const ok = s.record({ ...base, before: 'a', after: 'b' })!;
    s.record({ ...base, before: 'x'.repeat(200_001), after: 'b' });
    expect(s.get(ok.id)?.before).toBe('a');
    expect(s.restorable().map((c) => c.id)).toEqual([ok.id]);
  });
});
