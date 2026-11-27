import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import UPNG from '@pdf-lib/upng';

export interface DecodedPng { width: number; height: number; pixels: Uint8Array; sha256: string }
export class ImageDecodeFailure extends Error {
  constructor(public readonly code: 'invalid-image' | 'unsupported-image' | 'out-of-memory') { super(code); }
}
const invalid = (): never => { throw new ImageDecodeFailure('invalid-image'); };
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** Actual static-PNG pixel decode, not MIME/magic admission. Effectful native rendering isolates it in its pure worker. */
export function decodePng(input: Uint8Array, memoryBudget: number): DecodedPng {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) return invalid();
  let offset = 8; let width = 0; let height = 0; let depth = 0; let colorType = -1; let interlace = -1;
  let header = false; let palette: Buffer | undefined; let transparency = false; let dataStarted = false;
  let dataEnded = false; let ended = false;
  const compressed: Buffer[] = []; const decodeChunks: Buffer[] = [signature];
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) return invalid();
    const length = bytes.readUInt32BE(offset);
    if (length > 0x7fffffff || length > bytes.length - offset - 12) return invalid();
    const end = offset + length + 12;
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    if ([...typeBytes].some(byte => byte < 65 || byte > 122 || (byte > 90 && byte < 97)) || (typeBytes[2] & 32)) return invalid();
    const type = typeBytes.toString('ascii');
    const body = bytes.subarray(offset + 8, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return invalid();
    if (!header && type !== 'IHDR') return invalid();
    if (dataStarted && type !== 'IDAT') dataEnded = true;
    if (type === 'IHDR') {
      if (header || length !== 13) return invalid();
      header = true; width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; colorType = body[9]; interlace = body[12];
      const allowed: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !allowed[colorType]?.includes(depth)
        || body[10] !== 0 || body[11] !== 0 || interlace > 1) return invalid();
      const pixelBytes = width * height * 4;
      if (!Number.isSafeInteger(pixelBytes) || !Number.isFinite(memoryBudget) || pixelBytes > memoryBudget) throw new ImageDecodeFailure('out-of-memory');
      decodeChunks.push(bytes.subarray(offset, end));
    } else if (type === 'PLTE') {
      if (palette || transparency || dataStarted || !length || length % 3 || length > 768 || colorType === 0 || colorType === 4) return invalid();
      palette = body;
      if (colorType === 3 && length / 3 > 2 ** depth) return invalid();
      decodeChunks.push(bytes.subarray(offset, end));
    } else if (type === 'tRNS') {
      if (transparency || dataStarted || (colorType === 0 ? length !== 2 : colorType === 2 ? length !== 6
        : colorType === 3 ? !palette || length > palette.length / 3 : true)) return invalid();
      transparency = true; decodeChunks.push(bytes.subarray(offset, end));
    } else if (type === 'IDAT') {
      if (dataEnded || (colorType === 3 && !palette)) return invalid();
      dataStarted = true; compressed.push(body); decodeChunks.push(bytes.subarray(offset, end));
    } else if (type === 'IEND') {
      if (length || !dataStarted || end !== bytes.length) return invalid();
      ended = true; decodeChunks.push(bytes.subarray(offset, end));
    } else if (['acTL', 'fcTL', 'fdAT'].includes(type)) {
      throw new ImageDecodeFailure('unsupported-image');
    } else if (!(typeBytes[0] & 32)) return invalid();
    // The pixel decoder does not parse/decompress irrelevant text, ICC profiles or EXIF chunks.
    offset = end;
  }
  if (!ended) return invalid();
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bitsPerPixel = channels[colorType] * depth;
  const passes = interlace === 0 ? [[0, 0, 1, 1]] : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const rows = passes.map(([x, y, dx, dy]) => ({ width: Math.max(0, Math.ceil((width - x) / dx)), height: Math.max(0, Math.ceil((height - y) / dy)) }))
    .filter(pass => pass.width && pass.height).map(pass => ({ ...pass, bytes: Math.ceil(pass.width * bitsPerPixel / 8) }));
  const expected = rows.reduce((sum, row) => sum + (row.bytes + 1) * row.height, 0);
  if (!Number.isSafeInteger(expected) || expected > memoryBudget) throw new ImageDecodeFailure('out-of-memory');
  let inflated: Buffer;
  try { inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 }); } catch (error) {
    if ((error instanceof RangeError && (error as NodeJS.ErrnoException).code !== 'ERR_BUFFER_TOO_LARGE')
      || (error as NodeJS.ErrnoException)?.code === 'ERR_MEMORY_ALLOCATION_FAILED') throw new ImageDecodeFailure('out-of-memory');
    return invalid();
  }
  if (inflated.length !== expected) return invalid();
  let cursor = 0;
  for (const pass of rows) for (let y = 0; y < pass.height; y++) {
    if (inflated[cursor] > 4) return invalid(); cursor += pass.bytes + 1;
  }
  try {
    const canonical = Buffer.concat(decodeChunks);
    const data = UPNG.decode(canonical.buffer.slice(canonical.byteOffset, canonical.byteOffset + canonical.byteLength));
    if (colorType === 3) {
      const samples = new Uint8Array(data.data);
      const stride = Math.ceil(width * depth / 8);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const bit = x * depth;
        const index = (samples[y * stride + (bit >>> 3)] >>> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        if (index >= palette!.length / 3) return invalid();
      }
    }
    const frames = UPNG.toRGBA8(data);
    if (frames.length !== 1 || data.width !== width || data.height !== height || frames[0].byteLength !== width * height * 4) return invalid();
    return { width, height, pixels: new Uint8Array(frames[0]), sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if (error instanceof ImageDecodeFailure) throw error;
    if (error instanceof RangeError || (error as NodeJS.ErrnoException)?.code === 'ERR_MEMORY_ALLOCATION_FAILED') throw new ImageDecodeFailure('out-of-memory');
    return invalid();
  }
}
