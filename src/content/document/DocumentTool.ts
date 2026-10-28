import { PDF_FALLBACK_GUIDANCE } from './PdfFallback';
/** Shared model schema; no renderer/library imports on the host or CLI path. */
const run = { type: 'object', additionalProperties: false, properties: {
  text: { type: 'string' }, bold: { type: 'boolean' }, language: { type: 'string' },
}, required: ['text'] };
// v0.9.99: no advertised length or count maxima. Word's 63-column table limit is the one real structural maximum.
const inline = { type: 'array', minItems: 1, items: run };
const text = { anyOf: [{ type: 'string' }, inline] };
const block = (type: string, properties: object, required: string[]) => ({ type: 'object', additionalProperties: false,
  properties: { type: { type: 'string', enum: [type] }, ...properties }, required: ['type', ...required] });

export const WRITE_DOCUMENT_TOOL = 'write_document';
/** v0.9.99: how a model builds a long document without putting all of it in one tool argument. */
export const WRITE_DOCUMENT_DRAFT_GUIDANCE = 'There is no length limit. For a long document, send it in parts: '
  + 'give every call the same draft name; a call without final: true only adds its blocks to that draft (nothing is '
  + 'written); the call with final: true adds its blocks (may be none) and writes ONE file from all parts in order, '
  + 'using that call\'s path, format, template, title, header and footer.';
export const WRITE_DOCUMENT_DESCRIPTION = 'Write a local DOCX or PDF from structured text using contract-v1 or report-v1. '
  + 'Uses the same write permission, destination checks, approval and restore points as other file writes. '
  + WRITE_DOCUMENT_DRAFT_GUIDANCE + ' '
  + 'No HTML, base64, macros, external assets or font paths. DOCX preserves valid Unicode; its receipt may warn that '
  + 'reader layout is unverified. PDF generation currently requires Windows system fonts. ' + PDF_FALLBACK_GUIDANCE + ' '
  + 'PDF supports en, zh-Hans, zh-Hant, ja, ko, es and fr, plus common LTR symbols and Greek/Cyrillic letters; missing fonts or unsupported '
  + 'layout return an explicit failure, never a silent format change. Report only the host receipt as saved; saving is '
  + 'not a reader-layout check. For cancellation wait for a new user request; '
  + 'for render-stop-unconfirmed the previous worker stop was not confirmed: no document was committed; the next request uses a fresh worker. Otherwise correct the stated input/font/target issue. '
  + 'effect-uncertain requires inspecting the destination before retrying.';
export const WRITE_DOCUMENT_PARAMETERS = { type: 'object', additionalProperties: false, properties: {
  schema_version: { type: 'integer', enum: [1] },
  path: { type: 'string', description: 'Relative output path ending in .docx or .pdf, matching format.' },
  format: { type: 'string', enum: ['docx', 'pdf'] }, template: { type: 'string', enum: ['contract-v1', 'report-v1'] },
  draft: { type: 'string', description: 'Optional draft name for building a long document in several calls.' },
  final: { type: 'boolean', description: 'With draft: true writes the file from every part of the draft.' },
  document: { type: 'object', additionalProperties: false, properties: {
    title: text, subtitle: text, language: { type: 'string', description: 'Document language, e.g. en or zh-Hant; override on mixed-language runs.' },
    page: { type: 'string', enum: ['a4', 'letter'] }, header: text, footer: text,
    blocks: { type: 'array', items: { anyOf: [
      block('heading', { level: { type: 'integer', enum: [1, 2, 3] }, content: inline }, ['level', 'content']),
      block('paragraph', { content: inline }, ['content']),
      block('clause', { label: text, content: inline }, ['label', 'content']),
      block('table', { headers: { type: 'array', minItems: 1, maxItems: 63, items: text },
        rows: { type: 'array', minItems: 1, items: { type: 'array', minItems: 1, maxItems: 63, items: text } } }, ['headers', 'rows']),
      block('page-break', {}, []),
      block('signature', { parties: { type: 'array', minItems: 1, items: {
        type: 'object', additionalProperties: false, properties: { label: text, name: text }, required: ['label'],
      } } }, ['parties']),
    ] } },
  }, required: ['title', 'blocks'] },
}, required: ['schema_version', 'path', 'format', 'template', 'document'] };
export const WRITE_DOCUMENT_SPEC = { type: 'function' as const, function: {
  name: WRITE_DOCUMENT_TOOL, description: WRITE_DOCUMENT_DESCRIPTION, parameters: WRITE_DOCUMENT_PARAMETERS,
} };
export const DOCUMENT_AUTHORING_GUIDANCE = 'For a requested Word/PDF deliverable use write_document when offered, '
  + 'not Markdown renamed as .docx/.pdf. Preserve requested language and content; for a long document use its draft '
  + 'parts rather than shortening or splitting the deliverable into several files. Only its host receipt establishes '
  + 'a saved file; quote the returned relative path and retain any reader-layout-unverified warning in your handoff '
  + 'and summaries. A saved document is not proof that Word/PDF reader layout was checked. Do not claim a DOCX page count. '
  + PDF_FALLBACK_GUIDANCE;

/** v0.9.99: the draft fields of a write_document call, read from model arguments only as a name and a flag. */
export interface DocumentDraftCall { name: string; final: boolean }

/** `undefined` is the one-call form; `'invalid'` is a draft field of the wrong shape. */
export function documentDraftCall(args: unknown): DocumentDraftCall | undefined | 'invalid' {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const { draft, final } = args as Record<string, unknown>;
  if (final !== undefined && typeof final !== 'boolean') return 'invalid';
  if (draft === undefined) return undefined;
  if (typeof draft !== 'string' || !draft.trim() || draft.length > 200 || /[\x00-\x1f\x7f]/.test(draft)) return 'invalid';
  return { name: draft, final: final === true };
}

/** A draft part adds blocks on this machine only: no file is written, so it is not an effect of the request. */
export function isDocumentDraftPart(args: unknown): boolean {
  const call = documentDraftCall(args);
  return typeof call === 'object' && !call.final;
}

/** The document request itself, without the draft fields, for the strict canonical validator. */
export function documentRequestFields(args: Record<string, unknown>): Record<string, unknown> {
  const { draft: _draft, final: _final, ...request } = args;
  return request;
}
