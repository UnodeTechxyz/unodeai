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

import { CommandPolicy } from './CommandPolicy';
import { CommandApprover } from './WorkspaceTools';

/** The MCP tool name claude calls for permission. Referenced as mcp__<server>__permission_prompt. */
export const PERMISSION_TOOL_NAME = 'permission_prompt';

/** claude's --permission-prompt-tool response contract (returned as JSON text from the MCP tool). */
export type ClaudePermissionDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export interface CommandPermissionDeps {
  /** The same CommandPolicy that gates OpenAI-compat run_command. Absent → allow (no gating configured). */
  policy?: CommandPolicy;
  /** 'ask'-mode approver (shows the approval card). Should already be bound to this agent's name. */
  requestApproval?: CommandApprover;
  /** VS Code Workspace Trust state. `false` hard-denies shell commands (untrusted workspace); `true`/undefined
   *  leaves gating to the policy. Evaluated by the caller so this module stays vscode-free. */
  isTrusted?: boolean;
  /** Folder Access read-only mode: deny every native tool that can mutate files or run shell. */
  readOnly?: boolean;
}

export const CLAUDE_SHELL_TOOLS = ['Bash', 'PowerShell'] as const;

/** claude built-in tools that execute a shell command (carry it in input.command). Only these are gated;
 *  file edits/reads/etc. are governed by claude's --permission-mode + Roam's write checkpoints. Matched
 *  case-insensitively so a differently-cased shell tool name can't slip past the gate ungated. */
const SHELL_TOOLS = new Set(CLAUDE_SHELL_TOOLS.map((tool) => tool.toLowerCase()));

/** claude built-in tools that MUTATE the workspace. In an untrusted workspace these are denied (read-only),
 *  alongside shell tools. Matched case-insensitively so a differently-cased name can't slip past. */
const WRITE_TOOLS = new Set(['write', 'edit', 'notebookedit']);
const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep']);

function readOnlyAllows(tool: string): boolean {
  // Unode's loopback bridges are already scoped by the extension. In particular, a read-only Claude
  // agent must keep access to the read-only unode_files MCP bridge.
  return READ_ONLY_TOOLS.has(tool) || tool.startsWith('mcp__unode_');
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
  if (deps.readOnly && (SHELL_TOOLS.has(tool) || WRITE_TOOLS.has(tool))) {
    return { behavior: 'deny', message: 'This agent has no writable folders. Use read-only tools, or ask the user to grant a Read+Write folder.' };
  }
  // Workspace Trust: an untrusted workspace is read-only — deny both shell and file-mutating tools.
  if (deps.isTrusted === false && (SHELL_TOOLS.has(tool) || WRITE_TOOLS.has(tool))) {
    return { behavior: 'deny', message: 'This workspace is not trusted, so running commands and modifying files are disabled. Ask the user to trust the workspace (Workspace Trust); you can still read and analyze files.' };
  }
  if ((deps.readOnly || deps.isTrusted === false) && !readOnlyAllows(tool)) {
    return { behavior: 'deny', message: 'This agent is in a read-only scope. Use Read, Glob, Grep, or Unode read-only MCP tools; ask the user to grant a writable folder before using tools with filesystem or external side effects.' };
  }
  if (!SHELL_TOOLS.has(tool)) {
    return { behavior: 'allow', updatedInput: input };
  }
  const command = typeof input?.command === 'string' ? input.command.trim() : '';
  if (!command) {
    return { behavior: 'allow', updatedInput: input };
  }
  if (deps.isTrusted === false) {
    return { behavior: 'deny', message: 'Shell commands are disabled: this workspace is not trusted. Ask the user to trust the workspace (Workspace Trust) before running commands.' };
  }
  const verdict = deps.policy?.check(command);
  if (!verdict || verdict.allowed) {
    return { behavior: 'allow', updatedInput: input };
  }
  if (verdict.ask && deps.requestApproval) {
    const decision = await deps.requestApproval(command);
    if (decision.allow) {
      return { behavior: 'allow', updatedInput: input };
    }
    const note = decision.note ? ` The user said: "${decision.note}". Adjust or ask them what to do.` : '';
    return { behavior: 'deny', message: `Command not approved by the user.${note}` };
  }
  return { behavior: 'deny', message: `Command blocked by unode.commandApproval: ${verdict.reason ?? 'not allowed'}.` };
}
