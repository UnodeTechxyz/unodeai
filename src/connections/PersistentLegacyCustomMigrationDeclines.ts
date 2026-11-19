import { createHash } from 'node:crypto';
import type { AgentConfig } from '../types';
import { isLegacySingletonCustomAgent } from './LegacyCustomGatewayMigration';
import { legacyMigrationRosterSignature } from './LegacyMigrationRosterSignature';

export const LEGACY_CUSTOM_GATEWAY_MIGRATION_DECLINED_KEY = 'unode.migration.legacyCustomGateway.declined.v1';

/** The small subset of WorkspaceState this decision needs; kept narrow for activation-path tests. */
export interface LegacyCustomMigrationDeclineStore {
  get<T>(section: string): T | undefined;
  update(section: string, value: unknown): Thenable<void>;
}

/**
 * A declined migration is scoped to the exact legacy roster, but WorkspaceState receives only a digest.
 * The preimage deliberately includes the normalized migration signature so an endpoint/model/id change is
 * a new user decision, while an endpoint, key reference, and key value never leave process memory here.
 */
export function legacyCustomMigrationDeclineSignature(agents: readonly AgentConfig[]): string {
  const legacy = agents.filter(isLegacySingletonCustomAgent);
  return createHash('sha256').update(legacyMigrationRosterSignature(legacy)).digest('hex');
}

export class PersistentLegacyCustomMigrationDeclines {
  constructor(private readonly store: LegacyCustomMigrationDeclineStore) {}

  shouldSuppressPrompt(hasPendingMigration: boolean, agents: readonly AgentConfig[]): boolean {
    if (hasPendingMigration || !agents.some(isLegacySingletonCustomAgent)) {
      return false;
    }
    const declined = this.store.get<unknown>(LEGACY_CUSTOM_GATEWAY_MIGRATION_DECLINED_KEY);
    return typeof declined === 'string' && declined === legacyCustomMigrationDeclineSignature(agents);
  }

  async remember(agents: readonly AgentConfig[]): Promise<void> {
    await this.store.update(LEGACY_CUSTOM_GATEWAY_MIGRATION_DECLINED_KEY, legacyCustomMigrationDeclineSignature(agents));
  }

  async clear(): Promise<void> {
    await this.store.update(LEGACY_CUSTOM_GATEWAY_MIGRATION_DECLINED_KEY, undefined);
  }
}
