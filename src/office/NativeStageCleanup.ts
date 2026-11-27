import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { captureRasterFile } from './RasterFileCapture';
import { hostReadMemoryBudget } from '../content/ContentAssetStore';

interface Identity { dev: string; ino: string }
export interface NativeStageLease extends Identity { path: string; token: string }
/** What a stage still waits for after its native helper started: the helper's receipt in the ledger. */
export interface NativeStageWait { operation_id: string; receipt: string; helper_pid?: number }
/** Facts the host observed itself when the helper process ended (its validated final answer). */
export interface NativeHelperExit { stage_released: boolean }
interface Record extends NativeStageLease { owner: number; files: Array<[string, string]>; directories: Array<{ name: string } & Identity>; native?: NativeStageWait }
interface Receipt {
  version: 1; operation_id: string; host_pid: number; helper_pid: number; phase: string; process_name?: string;
  native_pid?: number; loader_pid?: number; children?: Array<{ pid: number }>; children_complete?: boolean;
}
const marker = '.unode-owned-stage';
/** Directories the host creates (or the helper creates in a fixed place) that only the native stage writes into. */
const PRODUCER_DIRECTORIES = ['tmp', 'helper-home', 'libreoffice-profile', 'native', 'pages'];
/** Native operations that stage through this lease: Office page rendering and workbook recalculation. */
const OPERATION = /^(?:office-render|workbook-recalc)-[a-zA-Z0-9-]+$/;
const RECEIPT_LIMIT = 16 * 1024;
const identity = async (path: string): Promise<Identity> => { const stat = await lstat(path, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('not-owned-directory'); return { dev: String(stat.dev), ino: String(stat.ino) }; };
const equal = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
/** A ledger record replaced while another process reads it: retried, at most this many renames (about 0.45 s of waits). */
const PERSIST_RENAME_ATTEMPTS = 10;
const RENAME_BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Only completed native operations, and started ones whose helper and native application are proven gone, are cleaned.
 * A started operation is cleaned only when its host, its helper and every native process its receipt names have
 * exited, or the helper's own final receipt says it released the stage. A missing or malformed receipt is never read
 * as "not started": the stage stays. Legacy prefix-only dirs are never swept.
 */
export class NativeStageCleanup {
  private readonly records = new Map<string, Record>();
  private readonly waiting = new Map<string, Record>();
  constructor(private readonly ledger?: string, private readonly ownerRunning = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }) {}
  async create(path: string): Promise<NativeStageLease> {
    const lease = { path, ...await identity(path), token: randomUUID() };
    await writeFile(join(path, marker), lease.token, { flag: 'wx', mode: 0o600 }); return lease;
  }
  /** Where the helper of an operation writes its receipt: the ledger when there is one, else the stage's own scratch. */
  receiptPath(operationId: string, stage: string): string {
    if (!OPERATION.test(operationId)) throw Error('invalid-operation');
    return this.ledger ? join(this.ledger, operationId + '.owner.json') : join(stage, 'tmp', 'owner-receipt.json');
  }
  private filename(token: string) { return join(this.ledger!, token + '.json'); }
  private pendingFile(token: string) { return join(this.ledger!, token + '.pending.json'); }
  private claimFile(token: string, owner = process.pid) { return join(this.ledger!, token + '.claimed-' + owner + '.json'); }
  private async persist(name: (token: string) => string, record: Record): Promise<void> {
    if (!this.ledger) return;
    let leftover: string | undefined;
    try {
      const file = name.call(this, record.token); const staged = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
      await mkdir(this.ledger, { recursive: true }); leftover = staged;
      await writeFile(staged, JSON.stringify(record), { mode: 0o600 });
      // Windows refuses a rename over a record another reader (a sweep of another window) has open at that moment.
      // The record is replaced whole once the reader closes; after a bounded wait the update is given up as before.
      for (let attempt = 1; ; attempt++) {
        try { await rename(staged, file); leftover = undefined; return; } catch (error) {
          if (attempt >= PERSIST_RENAME_ATTEMPTS || !RENAME_BUSY.has((error as NodeJS.ErrnoException)?.code ?? '')) throw error;
          await new Promise(resolve => setTimeout(resolve, 10 * attempt));
        }
      }
    } catch { /* Cleanup still works in this process when persistence is unavailable. */ } finally {
      if (leftover) await unlink(leftover).catch(() => {});
    }
  }
  private async identities(lease: NativeStageLease, names: readonly string[], known: Record['directories'] = []): Promise<Record['directories']> {
    const result: Record['directories'] = [];
    for (const name of names) {
      const prior = known.find(entry => entry.name === name);
      if (prior) { result.push(prior); continue; }
      try { result.push({ name, ...await identity(join(lease.path, name)) }); } catch { /* Absent or replaced producer dirs are not claimed. */ }
    }
    return result;
  }
  private files(lease: NativeStageLease, files: ReadonlyMap<string, string>): Array<[string, string]> {
    return [...files].map(([path, hash]) => [relative(lease.path, path), hash]);
  }
  async complete(lease: NativeStageLease, files: ReadonlyMap<string, string>, directories: string[]): Promise<boolean> {
    const record: Record = { ...lease, owner: process.pid, files: this.files(lease, files), directories: await this.identities(lease, directories) };
    this.records.set(record.token, record);
    await this.persist(this.filename, record);
    if (this.waiting.delete(record.token) && this.ledger) await unlink(this.pendingFile(record.token)).catch(() => {});
    return this.clean(record);
  }
  /** Before a native helper starts: the stage is recorded as waiting for the helper and its application. */
  async defer(lease: NativeStageLease, files: ReadonlyMap<string, string>, directories: string[], wait: NativeStageWait): Promise<void> {
    if (!OPERATION.test(wait.operation_id)) throw Error('invalid-operation');
    const record: Record = { ...lease, owner: process.pid, files: this.files(lease, files), directories: await this.identities(lease, directories), native: { ...wait } };
    this.waiting.set(record.token, record); await this.persist(this.pendingFile, record);
  }
  /** The launched helper's process number; the live host is the only writer of its own pending record. */
  async noteHelper(token: string, helperPid: number): Promise<void> {
    const record = this.waiting.get(token); if (!record?.native || !pid(helperPid)) return;
    record.native.helper_pid = helperPid; await this.persist(this.pendingFile, record);
  }
  /**
   * After the helper ended (observed by this host): clean only when the helper's own validated answer released the
   * stage, or its receipt shows every named native process gone. Otherwise the stage stays for a later sweep.
   */
  async release(token: string, update: { files?: ReadonlyMap<string, string>; directories?: string[]; exit?: NativeHelperExit } = {}): Promise<boolean> {
    const record = this.waiting.get(token); if (!record) return false;
    if (update.files) record.files = this.files(record, update.files);
    if (update.directories) record.directories = await this.identities(record, update.directories, record.directories);
    await this.persist(this.pendingFile, record);
    if (!(update.exit?.stage_released === true || await this.nativeGone(record, true))) return false;
    return this.claimAndClean(this.ledger ? this.pendingFile(token) : undefined, record);
  }
  private async readReceipt(record: Record): Promise<Receipt | undefined> {
    const wait = record.native; if (!wait || !OPERATION.test(wait.operation_id)) return undefined;
    // Only the receipt this record names, at the one place this cleaner would have told the helper to write it.
    if (wait.receipt !== (this.ledger ? join(this.ledger, wait.operation_id + '.owner.json') : join(record.path, 'tmp', 'owner-receipt.json'))) return undefined;
    try {
      const stat = await lstat(wait.receipt); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RECEIPT_LIMIT) return undefined;
      const receipt = JSON.parse(await readFile(wait.receipt, 'utf8')) as Receipt;
      if (receipt?.version !== 1 || receipt.operation_id !== wait.operation_id || receipt.host_pid !== record.owner || !pid(receipt.helper_pid)
        || wait.helper_pid !== undefined && wait.helper_pid !== receipt.helper_pid || typeof receipt.phase !== 'string') return undefined;
      return receipt;
    } catch { return undefined; }
  }
  /** Host (unless it is this process), helper and every recorded native process have exited, by the receipt. */
  private async nativeGone(record: Record, hostIsSelf: boolean): Promise<boolean> {
    if (!hostIsSelf && (!pid(record.owner) || this.ownerRunning(record.owner))) return false;
    const receipt = await this.readReceipt(record); if (!receipt || this.ownerRunning(receipt.helper_pid)) return false;
    if (receipt.phase === 'closed' || receipt.phase === 'not-started') return true;
    if (receipt.process_name === 'soffice' && receipt.children_complete !== true) return false;
    const processes = [receipt.native_pid, receipt.loader_pid, ...(Array.isArray(receipt.children) ? receipt.children.map(child => child?.pid) : [])].filter(value => value !== undefined);
    // No named native process is not proof that none started.
    return processes.length > 0 && processes.every(pid) && processes.every(value => !this.ownerRunning(value as number));
  }
  private async claimAndClean(file: string | undefined, record: Record): Promise<boolean> {
    let claimed: string | undefined;
    if (file) {
      claimed = this.claimFile(record.token);
      // An atomic rename: of two sweeps only one moves the record; the other finds it gone and leaves it.
      try { await rename(file, claimed); } catch { return false; }
    }
    this.waiting.delete(record.token);
    if (!await this.clean(record, true)) { if (!file) this.waiting.set(record.token, record); return false; }
    if (record.native) await unlink(record.native.receipt).catch(() => {});
    if (claimed) await unlink(claimed).catch(() => {});
    return true;
  }
  private async validate(record: Record): Promise<void> {
    if (!/^unode-(?:native-render|recalc)-/.test(basename(record.path)) || dirname(record.path) !== await realpath(tmpdir()) || await realpath(record.path) !== record.path
      || !equal(await identity(record.path), record) || await readFile(join(record.path, marker), 'utf8') !== record.token) throw Error('owned-stage-changed');
  }
  private async tree(path: string): Promise<void> {
    if (await realpath(path) !== path) throw Error('redirected-stage');
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name); const stat = await lstat(child);
      if (stat.isSymbolicLink() || await realpath(child) !== child) throw Error('redirected-stage');
      if (stat.isDirectory()) await this.tree(child); else if (!stat.isFile()) throw Error('unknown-stage-entry');
    }
  }
  private async clean(record: Record, allowGone = false): Promise<boolean> {
    try {
      if (allowGone) try { await lstat(record.path); } catch (error) { if (missing(error)) return true; throw error; }
      await this.validate(record);
      for (const directory of record.directories) {
        if (!PRODUCER_DIRECTORIES.includes(directory.name)) throw Error('unknown-producer-directory');
        const path = join(record.path, directory.name);
        try { await lstat(path); } catch (error) { if (missing(error)) continue; throw error; }
        if (!equal(await identity(path), directory)) throw Error('producer-directory-changed');
        await this.tree(path); await this.validate(record);
        if (await realpath(path) !== path || !equal(await identity(path), directory)) throw Error('producer-directory-changed');
        // The absolute producer directory is inside the verified private stage; the walk rejects redirects.
        await rm(path, { recursive: true });
      }
      for (const [name, hash] of record.files) {
        if (!/^[a-zA-Z0-9_.-]+(?:[\\/][a-zA-Z0-9_.-]+)*$/.test(name) || name.split(/[\\/]/).some(part => part === '..' || part === '.') || resolve(record.path, name) !== join(record.path, name) || !/^[a-f0-9]{64}$/.test(hash)) throw Error('invalid-owned-file');
        const path = join(record.path, name);
        try { if (await realpath(path) === path && !(await lstat(path)).isSymbolicLink() && digest(await captureRasterFile(path, hostReadMemoryBudget())) === hash) await unlink(path); } catch { /* Keep changed or locked files. */ }
      }
      try { await rmdir(join(record.path, 'pages')); } catch { /* Nonempty unknown pages stay. */ }
      if ((await readdir(record.path)).some(name => name !== marker)) return false;
      await this.validate(record); await unlink(join(record.path, marker));
      try { await rmdir(record.path); } catch (error) { await writeFile(join(record.path, marker), record.token, { flag: 'wx', mode: 0o600 }).catch(() => {}); throw error; }
      this.records.delete(record.token); if (this.ledger) await unlink(this.filename(record.token)).catch(() => {}); return true;
    } catch { return false; }
  }
  async recover(): Promise<void> {
    if (!this.ledger) return;
    let names: string[]; try { names = await readdir(this.ledger); } catch { return; }
    for (const name of names) {
      const match = /^([a-f0-9-]{36})(?:\.(pending)|\.claimed-(\d+))?\.json$/.exec(name); if (!match) continue;
      try {
        const file = join(this.ledger, name); if ((await lstat(file)).isSymbolicLink()) continue;
        const record = JSON.parse(await readFile(file, 'utf8')) as Record;
        if (match[1] !== record.token || !pid(record.owner)) continue;
        if (match[2]) {
          // A started operation: its host, helper and named native processes must all be gone. Nothing is ended here.
          if (!record.native || !await this.nativeGone(record, false)) continue;
          await this.claimAndClean(file, record);
        } else if (match[3]) {
          // A claim whose claimant exited mid-cleanup is claimed again; a live claimant's record is left alone.
          const claimant = Number(match[3]);
          if (!pid(claimant) || claimant === process.pid || this.ownerRunning(claimant)) continue;
          await this.claimAndClean(file, record);
        } else {
          if (this.ownerRunning(record.owner)) continue;
          await this.clean(record);
        }
      } catch { /* Never infer ownership from a prefix or corrupt ledger. */ }
    }
  }
  /** Deactivation: retry finished stages; a started one is cleaned only if its helper and application are gone. */
  async dispose(): Promise<void> {
    for (const record of this.records.values()) await this.clean(record);
    for (const record of [...this.waiting.values()]) if (await this.nativeGone(record, true)) await this.claimAndClean(this.ledger ? this.pendingFile(record.token) : undefined, record);
  }
}
