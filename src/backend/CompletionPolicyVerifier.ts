import { prepareCompletionVerificationCheck, type CompletionVerificationCheckOptions,
  type VerificationCheckOutcome } from './CompletionVerificationCheck';
import type { VerifyResult } from './Verifier';

export interface PolicyVerifyResult extends VerifyResult {
  /** Retain the observed fact for evidence and budgets; legacy merge status is only an adapter. */
  check: VerificationCheckOutcome;
}

/** Preserve the typed observation while adapting to the existing review-board status vocabulary. */
export function policyVerifyResult(check: VerificationCheckOutcome): PolicyVerifyResult {
  switch (check.kind) {
    case 'passed': return { status: 'passed', command: check.command, output: check.output, check };
    case 'failed': return { status: 'failed', command: check.command, output: check.output, check };
    case 'not-run': return { status: 'skipped', command: '', output: check.detail, blocked: true, check };
    case 'outcome-unknown': return { status: 'failed', command: check.command, output: check.output, blocked: true, check };
  }
}

/**
 * Unattended verifier adapter for worktrees/workflows. The host captures the original request and policy in
 * optionsFor; the actual execution cwd always comes from verify(). There is no interactive approval or default
 * executor fallback. A merge requires an observed pass, including when command checks are disabled.
 */
export class CompletionPolicyVerifier {
  constructor(private readonly optionsFor: (cwd: string) => Omit<CompletionVerificationCheckOptions, 'cwd' | 'requestApproval'>) {}

  async verify(cwd: string): Promise<PolicyVerifyResult> {
    const options = this.optionsFor(cwd);
    const check = await prepareCompletionVerificationCheck({ ...options, cwd, requestApproval: undefined }).run();
    return policyVerifyResult(check);
  }
}
