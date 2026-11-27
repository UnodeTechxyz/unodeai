import { parentPort } from 'node:worker_threads';
import { DocumentFailure } from '../content/document/DocumentContracts';
import { validatePresentationRequest, type PresentationImageInput } from './PresentationContracts';
import { ImageDecodeFailure } from './PngDecode';
import { buildPresentation } from './PresentationBuild';
import type { WorkbookBindingInput } from '../content/WorkbookBinding';
import { PresentationDataFailure } from './PresentationDataFailure';

if (!parentPort) throw new Error('Presentation worker requires a parent port.');
parentPort.once('message', async (input: { jobId?: unknown; deck?: unknown; images?: Array<{ assetRef: string; sha256: string; bytes: Uint8Array }>; bindings?: WorkbookBindingInput[] }) => {
  const jobId = typeof input?.jobId === 'string' ? input.jobId : '';
  try {
    if (!jobId) throw new DocumentFailure('invalid-input');
    const request = validatePresentationRequest({ schema_version: 1, path: 'render.pptx', deck: input.deck });
    if (input.images !== undefined && !Array.isArray(input.images)) throw new DocumentFailure('invalid-input');
    const images: PresentationImageInput[] = (input.images ?? []).map(image => {
      if (!image || typeof image.assetRef !== 'string' || !/^content-[1-9]\d*$/.test(image.assetRef)
        || typeof image.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(image.sha256) || !(image.bytes instanceof Uint8Array)) throw new DocumentFailure('invalid-input');
      return { ...image, bytes: Buffer.from(image.bytes) };
    });
    if (input.bindings !== undefined && !Array.isArray(input.bindings)) throw new DocumentFailure('invalid-input');
    const result = await buildPresentation(request.deck, images, input.bindings);
    const bytes = Uint8Array.from(result.bytes).buffer;
    parentPort!.postMessage({ jobId, ok: true, bytes, slides: result.slides, images: result.images, dataBindings: result.dataBindings, chartBindings: result.chartBindings }, [bytes]);
  } catch (error) {
    parentPort!.postMessage({ jobId, ok: false, code: error instanceof DocumentFailure ? error.code
      : error instanceof ImageDecodeFailure ? error.code === 'out-of-memory' ? 'out-of-memory' : 'invalid-input' : 'worker-exit',
      ...(error instanceof PresentationDataFailure ? { dataIssue: error.dataIssue } : {}),
      ...(error instanceof ImageDecodeFailure ? { imageIssue: error.code } : {}) });
  } finally { parentPort!.close(); }
});
