import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({ workspace: { workspaceFolders: [] } }));
import { HostFileCommits } from '../HostFileCommits';
import { PersistenceManager } from '../../state/PersistenceManager';

const workspace = path.join(path.resolve(path.sep), 'workspace');
const hash = 'a'.repeat(64);
const effect = { agentId: 'pm', key: path.join(workspace, 'deck.pptx'), operation: 'write' as const,
  grade: 'host-verified' as const, sha256: hash, byteLength: 42, requestId: 'request', turnId: 'turn' };

function storage() {
  const values = new Map<string, unknown>();
  const memento = {
    get: <T>(key: string, fallback?: T) => values.has(key) ? structuredClone(values.get(key)) as T : fallback,
    update: async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, structuredClone(value)); },
    keys: () => [...values.keys()],
  };
  return { values, memento, manager: (id: string) => new PersistenceManager({ workspaceState: memento } as never, undefined, () => workspace, id) };
}

describe('host-private latest file authors', () => {
  it('saves/loads through production workspace persistence, retains newer unknown and keeps legacy runs untouched', async () => {
    const disk = storage();
    const first = disk.manager('host-a');
    const ledger = new HostFileCommits(first.loadFileCommitFacts(), facts => first.saveFileCommitFacts(facts));
    ledger.record('workspace', effect, 'model-a');
    expect(ledger.author('workspace', effect.key, hash)).toBeUndefined(); // no durable success yet
    await ledger.flush();
    expect(new HostFileCommits(first.loadFileCommitFacts()).author('workspace', effect.key, hash)).toMatchObject({ reportedModelId: 'model-a', byteLength: 42 });
    ledger.record('workspace', effect); // exact same bytes, latest identity unknown
    await ledger.flush();
    expect(new HostFileCommits(first.loadFileCommitFacts()).author('workspace', effect.key, hash)).toBeUndefined();
    expect(await first.loadRuns()).toEqual([]);
    expect([...disk.values.keys()].sort()).toEqual(['roam.fileCommits.host.host-a', 'roam.fileCommits.merged.v1']);
  });

  it('does not claim persistence after save failure or fall back to the previous same-byte writer', async () => {
    let fail = false;
    const ledger = new HostFileCommits([], async () => { if (fail) throw new Error('disk full'); });
    ledger.record('workspace', effect, 'old-model'); await ledger.flush();
    expect(ledger.author('workspace', effect.key, hash)?.reportedModelId).toBe('old-model');
    fail = true;
    ledger.record('workspace', effect, 'new-model'); await ledger.flush();
    expect(ledger.author('workspace', effect.key, hash)).toBeUndefined();
  });

  it('treats divergent host shards as unknown instead of ordering independent host sequences', async () => {
    const disk = storage();
    const left = disk.manager('host-a'); const right = disk.manager('host-b');
    const a = new HostFileCommits([], facts => left.saveFileCommitFacts(facts));
    const b = new HostFileCommits([], facts => right.saveFileCommitFacts(facts));
    a.record('workspace', effect, 'a'); b.record('workspace', effect, 'b');
    await Promise.all([a.flush(), b.flush()]);
    expect(new HostFileCommits(left.loadFileCommitFacts()).author('workspace', effect.key, hash)).toBeUndefined();
    // Identical copies are one fact, never a conflict.
    expect(new HostFileCommits([...a.snapshot(), ...a.snapshot()]).author('workspace', effect.key, hash)?.reportedModelId).toBe('a');
    expect(new HostFileCommits([...a.snapshot(), null]).author('workspace', effect.key, hash)).toBeUndefined();
  });

  it('invalidates descendants on folder deletion and does not export unknown storage fields', () => {
    const ledger = new HostFileCommits();
    ledger.record('workspace', effect, 'a');
    const restored = new HostFileCommits(ledger.snapshot().map(fact => ({ ...fact, routeVersionKey: 'private-canary' })));
    expect(JSON.stringify(restored.snapshot())).not.toContain('private-canary');
    ledger.record('workspace', { ...effect, key: workspace, operation: 'delete-directory' }, 'a');
    expect(ledger.author('workspace', effect.key, hash)).toBeUndefined();
  });

  it.each(['rewrite', 'delete'])('three sequential editor session IDs: %s stays latest and idle shards are absorbed', async operation => {
    const disk = storage();
    const s1 = disk.manager('session-1');
    const first = new HostFileCommits(s1.loadFileCommitFacts(), facts => s1.saveFileCommitFacts(facts, 0));
    first.record('workspace', effect, 'first-model'); await first.flush();
    const s2 = disk.manager('session-2');
    const second = new HostFileCommits(s2.loadFileCommitFacts(), facts => s2.saveFileCommitFacts(facts, 100000));
    expect(second.author('workspace', effect.key, hash)?.reportedModelId).toBe('first-model');
    second.record('workspace', operation === 'delete' ? { ...effect, key: workspace, operation: 'delete-directory' } : effect, 'second-model');
    await second.flush();
    const s3 = disk.manager('session-3');
    const third = new HostFileCommits(s3.loadFileCommitFacts(), facts => s3.saveFileCommitFacts(facts, 200000));
    expect(third.author('workspace', effect.key, hash)?.reportedModelId).toBe(operation === 'rewrite' ? 'second-model' : undefined);
    third.record('workspace', effect, 'third-model'); await third.flush();
    expect(new HostFileCommits(s3.loadFileCommitFacts()).author('workspace', effect.key, hash)?.reportedModelId).toBe('third-model');
    expect([...disk.values.keys()].sort()).toEqual(['roam.fileCommits.host.session-3', 'roam.fileCommits.merged.v1']);
  });

  it('caps after merging and never restores an evicted old key from an absorbed shard', async () => {
    const disk = storage(); const s1 = disk.manager('session-1'); const s2 = disk.manager('session-2');
    const first = new HostFileCommits([], facts => s1.saveFileCommitFacts(facts, 0));
    first.record('workspace', effect, 'old'); await first.flush();
    const second = new HostFileCommits(s2.loadFileCommitFacts());
    for (let index = 0; index < 4096; index++) second.record('workspace', { ...effect, key: path.join(workspace, String(index)) }, 'new');
    await s2.saveFileCommitFacts(second.snapshot(), 100000);
    const third = new HostFileCommits(s2.loadFileCommitFacts());
    expect(third.snapshot()).toHaveLength(4096);
    expect(third.author('workspace', effect.key, hash)).toBeUndefined();
    const last = third.snapshot().at(-1)!;
    expect(new HostFileCommits(Array.from({ length: 20000 }, () => last)).author('workspace', last.key, hash)?.reportedModelId).toBe('new');
  });

  it('keeps absorbed source shards if the merged write fails or their contents change before cleanup', async () => {
    const disk = storage(); const first = disk.manager('old'); const second = disk.manager('new');
    const ledger = new HostFileCommits(); ledger.record('workspace', effect, 'a');
    await first.saveFileCommitFacts(ledger.snapshot(), 0);
    const update = disk.memento.update;
    disk.memento.update = async (key, value) => { if (key === 'roam.fileCommits.merged.v1') throw new Error('disk full'); await update(key, value); };
    await expect(second.saveFileCommitFacts(ledger.snapshot(), 100000)).rejects.toThrow('disk full');
    expect(disk.values.has('roam.fileCommits.host.old')).toBe(true);
    const changed = { savedAt: 100001, facts: ledger.snapshot().map(fact => ({ ...fact, id: 'new-concurrent-fact', reportedModelId: 'b' })) };
    disk.memento.update = async (key, value) => {
      await update(key, value);
      if (key === 'roam.fileCommits.merged.v1') disk.values.set('roam.fileCommits.host.old', changed);
    };
    await second.saveFileCommitFacts(ledger.snapshot(), 100000);
    expect(disk.values.get('roam.fileCommits.host.old')).toEqual(changed);
    expect(new HostFileCommits(second.loadFileCommitFacts()).author('workspace', effect.key, hash)).toBeUndefined();
  });
});
