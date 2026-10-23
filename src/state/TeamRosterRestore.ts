/** Host operations needed to replace one active roster without exposing SessionManager internals. */
export interface TeamRosterRestoreOps<T> {
  current(): readonly T[];
  removeAll(): Promise<void>;
  createLoaded(member: T): void;
  createRollback(member: T): void;
  persist(): Promise<void>;
}

/**
 * Replace a roster as a transaction from the user's point of view.
 *
 * Validation and the outgoing snapshot happen before this boundary. If any removal, creation, or persistence
 * step fails, partial loaded members are removed and the exact outgoing configs are rebuilt and persisted.
 */
export async function restoreTeamRoster<T>(members: readonly T[], ops: TeamRosterRestoreOps<T>): Promise<void> {
  const outgoing = [...ops.current()];
  try {
    await ops.removeAll();
    for (const member of members) ops.createLoaded(member);
    await ops.persist();
  } catch (restoreError) {
    try {
      await ops.removeAll();
      for (const member of outgoing) ops.createRollback(member);
      await ops.persist();
    } catch (rollbackError) {
      throw new Error(
        `Could not load the saved team, and restoring the previous roster also failed: ${String(rollbackError)}. `
        + `Original error: ${String(restoreError)}`,
      );
    }
    throw restoreError;
  }
}
