/** v0.9.108 P1: a PDF of an inspected DOCX/PPTX, produced by installed Word, PowerPoint or LibreOffice on Windows. */
export const EXPORT_PDF_TOOL = 'export_pdf';
export const EXPORT_PDF_SPEC = { type: 'function' as const, function: {
  name: EXPORT_PDF_TOOL,
  description: 'Export the exact DOCX/PPTX snapshot returned by inspect_office to a PDF file with installed Word, PowerPoint or LibreOffice on Windows, and save it at path through the normal file-write approval. '
    + 'The export is made from a private passive copy: active and external content is removed first, and the receipt reports copy_partial and the removed parts; the original is unchanged. '
    + 'auto follows the workspace renderer preference; word, powerpoint or libreoffice selects that application. A failed export is not retried with another application: choose another adapter_id, regenerate a write_document document with its built-in PDF output, or save as PDF in Word. '
    + 'Commands, trust, source access, the native policy and file-write permission apply. Native stages have a five-minute limit; UnodeAi never force-ends Word or PowerPoint, and native_stop reports what the application did after Stop or the limit. Not available on other platforms. '
    + 'To change the body text of a PDF made from a DOCX/PPTX: edit that source document with edit_office (Word edits are tracked by default), then export it here with regenerates_pdf naming the earlier PDF; the receipt says whether UnodeAi records confirm this document is the source of that PDF. For a combined PDF (attachments, watermark, page numbers, signature), then put the new pages in with edit_pdf replace_pages and repeat the overlays on those pages; signatures on replaced pages are invalidated and must be placed again. '
    + 'Without the source document, convert_pdf_to_docx (if offered) turns a PDF with a text layer into an editable .docx with Word; edit that, export it here, and compare the old and new PDF pages side by side with view_pdf_pages. A scanned PDF has no text layer: view_pdf_pages lets a model that reads images rebuild it as a Word document.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    snapshot_ref: { type: 'string', description: 'Exact snapshot_ref returned by inspect_office on this DOCX/PPTX in this agent context. Call inspect_office first.' },
    path: { type: 'string', description: 'Destination .pdf path within your current file access. The source is never overwritten by this tool.' },
    adapter_id: { type: 'string', enum: ['auto', 'word', 'powerpoint', 'libreoffice'], description: 'auto follows the user renderer preference and installed candidates; explicit names select that app for this request.' },
    regenerates_pdf: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', description: 'An authorized path of the earlier PDF.' },
      source_ref: { type: 'string', description: 'A PDF attachment source_ref (content-N) supplied to this request.' },
    }, description: 'Optional, exactly one of path or source_ref: the earlier PDF this export regenerates from its source document. Only checked and reported (source_lineage); it never blocks the export or grants access.' },
  }, required: ['snapshot_ref', 'path', 'adapter_id'] },
} };

/** The one input problem a call has, in words the model can act on; undefined when the input is well formed. */
export function exportPdfInputIssue(args: Record<string, unknown>): string | undefined {
  const extra = Object.keys(args).filter(key => !['snapshot_ref', 'path', 'adapter_id', 'regenerates_pdf'].includes(key));
  if (extra.length) return `Unexpected export_pdf fields ${extra.join(', ')}. Use only snapshot_ref, path, adapter_id and optionally regenerates_pdf.`;
  if (typeof args.snapshot_ref !== 'string' || !args.snapshot_ref) return 'export_pdf.snapshot_ref must be the string returned by inspect_office on the source DOCX/PPTX.';
  if (typeof args.path !== 'string' || !/\.pdf$/i.test(args.path.trim())) return 'export_pdf.path must be a destination file path ending in .pdf.';
  if (!['auto', 'word', 'powerpoint', 'libreoffice'].includes(String(args.adapter_id))) return 'export_pdf.adapter_id must be auto, word, powerpoint or libreoffice.';
  if (args.regenerates_pdf !== undefined && !regeneratedPdfSelector(args.regenerates_pdf)) {
    return 'export_pdf.regenerates_pdf must be an object with exactly one of path or source_ref (a non-empty string) naming the earlier PDF; omit it when no earlier PDF is being regenerated.';
  }
  return undefined;
}

/** The earlier PDF an export regenerates (13.10), as the PDF source selector edit_pdf uses; undefined when malformed. */
export function regeneratedPdfSelector(value: unknown): { path: string } | { source_ref: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1) return undefined;
  const [key, selected] = entries[0];
  if (typeof selected !== 'string' || !selected.trim()) return undefined;
  return key === 'path' ? { path: selected.trim() } : key === 'source_ref' ? { source_ref: selected.trim() } : undefined;
}

/** What export_pdf's receipt says about the PDF it regenerates (13.10): confirmed, or not, and never a grant. */
export interface ExportSourceLineage { regenerates: string; pdf_sha256?: string; state: 'confirmed-source' | 'not-confirmed'; note: string }
export function exportSourceLineage(regenerates: string, check: { pdfSha256: string; confirmed: boolean } | { unreadable: string }): ExportSourceLineage {
  if ('unreadable' in check) {
    return { regenerates, state: 'not-confirmed', note: `The earlier PDF could not be checked (${check.unreadable}). The export still ran; tell the user the source relationship was not confirmed.` };
  }
  return check.confirmed
    ? { regenerates, pdf_sha256: check.pdfSha256, state: 'confirmed-source', note: 'Re-exported from the source document: UnodeAi records confirm this document (now or at an earlier version) is the one that PDF was exported from.' }
    : { regenerates, pdf_sha256: check.pdfSha256, state: 'not-confirmed', note: 'Re-exported from this document, but no UnodeAi record links it to that PDF (for example it was made or changed outside UnodeAi). Tell the user the source relationship was not confirmed.' };
}

/** The destination resolves to the inspected source itself (for example an Office package named .pdf). */
export const EXPORT_PDF_SAME_SOURCE = 'export_pdf.path is the inspected source file itself. Nothing was exported or saved, and the source is unchanged. Choose a different destination path ending in .pdf.';

/** Why an export could not start or be observed, in export_pdf's own terms (never another tool's). */
export function exportPdfFailureHint(error: unknown, operationId?: string): string {
  const code = error instanceof Error ? error.message : '';
  if (operationId) return 'The PDF export operation could not be observed to its end. Nothing is confirmed saved; read the destination before exporting again.';
  if (['snapshot-unavailable', 'render-source-unavailable', 'render-source-changed'].includes(code)) {
    return 'PDF export could not start: the inspected snapshot, source version or current authority is unavailable. Call inspect_office with the authorized source path or source_ref, then copy its returned snapshot_ref exactly into export_pdf.snapshot_ref.';
  }
  if (code === 'cancelled' || (error instanceof Error && error.name === 'AbortError')) return 'PDF export preparation stopped. Nothing was exported or saved.';
  if (['render-script-changed', 'render-command-changed'].includes(code)) return 'PDF export preparation changed before execution. Nothing was exported or saved.';
  return 'PDF export preparation could not finish; the specific cause is not confirmed. Call inspect_office on the source again and use its new snapshot_ref; if that fails too, report the failure instead of repeating the same call.';
}

/** D5: no automatic engine switch. What the model can do next after a failed or not-run export. */
export const EXPORT_PDF_ALTERNATIVES = 'Nothing was saved. Alternatives: call export_pdf again with another installed adapter_id; for a document generated by write_document, regenerate it with its built-in PDF output; or ask the user to open the file in Word and use Save As > PDF.';
