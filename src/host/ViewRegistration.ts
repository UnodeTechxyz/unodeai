/*---------------------------------------------------------------------------------------------
 * Sidebar registration is host wiring, kept out of feature policy and domain services.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatViewProvider } from '../views/ChatViewProvider';
import type { WorkbenchRecovery } from './WorkbenchRecovery';
import { registerWorkbenchRecovery } from './WorkbenchTabs';

export interface UnodeSidebarViews {
  team: vscode.WebviewViewProvider;
  activity: vscode.WebviewViewProvider;
  chat: ChatViewProvider;
}

export function registerUnodeSidebarViews(
  subscriptions: vscode.Disposable[],
  views: UnodeSidebarViews,
  /** The window is closing or the bound workspace root was invalidated: Workbench recovery then does nothing. */
  recoveryBlocked: () => boolean,
): WorkbenchRecovery<vscode.Tab> {
  subscriptions.push(
    vscode.window.registerWebviewViewProvider('unode.teamPanel', views.team),
    vscode.window.registerWebviewViewProvider('unode.activityPanel', views.activity),
    vscode.window.registerWebviewViewProvider('unode.chat', views.chat),
    vscode.window.registerWebviewPanelSerializer(ChatViewProvider.workbenchViewType, {
      deserializeWebviewPanel: async (panel, state) => {
        views.chat.restoreWorkbench(panel, state);
      },
    }),
  );
  // Only after the serializer: a Workbench tab VS Code restores normally is always claimed by it first.
  return registerWorkbenchRecovery(subscriptions, views.chat, ChatViewProvider.workbenchViewType, recoveryBlocked);
}
