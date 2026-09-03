import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import {
  defaultTeamRules,
  generatedTeamRoster,
  syncTeamRulesWithRoster,
  TEAM_ROSTER_END,
  TEAM_ROSTER_START,
  TEAM_RULES_PRESETS,
  rulesResetForKind,
  teamKindFromSkills,
  upsertGeneratedTeamRoster,
  BUILT_IN_PROTECTIONS,
} from '../TeamRulesPanel';

describe('teamKindFromSkills — classify a team by its agents skills (roles are all "custom")', () => {
  it('a Business Planning roster is knowledge (the software-rules bug)', () => {
    // pm + strategy-lead + market-researcher + financial-analyst → their skills, pm has project-management
    expect(teamKindFromSkills(['project-management', 'strategy', 'market-research', 'financial-modeling'])).toBe('knowledge');
    expect(teamKindFromSkills(['project-management', 'business-analysis'])).toBe('knowledge');
  });
  it('a Marketing roster is knowledge', () => {
    expect(teamKindFromSkills(['project-management', 'content-marketing', 'growth-marketing', 'market-research', 'seo-analytics'])).toBe('knowledge');
  });
  it('a Sales roster is knowledge', () => {
    expect(teamKindFromSkills(['project-management', 'sales-development', 'sales-execution', 'sales-engineering', 'customer-success'])).toBe('knowledge');
  });
  it('a software crew is software', () => {
    expect(teamKindFromSkills(['project-management', 'architecture', 'coding', 'code-review'])).toBe('software');
    expect(teamKindFromSkills([])).toBe('software');
  });
});

describe('rulesResetForKind — switching teams carries the rules over, safely', () => {
  const sw = defaultTeamRules('software');
  const kn = defaultTeamRules('knowledge');

  it('swaps the previous kind-default to the new kind default', () => {
    expect(rulesResetForKind(sw, 'knowledge')).toBe(kn); // software default → business team → business rules
    expect(rulesResetForKind(kn, 'software')).toBe(sw);
  });
  it('leaves rules alone when they already match the new kind', () => {
    expect(rulesResetForKind(sw, 'software')).toBeNull();
    expect(rulesResetForKind(kn, 'knowledge')).toBeNull();
  });
  it('never clobbers empty, custom, or kind-agnostic-preset rules', () => {
    expect(rulesResetForKind('', 'knowledge')).toBeNull();
    expect(rulesResetForKind('# Team rules\n\n- my own custom rule', 'knowledge')).toBeNull();
    const strict = TEAM_RULES_PRESETS.find((p) => p.id === 'strict')!.body;
    expect(rulesResetForKind(strict, 'knowledge')).toBeNull(); // deliberate kind-agnostic preset is preserved
  });
});

describe('TEAM_RULES_PRESETS', () => {
  it('offers the prepared presets with unique ids and non-empty bodies', () => {
    const ids = TEAM_RULES_PRESETS.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['software', 'knowledge', 'strict', 'lean']));
    expect(new Set(ids).size).toBe(ids.length); // unique
    for (const p of TEAM_RULES_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.body).toMatch(/# Team guidance/);
      expect(p.body).toMatch(/Advisory/);
    }
  });
});

describe('defaultTeamRules — starter template matches the team kind', () => {
  it('a software team gets developer-oriented rules', () => {
    const rules = defaultTeamRules('software');
    expect(rules).toMatch(/focused review/i);
    expect(rules).toMatch(/relevant tests/i);
    expect(rules).not.toMatch(/cite a source/i);
  });

  it('a knowledge/business team gets analysis-oriented rules (NOT the software ones)', () => {
    const rules = defaultTeamRules('knowledge');
    expect(rules).toMatch(/cite a source/i);
    expect(rules).toMatch(/assumption/i);
    expect(rules).not.toMatch(/run the tests/i);     // the software-team bug: same dev rules for every team
    expect(rules).not.toMatch(/architect review/i);
  });

  it('the two kinds produce different templates', () => {
    expect(defaultTeamRules('software')).not.toBe(defaultTeamRules('knowledge'));
  });
});

describe('truthful Team Rules zones', () => {
  it('shows only the five removal-proved built-in protections and no paperwork/close guard', () => {
    expect(BUILT_IN_PROTECTIONS).toHaveLength(5);
    expect(BUILT_IN_PROTECTIONS.join('\n')).toMatch(/delegate-required/i);
    expect(BUILT_IN_PROTECTIONS.join('\n')).not.toMatch(/read_files|close_assignment|effect description/i);
  });

  it('keeps enforcement-shaped review templates out of advisory guidance', () => {
    const all = TEAM_RULES_PRESETS.map((preset) => `${preset.description}\n${preset.body}`).join('\n');
    expect(all).not.toMatch(/independent review|nothing (?:is )?done until|nothing ships|must have the architect/i);
  });
});

describe('generated team roster rules', () => {
  const first = [
    { name: 'Avery', role: 'Project Manager', duty: 'Break down work and coordinate the team.' },
    { name: 'Lin', role: 'Reviewer', duty: 'Review changes before completion.' },
  ];
  const second = [
    { name: 'Avery', role: 'Project Manager', duty: 'Break down work and coordinate the team.' },
    { name: 'Jo', role: 'Tester', duty: 'Run focused checks and report evidence.' },
  ];

  it('keeps the live roster compact: role plus one line of duty, not a biography', () => {
    const block = generatedTeamRoster([{ name: 'Avery', role: 'PM', duty: 'Coordinates work. Extra biography that must not enter every prompt.' }]);
    expect(block).toContain(TEAM_ROSTER_START);
    expect(block).toContain('**Avery** — PM: Coordinates work.');
    expect(block).not.toContain('Extra biography');
    expect(block).toContain(TEAM_ROSTER_END);
  });

  it('rewrites only its delimited roster in place and preserves user rules byte-for-byte', () => {
    const userRules = '# My rules\n\n- Never bypass review.\n\n';
    const initial = `${userRules}${generatedTeamRoster(first)}\n\n- Keep this user footer.`;
    const next = upsertGeneratedTeamRoster(initial, second);

    expect(next).toContain(userRules);
    expect(next).toContain('- Keep this user footer.');
    expect(next).toContain('**Jo** — Tester: Run focused checks and report evidence.');
    expect(next).not.toContain('**Lin**');
    expect(next.indexOf(TEAM_ROSTER_START)).toBe(initial.indexOf(TEAM_ROSTER_START));
  });

  it('appends rather than guessing when the delimiters are absent or incomplete', () => {
    const custom = '# Team rules\n\n- Written by a human.';
    const missing = upsertGeneratedTeamRoster(custom, first);
    const incomplete = upsertGeneratedTeamRoster(`${custom}\n${TEAM_ROSTER_START}\nold`, first);

    expect(missing).toMatch(/^# Team rules\n\n- Written by a human\./);
    expect(incomplete).toContain(`${TEAM_ROSTER_START}\nold`);
    expect(incomplete.split(TEAM_ROSTER_START)).toHaveLength(3); // original partial marker + appended owned block
  });

  it('switches only an untouched static default, then refreshes the generated roster', () => {
    const initial = syncTeamRulesWithRoster(defaultTeamRules('software'), 'software', first);
    const switched = syncTeamRulesWithRoster(initial, 'knowledge', second);
    const custom = syncTeamRulesWithRoster('# My custom rule\n\n- Preserve this.', 'knowledge', second);

    expect(switched).toContain('Cite a source');
    expect(switched).not.toContain('architect review');
    expect(switched).toContain('**Jo** — Tester');
    expect(custom).toContain('# My custom rule\n\n- Preserve this.');
  });
});
