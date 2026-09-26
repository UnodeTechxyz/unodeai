import type { ChatMode, CodexActPermissionProfile } from '../types';

export type ResolvedCodexPermissionProfile = 'read-only' | CodexActPermissionProfile;
export const CODEX_FULL_ACCESS_ENABLE_ACTION = 'Enable full access';

export function acceptedCodexFullAccessChoice(choice: unknown): boolean {
  return choice === CODEX_FULL_ACCESS_ENABLE_ACTION;
}

export interface CodexPermissionResolutionInput {
  configured?: unknown;
  mode: ChatMode;
  trusted: boolean;
  /** True when the agent has explicit Folder Access grants, i.e. it may touch only the folders it was given. */
  restricted?: boolean;
  writeRoots: readonly string[];
  allowedTools?: readonly string[];
  toolCeiling?: 'native-default' | 'bounded';
}

export interface CodexPermissionResolution {
  configured: CodexActPermissionProfile;
  effective: ResolvedCodexPermissionProfile;
  capReason?: string;
}

export function normalizeCodexPermissionProfile(value: unknown): CodexActPermissionProfile {
  return value === 'approve-for-me' || value === 'full-access' || value === 'ask-for-approval'
    ? value
    : 'ask-for-approval';
}

/**
 * Resolve the single host-owned Codex permission truth used by UI, spawn, thread and turn settings.
 * Repository configuration is deliberately not an input. Every limiting condition resolves downward.
 */
export function resolveCodexPermissionProfile(input: CodexPermissionResolutionInput): CodexPermissionResolution {
  const configured = normalizeCodexPermissionProfile(input.configured);
  if (input.mode === 'plan') {
    return { configured, effective: 'read-only', capReason: 'Plan mode is always read only.' };
  }
  if (!input.trusted) {
    return { configured, effective: 'read-only', capReason: 'Workspace Trust limits this agent to read only.' };
  }
  if (input.writeRoots.length === 0) {
    return { configured, effective: 'read-only', capReason: 'Folder Access grants no writable folder.' };
  }
  if (!codexWriteCapable(input.allowedTools, input.toolCeiling)) {
    return { configured, effective: 'read-only', capReason: 'This agent\'s tool ceiling does not allow writes.' };
  }
  // Full access has no sandbox, so it cannot honour a folder grant: an agent limited to one folder would
  // write anywhere the account can. The two workspace-write profiles do honour it through writableRoots.
  if (input.restricted && configured === 'full-access') {
    return {
      configured,
      effective: 'ask-for-approval',
      capReason: 'Folder Access limits this agent to its granted folders, which Full access cannot honour.',
    };
  }
  return { configured, effective: configured };
}

/**
 * Codex has no independent execute switch: its native file and command tools always run inside the selected
 * sandbox. The UnodeAi ceiling therefore controls whether that sandbox is read-only or workspace-write.
 */
export function codexWriteCapable(
  allowedTools: readonly string[] | undefined,
  toolCeiling?: 'native-default' | 'bounded',
): boolean {
  if (toolCeiling === 'native-default') return true;
  // Compatibility for records written before v0.9.85: absent and empty both meant native defaults.
  if (toolCeiling === undefined && (!Array.isArray(allowedTools) || allowedTools.length === 0)) return true;
  return !!allowedTools?.includes('write');
}
