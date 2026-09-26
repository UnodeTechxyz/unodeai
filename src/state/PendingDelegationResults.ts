/*---------------------------------------------------------------------------------------------
 *  UnodeAi - PendingDelegationResults
 *
 *  The durable, already-settled half of a coordinator's async delegation queue.  Live promises
 *  cannot survive an extension-host restart, but a result that has already arrived can.  Keep only
 *  that honest boundary: this is not a job scheduler and it does not pretend to resume workers.
 *--------------------------------------------------------------------------------------------*/

export interface PendingDelegationResult {
  coordinatorId: string;
  handle: string;
  ref: string;
  text: string;
}

/**
 * In-memory authority for the small durable queue. Persistence is intentionally host-owned: callers
 * snapshot this store after a mutation rather than making TeamTools depend on VS Code storage.
 */
export class PendingDelegationResults {
  private readonly entries = new Map<string, PendingDelegationResult>();

  constructor(initial: readonly PendingDelegationResult[] = []) {
    for (const entry of initial) {
      this.remember(entry);
    }
  }

  forCoordinator(coordinatorId: string): PendingDelegationResult[] {
    return this.snapshot().filter((entry) => entry.coordinatorId === coordinatorId);
  }

  remember(entry: PendingDelegationResult): void {
    const normalized = normalize(entry);
    if (!normalized) { return; }
    this.entries.set(keyFor(normalized.coordinatorId, normalized.handle), normalized);
  }

  consume(coordinatorId: string, handle: string): void {
    this.entries.delete(keyFor(coordinatorId, handle));
  }

  snapshot(): PendingDelegationResult[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }
}

function keyFor(coordinatorId: string, handle: string): string {
  return `${coordinatorId}\u0000${handle}`;
}

function normalize(value: PendingDelegationResult): PendingDelegationResult | undefined {
  if (!value || typeof value !== 'object') { return undefined; }
  const coordinatorId = typeof value.coordinatorId === 'string' ? value.coordinatorId.trim() : '';
  const handle = typeof value.handle === 'string' ? value.handle.trim() : '';
  const ref = typeof value.ref === 'string' ? value.ref.trim() : '';
  const text = typeof value.text === 'string' ? value.text : '';
  return coordinatorId && handle && ref && text
    ? { coordinatorId, handle, ref, text }
    : undefined;
}
