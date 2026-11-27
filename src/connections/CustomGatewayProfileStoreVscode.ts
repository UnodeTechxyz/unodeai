/* VS Code composition adapter for the otherwise framework-independent custom gateway store. */

import type * as vscode from 'vscode';
import {
  CustomGatewayProfileStore,
  CustomGatewayProfileStoreOptions,
} from './CustomGatewayProfileStore';
import { secretStorageKey } from '../secrets/secretStorageKey';

export type VSCodeCustomGatewayProfileStoreOptions = Omit<CustomGatewayProfileStoreOptions, 'storageDir' | 'secrets'>;

/**
 * Construct the machine-scoped store from the extension host's global storage and SecretStorage.
 * This is deliberately the only C1 module that knows about ExtensionContext; webviews and workspace
 * files receive neither this object nor a profile serializer containing a credential value.
 */
export function createVSCodeCustomGatewayProfileStore(
  context: Pick<vscode.ExtensionContext, 'globalStorageUri' | 'secrets'>,
  options: VSCodeCustomGatewayProfileStoreOptions = {},
): CustomGatewayProfileStore {
  return new CustomGatewayProfileStore({
    ...options,
    storageDir: context.globalStorageUri.fsPath,
    secrets: {
      store: async (secretRef, value) => { await context.secrets.store(secretStorageKey(secretRef), value); },
      delete: async (secretRef) => { await context.secrets.delete(secretStorageKey(secretRef)); },
      has: async (secretRef) => (await context.secrets.get(secretStorageKey(secretRef))) !== undefined,
    },
  });
}
