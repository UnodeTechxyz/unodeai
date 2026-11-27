/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Job outcome anchor (v0.9.93)
 *  What Chat keeps of an outcome card: which run it shows and the turn it follows. It holds no figure,
 *  no text and no rendered markup; the card's content is projected from the run every time it is shown.
 *
 *  Every field is a function of the closed run, so any window that sees the run writes the same anchor.
 *  A copy that differs can only come from a damaged or foreign record, and then the card says that its
 *  evidence is unavailable: no copy is chosen.
 *--------------------------------------------------------------------------------------------*/
import { jobOutcomeId, type JobOutcomeId } from './JobOutcome';

/** A coordinator's chat keeps at most this many entries, conflicts included; the oldest anchors by close time go first. */
export const JOB_OUTCOME_ANCHOR_LIMIT = 50;

export interface JobOutcomeAnchorV1 {
  kind: 'job-outcome';
  schemaVersion: 1;
  id: JobOutcomeId;
  runId: string;
  coordinatorId: string;
  /** The coordinator turn that closed the run. The card follows that turn's reply, and has no other position. */
  afterTurnId: string;
  /** When the run closed. */
  recordedAt: string;
}

export type JobOutcomeAnchorEntry =
  | { state: 'anchored'; anchor: JobOutcomeAnchorV1 }
  /** Copies under one id disagreed. It keeps the position only when every copy named the same turn. */
  | { state: 'conflict'; id: JobOutcomeId; runId: string; coordinatorId: string; afterTurnId?: string };

/** What an anchor is computed from: the closed run's identity, its closing turn and its close time. */
export interface ClosedRunAnchorFacts {
  runId: string;
  coordinatorId: string;
  closingTurnId: string;
  endedAt: string;
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const AGENT_ID = /^[^\u0000-\u001f]{1,200}$/;

function instant(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

/** The anchor of a closed run. A run without a closing turn has none: its card is not placed by a guess. */
export function jobOutcomeAnchor(facts: ClosedRunAnchorFacts): JobOutcomeAnchorV1 | undefined {
  if (!ID.test(facts.runId) || !AGENT_ID.test(facts.coordinatorId) || !ID.test(facts.closingTurnId) || !instant(facts.endedAt)) {
    return undefined;
  }
  return {
    kind: 'job-outcome',
    schemaVersion: 1,
    id: jobOutcomeId(facts.runId),
    runId: facts.runId,
    coordinatorId: facts.coordinatorId,
    afterTurnId: facts.closingTurnId,
    recordedAt: facts.endedAt,
  };
}

/** One stored entry rebuilt field by field. An entry whose id is not the id of its own run is not an entry. */
export function parseJobOutcomeAnchorEntry(raw: unknown): JobOutcomeAnchorEntry | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.state === 'anchored') {
    const stored = value.anchor as Record<string, unknown> | undefined;
    if (!stored || typeof stored !== 'object' || stored.kind !== 'job-outcome' || stored.schemaVersion !== 1) return undefined;
    if (typeof stored.runId !== 'string' || typeof stored.coordinatorId !== 'string'
        || typeof stored.afterTurnId !== 'string' || typeof stored.recordedAt !== 'string') {
      return undefined;
    }
    const anchor = jobOutcomeAnchor({
      runId: stored.runId, coordinatorId: stored.coordinatorId, closingTurnId: stored.afterTurnId, endedAt: stored.recordedAt,
    });
    return anchor && stored.id === anchor.id ? { state: 'anchored', anchor } : undefined;
  }
  if (value.state === 'conflict') {
    if (typeof value.runId !== 'string' || !ID.test(value.runId)
        || typeof value.coordinatorId !== 'string' || !AGENT_ID.test(value.coordinatorId)
        || value.id !== jobOutcomeId(value.runId)) {
      return undefined;
    }
    return {
      state: 'conflict',
      id: jobOutcomeId(value.runId),
      runId: value.runId,
      coordinatorId: value.coordinatorId,
      ...(typeof value.afterTurnId === 'string' && ID.test(value.afterTurnId) ? { afterTurnId: value.afterTurnId } : {}),
    };
  }
  return undefined;
}

export function anchorEntryId(entry: JobOutcomeAnchorEntry): JobOutcomeId {
  return entry.state === 'anchored' ? entry.anchor.id : entry.id;
}

function entryTurn(entry: JobOutcomeAnchorEntry): string | undefined {
  return entry.state === 'anchored' ? entry.anchor.afterTurnId : entry.afterTurnId;
}

function canonical(entry: JobOutcomeAnchorEntry): string {
  return JSON.stringify(parseJobOutcomeAnchorEntry(entry));
}

/**
 * Set-union by id. Equal copies are one entry: writing an anchor again changes nothing. Unequal copies, or a
 * conflict on either side, become a conflict that stays. Its fields are chosen by value, never by which copy came
 * first, so merging in either direction, or again, gives the same list. The list is kept in close-time order;
 * conflicts carry no time and are kept in id order before the rest.
 *
 * One bound holds for the whole list. Conflicts are kept first and the newest anchors fill what is left: a
 * conflict has no close time to age by, and one that was dropped would come back from the run as an ordinary
 * anchor, which is the choice between copies that a conflict exists to refuse.
 */
export function mergeJobOutcomeAnchors(
  local: readonly JobOutcomeAnchorEntry[],
  incoming: readonly JobOutcomeAnchorEntry[],
): JobOutcomeAnchorEntry[] {
  const byId = new Map<string, JobOutcomeAnchorEntry>();
  for (const entry of [...local, ...incoming]) {
    const id = anchorEntryId(entry);
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, structuredClone(entry));
      continue;
    }
    if (existing.state === 'anchored' && entry.state === 'anchored' && canonical(existing) === canonical(entry)) continue;
    const runId = existing.state === 'anchored' ? existing.anchor.runId : existing.runId;
    const coordinators = [existing, entry].map((copy) => (copy.state === 'anchored' ? copy.anchor.coordinatorId : copy.coordinatorId)).sort();
    const turns = [entryTurn(existing), entryTurn(entry)];
    byId.set(id, {
      state: 'conflict',
      id: jobOutcomeId(runId),
      runId,
      coordinatorId: coordinators[0],
      ...(turns[0] !== undefined && turns[0] === turns[1] ? { afterTurnId: turns[0] } : {}),
    });
  }
  const entries = [...byId.values()];
  const conflicts = entries.filter((entry) => entry.state === 'conflict')
    .sort((left, right) => (anchorEntryId(left) < anchorEntryId(right) ? -1 : anchorEntryId(left) > anchorEntryId(right) ? 1 : 0));
  const anchored = entries
    .filter((entry): entry is Extract<JobOutcomeAnchorEntry, { state: 'anchored' }> => entry.state === 'anchored')
    .sort((left, right) => {
      const difference = Date.parse(left.anchor.recordedAt) - Date.parse(right.anchor.recordedAt);
      if (difference !== 0) return difference;
      return left.anchor.id < right.anchor.id ? -1 : left.anchor.id > right.anchor.id ? 1 : 0;
    });
  const keptConflicts = conflicts.slice(-JOB_OUTCOME_ANCHOR_LIMIT);
  const room = JOB_OUTCOME_ANCHOR_LIMIT - keptConflicts.length;
  // slice(-0) is the whole list, so no room is said outright.
  return [...keptConflicts, ...(room > 0 ? anchored.slice(-room) : [])];
}

/** Stored anchors of one coordinator's chat, rebuilt one by one. An entry of another coordinator is not kept. */
export function deserializeJobOutcomeAnchors(value: unknown, coordinatorId: string): JobOutcomeAnchorEntry[] {
  if (!Array.isArray(value)) return [];
  const parsed: JobOutcomeAnchorEntry[] = [];
  for (const raw of value) {
    const entry = parseJobOutcomeAnchorEntry(raw);
    if (!entry) continue;
    const owner = entry.state === 'anchored' ? entry.anchor.coordinatorId : entry.coordinatorId;
    if (owner === coordinatorId) parsed.push(entry);
  }
  // Folded through the same merge, so a stored duplicate id with other content is a conflict too.
  return mergeJobOutcomeAnchors([], parsed);
}

export function sameJobOutcomeAnchors(left: readonly JobOutcomeAnchorEntry[], right: readonly JobOutcomeAnchorEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => canonical(entry) === canonical(right[index]));
}
