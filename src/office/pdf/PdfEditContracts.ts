/** edit_pdf: typed page, form and overlay operations on a user's PDF. Pure data contracts; no paths are opened here. */
export const EDIT_PDF_TOOL = 'edit_pdf';

export const PDF_EDIT_CODES = [
  'invalid-pdf-edits', 'pdf-destination-is-input', 'destination-extension-mismatch',
  'pdf-encrypted', 'pdf-signed', 'pdf-xfa-unsupported', 'pdf-invalid', 'invalid-pages', 'form-field-mismatch',
  'pdf-form-merge-unsupported', 'pdf-form-flatten-failed', 'font-unavailable', 'unsupported-glyph', 'text-not-found', 'image-unavailable', 'unsupported-image', 'signature-confirmation-stale',
  'pdf-output-check-failed', 'source-changed', 'source-unreadable', 'source-unavailable', 'cancelled',
  'out-of-memory', 'worker-unavailable', 'pdf-edit-failed',
] as const;
export type PdfEditCode = typeof PDF_EDIT_CODES[number];
const known = new Set<string>(PDF_EDIT_CODES);
export const isPdfEditCode = (value: unknown): value is PdfEditCode => typeof value === 'string' && known.has(value);
export class PdfEditFailure extends Error {
  constructor(code: PdfEditCode, public readonly inputIssue?: { location: string; issue: string }) { super(code); }
}

export type PdfSourceSelector = { path: string } | { source_ref: string };
export type PageNumberPosition = 'bottom-center' | 'bottom-left' | 'bottom-right' | 'top-center' | 'top-left' | 'top-right';
export type PdfEditOperation =
  | { op: 'merge' }
  | { op: 'extract_pages'; pages: string }
  | { op: 'delete_pages'; pages: string }
  | { op: 'rotate_pages'; pages: string; degrees: 90 | 180 | 270 }
  | { op: 'reorder_pages'; order: number[] }
  | { op: 'replace_pages'; pages: string; from: PdfSourceSelector & { pages?: string } }
  | { op: 'add_watermark'; text: string; opacity: number; angle: number; size: number; color: string; pages?: string }
  | { op: 'add_page_numbers'; format: string; position: PageNumberPosition; start: number; size: number; pages?: string }
  | { op: 'fill_form'; fields: Record<string, string | boolean | string[]>; flatten: boolean }
  | { op: 'add_text'; page: number; x: number; y: number; text: string; size: number; color: string }
  | { op: 'add_image'; page: number; rect: PdfRect; asset_ref: string }
  | { op: 'add_note'; page: number; x: number; y: number; text: string }
  | { op: 'add_highlight'; page: number; find?: string; occurrence: number; rect?: PdfRect; color: string }
  /** Always placed last (13.13); `page` is a page of the final document. Each placement is confirmed by the user. */
  | { op: 'place_signature'; page: number; rect: PdfRect };
/** Visible page rectangle (13.12): [x, y, width, height] in points from the visible top-left corner. */
export type PdfRect = [number, number, number, number];
export interface PdfEditRequest {
  schema_version: 1; destination: string; inputs: PdfSourceSelector[]; operations: PdfEditOperation[];
  flatten_forms_before_merge: boolean;
}

export const PDF_EDIT_LIMITS = Object.freeze({ inputs: 20, operations: 100, text: 500, fields: 500, order: 10000 });
const POSITIONS: readonly PageNumberPosition[] = ['bottom-center', 'bottom-left', 'bottom-right', 'top-center', 'top-left', 'top-right'];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const PAGES = /^\s*[1-9]\d*(?:\s*-\s*[1-9]\d*)?(?:\s*,\s*[1-9]\d*(?:\s*-\s*[1-9]\d*)?)*\s*$/;

/** "1-3,5" in the order written. Ranges must ascend; bounds are checked against the working document. */
export function parsePageList(value: string): number[] {
  if (!PAGES.test(value)) throw new PdfEditFailure('invalid-pages');
  const pages: number[] = [];
  for (const part of value.split(',')) {
    const [first, last = first] = part.split('-').map(text => Number(text.trim()));
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first || last - first > PDF_EDIT_LIMITS.order) throw new PdfEditFailure('invalid-pages');
    for (let page = first; page <= last; page++) pages.push(page);
  }
  return pages;
}

function selector(value: unknown, location: string, invalid: (location: string, issue: string) => never, extra: string[] = []): PdfSourceSelector {
  if (!object(value) || Object.keys(value).some(key => !['path', 'source_ref', ...extra].includes(key))) return invalid(location, `Use exactly one of path or source_ref${extra.length ? ' and optional ' + extra.join(', ') : ''}.`);
  const hasPath = typeof value.path === 'string' && !!value.path.trim(); const hasRef = typeof value.source_ref === 'string' && !!value.source_ref.trim();
  if (hasPath === hasRef || (value.path !== undefined && !hasPath) || (value.source_ref !== undefined && !hasRef)) return invalid(location, 'Use exactly one nonempty path or source_ref.');
  return hasPath ? { path: value.path as string } : { source_ref: value.source_ref as string };
}

export function validatePdfEditRequest(value: unknown): PdfEditRequest {
  const invalid = (location: string, issue: string): never => { throw new PdfEditFailure('invalid-pdf-edits', { location, issue }); };
  if (!object(value)) return invalid('request', 'Use an object with schema_version, destination, inputs and operations.');
  const allowed = ['schema_version', 'destination', 'inputs', 'operations', 'flatten_forms_before_merge'];
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) return invalid('request', `Remove ${extra.join(', ')}. Allowed fields: ${allowed.join(', ')}.`);
  if (value.schema_version !== 1) return invalid('schema_version', 'Use 1.');
  if (typeof value.destination !== 'string' || !value.destination.trim()) return invalid('destination', 'Use a nonempty authorized .pdf destination path.');
  if (!/\.pdf$/i.test(value.destination.trim())) throw new PdfEditFailure('destination-extension-mismatch');
  if (!Array.isArray(value.inputs) || !value.inputs.length || value.inputs.length > PDF_EDIT_LIMITS.inputs) return invalid('inputs', `Use 1 to ${PDF_EDIT_LIMITS.inputs} sources.`);
  const inputs = value.inputs.map((input, index) => selector(input, `inputs[${index}]`, invalid));
  if (value.flatten_forms_before_merge !== undefined && typeof value.flatten_forms_before_merge !== 'boolean') return invalid('flatten_forms_before_merge', 'Use true or false.');
  if (!Array.isArray(value.operations) || !value.operations.length || value.operations.length > PDF_EDIT_LIMITS.operations) return invalid('operations', `Use 1 to ${PDF_EDIT_LIMITS.operations} operations.`);
  const operations = value.operations.map((raw, index): PdfEditOperation => {
    const at = `operations[${index}]`;
    if (!object(raw) || typeof raw.op !== 'string') return invalid(at, 'Each operation needs an op.');
    const only = (fields: string[]) => {
      const unknown = Object.keys(raw).filter(key => key !== 'op' && !fields.includes(key));
      if (unknown.length) invalid(at, `Remove ${unknown.join(', ')} from ${raw.op}. Allowed: ${fields.join(', ') || 'none'}.`);
    };
    const pages = (key: string, required: boolean): string | undefined => {
      if (raw[key] === undefined && !required) return undefined;
      if (typeof raw[key] !== 'string' || !PAGES.test(raw[key] as string)) return invalid(`${at}.${key}`, 'Use 1-based page numbers and ascending ranges, e.g. "1-3,5".');
      return (raw[key] as string).replace(/\s+/g, '');
    };
    const text = (key: string): string => {
      if (typeof raw[key] !== 'string' || !(raw[key] as string).trim() || (raw[key] as string).length > PDF_EDIT_LIMITS.text || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(raw[key] as string)) {
        return invalid(`${at}.${key}`, `Use nonempty text up to ${PDF_EDIT_LIMITS.text} characters without control characters.`);
      }
      return (raw[key] as string).normalize('NFC');
    };
    const number = (key: string, fallback: number, min: number, max: number): number => {
      if (raw[key] === undefined) return fallback;
      if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || (raw[key] as number) < min || (raw[key] as number) > max) return invalid(`${at}.${key}`, `Use a number from ${min} to ${max}.`);
      return raw[key] as number;
    };
    const page = (): number => {
      if (!Number.isSafeInteger(raw.page) || (raw.page as number) < 1) return invalid(`${at}.page`, 'Use one 1-based page number of the working document.');
      return raw.page as number;
    };
    const rect = (key: string): PdfRect | undefined => {
      const value = raw[key];
      if (!Array.isArray(value) || value.length !== 4 || value.some(item => typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1e6) || value[2] <= 0 || value[3] <= 0) {
        return invalid(`${at}.${key}`, 'Use [x, y, width, height] in points from the visible top-left corner of the page; width and height above 0.');
      }
      return [...value] as PdfRect;
    };
    const multiline = (key: string): string => {
      if (typeof raw[key] !== 'string' || !(raw[key] as string).trim() || (raw[key] as string).length > 5000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw[key] as string)) {
        return invalid(`${at}.${key}`, 'Use nonempty text up to 5000 characters; line breaks are allowed.');
      }
      return (raw[key] as string).replace(/\r\n?/g, '\n').normalize('NFC');
    };
    const color = (fallback: string): string => {
      if (raw.color === undefined) return fallback;
      if (typeof raw.color !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test(raw.color)) return invalid(`${at}.color`, 'Use six hex RGB digits, e.g. "808080".');
      return raw.color.replace('#', '').toLowerCase();
    };
    switch (raw.op) {
      case 'merge':
        only([]);
        if (index !== 0) return invalid(at, 'merge must be the first operation; the inputs order is the merge order.');
        if (inputs.length < 2) return invalid(at, 'merge needs at least two inputs.');
        return { op: 'merge' };
      case 'extract_pages': only(['pages']); return { op: 'extract_pages', pages: pages('pages', true)! };
      case 'delete_pages': only(['pages']); return { op: 'delete_pages', pages: pages('pages', true)! };
      case 'rotate_pages':
        only(['pages', 'degrees']);
        if (![90, 180, 270].includes(raw.degrees as number)) return invalid(`${at}.degrees`, 'Use 90, 180 or 270 (clockwise).');
        return { op: 'rotate_pages', pages: pages('pages', true)!, degrees: raw.degrees as 90 | 180 | 270 };
      case 'reorder_pages':
        only(['order']);
        if (!Array.isArray(raw.order) || !raw.order.length || raw.order.length > PDF_EDIT_LIMITS.order
          || raw.order.some(page => !Number.isSafeInteger(page) || page < 1)) return invalid(`${at}.order`, 'Use every current page number exactly once, e.g. [3,1,2].');
        return { op: 'reorder_pages', order: [...raw.order as number[]] };
      case 'replace_pages': {
        only(['pages', 'from']);
        const from = selector(raw.from, `${at}.from`, invalid, ['pages']);
        const range = pages('pages', true)!;
        if (!/^\d+(?:-\d+)?$/.test(range)) return invalid(`${at}.pages`, 'Use one contiguous range of the working document, e.g. "1-12".');
        const selected = (raw.from as Record<string, unknown>).pages;
        if (selected !== undefined && (typeof selected !== 'string' || !PAGES.test(selected))) return invalid(`${at}.from.pages`, 'Use 1-based page numbers and ascending ranges, e.g. "1-12".');
        return { op: 'replace_pages', pages: range, from: { ...from, ...(typeof selected === 'string' ? { pages: selected.replace(/\s+/g, '') } : {}) } };
      }
      case 'add_watermark':
        only(['text', 'opacity', 'angle', 'size', 'color', 'pages']);
        return { op: 'add_watermark', text: text('text'), opacity: number('opacity', 0.2, 0.01, 1), angle: number('angle', 45, -360, 360),
          size: number('size', 48, 4, 400), color: color('808080'), ...(raw.pages !== undefined ? { pages: pages('pages', false)! } : {}) };
      case 'add_page_numbers': {
        only(['format', 'position', 'start', 'size', 'pages']);
        const format = raw.format === undefined ? '{n}/{total}' : text('format');
        if (!format.includes('{n}') || /\{(?!n\}|total\})/.test(format)) return invalid(`${at}.format`, 'Include {n}; {total} is optional. No other braces.');
        if (raw.position !== undefined && !POSITIONS.includes(raw.position as PageNumberPosition)) return invalid(`${at}.position`, `Use one of ${POSITIONS.join(', ')}.`);
        if (raw.start !== undefined && (!Number.isSafeInteger(raw.start) || (raw.start as number) < 0 || (raw.start as number) > 1e6)) return invalid(`${at}.start`, 'Use a whole number from 0.');
        return { op: 'add_page_numbers', format, position: (raw.position ?? 'bottom-center') as PageNumberPosition, start: (raw.start ?? 1) as number,
          size: number('size', 10, 4, 72), ...(raw.pages !== undefined ? { pages: pages('pages', false)! } : {}) };
      }
      case 'fill_form': {
        only(['fields', 'flatten']);
        if (!object(raw.fields) || !Object.keys(raw.fields).length || Object.keys(raw.fields).length > PDF_EDIT_LIMITS.fields) return invalid(`${at}.fields`, 'Use an object of field name to value.');
        for (const [name, field] of Object.entries(raw.fields)) {
          const ok = typeof field === 'boolean' || (typeof field === 'string' && field.length <= 10000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(field))
            || (Array.isArray(field) && field.length <= 1000 && field.every(item => typeof item === 'string' && item.length <= 10000));
          if (!name || !ok) return invalid(`${at}.fields.${name}`, 'Use a string for text, choice or radio fields, true/false for a check box, or a string array for a multi-select list.');
        }
        if (typeof raw.flatten !== 'boolean') return invalid(`${at}.flatten`, 'Choose flatten true (fields become fixed page content) or false (fields stay editable).');
        const fields = Object.fromEntries(Object.entries(raw.fields).map(([name, field]) => [name, typeof field === 'string' ? field.normalize('NFC') : Array.isArray(field) ? field.map(item => (item as string).normalize('NFC')) : field])) as Record<string, string | boolean | string[]>;
        return { op: 'fill_form', fields, flatten: raw.flatten };
      }
      case 'add_text':
        only(['page', 'x', 'y', 'text', 'size', 'color']);
        return { op: 'add_text', page: page(), x: number('x', NaN, 0, 1e6), y: number('y', NaN, 0, 1e6), text: multiline('text'), size: number('size', 12, 2, 400), color: color('000000') };
      case 'add_image':
        only(['page', 'rect', 'asset_ref']);
        if (typeof raw.asset_ref !== 'string' || !/^content-[1-9]\d*$/.test(raw.asset_ref)) return invalid(`${at}.asset_ref`, 'Use a PNG or JPEG asset_ref (content-N) supplied to this request.');
        return { op: 'add_image', page: page(), rect: rect('rect')!, asset_ref: raw.asset_ref };
      case 'add_note':
        only(['page', 'x', 'y', 'text']);
        return { op: 'add_note', page: page(), x: number('x', NaN, 0, 1e6), y: number('y', NaN, 0, 1e6), text: multiline('text') };
      case 'add_highlight': {
        only(['page', 'find', 'occurrence', 'rect', 'color']);
        if ((raw.find === undefined) === (raw.rect === undefined)) return invalid(at, 'Use exactly one of find (literal text on that page) or rect.');
        if (raw.occurrence !== undefined && (!Number.isSafeInteger(raw.occurrence) || (raw.occurrence as number) < 1)) return invalid(`${at}.occurrence`, 'Use 1 for the first match, 2 for the second, and so on.');
        return { op: 'add_highlight', page: page(), ...(raw.find !== undefined ? { find: text('find') } : { rect: rect('rect')! }), occurrence: (raw.occurrence ?? 1) as number, color: color('ffff00') };
      }
      case 'place_signature':
        only(['page', 'rect']);
        return { op: 'place_signature', page: page(), rect: rect('rect')! };
      default:
        return invalid(`${at}.op`, 'Use merge, extract_pages, delete_pages, rotate_pages, reorder_pages, replace_pages, add_watermark, add_page_numbers, fill_form, add_text, add_image, add_note, add_highlight or place_signature.');
    }
  });
  if (inputs.length > 1 && operations[0].op !== 'merge') return invalid('operations[0]', 'Several inputs are combined only by a first merge operation.');
  return { schema_version: 1, destination: value.destination.trim(), inputs, operations, flatten_forms_before_merge: value.flatten_forms_before_merge === true };
}

/** Facts the worker reports and the host re-validates before any byte is committed. */
export interface PdfEditOperationFact { op: PdfEditOperation['op']; pages: number[]; result: 'applied'; detail?: string }
/** `rotated`: clockwise degrees this page turned relative to its source page. */
export interface PdfPageOrigin { source: number; page: number; rotated: number }
/** An output page's identity: object reference, content-stream hash and visible size (13.13 page identity). */
export interface PdfPageIdentity { ref: string; content_sha256: string; width: number; height: number; rotation: number }
export interface PdfEditFacts {
  sha256: string; pages: number; sources: Array<{ sha256: string; pages: number }>;
  operations: PdfEditOperationFact[];
  /** Per output page: which source page it came from (source index into inputs + replace_pages sources). */
  page_map: PdfPageOrigin[];
  removed: { fields: string[]; widgets: number; outline_items: string[]; outline_destinations: string[]; links: number };
  dropped: string[];
  forms: { fields: Array<{ name: string; type: string }>; filled: string[]; flattened: boolean; flattened_inputs: number[] };
  fonts: Array<{ language: string; family: string; sha256: string }>;
  checks: { page_boxes: number; text_fingerprints: number; overlay_pages: number; field_values: number; annotations: number; images: number };
  /** `page`: where the operation put it; `output_page`: where it is in the output, absent when a later operation removed its page. */
  annotations: Array<{ op: 'add_note' | 'add_highlight'; page: number; subtype: 'Text' | 'Highlight'; quads: number; granularity?: 'text-item' | 'rect'; output_page?: number }>;
  images: Array<{ page: number; sha256: string; rect: PdfRect; output_page?: number }>;
  signatures: Array<{ page: number; rect: PdfRect; sha256: string }>;
  page_identity: PdfPageIdentity[];
  /** The first characters of each output page's text: shown only in the local signature confirmation, never to a model. */
  page_text_head: string[];
}
export interface PdfEditResult extends PdfEditFacts { bytes: Uint8Array }
