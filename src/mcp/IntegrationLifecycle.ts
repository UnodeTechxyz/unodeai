/*---------------------------------------------------------------------------------------------
 *  UnodeAi - governed Integration lifecycle
 *  Host facts only: catalog listing, configuration, approval, mount, exercise, and success.
 *--------------------------------------------------------------------------------------------*/

import { MCPServerConfig } from '../types';
import { approvalKey } from './McpApproval';

export const INTEGRATION_EVIDENCE_KEY = 'unode.integrationEvidence.v1';

interface StateLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

interface IntegrationEvidence {
  exercisedAt?: string;
  succeededAt?: string;
}

export interface IntegrationLifecycle {
  listed: boolean;
  configured: boolean;
  approved: boolean;
  mounted: boolean;
  exercised: boolean;
  succeeded: boolean;
}

/** Evidence follows the workspace + exact launch fingerprint, so edited configs start clean. */
export class IntegrationEvidenceStore {
  private readonly records: Record<string, IntegrationEvidence>;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly state: StateLike, private readonly workspaceId: string) {
    this.records = { ...state.get<Record<string, IntegrationEvidence>>(INTEGRATION_EVIDENCE_KEY, {}) };
  }

  evidenceFor(config: MCPServerConfig): IntegrationEvidence {
    return { ...(this.records[approvalKey(config, this.workspaceId)] ?? {}) };
  }

  noteExercised(config: MCPServerConfig, succeeded: boolean): Promise<void> {
    const key = approvalKey(config, this.workspaceId);
    const now = new Date().toISOString();
    const current = this.records[key] ?? {};
    this.records[key] = {
      ...current,
      exercisedAt: current.exercisedAt ?? now,
      succeededAt: succeeded ? (current.succeededAt ?? now) : current.succeededAt,
    };
    this.pending = this.pending.then(() => this.state.update(INTEGRATION_EVIDENCE_KEY, { ...this.records }));
    return this.pending;
  }
}

export function integrationLifecycle(input: {
  configured: boolean;
  approved: boolean;
  mounted: boolean;
  evidence?: IntegrationEvidence;
}): IntegrationLifecycle {
  return {
    listed: true,
    configured: input.configured,
    approved: input.approved,
    mounted: input.mounted,
    exercised: !!input.evidence?.exercisedAt,
    succeeded: !!input.evidence?.succeededAt,
  };
}
