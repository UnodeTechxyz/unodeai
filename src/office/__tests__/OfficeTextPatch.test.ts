import { expect, it } from 'vitest';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { decodeOfficeXml, encodeOfficeXml, replaceOfficeText } from '../OfficeTextPatch';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
it('replaces repeated exact text across Word runs, preserves styles and scopes to one paragraph', () => {
  const original = Buffer.from(`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>AB A</w:t></w:r><!--kept--><w:r><w:rPr><w:i/></w:rPr><w:t>B AB tail</w:t></w:r></w:p><w:p><w:r><w:t>AB</w:t></w:r></w:p></w:body></w:document>`);
  for (const replacement of ['新😀&', '', 'much longer text']) {
    const result = replaceOfficeText(original, 'docx', { kind: 'paragraph', ref: 'D1' }, 'AB', replacement);
    expect(result.replacements).toBe(3); const xml = result.bytes.toString('utf8');
    expect(xml).toContain('<w:rPr><w:b/></w:rPr>'); expect(xml).toContain('<w:rPr><w:i/></w:rPr>'); expect(xml).toContain('<!--kept-->');
    expect(xml).toContain('<w:p><w:r><w:t>AB</w:t></w:r></w:p>');
  }
  const first = replaceOfficeText(original, 'docx', { kind: 'paragraph', ref: 'D1' }, 'AB', '$&', false);
  expect(first.replacements).toBe(1); expect(first.bytes.toString()).toContain('$&amp;');
});
it.each(['utf-8', 'utf-16le', 'utf-16be'] as const)('keeps %s encoding, declaration and original BOM while writing real Word controls', encoding => {
  for (const bom of [false, true]) {
    const source = { xml: `<?xml version="1.0" encoding="${encoding}"?>\r\n<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>before</w:t></w:r></w:p><!--untouched\r\ncomment--></w:body></w:document>`, encoding, bom };
    const bytes = encodeOfficeXml(source); const result = replaceOfficeText(bytes, 'docx', { kind: 'paragraph', ref: 'D1' }, 'before', '新\r\nnext\t😀');
    expect(result.lineEndingsNormalized).toBe(true); const readback = decodeOfficeXml(result.bytes);
    expect(readback).toMatchObject({ encoding, bom }); expect(readback.xml).toContain(`encoding="${encoding}"`);
    expect(readback.xml).toContain('<w:br xmlns:w='); expect(readback.xml).toContain('<w:tab xmlns:w='); expect(readback.xml).toContain('<!--untouched\r\ncomment-->');
    expect(encodeOfficeXml(decodeOfficeXml(bytes))).toEqual(bytes);
  }
});
it('uses actual SDK PPT run boundaries for scoped multiline replacement and keeps another matching shape untouched', async () => {
  const deck = new PptxGenJS(); const slide = deck.addSlide(); slide.addText([{ text: 'Old ', options: { bold: true } }, { text: 'title', options: { italic: true } }], { x: 1, y: 1, w: 4, h: 1 });
  slide.addText('Old title', { x: 1, y: 3, w: 4, h: 1 }); const zip = await JSZip.loadAsync(await deck.write({ outputType: 'nodebuffer' }));
  const source = await zip.file('ppt/slides/slide1.xml')!.async('nodebuffer');
  const result = replaceOfficeText(source, 'pptx', { kind: 'object', ref: 'S1-O1', slideRef: 'S1' }, 'Old title', '新\nsecond');
  expect(result.replacements).toBe(1); const xml = result.bytes.toString(); expect(xml).toContain('<a:br xmlns:a=');
  expect(xml).toMatch(/<a:br[^>]*><a:rPr[^>]*b="1"/);
  expect(xml).toContain('b="1"'); expect(xml).toContain('i="1"'); expect(xml).toContain('Old title');
  expect(replaceOfficeText(result.bytes, 'pptx', { kind: 'object', ref: 'S1-O1', slideRef: 'S1' }, 'second', 'last').replacements).toBe(1);
});
it('keeps locally declared run prefixes valid when inserting PPT line breaks', () => {
  const source = Buffer.from(`<p:sld xmlns:p="${P}"><p:cSld><p:spTree><p:sp><p:txBody><z:p xmlns:z="${A}"><q:r xmlns:q="${A}" xmlns:font="${A}" data-note="literal xml:space and > marker"><font:rPr b="1"><font:latin typeface="$&amp;"/></font:rPr><x:t xmlns:x="${A}" xml:space = 'default'>old</x:t></q:r></z:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  const result = replaceOfficeText(source, 'pptx', { kind: 'object', ref: 'S1-O1', slideRef: 'S1' }, 'old', 'first\nlast');
  expect(result.bytes.toString()).toContain(`xml:space = 'preserve'`); expect(result.bytes.toString()).toContain('<q:br xmlns:q=');
  expect(result.bytes.toString()).toContain('typeface="$&amp;"');
});
it('selects a wrapped Word cell without replacing a same-text neighbour or nested table', () => {
  const cell = (value: string) => `<w:tc><w:p><w:r><w:t>${value}</w:t></w:r></w:p></w:tc>`;
  const source = Buffer.from(`<w:document xmlns:w="${W}"><w:body><w:tbl><w:tr>${cell('same')}<w:sdt><w:sdtContent><w:tc><w:p><w:r><w:t>same</w:t></w:r></w:p><w:tbl><w:tr>${cell('same')}</w:tr></w:tbl></w:tc></w:sdtContent></w:sdt></w:tr></w:tbl></w:body></w:document>`);
  const result = replaceOfficeText(source, 'docx', { kind: 'cell', ref: 'T1-R1-C2' }, 'same', 'changed');
  expect(result.replacements).toBe(1); expect(result.bytes.toString().match(/>same<\/w:t>/g)).toHaveLength(2);
});
it('refuses only the touched unsupported structure or missing exact text and leaves input bytes intact', () => {
  const original = Buffer.from(`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t></w:r></w:p></w:body></w:document>`); const before = Buffer.from(original);
  expect(() => replaceOfficeText(original, 'docx', { kind: 'paragraph', ref: 'D1' }, 'A\tB', 'joined')).toThrow('text-match-crosses-structural-control');
  expect(() => replaceOfficeText(original, 'docx', { kind: 'paragraph', ref: 'D2' }, 'A', 'changed')).toThrow('text-not-found');
  for (const invalid of ['\0', '\uD800', '\uDC00']) expect(() => replaceOfficeText(original, 'docx', { kind: 'paragraph', ref: 'D1' }, 'A', invalid)).toThrow(); expect(original).toEqual(before);
});

it('replaces a rich paragraph with many cross-run matches while leaving the next paragraph byte-identical', () => {
  const runs = '<w:r><w:rPr><w:b/></w:rPr><w:t>A</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>B </w:t></w:r>'.repeat(2000);
  const tail = '<w:p><w:r><w:t>AB untouched</w:t></w:r></w:p>';
  const source = Buffer.from(`<w:document xmlns:w="${W}"><w:body><w:p>${runs}</w:p>${tail}</w:body></w:document>`);
  const result = replaceOfficeText(source, 'docx', { kind: 'paragraph', ref: 'D1' }, 'AB', '新😀');
  expect(result.replacements).toBe(2000); expect(result.changedTextNodes).toBe(4000); expect(result.bytes.toString()).toContain(tail);
  expect(result.bytes.toString().match(/<w:b\/>/g)).toHaveLength(2000); expect(result.bytes.toString().match(/<w:i\/>/g)).toHaveLength(2000);
});
