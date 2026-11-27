import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runDocumentWorker, workerScript, CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES } from './ContentAssetStore';
import { OFFICE_ATTACHMENT_EXTENSIONS } from './OfficeAttachmentCandidates';
import type { OpenXmlAttachmentType } from './OfficeAttachmentType';

export class OfficeAttachmentFailure extends Error {}
interface Qualified { type: OpenXmlAttachmentType; bytes: number; sha256: string }
/** Host broker imports no parser; it accepts only the fixed worker's byte-bound finite type result. */
export class OfficeAttachmentQualifier {
  constructor(private readonly worker = workerScript('OfficeAttachmentTypeWorker.js')) {}
  async qualify(bytes: Uint8Array, signal?: AbortSignal, current = () => true): Promise<OpenXmlAttachmentType> {
    const live = () => !signal?.aborted && current(); let root: string | undefined;
    try {
      if (!live()) throw new OfficeAttachmentFailure('cancelled');
      if (!this.worker) throw new OfficeAttachmentFailure('worker-unavailable');
      const original = Buffer.from(bytes); const sha256 = createHash('sha256').update(original).digest('hex');
      root = await mkdtemp(join(tmpdir(), 'unode-office-attachment-type-'));
      if (!live()) throw new OfficeAttachmentFailure('cancelled');
      const source = join(root, 'source'); await writeFile(source, original, { flag: 'wx' });
      if (!live()) throw new OfficeAttachmentFailure('cancelled');
      const value = await runDocumentWorker<Qualified>(this.worker, original.length, { source,
        expansionRatio: CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, expansionFloor: CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES }, 'Office attachment', { signal });
      if (!live()) throw new OfficeAttachmentFailure('cancelled');
      if (!value || !OFFICE_ATTACHMENT_EXTENSIONS.includes(value.type) || value.bytes !== original.length || value.sha256 !== sha256) throw new OfficeAttachmentFailure('office-attachment-type-check-failed');
      return value.type;
    } catch (error) {
      if (!live()) throw new OfficeAttachmentFailure('cancelled');
      if (error instanceof OfficeAttachmentFailure) throw error;
      if ((error as NodeJS.ErrnoException)?.code === 'ERR_WORKER_OUT_OF_MEMORY') throw new OfficeAttachmentFailure('out-of-memory');
      throw new OfficeAttachmentFailure('office-attachment-type-unavailable');
    } finally {
      if (root && dirname(resolve(root)) === resolve(tmpdir()) && basename(root).startsWith('unode-office-attachment-type-')) {
        await rm(root, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
