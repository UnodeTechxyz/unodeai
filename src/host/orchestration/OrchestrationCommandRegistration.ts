/**
 * Command identities at the orchestration boundary. The extension host owns registration mechanics;
 * this module owns the bounded set of orchestration/evidence commands that enter the adapter.
 */

export type RegisterCommand = (command: string, handler: (...args: any[]) => unknown) => void;

export interface OrchestrationCommandPort {
  reviewRun(runId?: string): unknown;
  coordinatorCancelTask(options?: unknown): unknown;
}

/** Keep command ids stable while preventing their orchestration entry points from drifting apart. */
export function registerOrchestrationCommands(
  register: RegisterCommand,
  port: OrchestrationCommandPort,
): void {
  register('unode.reviewRun', port.reviewRun);
  register('unode.coordinatorCancelTask', port.coordinatorCancelTask);
}
