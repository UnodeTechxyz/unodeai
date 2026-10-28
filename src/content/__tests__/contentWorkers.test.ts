/*
 * v0.9.99 CF-2: the real untrusted-document workers (out/content/PdfWorker.js and OfficeWorker.js, built by `tsc`),
 * on synthetic documents made here: a PDF past the former 200-page limit, and Office archives with large or many
 * entries that are never read, and a decompression bomb.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { ContentAssetStore, extractWorkspaceDocument } from '../ContentAssetStore';

// yazl is a runtime dependency (the archive writer); typed loosely here as the product does with yauzl.
const yazl: any = require('yazl');

async function pdfOfPages(count: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= count; page++) {
    document.addPage([200, 200]).drawText(`Synthetic page ${page}`, { x: 20, y: 100, size: 12, font });
  }
  return document.save();
}

function zipOf(entries: Array<{ name: string; data: Buffer; compress?: boolean }>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const entry of entries) zip.addBuffer(entry.data, entry.name, { compress: entry.compress ?? true });
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

const DOCUMENT_XML = (text: string) => Buffer.from(
  `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
);

describe('the real PDF worker past the former page limit', () => {
  it('extracts page 201 of a 201-page PDF through the store, and every page through read_file\'s extraction', async () => {
    const bytes = await pdfOfPages(201);
    const store = new ContentAssetStore();
    try {
      const stored = await store.storePdf(bytes, 'user-attachment');
      if ('error' in stored) throw new Error(stored.error);
      const read = await store.readExtractedContent(stored.assetId, { start: 201, end: 201 });
      if ('error' in read) throw new Error(read.error);
      expect(read.pages.total).toBe(201);
      expect(read.items[0]).toMatchObject({ page: 201, text: 'Synthetic page 201' });
    } finally {
      await store.dispose();
    }
    const whole = await extractWorkspaceDocument(bytes);
    expect(whole.error).toBeUndefined();
    expect(whole.text).toContain('Page 1: Synthetic page 1');
    expect(whole.text).toContain('Page 201: Synthetic page 201');
  }, 60_000);

  it('stops a parse when Stop aborts it, as `stopped`', async () => {
    const abort = new AbortController();
    abort.abort();
    expect(await extractWorkspaceDocument(await pdfOfPages(3), { signal: abort.signal })).toEqual({ error: 'stopped' });
  }, 30_000);
});

describe('the real Office worker reads only the parts that hold text', () => {
  it('reads a document with 2,500 other entries and a 12 MiB incompressible one it never opens', async () => {
    const noise = Buffer.alloc(12 * 1024 * 1024);
    for (let index = 0; index < noise.length; index += 4) noise.writeUInt32LE((index * 2654435761) >>> 0, index);
    const archive = await zipOf([
      { name: 'word/media/image1.bin', data: noise, compress: false },
      ...Array.from({ length: 2_500 }, (_, index) => ({ name: `customXml/item${index}.xml`, data: Buffer.from(`<i>${index}</i>`) })),
      { name: 'word/document.xml', data: DOCUMENT_XML('The synthetic body text.') },
    ]);
    expect(archive.byteLength).toBeGreaterThan(10 * 1024 * 1024);
    expect(await extractWorkspaceDocument(archive)).toEqual({ text: 'The synthetic body text.' });
  }, 60_000);

  it('still refuses a decompression bomb: a text part that expands far beyond its compressed size', async () => {
    const bomb = Buffer.alloc(100 * 1024 * 1024, 0x61);
    const archive = await zipOf([{ name: 'word/document.xml', data: bomb }]);
    expect(archive.byteLength).toBeLessThan(1024 * 1024);
    expect(await extractWorkspaceDocument(archive)).toEqual({ error: 'oversized' });
  }, 60_000);
});
