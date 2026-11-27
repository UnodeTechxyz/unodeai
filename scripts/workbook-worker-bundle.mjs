import assert from 'node:assert/strict';
import { isBuiltin } from 'node:module';
export const WORKBOOK_WORKER_ENTRY = 'src/content/WorkbookWorker.ts';
export function assertWorkbookWorkerBundleGraph(metafile) {
  const outputs = Object.values(metafile.outputs).filter(output => output.entryPoint?.replaceAll('\\', '/').endsWith(WORKBOOK_WORKER_ENTRY));
  assert.equal(outputs.length, 1, 'The workbook worker must have one bundled entry');
  for (const input of Object.keys(outputs[0].inputs)) {
    assert(!/\.node$|(?:^|\/)@napi-rs\/|(?:^|\/)canvas\//i.test(input.replaceAll('\\', '/')), 'The workbook worker must not bundle native/canvas inputs');
  }
  for (const imported of outputs[0].imports) assert(!imported.external || isBuiltin(imported.path), 'The workbook worker must bundle runtime packages');
}
