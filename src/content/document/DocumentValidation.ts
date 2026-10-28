import { DOCX_MAX_TABLE_COLUMNS, DocumentFailure, type CanonicalDocumentRequest, type DocumentBlock,
  type DocumentText } from './DocumentContracts';
import { canonicalDocumentLanguage } from './DocumentLanguage';

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !keys.includes(key))) throw new DocumentFailure('invalid-input');
  return value as Record<string, unknown>;
}
function array(value: unknown, min: number): unknown[] {
  if (!Array.isArray(value) || value.length < min) throw new DocumentFailure('invalid-input');
  return value;
}

/**
 * Strict canonicalizer, before rendering. It checks structure, XML-safe characters and the relative path; it does
 * not count length (v0.9.99). `part` validates one part of a draft: it may carry no blocks and may begin or end with
 * a page break, because the assembled document is validated again as a whole before it is rendered.
 */
export function validateDocumentRequest(value: unknown, options: { part?: boolean } = {}): CanonicalDocumentRequest {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { throw new DocumentFailure('invalid-input'); }
  if (!json) throw new DocumentFailure('invalid-input');
  const raw = object(value, ['schema_version', 'path', 'format', 'template', 'document']);
  if (raw.schema_version !== 1 || !['docx', 'pdf'].includes(raw.format as string)
    || !['contract-v1', 'report-v1'].includes(raw.template as string)) throw new DocumentFailure('invalid-input');
  if (typeof raw.path !== 'string' || raw.path.length < 1 || raw.path.length > 1024
    || /[\\:\x00-\x1f]/.test(raw.path) || raw.path.split('/').some(part => !part || part === '.' || part === '..')) throw new DocumentFailure('invalid-input');
  if (!raw.path.toLowerCase().endsWith(`.${raw.format}`)) throw new DocumentFailure('extension-mismatch');
  const doc = object(raw.document, ['title', 'subtitle', 'language', 'page', 'header', 'footer', 'blocks']);
  const language = doc.language === undefined ? 'und' : canonicalDocumentLanguage(doc.language);
  if (doc.page !== undefined && doc.page !== 'a4' && doc.page !== 'letter') throw new DocumentFailure('invalid-input');
  const text = (value: unknown, multiline = false, inline = false): DocumentText => {
    const parts = typeof value === 'string' && !inline ? [{ text: value }] : array(value, 1);
    const result = parts.map(part => {
      const run = object(part, ['text', 'bold', 'language']);
      if (typeof run.text !== 'string' || (run.bold !== undefined && typeof run.bold !== 'boolean')) throw new DocumentFailure('invalid-input');
      // Whole-text NFC also changes CJK compatibility ideographs; compose modern Hangul only.
      const content = run.text.replace(/\r\n/g, '\n')
        .replace(/[\u1100-\u1112][\u1161-\u1175][\u11a8-\u11c2]?(?![\u11a8-\u11ff\ud7cb-\ud7fb])/g, syllable => syllable.normalize('NFC'));
      for (const char of content) {
        const point = char.codePointAt(0)!;
        if (!(point === 0xA && multiline) && !(point >= 0x20 && point <= 0xD7FF)
          && !(point >= 0xE000 && point <= 0xFFFD) && !(point >= 0x10000 && point <= 0x10FFFF)) throw new DocumentFailure('invalid-input');
      }
      return { text: content, bold: run.bold === true,
        language: run.language === undefined ? language : canonicalDocumentLanguage(run.language) };
    });
    return result;
  };
  const title = text(doc.title);
  if (!title.some(run => run.text.trim())) throw new DocumentFailure('invalid-input');
  const subtitle = doc.subtitle === undefined ? undefined : text(doc.subtitle);
  const header = doc.header === undefined ? undefined : text(doc.header);
  const footer = doc.footer === undefined ? undefined : text(doc.footer);
  const blocks = array(doc.blocks, options.part ? 0 : 1).map((value, index): DocumentBlock => {
    const block = object(value, ['type', 'level', 'content', 'label', 'headers', 'rows', 'parties']);
    const exact = (keys: string[]) => object(value, ['type', ...keys]);
    switch (block.type) {
      case 'heading':
        exact(['level', 'content']);
        if (![1, 2, 3].includes(block.level as number)) throw new DocumentFailure('invalid-input', index);
        return { type: 'heading', level: block.level as 1 | 2 | 3, content: text(block.content, false, true) };
      case 'paragraph': exact(['content']); return { type: 'paragraph', content: text(block.content, true, true) };
      case 'clause': exact(['label', 'content']); return { type: 'clause', label: text(block.label), content: text(block.content, true, true) };
      case 'page-break': exact([]); return { type: 'page-break' };
      case 'table': {
        exact(['headers', 'rows']);
        // Word cannot open a table wider than 63 columns: a real format limit, reported as a layout it cannot hold.
        if (Array.isArray(block.headers) && block.headers.length > DOCX_MAX_TABLE_COLUMNS) throw new DocumentFailure('layout-unrepresentable', index);
        const headers = array(block.headers, 1).map(cell => text(cell));
        const rows = array(block.rows, 1).map(value => {
          const row = array(value, headers.length);
          if (row.length !== headers.length) throw new DocumentFailure('invalid-input', index);
          return row.map(cell => text(cell));
        });
        return { type: 'table', headers, rows };
      }
      case 'signature': {
        exact(['parties']);
        return { type: 'signature', parties: array(block.parties, 1).map(value => {
          const party = object(value, ['label', 'name']);
          return { label: text(party.label), ...(party.name === undefined ? {} : { name: text(party.name) }) };
        }) };
      }
      default: throw new DocumentFailure('invalid-input', index);
    }
  });
  if (!options.part) blocks.forEach((block, index) => {
    if (block.type === 'page-break' && (index === 0 || index === blocks.length - 1 || blocks[index - 1].type === 'page-break')) throw new DocumentFailure('invalid-input', index);
  });
  return { schema_version: 1, path: raw.path, format: raw.format as 'docx' | 'pdf', template: raw.template as 'contract-v1' | 'report-v1',
    document: { title, ...(subtitle ? { subtitle } : {}), language, page: doc.page === 'letter' ? 'letter' : 'a4',
      ...(header ? { header } : {}), ...(footer ? { footer } : {}), blocks } };
}
