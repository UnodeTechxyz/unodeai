import { describe, expect, it } from 'vitest';
import {
  MAX_MEMORY_ATTESTATIONS,
  MEMORY_ATTESTATION_STATE_KEY,
  MemoryAttestationStore,
  workspaceScopeDigest,
} from '../MemoryAttestationStore';
import { memoryRowDigest } from '../SharedMemory';

class FakeMemento {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

describe('MemoryAttestationStore', () => {
  it('stores only bounded exact-row digests with a fixed local actor marker', async () => {
    const state = new FakeMemento();
    const now = new Date('2026-09-08T12:00:00.000Z');
    const store = new MemoryAttestationStore(state, '/workspace', () => now);
    const digest = memoryRowDigest('exact row');

    await expect(store.attest(digest)).resolves.toBe(true);
    expect(store.attestedDigests()).toEqual(new Set([digest]));
    expect(state.values.get(MEMORY_ATTESTATION_STATE_KEY)).toEqual({
      version: 1,
      workspaceDigest: workspaceScopeDigest('/workspace'),
      source: '.unode/memory/notes.md',
      entries: [{ digest, attestedAt: now.toISOString(), actor: 'local-user' }],
    });
    expect(JSON.stringify(state.values.get(MEMORY_ATTESTATION_STATE_KEY))).not.toContain('exact row');
  });

  it('fails closed for corruption, unknown versions, invalid rows, or another workspace', () => {
    const invalidStates: unknown[] = [
      { version: 2, workspaceDigest: workspaceScopeDigest('/workspace'), source: '.unode/memory/notes.md', entries: [] },
      { version: 1, workspaceDigest: workspaceScopeDigest('/other'), source: '.unode/memory/notes.md', entries: [] },
      { version: 1, workspaceDigest: workspaceScopeDigest('/workspace'), source: 'other.md', entries: [] },
      {
        version: 1,
        workspaceDigest: workspaceScopeDigest('/workspace'),
        source: '.unode/memory/notes.md',
        entries: [{ digest: 'not-a-digest', attestedAt: 'today', actor: 'local-user' }],
      },
      {
        version: 1,
        workspaceDigest: workspaceScopeDigest('/workspace'),
        source: '.unode/memory/notes.md',
        entries: [],
        noteProse: 'must never be accepted into this schema',
      },
    ];

    for (const value of invalidStates) {
      const state = new FakeMemento();
      state.values.set(MEMORY_ATTESTATION_STATE_KEY, value);
      expect(new MemoryAttestationStore(state, '/workspace').attestedDigests()).toEqual(new Set());
    }
  });

  it('updates timestamps without duplicates, revokes, and prunes absent rows', async () => {
    const state = new FakeMemento();
    let now = new Date('2026-09-08T12:00:00.000Z');
    const store = new MemoryAttestationStore(state, '/workspace', () => now);
    const first = memoryRowDigest('first');
    const second = memoryRowDigest('second');
    await store.attest(first);
    now = new Date('2026-09-08T13:00:00.000Z');
    await store.attest(first);
    await store.attest(second);

    const registry = state.values.get(MEMORY_ATTESTATION_STATE_KEY) as { entries: Array<{ digest: string; attestedAt: string }> };
    expect(registry.entries).toHaveLength(2);
    expect(registry.entries[0]).toMatchObject({ digest: first, attestedAt: now.toISOString() });

    await store.prune(new Set([second]));
    expect(store.attestedDigests()).toEqual(new Set([second]));
    await expect(store.revoke(second)).resolves.toBe(true);
    expect(store.attestedDigests()).toEqual(new Set());
    await expect(store.revoke(second)).resolves.toBe(false);
  });

  it('bounds retained attestations and rejects malformed digest inputs', async () => {
    const state = new FakeMemento();
    const store = new MemoryAttestationStore(state, '/workspace');
    await expect(store.attest('bad')).resolves.toBe(false);

    const digests = Array.from({ length: MAX_MEMORY_ATTESTATIONS + 3 }, (_, index) => memoryRowDigest(`row-${index}`));
    for (const digest of digests) await store.attest(digest);
    const retained = store.attestedDigests();
    expect(retained.size).toBe(MAX_MEMORY_ATTESTATIONS);
    expect(retained.has(digests[0])).toBe(false);
    expect(retained.has(digests.at(-1)!)).toBe(true);
  });
});
