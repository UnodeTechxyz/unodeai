// How partitioned warm coordinators split the cases they share: by estimated time, not by count.
//
// v0.9.100's PR CI showed why. The two shares held 702 and 691 main cases, but the first took 1081 s of worker time
// and the second 560 s, because the slow proof files (4-15 s a case) all fell to one side. The first coordinator
// also judges the sensors alone. It finished 260 s after the second, which stopped waiting at 240 s.
//
// The estimate comes from a checked-in table of measured times (mutation-proof-costs.json). Every coordinator
// computes the same split from the same table and the same manifests, so the shares are disjoint and together
// complete; the aggregator checks that they are. A stale or incomplete table can only make the split less even.
//
// v0.9.104's tag run showed the next gap. Every share was estimated at 908 s, but the three took 1351, 913 and 2294 s
// of worker time: a proof file's baseline was counted as one more case, while some baselines take 30-130 s (the
// activation flows). The table now also keeps each file's measured baseline time, and the estimate uses it.

export const PROOF_COSTS_SCHEMA = 'unode-mutation-proof-costs/v1';

/** Check a cost table and return it with the median per-case time, used for a proof file the table does not name. */
export function validateProofCosts(table) {
  if (table?.schema !== PROOF_COSTS_SCHEMA) throw new Error(`Proof cost table schema must be ${PROOF_COSTS_SCHEMA}.`);
  const positive = (value) => Number.isSafeInteger(value) && value > 0;
  const perCase = Object.entries(table.perCaseMs ?? {});
  if (perCase.length === 0) throw new Error('Proof cost table names no proof file.');
  for (const [file, ms] of perCase) {
    if (!/^src\/.+\.test\.ts$/.test(file) || !positive(ms)) throw new Error(`Proof cost table entry ${file} must be a src/ test file with a positive whole number of ms.`);
  }
  for (const [group, ms] of Object.entries(table.auxiliaryMs ?? {})) {
    if (!positive(ms)) throw new Error(`Proof cost table auxiliary ${group} must be a positive whole number of ms.`);
  }
  for (const [file, ms] of Object.entries(table.baselineMs ?? {})) {
    if (!/^src\/.+\.test\.ts$/.test(file) || !positive(ms)) throw new Error(`Proof cost table baseline ${file} must be a src/ test file with a positive whole number of ms.`);
  }
  const sorted = perCase.map(([, ms]) => ms).sort((left, right) => left - right);
  return {
    perCaseMs: table.perCaseMs,
    baselineMs: table.baselineMs ?? {},
    auxiliaryMs: table.auxiliaryMs ?? {},
    medianPerCaseMs: sorted[Math.floor(sorted.length / 2)],
  };
}

/**
 * Split `items` (each with a `testFile`) between `count` partitions. A proof file stays whole, since its baseline
 * runs where its cases are judged; it costs one run per case plus that baseline: its measured baseline time when the
 * table has one, otherwise one more case. The costliest file goes first, each
 * to the partition with the least estimated time so far; `preloadMs` is time a partition spends on work it does
 * alone. Ties break by file name and then by the lower partition, so the result depends on nothing else.
 */
export function costPartition(items, { count, costs, preloadMs = [] }) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('A partition count must be a positive integer.');
  const units = new Map();
  for (const item of items) {
    const unit = units.get(item.testFile) ?? { testFile: item.testFile, items: [] };
    unit.items.push(item);
    units.set(item.testFile, unit);
  }
  const estimate = (unit) => {
    const perCase = costs.perCaseMs[unit.testFile] ?? costs.medianPerCaseMs;
    return (costs.baselineMs?.[unit.testFile] ?? perCase) + perCase * unit.items.length;
  };
  const ordered = [...units.values()].map((unit) => ({ ...unit, ms: estimate(unit) }))
    .sort((left, right) => right.ms - left.ms || (left.testFile < right.testFile ? -1 : left.testFile > right.testFile ? 1 : 0));
  const totals = Array.from({ length: count }, (_, index) => preloadMs[index] ?? 0);
  const shares = Array.from({ length: count }, () => []);
  for (const unit of ordered) {
    const target = totals.indexOf(Math.min(...totals));
    totals[target] += unit.ms;
    shares[target].push(...unit.items);
  }
  return { shares, estimatedMs: totals };
}
