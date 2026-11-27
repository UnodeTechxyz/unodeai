import { EDIT_PDF_TOOL } from './PdfEditContracts';

const source = { type: 'object', additionalProperties: false, properties: {
  path: { type: 'string', description: 'An authorized PDF file path.' },
  source_ref: { type: 'string', description: 'A PDF attachment source_ref (content-N) supplied to this request.' },
} };
const pages = (purpose: string) => ({ type: 'string', description: `${purpose} 1-based page numbers of the current working document, e.g. "1-3,5".` });

export const EDIT_PDF_SPEC = { type: 'function' as const, function: {
  name: EDIT_PDF_TOOL,
  description: 'Page operations and form filling on existing PDFs, written to a new .pdf (never over an input). Requires current Read access to every input and Write access to the destination. '
    + 'Operations run in order on one working document. With several inputs the first operation must be merge (inputs order = merge order). Page numbers always refer to the working document as it is when that operation runs. '
    + 'merge, extract_pages and replace_pages copy pages into a new document: bookmarks, named destinations, page labels, structure tags and attachments are not carried over, and the result says so. '
    + 'A copied input with form fields is refused (pdf-form-merge-unsupported) unless flatten_forms_before_merge is true; then its fields become fixed page content first. '
    + 'rotate_pages, delete_pages, reorder_pages, add_watermark, add_page_numbers and fill_form change the document in place and keep its form fields, bookmarks and links; delete_pages removes only the widgets, bookmarks and links that point at the deleted pages and reports them. '
    + 'replace_pages swaps one contiguous range for pages from another PDF (for example a re-exported contract) and keeps the other pages; watermarks, numbers or notes on the replaced pages go with them, so repeat those operations for the new pages in the same request. '
    + 'fill_form sets fields by exact name: a string for text, choice or radio fields, true/false for a check box, a string array for a multi-select list; flatten true makes fields fixed content, false keeps them editable. '
    + 'Overlays and annotations (in place): add_text writes text whose top-left is x, y; add_image fits a PNG/JPEG asset_ref inside rect keeping its aspect; add_note adds a sticky-note annotation at x, y; '
    + 'add_highlight adds a Highlight annotation over the literal find text on that page (occurrence picks the n-th match, default 1) or over rect. Highlight boxes cover whole PDF text items, so they can be wider than the match; the result says so. '
    + 'place_signature puts the user’s saved visible signature (no certificate) in rect on page; you never see the image. Every place_signature runs after all other operations and its page is a page of the final document. The user confirms each placement; a declined one is reported as signature-declined and the rest of the request still completes. Without a saved signature the placement reports signature-unavailable with where the user adds one. '
    + 'All positions are points measured from the top-left corner of the page as it is displayed (after its rotation and crop box); a rect is [x, y, width, height] and must lie on the page. '
    + 'Overlay text uses an installed embeddable font for its script; if none is available the call fails with font-unavailable and names the language. '
    + 'Refused: encrypted PDFs (pdf-encrypted), PDFs with an existing digital signature (pdf-signed, any edit would invalidate it), XFA forms (pdf-xfa-unsupported). '
    + 'Not supported: redaction, editing body text in the content stream, covering old text with a white box. To change body text, edit the source DOCX and export it again with export_pdf (regenerates_pdf names this PDF), then use replace_pages; without the source DOCX, convert_pdf_to_docx (if offered) makes an editable .docx with Word. '
    + 'The output is reopened and checked: page count, page sizes and rotation, the text of every copied page, added overlay text, field names and filled values.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    schema_version: { type: 'integer', enum: [1] },
    destination: { type: 'string', description: 'Authorized destination .pdf path; must differ from every input.' },
    inputs: { type: 'array', minItems: 1, maxItems: 20, items: source, description: 'One PDF, or several merged by a first merge operation.' },
    flatten_forms_before_merge: { type: 'boolean', description: 'Only when the user agreed: flatten form fields of inputs copied by merge, extract_pages or replace_pages. Default false.' },
    operations: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, properties: {
      op: { type: 'string', enum: ['merge', 'extract_pages', 'delete_pages', 'rotate_pages', 'reorder_pages', 'replace_pages', 'add_watermark', 'add_page_numbers', 'fill_form', 'add_text', 'add_image', 'add_note', 'add_highlight', 'place_signature'] },
      page: { type: 'integer', minimum: 1, description: 'add_text/add_image/add_note/add_highlight: one page of the working document; place_signature: a page of the final document.' },
      x: { type: 'number', minimum: 0, description: 'add_text/add_note: points from the visible left edge.' },
      y: { type: 'number', minimum: 0, description: 'add_text/add_note: points from the visible top edge.' },
      rect: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 4, maxItems: 4, description: 'add_image/add_highlight/place_signature: [x, y, width, height] in visible points.' },
      asset_ref: { type: 'string', description: 'add_image: a PNG or JPEG content-N asset supplied to this request.' },
      find: { type: 'string', description: 'add_highlight: literal text on that page to highlight.' },
      occurrence: { type: 'integer', minimum: 1, description: 'add_highlight: which match of find, default 1.' },
      pages: pages('Pages to act on. For replace_pages one contiguous range, e.g. "1-12". Optional for add_watermark/add_page_numbers (default all).'),
      degrees: { type: 'integer', enum: [90, 180, 270], description: 'rotate_pages: clockwise.' },
      order: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'reorder_pages: every current page number exactly once, e.g. [3,1,2].' },
      from: { type: 'object', additionalProperties: false, properties: { ...source.properties, pages: pages('Optional pages of this PDF to insert.') },
        description: 'replace_pages: the PDF supplying the new pages.' },
      text: { type: 'string', description: 'add_watermark/add_text/add_note: the text; add_text and add_note accept line breaks.' },
      opacity: { type: 'number', minimum: 0.01, maximum: 1, description: 'add_watermark: default 0.2.' },
      angle: { type: 'number', description: 'add_watermark: counter-clockwise degrees as seen on the page; default 45.' },
      size: { type: 'number', description: 'Font size in points: watermark default 48, page numbers default 10, add_text default 12.' },
      color: { type: 'string', description: 'Six hex RGB digits: watermark default 808080, text default 000000, highlight default ffff00.' },
      format: { type: 'string', description: 'add_page_numbers: with {n} and optional {total}; default "{n}/{total}".' },
      position: { type: 'string', enum: ['bottom-center', 'bottom-left', 'bottom-right', 'top-center', 'top-left', 'top-right'], description: 'add_page_numbers: default bottom-center, 24 pt from the visible edge.' },
      start: { type: 'integer', minimum: 0, description: 'add_page_numbers: number shown on the first numbered page; default 1.' },
      fields: { type: 'object', additionalProperties: { anyOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'array', items: { type: 'string' } }] }, description: 'fill_form: field name to value.' },
      flatten: { type: 'boolean', description: 'fill_form: required choice, true = fixed content, false = still editable.' },
    }, required: ['op'] } },
  }, required: ['schema_version', 'destination', 'inputs', 'operations'] },
} };
