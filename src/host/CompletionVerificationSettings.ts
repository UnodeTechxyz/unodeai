import {
  resolveCompletionVerificationPolicy,
  verificationCommandIssueMessage,
  type CompletionVerificationPolicy,
  type VerificationPolicySource,
} from '../backend/CompletionVerificationPolicy';
import { workspaceRootIdentity } from '../state/WorkspaceRootIdentity';

export type CompletionVerificationSettingsView =
  | {
      kind: 'ready';
      cwd: string;
      mode: CompletionVerificationPolicy['mode'];
      source: VerificationPolicySource;
      sourceLabel: string;
      teamKind: 'software' | 'knowledge';
      command?: string;
      /** Opaque one-shot host form target; configuration only, never command authorization. */
      editToken?: string;
    }
  | {
      kind: 'configuration-invalid';
      cwd: string;
      source: 'team-document' | 'legacy-global';
      sourceLabel: string;
      teamKind: 'software' | 'knowledge';
      detail: string;
      repair: 'team-file' | 'legacy-user-settings';
    }
  | { kind: 'unavailable'; detail: string };

export interface CompletionVerificationConfigurationInspection<T> {
  globalValue?: T;
}

export interface CompletionVerificationConfiguration {
  inspect<T>(section: string): CompletionVerificationConfigurationInspection<T> | undefined;
}

/**
 * The retired setting is a user-level compatibility input, never a merged setting. In particular, a repository
 * value returned by Configuration.get() must not become either the displayed source or an executable candidate.
 */
export function readLegacyGlobalVerificationCommand(
  configuration: CompletionVerificationConfiguration,
): unknown {
  return configuration.inspect<unknown>('verifyCommand')?.globalValue;
}

export function completionVerificationSourceLabel(source: VerificationPolicySource): string {
  switch (source) {
    case 'team-document':
      return 'Team file configuration (not command authorization)';
    case 'legacy-global':
      return 'User Settings compatibility command (configuration only)';
    case 'legacy-default':
      return 'Compatibility default';
  }
}

/** Build display-only state. This does not prepare, approve or execute a command. */
export function buildCompletionVerificationSettingsView(input: {
  workspaceRoot?: string;
  agentSkills: readonly string[];
  completionVerification?: unknown;
  readLegacyGlobalCommand: () => unknown;
  teamDocumentState?: 'ready' | 'configuration-invalid' | 'unreadable';
}): CompletionVerificationSettingsView {
  if (!input.workspaceRoot) {
    return { kind: 'unavailable', detail: 'Open a workspace folder to view this team setting.' };
  }
  if (input.teamDocumentState === 'unreadable') {
    return {
      kind: 'unavailable',
      detail: 'The current .unode/team.json could not be read. Fix the file before changing completion checks.',
    };
  }

  const resolution = resolveCompletionVerificationPolicy({
    workspaceId: workspaceRootIdentity(input.workspaceRoot),
    agentSkills: input.agentSkills,
    completionVerification: input.teamDocumentState === 'configuration-invalid'
      ? { mode: '__invalid__' }
      : input.completionVerification,
    readLegacyGlobalCommand: input.readLegacyGlobalCommand,
  });

  if (resolution.kind === 'configuration-invalid') {
    const legacy = resolution.source === 'legacy-global';
    return {
      kind: 'configuration-invalid',
      cwd: input.workspaceRoot,
      source: resolution.source,
      sourceLabel: completionVerificationSourceLabel(resolution.source),
      teamKind: resolution.teamKind,
      detail: legacy
        ? `${resolution.commandIssue ? verificationCommandIssueMessage(resolution.commandIssue) : 'The command is invalid.'} No fallback is used.`
        : 'completionVerification is invalid in .unode/team.json. No fallback is used.',
      repair: legacy ? 'legacy-user-settings' : 'team-file',
    };
  }

  const { effective } = resolution;
  return {
    kind: 'ready',
    cwd: input.workspaceRoot,
    mode: effective.policy.mode,
    source: effective.source,
    sourceLabel: completionVerificationSourceLabel(effective.source),
    teamKind: effective.teamKind,
    ...(effective.policy.mode === 'command' ? { command: effective.policy.command } : {}),
  };
}
