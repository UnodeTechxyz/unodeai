/**
 * v0.9.99: no fixed whole-document ceiling (text, bytes, runs, blocks, cells, distinct characters, lines, pages,
 * output size, queue length or render time) refuses a document. What remains is correctness (structure, XML-safe
 * characters, path and authority), real layout or font failures, and real resource exhaustion, each reported as
 * itself. Word's own table limit of 63 columns is the one structural maximum, because Word cannot open more.
 */
export const DOCX_MAX_TABLE_COLUMNS = 63;
export type DocumentFailureCode = 'invalid-input' | 'extension-mismatch' | 'unsupported-glyph' | 'unsupported-text-layout'
  | 'layout-unrepresentable' | 'cancelled' | 'worker-exit' | 'out-of-memory'
  | 'render-stop-unconfirmed' | 'permission-refused' | 'target-refused' | 'target-changed'
  | 'denied' | 'checkpoint-failed' | 'not-committed' | 'effect-uncertain' | 'font-resource-invalid'
  | 'document-language-required' | 'font-unavailable' | 'font-embedding-restricted' | 'font-discovery-limit'
  | 'font-budget' | 'font-resource-changed' | 'draft-not-found' | 'draft-storage-failed';
export const DOCUMENT_FAILURE_CODES: readonly DocumentFailureCode[] = ['invalid-input', 'extension-mismatch',
  'unsupported-glyph', 'unsupported-text-layout', 'layout-unrepresentable', 'cancelled', 'worker-exit', 'out-of-memory',
  'render-stop-unconfirmed', 'permission-refused', 'target-refused', 'target-changed', 'denied', 'checkpoint-failed',
  'not-committed', 'effect-uncertain', 'font-resource-invalid', 'document-language-required', 'font-unavailable',
  'font-embedding-restricted', 'font-discovery-limit', 'font-budget', 'font-resource-changed', 'draft-not-found',
  'draft-storage-failed'];
export class DocumentFailure extends Error {
  constructor(public readonly code: DocumentFailureCode, public readonly blockIndex?: number) {
    super(`Document generation refused: ${code}.`);
    this.name = 'DocumentFailure';
  }
}
export interface DocumentRun { text: string; bold: boolean; language: string }
export type DocumentText = DocumentRun[];
export type DocumentBlock =
  | { type: 'heading'; level: 1 | 2 | 3; content: DocumentText }
  | { type: 'paragraph'; content: DocumentText }
  | { type: 'clause'; label: DocumentText; content: DocumentText }
  | { type: 'table'; headers: DocumentText[]; rows: DocumentText[][] }
  | { type: 'page-break' }
  | { type: 'signature'; parties: Array<{ label: DocumentText; name?: DocumentText }> };
export interface CanonicalDocument {
  title: DocumentText; subtitle?: DocumentText; language: string; page: 'a4' | 'letter';
  header?: DocumentText; footer?: DocumentText; blocks: DocumentBlock[];
}
export interface CanonicalDocumentRequest {
  schema_version: 1; path: string; format: 'docx' | 'pdf'; template: 'contract-v1' | 'report-v1';
  document: CanonicalDocument;
}
export interface DocumentRenderStats {
  format: 'docx' | 'pdf'; template: 'contract-v1' | 'report-v1'; blocks: number; headings: number; clauses: number;
  tables: number; pages?: number; rendererRevision: 2; fontManifestDigest: string;
}
export const documentPlainText = (runs: readonly DocumentRun[]): string => runs.map(run => run.text).join('');
export function documentTexts(document: CanonicalDocument): DocumentText[] {
  const texts = [document.title, ...(document.subtitle ? [document.subtitle] : []),
    ...(document.header ? [document.header] : []), ...(document.footer ? [document.footer] : [])];
  for (const block of document.blocks) {
    if (block.type === 'heading' || block.type === 'paragraph') texts.push(block.content);
    if (block.type === 'clause') texts.push(block.label, block.content);
    if (block.type === 'table') texts.push(...block.headers, ...block.rows.flat());
    if (block.type === 'signature') for (const party of block.parties) texts.push(party.label, ...(party.name ? [party.name] : []));
  }
  return texts;
}
