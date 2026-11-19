import { describe, expect, it, vi } from 'vitest';
import { renderDocx } from '../DocxRenderer';
import { documentLayoutWarnings, DOCUMENT_LAYOUT_POLICY } from '../DocumentLayoutAdmission';
import { validateDocumentRequest } from '../DocumentValidation';
import { DOCUMENT_LAYOUT_WARNING_TEXT, parseDocumentReceipt, type DocumentReceiptV1 } from '../DocumentWrite';
import { documentInput } from '../../../backend/__tests__/documentRouteFixtures';
import { RequestFileEffects } from '../../../session/RequestCloseoutAccumulator';
import { RequestCloseoutAccumulator } from '../../../session/RequestCloseoutAccumulator';
import { parseRequestCloseoutRecord, projectRequestSummary, jobOutcomeWithRequestLimits } from '../../../observability/RequestCloseout';
import { summarizeToolResult, hostToolSucceeded } from '../../../backend/toolSummary';
import { noJobUsage } from '../../../observability/JobOutcomeUsage';

async function receipt(): Promise<DocumentReceiptV1> {
  const input = validateDocumentRequest(documentInput('docx', 'مرحبا'));
  const { bytes, stats } = await renderDocx(input, () => new (require('yazl').ZipFile)());
  return { ...stats, kind: 'document-written', version: 1, path: input.path, bytes: bytes.length, sha256: 'a'.repeat(64),
    effect: 'created', layoutAdmissionPolicy: DOCUMENT_LAYOUT_POLICY, layoutWarnings: documentLayoutWarnings(input.document) };
}
describe('D3 host document receipt metadata, not another effect counter', () => {
  it('retains warnings in the reloaded request summary and displayed job outcome without double-counting effects', async () => {
    const r = await receipt(); const changed = vi.fn(); const effects = new RequestFileEffects(changed);
    effects.effect({ key: 'physical-file', path: r.path, operation: 'write', grade: 'host-verified' });
    effects.documentWritten(r); effects.documentWritten({ ...r, effect: 'unchanged' });
    expect(effects.observation().grades?.hostVerified).toBe(1); expect(effects.observation().documents).toHaveLength(1);
    const accumulator = new RequestCloseoutAccumulator({ requestId: 'request', rootAgentId: 'agent', terminalTurnId: 'turn',
      originTurnId: 'turn' }, effects);
    // Use the accumulator's real closed record through its finite parser/projection.
    const record = accumulator.finish({ terminal: { kind: 'answered' }, recordedAt: '2026-10-25T00:00:01.000Z', eventsCut: false });
    expect(record).toBeDefined();
    const reloaded = parseRequestCloseoutRecord(JSON.parse(JSON.stringify(record)))!;
    expect(reloaded.observations.changes.documents?.[0].layoutWarnings).toEqual(r.layoutWarnings);
    expect(JSON.stringify(projectRequestSummary(reloaded, { usage: noJobUsage }))).toContain(DOCUMENT_LAYOUT_WARNING_TEXT);
    const view = jobOutcomeWithRequestLimits({ available: true, sections: [] } as any, reloaded);
    expect(view.sections).toContainEqual(expect.objectContaining({ title: 'Documents', note: DOCUMENT_LAYOUT_WARNING_TEXT }));
    const card = summarizeToolResult('write_document', {}, { ...hostToolSucceeded('saved'), documentWrite: { code: 'written', receipt: r } });
    expect(card.summary).toContain('reader layout unverified');
    effects.restored(r.path, 'restored'); expect(effects.observation().documents).toBeUndefined();
  });
  it('does not invent changes for unchanged documents and strips arbitrary persisted receipt fields', async () => {
    const r = await receipt(); const effects = new RequestFileEffects();
    effects.documentWritten({ ...r, effect: 'unchanged' });
    expect(effects.observation().grades?.hostVerified).toBe(0); expect(effects.observation().files).toEqual([]);
    expect(parseDocumentReceipt({ ...r, rawBody: 'private-body', absoluteFontPath: 'private-font' })).toEqual(r);
    expect(parseDocumentReceipt({ ...r, format: 'pdf', pages: 1 })).toBeUndefined();
    // v0.9.99: a receipt for a long document reloads; no 10 MiB, 120-page or 1,000-block ceiling here either.
    const long = { ...r, format: 'pdf' as const, layoutWarnings: [], pages: 121, blocks: 1001, headings: 1001, bytes: 10_485_761 };
    expect(parseDocumentReceipt(long)).toEqual(long);
    expect(parseDocumentReceipt({ ...long, pages: 0 })).toBeUndefined(); expect(parseDocumentReceipt({ ...long, bytes: 0 })).toBeUndefined();
    expect(parseDocumentReceipt({ ...r, path: '../private' })).toBeUndefined();
    expect(parseDocumentReceipt({ ...r, layoutWarnings: [{ code: 'reader-layout-unverified', scripts: ['secret-content'], reasons: ['script'] }] })).toBeUndefined();
    effects.effect({ key: 'physical-file', path: r.path, operation: 'write', grade: 'host-verified' });
    expect(effects.observation().documents).toBeUndefined();
  });
});
