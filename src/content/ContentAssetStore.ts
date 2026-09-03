import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

export const CONTENT_ASSET_MAX_BYTES = 10 * 1024 * 1024;
export const CONTENT_ASSET_MAX_PAGES = 200;
export const CONTENT_ASSET_MAX_PAGE_TEXT = 20_000;
export const CONTENT_ASSET_MAX_TOTAL_TEXT = 200_000;
export const CONTENT_ASSET_TTL_MS = 30 * 60_000;
export const CONTENT_ASSET_PARSE_TIMEOUT_MS = 15_000;
/** Hard per-worker heap ceiling; PDF parsing must not compete with the extension host for unbounded memory. */
export const CONTENT_ASSET_WORKER_MAX_OLD_GENERATION_MB = 64;
/** A document archive with thousands of small entries is still a denial-of-service input. */
export const CONTENT_ASSET_MAX_ZIP_ENTRIES = 2_000;

export type ContentAssetState = 'ready' | 'extracting' | 'unsupported' | 'blocked' | 'failed' | 'expired';
export type ContentAssetSourceKind = 'public-url' | 'user-attachment' | 'turn-supplied';
export type ContentAssetMediaKind = 'pdf' | 'text' | 'image' | 'video' | 'unknown';
export type PdfFailureReason = 'unsupported' | 'encrypted' | 'malformed' | 'oversized' | 'too-many-pages' | 'timed-out' | 'memory-limited' | 'expired';

export interface ContentAssetRecord {
  id: string;
  sourceKind: ContentAssetSourceKind;
  mediaKind: ContentAssetMediaKind;
  mimeType: string;
  byteLength: number;
  createdAt: number;
  expiresAt: number;
  extractionState: ContentAssetState;
}

export interface PdfPageExtraction {
  page: number;
  text?: string;
  truncated: boolean;
  ocrRequired: boolean;
}

export interface PdfExtraction {
  totalPages: number;
  pages: PdfPageExtraction[];
}

export interface ExtractedContentRead {
  assetId: string;
  pages: { requested: { start: number; end: number }; extracted: number; total: number };
  items: PdfPageExtraction[];
}

export interface ExtractedContentSearch {
  assetId: string;
  pages: { searched: { start: number; end: number }; total: number };
  matches: Array<{ page: number; excerpt: string; truncated: boolean; ocrRequired: boolean }>;
  /** Searched pages whose limitations must remain visible even when they cannot produce a match. */
  ocrRequiredPages: number[];
  truncatedPages: number[];
}

export interface ContentAssetReceipt {
  assetId: string;
  mediaKind: ContentAssetMediaKind;
  mimeType: string;
  byteLength: number;
  extractionState: ContentAssetState;
}

/** Ephemeral only: callers must never put this object in history, evidence, or a model tool result. */
export interface ImageAssetForVision {
  assetId: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  byteLength: number;
  dataUrl: string;
}

interface StoredAsset extends ContentAssetRecord {
  path?: string;
  /** Agent that created this asset through its own tool surface. Never exposed in a receipt. */
  ownerAgentId?: string;
  /** Turn-supplied text stays in the bounded, expiring host store and never crosses the message bus. */
  text?: string;
  extraction?: PdfExtraction;
  failure?: PdfFailureReason;
}

export interface PdfExtractor {
  extract(path: string, range: { start: number; end: number }): Promise<{ totalPages: number; pages: PdfPageExtraction[] }>;
}

export interface OfficeExtractor {
  extract(path: string): Promise<{ format: 'docx' | 'pptx'; blocks: string[] }>;
}

/**
 * Extract a user-authorised workspace document without placing it in the content-asset store. The caller
 * owns normal read_file paging and returns the text in that tool result; this temporary file exists only to
 * give the bounded worker a stable byte snapshot while it parses.
 */
export async function extractWorkspaceDocument(bytes: Uint8Array): Promise<{ text?: string; error?: PdfFailureReason }> {
  if (bytes.byteLength > CONTENT_ASSET_MAX_BYTES) return { error: 'oversized' };
  const isPdfDocument = isPdf(bytes);
  const isOfficeDocument = isZip(bytes);
  if (!isPdfDocument && !isOfficeDocument) return { error: 'unsupported' };
  const root = await mkdtemp(join(tmpdir(), 'unode-read-file-'));
  const documentPath = join(root, isPdfDocument ? 'document.pdf' : 'document.zip');
  try {
    await writeFile(documentPath, bytes);
    if (isPdfDocument) {
      const extracted = await new WorkerPdfExtractor().extract(documentPath, { start: 1, end: CONTENT_ASSET_MAX_PAGES });
      if (extracted.totalPages > CONTENT_ASSET_MAX_PAGES) return { error: 'too-many-pages' };
      const text = extracted.pages.map((page) => `Page ${page.page}: ${page.ocrRequired
        ? 'OCR required / unavailable'
        : page.text ?? 'No extractable text.'}`).join('\n\n');
      return Buffer.byteLength(text, 'utf8') > CONTENT_ASSET_MAX_BYTES ? { error: 'oversized' } : { text };
    }
    const extracted = await new WorkerOfficeExtractor().extract(documentPath);
    const text = extracted.format === 'pptx'
      ? extracted.blocks.map((block, index) => `Slide ${index + 1}: ${block}`).join('\n\n')
      : extracted.blocks.join('\n\n');
    return Buffer.byteLength(text, 'utf8') > CONTENT_ASSET_MAX_BYTES ? { error: 'oversized' } : { text };
  } catch (error) {
    return { error: isPdfDocument ? classifyPdfFailure(error) : classifyOfficeFailure(error) };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** A host-owned store: records intentionally omit URL, temp path and all raw/extracted content. */
export class ContentAssetStore {
  private readonly assets = new Map<string, StoredAsset>();
  private nextId = 1;
  private root: string | undefined;

  constructor(
    private readonly options: {
      ttlMs?: number;
      now?: () => number;
      extractor?: PdfExtractor;
    } = {},
  ) {}

  async storePdf(
    bytes: Uint8Array,
    sourceKind: ContentAssetSourceKind,
    _declaredMimeType = 'application/pdf',
    ownerAgentId?: string,
  ): Promise<ContentAssetReceipt | { error: PdfFailureReason }> {
    await this.cleanupExpired();
    if (bytes.byteLength > CONTENT_ASSET_MAX_BYTES) {
      return { error: 'oversized' };
    }
    if (!isPdf(bytes)) {
      return { error: 'unsupported' };
    }
    const root = await this.ensureRoot();
    const id = `content-${this.nextId++}`;
    const path = join(root, `${id}.pdf`);
    await writeFile(path, bytes);
    const now = this.now();
    const asset: StoredAsset = {
      id,
      sourceKind,
      mediaKind: 'pdf',
      // Magic bytes decide the media kind; do not preserve a lying or overly-specific server header.
      mimeType: 'application/pdf',
      byteLength: bytes.byteLength,
      createdAt: now,
      expiresAt: now + (this.options.ttlMs ?? CONTENT_ASSET_TTL_MS),
      extractionState: 'ready',
      path,
      ...(ownerAgentId ? { ownerAgentId } : {}),
    };
    this.assets.set(id, asset);
    return this.receipt(asset);
  }

  /** Store a magic-confirmed image as a session asset. No source name, URL, or path leaves this class. */
  async storeImage(
    bytes: Uint8Array,
    sourceKind: ContentAssetSourceKind,
    _declaredMimeType = 'application/octet-stream',
    ownerAgentId?: string,
  ): Promise<ContentAssetReceipt | { error: 'unsupported' | 'oversized' }> {
    await this.cleanupExpired();
    if (bytes.byteLength > CONTENT_ASSET_MAX_BYTES) {
      return { error: 'oversized' };
    }
    const mimeType = imageMimeFromBytes(bytes);
    if (!mimeType) {
      return { error: 'unsupported' };
    }
    const root = await this.ensureRoot();
    const id = `content-${this.nextId++}`;
    const path = join(root, `${id}${imageExtension(mimeType)}`);
    await writeFile(path, bytes);
    const now = this.now();
    const asset: StoredAsset = {
      id,
      sourceKind,
      mediaKind: 'image',
      mimeType,
      byteLength: bytes.byteLength,
      createdAt: now,
      expiresAt: now + (this.options.ttlMs ?? CONTENT_ASSET_TTL_MS),
      extractionState: 'ready',
      path,
      ...(ownerAgentId ? { ownerAgentId } : {}),
    };
    this.assets.set(id, asset);
    return this.receipt(asset);
  }

  /**
   * Store one bounded turn-supplied text source behind the same opaque id used for binary assets.
   * This deliberately accepts no filename or source URL: those details belong to the manifest receipt,
   * while a delegate gets only an id it can page through with the regular extracted-content tools.
   */
  async storeText(
    text: string,
    sourceKind: ContentAssetSourceKind = 'turn-supplied',
    ownerAgentId?: string,
  ): Promise<ContentAssetReceipt | { error: 'oversized' }> {
    await this.cleanupExpired();
    const value = String(text ?? '');
    const byteLength = Buffer.byteLength(value, 'utf8');
    // Page reads are capped at 20k chars and total retained text at 200k. Refuse rather than retaining a
    // silently truncated source: a delegate must be able to report a missing source honestly.
    if (byteLength > CONTENT_ASSET_MAX_BYTES || value.length > CONTENT_ASSET_MAX_TOTAL_TEXT) {
      return { error: 'oversized' };
    }
    const now = this.now();
    const asset: StoredAsset = {
      id: `content-${this.nextId++}`,
      sourceKind,
      mediaKind: 'text',
      mimeType: 'text/plain; charset=utf-8',
      byteLength,
      createdAt: now,
      expiresAt: now + (this.options.ttlMs ?? CONTENT_ASSET_TTL_MS),
      extractionState: 'ready',
      text: value,
      ...(ownerAgentId ? { ownerAgentId } : {}),
    };
    this.assets.set(asset.id, asset);
    return this.receipt(asset);
  }

  /** Returns actual bytes only for the immediately forthcoming model request; never durable state. */
  async imageForVision(id: string): Promise<ImageAssetForVision | { error: 'unsupported' | 'expired' }> {
    const asset = this.getLive(id);
    if (!asset) { return { error: 'expired' }; }
    if (asset.mediaKind !== 'image' || !isSupportedImageMime(asset.mimeType)) { return { error: 'unsupported' }; }
    if (!asset.path) { return { error: 'unsupported' }; }
    const bytes = await readFile(asset.path);
    return {
      assetId: asset.id,
      mimeType: asset.mimeType,
      byteLength: asset.byteLength,
      dataUrl: `data:${asset.mimeType};base64,${bytes.toString('base64')}`,
    };
  }

  getReceipt(id: string): ContentAssetReceipt | undefined {
    const asset = this.getLive(id);
    return asset ? this.receipt(asset) : undefined;
  }

  /** Ownership is host-only. A shared store must not turn a guessed ordinal into read authority. */
  isOwnedBy(id: string, agentId: string): boolean {
    return this.getLive(id)?.ownerAgentId === agentId;
  }

  async readExtractedContent(id: string, range?: { start?: number; end?: number }): Promise<ExtractedContentRead | { error: PdfFailureReason }> {
    const asset = this.getLive(id);
    if (!asset) { return { error: 'expired' }; }
    if (asset.mediaKind === 'text') {
      const pages = textPages(asset.text ?? '');
      const requested = this.normalizeRange(range, 1, pages.length);
      const items = pages.filter((page) => page.page >= requested.start && page.page <= requested.end);
      return {
        assetId: id,
        pages: { requested, extracted: items.length, total: pages.length },
        items,
      };
    }
    if (asset.mediaKind !== 'pdf') { return { error: 'unsupported' }; }
    const initial = this.normalizeRange(range, 1, CONTENT_ASSET_MAX_PAGES);
    const extracted = await this.extract(asset, initial);
    if ('error' in extracted) { return extracted; }
    const requested = this.normalizeRange(range, 1, extracted.totalPages);
    const pages = await this.extract(asset, requested);
    if ('error' in pages) { return pages; }
    return {
      assetId: id,
      pages: { requested, extracted: pages.pages.length, total: pages.totalPages },
      items: pages.pages,
    };
  }

  async searchExtractedContent(
    id: string,
    query: string,
    range?: { start?: number; end?: number },
  ): Promise<ExtractedContentSearch | { error: PdfFailureReason }> {
    const asset = this.getLive(id);
    if (!asset) { return { error: 'expired' }; }
    if (asset.mediaKind === 'text') {
      const needle = query.trim();
      if (!needle) { return { error: 'malformed' }; }
      const allPages = textPages(asset.text ?? '');
      const searched = this.normalizeRange(range, 1, allPages.length);
      const lower = needle.toLowerCase();
      const pages = allPages.filter((page) => page.page >= searched.start && page.page <= searched.end);
      return {
        assetId: id,
        pages: { searched, total: allPages.length },
        ocrRequiredPages: [],
        truncatedPages: [],
        matches: pages.flatMap((page) => {
          const text = page.text ?? '';
          const at = text.toLowerCase().indexOf(lower);
          return at < 0 ? [] : [{
            page: page.page,
            excerpt: text.slice(Math.max(0, at - 120), Math.min(text.length, at + needle.length + 240)),
            truncated: false,
            ocrRequired: false,
          }];
        }),
      };
    }
    if (asset.mediaKind !== 'pdf') { return { error: 'unsupported' }; }
    const needle = query.trim();
    if (!needle) { return { error: 'malformed' }; }
    const initial = this.normalizeRange(range, 1, CONTENT_ASSET_MAX_PAGES);
    const extracted = await this.extract(asset, initial);
    if ('error' in extracted) { return extracted; }
    const searched = this.normalizeRange(range, 1, extracted.totalPages);
    const result = await this.extract(asset, searched);
    if ('error' in result) { return result; }
    const lower = needle.toLowerCase();
    return {
      assetId: id,
      pages: { searched, total: result.totalPages },
      ocrRequiredPages: result.pages.filter((page) => page.ocrRequired).map((page) => page.page),
      truncatedPages: result.pages.filter((page) => page.truncated).map((page) => page.page),
      matches: result.pages.flatMap((page) => {
        if (!page.text || !page.text.toLowerCase().includes(lower)) { return []; }
        const at = page.text.toLowerCase().indexOf(lower);
        return [{
          page: page.page,
          excerpt: page.text.slice(Math.max(0, at - 120), Math.min(page.text.length, at + needle.length + 240)),
          truncated: page.truncated,
          ocrRequired: page.ocrRequired,
        }];
      }),
    };
  }

  async cleanupExpired(): Promise<void> {
    const now = this.now();
    for (const [id, asset] of this.assets) {
      if (asset.expiresAt > now) { continue; }
      this.assets.delete(id);
      if (asset.path) {
        await rm(asset.path, { force: true }).catch(() => undefined);
      }
    }
  }

  async dispose(): Promise<void> {
    this.assets.clear();
    if (this.root) {
      const root = this.root;
      this.root = undefined;
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async extract(asset: StoredAsset, range: { start: number; end: number }): Promise<PdfExtraction | { error: PdfFailureReason }> {
    const existing = asset.extraction;
    if (existing && range.start >= 1 && range.end <= existing.totalPages
      && Array.from({ length: range.end - range.start + 1 }, (_, index) => existing.pages.some((page) => page.page === range.start + index)).every(Boolean)) {
      return { totalPages: existing.totalPages, pages: existing.pages.filter((page) => page.page >= range.start && page.page <= range.end) };
    }
    asset.extractionState = 'extracting';
    try {
      // PDF.js learns the total page count while opening the document, then reads only this requested range.
      // A five-page consultation must not silently parse and retain the other 37 pages of a 42-page file.
      if (!asset.path) { return { error: 'unsupported' }; }
      const extracted = await this.extractor().extract(asset.path, range);
      if (extracted.totalPages > CONTENT_ASSET_MAX_PAGES) {
        asset.extractionState = 'failed';
        asset.failure = 'too-many-pages';
        return { error: 'too-many-pages' };
      }
      const pagesByNumber = new Map<number, PdfPageExtraction>(existing?.pages.map((page) => [page.page, page]));
      const alreadyStored = [...pagesByNumber.values()].reduce((sum, page) => sum + (page.text?.length ?? 0), 0);
      // A partially cached range is parsed as one contiguous worker request. Bound only the newly learned
      // pages and preserve the cached ones; otherwise an overlapping retry at the total-text ceiling can
      // replace a previously readable page with an empty, truncated copy.
      const newPages = extracted.pages.filter((page) => !pagesByNumber.has(page.page));
      const bounded = boundPages(newPages, Math.max(0, CONTENT_ASSET_MAX_TOTAL_TEXT - alreadyStored));
      for (const page of bounded) { pagesByNumber.set(page.page, page); }
      asset.extraction = { totalPages: extracted.totalPages, pages: [...pagesByNumber.values()].sort((a, b) => a.page - b.page) };
      asset.extractionState = 'ready';
      return {
        totalPages: extracted.totalPages,
        pages: [...pagesByNumber.values()].filter((page) => page.page >= range.start && page.page <= range.end),
      };
    } catch (error) {
      const reason = classifyPdfFailure(error);
      asset.extractionState = 'failed';
      asset.failure = reason;
      return { error: reason };
    }
  }

  private extractor(): PdfExtractor {
    return this.options.extractor ?? new WorkerPdfExtractor();
  }

  private getLive(id: string): StoredAsset | undefined {
    const asset = this.assets.get(id);
    if (!asset) { return undefined; }
    if (asset.expiresAt <= this.now()) {
      void this.cleanupExpired();
      return undefined;
    }
    return asset;
  }

  private async ensureRoot(): Promise<string> {
    if (!this.root) {
      this.root = await mkdtemp(join(tmpdir(), 'unode-content-'));
    }
    return this.root;
  }

  private normalizeRange(range: { start?: number; end?: number } | undefined, min: number, max: number): { start: number; end: number } {
    const start = Number.isSafeInteger(range?.start) ? Math.min(max, Math.max(min, range!.start!)) : min;
    const end = Number.isSafeInteger(range?.end) ? Math.min(max, range!.end!) : max;
    return { start, end: Math.max(start, end) };
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  private receipt(asset: StoredAsset): ContentAssetReceipt {
    return {
      assetId: asset.id,
      mediaKind: asset.mediaKind,
      mimeType: asset.mimeType,
      byteLength: asset.byteLength,
      extractionState: asset.extractionState,
    };
  }
}

class WorkerPdfExtractor implements PdfExtractor {
  async extract(path: string, range: { start: number; end: number }): Promise<{ totalPages: number; pages: PdfPageExtraction[] }> {
    // tsc keeps this module under out/content; esbuild inlines it into out/extension.js and emits the worker
    // separately under out/content. Supporting both paths keeps the extractor testable before packaging.
    const sibling = join(__dirname, 'PdfWorker.js');
    const bundled = join(__dirname, 'content', 'PdfWorker.js');
    const workerPath = [sibling, bundled, join(process.cwd(), 'out', 'content', 'PdfWorker.js')].find(existsSync);
    if (!workerPath) throw new Error('PDF worker is unavailable.');
    const worker = new Worker(workerPath, {
      // `resourceLimits` belongs to this untrusted-document worker, not the extension host. A document
      // that cannot be parsed inside this budget fails closed rather than growing the host heap.
      resourceLimits: { maxOldGenerationSizeMb: CONTENT_ASSET_WORKER_MAX_OLD_GENERATION_MB },
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error('PDF parsing timed out.'));
      }, CONTENT_ASSET_PARSE_TIMEOUT_MS);
      const finish = () => clearTimeout(timer);
      worker.once('message', (message: { ok: boolean; value?: { totalPages: number; pages: PdfPageExtraction[] }; error?: string }) => {
        finish();
        void worker.terminate();
        message.ok && message.value ? resolve(message.value) : reject(new Error(message.error ?? 'PDF parsing failed.'));
      });
      worker.once('error', (error) => { finish(); void worker.terminate(); reject(error); });
      worker.postMessage({ path, range });
    });
  }
}

class WorkerOfficeExtractor implements OfficeExtractor {
  async extract(path: string): Promise<{ format: 'docx' | 'pptx'; blocks: string[] }> {
    const sibling = join(__dirname, 'OfficeWorker.js');
    const bundled = join(__dirname, 'content', 'OfficeWorker.js');
    const workerPath = [sibling, bundled, join(process.cwd(), 'out', 'content', 'OfficeWorker.js')].find(existsSync);
    if (!workerPath) throw new Error('Office document worker is unavailable.');
    const worker = new Worker(workerPath, {
      resourceLimits: { maxOldGenerationSizeMb: CONTENT_ASSET_WORKER_MAX_OLD_GENERATION_MB },
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error('Office document parsing timed out.'));
      }, CONTENT_ASSET_PARSE_TIMEOUT_MS);
      const finish = () => clearTimeout(timer);
      worker.once('message', (message: { ok: boolean; value?: { format: 'docx' | 'pptx'; blocks: string[] }; error?: string }) => {
        finish();
        void worker.terminate();
        message.ok && message.value ? resolve(message.value) : reject(new Error(message.error ?? 'Office document parsing failed.'));
      });
      worker.once('error', (error) => { finish(); void worker.terminate(); reject(error); });
      worker.postMessage({ path, maxBytes: CONTENT_ASSET_MAX_BYTES, maxEntries: CONTENT_ASSET_MAX_ZIP_ENTRIES });
    });
  }
}

export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

/** ZIP magic is only an intake candidate; OfficeWorker still demands an allowed Office text part. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06) || (bytes[2] === 0x07 && bytes[3] === 0x08));
}

/** Shared byte signature rule for image storage; declared MIME is display metadata, never authority. */
export function imageMimeFromBytes(bytes: Uint8Array): ImageAssetForVision['mimeType'] | undefined {
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) { return 'image/png'; }
  if (hasBytes(bytes, [0xff, 0xd8, 0xff])) { return 'image/jpeg'; }
  if (hasBytes(bytes, [0x47, 0x49, 0x46, 0x38])) { return 'image/gif'; }
  if (hasBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && hasBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)) { return 'image/webp'; }
  return undefined;
}

function hasBytes(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + prefix.length && prefix.every((byte, index) => bytes[offset + index] === byte);
}

function isSupportedImageMime(value: string): value is ImageAssetForVision['mimeType'] {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif';
}

function imageExtension(mimeType: ImageAssetForVision['mimeType']): string {
  return mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.gif';
}

/** Page text sources with the same bounded unit the PDF interface exposes. */
function textPages(text: string): PdfPageExtraction[] {
  const value = String(text ?? '');
  const total = Math.max(1, Math.ceil(value.length / CONTENT_ASSET_MAX_PAGE_TEXT));
  return Array.from({ length: total }, (_, index) => ({
    page: index + 1,
    text: value.slice(index * CONTENT_ASSET_MAX_PAGE_TEXT, (index + 1) * CONTENT_ASSET_MAX_PAGE_TEXT) || undefined,
    truncated: false,
    ocrRequired: false,
  }));
}

function boundPages(pages: PdfPageExtraction[], initialRemaining: number): PdfPageExtraction[] {
  let remaining = initialRemaining;
  return pages.map((page) => {
    const text = page.text ?? '';
    const allowed = Math.max(0, Math.min(CONTENT_ASSET_MAX_PAGE_TEXT, remaining));
    const clipped = text.slice(0, allowed);
    remaining -= clipped.length;
    return {
      ...page,
      text: clipped || undefined,
      truncated: page.truncated || clipped.length < text.length,
      ocrRequired: page.ocrRequired,
    };
  });
}

function classifyPdfFailure(error: unknown): PdfFailureReason {
  const text = String(error).toLowerCase();
  if (text.includes('password') || text.includes('encrypted')) { return 'encrypted'; }
  if (text.includes('timed out')) { return 'timed-out'; }
  if (text.includes('heap out of memory') || text.includes('memory limit')) { return 'memory-limited'; }
  return 'malformed';
}

function classifyOfficeFailure(error: unknown): PdfFailureReason {
  const text = String(error).toLowerCase();
  if (text.includes('encrypted')) return 'encrypted';
  if (text.includes('timed out')) return 'timed-out';
  if (text.includes('heap out of memory') || text.includes('memory limit')) return 'memory-limited';
  if (text.includes('exceeds the limit') || text.includes('too many entries')) return 'oversized';
  if (text.includes('not a supported docx or pptx')) return 'unsupported';
  return 'malformed';
}
