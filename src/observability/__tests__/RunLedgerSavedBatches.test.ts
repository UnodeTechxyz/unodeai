import { describe, expect, it } from 'vitest';
import { RunLedger } from '../RunLedger';
import { buildPortableRunEvidence } from '../PortableRunEvidence';
import { incrementalContract } from '../../backend/__tests__/checkpointFixtures';

/*
 * v0.9.97 L1: the run record keeps a contract's delivery plan and the incomplete mark of partial work across a
 * restart, re-read through the same parsers; neither leaves in portable evidence.
 * Each test names the design sentence it realises (DESIGN_v0997 review resolution, section 7.2).
 */

function dispatched(ledger: RunLedger, contract = incrementalContract()): string {
  return ledger.recordDelegationDispatched({
    coordinatorId: 'pm', handle: 'h-1', requestedAgent: 'writer', agentId: 'writer',
    instruction: 'Draft the article.', contract, attemptId: 'attempt-1', originCorrelationId: 'root-1',
  });
}

describe('saved-batch facts in the run record', () => {
  it('keeps the delivery plan across a restart, and drops a contract whose stored plan no longer parses', () => {
    const ledger = new RunLedger();
    const runId = dispatched(ledger);
    expect(new RunLedger(ledger.snapshot()).get(runId)?.delegations[0].contract?.delivery).toEqual({
      mode: 'incremental',
      sections: [{ key: 'intro', title: 'Introduction' }, { key: 'body' }, { key: 'close' }],
      batchTarget: 'one complete section',
    });
    const tampered = ledger.snapshot();
    (tampered[0].delegations[0].contract as any).delivery.sections.push({ key: 'Not A Key' });
    expect(new RunLedger(tampered).get(runId)?.delegations[0].contract).toBeUndefined();
  });

  // §7.2: "保留不完整标记" - the mark of partial work survives the record's own normalization.
  it('keeps the partial-work mark of a granted input, and drops one that is not the host\'s vocabulary', () => {
    const ledger = new RunLedger();
    const runId = dispatched(ledger);
    const grant = (partialWork: unknown) => ({
      attemptId: 'attempt-1', agentId: 'writer', inputId: 'draft', kind: 'upstreamArtifact' as const,
      sourceRef: 'artifact-1-x', suppliedAt: '2026-10-19T10:00:00.000Z', partialWork,
    });
    ledger.recordDelegationEvidence({
      handle: 'h-1', agentId: 'writer', outcome: 'replied-not-verified', evidence: {
        outcome: 'replied-not-verified', changedFiles: [], hadToolActions: false,
        verification: { ran: false, passed: false }, unrecordedWrites: false,
        inputGrants: [
          grant({ completeness: 'incomplete', finalCheck: 'INCOMPLETE: missing close' }),
          { ...grant({ completeness: 'done', finalCheck: 'x' }), inputId: 'other' },
        ],
      } as any,
    });
    const restored = new RunLedger(ledger.snapshot()).get(runId)!.delegations[0].evidence!.inputGrants!;
    expect(restored[0].partialWork).toEqual({ completeness: 'incomplete', finalCheck: 'INCOMPLETE: missing close' });
    expect(restored[1]).not.toHaveProperty('partialWork');
    // Section titles and the final-check prose stay out of portable evidence.
    const exported = JSON.stringify(buildPortableRunEvidence(new RunLedger(ledger.snapshot()).get(runId)!));
    expect(exported).not.toContain('Introduction');
    expect(exported).not.toContain('INCOMPLETE: missing close');
  });
});
