import { describe, expect, it, vi } from 'vitest';
import { storeUserInitiatedProviderKey } from '../UserInitiatedProviderKeyStore';

describe('user-initiated provider-key storage', () => {
  it('stores, asks for the connection coefficient, then invalidates derived data in that order', async () => {
    const events: string[] = [];
    await storeUserInitiatedProviderKey({
      secretName: 'UNODE_API_KEY',
      value: 'not-retained',
      connectionId: 'unode',
      storeSecret: async () => { events.push('store'); },
      promptForPriceMultiplier: async (connectionId) => { events.push(`price:${connectionId}`); },
      onCredentialChanged: async (secretName, connectionId) => { events.push(`changed:${secretName}:${connectionId}`); },
    });

    expect(events).toEqual([
      'store',
      'price:unode',
      'changed:UNODE_API_KEY:unode',
    ]);
  });

  it('keeps an arbitrary non-provider secret silent and out of credential-derived refreshes', async () => {
    const promptForPriceMultiplier = vi.fn();
    const onCredentialChanged = vi.fn();
    const storeSecret = vi.fn(async () => {});

    await storeUserInitiatedProviderKey({
      secretName: 'GITHUB_TOKEN',
      value: 'not-retained',
      storeSecret,
      promptForPriceMultiplier,
      onCredentialChanged,
    });

    expect(storeSecret).toHaveBeenCalledOnce();
    expect(promptForPriceMultiplier).not.toHaveBeenCalled();
    expect(onCredentialChanged).not.toHaveBeenCalled();
  });
});
