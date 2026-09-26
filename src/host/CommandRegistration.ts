/*---------------------------------------------------------------------------------------------
 * Command registration is a host concern.  Feature handlers remain ordinary functions in the
 * composition root; this adapter is the one place that turns them into VS Code disposables.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export type CommandHandler = (...args: any[]) => unknown;

export function registerCommand(
  subscriptions: vscode.Disposable[],
  command: string,
  handler: CommandHandler,
): void {
  subscriptions.push(vscode.commands.registerCommand(command, handler));
}
