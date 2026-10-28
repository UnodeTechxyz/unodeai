import { DocumentFailure } from './DocumentContracts';
import { Readable } from 'node:stream';
import type { SfntFaceMetadata } from './FontEmbeddingPolicy';

export const DOCUMENT_FONT_FEATURES = Object.freeze({ ccmp: true, locl: true, rlig: true, mark: true, mkmk: true,
  ljmo: true, vjmo: true, tjmo: true, liga: false, clig: false, dlig: false, hlig: false, calt: false, rclt: false,
  kern: false, frac: false, numr: false, dnom: false, tnum: false, pnum: false, onum: false, lnum: false,
  zero: false, sups: false, subs: false, vert: false, vrt2: false, fwid: false, hwid: false, pwid: false, halt: false, vhal: false });
export interface DocumentGlyph { id: number; advanceWidth: number; path?: unknown }
export interface PositionedGlyphRun {
  glyphs: DocumentGlyph[];
  positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
}

/** Finite compatibility surface for unmodified fontkit 2.0.4 and pdf-lib 1.17.1.
 * SFNT flag facts come from the selected source bytes, not private fontkit table objects. */
export function bindSubsetPdfFontAdapter(face: DocumentFontFace, bytes: Uint8Array, metadata: SfntFaceMetadata,
  script: string, language: string) {
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map<string, Buffer>();
  const count = source.readUInt16BE(metadata.sfntOffset + 4);
  for (let i = 0; i < count; i++) {
    const at = metadata.sfntOffset + 12 + i * 16;
    const start = source.readUInt32BE(at + 8); const length = source.readUInt32BE(at + 12);
    if (start > source.length - length) throw new DocumentFailure('font-resource-invalid');
    tables.set(source.toString('latin1', at, at + 4), source.subarray(start, start + length));
  }
  const os2 = tables.get('OS/2'); const post = tables.get('post'); const head = tables.get('head');
  if (!os2 || os2.length < 32 || !post || post.length < 16 || !head || head.length < 46) throw new DocumentFailure('font-resource-invalid');
  const glyph = (value: any) => ({ id: value.id, advanceWidth: value.advanceWidth, codePoints: [...value.codePoints] });
  const layout = (text: string): PositionedGlyphRun => {
    const run = face.layout(text, { ...DOCUMENT_FONT_FEATURES }, script, language, 'ltr');
    if (!run || run.glyphs.length !== run.positions.length || run.glyphs.some(g => !Number.isSafeInteger(g.id) || g.id <= 0)
      || run.positions.some(p => ![p.xAdvance, p.yAdvance, p.xOffset, p.yOffset].every(Number.isFinite))) throw new DocumentFailure('unsupported-glyph');
    return { glyphs: run.glyphs.map(glyph), positions: run.positions.map(p => ({ ...p })) };
  };
  const facade = Object.freeze({ layout, glyphForCodePoint: (cp: number) => glyph(face.glyphForCodePoint(cp)),
    unitsPerEm: face.unitsPerEm, postscriptName: face.postscriptName, characterSet: [...face.characterSet],
    ascent: face.ascent, descent: face.descent, capHeight: face.capHeight, xHeight: face.xHeight, italicAngle: face.italicAngle,
    bbox: Object.freeze({ minX: face.bbox.minX, minY: face.bbox.minY, maxX: face.bbox.maxX, maxY: face.bbox.maxY }),
    'OS/2': Object.freeze({ sFamilyClass: os2.readInt16BE(30) }), post: Object.freeze({ isFixedPitch: post.readUInt32BE(12) !== 0 }),
    head: Object.freeze({ macStyle: Object.freeze({ italic: (head.readUInt16BE(44) & 2) !== 0 }) }),
    createSubset() {
      const subset = face.createSubset(); let encoded = false; const mapping = new Map<number, number>();
      return Object.freeze({ cff: metadata.outlines === 'cff', includeGlyph(value: any) {
        const id = typeof value === 'number' ? value : value.id; const cid = subset.includeGlyph(id);
        if (!Number.isSafeInteger(cid) || cid < 0 || cid > 65535 || mapping.has(id) && mapping.get(id) !== cid) throw new DocumentFailure('font-resource-invalid');
        mapping.set(id, cid); return cid;
      }, encodeStream() {
        return Readable.from((async function* () {
          if (encoded) throw new DocumentFailure('font-resource-invalid'); encoded = true;
          const output = subset.encode();
          // v0.9.99: no subset-size budget. A subset holds only glyphs the document uses, at most the font's own glyph
          // count (16-bit glyph ids, checked per glyph above), so its size follows the font, not a fixed cap.
          if (!(output instanceof Uint8Array) || output.length < 4) throw new DocumentFailure('font-resource-invalid');
          if (metadata.outlines === 'cff') {
            if (output[0] !== 1 || output[2] < 4 || output[2] > output.length || output[3] < 1 || output[3] > 4) throw new DocumentFailure('font-resource-invalid');
          } else if (![0x00010000, 0x74727565].includes(Buffer.from(output).readUInt32BE(0))) throw new DocumentFailure('font-resource-invalid');
          yield output;
        })());
      } });
    },
  });
  return { layout, fontkit: { create: () => facade } };
}
export interface DocumentFontFace {
  unitsPerEm: number;
  layout(text: string, features: Record<string, boolean>, script: string, language: string, direction: string): PositionedGlyphRun;
  [key: string]: any;
}

/** Public fontkit façade, bound to one face/language/script. Later registerFontkit calls cannot rebind it. */
export function bindPdfFontAdapter(face: DocumentFontFace, script: string, language: string) {
  const layout = (text: string) => {
    const run = face.layout(text, { ...DOCUMENT_FONT_FEATURES }, script, language, 'ltr');
    if (!run || run.glyphs.length !== run.positions.length || !run.glyphs.length
      || run.glyphs.some(glyph => !Number.isSafeInteger(glyph.id) || glyph.id <= 0)
      || run.positions.some(position => ![position.xAdvance, position.yAdvance, position.xOffset, position.yOffset].every(Number.isFinite))
      || !Number.isFinite(face.unitsPerEm) || face.unitsPerEm <= 0) throw new DocumentFailure('unsupported-glyph');
    return run;
  };
  const facade = new Proxy(face, {
    get(target, property) {
      if (property === 'layout') return layout;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set() { throw new DocumentFailure('font-resource-invalid'); },
  });
  return { layout, fontkit: { create: () => facade } };
}

/** The same shaped run drives width and drawing. No private pdf-lib embedder/fontKey access. */
export function positionedPdfGlyphs(run: PositionedGlyphRun, cidHex: string, unitsPerEm: number,
  size: number, originX: number, originY: number) {
  if (!/^(?:[0-9a-fA-F]{4})+$/.test(cidHex) || cidHex.length !== run.glyphs.length * 4
    || !Number.isFinite(unitsPerEm) || unitsPerEm <= 0 || ![size, originX, originY].every(Number.isFinite) || size <= 0) throw new DocumentFailure('font-resource-invalid');
  let x = 0; let y = 0; const scale = size / unitsPerEm;
  return run.glyphs.map((glyph, index) => {
    const position = run.positions[index];
    const placed = { glyphId: glyph.id, cidHex: cidHex.slice(index * 4, index * 4 + 4),
      x: originX + (x + position.xOffset) * scale, y: originY + (y + position.yOffset) * scale };
    x += position.xAdvance; y += position.yAdvance;
    return placed;
  });
}
