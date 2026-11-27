import type { PdfTextItem, PdfTextPort } from './PdfEditEngine';

interface PdfjsModule { getDocument(options: object): { promise: Promise<any> } }

/** PDF.js text items per page, from bytes only: no URL, range transport, fonts or scripting. */
export function pdfjsTextPort(load: () => Promise<PdfjsModule>, onPage: () => void = () => {}): PdfTextPort {
  return {
    async pages(bytes: Uint8Array): Promise<PdfTextItem[][]> {
      const pdfjs = await load();
      // PDF.js takes ownership of the buffer it parses; give it a private copy.
      const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false, useWorkerFetch: false, stopAtErrors: true, verbosity: 0 }).promise;
      try {
        const pages: PdfTextItem[][] = [];
        for (let number = 1; number <= document.numPages; number++) {
          const page = await document.getPage(number);
          const content = await page.getTextContent({ includeMarkedContent: false });
          pages.push(content.items.flatMap((item: any) => typeof item?.str === 'string' && Array.isArray(item.transform)
            ? [{ str: item.str, transform: item.transform.map(Number), width: Number(item.width) || 0, height: Number(item.height) || 0 }] : []));
          page.cleanup(); onPage();
        }
        return pages;
      } finally { await document.destroy(); }
    },
  };
}
