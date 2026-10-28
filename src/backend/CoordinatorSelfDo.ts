/*---------------------------------------------------------------------------------------------
 *  v0.9.99: a coordinator with teammates may do a small, ready action itself
 *
 *  Before, a coordinator with teammates was refused every write or command until it filed a coordinator-only task
 *  contract, which cost extra model calls without protecting anything its own permissions did not already decide.
 *  Now, with no contract in force, the action runs under the coordinator's own configured authority (folders, write
 *  approval, Commands, Workspace Trust and Plan mode all still apply), and the result carries this reminder so that
 *  larger work is still delegated. A contract the coordinator did file keeps governing what it may do.
 *--------------------------------------------------------------------------------------------*/

/** The reminder appended to a coordinator's own tool result when it acted without a task contract. */
export const COORDINATOR_SELF_DO_REMINDER = '[host reminder] You have teammates. This ran under your own permissions, without a '
  + 'task contract, which suits a small, ready action. Delegate larger or parallel work with dispatch_task.';

/** The host facts the decision reads: whether the coordinator has teammates and the contract it filed, if any. */
export interface CoordinatorSelfDoTeam {
  hasTeammates?(): boolean;
  currentCoordinatorTaskAttempt?(): unknown;
  canCoordinatorExecute?(toolName: string): boolean;
}

/**
 * How a coordinator's own write or command proceeds: `solo` (no teammates, nothing changes), `contract` (its filed
 * contract authorises it), `own-authority` (no contract in force: it runs under the agent's own permissions with the
 * reminder), or `refused` (a contract is in force and does not cover this kind of action).
 */
export function coordinatorSelfDo(team: CoordinatorSelfDoTeam | undefined, toolName: string): 'solo' | 'contract' | 'own-authority' | 'refused' {
  if (!team?.hasTeammates?.()) return 'solo';
  if (team.canCoordinatorExecute?.(toolName) === true) return 'contract';
  return team.currentCoordinatorTaskAttempt?.() ? 'refused' : 'own-authority';
}
