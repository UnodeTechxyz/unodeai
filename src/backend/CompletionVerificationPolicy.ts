import { createHash } from 'node:crypto';
import { teamKindFromSkills, type TeamRulesKind } from '../state/TeamKind';

/** Configuration only. Neither this document nor its resolver grants command execution. */
export type CompletionVerificationPolicy =
  | { mode: 'disabled' }
  | { mode: 'auto' }
  | { mode: 'command'; command: string };

export type VerificationPolicySource = 'team-document' | 'legacy-global' | 'legacy-default';

export type VerificationCommandIssue = 'not-string' | 'nul' | 'line-break' | 'empty' | 'too-long';

/** Same validation for parsing and diagnostic text; never includes raw command content in a diagnostic. */
export function completionVerificationCommandIssue(raw: unknown): VerificationCommandIssue | undefined {
  if (typeof raw !== 'string') return 'not-string';
  if (raw.includes('\0')) return 'nul';
  if (/[\r\n]/.test(raw)) return 'line-break';
  const bytes = Buffer.byteLength(raw.trim(), 'utf8');
  if (bytes === 0) return 'empty';
  if (bytes > 2_048) return 'too-long';
  return undefined;
}

export function verificationCommandIssueMessage(issue: VerificationCommandIssue): string {
  const messages: Record<VerificationCommandIssue, string> = {
    'not-string': 'The command must be a string.',
    nul: 'The command contains a NUL character, which is not allowed.',
    'line-break': 'The command contains a CR or LF line break; it must be a single line.',
    empty: 'The command is empty after trimming whitespace.',
    'too-long': 'The command exceeds 2,048 UTF-8 bytes after trimming whitespace.',
  };
  return messages[issue];
}

export interface VerificationBinding {
  /** The host supplies the existing workspaceRootIdentity, not a new team identity. */
  workspaceId: string;
  policyDigest: string;
  source: VerificationPolicySource;
  teamKind: TeamRulesKind;
}

export interface EffectiveVerificationPolicy {
  binding: VerificationBinding;
  policy: CompletionVerificationPolicy;
  source: VerificationPolicySource;
  teamKind: TeamRulesKind;
}

export type VerificationPolicyResolution =
  | { kind: 'resolved'; effective: EffectiveVerificationPolicy }
  | { kind: 'configuration-invalid'; source: 'team-document' | 'legacy-global';
      workspaceId: string; teamKind: TeamRulesKind; commandIssue?: VerificationCommandIssue };

export type ParsedCompletionVerificationPolicy =
  | { kind: 'missing' }
  | { kind: 'valid'; policy: CompletionVerificationPolicy }
  | { kind: 'invalid' };

/** Closed data schema. Invalid input must never become disabled, auto or a legacy fallback. */
export function parseCompletionVerificationPolicy(raw: unknown): ParsedCompletionVerificationPolicy {
  if (raw === undefined) return { kind: 'missing' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid' };
  const value = raw as Record<string, unknown>;
  if (value.mode === 'disabled' || value.mode === 'auto') {
    return Object.keys(value).length === 1
      ? { kind: 'valid', policy: { mode: value.mode } }
      : { kind: 'invalid' };
  }
  if (value.mode !== 'command' || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'mode') || !Object.hasOwn(value, 'command') || typeof value.command !== 'string') {
    return { kind: 'invalid' };
  }
  // Check forbidden characters before trim: a trailing newline is not a harmless command normalisation.
  if (completionVerificationCommandIssue(value.command)) return { kind: 'invalid' };
  const command = value.command.trim();
  return { kind: 'valid', policy: { mode: 'command', command } };
}

/**
 * Lazy legacy read is intentional: knowledge teams and explicit policies never read the old setting.
 * The host callback must use inspect().globalValue, never the merged workspace/repository get().
 */
export function resolveCompletionVerificationPolicy(input: {
  workspaceId: string;
  agentSkills: readonly string[];
  completionVerification?: unknown;
  readLegacyGlobalCommand: () => unknown;
}): VerificationPolicyResolution {
  const teamKind = teamKindFromSkills(input.agentSkills);
  const parsed = parseCompletionVerificationPolicy(input.completionVerification);
  const invalid = (source: 'team-document' | 'legacy-global', commandIssue?: VerificationCommandIssue): VerificationPolicyResolution => ({
    kind: 'configuration-invalid', source, workspaceId: input.workspaceId, teamKind,
    ...(commandIssue ? { commandIssue } : {}),
  });
  const resolved = (policy: CompletionVerificationPolicy, source: VerificationPolicySource): VerificationPolicyResolution => ({
    kind: 'resolved',
    effective: {
      policy, source, teamKind,
      binding: {
        workspaceId: input.workspaceId,
        policyDigest: createHash('sha256').update(JSON.stringify(policy), 'utf8').digest('hex'),
        source, teamKind,
      },
    },
  });
  if (parsed.kind === 'invalid') return invalid('team-document');
  if (parsed.kind === 'valid') return resolved(parsed.policy, 'team-document');
  if (teamKind === 'knowledge') return resolved({ mode: 'disabled' }, 'legacy-default');
  const legacy = input.readLegacyGlobalCommand();
  const legacyIssue = completionVerificationCommandIssue(legacy);
  if (legacy === undefined || legacyIssue === 'empty') {
    return resolved({ mode: 'auto' }, 'legacy-default');
  }
  const legacyPolicy = parseCompletionVerificationPolicy({ mode: 'command', command: legacy });
  return legacyPolicy.kind === 'valid' ? resolved(legacyPolicy.policy, 'legacy-global') : invalid('legacy-global', legacyIssue);
}

/** Only policy inputs, never the full team-document hash. Request/attempt liveness is a separate check. */
export function sameVerificationBinding(left: VerificationBinding, right: VerificationBinding): boolean {
  return left.workspaceId === right.workspaceId && left.policyDigest === right.policyDigest
    && left.source === right.source && left.teamKind === right.teamKind;
}

/**
 * v0.9.99: whether the user explicitly required a verification check. A command the user wrote (in the team document
 * or the global verify-command setting) is a requirement, and so is a policy the host cannot read as valid, which never
 * silently becomes "no check". Automatic detection and a disabled check are not: when such a check could not run or
 * its outcome is unknown, work continues marked unverified instead of waiting for a check nobody asked for.
 */
export function verificationExplicitlyRequired(resolution: VerificationPolicyResolution): boolean {
  return resolution.kind !== 'resolved' || resolution.effective.policy.mode === 'command';
}

/**
 * v0.9.99: whether a check outcome is "could not run or unknown" rather than passed or failed, so that work may
 * continue unverified under a policy that does not require the check. A failed check is never in this set, and
 * neither is a stale request or policy (the work or its owner changed) or an invalid configuration.
 */
export function verificationUnrunOrUnknown(check: { kind: string; reason?: string }): boolean {
  if (check.kind === 'outcome-unknown') return true;
  return check.kind === 'not-run' && check.reason !== 'policy-stale' && check.reason !== 'configuration-invalid';
}
