/*---------------------------------------------------------------------------------------------
 *  UnodeAi - CommandApprovalPrompter (F2)
 *  Guided command-execution enablement. When command policy is 'none' (safe default),
 *  prompts the user once to switch to 'allowlist' with safe prefixes for npm, node, git,
 *  python, etc. Never enables 'all' mode.
 *
 *  Pure helpers (SAFE_COMMAND_PREFIXES, isApprovalNeeded) live in CommandPolicy.ts
 *  so tests can import them without pulling in the vscode module.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CommandApprovalMode, SAFE_COMMAND_TEMPLATES, isApprovalNeeded } from './CommandPolicy';
import { type CommandApprovalKey, reviewedSafeApprovalKeys } from './CommandShell';

export interface ProjectCommandApprovalWriter {
  enableExecution(keys: readonly CommandApprovalKey[]): Promise<boolean>;
}

/**
 * Show a one-time modal prompt asking the user to enable safe command execution.
 * If accepted, records ask-mode + the reviewed templates in UnodeAi's workspaceState bucket for the
 * current first folder, as one key per shell grammar that can run each template (cmd.exe, PowerShell and
 * POSIX shells), in one write. It never changes user-wide settings or writes repository files.
 */
export async function promptCommandApproval(
  currentMode: CommandApprovalMode,
  projectApprovals: ProjectCommandApprovalWriter,
): Promise<boolean> {
  if (!isApprovalNeeded(currentMode)) {
    return false;
  }

  const result = await vscode.window.showInformationMessage(
    'UnodeAi agents are blocked from running shell commands (safe default).\n\nEnable command execution? Safe build/test commands (npm, node, git, python, …) run automatically; anything else asks you first, with a one-click "always allow".',
    { modal: true },
    'Keep Disabled',
    'Enable Command Execution'
  );

  if (result !== 'Enable Command Execution') {
    return false;
  }

  return projectApprovals.enableExecution(reviewedSafeApprovalKeys(SAFE_COMMAND_TEMPLATES));
}

/** F2.3: Non-modal warning when a command was blocked due to 'none' mode. */
export function showBlockedWarning(): void {
  vscode.window
    .showWarningMessage(
      'Command blocked: execution is disabled. Allow safe build/test commands?',
      'Enable Commands'
    )
    .then((selection) => {
      if (selection === 'Enable Commands') {
        vscode.commands.executeCommand('unode.enableCommands');
      }
    });
}
