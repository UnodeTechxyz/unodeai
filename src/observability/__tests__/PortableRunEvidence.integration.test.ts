import { describe, expect, it } from 'vitest';
import type { DelegationEvidenceRecord } from '../../backend/TeamTools';
import { createTurnContextManifest } from '../../session/TurnContextManifest';
import type { Message } from '../../types';
import {
  buildPortableRunEvidence,
  PORTABLE_SCHEMA_FIELDS,
  renderPortableRunEvidence,
  type PortableRunEvidence,
} from '../PortableRunEvidence';
import { RunLedger } from '../RunLedger';
import { renderRunEvidencePack } from '../RunEvidencePack';

const RETAINED_PATH_CANARY = 'clients/acme/portable-retained-canary.ts';
const MACHINE_ID_CANARY = 'local:MACHINE-ID-MUST-STAY-INTERNAL';
const PRIVATE_ENDPOINT_CANARY = 'https://private-gateway.internal.example/v1';
const SOURCE_CANARY = 'SOURCE-BYTES-MUST-NEVER-BE-RETAINED';
const PROSE_CANARY = 'PROSE-MUST-STAY-IN-THE-INTERNAL-PACK';
const CONTENT_URL_CANARY = 'https://private-docs.internal.example/board-pack.pdf?token=CONTENT-URL-MUST-STAY-INTERNAL';
const CONTENT_TEXT_CANARY = 'EXTRACTED-PDF-TEXT-MUST-STAY-INTERNAL';
const CONTENT_PATH_CANARY = 'C:/temp/unode-content-secret/content-48.pdf';

const evidence: DelegationEvidenceRecord = {
  outcome: 'verified',
  changedFiles: [RETAINED_PATH_CANARY],
  hadToolActions: true,
  verification: { ran: true, passed: true, command: `npm test --token=${PROSE_CANARY}` },
  unrecordedWrites: false,
};

function message(from: string, to: string, type: Message['type'], instruction: string, correlationId?: string): Message {
  return {
    id: `${from}-${to}-${type}`,
    ...(correlationId ? { correlationId } : {}),
    from,
    to,
    type,
    priority: 'normal',
    payload: { instruction },
    timestamp: '2026-08-21T18:00:00.000Z',
  };
}

function expectOnlyKeys(value: object, schema: keyof typeof PORTABLE_SCHEMA_FIELDS): void {
  const allowed = new Set(PORTABLE_SCHEMA_FIELDS[schema]);
  expect(Object.keys(value).filter((key) => !allowed.has(key)), schema).toEqual([]);
}

function assertPortableSchema(pack: PortableRunEvidence): void {
  expectOnlyKeys(pack, '$');
  expectOnlyKeys(pack.accounting, 'accounting');
  expect(Object.values(pack.accounting.dispositionsByKind).every((value) => Number.isInteger(value) && value >= 0)).toBe(true);
  for (const permission of pack.permissions) {
    expectOnlyKeys(permission, 'permission');
  }
  for (const repair of pack.outcomeRepairs) {
    expectOnlyKeys(repair, 'outcomeRepair');
  }
  if (pack.verdict) { expectOnlyKeys(pack.verdict, 'verdict'); }
  for (const delegation of pack.delegations) {
    expectOnlyKeys(delegation, 'delegation');
    if (delegation.diffDigest) {
      expectOnlyKeys(delegation.diffDigest, 'diffDigest');
      for (const file of delegation.diffDigest.files) {
        expectOnlyKeys(file, 'diffFile');
      }
    }
    if (delegation.verification) { expectOnlyKeys(delegation.verification, 'verification'); }
    if (delegation.temporaryScope) { expectOnlyKeys(delegation.temporaryScope, 'temporaryScope'); }
    if (delegation.usage) { expectOnlyKeys(delegation.usage, 'usage'); }
    for (const state of delegation.taskStates ?? []) { expectOnlyKeys(state, 'taskState'); }
    for (const receipt of delegation.inputReceipts ?? []) { expectOnlyKeys(receipt, 'inputReceipt'); }
  }
  for (const receipt of pack.content ?? []) {
    expectOnlyKeys(receipt, 'contentReceipt');
    if (receipt.pages) { expectOnlyKeys(receipt.pages, 'contentPages'); }
  }
  expectOnlyKeys(pack.omitted, 'omitted');
  for (const declaration of [...pack.omitted.excluded, ...pack.omitted.unavailable, ...pack.retained]) {
    expectOnlyKeys(declaration, 'declaration');
  }
}

describe('Portable Run Evidence from a production RunLedger record', () => {
  it('exports both artifacts, retains positive canaries, and rejects production-only private fields', () => {
    const ledger = new RunLedger();
    const root = message('user', 'pm-private-name', 'ask.question', `${PROSE_CANARY}: ship the change.`);
    ledger.observeMessage(root);
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm-private-name',
      handle: 'real-ledger-handle',
      requestedAgent: `${PROSE_CANARY}-requested-agent`,
      agentId: 'developer-private-name',
      instruction: `${PROSE_CANARY}: edit the retained canary.`,
      originCorrelationId: root.id,
      scope: { folderAccess: [{ path: 'clients/acme', permission: 'readwrite' }] },
      route: {
        routeId: 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        connectionKind: 'openai-compatible',
        executionDomain: PRIVATE_ENDPOINT_CANARY,
        privacyDomain: {
          id: `unresolved-user-selected:${PRIVATE_ENDPOINT_CANARY}|private-model`,
          status: 'unresolved-user-selected',
        },
      },
    });
    ledger.recordTaskScopeApplied(
      'real-ledger-handle',
      { folderAccess: [{ path: 'clients/acme', permission: 'readwrite' }] },
      '2026-08-21T18:00:01.000Z',
    );
    ledger.recordContextManifest('developer-private-name', createTurnContextManifest([{
      kind: 'user-request',
      label: `${PROSE_CANARY}-context-label`,
      location: 'delegation',
      text: `${PROSE_CANARY}-context-text`,
      reason: 'delegated instruction',
    }]), 'real-ledger-handle');
    ledger.recordFileChange({
      agentId: 'developer-private-name',
      correlationId: 'real-ledger-handle',
      path: RETAINED_PATH_CANARY,
      before: null,
      after: SOURCE_CANARY,
    });
    ledger.recordDelegationEvidence({
      handle: 'real-ledger-handle', agentId: 'developer-private-name', outcome: 'verified', evidence,
    });
    ledger.recordDisposition({
      handle: 'real-ledger-handle',
      agentId: 'developer-private-name',
      outcome: 'verified',
      disposition: 'accepted',
      reason: `${PROSE_CANARY}-disposition`,
      recordedAt: '2026-08-21T18:01:00.000Z',
    });
    ledger.recordPermission({
      agentId: 'developer-private-name',
      kind: 'command-approval',
      decision: 'allowed',
      label: `${PROSE_CANARY}-permission-label`,
      approverId: MACHINE_ID_CANARY,
      correlationId: 'real-ledger-handle',
      recordedAt: '2026-08-21T18:00:30.000Z',
    });
    ledger.recordPermission({
      agentId: 'developer-private-name',
      kind: 'mcp-grant',
      decision: 'allowed',
      label: `${PROSE_CANARY}-server`,
      correlationId: 'real-ledger-handle',
      recordedAt: '2026-08-21T18:00:40.000Z',
    });
    ledger.recordPermission({
      agentId: 'developer-private-name',
      kind: 'tool-approval',
      decision: 'expired',
      correlationId: 'real-ledger-handle',
      recordedAt: '2026-08-21T18:00:45.000Z',
    });
    ledger.recordOutcomeRepair({
      outcomeId: `${PROSE_CANARY}-expired-outcome`, category: 'consent-timeout', state: 'unavailable',
      correlationId: 'real-ledger-handle', recordedAt: '2026-08-21T18:00:45.000Z',
    });
    ledger.recordOutcomeRepair({
      outcomeId: `${PROSE_CANARY}-empty-outcome`, category: 'delegate-empty', state: 'invoked',
      correlationId: 'real-ledger-handle', recordedAt: '2026-08-21T18:00:46.000Z',
    });
    // Deliberately pass fields a buggy observer might try to retain. The ledger's receipt boundary picks
    // only its bounded vocabulary before persistence; portable export re-validates it again.
    ledger.recordContentReceipt({
      agentId: 'developer-private-name',
      correlationId: 'real-ledger-handle',
      assetId: 'content-48',
      contentClass: 'pdf',
      action: 'read',
      extractionAttempted: true,
      extractionSucceeded: true,
      pages: { start: 1, end: 5, total: 42, extracted: 5 },
      truncated: false,
      ocrRequired: false,
      sourceUrl: CONTENT_URL_CANARY,
      extractedText: CONTENT_TEXT_CANARY,
      temporaryPath: CONTENT_PATH_CANARY,
    } as Parameters<RunLedger['recordContentReceipt']>[0]);
    ledger.observeMessage(message('pm-private-name', 'user', 'task.complete', 'done', root.id));

    const [run] = ledger.snapshot();
    const internal = renderRunEvidencePack(run, '2026-08-21T18:02:00.000Z');
    const portable = renderPortableRunEvidence(run, '2026-08-21T18:02:00.000Z');
    const pack = buildPortableRunEvidence(run, '2026-08-21T18:02:00.000Z');

    // This is a record produced through RunLedger's production methods, not a hand-assembled RunRecord.
    expect(run.schemaVersion).toBe(7);
    expect(internal).toContain(PRIVATE_ENDPOINT_CANARY);
    expect(internal).toContain(MACHINE_ID_CANARY);
    expect(internal).toContain(PROSE_CANARY);

    // Positive canaries prove that intended retained fields survive; exclusions alone would not.
    expect(portable).toContain(RETAINED_PATH_CANARY);
    expect(pack.delegations[0]).toMatchObject({
      routeId: 'custom-gateway',
      executionDomain: 'custom-gateway',
      privacyDomain: 'unresolved-user-selected',
      diffDigest: { algorithm: 'sha256', files: [{ path: RETAINED_PATH_CANARY }] },
    });
    expect(pack.permissions[0].approver).toBe('approver-1');
    expect(pack.permissions[1]).not.toHaveProperty('approver');
    expect(pack.permissions[2]).toMatchObject({ kind: 'tool-approval', decision: 'expired' });
    expect(pack.outcomeRepairs).toEqual([
      { category: 'consent-timeout', state: 'unavailable' },
      { category: 'delegate-empty', state: 'invoked' },
    ]);
    expect(pack.content).toEqual([{
      ordinal: 'content-1',
      contentClass: 'pdf',
      action: 'read',
      extractionAttempted: true,
      extractionSucceeded: true,
      pages: { start: 1, end: 5, total: 42, extracted: 5 },
      truncated: false,
      ocrRequired: false,
    }]);

    for (const excluded of [
      MACHINE_ID_CANARY, PRIVATE_ENDPOINT_CANARY, SOURCE_CANARY, PROSE_CANARY,
      CONTENT_URL_CANARY, CONTENT_TEXT_CANARY, CONTENT_PATH_CANARY, 'content-48',
    ]) {
      expect(portable).not.toContain(excluded);
    }
    expect(JSON.stringify(run)).not.toContain(SOURCE_CANARY);
    expect(JSON.stringify(run)).not.toContain(CONTENT_URL_CANARY);
    expect(JSON.stringify(run)).not.toContain(CONTENT_TEXT_CANARY);
    expect(JSON.stringify(run)).not.toContain(CONTENT_PATH_CANARY);
    expect(pack.retained.map((entry) => entry.field)).toEqual(expect.arrayContaining([
      'delegation.changedFiles', 'delegation.diffDigest', 'content.receipts',
    ]));
    expect(pack.omitted.unavailable.map((entry) => entry.field)).toContain('permission.approver');
    assertPortableSchema(pack);
  });
});
