import type { VerificationRequestIdentity } from './CompletionVerificationCheck';

/** A host-owned lease of the completed task, not a new task/agent identity or reusable authorization. */
export interface WorktreeVerificationOwner {
  readonly request: Extract<VerificationRequestIdentity, { kind: 'session' }>;
  readonly launchId: string;
  readonly hasTaskScope: boolean;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}
