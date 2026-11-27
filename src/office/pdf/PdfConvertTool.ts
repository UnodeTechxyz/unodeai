import type { PdfSourceSelector } from './PdfEditContracts';

/** v0.9.108 P4b (D12 route 2): a PDF with a text layer, converted to an editable .docx by installed Word on Windows. */
export const CONVERT_PDF_TO_DOCX_TOOL = 'convert_pdf_to_docx';

/** What the user does once, in Word, so that UnodeAi can convert; UnodeAi never changes this Word setting itself. */
export const WORD_PDF_NOTICE_STEPS = 'Word shows a notice when it opens a PDF ("Word will now convert your PDF to an editable Word document..."), and that notice would block a conversion Word runs out of sight. '
  + 'To allow conversions, the user turns it off once in Word: 1. In Word, choose File > Open and open any PDF. 2. In that notice, tick "Don’t show this message again" and choose OK. 3. Close the document and ask again. '
  + 'UnodeAi only reads this Word setting and never changes it. Without it, the source-document route still works: edit the DOCX the PDF was made from with edit_office and export it with export_pdf.';

export const CONVERT_PDF_TO_DOCX_SPEC = { type: 'function' as const, function: {
  name: CONVERT_PDF_TO_DOCX_TOOL,
  description: 'Convert a PDF that has a text layer into an editable .docx with installed Word on Windows, from a private copy, and save it at destination through the normal file-write approval. Use it to change the body text of a PDF when its source DOCX is not available; '
    + 'when the source DOCX is known, edit that instead and use export_pdf with regenerates_pdf. Word’s conversion can change the layout: after editing the .docx (edit_office, tracked by default) and exporting it with export_pdf, compare the old and new PDF pages side by side with view_pdf_pages before delivering. '
    + 'Runs only when the user has turned off Word’s PDF-conversion notice; otherwise it returns not-run with reason word-pdf-prompt-on and the steps for the user. A scanned PDF without a text layer returns pdf-no-text-layer: use view_pdf_pages with a model that reads images to rebuild it as a Word document. Encrypted PDFs are refused (pdf-encrypted). '
    + 'Commands, trust, source access, the native policy and file-write permission apply, as for export_pdf. The native stage has a five-minute limit; UnodeAi never force-ends Word, and native_stop reports what Word did after Stop or the limit. Other platforms return not-run with platform-unsupported.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    source: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', description: 'An authorized PDF file path.' },
      source_ref: { type: 'string', description: 'A PDF attachment source_ref (content-N) supplied to this request.' },
    }, description: 'The PDF to convert: exactly one of path or source_ref.' },
    destination: { type: 'string', description: 'Destination .docx path within your current file access; never the source.' },
  }, required: ['source', 'destination'] },
} };

/** The one input problem a call has, in words the model can act on; undefined when the input is well formed. */
export function convertPdfInput(args: Record<string, unknown>): { source: PdfSourceSelector; destination: string } | { issue: string } {
  const extra = Object.keys(args).filter(key => !['source', 'destination'].includes(key));
  if (extra.length) return { issue: `Unexpected convert_pdf_to_docx fields ${extra.join(', ')}. Use only source and destination.` };
  const source = args.source && typeof args.source === 'object' && !Array.isArray(args.source) ? Object.entries(args.source as Record<string, unknown>) : [];
  const [key, value] = source.length === 1 ? source[0] : [];
  if ((key !== 'path' && key !== 'source_ref') || typeof value !== 'string' || !value.trim()) {
    return { issue: 'convert_pdf_to_docx.source must be an object with exactly one of path or source_ref naming the PDF.' };
  }
  if (typeof args.destination !== 'string' || !/\.docx$/i.test(args.destination.trim())) return { issue: 'convert_pdf_to_docx.destination must be a file path ending in .docx.' };
  return { source: key === 'path' ? { path: value.trim() } : { source_ref: value.trim() }, destination: args.destination.trim() };
}

/** A conservative encryption check before Word is started: Word asks for a password in a dialog it cannot show. */
export function pdfLooksEncrypted(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes('/Encrypt');
}

export const CONVERT_PDF_ALTERNATIVES = 'Nothing was saved. Alternatives: if the source DOCX is known, edit it and use export_pdf with regenerates_pdf; or ask the user to open the PDF in Word and save it as .docx.';
