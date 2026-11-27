import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  selectTier, resolveModelTiers, modelForTier, configuredRoleTier, roleTierOverride, templateTierForRole, withRoleTierOverride,
} from '../SmartMode';
import { ModelTier, SmartModeConfig } from '../../types';
import { DEFAULT_MODEL_TIERS, ROLE_TEMPLATES } from '../../roles/RoleConfig';

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

describe('role-tier lookups are own-entry lookups (v0.9.100 R2)', () => {
  const objectMemberRoles = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];
  const sm = (roleTiers: Record<string, unknown> = {}) => ({ defaultTier: 'standard' as const, roleTiers: roleTiers as Record<string, ModelTier> });

  it.each(objectMemberRoles)('role %j without an override gets the default tier, not an inherited member', role => {
    expect(roleTierOverride({}, role)).toBeUndefined();
    expect(templateTierForRole(role)).toBeUndefined();
    expect(configuredRoleTier({ role }, sm())).toBe('standard');
    expect(configuredRoleTier({ role }, { defaultTier: 'economy' })).toBe('economy');
  });

  it.each(objectMemberRoles)('role %j with its own explicit override gets that override', role => {
    const table = withRoleTierOverride({}, role, 'premium');
    expect(Object.hasOwn(table, role)).toBe(true);
    expect(Object.getPrototypeOf(table)).toBe(Object.prototype);
    expect(configuredRoleTier({ role }, sm(table))).toBe('premium');
    // Also from a table that came from settings JSON, where `__proto__` is an ordinary key.
    expect(configuredRoleTier({ role }, sm(JSON.parse(JSON.stringify({ [role]: 'economy' }))))).toBe('economy');
    expect(withRoleTierOverride(table, role, undefined)).toEqual({});
  });

  it('keeps legitimate custom-role and built-in overrides, and their precedence', () => {
    const table = withRoleTierOverride(withRoleTierOverride({}, 'System Integrator', 'economy'), 'pm', 'economy');
    expect(configuredRoleTier({ role: 'System Integrator' }, sm(table))).toBe('economy');
    expect(configuredRoleTier({ role: 'pm' }, sm(table))).toBe('economy');
    expect(configuredRoleTier({ role: 'pm', tier: 'premium' }, sm(table))).toBe('premium');
    expect(configuredRoleTier({ role: 'pm' }, sm())).toBe(ROLE_TEMPLATES.pm.tier ?? 'standard');
    expect(configuredRoleTier({ role: 'Image Editor' }, sm())).toBe('standard');
    // Replacing keeps order; removing leaves other roles alone.
    expect(Object.keys(withRoleTierOverride(table, 'System Integrator', 'premium'))).toEqual(['System Integrator', 'pm']);
    expect(withRoleTierOverride(table, 'pm', undefined)).toEqual({ 'System Integrator': 'economy' });
  });

  it('ignores a stored value that is not a tier', () => {
    expect(configuredRoleTier({ role: 'Writer' }, sm({ Writer: 'ultra' }))).toBe('standard');
    expect(configuredRoleTier({ role: 'Writer', tier: 'ultra' }, sm({ Writer: 'economy' }))).toBe('economy');
  });

  it('the actual routing and Team card preview functions resolve through the own-entry rule', () => {
    const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    const wanted = ['configuredRoutingTier', 'smartModeCardPreview'];
    const bodies = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
      && !!node.name && wanted.includes(node.name.text));
    expect(bodies.map(node => node.name!.text).sort()).toEqual([...wanted].sort());
    const js = ts.transpileModule(bodies.map(node => node.getText(source)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    let settings: SmartModeConfig = { enabled: true, defaultTier: 'standard', roleTiers: {} };
    const host = { readSmartMode: () => settings, configuredRoleTier, resolveModelTiers, configuredSetting: (_key: string, fallback: unknown) => fallback };
    const fns = new Function('host', `with (host) { ${js}; return { ${wanted.join(', ')} }; }`)(host) as {
      configuredRoutingTier(config: { role: string; tier?: ModelTier }): ModelTier;
      smartModeCardPreview(config: { role: string; tier?: string; provider: { providerId: string } }): { tier: ModelTier } | undefined;
    };
    for (const role of objectMemberRoles) {
      expect(fns.configuredRoutingTier({ role })).toBe('standard');
      expect(fns.smartModeCardPreview({ role, provider: { providerId: 'roam' } })?.tier).toBe('standard');
    }
    settings = { ...settings, roleTiers: withRoleTierOverride({}, '__proto__', 'premium') };
    expect(fns.configuredRoutingTier({ role: '__proto__' })).toBe('premium');
    expect(fns.smartModeCardPreview({ role: '__proto__', provider: { providerId: 'roam' } })?.tier).toBe('premium');
    expect(fns.configuredRoutingTier({ role: 'constructor' })).toBe('standard');
  });
});
