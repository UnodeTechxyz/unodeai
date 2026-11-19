import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { PDFDocument, PDFRawStream, PDFName, PDFDict, decodePDFRawStream } from 'pdf-lib';
import { selectDocumentFontFace } from '../FontFaceSelection';
import { bindSubsetPdfFontAdapter } from '../PdfFontAdapter';
import { renderPdf } from '../PdfRenderer';
import { validateDocumentRequest } from '../DocumentValidation';
import { pdfTestFont } from './pdfTestFont';
import { DocumentRenderer } from '../DocumentRenderer';

const request = (blocks: unknown[], extra: object = {}) => validateDocumentRequest({ schema_version: 1, path: 'proof.pdf', format: 'pdf',
  template: 'report-v1', document: { title: 'PROOF', language: 'en', blocks, ...extra } });
const fonts = async (_language: string, style: 'regular' | 'bold') => {
  const bytes = Uint8Array.from(pdfTestFont(style === 'bold')).buffer;
  return [{ bytes, sha256: createHash('sha256').update(new Uint8Array(bytes)).digest('hex'), family: 'UnodeTest' }];
};
const base = path.join(process.cwd(), '.audit-repro', 'pdf-consumer-tests'); const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) {
  if (path.dirname(dir) !== base || !path.basename(dir).startsWith('job-')) throw new Error('Bad cleanup path');
  await rm(dir, { recursive: true, force: true });
} });

describe('actual PDF renderer, font subset and document worker', () => {
  it('renders decomposed modern Hangul through canonical syllables and copyable PDF text', async () => {
    const rendered = await renderPdf(request([{ type: 'paragraph', content: [{ text: '\u1112\u1161\u11ab\u1100\u1173\u11af', language: 'ko' }] }]),
      async (_language, style) => {
        const bytes = Uint8Array.from(pdfTestFont(style === 'bold', '한글')).buffer;
        return [{ bytes, sha256: createHash('sha256').update(new Uint8Array(bytes)).digest('hex'), family: 'UnodeTest' }];
      });
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await getDocument({ data: Uint8Array.from(rendered.bytes), useSystemFonts: false }).promise;
    try {
      const content = await (await document.getPage(1)).getTextContent();
      expect(content.items.map(item => 'str' in item ? item.str : '').join('')).toContain('한글');
    } finally { await document.destroy(); }
  });
  it('renders contract symbols and simple Greek/Cyrillic with copyable Unicode text', async () => {
    const value = '\u00a7 3.2 \u00a9 2026 \u2122 \u2192 \u00bd \u03bc \u03a9 \u0414';
    const rendered = await renderPdf(request([{ type: 'paragraph', content: [{ text: value }] }]), async (_language, style) => {
      const bytes = Uint8Array.from(pdfTestFont(style === 'bold', value)).buffer;
      return [{ bytes, sha256: createHash('sha256').update(new Uint8Array(bytes)).digest('hex'), family: 'UnodeTest' }];
    });
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: Uint8Array.from(rendered.bytes), useSystemFonts: false });
    const document = await loading.promise;
    try {
      const content = await (await document.getPage(1)).getTextContent();
      expect(content.items.map(item => 'str' in item ? item.str : '').join('')).toContain(value);
    } finally { await document.destroy(); }
  });
  it('keeps a heading with the following table header and first row, not alone on the previous page', async () => {
    const input = request([...Array.from({ length: 29 }, () => ({ type: 'paragraph', content: [{ text: 'A' }] })),
      { type: 'heading', level: 1, content: [{ text: 'FINAL' }] }, { type: 'table', headers: ['LEFT', 'RIGHT'], rows: [['A', 'B']] }]);
    const rendered = await renderPdf(input, fonts); const document = await PDFDocument.load(rendered.bytes);
    expect(document.getPageCount()).toBe(2);
    const firstFonts = document.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys();
    expect(firstFonts).toHaveLength(1); // Only regular text: the heading's bold subset belongs to page 2.
  });
  it('uses the public subsetter actual CID for sparse and repeated source glyph ids', () => {
    const source = pdfTestFont(); const kit = require('fontkit');
    const { face, metadata } = selectDocumentFontFace(kit, source, { family: 'UnodeTest', style: 'regular' });
    const adapter = bindSubsetPdfFontAdapter(face, source, metadata, 'latn', 'ENG');
    const subset = adapter.fontkit.create().createSubset();
    expect(subset.includeGlyph(50)).toBe(1); expect(subset.includeGlyph(50)).toBe(1);
    expect(subset.includeGlyph(2)).toBe(2); expect(subset.includeGlyph(0)).toBe(0);
  });
  it('embeds real subsets, supports both weights and deterministic multi-page table layout', async () => {
    const input = request([{ type: 'heading', level: 1, content: [{ text: 'TERMS' }] },
      { type: 'clause', label: '1.', content: [{ text: 'CONTRACT '.repeat(600) }] },
      { type: 'table', headers: ['A', 'B'], rows: [["TEXT ".repeat(600), 'SECOND CELL']] },
      { type: 'signature', parties: [{ label: 'PROVIDER' }, { label: 'CUSTOMER' }] }]);
    const first = await renderPdf(input, fonts); const second = await renderPdf(input, fonts);
    expect(first.bytes).toEqual(second.bytes); expect(first.stats.pages).toBeGreaterThan(2);
    const saved = await PDFDocument.load(first.bytes, { updateMetadata: false }); expect(saved.getPageCount()).toBe(first.stats.pages);
    const embeddedGlyphCounts: number[] = [];
    for (const [, object] of saved.context.enumerateIndirectObjects()) if (object instanceof PDFRawStream) {
      const bytes = Buffer.from(decodePDFRawStream(object).decode());
      if (bytes.length < 12 || ![0x10000, 0x74727565].includes(bytes.readUInt32BE(0))) continue;
      for (let i = 0; i < bytes.readUInt16BE(4); i++) {
        const at = 12 + i * 16;
        if (bytes.toString('ascii', at, at + 4) === 'maxp') embeddedGlyphCounts.push(bytes.readUInt16BE(bytes.readUInt32BE(at + 8) + 4));
      }
    }
    expect(embeddedGlyphCounts.length).toBeGreaterThan(0); expect(embeddedGlyphCounts.every(count => count < 96)).toBe(true);
    const text = first.bytes.toString('latin1'); expect(text).toContain('/FontFile2'); expect(text).toContain('/ToUnicode');
    expect(text).not.toContain('/JavaScript'); expect(text).not.toContain('/URI');
  });
  it('does layout admission before reading fonts and refuses an invalid source digest', async () => {
    let reads = 0; const never = async () => { reads++; return []; };
    await expect(renderPdf(request([{ type: 'paragraph', content: [{ text: 'abc\u202e' }] }]), never)).rejects.toMatchObject({ code: 'unsupported-text-layout' });
    expect(reads).toBe(0);
    await expect(renderPdf(request([{ type: 'paragraph', content: [{ text: 'ABC' }] }]),
      async (language, style) => (await fonts(language, style)).map(source => ({ ...source, sha256: '0'.repeat(64) })))).rejects.toMatchObject({ code: 'font-resource-changed' });
  });
  it('paginates past the former 120 pages and wraps long headers and footers without clipping', async () => {
    const blocks = Array.from({ length: 121 }, (_, i) => i % 2 ? { type: 'page-break' } : { type: 'paragraph', content: [{ text: 'A' }] });
    // A 61-page explicit-break request is valid; long headers/footers wrap without being clipped away.
    const valid = await renderPdf(request(blocks), fonts); expect(valid.stats.pages).toBe(61);
    const wrapped = await renderPdf(request([{ type: 'paragraph', content: [{ text: 'BODY' }] }],
      { header: 'HEADER '.repeat(30), footer: 'FOOTER '.repeat(30) }), fonts);
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const reader = await getDocument({ data: Uint8Array.from(wrapped.bytes), useSystemFonts: false }).promise;
    try {
      const items = (await (await reader.getPage(1)).getTextContent()).items.filter(item => 'str' in item);
      const all = items.map(item => item.str).join(' ');
      expect(all.match(/HEADER/g)).toHaveLength(30); expect(all.match(/FOOTER/g)).toHaveLength(30);
      const body = items.find(item => item.str.includes('BODY'))!;
      const headerLines = items.filter(item => item.str.includes('HEADER'));
      const footerLines = items.filter(item => item.str.includes('FOOTER'));
      expect(headerLines.length).toBeGreaterThan(1); expect(footerLines.length).toBeGreaterThan(1);
      expect(headerLines.every(item => item.transform[5] > body.transform[5])).toBe(true);
      expect(footerLines.every(item => item.transform[5] < body.transform[5])).toBe(true);
    } finally { await reader.destroy(); }
    const over = Array.from({ length: 241 }, (_, i) => i % 2 ? { type: 'page-break' } : { type: 'paragraph', content: [{ text: 'A' }] });
    // v0.9.99: page 121 is a page, not a refusal.
    const long = await renderPdf(request(over), fonts); expect(long.stats.pages).toBe(121);
    expect((await PDFDocument.load(long.bytes)).getPageCount()).toBe(121);
  });
  it('runs the real bundled PDF worker and host FontResourceBroker, not a fake success reply', async () => {
    await mkdir(base, { recursive: true }); const dir = await mkdtemp(path.join(base, 'job-')); directories.push(dir);
    const regular = path.join(dir, 'regular.ttf'); const bold = path.join(dir, 'bold.ttf');
    await writeFile(regular, pdfTestFont()); await writeFile(bold, pdfTestFont(true));
    const bundle = await build({ entryPoints: ['src/content/document/DocumentRenderWorker.ts'], bundle: true,
      platform: 'node', format: 'cjs', target: 'node18', write: false, metafile: true });
    expect(Object.keys(bundle.metafile.inputs)).toContain('node_modules/fontkit/dist/main.cjs');
    expect(Object.keys(bundle.metafile.inputs).some(file => /@napi-rs|\.node$/.test(file))).toBe(false);
    const renderer = new DocumentRenderer('unused.cjs', () => new Worker(bundle.outputFiles[0].text, { eval: true,
      execArgv: ['--require', path.resolve('scripts/document-worker-no-native.cjs')] }), {
      forbiddenRoots: () => [], candidates: (_language, style) => [{ family: 'UnodeTest', style, file: style === 'bold' ? bold : regular }],
    });
    const rendered = await renderer.render(request([
      { type: 'table', headers: [[{ text: 'LEFT', language: 'es' }], [{ text: 'RIGHT', language: 'fr' }]], rows: [['ONE', 'TWO']] },
      { type: 'heading', level: 1, content: [{ text: 'TERMS' }] },
      { type: 'paragraph', content: [{ text: 'ABC 123' }] }]), new AbortController().signal, () => true);
    expect(rendered.stats).toMatchObject({ format: 'pdf', pages: 1, headings: 1, tables: 1 });
    expect((await PDFDocument.load(rendered.bytes)).getPageCount()).toBe(1);
  });
});

// v0.9.99: the 120-page and 12,000-line ceilings are gone; a long document paginates, and only content that no
// page can hold is unrepresentable. All of these use the real renderer and subsetter with the synthetic test font.
const pageText = async (bytes: Buffer, pages: number[]) => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const reader = await getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false }).promise;
  try {
    const result: Array<Array<{ str: string; y: number }>> = [];
    for (const page of pages) result.push((await (await reader.getPage(page)).getTextContent()).items
      .flatMap(item => 'str' in item ? [{ str: item.str, y: item.transform[5] as number }] : []));
    return { count: reader.numPages, result };
  } finally { await reader.destroy(); }
};
describe('PDF pagination past the former page and line ceilings', () => {
  it('renders more than 12,000 lines on more than 120 pages, every line present and every footer numbered from the real count', async () => {
    const text = Array.from({ length: 12_001 }, (_, i) => `LINE ${i + 1}`).join('\n');
    const rendered = await renderPdf(request([{ type: 'paragraph', content: [{ text }] }], { footer: 'PAGE' }), fonts);
    expect(rendered.stats.pages).toBeGreaterThan(120);
    const total = rendered.stats.pages!;
    const { count, result: [first, last] } = await pageText(rendered.bytes, [1, total]);
    expect(count).toBe(total);
    expect(first.map(item => item.str).join(' ')).toContain('LINE 1 ');
    const lastText = last.map(item => item.str).join(' ');
    expect(lastText).toContain('LINE 12001'); expect(lastText).toContain(`PAGE ${total} / ${total}`);
  }, 120_000);
  it('reserves footer space from the actual page count when two-digit page numbers wrap the footer', async () => {
    // Two footer lines with " 1 / 1" (the first-pass guess); with two-digit page numbers the second line wraps onto a third.
    const footer = `${'F'.repeat(95)} ${'G'.repeat(93)}`;
    // One-line paragraphs fill each page to its last line, so a reservation one footer line short shows.
    const blocks = Array.from({ length: 600 }, (_, i) => ({ type: 'paragraph', content: [{ text: `BODY ${i + 1}` }] }));
    const rendered = await renderPdf(request(blocks, { footer }), fonts);
    const total = rendered.stats.pages!; expect(total).toBeGreaterThanOrEqual(10);
    const { result: [full] } = await pageText(rendered.bytes, [total - 1]);
    const body = full.filter(item => item.str.includes('BODY')); const foot = full.filter(item => item.str.includes('FFF') || /\d+ \/ \d+/.test(item.str));
    expect(foot.length).toBeGreaterThan(0);
    // The body stops 12 pt above the footer's first line: lowest body baseline >= footer baseline + 12 + one footer line.
    expect(Math.min(...body.map(item => item.y)) - Math.max(...foot.map(item => item.y))).toBeGreaterThanOrEqual(25);
  });
  it('reflows content the old field limits kept small instead of failing: long labels, tall table headers, long signatures and punctuation runs', async () => {
    const long = 'LABEL '.repeat(400);
    const rendered = await renderPdf(request([
      { type: 'clause', label: long, content: [{ text: 'CLAUSE BODY' }] },
      { type: 'heading', level: 1, content: [{ text: 'TABLE' }] },
      { type: 'table', headers: ['HEADER '.repeat(700), 'B'], rows: [['ROW CELL', 'TWO'], ['LAST CELL', 'END']] },
      { type: 'signature', parties: [{ label: 'SIGNER '.repeat(900), name: 'NAME' }, { label: 'OTHER' }] },
      { type: 'paragraph', content: [{ text: '。'.repeat(300), language: 'ja' }] },
    ]), async (_language, style) => {
      const bytes = Uint8Array.from(pdfTestFont(style === 'bold', '。')).buffer;
      return [{ bytes, sha256: createHash('sha256').update(new Uint8Array(bytes)).digest('hex'), family: 'UnodeTest' }];
    });
    const { count, result } = await pageText(rendered.bytes, Array.from({ length: rendered.stats.pages! }, (_, i) => i + 1));
    const all = result.flat().map(item => item.str).join(' ');
    expect(count).toBeGreaterThan(2);
    for (const token of ['CLAUSE BODY', 'ROW CELL', 'LAST CELL', 'END', 'NAME', 'OTHER']) expect(all).toContain(token);
    expect(all.match(/LABEL/g)).toHaveLength(400); expect(all.match(/HEADER/g)).toHaveLength(700);
    expect(all.match(/SIGNER/g)).toHaveLength(900); expect(all.match(/。/g)).toHaveLength(300);
  });
  it('still reports a glyph no page cell can hold as unrepresentable layout, never as a capacity limit', async () => {
    const columns = 63;
    await expect(renderPdf(request([{ type: 'table', headers: Array(columns).fill('W'), rows: [Array(columns).fill('W')] }]), fonts))
      .rejects.toMatchObject({ code: 'layout-unrepresentable' });
  });
});

// v0.9.99: the former 4,096 distinct-character and 8 MiB font-subset budgets refused long CJK documents. With the real
// bundled worker, host font broker and the Windows system font, every distinct Han character of the basic block renders.
const yaHei = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'msyh.ttc');
describe.runIf(process.platform === 'win32' && existsSync(yaHei))('PDF with a Windows system font past the former glyph budgets', () => {
  it('renders 20,902 distinct Han characters into one PDF with a Microsoft YaHei subset', async () => {
    const bundle = await build({ entryPoints: ['src/content/document/DocumentRenderWorker.ts'], bundle: true,
      platform: 'node', format: 'cjs', target: 'node18', write: false });
    const renderer = new DocumentRenderer('unused.cjs', (_path, limits) => new Worker(bundle.outputFiles[0].text, { eval: true,
      resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      execArgv: ['--require', path.resolve('scripts/document-worker-no-native.cjs')] }), { forbiddenRoots: () => [process.cwd()] });
    const text = Array.from({ length: 20_902 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');
    const blocks = Array.from({ length: Math.ceil(text.length / 2000) }, (_, i) => ({ type: 'paragraph', content: [{ text: text.slice(i * 2000, (i + 1) * 2000) }] }));
    const rendered = await renderer.render(validateDocumentRequest({ schema_version: 1, path: 'han.pdf', format: 'pdf',
      template: 'report-v1', document: { title: '\u5408\u540c', language: 'zh-Hans', blocks } }), new AbortController().signal, () => true);
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const reader = await getDocument({ data: Uint8Array.from(rendered.bytes), useSystemFonts: false }).promise;
    try {
      expect(reader.numPages).toBe(rendered.stats.pages);
      let all = '';
      for (let page = 1; page <= reader.numPages; page++) all += (await (await reader.getPage(page)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join('');
      expect(new Set([...all].filter(char => char >= '\u4e00' && char <= '\u9fa5')).size).toBe(20_902);
    } finally { await reader.destroy(); }
  }, 120_000);
});
