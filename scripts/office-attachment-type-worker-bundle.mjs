import assert from 'node:assert/strict';
import { isBuiltin } from 'node:module';
export const OFFICE_ATTACHMENT_TYPE_WORKER_ENTRY = 'src/content/OfficeAttachmentTypeWorker.ts';
export function assertOfficeAttachmentTypeWorkerBundleGraph(metafile) {
  const outputs = Object.values(metafile.outputs).filter(output => output.entryPoint?.replaceAll('\\', '/').endsWith(OFFICE_ATTACHMENT_TYPE_WORKER_ENTRY));
  assert.equal(outputs.length, 1, 'The Office attachment type worker must have one bundled entry');
  for (const input of Object.keys(outputs[0].inputs)) assert(!/\.node$|(?:^|\/)@napi-rs\/|(?:^|\/)canvas\//i.test(input.replaceAll('\\', '/')), 'The Office attachment type worker must not bundle native/canvas inputs');
  for (const imported of outputs[0].imports) assert(!imported.external || isBuiltin(imported.path), 'The Office attachment type worker must bundle runtime packages');
}
