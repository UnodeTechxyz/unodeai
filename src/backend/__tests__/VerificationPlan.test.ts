import { describe, expect, it } from 'vitest';
import { classifyDelegationEvidence } from '../TeamTools';
import { evaluateVerificationPlan, parseVerificationPlan, type VerificationPlan } from '../VerificationPlan';

const fileEffectPlan: VerificationPlan = {
  sensors: ['recorded-file-effect'],
  noneApplies: 'report-no-applicable-sensor',
};
const checksPlan: VerificationPlan = {
  sensors: ['run-checks'],
  noneApplies: 'report-no-applicable-sensor',
};
const commandExitPlan: VerificationPlan = {
  sensors: ['command-exit-zero'],
  noneApplies: 'report-no-applicable-sensor',
};
const noSensorPlan: VerificationPlan = {
  sensors: [],
  noneApplies: 'report-no-applicable-sensor',
};
const active = (overrides: Record<string, unknown> = {}) => ({
  hadToolActions: true,
  changedFiles: [],
  verification: { ran: false, passed: false },
  ...overrides,
});

describe('per-task verification plan', () => {
  it('judges two tasks in one workspace by their declared plan, not the global command', () => {
    const fileTask = classifyDelegationEvidence('implemented', active({ changedFiles: ['src/a.ts'] }), fileEffectPlan);
    const checkTask = classifyDelegationEvidence('implemented', active({ changedFiles: ['src/a.ts'] }), checksPlan);

    expect(fileTask.outcome).toBe('verified');
    expect(checkTask.outcome).toBe('replied-not-verified');
    expect(fileTask.verificationPlanStatus).toBe('satisfied');
    expect(checkTask.verificationPlanStatus).toBe('not-run');
  });

  it('records no applicable sensor separately from a check that did not run and one that failed', () => {
    expect(classifyDelegationEvidence('documented', active(), noSensorPlan).outcome).toBe('no-applicable-sensor');
    expect(classifyDelegationEvidence('implemented', active({ changedFiles: ['a.ts'] }), checksPlan).outcome).toBe('replied-not-verified');
    expect(classifyDelegationEvidence('implemented', active({ changedFiles: ['a.ts'], verification: {
      ran: true, passed: false, source: 'run-checks',
    } }), checksPlan).outcome).toBe('verification-failed');
  });

  it('accepts every framework-observed zero-exit command only when the task declared that sensor', () => {
    for (const command of ['./run-tests.sh', 'bazel test', 'deno test', 'just test']) {
      const evidence = active({
        changedFiles: ['src/a.ts'],
        verification: { ran: true, passed: true, command, source: 'command-exit-zero' },
      });
      expect(classifyDelegationEvidence('Done', evidence, commandExitPlan).outcome, command).toBe('verified');
    }
  });

  it('does not infer a verification plan from command spelling or a zero exit', () => {
    const evidence = active({
      changedFiles: ['src/a.ts'],
      verification: { ran: true, passed: true, command: 'npm test', source: 'command-exit-zero' },
    });
    expect(classifyDelegationEvidence('Done', evidence).outcome).toBe('replied-not-verified');
  });

  it('records a declared command exit failure and keeps command and run_checks sources separate', () => {
    const failed = active({
      changedFiles: ['src/a.ts'],
      verification: { ran: true, passed: false, command: 'bazel test', source: 'command-exit-zero' },
    });
    expect(classifyDelegationEvidence('Done', failed, commandExitPlan).outcome).toBe('verification-failed');

    const runChecks = active({
      changedFiles: ['src/a.ts'],
      verification: { ran: true, passed: true, source: 'run-checks' },
    });
    expect(classifyDelegationEvidence('Done', runChecks, commandExitPlan).outcome).toBe('replied-not-verified');
    expect(classifyDelegationEvidence('Done', runChecks, checksPlan).outcome).toBe('verified');
  });

  it('accepts only closed, command-free sensor declarations', () => {
    expect(parseVerificationPlan({ sensors: ['run-checks'], none_applies: 'report-no-applicable-sensor' }).plan).toEqual(checksPlan);
    expect(parseVerificationPlan({ sensors: ['run-checks'], none_applies: 'report-no-applicable-sensor', command: 'npm test' }).error).toMatch(/only sensors/i);
    // A command is not a permitted plan field and cannot become a host action.
    expect(evaluateVerificationPlan(checksPlan, active()).status).toBe('not-run');
  });
});
