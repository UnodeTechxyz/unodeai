import { describe, expect, it } from 'vitest';
import { limitedCoverageAreas, type RequestCloseoutRecordV1 } from '../RequestCloseout';
import {
  REQUEST_CLOSEOUT_RETAINED_LIMIT,
  RequestCloseoutStore,
  deserializeRequestCloseouts,
  requestCloseoutStoreKey,
  type RequestCloseoutState,
} from '../RequestCloseoutStore';

function record(turn: number, overrides: Partial<RequestCloseoutRecordV1> = {}, agent = 'pm'): RequestCloseoutRecordV1 {
  const built = {
    schemaVersion: 1 as const,
    recordId: `request-closeout:req-${turn}:turn-${turn}` as const,
    requestId: `req-${turn}`,
    rootAgentId: agent,
    originTurnId: `turn-${turn}`,
    terminalTurnId: `turn-${turn}`,
    recordedAt: new Date(Date.UTC(2026, 9, 8, 1, 0, turn % 60, 0) + Math.floor(turn / 60) * 60_000).toISOString(),
    revision: 1,
    terminal: { kind: 'answered' as const },
    usageUnitIds: [],
    observations: {
      changes: { coverage: 'complete' as const, files: [], omitted: 0, droppedPaths: 0 },
      checks: { coverage: 'complete' as const, passed: 0, failed: 0, refused: 0 },
      approvals: { coverage: 'complete' as const, decisions: [] },
      context: { coverage: 'complete' as const, sources: 0, estimatedTextTokens: 0 },
      routes: { coverage: 'unavailable' as const, agents: [], omitted: 0 },
      reasoning: { visibleItems: 0 },
    },
    coverage: { events: 'complete' as const, limited: [] as RequestCloseoutRecordV1['coverage']['limited'] },
    ...overrides,
  };
  built.coverage = { events: built.coverage.events, limited: limitedCoverageAreas(built) };
  return built;
}

class MemoryState implements RequestCloseoutState {
  readonly values = new Map<string, unknown>();
  updates = 0;
  failNext = 0;
  get(key: string): unknown {
    return structuredClone(this.values.get(key));
  }
  async update(key: string, value: unknown): Promise<void> {
    this.updates += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('disk full');
    }
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, structuredClone(value));
  }
}

describe('RequestCloseoutStore', () => {
  it('keeps a record and gives it back after a restart', async () => {
    const state = new MemoryState();
    const store = new RequestCloseoutStore(state);
    expect(store.upsert(record(1))).toBe('stored');
    await store.settled();
    expect(new RequestCloseoutStore(state).list('pm')).toEqual([record(1)]);
    expect(state.values.has(requestCloseoutStoreKey('pm'))).toBe(true);
  });

  it('replaces a record only by a larger revision', async () => {
    const store = new RequestCloseoutStore(new MemoryState());
    store.upsert(record(1));
    const revised = record(1, { revision: 2, terminal: { kind: 'stopped' } });
    expect(store.upsert(revised)).toBe('stored');
    expect(store.upsert(record(1))).toBe('stale');
    expect(store.get('pm', revised.recordId)).toEqual(revised);
    expect(store.list('pm')).toHaveLength(1);
  });

  it('changes nothing for the same record again, and refuses other content under the same revision', async () => {
    const diagnostics: string[] = [];
    const state = new MemoryState();
    const store = new RequestCloseoutStore(state, { onDiagnostic: (message) => diagnostics.push(message) });
    store.upsert(record(1));
    await store.settled();
    const writes = state.updates;
    expect(store.upsert(record(1))).toBe('unchanged');
    expect(store.upsert(record(1, { terminal: { kind: 'stopped' } }))).toBe('conflict');
    await store.settled();
    expect(state.updates).toBe(writes);
    expect(store.get('pm', record(1).recordId)?.terminal.kind).toBe('answered');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('two different records under revision 1');
  });

  it('refuses a value that is not a record', () => {
    const store = new RequestCloseoutStore(new MemoryState());
    expect(store.upsert({ ...record(1), recordId: 'request-closeout:other:turn-1' })).toBe('invalid');
    expect(store.upsert('not a record')).toBe('invalid');
    expect(store.list('pm')).toEqual([]);
  });

  it('drops a damaged stored record and keeps its valid neighbours', () => {
    const stored = [record(1), { ...record(2), revision: 'two' }, 'junk', record(3), record(4, {}, 'someone-else')];
    expect(deserializeRequestCloseouts(stored, 'pm').map((entry) => entry.recordId)).toEqual([
      'request-closeout:req-1:turn-1', 'request-closeout:req-3:turn-3',
    ]);
    expect(deserializeRequestCloseouts('not a list', 'pm')).toEqual([]);
  });

  it('keeps the larger revision when storage holds two copies of one id', () => {
    const stored = [record(1), record(1, { revision: 3, terminal: { kind: 'stopped' } }), record(1, { revision: 2 })];
    expect(deserializeRequestCloseouts(stored, 'pm')).toEqual([record(1, { revision: 3, terminal: { kind: 'stopped' } })]);
  });

  it('gives back copies, so a caller cannot change what is stored', () => {
    const store = new RequestCloseoutStore(new MemoryState());
    store.upsert(record(1));
    store.list('pm')[0].terminal.kind = 'failed';
    expect(store.list('pm')[0].terminal.kind).toBe('answered');
  });

  it('finds the record of one exact turn, as a copy, and nothing for a turn or an agent it does not hold', () => {
    const store = new RequestCloseoutStore(new MemoryState());
    store.upsert(record(1));
    store.upsert(record(2));
    store.upsert(record(3, {}, 'dev'));
    expect(store.ofTurn('pm', 'turn-2')).toEqual(record(2));
    expect(store.ofTurn('dev', 'turn-3')).toEqual(record(3, {}, 'dev'));
    // Another agent's turn, and a turn nobody had.
    expect(store.ofTurn('pm', 'turn-3')).toBeUndefined();
    expect(store.ofTurn('pm', 'turn-9')).toBeUndefined();
    expect(store.ofTurn('nobody', 'turn-1')).toBeUndefined();
    // A copy: a caller cannot change what is stored.
    store.ofTurn('pm', 'turn-2')!.terminal.kind = 'failed';
    expect(store.ofTurn('pm', 'turn-2')!.terminal.kind).toBe('answered');
    // The record as it was last revised.
    store.upsert(record(2, { revision: 2 }));
    expect(store.ofTurn('pm', 'turn-2')!.revision).toBe(2);
  });

  // v0.9.97: a request's file effects revise the records of that request, and only those (review resolution §2).
  it('gives the records of one request, oldest first, as copies, and none of another request or agent', () => {
    const store = new RequestCloseoutStore(new MemoryState());
    const laterTurn = (turn: number) => record(turn, {
      requestId: 'req-1',
      recordId: `request-closeout:req-1:turn-${turn}`,
    });
    store.upsert(laterTurn(3));
    store.upsert(record(2));
    store.upsert(laterTurn(1));
    store.upsert(record(9, {}, 'dev'));
    expect(store.ofRequest('pm', 'req-1').map((held) => held.terminalTurnId)).toEqual(['turn-1', 'turn-3']);
    expect(store.ofRequest('pm', 'req-9')).toEqual([]);
    expect(store.ofRequest('dev', 'req-1')).toEqual([]);
    const [copy] = store.ofRequest('pm', 'req-1');
    copy.revision = 99;
    expect(store.ofRequest('pm', 'req-1')[0].revision).toBe(1);
  });

  it('evicts the oldest record beyond the limit, but not one whose turn the conversation still shows', async () => {
    const state = new MemoryState();
    const store = new RequestCloseoutStore(state, { retainedTurnIds: () => new Set(['turn-0']) });
    for (let turn = 0; turn <= REQUEST_CLOSEOUT_RETAINED_LIMIT + 1; turn += 1) store.upsert(record(turn));
    const kept = store.list('pm').map((entry) => entry.terminalTurnId);
    expect(kept).toHaveLength(REQUEST_CLOSEOUT_RETAINED_LIMIT);
    expect(kept).toContain('turn-0');
    expect(kept).not.toContain('turn-1');
    expect(kept).not.toContain('turn-2');
    expect(kept).toContain('turn-3');
    await store.settled();
    expect((state.values.get(requestCloseoutStoreKey('pm')) as unknown[]).length).toBe(REQUEST_CLOSEOUT_RETAINED_LIMIT);
  });

  it('keeps the records in memory when a write fails, and says so once', async () => {
    const diagnostics: string[] = [];
    const state = new MemoryState();
    state.failNext = 2;
    const store = new RequestCloseoutStore(state, { onDiagnostic: (message) => diagnostics.push(message) });
    store.upsert(record(1));
    store.upsert(record(2));
    await store.settled();
    expect(store.list('pm')).toHaveLength(2);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('could not be saved');
    store.upsert(record(3));
    await store.settled();
    expect((state.values.get(requestCloseoutStoreKey('pm')) as unknown[]).length).toBe(3);
  });

  it('writes one at a time, in order', async () => {
    const order: number[] = [];
    const state: RequestCloseoutState = {
      get: () => undefined,
      update: async (_key, value) => {
        const size = (value as unknown[]).length;
        await new Promise((resolve) => setTimeout(resolve, size === 1 ? 20 : 0));
        order.push(size);
      },
    };
    const store = new RequestCloseoutStore(state);
    store.upsert(record(1));
    store.upsert(record(2));
    store.upsert(record(3));
    await store.settled();
    expect(order).toEqual([3, 3, 3]);
  });

  it('merges a record another window stored before it writes', async () => {
    const state = new MemoryState();
    const first = new RequestCloseoutStore(state);
    first.upsert(record(1));
    await first.settled();
    const second = new RequestCloseoutStore(state);
    second.list('pm');
    first.upsert(record(2));
    await first.settled();
    second.upsert(record(3));
    await second.settled();
    expect(deserializeRequestCloseouts(state.values.get(requestCloseoutStoreKey('pm')), 'pm').map((entry) => entry.terminalTurnId))
      .toEqual(['turn-1', 'turn-2', 'turn-3']);
  });

  it('tells its listeners which agent changed, and forgets an agent on clear', async () => {
    const state = new MemoryState();
    const store = new RequestCloseoutStore(state);
    const changed: string[] = [];
    const off = store.onDidChange((agent) => changed.push(agent));
    store.upsert(record(1));
    store.upsert(record(1));
    store.clear('pm');
    off();
    store.upsert(record(2));
    await store.settled();
    expect(changed).toEqual(['pm', 'pm']);
    expect(store.list('pm')).toHaveLength(1);
  });

  describe('the verification configuration a record keeps', () => {
    // v0.9.95: a record may say whether a verification command was configured when its turn closed. Records
    // stored by an earlier version do not, and they are still records.
    const configured = (turn: number, verificationConfigured: unknown): RequestCloseoutRecordV1 => {
      const base = record(turn);
      return {
        ...base,
        observations: { ...base.observations, checks: { ...base.observations.checks, verificationConfigured } },
      } as RequestCloseoutRecordV1;
    };

    it('stores the fact with its record and gives it back after a restart', async () => {
      const state = new MemoryState();
      const store = new RequestCloseoutStore(state);
      expect(store.upsert(configured(1, true))).toBe('stored');
      expect(store.upsert(configured(2, false))).toBe('stored');
      await store.settled();
      const restored = new RequestCloseoutStore(state);
      expect(restored.ofTurn('pm', 'turn-1')!.observations.checks)
        .toEqual({ coverage: 'complete', passed: 0, failed: 0, refused: 0, verificationConfigured: true });
      expect(restored.ofTurn('pm', 'turn-2')!.observations.checks)
        .toEqual({ coverage: 'complete', passed: 0, failed: 0, refused: 0, verificationConfigured: false });
    });

    it('still loads what an earlier version stored, and adds no fact to it', async () => {
      const state = new MemoryState();
      // As 0.9.94 wrote them: the member does not exist.
      state.values.set(requestCloseoutStoreKey('pm'), [record(1), record(2)]);
      const store = new RequestCloseoutStore(state);
      expect(store.list('pm')).toEqual([record(1), record(2)]);
      for (const held of store.list('pm')) expect(held.observations.checks).not.toHaveProperty('verificationConfigured');
      // A record of this version is kept beside them, and writing it does not rewrite theirs.
      expect(store.upsert(configured(3, true))).toBe('stored');
      await store.settled();
      const reread = new RequestCloseoutStore(state).list('pm');
      expect(reread.map((held) => held.observations.checks.verificationConfigured)).toEqual([undefined, undefined, true]);
      expect(reread.slice(0, 2)).toEqual([record(1), record(2)]);
    });

    it('refuses a record whose fact is not a yes or a no, and drops a stored one without its neighbours', () => {
      const store = new RequestCloseoutStore(new MemoryState());
      for (const value of ['true', 1, 0, null, { configured: true }]) {
        expect(store.upsert(configured(1, value))).toBe('invalid');
      }
      expect(store.list('pm')).toEqual([]);
      const stored = [configured(1, true), configured(2, 'yes'), configured(3, false), record(4)];
      expect(deserializeRequestCloseouts(stored, 'pm').map((entry) => entry.terminalTurnId)).toEqual(['turn-1', 'turn-3', 'turn-4']);
    });

    it('holds the fact as part of the record: another answer under the same revision is other content', () => {
      const store = new RequestCloseoutStore(new MemoryState());
      store.upsert(configured(1, true));
      expect(store.upsert(configured(1, true))).toBe('unchanged');
      expect(store.upsert(configured(1, false))).toBe('conflict');
      expect(store.upsert(record(1))).toBe('conflict');
      expect(store.get('pm', record(1).recordId)!.observations.checks.verificationConfigured).toBe(true);
    });
  });
});
