const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Allocation estimate only, never PNG admission. The isolated decoder still validates every chunk and pixel. */
export function pngDecodeAllocationBytes(input: Uint8Array): number {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature) || bytes.readUInt32BE(8) !== 13
    || bytes.toString('ascii', 12, 16) !== 'IHDR') return 0;
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  const depth = bytes[24]; const color = bytes[25]; const interlace = bytes[28];
  const formats: Record<number, { channels: number; depths: number[] }> = {
    0: { channels: 1, depths: [1, 2, 4, 8, 16] }, 2: { channels: 3, depths: [8, 16] },
    3: { channels: 1, depths: [1, 2, 4, 8] }, 4: { channels: 2, depths: [8, 16] }, 6: { channels: 4, depths: [8, 16] },
  };
  const format = formats[color];
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !format?.depths.includes(depth)
    || bytes[26] !== 0 || bytes[27] !== 0 || interlace > 1) return 0;
  // Cover RGBA output and filtered sample bytes (including packed/16-bit/Adam7 rows).
  const pixels = width * height * 4;
  const samples = (Math.ceil(width * format.channels * depth / 8) + 2) * height * (interlace ? 2 : 1);
  const estimate = Math.max(pixels, samples);
  return Number.isSafeInteger(estimate) ? estimate : Number.POSITIVE_INFINITY;
}
