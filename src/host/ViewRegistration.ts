/*---------------------------------------------------------------------------------------------
 * Sidebar registration is host wiring, kept out of feature policy and domain services.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatViewProvider } from '../views/ChatViewProvider';

export interface UnodeSidebarViews {
  team: vscode.WebviewViewProvider;
  activity: vscode.WebviewViewProvider;
  chat: ChatViewProvider;
}

export function registerUnodeSidebarViews(
  subscriptions: vscode.Disposable[],
  views: UnodeSidebarViews,
): void {
  subscriptions.push(
    vscode.window.registerWebviewViewProvider('unode.teamPanel', views.team),
    vscode.window.registerWebviewViewProvider('unode.activityPanel', views.activity),
    vscode.window.registerWebviewViewProvider('unode.chat', views.chat),
    vscode.window.registerWebviewPanelSerializer(ChatViewProvider.workbenchViewType, {
      deserializeWebviewPanel: async (panel) => {
        views.chat.restoreWorkbench(panel);
      },
    }),
  );
}
