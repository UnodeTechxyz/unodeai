import { parentPort } from 'node:worker_threads';
import { StringDecoder } from 'node:string_decoder';
import { docxAcceptedText, docxCommentCollector, docxCommentThreads, docxUnresolvedComments } from './DocxAcceptedText';
import { wordStoryModelFromXml } from '../office/word/WordRevisionModel';

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
 * v0.9.99: only text parts are opened: word/document.xml, word/comments.xml (presence notice only), or ppt/slides/slideN.xml. Every other
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
      let commentPresence: boolean | 'unknown' = false; let commentParaIds: Array<string | undefined> = [];
      let commentThreads: Map<string, { parent?: string; done?: string }> | 'unknown' | undefined;
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
          let accepted: ReturnType<typeof docxAcceptedText>;
          try { accepted = docxAcceptedText(documentXml, () => parentPort!.postMessage({ progress: true })); } catch (error) { reject(error); return; }
          const blocks = docxBlocks(accepted.xml);
          if (accepted.revisions) blocks.push('[DOCX notice] This file contains tracked changes. Deleted and moved-from content is omitted. Use inspect_office to inspect the document.');
          if (commentPresence === true || accepted.comments) blocks.push('[DOCX notice] This file contains comments. Use inspect_office to inspect the document.');
          else if (commentPresence === 'unknown') blocks.push('[DOCX notice] This file has a comments part that could not be inspected. The body text is still available.');
          const summary = revisionSummary(documentXml, accepted.revisions, commentPresence, commentParaIds, commentThreads);
          if (summary) blocks.push(summary);
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
        if (entry.fileName === 'word/comments.xml') {
          void optionalComments(zip, entry, expansionFloorBytes + maxExpansionRatio * Math.max(0, entry.compressedSize ?? 0))
            .then(result => { if (!done) { commentPresence = result === 'unknown' ? 'unknown' : result.length > 0; if (result !== 'unknown') commentParaIds = result; zip.readEntry(); } });
          return;
        }
        if (entry.fileName === 'word/commentsExtended.xml') {
          void optionalThreads(zip, entry, expansionFloorBytes + maxExpansionRatio * Math.max(0, entry.compressedSize ?? 0))
            .then(result => { if (!done) { commentThreads = result; zip.readEntry(); } });
          return;
        }
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

/** Optional metadata never refuses the body or contributes to its expansion accounting. No comment text is retained. */
function optionalPart<T>(zip: ZipFile, entry: ZipEntry, limit: number, make: () => { parser: { write(chunk: string): unknown; close(): unknown }; result: () => T }): Promise<T | 'unknown'> {
  if ((entry.generalPurposeBitFlag ?? 0) & 1 || (entry.versionNeededToExtract ?? 0) >= 45 || entry.extraFields?.some(field => field.id === 1)
    || ![0, 8].includes(entry.compressionMethod) || entry.uncompressedSize > limit) return Promise.resolve('unknown');
  return new Promise(resolve => zip.openReadStream(entry, (error, stream) => {
    if (error || !stream) { resolve('unknown'); return; }
    let settled = false; let bytes = 0; const decoder = new StringDecoder('utf8');
    const finish = (value: T | 'unknown') => { if (settled) return; settled = true; resolve(value); (stream as NodeJS.ReadableStream & { destroy(): void }).destroy(); };
    let reader: ReturnType<typeof make>;
    try { reader = make(); } catch { finish('unknown'); return; }
    stream.on('data', (chunk: Buffer) => {
      if (settled) return; bytes += chunk.byteLength;
      if (bytes > limit) { finish('unknown'); return; }
      try { parentPort!.postMessage({ progress: true }); reader.parser.write(decoder.write(chunk)); } catch { finish('unknown'); }
    });
    stream.once('error', () => finish('unknown'));
    stream.once('end', () => { if (settled) return; try { reader.parser.write(decoder.end()); reader.parser.close(); finish(reader.result()); } catch { finish('unknown'); } });
  }));
}
/** Each comment's last paragraph identity (its thread key); the array length is the comment count. */
function optionalComments(zip: ZipFile, entry: ZipEntry, limit: number): Promise<Array<string | undefined> | 'unknown'> {
  return optionalPart(zip, entry, limit, () => { const collector = docxCommentCollector(); return { parser: collector.parser, result: () => collector.lastParaIds }; });
}
function optionalThreads(zip: ZipFile, entry: ZipEntry, limit: number): Promise<Map<string, { parent?: string; done?: string }> | 'unknown'> {
  return optionalPart(zip, entry, limit, () => { const threads = docxCommentThreads(); return { parser: threads.parser, result: () => threads.threads }; });
}
/** One closing notice with revision and comment counts, only when the body has tracked changes or comments. */
function revisionSummary(xml: string, revised: boolean, presence: boolean | 'unknown', paraIds: Array<string | undefined>,
  threads: Map<string, { parent?: string; done?: string }> | 'unknown' | undefined): string | undefined {
  if (!revised && presence !== true) return undefined;
  let revisions = 0; let authors = 0;
  if (revised) {
    try {
      const model = wordStoryModelFromXml(xml, 'main', () => parentPort!.postMessage({ progress: true }), false);
      revisions = model.groups.length; authors = new Set(model.groups.map(group => group.author).filter(Boolean)).size;
    } catch { return undefined; }
  }
  const unresolved = docxUnresolvedComments(paraIds, threads instanceof Map ? threads : undefined);
  const comments = presence === 'unknown' ? 'unknown' : `${paraIds.length} (${unresolved === undefined ? 'resolution not recorded' : `${unresolved} unresolved`})`;
  return `[DOCX notice] Revisions: ${revisions} by ${authors} author${authors === 1 ? '' : 's'}; comments: ${comments}. Use inspect_office for details.`;
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
