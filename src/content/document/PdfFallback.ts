import type { DocumentFailureCode } from './DocumentContracts';

export const PDF_CONVERSION_STEPS = '1. Open the Word file in Microsoft Word, click File → Save As, choose PDF, and click Save.\n'
  + '2. Or open it in LibreOffice, click File → Export as PDF.';
export const PDF_LANGUAGE_REPAIR = 'Set the language of that text (or the document) to zh-Hans, zh-Hant, ja or ko as appropriate, and try PDF again.';
export const PDF_FALLBACK_GUIDANCE = 'If a failed PDF result asks for Word, write the same document now with format docx '
  + '(same content, same path with .docx), using write_document and its normal write approval. '
  + 'Then tell the user the file is ready as Word only after its host receipt, and give these conversion steps:\n'
  + PDF_CONVERSION_STEPS + '\nDo not fall back after a permission or Plan refusal, Stop/cancellation, or a declined write.';

// Explicit PDF-specific failures only. Shared input, queue and commit failures must retain PDF repair/retry.
// Newly introduced codes require a deliberate decision here, not a prefix match or a default fallback.
// v0.9.99: total length is never a reason: the page, line, output-size and render-time ceilings are gone, and an
// out-of-memory, draft or cancellation result is not a PDF-specific failure.
const PDF_FALLBACK_CODES = new Set<DocumentFailureCode>([
  'font-resource-invalid', 'font-unavailable', 'font-embedding-restricted', 'font-discovery-limit',
  'font-budget', 'font-resource-changed', 'unsupported-glyph', 'unsupported-text-layout',
  'layout-unrepresentable', 'worker-exit',
]);

/** Fixed host wording only: never put document text, provider errors or filenames in a transcript reminder. */
export function pdfFallback(code: DocumentFailureCode, outputPath: unknown): { instruction: string; notice: string } | undefined {
  if (!PDF_FALLBACK_CODES.has(code)) return undefined;
  const reason = code.startsWith('font-') ? 'a required font could not be used'
    : ['unsupported-glyph', 'unsupported-text-layout'].includes(code) ? 'some text cannot be rendered in PDF'
    : code === 'layout-unrepresentable' ? 'some content cannot be laid out on a PDF page'
    : 'the PDF renderer exited before completing';
  const characterAlternative = ['unsupported-glyph', 'unsupported-text-layout'].includes(code)
    ? ' Or, if the character is decorative, replace it and try PDF again.' : '';
  const destination = typeof outputPath === 'string' && /\.pdf$/i.test(outputPath)
    ? ` Use path ${JSON.stringify(outputPath.replace(/\.pdf$/i, '.docx'))}.` : '';
  return {
    instruction: `The PDF could not be made because ${reason}. ${PDF_FALLBACK_GUIDANCE}${destination}${characterAlternative}`,
    notice: `The PDF could not be made (${reason}). UnodeAi asked the agent to save it as Word instead. To get a PDF:\n${PDF_CONVERSION_STEPS}`,
  };
}
