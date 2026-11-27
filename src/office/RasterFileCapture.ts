import { lstat, open, realpath } from 'node:fs/promises';

/** Only host-owned staging files. Check identity, growth and the actual bound before allocating/readback. */
export async function captureRasterFile(file: string, budget: number): Promise<Buffer> {
  const before = await lstat(file);
  if (!Number.isSafeInteger(budget) || budget <= 0 || !before.isFile() || before.isSymbolicLink() || !before.size || before.size > budget || await realpath(file) !== file) throw Error('render-output-unavailable');
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw Error('render-output-changed');
    const bytes = Buffer.allocUnsafe(opened.size);
    for (let offset = 0; offset < bytes.length;) {
      const read = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!read.bytesRead) throw Error('render-output-changed'); offset += read.bytesRead;
    }
    const after = await handle.stat(); const named = await lstat(file);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || named.isSymbolicLink()
      || named.dev !== opened.dev || named.ino !== opened.ino || await realpath(file) !== file) throw Error('render-output-changed');
    return bytes;
  } finally { await handle.close(); }
}
