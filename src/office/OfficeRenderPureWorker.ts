import { parentPort } from 'node:worker_threads';
import { makeOfficeRenderCopy } from './OfficeRenderCopy';
import { decodePng } from './PngDecode';
import { officeImagePreview } from './OfficeImagePreview';
import { OFFICE_RENDER_PURE_ERROR, type OfficeRenderPureRequest } from './OfficeRenderPureContracts';

if (!parentPort) throw Error('Render copy/image worker requires a parent port.');
parentPort.once('message', async (job: OfficeRenderPureRequest) => {
  try {
    const value = job.operation === 'copy' && typeof job.source === 'string'
      ? await makeOfficeRenderCopy(job.source, () => {}, job.memoryBudget)
      : job.operation === 'png' && job.bytes instanceof Uint8Array
        ? (() => { const image = decodePng(job.bytes, job.memoryBudget); return { sha256: image.sha256, width: image.width, height: image.height }; })()
        : job.operation === 'preview' && job.bytes instanceof Uint8Array
          ? officeImagePreview(job.bytes, job.memoryBudget, job.maxBytes)
        : undefined;
    if (!value) throw Error('render-worker-request-invalid');
    parentPort!.postMessage({ id: job.id, ok: true, value });
  } catch (error) {
    const code = error instanceof RangeError ? 'out-of-memory'
      : error instanceof Error && OFFICE_RENDER_PURE_ERROR.test(error.message) ? error.message : 'render-worker-failed';
    parentPort!.postMessage({ id: job.id, ok: false, code });
  } finally { parentPort!.close(); }
});
