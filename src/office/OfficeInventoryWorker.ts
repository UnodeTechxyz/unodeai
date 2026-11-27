import { parentPort } from 'node:worker_threads';
import { indexOfficePackage, type OfficeInventoryManifest } from './OfficeInventory';
import { officeInventoryPage } from './OfficeInventoryPage';
import type { CellPosition, PageBudget } from '../content/WorkbookPage';
import type { WordView } from './word/WordRevisionViews';

export type OfficeInventoryWorkerRequest = { operation: 'parse'; source: string; directory: string; snapshot: string; expansionRatio: number; expansionFloor: number }
  | { operation: 'page'; directory: string; manifest: OfficeInventoryManifest; snapshot: string; start: CellPosition; cursor: string; budget: PageBudget; view?: WordView };
if (!parentPort) throw new Error('Office inventory worker requires a parent port.');
parentPort.once('message', async (request: OfficeInventoryWorkerRequest) => {
  let last = 0;
  const progress = () => { const now = Date.now(); if (now - last >= 250) { last = now; parentPort!.postMessage({ progress: true }); } };
  const heartbeat = setInterval(progress, 1000);
  try {
    const value = request.operation === 'parse'
      ? await indexOfficePackage(request.source, request.directory, request.snapshot, request.expansionRatio, request.expansionFloor, progress)
      : officeInventoryPage(request.directory, request.manifest, request.snapshot, request.start, request.cursor, request.budget, request.view);
    parentPort!.postMessage({ ok: true, value });
  } catch (error) {
    const errorCode = error instanceof RangeError ? 'out-of-memory' : error instanceof Error
      && ['invalid-cursor', 'invalid-budget', 'route-bound-too-small', 'unsupported-office-package', 'office-expansion-budget'].includes(error.message) ? error.message : 'invalid-office-package';
    parentPort!.postMessage({ ok: false, error: errorCode });
  } finally { clearInterval(heartbeat); parentPort!.close(); }
});
