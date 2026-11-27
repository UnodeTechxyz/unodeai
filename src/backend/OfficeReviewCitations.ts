import type { WorkbookDeliveryFact } from '../content/WorkbookDelivery';
import type { OfficeVisualReceipt } from '../office/OfficeVisualContracts';

/** v2 selectors name actual host receipts, never fabricated text line numbers for binary files. */
interface ReadCitation { receiptId: string; sourceRef: string; sourceSha256: string }
export type OfficeReviewCitation =
  | (ReadCitation & { kind: 'sheet-range'; sheetId: string; range: string; visibility: 'all' | 'visible-only' })
  | (ReadCitation & { kind: 'slide-object'; slideRef: string; objectRef: string })
  | (ReadCitation & { kind: 'document-object'; objectKind: 'paragraph' | 'table-cell'; objectRef: string })
  | { kind: 'render-page'; receiptId: string; assetId: string; sourceSha256: string; page: number; imageSha256: string; previewSha256: string }
  | { kind: 'image'; receiptId: string; assetId: string; imageSha256: string; previewSha256: string };

export interface OfficeCitationCustody {
  /** Implementations are bound to the current admitted attempt, not a global receipt search. */
  read(id: string): WorkbookDeliveryFact | undefined;
  visual(id: string): OfficeVisualReceipt | undefined;
  /** Only for a source the host identifies as the review target: its digest captured at dispatch. */
  targetDigest?(receiptId: string): string | undefined;
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ref = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const readId = (value: unknown) => typeof value === 'string' && /^(?:office|workbook)-delivery-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const visualId = (value: unknown) => typeof value === 'string' && /^office-visual-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

export function parseOfficeReviewCitation(raw: unknown): OfficeReviewCitation | undefined {
  if (!record(raw) || !ref(raw.receiptId)) return undefined;
  if (raw.kind === 'sheet-range' || raw.kind === 'slide-object' || raw.kind === 'document-object') {
    if (!readId(raw.receiptId) || !ref(raw.sourceRef) || !hash(raw.sourceSha256)) return undefined;
    const base = { receiptId: raw.receiptId, sourceRef: raw.sourceRef, sourceSha256: raw.sourceSha256 };
    if (raw.kind === 'sheet-range') return ref(raw.sheetId) && typeof raw.range === 'string' && rangeBounds(raw.range)
      && (raw.visibility === 'all' || raw.visibility === 'visible-only')
      ? { ...base, kind: 'sheet-range', sheetId: raw.sheetId, range: raw.range.toUpperCase(), visibility: raw.visibility } : undefined;
    if (raw.kind === 'slide-object') return ref(raw.slideRef) && /^S[1-9]\d*$/.test(raw.slideRef)
      && ref(raw.objectRef) && new RegExp('^' + raw.slideRef + '-O[1-9]\\d*$').test(raw.objectRef)
      ? { ...base, kind: 'slide-object', slideRef: raw.slideRef, objectRef: raw.objectRef } : undefined;
    return (raw.objectKind === 'paragraph' || raw.objectKind === 'table-cell') && typeof raw.objectRef === 'string'
      && /^[A-Za-z0-9:_-]{1,120}$/.test(raw.objectRef)
      ? { ...base, kind: 'document-object', objectKind: raw.objectKind, objectRef: raw.objectRef } : undefined;
  }
  if (raw.kind === 'render-page' || raw.kind === 'image') {
    if (!visualId(raw.receiptId) || typeof raw.assetId !== 'string' || !/^content-[1-9]\d*$/.test(raw.assetId)
      || !hash(raw.imageSha256) || !hash(raw.previewSha256)) return undefined;
    const base = { receiptId: raw.receiptId, assetId: raw.assetId, imageSha256: raw.imageSha256, previewSha256: raw.previewSha256 };
    if (raw.kind === 'image') return { ...base, kind: 'image' };
    return hash(raw.sourceSha256) && Number.isSafeInteger(raw.page) && (raw.page as number) > 0
      ? { ...base, kind: 'render-page', sourceSha256: raw.sourceSha256, page: raw.page as number } : undefined;
  }
  return undefined;
}

export type OfficeCitationCheck = { ok: true; evidence: 'text-payload' | 'image-payload'; sourceSha256: string }
  | { ok: false; reason: string; targetChanged?: true };

/** Checks receipt custody/version/selector coverage only, never the truth or completeness of a review. */
export function checkOfficeReviewCitation(citation: OfficeReviewCitation, custody: OfficeCitationCustody): OfficeCitationCheck {
  const parsed = parseOfficeReviewCitation(citation); if (!parsed) return no('The binary citation selector is invalid.'); citation = parsed;
  if (citation.kind === 'render-page' || citation.kind === 'image') {
    const fact = custody.visual(citation.receiptId);
    if (!fact || fact.state !== 'payload-submitted' || fact.asset_id !== citation.assetId
      || fact.origin.sha256 !== citation.imageSha256 || fact.preview.sha256 !== citation.previewSha256) return no('No matching image payload receipt belongs to this attempt.');
    const delivered = fact.route === 'http' ? fact.provider_result === 'accepted' && fact.transport.accepted > 0
      : fact.viewed === 'observed';
    if (!delivered) return no('Image delivery is rejected or unknown; submission alone cannot establish this visual citation. Continue other checks or report visual coverage as incomplete.');
    const digest = citation.kind === 'render-page' ? fact.origin.source_sha256 : fact.origin.sha256;
    if (!digest || (citation.kind === 'render-page'
      ? fact.origin.kind !== 'rendered-page' || fact.origin.page !== citation.page || digest !== citation.sourceSha256
      : fact.origin.kind !== 'generated-image')) return no('The image origin, original page or source version does not match this citation.');
    return targetVersion(custody, citation.receiptId, digest) ?? { ok: true, evidence: 'image-payload', sourceSha256: digest };
  }
  const fact = custody.read(citation.receiptId);
  if (!fact || !fact.route || !['payload-submitted', 'observed'].includes(fact.state)
    || fact.scope.sourceVersion !== citation.sourceRef || fact.scope.sourceSha256 !== citation.sourceSha256) return no('No matching delivered source version belongs to this attempt.');
  if (fact.route === 'codex' && fact.state !== 'observed') return no('Codex App Server submission leaves code-wrapper text delivery unknown; it cannot establish an observed citation.');
  const changed = targetVersion(custody, citation.receiptId, citation.sourceSha256); if (changed) return changed;
  const complete = new Set(fact.state === 'observed' ? fact.observed_units : fact.submitted_units);
  let selection: unknown; try { selection = JSON.parse(fact.scope.selection); } catch { return no('The receipt selection is unavailable.'); }
  if (!Array.isArray(selection)) return no('The receipt selection is unavailable.');
  if (citation.kind === 'sheet-range') {
    if (selection[0] !== citation.sheetId || selection[2] !== citation.visibility) return no('The worksheet or visibility selection does not match.');
    const bounds = rangeBounds(citation.range)!; const cells = (bounds.r2 - bounds.r1 + 1) * (bounds.c2 - bounds.c1 + 1);
    // A proof cannot name more complete cells than it holds; this avoids iterating unbounded model input.
    if (!Number.isSafeInteger(cells) || cells > complete.size) return no('Some cited cells were not delivered completely.');
    for (let row = bounds.r1; row <= bounds.r2; row++) for (let column = bounds.c1; column <= bounds.c2; column++) {
      if (!complete.has(`cell:${columnName(column)}${row}`)) return no('Some cited cells were not delivered completely.');
    }
  } else {
    if (selection[0] !== 'office' || selection[1] !== (citation.kind === 'slide-object' ? 'pptx' : 'docx')
      || !complete.has(`${citation.kind === 'slide-object' ? 'object' : citation.objectKind}:${citation.objectRef}`)) return no('The cited package object was not delivered completely.');
  }
  return { ok: true, evidence: 'text-payload', sourceSha256: citation.sourceSha256 };
}
function no(reason: string): OfficeCitationCheck { return { ok: false, reason }; }
function targetVersion(custody: OfficeCitationCustody, id: string, digest: string): OfficeCitationCheck | undefined {
  const expected = custody.targetDigest?.(id);
  return expected && expected !== digest ? { ok: false, targetChanged: true, reason: 'The cited target version differs from the bytes bound when this review was dispatched.' } : undefined;
}
function rangeBounds(value: string): { r1: number; r2: number; c1: number; c2: number } | undefined {
  const match = /^([A-Z]{1,20})([1-9]\d{0,15})(?::([A-Z]{1,20})([1-9]\d{0,15}))?$/i.exec(value); if (!match) return undefined;
  const column = (text: string) => { let n = 0; for (const char of text.toUpperCase()) n = n * 26 + char.charCodeAt(0) - 64; return n; };
  const bounds = { r1: Number(match[2]), r2: Number(match[4] ?? match[2]), c1: column(match[1]), c2: column(match[3] ?? match[1]) };
  return Object.values(bounds).every(Number.isSafeInteger) && bounds.r1 <= bounds.r2 && bounds.c1 <= bounds.c2 ? bounds : undefined;
}
function columnName(column: number): string {
  let result = ''; for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
}
