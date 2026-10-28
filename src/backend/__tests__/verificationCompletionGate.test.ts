import { describe, expect, it } from 'vitest';
import { decideVerificationCompletionGate } from '../completionGate';
import type { VerificationCheckOutcome } from '../CompletionVerificationCheck';

const binding = { workspaceId: 'workspace-A', policyDigest: 'digest', source: 'team-document' as const, teamKind: 'software' as const };
const context = { binding, source: 'team-document' as const };

describe('typed completion gate decisions', () => {
  it.each(['configuration-invalid', 'not-applicable', 'policy-stale', 'approval-required', 'policy-blocked', 'spawn-failed'] as const)(
    '%s preserves the obstacle without consuming repair budget or claiming a sensor passed', reason => {
      const check: VerificationCheckOutcome = { ...context, kind: 'not-run', reason, detail: 'obstacle' };
      for (const attempts of [0, 1, 2, 3, 99]) {
        expect(decideVerificationCompletionGate(check, attempts, false)).toEqual({
          kind: 'not-run', reason, commandSensorPassed: false, deliveryAllowed: false,
        });
      }
    },
  );
  it('allows disabled-team delivery only when no command sensor is required, without inventing a pass', () => {
    const check: VerificationCheckOutcome = { ...context, kind: 'not-run', reason: 'disabled', detail: 'disabled' };
    expect(decideVerificationCompletionGate(check, 0, false)).toEqual({
      kind: 'not-run', reason: 'disabled', commandSensorPassed: false, deliveryAllowed: true,
    });
    expect(decideVerificationCompletionGate(check, 0, true)).toMatchObject({ kind: 'not-run', deliveryAllowed: false });
  });
  it('unknown termination cannot deliver or request another implementation attempt', () => {
    const check: VerificationCheckOutcome = { ...context, kind: 'outcome-unknown', command: 'npm test', output: 'unconfirmed' };
    expect(decideVerificationCompletionGate(check, 0, false)).toEqual({
      kind: 'not-run', reason: 'outcome-unknown', commandSensorPassed: false, deliveryAllowed: false,
    });
  });
  it.each(['exit-nonzero', 'timeout-stopped'] as const)('only observed %s follows the bounded repair ladder', reason => {
    const check: VerificationCheckOutcome = { ...context, kind: 'failed', command: 'npm test', reason, output: 'failure' };
    expect([0, 1, 2, 3].map(attempts => decideVerificationCompletionGate(check, attempts, true))).toEqual([
      { kind: 'retry', attempt: 1, escalate: false }, { kind: 'retry', attempt: 2, escalate: false },
      { kind: 'retry', attempt: 3, escalate: true }, { kind: 'handoff', attempts: 3 },
    ]);
  });
  it('only an observed exit zero satisfies the command sensor', () => {
    expect(decideVerificationCompletionGate({ ...context, kind: 'passed', command: 'npm test', exitCode: 0, output: 'ok' }, 99, true))
      .toEqual({ kind: 'pass', commandSensorPassed: true });
  });
  it('honors non-default self-retry and redelegation budgets', () => {
    const check: VerificationCheckOutcome = { ...context, kind: 'failed', command: 'npm test', reason: 'exit-nonzero', output: 'failure' };
    const cfg = { maxSelfRetries: 0, maxRedelegations: 2 };
    expect(decideVerificationCompletionGate(check, 0, true, cfg)).toEqual({ kind: 'retry', attempt: 1, escalate: true });
    expect(decideVerificationCompletionGate(check, 1, true, cfg)).toEqual({ kind: 'retry', attempt: 2, escalate: true });
    expect(decideVerificationCompletionGate(check, 2, true, cfg)).toEqual({ kind: 'handoff', attempts: 2 });
    expect(decideVerificationCompletionGate(check, 0, true, { maxSelfRetries: 0, maxRedelegations: 0 }))
      .toEqual({ kind: 'handoff', attempts: 0 });
  });
});
