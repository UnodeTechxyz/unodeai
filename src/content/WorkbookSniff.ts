import { sniffContent } from '../contentSniff';

/** Two ASCII characters alone are ordinary CSV headers too. Require the corresponding binary structure. */
export function workbookBinaryLabel(bytes: Buffer): string | undefined {
  const label = sniffContent(bytes).label;
  if (label === 'BMP image') {
    if (bytes.length < 26) return undefined;
    const size = bytes.readUInt32LE(2); const pixels = bytes.readUInt32LE(10); const header = bytes.readUInt32LE(14);
    return [12, 16, 40, 52, 56, 64, 108, 124].includes(header) && pixels >= 14 + header && pixels <= bytes.length
      && (size === 0 || (size >= pixels && size <= bytes.length)) ? label : undefined;
  }
  if (label === 'Windows executable') {
    if (bytes.length < 28) return undefined;
    const last = bytes.readUInt16LE(2); const pages = bytes.readUInt16LE(4); const header = bytes.readUInt16LE(8) * 16;
    const size = pages * 512 - (last ? 512 - last : 0); const relocation = bytes.readUInt16LE(24);
    return pages > 0 && last < 512 && header >= 28 && header <= size && size <= bytes.length
      && relocation >= 28 && relocation + bytes.readUInt16LE(6) * 4 <= header ? label : undefined;
  }
  return label;
}
