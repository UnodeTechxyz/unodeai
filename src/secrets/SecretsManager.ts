/*---------------------------------------------------------------------------------------------
 *  UnodeAi - SecretsManager
 *  Thin wrapper over VS Code SecretStorage so API keys never touch config files, logs, or Git.
 *  Keys are namespaced under "roam.secret.<name>" to avoid clashing with other extensions.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { secretStorageKey } from './secretStorageKey';

export { SECRET_STORAGE_PREFIX, secretStorageKey } from './secretStorageKey';

export class SecretsManager {
  constructor(private storage: vscode.SecretStorage) {}

  async get(secretName: string): Promise<string | undefined> {
    return this.storage.get(secretStorageKey(secretName));
  }

  async set(secretName: string, value: string): Promise<void> {
    await this.storage.store(secretStorageKey(secretName), value);
  }

  async delete(secretName: string): Promise<void> {
    await this.storage.delete(secretStorageKey(secretName));
  }

  async has(secretName: string): Promise<boolean> {
    return (await this.get(secretName)) !== undefined;
  }

}
