/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Job outcome usage adapter (v0.9.93)
 *  Reads the spend authority for the projector: one usage unit by its exact id. It selects nothing by
 *  run id, time or agent, and it prices nothing: amounts are the ones the spend records already hold.
 *--------------------------------------------------------------------------------------------*/
import type { AggregateResult, DisplayClass } from '../models/spend/SpendAggregate';
import { nanoToString } from '../models/spend/Money';
import type { JobUsageLookup, JobUsageRow, JobUsageUnitFacts } from './JobOutcome';

/** A lookup over one aggregate of the durable spend events. The aggregate is read, never changed. */
export function jobUsageLookup(aggregate: AggregateResult): JobUsageLookup {
  const byUnit = new Map<string, JobUsageUnitFacts>();
  for (const [usageUnitId, unit] of aggregate.units) {
    byUnit.set(usageUnitId, {
      state: unit.state,
      quarantined: aggregate.quarantined.has(usageUnitId),
      unattributed: false,
      rows: [],
    });
  }
  const rows = new Map<string, Map<DisplayClass, { input: number; cached: number; output: number; nano?: bigint; unpriced: boolean }>>();
  for (const contribution of aggregate.contributions) {
    const facts = byUnit.get(contribution.usageUnitId);
    if (!facts) continue;
    if (contribution.unattributed) facts.unattributed = true;
    const unitRows = rows.get(contribution.usageUnitId) ?? new Map();
    rows.set(contribution.usageUnitId, unitRows);
    const row = unitRows.get(contribution.displayClass) ?? { input: 0, cached: 0, output: 0, unpriced: false };
    row.input += contribution.inputTokens;
    row.cached += contribution.cachedInputTokens;
    row.output += contribution.outputTokens;
    if (contribution.displayNano === undefined) row.unpriced = true;
    else row.nano = (row.nano ?? 0n) + contribution.displayNano;
    unitRows.set(contribution.displayClass, row);
  }
  for (const [usageUnitId, unitRows] of rows) {
    const facts = byUnit.get(usageUnitId)!;
    facts.rows = [...unitRows.entries()].map(([displayClass, row]): JobUsageRow => ({
      displayClass,
      inputTokens: row.input,
      cachedInputTokens: row.cached,
      outputTokens: row.output,
      // A basis with an unpriced part has no amount: part of a sum would read as the whole.
      ...(row.nano !== undefined && !row.unpriced ? { nanoUsd: nanoToString(row.nano) } : {}),
    }));
  }
  return (usageUnitId) => {
    const facts = byUnit.get(usageUnitId);
    return facts ? structuredClone(facts) : undefined;
  };
}

/** For a host without a spend authority (a folderless window, a test): every unit is unknown. */
export const noJobUsage: JobUsageLookup = () => undefined;
