/*---------------------------------------------------------------------------------------------
 *  UnodeAi - command permission decider (unify Claude agents with unode.commandApproval)
 *
 *  Claude agents run under the `claude` CLI's own --permission-mode, so historically their shell
 *  commands BYPASSED Roam's commandApproval (no approval card — see the PM verify-deadlock saga).
 *  claude exposes one hook to fix this: --permission-prompt-tool, an MCP tool claude calls whenever
 *  a tool use needs permission. This module is the pure decision logic behind that tool: it applies
 *  the SAME CommandPolicy (+ ask-mode approval card) that OpenAICompatBackend's run_command uses, so
 *  every agent type honors "Ask each" consistently. Kept vscode-free so it is unit-testable.
 *--------------------------------------------------------------------------------------------*/

import { CommandPolicy, noPolicyVerdict } from './CommandPolicy';
import { type CommandShellIdentity, commandShellIdentity } from './CommandShell';
import { CommandApprover } from './WorkspaceTools';
import type { HostToolRefusalReason } from './toolSummary';
import { commandDisabledNotice } from './commandDisabledNotice';

/** The MCP tool name claude calls for permission. Referenced as mcp__<server>__permission_prompt. */
export const PERMISSION_TOOL_NAME = 'permission_prompt';

/** claude's --permission-prompt-tool response contract (returned as JSON text from the MCP tool). */
export type ClaudePermissionResponse =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/** The host's decision: a deny also states its typed refusal reason, which never goes back to claude. */
export type ClaudePermissionDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; reason: HostToolRefusalReason };

/** The part of a decision claude receives. */
export function claudePermissionResponse(decision: ClaudePermissionDecision): ClaudePermissionResponse {
  return decision.behavior === 'allow'
    ? { behavior: 'allow', updatedInput: decision.updatedInput }
    : { behavior: 'deny', message: decision.message };
}

export interface CommandPermissionDeps {
  /** The same CommandPolicy that gates OpenAI-compat run_command. Absent → allow (no gating configured). */
  policy?: CommandPolicy;
  cwd?: string;
  onCommandDisabled?: (notice: string) => void;
  /** 'ask'-mode approver (shows the approval card). Should already be bound to this agent's name. */
  requestApproval?: CommandApprover;
  /** VS Code Workspace Trust state. `false` hard-denies shell commands (untrusted workspace); `true`/undefined
   *  leaves gating to the policy. Evaluated by the caller so this module stays vscode-free. */
  isTrusted?: boolean;
  /** Folder Access read-only mode: deny every native tool that can mutate files or run shell. */
  readOnly?: boolean;
  /** The boundary that makes the agent read-only, for the typed refusal: folder scope unless the caller knows it is
   *  a missing capability. An untrusted workspace is always `trust`. */
  readOnlyRefusal?: HostToolRefusalReason;
  /** Exact qualified names registered by this backend's opaque local MCP bridges. */
  allowedLocalMcpTools?: ReadonlySet<string>;
}

export const CLAUDE_SHELL_TOOLS = ['Bash', 'PowerShell'] as const;

/** claude built-in tools that execute a shell command (carry it in input.command). Only these are gated;
 *  file edits/reads/etc. are governed by claude's --permission-mode + Roam's write checkpoints. Matched
 *  case-insensitively so a differently-cased shell tool name can't slip past the gate ungated. */
const SHELL_TOOLS = new Set(CLAUDE_SHELL_TOOLS.map((tool) => tool.toLowerCase()));

/**
 * The policy identity of claude's own shell tools. claude executes them itself, so UnodeAi names their
 * grammar for the shared policy and the approval card but makes no claim about how they run. claude does not
 * report which PowerShell it uses, so it is Windows PowerShell, where `&&` is not a separator.
 */
const CLAUDE_TOOL_SHELLS: ReadonlyMap<string, CommandShellIdentity> = new Map([
  ['bash', commandShellIdentity('bash', 'native-provider-tool', { label: 'Claude Bash tool', fingerprint: ['claude-tool', 'bash'] })],
  ['powershell', commandShellIdentity('windows-powershell', 'native-provider-tool', { label: 'Claude PowerShell tool', fingerprint: ['claude-tool', 'powershell'] })],
]);

/** The shell identity the shared policy uses for one of claude's shell tools. */
export function claudeToolShell(tool: string): CommandShellIdentity | undefined {
  return CLAUDE_TOOL_SHELLS.get(tool.trim().toLowerCase());
}

/** claude built-in tools that MUTATE the workspace. In an untrusted workspace these are denied (read-only),
 *  alongside shell tools. Matched case-insensitively so a differently-cased name can't slip past. */
const WRITE_TOOLS = new Set(['write', 'edit', 'notebookedit']);
const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep']);

function readOnlyAllows(tool: string, allowedLocalMcpTools?: ReadonlySet<string>): boolean {
  // Unode's loopback bridges are already scoped by the extension. In particular, a read-only Claude
  // agent must keep access to the read-only unode_files MCP bridge.
  return READ_ONLY_TOOLS.has(tool) || allowedLocalMcpTools?.has(tool) === true;
}

/**
 * Decide whether a claude tool use may proceed. Shell commands go through Roam's CommandPolicy: allowlisted
 * → allow silently; 'ask' → show the approval card; blocked → deny with the reason. Everything else is
 * allowed unchanged. Returns claude's allow/deny shape.
 */
export async function decideCommandPermission(
  toolName: string,
  input: Record<string, unknown>,
  deps: CommandPermissionDeps
): Promise<ClaudePermissionDecision> {
  const tool = toolName.trim().toLowerCase();
  // Boundaries are named in order: Workspace Trust, then folder scope, then capability, then consent.
  // Workspace Trust: an untrusted workspace is read-only — deny both shell and file-mutating tools.
  if (deps.isTrusted === false && (SHELL_TOOLS.has(tool) || WRITE_TOOLS.has(tool))) {
    return { behavior: 'deny', message: 'This workspace is not trusted, so running commands and modifying files are disabled. Ask the user to trust the workspace (Workspace Trust); you can still read and analyze files.', reason: 'trust' };
  }
  const readOnlyRefusal = deps.readOnlyRefusal ?? 'scope';
  if (deps.readOnly && (SHELL_TOOLS.has(tool) || WRITE_TOOLS.has(tool))) {
    return { behavior: 'deny', message: 'This agent has no writable folders. Use read-only tools, or ask the user to grant a Read+Write folder.', reason: readOnlyRefusal };
  }
  if ((deps.readOnly || deps.isTrusted === false) && !readOnlyAllows(tool, deps.allowedLocalMcpTools)) {
    return {
      behavior: 'deny',
      message: 'This agent is in a read-only scope. Use Read, Glob, Grep, or Unode read-only MCP tools; ask the user to grant a writable folder before using tools with filesystem or external side effects.',
      reason: deps.isTrusted === false ? 'trust' : readOnlyRefusal,
    };
  }
  if (!SHELL_TOOLS.has(tool)) {
    return { behavior: 'allow', updatedInput: input };
  }
  const command = typeof input?.command === 'string' ? input.command.trim() : '';
  if (!command) {
    return { behavior: 'allow', updatedInput: input };
  }
  if (deps.isTrusted === false) {
    return { behavior: 'deny', message: 'Shell commands are disabled: this workspace is not trusted. Ask the user to trust the workspace (Workspace Trust) before running commands.', reason: 'trust' };
  }
  const shell = claudeToolShell(tool);
  if (!shell) {
    return { behavior: 'deny', message: 'This shell tool has no known grammar, so UnodeAi cannot check its command.', reason: 'capability' };
  }
  // No policy injected is NOT "allow everything": a blocked or opaque command is still refused (fail-closed),
  // a supported one keeps the no-gating contract. (This closes the old `!verdict → allow` branch.)
  const verdict = deps.policy ? deps.policy.check(command, { shell }) : noPolicyVerdict(command, shell);
  if (verdict.disabled) {
    const message = commandDisabledNotice(command, deps.cwd);
    deps.onCommandDisabled?.(message);
    return { behavior: 'deny', message, reason: 'capability' };
  }
  if (verdict.allowed) {
    return { behavior: 'allow', updatedInput: input };
  }
  if (verdict.ask && deps.requestApproval) {
    // An opaque command is approved for this one use only: force the prompt and let nothing be remembered.
    const decision = await deps.requestApproval(command, { shell, cwd: deps.cwd,
      ...(verdict.dangerous ? { dangerous: true } : {}),
      ...(verdict.opaque || verdict.dangerous ? { singleUse: true, forcePrompt: true } : {}) });
    if (decision.allow) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (verdict.dangerous) return { behavior: 'deny', message: 'The user did not confirm this delete.', reason: 'consent' };
    if (decision.withdrawn) {
      return { behavior: 'deny', message: 'Command not run: its approval was withdrawn because the agent was stopped, restarted or removed.', reason: 'consent' };
    }
    const note = decision.note ? ` The user said: "${decision.note}". Adjust or ask them what to do.` : '';
    return { behavior: 'deny', message: `Command not approved by the user.${note}`, reason: 'consent' };
  }
  if (verdict.dangerous) return { behavior: 'deny', message: 'The user did not confirm this delete.', reason: 'consent' };
  return { behavior: 'deny', message: `Command blocked by unode.commandApproval: ${verdict.reason ?? 'not allowed'}.`, reason: 'capability' };
}
