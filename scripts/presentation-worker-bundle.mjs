import assert from 'node:assert/strict';
import { isBuiltin } from 'node:module';

export const PRESENTATION_WORKER_ENTRY = 'src/office/PresentationWorker.ts';

export function assertPresentationWorkerBundleGraph(metafile) {
  const outputs = Object.values(metafile.outputs).filter(output =>
    output.entryPoint?.replaceAll('\\', '/').endsWith(PRESENTATION_WORKER_ENTRY));
  assert.equal(outputs.length, 1, 'The presentation worker must have exactly one bundled entry');
  for (const input of Object.keys(outputs[0].inputs)) {
    assert(!/\.node$|(?:^|\/)@napi-rs\/|(?:^|\/)canvas\//i.test(input.replaceAll('\\', '/')),
      'The presentation worker must not bundle native/canvas inputs');
  }
  for (const imported of outputs[0].imports) {
    assert(!imported.external || isBuiltin(imported.path), 'The presentation worker must bundle runtime packages');
  }
}
