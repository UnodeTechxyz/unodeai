import type { AgentConfig } from '../types';

/**
 * The team has one coordinating identity: the first PM in its durable roster order.
 *
 * Legacy teams can contain more than one PM. Selecting the first preserves the product's historical
 * `find(role === 'pm')` behaviour while making the other members ordinary workers for delegation.
 */
export function resolveCoordinatorId(members: readonly Pick<AgentConfig, 'id' | 'role'>[]): string | undefined {
  return members.find((member) => member.role === 'pm')?.id;
}

/**
 * Whether a team member is someone the coordinator can dispatch to: anyone but the coordinator itself and the
 * standalone Solo agent, which the person talks to directly and which is no part of the crew. The team tools, the
 * candidate snapshot of a request and the first-action guard all decide with this one rule.
 */
export function isDispatchCandidate(member: { id: string; role: string }, coordinatorId: string): boolean {
  return member.id !== coordinatorId && member.role !== 'solo';
}

/** The sole dispatch-authority predicate. A capability label never makes a worker a coordinator. */
export function isCoordinator(config: Pick<AgentConfig, 'id'>, coordinatorId: string | undefined): boolean {
  return coordinatorId !== undefined && config.id === coordinatorId;
}
