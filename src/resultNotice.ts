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

/** Read at each call so changing the setting takes effect without reloading. Invalid values fail visible. */
export function readResultNoticeStyle(configuration: InspectableConfiguration): ResultNoticeStyle {
  const value = readUserAuthoritySetting<unknown>(configuration, RESULT_NOTICE_STYLE_SETTING, 'dialog');
  return value === 'quiet' ? 'quiet' : 'dialog';
}

/** Show an itemless action result. Decisions with buttons must continue to call VS Code directly. */
export function showResultNotice(
  kind: ResultNoticeKind,
  message: string,
  detail?: string,
): Thenable<string | undefined> {
  let style: ResultNoticeStyle = 'dialog';
  try {
    style = readResultNoticeStyle(vscode.workspace.getConfiguration('unode'));
  } catch {
    // VS Code always supplies configuration in production. Keep results visible if a host shim is incomplete.
  }
  const quietMessage = detail ? `${message}\n\n${detail}` : message;
  if (kind === 'warning') {
    return style === 'dialog'
      ? vscode.window.showWarningMessage(message, { modal: true, ...(detail ? { detail } : {}) })
      : vscode.window.showWarningMessage(quietMessage);
  }
  if (kind === 'error') {
    return style === 'dialog'
      ? vscode.window.showErrorMessage(message, { modal: true, ...(detail ? { detail } : {}) })
      : vscode.window.showErrorMessage(quietMessage);
  }
  return style === 'dialog'
    ? vscode.window.showInformationMessage(message, { modal: true, ...(detail ? { detail } : {}) })
    : vscode.window.showInformationMessage(quietMessage);
}
