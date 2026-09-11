import * as vscode from 'vscode';

/**
 * Identifies the deterministic fixture arguments used by the extension-host E2E suite.
 * This is deliberately Test-only: a Development host may hold a developer's real secrets.
 */
export function isE2EFixtureRequest(extensionMode: vscode.ExtensionMode | undefined, value: unknown): boolean {
  return extensionMode === vscode.ExtensionMode.Test
    && !!value
    && typeof value === 'object'
    && (value as { e2e?: unknown }).e2e === true;
}

/**
 * The fixture may only remove what it created. A test profile that already holds a key is a profile
 * someone configured, and SecretStorage has no undo — so an existing key is never overwritten and never
 * deleted. Stashing the old value in memory was the other candidate and was rejected: it loses the value
 * if the extension host dies before teardown, which is exactly when a leak matters.
 */
export function decideFixtureApiKeyAction(state: {
  clearRequested: boolean;
  keyExists: boolean;
  createdByFixture: boolean;
}): 'create' | 'remove' | 'leave' {
  if (state.clearRequested) {
    return state.createdByFixture ? 'remove' : 'leave';
  }
  return state.keyExists ? 'leave' : 'create';
}
