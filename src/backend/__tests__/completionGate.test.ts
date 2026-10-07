import { describe, it, expect } from 'vitest';
import {
  decideCompletionGate,
  maxGateAttempts,
  buildGateRetryMessage,
  buildGateHandoffMessage,
  gateOutputTail,
  isMisconfiguredCheckOutput,
  buildGateMisconfiguredMessage,
  DEFAULT_COMPLETION_GATE_CONFIG,
  CompletionGateConfig,
} from '../completionGate';

describe('isMisconfiguredCheckOutput', () => {
  it('flags a broken/misconfigured verify command (not a code failure)', () => {
    expect(isMisconfiguredCheckOutput('This is not the tsc command you are looking for')).toBe(true);
    expect(isMisconfiguredCheckOutput('bash: npx: command not found')).toBe(true);
    expect(isMisconfiguredCheckOutput("'tsc' is not recognized as an internal or external command")).toBe(true);
    expect(isMisconfiguredCheckOutput('npm ERR! Missing script: "test"')).toBe(true);
    expect(isMisconfiguredCheckOutput('npx: could not determine executable to run')).toBe(true);
  });
  it('does NOT flag a real code/test failure', () => {
    expect(isMisconfiguredCheckOutput('Tests: 1 failed, 4 passed. Expected 5 to equal 6.')).toBe(false);
    expect(isMisconfiguredCheckOutput('src/app.ts(10,3): error TS2322: Type string is not assignable to number.')).toBe(false);
    expect(isMisconfiguredCheckOutput('')).toBe(false);
  });
  it('builds a message that points at the setting, not the code', () => {
    const msg = buildGateMisconfiguredMessage('npx tsc --noEmit', 'This is not the tsc command…');
    expect(msg).toMatch(/unode\.verifyCommand/);
    expect(msg).toMatch(/not a code (defect|failure)/i);
  });
});

describe('decideCompletionGate', () => {
  it('passes immediately when checks are green, regardless of attempts', () => {
    expect(decideCompletionGate(true, 0)).toEqual({ kind: 'pass' });
    expect(decideCompletionGate(true, 99)).toEqual({ kind: 'pass' });
  });

  it('runs self-fix retries first, then escalated (redelegated) retries', () => {
    const cfg: CompletionGateConfig = { maxSelfRetries: 2, maxRedelegations: 1 };
    expect(decideCompletionGate(false, 0, cfg)).toEqual({ kind: 'retry', attempt: 1, escalate: false });
    expect(decideCompletionGate(false, 1, cfg)).toEqual({ kind: 'retry', attempt: 2, escalate: false });
    // self budget (2) spent → escalate
    expect(decideCompletionGate(false, 2, cfg)).toEqual({ kind: 'retry', attempt: 3, escalate: true });
  });

  it('hands off to a human once the budget is exhausted — and stays handed off', () => {
    const cfg: CompletionGateConfig = { maxSelfRetries: 2, maxRedelegations: 1 };
    expect(decideCompletionGate(false, 3, cfg)).toEqual({ kind: 'handoff', attempts: 3 });
    expect(decideCompletionGate(false, 4, cfg)).toEqual({ kind: 'handoff', attempts: 4 });
    expect(decideCompletionGate(false, 1000, cfg)).toEqual({ kind: 'handoff', attempts: 1000 });
  });

  it('GUARANTEE: a forever-red project can never loop — it terminates in handoff within maxGateAttempts', () => {
    const cfg = DEFAULT_COMPLETION_GATE_CONFIG;
    const cap = maxGateAttempts(cfg);
    let attempts = 0;
    let retries = 0;
    // Simulate the runtime loop: checks NEVER pass.
    for (let guard = 0; guard < 1000; guard++) {
      const out = decideCompletionGate(false, attempts, cfg);
      if (out.kind === 'handoff') {
        expect(out.attempts).toBe(attempts);
        break;
      }
      expect(out.kind).toBe('retry');
      retries++;
      attempts++;
      expect(retries).toBeLessThanOrEqual(cap); // never more retries than the ladder allows
    }
    expect(retries).toBe(cap); // exactly the budget, then handoff
    expect(decideCompletionGate(false, attempts, cfg).kind).toBe('handoff');
  });

  it('a zero-budget config hands off on the first failure (no retries at all)', () => {
    const cfg: CompletionGateConfig = { maxSelfRetries: 0, maxRedelegations: 0 };
    expect(maxGateAttempts(cfg)).toBe(0);
    expect(decideCompletionGate(false, 0, cfg)).toEqual({ kind: 'handoff', attempts: 0 });
  });

  it('clamps negative knobs so a misconfig can never create an unbounded ladder', () => {
    const cfg: CompletionGateConfig = { maxSelfRetries: -5, maxRedelegations: -2 };
    expect(maxGateAttempts(cfg)).toBe(0);
    expect(decideCompletionGate(false, 0, cfg).kind).toBe('handoff');
  });
});

describe('gate messages', () => {
  it('tail-trims long output but keeps short output intact', () => {
    expect(gateOutputTail('short')).toBe('short');
    const big = 'x'.repeat(5000);
    const tail = gateOutputTail(big, 4000);
    expect(tail.length).toBeLessThan(big.length);
    expect(tail.startsWith('…')).toBe(true);
  });

  it('retry message differs for escalation and always forbids reporting done', () => {
    const normal = buildGateRetryMessage('npm test', 'FAIL: auth.ts', false);
    const esc = buildGateRetryMessage('npm test', 'FAIL: auth.ts', true);
    expect(normal).toMatch(/not done yet/i);
    expect(normal).toContain('npm test');
    expect(esc).toContain('stronger/different teammate');
    expect(esc).not.toBe(normal);
  });

  it('handoff message offers human options and never implies abandonment', () => {
    const msg = buildGateHandoffMessage('npm test', 3, 'FAIL');
    expect(msg).toContain('Blocked');
    expect(msg).toContain('3 fix attempts');
    expect(msg).toMatch(/stronger model/i);
    expect(msg).toMatch(/reassign/i);
    expect(msg).toMatch(/take it over/i);
  });
});
