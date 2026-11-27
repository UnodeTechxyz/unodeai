import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostReadMemoryBudget } from '../content/ContentAssetStore';
import { encodePowerShellScript, runDocumentWindowsPowerShell, type WindowsPowerShellDocumentDeps } from '../host/windowsPowerShell';
import { decodePng } from './PngDecode';
import { WINDOWS_PDF_RASTER_SCRIPT } from './WindowsPdfScript';
import { captureRasterFile } from './RasterFileCapture';

export interface RasterPageFact { page: number; bytes: number; sha256: string; width: number; height: number }
export interface NativePdfRasterResult {
  renderer: 'windows-pdf'; source_sha256: string; state: 'passed' | 'partial' | 'not-run' | 'failed' | 'cancelled' | 'outcome-unknown';
  total_pages?: number; pages: RasterPageFact[]; error?: string; staging_cleanup: 'removed' | 'not-removed';
  helper_stop?: 'not-started' | 'stopped' | 'unconfirmed';
  scope: string;
}
interface RasterPorts {
  execute?: typeof runDocumentWindowsPowerShell;
  powershell?: WindowsPowerShellDocumentDeps;
  memoryBudget?: () => number;
  decode?: (bytes: Buffer, budget: number) => Promise<{ sha256: string; width: number; height: number }>;
  retainStage?: (stage: string) => void;
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Internal PDF bytes only. Owns its private source/output stage; no caller-supplied output path or app flags. */
export class WindowsPdfRasterizer {
  constructor(private readonly ports: RasterPorts = {}) {}
  async rasterize(source: Buffer, signal: AbortSignal, current: () => boolean,
    onPage: (page: RasterPageFact & { data: Buffer }) => void | Promise<void> = () => {},
    acceptPageCount?: (total: number) => boolean): Promise<NativePdfRasterResult> {
    const sourceHash = digest(source);
    const result: NativePdfRasterResult = { renderer: 'windows-pdf', source_sha256: sourceHash, state: 'failed', pages: [], staging_cleanup: 'removed',
      scope: 'Actual decoded raster pages only; no model delivery, independent visual review, exact nominal-size or original Office fidelity claim.' };
    const budget = this.ports.memoryBudget?.() ?? hostReadMemoryBudget();
    if (!Number.isSafeInteger(budget) || budget <= 0 || source.length > budget) return { ...result, error: 'pdf-memory-limited' };
    if (signal.aborted || !current()) return { ...result, state: 'cancelled', error: 'cancelled' };
    const sourceBytes = Buffer.from(source);
    let stage: string | undefined;
    let cleanupAllowed = true;
    const check = () => { if (signal.aborted || !current()) throw Error('cancelled'); };
    try {
      stage = await mkdtemp(join(tmpdir(), 'unode-pdf-raster-')); stage = await realpath(stage);
      const input = join(stage, 'source.pdf'); const output = join(stage, 'pages'); const temporary = join(stage, 'tmp');
      await mkdir(output); await mkdir(temporary); await writeFile(input, sourceBytes, { flag: 'wx', mode: 0o600 });
      check(); const operationId = randomUUID();
      const run = await (this.ports.execute ?? runDocumentWindowsPowerShell)({ encodedCommand: encodePowerShellScript(WINDOWS_PDF_RASTER_SCRIPT),
        inputVariable: 'UNODE_PDF_JOB', input: Buffer.from(JSON.stringify({ version: 1, operationId, source: input, output,
          maxImageBytes: Math.min(budget, 0x7fffffff), maxNominalPixels: Math.max(1, Math.floor(budget / 64)) })).toString('base64'),
        maxInputChars: 65536, cwd: stage, tmp: temporary, maxStdoutBytes: 16384, signal,
      }, this.ports.powershell);
      if (run.status === 'stopped') {
        result.helper_stop = run.helper;
        cleanupAllowed = run.helper !== 'unconfirmed';
        return Object.assign(result, { state: run.helper === 'unconfirmed' ? 'outcome-unknown' : run.reason === 'cancelled' ? 'cancelled' : 'failed', error: run.reason === 'output-limit' ? 'raster-output-limit' : 'helper-' + run.helper });
      }
      check();
      if (run.status === 'unavailable') return Object.assign(result, { state: 'not-run', error: 'powershell-' + run.reason });
      if (run.code !== 0) return Object.assign(result, { error: 'raster-helper-failed' });
      let response: any; try { response = JSON.parse(run.stdout); } catch { return Object.assign(result, { error: 'raster-response-invalid' }); }
      if (response?.version !== 1) return Object.assign(result, { error: 'raster-response-invalid' });
      if (response.status === 'not-run' && ['powershell-constrained', 'windows-pdf-unavailable'].includes(response.error)) {
        return Object.assign(result, { state: 'not-run', error: response.error });
      }
      if (response.operation_id !== operationId || !['passed', 'partial', 'failed'].includes(response.status)
        || !Number.isSafeInteger(response.page_count) || response.page_count < 0 || !Number.isSafeInteger(response.completed_pages)
        || response.completed_pages < 0 || response.completed_pages > response.page_count
        || response.status === 'passed' && (response.page_count === 0 || response.completed_pages !== response.page_count)) return Object.assign(result, { error: 'raster-response-invalid' });
      result.total_pages = response.page_count;
      // A source-indexed caller must establish the mapping before any PDF page is published as that source unit.
      if (acceptPageCount && !acceptPageCount(response.page_count)) return Object.assign(result, { state: 'partial', error: 'raster-page-count-mismatch' });
      if (digest(await captureRasterFile(input, budget)) !== sourceHash) return Object.assign(result, { error: 'raster-source-changed' });
      for (let page = 1; page <= response.completed_pages; page++) {
        check(); const file = join(output, 'page-' + page + '.png');
        const bytes = await captureRasterFile(file, budget);
        const decoded = this.ports.decode ? await this.ports.decode(bytes, budget) : decodePng(bytes, budget); check();
        const fact: RasterPageFact = { page, bytes: bytes.length, sha256: decoded.sha256, width: decoded.width, height: decoded.height };
        result.pages.push(fact); await onPage({ ...fact, data: Buffer.from(bytes) }); check();
      }
      result.state = response.status;
      if (response.status !== 'passed') result.error = ['pdf-load-failed', 'pdf-empty', 'page-raster-failed'].includes(response.error) ? response.error : 'raster-incomplete';
      return result;
    } catch (error) {
      const cancelled = signal.aborted || !current();
      result.state = cancelled ? 'cancelled' : result.pages.length ? 'partial' : 'failed';
      result.error = cancelled ? 'cancelled' : error instanceof Error && /^(?:raster|render-output)-[a-z-]+$/.test(error.message) ? error.message : stage ? 'raster-page-invalid' : 'raster-stage-unavailable';
      return result;
    } finally {
      if (!cleanupAllowed) result.staging_cleanup = 'not-removed';
      else if (stage) try {
        const stat = await lstat(stage);
        if (stat.isDirectory() && !stat.isSymbolicLink() && await realpath(stage) === stage) await rm(stage, { recursive: true, force: true });
        else result.staging_cleanup = 'not-removed';
      } catch { result.staging_cleanup = 'not-removed'; }
      if (stage && result.staging_cleanup === 'not-removed') try { this.ports.retainStage?.(stage); } catch { /* Cleanup reporting never masks the primary result. */ }
    }
  }
}
