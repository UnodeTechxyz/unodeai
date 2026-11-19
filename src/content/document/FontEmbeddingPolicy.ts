import { DocumentFailure } from './DocumentContracts';

export interface SfntFaceMetadata {
  faceIndex: number; sfntOffset: number; weightClass: number; fsType: number;
  outlines: 'glyf' | 'cff'; embeddingAllowed: boolean;
}
export const FONT_RESOURCE_LIMITS = Object.freeze({ sourceBytes: 64 * 1024 * 1024, readCount: 64,
  readBytes: 256 * 1024 * 1024, retainedFiles: 12, retainedBytes: 192 * 1024 * 1024, collectionFaces: 64,
  selectedFaces: 16, instances: 32 });

/** Conservative R6 subset policy; missing/unknown flags never mean installable embedding. */
export function fontEmbeddingAllowed(fsType: unknown): boolean { return fsType === 0 || fsType === 0x0008; }

/** Bounded container/directory + OS/2 facts only. The real font parser remains fontkit in the worker. */
export function inspectSfntFaces(bytes: Uint8Array): SfntFaceMetadata[] {
  if (bytes.byteLength > FONT_RESOURCE_LIMITS.sourceBytes) throw new DocumentFailure('font-budget');
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const check = (offset: number, length: number) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > data.length - length) throw new DocumentFailure('font-resource-invalid');
  };
  check(0, 12);
  const u16 = (offset: number) => { check(offset, 2); return data.readUInt16BE(offset); };
  const u32 = (offset: number) => { check(offset, 4); return data.readUInt32BE(offset); };
  // ASCII decoding masks bit 7 in Node; never let a malformed tag alias OS/2 or OTTO.
  const tag = (offset: number) => { check(offset, 4); return data.toString('latin1', offset, offset + 4); };
  let offsets: number[];
  const metadataRanges: Array<{ start: number; end: number }> = [];
  if (tag(0) === 'ttcf') {
    const version = u32(4); const count = u32(8);
    if (version !== 0x00010000 && version !== 0x00020000) throw new DocumentFailure('font-resource-invalid');
    if (!count || count > FONT_RESOURCE_LIMITS.collectionFaces) throw new DocumentFailure('font-budget');
    const headerEnd = 12 + count * 4 + (version === 0x00020000 ? 12 : 0);
    check(12, headerEnd - 12); metadataRanges.push({ start: 0, end: headerEnd });
    offsets = Array.from({ length: count }, (_, i) => u32(12 + i * 4));
    if (new Set(offsets).size !== count || offsets.some(offset => offset < headerEnd || offset % 4 !== 0)) throw new DocumentFailure('font-resource-invalid');
    if (version === 0x00020000) {
      const dsig = 12 + count * 4;
      const length = u32(dsig + 4); const offset = u32(dsig + 8);
      if (length > 0) {
        if (tag(dsig) !== 'DSIG') throw new DocumentFailure('font-resource-invalid');
        check(offset, length); metadataRanges.push({ start: offset, end: offset + length });
      } else if (u32(dsig) !== 0 || offset !== 0) throw new DocumentFailure('font-resource-invalid');
    }
  } else offsets = [0];
  const directories = offsets.map(sfntOffset => {
    check(sfntOffset, 12);
    const signature = u32(sfntOffset);
    if (![0x4f54544f, 0x74727565, 0x00010000].includes(signature)) throw new DocumentFailure('font-resource-invalid');
    const count = u16(sfntOffset + 4);
    if (!count) throw new DocumentFailure('font-resource-invalid');
    check(sfntOffset + 12, count * 16);
    metadataRanges.push({ start: sfntOffset, end: sfntOffset + 12 + count * 16 });
    return { sfntOffset, count, signature };
  });
  const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
  metadataRanges.sort((a, b) => a.start - b.start);
  if (metadataRanges.some((range, i) => i > 0 && overlaps(range, metadataRanges[i - 1]))) throw new DocumentFailure('font-resource-invalid');
  return directories.map(({ sfntOffset, count, signature }, faceIndex) => {
    const tables = new Map<string, { offset: number; length: number }>();
    for (let i = 0; i < count; i++) {
      const entry = sfntOffset + 12 + 16 * i; const name = tag(entry); const offset = u32(entry + 8); const length = u32(entry + 12);
      check(offset, length);
      if (!/^[\x20-\x7e]{4}$/.test(name) || tables.has(name)
        || (length > 0 && metadataRanges.some(range => overlaps(range, { start: offset, end: offset + length })))) throw new DocumentFailure('font-resource-invalid');
      tables.set(name, { offset, length });
    }
    const ranges = [...tables.values()].filter(table => table.length > 0).sort((a, b) => a.offset - b.offset);
    if (ranges.some((table, i) => i > 0 && table.offset < ranges[i - 1].offset + ranges[i - 1].length)) throw new DocumentFailure('font-resource-invalid');
    const os2 = tables.get('OS/2');
    const outlines = signature === 0x4f54544f && tables.has('CFF ') && !tables.has('glyf') ? 'cff'
      : signature !== 0x4f54544f && tables.has('glyf') && !tables.has('CFF ') ? 'glyf' : undefined;
    if (!os2 || os2.length < 10 || !outlines || tables.has('fvar') || tables.has('CFF2') || tables.has('CBDT') || tables.has('EBDT') || tables.has('sbix')) throw new DocumentFailure('font-resource-invalid');
    if (!tables.get(outlines === 'glyf' ? 'glyf' : 'CFF ')!.length) throw new DocumentFailure('font-resource-invalid');
    if (u16(os2.offset) > 5) throw new DocumentFailure('font-resource-invalid');
    const weightClass = u16(os2.offset + 4); const fsType = u16(os2.offset + 8);
    if (weightClass < 1 || weightClass > 1000) throw new DocumentFailure('font-resource-invalid');
    return { faceIndex, sfntOffset, weightClass, fsType, outlines, embeddingAllowed: fontEmbeddingAllowed(fsType) };
  });
}

export function assertFontEmbedding(face: SfntFaceMetadata, style: 'regular' | 'bold'): void {
  if (!face.embeddingAllowed) throw new DocumentFailure('font-embedding-restricted');
  if ((face.weightClass >= 600) !== (style === 'bold')) throw new DocumentFailure('font-unavailable');
}
