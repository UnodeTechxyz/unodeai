export const VIEW_PDF_PAGES_TOOL = 'view_pdf_pages';
export const VIEW_PDF_PAGES_MAX = 10;
export const VIEW_PDF_PAGES_SPEC = { type: 'function' as const, function: {
  name: VIEW_PDF_PAGES_TOOL,
  description: 'Render up to 10 pages of a user PDF to page images. Requires current Read access to the PDF and Commands: on Windows it runs the fixed Windows.Data.Pdf page renderer as one ordinary command decision; '
    + 'on other platforms it returns state not-run with reason platform-unsupported (not verified on macOS/Linux) and read_file still reads the text. '
    + 'The result lists one image asset_id per page; call view_office_images with those asset_ids to see them (images reach only a connection that accepts images). '
    + 'Signatures that UnodeAi placed are hidden (white box) in these images; a file made through a PDF-to-Word conversion of a PDF UnodeAi signed returns not-run (derived-from-signed) instead of images. For text, prefer read_file.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    path: { type: 'string', description: 'An authorized PDF file path.' },
    source_ref: { type: 'string', description: 'A PDF attachment source_ref (content-N) supplied to this request.' },
    pages: { type: 'string', description: '1-based pages, e.g. "1-3,5"; at most 10 pages.' },
  }, required: ['pages'] },
} };
