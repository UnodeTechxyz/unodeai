/*---------------------------------------------------------------------------------------------
 *  UnodeAi - SpendStore (v0.9.89, design §8, §13.4)
 *
 *  Append-only per-window NDJSON shards plus a small control file, under the extension's global storage and
 *  keyed by the primary workspace root identity. Usage appends never take a lock: each window writes only its
 *  own shard, fsyncs, and only then reports the event durable. Reset, notice claims, repository decisions and
 *  Repair are the only operations that take `maintenance.lock`, an atomic directory with a nonce-checked lease.
 *
 *  Control is a series of revision files, `control/<revision>.json`, each published once by an exclusive hard
 *  link: the first window to publish a revision wins and any other publish of it fails. A lock holder whose lease
 *  was taken over therefore cannot write over newer control, whatever it believes about its lease. The lock itself
 *  is never rewritten or removed by a holder: renewals and release only create files named by the holder's nonce.
 *  Nothing here knows about prices or targets.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  emptySpendControl,
  SpendControlV1,
  SpendEventPayload,
  SpendEventV1,
  StoredSpendEvent,
  validateSpendControl,
  validateSpendEvent,
} from '../models/spend/SpendTypes';

export const SPEND_SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
export const SPEND_LINE_MAX_BYTES = 64 * 1024;
export const MAINTENANCE_LEASE_MS = 2 * 60 * 1000;
export const MAINTENANCE_RENEW_MS = 15 * 1000;
export const SPEND_POLL_MS = 15 * 1000;
/** A window whose heartbeat is older than this is treated as gone; its open usage units become coverage gaps. */
export const HOST_HEARTBEAT_LEASE_MS = 2 * 60 * 1000;
/** Control revisions kept after a commit; the older ones are the backups a reader falls back to. */
export const CONTROL_REVISIONS_KEPT = 10;
/** An unreadable newest revision younger than this may still be being written (file systems without hard links). */
export const CONTROL_IN_FLIGHT_MS = 10 * 1000;
const REVISION_FILE = /^(\d{12})\.json$/;
/** Error codes that mean the file system has no hard links; publishing then falls back to exclusive create. */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL', 'EISDIR']);
const NEWER_SCHEMA = 'Spend tracking was written by a newer UnodeAi. Update UnodeAi; this version will not overwrite it.';

export type ControlState = 'ok' | 'backup' | 'missing' | 'corrupt' | 'unsupported';

export interface SpendStoreSnapshot {
  events: readonly StoredSpendEvent[];
  control: SpendControlV1;
  controlState: ControlState;
  /** Complete lines that did not validate (never counted). */
  quarantinedLines: number;
  /** Shards written by a newer schema: reminders pause rather than misread them. */
  unsupportedLines: number;
  /** Hosts whose heartbeat is current. */
  liveHosts: ReadonlySet<string>;
}

export interface SpendStoreOptions {
  /** `<globalStorage>/spend/v1/<workspaceRootIdentity>` */
  root: string;
  hostEpoch?: string;
  now?: () => number;
  randomId?: () => string;
  log?: (message: string) => void;
  /** Disable timers in tests. */
  pollMs?: number;
  renewMs?: number;
  leaseMs?: number;
  heartbeatLeaseMs?: number;
  segmentMaxBytes?: number;
  /** Tests: publish control revisions by exclusive create, as on a file system without hard links. */
  hardLinks?: boolean;
  /** Tests: runs after the ownership check, immediately before a control revision is published. */
  beforeControlPublish?: () => Promise<void>;
}

interface ShardCursor {
  offset: number;
  pending: string;
}

/** A thrown error that means another window holds the lock; callers retry later. */
export class SpendLockBusyError extends Error {
  constructor() { super('Another UnodeAi window is updating spend tracking; retrying shortly.'); this.name = 'SpendLockBusyError'; }
}

/** An event this version refuses to write (invalid or oversized). Retrying cannot help. */
export class SpendEventRejectedError extends Error {
  constructor(message: string) { super(message); this.name = 'SpendEventRejectedError'; }
}

export class SpendStore {
  readonly hostEpoch: string;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly log: (message: string) => void;
  private readonly shardsDir: string;
  private readonly hostsDir: string;
  private readonly controlDir: string;
  private readonly lockDir: string;
  private readonly leaseMs: number;
  private readonly renewMs: number;
  private readonly heartbeatLeaseMs: number;
  private sequence = 0;
  private segmentIndex = 0;
  private segmentBytes = 0;
  /** Appends and shard reads run one at a time, so this window's cursor always matches what it wrote. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly events = new Map<string, StoredSpendEvent[]>();
  private readonly cursors = new Map<string, ShardCursor>();
  private control: SpendControlV1 = emptySpendControl();
  private controlState: ControlState = 'missing';
  /** The highest control revision file present, readable or not; the next commit publishes the one after it. */
  private controlSlot = 0;
  /** Modification time of the newest unreadable revision above the one in use, if any. */
  private unreadableSince: number | undefined;
  private hardLinks: boolean;
  private quarantinedLines = 0;
  private unsupportedLines = 0;
  private liveHosts = new Set<string>();
  private listeners = new Set<() => void>();
  private watcher: fs.FSWatcher | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing: Promise<boolean> | undefined;
  private disposed = false;
  private opened = false;
  private directories: Promise<void> | undefined;

  constructor(private readonly options: SpendStoreOptions) {
    this.hostEpoch = options.hostEpoch ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomUUID;
    this.log = options.log ?? (() => undefined);
    this.shardsDir = path.join(options.root, 'shards');
    this.hostsDir = path.join(options.root, 'hosts');
    this.controlDir = path.join(options.root, 'control');
    this.lockDir = path.join(options.root, 'maintenance.lock');
    this.hardLinks = options.hardLinks !== false;
    this.leaseMs = options.leaseMs ?? MAINTENANCE_LEASE_MS;
    this.renewMs = options.renewMs ?? MAINTENANCE_RENEW_MS;
    this.heartbeatLeaseMs = options.heartbeatLeaseMs ?? HOST_HEARTBEAT_LEASE_MS;
  }

  get root(): string { return this.options.root; }

  /** Create directories, write this window's heartbeat and read everything already there. */
  async open(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    await this.ensureDirectories();
    await this.writeHeartbeat();
    await this.refresh();
    const pollMs = this.options.pollMs ?? SPEND_POLL_MS;
    if (pollMs > 0) {
      this.pollTimer = setInterval(() => { void this.refresh().catch(() => undefined); }, pollMs);
      (this.pollTimer as { unref?: () => void }).unref?.();
      this.heartbeatTimer = setInterval(() => { void this.writeHeartbeat().catch(() => undefined); }, Math.min(pollMs * 2, 30_000));
      (this.heartbeatTimer as { unref?: () => void }).unref?.();
      try {
        // Watches can be lossy on remote and network hosts; the poll above is the guarantee.
        this.watcher = fs.watch(this.options.root, { recursive: true }, () => this.scheduleRefresh());
        this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; });
      } catch {
        this.watcher = undefined;
      }
    }
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Activation never waits for this; the first append does. */
  private ensureDirectories(): Promise<void> {
    this.directories ??= (async () => {
      await fsp.mkdir(this.shardsDir, { recursive: true });
      await fsp.mkdir(this.hostsDir, { recursive: true });
    })();
    return this.directories;
  }

  snapshot(): SpendStoreSnapshot {
    const events: StoredSpendEvent[] = [];
    for (const list of this.events.values()) events.push(...list);
    return {
      events,
      control: this.control,
      controlState: this.controlState,
      quarantinedLines: this.quarantinedLines,
      unsupportedLines: this.unsupportedLines,
      liveHosts: this.liveHosts,
    };
  }

  /**
   * Append one event to this window's shard and fsync it. Resolves only once the line is durable; the caller
   * updates projections and notices after that. Appends are serialized per window and never take the lock.
   */
  append(payload: SpendEventPayload, eventId: string): Promise<StoredSpendEvent> {
    return this.exclusive(() => this.appendNow(payload, eventId));
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private segmentName(): string {
    return `${this.hostEpoch}-${this.segmentIndex}`;
  }

  private async appendNow(payload: SpendEventPayload, eventId: string): Promise<StoredSpendEvent> {
    if (this.disposed) throw new Error('Spend tracking is closed.');
    const event = {
      schemaVersion: 1 as const,
      eventId,
      hostEpoch: this.hostEpoch,
      sequence: this.sequence + 1,
      recordedAt: new Date(this.now()).toISOString(),
      ...payload,
    } as SpendEventV1;
    if (!validateSpendEvent(event)) throw new SpendEventRejectedError(`Refusing to write an invalid spend event (${payload.kind}).`);
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > SPEND_LINE_MAX_BYTES) throw new SpendEventRejectedError('Refusing to write an oversized spend event.');
    if (this.segmentBytes > 0 && this.segmentBytes + bytes > (this.options.segmentMaxBytes ?? SPEND_SEGMENT_MAX_BYTES)) {
      this.segmentIndex += 1;
      this.segmentBytes = 0;
    }
    const segment = this.segmentName();
    const file = path.join(this.shardsDir, `${segment}.ndjson`);
    await this.ensureDirectories();
    const handle = await fsp.open(file, 'a');
    try {
      // writeFile keeps writing until every byte is written; a single write() may stop short.
      await handle.writeFile(line, 'utf8');
      await handle.sync();
    } catch (error) {
      // Part of the line may be on disk. Later lines go to a fresh segment so none is glued to that fragment, and
      // the sequence number is not reused (a line that did land whole is the same event, deduplicated by id).
      this.sequence = event.sequence;
      this.segmentIndex += 1;
      this.segmentBytes = 0;
      throw error;
    } finally {
      await handle.close();
    }
    this.sequence = event.sequence;
    this.segmentBytes += bytes;
    const stored: StoredSpendEvent = { segment, event };
    // Record our own line at once and advance the cursor, so the next refresh does not read it twice.
    const list = this.events.get(segment) ?? [];
    list.push(stored);
    this.events.set(segment, list);
    const cursor = this.cursors.get(segment) ?? { offset: 0, pending: '' };
    cursor.offset += bytes;
    this.cursors.set(segment, cursor);
    return stored;
  }

  private scheduleRefresh(): void {
    if (this.disposed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh().catch(() => undefined);
    }, 250);
    (this.refreshTimer as { unref?: () => void }).unref?.();
  }

  /** Re-read appended shard bytes, the control file and heartbeats. Resolves true when anything changed. */
  refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    const run = this.exclusive(async () => {
      let changed = false;
      let names: string[] = [];
      try { names = await fsp.readdir(this.shardsDir); } catch { names = []; }
      for (const name of names.filter((entry) => entry.endsWith('.ndjson')).sort()) {
        if (await this.readShard(name.slice(0, -'.ndjson'.length))) changed = true;
      }
      if (await this.readControl()) changed = true;
      if (await this.readHeartbeats()) changed = true;
      if (changed) this.emit();
      return changed;
    });
    this.refreshing = run;
    return run.finally(() => { this.refreshing = undefined; });
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* a view refresh never breaks accounting */ }
    }
  }

  private async readShard(segment: string): Promise<boolean> {
    const file = path.join(this.shardsDir, `${segment}.ndjson`);
    let size: number;
    try { size = (await fsp.stat(file)).size; } catch { return false; }
    let cursor = this.cursors.get(segment);
    if (cursor && size < cursor.offset) {
      // A shard never shrinks; if one did, re-read it whole and let dedupe decide.
      this.log(`Spend shard ${segment} shrank; re-reading it.`);
      this.events.delete(segment);
      cursor = undefined;
    }
    cursor ??= { offset: 0, pending: '' };
    this.cursors.set(segment, cursor);
    if (size === cursor.offset) return false;
    const handle = await fsp.open(file, 'r');
    let text: string;
    try {
      const buffer = Buffer.alloc(size - cursor.offset);
      await handle.read(buffer, 0, buffer.length, cursor.offset);
      text = buffer.toString('utf8');
      cursor.offset = size;
    } finally {
      await handle.close();
    }
    const combined = cursor.pending + text;
    const lines = combined.split('\n');
    // An incomplete final line waits for the next refresh.
    cursor.pending = lines.pop() ?? '';
    let changed = false;
    const list = this.events.get(segment) ?? [];
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > SPEND_LINE_MAX_BYTES) { this.quarantinedLines += 1; continue; }
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { this.quarantinedLines += 1; continue; }
      const event = validateSpendEvent(parsed);
      if (!event) {
        if (parsed && typeof parsed === 'object' && (parsed as { schemaVersion?: unknown }).schemaVersion !== 1) {
          this.unsupportedLines += 1;
        } else {
          this.quarantinedLines += 1;
        }
        continue;
      }
      list.push({ segment, event });
      changed = true;
    }
    this.events.set(segment, list);
    return changed;
  }

  private async readJson(file: string): Promise<{ state: 'missing' | 'invalid' | 'unsupported' | 'ok'; control?: SpendControlV1 }> {
    let text: string;
    try { text = await fsp.readFile(file, 'utf8'); } catch { return { state: 'missing' }; }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return { state: 'invalid' }; }
    const control = validateSpendControl(parsed);
    if (control) return { state: 'ok', control };
    const version = parsed && typeof parsed === 'object' ? (parsed as { schemaVersion?: unknown }).schemaVersion : undefined;
    return { state: typeof version === 'number' && version > 1 ? 'unsupported' : 'invalid' };
  }

  private revisionPath(revision: number): string {
    return path.join(this.controlDir, `${String(revision).padStart(12, '0')}.json`);
  }

  /** Control revision numbers present, newest first. */
  private async listRevisions(): Promise<number[]> {
    let names: string[] = [];
    try { names = await fsp.readdir(this.controlDir); } catch { return []; }
    const revisions: number[] = [];
    for (const name of names) {
      const match = REVISION_FILE.exec(name);
      if (match) revisions.push(Number(match[1]));
    }
    return revisions.sort((a, b) => b - a);
  }

  /**
   * The newest readable revision is the control. An unreadable newer one is skipped (the older revisions are the
   * backups); a revision from a newer schema stops the walk and fails closed.
   */
  private async readControl(): Promise<boolean> {
    for (let pass = 0; pass < 3; pass++) {
      const revisions = await this.listRevisions();
      let next = emptySpendControl();
      let state: ControlState = revisions.length === 0 ? 'missing' : 'corrupt';
      let unreadableSince: number | undefined;
      let vanished = false;
      for (const revision of revisions) {
        const file = this.revisionPath(revision);
        const read = await this.readJson(file);
        if (read.state === 'missing') { vanished = true; break; }
        if (read.state === 'unsupported') { state = 'unsupported'; break; }
        if (read.state === 'ok' && read.control!.revision === revision) {
          next = read.control!;
          state = revision === revisions[0] ? 'ok' : 'backup';
          break;
        }
        try {
          const modified = (await fsp.stat(file)).mtimeMs;
          unreadableSince = Math.max(unreadableSince ?? modified, modified);
        } catch { /* removed meanwhile */ }
      }
      // A listed revision was pruned before it could be read: this listing is out of date, so list again.
      if (vanished) continue;
      const changed = state !== this.controlState || next.revision !== this.control.revision
        || JSON.stringify(next) !== JSON.stringify(this.control);
      this.control = next;
      this.controlState = state;
      this.controlSlot = revisions[0] ?? 0;
      this.unreadableSince = unreadableSince;
      return changed;
    }
    return false;
  }

  // ─── Host heartbeats (open units of a gone window become coverage gaps) ───────────

  private async writeHeartbeat(): Promise<void> {
    if (this.disposed) return;
    const file = path.join(this.hostsDir, `${this.hostEpoch}.alive`);
    const stamp = new Date(this.now());
    try {
      await fsp.writeFile(file, stamp.toISOString());
      await fsp.utimes(file, stamp, stamp);
    } catch (error) {
      this.log(`Spend heartbeat skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async readHeartbeats(): Promise<boolean> {
    let names: string[] = [];
    try { names = await fsp.readdir(this.hostsDir); } catch { names = []; }
    const live = new Set<string>([this.hostEpoch]);
    for (const name of names) {
      if (!name.endsWith('.alive')) continue;
      try {
        const stat = await fsp.stat(path.join(this.hostsDir, name));
        if (this.now() - stat.mtimeMs < this.heartbeatLeaseMs) live.add(name.slice(0, -'.alive'.length));
      } catch { /* a heartbeat removed between list and stat is a closed window */ }
    }
    const changed = live.size !== this.liveHosts.size || [...live].some((host) => !this.liveHosts.has(host));
    this.liveHosts = live;
    return changed;
  }

  // ─── Maintenance lock and control transactions ────────────────────────────────

  /**
   * Run one control transaction under `maintenance.lock`. `fn` receives the current control (re-read under the
   * lock) and returns the next control, or undefined to write nothing. The next control is published as the
   * revision after the newest one present, by exclusive create: if any window published that revision first, this
   * transaction fails with `SpendLockBusyError` and writes nothing, so a late holder can never replace newer control.
   */
  async transact<T>(fn: (control: SpendControlV1, snapshot: SpendStoreSnapshot) => { next?: SpendControlV1; result: T }): Promise<T> {
    if (this.controlState === 'unsupported') throw new Error(NEWER_SCHEMA);
    const nonce = await this.acquireLock();
    const renew = setInterval(() => { void this.renewLock(nonce).catch(() => undefined); }, this.renewMs);
    (renew as { unref?: () => void }).unref?.();
    try {
      await this.refreshUnderLock();
      this.assertWritable('transact');
      const { next, result } = fn(this.control, this.snapshot());
      if (next) {
        const committed: SpendControlV1 = { ...next, schemaVersion: 1, revision: this.controlSlot + 1 };
        if (!validateSpendControl(committed)) throw new Error('Refusing to write an invalid spend control file.');
        await this.commitControl(committed, nonce);
        this.adoptControl(committed);
        await this.pruneRevisions(committed.revision);
        this.emit();
      }
      return result;
    } finally {
      clearInterval(renew);
      await this.releaseLock(nonce);
    }
  }

  /** A refresh that started before the lock was taken may have read older control; read again. */
  private async refreshUnderLock(): Promise<void> {
    while (this.refreshing) await this.refreshing.catch(() => undefined);
    await this.refresh();
  }

  /**
   * Checked after the re-read under the lock: an older UnodeAi never writes over a newer one's control or builds on
   * events it cannot read, and a transaction never silently replaces unreadable control (Repair does that).
   */
  private assertWritable(purpose: 'transact' | 'repair'): void {
    if (this.controlState === 'unsupported' || this.unsupportedLines > 0) {
      throw new Error(purpose === 'repair' ? 'Spend tracking was written by a newer UnodeAi. Update UnodeAi instead of repairing it.' : NEWER_SCHEMA);
    }
    if (purpose === 'transact' && this.controlState === 'corrupt') {
      throw new Error('The spend-tracking control file is unreadable. Run Repair spend tracking; work is not affected.');
    }
    if (this.unreadableSince !== undefined && this.now() - this.unreadableSince < CONTROL_IN_FLIGHT_MS) {
      // The newest revision may still be being written on a file system without hard links: retry shortly.
      throw new SpendLockBusyError();
    }
  }

  private adoptControl(committed: SpendControlV1): void {
    this.control = committed;
    this.controlState = 'ok';
    this.controlSlot = committed.revision;
    this.unreadableSince = undefined;
  }

  private async readOwner(dir: string): Promise<{ nonce: string; acquiredAt: number } | undefined> {
    try {
      const owner = JSON.parse(await fsp.readFile(path.join(dir, 'owner.json'), 'utf8')) as { nonce?: unknown; acquiredAt?: unknown };
      if (typeof owner.nonce !== 'string') return undefined;
      return { nonce: owner.nonce, acquiredAt: typeof owner.acquiredAt === 'string' ? Date.parse(owner.acquiredAt) : Number.NaN };
    } catch {
      return undefined;
    }
  }

  private async acquireLock(): Promise<string> {
    const nonce = this.randomId();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await fsp.mkdir(this.lockDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const status = await this.lockStatus();
        if (status.held) throw new SpendLockBusyError();
        await this.quarantineLock(status);
        continue;
      }
      try {
        // Written once, never rewritten: renewals and release only create files named by this nonce.
        await fsp.writeFile(path.join(this.lockDir, 'owner.json'),
          JSON.stringify({ nonce, hostEpoch: this.hostEpoch, acquiredAt: new Date(this.now()).toISOString() }), { flag: 'wx' });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Another window moved our new directory aside and took the lock first.
        if (code === 'EEXIST' || code === 'ENOENT') throw new SpendLockBusyError();
        throw error;
      }
      return nonce;
    }
    throw new SpendLockBusyError();
  }

  /**
   * Whether the lock is held: released when its owner's `released-<nonce>` exists, otherwise live for one lease
   * after acquisition or the owner's latest `beat-<nonce>`. A reused process id cannot keep it alive.
   */
  private async lockStatus(): Promise<{ held: boolean; nonce?: string; released?: boolean }> {
    const owner = await this.readOwner(this.lockDir);
    if (!owner) {
      // No owner record: judge the directory by its own age, so a crash between mkdir and write recovers too.
      try {
        return { held: this.now() - (await fsp.stat(this.lockDir)).mtimeMs < this.leaseMs };
      } catch {
        return { held: false };
      }
    }
    try {
      await fsp.stat(path.join(this.lockDir, `released-${owner.nonce}`));
      return { held: false, nonce: owner.nonce, released: true };
    } catch { /* not released */ }
    let heartbeat = Number.isFinite(owner.acquiredAt) ? owner.acquiredAt : Number.NEGATIVE_INFINITY;
    try {
      heartbeat = Math.max(heartbeat, (await fsp.stat(path.join(this.lockDir, `beat-${owner.nonce}`))).mtimeMs);
    } catch { /* not renewed yet */ }
    return { held: this.now() - heartbeat < this.leaseMs, nonce: owner.nonce };
  }

  /** Move a released or expired lock aside under a unique name, then remove it. */
  private async quarantineLock(status: { nonce?: string; released?: boolean }): Promise<void> {
    const quarantine = `${this.lockDir}.stale-${this.randomId()}`;
    try {
      await fsp.rename(this.lockDir, quarantine);
    } catch {
      return; // another window moved it first
    }
    const moved = await this.readOwner(quarantine);
    if (moved?.nonce !== status.nonce) {
      // Another window recovered and re-took the lock between our check and our rename. That holder now fails its
      // ownership check, and could not publish over a newer control revision in any case.
      this.log('Two windows recovered the spend-tracking maintenance lock at once; one of them retries.');
    } else if (!status.released) {
      this.log('A spend-tracking maintenance lock outlived its lease and was recovered.');
    }
    await fsp.rm(quarantine, { recursive: true, force: true }).catch(() => undefined);
  }

  private async ownsLock(nonce: string): Promise<boolean> {
    return (await this.readOwner(this.lockDir))?.nonce === nonce;
  }

  /** Touch this holder's own heartbeat file; a late renewal lands in a file no other holder reads. */
  private async renewLock(nonce: string): Promise<void> {
    if (!(await this.ownsLock(nonce))) return;
    const beat = path.join(this.lockDir, `beat-${nonce}`);
    const stamp = new Date(this.now());
    await fsp.writeFile(beat, stamp.toISOString());
    await fsp.utimes(beat, stamp, stamp);
  }

  /** Mark this holder's lock released. Nothing shared is removed or renamed; the next holder moves it aside. */
  private async releaseLock(nonce: string): Promise<void> {
    try {
      await fsp.writeFile(path.join(this.lockDir, `released-${nonce}`), '');
    } catch { /* already moved aside by another window */ }
  }

  private async writeDurably(file: string, text: string): Promise<void> {
    const handle = await fsp.open(file, 'wx');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Publish one control revision exactly once, whole: first writer wins, every later publish of it fails. */
  private async commitControl(control: SpendControlV1, nonce: string): Promise<void> {
    // A cheap early refusal. The exclusive publish below is what makes a late holder harmless.
    if (!(await this.ownsLock(nonce))) throw new SpendLockBusyError();
    await fsp.mkdir(this.controlDir, { recursive: true });
    const text = `${JSON.stringify(control, null, 2)}\n`;
    const target = this.revisionPath(control.revision);
    await this.options.beforeControlPublish?.();
    if (this.hardLinks) {
      const pending = path.join(this.controlDir, `.pending-${this.hostEpoch}-${this.randomId()}`);
      await this.writeDurably(pending, text);
      try {
        // link() never replaces an existing name, and readers only ever see the complete file.
        await fsp.link(pending, target);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (code === 'EEXIST') throw new SpendLockBusyError();
        if (!NO_HARD_LINKS.has(code)) throw error;
        this.hardLinks = false;
        this.log(`Spend tracking publishes control by exclusive create: this file system has no hard links (${code}).`);
      } finally {
        await fsp.rm(pending, { force: true }).catch(() => undefined);
      }
    }
    try {
      await this.writeDurably(target, text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SpendLockBusyError();
      throw error;
    }
  }

  /** Keep the newest revisions as backups; older ones can never be read as control again. */
  private async pruneRevisions(latest: number): Promise<void> {
    for (const revision of await this.listRevisions()) {
      if (revision > latest - CONTROL_REVISIONS_KEPT) continue;
      await fsp.rm(this.revisionPath(revision), { force: true }).catch(() => undefined);
    }
  }

  /** Remove moved-aside locks and unpublished control files a crashed window left behind. */
  private async sweepLeftovers(): Promise<void> {
    const old = async (file: string) => {
      try { return this.now() - (await fsp.stat(file)).mtimeMs >= this.leaseMs; } catch { return false; }
    };
    const lockName = path.basename(this.lockDir);
    for (const name of await fsp.readdir(this.options.root).catch(() => [] as string[])) {
      const file = path.join(this.options.root, name);
      if (name.startsWith(`${lockName}.`) && await old(file)) await fsp.rm(file, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const name of await fsp.readdir(this.controlDir).catch(() => [] as string[])) {
      const file = path.join(this.controlDir, name);
      if (name.startsWith('.pending-') && await old(file)) await fsp.rm(file, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Recorded Repair (design §6.3, §13.4): take the lock (recovering an expired one), rebuild from shards, publish
   * the last readable control (or an empty one) as a new revision with a repair record. Shard events are never
   * edited. Works when control is unreadable; refuses, under the lock, to build on a newer schema.
   */
  async repair(reason: string): Promise<void> {
    const nonce = await this.acquireLock();
    try {
      await this.refreshUnderLock();
      this.assertWritable('repair');
      const base = this.controlState === 'corrupt' ? emptySpendControl() : this.control;
      const committed: SpendControlV1 = {
        ...base,
        schemaVersion: 1,
        revision: this.controlSlot + 1,
        repairs: [...base.repairs, { repairId: `repair-${this.randomId()}`, repairedAt: new Date(this.now()).toISOString(), reason: reason.slice(0, 300) }],
      };
      await this.commitControl(committed, nonce);
      this.adoptControl(committed);
      await this.pruneRevisions(committed.revision);
    } finally {
      await this.releaseLock(nonce);
    }
    await this.sweepLeftovers();
    await this.exclusive(async () => {
      this.quarantinedLines = 0;
      this.unsupportedLines = 0;
      this.events.clear();
      this.cursors.clear();
    });
    await this.refresh();
    this.emit();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.watcher?.close();
    this.listeners.clear();
    try { await this.chain; } catch { /* already reported */ }
    // A closed window's open units are recovered by the next window at once.
    try { await fsp.rm(path.join(this.hostsDir, `${this.hostEpoch}.alive`), { force: true }); } catch { /* best effort */ }
  }
}

/** What the coordinator needs from durable storage; a folderless window uses the in-memory form. */
export interface SpendLedger {
  readonly hostEpoch: string;
  /** False for a folderless window: per-request display and reminders only, no project-period totals. */
  readonly projectBacked: boolean;
  append(payload: SpendEventPayload, eventId: string): Promise<StoredSpendEvent>;
  snapshot(): SpendStoreSnapshot;
  refresh(): Promise<boolean>;
  onDidChange(listener: () => void): () => void;
  transact<T>(fn: (control: SpendControlV1, snapshot: SpendStoreSnapshot) => { next?: SpendControlV1; result: T }): Promise<T>;
  repair(reason: string): Promise<void>;
  dispose(): Promise<void>;
}

export class FileSpendLedger extends SpendStore implements SpendLedger {
  readonly projectBacked = true;
}

/** A folderless window keeps request usage in memory only and writes no project ledger (design §13.4). */
export class MemorySpendLedger implements SpendLedger {
  readonly hostEpoch: string;
  readonly projectBacked = false;
  private readonly events: StoredSpendEvent[] = [];
  private control: SpendControlV1 = emptySpendControl();
  private sequence = 0;
  private listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now, hostEpoch: string = randomUUID()) {
    this.hostEpoch = hostEpoch;
  }

  async append(payload: SpendEventPayload, eventId: string): Promise<StoredSpendEvent> {
    const event = {
      schemaVersion: 1 as const, eventId, hostEpoch: this.hostEpoch, sequence: ++this.sequence,
      recordedAt: new Date(this.now()).toISOString(), ...payload,
    } as SpendEventV1;
    if (!validateSpendEvent(event)) throw new SpendEventRejectedError(`Refusing to record an invalid spend event (${payload.kind}).`);
    const stored = { segment: `${this.hostEpoch}-0`, event };
    this.events.push(stored);
    return stored;
  }

  snapshot(): SpendStoreSnapshot {
    return { events: this.events, control: this.control, controlState: 'ok', quarantinedLines: 0, unsupportedLines: 0, liveHosts: new Set([this.hostEpoch]) };
  }

  async refresh(): Promise<boolean> { return false; }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async transact<T>(fn: (control: SpendControlV1, snapshot: SpendStoreSnapshot) => { next?: SpendControlV1; result: T }): Promise<T> {
    const { next, result } = fn(this.control, this.snapshot());
    if (next) {
      this.control = { ...next, schemaVersion: 1, revision: this.control.revision + 1 };
      for (const listener of [...this.listeners]) listener();
    }
    return result;
  }

  async repair(): Promise<void> { /* nothing durable to repair */ }

  async dispose(): Promise<void> { this.listeners.clear(); }
}
