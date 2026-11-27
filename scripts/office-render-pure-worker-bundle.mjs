import assert from 'node:assert/strict';
import { isBuiltin } from 'node:module';
export const OFFICE_RENDER_PURE_WORKER_ENTRY = 'src/office/OfficeRenderPureWorker.ts';
export function assertOfficeRenderPureWorkerBundleGraph(metafile) {
  const outputs = Object.values(metafile.outputs).filter(output => output.entryPoint?.replaceAll('\\', '/').endsWith(OFFICE_RENDER_PURE_WORKER_ENTRY));
  assert.equal(outputs.length, 1, 'The pure render copy/PNG worker must have one entry');
  for (const input of Object.keys(outputs[0].inputs)) assert(!/\.node$|(?:^|\/)@napi-rs\/|(?:^|\/)canvas\//i.test(input.replaceAll('\\', '/')), 'The pure worker must not bundle native/canvas inputs');
  for (const imported of outputs[0].imports) {
    assert(!imported.external || isBuiltin(imported.path), 'Pure render worker runtime packages must be bundled');
    assert(!/^(?:node:)?child_process$/.test(imported.path), 'The pure worker must never own native child processes');
  }
}
