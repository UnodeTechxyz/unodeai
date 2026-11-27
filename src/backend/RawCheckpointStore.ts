/*---------------------------------------------------------------------------------------------
 *  UnodeAi - RawCheckpointStore
 *  The exact bytes of a file, kept before the host overwrites it, so a restore can put back what was there in any
 *  encoding, binary included. The text records of Checkpoints.ts hold decoded text; they stay what they are, and
 *  neither kind is ever presented as the other.
 *
 *  Everything lives in one directory per workspace, which the host takes from its extension storage (never from
 *  workspaceState, which holds no payload):
 *
 *    index.json               versioned, bounded metadata: one entry per restore point, no file content
 *    payloads/<id>.bin        the bytes of one restore point
 *    staging/<id>.<nonce>.tmp a payload being written; the index never names one
 *
 *  A capture writes the payload to staging, flushes and verifies it, renames it into payloads/, then commits the index
 *  (temporary file, flush, rename). Only after that may the caller overwrite the file, so every restore point a write
 *  relies on is complete on disk first. Opening the store reconciles what a crash left: it removes staging files and
 *  payloads the index does not name, and entries whose payload is gone. It never touches a workspace file and never
 *  replays a write.
 *
 *  Limits: 32 MiB per payload held in memory, 256 MiB per workspace, 30 days, and together with the text records at most
 *  200 entries (CheckpointIndexPeer). v0.9.99: a larger file is copied on disk as a stream, bounded only by the room of
 *  the workspace. An entry in use is pinned and never dropped. When room cannot be made without dropping a pinned entry
 *  or exceeding a limit, the capture is refused before anything is removed; the caller says the change has no restore
 *  point.
 *
 *  Whoever keeps text records that refer to a raw entry hears through `onRemoved` when one leaves the store (dropped
 *  for room, expired, its payload gone, or removed), so no record outlives the bytes it points at.
 *
 *  v0.9.110 (raw-v2): with `coordination`, every window of the workspace shares the directory safely. Every change of
 *  the index, and every payload written for it, runs under one cross-window lease (history/GenerationLease.ts) and
 *  starts by reading the index again, so no window writes over another's entries. Pins are written into the index
 *  with the id of the host that holds them: another window's eviction or expiry never drops a pinned entry, and only
 *  the pins of a host proven gone are dropped. Since staging and payload writes happen only under the lease, what a
 *  reconciliation finds unnamed was left by a holder that crashed. Without `coordination` (raw-v1, read only by
 *  0.9.110, and tests) one extension host per directory is assumed, as before. On Windows a directory cannot be
 *  flushed, so the durability of a rename across a power loss rests on the filesystem's own journal.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'crypto';
import { constants as fsConstants } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { MAX_CHECKPOINT_ENTRIES, type CheckpointIndexPeer } from './Checkpoints';
import type { GenerationLease } from '../history/GenerationLease';

export const RAW_CHECKPOINT_LIMITS = {
  maxPayloadBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: MAX_CHECKPOINT_ENTRIES,
};
export type RawCheckpointLimits = typeof RAW_CHECKPOINT_LIMITS;

/** A file's state as a restore point knows it: its size and SHA-256, or that it did not exist. */
export type RawFileState = { exists: true; size: number; sha256: string } | { exists: false };

export interface RawCheckpointEntry {
  readonly id: string;
  readonly createdAt: number;
  readonly agentId: string;
  readonly requestId?: string;
  /** The path as the tool reported it, for display. */
  readonly path: string;
  /** The absolute file, as the writing tool resolved it. A restore names this file. */
  readonly target: string;
  /** The file before the overwrite. Its bytes are the payload. */
  readonly before: RawFileState;
  /** What the overwrite left, once the caller has verified it. Absent while that is unknown. */
  readonly after?: RawFileState;
  /** v0.9.110 (raw-v2): who holds the entry, as `<hostInstanceId>:<pin id>`; a pinned entry is never dropped. */
  readonly pins?: readonly string[];
}

/** v0.9.110: how windows sharing one raw-v2 directory take turns, and which hosts are proven gone. */
export interface RawStoreCoordination {
  lease: GenerationLease;
  hostInstanceId: string;
  /** How long a change waits for another window's turn before it is refused (never a model or task timeout). */
  waitMs?: number;
  /** The hosts among `hostInstanceIds` proven gone; unknown is never gone. */
  hostsGone(hostInstanceIds: readonly string[]): Promise<ReadonlySet<string>>;
}

/** The store's lease is held by another window longer than this change may wait. */
export class RawStoreBusyError extends Error {
  constructor() {
    super('another UnodeAi window is using this workspace\'s restore points; try again when it has finished.');
  }
}

export const RAW_STORE_WAIT_MS = 30_000;

export interface RawCheckpointPin {
  readonly id: string;
  /** Idempotent. */
  release(): void;
}

/**
 * Why a capture was refused, for the caller to act on without reading the sentence: the file is over the per-payload
 * limit; there is no room without dropping an entry in use; the store's directory cannot be used; a payload or the
 * index could not be written; the request names no absolute file.
 */
export type RawCheckpointRefusalCode = 'too-large' | 'no-room' | 'unavailable' | 'storage' | 'invalid';

/**
 * v0.9.99: a restore point copied from the file on disk instead of from memory, for a file too large to read whole.
 * It is kept only when the copy has exactly the size and SHA-256 the caller observed.
 */
export interface RawFileCopySource {
  copyFrom: string;
  size: number;
  sha256: string;
}

function isCopySource(value: Buffer | RawFileCopySource | null): value is RawFileCopySource {
  return value !== null && !Buffer.isBuffer(value);
}

export type RawCheckpointCapture =
  | { status: 'captured'; entry: RawCheckpointEntry; pin: RawCheckpointPin }
  | { status: 'refused'; code: RawCheckpointRefusalCode; reason: string };

export type RawCheckpointRead =
  | { status: 'read'; bytes: Buffer }
  | { status: 'absent' }
  | { status: 'unavailable'; reason: string };

export interface RawCheckpointReconciliation {
  /** Staging files a crash left, removed. */
  removedStaging: number;
  /** Payloads the index did not name, removed. */
  removedOrphans: number;
  /** Entries whose payload was gone, dropped. */
  droppedMissing: number;
  /** Entries past the age limit, dropped. */
  expired: number;
  /** Set when the directory cannot be used: then nothing in it was changed, and every capture is refused. */
  unavailable?: string;
}

export interface RawCheckpointStoreOptions {
  /** This workspace's own directory. Nothing outside it is ever read, written or removed. */
  directory: string;
  /** The workspace identity the index records. An index of another identity is never touched. */
  workspaceId: string;
  now?: () => number;
  /** Tests lower these. */
  limits?: Partial<RawCheckpointLimits>;
  /** Told the ids of entries that left the store, once they are gone from its count. */
  onRemoved?: (ids: readonly string[]) => void;
  /** A test seam called just before the index is committed; the host passes none. */
  beforeIndexCommit?: () => Promise<void>;
  /** A test seam called with a staged payload once it is written and flushed, before it is read back. */
  afterStage?: (stagedFile: string) => Promise<void>;
  /** v0.9.110: set for the shared raw-v2 directory. */
  coordination?: RawStoreCoordination;
}

const INDEX_SCHEMA = 'unode.rawCheckpoints';
const INDEX_FILE = 'index.json';
const PAYLOADS = 'payloads';
const STAGING = 'staging';
const ID = /^[0-9a-f]{32}$/;
const PAYLOAD_NAME = /^([0-9a-f]{32})\.bin$/;
const STAGING_NAME = /^[0-9a-f]{32}\.[0-9a-f]{16}\.tmp$/;
const INDEX_TEMP_NAME = /^index\.json\.[0-9a-f]{16}\.tmp$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class RawCheckpointStore implements CheckpointIndexPeer {
  /** Changed only inside queued work, from its value when that work runs. */
  private entries: RawCheckpointEntry[] = [];
  /** Dropped for the text records' side of the shared limit, and not yet removed by queued work. */
  private readonly evicting = new Set<string>();
  private readonly pins = new Map<string, number>();
  private pinSequence = 0;
  private peer?: CheckpointIndexPeer;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly limits: RawCheckpointLimits;
  private readonly now: () => number;

  private constructor(private readonly options: RawCheckpointStoreOptions, private unavailable: string | undefined) {
    this.limits = { ...RAW_CHECKPOINT_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
  }

  /** Load the index and reconcile what an interrupted capture left. Nothing outside `directory` is touched. */
  static async open(options: RawCheckpointStoreOptions): Promise<{ store: RawCheckpointStore; reconciliation: RawCheckpointReconciliation }> {
    const reconciliation: RawCheckpointReconciliation = { removedStaging: 0, removedOrphans: 0, droppedMissing: 0, expired: 0 };
    const loaded = await loadIndex(options);
    if ('unavailable' in loaded) {
      reconciliation.unavailable = loaded.unavailable;
      return { store: new RawCheckpointStore(options, loaded.unavailable), reconciliation };
    }
    const store = new RawCheckpointStore(options, undefined);
    store.entries = loaded.entries;
    if (options.coordination) {
      try {
        await store.serialized(() => store.reconcile(reconciliation));
      } catch (error) {
        // Another window holds the store: it reconciles when it opens. Nothing here is changed.
        if (!(error instanceof RawStoreBusyError)) throw error;
      }
    } else {
      await store.reconcile(reconciliation);
    }
    return { store, reconciliation };
  }

  /** Share the entry limit with the text records of the same workspace. */
  attachPeer(peer: CheckpointIndexPeer | undefined): void {
    this.peer = peer;
  }

  /**
   * Keep `bytes` (null: the file does not exist; v0.9.99: a copy source, for a file copied on disk) as the restore
   * point of an overwrite of `target`. The entry comes back pinned: the caller releases the pin when its write is
   * done, or, for the first restore point of a request, when that request ends. A refusal removed nothing.
   */
  capture(input: {
    agentId: string;
    requestId?: string;
    path: string;
    target: string;
    bytes: Buffer | RawFileCopySource | null;
  }): Promise<RawCheckpointCapture> {
    return this.serialized<RawCheckpointCapture>(async () => {
      if (this.unavailable) {
        return { status: 'refused', code: 'unavailable', reason: this.unavailable };
      }
      const copy = isCopySource(input.bytes) ? input.bytes : undefined;
      const bytes = copy ? undefined : input.bytes as Buffer | null;
      const size = copy ? copy.size : bytes?.length ?? 0;
      if (copy && size > this.limits.maxTotalBytes) {
        return { status: 'refused', code: 'too-large', reason: `the file is larger than ${mib(this.limits.maxTotalBytes)}, all the room kept for this workspace's restore points.` };
      }
      if (!copy && size > this.limits.maxPayloadBytes) {
        return { status: 'refused', code: 'too-large', reason: `the file is larger than ${mib(this.limits.maxPayloadBytes)}, the most one restore point keeps.` };
      }
      if (!path.isAbsolute(input.target)) {
        return { status: 'refused', code: 'invalid', reason: 'the restore point does not name an absolute file.' };
      }
      try {
        await this.expire();
      } catch (err) {
        return { status: 'refused', code: 'storage', reason: `the restore-point index could not be saved (${errorCode(err)}).` };
      }
      const room = this.planRoom(size);
      if ('reason' in room) {
        return { status: 'refused', code: 'no-room', reason: room.reason };
      }
      const id = randomBytes(16).toString('hex');
      const before: RawFileState = input.bytes === null
        ? { exists: false }
        : { exists: true, size, sha256: copy ? copy.sha256 : sha256(bytes!) };
      if (input.bytes !== null) {
        const written = copy
          ? await this.copyPayload(id, copy)
          : await this.writePayload(id, bytes!, before as { sha256: string });
        if (written !== true) {
          return { status: 'refused', code: 'storage', reason: written };
        }
      }
      const firstPin = this.options.coordination ? this.newPinToken() : undefined;
      const entry: RawCheckpointEntry = {
        id,
        createdAt: this.now(),
        agentId: input.agentId,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        path: input.path,
        target: input.target,
        before,
        ...(firstPin ? { pins: [firstPin] } : {}),
      };
      // Entries chosen for eviction earlier go only if nothing pinned them meanwhile (another window may have).
      const pendingEvictions = [...this.evicting].filter((id) => this.entries.some((entry) => entry.id === id));
      const evictable = pendingEvictions.filter((id) => !this.isPinned(id));
      for (const id of pendingEvictions) if (this.isPinned(id)) this.evicting.delete(id);
      const evicted = new Set([...room.evictOwn, ...evictable]);
      const next = [...this.entries.filter((candidate) => !evicted.has(candidate.id)), entry];
      try {
        await this.commitIndex(next);
      } catch (err) {
        await this.removePayload(id);
        return { status: 'refused', code: 'storage', reason: `the restore-point index could not be saved (${errorCode(err)}).` };
      }
      this.entries = next;
      // Pinned before anything else can run: the caller is about to rely on it. With coordination the pin was written
      // with the entry, so no other window can drop it either.
      const pin = this.pin(id, firstPin)!;
      this.removed(room.evictOwn);
      // Raw-v2 tells a deferred eviction once it is done.
      if (this.options.coordination) this.removed(evictable);
      for (const evictedId of evicted) {
        this.evicting.delete(evictedId);
        await this.removePayload(evictedId);
      }
      for (let i = 0; i < room.evictPeer; i++) {
        this.peer?.evictOldest();
      }
      return { status: 'captured', entry, pin };
    }).catch((error: unknown): RawCheckpointCapture => {
      if (error instanceof RawStoreBusyError) return { status: 'refused', code: 'unavailable', reason: error.message };
      return { status: 'refused', code: 'storage', reason: `the restore point could not be kept (${errorCode(error)}).` };
    });
  }

  /** Record what the overwrite left, once the caller has read it back. False when it could not be saved. */
  recordAfter(id: string, after: RawFileState): Promise<boolean> {
    return this.serialized<boolean>(async () => {
      const index = this.entries.findIndex((entry) => entry.id === id);
      if (index < 0 || this.unavailable) {
        return false;
      }
      const next = [...this.entries];
      next[index] = { ...next[index], after };
      try {
        await this.commitIndex(next);
      } catch {
        return false;
      }
      this.entries = next;
      return true;
    }).catch(() => false);
  }

  /** The bytes of a restore point, verified against its recorded size and SHA-256. */
  async readBefore(id: string): Promise<RawCheckpointRead> {
    const entry = this.get(id);
    if (!entry) {
      return { status: 'unavailable', reason: 'that restore point is no longer kept.' };
    }
    if (!entry.before.exists) {
      return { status: 'absent' };
    }
    let bytes: Buffer;
    try {
      const handle = await fs.open(this.payloadPath(id), 'r');
      try {
        const stat = await handle.stat();
        if (stat.size !== entry.before.size) {
          return { status: 'unavailable', reason: 'its saved copy does not have the recorded size.' };
        }
        bytes = Buffer.alloc(entry.before.size);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== bytes.length) {
          return { status: 'unavailable', reason: 'its saved copy could not be read whole.' };
        }
      } finally {
        await handle.close();
      }
    } catch (err) {
      return { status: 'unavailable', reason: `its saved copy could not be read (${errorCode(err)}).` };
    }
    return sha256(bytes) === entry.before.sha256
      ? { status: 'read', bytes }
      : { status: 'unavailable', reason: 'its saved copy does not match the recorded SHA-256.' };
  }

  /**
   * Keep an entry from being dropped while something depends on it. Undefined for an entry that is gone. With
   * coordination the pin is also written into the index, so other windows keep the entry too; it holds in this window
   * from this call on, and in the others once written.
   */
  pin(id: string, written?: string): RawCheckpointPin | undefined {
    if (!this.get(id)) {
      return undefined;
    }
    this.pins.set(id, (this.pins.get(id) ?? 0) + 1);
    const token = this.options.coordination ? written ?? this.newPinToken() : undefined;
    if (token && !written) void this.writePin(id, token, true).catch(() => undefined);
    let released = false;
    return {
      id,
      release: () => {
        if (released) return;
        released = true;
        const count = (this.pins.get(id) ?? 1) - 1;
        if (count <= 0) this.pins.delete(id); else this.pins.set(id, count);
        if (token) void this.writePin(id, token, false).catch(() => undefined);
      },
    };
  }

  /**
   * v0.9.110: a pin that holds in every window before it is handed out: written into the shared index and read back.
   * Undefined when the entry is gone or the pin could not be written; a caller then must not rely on the entry.
   * Without coordination it is the ordinary pin.
   */
  async pinDurable(id: string): Promise<RawCheckpointPin | undefined> {
    if (!this.options.coordination) return this.pin(id);
    if (!this.get(id)) return undefined;
    const token = this.newPinToken();
    try {
      await this.writePin(id, token, true);
    } catch {
      return undefined;
    }
    if (!(this.entries.find((entry) => entry.id === id)?.pins ?? []).includes(token)) return undefined;
    return this.pin(id, token);
  }

  /**
   * v0.9.110 R2: a pin owned by a history record (`history:<operation>`), not by this host: it is written into the
   * index and no window drops it when a host goes. Resolves true once written. Coordinated stores only.
   */
  async pinNamed(id: string, owner: string): Promise<boolean> {
    if (!this.options.coordination || !/^history:[A-Za-z0-9._:-]{1,160}$/.test(owner)) return false;
    if (!this.get(id)) return false;
    try {
      await this.writePin(id, owner, true);
    } catch {
      return false;
    }
    return (this.entries.find((entry) => entry.id === id)?.pins ?? []).includes(owner);
  }

  /** Remove a history-owned pin; true when it is gone. */
  async unpinNamed(id: string, owner: string): Promise<boolean> {
    if (!this.options.coordination) return false;
    try {
      await this.writePin(id, owner, false);
      return true;
    } catch {
      return false;
    }
  }

  isPinned(id: string): boolean {
    if ((this.pins.get(id) ?? 0) > 0) return true;
    return (this.entries.find((entry) => entry.id === id)?.pins?.length ?? 0) > 0;
  }

  /**
   * v0.9.110 H1: a hold of the task history (a favourite's restore point), written into the index as `history:<owner>`:
   * not a host's pin, so no reload or gone-host reconciliation drops it; only releasing it here does. False when the
   * entry is gone.
   */
  async holdDurably(id: string, owner: string, hold: boolean): Promise<boolean> {
    if (!this.entries.some((entry) => entry.id === id)) return false;
    await this.writePin(id, `history:${owner}`, hold);
    return true;
  }

  /** v0.9.110 H1: the entries the task history holds under `owner`. */
  durablyHeld(owner: string): string[] {
    const token = `history:${owner}`;
    return this.entries.filter((entry) => entry.pins?.includes(token)).map((entry) => entry.id);
  }

  private newPinToken(): string {
    return `${this.options.coordination!.hostInstanceId}:${++this.pinSequence}-${randomBytes(4).toString('hex')}`;
  }

  /** Add or remove one pin of this host in the shared index. */
  private writePin(id: string, token: string, add: boolean): Promise<void> {
    return this.serialized(async () => {
      const index = this.entries.findIndex((entry) => entry.id === id);
      if (index < 0) return;
      const held = this.entries[index].pins ?? [];
      const pins = add ? [...new Set([...held, token])] : held.filter((pin) => pin !== token);
      if (pins.length === held.length && pins.every((pin, i) => pin === held[i])) return;
      const next = [...this.entries];
      next[index] = { ...next[index], ...(pins.length > 0 ? { pins } : { pins: undefined }) };
      if (pins.length === 0) delete (next[index] as { pins?: unknown }).pins;
      await this.commitIndex(next);
      this.entries = next;
    });
  }

  get(id: string): RawCheckpointEntry | undefined {
    return this.live().find((entry) => entry.id === id);
  }

  /** Newest first. */
  list(): RawCheckpointEntry[] {
    return this.live().reverse();
  }

  private live(): RawCheckpointEntry[] {
    return this.entries.filter((entry) => !this.evicting.has(entry.id));
  }

  /**
   * v0.9.110: copy entries of the older raw-v1 directory into this one, under the same ids, so text records that name
   * them keep their restore points. Each payload is copied and verified against its recorded size and SHA-256 before
   * its entry is added; v1 is only read, never changed. An entry that cannot be verified, or does not fit, is left
   * out (its records then lose the restore point, as for any entry that is gone). Returns the ids now here.
   */
  importLegacyEntries(source: { directory: string; workspaceId: string }, ids: readonly string[]): Promise<string[]> {
    return this.serialized<string[]>(async () => {
      if (this.unavailable) return [];
      const loaded = await loadIndex({ directory: source.directory, workspaceId: source.workspaceId });
      if ('unavailable' in loaded) return [];
      const wanted = new Set(ids.filter((id) => ID.test(id) && !this.entries.some((entry) => entry.id === id)));
      const imported: RawCheckpointEntry[] = [];
      // The room is counted with what this import has already admitted; nothing is evicted to make room for it.
      let entries = this.live().length + (this.peer?.count() ?? 0);
      let bytes = this.live().reduce((total, entry) => total + payloadSize(entry), 0);
      for (const entry of loaded.entries) {
        if (!wanted.has(entry.id)) continue;
        const { pins: _pins, ...plain } = entry;
        if (entries + 1 > this.limits.maxEntries) break;
        if (entry.before.exists && bytes + entry.before.size > this.limits.maxTotalBytes) continue;
        if (entry.before.exists) {
          const copied = await this.copyPayload(entry.id, {
            copyFrom: path.join(source.directory, PAYLOADS, `${entry.id}.bin`), size: entry.before.size, sha256: entry.before.sha256,
          });
          if (copied !== true) continue;
        }
        imported.push(plain);
        entries += 1;
        bytes += payloadSize(entry);
      }
      if (imported.length === 0) return [];
      const next = [...this.entries, ...imported].sort((a, b) => a.createdAt - b.createdAt);
      try {
        await this.commitIndex(next);
      } catch {
        for (const entry of imported) await this.removePayload(entry.id);
        return [];
      }
      this.entries = next;
      return imported.map((entry) => entry.id);
    }).catch(() => []);
  }

  /** Remove an entry that is not in use. */
  remove(id: string): Promise<boolean> {
    return this.serialized<boolean>(async () => {
      if (this.isPinned(id) || !this.get(id) || this.unavailable) {
        return false;
      }
      const next = this.entries.filter((entry) => entry.id !== id);
      await this.commitIndex(next);
      this.entries = next;
      this.removed([id]);
      await this.removePayload(id);
      return true;
    }).catch(() => false);
  }

  /**
   * v0.9.110 H1: remove an entry for a deletion the person asked for, and say what is on disk afterwards. `in-use`: a
   * pin holds it (running work); nothing changes. `removed`: neither the entry nor its bytes are left, also when it was
   * already gone from the index (an earlier attempt removed the entry but not its bytes: they are removed now).
   * `failed`: its bytes are still there.
   */
  purge(id: string): Promise<'removed' | 'in-use' | 'failed'> {
    if (!ID.test(id)) return Promise.resolve('failed');
    return this.serialized<'removed' | 'in-use' | 'failed'>(async () => {
      if (this.unavailable) return 'failed';
      if (this.isPinned(id)) return 'in-use';
      if (this.get(id)) {
        const next = this.entries.filter((entry) => entry.id !== id);
        await this.commitIndex(next);
        this.entries = next;
        this.removed([id]);
      }
      return await removeFileVerified(this.payloadPath(id)) ? 'removed' : 'failed';
    }).catch(() => 'failed' as const);
  }

  /** v0.9.110 H1: the entries as the shared index holds them now, also those another window added since. */
  listCurrent(): Promise<RawCheckpointEntry[]> {
    return this.serialized(async () => (this.unavailable ? Promise.reject(new Error(this.unavailable)) : this.list()));
  }

  /**
   * v0.9.110 H1: the entries an older raw directory of this workspace holds (raw-v1), read without changing it: its
   * index's entries, and payload files the index does not name. Empty when it is absent or another workspace's. It
   * throws when the directory is there but cannot be inspected (its index or payloads cannot be read, or its index is
   * damaged or of a format this version does not know): what it holds is not known, and it is left untouched.
   */
  static async readEntries(source: { directory: string; workspaceId: string }): Promise<Array<{ id: string; path: string }>> {
    const loaded = await loadIndex({ directory: source.directory, workspaceId: source.workspaceId });
    if ('unavailable' in loaded) {
      if (loaded.foreign) return [];
      throw new Error(loaded.unavailable);
    }
    const found = new Map(loaded.entries.filter((entry) => ID.test(entry.id)).map((entry) => [entry.id, entry.path] as [string, string]));
    if (loaded.entries.length > 0 || (await listNamesOrThrow(source.directory)).includes(INDEX_FILE)) {
      for (const name of await listNamesOrThrow(path.join(source.directory, PAYLOADS))) {
        const id = name.endsWith('.bin') ? name.slice(0, -4) : '';
        if (ID.test(id) && !found.has(id)) found.set(id, '(file not recorded)');
      }
    }
    return [...found].map(([id, filePath]) => ({ id, path: filePath }));
  }

  /** v0.9.110 H1: remove one payload file of an older raw directory (raw-v1); true only once it is gone. */
  static async removeEntryBytes(source: { directory: string }, id: string): Promise<boolean> {
    return ID.test(id) && removeFileVerified(path.join(source.directory, PAYLOADS, `${id}.bin`));
  }

  /** Settles once every queued change has been written. */
  async idle(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  count(): number {
    return this.live().length;
  }

  evictableTimes(): number[] {
    return this.live().filter((entry) => !this.isPinned(entry.id)).map((entry) => entry.createdAt);
  }

  /**
   * Drop the oldest entry not in use, for the text records' side of the shared limit. It leaves the count at once;
   * its index entry and payload are removed by queued work, from the index as it is when that work runs.
   */
  evictOldest(): void {
    const oldest = this.live().find((entry) => !this.isPinned(entry.id));
    if (!oldest || this.unavailable) {
      return;
    }
    this.evicting.add(oldest.id);
    // v0.9.110 (raw-v2): another window may pin it before this window's turn; its removal is told only once it is done.
    const shared = !!this.options.coordination;
    if (!shared) this.removed([oldest.id]);
    void this.serialized(async () => {
      if (!this.evicting.has(oldest.id)) {
        return; // a capture removed it already
      }
      if (shared) {
        // Under the lease, with the index read again: gone already, or pinned meanwhile by any window, it stays put.
        if (!this.entries.some((entry) => entry.id === oldest.id)) {
          this.evicting.delete(oldest.id);
          this.removed([oldest.id]);
          return;
        }
        if (this.isPinned(oldest.id)) {
          this.evicting.delete(oldest.id);
          return;
        }
      }
      const next = this.entries.filter((entry) => entry.id !== oldest.id);
      await this.commitIndex(next);
      this.entries = next;
      this.evicting.delete(oldest.id);
      await this.removePayload(oldest.id);
      if (shared) this.removed([oldest.id]);
    }).catch(() => { if (shared) this.evicting.delete(oldest.id); });
  }

  /**
   * Which entries must go for a payload of `size` to fit: the oldest first, of either kind for the entry limit, and
   * of this store alone for the byte limit. Pinned entries never go. Nothing is removed here.
   */
  private planRoom(size: number): { evictOwn: string[]; evictPeer: number } | { reason: string } {
    const live = this.live();
    const own = live.filter((entry) => !this.isPinned(entry.id));
    const peerTimes = this.peer?.evictableTimes() ?? [];
    const evictOwn: string[] = [];
    let evictPeer = 0;
    let entries = live.length + (this.peer?.count() ?? 0);
    let bytes = live.reduce((total, entry) => total + payloadSize(entry), 0);
    while (entries + 1 > this.limits.maxEntries || bytes + size > this.limits.maxTotalBytes) {
      const next = own[evictOwn.length];
      const byteBound = bytes + size > this.limits.maxTotalBytes;
      const peerNext = peerTimes[evictPeer];
      // On equal times the text record goes first, as the text store's own trim decides.
      const takePeer = !byteBound && peerNext !== undefined && (next === undefined || peerNext <= next.createdAt);
      if (takePeer) {
        evictPeer++;
        entries--;
        continue;
      }
      if (!next) {
        return {
          reason: byteBound
            ? `there is not room for it in the ${mib(this.limits.maxTotalBytes)} kept for this workspace's restore points without removing one still in use.`
            : `this workspace already keeps ${this.limits.maxEntries} restore points, and none that could make room is free.`,
        };
      }
      evictOwn.push(next.id);
      entries--;
      bytes -= payloadSize(next);
    }
    return { evictOwn, evictPeer };
  }

  private async expire(): Promise<number> {
    const cutoff = this.now() - this.limits.maxAgeMs;
    const expired = this.entries.filter((entry) => entry.createdAt < cutoff && !this.isPinned(entry.id));
    if (expired.length === 0) {
      return 0;
    }
    const next = this.entries.filter((entry) => !expired.includes(entry));
    await this.commitIndex(next);
    this.entries = next;
    this.removed(expired.map((entry) => entry.id));
    for (const entry of expired) {
      await this.removePayload(entry.id);
    }
    return expired.length;
  }

  /** Remove what a crash left: staging files, unnamed payloads, index temporaries, entries without their payload. */
  private async reconcile(result: RawCheckpointReconciliation): Promise<void> {
    await this.dropPinsOfGoneHosts();
    const named = new Set(this.entries.map((entry) => entry.id));
    for (const name of await listNames(this.dir(STAGING))) {
      if (STAGING_NAME.test(name) && await removeFile(path.join(this.dir(STAGING), name))) {
        result.removedStaging++;
      }
    }
    for (const name of await listNames(this.options.directory)) {
      if (INDEX_TEMP_NAME.test(name)) {
        await removeFile(path.join(this.options.directory, name));
      }
    }
    const present = new Set<string>();
    for (const name of await listNames(this.dir(PAYLOADS))) {
      const match = PAYLOAD_NAME.exec(name);
      if (!match) {
        continue;
      }
      if (named.has(match[1])) {
        present.add(match[1]);
      } else if (await removeFile(path.join(this.dir(PAYLOADS), name))) {
        result.removedOrphans++;
      }
    }
    const kept = this.entries.filter((entry) => !entry.before.exists || present.has(entry.id));
    result.droppedMissing = this.entries.length - kept.length;
    if (kept.length !== this.entries.length) {
      const dropped = this.entries.filter((entry) => !kept.includes(entry)).map((entry) => entry.id);
      await this.commitIndex(kept);
      this.entries = kept;
      this.removed(dropped);
    }
    result.expired = await this.expire();
  }

  /** v0.9.110: a pin whose host is proven gone holds nothing any more. Pins of live or unknown hosts stay. */
  private async dropPinsOfGoneHosts(): Promise<void> {
    const coordination = this.options.coordination;
    if (!coordination) return;
    const hosts = new Set<string>();
    for (const entry of this.entries) for (const pin of entry.pins ?? []) {
      const host = pin.slice(0, pin.indexOf(':'));
      // `history:` pins belong to a history record, not to a host: no host's end releases them.
      if (host && host !== coordination.hostInstanceId && host !== 'history') hosts.add(host);
    }
    if (hosts.size === 0) return;
    const gone = await coordination.hostsGone([...hosts]).catch(() => new Set<string>());
    if (gone.size === 0) return;
    const next = this.entries.map((entry) => {
      if (!entry.pins) return entry;
      const pins = entry.pins.filter((pin) => !gone.has(pin.slice(0, pin.indexOf(':'))));
      if (pins.length === entry.pins.length) return entry;
      const copy: RawCheckpointEntry = { ...entry, pins };
      if (pins.length === 0) delete (copy as { pins?: unknown }).pins;
      return copy;
    });
    await this.commitIndex(next);
    this.entries = next;
  }

  /** Tell the owner of records that refer to these entries that they are gone. */
  private removed(ids: readonly string[]): void {
    if (ids.length === 0) {
      return;
    }
    try {
      this.options.onRemoved?.(ids);
    } catch {
      // A listener's failure does not undo the removal.
    }
  }

  private async writePayload(id: string, bytes: Buffer, before: { sha256: string }): Promise<true | string> {
    const staged = path.join(this.dir(STAGING), `${id}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      await fs.mkdir(this.dir(STAGING), { recursive: true });
      await fs.mkdir(this.dir(PAYLOADS), { recursive: true });
      const handle = await fs.open(staged, 'wx');
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.options.afterStage?.(staged);
      // Read back what reached the disk: the restore point is the payload, not the buffer it was made from.
      if (sha256(await fs.readFile(staged)) !== before.sha256) {
        await removeFile(staged);
        return 'its saved copy did not read back as written.';
      }
      await fs.rename(staged, this.payloadPath(id));
      return true;
    } catch (err) {
      await removeFile(staged);
      return `its saved copy could not be written (${errorCode(err)}).`;
    }
  }

  /**
   * v0.9.99: copy a file into a payload on disk, as a stream, and keep it only when what reached the disk has the size
   * and SHA-256 the caller observed. A file that changed meanwhile keeps nothing.
   */
  private async copyPayload(id: string, source: RawFileCopySource): Promise<true | string> {
    const staged = path.join(this.dir(STAGING), `${id}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      await fs.mkdir(this.dir(STAGING), { recursive: true });
      await fs.mkdir(this.dir(PAYLOADS), { recursive: true });
      await fs.copyFile(source.copyFrom, staged, fsConstants.COPYFILE_EXCL);
      const handle = await fs.open(staged, 'r+');
      let digest: { size: number; sha256: string };
      try {
        await handle.sync();
        digest = await streamDigest(handle);
      } finally {
        await handle.close();
      }
      await this.options.afterStage?.(staged);
      if (digest.size !== source.size || digest.sha256 !== source.sha256) {
        await removeFile(staged);
        return 'the file changed while its copy was being made.';
      }
      await fs.rename(staged, this.payloadPath(id));
      return true;
    } catch (err) {
      await removeFile(staged);
      return `its saved copy could not be written (${errorCode(err)}).`;
    }
  }

  private async commitIndex(entries: readonly RawCheckpointEntry[]): Promise<void> {
    await fs.mkdir(this.options.directory, { recursive: true });
    await this.options.beforeIndexCommit?.();
    const data = JSON.stringify({ schema: INDEX_SCHEMA, version: 1, workspace: this.options.workspaceId, entries });
    const temporary = path.join(this.options.directory, `${INDEX_FILE}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx');
      try {
        await handle.writeFile(data, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, path.join(this.options.directory, INDEX_FILE));
    } catch (err) {
      await removeFile(temporary);
      throw err;
    }
  }

  private async removePayload(id: string): Promise<void> {
    if (ID.test(id)) {
      await removeFile(this.payloadPath(id));
    }
  }

  private payloadPath(id: string): string {
    return path.join(this.dir(PAYLOADS), `${id}.bin`);
  }

  private dir(name: string): string {
    return path.join(this.options.directory, name);
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const coordination = this.options.coordination;
    const step = coordination ? () => this.underLease(coordination, work) : work;
    const run = this.queue.then(step, step);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** One turn of this window in the shared directory: the lease, then the index as it is now, then the change. */
  private async underLease<T>(coordination: RawStoreCoordination, work: () => Promise<T>): Promise<T> {
    const attempt = await coordination.lease.acquire('raw-checkpoints', { waitMs: coordination.waitMs ?? RAW_STORE_WAIT_MS });
    if (attempt.status !== 'held') throw new RawStoreBusyError();
    try {
      await this.reloadIndex();
      return await work();
    } finally {
      await attempt.lease.release().catch(() => undefined);
    }
  }

  /** Read the index another window may have changed; entries it removed are reported gone here too. */
  private async reloadIndex(): Promise<void> {
    const loaded = await loadIndex(this.options);
    if ('unavailable' in loaded) {
      this.unavailable = loaded.unavailable;
      return;
    }
    const now = new Set(loaded.entries.map((entry) => entry.id));
    const gone = this.entries.filter((entry) => !now.has(entry.id)).map((entry) => entry.id);
    this.entries = loaded.entries;
    for (const id of gone) this.evicting.delete(id);
    this.removed(gone.filter((id) => !this.evicting.has(id)));
  }
}

/** The index, or why the directory must not be used. A missing index is an empty store. */
async function loadIndex(options: RawCheckpointStoreOptions): Promise<{ entries: RawCheckpointEntry[] } | { unavailable: string; foreign?: true }> {
  let text: string;
  try {
    text = await fs.readFile(path.join(options.directory, INDEX_FILE), 'utf8');
  } catch (err) {
    return errorCode(err) === 'ENOENT'
      ? { entries: [] }
      : { unavailable: `the restore-point index could not be read (${errorCode(err)}).` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { unavailable: 'the restore-point index is not readable, so UnodeAi leaves it and its restore points untouched.' };
  }
  const index = parsed as { schema?: unknown; version?: unknown; workspace?: unknown; entries?: unknown };
  if (!index || index.schema !== INDEX_SCHEMA || index.version !== 1 || !Array.isArray(index.entries)) {
    return { unavailable: 'the restore-point index has a format this UnodeAi version does not know, so it is left untouched.' };
  }
  if (index.workspace !== options.workspaceId) {
    return { unavailable: 'the restore-point directory belongs to another workspace, so it is left untouched.', foreign: true };
  }
  return { entries: index.entries.filter(isEntry) };
}

function isEntry(value: unknown): value is RawCheckpointEntry {
  const entry = value as Partial<RawCheckpointEntry> | undefined;
  return !!entry
    && typeof entry.id === 'string' && ID.test(entry.id)
    && typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
    && typeof entry.agentId === 'string'
    && typeof entry.path === 'string'
    && typeof entry.target === 'string' && path.isAbsolute(entry.target)
    && isState(entry.before)
    && (entry.after === undefined || isState(entry.after))
    && (entry.pins === undefined || (Array.isArray(entry.pins) && entry.pins.every((pin) => typeof pin === 'string' && pin.length <= 200)));
}

function isState(value: unknown): value is RawFileState {
  const state = value as { exists?: unknown; size?: unknown; sha256?: unknown } | undefined;
  if (!state || typeof state.exists !== 'boolean') {
    return false;
  }
  return !state.exists || (
    typeof state.size === 'number' && Number.isInteger(state.size) && state.size >= 0
    && typeof state.sha256 === 'string' && SHA256.test(state.sha256)
  );
}

function payloadSize(entry: RawCheckpointEntry): number {
  return entry.before.exists ? entry.before.size : 0;
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** The files of a directory; none when it does not exist. Any other failure to list it is thrown. */
async function listNamesOrThrow(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return [];
    throw new Error(`the restore-point directory could not be listed (${errorCode(err)}).`);
  }
}

async function removeFile(file: string): Promise<boolean> {
  try {
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  }
}

/** v0.9.110 H1: unlink a file and confirm it is gone; a file that was not there is gone too. */
async function removeFileVerified(file: string): Promise<boolean> {
  await fs.unlink(file).catch(() => undefined);
  try {
    await fs.stat(file);
    return false;
  } catch (err) {
    return errorCode(err) === 'ENOENT';
  }
}

/** Size and SHA-256 of an open file, read from its start in chunks. */
async function streamDigest(handle: fs.FileHandle): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(1024 * 1024);
  let size = 0;
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, size);
    if (bytesRead === 0) break;
    hash.update(chunk.subarray(0, bytesRead));
    size += bytesRead;
  }
  return { size, sha256: hash.digest('hex') };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function mib(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? (err instanceof Error ? err.message : String(err));
}
