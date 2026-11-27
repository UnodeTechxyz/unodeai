import { createHash } from 'node:crypto';
import UPNG from '@pdf-lib/upng';
import { deflateSync } from 'node:zlib';
import { JpegImage, getVerbosityLevel, setVerbosityLevel, VerbosityLevel } from 'pdfjs-dist/image_decoders/pdf.image_decoders.mjs';
import { ImageDecodeFailure, crc32 } from './PngDecode';

const invalid = (): never => { throw new ImageDecodeFailure('invalid-image'); };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function decodeFailure(error: unknown): never {
  if (error instanceof ImageDecodeFailure) throw error;
  if (error instanceof RangeError || (error as NodeJS.ErrnoException)?.code === 'ERR_MEMORY_ALLOCATION_FAILED') throw new ImageDecodeFailure('out-of-memory');
  return invalid();
}

/** EXIF is data only. An absent/unreadable optional orientation uses the encoded pixel order. */
function orientationFromExif(body: Buffer): number | undefined {
  if (body.length < 14 || body.subarray(0, 6).toString('binary') !== 'Exif\x00\x00') return undefined;
  const tiff = body.subarray(6); const little = tiff.toString('ascii', 0, 2) === 'II';
  if (!little && tiff.toString('ascii', 0, 2) !== 'MM') return undefined;
  const u16 = (at: number) => little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
  const u32 = (at: number) => little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
  if (u16(2) !== 42) return undefined;
  const first = u32(4); if (first > tiff.length - 2) return undefined;
  const count = u16(first); if (count > Math.floor((tiff.length - first - 2) / 12)) return undefined;
  for (let index = 0; index < count; index++) {
    const at = first + 2 + index * 12;
    if (u16(at) === 274 && u16(at + 2) === 3 && u32(at + 4) === 1) {
      const orientation = u16(at + 8); return orientation >= 1 && orientation <= 8 ? orientation : undefined;
    }
  }
  return undefined;
}

function header(bytes: Buffer): { width: number; height: number; orientation: number; components: number; profile?: Buffer; profilePresent: boolean } {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return invalid();
  let offset = 2; let width = 0; let height = 0; let orientation = 1; let oriented = false; let scans = 0; let ended = false;
  let components = 0;
  const profiles = new Map<number, Buffer>(); let profileCount = 0; let profilePresent = false; let badProfile = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) return invalid();
    while (offset < bytes.length && bytes[offset] === 255) offset++;
    if (offset >= bytes.length) return invalid();
    const marker = bytes[offset++];
    if (marker === 0xd9) { ended = true; break; }
    if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0 || marker === 0xd8 || bytes.length - offset < 2) return invalid();
    const length = bytes.readUInt16BE(offset); if (length < 2 || length > bytes.length - offset) return invalid();
    const body = bytes.subarray(offset + 2, offset + length); offset += length;
    if (marker === 0xe1 && !oriented) {
      const exif = orientationFromExif(body); if (exif !== undefined) { orientation = exif; oriented = true; }
    }
    if (marker === 0xe2 && body.subarray(0, 12).toString('binary') === 'ICC_PROFILE\x00') {
      profilePresent = true;
      if (body.length < 14 || !body[12] || !body[13] || body[12] > body[13] || profiles.has(body[12]) || (profileCount && profileCount !== body[13])) badProfile = true;
      else { profileCount = body[13]; profiles.set(body[12], body.subarray(14)); }
    }
    if ([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) throw new ImageDecodeFailure('unsupported-image');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (body.length < 6 || width) return invalid();
      if (body[0] !== 8) throw new ImageDecodeFailure('unsupported-image');
      height = body.readUInt16BE(1); width = body.readUInt16BE(3);
      components = body[5];
      if (![1, 3, 4].includes(components)) throw new ImageDecodeFailure('unsupported-image');
      if (!width || !height) return invalid();
    }
    if (marker === 0xda) {
      scans++;
      // Scan entropy until an unstuffed, non-restart marker; the outer loop validates the next segment.
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) { offset++; continue; }
        let next = offset + 1; while (next < bytes.length && bytes[next] === 255) next++;
        if (next >= bytes.length) return invalid();
        if (bytes[next] === 0 || (bytes[next] >= 0xd0 && bytes[next] <= 0xd7)) { offset = next + 1; continue; }
        break;
      }
    }
  }
  if (!ended || !width || !height || !scans) return invalid();
  let profile: Buffer | undefined;
  if (profilePresent && !badProfile && profiles.size === profileCount && components === 3) {
    const bytes = Buffer.concat(Array.from({ length: profileCount }, (_, index) => profiles.get(index + 1)!));
    if (bytes.length >= 128 && bytes.readUInt32BE(0) === bytes.length && bytes.toString('ascii', 16, 20) === 'RGB '
      && bytes.toString('ascii', 36, 40) === 'acsp') profile = bytes;
  }
  return { width, height, orientation, components, profile, profilePresent };
}

function withRgbProfile(png: Buffer, profile: Buffer): Buffer {
  const data = Buffer.concat([Buffer.from('JPEG ICC\x00\x00', 'binary'), deflateSync(profile)]);
  const chunk = Buffer.alloc(data.length + 12); chunk.writeUInt32BE(data.length); chunk.write('iCCP', 4, 4, 'ascii'); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  // iCCP belongs after IHDR and before PLTE/IDAT. This retains encoded RGB values in their original profile.
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}

/** Pure JS full JPEG decode in the private worker; no browser/native decoder or remote input. */
export function decodeJpeg(input: Uint8Array, memoryBudget: number) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const size = header(bytes); const count = size.width * size.height;
  if (!Number.isSafeInteger(count * 4) || !Number.isFinite(memoryBudget) || count * 4 > memoryBudget) throw new ImageDecodeFailure('out-of-memory');
  const verbosity = getVerbosityLevel(); const oldLog = console.log; const oldWarn = console.warn;
  let warned = false;
  let rgb: Uint8ClampedArray;
  try {
    // Repairs are not a verified complete decode. Diagnostics stay private and never include image data in a receipt.
    setVerbosityLevel(VerbosityLevel.WARNINGS);
    console.log = console.warn = (...diagnostic: unknown[]) => {
      // The pinned standalone decoder uses its built-in DeviceCMYK conversion without optional ICC WASM.
      // This exact configuration notice is not a scan repair. No fetch/optional WASM is enabled here.
      if (size.components === 4 && diagnostic.length === 1
        && diagnostic[0] === 'Warning: No ICC color space support due to missing `wasmUrl` API option') return;
      warned = true;
    };
    const decoder = new JpegImage(); decoder.parse(bytes);
    if (decoder.width !== size.width || decoder.height !== size.height) return invalid();
    rgb = decoder.getData({ width: size.width, height: size.height, forceRGB: true, isSourcePDF: false });
    if (warned || rgb.length !== count * 3) return invalid();
  } catch (error) { return decodeFailure(error); }
  finally { console.log = oldLog; console.warn = oldWarn; setVerbosityLevel(verbosity); }
  try {
    const swap = size.orientation >= 5; const width = swap ? size.height : size.width; const height = swap ? size.width : size.height;
    const pixels = new Uint8Array(count * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sx = x; let sy = y;
      switch (size.orientation) {
        case 2: sx = size.width - 1 - x; break;
        case 3: sx = size.width - 1 - x; sy = size.height - 1 - y; break;
        case 4: sy = size.height - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = size.height - 1 - x; break;
        case 7: sx = size.width - 1 - y; sy = size.height - 1 - x; break;
        case 8: sx = size.width - 1 - y; sy = x; break;
      }
      const from = (sy * size.width + sx) * 3; const to = (y * width + x) * 4;
      pixels[to] = rgb[from]; pixels[to + 1] = rgb[from + 1]; pixels[to + 2] = rgb[from + 2]; pixels[to + 3] = 255;
    }
    let png: Buffer = Buffer.from(UPNG.encode([pixels.buffer], width, height, 0));
    if (size.profile) png = withRgbProfile(png, size.profile);
    const colorProfile = size.profile ? 'preserved-rgb' as const : size.profilePresent || size.components === 4 ? 'unverified' as const : 'none' as const;
    return { width, height, pixels, png, sha256: hash(bytes), embeddedSha256: hash(png), orientation: size.orientation, colorProfile };
  } catch (error) { return decodeFailure(error); }
}
