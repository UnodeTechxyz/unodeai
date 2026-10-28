/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Accountability anchor (v0.9.94)
 *  Where a host-observed card stands in a conversation: after which turn, and which card it is. One kind of
 *  anchor places both cards, the Request summary and the Job outcome, so one rule decides between them.
 *
 *  A turn shows at most one card. When a turn closes a coordinated run, the run's Job outcome is that card and
 *  the turn's Request summary is not shown. An anchor names a turn by its exact id and never a position, a
 *  time or a neighbouring message, so a later reply cannot take a card or move one.
 *--------------------------------------------------------------------------------------------*/
import { JOB_OUTCOME_ANCHOR_LIMIT, type JobOutcomeAnchorEntry } from './JobOutcomeAnchor';
import type { RequestCloseoutRecordV1 } from './RequestCloseout';

/** Cards of both kinds that one conversation shows. Conflicts are kept first, then the newest. */
export const ACCOUNTABILITY_ANCHOR_LIMIT = JOB_OUTCOME_ANCHOR_LIMIT;

export type AccountabilityAnchorKind = 'request-summary' | 'job-outcome';

export interface AccountabilityAnchorV1 {
  schemaVersion: 1;
  anchorId: string;
  kind: AccountabilityAnchorKind;
  /**
   * `assistant-turn`: the card follows the reply that ended the turn. `user-turn`: the turn ended with no
   * reply, and the card follows the host's own terminal item for the request that began it.
   */
  target: { kind: 'assistant-turn' | 'user-turn'; turnId: string };
  requestId?: string;
  runId?: string;
  revision: number;
}

/** An anchor with what the bound needs: when its card was recorded, and whether it is a conflict that must stay. */
export interface AccountabilityAnchorCandidate {
  anchor: AccountabilityAnchorV1;
  recordedAt?: string;
  conflict?: boolean;
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** The anchor of one request closeout. A turn that delivered a reply is followed at that reply. */
export function requestSummaryAnchor(record: RequestCloseoutRecordV1): AccountabilityAnchorCandidate {
  return {
    anchor: {
      schemaVersion: 1,
      anchorId: record.recordId,
      kind: 'request-summary',
      target: { kind: record.terminal.kind === 'answered' ? 'assistant-turn' : 'user-turn', turnId: record.terminalTurnId },
      requestId: record.requestId,
      ...(record.observations.run ? { runId: record.observations.run.runId } : {}),
      revision: record.revision,
    },
    recordedAt: record.recordedAt,
  };
}

/**
 * The anchor of a Job outcome entry. `closedWithoutReply` is the host's knowledge that the run's closing turn
 * ended with no reply of its coordinator, as when the person stopped the coordinator before its first reply.
 * An entry in conflict that kept no turn has no place and no anchor.
 */
export function jobOutcomeAccountabilityAnchor(
  entry: JobOutcomeAnchorEntry,
  closedWithoutReply = false,
): AccountabilityAnchorCandidate | undefined {
  const turnId = entry.state === 'anchored' ? entry.anchor.afterTurnId : entry.afterTurnId;
  if (!turnId || !ID.test(turnId)) return undefined;
  return {
    anchor: {
      schemaVersion: 1,
      anchorId: entry.state === 'anchored' ? entry.anchor.id : entry.id,
      kind: 'job-outcome',
      target: { kind: closedWithoutReply ? 'user-turn' : 'assistant-turn', turnId },
      runId: entry.state === 'anchored' ? entry.anchor.runId : entry.runId,
      revision: 1,
    },
    ...(entry.state === 'anchored' ? { recordedAt: entry.anchor.recordedAt } : { conflict: true }),
  };
}

function precedes(left: AccountabilityAnchorV1, right: AccountabilityAnchorV1): boolean {
  if (left.kind !== right.kind) return left.kind === 'job-outcome';
  if (left.revision !== right.revision) return left.revision > right.revision;
  return left.anchorId < right.anchorId;
}

/**
 * One anchor per turn, then the bound. For one turn the Job outcome wins over the Request summary, then the
 * larger revision, then the smaller anchor id: the choice is by value, so it does not depend on the order the
 * candidates arrive in. Under the bound, conflicts are kept first and the newest of the rest fill what is left,
 * which is the rule the Job outcome anchors already follow.
 */
export function arbitrateAccountabilityAnchors(candidates: readonly AccountabilityAnchorCandidate[]): AccountabilityAnchorV1[] {
  const byTurn = new Map<string, AccountabilityAnchorCandidate>();
  for (const candidate of candidates) {
    const held = byTurn.get(candidate.anchor.target.turnId);
    if (!held || precedes(candidate.anchor, held.anchor)) byTurn.set(candidate.anchor.target.turnId, candidate);
  }
  const winners = [...byTurn.values()];
  const byId = (left: AccountabilityAnchorCandidate, right: AccountabilityAnchorCandidate) =>
    (left.anchor.anchorId < right.anchor.anchorId ? -1 : left.anchor.anchorId > right.anchor.anchorId ? 1 : 0);
  const conflicts = winners.filter((candidate) => candidate.conflict).sort(byId);
  const dated = winners.filter((candidate) => !candidate.conflict).sort((left, right) => {
    const difference = time(left.recordedAt) - time(right.recordedAt);
    return difference !== 0 ? difference : byId(left, right);
  });
  const keptConflicts = conflicts.slice(-ACCOUNTABILITY_ANCHOR_LIMIT);
  const room = ACCOUNTABILITY_ANCHOR_LIMIT - keptConflicts.length;
  // slice(-0) is the whole list, so no room is said outright.
  return [...keptConflicts, ...(room > 0 ? dated.slice(-room) : [])].map((candidate) => candidate.anchor);
}

function time(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  // An anchor without a time is the oldest: it is the first to make room.
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
