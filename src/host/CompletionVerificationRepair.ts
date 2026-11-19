import * as vscode from 'vscode';

/**
 * M1 repair adapter for the forthcoming completion-policy card. Opens the User layer, never the last-used
 * workspace/folder Settings target. No caller-supplied command/options, writes, migration or execution.
 * workbench.action.openGlobalSettings delegates to PreferencesService.openUserSettings, which fixes USER_LOCAL.
 */
export async function openLegacyVerificationUserSettings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openGlobalSettings', { query: '@id:unode.verifyCommand' });
}
