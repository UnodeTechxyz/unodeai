import { parse } from 'node:path';
import { DOCX_MAX_TABLE_COLUMNS, DocumentFailure, DocumentInputFailure, documentPlainText, type CanonicalDocumentRequest, type DocumentBlock,
  type DocumentText } from './DocumentContracts';
import { canonicalDocumentLanguage } from './DocumentLanguage';
import { validateDocumentSourceBindings } from './DocumentDataBinding';
import { canonicalDocumentTextContent } from './DocumentTextContent';
function at<T>(location: string, work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof DocumentFailure) throw new DocumentInputFailure([location, error instanceof DocumentInputFailure ? error.location : ''].filter(Boolean).join('.'),
      error instanceof DocumentInputFailure ? error.issue : 'Use the documented fields and value types at this location.', error.code, error.blockIndex);
    throw error;
  }
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) throw new DocumentInputFailure('', 'Expected an object with the documented fields.');
  const unexpected = Object.keys(value).filter(key => !keys.includes(key));
  if (unexpected.length) throw new DocumentInputFailure('', `Unexpected fields ${unexpected.join(', ')}. Allowed: ${keys.join(', ')}.`);
  return value as Record<string, unknown>;
}
function array(value: unknown, min: number): unknown[] {
  if (!Array.isArray(value) || value.length < min) throw new DocumentInputFailure('', `Expected an array with at least ${min} item(s). Text content in a block uses an array of {text:"..."} runs.`);
  return value;
}

/**
 * Strict canonicalizer, before rendering. It checks structure, XML-safe characters and a file destination; it does
 * not count length (v0.9.99). `part` validates one part of a draft: it may carry no blocks and may begin or end with
 * a page break, because the assembled document is validated again as a whole before it is rendered.
 */
export function validateDocumentRequest(value: unknown, options: { part?: boolean; finalizeTitle?: boolean; canonical?: boolean } = {}): CanonicalDocumentRequest {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { throw new DocumentFailure('invalid-input'); }
  if (!json) throw new DocumentFailure('invalid-input');
  const raw = at('request', () => object(value, ['schema_version', 'path', 'format', 'template', 'document', 'source_bindings']));
  if (raw.schema_version !== 1) throw new DocumentInputFailure('schema_version', 'Use schema_version:1.');
  if (!['docx', 'pdf'].includes(raw.format as string)) throw new DocumentInputFailure('format', 'Use docx or pdf.');
  if (!['contract-v1', 'report-v1'].includes(raw.template as string)) throw new DocumentInputFailure('template', 'Use contract-v1 or report-v1.');
  // Path authority belongs to the shared writer. The renderer also serves deliberate outside grants, so a valid
  // absolute or parent-relative path is not a format error. This never authorizes it or fetches a remote URI.
  if (typeof raw.path !== 'string' || !raw.path.trim() || /[\x00-\x1f]/.test(raw.path)
    || (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.path) && !/^[a-z]:[\\/]/i.test(raw.path))) throw new DocumentInputFailure('path', 'Supply a nonempty file path, not a URL or control characters.');
  if (!raw.path.toLowerCase().endsWith(`.${raw.format}`)) throw new DocumentInputFailure('path', 'The filename extension must match format.', 'extension-mismatch');
  const doc = at('document', () => object(raw.document, ['title', 'subtitle', 'language', 'page', 'header', 'footer', 'blocks']));
  const language = doc.language === undefined ? 'und' : at('document.language', () => canonicalDocumentLanguage(doc.language));
  if (doc.page !== undefined && doc.page !== 'a4' && doc.page !== 'letter') throw new DocumentInputFailure('document.page', 'Use a4 or letter.');
  const text = (value: unknown, multiline = false, inline = false, location = ''): DocumentText => at(location, () => {
    const parts = typeof value === 'string' && !inline ? [{ text: value }] : array(value, 1);
    const result = parts.map(part => {
      const run = object(part, ['text', 'bold', 'language']);
      if (typeof run.text !== 'string') throw new DocumentInputFailure('text', 'Each text run needs a string text field.');
      if (run.bold !== undefined && typeof run.bold !== 'boolean') throw new DocumentInputFailure('bold', 'Use boolean true or false.');
      // Whole-text NFC also changes CJK compatibility ideographs; compose modern Hangul only.
      const content = canonicalDocumentTextContent(run.text, multiline);
      return { text: content, bold: run.bold === true,
        language: run.language === undefined ? language : canonicalDocumentLanguage(run.language) };
    });
    return result;
  });
  const title = doc.title === undefined ? undefined : text(doc.title, false, false, 'document.title');
  if (title && !title.some(run => run.text.trim())) throw new DocumentInputFailure('document.title', 'Supply nonempty title text.');
  const subtitle = doc.subtitle === undefined ? undefined : text(doc.subtitle, false, false, 'document.subtitle');
  const header = doc.header === undefined ? undefined : text(doc.header, false, false, 'document.header');
  const footer = doc.footer === undefined ? undefined : text(doc.footer, false, false, 'document.footer');
  const blocks = at('document.blocks', () => array(doc.blocks, options.part || (options.canonical && title) ? 0 : 1)).map((value, index): DocumentBlock => at(`document.blocks[${index}]`, () => {
    const block = object(value, ['type', 'level', 'content', 'label', 'headers', 'rows', 'parties']);
    const exact = (keys: string[]) => object(value, ['type', ...keys]);
    switch (block.type) {
      case 'heading':
        exact(['level', 'content']);
        if (![1, 2, 3].includes(block.level as number)) throw new DocumentInputFailure('level', 'Use heading level 1, 2 or 3.', 'invalid-input', index);
        return { type: 'heading', level: block.level as 1 | 2 | 3, content: text(block.content, false, true, 'content') };
      case 'paragraph': exact(['content']); return { type: 'paragraph', content: text(block.content, true, true, 'content') };
      case 'clause': exact(['label', 'content']); return { type: 'clause', label: text(block.label, false, false, 'label'), content: text(block.content, true, true, 'content') };
      case 'page-break': exact([]); return { type: 'page-break' };
      case 'table': {
        exact(['headers', 'rows']);
        // Word cannot open a table wider than 63 columns: a real format limit, reported as a layout it cannot hold.
        if (Array.isArray(block.headers) && block.headers.length > DOCX_MAX_TABLE_COLUMNS) throw new DocumentFailure('layout-unrepresentable', index);
        const headers = at('headers', () => array(block.headers, 1)).map((cell, cellIndex) => text(cell, false, false, `headers[${cellIndex}]`));
        const rows = at('rows', () => array(block.rows, 1)).map((value, rowIndex) => at(`rows[${rowIndex}]`, () => {
          const row = array(value, headers.length);
          if (row.length !== headers.length) throw new DocumentInputFailure('', 'Each table row must have exactly as many cells as headers.', 'invalid-input', index);
          return row.map((cell, cellIndex) => text(cell, false, false, `[${cellIndex}]`));
        }));
        return { type: 'table', headers, rows };
      }
      case 'signature': {
        exact(['parties']);
        return { type: 'signature', parties: array(block.parties, 1).map(value => {
          const party = object(value, ['label', 'name']);
          return { label: text(party.label), ...(party.name === undefined ? {} : { name: text(party.name) }) };
        }) };
      }
      default: throw new DocumentInputFailure('type', 'Use heading, paragraph, clause, page-break, table or signature.', 'invalid-input', index);
    }
  }));
  if (!options.part) blocks.forEach((block, index) => {
    if (block.type === 'page-break' && ((index === 0 && !(options.canonical && title)) || index === blocks.length - 1 || blocks[index - 1]?.type === 'page-break')) throw new DocumentInputFailure(`document.blocks[${index}]`, 'A page-break cannot be first, last or consecutive.', 'invalid-input', index);
  });
  const bindings = raw.source_bindings === undefined ? undefined : validateDocumentSourceBindings(raw.source_bindings);
  for (const binding of bindings ?? []) {
    const block = blocks[binding.block_index];
    if (!block || block.type !== 'table' || binding.target.column + binding.data_from.fields.length - 1 > block.headers.length) throw new DocumentFailure('invalid-input', binding.block_index);
  }
  const request: CanonicalDocumentRequest = { schema_version: 1, path: raw.path, format: raw.format as 'docx' | 'pdf', template: raw.template as 'contract-v1' | 'report-v1',
    ...(bindings?.length ? { source_bindings: bindings } : {}),
    document: { ...(title ? { title } : {}), ...(subtitle ? { subtitle } : {}), language, page: doc.page === 'letter' ? 'letter' : 'a4',
      ...(header ? { header } : {}), ...(footer ? { footer } : {}), blocks } };
  return options.finalizeTitle && !options.part ? finalizeDocumentTitle(request) : request;
}

/** Once, at render admission after draft assembly; never while capturing an individual draft part. */
function finalizeDocumentTitle(request: CanonicalDocumentRequest): CanonicalDocumentRequest {
  const first = request.document.blocks[0];
  if (first?.type !== 'heading' || first.level !== 1) return request;
  const plain = (value: DocumentText) => documentPlainText(value).trim().replace(/\s+/g, ' ');
  const title = request.document.title;
  if (!title && !plain(first.content)) return request;
  if (title && plain(title) !== plain(first.content)) return request;
  return { ...request,
    ...(request.source_bindings ? { source_bindings: request.source_bindings.map(binding => ({ ...binding, block_index: binding.block_index - 1 })) } : {}),
    document: { ...request.document, title: title ?? first.content, blocks: request.document.blocks.slice(1) } };
}

/** Metadata only: an omitted visible title never creates a filename paragraph. */
export function documentMetadataTitle(request: { document: CanonicalDocumentRequest['document']; path?: string }): string {
  return request.document.title ? documentPlainText(request.document.title)
    : canonicalDocumentTextContent(parse(request.path ?? 'document').name, false);
}
