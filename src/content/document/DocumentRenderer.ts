import { Worker } from 'node:worker_threads';
import { totalmem } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DOCUMENT_FAILURE_CODES, DocumentFailure, type CanonicalDocumentRequest, type DocumentRenderStats } from './DocumentContracts';
import { validateDocumentRequest } from './DocumentValidation';
import * as path from 'node:path';
import { FontResourceBroker } from './FontResourceBroker';
import { systemFontCandidates } from './SystemFontCandidates';
import { documentTexts } from './DocumentContracts';
import type { SystemFontCandidate } from './SystemFontCandidates';

export interface RenderWorkerPort {
  on(name: 'message' | 'error' | 'exit', listener: (...args: any[]) => void): unknown;
  postMessage(value: unknown, transfer?: ArrayBuffer[]): void;
  terminate(): Promise<number>;
}
interface Job {
  request: CanonicalDocumentRequest; signal: AbortSignal; isCurrent(): boolean;
  resolve(value: { bytes: Buffer; stats: DocumentRenderStats }): void;
  reject(error: DocumentFailure): void;
  cancel(): void;
}
export interface RenderWorkerLimits { maxOldGenerationSizeMb: number }

/**
 * v0.9.99: the worker heap is sized from the input, not fixed for a typical document. A PDF holds positioned glyph
 * operators for every character, so it needs far more per input byte than a DOCX package. A heap the machine cannot
 * give is still a real out-of-memory failure, reported as one.
 */
export function documentWorkerHeapMb(request: CanonicalDocumentRequest, totalMemoryBytes = totalmem()): number {
  const inputMb = Buffer.byteLength(JSON.stringify(request.document), 'utf8') / 1_048_576;
  const wanted = 256 + Math.floor(inputMb * (request.format === 'pdf' ? 2048 : 64));
  return Math.max(256, Math.min(wanted, Math.floor(totalMemoryBytes / 1_048_576 / 2)));
}

/**
 * One cooperative host queue (v0.9.99): documents render one at a time, a waiting request is never refused as busy
 * and never times out, and Stop removes it at once. Rendering owns no target path, directory, checkpoint or
 * execution authority.
 */
export class DocumentRenderer {
  private readonly queue: Job[] = [];
  private active = false;
  constructor(private readonly workerPath: string,
    private readonly spawn: (path: string, limits: RenderWorkerLimits) => RenderWorkerPort = (path, limits) => new Worker(path, {
      resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    }), private readonly fontEnvironment: {
      forbiddenRoots(): readonly string[];
      candidates?(language: string, style: 'regular' | 'bold'): SystemFontCandidate[];
    } = { forbiddenRoots: () => [process.cwd()] }) {}

  render(request: CanonicalDocumentRequest, signal: AbortSignal, isCurrent: () => boolean) {
    if (signal.aborted || !isCurrent()) return Promise.reject(new DocumentFailure('cancelled'));
    // Capture the canonical input before waiting; caller mutations never change the queued job.
    let captured: CanonicalDocumentRequest;
    try { captured = validateDocumentRequest(request); } catch (error) { return Promise.reject(error); }
    return new Promise<{ bytes: Buffer; stats: DocumentRenderStats }>((resolve, reject) => {
      const remove = (error: DocumentFailure) => {
        const index = this.queue.indexOf(job);
        if (index < 0) return;
        this.queue.splice(index, 1); signal.removeEventListener('abort', job.cancel); reject(error);
      };
      const job: Job = { request: captured, signal, isCurrent, resolve, reject,
        cancel: () => remove(new DocumentFailure('cancelled')) };
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
    void this.run(job).then(job.resolve, job.reject).finally(() => {
      this.active = false; this.pump();
    });
  }

  private async run(job: Job): Promise<{ bytes: Buffer; stats: DocumentRenderStats }> {
    const jobId = randomUUID();
    let worker: RenderWorkerPort;
    try { worker = this.spawn(this.workerPath, { maxOldGenerationSizeMb: documentWorkerHeapMb(job.request) }); } catch { throw new DocumentFailure('worker-exit'); }
    let exitObserved = false;
    let exitCode: number | undefined;
    let exited!: () => void;
    const exit = new Promise<void>(resolve => { exited = resolve; });
    let abort: () => void = () => {};
    let result: { bytes: Buffer; stats: DocumentRenderStats } | undefined;
    let failure: DocumentFailure | undefined;
    const profiles = new Map<string, SystemFontCandidate[]>();
    if (job.request.format === 'pdf') {
      const languages = new Set([job.request.document.language, ...documentTexts(job.request.document).flatMap(text => text.map(run => run.language))]);
      for (const language of languages) for (const style of ['regular', 'bold'] as const) {
        const key = `${language}/${style}`;
        if (!profiles.has(key)) profiles.set(key, this.fontEnvironment.candidates?.(language, style)
          ?? systemFontCandidates(process.platform, path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'), language, style));
      }
    }
    // No render deadline (v0.9.99): a slow render keeps going and Stop ends it through the job's signal.
    const broker = job.request.format === 'pdf' ? new FontResourceBroker({ jobId, signal: job.signal,
      isCurrent: job.isCurrent, forbiddenRoots: this.fontEnvironment.forbiddenRoots(),
      candidates: [...new Set([...profiles.values()].flatMap(values => values.map(value => value.file)))] }) : undefined;
    const provided = new Map<string, { id: string; sha256: string }>();
    let fontRead = false; let lastFontRequest = 0;
    try {
      result = await new Promise<{ bytes: Buffer; stats: DocumentRenderStats }>((resolve, reject) => {
        let replied = false;
        worker.on('exit', (code: number) => {
          exitObserved = true; exitCode = code; exited();
          if (!replied || code !== 0) reject(new DocumentFailure('worker-exit'));
        });
        // A worker that exceeds its heap is a real out-of-memory failure, not a generic exit.
        worker.on('error', (error: { code?: unknown } | undefined) => {
          failure = new DocumentFailure(error?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'out-of-memory' : 'worker-exit'); reject(failure);
        });
        worker.on('message', (message: any) => {
          if (replied) return;
          if (message?.kind === 'font-read') {
            const candidates = profiles.get(`${message.language}/${message.style}`);
            if (!broker || message.jobId !== jobId || fontRead || !Number.isSafeInteger(message.requestId)
              || message.requestId !== lastFontRequest + 1 || !candidates) { reject(new DocumentFailure('font-resource-invalid')); return; }
            fontRead = true; lastFontRequest = message.requestId;
            void (async () => {
              const sources: Array<{ id: string; sha256: string; family: string; bytes?: ArrayBuffer }> = [];
              const transfer: ArrayBuffer[] = [];
              try {
                for (const candidate of candidates) {
                  const previous = provided.get(candidate.file);
                  if (previous) { sources.push({ ...previous, family: candidate.family }); continue; }
                  try {
                    const id = broker.issueCandidate(candidate.file); const source = await broker.read(jobId, id);
                    sources.push({ id, ...source, family: candidate.family }); transfer.push(source.bytes);
                    provided.set(candidate.file, { id, sha256: source.sha256 });
                  } catch (error) {
                    if (error instanceof DocumentFailure && ['cancelled', 'font-budget'].includes(error.code)) throw error;
                    // A missing named system alias may try the next explicitly listed candidate, never a scan.
                  }
                }
                if (!job.signal.aborted && job.isCurrent()) worker.postMessage({ kind: 'font-data', jobId,
                  requestId: message.requestId, sources }, transfer);
              } catch (error) { reject(error instanceof DocumentFailure ? error : new DocumentFailure('font-resource-invalid')); }
              finally { fontRead = false; }
            })();
            return;
          }
          if (!message || message.jobId !== jobId || typeof message.ok !== 'boolean') { reject(new DocumentFailure('worker-exit')); return; }
          replied = true;
          // Errors are finite host codes; never forward a worker's raw error/body to a model or log.
          if (!message.ok) { reject(new DocumentFailure(DOCUMENT_FAILURE_CODES.includes(message.code) ? message.code : 'worker-exit')); return; }
          const stats = message.stats as DocumentRenderStats;
          const blocks = job.request.document.blocks;
          if (job.request.format === 'pdf') {
            const plan = message.fontPlan;
            const hashes = new Set([...provided.values()].map(value => value.sha256));
            if (!Array.isArray(plan) || !plan.length || plan.length > 32
              || plan.some(use => !use || !hashes.has(use.sha256) || !profiles.has(`${use.language}/${use.style}`)
                || !Number.isSafeInteger(use.faceIndex) || use.faceIndex < 0 || typeof use.postscriptName !== 'string'
                || use.postscriptName.length > 200 || !['glyf', 'cff'].includes(use.outlines))
              || createHash('sha256').update(JSON.stringify({ fontkit: '2.0.4', pdfLib: '1.17.1', uses: plan })).digest('hex') !== stats?.fontManifestDigest) {
              reject(new DocumentFailure('font-resource-invalid')); return;
            }
          } else if (message.fontPlan !== undefined) { reject(new DocumentFailure('worker-exit')); return; }
          if (!(message.bytes instanceof ArrayBuffer) || message.bytes.byteLength === 0
            || !stats || stats.format !== job.request.format || stats.template !== job.request.template || stats.rendererRevision !== 2
            || stats.blocks !== blocks.length || stats.headings !== blocks.filter(block => block.type === 'heading').length
            || stats.clauses !== blocks.filter(block => block.type === 'clause').length || stats.tables !== blocks.filter(block => block.type === 'table').length
            || !/^[a-f0-9]{64}$/.test(stats.fontManifestDigest) || (stats.format === 'docx' && stats.pages !== undefined)
            || stats.format === 'pdf' && (!Number.isSafeInteger(stats.pages) || stats.pages! < 1)) {
            reject(new DocumentFailure('worker-exit')); return;
          }
          resolve({ bytes: Buffer.from(message.bytes), stats: { ...stats } });
        });
        abort = () => reject(new DocumentFailure('cancelled'));
        job.signal.addEventListener('abort', abort, { once: true });
        if (job.signal.aborted || !job.isCurrent()) { abort(); return; }
        const { format, template, document } = job.request; // No target path or caller identity enters the worker.
        worker.postMessage({ jobId, format, template, document });
      });
    } catch (error) { failure = error instanceof DocumentFailure ? error : new DocumentFailure('worker-exit'); }
    finally { job.signal.removeEventListener('abort', abort); }
    // A message is not worker termination. Observe exit; late/duplicate messages cannot release a slot.
    if (!failure && !exitObserved) await this.waitForExit(exit, 1000);
    if (!exitObserved) {
      try { void worker.terminate().catch(() => {}); } catch { /* observed below, never treated as a stopped worker */ }
      if (!await this.waitForExit(exit, 2000)) {
        await broker?.close();
        throw new DocumentFailure('render-stop-unconfirmed');
      }
    }
    await broker?.close();
    if (job.signal.aborted || !job.isCurrent()) throw new DocumentFailure('cancelled');
    if (!failure && exitCode !== 0) throw new DocumentFailure('worker-exit');
    if (failure) throw failure;
    return result!;
  }

  private async waitForExit(exit: Promise<void>, milliseconds: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([exit.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
}
