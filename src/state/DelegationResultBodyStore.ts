import * as fs from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { BigIntStats } from 'node:fs';
import { RESULT_MAILBOX_LIMITS } from './DelegationResultMailbox';

type BodyIo = Pick<typeof fs, 'lstat' | 'realpath' | 'opendir' | 'mkdir' | 'open' | 'link' | 'unlink'>;
export type ResultBodyStorageReason = 'storage-unavailable' | 'unsafe-path' | 'path-check-limit' | 'safe-publish-unavailable'
  | 'capacity' | 'conflict' | 'invalid-body' | 'reservation-required' | 'storage-error';
const MESSAGES: Record<ResultBodyStorageReason, string> = {
  'storage-unavailable': 'Result storage is unavailable. Open a physical workspace with private extension storage.',
  'unsafe-path': 'Private result recovery storage contains a link or unsupported file. Work can continue in the conversation.',
  'path-check-limit': 'Private result recovery storage could not be checked. Work can continue in the conversation.',
  'safe-publish-unavailable': 'This storage does not support safe result recovery files. Work can continue in the conversation.',
  capacity: 'Result recovery storage is full. Work can continue in the conversation; existing results have not been deleted.',
  conflict: 'An existing result has different bytes. Existing data was not replaced; the result was not acknowledged.',
  'invalid-body': 'The bounded result body is invalid. The result was not acknowledged.',
  'reservation-required': 'This result has no current capacity reservation. The result was not acknowledged.',
  'storage-error': 'The result could not be safely stored or read back. Recovery data was not acknowledged.',
};
export class ResultBodyStorageError extends Error {
  constructor(readonly reason: ResultBodyStorageReason) { super(MESSAGES[reason]); }
}
export interface ResultBodyFileRef { key: string; bytes: number; sha256: string }
/** Existing archive/ledger authority, supplied only by the host recovery consumer, never a tool/model.
 * assertClosed checks the exact archived result, released active index and current owner/lease.
 * The host's archived + decided/closed lifecycle authorizes reclamation, including within one process.
 * Optional readRecoveredBody additionally checks an available conversation copy; rolled-out journal text
 * and the editor's process identity are not prerequisites for freeing an archived result.
 */
export interface RecoveredResultArchive {
  assertClosed(ref: Readonly<ResultBodyFileRef>): void;
  readRecoveredBody?(ref: Readonly<ResultBodyFileRef>): Promise<string | undefined>;
}
export interface ResultBodyUsage { physicalSlots: number; physicalBytes: number; reservedSlots: number; reservedBytes: number }
export interface ResultBodyStoreOptions {
  storageUri: { scheme: string; fsPath: string } | undefined;
  /** Existing physical workspace identity, not an agent/model-supplied identifier. */
  workspaceId: string;
  /** Existing owner lease/workspace/trust/activation boundary. A key also requires that exact current
   * ledger completion, not merely a still-existing agent. Throw when stale; no identity is minted here. */
  assertCurrent(key?: string): void;
  /** Only the existing mailbox kernel's live reservation keys. Never settled body counts. */
  reservations(): readonly string[];
  /** Test I/O seam, never exposed to a model/tool. */
  io?: BodyIo;
}
const HEX = /^[a-f0-9]{64}$/;
const BODY = /^([a-f0-9]{64})\.body$/;
const STAGE = /^[a-f0-9]{64}\.stage$/;
const sameNode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const code = (error: unknown) => (error as { code?: string } | undefined)?.code;
const fail = (reason: ResultBodyStorageReason): never => { throw new ResultBodyStorageError(reason); };

/** Private body-file adapter only, NOT a second ledger, owner lease, index or archive authority.
 * No production constructor/caller is installed by this slice. Every mutation is serialized locally and
 * rechecks the supplied existing lease. Physical leftovers remain charged, even without an index entry.
 * Path checks detect substitution; they are not an OS sandbox against concurrent hostile filesystem edits. */
export class DelegationResultBodyStore {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly issuedStages = new Set<string>();
  private activeWriteKey?: string;
  private publishChecked = false;
  private readonly files = new Map<string, BigIntStats>();
  private physicalSlots = 0;
  private physicalBytes = 0;

  get readOnly(): boolean { return !this.publishChecked; }
  private constructor(private readonly options: ResultBodyStoreOptions, private readonly io: BodyIo,
    private readonly root: string, private readonly staging: string, private readonly bound: BigIntStats,
    private readonly openedAt: number) {}

  static async open(options: ResultBodyStoreOptions): Promise<DelegationResultBodyStore> {
    const io = options.io ?? fs;
    return safe(async () => {
      options.assertCurrent();
      const base = options.storageUri;
      if (!base) return fail('storage-unavailable');
      if (base.scheme !== 'file' || !path.isAbsolute(base.fsPath) || !HEX.test(options.workspaceId)) fail('storage-unavailable');
      // VS Code owns the base and its ancestors. Canonicalize once, accepting redirected AppData/home.
      let storage: string;
      try { storage = await io.realpath(path.resolve(base.fsPath)); }
      catch { return fail('storage-unavailable'); }
      const check = () => options.assertCurrent();
      const parent = path.join(storage, 'delegation-results-v1');
      const root = path.join(parent, options.workspaceId); const staging = path.join(root, 'staging');
      for (const folder of [parent, root, staging]) {
        check(); try { await io.mkdir(folder, { mode: 0o700 }); } catch (error) { if (code(error) !== 'EEXIST') throw error; }
        check(); await plainPath(io, folder, true, check);
      }
      const bound = await io.lstat(root, { bigint: true }); check();
      if (bound.ino === 0n) fail('storage-unavailable');
      const store = new DelegationResultBodyStore(options, io, root, staging, bound, Date.now());
      // Full storage must remain readable/recoverable. A capability probe itself costs one byte/slot;
      // never exceed the existing quota merely to diagnose a full backing directory.
      await store.rebuildUsage();
      const usage = store.measure();
      if (usage.physicalSlots + usage.reservedSlots < RESULT_MAILBOX_LIMITS.slots
        && usage.physicalBytes + usage.reservedBytes < RESULT_MAILBOX_LIMITS.totalBytes) await store.probePublish();
      return store;
    });
  }

  /** Content-free physical usage; an unindexed file is not permission to ignore its quota. */
  usage(): Promise<ResultBodyUsage> { return this.run(async () => this.measure()); }

  /** Check immediately before the existing kernel's synchronous reserve under the host admission lane. */
  checkAdmission(): Promise<void> {
    return this.run(async () => {
      const usage = this.measure(); requireRoom(usage, 1, RESULT_MAILBOX_LIMITS.bodyBytes);
      if (!this.publishChecked) await this.probePublish();
    });
  }

  write(key: string, text: string): Promise<ResultBodyFileRef> {
    return this.run(async () => {
      this.assert(); if (!HEX.test(key) || typeof text !== 'string') fail('invalid-body');
      this.options.assertCurrent(key);
      if (Buffer.byteLength(text, 'utf8') > RESULT_MAILBOX_LIMITS.bodyBytes) fail('invalid-body');
      const bytes = Buffer.from(text, 'utf8'); if (bytes.toString('utf8') !== text) fail('invalid-body');
      const ref = { key, bytes: bytes.length, sha256: sha(bytes) }; const final = this.bodyPath(key);
      const existing = await this.maybeRead(final);
      if (existing) {
        if (!existing.equals(bytes)) fail('conflict');
        // A previous link may have succeeded before its directory sync failed. Retry that sync too.
        await this.syncDirectory(this.root); this.options.assertCurrent(key); return ref;
      }
      const reserved = this.reservations(); if (!reserved.includes(key)) fail('reservation-required');
      const usage = this.measure();
      // Replace this attempt's reservation, not another attempt's, with its actual physical bytes.
      requireRoom(usage, 0, bytes.length - RESULT_MAILBOX_LIMITS.bodyBytes);
      if (!this.reservations().includes(key)) fail('reservation-required');
      if (!this.publishChecked) fail('storage-unavailable'); // Optional recovery only; never refuse task dispatch.
      this.options.assertCurrent(key);
      const stage = path.join(this.staging, `${randomBytes(32).toString('hex')}.stage`);
      const handle = await this.io.open(stage, 'wx', 0o600);
      this.issuedStages.add(stage);
      try { this.assert(); await handle.writeFile(bytes); this.assert(); await handle.sync(); this.assert(); }
      finally { await handle.close(); await this.remember(stage); }
      // A failure keeps this exact staging file charged: never delete the sole unverified copy.
      const staged = await this.readFile(stage); if (!staged.equals(bytes)) fail('storage-error');
      try {
        await this.io.link(stage, final);
        await this.syncDirectory(this.root);
      } catch (error) {
        this.assert();
        if (code(error) !== 'EEXIST') fail(publishUnsupported(error) ? 'safe-publish-unavailable' : 'storage-error');
      } finally { await this.remember(stage); await this.remember(final); }
      this.assert(); const published = await this.readFile(final);
      if (!published.equals(bytes)) fail('conflict');
      // Only this operation's verified staging name is removed; the immutable final body stays.
      await this.io.unlink(stage); this.forget(stage); this.assert();
      this.issuedStages.delete(stage);
      this.options.assertCurrent(key);
      return ref;
    }, key);
  }

  read(ref: ResultBodyFileRef): Promise<string> {
    return this.run(async () => {
      if (!validRef(ref)) fail('invalid-body');
      const bytes = await this.readFile(this.bodyPath(ref.key));
      if (bytes.length !== ref.bytes || sha(bytes) !== ref.sha256) fail('conflict');
      const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) fail('invalid-body');
      return text;
    });
  }

  /** Reclaim ONE proven archived body, not an eviction policy. Unknown/orphan/undecided files stay charged.
   * The consumer must supply the qualified existing archive authority above; this adapter creates no ledger,
   * archive copy, cleanup queue, timer or durability receipt. Optional recovery failure never refuses tasks. */
  reclaimArchived(ref: ResultBodyFileRef, archive: RecoveredResultArchive): Promise<boolean> {
    const captured = { ...ref };
    return this.run(async () => {
      if (!validRef(captured)) fail('invalid-body');
      const exact = Object.freeze({ ...captured });
      archive.assertClosed(exact);
      const target = this.bodyPath(captured.key);
      const bytes = await this.maybeRead(target);
      if (!bytes) return false;
      if (bytes.length !== captured.bytes || sha(bytes) !== captured.sha256) fail('conflict');
      if (archive.readRecoveredBody) {
        const archived = await archive.readRecoveredBody(exact);
        this.assert();
        if (typeof archived !== 'string' || Buffer.byteLength(archived, 'utf8') !== captured.bytes
          || sha(Buffer.from(archived, 'utf8')) !== captured.sha256) return false;
      }
      // Re-observe the exact generated file after the awaited archive read, not a stale path/PID-style identity.
      const current = await this.readFile(target);
      if (!current.equals(bytes)) fail('conflict');
      this.assert(); archive.assertClosed(exact);
      try { await this.io.unlink(target); }
      finally { await this.remember(target); }
      await this.syncDirectory(this.root); this.assert();
      return true;
    });
  }

  /** Lease-held recovery removes only old strict staging names. No final body deletion here: Memento ack
   * or extension-host restart is not a qualified durable archive receipt. Orphan finals stay charged. */
  recoverStaging(): Promise<number> {
    return this.run(async () => {
      await this.rebuildUsage(); let removed = 0;
      const directory = await this.io.opendir(this.staging);
      for await (const entry of directory) {
        this.assert(); if (!STAGE.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) fail('unsafe-path');
        const target = path.join(this.staging, entry.name);
        const before = await plainPath(this.io, target, false, () => this.assert());
        // Clock skew/mtime granularity must not turn this activation's failed write into old staging.
        if (this.issuedStages.has(target) || Number(before.mtimeMs) >= this.openedAt) continue;
        const now = await this.io.lstat(target, { bigint: true }); this.assert();
        if (!sameNode(before, now) || now.size !== before.size || now.mtimeNs !== before.mtimeNs) fail('unsafe-path');
        await this.io.unlink(target); this.forget(target); this.assert(); removed++;
      }
      return removed;
    });
  }

  private bodyPath(key: string): string { if (!HEX.test(key)) fail('invalid-body'); return path.join(this.root, `${key}.body`); }
  private assert(): void { this.options.assertCurrent(this.activeWriteKey); }
  private reservations(): string[] {
    this.assert(); const keys = [...this.options.reservations()];
    if (keys.length > RESULT_MAILBOX_LIMITS.slots || new Set(keys).size !== keys.length || keys.some(key => !HEX.test(key))) fail('storage-error');
    return keys;
  }
  private run<T>(operation: () => Promise<T>, writeKey?: string): Promise<T> {
    const result = this.tail.then(() => safe(async () => {
      this.activeWriteKey = writeKey;
      try { this.assert(); await this.checkRoot(); return await operation(); }
      finally { this.activeWriteKey = undefined; }
    }));
    this.tail = result.catch(() => undefined); return result;
  }
  private async checkRoot(): Promise<void> {
    this.assert(); await plainPath(this.io, path.dirname(this.root), true, () => this.assert());
    const now = await plainPath(this.io, this.root, true, () => this.assert());
    if (!sameNode(now, this.bound)) fail('unsafe-path');
    await plainPath(this.io, this.staging, true, () => this.assert()); this.assert();
  }
  private async readFile(target: string): Promise<Buffer> {
    const before = await plainPath(this.io, target, false, () => this.assert());
    if (before.ino === 0n) fail('unsafe-path');
    if (before.size > BigInt(RESULT_MAILBOX_LIMITS.bodyBytes)) fail('invalid-body');
    const handle = await this.io.open(target, 'r');
    try {
      this.assert(); const held = await handle.stat({ bigint: true }); this.assert();
      if (!held.isFile() || !sameNode(before, held) || held.size !== before.size) fail('unsafe-path');
      // Fixed-size read: a file growing after stat cannot cause an unbounded readFile allocation.
      const bytes = Buffer.alloc(Number(held.size) + 1); let used = 0;
      while (used < bytes.length) { const read = await handle.read(bytes, used, bytes.length - used, used); this.assert(); if (!read.bytesRead) break; used += read.bytesRead; }
      const after = await handle.stat({ bigint: true }); this.assert();
      if (!sameNode(held, after) || held.size !== after.size || held.mtimeNs !== after.mtimeNs || used !== Number(held.size)) fail('unsafe-path');
      const named = await plainPath(this.io, target, false, () => this.assert());
      if (!sameNode(named, after) || named.size !== after.size || named.mtimeNs !== after.mtimeNs) fail('unsafe-path');
      return bytes.subarray(0, used);
    } finally { await handle.close(); }
  }
  private async maybeRead(target: string): Promise<Buffer | undefined> {
    // Only absence at the named final is idempotent miss. A missing/substituted root is never a miss.
    try { await this.io.lstat(target); } catch (error) { if (code(error) === 'ENOENT') return undefined; throw error; }
    return this.readFile(target);
  }
  private measure(): ResultBodyUsage {
    const reservedSlots = this.reservations().length;
    return { physicalSlots: this.physicalSlots, physicalBytes: this.physicalBytes,
      reservedSlots, reservedBytes: reservedSlots * RESULT_MAILBOX_LIMITS.bodyBytes };
  }
  /** Only open/recovery inventory our own flat subtree. Never enumerate the storage base or its ancestors. */
  private async rebuildUsage(): Promise<void> {
    this.files.clear();
    for (const folder of [this.root, this.staging]) {
      const directory = await this.io.opendir(folder);
      for await (const entry of directory) {
        this.assert();
        if (folder === this.root && entry.name === 'staging' && entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (!(folder === this.root ? BODY.test(entry.name) : STAGE.test(entry.name)) || !entry.isFile() || entry.isSymbolicLink()) fail('unsafe-path');
        await this.remember(path.join(folder, entry.name));
      }
    }
    this.recount();
  }
  private async remember(target: string): Promise<void> {
    let stat: BigIntStats;
    try { stat = await this.io.lstat(target, { bigint: true }); }
    catch (error) { if (code(error) === 'ENOENT') { this.forget(target); return; } throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.ino === 0n) fail('unsafe-path');
    if (stat.size > BigInt(RESULT_MAILBOX_LIMITS.bodyBytes)) fail('invalid-body');
    this.files.set(target, stat); this.recount();
  }
  private forget(target: string): void { this.files.delete(target); this.recount(); }
  /** Arithmetic over cached metadata only; no filesystem scan on write/admission/usage. */
  private recount(): void {
    const finals = new Set([...this.files].filter(([name]) => path.dirname(name) === this.root)
      .map(([, stat]) => `${stat.dev}:${stat.ino}`));
    this.physicalSlots = 0; this.physicalBytes = 0;
    for (const [name, stat] of this.files) {
      if (path.dirname(name) === this.staging && stat.nlink === 2n && finals.has(`${stat.dev}:${stat.ino}`)) continue;
      this.physicalSlots++; this.physicalBytes += Number(stat.size);
    }
  }
  private async syncDirectory(folder: string): Promise<void> {
    let handle: fs.FileHandle | undefined;
    try { handle = await this.io.open(folder, 'r'); await handle.sync(); }
    catch (error) {
      // Directory fsync is unavailable on some platforms (notably Windows); real IO failures still matter.
      if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', ...(process.platform === 'win32' ? ['EPERM', 'EACCES'] : [])].includes(code(error) ?? '')) throw error;
    } finally { await handle?.close(); }
  }
  private async probePublish(): Promise<void> {
    const first = path.join(this.staging, `${randomBytes(32).toString('hex')}.stage`);
    const second = path.join(this.staging, `${randomBytes(32).toString('hex')}.stage`);
    const handle = await this.io.open(first, 'wx', 0o600);
    this.issuedStages.add(first);
    try { this.assert(); await handle.writeFile('a'); this.assert(); await handle.sync(); this.assert(); } finally { await handle.close(); await this.remember(first); }
    try { await this.io.link(first, second); }
    catch { fail('safe-publish-unavailable'); } // Retain exact staging file for lease-held recovery.
    this.assert();
    this.issuedStages.add(second);
    let refused = false;
    try { await this.io.link(first, second); } catch (error) { if (code(error) === 'EEXIST') refused = true; else throw error; }
    if (!refused || (await this.readFile(second)).toString() !== 'a') fail('safe-publish-unavailable');
    await this.io.unlink(second); this.forget(second); this.assert(); await this.io.unlink(first); this.forget(first); this.assert();
    this.issuedStages.delete(first); this.issuedStages.delete(second);
    this.publishChecked = true;
  }
}

/** Inspect only an owned subtree entry. The supplied base is canonicalized once, not rejected for ancestor links. */
async function plainPath(io: BodyIo, target: string, directory: boolean, check: () => void): Promise<BigIntStats> {
  check();
  const absolute = path.resolve(target);
  const stat = await io.lstat(absolute, { bigint: true }); check();
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail('unsafe-path');
  const real = await io.realpath(absolute); check();
  if (process.platform === 'win32' ? real.toLowerCase() !== absolute.toLowerCase() : real !== absolute) fail('unsafe-path');
  return stat;
}
function validRef(ref: ResultBodyFileRef): boolean {
  return !!ref && HEX.test(ref.key) && HEX.test(ref.sha256) && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && ref.bytes <= RESULT_MAILBOX_LIMITS.bodyBytes;
}
function requireRoom(usage: ResultBodyUsage, slots: number, bytes: number): void {
  if (usage.physicalSlots + usage.reservedSlots + slots > RESULT_MAILBOX_LIMITS.slots
    || usage.physicalBytes + usage.reservedBytes + bytes > RESULT_MAILBOX_LIMITS.totalBytes) fail('capacity');
}
function publishUnsupported(error: unknown): boolean { return ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EPERM'].includes(code(error) ?? ''); }
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { if (error instanceof ResultBodyStorageError) throw error; throw new ResultBodyStorageError('storage-error'); }
}
