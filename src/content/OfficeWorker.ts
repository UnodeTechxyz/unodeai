import { parentPort } from 'node:worker_threads';

// yauzl is deliberately a direct, pinned runtime dependency. It is loaded inside this bounded worker so
// neither ZIP central-directory parsing nor decompression consumes the extension-host heap.
const yauzl: any = require('yauzl');

interface ZipEntry {
  fileName: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  generalPurposeBitFlag?: number;
  versionNeededToExtract?: number;
  extraFields?: Array<{ id: number }>;
}

interface ZipFile {
  entryCount?: number;
  readEntry(): void;
  openReadStream(entry: ZipEntry, callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void): void;
  close(): void;
  on(event: 'entry' | 'end' | 'error', listener: (...args: any[]) => void): void;
}

type OfficeFormat = 'docx' | 'pptx';

interface OfficeText {
  format: OfficeFormat;
  blocks: string[];
}

if (!parentPort) {
  throw new Error('Office worker requires a parent port.');
}

parentPort.once('message', async (request: { path: string; maxExpansionRatio: number; expansionFloorBytes: number }) => {
  // v0.9.99: a sign of life while the event loop turns; the host ends a parse only when it stops for its stall period.
  const heartbeat = setInterval(() => parentPort!.postMessage({ progress: true }), 1_000);
  try {
    const value = await extractOfficeText(request.path, request.maxExpansionRatio, request.expansionFloorBytes);
    parentPort!.postMessage({ ok: true, value });
  } catch (error) {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    clearInterval(heartbeat);
    parentPort!.close();
  }
});

/**
 * v0.9.99: only the parts that hold the text are opened: word/document.xml, or ppt/slides/slideN.xml. Every other
 * entry (images, media, embedded files) is passed over without being checked or inflated, whatever its size, so a
 * larger ordinary document is not refused for content that is never read. The decompression-bomb guard follows what
 * the read parts expand to against their compressed size, not the file size or a count of entries: the expansion of
 * the parts read so far may reach the floor plus the ratio times their compressed size. The number of entries is
 * bounded by the file itself (each directory record takes bytes), and walking them is lazy.
 */
async function extractOfficeText(filePath: string, maxExpansionRatio: number, expansionFloorBytes: number): Promise<OfficeText> {
  return await new Promise<OfficeText>((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true }, (openError: Error | null, zip: ZipFile | undefined) => {
      if (openError || !zip) {
        reject(openError ?? new Error('ZIP archive could not be opened.'));
        return;
      }
      let done = false;
      let compressedBytes = 0;
      let declaredBytes = 0;
      let actualBytes = 0;
      const allowed = () => expansionFloorBytes + maxExpansionRatio * compressedBytes;
      let documentXml: string | undefined;
      const slides: Array<{ number: number; xml: string }> = [];
      const fail = (error: Error) => {
        if (done) return;
        done = true;
        try { zip.close(); } catch { /* best effort */ }
        reject(error);
      };
      const finish = () => {
        if (done) return;
        done = true;
        if (documentXml !== undefined) {
          const blocks = docxBlocks(documentXml);
          if (blocks.length === 0) {
            reject(new Error('DOCX document contains no extractable text.'));
          } else {
            resolve({ format: 'docx', blocks });
          }
          return;
        }
        if (slides.length > 0) {
          const blocks = slides.sort((left, right) => left.number - right.number).map((slide) => slideText(slide.xml));
          resolve({ format: 'pptx', blocks });
          return;
        }
        reject(new Error('ZIP archive is not a supported DOCX or PPTX document.'));
      };
      zip.on('error', (error: Error) => fail(error));
      zip.on('end', finish);
      zip.on('entry', (entry: ZipEntry) => {
        if (done) return;
        const slide = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(entry.fileName);
        const wanted = entry.fileName === 'word/document.xml' || !!slide;
        if (!wanted) {
          zip.readEntry();
          return;
        }
        if ((entry.generalPurposeBitFlag ?? 0) & 0x1) return fail(new Error('Encrypted ZIP entries are not supported.'));
        if ((entry.versionNeededToExtract ?? 0) >= 45 || entry.extraFields?.some((field) => field.id === 0x0001)) {
          return fail(new Error('Zip64 archives are not supported.'));
        }
        if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
          return fail(new Error('ZIP compression method is not supported.'));
        }
        compressedBytes += Math.max(0, entry.compressedSize ?? 0);
        declaredBytes += entry.uncompressedSize;
        if (declaredBytes > allowed()) {
          return fail(new Error('ZIP document part expands far beyond its compressed size.'));
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error('ZIP entry could not be read.'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => {
            const bytes = Buffer.from(chunk);
            actualBytes += bytes.byteLength;
            if (actualBytes > allowed()) {
              (stream as NodeJS.ReadableStream & { destroy(error?: Error): void }).destroy(new Error('ZIP document part expands far beyond its compressed size.'));
              return;
            }
            chunks.push(bytes);
          });
          stream.once('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));
          stream.once('end', () => {
            if (done) return;
            const xml = Buffer.concat(chunks).toString('utf8');
            if (entry.fileName === 'word/document.xml') documentXml = xml;
            else if (slide) slides.push({ number: Number(slide[1]), xml });
            parentPort!.postMessage({ progress: true });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function docxBlocks(xml: string): string[] {
  const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi)].map((match) => xmlText(match[1]));
  const blocks = paragraphs.filter(Boolean);
  return blocks.length > 0 ? blocks : [xmlText(xml)].filter(Boolean);
}

function slideText(xml: string): string {
  return [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi)]
    .map((match) => decodeXml(match[1]))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function xmlText(xml: string): string {
  // Strip markup before decoding entities: literal "< B & C >" in a document is text, not a tag.
  return decodeXml(xml
    .replace(/<w:tab\b[^>]*\/?>(?:<\/w:tab>)?/gi, '\t')
    .replace(/<w:(?:br|cr)\b[^>]*\/?>(?:<\/w:(?:br|cr)>)?/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_whole, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_whole, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
