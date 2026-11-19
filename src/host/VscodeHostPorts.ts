/*---------------------------------------------------------------------------------------------
 * VS Code implementations of the small host capabilities used by the composition root.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { SecretPort, SettingsPort, WorkspaceFilesPort } from './HostPorts';

export function vscodeSettings(section: string): SettingsPort {
  return {
    read<T>(key: string, fallback?: T): T | undefined {
      return vscode.workspace.getConfiguration(section).get<T>(key, fallback as T);
    },
    async writeGlobal<T>(key: string, value: T | undefined): Promise<void> {
      await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
    },
  };
}

export function vscodeSecrets(secrets: SecretPort): SecretPort {
  return secrets;
}

export function vscodeWorkspaceFiles(): WorkspaceFilesPort {
  return {
    hasWorkspace: () => (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
    workspaceRoots: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  };
}
