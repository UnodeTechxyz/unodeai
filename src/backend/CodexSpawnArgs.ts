/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Codex App Server spawn boundary
 *  One argv builder is shared by production and the real-binary probe so launch evidence cannot
 *  accidentally omit a product argument.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import type { ResolvedCodexPermissionProfile } from './CodexPermissionProfile';

export { codexWriteCapable } from './CodexPermissionProfile';

export interface CodexProtocolPermissionSettings {
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy: 'on-request' | 'never';
  approvalsReviewer: 'user' | 'auto_review';
  appApprovalMode: 'prompt' | 'approve';
  appApprovalsReviewer: 'user' | 'auto_review';
  networkAccess: boolean;
}

/** `guardian_subagent` is legacy-compatible, but the official Codex profile uses documented `auto_review`. */
export function codexProtocolPermissionSettings(profile: ResolvedCodexPermissionProfile): CodexProtocolPermissionSettings {
  switch (profile) {
    case 'read-only':
      return {
        sandboxMode: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user',
        appApprovalMode: 'prompt', appApprovalsReviewer: 'user', networkAccess: false,
      };
    case 'approve-for-me':
      return {
        sandboxMode: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
        appApprovalMode: 'prompt', appApprovalsReviewer: 'auto_review', networkAccess: false,
      };
    case 'full-access':
      return {
        sandboxMode: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user',
        appApprovalMode: 'approve', appApprovalsReviewer: 'user', networkAccess: true,
      };
    default:
      return {
        sandboxMode: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user',
        appApprovalMode: 'prompt', appApprovalsReviewer: 'user', networkAccess: false,
      };
  }
}

export const CODEX_BANNED_FLAGS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
] as const;

export interface CodexRepositoryLaunchMode {
  projectRoot: string;
  mode: 'native' | 'user-only';
  /** The agent's working directory, when it is a folder below `projectRoot`. */
  cwd?: string;
}

/**
 * Every folder Codex might use as this agent's project key: the working directory and each ancestor up to and
 * including the workspace root. Codex keys project trust by the git root when there is one, and otherwise by
 * the working directory itself. Measured on 0.155.1: in a non-git workspace an agent working in a subfolder was
 * keyed by that subfolder, missed a root-only override, and Codex then wrote
 * `[projects.'<subfolder>'] trust_level = "trusted"` into the user's own config.toml.
 */
export function codexProjectTrustRoots(projectRoot: string, cwd?: string): string[] {
  const root = path.resolve(projectRoot);
  const roots = [root];
  if (!cwd) return roots;
  let current = path.resolve(cwd);
  const relative = path.relative(root, current);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return roots;
  while (current !== root) {
    roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

/** The final argv boundary: bypass flags are always banned; the unsafe sandbox is profile-gated. */
export function assertSafeCodexSpawnArgs(
  args: readonly string[],
  profile: ResolvedCodexPermissionProfile = 'ask-for-approval',
): void {
  const banned = args.find((arg) => CODEX_BANNED_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
  if (banned) throw new Error(`Codex refused unsafe spawn argument: ${banned}`);
  // Match any spelling, not just the one our builder emits: `--sandbox danger-full-access`, `-s …`,
  // `sandbox_mode='danger-full-access'` and an unquoted value all reach the same unsandboxed process.
  const mentionsFullAccess = args.some((arg) => arg.includes('danger-full-access'));
  if (profile !== 'full-access' && mentionsFullAccess) {
    throw new Error('Codex refused a spawn whose sandbox does not match the host-owned permission profile.');
  }
  if (profile === 'full-access' && !args.includes('sandbox_mode="danger-full-access"')) {
    throw new Error('Codex refused a spawn whose sandbox does not match the host-owned permission profile.');
  }
}

/**
 * Build the complete production App Server argv.
 *
 * Match Codex's native "Ask for approval" preset at the process boundary. This is the
 * documented workspace-write + on-request profile: routine work inside the workspace is
 * automatic, while sandbox escapes and other eligible effects are sent to the user reviewer.
 */
export function buildCodexAppServerArgs(
  repository?: CodexRepositoryLaunchMode,
  profile: ResolvedCodexPermissionProfile = 'ask-for-approval',
): string[] {
  const settings = codexProtocolPermissionSettings(profile);
  const args = [
    'app-server', '--stdio', '--strict-config',
    '-c', 'analytics.enabled=false',
    '-c', 'otel.exporter="none"',
    '-c', `sandbox_mode=${JSON.stringify(settings.sandboxMode)}`,
    '-c', `sandbox_workspace_write.network_access=${settings.networkAccess}`,
    '-c', `approval_policy=${JSON.stringify(settings.approvalPolicy)}`,
    '-c', `approvals_reviewer=${JSON.stringify(settings.approvalsReviewer)}`,
    '-c', `apps._default.default_tools_approval_mode=${JSON.stringify(settings.appApprovalMode)}`,
    '-c', `apps._default.approvals_reviewer=${JSON.stringify(settings.appApprovalsReviewer)}`,
  ];
  if (repository) {
    args.push('-c', codexProjectTrustOverride(
      codexProjectTrustRoots(repository.projectRoot, repository.cwd),
      repository.mode === 'native' ? 'trusted' : 'untrusted',
    ));
  }
  assertSafeCodexSpawnArgs(args, profile);
  return args;
}

/**
 * Codex 0.155.x accepts a process-local replacement for the complete projects table. A dotted key
 * looked plausible but was ignored by the real Windows binary, so keep this exact full-map form.
 */
export function codexProjectTrustOverride(projectRoots: string | readonly string[], level: 'trusted' | 'untrusted'): string {
  const keys = [...new Set((typeof projectRoots === 'string' ? [projectRoots] : projectRoots).map((root) => {
    const canonical = path.resolve(root);
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  }))];
  const entries = keys.map((key) => `${JSON.stringify(key)} = { trust_level = ${JSON.stringify(level)} }`);
  return `projects={ ${entries.join(', ')} }`;
}

/**
 * Whether a Codex agent may be given a workspace-write turn.
 *
 * Older roster entries may contain `allowedTools: []` because route adaptation used to turn an absent ceiling
 * into an empty array. v0.9.85 records the distinction explicitly as `native-default` versus `bounded`; the
 * legacy empty/absent shape remains native-default until the agent is next saved.
 */
