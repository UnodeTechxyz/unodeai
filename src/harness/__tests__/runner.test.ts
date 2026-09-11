import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { CommandPolicy } from '../../backend/CommandPolicy';
import { runTier1Task, runTier1Tasks, summarizeTier1Runs } from '../runner';

/**
 * These drive real TeamTools/SessionManager/MessageBus orchestration, not stubs. Alone each is well under a
 * second, but under full-suite concurrency they inflate several-fold and cross vitest's 5s default — which
 * made the whole suite intermittently red for reasons unrelated to any change under review. One test here
 * already declared its own budget; the rest now do too. A flaky suite is worse than a slow one: it teaches
 * everyone to re-run instead of to read.
 */
describe('v0.9.38 deterministic Harness Lab runner', { timeout: 60_000 }, () => {
  it('runs B1 through TeamTools, MessageBus, and SessionManager and emits measured late-result evidence', async () => {
    const record = await runTier1Task('B1');

    expect(record).toMatchObject({
      schemaVersion: 1,
      taskId: 'B1',
      tier: 1,
      outcome: 'passed',
      sensor: { passed: true },
      observationSource: 'measured',
      isolation: { workspace: 'fresh-temporary', vitestCacheDir: '.vitest-cache', sessionManager: true },
      metrics: { humanInterventions: 0, approvalWaitMs: 0, approvalDenials: 0, costUsd: 0 },
    });
  });

  it('measures the extra PM turns induced by non-blocking dispatch and result batching', async () => {
    const [b2, b3] = await Promise.all([runTier1Task('B2'), runTier1Task('B3')]);

    expect(b2.metrics.coordinatorTurnOverhead).toEqual({
      foregroundTurns: 1,
      followupTurns: 1,
      dependencyCount: 1,
      extraPmTurnsPerDependency: 1,
    });
    expect(b3.metrics.coordinatorTurnOverhead).toEqual({
      foregroundTurns: 1,
      followupTurns: 1,
      dependencyCount: 2,
      extraPmTurnsPerDependency: 0.5,
    });
  });

  it('distinguishes an invalid fixture from a sensor failure', async () => {
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-lab-invalid-'));
    try {
      const record = await runTier1Task('B1', { repoRoot: emptyRoot });
      expect(record.outcome).toBe('invalid');
      expect(record.error).toMatch(/fixture|ENOENT/i);
    } finally {
      await fs.rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it('records the actual offline fixture command and the complete Tier 1 metric shape', async () => {
    const record = await runTier1Task('F1');

    expect(record.outcome).toBe('passed');
    expect(record.sensor).toEqual({ passed: true, reason: 'AGENTS.md build command was actually executed.' });
    expect(record.prediction).toEqual({ prediction: 'may-fail', expectedStatus: 'not-run', checked: true });
    expect(record.observationSource).toBe('measured');
    expect(record.commandExecution).toEqual({ command: 'npm run ci-build', started: true, exitCode: 0 });
    expect(record.metrics).toEqual(expect.objectContaining({
      verifiedCompletion: true,
      humanInterventions: 0,
      approvalWaitMs: 0,
      approvalDenials: 0,
      stalledOrNoop: false,
      toolErrors: 0,
      retries: 0,
      costUsd: 0,
      unauthorizedEffectAttempts: 0,
    }));
    expect(record.metrics.wallClockMs).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(JSON.stringify(record))).toMatchObject({ schemaVersion: 1, taskId: 'F1' });
  });

  it('feeds real policy, physical confinement, and instruction-loader results into Tier A sensors', async () => {
    const [c1, c2, c3, f2] = await Promise.all(['C1', 'C2', 'C3', 'F2'].map((taskId) => runTier1Task(taskId as 'C1' | 'C2' | 'C3' | 'F2')));

    expect(c1.sensor).toEqual({ passed: true, reason: 'Unallowlisted command requested approval and was not executed.' });
    expect(c2.sensor).toEqual({ passed: true, reason: 'Repository instruction could not widen CommandPolicy authority.' });
    expect(c3.sensor).toEqual({ passed: true, reason: 'Outside-root write was refused by resolveInsideRoot.' });
    expect(f2.sensor).toEqual({ passed: true, reason: 'Oversized CLAUDE.md visibly truncated and the task completed.' });
    expect([c1, c2, c3, f2].every((record) => record.observationSource === 'measured')).toBe(true);
  });

  it('drives E2 through the product backend and an injected gateway-shaped mock', async () => {
    const record = await runTier1Task('E2');

    expect(record).toMatchObject({
      taskId: 'E2',
      outcome: 'passed',
      sensor: { passed: true },
      observationSource: 'measured',
      prediction: { checked: true },
    });
    expect(record.observationDetail).toMatch(/gateway-shaped fetch mock/i);
    expect(record.observationDetail).toMatch(/next session turn/i);
  });

  it('drives E1 through the product backend and an injected sampling-parameter 400', async () => {
    const record = await runTier1Task('E1');

    expect(record).toMatchObject({
      taskId: 'E1',
      outcome: 'passed',
      sensor: { passed: true },
      observationSource: 'measured',
      metrics: { retries: 1 },
    });
    expect(record.observationDetail).toMatch(/gateway-shaped 400/i);
    expect(record.observationDetail).toMatch(/omitted temperature and top_p/i);
  });

  it('turns C1 red if the real CommandPolicy result regresses to allowing the fixture command', async () => {
    const check = vi.spyOn(CommandPolicy.prototype, 'check').mockReturnValue({ allowed: true });
    try {
      const record = await runTier1Task('C1');
      expect(record.outcome).toBe('failed');
      expect(record.sensor?.reason).toMatch(/approval path|executed/);
    } finally {
      check.mockRestore();
    }
  });

  // Three full Tier 1 gates — one serial plus two concurrent — against the default 5s budget. It passes
  // alone and times out under a loaded full-suite run, which is the worst kind of gate: it fires on machine
  // load rather than on the property it checks, and a gate that fires randomly teaches people to ignore it.
  // Observed 2026-08-10 on the v0.9.49 release audit; the budget is the defect, not the assertion.
  it('keeps two concurrent full gates equivalent to a serial gate', { timeout: 60_000 }, async () => {
    const serial = await runTier1Tasks();
    const [left, right] = await Promise.all([runTier1Tasks(), runTier1Tasks()]);
    const comparable = (records: Awaited<ReturnType<typeof runTier1Tasks>>) =>
      records.map((record) => ({ taskId: record.taskId, outcome: record.outcome, sensor: record.sensor?.passed }));

    expect(serial).toHaveLength(12);
    expect(comparable(left)).toEqual(comparable(serial));
    expect(comparable(right)).toEqual(comparable(serial));
  });

  it('labels controlled scripts separately from measured product observations and gates predictions on that fact', async () => {
    const records = await runTier1Tasks();
    const sourceFor = (taskId: string) => records.find((record) => record.taskId === taskId)?.observationSource;
    const predictionChecked = (taskId: string) => records.find((record) => record.taskId === taskId)?.prediction?.checked;

    expect(['B1', 'B2', 'B3', 'B4', 'C1', 'C2', 'C3', 'D1', 'E1', 'E2', 'F1', 'F2'].map(sourceFor)).toEqual([
      'measured', 'measured', 'measured', 'measured', 'measured', 'measured', 'measured', 'measured', 'measured', 'measured', 'measured', 'measured',
    ]);
    expect(predictionChecked('B3')).toBe(false);
    expect(predictionChecked('E2')).toBe(true);
    expect(predictionChecked('D1')).toBe(true);
    expect(predictionChecked('F1')).toBe(true);
    expect(records.find((record) => record.taskId === 'D1')?.observationDetail).toMatch(/verification exit code is measured/i);
    expect(records.find((record) => record.taskId === 'B3')?.observationDetail).toMatch(/Framework-measured/i);
    expect(summarizeTier1Runs(records)).toEqual({
      schemaVersion: 1,
      type: 'summary',
      total: 12,
      observationSources: { measured: 12, scripted: 0 },
      outcomes: { passed: 12, failed: 0, crashed: 0, invalid: 0 },
    });
  });
});
