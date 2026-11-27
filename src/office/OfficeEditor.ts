import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { totalmem } from 'node:os';
import { runDocumentWorker, workerScript, CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES } from '../content/ContentAssetStore';
import { OfficeEditFailure, isOfficeEditCode, type OfficeEditInput, type OfficeEditResult } from './OfficeEditContracts';
import type { OfficeEditWorkerRequest } from './OfficeEditWorker';
import type { PresentationImageInput } from './PresentationContracts';
import { pngDecodeAllocationBytes } from './PngMemory';
import { jpegDecodeAllocationBytes } from './JpegMemory';

interface Job { worker: string; input: OfficeEditInput; signal: AbortSignal; current(): boolean; cancel(): void;
  loadImages?: () => Promise<PresentationImageInput[]>;
  resolve(result: OfficeEditResult): void; reject(error: unknown): void }
/** One extension-host queue; cancelling a queued edit does not wait for another agent's edit. */
export class OfficeEditor {
  private static readonly queue: Job[] = [];
  private static active = false;
  constructor(private readonly worker = workerScript('OfficeEditWorker.js')) {}
  edit(input: OfficeEditInput, signal: AbortSignal, current: () => boolean, loadImages?: () => Promise<PresentationImageInput[]>): Promise<OfficeEditResult> {
    if (!this.worker) return Promise.reject(new OfficeEditFailure('worker-unavailable'));
    if (signal.aborted || !current()) return Promise.reject(new OfficeEditFailure('cancelled'));
    return new Promise((resolve, reject) => {
      const job: Job = { worker: this.worker!, input, signal, current, loadImages, resolve, reject, cancel: () => {
        const index = OfficeEditor.queue.indexOf(job); if (index < 0) return;
        OfficeEditor.queue.splice(index, 1); signal.removeEventListener('abort', job.cancel); reject(new OfficeEditFailure('cancelled'));
      } };
      signal.addEventListener('abort', job.cancel, { once: true }); OfficeEditor.queue.push(job); OfficeEditor.pump();
    });
  }
  private static pump(): void {
    if (this.active) return; const job = this.queue.shift(); if (!job) return;
    job.signal.removeEventListener('abort', job.cancel);
    if (job.signal.aborted || !job.current()) { job.reject(new OfficeEditFailure('cancelled')); this.pump(); return; }
    this.active = true; void this.run(job).then(job.resolve, job.reject).finally(() => { this.active = false; this.pump(); });
  }
  private static async run(job: Job): Promise<OfficeEditResult> {
    try {
      if (job.loadImages) job.input = { ...job.input, images: await job.loadImages() };
      const indexBytes = (await stat(join(job.input.directory, 'inventory.json-data'))).size;
      if (job.signal.aborted || !job.current()) throw new OfficeEditFailure('cancelled');
      const request: OfficeEditWorkerRequest = { input: job.input, expansionRatio: CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, expansionFloor: CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES };
      const imageBytes = (job.input.images ?? []).reduce((sum, image) => sum + image.bytes.length, 0);
      const bindingBytes = (job.input.bindings ?? []).reduce((sum, binding) => sum + binding.bytes, 0);
      const donorBytes = (job.input.donors ?? []).reduce((sum, donor) => sum + donor.bytes, 0);
      const decoded = (job.input.images ?? []).reduce((largest, image) => Math.max(largest, pngDecodeAllocationBytes(image.bytes), jpegDecodeAllocationBytes(image.bytes)), 0);
      // Existing machine-scaled heap/progress policy; include the actual uncompressed inventory and edit request.
      // Its eight-times-input heap reserves the decoder's heap/8 budget from actual dimensions, including compressed screenshots.
      const result = await runDocumentWorker<OfficeEditResult>(job.worker, indexBytes + Buffer.byteLength(JSON.stringify(job.input.edits))
        + (await stat(job.input.source)).size + imageBytes + bindingBytes + donorBytes + Math.min(decoded, totalmem()), request, 'Office edit', { signal: job.signal });
      if (job.signal.aborted || !job.current()) throw new OfficeEditFailure('cancelled'); return result;
    } catch (error) {
      if (job.signal.aborted || !job.current()) throw new OfficeEditFailure('cancelled');
      if ((error as NodeJS.ErrnoException)?.code === 'ERR_WORKER_OUT_OF_MEMORY') throw new OfficeEditFailure('out-of-memory');
      throw new OfficeEditFailure(error instanceof Error && isOfficeEditCode(error.message) ? error.message : 'office-edit-failed');
    }
  }
}
