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

export interface E2EFixtureSecretStore {
  read(): Promise<string | undefined>;
  writeFixture(): Promise<void>;
  removeFixture(): Promise<void>;
}

const E2E_API_KEY_VALUE = 'sk-e2e-offline';

/**
 * VS Code's test SecretStorage can resolve store/delete before a following get observes the change.
 * Keep that eventual consistency inside the Test-only fixture boundary: the next suite must not mistake
 * a fixture key awaiting deletion for a user's pre-existing key, or start an agent before a fixture key
 * awaiting storage is readable.
 */
async function settleFixtureSecretValue(
  read: () => Promise<string | undefined>,
  expected: string | undefined,
  reapply: () => Promise<void>,
  options: { attempts?: number; delayMs?: number; stableReads?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? 240;
  const delayMs = options.delayMs ?? 25;
  const stableReads = options.stableReads ?? 20;
  let consecutive = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await read() === expected) {
      consecutive += 1;
      if (consecutive >= stableReads) {
        return;
      }
    } else {
      consecutive = 0;
      // A stale SecretStorage operation may land after an earlier matching read. Re-applying makes
      // this host the last writer, while the consecutive-read window proves the state stayed settled.
      await reapply();
    }
    if (attempt < attempts) {
      await (delayMs > 0
        ? new Promise<void>((resolve) => setTimeout(resolve, delayMs))
        : Promise.resolve());
    }
  }
  throw new Error(
    `E2E API-key fixture SecretStorage did not settle to ${expected === undefined ? 'absent' : 'the fixture value'}.`,
  );
}

/**
 * Reconcile the known fake key without ever overwriting or deleting a user's key. Unlike an in-memory
 * ownership bit, the sentinel survives a crashed extension host. Refreshing a stale sentinel through an
 * observed absent state also serializes any delayed delete from that earlier host before this run starts.
 */
export async function reconcileE2EFixtureApiKey(
  store: E2EFixtureSecretStore,
  clearRequested: boolean,
  waitOptions: { attempts?: number; delayMs?: number; stableReads?: number } = {},
): Promise<'create' | 'remove' | 'leave'> {
  const current = await store.read();
  const fixtureOwned = current === E2E_API_KEY_VALUE;
  const action = !clearRequested && fixtureOwned
    ? 'create'
    : decideFixtureApiKeyAction({
        clearRequested,
        keyExists: current !== undefined,
        createdByFixture: fixtureOwned,
      });
  if (action === 'leave') {
    return action;
  }
  if (action === 'remove') {
    await store.removeFixture();
    await settleFixtureSecretValue(
      () => store.read(),
      undefined,
      () => store.removeFixture(),
      waitOptions,
    );
    return action;
  }

  if (fixtureOwned) {
    await store.removeFixture();
    await settleFixtureSecretValue(
      () => store.read(),
      undefined,
      () => store.removeFixture(),
      waitOptions,
    );
  }
  await store.writeFixture();
  await settleFixtureSecretValue(
    () => store.read(),
    E2E_API_KEY_VALUE,
    () => store.writeFixture(),
    waitOptions,
  );
  return 'create';
}
