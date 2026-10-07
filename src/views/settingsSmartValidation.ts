import { ModelTier } from '../types';

export type ModelTierCellPatch = {
  kind: 'modelTierCell';
  tier: ModelTier;
  provider: string;
  value: string;
};

export function isModelTier(value: unknown): value is ModelTier {
  return value === 'premium' || value === 'standard' || value === 'economy';
}

export function parseModelTierCellPatch(
  raw: Record<string, unknown>,
  knownProviders: ReadonlySet<string>
): ModelTierCellPatch | undefined {
  if (
    raw.kind !== 'modelTierCell' ||
    !isModelTier(raw.tier) ||
    typeof raw.provider !== 'string' ||
    !knownProviders.has(raw.provider) ||
    typeof raw.value !== 'string'
  ) {
    return undefined;
  }
  return {
    kind: 'modelTierCell',
    tier: raw.tier,
    provider: raw.provider,
    value: raw.value.trim(),
  };
}
