import { describe, expect, it } from 'vitest';
import type { DelegationEvidenceRecord } from '../../backend/TeamTools';
import type { ReviewEvidenceState } from '../../backend/ReviewEvidence';
import { renderRunEvidencePack } from '../RunEvidencePack';
import { RunLedger } from '../RunLedger';

/**
 * v0.9.94: what a review's evidence came to is a count-only record. The ledger keeps it through the strict reader
 * of that record, on the way in and on every restore, so it survives a reload and reaches the evidence pack. A
 * stored value the reader does not accept is left out: no record, never a repaired or a stronger one.
 */

const CHECKED: ReviewEvidenceState = {
  schemaVersion: 1,
  state: 'citations-checked',
  receipt: {
    schemaVersion: 1,
    findings: { observed: { total: 1, cited: 1 }, 'source-traced': { total: 1, cited: 1 }, inferred: { total: 2, cited: 0 } },
    citations: 4,
    citedFiles: 3,
    searches: { complete: 1, partial: 1 },
    citedSearchCoverage: 'partial',
    reportedCoverage: 'partial',
  },
};
const NOT_SUBMITTED: ReviewEvidenceState = { schemaVersion: 1, state: 'not-submitted' };

const settled: DelegationEvidenceRecord = {
  outcome: 'tool-activity-recorded',
  completionState: 'complete',
  changedFiles: [],
  hadToolActions: true,
  verification: { ran: false, passed: false },
  unrecordedWrites: false,
};

/** A ledger with one settled review delegation whose evidence record is `recorded`, written through the ledger. */
function ledgerWith(recorded: unknown): RunLedger {
  const ledger = new RunLedger();
  ledger.recordDelegationDispatched({
    coordinatorId: 'pm', handle: 'review-handle', requestedAgent: 'reviewer', agentId: 'reviewer',
    instruction: 'Review the artifact.', originCorrelationId: 'root-review',
  });
  ledger.recordDelegationEvidence({
    handle: 'review-handle', agentId: 'reviewer', outcome: 'tool-activity-recorded',
    evidence: { ...settled, ...(recorded === undefined ? {} : { reviewEvidence: recorded as ReviewEvidenceState }) },
  });
  return ledger;
}

/** What workspace storage hands back: the snapshot as JSON, with nothing of the live objects left. */
function stored(ledger: RunLedger): unknown[] {
  return JSON.parse(JSON.stringify(ledger.snapshot()));
}

/** A stored ledger whose one delegation carries `raw` as its review evidence, as a hand-edited or older file could. */
function storedWith(raw: unknown): unknown[] {
  const records = stored(ledgerWith(CHECKED)) as Array<{ delegations: Array<{ evidence: Record<string, unknown> }> }>;
  records[0].delegations[0].evidence.reviewEvidence = raw;
  return JSON.parse(JSON.stringify(records));
}

const evidenceOf = (ledger: RunLedger) => ledger.snapshot()[0].delegations[0].evidence!;

describe('review evidence in the run ledger', () => {
  it('keeps a checked record through store and reload, exactly as it was recorded', () => {
    const ledger = ledgerWith(CHECKED);
    expect(evidenceOf(ledger).reviewEvidence).toEqual(CHECKED);

    // Mutation: a ledger that drops the field on the way in or on restore has nothing left here.
    const reloaded = new RunLedger(stored(ledger));
    expect(evidenceOf(reloaded).reviewEvidence).toEqual(CHECKED);
    // A second store and reload changes nothing, and neither does the merge made before each whole-array write.
    expect(evidenceOf(new RunLedger(stored(reloaded))).reviewEvidence).toEqual(CHECKED);
    expect(new RunLedger().snapshotForPersistence(stored(ledger))[0].delegations[0].evidence?.reviewEvidence).toEqual(CHECKED);
    expect(reloaded.snapshotForPersistence(stored(ledger))[0].delegations[0].evidence?.reviewEvidence).toEqual(CHECKED);
  });

  it('keeps not-submitted as its own record, and never turns it into a checked one', () => {
    const reloaded = new RunLedger(stored(ledgerWith(NOT_SUBMITTED)));

    expect(evidenceOf(reloaded).reviewEvidence).toEqual(NOT_SUBMITTED);
    expect(evidenceOf(reloaded).reviewEvidence).not.toHaveProperty('receipt');
  });

  it('loads a ledger written before the record existed, with no record for its delegations', () => {
    const legacy = stored(ledgerWith(undefined));
    expect(JSON.stringify(legacy)).not.toContain('reviewEvidence');

    const reloaded = new RunLedger(legacy);
    const [run] = reloaded.snapshot();
    expect(run.delegations[0]).toMatchObject({ handle: 'review-handle', state: 'settled', evidence: { outcome: 'tool-activity-recorded' } });
    // No record is no record: it is not read as "not submitted", which only an admitted review can be.
    expect(run.delegations[0].evidence).not.toHaveProperty('reviewEvidence');
    expect(renderRunEvidencePack(run)).not.toContain('Review evidence');
  });

  const { receipt } = CHECKED as Extract<ReviewEvidenceState, { state: 'citations-checked' }>;
  it.each<[string, unknown]>([
    ['a string', 'citations-checked'],
    ['an empty object', {}],
    ['another schema version', { ...CHECKED, schemaVersion: 2 }],
    ['a state it does not know', { schemaVersion: 1, state: 'verified', receipt }],
    ['the state name used before this record was kept', { schemaVersion: 1, state: 'validated', receipt }],
    ['a checked state with no receipt', { schemaVersion: 1, state: 'citations-checked' }],
    ['an unknown key beside the state', { ...CHECKED, reviewer: 'model-x' }],
    ['an unknown key inside the receipt', { ...CHECKED, receipt: { ...receipt, statements: ['SENTINEL-FINDING-TEXT'] } }],
    ['"not submitted" carrying a receipt', { ...NOT_SUBMITTED, receipt }],
    ['a coverage under the name that hid whose statement it is', { ...CHECKED, receipt: { ...receipt, reportedCoverage: undefined, coverage: 'complete' } }],
    ['a count that is not a whole number', { ...CHECKED, receipt: { ...receipt, citations: '4' } }],
    ['an observed finding recorded without a citation', { ...CHECKED, receipt: { ...receipt, findings: { ...receipt.findings, observed: { total: 2, cited: 1 } } } }],
    ['complete coverage reported over a cited partial search', { ...CHECKED, receipt: { ...receipt, reportedCoverage: 'complete' } }],
    ['a cited-search coverage its counts do not support', { ...CHECKED, receipt: { ...receipt, citedSearchCoverage: 'complete' } }],
  ])('leaves out a stored record that is %s, and still loads the delegation', (_label, raw) => {
    const reloaded = new RunLedger(storedWith(raw));
    const [run] = reloaded.snapshot();

    // Mutation: a ledger that takes the stored value as it stands keeps every one of these.
    expect(run.delegations[0].evidence).not.toHaveProperty('reviewEvidence');
    expect(run.delegations[0]).toMatchObject({ handle: 'review-handle', state: 'settled', evidence: { outcome: 'tool-activity-recorded', hadToolActions: true } });
    expect(JSON.stringify(run)).not.toContain('SENTINEL-FINDING-TEXT');
    expect(renderRunEvidencePack(run)).not.toContain('Review evidence');
  });

  it('reads a stored record through the strict reader and keeps none that it refuses', () => {
    // One stored record with a key the reader does not know and a coverage the host refuses at submission. Taken
    // as it stands it would be the strongest record there is: checked, complete, and carrying a finding's text.
    const raw = { ...CHECKED, receipt: { ...receipt, reportedCoverage: 'complete', statements: ['SENTINEL-FINDING-TEXT'] } };
    const [run] = new RunLedger(storedWith(raw)).snapshot();

    expect(run.delegations[0].evidence).not.toHaveProperty('reviewEvidence');
    expect(JSON.stringify(run)).not.toContain('SENTINEL-FINDING-TEXT');
    // Nothing weaker is put in its place either: the record is absent, and the rest of the delegation is intact.
    expect(run.delegations[0]).toMatchObject({ handle: 'review-handle', state: 'settled', evidence: { outcome: 'tool-activity-recorded' } });
    expect(new RunLedger(storedWith(CHECKED)).snapshot()[0].delegations[0].evidence?.reviewEvidence).toEqual(CHECKED);
  });

  it('applies the same reader to a record handed over at settlement', () => {
    // The host derives this record itself. The ledger still does not take a malformed one on trust.
    const forged = ledgerWith({ ...CHECKED, receipt: { ...receipt, reportedCoverage: 'complete', statements: ['SENTINEL-FINDING-TEXT'] } });

    expect(evidenceOf(forged)).not.toHaveProperty('reviewEvidence');
    expect(JSON.stringify(forged.snapshot())).not.toContain('SENTINEL-FINDING-TEXT');
  });

  it('holds counts and fixed words only, after a reload too', () => {
    const [run] = new RunLedger(stored(ledgerWith(CHECKED))).snapshot();
    const values: unknown[] = [];
    JSON.stringify(run.delegations[0].evidence!.reviewEvidence, (_key, value) => {
      if (typeof value !== 'object') values.push(value);
      return value;
    });

    expect(values.length).toBeGreaterThan(10);
    expect(values.every((value) => typeof value === 'number'
      || ['citations-checked', 'complete', 'partial', 'none'].includes(String(value)))).toBe(true);
  });

  it('prints the record in the evidence pack in the sentence the host wrote, after a reload', () => {
    const [run] = new RunLedger(stored(ledgerWith(CHECKED))).snapshot();
    const pack = renderRunEvidencePack(run, '2026-10-08T09:00:00.000Z');

    expect(pack).toContain(
      '- Review evidence (host record): citations checked by the host. 4 findings: 1 observed (1 cited), 1 source-traced (1 cited), '
      + '2 inferred (0 cited); 4 citations in 3 files; 2 searches cited (1 partial). '
      + 'The reviewer reported overall coverage partial; the host did not check that. '
      + 'The host checked that each cited receipt belongs to this attempt and that each cited line was displayed to the reviewer. '
      + 'It did not check that a finding is correct or that the review covered everything.',
    );

    const [unsubmitted] = new RunLedger(stored(ledgerWith(NOT_SUBMITTED))).snapshot();
    expect(renderRunEvidencePack(unsubmitted)).toContain(
      '- Review evidence (host record): not submitted. The host recorded no checked citation and no cited search for this review; the findings are prose only.',
    );
  });
});
