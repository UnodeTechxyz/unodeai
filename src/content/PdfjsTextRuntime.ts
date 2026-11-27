/** Imported for its effect, first, by each isolated PDF.js worker. Never imported by the extension host. */
import { DOMMatrix as GeometryDOMMatrix } from '@napi-rs/canvas/geometry.js';

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
