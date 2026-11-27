import assert from 'node:assert/strict';
import { isBuiltin } from 'node:module';
export const OFFICE_INVENTORY_WORKER_ENTRY = 'src/office/OfficeInventoryWorker.ts';
export function assertOfficeInventoryWorkerBundleGraph(metafile) {
  const outputs = Object.values(metafile.outputs).filter(output => output.entryPoint?.replaceAll('\\', '/').endsWith(OFFICE_INVENTORY_WORKER_ENTRY));
  assert.equal(outputs.length, 1, 'The Office inventory worker must have one bundled entry');
  for (const input of Object.keys(outputs[0].inputs)) {
    assert(!/\.node$|(?:^|\/)@napi-rs\/|(?:^|\/)canvas\//i.test(input.replaceAll('\\', '/')), 'The Office inventory worker must not bundle native/canvas inputs');
  }
  for (const imported of outputs[0].imports) assert(!imported.external || isBuiltin(imported.path), 'The Office inventory worker must bundle runtime packages');
}
