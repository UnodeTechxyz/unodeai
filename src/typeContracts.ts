import type { RunCloseoutCompletionState } from './types';
import type { RunRecord } from './observability/RunLedger';

type Assert<T extends true> = T;

/** Compile-time proof: a closed run can never claim the absence of a terminal observation. */
export type RunCloseoutCompletionStateExcludesNotObserved = Assert<
  'not-observed' extends RunCloseoutCompletionState ? false : true
>;

/** normalizeRun always supplies this array to the in-memory RunRecord, including for old persisted rows. */
export type RunRecordContentReceiptsAreTotal = Assert<
  undefined extends RunRecord['contentReceipts'] ? false : true
>;

export type RunRecordOutcomeRepairsAreTotal = Assert<
  undefined extends RunRecord['outcomeRepairs'] ? false : true
>;

export type RunRecordVerdictsAreTotal = Assert<
  undefined extends RunRecord['verdicts'] ? false : true
>;

export type RunRecordReviewObservationsAreTotal = Assert<
  undefined extends RunRecord['reviewObservations'] ? false : true
>;
