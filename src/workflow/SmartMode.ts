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
import { DEFAULT_MODEL_TIERS, ROLE_TEMPLATES } from '../roles/RoleConfig';

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

/**
 * v0.9.100: a role is typed text (Custom role), so it can be any name, including `constructor`, `toString` or
 * `__proto__`. Only an own entry holding a real tier counts as the user's per-role override; an inherited
 * object member is not one.
 */
export function roleTierOverride(roleTiers: Readonly<Record<string, unknown>> | undefined, role: string): ModelTier | undefined {
  if (!roleTiers || !Object.hasOwn(roleTiers, role)) return undefined;
  const tier = roleTiers[role];
  return isModelTier(tier) ? tier : undefined;
}

/**
 * The per-role override table after setting (or, with no tier, removing) one role's override. Built from own
 * entries, never by assignment, so a role named `__proto__` is stored as an ordinary entry. Order is kept.
 */
export function withRoleTierOverride(
  roleTiers: Readonly<Record<string, ModelTier>> | undefined,
  role: string,
  tier: ModelTier | undefined,
): Record<string, ModelTier> {
  const entries = Object.entries(roleTiers ?? {}).flatMap(([name, value]): [string, ModelTier][] =>
    name !== role ? [[name, value]] : tier ? [[name, tier]] : []);
  if (tier && !entries.some(([name]) => name === role)) entries.push([role, tier]);
  return Object.fromEntries(entries);
}

/** The shipped template tier for a role, by own entry only (see roleTierOverride). */
export function templateTierForRole(role: string): ModelTier | undefined {
  if (!Object.hasOwn(ROLE_TEMPLATES, role)) return undefined;
  const tier = ROLE_TEMPLATES[role]?.tier;
  return isModelTier(tier) ? tier : undefined;
}

/**
 * The agent's configured tier before any per-task Smart Mode choice: its own tier, else the user's per-role
 * override, else the role template's tier, else the default tier. Shared by runtime routing and the Team card.
 */
export function configuredRoleTier(
  config: { role: string; tier?: unknown },
  cfg: Pick<SmartModeConfig, 'defaultTier' | 'roleTiers'>,
): ModelTier {
  return (isModelTier(config.tier) ? config.tier : undefined)
    ?? roleTierOverride(cfg.roleTiers, config.role)
    ?? templateTierForRole(config.role)
    ?? cfg.defaultTier;
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
