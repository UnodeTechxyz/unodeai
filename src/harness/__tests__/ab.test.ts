import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { readHarnessLabConfiguration, runA4FixtureRepairDemo, runProjectKnowledgeABProbe, runTier1AB, runTier2AB } from '../ab';
import { parseABCliArgs } from '../abCli';

const root = process.cwd();

describe('Harness Lab A/B driver', () => {
  it('requires two named configuration files and refuses a spend-capable half-invocation', () => {
    expect(() => parseABCliArgs([])).toThrow(/explicit --left and --right/i);
    expect(() => parseABCliArgs(['--left', 'a.json', '--right', 'b.json', '--route', 'unode:model'])).toThrow(/both.*--route.*--n/i);
    expect(parseABCliArgs(['--left', 'a.json', '--right', 'b.json'])).toEqual({ left: 'a.json', right: 'b.json', routes: [], n: undefined, demoA4Repair: false });
  });

  it('refuses named but otherwise identical control arms as a null experiment', async () => {
    const [left, right] = await Promise.all([
      readHarnessLabConfiguration('src/harness/fixtures/AB/control-left.json'),
      readHarnessLabConfiguration('src/harness/fixtures/AB/control-right.json'),
    ]);
    await expect(runTier1AB(left, right)).rejects.toThrow(/genuinely different effective axis/i);
  });

  it('runs the P2 full/progressive project-knowledge arms and proves their assembled contexts differ without a model call', async () => {
    const [left, right] = await Promise.all([
      readHarnessLabConfiguration('src/harness/fixtures/AB/p2-full.json'),
      readHarnessLabConfiguration('src/harness/fixtures/AB/p2-progressive.json'),
    ]);
    const tier1 = await runTier1AB(left, right);
    expect(tier1.records).toHaveLength(24);
    expect(tier1.records.every((record) => record.record.outcome === 'passed')).toBe(true);
    expect(tier1.records.find((record) => record.record.taskId === 'B1')?.configuration.notApplicableAxes).toContain('projectKnowledgeDisclosure');
    expect(tier1.summary.cost).toMatchObject({
      perProviderTurnTokens: { left: { totalRuns: 0, mean: null }, right: { totalRuns: 0, mean: null }, delta: null },
      taskTokens: { left: { totalRuns: 0, mean: null }, right: { totalRuns: 0, mean: null }, delta: null },
      taskCostUsd: { left: { totalRuns: 0, mean: null }, right: { totalRuns: 0, mean: null }, delta: null },
    });
    const probe = await runProjectKnowledgeABProbe(left, right, root);
    expect(probe).toMatchObject({ source: 'controlled-context-assembly', armsDiffer: true });
    expect(probe.contextByteDelta).toBeLessThan(0);
    expect(probe.note).toContain('no model-quality');
  }, 30_000);

  it('keeps the CI release chain on the real P2 arms instead of the retired identical-name control', async () => {
    const ci = await readFile('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('src/harness/fixtures/AB/p2-full.json');
    expect(ci).toContain('src/harness/fixtures/AB/p2-progressive.json');
    expect(ci).not.toContain('AB/control-left.json');
  });

  it('refuses an implementation comparison unless the two selected edit surfaces differ', async () => {
    await expect(runTier1AB(
      { name: 'edit-left', implementation: 'apply-edit' },
      { name: 'edit-right', implementation: 'apply-edit' },
    )).rejects.toThrow(/two distinct registered implementations/i);
  });

  it('refuses the retired legacy implementation value in a data configuration', async () => {
    await expect(runTier1AB(
      { name: 'retired', implementation: 'legacy-protocol-selection' as never },
      { name: 'current', implementation: 'apply-patch' },
    )).rejects.toThrow(/must be apply-edit or apply-patch/i);
  });

  it('refuses Tier 2 before an implementation comparison could consume a route budget', async () => {
    await expect(runTier2AB(
      { name: 'edit-left', implementation: 'apply-edit' },
      { name: 'edit-right', implementation: 'apply-edit' },
      [],
      1,
    )).rejects.toThrow(/two distinct registered implementations/i);
  });

  it('runs the P1 dialect arms on the implementation axis and records a real controllable difference', async () => {
    const result = await runTier1AB(
      { name: 'exact-snippet', implementation: 'apply-edit' },
      { name: 'patch-surface', implementation: 'apply-patch' },
    );
    const p1 = result.records.filter((record) => record.record.taskId === 'P1');

    expect(p1).toHaveLength(2);
    expect(p1.find((record) => record.side === 'left')?.record.outcome).toBe('failed');
    expect(p1.find((record) => record.side === 'right')?.record.outcome).toBe('passed');
    expect(result.summary.perTask.P1).toMatchObject({ passRateDelta: 1, fixturesMatch: true });
    expect(p1.every((record) => record.configuration.appliedAxes.includes('implementation'))).toBe(true);
  }, 30_000);

  it('demonstrates the predictable A4 repair direction without a model call or baseline rescore', async () => {
    const [left, right] = await Promise.all([
      readHarnessLabConfiguration('src/harness/fixtures/AB/a4-v0938-broken.json'),
      readHarnessLabConfiguration('src/harness/fixtures/AB/a4-v0939-repaired.json'),
    ]);
    const demo = await runA4FixtureRepairDemo(left, right, root);
    expect(demo).toMatchObject({ source: 'controlled-instrument-self-test', left: { outcome: 'failed' }, right: { outcome: 'passed' }, passRateDelta: 1 });
  });

});
