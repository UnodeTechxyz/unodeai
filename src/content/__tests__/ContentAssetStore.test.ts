import { describe, expect, it } from 'vitest';
import {
  CONTENT_ASSET_MAX_BYTES,
  CONTENT_ASSET_MAX_PAGE_TEXT,
  CONTENT_ASSET_MAX_TOTAL_TEXT,
  ContentAssetStore,
  type PdfExtractor,
} from '../ContentAssetStore';

const PDF = new TextEncoder().encode('%PDF-1.7\nnot a real parser fixture');

function extractor(pages = 42): PdfExtractor {
  return {
    async extract(_path, range) {
      return {
        totalPages: pages,
        pages: Array.from({ length: Math.min(pages, range.end) - range.start + 1 }, (_, index) => {
          const page = range.start + index;
          return {
            page,
            text: page === 3 ? undefined : `native text on page ${page}`,
            truncated: page === 2,
            ocrRequired: page === 3,
          };
        }),
      };
    },
  };
}

describe('ContentAssetStore', () => {
  it('stores only magic-confirmed images and exposes their bytes solely through the ephemeral vision port', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const store = new ContentAssetStore();
    try {
      const stored = await store.storeImage(png, 'public-url', 'text/plain');
      if ('error' in stored) { throw new Error(stored.error); }
      expect(stored).toMatchObject({ assetId: 'content-1', mediaKind: 'image', mimeType: 'image/png', byteLength: png.byteLength });
      expect(JSON.stringify(stored)).not.toContain('public-url');
      const vision = await store.imageForVision(stored.assetId);
      if ('error' in vision) { throw new Error(vision.error); }
      expect(vision.dataUrl).toBe(`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
      await expect(store.storeImage(new TextEncoder().encode('not an image'), 'public-url', 'image/png'))
        .resolves.toEqual({ error: 'unsupported' });
    } finally {
      await store.dispose();
    }
  });

  it('uses an opaque ordinal and never exposes the source or temporary path in a receipt', async () => {
    const store = new ContentAssetStore({ extractor: extractor() });
    try {
      const stored = await store.storePdf(PDF, 'user-attachment', 'text/plain'); // magic, not header, decides PDF
      expect(stored).toMatchObject({ assetId: 'content-1', mediaKind: 'pdf', mimeType: 'application/pdf' });
      expect(JSON.stringify(stored)).not.toContain('http');
      expect(JSON.stringify(stored)).not.toContain('user-attachment');
      expect(JSON.stringify(stored)).not.toMatch(/unode-content|\\.pdf/i);
    } finally {
      await store.dispose();
    }
  });

  it('pages a bounded turn-supplied text source behind an opaque receipt', async () => {
    const store = new ContentAssetStore();
    try {
      const body = `${'a'.repeat(CONTENT_ASSET_MAX_PAGE_TEXT)}needle`;
      const stored = await store.storeText(body, 'turn-supplied');
      if ('error' in stored) { throw new Error(stored.error); }
      expect(stored).toMatchObject({ assetId: 'content-1', mediaKind: 'text' });
      expect(JSON.stringify(stored)).not.toContain('needle');

      const read = await store.readExtractedContent(stored.assetId, { start: 2, end: 2 });
      if ('error' in read) { throw new Error(read.error); }
      expect(read.pages).toEqual({ requested: { start: 2, end: 2 }, extracted: 1, total: 2 });
      expect(read.items[0]?.text).toBe('needle');

      const search = await store.searchExtractedContent(stored.assetId, 'needle', { start: 2, end: 2 });
      if ('error' in search) { throw new Error(search.error); }
      expect(search.matches).toHaveLength(1);
      await expect(store.storeText('x'.repeat(CONTENT_ASSET_MAX_TOTAL_TEXT + 1), 'turn-supplied'))
        .resolves.toEqual({ error: 'oversized' });
    } finally {
      await store.dispose();
    }
  });

  it('reports page coverage and page-level OCR/truncation rather than claiming the document was read', async () => {
    const store = new ContentAssetStore({ extractor: extractor(42) });
    try {
      const stored = await store.storePdf(PDF, 'public-url');
      if ('error' in stored) { throw new Error(stored.error); }
      const read = await store.readExtractedContent(stored.assetId, { start: 1, end: 5 });
      if ('error' in read) { throw new Error(read.error); }
      expect(read.pages).toEqual({ requested: { start: 1, end: 5 }, extracted: 5, total: 42 });
      expect(read.items.find((page) => page.page === 2)?.truncated).toBe(true);
      expect(read.items.find((page) => page.page === 3)?.ocrRequired).toBe(true);

      const search = await store.searchExtractedContent(stored.assetId, 'native', { start: 1, end: 5 });
      if ('error' in search) { throw new Error(search.error); }
      expect(search.pages).toEqual({ searched: { start: 1, end: 5 }, total: 42 });
      expect(search.matches.map((match) => match.page)).toEqual([1, 2, 4, 5]);
      expect(search.ocrRequiredPages).toEqual([3]);
      expect(search.truncatedPages).toEqual([2]);
    } finally {
      await store.dispose();
    }
  });

  it('rejects a claimed PDF without PDF magic and makes expired assets unreachable', async () => {
    let now = 100;
    const store = new ContentAssetStore({ extractor: extractor(), now: () => now, ttlMs: 10 });
    try {
      await expect(store.storePdf(new TextEncoder().encode('not pdf'), 'public-url', 'application/pdf'))
        .resolves.toEqual({ error: 'unsupported' });
      const stored = await store.storePdf(PDF, 'public-url');
      if ('error' in stored) { throw new Error(stored.error); }
      now = 111;
      await expect(store.readExtractedContent(stored.assetId)).resolves.toEqual({ error: 'expired' });
      expect(store.getReceipt(stored.assetId)).toBeUndefined();
    } finally {
      await store.dispose();
    }
  });

  it('gives a local attachment the same magic, byte-limit, scan and parse outcomes as a public PDF', async () => {
    const kinds = ['public-url', 'user-attachment'] as const;
    const malformed = new TextEncoder().encode('not a PDF');
    const oversized = new Uint8Array(CONTENT_ASSET_MAX_BYTES + 1);
    oversized.set(PDF, 0);
    const scanExtractor: PdfExtractor = {
      async extract(_path, range) {
        return {
          totalPages: 2,
          pages: Array.from({ length: range.end - range.start + 1 }, (_, index) => ({
            page: range.start + index,
            truncated: false,
            ocrRequired: true,
          })),
        };
      },
    };

    for (const kind of kinds) {
      const store = new ContentAssetStore({ extractor: scanExtractor });
      try {
        await expect(store.storePdf(malformed, kind, 'application/pdf')).resolves.toEqual({ error: 'unsupported' });
        await expect(store.storePdf(oversized, kind, 'application/pdf')).resolves.toEqual({ error: 'oversized' });
        const stored = await store.storePdf(PDF, kind, 'application/pdf');
        if ('error' in stored) { throw new Error(stored.error); }
        const scanned = await store.readExtractedContent(stored.assetId, { start: 2, end: 2 });
        if ('error' in scanned) { throw new Error(scanned.error); }
        expect(scanned).toMatchObject({
          pages: { requested: { start: 2, end: 2 }, extracted: 1, total: 2 },
          items: [{ page: 2, ocrRequired: true }],
        });
      } finally {
        await store.dispose();
      }

      for (const [reason, error] of [
        ['encrypted', new Error('PasswordException: encrypted PDF')],
        ['malformed', new Error('invalid xref table')],
      ] as const) {
        const failedStore = new ContentAssetStore({ extractor: { async extract() { throw error; } } });
        try {
          const stored = await failedStore.storePdf(PDF, kind, 'application/pdf');
          if ('error' in stored) { throw new Error(stored.error); }
          await expect(failedStore.readExtractedContent(stored.assetId, { start: 1, end: 1 }))
            .resolves.toEqual({ error: reason });
        } finally {
          await failedStore.dispose();
        }
      }
    }
  });

  it.each([
    ['encrypted', new Error('PasswordException: encrypted PDF')],
    ['malformed', new Error('invalid xref table')],
    ['memory-limited', new Error('JavaScript heap out of memory')],
  ] as const)('fails closed with the structured %s reason', async (reason, error) => {
    const store = new ContentAssetStore({ extractor: { async extract() { throw error; } } });
    try {
      const stored = await store.storePdf(PDF, 'public-url');
      if ('error' in stored) { throw new Error(stored.error); }
      await expect(store.readExtractedContent(stored.assetId, { start: 1, end: 1 })).resolves.toEqual({ error: reason });
    } finally {
      await store.dispose();
    }
  });

  it('refuses over-page documents and removes an asset at backend disposal', async () => {
    const store = new ContentAssetStore({ extractor: extractor(201) });
    const stored = await store.storePdf(PDF, 'public-url');
    if ('error' in stored) { throw new Error(stored.error); }
    await expect(store.readExtractedContent(stored.assetId, { start: 1, end: 1 })).resolves.toEqual({ error: 'too-many-pages' });
    await store.dispose();
    await expect(store.readExtractedContent(stored.assetId)).resolves.toEqual({ error: 'expired' });
  });

  it('preserves cached overlap when a later range reaches the total extracted-text ceiling', async () => {
    const fullPage = 'x'.repeat(CONTENT_ASSET_MAX_PAGE_TEXT);
    const store = new ContentAssetStore({
      extractor: {
        async extract(_path, range) {
          return {
            totalPages: 11,
            pages: Array.from({ length: range.end - range.start + 1 }, (_, index) => ({
              page: range.start + index,
              text: fullPage,
              truncated: false,
              ocrRequired: false,
            })),
          };
        },
      },
    });
    try {
      const stored = await store.storePdf(PDF, 'public-url');
      if ('error' in stored) { throw new Error(stored.error); }
      const first = await store.readExtractedContent(stored.assetId, { start: 1, end: 10 });
      if ('error' in first) { throw new Error(first.error); }
      expect(first.items.reduce((sum, page) => sum + (page.text?.length ?? 0), 0)).toBe(CONTENT_ASSET_MAX_TOTAL_TEXT);

      const overlap = await store.readExtractedContent(stored.assetId, { start: 10, end: 11 });
      if ('error' in overlap) { throw new Error(overlap.error); }
      expect(overlap.items[0]).toMatchObject({ page: 10, text: fullPage, truncated: false });
      expect(overlap.items[1]).toMatchObject({ page: 11, text: undefined, truncated: true });
    } finally {
      await store.dispose();
    }
  });

  it('clamps unsafe or out-of-document page ranges before returning coverage', async () => {
    const store = new ContentAssetStore({ extractor: extractor(5) });
    try {
      const stored = await store.storePdf(PDF, 'public-url');
      if ('error' in stored) { throw new Error(stored.error); }
      const read = await store.readExtractedContent(stored.assetId, { start: Number.MAX_SAFE_INTEGER + 1, end: 999 });
      if ('error' in read) { throw new Error(read.error); }
      expect(read.pages.requested).toEqual({ start: 1, end: 5 });
    } finally {
      await store.dispose();
    }
  });
});
