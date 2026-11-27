/** Frame dimensions only for worker allocation. This never admits or decodes a JPEG. */
export function jpegDecodeAllocationBytes(input: Uint8Array): number {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return 0;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) return 0;
    while (offset < bytes.length && bytes[offset] === 255) offset++;
    if (offset >= bytes.length) return 0;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return 0;
    if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (bytes.length - offset < 2) return 0;
    const length = bytes.readUInt16BE(offset); if (length < 2 || length > bytes.length - offset) return 0;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8 || bytes[offset + 2] !== 8) return 0;
      const height = bytes.readUInt16BE(offset + 3); const width = bytes.readUInt16BE(offset + 5);
      return width * height * 4;
    }
    offset += length;
  }
  return 0;
}
