import { parentPort } from 'node:worker_threads';
import { DocumentFailure } from './DocumentContracts';
import { validateDocumentRequest } from './DocumentValidation';
import { renderDocx } from './DocxRenderer';
import { admitDocumentLayout } from './DocumentLayoutAdmission';
import { renderPdf, type PdfFontSource } from './PdfRenderer';

if (!parentPort) throw new Error('Document renderer requires a parent port.');
parentPort.once('message', async (job: { jobId: string; format: unknown; template: unknown; document: unknown }) => {
  const jobId = typeof job?.jobId === 'string' && job.jobId.length <= 100 ? job.jobId : '';
  try {
    const request = validateDocumentRequest({ schema_version: 1, path: `render.${job.format}`, format: job.format,
      template: job.template, document: job.document });
    if (!jobId) throw new DocumentFailure('invalid-input');
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
      parentPort!.postMessage({ jobId, ok: true, bytes, stats: rendered.stats, fontPlan: rendered.fontPlan }, [bytes]);
      return;
    }
    const yazl = require('yazl') as { ZipFile: new () => import('./DocxRenderer').DocumentZip };
    const rendered = await renderDocx(request, () => new yazl.ZipFile());
    const bytes = Uint8Array.from(rendered.bytes).buffer;
    parentPort!.postMessage({ jobId, ok: true, bytes, stats: rendered.stats }, [bytes]);
  } catch (error) {
    parentPort!.postMessage({ jobId, ok: false, code: error instanceof DocumentFailure ? error.code : 'worker-exit' });
  } finally {
    parentPort!.close();
  }
});
