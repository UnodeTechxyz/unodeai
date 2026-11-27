import { describe, expect, it, vi } from 'vitest';
import { decodeJpeg } from '../JpegDecode';
import { cmykJpegFixture, jpegGrayPixels, PRESENTATION_JPEG, withExifOrientation } from '../../backend/__tests__/jpegImageFixtures';
import { jpegDecodeAllocationBytes } from '../JpegMemory';
import { inflateSync } from 'node:zlib';

describe('existing pure-JS JPEG codec qualification', () => {
  it('decodes a valid four-component CMYK JPEG without network and reports approximate color honestly', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('unexpected network'); });
    const oldWarn = console.warn;
    try {
      const result = decodeJpeg(cmykJpegFixture(), 1048576);
      expect(result).toMatchObject({ width: 2, height: 1, colorProfile: 'unverified' });
      expect(result.pixels).toHaveLength(8); expect(result.pixels[3]).toBe(255); expect(result.pixels[7]).toBe(255);
      expect(result.pixels.slice(0, 4)).toEqual(result.pixels.slice(4));
      expect(fetch).not.toHaveBeenCalled(); expect(console.warn).toBe(oldWarn);
    } finally { fetch.mockRestore(); }
  });
  it('retains ordered RGB ICC bytes in the PNG rendition without interpreting profile metadata as instructions', () => {
    // A header-shaped synthetic payload verifies opaque preservation, not color-management quality.
    const profile = Buffer.alloc(132); profile.writeUInt32BE(profile.length); profile.write('RGB ', 16); profile.write('acsp', 36);
    const app2 = (sequence: number, bytes: Buffer) => {
      const data = Buffer.concat([Buffer.from('ICC_PROFILE\x00', 'binary'), Buffer.from([sequence, 2]), bytes]); const segment = Buffer.alloc(data.length + 4);
      segment.writeUInt16BE(0xffe2); segment.writeUInt16BE(data.length + 2, 2); data.copy(segment, 4); return segment;
    };
    const source = Buffer.concat([PRESENTATION_JPEG.subarray(0, 2), app2(2, profile.subarray(66)), app2(1, profile.subarray(0, 66)), PRESENTATION_JPEG.subarray(2)]);
    const result = decodeJpeg(source, 1048576); expect(result.colorProfile).toBe('preserved-rgb');
    let found: Buffer | undefined;
    for (let offset = 8; offset < result.png.length;) {
      const length = result.png.readUInt32BE(offset); const type = result.png.toString('ascii', offset + 4, offset + 8);
      if (type === 'iCCP') { const body = result.png.subarray(offset + 8, offset + 8 + length); found = inflateSync(body.subarray(body.indexOf(0) + 2)); }
      offset += length + 12;
    }
    expect(found).toEqual(profile); expect(result.pixels).toEqual(jpegGrayPixels([0, 1, 2, 3, 4, 5]));
  });
  it.each([
    [1, [0, 1, 2, 3, 4, 5], 3, 2], [2, [2, 1, 0, 5, 4, 3], 3, 2],
    [3, [5, 4, 3, 2, 1, 0], 3, 2], [4, [3, 4, 5, 0, 1, 2], 3, 2],
    [5, [0, 3, 1, 4, 2, 5], 2, 3], [6, [3, 0, 4, 1, 5, 2], 2, 3],
    [7, [5, 2, 4, 1, 3, 0], 2, 3], [8, [2, 5, 1, 4, 0, 3], 2, 3],
  ] as const)('normalizes EXIF orientation %i in actual decoded pixels', (orientation, order, width, height) => {
    const bytes = withExifOrientation(orientation, orientation % 2 === 0);
    const decoded = decodeJpeg(bytes, 1048576);
    expect(decoded).toMatchObject({ width, height, orientation }); expect(decoded.pixels).toEqual(jpegGrayPixels(order));
    expect(jpegDecodeAllocationBytes(bytes)).toBe(24);
  });
  it('decodes without network or repair, rejects truncated scans, and restores private worker diagnostics', () => {
    const oldFetch = globalThis.fetch; const fetch = vi.fn(() => { throw new Error('unexpected network'); }); globalThis.fetch = fetch;
    const oldLog = console.log; const oldWarn = console.warn;
    try {
      expect(decodeJpeg(PRESENTATION_JPEG, 1048576).pixels).toEqual(jpegGrayPixels([0, 1, 2, 3, 4, 5]));
      expect(() => decodeJpeg(PRESENTATION_JPEG.subarray(0, -2), 1048576)).toThrow('invalid-image');
      expect(() => decodeJpeg(PRESENTATION_JPEG, 1)).toThrow('out-of-memory');
      expect(fetch).not.toHaveBeenCalled(); expect(console.log).toBe(oldLog); expect(console.warn).toBe(oldWarn);
    } finally { globalThis.fetch = oldFetch; }
  });
});
