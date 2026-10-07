import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentAssetStore, type PdfExtractor } from '../../content/ContentAssetStore';
import type { ContentReceiptObservation } from '../../content/ContentReceipt';
import { WorkspaceTools } from '../WorkspaceTools';

const PDF = new TextEncoder().encode('%PDF-1.7\nreceipt fixture');

const extractor: PdfExtractor = {
  async extract(_path, range) {
    return {
      totalPages: 42,
      pages: Array.from({ length: range.end - range.start + 1 }, (_, index) => ({
        page: range.start + index,
        text: `content page ${range.start + index}`,
        truncated: false,
        ocrRequired: false,
      })),
    };
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('WorkspaceTools rich-content receipts', () => {
  it('records only a bounded image routing outcome, never source bytes or a destination', async () => {
    const receipts: ContentReceiptObservation[] = [];
    const store = new ContentAssetStore();
    const tools = new WorkspaceTools(
      process.cwd(), new Set(['read']), 'agent', undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, 'apply-edit', store, (receipt) => receipts.push(receipt),
    );
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const raw = Buffer.from(image).toString('base64');
    try {
      const stored = await store.storeImage(image, 'public-url', undefined, 'agent');
      if ('error' in stored) { throw new Error(stored.error); }
      tools.recordImageAssetOutcome(stored.assetId, 'stored');
      tools.recordImageAssetOutcome(stored.assetId, 'sent');
      tools.recordImageAssetOutcome(stored.assetId, 'omitted');

      expect(receipts).toEqual([
        { assetId: 'content-1', contentClass: 'image', action: 'stored', processingClass: 'local-storage', consentOutcome: 'not-requested' },
        { assetId: 'content-1', contentClass: 'image', action: 'sent', processingClass: 'remote-vision', consentOutcome: 'approved' },
        { assetId: 'content-1', contentClass: 'image', action: 'omitted', processingClass: 'remote-vision', consentOutcome: 'not-requested' },
      ]);
      expect(JSON.stringify(receipts)).not.toContain(raw);
      expect(JSON.stringify(receipts)).not.toContain('public-url');
      expect(JSON.stringify(receipts)).not.toContain('example.test');
    } finally {
      await store.dispose();
    }
  });

  it('imports a local PDF through the same receipt-only, page-scoped surface', async () => {
    const receipts: ContentReceiptObservation[] = [];
    const store = new ContentAssetStore({ extractor });
    const tools = new WorkspaceTools(
      process.cwd(), new Set(['read']), 'agent', undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, 'apply-edit', store, (receipt) => receipts.push(receipt),
    );
    const filename = 'private-board-pack.pdf';
    const extractedText = 'content page 2';
    try {
      const intake = await tools.importUserAttachedPdfs([{
        name: filename,
        mime: 'application/octet-stream',
        kind: 'pdf',
        dataBase64: Buffer.from(PDF).toString('base64'),
        size: PDF.byteLength,
      }]);
      expect(intake).toContain('temporary asset content-1');
      expect(intake).not.toContain(filename);
      expect(intake).not.toContain(extractedText);
      await expect(tools.runText('read_extracted_content', { assetId: 'content-1', pages: { start: 2, end: 3 } }))
        .resolves.toContain('extracted 2 of 42 total');

      expect(receipts).toEqual([
        {
          assetId: 'content-1', contentClass: 'pdf', action: 'stored',
          extractionAttempted: false, extractionSucceeded: false, truncated: false, ocrRequired: false,
        },
        {
          assetId: 'content-1', contentClass: 'pdf', action: 'read',
          extractionAttempted: true, extractionSucceeded: true,
          pages: { start: 2, end: 3, total: 42, extracted: 2 },
          truncated: false, ocrRequired: false,
        },
      ]);
      expect(JSON.stringify(receipts)).not.toContain(filename);
      expect(JSON.stringify(receipts)).not.toContain(extractedText);
    } finally {
      await store.dispose();
    }
  });

  it('reports only a stored receipt and bounded page coverage to its host observer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(PDF, {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    })));
    const receipts: ContentReceiptObservation[] = [];
    const store = new ContentAssetStore({ extractor });
    const tools = new WorkspaceTools(
      process.cwd(), new Set(['read']), 'agent', undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, 'apply-edit', store, (receipt) => receipts.push(receipt),
    );
    try {
      // A public TEST-NET literal keeps this receipt-only test independent of DNS timing; fetch itself is stubbed.
      await expect(tools.runText('fetch_url', { url: 'https://203.0.113.1/board-pack.pdf?token=never-record' }))
        .resolves.toContain('temporary asset content-1');
      await expect(tools.runText('read_extracted_content', { assetId: 'content-1', pages: { start: 1, end: 5 } }))
        .resolves.toContain('extracted 5 of 42 total');

      expect(receipts).toEqual([
        {
          assetId: 'content-1', contentClass: 'pdf', action: 'stored',
          extractionAttempted: false, extractionSucceeded: false, truncated: false, ocrRequired: false,
        },
        {
          assetId: 'content-1', contentClass: 'pdf', action: 'read',
          extractionAttempted: true, extractionSucceeded: true,
          pages: { start: 1, end: 5, total: 42, extracted: 5 },
          truncated: false, ocrRequired: false,
        },
      ]);
      expect(JSON.stringify(receipts)).not.toContain('203.0.113.1');
      expect(JSON.stringify(receipts)).not.toContain('token=');
    } finally {
      await store.dispose();
    }
  });

  it('keeps scanned and truncated searched pages visible even when neither page matches', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(PDF, {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    })));
    const receipts: ContentReceiptObservation[] = [];
    const store = new ContentAssetStore({
      extractor: {
        async extract(_path, range) {
          return {
            totalPages: 2,
            pages: Array.from({ length: range.end - range.start + 1 }, (_, index) => {
              const page = range.start + index;
              return page === 1
                ? { page, truncated: false, ocrRequired: true }
                : { page, text: 'different content', truncated: true, ocrRequired: false };
            }),
          };
        },
      },
    });
    const tools = new WorkspaceTools(
      process.cwd(), new Set(['read']), 'agent', undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, 'apply-edit', store, (receipt) => receipts.push(receipt),
    );
    try {
      await tools.runText('fetch_url', { url: 'https://203.0.113.1/scanned.pdf' });
      const output = await tools.runText('search_extracted_content', {
        assetId: 'content-1', query: 'not present', pages: { start: 1, end: 2 },
      });
      expect(output).toContain('OCR required / unavailable on searched page(s): 1');
      expect(output).toContain('truncated on searched page(s): 2');
      expect(receipts.at(-1)).toMatchObject({
        action: 'searched', extractionSucceeded: true, ocrRequired: true, truncated: true,
      });
    } finally {
      await store.dispose();
    }
  });
});
