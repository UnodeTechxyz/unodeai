/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Run turn entries (v0.9.92)
 *  One entry per ended turn of a coordinated run: who ran it, how it ended, the spend unit the host
 *  opened for it and its host-observed timing. The host writes it on every path that ends a turn, so a
 *  stopped or interrupted turn has one too. A turn with no entry was not recorded; that is never zero.
 *--------------------------------------------------------------------------------------------*/
import { parseTurnTimingPhases, type TurnTiming, type TurnTimingPhases } from '../session/TurnTiming';

export type RunTurnEnding = 'completed' | 'failed' | 'stopped' | 'interrupted';

/**
 * Upserted by `turnId`: the same entry again is a no-op, and a different entry under the same id becomes a conflict
 * that no later write resolves, so no reader can present either version as the turn's facts.
 */
export type RunTurnEntry =
  | {
      state: 'recorded';
      runId: string;
      turnId: string;
      agentId: string;
      /** The turn's thread key; for a delegated turn it is the delegation's handle. */
      correlationId: string;
      ended: RunTurnEnding;
      /** The spend unit the host opened for this turn. Usage is joined to the run through it, by exact id. */
      usageUnitId?: string;
      timing: TurnTiming & { phases: TurnTimingPhases };
    }
  | { state: 'conflict'; runId: string; turnId: string; agentId: string };

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ENDINGS = new Set<RunTurnEnding>(['completed', 'failed', 'stopped', 'interrupted']);

const id = (value: unknown): string | undefined => (typeof value === 'string' && ID.test(value) ? value : undefined);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const instant = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));

/**
 * A timing fact as the tracker builds it, or nothing. The two identities are checked: a stored value whose phases do
 * not add up to its duration is not one this host wrote, and is dropped rather than shown.
 */
function parseRecordedTiming(raw: unknown): (TurnTiming & { phases: TurnTimingPhases }) | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (!instant(value.startedAt) || !instant(value.settledAt) || !count(value.durationMs) || !count(value.approvalWaitMs)) {
    return undefined;
  }
  const phases = parseTurnTimingPhases(value.phases, value.durationMs);
  if (!phases) return undefined;
  if (Date.parse(value.settledAt) - Date.parse(value.startedAt) !== value.durationMs + value.approvalWaitMs) return undefined;
  return {
    startedAt: value.startedAt,
    settledAt: value.settledAt,
    durationMs: value.durationMs,
    approvalWaitMs: value.approvalWaitMs,
    phases,
  };
}

/** One entry rebuilt field by field from an untrusted value: a host event, or a stored row. */
export function parseRunTurnEntry(raw: unknown): RunTurnEntry | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const runId = id(value.runId);
  const turnId = id(value.turnId);
  const agentId = id(value.agentId);
  if (!runId || !turnId || !agentId) return undefined;
  if (value.state === 'conflict') return { state: 'conflict', runId, turnId, agentId };
  if (value.state !== 'recorded') return undefined;
  const correlationId = id(value.correlationId);
  const usageUnitId = value.usageUnitId === undefined ? undefined : id(value.usageUnitId);
  const timing = parseRecordedTiming(value.timing);
  if (!correlationId || !timing || (value.usageUnitId !== undefined && !usageUnitId)) return undefined;
  if (typeof value.ended !== 'string' || !ENDINGS.has(value.ended as RunTurnEnding)) return undefined;
  return {
    state: 'recorded',
    runId,
    turnId,
    agentId,
    correlationId,
    ended: value.ended as RunTurnEnding,
    ...(usageUnitId ? { usageUnitId } : {}),
    timing,
  };
}

/** Stored entries rebuilt one by one; an entry that fails validation is counted, not kept. */
export function normalizeRunTurnEntries(value: unknown, runId: string): { entries: RunTurnEntry[]; invalid: number } {
  if (!Array.isArray(value)) return { entries: [], invalid: 0 };
  const parsed: RunTurnEntry[] = [];
  let invalid = 0;
  for (const raw of value) {
    const entry = parseRunTurnEntry(raw);
    // An entry that names another run does not belong in this record.
    if (entry && entry.runId === runId) parsed.push(entry);
    else invalid++;
  }
  // Folded through the same merge, so a stored duplicate id with other content becomes a conflict too.
  return { entries: mergeRunTurnEntries([], parsed), invalid };
}

/**
 * Set-union by turn id. Equal entries collapse to one; unequal entries under one id, or a conflict on either side,
 * become a conflict that stays. A conflict carries only identity, so every window derives the same one. Entries are
 * kept in turn-id order, so merging two copies in either direction, or merging again, gives the same array.
 */
export function mergeRunTurnEntries(local: readonly RunTurnEntry[], incoming: readonly RunTurnEntry[]): RunTurnEntry[] {
  const entries = local.map((entry) => structuredClone(entry));
  const index = new Map(entries.map((entry, position) => [entry.turnId, position]));
  for (const entry of incoming) {
    const at = index.get(entry.turnId);
    if (at === undefined) {
      index.set(entry.turnId, entries.length);
      entries.push(structuredClone(entry));
      continue;
    }
    const existing = entries[at];
    if (existing.state === 'recorded' && entry.state === 'recorded' && canonical(existing) === canonical(entry)) continue;
    // Chosen by value, never by which copy came first: both merge directions give the same conflict.
    entries[at] = {
      state: 'conflict',
      runId: existing.runId <= entry.runId ? existing.runId : entry.runId,
      turnId: existing.turnId,
      agentId: existing.agentId <= entry.agentId ? existing.agentId : entry.agentId,
    };
  }
  return entries.sort((left, right) => (left.turnId < right.turnId ? -1 : left.turnId > right.turnId ? 1 : 0));
}

/** Key order is fixed by `parseRunTurnEntry`, which builds every entry, so equal entries serialize equally. */
function canonical(entry: RunTurnEntry): string {
  return JSON.stringify(parseRunTurnEntry(entry));
}
