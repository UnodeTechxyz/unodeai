import UPNG from '@pdf-lib/upng';
import { decodePng } from '../PngDecode';
import type { PdfSignatureRecord } from './PdfSignatureStore';

/**
 * 13.13: hide UnodeAi-placed signatures in a page image before it can be registered for a model. Each record's
 * visible rectangle (plus a small margin) is filled white with a grey frame. Returns the re-encoded PNG.
 */
export function maskSignatureRegions(png: Buffer, records: readonly Pick<PdfSignatureRecord, 'rect' | 'page_size'>[], memoryBudget: number): Buffer {
  const decoded = decodePng(png, memoryBudget); const pixels = Buffer.from(decoded.pixels); const { width, height } = decoded;
  for (const record of records) {
    const sx = width / record.page_size[0]; const sy = height / record.page_size[1]; const margin = 2;
    const x0 = Math.max(0, Math.floor(record.rect[0] * sx) - margin); const y0 = Math.max(0, Math.floor(record.rect[1] * sy) - margin);
    const x1 = Math.min(width, Math.ceil((record.rect[0] + record.rect[2]) * sx) + margin); const y1 = Math.min(height, Math.ceil((record.rect[1] + record.rect[3]) * sy) + margin);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const edge = x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1; const at = (y * width + x) * 4;
      pixels[at] = pixels[at + 1] = pixels[at + 2] = edge ? 128 : 255; pixels[at + 3] = 255;
    }
  }
  return Buffer.from(UPNG.encode([pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength)], width, height, 0));
}
