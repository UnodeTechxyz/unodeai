import { pmLiveRunningHandles, pmLiveStrip, type PmAttemptActivity, type PmLiveFacts, type PmLiveStrip, type PmTaskExchanges } from '../session/PmLiveStrip';
import type { NeedSnapshot } from './AccessTable';

/** A workspace-state store, as VS Code's Memento offers it. */
export interface PmReplyMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export const PM_REPLIED_AT_KEY = 'unode.pmRepliedAt';
/** The moment this store was first used: before it, no reply was recorded, so no earlier result is counted as owed. */
const FIRST_USE = '*';

/**
 * v0.9.102 (the PM live strip): when each PM last ended a turn with a final reply to the person, kept across reloads.
 * A PM with no recorded reply reads the store's first use, so results from before this feature are never shown as owed.
 */
export function pmReplyStore(memento: PmReplyMemento, now: () => string = () => new Date().toISOString()): {
  get(coordinatorId: string): string | undefined;
  record(coordinatorId: string, at: string): void;
} {
  const read = (): Record<string, string> => {
    const value = memento.get<unknown>(PM_REPLIED_AT_KEY);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Number.isFinite(Date.parse(entry[1]))));
  };
  let map = read();
  if (!map[FIRST_USE]) {
    map = { ...map, [FIRST_USE]: now() };
    void Promise.resolve(memento.update(PM_REPLIED_AT_KEY, map)).catch(() => undefined);
  }
  return {
    get: (coordinatorId) => map[coordinatorId] ?? map[FIRST_USE],
    record: (coordinatorId, at) => {
      const before = Date.parse(map[coordinatorId] ?? '');
      if (Number.isFinite(before) && before >= Date.parse(at)) return;
      map = { ...map, [coordinatorId]: at };
      void Promise.resolve(memento.update(PM_REPLIED_AT_KEY, map)).catch(() => undefined);
    },
  };
}

/** How long the strip waits before it is read again while it shows something: a safety net for a missed event. */
export const PM_LIVE_REFRESH_MS = 15_000;

/**
 * v0.9.102 (the PM live strip): publishes every PM's strip. `schedule` is called for each event that can change one; a
 * burst is read once, after the change that started it. While any strip shows something, it is read again every
 * PM_LIVE_REFRESH_MS, so a change no event reported is still shown. A failure to read one PM leaves the others.
 */
export function pmLivePublisher(ports: {
  coordinatorIds: () => readonly string[];
  facts: (coordinatorId: string) => Omit<PmLiveFacts, 'waitingForAccess'> | undefined;
  waitingForAccess: (coordinatorId: string) => PmLiveFacts['waitingForAccess'];
  /**
   * v0.9.103 (slice 3 §4.1): the live turn of a task's current attempt (SessionManager.liveAttemptActivity), read for each
   * task the strip lists as running and for nothing else. Undefined, or a failed read: unknown.
   */
  activity?: (handle: string) => PmAttemptActivity | undefined;
  /**
   * v0.9.103 (slice 3 §3, §4.2): the exchanges of a task's current attempt, read for the same handles. Undefined, or a
   * failed read: none known.
   */
  exchanges?: (handle: string) => PmTaskExchanges | undefined;
  publish: (strips: ReadonlyMap<string, PmLiveStrip>) => void;
}): { schedule: () => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refresh: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const run = () => {
    timer = undefined;
    if (disposed) return;
    const strips = new Map<string, PmLiveStrip>();
    let ids: readonly string[] = [];
    try { ids = ports.coordinatorIds(); } catch { ids = []; }
    for (const id of ids) {
      try {
        const facts = ports.facts(id);
        if (!facts) continue;
        const activity = new Map<string, PmAttemptActivity>();
        const exchanges = new Map<string, PmTaskExchanges>();
        for (const handle of ports.activity || ports.exchanges ? pmLiveRunningHandles(facts) : []) {
          let read: PmAttemptActivity | undefined;
          try { read = ports.activity?.(handle); } catch { read = undefined; }
          if (read) activity.set(handle, read);
          let asked: PmTaskExchanges | undefined;
          try { asked = ports.exchanges?.(handle); } catch { asked = undefined; }
          if (asked) exchanges.set(handle, asked);
        }
        const strip = pmLiveStrip({ ...facts, waitingForAccess: ports.waitingForAccess(id), ...(activity.size ? { activity } : {}),
          ...(exchanges.size ? { exchanges } : {}) });
        if (strip) strips.set(id, strip);
      } catch { /* This PM's strip is left out; the next read tries again. */ }
    }
    try { ports.publish(strips); } catch { /* The page keeps what it showed. */ }
    if (refresh) clearTimeout(refresh);
    refresh = strips.size ? setTimeout(() => { refresh = undefined; schedule(); }, PM_LIVE_REFRESH_MS) : undefined;
  };
  const schedule = () => {
    if (timer || disposed) return;
    timer = setTimeout(run, 0);
  };
  return {
    schedule,
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (refresh) clearTimeout(refresh);
    },
  };
}

/** v0.9.103 (slice 3): a task's exchange facts, with the seam's one question asked of SessionManager.awaitsExchange. */
function exchangesOf(
  sessionManager: { taskExchangeFacts?(handle: string): Omit<PmTaskExchanges, 'awaitsExchange'> | undefined; awaitsExchange?(handle: string): boolean },
  handle: string,
): PmTaskExchanges | undefined {
  const facts = sessionManager.taskExchangeFacts?.(handle);
  if (!facts) return undefined;
  return { owed: facts.owed, waiting: facts.waiting, exchangeCount: facts.exchangeCount, awaitsExchange: sessionManager.awaitsExchange?.(handle) === true };
}

/** The session events after which a PM's strip may say something else: a turn starts or ends, Stop, an agent comes or goes. */
export const PM_LIVE_SESSION_EVENTS = ['session.created', 'session.status', 'session.turnEnded', 'session.stopped', 'session.removed'] as const;

/**
 * v0.9.102 (the PM live strip): src/extension.ts's one connection of the strip. Each PM's strip is read from the session
 * manager's live facts and the access table's waiting needs, and published again when the task records, a session, the
 * access table change (a receipt change schedules it where it is published). `dispose` ends every subscription.
 */
export function connectPmLive(ports: {
  sessionManager: {
    coordinatorIds(): string[];
    coordinatorLiveFacts(coordinatorId: string): Omit<PmLiveFacts, 'waitingForAccess'> | undefined;
    /** v0.9.103 (slice 3 §4.1): the live turn of a task's current attempt; the silent-teammate line reads it. */
    liveAttemptActivity?(handle: string): PmAttemptActivity | undefined;
    /** v0.9.103 (slice 2 → slice 3 §3, §4.2): the exchange facts of a task's current attempt, and whether it awaits one. */
    taskExchangeFacts?(handle: string): Omit<PmTaskExchanges, 'awaitsExchange'> | undefined;
    awaitsExchange?(handle: string): boolean;
    on(event: typeof PM_LIVE_SESSION_EVENTS[number], listener: () => void): void;
    off(event: typeof PM_LIVE_SESSION_EVENTS[number], listener: () => void): void;
  };
  accessTable: { waitingNeedsOf(agentId: string): NeedSnapshot[]; onChange(listener: () => void): () => void };
  runLedger: { onDidChange(listener: () => void): () => void };
  publish: (strips: ReadonlyMap<string, PmLiveStrip>) => void;
}): { schedule: () => void; dispose: () => void } {
  const publisher = pmLivePublisher({
    coordinatorIds: () => ports.sessionManager.coordinatorIds(),
    facts: (coordinatorId) => ports.sessionManager.coordinatorLiveFacts(coordinatorId),
    waitingForAccess: (coordinatorId) => ports.accessTable.waitingNeedsOf(coordinatorId)
      .map((need) => ({ label: need.label, path: need.path, access: need.needed })),
    ...(ports.sessionManager.liveAttemptActivity
      ? { activity: (handle: string) => ports.sessionManager.liveAttemptActivity!(handle) } : {}),
    ...(ports.sessionManager.taskExchangeFacts ? { exchanges: (handle: string) => exchangesOf(ports.sessionManager, handle) } : {}),
    publish: ports.publish,
  });
  const schedule = () => publisher.schedule();
  const offLedger = ports.runLedger.onDidChange(schedule);
  const offTable = ports.accessTable.onChange(schedule);
  for (const event of PM_LIVE_SESSION_EVENTS) ports.sessionManager.on(event, schedule);
  schedule();
  return {
    schedule,
    dispose: () => {
      offLedger();
      offTable();
      for (const event of PM_LIVE_SESSION_EVENTS) ports.sessionManager.off(event, schedule);
      publisher.dispose();
    },
  };
}
