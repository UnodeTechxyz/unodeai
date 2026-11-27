import { readFile } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import type { PdfPageExtraction } from './ContentAssetStore';
// The text-only PDF.js runtime (geometry DOMMatrix, no native canvas) is shared with the PDF edit worker.
import './PdfjsTextRuntime';

if (!parentPort) {
  throw new Error('PDF worker requires a parent port.');
}

parentPort.once('message', async (request: { path: string; range: { start: number; end: number } }) => {
  // v0.9.99: a sign of life while the event loop turns, and one per page read. The host ends a parse only when both
  // stop for its stall period, so a slow parse that keeps going is never ended for being slow.
  const heartbeat = setInterval(() => parentPort!.postMessage({ progress: true }), 1_000);
  try {
    // Kept inside this worker: the extension host never parses untrusted PDF objects or follows embedded
    // links/attachments. PDF.js receives bytes only (no URL, no range transport, no scripting surface).
    // The Node display API uses its in-process "fake worker" for parsing. Import the handler first so
    // PDF.js's supported globalThis.pdfjsWorker hook is populated inside this bundle; otherwise it tries
    // to load a sibling pdf.worker.mjs file that the single-file worker deliberately does not ship.
    await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const bytes = new Uint8Array(await readFile(request.path));
    const task = pdfjs.getDocument({
      data: bytes,
      disableFontFace: true,
      isEvalSupported: false,
      useWorkerFetch: false,
      stopAtErrors: true,
    });
    const document = await task.promise;
    const totalPages = document.numPages;
    const pages: PdfPageExtraction[] = [];
    for (let number = request.range.start; number <= Math.min(request.range.end, totalPages); number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent({ includeMarkedContent: false });
      const text = content.items
        .flatMap((item) => 'str' in item && typeof item.str === 'string' ? [item.str] : [])
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      pages.push({ page: number, text: text || undefined, truncated: false, ocrRequired: !text });
      parentPort!.postMessage({ progress: true });
    }
    await document.destroy();
    parentPort!.postMessage({ ok: true, value: { totalPages, pages } });
  } catch (error) {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    clearInterval(heartbeat);
    // This is a one-request worker. Closing its port lets it exit naturally after the reply is delivered;
    // forcibly terminating a still-unwinding PDF.js worker can take down its parent process on Windows.
    parentPort!.close();
  }
});
