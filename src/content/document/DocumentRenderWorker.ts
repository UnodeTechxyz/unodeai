import { parentPort } from 'node:worker_threads';
import { DocumentFailure } from './DocumentContracts';
import { validateDocumentRequest } from './DocumentValidation';
import { renderDocx } from './DocxRenderer';
import { admitDocumentLayout, documentLayoutWarnings } from './DocumentLayoutAdmission';
import { renderPdf, type PdfFontSource } from './PdfRenderer';
import { bindDocumentData } from './DocumentDataBinding';
import { checkDocumentData } from './DocumentDataCheck';
import { DocumentDataFailure } from './DocumentDataFailure';
import type { WorkbookBindingInput } from '../WorkbookBinding';

if (!parentPort) throw new Error('Document renderer requires a parent port.');
parentPort.once('message', async (job: { jobId: string; format: unknown; template: unknown; document: unknown; filename?: unknown; source_bindings?: unknown; bindings?: WorkbookBindingInput[] }) => {
  const jobId = typeof job?.jobId === 'string' && job.jobId.length <= 100 ? job.jobId : '';
  try {
    // Title normalization already happened exactly once in the host queue. Only a basename is supplied for untitled metadata.
    const canonical = validateDocumentRequest({ schema_version: 1, path: job.filename ?? `render.${job.format}`, format: job.format,
      template: job.template, document: job.document, ...(job.source_bindings === undefined ? {} : { source_bindings: job.source_bindings }) }, { canonical: true });
    if (!jobId) throw new DocumentFailure('invalid-input');
    if (job.bindings !== undefined && !Array.isArray(job.bindings)) throw new DocumentDataFailure('selection');
    const bound = bindDocumentData(canonical, job.bindings ?? []); const request = bound.request;
    const bindingLayoutWarnings = request.source_bindings?.length ? (request.format === 'docx' ? documentLayoutWarnings(request.document) : []) : undefined;
    // The host supplies job-bound font snapshots. The worker never opens a font path itself.
    if (request.format !== 'docx') {
      const admission = admitDocumentLayout(request.document);
      const issue = admission.fields.flatMap(field => field.issues)[0];
      if (issue) throw new DocumentFailure(issue.code);
      const cache = new Map<string, PdfFontSource>(); let requestId = 0;
      const rendered = await renderPdf(request, (language, style) => new Promise((resolve, reject) => {
        const id = ++requestId;
        const answer = (message: any) => {
          if (message?.kind !== 'font-data' || message.jobId !== jobId || message.requestId !== id) return;
          parentPort!.off('message', answer);
          if (!Array.isArray(message.sources)) { reject(new DocumentFailure(message.code === 'font-budget' ? 'font-budget' : 'font-unavailable')); return; }
          const sources: PdfFontSource[] = [];
          for (const value of message.sources) {
            if (value.bytes instanceof ArrayBuffer) cache.set(value.id, { bytes: value.bytes, sha256: value.sha256, family: value.family });
            const source = cache.get(value.id);
            if (!source || source.sha256 !== value.sha256) { reject(new DocumentFailure('font-resource-invalid')); return; }
            sources.push({ ...source, family: value.family });
          } resolve(sources);
        };
        parentPort!.on('message', answer);
        parentPort!.postMessage({ kind: 'font-read', jobId, requestId: id, language, style });
      }));
      const bytes = Uint8Array.from(rendered.bytes).buffer;
      const dataBindings = await checkDocumentData(rendered.bytes, bound.expectations, 'pdf');
      parentPort!.postMessage({ jobId, ok: true, bytes, stats: { ...rendered.stats, ...(dataBindings.length ? { dataBindings } : {}) }, fontPlan: rendered.fontPlan,
        ...(bindingLayoutWarnings ? { bindingLayoutWarnings } : {}) }, [bytes]);
      return;
    }
    const yazl = require('yazl') as { ZipFile: new () => import('./DocxRenderer').DocumentZip };
    const rendered = await renderDocx(request, () => new yazl.ZipFile());
    const bytes = Uint8Array.from(rendered.bytes).buffer;
    const dataBindings = await checkDocumentData(rendered.bytes, bound.expectations, 'docx');
    parentPort!.postMessage({ jobId, ok: true, bytes, stats: { ...rendered.stats, ...(dataBindings.length ? { dataBindings } : {}) },
      ...(bindingLayoutWarnings ? { bindingLayoutWarnings } : {}) }, [bytes]);
  } catch (error) {
    parentPort!.postMessage({ jobId, ok: false, code: error instanceof DocumentFailure ? error.code : error instanceof RangeError ? 'out-of-memory' : 'worker-exit',
      ...(error instanceof DocumentDataFailure ? { bindingIssue: error.bindingIssue } : {}) });
  } finally {
    parentPort!.close();
  }
});
