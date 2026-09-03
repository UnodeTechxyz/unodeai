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

/** The sole dispatch-authority predicate. A capability label never makes a worker a coordinator. */
export function isCoordinator(config: Pick<AgentConfig, 'id'>, coordinatorId: string | undefined): boolean {
  return coordinatorId !== undefined && config.id === coordinatorId;
}
