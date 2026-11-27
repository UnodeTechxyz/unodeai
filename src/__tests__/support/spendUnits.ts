/**
 * v0.9.104 D0.4: the spend-unit helpers of the activation flows, shared by the files the former single flow file
 * was split into. Moved unchanged from ActivatedExtension.flows.test.ts.
 */
import { SpendCoordinator } from '../../host/SpendCoordinator';
import { spendEventId } from '../../models/spend/SpendTypes';

/**
 * The spend units recorded before a test, and the requests they belong to. A unit recorded later for one of those
 * requests is an earlier test's turn settling late (seen under the full suite's load on Node 22, 2026-11-15: a PM turn
 * of the previous flow was counted as request B's); it is never this test's, whose requests all start after the
 * snapshot.
 */
export const snapshotOf = (units: Array<{ usageUnitId: string; requestId: string }>) =>
  new Set([...units.map((unit) => unit.usageUnitId), ...units.map((unit) => `request:${unit.requestId}`)]);
export const unitsSince = <T extends { usageUnitId: string; requestId: string }>(units: T[], before: Set<string>) =>
  units.filter((unit) => !before.has(unit.usageUnitId) && !before.has(`request:${unit.requestId}`));
/**
 * This test's units once every agent has the number of units the test expects, or the wall-clock deadline passed. A quiet
 * moment is not completion: a ledger write can be delayed for seconds under load (Codex's audit of 0764d572). A unit
 * missing, or charged to an earlier request and so left out, never lets the count arrive, and the caller's exact
 * assertion then fails.
 */
export const unitsReaching = async <T extends { usageUnitId: string; requestId: string; agentId: string }>(
  read: () => T[], before: Set<string>, expected: Record<string, number>, deadlineMs = 30_000,
) => {
  const want = JSON.stringify(Object.entries(expected).sort());
  const deadline = Date.now() + deadlineMs;
  let units = unitsSince(read(), before);
  while (JSON.stringify(Object.entries(perAgent(units)).sort()) !== want && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    units = unitsSince(read(), before);
  }
  return units;
};
/**
 * v0.9.105 (nightly 44028065080; Codex's audit of 4c23e140, N1): every request begun in this process so far, read where
 * it begins in memory rather than from the ledger on disk. An earlier test's request can have all of its units written
 * after the next test took its snapshot (seen: four units of the previous flow's request, written 2.5 s into the next
 * one). A snapshot read from disk then names neither those units nor their request, and they were counted as the next
 * test's. A request is begun, and each of its units is begun, before any of its units is written, so a snapshot that
 * names every request begun before the test leaves out every later unit of an earlier test, however late it is written.
 * A unit of this test charged to an earlier request is left out as before, and the exact count then comes up short.
 *
 * Install it once per file, before the file's first request; `snapshot()` is a test's `before`.
 */
export const trackBegunRequests = () => {
  const proto = SpendCoordinator.prototype;
  const { beginRequest, beginUsageUnit } = proto;
  const begun = new Set<string>();
  // Stored as the ledger stores it: an id outside the event schema's character set is stored hashed.
  proto.beginRequest = function (this: SpendCoordinator, requestId, rootAgentId) {
    begun.add(spendEventId(requestId, 'id'));
    return beginRequest.call(this, requestId, rootAgentId);
  };
  proto.beginUsageUnit = function (this: SpendCoordinator, unit) {
    begun.add(spendEventId(unit.requestId, 'id'));
    return beginUsageUnit.call(this, unit);
  };
  return {
    /** The units already in the ledger and every request begun so far, for `unitsSince` and `unitsReaching`. */
    snapshot: (units: Array<{ usageUnitId: string; requestId: string }>) =>
      new Set([...snapshotOf(units), ...[...begun].map((requestId) => `request:${requestId}`)]),
    restore: () => { proto.beginRequest = beginRequest; proto.beginUsageUnit = beginUsageUnit; },
  };
};
/** How many units each agent has. */
export const perAgent = (units: Array<{ agentId: string }>) =>
  units.reduce((counts, unit) => ({ ...counts, [unit.agentId]: (counts[unit.agentId] ?? 0) + 1 }), {} as Record<string, number>);
