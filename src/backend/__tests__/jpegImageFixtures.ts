import JSZip from 'jszip';
import { expect } from 'vitest';
import { decodePng } from '../../office/PngDecode';

// Original synthetic 3x2 gray pixels (32,64,96 / 128,160,192), encoded once for tests.
// The development encoder's optional ICC profile was removed. No native encoder is needed to run these tests.
export const PRESENTATION_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAACAAMDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAfEAACAAUFAAAAAAAAAAAAAAAABwMEBggXJzZHU2X/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AqAgLekFhpeaHJ/b8HjSi++Y8QAAf/9k=', 'base64');
/** Original 2x1 baseline Adobe CMYK fixture: one MCU, four constant-128 components.
 * Each block has zero DC difference and AC end-of-block, with one-bit Huffman codes. */
export function cmykJpegFixture(): Buffer {
  const segment = (marker: number, data: Buffer) => {
    const head = Buffer.alloc(4); head.writeUInt16BE(marker); head.writeUInt16BE(data.length + 2, 2);
    return Buffer.concat([head, data]);
  };
  const adobe = Buffer.alloc(12); adobe.write('Adobe'); adobe.writeUInt16BE(100, 5);
  const frame = Buffer.from([8, 0, 1, 0, 2, 4, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 4, 0x11, 0]);
  const counts = Buffer.alloc(16); counts[0] = 1;
  const huffman = Buffer.concat([Buffer.from([0]), counts, Buffer.from([0, 0x10]), counts, Buffer.from([0])]);
  return Buffer.concat([Buffer.from([255, 216]), segment(0xffee, adobe), segment(0xffdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
    segment(0xffc0, frame), segment(0xffc4, huffman), segment(0xffda, Buffer.from([4, 1, 0, 2, 0, 3, 0, 4, 0, 0, 63, 0])),
    Buffer.from([0, 255, 217])]);
}
export function withExifOrientation(orientation: number, bigEndian = false): Buffer {
  const tiff = Buffer.alloc(26); tiff.write(bigEndian ? 'MM' : 'II');
  const u16 = (value: number, at: number) => bigEndian ? tiff.writeUInt16BE(value, at) : tiff.writeUInt16LE(value, at);
  const u32 = (value: number, at: number) => bigEndian ? tiff.writeUInt32BE(value, at) : tiff.writeUInt32LE(value, at);
  u16(42, 2); u32(8, 4); u16(1, 8); u16(274, 10); u16(3, 12); u32(1, 14); u16(orientation, 18);
  const body = Buffer.concat([Buffer.from('Exif\x00\x00', 'binary'), tiff]); const segment = Buffer.alloc(body.length + 4);
  segment.writeUInt16BE(0xffe1); segment.writeUInt16BE(body.length + 2, 2); body.copy(segment, 4);
  // A following unrelated APP1 must not reset EXIF orientation or trigger URL access.
  const xmp = Buffer.from('http://ns.adobe.com/xap/1.0/\x00fixture metadata', 'binary'); const xmpSegment = Buffer.alloc(xmp.length + 4);
  xmpSegment.writeUInt16BE(0xffe1); xmpSegment.writeUInt16BE(xmp.length + 2, 2); xmp.copy(xmpSegment, 4);
  return Buffer.concat([PRESENTATION_JPEG.subarray(0, 2), segment, xmpSegment, PRESENTATION_JPEG.subarray(2)]);
}
export const jpegGrayPixels = (order: readonly number[]) => Uint8Array.from(order.flatMap(index => {
  const shade = (index + 1) * 32; return [shade, shade, shade, 255];
}));
export function withRgbIccProfile(jpeg: Buffer, profile: Buffer): Buffer {
  const data = Buffer.concat([Buffer.from('ICC_PROFILE\x00', 'binary'), Buffer.from([1, 1]), profile]); const segment = Buffer.alloc(data.length + 4);
  segment.writeUInt16BE(0xffe2); segment.writeUInt16BE(data.length + 2, 2); data.copy(segment, 4);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}
export async function readJpegRendition(deck: Buffer) {
  const zip = await JSZip.loadAsync(deck);
  const media = Object.keys(zip.files).filter(name => name.startsWith('ppt/media/') && !zip.files[name].dir);
  expect(media).toHaveLength(1);
  const bytes = await zip.file(media[0])!.async('nodebuffer'); const image = decodePng(bytes, 1048576);
  return { bytes, image, xml: await zip.file('ppt/slides/slide1.xml')!.async('string') };
}
