import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertFontEmbedding, fontEmbeddingAllowed, inspectSfntFaces } from '../FontEmbeddingPolicy';
import { FontResourceBroker } from '../FontResourceBroker';
import { bindPdfFontAdapter, positionedPdfGlyphs, type DocumentFontFace } from '../PdfFontAdapter';
import { systemFontCandidates } from '../SystemFontCandidates';
import { selectDocumentFontFace } from '../FontFaceSelection';

function sfnt(fsType = 8, weight = 400) {
  const bytes = Buffer.alloc(80); bytes.writeUInt32BE(0x10000); bytes.writeUInt16BE(2, 4);
  bytes.write('OS/2', 12, 'ascii'); bytes.writeUInt32BE(48, 20); bytes.writeUInt32BE(12, 24);
  bytes.write('glyf', 28, 'ascii'); bytes.writeUInt32BE(64, 36); bytes.writeUInt32BE(4, 40);
  bytes.writeUInt16BE(weight, 52); bytes.writeUInt16BE(fsType, 56); return bytes;
}
describe('font resource and embedding boundaries', () => {
  it('selects the named collection face, including a single-face TTC, but never passes a selector to a TTF', () => {
    const one = sfnt(); const collection = Buffer.alloc(100); collection.write('ttcf', 0, 'ascii');
    collection.writeUInt32BE(0x10000, 4); collection.writeUInt32BE(1, 8); collection.writeUInt32BE(20, 12);
    one.copy(collection, 20); collection.writeUInt32BE(68, 40); collection.writeUInt32BE(84, 56);
    const face = { familyName: 'Family', postscriptName: 'FamilyPS', layout() {} };
    const calls: unknown[] = [];
    const kit = { create: (bytes: Uint8Array, name?: string) => {
      calls.push(name); return Buffer.from(bytes).toString('ascii', 0, 4) === 'ttcf' && !name ? { fonts: [face] } : face;
    } };
    expect(selectDocumentFontFace(kit, collection, { postscriptName: 'FamilyPS', style: 'regular' }).face).toBe(face);
    expect(calls).toEqual([undefined, 'FamilyPS']); calls.length = 0;
    expect(selectDocumentFontFace(kit, one, { postscriptName: 'FamilyPS', style: 'regular' }).face).toBe(face);
    expect(calls).toEqual([undefined]);
    expect(() => selectDocumentFontFace(kit, collection, { postscriptName: 'OtherPS', style: 'regular' })).toThrow('font-resource-invalid');
  });
  it('allows only known installable/editable subset embedding policies', () => {
    expect([0, 8].map(fontEmbeddingAllowed)).toEqual([true, true]);
    for (const flags of [undefined, null, -1, 1, 2, 4, 6, 10, 12, 0x100, 0x200, 0x8000]) expect(fontEmbeddingAllowed(flags)).toBe(false);
    const face = inspectSfntFaces(sfnt())[0];
    expect(face).toMatchObject({ fsType: 8, weightClass: 400, outlines: 'glyf', embeddingAllowed: true });
    expect(() => assertFontEmbedding(face, 'bold')).toThrow('font-unavailable');
    expect(() => assertFontEmbedding(inspectSfntFaces(sfnt(4))[0], 'regular')).toThrow('font-embedding-restricted');
  });
  it('rejects absent/invalid OS2, variable/unsupported containers and unbounded offsets', () => {
    const offset = sfnt(); offset.writeUInt32BE(0xffffffff, 20);
    expect(() => inspectSfntFaces(offset)).toThrow('font-resource-invalid');
    const missing = sfnt(); missing.write('name', 12, 'ascii');
    expect(() => inspectSfntFaces(missing)).toThrow('font-resource-invalid');
    const woff = sfnt(); woff.write('wOFF', 0, 'ascii');
    expect(() => inspectSfntFaces(woff)).toThrow('font-resource-invalid');
    const collection = Buffer.alloc(12); collection.write('ttcf', 0, 'ascii'); collection.writeUInt32BE(0x10000, 4); collection.writeUInt32BE(65, 8);
    expect(() => inspectSfntFaces(collection)).toThrow('font-budget');
  });
  it('reads only exact one-shot job candidates into standalone buffers and refuses workspace resources', async () => {
    // A candidate must equal its real path, and a runner's TEMP can be an 8.3 short name.
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'unode-font-proof-')));
    try {
      const file = join(directory, 'font.ttf'); await writeFile(file, sfnt());
      const job = { jobId: 'job-A', signal: new AbortController().signal, isCurrent: () => true,
        candidates: [file], forbiddenRoots: [] as string[] };
      const broker = new FontResourceBroker(job); const token = broker.issueCandidate(file);
      await expect(broker.read('job-B', token)).rejects.toMatchObject({ code: 'font-resource-invalid' });
      const read = await broker.read('job-A', token);
      expect(read.bytes.byteLength).toBe(80); expect(Buffer.from(read.bytes)).toEqual(sfnt());
      await expect(broker.read('job-A', token)).rejects.toMatchObject({ code: 'font-resource-invalid' });
      expect(() => broker.issueCandidate(join(directory, 'other.ttf'))).toThrow('font-resource-invalid');
      await broker.close();
      await expect(broker.read('job-A', token)).rejects.toMatchObject({ code: 'cancelled' });
      expect(() => new FontResourceBroker({ ...job, forbiddenRoots: [directory] }).issueCandidate(file)).toThrow('font-resource-invalid');
      const mutable = { ...job, candidates: [file] };
      const frozen = new FontResourceBroker(mutable); mutable.candidates.push(join(directory, 'other.ttf'));
      expect(() => frozen.issueCandidate(join(directory, 'other.ttf'))).toThrow('font-resource-invalid');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('does not invent remote desktop or unmeasured platform fonts', () => {
    expect(systemFontCandidates('linux', '/fonts', 'ja', 'bold')).toEqual([]);
    expect(systemFontCandidates('darwin', '/fonts', 'zh-Hant', 'regular')).toEqual([]);
    expect(systemFontCandidates('win32', 'C:/Windows/Fonts', 'ja', 'bold')[0]).toMatchObject({ family: 'Yu Gothic', style: 'bold' });
  });
});

describe('public bound font adapter and glyph positioning', () => {
  it('keeps each façade’s script/language binding and gives fontkit a fresh feature object on every call', () => {
    const calls: any[] = [];
    const face = { unitsPerEm: 1000, layout: (text: string, features: any, script: string, language: string, direction: string) => {
      calls.push({ text, script, language, direction, kern: features.kern }); features.kern = true;
      return { glyphs: [{ id: 1, advanceWidth: 500 }], positions: [{ xAdvance: 500, yAdvance: 0, xOffset: 20, yOffset: 30 }] };
    } } as DocumentFontFace;
    const french = bindPdfFontAdapter(face, 'latn', 'FRA '); const japanese = bindPdfFontAdapter(face, 'hani', 'JAN ');
    french.fontkit.create().layout('é', {}, '', '', ''); japanese.fontkit.create().layout('契', {}, '', '', ''); french.layout('x');
    expect(calls.map(call => [call.script, call.language, call.kern])).toEqual([['latn', 'FRA ', false], ['hani', 'JAN ', false], ['latn', 'FRA ', false]]);
  });
  it('applies actual x/y offsets and advances, not glyph default widths', () => {
    const run = { glyphs: [{ id: 10, advanceWidth: 700 }, { id: 11, advanceWidth: 700 }], positions: [
      { xAdvance: 500, yAdvance: 5, xOffset: 20, yOffset: 30 }, { xAdvance: 400, yAdvance: 0, xOffset: -10, yOffset: 8 },
    ] };
    expect(positionedPdfGlyphs(run, '00010002', 1000, 10, 100, 200)).toEqual([
      { glyphId: 10, cidHex: '0001', x: 100.2, y: 200.3 }, { glyphId: 11, cidHex: '0002', x: 104.9, y: 200.13 },
    ]);
    expect(() => positionedPdfGlyphs(run, '0001', 1000, 10, 0, 0)).toThrow('font-resource-invalid');
  });
});
