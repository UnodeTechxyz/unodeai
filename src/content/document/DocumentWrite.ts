import type { DocumentFailureCode, DocumentRenderStats } from './DocumentContracts';
import { DOCUMENT_LAYOUT_POLICY, type documentLayoutWarnings } from './DocumentLayoutAdmission';

/** A host fact: never accepted in model arguments and never inferred from success prose. */
export interface DocumentReceiptV1 extends DocumentRenderStats {
  kind: 'document-written'; version: 1; path: string; bytes: number; sha256: string;
  effect: 'created' | 'replaced' | 'unchanged'; restorePointId?: string;
  layoutAdmissionPolicy: typeof DOCUMENT_LAYOUT_POLICY;
  layoutWarnings: ReturnType<typeof documentLayoutWarnings>;
}
export type DocumentWriteFact =
  | { code: 'written'; receipt: DocumentReceiptV1 }
  | { code: DocumentFailureCode; stage: 'input' | 'render' | 'commit'; targetEffect: 'none' | 'uncertain'; blockIndex?: number };

export const DOCUMENT_LAYOUT_WARNING_TEXT = 'File written; reader layout for these characters has not been verified. Open the file and check it.';

/** Closed metadata projection for persisted host receipts; never reconstruct a receipt from prose/arguments. */
export function parseDocumentReceipt(raw: unknown): DocumentReceiptV1 | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, any>;
  // v0.9.99: no document-size ceiling here either; a receipt for a long document reloads like any other.
  const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  if (r.kind !== 'document-written' || r.version !== 1 || !['docx', 'pdf'].includes(r.format)
    || !['contract-v1', 'report-v1'].includes(r.template) || typeof r.path !== 'string' || r.path.length > 1024
    || !r.path || /[\\:\x00-\x1f]/.test(r.path) || r.path.split('/').some((p: string) => !p || p === '..' || p === '.')
    || !count(r.bytes) || r.bytes === 0 || !/^[a-f0-9]{64}$/.test(r.sha256)
    || !['created', 'replaced', 'unchanged'].includes(r.effect) || r.rendererRevision !== 2
    || !/^[a-f0-9]{64}$/.test(r.fontManifestDigest) || r.layoutAdmissionPolicy !== DOCUMENT_LAYOUT_POLICY
    || !['blocks', 'headings', 'clauses', 'tables'].every(key => count(r[key]))
    || (r.format === 'pdf' ? !count(r.pages) || r.pages === 0 : r.pages !== undefined)
    || r.restorePointId !== undefined && (typeof r.restorePointId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(r.restorePointId))
    || !Array.isArray(r.layoutWarnings) || r.layoutWarnings.length > 1) return undefined;
  const warnings: DocumentReceiptV1['layoutWarnings'] = [];
  for (const w of r.layoutWarnings) {
    if (r.format !== 'docx' || w?.code !== 'reader-layout-unverified' || !Array.isArray(w.scripts)
      || w.scripts.length > 32 || !w.scripts.every((s: unknown) => typeof s === 'string' && /^(?:[A-Z][a-z]{3}|Other)$/.test(s))
      || !Array.isArray(w.reasons) || !w.reasons.length || w.reasons.length > 4
      || !w.reasons.every((s: unknown) => ['script', 'format-control', 'symbol', 'mark-sequence'].includes(s as string))) return undefined;
    warnings.push({ code: 'reader-layout-unverified', scripts: [...new Set<string>(w.scripts)].sort(), reasons: [...new Set<DocumentReceiptV1['layoutWarnings'][number]['reasons'][number]>(w.reasons)].sort() });
  }
  return { kind: 'document-written', version: 1, path: r.path, format: r.format, template: r.template, bytes: r.bytes,
    sha256: r.sha256, effect: r.effect, blocks: r.blocks, headings: r.headings, clauses: r.clauses, tables: r.tables,
    ...(r.format === 'pdf' ? { pages: r.pages } : {}), ...(r.restorePointId ? { restorePointId: r.restorePointId } : {}),
    rendererRevision: 2, fontManifestDigest: r.fontManifestDigest, layoutAdmissionPolicy: DOCUMENT_LAYOUT_POLICY, layoutWarnings: warnings };
}
export function documentReceiptText(receipt: DocumentReceiptV1): string {
  return [`Document written: ${receipt.path}`, `Format: ${receipt.format}; template: ${receipt.template}`,
    `Size: ${receipt.bytes} bytes; SHA-256: ${receipt.sha256}`, `Effect: ${receipt.effect}`,
    `Blocks: ${receipt.blocks}; headings: ${receipt.headings}; clauses: ${receipt.clauses}; tables: ${receipt.tables}`,
    ...(receipt.format === 'pdf' ? [`Pages: ${receipt.pages}`] : []),
    ...(receipt.restorePointId ? [`Restore point: ${receipt.restorePointId}`] : []),
    ...(receipt.layoutWarnings.length ? [DOCUMENT_LAYOUT_WARNING_TEXT] : []),
    'Saving a document is not a reader-layout check.'].join('\n');
}
