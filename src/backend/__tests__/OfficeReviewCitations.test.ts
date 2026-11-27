import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkOfficeReviewCitation, parseOfficeReviewCitation, type OfficeCitationCustody } from '../OfficeReviewCitations';
import type { WorkbookDeliveryFact } from '../../content/WorkbookDelivery';
import type { OfficeVisualReceipt } from '../../office/OfficeVisualContracts';
import { ReviewReceiptRegistry, closeReviewEvidence, parseReviewEvidenceState } from '../ReviewEvidence';

const sha = 'a'.repeat(64); const other = 'b'.repeat(64);
function fixture() {
  const id = 'workbook-delivery-' + randomUUID();
  const read: WorkbookDeliveryFact = { id, scope: { sourceVersion: 'snapshot-owned', sourceSha256: sha, selection: '["sheet:1","A1:B2","all"]' },
    payload_sha256: other, state: 'payload-submitted', route: 'http', submitted_units: ['cell:A1', 'cell:A2', 'cell:B1', 'cell:B2'], observed_units: [] };
  const visual: OfficeVisualReceipt = { delivery_id: 'office-visual-' + randomUUID(), asset_id: 'content-1',
    origin: { kind: 'rendered-page', operation_id: 'office-render-' + randomUUID(), sha256: sha, source_sha256: other, page: 2, width: 10, height: 10, bytes: 100 },
    preview: { sha256: other, width: 5, height: 5, bytes: 50, resized: true, reencoded: true }, state: 'payload-submitted', route: 'http',
    provider_result: 'accepted', transport: { submitted: 1, accepted: 1, rejected: 0 }, viewed: 'unknown', visual_review: 'not-run' };
  const custody: OfficeCitationCustody = { read: ref => ref === read.id ? structuredClone(read) : undefined,
    visual: ref => ref === visual.delivery_id ? structuredClone(visual) : undefined };
  const cell = { kind: 'sheet-range' as const, receiptId: id, sourceRef: 'snapshot-owned', sourceSha256: sha, sheetId: 'sheet:1', range: 'A1:B2', visibility: 'all' as const };
  const page = { kind: 'render-page' as const, receiptId: visual.delivery_id, assetId: 'content-1', sourceSha256: other, page: 2, imageSha256: sha, previewSha256: other };
  return { read, visual, custody, cell, page };
}

describe('v2 Office citation selectors', () => {
  it('supports mixed v2 text/binary findings and strict count-only reload while leaving v1 text evidence readable', () => {
    const receipts = new ReviewReceiptRegistry(); const id = 'workbook-delivery-' + randomUUID(); const payload = JSON.stringify({ id, cells: ['a'] });
    receipts.workbooks.prepare(receipts, { sourceVersion: 'snapshot', sourceSha256: sha, selection: '["csv:1","A1","all"]' }, payload,
      [{ unit: 'cell:A1', start: 0, end: 1, total: 1 }], id);
    receipts.workbooks.recordText(receipts, payload, 'http', 'payload-submitted');
    const read = receipts.issueRead({ path: 'source.txt', pathAliases: [], startLine: 1, endLine: 1, contentDigest: sha, coverage: 'complete' })!;
    const text = { readReceiptId: read.id, path: 'source.txt', startLine: 1, endLine: 1 };
    const binary = { kind: 'sheet-range', receiptId: id, sourceRef: 'snapshot', sourceSha256: sha, sheetId: 'csv:1', range: 'A1', visibility: 'all' };
    const input = { schemaVersion: 2, coverage: 'partial', findings: [{ classification: 'observed', statement: 'Review these facts.', citations: [{ kind: 'text-line', ...text }, binary] }] };
    const closed = closeReviewEvidence(input, receipts); expect(closed.ok).toBe(true); if (!closed.ok) return;
    expect(closed.state).toMatchObject({ schemaVersion: 2, receipt: { schemaVersion: 2, citations: 2, citedFiles: 1, binarySources: 1 } });
    expect(parseReviewEvidenceState(JSON.parse(JSON.stringify(closed.state)))).toEqual(closed.state);
    const legacy = closeReviewEvidence({ ...input, schemaVersion: 1, findings: [{ classification: 'observed', statement: 'Text.', citations: [text] }] }, receipts);
    expect(legacy).toMatchObject({ ok: true, state: { schemaVersion: 1, receipt: { citations: 1 } } });
    expect(closeReviewEvidence({ ...input, findings: [{ classification: 'observed', statement: 'No support.', citations: [] }] }, receipts).ok).toBe(false);
    expect(closeReviewEvidence({ ...input, findings: [{ ...input.findings[0], citations: Array(9).fill(binary) }] }, receipts).ok).toBe(false);
    expect(closeReviewEvidence({ ...input, schemaVersion: 1, findings: [{ classification: 'observed', statement: 'Wrong version.', citations: [binary] }] }, receipts).ok).toBe(false);
  });
  it('checks exact cells, snapshot byte hash, worksheet and visibility rather than computation metadata', () => {
    const f = fixture(); expect(checkOfficeReviewCitation(f.cell, f.custody)).toMatchObject({ ok: true, evidence: 'text-payload', sourceSha256: sha });
    for (const change of [{ sourceSha256: other }, { sourceRef: 'other' }, { sheetId: 'sheet:2' }, { visibility: 'visible-only' as const }, { range: 'A1:C2' }])
      expect(checkOfficeReviewCitation({ ...f.cell, ...change }, f.custody).ok).toBe(false);
    f.read.submitted_units.pop(); expect(checkOfficeReviewCitation(f.cell, f.custody).ok).toBe(false);
  });
  it('unknown, prepared, foreign-attempt and code-wrapper-only delivery cannot become an observed citation', () => {
    const f = fixture();
    for (const state of ['prepared', 'unknown'] as const) { f.read.state = state; expect(checkOfficeReviewCitation(f.cell, f.custody).ok).toBe(false); }
    f.read.state = 'payload-submitted'; f.read.route = 'codex'; expect(checkOfficeReviewCitation(f.cell, f.custody).ok).toBe(false);
    expect(checkOfficeReviewCitation(f.cell, { read: () => undefined, visual: () => undefined }).ok).toBe(false);
    f.read.state = 'observed'; f.read.observed_units = [...f.read.submitted_units]; expect(checkOfficeReviewCitation(f.cell, f.custody).ok).toBe(true);
  });
  it('checks complete package object ids and type without treating DOCX/PPTX as fake text lines', () => {
    const f = fixture(); f.read.id = 'office-delivery-' + randomUUID(); f.read.scope.selection = '["office","pptx"]'; f.read.submitted_units = ['object:S1-O2'];
    const slide = { kind: 'slide-object' as const, receiptId: f.read.id, sourceRef: f.read.scope.sourceVersion, sourceSha256: sha, slideRef: 'S1', objectRef: 'S1-O2' };
    expect(checkOfficeReviewCitation(slide, f.custody).ok).toBe(true);
    expect(checkOfficeReviewCitation({ ...slide, objectRef: 'S1-O3' }, f.custody).ok).toBe(false);
    expect(parseOfficeReviewCitation({ ...slide, slideRef: 'S2' })).toBeUndefined();
    f.read.scope.selection = '["office","docx"]'; f.read.submitted_units = ['paragraph:P1'];
    expect(checkOfficeReviewCitation({ ...slide, kind: 'document-object', objectKind: 'paragraph', objectRef: 'P1' }, f.custody).ok).toBe(true);
  });
  it('binds rendered original page, original bytes and disclosed resized preview, and requires an unrejected image payload', () => {
    const f = fixture(); expect(checkOfficeReviewCitation(f.page, f.custody)).toMatchObject({ ok: true, evidence: 'image-payload', sourceSha256: other });
    for (const change of [{ page: 1 }, { sourceSha256: sha }, { imageSha256: other }, { previewSha256: sha }, { assetId: 'content-2' }])
      expect(checkOfficeReviewCitation({ ...f.page, ...change }, f.custody).ok).toBe(false);
    f.visual.provider_result = 'rejected'; expect(checkOfficeReviewCitation(f.page, f.custody).ok).toBe(false);
    f.visual.provider_result = 'unknown'; expect(checkOfficeReviewCitation(f.page, f.custody).ok).toBe(false);
  });
  it('does not infer CLI viewing from returned data:image lines or from a model assertion', () => {
    const f = fixture(); f.visual.route = 'codex'; expect(checkOfficeReviewCitation(f.page, f.custody).ok).toBe(false);
    expect(checkOfficeReviewCitation({ ...f.page, viewed: 'observed' } as any, f.custody).ok).toBe(false);
    f.visual.route = 'claude'; expect(checkOfficeReviewCitation(f.page, f.custody).ok).toBe(false);
    f.visual.viewed = 'observed'; expect(checkOfficeReviewCitation(f.page, f.custody).ok).toBe(true);
  });
  it('matches generated image origin and records dispatch-target mismatch without promoting a stale result', () => {
    const f = fixture(); f.visual.origin.kind = 'generated-image';
    const image = { kind: 'image' as const, receiptId: f.visual.delivery_id, assetId: f.visual.asset_id, imageSha256: sha, previewSha256: other };
    expect(checkOfficeReviewCitation(image, f.custody).ok).toBe(true); expect(checkOfficeReviewCitation(f.page, f.custody).ok).toBe(false);
    expect(checkOfficeReviewCitation(image, { ...f.custody, targetDigest: () => other })).toMatchObject({ ok: false, targetChanged: true });
  });
  it('rejects malformed and unbounded selectors before iterating any requested cells', () => {
    const f = fixture();
    for (const range of ['A0', 'B2:A1', 'A1:ZZZZZZZZZZZZZZZZZZZZ2', 'A1:B9999999999999999'])
      expect(checkOfficeReviewCitation({ ...f.cell, range }, f.custody).ok).toBe(false);
    expect(parseOfficeReviewCitation({ ...f.cell, receiptId: 'R1' })).toBeUndefined();
  });
});
