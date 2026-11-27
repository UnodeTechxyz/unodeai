import { createHash } from 'node:crypto';
import UPNG from '@pdf-lib/upng';
import { decodePng } from './PngDecode';

export interface OfficeImagePreview {
  bytes: Uint8Array; sha256: string; width: number; height: number;
  original_sha256: string; original_width: number; original_height: number;
  resized: boolean; reencoded: boolean;
}
/** Pure-worker preparation only. The original asset is retained separately; these are transport previews. */
export function officeImagePreview(input: Uint8Array, memoryBudget: number, maxBytes: number): OfficeImagePreview {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 5 * 1024 * 1024) throw Error('render-preview-invalid-budget');
  const image = decodePng(input, memoryBudget);
  const facts = { original_sha256: image.sha256, original_width: image.width, original_height: image.height };
  if (input.byteLength <= maxBytes) return { ...facts, bytes: input, sha256: image.sha256, width: image.width, height: image.height, resized: false, reencoded: false };
  let width = image.width; let height = image.height;
  for (;;) {
    let pixels = image.pixels;
    if (width !== image.width || height !== image.height) {
      pixels = new Uint8Array(width * height * 4);
      // Premultiplied-alpha bilinear sampling avoids dark borders around transparent illustrations.
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const sx = Math.max(0, (x + 0.5) * image.width / width - 0.5); const sy = Math.max(0, (y + 0.5) * image.height / height - 0.5);
        const x0 = Math.floor(sx); const y0 = Math.floor(sy); const dx = sx - x0; const dy = sy - y0;
        const samples = [[x0, y0, (1 - dx) * (1 - dy)], [Math.min(x0 + 1, image.width - 1), y0, dx * (1 - dy)],
          [x0, Math.min(y0 + 1, image.height - 1), (1 - dx) * dy], [Math.min(x0 + 1, image.width - 1), Math.min(y0 + 1, image.height - 1), dx * dy]];
        let alpha = 0; const color = [0, 0, 0];
        for (const [px, py, weight] of samples) {
          const at = (py * image.width + px) * 4; const a = image.pixels[at + 3] / 255 * weight; alpha += a;
          for (let c = 0; c < 3; c++) color[c] += image.pixels[at + c] * a;
        }
        const target = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) pixels[target + c] = alpha ? Math.round(color[c] / alpha) : 0;
        pixels[target + 3] = Math.round(alpha * 255);
      }
    }
    const buffer = pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength) as ArrayBuffer;
    const bytes = new Uint8Array(UPNG.encode([buffer], width, height, 0));
    if (bytes.byteLength <= maxBytes) {
      const decoded = decodePng(bytes, memoryBudget);
      if (decoded.width !== width || decoded.height !== height) throw Error('render-preview-invalid-output');
      return { ...facts, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), width, height,
        resized: width !== image.width || height !== image.height, reencoded: true };
    }
    if (width === 1 && height === 1) throw Error('render-preview-transport-bound');
    const scale = Math.min(0.75, Math.sqrt(maxBytes / bytes.byteLength) * 0.9);
    width = Math.max(1, Math.floor(width * scale)); height = Math.max(1, Math.floor(height * scale));
  }
}
