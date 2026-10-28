/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Request closeout store (v0.9.94)
 *  The durable copy of the request closeout records, one list per agent the person addressed, in workspace
 *  state. It stores and returns records; it projects nothing and decides nothing about a turn.
 *
 *  A record is replaced only by a larger revision. The same revision with the same content changes nothing; the
 *  same revision with other content is refused and reported, so two writers can never leave a reader with a
 *  choice between copies. A stored value is rebuilt record by record: one damaged record is dropped and its
 *  valid neighbours are kept.
 *--------------------------------------------------------------------------------------------*/
import {
  parseRequestCloseoutRecord,
  sameRequestCloseoutRecord,
  type RequestCloseoutRecordV1,
} from './RequestCloseout';

export const REQUEST_CLOSEOUT_STORE_KEY_PREFIX = 'unode.requestCloseouts.v1.';
/** Records kept per agent. A record whose turn is still in that agent's retained conversation is kept beyond it. */
export const REQUEST_CLOSEOUT_RETAINED_LIMIT = 100;
const DIAGNOSTIC_LIMIT = 300;

/** The part of a workspace-state store this needs. */
export interface RequestCloseoutState {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

export interface RequestCloseoutStoreOptions {
  /** One bounded line for the host's log. Never shown as a fact about a turn. */
  onDiagnostic?: (message: string) => void;
  /** Turn ids the agent's retained conversation still shows. Their records are not evicted. */
  retainedTurnIds?: (rootAgentId: string) => ReadonlySet<string>;
}

export type RequestCloseoutUpsert = 'stored' | 'unchanged' | 'stale' | 'conflict' | 'invalid';

export function requestCloseoutStoreKey(rootAgentId: string): string {
  return `${REQUEST_CLOSEOUT_STORE_KEY_PREFIX}${rootAgentId}`;
}

/** Stored records of one agent, rebuilt one by one. A record of another agent, or a second copy of an id, is not kept. */
export function deserializeRequestCloseouts(value: unknown, rootAgentId: string): RequestCloseoutRecordV1[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, RequestCloseoutRecordV1>();
  for (const raw of value) {
    const parsed = parseRequestCloseoutRecord(raw);
    if (!parsed || parsed.rootAgentId !== rootAgentId) continue;
    const held = byId.get(parsed.recordId);
    if (!held || parsed.revision > held.revision) byId.set(parsed.recordId, parsed);
  }
  return ordered([...byId.values()]);
}

function ordered(records: RequestCloseoutRecordV1[]): RequestCloseoutRecordV1[] {
  return records.sort((left, right) => {
    const difference = Date.parse(left.recordedAt) - Date.parse(right.recordedAt);
    if (difference !== 0) return difference;
    return left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0;
  });
}

export class RequestCloseoutStore {
  private readonly records = new Map<string, Map<string, RequestCloseoutRecordV1>>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly failedKeys = new Set<string>();
  private readonly listeners = new Set<(rootAgentId: string) => void>();

  constructor(
    private readonly state: RequestCloseoutState,
    private readonly options: RequestCloseoutStoreOptions = {},
  ) {}

  onDidChange(listener: (rootAgentId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The agent's records, oldest first. A copy: a caller cannot change what is stored. */
  list(rootAgentId: string): RequestCloseoutRecordV1[] {
    return ordered([...this.load(rootAgentId).values()]).map((entry) => structuredClone(entry));
  }

  /** The agent's record of one exact turn, when one is kept. A copy. Nothing else is read or copied to find it. */
  ofTurn(rootAgentId: string, terminalTurnId: string): RequestCloseoutRecordV1 | undefined {
    for (const held of this.load(rootAgentId).values()) {
      if (held.terminalTurnId === terminalTurnId) return structuredClone(held);
    }
    return undefined;
  }

  /**
   * v0.9.97: the agent's records of one request, oldest first. Copies of those only: a request's file effects revise
   * its records each time they change, and nothing else of the agent's is copied to find them.
   */
  ofRequest(rootAgentId: string, requestId: string): RequestCloseoutRecordV1[] {
    return ordered([...this.load(rootAgentId).values()].filter((held) => held.requestId === requestId)).map((entry) => structuredClone(entry));
  }

  get(rootAgentId: string, recordId: string): RequestCloseoutRecordV1 | undefined {
    const held = this.load(rootAgentId).get(recordId);
    return held ? structuredClone(held) : undefined;
  }

  /**
   * Keep a record. A larger revision replaces the one held. An equal revision is accepted only when it is the same
   * content; a smaller one is stale. A value that is not a record this host could have built is refused.
   */
  upsert(raw: unknown): RequestCloseoutUpsert {
    const incoming = parseRequestCloseoutRecord(raw);
    if (!incoming) return 'invalid';
    const records = this.load(incoming.rootAgentId);
    const held = records.get(incoming.recordId);
    if (held) {
      if (incoming.revision < held.revision) return 'stale';
      if (incoming.revision === held.revision) {
        if (sameRequestCloseoutRecord(held, incoming)) return 'unchanged';
        this.diagnose(`request closeout ${incoming.recordId}: two different records under revision ${incoming.revision}; the one held is kept`);
        return 'conflict';
      }
    }
    records.set(incoming.recordId, incoming);
    this.evict(incoming.rootAgentId, records);
    this.persist(incoming.rootAgentId);
    this.notify(incoming.rootAgentId);
    return 'stored';
  }

  /** Forget an agent's records: its conversation was cleared or the agent was removed. */
  clear(rootAgentId: string): void {
    this.records.set(rootAgentId, new Map());
    this.persist(rootAgentId);
    this.notify(rootAgentId);
  }

  /** Resolves when every write started so far has ended, whichever way. For shutdown and for tests. */
  async settled(): Promise<void> {
    await Promise.all([...this.writes.values()]);
  }

  private load(rootAgentId: string): Map<string, RequestCloseoutRecordV1> {
    const cached = this.records.get(rootAgentId);
    if (cached) return cached;
    const restored = new Map<string, RequestCloseoutRecordV1>();
    for (const entry of this.readStored(rootAgentId)) restored.set(entry.recordId, entry);
    this.records.set(rootAgentId, restored);
    return restored;
  }

  private readStored(rootAgentId: string): RequestCloseoutRecordV1[] {
    try {
      return deserializeRequestCloseouts(this.state.get(requestCloseoutStoreKey(rootAgentId)), rootAgentId);
    } catch {
      return [];
    }
  }

  /** Oldest first, a record whose turn the conversation still shows is passed over. */
  private evict(rootAgentId: string, records: Map<string, RequestCloseoutRecordV1>): void {
    if (records.size <= REQUEST_CLOSEOUT_RETAINED_LIMIT) return;
    let retained: ReadonlySet<string>;
    try { retained = this.options.retainedTurnIds?.(rootAgentId) ?? new Set(); } catch { retained = new Set(); }
    for (const entry of ordered([...records.values()])) {
      if (records.size <= REQUEST_CLOSEOUT_RETAINED_LIMIT) return;
      if (retained.has(entry.terminalTurnId)) continue;
      records.delete(entry.recordId);
    }
  }

  /**
   * One write at a time per agent. The stored value is read again first and merged by revision, so a second
   * window on the same workspace does not lose a record this one never saw. A write that fails leaves the records
   * in memory as they are, and is reported once until a write succeeds again.
   */
  private persist(rootAgentId: string): void {
    const key = requestCloseoutStoreKey(rootAgentId);
    const previous = this.writes.get(key) ?? Promise.resolve();
    const next = previous.then(async () => {
      const records = this.records.get(rootAgentId) ?? new Map<string, RequestCloseoutRecordV1>();
      if (records.size > 0) {
        for (const stored of this.readStored(rootAgentId)) {
          const held = records.get(stored.recordId);
          if (!held || stored.revision > held.revision) records.set(stored.recordId, stored);
        }
        this.evict(rootAgentId, records);
      }
      try {
        await this.state.update(key, records.size > 0 ? ordered([...records.values()]) : undefined);
        this.failedKeys.delete(key);
      } catch (error) {
        if (!this.failedKeys.has(key)) {
          this.failedKeys.add(key);
          this.diagnose(`request closeouts for ${rootAgentId} could not be saved: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
    this.writes.set(key, next);
  }

  private notify(rootAgentId: string): void {
    for (const listener of this.listeners) {
      try { listener(rootAgentId); } catch { /* a listener's failure is not the store's */ }
    }
  }

  private diagnose(message: string): void {
    try { this.options.onDiagnostic?.(message.replace(/\s+/g, ' ').slice(0, DIAGNOSTIC_LIMIT)); } catch { /* logging never fails a write */ }
  }
}
