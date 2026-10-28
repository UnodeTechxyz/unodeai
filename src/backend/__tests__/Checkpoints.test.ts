import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  CheckpointStore,
  checkpointEvidence,
  checkpointEvidenceLabel,
  checkpointRestoreDisabledMessage,
  checkpointRestorePlan,
  sha256Text,
  type Checkpoint,
  type CheckpointIndexPeer,
} from '../Checkpoints';

const TARGET = path.resolve('/ws/src/x.ts');
const base = { agentId: 'a1', agentName: 'Dev', path: 'src/x.ts', target: TARGET, operation: 'write' as const };

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

  it('keeps the file a change was recorded for, and what the change did', () => {
    const s = new CheckpointStore();
    const cp = s.record({ ...base, physicalTarget: TARGET, operation: 'delete-file', before: 'gone', after: '' });
    expect(cp).toMatchObject({ target: TARGET, physicalTarget: TARGET, operation: 'delete-file' });
    expect(s.serialize().items[0]).toMatchObject({ target: TARGET, operation: 'delete-file' });
  });

  // USAGE.md "Restoring a file": a record from before v0.9.97 is shown, but never restored against a guessed folder.
  it('lists a record without the file it names, but never offers to restore it', () => {
    const s = new CheckpointStore();
    s.restoreFrom({
      version: 1,
      nextId: 2,
      items: [{ id: 1, agentId: 'a1', agentName: 'Dev', path: 'src/x.ts', before: 'a', after: 'b', ts: 1 }],
    });
    expect(s.list()).toHaveLength(1);
    expect(s.restorable()).toEqual([]);
    expect(checkpointRestoreDisabledMessage(s.list()[0])).toContain('without the folder its path belongs to');
  });

  it('never offers to write the listing of a deleted folder back', () => {
    const s = new CheckpointStore();
    const cp = s.record({ ...base, operation: 'delete-directory', before: 'build/\n  out.js', after: '' })!;
    expect(cp.before).toBeNull();
    expect(cp.restoreDisabledReason).toBe('deleted-directory');
    expect(s.restorable()).toEqual([]);
  });

  it('does not offer a restore twice', () => {
    const s = new CheckpointStore();
    const cp = s.record({ ...base, before: 'a', after: 'b' })!;
    s.markRestored([cp.id], sha256Text('a'), 5);
    expect(s.get(cp.id)?.restored).toEqual({ at: 5, sha256: sha256Text('a') });
    expect(s.restorable()).toEqual([]);
    expect(checkpointRestoreDisabledMessage(cp)).toBe('This change was already restored.');
  });
});

describe('checkpointRestorePlan', () => {
  const at = (over: Partial<Checkpoint>): Checkpoint => ({
    id: 1, agentId: 'a1', agentName: 'Dev', path: 'src/x.ts', target: TARGET, operation: 'write',
    before: 'v0', after: 'v1', ts: 1, ...over,
  });

  it('requires the after-state of the newest record of the file, and undoes every later record of it', () => {
    const all = [
      at({ id: 1, before: 'v0', after: 'v1' }),
      at({ id: 2, path: 'other.ts', target: path.resolve('/ws/other.ts'), before: 'o0', after: 'o1' }),
      at({ id: 3, agentId: 'a2', agentName: 'QA', before: 'v1', after: 'v2' }),
    ];
    const planned = checkpointRestorePlan(all, all[0]);
    expect(planned).toMatchObject({ ok: true, plan: { target: TARGET, expected: { kind: 'bytes', sha256: sha256Text('v2') } } });
    expect(planned.ok && planned.plan.undoes.map((c) => c.id)).toEqual([1, 3]);
  });

  it('keeps two files with the same display path apart', () => {
    const all = [
      at({ id: 1, before: 'mine', after: 'mine after' }),
      at({ id: 2, target: path.resolve('/ws/other/src/x.ts'), before: 'theirs', after: 'theirs after' }),
    ];
    const planned = checkpointRestorePlan(all, all[0]);
    expect(planned).toMatchObject({ ok: true, plan: { expected: { kind: 'bytes', sha256: sha256Text('mine after') } } });
    expect(planned.ok && planned.plan.undoes.map((c) => c.id)).toEqual([1]);
  });

  it('requires the file to be gone after a recorded delete', () => {
    const all = [at({ id: 1 }), at({ id: 2, before: 'v1', after: '', operation: 'delete-file' })];
    expect(checkpointRestorePlan(all, all[1])).toMatchObject({ ok: true, plan: { expected: { kind: 'absent' } } });
  });

  it('requires what the last restore left, once one was made', () => {
    const all = [at({ id: 1 }), at({ id: 2, before: 'v1', after: 'v2', restored: { at: 3, sha256: sha256Text('v1') } })];
    const planned = checkpointRestorePlan(all, all[0]);
    expect(planned).toMatchObject({ ok: true, plan: { expected: { kind: 'bytes', sha256: sha256Text('v1') } } });
    expect(planned.ok && planned.plan.undoes.map((c) => c.id)).toEqual([1]);
  });

  it('cannot tell the state after a newer record whose content was not kept', () => {
    const all = [at({ id: 1 }), at({ id: 2, truncated: true, before: null, after: '' })];
    expect(checkpointRestorePlan(all, all[0])).toMatchObject({ ok: true, plan: { expected: { kind: 'unknown' } } });
  });

  it('refuses a record that cannot be restored, with its reason', () => {
    expect(checkpointRestorePlan([], at({ restoreDisabledReason: 'overwrote-existing', before: null })))
      .toEqual({ ok: false, reason: 'The write replaced an existing file, whose prior contents were not available.' });
  });
});

/** A raw-byte side of the unified index: entries with times, some of them in use. */
function peer(entries: Array<{ ts: number; pinned?: boolean }>): CheckpointIndexPeer & { entries: typeof entries } {
  return {
    entries,
    count: () => entries.length,
    evictableTimes: () => entries.filter((entry) => !entry.pinned).map((entry) => entry.ts).sort((a, b) => a - b),
    evictOldest() {
      const oldest = [...entries].sort((a, b) => a.ts - b.ts).find((entry) => !entry.pinned);
      if (oldest) entries.splice(entries.indexOf(oldest), 1);
    },
  };
}

describe('unified restore-point index (text and raw-byte records together)', () => {
  it('drops the oldest entry of either kind to keep both under one limit', () => {
    const s = new CheckpointStore(3);
    const raw = peer([{ ts: -10 }, { ts: Number.MAX_SAFE_INTEGER }]);
    s.attachPeer(raw);
    s.record({ ...base, before: 'a', after: 'b' });
    expect(raw.entries.map((entry) => entry.ts)).toEqual([-10, Number.MAX_SAFE_INTEGER]);
    s.record({ ...base, before: 'b', after: 'c' });
    expect(raw.entries.map((entry) => entry.ts)).toEqual([Number.MAX_SAFE_INTEGER]);
    expect(s.count() + raw.count()).toBe(3);
    s.record({ ...base, before: 'c', after: 'd' });
    expect(s.list().map((c) => c.before)).toEqual(['c', 'b']);
    expect(s.count() + raw.count()).toBe(3);
  });

  it('never drops an entry the other side has in use', () => {
    const s = new CheckpointStore(2);
    const raw = peer([{ ts: -10, pinned: true }, { ts: -5, pinned: true }]);
    s.attachPeer(raw);
    s.record({ ...base, before: 'a', after: 'b' });
    expect(raw.count()).toBe(2);
    // The new record stays: the write it records has already happened.
    expect(s.count()).toBe(1);
  });
});

// v0.9.97 (CHANGELOG [Unreleased], USAGE "Restoring a file"): a change the host kept the exact bytes before names
// that raw-byte restore point; a restore puts back those bytes, and a text record stays a text restore point.
describe('records that name a raw-byte restore point', () => {
  const rawRef = (id: string, after: string | null) => ({ id, afterSha256: after === null ? null : sha256Text(after) });

  it('counts such a change once, as its raw entry, in the shared limit', () => {
    const s = new CheckpointStore(3);
    s.record({ ...base, before: 'a', after: 'b', raw: rawRef('r1', 'b') });
    s.record({ ...base, before: 'b', after: 'c' });
    expect(s.list()).toHaveLength(2);
    expect(s.count()).toBe(1);
    expect(s.evictableTimes()).toHaveLength(1);
    expect(s.rawIds()).toEqual(['r1']);
  });

  it('leaves such a record to the raw store when room is made, and drops it only when its bytes are gone', () => {
    const s = new CheckpointStore(2);
    const raw = peer([{ ts: Number.MAX_SAFE_INTEGER }]);
    s.attachPeer(raw);
    s.record({ ...base, before: 'a', after: 'b', raw: rawRef('r1', 'b') });
    s.record({ ...base, before: 'b', after: 'c' });
    s.record({ ...base, before: 'c', after: 'd' });
    // The text record went for room; the one naming raw bytes is not the text side's to drop.
    expect(s.list().map((c) => [c.before, c.raw?.id])).toEqual([['c', undefined], ['a', 'r1']]);
    expect(s.dropRaw(['other'])).toBe(false);
    expect(s.dropRaw(['r1'])).toBe(true);
    expect(s.list().map((c) => c.before)).toEqual(['c']);
  });

  it('drops only a text restore point when the raw side asks it for room', () => {
    const s = new CheckpointStore();
    s.record({ ...base, before: 'a', after: 'b', raw: rawRef('r1', 'b') });
    s.record({ ...base, before: 'b', after: 'c' });
    s.evictOldest();
    expect(s.list().map((c) => c.raw?.id)).toEqual(['r1']);
  });

  it('keeps a change restorable when its text was too large to keep, and requires what the host read back', () => {
    const s = new CheckpointStore();
    const big = 'x'.repeat(250_000);
    const after = 'y'.repeat(250_000);
    const withRaw = s.record({ ...base, before: big, after, raw: rawRef('r1', after) })!;
    const textOnly = s.record({ ...base, target: path.resolve('/ws/other.ts'), before: big, after })!;
    expect(withRaw).toMatchObject({ truncated: true, before: null });
    expect(checkpointRestoreDisabledMessage(withRaw)).toBeUndefined();
    expect(checkpointRestoreDisabledMessage(textOnly)).toBe('The file content was too large to retain.');
    expect(checkpointRestorePlan(s.list(), withRaw)).toMatchObject({ ok: true, plan: { expected: { kind: 'bytes', sha256: sha256Text(after) } } });
  });

  it('requires the file to be gone after a raw-backed delete', () => {
    const s = new CheckpointStore();
    const removed = s.record({ ...base, operation: 'delete-file', before: 'v1', after: '', raw: rawRef('r1', null) })!;
    expect(checkpointRestorePlan(s.list(), removed)).toMatchObject({ ok: true, plan: { expected: { kind: 'absent' } } });
  });

  it('records a raw-backed change whose decoded text did not change, since its bytes did', () => {
    const s = new CheckpointStore();
    expect(s.record({ ...base, before: 'caf\ufffd', after: 'caf\ufffd', raw: rawRef('r1', 'caf\ufffd') })).toBeDefined();
    expect(s.record({ ...base, before: 'same', after: 'same' })).toBeUndefined();
  });

  it('labels what a restore puts back', () => {
    const s = new CheckpointStore();
    const withRaw = s.record({ ...base, before: 'a', after: 'b', raw: rawRef('r1', 'b') })!;
    const textOnly = s.record({ ...base, before: 'b', after: 'c' })!;
    expect([checkpointEvidence(withRaw), checkpointEvidenceLabel(withRaw)]).toEqual(['raw-bytes', 'exact bytes kept before the edit']);
    expect([checkpointEvidence(textOnly), checkpointEvidenceLabel(textOnly)]).toEqual(['text', 'text copy kept by UnodeAi']);
  });
});

// v0.9.97 P4: a saved attachment's record keeps a description or the bytes as UTF-8 for its diff, and the SHA-256 the
// host read back. USAGE "Saving a file you attached": restoring the save of a new file removes exactly that file.
describe('records whose text is not their bytes', () => {
  it('keep the after-state the host read back, and a restore requires exactly those bytes', () => {
    const s = new CheckpointStore();
    const saved = s.record({ ...base, before: null, after: '(PNG image, 70 bytes)', afterSha256: 'a'.repeat(64) })!;
    expect(saved.afterSha256).toBe('a'.repeat(64));
    expect(checkpointRestorePlan(s.list(), saved)).toMatchObject({ ok: true, plan: { expected: { kind: 'bytes', sha256: 'a'.repeat(64) } } });
    // A later text write of the same file is the newest record, and its own text is what the file must hold.
    s.record({ ...base, before: 'x', after: 'y' });
    expect(checkpointRestorePlan(s.list(), saved)).toMatchObject({ ok: true, plan: { expected: { kind: 'bytes', sha256: sha256Text('y') } } });
    // It survives the round-trip through workspace storage.
    const restored = new CheckpointStore();
    restored.restoreFrom(JSON.parse(JSON.stringify(s.serialize())));
    expect(restored.get(saved.id)?.afterSha256).toBe('a'.repeat(64));
  });
});
