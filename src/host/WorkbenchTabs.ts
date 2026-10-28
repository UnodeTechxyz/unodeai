/*---------------------------------------------------------------------------------------------
 * The VS Code side of Workbench recovery: which tabs are UnodeAi Workbench tabs, the questions, and the two tab
 * operations. The policy is WorkbenchRecovery's; nothing here decides when to act.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { showResultNotice } from '../resultNotice';
import {
  WorkbenchRecovery,
  type LiveWorkbenchPlacement,
  type WorkbenchRecoveryAnswer,
  type WorkbenchRecoveryQuestion,
  type WorkbenchTabCandidate,
} from './WorkbenchRecovery';

/** VS Code reports an extension's webview editor tab with this prefix on its view type (measured on 1.142.0). */
export function workbenchTabViewType(viewType: string): string {
  return `mainThreadWebview-${viewType}`;
}

/** The chat provider's side of recovery. */
export interface RecoverableWorkbench {
  liveWorkbenchPlacement(): LiveWorkbenchPlacement | undefined;
  hasSavedWorkbenchDrafts(): boolean;
  openRecoveredWorkbench(viewColumn: number): void;
  openWorkbench(preserveFocus?: boolean): void;
  isDisposed(): boolean;
  /** False while the roster is still being restored: a tab is not judged before its page could attach. */
  isRosterLoaded(): boolean;
  setWorkbenchRecovery(recovery: { interceptOpen(): boolean; changed(): void } | undefined): void;
}

export const NOT_NOW = 'Not now';
export const REOPEN_WORKBENCH = 'Reopen Workbench';
export const KEEP_OLD_TAB = 'Keep Old Tab';
export const CLOSE_OLD_TAB = 'Close Old Tab';

const LOST_CONNECTION = 'The UnodeAi Workbench lost its connection when the extension host restarted.';

export async function askWorkbenchRecovery(question: WorkbenchRecoveryQuestion): Promise<WorkbenchRecoveryAnswer> {
  if (question.kind === 'ambiguous') {
    void vscode.window.showWarningMessage(
      'Several UnodeAi Workbench tabs lost their connection. Copy any text you need from them, close them, then open the Workbench again.',
    );
    return undefined;
  }
  if (question.kind === 'close-extra') {
    const pick = await vscode.window.showWarningMessage(
      'A UnodeAi Workbench tab is no longer connected; the connected Workbench is in another tab. Copy any text you need from the old tab, then close it.',
      CLOSE_OLD_TAB,
      KEEP_OLD_TAB,
    );
    return pick === CLOSE_OLD_TAB ? 'close' : undefined;
  }
  const detail = question.savedDrafts
    ? 'Reopening closes the old tab and restores unsent text from the last saved copy. Text typed after the restart may be missing, so copy it from the old tab first if you need it. Nothing is sent.'
    : 'UnodeAi has no saved copy of unsent text from it. Reopening closes the old tab, so copy any text you need from it first. Nothing is sent.';
  if (question.userInitiated) {
    const pick = await vscode.window.showWarningMessage(LOST_CONNECTION, { modal: true, detail }, NOT_NOW, REOPEN_WORKBENCH);
    return pick === REOPEN_WORKBENCH ? 'reopen' : undefined;
  }
  const pick = await vscode.window.showWarningMessage(`${LOST_CONNECTION} ${detail}`, REOPEN_WORKBENCH, KEEP_OLD_TAB);
  return pick === REOPEN_WORKBENCH ? 'reopen' : undefined;
}

async function closeTab(tab: vscode.Tab): Promise<boolean> {
  try {
    return await vscode.window.tabGroups.close(tab, true);
  } catch {
    return false;
  }
}

/**
 * Arm recovery for the chat provider's Workbench. Call after the panel serializer is registered, so a normal restore
 * is always first to claim a tab.
 */
export function registerWorkbenchRecovery(
  subscriptions: vscode.Disposable[],
  chat: RecoverableWorkbench,
  workbenchViewType: string,
  blocked: () => boolean,
): WorkbenchRecovery<vscode.Tab> {
  const tabViewType = workbenchTabViewType(workbenchViewType);
  const recovery = new WorkbenchRecovery<vscode.Tab>({
    candidates: () => {
      const found: WorkbenchTabCandidate<vscode.Tab>[] = [];
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputWebview && tab.input.viewType === tabViewType) {
            found.push({ tab, viewColumn: group.viewColumn, activeInGroup: tab.isActive });
          }
        }
      }
      return found;
    },
    live: () => chat.liveWorkbenchPlacement(),
    blocked: () => blocked() || chat.isDisposed() || !chat.isRosterLoaded(),
    savedDrafts: () => chat.hasSavedWorkbenchDrafts(),
    ask: askWorkbenchRecovery,
    reopen: async (tab, viewColumn) => {
      // Opened first, in the old tab's group, so the new tab takes the old one's place once that is closed.
      chat.openRecoveredWorkbench(viewColumn);
      const closed = await closeTab(tab);
      if (!closed) {
        void showResultNotice('warning', 'UnodeAi reopened the Workbench but could not close the old tab.', 'Close the old tab yourself.');
      }
      return closed;
    },
    close: closeTab,
    open: () => chat.openWorkbench(false),
    now: () => Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  chat.setWorkbenchRecovery(recovery);
  subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => recovery.changed()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => recovery.changed()),
    {
      dispose: () => {
        recovery.cancel();
        chat.setWorkbenchRecovery(undefined);
      },
    },
  );
  recovery.start();
  return recovery;
}
