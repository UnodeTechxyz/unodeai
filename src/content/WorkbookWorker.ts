import { parentPort } from 'node:worker_threads';
import { parseCsvSnapshot, CsvInputFailure, type CsvOptions, type CsvManifest } from './CsvWorkbook';
import { readCsvPage, type CellPosition, type WorkbookRange, type PageBudget } from './WorkbookPage';
import { parseXlsxSnapshot, type XlsxManifest } from './XlsxWorkbook';
import { readXlsxPage } from './XlsxPage';
import { inspectXlsxPage } from './XlsxInspectPage';
import { executeWorkbookTransform, type WorkbookTransformInput, type WorkbookTransformManifest } from './WorkbookTransform';
import type { WorkbookTransformPlan } from './WorkbookTransformPlan';
import { readWorkbookTransformPage } from './WorkbookTransformPage';

export type WorkbookWorkerRequest = { operation: 'parse'; source: string; directory: string; options: CsvOptions; format?: 'csv' | 'xlsx' }
  | { operation: 'transform'; directory: string; inputs: WorkbookTransformInput[]; plan: WorkbookTransformPlan }
  | { operation: 'transform-page'; directory: string; manifest: WorkbookTransformManifest; transformationRef: string; dataRef: string; start: CellPosition; cursor: string; budget: PageBudget }
  | { operation: 'xlsx-page'; directory: string; source: XlsxManifest; sheetId: string; range: WorkbookRange; start: CellPosition;
    snapshotRef: string; cursor: string; budget: PageBudget; visibility: 'all' | 'visible-only' }
  | { operation: 'xlsx-inspect'; directory: string; source: XlsxManifest; start: CellPosition; snapshotRef: string; cursor: string; budget: PageBudget }
  | { operation: 'page'; directory: string; source: CsvManifest; range: WorkbookRange; start: CellPosition;
    snapshotRef: string; cursor: string; budget: PageBudget };

if (!parentPort) throw new Error('Workbook worker requires a parent port.');
parentPort.once('message', async (request: WorkbookWorkerRequest) => {
  let last = 0;
  const progress = () => { const now = Date.now(); if (now - last >= 250) { last = now; parentPort!.postMessage({ progress: true }); } };
  const heartbeat = setInterval(progress, 1000);
  try {
    const value = request.operation === 'parse'
      ? request.format === 'xlsx' ? await parseXlsxSnapshot(request.source, request.directory, progress)
        : await parseCsvSnapshot(request.source, request.directory, request.options, progress)
      : request.operation === 'transform' ? await executeWorkbookTransform(request.directory, request.inputs, request.plan, progress)
      : request.operation === 'transform-page' ? readWorkbookTransformPage(request.directory, request.manifest, request.transformationRef, request.dataRef, request.start, request.cursor, request.budget, progress)
      : request.operation === 'xlsx-inspect' ? inspectXlsxPage(request.directory, request.source, request.start, request.snapshotRef, request.cursor, request.budget)
      : request.operation === 'xlsx-page' ? readXlsxPage(request.directory, request.source, request.source.sheets.find(sheet => sheet.sheetId === request.sheetId)!,
        request.range, request.start, request.snapshotRef, request.cursor, request.visibility, request.budget, progress)
      : await readCsvPage(request.directory, request.source, request.range, request.start, request.snapshotRef, request.cursor, request.budget, progress);
    parentPort!.postMessage({ ok: true, value });
  } catch (error) {
    const code = error instanceof CsvInputFailure ? error.code : error instanceof RangeError ? 'out-of-memory'
      : error instanceof Error && ['invalid-range', 'invalid-cursor', 'route-bound-too-small', 'unavailable-worksheet', 'unsupported-workbook-package', 'invalid-transform-plan',
        'unknown-transform-column', 'invalid-source-selection', 'snapshot-unavailable', 'ambiguous-or-nonnumeric-literal', 'division-by-zero', 'arithmetic-resource-budget'].includes(error.message) ? error.message
      : request.operation.startsWith('transform') ? 'transform-failed'
      : request.operation.startsWith('xlsx') || (request.operation === 'parse' && request.format === 'xlsx') ? 'invalid-xlsx' : 'invalid-csv';
    parentPort!.postMessage({ ok: false, error: code });
  } finally { clearInterval(heartbeat); parentPort!.close(); }
});
