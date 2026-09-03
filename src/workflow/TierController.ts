/*---------------------------------------------------------------------------------------------
 *  UnodeAi - TierController (P2 / Team Workflow design §3)
 *  The deterministic "cost arbitrage" mechanism: switch agents between model tiers
 *  (premium/standard/economy) at runtime. Built on SessionManager.setModel — for the in-process
 *  OpenAICompatBackend the change takes effect on the next turn (no restart, context preserved).
 *
 *  A "tier directive" maps a role-or-id -> tier (e.g. { 'senior-dev': 'premium' } when a gate fails
 *  and we want a stronger model on the retry). The controller resolves each target agent's concrete
 *  model from the tier table for THAT agent's provider, then applies it. Pure of vscode so it's
 *  unit-testable; the extension injects the SessionManager-backed deps.
 *--------------------------------------------------------------------------------------------*/

import { ModelTier, DEFAULT_MODEL_TIERS } from '../roles/RoleConfig';

export interface TierTarget {
  id: string;
  role: string;
  providerId: string;
}

export interface TierControllerDeps {
  /** Current agents (id/role/provider) the controller may retune. */
  listAgents: () => TierTarget[];
  /** Switch an agent's model; returns true if it changed. */
  setModel: (agentId: string, model: string) => boolean;
}

export interface TierChange {
  agentId: string;
  role: string;
  tier: ModelTier;
  model: string;
}

export class TierController {
  constructor(
    private deps: TierControllerDeps,
    private tiers: Record<ModelTier, Record<string, string>> = DEFAULT_MODEL_TIERS
  ) {}

  /** Resolve the model id for a tier on a provider (provider-specific, falling back to Roam's). */
  modelFor(tier: ModelTier, providerId: string): string | undefined {
    return this.tiers[tier]?.[providerId] ?? this.tiers[tier]?.roam;
  }

  /**
   * Apply a tier directive { roleOrId: tier }. Each entry matches agents by exact id OR by role
   * (so 'senior-dev' retunes every senior-dev). Returns the changes actually applied.
   */
  applyTiers(directive: Record<string, ModelTier>): TierChange[] {
    const changes: TierChange[] = [];
    const agents = this.deps.listAgents();
    for (const [ref, tier] of Object.entries(directive)) {
      for (const agent of agents) {
        if (agent.id !== ref && agent.role !== ref) {
          continue;
        }
        const model = this.modelFor(tier, agent.providerId);
        if (model && this.deps.setModel(agent.id, model)) {
          changes.push({ agentId: agent.id, role: agent.role, tier, model });
        }
      }
    }
    return changes;
  }
}
