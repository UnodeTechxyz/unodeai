import { describe, expect, it } from 'vitest';
import { inspectSfntFaces } from '../FontEmbeddingPolicy';
import { selectDocumentFontFace } from '../FontFaceSelection';

function fixture(tags = ['OS/2', 'glyf']) {
  const bytes = Buffer.alloc(256); bytes.writeUInt32BE(0x10000); bytes.writeUInt16BE(tags.length, 4);
  for (let i = 0; i < tags.length; i++) {
    const record = 12 + i * 16; const offset = 96 + i * 32;
    bytes.write(tags[i], record, 'latin1'); bytes.writeUInt32BE(offset, record + 8); bytes.writeUInt32BE(16, record + 12);
  }
  bytes.writeUInt16BE(400, 100); bytes.writeUInt16BE(8, 104); return bytes;
}
function collection(version = 0x10000, faces = 2) {
  const bytes = Buffer.alloc(1024); bytes.write('ttcf'); bytes.writeUInt32BE(version, 4); bytes.writeUInt32BE(faces, 8);
  for (let i = 0; i < faces; i++) {
    const offset = 32 + i * 64; bytes.writeUInt32BE(offset, 12 + i * 4); bytes.writeUInt32BE(0x10000, offset); bytes.writeUInt16BE(2, offset + 4);
    for (let table = 0; table < 2; table++) {
      const record = offset + 12 + table * 16; const body = 256 + i * 64 + table * 32;
      bytes.write(table ? 'glyf' : 'OS/2', record); bytes.writeUInt32BE(body, record + 8); bytes.writeUInt32BE(16, record + 12);
    }
    bytes.writeUInt16BE(i ? 700 : 400, 260 + i * 64); bytes.writeUInt16BE(8, 264 + i * 64);
  }
  return bytes;
}

describe('bounded SFNT metadata is not an overlapping or aliased permission record', () => {
  it.each([0, 3, 11, 12, 24, 43, 95, 110])('refuses truncated metadata at %i bytes', size => {
    expect(() => inspectSfntFaces(fixture().subarray(0, size))).toThrow('font-resource-invalid');
  });
  it.each([
    ['table inside directory', (bytes: Buffer) => bytes.writeUInt32BE(12, 20)],
    ['table overlap', (bytes: Buffer) => bytes.writeUInt32BE(100, 36)],
    ['table length overflow', (bytes: Buffer) => bytes.writeUInt32BE(0xffffffff, 24)],
    ['duplicate table tag', (bytes: Buffer) => bytes.write('OS/2', 28)],
    ['empty outline stream', (bytes: Buffer) => bytes.writeUInt32BE(0, 40)],
    ['high-bit table alias', (bytes: Buffer) => { bytes[12] |= 0x80; }],
    ['wrong outline container', (bytes: Buffer) => bytes.write('OTTO')],
    ['invalid OS/2 version', (bytes: Buffer) => bytes.writeUInt16BE(6, 96)],
    ['zero weight', (bytes: Buffer) => bytes.writeUInt16BE(0, 100)],
    ['unknown weight', (bytes: Buffer) => bytes.writeUInt16BE(1001, 100)],
  ] as const)('refuses %s', (_, corrupt) => {
    const bytes = fixture(); corrupt(bytes); expect(() => inspectSfntFaces(bytes)).toThrow('font-resource-invalid');
  });
  it('accepts a bounded CFF directory only with the correct signature; high-bit OTTO is not OTTO', () => {
    const bytes = fixture(['OS/2', 'CFF ']); bytes.write('OTTO');
    expect(inspectSfntFaces(bytes)[0]).toMatchObject({ outlines: 'cff', embeddingAllowed: true });
    bytes[0] |= 0x80; expect(() => inspectSfntFaces(bytes)).toThrow('font-resource-invalid');
  });
  it.each(['fvar', 'CFF2', 'CBDT', 'EBDT', 'sbix'])('refuses unsupported %s tables before full parsing', tag => {
    expect(() => inspectSfntFaces(fixture(['OS/2', 'glyf', tag]))).toThrow('font-resource-invalid');
  });
  it('refuses two outline formats rather than choosing whichever table is inspected first', () => {
    expect(() => inspectSfntFaces(fixture(['OS/2', 'glyf', 'CFF ']))).toThrow('font-resource-invalid');
  });
  it('permits exact shared TTC tables, but not a table inside another face directory', () => {
    const bytes = collection();
    bytes.writeUInt32BE(256, 116); bytes.writeUInt32BE(288, 132);
    expect(inspectSfntFaces(bytes).map(face => face.weightClass)).toEqual([400, 400]);
    bytes.writeUInt32BE(32, 116); expect(() => inspectSfntFaces(bytes)).toThrow('font-resource-invalid');
  });
  it('accounts for the entire v2 header including DSIG fields', () => {
    const bytes = collection(0x20000, 1);
    expect(inspectSfntFaces(bytes)).toHaveLength(1);
    bytes.writeUInt32BE(20, 12); expect(() => inspectSfntFaces(bytes)).toThrow('font-resource-invalid');
  });
  it('rejects aliased/overlapping TTC directories and malformed DSIG ranges', () => {
    const duplicate = collection(); duplicate.writeUInt32BE(32, 16);
    expect(() => inspectSfntFaces(duplicate)).toThrow('font-resource-invalid');
    const overlapping = collection(); overlapping.writeUInt32BE(48, 16);
    expect(() => inspectSfntFaces(overlapping)).toThrow('font-resource-invalid');
    const dsig = collection(0x20000, 1); dsig.write('DSIG', 16); dsig.writeUInt32BE(8, 20); dsig.writeUInt32BE(32, 24);
    expect(() => inspectSfntFaces(dsig)).toThrow('font-resource-invalid');
    dsig.writeUInt32BE(1000, 24); expect(inspectSfntFaces(dsig)).toHaveLength(1);
    dsig.writeUInt32BE(0, 20); expect(() => inspectSfntFaces(dsig)).toThrow('font-resource-invalid');
  });
  it('rejects duplicate collection PostScript names even if only one face has the requested weight', () => {
    const bytes = collection(); const regular = { postscriptName: 'SamePS', familyName: 'Family', layout() {} };
    const bold = { ...regular }; const calls: unknown[] = [];
    const kit = { create: (_: Uint8Array, name?: string) => { calls.push(name); return name ? regular : { fonts: [regular, bold] }; } };
    expect(() => selectDocumentFontFace(kit, bytes, { family: 'Family', style: 'bold' })).toThrow('font-resource-invalid');
    expect(calls).toEqual([undefined]);
  });
});
