import { Worker } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { totalmem } from 'node:os';
import { DocumentFailure, DOCUMENT_FAILURE_CODES, type DocumentFailureCode } from '../content/document/DocumentContracts';
import type { RenderWorkerPort } from '../content/document/DocumentRenderer';
import { validatePresentationRequest, PresentationImageFailure, type PresentationImageInput, type PresentationRequest, type PresentationRender } from './PresentationContracts';
import { pngDecodeAllocationBytes } from './PngMemory';
import { jpegDecodeAllocationBytes } from './JpegMemory';
import type { WorkbookBindingInput } from '../content/WorkbookBinding';
import { PresentationDataFailure } from './PresentationDataFailure';

interface Job {
  request: PresentationRequest; signal: AbortSignal; isCurrent(): boolean;
  images: PresentationImageInput[];
  loadImages?: () => Promise<PresentationImageInput[]>;
  bindings: readonly WorkbookBindingInput[];
  resolve(result: PresentationRender): void; reject(error: DocumentFailure): void; cancel(): void;
}

/** One fixed-code worker per job. No arbitrary code, target file, URL or execution permission enters it. */
export class PresentationRenderer {
  private readonly queue: Job[] = [];
  private active = false;
  constructor(private readonly workerPath: string,
    private readonly spawn: (file: string, heapMb: number) => RenderWorkerPort = (file, heapMb) => {
      const worker = new Worker(file, { stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
      // Library diagnostics can contain document content; do not inherit them into host logs.
      worker.stdout.resume(); worker.stderr.resume();
      return worker;
    }) {}

  render(input: PresentationRequest, signal: AbortSignal, isCurrent: () => boolean,
    imageInputs: readonly PresentationImageInput[] | (() => Promise<PresentationImageInput[]>) = [], bindings: readonly WorkbookBindingInput[] = []): Promise<PresentationRender> {
    if (signal.aborted || !isCurrent()) return Promise.reject(new DocumentFailure('cancelled'));
    let request: PresentationRequest;
    try { request = validatePresentationRequest(input); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const job: Job = { request, signal, isCurrent, resolve, reject, bindings: structuredClone(bindings),
        images: typeof imageInputs === 'function' ? [] : imageInputs.map(image => ({ ...image, bytes: Buffer.from(image.bytes) })),
        ...(typeof imageInputs === 'function' ? { loadImages: imageInputs } : {}),
        cancel: () => {
          const index = this.queue.indexOf(job);
          if (index < 0) return;
          this.queue.splice(index, 1); signal.removeEventListener('abort', job.cancel); reject(new DocumentFailure('cancelled'));
        } };
      signal.addEventListener('abort', job.cancel, { once: true });
      this.queue.push(job); this.pump();
    });
  }

  private pump(): void {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    job.signal.removeEventListener('abort', job.cancel);
    if (job.signal.aborted || !job.isCurrent()) { job.reject(new DocumentFailure('cancelled')); this.pump(); return; }
    this.active = true;
    void this.run(job).then(job.resolve, job.reject).finally(() => { this.active = false; this.pump(); });
  }

  private async run(job: Job): Promise<PresentationRender> {
    if (job.signal.aborted || !job.isCurrent()) throw new DocumentFailure('cancelled');
    if (job.loadImages) job.images = (await job.loadImages()).map(image => ({ ...image, bytes: Buffer.from(image.bytes) }));
    if (job.signal.aborted || !job.isCurrent()) throw new DocumentFailure('cancelled');
    const jobId = randomUUID();
    const inputMb = (Buffer.byteLength(JSON.stringify(job.request.deck), 'utf8') + job.images.reduce((sum, image) => sum + image.bytes.length, 0)
      + job.bindings.reduce((sum, binding) => sum + binding.bytes, 0)) / 1048576;
    const decodedMb = job.images.reduce((largest, image) => Math.max(largest,
      pngDecodeAllocationBytes(image.bytes) / 1048576, jpegDecodeAllocationBytes(image.bytes) / 1048576), 0);
    // The decoder budget is heap/8; reserve it from actual pixel/sample dimensions, not compression ratio.
    const heapMb = Math.max(256, Math.min(256 + Math.floor(inputMb * 64) + Math.ceil(decodedMb * 8), Math.floor(totalmem() / 1048576 / 2)));
    return new Promise((resolve, reject) => {
      let worker: RenderWorkerPort;
      try { worker = this.spawn(this.workerPath, heapMb); } catch { reject(new DocumentFailure('worker-exit')); return; }
      let settled = false;
      let failure: DocumentFailureCode | undefined;
      let imageIssue: 'invalid-image' | 'unsupported-image' | 'out-of-memory' | undefined;
      let dataIssue = false;
      let result: PresentationRender | undefined;
      const finish = (error?: DocumentFailureCode) => {
        if (settled) return;
        settled = true;
        job.signal.removeEventListener('abort', stop);
        if (error) reject(dataIssue && error === 'invalid-input' ? new PresentationDataFailure() : imageIssue ? new PresentationImageFailure(imageIssue) : new DocumentFailure(error)); else resolve(result!);
      };
      const stop = () => { void worker.terminate().catch(() => finish('render-stop-unconfirmed')); };
      worker.on('message', message => {
        if (settled || message?.jobId !== jobId) return;
        const wanted = new Map<string, number>();
        for (const page of job.request.deck.slides) for (const object of page.objects) {
          if (object.type === 'image') wanted.set(object.asset_ref, (wanted.get(object.asset_ref) ?? 0) + 1);
        }
        const images = message?.images ?? [];
        const expected = new Map(job.images.map(image => [image.assetRef, image.sha256]));
        const validImages = Array.isArray(images) && images.length === wanted.size && new Set(images.map(image => image?.assetRef)).size === images.length
          && images.every(image => image && wanted.get(image.assetRef) === image.placements && expected.get(image.assetRef) === image.sha256
            && (image.embeddedSha256 === undefined || (typeof image.embeddedSha256 === 'string' && /^[0-9a-f]{64}$/.test(image.embeddedSha256)))
            && (image.sourceMimeType === undefined || (image.sourceMimeType === 'image/jpeg' && image.embeddedSha256
              && Number.isSafeInteger(image.orientation) && image.orientation >= 1 && image.orientation <= 8))
            && (image.colorProfile === undefined || ['none', 'preserved-rgb', 'unverified'].includes(image.colorProfile))
            && Number.isSafeInteger(image.width) && image.width > 0 && Number.isSafeInteger(image.height) && image.height > 0);
        const wantedData = job.request.deck.slides.flatMap((slide, slideIndex) => slide.objects.flatMap((object, objectIndex) => object.type === 'table' && object.data_from
          ? [{ slide: slideIndex + 1, object: objectIndex + 1, selection: object.data_from }] : []));
        const dataBindings = message?.dataBindings ?? [];
        const chartBindings = message?.chartBindings ?? [];
        const packageDigest = message.bytes instanceof ArrayBuffer ? createHash('sha256').update(Buffer.from(message.bytes)).digest('hex') : undefined;
        const validData = Array.isArray(dataBindings) && dataBindings.length === wantedData.length
          && new Set(dataBindings.map(fact => `${fact?.slide}:${fact?.object}`)).size === wantedData.length
          && dataBindings.every(fact => {
            const wanted = wantedData.find(item => item.slide === fact?.slide && item.object === fact?.object);
            return wanted && fact.transformation_ref === wanted.selection.transformation_ref && JSON.stringify(fact.selection) === JSON.stringify(wanted.selection)
              && ['passed', 'failed'].includes(fact.output?.status) && Number.isSafeInteger(fact.output.compared_cells) && fact.output.compared_cells >= 1
              && Number.isSafeInteger(fact.output.differences) && fact.output.differences >= 0
              && fact.output.text_comparison === 'powerpoint-line-breaks'
              && packageDigest !== undefined && fact.output.package_sha256 === packageDigest;
          });
        const wantedCharts = job.request.deck.slides.flatMap((slide, slideIndex) => {
          let chart = 0; return slide.objects.flatMap((object, objectIndex) => {
            if (object.type !== 'chart') return []; chart++;
            return object.data_from ? [{ slide: slideIndex + 1, object: objectIndex + 1, chart, selection: object.data_from }] : [];
          });
        });
        const validCharts = Array.isArray(chartBindings) && chartBindings.length === wantedCharts.length
          && new Set(chartBindings.map(fact => `${fact?.slide}:${fact?.object}`)).size === wantedCharts.length
          && chartBindings.every(fact => {
            const wanted = wantedCharts.find(item => item.slide === fact?.slide && item.object === fact?.object);
            const binding = job.bindings.find(input => input.transformationRef === wanted?.selection.transformation_ref);
            const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
            const rows = wanted && binding ? wanted.selection.rows ? wanted.selection.rows.last - wanted.selection.rows.first + 1 : binding.manifest.table.rows : 0;
            const sources = binding?.manifest.source_reads as Array<{ snapshot_ref?: unknown; source_sha256?: unknown }> | undefined;
            const expectedSources = new Map(sources?.filter(source => typeof source.snapshot_ref === 'string' && typeof source.source_sha256 === 'string')
              .map(source => [source.snapshot_ref, source.source_sha256]));
            const status = fact.output?.differences > 0 ? 'failed' : fact.points === 0 ? 'not-performed'
              : fact.partial || fact.precision_loss || fact.blank_points || fact.unknown_labels ? 'partial' : 'passed';
            return wanted && binding && fact.chart === wanted.chart && fact.transformation_ref === binding.transformationRef
              && JSON.stringify(fact.selection) === JSON.stringify(wanted.selection)
              && ['points', 'precision_loss', 'blank_points', 'unknown_labels'].every(key => count(fact[key]))
              && fact.points === rows * wanted.selection.value_fields.length && fact.precision_loss <= fact.points && fact.blank_points <= fact.points && fact.unknown_labels <= rows
              && typeof fact.partial === 'boolean' && fact.partial === (binding.manifest.table.partial === true)
              && typeof fact.supplied?.present === 'boolean' && count(fact.supplied.differences)
              && ['passed', 'partial', 'failed', 'not-performed'].includes(fact.output?.status) && count(fact.output.differences)
              && fact.output.package_sha256 === packageDigest && fact.output.status === status && fact.output.text_comparison === 'powerpoint-line-breaks'
              && (fact.output.status !== 'passed' || (fact.points > 0 && !fact.partial && !fact.precision_loss && !fact.blank_points && !fact.unknown_labels))
              && Array.isArray(fact.sources) && fact.sources.length === expectedSources.size
              && new Set(fact.sources.map((source: { snapshot_ref: string }) => source.snapshot_ref)).size === expectedSources.size
              && fact.sources.every((source: { snapshot_ref: string; sha256: string }) => expectedSources.get(source.snapshot_ref) === source.sha256);
          });
        if (message.ok === true && message.bytes instanceof ArrayBuffer
          && message.slides === job.request.deck.slides.length && message.bytes.byteLength > 0 && validImages && validData && validCharts) {
          result = { bytes: Buffer.from(message.bytes), slides: message.slides, images: message.images, ...(dataBindings.length ? { dataBindings } : {}), ...(chartBindings.length ? { chartBindings } : {}) };
        } else {
          failure = DOCUMENT_FAILURE_CODES.includes(message?.code) ? message.code : 'worker-exit';
          dataIssue = message?.dataIssue === 'source-text-unrepresentable';
          if (['invalid-image', 'unsupported-image', 'out-of-memory'].includes(message?.imageIssue)) imageIssue = message.imageIssue;
        }
      });
      worker.on('error', error => { failure = error?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'out-of-memory' : 'worker-exit'; });
      worker.on('exit', code => {
        if (job.signal.aborted || !job.isCurrent()) finish('cancelled');
        else finish(failure ?? (code !== 0 || !result ? 'worker-exit' : undefined));
      });
      job.signal.addEventListener('abort', stop, { once: true });
      if (job.signal.aborted || !job.isCurrent()) { stop(); return; }
      try { worker.postMessage({ jobId, deck: job.request.deck, images: job.images, bindings: job.bindings }); }
      catch { failure = 'worker-exit'; stop(); }
    });
  }
}
