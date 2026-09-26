/*---------------------------------------------------------------------------------------------
 *  UnodeAi - SmartMode (v0.1.1 F3)
 *  The auto-selection layer on top of the existing tier infrastructure. It decides WHICH tier a
 *  task should run at; the caller then maps that tier → concrete model (DEFAULT_MODEL_TIERS /
 *  TierController.modelFor) and hot-swaps it via SessionManager.setModel.
 *
 *  Reuse, don't reinvent: the tier UNION (`ModelTier`) and the tier→model TABLES already exist.
 *  This module is just the trigger + a small override-merge helper. Pure (no vscode), unit-testable.
 *--------------------------------------------------------------------------------------------*/

import { ModelTier, SmartModeConfig } from '../types';
import { DEFAULT_MODEL_TIERS } from '../roles/RoleConfig';

/** Minimal shape of an inbound task message — only the fields tier selection looks at. */
export interface TierSelectableMessage {
  type: string;
  payload?: { metadata?: Record<string, unknown> & { tier?: unknown } };
}

/**
 * Decide the tier for an inbound task. Precedence (first match wins):
 *   1. explicit per-task tier   (msg.payload.metadata.tier)
 *   2. task-type hint           (cfg.taskTierHints[msg.type])
 *   3. roleDefault              (caller-resolved: role override → role template → cfg.defaultTier)
 * When Smart Mode is off, the agent stays on its configured tier (roleDefault), unchanged.
 */
export function selectTier(
  msg: TierSelectableMessage,
  cfg: SmartModeConfig,
  roleDefault: ModelTier
): ModelTier {
  if (!cfg.enabled) {
    return roleDefault;
  }
  const explicitTier = msg.payload?.metadata?.tier;
  return isModelTier(explicitTier) ? explicitTier : cfg.taskTierHints?.[msg.type] ?? roleDefault;
}

export function isModelTier(value: unknown): value is ModelTier {
  return value === 'premium' || value === 'standard' || value === 'economy';
}

const TIERS: ModelTier[] = ['premium', 'standard', 'economy'];

/**
 * Merge a (possibly partial) user override over the built-in DEFAULT_MODEL_TIERS, per tier. An empty
 * or missing override yields the built-ins unchanged. Used to feed TierController/model lookup.
 */
export function resolveModelTiers(
  override?: Partial<Record<ModelTier, Record<string, string>>>
): Record<ModelTier, Record<string, string>> {
  const out = {} as Record<ModelTier, Record<string, string>>;
  for (const tier of TIERS) {
    out[tier] = { ...DEFAULT_MODEL_TIERS[tier], ...(override?.[tier] ?? {}) };
  }
  return out;
}

/**
 * Map a tier → concrete model id for one exact provider/connection. A missing entry means the
 * caller must retain that connection's configured model; borrowing Roam or another provider's
 * model id would silently route a dynamic gateway onto an unsupported catalog.
 */
export function modelForTier(
  tier: ModelTier,
  providerId: string,
  tiers: Record<ModelTier, Record<string, string>>
): string | undefined {
  return tiers[tier]?.[providerId];
}
