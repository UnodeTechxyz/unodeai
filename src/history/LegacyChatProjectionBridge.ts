/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the older per-member chat key and the canonical history (v0.9.110 H0, design §3.2)
 *
 *  0.9.110 keeps writing the 50-message `roam.chat.<agentId>` key so that 0.9.109, after a downgrade or in a
 *  window that was not reloaded, still shows the recent conversation. The key is a projection, never a second
 *  source; but what 0.9.109 writes into it must reach the history.
 *
 *  For each key this remembers what 0.9.110 last wrote: the digest of the whole value and one digest per message.
 *  At start, on window focus and before every write, the current key is compared with that. A message found by its
 *  history id is known; the rest are matched by content digest and occurrence in the snapshot; what is left is new.
 *
 *  What is new is kept, before anything writes over the key, in this bridge's own state as pending: the observed
 *  messages themselves, with the ids they will have in the history. Only a durable import removes them from there,
 *  so a write that follows at once, or a failed import, never loses what was observed. A key that 0.9.110 wrote once
 *  and that now holds none of it was replaced or cleared by 0.9.109.
 *
 *  Messages that left the projection (cleared, replaced, trimmed) are remembered by digest. A stale 0.9.109 copy
 *  written back later is not imported again and is not shown again in the chat; a new message 0.9.109 wrote is.
 *  VS Code's workspace state has no cross-process compare-and-set: simultaneous writes of the same key by two
 *  versions are not made atomic here, and a message 0.9.109 trimmed before 0.9.110 ever saw it is gone.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { chatHistoryKey, deserializeChatHistory, serializeChatHistory, type ChatHistoryMessage } from '../views/chatHistory';
import type { DurableAppendResult } from './HistoryStore';
import type { HistoryEventBody, HistoryMessageEntry } from './HistoryRecords';

export const BRIDGE_STATE_KEY_PREFIX = 'roam.history.bridge.';
/** Digests of messages that left the projection, remembered so a stale copy cannot restore them. */
export const BRIDGE_SEEN_LIMIT = 2_000;

export interface BridgeStatePort {
  get(key: string): unknown;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface BridgeStorePort {
  refresh(): Promise<void>;
  append(body: HistoryEventBody, options?: { eventId?: string }): Promise<DurableAppendResult>;
  hasMessage(messageId: string): boolean;
  migrationMarker(agentId: string, projectionKey: string): string | undefined;
  currentGeneration(agentId: string): string | undefined;
  /** v0.9.110 H1: a message with this content was deleted from the history; an older copy of it is not imported. */
  isTombstonedDigest?(digest: string, occurrence?: number): boolean;
}

interface PendingMessage {
  messageId: string;
  digest: string;
  message: ChatHistoryMessage;
  /** v0.9.110 H1: for an id generated from content, which copy of that content in the key it was. */
  occurrence?: number;
}

interface BridgeStateV1 {
  v: 1;
  /** The key's whole value as last accepted: written by this window, or reconciled from another version's write. */
  digest: string;
  /** The messages of the current view, by digest: what this window shows from that value. */
  entries: string[];
  seen: string[];
  /**
   * Observed in the key, not yet durable in the history. Never dropped for room: an observation leaves only once its
   * import is durable, because the key it came from may already be written over.
   */
  pending: PendingMessage[];
  /**
   * Messages in the accepted value that are not part of the current view: a stale copy of what left it. The chat keeps
   * them hidden for as long as the key holds them.
   */
  hidden: string[];
}

export type BridgeOutcome = 'migrated' | 'unchanged' | 'imported' | 'replaced' | 'unavailable' | 'failed';

export function bridgeStateKey(agentId: string): string {
  return `${BRIDGE_STATE_KEY_PREFIX}${agentId}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The whole stored value, as stored. */
export function projectionDigest(raw: unknown): string {
  return sha256(JSON.stringify(raw ?? null));
}

/** One message's content, without the history id 0.9.109 does not keep. */
export function legacyMessageDigest(message: ChatHistoryMessage): string {
  const { messageId: _messageId, ...rest } = message;
  return sha256(JSON.stringify(serializeChatHistory([rest], 1)[0] ?? null));
}

const DIGEST = /^[a-f0-9]{64}$/;

function parseState(value: unknown): BridgeStateV1 | undefined {
  const candidate = value as Partial<BridgeStateV1> | undefined;
  if (!candidate || candidate.v !== 1 || typeof candidate.digest !== 'string' || !Array.isArray(candidate.entries)
    || !Array.isArray(candidate.seen)) return undefined;
  const strings = (list: unknown[]) => list.filter((item): item is string => typeof item === 'string' && DIGEST.test(item));
  const pending: PendingMessage[] = [];
  for (const item of Array.isArray(candidate.pending) ? candidate.pending : []) {
    const entry = item as Partial<PendingMessage> | undefined;
    const [message] = entry?.message ? deserializeChatHistory([entry.message], 1) : [];
    if (entry && typeof entry.messageId === 'string' && typeof entry.digest === 'string' && DIGEST.test(entry.digest) && message) {
      pending.push({ messageId: entry.messageId, digest: entry.digest, message: { ...message, messageId: entry.messageId },
        ...(Number.isSafeInteger(entry.occurrence) && entry.occurrence! >= 0 ? { occurrence: entry.occurrence } : {}) });
    }
  }
  return { v: 1, digest: candidate.digest, entries: strings(candidate.entries), seen: strings(candidate.seen).slice(-BRIDGE_SEEN_LIMIT), pending,
    hidden: strings(Array.isArray(candidate.hidden) ? candidate.hidden : []) };
}

function counts(list: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of list) map.set(item, (map.get(item) ?? 0) + 1);
  return map;
}

/** Remove one occurrence of `key` from a multiset kept as counts; false when there is none. */
function take(map: Map<string, number>, key: string): boolean {
  const held = map.get(key) ?? 0;
  if (held <= 0) return false;
  map.set(key, held - 1);
  return true;
}

/** The id a message without its own has in the history: derived from its content and place, so it is stable. */
function legacyId(agentId: string, key: string, digest: string, occurrence: number): string {
  return `legacy-${sha256(`${agentId}\0${key}\0${digest}\0${occurrence}`).slice(0, 40)}`;
}

export interface LegacyChatProjectionBridgeDeps {
  state: BridgeStatePort;
  /** The store, once it is open; undefined while it opens or when it could not. */
  store: () => Promise<BridgeStorePort | undefined>;
  newGeneration: () => string;
  /**
   * Runs a reconciliation in the order of the history's other writes, so an import of what was in the key lands
   * before the changes this window makes after it. Runs it at once when not given.
   */
  schedule?: (work: () => Promise<unknown>) => void;
  log?: (line: string) => void;
}

export class LegacyChatProjectionBridge {
  /** The key's value when this window first looked at it, before any write of its own. */
  private readonly original = new Map<string, unknown>();
  private readonly running = new Map<string, Promise<BridgeOutcome>>();
  /** v0.9.110 H1: the history once a reconcile has opened it, so a write can tell a new message by its id at once. */
  private opened: BridgeStorePort | undefined;

  constructor(private readonly deps: LegacyChatProjectionBridgeDeps) {}

  /**
   * The first look at a member's key in this window: keep its value so a write that follows at once cannot hide
   * what was there, and reconcile it with the history.
   */
  observe(agentId: string): void {
    const key = chatHistoryKey(agentId);
    if (!this.original.has(agentId)) this.original.set(agentId, structuredCloneJson(this.deps.state.get(key)));
    this.scheduleReconcile(agentId);
  }

  /**
   * What the chat shows from the key at its first read: without the messages that left this projection earlier and
   * came back only in a stale copy. New messages another version wrote stay.
   */
  visibleProjection(agentId: string, messages: ChatHistoryMessage[]): ChatHistoryMessage[] {
    const state = parseState(this.deps.state.get(bridgeStateKey(agentId)));
    if (!state) return messages;
    if (projectionDigest(this.deps.state.get(chatHistoryKey(agentId))) === state.digest) {
      // The accepted value: what it holds of a stale copy stays hidden.
      if (state.hidden.length === 0) return messages;
      const hidden = counts(state.hidden);
      return messages.filter((message) => !take(hidden, legacyMessageDigest(message)));
    }
    return splitStale(messages, state).visible;
  }

  private scheduleReconcile(agentId: string): void {
    if (this.deps.schedule) this.deps.schedule(() => this.reconcile(agentId));
    else void this.reconcile(agentId);
  }

  /** Reconcile one member's key with the history. Calls for the same member run one after another. */
  reconcile(agentId: string): Promise<BridgeOutcome> {
    const previous = this.running.get(agentId) ?? Promise.resolve<BridgeOutcome>('unchanged');
    const next = previous.catch(() => 'failed' as const).then(() => this.reconcileNow(agentId));
    this.running.set(agentId, next);
    void next.finally(() => { if (this.running.get(agentId) === next) this.running.delete(agentId); });
    return next;
  }

  private async reconcileNow(agentId: string): Promise<BridgeOutcome> {
    const store = await this.deps.store();
    if (!store) return 'unavailable';
    this.opened = store;
    const key = chatHistoryKey(agentId);
    try {
      await store.refresh();
      let migratedNow = false;
      if (!store.migrationMarker(agentId, key)) {
        const migrated = await this.migrate(agentId, key, store);
        if (migrated !== 'migrated') return migrated;
        migratedNow = true;
      }
      const pending = await this.importPending(agentId, key, store);
      if (pending === 'failed') return 'failed';
      const raw = this.deps.state.get(key);
      const digest = projectionDigest(raw);
      const state = parseState(this.deps.state.get(bridgeStateKey(agentId)));
      const outcome = state?.digest === digest ? (pending === 'imported' ? 'imported' : 'unchanged')
        : await this.importDifference(agentId, key, raw, digest, state, store);
      return migratedNow && outcome === 'unchanged' ? 'migrated' : outcome;
    } catch (error) {
      this.deps.log?.(`Task history: the chat of ${agentId} was not reconciled (${(error as Error).message}).`);
      return 'failed';
    }
  }

  /** Copy → check → durable marker. Until the marker exists the key stays the source, and this runs again. */
  private async migrate(agentId: string, key: string, store: BridgeStorePort): Promise<BridgeOutcome> {
    const raw = this.original.has(agentId) ? this.original.get(agentId) : this.deps.state.get(key);
    const digest = projectionDigest(raw);
    const messages = deserializeChatHistory(raw);
    const entries = this.entriesFor(agentId, key, messages, store);
    let importedEventId: string | undefined;
    if (entries.length > 0) {
      importedEventId = eventIdFor('migration', agentId, key, digest);
      const result = await store.append({ kind: 'legacy-import', agentId, projectionKey: key, observedDigest: digest, reason: 'migration',
        viewGeneration: store.currentGeneration(agentId) ?? this.deps.newGeneration(), messages: entries }, { eventId: importedEventId });
      if (!appended(result)) return 'failed';
      await store.refresh();
      if (entries.some((entry) => !store.hasMessage(entry.messageId))) return 'failed';
    }
    const marker = await store.append({ kind: 'migration-marker', agentId, projectionKey: key, observedDigest: digest,
      ...(importedEventId ? { importedEventId } : {}) }, { eventId: eventIdFor('marker', agentId, key, digest) });
    if (!appended(marker)) return 'failed';
    const current = this.deps.state.get(key);
    const held = parseState(this.deps.state.get(bridgeStateKey(agentId)));
    // The window may have written meanwhile; what it wrote is recorded by its own events, and its baseline stands.
    if (!held || projectionDigest(current) === digest) {
      await this.deps.state.update(bridgeStateKey(agentId), this.stateFor(deserializeChatHistory(current), projectionDigest(current), held));
    }
    this.original.delete(agentId);
    return 'migrated';
  }

  /** Observed messages waiting since a write: imported once; they leave the waiting list only when durable. */
  private async importPending(agentId: string, key: string, store: BridgeStorePort): Promise<'none' | 'imported' | 'failed'> {
    const state = parseState(this.deps.state.get(bridgeStateKey(agentId)));
    if (!state || state.pending.length === 0) return 'none';
    const entries: HistoryMessageEntry[] = state.pending
      // A message's own id decides first; only a copy without one is matched by its content to a deleted message.
      .filter((entry) => !store.hasMessage(entry.messageId)
        && !(entry.messageId.startsWith('legacy-') && store.isTombstonedDigest?.(entry.digest, entry.occurrence ?? 0)))
      .map((entry) => ({ messageId: entry.messageId, message: entry.message }));
    if (entries.length > 0) {
      const observed = sha256(entries.map((entry) => entry.messageId).join('\0'));
      const result = await store.append({ kind: 'legacy-import', agentId, projectionKey: key, observedDigest: observed, reason: 'divergence',
        viewGeneration: store.currentGeneration(agentId) ?? this.deps.newGeneration(), messages: entries },
      { eventId: eventIdFor('pending', agentId, key, observed) });
      if (!appended(result)) return 'failed';
      await store.refresh();
      if (entries.some((entry) => !store.hasMessage(entry.messageId))) return 'failed';
    }
    const done = new Set(state.pending.map((entry) => entry.messageId));
    const now = parseState(this.deps.state.get(bridgeStateKey(agentId))) ?? state;
    await this.deps.state.update(bridgeStateKey(agentId), { ...now, pending: now.pending.filter((entry) => !done.has(entry.messageId)) });
    return entries.length > 0 ? 'imported' : 'none';
  }

  private async importDifference(agentId: string, key: string, raw: unknown, digest: string, state: BridgeStateV1 | undefined,
    store: BridgeStorePort): Promise<BridgeOutcome> {
    const messages = deserializeChatHistory(raw);
    const known = counts(state?.entries ?? []);
    const hadOutput = (state?.entries.length ?? 0) > 0;
    let matchedOutput = 0;
    const fresh: ChatHistoryMessage[] = [];
    const seen = counts(state?.seen ?? []);
    for (const message of messages) {
      const messageDigest = legacyMessageDigest(message);
      if (message.messageId && store.hasMessage(message.messageId)) { if (take(known, messageDigest)) matchedOutput++; continue; }
      // v0.9.110 H1: identity first. A message with its own id the history has never held is new, even when its
      // content is the same as a message the last view held (or a deleted one); only an id-less copy is matched by content.
      if (message.messageId) { fresh.push(message); continue; }
      if (take(known, messageDigest)) { matchedOutput++; continue; }
      if (take(seen, messageDigest)) continue;
      fresh.push(message);
    }
    const entries = this.entriesFor(agentId, key, messages, store).filter((entry) => fresh.includes(entry.source)).map(({ messageId, message }) => ({ messageId, message }));
    let outcome: BridgeOutcome = 'unchanged';
    if (hadOutput && matchedOutput === 0) {
      // None of what 0.9.110 wrote is there: the view was cleared or replaced. The earlier history stays readable.
      const result = await store.append({ kind: 'view-replaced', agentId, viewGeneration: this.deps.newGeneration(), reason: 'legacy-replaced',
        messages: entries }, { eventId: eventIdFor('replaced', agentId, key, digest) });
      if (!appended(result)) return 'failed';
      outcome = 'replaced';
    } else if (entries.length > 0) {
      const result = await store.append({ kind: 'legacy-import', agentId, projectionKey: key, observedDigest: digest, reason: 'divergence',
        viewGeneration: store.currentGeneration(agentId) ?? this.deps.newGeneration(), messages: entries },
      { eventId: eventIdFor('divergence', agentId, key, digest) });
      if (!appended(result)) return 'failed';
      outcome = 'imported';
    }
    const now = parseState(this.deps.state.get(bridgeStateKey(agentId))) ?? state;
    // The accepted value's stale messages are not taken in as part of the view: they stay hidden, and remembered.
    const split = now ? splitStale(messages, now) : { visible: messages, hidden: [] as string[] };
    await this.deps.state.update(bridgeStateKey(agentId), { ...this.stateFor(split.visible, digest, now), hidden: split.hidden });
    return outcome;
  }

  /**
   * Before this window writes the key (an append, a patch, Clear, Archive, Import, a removal): what another version
   * added since this window's last write. It is kept in this bridge's state as pending before the write, and its
   * durable import is scheduled in the history's order. The chat keeps the additions in the view it writes from.
   */
  beforeWrite(agentId: string): ChatHistoryMessage[] {
    const key = chatHistoryKey(agentId);
    const state = parseState(this.deps.state.get(bridgeStateKey(agentId)));
    if (!state) {
      // The first look is this write: keep what was there; the migration imports it.
      if (!this.original.has(agentId)) {
        this.original.set(agentId, structuredCloneJson(this.deps.state.get(key)));
        this.scheduleReconcile(agentId);
      }
      return [];
    }
    const raw = this.deps.state.get(key);
    if (projectionDigest(raw) === state.digest) return [];
    const known = counts(state.entries);
    const seen = counts(state.seen);
    const waiting = new Set(state.pending.map((entry) => entry.messageId));
    const occurrences = new Map<string, number>();
    const additions: PendingMessage[] = [];
    for (const message of deserializeChatHistory(raw)) {
      const digest = legacyMessageDigest(message);
      const occurrence = occurrences.get(digest) ?? 0;
      occurrences.set(digest, occurrence + 1);
      // v0.9.110 H1: identity first, as in the import. A message with its own id the history has never held is kept
      // before the write, even when its content matches one the view held or one that was deleted.
      const isNew = !!message.messageId && !!this.opened && !this.opened.hasMessage(message.messageId);
      if (!isNew && (take(known, digest) || take(seen, digest))) continue;
      const messageId = message.messageId ?? legacyId(agentId, key, digest, occurrence);
      if (waiting.has(messageId)) continue;
      additions.push({ messageId, digest, message: { ...message, messageId }, ...(message.messageId ? {} : { occurrence }) });
    }
    if (additions.length > 0) {
      const pending = [...state.pending, ...additions];
      void Promise.resolve(this.deps.state.update(bridgeStateKey(agentId), { ...state, pending })).catch(() => undefined);
      this.scheduleReconcile(agentId);
    }
    return additions.map((entry) => entry.message);
  }

  /** v0.9.110 H1 (Delete all): observations still waiting for their import are dropped with the history. */
  forgetPending(agentId: string): void {
    const state = parseState(this.deps.state.get(bridgeStateKey(agentId)));
    if (!state || state.pending.length === 0) return;
    void Promise.resolve(this.deps.state.update(bridgeStateKey(agentId), { ...state, pending: [] })).catch(() => undefined);
  }

  /** After this window wrote the key: remember what it wrote; what left the projection is remembered as seen. */
  written(agentId: string, value: readonly ChatHistoryMessage[] | undefined): void {
    const state = parseState(this.deps.state.get(bridgeStateKey(agentId)));
    void Promise.resolve(this.deps.state.update(bridgeStateKey(agentId), this.stateFor(value ? [...value] : [], projectionDigest(value), state)))
      .catch(() => undefined);
  }

  /** The new baseline; observed messages still waiting for their import stay waiting. */
  private stateFor(messages: readonly ChatHistoryMessage[], digest: string, previous: BridgeStateV1 | undefined): BridgeStateV1 {
    const entries = messages.map(legacyMessageDigest);
    const remaining = counts(entries);
    const left = (previous?.entries ?? []).filter((entry) => !take(remaining, entry));
    return { v: 1, digest, entries, seen: [...(previous?.seen ?? []), ...left].slice(-BRIDGE_SEEN_LIMIT), pending: previous?.pending ?? [], hidden: [] };
  }

  /** History ids: the message's own when it has one the history lacks, otherwise one derived from its content and place. */
  private entriesFor(agentId: string, key: string, messages: readonly ChatHistoryMessage[], store: BridgeStorePort):
    Array<HistoryMessageEntry & { source: ChatHistoryMessage }> {
    const occurrences = new Map<string, number>();
    const entries: Array<HistoryMessageEntry & { source: ChatHistoryMessage }> = [];
    const ids = new Set<string>();
    for (const message of messages) {
      const digest = legacyMessageDigest(message);
      const occurrence = occurrences.get(digest) ?? 0;
      occurrences.set(digest, occurrence + 1);
      if (message.messageId && store.hasMessage(message.messageId)) continue;
      // Deleted from the history: a copy found in the key without its id does not bring it back. A message that carries
      // its own id is judged by that id (above), so a new message is never taken for a deleted one with the same text.
      if (!message.messageId && store.isTombstonedDigest?.(digest, occurrence)) continue;
      const messageId = message.messageId && !ids.has(message.messageId) ? message.messageId : legacyId(agentId, key, digest, occurrence);
      if (store.hasMessage(messageId) || ids.has(messageId)) continue;
      ids.add(messageId);
      entries.push({ messageId, message: { ...message, messageId }, source: message });
    }
    return entries;
  }
}

/**
 * A key's messages, split into what the current view shows and the digests of a stale copy of what left it: a message
 * that matches the last view's entries stays; one that matches only what left the view is stale; anything else is new.
 */
function splitStale(messages: readonly ChatHistoryMessage[], state: BridgeStateV1): { visible: ChatHistoryMessage[]; hidden: string[] } {
  const known = counts(state.entries);
  const seen = counts(state.seen);
  const visible: ChatHistoryMessage[] = [];
  const hidden: string[] = [];
  for (const message of messages) {
    const digest = legacyMessageDigest(message);
    if (take(known, digest)) { visible.push(message); continue; }
    if (take(seen, digest)) { hidden.push(digest); continue; }
    visible.push(message);
  }
  return { visible, hidden };
}

function appended(result: DurableAppendResult): boolean {
  return result.status === 'durable' || result.status === 'duplicate';
}

/** The same observation always gets the same event id, so importing it twice records it once. */
function eventIdFor(kind: string, agentId: string, key: string, digest: string): string {
  return `lg-${kind}-${sha256(`${agentId}\0${key}\0${digest}`).slice(0, 40)}`;
}

function structuredCloneJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
