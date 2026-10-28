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
import { blockingPrompt, type PromptWait } from '../views/attentionSignal';
import type { OverwriteDecisionRequest } from './fileWritePolicy';

/** A folder has no restore copy. Its negative default is a real button, never a close affordance. */
export async function confirmFolderDelete(request: OverwriteDecisionRequest, key: string, wait: PromptWait): Promise<boolean> {
  if (request.signal?.aborted || !vscode.window) return false;
  const files = request.foreignFiles ?? [];
  const quote = (value: string) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const listing = files.slice(0, 10).map(quote).join('\n') + (files.length > 10 ? `\nand ${files.length - 10} more` : '');
  try {
    const choice = await blockingPrompt(key, () => vscode.window.showWarningMessage(
      `Delete this folder and the files UnodeAi did not make? There is no restore point.\n\nFolder: ${quote(request.path)}\n${listing}`,
      { modal: true }, "Don't delete", 'Delete',
    ), wait);
    return choice === 'Delete' && !request.signal?.aborted;
  } catch { return false; }
}

/** Never a remembered grant. The negative button is first and is NOT a close affordance. */
export async function confirmDangerousCommand(command: string, cwd: string | undefined, key: string, wait: PromptWait): Promise<boolean> {
  const choice = await blockingPrompt(key, () => vscode.window.showWarningMessage(
    `Run this potentially destructive command?\n\nCommand: ${command}\nFolder: ${cwd ?? 'not reported by the command provider'}`,
    { modal: true }, "Don't run", 'Run it',
  ), wait);
  return choice === 'Run it';
}

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
