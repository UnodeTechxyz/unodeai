/** The useful destination selected by the setup wizard's explicit Finish action. */
export type FirstRunDestination = 'team-panel' | 'chat';

/**
 * Never send a new user without agents to an empty Workbench. With a team, the existing chat command
 * remains the one routing point because it already honours `unode.workbench.autoOpen`.
 */
export function firstRunDestination(agentCount: number): FirstRunDestination {
  return agentCount > 0 ? 'chat' : 'team-panel';
}
