import { describe, expect, it } from 'vitest';
import {
  effectiveTargets,
  parseRepositoryBudget,
  parseUserTargets,
  periodIdFor,
  targetRevision,
  userTargetsToSettings,
} from '../SpendTargets';

const userSettings = {
  schemaVersion: 1,
  request: { tokens: 1_000_000, usd: '5.00' },
  project: { tokens: 10_000_000, usd: '50', period: 'day', timeZone: 'America/Vancouver' },
  agents: { worker: { tokens: 2_000_000 } },
};

describe('user targets', () => {
  it('are off by default', () => {
    const targets = parseUserTargets({ schemaVersion: 1 });
    expect(targets.request).toBeUndefined();
    expect(targets.project).toBeUndefined();
    expect(targets.diagnostics).toEqual([]);
  });

  it('disable only an invalid field and say why', () => {
    const targets = parseUserTargets({ schemaVersion: 1, request: { tokens: 0, usd: '1.5' } });
    expect(targets.request).toEqual({ nanoUsd: 1_500_000_000n });
    expect(targets.diagnostics[0]).toMatch(/request\.tokens/);
  });

  it('need a valid zone for a project target and a project target for agent shares', () => {
    expect(parseUserTargets({ ...userSettings, project: { tokens: 5, period: 'day', timeZone: 'Mars/Base' } }).project).toBeUndefined();
    const noProject = parseUserTargets({ schemaVersion: 1, agents: { worker: { tokens: 5 } } });
    expect(noProject.agents).toEqual({});
    expect(noProject.diagnostics[0]).toMatch(/project target/);
  });

  it('round-trip through the settings shape', () => {
    const parsed = parseUserTargets(userSettings);
    expect(userTargetsToSettings(parsed)).toEqual({
      schemaVersion: 1,
      request: { tokens: 1_000_000, usd: '5' },
      project: { tokens: 10_000_000, usd: '50', period: 'day', timeZone: 'America/Vancouver' },
      agents: { worker: { tokens: 2_000_000 } },
    });
  });
});

describe('repository budget file', () => {
  const valid = JSON.stringify({ schemaVersion: 1, max: { request: { tokens: 100, usd: '1.00' }, agents: { worker: { usd: '0.5' } } } });

  it('parses a valid proposal and binds it to a canonical digest', () => {
    const parsed = parseRepositoryBudget(valid);
    expect(parsed.ok).toBe(true);
    const reformatted = parseRepositoryBudget(JSON.stringify(JSON.parse(valid), null, 2));
    expect(reformatted.ok && parsed.ok && reformatted.budget.contentDigest === parsed.budget.contentDigest).toBe(true);
    const changed = parseRepositoryBudget(valid.replace('"1.00"', '"0.99"'));
    expect(changed.ok && parsed.ok && changed.budget.contentDigest !== parsed.budget.contentDigest).toBe(true);
  });

  it('rejects unsafe shapes', () => {
    const cases: Array<[string, RegExp]> = [
      ['{"schemaVersion":1,"max":{"request":{"tokens":1,"tokens":2}}}', /duplicate key/],
      ['{"schemaVersion":1,"schemaVersion":1,"max":{}}', /duplicate key/],
      ['{"schemaVersion":1,"max":{"request":{"tokens":1e3}}}', /exponent/],
      ['{"schemaVersion":1,"max":{"request":{"tokens":-1}}}', /negative/],
      ['{"schemaVersion":1,"max":{"request":{"tokens":[1]}}}', /arrays/],
      ['{"schemaVersion":1,"max":{"request":{"tokens":1.5}}}', /whole number/],
      ['{"schemaVersion":1,"max":{"request":{"usd":5}}}', /decimal string/],
      ['{"schemaVersion":1,"max":{}, }', /not valid JSON/],
      ['// hi\n{"schemaVersion":1,"max":{}}', /comments|not valid JSON/],
      ['{"schemaVersion":2,"max":{}}', /schemaVersion/],
      [`{"schemaVersion":1,"max":{"agents":{"${'a'.repeat(200)}":{"tokens":1}}}}`, /agent id/],
    ];
    for (const [text, reason] of cases) {
      const parsed = parseRepositoryBudget(text);
      expect(parsed.ok, text).toBe(false);
      if (!parsed.ok) expect(parsed.reason, text).toMatch(reason);
    }
    expect(parseRepositoryBudget(' '.repeat(64 * 1024 + 1))).toMatchObject({ ok: false });
  });

  it('reports unknown keys without failing', () => {
    const parsed = parseRepositoryBudget('{"schemaVersion":1,"extra":true,"max":{"period":"day","request":{"tokens":5,"zone":"UTC"}}}');
    expect(parsed.ok && parsed.budget.unknownKeys).toEqual(['extra', 'max.period', 'max.request.zone']);
  });
});

describe('effective targets', () => {
  const user = parseUserTargets(userSettings);
  const repo = (() => {
    const parsed = parseRepositoryBudget(JSON.stringify({ schemaVersion: 1, max: {
      request: { tokens: 10, usd: '99' },
      project: { tokens: 5 },
      agents: { worker: { tokens: 1 }, other: { tokens: 1 } },
    } }));
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.budget;
  })();

  it('ignore a repository proposal the user has not accepted, or whose content changed', () => {
    expect(effectiveTargets(user, repo, undefined).request.tokens).toEqual({ value: 1_000_000, repositoryNarrowed: false });
    expect(effectiveTargets(user, repo, 'f'.repeat(64)).request.tokens?.repositoryNarrowed).toBe(false);
  });

  it('only narrow an enabled user target after exact-digest acceptance', () => {
    const effective = effectiveTargets(user, repo, repo.contentDigest);
    expect(effective.request.tokens).toEqual({ value: 10, repositoryNarrowed: true });
    // A higher repository dollar value never widens the user's.
    expect(effective.request.nanoUsd).toEqual({ value: 5_000_000_000n, repositoryNarrowed: false });
    expect(effective.project?.tokens).toEqual({ value: 5, repositoryNarrowed: true });
    // The user set no project dollar target, so the repository cannot enable one.
    expect(effective.project?.nanoUsd).toEqual({ value: 50_000_000_000n, repositoryNarrowed: false });
    expect(effective.agents.worker.tokens).toEqual({ value: 1, repositoryNarrowed: true });
    expect(effective.agents.other).toBeUndefined();
  });

  it('never enables a reminder the user left off', () => {
    const off = parseUserTargets({ schemaVersion: 1 });
    const effective = effectiveTargets(off, repo, repo.contentDigest);
    expect(effective.request).toEqual({});
    expect(effective.project).toBeUndefined();
    expect(effective.agents).toEqual({});
  });

  it('changes revision when a target, the accepted narrowing or the reference mode changes', () => {
    const base = targetRevision(effectiveTargets(user, repo, undefined), 'unselected');
    expect(targetRevision(effectiveTargets(user, repo, undefined), 'unselected')).toBe(base);
    expect(targetRevision(effectiveTargets(user, repo, repo.contentDigest), 'unselected')).not.toBe(base);
    expect(targetRevision(effectiveTargets(user, repo, undefined), 'unode')).not.toBe(base);
    expect(targetRevision(effectiveTargets(parseUserTargets({ ...userSettings, request: { tokens: 7 } }), repo, undefined), 'unselected')).not.toBe(base);
  });
});

describe('periods', () => {
  it('uses the target zone, including across DST', () => {
    // 2026-11-01 07:30Z is 00:30 PDT->PST day boundary area in Vancouver: still Nov 1 locally.
    expect(periodIdFor(Date.parse('2026-11-01T07:30:00Z'), 'day', 'America/Vancouver')).toBe('2026-11-01@America/Vancouver');
    expect(periodIdFor(Date.parse('2026-11-01T06:30:00Z'), 'day', 'America/Vancouver')).toBe('2026-10-31@America/Vancouver');
    expect(periodIdFor(Date.parse('2026-10-31T23:30:00Z'), 'month', 'Asia/Shanghai')).toBe('2026-11@Asia/Shanghai');
    expect(periodIdFor(Date.parse('2026-10-31T23:30:00Z'), 'month', 'UTC')).toBe('2026-10@UTC');
    expect(periodIdFor(0, 'day', 'Not/AZone')).toBeUndefined();
  });
});
