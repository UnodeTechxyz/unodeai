/*---------------------------------------------------------------------------------------------
 *  UnodeAi - the CLI closure hashing worker (v0.9.97)
 *  Streams SHA-256 over the files it is given, one after another, off the extension host's thread. It only reads:
 *  it starts no program and opens nothing for writing. A link, a file that is not regular, a file replaced or
 *  changed while it is read, or more bytes than allowed ends the run with a failure instead of an answer.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';

const CHUNK_BYTES = 1024 * 1024;

if (!parentPort) {
  throw new Error('The CLI hashing worker requires a parent port.');
}

parentPort.once('message', async (request: { files: string[]; maxBytes: number }) => {
  try {
    const files: Array<{ size: number; sha256: string }> = [];
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let total = 0;
    for (const file of request.files) {
      const named = await lstat(file, { bigint: true });
      if (!named.isFile()) throw new Error(`${file} is not a regular file`);
      const handle = await open(file, 'r');
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) throw new Error(`${file} was replaced while it was opened`);
        const hash = createHash('sha256');
        let size = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, size);
          if (bytesRead === 0) break;
          size += bytesRead;
          total += bytesRead;
          if (total > request.maxBytes) throw new Error('the program files are larger than UnodeAi checks');
          hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await handle.stat({ bigint: true });
        if (BigInt(size) !== opened.size || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) {
          throw new Error(`${file} changed while it was read`);
        }
        files.push({ size, sha256: hash.digest('hex') });
      } finally {
        await handle.close();
      }
    }
    parentPort!.postMessage({ ok: true, files });
  } catch (error) {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
