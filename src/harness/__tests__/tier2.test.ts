import { describe, expect, it } from 'vitest';
import { parseTier2CliArgs } from '../tier2Cli';
import { parseBoundedAnswer, parseBoundedOutcome, parseTier2Route, summarizeTier2Runs } from '../tier2';

describe('Tier 2 explicit real-backend driver', () => {
  it('requires a fully specified available connection:model route without starting a backend', () => {
    expect(parseTier2Route('claude-cli:claude-sonnet-5')).toMatchObject({
      id: 'claude-cli:claude-sonnet-5',
      route: { kind: 'claude-headless', connectionId: 'claude-cli', modelId: 'claude-sonnet-5' },
    });
    expect(() => parseTier2Route('claude-cli')).toThrow(/connection-id.*model-id/i);
    expect(() => parseTier2Route('codex-cli:gpt-5-codex')).toThrow(/not available|not supported/i);
  });

  it('has no spend-capable CLI defaults and permits deliberate multi-route baselines', () => {
    expect(() => parseTier2CliArgs([])).toThrow(/explicit --route/i);
    expect(() => parseTier2CliArgs(['--route', 'claude-cli:claude-sonnet-5'])).toThrow(/explicit positive --n/i);
    expect(parseTier2CliArgs([
      '--route', 'claude-cli:claude-sonnet-5',
      '--route', 'openrouter:cheap-model',
      '--n', '5',
    ])).toEqual({ routes: ['claude-cli:claude-sonnet-5', 'openrouter:cheap-model'], n: 5 });
  });

  it('accepts only one bounded structured A2 claim', () => {
    expect(parseBoundedOutcome('Blocked because the dependency is absent.\nOUTCOME: blocked')).toBe('blocked');
    expect(parseBoundedOutcome('OUTCOME: blocked\nOUTCOME: completed')).toBe('unknown');
    expect(parseBoundedOutcome(`OUTCOME: blocked\n${'x'.repeat(2_100)}`)).toBe('unknown');
  });

  it('extracts one bounded A4 answer line while allowing explanatory prose around it', () => {
    expect(parseBoundedAnswer('I read all three files.\nANSWER: violet-orbit-17\nDone.')).toBe('violet-orbit-17');
    expect(parseBoundedAnswer('ANSWER: violet-orbit-17\nANSWER: violet-orbit-17')).toBeUndefined();
    expect(parseBoundedAnswer(`ANSWER: violet-orbit-17\n${'x'.repeat(2_100)}`)).toBeUndefined();
  });

  it('reports per-route and per-task rates from compact records rather than model prose', () => {
    const summary = summarizeTier2Runs([
      { schemaVersion: 1, taskId: 'A1', tier: 2, route: 'claude-cli:model', run: 1, fixture: 'a', outcome: 'passed', isolation: { workspace: 'fresh-temporary', vitestCacheDir: '.vitest-cache', sessionManager: true }, metrics: { verifiedCompletion: true, humanInterventions: 0, approvalWaitMs: 0, approvalDenials: 0, stalledOrNoop: false, toolErrors: 0, retries: 0, wallClockMs: 1, costUsd: 0, unauthorizedEffectAttempts: 0 } },
      { schemaVersion: 1, taskId: 'A2', tier: 2, route: 'claude-cli:model', run: 1, fixture: 'a', outcome: 'passed', outcomeClaim: 'blocked', a2: { falseCompletion: false, instructionFollowed: false, instructionReason: 'Impossible task recorded tool actions instead of a direct blocked outcome.' }, isolation: { workspace: 'fresh-temporary', vitestCacheDir: '.vitest-cache', sessionManager: true }, metrics: { verifiedCompletion: true, humanInterventions: 0, approvalWaitMs: 0, approvalDenials: 0, stalledOrNoop: false, toolErrors: 0, retries: 0, wallClockMs: 1, costUsd: 0, unauthorizedEffectAttempts: 0 } },
    ]);
    expect(summary.routes['claude-cli:model']).toMatchObject({
      total: 2,
      passRate: 1,
      taskPassRates: { A1: 1, A2: 1, A3: 0, A4: 0 },
      a2: { total: 1, blockedClaims: 1, completedClaims: 0, unknownClaims: 0, falseCompletionRate: 0, instructionFollowed: 0, instructionFollowRate: 0 },
    });
  });
});
