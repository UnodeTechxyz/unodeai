import { readFile } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import { DOMMatrix as GeometryDOMMatrix } from '@napi-rs/canvas/geometry.js';
import type { PdfPageExtraction } from './ContentAssetStore';

interface NodeModuleLoader {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}

// The packaged worker intentionally does not ship @napi-rs/canvas's platform-specific native binary:
// PDF extraction only needs PDF.js's text path, not a rendering canvas. PDF.js nevertheless constructs
// an identity DOMMatrix while its display module initializes. Its normal Node fallback loads DOMMatrix
// from the native canvas entry point, which is unavailable after the worker is bundled into the VSIX.
// Use the dependency's standalone JavaScript geometry implementation instead; this keeps the worker
// portable while providing PDF.js the complete matrix API rather than a text-path-specific stub.
if (Reflect.get(globalThis, 'DOMMatrix') === undefined) {
  Reflect.set(globalThis, 'DOMMatrix', GeometryDOMMatrix);
}

// pdfjs-dist's Node bootstrap tries to require the full @napi-rs/canvas package even when DOMMatrix is
// already present. That loads skia's native .node binary, which text extraction never uses and whose
// repeated worker unloads intermittently terminate the parent process with 0xC0000005 on Windows/Node 25.
// This isolated one-shot worker needs only the package's pure-JavaScript geometry subpath imported above.
// Return an explicit text-only stub inside this worker. This avoids loading the native binary without making
// PDF.js print misleading "rendering may be broken" bootstrap warnings; any accidental rendering attempt still
// fails closed. The extension host's module loader is not affected.
const nodeModule = require('node:module') as NodeModuleLoader;
const originalModuleLoad = nodeModule._load;
const unsupportedRendering = (): never => {
  throw new Error('Canvas rendering is unavailable in the UnodeAi text-extraction worker.');
};
class UnsupportedImageData { constructor() { unsupportedRendering(); } }
class UnsupportedPath2D { constructor() { unsupportedRendering(); } }
const textOnlyCanvas = Object.freeze({
  DOMMatrix: GeometryDOMMatrix,
  ImageData: UnsupportedImageData,
  Path2D: UnsupportedPath2D,
  createCanvas: unsupportedRendering,
});
nodeModule._load = function loadWithoutNativeCanvas(request: string, parent: unknown, isMain: boolean): unknown {
  if (request === '@napi-rs/canvas') {
    return textOnlyCanvas;
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

if (!parentPort) {
  throw new Error('PDF worker requires a parent port.');
}

parentPort.once('message', async (request: { path: string; range: { start: number; end: number } }) => {
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
    }
    await document.destroy();
    parentPort!.postMessage({ ok: true, value: { totalPages, pages } });
  } catch (error) {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    // This is a one-request worker. Closing its port lets it exit naturally after the reply is delivered;
    // forcibly terminating a still-unwinding PDF.js worker can take down its parent process on Windows.
    parentPort!.close();
  }
});
