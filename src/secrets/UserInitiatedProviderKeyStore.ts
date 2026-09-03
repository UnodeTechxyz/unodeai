/*---------------------------------------------------------------------------------------------
 *  UnodeAi - User-initiated provider-key storage
 *
 *  A provider credential changes two derived facts: the account-specific price coefficient and
 *  the credential-scoped model/price caches. Keep that follow-up at the write boundary so a new
 *  UI door cannot remember the SecretStorage write while forgetting either consequence.
 *--------------------------------------------------------------------------------------------*/

export interface UserInitiatedProviderKeyStoreInput {
  /** SecretStorage name or opaque custom-gateway secret reference. */
  secretName: string;
  /** Host-only credential value. It is passed to the storage callback and never retained here. */
  value: string;
  /** Present only when this credential belongs to a connection profile. */
  connectionId?: string;
  /** The actual storage operation; custom gateways supply their transaction-safe staged write. */
  storeSecret: () => Promise<void>;
  /** Ask for account-specific pricing only for a connection-owned credential. */
  promptForPriceMultiplier: (connectionId: string) => Promise<void>;
  /** Invalidate data derived from the old credential after the new one and its price are stored. */
  onCredentialChanged?: (secretName: string, connectionId?: string) => Promise<void> | void;
}

/**
 * The one production path for a user stating a new provider credential.
 *
 * Migration and fixture writes deliberately do not call this function: they did not come from a
 * user and must not open UI. A non-connection secret (for example an MCP token) still refreshes
 * nothing and is never asked for a price.
 */
export async function storeUserInitiatedProviderKey(input: UserInitiatedProviderKeyStoreInput): Promise<void> {
  await input.storeSecret();
  if (!input.connectionId) {
    return;
  }
  await input.promptForPriceMultiplier(input.connectionId);
  await input.onCredentialChanged?.(input.secretName, input.connectionId);
}
