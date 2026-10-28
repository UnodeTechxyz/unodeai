import assert from 'node:assert/strict';
import { isBuiltin } from 'node:module';

export const DOCUMENT_WORKER_ENTRY = 'src/content/document/DocumentRenderWorker.ts';

/** Check the generation worker's own graph, not PDF.js's separate extraction worker. */
export function assertDocumentWorkerBundleGraph(metafile) {
  const outputs = Object.values(metafile.outputs).filter(output =>
    output.entryPoint?.replaceAll('\\', '/').endsWith(DOCUMENT_WORKER_ENTRY));
  assert.equal(outputs.length, 1, 'The document generation worker must have exactly one bundled entry');
  for (const input of Object.keys(outputs[0].inputs)) {
    assert(!/\.node$|(?:^|\/)@napi-rs\/|(?:^|\/)canvas\//i.test(input.replaceAll('\\', '/')),
      'The document generation worker must not bundle native/canvas inputs');
  }
  for (const imported of outputs[0].imports) {
    assert(!imported.external || isBuiltin(imported.path), 'The document generation worker must not resolve external runtime packages');
  }
}
