import UPNG from '@pdf-lib/upng';
import JSZip from 'jszip';
import { expect } from 'vitest';
import { presentationInput } from './presentationRouteFixtures';
import { deflateSync } from 'node:zlib';

export const PRESENTATION_PIXELS = Uint8Array.from([255, 0, 0, 255, 0, 128, 255, 128]);
export const PRESENTATION_PNG = Buffer.from(UPNG.encode([PRESENTATION_PIXELS.buffer], 2, 1, 0));
export function solidScreenshotPng(width: number, height: number): Buffer {
  const crc = require('buffer-crc32') as { unsigned(bytes: Buffer): number };
  const chunk = (type: string, data: Buffer) => {
    const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4, 4, 'ascii');
    data.copy(bytes, 8); bytes.writeUInt32BE(crc.unsigned(bytes.subarray(4, -4)), bytes.length - 4); return bytes;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const row = Buffer.alloc(width * 4 + 1);
  for (let x = 0; x < width; x++) { row[x * 4 + 1] = 24; row[x * 4 + 2] = 48; row[x * 4 + 3] = 72; row[x * 4 + 4] = 255; }
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(raw, y * row.length);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export function presentationWithImage(assetRef: string) {
  const input = presentationInput() as Record<string, any>;
  input.deck.slides[0].objects.push({ type: 'image', asset_ref: assetRef, altText: 'Two color pixels', x: 1, y: 1, w: 4, h: 4 });
  return input;
}
export async function assertOriginalPngEmbedded(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const media = Object.keys(zip.files).filter(name => name.startsWith('ppt/media/') && !zip.files[name].dir);
  expect(media).toHaveLength(1);
  expect(await zip.file(media[0])!.async('nodebuffer')).toEqual(PRESENTATION_PNG);
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  expect(xml).toContain('descr="Two color pixels"');
  expect(xml).toContain('<a:off x="914400" y="1828800"/>');
  expect(xml).toContain('<a:ext cx="3657600" cy="1828800"/>');
}
