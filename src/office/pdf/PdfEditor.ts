import { randomUUID } from 'node:crypto';
import { runDocumentWorker, workerScript } from '../../content/ContentAssetStore';
import { DocumentFailure } from '../../content/document/DocumentContracts';
import { FontResourceBroker } from '../../content/document/FontResourceBroker';
import type { PdfFontSource } from '../../content/document/PdfRenderer';
import type { SystemFontCandidate } from '../../content/document/SystemFontCandidates';
import { platformSystemFontCandidates } from '../platform/SystemFontPlatform';
import { PdfEditFailure, isPdfEditCode, type PdfEditResult } from './PdfEditContracts';
import type { PdfEngineInput } from './PdfEditEngine';
import type { PdfEditWorkerRequest } from './PdfEditWorker';

export interface PdfEditJob {
  input: Omit<PdfEngineInput, 'fonts'>;
  /** Overlay/form languages; the host reads only those fonts, through the one-shot font broker. */
  languages: readonly string[];
  /** Workspace and agent-writable roots: never a font source. */
  forbiddenRoots: readonly string[];
}
interface Queued { job: PdfEditJob; signal: AbortSignal; current(): boolean; resolve(value: PdfEditResult): void; reject(error: unknown): void; cancel(): void }

/** Installed font locations come only from the platform adapter. */
const defaultCandidates = (language: string): SystemFontCandidate[] => platformSystemFontCandidates(language, 'regular');

/** One extension-host queue for PDF edits; a queued edit waits without a deadline and Stop removes it at once. */
export class PdfEditor {
  private readonly queue: Queued[] = [];
  private active = false;
  constructor(private readonly worker = workerScript('PdfEditWorker.js'),
    private readonly candidates: (language: string) => SystemFontCandidate[] = defaultCandidates) {}

  edit(job: PdfEditJob, signal: AbortSignal, current: () => boolean): Promise<PdfEditResult> {
    if (!this.worker) return Promise.reject(new PdfEditFailure('worker-unavailable'));
    if (signal.aborted || !current()) return Promise.reject(new PdfEditFailure('cancelled'));
    return new Promise((resolve, reject) => {
      const queued: Queued = { job, signal, current, resolve, reject, cancel: () => {
        const index = this.queue.indexOf(queued); if (index < 0) return;
        this.queue.splice(index, 1); signal.removeEventListener('abort', queued.cancel); reject(new PdfEditFailure('cancelled'));
      } };
      signal.addEventListener('abort', queued.cancel, { once: true }); this.queue.push(queued); this.pump();
    });
  }

  private pump(): void {
    if (this.active) return; const queued = this.queue.shift(); if (!queued) return;
    queued.signal.removeEventListener('abort', queued.cancel);
    if (queued.signal.aborted || !queued.current()) { queued.reject(new PdfEditFailure('cancelled')); this.pump(); return; }
    this.active = true; void this.run(queued).then(queued.resolve, queued.reject).finally(() => { this.active = false; this.pump(); });
  }

  private async fonts(queued: Queued): Promise<Record<string, PdfFontSource[]>> {
    const jobId = randomUUID(); const byLanguage = new Map(queued.job.languages.map(language => [language, this.candidates(language)]));
    const broker = new FontResourceBroker({ jobId, signal: queued.signal, isCurrent: queued.current, forbiddenRoots: queued.job.forbiddenRoots,
      candidates: [...new Set([...byLanguage.values()].flatMap(values => values.map(value => value.file)))] });
    const read = new Map<string, PdfFontSource>(); const fonts: Record<string, PdfFontSource[]> = {};
    try {
      for (const [language, candidates] of byLanguage) {
        fonts[language] = [];
        for (const candidate of candidates) {
          let source = read.get(candidate.file);
          if (!source) {
            try { const token = broker.issueCandidate(candidate.file); const bytes = await broker.read(jobId, token); source = { bytes: bytes.bytes, sha256: bytes.sha256, family: candidate.family }; read.set(candidate.file, source); }
            catch (error) {
              if (error instanceof DocumentFailure && error.code === 'cancelled') throw new PdfEditFailure('cancelled');
              if (error instanceof DocumentFailure && error.code === 'font-budget') break;
              continue; // A missing named system font may try the next listed candidate, never a scan.
            }
          }
          fonts[language].push({ ...source, family: candidate.family });
        }
      }
      return fonts;
    } finally { await broker.close(); }
  }

  private async run(queued: Queued): Promise<PdfEditResult> {
    try {
      const fonts = await this.fonts(queued);
      if (queued.signal.aborted || !queued.current()) throw new PdfEditFailure('cancelled');
      const request: PdfEditWorkerRequest = { input: { ...queued.job.input, fonts } };
      const inputBytes = queued.job.input.sources.reduce((sum, source) => sum + source.bytes.byteLength, 0)
        + Object.values(fonts).flat().reduce((sum, font) => sum + font.bytes.byteLength, 0);
      const result = await runDocumentWorker<PdfEditResult>(this.worker!, inputBytes * 4, request, 'PDF edit', { signal: queued.signal });
      if (queued.signal.aborted || !queued.current()) throw new PdfEditFailure('cancelled');
      return result;
    } catch (error) {
      if (queued.signal.aborted || !queued.current()) throw new PdfEditFailure('cancelled');
      if (error instanceof PdfEditFailure) throw error;
      if ((error as NodeJS.ErrnoException)?.code === 'ERR_WORKER_OUT_OF_MEMORY') throw new PdfEditFailure('out-of-memory');
      let parsed: { code?: unknown; issue?: { location: string; issue: string } } | undefined;
      try { parsed = JSON.parse(error instanceof Error ? error.message : ''); } catch { parsed = undefined; }
      throw new PdfEditFailure(isPdfEditCode(parsed?.code) ? parsed!.code : 'pdf-edit-failed', parsed?.issue);
    }
  }
}
