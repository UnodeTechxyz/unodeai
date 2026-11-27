import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDocumentWorker, workerScript, CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES } from '../content/ContentAssetStore';
import type { CellPosition, PageBudget } from '../content/WorkbookPage';
import type { OfficeInventoryManifest } from './OfficeInventory';
import type { OfficeInventoryWorkerRequest } from './OfficeInventoryWorker';
import type { officeInventoryPage } from './OfficeInventoryPage';
import type { WordView } from './word/WordRevisionViews';

type Page = ReturnType<typeof officeInventoryPage>;
interface Snapshot { id: string; key: string; hash: string; bytes: number; root: string; directory: string; manifest: OfficeInventoryManifest; holder: object }
interface Cursor { snapshot: Snapshot; position: CellPosition; view: WordView }
/** Private host descriptor: the model-visible snapshot id supplies no file access by itself. */
export interface OfficeSnapshotSource { snapshotRef: string; physicalKey: string; sourceSha256: string; bytes: number;
  sourcePath: string; directory: string; manifest: OfficeInventoryManifest }
/** Per-agent immutable snapshots. Every continuation requires the source bytes and current host lease again. */
export class OfficeReader {
  private readonly cursors = new Map<string, Cursor>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly roots = new Set<string>();
  private readonly reads = new Set<Promise<unknown>>();
  private readonly jobs = new Set<AbortController>();
  private readonly lifetime = new AbortController();
  private disposed = false;
  private disposal?: Promise<void>;
  constructor(private readonly worker = workerScript('OfficeInventoryWorker.js')) {}

  /** A continuation keeps the view of the request that started it; a different explicit view is an invalid cursor. */
  read(key: string, bytes: Buffer, cursor: string | undefined, budget: PageBudget, holder: object, signal?: AbortSignal, current = () => true, view?: WordView): Promise<Page> {
    const pending = this.readInternal(key, bytes, cursor, budget, holder, signal, current, view);
    this.reads.add(pending); void pending.then(() => this.reads.delete(pending), () => this.reads.delete(pending)); return pending;
  }

  /** Uses immutable inspected bytes only after actual current host authority and holder checks. */
  withSnapshot<T>(snapshotRef: string, holder: object, authorize: (physicalKey: string, sourceSha256: string) => Promise<() => boolean>,
    work: (source: OfficeSnapshotSource, current: () => boolean, signal: AbortSignal) => Promise<T>, signal?: AbortSignal, current = () => true): Promise<T> {
    const pending = (async () => {
      const snapshot = this.snapshots.get(snapshotRef);
      if (this.disposed || !snapshot || snapshot.holder !== holder) throw new Error('snapshot-unavailable');
      const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
      if (combined.aborted || !current()) throw new Error('cancelled');
      const lease = await authorize(snapshot.key, snapshot.hash);
      const live = () => !this.disposed && !combined.aborted && current() && lease() && this.snapshots.get(snapshotRef) === snapshot;
      if (!live()) throw new Error('cancelled');
      const result = await work({ snapshotRef: snapshot.id, physicalKey: snapshot.key, sourceSha256: snapshot.hash, bytes: snapshot.bytes,
        sourcePath: join(snapshot.root, 'source'), directory: snapshot.directory, manifest: snapshot.manifest }, live, combined);
      if (!live()) throw new Error('cancelled'); return result;
    })();
    this.reads.add(pending); void pending.then(() => this.reads.delete(pending), () => this.reads.delete(pending)); return pending;
  }

  private async readInternal(key: string, bytes: Buffer, cursor: string | undefined, budget: PageBudget, holder: object, signal: AbortSignal | undefined, current: () => boolean, requested?: WordView): Promise<Page> {
    const live = () => !this.disposed && !signal?.aborted && current();
    if (!live()) throw new Error('cancelled');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const old = cursor ? this.cursors.get(cursor) : undefined;
    if (cursor && (!old || old.snapshot.key !== key || old.snapshot.holder !== holder || requested !== undefined && requested !== old.view)) throw new Error('invalid-cursor');
    const view = old?.view ?? requested ?? 'current';
    if (old && old.snapshot.hash !== hash) throw new Error('source-changed');
    let snapshot = old?.snapshot; let unpublished: string | undefined;
    try {
      if (!snapshot) {
        const root = await mkdtemp(join(tmpdir(), 'unode-office-inventory-')); this.roots.add(root); unpublished = root;
        const directory = join(root, 'parsed'); await mkdir(directory); const source = join(root, 'source'); await writeFile(source, bytes);
        const id = `office-${randomUUID()}`;
        const manifest = await this.job<OfficeInventoryManifest>(bytes.length, { operation: 'parse', source, directory, snapshot: id,
          expansionRatio: CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, expansionFloor: CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES }, signal, live);
        if (manifest.sha256 !== hash || manifest.schema_version !== 1 || !['docx', 'pptx'].includes(manifest.kind)
          || !Number.isSafeInteger(manifest.records) || manifest.records < 1) throw new Error('worker-failed');
        snapshot = { id, key, hash, bytes: bytes.length, root, directory, manifest, holder };
      }
      const next = `office-cursor-${randomUUID()}`;
      const page = await this.job<Page>(snapshot.bytes, { operation: 'page', directory: snapshot.directory, manifest: snapshot.manifest, snapshot: snapshot.id,
        start: old?.position ?? { row: 1, column: 1, byte: 0 }, cursor: next, budget, view }, signal, live);
      if (page.snapshot_ref !== snapshot.id || page.source_sha256 !== hash || !Array.isArray(page.prepared_fragments)) throw new Error('worker-failed');
      if (!live()) throw new Error('cancelled');
      if (page.remaining) this.cursors.set(next, { snapshot, position: page.remaining, view });
      this.snapshots.set(snapshot.id, snapshot);
      unpublished = undefined; return page;
    } finally {
      if (unpublished) { await rm(unpublished, { recursive: true, force: true }); this.roots.delete(unpublished); }
    }
  }

  private async job<T>(bytes: number, request: OfficeInventoryWorkerRequest, signal: AbortSignal | undefined, current: () => boolean): Promise<T> {
    if (!this.worker) throw new Error('worker-unavailable');
    if (this.disposed || signal?.aborted || !current()) throw new Error('cancelled');
    const stop = new AbortController(); this.jobs.add(stop); const abort = () => stop.abort(); signal?.addEventListener('abort', abort, { once: true });
    try {
      const value = await runDocumentWorker<T>(this.worker, bytes, request, 'Office', { signal: stop.signal });
      if (this.disposed || signal?.aborted || !current()) throw new Error('cancelled'); return value;
    } catch (error) {
      if (this.disposed || signal?.aborted || !current()) throw new Error('cancelled');
      if ((error as NodeJS.ErrnoException)?.code === 'ERR_WORKER_OUT_OF_MEMORY') throw new Error('out-of-memory');
      if (error instanceof Error && ['invalid-cursor', 'route-bound-too-small', 'unsupported-office-package', 'invalid-office-package', 'office-expansion-budget', 'out-of-memory'].includes(error.message)) throw error;
      throw new Error('worker-failed');
    } finally { signal?.removeEventListener('abort', abort); this.jobs.delete(stop); }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = (async () => {
      await Promise.allSettled([...this.reads]);
      await Promise.allSettled([...this.roots].map(root => rm(root, { recursive: true, force: true })));
      this.roots.clear(); this.cursors.clear(); this.snapshots.clear();
    })();
    this.lifetime.abort(); for (const job of this.jobs) job.abort(); return this.disposal;
  }
}
