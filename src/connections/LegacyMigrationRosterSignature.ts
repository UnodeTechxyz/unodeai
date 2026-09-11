import type { AgentConfig } from '../types';
import { isLegacySingletonCustomAgent } from './LegacyCustomGatewayMigration';

/**
 * Compare the roster shape that remains after team-file validation. Team files intentionally drop
 * machine-owned endpoints for normal connections; a legacy Custom endpoint is the sole exception
 * because it is still input to the host-reviewed migration plan.
 */
export function legacyMigrationRosterSignature(agents: readonly AgentConfig[]): string {
  return JSON.stringify(agents.map((agent) => {
    const legacyCustom = isLegacySingletonCustomAgent(agent);
    return {
      id: agent.id,
      model: agent.model,
      backend: agent.backend,
      providerId: agent.provider?.providerId,
      // Team files never version legacy secret identities. The trusted host reads the source
      // roster's SecretStorage name only when it actually performs a migration.
      secretName: legacyCustom ? undefined : agent.provider?.apiKeySecretName,
      baseUrl: legacyCustom ? agent.baseUrl : undefined,
      route: agent.route,
    };
  }).sort((left, right) => left.id.localeCompare(right.id)));
}
