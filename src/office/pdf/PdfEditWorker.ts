// First: the text-only PDF.js runtime (geometry DOMMatrix, no native canvas binary) for this isolated worker.
import '../../content/PdfjsTextRuntime';
import { parentPort } from 'node:worker_threads';
import { PdfEditFailure, isPdfEditCode } from './PdfEditContracts';
import { runPdfEdit, type PdfEngineInput } from './PdfEditEngine';
import { pdfjsTextPort } from './PdfTextLayer';

export interface PdfEditWorkerRequest { input: PdfEngineInput }

if (!parentPort) throw new Error('PDF edit worker requires a parent port.');
parentPort.once('message', async (request: PdfEditWorkerRequest) => {
  // A sign of life while the event loop turns and one per page read, as for the PDF text worker.
  const alive = () => parentPort!.postMessage({ progress: true });
  const heartbeat = setInterval(alive, 1_000);
  try {
    // The fake-worker handler is imported first so PDF.js never looks for a sibling worker file.
    const text = pdfjsTextPort(async () => { await import('pdfjs-dist/legacy/build/pdf.worker.mjs'); return await import('pdfjs-dist/legacy/build/pdf.mjs') as any; }, alive);
    const result = await runPdfEdit(request.input, text);
    parentPort!.postMessage({ ok: true, value: result });
  } catch (error) {
    // Finite codes only; a PDF's own text never travels in an error.
    const code = error instanceof PdfEditFailure && isPdfEditCode(error.message) ? error.message : error instanceof RangeError ? 'out-of-memory' : 'pdf-edit-failed';
    const issue = error instanceof PdfEditFailure ? error.inputIssue : undefined;
    parentPort!.postMessage({ ok: false, error: JSON.stringify({ code, ...(issue ? { issue: { location: issue.location.slice(0, 200), issue: issue.issue.slice(0, 500) } } : {}) }) });
  } finally {
    clearInterval(heartbeat);
    parentPort!.close();
  }
});
