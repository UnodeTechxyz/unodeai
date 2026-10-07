import { describe, it, expect } from 'vitest';
import {
  LEGACY_FALLBACK_BRANCH_LABEL,
  decideGate,
  migrateWorkflowBranchLabel,
  resolveBranch,
  WorkflowGate,
} from '../GatedWorkflow';

describe('resolveBranch (P2 conditional routing)', () => {
  it('returns undefined when there are no branches', () => {
    expect(resolveBranch(undefined, 'anything')).toBeUndefined();
    expect(resolveBranch([], 'anything')).toBeUndefined();
  });

  it('matches only an exact declared structured label', () => {
    const branches = [
      { label: 'fail', goto: 'fix' },
      { label: 'pass', goto: 'ship' },
    ];
    expect(resolveBranch(branches, 'fail')).toBe('fix');
    expect(resolveBranch(branches, 'pass')).toBe('ship');
    expect(resolveBranch(branches, 'not approved')).toBeUndefined();
    expect(resolveBranch(branches, 'FAIL')).toBeUndefined();
  });

  it('falls through when no structured label was selected', () => {
    expect(resolveBranch([{ label: 'x', goto: 'a' }], undefined)).toBeUndefined();
    expect(resolveBranch([{ label: 'x', goto: 'a' }], 'no match')).toBeUndefined();
  });

  // A pre-0.9.70 branch with no condition always matched. Migrating it to a plain label would lose that,
  // because the agent is never shown the reserved label and so could never select it.
  describe('a migrated pre-0.9.70 unconditional branch', () => {
    const branches = [
      { label: 'pass', goto: 'ship' },
      { label: LEGACY_FALLBACK_BRANCH_LABEL, fallback: true as const, goto: 'review' },
    ];

    it('is taken when no label was selected, and when the selection matches nothing', () => {
      expect(resolveBranch(branches, undefined)).toBe('review');
      expect(resolveBranch(branches, 'something else')).toBe('review');
    });

    it('never wins over an exact declared label', () => {
      expect(resolveBranch(branches, 'pass')).toBe('ship');
    });

    it('cannot be selected by name, even if an agent guesses the reserved label', () => {
      expect(resolveBranch(
        [{ label: LEGACY_FALLBACK_BRANCH_LABEL, fallback: true as const, goto: 'review' },
          { label: 'pass', goto: 'ship' }],
        'pass',
      )).toBe('ship');
    });
  });

  describe('migrateWorkflowBranchLabel', () => {
    it('keeps a real label and does not invent a fallback', () => {
      expect(migrateWorkflowBranchLabel({ label: 'pass' })).toEqual({ label: 'pass' });
    });

    it('turns a legacy substring into an exact label', () => {
      expect(migrateWorkflowBranchLabel({ whenResultContains: 'approved' })).toEqual({ label: 'approved' });
    });

    it('turns an unconditional branch, including an empty substring, into a fallback', () => {
      const expected = { label: LEGACY_FALLBACK_BRANCH_LABEL, fallback: true };
      expect(migrateWorkflowBranchLabel({})).toEqual(expected);
      expect(migrateWorkflowBranchLabel({ whenResultContains: '' })).toEqual(expected);
    });

    it('preserves an already-migrated fallback so a save cannot drop it', () => {
      expect(migrateWorkflowBranchLabel({ label: LEGACY_FALLBACK_BRANCH_LABEL, fallback: true }))
        .toEqual({ label: LEGACY_FALLBACK_BRANCH_LABEL, fallback: true });
    });
  });
});

const gate: WorkflowGate = {
  after: 'code',
  objective: true,
  onPass: { 'senior-dev': 'economy' },
  onFail: { setTier: { 'senior-dev': 'premium' }, maxRetries: 2, onExhaust: 'human' },
};

describe('decideGate (P2 gated workflow)', () => {
  it('proceeds and applies onPass tiers when the check passes', () => {
    const d = decideGate(gate, true, 1);
    expect(d.proceed).toBe(true);
    expect(d.applyTiers).toEqual({ 'senior-dev': 'economy' });
    expect(d.retry).toBe(false);
  });

  it('retries with escalated tier on the first failure', () => {
    const d = decideGate(gate, false, 1);
    expect(d.proceed).toBe(false);
    expect(d.retry).toBe(true);
    expect(d.applyTiers).toEqual({ 'senior-dev': 'premium' });
    expect(d.escalate).toBe('none');
  });

  it('keeps retrying up to maxRetries', () => {
    expect(decideGate(gate, false, 2).retry).toBe(true); // 2 <= 2
    expect(decideGate(gate, false, 3).retry).toBe(false); // exhausted
  });

  it('escalates to human once retries are exhausted', () => {
    const d = decideGate(gate, false, 3);
    expect(d.escalate).toBe('human');
    expect(d.proceed).toBe(false);
  });

  it('defaults maxRetries=1 and onExhaust=human when onFail omitted', () => {
    const bare: WorkflowGate = { after: 'x', objective: true };
    expect(decideGate(bare, false, 1).retry).toBe(true);
    expect(decideGate(bare, false, 2).escalate).toBe('human');
  });

  it('supports re-routing the retry to another role', () => {
    const routed: WorkflowGate = { after: 'x', onFail: { route: 'architect', maxRetries: 1 } };
    expect(decideGate(routed, false, 1).route).toBe('architect');
  });
});
