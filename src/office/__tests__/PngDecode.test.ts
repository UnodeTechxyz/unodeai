import { describe, expect, it } from 'vitest';
import { inflateSync, deflateSync } from 'node:zlib';
import { decodePng } from '../PngDecode';
import { PRESENTATION_PNG, PRESENTATION_PIXELS } from '../../backend/__tests__/presentationImageFixtures';

describe('actual static PNG pixel qualification', () => {
  it('decodes color and alpha values, checks CRC, and uses the supplied real memory budget', () => {
    const image = decodePng(PRESENTATION_PNG, 1048576);
    expect(image.pixels).toEqual(PRESENTATION_PIXELS); expect(image).toMatchObject({ width: 2, height: 1 });
    const broken = Buffer.from(PRESENTATION_PNG); broken[broken.length - 1] ^= 1;
    expect(() => decodePng(broken, 1048576)).toThrow('invalid-image');
    expect(() => decodePng(PRESENTATION_PNG, 1)).toThrow('out-of-memory');
  });
  it('rejects invalid filters even with valid chunk CRC and zlib checksum', () => {
    const crc = require('buffer-crc32') as { unsigned(bytes: Buffer): number };
    const chunks = [PRESENTATION_PNG.subarray(0, 8)];
    for (let offset = 8; offset < PRESENTATION_PNG.length;) {
      const length = PRESENTATION_PNG.readUInt32BE(offset); const end = offset + length + 12;
      const type = PRESENTATION_PNG.subarray(offset + 4, offset + 8);
      if (type.toString() === 'IDAT') {
        const raw = inflateSync(PRESENTATION_PNG.subarray(offset + 8, end - 4)); raw[0] = 5;
        const data = deflateSync(raw); const chunk = Buffer.alloc(data.length + 12);
        chunk.writeUInt32BE(data.length); type.copy(chunk, 4); data.copy(chunk, 8);
        chunk.writeUInt32BE(crc.unsigned(chunk.subarray(4, -4)), chunk.length - 4); chunks.push(chunk);
      } else chunks.push(PRESENTATION_PNG.subarray(offset, end));
      offset = end;
    }
    expect(() => decodePng(Buffer.concat(chunks), 1048576)).toThrow('invalid-image');
  });
});
