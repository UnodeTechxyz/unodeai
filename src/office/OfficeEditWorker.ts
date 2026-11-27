import { parentPort } from 'node:worker_threads';
import { editOfficePackage } from './OfficeEdits';
import { OfficeEditFailure, type OfficeEditInput } from './OfficeEditContracts';
import { OfficeTextFailure } from './OfficeTextPatch';
import { ImageDecodeFailure } from './PngDecode';
import { WorkbookEditFailure, isWorkbookEditCode, type WorkbookEditInput, type WorkbookCreateInput } from './WorkbookEditContracts';
import { editWorkbookPackage } from './WorkbookEdits';
import { createWorkbookPackage } from './WorkbookCreate';
import { scanWorkbookForRecalc, readRecalculatedCopy, writeRecalculatedCache, stripRecalcCopy, type WorkbookRecalcWorkerInput } from './WorkbookRecalcPackage';

/** One fixed worker serves Office and workbook package writers; the request kind selects the writer, never code. */
export type OfficeEditWorkerRequest = { input: OfficeEditInput; expansionRatio: number; expansionFloor: number }
  | { workbook: { operation: 'edit'; input: WorkbookEditInput } | { operation: 'create'; input: WorkbookCreateInput } | { operation: 'recalc'; input: WorkbookRecalcWorkerInput };
    expansionRatio: number; expansionFloor: number };
if (!parentPort) throw new Error('Office edit worker requires a parent port.');
parentPort.once('message', async (request: OfficeEditWorkerRequest) => {
  let last = 0;
  const progress = () => { const now = Date.now(); if (now - last >= 250) { last = now; parentPort!.postMessage({ progress: true }); } };
  const heartbeat = setInterval(progress, 1000);
  if ('workbook' in request) {
    try {
      const { workbook, expansionRatio: ratio, expansionFloor: floor } = request;
      const value = workbook.operation === 'edit' ? await editWorkbookPackage(workbook.input, ratio, floor, progress)
        : workbook.operation === 'create' ? await createWorkbookPackage(workbook.input, ratio, floor, progress)
          : workbook.input.operation === 'recalc-scan' ? await scanWorkbookForRecalc(workbook.input, ratio, floor, progress)
            : workbook.input.operation === 'recalc-read' ? await readRecalculatedCopy(workbook.input, progress)
              : workbook.input.operation === 'recalc-strip' ? await stripRecalcCopy(workbook.input, ratio, floor, progress)
              : await writeRecalculatedCache(workbook.input, ratio, floor, progress);
      parentPort!.postMessage({ ok: true, value });
    } catch (error) {
      // The model-facing location of an input issue crosses the worker boundary as data; any other failure is only its code.
      const known = error instanceof WorkbookEditFailure && isWorkbookEditCode(error.message);
      const code = error instanceof RangeError ? 'out-of-memory' : known ? error.message
        : error instanceof Error && ['unsupported-xml-dtd', 'unsupported-xml-encoding'].includes(error.message) ? error.message
          : error instanceof Error && ['office-expansion-budget', 'corrupt-office-part', 'encrypted-office-part', 'invalid-office-zip'].includes(error.message) ? 'unsupported-workbook-package' : 'workbook-edit-failed';
      const issue = known ? (error as WorkbookEditFailure).inputIssue : undefined;
      parentPort!.postMessage({ ok: false, error: issue ? JSON.stringify({ code, issue }) : code });
    } finally { clearInterval(heartbeat); parentPort!.close(); }
    return;
  }
  try { parentPort!.postMessage({ ok: true, value: await editOfficePackage(request.input, request.expansionRatio, request.expansionFloor, progress) }); }
  catch (error) {
    const known = new Set(['invalid-office-edits', 'source-changed', 'unsupported-edit-target', 'unsupported-word-picture', 'unsupported-word-region', 'unsupported-control-text', 'unsupported-bookmark-text', 'edit-target-unavailable', 'donor-presentation-required', 'invalid-office-content-types',
      'macro-edit-unavailable', 'unsupported-package-preservation', 'office-preservation-check-failed', 'unsupported-xml-dtd', 'unsupported-xml-encoding',
      'unsupported-text-child', 'invalid-text-opening', 'unsupported-text-controls', 'unsupported-field-line-break', 'empty-text-match',
      'text-not-found', 'text-match-crosses-structural-control', 'edited-text-check-failed', 'invalid-image', 'unsupported-image', 'image-unavailable', 'picture-geometry-unavailable', 'office-output-check-failed', 'snapshot-unavailable', 'invalid-chart-data', 'chart-source-unavailable',
      'edit-not-trackable', 'overlaps-foreign-revision', 'revision-not-decidable', 'track-changes-unsupported-kind', 'word-id-space-exhausted', 'comment-anchor-ambiguous']);
    parentPort!.postMessage({ ok: false, error: error instanceof RangeError ? 'out-of-memory'
      : error instanceof ImageDecodeFailure ? error.code
      : (error instanceof OfficeEditFailure || error instanceof OfficeTextFailure) && known.has(error.message) ? error.message : 'office-edit-failed' });
  } finally { clearInterval(heartbeat); parentPort!.close(); }
});
