// Fixed passive original-byte Office type worker.
import { parentPort } from 'node:worker_threads';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { qualifyOpenXmlAttachment } from './OfficeAttachmentType';

if (!parentPort) throw new Error('Office attachment type worker requires a parent port.');
parentPort.once('message', async (input: { source: string; expansionRatio: number; expansionFloor: number }) => {
  const progress = () => parentPort!.postMessage({ progress: true });
  const heartbeat = setInterval(progress, 1000);
  try {
    const digest = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(input.source)) { digest.update(chunk); bytes += chunk.length; progress(); }
    const type = await qualifyOpenXmlAttachment(input.source, input.expansionRatio, input.expansionFloor, progress);
    parentPort!.postMessage({ ok: true, value: { type, bytes, sha256: digest.digest('hex') } });
  } catch { parentPort!.postMessage({ ok: false, error: 'office-attachment-type-unavailable' }); }
  finally { clearInterval(heartbeat); }
});
