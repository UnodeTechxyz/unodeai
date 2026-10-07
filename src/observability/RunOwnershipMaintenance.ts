import {
  RUN_OWNER_LEASE_MS,
  RunLedger,
  type RunOwnershipReconciliationDecision,
} from './RunLedger';
import type { DelegationInterruptionEvent } from '../backend/TeamTools';

export const RUN_OWNER_HEARTBEAT_INTERVAL_MS = 5_000;

export interface RunOwnershipMaintenanceState {
  previousTickAtMs: number;
}

export interface RunOwnershipMaintenanceResult {
  skipped?: 'idle' | 'host-stall';
  interruptions: DelegationInterruptionEvent[];
  decisions: RunOwnershipReconciliationDecision[];
}

/**
 * Refresh one host's ownership view. A process that has itself stalled cannot safely judge another
 * process's lease, so its first resumed tick renews only its own rows and does not read shared shards.
 */
export async function maintainRunOwnershipTick(
  ledger: RunLedger,
  loadRuns: (observedAt?: string) => Promise<readonly unknown[]>,
  state: RunOwnershipMaintenanceState,
  observedAt = new Date().toISOString(),
  heartbeatIntervalMs = RUN_OWNER_HEARTBEAT_INTERVAL_MS,
  ownerLeaseMs = RUN_OWNER_LEASE_MS,
): Promise<RunOwnershipMaintenanceResult> {
  const observedAtMs = Date.parse(observedAt);
  const elapsedMs = Number.isFinite(observedAtMs)
    ? observedAtMs - state.previousTickAtMs
    : 0;
  if (Number.isFinite(observedAtMs)) state.previousTickAtMs = observedAtMs;

  if (elapsedMs > heartbeatIntervalMs + ownerLeaseMs) {
    ledger.recordHostHeartbeat(observedAt);
    return { skipped: 'host-stall', interruptions: [], decisions: [] };
  }
  if (!ledger.hasActiveDelegations()) {
    return { skipped: 'idle', interruptions: [], decisions: [] };
  }

  // Publish this process's liveness in memory before considering foreign rows. The host-aware merge
  // keeps these locally-owned rows authoritative over a terminal stamp from a stalled observer.
  ledger.recordHostHeartbeat(observedAt);
  ledger.snapshotForPersistence(await loadRuns(observedAt));
  const decisions: RunOwnershipReconciliationDecision[] = [];
  const interruptions = ledger.reconcileRestoredActiveDelegations(
    observedAt,
    (decision) => decisions.push(decision),
  );
  return { interruptions, decisions };
}
