import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WorkbookDeliveryRegistry } from '../WorkbookDelivery';
import { workbookDeliveryFragments } from '../WorkbookDeliveryFragments';
import { sanitizeContentReceipt } from '../ContentReceipt';
import { RunLedger } from '../../observability/RunLedger';
import { renderRunEvidencePack } from '../../observability/RunEvidencePack';
import { renderPortableRunEvidence } from '../../observability/PortableRunEvidence';

describe('Office object delivery custody', () => {
  function fixture() {
    const registry = new WorkbookDeliveryRegistry(); const holder = {};
    const scope = { sourceVersion: 'office-snapshot-fixture', sourceSha256: 'a'.repeat(64), selection: '["office","pptx"]' };
    const record = JSON.stringify({ object_ref: 'S1-O1', text: 'PRIVATE_OBJECT_TEXT' });
    const prepare = (start: number, end: number, hash = scope.sourceSha256) => {
      const id = 'office-delivery-' + randomUUID();
      const page = { delivery_ref: id, prepared_fragments: [{ kind: 'object-fragment', id: 'S1-O1', encoding: 'json-utf8',
        text: record.slice(start, end), start_byte: start, end_byte: end, total_bytes: record.length }] };
      const fragments = workbookDeliveryFragments(page, true); expect(fragments.unknown).toBe(false);
      const payload = JSON.stringify(page); registry.prepare(holder, { ...scope, sourceSha256: hash }, payload, fragments.fragments, id);
      return { id, payload };
    };
    return { registry, holder, record, prepare };
  }

  it('requires actual complete payload fragments of one source version before recording a delivered object', () => {
    const f = fixture(); const first = f.prepare(0, 10); const last = f.prepare(10, f.record.length);
    f.registry.recordText(f.holder, first.payload, 'http', 'payload-submitted');
    expect(f.registry.fact(f.holder, first.id)?.submitted_units).toEqual([]);
    f.registry.recordText(f.holder, last.payload, 'http', 'payload-submitted');
    expect(f.registry.fact(f.holder, last.id)).toMatchObject({ state: 'payload-submitted', submitted_units: ['object:S1-O1'], observed_units: [] });
    expect(JSON.stringify(f.registry.facts(f.holder))).not.toContain('PRIVATE_OBJECT_TEXT');
  });

  it('does not join fragments from changed bytes or attest a shortened result that still names the receipt', () => {
    const f = fixture(); const first = f.prepare(0, 10); const changed = f.prepare(10, f.record.length, 'b'.repeat(64));
    f.registry.recordText(f.holder, first.payload, 'claude', 'observed');
    f.registry.recordText(f.holder, changed.payload, 'claude', 'observed');
    expect(f.registry.fact(f.holder, changed.id)?.observed_units).toEqual([]);
    const whole = f.prepare(0, f.record.length);
    f.registry.recordText(f.holder, whole.payload.replace('PRIVATE_OBJECT_TEXT', 'cut'), 'claude', 'observed');
    expect(f.registry.fact(f.holder, whole.id)).toMatchObject({ state: 'unknown', observed_units: [], submitted_units: [] });
  });

  it('isolates holders, keeps cloned facts immutable and releases ended-attempt custody', () => {
    const f = fixture(); const whole = f.prepare(0, f.record.length);
    expect(f.registry.fact({}, whole.id)).toBeUndefined();
    expect(f.registry.recordText({}, whole.payload, 'codex', 'payload-submitted')).toEqual([]);
    f.registry.recordText(f.holder, whole.payload, 'codex', 'payload-submitted');
    const clone = f.registry.fact(f.holder, whole.id)!; clone.scope.sourceSha256 = 'c'.repeat(64); clone.submitted_units.length = 0;
    expect(f.registry.fact(f.holder, whole.id)).toMatchObject({ scope: { sourceSha256: 'a'.repeat(64) }, submitted_units: ['object:S1-O1'] });
    f.registry.release(f.holder); expect(f.registry.fact(f.holder, whole.id)).toBeUndefined();
  });

  it('does not count package metadata or an object id with no delivered content as object coverage', () => {
    const fragments = workbookDeliveryFragments({ prepared_fragments: [
      { kind: 'part', id: 'P1', record: { content_type: 'fixture' } }, { kind: 'gap', id: 'S1-O1', record: { code: 'unavailable' } },
      { kind: 'object-fragment', id: 'S1-O1', encoding: 'json-utf8', text: '', start_byte: 0, end_byte: 0, total_bytes: 20 },
    ] }, true);
    expect(fragments.fragments).toEqual([{ unit: 'object:S1-O1', start: 0, end: 0, total: 20 }]);
    const registry = new WorkbookDeliveryRegistry(); const holder = {}; const id = 'office-delivery-' + randomUUID(); const payload = JSON.stringify({ id });
    registry.prepare(holder, { sourceVersion: 'fixture', selection: 'fixture' }, payload, fragments.fragments, id);
    registry.recordText(holder, payload, 'http', 'payload-submitted'); expect(registry.fact(holder, id)?.submitted_units).toEqual([]);
  });

  it('keeps only bounded Office counts through ledger reload and exports, without source hash or private content', () => {
    const id = 'office-delivery-' + randomUUID();
    const receipt = { contentClass: 'office' as const, receiptId: id, action: 'payload-submitted' as const, route: 'codex' as const,
      scopeDigest: 'a'.repeat(64), payloadDigest: 'b'.repeat(64), submittedUnits: 1, observedUnits: 0 };
    expect(sanitizeContentReceipt(receipt)).toEqual(receipt);
    expect(sanitizeContentReceipt({ ...receipt, contentClass: 'workbook' })).toBeUndefined();
    const ledger = new RunLedger(); ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'read', requestedAgent: 'reader', agentId: 'reader', instruction: 'Read.', originCorrelationId: 'request' });
    ledger.recordContentReceipt({ ...receipt, agentId: 'reader', correlationId: 'read' });
    const restored = new RunLedger(JSON.parse(JSON.stringify(ledger.snapshot()))); const run = restored.snapshot()[0];
    expect(run.contentReceipts).toEqual([expect.objectContaining(receipt)]);
    expect(renderRunEvidencePack(run)).toContain('office payload');
    const portable = renderPortableRunEvidence(run); expect(portable).toContain('office');
    expect(portable).not.toContain('a'.repeat(64)); expect(portable).not.toContain(id); expect(portable).not.toContain('PRIVATE_OBJECT_TEXT');
  });
});
