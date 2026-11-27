import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDocumentWorker, workerScript } from './ContentAssetStore';
import type { CsvManifest, CsvOptions } from './CsvWorkbook';
import { parseWorkbookRange, type CellPosition, type WorkbookRange, type PageBudget, type WorkbookPage } from './WorkbookPage';
import type { WorkbookWorkerRequest } from './WorkbookWorker';
import type { XlsxManifest } from './XlsxWorkbook';
import type { XlsxPage } from './XlsxPage';
import { XLSX_COLUMNS, XLSX_ROWS, xlsxRange } from './XlsxSheet';
import { workbookPlanDependencies, type WorkbookTransformPlan } from './WorkbookTransformPlan';
import type { WorkbookTransformManifest, WorkbookTransformInput } from './WorkbookTransform';
import type { WorkbookTransformPage } from './WorkbookTransformPage';
import type { WorkbookBindingInput } from './WorkbookBinding';

interface Snapshot { id: string; key: string; hash: string; bytes: number; root: string; directory: string; options: CsvOptions; source: CsvManifest | XlsxManifest;
  uses: number; obsolete: boolean; pins: Set<object>; cleaning?: boolean }
/** Private host data descriptor. Never serialized as a tool result or accepted from model arguments. */
export interface WorkbookSnapshotSource { snapshotRef: string; physicalKey: string; sourceSha256: string; bytes: number; directory: string; sourcePath: string; source: CsvManifest | XlsxManifest }
interface Cursor { snapshot: Snapshot; range: WorkbookRange; position: CellPosition; operation: 'inspect' | 'range'; sheetId?: string; visibility?: 'all' | 'visible-only' }
interface Transformation { id: string; dataRef: string; directory: string; manifest: WorkbookTransformManifest; sources: string[]; holder: object; inputBytes: number }
export interface WorkbookTransformReadArgs { transformation_ref?: string; data_ref?: string; cursor?: string }
export type WorkbookSourceAuthorizer = (physicalKey: string) => Promise<() => boolean>;
export interface WorkbookReadArgs { operation: 'inspect' | 'range'; range?: string; cursor?: string; encoding?: CsvOptions['encoding']; delimiter?: string;
  sheet_id?: string; visibility?: 'all' | 'visible-only' }
const known = new Set(['encoding', 'delimiter', 'quotes', 'invalid-range', 'invalid-cursor', 'route-bound-too-small', 'out-of-memory', 'source-changed',
  'invalid-xlsx', 'unsupported-workbook-package', 'unavailable-worksheet', 'invalid-transform-plan', 'unknown-transform-column', 'invalid-source-selection',
  'snapshot-unavailable', 'ambiguous-or-nonnumeric-literal', 'division-by-zero', 'arithmetic-resource-budget', 'transform-failed']);
/** Per-reader private snapshots and opaque cursors. The caller supplies current authorized bytes on every call. */
export class WorkbookReader {
  private readonly cursors = new Map<string, Cursor>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly references = new Map<string, Snapshot>();
  private readonly transformations = new Map<string, Transformation>();
  private readonly transformCursors = new Map<string, { transformation: Transformation; position: CellPosition }>();
  private readonly reads = new Set<Promise<unknown>>();
  private readonly latestHashes = new Map<string, string>();
  private readonly cleanup = new Set<Promise<void>>();
  private readonly folders = new Set<string>();
  private readonly jobs = new Set<AbortController>();
  private disposed = false;
  constructor(private readonly worker = workerScript('WorkbookWorker.js')) {}

  private reclaim(snapshot: Snapshot): void {
    if (!snapshot.obsolete || snapshot.uses || snapshot.pins.size || snapshot.cleaning) return;
    snapshot.cleaning = true;
    const cleanup = rm(snapshot.root, { recursive: true, force: true }).then(() => { this.folders.delete(snapshot.root); this.references.delete(snapshot.id); }, () => { snapshot.cleaning = false; });
    this.cleanup.add(cleanup); void cleanup.then(() => this.cleanup.delete(cleanup));
  }

  /** A host request/attempt/result owns the holder object; an opaque model-visible id grants no access. */
  retainSnapshot(snapshotRef: string, holder: object): boolean {
    const snapshot = this.references.get(snapshotRef);
    if (this.disposed || !snapshot || snapshot.cleaning || (snapshot.obsolete && !snapshot.uses && !snapshot.pins.size)) return false;
    snapshot.pins.add(holder); return true;
  }

  releaseSnapshots(holder: object): void {
    for (const snapshot of this.references.values()) if (snapshot.pins.delete(holder)) this.reclaim(snapshot);
  }

  withSnapshot<T>(snapshotRef: string, holder: object, authorize: (physicalKey: string) => Promise<() => boolean>,
    work: (source: WorkbookSnapshotSource, current: () => boolean) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const pending = (async () => {
      const snapshot = this.references.get(snapshotRef);
      if (this.disposed || !snapshot || snapshot.cleaning || !snapshot.pins.has(holder)) throw new Error('snapshot-unavailable');
      snapshot.uses++;
      try {
        if (signal?.aborted) throw new Error('cancelled');
        const lease = await authorize(snapshot.key);
        const current = () => !this.disposed && !signal?.aborted && snapshot.pins.has(holder) && lease();
        if (!current()) throw new Error('cancelled');
        const value = await work({ snapshotRef: snapshot.id, physicalKey: snapshot.key, sourceSha256: snapshot.hash,
          bytes: snapshot.bytes, directory: snapshot.directory, sourcePath: join(snapshot.root, 'source'), source: snapshot.source }, current);
        if (!current()) throw new Error('cancelled'); return value;
      } finally { snapshot.uses--; this.reclaim(snapshot); }
    })();
    this.reads.add(pending); void pending.then(() => this.reads.delete(pending), () => this.reads.delete(pending)); return pending;
  }

  private withSources<T>(refs: string[], holder: object, authorize: WorkbookSourceAuthorizer,
    work: (sources: WorkbookSnapshotSource[], current: () => boolean) => Promise<T>, signal: AbortSignal | undefined, current: () => boolean): Promise<T> {
    const sources: WorkbookSnapshotSource[] = []; const leases: Array<() => boolean> = [];
    const allCurrent = () => current() && leases.every(lease => lease());
    const next = (index: number): Promise<T> => index === refs.length ? work(sources, allCurrent)
      : this.withSnapshot(refs[index], holder, authorize, async (source, lease) => { sources.push(source); leases.push(lease); return next(index + 1); }, signal);
    return next(0);
  }

  /** Actual private index files are the transform worker input, rather than the compressed original ZIP size. */
  private async indexBytes(directory: string, current: () => boolean): Promise<number> {
    let bytes = 0; const pending = [directory];
    while (pending.length) {
      if (!current()) throw new Error('cancelled');
      const folder = pending.pop()!; const entries = await readdir(folder, { withFileTypes: true });
      for (const entry of entries) {
        const target = join(folder, entry.name);
        if (entry.isDirectory()) pending.push(target); else if (entry.isFile()) bytes += (await stat(target)).size;
      }
    }
    return bytes;
  }

  transform(plan: WorkbookTransformPlan, holder: object, authorize: WorkbookSourceAuthorizer, budget: PageBudget,
    signal?: AbortSignal, current = () => true): Promise<WorkbookTransformPage> {
    const needed = workbookPlanDependencies(plan); const refs = [...new Set(needed.sources.map(source => source.snapshot_ref))];
    let createdRef: string | undefined;
    const pending = this.withSources(refs, holder, authorize, async (sources, live) => {
      if (!live()) throw new Error('cancelled');
      const directory = await mkdtemp(join(tmpdir(), 'unode-workbook-result-')); this.folders.add(directory); const resultHolder = {};
      try {
        let inputBytes = 0;
        try { for (const source of sources) inputBytes += await this.indexBytes(source.directory, live); }
        catch { if (!live()) throw new Error('cancelled'); throw new Error('transform-failed'); }
        const inputs: WorkbookTransformInput[] = needed.sources.map(query => {
          const source = sources.find(source => source.snapshotRef === query.snapshot_ref)!;
          return { name: query.name, snapshot: { snapshotRef: source.snapshotRef, sourceSha256: source.sourceSha256, bytes: source.bytes, directory: source.directory, source: source.source } };
        });
        const manifest = await this.job<WorkbookTransformManifest>(inputBytes, { operation: 'transform', directory, inputs, plan }, signal, live);
        if (!live()) throw new Error('cancelled');
        if (manifest.schema_version !== 1 || manifest.computation !== 'host-run' || !Number.isSafeInteger(manifest.table?.rows)) throw new Error('transform-failed');
        for (const source of sources) if (!this.retainSnapshot(source.snapshotRef, resultHolder)) throw new Error('snapshot-unavailable');
        const pageBytes = await this.indexBytes(directory, live); if (!live()) throw new Error('cancelled');
        const result: Transformation = { id: `transformation-${randomUUID()}`, dataRef: `data-${randomUUID()}`, directory, manifest, sources: refs, holder: resultHolder, inputBytes: pageBytes };
        this.transformations.set(result.id, result); this.transformations.set(result.dataRef, result);
        createdRef = result.id;
        try { return await this.transformationPage(result, { row: 1, column: 1, byte: 0 }, budget, signal, live); }
        catch (error) { this.transformations.delete(result.id); this.transformations.delete(result.dataRef); throw error; }
      } catch (error) {
        this.releaseSnapshots(resultHolder);
        try { await rm(directory, { recursive: true, force: true }); this.folders.delete(directory); } catch { /* Owner dispose retries only its own private root. */ }
        throw error;
      }
    }, signal, current).catch(async error => {
      if (createdRef) await this.discardUnpublishedTransformation(createdRef);
      throw error;
    });
    this.reads.add(pending); void pending.then(() => this.reads.delete(pending), () => this.reads.delete(pending)); return pending;
  }

  /** Host rollback of a newly computed result rejected before publication; never a model-facing operation. */
  async discardUnpublishedTransformation(ref: string): Promise<void> {
    const result = this.transformations.get(ref); if (!result) return;
    this.transformations.delete(result.id); this.transformations.delete(result.dataRef);
    for (const [cursor, item] of this.transformCursors) if (item.transformation === result) this.transformCursors.delete(cursor);
    this.releaseSnapshots(result.holder);
    const cleanup = rm(result.directory, { recursive: true, force: true }).then(() => { this.folders.delete(result.directory); }, () => { /* Dispose retries this host-created root. */ });
    this.cleanup.add(cleanup); try { await cleanup; } finally { this.cleanup.delete(cleanup); }
  }

  readTransformation(args: WorkbookTransformReadArgs, authorize: WorkbookSourceAuthorizer, budget: PageBudget,
    signal?: AbortSignal, current = () => true): Promise<WorkbookTransformPage> {
    const cursor = args.cursor === undefined ? undefined : this.transformCursors.get(args.cursor);
    const ref = args.data_ref ?? args.transformation_ref; const result = ref === undefined ? cursor?.transformation : this.transformations.get(ref);
    if (!result || (args.cursor !== undefined && (!cursor || cursor.transformation !== result))
      || (args.data_ref !== undefined && args.data_ref !== result.dataRef) || (args.transformation_ref !== undefined && args.transformation_ref !== result.id)) return Promise.reject(new Error('invalid-cursor'));
    const pending = this.withSources(result.sources, result.holder, authorize,
      async (_sources, live) => this.transformationPage(result, cursor?.position ?? { row: 1, column: 1, byte: 0 }, budget, signal, live), signal, current);
    this.reads.add(pending); void pending.then(() => this.reads.delete(pending), () => this.reads.delete(pending)); return pending;
  }

  /** Private worker inputs for a host writer, held under each result's actual source authority through the work. */
  withTransformations<T>(refs: readonly string[], authorize: WorkbookSourceAuthorizer,
    work: (inputs: WorkbookBindingInput[], current: () => boolean) => Promise<T>, signal?: AbortSignal, current = () => true): Promise<T> {
    const inputs: WorkbookBindingInput[] = []; const leases: Array<() => boolean> = [];
    const unique = [...new Set(refs)];
    const next = (index: number): Promise<T> => {
      if (index === unique.length) return work(inputs, () => current() && leases.every(lease => lease()));
      const result = this.transformations.get(unique[index]);
      if (!result || result.id !== unique[index]) return Promise.reject(new Error('snapshot-unavailable'));
      return this.withSources(result.sources, result.holder, authorize, async (_sources, live) => {
        inputs.push({ transformationRef: result.id, dataRef: result.dataRef, directory: result.directory, manifest: result.manifest, bytes: result.inputBytes });
        leases.push(live); return next(index + 1);
      }, signal, current);
    };
    const pending = next(0);
    this.reads.add(pending); void pending.then(() => this.reads.delete(pending), () => this.reads.delete(pending)); return pending;
  }

  private async transformationPage(result: Transformation, start: CellPosition, budget: PageBudget, signal: AbortSignal | undefined, current: () => boolean): Promise<WorkbookTransformPage> {
    const cursor = `data-cursor-${randomUUID()}`;
    const page = await this.job<WorkbookTransformPage>(result.inputBytes, { operation: 'transform-page', directory: result.directory, manifest: result.manifest,
      transformationRef: result.id, dataRef: result.dataRef, start, cursor, budget }, signal, current);
    if (page.transformation_ref !== result.id || page.data_ref !== result.dataRef || !Array.isArray(page.prepared_fragments)) throw new Error('transform-failed');
    if (page.remaining) this.transformCursors.set(cursor, { transformation: result, position: page.remaining }); return page;
  }

  private noteCurrentVersion(key: string, hash: string): void {
    this.latestHashes.set(key, hash);
    for (const [cacheKey, snapshot] of this.snapshots) {
      if (snapshot.key !== key || snapshot.hash === hash) continue;
      this.snapshots.delete(cacheKey); snapshot.obsolete = true; this.reclaim(snapshot);
    }
  }

  private async job<T>(bytes: number, request: WorkbookWorkerRequest, signal: AbortSignal | undefined, current: () => boolean): Promise<T> {
    if (!this.worker) throw new Error('worker-unavailable');
    if (this.disposed || signal?.aborted || !current()) throw new Error('cancelled');
    const stop = new AbortController(); this.jobs.add(stop);
    const abort = () => stop.abort(); signal?.addEventListener('abort', abort, { once: true });
    try {
      const value = await runDocumentWorker<T>(this.worker, bytes, request, 'Workbook', { signal: stop.signal });
      if (this.disposed || signal?.aborted || !current()) throw new Error('cancelled');
      return value;
    } catch (error) {
      if (this.disposed || signal?.aborted || !current()) throw new Error('cancelled');
      if ((error as NodeJS.ErrnoException)?.code === 'ERR_WORKER_OUT_OF_MEMORY') throw new Error('out-of-memory');
      if (error instanceof Error && known.has(error.message)) throw error;
      throw new Error('worker-failed');
    } finally { signal?.removeEventListener('abort', abort); this.jobs.delete(stop); }
  }

  read(key: string, bytes: Buffer, args: WorkbookReadArgs, budget: PageBudget, signal?: AbortSignal, current = () => true, holder?: object) {
    const pending = this.readInternal(key, bytes, args, budget, signal, current, holder); this.reads.add(pending);
    void pending.then(() => this.reads.delete(pending), () => this.reads.delete(pending)); return pending;
  }

  private async readInternal(key: string, bytes: Buffer, args: WorkbookReadArgs, budget: PageBudget, signal: AbortSignal | undefined, current: () => boolean, holder?: object) {
    const hash = createHash('sha256').update(bytes).digest('hex');
    this.noteCurrentVersion(key, hash);
    const old = args.cursor ? this.cursors.get(args.cursor) : undefined;
    if (args.cursor && (!old || old.snapshot.key !== key)) throw new Error('invalid-cursor');
    if (old && old.snapshot.hash !== hash) throw new Error('source-changed');
    if (old && old.operation !== args.operation) throw new Error('invalid-cursor');
    const format = bytes.length >= 4 && [0x04034b50, 0x06054b50, 0x08074b50].includes(bytes.readUInt32LE(0)) ? 'xlsx' : 'csv';
    if (format === 'xlsx' && (args.encoding !== undefined || args.delimiter !== undefined)) throw new Error('invalid-range');
    const options: CsvOptions = { encoding: args.encoding ?? old?.snapshot.options.encoding ?? 'utf-8',
      ...(args.delimiter !== undefined ? { delimiter: args.delimiter } : old?.snapshot.options.delimiter === undefined ? {} : { delimiter: old.snapshot.options.delimiter }) };
    if (old && JSON.stringify(options) !== JSON.stringify(old.snapshot.options)) throw new Error('invalid-cursor');
    const cacheKey = JSON.stringify([key, hash, options]);
    let snapshot = this.snapshots.get(cacheKey);
    if (!snapshot) {
      snapshot = await (async (): Promise<Snapshot> => {
        if (this.disposed || signal?.aborted || !current()) throw new Error('cancelled');
        const directory = await mkdtemp(join(tmpdir(), 'unode-workbook-')); this.folders.add(directory);
        try {
          const sourcePath = join(directory, 'source'); const parsed = join(directory, 'parsed'); await mkdir(parsed);
          await writeFile(sourcePath, bytes);
          const source = await this.job<CsvManifest | XlsxManifest>(bytes.length, { operation: 'parse', source: sourcePath, directory: parsed, options, format }, signal, current);
          if (source.sha256 !== hash || source.format !== format || (source.format === 'csv'
            ? !Number.isSafeInteger(source.rows) || !Number.isSafeInteger(source.columns) : !Array.isArray(source.sheets))) throw new Error('worker-failed');
          return { id: `workbook-${randomUUID()}`, key, hash, bytes: bytes.length, root: directory, directory: parsed, options, source, uses: 0, obsolete: false, pins: new Set() };
        } catch (error) { await rm(directory, { recursive: true, force: true }); this.folders.delete(directory); throw error; }
      })();
      const alreadyPrepared = this.snapshots.get(cacheKey);
      if (alreadyPrepared) { snapshot.obsolete = true; this.reclaim(snapshot); snapshot = alreadyPrepared; }
      else if (this.latestHashes.get(key) === hash) this.snapshots.set(cacheKey, snapshot);
      else snapshot.obsolete = true;
    }
    snapshot.uses++;
    this.references.set(snapshot.id, snapshot);
    const publish = <T>(value: T): T => {
      if (this.disposed || signal?.aborted || !current()) throw new Error('cancelled');
      if (holder) snapshot.pins.add(holder); return value;
    };
    try {
      if (this.disposed || signal?.aborted || !current()) throw new Error('cancelled');
      if (snapshot.source.format === 'xlsx') {
        const source = snapshot.source; const cursor = `cursor-${randomUUID()}`;
        const visibility = args.visibility ?? old?.visibility ?? 'all';
        const sheetId = args.sheet_id ?? old?.sheetId ?? source.sheets.find(sheet => sheet.kind === 'worksheet' && !sheet.gap)?.sheetId;
        if (old && (old.sheetId !== sheetId || old.visibility !== visibility)) throw new Error('invalid-cursor');
        let selected: WorkbookRange = { firstRow: 1, lastRow: 0, firstColumn: 1, lastColumn: 0 };
        let request: WorkbookWorkerRequest;
        if (args.operation === 'inspect') {
          if (args.range !== undefined || args.sheet_id !== undefined || args.visibility !== undefined) throw new Error('invalid-range');
          request = { operation: 'xlsx-inspect', directory: snapshot.directory, source, start: old?.position ?? { row: 1, column: 1, byte: 0 }, snapshotRef: snapshot.id, cursor, budget };
        } else {
          const sheet = source.sheets.find(sheet => sheet.sheetId === sheetId); if (!sheet?.metadata || sheet.gap) throw new Error('unavailable-worksheet');
          try { selected = args.range === undefined ? old?.range ?? { firstRow: 1, lastRow: sheet.metadata.rows, firstColumn: 1, lastColumn: sheet.metadata.columns } : xlsxRange(args.range); }
          catch { throw new Error('invalid-range'); }
          if (selected.lastRow > XLSX_ROWS || selected.lastColumn > XLSX_COLUMNS) throw new Error('invalid-range');
          if (old && args.range !== undefined && JSON.stringify(selected) !== JSON.stringify(old.range)) throw new Error('invalid-cursor');
          request = { operation: 'xlsx-page', directory: snapshot.directory, source, sheetId: sheet.sheetId, range: selected,
            start: old?.position ?? { row: selected.firstRow, column: selected.firstColumn, byte: 0 }, snapshotRef: snapshot.id, cursor, budget, visibility };
        }
        const page = await this.job<XlsxPage>(snapshot.bytes, request, signal, current);
        if (page.snapshot_ref !== snapshot.id || page.source_sha256 !== hash || !Array.isArray(page.prepared_fragments)) throw new Error('worker-failed');
        if (page.remaining) this.cursors.set(cursor, { snapshot, range: selected, position: page.remaining, operation: args.operation, sheetId, visibility });
        return publish(page);
      }
      if ((args.sheet_id !== undefined && args.sheet_id !== 'csv:1') || (args.visibility !== undefined && args.visibility !== 'all')) throw new Error('invalid-range');
      if (args.operation === 'inspect') return publish({ schema_version: 1, snapshot_ref: snapshot.id, source_sha256: hash, source: snapshot.source,
        sheets: [{ sheet_id: 'csv:1', name: 'CSV', visibility: 'visible', rows: snapshot.source.rows, columns: snapshot.source.columns }],
        values: 'CSV fields remain literal strings; formulas are not executed.', delivery: 'prepared' });
      const range = parseWorkbookRange(args.range, snapshot.source);
      if (old && args.range !== undefined && JSON.stringify(range) !== JSON.stringify(old.range)) throw new Error('invalid-cursor');
      const selected = old?.range ?? range;
      const cursor = `cursor-${randomUUID()}`;
      const page = await this.job<WorkbookPage>(snapshot.bytes, { operation: 'page', directory: snapshot.directory, source: snapshot.source, range: selected,
        start: old?.position ?? { row: selected.firstRow, column: selected.firstColumn, byte: 0 }, snapshotRef: snapshot.id, cursor, budget }, signal, current);
      if (page.snapshot_ref !== snapshot.id || page.source_sha256 !== hash || !Array.isArray(page.prepared_fragments)) throw new Error('worker-failed');
      if (page.remaining) this.cursors.set(cursor, { snapshot, range: selected, position: page.remaining, operation: args.operation });
      return publish(page);
    } finally { snapshot.uses--; this.reclaim(snapshot); }
  }

  async dispose(): Promise<void> {
    this.disposed = true; for (const job of this.jobs) job.abort();
    await Promise.allSettled([...this.reads]);
    await Promise.allSettled([...this.cleanup]);
    await Promise.allSettled([...this.folders].map(folder => rm(folder, { recursive: true, force: true })));
    this.snapshots.clear(); this.references.clear(); this.cursors.clear(); this.transformations.clear(); this.transformCursors.clear(); this.folders.clear(); this.latestHashes.clear();
  }
}
