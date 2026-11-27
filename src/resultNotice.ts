/*---------------------------------------------------------------------------------------------
 *  UnodeAi - user-action result notices
 *  One policy point for itemless result dialogs. The user may make them quiet, but repository settings
 *  cannot silence them and decision/approval dialogs (which have action items) never pass through here.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { type InspectableConfiguration, readUserAuthoritySetting } from './settings/AuthoritySettings';

export const RESULT_NOTICE_STYLE_SETTING = 'notifications.resultStyle' as const;
export type ResultNoticeStyle = 'dialog' | 'quiet';
export type ResultNoticeKind = 'information' | 'warning' | 'error';

/**
 * v0.9.99: quiet corner notifications are the default. Read at each call so changing the setting takes effect
 * without reloading. An explicit Dialog in User Settings is kept; an unreadable value fails visible as Dialog.
 */
export const DEFAULT_RESULT_NOTICE_STYLE: ResultNoticeStyle = 'quiet';

export function readResultNoticeStyle(configuration: InspectableConfiguration): ResultNoticeStyle {
  const value = readUserAuthoritySetting<unknown>(configuration, RESULT_NOTICE_STYLE_SETTING, DEFAULT_RESULT_NOTICE_STYLE);
  if (value === undefined || value === null) return DEFAULT_RESULT_NOTICE_STYLE;
  return value === 'quiet' ? 'quiet' : 'dialog';
}

/**
 * Show an itemless action result. Decisions with buttons must continue to call VS Code directly.
 *
 * v0.9.99: an informational result never holds up work. A quiet notice resolves at once instead of when the
 * person closes it (VS Code keeps an itemless notification's promise open until it is dismissed from the
 * notification centre), and a notice that cannot be shown resolves rather than rejecting into the caller. An
 * explicit Dialog still waits for its OK, because the person chose a dialog.
 */
export function showResultNotice(
  kind: ResultNoticeKind,
  message: string,
  detail?: string,
): Thenable<string | undefined> {
  let style: ResultNoticeStyle = DEFAULT_RESULT_NOTICE_STYLE;
  try {
    style = readResultNoticeStyle(vscode.workspace.getConfiguration('unode'));
  } catch {
    // VS Code always supplies configuration in production. A host shim without it gets the quiet default.
  }
  const quietMessage = detail ? `${message}\n\n${detail}` : message;
  try {
    // An explicit Dialog waits for OK; the modal calls stay direct, so the modal-safety gate sees each one.
    if (style === 'dialog') {
      const shown = kind === 'warning'
        ? vscode.window.showWarningMessage(message, { modal: true, ...(detail ? { detail } : {}) })
        : kind === 'error'
          ? vscode.window.showErrorMessage(message, { modal: true, ...(detail ? { detail } : {}) })
          : vscode.window.showInformationMessage(message, { modal: true, ...(detail ? { detail } : {}) });
      return Promise.resolve(shown).catch(() => undefined);
    }
    const quiet = kind === 'warning' ? vscode.window.showWarningMessage(quietMessage)
      : kind === 'error' ? vscode.window.showErrorMessage(quietMessage)
        : vscode.window.showInformationMessage(quietMessage);
    void Promise.resolve(quiet).catch(() => undefined);
  } catch {
    // A notice that cannot be shown is not a reason to stop the work it reports on.
  }
  return Promise.resolve(undefined);
}
