import { stat } from 'node:fs/promises';
import { runDocumentWorker, workerScript, CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES } from '../content/ContentAssetStore';
import { WorkbookEditFailure, isWorkbookEditCode, type WorkbookEditInput, type WorkbookCreateInput, type WorkbookWriteResult } from './WorkbookEditContracts';
import type { OfficeEditWorkerRequest } from './OfficeEditWorker';
import type { WorkbookRecalcWorkerInput } from './WorkbookRecalcPackage';

interface Job { request: OfficeEditWorkerRequest; bytes: number; signal: AbortSignal; current(): boolean; resolve(result: unknown): void; reject(error: unknown): void; cancel(): void }
/** Host queue for the fixed workbook writers. A queued request that is stopped never waits for another agent's write. */
export class WorkbookEditor {
  private static readonly queue: Job[] = [];
  private static active = false;
  constructor(private readonly worker = workerScript('OfficeEditWorker.js')) {}
  edit(input: WorkbookEditInput, signal: AbortSignal, current: () => boolean): Promise<WorkbookWriteResult> {
    return this.enqueue({ workbook: { operation: 'edit', input }, expansionRatio: CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, expansionFloor: CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES },
      async () => (await stat(input.source)).size * 8 + Buffer.byteLength(JSON.stringify(input.edits)) + (input.bindings ?? []).reduce((sum, binding) => sum + binding.bytes, 0), signal, current);
  }
  create(input: WorkbookCreateInput, signal: AbortSignal, current: () => boolean): Promise<WorkbookWriteResult> {
    return this.enqueue({ workbook: { operation: 'create', input }, expansionRatio: CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, expansionFloor: CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES },
      async () => Buffer.byteLength(JSON.stringify(input.sheets)) * 8 + (input.bindings ?? []).reduce((sum, binding) => sum + binding.bytes, 0), signal, current);
  }
  /** The passive steps around a native recalculation run in the same fixed worker and queue. */
  recalc<T>(input: WorkbookRecalcWorkerInput, signal: AbortSignal, current: () => boolean): Promise<T> {
    return this.enqueue<T>({ workbook: { operation: 'recalc', input }, expansionRatio: CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, expansionFloor: CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES },
      async () => (await stat(input.source)).size * 8 + Buffer.byteLength(JSON.stringify(input)), signal, current);
  }
  private async enqueue<T = WorkbookWriteResult>(request: OfficeEditWorkerRequest, size: () => Promise<number>, signal: AbortSignal, current: () => boolean): Promise<T> {
    if (!this.worker) throw new WorkbookEditFailure('worker-unavailable');
    if (signal.aborted || !current()) throw new WorkbookEditFailure('cancelled');
    const bytes = await size(); const worker = this.worker;
    return new Promise((resolve, reject) => {
      const job: Job = { request, bytes, signal, current, resolve: value => resolve(value as T), reject, cancel: () => {
        const index = WorkbookEditor.queue.indexOf(job); if (index < 0) return;
        WorkbookEditor.queue.splice(index, 1); signal.removeEventListener('abort', job.cancel); reject(new WorkbookEditFailure('cancelled'));
      } };
      signal.addEventListener('abort', job.cancel, { once: true }); WorkbookEditor.queue.push(job); WorkbookEditor.pump(worker);
    });
  }
  private static pump(worker: string): void {
    if (this.active) return; const job = this.queue.shift(); if (!job) return;
    job.signal.removeEventListener('abort', job.cancel);
    if (job.signal.aborted || !job.current()) { job.reject(new WorkbookEditFailure('cancelled')); this.pump(worker); return; }
    this.active = true; void this.run(worker, job).then(job.resolve, job.reject).finally(() => { this.active = false; this.pump(worker); });
  }
  private static async run(worker: string, job: Job): Promise<unknown> {
    try {
      const result = await runDocumentWorker<unknown>(worker, job.bytes, job.request, 'Workbook edit', { signal: job.signal });
      if (job.signal.aborted || !job.current()) throw new WorkbookEditFailure('cancelled'); return result;
    } catch (error) {
      if (error instanceof WorkbookEditFailure) throw error;
      if (job.signal.aborted || !job.current()) throw new WorkbookEditFailure('cancelled');
      if ((error as NodeJS.ErrnoException)?.code === 'ERR_WORKER_OUT_OF_MEMORY') throw new WorkbookEditFailure('out-of-memory');
      const message = error instanceof Error ? error.message : '';
      if (message.startsWith('{')) {
        try {
          const parsed = JSON.parse(message) as { code?: string; issue?: { location?: unknown; issue?: unknown } };
          if (parsed.code && isWorkbookEditCode(parsed.code) && typeof parsed.issue?.location === 'string' && typeof parsed.issue.issue === 'string')
            throw new WorkbookEditFailure(parsed.code, { location: parsed.issue.location.slice(0, 200), issue: parsed.issue.issue.slice(0, 600) });
        } catch (failure) { if (failure instanceof WorkbookEditFailure) throw failure; }
      }
      throw new WorkbookEditFailure(isWorkbookEditCode(message) ? message : 'workbook-edit-failed');
    }
  }
}
