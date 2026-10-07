import { describe, expect, it } from 'vitest';
import { ROLE_TEMPLATES, SKILL_LIBRARY } from '../../roles/RoleConfig';
import type { AgentConfig } from '../../types';
import { resolveContextWindow } from '../../contextWindowDefaults';
import { bundledSmartCompactionPolicy, bundledSmartCompactionPolicyData } from '../BundledSmartCompactionPolicy';
import {
  applySmartCompactionChoice,
  compactionSizing,
  loadSmartCompactionPolicy,
  profileOverrideProblems,
  resolveSmartCompactionPolicy,
  resolveWorkProfile,
  sanitizeAgentCompactionFields,
  sanitizeProfileOverrides,
  SKILL_CATEGORIES,
  withoutDefaultCells,
  type LoadedSmartCompactionPolicy,
  type SmartCompactionResolutionInput,
} from '../SmartCompactionPolicy';
import { describeSmartCompaction, smartCompactionChoiceLabel } from '../SmartCompactionPreview';

const MILLION = 1_048_576;
const OPENROUTER_DEEPSEEK = { connectionId: 'openrouter', modelId: 'deepseek/deepseek-v4-pro-0813' };

function bundled(): LoadedSmartCompactionPolicy {
  return bundledSmartCompactionPolicy();
}

/** A deep copy of the shipped file, for fixtures that change one value. */
function bundledCopy(): Record<string, any> {
  return JSON.parse(JSON.stringify(bundledSmartCompactionPolicyData()));
}

function agent(fields: Partial<AgentConfig> = {}): SmartCompactionResolutionInput['agent'] {
  return { roleTemplateKey: 'pm', ...fields };
}

function resolve(
  fields: Partial<AgentConfig> = {},
  options: Partial<Omit<SmartCompactionResolutionInput, 'agent'>> = {},
) {
  return resolveSmartCompactionPolicy({
    policy: bundled(),
    agent: agent(fields),
    contextWindow: { tokens: MILLION, source: 'measured' },
    ...options,
  });
}

function trigger(result: ReturnType<typeof resolve>) {
  if (result.status !== 'resolved') throw new Error(`unavailable: ${result.reason}`);
  return result.policy;
}

describe('bundled Smart compaction policy data', () => {
  it('validates as shipped, with the revision the design names', () => {
    const policy = bundled();
    expect(policy.revision).toBe('v0.9.90/2');
    expect(policy.custom.ok).toBe(true);
    expect(policy.smart.ok).toBe(true);
  });

  // Adding a role template or a skill category without choosing its work profile must fail CI.
  it('maps every shipped role template and every skill category, and nothing else', () => {
    const data = bundledSmartCompactionPolicyData() as {
      profileByRoleTemplate: Record<string, string>;
      profileBySkillCategory: Record<string, string>;
    };
    expect(Object.keys(data.profileByRoleTemplate).sort()).toEqual(Object.keys(ROLE_TEMPLATES).sort());
    expect(Object.keys(data.profileBySkillCategory).sort()).toEqual([...SKILL_CATEGORIES].sort());
  });

  it('keeps the design table exactly', () => {
    const policy = bundled();
    if (!policy.smart.ok || !policy.custom.ok) throw new Error('bundled policy did not load');
    expect(policy.custom.value).toEqual({
      windowPercent: 70, ceilingTokens: 250_000, recentTailTokens: 48_000, postCompactTargetTokens: 80_000,
    });
    expect(policy.smart.value.profiles).toEqual({
      balanced: { windowPercent: 70, ceilingTokens: 250_000, recentTailTokens: 48_000, postCompactTargetTokens: 80_000 },
      'iterative-delivery': { windowPercent: 70, ceilingTokens: 220_000, recentTailTokens: 48_000, postCompactTargetTokens: 90_000 },
      'research-synthesis': { windowPercent: 70, ceilingTokens: 275_000, recentTailTokens: 60_000, postCompactTargetTokens: 110_000 },
      'qa-debugging': { windowPercent: 75, ceilingTokens: 300_000, recentTailTokens: 64_000, postCompactTargetTokens: 120_000 },
      'deep-build': { windowPercent: 75, ceilingTokens: 350_000, recentTailTokens: 80_000, postCompactTargetTokens: 150_000 },
    });
    expect(policy.smart.value.routeEvidenceCaps.map(({ connectionId, modelId, capTokens }) => ({ connectionId, modelId, capTokens })))
      .toEqual([{ ...OPENROUTER_DEEPSEEK, capTokens: 200_000 }]);
  });
});

describe('Smart compaction trigger matrix', () => {
  it('triggers a balanced agent on an uncapped 1,048,576-token window at 250,000', () => {
    const policy = trigger(resolve());
    expect(policy).toMatchObject({ mode: 'smart', profile: 'balanced', activeTriggerTokens: 250_000, winningTerm: 'practical-ceiling' });
    expect(policy.routeEvidenceCapTokens).toBeUndefined();
  });

  it('triggers a balanced agent on a 128k window at 89,600', () => {
    const policy = trigger(resolve({}, { contextWindow: { tokens: 128_000, source: 'configured' } }));
    expect(policy).toMatchObject({ activeTriggerTokens: 89_600, winningTerm: 'window-share' });
  });

  it.each([
    ['pm', 'balanced', 250_000, 140_000],
    ['senior-dev', 'iterative-delivery', 220_000, 140_000],
    ['market-researcher', 'research-synthesis', 275_000, 140_000],
    ['tester', 'qa-debugging', 300_000, 150_000],
    ['architect', 'deep-build', 350_000, 150_000],
  ] as const)('%s resolves to %s and takes the lower of share and ceiling', (roleTemplateKey, profile, ceiling, shareOf200k) => {
    const large = trigger(resolve({ roleTemplateKey }));
    expect(large).toMatchObject({ profile, activeTriggerTokens: ceiling, winningTerm: 'practical-ceiling' });
    const small = trigger(resolve({ roleTemplateKey }, { contextWindow: { tokens: 200_000, source: 'measured' } }));
    expect(small).toMatchObject({ profile, activeTriggerTokens: shareOf200k, winningTerm: 'window-share' });
  });

  it('lets the observed OpenRouter DeepSeek evidence cap win in Smart mode', () => {
    const result = resolve({ roleTemplateKey: 'market-researcher' }, { route: OPENROUTER_DEEPSEEK });
    const policy = trigger(result);
    expect(policy).toMatchObject({
      profile: 'research-synthesis', routeEvidenceCapTokens: 200_000, activeTriggerTokens: 200_000, winningTerm: 'route-evidence-cap',
    });
    const preview = describeSmartCompaction(result, {
      contextWindow: { tokens: MILLION, source: 'measured' },
      mechanism: { kind: 'host-history' },
    });
    // The exact preview line from the design (§4.1).
    expect(preview.rule).toBe(
      'Advertised window 1,048,576 · 70% = 734,003 · profile ceiling 275,000 · route evidence cap 200,000 · auto-compact at 200,000.',
    );
  });

  it('matches an evidence cap only by exact connection and normalized model id', () => {
    const spaced = resolve({}, { route: { connectionId: 'openrouter', modelId: '  DeepSeek/DeepSeek-V4-Pro-0813 ' } });
    expect(trigger(spaced).routeEvidenceCapTokens).toBe(200_000);
    for (const route of [
      { connectionId: 'openrouter', modelId: 'deepseek/deepseek-v4-pro-0813:batch' },
      { connectionId: 'openrouter', modelId: 'deepseek/deepseek-v4-pro' },
      { connectionId: 'custom:4226ca0d0448777607365ef22b695b36', modelId: 'deepseek/deepseek-v4-pro-0813' },
    ]) {
      expect(trigger(resolve({}, { route })).routeEvidenceCapTokens, route.modelId).toBeUndefined();
    }
  });

  it('follows a provider-observed lower window through the window-share term', () => {
    const config = {
      model: 'm', contextWindowTokens: undefined,
      measuredContextWindow: { model: 'm', tokens: MILLION, field: 'context_length' as const },
      observedContextWindow: { model: 'm', tokens: 100_000, observedAt: '2026-09-28T00:00:00.000Z' },
    };
    const window = resolveContextWindow(config);
    const policy = trigger(resolve({}, { contextWindow: { tokens: window.tokens, source: window.source } }));
    expect(policy).toMatchObject({ activeTriggerTokens: 70_000, winningTerm: 'window-share' });
  });

  it('leaves an unavailable window out of the minimum instead of inventing one', () => {
    const result = resolveSmartCompactionPolicy({ policy: bundled(), agent: agent() });
    expect(trigger(result)).toMatchObject({ activeTriggerTokens: 250_000, winningTerm: 'practical-ceiling' });
    expect(result.status === 'resolved' ? result.windowShareTokens : 'unavailable').toBeUndefined();
  });

  it('honors Custom numbers, shows but never applies an evidence cap to them', () => {
    const custom = { smartCompactionMode: 'custom' as const, smartCompactionWindowPercent: 50, smartCompactionCeilingTokens: 300_000 };
    const result = resolve(custom, { route: OPENROUTER_DEEPSEEK });
    const policy = trigger(result);
    expect(policy).toMatchObject({
      mode: 'custom', activeTriggerTokens: 300_000, winningTerm: 'practical-ceiling',
      recentTailTokens: 48_000, postCompactTargetTokens: 80_000,
    });
    expect(policy.profile).toBeUndefined();
    expect(policy.routeEvidenceCapTokens).toBeUndefined();
    expect(result.status === 'resolved' && result.customIgnoresEvidenceCapTokens).toBe(200_000);
    const preview = describeSmartCompaction(result, { contextWindow: { tokens: MILLION, source: 'measured' }, mechanism: { kind: 'host-history' } });
    expect(preview.warning).toContain('200,000');
    expect(preview.rule).toContain('your ceiling 300,000');
  });

  it('has no automatic trigger when Off, and Custom or Off never affect another agent', () => {
    const off = trigger(resolve({ smartCompactionMode: 'off' }));
    expect(off.activeTriggerTokens).toBeUndefined();
    expect(off.winningTerm).toBeUndefined();
    expect(trigger(resolve({ roleTemplateKey: 'tester' })).activeTriggerTokens).toBe(300_000);
  });

  it('makes a Custom agent with a missing number unavailable rather than guessing', () => {
    const result = resolve({ smartCompactionMode: 'custom', smartCompactionWindowPercent: 70 });
    expect(result).toMatchObject({ status: 'unavailable', mode: 'custom' });
  });

  it('sizes a compaction from the active trigger: at 250k it keeps 48k and aims for 80k', () => {
    expect(compactionSizing(trigger(resolve()))).toEqual({ recentTailTokens: 48_000, postCompactTargetTokens: 80_000 });
    // A low trigger shrinks both by their shares of it.
    expect(compactionSizing(trigger(resolve({}, { contextWindow: { tokens: 128_000, source: 'configured' } }))))
      .toEqual({ recentTailTokens: 26_880, postCompactTargetTokens: 40_320 });
    expect(compactionSizing(trigger(resolve({ smartCompactionMode: 'off' })))).toBeUndefined();
  });
});

describe('Smart compaction policy data is the only source of its numbers', () => {
  it('changes resolver output when an injected fixture changes, with no code edit', () => {
    const raw = bundledCopy();
    raw.profiles.balanced.ceilingTokens = 123_456;
    raw.revision = 'fixture/1';
    const policy = trigger(resolveSmartCompactionPolicy({
      policy: loadSmartCompactionPolicy(raw), agent: agent(), contextWindow: { tokens: MILLION, source: 'measured' },
    }));
    expect(policy.activeTriggerTokens).toBe(123_456);
  });

  it.each([
    ['an invalid profile row', (raw: Record<string, any>) => { raw.profiles.balanced.windowPercent = 95; }],
    ['a row whose target is not below its ceiling', (raw: Record<string, any>) => { raw.profiles.balanced.postCompactTargetTokens = 250_000; }],
    ['an unknown top-level field', (raw: Record<string, any>) => { raw.extra = true; }],
    ['a mapping to an unknown profile', (raw: Record<string, any>) => { raw.profileByRoleTemplate.pm = 'fast'; }],
    ['an unknown skill category', (raw: Record<string, any>) => { raw.profileBySkillCategory.cooking = 'balanced'; }],
    ['a cap whose model id is not normalized', (raw: Record<string, any>) => { raw.routeEvidenceCaps[0].modelId = 'DeepSeek/X'; }],
    ['a missing profile', (raw: Record<string, any>) => { delete raw.profiles['deep-build']; }],
  ])('makes Smart visibly unavailable for %s, never a hidden 250k fallback', (_label, mutate) => {
    const raw = bundledCopy();
    mutate(raw);
    const loaded = loadSmartCompactionPolicy(raw);
    expect(loaded.smart.ok).toBe(false);
    const result = resolveSmartCompactionPolicy({ policy: loaded, agent: agent(), contextWindow: { tokens: MILLION, source: 'measured' } });
    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('250000');
    // Custom stands on its own section.
    expect(loaded.custom.ok).toBe(true);
    const custom = resolveSmartCompactionPolicy({
      policy: loaded,
      agent: agent({ smartCompactionMode: 'custom', smartCompactionWindowPercent: 70, smartCompactionCeilingTokens: 200_000 }),
    });
    expect(custom.status).toBe('resolved');
  });

  it('keeps Smart available when only customDefaults is broken, and makes Custom unavailable', () => {
    const raw = bundledCopy();
    raw.customDefaults.recentTailTokens = 90_000; // above its target
    const loaded = loadSmartCompactionPolicy(raw);
    expect(loaded.smart.ok).toBe(true);
    expect(loaded.custom.ok).toBe(false);
    expect(resolveSmartCompactionPolicy({
      policy: loaded,
      agent: agent({ smartCompactionMode: 'custom', smartCompactionWindowPercent: 70, smartCompactionCeilingTokens: 200_000 }),
    }).status).toBe('unavailable');
  });

  it('makes both modes unavailable when the file itself is unusable', () => {
    for (const raw of [null, [], { ...bundledCopy(), schemaVersion: 2 }, { ...bundledCopy(), revision: '' }]) {
      const loaded = loadSmartCompactionPolicy(raw);
      expect(loaded.smart.ok).toBe(false);
      expect(loaded.custom.ok).toBe(false);
    }
  });
});

describe('work-profile resolution', () => {
  const data = (() => {
    const policy = bundled();
    if (!policy.smart.ok) throw new Error('bundled policy did not load');
    return policy.smart.value;
  })();

  it('prefers the agent, then the role template, then the primary skill category, then balanced', () => {
    expect(resolveWorkProfile({ roleTemplateKey: 'tester', smartCompactionProfile: 'deep-build' }, data))
      .toEqual({ profile: 'deep-build', source: 'agent' });
    expect(resolveWorkProfile({ roleTemplateKey: 'tester', skills: [SKILL_LIBRARY['documentation']] }, data))
      .toEqual({ profile: 'qa-debugging', source: 'role-template' });
    expect(resolveWorkProfile({ roleTemplateKey: 'not-shipped', skills: [SKILL_LIBRARY['documentation']] }, data))
      .toEqual({ profile: 'iterative-delivery', source: 'skill-category' });
    expect(resolveWorkProfile({}, data)).toEqual({ profile: 'balanced', source: 'fallback' });
  });

  it('uses the first skill with a real category, in persisted order', () => {
    const skills = [
      { id: 'odd', name: 'Odd', description: '', category: 'cooking' as never },
      { id: 'sec', name: 'Security', description: '', category: 'security' as const },
      { id: 'doc', name: 'Docs', description: '', category: 'documentation' as const },
    ];
    expect(resolveWorkProfile({ skills }, data)).toEqual({ profile: 'qa-debugging', source: 'skill-category' });
  });

  it('ignores the display name, the broad runtime role and the legacy free-text skill', () => {
    const base = trigger(resolve({ roleTemplateKey: 'market-researcher' }));
    const renamed = trigger(resolve({ roleTemplateKey: 'market-researcher', name: 'Architect of Everything', role: 'architect', skill: 'testing' } as Partial<AgentConfig>));
    expect(renamed).toEqual(base);
    expect(trigger(resolve({ roleTemplateKey: undefined, skill: 'testing' } as Partial<AgentConfig>)).profile).toBe('balanced');
  });
});

describe('team profile-table overrides', () => {
  const baseline = (() => {
    const policy = bundled();
    if (!policy.smart.ok) throw new Error('bundled policy did not load');
    return policy.smart.value.profiles;
  })();

  it('drops scalar-invalid cells one by one and keeps their valid siblings', () => {
    const { overrides, warnings } = sanitizeProfileOverrides({
      balanced: { windowPercent: 91, ceilingTokens: 200_000, recentTailTokens: 1.5 },
      'qa-debugging': { windowPercent: '80' },
      fast: { windowPercent: 50 },
    }, baseline);
    expect(overrides).toEqual({ balanced: { ceilingTokens: 200_000 } });
    expect(warnings).toHaveLength(4);
  });

  it('drops a conflicting row\'s three token cells together, keeps its window share, and reports it once', () => {
    const { overrides, warnings } = sanitizeProfileOverrides({
      balanced: { windowPercent: 60, ceilingTokens: 70_000, recentTailTokens: 20_000 },
    }, baseline);
    expect(overrides).toEqual({ balanced: { windowPercent: 60 } });
    expect(warnings).toEqual([expect.stringContaining('balanced token overrides were ignored')]);
  });

  it('changes every Smart agent on the edited row, and no Custom agent or other row', () => {
    const teamOverrides = { balanced: { ceilingTokens: 180_000 } };
    expect(trigger(resolve({}, { teamOverrides })).activeTriggerTokens).toBe(180_000);
    expect(trigger(resolve({ roleTemplateKey: 'solo' }, { teamOverrides })).activeTriggerTokens).toBe(180_000);
    expect(trigger(resolve({ roleTemplateKey: 'tester' }, { teamOverrides })).activeTriggerTokens).toBe(300_000);
    const custom = { smartCompactionMode: 'custom' as const, smartCompactionWindowPercent: 70, smartCompactionCeilingTokens: 250_000 };
    expect(trigger(resolve(custom, { teamOverrides })).activeTriggerTokens).toBe(250_000);
  });

  it('gives the resolved policy a stable identity that follows the effective values', () => {
    const plain = trigger(resolve());
    expect(plain.revision).toMatch(/^[0-9a-f]{12}$/);
    expect(trigger(resolve()).revision).toBe(plain.revision);
    expect(trigger(resolve({}, { teamOverrides: { balanced: { ceilingTokens: 180_000 } } })).revision).not.toBe(plain.revision);
    expect(trigger(resolve({}, { teamOverrides: { 'deep-build': { ceilingTokens: 400_000 } } })).revision).toBe(plain.revision);
    expect(trigger(resolve({}, { route: OPENROUTER_DEEPSEEK })).revision).not.toBe(plain.revision);
  });

  it('explains every problem in an editor candidate instead of trimming it', () => {
    expect(profileOverrideProblems({ balanced: { ceilingTokens: 250_000 } }, baseline)).toEqual([]);
    expect(profileOverrideProblems({
      balanced: { windowPercent: 5 },
      'deep-build': { postCompactTargetTokens: 400_000 },
    }, baseline)).toEqual([
      'Balanced: window share must be a whole percent from 10 to 90.',
      'Deep build: the post-compact target must be below the practical ceiling.',
    ]);
  });

  it('stores only cells that differ from the bundled value', () => {
    expect(withoutDefaultCells({ balanced: { windowPercent: 70, ceilingTokens: 200_000 }, tester: {} } as never, baseline))
      .toEqual({ balanced: { ceilingTokens: 200_000 } });
    expect(withoutDefaultCells({ balanced: { windowPercent: 70 } }, baseline)).toBeUndefined();
  });
});

describe('agent compaction fields', () => {
  it('admits each field alone and drops an invalid one with a warning', () => {
    const { fields, warnings } = sanitizeAgentCompactionFields({
      smartCompactionMode: 'sometimes',
      smartCompactionProfile: 'deep-build',
      smartCompactionWindowPercent: 70,
      smartCompactionCeilingTokens: 10,
    }, 'members[0]');
    expect(fields).toEqual({ smartCompactionProfile: 'deep-build', smartCompactionWindowPercent: 70 });
    expect(warnings).toHaveLength(2);
  });

  it('persists only what differs from Smart with Auto', () => {
    const config: Partial<AgentConfig> = {
      smartCompactionMode: 'custom', smartCompactionWindowPercent: 60, smartCompactionCeilingTokens: 200_000,
    };
    applySmartCompactionChoice(config, { mode: 'smart' });
    expect(config).toEqual({});
    applySmartCompactionChoice(config, { mode: 'smart', profile: 'qa-debugging' });
    expect(config).toEqual({ smartCompactionProfile: 'qa-debugging' });
    applySmartCompactionChoice(config, { mode: 'custom', windowPercent: 70, ceilingTokens: 250_000 });
    expect(config).toEqual({ smartCompactionMode: 'custom', smartCompactionWindowPercent: 70, smartCompactionCeilingTokens: 250_000 });
    applySmartCompactionChoice(config, { mode: 'off' });
    expect(config).toEqual({ smartCompactionMode: 'off' });
  });

  it('labels the saved choice for the roster gear', () => {
    expect(smartCompactionChoiceLabel({})).toBe('Smart — Auto work profile');
    expect(smartCompactionChoiceLabel({ smartCompactionProfile: 'deep-build' })).toBe('Smart — Deep build');
    expect(smartCompactionChoiceLabel({ smartCompactionMode: 'custom', smartCompactionWindowPercent: 70, smartCompactionCeilingTokens: 250_000 }))
      .toBe('Custom — 70% or 250,000 tokens');
    expect(smartCompactionChoiceLabel({ smartCompactionMode: 'off' })).toBe('Off — compact only by hand');
  });
});

describe('Smart compaction preview wording', () => {
  it('states the balanced rule, the host-history sizing and the Auto source', () => {
    const preview = describeSmartCompaction(resolve(), {
      contextWindow: { tokens: MILLION, source: 'assumed' },
      mechanism: { kind: 'host-history' },
      auto: { profile: 'balanced', source: 'role-template', sourceName: 'Project Manager' },
    });
    expect(preview.rule).toBe('Assumed window 1,048,576 · 70% = 734,003 · profile ceiling 250,000 · auto-compact at 250,000.');
    expect(preview.summary).toBe('Smart · Balanced · auto-compact at 250,000');
    expect(preview.sizing).toBe('After compacting, it keeps up to 48,000 recent tokens word for word and aims for about 80,000 in total.');
    expect(preview.autoLabel).toBe('Auto: Balanced — Project Manager template');
  });

  it('says a native runtime writes its own summary', () => {
    const preview = describeSmartCompaction(resolve(), {
      contextWindow: { tokens: MILLION, source: 'measured' },
      mechanism: { kind: 'native-runtime', runtimeName: 'Codex' },
    });
    expect(preview.sizing).toBe('Codex writes its own summary, so the recent-tail and target sizes apply to OpenAI-compatible routes only.');
  });

  it('never tells a Codex user that Off or the trigger stops Codex compacting on its own inside a turn', () => {
    const codex = { contextWindow: { tokens: MILLION, source: 'measured' as const }, mechanism: { kind: 'native-runtime' as const, runtimeName: 'Codex' }, runtimeOwnThreshold: true };
    expect(describeSmartCompaction(resolve(), codex).sizing).toBe('Codex writes its own summary, so the recent-tail and target sizes '
      + 'apply to OpenAI-compatible routes only. Inside a long turn it may also compact at its own threshold, which UnodeAi does not set.');
    expect(describeSmartCompaction(resolve({ smartCompactionMode: 'off' }), codex).rule).toBe('Automatic compaction is off for this '
      + 'agent. Compact by hand whenever you choose; the existing context-limit guard still applies. Codex still compacts on its own '
      + 'threshold inside a long turn; UnodeAi does not change that.');
  });

  it('discloses Claude\'s own in-turn threshold, including when its minimum clamps it above the trigger', () => {
    const preview = describeSmartCompaction(resolve({ smartCompactionMode: 'custom', smartCompactionWindowPercent: 70, smartCompactionCeilingTokens: 50_000 }), {
      contextWindow: { tokens: MILLION, source: 'assumed' },
      mechanism: { kind: 'native-runtime', runtimeName: 'Claude' },
      nativeThreshold: { tokens: 70_000, clamped: 'minimum' },
    });
    expect(preview.sizing).toBe('Claude writes its own summary, so the recent-tail and target sizes apply to OpenAI-compatible '
      + 'routes only. Inside a long turn it also compacts on its own at about 70,000 tokens (Claude\'s lowest setting, above '
      + 'this trigger); a change applies when the agent restarts.');
  });

  it('never presents an unavailable policy as a trigger, and says tasks are still sent', () => {
    const preview = describeSmartCompaction(
      { status: 'unavailable', mode: 'smart', reason: 'profiles must be an object' },
      { mechanism: { kind: 'host-history' } },
    );
    expect(preview).toMatchObject({ unavailable: true, summary: 'Unavailable' });
    expect(preview.rule).toContain('Tasks are still sent');
    expect(preview.rule).not.toMatch(/auto-compact at/);
  });
});
