import { describe, expect, it } from 'vitest';
import {
  deriveWorkerTaskProgressDistribution,
  WorkerTaskProgressRecord,
  WorkerTaskProgressTracker,
} from '../WorkerTaskProgress';

describe('WorkerTaskProgressTracker', () => {
  it('measures the longest gap without mistaking repeated work or secrets for material progress', () => {
    let now = 0;
    const tracker = new WorkerTaskProgressTracker(() => now);
    tracker.begin({
      sessionId: 'dev',
      correlationId: 'handle-1',
      agentId: 'dev',
      backend: 'claude',
      model: 'claude-sonnet',
    });

    now = 5_000;
    tracker.noteModelRequest('dev');
    now = 10_000;
    tracker.noteToolUse('dev', 'read_file', { path: 'src/app.ts', token: 'must-not-be-retained' });
    now = 70_000;
    tracker.noteToolUse('dev', 'read_file', { path: 'src/app.ts', token: 'must-not-be-retained' });
    now = 90_000;
    tracker.noteToolUse('dev', 'run_checks', {});
    now = 95_000;
    tracker.noteToolResult('dev', 'run_checks', true);
    now = 150_000;
    const record = tracker.finish('dev', {
      text: 'Checks passed.',
      isError: false,
      usage: { inputTokens: 321, outputTokens: 12 },
      delegationEvidence: {
        hadToolActions: true,
        changedFiles: [],
        verification: { ran: true, passed: true },
      },
    })!;

    expect(record).toMatchObject({
      correlationId: 'handle-1',
      durationMs: 150_000,
      modelRequests: 1,
      toolCalls: 3,
      inputTokens: 321,
      materialProgressCount: 4,
      longestNoMaterialProgressMs: 80_000,
      outcome: 'framework-evidenced-output',
      terminalState: 'completed',
    });
    expect(record.fingerprintSequence).toHaveLength(3);
    expect(record.fingerprintSequence[0]).toBe(record.fingerprintSequence[1]);
    expect(JSON.stringify(record.fingerprintSequence)).not.toContain('must-not-be-retained');
  });

  it('reports non-overlapping cohorts with quantiles and buckets, never a mean', () => {
    const records = [
      ...Array.from({ length: 8 }, (_, i) => progressRecord(`evidenced-${i}`, 'framework-evidenced-output', 5 * 60_000, i % 2 === 0 ? 30_000 : 45_000)),
      ...Array.from({ length: 8 }, (_, i) => progressRecord(`missing-${i}`, 'no-framework-evidence', 5 * 60_000, i % 2 === 0 ? 6 * 60_000 : 7 * 60_000)),
    ];

    const distribution = deriveWorkerTaskProgressDistribution(records, 5 * 60_000);

    expect(distribution.separation).toBe('evidenced-below-no-evidence');
    expect(distribution.frameworkEvidencedOutput.noMaterialProgressMs).toMatchObject({ min: 30_000, p50: 30_000, max: 45_000 });
    expect(distribution.noFrameworkEvidence.noMaterialProgressMs).toMatchObject({ min: 6 * 60_000, p50: 6 * 60_000, max: 7 * 60_000 });
    expect(distribution.frameworkEvidencedOutput.buckets).toEqual(expect.arrayContaining([
      { label: '15s–<1m', count: 8 },
    ]));
    expect(distribution.noFrameworkEvidence.buckets).toEqual(expect.arrayContaining([
      { label: '5m–<15m', count: 8 },
    ]));
    expect(distribution.frameworkEvidencedOutput.noMaterialProgressMs).not.toHaveProperty('mean');
  });

  it('returns a stop signal when the cohorts overlap or lack the minimum sample size', () => {
    const overlap = deriveWorkerTaskProgressDistribution([
      ...Array.from({ length: 8 }, (_, i) => progressRecord(`evidenced-${i}`, 'framework-evidenced-output', 5 * 60_000, 6 * 60_000)),
      ...Array.from({ length: 8 }, (_, i) => progressRecord(`missing-${i}`, 'no-framework-evidence', 5 * 60_000, 5 * 60_000)),
    ], 5 * 60_000);
    const missingCohort = deriveWorkerTaskProgressDistribution([
      progressRecord('only-evidenced', 'framework-evidenced-output', 5 * 60_000, 20_000),
    ], 5 * 60_000);

    expect(overlap.separation).toBe('overlap-or-reversed');
    expect(missingCohort.separation).toBe('insufficient-data');
  });

  it('does not call one record per cohort a separation even when their ranges do not overlap', () => {
    const distribution = deriveWorkerTaskProgressDistribution([
      progressRecord('evidenced-one', 'framework-evidenced-output', 5 * 60_000, 30_000),
      progressRecord('missing-one', 'no-framework-evidence', 5 * 60_000, 6 * 60_000),
    ], 5 * 60_000);

    expect(distribution.frameworkEvidencedOutput.count).toBe(1);
    expect(distribution.noFrameworkEvidence.count).toBe(1);
    expect(distribution.separation).toBe('insufficient-data');
  });
});

function progressRecord(
  correlationId: string,
  outcome: WorkerTaskProgressRecord['outcome'],
  durationMs: number,
  longestNoMaterialProgressMs: number,
): WorkerTaskProgressRecord {
  return {
    schemaVersion: 1,
    correlationId,
    agentId: 'dev',
    backend: 'claude',
    model: 'claude-sonnet',
    startedAt: '2026-08-11T00:00:00.000Z',
    settledAt: '2026-08-11T00:05:00.000Z',
    durationMs,
    modelRequests: 1,
    toolCalls: outcome === 'framework-evidenced-output' ? 1 : 0,
    fingerprintSequence: [],
    droppedFingerprintCount: 0,
    materialProgressCount: outcome === 'framework-evidenced-output' ? 1 : 0,
    lastMaterialProgressAt: '2026-08-11T00:00:00.000Z',
    longestNoMaterialProgressMs,
    outcome,
    hasFinalReply: true,
    terminalState: outcome === 'framework-evidenced-output' ? 'completed' : 'error-or-unresolved',
  };
}
