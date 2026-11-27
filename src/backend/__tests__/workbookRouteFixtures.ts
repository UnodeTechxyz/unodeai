import { build } from 'esbuild';
import { join } from 'node:path';
import { WorkbookReader } from '../../content/WorkbookReader';
import { WorkbookEditor } from '../../office/WorkbookEditor';
import { temporaryFolder } from './pathSafetyFixtures';
export async function workbookRouteReader() {
  const root = await temporaryFolder('unode-workbook-worker-'); const worker = join(root, 'WorkbookWorker.cjs');
  const result = await build({ entryPoints: ['src/content/WorkbookWorker.ts'], outfile: worker, bundle: true,
    platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent', metafile: true });
  const { assertWorkbookWorkerBundleGraph } = await import('../../../scripts/workbook-worker-bundle.mjs');
  assertWorkbookWorkerBundleGraph(result.metafile); return new WorkbookReader(worker);
}
/** v0.9.108: the actual Office edit worker bundle serves the workbook writers. */
export async function workbookRouteEditor() {
  const root = await temporaryFolder('unode-workbook-edit-worker-'); const worker = join(root, 'OfficeEditWorker.cjs');
  const result = await build({ entryPoints: ['src/office/OfficeEditWorker.ts'], outfile: worker, bundle: true,
    platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent', metafile: true });
  const { assertOfficeEditWorkerBundleGraph } = await import('../../../scripts/office-edit-worker-bundle.mjs');
  assertOfficeEditWorkerBundleGraph(result.metafile); return new WorkbookEditor(worker);
}
