import { describe, it, expect } from 'vitest';
import { selectTier, resolveModelTiers, modelForTier } from '../SmartMode';
import { SmartModeConfig } from '../../types';
import { DEFAULT_MODEL_TIERS } from '../../roles/RoleConfig';

const base: SmartModeConfig = { enabled: true, defaultTier: 'standard' };

describe('selectTier (F3)', () => {
  it('returns roleDefault unchanged when Smart Mode is off', () => {
    const off: SmartModeConfig = { enabled: false, defaultTier: 'economy' };
    expect(selectTier({ type: 'task.assign' }, off, 'premium')).toBe('premium');
  });

  it('uses an explicit per-task tier above everything', () => {
    const cfg: SmartModeConfig = { ...base, taskTierHints: { 'task.assign': 'economy' } };
    const msg = { type: 'task.assign', payload: { metadata: { tier: 'premium' as const } } };
    expect(selectTier(msg, cfg, 'standard')).toBe('premium');
  });

  it('ignores invalid explicit metadata tiers and falls back to hints/defaults', () => {
    const cfg: SmartModeConfig = { ...base, taskTierHints: { 'task.assign': 'economy' } };
    expect(selectTier({ type: 'task.assign', payload: { metadata: { tier: 'turbo' } } }, cfg, 'standard')).toBe('economy');
    expect(selectTier({ type: 'handoff', payload: { metadata: { tier: 'turbo' } } }, cfg, 'premium')).toBe('premium');
  });

  it('falls back to a task-type hint when no explicit tier', () => {
    const cfg: SmartModeConfig = { ...base, taskTierHints: { 'review.request': 'economy' } };
    expect(selectTier({ type: 'review.request' }, cfg, 'standard')).toBe('economy');
  });

  it('falls back to roleDefault when nothing matches', () => {
    expect(selectTier({ type: 'handoff' }, base, 'premium')).toBe('premium');
  });
});

describe('resolveModelTiers (F3)', () => {
  it('returns the built-ins when no override is given', () => {
    expect(resolveModelTiers()).toEqual(DEFAULT_MODEL_TIERS);
  });

  it('merges a partial override per tier without dropping built-in providers', () => {
    const merged = resolveModelTiers({ economy: { roam: 'my-cheap-model' } });
    expect(merged.economy.roam).toBe('my-cheap-model');
    // other providers in economy survive
    expect(merged.economy.openai).toBe(DEFAULT_MODEL_TIERS.economy.openai);
    // other tiers untouched
    expect(merged.premium).toEqual(DEFAULT_MODEL_TIERS.premium);
  });
});

describe('modelForTier (F3)', () => {
  const tiers = resolveModelTiers();

  it('resolves a provider-specific model', () => {
    expect(modelForTier('premium', 'openai', tiers)).toBe(DEFAULT_MODEL_TIERS.premium.openai);
    expect(modelForTier('economy', 'openrouter', tiers)).toBe(DEFAULT_MODEL_TIERS.economy.openrouter);
  });

  it('does not borrow another provider model for an unknown connection', () => {
    expect(modelForTier('standard', 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tiers)).toBeUndefined();
  });
});
