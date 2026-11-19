import type { VerificationCheckOutcome } from '../backend/CompletionVerificationCheck';
import type { VerificationPolicySource } from '../backend/CompletionVerificationPolicy';

/** Bounded host facts only. No command, output, error text, approval receipt or executable policy is retained. */
export type CompletionCheckObservation =
  | { kind: 'passed'; source: VerificationPolicySource }
  | { kind: 'outcome-unknown'; source: VerificationPolicySource }
  | { kind: 'failed'; source: VerificationPolicySource; reason: 'exit-nonzero' | 'timeout-stopped' }
  | { kind: 'not-run'; source: VerificationPolicySource; reason: Extract<VerificationCheckOutcome, { kind: 'not-run' }>['reason'] };

export function parseCompletionCheckObservation(raw: unknown): CompletionCheckObservation | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const source = value.source;
  if (source !== 'team-document' && source !== 'legacy-global' && source !== 'legacy-default') return undefined;
  if (value.kind === 'passed' || value.kind === 'outcome-unknown') return { kind: value.kind, source };
  if (value.kind === 'failed' && (value.reason === 'exit-nonzero' || value.reason === 'timeout-stopped')) {
    return { kind: value.kind, source, reason: value.reason };
  }
  if (value.kind === 'not-run' && (value.reason === 'disabled' || value.reason === 'configuration-invalid'
    || value.reason === 'not-applicable' || value.reason === 'policy-stale' || value.reason === 'approval-required'
    || value.reason === 'policy-blocked' || value.reason === 'spawn-failed')) {
    return { kind: value.kind, source, reason: value.reason };
  }
  return undefined;
}

export function completionCheckLabel(check: CompletionCheckObservation): string {
  if (check.kind === 'passed') return 'ran and passed';
  if (check.kind === 'outcome-unknown') return 'outcome unknown (not verified)';
  if (check.kind === 'failed') return check.reason === 'timeout-stopped' ? 'failed (timed out and stopped)' : 'ran and failed';
  const reasons: Record<Extract<CompletionCheckObservation, { kind: 'not-run' }>['reason'], string> = {
    disabled: 'disabled for this team', 'not-applicable': 'not applicable', 'configuration-invalid': 'invalid configuration',
    'policy-stale': 'request or policy changed', 'approval-required': 'approval required',
    'policy-blocked': 'blocked by current permissions', 'spawn-failed': 'could not start',
  };
  return `not run — ${reasons[check.reason]}`;
}
