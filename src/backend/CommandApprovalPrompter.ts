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
import { CommandApprovalMode, SAFE_COMMAND_PREFIXES, isApprovalNeeded } from './CommandPolicy';

/**
 * Show a one-time modal prompt asking the user to enable safe command execution.
 * If accepted, writes 'allowlist' + safe prefixes to workspace settings.
 * Returns true if the user accepted (config was updated).
 */
export async function promptCommandApproval(currentMode: CommandApprovalMode): Promise<boolean> {
  if (!isApprovalNeeded(currentMode)) {
    return false;
  }

  const result = await vscode.window.showInformationMessage(
    'UnodeAi agents are blocked from running shell commands (safe default).\n\nEnable command execution? Safe build/test commands (npm, node, git, python, …) run automatically; anything else asks you first, with a one-click "always allow".',
    { modal: true },
    'Enable Command Execution'
  );

  if (result !== 'Enable Command Execution') {
    return false;
  }

  const cfg = vscode.workspace.getConfiguration('unode');
  // 'ask' mode: safe prefixes run silently; novel commands prompt (Run / Always allow / Deny).
  await cfg.update('commandApproval', 'ask', vscode.ConfigurationTarget.Workspace);
  await cfg.update('allowedCommands', SAFE_COMMAND_PREFIXES, vscode.ConfigurationTarget.Workspace);
  return true;
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
